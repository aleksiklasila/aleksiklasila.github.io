"use strict";

// ============================================================
// ADJACENCY & LASER CONNECTIONS
// ============================================================
// Laser links and beams: made every tick from the world by the kernels
// (tower.js laserBeamsTick, laser.rs). These hooks of the JavaScript that
// changed them are no-ops now.
function recalculateLaserConnections() { if (typeof laserMapDirty === 'function') laserMapDirty(); }
function markLaserConnectionsDirty() {}
function ensureLaserConnections() {}
function laserListToggle(t) { if (typeof laserLinesTouch === 'function') laserLinesTouch(t, true); }
function _laserTowerList() { const out = []; for (const t of towers) if (t.type === 'laser') out.push(t); return out; }

function _isOperationalAdjacencyEntity(obj) {
    if (!obj) return false;
    if (obj.underConstruction) return false;
    let lvl = (obj.effectiveLevel !== undefined ? obj.effectiveLevel : obj.level);
    if (lvl !== undefined && lvl <= 0) return false;
    return true;
}

function _getCanonicalAreaCellsById(areaId, fallbackArea = null) {
    let aId = Math.floor(Number(areaId));
    if (aId >= 0 && Array.isArray(gridCellsByArea) && Array.isArray(gridCellsByArea[aId]) && gridCellsByArea[aId].length > 0) {
        return gridCellsByArea[aId];
    }
    let area = fallbackArea || getAreaById(aId);
    if (!area || !Array.isArray(area.cells) || area.cells.length <= 0) return [];
    return area.cells.filter(cp => cp && Number.isFinite(cp.x) && Number.isFinite(cp.y));
}

// Adjacency now (outside a match's ticks: placements before the start,
// tools, a test with the lane off): the lane's post and commit at once, the
// flood on this thread.
function _runAdjacencyRecalculation() {
    if (!_adjacencyNeedsRecalc) return;
    if (typeof simParallelRun !== 'function' || typeof _simWasmX === 'undefined' || !_simWasmX) return;
    // (A post takes every dirty tile.)
    _adjacencyLanePost(true);
    _adjacencyLaneCommit();
}
const ADJACENCY_BATCH_TICKS = 8;

// ---- Adjacency on a helper lane (BRAIN_OFF_MAIN_THREAD_PLAN.md) ----
// The main thread keeps a signature grid current (O(1) per dirty tile at
// the post), posts the flood (SIM_KERNEL_ADJ_FLOOD) every
// ADJACENCY_BATCH_TICKS ticks at phase 3 and takes the last post's result
// then: all its groups' members applied to their rows by one parallel
// kernel (SIM_KERNEL_ADJ_APPLY, ord.rs k_adj_apply: levels, upgrades,
// stacking, energy, the stat entries and descriptors), the JavaScript only
// its events (work sites, traps, vision registrations, lasers); areas'
// active flags at once. Every peer posts and
// commits on the same ticks; a resync drops it all and marks every tile
// (adjacencyLaneReset).
let ADJACENCY_LANE = true;
const ADJ_LANE = typeof SIM_LANE_T5 === 'number' ? SIM_LANE_T5 : 3;
// (Members a job of the apply kernel.)
const ADJ_APPLY_PER_JOB = 8192;
const _adjL = { posted: false, passive: false, paths: false, outs: 0, coff: null, ctile: null, cfor: null, mul: null, tabs: null };
function _adjArr(name, Type, n) {
    let a = _simParReg[name];
    if (!a || a.constructor !== Type || a.length < n) { const old = a; a = simHeapArray(Type, simReserveCap(Math.max(1, n), 64)); simParallelBind(name, a); simHeapFree(old); }
    return a;
}
function adjacencyLaneReset() {
    if (typeof simParallelBackgroundWait === 'function') simParallelBackgroundWait(ADJ_LANE);
    _adjL.posted = false; _adjL.cfor = null;
    _adjacencyDirtyAll = true; _adjacencyNeedsRecalc = true;
}
// Static building stat tables (data_dynamic.js PRECOMPUTED_STATS_MAP: per
// building key, level and research level; made once a stat map, never in
// play): stt.mxe the maximum energy (floored, at least 1; NaN none), stt.vis
// / stt.atk the vision and attack range in area steps (-1 none), at
// [(key * L1 + level) * R1 + research level]. Keys in _statKeyIds order.
const _statKeyIds = new Map();
function statKeyId(key) { let k = _statKeyIds.get(key); if (k === undefined) { k = _statKeyIds.size; _statKeyIds.set(key, k); } return k; }
const _stt = { map: null, nk: 0, L1: 0, R1: 0 };
function statTablesStatic() {
    const M = PRECOMPUTED_STATS_MAP && PRECOMPUTED_STATS_MAP.building;
    for (const key in M) statKeyId(key);
    const nk = _statKeyIds.size, L1 = MAX_THING_LEVEL + 1, R1 = MAX_RESEARCH_LEVEL + 1;
    if (_stt.map === M && _stt.nk === nk && _stt.L1 === L1 && _stt.R1 === R1 && simHeapHas(_stt.mxe)) return _stt;
    const n = Math.max(1, nk * L1 * R1);
    const mxe = _adjArr('stt.mxe', Float64Array, n), vis = _adjArr('stt.vis', Int32Array, n), atk = _adjArr('stt.atk', Int32Array, n), dmg = _adjArr('stt.dmg', Float32Array, n);
    mxe.fill(NaN); vis.fill(-1); atk.fill(-1); dmg.fill(NaN);
    for (const [key, kb] of _statKeyIds) {
        const levels = (M && M[key]) || [];
        for (let lv = 1; lv < L1; lv++) {
            const e = levels[lv] || {};
            for (let r = 0; r < R1; r++) {
                const i = (kb * L1 + lv) * R1 + r;
                // (As _getBuildingPlayerPrecomputedEntryObject makes them.)
                const me = Number(e.maxEnergy ? e.maxEnergy[r] : NaN);
                mxe[i] = Number.isFinite(me) ? Math.fround(Math.max(1, Math.floor(me))) : NaN;
                vis[i] = e.visionRange ? areaSteps(e.visionRange[r]) : -1;
                atk[i] = e.attackRange ? areaSteps(e.attackRange[r]) : -1;
                dmg[i] = e.damage ? Math.fround(Number(e.damage[r])) : NaN;
            }
        }
    }
    Object.assign(_stt, { map: M, nk, L1, R1, mxe, vis, atk, dmg });
    return _stt;
}
// Per owner row (0 none, 1 + the player) and building key: research levels
// of maxEnergy, visionRange, attackRange, damage (adj.rlv, four a pair), boost
// levels of the boosted stats (adj.bl: data_dynamic.js _statBoostLevels as
// levels, boostStepLevels), the researched maximum level (adj.rml:
// getThingResearchedMaxLevel). Small arrays, made again when research or a
// boost changes (the stats version), the players or the keys.
function _adjPlayerStats(S) {
    const np = players.length + 1, nk = S.nk;
    const ver = _precomputedStatsVersion + '|' + np + '|' + nk + '|' + (typeof gameStarted !== 'undefined' && gameStarted ? 1 : 0);
    const X = _adjL.ps;
    if (X && X.ver === ver && simHeapHas(X.rml)) return X;
    const n = Math.max(1, np * nk);
    const P = { ver, np, rml: _adjArr('adj.rml', Int32Array, n), rlv: _adjArr('adj.rlv', Int32Array, 4 * n), bl: _adjArr('adj.bl', Int32Array, n) };
    const MAXR = Math.max(1, MAX_RESEARCH_LEVEL), MAXL = Math.max(1, MAX_THING_LEVEL);
    P.rml.fill(1, 0, nk); P.rlv.fill(0, 0, 4 * nk); P.bl.fill(0, 0, nk);
    for (let o = 0; o < np - 1; o++) for (const [key, kb] of _statKeyIds) {
        const i = (o + 1) * nk + kb;
        const researched = Math.max(0, Math.floor(getPlayerResearchLevel(o, 'building', key, 'maxLevel') || 0));
        P.rml[i] = Math.max(1, Math.min(MAXL, 1 + Math.round(researched * (MAXL - 1) / MAXR)));
        P.rlv[4 * i] = getPlayerResearchLevel(o, 'building', key, 'maxEnergy');
        P.rlv[4 * i + 1] = getPlayerResearchLevel(o, 'building', key, 'visionRange');
        P.rlv[4 * i + 2] = getPlayerResearchLevel(o, 'building', key, 'attackRange');
        P.rlv[4 * i + 3] = getPlayerResearchLevel(o, 'building', key, 'damage');
        P.bl[i] = boostStepLevels(_statBoostLevels(o, 'building', key, 'visionRange'));
    }
    return (_adjL.ps = P);
}
// Per stationary type its building key's id (adj.tykey; -1 none).
function _adjTypeKeys() {
    const n = _stationaryTypes.length, L = _adjL;
    if (L.tyk && L.tykN === n && simHeapHas(L.tyk)) return n;
    const K = L.tyk = _adjArr('adj.tykey', Int32Array, Math.max(1, n));
    for (let ty = 0; ty < n; ty++) {
        const raw = _stationaryTypes[ty];
        let key = _sBuildingStatKeys.get(raw);
        if (key === undefined) { key = normalizeBuildingResearchKey(raw); _sBuildingStatKeys.set(raw, key); }
        const k = _normalizePlayerPrecomputedBuildingKey(key);
        K[ty] = _statKeyIds.has(k) ? _statKeyIds.get(k) : -1;
    }
    L.tykN = n;
    return n;
}
// The columns of the apply kernel's classes (ord.rs ADJ_COLS a class), as
// pointer words in adj.ctab (a class without a table: zeros, never met).
const _ADJ_CTAB_COLS = ['gx', 'gy', 'stacks', 'manualStacks', 'effectiveStacks', 'level', 'effectiveLevel', 'potentialEffectiveLevel', 'isStacking', 'stackingWorkDone',
    'autoUpgradeEnabled', 'isUpgrading', 'effectiveGroupSize', 'effectiveAreaMult', 'autoStackEnabled', '_ow', '_en', '_vsGen', '_vsR', '$tok', 'upgrademaxEnergy',
    '_mxOv', '_ovMx', '_ovVs', '$mxn', 'watched', 'watchedByTeam'];
