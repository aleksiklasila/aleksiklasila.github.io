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
            let rank = turret ? 0 : isTrapItem(target) ? 2 : 3;
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
    // (Enemies where they were at the pass's start: _unitTickX.)
    forEachUnitInRange(unit.x, unit.y, range, (enemy, d2) => {
        if (enemy.dead || enemy.owner === unit.owner || !_isUnitVisibleAtTickStart(unit.owner, enemy)) return;
        if (d2 < best || (d2 === best && (!closest || enemy.id < closest.id))) {
            closest = enemy; best = d2;
        }
    }, { enemyOfPlayer: unit.owner, tickStart: true });
    return closest;
}

// Whether any enemy unit or hostile structure may be within `steps` area
// steps of `area` (conservative: whole blocks and area boxes), for `owner`.
// Cached for the tick: units of a crowd share their areas. A unit's +-0.3
// tile window reaches at most one area further than its own, which callers
// add to `steps`.
let _hostileNearCache = new Map(), _hostileNearCacheTick = -1, _hostileNearCacheFor = null;
const _hostileNearSource = [0];
// The end of Unit.update (and of the kernel outputs' commits that stand for
// one): pushed out of a blocked tile, quantized, indexed, the drive-by shot
// of a unit that was on the move, armed again for the kernels.
// (Unit separation runs for all units at once after the updates,
// runUnitSeparationPass.)
function _unitUpdateEnd(u, cols, driveBy) {
    pushUnitOutOfBlockedTile(u);
    u.x = _quantizeUnitWorldCoord(u.x);
    u.y = _quantizeUnitWorldCoord(u.y);
    updateUnitSpatial(u);
    if (driveBy) u.tryDriveByAttack();
    if (cols) _unitArmAgain(u, cols);
}
function _unitArmAgain(u, cols) {
    const cmd = u.commandState;
    if (cmd === CMD_MOVING || cmd === CMD_ATTACK_MOVING) { if (u.holdPosition) simMoveTryParkHeld(u, cmd); else simMoveTryArm(u); }
    else if (cmd === CMD_IDLE && u.workerState && u.workerTransferCooldown > 0) simMoveTryParkWork(u);
    else if (cmd === CMD_IDLE && u.workerState === 'IDLE') simMoveTryPark(u);
    else if (cmd === CMD_IDLE && !u.workerState) simMoveTryParkIdle(u);
    else if (cmd === CMD_ATTACKING) {
        simMoveTryHold(u);
        const on = cols.mvOn[u._si];
        if (on !== 3 && on !== 5) { simMoveTryChase(u); if (cols.mvOn[u._si] !== 4) _simMoveTryApproachBuilding(u); }
    }
}
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
// Arriving in a crowd (Unit._followNavNode and the movement kernel's flow
// mode): within this many tiles of a group's destination, a unit held back
// beside an idle unit of its own owner has arrived.
const NAV_CROWD_TILES = 64;
function _unitCrowdIdleNear(u) {
    const c = u._us;
    return !!c && c.cwTick[u._si] === gameTime && c.cwNear[u._si] === 1;
}
// Fewer than 9 units listed in its 3x3 tiles at the tick's start: a waiting
// unit goes on.
function _unitCrowdThin(u) {
    const c = u._us;
    return !!c && c.cwTick[u._si] === gameTime && c.cwDense[u._si] < 9;
}

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
// (Outside the pass, where it is.)
let _unitPassOn = false;
function unitPassBegin() { _unitPassOn = true; spatialCountsDeferBegin(); astarPassStart(); }
function unitPassEnd() {
    _unitPassOn = false;
    // (The kernels' chunk moves: counted once, after the separation commit,
    // when one follows this tick.)
    spatialCountsDeferEnd(!!(_sepPending && _sepPending.tick === gameTime));
    astarPassEnd(); simMoveWallsDeferEnd();
}
function _unitTickX(t) { const c = t._us; return c && _unitPassOn ? c.x0[t._si] : t.x; }
function _unitTickY(t) { const c = t._us; return c && _unitPassOn ? c.y0[t._si] : t.y; }
// Any target (units as _unitTickX, other things where they are).
// Whether another unit counts as dead during the pass: as at its start
// (the movement kernel's dead0, this tick), whatever fell since (a ram's
// recoil, a mine): its hits are dropped after the pass anyway.
let _simDead0Tick = -1;
function _unitTickDead(t) { const c = t._us; return c && _unitPassOn && _simDead0Tick === gameTime ? c.dead0[t._si] === 1 : !!t.dead; }
function _thingTickX(t) { return t instanceof Unit ? _unitTickX(t) : t.x; }
function _thingTickY(t) { return t instanceof Unit ? _unitTickY(t) : t.y; }
// Whether `player` sees the tile unit t stood on at the pass's start (a
// thing with a tile of its own, gx/gy: that tile, as _isHostileThingVisibleToUnit).
function _isUnitVisibleAtTickStart(player, t) {
    const gx = Number.isFinite(t.gx) ? Math.floor(t.gx) : Math.floor(_unitTickX(t) / TILE);
    const gy = Number.isFinite(t.gy) ? Math.floor(t.gy) : Math.floor(_unitTickY(t) / TILE);
    return isGameplayTargetVisibleToPlayer(player, gx, gy);
}

