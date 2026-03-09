// fishing.js — Fishing system integrated into normal gameplay
const Fishing = {
    active: false,
    hole: null,

    // Fishing state
    baitDepth: 50,       // 0=surface, 100=deep (in percentage)
    maxDepth: 100,

    // Fish in the water (spawned at world generation)
    worldFish: [],

    // Hooked state
    hooked: false,
    hookedFish: null,
    hookedDepth: 0,     // depth (0..1) where the fish was hooked
    reelProgress: 0,    // 0=in water, 100=caught
    fishResistance: 0,
    escapeTimer: 0,

    // Fish types
    FISH_TYPES: [
        { id: 'small_perch', name: 'Perch', minDepth: 20, maxDepth: 60, rarity: 0.4, size: 1, resistance: 15, speed: 30, item: 'raw_fish' },
        { id: 'pike', name: 'Pike', minDepth: 40, maxDepth: 90, rarity: 0.25, size: 2, resistance: 35, speed: 25, item: 'raw_fish_large' },
        { id: 'whitefish', name: 'Whitefish', minDepth: 30, maxDepth: 70, rarity: 0.3, size: 1, resistance: 20, speed: 35, item: 'raw_fish' },
        { id: 'burbot', name: 'Burbot', minDepth: 60, maxDepth: 100, rarity: 0.15, size: 2, resistance: 40, speed: 20, item: 'raw_fish_large' },
        { id: 'trout', name: 'Lake Trout', minDepth: 50, maxDepth: 95, rarity: 0.1, size: 2, resistance: 45, speed: 22, item: 'raw_fish_large' }
    ],

    // Collision radius for fish biting bait
    BITE_RADIUS: 12,

    init() {
        this.worldFish = [];
    },

    // Called after World.generate() — spawn fish across all ice/water regions
    generateWorldFish() {
        this.worldFish = [];

        // Find contiguous ice/water regions
        let regionStart = -1;
        for (let i = 0; i <= World.WORLD_WIDTH; i++) {
            const isIceOrWater = i < World.WORLD_WIDTH &&
                (World.columns[i].type === 'ice' || World.columns[i].type === 'water');

            if (isIceOrWater && regionStart === -1) {
                regionStart = i;
            } else if (!isIceOrWater && regionStart !== -1) {
                // Found a complete ice/water region
                const startX = regionStart * World.TILE_SIZE;
                const endX = i * World.TILE_SIZE;
                const width = endX - startX;

                // About 1 fish per 4 tiles, capped at 15 per region
                const count = Math.max(2, Math.min(15, Math.floor(width / (World.TILE_SIZE * 4))));
                for (let j = 0; j < count; j++) {
                    this.spawnRegionFish(startX, endX);
                }

                regionStart = -1;
            }
        }
        console.log(`Spawned ${this.worldFish.length} fish.`);
    },

    spawnRegionFish(regionStartX, regionEndX) {
        // Pick a random fish type
        const totalWeight = this.FISH_TYPES.reduce((sum, f) => sum + f.rarity, 0);
        let r = Math.random() * totalWeight;
        let selected = this.FISH_TYPES[0];
        for (const f of this.FISH_TYPES) {
            r -= f.rarity;
            if (r <= 0) { selected = f; break; }
        }

        const depth = (selected.minDepth + Math.random() * (selected.maxDepth - selected.minDepth)) / 100;
        const x = regionStartX + Math.random() * (regionEndX - regionStartX);
        const initVx = (Math.random() - 0.5) * selected.speed;
        const initVy = (Math.random() - 0.5) * selected.speed * 0.004;

        this.worldFish.push({
            x: x,
            y: depth,
            vx: initVx,
            vy: initVy,
            targetVx: initVx,
            targetVy: initVy,
            speed: selected.speed,
            type: selected,
            regionStartX: regionStartX,
            regionEndX: regionEndX,
            dirTimer: 1 + Math.random() * 2,
            facing: initVx >= 0 ? 1 : -1
        });
    },

    startFishing(hole) {
        if (!Inventory.hasItem('bait', 1)) {
            Game.showMessage('No bait!', 1.5);
            return false;
        }

        this.active = true;
        this.hole = hole;
        this.baitDepth = 30;
        this.hooked = false;
        this.hookedFish = null;
        this.hookedDepth = 0;
        this.reelProgress = 0;
        this.escapeTimer = 0;

        Inventory.removeItem('bait', 1);
        Player.state = 'fishing';

        Game.showMessage('Fishing! W/S to set depth.', 2);
        return true;
    },

    stopFishing() {
        this.active = false;
        this.hooked = false;
        this.hookedFish = null;
        Player.state = 'idle';
    },

    update(dt, keys, keysJustPressed) {
        // Always update fish movement
        this.updateWorldFish(dt);

        if (!this.active) return;

        // Cancel with E
        if (keysJustPressed['KeyE']) {
            this.stopFishing();
            return;
        }

        if (this.hooked) {
            this.updateReeling(dt, keys);
            return;
        }

        // Control bait depth with W/S
        const waterDepthPx = Math.max(10, World.getWaterDepth(this.hole.x));
        const rodSpeedPxSec = 60; // constant speed in pixels per second
        const pctPerSec = (rodSpeedPxSec / waterDepthPx) * 100;

        if (keys['KeyW']) {
            this.baitDepth -= pctPerSec * dt;
            if (this.baitDepth <= 0) {
                this.stopFishing();
                return;
            }
        }
        if (keys['KeyS']) {
            this.baitDepth = Math.min(this.maxDepth, this.baitDepth + pctPerSec * dt);
        }

        // Check collision between bait and fish
        if (this.hole) {
            this.checkFishBiteCollision();
        }
    },

    updateWorldFish(dt) {
        for (let i = this.worldFish.length - 1; i >= 0; i--) {
            const fish = this.worldFish[i];

            // Smooth movement
            fish.x += fish.vx * dt;
            fish.y += fish.vy * dt;

            // Update facing based on velocity
            if (Math.abs(fish.vx) > 1) {
                fish.facing = fish.vx > 0 ? 1 : -1;
            }

            // Change direction occasionally — mostly horizontal
            fish.dirTimer -= dt;
            if (fish.dirTimer <= 0) {
                fish.targetVx = (Math.random() - 0.5) * fish.speed;
                fish.targetVy = (Math.random() - 0.5) * fish.speed * 0.006;
                fish.dirTimer = 2 + Math.random() * 4;
            }

            // Smooth velocity interpolation
            const lerpRate = 2.0 * dt;
            fish.vx += (fish.targetVx - fish.vx) * lerpRate;
            fish.vy += (fish.targetVy - fish.vy) * lerpRate;

            // Keep fish within their ice/water region — soft steering
            const distFromStart = fish.x - fish.regionStartX;
            const distFromEnd = fish.regionEndX - fish.x;
            const margin = 30;
            if (distFromStart < margin) {
                fish.targetVx = Math.abs(fish.targetVx);
            } else if (distFromEnd < margin) {
                fish.targetVx = -Math.abs(fish.targetVx);
            }
            // Hard clamp
            if (fish.x < fish.regionStartX) { fish.x = fish.regionStartX; fish.vx = Math.abs(fish.vx); }
            if (fish.x > fish.regionEndX) { fish.x = fish.regionEndX; fish.vx = -Math.abs(fish.vx); }

            // Depth bounds — gentle steering
            const minY = fish.type.minDepth * 0.01;
            const maxY = fish.type.maxDepth * 0.01;
            if (fish.y < minY + 0.05) {
                fish.targetVy = 0.04;
            } else if (fish.y > maxY - 0.05) {
                fish.targetVy = -0.04;
            }
            if (fish.y < minY) { fish.y = minY; fish.vy = Math.abs(fish.vy); }
            if (fish.y > maxY) { fish.y = maxY; fish.vy = -Math.abs(fish.vy); }
        }
    },

    checkFishBiteCollision() {
        if (!this.hole || this.hooked) return;

        const baitWorldX = this.hole.x;
        const baitDepthNorm = this.baitDepth / this.maxDepth;

        for (let i = this.worldFish.length - 1; i >= 0; i--) {
            const fish = this.worldFish[i];

            const dx = fish.x - baitWorldX;
            const dy = (fish.y - baitDepthNorm) * World.getWaterDepth(fish.x);
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < this.BITE_RADIUS) {
                // Fish bites!
                this.hooked = true;
                this.hookedFish = fish;
                this.hookedDepth = fish.y;
                this.reelProgress = 0;
                this.fishResistance = fish.type.resistance;
                this.escapeTimer = 3 + Math.random() * 2;
                this.baitDepth = fish.y * this.maxDepth;

                // Remove from world fish
                this.worldFish.splice(i, 1);

                Game.showMessage(`${fish.type.name} on the line! Reel up with W!`, 2);
                return;
            }
        }
    },

    updateReeling(dt, keys) {
        this.escapeTimer -= dt;

        const hookDepthPx = Math.max(10, this.hookedDepth * World.getWaterDepth(this.hole.x));

        if (keys['KeyW']) {
            const reelSpeedPxSec = 100 - this.fishResistance * 1.2;
            const speedPx = Math.max(10, reelSpeedPxSec);
            const progressSpeed = (speedPx / hookDepthPx) * 100;
            this.reelProgress += progressSpeed * dt;
        } else {
            const fallSpeedPxSec = this.fishResistance * 0.6;
            const progressSpeed = (fallSpeedPxSec / hookDepthPx) * 100;
            this.reelProgress -= progressSpeed * dt;
        }

        if (Math.random() < 0.02) {
            this.fishResistance = this.hookedFish.type.resistance * (0.5 + Math.random());
        }

        this.reelProgress = Math.max(0, Math.min(100, this.reelProgress));
        this.baitDepth = this.hookedDepth * this.maxDepth * (1 - this.reelProgress / 100);

        if (this.reelProgress >= 100) {
            Game.showMessage(`Caught a ${this.hookedFish.type.name}!`, 2.5);
            Inventory.addItem(this.hookedFish.type.item, 1);
            Inventory.damageSelectedItem(1);

            const col = World.getColumnAt(this.hole.x);
            if (col) {
                World.fishEggs.push({ x: this.hole.x, surfaceY: col.surfaceY });
            }

            this.stopFishing();
        }

        if (this.reelProgress <= -10 || this.escapeTimer <= 0) {
            Game.showMessage('The fish got away!', 2);
            Inventory.damageSelectedItem(1);
            this.stopFishing();
        }
    },

    // Render fish and fishing line in the world view
    render(ctx, camera, canvasW, canvasH) {
        const baseY = canvasH * 0.6;

        // Render all world fish (shadow overlay handles visibility)
        for (const fish of this.worldFish) {
            const fishSX = fish.x - camera.x + canvasW / 2;
            if (fishSX < -50 || fishSX > canvasW + 50) continue;

            const fishSY = baseY + 6 + fish.y * World.getWaterDepth(fish.x);
            this.renderFish(ctx, fishSX, fishSY, fish);
        }

        // Render hooked fish being reeled
        if (this.hooked && this.hookedFish && this.hole) {
            const holeSX = this.hole.x - camera.x + canvasW / 2;
            const currentDepth = this.hookedDepth * (1 - this.reelProgress / 100);
            const hookedY = baseY + 6 + currentDepth * World.getWaterDepth(this.hole.x);
            const wobble = Math.sin(Date.now() / 100) * 8;
            this.renderFish(ctx, holeSX + wobble, hookedY, this.hookedFish, true);
        }

        // Render fishing line and bait when active
        if (!this.active || !this.hole) return;

        const holeSX = this.hole.x - camera.x + canvasW / 2;
        const iceScreenY = baseY;
        const baitScreenY = iceScreenY + 6 + (this.baitDepth / this.maxDepth) * World.getWaterDepth(this.hole.x);

        // Fishing line
        ctx.strokeStyle = '#aaa';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(holeSX, iceScreenY - 5);
        ctx.lineTo(holeSX, baitScreenY);
        ctx.stroke();

        // Bait (always show hook, even when hooked)
        ctx.fillStyle = '#d4956a';
        ctx.beginPath();
        ctx.arc(holeSX, baitScreenY, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ccc';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(holeSX, baitScreenY + 4, 3, 0, Math.PI);
        ctx.stroke();

        // Depth indicator
        const waterDepthPx = World.getWaterDepth(this.hole.x);
        const actualDepthPx = (this.baitDepth / this.maxDepth) * waterDepthPx;
        const actualDepthMeters = (actualDepthPx / 20).toFixed(1);

        ctx.fillStyle = 'rgba(150,200,255,0.7)';
        ctx.font = '10px monospace';
        ctx.fillText(`${actualDepthMeters}m`, holeSX + 10, baitScreenY);

        // Reeling progress bar
        if (this.hooked) {
            const barW = 80;
            const barH = 8;
            const barX = holeSX - barW / 2;
            const barY = iceScreenY - 30;
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillRect(barX - 2, barY - 2, barW + 4, barH + 4);
            ctx.fillStyle = this.reelProgress > 70 ? '#44cc44' : '#4488cc';
            ctx.fillRect(barX, barY, barW * (this.reelProgress / 100), barH);
            ctx.strokeStyle = '#aaa';
            ctx.strokeRect(barX - 2, barY - 2, barW + 4, barH + 4);

            if (this.escapeTimer < 2) {
                const flash = Math.sin(Date.now() / 100) > 0 ? 1 : 0.3;
                ctx.fillStyle = `rgba(255,100,50,${flash})`;
                ctx.font = 'bold 11px monospace';
                ctx.textAlign = 'center';
                ctx.fillText('REEL UP!', holeSX, barY - 5);
                ctx.textAlign = 'left';
            }
        }

        // Fishing status hint
        if (!this.hooked) {
            ctx.fillStyle = 'rgba(150,180,200,0.5)';
            ctx.font = '10px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('W/S depth  E cancel', holeSX, iceScreenY - 15);
            ctx.textAlign = 'left';
        }
    },

    renderFish(ctx, x, y, fish, isHooked = false) {
        const size = fish.type ? fish.type.size : fish.size || 1;
        const facing = fish.facing || (fish.vx >= 0 ? 1 : -1);

        const img = Assets.get(fish.type ? fish.type.item : 'raw_fish');
        if (img) {
            ctx.save();
            ctx.translate(x, y);
            ctx.scale(facing, 1);
            if (isHooked) {
                ctx.globalAlpha = 0.8 + Math.sin(Date.now() / 80) * 0.2;
            }
            const w = 20 * size;
            const h = 14 * size;
            ctx.drawImage(img, -w / 2, -h / 2, w, h);
            ctx.globalAlpha = 1.0;
            ctx.restore();
        } else {
            ctx.save();
            ctx.translate(x, y);
            ctx.scale(facing, 1);
            ctx.fillStyle = isHooked ? '#ffaa44' : 'rgba(100,160,200,0.8)';
            ctx.beginPath();
            ctx.ellipse(0, 0, 10 * size, 5 * size, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(10 * size, 0);
            ctx.lineTo(16 * size, -4 * size);
            ctx.lineTo(16 * size, 4 * size);
            ctx.fill();
            ctx.fillStyle = '#222';
            ctx.beginPath();
            ctx.arc(-5 * size, -1 * size, 1.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }
};
