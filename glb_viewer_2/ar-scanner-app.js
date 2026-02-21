import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { pipeline, env, RawImage } from '@huggingface/transformers';

// ---- Configuration ----
const SPLAT_SIZE = 0.02;               // 2cm oriented surface quads
const MIN_DIST_SQ = 0.012 * 0.012;     // 1.2cm min distance squared
const MAX_SPLATS = 80000;
const GRID_CELL = 0.015;               // spatial hash cell size
const DEPTH_INFERENCE_INTERVAL = 4;    // Run depth inference every N frames
const DEPTH_SAMPLE_STEP = 8;           // Sample every Nth pixel from depth map
const DEPTH_MIN = 0.1;                 // Ignore depth < 10cm (too close / noise)
const DEPTH_MAX = 5.0;                 // Ignore depth > 5m (too far / unreliable)

// ---- Scene State ----
let renderer, scene, camera;
let hitTestSource = null;
let hitTestSourceRequested = false;
let onExitScanner = null;
let scannerDebugEl = null;

// ---- Calibration State ----
let depthScaleFactor = 0;              // 0 = uncalibrated, positive = calibrated
let lastHitTestDepth = 0;              // Distance from camera to hit-test point
let lastHitTestPos = new THREE.Vector3();
let lastCameraPos = new THREE.Vector3();
let pendingCalibration = false;        // True when user clicked calibrate

// ---- Debug Depth Viewer ----
let debugDepthVisible = false;
let debugDepthCanvas = null;
let debugDepthCtx = null;
let lastDepthMapData = null;           // Store last depth map for debug rendering

// ---- Depth Estimation ----
let depthEstimator = null;
let depthModelLoading = false;
let depthModelReady = false;
let frameCounter = 0;
let depthInferenceRunning = false;     // Prevent overlapping inferences

// ---- XR Camera Capture (via camera-access feature) ----
let xrGLBinding = null;               // XRWebGLBinding for getCameraImage
let captureFBO = null;                // Framebuffer for camera texture
let captureSmallFBO = null;           // Small framebuffer for downsampled read
let captureSmallTex = null;           // Small texture attached to captureSmallFBO
let cameraAccessAvailable = false;
const CAPTURE_WIDTH = 320;
const CAPTURE_HEIGHT = 240;

export function updateScannerStatus(msg) {
    if (!scannerDebugEl) scannerDebugEl = document.getElementById('scanner-debug-console');
    if (scannerDebugEl) {
        scannerDebugEl.textContent = msg + '\n' + scannerDebugEl.textContent;
    }
}

// ---- Scanning State ----
let isScanning = false;
let scanSessions = []; // [{startIndex, endIndex}] for undo

// ---- Splat Rendering & Data ----
let splatMesh = null;           // InstancedMesh for scan splats
let splatGeometry = null;       // Shared PlaneGeometry template
let numSplats = 0;
let splatPositions = [];        // Vector3[] for distance checks
let splatMatricesData = [];     // Float32Array(16)[] for export
let spatialGrid = {};           // { "gx,gy,gz": [index, ...] }

// ---- Cursor ----
let cursorMesh = null;          // Black circle at hit-test position

// Global re-usable objects
const _tmpPos = new THREE.Vector3();
const _viewPos = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _invProj = new THREE.Matrix4();
const _camMatrix = new THREE.Matrix4();
const _dummyObj = new THREE.Object3D();
const _splatMatrix = new THREE.Matrix4();
const _tmpMatrix = new THREE.Matrix4();

// ---- Spatial Grid Helpers ----
function gridKey(x, y, z) {
    return `${Math.floor(x / GRID_CELL)},${Math.floor(y / GRID_CELL)},${Math.floor(z / GRID_CELL)}`;
}

function isTooClose(pos) {
    try {
        const gx = Math.floor(pos.x / GRID_CELL);
        const gy = Math.floor(pos.y / GRID_CELL);
        const gz = Math.floor(pos.z / GRID_CELL);

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const key = `${gx + dx},${gy + dy},${gz + dz}`;
                    const cell = spatialGrid[key];
                    if (cell) {
                        for (const idx of cell) {
                            if (splatPositions[idx].distanceToSquared(pos) < MIN_DIST_SQ) return true;
                        }
                    }
                }
            }
        }
        return false;
    } catch (e) {
        updateScannerStatus(`isTooClose err: ${e.message}`);
        return false;
    }
}

