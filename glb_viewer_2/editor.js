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

// Callback to update URL params
let onSceneChanged = null;
let onRequestViewScene = null;
let statusEl = null;
let editorActive = false;

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

    // Events
    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', updateSize);

    // Toolbar buttons
    document.querySelectorAll('#editor-toolbar .tool-btn[data-mode]').forEach(btn => {
        btn.addEventListener('click', () => setTransformMode(btn.dataset.mode));
    });
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

export async function exportSceneAsGLB() {
    if (!loadedModel) return null;
    return new Promise((resolve, reject) => {
        const exporter = new GLTFExporter();
        exporter.parse(
            loadedModel,
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
    if (canvas) canvas.removeEventListener('pointerdown', onPointerDown);
    if (renderer) renderer.dispose();
    if (orbitControls) orbitControls.dispose();
    if (transformControls) transformControls.dispose();
}

// ---- Internal ----

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
    const w = parent.clientWidth - 220; // subtract panel width
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
    // Ignore if clicking on transform controls
    if (transformControls.dragging) return;

    const rect = canvas.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

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

    // Clicked empty space
    deselectObject();
}

function findEditableParent(obj) {
    while (obj) {
        if (editableObjects.includes(obj)) return obj;
        obj = obj.parent;
    }
    return null;
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
    transformControls.setMode(mode);
    document.querySelectorAll('#editor-toolbar .tool-btn[data-mode]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
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
    // Don't capture if typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    // Only handle if editor screen is active
    if (!document.getElementById('editor-screen').classList.contains('active')) return;

    switch (e.key.toLowerCase()) {
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
