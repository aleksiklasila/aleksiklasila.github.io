// npcs.js - NPCs (Polar Bear, Zombie) system

const NPCs = {
    // entities is now a tracked collection
    entities: null,
    particles: [],

    init() {
        this.entities = SpatialSyncDB.createCollection('npcs', []);
        this.particles = [];
    },

    update(dt) {
        if (Game.gameOver) return;

        if (Network.isClient) {
            // Client dead reckoning
            for (let i = 0; i < this.entities.length; i++) {
                const npc = this.entities[i];
                if (npc.type === 'zombie_bat') {
                    npc.x += npc.vx * dt;
                    npc.y += (npc.vy || 0) * dt;
                    if (npc.vx !== 0) npc.facing = npc.vx > 0 ? 1 : -1;
                } else if (npc.vx !== 0) {
                    npc.x += npc.vx * dt;
                    npc.y = World.getSurfaceY(npc.x);
                    npc.facing = npc.vx > 0 ? 1 : -1;
                }
            }
            // Particles
            for (let i = this.particles.length - 1; i >= 0; i--) {
                const p = this.particles[i];
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                p.life -= dt;
                if (p.life <= 0) this.particles.splice(i, 1);
            }
            return;
        }

        // Spawn Zombies at night (Host only)
        if (Survival.isNight) {
            // Determine max zombies based on day count
            const maxZombies = Survival.dayCount * 2
            let zombieCount = this.entities.filter(e => e.type === 'zombie').length;

            if (zombieCount < maxZombies && Math.random() < 0.01) {
                this.spawnZombie();
            }
        }

        // Spawn Zombie Bats in dungeons (Host only, any time)
        if (Dungeons.dungeons.length > 0) {
            const maxBats = Dungeons.dungeons.length * (2 + Math.floor(Survival.dayCount / 2));
            const batCount = this.entities.filter(e => e.type === 'zombie_bat').length;
            if (batCount < maxBats && Math.random() < 0.005) {
                this.spawnZombieBat();
            }
        }

        for (let i = this.entities.length - 1; i >= 0; i--) {
            const npc = this.entities[i];

            if (npc.despawn) {
                this.entities.splice(i, 1);
                continue;
            }

            if (npc.hp <= 0) {
                this.handleDeath(npc);
                this.entities.splice(i, 1);
                continue;
            }

            // Sleep Optimization (Host Only)
            let nearestPlayerDist = Infinity;
            for (const pid in SpatialSyncDB.players) {
                const p = SpatialSyncDB.players[pid];
                const d = Math.abs(p.x - npc.x);
                if (d < nearestPlayerDist) nearestPlayerDist = d;
            }
            if (nearestPlayerDist > 2500) {
                // Too far from any player (approx 60 tiles away)
                continue; // Skip AI update
            }

            if (npc.type === 'zombie') {
                // Determine speed (faster each night, even faster on blood moon)
                let baseSpeed = 40 + (Survival.dayCount - 1) * 5;
                const isBloodMoon = Survival.dayCount % 3 === 0;
                if (isBloodMoon) baseSpeed *= 1.5;

                npc.speed = baseSpeed;

                const distToPlayer = Math.abs(npc.x - Player.x);

                let lightDir = 0;
                let nearestLight = null;
                let minLightDist = 300; // Light radius to avoid

                for (const fire of World.campfires) {
                    if (!fire.lit) continue;

                    let avoidThis = !npc.aggro && !isBloodMoon; // Normal behavior

                    // Blue campfire overrides blood moon & aggro
                    if (fire.isBlue && !npc.immuneToBlue) {
                        avoidThis = true;
                    }

                    if (avoidThis && Math.abs(fire.x - npc.x) < minLightDist) {
                        nearestLight = fire;
                        minLightDist = Math.abs(fire.x - npc.x);
                    }
                }

                if (World.torches) {
                    for (const torch of World.torches) {
                        let avoidThis = !npc.aggro && !isBloodMoon;
                        if (torch.lit && avoidThis && Math.abs(torch.x - npc.x) < minLightDist) {
                            nearestLight = torch;
                            minLightDist = Math.abs(torch.x - npc.x);
                        }
                    }
                }

                let avoidThisPlayer = !npc.aggro && !isBloodMoon;
                if (avoidThisPlayer) {
                    const heldItem = Inventory.getSelectedItem();
                    const offHandItem = Inventory.secondHand;
                    const playerHasTorch = (heldItem && heldItem.id === 'torch' && heldItem.lit && heldItem.durability > 0) ||
                        (offHandItem && offHandItem.id === 'torch' && offHandItem.lit && offHandItem.durability > 0);
                    if (playerHasTorch && distToPlayer < minLightDist) {
                        nearestLight = Player;
                        minLightDist = distToPlayer;
                    }
                }

                if (nearestLight) {
                    lightDir = npc.x > nearestLight.x ? 1 : -1;
                }

                let desiredVx = npc.vx;

                if (lightDir !== 0) {
                    // Run away from light
                    desiredVx = npc.speed * lightDir;
                } else if (distToPlayer < 800) { // Chase player if in range
                    desiredVx = npc.x < Player.x ? npc.speed : -npc.speed;
                } else {
                    // Wander
                    npc.wanderTimer -= dt;
                    if (npc.wanderTimer <= 0) {
                        desiredVx = (Math.random() < 0.5 ? -1 : 1) * npc.speed * 0.5;
                        npc.wanderTimer = 2 + Math.random() * 3;
                    }
                }

                npc.directionCooldown = (npc.directionCooldown || 0) - dt;

                // Only allow changing moving direction if cooldown is finished
                if (Math.sign(desiredVx) !== Math.sign(npc.vx) && desiredVx !== 0 && npc.vx !== 0) {
                    if (npc.directionCooldown <= 0) {
                        npc.vx = desiredVx;
                        npc.directionCooldown = 1.0; // 1 second cooldown
                    }
                } else {
                    npc.vx = desiredVx;
                }

                // Despawn if day time
                if (!Survival.isNight) {
                    npc.despawn = true; // Despawn cleanly without dropping loot
                    continue;
                }
            }
            else if (npc.type === 'polar_bear') {
                const distToPlayer = Math.abs(npc.x - Player.x);
                let targetX = null;

                if (!npc.aggro) {
                    // Look for dropped fish
                    let nearestFish = null;
                    let minFishDist = 600;
                    for (const gItem of World.groundItems) {
                        if (gItem.item.id === 'raw_fish' || gItem.item.id === 'cooked_fish' || gItem.item.id === 'raw_fish_large' || gItem.item.id === 'cooked_fish_large') {
                            const d = Math.abs(gItem.x - npc.x);
                            if (d < minFishDist) {
                                minFishDist = d;
                                nearestFish = gItem;
                            }
                        }
                    }

                    if (nearestFish) {
                        targetX = nearestFish.x;
                        if (minFishDist < 30) {
                            // Eat fish
                            World.removeGroundItemNear(nearestFish.x);
                            npc.hp = Math.min(npc.maxHp, npc.hp + 20); // heal
                            npc.wanderTimer = 3; // pause after eating
                            npc.vx = 0;
                            continue;
                        }
                    } else if (distToPlayer < 400 && distToPlayer > 30) {
                        targetX = Player.x;
                    }
                } else {
                    // Aggroed (shot by player)
                    targetX = Player.x;
                }

                let desiredVx = 0;
                if (targetX !== null) {
                    desiredVx = npc.x < targetX ? npc.speed * 1.2 : -npc.speed * 1.2;
                }

                if (desiredVx !== 0) {
                    if (npc.directionCooldown === undefined) npc.directionCooldown = 0;
                    npc.directionCooldown -= dt;

                    if (Math.sign(desiredVx) !== Math.sign(npc.vx) && npc.vx !== 0) {
                        if (npc.directionCooldown <= 0) {
                            npc.vx = desiredVx;
                            npc.directionCooldown = 0.5; // 0.5s turn limit
                        }
                    } else {
                        npc.vx = desiredVx;
                    }
                } else {
                    // Wander
                    npc.wanderTimer -= dt;
                    if (npc.wanderTimer <= 0) {
                        npc.vx = (Math.random() < 0.5 ? -1 : 1) * npc.speed * 0.5;
                        npc.wanderTimer = 3 + Math.random() * 5;
                    }
                }
            }
            else if (npc.type === 'zombie_bat') {
                // Find this bat's dungeon
                const dungeon = Dungeons.dungeons.find(d => d.worldX === npc.dungeonWorldX);
                if (!dungeon) { npc.despawn = true; continue; }

                // Scale speed with day count and blood moon
                let baseSpeed = 70 + (Survival.dayCount - 1) * 8;
                const isBloodMoon = Survival.dayCount % 3 === 0;
                if (isBloodMoon) baseSpeed *= 1.5;
                npc.speed = baseSpeed;

                // World position of a node (same formula as player.js updateDungeonMovement)
                const nodePos = (key) => {
                    const nd = dungeon.nodes[key];
                    if (!nd) return null;
                    return {
                        x: dungeon.worldX + nd.x * Dungeons.ROOM_SIZE + 10,
                        y: dungeon.surfaceY - nd.y * Dungeons.ROOM_SIZE - 20
                    };
                };

                // Player is "visible" if they are in this same dungeon
                const playerInDungeon = Player.dungeonState &&
                    Player.dungeonState.inDungeon &&
                    Player.dungeonState.dungeon &&
                    Player.dungeonState.dungeon.worldX === npc.dungeonWorldX;

                // Blue campfire avoidance: check if any blue campfire is near bat's current node
                let fleeTarget = null;
                for (const fire of World.campfires) {
                    if (!fire.lit || !fire.isBlue) continue;
                    if (Math.abs(fire.x - npc.x) < 280) { fleeTarget = fire; break; }
                }

                // --- Node arrival: pick next target when bat reaches its target node ---
                const tpos = nodePos(npc.targetNodeKey);
                if (!tpos) {
                    // Invalid target — snap to a valid node
                    const fallbackKeys = Object.keys(dungeon.nodes);
                    if (fallbackKeys.length > 0) {
                        npc.currentNodeKey = fallbackKeys[0];
                        npc.targetNodeKey = fallbackKeys[0];
                        const fp = nodePos(npc.currentNodeKey);
                        if (fp) { npc.x = fp.x; npc.y = fp.y; }
                    }
                } else {
                    const tdx = tpos.x - npc.x;
                    const tdy = tpos.y - npc.y;
                    const tdist = Math.sqrt(tdx * tdx + tdy * tdy);

                    if (tdist < 18) {
                        // Arrived — advance current node and pick the next one
                        npc.currentNodeKey = npc.targetNodeKey;
                        const node = dungeon.nodes[npc.currentNodeKey];

                        if (node && node.connections.length > 0) {
                            if (fleeTarget) {
                                // Flee: pick neighbor furthest from the campfire
                                let bestKey = node.connections[0];
                                let bestDist = -1;
                                for (const cKey of node.connections) {
                                    const cp = nodePos(cKey);
                                    if (cp) {
                                        const d = Math.abs(cp.x - fleeTarget.x);
                                        if (d > bestDist) { bestDist = d; bestKey = cKey; }
                                    }
                                }
                                npc.targetNodeKey = bestKey;
                            } else if (playerInDungeon) {
                                // Chase: pick neighbor whose world pos is closest to player
                                // (greedy graph walk — never passes through walls)
                                let bestKey = node.connections[0];
                                let bestDist = Infinity;
                                for (const cKey of node.connections) {
                                    const cp = nodePos(cKey);
                                    if (cp) {
                                        const d = (cp.x - Player.x) ** 2 + (cp.y - Player.y) ** 2;
                                        if (d < bestDist) { bestDist = d; bestKey = cKey; }
                                    }
                                }
                                npc.targetNodeKey = bestKey;
                            } else {
                                // Wander: random neighbor, avoid reversing unless dead end
                                const forward = node.connections.filter(k => k !== npc.prevNodeKey);
                                const pool = forward.length > 0 ? forward : node.connections;
                                npc.prevNodeKey = npc.currentNodeKey;
                                npc.targetNodeKey = pool[Math.floor(Math.random() * pool.length)];
                            }
                        }
                        npc.vx = 0; npc.vy = 0;
                    } else {
                        // Still travelling toward target node
                        npc.vx = (tdx / tdist) * npc.speed;
                        npc.vy = (tdy / tdist) * npc.speed;
                    }
                }

                // Apply 2D movement along node edge
                npc.x += npc.vx * dt;
                npc.y += npc.vy * dt;
                if (npc.vx !== 0) npc.facing = npc.vx > 0 ? 1 : -1;
                npc.x = Math.max(40, Math.min((World.WORLD_WIDTH - 1) * World.TILE_SIZE, npc.x));

                // Attack player when on the same node or very close
                if (!Player.isDead) {
                    const adx = npc.x - Player.x;
                    const ady = npc.y - Player.y;
                    const distToPlayer = Math.sqrt(adx * adx + ady * ady);
                    if (distToPlayer < 35) {
                        npc.attackTimer -= dt;
                        if (npc.attackTimer <= 0) {
                            const bm = Survival.dayCount % 3 === 0;
                            Player.stats.sleep = Math.max(0, Player.stats.sleep - (bm ? 12 : 8));
                            Player.stats.warmth = Math.max(0, Player.stats.warmth - 3);
                            npc.attackTimer = 0.4;
                        }
                    }
                }

                continue; // Skip standard ground-based movement + attack
            }

            // Apply movement
            if (npc.vx !== 0) npc.facing = npc.vx > 0 ? 1 : -1;

            const nextX = npc.x + npc.vx * dt;
            const newCol = World.getColumnAt(nextX);

            // Basic collision with water and gates
            if ((newCol && newCol.type === 'water' && !World.isBridgeAt(nextX)) || World.isGateAt(nextX)) {
                npc.vx = 0;
                // If it's a gate and we are chasing player, attack gate
                const gate = World.getGateNear(nextX);
                if (gate && !gate.open) {
                    npc.attackTimer -= dt;
                    if (npc.attackTimer <= 0) {
                        gate.durability -= (npc.type === 'polar_bear' ? 10 : 5);
                        Game.showMessage('A gate is being attacked!', 1.5);
                        if (gate.durability <= 0) {
                            gate.durability = 0;
                            gate.open = true;
                            Game.showMessage('A gate was broken!', 2);
                        }
                        npc.attackTimer = 1.0;
                    }
                }
            } else {
                npc.x = nextX;
            }

            // Clamp to world
            npc.x = Math.max(40, Math.min((World.WORLD_WIDTH - 1) * World.TILE_SIZE, npc.x));
            npc.y = World.getSurfaceY(npc.x);

            // Attack player
            if (Player.isDead) continue;
            const pDist = Math.abs(npc.x - Player.x);
            if (pDist < 40) {
                npc.vx = 0;
                npc.attackTimer -= dt;
                if (npc.attackTimer <= 0) {
                    // Deal damage
                    const isBloodMoon = npc.type === 'zombie' && Survival.dayCount % 3 === 0;

                    if (npc.type === 'zombie') {
                        Player.stats.sleep = Math.max(0, Player.stats.sleep - (isBloodMoon ? 15 : 10));
                        Player.stats.warmth = Math.max(0, Player.stats.warmth - 5);
                    } else if (npc.type === 'polar_bear') {
                        Player.stats.warmth = Math.max(0, Player.stats.warmth - 20);
                        // Maybe damage clothes?
                        if (Inventory.clothing && Inventory.clothing.durability > 0) {
                            Inventory.clothing.durability -= 5;
                            if (Inventory.clothing.durability <= 0) {
                                Inventory.clothing = null;
                                Game.showMessage('Your clothing was destroyed!', 2);
                            }
                        }
                    }
                    npc.attackTimer = 0.5; // Attack every 1 second
                }
            }
        }

        // Update particles
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.life -= dt;
            if (p.life <= 0) this.particles.splice(i, 1);
        }
    },

    spawnZombie() {
        // Spawn off-screen
        const side = Math.random() < 0.5 ? 1 : -1;
        const x = Math.max(40, Math.min((World.WORLD_WIDTH - 1) * World.TILE_SIZE, Player.x + side * (Game.width / 2 + 100 + Math.random() * 200)));
        this.entities.push({
            type: 'zombie',
            x: x,
            y: World.getSurfaceY(x),
            vx: 0,
            vy: 0,
            speed: 40,
            hp: 80, // Heavy
            maxHp: 80,
            facing: 1,
            wanderTimer: 0,
            attackTimer: 0,
            immuneToBlue: Math.random() < 0.10 + 0.01 * Survival.dayCount, // 10% chance to ignore blue campfire, increase by 1% every day
            aggro: false
        });
    },

    spawnPolarBear() {
        // Spawn off-screen far away
        const side = Math.random() < 0.5 ? 1 : -1;
        const x = Math.max(40, Math.min((World.WORLD_WIDTH - 1) * World.TILE_SIZE, Player.x + side * (Game.width + 500 + Math.random() * 500)));
        this.entities.push({
            type: 'polar_bear',
            x: x,
            y: World.getSurfaceY(x),
            vx: 0,
            vy: 0,
            speed: 110, // Slightly faster than player with slope penalties
            hp: 80, // Heavy
            maxHp: 80,
            facing: 1,
            wanderTimer: 0,
            attackTimer: 0,
            directionCooldown: 0,
            aggro: false
        });
    },

    spawnZombieBat() {
        if (Dungeons.dungeons.length === 0) return;
        const dungeon = Dungeons.dungeons[Math.floor(Math.random() * Dungeons.dungeons.length)];
        const nodeKeys = Object.keys(dungeon.nodes).filter(k => dungeon.nodes[k].y > 0);
        if (nodeKeys.length === 0) return;

        const startKey = nodeKeys[Math.floor(Math.random() * nodeKeys.length)];
        const node = dungeon.nodes[startKey];

        // Pick a random connected neighbor as initial target so the bat is moving immediately
        const connections = node.connections;
        const targetKey = connections.length > 0
            ? connections[Math.floor(Math.random() * connections.length)]
            : startKey;

        const worldX = dungeon.worldX + node.x * Dungeons.ROOM_SIZE + 10;
        const worldY = dungeon.surfaceY - node.y * Dungeons.ROOM_SIZE - 20;

        const hp = 30 + Survival.dayCount * 5;
        this.entities.push({
            type: 'zombie_bat',
            x: worldX,
            y: worldY,
            vx: 0,
            vy: 0,
            speed: 70,
            hp: hp,
            maxHp: hp,
            facing: 1,
            attackTimer: 0,
            dungeonWorldX: dungeon.worldX,
            currentNodeKey: startKey,
            targetNodeKey: targetKey,
            prevNodeKey: null,
        });
    },

    handleDeath(npc) {
        if (npc.type === 'zombie') {
            // Drop at most 1 item, mostly nothing
            if (Math.random() < 0.3) { // 30% chance to drop anything
                const r = Math.random();
                let dropId;
                let count = 1;

                if (r < 0.4) dropId = 'firewood';
                else if (r < 0.8) dropId = 'rock';
                else if (r < 0.9) { dropId = 'money'; count = Math.floor(Math.random() * 10) + 1; }
                else if (r < 0.95) dropId = 'bait';
                else dropId = 'raw_fish';

                const def = Inventory.ITEMS[dropId];
                if (def) World.addGroundItem(npc.x, { ...def, count, durability: def.maxDurability });
            }
        } else if (npc.type === 'zombie_bat') {
            // Small chance to drop bait or money
            if (Math.random() < 0.25) {
                const r = Math.random();
                let dropId = r < 0.6 ? 'bait' : 'money';
                const count = dropId === 'money' ? Math.floor(Math.random() * 5) + 1 : 1;
                const def = Inventory.ITEMS[dropId];
                if (def) World.addGroundItem(npc.x, { ...def, count, durability: def.maxDurability });
            }
        } else if (npc.type === 'polar_bear') {
            // Drop hide on the ground
            const dropDef = Inventory.ITEMS['hide'];
            World.addGroundItem(npc.x, { ...dropDef, count: 1, durability: dropDef.maxDurability });

            // Drop a polar bear egg at a random location
            const randomX = Math.max(0, Math.min((World.WORLD_WIDTH - 1) * World.TILE_SIZE, Math.random() * World.WORLD_WIDTH * World.TILE_SIZE));
            World.polarBearEggs.push({
                x: randomX,
                surfaceY: World.getSurfaceY(randomX),
            });
        }
    },

    damageInLine(x, dist, direction, damage) {
        // Find closest entity in line (ignoring verticality for ease of use)
        let closestDist = Infinity;
        let closestNpc = null;

        for (const npc of this.entities) {
            if ((direction > 0 && npc.x > x && npc.x < x + dist) ||
                (direction < 0 && npc.x < x && npc.x > x - dist)) {

                const distanceX = Math.abs(npc.x - x);
                if (distanceX < closestDist) {
                    closestDist = distanceX;
                    closestNpc = npc;
                }
            }
        }

        if (closestNpc) {
            // Damage scales from 1x at point blank to 0.2x at max distance
            const multiplier = Math.max(0.2, 1 - (closestDist / dist));
            closestNpc.hp -= damage * multiplier;
            closestNpc.aggro = true; // Agros if hit

            // Push back slightly
            closestNpc.x += direction * 20;
        }
    },

    spawnPellet(x, y, dir, maxDist) {
        this.particles.push({
            type: 'pellet',
            x: x,
            y: y,
            vx: dir * (800 + Math.random() * 400),
            vy: (Math.random() - 0.5) * 50,
            life: 0.2 + Math.random() * 0.1,
            maxLife: 0.3
        });
    },

    spawnShotgunEffects(x, y, dir) {
        const muzzleX = x + dir * 20;

        // Small muzzle flash dot
        this.particles.push({
            type: 'flash',
            x: muzzleX,
            y: y,
            vx: 0,
            vy: 0,
            life: 0.07,
            maxLife: 0.07,
        });

        // Bullet tracers — 5 fast bright streaks with slight spread
        for (let i = 0; i < 5; i++) {
            this.particles.push({
                type: 'pellet',
                x: muzzleX,
                y: y + (Math.random() - 0.5) * 6,
                vx: dir * (800 + Math.random() * 400),
                vy: (Math.random() - 0.5) * 80,
                life: 0.12 + Math.random() * 0.08,
                maxLife: 0.2,
            });
        }

        // A couple of smoke puffs
        for (let i = 0; i < 3; i++) {
            this.particles.push({
                type: 'smoke',
                x: muzzleX + dir * Math.random() * 15,
                y: y + (Math.random() - 0.5) * 8,
                vx: dir * (15 + Math.random() * 30),
                vy: 25 + Math.random() * 35,
                life: 0.35 + Math.random() * 0.3,
                maxLife: 0.65,
            });
        }
    },

    render(ctx, camera, canvasW, canvasH) {
        const baseY = canvasH * 0.6;
        for (const npc of this.entities) {
            const sx = npc.x - camera.x + canvasW / 2;
            const sy = baseY - npc.y + camera.y;

            if (sx < -100 || sx > canvasW + 100) continue;

            ctx.save();
            ctx.translate(sx, sy);
            ctx.scale(npc.facing, 1);

            const isMoving = npc.vx !== 0 || (npc.vy || 0) !== 0;
            const bobY = isMoving ? Math.sin(Date.now() / 150) * 3 : 0;

            if (npc.type === 'zombie') {
                const img = Assets.get('zombie');
                if (img) {
                    const frameWidth = img.width / 3;
                    const frameHeight = img.height / 2;
                    const animFrame = isMoving ? Math.floor(Date.now() / 150) % 6 : 0;
                    const col = animFrame % 3;
                    const row = Math.floor(animFrame / 3);
                    ctx.drawImage(img, col * frameWidth, row * frameHeight, frameWidth, frameHeight, -20, -56 - bobY, 40, 56);
                }
            } else if (npc.type === 'zombie_bat') {
                const img = Assets.get('zombie_bat');
                if (img) {
                    const frameWidth = img.width / 3;
                    const frameHeight = img.height / 2;
                    const animFrame = Math.floor(Date.now() / 120) % 6; // Always animate (bats flap wings)
                    const col = animFrame % 3;
                    const row = Math.floor(animFrame / 3);
                    ctx.drawImage(img, col * frameWidth, row * frameHeight, frameWidth, frameHeight, -16, -28 - bobY, 32, 28);
                } else {
                    // Fallback if asset not loaded
                    ctx.fillStyle = '#553366';
                    ctx.fillRect(-12, -20 - bobY, 24, 20);
                }
            } else if (npc.type === 'polar_bear') {
                const img = Assets.get('polar_bear');
                if (img) {
                    const frameWidth = img.width / 3;
                    const frameHeight = img.height / 2;
                    const animFrame = isMoving ? Math.floor(Date.now() / 150) % 6 : 0;
                    const col = animFrame % 3;
                    const row = Math.floor(animFrame / 3);
                    ctx.drawImage(img, col * frameWidth, row * frameHeight, frameWidth, frameHeight, -40, -60 - bobY, 80, 60);
                }
            }

            // Render health bar
            if (npc.hp < npc.maxHp) {
                const hWidth = npc.type === 'zombie_bat' ? 30 : 40;
                const hHeight = 4;
                const hy = npc.type === 'polar_bear' ? -75 : npc.type === 'zombie_bat' ? -38 : -70;
                ctx.fillStyle = 'black';
                ctx.fillRect(-hWidth / 2 - 1, hy - bobY - 1, hWidth + 2, hHeight + 2);
                ctx.fillStyle = npc.type === 'zombie_bat' ? '#aa44ff' : 'red';
                ctx.fillRect(-hWidth / 2, hy - bobY, hWidth * Math.max(0, npc.hp / npc.maxHp), hHeight);
            }

            ctx.restore();
        }

        // Render particles
        for (const p of this.particles) {
            const px = p.x - camera.x + canvasW / 2;
            const py = baseY - p.y + camera.y;

            if (p.type === 'flash') {
                const t = p.life / p.maxLife;
                ctx.globalAlpha = t;
                ctx.fillStyle = '#ffffa0';
                ctx.beginPath();
                ctx.arc(px, py, 6, 0, Math.PI * 2);
                ctx.fill();
            } else if (p.type === 'smoke') {
                const t = p.life / p.maxLife;
                ctx.globalAlpha = t * 0.38;
                const size = 3 + (1 - t) * 16;
                ctx.fillStyle = '#bbbbbb';
                ctx.beginPath();
                ctx.arc(px, py, size, 0, Math.PI * 2);
                ctx.fill();
            } else {
                // Pellet / default
                if (px < -10 || px > canvasW + 10) continue;
                ctx.globalAlpha = p.life / (p.maxLife || 0.3);
                ctx.fillStyle = '#ffe844';
                ctx.fillRect(px - 1, py - 1, 6, 3);
            }
        }
        ctx.globalAlpha = 1;
    }
};
