"use strict";

function _ensurePathBudgetArrays() {
    let count = Math.max(0, players.length || 0);
    if (pathfindBudgetByPlayer.length !== count) pathfindBudgetByPlayer = new Int32Array(count);
    if (astarNodeBudgetPerTickByPlayer.length !== count) astarNodeBudgetPerTickByPlayer = new Int32Array(count);
    if (astarNodeBudgetRemainingByPlayer.length !== count) astarNodeBudgetRemainingByPlayer = new Int32Array(count);
}

function _resetPathBudgetTrackingPerTick() {
    _ensurePathBudgetArrays();
    pathfindBudget = 0;
    _updateAdaptivePathBudget();
    astarNodeBudgetPerTick = Math.max(0, Math.floor(Number(ASTAR_ITER_BUDGET_PER_PLAYER_TICK) || 0));
    astarNodeBudgetRemaining = astarNodeBudgetPerTick;
    for (let i = 0; i < players.length; i++) {
        pathfindBudgetByPlayer[i] = 0;
        astarNodeBudgetPerTickByPlayer[i] = astarNodeBudgetPerTick;
        astarNodeBudgetRemainingByPlayer[i] = astarNodeBudgetPerTick;
    }
}



function _getPlayerAstarBudgetRemaining(owner) {
    playerResourceBatchFlush();
    let pid = _normalizeOwnerId(owner);
    if (pid < 0 || !players[pid]) return 0;
    return Number(players[pid].astar) || 0;
}



// Each successful spawn can request a rally path once. It has a fresh
// unit ID, so there is no duplicate requester to remember for this tick.
function _noteSpawnPathfindRequest(owner) {
    if (isMultiplayer && gameStarted) return true;
    const pid = _normalizeOwnerId(owner);
    if (pid < 0) {
        if (!(pathfindBudget < MAX_PATHS_PER_TICK)) return false;
        pathfindBudget++;
    } else {
        pathfindBudgetByPlayer[pid] = Math.max(0, Number(pathfindBudgetByPlayer[pid]) || 0) + 1;
    }
    return true;
}



// Movement spends A* on every tile step of every unit. Apply those spends
// once per tick boundary (see gameTick) in the same fixed-point units, so the
// stockpile ends each tick exactly where per-step updates would leave it.
const _pendingMovementAstarFixed = [];


// During the unit pass, whether a step's A* is covered is judged by the
// player's budget at the pass's start, not what is left at that moment:
// steps the movement kernel takes before the pass and steps in Unit.update
// (in the pass's order) are then marked alike, whatever the order.
let _astarAtPassStart = null;
function astarPassStart() {
    const a = [];
    for (let pid = 0; pid < players.length; pid++) a[pid] = _getPlayerAstarBudgetRemaining(pid) + _fromFixedResourceUnits(_pendingMovementAstarFixed[pid] || 0);
    _astarAtPassStart = a;
}
function astarPassEnd() { _astarAtPassStart = null; }

function flushPendingMovementAstarSpend() {
    for (let pid = 0; pid < _pendingMovementAstarFixed.length; pid++) {
        let fixedDelta = _pendingMovementAstarFixed[pid];
        if (!fixedDelta) continue;
        _pendingMovementAstarFixed[pid] = 0;
        let player = _ensurePlayerResourceState(pid);
        if (!player) continue;
        let fixedMap = player._resourceFixedValues;
        let currentFixed = Number.isFinite(fixedMap.astar) ? Math.floor(fixedMap.astar) : _toFixedResourceUnits(Number(player.astar) || 0);
        _setPlayerResourceValue(pid, 'astar', _fromFixedResourceUnits(currentFixed + fixedDelta));
    }
}

