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

// Structures do not move, and liveness and owner are checked at query time:
// the buckets only change with the tile entity index (not every tick).
function _getHostileStructureIndex(list) {
    const tick = typeof _tileEntityVersion === 'number' ? _tileEntityVersion : (typeof gameTime === 'number' ? gameTime : 0);
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

// Conservative beam rectangle; Tower.update retains the exact hit/owner/health
// tests. Sort by the original ID comparator and original array order for ties,
// since bucket traversal order must never affect damage or destruction order.
function getLaserStructureCandidates(list, sx, sy, ex, ey) {
    let index = _getHostileStructureIndex(list);
    let stride = Math.ceil(GRID_W / 4) + 1;
    let minX = Math.max(0, Math.floor((Math.min(sx, ex) - 18) / index.size));
    let maxX = Math.min(Math.ceil(GRID_W / 4), Math.floor((Math.max(sx, ex) + 18) / index.size));
    let minY = Math.max(0, Math.floor((Math.min(sy, ey) - 18) / index.size));
    let maxY = Math.min(Math.ceil(GRID_H / 4), Math.floor((Math.max(sy, ey) + 18) / index.size));
    let entries = [];
    for (let by = minY; by <= maxY; by++) for (let bx = minX; bx <= maxX; bx++) {
        let bucket = index.buckets.get(by * stride + bx);
        if (bucket) for (let entry of bucket) entries.push(entry);
    }
    entries.sort((a, b) => ((a.target.id || 0) - (b.target.id || 0)) || a.order - b.order);
    return entries.map(entry => entry.target);
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
            let distance = detHypot(dx, dy);
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
    return _isTileBlockOpen(node.x, node.y);
}

// Whether a tile's whole 3x3 block is open terrain, cached per tile until
// the topology changes (0 unknown, 1 open, 2 not): moving units ask every
// tick.
let _tileBlockOpen = null, _tileBlockOpenVer = -1;
function _isTileBlockOpen(x, y) {
    if (x < 1 || y < 1 || x >= GRID_W - 1 || y >= GRID_H - 1) return false;
    if (_tileBlockOpenVer !== pathTopologyVersion || !_tileBlockOpen || _tileBlockOpen.length !== GRID_W * GRID_H) {
        if (!_tileBlockOpen || _tileBlockOpen.length !== GRID_W * GRID_H) _tileBlockOpen = new Uint8Array(GRID_W * GRID_H);
        else _tileBlockOpen.fill(0);
        _tileBlockOpenVer = pathTopologyVersion;
    }
    let k = y * GRID_W + x, v = _tileBlockOpen[k];
    if (v) return v === 1;
    let open = true;
    for (let gy = y - 1; gy <= y + 1 && open; gy++) {
        let row = grid[gy];
        if (row[x - 1].type === TYPE_WALL || row[x].type === TYPE_WALL || row[x + 1].type === TYPE_WALL) open = false;
    }
    _tileBlockOpen[k] = open ? 1 : 2;
    return open;
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
    let range = Math.floor(_getUnitAttackRangeArea(unit));
    // Nothing hostile anywhere in the areas in reach: done (O(1)).
    let box = getAreaRangeTileBox(sources, range);
    if (!hasHostileStructureInTileRect(unit.owner, box[0], box[1], box[2], box[3])) return null;
    let structuresByArea = getStructuresByArea();
    for (let areaId of getAreaIdsWithinDistanceOfSources(sources, range)) {
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
        let d = detHypot(item.x - unit.x, item.y - unit.y);
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

// Whether any enemy unit or hostile structure may be within `steps` area
// steps of `area` (conservative: whole blocks and area boxes), for `owner`.
// Cached for the tick: units of a crowd share their areas. A unit's +-0.3
// tile window reaches at most one area further than its own, which callers
// add to `steps`.
let _hostileNearCache = new Map(), _hostileNearCacheTick = -1, _hostileNearCacheFor = null;
const _hostileNearSource = [0];
function _hostilesPossibleNearArea(owner, area, steps) {
    if (!(area >= 0)) return true;
    if (_hostileNearCacheTick !== gameTime || _hostileNearCacheFor !== areaIdsWithinDistance) {
        _hostileNearCache.clear(); _hostileNearCacheTick = gameTime; _hostileNearCacheFor = areaIdsWithinDistance;
    }
    if (steps > 63) steps = 63;
    let key = (area * 64 + steps) * 64 + (owner & 63);
    let hit = _hostileNearCache.get(key);
    if (hit !== undefined) return hit;
    _hostileNearSource[0] = area;
    let box = getAreaRangeTileBox(_hostileNearSource, steps), cs = CHUNK_SIZE;
    let possible = box[2] >= 0 && (_regionMayHaveEnemyUnits(owner, Math.floor(box[0] / cs), Math.floor(box[1] / cs), Math.floor(box[2] / cs), Math.floor(box[3] / cs))
        || hasHostileStructureInTileRect(owner, box[0], box[1], box[2], box[3]));
    _hostileNearCache.set(key, possible);
    return possible;
}

function _quantizeUnitWorldCoord(value) {
    let n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * UNIT_POSITION_QUANTIZATION) / UNIT_POSITION_QUANTIZATION;
}

function _getUnitAttackRangeArea(unit) {
    return Math.max(0, Number(unit && unit.preComputed && unit.preComputed.attackRangeArea) || 0);
}

// Extra reach, beyond the collision distance, at which bodies count as touching.
const UNIT_CONTACT_ATTACK_MARGIN = TILE * 0.25;

// (The target at (tx, ty): by default where it is.)
function _isTargetWithinUnitAttackAreaRange(unit, target, tx = target && target.x, ty = target && target.y) {
    if (!unit || !target) return false;
    let rangeArea = Math.max(0, Number(_getUnitAttackRangeArea(unit)) || 0);
    if (isWorldTargetWithinAreaRange(unit.x, unit.y, tx, ty, Math.floor(rangeArea))) return true;
    return _isUnitTargetInContactAt(unit, target, tx, ty, Math.floor(rangeArea) + 1);
}

// Where another unit is during the unit pass: its position at the pass's
// start (x0, y0), whatever it has done since. Every unit's decisions read
// others there, so they do not depend on who went first; and the kernels
// (which run before the pass) decide exactly as Unit.update would.
function _unitTickX(t) { const c = t._us; return c ? c.x0[t._si] : t.x; }
function _unitTickY(t) { const c = t._us; return c ? c.y0[t._si] : t.y; }

// A hostile unit pressed against this one, one area step beyond its range.
// Cross-team collision keeps enemy bodies apart, so an attacker whose target
// stands just across an area border could otherwise never close in: it
// chased forever without striking. Touching also needs neighboring tiles
// with no wall corner between them. Callers check visibility separately.
function _isUnitTargetInContact(unit, target, maxAreaDistance) {
    return target instanceof Unit && _isUnitTargetInContactAt(unit, target, target.x, target.y, maxAreaDistance);
}
function _isUnitTargetInContactAt(unit, target, tx, ty, maxAreaDistance) {
    if (!(target instanceof Unit) || target.dead || !(unit.preComputed.attackDamage > 0)) return false;
    let dx = tx - unit.x, dy = ty - unit.y;
    let reach = unit.getCollisionRadius() + target.getCollisionRadius()
        + Math.max(0, Number(CROSS_TEAM_UNIT_COLLISION_PADDING) || 0) + UNIT_CONTACT_ATTACK_MARGIN;
    if (dx * dx + dy * dy > reach * reach) return false;
    let ugx = Math.floor(unit.x / TILE), ugy = Math.floor(unit.y / TILE);
    let tgx = Math.floor(tx / TILE), tgy = Math.floor(ty / TILE);
    let sx = tgx - ugx, sy = tgy - ugy;
    if (Math.abs(sx) > 1 || Math.abs(sy) > 1) return false;
    if (sx !== 0 && sy !== 0) {
        let side1 = grid[ugy] && grid[ugy][tgx], side2 = grid[tgy] && grid[tgy][ugx];
        if ((!side1 || side1.type === TYPE_WALL) && (!side2 || side2.type === TYPE_WALL)) return false;
    }
    return isWorldTargetWithinAreaRange(unit.x, unit.y, tx, ty, maxAreaDistance);
}

// V8 marks a field that no object of a shape has rewritten as constant;
// the first rewrite (say, the first move order setting _pendingPathTarget)
// then gives every unit a new shape, and each of the next hundred thousand
// unit reads migrates its object (about 10 us each: a stall of a second).
// The first unit rewrites each of its fields (then restores them), so the
// shape's fields are all mutable and general from the start.
let _unitFieldsMutable = false;
function _makeUnitFieldsMutable(u) {
    _unitFieldsMutable = true;
    // Every field also takes any kind of value (small integer, object,
    // fraction): a field holding only undefined that later gets an integer,
    // or an integer field a fraction, changes the shape the same way.
    for (const k of Object.keys(u)) {
        const v = u[k];
        u[k] = 1; u[k] = _UNIT_FIELD_WIDEN; u[k] = 0.5; u[k] = v;
    }
}

// A plain object for widening unit reference fields (see the Unit constructor).
const _UNIT_FIELD_WIDEN = {};

// Largest unit collision radius in the current stats (the runtime config can
// edit them in place), re-read once per tick.
let _maxUnitCollisionRadiusCache = 0, _maxUnitCollisionRadiusTick = NaN;
function _maxUnitCollisionRadius() {
    if (_maxUnitCollisionRadiusTick !== gameTime) {
        let m = 0.1;
        for (let k in BASE_UNIT_STATS) {
            let st = BASE_UNIT_STATS[k];
            if (!st || typeof st !== 'object') continue;
            m = Math.max(m, Number(st.collisionR) || 0, Number(st.r) || 0);
        }
        _maxUnitCollisionRadiusCache = m;
        _maxUnitCollisionRadiusTick = gameTime;
    }
    return _maxUnitCollisionRadiusCache;
}

class Unit {
    constructor(unitType, owner, x, y) {
        simUnitStateAllocate(this);
        this.id = nextUnitId++;
        // Stats refreshed on its first tick (a snapshotted flag: the list of
        // such units is rebuilt from it after a restore).
        this._needsStatsInit = true;
        _noteNewUnitForStats(this);
        this.unitType = unitType;
        this.owner = owner;
        this.x = x; this.y = y;
        this.prevX = x; this.prevY = y;
        if (this._us) { this._us.x0[this._si] = x; this._us.y0[this._si] = y; }
        // followPath: inputs of the last completed node scan (a cache).
        this._fpPath = null; this._fpTile = -1; this._fpIdx = -1; this._fpVer = -1;
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
        // Reference fields that later hold units, buildings or plain objects
        // are widened here first (then reset): V8 otherwise widens them the
        // first time such a value arrives mid-match, e.g. the first hit of a
        // battle, and recompiles every function reading units - a stall of
        // tens of ms. Values and behaviour are unchanged.
        this.attackTarget = this; this.attackTarget = _UNIT_FIELD_WIDEN;
        this.attackTarget = null; // visual: current attack target for draw effects
        this.attackFlash = 0; // visual: flash timer for attack animation

        this.commandState = CMD_IDLE;
        this.targetUnit = this; this.targetUnit = _UNIT_FIELD_WIDEN; this.targetUnit = null;
        this.targetBuilding = this; this.targetBuilding = _UNIT_FIELD_WIDEN; this.targetBuilding = null;
        this.targetPos = this; this.targetPos = _UNIT_FIELD_WIDEN; this.targetPos = null;
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
        this._lastAppliedEffectiveLevel = undefined;
        this._floorTile = -1; this._removedNow = false; this._routeKey = null; this._routeEnd = -1; this._routeSegEnd = -1; this._pendingDueStamp = -1; this._okTile = -1; this._okVer = 0; this._okNodeTile = -1; this._okNodeVer = 0; this._thingStatsRefreshStamp = 0; this._effectiveStatsStamp = 0; this._statsVer = -1; this._navReady = 0; this._navLastD = -1; this._vsGen = 0; this._vsR = -1; this._vsA = -1; this._vsP1 = -1; this._vsP2 = -1; this._vsListId = -1;
        this.workerState = undefined; this.workerType = undefined; this.carryingValue = undefined; this.workerTarget = undefined;
        this.workerTargetType = undefined; this._workerReservedTileIndex = undefined; this._resourceCollectorMemory = undefined;
        this._collectorPinnedTarget = undefined; this._collectorPinnedTargetType = undefined; this._collectorLastGatherX = undefined;
        this._collectorLastGatherY = undefined; this._collectorLastGatherGx = undefined; this._collectorLastGatherGy = undefined;
        this._collectorLastGatherType = undefined; this._collectorNextSpawner = undefined; this._collectorLastDropoffSpawner = undefined;
        this._lastMineTarget = undefined; this._astarLastGatherX = undefined; this._astarLastGatherY = undefined;
        this._astarLastGatherGx = undefined; this._astarLastGatherGy = undefined; this._astarPinnedTarget = undefined;
        this._astarPinnedTargetType = undefined; this._astarNextSpawner = undefined; this._astarLastMineTarget = undefined;
        this._astarLastMineTargetType = undefined; this._lastIdleStateTime = undefined; this._workerNextIdleRetargetTick = undefined; this._idleFailVer = -1; this._idleFailUntil = 0;
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
        this._researcherTripCost = undefined; this._researcherMaterialReadyTick = undefined; this._damageFlashStart = 0;
        // Same meaning as unset (no flash); typed like the values set later
        // (see the widening note above): -0 is a fractional-kind zero.
        this._damageFlashUntil = 0; this._damageFlashStrength = -0; this._damageFlashColor = '';
        this._energyBlockedUntil = undefined; this._nextScoutRetargetTick = undefined; this._scoutTarget = undefined;
        this._levelTextLabel = undefined;
        this._collectorLastMoveTick = undefined; this._collectorNextRecheckTick = undefined; this._healerLastMoveTick = undefined;
        this._healerNextRecheckTick = undefined; this._researchLastMoveTick = undefined; this._researchNextRecheckTick = undefined;
        this.holdPosition = undefined; this._ambientSoundTicks = undefined;

        this._spatialKey = undefined; this._spatialAreaId = undefined; this._spatialTile = -1; this._spatialZone = -1; this._spatialOwner = -1; this._spatialEpoch = 0; this._r3d = undefined; this._r3dSig = undefined; this._r3dTex = undefined; this._visStill = undefined; this._rslot = undefined; this._awaitGroupPath = 0;
        if (!_unitFieldsMutable) _makeUnitFieldsMutable(this);
        // A snapshot restore writes every field itself (same order, so the
        // same layout) and indexes the unit afterwards.
        if (_snapUnitShellMode) return;
        applyUnitLevelScaling(this, 1);
        this.energy = this.preComputedEffective ? this.preComputedEffective.maxEnergy : this.energy;
        updateUnitSpatial(this);
    }

    get id() { return this._us ? this._us.id[this._si] : (this._det ? this._det.id : undefined); }
    set id(v) { if (this._us) this._us.id[this._si] = v; else if (this._det) this._det.id = v; else Object.defineProperty(this, 'id', { value: v, writable: true, enumerable: true, configurable: true }); }
    get owner() { return this._us ? this._us.owner[this._si] : (this._det ? this._det.owner : undefined); }
    set owner(v) { if (this._us) { this._us.owner[this._si] = v; this._us.mvOn[this._si] = 0; } else if (this._det) this._det.owner = v; else Object.defineProperty(this, 'owner', { value: v, writable: true, enumerable: true, configurable: true }); }
    get x() { return this._us ? this._us.x[this._si] : (this._det ? this._det.x : undefined); }
    set x(v) { if (this._us) this._us.x[this._si] = v; else if (this._det) this._det.x = v; else Object.defineProperty(this, 'x', { value: v, writable: true, enumerable: true, configurable: true }); }
    get y() { return this._us ? this._us.y[this._si] : (this._det ? this._det.y : undefined); }
    set y(v) { if (this._us) this._us.y[this._si] = v; else if (this._det) this._det.y = v; else Object.defineProperty(this, 'y', { value: v, writable: true, enumerable: true, configurable: true }); }
    get prevX() { return this._us ? this._us.prevX[this._si] : (this._det ? this._det.prevX : undefined); }
    set prevX(v) { if (this._us) this._us.prevX[this._si] = v; else if (this._det) this._det.prevX = v; else Object.defineProperty(this, 'prevX', { value: v, writable: true, enumerable: true, configurable: true }); }
    get prevY() { return this._us ? this._us.prevY[this._si] : (this._det ? this._det.prevY : undefined); }
    set prevY(v) { if (this._us) this._us.prevY[this._si] = v; else if (this._det) this._det.prevY = v; else Object.defineProperty(this, 'prevY', { value: v, writable: true, enumerable: true, configurable: true }); }
    get vx() { return this._us ? this._us.vx[this._si] : (this._det ? this._det.vx : undefined); }
    set vx(v) { if (this._us) this._us.vx[this._si] = v; else if (this._det) this._det.vx = v; else Object.defineProperty(this, 'vx', { value: v, writable: true, enumerable: true, configurable: true }); }
    get vy() { return this._us ? this._us.vy[this._si] : (this._det ? this._det.vy : undefined); }
    set vy(v) { if (this._us) this._us.vy[this._si] = v; else if (this._det) this._det.vy = v; else Object.defineProperty(this, 'vy', { value: v, writable: true, enumerable: true, configurable: true }); }
    get attackTimer() { return this._us ? this._us.attackTimer[this._si] : (this._det ? this._det.attackTimer : undefined); }
    set attackTimer(v) { if (this._us) this._us.attackTimer[this._si] = v; else if (this._det) this._det.attackTimer = v; else Object.defineProperty(this, 'attackTimer', { value: v, writable: true, enumerable: true, configurable: true }); }
    get attackFlash() { return this._us ? this._us.attackFlash[this._si] : (this._det ? this._det.attackFlash : undefined); }
    set attackFlash(v) { if (this._us) this._us.attackFlash[this._si] = v; else if (this._det) this._det.attackFlash = v; else Object.defineProperty(this, 'attackFlash', { value: v, writable: true, enumerable: true, configurable: true }); }
    get energy() { return this._us ? this._us.energy[this._si] : (this._det ? this._det.energy : undefined); }
    set energy(v) { if (this._us) this._us.energy[this._si] = v; else if (this._det) this._det.energy = v; else Object.defineProperty(this, 'energy', { value: v, writable: true, enumerable: true, configurable: true }); }
    get pathIndex() { return this._us ? this._us.pathIndex[this._si] : (this._det ? this._det.pathIndex : undefined); }
    set pathIndex(v) { if (this._us) { this._us.pathIndex[this._si] = v; this._us.mvOn[this._si] = 0; } else if (this._det) this._det.pathIndex = v; else Object.defineProperty(this, 'pathIndex', { value: v, writable: true, enumerable: true, configurable: true }); }
    get commandState() { return this._us ? this._us.commandState[this._si] : (this._det ? this._det.commandState : undefined); }
    set commandState(v) { if (this._us) { this._us.commandState[this._si] = v; this._us.mvOn[this._si] = 0; } else if (this._det) this._det.commandState = v; else Object.defineProperty(this, 'commandState', { value: v, writable: true, enumerable: true, configurable: true }); }
    // Spatial index and visibility registration (columns; see SIM_MOVE_COLUMNS).
    get _spatialTile() { const c = this._us; return c ? c.spTile[this._si] : -1; }
    set _spatialTile(v) { const c = this._us; if (c) c.spTile[this._si] = v; else if (c === undefined) Object.defineProperty(this, '_spatialTile', { value: v, writable: true, configurable: true }); }
    get _spatialAreaId() { const c = this._us; if (!c) return undefined; const v = c.spArea[this._si]; return v === -2 ? undefined : v; }
    set _spatialAreaId(v) { const c = this._us; if (c) c.spArea[this._si] = v === undefined ? -2 : v; else if (c === undefined) Object.defineProperty(this, '_spatialAreaId', { value: v, writable: true, configurable: true }); }
    get _spatialOwner() { const c = this._us; return c ? c.spOwner[this._si] : -1; }
    set _spatialOwner(v) { const c = this._us; if (c) c.spOwner[this._si] = v; else if (c === undefined) Object.defineProperty(this, '_spatialOwner', { value: v, writable: true, configurable: true }); }
    get _spatialEpoch() { const c = this._us; return c ? c.spEpoch[this._si] : 0; }
    set _spatialEpoch(v) { const c = this._us; if (c) c.spEpoch[this._si] = v; else if (c === undefined) Object.defineProperty(this, '_spatialEpoch', { value: v, writable: true, configurable: true }); }
    get _spatialZone() { const c = this._us; return c ? c.spZone[this._si] : -1; }
    set _spatialZone(v) { const c = this._us; if (c) c.spZone[this._si] = v; else if (c === undefined) Object.defineProperty(this, '_spatialZone', { value: v, writable: true, configurable: true }); }
    get _spatialUnitTypeIdx() { const c = this._us; if (!c) return undefined; const v = c.spType[this._si]; return v === -1 ? undefined : v; }
    set _spatialUnitTypeIdx(v) { const c = this._us; if (c) c.spType[this._si] = v === undefined ? -1 : v; else if (c === undefined) Object.defineProperty(this, '_spatialUnitTypeIdx', { value: v, writable: true, configurable: true }); }
    get _vsGen() { const c = this._us; return c ? c.vsGen[this._si] : 0; }
    set _vsGen(v) { const c = this._us; if (c) c.vsGen[this._si] = v; else if (c === undefined) Object.defineProperty(this, '_vsGen', { value: v, writable: true, configurable: true }); }
    get _vsR() { const c = this._us; return c ? c.vsR[this._si] : -1; }
    set _vsR(v) { const c = this._us; if (c) c.vsR[this._si] = v; else if (c === undefined) Object.defineProperty(this, '_vsR', { value: v, writable: true, configurable: true }); }
    get _vsA() { const c = this._us; return c ? c.vsA[this._si] : -1; }
    set _vsA(v) { const c = this._us; if (c) c.vsA[this._si] = v; else if (c === undefined) Object.defineProperty(this, '_vsA', { value: v, writable: true, configurable: true }); }
    get _vsP1() { const c = this._us; return c ? c.vsP1[this._si] : -1; }
    set _vsP1(v) { const c = this._us; if (c) c.vsP1[this._si] = v; else if (c === undefined) Object.defineProperty(this, '_vsP1', { value: v, writable: true, configurable: true }); }
    get _vsP2() { const c = this._us; return c ? c.vsP2[this._si] : -1; }
    set _vsP2(v) { const c = this._us; if (c) c.vsP2[this._si] = v; else if (c === undefined) Object.defineProperty(this, '_vsP2', { value: v, writable: true, configurable: true }); }
    get _spatialKey() { const c = this._us; if (!c) return undefined; const k = c.sepKey[this._si]; return k === SIM_SEP_ABSENT ? undefined : k; }
    set _spatialKey(v) { const c = this._us; if (c) c.sepKey[this._si] = v === undefined ? SIM_SEP_ABSENT : v; else if (c === undefined) Object.defineProperty(this, '_spatialKey', { value: v, writable: true, configurable: true }); }
    get _vsAreas() { const c = this._us; if (!c) return null; const id = c.vsList[this._si]; return id < 0 ? null : _sourceAreaListById[id]; }
    set _vsAreas(v) { const c = this._us; if (c) c.vsList[this._si] = v ? _sourceAreaListIdOf(v) : -1; else if (c === undefined) Object.defineProperty(this, '_vsAreas', { value: v, writable: true, configurable: true }); }
    get _vsListId() { const c = this._us; return c ? c.vsList[this._si] : -1; }
    set _vsListId(v) { const c = this._us; if (c) c.vsList[this._si] = v; }
    // Arriving in a crowd (see _followNavNode): a column (mvNavLD) the kernel shares.
    get _navLastD() { const c = this._us; return c ? c.mvNavLD[this._si] : (this._det ? this._det._navLastD : this._nld); }
    set _navLastD(v) { const c = this._us; if (c) c.mvNavLD[this._si] = v; else if (this._det) this._det._navLastD = v; else Object.defineProperty(this, '_nld', { value: v, writable: true, configurable: true }); }
    // Dead: a column (see SIM_MOVE_COLUMNS), true or false.
    get dead() { const c = this._us; return c ? c.dead[this._si] === 1 : (this._det ? this._det.dead === true : this._deadv === true); }
    set dead(v) {
        const c = this._us;
        if (c) c.dead[this._si] = v ? 1 : 0;
        else if (this._det) this._det.dead = !!v;
        else Object.defineProperty(this, '_deadv', { value: !!v, writable: true, configurable: true });
    }
    // A worker's state and its next idle search: plain values (non-enumerable
    // _ws, _wnr); a change wakes a parked worker (see simMoveTryPark).
    get workerState() { return this._ws; }
    set workerState(v) {
        const c = this._us;
        if (c === undefined) { Object.defineProperty(this, '_ws', { value: v, writable: true, configurable: true }); return; }
        this._ws = v;
        if (c) c.mvOn[this._si] = 0;
    }
    get _workerNextIdleRetargetTick() { return this._wnr; }
    set _workerNextIdleRetargetTick(v) {
        const c = this._us;
        if (c === undefined) { Object.defineProperty(this, '_wnr', { value: v, writable: true, configurable: true }); return; }
        this._wnr = v;
        if (c) c.mvOn[this._si] = 0;
    }
    // The path: a plain reference (non-enumerable _path, see
    // simUnitStateAllocate); a new one disarms the movement kernel.
    get path() { return this._path; }
    set path(v) {
        const c = this._us;
        if (c === undefined) { Object.defineProperty(this, '_path', { value: v, writable: true, configurable: true }); return; }
        this._path = v;
        if (c) c.mvOn[this._si] = 0;
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
        // Moved by the movement kernel this tick (simMoveRun).
        let cols = this._us;
        if (cols && cols.mvOut[this._si] !== 0) return;
        // Previous position for interpolation and the collision pass.
        this.prevX = this.x; this.prevY = this.y;
        if (this.dead) return;

        // (Status effects and attack timers: counted down for every unit at
        // once before the pass, statusPrepassRun.)
        if (this.energy <= 0) { this.dead = true; return; }

        // Floor item interaction: on entering a tile, then refreshed once a
        // second, staggered by unit (trap effects last seconds).
        let gx = Math.floor(this.x / TILE), gy = Math.floor(this.y / TILE);
        let floorTile = gy * GRID_W + gx;
        if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H && (floorTile !== this._floorTile || (gameTime + this.id) % TICK_RATE === 0)) {
            this._floorTile = floorTile;
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
                    this._explodeMine(cell, item, itemLevel);
                    return;
                }
            }
        }

        // Speed modifier
        let spd = this.preComputed.speed;
        if (this.frozen > 0) spd *= 0.5;
        if (this.sandy > 0) spd *= 0.5;
        spd *= _getUnitAstarSpeedMultiplier(this);

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
        // Unit separation runs for all units at once after the updates
        // (runUnitSeparationPass).
        pushUnitOutOfBlockedTile(this);
        this.x = _quantizeUnitWorldCoord(this.x);
        this.y = _quantizeUnitWorldCoord(this.y);
        updateUnitSpatial(this);
        if (cols) {
            let cmd = this.commandState;
            if (cmd === CMD_MOVING || cmd === CMD_ATTACK_MOVING) simMoveTryArm(this);
            else if (cmd === CMD_IDLE && this.workerState === 'IDLE') simMoveTryPark(this);
            else if (cmd === CMD_IDLE && !this.workerState) simMoveTryParkIdle(this);
            else if (cmd === CMD_ATTACKING) simMoveTryHold(this);
        }
    }

    // A hostile mine under the unit goes off (separate from update: its
    // closure's context would otherwise be allocated on every update).
    _explodeMine(cell, item, itemLevel) {
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
    }

    doIdle(spd) {
        if (this.unitType === 'scout') {
            this.pickScoutDestination();
            return;
        }
        // Auto-aggro nearby enemies (the query staggers and caches itself;
        // an outer stagger here could alias with it and never meet).
        let aggroRange = Math.max(TILE, this.preComputed.visionRange * TILE);
        let closest = _combatScanTarget(this, aggroRange);
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

    // Within arrival tolerance of the issued move target.
    _isNearIssuedTarget(spd) {
        let t = this.targetPos;
        if (!(t && Number.isFinite(t.x) && Number.isFinite(t.y))) return false;
        let tol = Math.max(8, Math.min(TILE, Math.floor((Number(spd) || 1) * 2)));
        return detHypot(Number(t.x) - Number(this.x), Number(t.y) - Number(this.y)) <= tol;
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
                let dist = detHypot(dx, dy) || 1;
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
            if ((!this.path || this.pathIndex >= this.path.length) && this._pendingPathTarget && this._pendingPathTarget.cmd === CMD_MOVING && this._isNearIssuedTarget(spd)) {
                this._pendingPathTarget = null;
                this.pathIsFallbackAstar = false;
                this.targetPos = null;
                this.commandState = CMD_IDLE;
            }
            // Keep move command active while waiting for deferred pathfinding.
            return;
        }
        if (this.followPath(spd)) {
            // (The route's next stretch, walked from this tick as the kernel
            // walks it.)
            if (continueUnitRoute(this, CMD_MOVING)) { this._followRouteNode(spd); return; }
            if (this._pendingPathTarget && this._pendingPathTarget.cmd === CMD_MOVING) {
                this.path = null;
                if (this._isNearIssuedTarget(spd)) {
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
        // Scanning on the move is staggered to every other tick (by unit id):
        // a ready shot waits at most one tick.
        if (((gameTime + this.id) & 1) !== 0) return;
        // Marching through quiet ground (the common case): nothing hostile
        // anywhere near the unit's area, answered once per tick per area.
        if (!_hostilesPossibleNearArea(this.owner, this._spatialAreaId, Math.ceil(_getUnitAttackRangeArea(this)) + 1)) return;
        this._driveByScan();
    }

    // The scan itself (a separate method: its closure's context would
    // otherwise be allocated on every call of tryDriveByAttack).
    _driveByScan() {
        let closest = null;
        let bestD2 = Infinity;
        // The query visits the areas within ceil(range) steps. A whole range:
        // every visited unit is in range. Otherwise the last ring only counts
        // through contact. A unit's bucket area is its tile's area, so the
        // coverage answers visibility per area.
        let rangeArea = _getUnitAttackRangeArea(this), whole = Math.floor(rangeArea);
        let exact = whole === Math.ceil(rangeArea);
        let sources = exact ? null : getSourceAreaIdsAtWorld(this.x, this.y);
        let cover = _visCoverReady() && this.owner >= 0 && this.owner < _visCover.players ? _visCover.cover[this.owner] : null;
        // Use only simulation state. Pick by distance, then unit id, independent of
        // spatial bucket insertion order on different lockstep peers.
        forEachUnitInAreaRange(this.x, this.y, rangeArea, (enemy, areaId) => {
            if (cover ? !(cover[areaId] > 0) : !_isHostileThingVisibleToUnit(this, enemy)) return;
            if (!exact) {
                let inRange = false;
                for (let k = 0; k < sources.length && !inRange; k++) inRange = isAreaWithinDistance(sources[k], areaId, whole);
                if (!inRange && !_isUnitTargetInContact(this, enemy, whole + 1)) return;
            }
            let dx = enemy.x - this.x, dy = enemy.y - this.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < bestD2 || (d2 === bestD2 && (!closest || enemy.id < closest.id))) {
                closest = enemy;
                bestD2 = d2;
            }
        }, { enemyOfPlayer: this.owner, areaOnly: true });
        if (closest) { this._performAttackOnUnit(closest); return; }
        // Nothing hostile to hit on the way: shoot structures in reach,
        // turrets and traps on the route first (same staggered ticks).
        let structure = _findHostileStructureInAttackRange(this);
        if (structure) this._performAttackOnBuilding(structure);
    }

    doAttackMoving(spd) {
        // Check for nearby enemies first
        let aggroRange = Math.max(TILE, this.preComputed.visionRange * TILE);
        let closest = _combatScanTarget(this, aggroRange);
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
            if ((!this.path || this.pathIndex >= this.path.length) && this._pendingPathTarget && this._pendingPathTarget.cmd === CMD_ATTACK_MOVING && this._isNearIssuedTarget(spd)) {
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
            if (continueUnitRoute(this, CMD_ATTACK_MOVING)) { this._followRouteNode(spd); return; }
            if (this._pendingPathTarget && this._pendingPathTarget.cmd === CMD_ATTACK_MOVING) {
                this.path = null;
                if (this._isNearIssuedTarget(spd)) {
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

    // An attack: the attacker's side now (its cooldown, a ram's recoil),
    // the hit itself after the unit pass (unitHitsResolve), with every other
    // attack of the tick in the pass's order. No unit dies of another's
    // attack during the pass, so nothing in it depends on who went first.
    // False: the target never falls at once.
    _performAttackOnUnit(target) {
        this._attackerSide(target);
        _unitHitQueue(this, target, 0);
        return false;
    }

    _performAttackOnBuilding(tb) {
        this._attackerSide(tb);
        _unitHitQueue(this, tb, 1);
        return false;
    }

    _attackerSide(target) {
        let attackCue = ['fire', 'water', 'ice', 'poison', 'laser'].includes(this.attackStyle) ? 'attack_cast' : 'attack_swing';
        playSound(attackCue, this.x, this.y, this.unitType);
        this.attackTimer = this.preComputed.attackCooldown;
        this.attackTarget = target;
        this.attackFlash = 8;
        recordUnitAttackFx(this, target);
        if (this.attackStyle === 'ram') {
            this.energy -= this.preComputed.maxEnergy * 0.03;
            if (this.energy <= 0) { this.dead = true; }
        }
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
            // (The target where it was at the pass's start: _unitTickX.)
            let tpx = _unitTickX(this.targetUnit), tpy = _unitTickY(this.targetUnit);
            let tgx = Math.floor(tpx / TILE), tgy = Math.floor(tpy / TILE);
            // A forced target (an order, or retaliation against an attacker)
            // pressed against this unit stays engaged even when its area is
            // out of sight; units still acquire targets only by vision.
            let targetVisible = isGameplayTargetVisibleToPlayer(this.owner, tgx, tgy)
                || (this.forcedAttackTarget && _isUnitTargetInContactAt(this, this.targetUnit, tpx, tpy, Math.floor(_getUnitAttackRangeArea(this)) + 1));
            if (!targetVisible) {
                if (this.forcedAttackTarget) {
                    let lockX = Number.isFinite(this._forcedTargetLastSeenX) ? this._forcedTargetLastSeenX : tpx;
                    let lockY = Number.isFinite(this._forcedTargetLastSeenY) ? this._forcedTargetLastSeenY : tpy;
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
                this._forcedTargetLastSeenX = tpx;
                this._forcedTargetLastSeenY = tpy;
            }
            let d = detHypot(tpx - this.x, tpy - this.y);
            if (_isTargetWithinUnitAttackAreaRange(this, this.targetUnit, tpx, tpy)) {
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
                // (or near with open ground on the way: no route to ask for
                // each time the target moves on).
                if (this.path && this.pathIndex < this.path.length && d >= 2 * TILE && !_isChaseStepOpen(this, this.targetUnit, d, tpx, tpy)) {
                    this.followPath(spd);
                } else if (d < 2 * TILE || this.isFlying || _isChaseStepOpen(this, this.targetUnit, d, tpx, tpy)) {
                    // Close enough or flying - direct move
                    let dx = tpx - this.x, dy = tpy - this.y;
                    let dist = detHypot(dx, dy);
                    this.x += (dx / dist) * spd; this.y += (dy / dist) * spd;
                } else {
                    // Need a new path toward target
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
            let d = detHypot(tb.x - this.x, tb.y - this.y);
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
                    let dist = detHypot(dx, dy);
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

    _followRouteNode(spd) {
        const nd = this.path && this.pathIndex < this.path.length ? this.path[this.pathIndex] : null;
        if (nd && nd.nav && !this.holdPosition) this._followNavNode(nd, spd);
    }

    followPath(spd) {
        if (!this.path || this.pathIndex >= this.path.length) return true;
        // Held units keep their route (and its progress) until released.
        if (this.holdPosition) return false;
        if (this.path[this.pathIndex].nav) return this._followNavNode(this.path[this.pathIndex], spd);

        // Treat the shared route as a corridor. A roomy node is reached from
        // anywhere in its open 3x3 block, so crowds may flow beside the exact
        // tiles; tight nodes still need their own tile. The window is short
        // and also rejoins units that separation pushed past a waypoint.
        let tileX = Math.floor(this.x / TILE), tileY = Math.floor(this.y / TILE);
        // The node scans below depend only on the tile, the path, the index
        // and the topology: when those match the last completed scan, it
        // would find nothing new (units cross a tile in many ticks).
        let fpTile = tileY * GRID_W + tileX;
        if (this._fpPath === this.path && this._fpTile === fpTile && this._fpIdx === this.pathIndex && this._fpVer === pathTopologyVersion) return this._followPathStep(spd);
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
        this._fpPath = this.path; this._fpIdx = this.pathIndex; this._fpVer = pathTopologyVersion;
        this._fpTile = Math.floor(this.y / TILE) * GRID_W + Math.floor(this.x / TILE);
        return this._followPathStep(spd);
    }

    // A nav node (see navNode): one tile toward it by the navigation, O(1).
    // True when the path is done (at the node's tile and no more nodes, or
    // no way on from here).
    _followNavNode(nd, spd) {
        if (gameTime < (nd.ready | 0)) return false;
        const W = GRID_W, gx = Math.floor(this.x / TILE), gy = Math.floor(this.y / TILE), t = gy * W + gx, dest = nd.y * W + nd.x;
        if (t === dest) { this.pathIndex++; this._navLastD = -1; return this.pathIndex >= this.path.length; }
        // Near it and held back by a crowd (under a third of its speed made
        // good toward it since last tick): arrived where it is, as in the
        // movement kernel (not every unit of a big group fits on its tile).
        // Workers and lone units go all the way (a worker's task is at the
        // tile; only a group's destination is too small for all of it).
        if (nd.w && !this.workerState && this.pathIndex === this.path.length - 1 && Math.abs(nd.x - gx) <= 8 && Math.abs(nd.y - gy) <= 8) {
            const d = detHypot(nd.x * TILE + 16 - this.x, nd.y * TILE + 16 - this.y), last = this._navLastD;
            this._navLastD = d;
            if (last >= 0 && last - d < spd * 0.3) { this.pathIndex = this.path.length; this._navLastD = -1; return true; }
        } else this._navLastD = -1;
        const profile = nd.nav - 1, slot = navFieldRequest(profile, dest, !!nd.w), n = navStep(profile, t, dest, slot);
        if (n < 0) { this.pathIndex = this.path.length; return true; }
        const nx = n % W, ny = (n - nx) / W;
        let tx, ty;
        // Exactly as the movement kernel steers (flow mode; it hands the
        // unusual cases back here): on open ground up to 6 tiles ahead (all
        // with open blocks), straight there with the unit's own side offset
        // from the line; elsewhere the next tile's centre on its lane. n2:
        // the tile after the next.
        const wall = navWallTable(profile);
        const open = _simOpenBlock(wall, t, W, GRID_H) && _simOpenBlock(wall, n, W, GRID_H);
        let far = n, n2 = -1;
        for (let k = 1, cur = n; k < (open ? 6 : 2); k++) {
            const nn = navStep(profile, cur, dest, slot);
            if (nn < 0 || wall[nn]) break;
            if (k === 1) n2 = nn;
            if (!open || !_simOpenBlock(wall, nn, W, GRID_H)) break;
            far = cur = nn;
        }
        const kx = far % W, ky = (far - kx) / W;
        if (open) {
            const rdx = kx - gx, rdy = ky - gy, rl = Math.sqrt(rdx * rdx + rdy * rdy), sx = -rdy / rl, sy = rdx / rl, maxSide = TILE * 0.8;
            let side = ((this.x - (gx * TILE + 16)) * sx + (this.y - (gy * TILE + 16)) * sy) * 0.875;
            side = side > maxSide ? maxSide : (side < -maxSide ? -maxSide : side);
            tx = kx * TILE + 16 + sx * side; ty = ky * TILE + 16 + sy * side;
        } else {
            const lane = Math.max(1.5, Math.min(4, this.r * 0.6)), sdx = kx - gx, sdy = ky - gy;
            let lx = 0, ly = 0;
            if (Math.abs(sdx) >= Math.abs(sdy)) ly = (sdx < 0 ? lane : -lane); else lx = (sdy < 0 ? -lane : lane);
            tx = kx * TILE + 16 + lx; ty = ky * TILE + 16 + ly;
        }
        let dx = tx - this.x, dy = ty - this.y, dist = Math.sqrt(dx * dx + dy * dy);
        // Never turn back for a point it has passed: the one after.
        if (n2 >= 0 && far === n && this.vx * dx + this.vy * dy < 0) {
            const n2x = n2 % W;
            tx = n2x * TILE + 16; ty = ((n2 - n2x) / W) * TILE + 16;
            dx = tx - this.x; dy = ty - this.y; dist = Math.sqrt(dx * dx + dy * dy);
        }
        if (dist < 4) {
            if (n2 < 0) return false;
            const n2x = n2 % W;
            tx = n2x * TILE + 16; ty = ((n2 - n2x) / W) * TILE + 16;
            dx = tx - this.x; dy = ty - this.y; dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 4) return false;
        }
        const vx = (dx / dist) * spd, vy = (dy / dist) * spd;
        this.x += vx; this.y += vy; this.vx = vx; this.vy = vy;
        // Entering another tile is a step (charged like a path node; a step
        // the owner cannot cover still happens, as in the kernel).
        const ngx = Math.floor(this.x / TILE), ngy = Math.floor(this.y / TILE);
        if (ngx !== gx || ngy !== gy) _tryConsumeAstarMoveCostForTransition(this, { x: gx, y: gy }, { x: ngx, y: ngy });
        return false;
    }

    // followPath after its node bookkeeping: steer toward the current node.
    _followPathStep(spd) {
        let node = this.path[this.pathIndex];
        if (!this.pathIsFallbackAstar && !this.isFlying && !canUnitOccupyTileCached(this, node.x, node.y, 1)) {
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

        // The target: the node's centre plus a lane offset (lx, ly), or in a
        // corridor the unit's own side offset along (lx, ly) (as in
        // SIM_KERNEL_MOVE, which repeats this step for armed units).
        let prevNode = this.pathIndex > 0 ? this.path[this.pathIndex - 1] : null;
        let lx = 0, ly = 0;
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
            lx = -routeDy / routeLen; ly = routeDx / routeLen;
            // Drift gently back towards the exact route while there is no push.
            let side = ((this.x - baseTx) * lx + (this.y - baseTy) * ly) * 0.875;
            let maxSide = TILE * 0.8;
            side = side > maxSide ? maxSide : (side < -maxSide ? -maxSide : side);
            tx = baseTx + lx * side;
            ty = baseTy + ly * side;
        } else {
            // Directional lane rule:
            // horizontal: left -> below center, right -> above center
            // vertical: up -> left of center, down -> right of center
            if (Math.abs(segDx) >= Math.abs(segDy)) ly = (segDx < 0 ? laneOffset : -laneOffset);
            else lx = (segDy < 0 ? -laneOffset : laneOffset);
            tx = baseTx + lx; ty = baseTy + ly;
        }
        let dx = tx - this.x, dy = ty - this.y;
        let dist = detHypot(dx, dy);
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
        let vx = (dx / dist) * spd, vy = (dy / dist) * spd;
        this.vx = vx; this.vy = vy;
        this.x += vx; this.y += vy;
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
        if (this.attackTarget && this.attackFlash > 0 && (typeof renderer3dPanelRaster === 'undefined' || !renderer3dPanelRaster)) {
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
                let dx = tx - this.x, dy = ty - this.y, d = detHypot(dx, dy);
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
                let dx = tx - this.x, dy = ty - this.y, d = detHypot(dx, dy) || 1;
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

        if (shouldShowUnitLevels(this)) {
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

// The tick's attacks (see Unit._performAttackOnUnit): attacker, target,
// whether the target is a building, the damage and where the attacker
// stood, in the order they were made.
const _hitQ = { n: 0, a: [], t: [], b: new Uint8Array(1024), dmg: new Float64Array(1024), x: new Float64Array(1024), y: new Float64Array(1024) };
function _unitHitQueue(attacker, target, building) {
    const Q = _hitQ, i = Q.n++;
    if (i >= Q.b.length) {
        const grow = (A, T) => { const r = new T(A.length * 2); r.set(A); return r; };
        Q.b = grow(Q.b, Uint8Array); Q.dmg = grow(Q.dmg, Float64Array); Q.x = grow(Q.x, Float64Array); Q.y = grow(Q.y, Float64Array);
    }
    Q.a[i] = attacker; Q.t[i] = target; Q.b[i] = building;
    Q.dmg[i] = attacker.preComputed.attackDamage; Q.x[i] = attacker.x; Q.y[i] = attacker.y;
}
function _isHitBuildingStanding(tb) {
    if (!(tb.energy > 0)) return false;
    if (getTileEntityRef(tb.gx, tb.gy) === tb) return true;
    const row = grid[tb.gy], cell = row && row[tb.gx];
    return !!cell && cell.item === tb;
}
// The hits, in order: a target already fallen takes no more.
function unitHitsResolve() {
    const Q = _hitQ, n = Q.n;
    for (let i = 0; i < n; i++) {
        const a = Q.a[i], target = Q.t[i];
        Q.a[i] = null; Q.t[i] = null;
        if (Q.b[i] === 0) _unitHitUnit(a, target, Q.dmg[i], Q.x[i], Q.y[i]);
        else _unitHitBuilding(a, target, Q.dmg[i]);
    }
    Q.n = 0;
}
// Dropped (a restore replaces the world between ticks).
function unitHitsReset() { const Q = _hitQ; for (let i = 0; i < Q.n; i++) { Q.a[i] = null; Q.t[i] = null; } Q.n = 0; }
function _unitHitUnit(a, target, dmg, ax, ay) {
    if (target.dead) return;
    let before = target.energy;
    target.energy -= dmg;
    pushHostileDamageAlert(target, before - target.energy, a.owner);
    recordDamageVisual(target, before - target.energy, a.owner);
    if (before > target.energy) playSound('melee_hit', target.x, target.y, a.unitType);
    tryAutoRetaliateOnHostileDamage(target, a, ax, ay);
    let style = a.attackStyle;
    if (style === 'fire') {
        target.burning = Math.max(target.burning, 45);
        target.burnTickDamage = Math.max(target.burnTickDamage, dmg * 0.04);
    } else if (style === 'water') {
        target.wet = Math.max(target.wet, 60);
    } else if (style === 'ice') {
        target.frozen = Math.max(target.frozen, 40);
    } else if (style === 'poison') {
        target.poisoned = Math.max(target.poisoned, 50);
        target.poisonTickDamage = Math.max(target.poisonTickDamage, dmg * 0.04);
    } else if (style === 'swoop') {
        if (a.unitType === 'scout') applyStatusEffect(target, 'watch', getUnitEffectiveLevel(a), 0, a.owner, a.unitType);
    }
    if (target.energy <= 0) target.dead = true;
}
function _unitHitBuilding(a, tb, dmg) {
    if (!_isHitBuildingStanding(tb)) return;
    let before = tb.energy, style = a.attackStyle;
    if (style === 'fire') {
        applyStatusEffect(tb, 'fire', getUnitBaseLevel(a), dmg * 0.04);
        if (!isEffectImmune(tb, 'fire')) tb.energy -= dmg;
    } else if (style === 'water') {
        applyStatusEffect(tb, 'water', getUnitBaseLevel(a));
        if (!isEffectImmune(tb, 'water')) tb.energy -= dmg;
    } else if (style === 'ice') {
        applyStatusEffect(tb, 'ice', getUnitBaseLevel(a), dmg * 0.2);
        if (!isEffectImmune(tb, 'ice')) tb.energy -= dmg;
    } else if (style === 'poison') {
        applyStatusEffect(tb, 'poison', getUnitBaseLevel(a), dmg * 0.04);
        if (!isEffectImmune(tb, 'poison')) tb.energy -= dmg;
    } else if (style === 'swoop') {
        if (a.unitType === 'scout') applyStatusEffect(tb, 'watch', getUnitEffectiveLevel(a), 0, a.owner, a.unitType);
        tb.energy -= dmg;
    } else {
        tb.energy -= dmg;
    }
    pushHostileDamageAlert(tb, before - tb.energy, a.owner);
    recordDamageVisual(tb, before - tb.energy, a.owner);
    if (before > tb.energy) playSound('melee_hit', tb.x, tb.y, a.unitType);
    if (tb.energy <= 0) destroyBuilding(tb);
}

// Status effect fields: columns (SIM_UNIT_STATUS_COLUMNS), like x and y.
for (const k of (typeof SIM_UNIT_STATUS_COLUMNS !== 'undefined' ? SIM_UNIT_STATUS_COLUMNS : [])) {
    Object.defineProperty(Unit.prototype, k, {
        get() { const c = this._us; return c ? c[k][this._si] : (this._det ? this._det[k] : undefined); },
        set(v) { const c = this._us; if (c) c[k][this._si] = v; else if (this._det) this._det[k] = v; else Object.defineProperty(this, k, { value: v, writable: true, enumerable: true, configurable: true }); },
        configurable: true
    });
}

// Status effects and attack timers of every unit, counted down at once
// before the unit pass (SIM_KERNEL_STATUS; Unit.update did it per unit):
// damage over time dealt, units it kills marked dead. Then the few events
// that need the objects: damage shown, watches ended.
const STATUS_PREPASS_CHUNK = 8192;
let _statusCounts = null;
function statusPrepassRun() {
    const S = _simUnitState, n = units.length;
    if (!S || n === 0) return;
    const slots = _unitSlotMapEnsure(), chunks = Math.ceil(n / STATUS_PREPASS_CHUNK);
    if (!_statusCounts || _statusCounts.length < chunks) { _statusCounts = simSharedArray(Int32Array, Math.max(64, chunks * 2)); simParallelBind('st.count', _statusCounts); }
    simParallelBind('ix.slots', slots);
    const P = _simParams;
    P[0] = n; P[1] = STATUS_PREPASS_CHUNK;
    simParallelRun(SIM_KERNEL_STATUS, chunks);
    const C = S.columns, EV = C.stEv, DOT = C.stDot, owners = S.owners;
    for (let k = 0; k < chunks; k++) {
        if (_statusCounts[k] === 0) continue;
        for (let i = k * STATUS_PREPASS_CHUNK, end = Math.min(n, i + STATUS_PREPASS_CHUNK); i < end; i++) {
            const s = slots[i];
            if (s < 0) continue;
            const ev = EV[s];
            if (ev === 0) continue;
            EV[s] = 0;
            const u = owners[s];
            if (!u || u !== units[i]) continue;
            if (ev & 1) recordDamageVisual(u, DOT[s]);
            if (ev & 2) { u.watchedByTeam = -1; if (typeof visCoverOnUnitSpatialChanged === 'function') visCoverOnUnitSpatialChanged(u); }
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
    notePendingPathUnit(unit);
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
    return Math.max(1, clampThingLevel(detFloorLog2(stacks || 1) + 1));
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
    // Left in the list, dead, for the tick's single compaction pass (which
    // also drops it from the selection): a splice per removal made removing
    // many units quadratic.
    u._removedNow = true;
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
            units.push(nu); unitSlotMapPushed(nu);
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


// The nearest walkable tile to (gx, gy) by ring, and in that ring the one
// nearest to (fromGx, fromGy) (ties: smaller y, then smaller x). Scans each
// ring in place: building and sorting a candidate list per ring per unit made
// a rally to an unwalkable spot cost most of a tick.
// The walkable tiles of the nearest ring do not depend on where the unit is,
// only on what may stand on them: cached per target and walking class for the
// rest of the tick (a big army ordered to an unwalkable spot asks thousands
// of times). Keyed by the path topology version, which every peer bumps at
// resyncs, and by the tick.
let _nearestWalkableRingCache = new Map();
let _nearestWalkableRingCacheKey = '';

function _nearestWalkableRing(gx, gy, unit) {
    let tickKey = gameTime + '|' + currentTick + '|' + pathTopologyVersion;
    if (_nearestWalkableRingCacheKey !== tickKey) { _nearestWalkableRingCacheKey = tickKey; _nearestWalkableRingCache.clear(); }
    let cls = !unit ? 'n' : unit.isFlying ? 'f' : (unit.owner + '|' + (unit.workerType || ''));
    let key = gx + ',' + gy + '|' + cls;
    let ring = _nearestWalkableRingCache.get(key);
    if (ring !== undefined) return ring;
    ring = null;
    let maxRadius = Math.max(GRID_W, GRID_H);
    for (let r = 1; r <= maxRadius && !ring; r++) {
        let tiles = [];
        // The old candidate order: top and bottom rows by x, then the sides.
        for (let x = gx - r; x <= gx + r; x++) {
            if (isWalkableTileFor(unit, x, gy - r)) tiles.push(x, gy - r);
            if (isWalkableTileFor(unit, x, gy + r)) tiles.push(x, gy + r);
        }
        for (let y = gy - r + 1; y <= gy + r - 1; y++) {
            if (isWalkableTileFor(unit, gx - r, y)) tiles.push(gx - r, y);
            if (isWalkableTileFor(unit, gx + r, y)) tiles.push(gx + r, y);
        }
        if (tiles.length) ring = tiles;
    }
    _nearestWalkableRingCache.set(key, ring);
    return ring;
}

function findNearestWalkable(gx, gy, fromGx, fromGy, unit = null) {
    if (isWalkableTileFor(unit, gx, gy)) return { x: gx, y: gy };
    let hasFrom = Number.isFinite(fromGx) && Number.isFinite(fromGy);
    let ring = _nearestWalkableRing(gx, gy, unit);
    if (ring) {
        if (!hasFrom) return { x: ring[0], y: ring[1] };
        let bestX = ring[0], bestY = ring[1], bestD = detHypot(bestX - fromGx, bestY - fromGy);
        for (let i = 2; i < ring.length; i += 2) {
            let x = ring[i], y = ring[i + 1], d = detHypot(x - fromGx, y - fromGy);
            if (d < bestD || (d === bestD && (y < bestY || (y === bestY && x < bestX)))) { bestX = x; bestY = y; bestD = d; }
        }
        return { x: bestX, y: bestY };
    }
    return {
        x: Math.max(0, Math.min(GRID_W - 1, gx)),
        y: Math.max(0, Math.min(GRID_H - 1, gy))
    };
}

// ---- Unit separation ----
// One pass per tick after every unit has moved (gameTick). Each touching
// pair is found once (per spatial chunk: the chunk itself, then the chunks
// ahead of it) and both units are pushed apart, every tick, so crowds move
// smoothly instead of creeping into each other and snapping back.
// A unit takes part when it moved this tick or on its staggered resting
// check (getUnitCollisionRecalcTicks); a pair is tested when either does,
// and only a taking-part unit is pushed. Pushes are summed as integers
// (1/UNIT_SEPARATION_Q px), so the result does not depend on the order of
// the pairs (bucket order may differ between peers).
const UNIT_SEPARATION_Q = 1024;
// Share of an overlap a unit corrects: both of a pair (about what two
// successive 0.6 corrections gave), or the only one taking part.
const UNIT_SEPARATION_SHARE_BOTH = 0.42, UNIT_SEPARATION_SHARE_ONE = 0.6;
// A moving unit against one at rest that gives way: the mover corrects
// little of the overlap, the one at rest most (it steps aside).
const UNIT_SEPARATION_SHARE_MOVER = 0.2, UNIT_SEPARATION_SHARE_YIELD = 0.65;
// A colliding unit on a fallback path retries its path every this many ticks.
const UNIT_SEPARATION_PATH_RETRY_TICKS = 4;
// Contacts summed in full (see runUnitSeparationPass).
const UNIT_SEPARATION_CONTACTS = 3;
const _sep = { cap: 0, offs: null, offsReach: 0, offsCws: 0 };
function _sepGrow(n) {
    if (n <= _sep.cap) return;
    let cap = Math.max(1024, n, _sep.cap * 2);
    _sep.r = new Float64Array(cap);
    _sep.layer = new Uint8Array(cap); _sep.check = new Uint8Array(cap);
    _sep.cap = cap;   // (the packed and output arrays follow it: runUnitSeparationPass)
}


// Units by tile, contiguous (sorted entries): ord[k] is the unit index of
// the k-th entry; tile c holds entries start[c] .. start[c + 1] - 1. The
// separation kernel (sim_parallel.js) gathers each checking unit's pushes
// from these packed arrays, in parallel over rows of tiles; the units are
// read before and written after, here.
function _sepShared(S, name, Type, n) {
    let arr = S[name];
    if (!arr || arr.length < n) { arr = S[name] = simSharedArray(Type, n); simParallelBind('sep.' + name, arr); }
    return arr;
}
// Work is split into small batches of checking units, including within one
// crowded tile, rather than rows whose occupancy varies by orders of magnitude.

// Large worlds: the entries come straight from the unit state slots. The
// spatial index keeps each slot's chunk and layer current, so nothing is
// gathered from unit objects; entries are ordered by chunk (ties by slot:
// pushes are summed as integers, so the order does not change them).
// ============================================================
// MOVEMENT KERNEL
// ============================================================
// Most units spend most ticks marching along their route through open
// ground. After such a tick of Unit.update the unit is armed (its path
// window and stats in the columns, simMoveTryArm) and its following ticks
// run as SIM_KERNEL_MOVE over the columns and a few world tables (walls,
// structures by tile, hostile counts per block, area boxes), without
// reading the unit object: node by node, tile by tile, until something
// needs Unit.update again (a hostile possibly in reach, a hostile floor,
// the end of its window or path, a wall) or its orders, path, status or
// stats change (setters and hooks disarm it, simMoveDisarm). The kernel is
// a pure function of each unit's columns and the world, so the result does
// not depend on slot order; armed units move before the update pass, and
// the rest update in the usual order.
const _simMoveAreaSource = [0];

function simMoveDisarm(u) {
    const c = u && u._us;
    if (c) c.mvOn[u._si] = 0;
}

// Every unit's movement stat columns from its stats (after a restore, whose
// units get their stats as plain fields, and when the stat tables change in
// place: _precomputedStatsVersion).
let _simMoveStatsVersion = -1;
function simMoveRefreshAllStats() {
    _simMoveStatsVersion = typeof _precomputedStatsVersion !== 'undefined' ? _precomputedStatsVersion : 0;
    for (const u of units) if (u && u._us) simMoveStatsChanged(u);
}

function simMoveDisarmAll() {
    const S = _simUnitState;
    if (S) S.columns.mvOn.fill(0);
}

// New stats (a level or stacking change): an armed unit takes them into its
// columns (speed, reach, step cost), as simMoveTryArm would.
function simMoveStatsChanged(u) {
    const c = u && u._us;
    if (!c) return;
    const s = u._si, pc = u.preComputed, f = c.mvFlags[s];
    const spd = pc ? pc.speed * _getUnitAstarSpeedMultiplier(u) : NaN;
    // Every unit's movement stats, for orders that arm it from the columns.
    if (pc) {
        const rd = Math.ceil(_getUnitAttackRangeArea(u)) + 1, ra = Math.ceil(Math.max(TILE, pc.visionRange * TILE) / TILE) + 1;
        c.mvSpd[s] = spd; c.mvLane[s] = Math.max(1.5, Math.min(4, u.r * 0.6)); c.mvCost[s] = _resolveUnitAstarTileCost(u);
        c.mvReachD[s] = rd >= 0 && rd < SIM_MOVE_BOX_STEPS ? rd : 255; c.mvReachA[s] = ra >= 0 && ra < 255 ? ra : 255;
        c.mvShoot[s] = pc.attackDamage > 0 ? 1 : 0;
        c.cbRange[s] = Math.max(TILE, pc.visionRange * TILE);
    }
    // Parked or holding: its checks were made with the old stats.
    if (c.mvOn[s] >= 2) { c.mvOn[s] = 0; return; }
    if (c.mvOn[s] !== 1) return;
    let reach = 0, ok = spd >= 0;
    if (ok && (f & 16)) reach = Math.ceil(Math.max(TILE, pc.visionRange * TILE) / TILE) + 1;
    else if (ok && (f & 1)) reach = Math.ceil(_getUnitAttackRangeArea(u)) + 1;
    // A drive-by shooter that no longer shoots (or the reverse), or reaches
    // out of its tables: Unit.update decides.
    if (!ok || ((f & 16) === 0 && ((f & 1) !== 0) !== (pc.attackDamage > 0)) || !(reach >= 0 && reach < ((f & 16) ? 256 : SIM_MOVE_BOX_STEPS))) { c.mvOn[s] = 0; return; }
    if ((f & 1) && reach !== c.mvReach[s]) {
        const area = u._spatialAreaId;
        if (!(area >= 0)) { c.mvOn[s] = 0; return; }
        _simMoveEnsureAreaBox(area, reach);
    }
    c.mvSpd[s] = spd; c.mvReach[s] = reach; c.mvCost[s] = _resolveUnitAstarTileCost(u);
}

// Zones of tile (gx, gy) whose +-0.3 tile windows cover the same areas as
// `zone`'s (bit per zone; see updateUnitSpatial for the zones).
const _simMoveNearAreas = new Int32Array(9), _simMoveSetA = new Int32Array(4), _simMoveSetB = new Int32Array(4);
function _simMoveWindowAreas(zone, out) {
    const zx = (zone / 3) | 0, zy = zone % 3;
    let n = 0;
    for (let dx = zx === 0 ? -1 : 0; dx <= (zx === 2 ? 1 : 0); dx++) for (let dy = zy === 0 ? -1 : 0; dy <= (zy === 2 ? 1 : 0); dy++) {
        const v = _simMoveNearAreas[(dx + 1) * 3 + dy + 1];
        if (v < 0) continue;
        let i = 0;
        while (i < n && out[i] < v) i++;
        if (i < n && out[i] === v) continue;
        for (let j = n; j > i; j--) out[j] = out[j - 1];
        out[i] = v; n++;
    }
    return n;
}
// Cached per tile and zone (0: not yet known) for the current area layout;
// a new layout also resets every unit's mask (see resetUnitZoneMasks).
let _simMoveZoneMaskCache = null, _simMoveZoneMaskGrid = null, _simMoveZoneMaskAdm = null;
function _simMoveZoneMask(gx, gy, zone) {
    if (_simMoveZoneMaskGrid !== areaIdGrid || _simMoveZoneMaskAdm !== areaDistanceMatrix || !_simMoveZoneMaskCache || _simMoveZoneMaskCache.length !== GRID_W * GRID_H * 9) {
        if (!_simMoveZoneMaskCache || _simMoveZoneMaskCache.length !== GRID_W * GRID_H * 9) _simMoveZoneMaskCache = new Uint16Array(GRID_W * GRID_H * 9);
        else _simMoveZoneMaskCache.fill(0);
        _simMoveZoneMaskGrid = areaIdGrid; _simMoveZoneMaskAdm = areaDistanceMatrix;
        resetUnitZoneMasks();
    }
    if (!(gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H)) return _simMoveZoneMaskOf(gx, gy, zone);
    const k = (gy * GRID_W + gx) * 9 + zone;
    let m = _simMoveZoneMaskCache[k];
    if (m === 0) m = _simMoveZoneMaskCache[k] = _simMoveZoneMaskOf(gx, gy, zone);
    return m;
}
// Every unit's registered window zone counts as unknown (the next zone
// change re-registers it).
function resetUnitZoneMasks() {
    const S = _simUnitState;
    if (S) S.columns.mvZmask.fill(0);
}
function _simMoveZoneMaskOf(gx, gy, zone) {
    const center = getAreaIdAtTile(gx, gy);
    let same = true;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const v = getAreaIdAtTile(gx + dx, gy + dy);
        _simMoveNearAreas[(dx + 1) * 3 + dy + 1] = v;
        if (v !== center) same = false;
    }
    if (same) return 0x1FF;
    const n = _simMoveWindowAreas(zone, _simMoveSetA);
    let mask = 0;
    for (let z = 0; z < 9; z++) {
        if (z === zone) { mask |= 1 << z; continue; }
        const m = _simMoveWindowAreas(z, _simMoveSetB);
        if (m !== n) continue;
        let eq = true;
        for (let i = 0; i < n && eq; i++) eq = _simMoveSetA[i] === _simMoveSetB[i];
        if (eq) mask |= 1 << z;
    }
    return mask;
}

// Flow mode: a unit following the flow navigation (destination field slot
// `fid`, its generation `gen`; the air navigation for a flying unit) to tile
// `dest` under command `cmd`, armed
// from its columns alone (stats: simMoveStatsChanged). False when those do
// not allow it (Unit.update keeps the unit).
const SIM_FLOW_ARRIVE = 2;
function simFlowArm(c, s, fid, gen, dest, cmd, flying, ready = 0, worker = false, isWorker = false) {
    if (!(c.mvSpd[s] >= 0) || c.sepKey[s] === SIM_SEP_ABSENT) return false;
    // (Bit 128: no arriving in a crowd short of the tile: a worker's task
    // is at its tile, a lone unit's order too.)
    let flags = 64 | (flying ? 32 : 0) | (worker ? 128 : 0), reach = 0;
    if (cmd === CMD_ATTACK_MOVING) {
        reach = c.mvReachA[s];
        if (reach === 255) return false;
        flags |= 16;
    } else if (c.mvShoot[s]) {
        reach = c.mvReachD[s];
        const area = c.spArea[s];
        if (reach === 255 || !(area >= 0)) return false;
        _simMoveEnsureAreaBox(area, reach);
        flags |= 1;
    }
    c.mvFlags[s] = flags; c.mvReach[s] = reach; c.mvFlow[s] = fid; c.mvFGen[s] = gen; c.mvDest[s] = dest; c.mvNavT[s] = -1; c.mvReady[s] = ready;
    c.mvWk[s] = isWorker ? 1 : 0;
    c.mvSpent[s] = 0; c.mvFloor[s] = -1;
    c.mvOn[s] = 1;
    return true;
}

// A flow unit stopping short of its destination (a crowd there): its move
// order is done, as at the end of a path.
function simFlowArrive(u) {
    u._routeKey = null; u.path = null; u.pathIndex = 0;
    u._pendingPathTarget = null; u.pathIsFallbackAstar = false; u.targetPos = null;
    if (u.commandState === CMD_ATTACK_MOVING) { u._attackMoveGx = u._attackMoveGy = null; }
    u.commandState = CMD_IDLE;
}

// A unit on a route (u._routeKey) away from its end: armed in flow mode.
function _simMoveTryFlowArm(u, c, s, cmd) {
    if (u._routeKey !== NAV_ROUTE_KEY) return false;
    const x = c.x[s], y = c.y[s], gx = Math.floor(x / TILE), gy = Math.floor(y / TILE), t = gy * GRID_W + gx;
    const dest = u._routeEnd, profile = navProfileOf(u);
    if (!(dest >= 0) || t === dest) return false;
    navEnsure(profile);
    const did = navFieldRequest(profile, dest, true);
    return did >= 0 && simFlowArm(c, s, did, navFieldGen(did), dest, cmd, profile === NAV_PROFILE_AIR, u._navReady | 0);
}

// A unit ends its Unit.update marching along its path with nothing to react
// to: arms it (the columns SIM_KERNEL_MOVE works from) when every input of
// its next ticks is in the columns or the kernel's world tables.
function simMoveTryArm(u) {
    const c = u._us;
    if (!c || u.dead || u.holdPosition) return;
    const cmd = u.commandState;
    if (cmd !== CMD_MOVING && cmd !== CMD_ATTACK_MOVING) return;
    // A nav node next (workers too): flow mode toward its tile.
    const nd = u.path && u.pathIndex < u.path.length ? u.path[u.pathIndex] : null;
    if (nd && nd.nav) {
        if (u._spatialEpoch !== spatialEpoch) return;
        const s = u._si, profile = nd.nav - 1, dest = nd.y * GRID_W + nd.x;
        if (Math.floor(c.y[s] / TILE) * GRID_W + Math.floor(c.x[s] / TILE) === dest) return;
        const did = navFieldRequest(profile, dest, !!nd.w);
        // (Arriving in a crowd short of the tile: groups only.)
        if (did >= 0) simFlowArm(c, s, did, navFieldGen(did), dest, cmd, profile === NAV_PROFILE_AIR, nd.ready | 0, !!u.workerState || !nd.w, !!u.workerState);
        return;
    }
    if (u.workerState) return;
    if (!u.holdPosition && u._spatialEpoch === spatialEpoch && _simMoveTryFlowArm(u, c, u._si, cmd)) return;
    const path = u.path, idx = u.pathIndex;
    // Waiting for its group's route (see routeGroupMembers): parked until
    // the route gives it a path (the path setter wakes it) or its wait ends.
    const waiting = !path || !(idx < path.length);
    if (waiting && !(u.pathIsFallbackAstar && u._pendingPathTarget && u._pendingPathTarget.cmd === cmd && u._awaitGroupPath > gameTime + 1)) return;
    const s = u._si;
    if (u._spatialEpoch !== spatialEpoch || c.sepKey[s] === SIM_SEP_ABSENT) return;
    const owner = u.owner;
    if (!(owner >= 0 && owner < spatialUnitsComplexPlayerCount) || !spatialBlockCols) return;
    const pc = u.preComputed;
    const spd = pc ? pc.speed * _getUnitAstarSpeedMultiplier(u) : NaN;
    if (!(spd >= 0)) return;
    let flags = 0, reach = 0;
    if (cmd === CMD_MOVING) {
        // Drive-by shots (tryDriveByAttack): the tiles of the areas in reach
        // of its area (a table filled here and as it enters new areas).
        if (pc.attackDamage > 0) {
            reach = Math.ceil(_getUnitAttackRangeArea(u)) + 1;
            if (!(reach >= 0 && reach < SIM_MOVE_BOX_STEPS)) return;
            flags |= 1;
        }
    } else {
        // Attack-move aggro (doAttackMoving): the chunks and tiles its unit
        // and structure scans visit from anywhere in its tile.
        reach = Math.ceil(Math.max(TILE, pc.visionRange * TILE) / TILE) + 1;
        if (!(reach >= 0 && reach < 256)) return;
        flags |= 16;
    }
    if (u.pathIsFallbackAstar) flags |= 8;
    if (u.pathIsFallbackAstar && u._pendingPathTarget) flags |= 4;
    if (u.isFlying) flags |= 32;
    if (waiting) {
        if (u._isNearIssuedTarget(spd)) return;
        if (flags & 1) {
            const area = u._spatialAreaId;
            if (!(area >= 0)) return;
            _simMoveEnsureAreaBox(area, reach);
        }
        c.mvFlags[s] = flags; c.mvReach[s] = reach; c.mvWake[s] = u._awaitGroupPath; c.mvFloor[s] = u._floorTile;
        c.mvOn[s] = 2;
        return;
    }
    // The path window: nodes from pathIndex - 1, up to a portal link (the
    // kernel leaves those to Unit.update).
    const base = idx > 0 ? idx - 1 : 0, nb = s * SIM_MOVE_WINDOW, nodes = c.mvNodes;
    // (Adjacent portal pairs only exist with cloud towers.)
    const clouds = _cloudTileCache && _cloudTileCache.size > 0;
    let wl = 0, px = 0, py = 0;
    for (; wl < SIM_MOVE_WINDOW && base + wl < path.length; wl++) {
        const n = path[base + wl], nx = n.x, ny = n.y;
        if (wl > 0 && (Math.abs(nx - px) + Math.abs(ny - py) !== 1 || (clouds && isCloudPortalLink(px, py, nx, ny, owner)))) break;
        nodes[nb + wl] = ny * GRID_W + nx;
        px = nx; py = ny;
    }
    if (wl < 2 && base + wl < path.length) return;
    // Its area's box now; the next areas' as it enters them (simMoveRun).
    if (flags & 1) {
        const area = u._spatialAreaId;
        if (!(area >= 0)) return;
        _simMoveEnsureAreaBox(area, reach);
    }
    c.mvBase[s] = base; c.mvWlen[s] = wl; c.mvPlen[s] = path.length;
    c.mvFlags[s] = flags; c.mvReach[s] = reach; c.mvSpd[s] = spd;
    c.mvLane[s] = Math.max(1.5, Math.min(4, u.r * 0.6));
    c.mvCost[s] = _resolveUnitAstarTileCost(u);
    c.mvScan[s] = -1; c.mvFloor[s] = u._floorTile; c.mvSpent[s] = 0;
    c.mvOn[s] = 1;
}

// An idle worker whose search found nothing does nothing until its next
// search tick (see shouldRunWorkerIdleRetarget) or, for a builder, its next
// recheck: parked (mvOn 2) until then, its ticks cost the kernel a floor
// check. Anything that could give it work sooner (its state, a forced
// search, orders, status, stats) wakes it through the setters and hooks.
// A chase within CHASE_DIRECT_TILES of the target goes straight at it while
// the tile its next step enters (and the target's) is open ground.
const CHASE_DIRECT_TILES = 6;
function _isChaseStepOpen(u, t, d, px = t.x, py = t.y) {
    if (!(d < CHASE_DIRECT_TILES * TILE) || !(d > 0)) return false;
    const wall = simMoveWallGrid(), step = Math.max(TILE * 0.6, Number(u.preComputed && u.preComputed.speed) || 1);
    const nx = u.x + (px - u.x) / d * step, ny = u.y + (py - u.y) / d * step;
    const gx = Math.floor(nx / TILE), gy = Math.floor(ny / TILE), tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
    if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H || tx < 0 || ty < 0 || tx >= GRID_W || ty >= GRID_H) return false;
    return !wall[gy * GRID_W + gx] && !wall[ty * GRID_W + tx];
}

// Attack hold: a unit attacking a unit in range, waiting for its cooldown,
// needs nothing of Unit.update while nothing changes (the status pre-pass
// counts its timers down). The kernel hands the unit back on the tick of
// its attack, or at once when the target dies or leaves its tile, the unit
// leaves its tile or window zone (the range is a matter of those), or the
// target's area leaves its owner's sight. Forced targets (their last seen
// position is kept each tick), held units and structures stay in
// Unit.update.
function simMoveTryHold(u) {
    const c = u._us, tu = u.targetUnit;
    if (!c || u.dead || u.holdPosition || u.workerState || !tu || tu.dead || u.forcedAttackTarget || u.targetBuilding || u.attackTarget !== tu || u.path) return;
    if (!(u.attackTimer > 1) || !(u.preComputed && u.preComputed.attackDamage > 0)) return;
    const q = tu._si, tc = tu._us;
    if (tc !== c || !(q >= 0) || u._spatialEpoch !== spatialEpoch || c.sepKey[u._si] === SIM_SEP_ABSENT) return;
    // (Range in area steps; the kernel works out up to 2, touching included.)
    const k = Math.floor(Math.max(0, Number(_getUnitAttackRangeArea(u)) || 0));
    if (!(k <= 1)) return;
    const s = u._si;
    c.mvHT[s] = q; c.mvHTId[s] = tu.id; c.mvReach[s] = k;
    c.mvFloor[s] = u._floorTile; c.mvFlags[s] = 0;
    c.mvOn[s] = 3;
}

// A held unit at its turn in the update pass (kernel output 6): whether the
// hold still stands now, after the units before it in the pass (a target
// they killed or moved, sight they took away...). Otherwise it runs
// Unit.update after all: what it would have done at this point.
function simHoldStillValid(c, s) {
    // (Targets are seen where they were at the pass's start, hits land
    // after it: only a death during the pass, or walls changed, matter.)
    if (c.mvOn[s] !== 3 || c.dead[s] || !(c.energy[s] > 0) || _simMoveWallDirty || _simMoveWallVer !== _simMoveRunWallVer) return false;
    const q = c.mvHT[s];
    return q >= 0 && !c.dead[q] && (c.id[q] | 0) === c.mvHTId[s];
}
function simHoldUndo(c, s) {
    c.mvOn[s] = 0; c.mvOut[s] = 0;
}

// An idle combat unit with nothing in reach parks too: the kernel checks its
// floor and its aggro box (hostile units or structures there: back to
// Unit.update, which engages) each tick, and wakes it every
// SIM_IDLE_PARK_TICKS for its periodic checks.
const SIM_IDLE_PARK_TICKS = 20;
function simMoveTryParkIdle(u) {
    const c = u._us;
    if (!c || u.dead || u.holdPosition || u.workerState || u.unitType === 'scout' || u._attackMoveGx != null) return;
    const s = u._si, reach = c.mvReachA[s];
    if (u._spatialEpoch !== spatialEpoch || c.sepKey[s] === SIM_SEP_ABSENT || reach === 255) return;
    c.mvWake[s] = gameTime + SIM_IDLE_PARK_TICKS; c.mvFloor[s] = u._floorTile; c.mvFlags[s] = 16; c.mvReach[s] = reach;
    c.mvOn[s] = 2;
}
function simMoveTryPark(u) {
    const c = u._us;
    if (!c || u.dead || u.holdPosition || u.workerTransferCooldown > 0) return;
    const s = u._si;
    if (u._spatialEpoch !== spatialEpoch || c.sepKey[s] === SIM_SEP_ABSENT) return;
    const next = u._workerNextIdleRetargetTick;
    if (!Number.isFinite(next)) return;
    const id = u.id, delay = Math.max(1, Math.floor(Number(WORKER_AI_TICK_DELAY) || 1));
    const per = Math.ceil(getWorkerIdleSearchTicks() / delay);
    let wake = next;
    for (let t = gameTime + 1; t < wake; t++) {
        if (((t + id) % delay) === 0 && (Math.floor((t + id) / delay) % per) === 0) { wake = t; break; }
    }
    if (u.workerType === 'builder' && Number.isFinite(u._builderNextRecheckTick) && u._builderNextRecheckTick < wake) wake = u._builderNextRecheckTick;
    if (!(wake > gameTime + 1)) return;
    c.mvWake[s] = wake; c.mvFloor[s] = u._floorTile; c.mvFlags[s] = 0;
    c.mvOn[s] = 2;
}

// Drive-by boxes: per area and steps, the tile box of the areas within
// that many steps (getAreaRangeTileBox), for the kernel. Reset with the area
// layout.
const SIM_MOVE_BOX_STEPS = 9;
let _simMoveAreaBox = null, _simMoveAreaBoxOk = null, _simMoveAreaBoxFor = null;
function _simMoveAreaBoxes() {
    const A = Math.max(1, areaDistanceMatrix ? areaDistanceMatrix.length : 0);
    if (_simMoveAreaBoxFor !== areaDistanceMatrix || !_simMoveAreaBoxOk || _simMoveAreaBoxOk.length !== A * SIM_MOVE_BOX_STEPS) {
        _simMoveAreaBox = simSharedArray(Int32Array, A * SIM_MOVE_BOX_STEPS * 4);
        _simMoveAreaBoxOk = simSharedArray(Uint8Array, A * SIM_MOVE_BOX_STEPS);
        _simMoveAreaBoxFor = areaDistanceMatrix;
        simParallelBind('mv.areaBox', _simMoveAreaBox); simParallelBind('mv.areaBoxOk', _simMoveAreaBoxOk);
    }
}
function _simMoveEnsureAreaBox(area, steps) {
    _simMoveAreaBoxes();
    const k = area * SIM_MOVE_BOX_STEPS + steps;
    if (!(k >= 0 && k < _simMoveAreaBoxOk.length) || _simMoveAreaBoxOk[k]) return;
    _simMoveAreaSource[0] = area;
    const box = getAreaRangeTileBox(_simMoveAreaSource, steps);
    // No area in reach: an empty box (nothing can be possible there).
    if (box[2] < 0) { _simMoveAreaBox[k * 4] = 1; _simMoveAreaBox[k * 4 + 1] = 1; _simMoveAreaBox[k * 4 + 2] = 0; _simMoveAreaBox[k * 4 + 3] = 0; }
    else for (let j = 0; j < 4; j++) _simMoveAreaBox[k * 4 + j] = box[j];
    _simMoveAreaBoxOk[k] = 1;
}

// Walls per tile (grid type TYPE_WALL), kept in step where tile types
// change (simMoveTileTypeChanged) and rebuilt with the grid.
let _simMoveWall = null, _simMoveWallGrid = null, _simMoveWallDirty = true;
// Bumped whenever a wall changes (the kernel's cached look-aheads check it).
let _simMoveWallVer = 0;
function simMoveTileTypeChanged(gx, gy) {
    if (typeof stepCostsChanged === 'function') stepCostsChanged(gx, gy);
    if (!_simMoveWall || _simMoveWallGrid !== grid || _simMoveWall.length !== GRID_W * GRID_H) { _simMoveWallDirty = true; return; }
    const row = grid[gy], cell = row ? row[gx] : null;
    if (gx >= 0 && gx < GRID_W && cell) {
        const w = cell.type === TYPE_WALL ? 1 : 0, k = gy * GRID_W + gx;
        if (_simMoveWall[k] !== w) {
            const was = _simMoveWall[k];
            _simMoveWall[k] = w; _simMoveWallVer = (_simMoveWallVer + 1) | 0;
            if (typeof navWallChanged === 'function') navWallChanged(k, was, w);
        }
    }
}
function simMoveWallsDirty() { _simMoveWallDirty = true; if (typeof stepCostsReset === 'function') stepCostsReset(); }
// The wall table, current (1: grid type TYPE_WALL).
function simMoveWallGrid() { _simMoveWalls(); return _simMoveWall; }
function _simMoveWalls() {
    if (!_simMoveWallDirty && _simMoveWallGrid === grid && _simMoveWall && _simMoveWall.length === GRID_W * GRID_H) return;
    if (!_simMoveWall || _simMoveWall.length !== GRID_W * GRID_H) { _simMoveWall = simSharedArray(Uint8Array, GRID_W * GRID_H); simParallelBind('mv.wall', _simMoveWall); }
    for (let y = 0; y < GRID_H; y++) {
        const row = grid[y], o = y * GRID_W;
        for (let x = 0; x < GRID_W; x++) _simMoveWall[o + x] = row && row[x] && row[x].type === TYPE_WALL ? 1 : 0;
    }
    _simMoveWallGrid = grid; _simMoveWallDirty = false; _simMoveWallVer = (_simMoveWallVer + 1) | 0;
    if (typeof _navWallDiffReset === 'function') _navWallDiffReset();
    if (typeof stepCostsReset === 'function') stepCostsReset();
}

// Structures by tile, for "hostile to player p?" without the tables of
// every player: -1 none, p when owned by p alone (the structure and its
// cell), -2 otherwise (hostile to everyone). Mines count as none. Tiles
// whose tile entity changed are redone at the next kernel run; per block
// and player, the count of structures hostile to that player.
let _simMoveStruct = null, _simMoveStructBlocks = null, _simMoveStructSet = null, _simMoveStructDims = '';
let _simMoveStructDirty = [];
// Cell owners replaced (a restore): every tile's code again.
function simMoveStructsReset() { _simMoveStructDims = ''; }
function simMoveTileEntityChanged(gx, gy) {
    if (_simMoveStruct) _simMoveStructDirty.push(gy * GRID_W + gx);
}
function _simMoveStructCode(gx, gy) {
    const refs = tileEntityRef[gy], e = refs ? refs[gx] : null;
    if (!e) return -1;
    const type = tileEntityType[gy][gx];
    if (type === TILE_ENTITY_GOLDMINE || type === TILE_ENTITY_ASTARMINE) return -1;
    const cell = grid[gy] && grid[gy][gx];
    const cellOwner = cell && cell.item === e ? cell.owner : e.owner;
    return Number.isInteger(e.owner) && e.owner >= 0 && e.owner === cellOwner && e.owner < 127 ? e.owner : -2;
}
function _simMoveStructCount(tile, code, delta) {
    const players = spatialUnitsComplexPlayerCount, gx = tile % GRID_W, gy = (tile - gx) / GRID_W;
    const b = (Math.floor(gy / (SPATIAL_BLOCK_SIZE * CHUNK_SIZE)) * spatialBlockCols + Math.floor(gx / (SPATIAL_BLOCK_SIZE * CHUNK_SIZE))) * players;
    for (let p = 0; p < players; p++) if (code !== p) _simMoveStructBlocks[b + p] += delta;
}
function _simMoveStructs() {
    const players = spatialUnitsComplexPlayerCount, dims = GRID_W + 'x' + GRID_H + ':' + players + ':' + spatialBlockCols;
    if (!_simMoveStruct || _simMoveStructSet !== _activeTileEntities || _simMoveStructDims !== dims) {
        if (!_simMoveStruct || _simMoveStruct.length !== GRID_W * GRID_H) { _simMoveStruct = simSharedArray(Int8Array, GRID_W * GRID_H); simParallelBind('mv.struct', _simMoveStruct); }
        _simMoveStruct.fill(-1);
        _simMoveStructBlocks = new Int32Array(spatialBlockCols * spatialBlockRows * players);
        for (const e of _activeTileEntities) {
            const gx = e.gx, gy = e.gy;
            if (!(gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H)) continue;
            const t = gy * GRID_W + gx;
            if (_simMoveStruct[t] !== -1) continue;
            const code = _simMoveStructCode(gx, gy);
            _simMoveStruct[t] = code;
            if (code !== -1) _simMoveStructCount(t, code, 1);
        }
        _simMoveStructSet = _activeTileEntities; _simMoveStructDims = dims; _simMoveStructDirty.length = 0;
        return;
    }
    const dirty = _simMoveStructDirty;
    for (let i = 0; i < dirty.length; i++) {
        const t = dirty[i], gx = t % GRID_W, gy = (t - gx) / GRID_W;
        const old = _simMoveStruct[t], code = _simMoveStructCode(gx, gy);
        if (old === code) continue;
        if (old !== -1) _simMoveStructCount(t, old, -1);
        if (code !== -1) _simMoveStructCount(t, code, 1);
        _simMoveStruct[t] = code;
    }
    dirty.length = 0;
}

// Per player and block of the spatial index: enemy units plus structures
// hostile to the player, as summed-area tables (the kernel's "anything in
// reach?").
let _simMoveHostile = null;
function _simMoveBuildHostile() {
    _simMoveStructs();
    const players = spatialUnitsComplexPlayerCount, bc = spatialBlockCols, br = spatialBlockRows;
    const stride = bc + 1, plane = stride * (br + 1);
    if (!_simMoveHostile || _simMoveHostile.length < players * plane) {
        _simMoveHostile = simSharedArray(Int32Array, Math.max(1, players * plane));
        simParallelBind('mv.hostile', _simMoveHostile);
    }
    const H = _simMoveHostile, counts = spatialBlockCounts, st = _simMoveStructBlocks;
    for (let p = 0; p < players; p++) {
        const o = p * plane;
        H.fill(0, o, o + stride);
        for (let by = 0; by < br; by++) {
            const row = o + (by + 1) * stride, above = row - stride;
            H[row] = 0;
            let run = 0;
            for (let bx = 0; bx < bc; bx++) {
                const base = (by * bc + bx) * players;
                let v = st[base + p];
                for (let q = 0; q < players; q++) if (q !== p) v += counts[base + q];
                run += v;
                H[row + bx + 1] = H[above + bx + 1] + run;
            }
        }
    }
}

// The area graph for the kernels (area.off, area.nb: each area's
// neighbours, as areaNeighborIds), rebuilt with the area layout.
let _simAreaCsrFor = null;
// The walls as the kernel saw them (holds are checked against them).
let _simMoveRunWallVer = -1;
function _simAreaCsr() {
    if (_simAreaCsrFor === areaNeighborIds) return;
    const L = Array.isArray(areaNeighborIds) ? areaNeighborIds : [], A = L.length;
    let total = 0;
    for (let a = 0; a < A; a++) total += L[a] ? L[a].length : 0;
    const off = simSharedArray(Int32Array, A + 1), nb = simSharedArray(Int32Array, Math.max(1, total));
    let k = 0;
    for (let a = 0; a < A; a++) { off[a] = k; const l = L[a]; if (l) for (let i = 0; i < l.length; i++) nb[k++] = l[i]; }
    off[A] = k;
    simParallelBind('area.off', off); simParallelBind('area.nb', nb);
    _simAreaCsrFor = areaNeighborIds;
}

// Runs the armed units' tick (before the update pass), then charges their
// node steps to their owners and updates the spatial index and visibility
// of those that moved into another tile or window.
let _simMoveSpendTypes = null;
function simMoveRun() {
    const S = _simUnitState;
    if (!S || !spatialBlockCols || spatialBlockCounts.length !== spatialBlockCols * spatialBlockRows * spatialUnitsComplexPlayerCount) return;
    const n = S.owners.length;
    if (!n) return;
    const c = S.columns, players = spatialUnitsComplexPlayerCount;
    if (typeof _precomputedStatsVersion !== 'undefined' && _simMoveStatsVersion !== _precomputedStatsVersion) simMoveRefreshAllStats();
    _simMoveBuildHostile();
    _simMoveWalls();
    _simMoveAreaBoxes();
    // Every armed shooter's box is present (the table is a cache that may
    // have been reset: the kernel's outcome must not depend on it).
    {
        const ON = c.mvOn, FL = c.mvFlags, AR = c.spArea, RE = c.mvReach, ok = _simMoveAreaBoxOk;
        for (let s = 0; s < n; s++) {
            if (!ON[s] || (FL[s] & 1) === 0) continue;
            const a = AR[s];
            if (a >= 0 && !ok[a * SIM_MOVE_BOX_STEPS + RE[s]]) _simMoveEnsureAreaBox(a, RE[s]);
        }
    }
    const P = _simParams;
    P[0] = n; P[1] = 4096; P[2] = gameTime; P[3] = TICK_RATE; P[4] = 0; P[5] = GRID_W; P[6] = GRID_H;
    P[7] = TILE; P[8] = UNIT_POSITION_QUANTIZATION; P[9] = spatialBlockCols; P[10] = spatialBlockRows;
    P[11] = players; P[12] = CMD_MOVING; P[13] = CMD_ATTACK_MOVING; P[14] = SPATIAL_BLOCK_SIZE * CHUNK_SIZE; P[15] = SIM_SEP_ABSENT;
    P[16] = SIM_MOVE_WINDOW; P[17] = SIM_MOVE_BOX_STEPS; P[18] = SIM_FLOW_ARRIVE; P[19] = _simMoveWallVer;
    P[20] = Math.max(0, Number(CROSS_TEAM_UNIT_COLLISION_PADDING) || 0) + UNIT_CONTACT_ATTACK_MARGIN;
    P[21] = WORKER_MOVE_CHECK_TICKS;
    _simAreaCsr();
    // (Attack holds: sight by area, the area of each tile.)
    if (typeof _visCoverReady === 'function' && _visCoverReady()) simParallelBind('vis.cover', _visCover.cover);
    simParallelBind('ix.agrid', _spatialAreaGridFlat());
    if (typeof _flowTables === 'function') _flowTables();
    simParallelRun(SIM_KERNEL_MOVE, Math.ceil(n / 4096));
    _simMoveRunWallVer = _simMoveWallVer;
    const OUT = c.mvOut, owners = S.owners;
    let slow = null, charged = false;
    for (let s = 0; s < n; s++) {
        const o = OUT[s];
        if (o === 0) continue;
        if (c.mvSpent[s]) charged = true;
        if (o === 1 || o === 6) continue;
        // Arrived in the crowd at its destination: the move is done.
        if (o === 5) { const u = owners[s]; if (u && !u.dead) simFlowArrive(u); continue; }
        // Into a wall tile: the end of Unit.update (pushed out; can start
        // path work on the owner's budget): in id order afterwards.
        if (o === 4) { if (owners[s]) (slow ||= []).push(owners[s]); continue; }
        // A window zone covering other areas, or another tile: the spatial
        // index and visibility, from the columns.
        spatialSlotUpdate(c, s);
        // A drive-by shooter entering another area needs its box.
        if (o === 3 && (c.mvFlags[s] & 1) && c.spArea[s] >= 0) _simMoveEnsureAreaBox(c.spArea[s], c.mvReach[s]);
    }
    if (charged) _simMoveChargeSteps(S);
    if (slow) {
        slow.sort((a, b) => a.id - b.id);
        for (const u of slow) {
            if (u.dead) continue;
            pushUnitOutOfBlockedTile(u);
            u.x = _quantizeUnitWorldCoord(u.x); u.y = _quantizeUnitWorldCoord(u.y);
            updateUnitSpatial(u);
        }
    }
}

// The kernel's node steps, charged like _tryConsumeAstarMoveCost (one spend
// of the unit's cost per step, a unit marked when its owner could not cover
// it), in the units array's order, summed per
// owner and unit type for the usage log.
function _simMoveChargeSteps(S) {
    const c = S.columns, slots = _unitSlotMapEnsure(), owners = S.owners, SPENT = c.mvSpent;
    const types = _simMoveSpendTypes || (_simMoveSpendTypes = new Map());
    types.clear();
    const remaining = [];
    const names = _spatialUnitTypeNames();
    for (let i = 0; i < units.length; i++) {
        const s = slots[i];
        if (s < 0 || !SPENT[s] || owners[s] !== units[i]) continue;
        const k = SPENT[s], pid = c.owner[s], cost = c.mvCost[s];
        SPENT[s] = 0;
        if (!(cost > 0) || !(pid >= 0) || !players[pid]) continue;
        // As _tryConsumeAstarMoveCost: a step the owner cannot cover still
        // happens, and marks the unit (the budget glyph, a retry delay).
        let rem = remaining[pid];
        if (rem === undefined) rem = remaining[pid] = _getPlayerAstarBudgetRemaining(pid) + _fromFixedResourceUnits(_pendingMovementAstarFixed[pid] || 0);
        for (let j = 0; j < k; j++) { if (rem < cost) _setUnitAstarBudgetBlockedIndicator(units[i], 1); rem -= cost; }
        remaining[pid] = rem;
        _pendingMovementAstarFixed[pid] = (_pendingMovementAstarFixed[pid] || 0) + k * _toFixedResourceUnits(-cost);
        const type = names[c.spType[s]] || 'norm', key = pid * 64 + c.spType[s];
        let row = types.get(key);
        if (!row) types.set(key, row = { pid, unit: { unitType: type }, used: 0 });
        for (let j = 0; j < k; j++) row.used += cost;
    }
    for (const row of types.values()) _recordAstarUsage(row.pid, row.used, row.unit, 'movement');
}

// Unit type names by spatial type index (the spType column).
let _spatialTypeNames = [], _spatialTypeNamesFor = null;
function _spatialUnitTypeNames() {
    if (_spatialTypeNamesFor !== spatialUnitTypeToIndex) {
        _spatialTypeNames = [];
        for (const k in spatialUnitTypeToIndex) _spatialTypeNames[spatialUnitTypeToIndex[k]] = k;
        _spatialTypeNamesFor = spatialUnitTypeToIndex;
    }
    return _spatialTypeNames;
}

// The nearest visible enemy unit within `range` of an idle or attack-moving
// unit: this tick's combat scan (the world at the start of the update pass),
// else (another range, a unit the scan did not cover, or a target killed
// since) the query.
function _combatScanTarget(u, range) {
    const c = u._us;
    if (c) {
        const s = u._si;
        if (c.cbTick[s] === gameTime && c.cbRange[s] === range) {
            const q = c.cbT[s];
            if (q < 0) return null;
            const e = _simUnitState.owners[q];
            if (e && !e.dead) return e;
        }
    }
    return _findClosestEnemyUnitByChunks(u.owner, u.x, u.y, range);
}
// Runs the combat scan for every idle or attack-moving unit before the
// update pass (in parallel; see SIM_KERNEL_COMBAT_SCAN).
function combatScanRun() {

    const S = _simUnitState;
    if (!S || typeof SIM_KERNEL_COMBAT_SCAN !== 'number') return;
    const n = S.owners.length;
    if (!n || !_visCoverReady() || !_simMoveHostile || !spatialBlockCols) return;
    if (spatialIndexEntries() <= 0) return;
    simParallelBind('vis.cover', _visCover.cover);
    simParallelBind('sep.eslot', _sxESlot); simParallelBind('sep.rs', _sxStart); simParallelBind('sep.rc', _sxCount); simParallelBind('sep.rstamp', _sxStamp);
    const P = _simParams;
    P[0] = n; P[1] = 2048; P[2] = gameTime; P[3] = CHUNKS_W; P[4] = CHUNKS_H; P[5] = TILE; P[6] = _sxEpoch;
    P[7] = Math.min(spatialUnitsComplexPlayerCount, _visCover.players); P[8] = CMD_IDLE; P[9] = CMD_ATTACK_MOVING;
    P[10] = SPATIAL_BLOCK_SIZE * CHUNK_SIZE; P[11] = spatialBlockCols; P[12] = spatialBlockRows; P[13] = SIM_SEP_ABSENT; P[14] = CHUNK_SIZE;
    P[15] = GRID_W; P[16] = GRID_H;
    simParallelBind('ix.agrid', _spatialAreaGridFlat());
    simParallelRun(SIM_KERNEL_COMBAT_SCAN, Math.ceil(n / 2048));
}

// After the update pass: no unit counts as moved by the kernel any more
// (a later Unit.update call runs in full).
function simMoveEndTick() {
    const S = _simUnitState;
    if (S) S.columns.mvOut.fill(0, 0, S.owners.length);
}

// Large worlds: the entries are the unit index's (spatialIndexRebuild,
// just before this pass), grouped by chunk, with each entry's slot; the
// kernels read the unit state columns, nothing is gathered from objects.
function _prepareSharedUnitSeparation(S, restTicks) {
    const n = spatialIndexEntries();
    if (!n) return 0;
    simParallelBind('sep.eslot', _sxESlot); simParallelBind('sep.ekey', _sxEKey);
    simParallelBind('sep.rs', _sxStart); simParallelBind('sep.rc', _sxCount); simParallelBind('sep.rstamp', _sxStamp);
    _simParams[0] = n; _simParams[1] = 512;
    _simParams[2] = restTicks; _simParams[3] = gameTime;
    simParallelRun(SIM_KERNEL_SEPARATION_PREPARE, Math.ceil(n / 512));
    _simParams[0] = n; _simParams[1] = 2048; _simParams[2] = _sxEpoch; _simParams[3] = CHUNKS_W; _simParams[4] = CHUNKS_H;
    simParallelRun(SIM_KERNEL_SEPARATION_YIELD, Math.ceil(n / 2048));
    return n;
}

// How far a unit may have moved within a tick since the unit index was
// built (a unit's step plus a push), for the collision pass's culling.
const UNIT_SEPARATION_INDEX_MARGIN = TILE * 0.5;
function runUnitSeparationPass() {
    let n = units.length;
    // Large worlds run on unit state slots (outputs by slot), small ones on
    // the units array (outputs by index).
    const U = _simUnitState;
    const bySlot = n >= 4096 && !!U && CHUNKS_W * CHUNKS_H < SIM_SEP_ABSENT;
    if (bySlot) n = U.owners.length;
    _sepGrow(n);
    let S = _sep, R = S.r, L = S.layer, C = S.check;
    let restTicks = getUnitCollisionRecalcTicks();
    let any = false;
    let nChunks = CHUNKS_W * CHUNKS_H, cap = S.cap;
    let chunkR = _sepShared(S, 'chunkR', Float64Array, nChunks), chunkC = _sepShared(S, 'chunkC', Uint8Array, nChunks);
    let sole = _sepShared(S, 'sole', Int32Array, nChunks), start = _sepShared(S, 'start', Int32Array, nChunks + 1);
    if (!S.fillPos || S.fillPos.length < nChunks) S.fillPos = new Int32Array(nChunks);
    if (!S.key || S.key.length < cap) S.key = new Int32Array(cap);
    let ord = _sepShared(S, 'ord', Int32Array, cap), sx = _sepShared(S, 'sx', Float64Array, cap), sy = _sepShared(S, 'sy', Float64Array, cap);
    let sr = _sepShared(S, 'sr', Float64Array, cap), so = _sepShared(S, 'so', Int32Array, cap), sl = _sepShared(S, 'sl', Uint8Array, cap);
    let sc = _sepShared(S, 'sc', Uint8Array, cap), sid = _sepShared(S, 'sid', Float64Array, cap);
    let slots = _sepShared(S, 'slots', Int32Array, cap), keys = _sepShared(S, 'keys', Int32Array, cap);
    let jobs = _sepShared(S, 'jobs', Int32Array, cap), jobCount = 0;
    let sdx = _sepShared(S, 'sdx', Float64Array, cap), sdy = _sepShared(S, 'sdy', Float64Array, cap);
    let PX = _sepShared(S, 'px', Float64Array, cap), PY = _sepShared(S, 'py', Float64Array, cap);
    let OV = _sepShared(S, 'ov', Float64Array, cap), HIT = _sepShared(S, 'hit', Uint32Array, cap);
    let K = S.key;
    PX.fill(0, 0, n); PY.fill(0, 0, n); OV.fill(0, 0, n); HIT.fill(0, 0, n);
    let epoch = 1;
    if (!S.margin) { S.margin = simSharedArray(Float64Array, 1); simParallelBind('sep.margin', S.margin); }
    // (The shared index is from the tick's start: allow for a tick's movement.)
    S.margin[0] = bySlot ? UNIT_SEPARATION_INDEX_MARGIN : 0;
    if (bySlot) {
        jobCount = _prepareSharedUnitSeparation(S, restTicks);
        if (!jobCount) return;
        epoch = _sxEpoch;
    } else {
    chunkR.fill(0, 0, nChunks); chunkC.fill(0, 0, nChunks); sole.fill(-2, 0, nChunks); start.fill(0, 0, nChunks + 1);
    for (let i = 0; i < n; i++) {
        let u = units[i];
        let r = +u.collisionR || +u.r || 0.1;
        R[i] = r < 0.1 ? 0.1 : r;
        L[i] = u.isFlying ? 1 : (u.unitType === 'mole' ? 2 : 0);
        let c = !u.dead && (u.x !== u.prevX || u.y !== u.prevY || restTicks <= 1 || ((gameTime + u.id) % restTicks) === 0);
        C[i] = (c ? 1 : 0) | (!u.dead && (u.x !== u.prevX || u.y !== u.prevY) ? 3 : 0);
        if (c) any = true;
        // Units in the spatial buckets (alive), by tile.
        let key = u._spatialKey;
        if (u.dead || !(key >= 0 && key < nChunks)) { K[i] = -1; continue; }
        K[i] = key;
        start[key + 1]++;
        if (R[i] > chunkR[key]) chunkR[key] = R[i];
        // (Chunks where a unit moved: units at rest around them give way,
        // see SIM_KERNEL_SEPARATION_YIELD.)
        if (!u.dead && (u.x !== u.prevX || u.y !== u.prevY)) chunkC[key] = 1;
        let s0 = sole[key];
        sole[key] = s0 === -2 ? u.owner : (s0 === u.owner ? s0 : -1);
    }
    if (!any) return;
    // Counting sort by tile (stable: unit order within a tile).
    for (let c = 0; c < nChunks; c++) start[c + 1] += start[c];
    let fill = S.fillPos;
    fill.set(start.subarray(0, nChunks));
    for (let i = 0; i < n; i++) {
        let key = K[i];
        if (key < 0) continue;
        let k = fill[key]++;
        if (!(C[i] & 1)) {
            const cx = key % CHUNKS_W, cy = (key - cx) / CHUNKS_W;
            for (let oy = -1; oy <= 1 && !(C[i] & 1); oy++) for (let ox = -1; ox <= 1; ox++) {
                const nx = cx + ox, ny = cy + oy;
                if (nx >= 0 && ny >= 0 && nx < CHUNKS_W && ny < CHUNKS_H && chunkC[ny * CHUNKS_W + nx]) { C[i] |= 1; break; }
            }
        }
        ord[k] = i; sl[k] = L[i]; sc[k] = C[i]; keys[k] = key;
        if (C[i]) jobs[jobCount++] = k;
        let u = units[i];
        slots[k] = u._si;
        // Packed straight from the unit (small worlds, see SIM_KERNEL_UNIT_PACK).
        sx[k] = u.x; sy[k] = u.y; sr[k] = R[i]; so[k] = u.owner; sid[k] = u.id || 0;
        // Where it leaves an exact overlap: sideways to its motion (or path).
        if (C[i]) {
            let mdx = u.vx, mdy = u.vy;
            if (detHypot(mdx, mdy) < 0.001 && u.path && u.pathIndex < u.path.length) {
                let pn = u.path[u.pathIndex];
                mdx = pn.x * TILE + 16 - u.x;
                mdy = pn.y * TILE + 16 - u.y;
            }
            sdx[k] = mdx; sdy[k] = mdy;
        }
    }
    // Chunk ranges in the kernel's form (every chunk stamped).
    let rs = _sepShared(S, 'rs', Int32Array, nChunks), rc = _sepShared(S, 'rc', Int32Array, nChunks), rstamp = _sepShared(S, 'rstamp', Int32Array, nChunks);
    for (let c = 0; c < nChunks; c++) { rs[c] = start[c]; rc[c] = start[c + 1] - start[c]; rstamp[c] = 1; }
    simParallelBind('sep.rs', rs); simParallelBind('sep.rc', rc); simParallelBind('sep.rstamp', rstamp);
    }
    let pad = Math.max(0, Number(CROSS_TEAM_UNIT_COLLISION_PADDING) || 0);
    let maxR = Math.max(0.1, _maxUnitCollisionRadius());
    let cws = CHUNK_SIZE * TILE;
    let farAny = 2 * maxR + pad;
    let reach = Math.max(1, Math.ceil(farAny / cws));
    // Neighbour tile offsets (all around) with the least distance between
    // the tiles.
    if (!S.offs || S.offsReach !== reach || S.offsCws !== cws) {
        let list = [];
        for (let oy = -reach; oy <= reach; oy++) for (let ox = -reach; ox <= reach; ox++) {
            if (ox === 0 && oy === 0) continue;
            let gx = Math.max(0, Math.abs(ox) - 1), gy = Math.max(0, Math.abs(oy) - 1);
            list.push(ox, oy, Math.sqrt(gx * gx + gy * gy) * cws);
        }
        let offs = simSharedArray(Float64Array, list.length);
        offs.set(list);
        S.offs = offs; S.offsReach = reach; S.offsCws = cws;
        simParallelBind('sep.offs', offs);
    }
    let unitsPerJob = 128;
    let P = _simParams;
    P[0] = CHUNKS_W; P[1] = CHUNKS_H; P[2] = unitsPerJob; P[3] = pad; P[4] = farAny; P[5] = UNIT_SEPARATION_Q;
    P[6] = UNIT_SEPARATION_SHARE_BOTH; P[7] = UNIT_SEPARATION_SHARE_ONE; P[8] = S.offs.length / 3;
    P[9] = jobCount; P[10] = cws; P[11] = epoch; P[12] = UNIT_SEPARATION_SHARE_MOVER; P[13] = UNIT_SEPARATION_SHARE_YIELD;
    simParallelRun(SIM_KERNEL_SEPARATION, Math.ceil(jobCount / unitsPerJob));
    const useSharedFinish = bySlot;
    if (useSharedFinish) {
        _sepShared(S, 'nextX', Float64Array, cap); _sepShared(S, 'nextY', Float64Array, cap);
        _sepShared(S, 'fast', Uint8Array, cap);
        P[0] = n; P[1] = 512; P[2] = TILE; P[3] = UNIT_POSITION_QUANTIZATION;
        P[4] = UNIT_SEPARATION_CONTACTS; P[5] = UNIT_SEPARATION_Q; P[6] = gameTime; P[7] = UNIT_SEPARATION_PATH_RETRY_TICKS;
        P[8] = GRID_W; P[9] = GRID_H;
        simMoveWallGrid();
        simParallelRun(SIM_KERNEL_SEPARATION_FINISH, Math.ceil(n / 512));
    }
    // Path retries spend the owner's search budget: run them in id order
    // after the commit (slot order differs between peers).
    let retries = null, slow = null;
    const owners = bySlot ? U.owners : units;
    for (let i = 0; i < n; i++) {
        if (!HIT[i] || (useSharedFinish && S.fast[i] === 1)) continue;
        if (useSharedFinish && S.fast[i]) {
            // Committed by the kernel (same tile); 2: zone or retry work
            // (the object only on the unit's retry ticks).
            const c = U.columns;
            if (((gameTime + c.id[i]) | 0) % UNIT_SEPARATION_PATH_RETRY_TICKS === 0) {
                const u = owners[i];
                if (u && !u.dead && u.pathIsFallbackAstar && u._pendingPathTarget) (retries ||= []).push(u);
            }
            if (c.energy[i] > 0) spatialSlotUpdate(c, i);
            continue;
        }
        let u = owners[i];
        if (!u || u.dead) continue;
        // The rest can reach order-dependent work (a path retry after a push
        // out of a blocked tile): with slots, done afterwards in id order.
        if (bySlot) { (slow ||= []).push(i); continue; }
        _commitUnitSeparation(u, i, HIT, PX, PY, OV, (v) => (retries ||= []).push(v));
    }
    if (slow) {
        slow.sort((a, b) => owners[a].id - owners[b].id);
        for (let i of slow) _commitUnitSeparation(owners[i], i, HIT, PX, PY, OV, (v) => (retries ||= []).push(v));
    }
    if (retries) {
        if (bySlot) retries.sort((a, b) => a.id - b.id);
        for (let u of retries) _tryUpgradeAstarFallbackPath(u);
    }
}

// The swept commit of one unit's summed pushes (see runUnitSeparationPass).
function _commitUnitSeparation(u, i, HIT, PX, PY, OV, retry) {
    {
        // All contacts are resolved at once: beyond a few, their sum is
        // damped by sqrt(contacts) (full sums overshoot and oscillate in a
        // dense crowd; a plain average cannot hold a crowd pressing in).
        // applyUnitSeparation bounds it by the deepest overlap.
        let k = HIT[i], scale = k <= UNIT_SEPARATION_CONTACTS ? 1 : Math.sqrt(UNIT_SEPARATION_CONTACTS / k);
        let px = PX[i] * scale / UNIT_SEPARATION_Q, py = PY[i] * scale / UNIT_SEPARATION_Q;
        if (px !== 0 || py !== 0) applyUnitSeparation(u, px, py, OV[i]);
        // A unit bumping along a fallback path retries its real path now
        // and then (staggered), not on every tick of contact.
        if (u.pathIsFallbackAstar && u._pendingPathTarget && ((gameTime + u.id) % UNIT_SEPARATION_PATH_RETRY_TICKS) === 0) retry(u);
        pushUnitOutOfBlockedTile(u);
        u.x = _quantizeUnitWorldCoord(u.x);
        u.y = _quantizeUnitWorldCoord(u.y);
        updateUnitSpatial(u);
    }
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
    if (canUnitOccupyTileCached(unit, gx, gy, 0)) return;

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
