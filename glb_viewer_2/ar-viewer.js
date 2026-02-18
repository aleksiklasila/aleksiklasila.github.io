// ============================================================
// ar-viewer.js — Custom Three.js WebXR AR Viewer
// ============================================================
// Replaces model-viewer's broken WebXR AR mode with a direct
// Three.js implementation using hit-test API for proper
// world-anchored floor placement and touch gesture support.
// ============================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

let renderer, scene, camera;
let arModel = null;
let reticle = null;
let hitTestSource = null;
let hitTestSourceRequested = false;
let modelPlaced = false;

// Touch gesture state
let touches = {};
let lastTouchDist = 0;
let lastTouchAngle = 0;
let lastTouchCenter = { x: 0, y: 0 };
let isTwoFingerGesture = false;
let isDragging = false;
let dragRaycaster = new THREE.Raycaster();
let dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // floor plane
let dragOffset = new THREE.Vector3(); // offset between model and initial touch point

// Callbacks
let onExitAR = null;

/**
 * Start an AR session and load/display the given model URL.
 * @param {string} modelUrl — URL or blob URL of the GLB to display
 * @param {HTMLElement} containerEl — DOM element to use for the AR overlay
 * @param {object} callbacks — { onExit: function }
 */
export async function startARSession(modelUrl, containerEl, callbacks) {
    onExitAR = callbacks?.onExit || null;

    // Check WebXR support
    if (!navigator.xr) {
        alert('WebXR is not supported on this device/browser.');
        return false;
    }

    const supported = await navigator.xr.isSessionSupported('immersive-ar');
    if (!supported) {
        alert('Immersive AR is not supported on this device.');
        return false;
    }

    // --- Set up Three.js renderer for XR ---
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;

    containerEl.appendChild(renderer.domElement);

    // --- Scene ---
    scene = new THREE.Scene();

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(2, 5, 3);
    scene.add(dirLight);
    const hemiLight = new THREE.HemisphereLight(0xb1e1ff, 0xb97a20, 0.5);
    scene.add(hemiLight);

    // Camera
    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);

    // --- Reticle (placement indicator) ---
    reticle = createReticle();
    reticle.visible = false;
    scene.add(reticle);

    // --- Load model ---
    const loader = new GLTFLoader();
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    loader.setDRACOLoader(dracoLoader);

    try {
        const gltf = await loader.loadAsync(modelUrl);
        arModel = gltf.scene;

        // Center the model at its origin and sit on Y=0
        const box = new THREE.Box3().setFromObject(arModel);
        const center = box.getCenter(new THREE.Vector3());
        const minY = box.min.y;
        arModel.position.set(-center.x, -minY, -center.z);

        // Wrap in a container group for placement / gestures
        const container = new THREE.Group();
        container.name = '__arContainer';
        container.add(arModel);
        container.visible = false; // hidden until placed
        scene.add(container);

        // Replace arModel reference with container for transforms
        arModel = container;
    } catch (err) {
        console.error('Failed to load AR model:', err);
        alert('Failed to load model for AR: ' + err.message);
        cleanup();
        return false;
    }

    // --- Request XR session ---
    try {
        const session = await navigator.xr.requestSession('immersive-ar', {
            requiredFeatures: ['hit-test'],
            optionalFeatures: ['dom-overlay', 'light-estimation'],
            domOverlay: { root: containerEl }
        });

        renderer.xr.setReferenceSpaceType('local');
        await renderer.xr.setSession(session);

        session.addEventListener('end', () => {
            cleanup();
            if (onExitAR) onExitAR();
        });

        // Start render loop
        renderer.setAnimationLoop(onXRFrame);

        // Touch events on the session's overlay or canvas
        renderer.domElement.addEventListener('touchstart', onTouchStart, { passive: false });
        renderer.domElement.addEventListener('touchmove', onTouchMove, { passive: false });
        renderer.domElement.addEventListener('touchend', onTouchEnd, { passive: false });

        // Also on the container for dom-overlay
        containerEl.addEventListener('touchstart', onTouchStart, { passive: false });
        containerEl.addEventListener('touchmove', onTouchMove, { passive: false });
        containerEl.addEventListener('touchend', onTouchEnd, { passive: false });

        modelPlaced = false;
        hitTestSourceRequested = false;
        hitTestSource = null;

        return true;
    } catch (err) {
        console.error('Failed to start AR session:', err);
        alert('Failed to start AR session: ' + err.message);
        cleanup();
        return false;
    }
}

/**
 * Check if WebXR AR is supported on this device.
 */
export async function isARSupported() {
    if (!navigator.xr) return false;
    try {
        return await navigator.xr.isSessionSupported('immersive-ar');
    } catch {
        return false;
    }
}

// ---- XR Render Loop ----

function onXRFrame(timestamp, frame) {
    if (!frame) return;

    const session = renderer.xr.getSession();
    const referenceSpace = renderer.xr.getReferenceSpace();

    if (!modelPlaced) {
        // Request hit test source once
        if (!hitTestSourceRequested) {
            session.requestReferenceSpace('viewer').then((viewerRefSpace) => {
                session.requestHitTestSource({ space: viewerRefSpace }).then((source) => {
                    hitTestSource = source;
                });
            });
            hitTestSourceRequested = true;
        }

        // Update reticle position from hit test
        if (hitTestSource) {
            const hitTestResults = frame.getHitTestResults(hitTestSource);
            if (hitTestResults.length > 0) {
                const hit = hitTestResults[0];
                const pose = hit.getPose(referenceSpace);
                if (pose) {
                    reticle.visible = true;
                    reticle.matrix.fromArray(pose.transform.matrix);
                }
            } else {
                reticle.visible = false;
            }
        }
    }

    renderer.render(scene, camera);
}

