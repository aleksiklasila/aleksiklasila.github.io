import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// ---- Configuration ----
const SPLAT_SIZE = 0.025;               // 2.5cm oriented surface quads
const MIN_DIST_SQ = 0.016 * 0.016;      // 1.6cm min distance squared
const MAX_SPLATS = 50000;
const GRID_CELL = 0.02;                  // spatial hash cell size

// ---- Scene State ----
let renderer, scene, camera;
let hitTestSource = null;
let hitTestSourceRequested = false;
let onExitScanner = null;

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

// ---- Spatial Grid Helpers ----
function gridKey(x, y, z) {
    return `${Math.floor(x / GRID_CELL)},${Math.floor(y / GRID_CELL)},${Math.floor(z / GRID_CELL)}`;
}

function isTooClose(pos) {
    const gx = Math.floor(pos.x / GRID_CELL);
    const gy = Math.floor(pos.y / GRID_CELL);
    const gz = Math.floor(pos.z / GRID_CELL);
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
                const cell = spatialGrid[`${gx + dx},${gy + dy},${gz + dz}`];
                if (cell) {
                    for (const idx of cell) {
                        if (splatPositions[idx].distanceToSquared(pos) < MIN_DIST_SQ) return true;
                    }
                }
            }
        }
    }
    return false;
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
    if (numSplats >= MAX_SPLATS) return false;

    const pos = new THREE.Vector3().setFromMatrixPosition(matrix);
    if (isTooClose(pos)) return false;

    // Store data
    splatPositions[numSplats] = pos;
    splatMatricesData[numSplats] = matrix.elements.slice();
    addToGrid(pos, numSplats);

    // Update InstancedMesh
    splatMesh.setMatrixAt(numSplats, matrix);
    numSplats++;
    splatMesh.count = numSplats;
    splatMesh.instanceMatrix.needsUpdate = true;

    return true;
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
    splatGeometry.rotateX(-Math.PI / 2); // Normal = +Y (up), lies in XZ

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

    // ---- Toolbar ----
    setupScannerToolbar();

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
    // Truncate data back to session start
    numSplats = session.startIndex;
    splatPositions.length = numSplats;
    splatMatricesData.length = numSplats;
    splatMesh.count = numSplats;
    splatMesh.instanceMatrix.needsUpdate = true;

    // Rebuild spatial grid from remaining points
    rebuildGrid();
}

// ---- XR Render Loop ----

function onXRFrame(timestamp, frame) {
    if (!frame) return;
    const session = renderer.xr.getSession();
    const referenceSpace = renderer.xr.getReferenceSpace();

    // Request hit-test source once
    if (!hitTestSourceRequested) {
        session.requestReferenceSpace('viewer').then((viewerRefSpace) => {
            session.requestHitTestSource({ space: viewerRefSpace }).then((source) => {
                hitTestSource = source;
            });
        });
        hitTestSourceRequested = true;
    }

    // Process hit-test results every frame
    if (hitTestSource) {
        const hitTestResults = frame.getHitTestResults(hitTestSource);
        if (hitTestResults.length > 0) {
            const hit = hitTestResults[0];
            const pose = hit.getPose(referenceSpace);
            if (pose) {
                const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix);

                // Update cursor position (always visible when surface detected)
                if (cursorMesh) {
                    cursorMesh.matrix.copy(matrix);
                    cursorMesh.visible = true;
                }

                // Accumulate splats when scanning
                if (isScanning) {
                    // Add the exact hit point
                    addSplat(matrix);

                    // Add nearby points along the surface for faster coverage
                    for (let i = 0; i < 3; i++) {
                        const offset = new THREE.Matrix4().makeTranslation(
                            (Math.random() - 0.5) * SPLAT_SIZE * 3,
                            0,
                            (Math.random() - 0.5) * SPLAT_SIZE * 3
                        );
                        addSplat(new THREE.Matrix4().copy(matrix).multiply(offset));
                    }

                    // Update session end index
                    if (scanSessions.length > 0) {
                        scanSessions[scanSessions.length - 1].endIndex = numSplats;
                    }
                }
            }
        } else {
            // No surface — hide cursor
            if (cursorMesh) cursorMesh.visible = false;
        }
    }

    renderer.render(scene, camera);
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

    // Template geometry for each splat (already rotated)
    const template = splatGeometry;
    const tPos = template.attributes.position;
    const tNorm = template.attributes.normal;
    const tIdx = template.index;
    const vertsPerSplat = tPos.count;       // 4 for PlaneGeometry
    const indicesPerSplat = tIdx.count;     // 6 for PlaneGeometry (2 triangles)

    // Allocate merged arrays
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

        // Transform vertices and normals
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

        // Copy indices (offset by vertex count)
        const iOff = s * indicesPerSplat;
        for (let ii = 0; ii < indicesPerSplat; ii++) {
            mIdx[iOff + ii] = tIdx.array[ii] + vOff;
        }
    }

    // Build merged geometry
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
