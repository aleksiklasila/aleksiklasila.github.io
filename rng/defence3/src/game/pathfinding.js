"use strict";

let pathfindAllowedUnitIdSetsByPlayer = [];
let pathfindConsumedUnitIdSetsByPlayer = [];

function _ensurePathfindRequesterBudgetArrays() {
    let count = Math.max(0, players.length || 0);
    while (pathfindConsumedUnitIdSetsByPlayer.length < count) pathfindConsumedUnitIdSetsByPlayer.push(new Set());
    if (pathfindConsumedUnitIdSetsByPlayer.length > count) pathfindConsumedUnitIdSetsByPlayer.length = count;
}

function _rebuildDeterministicPathfindRequestSlotsPerTick() {
    _ensurePathfindRequesterBudgetArrays();
    let count = Math.max(0, players.length || 0);
    for (let pid = 0; pid < count; pid++) {
        pathfindConsumedUnitIdSetsByPlayer[pid].clear();
    }
}

function _getRequesterUnitId(requester) {
    if (!requester) return null;
    let unitId = Math.floor(Number(requester.id));
    return Number.isFinite(unitId) ? unitId : null;
}

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
    _rebuildDeterministicPathfindRequestSlotsPerTick();
    astarNodeBudgetPerTick = Math.max(0, Math.floor(Number(ASTAR_ITER_BUDGET_PER_PLAYER_TICK) || 0));
    astarNodeBudgetRemaining = astarNodeBudgetPerTick;
    for (let i = 0; i < players.length; i++) {
        pathfindBudgetByPlayer[i] = 0;
        astarNodeBudgetPerTickByPlayer[i] = astarNodeBudgetPerTick;
        astarNodeBudgetRemainingByPlayer[i] = astarNodeBudgetPerTick;
    }
}

function _setPlayerAstarBudget(owner, value) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0 || !players[pid]) return;
    _setPlayerResourceValue(pid, 'astar', Number(value) || 0);
}

function _getPlayerAstarBudgetAvailable(owner) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0 || !players[pid]) return 0;
    return Number(players[pid].astar) || 0;
}

function _getPlayerAstarBudgetRemaining(owner) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0 || !players[pid]) return 0;
    return Number(players[pid].astar) || 0;
}

function _getPlayerAstarBudgetUsed(owner) {
    return 0;
}

function _getPlayerAstarIterationBudgetRemaining(owner) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0) return astarNodeBudgetRemaining;
    return Math.max(0, Number(astarNodeBudgetRemainingByPlayer[pid]) || 0);
}

function _canUsePathfindRequestBudget(owner, requester = null) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0) {
        if (isMultiplayer && gameStarted) return true;
        return pathfindBudget < MAX_PATHS_PER_TICK;
    }
    let requesterId = _getRequesterUnitId(requester);
    if (!Number.isFinite(requesterId)) {
        if (isMultiplayer && gameStarted) return true;
        return pathfindBudgetByPlayer[pid] < MAX_PATHS_PER_TICK;
    }

    _ensurePathfindRequesterBudgetArrays();
    let consumed = pathfindConsumedUnitIdSetsByPlayer[pid];
    if (consumed && consumed.has(requesterId)) return false;
    return true;
}

function _consumePathfindRequestBudget(owner, requester = null) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0) {
        if (!(isMultiplayer && gameStarted)) pathfindBudget++;
        return;
    }
    let requesterId = _getRequesterUnitId(requester);
    if (Number.isFinite(requesterId)) {
        _ensurePathfindRequesterBudgetArrays();
        let consumed = pathfindConsumedUnitIdSetsByPlayer[pid];
        if (consumed && consumed.has(requesterId)) return;
        if (consumed) consumed.add(requesterId);
    }
    if (!(isMultiplayer && gameStarted)) {
        pathfindBudgetByPlayer[pid] = Math.max(0, Number(pathfindBudgetByPlayer[pid]) || 0) + 1;
    }
}

function _consumeAstarNodeBudget(owner, count = 1, unit = null, sourceTag = null) {
    let amount = Math.max(0, Math.floor(Number(count) || 0));
    if (amount <= 0) return;
    let pid = _normalizeOwnerId(owner);
    if (pid < 0) {
        astarNodeBudgetRemaining = Math.max(0, astarNodeBudgetRemaining - amount);
        return;
    }
    astarNodeBudgetRemainingByPlayer[pid] = Math.max(0, astarNodeBudgetRemainingByPlayer[pid] - amount);
}

function _tryConsumeAstarNodeBudget(owner, count = 1) {
    // Hot path (one node, valid player index), called per search expansion.
    if (count === 1 && (owner | 0) === owner && owner >= 0 && owner < astarNodeBudgetRemainingByPlayer.length && owner < players.length) {
        if (astarNodeBudgetRemainingByPlayer[owner] < 1) return false;
        astarNodeBudgetRemainingByPlayer[owner]--;
        return true;
    }
    let amount = Math.max(0, Math.floor(Number(count) || 0));
    if (amount <= 0) return true;
    if (_getPlayerAstarIterationBudgetRemaining(owner) < amount) return false;
    _consumeAstarNodeBudget(owner, amount);
    return true;
}

// Movement spends A* on every tile step of every unit. Apply those spends
// once per tick boundary (see gameTick) in the same fixed-point units, so the
// stockpile ends each tick exactly where per-step updates would leave it.
const _pendingMovementAstarFixed = [];

function _consumePlayerAstarStockpile(owner, amount, unit = null, sourceTag = null) {
    let delta = Math.max(0, Number(amount) || 0);
    if (!(delta > 0)) return;
    let pid = _normalizeOwnerId(owner);
    if (pid < 0 || !players[pid]) return;
    if (sourceTag === 'movement' && typeof gameStarted !== 'undefined' && gameStarted) {
        _pendingMovementAstarFixed[pid] = (_pendingMovementAstarFixed[pid] || 0) + _toFixedResourceUnits(-delta);
    } else {
        addPlayerResource(pid, 'astar', -delta);
    }
    _recordAstarUsage(pid, delta, unit, sourceTag);
}

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

function _tryConsumeAstarMoveCost(u, tiles = 1) {
    if (!u) return false;
    let tileCount = Math.max(0, Number(tiles) || 0);
    let amount = tileCount * _resolveUnitAstarTileCost(u);
    if (amount <= 0) return true;
    let pid = _normalizeOwnerId(u.owner);
    if (pid < 0) return true;
    // Include this tick's not yet applied movement spend. (In the unit pass:
    // the budget at its start, see astarPassStart.)
    let remaining = _astarAtPassStart ? (_astarAtPassStart[pid] ?? 0)
        : _getPlayerAstarBudgetRemaining(u.owner) + _fromFixedResourceUnits(_pendingMovementAstarFixed[pid] || 0);
    if (remaining < amount) {
        _setUnitAstarBudgetBlockedIndicator(u, 1);
    }
    _consumePlayerAstarStockpile(u.owner, amount, u, 'movement');
    return true;
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

function _markUnitAstarBudgetBlocked(u, cooldownTicks = null) {
    if (!u) return;
    _setUnitAstarBudgetBlockedIndicator(u, cooldownTicks);
}

function _makeFallbackPathForUnit(u, sx, sy, ex, ey, cmd = CMD_MOVING, src = 'fallback') {
    if (!u) return null;
    if (u.isFlying) {
        let path = _buildDeterministicOpenGridPath(sx, sy, ex, ey);
        u.pathIsFallbackAstar = false;
        u.path = path;
        u.pathIndex = (path && path.length > 1 && path[0].x === sx && path[0].y === sy) ? 1 : 0;
        u._pendingPathTarget = null;
        u.commandState = cmd;
        return path;
    }
    // Walkers: the way on the flow navigation at once (no search to wait for).
    if (typeof navPathTo === 'function') {
        let navPath = navPathTo(u, ex, ey);
        if (navPath && navPath.length > 0) {
            u.pathIsFallbackAstar = false;
            u.path = navPath;
            u.pathIndex = (navPath.length > 1 && navPath[0].x === sx && navPath[0].y === sy) ? 1 : 0;
            u._pendingPathTarget = null;
            u.commandState = cmd;
            return navPath;
        }
    }
    u.pathIsFallbackAstar = true;
    u.path = null;
    u.pathIndex = 0;
    u._pendingPathTarget = { gx: ex, gy: ey, cmd, src };
    notePendingPathUnit(u);
    u.commandState = cmd;
    _setUnitAstarBudgetBlockedIndicator(u, 1);
    return null;
}

function _tryUpgradeAstarFallbackPath(u) {
    if (!u || !u.pathIsFallbackAstar || !u._pendingPathTarget || u.dead) return;
    // Waiting for its group's shared search (see _takeGroupPathSearch).
    if (u._awaitGroupPath > gameTime) return;
    let pt = u._pendingPathTarget;
    let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
    let dest = findNearestWalkable(pt.gx, pt.gy, ugx, ugy, u);
    // Walkers: the way on the flow navigation (no search, no budget).
    if (typeof navPathTo === 'function') {
        let navPath = navPathTo(u, dest.x, dest.y);
        if (navPath && navPath.length > 0) {
            u.path = navPath;
            u.pathIndex = (navPath.length > 1 && navPath[0].x === ugx && navPath[0].y === ugy) ? 1 : 0;
            u.pathIsFallbackAstar = false;
            u.commandState = pt.cmd;
            u._pendingPathTarget = null;
            return;
        }
    }
    if (Number.isFinite(u._astarBudgetRetryTick) && gameTime < u._astarBudgetRetryTick) return;
    if (!_canUsePathfindRequestBudget(u.owner, u)) return;
    _consumePathfindRequestBudget(u.owner, u);
    let path = _findPathForUnitTagged(pt.src || 'deferred_resolver', u, ugx, ugy, dest.x, dest.y, !!u.isFlying, getPathCanWalkForUnit(u), u.owner);
    if (path && path.length > 0) {
        u.path = path;
        u.pathIndex = (path.length > 1 && path[0].x === ugx && path[0].y === ugy) ? 1 : 0;
        u.pathIsFallbackAstar = false;
        u.commandState = pt.cmd;
        u._pendingPathTarget = null;
        return;
    }
    if (_lastPathfindAbortedByBudget) _setUnitAstarBudgetBlockedIndicator(u);
}

function _recordAstarUsage(owner, usedNodes, unit = null, sourceTag = null) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0) return;
    let used = Math.max(0, Number(usedNodes) || 0);
    if (!(used > 0)) return;

    let bucket = _ensureAstarLogPlayer(pid);
    if (!bucket) return;

    let unitType = (unit && unit.unitType) || _activePathfindUnitType || 'other';
    if (typeof unitType !== 'string') unitType = String(unitType);
    let source = sourceTag || _activePathfindSource || PATH_SOURCE_UNSPECIFIED;
    if (typeof source !== 'string') source = String(source);
    // Movement records one spend per unit step. Readers only sum by tick,
    // type and source, so every spend of a tick goes into one row per
    // (owner, type, source), found through this tick's index.
    if (_astarUsageIndexTick !== gameTime) { _astarUsageIndex = new Map(); _astarUsageIndexTick = gameTime; }
    // owner -> unit type -> source (nested maps: no key strings per step).
    let byOwner = _astarUsageIndex.get(pid);
    if (!byOwner) _astarUsageIndex.set(pid, byOwner = new Map());
    let byType = byOwner.get(unitType);
    if (!byType) byOwner.set(unitType, byType = new Map());
    let row = byType.get(source);
    if (row && row.bucket === bucket) {
        row.ev.used += used;
        row.ev.delta -= used;
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
    byType.set(source, { bucket, ev });

    _pruneTickLogBucket(bucket, gameTime - Math.max(1, Math.floor(TICK_RATE * ASTAR_USAGE_LOG_MAX_SECONDS)));
}
let _astarUsageIndex = new Map(), _astarUsageIndexTick = -1;

function _withPathfindContext(source, owner, unit, fn) {
    let prevSource = _activePathfindSource;
    let prevOwner = _activePathfindOwner;
    let prevUnitId = _activePathfindUnitId;
    let prevUnitType = _activePathfindUnitType;
    _activePathfindSource = source || PATH_SOURCE_UNSPECIFIED;
    _activePathfindOwner = _normalizeOwnerId(owner);
    _activePathfindUnitId = unit && Number.isFinite(unit.id) ? unit.id : null;
    _activePathfindUnitType = unit && unit.unitType ? String(unit.unitType) : '';
    try {
        return fn();
    } finally {
        _activePathfindSource = prevSource;
        _activePathfindOwner = prevOwner;
        _activePathfindUnitId = prevUnitId;
        _activePathfindUnitType = prevUnitType;
    }
}

function _findPathForUnitTagged(sourceTag, unit, sx, sy, ex, ey, ignoreWalls = false, canWalk = null, pathOwner = null, cacheProfileHint = null, allowClosestReachableFallback = true) {
    // Walkers to an open tile: the way on the flow navigation, no search
    // (the search remains for what it cannot answer: a walled-off tile, a
    // way only through tiles this unit alone may enter).
    if (unit && typeof navPathTo === 'function') {
        let path = navPathTo(unit, ex, ey);
        if (path) return path;
    }
    let owner = _normalizeOwnerId(pathOwner);
    return _withPathfindContext(sourceTag, owner, unit, () => findPathAStar(sx, sy, ex, ey, ignoreWalls, canWalk, pathOwner, cacheProfileHint, allowClosestReachableFallback));
}

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

