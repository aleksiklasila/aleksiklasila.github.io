class EditorApp {
    constructor() {
        this.data = {
            images: {},       // name -> base64
            animations: {},   // name -> array (decoded)
        };

        this.actorConfig = {
            initialState: 'Idle',
            states: {
                // 'Idle': { animation: 'idle_anim', transitions: [ { condition: ['w'], target: 'Run' } ] }
            }
        };

        // UI Refs
        this.ui = {
            animList: document.getElementById('anim-list'),
            stateList: document.getElementById('state-list-container'),
            addStateBtn: document.getElementById('add-state-btn'),
            previewCanvas: document.getElementById('preview-canvas'),
            previewContainer: document.getElementById('preview-canvas-container'),
            debugState: document.getElementById('debug-state'),
            debugKeys: document.getElementById('debug-keys'),
            importBtn: document.getElementById('import-btn'),
            exportBtn: document.getElementById('export-btn'),
            fileInput: document.getElementById('file-input')
        };

        this.previewCtx = this.ui.previewCanvas.getContext('2d');
        this.previewCtx.imageSmoothingEnabled = false;

        this.inputState = {}; // { 'w': true }
        this.listeningForKey = null; // Callback when waiting for key press

        this.init();
    }

    init() {
        // Event Listeners
        this.ui.importBtn.addEventListener('click', () => this.handleImportClick());
        this.ui.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        this.ui.exportBtn.addEventListener('click', () => this.exportActor());
        this.ui.addStateBtn.addEventListener('click', () => this.addState());

        // Drag & Drop for Import
        document.body.addEventListener('dragover', (e) => e.preventDefault());
        document.body.addEventListener('drop', (e) => this.handleGlobalDrop(e));

        // Global Paste for Import
        document.addEventListener('paste', (e) => this.handlePaste(e));

        // Keyboard Handling for Preview + Binding
        window.addEventListener('keydown', (e) => this.handleKeyDown(e));
        window.addEventListener('keyup', (e) => this.handleKeyUp(e));

        // Preview Focus
        this.ui.previewContainer.addEventListener('mousedown', () => this.ui.previewContainer.focus());

        // Animation Loop
        this.lastTime = performance.now();
        requestAnimationFrame((t) => this.loop(t));
    }

    /* --- Import Logic --- */

    handleImportClick() {
        this.ui.fileInput.click();
    }

    async handleFileSelect(e) {
        const file = e.target.files[0];
        if (!file) return;
        await this.loadJsonFile(file);
        this.ui.fileInput.value = '';
    }

    async handleGlobalDrop(e) {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file && file.type === 'application/json') {
            await this.loadJsonFile(file);
        }
    }

    async handlePaste(e) {
        // Prevent default only if we handle it? 
        // If user is pasting into an input field (like state name), let them.
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        const text = e.clipboardData.getData('text');
        if (text) {
            try {
                const json = JSON.parse(text);
                // Basic validation: check if it looks like our format?
                // Our format is object with base64 strings.
                if (typeof json === 'object') {
                    this.importData(json);
                }
            } catch (err) {
                // Not JSON, ignore
            }
        }

        // Also handle file items in paste (optional)
    }

    async loadJsonFile(file) {
        try {
            const text = await file.text();
            const json = JSON.parse(text);
            this.importData(json);
        } catch (e) {
            alert("Failed to load JSON: " + e.message);
        }
    }

    importData(json) {
        // Format: { "image.png": "data...", "animName": "data:animation..." }
        let newAnims = 0;
        let foundIdleAnim = null;

        for (const [key, value] of Object.entries(json)) {
            if (typeof value === 'string') {
                if (value.startsWith('data:image')) {
                    this.data.images[key] = value;
                } else if (value.startsWith('data:animation')) {
                    // Decode
                    try {
                        const base64Content = value.substring(value.indexOf(',') + 1);
                        const decoded = atob(base64Content);
                        const sequence = JSON.parse(decoded);
                        this.data.animations[key] = sequence;
                        newAnims++;

                        if (key.toLowerCase().includes('idle')) {
                            foundIdleAnim = key;
                        }
                    } catch (e) {
                        console.error('Anim parse fail', e);
                    }
                }
            }
        }

        this.renderAnimLibrary();

        // Force refresh of runtime (to load new images)
        this.previewActor = null;

        if (newAnims > 0) {
            // Auto-create an Idle state if empty
            if (Object.keys(this.actorConfig.states).length === 0) {
                this.addState('Idle');
                // Auto-assign if we found something looking like idle
                if (foundIdleAnim) {
                    this.actorConfig.states['Idle'].animation = foundIdleAnim;
                }
            } else {
                // Check if existing Idle state needs anim
                if (this.actorConfig.states['Idle'] && !this.actorConfig.states['Idle'].animation && foundIdleAnim) {
                    this.actorConfig.states['Idle'].animation = foundIdleAnim;
                }
            }
            this.renderStateList();
        }
    }

    /* --- UI Rendering --- */

    renderAnimLibrary() {
        this.ui.animList.innerHTML = '';

        Object.keys(this.data.animations).forEach(animName => {
            const el = document.createElement('div');
            el.className = 'anim-item';
            el.draggable = true;
            el.dataset.animName = animName;

            // Thumbnail (First image of animation)
            const seq = this.data.animations[animName];
            const firstImg = seq.find(s => typeof s === 'string'); // find first string

            const img = document.createElement('img');
            if (firstImg && this.data.images[firstImg]) {
                img.src = this.data.images[firstImg];
            }

            const label = document.createElement('span');
            label.textContent = animName;

            el.appendChild(img);
            el.appendChild(label);

            el.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('application/x-anim-name', animName);
            });

            this.ui.animList.appendChild(el);
        });
    }

    renderStateList() {
        this.ui.stateList.innerHTML = '';

        Object.entries(this.actorConfig.states).forEach(([name, state]) => {
            const card = document.createElement('div');
            card.className = 'state-card';

            // Header
            const header = document.createElement('div');
            header.className = 'state-header';

            // Anim Drop Target
            const preview = document.createElement('div');
            preview.className = 'state-anim-preview';
            preview.title = 'Drop Animation Here';
            if (state.animation) {
                // Show thumb
                const seq = this.data.animations[state.animation];
                const firstImg = seq ? seq.find(s => typeof s === 'string') : null;
                if (firstImg && this.data.images[firstImg]) {
                    const img = document.createElement('img');
                    img.src = this.data.images[firstImg];
                    preview.innerHTML = '';
                    preview.appendChild(img);
                } else {
                    preview.textContent = '??';
                }
            } else {
                preview.textContent = 'None';
                preview.style.fontSize = '0.7rem';
            }

            // Drop logic
            preview.addEventListener('dragover', e => e.preventDefault());
            preview.addEventListener('drop', e => {
                e.preventDefault();
                const animName = e.dataTransfer.getData('application/x-anim-name');
                if (animName) {
                    state.animation = animName;
                    this.renderStateList();
                }
            });

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'state-name';
            nameInput.value = name;
            nameInput.onchange = (e) => {
                if (e.target.value !== name && e.target.value.trim() !== "") {
                    // Rename (Copy and Delete old)
                    this.actorConfig.states[e.target.value] = this.actorConfig.states[name];
                    delete this.actorConfig.states[name];

                    // Update transitions pointing to old name? 
                    // (Optional, but good UX: iterate all states and fix targets)
                    this.fixStateRenames(name, e.target.value);

                    this.renderStateList();
                }
            };

            const delBtn = document.createElement('button');
            delBtn.textContent = '🗑';
            delBtn.onclick = () => {
                delete this.actorConfig.states[name];
                this.renderStateList();
            };

            header.appendChild(preview);
            header.appendChild(nameInput);
            header.appendChild(delBtn);
            card.appendChild(header);

            // Transitions
            const transList = document.createElement('div');
            transList.className = 'transitions-list';

            if (state.transitions) {
                state.transitions.forEach((trans, idx) => {
                    const row = document.createElement('div');
                    row.className = 'transition-row';

                    // Conditions
                    const keyBtn = document.createElement('div');
                    keyBtn.className = 'key-binding';
                    keyBtn.textContent = this.formatCondition(trans.condition);
                    keyBtn.title = 'Click to Rebind';
                    keyBtn.onclick = () => this.startRebind(keyBtn, trans);

                    const arrow = document.createElement('span');
                    arrow.className = 'arrow';
                    arrow.innerHTML = '➞';

                    // Target State Select
                    const targetSelect = document.createElement('select');
                    this.populateStateSelect(targetSelect, trans.target);
                    targetSelect.onchange = (e) => { trans.target = e.target.value; };

                    const removeTransBtn = document.createElement('button');
                    removeTransBtn.innerHTML = '×';
                    removeTransBtn.style.padding = '0 0.4rem';
                    removeTransBtn.style.fontSize = '0.8rem';
                    removeTransBtn.onclick = () => {
                        state.transitions.splice(idx, 1);
                        this.renderStateList();
                    };

                    row.appendChild(keyBtn);
                    row.appendChild(arrow);
                    row.appendChild(targetSelect);
                    row.appendChild(removeTransBtn);
                    transList.appendChild(row);
                });
            }

            // Add Transition Button
            const addTransBtn = document.createElement('button');
            addTransBtn.innerText = '+ Add Transition';
            addTransBtn.style.fontSize = '0.8rem';
            addTransBtn.style.marginTop = '0.5rem';
            addTransBtn.onclick = () => {
                if (!state.transitions) state.transitions = [];
                state.transitions.push({ condition: [], target: name }); // Self loop by default
                this.renderStateList();
            };

            card.appendChild(transList);
            card.appendChild(addTransBtn);

            this.ui.stateList.appendChild(card);
        });
    }

    addState(name = null) {
        const newName = name || `State ${Object.keys(this.actorConfig.states).length + 1}`;
        this.actorConfig.states[newName] = {
            animation: null,
            transitions: []
        };
        this.renderStateList();
    }

    fixStateRenames(oldName, newName) {
        // Fix transitions targeting oldName
        Object.values(this.actorConfig.states).forEach(st => {
            if (st.transitions) {
                st.transitions.forEach(t => {
                    if (t.target === oldName) t.target = newName;
                });
            }
        });
        // Fix default
        if (this.actorConfig.initialState === oldName) this.actorConfig.initialState = newName;
    }

    populateStateSelect(select, currentValue) {
        select.innerHTML = '';
        Object.keys(this.actorConfig.states).forEach(s => {
            const opt = document.createElement('option');
            opt.value = s;
            opt.textContent = s;
            if (s === currentValue) opt.selected = true;
            select.appendChild(opt);
        });
    }

    formatCondition(cond) {
        if (cond === "No Input" || (Array.isArray(cond) && cond.length === 0)) return "No Input";
        if (Array.isArray(cond)) return cond.join('+');
        return String(cond);
    }

    /* --- Key Binding --- */

    startRebind(element, transition) {
        element.textContent = 'Press Keys...';
        element.classList.add('recording');

        let keysPressed = new Set();

        // We need a special handler that captures keys until released or confirmed
        // Actually simple approach:
        // Wait for first key down. Then wait for 1 second of no new keys? 
        // Or "Press Enter to confirm"?
        // Simpler: User holds keys they want (e.g. Shift+A). When they release ANY key, we commit that set?
        // Or when they press Enter? 

        // Let's do: Capture all currently held keys when a dedicated "Done" action happens?
        // User Flow: Click bind. Press 'A'. It sets to 'A'.
        // User Flow: Click bind. Press 'Shift'. Hold 'Shift', Press 'A'. It sets to 'Shift+A'.
        // Implementation: We listen to global keydown/up.

        const finish = () => {
            // Reset UI
            element.classList.remove('recording');
            this.listeningForKey = null;

            // Save
            // If empty, set to "No Input"
            if (keysPressed.size === 0) {
                transition.condition = "No Input";
            } else {
                transition.condition = Array.from(keysPressed);
            }
            this.renderStateList();
        };

        this.listeningForKey = {
            onKeyDown: (e) => {
                e.preventDefault();
                // If special key to clear? (Delete/Backspace) logic?
                if (e.key === 'Escape') {
                    keysPressed.clear(); // Clear to "No Input"
                    finish();
                    return;
                }

                // Track key
                // Use e.key but maybe normalize (Shift, Control, etc)
                // We'll use e.key values: "a", "A", "ArrowUp", "Shift"
                // For combinations, usually we want "Shift" + "a" (lowercase).
                // But e.key is "A" if shift is held.
                // Let's rely on `e.code`? Code is "KeyA".
                // Let's stick to `e.key` for simplicity but be aware of case.

                // Let's ignore repeated events
                if (e.repeat) return;

                keysPressed.add(e.key);
                element.textContent = Array.from(keysPressed).join('+');
            },
            onKeyUp: (e) => {
                // When a key is released, we take that as confirmation of the combo?
                // e.g. Press Shift (add), Press A (add), Release A (Trigger confirm)
                finish();
            }
        };
    }

    handleKeyDown(e) {
        // If binding
        if (this.listeningForKey) {
            this.listeningForKey.onKeyDown(e);
            return;
        }

        // Normal Preview Input
        // Prevent scrolling if focusing canvas
        if (document.activeElement === this.ui.previewContainer) {
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
                e.preventDefault();
            }
        }

        if (!e.repeat) {
            this.inputState[e.key] = true;
        }
    }

    handleKeyUp(e) {
        if (this.listeningForKey) {
            this.listeningForKey.onKeyUp(e);
            return;
        }
        this.inputState[e.key] = false;
    }

    /* --- Loop & Preview --- */

    loop(timestamp) {
        const dt = (timestamp - this.lastTime) / 1000;
        this.lastTime = timestamp;

        // Preview Logic
        if (!this.previewActor) {
            // Create runtime instance from current config
            // We do this every frame? No, wasteful.
            // We should stick to one instance and update its config?
            // Or recreate it only when config changes?
            // For now, let's just create it once and try to keep it synced.
            // Actually, simplest is to Recreate it every frame for "Immediate Mode" editing? 
            // - No, state would reset.

            // let's recreate it if missing
            this.refreshPreviewActor();
        } else {
            // Sync Config? 
            // The runtime uses `this.config`. If we pass reference, it sees changes.
            // But resources need to be loaded.
        }

        // Run Actor
        if (this.previewActor) {
            this.previewActor.update(dt, this.inputState);

            // Draw
            const ctx = this.previewCtx;
            ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

            // Draw grid or something
            ctx.fillStyle = '#222';
            ctx.fillRect(0, 0, 400, 400);

            this.previewActor.draw(ctx, 200, 300); // Center bottom-ish

            if (!this.previewActor.currentImage && this.previewActor.currentState) {
                ctx.fillStyle = '#666';
                ctx.font = '16px monospace';
                ctx.textAlign = 'center';
                ctx.fillText('No Animation / Empty State', 200, 200);
            }

            // Debug info
            this.ui.debugState.textContent = this.previewActor.currentState;

            const keys = Object.keys(this.inputState).filter(k => this.inputState[k]);
            this.ui.debugKeys.textContent = keys.length ? keys.join('+') : 'None';
        }

        requestAnimationFrame((t) => this.loop(t));
    }

    refreshPreviewActor() {
        // Build Full Config
        const fullConfig = {
            resources: {
                images: this.data.images,
                animations: this.data.animations
            },
            states: this.actorConfig.states,
            initialState: this.actorConfig.initialState
        };

        this.previewActor = new ActorRuntime(fullConfig);
    }

    /* --- Export --- */

    exportActor() {
        const fullConfig = {
            resources: {
                images: this.data.images,
                animations: this.data.animations
            },
            states: this.actorConfig.states,
            initialState: this.actorConfig.initialState,
            stateOrder: this.actorConfig.stateOrder // Export order meta
        };

        const str = JSON.stringify(fullConfig, null, 2);
        const blob = new Blob([str], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'actor_data.json';
        a.click();
    }
}

// Start
window.addEventListener('DOMContentLoaded', () => {
    window.app = new EditorApp();
});
