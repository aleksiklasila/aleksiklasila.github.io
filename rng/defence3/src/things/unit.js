"use strict";

// ============================================================
// UNIT CLASS
// ============================================================
const CMD_IDLE = 0, CMD_MOVING = 1, CMD_ATTACK_MOVING = 2, CMD_ATTACKING = 3, CMD_HOLDING = 4;
const UNIT_POSITION_QUANTIZATION = 8;

function _isHostileThingVisibleToUnit(unit, target) {
    if (!unit || !target) return false;
    let gx = Number.isFinite(target.gx) ? Math.floor(Number(target.gx)) : Math.floor((Number(target.x) || 0) / TILE);
    let gy = Number.isFinite(target.gy) ? Math.floor(Number(target.gy)) : Math.floor((Number(target.y) || 0) / TILE);
    return isGameplayTargetVisibleToPlayer(unit.owner, gx, gy);
}

const hostileStructureIndexes = new WeakMap();

function _getHostileStructureIndex(list) {
    const tick = typeof gameTime === 'number' ? gameTime : 0;
    const revision = typeof pathTopologyVersion === 'number' ? pathTopologyVersion : 0;
    let index = hostileStructureIndexes.get(list);
    if (index && index.tick === tick && index.revision === revision && index.length === list.length) return index;
    const size = TILE * 4;
    index = { tick, revision, length: list.length, size, buckets: new Map(), witnesses: new Map(), owners: new Map() };
    for (let order = 0; order < list.length; order++) {
        const target = list[order];
        const gx = Number.isFinite(target.gx) ? Math.floor(target.gx) : Math.floor((Number(target.x) || 0) / TILE);
        const gy = Number.isFinite(target.gy) ? Math.floor(target.gy) : Math.floor((Number(target.y) || 0) / TILE);
        if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) continue;
        const entry = { target, order, gx, gy };
        let owned = index.owners.get(target.owner);
        if (!owned) index.owners.set(target.owner, owned = []);
        owned.push(target);
        const key = Math.floor(target.y / size) * (Math.ceil(GRID_W / 4) + 1) + Math.floor(target.x / size);
        let bucket = index.buckets.get(key);
        if (!bucket) index.buckets.set(key, bucket = []);
        bucket.push(entry);
    }
    hostileStructureIndexes.set(list, index);
    return index;
}

// Preserve list order, strict distance ties and lazy visibility snapshot timing.
// The raw grid is immutable for this tick; resolve it once per scan rather than
// repeating player normalization and cache lookups for every building.
function _findClosestHostileStructure(unit, firstList, range, secondList = null, acceptsTarget = null) {
    let closest = null;
    let bestDistance = range;
    let vis = null;
    for (let pass = 0; pass < (secondList ? 2 : 1); pass++) {
        let list = pass === 0 ? firstList : secondList;
        let index = _getHostileStructureIndex(list);
        // Materialize the lazy grid at the same point as the original scan,
        // even when every hostile building is outside the search radius.
        let witness = index.witnesses.get(unit.owner);
        if (!witness || witness.owner === unit.owner || witness.energy <= 0) {
            witness = null;
            for (let [owner, owned] of index.owners) {
                if (owner === unit.owner) continue;
                for (let target of owned) {
                    if (target.owner !== unit.owner && target.energy > 0) { witness = target; break; }
                }
                if (witness) break;
            }
            if (witness) index.witnesses.set(unit.owner, witness);
        }
        if (!vis && witness) {
            let owner = Math.floor(Number(unit.owner));
            if (!Number.isFinite(owner) || owner < 0) owner = localPlayerId;
            vis = getRawVisibilityGridForPlayer(owner);
        }
        if (!vis || vis.length !== GRID_H || !(bestDistance > 0)) continue;
        let bestOrder = Infinity;
        const stride = Math.ceil(GRID_W / 4) + 1;
        const minX = Math.max(0, Math.floor((unit.x - bestDistance) / index.size));
        const maxX = Math.min(Math.ceil(GRID_W / 4), Math.floor((unit.x + bestDistance) / index.size));
        const minY = Math.max(0, Math.floor((unit.y - bestDistance) / index.size));
        const maxY = Math.min(Math.ceil(GRID_H / 4), Math.floor((unit.y + bestDistance) / index.size));
        for (let by = minY; by <= maxY; by++) for (let bx = minX; bx <= maxX; bx++) {
          let bucket = index.buckets.get(by * stride + bx);
          if (!bucket) continue;
          for (let entry of bucket) {
            let { target, gx, gy, order } = entry;
            if (target.owner === unit.owner || target.energy <= 0) continue;
            if (acceptsTarget && !acceptsTarget(target)) continue;
            let dx = target.x - unit.x, dy = target.y - unit.y;
            if (Math.abs(dx) > bestDistance || Math.abs(dy) > bestDistance) continue;
            if (!vis[gy] || !(vis[gy][gx] > 0)) continue;
            let distance = Math.hypot(dx, dy);
            if (distance < bestDistance || (distance === bestDistance && bestOrder !== Infinity && order < bestOrder)) {
                bestDistance = distance; closest = target; bestOrder = order;
            }
          }
        }
    }
    return closest;
}

function _tryConsumeAstarMoveCostForTransition(u, fromNode = null, toNode = null) {
    if (!u) return false;
    if (!fromNode || !toNode || !Number.isFinite(fromNode.x) || !Number.isFinite(fromNode.y) || !Number.isFinite(toNode.x) || !Number.isFinite(toNode.y)) {
        return _tryConsumeAstarMoveCost(u, 1);
    }
    let fromKey = (Math.floor(fromNode.y) * GRID_W) + Math.floor(fromNode.x);
    let toKey = (Math.floor(toNode.y) * GRID_W) + Math.floor(toNode.x);
    if (
        Number(u._astarLastChargedTick) === gameTime &&
        Number(u._astarLastChargedFromKey) === fromKey &&
        Number(u._astarLastChargedToKey) === toKey
    ) {
        return true;
    }
    if (!_tryConsumeAstarMoveCost(u, 1)) return false;
    u._astarLastChargedTick = gameTime;
    u._astarLastChargedFromKey = fromKey;
    u._astarLastChargedToKey = toKey;
    return true;
}

// A route node is roomy when its whole 3x3 block is open terrain. Structures,
// portals and map edges count as blocked, so corridors, gates and portals keep
// exact waypoints. The final node and portal entrances are never roomy.
function _isPathNodeRoomy(path, i) {
    let node = path[i], next = path[i + 1];
    if (!next || Math.abs(next.x - node.x) + Math.abs(next.y - node.y) !== 1) return false;
    let x = node.x, y = node.y;
    if (x < 1 || y < 1 || x >= GRID_W - 1 || y >= GRID_H - 1) return false;
    for (let gy = y - 1; gy <= y + 1; gy++) {
        let row = grid[gy];
        if (row[x - 1].type === TYPE_WALL || row[x].type === TYPE_WALL || row[x + 1].type === TYPE_WALL) return false;
    }
    return true;
}

const _unitCollisionCandidates = [];