function _adjApplyClasses(CT) {
    const classes = STRUCT_STATUS_CLASSES(), W = _ADJ_CTAB_COLS.length;
    for (let c = 0; c < 9; c++) {
        const C = classes[c], T = C ? _sTables.get(C) : null;
        if (!T || !T.n) { CT.fill(0, c * W, c * W + W); continue; }
        if (!_sColsInHeap(T) || !simHeapHas(T.mTok)) _sTableGrow(T, T.cap);
        if (!simHeapHas(T.mxOvN)) { const a = _sColAlloc(Int32Array, 4); a.set(T.mxOvN); T.mxOvN = a; }
        for (let j = 0; j < W; j++) {
            const k = _ADJ_CTAB_COLS[j], a = k === '$tok' ? T.mTok : k === '$mxn' ? T.mxOvN : T['c_' + k];
            CT[c * W + j] = _simWEnc(_simHeapPtrOf(a));
        }
    }
}
// The flood's no members applied (k_adj_apply on the helpers), then its events
// in member order.
function _adjApplyRun(no, passive) {
    const S = statTablesStatic(), X = _adjPlayerStats(S), NT = _adjTypeKeys(), R = _simParReg;
    const CT = _adjArr('adj.ctab', Int32Array, 9 * _ADJ_CTAB_COLS.length), jobs = Math.ceil(no / ADJ_APPLY_PER_JOB);
    const ev = _adjArr('adj.ev', Int32Array, 4 * no), evn = _adjArr('adj.evn', Int32Array, 16 * jobs);
    for (const k of ['code', 'own', 'stab', 'rrow', 'uc', 'brain', 'val']) simParallelBind('st.' + k, _ST[k]);
    _adjApplyClasses(CT);
    const laser = _stationaryTypeIds.get('laser'), vis = typeof _visCover !== 'undefined' && _visCover.syncedTick >= 0 && _visCover.adm === areaDistanceMatrix;
    const P = _simParams;
    P[0] = no; P[1] = ADJ_APPLY_PER_JOB; P[2] = passive ? 1 : 0; P[3] = GRID_W; P[4] = MAX_THING_LEVEL; P[5] = S.nk; P[6] = X.np; P[7] = 0;
    P[8] = vis ? 1 : 0; P[9] = vis ? _visCover.gen : 0; P[10] = laser === undefined ? -1 : laser; P[11] = S.L1; P[12] = ST_OWNER_NONE; P[13] = NT; P[14] = S.R1;
    simParallelRun(SIM_KERNEL_ADJ_APPLY, jobs);
    const OT = R['adj.otile'], classes = STRUCT_STATUS_CLASSES();
    for (let j = 0; j < jobs; j++) for (let q = 0, n = evn[j * 16], b = j * ADJ_APPLY_PER_JOB; q < n; q++) {
        const e = 4 * (b + q), T = _sTables.get(classes[ev[e]]), obj = T ? T.rowObj[ev[e + 1]] : null, flags = ev[e + 2], i = ev[e + 3];
        if (!obj) continue;
        if (flags & 2) { const t = OT[i], gx = t % GRID_W, gy = (t - gx) / GRID_W; workSiteDirty(gx, gy); simTrapDirty(gx, gy); }
        if (flags & 16) visCoverOnBuildingChanged(obj);
        if ((flags & 32) && obj.laserCheck) obj.laserCheck();
    }
}
// On the batch tick: the last post's commit, then the next post.
function adjacencyLaneStep() {
    if (!simStepCrosses(-3, ADJACENCY_BATCH_TICKS)) return;
    _adjacencyLaneCommit();
    _adjacencyLanePost(false);
}
// The last post's result (the flood's members applied, the areas' flags).
function _adjacencyLaneCommit() {
    const L = _adjL;
    if (L.posted) {
        if (!L.sync) simParallelBackgroundWait(ADJ_LANE);
        L.posted = false;
        const R = _simParReg, CNT = R['adj.ocnt'], no = CNT[0], na = CNT[2];
        const OT = R['adj.otile'], OG = R['adj.ogrp'], GS = R['adj.gsize'], GM = R['adj.gmul'], OA = R['adj.oarea'], OACT = R['adj.oact'];
        if (no > 0) _adjApplyRun(no, L.passive);
        let changed = false;
        for (let i = 0; i < na; i++) {
            const a = getAreaById(OA[i]);
            if (!a) continue;
            const next = OACT[i] === 1;
            if (!L.passive && !next && a.multiplierLevel > 0) { a.multiplierLevel = 0; if (L.mul && OA[i] < L.mul.length) L.mul[OA[i]] = 0; changed = true; }
            if (!!a.active !== next) changed = true;
            a.active = next;
        }
        if (changed) dirtyAreas = true;
        if (L.paths) _bumpPathTopologyVersion();
    }
}
// The next post: the dirty tiles' signatures, the flood on the lane (sync:
// run now on this thread).
function _adjacencyLanePost(sync) {
    const L = _adjL;
    if (!_adjacencyNeedsRecalc) return;
    const N = GRID_W * GRID_H, all = _adjacencyDirtyAll, blocks = (N + 255) >> 8;
    // The area tables (when the layout changed: rare): each area's tiles
    // made by the kernel from the area grid (adj.ag) when the layout's
    // version is new. (The page's pass over its areas' cell lists, cold
    // code at a layout's first post, was 0.3-1.4 s on a 1000x1000 map.)
    const A = Array.isArray(areas) ? areas.length : 0;
    if (L.cfor !== gridCellsByArea || !L.coff || L.coff.length < A + 1) {
        L.coff = _adjArr('adj.coff', Int32Array, A + 1); L.ctile = _adjArr('adj.ctile', Int32Array, N);
        L.cfor = gridCellsByArea; L.layoutVer = (L.layoutVer | 0) + 1;
        L.mul = _adjArr('adj.mul', Int32Array, A);
        for (let a = 0; a < A; a++) L.mul[a] = (areas[a] && areas[a].multiplierLevel) | 0;
    }
    // (The lane is shared (the units' cover): its job finished before its
    // arrays and params are written, else a pending stage of it runs with these.)
    simParallelBackgroundWait(ADJ_LANE);
    // The signature grid, the seeds (every structure, or the dirty tiles: all
    // of them, their flags cleared) and the cloud portals by the post kernel
    // (ord.rs k_adj_post) on the helpers.
    _adjacencyDirtyTiles.room(N);
    simParallelBind('adj.dflag', _adjacencyDirtyTiles.flag); simParallelBind('adj.dblk', _adjacencyDirtyTiles.blk);
    for (const k of ['code', 'own', 'uc', 'brain', 'stab', 'rrow', 'val']) simParallelBind('st.' + k, _ST[k]);
    // (Seeds as offsets in their 256-tile block; portals a list sized by the
    // towers' table, the second half the flood's sort scratch.)
    const Tw = typeof Tower !== 'undefined' ? _sTables.get(Tower) : null, ccap = Math.max(64, Tw ? Tw.cap : 64);
    _adjArr('adj.sig', Int32Array, N); _adjArr('adj.seed8', Uint8Array, blocks * 256); _adjArr('adj.scnt', Int32Array, blocks);
    _adjArr('adj.cls4', Int32Array, 8 * ccap); _adjArr('adj.cloud', Int32Array, 3 * ccap);
    const CC = _adjArr('adj.ccnt', Int32Array, 4); CC[0] = 0;
    _adjApplyClasses(_adjArr('adj.ctab', Int32Array, 9 * _ADJ_CTAB_COLS.length));
    const TF = _adjTypeFlags(), jobs = Math.ceil(blocks / ADJ_POST_BLOCKS_PER_JOB), PF = _adjArr('adj.pflag', Int32Array, 16 * jobs);
    const P = _simParams;
    P[0] = blocks; P[1] = ADJ_POST_BLOCKS_PER_JOB; P[2] = N; P[3] = all ? 1 : 0; P[4] = ST_OWNER_NONE; P[5] = TF.n; P[6] = ccap;
    simParallelRun(SIM_KERNEL_ADJ_POST, jobs);
    if (CC[0] > ccap) CC[0] = ccap;
    // (The flood's seeds, dense: room for as many as the blocks hold.)
    { const SC = _simParReg['adj.scnt']; let ns = 0; for (let b = 0; b < blocks; b++) ns += SC[b]; _adjArr('adj.seed', Int32Array, Math.max(1, ns)); }
    if (!all) _adjacencyDirtyTiles.takenAll(); else _adjacencyDirtyTiles.clear();
    let paths = all;
    for (let q = 0; q < jobs && !paths; q++) if (PF[q * 16]) paths = true;
    // (A new area grid: the kernel's cells by area made again.)
    const AG = _spatialAreaGridFlat();
    if (L.agFor !== AG) { L.agFor = AG; L.layoutVer = (L.layoutVer | 0) + 1; }
    simParallelBind('adj.ag', AG);
    // (Outputs: up to every tile once.)
    _adjArr('adj.otile', Int32Array, N); _adjArr('adj.ogrp', Int32Array, N); _adjArr('adj.gsize', Int32Array, N); _adjArr('adj.gmul', Float64Array, N);
    _adjArr('adj.oarea', Int32Array, Math.max(1, A)); _adjArr('adj.oact', Uint8Array, Math.max(1, A)); _adjArr('adj.ocnt', Int32Array, 4);
    _adjArr('adj.wk', Int32Array, 8 + 4 * N + 4 * Math.max(1, A));
    const B = _simBgParamsByLane[ADJ_LANE];
    B.fill(0); B[0] = GRID_W; B[1] = GRID_H; B[4] = A; B[5] = L.layoutVer; B[6] = blocks;
    if (sync) { for (let q = 0; q < 8; q++) P[q] = B[q]; simParallelRun(SIM_KERNEL_ADJ_FLOOD, 1); }
    else simParallelBackground(SIM_KERNEL_ADJ_FLOOD, 1, ADJ_LANE);
    L.posted = true; L.sync = !!sync; L.passive = !!_adjacencyPassiveRefreshMode; L.paths = paths;
    _adjacencyNeedsRecalc = _adjacencyDirtyTiles.size > 0;
    _adjacencyDirtyAll = false; _adjacencyPassiveRefreshMode = false;
    _adjacencyLastRecalcTick = gameTime;
}
// Blocks of 256 tiles a job of the post kernel.
const ADJ_POST_BLOCKS_PER_JOB = 64;
// Per stationary type (data_state.js _stationaryTypes): bit 0 a cloud portal,
// bit 1 its structures change paths (clouds, spawners), its pair id + 1 in
// bits 8.. (adj.tyf; made again as types appear).
function _adjTypeFlags() {
    const n = _stationaryTypes.length, L = _adjL;
    if (L.tyf && L.tyfN === n && simHeapHas(L.tyf)) return { n };
    const F = L.tyf = _adjArr('adj.tyf', Int32Array, Math.max(1, n));
    for (let ty = 0; ty < n; ty++) {
        const b = BASE_CARD_TYPES[_stationaryTypes[ty]], cloud = !!(b && b.isCloud);
        const pair = cloud && b.pairId !== undefined && b.pairId !== null ? (Number(b.pairId) | 0) : -1;
        F[ty] = (cloud ? 3 : 0) | ((pair + 1) << 8);
    }
    L.tyfN = n;
    return { n };
}

function recalculateAdjacency(forceFull = false, options = null) {
    if (forceFull && typeof forceFull === 'object') {
        options = forceFull;
        forceFull = !!options.forceFull;
    }
    if (forceFull) _adjacencyDirtyAll = true;
    _adjacencyPassiveRefreshMode = !!(options && options.passiveRefresh);
    _adjacencyNeedsRecalc = true;
    // (The lane: marked; it takes it at its next batch.)
    if (ADJACENCY_LANE && typeof gameStarted !== 'undefined' && gameStarted) return;
    // (During a tick: once, at its end (gameTick); outside one, now.)
    if (_adjacencyLastRecalcTick === gameTime || (typeof _inGameTick !== 'undefined' && _inGameTick)) return;
    _runAdjacencyRecalculation();
}

// Effective stats follow the units around them a few seconds behind: each
// unit's turn comes this many times less often than the configured ticks.
const UNIT_EFFECTIVE_STATS_SLOWDOWN = 5;
function getUnitEffectiveStatsRecalcTicks() {
    return Math.max(1, Math.min(1200, Math.floor(Number(UNIT_EFFECTIVE_STATS_RECALC_TICKS) || 1) * UNIT_EFFECTIVE_STATS_SLOWDOWN));
}

function getUnitCollisionRecalcTicks() {
    return Math.max(1, Math.min(240, Math.floor(Number(UNIT_COLLISION_RECALC_TICKS) || 1)));
}

// (A new unit has its stats from creation: applyUnitLevelScaling gives it
// its level's tables, a stat row of its owner, type and level, and notes it
// current (esVer). Nothing refreshes a unit afterwards: its row is rewritten
// in place when research changes the tables, and its effective level, which
// follows the units around it a few seconds behind, is the strided share of
// recalculateUnitEffectiveLevel's, from the columns, in the kernels.)
// A restore or a new world: the base entries (tables of the stat maps) may
// be other objects.
function resetNewUnitsForStats() {
    if (typeof _effBaseClear === 'function') _effBaseClear();
}

// A unit's effective-stats range in area steps: its base vision range in areas, in whole steps (0a: its own area, 1a: its own and
// the areas next to it, and so on; a range of 0.6 is 0a, 1.35 is 1a).
const EFF_AREA_STEPS_MAX = 6;
function _effAreaStepsOf(b) {
    const v = b ? Number(b.visionRangeArea) : NaN;
    return Math.min(EFF_AREA_STEPS_MAX, areaSteps(v));
}

// The effective levels' counts: the units each lane (owner * unit types + type) has in each area, a snapshot taken by the kernels
// at the start of each period (the same tick on every peer; at a restore every peer takes a new one on the same tick) and read by
// the evaluations of the period. A unit's stacks go with the units of its type in the areas within its range, so they follow
// the crowd a few ticks behind.
const _effAreaHist = { arr: null, tick: -1, areas: 0, lanes: 0 };
function effAreaHistReset() { _effAreaHist.tick = -1; }
function _effAreaHistEnsure(tick, step) {
    const H = _effAreaHist, S = typeof _simUnitState !== 'undefined' ? _simUnitState : null;
    const A = Array.isArray(areaNeighborIds) ? areaNeighborIds.length : 0, L = Math.max(1, spatialUnitsComplexPlayerCount * spatialUnitsComplexUnitTypeCount);
    if (H.arr && H.areas === A && H.lanes === L && H.tick >= 0 && tick - H.tick < step && tick >= H.tick) return H;
    if (!S || !(A > 0) || typeof SIM_KERNEL_EFF_AREA_HIST !== 'number') { H.tick = -1; return null; }
    const n = A * L;
    if (!H.arr || H.arr.length !== n) {
        if (H.arr) simHeapFree(H.arr);
        H.arr = simHeapArray(Int32Array, n); simParallelBind('eff.areaHist', H.arr);
    }
    H.areas = A; H.lanes = L; H.tick = tick;
    const P = _simParams;
    P[0] = n; P[1] = 65536; P[2] = L; P[3] = A; P[4] = spatialUnitsComplexUnitTypeCount; P[5] = spatialUnitsComplexPlayerCount; P[6] = 0;
    simParallelRun(SIM_KERNEL_EFF_AREA_HIST, Math.ceil(n / 65536));
    const slots = S.owners.length;
    P[0] = slots; P[1] = 16384; P[6] = 1;
    simParallelRun(SIM_KERNEL_EFF_AREA_HIST, Math.ceil(slots / 16384));
    return H;
}

let _effectiveStatsStamp = 0;

