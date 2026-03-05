// shop.js — Handles the Shop Interface where players can buy and sell items
const Shop = {
    isOpen: false,

    // Items available for purchase in shop
    saleItems: [],

    // The item stack currently placed in the sell slot
    sellSlot: null,

    // UI bounds for click detection
    ui: {
        x: 0, y: 0, w: 0, h: 0,
        sellSlotBounds: null,
        sellButtonBounds: null,
        buyItemBounds: []
    },
    // Track when the shop last restocked
    lastRestockDay: -1,

    init() {
        this.isOpen = false;
        this.sellSlot = null;
        this.lastRestockDay = -1;

        // Available item pool
        this.allItems = [
            'ice_drill', 'fishing_rod', 'scoop', 'bait', 'axe',
            'flint_steel', 'tent', 'firewood', 'raw_fish',
            'cooked_fish', 'raw_fish_large', 'cooked_fish_large'
        ];
        this.saleItems = [];
    },

    toggle() {
        if (!this.isOpen) {
            // Check if player is near the shop building
            if (World.shop && Math.abs(Player.x - World.shop.x) < 100) {
                this.isOpen = true;
                Inventory.isOpen = true; // Open inventory so player can drag items

                // Randomize shop items only once per day
                if (this.lastRestockDay !== Survival.dayCount) {
                    this.lastRestockDay = Survival.dayCount;
                    const availableKeys = Object.keys(Inventory.ITEMS);
                    this.saleItems = availableKeys.sort(() => 0.5 - Math.random()).slice(0, 5);
                }

                Game.showMessage('Welcome to the Shop!', 2);
            } else {
                Game.showMessage('You are too far from the shop!', 1.5);
            }
        } else {
            this.close();
        }
    },

    close() {
        this.isOpen = false;
        // Return item in sell slot to inventory
        if (this.sellSlot) {
            if (!Inventory.addItem(this.sellSlot.id, this.sellSlot.count)) {
                // If inventory is full, drop it on the ground?
                // The game currently doesn't have a drop mechanic, we'll just force it back or destroy it if true logic is missing.
                // For safety, force add to first available empty bag slot manually if additive fails
                let forced = false;
                for (let i = 0; i < Inventory.BAG_SIZE; i++) {
                    if (!Inventory.bag[i]) {
                        Inventory.bag[i] = this.sellSlot;
                        forced = true; break;
                    }
                }
                if (!forced) Game.showMessage('Inventory full! Item lost!', 2);
            }
            this.sellSlot = null;
        }
    },

    handleMouseDown(mouseX, mouseY, canvasW, canvasH) {
        if (!this.isOpen) return false;

        // Check if clicked the Sell button
        if (this.ui.sellButtonBounds) {
            const b = this.ui.sellButtonBounds;
            if (mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h) {
                this.sellItem();
                return true;
            }
        }

        // Check if clicked Sell Slot to pick up item
        if (this.ui.sellSlotBounds) {
            const b = this.ui.sellSlotBounds;
            if (mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h) {
                if (this.sellSlot) {
                    // Pick up item from sell slot
                    Inventory.dragItem = this.sellSlot;
                    Inventory.dragSource = { type: 'shop' };
                    this.sellSlot = null;
                    return true;
                }
            }
        }

        // Check if clicked to Buy an item
        for (let i = 0; i < this.ui.buyItemBounds.length; i++) {
            const b = this.ui.buyItemBounds[i];
            if (mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h) {
                this.buyItem(b.itemId);
                return true;
            }
        }

        return false;
    },

    handleMouseUp(mouseX, mouseY, canvasW, canvasH) {
        if (!this.isOpen || !Inventory.dragItem) return false;

        if (this.ui.sellSlotBounds) {
            const b = this.ui.sellSlotBounds;
            if (mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h) {

                // Same item stacking logic
                if (this.sellSlot && this.sellSlot.id === Inventory.dragItem.id && Inventory.dragItem.stackable) {
                    const space = this.sellSlot.maxStack - this.sellSlot.count;
                    const add = Math.min(Inventory.dragItem.count, space);
                    this.sellSlot.count += add;
                    Inventory.dragItem.count -= add;

                    if (Inventory.dragItem.count <= 0) {
                        Inventory.dragItem = null;
                        Inventory.dragSource = null;
                        return true;
                    }
                }

                // Swap or place
                const temp = this.sellSlot;
                this.sellSlot = Inventory.dragItem;
                Inventory.dragItem = temp;

                if (Inventory.dragItem) {
                    Inventory.dragSource = { type: 'shop' };
                } else {
                    Inventory.dragSource = null;
                }
                return true;
            }
        }

        return false;
    },

    sellItem() {
        if (!this.sellSlot) return;

        // Value is 3/4 of the buy price
        const def = Inventory.ITEMS[this.sellSlot.id];
        if (!def.price) return;

        const saleValuePerItem = Math.floor(def.price * 0.75);
        if (saleValuePerItem <= 0) {
            Game.showMessage('This item cannot be sold.', 2);
            return;
        }

        const totalValue = saleValuePerItem * this.sellSlot.count;
        Player.money += totalValue;

        Game.showMessage(`Sold ${this.sellSlot.count}x ${def.name} for $${totalValue}`, 2);
        this.sellSlot = null;
    },

    buyItem(itemId) {
        const def = Inventory.ITEMS[itemId];
        if (!def || !def.price) return;

        if (Player.money >= def.price) {
            if (Inventory.addItem(itemId, 1)) {
                Player.money -= def.price;
                Game.showMessage(`Bought ${def.name} for $${def.price}`, 1.5);
            } else {
                Game.showMessage('Inventory full!', 1.5);
            }
        } else {
            Game.showMessage(`Not enough money! Need $${def.price}`, 1.5);
        }
    },

    render(ctx, canvasW, canvasH) {
        if (!this.isOpen) return;

        const w = 480;
        const h = 200; // Shorter for single row

        const slotSize = 52;
        const gap = 4;
        const bagCols = 8;
        const bagRows = 3;
        const inventoryW = bagCols * (slotSize + gap);
        const inventoryH = (bagRows + 1) * (slotSize + gap) + 60;
        const invStartY = (canvasH - inventoryH) / 2;

        // Position shop above the inventory
        const x = (canvasW - w) / 2;
        const y = Math.max(20, invStartY - h - 30);

        this.ui.x = x;
        this.ui.y = y;
        this.ui.w = w;
        this.ui.h = h;

        // Background
        ctx.fillStyle = '#141e32'; // Solid color, no transparency
        ctx.strokeStyle = '#6496c8';
        ctx.lineWidth = 3;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);

        // Title
        ctx.fillStyle = '#99ccff';
        ctx.font = 'bold 20px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('FISHING SHOP', x + w / 2, y + 25);
        ctx.textAlign = 'left';

        // Draw Items for Sale (Left side)
        ctx.fillStyle = '#ddd';
        ctx.font = '14px monospace';
        ctx.fillText('Items for Sale:', x + 15, y + 55);

        this.ui.buyItemBounds = [];
        for (let i = 0; i < this.saleItems.length; i++) {
            const itemId = this.saleItems[i];
            const def = Inventory.ITEMS[itemId];
            if (!def) continue;

            const sx = x + 15 + i * (slotSize + gap);
            const sy = y + 70;

            // Slot BG
            ctx.fillStyle = 'rgba(40,50,70,0.8)';
            ctx.fillRect(sx, sy, slotSize, slotSize);
            ctx.strokeStyle = 'rgba(100,150,200,0.5)';
            ctx.lineWidth = 1;
            ctx.strokeRect(sx, sy, slotSize, slotSize);

            // Icon
            Inventory.renderItemIcon(ctx, { id: itemId, stackable: false }, sx + 6, sy + 6, slotSize - 12);

            // Interaction bounds
            this.ui.buyItemBounds.push({ x: sx, y: sy, w: slotSize, h: slotSize, itemId: itemId });

            // Price tag
            ctx.fillStyle = '#ffaa44';
            ctx.font = '10px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(`$${def.price}`, sx + slotSize / 2, sy + slotSize + 12);
            ctx.textAlign = 'left';
        }

        // Draw Sell Area (Right side)
        const rx = x + w - 160;
        ctx.fillStyle = 'rgba(20,30,50,0.6)';
        ctx.fillRect(rx, y + 50, 145, h - 65);

        ctx.fillStyle = '#ddd';
        ctx.font = '14px monospace';
        ctx.fillText('Sell Items:', rx + 15, y + 75);

        ctx.fillStyle = '#888';
        ctx.font = '10px monospace';
        ctx.fillText('(Drag item here)', rx + 15, y + 90);

        // Sell Slot
        const sellSlotSize = 48;
        const ssx = rx + (145 - sellSlotSize) / 2;
        const ssy = y + 100;

        this.ui.sellSlotBounds = { x: ssx, y: ssy, w: sellSlotSize, h: sellSlotSize };

        ctx.fillStyle = 'rgba(10,15,25,0.8)';
        ctx.fillRect(ssx, ssy, sellSlotSize, sellSlotSize);
        ctx.strokeStyle = '#6496c8';
        ctx.lineWidth = 2;
        ctx.strokeRect(ssx, ssy, sellSlotSize, sellSlotSize);

        if (this.sellSlot) {
            Inventory.renderItemIcon(ctx, this.sellSlot, ssx + 8, ssy + 8, sellSlotSize - 16);

            const def = Inventory.ITEMS[this.sellSlot.id];
            const saleValue = Math.floor(def.price * 0.75) * this.sellSlot.count;

            ctx.fillStyle = '#44ff44';
            ctx.font = 'bold 12px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(`+ $${saleValue}`, ssx + sellSlotSize / 2, ssy + sellSlotSize + 15);
            ctx.textAlign = 'left';

            // Sell Button
            const btnW = 80;
            const btnH = 24;
            const btnX = rx + (145 - btnW) / 2;
            const btnY = ssy + sellSlotSize + 20;

            this.ui.sellButtonBounds = { x: btnX, y: btnY, w: btnW, h: btnH };

            ctx.fillStyle = '#aa3333';
            ctx.fillRect(btnX, btnY, btnW, btnH);
            ctx.strokeStyle = '#ff6666';
            ctx.strokeRect(btnX, btnY, btnW, btnH);

            ctx.fillStyle = '#fff';
            ctx.font = 'bold 14px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('SELL', btnX + btnW / 2, btnY + 20);
            ctx.textAlign = 'left';
        } else {
            this.ui.sellButtonBounds = null;
        }
    }
};