function addToGrid(pos, index) {
    const key = gridKey(pos.x, pos.y, pos.z);
    if (!spatialGrid[key]) spatialGrid[key] = [];
    spatialGrid[key].push(index);
}

function rebuildGrid() {
    spatialGrid = {};
    for (let i = 0; i < numSplats; i++) {
        addToGrid(splatPositions[i], i);
    }
}

// ---- Add Splat ----
function addSplat(matrix) {
    try {
        if (numSplats >= MAX_SPLATS) return false;

        _tmpPos.setFromMatrixPosition(matrix);
        if (isTooClose(_tmpPos)) return false;

        const pos = _tmpPos.clone();

        splatPositions[numSplats] = pos;
        splatMatricesData[numSplats] = matrix.elements.slice();
        addToGrid(pos, numSplats);

        splatMesh.setMatrixAt(numSplats, matrix);
        numSplats++;
        splatMesh.count = numSplats;

        return true;
    } catch (e) {
        updateScannerStatus(`addSplat err: ${e.message}`);
        return false;
    }
}

// ---- Add splat from world position with camera-facing orientation ----
function addSplatFromWorldPos(worldPos, cameraPose) {
    // Create a matrix that places a small quad at worldPos, oriented to face the camera
    _dummyObj.position.copy(worldPos);
    // Look at camera position for orientation
    _camPos.setFromMatrixPosition(cameraPose);
    _dummyObj.lookAt(_camPos);
    _dummyObj.scale.set(1, 1, 1);
    _dummyObj.updateMatrix();
    return addSplat(_dummyObj.matrix);
}

// ---- Depth Estimation Pipeline ----

async function loadDepthModel() {
    if (depthModelLoading || depthModelReady) return;
    depthModelLoading = true;

    const loadingEl = document.getElementById('scanner-model-loading');
    const progressTextEl = document.getElementById('scanner-model-progress');
    const progressBarEl = document.getElementById('scanner-model-progress-bar');

    if (loadingEl) loadingEl.style.display = 'flex';

    updateScannerStatus('Loading depth estimation model...');

    // Configure ONNX Runtime WASM paths for CDN usage
    env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';

    // Progress callback shared across attempts
    const progressCb = (progress) => {
        if (progress.status === 'download' || progress.status === 'progress') {
            const pct = progress.progress ? Math.round(progress.progress) : 0;
            if (progressTextEl) progressTextEl.textContent = `Downloading model... ${pct}%`;
            if (progressBarEl) progressBarEl.style.width = `${pct}%`;
        } else if (progress.status === 'ready') {
            if (progressTextEl) progressTextEl.textContent = 'Model ready!';
            if (progressBarEl) progressBarEl.style.width = '100%';
        }
    };

    // Try backends in order: wasm (most compatible), then webgpu
    const backends = ['wasm', 'webgpu'];
    for (const backend of backends) {
        try {
            updateScannerStatus(`Trying ${backend} backend...`);
            if (progressTextEl) progressTextEl.textContent = `Loading (${backend})...`;

            depthEstimator = await pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small', {
                device: backend,
                progress_callback: progressCb,
            });

            depthModelReady = true;
            depthModelLoading = false;
            updateScannerStatus(`Depth model loaded (${backend})!`);
            setTimeout(() => { if (loadingEl) loadingEl.style.display = 'none'; }, 500);
            return; // Success!

        } catch (err) {
            updateScannerStatus(`${backend} backend failed: ${err.message}`);
        }
    }

    // All backends failed
    depthModelLoading = false;
    updateScannerStatus('All depth backends failed - scanning limited to hit-test only');
    if (progressTextEl) progressTextEl.textContent = 'Model load failed - using hit-test only';
    setTimeout(() => { if (loadingEl) loadingEl.style.display = 'none'; }, 2000);
}

// ---- XR Camera Capture ----

