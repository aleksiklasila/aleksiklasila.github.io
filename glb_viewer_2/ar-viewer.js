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
import { TransformControls } from 'three/addons/controls/TransformControls.js';

let renderer, scene, camera;
let arModel = null;
let editableObjects = [];
let selectedObjects = [];
let selectionGroup = null;
let reticle = null;
let hitTestSource = null;
let hitTestSourceRequested = false;
let modelPlaced = false;

// Gizmo Controls
let transformControl = null;
let currentTool = 'placement'; // Default to placement
let toolbarEl = null;
let toolbarHandleEl = null;

// Helper
let selectionBoxHelper = null;

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
 * @param {object} callbacks — { onExit: function, sceneData: Array }
 */
export async function startARSession(modelUrl, containerEl, callbacks) {
    onExitAR = callbacks?.onExit || null;
    const sceneData = callbacks?.sceneData || null;

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

    // --- UI Setup ---
    setupARToolbar();

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

    // --- Transform Controls ---
    transformControl = new TransformControls(camera, containerEl);
    transformControl.addEventListener('dragging-changed', function (event) {
        // Disable custom touch logic when gizmo is dragging
    });
    scene.add(transformControl);

    // --- Request XR session IMMEDIATELY to avoid dropping transient user activation ---
    let session;
    try {
        session = await navigator.xr.requestSession('immersive-ar', {
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

        // Start render loop (shows camera feed immediately)
        renderer.setAnimationLoop(onXRFrame);

        // Touch bindings for placement and interaction
        renderer.domElement.addEventListener('touchstart', onTouchStart, { passive: false });
        containerEl.addEventListener('touchstart', onTouchStart, { passive: false });
        containerEl.addEventListener('touchmove', onTouchMove, { passive: false });
        containerEl.addEventListener('touchend', onTouchEnd, { passive: false });

        modelPlaced = false;
        hitTestSourceRequested = false;
        hitTestSource = null;
    } catch (err) {
        console.error('Failed to start AR session:', err);
        alert('Failed to start AR session: ' + err.message);
        cleanup();
        return false;
    }

    // --- Load model asynchronously WHILE in AR session ---
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

        // Selection Group
        selectionGroup = new THREE.Group();
        container.add(selectionGroup);

        // Highlight Helper
        selectionBoxHelper = new THREE.BoxHelper(selectionGroup, 0xffff00);
        selectionBoxHelper.visible = false;
        container.add(selectionBoxHelper);

        // Populate editable objects (top level children of GLB)
        editableObjects = [];
        arModel.children.forEach(child => {
            child.userData._editorIndex = editableObjects.length;
            child.userData._editorOriginalName = child.name || `Object_${editableObjects.length}`;
            child.userData._isCloned = false;
            editableObjects.push(child);
            // AUTO-PIVOT: Re-pivot to bottom center
            rePivotToBBoxCenter(child);
        });

        // Apply editor modifications if provided
        if (sceneData) {
            applySceneState(sceneData);
        }

        container.visible = false; // hidden until placed
        scene.add(container);

        // Replace arModel reference with container for transforms
        arModel = container;
    } catch (err) {
        console.error('Failed to load AR model:', err);
        alert('Failed to load model for AR: ' + err.message);
        // Do not return false, session is already running. Just warn user.
    }

    return true;
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

    // Removed native plane detection

    // Fix for TransformControls raycasting:
    // Sync the main camera's matrices with the XR camera used by the renderer.
    // TransformControls uses 'camera' for raycasting, which needs to match the XR view.
    if (renderer.xr.isPresenting) {
        const xrCamera = renderer.xr.getCamera(camera);
        if (xrCamera) {
            const cam = (xrCamera.cameras && xrCamera.cameras.length > 0) ? xrCamera.cameras[0] : xrCamera;
            camera.projectionMatrix.copy(cam.projectionMatrix);
            camera.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
            // Also sync transform just in case
            camera.matrixWorld.copy(cam.matrixWorld);
            camera.position.setFromMatrixPosition(cam.matrixWorld);
            camera.quaternion.setFromRotationMatrix(cam.matrixWorld);
            camera.scale.setFromMatrixScale(cam.matrixWorld);
            camera.updateMatrixWorld(true);
        }
    }

    if (!modelPlaced || currentTool === 'placement' || currentTool === 'scanner') {
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
                    reticle.visible = (currentTool === 'placement' && !modelPlaced);
                    reticle.matrix.fromArray(pose.transform.matrix);

                    // Auto-placement logic for 'placement' tool
                    if (currentTool === 'placement' && arModel) {
                        const reticlePos = new THREE.Vector3();
                        const reticleQuat = new THREE.Quaternion();
                        const reticleScale = new THREE.Vector3();
                        reticle.matrix.decompose(reticlePos, reticleQuat, reticleScale);

                        arModel.position.copy(reticlePos);
                        // We do NOT copy rotation, as user might want to rotate manualy.
                        // But we should ensure model is visible.
                        arModel.visible = true;

                        // If this is the very first placement, maybe align to surface? 
                        // For now, keep Y up or whatever GLB default is.

                        // Update floor plane for gestures (if they switch to generic later)
                        dragPlane.constant = -reticlePos.y;
                    }
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
    // User requested to remove the green circle.
    // We keep the reticle object for logic (hit-test tracking), but make it invisible/empty.
    const reticlePlaceholder = new THREE.Object3D();
    reticlePlaceholder.matrixAutoUpdate = false;
    reticlePlaceholder.visible = false;
    return reticlePlaceholder;
}

// ---- Touch Gesture Handling ----

function onTouchStart(event) {
    // Check if touching a UI element (toolbar buttons).
    if (event.target.closest('button') || event.target.closest('#ar-toolbar-container')) {
        return; // Allow UI interaction
    }

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

            // Set initial tool
            updateToolState();
        }

        // If currentTool is 'placement', we consider it placed once hits are found in onXRFrame
        if (currentTool === 'placement') {
            modelPlaced = true;
        }

        return;
    }

    if (currentTool === 'cursor') {
        const t = event.changedTouches[0];
        const ndcX = (t.clientX / window.innerWidth) * 2 - 1;
        const ndcY = -(t.clientY / window.innerHeight) * 2 + 1;

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);

        // Intersect recursive
        const intersects = raycaster.intersectObjects(arModel.children, true);

        if (intersects.length > 0) {
            const hit = intersects[0];
            const hitPoint = hit.point;

            // Re-pivot logic
            const children = [...arModel.children];
            children.forEach(child => {
                scene.attach(child);
            });

            arModel.position.copy(hitPoint);
            arModel.updateMatrixWorld();

            children.forEach(child => {
                arModel.attach(child);
            });

            dragPlane.constant = -hitPoint.y;
        }
        return;
    }

    // --- SELECTION LOGIC ADDED HERE ---
    if (currentTool === 'select') {
        const t = event.changedTouches[0];
        const ndcX = (t.clientX / window.innerWidth) * 2 - 1;
        const ndcY = -(t.clientY / window.innerHeight) * 2 + 1;
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);

        // Raycast against all Meshes in editableObjects
        const interactable = [];
        editableObjects.forEach(obj => {
            obj.traverse(child => {
                if (child.isMesh) interactable.push(child);
            });
        });

        const intersects = raycaster.intersectObjects(interactable, false);

        if (intersects.length > 0) {
            // Find root editable
            let hit = intersects[0].object;
            // Walk up until hit is in editableObjects
            while (hit) {
                if (editableObjects.includes(hit)) break;
                if (hit === scene || hit === arModel) { hit = null; break; }
                hit = hit.parent;
            }

            if (hit) {
                const isSelected = selectedObjects.includes(hit);
                if (isSelected) {
                    const newSelection = selectedObjects.filter(o => o !== hit);
                    updateSelection(newSelection);
                } else {
                    updateSelection([...selectedObjects, hit]);
                }
                return;
            }
        } else {
            // Tap background -> Select All
            updateSelection(editableObjects);
        }
        return;
    }

    if (currentTool !== 'generic' && currentTool !== 'placement') {
        // Gizmo mode - Do not change selection.
        return;
    }

    // Generic Mode: Handle Gestures (no selection change)
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
        if (dragRaycaster.ray.intersectPlane(dragPlane, hitPoint) && selectionGroup) {
            dragOffset.set(
                selectionGroup.position.x - hitPoint.x,
                0,
                selectionGroup.position.z - hitPoint.z
            );
        } else {
            dragOffset.set(0, 0, 0);
        }
    }
}

