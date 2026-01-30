import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildMeshFromDepth } from './ar-mesh.js';

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
let lastGlbBlob = null;

// --- Initialization ---
init();

function init() {
    window.setQuality = (mode) => {
        qualityMode = mode;
        document.getElementById('btn-fast').classList.toggle('active', mode === 'fast');
        document.getElementById('btn-detailed').classList.toggle('active', mode === 'detailed');
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
    scene.add(reticle);
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
        if (pose) {
            const depthInfo = frame.getDepthInformation(pose.views[0]);
            if (depthInfo) {
                window.latestDepthPack = { depthInfo, view: pose.views[0] };
                statusText.innerText = `Depth Active: ${depthInfo.width}x${depthInfo.height}`;
            } else {
                statusText.innerText = `Depth unavailable`;
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
            const now = performance.now();
            if (now - lastScanTime > 1000) { // 1 second interval
                generateMeshFromDepth(window.latestDepthPack.depthInfo);
                lastScanTime = now;
                statusText.innerText = `Scanning... Meshes: ${scannedMeshes.length}`;
            }
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
            statusText.innerText = "Scanning... Move slowly.";
            clearScannedMeshes();
        }

    } else {
        // Stop Scan (Detailed Mode)
        isScanning = false;
        btnScan.innerText = "Scan";
        btnScan.classList.add("primary-btn");
        btnScan.classList.remove("secondary-btn");
        btnExport.disabled = false;
        statusText.innerText = `Scan complete. ${scannedMeshes.length} meshes ready.`;
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
    const camera = renderer.xr.getCamera();

    // Create Mesh in View Space
    const mesh = buildMeshFromDepth(depthInfo, camera);

    if (mesh) {
        // Transform to World Space
        mesh.applyMatrix4(camera.matrixWorld);
        mesh.isARMesh = true; // Tag for cleanup

        scene.add(mesh);
        scannedMeshes.push(mesh);
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
    btnView.style.display = 'none';
    lastGlbBlob = null;
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
    if (!scannedMeshes.length && !lastGlbBlob) return;

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
            function (error) { alert("Export error: " + error); },
            { binary: true }
        );
    } else {
        openViewer(lastGlbBlob);
    }
}

function openViewer(blob) {
    const url = URL.createObjectURL(blob);
    debugViewer.src = url;
    viewerOverlay.classList.remove('hidden');
}