/**
 * Initialize WebGL resources for capturing the XR camera texture.
 * Must be called after the WebGL context is available.
 */
function initCameraCapture(gl) {
    // Save current framebuffer
    const prevFB = gl.getParameter(gl.FRAMEBUFFER_BINDING);

    // FBO to attach the camera texture for reading
    captureFBO = gl.createFramebuffer();

    // Small FBO + texture for downsampled capture
    captureSmallTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, captureSmallTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, CAPTURE_WIDTH, CAPTURE_HEIGHT, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    captureSmallFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, captureSmallFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, captureSmallTex, 0);

    // Restore previous framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
    gl.bindTexture(gl.TEXTURE_2D, null);
}

/**
 * Capture a frame from the XR camera using getCameraImage.
 * Uses blitFramebuffer to downsample efficiently.
 */
function captureXRCameraFrame(gl, view) {
    if (!xrGLBinding || !view.camera) return null;

    try {
        // Save the current framebuffer binding (the XR framebuffer)
        // We MUST restore this afterward — binding to null would break
        // Three.js's internal state tracking and cause dual-layer rendering.
        const prevFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);

        const cameraTexture = xrGLBinding.getCameraImage(view.camera);
        if (!cameraTexture) return null;

        const camW = view.camera.width;
        const camH = view.camera.height;

        // Attach camera texture to source FBO
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, captureFBO);
        gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cameraTexture, 0);

        // Blit (downsample) to small FBO
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, captureSmallFBO);
        gl.blitFramebuffer(
            0, 0, camW, camH,
            0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT,
            gl.COLOR_BUFFER_BIT, gl.LINEAR
        );

        // Read pixels from small FBO
        gl.bindFramebuffer(gl.FRAMEBUFFER, captureSmallFBO);
        const pixels = new Uint8Array(CAPTURE_WIDTH * CAPTURE_HEIGHT * 4);
        gl.readPixels(0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        // Restore the XR framebuffer (NOT null!)
        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFramebuffer);

        // Flip Y (WebGL is bottom-up)
        const flipped = new Uint8ClampedArray(CAPTURE_WIDTH * CAPTURE_HEIGHT * 4);
        for (let y = 0; y < CAPTURE_HEIGHT; y++) {
            const srcRow = (CAPTURE_HEIGHT - 1 - y) * CAPTURE_WIDTH * 4;
            const dstRow = y * CAPTURE_WIDTH * 4;
            flipped.set(pixels.subarray(srcRow, srcRow + CAPTURE_WIDTH * 4), dstRow);
        }

        return { data: flipped, width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT };
    } catch (e) {
        updateScannerStatus(`Camera capture err: ${e.message}`);
        return null;
    }
}

function cleanupCameraCapture(gl) {
    if (captureFBO) { gl.deleteFramebuffer(captureFBO); captureFBO = null; }
    if (captureSmallFBO) { gl.deleteFramebuffer(captureSmallFBO); captureSmallFBO = null; }
    if (captureSmallTex) { gl.deleteTexture(captureSmallTex); captureSmallTex = null; }
    xrGLBinding = null;
    cameraAccessAvailable = false;
}

/**
 * Run depth inference on captured image and unproject to 3D points.
 * IMPORTANT: projMatrixClone and cameraPoseClone must be CLONED matrices,
 * not live references that may be overwritten by the XR runtime.
 */