// Floor structures that harm units standing on them.
const TRAP_ITEM_TYPES = new Set(['lava', 'poison_puddle', 'ice_patch', 'water_puddle', 'sand', 'mine']);
function isTrapItem(item) { return !!(item && TRAP_ITEM_TYPES.has(item.type)); }

// Whether a tile is on the next stretch of the unit's route.
const UNIT_ROUTE_LOOKAHEAD = 12;
function _isTileOnUnitRoute(unit, gx, gy) {
    let path = unit.path;
    if (!path) return false;
    let end = Math.min(path.length, (unit.pathIndex || 0) + UNIT_ROUTE_LOOKAHEAD);
    for (let i = Math.max(0, (unit.pathIndex || 0) - 1); i < end; i++) {
        if (path[i].x === gx && path[i].y === gy) return true;
    }
    return false;
}

// Hostile structure the unit can hit from where it stands (area attack
// range, from the same +-0.3 tile window as its drawn range), by threat:
// turrets, traps on its route, other traps, then any other building. Nearest
// wins within a class, then the lower tile index. Visible targets only.
function _findHostileStructureInAttackRange(unit) {
    let sources = getSourceAreaIdsAtWorld(unit.x, unit.y);
    if (sources.length === 0) return null;
    let best = null, bestRank = 4, bestD2 = Infinity, bestKey = Infinity;
    let structuresByArea = getStructuresByArea();
    for (let areaId of getAreaIdsWithinDistanceOfSources(sources, Math.floor(_getUnitAttackRangeArea(unit)))) {
        let structures = structuresByArea[areaId];
        if (!structures) continue;
        for (let target of structures) {
            let gx = target.gx, gy = target.gy, cell = grid[gy][gx];
            if (!(target.energy > 0) || target.underConstruction) continue;
            let owner = target.owner !== undefined ? target.owner : cell.owner;
            if (owner === unit.owner || owner < 0) continue;
            // Towers are tile entities, never cell items; portals are not turrets.
            let turret = cell.item !== target && !String(target.type || '').startsWith('cloud');
            let rank = turret ? 0 : isTrapItem(target) ? (_isTileOnUnitRoute(unit, gx, gy) ? 1 : 2) : 3;
            if (rank > bestRank) continue;
            let dx = target.x - unit.x, dy = target.y - unit.y, d2 = dx * dx + dy * dy, key = gy * GRID_W + gx;
            if (rank === bestRank && (d2 > bestD2 || (d2 === bestD2 && key > bestKey))) continue;
            if (!isGameplayTargetVisibleToPlayer(unit.owner, gx, gy)) continue;
            best = target; bestRank = rank; bestD2 = d2; bestKey = key;
        }
    }
    return best;
}

// Closest visible hostile cell item within range of the unit's tile window.
// Visits the same tiles in the same row-major order as a scan of every tile
// in the window (strictly nearer wins, so ties keep the earlier tile), but
// only tiles that hold an item. `kind` limits it to traps (those on the
// unit's route first) or to everything else.
function _findClosestHostileCellItem(unit, range, kind = null) {
    let rTiles = Math.ceil(range / TILE) + 1;
    let ugx = Math.floor(unit.x / TILE), ugy = Math.floor(unit.y / TILE);
    let minGx = Math.max(0, ugx - rTiles), maxGx = Math.min(GRID_W - 1, ugx + rTiles);
    let minGy = Math.max(0, ugy - rTiles), maxGy = Math.min(GRID_H - 1, ugy + rTiles);
    let closest = null, closestD = range, closestOnRoute = false;
    let items = getCellItemsRowMajor();
    for (let i = findCellItemRowStart(items, minGy); i < items.length; i++) {
        let item = items[i], gx = item.gx, gy = item.gy;
        if (gy > maxGy) break;
        if (gx < minGx || gx > maxGx) continue;
        if (kind && (kind === 'trap') !== isTrapItem(item)) continue;
        let cell = grid[gy][gx];
        if (!cell || cell.item !== item || cell.owner === unit.owner) continue;
        if (!isGameplayTargetVisibleToPlayer(unit.owner, gx, gy)) continue;
        if (item.energy <= 0 || item.underConstruction) continue;
        let d = Math.hypot(item.x - unit.x, item.y - unit.y);
        if (d >= range) continue;
        let onRoute = kind === 'trap' && _isTileOnUnitRoute(unit, gx, gy);
        if (closestOnRoute && !onRoute) continue;
        if ((onRoute && !closestOnRoute) || d < closestD) { closestD = d; closest = item; closestOnRoute = onRoute; }
    }
    return closest;
}

// Structure an idle or attack-moving unit engages on its own, by threat:
// turrets, traps (those on its route first), barracks and spawners, then any
// other building. Within a class the nearest visible one in range.
function _findAutoStructureTarget(unit, range) {
    // Every scan below stays within this tile window of the unit.
    let reach = Math.ceil(range / TILE) + 1;
    let ugx = Math.floor(unit.x / TILE), ugy = Math.floor(unit.y / TILE);
    if (!hasHostileStructureInTileRect(unit.owner, ugx - reach, ugy - reach, ugx + reach, ugy + reach)) return null;
    return _findClosestHostileStructure(unit, towers, range)
        || _findClosestHostileCellItem(unit, range, 'trap')
        || _findClosestHostileStructure(unit, barracks, range, collectorSpawners)
        || _findClosestHostileCellItem(unit, range, 'other');
}

function _findNearbyCombatEnemy(unit, range) {
    let closest = null, best = range * range;
    // This refresh is already staggered by the caller. Do not use the older
    // once-per-second chunk query, whose stagger can miss this cadence forever.
    forEachUnitInRange(unit.x, unit.y, range, (enemy, d2) => {
        if (enemy.dead || enemy.owner === unit.owner || !_isHostileThingVisibleToUnit(unit, enemy)) return;
        if (d2 < best || (d2 === best && (!closest || enemy.id < closest.id))) {
            closest = enemy; best = d2;
        }
    }, { enemyOfPlayer: unit.owner });
    return closest;
}

function _quantizeUnitWorldCoord(value) {
    let n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * UNIT_POSITION_QUANTIZATION) / UNIT_POSITION_QUANTIZATION;
}

function _getUnitAttackRangeArea(unit) {
    return Math.max(0, Number(unit && unit.preComputed && unit.preComputed.attackRangeArea) || 0);
}

function _isTargetWithinUnitAttackAreaRange(unit, target) {
    if (!unit || !target) return false;
    let rangeArea = Math.max(0, Number(_getUnitAttackRangeArea(unit)) || 0);
    return isWorldTargetWithinAreaRange(unit.x, unit.y, target.x, target.y, Math.floor(rangeArea));
}

