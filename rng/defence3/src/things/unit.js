"use strict";

// ============================================================
// UNIT CLASS
// ============================================================
const CMD_IDLE = 0, CMD_MOVING = 1, CMD_ATTACK_MOVING = 2, CMD_ATTACKING = 3, CMD_HOLDING = 4;

class Unit {
    constructor(unitType, owner, x, y) {
        this.id = nextUnitId++;
        this.unitType = unitType;
        this.owner = owner;
        this.x = x; this.y = y;
        this.prevX = x; this.prevY = y;
        this.teleportHideTicks = 0;

        let s = BASE_UNIT_STATS[unitType] || BASE_UNIT_STATS.norm;
        this.energy = s.energy; this.maxEnergy = s.energy;
        this.speed = s.speed;
        this.attackDamage = s.atk;
        this.attackRangeArea = Math.max(0, Number(s.attackRange) || 0);
        this.attackRange = this.attackRangeArea * AREA_UNIT_TILE_EQUIVALENT * TILE;
        this.visionRangeArea = Math.max(0, Number(s.visionRange) || 0);
        this.visionRange = (this.visionRangeArea || 0.8) * AREA_UNIT_TILE_EQUIVALENT;
        this.attackCooldown = secondsToTicks(s.atkCd);
        this.attackTimer = 0;
        this.color = s.color; this.r = s.r;
        this.collisionR = Number.isFinite(s.collisionR) ? s.collisionR : this.r;
        this.vis = s.vis || 'circle';
        this.isFlying = s.isFlying || false;
        this.turretImmune = s.turretImmune || false;
        this.isSnake = s.isSnake || false;
        this.snakeMaxHistory = s.snakeMaxHistory || 0;
        this.poisonResistant = s.poisonResistant || false;
        this.fireResistant = s.fireResistant || false;
        this.waterResistant = s.waterResistant || false;
        this.iceResistant = s.iceResistant || false;
        this.laserResistant = s.laserResistant || false;
        this.sandResistant = s.sandResistant || false;
        this.attackStyle = s.attackStyle || 'melee';
        this.isKing = (unitType === 'king');
        this.attackTarget = null; // visual: current attack target for draw effects
        this.attackFlash = 0; // visual: flash timer for attack animation

        this.commandState = CMD_IDLE;
        this.targetUnit = null;
        this.targetBuilding = null;
        this.targetPos = null;
        this.path = null;
        this.pathIndex = 0;
        this.forcedAttackTarget = false;
        this._forcedTargetLastSeenX = null;
        this._forcedTargetLastSeenY = null;
        this.dead = false;
        this.unitLevel = 1;
        this.stackCount = 1;
        this.effectiveStacks = 1;
        this.effectiveLevel = 1;

        this.baseEnergy = this.maxEnergy;
        this.baseAttackDamage = this.attackDamage;
        this.baseSpeed = this.speed;
        this.baseAttackCooldown = this.attackCooldown;
        this.baseVisionRangeArea = this.visionRangeArea;
        this.baseVisionRange = this.visionRange;
        this.baseAttackRangeArea = this.attackRangeArea;
        this.baseAttackRange = this.attackRange / TILE;

        this.baseLevel = 1;
        this.baseLevelmaxEnergy = this.maxEnergy;
        this.baseLevelAttackDamage = this.attackDamage;
        this.baseLevelAttackCooldown = this.attackCooldown;
        this.baseLevelSpeed = this.speed;
        this.baseLevelVisionRangeArea = this.visionRangeArea;
        this.baseLevelVisionRange = this.visionRange;
        this.baseLevelAttackRangeArea = this.attackRangeArea;
        this.baseLevelGatherPerTrip = 0;
        this.baseLevelBuilderDps = 0;
        this.baseLevelhealerDps = 0;

        // Status effects
        this.poisoned = 0; this.poisonTickDamage = 0;
        this.burning = 0; this.burnTickDamage = 0;
        this.frozen = 0; this.iceTickDamage = 0;
        this.wet = 0; this.sandy = 0; this.watched = 0;
        this.vx = 0; this.vy = 0;
        this.workerTransferCooldown = 0;

        // Snake
        if (this.isSnake) { this.snakeHistory = []; this.snakeRecordTimer = 0; }

        this._spatialKey = undefined;
        updateUnitSpatial(this);
    }

    getCollisionLayer() {
        if (this.isFlying) return 'air';
        if (this.unitType === 'mole') return 'mole';
        return 'ground';
    }

    getCollisionRadius() {
        return Math.max(0.1, Number(this.collisionR) || Number(this.r) || 0.1);
    }

    pickScoutDestination() {
        if (Number.isFinite(this._nextScoutRetargetTick) && gameTime < this._nextScoutRetargetTick) return;
        let ugx = Math.floor(this.x / TILE), ugy = Math.floor(this.y / TILE);
        let rgx = Math.floor((typeof rng === 'function' ? rng() : Math.random()) * GRID_W);
        let rgy = Math.floor((typeof rng === 'function' ? rng() : Math.random()) * GRID_H);
        rgx = Math.max(0, Math.min(GRID_W - 1, rgx));
        rgy = Math.max(0, Math.min(GRID_H - 1, rgy));
        this._scoutTarget = { gx: rgx, gy: rgy };
        if (_canUsePathfindRequestBudget(this.owner)) {
            _consumePathfindRequestBudget(this.owner);
            this.path = _findPathForUnitTagged('scout_ai', this, ugx, ugy, rgx, rgy, true, null, this.owner);
            this.pathIndex = (this.path && this.path.length > 1 && this.path[0].x === ugx && this.path[0].y === ugy) ? 1 : 0;
        } else {
            this.path = _makeFallbackPathForUnit(this, ugx, ugy, rgx, rgy, CMD_MOVING, 'scout_ai');
            this.pathIndex = (this.path && this.path.length > 1 && this.path[0].x === ugx && this.path[0].y === ugy) ? 1 : 0;
        }
        this._nextScoutRetargetTick = gameTime + Math.max(8, Math.floor(TICK_RATE * 0.5));
        this.commandState = CMD_MOVING;
    }

    update() {
        if (this.dead) return;

        if (this.teleportHideTicks > 0) this.teleportHideTicks--;

        // Status effects tick
        if (this.burning > 0) {
            this.burning--;
            if (this.burnTickDamage > 0) {
                this.energy -= this.burnTickDamage;
                recordDamageVisual(this, this.burnTickDamage);
            }
        }
        if (this.poisoned > 0) {
            this.poisoned--;
            if (this.poisonTickDamage > 0) {
                this.energy -= this.poisonTickDamage;
                recordDamageVisual(this, this.poisonTickDamage);
            }
        }
        if (this.frozen > 0 && this.wet > 0 && this.iceTickDamage > 0) {
            this.energy -= this.iceTickDamage * 1.5;
            recordDamageVisual(this, this.iceTickDamage * 1.5);
        }
        if (this.frozen > 0) this.frozen--;
        if (this.wet > 0) this.wet--;
        if (this.sandy > 0) this.sandy--;
        if (this.watched > 0) this.watched--;

        if (this.energy <= 0) { this.dead = true; return; }

        // Floor item interaction
        let gx = Math.floor(this.x / TILE), gy = Math.floor(this.y / TILE);
        if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H) {
            let cell = grid[gy][gx];
            if (cell.item && cell.owner !== this.owner && !cell.item.underConstruction) {
                let item = cell.item;
                let itemLevel = getThingEffectiveLevel(item, stackCountToLevel(item.stacks || 1));
                if (item.type === 'sand') {
                    applyStatusEffect(this, 'sand', itemLevel, 0, item.owner, item.type);
                }
                else if (item.type === 'lava') {
                    applyStatusEffect(this, 'fire', itemLevel, item.damage || 1, item.owner, item.type);
                }
                else if (item.type === 'poison_puddle') {
                    applyStatusEffect(this, 'poison', itemLevel, item.damage || 1, item.owner, item.type);
                }
                else if (item.type === 'ice_patch') {
                    applyStatusEffect(this, 'ice', itemLevel, item.damage || 1, item.owner, item.type);
                }
                else if (item.type === 'water_puddle') {
                    applyStatusEffect(this, 'water', itemLevel, 0, item.owner, item.type);
                }
                else if (item.type === 'mine') {
                    let blastDamage = getBuildingStatForOwner(item.owner, 'mine', itemLevel, 'blastDamage');
                    if (!Number.isFinite(blastDamage) || blastDamage <= 0) blastDamage = Number(item.damage) || 135;
                    let blastRadiusArea = getBuildingStatForOwner(item.owner, 'mine', itemLevel, 'blastRadius');
                    if (!Number.isFinite(blastRadiusArea) || blastRadiusArea <= 0) blastRadiusArea = 0.24;
                    let blastRadiusPx = Math.max(0, Number(blastRadiusArea) * AREA_UNIT_TILE_EQUIVALENT * TILE);

                    forEachUnitInRange(this.x, this.y, blastRadiusPx, (u) => {
                        if (!u) return;
                        let prevEnergy = u.energy;
                        u.energy -= blastDamage;
                        pushHostileDamageAlert(u, prevEnergy - u.energy, item.owner);
                        recordDamageVisual(u, prevEnergy - u.energy, item.owner);
                        if (u.energy <= 0 && !u.dead) u.dead = true;
                    }, { enemyOfPlayer: item.owner });

                    createExplosion(this.x, this.y, "#f80", 15);
                    playSound('mine_explode', this.x, this.y);
                    clearTileEntity(cell.item.gx, cell.item.gy, cell.item);
                    cell.item = null;
                    if (this.energy <= 0) this.dead = true;
                    return;
                }
            }
        }