function _recordPathfindCall(source, elapsedMs, cacheHit) {
    if (!_pathfindPerfTick) _resetPathfindPerfTick();
    let src = (source && _pathfindPerfTick.bySource[source] !== undefined) ? source : PATH_SOURCE_UNSPECIFIED;
    _pathfindPerfTick.totalCalls++;
    _pathfindPerfTick.bySource[src]++;
    if (cacheHit) _pathfindPerfTick.cacheHits++;
    _pathfindPerfTick.totalMs += Math.max(0, Number(elapsedMs) || 0);
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

function _withPathfindSource(source, fn) {
    let prev = _activePathfindSource;
    _activePathfindSource = source || PATH_SOURCE_UNSPECIFIED;
    try {
        return fn();
    } finally {
        _activePathfindSource = prev;
    }
}

// Units waiting for a deferred path, registered where a pending target is
// set, and scheduled by the tick they are next due: the tick after they
// were last looked at, or later while their search budget cools down
// (u._astarBudgetRetryTick). The resolver visits only the units due, so a
// big army waiting its turn costs nothing per tick. The due tick follows
// from the unit's state, so a restored peer rebuilds the same schedule.
let _pendingPathUnits = new Set();
let _pendingPathDue = new Map(); // tick -> [unit] (duplicates dropped when taken)
function _pendingPathDueTick(u, afterTick) {
    let retry = u._astarBudgetRetryTick;
    return Number.isFinite(retry) && retry > afterTick + 1 ? retry : afterTick + 1;
}
function schedulePendingPathUnit(u, tick) {
    let list = _pendingPathDue.get(tick);
    if (!list) _pendingPathDue.set(tick, list = []);
    list.push(u);
}
function notePendingPathUnit(u) {
    _pendingPathUnits.add(u);
    schedulePendingPathUnit(u, _pendingPathDueTick(u, gameTime));
}
function resetPendingPathUnits() {
    _pendingPathUnits = new Set();
    _pendingPathDue = new Map();
    for (let u of units) if (u && !u.dead && u._pendingPathTarget) notePendingPathUnit(u);
}
// The pending units due at `tick` (each once, in id order); those no longer
// waiting are dropped.
function takeDuePendingPathUnits(tick) {
    let due = [];
    for (let [t, list] of _pendingPathDue) {
        if (t > tick) continue;
        _pendingPathDue.delete(t);
        for (let u of list) {
            if (u._pendingDueStamp === tick) continue;
            u._pendingDueStamp = tick;
            if (u.dead || !u._pendingPathTarget) { _pendingPathUnits.delete(u); continue; }
            due.push(u);
        }
    }
    due.sort((a, b) => a.id - b.id);
    return due;
}

function _countPendingPathBacklog() {
    return _pendingPathUnits.size;
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

function _isPathValidForScenario(path, sx, sy, ex, ey, ignoreWalls, canWalk, owner, usePortalEdges) {
    if (!Array.isArray(path) || path.length <= 0) return false;
    if (path[0].x !== sx || path[0].y !== sy) return false;
    let last = path[path.length - 1];
    if (last.x !== ex || last.y !== ey) return false;
    for (let i = 1; i < path.length; i++) {
        let p = path[i - 1], n = path[i];
        let dx = Math.abs(n.x - p.x), dy = Math.abs(n.y - p.y);
        let adjacent = (dx + dy) === 1;
        if (!adjacent) {
            if (!usePortalEdges || !isCloudPortalLink(p.x, p.y, n.x, n.y, owner)) return false;
        }
        if (n.x < 0 || n.x >= GRID_W || n.y < 0 || n.y >= GRID_H) return false;
        if (!ignoreWalls && grid[n.y][n.x].type === TYPE_WALL) {
            if (!(usePortalEdges && !!_getCloudTowerFast(n.x, n.y, owner)) && !(canWalk && canWalk(n.x, n.y))) {
                return false;
            }
        }
    }
    return true;
}

function _findPathBfsReference(sx, sy, ex, ey, ignoreWalls, canWalk, owner, usePortalEdges) {
    if (sx === ex && sy === ey) return [{ x: sx, y: sy }];
    let w = GRID_W, h = GRID_H;
    let size = w * h;
    let q = new Int32Array(size);
    let from = new Int32Array(size);
    from.fill(-1);
    let head = 0, tail = 0;
    let start = sy * w + sx;
    let end = ey * w + ex;
    q[tail++] = start;
    from[start] = start;

    while (head < tail) {
        let k = q[head++];
        if (k === end) break;
        let cx = k % w, cy = (k / w) | 0;

        for (let di = 0; di < 8; di += 2) {
            let nx = cx + _ASTAR_DIRS[di], ny = cy + _ASTAR_DIRS[di + 1];
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            if (!ignoreWalls && grid[ny][nx].type === TYPE_WALL) {
                if (!(usePortalEdges && !!_getCloudTowerFast(nx, ny, owner)) && !(canWalk && canWalk(nx, ny))) continue;
            }
            let nk = ny * w + nx;
            if (from[nk] !== -1) continue;
            from[nk] = k;
            q[tail++] = nk;
        }

        if (usePortalEdges) {
            let cloud = _getCloudTowerFast(cx, cy, owner);
            if (cloud) {
                let partner = getPairedCloudTower(cloud, owner);
                if (partner) {
                    let pk = partner.gy * w + partner.gx;
                    if (from[pk] === -1) {
                        from[pk] = k;
                        q[tail++] = pk;
                    }
                }
            }
        }
    }

    if (from[end] === -1) return null;
    let out = [];
    let cur = end;
    while (true) {
        out.push({ x: cur % w, y: (cur / w) | 0 });
        if (cur === start) break;
        cur = from[cur];
    }
    out.reverse();
    return out;
}

function runPathfindingCorrectnessHarness() {
    let scenarios = [];
    let midSx = Math.floor(GRID_W * 0.15), midSy = Math.floor(GRID_H * 0.15);
    let midEx = Math.floor(GRID_W * 0.85), midEy = Math.floor(GRID_H * 0.85);
    scenarios.push({
        name: 'open_map',
        sx: Math.max(0, Math.min(GRID_W - 1, midSx)),
        sy: Math.max(0, Math.min(GRID_H - 1, midSy)),
        ex: Math.max(0, Math.min(GRID_W - 1, midEx)),
        ey: Math.max(0, Math.min(GRID_H - 1, midEy)),
        ignoreWalls: true,
        canWalk: null,
        owner: localPlayerId
    });

    let wallA = null, wallB = null;
    for (let y = 1; y < GRID_H - 1 && (!wallA || !wallB); y++) {
        for (let x = 1; x < GRID_W - 1 && (!wallA || !wallB); x++) {
            if (grid[y][x].type !== TYPE_WALL) continue;
            if (!wallA) wallA = { x: Math.max(0, x - 1), y };
            else wallB = { x: Math.min(GRID_W - 1, x + 1), y };
        }
    }
    if (wallA && wallB) {
        scenarios.push({
            name: 'dense_walls',
            sx: wallA.x,
            sy: wallA.y,
            ex: wallB.x,
            ey: wallB.y,
            ignoreWalls: false,
            canWalk: null,
            owner: localPlayerId
        });
    }

    let cloud = towers.find(t => t && t.baseStats && t.baseStats.isCloud && t.energy > 0 && !t.underConstruction);
    if (cloud) {
        let pair = getPairedCloudTower(cloud, cloud.owner);
        if (pair) {
            scenarios.push({
                name: 'cloud_portal',
                sx: cloud.gx,
                sy: cloud.gy,
                ex: pair.gx,
                ey: pair.gy,
                ignoreWalls: false,
                canWalk: null,
                owner: cloud.owner
            });
        }
    }

    let mine = goldMines.find(m => m && m.gold > 0);
    if (mine) {
        scenarios.push({
            name: 'worker_can_walk',
            sx: Math.max(0, mine.gx - 1),
            sy: mine.gy,
            ex: mine.gx,
            ey: mine.gy,
            ignoreWalls: false,
            canWalk: _collectorCanWalk,
            owner: localPlayerId
        });
    }

    let results = [];
    for (let s of scenarios) {
        let usePortalEdges = (s.owner !== null && s.owner !== undefined);
        let astar = findPathAStarTagged('unspecified', s.sx, s.sy, s.ex, s.ey, s.ignoreWalls, s.canWalk, s.owner);
        let bfs = _findPathBfsReference(s.sx, s.sy, s.ex, s.ey, s.ignoreWalls, s.canWalk, s.owner, usePortalEdges);
        let astarValid = astar ? _isPathValidForScenario(astar, s.sx, s.sy, s.ex, s.ey, s.ignoreWalls, s.canWalk, s.owner, usePortalEdges) : false;
        let bfsValid = bfs ? _isPathValidForScenario(bfs, s.sx, s.sy, s.ex, s.ey, s.ignoreWalls, s.canWalk, s.owner, usePortalEdges) : false;
        results.push({
            name: s.name,
            astarFound: !!astar,
            bfsFound: !!bfs,
            astarValid,
            bfsValid,
            parity: (!!astar === !!bfs),
            astarLen: astar ? astar.length : 0,
            bfsLen: bfs ? bfs.length : 0
        });
    }

    return {
        tick: gameTime,
        topologyVersion: pathTopologyVersion,
        scenarios: results,
        allPassed: results.every(r => r.astarValid && r.bfsValid && r.parity)
    };
}

window.getPathfindingPerfSnapshot = getPathfindingPerfSnapshot;
window.runPathfindingCorrectnessHarness = runPathfindingCorrectnessHarness;

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

function _makePathCacheKey(sx, sy, ex, ey, movementProfile, pathOwner, usePortalEdges) {
    return movementProfile + '|' + (pathOwner === null ? 'n' : String(pathOwner)) + '|' + (usePortalEdges ? 'p1' : 'p0') + '|' + sx + ',' + sy + '>' + ex + ',' + ey;
}

function _hasUsablePathPortal(owner) {
    if (_cloudTileCacheVer !== pathTopologyVersion) _rebuildCloudTileCache();
    for (let list of _cloudPairIndexCache.values()) {
        let active = 0;
        for (let t of list) {
            if (t.owner === owner && t.energy > 0 && !t.underConstruction && ++active === 2) return true;
        }
    }
    return false;
}

// A lower bound on the path length from a tile to a target when the
// owner's live portals (a step from a cloud to its paired cloud) can
// shorten it: the shortest distance where any move costs its Manhattan
// length and each portal step costs 1. It is consistent (a shortest-path
// metric), so searches keep their heuristic with portals instead of
// flooding the map. `targetH(x, y)` is the plain distance to the target.
// Returns entries [x, y, cost] (cost: 1 + the partner's distance), and
// h(x, y) = min(targetH(x, y), min over entries |x - ex| + |y - ey| + cost).
function _portalHeuristicEntries(owner, targetH) {
    if (_cloudTileCacheVer !== pathTopologyVersion) _rebuildCloudTileCache();
    let ends = [];
    for (let t of _cloudTileCache.values()) {
        if (t.owner !== owner || !(t.energy > 0) || t.underConstruction) continue;
        let partner = getPairedCloudTower(t, owner);
        if (partner) ends.push({ x: t.gx, y: t.gy, partner });
    }
    if (ends.length === 0) return null;
    ends.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    let index = new Map(ends.map((e, i) => [e.y * GRID_W + e.x, i]));
    let partnerOf = ends.map(e => index.has(e.partner.gy * GRID_W + e.partner.gx) ? index.get(e.partner.gy * GRID_W + e.partner.gx) : -1);
    let H = ends.map(e => targetH(e.x, e.y));
    // Shortest distances to the target over portal endpoints (few of them).
    for (let round = 0; round < ends.length + 1; round++) {
        let changed = false;
        for (let i = 0; i < ends.length; i++) {
            let best = H[i];
            if (partnerOf[i] >= 0 && 1 + H[partnerOf[i]] < best) best = 1 + H[partnerOf[i]];
            for (let j = 0; j < ends.length; j++) {
                let d = Math.abs(ends[i].x - ends[j].x) + Math.abs(ends[i].y - ends[j].y) + H[j];
                if (d < best) best = d;
            }
            if (best < H[i]) { H[i] = best; changed = true; }
        }
        if (!changed) break;
    }
    let out = [];
    for (let i = 0; i < ends.length; i++) if (partnerOf[i] >= 0) out.push(ends[i].x, ends[i].y, 1 + H[partnerOf[i]]);
    return out.length ? out : null;
}

function _portalHeuristic(entries, x, y, plain) {
    let h = plain;
    for (let i = 0; i < entries.length; i += 3) {
        let d = Math.abs(x - entries[i]) + Math.abs(y - entries[i + 1]) + entries[i + 2];
        if (d < h) h = d;
    }
    return h;
}

let _pathClearanceGrid = null;
let _pathClearanceVersion = -1;
let _pathClearanceWidth = 0;
let _pathClearanceHeight = 0;
let _pathClearanceTiles = null;

function _ensurePathClearanceCache() {
    if (_pathClearanceGrid === grid && _pathClearanceVersion === pathTopologyVersion &&
        _pathClearanceWidth === GRID_W && _pathClearanceHeight === GRID_H) return;
    _pathClearanceGrid = grid;
    _pathClearanceVersion = pathTopologyVersion;
    _pathClearanceWidth = GRID_W;
    _pathClearanceHeight = GRID_H;
    if (!_pathClearanceTiles || _pathClearanceTiles.length !== GRID_W * GRID_H) {
        _pathClearanceTiles = new Uint8Array(GRID_W * GRID_H);
    } else _pathClearanceTiles.fill(0);
}

// Cache terrain clearance lazily across searches. Only two rings (24 cells)
// are inspected; three means enough room, where diagonal preference takes over.
// Special passability is checked live and never stored in the terrain cache.
function _getPathClearance(x, y, canWalk, owner, usePortalEdges) {
    let width = GRID_W, height = GRID_H, terrainGrid = grid;
    let key = y * width + x;
    let clearance = _pathClearanceTiles[key];
    if (!clearance) {
        clearance = 3;
        terrain: for (let r = 1; r <= 2; r++) {
            for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
                if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
                let nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height || terrainGrid[ny][nx].type === TYPE_WALL) {
                    clearance = r;
                    break terrain;
                }
            }
        }
        _pathClearanceTiles[key] = clearance;
    }
    if (clearance === 3 || (!canWalk && !(usePortalEdges && _cloudTileCache.size))) return clearance;
    for (let r = clearance; r <= 2; r++) {
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
            let nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) return r;
            if (terrainGrid[ny][nx].type === TYPE_WALL &&
                !(usePortalEdges && _getCloudTowerFast(nx, ny, owner)) && !(canWalk && canWalk(nx, ny))) return r;
        }
    }
    return 3;
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

