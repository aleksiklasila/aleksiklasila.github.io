// survival.js — Day/night cycle, snowstorms, fire, tree chopping, cooking
const Survival = {
    timeOfDay: 0.3,     // 0=midnight, 0.5=noon, 1=midnight
    dayLength: 300,      // seconds per full day
    dayCount: 1,

    stormActive: false,
    stormTimer: 0,
    stormCooldown: 60,
    stormDuration: 0,
    stormIntensity: 0,

    snowParticles: [],
    maxSnowParticles: 200,

    isNight: false,

    currentTemp: 0,
    feelsLikeTemp: 0,

    cookingTimer: 0,

    messages: [],

    init() {
        this.timeOfDay = 0.3; // Start in morning
        this.dayCount = 1;
        this.stormActive = false;
        this.stormTimer = 0;
        this.stormCooldown = 60 + Math.random() * 40;
        this.snowParticles = [];
        this.initSnowParticles();
        this.updateTemperatures();
        this.cookingTimer = 0;
    },

    initSnowParticles() {
        this.snowParticles = [];
        for (let i = 0; i < this.maxSnowParticles; i++) {
            this.snowParticles.push({
                x: Math.random() * 1200,
                y: Math.random() * 800,
                size: 1 + Math.random() * 3,
                speedX: -0.3 + Math.random() * 0.6,
                speedY: 0.5 + Math.random() * 1.5,
                opacity: 0.3 + Math.random() * 0.7
            });
        }
    },

    update(dt) {
        // Advance time
        this.timeOfDay += dt / this.dayLength;
        if (this.timeOfDay >= 1) {
            this.timeOfDay -= 1;
            this.dayCount++;
            Game.showMessage(`Day ${this.dayCount}`, 3);
        }

        // Determine night
        this.isNight = this.timeOfDay < 0.2 || this.timeOfDay > 0.8;

        // Storm logic
        if (!this.stormActive) {
            this.stormCooldown -= dt;
            if (this.stormCooldown <= 0) {
                this.startStorm();
            }
        } else {
            this.stormTimer -= dt;
            if (this.stormTimer <= 0) {
                this.endStorm();
            }
        }

        // Update snow particles
        this.updateSnow(dt);

        // Update Tempearture
        this.updateTemperatures();

        // Handle auto-cooking fish
        this.updateCooking(dt);

        // Drain carried torch fuel
        this.updateCarriedTorch(dt);
    },

    updateTemperatures() {
        // Base temp goes from -15C at night to +5C at noon
        // timeOfDay: 0=midnight, 0.5=noon, 1=midnight
        // Use a cosine wave: cos(0) = 1 (midnight -> lowest temp), cos(PI) = -1 (noon -> highest temp)
        const dayCycleTemp = -5 - Math.cos(this.timeOfDay * Math.PI * 2) * 10;

        let stormDrop = 0;
        if (this.stormActive) {
            stormDrop = this.stormIntensity * 15; // Drops up to 15 degrees in heavy storm
        }

        // Difficulty cold offset: each level drops temp by 3°C
        const diffCold = Difficulty.getLevel(Player.x) * 3;

        this.currentTemp = dayCycleTemp - diffCold;

        // Feels like accounts for wind/storm
        this.feelsLikeTemp = this.currentTemp - stormDrop;
    },

    startStorm() {
        const diffLevel = Difficulty.getLevel(Player.x);
        this.stormActive = true;
        this.stormDuration = 15 + diffLevel * 5 + Math.random() * (25 + diffLevel * 5);
        this.stormTimer = this.stormDuration;
        this.stormIntensity = Math.min(1, 0.4 + diffLevel * 0.1) + Math.random() * Math.max(0.1, 0.6 - diffLevel * 0.05);
        this.stormIntensity = Math.min(1, this.stormIntensity);
        Game.showMessage('A snowstorm is coming!', 3);
    },

    endStorm() {
        const diffLevel = Difficulty.getLevel(Player.x);
        this.stormActive = false;
        const baseCooldown = Math.max(10, 40 - diffLevel * 5);
        this.stormCooldown = baseCooldown + Math.random() * baseCooldown;
        this.stormIntensity = 0;
        Game.showMessage('The storm has passed.', 2);
    },

    updateSnow(dt) {
        const windX = this.stormActive ? -3 * this.stormIntensity : -0.3;
        const speedMult = this.stormActive ? 2 + this.stormIntensity * 3 : 1;

        for (const p of this.snowParticles) {
            p.x += (p.speedX + windX) * speedMult * 60 * dt;
            p.y += p.speedY * speedMult * 60 * dt;

            if (p.y > 800) {
                p.y = -5;
                p.x = Math.random() * 1400;
            }
            if (p.x < -20) {
                p.x = 1220;
            }
            if (p.x > 1220) {
                p.x = -10;
            }
        }
    },

    // Use axe to chop trees or pick up tents
    useAxe(playerX) {
        if (!Inventory.hasItem('axe')) {
            Game.showMessage('You need an axe!', 1.5);
            return;
        }

        // Find nearest alive tree
        let nearestTree = null;
        let nearestTreeDist = Infinity;
        for (const tree of World.trees) {
            if (!tree.alive) continue;
            const d = Math.abs(tree.x - playerX);
            if (d < nearestTreeDist && d < 60) {
                nearestTreeDist = d;
                nearestTree = tree;
            }
        }

        // Find nearest tent
        let nearestTentDist = Infinity;
        for (const tent of World.tents) {
            const d = Math.abs(tent.x - playerX);
            if (d < nearestTentDist && d < 50) {
                nearestTentDist = d;
            }
        }

        // Find nearest torch
        let nearestTorchDist = Infinity;
        if (World.torches) {
            for (const torch of World.torches) {
                const d = Math.abs(torch.x - playerX);
                if (d < nearestTorchDist && d < 40) {
                    nearestTorchDist = d;
                }
            }
        }

        // Decide what to hit
        const minDist = Math.min(nearestTreeDist, nearestTentDist, nearestTorchDist);

        if (minDist === nearestTorchDist && nearestTorchDist < Infinity) {
            Player.startAction(1.0, 'chopping', () => {
                const remainingFuel = World.removeTorchNear(playerX);
                if (remainingFuel !== false) {
                    Inventory.damageSelectedItem(1); // damage the axe
                    Inventory.addItem('torch', 1, remainingFuel);
                    Game.showMessage('Picked up torch.', 1.5);
                }
            });
        } else if (minDist === nearestTentDist && nearestTentDist < Infinity) {
            Player.startAction(1.5, 'chopping', () => {
                const removedTentDurability = World.removeTentNear(playerX);
                if (removedTentDurability !== false) {
                    Inventory.damageSelectedItem(1); // damage the axe
                    if (removedTentDurability <= 0) {
                        Game.showMessage('The tent fell apart as you picked it up!', 2);
                    } else {
                        Inventory.addItem('tent', 1, removedTentDurability);
                        Game.showMessage('Picked up tent.', 1.5);
                    }
                }
            });
        } else if (minDist === nearestTreeDist && nearestTreeDist < Infinity) {
            Player.startAction(1.5, 'chopping', () => {
                nearestTree.alive = false;
                Inventory.addItem('firewood', 2 + (Math.random() * 2) | 0);
                Inventory.damageSelectedItem(1);
                Game.showMessage('Got firewood!', 1.5);
            });
        } else {
            Game.showMessage('Nothing to chop or pick up nearby.', 1);
        }
    },

    // Make a fire
    makeFire(playerX) {
        if (!Inventory.hasItem('flint_steel')) {
            Game.showMessage('You need flint & steel!', 1.5);
            return;
        }
        if (!Inventory.hasItem('firewood', 2)) {
            Game.showMessage('Need at least 2 firewood!', 1.5);
            return;
        }

        const col = World.getColumnAt(playerX);
        if (!col || col.type === 'water') {
            Game.showMessage("Can't make fire here!", 1.5);
            return;
        }

        Player.startAction(2, 'chopping', () => {
            Inventory.removeItem('firewood', 2);
            const fire = World.addCampfire(playerX);
            if (fire) {
                Inventory.damageSelectedItem(1);
                Game.showMessage('Fire started!', 2);
            }
        });
    },

    // Cook fish automatically over time when held near fire or torch
    updateCooking(dt) {
        if (!Player || Player.isDead) return;

        const item = Inventory.getSelectedItem();
        let isHoldingRawFish = false;
        let fishType = null;

        if (item) {
            if (item.id === 'raw_fish' || item.id === 'raw_fish_large') {
                isHoldingRawFish = true;
                fishType = item.id;
            }
        }

        if (!isHoldingRawFish) {
            this.cookingTimer = 0;
            return;
        }

        // Check near fire or ground torch
        let nearHeat = false;
        for (const fire of World.campfires) {
            if (fire.lit && Math.abs(fire.x - Player.x) < 80) {
                nearHeat = true;
                break;
            }
        }
        if (!nearHeat && World.torches) {
            for (const torch of World.torches) {
                if (torch.lit && Math.abs(torch.x - Player.x) < 60) {
                    nearHeat = true;
                    break;
                }
            }
        }

        if (nearHeat) {
            this.cookingTimer += dt;
            if (this.cookingTimer >= 2.0) { // cook time 2 seconds
                this.cookingTimer = 0;

                Inventory.removeItem(fishType, 1);
                if (fishType === 'raw_fish') {
                    Inventory.addItem('cooked_fish', 1);
                    Game.showMessage('Cooked a fish!', 1.5);
                } else {
                    Inventory.addItem('cooked_fish_large', 1);
                    Game.showMessage('Cooked a large fish!', 1.5);
                }
            }
        } else {
            this.cookingTimer = 0;
        }
    },

    // Drain held torch durability over time
    updateCarriedTorch(dt) {
        const item = Inventory.getSelectedItem();
        if (item && item.id === 'torch' && item.durability > 0) {
            item.durability -= dt * 0.8; // Same rate as ground torch/campfire
            if (item.durability <= 0) {
                item.durability = 0;
                Inventory.hotbar[Inventory.selectedSlot] = null;
                Game.showMessage('Your torch burned out!', 2);
            }
        }
    },

    // Use selected item
    useItem(playerX) {
        const item = Inventory.getSelectedItem();
        if (!item) return;

        switch (item.id) {
            case 'ice_drill': {
                const col = World.getColumnAt(playerX);
                if (col && col.type === 'ice') {
                    Player.startAction(2.5, 'chopping', () => {
                        if (World.addFishingHole(playerX)) {
                            Voxels.drillHole(playerX);
                            Inventory.damageSelectedItem(1);
                            Game.showMessage('Made a fishing hole!', 2);
                        } else {
                            Game.showMessage('Too close to another hole!', 1.5);
                        }
                    });
                } else {
                    Game.showMessage('Can only drill on ice!', 1.5);
                }
                break;
            }

            case 'fishing_rod': {
                // Find nearby fishing hole
                let nearestHole = null;
                let nearestDist = Infinity;
                for (const hole of World.fishingHoles) {
                    const d = Math.abs(hole.x - playerX);
                    if (d < nearestDist && d < 50) {
                        nearestDist = d;
                        nearestHole = hole;
                    }
                }
                if (nearestHole) {
                    Fishing.startFishing(nearestHole);
                } else {
                    Game.showMessage('No fishing hole nearby!', 1.5);
                }
                break;
            }

            case 'scoop': {
                let nearestHole = null;
                let nearestDist = Infinity;
                for (const hole of World.fishingHoles) {
                    const d = Math.abs(hole.x - playerX);
                    if (d < nearestDist && d < 50) {
                        nearestDist = d;
                        nearestHole = hole;
                    }
                }
                if (nearestHole) {
                    Player.startAction(1.5, 'chopping', () => {
                        Player.stats.thirst = Math.min(100, Player.stats.thirst + 40);
                        Inventory.damageSelectedItem(1);
                        Game.showMessage('Drank water from the hole! (+40 thirst)', 2);
                    });
                } else {
                    Player.startAction(1.5, 'chopping', () => {
                        Player.stats.thirst = Math.min(100, Player.stats.thirst + 8);
                        Player.stats.warmth = Math.max(0, Player.stats.warmth - 3);
                        Inventory.damageSelectedItem(1);
                        Game.showMessage('Ate snow for water. (-3 warmth)', 1.5);
                    });
                }
                break;
            }

            case 'axe':
                this.useAxe(playerX);
                break;

            case 'flint_steel':
                this.makeFire(playerX);
                break;

            case 'cooked_fish':
                Inventory.removeItem('cooked_fish', 1);
                Player.stats.hunger = Math.min(100, Player.stats.hunger + 30);
                Player.stats.thirst = Math.min(100, Player.stats.thirst + 5);
                Game.showMessage('Ate cooked fish! (+30 hunger)', 1.5);
                break;

            case 'cooked_fish_large':
                Inventory.removeItem('cooked_fish_large', 1);
                Player.stats.hunger = Math.min(100, Player.stats.hunger + 50);
                Player.stats.thirst = Math.min(100, Player.stats.thirst + 10);
                Game.showMessage('Ate large cooked fish! (+50 hunger)', 1.5);
                break;

            case 'raw_fish':
                // Can eat raw but less effective and risks
                Inventory.removeItem('raw_fish', 1);
                Player.stats.hunger = Math.min(100, Player.stats.hunger + 10);
                Player.stats.warmth = Math.max(0, Player.stats.warmth - 5);
                Game.showMessage('Ate raw fish... (-5 warmth)', 1.5);
                break;

            case 'raw_fish_large':
                Inventory.removeItem('raw_fish_large', 1);
                Player.stats.hunger = Math.min(100, Player.stats.hunger + 20);
                Player.stats.warmth = Math.max(0, Player.stats.warmth - 5);
                Game.showMessage('Ate large raw fish... (-5 warmth)', 1.5);
                break;

            case 'firewood':
                // Check near fire
                for (const fire of World.campfires) {
                    if (fire.lit && Math.abs(fire.x - playerX) < 80) {
                        Inventory.removeItem('firewood', 1);
                        fire.fuel = Math.min(100, fire.fuel + 40);
                        Game.showMessage('Added fuel to fire.', 1.5);
                        return;
                    }
                }
                Game.showMessage('Use near a campfire to add fuel.', 1.5);
                break;

            case 'tent': {
                // Place tent
                const tentItem = Inventory.getSelectedItem();
                const currentDurability = tentItem.durability !== undefined ? tentItem.durability : 5;

                if (World.addTent(playerX, currentDurability - 1)) {
                    Inventory.removeItem('tent', 1);
                    if (currentDurability - 1 <= 0) {
                        Game.showMessage('Pitched tent! (It looks very fragile...)', 2);
                    } else {
                        Game.showMessage('Pitched tent! Stand inside for shelter.', 2);
                    }
                } else {
                    Game.showMessage('Too close to another tent!', 1.5);
                }
                break;
            }

            case 'bait':
                Game.showMessage('Use with fishing rod at a hole.', 1.5);
                break;

            case 'torch': {
                // Check if near a ground torch to pick up
                let nearTorch = false;
                if (World.torches) {
                    for (const torch of World.torches) {
                        if (torch.lit && Math.abs(torch.x - playerX) < 50) {
                            nearTorch = true;
                            break;
                        }
                    }
                }
                if (nearTorch) {
                    // Pick up the ground torch
                    const remainingFuel = World.removeTorchNear(playerX);
                    if (remainingFuel !== false) {
                        // The current torch in hand is consumed to pick up ground torch
                        // Update the held torch's durability to the ground torch's fuel
                        const heldTorch = Inventory.getSelectedItem();
                        if (heldTorch) {
                            heldTorch.durability = Math.min(100, heldTorch.durability + remainingFuel);
                        }
                        Game.showMessage('Picked up torch. Fuel restored!', 1.5);
                    }
                } else {
                    // Place the torch on the ground
                    const torchItem = Inventory.getSelectedItem();
                    const fuel = torchItem.durability || 100;
                    if (World.addTorch(playerX, fuel)) {
                        Inventory.hotbar[Inventory.selectedSlot] = null;
                        Game.showMessage('Placed torch on the ground.', 1.5);
                    } else {
                        Game.showMessage("Can't place torch here!", 1.5);
                    }
                }
                break;
            }
        }
    },

    renderOverlays(ctx, canvasW, canvasH) {
        // Night overlay
        const nightAlpha = this.isNight
            ? 0.4 + 0.2 * (1 - Math.abs(this.timeOfDay - 0.5) * 2)
            : Math.max(0, 0.3 - Math.sin(this.timeOfDay * Math.PI) * 0.4);

        if (nightAlpha > 0.05) {
            ctx.fillStyle = `rgba(5,5,25,${nightAlpha})`;
            ctx.fillRect(0, 0, canvasW, canvasH);
        }

        // Campfire glow punctures night overlay
        for (const fire of World.campfires) {
            if (!fire.lit) continue;
            const sx = fire.x - Game.camera.x + canvasW / 2;
            const baseY = canvasH * 0.6;
            const sy = baseY - fire.surfaceY;
            if (sx < -100 || sx > canvasW + 100) continue;

            const glowGrad = ctx.createRadialGradient(sx, sy - 15, 5, sx, sy - 15, 100);
            glowGrad.addColorStop(0, `rgba(255,180,60,${0.15 * nightAlpha})`);
            glowGrad.addColorStop(1, 'rgba(255,100,0,0)');
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = glowGrad;
            ctx.fillRect(sx - 120, sy - 120, 240, 200);
            ctx.globalCompositeOperation = 'source-over';
        }

        // Ground torch glow punctures night overlay
        if (World.torches) {
            for (const torch of World.torches) {
                if (!torch.lit) continue;
                const sx = torch.x - Game.camera.x + canvasW / 2;
                const baseY = canvasH * 0.6;
                const sy = baseY - torch.surfaceY;
                if (sx < -100 || sx > canvasW + 100) continue;

                const glowGrad = ctx.createRadialGradient(sx, sy - 20, 3, sx, sy - 20, 60);
                glowGrad.addColorStop(0, `rgba(255,180,60,${0.1 * nightAlpha})`);
                glowGrad.addColorStop(1, 'rgba(255,100,0,0)');
                ctx.globalCompositeOperation = 'lighter';
                ctx.fillStyle = glowGrad;
                ctx.fillRect(sx - 70, sy - 80, 140, 120);
                ctx.globalCompositeOperation = 'source-over';
            }
        }

        // Storm overlay
        if (this.stormActive) {
            ctx.fillStyle = `rgba(200,210,220,${this.stormIntensity * 0.15})`;
            ctx.fillRect(0, 0, canvasW, canvasH);
        }

        // Snow particles
        const activeCount = this.stormActive
            ? this.maxSnowParticles
            : Math.floor(this.maxSnowParticles * 0.3);

        ctx.fillStyle = '#fff';
        for (let i = 0; i < activeCount && i < this.snowParticles.length; i++) {
            const p = this.snowParticles[i];
            ctx.globalAlpha = p.opacity * (this.stormActive ? 1 : 0.5);
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }
};
