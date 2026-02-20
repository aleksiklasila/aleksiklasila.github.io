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
let onARSceneChanged = null;

// Debug overlay
let debugEl = null;

// Undo stack — each entry is a snapshot of all editable objects' transforms
let arUndoStack = [];
const AR_MAX_UNDO = 50;

// Debounced save timer
let arSaveTimeout = null;

/**
 * Start an AR session and load/display the given model URL.
 * @param {string} modelUrl — URL or blob URL of the GLB to display
 * @param {HTMLElement} containerEl — DOM element to use for the AR overlay
 * @param {object} callbacks — { onExit: function, sceneData: Array }
 */
export async function startARSession(modelUrl, containerEl, callbacks) {
    onExitAR = callbacks?.onExit || null;
    onARSceneChanged = callbacks?.onSceneChanged || null;
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
        // NOTE: Only bind to containerEl (the DOM overlay root), NOT renderer.domElement.
        // Binding both causes onTouchStart to fire twice and interferes with TransformControls.
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

        // Selection Group — inside container so it moves with placement
        selectionGroup = new THREE.Group();
        selectionGroup.name = '__selectionGroup';
        container.add(selectionGroup);

        // Highlight Helper
        selectionBoxHelper = new THREE.BoxHelper(selectionGroup, 0xffff00);
        selectionBoxHelper.visible = false;
        scene.add(selectionBoxHelper);

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
                        arModel.visible = true;

                        // Update floor plane for gestures (if they switch to generic later)
                        dragPlane.constant = -reticlePos.y;
                    }
                }
            } else {
                reticle.visible = false;
            }
        }
    }

    // Update helpers each frame so they follow moving objects
    if (selectionBoxHelper && selectionBoxHelper.visible) {
        selectionBoxHelper.update();
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
    // Check if touching a UI element (toolbar buttons, nav bar).
    if (event.target.closest('button') || event.target.closest('#ar-toolbar-container') || event.target.closest('#top-nav-bar')) {
        return; // Allow UI interaction
    }

    if (currentTool !== 'translate' && currentTool !== 'rotate' && currentTool !== 'scale') {
        event.preventDefault();
    }

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

        // Force update all world matrices before raycasting — in XR mode,
        // mesh descendants' matrixWorld can be stale after re-parenting
        scene.updateMatrixWorld(true);

        // Raycast against editableObjects (they may be in selectionGroup, not arModel directly)
        const intersects = raycaster.intersectObjects(editableObjects, true);

        if (intersects.length > 0) {
            const hit = intersects[0];
            const hitPoint = hit.point;

            // Re-pivot logic — detach children, move container, re-attach
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

        // Force update all world matrices before raycasting
        scene.updateMatrixWorld(true);

        const intersects = raycaster.intersectObjects(interactable, false);
        arDebugStatus(`SELECT tap: ${interactable.length} meshes, ${intersects.length} hits, sel=${selectedObjects.length}`);

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

        // Determine transform target: selectionGroup for subset, arModel for all
        const transformTarget = (selectedObjects.length > 0 && selectedObjects.length < editableObjects.length && selectionGroup)
            ? selectionGroup : arModel;

        // Compute drag offset: difference between target pos and where the ray hits the floor
        const t = touches[touchKeys[0]];
        const ndcX = (t.x / window.innerWidth) * 2 - 1;
        const ndcY = -(t.y / window.innerHeight) * 2 + 1;
        dragRaycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
        const hitPoint = new THREE.Vector3();
        if (dragRaycaster.ray.intersectPlane(dragPlane, hitPoint) && transformTarget) {
            // Get world position of transform target
            const targetWorldPos = new THREE.Vector3();
            transformTarget.getWorldPosition(targetWorldPos);
            dragOffset.set(
                targetWorldPos.x - hitPoint.x,
                0,
                targetWorldPos.z - hitPoint.z
            );
        } else {
            dragOffset.set(0, 0, 0);
        }
    }
}

