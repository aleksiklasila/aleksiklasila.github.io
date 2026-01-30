import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildMeshFromDepth } from './ar-mesh.js?v=2';
import { ARScanner } from './ar-scanner.js?v=3';

// --- Constants & Globals ---
let camera, scene, renderer;
let controller;
let reticle;
let xrRefSpace = null;
let currentSession = null;
let isScanning = false;
let qualityMode = 'fast'; // 'fast' | 'detailed'
let scannedMeshes = []; // Array of accummulated meshes
let lastScanTime = 0;
let isViewing = false; // Flag to pause UI status updates during viewing
let arScanner = null; // Fusion scanner instance

// HTML Elements
const btnEnterAR = document.getElementById('btn-enter-ar');
const btnScan = document.getElementById('btn-scan');
const btnExport = document.getElementById('btn-export');
const startScreen = document.getElementById('start-screen');
const controlsPanel = document.getElementById('controls');
const statusText = document.getElementById('status-text');
const btnView = document.getElementById('btn-view');
const viewerOverlay = document.getElementById('viewer-overlay');
const debugViewer = document.getElementById('debug-viewer');
const depthCanvas = document.getElementById('depth-debug');
const depthCtx = depthCanvas.getContext('2d');
let lastGlbBlob = null;

// --- Initialization ---
init();

function init() {
    window.setQuality = (mode) => {
        qualityMode = mode;
        document.getElementById('btn-fast').classList.toggle('active', mode === 'fast');
        document.getElementById('btn-detailed').classList.toggle('active', mode === 'detailed');
        statusText.innerText = mode === 'detailed' ? "Detailed: Move slowly to accumulate." : "Fast: Single snapshot.";
        console.log(`Quality set to: ${mode}`);
    };

    btnEnterAR.addEventListener('click', onEnterAR);
    btnScan.addEventListener('click', onScanToggle);
    btnExport.addEventListener('click', onExport);
    btnView.addEventListener('click', onViewDebug);

    setupThreeJS();

    // Check WebXR Support
    if (navigator.xr) {
        navigator.xr.isSessionSupported('immersive-ar').then((supported) => {
            if (supported) {
                btnEnterAR.disabled = false;
                btnEnterAR.textContent = 'Start AR';
            } else {
                btnEnterAR.disabled = true;
                btnEnterAR.textContent = 'AR Not Supported';
                statusText.innerText = 'WebXR immersive-ar not supported on this device.';
            }
        });
    } else {
        btnEnterAR.disabled = true;
        btnEnterAR.textContent = 'WebXR Not Found';
    }
}

function setupThreeJS() {
    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

    const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
    light.position.set(0.5, 1, 0.25);
    scene.add(light);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    document.body.appendChild(renderer.domElement);

    // Reticle (cursor)
    const geometry = new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial();
    reticle = new THREE.Mesh(geometry, material);
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    reticle.visible = false;
    scene.add(reticle);

    // Init Scanner
    arScanner = new ARScanner(scene, renderer);
}

// --- WebXR Session ---
async function onEnterAR() {
    const overlayElement = document.getElementById('overlay');

    if (!currentSession) {
        const sessionInit = {
            requiredFeatures: ['hit-test', 'depth-sensing', 'dom-overlay'],
            domOverlay: { root: overlayElement },
            depthSensing: {
                usagePreference: ["cpu-optimized", "gpu-optimized"],
                dataFormatPreference: ["luminance-alpha", "float32"]
            }
        };
        try {
            const session = await navigator.xr.requestSession('immersive-ar', sessionInit);
            onSessionStarted(session);
        } catch (e) {
            console.error("Failed to start AR session", e);
            alert("Error starting AR: " + e.message); // Visible alert on device
            statusText.innerText = "Error starting AR: " + e.message;
        }
    }
}

function onSessionStarted(session) {
    currentSession = session;
    session.addEventListener('end', onSessionEnded);

    renderer.xr.setReferenceSpaceType('local');
    renderer.xr.setSession(session);

    // Verify overlay
    if (!session.domOverlayState) {
        // Warn if overlay is not active
        // alert("Warning: DOM Overlay not supported/active"); 
    }

    startScreen.classList.add('hidden');
    controlsPanel.classList.remove('hidden');
}

function onSessionEnded() {
    currentSession = null;
    startScreen.classList.remove('hidden');
    controlsPanel.classList.add('hidden');
}