        // Speed modifier
        let spd = this.speed;
        if (this.frozen > 0) spd *= 0.5;
        if (this.sandy > 0) spd *= 0.5;
        spd *= _getUnitAstarSpeedMultiplier(this);

        // Snake history
        if (this.isSnake) {
            this.snakeRecordTimer++;
            if (this.snakeRecordTimer >= 3) {
                this.snakeRecordTimer = 0;
                this.snakeHistory.unshift({ x: this.x, y: this.y });
                if (this.snakeHistory.length > this.snakeMaxHistory) this.snakeHistory.pop();
            }
        }

        // Attack timer
        if (this.attackTimer > 0) this.attackTimer--;
        if (this.attackFlash > 0) this.attackFlash--;

        // Worker AI (collector/salvager units)
        if (this.workerState) {
            updateWorkerAI(this);
            // Workers still follow paths via the normal system
        }

        // State machine
        switch (this.commandState) {
            case CMD_IDLE: if (!this.workerState) this.doIdle(spd); break;
            case CMD_MOVING: this.doMoving(spd); break;
            case CMD_ATTACK_MOVING: this.doAttackMoving(spd); break;
            case CMD_ATTACKING: this.doAttacking(spd); break;
            case CMD_HOLDING: this.doHolding(); break;
        }
        // Separation from nearby units (staggered to reduce per-tick cost spikes).
        let collisionInterval = getUnitCollisionRecalcTicks();
        let hadUnitCollision = false;
        if (collisionInterval <= 1 || ((gameTime + this.id) % collisionInterval) === 0) {
            let selfCollisionR = this.getCollisionRadius();
            let sepRange = selfCollisionR * 2;
            let pushX = 0, pushY = 0;
            let myLayer = this.getCollisionLayer();
            forEachUnitInRange(this.x, this.y, sepRange, (other, d2, dx, dy) => {
                if (other === this || other.dead) return;
                if (other.getCollisionLayer() !== myLayer) return;
                dx = -dx; dy = -dy;
                let d = Math.sqrt(Math.max(0, d2));
                let minDist = selfCollisionR + other.getCollisionRadius();
                if (d < minDist) {
                    hadUnitCollision = true;
                    let nx = 0, ny = 0;
                    if (d > 0.001) {
                        nx = dx / d;
                        ny = dy / d;
                    } else {
                        // Exact overlap fallback: use current movement direction (no random/id jitter).
                        let mdx = this.vx, mdy = this.vy;
                        if (Math.hypot(mdx, mdy) < 0.001 && this.path && this.pathIndex < this.path.length) {
                            let pn = this.path[this.pathIndex];
                            mdx = pn.x * TILE + 16 - this.x;
                            mdy = pn.y * TILE + 16 - this.y;
                        }
                        if (Math.abs(mdx) >= Math.abs(mdy)) {
                            nx = mdx >= 0 ? 0 : 0;
                            ny = mdx >= 0 ? -1 : 1;
                        } else {
                            nx = mdy >= 0 ? 1 : -1;
                            ny = 0;
                        }
                    }
                    let force = (minDist - Math.max(d, 0.001)) * 0.3;
                    pushX += nx * force;
                    pushY += ny * force;
                }
            });
            if (pushX !== 0 || pushY !== 0) {
                this.x += pushX; this.y += pushY;
                // Clamp to walkable area
                let ngx = Math.floor(this.x / TILE), ngy = Math.floor(this.y / TILE);
                if (!this.isFlying && !canUnitOccupyTile(this, ngx, ngy)) {
                    this.x -= pushX; this.y -= pushY;
                    hadUnitCollision = true;
                }
            }
        }
        if (hadUnitCollision && this.pathIsFallbackAstar && this._pendingPathTarget) {
            _tryUpgradeAstarFallbackPath(this);
        }
        pushUnitOutOfBlockedTile(this);
        updateUnitSpatial(this);
    }

    doIdle(spd) {
        if (this.unitType === 'scout') {
            this.pickScoutDestination();
            return;
        }
        // Auto-aggro nearby enemies
        let aggroRange = Math.max(TILE, this.visionRange * TILE);
        let closest = _findClosestEnemyUnitByChunks(this.owner, this.x, this.y, aggroRange);
        if (closest) {
            this.targetUnit = closest;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
            return;
        }
        // Priority for structures: towers -> barracks/spawners -> floor items.
        let closestTower = null, closestTowerD = aggroRange;
        for (let t of towers) {
            if (t.owner === this.owner || t.energy <= 0) continue;
            let d = Math.hypot(t.x - this.x, t.y - this.y);
            if (d < closestTowerD) { closestTowerD = d; closestTower = t; }
        }
        if (closestTower) {
            this.targetBuilding = closestTower;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
            return;
        }

        let closestStruct = null, closestStructD = aggroRange;
        let scanStructList = (list) => {
            for (let b of list) {
                if (b.owner === this.owner || b.energy <= 0) continue;
                let d = Math.hypot(b.x - this.x, b.y - this.y);
                if (d < closestStructD) { closestStructD = d; closestStruct = b; }
            }
        };
        scanStructList(barracks);
        scanStructList(collectorSpawners);
        if (closestStruct) {
            this.targetBuilding = closestStruct;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
            return;
        }

        let rTiles = Math.ceil(aggroRange / TILE) + 1;
        let ugx = Math.floor(this.x / TILE), ugy = Math.floor(this.y / TILE);
        let minGx = Math.max(0, ugx - rTiles), maxGx = Math.min(GRID_W - 1, ugx + rTiles);
        let minGy = Math.max(0, ugy - rTiles), maxGy = Math.min(GRID_H - 1, ugy + rTiles);
        let closestItem = null, closestItemD = aggroRange;
        for (let gy = minGy; gy <= maxGy; gy++) {
            for (let gx = minGx; gx <= maxGx; gx++) {
                let cell = grid[gy][gx];
                if (!cell || !cell.item || cell.owner === this.owner) continue;
                let item = cell.item;
                if (item.energy <= 0 || item.underConstruction) continue;
                let d = Math.hypot(item.x - this.x, item.y - this.y);
                if (d < closestItemD) { closestItemD = d; closestItem = item; }
            }
        }
        if (closestItem) {
            this.targetBuilding = closestItem;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
        }
    }

    doMoving(spd) {
        if (this.unitType === 'scout') {
            if (this.path && this.pathIndex < this.path.length) {
                if (this.followPath(spd)) {
                    this.path = null;
                    this.commandState = CMD_IDLE;
                }
            } else if (this._scoutTarget) {
                let tx = this._scoutTarget.gx * TILE + 16;
                let ty = this._scoutTarget.gy * TILE + 16;
                let dx = tx - this.x, dy = ty - this.y;
                let dist = Math.hypot(dx, dy) || 1;
                if (dist <= Math.max(4, spd)) {
                    this.commandState = CMD_IDLE;
                } else {
                    this.x += (dx / dist) * spd;
                    this.y += (dy / dist) * spd;
                }
            } else {
                this.commandState = CMD_IDLE;
            }
            return;
        }
        if ((!this.path || this.pathIndex >= this.path.length) && this._pendingPathTarget && this._pendingPathTarget.cmd === CMD_MOVING) {
            if (this.pathIsFallbackAstar) _tryUpgradeAstarFallbackPath(this);
            // Keep move command active while waiting for deferred pathfinding.
            return;
        }
        if (this.followPath(spd)) {
            if (this._pendingPathTarget && this._pendingPathTarget.cmd === CMD_MOVING) {
                this.path = null;
                return;
            }
            this.commandState = CMD_IDLE;
            this.path = null;
        }
    }

    doAttackMoving(spd) {
        // Check for nearby enemies first
        let aggroRange = Math.max(TILE, this.visionRange * TILE);
        let closest = _findClosestEnemyUnitByChunks(this.owner, this.x, this.y, aggroRange);
        if (closest) {
            this.targetUnit = closest;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
            return;
        }
        let closestTower = null, closestTowerD = aggroRange;
        for (let t of towers) {
            if (t.owner === this.owner || t.energy <= 0) continue;
            let d = Math.hypot(t.x - this.x, t.y - this.y);
            if (d < closestTowerD) { closestTowerD = d; closestTower = t; }
        }
        if (closestTower) {
            this.targetBuilding = closestTower;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
            return;
        }

        let closestStruct = null, closestStructD = aggroRange;
        let scanStructList = (list) => {
            for (let b of list) {
                if (b.owner === this.owner || b.energy <= 0) continue;
                let d = Math.hypot(b.x - this.x, b.y - this.y);
                if (d < closestStructD) { closestStructD = d; closestStruct = b; }
            }
        };
        scanStructList(barracks);
        scanStructList(collectorSpawners);
        if (closestStruct) {
            this.targetBuilding = closestStruct;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
            return;
        }

        let rTiles = Math.ceil(aggroRange / TILE) + 1;
        let ugx = Math.floor(this.x / TILE), ugy = Math.floor(this.y / TILE);
        let minGx = Math.max(0, ugx - rTiles), maxGx = Math.min(GRID_W - 1, ugx + rTiles);
        let minGy = Math.max(0, ugy - rTiles), maxGy = Math.min(GRID_H - 1, ugy + rTiles);
        let closestItem = null, closestItemD = aggroRange;
        for (let gy = minGy; gy <= maxGy; gy++) {
            for (let gx = minGx; gx <= maxGx; gx++) {
                let cell = grid[gy][gx];
                if (!cell || !cell.item || cell.owner === this.owner) continue;
                let item = cell.item;
                if (item.energy <= 0 || item.underConstruction) continue;
                let d = Math.hypot(item.x - this.x, item.y - this.y);
                if (d < closestItemD) { closestItemD = d; closestItem = item; }
            }
        }
        if (closestItem) {
            this.targetBuilding = closestItem;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
            return;
        }
        if ((!this.path || this.pathIndex >= this.path.length) && this._pendingPathTarget && this._pendingPathTarget.cmd === CMD_ATTACK_MOVING) {
            if (this.pathIsFallbackAstar) _tryUpgradeAstarFallbackPath(this);
            // Keep attack-move active while waiting for deferred pathfinding.
            return;
        }
        if (this.followPath(spd)) {
            if (this._pendingPathTarget && this._pendingPathTarget.cmd === CMD_ATTACK_MOVING) {
                this.path = null;
                return;
            }
            this.commandState = CMD_IDLE;
            this.path = null;
        }
    }

    _performAttackOnUnit(target) {
        let targetEnergyBefore = target.energy;
        target.energy -= this.attackDamage;
        pushHostileDamageAlert(target, targetEnergyBefore - target.energy, this.owner);
        recordDamageVisual(target, targetEnergyBefore - target.energy, this.owner);
        if (targetEnergyBefore > target.energy) playSound('melee_hit', target.x, target.y);
        tryAutoRetaliateOnHostileDamage(target, this, this.x, this.y);
        this.attackTimer = this.attackCooldown;
        this.attackTarget = target;
        this.attackFlash = 8;
        let style = this.attackStyle;
        if (style === 'fire') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#f50', 3);
            target.burning = Math.max(target.burning, 45);
            target.burnTickDamage = Math.max(target.burnTickDamage, this.attackDamage * 0.04);
        } else if (style === 'water') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#4af', 3);
            target.wet = Math.max(target.wet, 60);
        } else if (style === 'ice') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#afe', 3);
            target.frozen = Math.max(target.frozen, 40);
        } else if (style === 'poison') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#2d2', 3);
            target.poisoned = Math.max(target.poisoned, 50);
            target.poisonTickDamage = Math.max(target.poisonTickDamage, this.attackDamage * 0.04);
        } else if (style === 'laser') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#f0f', 2);
        } else if (style === 'swoop') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#dd0', 2);
        } else if (style === 'ram') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#0f0', 3);
            createDirectedParticles(target.x, target.y, this.x, this.y, '#f00', 2);
            this.energy -= this.maxEnergy * 0.03;
            if (this.energy <= 0) { this.dead = true; }
        } else {
            // Default melee
            createDirectedParticles(this.x, this.y, target.x, target.y, '#f88', 2);
        }
        if (target.energy <= 0) { target.dead = true; return true; }
        return false;
    }

    _performAttackOnBuilding(tb) {
        let buildingEnergyBefore = tb.energy;
        this.attackTimer = this.attackCooldown;
        this.attackTarget = tb;
        this.attackFlash = 8;
        let style = this.attackStyle;
        if (style === 'fire') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#f50', 3);
            applyStatusEffect(tb, 'fire', getUnitBaseLevel(this), this.attackDamage * 0.04);
            if (!isEffectImmune(tb, 'fire')) tb.energy -= this.attackDamage;
        } else if (style === 'water') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#4af', 3);
            applyStatusEffect(tb, 'water', getUnitBaseLevel(this));
            if (!isEffectImmune(tb, 'water')) tb.energy -= this.attackDamage;
        } else if (style === 'ice') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#afe', 3);
            applyStatusEffect(tb, 'ice', getUnitBaseLevel(this), this.attackDamage * 0.2);
            if (!isEffectImmune(tb, 'ice')) tb.energy -= this.attackDamage;
        } else if (style === 'poison') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#2d2', 3);
            applyStatusEffect(tb, 'poison', getUnitBaseLevel(this), this.attackDamage * 0.04);
            if (!isEffectImmune(tb, 'poison')) tb.energy -= this.attackDamage;
        } else if (style === 'laser') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#f0f', 2);
            tb.energy -= this.attackDamage;
        } else if (style === 'swoop') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#dd0', 2);
            tb.energy -= this.attackDamage;
        } else if (style === 'ram') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#0f0', 3);
            createDirectedParticles(tb.x, tb.y, this.x, this.y, '#f00', 2);
            tb.energy -= this.attackDamage;
            this.energy -= this.maxEnergy * 0.03;
            if (this.energy <= 0) { this.dead = true; }
        } else {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#f88', 2);
            tb.energy -= this.attackDamage;
        }
        pushHostileDamageAlert(tb, buildingEnergyBefore - tb.energy, this.owner);
        recordDamageVisual(tb, buildingEnergyBefore - tb.energy, this.owner);
        if (buildingEnergyBefore > tb.energy) playSound('melee_hit', tb.x, tb.y);
        if (tb.energy <= 0) { destroyBuilding(tb); return true; }
        return false;
    }

    doAttacking(spd) {
        // Attack unit target
        if (this.targetUnit) {
            if (this.targetUnit.dead) { this.targetUnit = null; this.attackTarget = null; this.forcedAttackTarget = false; this.commandState = CMD_IDLE; return; }
            let tgx = Math.floor(this.targetUnit.x / TILE), tgy = Math.floor(this.targetUnit.y / TILE);
            let targetVisible = isGameplayTargetVisibleToPlayer(this.owner, tgx, tgy);
            if (!targetVisible) {
                if (this.forcedAttackTarget) {
                    let lockX = Number.isFinite(this._forcedTargetLastSeenX) ? this._forcedTargetLastSeenX : this.targetUnit.x;
                    let lockY = Number.isFinite(this._forcedTargetLastSeenY) ? this._forcedTargetLastSeenY : this.targetUnit.y;
                    this.targetUnit = null;
                    this.attackTarget = null;
                    this.forcedAttackTarget = false;
                    this.path = null;
                    this.pathIndex = 0;
                    this._pendingPathTarget = null;
                    if (Number.isFinite(lockX) && Number.isFinite(lockY)) {
                        let ugx = Math.floor(this.x / TILE), ugy = Math.floor(this.y / TILE);
                        let lgx = Math.floor(lockX / TILE), lgy = Math.floor(lockY / TILE);
                        let dest = findNearestWalkable(lgx, lgy, ugx, ugy, this);
                        if (_canUsePathfindRequestBudget(this.owner)) {
                            _consumePathfindRequestBudget(this.owner);
                            this.path = _findPathForUnitTagged('ai_combat', this, ugx, ugy, dest.x, dest.y, this.isFlying, null, this.owner);
                            this.pathIndex = (this.path && this.path.length > 1 && this.path[0].x === ugx && this.path[0].y === ugy) ? 1 : 0;
                        } else {
                            this.path = _makeFallbackPathForUnit(this, ugx, ugy, dest.x, dest.y, CMD_MOVING, 'ai_combat');
                            this.pathIndex = (this.path && this.path.length > 1 && this.path[0].x === ugx && this.path[0].y === ugy) ? 1 : 0;
                        }
                        this.commandState = CMD_MOVING;
                    } else {
                        this.commandState = CMD_IDLE;
                    }
                    return;
                } else {
                    this.targetUnit = null;
                    this.attackTarget = null;
                    this.path = null;
                    this.pathIndex = 0;
                    this._pendingPathTarget = null;
                    this.forcedAttackTarget = false;
                    this.commandState = CMD_IDLE;
                    return;
                }
            }
            if (this.forcedAttackTarget) {
                this._forcedTargetLastSeenX = this.targetUnit.x;
                this._forcedTargetLastSeenY = this.targetUnit.y;
            }
            let d = Math.hypot(this.targetUnit.x - this.x, this.targetUnit.y - this.y);
            if (d <= this.attackRange + this.r + this.targetUnit.r) {
                this.attackTarget = this.targetUnit;
                this.path = null;
                // In range - attack
                if (this.attackTimer <= 0) {
                    if (this._performAttackOnUnit(this.targetUnit)) {
                        this.targetUnit = null; this.attackTarget = null; this.forcedAttackTarget = false; this.commandState = CMD_IDLE;
                    }
                }
            } else if (!this.forcedAttackTarget && d > 8 * TILE) {
                // Leash
                this.targetUnit = null; this.attackTarget = null; this.path = null; this.forcedAttackTarget = false; this.commandState = CMD_IDLE;
            } else {
                // Move toward target using path if available, direct if close
                if (this.path && this.pathIndex < this.path.length) {
                    this.followPath(spd);
                } else if (d < 2 * TILE || this.isFlying) {
                    // Close enough or flying - direct move
                    let dx = this.targetUnit.x - this.x, dy = this.targetUnit.y - this.y;
                    let dist = Math.hypot(dx, dy);
                    this.x += (dx / dist) * spd; this.y += (dy / dist) * spd;
                } else {
                    // Need a new path toward target
                    let tgx = Math.floor(this.targetUnit.x / TILE), tgy = Math.floor(this.targetUnit.y / TILE);
                    let ugx = Math.floor(this.x / TILE), ugy = Math.floor(this.y / TILE);
                    if (_canUsePathfindRequestBudget(this.owner)) {
                        _consumePathfindRequestBudget(this.owner);
                        let dest = findNearestWalkable(tgx, tgy, ugx, ugy, this);
                        this.path = _findPathForUnitTagged('ai_combat', this, ugx, ugy, dest.x, dest.y, this.isFlying, null, this.owner);
                        this.pathIndex = (this.path && this.path.length > 1 && this.path[0].x === ugx && this.path[0].y === ugy) ? 1 : 0;
                    } else {
                        let dest = findNearestWalkable(tgx, tgy, ugx, ugy, this);
                        this.path = _makeFallbackPathForUnit(this, ugx, ugy, dest.x, dest.y, CMD_ATTACKING, 'ai_combat');
                        this.pathIndex = (this.path && this.path.length > 1 && this.path[0].x === ugx && this.path[0].y === ugy) ? 1 : 0;
                    }
                }
            }
            return;
        }
        // Attack building target
        if (this.targetBuilding) {
            let tb = this.targetBuilding;
            if (tb.energy <= 0) { this.targetBuilding = null; this.attackTarget = null; this.forcedAttackTarget = false; this.commandState = CMD_IDLE; return; }
            let d = Math.hypot(tb.x - this.x, tb.y - this.y);
            if (d <= this.attackRange + this.r + 16) {
                this.attackTarget = tb;
                this.path = null;
                if (this.attackTimer <= 0) {
                    if (this._performAttackOnBuilding(tb)) {
                        this.targetBuilding = null; this.attackTarget = null; this.forcedAttackTarget = false; this.commandState = CMD_IDLE;
                    }
                }
            } else {
                if (this.path && this.pathIndex < this.path.length) {
                    this.followPath(spd);
                } else if (d < 2 * TILE || this.isFlying) {
                    let dx = tb.x - this.x, dy = tb.y - this.y;
                    let dist = Math.hypot(dx, dy);
                    this.x += (dx / dist) * spd; this.y += (dy / dist) * spd;
                } else {
                    let tgx = Math.floor(tb.x / TILE), tgy = Math.floor(tb.y / TILE);
                    let ugx = Math.floor(this.x / TILE), ugy = Math.floor(this.y / TILE);
                    if (_canUsePathfindRequestBudget(this.owner)) {
                        _consumePathfindRequestBudget(this.owner);
                        let dest = findNearestWalkable(tgx, tgy, ugx, ugy, this);
                        this.path = _findPathForUnitTagged('ai_combat', this, ugx, ugy, dest.x, dest.y, this.isFlying, null, this.owner);
                        this.pathIndex = (this.path && this.path.length > 1 && this.path[0].x === ugx && this.path[0].y === ugy) ? 1 : 0;
                    } else {
                        let dest = findNearestWalkable(tgx, tgy, ugx, ugy, this);
                        this.path = _makeFallbackPathForUnit(this, ugx, ugy, dest.x, dest.y, CMD_ATTACKING, 'ai_combat');
                        this.pathIndex = (this.path && this.path.length > 1 && this.path[0].x === ugx && this.path[0].y === ugy) ? 1 : 0;
                    }
                }
            }
            return;
        }
        this.attackTarget = null;
        this.forcedAttackTarget = false;
        this.commandState = CMD_IDLE;
    }

    doHolding() {
        forEachUnitInAreaRange(this.x, this.y, this.attackRangeArea, (u) => {
            let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
            if (!isGameplayTargetVisibleToPlayer(this.owner, ugx, ugy)) return;
            if (this.attackTimer <= 0) {
                this._performAttackOnUnit(u);
                return true;
            }
        }, { enemyOfPlayer: this.owner });
    }

    followPath(spd) {
        if (!this.path || this.pathIndex >= this.path.length) return true;

        // Consume stale nodes first so we never steer back toward an already-reached tile center.
        while (this.path && this.pathIndex < this.path.length) {
            let curNode = this.path[this.pathIndex];
            let ugx = Math.floor(this.x / TILE), ugy = Math.floor(this.y / TILE);
            if (curNode.x !== ugx || curNode.y !== ugy) break;

            let nextNodeInTile = this.path[this.pathIndex + 1];
            if (nextNodeInTile && isCloudPortalLink(curNode.x, curNode.y, nextNodeInTile.x, nextNodeInTile.y, this.owner)) {
                if (!_tryConsumeAstarMoveCost(this, 1)) return false;
                let laneOffsetNow = Math.max(1.5, Math.min(4, this.r * 0.6));
                let nTx = nextNodeInTile.x * TILE + 16;
                let nTy = nextNodeInTile.y * TILE + 16;
                let postNodeNow = this.path[this.pathIndex + 2] || null;
                let linkDxNow = postNodeNow ? (postNodeNow.x - nextNodeInTile.x) : (nextNodeInTile.x - curNode.x);
                let linkDyNow = postNodeNow ? (postNodeNow.y - nextNodeInTile.y) : (nextNodeInTile.y - curNode.y);
                if (Math.abs(linkDxNow) >= Math.abs(linkDyNow)) {
                    nTy += (linkDxNow < 0 ? laneOffsetNow : -laneOffsetNow);
                } else {
                    nTx += (linkDyNow < 0 ? -laneOffsetNow : laneOffsetNow);
                }
                this.x = nTx;
                this.y = nTy;
                this.teleportHideTicks = Math.max(this.teleportHideTicks, 2);
                this.pathIndex += 2;
            } else {
                if (this.pathIndex > 0 && !_tryConsumeAstarMoveCost(this, 1)) return false;
                this.pathIndex++;
            }

            if (this.pathIndex >= this.path.length) return true;
        }
        if (!this.path || this.pathIndex >= this.path.length) return true;

        let node = this.path[this.pathIndex];
        if (!this.pathIsFallbackAstar && !this.isFlying && !canUnitOccupyTile(this, node.x, node.y)) {
            this.path = null;
            this.pathIndex = 0;
            if (this.pathIsFallbackAstar && this._pendingPathTarget) {
                _tryUpgradeAstarFallbackPath(this);
            }
            if (this._pendingPathTarget) {
                this.commandState = this._pendingPathTarget.cmd;
            }
            return true;
        }
        let laneOffset = Math.max(1.5, Math.min(4, this.r * 0.6));
        let baseTx = node.x * TILE + 16;
        let baseTy = node.y * TILE + 16;
        let tx = baseTx;
        let ty = baseTy;

        // Use path-segment direction (stable) instead of live position delta (can flip/jitter).
        let segDx = 0, segDy = 0;
        if (this.pathIndex > 0) {
            let prevNode = this.path[this.pathIndex - 1];
            segDx = node.x - prevNode.x;
            segDy = node.y - prevNode.y;
        } else if (this.pathIndex + 1 < this.path.length) {
            let nextNodeForDir = this.path[this.pathIndex + 1];
            segDx = nextNodeForDir.x - node.x;
            segDy = nextNodeForDir.y - node.y;
        }
        if (segDx === 0 && segDy === 0) {
            if (Math.abs(this.vx) >= Math.abs(this.vy)) segDx = (this.vx >= 0 ? 1 : -1);
            else segDy = (this.vy >= 0 ? 1 : -1);
        }

        // Directional lane rule:
        // horizontal: left -> below center, right -> above center
        // vertical: up -> left of center, down -> right of center
        if (Math.abs(segDx) >= Math.abs(segDy)) {
            ty += (segDx < 0 ? laneOffset : -laneOffset);
        } else {
            tx += (segDy < 0 ? -laneOffset : laneOffset);
        }
        let dx = tx - this.x, dy = ty - this.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 4) {
            let nextNode = this.path[this.pathIndex + 1];
            if (nextNode && isCloudPortalLink(node.x, node.y, nextNode.x, nextNode.y, this.owner)) {
                if (!_tryConsumeAstarMoveCost(this, 1)) return false;
                let nTx = nextNode.x * TILE + 16;
                let nTy = nextNode.y * TILE + 16;
                let postNode = this.path[this.pathIndex + 2] || null;
                let linkDx = postNode ? (postNode.x - nextNode.x) : (nextNode.x - node.x);
                let linkDy = postNode ? (postNode.y - nextNode.y) : (nextNode.y - node.y);
                if (Math.abs(linkDx) >= Math.abs(linkDy)) {
                    nTy += (linkDx < 0 ? laneOffset : -laneOffset);
                } else {
                    nTx += (linkDy < 0 ? -laneOffset : laneOffset);
                }
                this.x = nTx;
                this.y = nTy;
                this.teleportHideTicks = Math.max(this.teleportHideTicks, 2);
                this.pathIndex += 2;
                if (this.pathIndex >= this.path.length) return true;
                return false;
            }
            if (this.pathIndex > 0 && !_tryConsumeAstarMoveCost(this, 1)) return false;
            this.pathIndex++;
            if (this.pathIndex >= this.path.length) return true;
            return false;
        }
        this.vx = (dx / dist) * spd; this.vy = (dy / dist) * spd;
        this.x += this.vx; this.y += this.vy;
        return false;
    }

    draw(ctx) {
        if (this.dead || this.teleportHideTicks > 0) return;
        // Unit body
        let strokeColor = '#000', lw = 1;
        if (this.burning > 0) strokeColor = '#f50';
        else if (this.poisoned > 0) strokeColor = '#2d2';
        else if (this.frozen > 0 && this.wet > 0) strokeColor = '#fff';
        else if (this.frozen > 0) strokeColor = '#afe';
        else if (this.wet > 0) strokeColor = '#4af';
        if (this.burning > 0 || this.poisoned > 0 || this.frozen > 0 || this.wet > 0) lw = 2;

        if (this.isSnake && this.snakeHistory.length > 0) {
            ctx.save();
            ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = this.r * 2;
            ctx.strokeStyle = this.color;
            ctx.beginPath(); ctx.moveTo(this.x, this.y);
            for (let p of this.snakeHistory) ctx.lineTo(p.x, p.y);
            ctx.stroke();
            ctx.fillStyle = this.color;
            ctx.beginPath(); ctx.arc(this.x, this.y, this.r + 2, 0, 6.28); ctx.fill();
            ctx.fillStyle = "black";
            ctx.beginPath(); ctx.arc(this.x - 2, this.y - 2, 2, 0, 6.28); ctx.fill();
            ctx.beginPath(); ctx.arc(this.x + 2, this.y - 2, 2, 0, 6.28); ctx.fill();
            ctx.restore();
        } else if (this.vis === 'triangle') {
            ctx.fillStyle = this.color; ctx.beginPath();
            let tr = this.r * 0.5;
            ctx.moveTo(this.x, this.y + tr); ctx.lineTo(this.x - tr, this.y - tr); ctx.lineTo(this.x + tr, this.y - tr);
            ctx.closePath(); ctx.fill(); ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
        } else if (this.vis === 'star') {
            if (this.unitType === 'collector' || this.unitType === 'astar_collector') {
                ctx.save();
                ctx.font = `${Math.round(this.r * 2.4)}px Arial`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = this.unitType === 'collector' ? '#ffd34d' : (this.carryingValue > 0 ? '#f4f4f4' : '#9aa0a6');
                ctx.fillText(this.unitType === 'collector' ? '⚡' : (this.carryingValue > 0 ? '★' : '☆'), this.x, this.y + 1);
                ctx.restore();
            } else {
                drawCachedUnitStar(ctx, this.x, this.y, this.r, this.color, strokeColor, lw);
            }
        } else if (this.vis === 'triangle_down') {
            ctx.fillStyle = this.color; ctx.beginPath();
            let tr = this.r;
            ctx.moveTo(this.x, this.y + tr); ctx.lineTo(this.x - tr, this.y - tr * 0.5); ctx.lineTo(this.x + tr, this.y - tr * 0.5);
            ctx.closePath(); ctx.fill(); ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
        } else if (this.vis === 'mole') {
            ctx.fillStyle = this.color; ctx.beginPath();
            ctx.ellipse(this.x, this.y, this.r * 0.8, this.r * 1.1, 0, 0, Math.PI * 2);
            ctx.fill(); ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
        } else if (this.vis === 'rect') {
            let rr = this.r;
            ctx.fillStyle = this.color; ctx.fillRect(this.x - rr, this.y - rr * 0.7, rr * 2, rr * 1.4);
            ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.strokeRect(this.x - rr, this.y - rr * 0.7, rr * 2, rr * 1.4);
            if (this.unitType === 'researcher_unit') {
                ctx.fillStyle = '#5af';
                ctx.fillRect(this.x - rr * 0.3, this.y - rr * 0.35, rr * 0.6, rr * 0.7);
                ctx.strokeStyle = '#93f';
                ctx.lineWidth = Math.max(1, lw * 0.8);
                ctx.strokeRect(this.x - rr * 0.3, this.y - rr * 0.35, rr * 0.6, rr * 0.7);
            }
        } else if (this.vis === 'king') {
            let rr = this.r;
            // Crown shape
            ctx.fillStyle = this.color; ctx.beginPath();
            ctx.moveTo(this.x - rr, this.y + rr * 0.4);
            ctx.lineTo(this.x - rr, this.y - rr * 0.2);
            ctx.lineTo(this.x - rr * 0.5, this.y + rr * 0.1);
            ctx.lineTo(this.x, this.y - rr * 0.7);
            ctx.lineTo(this.x + rr * 0.5, this.y + rr * 0.1);
            ctx.lineTo(this.x + rr, this.y - rr * 0.2);
            ctx.lineTo(this.x + rr, this.y + rr * 0.4);
            ctx.closePath(); ctx.fill();
            ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
            // Jewel dots on crown tips
            ctx.fillStyle = '#f00';
            ctx.beginPath(); ctx.arc(this.x - rr, this.y - rr * 0.2, 2, 0, 6.28); ctx.fill();
            ctx.beginPath(); ctx.arc(this.x, this.y - rr * 0.7, 2, 0, 6.28); ctx.fill();
            ctx.beginPath(); ctx.arc(this.x + rr, this.y - rr * 0.2, 2, 0, 6.28); ctx.fill();
        } else {
            ctx.fillStyle = this.color; ctx.beginPath(); ctx.arc(this.x, this.y, this.r, 0, 6.28); ctx.fill();
            ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
        }

        // Owner dot
        ctx.fillStyle = PLAYER_COLORS[this.owner];
        ctx.beginPath(); ctx.arc(this.x, this.y - this.r - 3, 2, 0, 6.28); ctx.fill();

        // Energy bar
        if (this.energy < this.maxEnergy) {
            let bw = this.r * 2 + 4, bh = 2, bx = this.x - bw / 2, by = this.y - this.r - 7;
            ctx.fillStyle = '#600'; ctx.fillRect(bx, by, bw, bh);
            ctx.fillStyle = '#0f0'; ctx.fillRect(bx, by, bw * Math.max(0, this.energy / this.maxEnergy), bh);
        }
        // Attack visual effects
        if (this.attackTarget && this.attackFlash > 0) {
            let tx = this.attackTarget.x, ty = this.attackTarget.y;
            ctx.save();
            let style = this.attackStyle;
            if (style === 'laser') {
                // Laser beam from unit to target
                let grad = ctx.createLinearGradient(this.x, this.y, tx, ty);
                grad.addColorStop(0, '#f0f');
                grad.addColorStop(0.5, '#fff');
                grad.addColorStop(1, '#d0f');
                ctx.strokeStyle = grad;
                ctx.lineWidth = 2 + this.attackFlash * 0.4;
                ctx.shadowColor = '#f0f'; ctx.shadowBlur = 8 + this.attackFlash;
                ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(tx, ty); ctx.stroke();
                // Core beam
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(tx, ty); ctx.stroke();
                ctx.shadowBlur = 0;
            } else if (style === 'fire') {
                // Fire burst toward target
                let dx = tx - this.x, dy = ty - this.y, d = Math.hypot(dx, dy);
                let nx = dx / d, ny = dy / d;
                ctx.strokeStyle = '#f50'; ctx.lineWidth = 3;
                ctx.shadowColor = '#f80'; ctx.shadowBlur = 10;
                ctx.beginPath();
                ctx.moveTo(this.x + nx * this.r, this.y + ny * this.r);
                // Wavy flame path
                let steps = 4;
                for (let i = 1; i <= steps; i++) {
                    let t = i / steps;
                    let mx = this.x + dx * t, my = this.y + dy * t;
                    let perp = (Math.sin(i * 3 + gameTime * 0.5)) * 4;
                    ctx.lineTo(mx + ny * perp, my - nx * perp);
                }
                ctx.stroke();
                ctx.shadowBlur = 0;
            } else if (style === 'water') {
                // Water stream arc
                let mx = (this.x + tx) / 2, my = (this.y + ty) / 2 - 8;
                ctx.strokeStyle = '#4af'; ctx.lineWidth = 2.5;
                ctx.shadowColor = '#08f'; ctx.shadowBlur = 6;
                ctx.beginPath(); ctx.moveTo(this.x, this.y);
                ctx.quadraticCurveTo(mx, my, tx, ty); ctx.stroke();
                // Droplets along arc
                ctx.fillStyle = '#8cf';
                for (let i = 0; i < 3; i++) {
                    let t = (i + 1) / 4;
                    let px = this.x * (1 - t) * (1 - t) + 2 * mx * t * (1 - t) + tx * t * t;
                    let py = this.y * (1 - t) * (1 - t) + 2 * my * t * (1 - t) + ty * t * t;
                    ctx.beginPath(); ctx.arc(px, py, 1.5, 0, 6.28); ctx.fill();
                }
                ctx.shadowBlur = 0;
            } else if (style === 'ice') {
                // Ice shard line with sparkles
                ctx.strokeStyle = '#afe'; ctx.lineWidth = 2;
                ctx.shadowColor = '#fff'; ctx.shadowBlur = 8;
                ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(tx, ty); ctx.stroke();
                // Ice crystals along path
                ctx.fillStyle = '#fff';
                let dx = tx - this.x, dy = ty - this.y;
                for (let i = 1; i <= 3; i++) {
                    let t = i / 4;
                    let px = this.x + dx * t, py = this.y + dy * t;
                    ctx.save(); ctx.translate(px, py); ctx.rotate(gameTime * 0.2 + i);
                    ctx.fillRect(-2, -1, 4, 2); ctx.fillRect(-1, -2, 2, 4);
                    ctx.restore();
                }
                ctx.shadowBlur = 0;
            } else if (style === 'poison') {
                // Poison cloud trail
                let dx = tx - this.x, dy = ty - this.y;
                ctx.globalAlpha = 0.5 + this.attackFlash * 0.05;
                for (let i = 1; i <= 5; i++) {
                    let t = i / 6;
                    let px = this.x + dx * t, py = this.y + dy * t;
                    let sz = 3 + Math.sin(gameTime * 0.3 + i) * 1.5;
                    ctx.fillStyle = i % 2 === 0 ? '#2d2' : '#0a0';
                    ctx.beginPath(); ctx.arc(px, py, sz, 0, 6.28); ctx.fill();
                }
                ctx.globalAlpha = 1;
            } else if (style === 'swoop') {
                // Flying swoop - expanding ring around target on hit
                let swoopR = (8 - this.attackFlash) * 2 + 4;
                ctx.strokeStyle = '#dd0'; ctx.lineWidth = 2;
                ctx.globalAlpha = this.attackFlash / 8;
                ctx.beginPath(); ctx.arc(tx, ty, swoopR, 0, 6.28); ctx.stroke();
                ctx.globalAlpha = 1;
            } else if (style === 'ram') {
                // Snake ram - impact shockwave ring
                let shockR = (8 - this.attackFlash) * 3;
                ctx.strokeStyle = '#ff0'; ctx.lineWidth = 2;
                ctx.globalAlpha = this.attackFlash / 8;
                ctx.beginPath(); ctx.arc(tx, ty, shockR, 0, 6.28); ctx.stroke();
                // Impact lines radiating from target
                ctx.strokeStyle = '#f00'; ctx.lineWidth = 1.5;
                for (let i = 0; i < 6; i++) {
                    let a = i * Math.PI / 3 + gameTime * 0.1;
                    ctx.beginPath();
                    ctx.moveTo(tx + Math.cos(a) * 4, ty + Math.sin(a) * 4);
                    ctx.lineTo(tx + Math.cos(a) * (shockR + 4), ty + Math.sin(a) * (shockR + 4));
                    ctx.stroke();
                }
                ctx.globalAlpha = 1;
            } else if (this.attackFlash > 4) {
                // Default melee: quick slash line
                let dx = tx - this.x, dy = ty - this.y, d = Math.hypot(dx, dy) || 1;
                let nx = dx / d, ny = dy / d;
                let perpX = -ny * 5, perpY = nx * 5;
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
                ctx.globalAlpha = (this.attackFlash - 4) / 4;
                ctx.beginPath();
                ctx.moveTo(tx + perpX, ty + perpY);
                ctx.lineTo(tx - perpX, ty - perpY);
                ctx.stroke();
                ctx.globalAlpha = 1;
            }
            ctx.restore();
        }

        if (shouldShowUnitLevels()) {
            let txt = getUnitLevelLabelText(this);
            let sprite = _getUnitLevelTextSprite(txt);
            let dx = Math.round(this.x - sprite.width * 0.5);
            let dy = Math.round(this.y - this.r - 7 - sprite.height);
            queueDrawImage(ctx, sprite.canvas, dx, dy, sprite.width, sprite.height);
        }

        // Carrying value indicator for workers
        let statusY = this.y - this.r - 9;
        let energyBlocked = Number.isFinite(this._energyBlockedUntil) && gameTime < this._energyBlockedUntil;
        if (this.workerType === 'astar_collector') {
            drawUnitStatusGlyph(ctx, this.carryingValue > 0 ? '★' : '☆', this.carryingValue > 0 ? '#ddd' : '#888', this.x, statusY);
        } else if (this.carryingValue > 0) {
            drawUnitStatusGlyph(ctx, '⚡', '#fd0', this.x, statusY);
        } else if (this.workerType === 'builder' && this.workerState) {
            // Builder visual: hammer when building, ⚡ when fetching energy.
            if (this.workerState === 'RETURNING_FOR_GOLD') {
                drawUnitStatusGlyph(ctx, '⚡', energyBlocked ? '#f55' : '#fd0', this.x, statusY);
            } else if (this.workerState === 'MOVING_TO_BUILD' || this.workerState === 'BUILDING_IN_PLACE') {
                drawUnitStatusGlyph(ctx, '\uD83D\uDD28', '#fa0', this.x, statusY);
            }
        } else if (this.workerType === 'healer' && this.workerState) {
            if (this.workerState === 'RETURNING_FOR_GOLD') {
                drawUnitStatusGlyph(ctx, '⚡', energyBlocked ? '#f55' : '#fd0', this.x, statusY);
            } else if (this.workerState === 'MOVING_TO_HEAL' || this.workerState === 'HEALING') {
                drawUnitStatusGlyph(ctx, '+', '#fff', this.x, statusY);
            }
        } else if (this.workerType === 'researcher' && this.workerState) {
            if (this.workerState === 'RETURNING_FOR_GOLD' || !this.researcherHasMaterial) {
                drawUnitStatusGlyph(ctx, '⚡', energyBlocked ? '#f55' : '#fd0', this.x, statusY);
            } else if (this.workerState === 'MOVING_TO_RESEARCH' || this.workerState === 'RESEARCHING') {
                drawUnitStatusGlyph(ctx, 'R', '#7bf', this.x, statusY);
            }
        }
    }
}