function _buildDeterministicOpenGridPath(sx, sy, ex, ey, maxLen = Infinity) {
    let path = [{ x: sx, y: sy }];
    let cx = sx;
    let cy = sy;
    let totalDx = Math.abs(ex - sx);
    let totalDy = Math.abs(ey - sy);
    let stepX = ex > sx ? 1 : (ex < sx ? -1 : 0);
    let stepY = ey > sy ? 1 : (ey < sy ? -1 : 0);
    let movedX = 0;
    let movedY = 0;
    let preferXOnTie = (((sx + sy + ex + ey) & 1) === 0);
    let guard = 0;
    let guardMax = Math.max(1, (GRID_W * GRID_H) + 4);

    while ((cx !== ex || cy !== ey) && guard < guardMax) {
        guard++;
        let moveAlongX = false;
        if (movedX >= totalDx) {
            moveAlongX = false;
        } else if (movedY >= totalDy) {
            moveAlongX = true;
        } else {
            let nextXCross = (movedX + 1) * totalDy;
            let nextYCross = (movedY + 1) * totalDx;
            if (nextXCross < nextYCross) moveAlongX = true;
            else if (nextYCross < nextXCross) moveAlongX = false;
            else moveAlongX = preferXOnTie;
        }

        if (moveAlongX && stepX !== 0) {
            cx += stepX;
            movedX++;
        } else if (stepY !== 0) {
            cy += stepY;
            movedY++;
        } else if (stepX !== 0) {
            cx += stepX;
            movedX++;
        } else {
            break;
        }

        path.push({ x: cx, y: cy });
        if (path.length >= maxLen) break;
    }

    return path;
}

// ---- A* scratch buffers: reused across calls via epoch trick, avoids per-call alloc ----
let _astarCap = 0;
let _astarEpoch = 0;
let _astarVisitedGen = null;  // Int32Array: [key] === epoch G�� visited this call
let _astarGScoreGen = null;  // Int32Array: [key] === epoch G�� gScore valid this call
let _astarGScoreVal = null;  // Int32Array: best g-score per tile
let _astarFrom = null;  // Int32Array: parent key (for path reconstruction)
let _astarHeapF = null;  // Float64Array: integer cost plus bounded tie preference
let _astarHeapK = null;  // Int32Array: heap node keys

function _ensureAstarBuffers(size) {
    if (size > _astarCap) {
        _astarCap = size + 2048;
        _astarVisitedGen = new Int32Array(_astarCap);
        _astarGScoreGen = new Int32Array(_astarCap);
        _astarGScoreVal = new Int32Array(_astarCap);
        _astarFrom = new Int32Array(_astarCap);
        _astarHeapF = new Float64Array(_astarCap * 4);
        _astarHeapK = new Int32Array(_astarCap * 4);
    }
}

// Static 4-directional offsets: avoids per-iteration array allocation in hot path
const _ASTAR_DIRS = new Int8Array([0, 1, 0, -1, 1, 0, -1, 0]);

// Cloud tower tile cache G�� keyed by (gy*GRID_W+gx), invalidated by pathTopologyVersion
let _cloudTileCache = null;
let _cloudTileCacheVer = -1;
let _cloudPairIndexCache = null;

function _makeCloudPairKey(pairId, owner) {
    return String(pairId) + '|' + String(owner);
}

function _rebuildCloudTileCache() {
    let m = new Map();
    let pairIndex = new Map();
    for (let t of towers) {
        if (t.baseStats && t.baseStats.isCloud) {
            m.set(t.gy * GRID_W + t.gx, t);
            let pairId = t.baseStats.pairId;
            if (pairId !== undefined && pairId !== null) {
                let key = _makeCloudPairKey(pairId, t.owner);
                let list = pairIndex.get(key);
                if (!list) {
                    list = [];
                    pairIndex.set(key, list);
                }
                list.push(t);
            }
        }
    }
    _cloudTileCache = m;
    _cloudPairIndexCache = pairIndex;
    _cloudTileCacheVer = pathTopologyVersion;
}

// Fast O(1) cloud-tower lookup with live energy/construction check
function _getCloudTowerFast(gx, gy, owner) {
    if (_cloudTileCacheVer !== pathTopologyVersion) _rebuildCloudTileCache();
    let t = _cloudTileCache.get(gy * GRID_W + gx);
    if (!t) return null;
    if (!(t.energy > 0 && !t.underConstruction)) return null;
    if (owner !== null && t.owner !== owner) return null;
    return t;
}

// ---- Connected regions of the plain ground graph ----
// Tiles that are not walls (and the owner's live cloud portals, joined with
// their pair) in 4-connected regions, per owner. A search whose target lies
// in another region than its start cannot reach it: rather than exhausting
// the start's whole region (often over several ticks of budget), it goes
// straight to the region's tile nearest the target (see findPathAStar).
// The plain labels (no portals) are kept as walls change
// (pathRegionsTileChanged): a tile opened joins the regions around it; a
// tile closed is left out, and only when its open neighbours are not
// joined around it (the ring of tiles around it, then a search in a window
// around it) are the labels made again. An owner with live portals gets
// the plain labels joined through its portals (each plain region mapped to
// its root: a pass over the tiles, not a flood of the map), then kept the
// same way (made again when its portals change or a tile with one of them
// changes). (Region numbers may differ from a fresh build's: only which
// tiles share a region counts, the same on every peer.) Owners without
// live portals share the plain labels (key -1).
let _pathRegions = { w: 0, h: 0, grid: null, portalSig: 0, portalOwners: new Set(), byOwner: new Map(), nearest: new Map(), rebuilds: 0 };

function _pathRegionPortalSignature() {
    if (_cloudTileCacheVer !== pathTopologyVersion) _rebuildCloudTileCache();
    let sig = 0;
    for (let [key, t] of _cloudTileCache) if (t.energy > 0 && !t.underConstruction) sig = (Math.imul(sig ^ (key + 1), 16777619) + (t.owner + 3)) | 0;
    return sig;
}
function _pathRegionFind(E, a) {
    const P = E.parent;
    while (P[a] !== a) { P[a] = P[P[a]]; a = P[a]; }
    return a;
}
// Region label per tile (-1: not walkable) for plain ground movement of
// `owner` (null: no portals).
function getPathRegions(owner) {
    let R = _pathRegions;
    let portalSig = _pathRegionPortalSignature();
    if (R.grid !== grid || R.w !== GRID_W || R.h !== GRID_H) {
        R.grid = grid; R.w = GRID_W; R.h = GRID_H;
        R.byOwner = new Map(); R.nearest = new Map();
    }
    if (R.portalSig !== portalSig || !R.portalOwners) {
        // (The plain labels stay; the owners' are made again.)
        R.portalSig = portalSig;
        R.portalOwners = new Set();
        for (let t of _cloudTileCache.values()) if (t.energy > 0 && !t.underConstruction) R.portalOwners.add(t.owner);
        for (const k of [...R.byOwner.keys()]) if (k >= 0) R.byOwner.delete(k);
        R.nearest = new Map();
    }
    let key = owner === null || owner === undefined ? -1 : owner;
    if (key >= 0 && !R.portalOwners.has(key)) key = -1;
    const plain = _pathRegionsPlain(R);
    if (key < 0) return plain.labels;
    let E = R.byOwner.get(key);
    if (E && !E.dirty) { _pathRegionsCanon(E); return E.labels; }
    E = _pathRegionsOwner(R, key, plain, E);
    R.byOwner.set(key, E);
    return E.labels;
}
// (Regions joined since: every label its region's root.)
function _pathRegionsCanon(E) {
    if (!E.canon) return;
    const L = E.labels;
    for (let i = 0; i < L.length; i++) if (L[i] >= 0) L[i] = _pathRegionFind(E, L[i]);
    E.canon = false;
}
// The plain labels, made (a flood of the map) when missing or after a
// possible split.
function _pathRegionsPlain(R) {
    let E = R.byOwner.get(-1);
    if (E && E.dirty) { R.byOwner.delete(-1); E = null; }
    if (E) { _pathRegionsCanon(E); return E; }
    R.rebuilds++;
    let w = GRID_W, h = GRID_H, n = w * h;
    let labels = new Int32Array(n).fill(-1);
    let walk = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
        let row = grid[y];
        for (let x = 0; x < w; x++) if (row[x].type !== TYPE_WALL) walk[y * w + x] = 1;
    }
    let q = new Int32Array(n), next = 0;
    for (let i = 0; i < n; i++) {
        if (!walk[i] || labels[i] >= 0) continue;
        let id = next++, head = 0, tail = 0;
        labels[i] = id; q[tail++] = i;
        while (head < tail) {
            let k = q[head++], x = k % w, y = (k / w) | 0;
            if (x > 0 && walk[k - 1] && labels[k - 1] < 0) { labels[k - 1] = id; q[tail++] = k - 1; }
            if (x < w - 1 && walk[k + 1] && labels[k + 1] < 0) { labels[k + 1] = id; q[tail++] = k + 1; }
            if (y > 0 && walk[k - w] && labels[k - w] < 0) { labels[k - w] = id; q[tail++] = k - w; }
            if (y < h - 1 && walk[k + w] && labels[k + w] < 0) { labels[k + w] = id; q[tail++] = k + w; }
        }
    }
    E = { key: -1, labels, parent: new Int32Array(Math.max(64, next * 2)), next, canon: false, dirty: false };
    for (let i = 0; i < E.parent.length; i++) E.parent[i] = i;
    R.byOwner.set(-1, E);
    return E;
}
// An owner's labels from the plain ones (canonical: every label a root):
// its live portals' tiles (walls to others) walkable, joined with their open
// neighbours and their pair; each plain region then labelled by its root.
function _pathRegionsOwner(R, key, plain, old) {
    const PL = plain.labels, n = PL.length, w = GRID_W, h = GRID_H, M = plain.next;
    const extra = new Map();
    let more = 0;
    for (let [tk, t] of _cloudTileCache) if (t.owner === key && t.energy > 0 && !t.underConstruction && PL[tk] < 0) extra.set(tk, M + more++);
    const E = { key, labels: old && old.labels.length === n ? old.labels : new Int32Array(n), parent: new Int32Array(Math.max(64, (M + more) * 2)), next: M + more, canon: false, dirty: false };
    for (let i = 0; i < E.parent.length; i++) E.parent[i] = i;
    const label = k => { const l = PL[k]; if (l >= 0) return l; const e = extra.get(k); return e === undefined ? -1 : e; };
    const join = (a, b) => { const ra = _pathRegionFind(E, a), rb = _pathRegionFind(E, b); if (ra !== rb) E.parent[Math.max(ra, rb)] = Math.min(ra, rb); };
    for (const [tk, l] of extra) {
        const x = tk % w, y = (tk / w) | 0;
        if (x > 0) { const o = label(tk - 1); if (o >= 0) join(l, o); }
        if (x < w - 1) { const o = label(tk + 1); if (o >= 0) join(l, o); }
        if (y > 0) { const o = label(tk - w); if (o >= 0) join(l, o); }
        if (y < h - 1) { const o = label(tk + w); if (o >= 0) join(l, o); }
    }
    for (let [tk, t] of _cloudTileCache) {
        if (t.owner !== key || !(t.energy > 0 && !t.underConstruction)) continue;
        let partner = getPairedCloudTower(t, key);
        if (!partner) continue;
        let a = label(tk), b = label(partner.gy * w + partner.gx);
        if (a >= 0 && b >= 0) join(a, b);
    }
    const map = new Int32Array(M);
    for (let l = 0; l < M; l++) map[l] = _pathRegionFind(E, l);
    const L = E.labels;
    for (let i = 0; i < n; i++) { const l = PL[i]; L[i] = l >= 0 ? map[l] : -1; }
    for (const [tk, l] of extra) L[tk] = _pathRegionFind(E, l);
    return E;
}
// The ring of 8 tiles around a tile, in order (each 4-adjacent to the next).
const _PATH_REGION_RING = [0, -1, 1, -1, 1, 0, 1, 1, 0, 1, -1, 1, -1, 0, -1, -1];
// A closed tile's open 4-neighbours still joined by a way around it within a
// window of PATH_REGION_LOCAL_RADIUS tiles (a breadth-first search from one
// of them until it met the others): else the labels are made again.
const PATH_REGION_LOCAL_RADIUS = 24;
let _pathRegionStamp = null, _pathRegionStampNow = 0, _pathRegionQ = null;
function _pathRegionJoinedAround(L, gx, gy) {
    const W = GRID_W, H = GRID_H, n = W * H, r = PATH_REGION_LOCAL_RADIUS;
    if (!_pathRegionStamp || _pathRegionStamp.length !== n) { _pathRegionStamp = new Int32Array(n); _pathRegionStampNow = 0; }
    if (++_pathRegionStampNow >= 0x7fffffff) { _pathRegionStamp.fill(0); _pathRegionStampNow = 1; }
    const S = _pathRegionStamp, now = _pathRegionStampNow, side = 2 * r + 1;
    if (!_pathRegionQ || _pathRegionQ.length < side * side) _pathRegionQ = new Int32Array(side * side);
    const Q = _pathRegionQ, x0 = Math.max(0, gx - r), y0 = Math.max(0, gy - r), x1 = Math.min(W - 1, gx + r), y1 = Math.min(H - 1, gy + r);
    const t = gy * W + gx;
    let want = 0, start = -1;
    const nb = [gx > 0 ? t - 1 : -1, gx < W - 1 ? t + 1 : -1, gy > 0 ? t - W : -1, gy < H - 1 ? t + W : -1];
    // (Targets stamped now - 1 would collide with the last search: a stamp
    // of their own, -now.)
    for (const k of nb) if (k >= 0 && L[k] >= 0) { if (start < 0) start = k; else { S[k] = -now; want++; } }
    if (start < 0 || want === 0) return true;
    let head = 0, tail = 0;
    S[start] = now; Q[tail++] = start;
    while (head < tail) {
        const k = Q[head++], x = k % W, y = (k / W) | 0;
        for (let d = 0; d < 4; d++) {
            const nx = d === 0 ? x - 1 : d === 1 ? x + 1 : x, ny = d === 2 ? y - 1 : d === 3 ? y + 1 : y;
            if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
            const m = ny * W + nx;
            if (S[m] === now || L[m] < 0) continue;
            if (S[m] === -now && --want === 0) return true;
            S[m] = now; Q[tail++] = m;
        }
    }
    return false;
}
// A tile's wall changed (simMoveTileTypeChanged, as the grid changes): the
// kept labels follow, the plain ones and each owner's (a tile with a
// portal on it: that owner's made again from the plain ones).
function pathRegionsTileChanged(gx, gy) {
    const R = _pathRegions;
    if (!R.byOwner.size || R.grid !== grid || R.w !== GRID_W || R.h !== GRID_H) return;
    const W = GRID_W, row = grid[gy], cell = row ? row[gx] : null;
    if (!cell || gx < 0 || gx >= W) return;
    const t = gy * W + gx, open = cell.type !== TYPE_WALL;
    R.nearest.clear();
    for (const E of R.byOwner.values()) {
        if (E.dirty) continue;
        if (E.key >= 0 && _cloudTileCache && _cloudTileCache.has(t)) { E.dirty = true; continue; }
        _pathRegionTileSet(E, gx, gy, open);
    }
}
function _pathRegionTileSet(E, gx, gy, open) {
    const W = GRID_W, H = GRID_H, t = gy * W + gx, L = E.labels;
    if (open === (L[t] >= 0)) return;
    if (open) {
        let root = -1;
        for (let i = 0; i < 4; i++) {
            const k = i === 0 ? (gx > 0 ? t - 1 : -1) : i === 1 ? (gx < W - 1 ? t + 1 : -1) : i === 2 ? (gy > 0 ? t - W : -1) : (gy < H - 1 ? t + W : -1);
            if (k < 0 || L[k] < 0) continue;
            const r = _pathRegionFind(E, L[k]);
            if (root < 0) root = r;
            else if (r !== root) { if (r < root) { E.parent[root] = r; root = r; } else E.parent[r] = root; E.canon = true; }
        }
        if (root < 0) {
            root = E.next++;
            if (root >= E.parent.length) { const P = new Int32Array(E.parent.length * 2); P.set(E.parent); for (let i = E.parent.length; i < P.length; i++) P[i] = i; E.parent = P; }
        }
        L[t] = root;
    } else {
        L[t] = -1;
        // Its open 4-neighbours stay joined when one run of open tiles
        // around it holds them all, or a way around it in a window joins
        // them; else the labels are made again.
        let n4 = 0, firstClosed = -1;
        const ring = _pathRegionRingScratch;
        for (let i = 0; i < 8; i++) {
            const x = gx + _PATH_REGION_RING[2 * i], y = gy + _PATH_REGION_RING[2 * i + 1];
            const o = x >= 0 && y >= 0 && x < W && y < H && L[y * W + x] >= 0;
            ring[i] = o ? 1 : 0;
            if (o && (i & 1) === 0) n4++;
            if (!o && firstClosed < 0) firstClosed = i;
        }
        if (n4 <= 1 || firstClosed < 0) return;
        let runs = 0, has4 = false;
        for (let k = 1; k <= 8; k++) {
            const i = (firstClosed + k) % 8;
            if (ring[i]) { if ((i & 1) === 0) has4 = true; }
            else { if (has4) runs++; has4 = false; }
        }
        if (runs > 1 && !_pathRegionJoinedAround(L, gx, gy)) E.dirty = true;
    }
}
const _pathRegionRingScratch = new Uint8Array(8);
// Grid tiles set without the hook (a restore): made again at next use.
function pathRegionsReset() { _pathRegions.byOwner = new Map(); _pathRegions.nearest = new Map(); }
// The plain labels, made ahead (a match's first tick, after a restore): not
// at the first order.
// (Then the owners with live portals, one a tick.)
function pathRegionsWarm() {
    const R = _pathRegions;
    if (!(R.grid === grid && R.w === GRID_W && R.h === GRID_H && R.byOwner.has(-1) && !R.byOwner.get(-1).dirty)) { getPathRegions(null); return; }
    if (R.portalSig !== _pathRegionPortalSignature()) getPathRegions(null);
    for (const o of R.portalOwners) { const E = R.byOwner.get(o); if (!E || E.dirty) { getPathRegions(o); return; } }
}