// A unit's base tables were (re)applied (applyUnitLevelScaling): the
// effective-stats kernel can take it from the columns (esOk) while its
// range does not depend on its effective tables (_effAreaStepsOf: its base ones).
function effStatsUnitBaseChanged(u) {
    const c = u && u._us;
    if (!c) return;
    const s = u._si, b = u.basePreComputed, typeIdx = spatialUnitTypeToIndex[u.unitType];
    const ok = !!(b && Number.isFinite(b.visionRange) && b.visionRange && Number.isFinite(b.maxEnergy)
        && Number.isFinite(typeIdx) && typeIdx >= 0 && Number.isFinite(u.baseLevel));
    c.esOk[s] = ok ? 1 : 0;
    if (!ok) return;
    c.esRad[s] = _effAreaStepsOf(b);
    c.esType[s] = typeIdx;
}
// Every unit takes the full path once more (a restore replaced tables in
// place, the stat tables changed).
function effStatsInvalidateAll() {
    if (typeof _simUnitState !== 'undefined' && _simUnitState) _simUnitState.columns.esOk.fill(0);
}
// At a resync, on every peer: each unit's effective level counts as applied
// (a restored peer has no record of what was; the others applied theirs at
// its refresh), so no peer applies its tables again for nothing (that also
// rounds its energy) at a refresh the others make without.
function effStatsAppliedSync() {
    const S = typeof _simUnitState !== 'undefined' ? _simUnitState : null;
    if (!S) return;
    const c = S.columns, n = S.owners.length;
    for (let s = 0; s < n; s++) c._lastAppliedEffectiveLevel[s] = c.effectiveLevel[s];
    // (A restored unit's flag (_statsBehind: -2 behind, -3 current) as a
    // version: behind stays behind, as on the peer it came from.)
    for (let s = 0; s < n; s++) {
        const v = c.esVer[s];
        if (v !== -2 && v !== -3) continue;
        const u = S.owners[s];
        c.esVer[s] = v === -3 && u ? _unitStatsVerOf(u) : -2;
    }
}
// (esVer -1: a new unit, its stats not applied yet; -2: behind, from a
// restore.)
function _unitStatsBehind(u, ver) {
    if (ver === -3) return false;
    if (ver < 0) return true;
    return ver !== _unitStatsVerOf(u);
}
let _effStatsVersion = -1;

// The nearby same-owner same-type count of one unit (the full path): the snapshot's counts of its area and, for a range of r
// area steps, of the areas within r of it (breadth first over the area graph), as the kernel sums them.
let _effAreaSeen = new Int32Array(0), _effAreaQueue = new Int32Array(0), _effAreaEpoch = 0;
function _effAreaCount(u, hist) {
    const H = hist || _effAreaHist, c = u._us;
    if (!c || !H.arr) return 0;
    const owner = Math.floor(Number(u.owner)), typeIdx = spatialUnitTypeToIndex[u.unitType];
    if (!Number.isFinite(typeIdx) || typeIdx < 0 || !(owner >= 0 && owner < spatialUnitsComplexPlayerCount)) return 0;
    const ar = c.spArea[u._si];
    if (!(ar >= 0 && ar < H.areas)) return 0;
    const lane = owner * spatialUnitsComplexUnitTypeCount + typeIdx, L = H.lanes, arr = H.arr, r = c.esRad[u._si];
    let sum = arr[ar * L + lane];
    if (r >= 1) {
        const nbs = areaNeighborIds;
        if (r === 1) { const l = nbs[ar]; if (l) for (let i = 0; i < l.length; i++) sum += arr[l[i] * L + lane]; }
        else {
            if (_effAreaSeen.length < H.areas) { _effAreaSeen = new Int32Array(H.areas); _effAreaQueue = new Int32Array(H.areas); _effAreaEpoch = 0; }
            const ep = ++_effAreaEpoch, seen = _effAreaSeen, q = _effAreaQueue;
            seen[ar] = ep; q[0] = ar;
            let qh = 0, qt = 1;
            for (let d = 1; d <= r && qh < qt; d++) {
                const end = qt;
                while (qh < end) {
                    const l = nbs[q[qh++]];
                    if (l) for (let i = 0; i < l.length; i++) { const nb = l[i]; if (nb >= 0 && nb < H.areas && seen[nb] !== ep) { seen[nb] = ep; q[qt++] = nb; sum += arr[nb * L + lane]; } }
                }
            }
        }
    }
    return sum | 0;
}

// One unit, the whole way (new units, the selection, units the kernel
// leaves to objects): base stacks and level (its base tables made again
// when they do not fit), the nearby count, effective stacks and level, and
// its effective tables when that level changed.
// Per (owner, unit type) the version of its stat tables (research, resource
// penalties: unitStatsTablesChanged), and per unit (column esVer) the one its
// stats were applied at: a unit behind takes the tables at its next refresh
// (the kernel hands it to _effStatsFullUnit). Peer-local counts: a resync
// marks every unit current on every peer (effStatsAppliedSync).
const UNIT_STATS_VER_TYPES = 64;
let _unitStatsVer = new Int32Array(16 * UNIT_STATS_VER_TYPES);
function _unitStatsVerTable(players) {
    if (_unitStatsVer.length < players * UNIT_STATS_VER_TYPES) { const t = typeof simSharedArray === 'function' ? simSharedArray(Int32Array, players * 2 * UNIT_STATS_VER_TYPES) : new Int32Array(players * 2 * UNIT_STATS_VER_TYPES); t.set(_unitStatsVer); _unitStatsVer = t; }
    // (Into the wasm heap once it is up: the Rust kernels read it.)
    else if (typeof simSharedArray === 'function' && typeof _simHeapPtrOf !== 'undefined' && _simHeapPtrOf !== null && _simHeapPtrOf(_unitStatsVer) < 0) { const t = simSharedArray(Int32Array, _unitStatsVer.length); t.set(_unitStatsVer); _unitStatsVer = t; }
    return _unitStatsVer;
}
function unitStatsTablesChanged(owner, unitType) {
    const o = Math.floor(Number(owner)), ti = typeof spatialUnitTypeToIndex !== 'undefined' ? spatialUnitTypeToIndex[unitType] : undefined;
    if (!(o >= 0)) return;
    const T = _unitStatsVerTable(o + 1);
    if (Number.isFinite(ti) && ti >= 0 && ti < UNIT_STATS_VER_TYPES) T[o * UNIT_STATS_VER_TYPES + ti]++;
    else for (let k = 0; k < UNIT_STATS_VER_TYPES; k++) T[o * UNIT_STATS_VER_TYPES + k]++;
}
function _unitStatsVerOf(u) {
    const o = Math.floor(Number(u.owner)), ti = typeof spatialUnitTypeToIndex !== 'undefined' ? spatialUnitTypeToIndex[u.unitType] : undefined;
    if (!(o >= 0) || !(ti >= 0 && ti < UNIT_STATS_VER_TYPES) || o * UNIT_STATS_VER_TYPES + ti >= _unitStatsVer.length) return 0;
    return _unitStatsVer[o * UNIT_STATS_VER_TYPES + ti];
}
// ---- Effective stat rows ----
// A unit's effective stat tables are one of few shared objects (those of its
// owner, type, base and effective level: clonePrecomputedWithBaseMaxEnergy
// hands out the same object), kept as rows: the object (_effRowObj) and what
// the kernels need of it (eff.r* columns), found by (owner, spatial type,
// base level, effective level) in eff.rowOf and valid for the (owner, type)
// stat tables' version it was made at (eff.rowVer, as unit.esVer). A unit
// with a row (unit.statRow >= 0) reads its tables from it (Unit.preComputed);
// SIM_KERNEL_EFF_UNITS gives a unit the row of its new effective level and
// the movement columns from it (simMoveStatsChanged's); the JavaScript only
// makes rows (_effRowAttach, when it applies a unit's tables itself).
const EFF_ROW_MAX = 1 << 15;
let _effRowMeta = [];
let _effRowObj = [], _effRowN = 0, _effRowCap = 0, _effRowLk = null, _effRowLkDims = '';
const _EFF_ROW_COLS = [['rowVer', Int32Array], ['rSpd', Float32Array], ['rCost', Float32Array], ['rRD', Int32Array], ['rRA', Int32Array], ['rRK', Uint8Array],
    ['rLzW', Uint8Array], ['rCb', Float32Array], ['rCd', Float32Array], ['rDmg', Float32Array], ['rVis', Float32Array], ['rChs', Float32Array],
    // (The visibility cover's steps of a unit with the row, as _visCoverSyncUnit
    // works them out: -1 none, -2 for the JavaScript.)
    ['rVsA', Int8Array]];
const _effRowCols = {};
const EFF_HOT_WIDTH = 16;
let _effHot = null;
function _effRowDims() { return [spatialUnitsComplexPlayerCount | 0, spatialUnitsComplexUnitTypeCount | 0, (MAX_THING_LEVEL | 0) + 1]; }
// The same as numbers, and their key made when they change (every lookup of every unit made an array and a string of them).
let _effDimNP = -1, _effDimNT = -1, _effDimL1 = -1, _effDimKey = '';
function _effDimsRefresh() {
    const NP = spatialUnitsComplexPlayerCount | 0, NT = spatialUnitsComplexUnitTypeCount | 0, L1 = (MAX_THING_LEVEL | 0) + 1;
    if (NP !== _effDimNP || NT !== _effDimNT || L1 !== _effDimL1) { _effDimNP = NP; _effDimNT = NT; _effDimL1 = L1; _effDimKey = NP + ':' + NT + ':' + L1; }
    return _effDimKey;
}
function _effRowLookup() {
    const dims = _effDimsRefresh();
    if (_effRowLk === null || _effRowLkDims !== dims) {
        const NP = _effDimNP, NT = _effDimNT, L1 = _effDimL1;
        if (_effRowLk !== null) _effRowsReset();
        _effRowLk = simSharedArray(Int32Array, Math.max(1, NP * NT * L1 * L1));
        _effRowLk.fill(-1);
        _effRowLkDims = dims;
        simParallelBind('eff.rowOf', _effRowLk);
    }
    return _effRowLk;
}
function _effRowGrow(n) {
    if (n <= _effRowCap) return;
    const cap = Math.max(256, _effRowCap * 2, n);
    const hot = simSharedArray(Float32Array, cap * EFF_HOT_WIDTH);
    if (_effHot) hot.set(_effHot.subarray(0, _effRowN * EFF_HOT_WIDTH));
    _effHot = hot; simParallelBind('eff.hot', hot);
    for (const [k, T] of _EFF_ROW_COLS) {
        const a = simSharedArray(T, cap);
        if (_effRowCols[k]) a.set(_effRowCols[k].subarray(0, _effRowN));
        _effRowCols[k] = a;
        simParallelBind('eff.' + k, a);
    }
    _effRowCap = cap;
}
// Every row dropped (too many, or the lookup's dimensions changed): units
// keep their objects.
function _effRowsReset() {
    const S = typeof _simUnitState !== 'undefined' ? _simUnitState : null;
    if (S) {
        const c = S.columns, n = S.owners.length;
        for (let s = 0; s < n; s++) {
            const r = c.statRow[s];
            if (r < 0) continue;
            const u = S.owners[s];
            if (u) u._effRowKeep(_effRowObj[r]);
            c.statRow[s] = -1;
        }
    }
    _effRowObj = []; _effRowMeta = []; _effRowN = 0;
    if (_effRowLk) _effRowLk.fill(-1);
}
// ---- Base entries ----
// Per (owner, spatial type, base level): the base tables a unit of them has
// after its full path at the (owner, type) stat tables' version eff.bVer (the
// tables themselves, their window radius eff.bRad and maxEnergy: eff.bMaxE
// for the kernel, Float32 as the unit's column holds it; the double here),
// noted by the full path (_effBaseNote). A unit behind its tables whose base
// entry and new level's row are of the current version is taken in the
// kernel (SIM_KERNEL_EFF_UNITS: its full path's result; the caller gives it
// the tables and maxEnergy, flags 5 and 6): after a research ~700 units a
// tick at 105k took the full path (~4 us each, of a ~4.5 ms step).
const EFF_BASE_NONE = -2147483648;
let _effBase = { dims: '', ver: null, rad: null, maxE: null, maxE64: null, obj: [] };
function _effBaseLookup() {
    const dims = _effDimsRefresh(), B = _effBase;
    if (B.dims !== dims || !B.ver) {
        const NP = _effDimNP, NT = _effDimNT, L1 = _effDimL1;
        const n = Math.max(1, NP * NT * L1);
        B.ver = simSharedArray(Int32Array, n); B.ver.fill(EFF_BASE_NONE);
        B.rad = simSharedArray(Int32Array, n); B.maxE = simSharedArray(Float32Array, n);
        B.maxE64 = new Float64Array(n); B.obj = new Array(n).fill(null); B.dims = dims;
        simParallelBind('eff.bVer', B.ver); simParallelBind('eff.bRad', B.rad); simParallelBind('eff.bMaxE', B.maxE);
    }
    return B;
}
function _effBaseClear() {
    const B = _effBase;
    if (!B.ver) return;
    B.ver.fill(EFF_BASE_NONE);
    B.obj.fill(null);
}
function _effBaseIndex(o, ty, bl) {
    const [NP, NT, L1] = _effRowDims();
    if (!(o >= 0 && o < NP && ty >= 0 && ty < NT && bl >= 1 && bl < L1) || bl !== Math.floor(bl)) return -1;
    return (o * NT + ty) * L1 + bl;
}
// u just took its base tables at its stat tables' version (the full path).
function _effBaseNote(u) {
    const c = u && u._us;
    if (!c || typeof simSharedArray !== 'function') return;
    const s = u._si, b = u.preComputedBase;
    if (!c.esOk[s] || !b || typeof b !== 'object') return;
    const ver = c.esVer[s];
    if (ver !== _unitStatsVerOf(u)) return;
    const mx = Number(b.maxEnergy);
    if (!Number.isFinite(mx) || Number(u.maxEnergy) !== mx) return;
    const B = _effBaseLookup(), i = _effBaseIndex(c.owner[s], c.esType[s], c.baseLevel[s]);
    if (i < 0) return;
    B.obj[i] = b; B.maxE64[i] = mx; B.maxE[i] = mx; B.rad[i] = c.esRad[s]; B.ver[i] = ver;
}
// Off: units behind their tables take the full path, as before (tests:
// both ways give the same state).
let EFF_BEHIND_IN_KERNEL = true, _effBehindInKernel = 0;

