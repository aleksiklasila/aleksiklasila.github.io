import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// ============================================================
// GLB Scene Editor
// ============================================================

let renderer, scene, camera, orbitControls, transformControls;
let canvas;
let loadedModel = null;
let editableObjects = []; // top-level objects from GLB
let selectedObjects = [];
let selectionGroup = null;
let selectionBoxHelper = null;
let selectedObject = null; // Deprecated, keeping for safety until fully refactored, but logic will use array
let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2();

// Tools state
let currentMode = 'none'; // none, translate, rotate, scale, cursor, generic
let isInteracting = false;

// Touch state for 'generic' tool
let touches = {};
let lastTouchDist = 0;
let lastTouchAngle = 0;
let isDragging = false;
let dragRaycaster = new THREE.Raycaster();
let dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let dragOffset = new THREE.Vector3();
let dragObject = null;

// Callback to update URL params
let onSceneChanged = null;
let onRequestViewScene = null;
let statusEl = null;
let editorActive = false;

// Click-vs-drag tracking (to avoid deselecting on orbit rotations)
let pointerDownPos = null;
const CLICK_THRESHOLD = 5; // pixels

// Undo stack — each entry is a snapshot of all editable objects' transforms
let undoStack = [];
const MAX_UNDO = 50;

// ---- Public API ----

export function pauseEditor() {
    editorActive = false;
}

export function resumeEditor() {
    if (!editorActive && renderer) {
        editorActive = true;
        animate();
    }
}

export function initEditor(canvasEl, callbacks) {
    canvas = canvasEl;
    onSceneChanged = callbacks.onSceneChanged;
    onRequestViewScene = callbacks.onRequestViewScene;
    statusEl = document.getElementById('editor-debug-console');

    // Renderer
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    updateSize();

    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a2e);

    // Selection Group (for multi-object transform)
    selectionGroup = new THREE.Group();
    scene.add(selectionGroup);

    // Box Helper for selection highlighting
    selectionBoxHelper = new THREE.BoxHelper(selectionGroup, 0xffff00); // Yellow
    selectionBoxHelper.visible = false;
    scene.add(selectionBoxHelper);

    // Grid
    const grid = new THREE.GridHelper(20, 40, 0x444466, 0x333355);
    grid.material.opacity = 0.5;
    grid.material.transparent = true;
    scene.add(grid);

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(5, 10, 7);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(1024, 1024);
    scene.add(dirLight);

    const hemiLight = new THREE.HemisphereLight(0xb1e1ff, 0xb97a20, 0.4);
    scene.add(hemiLight);

    // Camera
    camera = new THREE.PerspectiveCamera(50, canvas.clientWidth / canvas.clientHeight, 0.01, 1000);
    camera.position.set(3, 2, 3);

    // Orbit
    orbitControls = new OrbitControls(camera, canvas);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.08;

    // Transform Controls
    transformControls = new TransformControls(camera, canvas);
    transformControls.addEventListener('dragging-changed', (event) => {
        orbitControls.enabled = !event.value;
    });
    // Push undo state when user starts dragging the gizmo
    transformControls.addEventListener('mouseDown', () => {
        pushUndoState();
    });
    transformControls.addEventListener('objectChange', () => {
        updateTransformInfo();
        debouncedSave();
    });
    scene.add(transformControls);

    // Events — use pointerdown + pointerup for click-vs-drag detection
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);

    // Touch events for generic tool
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', updateSize);

    // Toolbar buttons
    document.querySelectorAll('#editor-toolbar .tool-btn[data-mode]').forEach(btn => {
        btn.addEventListener('click', () => setTransformMode(btn.dataset.mode));
    });
    // Set default mode
    setTransformMode('none');
    document.getElementById('btn-space').addEventListener('click', toggleSpace);
    document.getElementById('btn-clone').addEventListener('click', cloneSelected);
    document.getElementById('btn-delete').addEventListener('click', deleteSelected);
    document.getElementById('btn-share').addEventListener('click', shareLink);
    document.getElementById('btn-editor-undo').addEventListener('click', undoEditor);

    // Start render loop
    editorActive = true;
    animate();
    setStatus('Editor ready. Load a model to begin.');
}