function _resolveUnitAstarTileCost(u) {
    if (!u) return 0.01;
    let unitCost = Number(u.preComputed && u.preComputed.astarCost);
    if (Number.isFinite(unitCost) && unitCost > 0) return Math.max(0.01, unitCost);

    let owner = Number.isFinite(u.owner) ? u.owner : localPlayerId;
    let unitType = String(u.unitType || 'norm');
    let level = Math.max(1, Math.floor(Number(u.effectiveLevel || u.unitLevel || 1) || 1));
    let mapCost = Number(getUnitStatForOwner(owner, unitType, level, 'astarCost'));
    if (Number.isFinite(mapCost) && mapCost > 0) return Math.max(0.01, mapCost);

    let baseCost = Number((BASE_UNIT_STATS[unitType] || BASE_UNIT_STATS.norm || {}).astarCost);
    if (Number.isFinite(baseCost) && baseCost > 0) return Math.max(0.01, baseCost);
    return 0.01;
}


function _getUnitAstarSpeedMultiplier(u) {
    return 1;
}

function _setUnitAstarBudgetBlockedIndicator(u, cooldownTicks = null) {
    if (!u) return;
    let cd = Math.max(1, Math.floor(Number(cooldownTicks) || _getAstarBudgetIdleCooldownTicks()));
    u._astarBudgetBlockedUntil = gameTime + _getAstarBlockedGlyphTicks();
    u._astarBudgetRetryTick = gameTime + cd;
}


// Every unit's way is on the flow navigation (flownav.js; flyers on the air
// one), O(1) here: nothing on this thread searches. A unit that cannot get
// where it was sent has not arrived: it keeps its target (a pending one)
// and heads for the closest tile it can reach, which the helpers work out
// (navPathSubstitute); there it waits, asleep (parked) between looks, until a
// new navigation build could change the answer.
function _makeFallbackPathForUnit(u, sx, sy, ex, ey, cmd = CMD_MOVING, src = 'fallback') {
    if (!u) return null;
    let path = navPathReach(u, sx, sy, ex, ey);
    if (path && path.length > 0) {
        u.pathIsFallbackAstar = false;
        u.path = path;
        u.pathIndex = (path.length > 1 && path[0].x === sx && path[0].y === sy) ? 1 : 0;
        u._pendingPathTarget = null;
        u.commandState = cmd;
        return path;
    }
    u.pathIsFallbackAstar = true;
    u.path = null;
    u.pathIndex = 0;
    u._pendingPathTarget = { gx: ex, gy: ey, cmd, src };
    u.commandState = cmd;
    // (The closest tile: asked for now; its retry tick is the answer's.)
    navPathSubstitute(u, sx, sy, u._pendingPathTarget);
    notePendingPathUnit(u);
    return null;
}

// A waiting unit's look again (looks wait for its retry tick): every
// NAV_GOAL_RECHECK_TICKS ticks at its own phase (by id).
const NAV_GOAL_RECHECK_TICKS = 256;
function _navGoalRecheckTick(u) {
    const P = NAV_GOAL_RECHECK_TICKS, ph = (((gameTime + (u.id | 0)) % P) + P) % P;
    return gameTime + P - ph;
}
// A unit with a pending target (_pendingPathTarget pt: { gx, gy, cmd, src },
// and the navigation's state of it: sub, the tick of the helpers' answer;
// at, the closest tile it heads for; ver, the build it waits under), O(1):
// its way when it can get there now (its order then goes on as given);
// else toward the closest tile it can reach (pt kept: not arrived); there,
// or walled in, it waits until a new navigation build. Looks before its
// retry tick (u._astarBudgetRetryTick) do nothing.
const _pendingPathDest = { x: 0, y: 0 };
function _tryUpgradeAstarFallbackPath(u) {
    const pt = u && u._pendingPathTarget;
    if (!pt || u.dead) return;
    if (Number.isFinite(u._astarBudgetRetryTick) && gameTime < u._astarBudgetRetryTick) return;
    // (On its way to the closest tile: looks again when there, or at its look.)
    const currentPath = u.path;
    if (currentPath && u.pathIndex < currentPath.length) { u._astarBudgetRetryTick = _navGoalRecheckTick(u); return; }
    const profile = navProfileOf(u), nav = _nav[profile];
    // Waiting where it got to: only a new build changes the answer.
    if (pt.ver > 0 && nav && pt.ver === nav.seq) { u._astarBudgetRetryTick = _navGoalRecheckTick(u); return; }
    pt.ver = 0;
    const c = u._us, s = u._si;
    const ugx = Math.floor((c ? c.x[s] * 0.125 : u.x) / TILE);
    const ugy = Math.floor((c ? c.y[s] * 0.125 : u.y) / TILE), here = ugy * GRID_W + ugx;
    const dest = findNearestWalkable(pt.gx, pt.gy, ugx, ugy, u, _pendingPathDest);
    const way = navPathReach(u, ugx, ugy, dest.x, dest.y, currentPath);
    if (way && way.length > 0) {
        u.path = way;
        u.pathIndex = 0;
        u.pathIsFallbackAstar = false;
        u.commandState = pt.cmd;
        u._pendingPathTarget = null;
        return;
    }
    const path = navPathSubstitute(u, ugx, ugy, pt);
    if (path === null) return;
    const at = path.length ? path[0].y * GRID_W + path[0].x : -1;
    // Walled in, or as near as it gets (on that tile, or a step from it in
    // a crowd): it waits (its order stays).
    if (at < 0 || at === here || (Math.abs(path[0].x - ugx) <= 1 && Math.abs(path[0].y - ugy) <= 1 && pt.at === at)) {
        pt.ver = nav ? nav.seq : 1;
        pt.at = at;
        u.path = null;
        u.pathIndex = 0;
        u.pathIsFallbackAstar = true;
        u._astarBudgetRetryTick = _navGoalRecheckTick(u);
        return;
    }
    pt.at = at;
    u.path = path;
    u.pathIndex = 0;
    u.pathIsFallbackAstar = true;
    u.commandState = pt.cmd;
    u._astarBudgetRetryTick = _navGoalRecheckTick(u);
}

