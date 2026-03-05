// inventory.js — Inventory system with bag and hotbar
const Inventory = {
    BAG_SIZE: 24,
    HOTBAR_SIZE: 8,
    bag: [],
    hotbar: [],
    selectedSlot: 0,
    isOpen: false,
    dragItem: null,
    dragSource: null,

    // Item definitions
    ITEMS: {
        ice_drill: { id: 'ice_drill', name: 'Ice Drill', stackable: false, maxStack: 1, usable: true, category: 'tool', price: 100, maxDurability: 5 },
        fishing_rod: { id: 'fishing_rod', name: 'Fishing Rod', stackable: false, maxStack: 1, usable: true, category: 'tool', price: 50, maxDurability: 10 },
        scoop: { id: 'scoop', name: 'Scoop', stackable: false, maxStack: 1, usable: true, category: 'tool', price: 20, maxDurability: 10 },
        bait: { id: 'bait', name: 'Bait', stackable: true, maxStack: 20, usable: true, category: 'consumable', price: 5 },
        axe: { id: 'axe', name: 'Axe', stackable: false, maxStack: 1, usable: true, category: 'tool', price: 80, maxDurability: 20 },
        flint_steel: { id: 'flint_steel', name: 'Flint & Steel', stackable: false, maxStack: 1, usable: true, category: 'tool', price: 30, maxDurability: 10 },
        tent: { id: 'tent', name: 'Tent', stackable: false, maxStack: 1, usable: true, category: 'tool', price: 250, maxDurability: 5 },
        firewood: { id: 'firewood', name: 'Firewood', stackable: true, maxStack: 10, usable: true, category: 'resource', price: 2 },
        raw_fish: { id: 'raw_fish', name: 'Raw Fish', stackable: true, maxStack: 10, usable: true, category: 'food', price: 10 },
        cooked_fish: { id: 'cooked_fish', name: 'Cooked Fish', stackable: true, maxStack: 10, usable: true, category: 'food', price: 15 },
        raw_fish_large: { id: 'raw_fish_large', name: 'Large Raw Fish', stackable: true, maxStack: 5, usable: true, category: 'food', price: 25 },
        cooked_fish_large: { id: 'cooked_fish_large', name: 'Large Cooked Fish', stackable: true, maxStack: 5, usable: true, category: 'food', price: 35 }
    },

    init() {
        this.bag = new Array(this.BAG_SIZE).fill(null);
        this.hotbar = new Array(this.HOTBAR_SIZE).fill(null);
        this.selectedSlot = 0;
        this.isOpen = false;

        // Default loadout
        this.hotbar[0] = this.createItem('ice_drill');
        this.hotbar[1] = this.createItem('fishing_rod');
        this.hotbar[2] = this.createItem('scoop');
        this.hotbar[3] = this.createItem('bait', 10);
        this.hotbar[4] = this.createItem('axe');
        this.hotbar[5] = this.createItem('flint_steel');
        this.hotbar[6] = this.createItem('tent');
    },

    createItem(id, count = 1, durability = undefined) {
        const def = this.ITEMS[id];
        if (!def) return null;
        const item = { ...def, count };
        if (durability !== undefined) {
            item.durability = durability;
        } else if (def.maxDurability) {
            item.durability = def.maxDurability;
        }
        return item;
    },

    getSelectedItem() {
        return this.hotbar[this.selectedSlot];
    },

    addItem(id, count = 1, durability = undefined) {
        const def = this.ITEMS[id];
        if (!def) return false;

        // Try stack into existing slots first
        if (def.stackable) {
            // Check hotbar
            for (let i = 0; i < this.HOTBAR_SIZE; i++) {
                if (this.hotbar[i] && this.hotbar[i].id === id && this.hotbar[i].count < def.maxStack) {
                    const space = def.maxStack - this.hotbar[i].count;
                    const add = Math.min(count, space);
                    this.hotbar[i].count += add;
                    count -= add;
                    if (count <= 0) return true;
                }
            }
            // Check bag
            for (let i = 0; i < this.BAG_SIZE; i++) {
                if (this.bag[i] && this.bag[i].id === id && this.bag[i].count < def.maxStack) {
                    const space = def.maxStack - this.bag[i].count;
                    const add = Math.min(count, space);
                    this.bag[i].count += add;
                    count -= add;
                    if (count <= 0) return true;
                }
            }
        }

        // Place in empty slots
        while (count > 0) {
            const addCount = Math.min(count, def.maxStack);
            let placed = false;

            // Try hotbar first
            for (let i = 0; i < this.HOTBAR_SIZE; i++) {
                if (!this.hotbar[i]) {
                    this.hotbar[i] = this.createItem(id, addCount, durability);
                    count -= addCount;
                    placed = true;
                    break;
                }
            }
            if (placed) continue;

            // Try bag
            for (let i = 0; i < this.BAG_SIZE; i++) {
                if (!this.bag[i]) {
                    this.bag[i] = this.createItem(id, addCount, durability);
                    count -= addCount;
                    placed = true;
                    break;
                }
            }
            if (!placed) return false; // Full
        }
        return true;
    },

    removeItem(id, count = 1) {
        // Remove from hotbar first, then bag
        for (let i = 0; i < this.HOTBAR_SIZE; i++) {
            if (this.hotbar[i] && this.hotbar[i].id === id) {
                const remove = Math.min(count, this.hotbar[i].count);
                this.hotbar[i].count -= remove;
                count -= remove;
                if (this.hotbar[i].count <= 0) this.hotbar[i] = null;
                if (count <= 0) return true;
            }
        }
        for (let i = 0; i < this.BAG_SIZE; i++) {
            if (this.bag[i] && this.bag[i].id === id) {
                const remove = Math.min(count, this.bag[i].count);
                this.bag[i].count -= remove;
                count -= remove;
                if (this.bag[i].count <= 0) this.bag[i] = null;
                if (count <= 0) return true;
            }
        }
        return count <= 0;
    },

    damageSelectedItem(amount = 1) {
        const item = this.hotbar[this.selectedSlot];
        if (item && item.durability !== undefined) {
            item.durability -= amount;
            if (item.durability <= 0) {
                this.hotbar[this.selectedSlot] = null;
                Game.showMessage(`${item.name} broke!`, 2);
            }
        }
    },

    hasItem(id, count = 1) {
        let total = 0;
        for (const item of this.hotbar) {
            if (item && item.id === id) total += item.count;
        }
        for (const item of this.bag) {
            if (item && item.id === id) total += item.count;
        }
        return total >= count;
    },

    scrollSlot(delta) {
        this.selectedSlot = ((this.selectedSlot + delta) % this.HOTBAR_SIZE + this.HOTBAR_SIZE) % this.HOTBAR_SIZE;
    },

    toggle() {
        this.isOpen = !this.isOpen;
    },

    handleMouseDown(mouseX, mouseY, canvasW, canvasH) {
        if (!this.isOpen) return false;

        const slotSize = 52;
        const gap = 4;
        const bagCols = 8;
        const bagRows = 3;
        const totalW = bagCols * (slotSize + gap);
        const totalH = (bagRows + 1) * (slotSize + gap) + 40; // +1 for hotbar row
        const startX = (canvasW - totalW) / 2;

        let startY = (canvasH - totalH) / 2;
        if (Shop.isOpen) {
            startY = Shop.ui.y + Shop.ui.h + 20;
        }

        // Check bag slots
        for (let row = 0; row < bagRows; row++) {
            for (let col = 0; col < bagCols; col++) {
                const sx = startX + col * (slotSize + gap);
                const sy = startY + 30 + row * (slotSize + gap);
                if (mouseX >= sx && mouseX < sx + slotSize && mouseY >= sy && mouseY < sy + slotSize) {
                    const idx = row * bagCols + col;
                    if (this.bag[idx]) {
                        this.dragItem = this.bag[idx];
                        this.bag[idx] = null;
                        this.dragSource = { type: 'bag', idx };
                        return true;
                    }
                }
            }
        }

        // Check hotbar in inventory view
        const hotbarY = startY + 30 + bagRows * (slotSize + gap) + 10;
        for (let i = 0; i < this.HOTBAR_SIZE; i++) {
            const sx = startX + i * (slotSize + gap);
            if (mouseX >= sx && mouseX < sx + slotSize && mouseY >= hotbarY && mouseY < hotbarY + slotSize) {
                if (this.hotbar[i]) {
                    this.dragItem = this.hotbar[i];
                    this.hotbar[i] = null;
                    this.dragSource = { type: 'hotbar', idx: i };
                    return true;
                }
            }
        }

        return false;
    },

    handleMouseUp(mouseX, mouseY, canvasW, canvasH) {
        if (!this.isOpen || !this.dragItem) return false;

        const slotSize = 52;
        const gap = 4;
        const bagCols = 8;
        const bagRows = 3;
        const totalW = bagCols * (slotSize + gap);
        const totalH = (bagRows + 1) * (slotSize + gap) + 40;
        const startX = (canvasW - totalW) / 2;

        let startY = (canvasH - totalH) / 2;
        if (Shop.isOpen) {
            startY = Shop.ui.y + Shop.ui.h + 20;
        }

        // Check bag slots
        for (let row = 0; row < bagRows; row++) {
            for (let col = 0; col < bagCols; col++) {
                const sx = startX + col * (slotSize + gap);
                const sy = startY + 30 + row * (slotSize + gap);
                if (mouseX >= sx && mouseX < sx + slotSize && mouseY >= sy && mouseY < sy + slotSize) {
                    const idx = row * bagCols + col;

                    // Same item stacking logic
                    if (this.bag[idx] && this.bag[idx].id === this.dragItem.id && this.dragItem.stackable) {
                        const space = this.bag[idx].maxStack - this.bag[idx].count;
                        const add = Math.min(this.dragItem.count, space);
                        this.bag[idx].count += add;
                        this.dragItem.count -= add;

                        if (this.dragItem.count <= 0) {
                            this.dragItem = null;
                            this.dragSource = null;
                            return true;
                        }
                    }

                    // Swap or place
                    const temp = this.bag[idx];
                    this.bag[idx] = this.dragItem;
                    this.dragItem = temp;

                    if (this.dragItem) {
                        this.dragSource = { type: 'bag', idx };
                    } else {
                        this.dragSource = null;
                    }
                    return true;
                }
            }
        }

        // Check hotbar in inventory view
        const hotbarY = startY + 30 + bagRows * (slotSize + gap) + 10;
        for (let i = 0; i < this.HOTBAR_SIZE; i++) {
            const sx = startX + i * (slotSize + gap);
            if (mouseX >= sx && mouseX < sx + slotSize && mouseY >= hotbarY && mouseY < hotbarY + slotSize) {

                // Same item stacking logic
                if (this.hotbar[i] && this.hotbar[i].id === this.dragItem.id && this.dragItem.stackable) {
                    const space = this.hotbar[i].maxStack - this.hotbar[i].count;
                    const add = Math.min(this.dragItem.count, space);
                    this.hotbar[i].count += add;
                    this.dragItem.count -= add;

                    if (this.dragItem.count <= 0) {
                        this.dragItem = null;
                        this.dragSource = null;
                        return true;
                    }
                }

                // Swap or place
                const temp = this.hotbar[i];
                this.hotbar[i] = this.dragItem;
                this.dragItem = temp;

                if (this.dragItem) {
                    this.dragSource = { type: 'hotbar', idx: i };
                } else {
                    this.dragSource = null;
                }
                return true;
            }
        }

        return false;
    },

    render(ctx, canvasW, canvasH) {
        // Always render hotbar
        this.renderHotbar(ctx, canvasW, canvasH);

        // Render full inventory if open
        if (this.isOpen) {
            this.renderBag(ctx, canvasW, canvasH);
        }
    },

    renderHotbar(ctx, canvasW, canvasH) {
        const slotSize = 48;
        const gap = 4;
        const totalW = this.HOTBAR_SIZE * (slotSize + gap) - gap;
        const startX = (canvasW - totalW) / 2;
        const y = canvasH - slotSize - 12;

        for (let i = 0; i < this.HOTBAR_SIZE; i++) {
            const x = startX + i * (slotSize + gap);

            // Slot background
            ctx.fillStyle = i === this.selectedSlot ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.5)';
            ctx.fillRect(x, y, slotSize, slotSize);

            // Border
            ctx.strokeStyle = i === this.selectedSlot ? '#ffcc00' : 'rgba(255,255,255,0.3)';
            ctx.lineWidth = i === this.selectedSlot ? 2 : 1;
            ctx.strokeRect(x, y, slotSize, slotSize);

            // Item icon
            if (this.hotbar[i]) {
                this.renderItemIcon(ctx, this.hotbar[i], x + 4, y + 4, slotSize - 8);
            }

            // Slot number
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.font = '10px monospace';
            ctx.fillText(i + 1, x + 3, y + 12);
        }
    },

    renderBag(ctx, canvasW, canvasH) {
        const slotSize = 52;
        const gap = 4;
        const bagCols = 8;
        const bagRows = 3;
        const totalW = bagCols * (slotSize + gap);
        const totalH = (bagRows + 1) * (slotSize + gap) + 60;
        const startX = (canvasW - totalW) / 2;
        const startY = Shop.isOpen ? Shop.ui.y + Shop.ui.h + 20 : (canvasH - totalH) / 2;

        // Inventory Panel
        ctx.fillStyle = '#141e32'; // Solid color, no transparency
        ctx.strokeStyle = '#6496c8';
        ctx.lineWidth = 2;
        const panelPad = 15;
        ctx.fillRect(startX - panelPad, startY - panelPad, totalW + panelPad * 2, totalH + panelPad * 2);
        ctx.strokeRect(startX - panelPad, startY - panelPad, totalW + panelPad * 2, totalH + panelPad * 2);

        // Title
        ctx.fillStyle = '#b0c8e0';
        ctx.font = '16px monospace';
        ctx.fillText('INVENTORY', startX, startY + 20);

        // Bag slots
        for (let row = 0; row < bagRows; row++) {
            for (let col = 0; col < bagCols; col++) {
                const x = startX + col * (slotSize + gap);
                const y = startY + 30 + row * (slotSize + gap);
                const idx = row * bagCols + col;

                ctx.fillStyle = 'rgba(40,50,70,0.8)';
                ctx.fillRect(x, y, slotSize, slotSize);
                ctx.strokeStyle = 'rgba(80,100,140,0.6)';
                ctx.lineWidth = 1;
                ctx.strokeRect(x, y, slotSize, slotSize);

                if (this.bag[idx]) {
                    this.renderItemIcon(ctx, this.bag[idx], x + 6, y + 6, slotSize - 12);
                }
            }
        }

        // Hotbar label
        const hotbarY = startY + 30 + bagRows * (slotSize + gap) + 10;
        ctx.fillStyle = '#8090a0';
        ctx.font = '12px monospace';
        ctx.fillText('HOTBAR', startX, hotbarY - 4);

        // Hotbar slots in inventory view
        for (let i = 0; i < this.HOTBAR_SIZE; i++) {
            const x = startX + i * (slotSize + gap);

            ctx.fillStyle = i === this.selectedSlot ? 'rgba(60,70,90,0.9)' : 'rgba(40,50,70,0.8)';
            ctx.fillRect(x, hotbarY, slotSize, slotSize);
            ctx.strokeStyle = i === this.selectedSlot ? '#ffcc00' : 'rgba(80,100,140,0.6)';
            ctx.lineWidth = i === this.selectedSlot ? 2 : 1;
            ctx.strokeRect(x, hotbarY, slotSize, slotSize);

            if (this.hotbar[i]) {
                this.renderItemIcon(ctx, this.hotbar[i], x + 6, hotbarY + 6, slotSize - 12);
            }
        }

        // Dragged item follows mouse (rendered in game.js with mouse pos)
    },

    renderItemIcon(ctx, item, x, y, size) {
        ctx.save();
        ctx.translate(x, y);
        const s = size / 32; // scale factor

        let assetName = item.id;
        if (assetName === 'firewood') assetName = 'wood';

        const img = Assets.get(assetName);
        if (img) {
            ctx.drawImage(img, 0, 0, size, size);
        } else {
            // Fallback for missing assets (like bait)
            if (item.id === 'bait') {
                ctx.fillStyle = '#d4956a';
                ctx.beginPath();
                ctx.arc(16 * s, 16 * s, 6 * s, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#b37548';
                ctx.beginPath();
                ctx.arc(16 * s, 16 * s, 3 * s, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.fillStyle = '#ff00ff';
                ctx.fillRect(0, 0, size, size);
            }
        }

        // Count badge
        if (item.stackable && item.count > 1) {
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.fillRect(20 * s, 22 * s, 14 * s, 12 * s);
            ctx.fillStyle = '#fff';
            ctx.font = `${10 * s}px monospace`;
            ctx.fillText(item.count, 21 * s, 32 * s);
        }

        // Durability bar
        if (item.maxDurability && item.durability !== undefined) {
            const pct = item.durability / item.maxDurability;
            const barW = size * 0.8;
            const barH = 4 * s;
            const bx = (size - barW) / 2;
            const by = size - barH - 2 * s;

            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.fillRect(bx, by, barW, barH);

            ctx.fillStyle = pct > 0.5 ? '#44cc44' : (pct > 0.2 ? '#ccaa33' : '#cc3333');
            ctx.fillRect(bx, by, barW * pct, barH);

            ctx.strokeStyle = '#222';
            ctx.lineWidth = 1;
            ctx.strokeRect(bx, by, barW, barH);
        }

        ctx.restore();
    }
};