export async function loadModel(url) {
    setStatus('Loading model...');

    // Clear previous
    if (loadedModel) {
        scene.remove(loadedModel);
        loadedModel = null;
    }
    editableObjects = [];
    selectedObject = null;
    transformControls.detach();

    const loader = new GLTFLoader();
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    loader.setDRACOLoader(dracoLoader);

    try {
        const gltf = await loader.loadAsync(url);
        loadedModel = gltf.scene;
        scene.add(loadedModel);

        // Collect editable objects (top-level children of the gltf scene)
        loadedModel.children.forEach((child, idx) => {
            child.userData._editorIndex = idx;
            child.userData._editorOriginalName = child.name || `Object_${idx}`;
            child.userData._isCloned = false;
            editableObjects.push(child);
        });

        // Re-pivot each editable object so the gizmo appears at its visual center
        editableObjects.forEach(obj => rePivotToBBoxCenter(obj));

        // Frame the model
        frameModel();
        updateObjectList();
        setStatus(`Loaded ${editableObjects.length} objects.`);
    } catch (err) {
        console.error('Failed to load model:', err);
        setStatus('Error loading model: ' + err.message);
    }
}

export function applySceneState(sceneData) {
    if (!sceneData || !Array.isArray(sceneData)) return;

    sceneData.forEach(entry => {
        if (entry.cloned && entry.sourceIndex !== undefined) {
            // Find source object
            const source = editableObjects.find(
                o => o.userData._editorIndex === entry.sourceIndex && !o.userData._isCloned
            );
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

            loadedModel.add(clone);
            editableObjects.push(clone);
        } else {
            // Find original object by index
            const obj = editableObjects.find(
                o => o.userData._editorIndex === entry.index && !o.userData._isCloned
            );
            if (!obj) return;
            if (entry.position) obj.position.fromArray(entry.position);
            if (entry.rotation) obj.rotation.set(entry.rotation[0], entry.rotation[1], entry.rotation[2]);
            if (entry.scale) obj.scale.fromArray(entry.scale);
        }
    });

    updateObjectList();
}

export function getSceneState() {
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
    return state;
}

/**
 * Re-center a scene group so that its bounding-box center X/Z is at origin
 * and its bottom (min Y) sits at Y=0 (floor plane). This ensures correct
 * WebXR AR floor placement.
 */
function centerForExport(group) {
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());
    const minY = box.min.y;

    // Shift all top-level children so the scene is centered at origin with floor at Y=0
    group.children.forEach(child => {
        child.position.x -= center.x;
        child.position.y -= minY;   // lift so bottom = 0
        child.position.z -= center.z;
    });

    // Reset the root group transform
    group.position.set(0, 0, 0);
    group.rotation.set(0, 0, 0);
    group.scale.set(1, 1, 1);
    group.updateMatrixWorld(true);
}

export async function exportSceneAsGLB() {
    if (!loadedModel) return null;

    // CRITICAL: Deselect everything so they are detached from selectionGroup 
    // and re-attached to loadedModel with correct world transforms.
    updateSelection([]);

    // Clone the model so we don't modify the editor's live scene
    const exportClone = loadedModel.clone(true);
    centerForExport(exportClone);

    return new Promise((resolve, reject) => {
        const exporter = new GLTFExporter();
        exporter.parse(
            exportClone,
            (buffer) => {
                const blob = new Blob([buffer], { type: 'model/gltf-binary' });
                resolve(URL.createObjectURL(blob));
            },
            (error) => reject(error),
            { binary: true }
        );
    });
}

export function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', updateSize);
    if (canvas) {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointerup', onPointerUp);
    }
    if (renderer) renderer.dispose();
    if (orbitControls) orbitControls.dispose();
    if (transformControls) transformControls.dispose();
}

// ---- Internal ----

/**
 * Re-pivot an object so its local origin is at the specified world position.
 * Uses scene attachment to preserve child world positions.
 */
