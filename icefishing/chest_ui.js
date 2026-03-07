// chest_ui.js — Shared UI for Chest and Tombstone inventory
const ChestUI = {
    isOpen: false,
    currentChest: null,  // reference to a chest or tombstone object
    isLocked: false,     // tombstone mode: can take but not place items
    isTombstone: false,  // track if it's a tombstone for auto-destroy

    COLS: 8,
    ROWS: 5,

    // UI bounds for click detection
    ui: { x: 0, y: 0, w: 0, h: 0 },

    open(container, locked = false, isTombstone = false) {
        this.currentChest = container;
        this.isLocked = locked;
        this.isTombstone = isTombstone;
        this.isOpen = true;
        Inventory.isOpen = true; // open inventory alongside
    },

    close() {
        this.isOpen = false;
        this.currentChest = null;
        this.isLocked = false;
        this.isTombstone = false;
    },

    // Check if tombstone is empty and auto-destroy
    checkTombstoneEmpty() {
        if (!this.isTombstone || !this.currentChest) return;
        const hasItems = this.currentChest.inventory.some(item => item !== null);
        if (!hasItems) {
            // Remove tombstone from world
            World.removeTombstoneNear(this.currentChest.x);
            Game.showMessage('The tombstone crumbles away.', 2);
            this.close();
        }
    },

    handleMouseDown(mouseX, mouseY, canvasW, canvasH, shiftKey = false, ctrlKey = false, button = 0) {
        if (!this.isOpen || !this.currentChest) return false;

        const slotSize = 52;
        const gap = 4;
        const totalW = this.COLS * (slotSize + gap);
        const totalH = this.ROWS * (slotSize + gap) + 30;
        const startX = (canvasW - totalW) / 2;
        const startY = 30; // chest UI at top of screen

        for (let row = 0; row < this.ROWS; row++) {
            for (let col = 0; col < this.COLS; col++) {
                const sx = startX + col * (slotSize + gap);
                const sy = startY + 30 + row * (slotSize + gap);
                if (mouseX >= sx && mouseX < sx + slotSize && mouseY >= sy && mouseY < sy + slotSize) {
                    const idx = row * this.COLS + col;
                    if (this.currentChest.inventory[idx]) {
                        const item = this.currentChest.inventory[idx];
                        if (button === 2) {
                            // Right click: move to second hand
                            this.currentChest.inventory[idx] = null;
                            Inventory.moveToSecondHand(item);
                            this.checkTombstoneEmpty();
                            return true;
                        }
                        // Left click: pick up for drag
                        if (item.stackable && item.count > 1 && (shiftKey || ctrlKey)) {
                            let takeCount = ctrlKey ? 1 : Math.max(1, Math.floor(item.count / 2));
                            Inventory.dragItem = { ...item, count: takeCount };
                            item.count -= takeCount;
                            Inventory.dragSource = { type: 'chest', idx, locked: this.isLocked };
                        } else {
                            Inventory.dragItem = item;
                            this.currentChest.inventory[idx] = null;
                            Inventory.dragSource = { type: 'chest', idx, locked: this.isLocked };
                        }
                        this.checkTombstoneEmpty();
                        return true;
                    }
                    // Clicked empty slot in chest
                    return true;
                }
            }
        }

        // Check if click is within the UI panel area
        if (mouseX >= startX - 15 && mouseX <= startX + totalW + 15 && mouseY >= startY - 15 && mouseY <= startY + totalH + 30) {
            return true;
        }

        return false;
    },

    handleMouseUp(mouseX, mouseY, canvasW, canvasH) {
        if (!this.isOpen || !this.currentChest || !Inventory.dragItem) return false;

        const slotSize = 52;
        const gap = 4;
        const startX = (canvasW - this.COLS * (slotSize + gap)) / 2;
        const startY = 30;

        for (let row = 0; row < this.ROWS; row++) {
            for (let col = 0; col < this.COLS; col++) {
                const sx = startX + col * (slotSize + gap);
                const sy = startY + 30 + row * (slotSize + gap);
                if (mouseX >= sx && mouseX < sx + slotSize && mouseY >= sy && mouseY < sy + slotSize) {
                    const idx = row * this.COLS + col;

                    // If locked (tombstone), prevent placing items IN
                    if (this.isLocked) {
                        // Only allow putting back to original slot if dragged FROM this chest
                        if (Inventory.dragSource && Inventory.dragSource.type === 'chest' && Inventory.dragSource.idx === idx) {
                            // Allow putting back
                        } else {
                            Game.showMessage("Cannot place items in the tombstone!", 1.5);
                            return true;
                        }
                    }

                    // Stack if same item
                    if (this.currentChest.inventory[idx] && this.currentChest.inventory[idx].id === Inventory.dragItem.id && Inventory.dragItem.stackable) {
                        const space = this.currentChest.inventory[idx].maxStack - this.currentChest.inventory[idx].count;
                        const add = Math.min(Inventory.dragItem.count, space);
                        this.currentChest.inventory[idx].count += add;
                        Inventory.dragItem.count -= add;
                        if (Inventory.dragItem.count <= 0) {
                            Inventory.dragItem = null;
                            Inventory.dragSource = null;
                            return true;
                        }
                    }

                    // Swap or place
                    const temp = this.currentChest.inventory[idx];
                    this.currentChest.inventory[idx] = Inventory.dragItem;
                    Inventory.dragItem = temp;

                    if (Inventory.dragItem) {
                        Inventory.dragSource = { type: 'chest', idx, locked: this.isLocked };
                    } else {
                        Inventory.dragSource = null;
                    }
                    return true;
                }
            }
        }

        return false;
    },

    render(ctx, canvasW, canvasH) {
        if (!this.isOpen || !this.currentChest) return;

        const slotSize = 52;
        const gap = 4;
        const totalW = this.COLS * (slotSize + gap);
        const totalH = this.ROWS * (slotSize + gap) + 30;
        const startX = (canvasW - totalW) / 2;
        const startY = 30;
        const panelPad = 15;

        // Panel background
        ctx.fillStyle = this.isTombstone ? '#2a1a1a' : '#1a2a14';
        ctx.strokeStyle = this.isTombstone ? '#884444' : '#4a8a3a';
        ctx.lineWidth = 2;
        ctx.fillRect(startX - panelPad, startY - panelPad, totalW + panelPad * 2, totalH + panelPad * 2);
        ctx.strokeRect(startX - panelPad, startY - panelPad, totalW + panelPad * 2, totalH + panelPad * 2);

        // Title
        ctx.fillStyle = this.isTombstone ? '#cc8888' : '#88cc88';
        ctx.font = '16px monospace';
        ctx.fillText(this.isTombstone ? 'TOMBSTONE' : 'CHEST', startX, startY + 20);

        if (this.isLocked) {
            ctx.fillStyle = '#ff8888';
            ctx.font = '10px monospace';
            ctx.fillText('(Take only)', startX + 110, startY + 20);
        }

        // Slots
        for (let row = 0; row < this.ROWS; row++) {
            for (let col = 0; col < this.COLS; col++) {
                const x = startX + col * (slotSize + gap);
                const y = startY + 30 + row * (slotSize + gap);
                const idx = row * this.COLS + col;

                ctx.fillStyle = this.isLocked ? 'rgba(50,30,30,0.8)' : 'rgba(40,50,30,0.8)';
                ctx.fillRect(x, y, slotSize, slotSize);
                ctx.strokeStyle = this.isLocked ? 'rgba(120,60,60,0.6)' : 'rgba(60,100,40,0.6)';
                ctx.lineWidth = 1;
                ctx.strokeRect(x, y, slotSize, slotSize);

                if (this.currentChest.inventory[idx]) {
                    Inventory.renderItemIcon(ctx, this.currentChest.inventory[idx], x + 6, y + 6, slotSize - 12);
                }
            }
        }

        // Store UI bounds
        this.ui.x = startX - panelPad;
        this.ui.y = startY - panelPad;
        this.ui.w = totalW + panelPad * 2;
        this.ui.h = totalH + panelPad * 2;
    }
};
