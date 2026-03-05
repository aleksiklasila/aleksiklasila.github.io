// game.js — Main game loop, input handling, camera, HUD
const Game = {
    canvas: null,
    ctx: null,
    width: 0,
    height: 0,

    camera: { x: 0, y: 0 },

    keys: {},
    keysJustPressed: {},
    mouseX: 0,
    mouseY: 0,

    lastTime: 0,
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

        this.canvas.addEventListener('mousemove', e => {
            const rect = this.canvas.getBoundingClientRect();
            this.mouseX = e.clientX - rect.left;
            this.mouseY = e.clientY - rect.top;
        });

        this.canvas.addEventListener('mousedown', e => {
            // Only handle left click
            if (e.button !== 0) return;

            const rect = this.canvas.getBoundingClientRect();
            this.mouseX = e.clientX - rect.left;
            this.mouseY = e.clientY - rect.top;

            // Click Shop UI
            if (Shop.isOpen) {
                if (Shop.handleMouseDown(this.mouseX, this.mouseY, this.width, this.height)) return;
            }

            // Click Repair Shop UI
            if (RepairShop.isOpen) {
                if (RepairShop.handleMouseDown(this.mouseX, this.mouseY, this.width, this.height)) return;
            }

            // Click Inventory UI
            if (Inventory.isOpen) {
                if (Inventory.handleMouseDown(this.mouseX, this.mouseY, this.width, this.height)) return;
            }

            // Click on Shop Building in World
            if (!this.gameOver && !Fishing.active && World.shop) {
                const sx = World.shop.x - this.camera.x + this.width / 2;
                const sy = (this.height * 0.6) - World.shop.surfaceY - 128;
                // Shop image is 128x128
                if (this.mouseX >= sx - 64 && this.mouseX <= sx + 64 && this.mouseY >= sy && this.mouseY <= sy + 128) {
                    Shop.toggle();
                    return;
                }
            }

            // Click on Repair Shop Building in World
            if (!this.gameOver && !Fishing.active && World.repairShop) {
                const sx = World.repairShop.x - this.camera.x + this.width / 2;
                const sy = (this.height * 0.6) - World.repairShop.surfaceY - 128;
                if (this.mouseX >= sx - 64 && this.mouseX <= sx + 64 && this.mouseY >= sy && this.mouseY <= sy + 128) {
                    RepairShop.toggle();
                    return;
                }
            }

            // Only use item if not clicking on UI and shop/inventory isn't open
            if (!this.gameOver && !Fishing.active && Player.actionTimer <= 0 && !Shop.isOpen && !RepairShop.isOpen && !Inventory.isOpen) {
                Survival.useItem(Player.x);
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

            if (!droppedInUI && Inventory.isOpen) {
                droppedInUI = Inventory.handleMouseUp(this.mouseX, this.mouseY, this.width, this.height);
            }

            // If we didn't drop it in a valid slot, return it to source
            if (!droppedInUI && Inventory.dragItem && Inventory.dragSource) {
                if (Inventory.dragSource.type === 'bag') {
                    Inventory.bag[Inventory.dragSource.idx] = Inventory.dragItem;
                } else if (Inventory.dragSource.type === 'hotbar') {
                    Inventory.hotbar[Inventory.dragSource.idx] = Inventory.dragItem;
                } else if (Inventory.dragSource.type === 'shop') {
                    Shop.sellSlot = Inventory.dragItem;
                } else if (Inventory.dragSource.type === 'repair_shop') {
                    RepairShop.repairSlot = Inventory.dragItem;
                } else if (Inventory.dragSource.type === 'shop_buy') {
                    // Do nothing, item returns to shop (not bought)
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
        Survival.init();
        Fishing.init();
        Fishing.generateWorldFish();

        let startX = World.WORLD_WIDTH * World.TILE_SIZE / 2;
        for (let i = Math.floor(World.WORLD_WIDTH / 2); i < World.WORLD_WIDTH; i++) {
            if (World.columns[i].type === 'ground') { startX = i * World.TILE_SIZE; break; }
        }

        Player.init(startX);
        this.camera.x = Player.x;
        this.camera.y = 0;

        this.showMessage('Survive the frozen wilderness. Press E for inventory.', 4);

        this.running = true;
        this.lastTime = performance.now();
        requestAnimationFrame(t => this.loop(t));
    },

    loop(timestamp) {
        if (!this.running) return;
        const dt = Math.min((timestamp - this.lastTime) / 1000, 0.05);
        this.lastTime = timestamp;
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

        if (Inventory.isOpen) {
            if (this.keysJustPressed['KeyW'] || this.keysJustPressed['KeyS'] || this.keysJustPressed['KeyA'] || this.keysJustPressed['KeyD']) {
                Inventory.isOpen = false;
            }
        }

        if (Inventory.isOpen || Shop.isOpen || RepairShop.isOpen) return;

        // Item use is now handled by left-click (in setupInputs)

        if (this.keysJustPressed['KeyF'] && !Fishing.active && Player.actionTimer <= 0) {
            const item = Inventory.getSelectedItem();
            if (item && (item.id === 'raw_fish' || item.id === 'cooked_fish' || item.id === 'raw_fish_large' || item.id === 'cooked_fish_large')) {
                Survival.useItem(Player.x);
            } else {
                Player.stats.thirst = Math.min(100, Player.stats.thirst + 8);
                Player.stats.warmth = Math.max(0, Player.stats.warmth - 3);
                this.showMessage('Ate snow for water. (-3 warmth)', 1.5);
            }
        }

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

        // 8. UI Screens (Shop / Repair Shop / Inventory)
        if (Shop.isOpen || RepairShop.isOpen || Inventory.isOpen) {
            ctx.fillStyle = 'rgba(0,0,0,0.8)';
            ctx.fillRect(0, 0, this.width, this.height);
        }

        Shop.render(ctx, this.width, this.height);
        RepairShop.render(ctx, this.width, this.height);
        Inventory.render(ctx, this.width, this.height);

        // 9. HUD
        this.renderHUD(ctx);

        // Render dragged item
        if (Inventory.dragItem) {
            Inventory.renderItemIcon(ctx, Inventory.dragItem, this.mouseX - 20, this.mouseY - 20, 40);
        }

        this.renderMessage(ctx);

        if (this.gameOver) this.renderGameOver(ctx);
    },

    updateLights() {
        Lighting.clearLights();

        const baseY = this.height * 0.6;

        // Ambient light from day/night cycle
        const dayMix = Math.max(0, Math.min(1, Math.sin(Survival.timeOfDay * Math.PI)));
        Lighting.ambientLight = Survival.stormActive
            ? Math.max(0.1, dayMix * 0.4)
            : Math.max(0.05, dayMix * 0.85);

        // Player vision light (always active)
        const playerSX = Player.x - this.camera.x + this.width / 2;
        const playerSY = baseY - Player.y - 25;
        const visionRadius = Survival.isNight ? 250 : 600;
        Lighting.addLight(playerSX, playerSY, visionRadius, 1.0, 1.0, 1.0, Survival.isNight ? 0.7 : 0.3);

        // Campfire lights
        for (const fire of World.campfires) {
            if (!fire.lit) continue;
            const sx = fire.x - this.camera.x + this.width / 2;
            const sy = baseY - fire.surfaceY;
            if (sx < -200 || sx > this.width + 200) continue;
            const flicker = 0.9 + Math.sin(Date.now() / 150) * 0.1;
            Lighting.addLight(sx, sy - 15, 180, 1.0, 0.65, 0.25, 0.9 * flicker);
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

        ctx.fillStyle = 'rgba(255,215,0,0.8)';
        ctx.font = 'bold 14px monospace';
        ctx.fillText(`💵 $${Player.money}`, startX, y + 15);

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
        ctx.fillText('A/D Move  SCROLL Items  CLICK Use  E Inventory  F Eat/Drink', this.width - 10, 15);
        ctx.textAlign = 'left';

        if (Player.actionTimer > 0) {
            const progress = 1 - (Player.actionTimer / 2.5);
            const pbW = 100, pbH = 8;
            const pbX = this.width / 2 - pbW / 2, pbY = this.height * 0.4;
            ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(pbX - 2, pbY - 2, pbW + 4, pbH + 4);
            ctx.fillStyle = '#ffcc00'; ctx.fillRect(pbX, pbY, pbW * Math.min(1, progress), pbH);
            ctx.strokeStyle = '#888'; ctx.strokeRect(pbX - 2, pbY - 2, pbW + 4, pbH + 4);
        }
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