function setPivot(obj, targetWorldPos) {
    if (!obj) return;

    // 1. Calculate offset in obj's Local Space
    // We want to know where targetWorldPos is, relative to obj's current origin
    obj.updateMatrixWorld();
    const localOffset = obj.worldToLocal(targetWorldPos.clone());

    if (localOffset.lengthSq() < 0.00001) return; // Already there

    // 2. Shift Geometry (if it's a Mesh)
    if (obj.geometry) {
        obj.geometry.translate(-localOffset.x, -localOffset.y, -localOffset.z);
    }

    // 3. Shift Children (to keep them in place relative to visual pivot)
    // Children positions are relative to obj origin. If origin moves +offset,
    // children must move -offset to stay in same world spot.
    obj.children.forEach(child => {
        child.position.sub(localOffset);
    });

    // 4. Move Object to new pivot location
    // We set the object's position to the targetWorldPos
    if (obj.parent) {
        obj.parent.updateMatrixWorld();
        const newLocalPos = obj.parent.worldToLocal(targetWorldPos.clone());
        obj.position.copy(newLocalPos);
    } else {
        obj.position.copy(targetWorldPos);
    }

    obj.updateMatrixWorld();
}

/**
 * Re-pivot an object so its local origin is at its bounding-box center.
 * This makes TransformControls gizmo appear at the "center of mass".
 */
function rePivotToBBoxCenter(obj) {
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return; // Prevent NaN errors on empty nodes
    const center = box.getCenter(new THREE.Vector3());
    // User wants pivot at the bottom of the object centered horizontally
    const bottomCenter = new THREE.Vector3(center.x, box.min.y, center.z);
    setPivot(obj, bottomCenter);
}

function animate() {
    if (!editorActive) return;
    requestAnimationFrame(animate);
    orbitControls.update();
    // Update bounding box helper every frame so it follows moving objects
    if (selectionBoxHelper && selectionBoxHelper.visible) {
        selectionBoxHelper.update();
    }
    renderer.render(scene, camera);
}

function updateSize() {
    if (!canvas || !renderer) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w <= 0 || h <= 0) return;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    renderer.setSize(w, h);
    if (camera) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
}

function frameModel() {
    if (!loadedModel) return;
    const box = new THREE.Box3().setFromObject(loadedModel);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim * 2;

    orbitControls.target.copy(center);
    camera.position.set(center.x + dist * 0.6, center.y + dist * 0.4, center.z + dist * 0.6);
    camera.lookAt(center);
    orbitControls.update();
}

function onPointerDown(event) {
    // Ignore if interacting with transform controls gizmo
    if (transformControls.dragging) return;

    // Record pointer start for click-vs-drag detection
    pointerDownPos = { x: event.clientX, y: event.clientY };
}

function onPointerUp(event) {
    // If no recorded down position, ignore (could be transform controls drag)
    if (!pointerDownPos) return;

    // Check if this was a click (not a drag/orbit rotation)
    const dx = event.clientX - pointerDownPos.x;
    const dy = event.clientY - pointerDownPos.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    pointerDownPos = null;

    // If pointer moved more than threshold, it was an orbit/pan — don't change selection
    if (dist > CLICK_THRESHOLD) return;

    const rect = canvas.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Handle Cursor Tool (Set Pivot)
    if (currentMode === 'cursor') {
        const intersects = getIntersects(mouse, editableObjects, true); // recursive
        if (intersects.length > 0) {
            const hit = intersects[0];
            const targetObj = findEditableParent(hit.object);
            if (targetObj) {
                setPivot(targetObj, hit.point);
                // Do NOT select/attach gizmo. Just set pivot.
                // Visual feedback
                showPivotFeedback(hit.point);
                setStatus(`Pivot set for ${targetObj.userData._editorOriginalName}`);
            }
        }
        return;
    }

    // 4. Handle Selection (ONLY in 'select' mode)
    if (currentMode === 'select') {

        // Raycast for objects
        raycaster.setFromCamera(mouse, camera);

        // Intersect editable objects
        // We need to recursively check children of editableObjects
        let interactable = [];
        editableObjects.forEach(obj => {
            obj.traverse(child => {
                if (child.isMesh || child.isGroup) interactable.push(child);
            });
        });

        const intersects = raycaster.intersectObjects(interactable, false);

        if (intersects.length > 0) {
            // Find the root editable object for this hit
            let hit = intersects[0].object;
            let editable = null;

            // Walk up until we find a member of editableObjects
            let curr = hit;
            while (curr) {
                if (editableObjects.includes(curr)) {
                    editable = curr;
                    break;
                }
                if (curr === scene || curr === loadedModel) break;
                curr = curr.parent;
            }

            if (editable) {
                // Toggle selection
                const isSelected = selectedObjects.includes(editable);
                if (isSelected) {
                    const newSelection = selectedObjects.filter(o => o !== editable);
                    updateSelection(newSelection);
                } else {
                    updateSelection([...selectedObjects, editable]);
                }
                return;
            }
        }

        // Clicked empty space — Select All
        updateSelection(editableObjects);
        setStatus("Selected All Objects");
    }
}