// u's tables (just applied: preComputed, the effective ones) as its row.
function _effRowAttach(u) {
    const c = u && u._us;
    if (!c || typeof simSharedArray !== 'function') return;
    const s = u._si, pc = u._pc;
    if (!pc || typeof pc !== 'object' || pc !== u._pce) return;
    _effDimsRefresh();
    const NP = _effDimNP, NT = _effDimNT, L1 = _effDimL1;
    const o = c.owner[s], ty = spatialUnitTypeToIndex[u.unitType], bl = Math.max(1,c.baseLevel[s]), el = Math.max(1,c.effectiveLevel[s]);
    if (!(o >= 0 && o < NP && ty >= 0 && ty < NT && bl >= 1 && bl < L1 && el >= 1 && el < L1) || bl !== Math.floor(bl) || el !== Math.floor(el)) return;
    const lk = _effRowLookup(), key = ((o * NT + ty) * L1 + bl) * L1 + el, ver = c.esVer[s];
    let r = lk[key];
    if (!(r >= 0 && _effRowObj[r] === pc && _effRowCols.rowVer[r] === ver)) {
        if (_effRowN >= EFF_ROW_MAX) { _effRowsReset(); r = -1; }
        if (!(r >= 0)) { r = _effRowN; _effRowGrow(r + 1); _effRowN = r + 1; }
        _effRowObj[r] = pc;
        _effRowMeta[r] = { owner:o, type:u.unitType, bl, el };
        _effRowWrite(r, u, pc, ver);
        lk[key] = r;
    }
    c.statRow[s] = r;
    // The row already owns both effective tables. Keep private handles
    // empty unless a caller overrides one of the tables independently.
    c.jr__pc.clear(s); c.jr__pce.clear(s);
}

// Research/boost changes rewrite rows, never the unit list. Row handles
// remain valid for every existing instance, including sleeping SIMD lanes.
function _effRowWrite(r, u, pc, ver) {
    const R = _effRowCols, range = _getUnitAttackRangeArea(u), vis = Number(pc.visionRange);
    R.rowVer[r] = ver;
    R.rSpd[r] = pc.speed * _getUnitAstarSpeedMultiplier(u);
    R.rCost[r] = _resolveUnitAstarTileCost(u);
    R.rRD[r] = Math.ceil(range) + 1;
    R.rRA[r] = Math.ceil(Math.max(TILE, vis * TILE) / TILE) + 1;
    R.rRK[r] = Math.min(255, Math.floor(range));
    R.rLzW[r] = Math.floor(range) === Math.ceil(range) ? 1 : 0;
    R.rCb[r] = Math.max(TILE, vis * TILE);
    R.rCd[r] = pc.attackCooldown; R.rDmg[r] = pc.attackDamage; R.rVis[r] = vis;
    R.rChs[r] = Math.max(TILE * 0.6, Number(pc.speed) || 1);
    // (getEntityEffectiveVisibilityRangeArea of a unit whose effective
    // tables are pc.)
    // (Whole steps, 0 its own area: every unit sees.)
    const va = Number(pc.visionRangeArea);
    R.rVsA[r] = !Number.isFinite(va) || typeof VIS_COVER_MAX_STEPS !== 'number' ? -2 : areaSteps(va);
    // One cache line per shared level/stat row. Rust can broadcast a
    // row for equal SIMD lanes instead of streaming per-unit copies.
    _effHot.set([R.rSpd[r], R.rCost[r], R.rChs[r], R.rCb[r], R.rCd[r], R.rDmg[r], R.rVis[r], R.rRD[r], R.rRA[r], R.rRK[r], R.rVsA[r]], r * EFF_HOT_WIDTH);
}
function effSharedTablesChanged(owner, unitType) {
    const levels = PRECOMPUTED_STATS_MAP_PLAYER[owner]?.unit?.[unitType];
    if (!levels) return;
    for (let r=0;r<_effRowN;r++) {
        const m=_effRowMeta[r];
        if (!m || m.owner!==owner || m.type!==unitType) continue;
        const base=levels[m.bl], effective=levels[m.el];
        if (!base || !effective) continue;
        const next=clonePrecomputedWithBaseMaxEnergy(base,effective), pc=_effRowObj[r];
        if (pc!==next) Object.assign(pc,next);
        const u={owner,unitType,preComputed:pc,effectiveLevel:m.el,unitLevel:m.bl};
        _effRowWrite(r,u,pc,_unitStatsVerOf(u));
    }
}

// A unit's effective level from its effective stacks, sticky around the
// level it has (last): one level down only below 0.8 of its threshold, one
// up only from 1.25 of the next one's, so counts around a power of two do not
// flip it every refresh (in a battle ~1.7k units a tick at 400k took new
// tables). The kernel's twin: SIM_KERNEL_EFF_UNITS.
function _effSticky(el, effS, last) {
    if (!(last >= 1) || el === last) return el;
    // (detPow: Math.pow need not be exact, even for 2^k.)
    if (el === last - 1) return effS * 5 >= 4 * detPow(2, last - 1) ? last : el;
    if (el === last + 1) return effS * 4 < 5 * detPow(2, last) ? last : el;
    return el;
}
function _effStatsFullUnit(u) {
    let baseStacks = getUnitStackCount(u);
    let baseLevel = stackCountToLevel(baseStacks);
    const previousRow=u._us ? u._us.statRow[u._si] : -1;
    // (The effective level applied before this refresh: the sticky level's
    // reference, as the kernel twin reads it; the base refresh below applies
    // the base level's tables.)
    const lastApplied = u._lastAppliedEffectiveLevel;
    const c = u._us, ver = _unitStatsVerOf(u), behind = !!c && c.esVer[u._si] !== ver;
    if (c) c.esVer[u._si] = ver;
    let needsRefresh = behind || !Number.isFinite(u.baseLevel) || u.baseLevel !== baseLevel ||
        !(u.basePreComputed && Number.isFinite(u.basePreComputed.visionRange)) || !(u.basePreComputed && Number.isFinite(u.basePreComputed.maxEnergy));
    u.stackCount = baseStacks;
    u.unitLevel = baseLevel;
    if (needsRefresh) {
        // (The movement columns told once, by the effective scaling below,
        // which always follows a refresh: the base level's tables between
        // disarmed every unit above its base level at each refresh, as
        // _refreshThingPrecomputedStats holds them too.)
        const held = _unitStatsNotifyHeld;
        _unitStatsNotifyHeld = true;
        try { applyUnitLevelScaling(u, baseLevel); } finally { _unitStatsNotifyHeld = held; }
        u.stackCount = baseStacks;
        _effBaseNote(u);
    } else if (u._us && !u._us.esOk[u._si]) effStatsUnitBaseChanged(u);
    // (Its range's count from the period's snapshot.)
    _effAreaHistEnsure(Math.max(0, Math.floor(Number(gameTime) || 0)), getUnitEffectiveStatsRecalcTicks());
    let similarCount = _effAreaCount(u);
    if (similarCount < 1) similarCount = 1;
    let effStacks = Math.max(1, Math.floor(similarCount * baseStacks));
    u.effectiveStacks = effStacks;
    u.effectiveLevel = _effSticky(stackCountToLevel(effStacks), effStacks, lastApplied);
    let nextEffLevel = getUnitEffectiveLevel(u);
    if (needsRefresh || lastApplied !== nextEffLevel) {
        applyUnitEffectiveScaling(u, nextEffLevel, previousRow);
        u._lastAppliedEffectiveLevel = nextEffLevel;
    }
}

// Units' effective level: the strided share of the units (1/intervalTicks
// of them a tick, by index; a new unit has its turn like the others; the
// selection too, as in multiplayer: no per-tick pass over it). The strided
// share runs in the kernels from the columns
// (SIM_KERNEL_EFF_UNITS: stacks, levels, nearby counts); only units whose
// effective level changed (their effective tables), and units the columns
// cannot answer for, are touched as objects, in the share's order.
let _effFlags = null;
function recalculateUnitEffectiveLevel() {
    let intervalTicks = getUnitEffectiveStatsRecalcTicks();
    let tick = Math.max(0, Math.floor(Number(gameTime) || 0));
    let stamp = ++_effectiveStatsStamp;
    // (Changed stat tables: each unit behind takes them at its refresh, see
    // _unitStatsVerOf; not every unit at once.)
    const S = typeof _simUnitState !== 'undefined' ? _simUnitState : null;
    const taken = u => {
        if (!u || u.dead) return true;
        const c = u._us;
        if (c) { if (c.esTaken[u._si] === stamp) return true; c.esTaken[u._si] = stamp; return false; }
        if (u._effectiveStatsStamp === stamp) return true;
        u._effectiveStatsStamp = stamp;
        return false;
    };
    // The strided share. Units behind their stat tables (a research done:
    // every unit of the type) are taken in the kernel from their (owner, type,
    // base level)'s base entry and their new level's row; the first of a key
    // without them this tick takes the full path, which makes both, and the
    // kernel runs again for the rest (no cap: the whole share this tick; which
    // path takes one decides nothing).
    const behindNow = u => { const c = u._us; return !!c && c.esVer[u._si] !== _unitStatsVerOf(u); };
    const takenNow = u => { const c = u._us; return c ? c.esTaken[u._si] === stamp : u._effectiveStatsStamp === stamp; };
    let step = Math.max(1, intervalTicks | 0), phase = tick % step, n = units.length;
    let m = phase < n ? Math.ceil((n - phase) / step) : 0;
    const hist = m > 0 && S && typeof SIM_KERNEL_EFF_UNITS === 'number' && n >= EFF_STATS_KERNEL_MIN_UNITS ? _effAreaHistEnsure(tick, step) : null;
    if (hist) {
        const slots = _unitSlotMapEnsure(), c = S.columns;
        if (!_effFlags || _effFlags.length < m) { _effFlags = simSharedArray(Uint8Array, Math.max(1024, m * 2)); simParallelBind('eff.flag', _effFlags); }
        simParallelBind('ix.slots', slots); _simAreaCsr();
        const P = _simParams;
        // (64 a job: a unit's counts are a few reads, but its row is costly; 1024 left
        // a few long jobs and most helpers idle, 256 a ~0.15 ms tail.)
        P[0] = m; P[1] = 64; P[2] = step; P[3] = phase; P[5] = hist.areas; P[6] = hist.lanes;
        P[8] = spatialUnitsComplexUnitTypeCount; P[9] = spatialUnitsComplexPlayerCount;
        P[10] = MAX_THING_LEVEL; P[11] = stamp;
        // (Stat rows: the kernel gives a unit of a new level its row.)
        _effRowLookup(); _effRowGrow(1);
        P[18] = _effRowN; P[19] = SIM_MOVE_BOX_STEPS;
        // (-1: no per-unit cover registration; units' sight is the vision kernels' (vis.rs).)
        P[20] = -1; P[21] = 0; P[22] = SIM_SEP_ABSENT;
        simParallelBind('eff.tver', _unitStatsVerTable(spatialUnitsComplexPlayerCount)); P[14] = UNIT_STATS_VER_TYPES;
        _effBaseLookup();
        // (Off: the full path for every unit behind, the tests' reference.)
        P[23] = EFF_BEHIND_IN_KERNEL ? m : 0; P[24] = 0;
        // (The upkeep bins, when kept: main.js _upkU.)
        const UK = typeof _upkU !== 'undefined' && _upkU && _upkU.cols === c && _upkU.cnt === _upkHist ? _upkU : null;
        P[12] = UK ? UK.np : 0; P[13] = UK ? UK.L1 : 0; P[17] = UK && _simParReg['upk.h'] ? _simParReg['upk.h'].length : 0;
        _effPSave.set(P.subarray(0, 32));
        simParallelRun(SIM_KERNEL_EFF_UNITS, Math.ceil(m / 64));
        // (Keys whose entry the full path made this tick: _effKeySeen, by stamp.)
        const NK = _effDimNP * _effDimNT * _effDimL1;
        if (!_effKeySeen || _effKeySeen.length < NK) _effKeySeen = new Int32Array(Math.max(64, NK));
        let again = false;
        for (let pass = 0; pass < 2; pass++) {
            // (The full path ran kernels of its own (the shared parameters) and made rows.)
            if (pass === 1) { if (!again) break; P.set(_effPSave); _effRowGrow(1); P[18] = _effRowN; simParallelRun(SIM_KERNEL_EFF_UNITS, Math.ceil(m / 64)); }
            const F = _effFlags;
            for (let j = 0; j < m; j++) {
                const f = F[j];
                if (f === 0 || f === 3 || f === 4) continue;
                const i = phase + j * step, u = units[i];
                if (f === 5 || f === 6) {
                    // (Behind its tables, taken in the kernel from its base entry
                    // and row: the base tables and maxEnergy, as its full path
                    // sets them.)
                    const s = slots[i], B = _effBase, bi = _effBaseIndex(c.owner[s], c.esType[s], c.baseLevel[s]);
                    const b = B.obj[bi];
                    u.preComputedBase = b;
                    u.basePreComputed = b;
                    u.maxEnergy = B.maxE64[bi];
                    _effBehindInKernel++;
                } else if (f === 1) {
                    // (The kernel set its stacks and levels.)
                    const s = slots[i], lvl = c.effectiveLevel[s];
                    applyUnitEffectiveScaling(u, lvl);
                    c._lastAppliedEffectiveLevel[s] = lvl;
                } else if (u && !u.dead && !takenNow(u)) {
                    // (Behind, its key's entry made by another this tick: the kernel's again.)
                    if (pass === 0 && behindNow(u)) {
                        const s = slots[i], bi = s >= 0 ? _effBaseIndex(c.owner[s], c.esType[s], c.baseLevel[s]) : -1;
                        if (bi >= 0 && _effKeySeen[bi] === stamp) { again = true; continue; }
                        if (bi >= 0) _effKeySeen[bi] = stamp;
                    }
                    if (!taken(u)) _effStatsFullUnit(u);
                }
            }
        }
    } else {
        for (let i = phase; i < n; i += step) {
            const u = units[i];
            if (!u || u.dead || takenNow(u)) continue;
            if (!taken(u)) _effStatsFullUnit(u);
        }
    }
}
// From this many units the strided share runs in the kernels (tests lower
// it; both ways give the same state).
let EFF_STATS_KERNEL_MIN_UNITS = 2048;
let _effKeySeen = null;
const _effPSave = new Float64Array(32);