function _recordAstarUsage(owner, usedNodes, unit = null, sourceTag = null, unitTypeHint = null) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0) return;
    let used = Math.max(0, Number(usedNodes) || 0);
    if (!(used > 0)) return;

    let bucket = _ensureAstarLogPlayer(pid);
    if (!bucket) return;

    let unitType = unitTypeHint || (unit && unit.unitType) || _activePathfindUnitType || 'other';
    if (typeof unitType !== 'string') unitType = String(unitType);
    let source = sourceTag || _activePathfindSource || PATH_SOURCE_UNSPECIFIED;
    if (typeof source !== 'string') source = String(source);
    // Movement records one spend per unit step. Readers only sum by tick,
    // type and source, so every spend of a tick goes into one row per
    // (owner, type, source), found through this tick's index.
    // Key by the log bucket so replacing a match's logs also releases its index.
    // A snapshot can rewind the clock while retaining the HUD's log buckets.
    if (gameTime < _astarUsageIndexTick) _astarUsageIndex = new WeakMap();
    _astarUsageIndexTick = gameTime;
    let byOwner = _astarUsageIndex.get(bucket);
    if (!byOwner) _astarUsageIndex.set(bucket, byOwner = new Map());
    let byType = byOwner.get(unitType);
    if (!byType) byOwner.set(unitType, byType = new Map());
    let row = byType.get(source);
    if (row && row.tick === gameTime) {
        row.used += used;
        row.delta -= used;
        return;
    }
    let unitMetric = _astarMetricKeyForUnitType(unitType);
    let unitId = (unit && Number.isFinite(Number(unit.id)))
        ? Math.floor(Number(unit.id))
        : (Number.isFinite(Number(_activePathfindUnitId)) ? Math.floor(Number(_activePathfindUnitId)) : null);
    let ev = {
        tick: gameTime,
        owner: pid,
        unitType,
        unitMetric,
        unitId,
        source,
        used,
        delta: -used,
    };
    bucket.push(ev);
    byType.set(source, ev);

    _pruneTickLogBucket(bucket, gameTime - Math.max(1, Math.floor(TICK_RATE * ASTAR_USAGE_LOG_MAX_SECONDS)));
}
let _astarUsageIndex = new WeakMap(), _astarUsageIndexTick = -1;



