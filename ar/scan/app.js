import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildMeshFromDepth } from './ar-mesh.js?v=3';
import { ARScanner } from './ar-scanner.js?v=6';

// --- Constants & Globals ---
let camera, scene, renderer;
let controller;
let reticle;
let xrRefSpace = null;
let currentSession = null;
let isScanning = false;
// variable removed
let qualityMode = 'detailed'; // Default to detailed logic
let viewMode = 'camera'; // 'camera' | 'depth'
let scannedMeshes = []; // Array of accummulated meshes
let lastScanTime = 0;
let isViewing = false; // Flag to pause UI status updates during viewing
let arScanner = null; // Fusion scanner instance
let glBinding = null;
let gl = null;
let readbackFBO = null;
let readbackTexture = null;
let colorBuffer = null;
const COLOR_SIZE = 128; // Downsample for performance handling

// HTML Elements
const btnEnterAR = document.getElementById('btn-enter-ar');
const btnScan = document.getElementById('btn-scan');
const btnExport = document.getElementById('btn-export');
const startScreen = document.getElementById('start-screen');
const controlsPanel = document.getElementById('controls');
const statusText = document.getElementById('status-text');
const viewerOverlay = document.getElementById('viewer-overlay');
const debugViewer = document.getElementById('debug-viewer');
const depthCanvas = document.getElementById('depth-debug');
const depthCtx = depthCanvas.getContext('2d');
const btnViewToggle = document.getElementById('btn-view-toggle');
const btnSettings = document.getElementById('btn-settings');
const settingsPanel = document.getElementById('settings-panel');
const btnCloseSettings = document.getElementById('btn-close-settings');
const btnView = document.getElementById('btn-view'); // Kept for reference or removal? 
// Actually btnView is used in logic for "Check" button, though hidden.
// Let's keep it defined to avoid null errors if code refs it, but it might be commented out in HTML.
// HTML has it commented out but ID exists if uncommented? 
// No, I commented it out in HTML. So getElementById might return null.
// Let's ensure we check for null before adding listeners.

// Settings Inputs
const rangeConfidence = document.getElementById('range-confidence');
const rangeMinDepth = document.getElementById('range-min-depth');
const rangeMaxDepth = document.getElementById('range-max-depth');
const rangeVoxel = document.getElementById('range-voxel');
const valConfidence = document.getElementById('val-confidence');
const valMinDepth = document.getElementById('val-min-depth');
const valMaxDepth = document.getElementById('val-max-depth');
const valVoxel = document.getElementById('val-voxel');
const rangeRotation = document.getElementById('range-rotation');
const valRotation = document.getElementById('val-rotation');
let lastGlbBlob = null;