async function processDepthFrame(imageData, projMatrixClone, cameraPoseClone) {
    if (!depthModelReady || !depthEstimator || depthInferenceRunning) return;
    depthInferenceRunning = true;

    const t0 = performance.now();

    try {
        // Create RawImage from pixel data
        const rawImage = new RawImage(imageData.data, imageData.width, imageData.height, 4);

        // Run depth estimation
        const result = await depthEstimator(rawImage);
        const depthMap = result.depth; // RawImage with depth values

        const t1 = performance.now();
        const inferenceMs = Math.round(t1 - t0);

        // Depth map dimensions
        const dw = depthMap.width;
        const dh = depthMap.height;
        const depthData = depthMap.data; // Float32Array of relative depth values

        // Store for debug rendering
        lastDepthMapData = { data: depthData, width: dw, height: dh };

        // Render debug depth map if visible
        if (debugDepthVisible) {
            renderDebugDepthMap(depthData, dw, dh);
        }

        // Find min/max relative depth
        let minRel = Infinity, maxRel = -Infinity;
        for (let i = 0; i < depthData.length; i++) {
            const d = depthData[i];
            if (d > 0) {
                if (d < minRel) minRel = d;
                if (d > maxRel) maxRel = d;
            }
        }

        const relRange = maxRel - minRel;
        if (relRange <= 0) {
            depthInferenceRunning = false;
            return;
        }

        // Handle calibration request
        if (pendingCalibration && lastHitTestDepth > 0.05) {
            // Get the relative depth at the center of the depth map (where cursor is)
            const cx = Math.floor(dw / 2);
            const cy = Math.floor(dh / 2);
            const centerRelDepth = depthData[cy * dw + cx];
            if (centerRelDepth > 0) {
                // scale = hitTestDepth * centerRelativeDepth
                // so that: metricDepth = scale / relativeDepth
                depthScaleFactor = lastHitTestDepth * centerRelDepth;
                updateScannerStatus(`Calibrated! scale=${depthScaleFactor.toFixed(3)}, hitDist=${lastHitTestDepth.toFixed(2)}m`);
            }
            pendingCalibration = false;
        }

        // If not calibrated, skip depth-based splatting
        if (depthScaleFactor <= 0) {
            updateScannerStatus(`Depth: ${inferenceMs}ms (uncalibrated - tap 🎯 to calibrate)`);
            depthInferenceRunning = false;
            return;
        }

        // Unproject using cloned matrices
        const invProjMatrix = new THREE.Matrix4().copy(projMatrixClone).invert();

        let pointsAdded = 0;
        const step = Math.max(2, Math.floor(DEPTH_SAMPLE_STEP * (dw / imageData.width)));
        const worldPos = new THREE.Vector3();
        const ndcPos = new THREE.Vector4();
        const viewDir = new THREE.Vector3();

        for (let py = step; py < dh - step; py += step) {
            for (let px = step; px < dw - step; px += step) {
                const idx = py * dw + px;
                const relativeDepth = depthData[idx];

                if (relativeDepth <= 0) continue;

                // Convert relative to metric using calibrated scale
                // Depth-Anything: higher values = closer, so metric = scale / relative
                const metricDepth = depthScaleFactor / relativeDepth;

                if (metricDepth < DEPTH_MIN || metricDepth > DEPTH_MAX) continue;

                // Convert pixel coords to NDC [-1, 1]
                const ndcX = (px / dw) * 2.0 - 1.0;
                const ndcY = 1.0 - (py / dh) * 2.0; // Flip Y

                // Unproject: NDC → view-space ray (un-normalized)
                ndcPos.set(ndcX, ndcY, -1.0, 1.0);
                ndcPos.applyMatrix4(invProjMatrix);
                const rayX = ndcPos.x / ndcPos.w;
                const rayY = ndcPos.y / ndcPos.w;
                const rayZ = ndcPos.z / ndcPos.w;

                // Depth models output Z-depth (perpendicular distance from camera
                // plane), NOT ray distance. Scale the ray so that its Z-component
                // equals -metricDepth. Camera looks along -Z in view space.
                // t = -metricDepth / rayZ  (rayZ is negative, so t is positive)
                const t = -metricDepth / rayZ;
                worldPos.set(rayX * t, rayY * t, -metricDepth);

                // Camera space → World space
                worldPos.applyMatrix4(cameraPoseClone);

                if (addSplatFromWorldPos(worldPos, cameraPoseClone)) {
                    pointsAdded++;
                }
            }
        }

        // Update session end index
        if (scanSessions.length > 0) {
            scanSessions[scanSessions.length - 1].endIndex = numSplats;
        }

        updateScannerStatus(`Depth: ${inferenceMs}ms, +${pointsAdded} pts, scale=${depthScaleFactor.toFixed(2)} (total: ${numSplats})`);

    } catch (e) {
        updateScannerStatus(`Depth inference err: ${e.message}`);
    }

    depthInferenceRunning = false;
}

