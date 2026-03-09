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
    secondHand: null,
    clothing: null,

    getLayout(canvasW, canvasH) {
        const slotSize = 52;
        const gap = 4;
        const bagCols = 8;
        const bagRows = 3;
        const totalW = bagCols * (slotSize + gap);
        const totalH = (bagRows + 1) * (slotSize + gap) + 60;

        const anyMenuOpen = typeof UIMenu !== 'undefined' && (Shop.isOpen || RepairShop.isOpen || Crafting.isOpen || Anvil.isOpen || ChestUI.isOpen);

        let startX, startY;
        if (anyMenuOpen) {
            let activeMenuWidth = 0;
            if (Shop.isOpen || RepairShop.isOpen || Crafting.isOpen || Anvil.isOpen) {
                activeMenuWidth = UIMenu.width;
            } else if (ChestUI.isOpen) {
                activeMenuWidth = ChestUI.COLS * (ChestUI.SLOT_SIZE + ChestUI.GAP);
            }

            const combinedW = totalW + 20 + activeMenuWidth;
            startX = (canvasW - combinedW) / 2;
            const targetBottomY = canvasH - 100;
            startY = targetBottomY - totalH - 15; // Account for panelPad (15) in renderBag
        } else {
            // Centered positioning
            startX = (canvasW - totalW) / 2;
            startY = (canvasH - totalH) / 2;
        }

        return { startX, startY, totalW, totalH, slotSize, gap, bagCols, bagRows };
    },

    ITEMS: {
        money: { id: 'money', name: 'Money', stackable: true, maxStack: 1000, usable: false, category: 'currency', cost: {} },
        ice_drill: { id: 'ice_drill', name: 'Ice Drill', stackable: false, maxStack: 1, usable: true, category: 'tool', cost: { money: 100 }, maxDurability: 5 },
        fishing_rod: { id: 'fishing_rod', name: 'Fishing Rod', stackable: false, maxStack: 1, usable: true, category: 'tool', cost: { money: 50 }, maxDurability: 10 },
        scoop: { id: 'scoop', name: 'Scoop', stackable: false, maxStack: 1, usable: true, category: 'tool', cost: { money: 20 }, maxDurability: 10 },
        bait: { id: 'bait', name: 'Bait', stackable: true, maxStack: 20, usable: true, category: 'consumable', cost: { money: 5 } },
        axe: { id: 'axe', name: 'Axe', stackable: false, maxStack: 1, usable: true, category: 'tool', cost: { money: 80 }, maxDurability: 20 },
        hammer: { id: 'hammer', name: 'Hammer', stackable: false, maxStack: 1, usable: true, category: 'tool', cost: { money: 120 }, maxDurability: 50 },
        flint_steel: { id: 'flint_steel', name: 'Flint & Steel', stackable: false, maxStack: 1, usable: true, category: 'tool', cost: { money: 30 }, maxDurability: 10 },
        tent: { id: 'tent', name: 'Tent', stackable: false, maxStack: 1, usable: true, category: 'tool', cost: { money: 250 }, maxDurability: 5 },
        firewood: { id: 'firewood', name: 'Firewood', stackable: true, maxStack: 10, usable: true, category: 'resource', cost: { money: 7 } },
        raw_fish: { id: 'raw_fish', name: 'Raw Fish', stackable: true, maxStack: 10, usable: true, category: 'food', cost: { money: 10 } },
        cooked_fish: { id: 'cooked_fish', name: 'Cooked Fish', stackable: true, maxStack: 10, usable: true, category: 'food', cost: { money: 15 } },
        raw_fish_large: { id: 'raw_fish_large', name: 'Large Raw Fish', stackable: true, maxStack: 5, usable: true, category: 'food', cost: { money: 25 } },
        cooked_fish_large: { id: 'cooked_fish_large', name: 'Large Cooked Fish', stackable: true, maxStack: 5, usable: true, category: 'food', cost: { money: 35 } },
        torch: { id: 'torch', name: 'Torch', stackable: false, maxStack: 1, usable: true, category: 'tool', cost: { money: 15 }, maxDurability: 100, lit: false },
        campfire_blue: { id: 'campfire_blue', name: 'Blue Campfire', stackable: false, maxStack: 1, usable: true, category: 'building', cost: { firewood: 5 } },
        campfire_blue_lit: { id: 'campfire_blue_lit', name: 'Lit Blue Campfire', stackable: false, maxStack: 1, usable: true, category: 'building', cost: { firewood: 5 } },
        shovel: { id: 'shovel', name: 'Shovel', stackable: false, maxStack: 1, usable: true, category: 'tool', cost: { money: 50 }, maxDurability: 50 },
        simple_bridge: { id: 'simple_bridge', name: 'Simple Bridge', stackable: true, maxStack: 10, usable: true, category: 'building', cost: { money: 20 } },
        fish_egg: { id: 'fish_egg', name: 'Fish Egg', stackable: true, maxStack: 10, usable: false, category: 'material', cost: { money: 10 } },
        tree_egg: { id: 'tree_egg', name: 'Tree Sapling', stackable: true, maxStack: 10, usable: false, category: 'material', cost: { money: 5 } },
        polar_bear_egg: { id: 'polar_bear_egg', name: 'Polar Bear Egg', stackable: true, maxStack: 10, usable: false, category: 'material', cost: { money: 100 } },
        rock: { id: 'rock', name: 'Rock', stackable: true, maxStack: 10, usable: false, category: 'resource', cost: { money: 10 } },
        pickaxe: { id: 'pickaxe', name: 'Pickaxe', stackable: false, maxStack: 1, usable: true, category: 'tool', cost: { money: 90 }, maxDurability: 20 },
        anvil: { id: 'anvil', name: 'Anvil', stackable: false, maxStack: 1, usable: true, category: 'tool', cost: { money: 200 }, maxDurability: 50 },
        chest: { id: 'chest', name: 'Chest', stackable: false, maxStack: 1, usable: true, category: 'building', cost: { firewood: 5 } },
        shotgun: { id: 'shotgun', name: 'Shotgun', stackable: false, maxStack: 1, usable: true, category: 'weapon', cost: { money: 70 }, maxDurability: 10 },
        hide: { id: 'hide', name: 'Hide', stackable: false, maxStack: 1, usable: false, category: 'clothing', cost: { money: 50 }, maxDurability: 100 }
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
        this.hotbar[3] = this.createItem('hammer');
        this.hotbar[4] = this.createItem('axe');
        this.hotbar[5] = this.createItem('flint_steel');
        this.hotbar[6] = this.createItem('tent');

        // Bait in bag
        this.bag[0] = this.createItem('bait', 10);
        this.bag[4] = this.createItem('shotgun');
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

    getHandItem(isSecondHand) {
        return isSecondHand ? this.secondHand : this.hotbar[this.selectedSlot];
    },

    removeHandItem(isSecondHand) {
        if (isSecondHand) {
            this.secondHand = null;
        } else {
            this.hotbar[this.selectedSlot] = null;
        }
    },

    consumeHandItem(isSecondHand, amount = 1) {
        const item = this.getHandItem(isSecondHand);
        if (!item) return;

        if (item.durability !== undefined) {
            item.durability -= amount;
            if (item.durability <= 0) {
                this.removeHandItem(isSecondHand);
                Game.showMessage(`${item.name} broke!`, 2);
            }
        } else if (item.stackable) {
            item.count -= amount;
            if (item.count <= 0) {
                this.removeHandItem(isSecondHand);
            }
        }
    },

    damageSelectedItem(amount = 1) {
        this.consumeHandItem(false, amount);
    },

    damageItemById(id, amount = 1) {
        for (const c of [this.hotbar, this.bag]) {
            for (let i = 0; i < c.length; i++) {
                const item = c[i];
                if (item && item.id === id && item.durability !== undefined) {
                    item.durability -= amount;
                    if (item.durability <= 0) {
                        c[i] = null;
                        Game.showMessage(`${item.name} broke!`, 2);
                    }
                    return true;
                }
            }
        }
        return false;
    },

    hasItem(id, count = 1) {
        return this.countItem(id) >= count;
    },

    countItem(id) {
        let total = 0;
        for (const item of this.hotbar) {
            if (item && item.id === id) total += item.count;
        }
        for (const item of this.bag) {
            if (item && item.id === id) total += item.count;
        }
        if (this.secondHand && this.secondHand.id === id) {
            total += this.secondHand.count;
        }
        return total;
    },

    canAfford(costObj) {
        for (const id in costObj) {
            if (!this.hasItem(id, costObj[id])) return false;
        }
        return true;
    },

    payCost(costObj) {
        if (!this.canAfford(costObj)) return false;
        for (const id in costObj) {
            this.removeItem(id, costObj[id]);
        }
        return true;
    },

    moveToSecondHand(item) {
        if (!item) return;

        // If second hand is occupied, move it to inventory
        if (this.secondHand) {
            const oldItem = this.secondHand;
            this.secondHand = null;
            // Add the old item to inventory
            this.addItem(oldItem.id, oldItem.count, oldItem.durability);
        }

        // Now set the new item
        this.secondHand = item;
    },

    moveToClothing(item) {
        if (!item || item.id !== 'hide') return false;

        if (this.clothing) {
            const oldItem = this.clothing;
            this.clothing = null;
            this.addItem(oldItem.id, oldItem.count, oldItem.durability);
        }

        this.clothing = item;
        return true;
    },

    scrollSlot(delta) {
        this.selectedSlot = ((this.selectedSlot + delta) % this.HOTBAR_SIZE + this.HOTBAR_SIZE) % this.HOTBAR_SIZE;
    },

    toggle() {
        this.isOpen = !this.isOpen;
    },

    handleMouseDown(mouseX, mouseY, canvasW, canvasH, shiftKey = false, ctrlKey = false, button = 0) {
        const { startX, startY, totalW, totalH, slotSize, gap, bagCols, bagRows } = this.getLayout(canvasW, canvasH);

        // Check bag slots (only if inventory is open)
        if (this.isOpen) {
            for (let row = 0; row < bagRows; row++) {
                for (let col = 0; col < bagCols; col++) {
                    const sx = startX + col * (slotSize + gap);
                    const sy = startY + 30 + row * (slotSize + gap);
                    if (mouseX >= sx && mouseX < sx + slotSize && mouseY >= sy && mouseY < sy + slotSize) {
                        const idx = row * bagCols + col;
                        if (this.bag[idx]) {
                            const item = this.bag[idx];
                            if (button === 2) {
                                this.bag[idx] = null;
                                this.moveToSecondHand(item);
                                return true;
                            }
                            if (item.stackable && item.count > 1 && (shiftKey || ctrlKey)) {
                                let takeCount = ctrlKey ? 1 : Math.max(1, Math.floor(item.count / 2));
                                this.dragItem = { ...item, count: takeCount };
                                item.count -= takeCount;
                                this.dragSource = { type: 'bag_split', idx };
                            } else {
                                this.dragItem = item;
                                this.bag[idx] = null;
                                this.dragSource = { type: 'bag', idx };
                            }
                            return true;
                        }
                        return true;
                    }
                }
            }

            // Check hotbar inside bag UI
            const bagHotbarY = startY + 30 + bagRows * (slotSize + gap) + 10;
            const bshX = startX - slotSize - 20;

            if (mouseX >= bshX && mouseX < bshX + slotSize && mouseY >= bagHotbarY && mouseY < bagHotbarY + slotSize) {
                if (this.secondHand) {
                    if (button === 2) {
                        const item = this.secondHand;
                        this.secondHand = null;
                        this.addItem(item.id, item.count, item.durability);
                    } else {
                        const item = this.secondHand;
                        this.dragItem = item;
                        this.secondHand = null;
                        this.dragSource = { type: 'secondHand', idx: 0 };
                    }
                    return true;
                }
                return true;
            }

            // Check clothing slot
            const clothX = startX + totalW + 20;
            const clothY = bagHotbarY;
            if (mouseX >= clothX && mouseX < clothX + slotSize && mouseY >= clothY && mouseY < clothY + slotSize) {
                if (this.clothing) {
                    if (button === 2) {
                        const item = this.clothing;
                        this.clothing = null;
                        this.addItem(item.id, item.count, item.durability);
                    } else {
                        const item = this.clothing;
                        this.dragItem = item;
                        this.clothing = null;
                        this.dragSource = { type: 'clothing', idx: 0 };
                    }
                    return true;
                }
                return true;
            }

            for (let i = 0; i < this.HOTBAR_SIZE; i++) {
                const sx = startX + i * (slotSize + gap);
                if (mouseX >= sx && mouseX < sx + slotSize && mouseY >= bagHotbarY && mouseY < bagHotbarY + slotSize) {
                    if (this.hotbar[i]) {
                        const item = this.hotbar[i];
                        if (button === 2) {
                            this.hotbar[i] = null;
                            this.moveToSecondHand(item);
                            return true;
                        }
                        if (item.stackable && item.count > 1 && (shiftKey || ctrlKey)) {
                            let takeCount = ctrlKey ? 1 : Math.max(1, Math.floor(item.count / 2));
                            this.dragItem = { ...item, count: takeCount };
                            item.count -= takeCount;
                            this.dragSource = { type: 'hotbar_split', idx: i };
                        } else {
                            this.dragItem = item;
                            this.hotbar[i] = null;
                            this.dragSource = { type: 'hotbar', idx: i };
                        }
                        return true;
                    }
                    return true;
                }
            }

            if (mouseX >= startX - 15 && mouseX <= startX + totalW + 15 && mouseY >= startY - 15 && mouseY <= startY + totalH + 15) {
                return true;
            }
        }

        // Check hotbar in game view (bottom centered)
        const hotbarSlotSize = 48;
        const hotbarGap = 4;
        const totalHotbarW = this.HOTBAR_SIZE * (hotbarSlotSize + hotbarGap) - hotbarGap;
        const hotbarStartX = (canvasW - totalHotbarW) / 2;
        const hotbarY = canvasH - hotbarSlotSize - 12;
        const shX = hotbarStartX - hotbarSlotSize - 20;

        if (mouseX >= shX && mouseX < shX + hotbarSlotSize && mouseY >= hotbarY && mouseY < hotbarY + hotbarSlotSize) {
            if (this.secondHand) {
                if (button === 2) {
                    const item = this.secondHand;
                    this.secondHand = null;
                    this.addItem(item.id, item.count, item.durability);
                } else {
                    const item = this.secondHand;
                    this.dragItem = item;
                    this.secondHand = null;
                    this.dragSource = { type: 'secondHand', idx: 0 };
                }
                return true;
            }
            return true;
        }

        for (let i = 0; i < this.HOTBAR_SIZE; i++) {
            const sx = hotbarStartX + i * (hotbarSlotSize + hotbarGap);
            if (mouseX >= sx && mouseX < sx + hotbarSlotSize && mouseY >= hotbarY && mouseY < hotbarY + hotbarSlotSize) {
                if (this.hotbar[i]) {
                    const item = this.hotbar[i];
                    if (button === 2) {
                        this.hotbar[i] = null;
                        this.moveToSecondHand(item);
                        return true;
                    }
                    if (item.stackable && item.count > 1 && (shiftKey || ctrlKey)) {
                        let takeCount = ctrlKey ? 1 : Math.max(1, Math.floor(item.count / 2));
                        this.dragItem = { ...item, count: takeCount };
                        item.count -= takeCount;
                        this.dragSource = { type: 'hotbar_split', idx: i };
                    } else {
                        this.dragItem = item;
                        this.hotbar[i] = null;
                        this.dragSource = { type: 'hotbar', idx: i };
                    }
                    return true;
                }
                return true;
            }
        }

        return false;
    },

    handleMouseUp(mouseX, mouseY, canvasW, canvasH) {
        if (!this.dragItem) return false;

        const { startX, startY, totalW, totalH, slotSize, gap, bagCols, bagRows } = this.getLayout(canvasW, canvasH);

        // Check bag slots (only if inventory is open)
        if (this.isOpen) {
            for (let row = 0; row < bagRows; row++) {
                for (let col = 0; col < bagCols; col++) {
                    const sx = startX + col * (slotSize + gap);
                    const sy = startY + 30 + row * (slotSize + gap);
                    if (mouseX >= sx && mouseX < sx + slotSize && mouseY >= sy && mouseY < sy + slotSize) {
                        const idx = row * bagCols + col;

                        // Shop Buy Check
                        if (this.dragSource && this.dragSource.type === 'shop_buy') {
                            const def = Inventory.ITEMS[this.dragItem.id];
                            if (def.cost && def.cost.money) {
                                if (!Inventory.canAfford({ money: def.cost.money })) {
                                    Game.showMessage(`Not enough money! Need $${def.cost.money}`, 1.5);
                                    return true;
                                }
                                Inventory.payCost({ money: def.cost.money });
                            }
                            Shop.saleItems[this.dragSource.index] = null;
                            Game.showMessage(`Bought ${def.name} for $${def.cost ? def.cost.money : 0}`, 1.5);
                            this.dragSource = null;
                        }

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

            // Check hotbar inside bag UI
            const bagHotbarY = startY + 30 + bagRows * (slotSize + gap) + 10;
            const bshX = startX - slotSize - 20;

            if (mouseX >= bshX && mouseX < bshX + slotSize && mouseY >= bagHotbarY && mouseY < bagHotbarY + slotSize) {
                if (this.dragSource && this.dragSource.type === 'shop_buy') {
                    if (this.secondHand && (!this.dragItem.stackable || this.secondHand.id !== this.dragItem.id || this.secondHand.count >= this.secondHand.maxStack)) {
                        Game.showMessage("Cannot place item there!", 1.5);
                        return true;
                    }
                    const def = Inventory.ITEMS[this.dragItem.id];
                    if (def.cost && def.cost.money) {
                        if (!Inventory.canAfford({ money: def.cost.money })) {
                            Game.showMessage(`Not enough money! Need $${def.cost.money}`, 1.5);
                            return true;
                        }
                        Inventory.payCost({ money: def.cost.money });
                    }
                    Shop.saleItems[this.dragSource.index] = null;
                    Game.showMessage(`Bought ${def.name} for $${def.cost ? def.cost.money : 0}`, 1.5);
                    this.dragSource = null;
                }

                if (this.secondHand && this.secondHand.id === this.dragItem.id && this.dragItem.stackable) {
                    const space = this.secondHand.maxStack - this.secondHand.count;
                    const add = Math.min(this.dragItem.count, space);
                    this.secondHand.count += add;
                    this.dragItem.count -= add;
                    if (this.dragItem.count <= 0) {
                        this.dragItem = null;
                        this.dragSource = null;
                        return true;
                    }
                }

                const temp = this.secondHand;
                this.secondHand = this.dragItem;
                this.dragItem = temp;
                if (this.dragItem) {
                    this.dragSource = { type: 'secondHand', idx: 0 };
                } else {
                    this.dragSource = null;
                }
                return true;
            }

            // Check clothing slot drop
            const clothX = bshX;
            const clothY = bagHotbarY - slotSize - 20;
            if (mouseX >= clothX && mouseX < clothX + slotSize && mouseY >= clothY && mouseY < clothY + slotSize) {
                if (this.dragItem.id !== 'hide') {
                    Game.showMessage("Can only equip hide here!", 1.5);
                    return true;
                }

                if (this.dragSource && this.dragSource.type === 'shop_buy') {
                    const def = Inventory.ITEMS[this.dragItem.id];
                    if (def.cost && def.cost.money) {
                        if (!Inventory.canAfford({ money: def.cost.money })) {
                            Game.showMessage(`Not enough money! Need $${def.cost.money}`, 1.5);
                            return true;
                        }
                        Inventory.payCost({ money: def.cost.money });
                    }
                    Shop.saleItems[this.dragSource.index] = null;
                    Game.showMessage(`Bought ${def.name} for $${def.cost ? def.cost.money : 0}`, 1.5);
                    this.dragSource = null;
                }

                const temp = this.clothing;
                this.clothing = this.dragItem;
                this.dragItem = temp;
                if (this.dragItem) {
                    this.dragSource = { type: 'clothing', idx: 0 };
                } else {
                    this.dragSource = null;
                }
                return true;
            }

            for (let i = 0; i < this.HOTBAR_SIZE; i++) {
                const sx = startX + i * (slotSize + gap);
                if (mouseX >= sx && mouseX < sx + slotSize && mouseY >= bagHotbarY && mouseY < bagHotbarY + slotSize) {
                    if (this.dragSource && this.dragSource.type === 'shop_buy') {
                        const def = Inventory.ITEMS[this.dragItem.id];
                        if (def.cost && def.cost.money) {
                            if (!Inventory.canAfford({ money: def.cost.money })) {
                                Game.showMessage(`Not enough money! Need $${def.cost.money}`, 1.5);
                                return true;
                            }
                            Inventory.payCost({ money: def.cost.money });
                        }
                        Shop.saleItems[this.dragSource.index] = null;
                        Game.showMessage(`Bought ${def.name} for $${def.cost ? def.cost.money : 0}`, 1.5);
                        this.dragSource = null;
                    }

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
        }

        // Check hotbar in game view (bottom centered)
        const hotbarSlotSize = 48;
        const hotbarGap = 4;
        const totalHotbarW = this.HOTBAR_SIZE * (hotbarSlotSize + hotbarGap) - hotbarGap;
        const hotbarStartX = (canvasW - totalHotbarW) / 2;
        const hotbarY = canvasH - hotbarSlotSize - 12;
        const shX = hotbarStartX - hotbarSlotSize - 20;

        if (mouseX >= shX && mouseX < shX + hotbarSlotSize && mouseY >= hotbarY && mouseY < hotbarY + hotbarSlotSize) {
            if (this.dragSource && this.dragSource.type === 'shop_buy') {
                const def = Inventory.ITEMS[this.dragItem.id];
                if (def.cost && def.cost.money) {
                    if (!Inventory.canAfford({ money: def.cost.money })) {
                        Game.showMessage(`Not enough money! Need $${def.cost.money}`, 1.5);
                        return true;
                    }
                    Inventory.payCost({ money: def.cost.money });
                }
                Shop.saleItems[this.dragSource.index] = null;
                Game.showMessage(`Bought ${def.name} for $${def.cost ? def.cost.money : 0}`, 1.5);
                this.dragSource = null;
            }

            if (this.secondHand && this.secondHand.id === this.dragItem.id && this.dragItem.stackable) {
                const space = this.secondHand.maxStack - this.secondHand.count;
                const add = Math.min(this.dragItem.count, space);
                this.secondHand.count += add;
                this.dragItem.count -= add;

                if (this.dragItem.count <= 0) {
                    this.dragItem = null;
                    this.dragSource = null;
                    return true;
                }
            }

            const temp = this.secondHand;
            this.secondHand = this.dragItem;
            this.dragItem = temp;

            if (this.dragItem) {
                this.dragSource = { type: 'secondHand', idx: 0 };
            } else {
                this.dragSource = null;
            }
            return true;
        }

        for (let i = 0; i < this.HOTBAR_SIZE; i++) {
            const sx = hotbarStartX + i * (hotbarSlotSize + hotbarGap);
            if (mouseX >= sx && mouseX < sx + hotbarSlotSize && mouseY >= hotbarY && mouseY < hotbarY + hotbarSlotSize) {
                if (this.dragSource && this.dragSource.type === 'shop_buy') {
                    const def = Inventory.ITEMS[this.dragItem.id];
                    if (def.cost && def.cost.money) {
                        if (!Inventory.canAfford({ money: def.cost.money })) {
                            Game.showMessage(`Not enough money! Need $${def.cost.money}`, 1.5);
                            return true;
                        }
                        Inventory.payCost({ money: def.cost.money });
                    }
                    Shop.saleItems[this.dragSource.index] = null;
                    Game.showMessage(`Bought ${def.name} for $${def.cost ? def.cost.money : 0}`, 1.5);
                    this.dragSource = null;
                }

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

        // --- Fallback if dropped in empty space ---
        if (this.dragItem) {
            // Did it come from the shop? If so, just cancel the purchase
            if (this.dragSource && this.dragSource.type === 'shop_buy') {
                this.dragItem = null;
                this.dragSource = null;
                return true;
            }

            // Return to its original slot
            if (this.dragSource) {
                if (this.dragSource.type === 'bag') {
                    // Try to put it back exactly where it was, or find any empty slot
                    if (!this.bag[this.dragSource.idx]) {
                        this.bag[this.dragSource.idx] = this.dragItem;
                    } else {
                        Inventory.addItem(this.dragItem.id, this.dragItem.count, this.dragItem.durability);
                    }
                } else if (this.dragSource.type === 'hotbar') {
                    if (!this.hotbar[this.dragSource.idx]) {
                        this.hotbar[this.dragSource.idx] = this.dragItem;
                    } else {
                        Inventory.addItem(this.dragItem.id, this.dragItem.count, this.dragItem.durability);
                    }
                } else if (this.dragSource.type === 'secondHand') {
                    if (!this.secondHand) {
                        this.secondHand = this.dragItem;
                    } else {
                        Inventory.addItem(this.dragItem.id, this.dragItem.count, this.dragItem.durability);
                    }
                } else if (this.dragSource.type === 'clothing') {
                    if (!this.clothing) {
                        this.clothing = this.dragItem;
                    } else {
                        Inventory.addItem(this.dragItem.id, this.dragItem.count, this.dragItem.durability);
                    }
                } else if (this.dragSource.type === 'chest') {
                    if (ChestUI.currentChest && !ChestUI.currentChest.inventory[this.dragSource.idx]) {
                        ChestUI.currentChest.inventory[this.dragSource.idx] = this.dragItem;
                    } else {
                        Inventory.addItem(this.dragItem.id, this.dragItem.count, this.dragItem.durability);
                    }
                } else if (this.dragSource.type === 'repair_shop') {
                    if (!RepairShop.repairSlot) {
                        RepairShop.repairSlot = this.dragItem;
                    } else {
                        Inventory.addItem(this.dragItem.id, this.dragItem.count, this.dragItem.durability);
                    }
                } else if (this.dragSource.type === 'anvil') {
                    if (!Anvil.repairSlot) {
                        Anvil.repairSlot = this.dragItem;
                    } else {
                        Inventory.addItem(this.dragItem.id, this.dragItem.count, this.dragItem.durability);
                    }
                } else if (this.dragSource.type === 'shop' || this.dragSource.type === 'shop_split') {
                    if (!Shop.sellSlot) {
                        Shop.sellSlot = this.dragItem;
                    } else {
                        Inventory.addItem(this.dragItem.id, this.dragItem.count, this.dragItem.durability);
                    }
                } else if (this.dragSource.type === 'bag_split') {
                    if (!this.bag[this.dragSource.idx]) {
                        this.bag[this.dragSource.idx] = this.dragItem;
                    } else {
                        Inventory.addItem(this.dragItem.id, this.dragItem.count, this.dragItem.durability);
                    }
                } else if (this.dragSource.type === 'hotbar_split') {
                    if (!this.hotbar[this.dragSource.idx]) {
                        this.hotbar[this.dragSource.idx] = this.dragItem;
                    } else {
                        Inventory.addItem(this.dragItem.id, this.dragItem.count, this.dragItem.durability);
                    }
                }
            } else {
                // If it somehow had no source, just add it to inventory
                Inventory.addItem(this.dragItem.id, this.dragItem.count, this.dragItem.durability);
            }

            this.dragItem = null;
            this.dragSource = null;
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

        // Render second hand to the left of the hotbar
        const totalW = this.HOTBAR_SIZE * (slotSize + gap) - gap;
        const startX = (canvasW - totalW) / 2;
        const y = canvasH - slotSize - 12;

        const shX = startX - slotSize - 20; // 20px gap to the left of hotbar
        const shY = y;

        // Second Hand slot background
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(shX, shY, slotSize, slotSize);
        ctx.strokeStyle = '#a3a3a3'; // different border color to distinguish
        ctx.lineWidth = 1;
        ctx.strokeRect(shX, shY, slotSize, slotSize);

        // Second Hand item
        if (this.secondHand) {
            this.renderItemIcon(ctx, this.secondHand, shX + 4, shY + 4, slotSize - 8);
        }

        // Second Hand Label / Number? No number, just an icon or implicit knowledge.
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '10px monospace';
        ctx.fillText("2nd", shX + 3, shY + 12);

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
        const { startX, startY, totalW, totalH, slotSize, gap, bagCols, bagRows } = this.getLayout(canvasW, canvasH);

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

        // Render second hand in bag view
        const bshX = startX - slotSize - 20;
        ctx.fillStyle = 'rgba(40,50,70,0.8)';
        ctx.fillRect(bshX, hotbarY, slotSize, slotSize);
        ctx.strokeStyle = '#a3a3a3';
        ctx.lineWidth = 1;
        ctx.strokeRect(bshX, hotbarY, slotSize, slotSize);

        if (this.secondHand) {
            this.renderItemIcon(ctx, this.secondHand, bshX + 6, hotbarY + 6, slotSize - 12);
        }

        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '10px monospace';
        ctx.fillText("2nd", bshX + 3, hotbarY + 12);

        // Render clothing slot in bag view
        const clothX = bshX;
        const clothY = hotbarY - slotSize - 20;
        ctx.fillStyle = 'rgba(40,50,70,0.8)';
        ctx.fillRect(clothX, clothY, slotSize, slotSize);
        ctx.strokeStyle = '#a3a3a3';
        ctx.lineWidth = 1;
        ctx.strokeRect(clothX, clothY, slotSize, slotSize);

        if (this.clothing) {
            this.renderItemIcon(ctx, this.clothing, clothX + 6, clothY + 6, slotSize - 12);
        }

        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '10px monospace';
        ctx.fillText("Cloth", clothX + 3, clothY + 12);

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
        if (assetName === 'rock') assetName = 'item_rock';
        if (assetName === 'item_chest') assetName = 'chest';
        if (item.id === 'torch' && item.lit !== true) assetName = 'torch_off';

        const img = Assets.get(assetName);
        if (img) {
            if (assetName === 'campfire_anim') {
                const fw = img.width / 3;
                const fh = img.height / 2;
                ctx.drawImage(img, 0, 0, fw, fh, 0, 0, size, size);
            } else {
                ctx.drawImage(img, 0, 0, size, size);
            }
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
            } else if (item.id === 'chest') {
                // Chest Icon Fallback
                ctx.fillStyle = '#6b4423';
                ctx.fillRect(4 * s, 8 * s, 24 * s, 20 * s);
                ctx.fillStyle = '#8b5a2b';
                ctx.fillRect(4 * s, 8 * s, 24 * s, 6 * s); // Lid
                ctx.fillStyle = '#ffd700'; // Lock
                ctx.fillRect(14 * s, 14 * s, 4 * s, 4 * s);
            } else if (item.id === 'tombstone') {
                // Tombstone Icon Fallback
                ctx.fillStyle = '#777';
                ctx.beginPath();
                ctx.moveTo(8 * s, 28 * s);
                ctx.lineTo(8 * s, 12 * s);
                ctx.arc(16 * s, 12 * s, 8 * s, Math.PI, 0);
                ctx.lineTo(24 * s, 28 * s);
                ctx.fill();
                ctx.strokeStyle = '#444';
                ctx.lineWidth = 1;
                ctx.stroke();
                ctx.fillStyle = '#333';
                ctx.font = `${8 * s}px monospace`;
                ctx.fillText("RIP", 12 * s, 18 * s);
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