// ---- Reticle ----

function createReticle() {
    const ring = new THREE.RingGeometry(0.08, 0.10, 32);
    ring.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
        color: 0x00ff88,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.8
    });
    const mesh = new THREE.Mesh(ring, material);
    mesh.matrixAutoUpdate = false;
    return mesh;
}

// ---- Touch Gesture Handling ----

function onTouchStart(event) {
    event.preventDefault();

    if (!modelPlaced) {
        // Place model at reticle position on first tap
        if (reticle.visible && arModel) {
            // Get reticle world position
            const reticlePos = new THREE.Vector3();
            reticle.getWorldPosition(reticlePos);

            arModel.position.copy(reticlePos);
            arModel.visible = true;
            modelPlaced = true;

            reticle.visible = false;

            // Update drag plane height to placed position
            dragPlane.constant = -reticlePos.y;
        }
        return;
    }

    // Track fingers
    for (let i = 0; i < event.changedTouches.length; i++) {
        const t = event.changedTouches[i];
        touches[t.identifier] = { x: t.clientX, y: t.clientY };
    }

    const touchKeys = Object.keys(touches);

    if (touchKeys.length === 2) {
        isTwoFingerGesture = true;
        isDragging = false;
        const t1 = touches[touchKeys[0]];
        const t2 = touches[touchKeys[1]];
        lastTouchDist = Math.hypot(t2.x - t1.x, t2.y - t1.y);
        lastTouchAngle = Math.atan2(t2.y - t1.y, t2.x - t1.x);
        lastTouchCenter = { x: (t1.x + t2.x) / 2, y: (t1.y + t2.y) / 2 };
    } else if (touchKeys.length === 1) {
        isTwoFingerGesture = false;
        isDragging = true;

        // Compute drag offset: difference between model pos and where the ray hits the floor
        const t = touches[touchKeys[0]];
        const ndcX = (t.x / window.innerWidth) * 2 - 1;
        const ndcY = -(t.y / window.innerHeight) * 2 + 1;
        dragRaycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
        const hitPoint = new THREE.Vector3();
        if (dragRaycaster.ray.intersectPlane(dragPlane, hitPoint) && arModel) {
            dragOffset.set(
                arModel.position.x - hitPoint.x,
                0,
                arModel.position.z - hitPoint.z
            );
        } else {
            dragOffset.set(0, 0, 0);
        }
    }
}

function onTouchMove(event) {
    event.preventDefault();
    if (!modelPlaced || !arModel) return;

    // Update touch positions
    for (let i = 0; i < event.changedTouches.length; i++) {
        const t = event.changedTouches[i];
        if (touches[t.identifier]) {
            touches[t.identifier] = { x: t.clientX, y: t.clientY };
        }
    }

    const touchKeys = Object.keys(touches);

    if (isTwoFingerGesture && touchKeys.length === 2) {
        const t1 = touches[touchKeys[0]];
        const t2 = touches[touchKeys[1]];

        // Current distance and angle
        const dist = Math.hypot(t2.x - t1.x, t2.y - t1.y);
        const angle = Math.atan2(t2.y - t1.y, t2.x - t1.x);

        // Pinch to scale
        if (lastTouchDist > 0) {
            const scaleFactor = dist / lastTouchDist;
            arModel.scale.multiplyScalar(scaleFactor);
            // Clamp scale
            const s = arModel.scale.x;
            const clamped = Math.max(0.05, Math.min(s, 20));
            arModel.scale.setScalar(clamped);
        }

        // Rotate around Y axis
        const angleDelta = angle - lastTouchAngle;
        arModel.rotation.y += angleDelta;

        lastTouchDist = dist;
        lastTouchAngle = angle;
        lastTouchCenter = { x: (t1.x + t2.x) / 2, y: (t1.y + t2.y) / 2 };

    } else if (isDragging && touchKeys.length === 1) {
        // Single finger drag — move model on the floor plane
        const t = touches[touchKeys[0]];

        // Cast ray from touch point onto the floor plane
        const ndcX = (t.x / window.innerWidth) * 2 - 1;
        const ndcY = -(t.y / window.innerHeight) * 2 + 1;
        dragRaycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);

        const intersection = new THREE.Vector3();
        if (dragRaycaster.ray.intersectPlane(dragPlane, intersection)) {
            arModel.position.x = intersection.x + dragOffset.x;
            arModel.position.z = intersection.z + dragOffset.z;
        }
    }
}

function onTouchEnd(event) {
    event.preventDefault();

    for (let i = 0; i < event.changedTouches.length; i++) {
        delete touches[event.changedTouches[i].identifier];
    }

    const remaining = Object.keys(touches).length;
    if (remaining < 2) {
        isTwoFingerGesture = false;
    }
    if (remaining === 0) {
        isDragging = false;
    }
}

// ---- Cleanup ----

function cleanup() {
    modelPlaced = false;
    hitTestSource = null;
    hitTestSourceRequested = false;
    arModel = null;
    touches = {};

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
    reticle = null;
}

/**
 * End the current AR session programmatically.
 */
export async function endARSession() {
    const session = renderer?.xr?.getSession();
    if (session) {
        await session.end();
    }
    cleanup();
}
