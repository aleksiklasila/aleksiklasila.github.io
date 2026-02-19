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
let selectedObject = null;
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
    statusEl = document.getElementById('editor-status');

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
    document.getElementById('btn-open-viewer').addEventListener('click', openInViewer);
    document.getElementById('btn-share').addEventListener('click', shareLink);

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
    if (!obj || !obj.parent) return;

    // Detach children to Scene to preserve their World Transforms
    const children = [];
    // We must copy the children array as we'll be modifying it
    [...obj.children].forEach(child => {
        children.push(child);
        scene.attach(child);
    });

    // Move obj to target position (converting world to parent-local)
    const parentLocalPos = obj.parent.worldToLocal(targetWorldPos.clone());
    obj.position.copy(parentLocalPos);
    obj.updateMatrixWorld();

    // Re-attach children
    children.forEach(child => {
        obj.attach(child);
    });
}

/**
 * Re-pivot an object so its local origin is at its bounding-box center.
 * This makes TransformControls gizmo appear at the "center of mass".
 */
function rePivotToBBoxCenter(obj) {
    const box = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    // User wants pivot at the bottom of the object centered horizontally
    const bottomCenter = new THREE.Vector3(center.x, box.min.y, center.z);
    setPivot(obj, bottomCenter);
}

function animate() {
    if (!editorActive) return;
    requestAnimationFrame(animate);
    orbitControls.update();
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
                selectObject(targetObj);
                setStatus(`Pivot set for ${targetObj.userData._editorOriginalName}`);
                // Visual feedback
                showPivotFeedback(hit.point);
            }
        }
        return;
    }

    raycaster.setFromCamera(mouse, camera);

    // Test against all editable objects
    const allMeshes = [];
    editableObjects.forEach(obj => {
        obj.traverse(child => {
            if (child.isMesh) allMeshes.push(child);
        });
    });

    const intersects = raycaster.intersectObjects(allMeshes, false);
    if (intersects.length > 0) {
        // Walk up to find the editable root
        let hit = intersects[0].object;
        const editable = findEditableParent(hit);
        if (editable) {
            selectObject(editable);
            return;
        }
    }

    // Clicked empty space — deselect
    deselectObject();
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

function selectObject(obj) {
    selectedObject = obj;
    transformControls.attach(obj);
    updateObjectList();
    updateTransformInfo();
    setStatus(`Selected: ${obj.userData._editorOriginalName}`);
}

function deselectObject() {
    selectedObject = null;
    transformControls.detach();
    updateObjectList();
    updateTransformInfo();
}

function setTransformMode(mode) {
    currentMode = mode;

    // Reset state
    isDragging = false;
    touches = {};
    orbitControls.enabled = true;

    if (mode === 'none' || mode === 'cursor' || mode === 'generic') {
        transformControls.detach();
    } else {
        transformControls.setMode(mode);
        if (selectedObject) transformControls.attach(selectedObject);
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
    if (!selectedObject || !loadedModel) return;

    const clone = selectedObject.clone(true);
    clone.userData._editorIndex = editableObjects.length;
    clone.userData._editorOriginalName = selectedObject.userData._editorOriginalName + '_clone';
    clone.userData._isCloned = true;
    clone.userData._sourceIndex = selectedObject.userData._isCloned
        ? selectedObject.userData._sourceIndex
        : selectedObject.userData._editorIndex;
    clone.name = clone.userData._editorOriginalName;

    // Offset slightly
    clone.position.x += 0.5;

    loadedModel.add(clone);
    editableObjects.push(clone);
    selectObject(clone);
    saveScene();
    setStatus(`Cloned: ${clone.userData._editorOriginalName}`);
}

function deleteSelected() {
    if (!selectedObject) return;
    if (!selectedObject.userData._isCloned) {
        setStatus('Cannot delete original objects. Only clones can be deleted.');
        return;
    }

    const name = selectedObject.userData._editorOriginalName;
    transformControls.detach();
    loadedModel.remove(selectedObject);
    editableObjects = editableObjects.filter(o => o !== selectedObject);
    selectedObject = null;
    updateObjectList();
    updateTransformInfo();
    saveScene();
    setStatus(`Deleted: ${name}`);
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
            isDragging = true;
            dragObject = findEditableParent(intersects[0].object);

            if (dragObject) {
                selectObject(dragObject);
                orbitControls.enabled = false;

                // Init drag plane at object height (or ground)
                // We use a horizontal plane passing through the hit point
                const hitPoint = intersects[0].point;
                dragPlane.constant = -hitPoint.y;

                // Offset
                dragOffset.subVectors(dragObject.position, hitPoint);
                dragOffset.y = 0; // We only drag in XZ plane effectively if we project to plane
            }
        } else {
            // Hit background -> Orbit
            isDragging = false;
            orbitControls.enabled = true;
            deselectObject();
        }
    } else if (touchKeys.length === 2) {
        // Two fingers -> Scale/Rotate selected object OR Orbit if no object selected?
        // Logic: If we are interacting, disable orbit.

        if (selectedObject) {
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
            updateTransformInfo();
            debouncedSave();
        }
    } else if (touchKeys.length === 2 && isTwoFingerGesture && selectedObject) {
        const t1 = touches[touchKeys[0]];
        const t2 = touches[touchKeys[1]];

        const dist = Math.hypot(t2.x - t1.x, t2.y - t1.y);
        const angle = Math.atan2(t2.y - t1.y, t2.x - t1.x);

        if (lastTouchDist > 0) {
            const scaleFactor = dist / lastTouchDist;
            selectedObject.scale.multiplyScalar(scaleFactor);
            // Clamp?
            selectedObject.scale.max(new THREE.Vector3(20, 20, 20));
            selectedObject.scale.min(new THREE.Vector3(0.01, 0.01, 0.01));
        }

        const angleDelta = angle - lastTouchAngle;
        selectedObject.rotation.y += angleDelta;

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
        div.className = 'object-item' + (obj === selectedObject ? ' selected' : '');
        div.innerHTML = `
            <span class="obj-icon">◆</span>
            <span class="obj-name">${obj.userData._editorOriginalName}</span>
            ${obj.userData._isCloned ? '<span class="obj-cloned">clone</span>' : ''}
        `;
        div.addEventListener('click', () => selectObject(obj));
        list.appendChild(div);
    });
}

function updateTransformInfo() {
    const info = document.getElementById('transform-info');
    if (!selectedObject) {
        info.textContent = 'No selection';
        return;
    }
    const p = selectedObject.position;
    const r = selectedObject.rotation;
    const s = selectedObject.scale;
    const deg = (v) => (v * 180 / Math.PI).toFixed(1);
    info.innerHTML = `
<b>${selectedObject.userData._editorOriginalName}</b>
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

async function openInViewer() {
    if (!loadedModel) return;
    setStatus('Exporting scene to GLB...');
    try {
        const blobUrl = await exportSceneAsGLB();
        if (onRequestViewScene) {
            onRequestViewScene(blobUrl);
        }
    } catch (err) {
        console.error('Export failed:', err);
        setStatus('Export error: ' + err.message);
    }
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
    if (statusEl) statusEl.textContent = msg;
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