function onTouchMove(event) {
    // Check if touching a UI element
    if (event.target.closest('button') || event.target.closest('#ar-toolbar-container')) {
        return;
    }

    event.preventDefault();
    if (!modelPlaced || !arModel) return;
    if (transformControl && transformControl.dragging) return;
    if (currentTool !== 'generic' && currentTool !== 'placement') return;

    // Update touch positions
    for (let i = 0; i < event.changedTouches.length; i++) {
        const t = event.changedTouches[i];
        if (touches[t.identifier]) {
            touches[t.identifier] = { x: t.clientX, y: t.clientY };
        }
    }

    const touchKeys = Object.keys(touches);

    if (selectedObjects.length === 0) return; // Should have selection if we are here (drag/gesture)

    if (isTwoFingerGesture && touchKeys.length === 2) {
        // Allow scaling/rotation in both generic and placement modes
        const t1 = touches[touchKeys[0]];
        const t2 = touches[touchKeys[1]];

        // Current distance and angle
        const dist = Math.hypot(t2.x - t1.x, t2.y - t1.y);
        const angle = Math.atan2(t2.y - t1.y, t2.x - t1.x);

        // Pinch to scale
        if (lastTouchDist > 0) {
            const scaleFactor = dist / lastTouchDist;
            selectionGroup.scale.multiplyScalar(scaleFactor);
            // Clamp scale
            const s = selectionGroup.scale.x;
            const clamped = Math.max(0.01, Math.min(s, 20));
            selectionGroup.scale.setScalar(clamped);
        }

        // Rotate around Y axis
        const angleDelta = angle - lastTouchAngle;
        selectionGroup.rotation.y += angleDelta;

        lastTouchDist = dist;
        lastTouchAngle = angle;
        lastTouchCenter = { x: (t1.x + t2.x) / 2, y: (t1.y + t2.y) / 2 };

        selectionGroup.updateMatrixWorld();

    } else if (isDragging && touchKeys.length === 1) {
        // Single finger drag — only in generic mode
        if (currentTool === 'placement') return;

        // Single finger drag — move model on the floor plane
        const t = touches[touchKeys[0]];

        // Cast ray from touch point onto the floor plane
        const ndcX = (t.x / window.innerWidth) * 2 - 1;
        const ndcY = -(t.y / window.innerHeight) * 2 + 1;
        dragRaycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);

        const intersection = new THREE.Vector3();
        if (dragRaycaster.ray.intersectPlane(dragPlane, intersection)) {
            // Apply to group
            // We need to maintain offset
            const newPos = new THREE.Vector3(
                intersection.x + dragOffset.x,
                selectionGroup.position.y, // Maintain Y
                intersection.z + dragOffset.z
            );
            selectionGroup.position.x = newPos.x;
            selectionGroup.position.z = newPos.z;
            selectionGroup.updateMatrixWorld();
        }
    }
}