function onTouchMove(event) {
    // Check if touching a UI element
    if (event.target.closest('button') || event.target.closest('#ar-toolbar-container') || event.target.closest('#top-nav-bar')) {
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

    if (!arModel) return;

    // Determine transform target: selectionGroup for subset, arModel for all
    const transformTarget = (selectedObjects.length > 0 && selectedObjects.length < editableObjects.length && selectionGroup)
        ? selectionGroup : arModel;

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
            transformTarget.scale.multiplyScalar(scaleFactor);
            // Clamp scale
            const s = transformTarget.scale.x;
            const clamped = Math.max(0.01, Math.min(s, 20));
            transformTarget.scale.setScalar(clamped);
        }

        // Rotate around Y axis
        const angleDelta = angle - lastTouchAngle;
        transformTarget.rotation.y += angleDelta;

        lastTouchDist = dist;
        lastTouchAngle = angle;
        lastTouchCenter = { x: (t1.x + t2.x) / 2, y: (t1.y + t2.y) / 2 };

        transformTarget.updateMatrixWorld();
        debouncedARSave();

    } else if (isDragging && touchKeys.length === 1) {
        // Single finger drag — only in generic mode
        if (currentTool === 'placement') return;

        // Single finger drag — move on the floor plane
        const t = touches[touchKeys[0]];

        // Cast ray from touch point onto the floor plane
        const ndcX = (t.x / window.innerWidth) * 2 - 1;
        const ndcY = -(t.y / window.innerHeight) * 2 + 1;
        dragRaycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);

        const intersection = new THREE.Vector3();
        if (dragRaycaster.ray.intersectPlane(dragPlane, intersection)) {
            // Move transform target (world space for arModel, local for selectionGroup)
            if (transformTarget === arModel) {
                transformTarget.position.x = intersection.x + dragOffset.x;
                transformTarget.position.z = intersection.z + dragOffset.z;
            } else {
                // selectionGroup is inside arModel, convert to local
                const worldTarget = new THREE.Vector3(
                    intersection.x + dragOffset.x,
                    transformTarget.getWorldPosition(new THREE.Vector3()).y,
                    intersection.z + dragOffset.z
                );
                arModel.updateMatrixWorld();
                const localPos = arModel.worldToLocal(worldTarget);
                transformTarget.position.x = localPos.x;
                transformTarget.position.z = localPos.z;
            }
            transformTarget.updateMatrixWorld();
            debouncedARSave();
        }
    }
}

