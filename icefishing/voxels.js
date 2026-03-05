// voxels.js — Voxel-based terrain system
const Voxels = {
    SIZE: 4,          // pixels per voxel
    GRID_W: 0,
    GRID_H: 300,      // voxel rows
    TOP_Y: 500,       // world Y at voxel row 0

    // Tile types
    AIR: 0,
    GROUND: 1,
    ICE: 2,
    WATER: 3,
    SNOW: 4,
    LAKEBED: 5,

    grid: null,       // Uint8Array

    // Color palette [r, g, b] for each tile type
    COLORS: [
        null,             // 0: AIR
        [110, 85, 60],    // 1: GROUND
        [180, 220, 245],  // 2: ICE
        [18, 50, 105],    // 3: WATER
        [235, 240, 248],  // 4: SNOW
        [80, 70, 45],     // 5: LAKEBED
    ],

    // Offscreen canvas for batch rendering
    _canvas: null,
    _ctx: null,

    generate() {
        this.GRID_W = Math.ceil(World.WORLD_WIDTH * World.TILE_SIZE / this.SIZE);
        this.grid = new Uint8Array(this.GRID_W * this.GRID_H);

        for (let vx = 0; vx < this.GRID_W; vx++) {
            const worldX = vx * this.SIZE;
            const colIdx = Math.min(Math.floor(worldX / World.TILE_SIZE), World.WORLD_WIDTH - 1);
            if (colIdx < 0) continue;
            const col = World.columns[colIdx];

            const surfaceWorldY = (col.type === 'ice' || col.type === 'water') ? 0 : col.surfaceY;
            const isWaterArea = (col.type === 'ice' || col.type === 'water');
            const lakebedWorldY = isWaterArea ? col.surfaceY : -9999;

            for (let vy = 0; vy < this.GRID_H; vy++) {
                const worldY = this.TOP_Y - vy * this.SIZE;
                let type = this.AIR;

                if (col.type === 'ground' || col.type === 'shore') {
                    if (worldY <= surfaceWorldY && worldY > surfaceWorldY - 10) {
                        type = this.SNOW;
                    } else if (worldY <= surfaceWorldY - 10) {
                        type = this.GROUND;
                    }
                } else if (col.type === 'ice') {
                    if (worldY <= 6 && worldY > -6) {
                        type = this.ICE;
                    } else if (worldY <= -6 && worldY > lakebedWorldY) {
                        type = this.WATER;
                    } else if (worldY <= lakebedWorldY) {
                        type = this.LAKEBED;
                    }
                } else if (col.type === 'water') {
                    if (worldY <= 2 && worldY > lakebedWorldY) {
                        type = this.WATER;
                    } else if (worldY <= lakebedWorldY) {
                        type = this.LAKEBED;
                    }
                }

                this.grid[vy * this.GRID_W + vx] = type;
            }
        }
    },

    get(vx, vy) {
        if (vx < 0 || vx >= this.GRID_W || vy < 0 || vy >= this.GRID_H) return this.GROUND;
        return this.grid[vy * this.GRID_W + vx];
    },

    set(vx, vy, type) {
        if (vx < 0 || vx >= this.GRID_W || vy < 0 || vy >= this.GRID_H) return;
        this.grid[vy * this.GRID_W + vx] = type;
    },

    isSolid(type) {
        return type === this.GROUND || type === this.ICE || type === this.SNOW || type === this.LAKEBED;
    },

    worldToVoxel(worldX, worldY) {
        return {
            vx: Math.floor(worldX / this.SIZE),
            vy: Math.floor((this.TOP_Y - worldY) / this.SIZE)
        };
    },

    voxelToWorld(vx, vy) {
        return {
            x: vx * this.SIZE,
            y: this.TOP_Y - vy * this.SIZE
        };
    },

    // Drill a hole — remove ice voxels in a radius
    drillHole(worldX) {
        const centerVx = Math.floor(worldX / this.SIZE);
        const iceCenterVy = Math.floor(this.TOP_Y / this.SIZE); // worldY=0 → vy
        const radiusX = 5;
        const radiusY = 4;

        for (let dx = -radiusX; dx <= radiusX; dx++) {
            for (let dy = -radiusY; dy <= radiusY; dy++) {
                const vx = centerVx + dx;
                const vy = iceCenterVy + dy;
                const type = this.get(vx, vy);
                if (type === this.ICE || type === this.SNOW) {
                    this.set(vx, vy, this.AIR);
                }
            }
        }
        // Mark that lighting texture needs refresh
        this._dirty = true;
    },

    _dirty: true,

    // Render visible voxels using offscreen canvas
    render(ctx, camera, canvasW, canvasH) {
        const baseY = canvasH * 0.6;

        // Determine visible voxel range
        const camOffX = camera.x - canvasW / 2;
        const startVx = Math.max(0, Math.floor(camOffX / this.SIZE) - 1);
        const endVx = Math.min(this.GRID_W, startVx + Math.ceil(canvasW / this.SIZE) + 2);

        const topWorldY = baseY; // screenY=0 → worldY=baseY
        const botWorldY = baseY - canvasH; // screenY=canvasH → worldY=baseY-canvasH
        const startVy = Math.max(0, Math.floor((this.TOP_Y - topWorldY) / this.SIZE) - 1);
        const endVy = Math.min(this.GRID_H, Math.ceil((this.TOP_Y - botWorldY) / this.SIZE) + 1);

        const renderW = endVx - startVx;
        const renderH = endVy - startVy;
        if (renderW <= 0 || renderH <= 0) return;

        // Create/resize offscreen canvas for voxel chunk
        if (!this._canvas || this._canvas.width < renderW || this._canvas.height < renderH) {
            this._canvas = document.createElement('canvas');
            this._canvas.width = Math.max(renderW, 600);
            this._canvas.height = Math.max(renderH, 400);
            this._ctx = this._canvas.getContext('2d');
        }

        const imgData = this._ctx.createImageData(renderW, renderH);
        const data = imgData.data;

        for (let ly = 0; ly < renderH; ly++) {
            const vy = startVy + ly;
            const rowOff = vy * this.GRID_W;
            for (let lx = 0; lx < renderW; lx++) {
                const vx = startVx + lx;
                const type = this.grid[rowOff + vx];
                if (type === this.AIR) continue;

                const baseColor = this.COLORS[type];
                if (!baseColor) continue;

                // Pseudo-random per-voxel variation for texture
                const hash = ((vx * 7919 + vy * 6271) & 255) / 255;
                const v = (hash - 0.5) * 18;

                // Depth darkening for ground (deeper = darker)
                let depthDarken = 0;
                if (type === this.GROUND || type === this.LAKEBED) {
                    const surfVy = Math.floor((this.TOP_Y - 0) / this.SIZE);
                    depthDarken = Math.min(40, Math.max(0, (vy - surfVy) * 0.4));
                }

                const idx = (ly * renderW + lx) * 4;
                data[idx] = Math.max(0, Math.min(255, baseColor[0] + v - depthDarken));
                data[idx + 1] = Math.max(0, Math.min(255, baseColor[1] + v - depthDarken));
                data[idx + 2] = Math.max(0, Math.min(255, baseColor[2] + v - depthDarken));
                data[idx + 3] = type === this.WATER ? 210 : 255;
            }
        }

        this._ctx.putImageData(imgData, 0, 0);

        // Draw the voxel chunk onto the main canvas at the correct position
        const drawX = startVx * this.SIZE - camOffX;
        const drawY = baseY - (this.TOP_Y - startVy * this.SIZE);

        ctx.drawImage(this._canvas, 0, 0, renderW, renderH,
            drawX, drawY, renderW * this.SIZE, renderH * this.SIZE);
    },

    // Get solidity chunk for GPU lighting (0=pass-through, 255=solid)
    getSolidityChunk(startVx, startVy, width, height) {
        const data = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const type = this.get(startVx + x, startVy + y);
                data[y * width + x] = this.isSolid(type) ? 255 : 0;
            }
        }
        return data;
    }
};