function canUnitAutoRetaliate(unit) {
    return !!(
        unit &&
        !unit.dead &&
        !unit.workerState &&
        (unit.commandState === CMD_IDLE || unit.commandState === CMD_HOLDING) &&
        Number(unit.attackDamage) > 0 &&
        Number(unit.attackRange) > 0
    );
}

function _issueRetaliationPath(unit, targetGx, targetGy, forcedAttackTarget) {
    let ugx = Math.floor(unit.x / TILE), ugy = Math.floor(unit.y / TILE);
    let dest = findNearestWalkable(targetGx, targetGy, ugx, ugy, unit);
    let canWalk = (typeof getPathCanWalkForUnit === 'function') ? getPathCanWalkForUnit(unit) : null;
    unit.path = null;
    unit.pathIndex = 0;
    unit._pendingPathTarget = null;
    if (_canUsePathfindRequestBudget(unit.owner)) {
        _consumePathfindRequestBudget(unit.owner);
        unit.path = _findPathForUnitTagged('ai_combat', unit, ugx, ugy, dest.x, dest.y, unit.isFlying, canWalk, unit.owner);
        if (unit.path && unit.path.length > 0) {
            unit.pathIndex = (unit.path.length > 1 && unit.path[0].x === ugx && unit.path[0].y === ugy) ? 1 : 0;
            return;
        }
    } else {
        unit.path = _makeFallbackPathForUnit(unit, ugx, ugy, dest.x, dest.y, CMD_ATTACKING, 'ai_combat');
        unit.pathIndex = (unit.path && unit.path.length > 1 && unit.path[0].x === ugx && unit.path[0].y === ugy) ? 1 : 0;
        return;
    }
    unit.path = null;
    unit.pathIndex = 0;
    unit._pendingPathTarget = { gx: dest.x, gy: dest.y, cmd: CMD_ATTACKING, src: forcedAttackTarget ? 'retaliate_unit' : 'retaliate_building' };
}