// Measurement State
const measureContainer = document.getElementById('measure-container');
const measureCrosshair = document.getElementById('measure-crosshair');
// const measureText = document.getElementById('measure-text'); // Removed
const measureState = {
    active: false,
    inputX: 0, // 0-1 (Screen/Canvas Normalized)
    inputY: 0, // 0-1
    avgDepth: 0,
    samples: 0
};

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

    if (btnView) btnView.addEventListener('click', onViewDebug);
    if (btnViewToggle) btnViewToggle.addEventListener('click', onViewToggle);

    // Measurement Input
    depthCanvas.addEventListener('pointerdown', (e) => {
        if (!isViewing && viewMode === 'depth') {
            const rect = depthCanvas.getBoundingClientRect();
            // Normalized 0-1
            measureState.inputX = (e.clientX - rect.left) / rect.width;
            measureState.inputY = (e.clientY - rect.top) / rect.height;
            console.log("Measure Touch:", measureState.inputX.toFixed(2), measureState.inputY.toFixed(2));
            measureState.active = true;
            measureState.samples = 0; // Reset averaging

            // Move crosshair (Percent)
            measureCrosshair.style.left = (measureState.inputX * 100) + '%';
            measureCrosshair.style.top = (measureState.inputY * 100) + '%';
        }
    });

    // Settings listeners
    btnSettings.addEventListener('click', () => {
        settingsPanel.classList.toggle('hidden');
    });
    btnCloseSettings.addEventListener('click', () => {
        settingsPanel.classList.add('hidden');
    });

    // Param Listeners
    const updateScannerParams = () => {
        if (!arScanner) return;
        arScanner.minCount = parseInt(rangeConfidence.value);
        arScanner.minDepth = parseFloat(rangeMinDepth.value);
        arScanner.maxDepth = parseFloat(rangeMaxDepth.value);
        // Voxel size usually requires restart/clear, handled separately or live?
        // Let's allow live clear or just set property if scanner supports it.
        // For now, next rebuild will use it if we support dynamic cell size.
        // But cell size affects key hashing. changing it breaks map. 
        // So we just store it and apply on next "clear/start".
        arScanner.nextCellSize = parseFloat(rangeVoxel.value) / 100.0; // cm to m

        // Update Labels
        valConfidence.innerText = rangeConfidence.value;
        valMinDepth.innerText = rangeMinDepth.value + 'm';
        valMaxDepth.innerText = rangeMaxDepth.value + 'm';
        valVoxel.innerText = rangeVoxel.value + 'cm';

        // Rotation
        if (rangeRotation && valRotation) {
            depthRotation = parseInt(rangeRotation.value);
            valRotation.innerText = depthRotation;
        }
    };

    rangeConfidence.addEventListener('input', updateScannerParams);
    rangeMinDepth.addEventListener('input', updateScannerParams);
    rangeMaxDepth.addEventListener('input', updateScannerParams);
    rangeVoxel.addEventListener('input', updateScannerParams);
    if (rangeRotation) rangeRotation.addEventListener('input', updateScannerParams);

    // Initial update
    updateScannerParams();

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
    renderer.domElement.style.cssText = "position:absolute; top:0; left:0; z-index:10; pointer-events:none;"; // Allow clicks to pass if needed, but we have UI
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

    // Initial sync with UI defaults
    if (rangeConfidence) {
        arScanner.minCount = parseInt(rangeConfidence.value);
        arScanner.minDepth = parseFloat(rangeMinDepth.value);
        arScanner.maxDepth = parseFloat(rangeMaxDepth.value);
        arScanner.cellSize = parseFloat(rangeVoxel.value) / 100.0;
    }
}

