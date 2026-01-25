/**
 * Image to Base64 Converter Logic
 */

class ImageManager {
    constructor() {
        this.images = new Map(); // id -> { id, file, name, originalUrl, compressedUrl, base64, status }
        this.selectedId = null;
        this.settings = {
            quality: 0.8,
            maxWidth: null,
            maxHeight: null
        };

        this.initEventListeners();
    }

    initEventListeners() {
        // UI Inputs
        this.ui = {
            fileInput: document.getElementById('fileInput'),
            dropZone: document.getElementById('dropZone'),
            qualityRange: document.getElementById('qualityRange'),
            qualityValue: document.getElementById('qualityValue'),
            maxWidthInput: document.getElementById('maxWidthInput'),
            maxHeightInput: document.getElementById('maxHeightInput'),
            imageList: document.getElementById('imageList'),
            originalViewer: document.getElementById('originalViewer'),
            convertedViewer: document.getElementById('convertedViewer'),
            originalInfo: document.getElementById('originalInfo'),
            convertedInfo: document.getElementById('convertedInfo'),
            imageCount: document.getElementById('imageCount'),
            btnExportJson: document.getElementById('btnExportJson'),
            btnCopyJson: document.getElementById('btnCopyJson'),
            btnClearAll: document.getElementById('btnClearAll')
        };

        // Input Change Listeners
        this.ui.fileInput.addEventListener('change', (e) => this.handleFiles(e.target.files));

        // Drag & Drop
        this.ui.dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            this.ui.dropZone.classList.add('drag-over');
        });
        this.ui.dropZone.addEventListener('dragleave', () => {
            this.ui.dropZone.classList.remove('drag-over');
        });
        this.ui.dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            this.ui.dropZone.classList.remove('drag-over');
            this.handleFiles(e.dataTransfer.files);
        });

        // Paste
        document.addEventListener('paste', (e) => this.handlePaste(e));

        // Settings
        this.ui.qualityRange.addEventListener('input', (e) => {
            this.settings.quality = parseFloat(e.target.value);
            this.ui.qualityValue.textContent = this.settings.quality;
            this.recompressAll();
        });
        this.ui.maxWidthInput.addEventListener('input', (e) => {
            this.settings.maxWidth = parseInt(e.target.value) || null;
            this.recompressAll();
        });
        this.ui.maxHeightInput.addEventListener('input', (e) => {
            this.settings.maxHeight = parseInt(e.target.value) || null;
            this.recompressAll();
        });

        // Actions
        this.ui.btnExportJson.addEventListener('click', () => this.exportJson());
        this.ui.btnCopyJson.addEventListener('click', () => this.copyJson());
        this.ui.btnClearAll.addEventListener('click', () => this.clearAll());
    }

    async handleFiles(fileList) {
        if (!fileList || fileList.length === 0) return;

        for (let i = 0; i < fileList.length; i++) {
            const file = fileList[i];

            if (file.type === 'application/json') {
                await this.handleJsonImport(file);
            } else if (file.type.startsWith('image/')) {
                await this.addImage(file);
            }
        }
    }

    async handlePaste(e) {
        const items = (e.clipboardData || e.originalEvent.clipboardData).items;
        let hasHandled = false;

        // check for text (JSON)
        const textData = e.clipboardData.getData('text');
        if (textData) {
            try {
                const json = JSON.parse(textData);
                // Check if it looks like our schema
                if (typeof json === 'object') {
                    await this.importResults(json);
                    hasHandled = true;
                }
            } catch (err) {
                // Not JSON, ignore
            }
        }

        // check for images
        if (!hasHandled) {
            for (let index in items) {
                const item = items[index];
                if (item.kind === 'file' && item.type.startsWith('image/')) {
                    const blob = item.getAsFile();
                    // Generate a name for pasted image
                    const name = `pasted_image_${Date.now()}.png`;
                    const file = new File([blob], name, { type: blob.type });
                    await this.addImage(file);
                }
            }
        }
    }

    async handleJsonImport(file) {
        const text = await file.text();
        try {
            const json = JSON.parse(text);
            await this.importResults(json);
        } catch (e) {
            alert('Invalid JSON file');
            console.error(e);
        }
    }

    async importResults(json) {
        for (const [name, base64] of Object.entries(json)) {
            // For imported JSON, the base64 IS the 'original' in this context, 
            // or we treat it as source. 
            // To fit our pipeline, we can convert base64 -> Blob -> File
            try {
                const res = await fetch(base64);
                const blob = await res.blob();
                const file = new File([blob], name, { type: blob.type });
                await this.addImage(file);
            } catch (e) {
                console.error(`Failed to load image ${name}`, e);
            }
        }
    }

    async addImage(file) {
        const id = 'img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        const originalUrl = URL.createObjectURL(file);

        const imageItem = {
            id,
            file,
            name: file.name,
            originalUrl,
            compressedUrl: null,
            base64: null,
            status: 'pending',
            originalSize: file.size
        };

        this.images.set(id, imageItem);
        this.renderImageList();

        // Select this new image
        this.selectImage(id);

        // Trigger compression
        await this.processImage(id);
    }

    async processImage(id) {
        const item = this.images.get(id);
        if (!item) return;

        try {
            const result = await this.compress(item.originalUrl, item.file.type);
            item.base64 = result.base64;
            item.compressedUrl = result.base64; // Data URL can be used as src
            item.status = 'ready';

            // Calculate compressed size (rough estimate: length * 0.75 for base64)
            // Exact bytes: (length * 3) / 4 - padding
            const strLen = item.base64.indexOf(',') > -1 ? item.base64.split(',')[1].length : item.base64.length;
            item.compressedSize = (strLen * 3) / 4;

            this.updateImageStatus(id);
            if (this.selectedId === id) {
                this.updateMainView();
            }
        } catch (e) {
            console.error('Compression failed', e);
            item.status = 'error';
        }
    }

    compress(src, mimeType) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                // Scaling logic
                const maxW = this.settings.maxWidth;
                const maxH = this.settings.maxHeight;

                if (maxW && width > maxW) {
                    height *= maxW / width;
                    width = maxW;
                }
                if (maxH && height > maxH) {
                    width *= maxH / height;
                    height = maxH;
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                const quality = Math.max(0.1, Math.min(1.0, this.settings.quality));
                const base64 = canvas.toDataURL(mimeType === 'image/png' ? 'image/png' : 'image/jpeg', quality);

                resolve({ base64, width, height });
            };
            img.onerror = reject;
            img.src = src;
        });
    }

    recompressAll() {
        this.images.forEach((item, id) => {
            this.processImage(id);
        });
    }

    selectImage(id) {
        this.selectedId = id;
        this.renderImageList(); // to update active class
        this.updateMainView();
    }

    updateMainView() {
        const item = this.images.get(this.selectedId);

        // Reset
        this.ui.originalViewer.innerHTML = '';
        this.ui.convertedViewer.innerHTML = '';
        this.ui.originalInfo.textContent = '';
        this.ui.convertedInfo.textContent = '';

        if (!item) {
            this.ui.originalViewer.innerHTML = '<div class="placeholder-text">Select an image</div>';
            this.ui.convertedViewer.innerHTML = '<div class="placeholder-text">Select an image</div>';
            return;
        }

        // Show Original
        const imgOrig = document.createElement('img');
        imgOrig.src = item.originalUrl;
        this.ui.originalViewer.appendChild(imgOrig);
        this.ui.originalInfo.textContent = `${this.formatBytes(item.originalSize)}`;

        // Show Converted
        if (item.base64) {
            const imgConv = document.createElement('img');
            imgConv.src = item.base64;
            this.ui.convertedViewer.appendChild(imgConv);
            this.ui.convertedInfo.textContent = `${this.formatBytes(item.compressedSize)} (Quality: ${this.settings.quality})`;
        } else {
            this.ui.convertedViewer.innerHTML = '<div class="placeholder-text">Processing...</div>';
        }
    }

    renderImageList() {
        this.ui.imageList.innerHTML = '';
        this.images.forEach((item, id) => {
            const li = document.createElement('li');
            li.className = `image-list-item ${id === this.selectedId ? 'active' : ''}`;
            li.onclick = () => this.selectImage(id);

            const nameSpan = document.createElement('span');
            nameSpan.className = 'item-name';
            nameSpan.textContent = item.name;
            nameSpan.title = item.name;

            const statusDiv = document.createElement('div');
            statusDiv.className = `item-status ${item.status === 'ready' ? 'ready' : ''}`;

            li.appendChild(nameSpan);
            li.appendChild(statusDiv);
            this.ui.imageList.appendChild(li);
        });
        this.ui.imageCount.textContent = this.images.size;
    }

    updateImageStatus(id) {
        // Optimally just update the status indicator for the specific item
        // But for simplicity calling renderImageList is fine for now unless huge list
        this.renderImageList();
    }

    exportJson() {
        const output = {};
        this.images.forEach((item) => {
            if (item.base64) {
                output[item.name] = item.base64;
            }
        });

        const blob = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'images_base64.json';
        a.click();
    }

    copyJson() {
        const output = {};
        this.images.forEach((item) => {
            if (item.base64) {
                output[item.name] = item.base64;
            }
        });

        const str = JSON.stringify(output, null, 2);
        navigator.clipboard.writeText(str).then(() => {
            const originalText = this.ui.btnCopyJson.textContent;
            this.ui.btnCopyJson.textContent = 'Copied!';
            setTimeout(() => {
                this.ui.btnCopyJson.textContent = originalText;
            }, 2000);
        });
    }

    clearAll() {
        this.images.clear();
        this.selectedId = null;
        this.renderImageList();
        this.updateMainView();
        // clear file input
        this.ui.fileInput.value = '';
    }

    formatBytes(bytes, decimals = 2) {
        if (!bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    window.app = new ImageManager();
});

/* 
 * ==========================================================================
 *  REUSABLE LOADER FUNCTION 
 *  Copy this function into your other projects (WebGL, Canvas, etc.)
 *  to easily load the JSON exported by this tool.
 * ==========================================================================
 */

/**
 * Loads images from a standard JSON object {"name": "base64", ...}
 * @param {Object} jsonContent - The JSON object containing "filename": "base64" pairs
 * @returns {Promise<Object>} - A promise that resolves to a map of { filename: ImageElement }
 */
async function loadGameAssets(jsonContent) {
    const images = {};
    const promises = [];

    for (const [name, base64] of Object.entries(jsonContent)) {
        const p = new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve({ name, img });
            img.onerror = reject;
            // Use the base64 string directly as source
            img.src = base64;
        });
        promises.push(p);
    }

    const results = await Promise.all(promises);
    results.forEach(item => images[item.name] = item.img);
    return images;
}