function findEditableParent(obj) {
    while (obj) {
        if (editableObjects.includes(obj)) return obj;
        if (obj === scene) return null;
        obj = obj.parent;
    }
    return null;
}

function getIntersects(mouse, objects, recursive = false) {
    raycaster.setFromCamera(mouse, camera);
    const targets = [];
    objects.forEach(obj => {
        if (recursive) {
            targets.push(obj);
        } else {
            obj.traverse(child => {
                if (child.isMesh) targets.push(child);
            });
        }
    });
    // If recursive is true, Raycaster handles recursion if we pass the group
    // BUT raycaster.intersectObjects(objects, true) where objects is array of groups works.
    return raycaster.intersectObjects(objects, recursive);
}

function showPivotFeedback(pos) {
    const geo = new THREE.SphereGeometry(0.05, 16, 16);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    scene.add(mesh);
    setTimeout(() => scene.remove(mesh), 500);
}

export function updateSelection(objects) {
    // 1. Detach current selection (if any) back to loadedModel
    if (selectedObjects.length > 0) {
        // We must iterate backwards or copy array because attach modifies the children array of the group
        const currentChildren = [...selectionGroup.children];
        currentChildren.forEach(child => {
            if (loadedModel) loadedModel.attach(child);
            else scene.attach(child);
        });
        transformControls.detach();
    }

    // 2. Update state
    selectedObjects = objects || [];
    selectedObject = selectedObjects.length > 0 ? selectedObjects[0] : null; // Legacy support

    // 3. If no new selection, update UI and return
    if (selectedObjects.length === 0) {
        updateObjectList();
        updateTransformInfo();
        return;
    }

    // 4. Calculate Group Pivot
    // Logic: Average X and Z, Minimum Y (Floor)
    let avgX = 0, avgZ = 0, minY = Infinity;

    selectedObjects.forEach(obj => {
        // Get world position
        const worldPos = new THREE.Vector3();
        obj.getWorldPosition(worldPos);

        avgX += worldPos.x;
        avgZ += worldPos.z;
        if (worldPos.y < minY) minY = worldPos.y;
    });

    avgX /= selectedObjects.length;
    avgZ /= selectedObjects.length;

    if (minY === Infinity) minY = 0;

    // 5. Position Selection Group
    selectionGroup.position.set(avgX, minY, avgZ);
    selectionGroup.rotation.set(0, 0, 0);
    selectionGroup.scale.set(1, 1, 1);
    selectionGroup.updateMatrixWorld();

    // 6. Attach objects to group
    selectedObjects.forEach(obj => {
        selectionGroup.attach(obj);
    });

    // 7. Update Helpers
    if (selectionBoxHelper) {
        selectionBoxHelper.update();
        // Check visibility based on mode
        const visibleModes = ['select', 'translate', 'rotate', 'scale', 'generic'];
        selectionBoxHelper.visible = visibleModes.includes(currentMode);
    }

    // 8. Attach Controls (ONLY if NOT in select/cursor/none)
    // Select Mode = No Gizmo (User Request)
    if (currentMode === 'translate' || currentMode === 'rotate' || currentMode === 'scale') {
        transformControls.attach(selectionGroup);
    } else {
        transformControls.detach();
    }

    // 8. Update UI
    updateObjectList();
    updateTransformInfo();
    setStatus(`Selected ${selectedObjects.length} object(s)`);
}

function selectObject(obj) {
    // Single select wrapper
    updateSelection([obj]);
}

function deselectObject() {
    updateSelection([]);
}