// The tile of `region` nearest (Manhattan, then lowest index) to (ex, ey):
// the reachable stand-in for a target outside the region. Cached.
function nearestTileInPathRegion(owner, labels, region, ex, ey) {
    let R = _pathRegions;
    let key = ((owner === null || owner === undefined ? -1 : owner) + 2) * 1e9 + region * 1e5 + ey * GRID_W + ex;
    let hit = R.nearest.get(key);
    if (hit !== undefined) return hit;
    let w = GRID_W, best = -1, bestD = Infinity;
    for (let i = 0; i < labels.length; i++) {
        if (labels[i] !== region) continue;
        let d = Math.abs(i % w - ex) + Math.abs(((i / w) | 0) - ey);
        if (d < bestD) { bestD = d; best = i; }
    }
    R.nearest.set(key, best);
    return best;
}

// Typed-array min-heap (no object allocation per push)
// _astarHeapF / _astarHeapK must be ensured before use; _astarHeapSz tracks current size.
let _astarHeapSz = 0;

function _heapPush(f, k) {
    let i = _astarHeapSz++;
    _astarHeapF[i] = f; _astarHeapK[i] = k;
    let hF = _astarHeapF, hK = _astarHeapK;
    while (i > 0) {
        let p = (i - 1) >> 1;
        if (hF[p] > hF[i] || (hF[p] === hF[i] && hK[p] > hK[i])) {
            let tf = hF[i]; hF[i] = hF[p]; hF[p] = tf;
            let tk = hK[i]; hK[i] = hK[p]; hK[p] = tk;
            i = p;
        } else break;
    }
}

// Returns popped f in _astarPopF, key in _astarPopK
let _astarPopF = 0, _astarPopK = 0;
function _heapPop() {
    _astarPopF = _astarHeapF[0]; _astarPopK = _astarHeapK[0];
    let n = --_astarHeapSz;
    if (n > 0) {
        let hF = _astarHeapF, hK = _astarHeapK;
        hF[0] = hF[n]; hK[0] = hK[n];
        let i = 0;
        while (true) {
            let l = (i << 1) + 1, r = l + 1, s = i;
                if (l < n && (hF[l] < hF[s] || (hF[l] === hF[s] && hK[l] < hK[s]))) s = l;
                if (r < n && (hF[r] < hF[s] || (hF[r] === hF[s] && hK[r] < hK[s]))) s = r;
            if (s !== i) {
                let tf = hF[i]; hF[i] = hF[s]; hF[s] = tf;
                let tk = hK[i]; hK[i] = hK[s]; hK[s] = tk;
                i = s;
            } else break;
        }
    }
}

class MinHeap {
    constructor() { this.data = []; }
    push(item) { this.data.push(item); this._bubbleUp(this.data.length - 1); }
    pop() {
        let top = this.data[0];
        let len = this.data.length - 1;
        if (len > 0) {
            let last = this.data[len];
            this.data[0] = last;
            this._sinkDown(0, len, last.f);
        }
        this.data.pop();
        return top;
    }
    get length() { return this.data.length; }
    _bubbleUp(i) {
        let item = this.data[i];
        let f = item.f;
        while (i > 0) {
            let p = (i - 1) >> 1;
            let pf = this.data[p].f;
            if (f < pf) { this.data[i] = this.data[p]; i = p; }
            else break;
        }
        this.data[i] = item;
    }
    _sinkDown(i, n, itemF) {
        let data = this.data;
        while (true) {
            let l = (i << 1) + 1, r = l + 1, smallest = i;
            let smallestF = itemF;
            if (l < n && data[l].f < smallestF) { smallest = l; smallestF = data[l].f; }
            if (r < n && data[r].f < smallestF) smallest = r;
            if (smallest !== i) { data[i] = data[smallest]; i = smallest; }
            else break;
        }
        data[i] = data[n];
    }
}

function getCloudTowerAt(gx, gy, owner = null) {
    return _getCloudTowerFast(gx, gy, owner);
}

function getPairedCloudTower(cloud, owner = null) {
    if (!cloud || !cloud.baseStats || !cloud.baseStats.isCloud) return null;
    let pairId = cloud.baseStats.pairId;
    if (pairId === undefined || pairId === null) return null;
    let matchOwner = owner !== null ? owner : cloud.owner;
    if (_cloudTileCacheVer !== pathTopologyVersion) _rebuildCloudTileCache();
    let list = _cloudPairIndexCache.get(_makeCloudPairKey(pairId, matchOwner));
    if (!list || list.length <= 0) return null;
    for (let i = 0; i < list.length; i++) {
        let t = list[i];
        if (t === cloud) continue;
        if (t.energy > 0 && !t.underConstruction) return t;
    }
    return null;
}

function isCloudPortalLink(gx1, gy1, gx2, gy2, owner) {
    let c1 = getCloudTowerAt(gx1, gy1, owner);
    let c2 = getCloudTowerAt(gx2, gy2, owner);
    if (!c1 || !c2) return false;
    if (c1.baseStats.pairId === undefined || c2.baseStats.pairId === undefined) return false;
    return c1.baseStats.pairId === c2.baseStats.pairId;
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

    // Builders can stand on active build/upgrade targets.
    if (unit.workerType === 'builder') {
        if (_canBuilderPassTile(unit.owner, gx, gy)) return true;
    }

    // Salvagers can stand on owned marked-for-salvage targets.
    if (unit.workerType === 'salvager') {
        let isOwnedMarkedTarget = (obj) => !!obj && obj.owner === unit.owner && !!obj.markedForSalvage && (!(obj.energy !== undefined) || obj.energy > 0);
        if (isOwnedMarkedTarget(getTileEntityRef(gx, gy))) return true;
    }

    return false;
}

function isWalkableTileFor(unit, gx, gy) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
    if (unit) return canUnitOccupyTile(unit, gx, gy);
    return grid[gy][gx].type !== TYPE_WALL;
}

