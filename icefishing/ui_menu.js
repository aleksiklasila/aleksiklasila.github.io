// ui_menu.js - Generic utility for rendering standardized menus

const UIMenu = {
    activeMenu: null,

    // Shared dimensions
    width: 620,
    height: 320,
    slotSize: 52,
    gap: 4,

    // Define colors used globally for menus
    colors: {
        bg: '#141e32',
        border: '#6496c8',
        title: '#99ccff',
        text: '#ececec',
        slotBg: 'rgba(40,50,70,0.8)',
        slotBorder: 'rgba(100,150,200,0.5)'
    },

    // Check if any menu is occupying UI space
    isOpen() {
        return this.activeMenu !== null;
    },

    // Get bounds for inventory to position itself below the menu
    getActiveMenuBounds() {
        if (!this.isOpen()) return null;
        return {
            x: this.activeMenu.x,
            y: this.activeMenu.y,
            w: this.activeMenu.w,
            h: this.activeMenu.h
        };
    },

    // Helper to calculate Y position to bottom-align with a 100px margin
    calculateYPosition(canvasW, canvasH) {
        return canvasH - this.height - 100;
    },

    renderMenuBase(ctx, canvasW, canvasH, title, sourceObject) {
        // Center the combined unit (Inventory + Gap + Menu)
        // Inventory Width = 448, Gap = 20, Menu Width = 620
        const invTotalW = 448;
        const combinedW = invTotalW + 20 + this.width;
        const invStartX = (canvasW - combinedW) / 2;

        const x = invStartX + invTotalW + 20;
        const y = this.calculateYPosition(canvasW, canvasH);

        // Save bounds to active menu tracking
        this.activeMenu = { x, y, w: this.width, h: this.height };
        if (sourceObject && sourceObject.ui) {
            sourceObject.ui.x = x;
            sourceObject.ui.y = y;
            sourceObject.ui.w = this.width;
            sourceObject.ui.h = this.height;
        }

        // Background
        ctx.fillStyle = this.colors.bg;
        ctx.strokeStyle = this.colors.border;
        ctx.lineWidth = 3;
        ctx.fillRect(x, y, this.width, this.height);
        ctx.strokeRect(x, y, this.width, this.height);

        // Title
        ctx.fillStyle = this.colors.title;
        ctx.font = 'bold 20px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(title.toUpperCase(), x + this.width / 2, y + 25);
        ctx.textAlign = 'left';

        return { x, y, w: this.width, h: this.height };
    },

    // Renders a grid on the left side of the menu (like items for sale, or recipes)
    // Left side takes up a specific portion of the width
    renderLeftGrid(ctx, bounds, label, items, renderItemCallback) {
        const { x, y, w, h } = bounds;

        ctx.fillStyle = this.colors.text;
        ctx.font = '14px monospace';
        ctx.fillText(label, x + 15, y + 55);

        const itemsPerRow = 8;
        const slotsBounds = []; // Array of slot positions for clicking

        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            const row = Math.floor(i / itemsPerRow);
            const col = i % itemsPerRow;

            const sx = x + 15 + col * (this.slotSize + this.gap);
            const sy = y + 70 + row * (this.slotSize + this.gap + 25);

            // Slot BG
            ctx.fillStyle = this.colors.slotBg;
            ctx.fillRect(sx, sy, this.slotSize, this.slotSize);
            ctx.strokeStyle = this.colors.slotBorder;
            ctx.lineWidth = 1;
            ctx.strokeRect(sx, sy, this.slotSize, this.slotSize);

            // Pass execution to callback to customize the innards (prices, red shade, etc)
            renderItemCallback(ctx, item, i, sx, sy, this.slotSize);

            slotsBounds.push({ x: sx, y: sy, w: this.slotSize, h: this.slotSize, index: i, item: item });
        }

        return slotsBounds;
    },

    // Renders the right bounding area block for interactions (selling/repairing)
    renderRightPanel(ctx, bounds, label, subLabel) {
        const { x, y, w, h } = bounds;
        const rx = x + w - 160;

        ctx.fillStyle = 'rgba(20,30,50,0.6)';
        ctx.fillRect(rx, y + 50, 145, h - 65);

        ctx.fillStyle = '#ddd';
        ctx.font = '14px monospace';
        ctx.fillText(label, rx + 15, y + 75);

        ctx.fillStyle = '#888';
        ctx.font = '10px monospace';
        ctx.fillText(subLabel, rx + 15, y + 90);

        return { rx, ry: y + 50, rw: 145, rh: h - 65 };
    },

    // Helper to draw the action slot inside the Right Panel
    renderActionSlot(ctx, panelBounds, slotSize) {
        const { rx, ry, rw, rh } = panelBounds;
        const ssx = rx + (rw - slotSize) / 2;
        const ssy = ry + 50;

        ctx.fillStyle = 'rgba(10,15,25,0.8)';
        ctx.fillRect(ssx, ssy, slotSize, slotSize);
        ctx.strokeStyle = this.colors.border;
        ctx.lineWidth = 2;
        ctx.strokeRect(ssx, ssy, slotSize, slotSize);

        return { x: ssx, y: ssy, w: slotSize, h: slotSize };
    },

    // Helper to draw standard interaction button beneath action slot
    renderActionButton(ctx, panelBounds, slotY, slotSize, label, colorHex) {
        const { rx, ry, rw, rh } = panelBounds;
        const btnW = 80;
        const btnH = 24;
        const btnX = rx + (rw - btnW) / 2;
        const btnY = slotY + slotSize + 20;

        ctx.fillStyle = colorHex;
        ctx.fillRect(btnX, btnY, btnW, btnH);
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(btnX, btnY, btnW, btnH);

        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(label, btnX + btnW / 2, btnY + 17);
        ctx.textAlign = 'left';

        return { x: btnX, y: btnY, w: btnW, h: btnH };
    }
};
