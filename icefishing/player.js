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
        if (keys['KeyA'] || keys['ArrowLeft']) {
            this.vx = -this.speed;
            this.facing = -1;
            moving = true;
        } else if (keys['KeyD'] || keys['ArrowRight']) {
            this.vx = this.speed;
            this.facing = 1;
            moving = true;
        } else {
            this.vx = 0;
        }

        this.state = moving ? 'walking' : 'idle';

        // Apply movement
        this.x += this.vx * dt;
        // Clamp to world
        this.x = Math.max(40, Math.min((World.WORLD_WIDTH - 1) * World.TILE_SIZE, this.x));

        // Stick to terrain surface
        const surfaceY = World.getSurfaceY(this.x);
        this.y = surfaceY;

        // Animation
        this.animTimer += dt;
        if (this.animTimer > 0.15) {
            this.animTimer = 0;
            this.animFrame = (this.animFrame + 1) % 4;
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

        // Warmth drain
        let warmthDrain = this.drainRates.warmth;
        if (isOnIce) warmthDrain *= 1.5;
        if (isInStorm && !isInTent) warmthDrain *= 2.5;
        if (isNight) warmthDrain *= 1.8;

        // Tent reduces warmth drain significantly
        if (isInTent) {
            warmthDrain *= 0.3; // 70% reduction
        }

        // Check if near campfire
        let nearFire = false;
        for (const fire of World.campfires) {
            if (fire.lit && Math.abs(fire.x - this.x) < 80) {
                nearFire = true;
                break;
            }
        }
        if (nearFire) {
            this.stats.warmth = Math.min(100, this.stats.warmth + dt * 8);
            this.stats.sleep = Math.min(100, this.stats.sleep + dt * 1);
        } else if (isInTent) {
            // Tent gives mild warmth recovery and sleep recovery
            this.stats.warmth = Math.min(100, this.stats.warmth + dt * 2);
            this.stats.sleep = Math.min(100, this.stats.sleep + dt * 3);
        } else {
            this.stats.warmth -= warmthDrain * dt;
        }

        this.stats.hunger -= this.drainRates.hunger * dt;
        this.stats.thirst -= this.drainRates.thirst * dt;
        if (!isInTent) {
            this.stats.sleep -= this.drainRates.sleep * dt;
        }

        // Clamp
        for (const key of Object.keys(this.stats)) {
            this.stats[key] = Math.max(0, Math.min(100, this.stats[key]));
        }

        // Death check
        for (const [key, val] of Object.entries(this.stats)) {
            if (val <= 0) {
                this.isDead = true;
                this.state = 'dying';
                const causes = {
                    warmth: 'Froze to death',
                    hunger: 'Starved to death',
                    thirst: 'Died of dehydration',
                    sleep: 'Died of exhaustion'
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
        const img = Assets.get('player');
        if (img) {
            // Draw sprite (approx 32x48 scale)
            ctx.drawImage(img, -16, -44 - bobY, 32, 48);
        }

        // Held item rendering
        if (this.state !== 'fishing') {
            const item = Inventory.getSelectedItem();
            if (item) {
                this.renderHeldItem(ctx, item, bobY);
            }
        }

        ctx.restore();
    },

    renderHeldItem(ctx, item, bobY) {
        ctx.save();
        ctx.translate(10, -14 - bobY);

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
            }
        }
        ctx.restore();
    }
};
