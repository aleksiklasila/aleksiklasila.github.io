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
    CAVE_BG: 6,

    grid: null,       // Uint8Array
    solidity: null,   // Uint8Array for fast lighting checks (0=pass, 255=solid)

    // Color palette [r, g, b] for each tile type
    COLORS: [
        null,             // 0: AIR
        [110, 85, 60],    // 1: GROUND
        [180, 220, 245],  // 2: ICE
        [18, 50, 105],    // 3: WATER
        [235, 240, 248],  // 4: SNOW
        [80, 70, 45],     // 5: LAKEBED
        [40, 30, 20],     // 6: CAVE_BG
    ],

    // Voxel tile caching
    TILE_SIZE_VX: 64, // voxels per tile side
    _tileCache: {},   // map of "tx,ty" -> { canvas, ctx, dirty }

    // Offscreen canvas for batch rendering (legacy/fallback)
    _canvas: null,
    _ctx: null,

    generate() {
        this.GRID_W = Math.ceil(World.WORLD_WIDTH * World.TILE_SIZE / this.SIZE);
        this.grid = new Uint8Array(this.GRID_W * this.GRID_H);
        this.solidity = new Uint8Array(this.GRID_W * this.GRID_H);
        this._tileCache = {};

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

                // Zelda-style Dungeon Check
                if (type === this.GROUND || type === this.LAKEBED || type === this.ICE || type === this.SNOW) {
                    if (Dungeons.isCave(worldX, worldY)) {
                        type = this.CAVE_BG;
                    }
                }

                const idx = vy * this.GRID_W + vx;
                this.grid[idx] = type;
                this.solidity[idx] = this.isSolid(type) ? 255 : 0;
            }
        }
    },

    get(vx, vy) {
        if (vx < 0 || vx >= this.GRID_W || vy < 0 || vy >= this.GRID_H) return this.GROUND;
        return this.grid[vy * this.GRID_W + vx];
    },

    set(vx, vy, type) {
        if (vx < 0 || vx >= this.GRID_W || vy < 0 || vy >= this.GRID_H) return;
        const idx = vy * this.GRID_W + vx;
        if (this.grid[idx] === type) return;

        this.grid[idx] = type;
        this.solidity[idx] = this.isSolid(type) ? 255 : 0;

        // Invalidate tile cache
        const tx = Math.floor(vx / this.TILE_SIZE_VX);
        const ty = Math.floor(vy / this.TILE_SIZE_VX);
        if (this._tileCache[`${tx},${ty}`]) {
            this._tileCache[`${tx},${ty}`].dirty = true;
        }
    },

    isSolid(type) {
        // CAVE_BG is NOT solid, allowing light to pass and players to fall through
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

    // Render visible voxels using tile-based caching
    render(ctx, camera, canvasW, canvasH) {
        const baseY = canvasH * 0.6;
        const camOffX = camera.x - canvasW / 2;
        const camOffY = camera.y;

        const startX = Math.floor((camera.x - canvasW / 2) / this.SIZE);
        const endX = Math.ceil((camera.x + canvasW / 2) / this.SIZE);

        const topWorldY = baseY + camOffY;
        const botWorldY = baseY + camOffY - canvasH;
        const startVy = Math.max(0, Math.floor((this.TOP_Y - topWorldY) / this.SIZE) - 1);
        const endVy = Math.min(this.GRID_H, Math.ceil((this.TOP_Y - botWorldY) / this.SIZE) + 1);

        const startTx = Math.floor(startX / this.TILE_SIZE_VX);
        const endTx = Math.floor(endX / this.TILE_SIZE_VX);
        const startTy = Math.floor(startVy / this.TILE_SIZE_VX);
        const endTy = Math.floor(endVy / this.TILE_SIZE_VX);

        for (let tx = startTx; tx <= endTx; tx++) {
            if (tx < 0 || tx * this.TILE_SIZE_VX >= this.GRID_W) continue;
            for (let ty = startTy; ty <= endTy; ty++) {
                if (ty < 0 || ty * this.TILE_SIZE_VX >= this.GRID_H) continue;

                const tile = this._getOrRenderTile(tx, ty);
                if (!tile) continue;

                const drawX = (tx * this.TILE_SIZE_VX) * this.SIZE - camOffX;
                const drawY = baseY - (this.TOP_Y - (ty * this.TILE_SIZE_VX) * this.SIZE) + camOffY;

                ctx.drawImage(tile.canvas, drawX, drawY);
            }
        }
    },

    _getOrRenderTile(tx, ty) {
        const key = `${tx},${ty}`;
        let tile = this._tileCache[key];

        if (!tile) {
            const canvas = document.createElement('canvas');
            canvas.width = this.TILE_SIZE_VX * this.SIZE;
            canvas.height = this.TILE_SIZE_VX * this.SIZE;
            tile = { canvas, ctx: canvas.getContext('2d'), dirty: true };
            this._tileCache[key] = tile;
        }

        if (tile.dirty) {
            this._renderTile(tx, ty, tile);
            tile.dirty = false;
        }

        return tile;
    },

    _renderTile(tx, ty, tile) {
        const vxStart = tx * this.TILE_SIZE_VX;
        const vyStart = ty * this.TILE_SIZE_VX;
        const tSize = this.TILE_SIZE_VX;

        const imgData = tile.ctx.createImageData(tSize * this.SIZE, tSize * this.SIZE);
        const data32 = new Uint32Array(imgData.data.buffer);

        for (let lvy = 0; lvy < tSize; lvy++) {
            const vy = vyStart + lvy;
            if (vy >= this.GRID_H) break;
            const rowOff = vy * this.GRID_W;

            for (let lvx = 0; lvx < tSize; lvx++) {
                const vx = vxStart + lvx;
                if (vx >= this.GRID_W) break;

                const type = this.grid[rowOff + vx];
                if (type === this.AIR) continue;
                // CAVE_BG still gets rendered, allowing the cavern walls to be distinct from the sky

                const baseColor = this.COLORS[type];
                if (!baseColor) continue;

                const hash = ((vx * 7919 + vy * 6271) & 255) / 255;
                const v = (hash - 0.5) * 18;

                let depthDarken = 0;
                // Darken CAVE_BG based on depth too 
                if (type === this.GROUND || type === this.LAKEBED || type === this.CAVE_BG) {
                    const surfVy = Math.floor((this.TOP_Y - 0) / this.SIZE);
                    depthDarken = Math.min(40, Math.max(0, (vy - surfVy) * 0.4));
                }

                const r = Math.max(0, Math.min(255, baseColor[0] + v - depthDarken));
                const g = Math.max(0, Math.min(255, baseColor[1] + v - depthDarken));
                const b = Math.max(0, Math.min(255, baseColor[2] + v - depthDarken));
                const a = type === this.WATER ? 210 : 255;

                const colValue = (a << 24) | (b << 16) | (g << 8) | r;

                // Fill SIZE x SIZE pixels
                for (let py = 0; py < this.SIZE; py++) {
                    const lineOffset = (lvy * this.SIZE + py) * (tSize * this.SIZE);
                    for (let px = 0; px < this.SIZE; px++) {
                        data32[lineOffset + (lvx * this.SIZE + px)] = colValue;
                    }
                }
            }
        }
        tile.ctx.putImageData(imgData, 0, 0);
    },

    // Get solidity chunk for GPU lighting (0=pass-through, 255=solid)
    getSolidityChunk(startVx, startVy, width, height) {
        const data = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            const vy = startVy + y;
            if (vy < 0 || vy >= this.GRID_H) {
                if (vy >= this.GRID_H) data.fill(255, y * width, (y + 1) * width);
                continue;
            }
            const gridRowOff = vy * this.GRID_W + startVx;
            const chunkRowOff = y * width;

            // Subarray and set is faster than per-pixel loop
            const rowData = this.solidity.subarray(gridRowOff, gridRowOff + width);
            data.set(rowData, chunkRowOff);
        }
        return data;
    }
};