function _newPathfindPerfTick() {
    return {
        tick: gameTime,
        maxPathsPerTick: MAX_PATHS_PER_TICK,
        totalCalls: 0,
        cacheHits: 0,
        totalMs: 0,
        backlog: 0,
        bySource: {
            player_commands: 0,
            spawner_rally: 0,
            worker_ai: 0,
            scout_ai: 0,
            deferred_resolver: 0,
            ai_combat: 0,
            unspecified: 0
        }
    };
}

function _resetPathfindPerfTick() {
    _pathfindPerfTick = _newPathfindPerfTick();
}


function _finalizePathfindPerfTick(backlogCount) {
    if (!_pathfindPerfTick) return;
    _pathfindPerfTick.backlog = Math.max(0, Math.floor(Number(backlogCount) || 0));
    _pathfindPerfTick.maxPathsPerTick = MAX_PATHS_PER_TICK;
    _pathfindPerfHistory.push(_pathfindPerfTick);
    if (_pathfindPerfHistory.length > PATHFIND_PERF_HISTORY_MAX) {
        _pathfindPerfHistory.splice(0, _pathfindPerfHistory.length - PATHFIND_PERF_HISTORY_MAX);
    }
}


// Units waiting for a deferred path, registered where a pending target is
// set, and scheduled by the tick they are next due: the tick after they
// were last looked at, or later while their search budget cools down
// (u._astarBudgetRetryTick). The resolver visits only the units due, so a
// big army waiting its turn costs nothing per tick. The due tick follows
// from the unit's state, so a restored peer rebuilds the same schedule.
// The wheel: a bucket a tick (PENDING_WHEEL of them, by due tick modulo),
// each a list through the units' columns (ppDue, ppNext, ppPrev: a unit in
// one bucket at most), its first slot in _ppHead (heap, -1 none). Nothing
// grows and nothing is made in play.
const PENDING_WHEEL = 1024;
let _ppHead = null, _ppCount = 0, _ppTaken = -1;
const _pendingPathDueScratch = [];
const _pendingPathBuckets = [[], [], [], [], []];
function _ppHeads() {
    if (!_ppHead || (typeof simHeapHas === 'function' && !simHeapHas(_ppHead))) { _ppHead = typeof simSharedArray === 'function' ? simSharedArray(Int32Array, PENDING_WHEEL) : new Int32Array(PENDING_WHEEL); _ppHead.fill(-1); }
    return _ppHead;
}
function _ppLink(c, s, tick) {
    const H = _ppHeads(), b = tick & (PENDING_WHEEL - 1), h = H[b];
    c.ppNext[s] = h; c.ppPrev[s] = -1;
    if (h >= 0) c.ppPrev[h] = s;
    H[b] = s; c.ppDue[s] = tick; _ppCount++;
}
// Slot s out of its bucket (its slot let go, taken, or scheduled again).
function pendingPathUnlink(c, s) {
    const H = _ppHeads(), b = c.ppDue[s] & (PENDING_WHEEL - 1), p = c.ppPrev[s], n = c.ppNext[s];
    if (p >= 0) c.ppNext[p] = n; else if (H[b] === s) H[b] = n;
    if (n >= 0) c.ppPrev[n] = p;
    c.ppDue[s] = -1; _ppCount--;
}
// (After a compaction: the buckets made again from the slots' due ticks.)
function pendingPathRelink() {
    const S = typeof _simUnitState !== 'undefined' ? _simUnitState : null;
    _ppHeads().fill(-1); _ppCount = 0;
    if (!S) return;
    const c = S.columns, owners = S.owners;
    for (let s = 0; s < owners.length; s++) { const t = c.ppDue[s]; if (t >= 0) { c.ppDue[s] = -1; if (owners.at(s)) _ppLink(c, s, t); } }
}
function _pendingPathDueTick(u, afterTick) {
    let retry = u._astarBudgetRetryTick;
    return Number.isFinite(retry) && retry > afterTick + 1 ? retry : afterTick + 1;
}
function schedulePendingPathUnit(u, tick) {
    const c = u._us;
    if (!c) return;
    const s = u._si;
    if (c.ppDue[s] === tick) return;
    if (c.ppDue[s] >= 0) pendingPathUnlink(c, s);
    _ppLink(c, s, tick);
}
function notePendingPathUnit(u) {
    schedulePendingPathUnit(u, _pendingPathDueTick(u, gameTime));
}
function resetPendingPathUnits() {
    _pendingPathDueScratch.length = 0;
    for (const bucket of _pendingPathBuckets) bucket.length = 0;
    const S = typeof _simUnitState !== 'undefined' ? _simUnitState : null;
    if (S) S.columns.ppDue.fill(-1);
    _ppHeads().fill(-1); _ppCount = 0; _ppTaken = gameTime;
    for (let u of units) if (u && !u.dead && u._pendingPathTarget) notePendingPathUnit(u);
}
function pendingPathWaiting() { return _ppCount; }
// The pending units due at `tick` (each once, in id order); those no longer
// waiting are dropped.
function takeDuePendingPathUnits(tick) {
    const due = _pendingPathDueScratch, S = _simUnitState;
    due.length = 0;
    if (!S) return due;
    const c = S.columns, owners = S.owners, H = _ppHeads();
    // (The buckets of the ticks since the last take, each once.)
    const from = _ppTaken < 0 || tick - _ppTaken >= PENDING_WHEEL ? tick - PENDING_WHEEL + 1 : _ppTaken + 1;
    for (let t = from; t <= tick; t++) {
        let s = H[t & (PENDING_WHEEL - 1)];
        while (s >= 0) {
            const next = c.ppNext[s];
            if (c.ppDue[s] <= tick) {
                pendingPathUnlink(c, s);
                const u = owners.at(s);
                if (u && !u.dead && u._pendingPathTarget) due.push(u);
            }
            s = next;
        }
    }
    _ppTaken = tick;
    due.sort(_pendingPathIdOrder);
    return due;
}
function _pendingPathIdOrder(a, b) { return a.id - b.id; }
function _countPendingPathBacklog() {
    return _ppCount;
}

