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

// ---- Depth Estimation ----
let depthEstimator = null;
let depthModelLoading = false;
let depthModelReady = false;
let frameCounter = 0;
let depthInferenceRunning = false;     // Prevent overlapping inferences

// ---- Camera stream for depth estimation ----
let cameraStream = null;              // MediaStream from getUserMedia
let cameraVideo = null;               // Hidden <video> element
let captureCanvas = null;             // Offscreen canvas for frame capture
let captureCtx = null;                // 2D context of capture canvas
const CAPTURE_WIDTH = 320;            // Downsampled capture resolution
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

// ---- Camera Stream (getUserMedia) ----

/**
 * Start a back-camera video stream for depth inference.
 * The stream runs independently from WebXR and provides real camera imagery.
 */
async function startCameraStream() {
    try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'environment',
                width: { ideal: 640 },
                height: { ideal: 480 }
            },
            audio: false
        });

        cameraVideo = document.createElement('video');
        cameraVideo.srcObject = cameraStream;
        cameraVideo.setAttribute('playsinline', '');
        cameraVideo.setAttribute('autoplay', '');
        cameraVideo.muted = true;
        cameraVideo.style.display = 'none';
        document.body.appendChild(cameraVideo);
        await cameraVideo.play();

        // Create offscreen canvas for frame capture
        captureCanvas = document.createElement('canvas');
        captureCanvas.width = CAPTURE_WIDTH;
        captureCanvas.height = CAPTURE_HEIGHT;
        captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });

        updateScannerStatus('Camera stream started for depth estimation');
    } catch (e) {
        updateScannerStatus(`Camera stream error: ${e.message}`);
        cameraStream = null;
        cameraVideo = null;
    }
}

function stopCameraStream() {
    if (cameraStream) {
        cameraStream.getTracks().forEach(t => t.stop());
        cameraStream = null;
    }
    if (cameraVideo) {
        cameraVideo.pause();
        if (cameraVideo.parentElement) cameraVideo.parentElement.removeChild(cameraVideo);
        cameraVideo = null;
    }
    captureCanvas = null;
    captureCtx = null;
}

/**
 * Capture a frame from the live camera video stream.
 * Returns pixel data suitable for the depth estimation pipeline.
 */
function captureVideoFrame() {
    if (!cameraVideo || !captureCtx || cameraVideo.readyState < 2) return null;

    captureCtx.drawImage(cameraVideo, 0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT);
    const imageData = captureCtx.getImageData(0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT);
    return { data: new Uint8ClampedArray(imageData.data), width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT };
}

/**
 * Run depth inference on captured image and unproject to 3D points.
 */