// --- Logic Loop ---
renderer.setAnimationLoop(render);

function render(timestamp, frame) {
    if (frame) {
        const referenceSpace = renderer.xr.getReferenceSpace();
        const session = renderer.xr.getSession();

        // 0. Update Pose & Depth State
        const pose = frame.getViewerPose(referenceSpace);
        if (pose && !isViewing) {
            const depthInfo = frame.getDepthInformation(pose.views[0]);
            if (depthInfo) {
                window.latestDepthPack = { depthInfo, view: pose.views[0] };
                // Only show "Depth Active" if NOT scanning
                if (!isScanning) {
                    statusText.innerText = `Depth Active: ${depthInfo.width}x${depthInfo.height}`;
                    // Visual Debug: Render depth to canvas
                    drawDepthDebug(depthInfo);
                    depthCanvas.style.display = 'block';
                }
            } else {
                if (!isScanning) {
                    statusText.innerText = `Depth unavailable`;
                    depthCanvas.style.display = 'none';
                }
                window.latestDepthPack = null;
            }
        }

        // 1. Check Snapshot Request (Fast Mode)
        if (window.needsSnapshot && window.latestDepthPack) {
            generateMeshFromDepth(window.latestDepthPack.depthInfo);
            window.needsSnapshot = false;
            btnExport.disabled = false;
        }

        // 2. Detailed Mode Loop
        if (isScanning && qualityMode === 'detailed' && window.latestDepthPack) {
            // New Fusion Logic
            const { depthInfo, view } = window.latestDepthPack;
            arScanner.processFrame(depthInfo, view, camera);

            // Only update text occasionally
            // statusText.innerText = `Scanning... Voxels: ${arScanner.voxels.size}`;
        }

        // 3. Update Reticle
        updateReticle(frame, referenceSpace);
    }
    renderer.render(scene, camera);
}

function updateReticle(frame, referenceSpace) {
    // Reticle logic skipped for brevity, focused on scanning
}


// --- Scanning Logic ---
function onScanToggle() {
    if (!isScanning) {
        // Start Scan
        isScanning = true;
        btnScan.innerText = "Stop";
        btnScan.classList.remove("primary-btn");
        btnScan.classList.add("secondary-btn");

        if (qualityMode === 'fast') {
            performFastScan();
            // Fast scan is instant
            isScanning = false;
            btnScan.innerText = "Scan";
            btnScan.classList.add("primary-btn");
            btnScan.classList.remove("secondary-btn");
        } else {
            // Detailed mode (continuous)
            statusText.innerText = "Scanning... Move around object.";
            clearScannedMeshes();
            arScanner.start();
        }

    } else {
        // Stop Scan (Detailed Mode)
        isScanning = false;
        if (qualityMode === 'detailed') {
            arScanner.stop();
            // Add the scanner's pointcloud to scannedMeshes for export
            if (arScanner.pointCloud) scannedMeshes.push(arScanner.pointCloud);
        }

        btnScan.innerText = "Scan";
        btnScan.classList.add("primary-btn");
        btnScan.classList.remove("secondary-btn");
        btnExport.disabled = false;
        statusText.innerText = `Scan complete.`;
    }
}

function performFastScan() {
    if (!window.latestDepthPack) {
        alert("No depth data available! Move your phone slightly.");
        return;
    }
    statusText.innerText = "Capturing snapshot...";
    clearScannedMeshes(); // Clear previous for fast scan
    window.needsSnapshot = true;
}

function generateMeshFromDepth(depthInfo) {
    if (!renderer.xr.isPresenting) return;

    // Use camera as proxy for view projection if needed, 
    // but buildMeshFromDepth takes the view logic.
    // We already have 'window.latestDepthPack.view' but strictly we should pass it.
    // However, for Simplicity in this block, let's just use the active camera which matches the view 
    // (Three.js updates camera projection from view).
    // Use correct calling convention for new ar-mesh
    const view = window.latestDepthPack ? window.latestDepthPack.view : renderer.xr.getCamera();
    // If using latestDepthPack.view, we must still respect the current camera transform?
    // Actually, AR depth is relative to the *view* at the time of capture.
    // So usually we need the pose of that view to place it in world.
    // For simplicity with 'camera', we assume immediate capture.

    // Create Points in View Space
    const points = buildMeshFromDepth(depthInfo, view);

    if (points) {
        // Transform to World Space
        // Note: If using 'view' from the past, we ideally need that view's transform.
        // But for "Fast" mode (now), camera.matrixWorld is close enough approximately if instantaneous.
        // For "Detailed", we might drift if we don't save the pose.
        // Let's us camera.matrixWorld for now as we are doing real-time.
        const camera = renderer.xr.getCamera();
        points.applyMatrix4(camera.matrixWorld);
        points.isARMesh = true;

        scene.add(points);
        scannedMeshes.push(points);
        // Enable view button since we have data
        btnView.style.display = 'inline-block';
    }
}