// ============================================================
// BUILDING PLACEMENT & DESTRUCTION
// ============================================================
function _areaHasForeignBuildPresence(areaId, playerId) {
    let aId = Math.floor(Number(areaId));
    if (!(aId >= 0)) return false;

    let unitBucket = spatialUnitsByArea[aId];
    if (unitBucket instanceof Set) {
        for (let u of unitBucket) {
            if (!u || u.dead || u.owner === playerId) continue;
            return true;
        }
    }

    let area = getAreaById(aId);
    let areaCells = _getCanonicalAreaCellsById(aId, area);
    if (areaCells.length <= 0) return false;
    for (let cellPos of areaCells) {
        let ref = getTileEntityRef(cellPos.x, cellPos.y);
        if (!ref) continue;
        if (!Number.isFinite(ref.owner) || ref.owner < 0 || ref.owner === playerId) continue;
        return true;
    }
    return false;
}

function _isBuildAreaContested(gx, gy, playerId) {
    return _areaHasForeignBuildPresence(getAreaIdAtTile(gx, gy), playerId);
}

function canBuildAt(gx, gy, playerId) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
    if (!isTileActuallyVisibleToPlayer(playerId, gx, gy)) return false;
    if (!(isMultiplayer && gameStarted) && _isBuildAreaContested(gx, gy, playerId)) return false;
    if (grid[gy][gx].type === TYPE_WALL) return false;
    if (grid[gy][gx].item) return false;
    // (A tower under construction stands on a floor tile.)
    if (getTileEntityRef(gx, gy)) return false;
    // Don't allow building on gold mines
    if (getGoldMineAt(gx, gy)) return false;
    if (getAstarMineAt(gx, gy)) return false;
    // Check within 5 tiles of any fully-built owned building
    /*
    // distance thing disabled for now.
    for (let t of towers) { if (t.owner === playerId && !t.underConstruction && Math.abs(t.gx - gx) + Math.abs(t.gy - gy) <= 5) return true; }
    for (let b of barracks) { if (b.owner === playerId && !b.underConstruction && Math.abs(b.gx - gx) + Math.abs(b.gy - gy) <= 5) return true; }
    for (let s of collectorSpawners) { if (s.owner === playerId && !s.underConstruction && Math.abs(s.gx - gx) + Math.abs(s.gy - gy) <= 5) return true; }
    // Check floor items too (exclude under-construction)
    for (let y2 = 0; y2 < GRID_H; y2++) for (let x2 = 0; x2 < GRID_W; x2++) {
        if (grid[y2][x2].item && !grid[y2][x2].item.underConstruction && grid[y2][x2].owner === playerId && Math.abs(x2 - gx) + Math.abs(y2 - gy) <= 5) return true;
    }
    return false;
    */
    return true
}

function canStackAt(gx, gy, itemKey, playerId) {
    // Check if we can stack on an existing same-type building
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
    let pid = Math.floor(Number(playerId));
    let isVisible = isTileActuallyVisibleToPlayer(pid, gx, gy);
    if (!isVisible) return false;

    if (!(isMultiplayer && gameStarted) && _isBuildAreaContested(gx, gy, pid)) return false;
    let cardDef = BASE_CARD_TYPES[itemKey];
    if (!cardDef) return false;
    if (cardDef.target === 'wall') {
        let t = getTowerAtTile(gx, gy);
        let ok = !!(t && t.type === itemKey && Math.floor(Number(t.owner)) === pid);
        if (!ok && t && t.type === itemKey && simStepCrosses(0, 20)) {
             console.warn(`canStackAt: owner mismatch for tower. t.owner: ${t.owner}, pid: ${pid}`);
        }
        return ok;
    }
    if (itemKey.startsWith('barrack_')) {
        let unitType = cardDef.unitType || 'norm';
        let b = getBarrackAtTile(gx, gy);
        let ok = !!(b && b.unitType === unitType && Math.floor(Number(b.owner)) === pid);
        if (!ok && b && b.unitType === unitType && simStepCrosses(0, 20)) {
             console.warn(`canStackAt: owner mismatch for barrack. b.owner: ${b.owner}, pid: ${pid}`);
        }
        return ok;
    }
    if (itemKey === 'spawner' || itemKey === 'astar_spawner' || itemKey === 'salvager' || itemKey === 'builder_spawner' || itemKey === 'healer_spawner' || itemKey === 'research') {
        let s = getSpawnerAtTile(gx, gy);
        let ok = !!(s && s.type === itemKey && Math.floor(Number(s.owner)) === pid);
        if (!ok && s && s.type === itemKey && simStepCrosses(0, 20)) {
             console.warn(`canStackAt: owner mismatch for spawner. s.owner: ${s.owner}, pid: ${pid}`);
        }
        return ok;
    }
    // Floor items
    let cell = grid[gy][gx];
    let ok = !!(cell.item && cell.item.type === itemKey && Math.floor(Number(cell.owner)) === pid);
    if (!ok && cell.item && cell.item.type === itemKey && simStepCrosses(0, 20)) {
         console.warn(`canStackAt: owner mismatch for floor item. cell.owner: ${cell.owner}, pid: ${pid}`);
    }
    return ok;
}

const AREA_LEVEL_COLORS = ['#888', '#4f4', '#4af', '#c4f', '#f90', '#fd0'];
const AREA_LEVEL_NAMES = ['Gray', 'Green', 'Blue', 'Purple', 'Orange', 'Gold'];

function getAreaUpgradeCost(currentLevel) {
    return Math.floor(100 * detPow(3, currentLevel));
}

function placeBuilding(gx, gy, itemKey, playerId, defaults = null) {
    let cardDef = BASE_CARD_TYPES[itemKey];
    if (!cardDef) return false;
    let placedNewStructure = false;
    let placedNewWallStructure = false;

    // Simulation code must not read this client's UI toggles (they differ
    // between players); the placing player's choice travels in the action.
    let useDefaultAutoUpgrade = true;
    let useDefaultBuild = true;
    let silentPlace = false;
    let ignorePlacementRules = false;
    if (defaults && typeof defaults === 'object') {
        if (defaults.autoUpgradeEnabled !== undefined) useDefaultAutoUpgrade = !!defaults.autoUpgradeEnabled;
        if (defaults.buildEnabled !== undefined) useDefaultBuild = !!defaults.buildEnabled;
        if (defaults.silent !== undefined) silentPlace = !!defaults.silent;
        if (defaults.ignorePlacementRules !== undefined) ignorePlacementRules = !!defaults.ignorePlacementRules;
    }

    // The building limit (getPlayerStructureLimit): a new structure on an
    // empty tile only; stacking or upgrading one in place still works.
    if (!ignorePlacementRules && playerId >= 0 && typeof playerStructureCount === 'function'
        && !getTileEntityRef(gx, gy) && playerStructureCount(playerId) >= getPlayerStructureLimit()) return false;

    if (itemKey.startsWith('cloud_')) {
        let hasSameCloud = towers.some(t => t.owner === playerId && t.type === itemKey && t.energy > 0);
        if (hasSameCloud) return false;
    }

    // Area upgrader: special handling
    if (itemKey === 'area_upgrader') {
        let aId = grid[gy][gx].areaId;
        if (aId === -1) return false;
        if (_areaHasForeignBuildPresence(aId, playerId)) return false;
        let area = getAreaById(aId);
        if (!area) return false;
        let areaCells = _getCanonicalAreaCellsById(aId, area);
        if (areaCells.length <= 0) return false;
        // Check if ALL cells in area are occupied by any building/item (any owner)
        let allFilled = areaCells.every(cp => {
            if (!cp || !Number.isFinite(cp.x) || !Number.isFinite(cp.y)) return false;
            let c = grid[cp.y][cp.x];
            if (!c) return false;
            if (c.type === TYPE_WALL) {
                let t = getTowerAtTile(cp.x, cp.y);
                if (t && !t.underConstruction && getDisplayLevel(t) > 0) return true;
            }
            if (c.item && !c.item.underConstruction && getDisplayLevel(c.item) > 0) return true;
            let b = getBarrackAtTile(cp.x, cp.y);
            if (b && !b.underConstruction && getDisplayLevel(b) > 0) return true;
            let s = getSpawnerAtTile(cp.x, cp.y);
            if (s && !s.underConstruction && getDisplayLevel(s) > 0) return true;
            return false;
        });
        if (!allFilled) return false;
        if ((area.multiplierLevel || 0) >= 5) return false;
        let upgradeCost = getAreaUpgradeCost(area.multiplierLevel || 0);
        addPlayerResource(playerId, 'energy', -upgradeCost);
        recordEnergyDelta(playerId, 'builder', -upgradeCost);
        area.multiplierLevel = (area.multiplierLevel || 0) + 1;
        if (_adjL.mul && area.id >= 0 && area.id < _adjL.mul.length) _adjL.mul[area.id] = area.multiplierLevel;
        dirtyAreas = true;
        _markCombinedBgAreaDirty(aId, 1);
        for (let cp of areaCells) {
            if (!cp || !Number.isFinite(cp.x) || !Number.isFinite(cp.y)) continue;
            requestAdjacencyRecalc(cp.x, cp.y, 0);
        }
        recalculateAdjacency({ passiveRefresh: true });
        if (playerId === localPlayerId && !silentPlace) playSound('place', gx * TILE + 16, gy * TILE + 16);
        return true;
    }

    // Allow startup/bootstrap spawns to bypass visibility/normal placement gates.
    // This keeps configured starter spawns deterministic even under fog/contested checks.
    if (!ignorePlacementRules) {
        // Allow stacking on existing same-type buildings, otherwise check canBuildAt
        if (!canStackAt(gx, gy, itemKey, playerId) && !canBuildAt(gx, gy, playerId)) return false;
    }

    if (cardDef.target === 'wall') {
        // Tower - check if same type exists for stacking
        let existing = getTowerAtTile(gx, gy);
        if (!(existing && existing.type === itemKey && existing.owner === playerId)) existing = null;
        if (existing) { existing.upgrade(); }
        else {
            // (Its tile turns into a wall when it is built: structureWallSync.
            // Under construction every unit walks over it.)
            grid[gy][gx].owner = playerId;
            let t = new Tower(gx, gy, itemKey, playerId);
            t.underConstruction = true; t.energy = 1;
            t.autoUpgradeEnabled = useDefaultAutoUpgrade;
            t.buildEnabled = useDefaultBuild;
            t.level = 0; t.effectiveLevel = 0; t.potentialEffectiveLevel = 0;
            t.updateTextCache();
            structListPush(towers, t); towerJoinedOrLeft(t);
            setTileEntity(gx, gy, itemKey, t);
            placedNewStructure = true;
            placedNewWallStructure = true;
        }
        _markCombinedBgTileDirty(gx, gy, 0, true);
    } else if (itemKey.startsWith('barrack_')) {
        let unitType = cardDef.unitType || 'norm';
        let existing = getBarrackAtTile(gx, gy);
        if (!(existing && existing.unitType === unitType && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let b = new Barrack(gx, gy, playerId, unitType);
            b.underConstruction = true; b.energy = 1;
            b.autoUpgradeEnabled = useDefaultAutoUpgrade;
            b.buildEnabled = useDefaultBuild;
            b.level = 0; b.effectiveLevel = 0; b.potentialEffectiveLevel = 0;
            updateItemTextCache(b);
            structListPush(barracks, b); barracksChanged();
            grid[gy][gx].item = b;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, b);
            placedNewStructure = true;
        }
    } else if (itemKey === 'spawner') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'spawner' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new CollectorSpawner(gx, gy, playerId);
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            structListPush(collectorSpawners, s); collectorSpawnersChanged();
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else if (itemKey === 'astar_spawner') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'astar_spawner' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new AstarSpawner(gx, gy, playerId);
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            structListPush(collectorSpawners, s); collectorSpawnersChanged();
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else if (itemKey === 'salvager') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'salvager' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new SalvagerSpawner(gx, gy, playerId);
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            structListPush(collectorSpawners, s); collectorSpawnersChanged();
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else if (itemKey === 'builder_spawner') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'builder_spawner' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new BuilderSpawner(gx, gy, playerId);
            // builder spawner starts under construction too
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            structListPush(collectorSpawners, s); collectorSpawnersChanged();
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else if (itemKey === 'healer_spawner') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'healer_spawner' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new HealerSpawner(gx, gy, playerId);
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            structListPush(collectorSpawners, s); collectorSpawnersChanged();
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else if (itemKey === 'research') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'research' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new ResearchSpawner(gx, gy, playerId);
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            structListPush(collectorSpawners, s); collectorSpawnersChanged();
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else {
        // Floor item
        let cell = grid[gy][gx];
        if (cell.item && cell.item.type === itemKey && cell.owner === playerId) {
            addManualStackToThing(cell.item, 1);
        } else {
            let stats = calculateItemStats(itemKey, 1, playerId);
            let item = Object.assign(new FloorItem(), { type: itemKey, stacks: 1, manualStacks: 1, effectiveStacks: 1, level: 0, effectiveLevel: 0, potentialEffectiveLevel: 0, isStacking: false, stackingWorkDone: 0, energy: 1, maxEnergy: stats.maxEnergy, damage: stats.damage || 0, gx, gy, x: gx * TILE + 16, y: gy * TILE + 16, underConstruction: true, owner: playerId, markedForSalvage: false, autoUpgradeEnabled: useDefaultAutoUpgrade, buildEnabled: useDefaultBuild });
            cell.item = item;
            cell.owner = playerId;
            setTileEntity(gx, gy, itemKey, item);
            updateItemTextCache(item);
            placedNewStructure = true;
        }
    }
    // Newly placed structures start under construction, so they don't affect adjacency yet.
    // Avoid expensive full-map adjacency recalculation on every placement.
    if (placedNewStructure) _bumpPathTopologyVersion();
    if (placedNewWallStructure) markLaserConnectionsDirty(gx, gy);
    if (playerId === localPlayerId && !silentPlace) playSound('place', gx * TILE + 16, gy * TILE + 16);
    return true;
}