// ---- Debug Depth Map Rendering ----

function renderDebugDepthMap(depthData, dw, dh) {
    if (!debugDepthCanvas) {
        debugDepthCanvas = document.getElementById('scanner-depth-canvas');
        if (debugDepthCanvas) debugDepthCtx = debugDepthCanvas.getContext('2d');
    }
    if (!debugDepthCtx) return;

    const cw = debugDepthCanvas.width;
    const ch = debugDepthCanvas.height;
    const imgData = debugDepthCtx.createImageData(cw, ch);

    // Find min/max for normalization
    let minD = Infinity, maxD = -Infinity;
    for (let i = 0; i < depthData.length; i++) {
        if (depthData[i] > 0) {
            if (depthData[i] < minD) minD = depthData[i];
            if (depthData[i] > maxD) maxD = depthData[i];
        }
    }
    const range = maxD - minD || 1;

    for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
            const sx = Math.floor(x * dw / cw);
            const sy = Math.floor(y * dh / ch);
            const d = depthData[sy * dw + sx];
            // Map depth to color: closer (higher) = warm, farther (lower) = cool
            const norm = (d - minD) / range; // 0..1, higher = closer
            const r = Math.floor(norm * 255);
            const g = Math.floor((1 - Math.abs(norm - 0.5) * 2) * 200);
            const b = Math.floor((1 - norm) * 255);
            const pi = (y * cw + x) * 4;
            imgData.data[pi] = r;
            imgData.data[pi + 1] = g;
            imgData.data[pi + 2] = b;
            imgData.data[pi + 3] = 255;
        }
    }

    debugDepthCtx.putImageData(imgData, 0, 0);

    // Show info
    const infoEl = document.getElementById('scanner-depth-info');
    if (infoEl) {
        infoEl.textContent = `Depth range: ${minD.toFixed(1)}-${maxD.toFixed(1)} | Scale: ${depthScaleFactor > 0 ? depthScaleFactor.toFixed(2) : 'uncalibrated'}`;
    }
}

// ---- Public API ----

export async function isScannerSupported() {
    if (!navigator.xr) return false;
    try {
        return await navigator.xr.isSessionSupported('immersive-ar');
    } catch {
        return false;
    }
}

export async function startScannerSession(containerEl, callbacks) {
    onExitScanner = callbacks?.onExit || null;

    if (!navigator.xr) {
        alert('WebXR is not supported on this device/browser.');
        return false;
    }

    const supported = await navigator.xr.isSessionSupported('immersive-ar');
    if (!supported) {
        alert('Immersive AR is not supported on this device.');
        return false;
    }

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    containerEl.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);

    // ---- Splat geometry (small surface-oriented quad) ----
    splatGeometry = new THREE.PlaneGeometry(SPLAT_SIZE, SPLAT_SIZE);

    // ---- InstancedMesh for scan splats ----
    const splatMaterial = new THREE.MeshBasicMaterial({
        color: 0x00ff00,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.7,
    });
    splatMesh = new THREE.InstancedMesh(splatGeometry, splatMaterial, MAX_SPLATS);
    splatMesh.count = 0;
    splatMesh.frustumCulled = false;
    scene.add(splatMesh);

    // ---- Cursor indicator (black filled circle) ----
    const cursorGeo = new THREE.CircleGeometry(SPLAT_SIZE / 2, 24);
    cursorGeo.rotateX(-Math.PI / 2);
    const cursorMat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
    });
    cursorMesh = new THREE.Mesh(cursorGeo, cursorMat);
    cursorMesh.matrixAutoUpdate = false;
    cursorMesh.visible = false;
    scene.add(cursorMesh);

    // ---- Reset state ----
    numSplats = 0;
    splatPositions = [];
    splatMatricesData = [];
    spatialGrid = {};
    isScanning = false;
    scanSessions = [];
    frameCounter = 0;
    depthInferenceRunning = false;
    depthScaleFactor = 0;
    lastHitTestDepth = 0;
    pendingCalibration = false;
    debugDepthVisible = false;
    debugDepthCanvas = null;
    debugDepthCtx = null;
    lastDepthMapData = null;

    // ---- Toolbar ----
    setupScannerToolbar();

    // ---- Start loading depth model in parallel ----
    loadDepthModel();

    // ---- XR Session ----
    try {
        const session = await navigator.xr.requestSession('immersive-ar', {
            requiredFeatures: ['hit-test'],
            optionalFeatures: ['dom-overlay', 'camera-access'],
            domOverlay: { root: containerEl }
        });

        renderer.xr.setReferenceSpaceType('local');
        await renderer.xr.setSession(session);

        // Create XRWebGLBinding for camera access
        const gl = renderer.getContext();
        try {
            xrGLBinding = new XRWebGLBinding(session, gl);
            initCameraCapture(gl);
            cameraAccessAvailable = true;
            updateScannerStatus('XR camera access initialized');
        } catch (e) {
            updateScannerStatus(`Camera access not available: ${e.message}`);
            cameraAccessAvailable = false;
        }

        session.addEventListener('end', () => {
            cleanup();
            if (onExitScanner) onExitScanner();
        });

        renderer.setAnimationLoop(onXRFrame);
        hitTestSourceRequested = false;
        hitTestSource = null;

        return true;
    } catch (err) {
        console.error('Failed to start AR Scanner:', err);
        alert('Scanner failed: ' + err.message);
        cleanup();
        return false;
    }
}