function tryAutoRetaliateOnHostileDamage(unit, attacker, lastKnownX = null, lastKnownY = null) {
    if (!canUnitAutoRetaliate(unit)) return false;
    if (!attacker) return false;
    if (attacker === unit) return false;
    if (Number.isFinite(attacker.owner) && attacker.owner === unit.owner) return false;

    let attackerIsUnit = attacker instanceof Unit;
    if (attackerIsUnit) {
        if (attacker.dead) return false;
        unit.targetUnit = attacker;
        unit.targetBuilding = null;
        unit.targetPos = null;
        unit.attackTarget = null;
        unit.forcedAttackTarget = true;
        unit._forcedTargetLastSeenX = Number.isFinite(attacker.x) ? attacker.x : lastKnownX;
        unit._forcedTargetLastSeenY = Number.isFinite(attacker.y) ? attacker.y : lastKnownY;
        unit.commandState = CMD_ATTACKING;
        _issueRetaliationPath(unit, Math.floor((unit._forcedTargetLastSeenX || attacker.x) / TILE), Math.floor((unit._forcedTargetLastSeenY || attacker.y) / TILE), true);
        return true;
    }

    if ('energy' in attacker && Number(attacker.energy) <= 0) return false;
    if (!Number.isFinite(attacker.x) || !Number.isFinite(attacker.y)) return false;

    unit.targetUnit = null;
    unit.targetBuilding = attacker;
    unit.targetPos = null;
    unit.attackTarget = null;
    unit.forcedAttackTarget = false;
    unit._forcedTargetLastSeenX = null;
    unit._forcedTargetLastSeenY = null;
    unit.commandState = CMD_ATTACKING;
    let targetGx = Number.isFinite(attacker.gx) ? attacker.gx : Math.floor(attacker.x / TILE);
    let targetGy = Number.isFinite(attacker.gy) ? attacker.gy : Math.floor(attacker.y / TILE);
    _issueRetaliationPath(unit, targetGx, targetGy, false);
    return true;
}


