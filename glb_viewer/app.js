import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// --- Global State ---
const state = {
    modelUrl: null,
    currentScreen: 'input-screen', // input-screen, selection-screen, standard-viewer-screen, enhanced-viewer-screen
    threeInitialized: false,
    viewerEnhanced: {
        scene: null,
        camera: null,
        renderer: null,
        controls: null,
        transformControl: null,
        modelGroup: null
    }
};

// --- DOM Elements ---
const screens = {
    input: document.getElementById('input-screen'),
    selection: document.getElementById('selection-screen'),
    standard: document.getElementById('standard-viewer-screen'),
    enhanced: document.getElementById('enhanced-viewer-screen')
};

const inputUrl = document.getElementById('model-url-input');
const btnLoad = document.getElementById('load-btn');
const btnStandard = document.getElementById('btn-standard');
const btnEnhanced = document.getElementById('btn-enhanced');
const btnsBack = document.querySelectorAll('.back-btn');

// --- Initialization ---

function init() {
    // 1. Check URL params
    const urlParams = new URLSearchParams(window.location.search);
    const modelParam = urlParams.get('model');

    if (modelParam) {
        state.modelUrl = modelParam;
        showScreen('selection-screen');
    } else {
        showScreen('input-screen');
    }

    // 2. Event Listeners
    btnLoad.addEventListener('click', handleUrlInput);

    // Allow pressing Enter in input
    inputUrl.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleUrlInput();
    });

    btnStandard.addEventListener('click', () => {
        loadStandardViewer();
        showScreen('standard-viewer-screen');
    });

    btnEnhanced.addEventListener('click', () => {
        loadEnhancedViewer();
        showScreen('enhanced-viewer-screen');
    });

    btnsBack.forEach(btn => {
        btn.addEventListener('click', (e) => {
            const target = e.target.dataset.target;
            showScreen(target);

            // Should Pause rendering if leaving enhanced viewer to save battery?
            // For now, simple screen switch is enough.
        });
    });
}

function handleUrlInput() {
    const url = inputUrl.value.trim();
    if (!url) {
        alert("Please enter a valid URL");
        return;
    }

    // Update URL without reloading
    const newUrl = new URL(window.location);
    newUrl.searchParams.set('model', url);
    window.history.pushState({}, '', newUrl);

    state.modelUrl = url;
    showScreen('selection-screen');
}

function showScreen(screenId) {
    // Hide all
    Object.values(screens).forEach(el => el.classList.remove('active'));
    // Show target
    document.getElementById(screenId).classList.add('active');
    state.currentScreen = screenId;
}

// --- Standard Viewer Logic ---

function loadStandardViewer() {
    const viewer = document.getElementById('main-model-viewer');
    if (viewer.src !== state.modelUrl) {
        viewer.src = state.modelUrl;
    }
}

// --- Enhanced Viewer Logic (Three.js) ---

function loadEnhancedViewer() {
    if (!state.threeInitialized) {
        initThreeJS();
        state.threeInitialized = true;
    }

    // Load model if not already loaded or if URL changed (logic simplified for now, usually clear scene)
    loadGLBModel(state.modelUrl);
}

function initThreeJS() {
    const container = document.getElementById('three-canvas-container');
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x333333);
    scene.add(new THREE.GridHelper(10, 10));

    // Camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(3, 2, 5);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 1);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 2);
    dirLight.position.set(5, 10, 7);
    dirLight.castShadow = true;
    scene.add(dirLight);

    // Objects Group
    const modelGroup = new THREE.Group();
    scene.add(modelGroup);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Configuration for "RealityScan" style feeling
    // 1 finger rotate (default)
    // 2 finger pan/zoom (default for OrbitControls touch handling)
    controls.touches.ONE = THREE.TOUCH.ROTATE;
    controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;

    // Transform Controls (for moving objects)
    const transformControl = new TransformControls(camera, renderer.domElement);
    transformControl.addEventListener('dragging-changed', function (event) {
        controls.enabled = !event.value;
    });
    scene.add(transformControl);

    // Raycaster for selection
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    renderer.domElement.addEventListener('pointerdown', (event) => {
        // Calculate mouse position
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(modelGroup.children, true);

        if (intersects.length > 0) {
            // Find the root object that was loaded (usually scene) or the mesh itself
            // For better UX, we usually select the top-level object in our modelGroup
            let selected = intersects[0].object;

            // Traverse up to find the object that is a direct child of modelGroup
            while (selected.parent && selected.parent !== modelGroup) {
                selected = selected.parent;
            }

            transformControl.attach(selected);
        } else {
            transformControl.detach();
        }
    });

    // Handle Window Resize
    window.addEventListener('resize', () => {
        if (state.currentScreen === 'enhanced-viewer-screen') {
            camera.aspect = container.clientWidth / container.clientHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(container.clientWidth, container.clientHeight);
        }
    });

    // Save references
    state.viewerEnhanced = {
        scene, camera, renderer, controls, transformControl, modelGroup
    };

    // Animation Loop
    function animate() {
        requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
    }
    animate();
}

function loadGLBModel(url) {
    const { scene, modelGroup, transformControl, camera, controls } = state.viewerEnhanced;

    // Clear previous model
    while (modelGroup.children.length > 0) {
        modelGroup.remove(modelGroup.children[0]);
    }
    transformControl.detach();

    const loader = new GLTFLoader();
    loader.load(url, (gltf) => {
        const model = gltf.scene;

        // Auto-center and scale calculation (based on whole scene)
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());

        // Adjust Camera to fit
        const size = box.getSize(new THREE.Vector3()).length();
        const fitHeightDistance = size / (2 * Math.atan(Math.PI * camera.fov / 360));
        const fitWidthDistance = fitHeightDistance / camera.aspect;
        const distance = 1.5 * Math.max(fitHeightDistance, fitWidthDistance);

        // Reset controls target to center of the scene (0,0,0) because we will center objects there
        controls.target.set(0, 0, 0);

        // Position camera
        camera.position.set(distance, distance * 0.5, distance);
        camera.lookAt(0, 0, 0);

        // Offset to center objects at (0,0,0)
        const offset = center.negate();

        // Ungroup and add children to modelGroup for individual selection
        const children = [...model.children];

        children.forEach(child => {
            // Apply the centering offset to each child so the group stays centered
            child.position.add(offset);

            // Enable shadows
            child.traverse(node => {
                if (node.isMesh) {
                    node.castShadow = true;
                    node.receiveShadow = true;
                }
            });

            modelGroup.add(child);
        });

        controls.update();

    }, undefined, (error) => {
        console.error("An error occurred loading the GLB:", error);
        alert("Failed to load model. Check console or CORS settings.");
    });
}

// Start
init();