function _pendingPathPriority(src) {
    if (src === 'player_commands') return 0;
    if (src === 'ai_combat') return 1;
    if (src === 'worker_ai') return 2;
    if (src === 'scout_ai') return 3;
    return 4;
}

function _updateAdaptivePathBudget() {
    // Lockstep determinism: never derive gameplay pathfinding budget from local FPS/load.
    // Different machine performance can otherwise change worker path assignment timing.
    if (isMultiplayer && gameStarted) {
        MAX_PATHS_PER_TICK = Math.max(MIN_PATHS_PER_TICK, Math.min(MAX_PATHS_PER_TICK_HARD, 30));
        return;
    }

    let fps = Number(_fpsDisplay);
    let tickLoad = Number(_tickAccumulator) / Math.max(1, Number(TICK_MS));
    if (!Number.isFinite(fps)) fps = 60;
    if (!Number.isFinite(tickLoad)) tickLoad = 0;

    let fpsScale = 1;
    if (fps < 44) fpsScale = 0.72;
    else if (fps < 52) fpsScale = 0.9;
    else if (fps > 72) fpsScale = 1.2;

    let loadScale = 1;
    if (tickLoad > 1.4) loadScale = 0.7;
    else if (tickLoad > 1.05) loadScale = 0.82;
    else if (tickLoad < 0.55) loadScale = 1.1;

    let nextCap = Math.round(30 * fpsScale * loadScale);
    MAX_PATHS_PER_TICK = Math.max(MIN_PATHS_PER_TICK, Math.min(MAX_PATHS_PER_TICK_HARD, nextCap));
}

function getPathfindingPerfSnapshot() {
    return {
        latest: _pathfindPerfHistory.length > 0 ? _pathfindPerfHistory[_pathfindPerfHistory.length - 1] : null,
        history: _pathfindPerfHistory.slice()
    };
}




window.getPathfindingPerfSnapshot = getPathfindingPerfSnapshot;

// Where combat units may stand changes with the path topology and when a
// building finishes (an unfinished one can be walked through): cached
// "this tile is fine" answers carry this version.
let tileOccupancyVersion = 1;
function bumpTileOccupancyVersion() { tileOccupancyVersion++; }