function getUnitStackCount(u) {
    if (!u) return 1;
    if (Number.isFinite(u.stackCount) && u.stackCount >= 1) return Math.floor(u.stackCount);
    return getRequiredStacksForLevel(getUnitBaseLevel(u));
}

function stackCountToLevel(stacks) {
    return Math.max(1, clampThingLevel(Math.floor(Math.log2(Math.max(1, Math.floor(stacks || 1)))) + 1));
}

function distributeEvenInteger(total, count) {
    let n = Math.max(0, Math.floor(count || 0));
    if (n <= 0) return [];
    let sum = Math.max(0, Math.floor(total || 0));
    let base = Math.floor(sum / n);
    let rem = sum % n;
    let out = new Array(n).fill(base);
    for (let i = 0; i < rem; i++) out[i]++;
    return out;
}

function distributeEvenWithCaps(total, caps) {
    let n = caps.length;
    if (n === 0) return [];
    let values = new Array(n).fill(0);
    let left = Math.max(0, Number(total) || 0);
    let active = Array.from({ length: n }, (_, i) => i);
    let eps = 1e-6;
    while (left > eps && active.length > 0) {
        let share = left / active.length;
        let nextActive = [];
        for (let idx of active) {
            let capLeft = Math.max(0, (Number(caps[idx]) || 0) - values[idx]);
            if (capLeft <= eps) continue;
            let add = Math.min(capLeft, share);
            values[idx] += add;
            left -= add;
            if (((Number(caps[idx]) || 0) - values[idx]) > eps) nextActive.push(idx);
        }
        if (nextActive.length === active.length) {
            // No one capped this pass, we're done.
            break;
        }
        active = nextActive;
    }
    return values;
}

