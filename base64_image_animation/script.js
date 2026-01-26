/**
 * Base64 Animation Studio
 * Logic for composing animations from base64 images.
 */

class AnimationStudio {
    constructor() {
        this.images = new Map(); // name -> base64
        this.tracks = []; // Array<{ id, name, items: [] }>
        // item: { type: 'image' | 'sleep', value: string | number, id: unique_id }

        this.initEventListeners();
    }

    initEventListeners() {
        // UI Elements
        this.ui = {
            dropZone: document.getElementById('dropZone'),
            fileInput: document.getElementById('fileInput'),
            imageGrid: document.getElementById('imageGrid'),
            assetCount: document.getElementById('assetCount'),
            tracksContainer: document.getElementById('tracksContainer'),
            noTracksMsg: document.getElementById('noTracksMsg'),
            btnAddTrack: document.getElementById('btnAddTrack'),
            btnExportJson: document.getElementById('btnExportJson'),
            btnCopyJson: document.getElementById('btnCopyJson'),
            btnClearAll: document.getElementById('btnClearAll'),

            // Preview
            previewOverlay: document.getElementById('previewOverlay'),
            previewImage: document.getElementById('previewImage'),
            previewTitle: document.getElementById('previewTitle'),
            previewFrameIdx: document.getElementById('previewFrameIdx'),
            previewTotalFrames: document.getElementById('previewTotalFrames'),
            btnClosePreview: document.getElementById('btnClosePreview'),
        };

        // File Import
        this.ui.fileInput.addEventListener('change', (e) => this.handleFiles(e.target.files));

        // Drag & Drop Import
        this.ui.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); this.ui.dropZone.classList.add('drag-over'); });
        this.ui.dropZone.addEventListener('dragleave', () => this.ui.dropZone.classList.remove('drag-over'));
        this.ui.dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            this.ui.dropZone.classList.remove('drag-over');
            this.handleFiles(e.dataTransfer.files);
        });

        // Paste
        document.addEventListener('paste', (e) => this.handlePaste(e));

        // Buttons
        this.ui.btnAddTrack.addEventListener('click', () => this.addTrack());
        this.ui.btnClearAll.addEventListener('click', () => this.clearAll());
        this.ui.btnExportJson.addEventListener('click', () => this.exportJson());
        this.ui.btnCopyJson.addEventListener('click', () => this.copyJson());

        // Preview Close
        this.ui.btnClosePreview.addEventListener('click', () => this.stopPreview());
    }

    /* --- File Handling --- */

    async handleFiles(fileList) {
        if (!fileList || fileList.length === 0) return;

        for (const file of fileList) {
            if (file.type === 'application/json') {
                await this.loadJsonFile(file);
            } else if (file.type.startsWith('image/')) {
                await this.loadImageFile(file);
            }
        }
    }

    async handlePaste(e) {
        const textData = e.clipboardData.getData('text');
        if (textData) {
            try {
                const json = JSON.parse(textData);
                this.importData(json);
                return;
            } catch (e) { } // not json
        }

        // Check for image items
        const items = e.clipboardData.items;
        for (const item of items) {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                await this.loadImageFile(file);
            }
        }
    }

    async loadJsonFile(file) {
        const text = await file.text();
        try {
            const json = JSON.parse(text);
            this.importData(json);
        } catch (e) {
            alert('Invalid JSON');
        }
    }

    async loadImageFile(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            this.images.set(file.name, e.target.result);
            this.renderAssetLibrary();
        };
        reader.readAsDataURL(file);
    }

    importData(json) {
        // 1. Load Images
        // 2. Load Tracks

        let loadedTracks = 0;

        for (const [key, value] of Object.entries(json)) {
            if (key.startsWith('data:animation')) continue; // Skip raw animation strings if they are at top level (unlikely based on my plan, but good safety)

            if (typeof value === 'string' && value.startsWith('data:image')) {
                this.images.set(key, value);
            } else if (typeof value === 'string' && value.startsWith('data:animation')) {
                // Decode animation
                try {
                    const base64Content = value.substring(value.indexOf(',') + 1);
                    const decoded = atob(base64Content);
                    const sequence = JSON.parse(decoded);
                    // Format: ["img1", 0.04, "img2", ...]
                    this.importTrack(key, sequence);
                    loadedTracks++;
                } catch (e) {
                    console.error("Failed to parse animation " + key, e);
                }
            } else if (Array.isArray(value)) {
                // Support legacy/plan array format if we want, or user's specific format
                // The user's request said export as data:animation...
                // But import might see Arrays if manually edited? 
                // Let's support Array too just in case.
                this.importTrack(key, value);
                loadedTracks++;
            }
        }

        this.renderAssetLibrary();
        if (loadedTracks > 0) this.renderTracks();
    }

    importTrack(name, sequence) {
        // Convert ["img", 0.04] -> internal track format
        const items = [];
        for (const part of sequence) {
            if (typeof part === 'string') {
                if (this.images.has(part)) {
                    items.push({
                        id: Math.random().toString(36).substr(2),
                        type: 'image',
                        value: part
                    });
                } else {
                    console.warn(`Track ${name} references missing image ${part}`);
                    // Still add it? Maybe with placeholder
                    items.push({
                        id: Math.random().toString(36).substr(2),
                        type: 'image',
                        value: part, // missing
                        missing: true
                    });
                }
            } else if (typeof part === 'number' || !isNaN(parseFloat(part))) {
                items.push({
                    id: Math.random().toString(36).substr(2),
                    type: 'sleep',
                    value: parseFloat(part)
                });
            }
        }

        const track = {
            id: Math.random().toString(36).substr(2),
            name: name,
            items: items
        };
        this.tracks.push(track);
    }

    /* --- UI Rendering --- */

    renderAssetLibrary() {
        this.ui.imageGrid.innerHTML = '';
        this.ui.assetCount.textContent = this.images.size;

        this.images.forEach((base64, name) => {
            const div = document.createElement('div');
            div.className = 'image-item';
            div.draggable = true;

            const img = document.createElement('img');
            img.src = base64;

            const label = document.createElement('div');
            label.className = 'label';
            label.textContent = name;
            label.title = name;

            div.appendChild(img);
            div.appendChild(label);

            // Drag Events
            div.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('application/x-image-name', name);
                e.dataTransfer.effectAllowed = 'copy';
            });

            this.ui.imageGrid.appendChild(div);
        });
    }

    renderTracks() {
        this.ui.tracksContainer.innerHTML = '';
        if (this.tracks.length === 0) {
            this.ui.tracksContainer.appendChild(this.ui.noTracksMsg);
            return;
        }

        this.tracks.forEach((track, index) => {
            const trackEl = this.createTrackElement(track, index);
            this.ui.tracksContainer.appendChild(trackEl);
        });
    }

    createTrackElement(track, index) {
        const el = document.createElement('div');
        el.className = 'track';
        el.dataset.trackId = track.id;

        // Header
        const header = document.createElement('div');
        header.className = 'track-header';

        const nameGroup = document.createElement('div');
        nameGroup.className = 'track-name-inputs';
        const nameInput = document.createElement('input');
        nameInput.className = 'track-name';
        nameInput.value = track.name;
        nameInput.addEventListener('change', (e) => { track.name = e.target.value; });
        nameGroup.appendChild(nameInput);

        const controls = document.createElement('div');
        controls.className = 'track-controls';

        const btnPlay = document.createElement('button');
        btnPlay.className = 'btn btn-secondary btn-icon';
        btnPlay.innerHTML = '▶';
        btnPlay.title = 'Preview Track';
        btnPlay.onclick = () => this.playTrack(track);

        const btnDelete = document.createElement('button');
        btnDelete.className = 'btn btn-danger btn-icon';
        btnDelete.innerHTML = '🗑';
        btnDelete.title = 'Delete Track';
        btnDelete.onclick = () => {
            this.tracks.splice(index, 1);
            this.renderTracks();
        };

        controls.appendChild(btnPlay);
        controls.appendChild(btnDelete);

        header.appendChild(nameGroup);
        header.appendChild(controls);

        // Timeline
        const timeline = document.createElement('div');
        timeline.className = 'track-timeline';

        // Render Items
        track.items.forEach((item, itemIdx) => {
            const itemEl = this.createTimelineItem(item, track, itemIdx);
            timeline.appendChild(itemEl);
        });

        // Drop Logic
        timeline.addEventListener('dragover', (e) => {
            e.preventDefault();
            timeline.classList.add('drag-over');
        });
        timeline.addEventListener('dragleave', () => timeline.classList.remove('drag-over'));
        timeline.addEventListener('drop', (e) => {
            e.preventDefault();
            timeline.classList.remove('drag-over');
            const imageName = e.dataTransfer.getData('application/x-image-name');
            if (imageName && this.images.has(imageName)) {
                this.addItemToTrack(track, imageName);
            }
        });

        el.appendChild(header);
        el.appendChild(timeline);
        return el;
    }

    createTimelineItem(item, track, index) {
        const el = document.createElement('div');
        el.className = 'timeline-item';

        if (item.type === 'image') {
            const imgDiv = document.createElement('div');
            imgDiv.className = 'timeline-image';

            const img = document.createElement('img');
            // If missing, show placeholder? but for now rely on map
            img.src = this.images.get(item.value) || ''; // Empty if missing
            if (!this.images.has(item.value)) {
                img.alt = 'MISSING: ' + item.value;
            }

            const label = document.createElement('span');
            label.textContent = item.value;

            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-btn';
            removeBtn.innerHTML = '×';
            removeBtn.onclick = () => {
                // Check if next item is sleep
                const nextItem = track.items[index + 1];
                if (nextItem && nextItem.type === 'sleep') {
                    track.items.splice(index, 2);
                } else {
                    track.items.splice(index, 1);
                }
                this.renderTracks();
            };

            imgDiv.appendChild(img);
            imgDiv.appendChild(label);
            imgDiv.appendChild(removeBtn);
            el.appendChild(imgDiv);

            // Arrow after image if not last? 
            // Actually sequence is Img -> Sleep -> Img
            // But visually they are side by side.

        } else if (item.type === 'sleep') {
            const sleepDiv = document.createElement('div');
            sleepDiv.className = 'timeline-sleep';

            const arrow = document.createElement('div');
            arrow.className = 'timeline-arrow';
            arrow.innerHTML = '→';

            const input = document.createElement('input');
            input.type = 'number';
            input.step = '0.01';
            input.value = item.value;
            input.title = "Duration (seconds)";
            input.onchange = (e) => {
                let val = parseFloat(e.target.value);
                if (val < 0) val = 0;
                item.value = val;
            };

            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-btn';
            removeBtn.innerHTML = '×';
            removeBtn.style.position = 'relative'; // inline for sleep
            removeBtn.style.top = '0';
            removeBtn.style.right = '0';
            removeBtn.style.background = 'transparent';
            removeBtn.style.color = 'var(--danger-color)';
            removeBtn.style.opacity = '0.5';

            removeBtn.onclick = () => {
                track.items.splice(index, 1);
                this.renderTracks();
            };


            sleepDiv.appendChild(arrow);
            sleepDiv.appendChild(input);
            // sleepDiv.appendChild(removeBtn); // Maybe skip removing sleep easily to avoid breaking flow? 
            // Actually user can just drag new image.

            el.appendChild(sleepDiv);
        }

        return el;
    }

    addItemToTrack(track, imageName) {
        // Add Image
        track.items.push({
            id: Math.random().toString(36).substr(2),
            type: 'image',
            value: imageName
        });

        // Add default sleep (1/24)
        track.items.push({
            id: Math.random().toString(36).substr(2),
            type: 'sleep',
            value: 0.04166666
        });

        this.renderTracks();
    }

    addTrack() {
        const name = `Track ${this.tracks.length + 1}`;
        this.tracks.push({
            id: Math.random().toString(36).substr(2),
            name: name,
            items: []
        });
        this.renderTracks();
    }

    clearAll() {
        if (confirm('Clear all assets and tracks?')) {
            this.images.clear();
            this.tracks = [];
            this.renderAssetLibrary();
            this.renderTracks();
        }
    }

    /* --- Preview --- */

    async playTrack(track) {
        this.isPreviewing = true;
        this.ui.previewOverlay.classList.remove('hidden');
        this.ui.previewTitle.textContent = `Preview: ${track.name}`;

        // Extract sequence: pair of [Image, Duration]
        // But our structure is flat list.

        let frames = [];
        // Flatten logic: 
        // Iterate items. If Image, set as current image. If Sleep, wait that time.
        // If Image follows Image immediately? Show first one for 0 time? No, usually sleep follows.
        // We will just execute the instructions in order.

        // Validate
        if (track.items.length === 0) {
            this.ui.previewImage.src = '';
            return;
        }

        // Loop animation
        while (this.isPreviewing) {
            let processed = 0;
            for (let i = 0; i < track.items.length; i++) {
                if (!this.isPreviewing) break;

                const item = track.items[i];

                this.ui.previewFrameIdx.textContent = i + 1;
                this.ui.previewTotalFrames.textContent = track.items.length;

                if (item.type === 'image') {
                    const base64 = this.images.get(item.value);
                    if (base64) {
                        this.ui.previewImage.src = base64;
                    }
                } else if (item.type === 'sleep') {
                    // Wait
                    const ms = item.value * 1000;
                    if (ms > 0) {
                        await new Promise(r => setTimeout(r, ms));
                    }
                }

                processed++;
            }
            // If just finished track and still previewing, loop. 
            // Add a small sanity delay if track is empty or zero duration to prevent freeze?
            // If track has no sleeps, it will blast at infinite speed. 
            // Add forced 1 frame delay at minimum.
            await new Promise(r => requestAnimationFrame(r));
        }
    }

    stopPreview() {
        this.isPreviewing = false;
        this.ui.previewOverlay.classList.add('hidden');
    }

    /* --- Export --- */

    exportJson() {
        const output = {};

        // 1. Add all images
        this.images.forEach((val, key) => {
            output[key] = val;
        });

        // 2. Add tracks
        this.tracks.forEach(track => {
            // Convert items to run array
            const run = [];
            track.items.forEach(item => {
                run.push(item.value);
            });

            // Encode to base64 json
            const jsonStr = JSON.stringify(run);
            const base64 = btoa(jsonStr);
            const dataUri = `data:animation;base64,${base64}`;

            output[track.name] = dataUri;
        });

        const blob = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'animation_project.json';
        a.click();
    }

    copyJson() {
        const output = {};

        // 1. Add all images
        this.images.forEach((val, key) => {
            output[key] = val;
        });

        // 2. Add tracks
        this.tracks.forEach(track => {
            const run = [];
            track.items.forEach(item => {
                // item.value is string (image name) or number (sleep)
                run.push(item.value);
            });
            const jsonStr = JSON.stringify(run);
            const base64 = btoa(jsonStr);
            const dataUri = `data:animation;base64,${base64}`;
            output[track.name] = dataUri;
        });

        const str = JSON.stringify(output, null, 2);
        navigator.clipboard.writeText(str).then(() => {
            const orig = this.ui.btnCopyJson.textContent;
            this.ui.btnCopyJson.textContent = 'Copied!';
            setTimeout(() => this.ui.btnCopyJson.textContent = orig, 2000);
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.app = new AnimationStudio();
});