// canUnitOccupyTile for a unit's tile, remembered per unit (combat units:
// a worker's passability also depends on its task) until the tile or the
// occupancy version changes. `slot` 0: the unit's own tile, 1: its path node.
function canUnitOccupyTileCached(unit, gx, gy, slot) {
    let key = gy * GRID_W + gx;
    if (slot === 0 ? (unit._okTile === key && unit._okVer === tileOccupancyVersion)
        : (unit._okNodeTile === key && unit._okNodeVer === tileOccupancyVersion)) return true;
    let ok = canUnitOccupyTile(unit, gx, gy);
    if (ok && !unit.workerType) {
        if (slot === 0) { unit._okTile = key; unit._okVer = tileOccupancyVersion; }
        else { unit._okNodeTile = key; unit._okNodeVer = tileOccupancyVersion; }
    }
    return ok;
}

function _bumpPathTopologyVersion() {
    tileOccupancyVersion++;
    pathTopologyVersion++;
    if (pathTopologyVersion > 1000000000) pathTopologyVersion = 1;
    if (sharedPathCache.size > 0) sharedPathCache.clear();
    if (sharedPartialPathCache.size > 0) sharedPartialPathCache.clear();
    if (sharedSpawnerRallyTemplateCache.size > 0) sharedSpawnerRallyTemplateCache.clear();
}

function _isPathCacheExpired(entry, ttlTicks) {
    if (!entry) return true;
    if (entry.version !== pathTopologyVersion) return true;
    return (gameTime - entry.tick) > ttlTicks;
}








function _trimPathCacheIfNeeded(cacheMap, maxEntries) {
    if (cacheMap.size <= maxEntries) return;
    if (cacheMap.size <= (maxEntries + PATH_CACHE_TRIM_CHUNK)) return;
    let removeCount = Math.max(PATH_CACHE_TRIM_CHUNK, cacheMap.size - maxEntries);
    for (let k of cacheMap.keys()) {
        cacheMap.delete(k);
        removeCount--;
        if (removeCount <= 0) break;
    }
}

function _resolveMovementProfile(ignoreWalls, canWalk, cacheProfileHint = null) {
    if (cacheProfileHint) return cacheProfileHint;
    if (ignoreWalls) return 'ignore_walls';
    if (!canWalk) return 'ground';
    if (canWalk === _collectorCanWalk) return 'collector';
    if (canWalk && canWalk._pathProfileKey) return canWalk._pathProfileKey;
    return null;
}





// Cloud tower tile cache G�� keyed by (gy*GRID_W+gx), invalidated by pathTopologyVersion
let _cloudTileCache = null;
let _cloudTileCacheVer = -1;
let _cloudPairIndexCache = null;

function _makeCloudPairKey(pairId, owner) {
    return String(pairId) + '|' + String(owner);
}

