// crafting.js - Handles the Crafting/Building Interface using the hammer
const Crafting = {
    isOpen: false,

    // UI bounds for click detection
    ui: {
        x: 0, y: 0, w: 0, h: 0,
        craftItemBounds: []
    },

    recipes: [
        {
            id: 'campfire',
            name: 'Campfire',
            description: 'Unlit. Use Flint & Steel.',
            cost: { firewood: 2 },
            icon: 'campfire_off',
            onBuild: (playerX) => {
                const col = World.getColumnAt(playerX);
                if (!col || col.type === 'water') {
                    Game.showMessage("Can't build campfire here!", 1.5);
                    return false;
                }
                const fire = World.addCampfire(playerX);
                if (fire) {
                    fire.lit = false;
                    Game.showMessage("Built Campfire! Light it with Flint & Steel.", 2);
                    return true;
                }
                return false;
            }
        },
        {
            id: 'torch',
            name: 'Torch',
            description: 'Unlit. Use Flint & Steel.',
            cost: { firewood: 1 },
            icon: 'torch_off',
            onBuild: (playerX) => {
                const col = World.getColumnAt(playerX);
                if (!col || col.type === 'water') {
                    Game.showMessage("Can't build torch here!", 1.5);
                    return false;
                }
                const torch = World.addTorch(playerX, 100);
                if (torch) {
                    torch.lit = false;
                    Game.showMessage("Built Torch! Light it with Flint & Steel.", 2);
                    return true;
                }
                return false;
            }
        },
        {
            id: 'campfire_lit',
            name: 'Lit Campfire',
            description: 'Use Flint & Steel.',
            cost: { firewood: 2 },
            requiresItem: 'flint_steel',
            icon: 'campfire_on',
            onBuild: (playerX) => {
                const col = World.getColumnAt(playerX);
                if (!col || col.type === 'water') {
                    Game.showMessage("Can't build campfire here!", 1.5);
                    return false;
                }
                const fire = World.addCampfire(playerX);
                if (fire) {
                    fire.lit = true;
                    Inventory.damageItemById('flint_steel', 1);
                    Game.showMessage("Built a Lit Campfire!", 2);
                    return true;
                }
                return false;
            }
        },
        {
            id: 'torch_lit',
            name: 'Lit Torch',
            description: 'Use Flint & Steel.',
            cost: { firewood: 1 },
            requiresItem: 'flint_steel',
            icon: 'torch',
            onBuild: (playerX) => {
                const col = World.getColumnAt(playerX);
                if (!col || col.type === 'water') {
                    Game.showMessage("Can't build torch here!", 1.5);
                    return false;
                }
                const torch = World.addTorch(playerX, 100);
                if (torch) {
                    torch.lit = true;
                    Inventory.damageItemById('flint_steel', 1);
                    Game.showMessage("Built a Lit Torch!", 2);
                    return true;
                }
                return false;
            }
        },
        {
            id: 'simple_bridge',
            name: 'Simple Bridge',
            description: 'Walk over water.',
            cost: { firewood: 10 },
            icon: 'simple_bridge',
            onBuild: (playerX) => {
                const targetX = playerX + Player.facing * World.TILE_SIZE * 1.5;
                if (World.addBridge(targetX)) {
                    Game.showMessage('Built a bridge!', 2);
                    return true;
                } else {
                    Game.showMessage('Cannot build here!', 2);
                    return false;
                }
            }
        },
        {
            id: 'chest',
            name: 'Chest',
            description: 'Store items (8x5).',
            cost: { firewood: 5 },
            icon: 'item_chest',
            onBuild: (playerX) => {
                if (World.addChest(playerX)) {
                    Game.showMessage('Placed a chest!', 2);
                    return true;
                } else {
                    Game.showMessage("Can't place chest here!", 1.5);
                    return false;
                }
            }
        }
    ],

    init() {
        this.isOpen = false;
    },

    toggle() {
        this.isOpen = !this.isOpen;
        if (this.isOpen) {
            Inventory.isOpen = true;
            Game.showMessage("Crafting Menu Opened", 1.5);
        } else {
            this.close();
        }
    },

    close() {
        this.isOpen = false;
        if (Shop.isOpen || RepairShop.isOpen || Anvil.isOpen) return; // let inventory naturally follow the next window or close
        Inventory.isOpen = false;
    },

    handleMouseDown(mouseX, mouseY, canvasW, canvasH, button = 0) {
        if (!this.isOpen) return false;

        for (let i = 0; i < this.ui.craftItemBounds.length; i++) {
            const b = this.ui.craftItemBounds[i];
            if (mouseX >= b.x && mouseX <= b.x + b.w && mouseY >= b.y && mouseY <= b.y + b.h) {
                this.craftItem(b.recipeIndex, button);
                return true;
            }
        }

        // If clicked inside the UI window but not on a button, still consume the click
        if (mouseX >= this.ui.x && mouseX <= this.ui.x + this.ui.w && mouseY >= this.ui.y && mouseY <= this.ui.y + this.ui.h) {
            return true;
        }

        return false;
    },

    craftItem(recipeIndex, button = 0) {
        const recipe = this.recipes[recipeIndex];

        if (!Inventory.canAfford(recipe.cost)) {
            Game.showMessage('Not enough materials!', 1.5);
            return;
        }

        // Attempt build
        Player.startAction(1.5, 'chopping', () => {
            let success = false;

            if (button === 2 && !recipe.id.includes('campfire')) {
                // Right click -> put in second hand instead of building in world
                success = true;

                let isLit = recipe.id.includes('_lit');
                let itemToGive = { ...Inventory.ITEMS['torch'], count: 1, lit: isLit };
                if (Inventory.ITEMS['torch'].maxDurability) {
                    itemToGive.durability = Inventory.ITEMS['torch'].maxDurability;
                }

                Inventory.moveToSecondHand(itemToGive);
                // The cost of flint_steel for the lit version was defined in recipe.requiresItem and handled in onBuild.
                // We must handle damage manually here since onBuild is skipped.
                if (isLit) {
                    Inventory.damageItemById('flint_steel', 1);
                }
                Game.showMessage(`Crafted ${recipe.name} to Second Hand!`, 2);
            } else {
                success = recipe.onBuild(Player.x);
            }

            if (success) {
                Inventory.payCost(recipe.cost);

                // Damage hammer
                for (let i = 0; i < Inventory.HOTBAR_SIZE; i++) {
                    let item = Inventory.hotbar[i];
                    if (item && item.id === 'hammer') {
                        item.durability -= 1;
                        if (item.durability <= 0) {
                            Inventory.hotbar[i] = null;
                            Game.showMessage('Hammer broke!', 2);
                            this.close();
                        }
                        break;
                    }
                }
            }
        });

        // Close UI while building
        this.close();
    },

    render(ctx, canvasW, canvasH) {
        if (!this.isOpen) return;

        const bounds = UIMenu.renderMenuBase(ctx, canvasW, canvasH, 'CRAFTING', this);

        const visibleRecipes = this.recipes
            .map((r, index) => ({ ...r, originalIndex: index }))
            .filter(r => !r.requiresItem || Inventory.hasItem(r.requiresItem, 1));

        this.ui.craftItemBounds = UIMenu.renderLeftGrid(ctx, bounds, 'Select an item to build:', visibleRecipes, (c, recipe, i, sx, sy, slotSize) => {
            // Icon
            Inventory.renderItemIcon(c, { id: recipe.icon, stackable: false, lit: recipe.id.includes('_lit') }, sx + 8, sy + 8, slotSize - 16);

            // Can afford?
            const afford = Inventory.canAfford(recipe.cost);
            if (!afford) {
                c.fillStyle = 'rgba(255, 0, 0, 0.3)';
                c.fillRect(sx, sy, slotSize, slotSize);
            }

            // Cost tags
            let cIdx = 0;
            const costKeys = Object.keys(recipe.cost);
            const tagW = costKeys.length * 36;
            let startTx = sx + slotSize / 2 - tagW / 2;

            for (const key of costKeys) {
                const amount = recipe.cost[key];
                Inventory.renderItemIcon(c, { id: key, stackable: false }, startTx + cIdx * 36, sy + slotSize + 12, 14);
                c.fillStyle = Inventory.hasItem(key, amount) ? '#a3d2ca' : '#ff7b54';
                c.font = '10px monospace';
                c.textAlign = 'left';
                c.fillText(`${amount}`, startTx + cIdx * 36 + 18, sy + slotSize + 22);
                cIdx++;
            }
        });

        // Remap the interaction bounds for crafting click targeting
        this.ui.craftItemBounds.forEach(b => {
            b.recipeIndex = b.item.originalIndex;
        });
    }
};