class Unit {
    constructor(unitType, owner, x, y) {
        this.id = nextUnitId++;
        this.unitType = unitType;
        this.owner = owner;
        this.x = x; this.y = y;
        this.prevX = x; this.prevY = y;
        this.teleportHideTicks = 0;

        let s = BASE_UNIT_STATS[unitType] || BASE_UNIT_STATS.norm;
        this.energy = Math.max(1, Math.floor(Number(s.energy) || 1));
        this.preComputedBase = null;
        this.preComputedEffective = null;
        this.basePreComputed = null;
        this.preComputed = null;
        this.attackTimer = 0;
        this.vis = s.vis || 'circle';
        this.color = s.color || '#fff';
        this.r = s.r;
        this.collisionR = Number.isFinite(s.collisionR) ? s.collisionR : this.r;
        this.turretImmune = s.turretImmune || false;
        this.isSnake = s.isSnake || false;
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
        this.baseLevel = 1;

        // Status effects
        this.poisoned = 0; this.poisonTickDamage = 0;
        this.burning = 0; this.burnTickDamage = 0;
        this.frozen = 0; this.iceTickDamage = 0;
        this.wet = 0; this.sandy = 0; this.watched = 0; this.watchedByTeam = -1;
        this.vx = 0; this.vy = 0;
        this.workerTransferCooldown = 0;

        // Fields that are otherwise added on first use (workers, pathing,
        // astar budget, damage flash...). Declaring every one here, in one
        // order, gives all units one hidden class: property reads in the
        // per-unit tick loops stay monomorphic instead of megamorphic.
        // Values stay undefined, as if the field had never been set.
        this._effectiveStatsRecalcCounter = undefined; this._lastAppliedEffectiveLevel = undefined; this._thingStatsRecalcCounter = undefined;
        this.workerState = undefined; this.workerType = undefined; this.carryingValue = undefined; this.workerTarget = undefined;
        this.workerTargetType = undefined; this._workerReservedTileIndex = undefined; this._resourceCollectorMemory = undefined;
        this._collectorPinnedTarget = undefined; this._collectorPinnedTargetType = undefined; this._collectorLastGatherX = undefined;
        this._collectorLastGatherY = undefined; this._collectorLastGatherGx = undefined; this._collectorLastGatherGy = undefined;
        this._collectorLastGatherType = undefined; this._collectorNextSpawner = undefined; this._collectorLastDropoffSpawner = undefined;
        this._lastMineTarget = undefined; this._astarLastGatherX = undefined; this._astarLastGatherY = undefined;
        this._astarLastGatherGx = undefined; this._astarLastGatherGy = undefined; this._astarPinnedTarget = undefined;
        this._astarPinnedTargetType = undefined; this._astarNextSpawner = undefined; this._astarLastMineTarget = undefined;
        this._astarLastMineTargetType = undefined; this._lastIdleStateTime = undefined; this._workerNextIdleRetargetTick = undefined;
        this.builderHasMaterial = undefined; this._builderLastWatchX = undefined; this._builderLastWatchY = undefined;
        this._builderLastMoveTick = undefined; this._builderNextRecheckTick = undefined; this.healerHasMaterial = undefined;
        this._healerQueueCommitTarget = undefined; this._healerQueueCommitRequired = undefined; this._healerQueueCommitMaxPaid = undefined;
        this.researcherHasMaterial = undefined; this._workerLastPathX = undefined; this._workerLastPathY = undefined;
        this._workerPathStallTicks = undefined; this._workerLastPathKey = undefined; this._workerLastPathTick = undefined;
        this._astarLastChargedTick = undefined; this._astarLastChargedFromKey = undefined; this._astarLastChargedToKey = undefined;
        this._attackMoveGx = undefined; this._attackMoveGy = undefined; this.pathIsFallbackAstar = undefined;
        this._pendingPathTarget = undefined; this._astarBudgetBlockedUntil = undefined; this._astarBudgetRetryTick = undefined;
        this._manualMoveIssuedTick = undefined; this._builderLastWorkX = undefined; this._builderLastWorkY = undefined;
        this._builderLastWorkGx = undefined; this._builderLastWorkGy = undefined; this._builderSpawnerTarget = undefined;
        this._healerPinnedQueueTarget = undefined; this._healerLastWorkX = undefined; this._healerLastWorkY = undefined;
        this._healerLastWorkGx = undefined; this._healerLastWorkGy = undefined; this._healerSpawnerTarget = undefined;
        this._healerQueueTripCost = undefined; this._researchSpawnerTarget = undefined; this._researcherTripWork = undefined;
        this._researcherTripCost = undefined; this._researcherMaterialReadyTick = undefined; this._damageFlashStart = undefined;
        this._damageFlashUntil = undefined; this._damageFlashStrength = undefined; this._damageFlashColor = undefined;
        this._energyBlockedUntil = undefined; this._nextScoutRetargetTick = undefined; this._scoutTarget = undefined;
        this._levelTextLabel = undefined;
        this._collectorLastMoveTick = undefined; this._collectorNextRecheckTick = undefined; this._healerLastMoveTick = undefined;
        this._healerNextRecheckTick = undefined; this._researchLastMoveTick = undefined; this._researchNextRecheckTick = undefined;
        this.holdPosition = undefined; this._ambientSoundTicks = undefined;

        this._spatialKey = undefined;
        applyUnitLevelScaling(this, 1);
        this.energy = this.preComputedEffective ? this.preComputedEffective.maxEnergy : this.energy;
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
        if (_canUsePathfindRequestBudget(this.owner, this)) {
            _consumePathfindRequestBudget(this.owner, this);
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
        if (this.watched > 0) {
            this.watched--;
            if (this.watched <= 0) this.watchedByTeam = -1;
        }

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
        let spd = this.preComputed.speed;
        if (this.frozen > 0) spd *= 0.5;
        if (this.sandy > 0) spd *= 0.5;
        spd *= _getUnitAstarSpeedMultiplier(this);

        // Attack timer
        if (this.attackTimer > 0) this.attackTimer--;
        if (this.attackFlash > 0) this.attackFlash--;

        // Worker AI (collector/salvager units)
        if (this.workerState) {
            updateWorkerAI(this);
            // Keep worker motion state deterministic: movement-oriented worker states must
            // always execute the movement state machine this tick.
            {
                if (
                    this.workerState === 'MANUAL_MOVE' ||
                    this.workerState === 'MOVING_TO' ||
                    this.workerState === 'MOVING_TO_ASTAR' ||
                    this.workerState === 'RETURNING' ||
                    this.workerState === 'RETURNING_ASTAR' ||
                    this.workerState === 'MOVING_TO_BUILD' ||
                    this.workerState === 'RETURNING_FOR_GOLD' ||
                    this.workerState === 'MOVING_TO_HEAL' ||
                    this.workerState === 'MOVING_TO_RESEARCH'
                ) {
                    this.commandState = CMD_MOVING;
                } else if (
                    this.workerState === 'IDLE' ||
                    this.workerState === 'BUILDING_IN_PLACE' ||
                    this.workerState === 'HEALING' ||
                    this.workerState === 'RESEARCHING'
                ) {
                    this.commandState = CMD_IDLE;
                }
            }
            // Workers still follow paths via the normal system
        }

        // State machine
        switch (this.commandState) {
            case CMD_IDLE: if (!this.workerState) this.doIdle(spd); break;
            case CMD_MOVING:
                this.tryDriveByAttack();
                this.doMoving(spd);
                break;
            case CMD_ATTACK_MOVING: this.doAttackMoving(spd); break;
            case CMD_ATTACKING: this.doAttacking(spd); break;
            case CMD_HOLDING:
                // Legacy state from older snapshots: hold is now a flag.
                this.holdPosition = true;
                this.commandState = CMD_IDLE;
                break;
        }
        // Movement must not accumulate five ticks of penetration before being
        // corrected. Resting units retain the configured staggered refresh.
        let movedThisTick = this.x !== this.prevX || this.y !== this.prevY;
        let collisionInterval = movedThisTick ? 1 : getUnitCollisionRecalcTicks();
        let hadUnitCollision = false;
        if (collisionInterval <= 1 || ((gameTime + this.id) % collisionInterval) === 0) {
            let selfCollisionR = this.getCollisionRadius();
            let crossTeamCollisionPadding = Math.max(0, Number(CROSS_TEAM_UNIT_COLLISION_PADDING) || 0);
            let sepRange = selfCollisionR * 2 + crossTeamCollisionPadding;
            let pushX = 0, pushY = 0, maxOverlap = 0;
            let myLayer = this.getCollisionLayer();
            // Pooled entries: this runs for every moving unit every tick.
            let collisionCandidates = _unitCollisionCandidates;
            let candidateCount = 0;
            // Same candidates as forEachUnitInRange(x, y, sepRange, ..., { pad: 0 })
            // (unit centers are bucketed per chunk, so chunks overlapping the
            // range circle hold every candidate), inlined: this runs for every
            // moving unit every tick.
            let wx = this.x, wy = this.y, radiusSq = sepRange * sepRange, cws = CHUNK_SIZE * TILE;
            let minCx = Math.max(0, Math.floor((wx - sepRange) / cws)), maxCx = Math.min(CHUNKS_W - 1, Math.floor((wx + sepRange) / cws));
            let minCy = Math.max(0, Math.floor((wy - sepRange) / cws)), maxCy = Math.min(CHUNKS_H - 1, Math.floor((wy + sepRange) / cws));
            for (let cy = minCy; cy <= maxCy; cy++) {
                let chunkMinY = cy * cws;
                let ny = wy < chunkMinY ? chunkMinY : (wy > chunkMinY + cws ? chunkMinY + cws : wy);
                for (let cx = minCx; cx <= maxCx; cx++) {
                    let chunk = spatialUnits[cy * CHUNKS_W + cx];
                    if (!chunk || chunk.length === 0) continue;
                    let chunkMinX = cx * cws;
                    let nx = wx < chunkMinX ? chunkMinX : (wx > chunkMinX + cws ? chunkMinX + cws : wx);
                    if ((wx - nx) * (wx - nx) + (wy - ny) * (wy - ny) > radiusSq) continue;
                    for (let k = 0; k < chunk.length; k++) {
                        let other = chunk[k];
                        if (other.dead || other === this) continue;
                        let dx = other.x - wx, dy = other.y - wy, d2 = dx * dx + dy * dy;
                        if (d2 > radiusSq) continue;
                        // getCollisionLayer() / getCollisionRadius(), inlined.
                        let otherLayer = other.isFlying ? 'air' : (other.unitType === 'mole' ? 'mole' : 'ground');
                        if (otherLayer !== myLayer) continue;
                        let otherR = +other.collisionR || +other.r || 0.1;
                        if (otherR < 0.1) otherR = 0.1;
                        let collisionPadding = other.owner === this.owner ? 0 : crossTeamCollisionPadding;
                        let minDist = selfCollisionR + otherR + collisionPadding;
                        if (d2 >= minDist * minDist) continue;
                        let entry = collisionCandidates[candidateCount] || (collisionCandidates[candidateCount] = {});
                        entry.other = other; entry.d2 = d2; entry.dx = dx; entry.dy = dy; entry.minDist = minDist;
                        entry.order = Math.floor(Number(other.id) || 0);
                        // Insertion sort by unit id (unique), independent of bucket order.
                        let i = candidateCount++;
                        while (i > 0 && collisionCandidates[i - 1].order > entry.order) {
                            collisionCandidates[i] = collisionCandidates[i - 1];
                            i--;
                        }
                        collisionCandidates[i] = entry;
                    }
                }
            }
            for (let c = 0; c < candidateCount; c++) {
                let entry = collisionCandidates[c];
                let other = entry.other;
                let dx = -entry.dx;
                let dy = -entry.dy;
                let d = Math.sqrt(Math.max(0, entry.d2));
                let minDist = entry.minDist;
                if (d < minDist) {
                    hadUnitCollision = true;
                    maxOverlap = Math.max(maxOverlap, minDist - d);
                    let nx = 0, ny = 0;
                    if (d > 0.001) {
                        nx = dx / d;
                        ny = dy / d;
                    } else {
                        // Exact overlap fallback: split the pair deterministically so
                        // same-direction air units do not keep shoving in lockstep.
                        let mdx = this.vx, mdy = this.vy;
                        if (Math.hypot(mdx, mdy) < 0.001 && this.path && this.pathIndex < this.path.length) {
                            let pn = this.path[this.pathIndex];
                            mdx = pn.x * TILE + 16 - this.x;
                            mdy = pn.y * TILE + 16 - this.y;
                        }
                        let pairSign = ((Number(this.id) || 0) < (Number(other && other.id) || 0)) ? -1 : 1;
                        if (Math.abs(mdx) >= Math.abs(mdy)) {
                            nx = 0;
                            ny = (mdx >= 0 ? -1 : 1) * pairSign;
                        } else {
                            nx = (mdy >= 0 ? 1 : -1) * pairSign;
                            ny = 0;
                        }
                    }
                    let force = (minDist - Math.max(d, 0.001)) * 0.6;
                    pushX += nx * force;
                    pushY += ny * force;
                }
                entry.other = null;
            }
            if (pushX !== 0 || pushY !== 0) {
                applyUnitSeparation(this, pushX, pushY, maxOverlap);
            }
        }
        if (hadUnitCollision && this.pathIsFallbackAstar && this._pendingPathTarget) {
            _tryUpgradeAstarFallbackPath(this);
        }
        pushUnitOutOfBlockedTile(this);
        this.x = _quantizeUnitWorldCoord(this.x);
        this.y = _quantizeUnitWorldCoord(this.y);
        updateUnitSpatial(this);
    }

    doIdle(spd) {
        if (this.unitType === 'scout') {
            this.pickScoutDestination();
            return;
        }
        // Auto-aggro nearby enemies
        let aggroRange = Math.max(TILE, this.preComputed.visionRange * TILE);
        let closest = _findClosestEnemyUnitByChunks(this.owner, this.x, this.y, aggroRange);
        if (closest) {
            this.targetUnit = closest;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
            return;
        }
        // An engagement during attack-move ended: continue the attack-move
        // (which also engages structures on the way). Routed by the budgeted
        // tick-start resolver, together with units resuming to the same tile.
        if (this._attackMoveGx != null && !this.holdPosition && !this.workerState) {
            let gx = this._attackMoveGx, gy = this._attackMoveGy;
            this.targetPos = { x: gx * TILE + 16, y: gy * TILE + 16 };
            _makeFallbackPathForUnit(this, Math.floor(this.x / TILE), Math.floor(this.y / TILE), gx, gy, CMD_ATTACK_MOVING, 'ai_combat');
            return;
        }
        // Structures do not move; a staggered quarter of the ticks suffices.
        if (((gameTime + this.id) & 3) !== 0) return;
        let structure = _findAutoStructureTarget(this, aggroRange);
        if (structure) {
            this.targetBuilding = structure;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
        }
    }

    doMoving(spd) {
        let isNearIssuedTarget = () => {
            if (!(this.targetPos && Number.isFinite(this.targetPos.x) && Number.isFinite(this.targetPos.y))) return false;
            let tol = Math.max(8, Math.min(TILE, Math.floor((Number(spd) || 1) * 2)));
            return Math.hypot(Number(this.targetPos.x) - Number(this.x), Number(this.targetPos.y) - Number(this.y)) <= tol;
        };
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
                if (this.holdPosition) {
                    // Keep the destination until released.
                } else if (dist <= Math.max(4, spd)) {
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
            if ((!this.path || this.pathIndex >= this.path.length) && this._pendingPathTarget && this._pendingPathTarget.cmd === CMD_MOVING && isNearIssuedTarget()) {
                this._pendingPathTarget = null;
                this.pathIsFallbackAstar = false;
                this.targetPos = null;
                this.commandState = CMD_IDLE;
            }
            // Keep move command active while waiting for deferred pathfinding.
            return;
        }
        if (this.followPath(spd)) {
            if (this._pendingPathTarget && this._pendingPathTarget.cmd === CMD_MOVING) {
                this.path = null;
                if (isNearIssuedTarget()) {
                    this._pendingPathTarget = null;
                    this.pathIsFallbackAstar = false;
                    this.targetPos = null;
                    this.commandState = CMD_IDLE;
                }
                return;
            }
            this.commandState = CMD_IDLE;
            this.path = null;
            this.targetPos = null;
        }
    }

    tryDriveByAttack() {
        if (this.workerState || this.attackTimer > 0 || this.preComputed.attackDamage <= 0) return;
        let closest = null;
        let bestD2 = Infinity;
        // Use only simulation state. Pick by distance, then unit id, independent of
        // spatial bucket insertion order on different lockstep peers.
        forEachUnitInAreaRange(this.x, this.y, _getUnitAttackRangeArea(this), (enemy) => {
            if (!_isHostileThingVisibleToUnit(this, enemy) || !_isTargetWithinUnitAttackAreaRange(this, enemy)) return;
            let dx = enemy.x - this.x, dy = enemy.y - this.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < bestD2 || (d2 === bestD2 && (!closest || enemy.id < closest.id))) {
                closest = enemy;
                bestD2 = d2;
            }
        }, { enemyOfPlayer: this.owner, areaOnly: true });
        if (closest) { this._performAttackOnUnit(closest); return; }
        // Nothing hostile to hit on the way: shoot structures in reach,
        // turrets and traps on the route first (staggered by unit id).
        if (((gameTime + this.id) & 1) !== 0) return;
        let structure = _findHostileStructureInAttackRange(this);
        if (structure) this._performAttackOnBuilding(structure);
    }

