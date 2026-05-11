"use strict";

const OUT_OF_ASTAR_SPEED_MULTIPLIER = 1 / 3;

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

function _setPlayerAstarBudget(owner, value) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0 || !players[pid]) return;
    players[pid].astar = Math.max(0, Number(value) || 0);
}

function _getPlayerAstarBudgetAvailable(owner) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0 || !players[pid]) return 0;
    return Math.max(0, Number(players[pid].astar) || 0);
}

function _getPlayerAstarBudgetRemaining(owner) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0 || !players[pid]) return 0;
    return Math.max(0, Number(players[pid].astar) || 0);
}

function _getPlayerAstarBudgetUsed(owner) {
    return 0;
}

function _getPlayerAstarIterationBudgetRemaining(owner) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0) return astarNodeBudgetRemaining;
    return Math.max(0, Number(astarNodeBudgetRemainingByPlayer[pid]) || 0);
}

function _canUsePathfindRequestBudget(owner) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0) return pathfindBudget < MAX_PATHS_PER_TICK;
    return pathfindBudgetByPlayer[pid] < MAX_PATHS_PER_TICK;
}

function _consumePathfindRequestBudget(owner) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0) {
        pathfindBudget++;
        return;
    }
    pathfindBudgetByPlayer[pid] = Math.max(0, Number(pathfindBudgetByPlayer[pid]) || 0) + 1;
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
    let amount = Math.max(0, Math.floor(Number(count) || 0));
    if (amount <= 0) return true;
    if (_getPlayerAstarIterationBudgetRemaining(owner) < amount) return false;
    _consumeAstarNodeBudget(owner, amount);
    return true;
}

function _consumePlayerAstarStockpile(owner, amount, unit = null, sourceTag = null) {
    let delta = Math.max(0, Number(amount) || 0);
    if (!(delta > 0)) return;
    let pid = _normalizeOwnerId(owner);
    if (pid < 0 || !players[pid]) return;
    players[pid].astar = Math.max(0, (Number(players[pid].astar) || 0) - delta);
    _recordAstarUsage(pid, delta, unit, sourceTag);
}

function _tryConsumeAstarMoveCost(u, tiles = 1) {
    if (!u) return false;
    let tileCount = Math.max(0, Number(tiles) || 0);
    let amount = tileCount * Math.max(0.1, Number(u.astarCost) || Number((BASE_UNIT_STATS[u.unitType] || {}).astarCost) || 1);
    if (amount <= 0) return true;
    let pid = _normalizeOwnerId(u.owner);
    if (pid < 0) return true;
    if (_getPlayerAstarBudgetRemaining(u.owner) < amount) {
        _setUnitAstarBudgetBlockedIndicator(u, 1);
        // Out of A*: do not hard-stop movement. Unit speed is reduced elsewhere.
        return true;
    }
    _consumePlayerAstarStockpile(u.owner, amount, u, 'movement');
    return true;
}

function _getUnitAstarSpeedMultiplier(u) {
    if (!u) return 1;
    let pid = _normalizeOwnerId(u.owner);
    if (pid < 0 || !players[pid]) return 1;
    let astarCost = Math.max(0, Number(u.astarCost) || Number((BASE_UNIT_STATS[u.unitType] || {}).astarCost) || 0);
    if (astarCost <= 0) return 1;
    return _getPlayerAstarBudgetRemaining(u.owner) <= 0
        ? OUT_OF_ASTAR_SPEED_MULTIPLIER
        : 1;
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
    let cd = Math.max(1, Math.floor(Number(cooldownTicks) || _getAstarBudgetIdleCooldownTicks()));
    if (u.workerState) {
        u._workerNextIdleRetargetTick = Math.max(gameTime + cd, Number(u._workerNextIdleRetargetTick) || 0);
    }
}

function _makeFallbackPathForUnit(u, sx, sy, ex, ey, cmd = CMD_MOVING, src = 'fallback') {
    if (!u) return null;
    u.pathIsFallbackAstar = true;
    u.path = null;
    u.pathIndex = 0;
    u._pendingPathTarget = { gx: ex, gy: ey, cmd, src };
    u.commandState = cmd;
    _setUnitAstarBudgetBlockedIndicator(u, 1);
    return null;
}

