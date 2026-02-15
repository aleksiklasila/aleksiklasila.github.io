// --- Global State ---
const state = {
    modelUrl: null,
    currentScreen: 'input-screen', // input-screen, standard-viewer-screen
};

// --- DOM Elements ---
const screens = {
    input: document.getElementById('input-screen'),
    standard: document.getElementById('standard-viewer-screen'),
};

const inputUrl = document.getElementById('model-url-input');
const btnLoad = document.getElementById('load-btn');
const btnsBack = document.querySelectorAll('.back-btn');

// --- Initialization ---

function init() {
    // 1. Check URL params
    const urlParams = new URLSearchParams(window.location.search);
    const modelParam = urlParams.get('model');

    if (modelParam) {
        state.modelUrl = modelParam;
        loadStandardViewer();
        showScreen('standard-viewer-screen');
    } else {
        showScreen('input-screen');
    }

    // 2. Event Listeners
    btnLoad.addEventListener('click', handleUrlInput);

    // Allow pressing Enter in input
    inputUrl.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleUrlInput();
    });

    btnsBack.forEach(btn => {
        btn.addEventListener('click', (e) => {
            // When going back, we usually want to go to input screen since selection is gone
            // But let's respect the data-target if we want to add more screens later, 
            // otherwise default to input-screen
            showScreen('input-screen');

            // Optional: Clear the URL param so refresh goes to input?
            // const newUrl = new URL(window.location);
            // newUrl.searchParams.delete('model');
            // window.history.pushState({}, '', newUrl);
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
    loadStandardViewer();
    showScreen('standard-viewer-screen');
}

function showScreen(screenId) {
    // Hide all
    Object.values(screens).forEach(el => el.classList.remove('active'));
    // Show target
    // Check if element exists (since we removed some screens)
    const screen = document.getElementById(screenId);
    if (screen) {
        screen.classList.add('active');
        state.currentScreen = screenId;
    } else {
        console.warn(`Screen ${screenId} not found`);
    }
}

// --- Standard Viewer Logic ---

function loadStandardViewer() {
    const viewer = document.getElementById('main-model-viewer');
    if (viewer.src !== state.modelUrl) {
        viewer.src = state.modelUrl;
    }
}

// Start
init();