    doAttackMoving(spd) {
        let isNearIssuedTarget = () => {
            if (!(this.targetPos && Number.isFinite(this.targetPos.x) && Number.isFinite(this.targetPos.y))) return false;
            let tol = Math.max(8, Math.min(TILE, Math.floor((Number(spd) || 1) * 2)));
            return Math.hypot(Number(this.targetPos.x) - Number(this.x), Number(this.targetPos.y) - Number(this.y)) <= tol;
        };
        // Check for nearby enemies first
        let aggroRange = Math.max(TILE, this.preComputed.visionRange * TILE);
        let closest = _findClosestEnemyUnitByChunks(this.owner, this.x, this.y, aggroRange);
        if (closest) {
            this.targetUnit = closest;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
            return;
        }
        // Structures do not move: scan for them on a staggered quarter of the
        // ticks (by unit id), which is plenty to react to buildings entering
        // aggro range. Enemy units above are still checked every tick.
        if (((gameTime + this.id) & 3) === 0) {
            let structure = _findAutoStructureTarget(this, aggroRange);
            if (structure) {
                this.targetBuilding = structure;
                this.forcedAttackTarget = false;
                this.commandState = CMD_ATTACKING;
                return;
            }
        }
        if ((!this.path || this.pathIndex >= this.path.length) && this._pendingPathTarget && this._pendingPathTarget.cmd === CMD_ATTACK_MOVING) {
            if (this.pathIsFallbackAstar) _tryUpgradeAstarFallbackPath(this);
            if ((!this.path || this.pathIndex >= this.path.length) && this._pendingPathTarget && this._pendingPathTarget.cmd === CMD_ATTACK_MOVING && isNearIssuedTarget()) {
                this._pendingPathTarget = null;
                this.pathIsFallbackAstar = false;
                this.targetPos = null;
                this._attackMoveGx = this._attackMoveGy = null;
                this.commandState = CMD_IDLE;
            }
            // Keep attack-move active while waiting for deferred pathfinding.
            return;
        }
        if (this.followPath(spd)) {
            if (this._pendingPathTarget && this._pendingPathTarget.cmd === CMD_ATTACK_MOVING) {
                this.path = null;
                if (isNearIssuedTarget()) {
                    this._pendingPathTarget = null;
                    this.pathIsFallbackAstar = false;
                    this.targetPos = null;
                    this._attackMoveGx = this._attackMoveGy = null;
                    this.commandState = CMD_IDLE;
                }
                return;
            }
            this._attackMoveGx = this._attackMoveGy = null;
            this.commandState = CMD_IDLE;
            this.path = null;
            this.targetPos = null;
        }
    }