// ---- Toolbar ----

function setupScannerToolbar() {
    const scanBtn = document.getElementById('scanner-scan-btn');
    const undoBtn = document.getElementById('scanner-undo-btn');

    if (scanBtn) {
        const startScanning = (e) => {
            e.preventDefault();
            e.stopPropagation();
            isScanning = true;
            scanBtn.classList.add('scanning');
            // Record start index for this scan session
            scanSessions.push({ startIndex: numSplats, endIndex: numSplats });
        };
        const stopScanning = (e) => {
            if (!isScanning) return;
            e.preventDefault();
            e.stopPropagation();
            isScanning = false;
            scanBtn.classList.remove('scanning');
            // Update end index
            if (scanSessions.length > 0) {
                scanSessions[scanSessions.length - 1].endIndex = numSplats;
            }
        };

        scanBtn.addEventListener('touchstart', startScanning, { passive: false });
        scanBtn.addEventListener('mousedown', startScanning);
        document.addEventListener('touchend', stopScanning);
        document.addEventListener('mouseup', stopScanning);
    }

    if (undoBtn) {
        undoBtn.onclick = (e) => {
            e.stopPropagation();
            undoLastScan();
        };
    }

    // ---- Calibrate button ----
    const calibrateBtn = document.getElementById('scanner-calibrate-btn');
    if (calibrateBtn) {
        calibrateBtn.onclick = (e) => {
            e.stopPropagation();
            if (lastHitTestDepth > 0.05) {
                pendingCalibration = true;
                updateScannerStatus('Calibration pending... waiting for next depth frame');
                calibrateBtn.classList.add('scanning');
                setTimeout(() => calibrateBtn.classList.remove('scanning'), 1500);
            } else {
                updateScannerStatus('Point camera at a surface first (cursor must be visible)');
            }
        };
    }

    // ---- Debug depth view toggle ----
    const debugBtn = document.getElementById('scanner-debug-btn');
    if (debugBtn) {
        debugBtn.onclick = (e) => {
            e.stopPropagation();
            debugDepthVisible = !debugDepthVisible;
            debugBtn.classList.toggle('active', debugDepthVisible);
            const debugPanel = document.getElementById('scanner-depth-debug');
            if (debugPanel) debugPanel.style.display = debugDepthVisible ? 'block' : 'none';
            // Expand the scanner panel so the debug view is visible
            if (debugDepthVisible) {
                const panel = document.getElementById('scanner-object-panel');
                if (panel) {
                    panel.style.height = '320px';
                    panel.classList.remove('collapsed');
                }
            }
        };
    }
}

function undoLastScan() {
    if (scanSessions.length === 0) return;

    const session = scanSessions.pop();
    numSplats = session.startIndex;
    splatPositions.length = numSplats;
    splatMatricesData.length = numSplats;
    splatMesh.count = numSplats;
    splatMesh.instanceMatrix.needsUpdate = true;

    rebuildGrid();
}