function findPathAStar(sx, sy, ex, ey, ignoreWalls = false, canWalk = null, pathOwner = null, cacheProfileHint = null, allowClosestReachableFallback = true) {
    let perfStart = performance.now();
    let sourceTag = _activePathfindSource || PATH_SOURCE_UNSPECIFIED;
    let ownerForBudget = _normalizeOwnerId(pathOwner !== null ? pathOwner : _activePathfindOwner);
    _lastPathfindAbortedByBudget = false;
    if (sx === ex && sy === ey) {
        _recordPathfindCall(sourceTag, performance.now() - perfStart, false);
        return [{ x: ex, y: ey }];
    }
    // Cloud portals are only relevant for grounded movement; flying/open-grid paths are handled directly.
    let usePortalEdges = (!ignoreWalls && pathOwner !== null);
    let movementProfile = _resolveMovementProfile(ignoreWalls, canWalk, cacheProfileHint);
    let cacheKey = null;
    let resumePrefixPath = null;
    let resumeStartX = sx;
    let resumeStartY = sy;

    let gridData = grid, wallG = typeof simMoveWallGrid === 'function' ? simMoveWallGrid() : null;
    let gridW = GRID_W;
    let gridH = GRID_H;

    if (movementProfile) {
        cacheKey = _makePathCacheKey(sx, sy, ex, ey, movementProfile, pathOwner, usePortalEdges);
        let cached = sharedPathCache.get(cacheKey);
        if (cached && !_isPathCacheExpired(cached, PATH_CACHE_TTL_TICKS)) {
            _recordPathfindCall(sourceTag, performance.now() - perfStart, true);
            return cached.path;
        }
        if (cached) sharedPathCache.delete(cacheKey);

        let partial = sharedPartialPathCache.get(cacheKey);
        if (partial && !_isPathCacheExpired(partial, PARTIAL_PATH_CACHE_TTL_TICKS) && Array.isArray(partial.path) && partial.path.length > 1) {
            let last = partial.path[partial.path.length - 1];
            if (last && Number.isFinite(last.x) && Number.isFinite(last.y) && last.x >= 0 && last.x < GRID_W && last.y >= 0 && last.y < GRID_H) {
                resumePrefixPath = partial.path;
                resumeStartX = Math.floor(last.x);
                resumeStartY = Math.floor(last.y);
            }
        } else if (partial) {
            sharedPartialPathCache.delete(cacheKey);
        }
    }

    if (resumePrefixPath) {
        sx = resumeStartX;
        sy = resumeStartY;
        if (sx === ex && sy === ey) {
            let full = resumePrefixPath;
            if (movementProfile) {
                sharedPathCache.set(cacheKey, { path: full, tick: gameTime, version: pathTopologyVersion });
                sharedPartialPathCache.delete(cacheKey);
                _trimPathCacheIfNeeded(sharedPathCache, PATH_CACHE_MAX_ENTRIES);
            }
            _recordPathfindCall(sourceTag, performance.now() - perfStart, false);
            return full;
        }
    }

    if (ignoreWalls) {
        let path = _buildDeterministicOpenGridPath(sx, sy, ex, ey);
        if (resumePrefixPath && resumePrefixPath.length > 0 && path.length > 0) {
            let merged = resumePrefixPath.slice();
            for (let i = 1; i < path.length; i++) merged.push(path[i]);
            path = merged;
        }
        if (movementProfile) {
            sharedPathCache.set(cacheKey, { path, tick: gameTime, version: pathTopologyVersion });
            sharedPartialPathCache.delete(cacheKey);
            _trimPathCacheIfNeeded(sharedPathCache, PATH_CACHE_MAX_ENTRIES);
        }
        _recordPathfindCall(sourceTag, performance.now() - perfStart, false);
        return path;
    }

    // Resolve cloud tile cache once per call (O(1) per lookup in hot path)
    if (usePortalEdges && _cloudTileCacheVer !== pathTopologyVersion) _rebuildCloudTileCache();
    // Only inspect live pairs on cache misses. Unpaired cloud tiles stay
    // walkable, but do not require disabling the Manhattan heuristic.
    let usePortalHeuristic = usePortalEdges && _hasUsablePathPortal(pathOwner);

    if (!ignoreWalls && sx >= 0 && sx < gridW && sy >= 0 && sy < gridH) {
        if (gridData[ey] && gridData[ey][ex] && !(ignoreWalls || gridData[ey][ex].type !== TYPE_WALL || (usePortalEdges && _getCloudTowerFast(ex, ey, pathOwner)) || (canWalk && canWalk(ex, ey)))) {
            // Find nearest walkable neighbor of target
            let best = null, bestD = 9999;
            for (let di = 0; di < 8; di += 2) {
                let nx = ex + _ASTAR_DIRS[di], ny = ey + _ASTAR_DIRS[di + 1];
                if (nx >= 0 && nx < gridW && ny >= 0 && ny < gridH && (ignoreWalls || gridData[ny][nx].type !== TYPE_WALL || (usePortalEdges && _getCloudTowerFast(nx, ny, pathOwner)) || (canWalk && canWalk(nx, ny)))) {
                    let d = Math.abs(nx - sx) + Math.abs(ny - sy);
                    if (d < bestD) { bestD = d; best = { x: nx, y: ny }; }
                }
            }
            if (best) { ex = best.x; ey = best.y; }
            else {
                _recordPathfindCall(sourceTag, performance.now() - perfStart, false);
                return null;
            }
        }
        // Plain ground movement: a target in another region cannot be
        // reached; the search heads for the start region's tile nearest it.
        if (!canWalk) {
            let owner = usePortalEdges ? pathOwner : null;
            let labels = getPathRegions(owner);
            let sr = labels[sy * gridW + sx], er = labels[ey * gridW + ex];
            if (sr >= 0 && er !== sr) {
                let t = allowClosestReachableFallback ? nearestTileInPathRegion(owner, labels, sr, ex, ey) : -1;
                if (t < 0) {
                    _recordPathfindCall(sourceTag, performance.now() - perfStart, false);
                    return null;
                }
                // Already as near as it can get: arrived.
                if (t === sy * gridW + sx) {
                    _recordPathfindCall(sourceTag, performance.now() - perfStart, false);
                    return [{ x: sx, y: sy }];
                }
                ex = t % gridW; ey = (t / gridW) | 0;
            }
        }
    }

    let bufSize = gridW * gridH;
    _ensurePathClearanceCache();
    let clearanceTiles = _pathClearanceTiles;
    // Portal lookups can only succeed when cloud towers exist at all.
    let hasCloudTiles = usePortalEdges && !!(_cloudTileCache && _cloudTileCache.size);
    let routeDx = ex - sx, routeDy = ey - sy;
    // The fractional part is always < 1: it only orders equal-cost paths.
    // Prefer clearance first, then progress and proximity to the direct line.
    // This interleaves cardinal steps without adding diagonal tile edges,
    // per-unit variants or allocations in the neighbor loop.
    let tieStride = 2 * bufSize + 4 * (gridW + gridH) + 1;
    let tieScale = 0.125 / ((gridW + gridH + 1) * tieStride);
    _ensureAstarBuffers(bufSize);
    let configuredAstarLimit = Math.max(ASTAR_MAX_ITERS_BASE, Math.min(ASTAR_MAX_ITERS_HARD, Math.floor(Number(ASTAR_MAX_ITERS_LIMIT) || ASTAR_MAX_ITERS_HARD)));
    let maxAstarIterations = Math.max(ASTAR_MAX_ITERS_BASE, Math.min(configuredAstarLimit, (bufSize >> 1) + ASTAR_MAX_ITERS_BASE));
    let astarIterations = 0;
    let abortedByBudget = false;
    let budgetOwner = Number.isFinite(pathOwner) ? pathOwner : _activePathfindOwner;
    let partialResumeKey = -1;

    // Bump epoch; on overflow reset arrays
    if (++_astarEpoch > 2000000000) {
        _astarEpoch = 1;
        _astarVisitedGen.fill(0);
        _astarGScoreGen.fill(0);
    }
    let epoch = _astarEpoch;
    let visitedGen = _astarVisitedGen;
    let gScoreGen = _astarGScoreGen;
    let gScoreVal = _astarGScoreVal;
    let astarFrom = _astarFrom;

    let startKey = sy * gridW + sx;
    let endKey = ey * gridW + ex;
    let bestReachableKey = startKey;
    let bestReachableH = Math.abs(ex - sx) + Math.abs(ey - sy);
    let bestReachableG = 0;

    // Init start node
    gScoreGen[startKey] = epoch;
    gScoreVal[startKey] = 0;
    astarFrom[startKey] = startKey; // sentinel for path reconstruction

    _astarHeapSz = 0;
    // With live portals, the portal-aware bound (see _portalHeuristicEntries).
    let portalEntries = usePortalHeuristic ? _portalHeuristicEntries(pathOwner, (x, y) => Math.abs(ex - x) + Math.abs(ey - y)) : null;
    let startH = usePortalHeuristic
        ? (portalEntries ? _portalHeuristic(portalEntries, sx, sy, Math.abs(ex - sx) + Math.abs(ey - sy)) : 0)
        : (Math.abs(ex - sx) + Math.abs(ey - sy));
    _heapPush(startH, startKey);

    while (_astarHeapSz > 0) {
        let heapSz = --_astarHeapSz;
        let curKey = _astarHeapK[0];
        if (heapSz > 0) {
            let hF = _astarHeapF, hK = _astarHeapK;
            hF[0] = hF[heapSz];
            hK[0] = hK[heapSz];
            let i = 0;
            while (true) {
                let l = (i << 1) + 1;
                if (l >= heapSz) break;
                let r = l + 1;
                let s = l;
                if (r < heapSz && (hF[r] < hF[l] || (hF[r] === hF[l] && hK[r] < hK[l]))) s = r;
                if (hF[i] < hF[s] || (hF[i] === hF[s] && hK[i] <= hK[s])) break;
                let tf = hF[i]; hF[i] = hF[s]; hF[s] = tf;
                let tk = hK[i]; hK[i] = hK[s]; hK[s] = tk;
                i = s;
            }
        }
        if (visitedGen[curKey] === epoch) continue;
        visitedGen[curKey] = epoch;

        if (curKey === endKey) {
            // Reconstruct path (follow astarFrom back to startKey)
            let path = [];
            let k = endKey;
            while (true) {
                path.push({ x: k % gridW, y: (k / gridW) | 0 });
                if (k === startKey) break;
                k = astarFrom[k];
            }
            path.reverse();
            if (resumePrefixPath && resumePrefixPath.length > 0) {
                let merged = resumePrefixPath.slice();
                for (let i = 1; i < path.length; i++) merged.push(path[i]);
                path = merged;
            }
            if (movementProfile) {
                sharedPathCache.set(cacheKey, { path: path, tick: gameTime, version: pathTopologyVersion });
                sharedPartialPathCache.delete(cacheKey);
                _trimPathCacheIfNeeded(sharedPathCache, PATH_CACHE_MAX_ENTRIES);
            }
            _recordPathfindCall(sourceTag, performance.now() - perfStart, false);
            return path;
        }

        if (!_tryConsumeAstarNodeBudget(budgetOwner, 1)) {
            abortedByBudget = true;
            _lastPathfindAbortedByBudget = true;
            partialResumeKey = curKey;
            break;
        }
        astarIterations++;
        if (astarIterations > maxAstarIterations) {
            abortedByBudget = true;
            _lastPathfindAbortedByBudget = true;
            partialResumeKey = curKey;
            break;
        }

        let cx = curKey % gridW, cy = (curKey / gridW) | 0;
        let cg = gScoreVal[curKey];
        let curH = Math.abs(ex - cx) + Math.abs(ey - cy);
        if (curH < bestReachableH || (curH === bestReachableH && (cg < bestReachableG || (cg === bestReachableG && curKey < bestReachableKey)))) {
            bestReachableKey = curKey;
            bestReachableH = curH;
            bestReachableG = cg;
        }

        // Expand 4 cardinal neighbors inline (no array allocation)
        for (let di = 0; di < 8; di += 2) {
            let nx = cx + _ASTAR_DIRS[di], ny = cy + _ASTAR_DIRS[di + 1];
            if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
            if (!ignoreWalls && (wallG ? wallG[ny * gridW + nx] : gridData[ny][nx].type === TYPE_WALL)) {
                if (!(hasCloudTiles && _getCloudTowerFast(nx, ny, pathOwner)) && !(canWalk && canWalk(nx, ny))) continue;
            }
            let nKey = ny * gridW + nx;
            if (visitedGen[nKey] === epoch) continue;
            let ng = cg + 1;
            if (gScoreGen[nKey] !== epoch || ng < gScoreVal[nKey]) {
                gScoreGen[nKey] = epoch;
                gScoreVal[nKey] = ng;
                astarFrom[nKey] = curKey;
                let distance = Math.abs(ex - nx) + Math.abs(ey - ny);
                let h = usePortalHeuristic ? (portalEntries ? _portalHeuristic(portalEntries, nx, ny, distance) : 0) : distance;
                let cross = Math.abs((nx - sx) * routeDy - (ny - sy) * routeDx);
                // Cached terrain clearance answers directly unless special
                // passability (walk profile or portals) must be checked live.
                let clearance = clearanceTiles[nKey];
                if (!clearance || (clearance !== 3 && (canWalk || hasCloudTiles))) clearance = _getPathClearance(nx, ny, canWalk, pathOwner, usePortalEdges);
                let clearancePenalty = (3 - clearance) * 0.125;
                _heapPush(ng + h + clearancePenalty + (distance * tieStride + cross) * tieScale, nKey);
            }
        }

        // Cloud portal teleport edges
        if (hasCloudTiles) {
            let cloud = _getCloudTowerFast(cx, cy, pathOwner);
            if (cloud) {
                let partner = getPairedCloudTower(cloud, pathOwner);
                if (partner) {
                    let nKey = partner.gy * gridW + partner.gx;
                    if (visitedGen[nKey] !== epoch) {
                        let ng = cg + 1;
                        if (gScoreGen[nKey] !== epoch || ng < gScoreVal[nKey]) {
                            gScoreGen[nKey] = epoch;
                            gScoreVal[nKey] = ng;
                            astarFrom[nKey] = curKey;
                            let distance = Math.abs(ex - partner.gx) + Math.abs(ey - partner.gy);
                            let cross = Math.abs((partner.gx - sx) * routeDy - (partner.gy - sy) * routeDx);
                            let clearancePenalty = (3 - _getPathClearance(partner.gx, partner.gy, canWalk, pathOwner, usePortalEdges)) * 0.125;
                            let ph = portalEntries ? _portalHeuristic(portalEntries, partner.gx, partner.gy, distance) : 0;
                            _heapPush(ng + ph + clearancePenalty + (distance * tieStride + cross) * tieScale, nKey);
                        }
                    }
                }
            }
        }
    }

    if (abortedByBudget && movementProfile && cacheKey) {
        let partialPath = [];
        let pk = partialResumeKey >= 0 ? partialResumeKey : (_astarHeapSz > 0 ? _astarHeapK[0] : -1);
        if (!(pk >= 0)) {
            // Fallback: at least keep current local start so next attempt can resume deterministically.
            partialPath = [{ x: sx, y: sy }];
        } else {
            let guard = 0;
            while (pk >= 0 && guard <= (GRID_W * GRID_H)) {
                guard++;
                partialPath.push({ x: pk % gridW, y: (pk / gridW) | 0 });
                if (pk === startKey) break;
                let parent = astarFrom[pk];
                if (!Number.isFinite(parent) || parent < 0 || parent === pk) break;
                pk = parent;
            }
            partialPath.reverse();
        }

        if (resumePrefixPath && resumePrefixPath.length > 0 && partialPath.length > 0) {
            let mergedPartial = resumePrefixPath.slice();
            for (let i = 1; i < partialPath.length; i++) mergedPartial.push(partialPath[i]);
            partialPath = mergedPartial;
        }

        if (partialPath.length > 1) {
            sharedPartialPathCache.set(cacheKey, { path: partialPath, tick: gameTime, version: pathTopologyVersion });
            _trimPathCacheIfNeeded(sharedPartialPathCache, PARTIAL_PATH_CACHE_MAX_ENTRIES);
        }
    }

    if (!abortedByBudget && allowClosestReachableFallback && bestReachableKey >= 0 && bestReachableKey !== startKey) {
        let bestEffortPath = [];
        let k = bestReachableKey;
        let guard = 0;
        while (k >= 0 && guard <= (GRID_W * GRID_H)) {
            guard++;
            bestEffortPath.push({ x: k % gridW, y: (k / gridW) | 0 });
            if (k === startKey) break;
            let parent = astarFrom[k];
            if (!Number.isFinite(parent) || parent < 0 || parent === k) break;
            k = parent;
        }
        bestEffortPath.reverse();

        if (resumePrefixPath && resumePrefixPath.length > 0 && bestEffortPath.length > 0) {
            let merged = resumePrefixPath.slice();
            for (let i = 1; i < bestEffortPath.length; i++) merged.push(bestEffortPath[i]);
            bestEffortPath = merged;
        }

        if (bestEffortPath.length > 1) {
            if (movementProfile) {
                sharedPathCache.set(cacheKey, { path: bestEffortPath, tick: gameTime, version: pathTopologyVersion });
                sharedPartialPathCache.delete(cacheKey);
                _trimPathCacheIfNeeded(sharedPathCache, PATH_CACHE_MAX_ENTRIES);
            }
            _recordPathfindCall(sourceTag, performance.now() - perfStart, false);
            return bestEffortPath;
        }
    }

    if (movementProfile && !abortedByBudget) {
        sharedPathCache.set(cacheKey, { path: null, tick: gameTime, version: pathTopologyVersion });
        sharedPartialPathCache.delete(cacheKey);
        _trimPathCacheIfNeeded(sharedPathCache, PATH_CACHE_MAX_ENTRIES);
    }
    _recordPathfindCall(sourceTag, performance.now() - perfStart, false);
    return null;
}