function onTouchEnd(event) {
    // Check if touching a UI element
    if (event.target.closest('button') || event.target.closest('#ar-toolbar-container')) {
        return;
    }

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

    if (transformControl) {
        transformControl.dispose();
        transformControl = null;
    }

    // Teardown Toolbar
    const tb = document.getElementById('ar-toolbar-container');
    if (tb && tb.parentElement) {
        // Reset state for next time or remove listeners if we added them dynamically
        // But the HTML is static in index.html, so we just hide it or leave it.
        // Ideally we should reset active state.
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

function updateSelection(objects) {
    if (!selectionGroup || !arModel) return;

    // The 'arModel' variable is actually the Container Group now (see startARSession).
    // The actual GLB model is a child of it.
    // Let's find the original model root to re-attach objects to.
    // We added: container.add(arModel_original); container.add(selectionGroup);
    // So arModel (container) . children[0] is likely the original GLB root? 
    // Wait, earlier code: `arModel = gltf.scene; ... container.add(arModel); ... arModel = container;`
    // So `arModel` (global) is the container.
    // The GLB root is `arModel.children.find(c => c !== selectionGroup)`.

    // 1. Detach current
    if (selectedObjects.length > 0) {
        const glbRoot = arModel.children.find(c => c !== selectionGroup); // The original gltf scene
        const currentChildren = [...selectionGroup.children];
        currentChildren.forEach(child => {
            if (glbRoot) glbRoot.attach(child);
        });
        if (transformControl) transformControl.detach();
    }

    // 2. Update state
    selectedObjects = objects || [];

    // 3. If no new selection
    if (selectedObjects.length === 0) {
        if (selectionBoxHelper) selectionBoxHelper.visible = false;
        return;
    }

    // 4. Calculate Pivot (Avg X/Z, Min Y)
    let avgX = 0, avgZ = 0, minY = Infinity;

    selectedObjects.forEach(obj => {
        const worldPos = new THREE.Vector3();
        obj.getWorldPosition(worldPos);
        avgX += worldPos.x;
        avgZ += worldPos.z;
        if (worldPos.y < minY) minY = worldPos.y;
    });

    avgX /= selectedObjects.length;
    avgZ /= selectedObjects.length;
    if (minY === Infinity) minY = 0;

    // 5. Position Group
    selectionGroup.position.set(avgX, minY, avgZ);
    selectionGroup.rotation.set(0, 0, 0);
    selectionGroup.scale.set(1, 1, 1);
    selectionGroup.updateMatrixWorld();

    // 6. Attach
    selectedObjects.forEach(obj => {
        selectionGroup.attach(obj);
    });

    // 7. Helpers & Gizmo
    if (selectionBoxHelper) {
        selectionBoxHelper.update();
        const visibleModes = ['select', 'translate', 'rotate', 'scale', 'generic'];
        selectionBoxHelper.visible = visibleModes.includes(currentTool);
    }

    if (currentTool === 'translate' || currentTool === 'rotate' || currentTool === 'scale') {
        transformControl.attach(selectionGroup);
    } else {
        transformControl.detach();
    }
}

// ---- Toolbar Logic ----

function setupARToolbar() {
    toolbarEl = document.getElementById('ar-toolbar');
    toolbarHandleEl = document.getElementById('ar-toolbar-drag-handle');
    const container = document.getElementById('ar-overlay');
    const objectPanel = document.getElementById('ar-object-panel');

    if (!toolbarEl || !objectPanel) return; // Should exist in HTML

    // Reset UI state
    currentTool = 'placement';
    updateToolbarUI();

    // Bind buttons
    const buttons = toolbarEl.querySelectorAll('.tool-btn');
    buttons.forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            if (btn.id === 'ar-exit-btn') {
                endARSession();
                return;
            }
            const mode = btn.dataset.mode;
            if (mode) {
                currentTool = mode;
                updateToolbarUI();
                updateToolState();
            }
        };
        // Fix for touch devices mostly needing touchstart if click is simulated poorly? 
        // Usually click works fine on buttons even with touchstart prevented on parent if we didn't stop propagation excessively.
        // We added logic in onTouchStart to return if target is button.
    });

    // Drag handle logic
    if (toolbarHandleEl && objectPanel) {
        let isDraggingRaw = false;
        let startY = 0;
        let startHeight = 0;
        const MIN_HEIGHT = 40;
        const DEFAULT_HEIGHT = 180;

        const onPointerDown = (e) => {
            isDraggingRaw = true;
            startY = e.touches ? e.touches[0].clientY : e.clientY;
            startHeight = objectPanel.offsetHeight;
            objectPanel.style.transition = 'none';
            toolbarHandleEl.classList.add('dragging');
            e.stopPropagation();
            e.preventDefault();
        };

        toolbarHandleEl.addEventListener('touchstart', onPointerDown, { passive: false });
        toolbarHandleEl.addEventListener('mousedown', onPointerDown);

        const onPointerMove = (e) => {
            if (!isDraggingRaw) return;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const delta = startY - clientY; // Dragging up (smaller Y) increases height

            let newHeight = startHeight + delta;
            const maxHeight = window.innerHeight * 0.8; // Max 80% of screen

            newHeight = Math.max(0, Math.min(newHeight, maxHeight));

            objectPanel.style.height = newHeight + 'px';

            if (newHeight < MIN_HEIGHT) {
                objectPanel.classList.add('collapsed');
            } else {
                objectPanel.classList.remove('collapsed');
            }
        };

        document.addEventListener('touchmove', onPointerMove, { passive: false });
        document.addEventListener('mousemove', onPointerMove);

        const onPointerUp = () => {
            if (isDraggingRaw) {
                isDraggingRaw = false;
                objectPanel.style.transition = '';
                toolbarHandleEl.classList.remove('dragging');
                if (objectPanel.offsetHeight < MIN_HEIGHT) {
                    objectPanel.style.height = '0px';
                    objectPanel.classList.add('collapsed');
                }
            }
        };

        document.addEventListener('touchend', onPointerUp);
        document.addEventListener('mouseup', onPointerUp);

        // Double click to toggle full/min
        toolbarHandleEl.addEventListener('dblclick', () => {
            if (objectPanel.classList.contains('collapsed') || objectPanel.offsetHeight < MIN_HEIGHT) {
                objectPanel.style.height = DEFAULT_HEIGHT + 'px';
                objectPanel.classList.remove('collapsed');
            } else {
                objectPanel.style.height = '0px';
                objectPanel.classList.add('collapsed');
            }
        });
    }
}