// ---- XR Render Loop ----

function onXRFrame(timestamp, frame) {
    try {
        if (!frame) return;
        const session = renderer.xr.getSession();
        const referenceSpace = renderer.xr.getReferenceSpace();

        // Request hit-test source once (for cursor indicator)
        if (!hitTestSourceRequested) {
            session.requestReferenceSpace('viewer').then((viewerRefSpace) => {
                session.requestHitTestSource({
                    space: viewerRefSpace,
                    entityTypes: ['point', 'plane']
                }).then((source) => {
                    hitTestSource = source;
                });
            });
            hitTestSourceRequested = true;
        }

        // Update cursor from hit-test and track depth for calibration
        if (hitTestSource) {
            const hitTestResults = frame.getHitTestResults(hitTestSource);
            if (hitTestResults.length > 0) {
                const hit = hitTestResults[0];
                const pose = hit.getPose(referenceSpace);
                if (pose) {
                    const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
                    if (cursorMesh) {
                        cursorMesh.matrix.copy(matrix);
                        cursorMesh.visible = true;
                    }

                    // Track hit-test depth for calibration
                    const viewerPose = frame.getViewerPose(referenceSpace);
                    if (viewerPose) {
                        lastHitTestPos.setFromMatrixPosition(matrix);
                        lastCameraPos.set(
                            viewerPose.transform.position.x,
                            viewerPose.transform.position.y,
                            viewerPose.transform.position.z
                        );
                        lastHitTestDepth = lastCameraPos.distanceTo(lastHitTestPos);
                    }
                }
            } else if (cursorMesh) {
                cursorMesh.visible = false;
            }
        }

        // ---- Depth-based scanning ----
        // Run depth inference when scanning, or when debug view is visible (for visualization)
        if (depthModelReady && (isScanning || debugDepthVisible || pendingCalibration)) {
            frameCounter++;

            if (frameCounter % DEPTH_INFERENCE_INTERVAL === 0 && !depthInferenceRunning) {
                const viewerPose = frame.getViewerPose(referenceSpace);
                if (viewerPose && viewerPose.views.length > 0) {
                    const view = viewerPose.views[0];

                    // CRITICAL: Clone matrices NOW before the async call.
                    // viewerPose.transform.matrix and view.projectionMatrix are live references
                    // that get overwritten by the XR runtime on the next frame.
                    const projMatrixClone = new THREE.Matrix4().fromArray(view.projectionMatrix);
                    const cameraPoseClone = new THREE.Matrix4().fromArray(viewerPose.transform.matrix);

                    // Capture frame from XR camera
                    const gl = renderer.getContext();
                    const imageData = cameraAccessAvailable ? captureXRCameraFrame(gl, view) : null;
                    if (imageData) {
                        processDepthFrame(imageData, projMatrixClone, cameraPoseClone);
                    }
                }
            }
        }

        // Also add hit-test splats when scanning (as supplementary points)
        if (isScanning && hitTestSource) {
            const hitTestResults = frame.getHitTestResults(hitTestSource);
            if (hitTestResults.length > 0) {
                const hit = hitTestResults[0];
                const pose = hit.getPose(referenceSpace);
                if (pose) {
                    const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
                    addSplat(matrix);

                    // Add nearby surface points
                    for (let i = 0; i < 4; i++) {
                        const angle = (i / 4) * Math.PI * 2;
                        const radius = SPLAT_SIZE * (1.5 + Math.random() * 2);
                        const offset = new THREE.Matrix4().makeTranslation(
                            Math.cos(angle) * radius,
                            0,
                            Math.sin(angle) * radius
                        );
                        addSplat(new THREE.Matrix4().copy(matrix).multiply(offset));
                    }

                    if (scanSessions.length > 0) {
                        scanSessions[scanSessions.length - 1].endIndex = numSplats;
                    }
                }
            }
        }

        // Update GPU buffer only ONCE per frame
        if (isScanning && splatMesh) {
            splatMesh.instanceMatrix.needsUpdate = true;
        }

        renderer.render(scene, camera);

    } catch (e) {
        updateScannerStatus(`XRFrame err: ${e.message} ${e.stack}`);
        if (isScanning) {
            isScanning = false;
            const scanBtn = document.getElementById('scanner-scan-btn');
            if (scanBtn) scanBtn.classList.remove('scanning');
        }
    }
}