function findPathAStarTagged(sourceTag, sx, sy, ex, ey, ignoreWalls = false, canWalk = null, pathOwner = null, cacheProfileHint = null, allowClosestReachableFallback = true) {
    return _withPathfindContext(sourceTag, pathOwner, null, () => findPathAStar(sx, sy, ex, ey, ignoreWalls, canWalk, pathOwner, cacheProfileHint, allowClosestReachableFallback));
}

let _groupStartMarks = null;
let _groupBucketHead = null, _groupQueueKey = null, _groupQueueNext = null;

// ------------------------------------------------------------------
// Group routes: one reverse search from a shared destination serves every
// unit in a move/attack-move order, instead of one A* per unit.
// ------------------------------------------------------------------

// Returns one path per start ({x, y}), each running from its start to
// (ex, ey), or null where the shared search cannot answer (an unreachable
// start, an unwalkable target or an exhausted node budget); callers then fall
// back to the per-unit search. Paths are shortest, like findPathAStar, and
// pick among equal-length steps by clearance first, then by staying close to
// the unit's own straight line to the target, then by tile index. Each choice
// depends only on the grid, the starts and the target, so peers agree.
function findGroupPathsToTarget(starts, ex, ey, canWalk = null, pathOwner = null) {
    let perfStart = performance.now();
    let result = new Array(starts.length).fill(null);
    let gridW = GRID_W, gridH = GRID_H, gridData = grid;
    if (!(starts.length > 0) || !(ex >= 0 && ey >= 0 && ex < gridW && ey < gridH)) return result;
    let usePortalEdges = pathOwner !== null;
    if (usePortalEdges && _cloudTileCacheVer !== pathTopologyVersion) _rebuildCloudTileCache();
    let cloudsExist = usePortalEdges && !!(_cloudTileCache && _cloudTileCache.size);
    let walkable = (x, y) => gridData[y][x].type !== TYPE_WALL
        || (cloudsExist && !!_getCloudTowerFast(x, y, pathOwner)) || !!(canWalk && canWalk(x, y));
    if (!walkable(ex, ey)) return result;

    let bufSize = gridW * gridH;
    _ensurePathClearanceCache();
    _ensureAstarBuffers(bufSize);
    if (++_astarEpoch > 2000000000) {
        _astarEpoch = 1;
        _astarVisitedGen.fill(0);
        _astarGScoreGen.fill(0);
    }
    let epoch = _astarEpoch;
    let settled = _astarVisitedGen, gGen = _astarGScoreGen, gVal = _astarGScoreVal;

    // Starts are the targets of the reverse search. A consistent heuristic
    // (distance to their bounding box) keeps it to a corridor plus that box.
    // Start tiles are marked in a scratch array: 1 = pending, 2 = reached.
    if (!_groupStartMarks || _groupStartMarks.length < bufSize) _groupStartMarks = new Uint8Array(bufSize);
    let startMarks = _groupStartMarks;
    let startKeys = [];
    let minX = gridW, minY = gridH, maxX = -1, maxY = -1;
    for (let s of starts) {
        if (!(s.x >= 0 && s.y >= 0 && s.x < gridW && s.y < gridH)) continue;
        let key = s.y * gridW + s.x;
        if (startMarks[key]) continue;
        startMarks[key] = 1;
        startKeys.push(key);
        if (s.x < minX) minX = s.x;
        if (s.x > maxX) maxX = s.x;
        if (s.y < minY) minY = s.y;
        if (s.y > maxY) maxY = s.y;
    }
    let clearStartMarks = () => { for (let key of startKeys) startMarks[key] = 0; };
    if (startKeys.length === 0) return result;
    // Live portals break the heuristic's consistency, as in findPathAStar.
    let noHeuristic = usePortalEdges && _hasUsablePathPortal(pathOwner);

    let budgetOwner = Number.isFinite(pathOwner) ? pathOwner : _activePathfindOwner;
    let budgetArr = astarNodeBudgetRemainingByPlayer;
    let fastBudget = (budgetOwner | 0) === budgetOwner && budgetOwner >= 0 && budgetOwner < budgetArr.length
        && typeof players !== 'undefined' && budgetOwner < players.length;
    let endKey = ey * gridW + ex;
    gGen[endKey] = epoch;
    gVal[endKey] = 0;
    // Bucket queue: every edge costs 1 and the heuristic is consistent, so
    // priorities popped never decrease. Nodes with equal priority may settle
    // in any order; the settled set and every distance are the same.
    let maxPriority = 2 * (gridW + gridH) + bufSize;
    if (!_groupBucketHead || _groupBucketHead.length < maxPriority + 1) _groupBucketHead = new Int32Array(maxPriority + 1);
    if (!_groupQueueKey || _groupQueueKey.length < 4 * bufSize + 16) {
        _groupQueueKey = new Int32Array(4 * bufSize + 16);
        _groupQueueNext = new Int32Array(4 * bufSize + 16);
    }
    let bucketHead = _groupBucketHead, queueKey = _groupQueueKey, queueNext = _groupQueueNext;
    bucketHead.fill(-1, 0, maxPriority + 1);
    let queueSize = 0, current = 0;
    let push = (priority, key) => {
        if (queueSize >= queueKey.length || priority > maxPriority) return false;
        queueKey[queueSize] = key;
        queueNext[queueSize] = bucketHead[priority];
        bucketHead[priority] = queueSize++;
        return true;
    };
    push(noHeuristic ? 0 : ((ex < minX ? minX - ex : (ex > maxX ? ex - maxX : 0)) + (ey < minY ? minY - ey : (ey > maxY ? ey - maxY : 0))), endKey);
    let remaining = startKeys.length;
    let searchClouds = cloudsExist;
    let bound = Infinity;
    let iterations = 0;
    let wallType = TYPE_WALL;
    while (true) {
        while (current <= maxPriority && bucketHead[current] < 0) current++;
        // Settle every node that can lie on a shortest route of the last start.
        if (current > maxPriority || current > bound) break;
        let entry = bucketHead[current];
        bucketHead[current] = queueNext[entry];
        let curKey = queueKey[entry];
        if (settled[curKey] === epoch) continue;
        settled[curKey] = epoch;
        let cx = curKey % gridW, cy = (curKey / gridW) | 0;
        let cg = gVal[curKey];
        let mark = startMarks[curKey];
        if (mark === 1) {
            startMarks[curKey] = 2;
            if (--remaining === 0) bound = cg;
        }
        // Stepping into a tile requires that tile to be walkable.
        if (gridData[cy][cx].type === wallType && !walkable(cx, cy)) continue;
        let budgetOk = fastBudget
            ? (budgetArr[budgetOwner] >= 1 ? (budgetArr[budgetOwner]--, true) : false)
            : _tryConsumeAstarNodeBudget(budgetOwner, 1);
        if (++iterations > bufSize || !budgetOk) {
            _lastPathfindAbortedByBudget = true;
            clearStartMarks();
            _recordPathfindCall('player_commands', performance.now() - perfStart, false);
            return result;
        }
        let ng = cg + 1;
        for (let di = 0; di < 8; di += 2) {
            let nx = cx + _ASTAR_DIRS[di], ny = cy + _ASTAR_DIRS[di + 1];
            if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
            let nKey = ny * gridW + nx;
            if (settled[nKey] === epoch) continue;
            if (gGen[nKey] === epoch && gVal[nKey] <= ng) continue;
            // A unit may stand on an unwalkable tile; it is only ever left.
            if (gridData[ny][nx].type === wallType && !startMarks[nKey] && !walkable(nx, ny)) continue;
            gGen[nKey] = epoch;
            gVal[nKey] = ng;
            push(noHeuristic ? ng : ng + (nx < minX ? minX - nx : (nx > maxX ? nx - maxX : 0)) + (ny < minY ? minY - ny : (ny > maxY ? ny - maxY : 0)), nKey);
        }
        if (searchClouds) {
            let cloud = _getCloudTowerFast(cx, cy, pathOwner);
            let partner = cloud ? getPairedCloudTower(cloud, pathOwner) : null;
            if (partner) {
                let nKey = partner.gy * gridW + partner.gx;
                if (settled[nKey] !== epoch && !(gGen[nKey] === epoch && gVal[nKey] <= ng)
                    && (startMarks[nKey] || walkable(partner.gx, partner.gy))) {
                    gGen[nKey] = epoch;
                    gVal[nKey] = ng;
                    let px = partner.gx, py = partner.gy;
                    push(noHeuristic ? ng : ng + (px < minX ? minX - px : (px > maxX ? px - maxX : 0)) + (py < minY ? minY - py : (py > maxY ? py - maxY : 0)), nKey);
                }
            }
        }
    }
    clearStartMarks();

    // Walk each start downhill. Paths share node objects per tile.
    let hasClouds = usePortalEdges && !!(_cloudTileCache && _cloudTileCache.size);
    let stepKeys = [0, 0, 0, 0, 0];
    let nodes = new Map();
    let nodeAt = key => {
        let node = nodes.get(key);
        if (!node) nodes.set(key, node = { x: key % gridW, y: (key / gridW) | 0 });
        return node;
    };
    let byStart = new Map();
    for (let i = 0; i < starts.length; i++) {
        let s = starts[i];
        if (!(s.x >= 0 && s.y >= 0 && s.x < gridW && s.y < gridH)) continue;
        let startKey = s.y * gridW + s.x;
        if (byStart.has(startKey)) { result[i] = byStart.get(startKey); continue; }
        let path = null;
        if (settled[startKey] === epoch) {
            path = [nodeAt(startKey)];
            let routeDx = ex - s.x, routeDy = ey - s.y;
            let cur = startKey;
            while (cur !== endKey) {
                let cx = cur % gridW, cy = (cur / gridW) | 0, want = gVal[cur] - 1;
                let count = 0;
                let consider = (nKey, nx, ny) => {
                    if (settled[nKey] !== epoch || gVal[nKey] !== want || !walkable(nx, ny)) return;
                    stepKeys[count++] = nKey;
                };
                for (let di = 0; di < 8; di += 2) {
                    let nx = cx + _ASTAR_DIRS[di], ny = cy + _ASTAR_DIRS[di + 1];
                    if (nx >= 0 && nx < gridW && ny >= 0 && ny < gridH) consider(ny * gridW + nx, nx, ny);
                }
                if (hasClouds) {
                    let cloud = _getCloudTowerFast(cx, cy, pathOwner);
                    let partner = cloud ? getPairedCloudTower(cloud, pathOwner) : null;
                    if (partner) consider(partner.gy * gridW + partner.gx, partner.gx, partner.gy);
                }
                // Most steps have one candidate; rank only real choices.
                let best = count > 0 ? stepKeys[0] : -1;
                if (count > 1) {
                    let bestClear = -1, bestCross = 0;
                    best = -1;
                    for (let c = 0; c < count; c++) {
                        let nKey = stepKeys[c], nx = nKey % gridW, ny = (nKey / gridW) | 0;
                        let clear = _getPathClearance(nx, ny, canWalk, pathOwner, usePortalEdges);
                        let cross = Math.abs((nx - s.x) * routeDy - (ny - s.y) * routeDx);
                        if (best < 0 || clear > bestClear || (clear === bestClear && (cross < bestCross || (cross === bestCross && nKey < best)))) {
                            best = nKey; bestClear = clear; bestCross = cross;
                        }
                    }
                }
                if (best < 0 || path.length > bufSize) { path = null; break; }
                path.push(nodeAt(best));
                cur = best;
            }
        }
        byStart.set(startKey, path);
        result[i] = path;
    }
    _recordPathfindCall('player_commands', performance.now() - perfStart, false);
    return result;
}

