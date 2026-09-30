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
    // Include this tick's not yet applied movement spend.
    let remaining = _getPlayerAstarBudgetRemaining(u.owner) + _fromFixedResourceUnits(_pendingMovementAstarFixed[pid] || 0);
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
    if (Number.isFinite(u._astarBudgetRetryTick) && gameTime < u._astarBudgetRetryTick) return;
    if (!_canUsePathfindRequestBudget(u.owner, u)) return;

    let pt = u._pendingPathTarget;
    let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
    let dest = findNearestWalkable(pt.gx, pt.gy, ugx, ugy, u);
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
    if (sharedSpawnerRouteCache.size > 0) sharedSpawnerRouteCache.clear();
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

function _buildDeterministicOpenGridPath(sx, sy, ex, ey) {
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
// their pair) in 4-connected regions, per owner, rebuilt when the topology
// or the live portals change. A search whose target lies in another region
// than its start cannot reach it: rather than exhausting the start's whole
// region (often over several ticks of budget), it goes straight to the
// region's tile nearest the target (see findPathAStar).
let _pathRegions = { version: -1, w: 0, h: 0, byOwner: new Map(), nearest: new Map() };

function _pathRegionPortalSignature() {
    if (_cloudTileCacheVer !== pathTopologyVersion) _rebuildCloudTileCache();
    let sig = 0;
    for (let [key, t] of _cloudTileCache) if (t.energy > 0 && !t.underConstruction) sig = (Math.imul(sig ^ (key + 1), 16777619) + (t.owner + 3)) | 0;
    return sig;
}

// Region label per tile (-1: not walkable) for plain ground movement of
// `owner` (null: no portals).
function getPathRegions(owner) {
    let R = _pathRegions;
    let portalSig = _pathRegionPortalSignature();
    if (R.version !== pathTopologyVersion || R.w !== GRID_W || R.h !== GRID_H || R.portalSig !== portalSig) {
        R.version = pathTopologyVersion; R.w = GRID_W; R.h = GRID_H; R.portalSig = portalSig;
        R.byOwner = new Map(); R.nearest = new Map();
    }
    let key = owner === null || owner === undefined ? -1 : owner;
    let labels = R.byOwner.get(key);
    if (labels) return labels;
    let w = GRID_W, h = GRID_H, n = w * h;
    labels = new Int32Array(n).fill(-1);
    let walk = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
        let row = grid[y];
        for (let x = 0; x < w; x++) if (row[x].type !== TYPE_WALL || (key >= 0 && _getCloudTowerFast(x, y, key))) walk[y * w + x] = 1;
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
    // Paired portals join their regions (union-find, then relabel).
    if (key >= 0 && _cloudTileCache.size) {
        let parent = new Int32Array(next);
        for (let i = 0; i < next; i++) parent[i] = i;
        let find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
        for (let [tileKey, t] of _cloudTileCache) {
            if (t.owner !== key || !(t.energy > 0 && !t.underConstruction)) continue;
            let partner = getPairedCloudTower(t, key);
            if (!partner) continue;
            let a = labels[tileKey], b = labels[partner.gy * w + partner.gx];
            if (a < 0 || b < 0) continue;
            let ra = find(a), rb = find(b);
            if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
        }
        for (let i = 0; i < n; i++) if (labels[i] >= 0) labels[i] = find(labels[i]);
    }
    R.byOwner.set(key, labels);
    return labels;
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

    let gridData = grid;
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
            if (!ignoreWalls && gridData[ny][nx].type === TYPE_WALL) {
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
// later instead of failing every tick. Routes are caches of the path
// topology: a topology change (every peer bumps it at a resync) drops them.
// Live routes (least recently used dropped beyond): enough for many-point
// orders of every player. A route holds 5 bytes per map tile.
const GROUP_ROUTE_MAX = 32;
const GROUP_ROUTE_NODES_PER_TICK = 60000;
// Start tiles turned into paths per tick, over all routes (walking a long
// route downhill for thousands of tiles at once would stall a tick).
const GROUP_ROUTE_PATHS_PER_TICK = 400;
let _groupRoutes = new Map(), _groupRoutesVersion = -1, _groupRouteSeq = 0;
const _groupRouteStepKeys = new Int32Array(8);
let _groupRoutePathTick = -1, _groupRoutePathsLeft = 0;

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
function getGroupRoute(owner, ex, ey, canWalk, starts) {
    if (_groupRoutesVersion !== pathTopologyVersion) { _groupRoutes = new Map(); _groupRoutesVersion = pathTopologyVersion; }
    let key = _groupRouteKey(owner, ex, ey, canWalk);
    if (key === null) return null;
    let route = _groupRoutes.get(key);
    if (!route) {
        if (_groupRoutes.size >= GROUP_ROUTE_MAX) {
            // Drop the least recently used (ties: the oldest).
            let oldest = null;
            for (let r of _groupRoutes.values()) if (!oldest || r.lastUsed < oldest.lastUsed || (r.lastUsed === oldest.lastUsed && r.seq < oldest.seq)) oldest = r;
            _groupRoutes.delete(oldest.key);
        }
        route = new GroupRoute(key, owner, ex, ey, canWalk, starts);
        _groupRoutes.set(key, route);
    }
    route.lastUsed = gameTime;
    return route;
}

class GroupRoute {
    constructor(key, owner, ex, ey, canWalk, starts) {
        this.key = key; this.seq = ++_groupRouteSeq; this.lastUsed = gameTime;
        this.owner = owner; this.ex = ex; this.ey = ey; this.canWalk = canWalk;
        let n = GRID_W * GRID_H;
        this.w = GRID_W; this.h = GRID_H;
        this.g = new Int32Array(n).fill(-1);
        // Per tile: bit 0 settled, bit 1 start tile (may be left though blocked).
        this.flags = new Uint8Array(n);
        this.pending = new Set();           // start tiles not settled yet
        this.paths = new Map();              // start tile -> path (null: none)
        this.heap = new Float64Array(1024); this.heapSize = 0;
        this.bound = Infinity;               // settle up to this priority once every start is reached
        this.exhausted = false;              // nothing left to expand
        // Heuristic: distance to the starts' bounding box, fixed at creation
        // (consistent for any start, so later starts stay exact).
        let minX = GRID_W, minY = GRID_H, maxX = -1, maxY = -1;
        for (let s of starts) {
            if (s.x < minX) minX = s.x; if (s.x > maxX) maxX = s.x;
            if (s.y < minY) minY = s.y; if (s.y > maxY) maxY = s.y;
        }
        this.bx0 = minX; this.by0 = minY; this.bx1 = maxX; this.by1 = maxY;
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
            this.flags[k] |= 2;
            if (!(this.flags[k] & 1)) { this.pending.add(k); this.bound = Infinity; }
        }
    }

    _walkable(x, y) {
        return grid[y][x].type !== TYPE_WALL
            || (this.usePortals && _cloudTileCache && _cloudTileCache.size > 0 && !!_getCloudTowerFast(x, y, this.owner))
            || !!(this.canWalk && this.canWalk(x, y));
    }

    // Expands up to `maxNodes` nodes within the owner's budget. Returns false
    // when the budget ran out before the reached starts were done.
    advance(maxNodes) {
        if (this.exhausted || (this.pending.size === 0 && this.heapSize === 0)) return true;
        let W = this.w, H = this.h, g = this.g, flags = this.flags;
        let owner = this.owner, wallType = TYPE_WALL, gridData = grid;
        if (this.usePortals && _cloudTileCacheVer !== pathTopologyVersion) _rebuildCloudTileCache();
        let searchClouds = this.usePortals && !!(_cloudTileCache && _cloudTileCache.size);
        let budgetArr = astarNodeBudgetRemainingByPlayer;
        let fastBudget = (owner | 0) === owner && owner >= 0 && owner < budgetArr.length && owner < players.length;
        let expanded = 0;
        while (this.heapSize > 0) {
            let top = this.heap[0];
            let priority = Math.floor(top / 2097152);
            if (this.pending.size === 0 && priority > this.bound) return true;
            if (expanded >= maxNodes) return false;
            let budgetOk = fastBudget ? (budgetArr[owner] >= 1 ? (budgetArr[owner]--, true) : false) : _tryConsumeAstarNodeBudget(owner, 1);
            if (!budgetOk) { _lastPathfindAbortedByBudget = true; return false; }
            this._pop();
            let cur = top - priority * 2097152;
            if (flags[cur] & 1) continue;
            expanded++;
            flags[cur] |= 1;
            let cx = cur % W, cy = (cur / W) | 0, cg = g[cur];
            if ((flags[cur] & 2) && this.pending.delete(cur) && this.pending.size === 0) this.bound = priority;
            // Stepping into a tile requires that tile to be walkable.
            if (gridData[cy][cx].type === wallType && !this._walkable(cx, cy)) continue;
            let ng = cg + 1;
            for (let di = 0; di < 8; di += 2) {
                let nx = cx + _ASTAR_DIRS[di], ny = cy + _ASTAR_DIRS[di + 1];
                if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                let nKey = ny * W + nx;
                if ((flags[nKey] & 1) || (g[nKey] >= 0 && g[nKey] <= ng)) continue;
                // A unit may stand on an unwalkable tile; it is only ever left.
                if (gridData[ny][nx].type === wallType && !(flags[nKey] & 2) && !this._walkable(nx, ny)) continue;
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
        return this._walk(sx, sy, maxLen);
    }

    _walk(sx, sy, maxLen) {
        let W = this.w, H = this.h, startKey = sy * W + sx;
        let g = this.g, flags = this.flags, owner = this.owner, canWalk = this.canWalk;
        let hasClouds = this.usePortals && !!(_cloudTileCache && _cloudTileCache.size);
        let nodes = this.nodes || (this.nodes = new Map());
        if (!(flags[startKey] & 1)) return null;
        let node = nodes.get(startKey);
        if (!node) nodes.set(startKey, node = { x: sx, y: sy });
        let path = [node];
        let routeDx = this.ex - sx, routeDy = this.ey - sy;
        let cur = startKey, stepKeys = _groupRouteStepKeys, limit = W * H, wallType = TYPE_WALL, gridData = grid;
        while (cur !== this.endKey) {
            let cx = cur % W, cy = (cur / W) | 0, want = g[cur] - 1;
            let count = 0;
            // Settled neighbours one step closer that can be stepped on.
            for (let di = 0; di < 8; di += 2) {
                let nx = cx + _ASTAR_DIRS[di], ny = cy + _ASTAR_DIRS[di + 1];
                if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
                let nKey = ny * W + nx;
                if (!(flags[nKey] & 1) || g[nKey] !== want) continue;
                if (gridData[ny][nx].type === wallType && !this._walkable(nx, ny)) continue;
                stepKeys[count++] = nKey;
            }
            if (hasClouds) {
                let cloud = _getCloudTowerFast(cx, cy, owner);
                let partner = cloud ? getPairedCloudTower(cloud, owner) : null;
                if (partner) {
                    let nKey = partner.gy * W + partner.gx;
                    if ((flags[nKey] & 1) && g[nKey] === want && this._walkable(partner.gx, partner.gy)) stepKeys[count++] = nKey;
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
    if (!last || last.y * GRID_W + last.x !== u._routeSegEnd) { u._routeKey = null; return false; }
    u._routeKey = null;
    if (last.y * GRID_W + last.x === endKey) return false;
    let gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE);
    let route = _groupRoutesVersion === pathTopologyVersion ? _groupRoutes.get(key) : null;
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
    if (_groupRoutesVersion !== pathTopologyVersion || _groupRoutes.size === 0) return;
    for (let route of [..._groupRoutes.values()].sort((a, b) => a.seq - b.seq)) {
        if (route.exhausted || route.pending.size === 0 || route.advancedTick === gameTime) continue;
        route.advancedTick = gameTime;
        _withPathfindContext('deferred_resolver', route.owner, null, () => route.advance(GROUP_ROUTE_NODES_PER_TICK));
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
        _withPathfindContext('player_commands', owner, null, () => route.advance(GROUP_ROUTE_NODES_PER_TICK));
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