async function processDepthFrame(imageData, view, cameraPoseMatrix, referenceSpace) {
    if (!depthModelReady || !depthEstimator || depthInferenceRunning) return;
    depthInferenceRunning = true;

    const t0 = performance.now();

    try {
        // Create RawImage from pixel data (RGBA → RGB handled by transformers.js)
        const rawImage = new RawImage(imageData.data, imageData.width, imageData.height, 4);

        // Run depth estimation
        const result = await depthEstimator(rawImage);
        const depthMap = result.depth; // RawImage with depth values

        const t1 = performance.now();
        const inferenceMs = Math.round(t1 - t0);

        // Get camera projection matrix to unproject pixels
        const projMatrix = new THREE.Matrix4().fromArray(view.projectionMatrix);
        const invProjMatrix = new THREE.Matrix4().copy(projMatrix).invert();
        const cameraWorldMatrix = new THREE.Matrix4().fromArray(cameraPoseMatrix);

        // Depth map dimensions
        const dw = depthMap.width;
        const dh = depthMap.height;
        const depthData = depthMap.data; // Float32Array of depth values

        // Find min/max depth for relative → metric scaling
        // Depth-Anything outputs relative (inverse) depth - higher value = closer
        let minDepth = Infinity, maxDepth = -Infinity;
        for (let i = 0; i < depthData.length; i++) {
            const d = depthData[i];
            if (d > 0) {
                if (d < minDepth) minDepth = d;
                if (d > maxDepth) maxDepth = d;
            }
        }

        // We'll use the depth range to scale relative depth to approximate meters.
        // With relative depth models, closer objects have higher values.
        // We invert and scale: metric_depth ≈ scale / relative_depth
        // The scale factor is calibrated assuming the scene is ~0.5m to ~5m away.
        // We use a heuristic: map the median depth range to ~2m.
        const depthRange = maxDepth - minDepth;
        if (depthRange <= 0) {
            depthInferenceRunning = false;
            return;
        }

        // Approximate metric scale: we assume the camera is looking at a scene
        // where the median depth is roughly 1.5m. The relative depth model
        // outputs higher values for closer objects.
        const scaleEstimate = 2.0; // Approximate metric scale factor

        let pointsAdded = 0;
        const step = Math.max(2, Math.floor(DEPTH_SAMPLE_STEP * (dw / imageData.width)));
        const worldPos = new THREE.Vector3();
        const ndcPos = new THREE.Vector4();

        for (let py = step; py < dh - step; py += step) {
            for (let px = step; px < dw - step; px += step) {
                const idx = py * dw + px;
                const relativeDepth = depthData[idx];

                if (relativeDepth <= 0) continue;

                // Convert relative depth to approximate metric depth
                // Higher relative depth = closer, so we invert
                const metricDepth = scaleEstimate * (maxDepth / relativeDepth);

                if (metricDepth < DEPTH_MIN || metricDepth > DEPTH_MAX) continue;

                // Convert pixel coords to NDC [-1, 1]
                const ndcX = (px / dw) * 2.0 - 1.0;
                const ndcY = 1.0 - (py / dh) * 2.0; // Flip Y

                // Unproject from NDC + depth to view space
                ndcPos.set(ndcX, ndcY, -1.0, 1.0);
                ndcPos.applyMatrix4(invProjMatrix);
                // ndcPos is now in view/camera space at the near plane
                // Scale by metric depth
                const viewDir = new THREE.Vector3(ndcPos.x / ndcPos.w, ndcPos.y / ndcPos.w, ndcPos.z / ndcPos.w).normalize();
                worldPos.copy(viewDir).multiplyScalar(metricDepth);

                // Transform from camera space to world space
                worldPos.applyMatrix4(cameraWorldMatrix);

                // Add splat at this position
                if (addSplatFromWorldPos(worldPos, cameraWorldMatrix)) {
                    pointsAdded++;
                }
            }
        }

        // Update session end index
        if (scanSessions.length > 0) {
            scanSessions[scanSessions.length - 1].endIndex = numSplats;
        }

        updateScannerStatus(`Depth: ${inferenceMs}ms, +${pointsAdded} pts (total: ${numSplats})`);

    } catch (e) {
        updateScannerStatus(`Depth inference err: ${e.message}`);
    }

    depthInferenceRunning = false;
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

    // ---- Toolbar ----
    setupScannerToolbar();

    // ---- Start loading depth model and camera stream in parallel ----
    loadDepthModel();
    startCameraStream();

    // ---- XR Session ----
    try {
        const session = await navigator.xr.requestSession('immersive-ar', {
            requiredFeatures: ['hit-test'],
            optionalFeatures: ['dom-overlay'],
            domOverlay: { root: containerEl }
        });

        renderer.xr.setReferenceSpaceType('local');
        await renderer.xr.setSession(session);

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

        // Update cursor from hit-test (visual indicator only)
        if (hitTestSource) {
            const hitTestResults = frame.getHitTestResults(hitTestSource);
            if (hitTestResults.length > 0) {
                const hit = hitTestResults[0];
                const pose = hit.getPose(referenceSpace);
                if (pose && cursorMesh) {
                    const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
                    cursorMesh.matrix.copy(matrix);
                    cursorMesh.visible = true;
                }
            } else if (cursorMesh) {
                cursorMesh.visible = false;
            }
        }

        // ---- Depth-based scanning ----
        if (isScanning && depthModelReady) {
            frameCounter++;

            if (frameCounter % DEPTH_INFERENCE_INTERVAL === 0 && !depthInferenceRunning) {
                // Get the XR view for camera intrinsics and pose
                const viewerPose = frame.getViewerPose(referenceSpace);
                if (viewerPose && viewerPose.views.length > 0) {
                    const view = viewerPose.views[0];
                    const cameraPoseMatrix = viewerPose.transform.matrix;

                    // Capture frame from live camera video stream
                    const imageData = captureVideoFrame();
                    if (imageData) {
                        // Run depth inference asynchronously (doesn't block render loop)
                        processDepthFrame(imageData, view, cameraPoseMatrix, referenceSpace);
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

    // Stop camera stream
    stopCameraStream();

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