// Structures destroyed (world model W5): the tiles in list[0..n) (a heap
// Int32Array: the hit kernels' dead lists), in its order; deadOnly: only those
// out of energy. The tables' side (the per-tile structure table, cells, walls
// becoming ground, adjacency marks, work versions, the journal, the movement
// kernel's codes, trap marks) by one kernel over the batch (dst.rs
// k_struct_destroy); here only the rows' objects (the lists, their rows),
// the events of systems not yet kernels (walls, walk classes, reservations)
// and presentation, then once a batch the versions and checks.
const _dst = { cap: 0, tiles: null, hdr: null, walls: null, resv: null, ocnt: null, one: null, objs: [], P: new Float64Array(24) };
function _dstRoom(n) {
    const D = _dst;
    if (D.cap < n || !simHeapHas(D.tiles)) {
        const cap = Math.max(1024, n * 2);
        D.tiles = simSharedArray(Int32Array, cap); D.walls = simSharedArray(Int32Array, cap);
        D.resv = simSharedArray(Int32Array, cap * 2 * _WORKER_TARGET_LOAD_TYPE_COUNT);
        D.hdr = simSharedArray(Int32Array, 16); D.ocnt = simSharedArray(Int32Array, 64); D.one = simSharedArray(Int32Array, 1);
        D.cap = cap;
    }
    return D;
}
// (quiet: floor items cleared, the status tick's: no explosion or sound, no
// route or win changes.)
function structDestroyTiles(list, n, deadOnly = false, quiet = false) {
    if (!(n > 0)) return 0;
    const D = _dstRoom(n), objs = D.objs, T = _ST;
    let m = 0, adj = false;
    for (let i = 0; i < n; i++) {
        const t = list[i], gx = t % GRID_W, gy = (t - gx) / GRID_W, e = getTileEntityRef(gx, gy);
        if (!e || e._stMine || !(e._stT === t) || (deadOnly && !(e.energy <= 0))) continue;
        if (e instanceof Tower || (BASE_CARD_TYPES[e.type] && BASE_CARD_TYPES[e.type].target === 'wall')) { if (structListRemove(towers, e) !== -1) towerJoinedOrLeft(e); adj = true; }
        else if (e instanceof Barrack || e.type === 'barrack') { if (structListRemove(barracks, e) !== -1) barracksChanged(); adj = true; }
        else if (isSpawnerEntity(e)) { if (structListRemove(collectorSpawners, e) !== -1) collectorSpawnersChanged(); }
        // (Off its tile: a second entry of the list finds nothing.)
        e._stT = -1; grid[gy][gx]._item = null;
        D.tiles[m] = t; objs[m++] = e;
    }
    if (m === 0) return 0;
    if (!simHeapHas(T.code)) structTablesRehome();
    const AD = _adjacencyDirtyTiles; AD.room(GRID_W * GRID_H);
    const V = _workerWorkTable(), L = _teLogRoom();
    const mvOk = !!_simMoveStruct && !!_simMoveStructBlocks && _simMoveStructP === spatialUnitsComplexPlayerCount && _simMoveStructC === spatialBlockCols && _simMoveStructW === GRID_W && _simMoveStructH === GRID_H;
    const trapOk = !!_trap.dirty && simHeapHas(_trap.dirty);
    const P = D.P;
    P[0] = m; P[1] = GRID_W; P[2] = GRID_H; P[3] = SNAP_REGION_TILES; P[4] = T.rw; P[5] = TYPE_WALL; P[6] = TYPE_FLOOR; P[7] = AD.flag.length;
    P[8] = V.np; P[9] = _WORKER_WORK_TYPES.length; P[10] = V.rw; P[11] = V.rh; P[12] = WORKER_WORK_REGION_TILES; P[13] = _teLogEnd;
    P[14] = spatialUnitsComplexPlayerCount; P[15] = spatialBlockCols; P[16] = SPATIAL_BLOCK_SIZE * CHUNK_SIZE; P[17] = trapOk ? (_trap.all ? -1 : _trap.nd) : -1;
    P[18] = _WORKER_TARGET_LOAD_TYPE_COUNT; P[19] = m * _WORKER_TARGET_LOAD_TYPE_COUNT; P[20] = L.length; P[21] = trapOk ? _trap.dirty.length : 0;
    const resvOk = simHeapHas(workerReservedTiles) && workerReservedTiles.length === GRID_W * GRID_H * _WORKER_TARGET_LOAD_TYPE_COUNT;
    simRustDirect('k_struct_destroy', [D.tiles, T.code, T.own, T.uc, T.val, T.tim, T.brain, T.rtab, T.stab, T.rrow, T.ctab, T.rcnt, T.cnt, cellType, cellOwner,
        AD.flag, AD.blk, V, L, mvOk ? _simMoveStruct : null, mvOk ? _simStructCls : null, mvOk ? _simMoveStructBlocks : null, trapOk ? _trap.dirty : null,
        resvOk ? workerReservedTiles : null, D.hdr, D.walls, D.resv, D.ocnt], P);
    const H = D.hdr;
    // The batch's counters.
    _tileEntityVersion++;
    _teLogEnd = H[6]; _teLogBase = Math.max(0, _teLogEnd - L.length);
    V.sum = (V.sum + H[4]) | 0;
    if (H[1] > 0) { if (AD.n === 0 || H[3] < AD.min) AD.min = H[3]; AD.n += H[1]; AD.sum = (AD.sum + H[2]) | 0; }
    _adjacencyNeedsRecalc = true;
    if (trapOk) { if (H[5] < 0) _trap.all = true; else _trap.nd = H[5]; }
    for (let o = 0; o < 64; o++) if (D.ocnt[o]) structCountByOwner[o] += D.ocnt[o];
    // Events of the systems that are not tables yet.
    for (let r = 0, nr = H[7]; r < nr; r++) {
        const slot = D.resv[r * 2], u = workerReservedAt(slot);
        if (u) u._workerReservedTileIndex = -1;
        workerReservedSet(slot, null);
    }
    for (let i = 0; i < m; i++) { const t = D.tiles[i]; if (_unitPassOn) _simClassQ.push(t); else _simMoveClassTileChanged(t); }
    for (let i = 0, nw = H[0]; i < nw; i++) { const t = D.walls[i], gx = t % GRID_W; simMoveTileTypeChanged(gx, (t - gx) / GRID_W); }
    for (let i = 0; i < m; i++) {
        const e = objs[i], t = D.tiles[i], gx = t % GRID_W, gy = (t - gx) / GRID_W;
        objs[i] = null;
        structRowDetach(e);
        _markCombinedBgTileDirty(gx, gy, 0, e instanceof Tower);
        if (quiet) continue;
        createExplosion(e.x, e.y, '#f44', 10);
        playSound('building_destroyed', e.x, e.y);
    }
    if (adj || quiet) recalculateAdjacency();
    if (quiet) return m;
    // A freed tile: walls, builder passage and routes change.
    _bumpPathTopologyVersion();
    // (Once a tick, at its end: a scan of the assets per destroyed building
    // was O(buildings) each.)
    if (typeof _inGameTick !== 'undefined' && _inGameTick) _winCheckDue = true; else checkWinCondition();
    return m;
}
// A list for callers that gather tiles (not the batch's own).
let _dstExt = null;
function structDestroyList(n) {
    if (!_dstExt || _dstExt.length < n || !simHeapHas(_dstExt)) _dstExt = simSharedArray(Int32Array, Math.max(256, n * 2));
    return _dstExt;
}
function destroyBuilding(building) {
    if (!building || !(building._stT >= 0)) return;
    const D = _dstRoom(1);
    D.one[0] = building._stT;
    structDestroyTiles(D.one, 1);
}
let _winCheckDue = false;


// ============================================================
// ITEM STATS
// ============================================================
function getUpgrademaxEnergy(item, nextLevel) {
    if (item.type === 'barrack' || (item.type && item.type.startsWith('barrack'))) {
        let bType = item.unitType ? ('barrack_' + item.unitType) : 'barrack_norm';
        return calculateItemStats(bType, nextLevel, item.owner).maxEnergy;
    }
    if (item.type === 'spawner' || item.type === 'astar_spawner' || item.type === 'salvager' || item.type === 'builder_spawner' || item.type === 'healer_spawner' || item.type === 'research') return calculateItemStats(item.type, nextLevel, item.owner).maxEnergy;
    if (item instanceof Tower) return calculateItemStats(item.type, nextLevel, item.owner).maxEnergy;
    return calculateItemStats(item.type || 'farm', nextLevel, item.owner).maxEnergy;
}

function getThingResearchBuildingKey(item) {
    if (!item || !item.type) return '';
    if (item.type === 'barrack') return `barrack_${item.unitType || 'norm'}`;
    return String(item.type || '');
}

function getThingResearchedMaxLevel(item) {
    if (!item) return Math.max(1, MAX_THING_LEVEL);
    let key = getThingResearchBuildingKey(item);
    if (!key) return Math.max(1, MAX_THING_LEVEL);
    let owner = Number.isFinite(item.owner) ? Math.floor(item.owner) : -1;
    if (owner < 0 || typeof getPlayerResearchLevel !== 'function') return 1;
    let researchedLevel = Math.max(0, Math.floor(getPlayerResearchLevel(owner, 'building', key, 'maxLevel') || 0));
    return Math.max(1, Math.min(MAX_THING_LEVEL, 1 + Math.round(researchedLevel * (MAX_THING_LEVEL - 1) / Math.max(1, MAX_RESEARCH_LEVEL))));
}

function beginUpgradeProgress(item, nextLevel) {
    if (!item) return;
    let targetLevel = Math.max(1, clampThingLevel(Math.floor(Number(nextLevel) || 1)));
    if (targetLevel > getThingResearchedMaxLevel(item)) return;
    let targetmaxEnergy = Math.max(1, Math.floor(getUpgrademaxEnergy(item, nextLevel) || (item.maxEnergy || 1)));
    item.isUpgrading = true;
    item.isStacking = false;
    item.upgrademaxEnergy = targetmaxEnergy;
    item.maxEnergy = targetmaxEnergy;
    if (!Number.isFinite(item.energy) || item.energy < 1) item.energy = 1;
    item.energy = Math.min(item.energy, item.maxEnergy);
}

function getDisplayLevel(item) {
    if (!item) return 1;
    if (item.underConstruction) return 0;
    if (item.effectiveLevel !== undefined) return clampThingLevel(item.effectiveLevel);
    if (item.level !== undefined) return clampThingLevel(item.level);
    return stackCountToLevel(item.stacks || 1);
}

function getRequiredStacksForLevel(level) {
    let lvl = Math.max(1, clampThingLevel(Math.floor(Number(level) || 1)));
    return Math.max(1, Math.round(detPow(2, lvl - 1)));
}

function getThingStackedStacks(item) {
    if (!item) return 1;
    return Math.max(1, Math.floor(Number(item.stacks) || 1));
}

function getThingManualStacks(item) {
    if (!item) return 1;
    let stacked = getThingStackedStacks(item);
    let manual = Number.isFinite(item.manualStacks) ? Math.floor(item.manualStacks) : stacked;
    return Math.max(stacked, Math.max(1, manual));
}

function getThingRemainingStacks(item) {
    return Math.max(0, getThingManualStacks(item) - getThingStackedStacks(item));
}

function getThingStackingProgressRatio(item) {
    let stacked = getThingStackedStacks(item);
    let total = getThingManualStacks(item);
    if (total <= 0) return 1;
    let stackCost = getThingStackingEnergyCost(item);
    let partial = 0;
    if (stackCost > 0) {
        let work = Math.max(0, Number(item && item.stackingWorkDone) || 0);
        partial = Math.max(0, Math.min(1, work / stackCost));
    }
    let progressStacks = Math.min(total, stacked + partial);
    return Math.max(0, Math.min(1, progressStacks / total));
}

function getThingStackingRemainingEnergy(item) {
    if (!item) return 0;
    let remainingStacks = getThingRemainingStacks(item);
    if (remainingStacks <= 0) return 0;
    let stackCost = getThingStackingEnergyCost(item);
    let done = Math.max(0, Number(item.stackingWorkDone) || 0);
    return Math.max(0, remainingStacks * stackCost - done);
}