function onTouchEnd(event) {
    // Check if touching a UI element
    if (event.target.closest('button') || event.target.closest('#ar-toolbar-container') || event.target.closest('#top-nav-bar')) {
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

    // arModel is the container (__arContainer). Its children are:
    //   [0] = gltf.scene (the GLB root with editable objects)
    //   [1] = selectionGroup
    // Find the GLB root (first child that isn't selectionGroup)
    const glbRoot = arModel.children.find(c => c !== selectionGroup);

    // 1. Detach current selection back to glbRoot
    if (selectedObjects.length > 0) {
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

    // 4. Calculate Pivot in world space (Avg X/Z, Min Y)
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

    // 5. Position Group — convert world pivot to arModel-local coordinates
    //    since selectionGroup is now inside arModel (the container)
    const worldPivot = new THREE.Vector3(avgX, minY, avgZ);
    arModel.updateMatrixWorld();
    const localPivot = arModel.worldToLocal(worldPivot);

    selectionGroup.position.copy(localPivot);
    selectionGroup.rotation.set(0, 0, 0);
    selectionGroup.scale.set(1, 1, 1);
    selectionGroup.updateMatrixWorld();

    // 6. Attach (preserves world transforms)
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
        if (selectedObjects.length < editableObjects.length && selectionGroup) {
            // Subset — gizmo on selectionGroup for individual transforms
            transformControl.attach(selectionGroup);
        } else if (arModel) {
            // All selected — gizmo on arModel for whole-model transforms
            transformControl.attach(arModel);
        }
    } else {
        transformControl.detach();
    }

    updateARObjectList();
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

    // Create debug overlay (hidden by default, can be re-enabled for debugging)
    if (!debugEl) {
        debugEl = document.createElement('div');
        debugEl.id = 'ar-debug-status';
        debugEl.style.cssText = 'position:fixed;top:40px;left:10px;right:10px;color:#0f0;background:rgba(0,0,0,0.7);padding:6px 10px;font:12px monospace;z-index:99999;pointer-events:none;border-radius:4px;display:none;';
        const overlay = document.getElementById('ar-overlay');
        if (overlay) overlay.appendChild(debugEl);
    }

    // Bind buttons
    const buttons = toolbarEl.querySelectorAll('.tool-btn');
    buttons.forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            if (btn.id === 'ar-undo-btn') {
                undoAR();
                return;
            }
            const mode = btn.dataset.mode;
            if (mode) {
                currentTool = mode;
                updateToolbarUI();
                updateToolState();
            }
        };
    });

    // Push undo state when gizmo drag starts
    if (transformControl) {
        transformControl.addEventListener('mouseDown', () => {
            pushARUndoState();
        });
    }

    // Bind clone/delete buttons
    const cloneBtn = document.getElementById('ar-btn-clone');
    const deleteBtn = document.getElementById('ar-btn-delete');
    if (cloneBtn) cloneBtn.onclick = () => cloneSelectedAR();
    if (deleteBtn) deleteBtn.onclick = () => deleteSelectedAR();

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
    if (!transformControl) return;

    // When switching away from placement, ensure model is considered "placed"
    // The model is already visible & positioned by onXRFrame auto-placement.
    // Without this, the !modelPlaced guard blocks all custom touch handlers.
    if (currentTool !== 'placement' && !modelPlaced && arModel && arModel.visible) {
        modelPlaced = true;
        // Set drag plane from arModel's current position
        dragPlane.constant = -arModel.position.y;
    }

    // Auto-select all objects for bounding box if none selected
    if (selectedObjects.length === 0 && editableObjects.length > 0 && selectionGroup) {
        updateSelection(editableObjects);
    }

    if (currentTool === 'placement' || currentTool === 'generic' || currentTool === 'select' || currentTool === 'cursor') {
        transformControl.detach();
    } else if (currentTool === 'translate' || currentTool === 'rotate' || currentTool === 'scale') {
        transformControl.setMode(currentTool);
        if (selectedObjects.length > 0 && selectedObjects.length < editableObjects.length && selectionGroup) {
            // Subset selected — attach to selectionGroup for individual object transforms
            transformControl.attach(selectionGroup);
        } else if (arModel) {
            // All selected (or none) — attach to arModel for whole-model transforms
            transformControl.attach(arModel);
        }
    }

    // Helper Visibility
    if (selectionBoxHelper) {
        const visibleModes = ['select', 'translate', 'rotate', 'scale', 'generic'];
        selectionBoxHelper.visible = visibleModes.includes(currentTool) && selectedObjects.length > 0;
        if (selectionBoxHelper.visible) selectionBoxHelper.update();
    }

    // Scanner Visibility
    if (typeof arScanner !== 'undefined' && arScanner) {
        arScanner.setVisible(currentTool === 'scanner');
    }

    arDebugStatus(`Tool: ${currentTool} | sel: ${selectedObjects.length}/${editableObjects.length} | placed: ${modelPlaced} | box: ${selectionBoxHelper?.visible}`);
}