function _tryUpgradeAstarFallbackPath(u) {
    if (!u || !u.pathIsFallbackAstar || !u._pendingPathTarget || u.dead) return;
    if (Number.isFinite(u._astarBudgetRetryTick) && gameTime < u._astarBudgetRetryTick) return;
    if (!_canUsePathfindRequestBudget(u.owner)) return;

    let pt = u._pendingPathTarget;
    let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
    let dest = findNearestWalkable(pt.gx, pt.gy, ugx, ugy, u);
    _consumePathfindRequestBudget(u.owner);
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

    let unitType = String((unit && unit.unitType) || _activePathfindUnitType || 'other');
    let unitMetric = _astarMetricKeyForUnitType(unitType);
    let unitId = (unit && Number.isFinite(Number(unit.id)))
        ? Math.floor(Number(unit.id))
        : (Number.isFinite(Number(_activePathfindUnitId)) ? Math.floor(Number(_activePathfindUnitId)) : null);
    bucket.push({
        tick: gameTime,
        owner: pid,
        unitType,
        unitMetric,
        unitId,
        source: String(sourceTag || _activePathfindSource || PATH_SOURCE_UNSPECIFIED),
        used
    });

    let pruneBefore = gameTime - Math.max(1, Math.floor(TICK_RATE * ASTAR_USAGE_LOG_MAX_SECONDS));
    while (bucket.length > 0 && Number(bucket[0].tick) < pruneBefore) bucket.shift();
}

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