function getThingStackingEnergyCost(item) {
    if (!item) return 1;
    let baseEnergy = getUpgrademaxEnergy(item, 1);
    if (!Number.isFinite(baseEnergy) || baseEnergy <= 0) baseEnergy = item.maxEnergy || 1;
    return Math.max(1, Math.floor(baseEnergy));
}

function refreshThingProgressState(item) {
    if (!item) return;

    item.stacks = getThingStackedStacks(item);
    item.manualStacks = getThingManualStacks(item);
    if (!Number.isFinite(item.stackingWorkDone) || item.stackingWorkDone < 0) item.stackingWorkDone = 0;

    let hasPendingStacks = getThingRemainingStacks(item) > 0;
    if (item.underConstruction || item.isUpgrading) {
        item.isStacking = false;
        return;
    }

    let baseLevel = getThingBaseLevel(item);
    let effLevel = getThingEffectiveLevel(item, baseLevel);
    let researchedMaxLevel = getThingResearchedMaxLevel(item);
    let maxAutoUpgradeLevel = Math.min(effLevel, researchedMaxLevel);
    if (baseLevel < maxAutoUpgradeLevel && isAutoUpgradeEnabled(item)) {
        beginUpgradeProgress(item, baseLevel + 1);
        item.isStacking = false;
        return;
    }

    item.isStacking = false;
    if (hasPendingStacks && isAutoStackEnabled(item)) {
        // Only stack if next stack level won't exceed max level
        let nextStackLevel = stackCountToLevel(getThingStackedStacks(item) + 1);
        let maxLevel = getThingResearchedMaxLevel(item);
        item.isStacking = nextStackLevel <= maxLevel;
    }
    if (!item.isStacking) item.stackingWorkDone = 0;
    if (!item.underConstruction && !item.isUpgrading && !item.isStacking && Number.isFinite(item.gx) && Number.isFinite(item.gy)) {
        let builderTypeIndex = _workerTypeToLoadIndex('builder');
        let tileIndex = Math.floor(item.gy) * GRID_W + Math.floor(item.gx);
        let slotIndex = tileIndex * _WORKER_TARGET_LOAD_TYPE_COUNT + builderTypeIndex;
        let reservedUnit = workerReservedAt(slotIndex);
        if (reservedUnit) reservedUnit._workerReservedTileIndex = -1;
        workerReservedSet(slotIndex, null);
    }
}

function addManualStackToThing(item, amount = 1) {
    if (!item) return;
    let addCount = Math.max(1, Math.floor(Number(amount) || 1));
    item.stacks = getThingStackedStacks(item);
    item.manualStacks = getThingManualStacks(item) + addCount;
    item.level = stackCountToLevel(item.stacks);
    if (typeof upkeepThingDirty === 'function') upkeepThingDirty(item);
    if (Number.isFinite(item.gx) && Number.isFinite(item.gy)) {
        _requestAdjacencyRecalcForThing(item, 1);
        recalculateAdjacency();
    }
    refreshThingProgressState(item);
    if (item.updateTextCache) item.updateTextCache();
    else updateItemTextCache(item);
    bumpTileOccupancyVersion();
    visCoverOnBuildingChanged(item);
}

function getThingBaseLevel(item, fallback = 1) {
    if (!item) return Math.max(1, clampThingLevel(fallback));
    if (Number.isFinite(item.level)) return Math.max(1, clampThingLevel(item.level));
    if (Number.isFinite(item.stacks)) return stackCountToLevel(item.stacks || 1);
    return Math.max(1, clampThingLevel(fallback));
}

function getThingEffectiveLevel(item, fallback = 1) {
    if (!item) return Math.max(1, clampThingLevel(fallback));
    if (Number.isFinite(item.effectiveLevel)) return Math.max(1, clampThingLevel(item.effectiveLevel));
    return getThingBaseLevel(item, fallback);
}

function getThingPotentialLevel(item, fallback = 1) {
    let lvl = getThingEffectiveLevel(item, fallback);
    if (!item) return lvl;
    if (Number.isFinite(item.potentialEffectiveLevel)) lvl = Math.max(lvl, Math.max(1, clampThingLevel(item.potentialEffectiveLevel)));
    if (Number.isFinite(item.level)) lvl = Math.max(lvl, Math.max(1, clampThingLevel(item.level)));
    if (Number.isFinite(item.stacks)) lvl = Math.max(lvl, stackCountToLevel(item.stacks || 1));
    if (Number.isFinite(item.manualStacks)) lvl = Math.max(lvl, stackCountToLevel(item.manualStacks || 1));
    return lvl;
}

function getUnitBaseLevel(unit, fallback = 1) {
    if (!unit) return Math.max(1, clampThingLevel(fallback));
    if (Number.isFinite(unit.unitLevel)) return Math.max(1, clampThingLevel(unit.unitLevel));
    if (Number.isFinite(unit.baseLevel)) return Math.max(1, clampThingLevel(unit.baseLevel));
    if (Number.isFinite(unit.stackCount)) return stackCountToLevel(unit.stackCount || 1);
    return Math.max(1, clampThingLevel(fallback));
}

function getUnitEffectiveLevel(unit, fallback = 1) {
    if (!unit) return Math.max(1, clampThingLevel(fallback));
    if (Number.isFinite(unit.effectiveLevel)) return Math.max(1, clampThingLevel(unit.effectiveLevel));
    return getUnitBaseLevel(unit, fallback);
}

function getConfiguredMaxPop() {
    return Math.max(1, Math.floor(CONFIG_MAX_POP || 200));
}

function getHousePopCapContribution(ownerId, level) {
    let lvl = Math.max(1, clampThingLevel(Math.floor(Number(level) || 1)));
    let mapped = getBuildingStatForOwner(ownerId, 'house', lvl, 'popCap');
    if (Number.isFinite(mapped)) return Math.max(1, Math.floor(mapped));
    return Math.max(1, Math.floor(detPow(1.6, lvl)));
}

function recomputePlayerPopCaps() {
    let cfgCap = getConfiguredMaxPop();
    if (_popCapScratchByOwner.length !== players.length) _popCapScratchByOwner = new Int32Array(players.length);
    else _popCapScratchByOwner.fill(0);
    let popByOwner = _popCapScratchByOwner;

    // The houses: the buildings' bins (main.js _upkBuildingsStep: by owner,
    // type and level, kept from placements, removals, construction and
    // upgrades), each house bin counted once (integer sums).
    if (typeof _upkBuildingsStep === 'function') {
        const B = _upkBuildingsStep();
        for (let b = 0; b < B.n; b++) {
            const c = B.cnt[b], owner = B.owner[b];
            if (!c || B.type[b] !== 'house' || owner >= players.length) continue;
            popByOwner[owner] += c * getHousePopCapContribution(owner, B.lvl[b]);
        }
    } else for (let item of (typeof _cellItemsOfType === 'function' ? _cellItemsOfType('house') : getCellItemsRowMajor())) {
        let cell = grid[item.gy] && grid[item.gy][item.gx];
        if (!cell || cell.item !== item || item.type !== 'house') continue;
        let owner = cell.owner;
        if (owner < 0 || owner >= players.length) continue;
        if (item.energy <= 0 || item.underConstruction) continue;
        let level = Math.max(1, Math.floor(getThingBaseLevel(item) || 1));
        popByOwner[owner] += getHousePopCapContribution(owner, level);
    }

    for (let pid = 0; pid < players.length; pid++) {
        playerPopCaps[pid] = Math.min(cfgCap, popByOwner[pid] || 0);
    }
}


function getEntityVisibilityRangeArea(e) {
    if (!e) return null;
    if (e.preComputed && Number.isFinite(e.preComputed.visionRangeArea)) return e.preComputed.visionRangeArea;
    if (e.currentStats && Number.isFinite(e.currentStats.visionRangeArea)) return e.currentStats.visionRangeArea;
    if (e.basePreComputed && Number.isFinite(e.basePreComputed.visionRangeArea)) return e.basePreComputed.visionRangeArea;
    if (e.currentStats && Number.isFinite(e.currentStats.visionRange)) return e.currentStats.visionRange;
    if (e.preComputed && Number.isFinite(e.preComputed.visionRange)) return Number(e.preComputed.visionRange) / AREA_UNIT_TILE_EQUIVALENT;
    if (e.basePreComputed && Number.isFinite(e.basePreComputed.visionRange)) return Number(e.basePreComputed.visionRange) / AREA_UNIT_TILE_EQUIVALENT;
    return null;
}

function getEntityVisibilityRangeTiles(e) {
    let area = getEntityVisibilityRangeArea(e);
    return Number.isFinite(area) ? areaStepsVisionTiles(areaSteps(area)) : null;
}

function getEntityStatsCalcType(e) {
    if (!e) return '';
    if (e.type === 'barrack' && e.unitType) return 'barrack_' + e.unitType;
    return e.type || '';
}

function getEntityBaseVisibilityRangeArea(e) {
    if (!e) return null;
    if (e.basePreComputed && Number.isFinite(e.basePreComputed.visionRangeArea)) return e.basePreComputed.visionRangeArea;
    let statsType = getEntityStatsCalcType(e);
    let baseLevel = getThingBaseLevel(e, stackCountToLevel((e.stacks || 1)));
    if (statsType) {
        let s = calculateItemStats(statsType, baseLevel, e.owner);
        if (s && Number.isFinite(s.visionRange)) return s.visionRange;
        if (typeof getBuildingStatForOwner === 'function') {
            let statVision = Number(getBuildingStatForOwner(e.owner, statsType, baseLevel, 'visionRange'));
            if (Number.isFinite(statVision)) return statVision;
        }
        let defVision = Number(BASE_CARD_TYPES && BASE_CARD_TYPES[statsType] && BASE_CARD_TYPES[statsType].visionRange);
        if (Number.isFinite(defVision)) return defVision;
    }
    return getEntityVisibilityRangeArea(e);
}

function getEntityBaseVisibilityRangeTiles(e) {
    let area = getEntityBaseVisibilityRangeArea(e);
    return Number.isFinite(area) ? areaStepsVisionTiles(areaSteps(area)) : null;
}

function getEntityEffectiveVisibilityRangeArea(e) {
    if (!e) return null;
    if (e.preComputedEffective && Number.isFinite(e.preComputedEffective.visionRangeArea)) return e.preComputedEffective.visionRangeArea;
    if (e.preComputedEffective && Number.isFinite(e.preComputedEffective.visionRange)) {
        return e.preComputedEffective.visionRange / (e.unitType && !e.type ? AREA_UNIT_TILE_EQUIVALENT : 1);
    }
    if (!e.type && e.preComputed && Number.isFinite(e.preComputed.visionRangeArea)) return e.preComputed.visionRangeArea;
    let statsType = getEntityStatsCalcType(e);
    let baseLevel = getThingBaseLevel(e, stackCountToLevel((e.stacks || 1)));
    let effLevel = getThingEffectiveLevel(e, baseLevel);
    if (statsType) {
        let s = calculateItemStats(statsType, effLevel, e.owner);
        if (s && Number.isFinite(s.visionRange)) return s.visionRange;
        if (typeof getBuildingStatForOwner === 'function') {
            let statVision = Number(getBuildingStatForOwner(e.owner, statsType, effLevel, 'visionRange'));
            if (Number.isFinite(statVision)) return statVision;
        }
        let defVision = Number(BASE_CARD_TYPES && BASE_CARD_TYPES[statsType] && BASE_CARD_TYPES[statsType].visionRange);
        if (Number.isFinite(defVision)) return defVision;
    }
    return getEntityVisibilityRangeArea(e);
}

function getEntityEffectiveVisibilityRangeTiles(e) {
    let area = getEntityEffectiveVisibilityRangeArea(e);
    return Number.isFinite(area) ? areaStepsVisionTiles(areaSteps(area)) : null;
}

function getEntityBaseEnergyMax(e) {
    if (!e) return 0;
    if (e.basePreComputed && Number.isFinite(e.basePreComputed.maxEnergy)) {
        return Math.max(1, Math.floor(e.basePreComputed.maxEnergy));
    }
    if (e.preComputedBase && Number.isFinite(e.preComputedBase.maxEnergy)) {
        return Math.max(1, Math.floor(e.preComputedBase.maxEnergy));
    }
    let statsType = getEntityStatsCalcType(e);
    let baseLevel = getThingBaseLevel(e, stackCountToLevel((e.stacks || 1)));
    if (statsType) {
        let s = calculateItemStats(statsType, baseLevel, e.owner);
        if (s && Number.isFinite(s.maxEnergy)) return Math.max(1, Math.floor(s.maxEnergy));
    }
    return 1;
}

function getEntityEffectiveEnergyMax(e) {
    if (!e) return 0;
    if (e.preComputedEffective && Number.isFinite(e.preComputedEffective.maxEnergy)) {
        return Math.max(1, Math.floor(e.preComputedEffective.maxEnergy));
    }
    if (e.preComputed && Number.isFinite(e.preComputed.maxEnergy)) {
        return Math.max(1, Math.floor(e.preComputed.maxEnergy));
    }
    if (e.currentStats && Number.isFinite(e.currentStats.maxEnergy)) {
        return Math.max(1, Math.floor(e.currentStats.maxEnergy));
    }
    let statsType = getEntityStatsCalcType(e);
    let baseLevel = getThingBaseLevel(e, stackCountToLevel((e.stacks || 1)));
    let effLevel = getThingEffectiveLevel(e, baseLevel);
    if (statsType) {
        let s = calculateItemStats(statsType, effLevel, e.owner);
        if (s && Number.isFinite(s.maxEnergy)) return Math.max(1, Math.floor(s.maxEnergy));
    }
    return Math.max(1, getEntityBaseEnergyMax(e));
}