// --- WebXR Session ---
async function onEnterAR() {
    const overlayElement = document.getElementById('overlay');

    if (!currentSession) {
        const sessionInit = {
            requiredFeatures: ['hit-test', 'depth-sensing', 'dom-overlay', 'camera-access'],
            domOverlay: { root: overlayElement },
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

async function onSessionStarted(session) {
    currentSession = session;
    session.addEventListener('end', onSessionEnded);

    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);

    // Verify overlay
    if (!session.domOverlayState) {
        // Warn if overlay is not active
    }

    startScreen.classList.add('hidden');
    controlsPanel.classList.remove('hidden');

    // Init GL Binding for Camera Access
    gl = renderer.getContext();
    try {
        // Ensure context is compatible
        if (gl.makeXRCompatible) {
            await gl.makeXRCompatible();
        }
        glBinding = new XRWebGLBinding(session, gl);
        initColorReadback(gl);
    } catch (e) {
        console.error("XRWebGLBinding failed", e);
        statusText.innerText = "Camera/Color access failed. " + e.message;
    }
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

                // Always render depth if View Mode is 'depth'
                if (viewMode === 'depth') {
                    drawDepthDebug(depthInfo, true);
                    depthCanvas.style.display = 'block';
                    updateMeasurement(depthInfo);
                } else {
                    depthCanvas.style.display = 'none';
                }
            } else {
                depthCanvas.style.display = 'none';
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

            // Try Capture Color
            let colors = null;
            if (glBinding && view.camera) {
                colors = captureCameraColor(view);
            }

            arScanner.processFrame(depthInfo, view, camera, colors);

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
            // Apply pending voxel size change if any
            if (arScanner.nextCellSize && arScanner.nextCellSize !== arScanner.cellSize) {
                arScanner.cellSize = arScanner.nextCellSize;
                console.log("Applied new voxel size: " + arScanner.cellSize);
            }
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
        if (btnView) btnView.style.display = 'inline-block';
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
    // btnView might be null if removed from DOM
    if (btnView) btnView.style.display = 'none';
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

// --- View Toggle ---
// Global rotation setting
let depthRotation = 90;

function onViewToggle() {
    if (viewMode === 'camera') {
        viewMode = 'depth';
        btnViewToggle.innerText = '👁️ Depth';
        // Make depth canvas fullscreen, z-index 100 (top)
        // Solid black background to block camera
        // Make depth canvas fullscreen, z-index 50 (above camera 10, below UI 100)
        // Solid black background to block camera
        // Make depth canvas fullscreen, z-index 50 (above camera 10, below UI 100)
        // Solid black background to block camera
        depthCanvas.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; object-fit:contain; opacity:1.0; pointer-events:auto; z-index:50; background:black;";

        // Show cursor immediately at center
        measureContainer.style.display = 'block';
        if (!measureState.active) {
            measureState.inputX = 0.5;
            measureState.inputY = 0.5;
            measureState.active = true;
            measureState.samples = 0;
            measureCrosshair.style.left = '50%';
            measureCrosshair.style.top = '50%';
        }
        statusText.innerText = "Tap to measure distance";
    } else {
        viewMode = 'camera';
        btnViewToggle.innerText = '👁️ Cam';
        // Hide/Standard depth canvas
        depthCanvas.style.display = 'none';
        measureContainer.style.display = 'none';
        measureState.active = false;
    }
}

function updateMeasurement(depthInfo) {
    if (!measureState.active) return;

    const width = depthInfo.width;
    const height = depthInfo.height;

    // 1. Map Screen Coords (inputX, inputY) to Depth Image Coords
    // We need to reverse the rotation logic in drawDepthDebug
    // Screen X/Y (0-1) corresponds to the 'dest' coords in draw function.

    let depthX, depthY;

    // In drawDepthDebug:
    // 90 (CW): destX = H - 1 - y, destY = x
    // => x = destY, y = H - 1 - destX

    // 180 (CW): destX = W - 1 - x, destY = H - 1 - y
    // => x = W - 1 - destX, y = H - 1 - destY

    // 270 (CW): destX = y, destY = W - 1 - x
    // => x = W - 1 - destY, y = destX

    // 0: destX = x, destY = y

    // Normalized coords of screen
    const sx = measureState.inputX;
    const sy = measureState.inputY;

    // Dimensions of the rotated image on screen (logical)
    // If 90/270, screen width maps to depth height, screen height maps to depth width

    if (depthRotation === 90) {
        // Screen X (0-1) -> Depth Y (x=destY) -> range 0-Width
        // Screen Y (0-1) -> Depth X (y=H-1-destX) -> range 0-Height

        // Wait, let's look at the mapping again carefully.
        // destX is the fast index (horizontal on screen)
        // destY is the slow index (vertical on screen)

        // At 90deg CW:
        // Top-Left Screen (0,0) => destX=0, destY=0
        // Formula: destX = H - 1 - y => 0 = H - 1 - y => y = H - 1 (Bottom of depth img)
        //          destY = x => 0 = x => x = 0 (Left of depth img)

        // So Screen(0,0) -> Depth(0, H-1) ?

        // Let's use proportional mapping:
        const screenW = height; // Rotated
        const screenH = width;

        const px = Math.floor(sx * screenW); // destX
        const py = Math.floor(sy * screenH); // destY

        depthX = py; // x = destY
        depthY = height - 1 - px; // y = H - 1 - destX

    } else if (depthRotation === 180) {
        // 180
        const px = Math.floor(sx * width);
        const py = Math.floor(sy * height);

        depthX = width - 1 - px;
        depthY = height - 1 - py;

    } else if (depthRotation === 270) {
        // 270 (-90)
        // destX = y, destY = W - 1 - x
        // Top-Left Screen (0,0) -> destX=0, destY=0
        // 0 = y => y = 0
        // 0 = W - 1 - x => x = W - 1

        const screenW = height;
        const screenH = width;

        const px = Math.floor(sx * screenW);
        const py = Math.floor(sy * screenH);

        depthX = width - 1 - py; // x = W - 1 - destY
        depthY = px; // y = destX

    } else {
        // 0
        depthX = Math.floor(sx * width);
        depthY = Math.floor(sy * height);
    }

    // Clamp
    if (depthX < 0) depthX = 0; if (depthX >= width) depthX = width - 1;
    if (depthY < 0) depthY = 0; if (depthY >= height) depthY = height - 1;

    // 2. Sample Depth
    let dist = 0;
    try {
        dist = depthInfo.getDepthInMeters(depthX, depthY);
    } catch (e) { console.error(e); }

    if (typeof dist !== 'number' || isNaN(dist) || dist === 0) {
        // Invalid or Too Far/Close
        // Keep previous average or show --
    } else {
        // 3. Average
        // Exponential moving average for smoothness
        const alpha = 0.15;
        if (measureState.samples === 0) {
            measureState.avgDepth = dist;
        } else {
            measureState.avgDepth = measureState.avgDepth * (1 - alpha) + dist * alpha;
        }
        measureState.samples++;
    }

    // Update Text
    if (measureState.samples > 0) {
        statusText.innerText = "Distance: " + measureState.avgDepth.toFixed(2) + " m";
    } else {
        statusText.innerText = "Distance: -- m";
    }

    // Debug 1/60 frames
    if (Math.random() < 0.02) {
        // console.log("Depth Query:", depthX, depthY, dist);
    }
}

function drawDepthDebug(depthInfo, fullscreen = false) {
    const srcWidth = depthInfo.width;
    const srcHeight = depthInfo.height;

    // Determine output dimensions
    let width, height;
    if (depthRotation === 90 || depthRotation === 270) {
        width = srcHeight;
        height = srcWidth;
    } else {
        width = srcWidth;
        height = srcHeight;
    }

    // Resize canvas if needed
    if (depthCanvas.width !== width || depthCanvas.height !== height) {
        depthCanvas.width = width;
        depthCanvas.height = height;
    }

    const rawData = new Uint16Array(depthInfo.data);
    const toMeters = depthInfo.rawValueToMeters || 1.0;
    const imageData = depthCtx.createImageData(width, height);
    const pixels = imageData.data; // RGBA

    for (let y = 0; y < srcHeight; y++) {
        for (let x = 0; x < srcWidth; x++) {
            // Source Index
            const srcIdx = y * srcWidth + x;
            const val = rawData[srcIdx];

            // Rotation Logic
            let destX, destY;
            if (depthRotation === 90) {
                // CW 90
                destX = srcHeight - 1 - y;
                destY = x;
            } else if (depthRotation === 180) {
                // CW 180
                destX = srcWidth - 1 - x;
                destY = srcHeight - 1 - y;
            } else if (depthRotation === 270) {
                // CW 270 (CCW 90)
                destX = y;
                destY = srcWidth - 1 - x;
            } else {
                // 0
                destX = x;
                destY = y;
            }

            const destIdx = (destY * width + destX) * 4;

            // Convert to meters
            const m = val * toMeters;
            // Normalize for display (0m to 5m = 0 to 255)
            // Near = White (255), Far = Black (0)
            let intensity = 0;
            if (m > 0 && m < 5.0) {
                intensity = Math.floor((m / 5.0) * 255);
                intensity = 255 - intensity;
            }

            if (m === 0) {
                // Invalid = Red
                pixels[destIdx] = 255;
                pixels[destIdx + 1] = 0;
                pixels[destIdx + 2] = 0;
                pixels[destIdx + 3] = 255;
            } else {
                // Grayscale
                pixels[destIdx] = intensity;
                pixels[destIdx + 1] = intensity;
                pixels[destIdx + 2] = intensity;
                pixels[destIdx + 3] = 255;
            }
        }
    }
    depthCtx.putImageData(imageData, 0, 0);
}

function initColorReadback(gl) {
    if (readbackFBO) return;

    readbackTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, readbackTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, COLOR_SIZE, COLOR_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

    readbackFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, readbackFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, readbackTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    colorBuffer = new Uint8Array(COLOR_SIZE * COLOR_SIZE * 4);
}

function captureCameraColor(view) {
    if (!glBinding || !readbackFBO) return null;

    const cameraTexture = glBinding.getCameraImage(view.camera);
    if (!cameraTexture) return null;

    // Save previous state
    const prevFBO = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    // const prevProgram = gl.getParameter(gl.CURRENT_PROGRAM); // Three.js handles this mostly

    // 1. Blit/Render Camera Texture to small FBO
    // Simple way: wrap it in Three.js and render a quad? 
    // Or just raw GL since we have the texture? Raw GL is faster/safer here to avoid messing Three state.

    gl.bindFramebuffer(gl.FRAMEBUFFER, readbackFBO);
    gl.viewport(0, 0, COLOR_SIZE, COLOR_SIZE);

    // To do this simply without a shader, we can use gl.copyTexImage? No, textures are different sizes.
    // We need a blit. gl.blitFramebuffer is WebGL2 (usually avail in WebXR).
    // AR camera texture is usually OES_external_image or similar, might need shader.
    // BUT! glBinding.getCameraImage returns a WebGLTexture.
    // Let's assume we can attach it to a FBO? No, usually incomplete if external.

    // Simplest robust way: Just use Three.js internals or a simple shader?
    // Actually, let's skip the complexity of a custom blit shader for this snippet 
    // and rely on a simpler approach if possible.
    // If we assume WebGL2, we can blit.

    // Attempt WebGL2 Blit (Fastest)
    // Create a temp FBO for the camera source?
    // Camera texture might be OES, so can't attach to FBO directly in some cases.

    // Fallback: If we can't easily blit, we return null for now to avoid breaking.
    // Wait, we need this feature. 
    // Correct way: Draw a full screen quad with the camera texture.
    // Effectively impossible to write raw GL here without a lot of boilerplate.
    // Hack: Assume we can just read pixels from it? No.

    // Let's TRY generic framebuffer blit if same types.
    // If not, we serve a placebo or need a helper class.

    // REVISION: To keep 'app.js' clean, let's just create a THREE.Mesh with the texture 
    // and render it to a target? 
    // Three.js `XRWebGLLayer` is opaque. `getCameraImage` gives raw GL texture.
    // Integrating raw GL texture into Three.js scene is tricky.

    // OK, simplest path that WORKS:
    // Don't use `getCameraImage` if it's too hard.
    // Is there a strictly Three.js way? `renderer.xr.getCameraFramebuffer()`? No.

    // Let's try to proceed with the raw GL approach, assuming standard Texture2D (not OES).
    // Most WebXR camera images are regular textures now.

    // Minimal Shader for Quad
    if (!window.camQuadProg) {
        const vs = `attribute vec2 p; varying vec2 v; void main(){v=p*0.5+0.5; gl_Position=vec4(p,0,1);}`;
        const fs = `precision mediump float; uniform sampler2D t; varying vec2 v; void main(){gl_FragColor=texture2D(t,v);}`;
        const vsS = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vsS, vs); gl.compileShader(vsS);
        const fsS = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fsS, fs); gl.compileShader(fsS);
        const p = gl.createProgram(); gl.attachShader(p, vsS); gl.attachShader(p, fsS); gl.linkProgram(p);
        const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        window.camQuadProg = { p, buf, loc: gl.getAttribLocation(p, "p") };
    }

    const prog = window.camQuadProg;
    gl.useProgram(prog.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, prog.buf);
    gl.enableVertexAttribArray(prog.loc);
    gl.vertexAttribPointer(prog.loc, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cameraTexture);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Read
    gl.readPixels(0, 0, COLOR_SIZE, COLOR_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, colorBuffer);

    // Restore
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFBO);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

    // Reset Three state (important!)
    renderer.resetState();

    return { data: colorBuffer, width: COLOR_SIZE, height: COLOR_SIZE };
}