    _performAttackOnUnit(target) {
        let attackCue = ['fire', 'water', 'ice', 'poison', 'laser'].includes(this.attackStyle) ? 'attack_cast' : 'attack_swing';
        playSound(attackCue, this.x, this.y, this.unitType);
        let targetEnergyBefore = target.energy;
        target.energy -= this.preComputed.attackDamage;
        pushHostileDamageAlert(target, targetEnergyBefore - target.energy, this.owner);
        recordDamageVisual(target, targetEnergyBefore - target.energy, this.owner);
        if (targetEnergyBefore > target.energy) playSound('melee_hit', target.x, target.y, this.unitType);
        tryAutoRetaliateOnHostileDamage(target, this, this.x, this.y);
        this.attackTimer = this.preComputed.attackCooldown;
        this.attackTarget = target;
        this.attackFlash = 8;
        let style = this.attackStyle;
        if (style === 'fire') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#f50', 3);
            target.burning = Math.max(target.burning, 45);
            target.burnTickDamage = Math.max(target.burnTickDamage, this.preComputed.attackDamage * 0.04);
        } else if (style === 'water') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#4af', 3);
            target.wet = Math.max(target.wet, 60);
        } else if (style === 'ice') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#afe', 3);
            target.frozen = Math.max(target.frozen, 40);
        } else if (style === 'poison') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#2d2', 3);
            target.poisoned = Math.max(target.poisoned, 50);
            target.poisonTickDamage = Math.max(target.poisonTickDamage, this.preComputed.attackDamage * 0.04);
        } else if (style === 'laser') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#f0f', 2);
        } else if (style === 'swoop') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#dd0', 2);
            if (this.unitType === 'scout') applyStatusEffect(target, 'watch', getUnitEffectiveLevel(this), 0, this.owner, this.unitType);
        } else if (style === 'ram') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#0f0', 3);
            createDirectedParticles(target.x, target.y, this.x, this.y, '#f00', 2);
            this.energy -= this.preComputed.maxEnergy * 0.03;
            if (this.energy <= 0) { this.dead = true; }
        } else {
            // Default melee
            createDirectedParticles(this.x, this.y, target.x, target.y, '#f88', 2);
        }
        if (target.energy <= 0) { target.dead = true; return true; }
        return false;
    }

    _performAttackOnBuilding(tb) {
        let attackCue = ['fire', 'water', 'ice', 'poison', 'laser'].includes(this.attackStyle) ? 'attack_cast' : 'attack_swing';
        playSound(attackCue, this.x, this.y, this.unitType);
        let buildingEnergyBefore = tb.energy;
        this.attackTimer = this.preComputed.attackCooldown;
        this.attackTarget = tb;
        this.attackFlash = 8;
        let style = this.attackStyle;
        if (style === 'fire') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#f50', 3);
            applyStatusEffect(tb, 'fire', getUnitBaseLevel(this), this.preComputed.attackDamage * 0.04);
            if (!isEffectImmune(tb, 'fire')) tb.energy -= this.preComputed.attackDamage;
        } else if (style === 'water') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#4af', 3);
            applyStatusEffect(tb, 'water', getUnitBaseLevel(this));
            if (!isEffectImmune(tb, 'water')) tb.energy -= this.preComputed.attackDamage;
        } else if (style === 'ice') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#afe', 3);
            applyStatusEffect(tb, 'ice', getUnitBaseLevel(this), this.preComputed.attackDamage * 0.2);
            if (!isEffectImmune(tb, 'ice')) tb.energy -= this.preComputed.attackDamage;
        } else if (style === 'poison') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#2d2', 3);
            applyStatusEffect(tb, 'poison', getUnitBaseLevel(this), this.preComputed.attackDamage * 0.04);
            if (!isEffectImmune(tb, 'poison')) tb.energy -= this.preComputed.attackDamage;
        } else if (style === 'laser') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#f0f', 2);
            tb.energy -= this.preComputed.attackDamage;
        } else if (style === 'swoop') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#dd0', 2);
            if (this.unitType === 'scout') applyStatusEffect(tb, 'watch', getUnitEffectiveLevel(this), 0, this.owner, this.unitType);
            tb.energy -= this.preComputed.attackDamage;
        } else if (style === 'ram') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#0f0', 3);
            createDirectedParticles(tb.x, tb.y, this.x, this.y, '#f00', 2);
            tb.energy -= this.preComputed.attackDamage;
            this.energy -= this.preComputed.maxEnergy * 0.03;
            if (this.energy <= 0) { this.dead = true; }
        } else {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#f88', 2);
            tb.energy -= this.preComputed.attackDamage;
        }
        pushHostileDamageAlert(tb, buildingEnergyBefore - tb.energy, this.owner);
        recordDamageVisual(tb, buildingEnergyBefore - tb.energy, this.owner);
        if (buildingEnergyBefore > tb.energy) playSound('melee_hit', tb.x, tb.y, this.unitType);
        if (tb.energy <= 0) { destroyBuilding(tb); return true; }
        return false;
    }

    doAttacking(spd) {
        // Automatic structure attacks yield to nearby units. Explicit player
        // targets remain locked, and the scan is staggered by simulation tick.
        if (this.targetBuilding && !this.forcedAttackTarget && (gameTime + this.id) % 8 === 0) {
            let enemy = _findNearbyCombatEnemy(this,
                Math.max(TILE, this.preComputed.visionRange * TILE));
            if (enemy) {
                this.targetBuilding = null;
                this.targetUnit = enemy;
                this.attackTarget = null;
                this.path = null;
                this.pathIndex = 0;
                this._pendingPathTarget = null;
            }
        }
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
                        if (_canUsePathfindRequestBudget(this.owner, this)) {
                            _consumePathfindRequestBudget(this.owner, this);
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
            if (_isTargetWithinUnitAttackAreaRange(this, this.targetUnit)) {
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
            } else if (this.holdPosition) {
                // Held: keep the chosen target (attacked as soon as it is in
                // range) but never chase it; fight whatever is in range.
                this.attackTarget = null;
                this.doHolding();
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
                    if (_canUsePathfindRequestBudget(this.owner, this)) {
                        _consumePathfindRequestBudget(this.owner, this);
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
            if (tb.energy <= 0 || !_isHostileThingVisibleToUnit(this, tb)) { this.targetBuilding = null; this.attackTarget = null; this.forcedAttackTarget = false; this.commandState = CMD_IDLE; return; }
            let d = Math.hypot(tb.x - this.x, tb.y - this.y);
            if (_isTargetWithinUnitAttackAreaRange(this, tb)) {
                this.attackTarget = tb;
                this.path = null;
                if (this.attackTimer <= 0) {
                    if (this._performAttackOnBuilding(tb)) {
                        this.targetBuilding = null; this.attackTarget = null; this.forcedAttackTarget = false; this.commandState = CMD_IDLE;
                    }
                }
            } else if (this.holdPosition) {
                this.attackTarget = null;
                this.doHolding();
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
                    if (_canUsePathfindRequestBudget(this.owner, this)) {
                        _consumePathfindRequestBudget(this.owner, this);
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
        if (this.attackTimer > 0 || this.preComputed.attackDamage <= 0) return;
        let closest = null, bestD2 = Infinity;
        forEachUnitInAreaRange(this.x, this.y, _getUnitAttackRangeArea(this), (enemy) => {
            if (!_isHostileThingVisibleToUnit(this, enemy) || !_isTargetWithinUnitAttackAreaRange(this, enemy)) return;
            let dx = enemy.x - this.x, dy = enemy.y - this.y, d2 = dx * dx + dy * dy;
            if (d2 < bestD2 || (d2 === bestD2 && (!closest || enemy.id < closest.id))) {
                closest = enemy; bestD2 = d2;
            }
        }, { enemyOfPlayer: this.owner, areaOnly: true });
        if (closest) { this._performAttackOnUnit(closest); return; }

        // Hold uses the same attack area as combat, but never enters the
        // chasing state. Structures by the same threat order as attack move.
        let structure = _findHostileStructureInAttackRange(this);
        if (structure) this._performAttackOnBuilding(structure);
    }

    followPath(spd) {
        if (!this.path || this.pathIndex >= this.path.length) return true;
        // Held units keep their route (and its progress) until released.
        if (this.holdPosition) return false;

        // Treat the shared route as a corridor. A roomy node is reached from
        // anywhere in its open 3x3 block, so crowds may flow beside the exact
        // tiles; tight nodes still need their own tile. The window is short
        // and also rejoins units that separation pushed past a waypoint.
        let tileX = Math.floor(this.x / TILE), tileY = Math.floor(this.y / TILE);
        let first = Math.max(0, this.pathIndex - 1);
        let limit = Math.min(this.path.length - 1, this.pathIndex + 6);
        let reached = -1;
        for (let i = first; i <= limit; i++) {
            let node = this.path[i], next = this.path[i + 1];
            let dx = node.x - tileX, dy = node.y - tileY;
            // Portal entrances are consumed on their exact tile below.
            if (next && Math.abs(next.x - node.x) + Math.abs(next.y - node.y) !== 1) {
                if (dx === 0 && dy === 0) reached = i - 1;
                break;
            }
            if ((dx === 0 && dy === 0) ||
                (dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1 && _isPathNodeRoomy(this.path, i))) reached = i;
        }
        while (this.pathIndex <= reached) {
            if (this.pathIndex > 0 && !_tryConsumeAstarMoveCostForTransition(
                this, this.path[this.pathIndex - 1], this.path[this.pathIndex])) return false;
            this.pathIndex++;
        }
        if (this.pathIndex >= this.path.length) return true;

        // Consume stale nodes first so we never steer back toward an already-reached tile center.
        while (this.path && this.pathIndex < this.path.length) {
            let curNode = this.path[this.pathIndex];
            let ugx = Math.floor(this.x / TILE), ugy = Math.floor(this.y / TILE);
            if (curNode.x !== ugx || curNode.y !== ugy) break;

            let nextNodeInTile = this.path[this.pathIndex + 1];
            if (nextNodeInTile && isCloudPortalLink(curNode.x, curNode.y, nextNodeInTile.x, nextNodeInTile.y, this.owner)) {
                if (!_tryConsumeAstarMoveCostForTransition(this, curNode, nextNodeInTile)) return false;
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
                if (this.pathIndex > 0) {
                    let prevNodeForCost = this.path[this.pathIndex - 1] || null;
                    if (!_tryConsumeAstarMoveCostForTransition(this, prevNodeForCost, curNode)) return false;
                }
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
            let ugx = Math.floor(this.x / TILE);
            let ugy = Math.floor(this.y / TILE);
            if (node.x !== ugx) segDx = node.x - ugx;
            else if (node.y !== ugy) segDy = node.y - ugy;
            else if (this.pathIndex + 1 < this.path.length) {
                let nextNodeForFallback = this.path[this.pathIndex + 1];
                segDx = nextNodeForFallback.x - node.x;
                segDy = nextNodeForFallback.y - node.y;
            } else {
                segDx = 1;
            }
        }

        let prevNode = this.pathIndex > 0 ? this.path[this.pathIndex - 1] : null;
        if (prevNode && Math.abs(prevNode.x - Math.floor(this.x / TILE)) <= 1 &&
            Math.abs(prevNode.y - Math.floor(this.y / TILE)) <= 1 &&
            _isPathNodeRoomy(this.path, this.pathIndex - 1) && _isPathNodeRoomy(this.path, this.pathIndex)) {
            // Inside the corridor: keep the unit's current side offset from
            // the route instead of converging every unit onto one point. Both
            // adjacent 3x3 blocks are open, and the clamped target stays in
            // them, so this straight segment cannot cut through a wall.
            let ahead = this.path[this.pathIndex + 1], far = this.path[this.pathIndex + 2];
            if (far && Math.abs(far.x - ahead.x) + Math.abs(far.y - ahead.y) === 1) ahead = far;
            let routeDx = ahead.x - prevNode.x, routeDy = ahead.y - prevNode.y;
            let routeLen = Math.sqrt(routeDx * routeDx + routeDy * routeDy);
            let sideX = -routeDy / routeLen, sideY = routeDx / routeLen;
            // Drift gently back towards the exact route while there is no push.
            let side = ((this.x - baseTx) * sideX + (this.y - baseTy) * sideY) * 0.875;
            let maxSide = TILE * 0.8;
            side = side > maxSide ? maxSide : (side < -maxSide ? -maxSide : side);
            tx += sideX * side;
            ty += sideY * side;
        } else if (Math.abs(segDx) >= Math.abs(segDy)) {
            // Directional lane rule:
            // horizontal: left -> below center, right -> above center
            // vertical: up -> left of center, down -> right of center
            ty += (segDx < 0 ? laneOffset : -laneOffset);
        } else {
            tx += (segDy < 0 ? -laneOffset : laneOffset);
        }
        let dx = tx - this.x, dy = ty - this.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 4) {
            let nextNode = this.path[this.pathIndex + 1];
            if (nextNode && isCloudPortalLink(node.x, node.y, nextNode.x, nextNode.y, this.owner)) {
                if (!_tryConsumeAstarMoveCostForTransition(this, node, nextNode)) return false;
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
            if (this.pathIndex > 0) {
                let prevNodeForCost = this.path[this.pathIndex - 1] || null;
                if (!_tryConsumeAstarMoveCostForTransition(this, prevNodeForCost, node)) return false;
            }
            this.pathIndex++;
            if (this.pathIndex >= this.path.length) return true;
            return false;
        }
        this.vx = (dx / dist) * spd; this.vy = (dy / dist) * spd;
        this.x += this.vx; this.y += this.vy;
        return false;
    }

    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
        if (this.dead || this.teleportHideTicks > 0) return;
        // Unit body
        let strokeColor = (this.owner >= 0) ? get2DRenderOwnerColor(this.owner) : '#000';
        let lw = 1;
        if (this.burning > 0) strokeColor = '#f50';
        else if (this.poisoned > 0) strokeColor = '#2d2';
        else if (this.frozen > 0 && this.wet > 0) strokeColor = '#fff';
        else if (this.frozen > 0) strokeColor = '#afe';
        else if (this.wet > 0) strokeColor = '#4af';
        if (this.burning > 0 || this.poisoned > 0 || this.frozen > 0 || this.wet > 0) lw = 1.5;

        drawCachedUnitBody(ctx, this, strokeColor, lw);

        // Owner dot removed in favor of colored outline

        // Energy bar
        if (this.energy < this.preComputed.maxEnergy) {
            let bw = this.r * 2 + 4, bh = 2, bx = this.x - bw / 2, by = this.y - this.r - 7;
            ctx.fillStyle = '#600'; ctx.fillRect(bx, by, bw, bh);
            ctx.fillStyle = '#0f0'; ctx.fillRect(bx, by, bw * Math.max(0, this.energy / this.preComputed.maxEnergy), bh);
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
        !unit.holdPosition &&
        unit.commandState === CMD_IDLE &&
        Number(unit.preComputed && unit.preComputed.attackDamage) > 0 &&
        Number(unit.preComputed && unit.preComputed.attackRangeArea) > 0
    );
}

function _issueRetaliationPath(unit, targetGx, targetGy, forcedAttackTarget) {
    let ugx = Math.floor(unit.x / TILE), ugy = Math.floor(unit.y / TILE);
    let dest = findNearestWalkable(targetGx, targetGy, ugx, ugy, unit);
    let canWalk = (typeof getPathCanWalkForUnit === 'function') ? getPathCanWalkForUnit(unit) : null;
    unit.path = null;
    unit.pathIndex = 0;
    unit._pendingPathTarget = null;
    if (_canUsePathfindRequestBudget(unit.owner, unit)) {
        _consumePathfindRequestBudget(unit.owner, unit);
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
    let resourceCollectorCfg = getResourceTypeByCollectorUnit(u.unitType);
    if (resourceCollectorCfg) {
        u.workerState = 'IDLE';
        u.workerType = resourceCollectorCfg.collectorUnitKey;
        u.carryingValue = 0;
        _clearWorkerTarget(u);
        if (typeof _clearResourceCollectorTaskMemory === 'function') _clearResourceCollectorTaskMemory(u);
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
    let maxEnergyCaps = survivors.map(u => Math.max(1, Number(u.preComputed && u.preComputed.maxEnergy) || 1));
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

function applyUnitSeparation(unit, dx, dy, maxOverlap = unit.getCollisionRadius() * 2) {
    // Resolve crowded overlaps promptly, but never sum a hundred contacts into
    // a hundred-contact teleport. One correction is bounded by penetration.
    let total = Math.sqrt(dx * dx + dy * dy);
    let limit = Math.max(0, maxOverlap);
    if (total > limit) { dx *= limit / total; dy *= limit / total; }
    // Sweep large corrections, including enlarged units and enemy padding.
    // Axis sliding releases wall-side crowds without crossing a corner cap.
    let steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (TILE / 4)));
    let startX = unit.x, startY = unit.y;
    for (let i = 1; i <= steps; i++) {
        let x = _quantizeUnitWorldCoord(startX + dx * i / steps);
        let y = _quantizeUnitWorldCoord(startY + dy * i / steps);
        if (!unit.isFlying) {
            let gx = Math.floor(unit.x / TILE), gy = Math.floor(unit.y / TILE);
            let nx = Math.floor(x / TILE), ny = Math.floor(y / TILE);
            let sideX = canUnitOccupyTile(unit, nx, gy), sideY = canUnitOccupyTile(unit, gx, ny);
            if (!canUnitOccupyTile(unit, nx, ny) || (gx !== nx && gy !== ny && (!sideX || !sideY))) {
                if (sideX && nx !== gx) unit.x = x;
                else if (sideY && ny !== gy) unit.y = y;
                break;
            }
        }
        unit.x = x; unit.y = y;
    }
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
// Body geometry is shared by immediate drawing and the strategic sprite cache.
function drawUnitBodyGeometry(ctx, unit, strokeColor, lw) {
        if (unit.isSnake) {
            // Snakes render as their head only; the tail was removed.
            ctx.save();
            ctx.fillStyle = strokeColor;
            ctx.beginPath(); ctx.arc(unit.x, unit.y, unit.r + 1.5, 0, 6.28); ctx.fill();
            ctx.fillStyle = unit.color;
            ctx.beginPath(); ctx.arc(unit.x, unit.y, unit.r, 0, 6.28); ctx.fill();
            ctx.fillStyle = "black";
            ctx.beginPath(); ctx.arc(unit.x - 2, unit.y - 2, 1.5, 0, 6.28); ctx.fill();
            ctx.beginPath(); ctx.arc(unit.x + 2, unit.y - 2, 1.5, 0, 6.28); ctx.fill();
            ctx.restore();
        } else if (unit.vis === 'triangle') {
            ctx.fillStyle = unit.color; ctx.beginPath();
            let tr = unit.r * 0.5;
            ctx.moveTo(unit.x, unit.y + tr); ctx.lineTo(unit.x - tr, unit.y - tr); ctx.lineTo(unit.x + tr, unit.y - tr);
            ctx.closePath(); ctx.fill(); ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
        } else if (unit.vis === 'star') {
            if (unit.unitType === 'collector' || unit.unitType === 'astar_collector') {
                ctx.save();
                // Outline circle
                ctx.strokeStyle = strokeColor; ctx.lineWidth = lw;
                ctx.beginPath(); ctx.arc(unit.x, unit.y, unit.r, 0, 6.28); ctx.stroke();
                ctx.font = `${Math.round(unit.r * 2.4)}px Arial`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = unit.unitType === 'collector' ? '#ffd34d' : (unit.carryingValue > 0 ? '#f4f4f4' : '#9aa0a6');
                ctx.fillText(unit.unitType === 'collector' ? '⚡' : (unit.carryingValue > 0 ? '★' : '☆'), unit.x, unit.y + 1);
                ctx.restore();
            } else {
                drawCachedUnitStar(ctx, unit.x, unit.y, unit.r, unit.color, strokeColor, lw);
            }
        } else if (unit.vis === 'triangle_down') {
            ctx.fillStyle = unit.color; ctx.beginPath();
            let tr = unit.r;
            ctx.moveTo(unit.x, unit.y + tr); ctx.lineTo(unit.x - tr, unit.y - tr * 0.5); ctx.lineTo(unit.x + tr, unit.y - tr * 0.5);
            ctx.closePath(); ctx.fill(); ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
        } else if (unit.vis === 'mole') {
            ctx.fillStyle = unit.color; ctx.beginPath();
            ctx.ellipse(unit.x, unit.y, unit.r * 0.8, unit.r * 1.1, 0, 0, Math.PI * 2);
            ctx.fill(); ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
        } else if (unit.vis === 'rect') {
            let rr = unit.r;
            ctx.fillStyle = unit.color; ctx.fillRect(unit.x - rr, unit.y - rr * 0.7, rr * 2, rr * 1.4);
            ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.strokeRect(unit.x - rr, unit.y - rr * 0.7, rr * 2, rr * 1.4);
            if (unit.unitType === 'researcher_unit') {
                ctx.fillStyle = '#5af';
                ctx.fillRect(unit.x - rr * 0.3, unit.y - rr * 0.35, rr * 0.6, rr * 0.7);
                ctx.strokeStyle = '#93f';
                ctx.lineWidth = Math.max(1, lw * 0.8);
                ctx.strokeRect(unit.x - rr * 0.3, unit.y - rr * 0.35, rr * 0.6, rr * 0.7);
            }
        } else if (unit.vis === 'king') {
            let rr = unit.r;
            // Crown shape
            ctx.fillStyle = unit.color; ctx.beginPath();
            ctx.moveTo(unit.x - rr, unit.y + rr * 0.4);
            ctx.lineTo(unit.x - rr, unit.y - rr * 0.2);
            ctx.lineTo(unit.x - rr * 0.5, unit.y + rr * 0.1);
            ctx.lineTo(unit.x, unit.y - rr * 0.7);
            ctx.lineTo(unit.x + rr * 0.5, unit.y + rr * 0.1);
            ctx.lineTo(unit.x + rr, unit.y - rr * 0.2);
            ctx.lineTo(unit.x + rr, unit.y + rr * 0.4);
            ctx.closePath(); ctx.fill();
            ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
            // Jewel dots on crown tips
            ctx.fillStyle = '#f00';
            ctx.beginPath(); ctx.arc(unit.x - rr, unit.y - rr * 0.2, 1.5, 0, 6.28); ctx.fill();
            ctx.beginPath(); ctx.arc(unit.x, unit.y - rr * 0.7, 1.5, 0, 6.28); ctx.fill();
            ctx.beginPath(); ctx.arc(unit.x + rr, unit.y - rr * 0.2, 1.5, 0, 6.28); ctx.fill();
        } else {
            ctx.fillStyle = unit.color; ctx.beginPath(); ctx.arc(unit.x, unit.y, unit.r, 0, 6.28); ctx.fill();
            ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
        }

}