function clearScannedMeshes() {
    for (const mesh of scannedMeshes) {
        scene.remove(mesh);
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) mesh.material.dispose();
    }
    scannedMeshes = [];
    if (arScanner) arScanner.clear(); // Clear voxel grid
    btnView.style.display = 'none';
    lastGlbBlob = null;
    isViewing = false;
    viewerOverlay.classList.add('hidden');
}

// --- Export Logic ---
function onExport() {
    if (scannedMeshes.length === 0) return;

    const exporter = new GLTFExporter();
    exporter.parse(
        scannedMeshes,
        function (gltf) {
            saveArrayBuffer(gltf, 'scan.glb');
        },
        function (error) {
            console.error('An error happened during export:', error);
        },
        { binary: true }
    );
}

function saveArrayBuffer(buffer, filename) {
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    lastGlbBlob = blob; // Save for viewer
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
}

function onViewDebug() {
    // Force stop scanning to prevent conflicts
    if (isScanning) {
        onScanToggle(); // This toggles it off
    }

    isViewing = true;
    if (!scannedMeshes.length && !lastGlbBlob) return;

    // ... exports ...

    // If we haven't exported yet, quick export to memory
    if (!lastGlbBlob) {
        statusText.innerText = "Exporting for preview...";
        const exporter = new GLTFExporter();
        exporter.parse(
            scannedMeshes,
            function (gltf) {
                lastGlbBlob = new Blob([gltf], { type: 'application/octet-stream' });
                openViewer(lastGlbBlob);
            },
            function (error) {
                alert("Export error: " + error);
                isViewing = false;
            },
            { binary: true }
        );
    } else {
        openViewer(lastGlbBlob);
    }
}

function openViewer(blob) {
    statusText.innerText = "Opening Viewer...";
    const url = URL.createObjectURL(blob);
    debugViewer.src = url;
    viewerOverlay.classList.remove('hidden');
    // Ensure overlay is on top by forcing display style if needed (class handler should be enough)
}

// Add close handler to global scope or attach in init if preferred
window.closeViewer = () => {
    isViewing = false;
    viewerOverlay.classList.add('hidden');
};

function drawDepthDebug(depthInfo) {
    const width = depthInfo.width;
    const height = depthInfo.height;

    // Resize canvas if needed
    if (depthCanvas.width !== width || depthCanvas.height !== height) {
        depthCanvas.width = width;
        depthCanvas.height = height;
    }

    const rawData = new Uint16Array(depthInfo.data);
    const toMeters = depthInfo.rawValueToMeters || 1.0;
    const imageData = depthCtx.createImageData(width, height);
    const pixels = imageData.data; // RGBA

    for (let i = 0; i < width * height; i++) {
        // Raw value
        const val = rawData[i];
        // Convert to meters
        const m = val * toMeters;
        // Normalize for display (0m to 5m = 0 to 255)
        // 0 is usually invalid/unknown
        let intensity = 0;
        if (m > 0 && m < 5.0) {
            intensity = Math.floor((m / 5.0) * 255);
            // Invert so near is bright? Or standard depth map (near=black/white?)
            // Usually Near = Bright (High value), Far = Dark
            // Let's do: Near (0m) = 255 (White), Far (5m) = 0 (Black)
            intensity = 255 - intensity;
        }

        const px = i * 4;
        if (m === 0) {
            // Invalid = Red
            pixels[px] = 255;
            pixels[px + 1] = 0;
            pixels[px + 2] = 0;
            pixels[px + 3] = 255;
        } else {
            // Grayscale
            pixels[px] = intensity;
            pixels[px + 1] = intensity;
            pixels[px + 2] = intensity;
            pixels[px + 3] = 255;
        }
    }
    depthCtx.putImageData(imageData, 0, 0);
}