function removeUnitNow(u, adjustPop = true) {
    if (!u) return;
    if (!u.dead) {
        u.dead = true;
        u.energy = 0;
    }
    _clearWorkerTarget(u);
    removeUnitSpatial(u);
    selectedUnits = selectedUnits.filter(su => su !== u);
    let idx = units.indexOf(u);
    if (idx >= 0) units.splice(idx, 1);
    if (adjustPop && players[u.owner]) players[u.owner].popCount = Math.max(0, (players[u.owner].popCount || 0) - 1);
}

function configureWorkerUnitFromType(u) {
    if (!u) return;
    if (u.unitType === 'collector') {
        u.workerState = 'IDLE'; u.workerType = 'collector'; u.carryingValue = 0; _clearWorkerTarget(u);
    } else if (u.unitType === 'astar_collector') {
        u.workerState = 'IDLE'; u.workerType = 'astar_collector'; u.carryingValue = 0; _clearWorkerTarget(u);
    } else if (u.unitType === 'salvager_unit') {
        u.workerState = 'IDLE'; u.workerType = 'salvager'; u.carryingValue = 0; _clearWorkerTarget(u);
    } else if (u.unitType === 'builder_unit') {
        u.workerState = 'IDLE'; u.workerType = 'builder'; u.carryingValue = 0; _clearWorkerTarget(u);
        u.builderHasMaterial = false;
    } else if (u.unitType === 'healer_unit') {
        u.workerState = 'IDLE'; u.workerType = 'healer'; u.carryingValue = 0; _clearWorkerTarget(u);
        u.healerHasMaterial = false;
    } else if (u.unitType === 'researcher_unit') {
        u.workerState = 'IDLE'; u.workerType = 'researcher'; u.carryingValue = 0; _clearWorkerTarget(u);
        u.researcherHasMaterial = false;
    }
}

