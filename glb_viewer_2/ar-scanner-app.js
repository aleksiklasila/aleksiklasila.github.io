import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

let renderer, scene, camera;
let pointCloud, geometry, positions;
let numPoints = 0;
const MAX_POINTS = 50000;
let hitTestSource = null;
let hitTestSourceRequested = false;

// Callbacks
let onExitScanner = null;

// Scanning state
let isScanning = false;
let scanSessions = []; // [{startIndex, endIndex}] for undo

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

    // Point cloud setup
    geometry = new THREE.BufferGeometry();
    positions = new Float32Array(MAX_POINTS * 3);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // Smaller dots for better visual quality
    const material = new THREE.PointsMaterial({ color: 0x00ff00, size: 0.008, sizeAttenuation: true });
    pointCloud = new THREE.Points(geometry, material);
    pointCloud.frustumCulled = false;
    scene.add(pointCloud);

    // Setup scan/undo buttons
    setupScannerToolbar();

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
        numPoints = 0;
        hitTestSourceRequested = false;
        hitTestSource = null;
        isScanning = false;
        scanSessions = [];

        return true;
    } catch (err) {
        console.error('Failed to start AR Scanner:', err);
        alert('Scanner failed: ' + err.message);
        cleanup();
        return false;
    }
}

function setupScannerToolbar() {
    const scanBtn = document.getElementById('scanner-scan-btn');
    const undoBtn = document.getElementById('scanner-undo-btn');

    if (scanBtn) {
        // Press and hold to scan
        const startScanning = (e) => {
            e.preventDefault();
            e.stopPropagation();
            isScanning = true;
            scanBtn.classList.add('scanning');
            // Record start index for this scan session
            scanSessions.push({ startIndex: numPoints, endIndex: numPoints });
        };
        const stopScanning = (e) => {
            if (!isScanning) return;
            e.preventDefault();
            e.stopPropagation();
            isScanning = false;
            scanBtn.classList.remove('scanning');
            // Update end index for the current session
            if (scanSessions.length > 0) {
                scanSessions[scanSessions.length - 1].endIndex = numPoints;
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
    // Zero out positions from session.startIndex to session.endIndex
    for (let i = session.startIndex * 3; i < session.endIndex * 3; i++) {
        positions[i] = 0;
    }
    numPoints = session.startIndex;
    geometry.attributes.position.needsUpdate = true;
    geometry.setDrawRange(0, numPoints);
}

function onXRFrame(timestamp, frame) {
    if (!frame) return;
    const session = renderer.xr.getSession();
    const referenceSpace = renderer.xr.getReferenceSpace();

    if (!hitTestSourceRequested) {
        session.requestReferenceSpace('viewer').then((viewerRefSpace) => {
            session.requestHitTestSource({ space: viewerRefSpace }).then((source) => {
                hitTestSource = source;
            });
        });
        hitTestSourceRequested = true;
    }

    // Only accumulate points when scanning is active
    if (isScanning && hitTestSource && numPoints < MAX_POINTS) {
        const hitTestResults = frame.getHitTestResults(hitTestSource);
        if (hitTestResults.length > 0) {
            const hit = hitTestResults[0];
            const pose = hit.getPose(referenceSpace);
            if (pose) {
                const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
                const pos = new THREE.Vector3().setFromMatrixPosition(matrix);

                // Add points with slight noise to mimic density
                for (let i = 0; i < 3 && numPoints < MAX_POINTS; i++) {
                    const idx = numPoints * 3;
                    positions[idx] = pos.x + (Math.random() - 0.5) * 0.04;
                    positions[idx + 1] = pos.y;
                    positions[idx + 2] = pos.z + (Math.random() - 0.5) * 0.04;
                    numPoints++;
                }

                geometry.attributes.position.needsUpdate = true;
                geometry.setDrawRange(0, numPoints);

                // Update current session's endIndex
                if (scanSessions.length > 0) {
                    scanSessions[scanSessions.length - 1].endIndex = numPoints;
                }
            }
        }
    }

    renderer.render(scene, camera);
}

export async function endScannerSession() {
    const session = renderer?.xr?.getSession();
    if (session) {
        try {
            await session.end();
        } catch (e) { }
    }
    // Let event listener call cleanup
}

function cleanup() {
    hitTestSource = null;
    hitTestSourceRequested = false;
    isScanning = false;
    scanSessions = [];

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

export async function exportScanAsGLB() {
    if (numPoints === 0 || !pointCloud) {
        alert("No scan data accumulated.");
        return null;
    }

    return new Promise((resolve, reject) => {
        const exporter = new GLTFExporter();
        // Export just the point cloud mesh
        exporter.parse(
            pointCloud,
            (buffer) => {
                const blob = new Blob([buffer], { type: 'model/gltf-binary' });
                resolve(URL.createObjectURL(blob));
            },
            (error) => reject(error),
            { binary: true }
        );
    });
}