// The cloud towers (a set kept by their joins and leaves: cloudTowerToggle),
// and the tables made from them in tile order (the same on every peer
// whatever the history): by tile, by (pair id, owner), the tiles for the
// portal signature kernel. A whole walk of the towers only when the list is
// another (a restore, a new match).
const _cloudSet = new Set();
function cloudTowerToggle(t) {
    if (_cloudTileCacheList !== towers) return;
    // (A member while it holds its tile: the list is the table's view.)
    if (t._stT >= 0 && !t.dead) _cloudSet.add(t); else _cloudSet.delete(t);
    _cloudTablesMake();
}
// Whether owner has a live cloud tower of this type (the cloud set, not a
// walk of every tower).
function cloudTowerOwned(owner, type) {
    if (!_cloudTablesCurrent()) _rebuildCloudTileCache();
    // (Each by the tile table: a tower gone without its leave counted on one peer only.)
    for (const t of _cloudSet) if (t._stT >= 0 && !t.dead && getTileEntityRef(t.gx, t.gy) === t && t.owner === owner && t.type === type && t.energy > 0) return true;
    return false;
}
// A restore: the cloud tables made again from the towers as restored (the set held
// the objects of before, the live towers missing: a placement check differed).
function cloudTowersReset() { _cloudTileCacheList = null; _cloudTileCacheVer = -1; _cloudSet.clear(); }
function _rebuildCloudTileCache() {
    _cloudSet.clear();
    for (let t of towers) if (t.baseStats && t.baseStats.isCloud) _cloudSet.add(t);
    _cloudTablesMake();
}
function _cloudTablesMake() {
    const list = [..._cloudSet].sort((a, b) => (a.gy * GRID_W + a.gx) - (b.gy * GRID_W + b.gx));
    let m = new Map();
    let pairIndex = new Map();
    for (const t of list) {
        m.set(t.gy * GRID_W + t.gx, t);
        let pairId = t.baseStats.pairId;
        if (pairId !== undefined && pairId !== null) {
            let key = _makeCloudPairKey(pairId, t.owner);
            let l = pairIndex.get(key);
            if (!l) pairIndex.set(key, l = []);
            l.push(t);
        }
    }
    _cloudTileCache = m;
    _cloudPairIndexCache = pairIndex;
    const CL = _cloudTileList && _cloudTileList.length >= m.size && simHeapHas(_cloudTileList) ? _cloudTileList : (_cloudTileList = simSharedArray(Int32Array, Math.max(64, m.size * 2)));
    let ci = 0;
    for (const key of m.keys()) CL[ci++] = key;
    _cloudTileN = ci;
    _cloudTileCacheVer = _cloudTowersVersion(); _cloudTileCacheList = towers;
}
// Whether the cloud tables are those of the towers list as it is: they hold
// only which towers are clouds and where (energy and construction are read
// live), so the clouds among the list's members decide (cloudTowersVersion;
// a restore makes a new list). (They were rebuilt at every path topology
// change: a mine depleted or a building placed or lost anywhere walked all
// the towers, ~20k, at the next lookup, several times a tick in a battle.)
let _cloudTileCacheList = null, _cloudTileList = null, _cloudTileN = 0;
function _cloudTowersVersion() { return typeof cloudTowersVersion === 'number' ? cloudTowersVersion : 0; }
function _cloudTablesCurrent() { return _cloudTileCacheVer === _cloudTowersVersion() && _cloudTileCacheList === towers; }

// Fast O(1) cloud-tower lookup with live energy/construction check
function _getCloudTowerFast(gx, gy, owner) {
    if (!_cloudTablesCurrent()) _rebuildCloudTileCache();
    let t = _cloudTileCache.get(gy * GRID_W + gx);
    if (!t) return null;
    if (!(t.energy > 0 && !t.underConstruction)) return null;
    if (owner !== null && t.owner !== owner) return null;
    return t;
}








function getCloudTowerAt(gx, gy, owner = null) {
    return _getCloudTowerFast(gx, gy, owner);
}



function canUnitOccupyTile(unit, gx, gy) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
    if (unit && unit.isFlying) return true;
    if (grid[gy][gx].type !== TYPE_WALL) return true;

    // Allow units to walk through tiles where the building is still under construction (L0)
    let tileEntity = getTileEntityRef(gx, gy);
    if (tileEntity && tileEntity.underConstruction) return true;

    if (!!getCloudTowerAt(gx, gy, unit ? unit.owner : null)) return true;
    if (!unit) return false;

    // Collector variants can stand on both active mine types.
    if (isResourceCollectorWorkerType(unit.workerType)) {
        for (let cfg of RESOURCE_TYPE_LIST) {
            if (hasActiveResourceMineAt(cfg.key, gx, gy)) return true;
        }
    }

    // Builders and salvagers walk over their owner's buildings (their work
    // is at those, in the middle of a base too: flownav.js navProfileOf).
    if (unit.workerType === 'builder' || unit.workerType === 'salvager') {
        if (_canBuilderPassTile(unit.owner, gx, gy)) return true;
    }

    return false;
}

function isWalkableTileFor(unit, gx, gy) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
    if (unit) return canUnitOccupyTile(unit, gx, gy);
    return grid[gy][gx].type !== TYPE_WALL;
}




