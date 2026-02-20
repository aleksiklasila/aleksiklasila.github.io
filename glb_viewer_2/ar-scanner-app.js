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

// UI
let exportBtn = null;
let exitBtn = null;

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
    // Use slightly larger points for visibility
    const material = new THREE.PointsMaterial({ color: 0x00ff00, size: 0.02, sizeAttenuation: true });
    pointCloud = new THREE.Points(geometry, material);
    pointCloud.frustumCulled = false; // Important since we dynamically update bounds
    scene.add(pointCloud);

    // Toolbar logic (Export specific to Scanner)
    exportBtn = document.getElementById('btn-export-glb');
    exitBtn = document.getElementById('ar-scanner-exit-btn');
    if (exportBtn) {
        exportBtn.onclick = async () => {
            const url = await exportScanAsGLB();
            if (url) {
                const a = document.createElement('a');
                a.href = url;
                a.download = 'environment_scan.glb';
                a.click();
            }
        };
    }
    if (exitBtn) {
        // Just trigger session end
        exitBtn.onclick = () => endScannerSession();
    }

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

        return true;
    } catch (err) {
        console.error('Failed to start AR Scanner:', err);
        alert('Scanner failed: ' + err.message);
        cleanup();
        return false;
    }
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

    if (hitTestSource && numPoints < MAX_POINTS) {
        const hitTestResults = frame.getHitTestResults(hitTestSource);
        if (hitTestResults.length > 0) {
            const hit = hitTestResults[0];
            const pose = hit.getPose(referenceSpace);
            if (pose) {
                // To create splats/denser cluster, we can add a few points around the hit.
                // For simplicity and performance, we'll store the hit position.
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
    if (exportBtn) exportBtn.onclick = null;
    if (exitBtn) exitBtn.onclick = null;
    hitTestSource = null;
    hitTestSourceRequested = false;

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
