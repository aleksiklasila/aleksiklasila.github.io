// game.js — Main game loop, input handling, camera, HUD
const Game = {
    canvas: null,
    ctx: null,
    width: 0,
    height: 0,

    camera: { x: 0, y: 0 },
    originX: 0,

    keys: {},
    keysJustPressed: {},
    mouseX: 0,
    mouseY: 0,

    lastTime: 0,
    nextFrameTime: 0,
    fps: 0,
    fpsFrames: 0,
    fpsLastTime: 0,
    fpsLocked: false,
    targetFPS: 60,
    running: false,
    gameOver: false,

    messageText: '',
    messageTimer: 0,

    tutorialStep: 0,
    tutorialShown: {},

    init() {
        const startBtn = document.getElementById('start-btn');
        if (startBtn) startBtn.innerText = "LOADING...";

        Assets.init(() => {
            const titleScreen = document.getElementById('title-screen');
            if (titleScreen) titleScreen.style.display = 'none';

            this.canvas = document.getElementById('game');
            this.ctx = this.canvas.getContext('2d');
            this.resize();

            this.setupInputs();

            // Initialize lighting system
            Lighting.init();

            this.startNewGame();
        });
    },

    setupInputs() {
        window.addEventListener('keydown', e => {
            if (!this.keys[e.code]) this.keysJustPressed[e.code] = true;
            this.keys[e.code] = true;
            e.preventDefault();
        });
        window.addEventListener('keyup', e => {
            this.keys[e.code] = false;
            e.preventDefault();
        });
        window.addEventListener('wheel', e => {
            if (!Fishing.active) {
                Inventory.scrollSlot(e.deltaY > 0 ? 1 : -1);
            }
        });

        this.canvas.addEventListener('contextmenu', e => {
            e.preventDefault();
        });

        this.canvas.addEventListener('mousemove', e => {
            const rect = this.canvas.getBoundingClientRect();
            this.mouseX = e.clientX - rect.left;
            this.mouseY = e.clientY - rect.top;
        });

        this.canvas.addEventListener('mousedown', e => {
            // Only handle left and right clicks
            if (e.button !== 0 && e.button !== 2) return;

            const rect = this.canvas.getBoundingClientRect();
            this.mouseX = e.clientX - rect.left;
            this.mouseY = e.clientY - rect.top;

            if (e.button === 0 && this.mouseX >= 5 && this.mouseX <= 110 && this.mouseY >= this.height - 25 && this.mouseY <= this.height - 5) {
                this.fpsLocked = !this.fpsLocked;
                return;
            }

            // Click Shop UI
            if (Shop.isOpen) {
                if (Shop.handleMouseDown(this.mouseX, this.mouseY, this.width, this.height, e.shiftKey, e.ctrlKey, e.button)) return;
            }

            // Click Repair Shop UI
            if (RepairShop.isOpen) {
                if (RepairShop.handleMouseDown(this.mouseX, this.mouseY, this.width, this.height, e.shiftKey, e.ctrlKey, e.button)) return;
            }

            // Click Crafting UI
            if (Crafting.isOpen) {
                if (Crafting.handleMouseDown(this.mouseX, this.mouseY, this.width, this.height, e.button)) return;
            }

            // Click Anvil UI
            if (Anvil.isOpen) {
                if (Anvil.handleMouseDown(this.mouseX, this.mouseY, this.width, this.height, e.shiftKey, e.ctrlKey, e.button)) return;
            }

            // Click Inventory UI
            if (Inventory.isOpen) {
                if (Inventory.handleMouseDown(this.mouseX, this.mouseY, this.width, this.height, e.shiftKey, e.ctrlKey, e.button)) return;
            }
            // Always check hotbar clicks (even if inventory is closed)
            else {
                if (Inventory.handleMouseDown(this.mouseX, this.mouseY, this.width, this.height, e.shiftKey, e.ctrlKey, e.button)) return;
            }

            // Click on Shop Building in World
            if (!this.gameOver && !Fishing.active && World.shop && e.button === 0) {
                const sx = World.shop.x - this.camera.x + this.width / 2;
                const sy = (this.height * 0.6) - World.shop.surfaceY - 128;
                // Shop image is 128x128
                if (this.mouseX >= sx - 64 && this.mouseX <= sx + 64 && this.mouseY >= sy && this.mouseY <= sy + 128) {
                    Shop.toggle();
                    return;
                }
            }

            // Click on Repair Shop Building in World
            if (!this.gameOver && !Fishing.active && World.repairShop && e.button === 0) {
                const sx = World.repairShop.x - this.camera.x + this.width / 2;
                const sy = (this.height * 0.6) - World.repairShop.surfaceY - 128;
                if (this.mouseX >= sx - 64 && this.mouseX <= sx + 64 && this.mouseY >= sy && this.mouseY <= sy + 128) {
                    RepairShop.toggle();
                    return;
                }
            }

            // Handle clicking world items (Tents and Torches) to pick them up
            if (!this.gameOver && !Fishing.active && Player.actionTimer <= 0 && !Shop.isOpen && !RepairShop.isOpen && !Inventory.isOpen && !Crafting.isOpen && !Anvil.isOpen) {
                const worldX = this.mouseX + this.camera.x - this.width / 2;
                const baseY = this.height * 0.6;

                // Check if worldX is close enough to Player to pick up (e.g. within 60px)
                if (Math.abs(Player.x - worldX) < 100) {
                    // Check Ground Items
                    if (World.groundItems) {
                        for (let i = 0; i < World.groundItems.length; i++) {
                            const gItem = World.groundItems[i];
                            const itemScreenY = baseY - gItem.surfaceY - 8;
                            if (Math.abs(gItem.x - worldX) < 30 && Math.abs(this.mouseY - itemScreenY) < 30) {
                                const pickedItem = World.removeGroundItemNear(worldX);
                                if (pickedItem) {
                                    if (e.button === 2) {
                                        Inventory.moveToSecondHand(pickedItem);
                                    } else {
                                        Inventory.addItem(pickedItem.id, pickedItem.count, pickedItem.durability);
                                    }
                                    Game.showMessage('Picked up ' + pickedItem.name, 1.5);
                                    return;
                                }
                            }
                        }
                    }
                    // Check Tents
                    for (let i = 0; i < World.tents.length; i++) {
                        const tent = World.tents[i];
                        const tentScreenY = baseY - tent.surfaceY - 18;
                        if (Math.abs(tent.x - worldX) < 40 && Math.abs(this.mouseY - tentScreenY) < 40) {
                            const removedTentDurability = World.removeTentNear(worldX);
                            if (removedTentDurability !== false) {
                                if (removedTentDurability <= 0) {
                                    Game.showMessage('The tent fell apart as you picked it up!', 2);
                                } else {
                                    const tentItem = { ...Inventory.ITEMS['tent'], count: 1, durability: removedTentDurability };
                                    if (e.button === 2) {
                                        Inventory.moveToSecondHand(tentItem);
                                    } else {
                                        Inventory.addItem('tent', 1, removedTentDurability);
                                    }
                                    Game.showMessage('Picked up tent.', 1.5);
                                }
                            }
                            return; // Stop after picking something up
                        }
                    }

                    // Check Torches
                    if (World.torches) {
                        for (let i = 0; i < World.torches.length; i++) {
                            const torch = World.torches[i];
                            const torchScreenY = baseY - torch.surfaceY - 15;
                            if (Math.abs(torch.x - worldX) < 30 && Math.abs(this.mouseY - torchScreenY) < 30) {
                                const torchData = World.removeTorchNear(worldX);
                                if (torchData !== false) {
                                    const torchItem = { ...Inventory.ITEMS['torch'], count: 1, durability: torchData.fuel, lit: !!torchData.lit };
                                    if (e.button === 2) {
                                        Inventory.moveToSecondHand(torchItem);
                                    } else {
                                        Inventory.addItem('torch', 1, torchData.fuel);
                                        // Update newly added lit torch
                                        if (torchItem.lit) {
                                            let found = false;
                                            for (let j = Inventory.HOTBAR_SIZE - 1; j >= 0 && !found; j--) {
                                                if (Inventory.hotbar[j] && Inventory.hotbar[j].id === 'torch' && Inventory.hotbar[j].durability === torchData.fuel) {
                                                    Inventory.hotbar[j].lit = true;
                                                    found = true;
                                                }
                                            }
                                            for (let j = Inventory.BAG_SIZE - 1; j >= 0 && !found; j--) {
                                                if (Inventory.bag[j] && Inventory.bag[j].id === 'torch' && Inventory.bag[j].durability === torchData.fuel) {
                                                    Inventory.bag[j].lit = true;
                                                    found = true;
                                                }
                                            }
                                        }
                                    }
                                    Game.showMessage('Picked up torch.', 1.5);
                                }
                                return;
                            }
                        }
                    }
                }

                // If no item picked up, try using the selected item
                if (e.button === 0) {
                    Survival.useItem(Player.x, false);
                } else if (e.button === 2) {
                    Survival.useItem(Player.x, true);
                }
            }
        });

        this.canvas.addEventListener('mouseup', e => {
            if (e.button !== 0) return;

            const rect = this.canvas.getBoundingClientRect();
            this.mouseX = e.clientX - rect.left;
            this.mouseY = e.clientY - rect.top;

            let droppedInUI = false;

            if (Shop.isOpen) {
                droppedInUI = Shop.handleMouseUp(this.mouseX, this.mouseY, this.width, this.height);
            }

            if (!droppedInUI && RepairShop.isOpen) {
                droppedInUI = RepairShop.handleMouseUp(this.mouseX, this.mouseY, this.width, this.height);
            }

            if (!droppedInUI && Anvil.isOpen) {
                droppedInUI = Anvil.handleMouseUp(this.mouseX, this.mouseY, this.width, this.height);
            }

            if (!droppedInUI && Inventory.isOpen) {
                droppedInUI = Inventory.handleMouseUp(this.mouseX, this.mouseY, this.width, this.height);
            }
            if (!droppedInUI && !Inventory.isOpen) {
                droppedInUI = Inventory.handleMouseUp(this.mouseX, this.mouseY, this.width, this.height);
            }

            if (!droppedInUI && Inventory.dragItem && Inventory.dragSource) {
                // If buying from shop and dropping to world, still charge
                if (Inventory.dragSource.type === 'shop_buy') {
                    const def = Inventory.ITEMS[Inventory.dragItem.id];
                    if (def.cost && def.cost.money) {
                        if (!Inventory.canAfford({ money: def.cost.money })) {
                            Game.showMessage(`Not enough money! Need $${def.cost.money}`, 1.5);
                            Inventory.dragItem = null;
                            Inventory.dragSource = null;
                            return;
                        }
                        Inventory.payCost({ money: def.cost.money });
                    }
                    Shop.saleItems[Inventory.dragSource.index] = null;
                    Game.showMessage(`Bought and dropped ${def.name} for $${def.cost ? def.cost.money : 0}`, 1.5);
                }

                // Drop into the world
                const worldX = this.mouseX + this.camera.x - this.width / 2;

                if (Inventory.dragItem.id === 'torch' && Inventory.dragItem.lit) {
                    const placed = World.addTorch(worldX, Inventory.dragItem.durability, true);
                    if (!placed) {
                        World.addGroundItem(worldX, Inventory.dragItem);
                    }
                } else {
                    World.addGroundItem(worldX, Inventory.dragItem);
                }

                if (Inventory.dragSource.type !== 'shop_buy') {
                    Game.showMessage('Dropped ' + Inventory.dragItem.name, 1.5);
                }
                Inventory.dragItem = null;
                Inventory.dragSource = null;
            }
        });

        window.addEventListener('resize', () => this.resize());
    },

    resize() {
        this.width = window.innerWidth;
        this.height = window.innerHeight;
        this.canvas.width = this.width;
        this.canvas.height = this.height;
    },

    startNewGame() {
        this.gameOver = false;
        this.messageText = '';
        this.messageTimer = 0;
        this.tutorialShown = {};

        World.generate();
        Voxels.generate();
        Inventory.init();
        Shop.init();
        RepairShop.init();
        Crafting.init();
        Anvil.init();

        // Add starter unlit torch to hotbar
        const starterTorch = Inventory.createItem('torch', 1);
        starterTorch.lit = false;
        Inventory.hotbar[7] = starterTorch;

        // Add starter shovel to hotbar
        const starterShovel = Inventory.createItem('shovel', 1);
        Inventory.hotbar[6] = starterShovel;

        // Add starter money
        Inventory.addItem('money', 100);

        // Add starter pickaxe, anvil, and tent to bag
        Inventory.bag[1] = Inventory.createItem('pickaxe');
        Inventory.bag[2] = Inventory.createItem('anvil');
        Inventory.bag[3] = Inventory.createItem('tent');

        Survival.init();
        Fishing.init();
        Fishing.generateWorldFish();

        let startX = World.WORLD_WIDTH * World.TILE_SIZE / 2;
        for (let i = Math.floor(World.WORLD_WIDTH / 2); i < World.WORLD_WIDTH; i++) {
            if (World.columns[i].type === 'ground') { startX = i * World.TILE_SIZE; break; }
        }

        Player.init(startX);
        this.originX = startX;
        Difficulty.originX = startX;
        this.camera.x = Player.x;
        this.camera.y = 0;

        this.showMessage('Survive the frozen wilderness. Press E for inventory.', 4);

        this.running = true;
        this.lastTime = performance.now();
        requestAnimationFrame(t => this.loop(t));
    },

    loop(timestamp) {
        if (!this.running) return;

        if (this.fpsLocked) {
            if (!this.nextFrameTime) this.nextFrameTime = timestamp;
            const frameDelay = 1000 / this.targetFPS;

            // 40% frame delay tolerance prevents rejecting native 60Hz 
            // requestAnimationFrame timings due to browser jitter,
            // while successfully throttling 120Hz/144Hz setups to 60 FPS.
            if (timestamp < this.nextFrameTime - (frameDelay * 0.4)) {
                requestAnimationFrame(t => this.loop(t));
                return;
            }

            this.nextFrameTime += frameDelay;
            // Catch up if execution paused (e.g. background tab)
            if (timestamp > this.nextFrameTime + (frameDelay * 2)) {
                this.nextFrameTime = timestamp;
            }
        } else {
            this.nextFrameTime = 0; // reset for clean lock re-entry
        }

        const dt = Math.min((timestamp - this.lastTime) / 1000, 0.05);
        this.lastTime = timestamp;

        if (!this.fpsLastTime) this.fpsLastTime = timestamp;
        this.fpsFrames++;
        if (timestamp - this.fpsLastTime >= 1000) {
            // Precise adjustment: If we are locked and running smoothly, we clamp the displayed FPS to prevent
            // reporting 61, 62 etc. due to tiny requestAnimationFrame jitter over the second.
            let computedFps = this.fpsFrames;
            if (this.fpsLocked) {
                // If it's hitting 59, 60, 61, 62, clamp it to 60 for consistency
                if (computedFps >= this.targetFPS - 1 && computedFps <= this.targetFPS + 2) {
                    computedFps = this.targetFPS;
                }
            }
            this.fps = computedFps;
            this.fpsFrames = 0;
            this.fpsLastTime = timestamp;
        }

        this.update(dt);
        this.render();
        this.keysJustPressed = {};
        requestAnimationFrame(t => this.loop(t));
    },

    update(dt) {
        if (this.gameOver) {
            if (this.keysJustPressed['Space']) this.startNewGame();
            return;
        }

        if (this.keysJustPressed['KeyE'] && !Fishing.active) Inventory.toggle();

        // If shop or repair shop is open, handle them.
        if (Shop.isOpen || RepairShop.isOpen) {
            // Close with W, A, S, or D
            if (this.keysJustPressed['KeyW'] || this.keysJustPressed['KeyS'] || this.keysJustPressed['KeyA'] || this.keysJustPressed['KeyD']) {
                if (Shop.isOpen) Shop.close();
                if (RepairShop.isOpen) RepairShop.close();
            } else {
                // Check if player walked away
                if (Shop.isOpen && Math.abs(Player.x - World.shop.x) >= 100) {
                    Shop.close();
                }
                if (RepairShop.isOpen && Math.abs(Player.x - World.repairShop.x) >= 100) {
                    RepairShop.close();
                }
            }
        }

        if (Inventory.isOpen || Crafting.isOpen || Anvil.isOpen) {
            if (this.keysJustPressed['KeyW'] || this.keysJustPressed['KeyS'] || this.keysJustPressed['KeyA'] || this.keysJustPressed['KeyD']) {
                Inventory.isOpen = false;
                Crafting.isOpen = false;
                Anvil.close();
            }
        }

        if (Inventory.isOpen || Shop.isOpen || RepairShop.isOpen || Crafting.isOpen || Anvil.isOpen) return;

        // Item use is now handled by left-click (in setupInputs)

        Player.update(dt, this.keys);
        Survival.update(dt);
        World.update(dt);
        Fishing.update(dt, this.keys, this.keysJustPressed);

        this.camera.x += (Player.x - this.camera.x) * 0.08;

        if (Player.isDead) this.gameOver = true;

        if (this.messageTimer > 0) this.messageTimer -= dt;
        this.checkTutorials();
    },

    checkTutorials() {
        const col = World.getColumnAt(Player.x);
        if (!col) return;
        if (col.type === 'ice' && !this.tutorialShown.ice) {
            this.showMessage('Ice! Use ICE DRILL (slot 1) + CLICK to make a fishing hole.', 4);
            this.tutorialShown.ice = true;
        }
        if (Player.stats.warmth < 40 && !this.tutorialShown.cold) {
            this.showMessage('Getting cold! Chop trees (AXE+CLICK) and make fire (FLINT+CLICK).', 4);
            this.tutorialShown.cold = true;
        }
        if (Player.stats.hunger < 40 && !this.tutorialShown.hungry) {
            this.showMessage('Getting hungry! Catch and cook fish, or eat raw.', 3);
            this.tutorialShown.hungry = true;
        }
        if (Player.stats.thirst < 40 && !this.tutorialShown.thirsty) {
            this.showMessage('Thirsty! Press F to eat snow (costs warmth).', 3);
            this.tutorialShown.thirsty = true;
        }
    },

    showMessage(text, duration = 2) {
        this.messageText = text;
        this.messageTimer = duration;
    },

    render() {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.width, this.height);

        // 1. Sky and mountains
        World.render(ctx, this.camera, this.width, this.height, Survival.timeOfDay);

        // 2. Voxel terrain (ground, ice, water, lakebed)
        Voxels.render(ctx, this.camera, this.width, this.height);

        // 3. Fish and fishing line
        Fishing.render(ctx, this.camera, this.width, this.height);

        // 4. Surface objects (holes, tents, trees, campfires)
        World.renderObjects(ctx, this.camera, this.width, this.height);

        // 5. Player
        Player.render(ctx, this.camera, this.width, this.height);

        // 6. GPU Lighting overlay
        this.updateLights();
        Lighting.render(this.camera, this.width, this.height);
        Lighting.composite(ctx);

        // 7. Survival overlays (night tint is now handled by lighting ambient)
        Survival.renderOverlays(ctx, this.width, this.height);

        // 8. UI Screens (Shop / Repair Shop / Inventory / Crafting)
        if (Shop.isOpen || RepairShop.isOpen || Inventory.isOpen || Crafting.isOpen || Anvil.isOpen) {
            ctx.fillStyle = 'rgba(0,0,0,0.8)';
            ctx.fillRect(0, 0, this.width, this.height);
        }

        Shop.render(ctx, this.width, this.height);
        RepairShop.render(ctx, this.width, this.height);
        Inventory.render(ctx, this.width, this.height);
        Crafting.render(ctx, this.width, this.height);
        Anvil.render(ctx, this.width, this.height);

        // 9. HUD
        this.renderHUD(ctx);

        // Render dragged item
        if (Inventory.dragItem) {
            Inventory.renderItemIcon(ctx, Inventory.dragItem, this.mouseX - 20, this.mouseY - 20, 40);
        }

        this.renderFPS(ctx);

        this.renderMessage(ctx);

        if (this.gameOver) this.renderGameOver(ctx);
    },

    renderFPS(ctx) {
        const text = `FPS: ${this.fps || 0}${this.fpsLocked ? ' (60)' : ''}`;
        const extW = this.fpsLocked ? 40 : 0;
        ctx.fillStyle = this.fpsLocked ? 'rgba(50,80,50,0.8)' : 'rgba(0,0,0,0.5)';
        ctx.fillRect(5, this.height - 25, 65 + extW, 20);
        ctx.fillStyle = this.fps >= 50 ? '#00ff00' : (this.fps >= 30 ? '#ffff00' : '#ff0000');
        ctx.font = '12px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(text, 10, this.height - 10);
    },

    updateLights() {
        Lighting.clearLights();

        const baseY = this.height * 0.6;

        // --- Sun: directional light rotating around the player ---
        // timeOfDay: 0=midnight, 0.25=sunrise, 0.5=noon, 0.75=sunset
        // Sun angle: 0.25 (sunrise) -> left (PI), 0.5 (noon) -> up (PI/2), 0.75 (sunset) -> right (0)
        const sunAngle = Math.PI - (Survival.timeOfDay - 0.25) * Math.PI * 2;
        // Direction from surface TO sun
        const sunDirX = Math.cos(sunAngle);
        const sunDirY = -Math.sin(sunAngle); // Negative because screen Y grows downward

        // Keep sun mostly bright during the day, fading entirely at midnight
        let sunIntensity = Math.min(1.0, Math.sin(Survival.timeOfDay * Math.PI) * 1.5);
        if (Survival.stormActive) sunIntensity *= 0.4;
        Lighting.setSunDir(sunDirX, sunDirY, sunIntensity);

        // --- Player vision ---
        const playerSX = Player.x - this.camera.x + this.width / 2;
        const playerSY = baseY - Player.y - 25;
        const visionRadius = Survival.stormActive ? 350 : 600;
        Lighting.setPlayerVision(playerSX, playerSY, visionRadius);

        // --- Campfire lights (culled to on-screen) ---
        for (const fire of World.campfires) {
            if (!fire.lit) continue;
            const sx = fire.x - this.camera.x + this.width / 2;
            const sy = baseY - fire.surfaceY;
            // Cull: skip if too far off-screen
            if (sx < -430 || sx > this.width + 430) continue;
            Lighting.addLight(sx, sy - 15, 400, 1.0, 0.65, 0.25, 0.9);
        }

        // --- Ground torch lights (culled to on-screen) ---
        if (World.torches) {
            for (const torch of World.torches) {
                if (!torch.lit) continue;
                const sx = torch.x - this.camera.x + this.width / 2;
                const sy = baseY - torch.surfaceY;
                if (sx < -330 || sx > this.width + 330) continue;
                Lighting.addLight(sx, sy - 20, 300, 1.0, 0.7, 0.3, 0.8);
            }
        }

        // --- Carried torch light ---
        const heldItem = Inventory.getSelectedItem();
        if (heldItem && heldItem.id === 'torch' && heldItem.lit && heldItem.durability > 0) {
            Lighting.addLight(playerSX, playerSY - 10, 300, 1.0, 0.7, 0.3, 0.8);
        }

        // --- Second hand torch light ---
        const offHandItem = Inventory.secondHand;
        if (offHandItem && offHandItem.id === 'torch' && offHandItem.lit && offHandItem.durability > 0) {
            Lighting.addLight(playerSX, playerSY - 10, 300, 1.0, 0.7, 0.3, 0.8);
        }
    },

    renderHUD(ctx) {
        const barW = 140, barH = 14, startX = 15, gap = 22;
        let y = 15;

        const stats = [
            { key: 'warmth', label: '🔥 WARMTH', color: '#ff6633', bgColor: '#441100' },
            { key: 'hunger', label: '🍖 HUNGER', color: '#44bb44', bgColor: '#003300' },
            { key: 'thirst', label: '💧 THIRST', color: '#3388ff', bgColor: '#001144' },
            { key: 'sleep', label: '😴 SLEEP', color: '#bb88ff', bgColor: '#220044' }
        ];

        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(startX - 5, y - 5, barW + 60, stats.length * gap + 10);

        for (const stat of stats) {
            const val = Player.stats[stat.key];
            ctx.fillStyle = '#ccc'; ctx.font = '10px monospace';
            ctx.fillText(stat.label, startX, y + 10);
            const bx = startX + 85;
            ctx.fillStyle = stat.bgColor; ctx.fillRect(bx, y, barW, barH);
            ctx.fillStyle = val < 25 ? '#ff2200' : stat.color;
            ctx.fillRect(bx, y, barW * (val / 100), barH);
            if (val < 20) {
                ctx.fillStyle = `rgba(255,0,0,${Math.sin(Date.now() / 200) * 0.3 + 0.3})`;
                ctx.fillRect(bx, y, barW, barH);
            }
            if (stat.key === 'warmth') {
                // Map 0-100 warmth to 34.0C - 37.0C
                const bodyTemp = 34.0 + (val / 100) * 3.0;
                ctx.fillText(`${bodyTemp.toFixed(1)}°C`, bx + barW + 5, y + 11);
            } else {
                ctx.fillText(`${Math.round(val)}`, bx + barW + 5, y + 11);
            }
            y += gap;
        }

        y += 5;
        // Adjust for wider time + temp box
        ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(startX - 5, y - 2, 175, 40);
        const hours = Math.floor(Survival.timeOfDay * 24);
        const mins = Math.floor((Survival.timeOfDay * 24 - hours) * 60);
        ctx.fillStyle = Survival.isNight ? '#8888cc' : '#ffffaa';
        ctx.font = '12px monospace';
        ctx.fillText(`Day ${Survival.dayCount}  ${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`, startX, y + 14);

        ctx.fillStyle = '#ffaa44';
        const cTemp = Survival.currentTemp.toFixed(1);
        const fTemp = Survival.feelsLikeTemp.toFixed(1);
        ctx.fillText(`Temp: ${cTemp}°C`, startX, y + 28);
        ctx.fillStyle = '#ccccff';
        ctx.fillText(`(Feels: ${fTemp}°C)`, startX + 90, y + 28);

        y += 38;

        if (Survival.stormActive) {
            ctx.fillStyle = 'rgba(200,0,0,0.7)'; ctx.font = 'bold 12px monospace';
            ctx.fillText('⚠ STORM', startX, y + 12);
            y += 16;
        }
        if (World.isPlayerInTent(Player.x)) {
            ctx.fillStyle = 'rgba(60,120,60,0.7)'; ctx.font = 'bold 11px monospace';
            ctx.fillText('🏕 IN TENT', startX, y + 12);
            y += 16;
        }

        const moneyCount = Inventory.countItem('money');
        ctx.fillStyle = 'rgba(255,215,0,0.8)';
        ctx.font = 'bold 14px monospace';
        ctx.fillText(`💵 $${moneyCount}`, startX, y + 15);

        const woodCount = Inventory.countItem('firewood');
        ctx.fillStyle = '#f2a365';
        ctx.fillText(`🪵 ${woodCount}`, startX + 90, y + 15);

        const rockCount = Inventory.countItem('rock');
        ctx.fillStyle = '#aaa';
        ctx.fillText(`🪨 ${rockCount}`, startX + 140, y + 15);

        const selectedItem = Inventory.getSelectedItem();
        if (selectedItem) {
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            const nameW = ctx.measureText(selectedItem.name).width + 20;
            ctx.fillRect(this.width / 2 - nameW / 2, this.height - 72, nameW, 18);
            ctx.fillStyle = '#ddd'; ctx.font = '12px monospace'; ctx.textAlign = 'center';
            ctx.fillText(selectedItem.name, this.width / 2, this.height - 58);
            ctx.textAlign = 'left';
        }

        ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.font = '10px monospace'; ctx.textAlign = 'right';
        ctx.fillText('A/D Move  SCROLL Items  CLICK Use  E Inventory', this.width - 10, 15);
        ctx.textAlign = 'left';

        if (Player.actionTimer > 0) {
            const progress = 1 - (Player.actionTimer / 2.5);
            const pbW = 100, pbH = 8;
            const pbX = this.width / 2 - pbW / 2, pbY = this.height * 0.4;
            ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(pbX - 2, pbY - 2, pbW + 4, pbH + 4);
            ctx.fillStyle = '#ffcc00'; ctx.fillRect(pbX, pbY, pbW * Math.min(1, progress), pbH);
            ctx.strokeStyle = '#888'; ctx.strokeRect(pbX - 2, pbY - 2, pbW + 4, pbH + 4);
        }

        // Origin arrow indicator — show when > 100m from origin
        this.renderOriginArrow(ctx);
    },

    renderOriginArrow(ctx) {
        const distM = Difficulty.getDistance(Player.x);
        if (distM < 50) return;

        const originIsLeft = Player.x > this.originX;
        const arrowSize = 40;
        const margin = 20;
        const ax = originIsLeft ? margin + arrowSize / 2 : this.width - margin - arrowSize / 2;
        const ay = this.height - margin - arrowSize / 2 - 30;

        // Background circle
        ctx.save();
        ctx.globalAlpha = 0.75;
        ctx.fillStyle = '#1a1a2e';
        ctx.beginPath();
        ctx.arc(ax, ay, arrowSize / 2 + 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        // Arrow pointing toward origin
        ctx.fillStyle = '#ffcc44';
        ctx.beginPath();
        if (originIsLeft) {
            // Left-pointing arrow
            ctx.moveTo(ax - 14, ay);
            ctx.lineTo(ax + 6, ay - 12);
            ctx.lineTo(ax + 6, ay - 4);
            ctx.lineTo(ax + 14, ay - 4);
            ctx.lineTo(ax + 14, ay + 4);
            ctx.lineTo(ax + 6, ay + 4);
            ctx.lineTo(ax + 6, ay + 12);
        } else {
            // Right-pointing arrow
            ctx.moveTo(ax + 14, ay);
            ctx.lineTo(ax - 6, ay - 12);
            ctx.lineTo(ax - 6, ay - 4);
            ctx.lineTo(ax - 14, ay - 4);
            ctx.lineTo(ax - 14, ay + 4);
            ctx.lineTo(ax - 6, ay + 4);
            ctx.lineTo(ax - 6, ay + 12);
        }
        ctx.closePath();
        ctx.fill();

        // Distance label
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${Math.round(distM)}m`, ax, ay + arrowSize / 2 + 14);
        ctx.textAlign = 'left';
        ctx.restore();
    },

    renderMessage(ctx) {
        if (this.messageTimer <= 0) return;
        const alpha = Math.min(1, this.messageTimer);
        ctx.fillStyle = `rgba(0,0,0,${alpha * 0.6})`;
        const textW = ctx.measureText(this.messageText).width + 40;
        const mx = this.width - textW - 20;
        const my = 20;
        ctx.fillRect(mx, my, textW, 30);
        ctx.fillStyle = `rgba(255,255,255,${alpha})`;
        ctx.font = '14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(this.messageText, mx + textW / 2, my + 20);
        ctx.textAlign = 'left';
    },

    renderGameOver(ctx) {
        ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(0, 0, this.width, this.height);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#cc3333'; ctx.font = 'bold 48px monospace';
        ctx.fillText('GAME OVER', this.width / 2, this.height / 2 - 40);
        ctx.fillStyle = '#ddd'; ctx.font = '20px monospace';
        ctx.fillText(Player.deathCause, this.width / 2, this.height / 2 + 10);
        ctx.fillStyle = '#aaa'; ctx.font = '16px monospace';
        ctx.fillText(`Survived ${Survival.dayCount} day${Survival.dayCount > 1 ? 's' : ''}`, this.width / 2, this.height / 2 + 45);
        ctx.fillStyle = '#ffcc00'; ctx.font = '14px monospace';
        ctx.fillText('Press SPACE to try again', this.width / 2, this.height / 2 + 85);
        ctx.textAlign = 'left';
    }
};