function setTransformMode(mode) {
    currentMode = mode;

    // Reset state
    isDragging = false;
    touches = {};

    // Default: Orbit enabled (unless generic)
    orbitControls.enabled = true;

    // Gizmo Visibility
    if (mode === 'translate' || mode === 'rotate' || mode === 'scale') {
        transformControls.setMode(mode);
        if (selectedObjects.length > 0) transformControls.attach(selectionGroup);
    } else {
        transformControls.detach();
    }

    if (mode === 'generic') {
        orbitControls.enabled = false;
    }

    // Helper Visibility
    if (selectionBoxHelper) {
        const visibleModes = ['select', 'translate', 'rotate', 'scale', 'generic'];
        selectionBoxHelper.visible = visibleModes.includes(mode) && selectedObjects.length > 0;
        if (selectionBoxHelper.visible) selectionBoxHelper.update();
    }

    document.querySelectorAll('#editor-toolbar .tool-btn[data-mode]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    let msg = '';
    switch (mode) {
        case 'none': msg = 'View Only Mode'; break;
        case 'generic': msg = 'Generic Interaction (1-finger drag, 2-finger scale/rotate)'; break;
        case 'cursor': msg = 'Click on model to set pivot point'; break;
        default: msg = `Tool: ${mode}`;
    }
    setStatus(msg);
}

function toggleSpace() {
    const btn = document.getElementById('btn-space');
    const current = transformControls.space;
    const next = current === 'local' ? 'world' : 'local';
    transformControls.setSpace(next);
    btn.textContent = next === 'local' ? 'L' : 'W';
}

function cloneSelected() {
    if (selectedObjects.length === 0 || !loadedModel) return;
    pushUndoState();

    const newClones = [];

    // We need to be careful cloning while they are attached to selectionGroup.
    // Cloning an object that is child of selectionGroup will clone it in that local space.
    // Ideally, we want to clone the original state. 
    // BUT, the user might have transformed the group.

    // Simplest approach: Deselect (apply transforms), Clone, Select New Clones.
    // This ensures transforms are baked into objects before cloning.

    // Save current selection to re-select if needed (though we select clones usually)
    const currentSelection = [...selectedObjects];

    // Temporarily deselect to bake transforms to world/parent space
    updateSelection([]);

    currentSelection.forEach(obj => {
        const clone = obj.clone(true);
        clone.userData._editorIndex = editableObjects.length;
        clone.userData._editorOriginalName = obj.userData._editorOriginalName + '_clone';
        clone.userData._isCloned = true;
        clone.userData._sourceIndex = obj.userData._isCloned
            ? obj.userData._sourceIndex
            : obj.userData._editorIndex;
        clone.name = clone.userData._editorOriginalName;

        // Offset slightly so it's visible? Or keep same place?
        // editor.js existing logic offset x by 0.5.
        clone.position.x += 0.5;

        loadedModel.add(clone);
        editableObjects.push(clone);
        newClones.push(clone);
    });

    // Select the new clones
    updateSelection(newClones);
    saveScene();
    setStatus(`Cloned ${newClones.length} objects`);
}

function deleteSelected() {
    if (selectedObjects.length === 0) return;
    pushUndoState();

    // Filter out non-clones? Or just delete what we can?
    // "Only clones can be deleted" rule in existing code.
    const toDelete = selectedObjects.filter(obj => obj.userData._isCloned);

    if (toDelete.length === 0) {
        setStatus('Cannot delete original objects. Only clones can be deleted.');
        return;
    }

    if (toDelete.length < selectedObjects.length) {
        setStatus('Some objects were not deleted (originals).');
    }

    // Detach from controls
    transformControls.detach();

    // We need to remove them from Scene/Group. 
    // Check parent. If they are in selectionGroup, remove from there.
    toDelete.forEach(obj => {
        if (obj.parent) obj.parent.remove(obj);
        // Also remove from editableObjects
        const idx = editableObjects.indexOf(obj);
        if (idx > -1) editableObjects.splice(idx, 1);
    });

    // Update selection state
    // Remove deleted ones from selectedObjects array
    selectedObjects = selectedObjects.filter(obj => !toDelete.includes(obj));

    // If we still have objects selected, re-run updateSelection to recalculate pivot
    const remaining = [...selectedObjects];
    // Force update (pass empty first to reset, then remaining)
    // Actually updateSelection handles "detach current", but "current" is broken now if we removed children directly.
    // Safer to just clear selectionGroup manually if needed, but updateSelection logic tries to attach children back to loadedModel.
    // Since we removed toDelete items, they are gone. stored `selectedObjects` still has them until we filtered above.

    // Reset selection group
    selectionGroup.clear(); // Remove visual helpers if any (none currently), children are gone or detached
    transformControls.detach();

    // Call updateSelection with remaining
    updateSelection(remaining);

    saveScene();
    setStatus(`Deleted ${toDelete.length} objects`);
}

function onKeyDown(e) {
    if (!document.getElementById('editor-screen').classList.contains('active')) return;

    // Shortcuts
    switch (e.key.toLowerCase()) {
        case 'v': setTransformMode('none'); break;
        case 'g': setTransformMode('generic'); break;
        case 'c': setTransformMode('cursor'); break;
        case 'w': setTransformMode('translate'); break;
        case 'e': setTransformMode('rotate'); break;
        case 'r': setTransformMode('scale'); break;
        case 'q': toggleSpace(); break;
        case 'delete':
        case 'backspace': deleteSelected(); e.preventDefault(); break;
        case 'd':
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                cloneSelected();
            }
            break;
        case 'z':
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                undoEditor();
            }
            break;
        case 'f':
            frameModel();
            break;
    }
}

