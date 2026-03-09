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
    gameOverButtons: { newGame: { x: 0, y: 0, w: 0, h: 0 }, continue_: { x: 0, y: 0, w: 0, h: 0 } },

    messageText: '',
    messageTimer: 0,

    tutorialStep: 0,
    tutorialShown: {},
    _hudState: {}, // Tracks last rendered HUD values to avoid fillText

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

            // HUD label cache
            this._hudCache = document.createElement('canvas');
            this._hudCtx = this._hudCache.getContext('2d');
            this._hudCacheDirty = true;

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

            // Game over button clicks
            if (this.gameOver && e.button === 0) {
                const mx = this.mouseX, my = this.mouseY;
                const ng = this.gameOverButtons.newGame;
                const ct = this.gameOverButtons.continue_;
                if (mx >= ng.x && mx <= ng.x + ng.w && my >= ng.y && my <= ng.y + ng.h) {
                    this.startNewGame();
                    return;
                }
                if (mx >= ct.x && mx <= ct.x + ct.w && my >= ct.y && my <= ct.y + ct.h) {
                    this.continueGame();
                    return;
                }
                return;
            }

            // ChestUI handle click
            if (ChestUI.handleMouseDown(this.mouseX, this.mouseY, this.width, this.height, e.shiftKey, e.ctrlKey, e.button)) return;

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

            // Gate repair is now combined with gate open/close mechanic
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

            // Click on Gate in World
            if (!this.gameOver && !Fishing.active && e.button === 0) {
                const worldX = this.mouseX + this.camera.x - this.width / 2;
                const gate = World.getGateNear(worldX);
                if (gate) {
                    const sx = gate.x - this.camera.x + this.width / 2;
                    const sy = (this.height * 0.6) - gate.surfaceY - 128;
                    // Gate image is 128x128
                    if (this.mouseX >= sx - 64 && this.mouseX <= sx + 64 && this.mouseY >= sy && this.mouseY <= sy + 128) {
                        const handItem = Inventory.getHandItem(false);
                        const isHoldingRepairItem = handItem && (handItem.id === 'firewood' || handItem.id === 'rock');

                        // Repair gate block
                        if (gate.durability < gate.maxDurability && isHoldingRepairItem) {
                            Player.startAction(0.4, 'chopping', () => {
                                const prevDur = gate.durability;
                                gate.durability = Math.min(gate.maxDurability, gate.durability + 10); // each repairs 10
                                if (prevDur <= 0 && gate.durability > 0) {
                                    gate.open = false; // It stands up
                                }
                                Inventory.consumeHandItem(false, 1);
                                this.showMessage(`Repaired gate with ${handItem.name}! (+10 hp)`, 1.5);
                            });
                            return;
                        }

                        // Normal open / close interaction
                        if (gate.durability > 0) {
                            gate.open = !gate.open;
                            this.showMessage(gate.open ? 'Gate opened.' : 'Gate closed.', 1.5);
                        } else {
                            this.showMessage('Gate is broken! Equip firewood or rock to repair.', 2);
                        }
                        return;
                    }
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

                    // Check NPCs (Melee Attack)
                    let handledByMelee = false;
                    const handItem = Inventory.getHandItem(false);
                    // Do not trigger melee if holding a shotgun
                    if (!handItem || handItem.id !== 'shotgun') {
                        for (let i = 0; i < NPCs.entities.length; i++) {
                            const npc = NPCs.entities[i];
                            const npcScreenY = baseY - npc.y - 30;
                            if (Math.abs(npc.x - worldX) < 40 && Math.abs(this.mouseY - npcScreenY) < 60) {
                                if (e.button === 0) {
                                    // Check distance to player
                                    if (Math.abs(Player.x - npc.x) < 80 && Math.abs(Player.y - npc.y) < 60) {

                                        // Simple cooldown check
                                        const now = Date.now();
                                        if (now - (Player.lastMeleeTime || 0) < 400) {
                                            handledByMelee = true;
                                            break;
                                        }
                                        Player.lastMeleeTime = now;

                                        let dmg = 10; // Fists damage
                                        let toolName = 'fists';

                                        if (handItem) {
                                            if (handItem.id === 'axe') { dmg = 25; toolName = 'axe'; }
                                            else if (handItem.id === 'pickaxe') { dmg = 20; toolName = 'pickaxe'; }
                                            else if (handItem.id === 'hammer') { dmg = 15; toolName = 'hammer'; }
                                            else if (handItem.id === 'ice_drill' || handItem.id === 'shovel') { dmg = 15; toolName = handItem.name.toLowerCase(); }
                                        }

                                        // Apply damage instantly without stopping movement
                                        npc.hp -= dmg;
                                        npc.aggro = true;
                                        npc.x += (npc.x > Player.x ? 1 : -1) * 15; // Pushback

                                        this.showMessage(`Hit ${npc.type.replace('_', ' ')} with ${toolName}!`, 1);

                                        if (handItem && handItem.durability !== undefined && toolName !== 'fists') {
                                            handItem.durability -= 1;
                                            if (handItem.durability <= 0) {
                                                Inventory.removeHandItem(false);
                                                this.showMessage(`${handItem.name} broke!`, 1.5);
                                            }
                                        }
                                        handledByMelee = true;
                                        break;
                                    } else {
                                        this.showMessage("Too far to melee attack!", 1);
                                        handledByMelee = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    if (handledByMelee) return;

                    // Check Chests (before tents)
                    const chest = World.getChestNear(worldX);
                    if (chest) {
                        const chestScreenY = baseY - chest.surfaceY - 14;
                        if (Math.abs(chest.x - worldX) < 30 && Math.abs(this.mouseY - chestScreenY) < 30) {
                            ChestUI.open(chest, false, false);
                            return;
                        }
                    }

                    // Check Tombstones
                    const ts = World.getTombstoneNear(worldX);
                    if (ts) {
                        const tsScreenY = baseY - ts.surfaceY - 18;
                        if (Math.abs(ts.x - worldX) < 35 && Math.abs(this.mouseY - tsScreenY) < 35) {
                            ChestUI.open(ts, true, true);
                            return;
                        }
                    }

                    // Check Tents
                    for (let i = 0; i < World.tents.length; i++) {
                        const tent = World.tents[i];
                        if (tent.permanent) continue;

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
                            if (torch.permanent) continue;

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

            if (!droppedInUI && ChestUI.isOpen) {
                droppedInUI = ChestUI.handleMouseUp(this.mouseX, this.mouseY, this.width, this.height);
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
        this._hudCacheDirty = true;
    },

    startNewGame() {
        if (this.loopId !== undefined) {
            cancelAnimationFrame(this.loopId);
        }

        this.running = false; // Temporarily stop loop logic before full reset
        this.gameOver = false;
        this.messageText = '';
        this.messageTimer = 0;
        this.tutorialShown = {};

        NPCs.init();
        World.generate();
        Voxels.generate();
        Inventory.init();
        Shop.init();
        RepairShop.init();
        Crafting.init();
        Anvil.init();
        ChestUI.close();

        Inventory.dragItem = null;
        Inventory.dragSource = null;

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
        this.loopId = requestAnimationFrame(t => this.loop(t));
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
                this.loopId = requestAnimationFrame(t => this.loop(t));
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
        this.loopId = requestAnimationFrame(t => this.loop(t));
    },

    update(dt) {
        if (this.gameOver) {
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

        if (Inventory.isOpen || Crafting.isOpen || Anvil.isOpen || ChestUI.isOpen) {
            if (this.keysJustPressed['KeyW'] || this.keysJustPressed['KeyS'] || this.keysJustPressed['KeyA'] || this.keysJustPressed['KeyD']) {
                Inventory.isOpen = false;
                Crafting.isOpen = false;
                Anvil.close();
                ChestUI.close();
            } else {
                if (ChestUI.isOpen && ChestUI.currentChest && Math.abs(Player.x - ChestUI.currentChest.x) >= 100) {
                    ChestUI.close();
                }
            }
        }

        // Don't allow player movement or item use while menus are open,
        // but keep the game world updating below

        // Item use is now handled by left-click (in setupInputs)

        const anyMenuOpen = Inventory.isOpen || Shop.isOpen || RepairShop.isOpen || Crafting.isOpen || Anvil.isOpen || ChestUI.isOpen;

        // Effective keys: if a menu is open, systems receive no input to prevent accidental actions
        const effectiveKeys = anyMenuOpen ? {} : this.keys;
        const effectiveKeysJustPressed = anyMenuOpen ? {} : this.keysJustPressed;

        // Allow cancelling actions by moving
        if (effectiveKeys['KeyA'] || effectiveKeys['KeyD']) {
            Player.cancelAction();
        }

        // Player updates: movement, animation, sub-stats (re-consolidated)
        Player.update(dt, effectiveKeys);

        // World updates: campfires, torches, weather, time
        Survival.update(dt);
        World.update(dt);
        NPCs.update(dt);

        // Fishing updates: world fish movement + reeling (input blocked if menu open)
        Fishing.update(dt, effectiveKeys, effectiveKeysJustPressed);

        this.camera.x += (Player.x - this.camera.x) * 0.08;

        if (Player.isDead && !this.gameOver) {
            // Spawn tombstone with player items
            const items = [];
            for (let i = 0; i < Inventory.HOTBAR_SIZE; i++) {
                if (Inventory.hotbar[i]) { items.push(Inventory.hotbar[i]); Inventory.hotbar[i] = null; }
            }
            for (let i = 0; i < Inventory.BAG_SIZE; i++) {
                if (Inventory.bag[i]) { items.push(Inventory.bag[i]); Inventory.bag[i] = null; }
            }
            if (Inventory.secondHand) { items.push(Inventory.secondHand); Inventory.secondHand = null; }
            if (items.length > 0) {
                World.addTombstone(Player.x, items);
            }
            this.gameOver = true;
        }

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

        // 4.5 NPCs
        NPCs.render(ctx, this.camera, this.width, this.height);

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
        ChestUI.render(ctx, this.width, this.height);
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
        let sunDirX = Math.cos(sunAngle);
        let sunDirY = -Math.sin(sunAngle); // Negative because screen Y grows downward

        // Keep sun mostly bright during the day, fading entirely at midnight
        let sunIntensity = Math.max(0.0, Math.sin(Survival.timeOfDay * Math.PI) * 1.5);
        if (Survival.stormActive) sunIntensity *= 0.4;

        let sunColorR = 1.0;
        let sunColorG = 0.98;
        let sunColorB = 0.92;

        if (Survival.isNight && Survival.dayCount % 3 === 0) {
            // Blood Moon (opposite in the sky to the sun)
            sunDirX = -sunDirX;
            sunDirY = -sunDirY;
            // Dimmer than daytime, but bright enough to see red shadows at night
            sunIntensity = 1.0;
            if (Survival.stormActive) sunIntensity *= 0.8;
            sunColorR = 1.0;
            sunColorG = 0.0;
            sunColorB = 0.0;
        }

        Lighting.setSunDir(sunDirX, sunDirY, Math.min(1.0, sunIntensity), sunColorR, sunColorG, sunColorB);

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

            if (fire.isBlue) {
                Lighting.addLight(sx, sy - 15, 400, 0.3, 0.7, 1.0, 0.9);
            } else {
                Lighting.addLight(sx, sy - 15, 400, 1.0, 0.65, 0.25, 0.9);
            }
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

    _renderHUDLabels() {
        const stats = [
            { label: '🔥 WARMTH' },
            { label: '🍖 HUNGER' },
            { label: '💧 THIRST' },
            { label: '😴 SLEEP' }
        ];
        const gap = 22;
        this._hudCache.width = 600; // Wider to accommodate more text
        this._hudCache.height = 300;
        const ctx = this._hudCtx;
        ctx.clearRect(0, 0, this._hudCache.width, this._hudCache.height);

        ctx.fillStyle = '#ccc';
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';

        let y = 15;
        for (const stat of stats) {
            ctx.fillText(stat.label, 15, y + 10);
            y += gap;
        }

        y += 5;
        ctx.fillStyle = '#ffaa44';
        ctx.font = '12px monospace';
        // Static parts of time/temp labels
        ctx.fillText('Temp:', 15, y + 28);

        // Help text
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        ctx.fillText('A/D Move  SCROLL Items  CLICK Use  E Inventory', 590, 15);
        ctx.textAlign = 'left';

        this._hudCacheDirty = false;
        this._hudState = {}; // Reset state to force redraw of values
    },

    renderHUD(ctx) {
        if (this._hudCacheDirty) this._renderHUDLabels();

        const barW = 140, barH = 14, startX = 15, gap = 22;
        let y = 15;

        // 1. Draw Backgrounds
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(startX - 5, y - 5, barW + 60, this.HUD_STATS.length * gap + 10);

        // 2. Draw Cached Static Labels & Help
        ctx.drawImage(this._hudCache, 0, 0);

        // 3. Draw Dynamic Bars and Values
        for (const stat of this.HUD_STATS) {
            const val = Player.stats[stat.key];
            const bx = startX + 85;

            // Draw Bar (fast)
            ctx.fillStyle = stat.bgColor; ctx.fillRect(bx, y, barW, barH);
            ctx.fillStyle = val < 25 ? '#ff2200' : stat.color;
            ctx.fillRect(bx, y, barW * (val / 100), barH);

            // Animation overlay (fast)
            if (val < 20) {
                ctx.fillStyle = `rgba(255,0,0,${Math.sin(Date.now() / 200) * 0.3 + 0.3})`;
                ctx.fillRect(bx, y, barW, barH);
            }

            // Value text (cached)
            let valStr = '';
            if (stat.key === 'warmth') {
                valStr = (34.0 + (val / 100) * 3.0).toFixed(1) + '°C';
            } else {
                valStr = Math.round(val).toString();
            }

            if (this._hudState[stat.key] !== valStr) {
                this._hudState[stat.key] = valStr;
                // Clear and redraw value in cache
                this._hudCtx.clearRect(bx + barW + 5, y, 60, 20);
                this._hudCtx.fillStyle = '#ccc';
                this._hudCtx.font = '10px monospace';
                this._hudCtx.fillText(valStr, bx + barW + 5, y + 11);
            }

            y += gap;
        }

        // Time and Temperature
        y += 5;
        const hours = Math.floor(Survival.timeOfDay * 24);
        const mins = Math.floor((Survival.timeOfDay * 24 - hours) * 60);
        const dayStr = `Day ${Survival.dayCount}  ${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
        const cTempStr = Survival.currentTemp.toFixed(1) + '°C';
        const fTempStr = `(Feels: ${Survival.feelsLikeTemp.toFixed(1)}°C)`;

        ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(startX - 5, y - 2, 175, 40);

        if (this._hudState.dayTime !== dayStr) {
            this._hudState.dayTime = dayStr;
            this._hudCtx.clearRect(startX, y, 170, 18);
            this._hudCtx.fillStyle = Survival.isNight ? '#8888cc' : '#ffffaa';
            this._hudCtx.font = '12px monospace';
            this._hudCtx.fillText(dayStr, startX, y + 14);
        }

        if (this._hudState.temp !== cTempStr + fTempStr) {
            this._hudState.temp = cTempStr + fTempStr;
            this._hudCtx.clearRect(startX + 50, y + 18, 200, 18);
            this._hudCtx.font = '12px monospace';
            this._hudCtx.fillStyle = '#ffaa44';
            this._hudCtx.fillText(cTempStr, startX + 50, y + 28);
            this._hudCtx.fillStyle = '#ccccff';
            this._hudCtx.fillText(fTempStr, startX + 90, y + 28);
        }

        y += 38;

        // Warnings (Redraw cache if state changes)
        const storm = !!Survival.stormActive;
        const tent = !!World.isPlayerInTent(Player.x);
        if (this._hudState.storm !== storm || this._hudState.tent !== tent) {
            this._hudState.storm = storm;
            this._hudState.tent = tent;
            this._hudCtx.clearRect(startX, y, 100, 40);
            let wy = y;
            if (storm) {
                this._hudCtx.fillStyle = 'rgba(200,0,0,0.7)'; this._hudCtx.font = 'bold 12px monospace';
                this._hudCtx.fillText('⚠ STORM', startX, wy + 12);
                wy += 16;
            }
            if (tent) {
                this._hudCtx.fillStyle = 'rgba(60,120,60,0.7)'; this._hudCtx.font = 'bold 11px monospace';
                this._hudCtx.fillText('🏕 IN TENT', startX, wy + 12);
            }
        }

        // Resources (Money, wood, rock)
        const moneyCount = Inventory.countItem('money');
        const woodCount = Inventory.countItem('firewood');
        const rockCount = Inventory.countItem('rock');
        const resourceStr = `${moneyCount},${woodCount},${rockCount}`;
        const ry = y + (storm ? 16 : 0) + (tent ? 16 : 0);

        if (this._hudState.resources !== resourceStr || this._hudState.resourceY !== ry) {
            this._hudState.resources = resourceStr;
            this._hudState.resourceY = ry;
            this._hudCtx.clearRect(startX, y + 32, 300, 40); // Clear both potential areas
            this._hudCtx.clearRect(startX, ry, 300, 20);

            this._hudCtx.font = 'bold 14px monospace';
            this._hudCtx.fillStyle = 'rgba(255,215,0,0.8)';
            this._hudCtx.fillText(`💵 $${moneyCount}`, startX, ry + 15);
            this._hudCtx.fillStyle = '#f2a365';
            this._hudCtx.fillText(`🪵 ${woodCount}`, startX + 90, ry + 15);
            this._hudCtx.fillStyle = '#aaa';
            this._hudCtx.fillText(`🪨 ${rockCount}`, startX + 140, ry + 15);
        }

        // Selected Item Name
        const selectedItem = Inventory.getSelectedItem();
        const itemName = selectedItem ? selectedItem.name : '';
        if (this._hudState.itemName !== itemName) {
            this._hudState.itemName = itemName;
            this._hudCtx.clearRect(0, this.height - 80, this.width, 30);
            if (itemName) {
                this._hudCtx.fillStyle = 'rgba(0,0,0,0.5)';
                const nameW = this._hudCtx.measureText(itemName).width + 20;
                this._hudCtx.fillRect(this.width / 2 - nameW / 2, this.height - 72, nameW, 18);
                this._hudCtx.fillStyle = '#ddd'; this._hudCtx.font = '12px monospace'; this._hudCtx.textAlign = 'center';
                this._hudCtx.fillText(itemName, this.width / 2, this.height - 58);
                this._hudCtx.textAlign = 'left';
            }
        }

        // Player Progress Bar (Action timer) - Draw direct (fast)
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

    continueGame() {
        this.gameOver = false;
        Player.isDead = false;
        Player.state = 'idle';
        Player.stats = { warmth: 50, hunger: 50, thirst: 50, sleep: 50 };
        // Empty inventory on continue — player retrieves items from tombstone
        Inventory.bag = new Array(Inventory.BAG_SIZE).fill(null);
        Inventory.hotbar = new Array(Inventory.HOTBAR_SIZE).fill(null);
        Inventory.secondHand = null;
        Inventory.selectedSlot = 0;
        Inventory.isOpen = false;
        Inventory.dragItem = null;
        Inventory.dragSource = null;

        // Move player back to origin
        Player.x = this.originX;
        Player.y = World.getSurfaceY(this.originX);
        this.camera.x = Player.x;
    },

    renderGameOver(ctx) {
        ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(0, 0, this.width, this.height);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#cc3333'; ctx.font = 'bold 48px monospace';
        ctx.fillText('GAME OVER', this.width / 2, this.height / 2 - 50);
        ctx.fillStyle = '#ddd'; ctx.font = '20px monospace';
        ctx.fillText(Player.deathCause, this.width / 2, this.height / 2);
        ctx.fillStyle = '#aaa'; ctx.font = '16px monospace';
        ctx.fillText(`Survived ${Survival.dayCount} day${Survival.dayCount > 1 ? 's' : ''}`, this.width / 2, this.height / 2 + 35);

        // Buttons
        const btnW = 160, btnH = 40, btnGap = 20;
        const btnY = this.height / 2 + 65;
        const ngX = this.width / 2 - btnW - btnGap / 2;
        const ctX = this.width / 2 + btnGap / 2;

        // New Game button
        ctx.fillStyle = '#882222';
        ctx.fillRect(ngX, btnY, btnW, btnH);
        ctx.strokeStyle = '#cc4444'; ctx.lineWidth = 2;
        ctx.strokeRect(ngX, btnY, btnW, btnH);
        ctx.fillStyle = '#ffcc00'; ctx.font = 'bold 16px monospace';
        ctx.fillText('New Game', ngX + btnW / 2, btnY + 26);

        // Continue button
        ctx.fillStyle = '#225522';
        ctx.fillRect(ctX, btnY, btnW, btnH);
        ctx.strokeStyle = '#44cc44'; ctx.lineWidth = 2;
        ctx.strokeRect(ctX, btnY, btnW, btnH);
        ctx.fillStyle = '#ffcc00'; ctx.font = 'bold 16px monospace';
        ctx.fillText('Continue', ctX + btnW / 2, btnY + 26);

        // Store button bounds for click detection
        this.gameOverButtons.newGame = { x: ngX, y: btnY, w: btnW, h: btnH };
        this.gameOverButtons.continue_ = { x: ctX, y: btnY, w: btnW, h: btnH };

        ctx.textAlign = 'left';
    },

    HUD_STATS: [
        { key: 'warmth', label: '🔥 WARMTH', color: '#ff6633', bgColor: '#441100' },
        { key: 'hunger', label: '🍖 HUNGER', color: '#44bb44', bgColor: '#003300' },
        { key: 'thirst', label: '💧 THIRST', color: '#3388ff', bgColor: '#001144' },
        { key: 'sleep', label: '😴 SLEEP', color: '#bb88ff', bgColor: '#220044' }
    ]
};