function getEntityPotentialEnergyMax(e) {
    if (!e) return 0;
    if (e.preComputedPotential && Number.isFinite(e.preComputedPotential.maxEnergy)) {
        return Math.max(1, Math.floor(e.preComputedPotential.maxEnergy));
    }
    let statsType = getEntityStatsCalcType(e);
    let baseLevel = getThingBaseLevel(e, stackCountToLevel((e.stacks || 1)));
    let potentialLevel = getThingPotentialLevel(e, getThingEffectiveLevel(e, baseLevel));
    if (statsType) {
        let s = calculateItemStats(statsType, potentialLevel, e.owner);
        if (s && Number.isFinite(s.maxEnergy)) return Math.max(1, Math.floor(s.maxEnergy));
    }
    return Math.max(1, getEntityEffectiveEnergyMax(e));
}

function getUnitRenderActionRangeArea(u) {
    if (!u) return 0;
    if (u.workerType === 'collector' || u.workerType === 'astar_collector' || u.workerType === 'salvager' || u.workerType === 'builder' || u.workerType === 'healer' || u.workerType === 'researcher') {
        return (24 / TILE) / AREA_UNIT_TILE_EQUIVALENT;
    }
    return Math.max(0, Number(u.preComputed && u.preComputed.attackRangeArea) || 0);
}

function getUnitRenderActionRangePx(u) {
    let area = getUnitRenderActionRangeArea(u);
    return area > 0 ? (Number(area) * AREA_UNIT_TILE_EQUIVALENT * TILE) : 0;
}

function getAreaRangeCellsAtWorld(wx, wy, rangeArea) {
    let sources = getSourceAreaIdsAtWorld(wx, wy);
    if (sources.length === 0) return [];
    return getGridCellsWithinDistanceOfSources(sources, Math.floor(Math.max(0, Number(rangeArea) || 0)));
}

// A structure's tile wall follows its construction: wall-type things
// (towers, clouds: BASE_CARD_TYPES target 'wall') block their tile only once
// built; under construction any unit walks over them, as over the floor
// things (which never block). The grid type is what every walk check reads
// (the movement kernel's walls, the navigation, A*); a tile turning into a
// wall pushes whoever stands on it off (unit.js _simWallPushOut).
function structureWallSync(item) {
    if (!item || !(typeof Tower === 'function' && item instanceof Tower)) return;
    const gx = item.gx, gy = item.gy;
    if (!(gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H) || getTileEntityRef(gx, gy) !== item) return;
    const cell = grid[gy][gx], want = item.underConstruction ? TYPE_FLOOR : TYPE_WALL;
    if (cell.type === want) return;
    cell.type = want;
    simMoveTileTypeChanged(gx, gy);
    // (Indexes kept from the tile journal see it: the laser beam map's
    // blocking walls, tower.js laserBeamsTick.)
    if (typeof noteTileEntityChanged === 'function') noteTileEntityChanged(gx, gy);
    _markCombinedBgTileDirty(gx, gy, 0, true);
    if (typeof markLaserConnectionsDirty === 'function') markLaserConnectionsDirty(gx, gy);
}

function markConstructionComplete(item) {
    if (!item) return;
    item.underConstruction = false;
    structureWallSync(item);
    // (Its hammer off at the next tick: presentation only.)
    if (typeof simPresentTileDirty === 'function') simPresentTileDirty(item.gx, item.gy);
    if ((item.level || 0) < 1) item.level = 1;
    if ((item.effectiveLevel || 0) < 1) item.effectiveLevel = 1;
    if ((item.potentialEffectiveLevel || 0) < 1) item.potentialEffectiveLevel = 1;
    refreshThingProgressState(item);
    if (item.updateTextCache) item.updateTextCache();
    else updateItemTextCache(item);
    // Built: it sees from now (visibility coverage).
    if (typeof visCoverOnBuildingChanged === 'function') visCoverOnBuildingChanged(item);
    if (typeof workSiteBuilt === 'function') workSiteBuilt(item);
    // (A trap working from now: the movement kernel's trap table.)
    if (typeof simTrapDirty === 'function' && Number.isFinite(item.gx)) simTrapDirty(item.gx, item.gy);
    if (typeof upkeepThingDirty === 'function') upkeepThingDirty(item);
    if (typeof spawnerProductionChanged === 'function' && hasSpawnQueue(item)) spawnerProductionChanged(item);
    if (typeof Tower === 'function' && item instanceof Tower) item.laserCheck();
}

function isAutoUpgradeEnabled(item) {
    return item && item.autoUpgradeEnabled !== false;
}

function isBuildEnabled(item) {
    return item && item.buildEnabled !== false;
}

function isAutoStackEnabled(item) {
    return item && item.autoStackEnabled !== false;
}

function isQueueEnabled(item) {
    return item && item.queueEnabled !== false;
}

function isAutoResearchEnabled(item) {
    if (!item || item.type !== 'research') return true;
    return item.autoResearchEnabled !== false;
}


function getLevelLabelText(item) {
    if (!item) return 'L1';
    // A structure view (sim_frame_world.js): the simulation's label.
    if (item._structView) return item._labelText();
    let currentLevel = item.underConstruction
        ? 0
        : Math.max(1, Math.floor(getThingBaseLevel(item) || 1));
    let effectiveLevel = item.underConstruction
        ? Math.max(0, Math.floor(getThingEffectiveLevel(item, currentLevel || 1) || 0))
        : Math.max(1, Math.floor(getThingEffectiveLevel(item, currentLevel) || currentLevel));
    let potentialLevel = item.underConstruction
        ? Math.max(0, Math.floor(getThingPotentialLevel(item, Math.max(0, effectiveLevel)) || effectiveLevel))
        : Math.max(effectiveLevel, Math.floor(getThingPotentialLevel(item, effectiveLevel) || effectiveLevel));
    let researchedMax = (typeof getThingResearchedMaxLevel === 'function') ? getThingResearchedMaxLevel(item) : MAX_THING_LEVEL;
    let shownLevel = Math.max(effectiveLevel, potentialLevel);
    
    if (shownLevel > currentLevel) {
        // If potential exceeds research max, show differently
        if (potentialLevel > researchedMax) {
            // If current is already at max, just show current->potential with blocked marker
            if (currentLevel === researchedMax) {
                return `L${currentLevel}->L${potentialLevel}|BLOCKED`;
            }
            // Otherwise show current->max->potential with blocked marker
            return `L${currentLevel}->L${researchedMax}->L${potentialLevel}|BLOCKED`;
        }
        // Otherwise cap shown level to researched max
        shownLevel = Math.min(shownLevel, researchedMax);
        return `L${currentLevel}->L${shownLevel}`;
    }
    return `L${currentLevel}`;
}

function getUnitLevelLabelText(unit) {
    let lvl = getUnitEffectiveLevel(unit, getUnitBaseLevel(unit));
    return `L${lvl}`;
}

// How large a world point is drawn, as a 2D-equivalent zoom (screen pixels
// per world pixel). In 2D this is the camera zoom. In 3D it is the on-screen
// scale at that point, i.e. its distance to the camera: zoom, tilt and where
// the point is on the map all count, so the far end of a tilted view is
// "zoomed out" even when the camera is zoomed in.
function getViewZoomAt(worldX, worldY) {
    let r = typeof renderer3dInstance !== 'undefined' ? renderer3dInstance : null;
    if (r && r.enabled && r.lodProjectionScale > 0 && typeof renderDimensionMode !== 'undefined' && renderDimensionMode === '3d'
        && Number.isFinite(worldX) && Number.isFinite(worldY)) {
        return r.pixelsPerWorldAt(worldX / TILE, 0, worldY / TILE) / TILE;
    }
    return camera && Number.isFinite(camera.zoom) ? camera.zoom : 1;
}

// Level labels appear once a thing is drawn large enough. With an entity the
// size is measured where it is (see getViewZoomAt); in 3D a 5% band keeps a
// label from flickering while the camera moves across the threshold.
const _levelLabelShown = new WeakMap();
function _isDrawnLargeEnough(entity, threshold) {
    if (!entity) return !camera || !Number.isFinite(camera.zoom) || camera.zoom >= threshold;
    let zoom = getViewZoomAt(Number(entity.x), Number(entity.y));
    if (renderDimensionMode !== '3d') return zoom >= threshold;
    let shown = _levelLabelShown.get(entity);
    let next = shown ? zoom >= threshold * 0.95 : zoom >= threshold * 1.05;
    if (next !== shown) _levelLabelShown.set(entity, next);
    return next;
}

function shouldShowBuildingLevels(entity = null) {
    if (!(levelVisibilityMode === LEVEL_VISIBILITY_ALL || levelVisibilityMode === LEVEL_VISIBILITY_BUILDINGS)) return false;
    return _isDrawnLargeEnough(entity, 0.62);
}

function shouldShowUnitLevels(entity = null) {
    if (levelVisibilityMode !== LEVEL_VISIBILITY_ALL) return false;
    return _isDrawnLargeEnough(entity, 0.7);
}

function getLevelVisibilityButtonText() {
    if (levelVisibilityMode === LEVEL_VISIBILITY_ALL) return 'Levels: Everything';
    if (levelVisibilityMode === LEVEL_VISIBILITY_BUILDINGS) return 'Levels: Buildings';
    return 'Levels: Off';
}

function updateLevelVisibilityButton() {
    let btn = document.getElementById('btn-level-visibility');
    if (!btn) return;
    btn.value = String(levelVisibilityMode);
}

function cycleLevelVisibilityMode() {
    levelVisibilityMode = (levelVisibilityMode + 1) % 3;
    updateLevelVisibilityButton();
    saveUiSettingsToStorage();
}

function getRenderRangeButtonText() {
    if (renderRangeMode === RENDER_RANGE_TURRETS) return 'Render range: Turrets';
    if (renderRangeMode === RENDER_RANGE_TURRETS_AND_UNITS) return 'Render range: Turrets + Units';
    if (renderRangeMode === RENDER_RANGE_ALL) return 'Render range: All things';
    if (renderRangeMode === RENDER_RANGE_UNITS) return 'Render range: Units';
    if (renderRangeMode === RENDER_RANGE_BUILDINGS) return 'Render range: Buildings';
    return 'Render range: None';
}

function updateRenderRangeButton() {
    let btn = document.getElementById('btn-render-range');
    if (!btn) return;
    btn.value = String(renderRangeMode);
}

function cycleRenderRangeMode() {
    renderRangeMode = (renderRangeMode + 1) % 6;
    updateRenderRangeButton();
    saveUiSettingsToStorage();
}

function getBuildPlacementModeButtonText() {
    return `Build place: ${buildPlacementMode + 1}`;
}

function getBuildPlacementModeDescription() {
    if (buildPlacementMode === BUILD_PLACE_MODE_DRAG_KEEP) {
        return 'Left Click: place + keep selected | Shift + Left Click: place + drag place + keep selected';
    }
    if (buildPlacementMode === BUILD_PLACE_MODE_SHIFT_KEEP) {
        return 'Left Click: place + unselect | Shift + Left Click: place + keep selected';
    }
    return 'Left Click: place + unselect | Shift + Left Click: place + keep selected + drag place';
}

function updateBuildPlacementModeButton() {
    let btn = document.getElementById('btn-build-place-mode');
    if (btn) btn.textContent = getBuildPlacementModeButtonText();
    let desc = document.getElementById('build-place-mode-desc');
    if (desc) desc.textContent = getBuildPlacementModeDescription();
}

function cycleBuildPlacementMode() {
    buildPlacementMode = (buildPlacementMode + 1) % 3;
    updateBuildPlacementModeButton();
    saveUiSettingsToStorage();
}

function shouldShiftDragBuildPlace(shiftHeld) {
    if (!shiftHeld) return false;
    return buildPlacementMode === BUILD_PLACE_MODE_DRAG_KEEP || buildPlacementMode === BUILD_PLACE_MODE_SHIFT_DRAG;
}

function shouldKeepBuildSelectionAfterLeftClick(shiftHeld) {
    if (buildPlacementMode === BUILD_PLACE_MODE_DRAG_KEEP) return true;
    if (!shiftHeld) return false;
    return buildPlacementMode === BUILD_PLACE_MODE_SHIFT_KEEP || buildPlacementMode === BUILD_PLACE_MODE_SHIFT_DRAG;
}

// Areas, to a hundredth (ranges are fractional: 1.5a).
// (Whole areas: 0a the thing's own area, 1a and those next to it, ...)
function formatAreaDistanceStat(v) {
    return Number.isFinite(v) ? `${Math.floor(Math.max(0, v) + 1e-9)}a` : '-';
}
// A blast's radius: a splash about the hit, in tiles (not areas: a fraction of one).
function formatBlastRadiusStat(v) {
    return Number.isFinite(v) ? `${Math.round(Math.max(0, v) * AREA_UNIT_TILE_EQUIVALENT * 10) / 10} tiles` : '-';
}

function formatRangeStatTiles(v) {
    return Number.isFinite(v) ? formatAreaDistanceStat(v / AREA_UNIT_TILE_EQUIVALENT) : '-';
}

// Shared stat rows store the canonical range in areas, plus a derived pixel
// distance for consumers that need world coordinates.
function getStatAttackRangeArea(stats) {
    // (Areas are whole: 0 its own, 1 the adjacent ones...)
    if (Number.isFinite(stats && stats.attackRangeArea)) return Math.max(0, Math.floor(stats.attackRangeArea));
    return 0;
}