function spawnUnitNearUnit(templateUnit) {
    if (!templateUnit) return null;
    let attempts = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1],
        [2, 0], [-2, 0], [0, 2], [0, -2]
    ];
    let baseGx = Math.floor(templateUnit.x / TILE);
    let baseGy = Math.floor(templateUnit.y / TILE);
    let spawnTile = { x: baseGx, y: baseGy };
    for (let [dx, dy] of attempts) {
        let tx = Math.max(0, Math.min(GRID_W - 1, baseGx + dx));
        let ty = Math.max(0, Math.min(GRID_H - 1, baseGy + dy));
        if (templateUnit.isFlying || canUnitOccupyTile(templateUnit, tx, ty)) {
            spawnTile = { x: tx, y: ty };
            break;
        }
    }
    if (!templateUnit.isFlying) {
        spawnTile = findNearestWalkable(spawnTile.x, spawnTile.y, baseGx, baseGy);
    }
    let nu = new Unit(templateUnit.unitType, templateUnit.owner, spawnTile.x * TILE + 16, spawnTile.y * TILE + 16);
    configureWorkerUnitFromType(nu);
    return nu;
}

function shuffleInPlaceDeterministic(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        let r = (typeof rng === 'function')
            ? rng()
            : ((((i + 1) * 1103515245 + (gameTime + 1) * 12345) >>> 0) / 4294967296);
        let j = Math.floor(r * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function resizeUnitSubgroup(playerId, unitIds, mode, subgroupFilter = null) {
    if (!Array.isArray(unitIds) || unitIds.length === 0) return;
    let idSet = new Set(unitIds);
    let source = units.filter(u => idSet.has(u.id) && u.owner === playerId && !u.dead && !u.isKing);
    if (subgroupFilter && subgroupFilter.unitType) {
        source = source.filter(u => u.unitType === subgroupFilter.unitType);
    }
    if (subgroupFilter && Number.isFinite(subgroupFilter.unitLevel)) {
        source = source.filter(u => getUnitBaseLevel(u) === subgroupFilter.unitLevel);
    }
    if (source.length === 0) return;
    if (mode === 'd2' && source.length < 2) return;

    // Keep deterministic order for repeatable redistribution.
    source.sort((a, b) => a.id - b.id);

    let initialCount = source.length;
    let sumStacks = source.reduce((s, u) => s + getUnitStackCount(u), 0);
    let sumEnergy = source.reduce((s, u) => s + Math.max(0, Number(u.energy) || 0), 0);

    let targetCount = initialCount;
    if (mode === 'x2') {
        targetCount = Math.min(sumStacks, initialCount * 2);
        let popCap = getPlayerPopCap(playerId);
        let room = Math.max(0, popCap - players[playerId].popCount);
        targetCount = Math.min(targetCount, initialCount + room);
    } else {
        targetCount = Math.floor(initialCount / 2);
    }
    targetCount = Math.max(0, Math.floor(targetCount));

    let survivors = [];
    if (targetCount >= initialCount) {
        survivors = [...source];
        let toSpawn = targetCount - initialCount;
        for (let i = 0; i < toSpawn; i++) {
            let template = source[i % source.length];
            let nu = spawnUnitNearUnit(template);
            if (!nu) continue;
            units.push(nu);
            players[playerId].popCount++;
            survivors.push(nu);
        }
    } else {
        let shuffled = shuffleInPlaceDeterministic([...source]);
        let survivorSet = new Set(shuffled.slice(0, targetCount).map(u => u.id));
        survivors = source.filter(u => survivorSet.has(u.id));
        for (let u of source) {
            if (!survivorSet.has(u.id)) removeUnitNow(u, true);
        }
    }

    if (survivors.length === 0) {
        updateInfoPanel();
        return;
    }

    // Distribute virtual stacks evenly (+-1), preserving exact combined stacks.
    let stackShares = distributeEvenInteger(sumStacks, survivors.length);
    for (let i = 0; i < survivors.length; i++) {
        let u = survivors[i];
        let stackCount = Math.max(1, stackShares[i]);
        u.stackCount = stackCount;
        let lvl = stackCountToLevel(stackCount);
        applyUnitLevelScaling(u, lvl);
        u.stackCount = stackCount;
    }

    // Preserve total Energy as much as possible without exceeding new total max Energy.
    let maxEnergyCaps = survivors.map(u => Math.max(1, Number(u.maxEnergy) || 1));
    let energyTarget = Math.min(sumEnergy, maxEnergyCaps.reduce((s, v) => s + v, 0));
    let energyShares = distributeEvenWithCaps(energyTarget, maxEnergyCaps);
    for (let i = 0; i < survivors.length; i++) {
        survivors[i].energy = Math.max(0, Math.min(maxEnergyCaps[i], energyShares[i]));
        if (survivors[i].energy <= 0) survivors[i].energy = Math.min(1, maxEnergyCaps[i]);
    }

    // Keep selection focused on transformed survivors only.
    let survivorIds = new Set(survivors.map(u => u.id));
    selectedUnits = selectedUnits.filter(u => !idSet.has(u.id) || survivorIds.has(u.id));
    for (let u of survivors) {
        if (!selectedUnits.includes(u)) selectedUnits.push(u);
    }

    updateInfoPanel();
}


function findNearestWalkable(gx, gy, fromGx, fromGy, unit = null) {
    if (isWalkableTileFor(unit, gx, gy)) return { x: gx, y: gy };

    let maxRadius = Math.max(GRID_W, GRID_H);
    for (let r = 1; r <= maxRadius; r++) {
        let candidates = [];
        for (let x = gx - r; x <= gx + r; x++) {
            candidates.push({ x, y: gy - r });
            candidates.push({ x, y: gy + r });
        }
        for (let y = gy - r + 1; y <= gy + r - 1; y++) {
            candidates.push({ x: gx - r, y });
            candidates.push({ x: gx + r, y });
        }

        if (Number.isFinite(fromGx) && Number.isFinite(fromGy)) {
            candidates.sort((a, b) => {
                let da = Math.hypot(a.x - fromGx, a.y - fromGy);
                let db = Math.hypot(b.x - fromGx, b.y - fromGy);
                if (da !== db) return da - db;
                if (a.y !== b.y) return a.y - b.y;
                return a.x - b.x;
            });
        }

        for (let c of candidates) {
            if (!isWalkableTileFor(unit, c.x, c.y)) continue;
            return { x: c.x, y: c.y };
        }
    }

    return {
        x: Math.max(0, Math.min(GRID_W - 1, gx)),
        y: Math.max(0, Math.min(GRID_H - 1, gy))
    };
}

function pushUnitOutOfBlockedTile(unit) {
    if (!unit || unit.dead || unit.isFlying) return;
    let gx = Math.floor(unit.x / TILE), gy = Math.floor(unit.y / TILE);
    if (canUnitOccupyTile(unit, gx, gy)) return;

    let fromGx = Number.isFinite(unit.prevX) ? Math.floor(unit.prevX / TILE) : gx;
    let fromGy = Number.isFinite(unit.prevY) ? Math.floor(unit.prevY / TILE) : gy;
    let dest = findNearestWalkable(gx, gy, fromGx, fromGy, unit);
    if (!canUnitOccupyTile(unit, dest.x, dest.y)) return;

    unit.x = dest.x * TILE + TILE * 0.5;
    unit.y = dest.y * TILE + TILE * 0.5;
    unit.path = null;
    unit.pathIndex = 0;
    if (unit._pendingPathTarget) {
        _tryUpgradeAstarFallbackPath(unit);
        if (!unit.path || unit.path.length <= 0) {
            if (unit.workerState === 'MANUAL_MOVE') {
                unit.commandState = unit._pendingPathTarget.cmd;
                return;
            }
            unit.commandState = unit._pendingPathTarget.cmd;
        }
    }
}

const UNIT_STAR_PATH_CACHE = new Map();

function getUnitStarPath(radius) {
    let r = Math.max(1, Number(radius) || 1);
    let key = `${r}`;
    let cached = UNIT_STAR_PATH_CACHE.get(key);
    if (cached) return cached;

    let p = new Path2D();
    for (let i = 0; i < 5; i++) {
        let a = (i * 4 * Math.PI) / 5 - Math.PI / 2;
        let px = Math.cos(a) * r;
        let py = Math.sin(a) * r;
        if (i === 0) p.moveTo(px, py);
        else p.lineTo(px, py);
    }
    p.closePath();
    UNIT_STAR_PATH_CACHE.set(key, p);
    return p;
}


const UNIT_STATUS_GLYPH_CACHE = new Map();
const UNIT_STATUS_GLYPH_CACHE_MAX = 64;

function _getUnitStatusGlyphSprite(symbol, color, size = 'normal') {
    let txt = String(symbol || '');
    let scale = _getUiSpriteScale();
    let sizeKey = String(size || 'normal');
    let key = txt + '|' + String(color || '#fff') + '|' + scale + '|' + sizeKey;
    let cached = UNIT_STATUS_GLYPH_CACHE.get(key);
    if (cached) return cached;

    let compact = sizeKey === 'small';
    let w = compact ? 10 : 14;
    let h = compact ? 9 : 12;
    let c = document.createElement('canvas');
    c.width = w * scale;
    c.height = h * scale;
    let g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.clearRect(0, 0, w, h);
    g.font = compact
        ? '700 8px Segoe UI Emoji, Segoe UI Symbol, Segoe UI, Arial, sans-serif'
        : '700 10px Segoe UI Emoji, Segoe UI Symbol, Segoe UI, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = color;
    g.shadowColor = 'transparent';
    g.shadowBlur = 0;
    g.fillText(txt, w * 0.5, h * 0.5 + 0.5);
    g.shadowColor = 'transparent';

    cached = { canvas: c, width: w, height: h };
    UNIT_STATUS_GLYPH_CACHE.set(key, cached);
    _trimSpriteCache(UNIT_STATUS_GLYPH_CACHE, UNIT_STATUS_GLYPH_CACHE_MAX);
    return cached;
}

function drawUnitStatusGlyph(ctx, symbol, color, x, y, size = 'normal') {
    let s = _getUnitStatusGlyphSprite(symbol, color, size);
    let dx = Math.round(x - s.width * 0.5);
    let dy = Math.round(y - s.height * 0.5);
    queueDrawImage(ctx, s.canvas, dx, dy, s.width, s.height);
}

function drawCachedUnitStar(ctx, x, y, radius, color, strokeColor = '#000', lineWidth = 1) {
    let path = getUnitStarPath(radius);
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.fill(path);
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.stroke(path);
    ctx.restore();
}