// ---- Group routes: shared reverse searches that run over several ticks ----
// A move order for a large army is answered by one reverse search from the
// destination (the flow of findGroupPathsToTarget), but one that keeps its
// state between ticks: each tick it expands at most its share of the
// owner's search budget, and the members whose tiles it has reached get
// their paths (walked downhill from the distances, shared per start tile).
// A search too big for one tick's budget therefore finishes a few ticks
// later instead of failing every tick. Routes are caches (every peer drops
// them at a resync, resetGroupRoutes); at most FLOW_MAX live, 5 bytes per
// map tile each.
const GROUP_ROUTE_NODES_PER_TICK = 60000;
// Nodes all routes together expand per tick (a big order starts many at
// once; each route gets a share, members near their destination first).
// A route always gets at least GROUP_ROUTE_NODES_MIN.
const GROUP_ROUTE_NODES_TICK = 60000, GROUP_ROUTE_NODES_MIN = 1500;
let _groupRouteNodesTick = -1, _groupRouteNodesLeft = 0;
function _groupRouteNodeBudget(share) {
    if (_groupRouteNodesTick !== gameTime) { _groupRouteNodesTick = gameTime; _groupRouteNodesLeft = GROUP_ROUTE_NODES_TICK; }
    return Math.max(GROUP_ROUTE_NODES_MIN, Math.min(GROUP_ROUTE_NODES_PER_TICK, share, _groupRouteNodesLeft));
}
function _groupRouteAdvance(route, source, share) {
    const before = route.expandedTotal;
    _withPathfindContext(source, route.owner, null, () => route.advance(_groupRouteNodeBudget(share)));
    _groupRouteNodesLeft -= route.expandedTotal - before;
}
// Start tiles turned into paths per tick, over all routes (walking a long
// route downhill for thousands of tiles at once would stall a tick).
const GROUP_ROUTE_PATHS_PER_TICK = 400;
let _groupRoutes = new Map(), _groupRouteSeq = 0;
const _groupRouteStepKeys = new Int32Array(8);
let _groupRoutePathTick = -1, _groupRoutePathsLeft = 0;

// Flying units' routes: over the air walkability (AIR_CAN_WALK) and the
// portals, so buildings other than portals never change them: an air flow
// stays valid until the portals change (_cloudSignature). Today every tile
// is open to flyers (a void or border tile would close it: _airWallTable).
const AIR_CAN_WALK = Object.assign(() => true, { _pathProfileKey: 'air', _air: true });
let _airWall = null, _cloudSig = 0, _cloudSigVer = -1;
// The portals as they are (cloud towers: tile, owner, pair, usable).
function _cloudSignature() {
    if (_cloudTileCacheVer !== pathTopologyVersion) _rebuildCloudTileCache();
    if (_cloudSigVer === _cloudTileCacheVer) return _cloudSig;
    let h = 2166136261 | 0;
    for (const [k, t] of _cloudTileCache) {
        h = Math.imul(h ^ k, 16777619); h = Math.imul(h ^ (t.owner | 0), 16777619);
        h = Math.imul(h ^ ((t.baseStats && t.baseStats.pairId) | 0), 16777619);
        h = Math.imul(h ^ (t.energy > 0 && !t.underConstruction ? 1 : 0), 16777619);
    }
    _cloudSig = h; _cloudSigVer = _cloudTileCacheVer;
    return h;
}
function _airWallTable() {
    if (!_airWall || _airWall.length !== GRID_W * GRID_H) {
        _airWall = simSharedArray(Uint8Array, GRID_W * GRID_H);
        if (typeof simParallelBind === 'function') simParallelBind('mv.airwall', _airWall);
    }
    return _airWall;
}

// Routes keep off walls: stepping onto a tile costs 1, plus 2 next to a
// wall and 1 two tiles from one (see stepCostTable), so flows run down the
// middle of corridors and hug walls only where there is no other way.
let _stepCost = null, _stepCostWall = null;
function stepCostTable(wall) {
    if (!_stepCost || _stepCost.length !== wall.length) { _stepCost = new Uint8Array(wall.length); _stepCostWall = wall; }
    return _stepCost;
}
// A tile's step cost (0 in the table: not yet known).
function _stepCostAt(table, wall, t) {
    let c = table[t];
    if (c) return c;
    const W = GRID_W, H = GRID_H, x = t % W, y = (t - x) / W;
    c = 1;
    ring: for (let r = 1; r <= 2; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || wall[ny * W + nx]) { c = r === 1 ? 3 : 2; break ring; }
    }
    table[t] = c;
    return c;
}
// The walls changed at a tile: the costs around it are worked out again.
function stepCostsChanged(gx, gy) {
    if (!_stepCost) return;
    for (let y = gy - 2; y <= gy + 2; y++) for (let x = gx - 2; x <= gx + 2; x++) if (x >= 0 && y >= 0 && x < GRID_W && y < GRID_H) _stepCost[y * GRID_W + x] = 0;
}
function stepCostsReset() { if (_stepCost) _stepCost.fill(0); }

function _groupRouteProfile(canWalk) {
    if (!canWalk) return 'plain';
    return canWalk._pathProfileKey || null;
}

function _groupRouteKey(owner, ex, ey, canWalk) {
    let profile = _groupRouteProfile(canWalk);
    return profile === null ? null : owner + '|' + profile + '|' + (ey * GRID_W + ex);
}

// Start tiles this tick may still turn into paths.
function _groupRouteTakePathQuota() {
    if (_groupRoutePathTick !== gameTime) { _groupRoutePathTick = gameTime; _groupRoutePathsLeft = GROUP_ROUTE_PATHS_PER_TICK; }
    if (_groupRoutePathsLeft <= 0) return false;
    _groupRoutePathsLeft--;
    return true;
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
const FLOW_MAX = 32;
let _flowSlots = new Array(FLOW_MAX).fill(null);
let _flowGen = null, _flowUsed = null, _flowG = [], _flowF = [];
function _flowTables() {
    if (!_flowGen) {
        _flowGen = simSharedArray(Int32Array, FLOW_MAX); _flowUsed = simSharedArray(Int32Array, FLOW_MAX);
        simParallelBind('flow.gen', _flowGen); simParallelBind('flow.used', _flowUsed);
    }
}
function _flowBind() {
    _flowG = _flowSlots.map(r => r ? r.g : null); _flowF = _flowSlots.map(r => r ? r.flags : null);
    simParallelBind('flow.g', _flowG); simParallelBind('flow.f', _flowF);
}
function _flowRelease(fid) {
    const r = _flowSlots[fid];
    if (!r) return;
    r.fid = -1;
    if (_groupRoutes.get(r.key) === r) _groupRoutes.delete(r.key);
    _flowSlots[fid] = null;
    _flowGen[fid]++;
}
// A slot for a new route: a free one, else the least recently used (by
// orders and by the kernel's followers; ties: the lowest slot).
function _flowAssign(route) {
    _flowTables();
    let fid = _flowSlots.indexOf(null);
    if (fid < 0) {
        let best = Infinity;
        for (let i = 0; i < FLOW_MAX; i++) {
            const r = _flowSlots[i], used = Math.max(r.lastUsed, _flowUsed[i]);
            if (used < best) { best = used; fid = i; }
        }
        _flowRelease(fid);
    }
    _flowSlots[fid] = route; route.fid = fid; route.gen = ++_flowGen[fid]; _flowUsed[fid] = gameTime;
    _flowBind();
}
function resetGroupRoutes() {
    _flowTables();
    for (let i = 0; i < FLOW_MAX; i++) _flowRelease(i);
    _groupRoutes = new Map();
    _flowBind();
}
function flowRouteById(fid) { return fid >= 0 && fid < FLOW_MAX ? _flowSlots[fid] : null; }

function getGroupRoute(owner, ex, ey, canWalk, starts) {
    let key = _groupRouteKey(owner, ex, ey, canWalk);
    if (key === null) return null;
    let route = _groupRoutes.get(key);
    if (route && (route.air ? route.cloudSig !== _cloudSignature() : route.version !== pathTopologyVersion)) {
        // Built before the walls changed: new requests get a fresh one.
        _groupRoutes.delete(key);
        route = null;
    }
    if (!route) {
        route = new GroupRoute(key, owner, ex, ey, canWalk, starts);
        _flowAssign(route);
        _groupRoutes.set(key, route);
    }
    route.lastUsed = gameTime;
    return route;
}

// Walls per tile from the grid (for callers without the movement kernel's
// table: sandboxed tests).
function _gridWallTable() {
    const t = new Uint8Array(GRID_W * GRID_H);
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) t[y * GRID_W + x] = grid[y][x].type === TYPE_WALL ? 1 : 0;
    return t;
}

class GroupRoute {
    constructor(key, owner, ex, ey, canWalk, starts) {
        this.key = key; this.seq = ++_groupRouteSeq; this.lastUsed = gameTime;
        this.owner = owner; this.ex = ex; this.ey = ey; this.canWalk = canWalk;
        let n = GRID_W * GRID_H;
        this.w = GRID_W; this.h = GRID_H;
        this.version = pathTopologyVersion; this.fid = -1; this.gen = 0;
        this.g = simSharedArray(Int32Array, n).fill(-1);
        // Per tile: bit 0 settled, bit 1 start tile (may be left though blocked).
        this.flags = simSharedArray(Uint8Array, n);
        this.pendingCount = 0;              // start tiles not settled yet (flag bit 1 set, bit 0 not)
        this.segments = new Map();           // start tile -> its first segment (shared by units there)
        this.paths = new Map();              // start tile -> path (null: none)
        this.heap = new Float64Array(1024); this.heapSize = 0;
        this.bound = Infinity;               // settle up to this priority once every start is reached
        this.exhausted = false;              // nothing left to expand
        this.expandedTotal = 0;
        // Heuristic: distance to the starts' bounding box, fixed at creation
        // (consistent for any start, so later starts stay exact).
        let minX = GRID_W, minY = GRID_H, maxX = -1, maxY = -1;
        for (let s of starts) {
            if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
            if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
        }
        this.bx0 = minX; this.by0 = minY; this.bx1 = maxX; this.by1 = maxY;
        this.air = !!(canWalk && canWalk._air);
        this.cloudSig = this.air ? _cloudSignature() : 0;
        this.usePortals = owner !== null;
        this.noHeuristic = false;
        // Live portals: the portal-aware bound to the starts' box.
        this.portalEntries = this.usePortals && _hasUsablePathPortal(owner)
            ? _portalHeuristicEntries(owner, (x, y) => this._boxH(x, y)) : null;
        let endKey = ey * GRID_W + ex;
        this.endKey = endKey;
        this.g[endKey] = 0;
        this._push(this._h(ex, ey), endKey);
        this.addStarts(starts);
    }

    _boxH(x, y) {
        if (this.bx1 < 0) return 0;
        return (x < this.bx0 ? this.bx0 - x : (x > this.bx1 ? x - this.bx1 : 0)) + (y < this.by0 ? this.by0 - y : (y > this.by1 ? y - this.by1 : 0));
    }
    _h(x, y) {
        let h = this._boxH(x, y);
        return this.portalEntries ? _portalHeuristic(this.portalEntries, x, y, h) : h;
    }

    // Min-heap of priority * 2^21 + tile (tiles below 2^21: maps up to 1448^2).
    _push(priority, key) {
        if (this.heapSize >= this.heap.length) { let grown = new Float64Array(this.heap.length * 2); grown.set(this.heap); this.heap = grown; }
        let h = this.heap, i = this.heapSize++, v = priority * 2097152 + key;
        while (i > 0) { let p = (i - 1) >> 1; if (h[p] <= v) break; h[i] = h[p]; i = p; }
        h[i] = v;
    }
    _pop() {
        let h = this.heap, top = h[0], last = h[--this.heapSize], n = this.heapSize, i = 0;
        while (true) {
            let l = 2 * i + 1;
            if (l >= n) break;
            let r = l + 1, c = (r < n && h[r] < h[l]) ? r : l;
            if (h[c] >= last) break;
            h[i] = h[c]; i = c;
        }
        if (n > 0) h[i] = last;
        return top;
    }

    addStarts(starts) {
        for (let s of starts) {
            if (!(s.x >= 0 && s.y >= 0 && s.x < this.w && s.y < this.h)) continue;
            let k = s.y * this.w + s.x;
            const f = this.flags[k];
            if (f & 2) continue;
            this.flags[k] = f | 2;
            if (!(f & 1)) { this.pendingCount++; this.bound = Infinity; }
        }
    }

    _walkable(x, y) {
        if (this.air) return false;
        return grid[y][x].type !== TYPE_WALL
            || (this.usePortals && _cloudTileCache && _cloudTileCache.size > 0 && !!_getCloudTowerFast(x, y, this.owner))
            || !!(this.canWalk && this.canWalk(x, y));
    }

    // Expands up to `maxNodes` nodes within the owner's budget. Returns false
    // when the budget ran out before the reached starts were done.
    advance(maxNodes) {
        if (this.exhausted || (this.pendingCount === 0 && this.heapSize === 0)) return true;
        let W = this.w, H = this.h, g = this.g, flags = this.flags;
        let owner = this.owner;
        // Walls from the per-tile table (see simMoveTileTypeChanged), not
        // the grid's cell objects (a cache miss per node on large maps).
        const wall = this.air ? _airWallTable() : (typeof simMoveWallGrid === 'function' ? simMoveWallGrid() : _gridWallTable());
        const costs = this.air ? null : stepCostTable(wall);
        if (this.usePortals && _cloudTileCacheVer !== pathTopologyVersion) _rebuildCloudTileCache();
        let searchClouds = this.usePortals && !!(_cloudTileCache && _cloudTileCache.size);
        let budgetArr = astarNodeBudgetRemainingByPlayer;
        let fastBudget = (owner | 0) === owner && owner >= 0 && owner < budgetArr.length && owner < players.length;
        let expanded = 0;
        while (this.heapSize > 0) {
            let top = this.heap[0];
            let priority = Math.floor(top / 2097152);
            if (this.pendingCount === 0 && priority > this.bound) return true;
            if (expanded >= maxNodes) return false;
            let budgetOk = fastBudget ? (budgetArr[owner] >= 1 ? (budgetArr[owner]--, true) : false) : _tryConsumeAstarNodeBudget(owner, 1);
            if (!budgetOk) { _lastPathfindAbortedByBudget = true; return false; }
            this._pop();
            let cur = top - priority * 2097152;
            if (flags[cur] & 1) continue;
            expanded++; this.expandedTotal++;
            flags[cur] |= 1;
            let cx = cur % W, cy = (cur / W) | 0, cg = g[cur];
            if ((flags[cur] & 2) && --this.pendingCount === 0) this.bound = priority;
            // Stepping into a tile requires that tile to be walkable.
            if (wall[cur] && !this._walkable(cx, cy)) continue;
            // (Entering cur costs its step cost; flyers pay 1.)
            let ng = cg + (costs ? _stepCostAt(costs, wall, cur) : 1);
            for (let di = 0; di < 8; di += 2) {
                let nx = cx + _ASTAR_DIRS[di], ny = cy + _ASTAR_DIRS[di + 1];
                if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                let nKey = ny * W + nx;
                if ((flags[nKey] & 1) || (g[nKey] >= 0 && g[nKey] <= ng)) continue;
                // A unit may stand on an unwalkable tile; it is only ever left.
                if (wall[nKey] && !(flags[nKey] & 2) && !this._walkable(nx, ny)) continue;
                g[nKey] = ng;
                this._push(this.noHeuristic ? ng : ng + this._h(nx, ny), nKey);
            }
            if (searchClouds) {
                let cloud = _getCloudTowerFast(cx, cy, owner);
                let partner = cloud ? getPairedCloudTower(cloud, owner) : null;
                if (partner) {
                    let nKey = partner.gy * W + partner.gx;
                    if (!(flags[nKey] & 1) && !(g[nKey] >= 0 && g[nKey] <= ng) && ((flags[nKey] & 2) || this._walkable(partner.gx, partner.gy))) {
                        g[nKey] = ng;
                        this._push(this.noHeuristic ? ng : ng + this._h(partner.gx, partner.gy), nKey);
                    }
                }
            }
        }
        this.exhausted = true;
        return true;
    }