function arDebugStatus(msg) {
    if (debugEl) debugEl.textContent = msg;
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
    if (box.isEmpty()) return; // Prevent NaN errors on empty nodes
    const center = box.getCenter(new THREE.Vector3());
    // User wants pivot at the bottom of the object centered horizontally
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

// ---- Object List for AR ----

function updateARObjectList() {
    const list = document.getElementById('ar-object-list');
    const infoEl = document.getElementById('ar-transform-info');
    if (!list) return;
    list.innerHTML = '';

    editableObjects.forEach(obj => {
        const div = document.createElement('div');
        const isSelected = selectedObjects.includes(obj);
        div.className = 'object-item' + (isSelected ? ' selected' : '');
        div.innerHTML = `
            <span class="obj-icon">◆</span>
            <span class="obj-name">${obj.userData._editorOriginalName || obj.name || 'Object'}</span>
            ${obj.userData._isCloned ? '<span class="obj-cloned">clone</span>' : ''}
        `;
        div.addEventListener('click', (e) => {
            e.stopPropagation();
            // Toggle selection
            const isSelected = selectedObjects.includes(obj);
            if (isSelected) {
                updateSelection(selectedObjects.filter(o => o !== obj));
            } else {
                updateSelection([...selectedObjects, obj]);
            }
        });
        list.appendChild(div);
    });

    // Update select count info
    if (infoEl) {
        if (selectedObjects.length > 0) {
            infoEl.textContent = `Selected ${selectedObjects.length} of ${editableObjects.length} object(s)`;
        } else {
            infoEl.textContent = '';
        }
    }
}

// ---- Clone/Delete for AR ----

function cloneSelectedAR() {
    if (selectedObjects.length === 0 || !arModel) return;
    pushARUndoState();

    const glbRoot = arModel.children.find(c => c !== selectionGroup);
    if (!glbRoot) return;

    const currentSelection = [...selectedObjects];
    updateSelection([]);

    const newClones = [];
    currentSelection.forEach(obj => {
        const clone = obj.clone(true);
        clone.userData._editorIndex = editableObjects.length;
        clone.userData._editorOriginalName = obj.userData._editorOriginalName + '_clone';
        clone.userData._isCloned = true;
        clone.userData._sourceIndex = obj.userData._isCloned
            ? obj.userData._sourceIndex
            : obj.userData._editorIndex;
        clone.name = clone.userData._editorOriginalName;
        clone.position.x += 0.1;

        glbRoot.add(clone);
        editableObjects.push(clone);
        newClones.push(clone);
    });

    updateSelection(newClones);
    debouncedARSave();
    arDebugStatus(`Cloned ${newClones.length} objects`);
}

function deleteSelectedAR() {
    if (selectedObjects.length === 0) return;
    pushARUndoState();

    const toDelete = selectedObjects.filter(obj => obj.userData._isCloned);
    if (toDelete.length === 0) {
        arDebugStatus('Cannot delete original objects');
        return;
    }

    transformControl.detach();

    toDelete.forEach(obj => {
        if (obj.parent) obj.parent.remove(obj);
        const idx = editableObjects.indexOf(obj);
        if (idx > -1) editableObjects.splice(idx, 1);
    });

    selectedObjects = selectedObjects.filter(obj => !toDelete.includes(obj));
    const remaining = [...selectedObjects];
    selectionGroup.clear();
    transformControl.detach();
    updateSelection(remaining);
    debouncedARSave();
    arDebugStatus(`Deleted ${toDelete.length} objects`);
}

// ---- Undo Logic for AR ----

function pushARUndoState() {
    const currentSel = [...selectedObjects];
    updateSelection([]);

    const snapshot = editableObjects.map(obj => ({
        ref: obj,
        position: obj.position.toArray(),
        rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
        scale: obj.scale.toArray(),
        isCloned: !!obj.userData._isCloned,
        parent: obj.parent,
    }));
    arUndoStack.push(snapshot);
    if (arUndoStack.length > AR_MAX_UNDO) arUndoStack.shift();

    updateSelection(currentSel);
}

function undoAR() {
    if (arUndoStack.length === 0) {
        arDebugStatus('Nothing to undo');
        return;
    }

    const snapshot = arUndoStack.pop();
    updateSelection([]);
    transformControl.detach();

    const snapshotRefs = new Set(snapshot.map(s => s.ref));
    const toRemove = editableObjects.filter(obj => !snapshotRefs.has(obj));
    toRemove.forEach(obj => {
        if (obj.parent) obj.parent.remove(obj);
    });

    editableObjects = [];
    const glbRoot = arModel ? arModel.children.find(c => c !== selectionGroup) : null;
    snapshot.forEach(entry => {
        const obj = entry.ref;
        obj.position.fromArray(entry.position);
        obj.rotation.set(entry.rotation[0], entry.rotation[1], entry.rotation[2]);
        obj.scale.fromArray(entry.scale);
        if (!obj.parent && glbRoot) {
            glbRoot.add(obj);
        }
        editableObjects.push(obj);
    });

    updateARObjectList();
    debouncedARSave();
    arDebugStatus('Undo applied');
}

// ---- Scene State for URL Sync ----

function debouncedARSave() {
    clearTimeout(arSaveTimeout);
    arSaveTimeout = setTimeout(() => saveARScene(), 300);
}

function saveARScene() {
    if (onARSceneChanged) {
        const state = getARSceneState();
        onARSceneChanged(state);
    }
}

export function getARSceneState() {
    // Must detach selection to get accurate world-space transforms
    const currentSel = [...selectedObjects];
    updateSelection([]);

    const state = [];
    editableObjects.forEach(obj => {
        const entry = {
            name: obj.userData._editorOriginalName,
            index: obj.userData._editorIndex,
            position: obj.position.toArray().map(v => Math.round(v * 10000) / 10000),
            rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z].map(v => Math.round(v * 10000) / 10000),
            scale: obj.scale.toArray().map(v => Math.round(v * 10000) / 10000),
            cloned: !!obj.userData._isCloned,
        };
        if (obj.userData._isCloned) {
            entry.sourceIndex = obj.userData._sourceIndex;
        }
        state.push(entry);
    });

    // Re-select
    updateSelection(currentSel);
    return state;
}