// ---- Touch Logic for Generic Tool ----

function onTouchStart(event) {
    if (currentMode !== 'generic') return;

    // If touching UI, ignore
    if (event.target !== canvas) return;

    // Prevent default to stop scrolling/zooming by browser
    event.preventDefault();

    for (let i = 0; i < event.changedTouches.length; i++) {
        const t = event.changedTouches[i];
        touches[t.identifier] = { x: t.clientX, y: t.clientY };
    }

    const touchKeys = Object.keys(touches);

    if (touchKeys.length === 1) {
        // Check if we hit an object
        const t = touches[touchKeys[0]];
        const rect = canvas.getBoundingClientRect();
        const m = new THREE.Vector2(
            ((t.x - rect.left) / rect.width) * 2 - 1,
            -((t.y - rect.top) / rect.height) * 2 + 1
        );

        dragRaycaster.setFromCamera(m, camera);
        const intersects = dragRaycaster.intersectObjects(editableObjects, true);

        if (intersects.length > 0) {
            // Hit an object -> Start Drag
            // If the hit object is NOT in current selection, select it (single select)
            const hitObj = findEditableParent(intersects[0].object);
            if (hitObj && !selectedObjects.includes(hitObj)) {
                updateSelection([hitObj]);
            }

            // Allow dragging if we have a selection
            if (selectedObjects.length > 0) {
                isDragging = true;
                dragObject = selectionGroup; // Drag the group!

                orbitControls.enabled = false;

                // Init drag plane at object height (or ground)
                const hitPoint = intersects[0].point;
                dragPlane.constant = -hitPoint.y;

                // Offset
                dragOffset.subVectors(dragObject.position, hitPoint);
                dragOffset.y = 0;
            }
        } else if (selectedObjects.length > 0) {
            // No hit on object, but selection exists → drag selection by offset (like AR viewer)
            isDragging = true;
            dragObject = selectionGroup;
            orbitControls.enabled = false;

            // Compute offset from floor-plane hit to group position
            const t2 = touches[touchKeys[0]];
            const rect2 = canvas.getBoundingClientRect();
            const m2 = new THREE.Vector2(
                ((t2.x - rect2.left) / rect2.width) * 2 - 1,
                -((t2.y - rect2.top) / rect2.height) * 2 + 1
            );
            dragRaycaster.setFromCamera(m2, camera);
            const hitPt = new THREE.Vector3();
            if (dragRaycaster.ray.intersectPlane(dragPlane, hitPt)) {
                dragOffset.subVectors(dragObject.position, hitPt);
                dragOffset.y = 0;
            } else {
                dragOffset.set(0, 0, 0);
            }
        } else {
            isDragging = false;
            orbitControls.enabled = true;
        }
    } else if (touchKeys.length === 2) {
        // Two fingers -> Scale/Rotate selected object OR Orbit if no object selected?
        if (selectedObjects.length > 0) {
            orbitControls.enabled = false;
            isTwoFingerGesture = true;

            const t1 = touches[touchKeys[0]];
            const t2 = touches[touchKeys[1]];
            lastTouchDist = Math.hypot(t2.x - t1.x, t2.y - t1.y);
            lastTouchAngle = Math.atan2(t2.y - t1.y, t2.x - t1.x);
        } else {
            orbitControls.enabled = true; // Let orbit handle 2-finger zoom/pan
        }
    }
}

