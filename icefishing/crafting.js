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
            costId: 'firewood',
            costAmount: 2,
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
            costId: 'firewood',
            costAmount: 1,
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
            costId: 'firewood',
            costAmount: 2,
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
            costId: 'firewood',
            costAmount: 1,
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
        }
    ],

    init() {
        this.isOpen = false;
    },

    toggle() {
        this.isOpen = !this.isOpen;
        if (this.isOpen) {
            Game.showMessage("Crafting Menu Opened", 1.5);
        }
    },

    close() {
        this.isOpen = false;
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

        if (!Inventory.hasItem(recipe.costId, recipe.costAmount)) {
            const def = Inventory.ITEMS[recipe.costId];
            Game.showMessage(`Need ${recipe.costAmount}x ${def ? def.name : recipe.costId}!`, 1.5);
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
                Inventory.removeItem(recipe.costId, recipe.costAmount);

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

        const w = 400;
        const h = 240;

        const x = (canvasW - w) / 2;
        const y = (canvasH - h) / 2 - 50;

        this.ui.x = x;
        this.ui.y = y;
        this.ui.w = w;
        this.ui.h = h;

        // Background
        ctx.fillStyle = '#222831';
        ctx.strokeStyle = '#f2a365';
        ctx.lineWidth = 3;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);

        // Title
        ctx.fillStyle = '#ececec';
        ctx.font = 'bold 20px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('CRAFTING', x + w / 2, y + 25);
        ctx.textAlign = 'left';

        ctx.fillStyle = '#a3a3a3';
        ctx.font = '12px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Select an item to build', x + w / 2, y + 45);
        ctx.textAlign = 'left';

        this.ui.craftItemBounds = [];
        const slotSize = 64;
        const gap = 20;

        const visibleRecipes = this.recipes
            .map((r, index) => ({ ...r, originalIndex: index }))
            .filter(r => !r.requiresItem || Inventory.hasItem(r.requiresItem, 1));

        const startX = x + (w - (visibleRecipes.length * slotSize + (visibleRecipes.length - 1) * gap)) / 2;
        const startY = y + 70;

        for (let i = 0; i < visibleRecipes.length; i++) {
            const recipe = visibleRecipes[i];
            const sx = startX + i * (slotSize + gap);
            const sy = startY;

            // Slot Background
            ctx.fillStyle = 'rgba(50, 60, 75, 0.8)';
            ctx.fillRect(sx, sy, slotSize, slotSize);
            ctx.strokeStyle = '#f2a365';
            ctx.lineWidth = 2;
            ctx.strokeRect(sx, sy, slotSize, slotSize);

            // Icon
            Inventory.renderItemIcon(ctx, { id: recipe.icon, stackable: false }, sx + 8, sy + 8, slotSize - 16);

            // Can afford?
            const afford = Inventory.hasItem(recipe.costId, recipe.costAmount);
            if (!afford) {
                ctx.fillStyle = 'rgba(255, 0, 0, 0.3)';
                ctx.fillRect(sx, sy, slotSize, slotSize);
            }

            // Target area for clicking
            this.ui.craftItemBounds.push({ x: sx, y: sy, w: slotSize, h: slotSize, recipeIndex: recipe.originalIndex });

            // Name
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 14px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(recipe.name, sx + slotSize / 2, sy + slotSize + 20);

            // Cost tag
            ctx.fillStyle = afford ? '#a3d2ca' : '#ff7b54';
            ctx.font = '12px monospace';
            const reqDef = Inventory.ITEMS[recipe.costId];
            const costText = `${recipe.costAmount}x ${reqDef ? reqDef.name : recipe.costId}`;
            ctx.fillText(costText, sx + slotSize / 2, sy + slotSize + 36);

            // Desc
            ctx.fillStyle = '#a3a3a3';
            ctx.font = '10px monospace';
            ctx.fillText(recipe.description, sx + slotSize / 2, sy + slotSize + 50);
            ctx.textAlign = 'left';
        }
    }
};
