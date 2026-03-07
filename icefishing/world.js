// world.js — Sky, mountains, surface objects (terrain is now in voxels.js)
const World = {
    TILE_SIZE: 40,
    WORLD_WIDTH: 5000,
    columns: [],
    trees: [],
    fishingHoles: [],
    tents: [],
    torches: [],
    groundItems: [],
    shop: null,
    repairShop: null,
    fishEggs: [],
    treeEggs: [],
    bridges: [],
    rocks: [],
    rockEggs: [],

    generate(seed) {
        Perlin.seed(seed || (Math.random() * 100000) | 0);
        this.columns = [];
        this.trees = [];
        this.fishingHoles = [];
        this.campfires = [];
        this.tents = [];
        this.torches = [];
        this.groundItems = [];
        this.fishEggs = [];
        this.treeEggs = [];
        this.bridges = [];
        this.rocks = [];
        this.rockEggs = [];

        const centerCol = Math.floor(this.WORLD_WIDTH / 2);

        for (let x = 0; x < this.WORLD_WIDTH; x++) {
            const nx = x / 80;
            const elevation = Perlin.fbm(nx, 0, 5, 2.0, 0.5) * 1.2;
            const detail = Perlin.fbm(nx, 10, 3, 2.0, 0.4) * 0.3;
            const current = Math.abs(Perlin.fbm(nx, 50, 3, 2.5, 0.6));

            // Scale terrain amplitude with distance from center (continuous)
            const terrainMult = Difficulty.getTerrainMultiplier(x, centerCol);
            let height = (elevation + detail) * terrainMult;

            // Force a flat, safe ground area around the origin (spawn)
            const distFromCenterRows = Math.abs(x - centerCol);
            if (distFromCenterRows < 25) {
                const blend = 1.0 - (distFromCenterRows / 25);
                height = (height * (1 - blend)) + (0.15 * blend);
            }

            let type;
            if (height > 0.02) type = 'ground';
            else if (height > -0.02) type = 'shore';
            else type = current > 0.4 ? 'water' : 'ice';

            const surfaceY = height * 300;

            this.columns.push({ x, surfaceY, height, type, current, snowDepth: Math.random() * 3 + 1 });

            if (type === 'ground' && height > 0.06) {
                const treeDensity = Perlin.fbm(nx, 100, 2, 2.0, 0.5);
                if (treeDensity > 0 && Math.random() < 0.80) {
                    this.trees.push({
                        x: x * this.TILE_SIZE + Math.random() * 20 - 10,
                        groundCol: x,
                        type: (Math.random() * 3) | 0,
                        alive: true
                    });
                }
                // Rocks spawn on higher ground with some randomness (rarer)
                if (height > 0.1 && Math.random() < 0.083) {
                    this.rocks.push({
                        x: x * this.TILE_SIZE + Math.random() * 20 - 10,
                        groundCol: x,
                        alive: true
                    });
                }
            }
        }

        // Place the shop relatively close to spawn
        let spawnCol = Math.floor(this.WORLD_WIDTH / 2);
        for (let i = spawnCol; i < this.WORLD_WIDTH; i++) {
            if (this.columns[i].type === 'ground' && this.columns[i].height > 0.1) {
                // Place shop a bit further than the spawn point so the player doesn't spawn exactly inside it
                this.shop = {
                    x: (i + 4) * this.TILE_SIZE,
                    surfaceY: this.columns[i + 4].surfaceY
                };

                // Place repair shop slightly further
                // Need to make sure we don't index out of bounds, but i+15 is generally safe near spawn
                let repairIdx = Math.min(i + 12, this.WORLD_WIDTH - 1);
                this.repairShop = {
                    x: repairIdx * this.TILE_SIZE,
                    surfaceY: this.columns[repairIdx].surfaceY
                };
                break;
            }
        }
    },

    getSurfaceY(worldX) {
        const col = (worldX / this.TILE_SIZE) | 0;
        if (col < 0 || col >= this.WORLD_WIDTH - 1) return 0;
        const c = this.columns[col];
        const c1 = this.columns[Math.min(col + 1, this.WORLD_WIDTH - 1)];
        const y0 = (c.type === 'ice' || c.type === 'water') ? 0 : c.surfaceY;
        const y1 = (c1.type === 'ice' || c1.type === 'water') ? 0 : c1.surfaceY;
        const frac = (worldX / this.TILE_SIZE) - col;
        return y0 + (y1 - y0) * frac;
    },

    getColumnAt(worldX) {
        const col = Math.round(worldX / this.TILE_SIZE);
        if (col < 0 || col >= this.WORLD_WIDTH) return null;
        return this.columns[col];
    },

    getWaterDepth(worldX) {
        const col = this.getColumnAt(worldX);
        if (!col || (col.type !== 'water' && col.type !== 'ice')) return 100; // default for non-water
        return -col.surfaceY;
    },

    addFishingHole(worldX) {
        const col = this.getColumnAt(worldX);
        if (!col || col.type !== 'ice') return false;
        for (const h of this.fishingHoles) {
            if (Math.abs(h.x - worldX) < this.TILE_SIZE) return false;
        }
        this.fishingHoles.push({ x: worldX, col: Math.round(worldX / this.TILE_SIZE), surfaceY: 0 });
        return true;
    },

    addBridge(worldX) {
        const colIdx = Math.round(worldX / this.TILE_SIZE);
        const col = this.getColumnAt(worldX);
        if (!col || col.type !== 'water') return false;

        // Check if there's already a bridge at this exact spot
        for (const b of this.bridges) {
            if (colIdx >= b.startCol && colIdx <= b.endCol) return false;
        }

        // Expand left to find start of water or an existing bridge
        let leftCol = colIdx;
        while (leftCol > 0 && this.columns[leftCol - 1].type === 'water') {
            const hasBridge = this.bridges.some(b => (leftCol - 1) >= b.startCol && (leftCol - 1) <= b.endCol);
            if (hasBridge) break;
            leftCol--;
        }

        // Expand right to find end of water or an existing bridge
        let rightCol = colIdx;
        while (rightCol < this.WORLD_WIDTH - 1 && this.columns[rightCol + 1].type === 'water') {
            const hasBridge = this.bridges.some(b => (rightCol + 1) >= b.startCol && (rightCol + 1) <= b.endCol);
            if (hasBridge) break;
            rightCol++;
        }

        // We want a max of 10 tiles. If the span is longer, truncate it.
        const maxSpan = 10;
        let span = rightCol - leftCol + 1;
        if (span > maxSpan) {
            if (colIdx - leftCol < rightCol - colIdx) {
                // Closer to left shore, anchor to left
                rightCol = leftCol + maxSpan - 1;
            } else {
                // Closer to right shore, anchor to right
                leftCol = rightCol - maxSpan + 1;
            }
        }

        this.bridges.push({ startCol: leftCol, endCol: rightCol, surfaceY: 0 });
        return true;
    },

    isBridgeAt(worldX) {
        const colIdx = Math.round(worldX / this.TILE_SIZE);
        for (const b of this.bridges) {
            if (colIdx >= b.startCol && colIdx <= b.endCol) return true;
        }
        return false;
    },

    addCampfire(worldX) {
        const col = this.getColumnAt(worldX);
        if (!col || col.type === 'water') return false;
        const surfaceY = (col.type === 'ice') ? 0 : col.surfaceY;
        const fire = { x: worldX, surfaceY, fuel: 100, lit: false };
        this.campfires.push(fire);
        return fire;
    },

    addTorch(worldX, fuel = 100, isLit = false) {
        const col = this.getColumnAt(worldX);
        if (!col || col.type === 'water') return false;
        const surfaceY = (col.type === 'ice') ? 0 : col.surfaceY;
        const torch = { x: worldX, surfaceY, fuel, lit: isLit };
        this.torches.push(torch);
        return torch;
    },

    removeTorchNear(worldX) {
        for (let i = 0; i < this.torches.length; i++) {
            if (Math.abs(this.torches[i].x - worldX) < 50) {
                const data = { fuel: this.torches[i].fuel, lit: this.torches[i].lit };
                this.torches.splice(i, 1);
                return data;
            }
        }
        return false;
    },

    addGroundItem(worldX, item) {
        const col = this.getColumnAt(worldX);
        if (!col) return false;
        const surfaceY = (col.type === 'ice' || col.type === 'water') ? 0 : col.surfaceY;
        this.groundItems.push({ x: worldX, surfaceY, item: { ...item } });
        return true;
    },

    removeGroundItemNear(worldX) {
        for (let i = 0; i < this.groundItems.length; i++) {
            if (Math.abs(this.groundItems[i].x - worldX) < 50) {
                const item = this.groundItems[i].item;
                this.groundItems.splice(i, 1);
                return item;
            }
        }
        return false;
    },

    addTent(worldX, durability = 5) {
        const col = this.getColumnAt(worldX);
        if (!col) return false;
        for (const t of this.tents) {
            if (Math.abs(t.x - worldX) < this.TILE_SIZE * 3) return false;
        }
        const surfaceY = (col.type === 'ice' || col.type === 'water') ? 0 : col.surfaceY;
        this.tents.push({ x: worldX, surfaceY, durability });
        return true;
    },

    removeTentNear(worldX) {
        for (let i = 0; i < this.tents.length; i++) {
            if (Math.abs(this.tents[i].x - worldX) < 50) {
                const dur = this.tents[i].durability !== undefined ? this.tents[i].durability : 5;
                this.tents.splice(i, 1);
                return dur;
            }
        }
        return false;
    },

    isPlayerInTent(playerX) {
        for (const t of this.tents) { if (Math.abs(t.x - playerX) < 30) return true; }
        return false;
    },

    // Render sky, mountains, and surface objects (terrain handled by Voxels)
    render(ctx, camera, canvasW, canvasH, timeOfDay) {
        const baseY = canvasH * 0.6;
        const dayMix = Math.max(0, Math.min(1, Math.sin(timeOfDay * Math.PI)));

        // Sky gradient
        const skyR = Math.round(10 + 174 * dayMix);
        const skyG = Math.round(14 + 198 * dayMix);
        const skyB = Math.round(26 + 206 * dayMix);
        const skyGrad = ctx.createLinearGradient(0, 0, 0, canvasH);
        skyGrad.addColorStop(0, `rgb(${skyR},${skyG},${skyB})`);
        skyGrad.addColorStop(1, `rgb(${Math.round(skyR * 0.7)},${Math.round(skyG * 0.7)},${Math.round(skyB * 0.8)})`);
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, canvasW, canvasH);

        // Mountains
        this.renderMountains(ctx, camera, canvasW, canvasH, baseY, dayMix);
    },

    // Render surface objects on top of voxels
    renderObjects(ctx, camera, canvasW, canvasH) {
        const baseY = canvasH * 0.6;

        // Fishing holes
        for (const hole of this.fishingHoles) {
            const sx = hole.x - camera.x + canvasW / 2;
            if (sx < -50 || sx > canvasW + 50) continue;
            const img = Assets.get('fishing_hole');
            if (img) ctx.drawImage(img, sx - 24, baseY - 12, 48, 24);
            else {
                ctx.fillStyle = '#1a3a5c';
                ctx.beginPath(); ctx.ellipse(sx, baseY, 18, 6, 0, 0, Math.PI * 2); ctx.fill();
                ctx.strokeStyle = '#8ac'; ctx.lineWidth = 2; ctx.stroke();
            }
        }

        // Bridges
        for (const bridge of this.bridges) {
            const bridgePixelWidth = (bridge.endCol - bridge.startCol + 1) * this.TILE_SIZE;
            const bridgeCenterX = ((bridge.startCol + bridge.endCol) / 2) * this.TILE_SIZE;
            const sx = bridgeCenterX - camera.x + canvasW / 2;

            if (sx + bridgePixelWidth / 2 < -80 || sx - bridgePixelWidth / 2 > canvasW + 80) continue;

            const img = Assets.get('simple_bridge');
            if (img) {
                ctx.drawImage(img, sx - bridgePixelWidth / 2, baseY - 12 - bridge.surfaceY, bridgePixelWidth, 24);
            } else {
                ctx.fillStyle = '#6a4a2a';
                ctx.fillRect(sx - bridgePixelWidth / 2, baseY - 6 - bridge.surfaceY, bridgePixelWidth, 12);
            }
        }

        // Shop
        if (this.shop) {
            const sx = this.shop.x - camera.x + canvasW / 2;
            if (sx > -200 && sx < canvasW + 200) {
                const img = Assets.get('shop');
                if (img) {
                    // Draw the shop so it sits on the ground
                    ctx.drawImage(img, sx - 64, baseY - this.shop.surfaceY - 128, 128, 128);
                } else {
                    ctx.fillStyle = '#6e4c30';
                    ctx.fillRect(sx - 60, baseY - this.shop.surfaceY - 100, 120, 100);
                    ctx.fillStyle = '#8f6e4a';
                    ctx.fillRect(sx - 20, baseY - this.shop.surfaceY - 40, 40, 40);
                }
            }
        }

        // Repair Shop
        if (this.repairShop) {
            const sx = this.repairShop.x - camera.x + canvasW / 2;
            if (sx > -200 && sx < canvasW + 200) {
                const img = Assets.get('repair_shop');
                if (img) {
                    // Draw the repair shop so it sits on the ground
                    ctx.drawImage(img, sx - 64, baseY - this.repairShop.surfaceY - 128, 128, 128);
                } else {
                    ctx.fillStyle = '#4a6e30';
                    ctx.fillRect(sx - 60, baseY - this.repairShop.surfaceY - 100, 120, 100);
                    ctx.fillStyle = '#6a8f4a';
                    ctx.fillRect(sx - 20, baseY - this.repairShop.surfaceY - 40, 40, 40);
                }
            }
        }

        // Tents
        for (const tent of this.tents) {
            const sx = tent.x - camera.x + canvasW / 2;
            if (sx < -80 || sx > canvasW + 80) continue;
            this.renderTent(ctx, sx, baseY - tent.surfaceY);
        }

        // Trees
        for (const tree of this.trees) {
            if (!tree.alive) continue;
            const sx = tree.x - camera.x + canvasW / 2;
            if (sx < -60 || sx > canvasW + 60) continue;
            const col = this.columns[tree.groundCol];
            if (!col) continue;
            this.renderTree(ctx, sx, baseY - col.surfaceY, tree.type);
        }

        // Rocks
        for (const rock of this.rocks) {
            if (!rock.alive) continue;
            const sx = rock.x - camera.x + canvasW / 2;
            if (sx < -60 || sx > canvasW + 60) continue;
            const col = this.columns[rock.groundCol];
            if (!col) continue;
            const ry = baseY - col.surfaceY;
            const img = Assets.get('rock');
            if (img) {
                ctx.drawImage(img, sx - 24, ry - 42, 48, 48);
            } else {
                ctx.fillStyle = '#7a7a7a';
                ctx.beginPath();
                ctx.moveTo(sx - 18, ry);
                ctx.lineTo(sx - 12, ry - 28);
                ctx.lineTo(sx + 12, ry - 25);
                ctx.lineTo(sx + 18, ry);
                ctx.closePath();
                ctx.fill();
            }
        }

        // Rock Eggs (small rocks ready to regrow)
        for (const re of this.rockEggs) {
            const sx = re.x - camera.x + canvasW / 2;
            if (sx < -30 || sx > canvasW + 30) continue;
            const col = this.columns[re.groundCol];
            if (!col) continue;
            const ry = baseY - col.surfaceY;
            const img = Assets.get('rock');
            if (img) {
                ctx.globalAlpha = 0.6;
                ctx.drawImage(img, sx - 6, ry - 10, 12, 12);
                ctx.globalAlpha = 1;
            } else {
                ctx.fillStyle = '#999';
                ctx.beginPath();
                ctx.arc(sx, ry - 4, 4, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Tree Eggs (Saplings) - rendered as 1/5th scale trees
        for (const te of this.treeEggs) {
            const sx = te.x - camera.x + canvasW / 2;
            if (sx < -50 || sx > canvasW + 50) continue;
            this.renderTree(ctx, sx, baseY - te.surfaceY, te.type || 0, 0.2);
        }

        // Fish Eggs
        for (const fe of this.fishEggs) {
            const sx = fe.x - camera.x + canvasW / 2;
            if (sx < -50 || sx > canvasW + 50) continue;
            const img = Assets.get('fish_egg');
            // Draw at the bottom of the water column
            if (img) ctx.drawImage(img, sx - 10, baseY - fe.surfaceY + 6 - 20, 20, 20);
        }

        // Campfires
        for (const fire of this.campfires) {
            const sx = fire.x - camera.x + canvasW / 2;
            if (sx < -50 || sx > canvasW + 50) continue;
            this.renderCampfire(ctx, sx, baseY - fire.surfaceY, fire);
        }

        // Ground torches
        for (const torch of this.torches) {
            const sx = torch.x - camera.x + canvasW / 2;
            if (sx < -50 || sx > canvasW + 50) continue;
            this.renderTorch(ctx, sx, baseY - torch.surfaceY, torch);
        }

        // Ground Items
        for (const gItem of this.groundItems) {
            const sx = gItem.x - camera.x + canvasW / 2;
            if (sx < -50 || sx > canvasW + 50) continue;
            Inventory.renderItemIcon(ctx, gItem.item, sx - 12, baseY - gItem.surfaceY - 20, 24);
        }
    },

    renderMountains(ctx, camera, canvasW, canvasH, baseY, dayMix) {
        const farCol = Math.round(40 + 60 * dayMix);
        const farColB = Math.round(50 + 80 * dayMix);
        ctx.fillStyle = `rgb(${farCol},${farCol + 10},${farColB + 30})`;
        ctx.beginPath(); ctx.moveTo(0, canvasH);
        for (let x = 0; x <= canvasW; x += 30) {
            const wx = (x + camera.x * 0.1) / 200;
            ctx.lineTo(x, baseY - Perlin.fbm(wx, 200, 3, 2.0, 0.5) * 120 - 140);
        }
        ctx.lineTo(canvasW, canvasH); ctx.fill();

        const nearCol = Math.round(60 + 80 * dayMix);
        const nearColB = Math.round(70 + 90 * dayMix);
        ctx.fillStyle = `rgb(${nearCol},${nearCol + 5},${nearColB + 20})`;
        ctx.beginPath(); ctx.moveTo(0, canvasH);
        for (let x = 0; x <= canvasW; x += 20) {
            const wx = (x + camera.x * 0.3) / 150;
            ctx.lineTo(x, baseY - Perlin.fbm(wx, 300, 3, 2.0, 0.5) * 80 - 30);
        }
        ctx.lineTo(canvasW, canvasH); ctx.fill();
    },

    renderTree(ctx, x, y, type, scale = 1.0) {
        const img = Assets.get('tree');
        if (img) {
            const s = (1 + type * 0.2) * scale;
            ctx.drawImage(img, x - 24 * s, y - 96 * s + 5, 48 * s, 96 * s);
            return;
        }
        const trunkH = (30 + type * 10) * scale, trunkW = (4 + type) * scale;
        ctx.fillStyle = '#5a3a20';
        ctx.fillRect(x - trunkW / 2, y - trunkH, trunkW, trunkH);
        const layers = 3 + type, maxW = (20 + type * 8) * scale;
        ctx.fillStyle = '#1a4a2a';
        for (let i = 0; i < layers; i++) {
            const ly = y - trunkH - (i * 14 - 5) * scale, lw = maxW - i * 4 * scale;
            ctx.beginPath(); ctx.moveTo(x - lw / 2, ly); ctx.lineTo(x, ly - 20 * scale); ctx.lineTo(x + lw / 2, ly);
            ctx.closePath(); ctx.fill();
        }
        ctx.fillStyle = 'rgba(230,240,250,0.8)';
        for (let i = 0; i < layers; i++) {
            const ly = y - trunkH - (i * 14 - 5) * scale, lw = maxW - i * 4 * scale;
            ctx.beginPath(); ctx.moveTo(x - lw / 2 + 3 * scale, ly); ctx.lineTo(x, ly - 5 * scale); ctx.lineTo(x + lw / 2 - 3 * scale, ly);
            ctx.closePath(); ctx.fill();
        }
    },

    renderTent(ctx, x, y) {
        const w = 50, h = 36;
        ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.beginPath(); ctx.ellipse(x, y, w / 2 + 5, 4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#5a6a4a'; ctx.beginPath(); ctx.moveTo(x - w / 2, y); ctx.lineTo(x, y - h); ctx.lineTo(x + w / 2, y); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#7a8e6a'; ctx.beginPath(); ctx.moveTo(x - w / 2, y); ctx.lineTo(x, y - h); ctx.lineTo(x + 5, y); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#2a3020'; ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x - 1, y - h * 0.6); ctx.lineTo(x + 4, y); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#4a5a3a'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x - w / 2, y); ctx.lineTo(x, y - h); ctx.lineTo(x + w / 2, y); ctx.stroke();
    },

    renderCampfire(ctx, x, y, fire) {
        const img = Assets.get('campfire_anim');

        if (fire.lit) {
            const t = Date.now() / 100, fl = Math.sin(t) * 3;
            const glow = ctx.createRadialGradient(x, y - 15, 5, x, y - 15, 60);
            glow.addColorStop(0, `rgba(255,150,30,${0.4 + fl * 0.05})`);
            glow.addColorStop(1, 'rgba(255,100,0,0)');
            ctx.fillStyle = glow; ctx.fillRect(x - 70, y - 80, 140, 100);

            if (img) {
                // Campfire has 6 frames in a 3x2 grid (3 cols, 2 rows)
                const frameWidth = img.width / 3;
                const frameHeight = img.height / 2;
                const animFrame = Math.floor(Date.now() / 150) % 6;
                const col = animFrame % 3;
                const row = Math.floor(animFrame / 3);
                ctx.drawImage(img, col * frameWidth, row * frameHeight, frameWidth, frameHeight, x - 24, y - 48, 48, 48);
            } else {
                ctx.fillStyle = '#4a2a10'; ctx.fillRect(x - 12, y - 4, 24, 4);
                ctx.fillStyle = '#ff6600'; ctx.beginPath();
                ctx.moveTo(x - 8, y - 5); ctx.quadraticCurveTo(x, y - 30 + fl, x + 8, y - 5); ctx.fill();
            }

            ctx.fillStyle = '#ffdd44';
            for (let i = 0; i < 3; i++) ctx.fillRect(x + Math.sin(t + i * 2) * 6, y - 20 - Math.abs(Math.sin(t * 1.5 + i)) * 15, 2, 2);
        } else {
            // Unlit campfire
            const imgOff = Assets.get('campfire_off');
            if (imgOff) {
                ctx.drawImage(imgOff, x - 24, y - 48, 48, 48);
            } else if (img) {
                // Draw just the first frame of the campfire without animating or glowing
                const frameWidth = img.width / 3;
                const frameHeight = img.height / 2;
                ctx.drawImage(img, 0, 0, frameWidth, frameHeight, x - 24, y - 48, 48, 48);
            } else {
                ctx.fillStyle = '#4a2a10'; ctx.fillRect(x - 12, y - 4, 24, 4); // Just the logs
            }
        }

        // Render fuel/durability bar above campfire
        const pct = fire.fuel / 100;
        const barW = 24;
        const barH = 4;
        const bx = x - barW / 2;
        const by = y - 55; // above campfire

        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(bx, by, barW, barH);

        ctx.fillStyle = pct > 0.5 ? '#ffcc00' : (pct > 0.2 ? '#cc6600' : '#cc3300');
        ctx.fillRect(bx, by, barW * pct, barH);

        ctx.strokeStyle = '#222';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, barW, barH);
    },

    renderTorch(ctx, x, y, torch) {
        if (torch.lit) {
            const t = Date.now() / 100, fl = Math.sin(t + x) * 2;
            // Glow
            const glow = ctx.createRadialGradient(x, y - 20, 3, x, y - 20, 35);
            glow.addColorStop(0, `rgba(255,160,40,${0.3 + fl * 0.03})`);
            glow.addColorStop(1, 'rgba(255,100,0,0)');
            ctx.fillStyle = glow; ctx.fillRect(x - 40, y - 55, 80, 60);
        }

        const img = Assets.get(torch.lit ? 'torch' : 'torch_off');
        if (img) {
            ctx.drawImage(img, x - 12, y - 24, 24, 24);
        } else {
            // Stick
            ctx.fillStyle = '#6a4a2a';
            ctx.fillRect(x - 2, y - 28, 4, 28);

            if (torch.lit) {
                const fl = Math.sin(Date.now() / 100 + x) * 2;
                // Flame
                ctx.fillStyle = '#ff8800';
                ctx.beginPath();
                ctx.moveTo(x - 4, y - 28);
                ctx.quadraticCurveTo(x, y - 42 + fl, x + 4, y - 28);
                ctx.fill();
                ctx.fillStyle = '#ffcc44';
                ctx.beginPath();
                ctx.moveTo(x - 2, y - 28);
                ctx.quadraticCurveTo(x, y - 36 + fl * 0.5, x + 2, y - 28);
                ctx.fill();
            } else {
                // Unlit top for the torch
                ctx.fillStyle = '#3a2a1a';
                ctx.fillRect(x - 3, y - 30, 6, 4);
            }
        }

        // Fuel bar
        const pct = torch.fuel / 100;
        const barW = 18;
        const barH = 3;
        const bx = x - barW / 2;
        const by = y - 48;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(bx, by, barW, barH);
        ctx.fillStyle = pct > 0.5 ? '#ffcc00' : (pct > 0.2 ? '#cc6600' : '#cc3300');
        ctx.fillRect(bx, by, barW * pct, barH);
        ctx.strokeStyle = '#222';
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, barW, barH);
    },

    update(dt) {
        for (let i = this.campfires.length - 1; i >= 0; i--) {
            const f = this.campfires[i];
            if (f.lit) { f.fuel -= dt * 0.8; if (f.fuel <= 0) f.lit = false; }
        }
        for (let i = this.torches.length - 1; i >= 0; i--) {
            const t = this.torches[i];
            if (t.lit) { t.fuel -= dt * 0.8; if (t.fuel <= 0) t.lit = false; }
        }
    }
};
