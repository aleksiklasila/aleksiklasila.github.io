// player.js — Player movement, animation, stats, rendering
const Player = {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    width: 24,
    height: 40,
    facing: 1, // 1=right, -1=left
    state: 'idle', // idle, walking, fishing, chopping, dying
    animFrame: 0,
    animTimer: 0,

    // Survival stats (0-100)
    stats: {
        warmth: 80,
        hunger: 70,
        thirst: 70,
        sleep: 90
    },

    money: 0,

    // Rates per second
    drainRates: {
        warmth: 1.2,
        hunger: 0.6,
        thirst: 0.8,
        sleep: 0.4
    },

    isDead: false,
    deathCause: '',
    speed: 150,

    // Action state
    actionTimer: 0,
    actionCallback: null,

    init(worldX) {
        this.x = worldX;
        this.y = World.getSurfaceY(worldX);
        this.stats = { warmth: 80, hunger: 70, thirst: 70, sleep: 90 };
        this.money = 0;
        this.isDead = false;
        this.state = 'idle';
    },

    update(dt, keys) {
        if (this.isDead) return;

        // Action in progress (chopping, drilling, etc.)
        if (this.actionTimer > 0) {
            this.actionTimer -= dt;
            if (this.actionTimer <= 0) {
                this.actionTimer = 0;
                if (this.actionCallback) {
                    this.actionCallback();
                    this.actionCallback = null;
                }
                this.state = 'idle';
            }
            return;
        }

        // Don't move while fishing
        if (this.state === 'fishing') return;

        // Movement (A/D only - W/S are used for fishing depth when fishing)
        let moving = false;

        // Force sleep state if exhausted
        if (this.stats.sleep <= 0) {
            this.state = 'sleeping';
        } else if (this.state === 'sleeping' && this.stats.sleep < 5) {
            // keep sleeping
        } else {
            let currentSpeed = this.speed;
            if (this.stats.sleep < 25) {
                currentSpeed *= 0.5; // Slow down 50% when sleepy
            }

            // Terrain steepness slowdown — slope measured over 20px
            const slope = Math.abs(World.getSurfaceY(this.x + 10) - World.getSurfaceY(this.x - 10)) / 20;
            const slopeFactor = Math.max(0, 1 - slope * 0.02);
            // Difficulty zone slowdown
            const diffMult = Math.max(0, 1 - Difficulty.getLevel(this.x) * 0.05);
            currentSpeed *= slopeFactor * diffMult;

            if (keys['KeyA'] || keys['ArrowLeft']) {
                this.vx = -currentSpeed;
                this.facing = -1;
                moving = true;
            } else if (keys['KeyD'] || keys['ArrowRight']) {
                this.vx = currentSpeed;
                this.facing = 1;
                moving = true;
            } else {
                this.vx = 0;
            }

            this.state = moving ? 'walking' : 'idle';
        }

        // Apply movement
        if (this.state !== 'sleeping') {
            this.x += this.vx * dt;
        }
        // Clamp to world
        this.x = Math.max(40, Math.min((World.WORLD_WIDTH - 1) * World.TILE_SIZE, this.x));

        // Stick to terrain surface
        const surfaceY = World.getSurfaceY(this.x);
        this.y = surfaceY;

        // Animation
        this.animTimer += dt;
        if (this.animTimer > 0.15) {
            this.animTimer = 0;
            this.animFrame = (this.animFrame + 1) % 6; // up to 6 frames for the 3x2 grid
        }

        // Drain stats
        this.updateStats(dt);
    },

    updateStats(dt) {
        const col = World.getColumnAt(this.x);
        const isOnIce = col && (col.type === 'ice' || col.type === 'water');
        const isInStorm = Survival.stormActive;
        const isNight = Survival.isNight;
        const isInTent = World.isPlayerInTent(this.x);

        // Warmth drain based on Temperature
        const feelsLike = Survival.feelsLikeTemp;
        let warmthMultiplier = 0;

        // If it's warm enough (e.g. above 0C), warmly recover or stay neutral
        if (feelsLike > 0) {
            this.stats.warmth = Math.min(100, this.stats.warmth + feelsLike * 0.1 * dt);
        } else {
            // Drain based on how cold it is below 0
            warmthMultiplier = Math.abs(feelsLike) * 0.15; // e.g. -10C = 1.5x drain
            if (isOnIce) warmthMultiplier *= 1.5;
            if (isInTent) warmthMultiplier *= 0.3; // 70% reduction

            let warmthDrain = this.drainRates.warmth * warmthMultiplier;

            // Apply drain if not recovering from fire
            let nearFire = false;
            for (const fire of World.campfires) {
                if (fire.lit && Math.abs(fire.x - this.x) < 80) nearFire = true;
            }
            if (!nearFire) {
                this.stats.warmth -= warmthDrain * dt;
            }
        }

        // Check if near campfire to recover
        let nearFireRec = false;
        for (const fire of World.campfires) {
            if (fire.lit && Math.abs(fire.x - this.x) < 80) {
                nearFireRec = true;
                break;
            }
        }
        let nearTorchRec = false;
        if (!nearFireRec && World.torches) {
            for (const torch of World.torches) {
                if (torch.lit && Math.abs(torch.x - this.x) < 60) {
                    nearTorchRec = true;
                    break;
                }
            }
        }
        if (nearFireRec) {
            this.stats.warmth = Math.min(100, this.stats.warmth + dt * 8);
            this.stats.sleep = Math.min(100, this.stats.sleep + dt * 1);
        } else if (nearTorchRec) {
            this.stats.warmth = Math.min(100, this.stats.warmth + dt * 4);
        } else if (isInTent) {
            // Tent gives minor sleep recovery
            this.stats.sleep = Math.min(100, this.stats.sleep + dt * 3);
        }

        this.stats.hunger -= this.drainRates.hunger * dt;
        this.stats.thirst -= this.drainRates.thirst * dt;
        if (!isInTent && this.state !== 'sleeping') {
            this.stats.sleep -= this.drainRates.sleep * dt;
        } else if (this.state === 'sleeping') {
            // Force sleep recovery
            this.stats.sleep += dt * 5;
        }

        // Clamp
        for (const key of Object.keys(this.stats)) {
            this.stats[key] = Math.max(0, Math.min(100, this.stats[key]));
        }

        // Death check
        for (const [key, val] of Object.entries(this.stats)) {
            if (val <= 0) {
                if (key === 'sleep') continue; // Sleep exhaustion is handled via 'sleeping' state
                this.isDead = true;
                this.state = 'dying';
                const causes = {
                    warmth: 'Froze to death',
                    hunger: 'Starved to death',
                    thirst: 'Died of dehydration'
                };
                this.deathCause = causes[key];
                break;
            }
        }
    },

    startAction(duration, state, callback) {
        this.actionTimer = duration;
        this.state = state;
        this.actionCallback = callback;
    },

    render(ctx, camera, canvasW, canvasH) {
        const baseY = canvasH * 0.6;
        const sx = this.x - camera.x + canvasW / 2;
        const sy = baseY - this.y;

        ctx.save();
        ctx.translate(sx, sy);
        ctx.scale(this.facing, 1);

        const bobY = this.state === 'walking' ? Math.sin(this.animFrame * Math.PI / 2) * 3 : 0;
        let imgName = this.state === 'walking' ? 'player_walk' : 'player_idle';
        if (this.state === 'sleeping' || this.state === 'dying') {
            imgName = 'player_idle';
        }

        const img = Assets.get(imgName);
        if (img) {
            // Player sprites are 6 frames in a 3x2 grid (3 cols, 2 rows)
            const frameWidth = img.width / 3;
            const frameHeight = img.height / 2;
            const animFrame = this.animFrame % 6; // up to 6 frames now
            const col = animFrame % 3;
            const row = Math.floor(animFrame / 3);

            if (this.state === 'sleeping' || this.state === 'dying') {
                ctx.save();
                ctx.translate(0, -20);
                // Rotate 90 degrees to lay down
                ctx.rotate(Math.PI / 2);
                ctx.drawImage(img, col * frameWidth, row * frameHeight, frameWidth, frameHeight, -20, -28, 40, 56);
                ctx.restore();
                if (this.state === 'sleeping') {
                    const zBob = Math.sin(Date.now() / 300) * 5;
                    ctx.fillStyle = '#fff';
                    ctx.font = 'bold 16px monospace';
                    ctx.fillText('Zzz...', 10, -40 + zBob);
                }
            } else {
                // Draw sprite (approx 32x48 scale)
                // Shift X so the sprite center is aligned, Shift Y to align feet
                ctx.drawImage(img, col * frameWidth, row * frameHeight, frameWidth, frameHeight, -20, -56 - bobY, 40, 56);
            }
        }

        // Held item rendering
        const item = Inventory.getSelectedItem();
        if (item) {
            this.renderHeldItem(ctx, item, bobY);
        }

        ctx.restore();
    },

    renderHeldItem(ctx, item, bobY) {
        ctx.save();
        ctx.translate(10, -24 - bobY);

        let assetName = item.id;
        if (assetName === 'firewood') assetName = 'wood';

        const img = Assets.get(assetName);
        if (img) {
            // Draw rotated to look like it's held in the hand
            ctx.rotate(15 * Math.PI / 180);
            ctx.drawImage(img, -4, -20, 24, 24);
        } else {
            switch (item.id) {
                case 'axe':
                    // Axe handle
                    ctx.fillStyle = '#8B6914';
                    ctx.fillRect(0, -2, 18, 3);
                    // Axe head
                    ctx.fillStyle = '#888';
                    ctx.beginPath();
                    ctx.moveTo(16, -6);
                    ctx.lineTo(22, -2);
                    ctx.lineTo(22, 4);
                    ctx.lineTo(16, 8);
                    ctx.lineTo(16, -6);
                    ctx.fill();
                    break;
                case 'scoop':
                    // Handle
                    ctx.fillStyle = '#8B6914';
                    ctx.fillRect(0, -5, 15, 3);
                    // Bowl
                    ctx.fillStyle = '#999';
                    ctx.beginPath();
                    ctx.arc(15, -3.5, 6, 0, Math.PI);
                    ctx.fill();
                    break;
                case 'fishing_rod':
                    // Rod
                    ctx.strokeStyle = '#8B6914';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(0, 0);
                    ctx.lineTo(25, -15);
                    ctx.stroke();
                    // Line
                    ctx.strokeStyle = '#aaa';
                    ctx.lineWidth = 0.5;
                    ctx.beginPath();
                    ctx.moveTo(25, -15);
                    ctx.lineTo(25, 5);
                    ctx.stroke();
                    break;
                case 'ice_drill':
                    // Drill body
                    ctx.fillStyle = '#666';
                    ctx.fillRect(0, -8, 4, 20);
                    // Blade
                    ctx.fillStyle = '#aaa';
                    ctx.beginPath();
                    ctx.moveTo(-2, 12);
                    ctx.lineTo(2, 16);
                    ctx.lineTo(6, 12);
                    ctx.closePath();
                    ctx.fill();
                    // Handle
                    ctx.fillStyle = '#c33';
                    ctx.fillRect(-2, -10, 8, 4);
                    break;
                case 'flint_steel':
                    ctx.fillStyle = '#555';
                    ctx.fillRect(0, -2, 8, 6);
                    ctx.fillStyle = '#888';
                    ctx.fillRect(10, -1, 6, 4);
                    break;
                case 'tent':
                    // Small tent icon
                    ctx.fillStyle = '#7a8e6a';
                    ctx.beginPath();
                    ctx.moveTo(-5, 5);
                    ctx.lineTo(5, -10);
                    ctx.lineTo(15, 5);
                    ctx.closePath();
                    ctx.fill();
                    break;
                case 'torch': {
                    // Torch stick
                    ctx.fillStyle = '#6a4a2a';
                    ctx.fillRect(0, -2, 16, 3);
                    // Flame
                    const tf = Math.sin(Date.now() / 100) * 2;
                    ctx.fillStyle = '#ff8800';
                    ctx.beginPath();
                    ctx.moveTo(14, -5);
                    ctx.quadraticCurveTo(18, -14 + tf, 22, -5);
                    ctx.fill();
                    ctx.fillStyle = '#ffcc44';
                    ctx.beginPath();
                    ctx.moveTo(15, -4);
                    ctx.quadraticCurveTo(18, -10 + tf * 0.5, 21, -4);
                    ctx.fill();
                    break;
                }
            }
        }
        ctx.restore();
    }
};
