// ============================================================
// App.js — Routing & URL Compression
// ============================================================
// All parameters are stored in a single compressed base64 JSON
// in the ?d= URL parameter. On load, this is decoded into a
// config map. Legacy ?model= is also supported for backwards
// compatibility.
//
// Config map shape:
// {
//   model: "https://...",       // GLB URL
//   mode: "editor" | undefined, // editor mode flag
//   scene: [...]               // scene state array
// }
// ============================================================

import { initEditor, loadModel, applySceneState, getSceneState, exportSceneAsGLB, loadAndComposeGLB, pauseEditor, resumeEditor } from './editor.js';
import { startARSession, isARSupported, endARSession } from './ar-viewer.js';
import { startScannerSession, isScannerSupported, endScannerSession, exportScanAsGLB } from './ar-scanner-app.js';

// --- URL Compression Helpers ---

function encodeConfig(config) {
    const json = JSON.stringify(config);
    const compressed = pako.deflate(json);
    // Convert Uint8Array to base64 (URL-safe)
    let binary = '';
    for (let i = 0; i < compressed.length; i++) {
        binary += String.fromCharCode(compressed[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeConfig(encoded) {
    try {
        // URL-safe base64 back to standard
        let b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
        // Pad
        while (b64.length % 4) b64 += '=';
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        const json = pako.inflate(bytes, { to: 'string' });
        return JSON.parse(json);
    } catch (e) {
        console.error('Failed to decode config:', e);
        return null;
    }
}

function updateUrlConfig(config) {
    const encoded = encodeConfig(config);
    const url = new URL(window.location);
    // Remove legacy params
    url.searchParams.delete('model');
    url.searchParams.delete('mode');
    url.searchParams.delete('scene');
    url.searchParams.set('d', encoded);
    window.history.replaceState({}, '', url);
}

// --- Global State ---

const state = {
    config: null, // decoded config map
    currentScreen: 'input-screen',
    editorInitialized: false,
};

// --- DOM Elements ---

const screens = {
    input: document.getElementById('input-screen'),
    editor: document.getElementById('editor-screen'),
    standard: document.getElementById('standard-viewer-screen'),
    loading: document.getElementById('loading-overlay'),
};

const inputUrl = document.getElementById('model-url-input');
const btnStartEditor = document.getElementById('btn-start-editor');
const btnStartAR = document.getElementById('btn-start-ar');
const btnStartScanner = document.getElementById('btn-start-scanner');

const topNavBar = document.getElementById('top-nav-bar');
const navTabs = {
    editor: document.getElementById('nav-tab-editor'),
    ar: document.getElementById('nav-tab-ar'),
    scanner: document.getElementById('nav-tab-scanner')
};
const btnExportGLB = document.getElementById('btn-export-glb');

const arOverlay = document.getElementById('ar-overlay');
const arScannerOverlay = document.getElementById('ar-scanner-overlay');

// We use model-viewer purely as a fallback for AR
const standardViewerScreen = document.getElementById('standard-viewer-screen');
const objModelViewer = document.getElementById('main-model-viewer');

// --- Initialization ---

async function init() {
    const urlParams = new URLSearchParams(window.location.search);

    // 1. Try compressed config
    const dParam = urlParams.get('d');
    if (dParam) {
        state.config = decodeConfig(dParam);
    }

    // 2. Fallback to legacy ?model= param
    if (!state.config) {
        const modelParam = urlParams.get('model');
        if (modelParam) {
            state.config = { model: modelParam };
            const modeParam = urlParams.get('mode');
            if (modeParam) state.config.mode = modeParam;
        }
    }

    // 3. Route based on config
    if (state.config && state.config.model) {
        if (!state.config.mode) state.config.mode = 'editor';
        switchMode(state.config.mode, true);
    } else {
        showScreen('input-screen');
    }

    // 4. Event Listeners
    btnStartEditor.addEventListener('click', () => handleUrlInput('editor'));
    btnStartAR.addEventListener('click', () => handleUrlInput('ar'));
    btnStartScanner.addEventListener('click', () => handleUrlInput('scanner'));

    inputUrl.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleUrlInput('editor');
    });

    Object.keys(navTabs).forEach(mode => {
        navTabs[mode].addEventListener('click', () => switchMode(mode));
    });

    if (btnExportGLB) {
        btnExportGLB.addEventListener('click', async () => {
            // Let editor or scanner handle export logic depending on mode
            if (state.config.mode === 'editor' || state.config.mode === 'ar') {
                // AR Viewer and Editor use the same scene/glb structure, we'll just export editor's since they are synced (or AR Viewer could have its own)
                const url = await exportSceneAsGLB();
                if (url) {
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'scene.glb';
                    a.click();
                }
            } else if (state.config.mode === 'scanner') {
                const url = await exportScanAsGLB();
                if (url) {
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'scan.glb';
                    a.click();
                }
            }
        });
    }
}

async function handleUrlInput(mode) {
    const url = inputUrl.value.trim();
    if (!url && mode !== 'scanner') { // Scanner doesn't strictly need a model, but editor does
        alert('Please enter a valid URL');
        return;
    }

    if (!state.config) state.config = {};
    if (url) state.config.model = url;

    updateUrlConfig(state.config);

    switchMode(mode);
}

async function switchMode(mode, initialLoad = false) {
    // End active XR sessions when switching away
    if (state.config.mode !== mode && !initialLoad) {
        if (state.config.mode === 'ar') endARSession();
        if (state.config.mode === 'scanner') endScannerSession();
    }

    state.config.mode = mode;
    updateUrlConfig(state.config);

    // Update Top Tabs
    Object.values(navTabs).forEach(t => t.classList.remove('active'));
    if (navTabs[mode]) navTabs[mode].classList.add('active');

    topNavBar.classList.add('visible');

    if (mode === 'editor') {
        startEditor(state.config.model, state.config.scene);
    } else if (mode === 'ar') {
        // Must wait for editor to initialize/load if we are pulling a scene
        launchAR(state.config.model);
    } else if (mode === 'scanner') {
        launchScanner();
    } else {
        topNavBar.classList.remove('visible');
        showScreen('input-screen');
    }
}

// --- Screen Management ---

function showScreen(screenId) {
    Object.values(screens).forEach(el => {
        if (el) el.classList.remove('active');
    });
    const screen = document.getElementById(screenId);
    if (screen) {
        screen.classList.add('active');
        state.currentScreen = screenId;
    }

    // Pause/resume editor render loop to avoid GPU contention
    if (screenId === 'editor-screen') {
        if (state.editorInitialized) resumeEditor();
    } else {
        if (state.editorInitialized) pauseEditor();
    }
}

// --- AR Viewer ---

async function launchAR(modelUrl) {
    if (!modelUrl) {
        alert('No model loaded to view in AR.');
        switchMode('editor');
        return;
    }

    const supported = await isARSupported();
    if (supported) {
        showScreen(''); // Close the normal viewer
        arOverlay.style.display = 'block';

        const success = await startARSession(modelUrl, arOverlay, {
            onExit: () => {
                arOverlay.style.display = 'none';
                if (state.config.mode === 'ar') switchMode('editor'); // automatically switch tabs back to editor
            },
            sceneData: state.config?.scene
        });

        if (!success) {
            arOverlay.style.display = 'none';
            // Fallback
            launchFallbackAR(modelUrl);
        }
    } else {
        // Fallback
        launchFallbackAR(modelUrl);
    }
}

async function launchFallbackAR(modelUrl) {
    if (objModelViewer.src !== modelUrl) objModelViewer.src = modelUrl;
    standardViewerScreen.classList.add('active'); // show screen manually
    // Automatically trigger model-viewer's AR
    try {
        await objModelViewer.activateAR();
    } catch (err) {
        alert("AR is completely unsupported here.");
        switchMode('editor');
    }
}

// --- AR Scanner ---

async function launchScanner() {
    const supported = await isScannerSupported();
    if (!supported) {
        alert("AR Scanner is not supported on your device. WebXR Immersive AR is required.");
        switchMode('editor');
        return;
    }

    showScreen(''); // Close the normal viewer
    arScannerOverlay.style.display = 'block';
    const success = await startScannerSession(arScannerOverlay, {
        onExit: () => {
            arScannerOverlay.style.display = 'none';
            if (state.config.mode === 'scanner') switchMode('editor');
        }
    });

    if (!success) {
        arScannerOverlay.style.display = 'none';
        switchMode('editor');
    }
}

// --- Editor ---

async function startEditor(modelUrl, sceneData) {
    showScreen('editor-screen');

    if (!state.editorInitialized) {
        const canvas = document.getElementById('editor-canvas');
        initEditor(canvas, {
            onSceneChanged: (sceneState) => {
                // Update config and URL
                if (!state.config) state.config = {};
                state.config.scene = sceneState;
                updateUrlConfig(state.config);
            },
            onRequestViewScene: (blobUrl) => {
                // Open in model-viewer
                loadStandardViewer(blobUrl);
                showScreen('standard-viewer-screen');
            },
        });
        state.editorInitialized = true;
    }

    await loadModel(modelUrl);
    if (sceneData) {
        applySceneState(sceneData);
    }
}

// --- Compose & View (auto-apply scene without editor) ---

async function composeAndView(modelUrl, sceneData) {
    showScreen('loading-overlay');
    document.getElementById('loading-text').textContent = 'Composing scene...';

    try {
        const blobUrl = await loadAndComposeGLB(modelUrl, sceneData);
        loadStandardViewer(blobUrl);
        showScreen('standard-viewer-screen');
    } catch (err) {
        console.error('Scene composition failed:', err);
        alert('Failed to compose scene: ' + err.message);
        showScreen('input-screen');
    }
}

// --- Start ---
init();