let isTwoFingerGesture = false;

function onTouchMove(event) {
    if (currentMode !== 'generic') return;
    event.preventDefault();

    for (let i = 0; i < event.changedTouches.length; i++) {
        const t = event.changedTouches[i];
        if (touches[t.identifier]) {
            touches[t.identifier] = { x: t.clientX, y: t.clientY };
        }
    }

    const touchKeys = Object.keys(touches);

    if (touchKeys.length === 1 && isDragging && dragObject) {
        const t = touches[touchKeys[0]];
        const rect = canvas.getBoundingClientRect();
        const m = new THREE.Vector2(
            ((t.x - rect.left) / rect.width) * 2 - 1,
            -((t.y - rect.top) / rect.height) * 2 + 1
        );

        dragRaycaster.setFromCamera(m, camera);
        const hit = new THREE.Vector3();
        if (dragRaycaster.ray.intersectPlane(dragPlane, hit)) {
            dragObject.position.x = hit.x + dragOffset.x;
            dragObject.position.z = hit.z + dragOffset.z;
            // Keep Y same?
            dragObject.updateMatrixWorld(); // Update group
            updateTransformInfo();
            debouncedSave();
        }
    } else if (touchKeys.length === 2 && isTwoFingerGesture && selectedObjects.length > 0) {
        const t1 = touches[touchKeys[0]];
        const t2 = touches[touchKeys[1]];

        const dist = Math.hypot(t2.x - t1.x, t2.y - t1.y);
        const angle = Math.atan2(t2.y - t1.y, t2.x - t1.x);

        if (lastTouchDist > 0) {
            const scaleFactor = dist / lastTouchDist;
            selectionGroup.scale.multiplyScalar(scaleFactor);
            // Clamp scale uniformly
            const s = selectionGroup.scale.x;
            const clamped = Math.max(0.01, Math.min(s, 20));
            selectionGroup.scale.setScalar(clamped);
        }

        const angleDelta = angle - lastTouchAngle;
        selectionGroup.rotation.y += angleDelta;

        lastTouchDist = dist;
        lastTouchAngle = angle;
        updateTransformInfo();
        debouncedSave();
    }
}

function onTouchEnd(event) {
    if (currentMode !== 'generic') return;
    event.preventDefault();

    for (let i = 0; i < event.changedTouches.length; i++) {
        delete touches[event.changedTouches[i].identifier];
    }

    if (Object.keys(touches).length === 0) {
        orbitControls.enabled = true;
        isDragging = false;
        isTwoFingerGesture = false;
        dragObject = null;
    }
}


function updateObjectList() {
    const list = document.getElementById('object-list');
    list.innerHTML = '';

    editableObjects.forEach(obj => {
        const div = document.createElement('div');
        const isSelected = selectedObjects.includes(obj);
        div.className = 'object-item' + (isSelected ? ' selected' : '');
        div.innerHTML = `
            <span class="obj-icon">◆</span>
            <span class="obj-name">${obj.userData._editorOriginalName}</span>
            ${obj.userData._isCloned ? '<span class="obj-cloned">clone</span>' : ''}
        `;
        div.addEventListener('click', (e) => {
            // Check for ctrl/shift for multi-select toggle? 
            // For now, adhere to "click an object -> only that object"
            // If we want multiple, we can implement Ctrl+Click here later.
            // User request: "Clicking one object selects that".
            selectObject(obj);
        });
        list.appendChild(div);
    });
}
function updateTransformInfo() {
    const info = document.getElementById('transform-info');
    if (selectedObjects.length === 0) {
        info.textContent = 'No selection';
        return;
    }

    // If multiple, show Group info
    const target = selectedObjects.length > 1 ? selectionGroup : selectedObjects[0];
    const name = selectedObjects.length > 1 ? `Group (${selectedObjects.length} objects)` : target.userData._editorOriginalName;

    const p = target.position;
    const r = target.rotation;
    const s = target.scale;
    const deg = (v) => (v * 180 / Math.PI).toFixed(1);

    info.innerHTML = `
<b>${name}</b>
Pos: ${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}
Rot: ${deg(r.x)}°, ${deg(r.y)}°, ${deg(r.z)}°
Scl: ${s.x.toFixed(3)}, ${s.y.toFixed(3)}, ${s.z.toFixed(3)}
    `.trim();
}