function _isUnitTargetInContactAt(unit, target, tx, ty, maxAreaDistance) {
    if (!(target instanceof Unit) || _unitTickDead(target) || !(unit.preComputed.attackDamage > 0)) return false;
    let dx = tx - unit.x, dy = ty - unit.y;
    let reach = unit.getCollisionRadius() + target.getCollisionRadius()
        + Math.max(0, Number(CROSS_TEAM_UNIT_COLLISION_PADDING) || 0) + UNIT_CONTACT_ATTACK_MARGIN;
    if (dx * dx + dy * dy > reach * reach) return false;
    let ugx = Math.floor(unit.x / TILE), ugy = Math.floor(unit.y / TILE);
    let tgx = Math.floor(tx / TILE), tgy = Math.floor(ty / TILE);
    let sx = tgx - ugx, sy = tgy - ugy;
    if (Math.abs(sx) > 1 || Math.abs(sy) > 1) return false;
    if (sx !== 0 && sy !== 0) {
        // (The walls as the movement kernel has them: during the unit pass,
        // as at its start, see simMoveWallGrid.)
        const wall = simMoveWallGrid();
        const in1 = tgx >= 0 && tgx < GRID_W && ugy >= 0 && ugy < GRID_H, in2 = ugx >= 0 && ugx < GRID_W && tgy >= 0 && tgy < GRID_H;
        if ((!in1 || wall[ugy * GRID_W + tgx]) && (!in2 || wall[tgy * GRID_W + ugx])) return false;
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
        if (this._us) { this._us.x0[this._si] = x; this._us.y0[this._si] = y; this._us.upT[this._si] = simUnitTypeIndex(unitType); if (typeof upkeepUnitRefresh === 'function') upkeepUnitRefresh(this); }
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
        // (The fields a move order writes, together: see _issueGroupMoveOrder.)
        this._routeKey = null; this._routeEnd = -1; this._routeSegEnd = -1; this._navReady = 0; this._attackMoveGx = undefined; this._attackMoveGy = undefined; this.pathIsFallbackAstar = undefined; this._pendingPathTarget = undefined; this.holdPosition = undefined; this._awaitGroupPath = 0;
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
        this._floorTile = -1; this._removedNow = false; this._pendingDueStamp = -1; this._okTile = -1; this._okVer = 0; this._okNodeTile = -1; this._okNodeVer = 0; this._thingStatsRefreshStamp = 0; this._effectiveStatsStamp = 0; this._statsVer = -1; this._navLastD = -1; this._vsGen = 0; this._vsR = -1; this._vsA = -1; this._vsP1 = -1; this._vsP2 = -1;
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
        this.researcherHasMaterial = undefined;
        this._astarLastChargedTick = undefined; this._astarLastChargedFromKey = undefined; this._astarLastChargedToKey = undefined;
        
        this._astarBudgetBlockedUntil = undefined; this._astarBudgetRetryTick = undefined;
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
        this._ambientSoundTicks = undefined;

        this._spatialKey = undefined; this._spatialAreaId = undefined; this._spatialTile = -1; this._spatialOwner = -1; this._spatialEpoch = 0; this._r3d = undefined; this._r3dSig = undefined; this._r3dTex = undefined; this._visStill = undefined; this._rslot = undefined;
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
    set owner(v) { if (this._us) { this._us.owner[this._si] = v; this._us.mvOn[this._si] = 0; if (typeof upkeepUnitRefresh === 'function') upkeepUnitRefresh(this); } else if (this._det) this._det.owner = v; else Object.defineProperty(this, 'owner', { value: v, writable: true, enumerable: true, configurable: true }); }
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
    set attackTimer(v) { if (this._us) { this._us.attackTimer[this._si] = v; if (v > 0) this._us.tmOn[this._si] = 1; } else if (this._det) this._det.attackTimer = v; else Object.defineProperty(this, 'attackTimer', { value: v, writable: true, enumerable: true, configurable: true }); }
    get attackFlash() { return this._us ? this._us.attackFlash[this._si] : (this._det ? this._det.attackFlash : undefined); }
    set attackFlash(v) { if (this._us) { this._us.attackFlash[this._si] = v; if (v > 0) this._us.tmOn[this._si] = 1; } else if (this._det) this._det.attackFlash = v; else Object.defineProperty(this, 'attackFlash', { value: v, writable: true, enumerable: true, configurable: true }); }
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
    // Stacks and levels: columns (SIM_UNIT_LEVEL_COLUMNS; NaN: not set);
    // the upkeep bin follows them (upkeepUnitRefresh).
    get stackCount() { const c = this._us; const v = c ? c.stackCount[this._si] : (this._det ? this._det.stackCount : undefined); return v === v ? v : undefined; }
    set stackCount(v) { const c = this._us; if (c) { c.stackCount[this._si] = typeof v === 'number' ? v : NaN; if (typeof upkeepUnitRefresh === 'function') upkeepUnitRefresh(this); } else if (this._det) this._det.stackCount = v; else Object.defineProperty(this, 'stackCount', { value: v, writable: true, enumerable: true, configurable: true }); }
    get unitLevel() { const c = this._us; const v = c ? c.unitLevel[this._si] : (this._det ? this._det.unitLevel : undefined); return v === v ? v : undefined; }
    set unitLevel(v) { const c = this._us; if (c) { c.unitLevel[this._si] = typeof v === 'number' ? v : NaN; if (typeof upkeepUnitRefresh === 'function') upkeepUnitRefresh(this); } else if (this._det) this._det.unitLevel = v; else Object.defineProperty(this, 'unitLevel', { value: v, writable: true, enumerable: true, configurable: true }); }
    get baseLevel() { const c = this._us; const v = c ? c.baseLevel[this._si] : (this._det ? this._det.baseLevel : undefined); return v === v ? v : undefined; }
    set baseLevel(v) { const c = this._us; if (c) { c.baseLevel[this._si] = typeof v === 'number' ? v : NaN; if (typeof upkeepUnitRefresh === 'function') upkeepUnitRefresh(this); } else if (this._det) this._det.baseLevel = v; else Object.defineProperty(this, 'baseLevel', { value: v, writable: true, enumerable: true, configurable: true }); }
    get effectiveStacks() { const c = this._us; const v = c ? c.effectiveStacks[this._si] : (this._det ? this._det.effectiveStacks : undefined); return v === v ? v : undefined; }
    set effectiveStacks(v) { const c = this._us; if (c) c.effectiveStacks[this._si] = typeof v === 'number' ? v : NaN; else if (this._det) this._det.effectiveStacks = v; else Object.defineProperty(this, 'effectiveStacks', { value: v, writable: true, enumerable: true, configurable: true }); }
    get effectiveLevel() { const c = this._us; const v = c ? c.effectiveLevel[this._si] : (this._det ? this._det.effectiveLevel : undefined); return v === v ? v : undefined; }
    set effectiveLevel(v) { const c = this._us; if (c) { c.effectiveLevel[this._si] = typeof v === 'number' ? v : NaN; if (typeof upkeepUnitRefresh === 'function') upkeepUnitRefresh(this); } else if (this._det) this._det.effectiveLevel = v; else Object.defineProperty(this, 'effectiveLevel', { value: v, writable: true, enumerable: true, configurable: true }); }
    get _lastAppliedEffectiveLevel() { const c = this._us; const v = c ? c._lastAppliedEffectiveLevel[this._si] : (this._det ? this._det._lastAppliedEffectiveLevel : undefined); return v === v ? v : undefined; }
    set _lastAppliedEffectiveLevel(v) { const c = this._us; if (c) c._lastAppliedEffectiveLevel[this._si] = typeof v === 'number' ? v : NaN; else if (this._det) this._det._lastAppliedEffectiveLevel = v; else Object.defineProperty(this, '_lastAppliedEffectiveLevel', { value: v, writable: true, enumerable: true, configurable: true }); }
    // The tile whose floor it last checked (Unit.update's floor items): a
    // column (mvFloor) the movement kernel keeps as it moves the unit.
    get _floorTile() { const c = this._us; return c ? c.mvFloor[this._si] : (this._det ? this._det._floorTile : this._flt); }
    set _floorTile(v) { const c = this._us; if (c) c.mvFloor[this._si] = v; else if (this._det) this._det._floorTile = v; else Object.defineProperty(this, '_flt', { value: v, writable: true, configurable: true }); }
    // Arriving in a crowd (see _followNavNode): a column (mvNavLD) the kernel shares.
    get _sepMoved() { const c = this._us; return c ? c.sepMov[this._si] : (this._det ? this._det._sepMoved : (this._smv | 0)); }
    set _sepMoved(v) { const c = this._us; if (c) c.sepMov[this._si] = v ? 1 : 0; else if (this._det) this._det._sepMoved = v ? 1 : 0; else Object.defineProperty(this, '_smv', { value: v ? 1 : 0, writable: true, configurable: true }); }
    get _navLastD() { const c = this._us; return c ? c.mvNavLD[this._si] : (this._det ? this._det._navLastD : this._nld); }
    set _navLastD(v) { const c = this._us; if (c) c.mvNavLD[this._si] = v; else if (this._det) this._det._navLastD = v; else Object.defineProperty(this, '_nld', { value: v, writable: true, configurable: true }); }
    // A forced target's last seen position (null: none): columns fLsX/fLsY
    // (NaN for null), which the movement kernel writes for forced holds and
    // chases (see simMoveTryHold).
    get _forcedTargetLastSeenX() { const c = this._us; if (c) { const v = c.fLsX[this._si]; return v === v ? v : null; } return this._det ? this._det._forcedTargetLastSeenX : (this._flsx ?? null); }
    set _forcedTargetLastSeenX(v) { const c = this._us; if (c) c.fLsX[this._si] = typeof v === 'number' ? v : NaN; else if (this._det) this._det._forcedTargetLastSeenX = v; else Object.defineProperty(this, '_flsx', { value: v, writable: true, configurable: true }); }
    get _forcedTargetLastSeenY() { const c = this._us; if (c) { const v = c.fLsY[this._si]; return v === v ? v : null; } return this._det ? this._det._forcedTargetLastSeenY : (this._flsy ?? null); }
    set _forcedTargetLastSeenY(v) { const c = this._us; if (c) c.fLsY[this._si] = typeof v === 'number' ? v : NaN; else if (this._det) this._det._forcedTargetLastSeenY = v; else Object.defineProperty(this, '_flsy', { value: v, writable: true, configurable: true }); }
    // Whether its stats are behind its stat tables (research it has not
    // taken yet, see things_utils.js _unitStatsVerOf): kept in esVer as a
    // version (peer-local), sent as a flag; a restore sets markers that
    // effStatsAppliedSync turns into versions.
    get _statsBehind() { const c = this._us; return c ? _unitStatsBehind(this, c.esVer[this._si]) : !!(this._det && this._det._statsBehind); }
    set _statsBehind(v) { const c = this._us; if (c) c.esVer[this._si] = v ? -2 : -3; else if (this._det) this._det._statsBehind = !!v; }
    // Dead: a column (see SIM_MOVE_COLUMNS), true or false.
    get dead() { const c = this._us; return c ? c.dead[this._si] === 1 : (this._det ? this._det.dead === true : this._deadv === true); }
    set dead(v) {
        const c = this._us;
        // (Outside a tick, an action's or a restore's: the prebuilt unit
        // index no longer holds.)
        if (typeof _inGameTick !== 'undefined' && !_inGameTick && typeof _sxPre !== 'undefined' && _sxPre) spatialIndexInvalidate();
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
        if (c) { c.mvOn[this._si] = 0; if (v !== 'IDLE') c.wsKind[this._si] = 0; }
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
    // A structure target (its value in _tb), mirrored into the acqB column:
    // the acquisition tier looks for units only for units that may use the
    // answer (idle, attack-moving, or attacking a structure).
    get targetBuilding() { return this._tb; }
    set targetBuilding(v) {
        const c = this._us;
        if (c === undefined) { Object.defineProperty(this, '_tb', { value: v, writable: true, configurable: true }); return; }
        this._tb = v;
        if (c) c.acqB[this._si] = v ? 1 : 0;
    }
    // A fallback path with a target still pending (the separation's commit
    // retries it now and then: _tryUpgradeAstarFallbackPath): mirrored into
    // the mvPF column (1 while both are set), so the separation lists only
    // those units on their retry ticks, without reading every unit object.
    get pathIsFallbackAstar() { return this._pfa; }
    set pathIsFallbackAstar(v) {
        const c = this._us;
        if (c === undefined) { Object.defineProperty(this, '_pfa', { value: v, writable: true, configurable: true }); return; }
        this._pfa = v;
        if (c) c.mvPF[this._si] = v && this._ppt ? 1 : 0;
    }
    get _pendingPathTarget() { return this._ppt; }
    set _pendingPathTarget(v) {
        const c = this._us;
        if (c === undefined) { Object.defineProperty(this, '_ppt', { value: v, writable: true, configurable: true }); return; }
        this._ppt = v;
        if (c) c.mvPF[this._si] = v && this._pfa ? 1 : 0;
    }
    get path() { return this._path; }
    set path(v) {
        const c = this._us;
        if (c === undefined) { Object.defineProperty(this, '_path', { value: v, writable: true, configurable: true }); return; }
        if (this._us) simUnitPathRelease(this._us, this._si);
        this._path = v;
        if (c) { c.mvOn[this._si] = 0; c.mvCD[this._si] = -1; }
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
        // (A forced target's last seen position the kernel wrote this tick
        // before handing the unit back: as it was, doAttacking decides.)
        if (cols && cols.fLsT[this._si] === gameTime) simForcedSeenUndo(cols, this._si);
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
        let spd = Math.fround(this.preComputed.speed * _getUnitAstarSpeedMultiplier(this));
        if (this.frozen > 0) spd *= 0.5;
        if (this.sandy > 0) spd *= 0.5;


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
        // (A unit on the move shoots after its step, from where it stands
        // then, with the drive-by look the helpers made this tick: the
        // movement kernel moves it, and its turn only takes the shot,
        // simDriveByFire.)
        let driveBy = false;
        switch (this.commandState) {
            case CMD_IDLE: if (!this.workerState) this.doIdle(spd); break;
            case CMD_MOVING:
                driveBy = true;
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
        _unitUpdateEnd(this, cols, driveBy);
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
            recordDamageVisual(u, prevEnergy - u.energy, item.owner); shrineDamageTaken(u, prevEnergy - u.energy);
            if (u.energy <= 0 && !u.dead) u.dead = true;
        }, { enemyOfPlayer: item.owner, tickStart: true });

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
        // (On its acquisition ticks: _unitAcquireTick.)
        let closest = _unitAcquireTick(this) ? _combatScanTarget(this, aggroRange) : null;
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
        let structure = _acqStructureHit(this, aggroRange);
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
        // (The combat brain fires on the move: cmMode 3.)
        if (SIM_COMBAT_BRAIN && !this.workerState) return;
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
        // The helpers' answer this tick (SIM_KERNEL_DRIVEBY): taken when
        // still standing as found (the best of a superset, so then the best
        // of what this look would find); else the look itself.
        const c = this._us;
        if (c && c.dbTick[this._si] === gameTime) {
            const s = this._si, q = c.dbT[s];
            if (q >= 0) {
                const e = _simUnitState.owners[q];
                if (e && (e.id | 0) === c.dbTI[s] && !e.dead) { this._performAttackOnUnit(e); return; }
            } else if (q === -1) {
                const tl = c.dbS[s];
                if (tl < 0) return;
                const gx = tl % GRID_W, gy = (tl - gx) / GRID_W, e = getTileEntityRef(gx, gy), cell = grid[gy] && grid[gy][gx];
                const owner = e ? (e.owner !== undefined ? e.owner : (cell ? cell.owner : -1)) : -1;
                if (e && e.energy > 0 && !e.underConstruction && owner !== this.owner && owner >= 0 && isGameplayTargetVisibleToPlayer(this.owner, gx, gy)) { this._performAttackOnBuilding(e); return; }
            }
        }
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
                if (!inRange && !_isUnitTargetInContactAt(this, enemy, _unitTickX(enemy), _unitTickY(enemy), whole + 1)) return;
            }
            let dx = _unitTickX(enemy) - this.x, dy = _unitTickY(enemy) - this.y;
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
        // (On its acquisition ticks: _unitAcquireTick.)
        let closest = _unitAcquireTick(this) ? _combatScanTarget(this, aggroRange) : null;
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
            let structure = _acqStructureHit(this, aggroRange);
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
            let recoil = this.preComputed.maxEnergy * 0.03;
            this.energy -= recoil;
            shrineDamageTaken(this, recoil);
            if (this.energy <= 0) { this.dead = true; }
        }
    }

    doAttacking(spd) {
        // Automatic structure attacks yield to nearby units. Explicit player
        // targets remain locked, and the scan is staggered by simulation tick.
        // (The tick's combat scan covers it: see SIM_KERNEL_COMBAT_SCAN.)
        if (this.targetBuilding && !this.forcedAttackTarget && (gameTime + this.id) % 8 === 0) {
            const range = Math.max(TILE, this.preComputed.visionRange * TILE);
            let enemy = _combatScanHit(this, range);
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
            if (_unitTickDead(this.targetUnit)) { this.targetUnit = null; this.attackTarget = null; this.forcedAttackTarget = false; this.commandState = CMD_IDLE; this._resumeAttackMove(); return; }
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
                    this._resumeAttackMove();
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
                this._resumeAttackMove();
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
            if (tb.energy <= 0 || !_isHostileThingVisibleToUnit(this, tb)) { this.targetBuilding = null; this.attackTarget = null; this.forcedAttackTarget = false; this.commandState = CMD_IDLE; this._resumeAttackMove(); return; }
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

    // An engagement on the way of an attack-move ended (its target died, went
    // out of sight or out of leash, its structure fell): on toward the
    // attack-move's tile at once, as doIdle does on the next tick (a new
    // target is the attack-move's own look, on its acquisition ticks: the
    // same cadence as doIdle's). In a big battle every kill sent each of
    // its attackers through a whole idle update first.
    _resumeAttackMove() {
        if (this._attackMoveGx == null || this.holdPosition || this.workerState || this.unitType === 'scout' || this.dead) return;
        let gx = this._attackMoveGx, gy = this._attackMoveGy;
        this.targetPos = { x: gx * TILE + 16, y: gy * TILE + 16 };
        _makeFallbackPathForUnit(this, Math.floor(this.x / TILE), Math.floor(this.y / TILE), gx, gy, CMD_ATTACK_MOVING, 'ai_combat');
    }

    doHolding() {
        if (this.attackTimer > 0 || this.preComputed.attackDamage <= 0) return;
        let closest = null, bestD2 = Infinity;
        // (Enemies where they were at the pass's start: _unitTickX.)
        forEachUnitInAreaRange(this.x, this.y, _getUnitAttackRangeArea(this), (enemy) => {
            const ex = _unitTickX(enemy), ey = _unitTickY(enemy);
            if (!_isUnitVisibleAtTickStart(this.owner, enemy) || !_isTargetWithinUnitAttackAreaRange(this, enemy, ex, ey)) return;
            let dx = ex - this.x, dy = ey - this.y, d2 = dx * dx + dy * dy;
            if (d2 < bestD2 || (d2 === bestD2 && (!closest || enemy.id < closest.id))) {
                closest = enemy; bestD2 = d2;
            }
        }, { enemyOfPlayer: this.owner, areaOnly: true, tickStart: true });
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
                let laneOffsetNow = Math.fround(Math.max(1.5, Math.min(4, this.r * 0.6)));
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
        // (NAV_CROWD_TILES: see the arrival below.)
        if (gameTime < (nd.ready | 0)) return false;
        const W = GRID_W, gx = Math.floor(this.x / TILE), gy = Math.floor(this.y / TILE), t = gy * W + gx, dest = nd.y * W + nd.x;
        if (t === dest) { this.pathIndex++; this._navLastD = -1; return this.pathIndex >= this.path.length; }
        // Between its steers: on along its committed step (see
        // SIM_STEER_TICKS in sim_parallel.js), as the movement kernel.
        const c = this._us, s = this._si, steer = c && typeof SIM_STEER_NEAR_TICKS === 'number' ? SIM_STEER_NEAR_TICKS : 1;
        if (c) {
            if (c.mvCD[s] === dest && c.mvCTl[s] === t && gameTime - c.mvCT[s] < c.mvCN[s]) {
                let vx = c.mvCVx[s], vy = c.mvCVy[s];
                const sgx = Math.floor((this.x + vx) / TILE), sgy = Math.floor((this.y + vy) / TILE);
                if (nd.nav - 1 !== NAV_PROFILE_AIR && (sgx !== gx || sgy !== gy)) {
                    const sl = simFlowSlide(navWallTable(nd.nav - 1), W, GRID_H, gx, gy, sgx, sgy);
                    if (sl) { if (sl & 1) vx = 0; if (sl & 2) vy = 0; c.mvCD[s] = -1; }
                }
                this.x += vx; this.y += vy; this.vx = vx; this.vy = vy;
                const ngx = Math.floor(this.x / TILE), ngy = Math.floor(this.y / TILE);
                if (ngx !== gx || ngy !== gy) _tryConsumeAstarMoveCostForTransition(this, { x: gx, y: gy }, { x: ngx, y: ngy });
                return false;
            }
            // (A steer: commits again below, if it moves.)
            c.mvCD[s] = -1;
        }
        // Near it and held back by a crowd (under a third of its speed made
        // good toward it since last tick): arrived where it is, as in the
        // movement kernel (not every unit of a big group fits on its tile).
        // Workers and lone units go all the way (a worker's task is at the
        // tile; only a group's destination is too small for all of it).
        // Waiting in a crowd (_navLastD -2 - dest): still, but for a look
        // every 16 ticks (by id: on when the crowd around has thinned out)
        // and a try every 64 (so a jam in a corridor clears).
        if (this._navLastD === -2 - dest) {
            if (((gameTime + this.id) & 15) !== 0 || (((gameTime + this.id) & 63) !== 0 && !_unitCrowdThin(this))) return false;
            this._navLastD = -1;
        }
        // Further out (up to NAV_CROWD_TILES), held back beside an idle or
        // waiting unit of its own (the combat scan's crowd flag): it waits,
        // so a big crowd settles from its middle outward instead of pressing.
        if (nd.w && !this.workerState && this.pathIndex === this.path.length - 1 && Math.abs(nd.x - gx) <= NAV_CROWD_TILES && Math.abs(nd.y - gy) <= NAV_CROWD_TILES) {
            const d = detHypot(nd.x * TILE + 16 - this.x, nd.y * TILE + 16 - this.y), last = this._navLastD;
            this._navLastD = d;
            const near = Math.abs(nd.x - gx) <= 8 && Math.abs(nd.y - gy) <= 8;
            if (last >= 0 && last - d < spd * 0.3 * steer) {
                // A detour or wall can also reduce progress. Only settle
                // short of the destination when a friendly crowd is there.
                if (near && _unitCrowdIdleNear(this)) { this.pathIndex = this.path.length; this._navLastD = -1; return true; }
                if (_unitCrowdIdleNear(this)) { this._navLastD = -2 - dest; return false; }
            }
        } else this._navLastD = -1;
        const profile = nd.nav - 1, slot = navFieldRequest(profile, dest, !!nd.w);
        let tx, ty;
        // Exactly as the movement kernel steers (flow mode): the look-ahead
        // (simFlowLook: the next tile, the one after, on open ground up to 6
        // tiles ahead), then straight there with the unit's own side offset
        // from the line, or the next tile's centre on its lane.
        const wall = navWallTable(profile);
        const lk = _navFlowLook(this, profile, slot, t, gx, gy, dest, wall);
        // No way there on the navigation: it has not arrived. A worker at
        // its task (a tile from it: at its work) stands and waits, its task
        // looking again on its check ticks; anything else (a worker the
        // player sent too) keeps its target (a pending one) and heads for
        // the closest tile it can reach (the helpers' answer, see
        // _tryUpgradeAstarFallbackPath). Walled in: it stands.
        if (lk === 0) {
            if (this.workerState && this.workerState !== 'MANUAL_MOVE') {
                if (Math.abs(nd.x - gx) > 1 || Math.abs(nd.y - gy) > 1) return false;
                this.pathIndex = this.path.length; return true;
            }
            let pt = this._pendingPathTarget;
            if (pt) { pt.ver = 0; pt.at = -1; pt.sub = 0; }
            else pt = this._pendingPathTarget = { gx: nd.x, gy: nd.y, cmd: this.commandState, src: 'nav_unreachable' };
            this.path = null; this.pathIndex = 0; this._routeKey = null; this.pathIsFallbackAstar = true;
            navPathSubstitute(this, gx, gy, pt);
            notePendingPathUnit(this);
            return false;
        }
        if (lk === -1) return false;
        const L = _navLookOut, n = L[0], n2 = L[1], far = L[2], open = L[3] === 1;
        const kx = far % W, ky = (far - kx) / W;
        if (open) {
            const rdx = kx - gx, rdy = ky - gy, rl = Math.sqrt(rdx * rdx + rdy * rdy), sx = -rdy / rl, sy = rdx / rl, maxSide = TILE * 0.8;
            let side = ((this.x - (gx * TILE + 16)) * sx + (this.y - (gy * TILE + 16)) * sy) * 0.875;
            side = side > maxSide ? maxSide : (side < -maxSide ? -maxSide : side);
            tx = kx * TILE + 16 + sx * side; ty = ky * TILE + 16 + sy * side;
        } else {
            const lane = Math.fround(Math.max(1.5, Math.min(4, this.r * 0.6))), sdx = kx - gx, sdy = ky - gy;
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
        let vx = (dx / dist) * spd, vy = (dy / dist) * spd;
        // Into a wall (on the ground): along it, one axis, else it stands.
        // (The walls of its walk class: a builder's own buildings are none.)
        if (profile !== NAV_PROFILE_AIR) {
            const sl = simFlowSlide(wall, W, GRID_H, gx, gy, Math.floor((this.x + vx) / TILE), Math.floor((this.y + vy) / TILE));
            if (sl & 1) vx = 0;
            if (sl & 2) vy = 0;
        }
        this.x += vx; this.y += vy; this.vx = vx; this.vy = vy;
        if (c) {
            c.mvCD[s] = dest; c.mvCT[s] = gameTime; c.mvCVx[s] = vx; c.mvCVy[s] = vy; c.mvCTl[s] = t;
            c.mvCN[s] = Math.abs(nd.x - gx) <= 8 && Math.abs(nd.y - gy) <= 8 ? SIM_STEER_NEAR_TICKS : SIM_STEER_TICKS;
        }
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
        let laneOffset = Math.fround(Math.max(1.5, Math.min(4, this.r * 0.6)));
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
// The hits, ranked by their attackers' ids (one attack a unit a tick): the
// attacks made in the pass (_hitQ) and the movement kernel's (held units'
// attacks at the pass's start, _simMoveHitA...) alike, whichever made them.
// Hits on units: per target in rank order on the helpers (SIM_KERNEL_HITS:
// energy, statuses, fallen; a target already fallen takes no more); then
// here, in rank order: hits on structures, retaliations of units hit while
// idle, scouts' watches, and the looks (flash, sound, effect) of the first
// SIM_HITS_PRESENT hits of the tick.
let _hitOrder = new Float64Array(1024), _hitKeys = new Float64Array(1024);
const _hitK = { cap: 0, q: null, dmg: null, sty: null, flag: null, g: null, jb: null, shr: null, src: null };
const SIM_HITS_PRESENT = 512, SIM_HITS_PER_JOB = 512;
function _hitStyleCode(a) {
    const st = a.attackStyle;
    return st === 'fire' ? 1 : st === 'water' ? 2 : st === 'ice' ? 3 : st === 'poison' ? 4 : (st === 'swoop' && a.unitType === 'scout') ? 5 : 0;
}
function _hitArrays(total) {
    const K = _hitK;
    if (K.cap >= total) return K;
    const cap = simReserveCap(total, 4096);
    K.q = simSharedArray(Int32Array, cap); K.dmg = simSharedArray(Float64Array, cap); K.sty = simSharedArray(Uint8Array, cap);
    K.flag = simSharedArray(Uint8Array, cap); K.g = simSharedArray(Int32Array, cap); K.src = new Int32Array(cap);
    K.cap = cap;
    simParallelBind('hit.q', K.q); simParallelBind('hit.dmg', K.dmg); simParallelBind('hit.sty', K.sty); simParallelBind('hit.flag', K.flag); simParallelBind('hit.g', K.g);
    return K;
}
function unitHitsResolve() {
    const Q = _hitQ, n = Q.n, S = _simUnitState;
    const KC = _simMoveHitChunks, HC = _simMoveHitC, HA = _simMoveHitA, HT = _simMoveHitT, CH = SIM_MOVE_CHUNK;
    _simMoveHitChunks = 0;
    let nk = 0;
    for (let k = 0; k < KC; k++) nk += HC[k];
    const total = n + nk;
    if (total === 0) return;
    // (id * 2^22 + entry: ids below 2^30, entries below 2^22; a native sort.)
    if (_hitOrder.length < total) _hitOrder = new Float64Array(total * 2);
    const O = _hitOrder, SH = 4194304;
    for (let i = 0; i < n; i++) O[i] = (Q.a[i].id | 0) * SH + i;
    if (nk) {
        const ID = S.columns.id;
        let m = n;
        for (let k = 0; k < KC; k++) for (let j = k * CH, e = j + HC[k]; j < e; j++) O[m++] = (ID[HA[j]] | 0) * SH + n + j;
    }
    const ord = total > 1 ? O.subarray(0, total).sort() : O;
    if (!S || typeof SIM_KERNEL_HITS !== 'number') {
        for (let r = 0; r < total; r++) {
            const i = ord[r] % SH, a = Q.a[i], target = Q.t[i];
            Q.a[i] = null; Q.t[i] = null;
            if (Q.b[i] === 0) _unitHitUnit(a, target, Q.dmg[i], Q.x[i], Q.y[i]);
            else _unitHitBuilding(a, target, Q.dmg[i]);
        }
        Q.n = 0;
        return;
    }
    const C = S.columns, owners = S.owners, K = _hitArrays(total);
    const HQ = K.q, HD = K.dmg, HS = K.sty, SRC = K.src;
    if (_hitKeys.length < total) _hitKeys = new Float64Array(total * 2);
    const KEYS = _hitKeys;
    let nu = 0;
    for (let r = 0; r < total; r++) {
        const i = ord[r] % SH;
        SRC[r] = i;
        if (i < n) {
            const t = Q.t[i];
            // (A structure, or a unit without its columns: here, below.)
            if (Q.b[i] !== 0 || t._us !== C || !(t._si >= 0)) { HQ[r] = -1; continue; }
            HQ[r] = t._si; HD[r] = Q.dmg[i]; HS[r] = _hitStyleCode(Q.a[i]);
        } else {
            const j = i - n, s = HA[j];
            HQ[r] = HT[j]; HD[r] = C.atkDmg[s]; HS[r] = C.atkSty[s];
        }
        KEYS[nu++] = HQ[r] * SH + r;
    }
    // By target, then rank; jobs split between targets.
    const G = K.g;
    if (nu) {
        const kk = nu > 1 ? KEYS.subarray(0, nu).sort() : KEYS;
        for (let g = 0; g < nu; g++) G[g] = kk[g] % SH;
        const jobs = Math.max(1, Math.min(64, Math.ceil(nu / SIM_HITS_PER_JOB)));
        if (!K.jb || K.jb.length < jobs + 1) { K.jb = simSharedArray(Int32Array, 130); simParallelBind('hit.jb', K.jb); }
        const NO = Math.max(16, players.length);
        if (!K.shr || K.shr.length < 64 * NO) { K.shr = simSharedArray(Float64Array, 64 * NO * 2); simParallelBind('hit.shr', K.shr); }
        const JB = K.jb;
        JB[0] = 0;
        for (let j = 1; j < jobs; j++) {
            let b = Math.max(JB[j - 1], Math.floor(j * nu / jobs));
            while (b > 0 && b < nu && HQ[G[b]] === HQ[G[b - 1]]) b++;
            JB[j] = b;
        }
        JB[jobs] = nu;
        const P = _simParams;
        P[0] = NO; P[1] = RESOURCE_FIXED_POINT_SCALE; P[2] = CMD_IDLE;
        simParallelRun(SIM_KERNEL_HITS, jobs);
        // (The shrines' share: integers, any order.)
        const SHR = K.shr;
        for (let j = 0; j < jobs; j++) for (let o = 0; o < NO; o++) {
            const v = SHR[j * NO + o];
            if (!v) continue;
            if (o >= _shrinePendingFixed.length) { const a = new Float64Array(o + 8); a.set(_shrinePendingFixed); _shrinePendingFixed = a; }
            _shrinePendingFixed[o] += v;
        }
    }
    const FL = K.flag;
    let pres = 0;
    for (let r = 0; r < total; r++) {
        const i = SRC[r];
        if (HQ[r] < 0) {
            const a = Q.a[i], t = Q.t[i];
            if (Q.b[i] === 0) _unitHitUnit(a, t, Q.dmg[i], Q.x[i], Q.y[i]);
            else _unitHitBuilding(a, t, Q.dmg[i]);
            continue;
        }
        const fl = FL[r];
        if (!fl) continue;
        const look = pres < SIM_HITS_PRESENT, sty = HS[r];
        if (!look && !(fl & 2) && sty !== 5) continue;
        let a, t, ax, ay;
        if (i < n) { a = Q.a[i]; t = Q.t[i]; ax = Q.x[i]; ay = Q.y[i]; }
        else { const j = i - n, s = HA[j]; a = owners[s]; t = owners[HT[j]]; ax = C.x[s]; ay = C.y[s]; }
        if (!a || !t) continue;
        const dmg = HD[r];
        if (look) {
            pres++;
            // (A kernel attack's own look and sound, as _attackerSide's.)
            if (i >= n) { recordUnitAttackFx(a, t); playSound(sty >= 1 && sty <= 4 || a.attackStyle === 'laser' ? 'attack_cast' : 'attack_swing', ax, ay, a.unitType); }
            pushHostileDamageAlert(t, dmg, a.owner);
            recordDamageVisual(t, dmg, a.owner);
            if (dmg > 0) playSound('melee_hit', t.x, t.y, a.unitType);
        }
        if (fl & 2) tryAutoRetaliateOnHostileDamage(t, a, ax, ay);
        if (sty === 5) applyStatusEffect(t, 'watch', getUnitEffectiveLevel(a), 0, a.owner, a.unitType);
    }
    for (let i = 0; i < n; i++) { Q.a[i] = null; Q.t[i] = null; }
    Q.n = 0;
}
// Dropped (a restore replaces the world between ticks).
function unitHitsReset() { const Q = _hitQ; for (let i = 0; i < Q.n; i++) { Q.a[i] = null; Q.t[i] = null; } Q.n = 0; }
function _unitHitUnit(a, target, dmg, ax, ay) {
    if (target.dead) return;
    let before = target.energy;
    target.energy -= dmg;
    pushHostileDamageAlert(target, before - target.energy, a.owner);
    recordDamageVisual(target, before - target.energy, a.owner); shrineDamageTaken(target, before - target.energy);
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
    recordDamageVisual(tb, before - tb.energy, a.owner); shrineDamageTaken(tb, before - tb.energy);
    if (before > tb.energy) playSound('melee_hit', tb.x, tb.y, a.unitType);
    if (tb.energy <= 0) destroyBuilding(tb);
}

// Status effect fields: columns (SIM_UNIT_STATUS_COLUMNS), like x and y.
// (A timer set running flags its unit for the status pre-pass: stOn.)
// (Made per column with its name in the code: one closure over the key did
// c[k] for every column at one site, a megamorphic lookup on every read.)
for (const k of (typeof SIM_UNIT_STATUS_COLUMNS !== 'undefined' ? SIM_UNIT_STATUS_COLUMNS : [])) {
    const timer = SIM_STATUS_TIMER_COLUMNS.includes(k);
    const get = new Function(`return function () { const c = this._us; return c ? c.${k}[this._si] : (this._det ? this._det.${k} : undefined); };`)();
    const set = new Function('k', `return function (v) { const c = this._us; if (c) { c.${k}[this._si] = v;${timer ? ' if (v > 0) c.stOn[this._si] = 1;' : k === 'workerTransferCooldown' ? ' if (v > 0) c.tmOn[this._si] = 1;' : ''} } else if (this._det) this._det.${k} = v; else Object.defineProperty(this, k, { value: v, writable: true, enumerable: true, configurable: true }); };`)(k);
    Object.defineProperty(Unit.prototype, k, { get, set, configurable: true });
}

// Status effects and attack timers of every unit, counted down at once
// before the unit pass (SIM_KERNEL_STATUS; Unit.update did it per unit):
// damage over time dealt, units it kills marked dead. Then the few events
// that need the objects: damage shown, watches ended.
const STATUS_PREPASS_CHUNK = 2048;
// Units' damage over time is reported (its flash, the shrines' count) every
// this many ticks, summed (see SIM_KERNEL_STATUS).
const STATUS_DOT_REPORT_TICKS = 4;
// At a resync every peer drops the sums not yet reported (a restored peer
// has none).
function statusDotAccReset() {
    const S = _simUnitState;
    if (S) S.columns.stAcc.fill(0);
}
let _statusCounts = null, _statusList = null;
function statusPrepassRun() {
    const S = _simUnitState, n = units.length;
    if (!S || n === 0) return;
    const slots = _unitSlotMapEnsure(), chunks = Math.ceil(n / STATUS_PREPASS_CHUNK);
    if (!_statusCounts || _statusCounts.length < chunks) { _statusCounts = simSharedArray(Int32Array, Math.max(64, chunks * 2)); simParallelBind('st.count', _statusCounts); }
    if (!_statusList || _statusList.length < chunks * STATUS_PREPASS_CHUNK) { _statusList = simSharedArray(Int32Array, simReserveCap(chunks * STATUS_PREPASS_CHUNK, 4096)); simParallelBind('st.list', _statusList); }
    simParallelBind('ix.slots', slots);
    const P = _simParams;
    P[0] = n; P[1] = STATUS_PREPASS_CHUNK; P[2] = gameTime; P[3] = STATUS_DOT_REPORT_TICKS;
    // (The separation's tick-start copy only when separationStart, next,
    // will not take the prebuilt one.)
    P[4] = _sepPrebuiltForTick() ? 0 : 1;
    simParallelRun(SIM_KERNEL_STATUS, chunks);
    const C = S.columns, EV = C.stEv, DOT = C.stDot, owners = S.owners;
    // (Each job's units with events, in index order: the kernel's lists.)
    const LIST = _statusList;
    for (let k = 0; k < chunks; k++) {
        for (let j = k * STATUS_PREPASS_CHUNK, je = j + _statusCounts[k]; j < je; j++) {
            const i = LIST[j], s = slots[i];
            if (s < 0) continue;
            const ev = EV[s];
            if (ev === 0) continue;
            EV[s] = 0;
            const u = owners[s];
            if (!u || u !== units[i]) continue;
            if (ev & 1) { recordDamageVisual(u, DOT[s]); shrineDamageTaken(u, DOT[s]); }
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
    // (The combat brain engages: no object retaliation.)
    if (SIM_COMBAT_BRAIN) return false;
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
    // (In the wasm heap: the chain's Rust kernels read them in place.)
    if (!arr || arr.length < n) { const old = arr; arr = S[name] = simHeapArray(Type, n); simParallelBind('sep.' + name, arr); simHeapFree(old); }
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
// The flow look-aheads, at a resync on every peer: a new build or wall
// change leaves them standing until the unit's refresh tick, so their
// contents count (a restoring peer starts without them).
function simMoveResetLookCaches() {
    const S = _simUnitState;
    if (S) { S.columns.mvNavT.fill(-1); S.columns.mvCD.fill(-1); }
}

// New stats (a level or stacking change): an armed unit takes them into its
// columns (speed, reach, step cost), as simMoveTryArm would.
function simMoveStatsChanged(u) {
    const c = u && u._us;
    if (!c) return;
    const s = u._si, pc = u.preComputed, f = c.mvFlags[s];
    const spd = pc ? pc.speed * _getUnitAstarSpeedMultiplier(u) : NaN;
    // Every unit's movement stats, for orders that arm it from the columns.
    // (Unchanged: nothing to redo. A recalculation that finds the same stats
    // (on a peer that restored the unit, say) must leave it as it was.)
    let same = !!pc;
    if (pc) {
        const o0 = c.mvSpd[s], o1 = c.mvLane[s], o2 = c.mvCost[s], o3 = c.mvReachD[s], o4 = c.mvReachA[s], o5 = c.mvShoot[s], o6 = c.mvRangeK[s], o7 = c.cbRange[s];
        const rd = Math.ceil(_getUnitAttackRangeArea(u)) + 1, ra = Math.ceil(Math.max(TILE, pc.visionRange * TILE) / TILE) + 1;
        c.atkCd[s] = pc.attackCooldown; c.atkDmg[s] = pc.attackDamage; c.atkSty[s] = _hitStyleCode(u);
        c.mvSpd[s] = spd; c.mvLane[s] = Math.max(1.5, Math.min(4, u.r * 0.6)); c.mvCost[s] = _resolveUnitAstarTileCost(u);
        c.mvReachD[s] = rd >= 0 && rd < SIM_MOVE_BOX_STEPS ? rd : 255; c.mvReachA[s] = ra >= 0 && ra < 255 ? ra : 255;
        c.mvShoot[s] = pc.attackDamage > 0 ? 1 : 0;
        c.mvRangeK[s] = Math.min(255, Math.floor(_getUnitAttackRangeArea(u)));
        const rga = _getUnitAttackRangeArea(u);
        c.lzFlags[s] = (u.turretImmune ? 1 : 0) | (u.laserResistant ? 2 : 0) | (Math.floor(rga) === Math.ceil(rga) ? 4 : 0);
        c.cbRange[s] = Math.max(TILE, pc.visionRange * TILE);
        same = Object.is(o0, c.mvSpd[s]) && o1 === c.mvLane[s] && Object.is(o2, c.mvCost[s]) && o3 === c.mvReachD[s] && o4 === c.mvReachA[s]
            && o5 === c.mvShoot[s] && o6 === c.mvRangeK[s] && o7 === c.cbRange[s];
    }
    if (same) return;
    // Holding (3: an enemy unit, 5: a structure): the hold stands on its
    // range in area steps (mvReach, as simMoveTryHold took it) and on the
    // unit dealing damage; its chase step's length follows the speed. The
    // same range, still shooting: kept, as Unit.update would decide the same
    // (in a battle effective levels change all the time: every change made
    // each holder run Unit.update again).
    const on = c.mvOn[s];
    if (on === 3 || on === 5) {
        const k = Math.floor(Math.max(0, Number(_getUnitAttackRangeArea(u)) || 0));
        if (pc && pc.attackDamage > 0 && k === c.mvReach[s]) { if (on === 3) c.mvChs[s] = Math.max(TILE * 0.6, Number(pc.speed) || 1); return; }
        c.mvOn[s] = 0; return;
    }
    // Parked or chasing: its checks were made with the old stats.
    if (on >= 2) { c.mvOn[s] = 0; return; }
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

// Unit._followNavNode's flow look-ahead (simFlowLook): with its destination
// field made (the only case the movement kernel steers) on the unit's own
// cache columns, exactly as the kernel; without it (asked for, made at the
// next flush) it waits (-1: the way is the field's row). The result in
// _navLookOut: next tile, the one after, the farthest, open (1).
const _navLookOut = new Int32Array(4);
const _navLookScratch = { mvNavT: new Int32Array(1), mvNavD: new Int32Array(1), mvNavV: new Int32Array(1), mvNavW: new Int32Array(1), mvNavG: new Int32Array(1),
    mvNavN1: new Int32Array(1), mvNavN2: new Int32Array(1), mvNavFar: new Int32Array(1), mvNavOpen: new Uint8Array(1) };
function _navFlowLook(u, profile, slot, t, gx, gy, dest, wall) {
    const nav = _nav[profile];
    if (!nav) return 0;
    const Fp = slot >= 0 ? _navFieldPool(slot) : null, i = slot >= 0 ? _navFieldIndex(slot) : 0, m = i * NAV_FIELD_META;
    const has = !!(Fp && Fp.meta && Fp.rows && Fp.meta[m] === profile && Fp.meta[m + 1] === dest && Fp.meta[m + 7] === 1);
    if (!has) return -1;
    let LC = u._us, s = u._si;
    if (!LC) { LC = _navLookScratch; s = 0; LC.mvNavT[0] = -1; }
    const lk = simFlowLook(LC, s, ((gameTime + u.id) & (SIM_FLOW_REFRESH_TICKS - 1)) === 0, t, gx, gy, dest, GRID_W, GRID_H, wall, nav.version | 0,
        _simMoveWallBlk9 ? simWallKey9(_simMoveWallBlk9, _simMoveWallBlkW, gx, gy, _simMoveWallVer) : simWallKey(_simMoveWallBlk, _simMoveWallBlkW, (GRID_H + 7) >> 3, gx, gy, _simMoveWallVer), slot >= NAV_WIDE_BASE ? 2 : 1,
        nav.C, nav.cw, nav.partL, nav.partBase, Fp.rows, i * Fp.rowW, nav.fields, nav.nodeBase, nav.nodeTile, nav.nodePair,
        Fp.pool, i * Fp.span * Fp.span, Fp.meta[m + 2], Fp.meta[m + 3], Fp.meta[m + 4], Fp.meta[m + 5]);
    if (lk === -2) {
        // (A bad build's step to a tile that is not a neighbour: toward it.)
        const n = navStep(profile, t, dest, slot);
        _navLookOut[0] = n; _navLookOut[1] = -1; _navLookOut[2] = n; _navLookOut[3] = 0;
        return 1;
    }
    if (lk === 1) { _navLookOut[0] = LC.mvNavN1[s]; _navLookOut[1] = LC.mvNavN2[s]; _navLookOut[2] = LC.mvNavFar[s]; _navLookOut[3] = LC.mvNavOpen[s]; }
    return lk;
}

// Flow mode: a unit following the flow navigation (destination field slot
// `fid`, its generation `gen`; the air navigation for a flying unit) to tile
// `dest` under command `cmd`, armed
// from its columns alone (stats: simMoveStatsChanged). False when those do
// not allow it (Unit.update keeps the unit).
const SIM_FLOW_ARRIVE = 2;
// A unit's worker kind for the kernel (mvWk): 0 none, 1 at its task, 2 sent
// by the player.
function _simWorkerKind(u) { return u.workerState ? (u.workerState === 'MANUAL_MOVE' ? 2 : 1) : 0; }
// (profile: its navigation's, flownav.js navProfileOf: its walls and fields.)
function simFlowArm(c, s, fid, gen, dest, cmd, flying, ready = 0, worker = false, isWorker = false, profile = flying ? NAV_PROFILE_AIR : NAV_PROFILE_GROUND) {
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
    c.mvFlags[s] = flags; c.mvReach[s] = reach; c.mvFlow[s] = fid; c.mvFGen[s] = gen; c.mvDest[s] = dest; c.mvReady[s] = ready; c.mvNP[s] = profile;
    // (1: a worker at its task, which stands where the way ends; 2: one the
    // player sent, handed back there.)
    c.mvWk[s] = isWorker === 2 ? 2 : (isWorker ? 1 : 0);
    c.mvSpent[s] = 0;
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

// A unit on a route (u._routeKey) away from its end, its path used up (so
// Unit.update would go on along the route: continueUnitRoute): armed in
// flow mode. (A path of its own first, as Unit.update follows it.)
function _simMoveTryFlowArm(u, c, s, cmd) {
    if (u._routeKey !== NAV_ROUTE_KEY || (u.path && u.pathIndex < u.path.length)) return false;
    const x = c.x[s], y = c.y[s], gx = Math.floor(x / TILE), gy = Math.floor(y / TILE), t = gy * GRID_W + gx;
    const dest = u._routeEnd, profile = navProfileOf(u);
    if (!(dest >= 0) || t === dest) return false;
    // (Its path's last node the route's end: the route is done, as
    // continueUnitRoute decides.)
    const last = u.path && u.path.length ? u.path[u.path.length - 1] : null;
    if (last && last.y * GRID_W + last.x === dest) return false;
    navEnsure(profile);
    const did = navFieldRequest(profile, dest, true);
    return did >= 0 && simFlowArm(c, s, did, navFieldGen(did), dest, cmd, profile === NAV_PROFILE_AIR, u._navReady | 0, !!u.workerState, _simWorkerKind(u), profile);
}

// A unit ends its Unit.update marching along its path with nothing to react
// to: arms it (the columns SIM_KERNEL_MOVE works from) when every input of
// its next ticks is in the columns or the kernel's world tables.
function simMoveTryArm(u) {
    const c = u._us;
    if (!c || u.dead || u.holdPosition) return;
    const cmd = u.commandState;
    if (cmd !== CMD_MOVING && cmd !== CMD_ATTACK_MOVING) return;
    // Waiting for its way (a pending target, no path): asleep till its look.
    if ((!u.path || u.pathIndex >= u.path.length) && u._pendingPathTarget) { simMoveTryParkWait(u, cmd); return; }
    // A nav node next (workers too): flow mode toward its tile.
    const nd = u.path && u.pathIndex < u.path.length ? u.path[u.pathIndex] : null;
    if (nd && nd.nav) {
        if (u._spatialEpoch !== spatialEpoch) return;
        const s = u._si, profile = nd.nav - 1, dest = nd.y * GRID_W + nd.x;
        if (Math.floor(c.y[s] / TILE) * GRID_W + Math.floor(c.x[s] / TILE) === dest) return;
        const did = navFieldRequest(profile, dest, !!nd.w);
        // (Arriving in a crowd short of the tile: groups only.)
        if (did >= 0) simFlowArm(c, s, did, navFieldGen(did), dest, cmd, profile === NAV_PROFILE_AIR, nd.ready | 0, !!u.workerState || !nd.w, _simWorkerKind(u), profile);
        return;
    }
    // (Workers walk their own paths: no group routes.)
    const worker = !!u.workerState;
    if (!worker && !u.holdPosition && u._spatialEpoch === spatialEpoch && _simMoveTryFlowArm(u, c, u._si, cmd)) return;
    const path = u.path, idx = u.pathIndex;
    // Waiting for its group's route (see routeGroupMembers): parked until
    // the route gives it a path (the path setter wakes it) or its wait ends.
    const waiting = !path || !(idx < path.length);
    if (waiting && worker) return;
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
        c.mvFlags[s] = flags; c.mvReach[s] = reach; c.mvWake[s] = u._awaitGroupPath;
        c.mvOn[s] = 2;
        return;
    }
    // The path window: nodes from pathIndex - 1, up to a portal link (the
    // kernel leaves those to Unit.update).
    const base = idx > 0 ? idx - 1 : 0, nb = simUnitPathWindow(c, s), nodes = c.mvNodes;
    // (Adjacent portal pairs only exist with cloud towers.)
    const clouds = _cloudTileCache && _cloudTileCache.size > 0;
    let wl = 0, px = 0, py = 0;
    for (; wl < SIM_MOVE_WINDOW && base + wl < path.length; wl++) {
        const n = path[base + wl], nx = n.x, ny = n.y;
        if (wl > 0 && (Math.abs(nx - px) + Math.abs(ny - py) !== 1 || (clouds && isCloudPortalLink(px, py, nx, ny, owner)))) break;
        // (A worker's path ends on its target's tile, where it may not
        // stand: Unit.update walks it from there on.)
        if (worker && wl > 0 && !canUnitOccupyTile(u, nx, ny)) break;
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
    c.mvScan[s] = -1; c.mvSpent[s] = 0; c.mvWk[s] = worker ? 1 : 0;
    c.mvOn[s] = 1;
}

// Approach (mvOn 6): a unit attacking a structure it is not in range of,
// following its path there (doAttacking's building branch: followPath).
// The kernel walks the path window, or the flow field of a nav node, as for
// a move (no scans) while the structure's tile (mvHT) still holds a hostile structure, its area is in
// sight and the unit is not in range (_simInAreaRange 0); it hands the unit
// back when in range or unsure, at the window's or path's end, and on an
// automatic target's look for enemy units ((t + id) % 8). Nothing during the
// pass can fail doAttacking's checks on the structure (hits land after it,
// destroyBuilding leaves its energy, sight is held), so no turn check.
function _simMoveTryApproachBuilding(u) {
    const c = u._us, tb = u.targetBuilding;
    if (!c || u.dead || u.holdPosition || u.workerState || u.targetUnit || !tb || u.attackTarget === tb || !(tb.energy > 0)) return;
    const path = u.path, idx = u.pathIndex;
    if (!path || !(idx < path.length)) return;
    const s = u._si, owner = u.owner, gx = tb.gx, gy = tb.gy;
    if (u._spatialEpoch !== spatialEpoch || c.sepKey[s] === SIM_SEP_ABSENT) return;
    if (!(owner >= 0 && owner < spatialUnitsComplexPlayerCount) || !spatialBlockCols) return;
    if (!(Number.isInteger(gx) && Number.isInteger(gy) && gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H)
        || tb.x !== gx * TILE + TILE / 2 || tb.y !== gy * TILE + TILE / 2) return;
    const k = Math.floor(Math.max(0, Number(_getUnitAttackRangeArea(u)) || 0));
    if (!(k <= 2)) return;
    const pc = u.preComputed;
    const spd = pc ? pc.speed * _getUnitAstarSpeedMultiplier(u) : NaN;
    if (!(spd >= 0)) return;
    // A flow navigation node next (_followNavNode): flow mode toward its
    // tile, without scans. Arriving short of it in a crowd only for a group
    // node (nd.w) that ends the path, as _followNavNode (the kernel hands
    // that arrival back to Unit.update); bit 128 otherwise.
    const nd = path[idx];
    if (nd.nav) {
        const dest = nd.y * GRID_W + nd.x, profile = nd.nav - 1;
        if (Math.floor(c.y[s] / TILE) * GRID_W + Math.floor(c.x[s] / TILE) === dest) return;
        const did = navFieldRequest(profile, dest, !!nd.w);
        if (!(did >= 0)) return;
        const crowd = !!nd.w && idx === path.length - 1;
        c.mvFlags[s] = 64 | (crowd ? 0 : 128) | (profile === NAV_PROFILE_AIR ? 32 : 0); c.mvReach[s] = k; c.mvSpd[s] = spd; c.mvNP[s] = profile;
        c.mvFlow[s] = did; c.mvFGen[s] = navFieldGen(did); c.mvDest[s] = dest; c.mvReady[s] = nd.ready | 0;
        c.mvWk[s] = 0; c.mvSpent[s] = 0;
        c.mvHT[s] = gy * GRID_W + gx; c.mvHTId[s] = u.forcedAttackTarget ? 1 : 0;
        c.mvOn[s] = 6;
        return;
    }
    // The path window, as simMoveTryArm's (and ending before a nav node).
    const base = idx > 0 ? idx - 1 : 0, nb = simUnitPathWindow(c, s), nodes = c.mvNodes;
    const clouds = _cloudTileCache && _cloudTileCache.size > 0;
    let wl = 0, px = 0, py = 0;
    for (; wl < SIM_MOVE_WINDOW && base + wl < path.length; wl++) {
        const n = path[base + wl], nx = n.x, ny = n.y;
        if (wl > 0 && (n.nav || Math.abs(nx - px) + Math.abs(ny - py) !== 1 || (clouds && isCloudPortalLink(px, py, nx, ny, owner)))) break;
        nodes[nb + wl] = ny * GRID_W + nx;
        px = nx; py = ny;
    }
    if (wl < 2 && base + wl < path.length) return;
    c.mvBase[s] = base; c.mvWlen[s] = wl; c.mvPlen[s] = path.length;
    c.mvFlags[s] = (u.pathIsFallbackAstar ? 8 : 0) | (u.isFlying ? 32 : 0);
    c.mvReach[s] = k; c.mvSpd[s] = spd;
    c.mvLane[s] = Math.max(1.5, Math.min(4, u.r * 0.6));
    c.mvCost[s] = _resolveUnitAstarTileCost(u);
    c.mvScan[s] = -1; c.mvSpent[s] = 0; c.mvWk[s] = 0;
    c.mvHT[s] = gy * GRID_W + gx; c.mvHTId[s] = u.forcedAttackTarget ? 1 : 0;
    c.mvOn[s] = 6;
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
// leaves its tile (the range is a matter of that), or the target's area
// leaves its owner's sight. A forced target (an order, retaliation:
// mvFlags 8): the kernel keeps its last seen position as doAttacking does
// (fLsX/fLsY, while its area is in sight; out of sight Unit.update decides,
// contact counts there). Held units and structures stay in Unit.update.
function simMoveTryHold(u) {
    const c = u._us, tu = u.targetUnit;
    if (c && !tu && u.targetBuilding) { _simMoveTryHoldBuilding(u, c); return; }
    if (!c || u.dead || u.holdPosition || u.workerState || !tu || tu.dead || u.targetBuilding || u.attackTarget !== tu || u.path) return;
    // (A timer of one tick: held too, its attack next tick made by the
    // kernel's hand-back, simHoldFire, not a whole Unit.update.)
    if (!(u.attackTimer > 0) || !(u.preComputed && u.preComputed.attackDamage > 0)) return;
    const q = tu._si, tc = tu._us;
    if (tc !== c || !(q >= 0) || u._spatialEpoch !== spatialEpoch || c.sepKey[u._si] === SIM_SEP_ABSENT) return;
    // (Range in area steps; the kernel works out up to 1, touching included.
    // Longer: held while it stands in the window and its target on the tile
    // it is in range by areas from: the result is a pure function of those.)
    const k = Math.floor(Math.max(0, Number(_getUnitAttackRangeArea(u)) || 0));
    const s = u._si;
    if (!(k <= 1)) {
        const tx = _unitTickX(tu), ty = _unitTickY(tu), tgx = Math.floor(tx / TILE), tgy = Math.floor(ty / TILE);
        if (!(tgx >= 0 && tgy >= 0 && tgx < GRID_W && tgy < GRID_H) || !isWorldTargetWithinAreaRange(u.x, u.y, tx, ty, k)) return;
        c.mvHWin[s] = simWindowKey(u.x, u.y, TILE); c.mvHTT[s] = tgy * GRID_W + tgx; c.mvHVer[s] = _simAreaLayoutVer;
    }
    // (A short hold: the kernel keeps its last in-range-by-areas look in
    // mvHWin / mvHTT / mvHVer; none yet.)
    else c.mvHVer[s] = -1;
    c.mvHT[s] = q; c.mvHTId[s] = tu.id; c.mvReach[s] = k;
    // (Its target stepping out of range: the kernel takes the chase's step,
    // see simMoveTryChase.)
    c.mvChs[s] = Math.max(TILE * 0.6, Number(u.preComputed.speed) || 1);
    // (Bit 4: its attacks made by the kernel, simHoldFire's work at the
    // pass's start; not a ram's, whose recoil is the object's.)
    const kf = SIM_KERNEL_FIRE && u.attackStyle !== 'ram';
    if (kf) { c.atkCd[s] = u.preComputed.attackCooldown; c.atkDmg[s] = u.preComputed.attackDamage; c.atkSty[s] = _hitStyleCode(u); }
    c.mvFlags[s] = (u.isFlying ? 32 : 0) | (u.forcedAttackTarget ? 8 : 0) | (kf ? 4 : 0);
    c.mvOn[s] = 3;
}

// Building hold (mvOn 5): a unit attacking a structure in range, waiting for
// its cooldown (doAttacking's building branch: alive, visible, in area
// range, attackTimer above 0). The kernel keeps it while the structure's
// tile still holds a hostile structure (mv.struct), its area is in sight,
// it is in range and the timer runs, and hands it back on its attack tick,
// on an automatic target's reconsideration tick ((t + id) % 8: a look for
// enemy units) and on the usual floor/wall checks. The structure's own
// state is checked again at the unit's turn (simHoldStillValid).
function _simMoveTryHoldBuilding(u, c) {
    const tb = u.targetBuilding;
    if (u.dead || u.holdPosition || u.workerState || u.path || u.attackTarget !== tb || !(tb.energy > 0)) return;
    if (!(u.attackTimer > 0) || !(u.preComputed && u.preComputed.attackDamage > 0)) return;
    const s = u._si, gx = tb.gx, gy = tb.gy;
    if (u._spatialEpoch !== spatialEpoch || c.sepKey[s] === SIM_SEP_ABSENT) return;
    // (The kernel knows the tile; a structure stands at its centre.)
    if (!(Number.isInteger(gx) && Number.isInteger(gy) && gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H)
        || tb.x !== gx * TILE + TILE / 2 || tb.y !== gy * TILE + TILE / 2) return;
    const k = Math.floor(Math.max(0, Number(_getUnitAttackRangeArea(u)) || 0));
    if (!(k <= 2)) return;
    c.mvDest[s] = gy * GRID_W + gx; c.mvReach[s] = k;
    c.mvFlags[s] = u.forcedAttackTarget ? 1 : 0;
    c.mvOn[s] = 5;
}

// Chase: a unit after an enemy unit it is not in range of, with no path of
// its own, steps straight at it while _isChaseStepOpen (or it is close, or
// flies) in doAttacking. The kernel does those ticks: it hands the unit back
// when the target dies, leaves its owner's sight, comes in range or out of
// leash (a forced target has none: mvFlags 8, its last seen position kept
// as for a hold), when the straight step is not open or would enter a wall
// or a structure's tile, and on a hostile floor. Structures, held units and
// workers stay in Unit.update.
// Checked again at the unit's turn in the pass (simChaseStillValid).
function simMoveTryChase(u) {
    const c = u._us, tu = u.targetUnit;
    // (attackTarget may still name its target from a tick it was in range:
    // doAttacking's chase leaves it, nothing on the way reads it. A unit in
    // range the hold did not take (its attack tick, a path left) comes out
    // of the kernel as come in range: simHoldChaseCommit, the same.)
    if (!c || u.dead || u.holdPosition || u.workerState || !tu || tu.dead || u.targetBuilding) return;
    // (With a path of its own, doAttacking steps straight only when close or
    // the step is open, flying or not; otherwise it follows the path:
    // Unit.update. Bit 1 tells the kernel.)
    const hasPath = !!(u.path && u.pathIndex < u.path.length);
    const pc = u.preComputed;
    if (!(pc && pc.attackDamage > 0)) return;
    const q = tu._si, s = u._si;
    if (tu._us !== c || !(q >= 0) || u._spatialEpoch !== spatialEpoch || c.sepKey[s] === SIM_SEP_ABSENT) return;
    // (Range in area steps; the kernel works out up to 2, touching included.)
    const k = Math.floor(Math.max(0, Number(_getUnitAttackRangeArea(u)) || 0));
    if (!(k <= 1)) return;
    // (Bit 4: come in range, its attack made by the kernel, as a hold's.)
    const kf = SIM_KERNEL_FIRE && u.attackStyle !== 'ram';
    if (kf) { c.atkCd[s] = pc.attackCooldown; c.atkDmg[s] = pc.attackDamage; c.atkSty[s] = _hitStyleCode(u); }
    let flags = (u.isFlying ? 32 : 0) | (hasPath ? 2 : 0) | (u.forcedAttackTarget ? 8 : 0) | (kf ? 4 : 0);
    // Its path's next node a nav node (navPathTo): the kernel follows its
    // flow field when the straight step is not open (followPath ->
    // _followNavNode), as _simMoveTryApproachBuilding arms it.
    const nd = hasPath ? u.path[u.pathIndex] : null;
    if (nd && nd.nav && ((nd.nav - 1) === NAV_PROFILE_AIR) === !!u.isFlying) {
        const dest = nd.y * GRID_W + nd.x, profile = nd.nav - 1;
        const spd = pc.speed * _getUnitAstarSpeedMultiplier(u);
        if (Math.floor(c.y[s] / TILE) * GRID_W + Math.floor(c.x[s] / TILE) !== dest && spd >= 0) {
            const did = navFieldRequest(profile, dest, !!nd.w);
            if (did >= 0) {
                const crowd = !!nd.w && u.pathIndex === u.path.length - 1;
                flags |= 64 | (crowd ? 0 : 128);
                c.mvSpd[s] = spd; c.mvFlow[s] = did; c.mvFGen[s] = navFieldGen(did); c.mvDest[s] = dest; c.mvReady[s] = nd.ready | 0; c.mvNP[s] = profile;
                c.mvWk[s] = 0; c.mvSpent[s] = 0;
            }
        }
    }
    c.mvHT[s] = q; c.mvHTId[s] = tu.id; c.mvReach[s] = k;
    c.mvChs[s] = Math.max(TILE * 0.6, Number(pc.speed) || 1);
    c.mvFlags[s] = flags;
    c.mvOn[s] = 4;
}
// A chasing unit the kernel moved (output 7-9), at its turn: whether that
// move still stands (its target and itself alive, its orders the same, the
// walls as they were). Otherwise the move is undone and Unit.update runs.
// (on: 3 for a hold's chase step or a chase come in range, outputs 11-13.)
function simChaseStillValid(c, s, on = 4) {
    if (c.mvOn[s] !== on || c.dead[s] || !(c.energy[s] > 0) || _simMoveWallDirty || _simMoveWallVer !== _simMoveRunWallVer || (_simMoveWallQ.length && _simMoveWallQNear(c, s))) return false;
    const q = c.mvHT[s];
    if (!(q >= 0) || c.dead0[q] || (c.id[q] | 0) !== c.mvHTId[s]) return false;
    const u = _simUnitState.owners[s], tu = u && u.targetUnit;
    return !!tu && tu._si === q && u.commandState === CMD_ATTACKING && !!u.forcedAttackTarget === ((c.mvFlags[s] & 8) !== 0) && !u.targetBuilding && !u.holdPosition;
}
function simChaseUndo(c, s) {
    c.mvOn[s] = 0; c.mvOut[s] = 0;
    c.x[s] = c.prevX[s]; c.y[s] = c.prevY[s];
}
// The last seen position of a forced target as before the kernel's write
// this tick (fLsT): the unit runs Unit.update after all (handed back, or its
// hold or chase no longer standing at its turn).
function simForcedSeenUndo(c, s) {
    c.fLsX[s] = c.fLsPX[s]; c.fLsY[s] = c.fLsPY[s]; c.fLsT[s] = -1;
}

// A held unit at its turn in the update pass (kernel output 6): whether the
// hold still stands now, after the units before it in the pass (a target
// they killed or moved, sight they took away...). Otherwise it runs
// Unit.update after all: what it would have done at this point.
function simHoldStillValid(c, s) {
    // (Targets are seen where they were at the pass's start, hits land
    // after it: only a death during the pass, or walls changed, matter.)
    const on = c.mvOn[s];
    if ((on !== 3 && on !== 5) || c.dead[s] || !(c.energy[s] > 0) || _simMoveWallDirty || _simMoveWallVer !== _simMoveRunWallVer || (_simMoveWallQ.length && _simMoveWallQNear(c, s))) return false;
    if (on === 5) {
        // A structure: still standing, still the unit's target.
        const u = _simUnitState.owners[s], tb = u && u.targetBuilding;
        return !!tb && tb.energy > 0 && !u.targetUnit && u.attackTarget === tb && u.commandState === CMD_ATTACKING && !u.holdPosition
            && tb.gy * GRID_W + tb.gx === c.mvDest[s];
    }
    const q = c.mvHT[s];
    return q >= 0 && !c.dead0[q] && (c.id[q] | 0) === c.mvHTId[s];
}
// A held unit's attack tick (kernel output 10), its hold still standing at
// its turn: what Unit.update does then (doAttacking in range with the timer
// run out: the attack on its target, unit or structure), and, as at its end,
// armed again (the timer restarted).
function simHoldFire(c, s) {
    const u = _simUnitState.owners[s];
    if (c.mvOn[s] === 5) { const tb = u.targetBuilding; u.attackTarget = tb; u._performAttackOnBuilding(tb); }
    else { const tu = u.targetUnit; u.attackTarget = tu; u._performAttackOnUnit(tu); }
    c.mvOn[s] = 0;
    if (u.dead || u.commandState !== CMD_ATTACKING) return;
    simMoveTryHold(u);
    if (c.mvOn[s] !== 3 && c.mvOn[s] !== 5) { simMoveTryChase(u); if (c.mvOn[s] !== 4) _simMoveTryApproachBuilding(u); }
}
// A hold whose target stepped out of range, after its step (kernel output
// 11, 12), or a chase come in range (13), at its turn (simChaseStillValid):
// the rest of what Unit.update does then (doAttacking in range: its target
// the attack target, its path dropped, the attack on its attack tick) and,
// as at its end, armed again.
function simHoldChaseCommit(c, s, o) {
    const u = _simUnitState.owners[s];
    c.mvOn[s] = 0;
    if (o === 13) {
        const tu = u.targetUnit;
        u.attackTarget = tu; u.path = null;
        if (u.attackTimer <= 0) u._performAttackOnUnit(tu);
        if (u.dead || u.commandState !== CMD_ATTACKING) return;
    }
    simMoveTryHold(u);
    if (c.mvOn[s] !== 3 && c.mvOn[s] !== 5) { simMoveTryChase(u); if (c.mvOn[s] !== 4) _simMoveTryApproachBuilding(u); }
}
// A chase come in range (output 13), at its turn: doAttacking in range (its
// target the attack target, its path dropped, its attack on its attack tick
// unless the kernel made it) and held again: as simMoveTryHold arms it from
// the chase's columns (the same target, range and step) when its timer
// runs; else the whole arming.
function simChaseInRangeCommit(c, s) {
    const u = _simUnitState.owners[s], tu = u.targetUnit;
    u.attackTarget = tu; u.path = null;
    c.mvOn[s] = 0;
    if (u.attackTimer <= 0) u._performAttackOnUnit(tu);
    if (u.dead || u.commandState !== CMD_ATTACKING) return;
    if (u.attackTimer > 0 && tu && !tu.dead && !u.holdPosition && !u.targetBuilding) {
        c.mvHVer[s] = -1;
        c.mvFlags[s] = (c.mvFlags[s] & 40) | (SIM_KERNEL_FIRE && u.attackStyle !== 'ram' ? 4 : 0);
        c.mvOn[s] = 3;
        return;
    }
    simMoveTryHold(u);
    if (c.mvOn[s] !== 3 && c.mvOn[s] !== 5) { simMoveTryChase(u); if (c.mvOn[s] !== 4) _simMoveTryApproachBuilding(u); }
}
// The units the kernel moved or held, not visited in the pass, on a tile
// that became a wall during it: pushed out as the end of their Unit.update
// would have, in id order.
function simPassWallFixups(S) {
    const q = _simMoveWallQ;
    if (!q.length) return;
    const c = S.columns, OUT = c.mvOut, list = [], seen = new Set();
    for (let i = 0; i < q.length; i += 2) {
        const gx = q[i], gy = q[i + 1], row = grid[gy], cell = row ? row[gx] : null;
        if (!cell || cell.type !== TYPE_WALL) continue;
        forEachUnitInRange(gx * TILE + TILE / 2, gy * TILE + TILE / 2, TILE * 1.5, u => {
            const s = u._si;
            if (!(s >= 0) || u._us !== c || seen.has(u)) return;
            const o = OUT[s];
            if (o === 0 || o === 10 || o >= 13 || o === 4 || o === 5 || u.dead || u.isFlying) return;
            if (Math.floor(c.x[s] / TILE) !== gx || Math.floor(c.y[s] / TILE) !== gy) return;
            seen.add(u); list.push(u);
        });
    }
    list.sort((a, b) => a.id - b.id);
    for (const u of list) {
        pushUnitOutOfBlockedTile(u);
        u.x = _quantizeUnitWorldCoord(u.x); u.y = _quantizeUnitWorldCoord(u.y);
        updateUnitSpatial(u);
    }
}
function simHoldUndo(c, s) {
    c.mvOn[s] = 0; c.mvOut[s] = 0;
}
// A drive-by shooter the kernel moved whose look (SIM_KERNEL_DRIVEBY) found
// something (mvFire): at its turn, its shot, as at the end of Unit.update
// (after its step, from where it stands then).
function simDriveByFire(c, s, u) {
    if (u.dead || !(c.energy[s] > 0) || u.commandState !== CMD_MOVING) return;
    u.tryDriveByAttack();
}
// A held or chasing unit whose target died (kernel output 15, as at the
// pass's start): at its turn, what Unit.update does then (doAttacking: its
// target dropped, idle, an attack-move resumed; then its end). False: not
// as the kernel saw it, Unit.update runs.
function simTargetDiedCommit(c, s, u) {
    if (c.dead[s] || !(c.energy[s] > 0) || _simMoveWallDirty || _simMoveWallVer !== _simMoveRunWallVer) return false;
    if (!u || u.dead || u.workerState || u.commandState !== CMD_ATTACKING || u.targetBuilding || !u.targetUnit || !_unitTickDead(u.targetUnit)) return false;
    if (c.fLsT[s] === gameTime) simForcedSeenUndo(c, s);
    u.prevX = u.x; u.prevY = u.y;
    u.targetUnit = null; u.attackTarget = null; u.forcedAttackTarget = false; u.commandState = CMD_IDLE;
    u._resumeAttackMove();
    _unitUpdateEnd(u, c, false);
    return true;
}
// An attack-mover or idle combat unit whose aggro look (the acquisition
// tier's target, on its acquisition tick) found a unit: kernel output 14 (it
// stood: no move). At its turn, what Unit.update would do there: the
// preamble (the floor was the kernel's check), doAttackMoving's / doIdle's
// first branch (that target, unforced, attacking), the end (push out of a
// blocked tile, the index, re-armed as an attacker). False: the unit runs
// Unit.update after all (not as the kernel saw it, or a wall changed by it).
function simEngageCommit(c, s) {
    // (Walls changed by the pass's units: its tile looked at after the pass,
    // _simPassWallFixups.)
    if (c.dead[s] || !(c.energy[s] > 0) || _simMoveWallDirty || _simMoveWallVer !== _simMoveRunWallVer) return false;
    const u = _simUnitState.owners[s];
    if (!u || u.dead || u.workerState || u.holdPosition) return false;
    const cmd = u.commandState;
    if (cmd !== CMD_ATTACK_MOVING && !(cmd === CMD_IDLE && u.unitType !== 'scout')) return false;
    if (c.fLsT[s] === gameTime || !_unitAcquireTick(u)) return false;
    const e = _combatScanTarget(u, Math.max(TILE, u.preComputed.visionRange * TILE));
    if (!e) return false;
    // (It stood: prevX/prevY are the kernel's, its position quantized and
    // indexed already; its tile was open at the pass's start.)
    u.targetUnit = e;
    u.forcedAttackTarget = false;
    u.commandState = CMD_ATTACKING;
    simMoveTryHold(u);
    if (c.mvOn[s] !== 3 && c.mvOn[s] !== 5) { simMoveTryChase(u); if (c.mvOn[s] !== 4) _simMoveTryApproachBuilding(u); }
    return true;
}

// An idle combat unit with nothing in reach parks too: the kernel checks its
// floor and its aggro box (hostile units or structures there: back to
// Unit.update, which engages) each tick, and wakes it every
// SIM_IDLE_PARK_TICKS for its periodic checks, at its own phase of them
// ((tick + id) % SIM_IDLE_PARK_TICKS === 0): the units parked on one tick
// (a match's start) do not all wake on one later tick. (A safety net: the
// kernel hands a parked unit back for anything its update would act on;
// every 100 ticks cost ~1500 updates a tick with 150k idle units.)
const SIM_IDLE_PARK_TICKS = 1000;
function simMoveTryParkIdle(u) {
    const c = u._us;
    if (!c || u.dead || u.holdPosition || u.workerState || u.unitType === 'scout' || u._attackMoveGx != null) return;
    const s = u._si, reach = c.mvReachA[s];
    if (u._spatialEpoch !== spatialEpoch || c.sepKey[s] === SIM_SEP_ABSENT || reach === 255) return;
    const P = SIM_IDLE_PARK_TICKS, ph = (((gameTime + (u.id | 0)) % P) + P) % P;
    c.mvWake[s] = gameTime + P - ph; c.mvFlags[s] = 16; c.mvReach[s] = reach;
    c.mvOn[s] = 2;
}
// A unit waiting for its way (a pending target, no path: the helpers'
// answer, or a look again, at its retry tick): parked till then, so the
// simulation thread does nothing for it meanwhile (the kernel stands it,
// and hands an attack-mover back for what it would engage, as an idle one).
function simMoveTryParkWait(u, cmd) {
    const c = u._us, wake = u._astarBudgetRetryTick;
    if (!c || !(wake > gameTime + 1) || u.unitType === 'scout') return;
    const s = u._si;
    if (u._spatialEpoch !== spatialEpoch || c.sepKey[s] === SIM_SEP_ABSENT) return;
    // (Its looks as when it moves, simFlowArm: an attack-mover's aggro, a
    // shooter's drive-by.)
    let flags = 0, reach = 0;
    if (cmd === CMD_ATTACK_MOVING) {
        reach = c.mvReachA[s];
        if (reach === 255) return;
        flags = 16;
    } else if (c.mvShoot[s]) {
        reach = c.mvReachD[s];
        const area = c.spArea[s];
        if (reach === 255 || !(area >= 0)) return;
        _simMoveEnsureAreaBox(area, reach);
        flags = 1;
    }
    c.mvWake[s] = wake; c.mvFlags[s] = flags; c.mvReach[s] = reach;
    c.mvOn[s] = 2;
}
// A held unit with orders to move (hold keeps its orders, path and
// progress; followPath stands it): Unit.update only looks for what to shoot
// (a drive-by shooter: tryDriveByAttack) or to engage (an attack-mover:
// doAttackMoving's looks) and checks its floor. Parked with those looks, as
// a waiting one (simMoveTryParkWait); released (stop: hold off, disarmed),
// ordered again (the setters disarm) or woken at its own phase of
// SIM_IDLE_PARK_TICKS (a safety net). (Thousands of held movers ran a
// near-empty Unit.update every tick: ~9k a tick in the ACTIONS bench.)
function simMoveTryParkHeld(u, cmd) {
    const c = u._us;
    if (!c || u.dead || !u.holdPosition || u.workerState || u.unitType === 'scout') return;
    // (A way to keep: without one, its looks for a way and its arrival are
    // Unit.update's.)
    if (!u.path || !(u.pathIndex < u.path.length)) return;
    const s = u._si;
    if (u._spatialEpoch !== spatialEpoch || c.sepKey[s] === SIM_SEP_ABSENT) return;
    let flags = 0, reach = 0;
    if (cmd === CMD_ATTACK_MOVING) {
        reach = c.mvReachA[s];
        if (reach === 255) return;
        flags = 16;
    } else if (c.mvShoot[s]) {
        reach = c.mvReachD[s];
        const area = c.spArea[s];
        if (reach === 255 || !(area >= 0)) return;
        _simMoveEnsureAreaBox(area, reach);
        flags = 1;
    }
    const P = SIM_IDLE_PARK_TICKS, ph = (((gameTime + (u.id | 0)) % P) + P) % P;
    c.mvWake[s] = gameTime + P - ph; c.mvFlags[s] = flags; c.mvReach[s] = reach;
    c.mvOn[s] = 2;
}
// A worker at its work (its path done, nothing pending) whose transfer
// cooldown runs: Unit.update only stands it there until the cooldown runs
// out (updateWorkerAI; the status pre-pass counts it down), so it is parked
// until that tick.
function simMoveTryParkWork(u) {
    const c = u._us;
    if (!c || u.dead || u.holdPosition || u.workerState === 'MANUAL_MOVE' || !(u.workerTransferCooldown > 0)) return;
    if ((u.path && u.pathIndex < u.path.length) || u._pendingPathTarget) return;
    const s = u._si;
    if (u._spatialEpoch !== spatialEpoch || c.sepKey[s] === SIM_SEP_ABSENT) return;
    c.mvWake[s] = gameTime + Math.ceil(u.workerTransferCooldown); c.mvFlags[s] = 0;
    c.mvOn[s] = 2;
}
// A tick bound for an Int32 column the kernels compare as t < bound: the
// same answer for every integer tick t (NaN: never, Infinity: always).
function _simTickBound(v) { return v === v ? (v >= 2147483647 ? 2147483647 : v <= -2147483648 ? -2147483648 : Math.ceil(v)) : -2147483648; }
function simMoveTryPark(u) {
    const c = u._us;
    if (!c || u.dead || u.holdPosition || u.workerTransferCooldown > 0) return;
    const s = u._si;
    if (u._spatialEpoch !== spatialEpoch || c.sepKey[s] === SIM_SEP_ABSENT) return;
    // Registered with the search tier (worker.js wsRegister): parked till the
    // tier hands it its work; only a builder's watchdog sample (pushed away)
    // or its recheck (with a target) wakes it.
    if (c.wsKind[s] && typeof _wsRegistered === 'function' && _wsRegistered(u)) {
        const watchStill = u.workerType === 'builder' && Number.isFinite(u._builderLastWatchX) && Number.isFinite(u._builderLastWatchY)
            && u._builderLastWatchX === c.x[s] && u._builderLastWatchY === c.y[s];
        let wake = gameTime + 0x3fffffff;
        if (u.workerType === 'builder') {
            if (u.workerTarget && Number.isFinite(u._builderNextRecheckTick) && u._builderNextRecheckTick < wake) wake = u._builderNextRecheckTick;
            const w = gameTime + 1 + (((BUILDER_WATCH_TICKS - ((gameTime + 1 + u.id) % BUILDER_WATCH_TICKS)) % BUILDER_WATCH_TICKS) + BUILDER_WATCH_TICKS) % BUILDER_WATCH_TICKS;
            if (w < wake && !watchStill) wake = w;
        }
        if (!(wake > gameTime + 1)) return;
        c.mvWake[s] = wake; c.mvFlags[s] = watchStill ? 4 : 0;
        if (watchStill) { c.wkWx[s] = u._builderLastWatchX; c.wkWy[s] = u._builderLastWatchY; }
        c.mvOn[s] = 2;
        return;
    }
    const next = u._workerNextIdleRetargetTick;
    if (!Number.isFinite(next)) return;
    // (A collector with no idle start yet sets it on its next update: not parked.)
    if (isResourceCollectorWorkerType(u.workerType) && !u._lastIdleStateTime) return;
    const id = u.id, delay = Math.max(1, Math.floor(Number(WORKER_AI_TICK_DELAY) || 1));
    const per = Math.ceil(getWorkerIdleSearchTicks() / delay);
    // (A builder's watchdog samples change nothing while it stands where
    // the last one was taken: the kernel wakes it at a sample tick only when
    // it was pushed away, mvFlags 4.)
    const watchStill = u.workerType === 'builder' && Number.isFinite(u._builderLastWatchX) && Number.isFinite(u._builderLastWatchY)
        && u._builderLastWatchX === c.x[s] && u._builderLastWatchY === c.y[s];
    // Its next wake for anything but a search: its scheduled search (none
    // while a failed search's backoff runs: its end wakes it), a builder's
    // recheck (with a target) and watchdog sample, its search origin
    // changing.
    const failVer = u._idleFailVer, failUntil = u._idleFailUntil;
    // (A collector that has no idle start yet sets it on its next update.)
    const backoff = workerIdleBackoff(u, gameTime + 1)
        && !(isResourceCollectorWorkerType(u.workerType) && !u._lastIdleStateTime);
    // (In a backoff its scheduled search comes at the backoff's end, if not
    // due later: shouldRunWorkerIdleRetarget's schedule.)
    let sched = backoff ? Math.max(next, failUntil) : next;
    const originUntil = _workerWorkOriginUntil(u);
    if (originUntil < sched) sched = originUntil;
    if (u.workerType === 'builder') {
        if (u.workerTarget && Number.isFinite(u._builderNextRecheckTick) && u._builderNextRecheckTick < sched) sched = u._builderNextRecheckTick;
        const w = gameTime + 1 + (((BUILDER_WATCH_TICKS - ((gameTime + 1 + id) % BUILDER_WATCH_TICKS)) % BUILDER_WATCH_TICKS) + BUILDER_WATCH_TICKS) % BUILDER_WATCH_TICKS;
        if (w < sched && !watchStill) sched = w;
    }
    // Then its periodic search tick (see shouldRunWorkerIdleRetarget).
    let wake = sched;
    for (let t = gameTime + 1; t < wake; t++) {
        if (((t + id) % delay) === 0 && (Math.floor((t + id) / delay) % per) === 0) { wake = t; break; }
    }
    if (!(wake > gameTime + 1)) return;
    c.mvWake[s] = wake; c.mvFlags[s] = watchStill ? 4 : 0;
    if (watchStill) { c.wkWx[s] = u._builderLastWatchX; c.wkWy[s] = u._builderLastWatchY; }
    // Its search ticks while nothing changed (its last search failed at work
    // version wkFail, until wkUntil): the kernel checks the version and keeps
    // it parked (shouldRunWorkerIdleRetarget would return at once).
    if (backoff) {
        const org = _workerWorkOrigin(u);
        c.wkType[s] = _workerWorkType(u.workerType); c.wkD[s] = Math.ceil(_getWorkerAutoSearchDistancePx(u) / TILE) + 1;
        c.wkOx[s] = Math.floor(org.x / TILE); c.wkOy[s] = Math.floor(org.y / TILE);
        c.wkTwice[s] = org !== u ? 1 : 0;
        c.wkFail[s] = failVer | 0; c.wkUntil[s] = _simTickBound(failUntil); c.wkSched[s] = _simTickBound(sched);
        c.mvFlags[s] |= 2;
    }
    c.mvOn[s] = 2;
}

// Drive-by boxes: per area and steps, the tile box of the areas within
// that many steps (getAreaRangeTileBox), for the kernel. Reset with the area
// layout.
const SIM_MOVE_BOX_STEPS = 9;
let _simMoveAreaBox = null, _simMoveAreaBoxOk = null, _simMoveAreaBoxFor = null;
// (Set when the table is made anew: simMoveRun makes the boxes of the armed
// shooters again, once.)
let _simMoveAreaBoxesNew = true;
function _simMoveAreaBoxes() {
    const A = Math.max(1, areaDistanceMatrix ? areaDistanceMatrix.length : 0);
    if (_simMoveAreaBoxFor !== areaDistanceMatrix || !_simMoveAreaBoxOk || _simMoveAreaBoxOk.length !== A * SIM_MOVE_BOX_STEPS) {
        _simMoveAreaBoxesNew = true;
        _simMoveAreaBox = simHeapArrayAuto(Int32Array, A * SIM_MOVE_BOX_STEPS * 4);
        _simMoveAreaBoxOk = simHeapArrayAuto(Uint8Array, A * SIM_MOVE_BOX_STEPS);
        _simMoveAreaBoxFor = areaDistanceMatrix;
        simParallelBind('mv.areaBox', _simMoveAreaBox); simParallelBind('mv.areaBoxOk', _simMoveAreaBoxOk);
        _simAreaBoxJob = { layout: areaDistanceMatrix, out: null };
    }
    if (_simAreaBoxJob) _simAreaBoxStep();
}
// Every area's boxes at every distance, made on the helpers for a new layout
// (SIM_KERNEL_AREA_BOX, lane SIM_LANE_BUILD) and taken whole when done: an
// army's first order, or its march into new ground, made each area's box at
// once in the tick (a 56k-unit order: ~100 ms). Until then a box is made
// when first needed, the same box. (Without helpers: made at once.)
let _simAreaBoxJob = null;
function _simAreaBoxStep() {
    const J = _simAreaBoxJob, lane = typeof SIM_LANE_BUILD === 'number' ? SIM_LANE_BUILD : -1;
    if (J.layout !== areaDistanceMatrix || lane < 0 || typeof SIM_KERNEL_AREA_BOX !== 'number') { _simAreaBoxJob = null; return; }
    const D = SIM_MOVE_BOX_STEPS, A = _simMoveAreaBoxOk.length / D;
    if (!J.out) {
        if (simParallelBackgroundPending(lane)) return;
        _simAreaCsr();
        const own = simHeapArrayAuto(Int32Array, A * 4), out = simHeapArrayAuto(Int32Array, A * D * 4);
        for (let a = 0; a < A; a++) {
            const ar = _areaById[a], o = a * 4;
            if (ar) { own[o] = ar.minGx; own[o + 1] = ar.minGy; own[o + 2] = ar.maxGx; own[o + 3] = ar.maxGy; }
            else { own[o] = 1; own[o + 1] = 1; own[o + 2] = 0; own[o + 3] = 0; }
        }
        simParallelBind('abox.own', own); simParallelBind('abox.out', out);
        simParallelBind('abox.off', _simParReg['area.off']); simParallelBind('abox.nb', _simParReg['area.nb']);
        const stages = [];
        for (let d = 0; d < D; d++) {
            const P = simParallelStageParams(lane, d);
            P.fill(0); P[0] = A; P[1] = 4096; P[2] = D; P[3] = d;
            stages.push([SIM_KERNEL_AREA_BOX, Math.ceil(A / 4096)]);
        }
        J.out = out;
        simParallelBackgroundChain(lane, stages, true);
    }
    if (simParallelBackgroundPending(lane) && !simParallelBackgroundDone(lane)) return;
    simParallelBackgroundWait(lane);
    // (The same layout as the table's: k = area * D + distance.)
    _simMoveAreaBox = J.out;
    simParallelBind('mv.areaBox', _simMoveAreaBox);
    _simMoveAreaBoxOk.fill(1);
    _simAreaBoxJob = null;
}
// An area's box at a distance from the table (getAreaRangeTileBox's row
// format: an empty box as [GRID_W, GRID_H, -1, -1]) when the table holds it
// for the current layout; else nothing written.
function simMoveAreaBoxRead(area, steps, out, o) {
    if (_simMoveAreaBoxFor !== areaDistanceMatrix || !_simMoveAreaBoxOk || !(steps >= 0 && steps < SIM_MOVE_BOX_STEPS)) return;
    const k = area * SIM_MOVE_BOX_STEPS + steps;
    if (!(k >= 0 && k < _simMoveAreaBoxOk.length) || !_simMoveAreaBoxOk[k]) return;
    const B = _simMoveAreaBox, b = k * 4;
    if (B[b] > B[b + 2]) { out[o] = GRID_W; out[o + 1] = GRID_H; out[o + 2] = -1; out[o + 3] = -1; return; }
    out[o] = B[b]; out[o + 1] = B[b + 1]; out[o + 2] = B[b + 2]; out[o + 3] = B[b + 3];
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
// Per 8x8 tile block, a count of its wall changes (the kernel's cached
// flow look-aheads depend on the walls within 8 tiles: keyed by the sum
// over the 3x3 blocks around the unit's tile).
let _simMoveWallBlk = null, _simMoveWallBlkW = 0;
// Bumped whenever a wall changes (the kernel's cached look-aheads check it).
let _simMoveWallVer = 0;
// During the unit pass the wall table stands still (the kernel and every
// Unit.update see the walls of the pass's start): tile type changes are
// applied at its end, in order. (Holds and chases check _simMoveWallQNear.)
let _simMoveWallQ = [];
// The tiles changed so far this pass (stamped with the pass's number): a
// kernel hold or chase at its turn stands unless one is within a tile of
// where the unit started or ended up. Its decisions read the walls of the
// pass's start (simMoveWallGrid: the same as the kernel's); only the end of
// Unit.update reads its own tile live (pushUnitOutOfBlockedTile). Any change
// anywhere sent every later hold and chase through Unit.update: towers
// falling in a battle, ~9k units a tick at 200k.
let _simMoveWallQT = null, _simMoveWallQGen = 0;
function _simMoveWallQMark(gx, gy) {
    const n = GRID_W * GRID_H;
    if (!_simMoveWallQT || _simMoveWallQT.length !== n) { _simMoveWallQT = new Uint8Array(n); _simMoveWallQGen = 0; }
    if (_simMoveWallQ.length === 2) { if (++_simMoveWallQGen > 255) { _simMoveWallQT.fill(0); _simMoveWallQGen = 1; } }
    if (gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H) _simMoveWallQT[gy * GRID_W + gx] = _simMoveWallQGen;
}
let _simMoveWallQKept = 0;
function _simMoveWallQNear(c, s) {
    const T = _simMoveWallQT, g = _simMoveWallQGen;
    if (!T) return true;
    _simMoveWallQKept++;
    const W = GRID_W, H = GRID_H;
    for (let pass = 0; pass < 2; pass++) {
        const gx = Math.floor((pass ? c.x[s] : c.prevX[s]) / TILE), gy = Math.floor((pass ? c.y[s] : c.prevY[s]) / TILE);
        if (!(gx >= 0 && gy >= 0 && gx < W && gy < H)) return true;
        for (let y = gy - 1; y <= gy + 1; y++) {
            if (y < 0 || y >= H) continue;
            for (let x = gx - 1; x <= gx + 1; x++) if (x >= 0 && x < W && T[y * W + x] === g) { _simMoveWallQKept--; return true; }
        }
    }
    return false;
}
function simMoveWallsDeferEnd() {
    if (_simMoveWallQ.length) {
        const q = _simMoveWallQ;
        _simMoveWallQ = [];
        for (let i = 0; i < q.length; i += 2) simMoveTileTypeChanged(q[i], q[i + 1]);
    }
    if (_simClassQ.length) {
        const q = _simClassQ;
        _simClassQ = [];
        for (let i = 0; i < q.length; i++) _simMoveClassTileChanged(q[i]);
    }
}
// Tile entities changed during the pass: the walk classes' walls (see
// navClassTileChanged) follow at its end, as the walls do.
let _simClassQ = [];
// The walk classes' walls at tile k (flownav.js), and when any changed the
// wall versions the cached look-aheads check (as a wall change).
function _simMoveClassTileChanged(k) {
    if (typeof navClassTileChanged !== 'function' || !navClassTileChanged(k)) return;
    const gx = k % GRID_W, gy = (k - gx) / GRID_W;
    _simMoveWallVer = (_simMoveWallVer + 1) | 0;
    if (_simMoveWallBlk) { _simMoveWallBlk[(gy >> 3) * _simMoveWallBlkW + (gx >> 3)]++; _simMoveWallBlk9Add(gx >> 3, gy >> 3); }
}
function simMoveTileTypeChanged(gx, gy) {
    // (The path regions follow the grid at once: pathfinding.js.)
    if (typeof pathRegionsTileChanged === 'function') pathRegionsTileChanged(gx, gy);
    if (_unitPassOn) { _simMoveWallQ.push(gx, gy); _simMoveWallQMark(gx, gy); return; }
    if (typeof stepCostsChanged === 'function') stepCostsChanged(gx, gy);
    if (!_simMoveWall || _simMoveWallGrid !== grid || _simMoveWall.length !== GRID_W * GRID_H) { _simMoveWallDirty = true; return; }
    const row = grid[gy], cell = row ? row[gx] : null;
    if (gx >= 0 && gx < GRID_W && cell) {
        const w = cell.type === TYPE_WALL ? 1 : 0, k = gy * GRID_W + gx;
        if (_simMoveWall[k] !== w) {
            const was = _simMoveWall[k];
            _simMoveWall[k] = w; _simMoveWallVer = (_simMoveWallVer + 1) | 0;
            if (_simMoveWallBlk) { _simMoveWallBlk[(gy >> 3) * _simMoveWallBlkW + (gx >> 3)]++; _simMoveWallBlk9Add(gx >> 3, gy >> 3); }
            if (typeof navWallChanged === 'function') navWallChanged(k, was, w);
        }
        // (The walk classes' walls: also when only its tile entity changed.)
        _simMoveClassTileChanged(k);
    }
}
// Per 8x8 block, the sum of its 3x3 blocks' wall change counts (simWallKey's
// value, the kernel's one read: simWallKey9).
let _simMoveWallBlk9 = null;
function _simMoveWallBlk9All() {
    const W = _simMoveWallBlkW, H = (GRID_H + 7) >> 3, B = _simMoveWallBlk;
    if (!_simMoveWallBlk9 || _simMoveWallBlk9.length !== B.length) { _simMoveWallBlk9 = simHeapArrayAuto(Int32Array, B.length); simParallelBind('mv.wallBlk9', _simMoveWallBlk9); }
    for (let by = 0; by < H; by++) for (let bx = 0; bx < W; bx++) _simMoveWallBlk9[by * W + bx] = simWallKey(B, W, H, bx * 8, by * 8, 0);
}
function _simMoveWallBlk9Add(bx, by) {
    const W = _simMoveWallBlkW, H = (GRID_H + 7) >> 3, A = _simMoveWallBlk9;
    if (!A) return;
    for (let y = by - 1; y <= by + 1; y++) for (let x = bx - 1; x <= bx + 1; x++) if (x >= 0 && y >= 0 && x < W && y < H) A[y * W + x] = (A[y * W + x] + 1) | 0;
}
function simMoveWallsDirty() { _simMoveWallDirty = true; if (typeof stepCostsReset === 'function') stepCostsReset(); if (typeof pathRegionsReset === 'function') pathRegionsReset(); }
// The wall table, current (1: grid type TYPE_WALL).
function simMoveWallGrid() { _simMoveWalls(); return _simMoveWall; }
function _simMoveWalls() {
    if (!_simMoveWallDirty && _simMoveWallGrid === grid && _simMoveWall && _simMoveWall.length === GRID_W * GRID_H) return;
    if (!_simMoveWall || _simMoveWall.length !== GRID_W * GRID_H) { const old = _simMoveWall; _simMoveWall = simHeapArray(Uint8Array, GRID_W * GRID_H); simParallelBind('mv.wall', _simMoveWall); simHeapFree(old); }
    for (let y = 0; y < GRID_H; y++) {
        const row = grid[y], o = y * GRID_W;
        for (let x = 0; x < GRID_W; x++) _simMoveWall[o + x] = row && row[x] && row[x].type === TYPE_WALL ? 1 : 0;
    }
    _simMoveWallGrid = grid; _simMoveWallDirty = false; _simMoveWallVer = (_simMoveWallVer + 1) | 0;
    // (Every block's version moves on: the look-aheads cached anywhere are
    // made again.)
    _simMoveWallBlkW = (GRID_W + 7) >> 3;
    const nb = _simMoveWallBlkW * ((GRID_H + 7) >> 3);
    if (!_simMoveWallBlk || _simMoveWallBlk.length !== nb) { _simMoveWallBlk = simSharedArray(Int32Array, nb); simParallelBind('mv.wallBlk', _simMoveWallBlk); }
    for (let i = 0; i < nb; i++) _simMoveWallBlk[i]++;
    _simMoveWallBlk9All();
    if (typeof _navWallDiffReset === 'function') _navWallDiffReset();
    if (typeof navClassReset === 'function') navClassReset();
    if (typeof stepCostsReset === 'function') stepCostsReset();
}

// Structures by tile, for "hostile to player p?" without the tables of
// every player: -1 none, p when owned by p alone (the structure and its
// cell), -2 otherwise (hostile to everyone). Mines count as none. Tiles
// whose tile entity changed are redone at the next kernel run; per block
// and player, the count of structures hostile to that player.
let _simMoveStruct = null, _simMoveStructBlocks = null, _simMoveStructSet = null, _simMoveStructDims = '';
// (And by class, for the acquisition tier's structure look: _simStructClass.)
let _simStructCls = null;
// 0 none (or a mine), 1 turret, 2 trap, 3 barrack or spawner, 4 any other
// building (a cell item), 5 a cloud tower: the order
// _findAutoStructureTarget takes them in (cloud towers with the turrets;
// the drive-by look ranks them with the buildings).
function _simStructClass(gx, gy) {
    const refs = tileEntityRef[gy], e = refs ? refs[gx] : null;
    if (!e) return 0;
    const type = tileEntityType[gy][gx];
    if (type === TILE_ENTITY_GOLDMINE || type === TILE_ENTITY_ASTARMINE) return 0;
    if (e instanceof Tower) return String(e.type || '').startsWith('cloud') ? 5 : 1;
    if (e instanceof Barrack || isSpawnerEntity(e)) return 3;
    const cell = grid[gy] && grid[gy][gx];
    if (cell && cell.item === e) return isTrapItem(e) ? 2 : 4;
    return 0;
}
let _simMoveStructDirty = [];
// Cell owners replaced (a restore): every tile's code again.
function simMoveStructsReset() { _simMoveStructDims = ''; }
function simMoveTileEntityChanged(gx, gy) {
    if (_simMoveStruct) _simMoveStructDirty.push(gy * GRID_W + gx);
    // (The walk classes' walls: a builder's own buildings, active mines; at
    // the unit pass's end when in it, as the walls.)
    if (gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H) { if (_unitPassOn) _simClassQ.push(gy * GRID_W + gx); else _simMoveClassTileChanged(gy * GRID_W + gx); }
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
        if (!_simMoveStruct || _simMoveStruct.length !== GRID_W * GRID_H) { _simMoveStruct = simHeapArrayAuto(Int8Array, GRID_W * GRID_H); simParallelBind('mv.struct', _simMoveStruct); }
        if (!_simStructCls || _simStructCls.length !== GRID_W * GRID_H) { _simStructCls = simHeapArrayAuto(Int8Array, GRID_W * GRID_H); simParallelBind('mv.scls', _simStructCls); }
        _simMoveStruct.fill(-1); _simStructCls.fill(0);
        _simMoveStructBlocks = simHeapArrayAuto(Int32Array, spatialBlockCols * spatialBlockRows * players);
        for (const e of _activeTileEntities) {
            const gx = e.gx, gy = e.gy;
            if (!(gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H)) continue;
            const t = gy * GRID_W + gx;
            if (_simMoveStruct[t] !== -1) continue;
            const code = _simMoveStructCode(gx, gy);
            _simMoveStruct[t] = code; _simStructCls[t] = _simStructClass(gx, gy);
            if (code !== -1) _simMoveStructCount(t, code, 1);
        }
        _simMoveStructSet = _activeTileEntities; _simMoveStructDims = dims; _simMoveStructDirty.length = 0;
        return;
    }
    const dirty = _simMoveStructDirty;
    for (let i = 0; i < dirty.length; i++) {
        const t = dirty[i], gx = t % GRID_W, gy = (t - gx) / GRID_W;
        const old = _simMoveStruct[t], code = _simMoveStructCode(gx, gy);
        _simStructCls[t] = _simStructClass(gx, gy);
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
        simHeapFree(_simMoveHostile);
        _simMoveHostile = simHeapArray(Int32Array, Math.max(1, players * plane));
        simParallelBind('mv.hostile', _simMoveHostile);
    }
    if (!_simMoveHostStruct || _simMoveHostStruct.length < players * plane) {
        simHeapFree(_simMoveHostStruct);
        _simMoveHostStruct = simHeapArray(Int32Array, Math.max(1, players * plane));
        simParallelBind('mv.hstruct', _simMoveHostStruct);
    }
    // (In parallel: the rows, then the columns; see SIM_KERNEL_SAT_ROWS.)
    if (_simPool && typeof SIM_KERNEL_SAT_ROWS === 'number' && spatialBlockCounts.length === bc * br * players && _simMoveStructBlocks.length === bc * br * players) {
        simParallelBind('ix.bcount', spatialBlockCounts); simParallelBind('mv.stblk', _simMoveStructBlocks);
        const P = _simParams, per = 16;
        P[0] = players; P[1] = bc; P[2] = br; P[3] = per;
        simParallelRun(SIM_KERNEL_SAT_ROWS, players * Math.ceil(br / per));
        simParallelRun(SIM_KERNEL_SAT_COLS, players * Math.ceil(bc / per));
        return;
    }
    const H = _simMoveHostile, HS = _simMoveHostStruct, counts = spatialBlockCounts, st = _simMoveStructBlocks;
    for (let p = 0; p < players; p++) {
        const o = p * plane;
        H.fill(0, o, o + stride); HS.fill(0, o, o + stride);
        for (let by = 0; by < br; by++) {
            const row = o + (by + 1) * stride, above = row - stride;
            H[row] = 0; HS[row] = 0;
            let run = 0, runS = 0;
            for (let bx = 0; bx < bc; bx++) {
                const base = (by * bc + bx) * players;
                let v = st[base + p];
                runS += v;
                for (let q = 0; q < players; q++) if (q !== p) v += counts[base + q];
                run += v;
                H[row + bx + 1] = H[above + bx + 1] + run;
                HS[row + bx + 1] = HS[above + bx + 1] + runS;
            }
        }
    }
}
// (The same, structures hostile to the player alone.)
let _simMoveHostStruct = null;

// The area graph for the kernels (area.off, area.nb: each area's
// neighbours, as areaNeighborIds), rebuilt with the area layout.
let _simAreaCsrFor = null;
// The walls as the kernel saw them (holds are checked against them).
let _simMoveRunWallVer = -1;
// (Bumped with every new area layout: long-range holds made under another
// are handed back.)
let _simAreaLayoutVer = 1;
// isWorldTargetWithinAreaRange through the kernels' twin (_simInAreaRange
// on the flat area grid and the CSR area graph): 1 / 0, or -1 where that
// does not work it out (over 2 steps): then the general path.
function simAreaRangeFast(x, y, tx, ty, k) {
    if (!(k >= 0 && k <= 2) || k !== Math.floor(k) || typeof _simInAreaRange !== 'function') return -1;
    _simAreaCsr();
    const R = _simParReg;
    return _simInAreaRange(_spatialAreaGridFlat(), R['area.off'], R['area.nb'], GRID_W, GRID_H, TILE, x, y, tx, ty, k);
}
function _simAreaCsr() {
    if (_simAreaCsrFor === areaNeighborIds) return;
    _simAreaLayoutVer = (_simAreaLayoutVer + 1) | 0;
    const L = Array.isArray(areaNeighborIds) ? areaNeighborIds : [], A = L.length;
    let total = 0;
    for (let a = 0; a < A; a++) total += L[a] ? L[a].length : 0;
    const off = simHeapArrayAuto(Int32Array, A + 1), nb = simHeapArrayAuto(Int32Array, Math.max(1, total));
    let k = 0;
    for (let a = 0; a < A; a++) { off[a] = k; const l = L[a]; if (l) for (let i = 0; i < l.length; i++) nb[k++] = l[i]; }
    off[A] = k;
    simParallelBind('area.off', off); simParallelBind('area.nb', nb);
    _simAreaCsrFor = areaNeighborIds;
}

// Runs the armed units' tick (before the update pass), then charges their
// node steps to their owners and updates the spatial index and visibility
// of those that moved into another tile or window.
let _simMoveSpendTypes = null, _simMovePost = null, _simMovePostC = null;
// The kernel's attacks (unit holds, mvFlags 4): attacker and target slots per
// chunk of SIM_MOVE_CHUNK, how many per chunk; chunks this tick (0: none).
let _simMoveHitA = null, _simMoveHitT = null, _simMoveHitC = null, _simMoveHitChunks = 0;
let SIM_KERNEL_FIRE = true;
function simMoveRun() {
    const S = _simUnitState;
    if (!S || !spatialBlockCols || spatialBlockCounts.length !== spatialBlockCols * spatialBlockRows * spatialUnitsComplexPlayerCount) return;
    const n = S.owners.length;
    if (!n) return;
    const c = S.columns, players = spatialUnitsComplexPlayerCount;
    // (Changed stat tables reach the movement columns as each unit takes them,
    // simMoveStatsChanged; not every unit at once.)
    _simMoveBuildHostile();
    _simMoveWalls();
    _simMoveAreaBoxes();
    // The combat scan first: the kernel keeps aggro units moving when it
    // found no enemy unit for them (see SIM_KERNEL_MOVE).
    combatScanRun();
    // Every armed shooter's box is present (the table is a cache that may
    // have been reset: the kernel's outcome must not depend on it): after a
    // reset; otherwise arming and entering an area make them.
    if (_simMoveAreaBoxesNew) {
        _simMoveAreaBoxesNew = false;
        const ON = c.mvOn, FL = c.mvFlags, AR = c.spArea, RE = c.mvReach, ok = _simMoveAreaBoxOk;
        for (let s = 0; s < n; s++) {
            if (!ON[s] || (FL[s] & 1) === 0) continue;
            const a = AR[s];
            if (a >= 0 && !ok[a * SIM_MOVE_BOX_STEPS + RE[s]]) _simMoveEnsureAreaBox(a, RE[s]);
        }
    }
    const P = _simParams, CH = SIM_MOVE_CHUNK;
    P[0] = n; P[1] = CH; P[2] = gameTime; P[3] = TICK_RATE; P[4] = 0; P[5] = GRID_W; P[6] = GRID_H;
    P[7] = TILE; P[8] = UNIT_POSITION_QUANTIZATION; P[9] = spatialBlockCols; P[10] = spatialBlockRows;
    P[11] = players; P[12] = CMD_MOVING; P[13] = CMD_ATTACK_MOVING; P[14] = SPATIAL_BLOCK_SIZE * CHUNK_SIZE; P[15] = SIM_SEP_ABSENT;
    P[16] = SIM_MOVE_WINDOW; P[17] = SIM_MOVE_BOX_STEPS; P[18] = SIM_FLOW_ARRIVE; P[19] = _simMoveWallVer;
    P[20] = Math.max(0, Number(CROSS_TEAM_UNIT_COLLISION_PADDING) || 0) + UNIT_CONTACT_ATTACK_MARGIN;
    P[21] = WORKER_MOVE_CHECK_TICKS;
    {
        const V = _workerWorkTable(), delay = Math.max(1, Math.floor(Number(WORKER_AI_TICK_DELAY) || 1));
        simParallelBind('wk.ver', V);
        P[22] = V.np; P[23] = _WORKER_WORK_TYPES.length; P[24] = V.rw; P[25] = V.rh; P[26] = WORKER_WORK_REGION_TILES;
        P[27] = delay * Math.ceil(getWorkerIdleSearchTicks() / delay); P[28] = _healerCandidatesGen; P[29] = BUILDER_WATCH_TICKS;
        P[30] = _simMoveWallBlkW; P[31] = (GRID_H + 7) >> 3;
    }
    _simAreaCsr();
    P[32] = _simAreaLayoutVer;
    // (Drive-by looks: the unit index by chunk, and its owners per chunk
    // when this tick's combat scan made them.)
    P[33] = _sxEpoch; P[34] = CHUNKS_W; P[35] = CHUNKS_H; P[36] = CHUNK_SIZE; P[37] = _combatScanTick === gameTime ? 1 : 0;
    P[38] = SIM_ACQUIRE_TICKS; P[39] = _acqCommitTick;
    // (Attack holds: sight by area, the area of each tile.)
    if (typeof _visCoverReady === 'function' && _visCoverReady()) { simParallelBind('vis.cover', _visCover.visible); simParallelBind('vis.coverf', _visCover.visibleFlat); }
    simParallelBind('ix.agrid', _spatialAreaGridFlat());
    if (typeof _flowTables === 'function') _flowTables();
    const chunks = Math.ceil(n / CH);
    if (!_simMovePost || _simMovePost.length < chunks * CH) { _simMovePost = simHeapArrayAuto(Int32Array, simReserveCap(chunks * CH, 8192)); simParallelBind('mv.post', _simMovePost); }
    if (!_simMovePostC || _simMovePostC.length < chunks) { _simMovePostC = simHeapArrayAuto(Int32Array, Math.max(64, chunks * 2)); simParallelBind('mv.postc', _simMovePostC); }
    // (The attacks the kernel made, per chunk: see unitHitsResolve.)
    if (!_simMoveHitA || _simMoveHitA.length < chunks * CH) {
        _simMoveHitA = simHeapArrayAuto(Int32Array, simReserveCap(chunks * CH, 8192)); _simMoveHitT = simHeapArrayAuto(Int32Array, _simMoveHitA.length);
        simParallelBind('mv.hita', _simMoveHitA); simParallelBind('mv.hitt', _simMoveHitT);
    }
    if (!_simMoveHitC || _simMoveHitC.length < chunks) { _simMoveHitC = simHeapArrayAuto(Int32Array, Math.max(64, chunks * 2)); simParallelBind('mv.hitc', _simMoveHitC); }
    _simMoveHitChunks = chunks;
    // (The kernel's epilogue: the index columns of units in other tiles, the
    // node steps' charges per chunk, owner and type.)
    const NPa = _simMoveGamePlayers(), names = _spatialUnitTypeNames(), NT = names.length + 1;
    {
        if (!_simMoveRem || _simMoveRem.length < NPa) { _simMoveRem = simHeapArrayAuto(Float64Array, Math.max(8, NPa * 2)); simParallelBind('mv.astarRem', _simMoveRem); }
        for (let pid = 0; pid < NPa; pid++) _simMoveRem[pid] = _astarAtPassStart ? (_astarAtPassStart[pid] ?? 0) : _getPlayerAstarBudgetRemaining(pid) + _fromFixedResourceUnits(_pendingMovementAstarFixed[pid] || 0);
        if (!_simMoveChFix || _simMoveChFix.length < chunks * NPa) { _simMoveChFix = simHeapArrayAuto(Float64Array, Math.max(64, chunks * NPa * 2)); simParallelBind('mv.chFix', _simMoveChFix); }
        if (!_simMoveChUse || _simMoveChUse.length < chunks * NPa * NT) { _simMoveChUse = simHeapArrayAuto(Float64Array, Math.max(256, chunks * NPa * NT * 2)); simParallelBind('mv.chUse', _simMoveChUse); }
        const V = typeof _visCover !== 'undefined' ? _visCover : null;
        P[40] = spatialEpoch; P[41] = V ? V.gen : 0; P[42] = !V || V.syncedTick < 0 || V.adm !== areaDistanceMatrix ? 1 : 0;
        P[43] = NPa; P[44] = NT; P[45] = RESOURCE_FIXED_POINT_SCALE;
    }
    // (Flow units between steers first, a small kernel of their own; the
    // movement kernel does the rest.)
    const stepK = SIM_MOVE_STEP_KERNEL && typeof SIM_KERNEL_MOVE_STEP === 'number';
    P[46] = stepK ? 1 : 0; P[48] = SIM_COMBAT_BRAIN ? 1 : 0;
    // The fast step and remaining movement share each scheduled chunk.
    simParallelRun(SIM_KERNEL_MOVE, chunks);
    _simMoveRunWallVer = _simMoveWallVer; _simDead0Tick = gameTime;
    _spatialKernelMoves = true;
    _simMoveChargeSteps(chunks, NPa, NT, names);
    // The slots the kernel listed (an arrival, a wall, a budget mark, a unit
    // whose index it did not update, a drive-by shooter in another area),
    // chunk by chunk in slot order: not every slot.
    const OUT = c.mvOut, owners = S.owners, PL = _simMovePost, PC = _simMovePostC;
    let slow = null;
    for (let k = 0; k < chunks; k++) for (let i = k * CH, e = i + PC[k]; i < e; i++) {
        const s = PL[i], o = OUT[s];
        if (o === 0) continue;
        if (c.mvBlk[s]) { c.mvBlk[s] = 0; if (owners[s]) _setUnitAstarBudgetBlockedIndicator(owners[s], 1); }
        if (o === 1 || o === 6 || o === 7 || o === 10 || o === 11 || o === 13 || o === 14 || o === 15) continue;
        // Arrived in the crowd at its destination: the move is done.
        if (o === 5) { const u = owners[s]; if (u && !u.dead) simFlowArrive(u); continue; }
        // Into a wall tile: the end of Unit.update (pushed out; can start
        // path work on the owner's budget): in id order afterwards.
        if (o === 4) { if (owners[s]) (slow ||= []).push(owners[s]); continue; }
        // Another tile: the spatial index, from the columns.
        spatialSlotUpdate(c, s);
        // A drive-by shooter entering another area needs its box.
        if (o === 3 && (c.mvFlags[s] & 1) && c.spArea[s] >= 0) _simMoveEnsureAreaBox(c.spArea[s], c.mvReach[s]);
    }
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
// it: mvBlk): the kernel's sums per chunk and owner into the pending spend,
// per owner and unit type into the usage log.
function _simMoveChargeSteps(chunks, NP, NT, names) {
    const FIX = _simMoveChFix, USE = _simMoveChUse;
    for (let pid = 0; pid < NP; pid++) {
        let fix = 0;
        for (let k = 0; k < chunks; k++) fix += FIX[k * NP + pid];
        if (fix) _pendingMovementAstarFixed[pid] = (_pendingMovementAstarFixed[pid] || 0) + fix;
        for (let ti = 0; ti < NT; ti++) {
            let used = 0;
            for (let k = 0; k < chunks; k++) used += USE[(k * NP + pid) * NT + ti];
            if (used > 0) _recordAstarUsage(pid, used, { unitType: (ti < NT - 1 && names[ti]) || 'norm' }, 'movement');
        }
    }
}
let _simMoveRem = null, _simMoveChFix = null, _simMoveChUse = null;
// (The step kernel before the movement kernel: see SIM_KERNEL_MOVE_STEP.)
let SIM_MOVE_STEP_KERNEL = true;
// Slots per job of the movement kernels: small jobs, so the helpers share
// the work evenly (4096: ~49 jobs at 200k, the last ones' wait ~3 ms a
// tick; 1024: an order's newly armed units, consecutive slots, still made
// a few jobs far longer than the rest; 256 added claim overhead and did not
// end those ticks' spikes).
// (The charges' per-job sums: integers, or the usage log's.)
const SIM_MOVE_CHUNK = 512;
// (simMoveRun's own 'players' is the index's count.)
function _simMoveGamePlayers() { return players.length; }

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

// Idle and attack-moving units look for enemy units (the combat scan) on
// their acquisition ticks only: (tick + id) % SIM_ACQUIRE_TICKS === 0, a
// tier below the tick (5 a second each, staggered); the structure look
// (every 4 ticks) falls on the same ticks.
const SIM_ACQUIRE_TICKS = 4;
function _unitAcquireTick(u) { return ((gameTime + u.id) % SIM_ACQUIRE_TICKS) === 0; }
// The nearest visible enemy unit within `range` of an idle or attack-moving
// unit: this tick's combat scan (the world at the start of the update pass),
// else (another range, a unit the scan did not cover, or a target killed
// since) the query.
// The structure the acquisition tier found for u's look (see
// SIM_KERNEL_ACQ_SCAN), still there, hostile, standing, built (cell items)
// and in sight; else null (until the next commit).
function _acqStructureHit(u, range) {
    const c = u._us;
    if (!c) return null;
    const s = u._si;
    if (c.cbTick[s] !== _acqCommitTick || c.cbRangeS[s] !== range) return null;
    const t = c.cbS[s];
    if (!(t >= 0)) return null;
    const gx = t % GRID_W, gy = (t - gx) / GRID_W, e = getTileEntityRef(gx, gy);
    if (!e || !(e.energy > 0)) return null;
    const cell = grid[gy] && grid[gy][gx], isItem = !!cell && cell.item === e;
    const owner = isItem ? cell.owner : e.owner;
    if (owner === u.owner || (isItem && e.underConstruction)) return null;
    if (!isGameplayTargetVisibleToPlayer(u.owner, gx, gy)) return null;
    return e;
}
// (The acquisition tier's result, no search here: _combatScanHit.)
function _combatScanTarget(u, range) { return _combatScanHit(u, range); }
// The acquisition tier's committed target of u (see _acqTierStep): looked
// for with this range, alive (as at the pass's start) and the same unit;
// else null (nothing until the next commit).
function _combatScanHit(u, range) {
    const c = u._us;
    if (!c) return null;
    const s = u._si;
    // (The combat brain engages combat units: not their objects.)
    if (SIM_COMBAT_BRAIN && !c.isWk[s]) return null;
    if (c.cbTick[s] !== _acqCommitTick || c.cbRangeS[s] !== range) return null;
    const q = c.cbT[s];
    if (q < 0) return null;
    const e = _simUnitState.owners[q];
    return e && (e.id | 0) === c.cbTId[s] && !_unitTickDead(e) ? e : null;
}
// Runs the combat scan for every idle or attack-moving unit before the
// update pass (in parallel; see SIM_KERNEL_COMBAT_SCAN).
let _combatScanTick = -1, _combatScanOwnerMask = null;
function combatScanRun() {
    if (_combatScanTick === gameTime) return;

    const S = _simUnitState;
    if (!S || typeof SIM_KERNEL_COMBAT_SCAN !== 'number') return;
    const n = S.owners.length;
    if (!n || !_visCoverReady() || !_simMoveHostile || !spatialBlockCols) return;
    if (spatialIndexEntries() <= 0) return;
    simParallelBind('vis.cover', _visCover.visible); simParallelBind('vis.coverf', _visCover.visibleFlat);
    simParallelBind('sep.eslot', _sxESlot); simParallelBind('sep.rs', _sxStart); simParallelBind('sep.rc', _sxCount); simParallelBind('sep.rstamp', _sxStamp);
    const P = _simParams;
    P[0] = n; P[1] = 2048; P[2] = gameTime; P[3] = CHUNKS_W; P[4] = CHUNKS_H; P[5] = TILE; P[6] = _sxEpoch;
    P[7] = Math.min(spatialUnitsComplexPlayerCount, _visCover.players); P[8] = CMD_IDLE; P[9] = CMD_ATTACK_MOVING;
    P[10] = SPATIAL_BLOCK_SIZE * CHUNK_SIZE; P[11] = spatialBlockCols; P[12] = spatialBlockRows; P[13] = SIM_SEP_ABSENT; P[14] = CHUNK_SIZE;
    P[15] = GRID_W; P[16] = GRID_H; P[17] = CMD_MOVING; P[18] = CMD_ATTACKING; P[19] = SIM_ACQUIRE_TICKS;
    simParallelBind('ix.agrid', _spatialAreaGridFlat());
    _combatScanTick = gameTime;
    // Owners per tile first (SIM_KERNEL_TILE_OWNERS): the scan passes over
    // tiles holding only its own player's units.
    {
        const nc = CHUNKS_W * CHUNKS_H, ne = spatialIndexEntries();
        if (!_combatScanOwnerMask || _combatScanOwnerMask.length !== nc) { simHeapFree(_combatScanOwnerMask); _combatScanOwnerMask = simHeapArray(Uint8Array, nc); _sxOwnerMaskEpoch = -1; }
        simParallelBind('ix.omask', _combatScanOwnerMask); simParallelBind('sep.ekey', _sxEKey);
        // (Made with the index after the last tick: spatialIndexPrebuild.)
        if (_sxOwnerMaskEpoch !== _sxEpoch) {
            P[0] = ne; P[1] = 8192; P[2] = 0;
            simParallelRun(SIM_KERNEL_TILE_OWNERS, Math.ceil(ne / 8192));
            _sxOwnerMaskEpoch = _sxEpoch;
        }
        P[0] = n; P[1] = 2048; P[2] = gameTime;
    }
    simParallelRun(SIM_KERNEL_COMBAT_SCAN, Math.ceil(n / 2048));
    // The drive-by looks (SIM_KERNEL_DRIVEBY).
    if (!SIM_COMBAT_BRAIN && typeof SIM_KERNEL_DRIVEBY === 'number' && _simStructCls) {
        _simAreaCsr(); simMoveWallGrid();
        P[0] = n; P[1] = 2048; P[2] = gameTime; P[3] = CHUNKS_W; P[4] = CHUNKS_H; P[5] = TILE; P[6] = _sxEpoch;
        P[7] = Math.min(spatialUnitsComplexPlayerCount, _visCover.players); P[8] = CMD_MOVING; P[9] = GRID_W; P[10] = GRID_H;
        P[11] = CHUNK_SIZE; P[12] = SIM_SEP_ABSENT; P[13] = SIM_MOVE_BOX_STEPS;
        P[14] = Math.max(0, Number(CROSS_TEAM_UNIT_COLLISION_PADDING) || 0) + UNIT_CONTACT_ATTACK_MARGIN;
        P[15] = SPATIAL_BLOCK_SIZE * CHUNK_SIZE; P[16] = spatialBlockCols; P[17] = spatialBlockRows; P[18] = 1;
        simParallelRun(SIM_KERNEL_DRIVEBY, Math.ceil(n / 2048));
    }
    _acqTierStep();
}

// The acquisition tier: the search for enemy units (idle and attack-moving
// units, building attackers' looks) is not the tick's: a job on the helpers
// (lane SIM_LANE_T10) every SIM_ACQUIRE_TICKS ticks. At phase 2 the tick
// takes a snapshot of what it reads (SIM_KERNEL_ACQ_SNAP and copies of the
// unit index, the hostile tables and the cover) and posts the scan
// (SIM_KERNEL_ACQ_SCAN); at phase 0 the result is committed into the units'
// columns (SIM_KERNEL_ACQ_COMMIT), stamped with that tick (_acqCommitTick).
// Until the next commit a unit takes it at its acquisition tick
// (_combatScanHit, the movement kernel's _simAcqHit): a target where it was
// up to 2-5 ticks before, alive and the same unit still. Every peer posts
// and commits at the same ticks; a resync drops a pending run on all.
const ACQ_LANE = typeof SIM_LANE_T10 === 'number' ? SIM_LANE_T10 : 2;
// Combat decisions on the helpers (BRAIN_OFF_MAIN_THREAD_PLAN.md, stage 1):
// the brain's instructions drive engaged units in the movement kernel.
let SIM_COMBAT_BRAIN = true, _acqBrain = false;
let _acqCommitTick = -1, _acqStage = 0, _acqStepTick = -1, _acqN = 0;
const _acq = { cap: 0, chunks: 0, entries: 0, A: 0, cover: null, hs: null };
function _acqTierStep() {
    if (_acqStepTick === gameTime) return;
    _acqStepTick = gameTime;
    const ph = gameTime % SIM_ACQUIRE_TICKS;
    if (ph === 0) _acqCommit();
    else if (ph === 2) _acqPost();
}
// Before the unit index (or the owners per chunk, the hostile tables) is
// made again: a posted scan reads them in place, so it is waited for here
// (it was posted a tick before; done by now as a rule).
function acqTierIndexWait() {
    if (_acqStage === 1) simParallelBackgroundWait(ACQ_LANE);
}
// (A resync: every peer's combat instructions dropped on the same tick.)
function combatBrainReset() {
    const S = _simUnitState;
    if (S) S.columns.cmMode.fill(0);
}
function acqTierReset() {
    simParallelBackgroundWait(ACQ_LANE);
    _acqStage = 0; _acqCommitTick = -1; _acqStepTick = -1;
}
function _acqArray(name, Type, n) {
    let a = _simParReg[name];
    // (In the wasm heap: the scan's Rust twin reads them in place.)
    if (!a || a.constructor !== Type || a.length < n) { const old = a; a = simHeapArray(Type, Math.max(1024, n)); simParallelBind(name, a); simHeapFree(old); }
    return a;
}
function _acqPost() {
    const S = _simUnitState;
    simParallelBackgroundWait(ACQ_LANE);
    _acqStage = 0;
    if (!S || !_visCoverReady() || !_simMoveHostile || !_simMoveStruct || !_simStructCls || !spatialBlockCols || spatialIndexEntries() <= 0) return;
    const n = S.owners.length, nc = CHUNKS_W * CHUNKS_H, ne = spatialIndexEntries(), C = _visCover, A = C.areaCount, np = C.players;
    if (!n || !_combatScanOwnerMask) return;
    const cap = simReserveCap(n);
    if (_acq.cap < n) {
        _acqArray('acq.x', Float32Array, cap); _acqArray('acq.y', Float32Array, cap); _acqArray('acq.own', Int8Array, cap); _acqArray('acq.flags', Uint8Array, cap);
        _acqArray('acq.cmd', Uint8Array, cap); _acqArray('acq.rng', Float32Array, cap); _acqArray('acq.id', Int32Array, cap);
        _acqArray('acq.out', Int32Array, cap); _acqArray('acq.tid', Int32Array, cap); _acqArray('acq.sout', Int32Array, cap);
        // (The combat brain's: its inputs and its instructions.)
        _acqArray('acq.cm', Uint8Array, cap); _acqArray('acq.ct', Int32Array, cap); _acqArray('acq.ctid', Int32Array, cap); _acqArray('acq.rk', Uint8Array, cap);
        _acqArray('acq.bm', Uint8Array, cap); _acqArray('acq.bt', Int32Array, cap); _acqArray('acq.btid', Int32Array, cap);
        _acq.cap = cap;
    }
    const P = _simParams;
    P[0] = n; P[1] = 8192; P[2] = SIM_SEP_ABSENT; P[3] = CMD_ATTACKING; P[4] = SIM_COMBAT_BRAIN ? 1 : 0; P[5] = CMD_MOVING;
    simParallelRun(SIM_KERNEL_ACQ_SNAP, Math.ceil(n / 8192));
    // The index, the owners per chunk and the hostile tables as they are:
    // the job reads them in place, done before the next tick's index
    // rebuild rewrites them (acqTierIndexWait; they change nowhere else).
    // The structure tables (queries refresh them mid-tick) and the cover:
    // copies.
    simParallelBind('acq.rs', _sxStart); simParallelBind('acq.rc', _sxCount); simParallelBind('acq.rst', _sxStamp);
    simParallelBind('acq.es', _sxESlot); simParallelBind('acq.om', _combatScanOwnerMask);
    simParallelBind('acq.hs', _simMoveHostile); if (_simMoveHostStruct) simParallelBind('acq.hss', _simMoveHostStruct);
    _acqArray('acq.sown', Int8Array, GRID_W * GRID_H).set(_simMoveStruct.subarray(0, GRID_W * GRID_H));
    _acqArray('acq.scls', Int8Array, GRID_W * GRID_H).set(_simStructCls.subarray(0, GRID_W * GRID_H));
    const cov = _acqArray('acq.cover', Uint8Array, Math.max(1, np * A));
    for (let p = 0; p < np; p++) cov.set(C.visible[p].subarray(0, A), p * A);
    simParallelBind('acq.agrid', _spatialAreaGridFlat());
    // First the owners per chunk transposed (SIM_KERNEL_ACQ_OMT: the Rust
    // scan reads a ring's columns as runs), then the scan. (Each stage's
    // params written whole.)
    _acqArray('acq.omt', Uint8Array, CHUNKS_W * CHUNKS_H);
    // (And the index's entries packed in its order: acq.ex... .)
    const ecap = simReserveCap(ne);
    _acqArray('acq.ex', Float32Array, ecap); _acqArray('acq.ey', Float32Array, ecap);
    _acqArray('acq.eo', Int32Array, ecap); _acqArray('acq.ea', Int32Array, ecap); _acqArray('acq.eid', Int32Array, ecap);
    const T = simParallelStageParams(ACQ_LANE, 0), B = simParallelStageParams(ACQ_LANE, 1);
    T.fill(0); B.fill(0);
    const EPER = 4096, prepJobs = Math.max(Math.ceil(CHUNKS_H / 64), Math.ceil(ne / EPER));
    T[0] = CHUNKS_W; T[1] = CHUNKS_H; T[2] = 64; T[3] = ne; T[4] = EPER; T[5] = TILE; T[6] = GRID_W; T[7] = GRID_H;
    // (Small chunks: a helper takes the tick's own jobs between them.)
    B[0] = n; B[1] = 256; B[3] = CHUNKS_W; B[4] = CHUNKS_H; B[5] = TILE; B[6] = _sxEpoch;
    B[7] = Math.min(spatialUnitsComplexPlayerCount, np); B[8] = CMD_IDLE; B[9] = CMD_ATTACK_MOVING;
    B[10] = SPATIAL_BLOCK_SIZE * CHUNK_SIZE; B[11] = spatialBlockCols; B[12] = spatialBlockRows; B[14] = CHUNK_SIZE;
    // (The units in the index's order: B[22], its entries B[23].)
    B[15] = GRID_W; B[16] = GRID_H; B[18] = CMD_ATTACKING; B[20] = A; B[21] = 1; B[22] = 1; B[23] = ne;
    // Then the combat brain on the scan's results (its own copy of the area
    // graph: the layout may change before the commit).
    const C3 = simParallelStageParams(ACQ_LANE, 2);
    C3.fill(0);
    if (SIM_COMBAT_BRAIN) {
        _simAreaCsr();
        _acqArray('acq.aoff', Int32Array, _simParReg['area.off'].length).set(_simParReg['area.off']);
        _acqArray('acq.anb', Int32Array, _simParReg['area.nb'].length).set(_simParReg['area.nb']);
        C3[0] = n; C3[1] = 2048; C3[2] = CMD_IDLE; C3[3] = CMD_ATTACK_MOVING; C3[4] = TILE; C3[5] = GRID_W; C3[6] = GRID_H; C3[7] = Math.min(spatialUnitsComplexPlayerCount, np); C3[8] = A;
    }
    simParallelBackgroundChain(ACQ_LANE, [[SIM_KERNEL_ACQ_OMT, prepJobs], [SIM_KERNEL_ACQ_SCAN, Math.ceil(ne / 256)], [SIM_KERNEL_COMBAT_BRAIN, SIM_COMBAT_BRAIN ? Math.ceil(n / 2048) : 0]]);
    _acqBrain = SIM_COMBAT_BRAIN;
    _acqStage = 1; _acqN = n;
}
function _acqCommit() {
    if (_acqStage !== 1) return;
    simParallelBackgroundWait(ACQ_LANE);
    _acqStage = 0;
    const S = _simUnitState;
    if (!S) return;
    const n = Math.min(_acqN, S.owners.length), P = _simParams;
    P[0] = n; P[1] = 8192; P[2] = gameTime;
    simParallelRun(SIM_KERNEL_ACQ_COMMIT, Math.ceil(n / 8192));
    if (_acqBrain) { P[0] = n; P[1] = 8192; simParallelRun(SIM_KERNEL_COMBAT_COMMIT, Math.ceil(n / 8192)); }
    _acqCommitTick = gameTime;
}

// After the update pass: no unit counts as moved by the kernel any more
// (a later Unit.update call runs in full).
function simMoveEndTick() {
    const S = _simUnitState;
    if (S) S.columns.mvOut.fill(0, 0, S.owners.length);
}


// How far a unit may have moved within a tick since the unit index was
// built (a unit's step plus a push), for the collision pass's culling.
const UNIT_SEPARATION_INDEX_MARGIN = TILE * 0.5;
// Large worlds (slots) run the separation as a chain on the helpers (lane
// 0, see SIM_KERNEL_SEP_PACK: pack with the chunk aggregates, mark, pairs twice; Rust twins in wasm/src/lib.rs): started at the tick's start from the
// tick-start copy of the units (SIM_KERNEL_STATUS: x0/y0, sepD0/R0/L0) and
// the unit index, while the simulation thread does the unit pass; collected
// and applied after it (runUnitSeparationPass). Movers: units that moved by
// themselves last tick (_sepMoved). Each unit's contacts are looked at
// every other tick (staggered by id), its push spread over two ticks.
// Small worlds separate after the pass from where units are then.
let SEPARATION_SLOT_MIN_UNITS = 0;
// UNIT_SEPARATION_MODE 0: staggered, half the units a tick ((t + id) even:
// each unit every other tick); 1: every unit every tick (pushes at once);
// 2: every unit on even ticks. With 0 and 2 each push is scaled by
// UNIT_SEPARATION_TIER_GAIN (bounded by its deepest overlap) and applied
// half on its tick, half on the next. Staggered keeps crowds and fights as
// still and spaced as every tick (tests/separation-jitter.test.cjs); every
// unit at once (2) makes crowds sway.
let UNIT_SEPARATION_MODE = 0;
let UNIT_SEPARATION_TIER_GAIN = 1.0;
let _sepPending = null, _sepDirty = true;
const SEP_PACK_PER = 1024, SEP_MARK_PER = 2048;
// The chain's arrays for n slots (the sums cleared once when new or after
// the small-world pass wrote them by unit index: the commit clears them as
// it reads them).
function _sepArrays(n) {
    _sepGrow(n);
    const S = _sep, cap = S.cap;
    // (Nothing per chunk: mark and pairs find neighbours through the entries.)
    for (const [name, Type, size] of [['ord', Int32Array, cap], ['qx', Float32Array, cap], ['qy', Float32Array, cap],
        ['qr', Float32Array, cap], ['meta', Int32Array, cap], ['qid', Int32Array, cap], ['px', Float64Array, cap], ['py', Float64Array, cap], ['ov', Float32Array, cap],
        ['hit', Uint32Array, cap], ['nextX', Float32Array, cap], ['nextY', Float32Array, cap], ['fast', Uint8Array, cap], ['ex', Int32Array, cap], ['exc', Int32Array, Math.ceil(cap / 512) + 1]]) _sepShared(S, name, Type, size);
    if (_sepDirty || S.sumsCap !== cap) { S.px.fill(0); S.py.fill(0); S.ov.fill(0); S.hit.fill(0); _sepDirty = false; S.sumsCap = cap; }
}
// Whether separationStart will take the separation prebuilt after the last
// tick (its own test).
function _sepPrebuiltForTick() {
    const U = _simUnitState;
    return !!(U && units.length >= SEPARATION_SLOT_MIN_UNITS && CHUNKS_W * CHUNKS_H < SIM_SEP_ABSENT && _sepPre && _sepPre.taken && _sepPre.tick === gameTime && _sepPre.n <= U.owners.length);
}
function separationStart() {
    _sepPending = null;
    const U = _simUnitState;
    if (!U || units.length < SEPARATION_SLOT_MIN_UNITS || !(CHUNKS_W * CHUNKS_H < SIM_SEP_ABSENT)) return;
    // Made after the last tick with the unit index (spatialIndexPrebuild):
    // taken after this tick's unit pass.
    if (_sepPre && _sepPre.taken && _sepPre.tick === gameTime && _sepPre.n <= U.owners.length) {
        _sepPending = { tick: gameTime, n: _sepPre.n, lane: SIM_LANE_IX };
        _sepPre = null;
        return;
    }
    _sepPre = null;
    const n = U.owners.length;
    _sepArrays(n);
    const S = _sep;
    const ne = spatialIndexEntries(), mode = UNIT_SEPARATION_MODE | 0;
    _sepPending = { tick: gameTime, n, lane: 0 };
    // (Not a separation tick: the commit applies the pushes carried over.)
    if (!ne || (mode === 2 && (gameTime & 1) !== 0)) return;
    simParallelBind('sep.eslot', _sxESlot); simParallelBind('sep.ekey', _sxEKey);
    simParallelBind('sep.rs', _sxStart); simParallelBind('sep.rc', _sxCount); simParallelBind('sep.rstamp', _sxStamp);
    const pad = Math.max(0, Number(CROSS_TEAM_UNIT_COLLISION_PADDING) || 0), maxR = Math.max(0.1, _maxUnitCollisionRadius()), cws = CHUNK_SIZE * TILE;
    // (Bands 2 * reach rows high: a unit's pushes reach that far around it,
    // see SIM_KERNEL_SEP_PAIRS.)
    const farAny = 2 * maxR + pad, reach = Math.max(1, Math.ceil(farAny / cws)), H = Math.max(2, 2 * reach);
    const bands = Math.ceil(CHUNKS_H / H);
    // (Every stage's params written whole: lane 0 is the state hash's too
    // (utils_snapshot.js SNAP_REGION), whose P[5] 1 would make the pack read
    // the live columns the pass is moving.)
    for (let st = 0; st < 5; st++) simParallelStageParams(0, st).fill(0);
    let P = simParallelStageParams(0, 0);
    P[0] = ne; P[1] = SEP_PACK_PER; P[2] = getUnitCollisionRecalcTicks(); P[3] = gameTime; P[4] = mode;
    P = simParallelStageParams(0, 1);
    P[0] = ne; P[1] = SEP_MARK_PER; P[2] = _sxEpoch; P[3] = CHUNKS_W; P[4] = CHUNKS_H; P[5] = gameTime; P[6] = mode;
    for (let parity = 0; parity < 2; parity++) {
        P = simParallelStageParams(0, 2 + parity);
        P[0] = CHUNKS_W; P[1] = CHUNKS_H; P[2] = H; P[3] = pad; P[4] = farAny; P[5] = UNIT_SEPARATION_Q;
        P[6] = UNIT_SEPARATION_SHARE_BOTH; P[7] = UNIT_SEPARATION_SHARE_ONE; P[9] = ne; P[10] = cws; P[11] = _sxEpoch;
        P[12] = UNIT_SEPARATION_SHARE_MOVER; P[13] = UNIT_SEPARATION_SHARE_YIELD; P[14] = parity;
    }
    simParallelBackgroundChain(0, [[SIM_KERNEL_SEP_PACK, Math.ceil(ne / SEP_PACK_PER)], [SIM_KERNEL_SEP_MARK, Math.ceil(ne / SEP_MARK_PER)],
        [SIM_KERNEL_SEP_PAIRS, Math.ceil(bands / 2)], [SIM_KERNEL_SEP_PAIRS, Math.floor(bands / 2)]]);
}
// The next tick's separation as stages of the unit index's prebuild chain
// (chunk.js spatialIndexPrebuild, after a tick's end, from the state the
// next tick starts from: the live columns and the index being built, its
// entry count read by the kernels), or null. tick: the next tick's gameTime.
let _sepPre = null, SEPARATION_PREBUILD = true;
function separationPrebuildStages(n, ep, tick) {
    _sepPre = null;
    const U = _simUnitState;
    if (!SEPARATION_PREBUILD) return null;
    if (!U || n < SEPARATION_SLOT_MIN_UNITS || !(CHUNKS_W * CHUNKS_H < SIM_SEP_ABSENT)) return null;
    const mode = UNIT_SEPARATION_MODE | 0;
    if (mode === 2 && (tick & 1) !== 0) return null;
    const ns = U.owners.length;
    _sepArrays(ns);
    const S = _sep;
    simParallelBind('sep.eslot', _sxESlot); simParallelBind('sep.ekey', _sxEKey);
    simParallelBind('sep.rs', _sxStart); simParallelBind('sep.rc', _sxCount); simParallelBind('sep.rstamp', _sxStamp);
    const pad = Math.max(0, Number(CROSS_TEAM_UNIT_COLLISION_PADDING) || 0), maxR = Math.max(0.1, _maxUnitCollisionRadius()), cws = CHUNK_SIZE * TILE;
    const farAny = 2 * maxR + pad, reach = Math.max(1, Math.ceil(farAny / cws)), H = Math.max(2, 2 * reach), bands = Math.ceil(CHUNKS_H / H);
    // (Job counts for every unit: the kernels stop at the entries listed.)
    const pairs = parity => [CHUNKS_W, CHUNKS_H, H, pad, farAny, UNIT_SEPARATION_Q, UNIT_SEPARATION_SHARE_BOTH, UNIT_SEPARATION_SHARE_ONE, 0, n, cws, ep,
        UNIT_SEPARATION_SHARE_MOVER, UNIT_SEPARATION_SHARE_YIELD, parity, 1];
    _sepPre = { tick, n: ns, ep };
    return [[SIM_KERNEL_SEP_PACK, Math.ceil(n / SEP_PACK_PER), [n, SEP_PACK_PER, getUnitCollisionRecalcTicks(), tick, mode, 1]],
        [SIM_KERNEL_SEP_MARK, Math.ceil(n / SEP_MARK_PER), [n, SEP_MARK_PER, ep, CHUNKS_W, CHUNKS_H, tick, mode, 1]],
        [SIM_KERNEL_SEP_PAIRS, Math.ceil(bands / 2), pairs(0)], [SIM_KERNEL_SEP_PAIRS, Math.floor(bands / 2), pairs(1)]];
}
// The prebuild chain's separation dropped (waited for: its sums are
// stale, cleared before the next use).
function separationPrebuildDrop() { if (_sepPre) { _sepPre = null; _sepDirty = true; } }
// The prebuilt index was taken (its epoch): its separation is this tick's.
function separationPrebuildTaken(ep) {
    if (_sepPre && _sepPre.ep === ep) _sepPre.taken = true;
    else _sepPre = null;
}
// A resync (every peer at the same tick): no push carried over.
function separationReset() {
    const U = _simUnitState;
    if (U) { U.columns.sepCx.fill(0); U.columns.sepCy.fill(0); }
}
function runUnitSeparationPass() {
    // Started at the tick's start (separationStart, or the unit index's
    // prebuild chain): its pushes, then the commit. (Every world: the Rust
    // chain on the unit state slots; no tick without one: a separation
    // that did not start (no index entries) has nothing to push.)
    if (_sepPending && _sepPending.tick === gameTime) {
        const n0 = _sepPending.n, lane = _sepPending.lane | 0;
        _sepPending = null;
        simParallelBackgroundWait(lane);
        _commitUnitSeparationPushes(n0);
    }
}

// The pushes of the slots below n (large worlds): the finish kernel applies
// them (and records who moved by itself) and lists the slots needing the
// simulation thread: a new tile (the unit index), a path retry, or blocked
// ground on the way (the swept object commit, in id order).
function _commitUnitSeparationPushes(n) {
    const U = _simUnitState, S = _sep;
    // (2048 a job: at 400k slots 512 made ~800 jobs, their claims and the
    // idle slots' fast path about even.)
    const P = _simParams, per = 2048, chunks = Math.ceil(n / per);
    P[0] = n; P[1] = per; P[2] = TILE; P[3] = UNIT_POSITION_QUANTIZATION;
    P[4] = UNIT_SEPARATION_CONTACTS; P[5] = UNIT_SEPARATION_Q; P[6] = gameTime; P[7] = UNIT_SEPARATION_PATH_RETRY_TICKS;
    const once = (UNIT_SEPARATION_MODE | 0) === 1;
    P[8] = GRID_W; P[9] = GRID_H; P[10] = once ? 1 : UNIT_SEPARATION_TIER_GAIN; P[11] = once ? 1 : 0.5;
    {
        // (Tile changes indexed in the kernel, as the movement kernel's.)
        const V = typeof _visCover !== 'undefined' ? _visCover : null;
        P[12] = 1; P[13] = spatialEpoch; P[14] = V ? V.gen : 0; P[15] = !V || V.syncedTick < 0 || V.adm !== areaDistanceMatrix ? 1 : 0;
        P[16] = CHUNK_SIZE; P[17] = CHUNKS_W; P[18] = SIM_SEP_ABSENT;
        simParallelBind('ix.agrid', _spatialAreaGridFlat());
        _sepShared(S, 'moves', Int32Array, 1)[0] = 0;
    }
    simMoveWallGrid();
    simParallelRun(SIM_KERNEL_SEPARATION_FINISH, chunks);
    // (Chunk moves: counted now, as at the pass's end.)
    if (S.moves[0]) _spatialKernelMoves = true;
    if (_spatialKernelMoves) spatialCountsDeferEnd();
    let retries = null, slow = null;
    const owners = U.owners, c = U.columns, fast = S.fast, EX = S.ex, EXC = S.exc;
    for (let k = 0; k < chunks; k++) for (let j = k * per, e = j + EXC[k]; j < e; j++) {
        const i = EX[j];
        if (fast[i]) {
            if (((gameTime + c.id[i]) | 0) % UNIT_SEPARATION_PATH_RETRY_TICKS === 0) {
                const u = owners[i];
                if (u && !u.dead && u.pathIsFallbackAstar && u._pendingPathTarget) (retries ||= []).push(u);
            }
            if (c.energy[i] > 0) spatialSlotUpdate(c, i);
            continue;
        }
        const u = owners[i];
        if (!u || u.dead) continue;
        (slow ||= []).push(i);
    }
    if (slow) {
        slow.sort((a, b) => owners[a].id - owners[b].id);
        for (let i of slow) {
            const u = owners[i];
            applyUnitSeparation(u, S.nextX[i], S.nextY[i], Infinity);
            if (u.pathIsFallbackAstar && u._pendingPathTarget && ((gameTime + u.id) % UNIT_SEPARATION_PATH_RETRY_TICKS) === 0) (retries ||= []).push(u);
            pushUnitOutOfBlockedTile(u);
            u.x = _quantizeUnitWorldCoord(u.x);
            u.y = _quantizeUnitWorldCoord(u.y);
            updateUnitSpatial(u);
        }
    }
    if (retries) {
        retries.sort((a, b) => a.id - b.id);
        for (let u of retries) _tryUpgradeAstarFallbackPath(u);
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
    // (Any tile not a wall: canUnitOccupyTile's first answer, read before the
    // unit's cache fields, which miss whenever any tile changed anywhere.)
    const row = gx >= 0 && gx < GRID_W ? grid[gy] : null, cell = row ? row[gx] : null;
    if (cell && cell.type !== TYPE_WALL) return;
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