function updateToolbarUI() {
    if (!toolbarEl) return;
    const buttons = toolbarEl.querySelectorAll('.tool-btn');
    buttons.forEach(btn => {
        if (btn.dataset.mode === currentTool) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // Also update generic hint if needed
}

function updateToolState() {
    if (!transformControl || !selectionGroup) return;

    if (currentTool === 'generic' || currentTool === 'placement' || currentTool === 'select') {
        transformControl.detach();
    } else if (currentTool === 'translate' || currentTool === 'rotate' || currentTool === 'scale') {
        transformControl.setMode(currentTool);
        if (selectedObjects.length > 0) {
            transformControl.attach(selectionGroup);
        }
    }

    // Helper Visibility
    if (selectionBoxHelper) {
        const visibleModes = ['select', 'translate', 'rotate', 'scale', 'generic'];
        selectionBoxHelper.visible = visibleModes.includes(currentTool) && selectedObjects.length > 0;
        if (selectionBoxHelper.visible) selectionBoxHelper.update();
    }

    // Scanner Visibility
    if (arScanner) {
        arScanner.setVisible(currentTool === 'scanner');
    }
}

// ---- Pivot Logic ----

function setPivot(obj, targetWorldPos) {
    if (!obj) return;

    obj.updateMatrixWorld();
    const localOffset = obj.worldToLocal(targetWorldPos.clone());

    if (localOffset.lengthSq() < 0.00001) return;

    if (obj.geometry) {
        obj.geometry.translate(-localOffset.x, -localOffset.y, -localOffset.z);
    }

    obj.children.forEach(child => {
        child.position.sub(localOffset);
    });

    if (obj.parent) {
        obj.parent.updateMatrixWorld();
        const newLocalPos = obj.parent.worldToLocal(targetWorldPos.clone());
        obj.position.copy(newLocalPos);
    } else {
        obj.position.copy(targetWorldPos);
    }

    obj.updateMatrixWorld();
}

function rePivotToBBoxCenter(obj) {
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const bottomCenter = new THREE.Vector3(center.x, box.min.y, center.z);
    setPivot(obj, bottomCenter);
}


function applySceneState(sceneData) {
    if (!sceneData || !Array.isArray(sceneData)) return;

    // Use a flat map to store what original indices refer to which objects
    const originalObjectsMap = new Map();
    arModel.children.forEach(child => originalObjectsMap.set(child.userData._editorIndex, child));

    sceneData.forEach(entry => {
        if (entry.cloned && entry.sourceIndex !== undefined) {
            // Find source object
            const source = originalObjectsMap.get(entry.sourceIndex);
            if (!source) return;
            const clone = source.clone(true);
            clone.userData._editorIndex = editableObjects.length;
            clone.userData._editorOriginalName = entry.name || source.userData._editorOriginalName + '_clone';
            clone.userData._isCloned = true;
            clone.userData._sourceIndex = entry.sourceIndex;
            clone.name = clone.userData._editorOriginalName;

            if (entry.position) clone.position.fromArray(entry.position);
            if (entry.rotation) clone.rotation.set(entry.rotation[0], entry.rotation[1], entry.rotation[2]);
            if (entry.scale) clone.scale.fromArray(entry.scale);

            arModel.add(clone);
            editableObjects.push(clone);
        } else {
            // Find original object by index
            const obj = originalObjectsMap.get(entry.index);
            if (!obj) return;
            if (entry.position) obj.position.fromArray(entry.position);
            if (entry.rotation) obj.rotation.set(entry.rotation[0], entry.rotation[1], entry.rotation[2]);
            if (entry.scale) obj.scale.fromArray(entry.scale);
        }
    });
}
