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

import { initEditor, loadModel, applySceneState, getSceneState, exportSceneAsGLB, loadAndComposeGLB } from './editor.js';

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
const btnLoad = document.getElementById('load-btn');
const btnEdit = document.getElementById('edit-btn');
const btnEditFromViewer = document.getElementById('btn-edit-from-viewer');
const btnsBack = document.querySelectorAll('.back-btn');

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
        if (state.config.mode === 'editor') {
            // Editor mode
            await startEditor(state.config.model, state.config.scene);
        } else if (state.config.scene && state.config.scene.length > 0) {
            // Viewer with scene composition
            await composeAndView(state.config.model, state.config.scene);
        } else {
            // Plain viewer
            loadStandardViewer(state.config.model);
            showScreen('standard-viewer-screen');
        }
    } else {
        showScreen('input-screen');
    }

    // 4. Event Listeners
    btnLoad.addEventListener('click', () => handleUrlInput('viewer'));
    btnEdit.addEventListener('click', () => handleUrlInput('editor'));
    inputUrl.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleUrlInput('viewer');
    });

    btnEditFromViewer.addEventListener('click', () => {
        if (state.config && state.config.model) {
            state.config.mode = 'editor';
            updateUrlConfig(state.config);
            startEditor(state.config.model, state.config.scene);
        }
    });

    btnsBack.forEach(btn => {
        btn.addEventListener('click', () => {
            showScreen('input-screen');
            state.config = null;
            // Clear URL
            const url = new URL(window.location);
            url.searchParams.delete('d');
            url.searchParams.delete('model');
            url.searchParams.delete('mode');
            url.searchParams.delete('scene');
            window.history.pushState({}, '', url);
        });
    });
}

async function handleUrlInput(mode) {
    const url = inputUrl.value.trim();
    if (!url) {
        alert('Please enter a valid URL');
        return;
    }

    state.config = { model: url };

    if (mode === 'editor') {
        state.config.mode = 'editor';
        updateUrlConfig(state.config);
        await startEditor(url);
    } else {
        updateUrlConfig(state.config);
        loadStandardViewer(url);
        showScreen('standard-viewer-screen');
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
}

// --- Standard Viewer ---

function loadStandardViewer(url) {
    const viewer = document.getElementById('main-model-viewer');
    if (url && viewer.src !== url) {
        viewer.src = url;
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
