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
// retry tick (u._astarBudgetRetryTick) do nothing. By the kernel (wasm/src/pp.rs
// k_pp_due): one unit here (mode 1); the tick's due units in one pass
// (pendingPathsDue, mode 0); every waiting unit's substitute asked again
// (pendingPathSubAskAll, mode 2).
function _tryUpgradeAstarFallbackPath(u) {
    if (!u || u.dead || !u._us) return;
    _ppList(1)[0] = u._si;
    _ppRun(1, 1, _ppL);
}
// (Units in the given order, one pass.)
function pendingPathUpgradeUnits(us) {
    const L = _ppList(us.length);
    let n = 0;
    for (const u of us) if (u && !u.dead && u._us) L[n++] = u._si;
    if (n) _ppRun(1, n, L);
}
// k_pp_due's arguments (see its comment): the arrays, the parameters, the
// per-profile navigation table (encoded addresses), the scratch (heap; sized
// by the units waiting, a power of two).
const _ppA = new Array(55).fill(null), _ppP = new Float64Array(27), _ppPtrs = new Float64Array(4);
let _ppHdr = null, _ppTab = null, _ppL = null, _ppKa = null, _ppKb = null, _ppVa = null, _ppVb = null, _ppKeys = null;
function _ppGrow(a, T, n) {
    if (a && a.length >= n && simHeapHas(a)) return a;
    if (a && simHeapHas(a)) simHeapFree(a);
    return simHeapArray(T, Math.max(1024, 1 << Math.ceil(Math.log2(Math.max(1, n)))));
}
function _ppList(n) { return (_ppL = _ppGrow(_ppL, Int32Array, n)); }
function _ppRun(mode, n, list) {
    const S = _simUnitState, C = S && S.columns;
    if (!C) return;
    const N = _navSubReady(), A = _ppA, P = _ppP;
    if (!_ppHdr || !simHeapHas(_ppHdr)) { _ppHdr = simHeapArray(Int32Array, 8); _ppTab = simHeapArray(Int32Array, 12); }
    if (!_ppKeys) { _ppKeys = [_simHKey('_pendingPathTarget'), _simHKey('pathIsFallbackAstar'), _simHKey('_astarBudgetRetryTick')]; }
    // The navigation of every profile (a unit's is its own: flying, building, else the ground's).
    for (let p = 0; p < NAV_PROFILES; p++) {
        const nav = navEnsure(p), w = navWallTable(p), o = p * 4;
        // (The heap's byte addresses, -1 outside it; encoded as the kernels' words after: an address past 2 GiB is a
        // negative word, read unsigned by the kernel. Its sign tested here made every match whose heap passed 2 GiB
        // throw at its first waiting unit: no tick ran past the index (mixed-1m-4teams, a 100k two-tab start).)
        const ptrs = _ppPtrs;
        ptrs[0] = _simHeapPtrOf(w); ptrs[1] = nav && nav.partL ? _simHeapPtrOf(nav.partL) : 0; ptrs[2] = nav && nav.partL ? _simHeapPtrOf(nav.partBase) : 0; ptrs[3] = nav && nav.partL ? _simHeapPtrOf(nav.partComp) : 0;
        for (let j = 0; j < 4; j++) { if (!(ptrs[j] >= 0)) throw new Error('k_pp_due: profile ' + p + ' navigation array ' + j + ' not in the wasm heap' + (typeof simHeapStats === 'function' ? ' (heap ' + JSON.stringify(simHeapStats()) + ', grid ' + GRID_W + 'x' + GRID_H + ')' : '')); _ppTab[o + j] = _simWEnc(ptrs[j]); }
        P[16 + p] = nav ? nav.seq | 0 : 0; P[19 + p] = nav ? nav.cs : 0; P[22 + p] = nav ? nav.cw : 0;
    }
    const room = Math.max(1, mode === 0 ? _ppCount : n);
    _ppKa = _ppGrow(_ppKa, BigUint64Array, room); _ppKb = _ppGrow(_ppKb, BigUint64Array, room);
    _ppVa = _ppGrow(_ppVa, Int32Array, room); _ppVb = _ppGrow(_ppVb, Int32Array, room);
    const PA = simPathArena(8 * room), T = _ST.code && _ST.n === GRID_W * GRID_H ? _ST : null;
    if (T && !simHeapHas(T.code)) structTablesRehome();
    const rt = C.oc__astarBudgetRetryTick;
    if (!simHeapHas(rt.data)) rt._rehome();
    A[0] = list; A[1] = _ppHeads(); A[2] = C.ppDue; A[3] = C.ppNext; A[4] = C.ppPrev;
    A[5] = C.ptSt; A[6] = C.ptGx; A[7] = C.ptGy; A[8] = C.ptCmd; A[9] = C.ptSrc; A[10] = C.ptVer; A[11] = C.ptAt; A[12] = C.ptSub;
    A[13] = C.dead; A[14] = C.live; A[15] = C.id; A[16] = C.x; A[17] = C.y; A[18] = rt.data; A[19] = C.hObj;
    A[20] = C.nvPK; A[21] = C.pthH; A[22] = C.pathIndex; A[23] = C.commandState; A[24] = C.mvOn; A[25] = C.mvSteer; A[26] = C.mvPath;
    A[27] = S.pathPool ? S.pathPool.fs : null; A[28] = C.mvPF; A[29] = C.mvPP; A[30] = PA.a; A[31] = PA.free;
    A[32] = C.jFly; A[33] = C.wkIx; A[34] = C.wbType; A[35] = C.owner; A[36] = _mvtDirty; A[37] = _ppTab;
    A[38] = simMoveWallGrid(); A[39] = _navClassWalls(NAV_PROFILE_BUILD);
    A[40] = T && T.code; A[41] = T && T.val; A[42] = T && T.uc; A[43] = T && T.own; A[44] = T && T.brain; A[45] = findNearestWalkableClouds();
    A[46] = N.tab; A[47] = N.list; A[48] = _ppHdr; A[49] = _ppKa; A[50] = _ppKb; A[51] = _ppVa; A[52] = _ppVb;
    A[53] = C.wkS; A[54] = C.rkF;
    P[25] = SIM_PPT_SRC.indexOf('nav_unreachable'); P[26] = typeof UNIT_EV_NOWAY === 'number' ? UNIT_EV_NOWAY : 2;
    P[0] = mode; P[1] = mode === 0 ? room : n; P[2] = gameTime; P[3] = GRID_W; P[4] = GRID_H; P[5] = TILE; P[6] = PENDING_WHEEL; P[7] = _ppTaken;
    P[8] = PA.a.length; P[9] = N.mask + 1; P[10] = navSubRoom(); P[11] = NAV_SUB_TICKS;
    P[12] = _ppKeys[0]; P[13] = _ppKeys[1]; P[14] = _ppKeys[2]; P[15] = _stationaryTypes.length;
    const H = _ppHdr;
    H[0] = 0; H[1] = PA.top; H[2] = N.n; H[3] = 0; H[5] = N.asks;
    simRustDirect('k_pp_due', A, P);
    PA.top = H[1];
    N.used += H[2] - N.n; N.n = H[2]; N.asks = H[5];
    if (mode === 0 || mode === 3) _ppCount += H[0];
    if (mode === 0) _ppTaken = gameTime;
    // (Bit 2: the substitutes' room, a limit; the others cannot happen with the room given.)
    if (H[3] & ~2) throw new Error('k_pp_due: errors ' + H[3]);
}
// The units due this tick (main.js pendingPathsTick): each, by its source's
// priority, then its id, looked at once; those still waiting scheduled again.
function pendingPathsDue() {
    if (_ppCount > 0) _ppRun(0, 0, null);
}
// The tick's no-way events of units (no worker's) by the kernel (pp.rs mode 3: their pending targets, substitutes and
// wheel), dropped from the sorted list E (j of them). (unit.js unitEventsRun.)
function pendingPathNoWayEvents(E, j) {
    if (j > 0) _ppRun(3, j, E);
}
// Every waiting unit's substitute asked again (flownav.js navSubstitutesRestore, and the table cleared).
function pendingPathSubAskAll() {
    if (typeof _simUnitState === 'undefined' || !_simUnitState || typeof _simWasmX === 'undefined' || _simWasmX === null) return;
    const R = unitRows();
    if (R.n > 0) _ppRun(2, R.n, R.slots);
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
    // (The page's running sums: hud.js _deltaStore.)
    if (typeof _DELTA_STORE_ON !== 'undefined' && _DELTA_STORE_ON) _deltaAdd(_deltaSeries('a', pid, unitType + '|' + source, unitType, source), gameTime, -used);
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
    const S = typeof _simUnitState !== 'undefined' ? _simUnitState : null;
    if (S) S.columns.ppDue.fill(-1);
    _ppHeads().fill(-1); _ppCount = 0; _ppTaken = gameTime;
    // (A page beside a simulation worker simulates nothing: no wheel.)
    if (!S || typeof _simWasmX === 'undefined' || _simWasmX === null) return;
    // (The units with a pending target, in id order, by a kernel over the id table and columns: snap_units.rs
    // k_pp_reset. A pass over the units list made every unit's object.)
    const R = unitRows(), C = S.columns, rt = C.oc__astarBudgetRetryTick, P = _ppResetP;
    P[0] = R.n; P[1] = gameTime; P[2] = PENDING_WHEEL;
    simRustDirect('k_pp_reset', [R.slots, C.dead, C.ptSt, rt && rt.data && simHeapHas(rt.data) ? rt.data : null, _ppHeads(), C.ppNext, C.ppPrev, C.ppDue, _ppResetOut()], P);
    _ppCount = _ppResetOut()[0];
}
// (A whole release: the wheel empty.)
function pendingPathClear() { _ppHeads().fill(-1); _ppCount = 0; }
const _ppResetP = new Float64Array(4);
let _ppResetO = null;
function _ppResetOut() { if (!_ppResetO || !simHeapHas(_ppResetO)) _ppResetO = simHeapArray(Int32Array, 4); return _ppResetO; }
function pendingPathWaiting() { return _ppCount; }
function _countPendingPathBacklog() {
    return _ppCount;
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
// A cloud portal joined or left (built, destroyed): the groups at every
// portal of its pair seed the next adjacency flood, not only those at its
// own tile (a pair's groups are one group through the portals; destroyed, the
// far end's group stayed joined until a change near it). Any owner: a
// destroyed tower's row, its owner, is cleared already; a pair has a few
// portals at most. (Flags: the marking order does not matter.)
function cloudPairAdjacencyDirty(t) {
    const def = t && BASE_CARD_TYPES[t.type];
    if (!def || def.pairId === undefined || def.pairId === null) return;
    if (!_cloudTablesCurrent()) _rebuildCloudTileCache();
    for (const c of _cloudSet) {
        const d = BASE_CARD_TYPES[c.type];
        // (Only one standing at its tile: a member left over on one peer
        // would mark tiles the others do not; the dirty set is hashed.)
        if (d && d.pairId === def.pairId && Number.isFinite(c.gx) && Number.isFinite(c.gy) && getTileEntityRef(c.gx, c.gy) === c) requestAdjacencyRecalc(c.gx, c.gy, 1);
    }
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
    if (cellType[(grid[gy][gx]) - 1] !== TYPE_WALL) return true;

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
    return cellType[(grid[gy][gx]) - 1] !== TYPE_WALL;
}




let _airWall = null, _cloudSig = 0, _cloudSigVer = -1, _cloudSigTables = null;
function _airWallTable() {
    // (One made before the wasm heap was up (a plain array): made again in it, where the kernels read it.)
    if (!_airWall || _airWall.length !== GRID_W * GRID_H || (typeof simHeapHas === 'function' && !simHeapHas(_airWall))) {
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
// cached while the unit's tile, its route's end and the navigation (its
// installs, nav.version) are the same: the same walk gives the same path, and
// a watched selection's units walked it every tick (64 atlas steps and nodes
// each, ~256 units: up to ~8 ms of the simulation thread). Never simulation input.
const UNIT_DISPLAY_PATH = 64;
const _displayPaths = new WeakMap();
function unitDisplayPath(u) {
    let p = u && u.path;
    if (p && p.length) return p;
    if (!u || !u._routeKey || !u._us) return p;
    if (u._routeKey === NAV_ROUTE_KEY) {
        let c = _displayPaths.get(u);
        const prof = navProfileOf(u), gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE), end = u._routeEnd;
        const nav = _nav[prof], ver = nav ? nav.version | 0 : -1, tile = gy * GRID_W + gx;
        if (c && c.tile === tile && c.end === end && c.ver === ver && c.prof === prof) return c.path;
        let path = navPath(prof, gx, gy, end, UNIT_DISPLAY_PATH) || [];
        path.push({ x: end % GRID_W, y: (end / GRID_W) | 0 });
        if (c) { c.tile = tile; c.end = end; c.ver = ver; c.prof = prof; c.path = path; }
        else _displayPaths.set(u, { tile, end, ver, prof, path });
        return path;
    }
    return p;
}