function _findPathForUnitTagged(sourceTag, unit, sx, sy, ex, ey, ignoreWalls = false, canWalk = null, pathOwner = null, cacheProfileHint = null) {
    let owner = _normalizeOwnerId(pathOwner);
    return _withPathfindContext(sourceTag, owner, unit, () => findPathAStar(sx, sy, ex, ey, ignoreWalls, canWalk, pathOwner, cacheProfileHint));
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

function _countPendingPathBacklog() {
    let c = 0;
    for (let u of units) {
        if (u && !u.dead && u._pendingPathTarget) c++;
    }
    return c;
}

function _pendingPathPriority(src) {
    if (src === 'player_commands') return 0;
    if (src === 'ai_combat') return 1;
    if (src === 'worker_ai') return 2;
    if (src === 'scout_ai') return 3;
    return 4;
}

function _updateAdaptivePathBudget() {
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

function _bumpPathTopologyVersion() {
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

// ---- A* scratch buffers: reused across calls via epoch trick, avoids per-call alloc ----
let _astarCap = 0;
let _astarEpoch = 0;
let _astarVisitedGen = null;  // Int32Array: [key] === epoch G�� visited this call
let _astarGScoreGen = null;  // Int32Array: [key] === epoch G�� gScore valid this call
let _astarGScoreVal = null;  // Int32Array: best g-score per tile
let _astarFrom = null;  // Int32Array: parent key (for path reconstruction)
let _astarHeapF = null;  // Int32Array: heap f-values (packed int heap)
let _astarHeapK = null;  // Int32Array: heap node keys

function _ensureAstarBuffers(size) {
    if (size > _astarCap) {
        _astarCap = size + 2048;
        _astarVisitedGen = new Int32Array(_astarCap);
        _astarGScoreGen = new Int32Array(_astarCap);
        _astarGScoreVal = new Int32Array(_astarCap);
        _astarFrom = new Int32Array(_astarCap);
        _astarHeapF = new Int32Array(_astarCap * 4);
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

// Typed-array min-heap (no object allocation per push)
// _astarHeapF / _astarHeapK must be ensured before use; _astarHeapSz tracks current size.
let _astarHeapSz = 0;

function _heapPush(f, k) {
    let i = _astarHeapSz++;
    _astarHeapF[i] = f; _astarHeapK[i] = k;
    let hF = _astarHeapF, hK = _astarHeapK;
    while (i > 0) {
        let p = (i - 1) >> 1;
        if (hF[p] > hF[i]) {
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
            if (l < n && hF[l] < hF[s]) s = l;
            if (r < n && hF[r] < hF[s]) s = r;
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

    if (!!getCloudTowerAt(gx, gy, unit ? unit.owner : null)) return true;
    if (!unit) return false;

    // Collectors can stand on active gold mines.
    if (unit.workerType === 'collector') {
        if (hasActiveGoldMineAt(gx, gy)) return true;
    }

    if (unit.workerType === 'astar_collector') {
        if (hasActiveAstarMineAt(gx, gy)) return true;
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

function findPathAStar(sx, sy, ex, ey, ignoreWalls = false, canWalk = null, pathOwner = null, cacheProfileHint = null) {
    let perfStart = performance.now();
    let sourceTag = _activePathfindSource || PATH_SOURCE_UNSPECIFIED;
    let ownerForBudget = _normalizeOwnerId(pathOwner !== null ? pathOwner : _activePathfindOwner);
    _lastPathfindAbortedByBudget = false;
    if (sx === ex && sy === ey) {
        _recordPathfindCall(sourceTag, performance.now() - perfStart, false);
        return [{ x: ex, y: ey }];
    }
    // Cloud portals should be usable for all unit pathing modes whenever owner context is known.
    let usePortalEdges = (pathOwner !== null);
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

    // Resolve cloud tile cache once per call (O(1) per lookup in hot path)
    if (usePortalEdges && _cloudTileCacheVer !== pathTopologyVersion) _rebuildCloudTileCache();

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
    }

    let bufSize = gridW * gridH;
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

    // Init start node
    gScoreGen[startKey] = epoch;
    gScoreVal[startKey] = 0;
    astarFrom[startKey] = startKey; // sentinel for path reconstruction

    _astarHeapSz = 0;
    let startH = usePortalEdges ? 0 : (Math.abs(ex - sx) + Math.abs(ey - sy));
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
                if (r < heapSz && hF[r] < hF[l]) s = r;
                if (hF[i] <= hF[s]) break;
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

        // Expand 4 cardinal neighbors inline (no array allocation)
        for (let di = 0; di < 8; di += 2) {
            let nx = cx + _ASTAR_DIRS[di], ny = cy + _ASTAR_DIRS[di + 1];
            if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
            if (!ignoreWalls && gridData[ny][nx].type === TYPE_WALL) {
                if (!(usePortalEdges && _getCloudTowerFast(nx, ny, pathOwner)) && !(canWalk && canWalk(nx, ny))) continue;
            }
            let nKey = ny * gridW + nx;
            if (visitedGen[nKey] === epoch) continue;
            let ng = cg + 1;
            if (gScoreGen[nKey] !== epoch || ng < gScoreVal[nKey]) {
                gScoreGen[nKey] = epoch;
                gScoreVal[nKey] = ng;
                astarFrom[nKey] = curKey;
                let h = usePortalEdges ? 0 : (Math.abs(ex - nx) + Math.abs(ey - ny));
                _heapPush(ng + h, nKey);
            }
        }

        // Cloud portal teleport edges
        if (usePortalEdges) {
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
                            _heapPush(ng, nKey); // h=0 in portal/Dijkstra mode
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

    if (movementProfile && !abortedByBudget) {
        sharedPathCache.set(cacheKey, { path: null, tick: gameTime, version: pathTopologyVersion });
        sharedPartialPathCache.delete(cacheKey);
        _trimPathCacheIfNeeded(sharedPathCache, PATH_CACHE_MAX_ENTRIES);
    }
    _recordPathfindCall(sourceTag, performance.now() - perfStart, false);
    return null;
}

function findPathAStarTagged(sourceTag, sx, sy, ex, ey, ignoreWalls = false, canWalk = null, pathOwner = null, cacheProfileHint = null) {
    return _withPathfindContext(sourceTag, pathOwner, null, () => findPathAStar(sx, sy, ex, ey, ignoreWalls, canWalk, pathOwner, cacheProfileHint));
}