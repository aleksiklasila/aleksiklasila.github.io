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

    handleMouseDown(mouseX, mouseY, canvasW, canvasH, shiftKey = false, ctrlKey = false, button = 0) {
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
                    if (button === 2) {
                        const item = this.repairSlot;
                        this.repairSlot = null;
                        Inventory.moveToSecondHand(item);
                        return true;
                    }
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
        let repairCost = Math.floor(salePrice / 8);
        if (repairCost <= 0) repairCost = 1; // Minimum cost of $1

        // Assuming a full repair for now, as `repairAmount` is not defined elsewhere.
        // If partial repair is intended, `repairAmount` would need to be calculated.
        const repairAmount = def.maxDurability - this.repairSlot.durability;

        if (Inventory.canAfford({ money: repairCost })) {
            Inventory.payCost({ money: repairCost });
            this.repairSlot.durability = Math.min(this.repairSlot.durability + repairAmount, def.maxDurability);
            Game.showMessage(`Repaired ${def.name} for $${repairCost}!`, 2);
        } else {
            Game.showMessage(`Not enough money! Need $${repairCost}.`, 2);
        }
    },

    render(ctx, canvasW, canvasH) {
        if (!this.isOpen) return;

        const bounds = UIMenu.renderMenuBase(ctx, canvasW, canvasH, 'REPAIR STATION', this);

        // Draw interaction panel on the right matching selling workflow
        const panelBounds = UIMenu.renderRightPanel(ctx, bounds, 'Repair Tool:', '(Drag item here)');
        this.ui.repairSlotBounds = UIMenu.renderActionSlot(ctx, panelBounds, 48);

        if (this.repairSlot) {
            const ssx = this.ui.repairSlotBounds.x;
            const ssy = this.ui.repairSlotBounds.y;
            const repairSlotSize = this.ui.repairSlotBounds.w;

            Inventory.renderItemIcon(ctx, this.repairSlot, ssx + 8, ssy + 8, repairSlotSize - 16);

            const def = Inventory.ITEMS[this.repairSlot.id];

            if (def.maxDurability && this.repairSlot.durability < def.maxDurability) {
                const salePrice = Math.floor(def.price * 0.75);
                let repairCost = Math.floor(salePrice / 8);
                if (repairCost <= 0) repairCost = 1;

                this.ui.repairButtonBounds = UIMenu.renderActionButton(ctx, panelBounds, ssy, repairSlotSize, `REPAIR($${repairCost})`, '#aa3333');
            } else {
                this.ui.repairButtonBounds = null;

                const btnX = panelBounds.rx + (panelBounds.rw - 80) / 2;
                const btnY = ssy + repairSlotSize + 20;

                ctx.fillStyle = '#888';
                ctx.font = '12px monospace';
                ctx.textAlign = 'center';
                if (!def.maxDurability) {
                    ctx.fillText('Cannot repair', btnX + 40, btnY + 16);
                } else {
                    ctx.fillText('Fully repaired', btnX + 40, btnY + 16);
                }
                ctx.textAlign = 'left';
            }
        } else {
            this.ui.repairButtonBounds = null;
        }
    }
};