let _airWall = null, _cloudSig = 0, _cloudSigVer = -1, _cloudSigTables = null;
function _airWallTable() {
    if (!_airWall || _airWall.length !== GRID_W * GRID_H) {
        _airWall = simHeapArrayAuto(Uint8Array, GRID_W * GRID_H);
        if (typeof simParallelBind === 'function') simParallelBind('mv.airwall', _airWall);
    }
    return _airWall;
}





// The live route for a destination (created on first use).
// ---- Flows ----
// A route is also a flow field: every settled tile's distance to the
// destination (g), so units of a group order follow it tile by tile in the
// movement kernel with no path of their own (see SIM_KERNEL_MOVE). Routes
// live in FLOW_MAX slots (arrays in shared memory, by slot id for the
// kernels); a slot's generation changes when its route is dropped, and the
// units following it go back to Unit.update. Routes survive topology
// changes: a new request after one gets a fresh route (the old one stays
// for the units already on it until its slot is needed; they check walls
// as they go).

// A unit's destination tile as the interface shows it ({x, y} or null): its
// path's end, or its flow's destination. O(1): for markers drawn per frame.
function unitDisplayDest(u) {
    if (u && u._orderDestination !== undefined) {
        const tile = Math.abs(u._orderDestination) - 1;
        return tile >= 0 ? { x: tile % GRID_W, y: Math.floor(tile / GRID_W) } : null;
    }
    let p = u && u.path;
    if (p && p.length) return p[p.length - 1];
    if (u && u._routeKey && u._routeEnd >= 0) return { x: u._routeEnd % GRID_W, y: (u._routeEnd / GRID_W) | 0 };
    return null;
}

// Compact presentation of the current order for every unit, including units
// outside the watched-detail budget. Zero means no destination; negative is
// attack-move. A queued group order supersedes its previous route immediately.
function getUnitOrderDestinationCode(u) {
    const queued = typeof orderQueuedOf === 'function' ? orderQueuedOf(u) : null;
    let x, y, cmd = u.commandState;
    if (queued) {
        x = Math.max(0, Math.min(GRID_W - 1, Math.floor(queued.targetX / TILE)));
        y = Math.max(0, Math.min(GRID_H - 1, Math.floor(queued.targetY / TILE)));
        cmd = queued.cmd;
    } else {
        if (cmd < CMD_MOVING || cmd > CMD_ATTACK_MOVING) return 0;
        const pending = u._pendingPathTarget;
        const dest = pending ? { x: pending.gx, y: pending.gy } : unitDisplayDest(u);
        if (!dest) return 0;
        x = dest.x; y = dest.y;
        // (A scout exploring by itself has no order: no marker for it.)
        const st = u.unitType === 'scout' ? u._scoutTarget : null;
        if (!pending && st && Math.floor(x) === st.gx && Math.floor(y) === st.gy) return 0;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    const code = Math.floor(y) * GRID_W + Math.floor(x) + 1;
    return cmd === CMD_ATTACK_MOVING ? -code : code;
}

// A unit's path as the interface shows it: its own, or for a unit following
// a flow in the movement kernel (no path of its own) the flow walked from
// where it stands (up to UNIT_DISPLAY_PATH nodes and the destination),
// cached for the tick. Never simulation input.
const UNIT_DISPLAY_PATH = 64;
const _displayPaths = new WeakMap();
function unitDisplayPath(u) {
    let p = u && u.path;
    if (p && p.length) return p;
    if (!u || !u._routeKey || !u._us) return p;
    if (u._routeKey === NAV_ROUTE_KEY) {
        let c = _displayPaths.get(u);
        if (c && c.tick === gameTime) return c.path;
        let path = navPath(navProfileOf(u), Math.floor(u.x / TILE), Math.floor(u.y / TILE), u._routeEnd, UNIT_DISPLAY_PATH) || [];
        let end = u._routeEnd;
        path.push({ x: end % GRID_W, y: (end / GRID_W) | 0 });
        _displayPaths.set(u, { tick: gameTime, path });
        return path;
    }
    return p;
}





