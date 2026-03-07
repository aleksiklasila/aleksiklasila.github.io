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
            'ice_drill', 'fishing_rod', 'scoop', 'bait', 'axe', 'hammer',
            'flint_steel', 'tent', 'firewood', 'raw_fish',
            'cooked_fish', 'raw_fish_large', 'cooked_fish_large', 'torch', 'shovel'
        ];
        this.saleItems = [];
    },

    toggle() {
        if (!this.isOpen) {
            // Check if player is near the shop building
            if (World.shop && Math.abs(Player.x - World.shop.x) < 100) {
                this.isOpen = true;
                Inventory.isOpen = true; // Open inventory so player can drag items

                // Render all items in shop at all times
                if (this.lastRestockDay !== Survival.dayCount) {
                    this.lastRestockDay = Survival.dayCount;
                    // Sort available keys logically by category or keep unsorted
                    this.saleItems = [...this.allItems];
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

    handleMouseDown(mouseX, mouseY, canvasW, canvasH, shiftKey = false, ctrlKey = false, button = 0) {
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
                    const item = this.sellSlot;
                    if (button === 2) {
                        this.sellSlot = null;
                        Inventory.moveToSecondHand(item);
                        return true;
                    }
                    if (item.stackable && item.count > 1 && (shiftKey || ctrlKey)) {
                        let takeCount = ctrlKey ? 1 : Math.max(1, Math.floor(item.count / 2));
                        Inventory.dragItem = { ...item, count: takeCount };
                        item.count -= takeCount;
                        Inventory.dragSource = { type: 'shop_split' };
                    } else {
                        // Pick up item from sell slot
                        Inventory.dragItem = this.sellSlot;
                        Inventory.dragSource = { type: 'shop' };
                        this.sellSlot = null;
                    }
                    return true;
                }
            }
        }

        // Check if clicked to Buy an item
        for (let i = 0; i < this.ui.buyItemBounds.length; i++) {
            const b = this.ui.buyItemBounds[i];
            if (mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h) {
                if (!b.itemId || Inventory.dragItem) return false;

                const def = Inventory.ITEMS[b.itemId];

                if (button === 2) {
                    if (def.cost && def.cost.money && !Inventory.canAfford({ money: def.cost.money })) {
                        Game.showMessage(`Not enough money! Need $${def.cost.money}`, 1.5);
                        return true;
                    }
                    if (def.cost && def.cost.money) {
                        Inventory.payCost({ money: def.cost.money });
                    }
                    let item = { ...def, count: 1 };
                    if (def.maxDurability) item.durability = def.maxDurability;
                    this.saleItems[b.index] = null;
                    Inventory.moveToSecondHand(item);
                    if (def.cost && def.cost.money) {
                        Game.showMessage(`Bought ${def.name} for $${def.cost.money}`, 1.5);
                    }
                    return true;
                }

                let item = { ...def, count: 1 };
                if (def.maxDurability) item.durability = def.maxDurability;

                Inventory.dragItem = item;
                Inventory.dragSource = { type: 'shop_buy', index: b.index };
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
        if (!def.cost || !def.cost.money) return;

        const saleValuePerItem = Math.floor(def.cost.money * 0.75);
        if (saleValuePerItem <= 0) {
            Game.showMessage('This item cannot be sold.', 2);
            return;
        }

        const totalValue = saleValuePerItem * this.sellSlot.count;
        Inventory.addItem('money', totalValue);

        Game.showMessage(`Sold ${this.sellSlot.count}x ${def.name} for $${totalValue}`, 2);
        this.sellSlot = null;
    },

    render(ctx, canvasW, canvasH) {
        if (!this.isOpen) return;

        const bounds = UIMenu.renderMenuBase(ctx, canvasW, canvasH, 'FISHING SHOP', this);

        // Draw Items for Sale (Left side)
        this.ui.buyItemBounds = UIMenu.renderLeftGrid(ctx, bounds, 'Items for Sale:', this.saleItems, (c, item, i, sx, sy, slotSize) => {
            if (!item) {
                c.fillStyle = '#888';
                c.font = 'bold 12px monospace';
                c.textAlign = 'center';
                c.fillText('SOLD', sx + slotSize / 2, sy + slotSize / 2 + 4);
                c.textAlign = 'left';
            } else {
                const def = Inventory.ITEMS[item];
                if (!def) return;

                // Icon
                Inventory.renderItemIcon(c, { id: item, stackable: false }, sx + 6, sy + 6, slotSize - 12);

                if (def.cost && def.cost.money) {
                    if (!Inventory.canAfford({ money: def.cost.money })) {
                        c.fillStyle = 'rgba(255,0,0,0.3)';
                        c.fillRect(sx, sy, slotSize, slotSize);
                    }

                    // Price tag
                    c.fillStyle = Inventory.canAfford({ money: def.cost.money }) ? '#ffaa44' : '#ff4444';
                    c.font = '10px monospace';
                    c.textAlign = 'center';
                    c.fillText(`$${def.cost.money}`, sx + slotSize / 2, sy + slotSize + 12);
                    c.textAlign = 'left';
                }
            }
        });

        // Remap bounds data
        this.ui.buyItemBounds.forEach(b => b.itemId = b.item);

        // Draw Sell Area (Right side)
        const panelBounds = UIMenu.renderRightPanel(ctx, bounds, 'Sell Items:', '(Drag item here)');
        this.ui.sellSlotBounds = UIMenu.renderActionSlot(ctx, panelBounds, 48);

        if (this.sellSlot) {
            const ssx = this.ui.sellSlotBounds.x;
            const ssy = this.ui.sellSlotBounds.y;
            const sellSlotSize = this.ui.sellSlotBounds.w;

            Inventory.renderItemIcon(ctx, this.sellSlot, ssx + 8, ssy + 8, sellSlotSize - 16);

            const def = Inventory.ITEMS[this.sellSlot.id];
            if (def.cost && def.cost.money) {
                const saleValue = Math.floor(def.cost.money * 0.75) * this.sellSlot.count;

                ctx.fillStyle = '#44ff44';
                ctx.font = 'bold 12px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`+ $${saleValue}`, ssx + sellSlotSize / 2, ssy + sellSlotSize + 15);
                ctx.textAlign = 'left';
            }

            // Sell Button
            this.ui.sellButtonBounds = UIMenu.renderActionButton(ctx, panelBounds, ssy, sellSlotSize, 'SELL', '#aa3333');
        } else {
            this.ui.sellButtonBounds = null;
        }
    }
};