let saveTimeout = null;
function debouncedSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveScene(), 300);
}

function saveScene() {
    if (onSceneChanged) {
        const state = getSceneState();
        onSceneChanged(state);
    }
}

// ---- Undo Logic ----

function pushUndoState() {
    // Snapshot all editable objects' transforms + which are clones
    // Must deselect first to bake transforms back to loadedModel space
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
    undoStack.push(snapshot);
    if (undoStack.length > MAX_UNDO) undoStack.shift();

    // Re-select
    updateSelection(currentSel);
}

function undoEditor() {
    if (undoStack.length === 0) {
        setStatus('Nothing to undo');
        return;
    }

    const snapshot = undoStack.pop();

    // Deselect to detach from selectionGroup
    updateSelection([]);
    transformControls.detach();

    // Remove any objects that didn't exist in the snapshot
    const snapshotRefs = new Set(snapshot.map(s => s.ref));
    const toRemove = editableObjects.filter(obj => !snapshotRefs.has(obj));
    toRemove.forEach(obj => {
        if (obj.parent) obj.parent.remove(obj);
    });

    // Restore transforms and re-add any objects that were removed since snapshot
    editableObjects = [];
    snapshot.forEach(entry => {
        const obj = entry.ref;
        obj.position.fromArray(entry.position);
        obj.rotation.set(entry.rotation[0], entry.rotation[1], entry.rotation[2]);
        obj.scale.fromArray(entry.scale);
        // Re-add to loadedModel if somehow removed
        if (!obj.parent && loadedModel) {
            loadedModel.add(obj);
        }
        editableObjects.push(obj);
    });

    updateObjectList();
    saveScene();
    setStatus('Undo applied');
}



function shareLink() {
    const url = window.location.href;
    navigator.clipboard.writeText(url).then(() => {
        setStatus('Link copied to clipboard!');
    }).catch(() => {
        // Fallback
        prompt('Copy this link:', url);
    });
}

function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg + '\n' + statusEl.textContent;
}

// ---- Static helpers (for use without full editor init) ----

export async function loadAndComposeGLB(modelUrl, sceneData) {
    const loader = new GLTFLoader();
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    loader.setDRACOLoader(dracoLoader);

    const gltf = await loader.loadAsync(modelUrl);
    const modelScene = gltf.scene;

    // Index the children
    const originals = [];
    modelScene.children.forEach((child, idx) => {
        child.userData._editorIndex = idx;
        originals.push(child);
    });

    // Apply scene data
    if (sceneData && Array.isArray(sceneData)) {
        sceneData.forEach(entry => {
            if (entry.cloned && entry.sourceIndex !== undefined) {
                const source = originals[entry.sourceIndex];
                if (!source) return;
                const clone = source.clone(true);
                if (entry.position) clone.position.fromArray(entry.position);
                if (entry.rotation) clone.rotation.set(entry.rotation[0], entry.rotation[1], entry.rotation[2]);
                if (entry.scale) clone.scale.fromArray(entry.scale);
                modelScene.add(clone);
            } else {
                const obj = originals[entry.index];
                if (!obj) return;
                if (entry.position) obj.position.fromArray(entry.position);
                if (entry.rotation) obj.rotation.set(entry.rotation[0], entry.rotation[1], entry.rotation[2]);
                if (entry.scale) obj.scale.fromArray(entry.scale);
            }
        });
    }

    // Re-center for AR floor placement
    centerForExport(modelScene);

    // Export composed scene
    return new Promise((resolve, reject) => {
        const exporter = new GLTFExporter();
        exporter.parse(
            modelScene,
            (buffer) => {
                const blob = new Blob([buffer], { type: 'model/gltf-binary' });
                resolve(URL.createObjectURL(blob));
            },
            (error) => reject(error),
            { binary: true }
        );
    });
}