// ---- Session Management ----

export async function endScannerSession() {
    const session = renderer?.xr?.getSession();
    if (session) {
        try {
            await session.end();
        } catch (e) { }
    }
}

function cleanup() {
    hitTestSource = null;
    hitTestSourceRequested = false;
    isScanning = false;
    scanSessions = [];
    numSplats = 0;
    splatPositions = [];
    splatMatricesData = [];
    spatialGrid = {};
    cursorMesh = null;
    splatMesh = null;
    splatGeometry = null;
    frameCounter = 0;
    depthInferenceRunning = false;

    // Clean up XR camera capture resources
    if (renderer) {
        const gl = renderer.getContext();
        if (gl) cleanupCameraCapture(gl);
    }

    if (renderer) {
        renderer.setAnimationLoop(null);
        if (renderer.domElement && renderer.domElement.parentElement) {
            renderer.domElement.parentElement.removeChild(renderer.domElement);
        }
        renderer.dispose();
        renderer = null;
    }
    scene = null;
    camera = null;
}

// ---- GLB Export (merged mesh) ----

export async function exportScanAsGLB() {
    if (numSplats === 0 || !splatGeometry) {
        alert("No scan data accumulated.");
        return null;
    }

    const template = splatGeometry;
    const tPos = template.attributes.position;
    const tNorm = template.attributes.normal;
    const tIdx = template.index;
    const vertsPerSplat = tPos.count;
    const indicesPerSplat = tIdx.count;

    const totalVerts = numSplats * vertsPerSplat;
    const totalIndices = numSplats * indicesPerSplat;
    const mPos = new Float32Array(totalVerts * 3);
    const mNorm = new Float32Array(totalVerts * 3);
    const mIdx = totalVerts > 65535 ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices);

    const mat4 = new THREE.Matrix4();
    const normalMat = new THREE.Matrix3();
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();

    for (let s = 0; s < numSplats; s++) {
        mat4.fromArray(splatMatricesData[s]);
        normalMat.getNormalMatrix(mat4);

        const vOff = s * vertsPerSplat;

        for (let vi = 0; vi < vertsPerSplat; vi++) {
            v.fromArray(tPos.array, vi * 3).applyMatrix4(mat4);
            mPos[(vOff + vi) * 3] = v.x;
            mPos[(vOff + vi) * 3 + 1] = v.y;
            mPos[(vOff + vi) * 3 + 2] = v.z;

            n.fromArray(tNorm.array, vi * 3).applyMatrix3(normalMat).normalize();
            mNorm[(vOff + vi) * 3] = n.x;
            mNorm[(vOff + vi) * 3 + 1] = n.y;
            mNorm[(vOff + vi) * 3 + 2] = n.z;
        }

        const iOff = s * indicesPerSplat;
        for (let ii = 0; ii < indicesPerSplat; ii++) {
            mIdx[iOff + ii] = tIdx.array[ii] + vOff;
        }
    }

    const mergedGeo = new THREE.BufferGeometry();
    mergedGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3));
    mergedGeo.setAttribute('normal', new THREE.BufferAttribute(mNorm, 3));
    mergedGeo.setIndex(new THREE.BufferAttribute(mIdx, 1));

    const mesh = new THREE.Mesh(mergedGeo, new THREE.MeshStandardMaterial({
        color: 0xcccccc,
        side: THREE.DoubleSide,
        roughness: 0.7,
        metalness: 0.1
    }));

    return new Promise((resolve, reject) => {
        const exporter = new GLTFExporter();
        exporter.parse(
            mesh,
            (buffer) => {
                const blob = new Blob([buffer], { type: 'model/gltf-binary' });
                resolve(URL.createObjectURL(blob));
            },
            (error) => reject(error),
            { binary: true }
        );
    });
}