    // Whether the path from this start tile is known (the tile is settled:
    // its whole downhill chain was settled before it) or can never be
    // (search exhausted).
    ready(startKey) { return this.exhausted || (this.flags[startKey] & 1) === 1; }

    // The path from a start tile (walked downhill, nodes shared per tile),
    // null when unreachable. Built once per start tile.
    pathFrom(sx, sy) {
        let W = this.w, startKey = sy * W + sx;
        if (this.paths.has(startKey)) return this.paths.get(startKey);
        let path = this._walk(sx, sy, Infinity);
        this.paths.set(startKey, path);
        return path;
    }

    // The first `maxLen` nodes downhill from a tile (the whole rest when it
    // is closer), null when the tile is not settled.
    segmentFrom(sx, sy, maxLen) {
        // Units on the same tile share it (paths are never modified).
        if (maxLen !== GROUP_ROUTE_SEGMENT) return this._walk(sx, sy, maxLen);
        const key = sy * this.w + sx;
        let seg = this.segments.get(key);
        if (seg === undefined) { seg = this._walk(sx, sy, maxLen); if (seg) this.segments.set(key, seg); }
        return seg;
    }

    _walk(sx, sy, maxLen) {
        _ensurePathClearanceCache();
        let W = this.w, H = this.h, startKey = sy * W + sx;
        let g = this.g, flags = this.flags, owner = this.owner, canWalk = this.canWalk;
        let hasClouds = this.usePortals && !!(_cloudTileCache && _cloudTileCache.size);
        let nodes = this.nodes || (this.nodes = new Map());
        if (!(flags[startKey] & 1)) return null;
        let node = nodes.get(startKey);
        if (!node) nodes.set(startKey, node = { x: sx, y: sy });
        let path = [node];
        let routeDx = this.ex - sx, routeDy = this.ey - sy;
        let cur = startKey, stepKeys = _groupRouteStepKeys, limit = W * H, wall = this.air ? _airWallTable() : (typeof simMoveWallGrid === 'function' ? simMoveWallGrid() : _gridWallTable());
        while (cur !== this.endKey) {
            let cx = cur % W, cy = (cur / W) | 0, want = g[cur] - 1;
            // The lowest distance among the settled neighbours below this
            // tile's (steps cost more near walls, so not always one less).
            for (let di = 0; di < 8; di += 2) {
                let nx = cx + _ASTAR_DIRS[di], ny = cy + _ASTAR_DIRS[di + 1];
                if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                let nKey = ny * W + nx;
                if ((flags[nKey] & 1) && g[nKey] >= 0 && g[nKey] < want) want = g[nKey];
            }
            let count = 0;
            // Settled neighbours at that distance that can be stepped on.
            for (let di = 0; di < 8; di += 2) {
                let nx = cx + _ASTAR_DIRS[di], ny = cy + _ASTAR_DIRS[di + 1];
                if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                let nKey = ny * W + nx;
                if (!(flags[nKey] & 1) || g[nKey] !== want) continue;
                if (wall[nKey] && !this._walkable(nx, ny)) continue;
                stepKeys[count++] = nKey;
            }
            if (hasClouds) {
                let cloud = _getCloudTowerFast(cx, cy, owner);
                let partner = cloud ? getPairedCloudTower(cloud, owner) : null;
                if (partner) {
                    let nKey = partner.gy * W + partner.gx;
                    if ((flags[nKey] & 1) && g[nKey] === g[cur] - 1 && this._walkable(partner.gx, partner.gy)) stepKeys[count++] = nKey;
                }
            }
            // Most steps have one candidate; rank only real choices.
            let best = count > 0 ? stepKeys[0] : -1;
            if (count > 1) {
                let bestClear = -1, bestCross = 0;
                best = -1;
                for (let c = 0; c < count; c++) {
                    let nKey = stepKeys[c], nx = nKey % W, ny = (nKey / W) | 0;
                    let clear = _getPathClearance(nx, ny, canWalk, owner, this.usePortals);
                    let cross = Math.abs((nx - sx) * routeDy - (ny - sy) * routeDx);
                    if (best < 0 || clear > bestClear || (clear === bestClear && (cross < bestCross || (cross === bestCross && nKey < best)))) {
                        best = nKey; bestClear = clear; bestCross = cross;
                    }
                }
            }
            if (best < 0 || path.length > limit) return null;
            let next = nodes.get(best);
            if (!next) nodes.set(best, next = { x: best % W, y: (best / W) | 0 });
            path.push(next);
            cur = best;
            if (path.length >= maxLen) break;
        }
        return path;
    }
}

// A unit's destination tile as the interface shows it ({x, y} or null): its
// path's end, or its flow's destination. O(1): for markers drawn per frame.
function unitDisplayDest(u) {
    let p = u && u.path;
    if (p && p.length) return p[p.length - 1];
    if (u && u._routeKey && u._routeEnd >= 0) return { x: u._routeEnd % GRID_W, y: (u._routeEnd / GRID_W) | 0 };
    return null;
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
    let route = _groupRoutes.get(u._routeKey);
    if (!route) return p;
    let c = _displayPaths.get(u);
    if (c && c.tick === gameTime) return c.path;
    let gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE), seg = null;
    if (gx >= 0 && gy >= 0 && gx < route.w && gy < route.h) seg = route._walk(gx, gy, UNIT_DISPLAY_PATH);
    if (seg && seg.length) {
        let last = seg[seg.length - 1];
        if (last.y * route.w + last.x !== route.endKey) seg = seg.concat([{ x: route.ex, y: route.ey }]);
    } else seg = [{ x: route.ex, y: route.ey }];
    _displayPaths.set(u, { tick: gameTime, path: seg });
    return seg;
}

// Units following a route in segments (see routeGroupMembers) keep, as
// snapshotted numbers, the route (u._routeKey), its end tile (u._routeEnd)
// and the last tile of their current segment (u._routeSegEnd): a unit whose
// path still ends there when it runs out continues on the route. Routes are
// caches dropped on every peer together (topology changes, resyncs); a unit
// whose route is gone asks for a path to its end again.
const GROUP_ROUTE_SEGMENT = 24;
function _giveRouteSegment(u, route, gx, gy) {
    let seg = route.segmentFrom(gx, gy, GROUP_ROUTE_SEGMENT);
    if (!seg || seg.length === 0) return null;
    let last = seg[seg.length - 1];
    u._routeKey = route.key; u._routeEnd = route.endKey; u._routeSegEnd = last.y * route.w + last.x;
    return seg;
}

// Called when a unit's path ran out: true when it goes on (a next segment,
// or a fresh request for the rest of its way); false when it arrived or was
// not on a route.
function continueUnitRoute(u, cmd) {
    let key = u._routeKey;
    if (!key) return false;
    let path = u.path, last = path && path.length ? path[path.length - 1] : null;
    let endKey = u._routeEnd;
    // On the flow navigation: the next stretch of the way from here.
    if (key === NAV_ROUTE_KEY) {
        let gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE);
        u._routeKey = null;
        if (gy * GRID_W + gx === endKey || (last && last.y * GRID_W + last.x === endKey)) return false;
        // One nav node on to the end (O(1) a tick), from the route's ready tick.
        let profile = navProfileOf(u), ex = endKey % GRID_W, ey = (endKey - ex) / GRID_W;
        navFieldRequest(profile, endKey, true);
        u.path = [{ x: ex, y: ey, nav: profile + 1, w: 1, ready: u._navReady | 0 }]; u.pathIndex = 0;
        u._routeKey = NAV_ROUTE_KEY; u._routeSegEnd = endKey;
        return true;
    }
    // Following a flow in the kernel (no path yet): a segment from here.
    if (!last && u._routeSegEnd === -1) {
        let gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE);
        if (gy * GRID_W + gx === endKey) { u._routeKey = null; return false; }
        let route = _groupRoutes.get(key) || null;
        if (route && gx >= 0 && gy >= 0 && gx < route.w && gy < route.h && (route.flags[gy * route.w + gx] & 1)) {
            route.lastUsed = gameTime;
            let seg = _giveRouteSegment(u, route, gx, gy);
            if (seg && seg.length > 1) {
                u.path = seg;
                u.pathIndex = (seg[0].x === gx && seg[0].y === gy) ? 1 : 0;
                return true;
            }
        }
        u._routeKey = null;
        _makeFallbackPathForUnit(u, gx, gy, endKey % GRID_W, (endKey / GRID_W) | 0, cmd, 'player_commands');
        if (route && !route.exhausted) u._awaitGroupPath = gameTime + 20;
        return true;
    }
    if (!last || last.y * GRID_W + last.x !== u._routeSegEnd) { u._routeKey = null; return false; }
    u._routeKey = null;
    if (last.y * GRID_W + last.x === endKey) return false;
    let gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE);
    let route = _groupRoutes.get(key) || null;
    if (route && gx >= 0 && gy >= 0 && gx < route.w && gy < route.h && route.ready(gy * route.w + gx)) {
        route.lastUsed = gameTime;
        let seg = _giveRouteSegment(u, route, gx, gy);
        if (seg && seg.length > 1) {
            u.path = seg;
            u.pathIndex = (seg[0].x === gx && seg[0].y === gy) ? 1 : 0;
            return true;
        }
    }
    // The route is gone (or does not cover this tile): the rest of the way
    // is requested like any deferred move.
    _makeFallbackPathForUnit(u, gx, gy, endKey % GRID_W, (endKey / GRID_W) | 0, cmd, 'player_commands');
    return true;
}

// Every live route still short of its starts advances within this tick's
// share of its owner's budget (tick start, before any other search).
function advanceGroupRoutes() {
    if (_groupRoutes.size === 0) return;
    const active = [..._groupRoutes.values()].filter(r => !r.exhausted && r.pendingCount > 0 && r.advancedTick !== gameTime).sort((a, b) => a.seq - b.seq);
    // Equal shares of the tick's nodes (what one leaves goes to the next).
    for (let i = 0; i < active.length; i++) {
        const route = active[i];
        route.advancedTick = gameTime;
        if (_groupRouteNodesTick !== gameTime) _groupRouteNodeBudget(0);
        _groupRouteAdvance(route, 'deferred_resolver', Math.floor(_groupRouteNodesLeft / (active.length - i)));
    }
}

// Routes the members (each {u, ugx, ugy}) toward (ex, ey) through the
// shared route: advances it within this tick's budget, then gives every
// member whose tile it has reached its path (within the tick's quota of new
// start tiles). Returns the paths by member index: a path, null (can never
// be reached: route it alone), or undefined (not known yet: keep waiting).
function routeGroupMembers(owner, ex, ey, canWalk, members) {
    let starts = members.map(m => ({ x: m.ugx, y: m.ugy }));
    let route = getGroupRoute(owner, ex, ey, canWalk, starts);
    let out = new Array(members.length);
    if (!route) return out;
    _ensurePathClearanceCache();
    route.addStarts(starts);
    let perfStart = performance.now();
    // Once per tick per route (advanceGroupRoutes may have done it already).
    if (route.advancedTick !== gameTime) {
        route.advancedTick = gameTime;
        _groupRouteAdvance(route, 'player_commands', GROUP_ROUTE_NODES_TICK / 8);
    }
    _recordPathfindCall('player_commands', performance.now() - perfStart, false);
    for (let i = 0; i < members.length; i++) {
        let m = members[i];
        if (!(m.ugx >= 0 && m.ugy >= 0 && m.ugx < route.w && m.ugy < route.h)) { out[i] = null; continue; }
        let key = m.ugy * route.w + m.ugx;
        if (!route.ready(key)) continue;
        // Combat units follow the route in short segments (cheap, any
        // number at once); workers, whose AI treats a path's end as their
        // arrival, get the whole path (a few start tiles per tick).
        if (!m.u.workerState) {
            if (!(route.flags[key] & 1)) { out[i] = null; continue; }
            out[i] = _giveRouteSegment(m.u, route, m.ugx, m.ugy);
            continue;
        }
        if (!route.paths.has(key) && !_groupRouteTakePathQuota()) continue;
        out[i] = route.pathFrom(m.ugx, m.ugy);
    }
    return out;
}
