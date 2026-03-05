// repair_shop.js — Handles the Repair Station Interface
const RepairShop = {
    isOpen: false,

    // The item currently placed in the repair slot
    repairSlot: null,

    // UI bounds for click detection
    ui: {
        x: 0, y: 0, w: 0, h: 0,
        repairSlotBounds: null,
        repairButtonBounds: null
    },

    init() {
        this.isOpen = false;
        this.repairSlot = null;
    },

    toggle() {
        if (!this.isOpen) {
            // Check if player is near the repair shop building
            if (World.repairShop && Math.abs(Player.x - World.repairShop.x) < 100) {
                this.isOpen = true;
                Inventory.isOpen = true; // Open inventory so player can drag items
                Game.showMessage('Welcome to the Repair Station!', 2);
            } else {
                Game.showMessage('You are too far from the repair station!', 1.5);
            }
        } else {
            this.close();
        }
    },

    close() {
        this.isOpen = false;
        // Return item in repair slot to inventory
        if (this.repairSlot) {
            if (!Inventory.addItem(this.repairSlot.id, this.repairSlot.count, this.repairSlot.durability)) {
                let forced = false;
                for (let i = 0; i < Inventory.BAG_SIZE; i++) {
                    if (!Inventory.bag[i]) {
                        Inventory.bag[i] = this.repairSlot;
                        forced = true; break;
                    }
                }
                if (!forced) Game.showMessage('Inventory full! Item lost!', 2);
            }
            this.repairSlot = null;
        }
    },

    handleMouseDown(mouseX, mouseY, canvasW, canvasH) {
        if (!this.isOpen) return false;

        // Check if clicked the Repair button
        if (this.ui.repairButtonBounds) {
            const b = this.ui.repairButtonBounds;
            if (mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h) {
                this.repairItem();
                return true;
            }
        }

        // Check if clicked Repair Slot to pick up item
        if (this.ui.repairSlotBounds) {
            const b = this.ui.repairSlotBounds;
            if (mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h) {
                if (this.repairSlot) {
                    // Pick up item from repair slot
                    Inventory.dragItem = this.repairSlot;
                    Inventory.dragSource = { type: 'repair_shop' };
                    this.repairSlot = null;
                    return true;
                }
            }
        }

        return false;
    },

    handleMouseUp(mouseX, mouseY, canvasW, canvasH) {
        if (!this.isOpen || !Inventory.dragItem) return false;

        if (this.ui.repairSlotBounds) {
            const b = this.ui.repairSlotBounds;
            if (mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h) {

                // Swap or place
                const temp = this.repairSlot;
                this.repairSlot = Inventory.dragItem;
                Inventory.dragItem = temp;

                if (Inventory.dragItem) {
                    Inventory.dragSource = { type: 'repair_shop' };
                } else {
                    Inventory.dragSource = null;
                }
                return true;
            }
        }

        return false;
    },

    repairItem() {
        if (!this.repairSlot) return;

        const def = Inventory.ITEMS[this.repairSlot.id];
        if (!def.maxDurability) {
            Game.showMessage('This item cannot be repaired.', 2);
            return;
        }

        if (this.repairSlot.durability >= def.maxDurability) {
            Game.showMessage('Item is already fully repaired.', 2);
            return;
        }

        const salePrice = Math.floor(def.price * 0.75);
        let repairCost = Math.floor(salePrice / 4);
        if (repairCost <= 0) repairCost = 1; // Minimum cost of $1

        if (Player.money >= repairCost) {
            Player.money -= repairCost;
            this.repairSlot.durability = def.maxDurability;
            Game.showMessage(`${def.name} repaired for $${repairCost}!`, 2);
        } else {
            Game.showMessage(`Not enough money! Need $${repairCost}.`, 2);
        }
    },

    render(ctx, canvasW, canvasH) {
        if (!this.isOpen) return;

        const w = 240;
        const h = 180;

        const slotSize = 52;
        const gap = 4;
        const bagCols = 8;
        const bagRows = 3;
        const inventoryH = (bagRows + 1) * (slotSize + gap) + 60;
        const invStartY = (canvasH - inventoryH) / 2;

        const x = (canvasW - w) / 2;
        const y = Math.max(20, invStartY - h - 30);

        this.ui.x = x;
        this.ui.y = y;
        this.ui.w = w;
        this.ui.h = h;

        // Background
        ctx.fillStyle = '#1e3214'; // Darker green solid color
        ctx.strokeStyle = '#64c864';
        ctx.lineWidth = 3;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);

        // Title
        ctx.fillStyle = '#99ff99';
        ctx.font = 'bold 20px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('REPAIR STATION', x + w / 2, y + 25);
        ctx.textAlign = 'left';

        ctx.fillStyle = '#ddd';
        ctx.font = '14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Fix broken tools', x + w / 2, y + 55);

        ctx.fillStyle = '#888';
        ctx.font = '10px monospace';
        ctx.fillText('(Drag item here)', x + w / 2, y + 70);
        ctx.textAlign = 'left';

        // Repair Slot
        const repairSlotSize = 48;
        const rx = x + (w - repairSlotSize) / 2;
        const ry = y + 80;

        this.ui.repairSlotBounds = { x: rx, y: ry, w: repairSlotSize, h: repairSlotSize };

        ctx.fillStyle = 'rgba(10,25,10,0.8)';
        ctx.fillRect(rx, ry, repairSlotSize, repairSlotSize);
        ctx.strokeStyle = '#64c864';
        ctx.lineWidth = 2;
        ctx.strokeRect(rx, ry, repairSlotSize, repairSlotSize);

        if (this.repairSlot) {
            Inventory.renderItemIcon(ctx, this.repairSlot, rx + 8, ry + 8, repairSlotSize - 16);

            const def = Inventory.ITEMS[this.repairSlot.id];

            // Repair button
            const btnW = 90;
            const btnH = 24;
            const btnX = x + (w - btnW) / 2;
            const btnY = ry + repairSlotSize + 15;

            if (def.maxDurability && this.repairSlot.durability < def.maxDurability) {
                const salePrice = Math.floor(def.price * 0.75);
                let repairCost = Math.floor(salePrice / 4);
                if (repairCost <= 0) repairCost = 1;

                this.ui.repairButtonBounds = { x: btnX, y: btnY, w: btnW, h: btnH };

                ctx.fillStyle = '#aa3333';
                ctx.fillRect(btnX, btnY, btnW, btnH);
                ctx.strokeStyle = '#ff6666';
                ctx.strokeRect(btnX, btnY, btnW, btnH);

                ctx.fillStyle = '#fff';
                ctx.font = 'bold 12px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`REPAIR ($${repairCost})`, btnX + btnW / 2, btnY + 16);
                ctx.textAlign = 'left';
            } else {
                this.ui.repairButtonBounds = null;

                ctx.fillStyle = '#888';
                ctx.font = '12px monospace';
                ctx.textAlign = 'center';
                if (!def.maxDurability) {
                    ctx.fillText('Cannot be repaired', btnX + btnW / 2, btnY + 16);
                } else {
                    ctx.fillText('Fully repaired', btnX + btnW / 2, btnY + 16);
                }
                ctx.textAlign = 'left';
            }
        } else {
            this.ui.repairButtonBounds = null;
        }
    }
};
