"use strict";

// ============================================================
// BARRACK CLASS
// ============================================================
function getBaseSpawnCooldownSeconds(unitType, buildingKey = null) {
    let cfg = BARRACK_SPAWN_CONFIG[unitType] || BARRACK_SPAWN_CONFIG.norm;
    if (Number.isFinite(cfg.baseTime) && cfg.baseTime > 0) return cfg.baseTime;
    return 1;
}

function getBarrackSpawnCooldown(unitType, level, owner = null, buildingKey = null) {
    let baseCd = getUnitStatFromMap(unitType, level, 'trainingTime', 0);
    if (!(baseCd > 0)) baseCd = getUnitStatFromMap('norm', level, 'trainingTime', 0);
    if (buildingKey && Number.isFinite(owner)) {
        let researched = getBuildingStatForOwner(owner, buildingKey, level, 'spawnCd');
        if (Number.isFinite(researched) && researched > 0) return researched;
    }
    return baseCd;
}

function getQueuedSpawnInfo(entry, fallbackType, fallbackLevel, owner = null) {
    if (entry && typeof entry === 'object') {
        let level = Math.max(1, entry.level || fallbackLevel || 1);
        let unitType = entry.unitType || fallbackType;
        let required = Number(entry.energyRequired);
        if (!Number.isFinite(required) || required < 1) {
            let energyCost = getUnitStatForOwner(Number.isFinite(owner) ? owner : localPlayerId, unitType, level, 'energy');
            required = Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
        }
        let paid = Number(entry.energyPaid);
        if (!Number.isFinite(paid) || paid < 0) paid = 0;
        return {
            unitType,
            level,
            energyRequired: required,
            energyPaid: Math.max(0, Math.min(required, paid))
        };
    }
    let level = Math.max(1, fallbackLevel || 1);
    let unitType = entry || fallbackType;
    let energyCost = getUnitStatForOwner(Number.isFinite(owner) ? owner : localPlayerId, unitType, level, 'energy');
    let required = Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    return {
        unitType,
        level,
        energyRequired: required,
        energyPaid: 0
    };
}

function getSpawnerFallbackUnitType(spawner) {
    if (!spawner) return 'norm';
    if (spawner.type === 'barrack') return spawner.unitType || 'norm';
    if (spawner.type === 'spawner') return 'collector';
    if (spawner.type === 'astar_spawner') return 'astar_collector';
    if (spawner.type === 'salvager') return 'salvager_unit';
    if (spawner.type === 'builder_spawner') return 'builder_unit';
    if (spawner.type === 'healer_spawner') return 'healer_unit';
    if (spawner.type === 'research') return 'researcher_unit';
    return 'norm';
}

// ---- Spawn queues ----
// A barrack's or spawner's queue is a count and its front's state, columns of
// its table row (_qN; _qLv the front's level, _qReq its energy cost, _qPaid
// what healers paid of it): no arrays or entry objects. An entry becomes the
// front with the building's base level and that level's cost then (not those
// of when it was queued). The page's structure views keep arrays (their
// spawnQueue), and so does spawnQueue on these objects for the interface: a
// copy made when read, its setter (snapshots, scenes) taking the count and
// the front.
function spawnQueueCount(e) {
    if (!e) return 0;
    const n = e._qN;
    if (n !== undefined) return n | 0;
    const q = e.spawnQueue;
    return Array.isArray(q) ? q.length : 0;
}
function hasSpawnQueue(e) { return !!e && (e._qN !== undefined || Array.isArray(e.spawnQueue)); }
function spawnQueueUnitType(s) {
    if (s.type === 'barrack') return s.unitType || 'norm';
    return (typeof getSpawnedUnitTypeForBuildingKey === 'function' && getSpawnedUnitTypeForBuildingKey(s.type)) || getSpawnerFallbackUnitType(s);
}
function _spawnQueueFrontNew(s) {
    const lvl = Math.max(1, getThingBaseLevel(s) || 1), c = getUnitStatForOwner(Number.isFinite(s.owner) ? s.owner : localPlayerId, spawnQueueUnitType(s), lvl, 'energy');
    s._qLv = lvl; s._qReq = Math.max(1, Math.floor(Number.isFinite(c) ? c : 1)); s._qPaid = 0;
}
function spawnQueuePush(s, n = 1) {
    if (!(n > 0)) return;
    if (!(s._qN > 0)) { s._qN = 0; _spawnQueueFrontNew(s); }
    s._qN += n;
}
function spawnQueueShift(s) {
    if (!(s._qN > 0)) return;
    s._qN--;
    if (s._qN > 0) _spawnQueueFrontNew(s); else { s._qLv = 0; s._qReq = 0; s._qPaid = 0; }
}
// The front (null: none) as a record reused by the next call; a page view's
// from its array.
const _sqFront = { unitType: '', level: 1, energyRequired: 1, energyPaid: 0 };
function spawnQueueFront(s) {
    if (!(spawnQueueCount(s) > 0)) return null;
    if (s._qN === undefined) return getQueuedSpawnInfo(s.spawnQueue[0], getSpawnerFallbackUnitType(s), getThingBaseLevel(s), s.owner);
    const F = _sqFront;
    F.unitType = spawnQueueUnitType(s); F.level = s._qLv; F.energyRequired = s._qReq; F.energyPaid = s._qPaid;
    return F;
}
function spawnQueuePay(s, amount) { s._qPaid = Math.min(s._qReq, s._qPaid + amount); }
const _SPAWN_QUEUE_PROP = {
    get() {
        const n = this._qN | 0;
        if (!(n > 0)) return [];
        const ty = spawnQueueUnitType(this), q = [{ unitType: ty, level: this._qLv, energyRequired: this._qReq, energyPaid: this._qPaid }];
        for (let i = 1; i < n; i++) q.push(ty);
        return q;
    },
    set(v) {
        const n = Array.isArray(v) ? v.length : 0;
        this._qN = n;
        if (!n) { this._qLv = 0; this._qReq = 0; this._qPaid = 0; return; }
        const f = getQueuedSpawnInfo(v[0], spawnQueueUnitType(this), getThingBaseLevel(this), this.owner);
        this._qLv = f.level; this._qReq = f.energyRequired; this._qPaid = f.energyPaid;
    },
    configurable: true
};

function _shouldWaitForConstruction(self) {
    if (!self || !self.underConstruction) return false;
    let targetEnergy = Number(getUpgrademaxEnergy(self, 1));
    let visibleMax = Number(self.maxEnergy);
    // Use the visible construction cap as an upper bound to avoid impossible L0 completion thresholds.
    if (Number.isFinite(visibleMax) && visibleMax > 0) {
        targetEnergy = Number.isFinite(targetEnergy) && targetEnergy > 0
            ? Math.min(targetEnergy, visibleMax)
            : visibleMax;
    }
    let requiredEnergy = Math.max(1, Math.floor(Number.isFinite(targetEnergy) && targetEnergy > 0 ? targetEnergy : 1));
    if ((Number(self.energy) || 0) >= requiredEnergy) {
        markConstructionComplete(self);
        return false;
    }
    return true;
}

let globalSpawnerReadyOrderCounter = 1;

// A spawner's production cooldown in ticks, as its type sets it.
const _SPAWN_COOLDOWN_ARGS = { spawner: ['collector', 'spawner'], astar_spawner: ['astar_collector', 'astar_spawner'], salvager: ['salvager_unit', 'salvager'],
    builder_spawner: ['builder_unit', 'builder_spawner'], healer_spawner: ['healer_unit', 'healer_spawner'], research: ['researcher_unit', 'research'] };
// (By the stat tables' version, the producing type (a barrack's unit type),
// owner and base level: the same answer for every spawner of them; was ~1 us
// a call, ~80k barracks and spawners on every presentation sweep.)
const _spawnCdMemo = { ver: -1, byType: new Map() };
function spawnerCooldownTicks(s) {
    const lvl = getThingBaseLevel(s), M = _spawnCdMemo;
    if (M.ver !== _precomputedStatsVersion) { M.ver = _precomputedStatsVersion; M.byType.clear(); }
    const key = s.type === 'barrack' ? s.unitType : s.type, o = Number.isFinite(s.owner) ? s.owner : -1;
    let row = M.byType.get(key);
    if (row === undefined) M.byType.set(key, row = []);
    const at = (o + 1) * 64 + (lvl & 63);
    const was = row[at];
    if (was !== undefined && lvl < 64 && o < 63) return was;
    const v = _spawnerCooldownTicksCompute(s, lvl);
    if (lvl < 64 && o < 63) row[at] = v;
    return v;
}
function _spawnerCooldownTicksCompute(s, lvl) {
    if (s.type === 'barrack') return Math.round(getBarrackSpawnCooldown(s.unitType, lvl, s.owner, `barrack_${s.unitType}`) * TICK_RATE);
    const a = _SPAWN_COOLDOWN_ARGS[s.type];
    return a ? Math.round(getBarrackSpawnCooldown(a[0], lvl, s.owner, a[1]) * TICK_RATE) : Math.max(1, Math.round(s.spawnCooldown || 1));
}
// Where a spawner's production may have moved on (a payment, its queue or
// its queue switch changed, construction done): its timer and, once its
// front is paid, its ready order (barracks and spawners have no tick of
// their own: spawnerStructuresTick).
// (A spawner's production moved on (a payment, its queue, construction done): the production pass (spr.rs
// k_spawn_prod) brings every barrack's and spawner's row up to date each step; nothing to do now.)
function spawnerProductionChanged(s) { }
// A tick of the barracks and spawners: the players' research moves on.
function spawnerStructuresTick() {
    // (Their statuses: the status kernel's, main.js; removals there too.)
    researchAdvanceTick();
}
// Each player's research moves on once a tick while it has a research
// building (built, alive: the buildings' bins); the buildings read its task
// (ResearchSpawner.researchTask, derived).
function researchAdvanceTick() {
    const B = typeof _upkBuildingsStep === 'function' ? _upkBuildingsStep() : null;
    if (!B) return;
    const np = players.length;
    let has = 0;
    for (let b = 0; b < B.n; b++) if (B.cnt[b] && B.type[b] === 'research' && B.owner[b] < np && B.owner[b] < 31) has |= 1 << B.owner[b];
    for (let o = 0; o < np && o < 31; o++) {
        if (!(has & (1 << o))) continue;
        _researchAdvancedTick[o] = gameTime;
        tryAdvancePlayerResearchTask(o);
    }
}
// The empty part of a production or research bar. A bar is drawn whenever
// something is queued, empty too: queued and not being made (no workers, no
// energy, production switched off) is what the player has to see, so its
// track is light enough to read on a dark building.
const QUEUE_BAR_TRACK = '#6a6a6a';
// (The production pass's: spr.rs k_spawn_prod.)
function updateSpawnerProductionProgress(spawner) { }

// (Ready orders: each spawner row's c__spawnReadyOrder, given by the production pass, spr.rs k_spawn_select; a resync
// keeps the rows.)
function spawnerReadyReset() { }
// ---- production as table passes (TABLES_CONVERSION_PLAN.md S2; wasm/src/spr.rs) ----
// Each step every barrack's and spawner's row is brought up to date on the
// helpers (k_spawn_prod: its spawn timer from its front's payment, not ready
// while unpaid, newly paid ones listed), the newly paid ones get ready orders
// and the ready ones are taken by order within their owners' population
// room (k_spawn_select), the queues of those that spawned move on together
// (k_spawn_shift). Cooldowns and next costs by spawner type, owner and base
// level in spr.tab (_spTabFill, for the keys the pass reports). Replaces the
// per-payment and staggered updates and the per-owner ready lists.
let SPAWN_PROD_WASM = true;
const SPAWN_PROD_ROWS = 2048, SPAWN_PROD_TYPES = 256;
const _spp = { on: false, cls: null, jobs: null, tab: null, out: null, cnt: null, sel: null, tmp: null, shift: null, ns: 0, np: -1, classes: null, ix: null, AP: new Float64Array(64), BP: new Float64Array(4) };
function _spProdOn() {
    return SPAWN_PROD_WASM && typeof _simWasmX !== 'undefined' && _simWasmX !== null && typeof _simWasmX.k_spawn_prod === 'function'
        && typeof SIM_KERNEL_SPAWN_PROD === 'number' && _ST.n > 0 && simHeapHas(_ST.brain) && simHeapHas(_ST.tim) && simHeapHas(_ST.ctab) && simHeapHas(_ST.rrow);
}
function _spArr(name, Type, n) { let a = _spp[name]; if (!a || a.length < n || !simHeapHas(a)) a = _spp[name] = simSharedArray(Type, Math.max(64, n)); return a; }
// The pass's arrays for the match (main.js simMatchReserve): spawner rows
// at most the structure rows (B.structs), a batch's spawns at most SPB_CAP.
function spawnerProductionReserve(B) {
    const rows = Math.max(64, B.structs | 0), classes = 16, jobs = Math.ceil(rows / SPAWN_PROD_ROWS) + classes;
    _spArr('cls', Int32Array, classes * 16); _spArr('jobs', Int32Array, jobs * 3);
    _spArr('tab', Float64Array, (Math.max(1, B.players) + 1) * SPAWN_PROD_TYPES * 64 * 3); _spp.np = -1;
    _spArr('out', Int32Array, jobs * SPAWN_PROD_ROWS * 5); _spArr('cnt', Int32Array, jobs * 16);
    _spArr('sel', Int32Array, rows + 4); _spArr('tmp', Uint32Array, 8 * rows + 65536); _spArr('shift', Int32Array, SPB_CAP + 1);
}
const _SP_COLS = ['_stT', '_ow', '_en', '_uc', 'queueEnabled', '_qN', '_qLv', '_qReq', '_qPaid', '_spt', '_spawnReadyOrder'].map(name => 'c_' + name);
const _spawnSelectArgs = new Array(5).fill(null);
const _spawnShiftArgs = new Array(4).fill(null);
function _spClasses() {
    if (!_spp.classes) {
        _spp.classes = [Barrack, CollectorSpawner, AstarSpawner, typeof SalvagerSpawner !== 'undefined' ? SalvagerSpawner : null, typeof BuilderSpawner !== 'undefined' ? BuilderSpawner : null,
            typeof HealerSpawner !== 'undefined' ? HealerSpawner : null, typeof ResearchSpawner !== 'undefined' ? ResearchSpawner : null].filter(Boolean);
        _spp.ix = new Map(_spp.classes.map((C, k) => [C, k]));
    }
    return _spp.classes;
}
// A group's spawn queue changes (main.js spawnCounts): tiles and counts, by
// the kernel (wasm/src/spr.rs k_spawn_counts); the changed tiles' list and
// count back (_spp.out, n). Fronts' costs: spr.tab, missing keys filled first.
function spawnCountsKernel(tiles, counts, n, playerId, worker) {
    const S = _spp, CL = _spClasses(), { cls } = _spClsBuild();
    const np1 = players.length + 1, tab = _spArr('tab', Float64Array, np1 * SPAWN_PROD_TYPES * 64 * 3);
    if (S.np !== np1) { tab.fill(NaN); S.np = np1; }
    const out = _spArr('cout', Int32Array, n + 4), cnt = _spArr('ccnt', Int32Array, 4), ver = _precomputedStatsVersion, P = S.CP || (S.CP = new Float64Array(16));
    P.fill(0); P[0] = n; P[1] = SPAWN_PROD_TYPES; P[2] = playerId; P[3] = worker ? 1 : 0; P[4] = CL.length; P[5] = GRID_W * GRID_H; P[7] = ver; P[8] = worker ? 10 : 20;
    const args = [cls, tiles, counts, _ST.ctab, _ST.rrow, _ST.brain, tab, out, cnt, _ST.tim];
    P[6] = 0; simRustDirect('k_spawn_counts', args, P);
    for (let i = 0, m = cnt[1]; i < m; i++) { const key = out[i]; if (tab[key * 3 + 2] !== ver) _spTabFill(tab, key, ver); }
    P[6] = 1; simRustDirect('k_spawn_counts', args, P);
    return cnt[0];
}
// The table entry of a key: the cooldown (barrack.js _spawnerCooldownTicksCompute) and the next unit's cost (_spawnQueueFrontNew) of its spawner type, owner and base level.
function _spTabFill(tab, key, ver) {
    const types = SPAWN_PROD_TYPES, lv = key % 64, ty = Math.floor(key / 64) % types, o = Math.floor(key / (64 * types)) - 1, raw = _stationaryTypes[ty];
    let cd = NaN, cost = NaN;
    if (raw) {
        const isB = raw.startsWith('barrack_'), s = { type: isB ? 'barrack' : raw, unitType: isB ? raw.slice(8) : undefined, owner: o };
        cd = _spawnerCooldownTicksCompute(s, lv);
        cost = getUnitStatForOwner(o, spawnQueueUnitType(s), lv, 'energy');
    }
    tab[key * 3] = cd; tab[key * 3 + 1] = cost; tab[key * 3 + 2] = ver;
}
// The step's production; returns spr.sel ([0] count, then the tiles of the spawners to spawn, in order).
// The classes' table for the kernels (spr.cls: rows, ctab tag, column
// pointers by _SP_COLS) and their jobs' count.
function _spClsBuild() {
    const CL = _spClasses();
    if (typeof structRallyClasses === 'function') structRallyClasses();
    const cls = _spArr('cls', Int32Array, CL.length * 16);
    // (Every class's columns in the heap, the rally ones too (the births read them): moved there when one is not. A class
    // left out would neither produce nor rally on this peer alone.)
    const need = [..._SP_COLS, ..._SPAWN_RALLY_COLS];
    if (CL.some(C => { const T = _sTables.get(C); return T && T.n > 0 && need.some(nm => !T[nm] || !simHeapHas(T[nm])); })) structTablesRehome();
    let J = 0;
    for (let k = 0; k < CL.length; k++) {
        const C = CL[k];
        const T = _sTables.get(C), b = k * 16;
        cls.fill(0, b, b + 16);
        if (!T || !(T.n > 0)) continue;
        let j = 0;
        for (; j < _SP_COLS.length; j++) {
            const a = T[_SP_COLS[j]];
            if (!a || !simHeapHas(a)) break;
            cls[b + 2 + j] = _simWEnc(_simHeapPtrOf(a));
        }
        if (j !== _SP_COLS.length) throw new Error('spawner production: a column of ' + C.name + ' not in the heap: ' + _SP_COLS[j]);
        cls[b] = T.n;
        cls[b + 1] = _stAllIx.get(C) || 0;
        J += Math.ceil(T.n / SPAWN_PROD_ROWS);
    }
    return { cls, J };
}
function spawnerProductionPass() {
    const S = _spp, CL = _spClasses();
    if (globalSpawnerReadyOrderCounter > 1073741824) _spRebase(CL);
    const { cls, J } = _spClsBuild();
    const sel = _spArr('sel', Int32Array, 8);
    if (J === 0) { sel[0] = 0; return sel; }
    const JB = _spArr('jobs', Int32Array, J * 3);
    let at = 0;
    for (let k = 0; k < CL.length; k++) {
        const rows = cls[k * 16];
        for (let r = 0; r < rows; r += SPAWN_PROD_ROWS) {
            JB[at++] = k; JB[at++] = r; JB[at++] = Math.min(rows, r + SPAWN_PROD_ROWS);
        }
    }
    const np1 = players.length + 1, tab = _spArr('tab', Float64Array, np1 * SPAWN_PROD_TYPES * 64 * 3);
    if (S.np !== np1) { tab.fill(NaN); S.np = np1; }
    const out = _spArr('out', Int32Array, J * SPAWN_PROD_ROWS * 5), cnt = _spArr('cnt', Int32Array, J * 16);
    simParallelBind('spr.cls', cls); simParallelBind('spr.jobs', JB); simParallelBind('st.brain', _ST.brain);
    simParallelBind('st.ctab', _ST.ctab); simParallelBind('st.rrow', _ST.rrow); simParallelBind('st.tim', _ST.tim);
    simParallelBind('spr.tab', tab); simParallelBind('spr.out', out); simParallelBind('spr.cnt', cnt);
    const ver = _precomputedStatsVersion, P = _simParams;
    // The table's missing or stale keys, then every row.
    P[0] = J; P[1] = 0; P[2] = ver; P[3] = SPAWN_PROD_TYPES; P[4] = SPAWN_PROD_ROWS;
    simParallelRun(SIM_KERNEL_SPAWN_PROD, J);
    for (let j = 0; j < J; j++) { const b = j * SPAWN_PROD_ROWS * 5 + SPAWN_PROD_ROWS * 4; for (let i = 0, m = cnt[j * 16 + 2]; i < m; i++) { const key = out[b + i]; if (tab[key * 3 + 2] !== ver) _spTabFill(tab, key, ver); } }
    P[0] = J; P[1] = 1; P[2] = ver; P[3] = SPAWN_PROD_TYPES; P[4] = SPAWN_PROD_ROWS;
    simParallelRun(SIM_KERNEL_SPAWN_PROD, J);
    let cap = 0;
    for (let j = 0; j < J; j++) cap += cnt[j * 16] + cnt[j * 16 + 1];
    const sl = _spArr('sel', Int32Array, cap + 4), tmp = _spArr('tmp', Uint32Array, 8 * Math.max(1, cap) + 65536), AP = S.AP;
    AP.fill(0); AP[0] = J; AP[1] = SPAWN_PROD_ROWS; AP[2] = globalSpawnerReadyOrderCounter; AP[62] = Math.max(1, cap); AP[63] = Math.min(56, players.length);
    for (let o = 0; o < players.length && o < 56; o++) AP[3 + o] = players[o] ? Math.max(0, getPlayerPopCap(o) - players[o].popCount) : 0;
    const args = _spawnSelectArgs;
    args[0] = cls; args[1] = out; args[2] = cnt; args[3] = sl; args[4] = tmp;
    try { simRustDirect('k_spawn_select', args, AP); } finally { args.fill(null); }
    const n = sl[0];
    globalSpawnerReadyOrderCounter = sl[n + 1] + sl[n + 2] * 2147483648;
    return sl;
}
// The ready orders (Int32 tickets) made small again: less the least held, the counter too (every peer alike: a whole step's state).
function _spRebase(CL) {
    let m = globalSpawnerReadyOrderCounter;
    for (const C of CL) { const T = _sTables.get(C), a = T && T.c__spawnReadyOrder; if (a) for (let r = 0; r < T.n; r++) if (a[r] !== -2147483648 && a[r] < m) m = a[r]; }
    for (const C of CL) { const T = _sTables.get(C), a = T && T.c__spawnReadyOrder; if (a) for (let r = 0; r < T.n; r++) if (a[r] !== -2147483648) a[r] -= m; }
    globalSpawnerReadyOrderCounter -= m;
}
function _spShiftRun() {
    const S = _spp;
    if (S.ns > 0) {
        const BP = S.BP, args = _spawnShiftArgs;
        BP[0] = S.ns; BP[1] = SPAWN_PROD_TYPES;
        args[0] = S.cls; args[1] = S.shift; args[2] = _ST.brain; args[3] = S.tab;
        try { simRustDirect('k_spawn_shift', args, BP); } finally { args.fill(null); }
    }
    S.ns = 0;
}
// The step's spawns: the production pass and the births (kernels). (A world without the simulation's kernels, a page beside
// its simulation worker, spawns nothing.)
function processGlobalSpawnerQueue() {
    if (_spProdOn()) _processSpawnsByTables();
}
// The production pass's spawns: its picks made units by one kernel (spr.rs
// k_spawn_births: checks, exit, footprint, slot, handle, id, columns, stats
// from the effective rows, worker set-up, id table, the spawners' own
// changes), then their spatial entries, upkeep bins and the queues' shifts
// (kernels) and the counters the JavaScript keeps (O(1)). Unit objects are
// made when JavaScript asks for one (SimOwners.at).
function _processSpawnsByTables() {
    const S = _spp;
    S.ns = 0;
    const sel = spawnerProductionPass();
    if (sel[0] > 0) _spawnBirths(sel);
}
// The columns k_spawn_births writes, in spr.rs C_* order (their places in the slot table).
const _SPAWN_BIRTH_COLS = ['id', 'owner', 'upT', 'x', 'y', 'prevX', 'prevY', 'x0', 'y0', 'r', 'collisionR', 'unitLevel', 'stackCount', 'effectiveStacks',
    'effectiveLevel', 'baseLevel', 'tuS', 'tuId', 'tbT', 'acqB', 'mvTgX', 'mvTgY', 'hnd', 'dead', 'dead0', 'energy', 'live', 'tmOn',
    'maxE', 'jMaxE', '_lastAppliedEffectiveLevel', 'statRow', 'bsRow', 'esOk', 'esRad', 'esType', 'esVer', 'jFly', 'lzFlags', 'mvLane', 'mvReachD', 'mvReachA',
    'mvShoot', 'mvRangeK', 'atkSty', 'atkWatch', 'wkS', 'wkR', 'wkIx', 'isWk', 'hObj', 'wkIdle', 'oc_workerType', 'sepD0', 'sepR0', 'sepL0', 'nvPK', 'pathIndex', 'commandState'];
const SPAWN_UT_W = 12;
// The rally columns the births read and write (spr.rs RW_W words a class).
const _SPAWN_RALLY_COLS = ['c_rallyX', 'c_rallyY', 'c_rallyTargetUnitId', 'c__rallyLastSeenX', 'c__rallyLastSeenY', 'c__pendingRallyDetach'];
// (The spawners' structure types besides the barracks: getSpawnerFallbackUnitType's.)
const _SPAWNER_KEYS = new Set(['spawner', 'astar_spawner', 'salvager', 'builder_spawner', 'healer_spawner', 'research']);
// The births' tables (heap): made at the match's start and again where what they hold changed (the slot table, the
// worker records' columns, unit or structure types added, the occupancy's planes).
const _sb = { Z: null, colix: null, sty: null, styN: -1, ut: null, utN: -1, utPlanes: -1, stk: null, wtab: null, wkind: null, wdefs: null, wFor: null,
    out: null, list: null, dirty: null, A: [], P: new Float64Array(64), UP: new Float64Array(8) };
function _spawnBirthTables(S, n) {
    const B = _sb, C = S.columns, Z = _simSlotZeroTable(S);
    if (!Z) throw new Error('spawn births: unit columns not in the heap');
    if (typeof _spbKind === 'function') _spbKind(Z);
    if (B.Z !== Z.tab || B.ZN !== Z.n) {
        // (Each name's place in the slot table: the unit columns, the movement ones, then the shared ids' arrays.)
        const names = [...SIM_UNIT_COLUMNS, ...SIM_MOVE_COLUMNS.map(c => c[0])];
        for (const nm of _simUnitSharedJs()) { const c = C[nm]; if (c && c.data && simHeapHas(c.data)) names.push(nm); }
        if (!B.colix || !simHeapHas(B.colix)) B.colix = simHeapArray(Int32Array, 64);
        _SPAWN_BIRTH_COLS.forEach((k, i) => { B.colix[i] = names.indexOf(k); });
        for (const k of _SPAWN_BIRTH_COLS) if (names.indexOf(k) < 0 && !['oc_workerType'].includes(k)) throw new Error('spawn births: no slot column ' + k);
        B.Z = Z.tab; B.ZN = Z.n;
    }
    // Per stationary type (st.brain's type): the unit type its spawner makes (unit.upT), -1 none.
    _stationaryTypesSeed();
    const nst = _stationaryTypes.length;
    if (B.styN !== nst || B.styFor !== _stationaryTypes || B.styCols !== C || !B.sty || !simHeapHas(B.sty)) {
        if (!B.sty || B.sty.length < nst + 1 || !simHeapHas(B.sty)) B.sty = simHeapArray(Int32Array, Math.max(256, nst * 2));
        for (let i = 0; i < nst; i++) {
            const key = _stationaryTypes[i];
            let ty = null;
            if (key.startsWith('barrack_')) ty = key.slice(8);
            else if (_SPAWNER_KEYS.has(key)) ty = getSpawnedUnitTypeForBuildingKey(key) || getSpawnerFallbackUnitType({ type: key });
            B.sty[i] = ty && BASE_UNIT_STATS[ty] ? simUnitTypeIndex(ty) : -1;
        }
        B.styN = nst; B.styFor = _stationaryTypes; B.styCols = C;
    }
    // Per unit type its spawn words (spr.rs UT_*).
    const O = typeof occupancyEnsure === 'function' && SIM_OCCUPANCY_ENABLED ? occupancyEnsure() : null, planes = O ? O.planes : 1;
    simUnitTypeIndex('norm');
    const nut = _simUnitTypeNames.length;
    // (Per peer: the type indices and the shared column's pool ids are its own; a restore makes new columns and pools.)
    if (B.utN !== nut || B.utPlanes !== planes || B.utCols !== C || B.utPool !== (C.oc_workerType && C.oc_workerType.pool) || B.utTy !== spatialUnitTypeToIndex || !B.ut || !simHeapHas(B.ut)) {
        if (!B.ut || B.ut.length < nut * SPAWN_UT_W || !simHeapHas(B.ut)) B.ut = simHeapArray(Float64Array, Math.max(64, nut * 2) * SPAWN_UT_W);
        const wtKey = _simHKey('workerType'), wtCol = C.oc_workerType;
        for (let i = 0; i < nut; i++) {
            const name = _simUnitTypeNames[i], def = BASE_UNIT_STATS[name] || BASE_UNIT_STATS.norm || {}, b = i * SPAWN_UT_W;
            const r = Number(def.r) || 0, cr = Number.isFinite(def.collisionR) ? def.collisionR : r, fly = !!def.isFlying;
            const rc = getResourceTypeByCollectorUnit(name);
            const wt = rc ? rc.collectorUnitKey : name === 'salvager_unit' ? 'salvager' : name === 'builder_unit' ? 'builder' : name === 'healer_unit' ? 'healer' : name === 'researcher_unit' ? 'researcher' : null;
            const wb = !wt ? 0 : wt === 'collector' ? 1 : wt === 'astar_collector' ? 2 : wt === 'salvager' ? 3 : wt === 'builder' ? 4 : wt === 'healer' ? 5 : 6;
            // (configureWorkerUnitFromType's columns: IDLE, no target, its material false.)
            const mat = wt === 'builder' ? 1 << 13 : wt === 'healer' ? 1 << 15 : wt === 'researcher' ? 1 << 17 : 0;
            const ty = spatialUnitTypeToIndex[name];
            B.ut[b] = ty >= 0 ? ty : -1; B.ut[b + 1] = r; B.ut[b + 2] = cr;
            B.ut[b + 3] = Math.max(1, Math.min(32, Math.ceil((cr || r || 1) / (TILE / SIM_OCCUPANCY_SUBCELLS))));
            B.ut[b + 4] = planes === 1 ? 0 : Math.min(planes - 1, fly ? 1 : name === 'mole' ? 2 : 0);
            B.ut[b + 5] = wb;
            B.ut[b + 6] = wt ? (SIM_WS_IDLE | (simWttCode(null) << 5) | (SIM_WT_NULL << 10) | mat) : 0;
            B.ut[b + 7] = wt ? (_simHTerm(wtKey, wt) - _simHTerm(wtKey, undefined)) | 0 : 0;
            B.ut[b + 8] = wt && wtCol && wtCol.pool ? _simSharedIdOf(wtCol, wt) : 0;
            B.ut[b + 9] = fly ? 1 : 0;
            B.ut[b + 10] = ty >= 0 && Number.isFinite(Number(def.visionRange)) && Number(def.visionRange) !== 0 ? 1 : 0;
            B.ut[b + 11] = 0;
        }
        B.utN = nut; B.utPlanes = planes; B.utCols = C; B.utPool = C.oc_workerType && C.oc_workerType.pool; B.utTy = spatialUnitTypeToIndex;
    }
    if (!B.stk || !simHeapHas(B.stk)) { B.stk = simHeapArray(Float64Array, 256); for (let l = 0; l < 256; l++) B.stk[l] = l >= 1 ? getRequiredStacksForLevel(l) : 1; }
    // The worker records' columns (sim_unit_state.js SIM_UNIT_WK_SIDE) as a slot table, their defaults; wbType's and wbTick's places last.
    if (B.wFor !== C.wbType) {
        const L = SIM_UNIT_WK_SIDE.filter(([k]) => C[k] && simHeapHas(C[k]));
        const m = L.length;
        for (const a of [B.wtab, B.wkind, B.wdefs]) if (a && simHeapHas(a)) simHeapFree(a);
        B.wtab = simHeapArray(Int32Array, 3 * m + 3); B.wkind = simHeapArray(Int32Array, m + 4); B.wdefs = simHeapArray(Float64Array, m + 2);
        L.forEach(([k], j) => {
            const a = C[k];
            B.wtab[3 * j] = _simWEnc(_simHeapPtrOf(a)); B.wtab[3 * j + 1] = a.BYTES_PER_ELEMENT; B.wtab[3 * j + 2] = 1;
            B.wkind[j] = a instanceof Float64Array ? 3 : a instanceof Float32Array ? 2 : 1;
            B.wdefs[j] = k in SIM_WK_DEFAULTS ? SIM_WK_DEFAULTS[k] : 0;
        });
        B.wkind = (() => { const a = simHeapArray(Int32Array, m + 8); a.set(B.wkind.subarray(0, m)); simHeapFree(B.wkind); return a; })();
        ['wbType', 'wbTick', 'wmCarry', 'wmPinTy', 'wmWty', 'wmMineTy'].forEach((nm, j) => { B.wkind[m + j] = L.findIndex(([k]) => k === nm); });
        B.wN = m; B.wFor = C.wbType;
    }
    // Its outs: the list (births, then the blocked), the shifts, the dirty tiles.
    const room = Math.max(1024, n * 2 + 16);
    if (!B.out || !simHeapHas(B.out)) B.out = simHeapArray(Int32Array, 160);
    if (!B.list || B.list.length < room || !simHeapHas(B.list)) { B.list = simHeapArray(Int32Array, room * 2); B.dirty = simHeapArray(Int32Array, room); B.evl = simHeapArray(Int32Array, room); }
    // (The rally classes' columns, in the spawner classes' order (spr.cls, _spClasses); the players' visibility covers.)
    if (!B.rally || !simHeapHas(B.rally)) B.rally = simHeapArray(Int32Array, 16 * 8);
    B.rally.fill(0);
    _spClasses().forEach((K, k) => {
        const T = _sTables.get(K);
        if (!T || !(T.n > 0)) return;
        _SPAWN_RALLY_COLS.forEach((nm, j) => { if (!T[nm] || !simHeapHas(T[nm])) throw new Error('spawn births: rally column ' + nm + ' of ' + K.name + ' not in the heap'); B.rally[k * 8 + j] = _simWEnc(_simHeapPtrOf(T[nm])); });
    });
    if (!B.cover || !simHeapHas(B.cover)) B.cover = simHeapArray(Int32Array, 64);
    B.cover.fill(0); B.ncov = 0;
    if (!matchFullVisibility && typeof _visCoverReady === 'function' && _visCoverReady()) { const V = _visCover; B.ncov = Math.min(64, V.players); for (let p = 0; p < B.ncov; p++) { const a = V.cover[p]; if (a && simHeapHas(a)) B.cover[p] = _simWEnc(_simHeapPtrOf(a)); } }
    return B;
}
// The id of value v in a shared column's pool (sim_unit_state.js SimSharedColumn), made when it has none.
function _simSharedIdOf(col, v) {
    const P = col.pool;
    let id = P.ids.get(v);
    if (id === undefined) { id = P.values.length; P.values.push(v); P.ids.set(v, id); }
    return id;
}
function _spawnBirths(sel) {
    const S = _simUnitState, C = S.columns, n = sel[0];
    // (Room made first, as the match's budget holds it: worker records (their columns may be made anew: the tables below
    // name them), handles, the id table and hash, the spawners' shifts.)
    simUnitWkReserve(n);
    const B = _spawnBirthTables(S, n), sl = S.sl;
    _simHandleGrow(S, S.hnext + n + 1);
    if (!simHeapHas(S.hfree)) { const h = simHeapArray(Int32Array, Math.max(1024, S.hfree.length)); h.set(S.hfree); S.hfree = h; }
    _uixRoom(_uix.n + n);
    // (The id index brought up to date on every peer alike: a rally following a unit looks it up there; and the births go into it.)
    const map = _unitByIdMap(), mapOn = map instanceof UnitIdIndex && map._ok() && simHeapHas(map.t);
    if (!mapOn) throw new Error('spawn births: the unit id index is not in the heap');
    if (mapOn && (map.used + n) * 2 > map.t.length) map._make(n);
    const shift = _spArr('shift', Int32Array, n + 1);
    if (sl.gw !== GRID_W || sl.gh !== GRID_H) { _simSlabKeys(sl); for (let i = 0; i < sl.slabs; i++) sl.home[i] = -1; _simSlabRelist(sl); }
    _simSlabReserve(sl, Math.ceil(S.cap / SIM_SLAB));
    if (!simHeapHas(sl.hdr)) { const h = simHeapArray(Int32Array, 8); h.set(sl.hdr); sl.hdr = h; }
    sl.hdr[7] = S.owners.length;
    const O = SIM_OCCUPANCY_ENABLED && typeof occupancyEnsure === 'function' ? occupancyEnsure() : null, OA = O ? _occupancyAddresses() : null;
    const U = unitStatTables(), W = _simWkPool(S), V = _workerWorkTable();
    const A = B.A;
    A.length = 0;
    A.push(sel, _spp.cls, _ST.brain, _ST.ctab, _ST.rrow, _ST.tim, simMoveWallGrid(),
        sl.bits, sl.sfree, sl.home, sl.cur, sl.heads, sl.entries, sl.used, sl.ever, sl.hdr,
        _simSlotZeroTable(S).tab, _spb.kind, B.colix, B.sty, B.ut, B.stk,
        C.hslot, S.hfree, _uix.ids, _uix.slots, mapOn ? map.t : null,
        O ? O.bits : null, O ? O.mask : null, O ? O.rec : null, null,
        _effRowCols.rMaxE, _effHot, U.tys, _effRowCols.rWch, U.bRad, _unitStatsVerTable(spatialUnitsComplexPlayerCount),
        W.free, B.wtab, B.wdefs, V,
        B.out, shift, B.list, B.dirty, S.sepKey, _mvtDirty && simHeapHas(_mvtDirty) ? _mvtDirty : null, B.wkind,
        B.rally, B.evl, typeof _airWallTable === 'function' ? _airWallTable() : null, B.cover, simHeapHas(cellArea) ? cellArea : null);
    const P = B.P;
    P.fill(0);
    P[0] = n; P[1] = GRID_W; P[2] = GRID_H; P[3] = TILE; P[4] = Math.min(S.cap, sl.sfree.length * SIM_SLAB); P[5] = SIM_SLAB_SLACK_MIN; P[6] = SIM_SLAB_SLACK_SHIFT;
    P[7] = SIM_SLAB_KEY_TILES; P[8] = sl.kw; P[9] = sl.kh; P[10] = nextUnitId; P[11] = S.hfreeN; P[12] = S.hnext;
    if (O) { P[13] = O.w; P[14] = O.h; P[15] = O.stride; P[16] = O.cell; P[17] = O.planes; }
    P[18] = W.freeCount; P[19] = W.used; P[20] = W.cap; P[21] = U.NT; P[22] = U.L1; P[23] = U.NP;
    P[25] = globalSpawnerReadyOrderCounter; P[26] = mapOn ? map.mask : 0; P[27] = _uix.n; P[28] = SIM_SEP_ABSENT;
    P[29] = WORKER_WORK_REGION_TILES; P[30] = _WORKER_WORK_TYPES.length; P[31] = _workerWorkType('healer'); P[32] = B.styN; P[33] = B.utN; P[34] = B.wN; P[35] = SIM_MOVE_BOX_STEPS; P[36] = simWttCode(null);
    P[37] = matchFullVisibility ? 1 : 0; P[38] = CMD_ATTACK_MOVING; P[39] = B.ncov;
    try { simRustDirect('k_spawn_births', A, P); } finally { A.length = 0; }
    const out = B.out, nb = out[0];
    if (out[10]) throw new Error('spawn births: a worker record past the pool (simUnitWkReserve)');
    S.owners.length = sl.hdr[7]; sl.layout = 0;
    globalSpawnerReadyOrderCounter = out[6];
    V.sum = (V.sum + out[7]) | 0;
    if (out[8] > 0) workSiteDirtyList(B.dirty, out[8]);
    if (nb > 0) {
        nextUnitId += nb;
        S.hfreeN -= out[2]; S.hnext += out[3];
        if (S.objs.length < S.hnext) { const L0 = S.objs.length; S.objs.length = S.hnext; S.objs.fill(null, L0); }
        W.freeCount -= out[4]; W.used += out[5];
        _uix.n += nb; _uix.ver++;
        if (mapOn) { map.used += nb; map.size += nb; }
        for (let o = 0; o < players.length && o < 64; o++) if (out[16 + o]) players[o].popCount += out[16 + o];
        if (O) { O.spawns += nb; O.registered += nb; O.relocated += out[9]; for (let r = 1; r < 48; r++) if (out[80 + r]) O.expectedBits += O.sizes[r] * out[80 + r]; }
        // Their spatial entries and upkeep bins (kernels over the births' slots).
        _spbSpatialList(B.list, nb);
        _spawnUpkeep(B.list, nb, C);
    }
    _spp.ns = out[11]; _spShiftRun();
    if (out[12] > 0) { playerResourceBatchBegin(); try { if (!waiAvailable()) throw new Error('spawn births: the worker pass is not available for the rally events'); waiOutEvents(waiRun(B.evl, out[12])); } finally { playerResourceBatchEnd(); } }
}
// The upkeep bins of n new units (birth.rs k_upk_bins, the slots of list).
function _spawnUpkeep(list, n, C) {
    const U = _upkU;
    if (!U || U.cols !== C || !(n > 0)) return;
    const P = _sb.UP;
    P.fill(0); P[0] = n; P[1] = U.np; P[2] = U.L1; P[3] = U.cnt.length;
    simRustDirect('k_upk_bins', [list, C.owner, C.upT, C.effectiveLevel, C.unitLevel, C.baseLevel, C.stackCount, C.upB, U.cnt], P);
}
class Barrack {
    constructor(gx, gy, owner, unitType = 'norm', stacks = 1) {
        if (typeof structTableInit === 'function') structTableInit(this);
        this.gx = gx; this.gy = gy; this.owner = owner;
        this.x = gx * TILE + 16; this.y = gy * TILE + 16;
        this.stacks = stacks; this.type = 'barrack'; this.unitType = unitType;
        this.manualStacks = stacks;
        this.effectiveStacks = stacks;
        this.level = stackCountToLevel(this.stacks);
        this.effectiveLevel = this.level;
        this.isStacking = false;
        this.stackingWorkDone = 0;
        this.spawnTimer = 0;

        this._qN = 0; // queued units (the front: _qLv, _qReq, _qPaid)
        this.rallyX = null; this.rallyY = null; // rally point in world coords
        this.rallyTargetUnitId = null;
        let stats = calculateItemStats('barrack_' + this.unitType, this.level, this.owner);

        this.energy = stats.maxEnergy;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.queueEnabled = true;
        updateItemTextCache(this);
    }

    getUnitCost() {
        let lvl = getThingBaseLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, this.unitType, lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }

    update() {
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;

        if (spawnQueueCount(this) > 0) {
            updateSpawnerProductionProgress(this);
        } else {
            this.spawnTimer = 0;
            this._spawnReadyOrder = undefined;
        }
    }

    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
        if (this.owner >= 0) {
            ctx.strokeStyle = get2DRenderOwnerColor(this.owner); ctx.lineWidth = 1;
            ctx.strokeRect(this.x - 15, this.y - 15, 30, 30);
        }

        ctx.fillStyle = '#664'; ctx.beginPath();
        ctx.moveTo(this.x - 12, this.y - 12); ctx.lineTo(this.x + 12, this.y - 12); ctx.lineTo(this.x, this.y - 20);
        ctx.fill();

        // Unit type indicator
        let us = BASE_UNIT_STATS[this.unitType] || BASE_UNIT_STATS.norm;
        ctx.fillStyle = us.color; ctx.beginPath(); ctx.arc(this.x, this.y + 4, 5, 0, 6.28); ctx.fill();

        if (this.underConstruction) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 14, 24, 3);
        } else {
            // Spawn progress (only show when queue has items)
            if (spawnQueueCount(this) > 0 && this.spawnCooldown > 0) {
                let pct = this.spawnTimer / this.spawnCooldown;
                let bw = 24, bh = 3, bx = this.x - bw / 2, by = this.y + 12;
                ctx.fillStyle = QUEUE_BAR_TRACK; ctx.fillRect(bx, by, bw, bh);
                ctx.fillStyle = pct > 0.8 ? '#4f4' : '#fa0'; ctx.fillRect(bx, by, bw * pct, bh);
            }
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 17, 24, 3);
        }
        if (this.textCanvas && shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);
    }
}
if (typeof structTableAccessors === 'function') structTableAccessors(Barrack, 0x33);

// ============================================================
// COLLECTOR / SALVAGER (barrack-like spawners + worker units)
// ============================================================
// A barrack or spawner whose update would change nothing: nothing queued,
// its timer at rest, no status running, alive; not a research building
// (its update moves research on). (Its spawn cooldown is worked
// out again by its next update, once something is queued.)
function spawnerQuiet(b) {
    return b.type !== 'research' && hasSpawnQueue(b) && spawnQueueCount(b) === 0 && !(b.spawnTimer > 0) && b._spawnReadyOrder === undefined
        && b.energy > 0 && !thingStatusPending(b);
}

// Production is a tier below the tick: a barrack or spawner brings its
// queue's front up to date (timer from the energy paid, its ready order
// once paid; a research building also its player's research task: a
// finished one completes) every SPAWNER_UPDATE_TICKS ticks, staggered by
// tile (payments and research work themselves are not delayed; a spawn is
// ready, research completes, up to that many ticks later).
const SPAWNER_UPDATE_TICKS = 4;
// Per player, the tick its research task was last moved on (by a research
// building's update; idempotent within a tick, so this only saves calls).
const _researchAdvancedTick = [];
function spawnerDue(b) {
    return simStepCrosses(b.gx + b.gy * 7, SPAWNER_UPDATE_TICKS);
}

class CollectorSpawner {
    constructor(gx, gy, owner, stacks = 1) {
        if (typeof structTableInit === 'function') structTableInit(this);
        this.gx = gx; this.gy = gy; this.owner = owner;
        this.x = gx * TILE + 16; this.y = gy * TILE + 16;
        this.stacks = stacks; this.type = 'spawner';
        this.manualStacks = stacks;
        this.effectiveStacks = stacks;
        this.level = stackCountToLevel(this.stacks);
        this.effectiveLevel = this.level;
        this.isStacking = false;
        this.stackingWorkDone = 0;
        let stats = calculateItemStats('spawner', this.level, this.owner);

        this.energy = stats.maxEnergy;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.queueEnabled = true;
        this._qN = 0; this.spawnTimer = 0;
        this.rallyX = null; this.rallyY = null; this.rallyTargetUnitId = null;

        updateItemTextCache(this);
    }
    getUnitCost() {
        let lvl = getThingBaseLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'collector', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }
    update() {
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;

        if (spawnQueueCount(this) > 0) {
            updateSpawnerProductionProgress(this);
        } else { this.spawnTimer = 0; this._spawnReadyOrder = undefined; }
    }
    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
        if (this.owner >= 0) {
            ctx.strokeStyle = get2DRenderOwnerColor(this.owner); ctx.lineWidth = 1;
            ctx.strokeRect(this.x - 15, this.y - 15, 30, 30);
        }
        drawWorkerBuildingEmblem(ctx, this.x, this.y, 1, this.type);
        if (this.underConstruction) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 10, 24, 3);
        } else {
            if (spawnQueueCount(this) > 0 && this.spawnCooldown > 0) {
                let pct = this.spawnTimer / this.spawnCooldown;
                ctx.fillStyle = QUEUE_BAR_TRACK; ctx.fillRect(this.x - 12, this.y + 6, 24, 3);
                ctx.fillStyle = pct > 0.8 ? '#4f4' : '#fa0'; ctx.fillRect(this.x - 12, this.y + 6, 24 * pct, 3);
            }
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 11, 20, 3);
        }
        if (this.textCanvas && shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);
    }
}
if (typeof structTableAccessors === 'function') structTableAccessors(CollectorSpawner, 0x44);

class AstarSpawner {
    constructor(gx, gy, owner, stacks = 1) {
        if (typeof structTableInit === 'function') structTableInit(this);
        this.gx = gx; this.gy = gy; this.owner = owner;
        this.x = gx * TILE + 16; this.y = gy * TILE + 16;
        this.stacks = stacks; this.type = 'astar_spawner';
        this.manualStacks = stacks;
        this.effectiveStacks = stacks;
        this.level = stackCountToLevel(this.stacks);
        this.effectiveLevel = this.level;
        this.isStacking = false;
        this.stackingWorkDone = 0;
        let stats = calculateItemStats('astar_spawner', this.level, this.owner);

        this.energy = stats.maxEnergy;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.queueEnabled = true;
        this._qN = 0; this.spawnTimer = 0;
        this.rallyX = null; this.rallyY = null; this.rallyTargetUnitId = null;

        updateItemTextCache(this);
    }
    getUnitCost() {
        let lvl = getThingBaseLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'astar_collector', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }
    update() {
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;

        if (spawnQueueCount(this) > 0) {
            updateSpawnerProductionProgress(this);
        } else { this.spawnTimer = 0; this._spawnReadyOrder = undefined; }
    }
    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
        if (this.owner >= 0) {
            ctx.strokeStyle = get2DRenderOwnerColor(this.owner); ctx.lineWidth = 1;
            ctx.strokeRect(this.x - 15, this.y - 15, 30, 30);
        }
        drawWorkerBuildingEmblem(ctx, this.x, this.y, 1, this.type);
        if (this.underConstruction) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 10, 24, 3);
        } else {
            if (spawnQueueCount(this) > 0 && this.spawnCooldown > 0) {
                let pct = this.spawnTimer / this.spawnCooldown;
                ctx.fillStyle = QUEUE_BAR_TRACK; ctx.fillRect(this.x - 12, this.y + 6, 24, 3);
                ctx.fillStyle = pct > 0.8 ? '#4f4' : '#fa0'; ctx.fillRect(this.x - 12, this.y + 6, 24 * pct, 3);
            }
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 11, 20, 3);
        }
        if (this.textCanvas && shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);
    }
}
if (typeof structTableAccessors === 'function') structTableAccessors(AstarSpawner, 0x44);

class SalvagerSpawner {
    constructor(gx, gy, owner, stacks = 1) {
        if (typeof structTableInit === 'function') structTableInit(this);
        this.gx = gx; this.gy = gy; this.owner = owner;
        this.x = gx * TILE + 16; this.y = gy * TILE + 16;
        this.stacks = stacks; this.type = 'salvager';
        this.manualStacks = stacks;
        this.effectiveStacks = stacks;
        this.level = stackCountToLevel(this.stacks);
        this.effectiveLevel = this.level;
        this.isStacking = false;
        this.stackingWorkDone = 0;
        let stats = calculateItemStats('salvager', this.level, this.owner);

        this.energy = stats.maxEnergy;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.queueEnabled = true;
        this._qN = 0; this.spawnTimer = 0;
        this.rallyX = null; this.rallyY = null; this.rallyTargetUnitId = null;

        updateItemTextCache(this);
    }
    getUnitCost() {
        let lvl = getThingBaseLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'salvager_unit', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }
    update() {
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;

        if (spawnQueueCount(this) > 0) {
            updateSpawnerProductionProgress(this);
        } else { this.spawnTimer = 0; this._spawnReadyOrder = undefined; }
    }
    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
        if (this.owner >= 0) {
            ctx.strokeStyle = get2DRenderOwnerColor(this.owner); ctx.lineWidth = 1;
            ctx.strokeRect(this.x - 15, this.y - 15, 30, 30);
        }
        drawWorkerBuildingEmblem(ctx, this.x, this.y, 1, this.type);
        if (this.underConstruction) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 10, 24, 3);
        } else {
            if (spawnQueueCount(this) > 0 && this.spawnCooldown > 0) {
                let pct = this.spawnTimer / this.spawnCooldown;
                ctx.fillStyle = QUEUE_BAR_TRACK; ctx.fillRect(this.x - 12, this.y + 6, 24, 3);
                ctx.fillStyle = pct > 0.8 ? '#4f4' : '#fa0'; ctx.fillRect(this.x - 12, this.y + 6, 24 * pct, 3);
            }
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 11, 20, 3);
        }
        if (this.textCanvas && shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);
    }
}
if (typeof structTableAccessors === 'function') structTableAccessors(SalvagerSpawner, 0x44);

class BuilderSpawner {
    constructor(gx, gy, owner, stacks = 1) {
        if (typeof structTableInit === 'function') structTableInit(this);
        this.gx = gx; this.gy = gy; this.owner = owner;
        this.x = gx * TILE + 16; this.y = gy * TILE + 16;
        this.stacks = stacks; this.type = 'builder_spawner';
        this.manualStacks = stacks;
        this.effectiveStacks = stacks;
        this.level = stackCountToLevel(this.stacks);
        this.effectiveLevel = this.level;
        this.isStacking = false;
        this.stackingWorkDone = 0;
        let stats = calculateItemStats('builder_spawner', this.level, this.owner);

        this.energy = stats.maxEnergy;
        this.underConstruction = true;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.queueEnabled = true;
        this._qN = 0; this.spawnTimer = 0;
        this.rallyX = null; this.rallyY = null; this.rallyTargetUnitId = null;

        updateItemTextCache(this);
    }
    getUnitCost() {
        let lvl = getThingBaseLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'builder_unit', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }
    // Builder DPS per unit: scales with base level
    getBuilderDps() {
        let lvl = getThingBaseLevel(this);
        let dps = getUnitStatForOwner(this.owner, 'builder_unit', lvl, 'builderDps');
        let fallback = 1;
        return Math.max(1, Math.round(Number.isFinite(dps) ? dps : fallback));
    }
    update() {
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;

        if (spawnQueueCount(this) > 0) {
            updateSpawnerProductionProgress(this);
        } else { this.spawnTimer = 0; this._spawnReadyOrder = undefined; }
    }
    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
        if (this.owner >= 0) {
            ctx.strokeStyle = get2DRenderOwnerColor(this.owner); ctx.lineWidth = 1;
            ctx.strokeRect(this.x - 15, this.y - 15, 30, 30);
        }
        drawWorkerBuildingEmblem(ctx, this.x, this.y, 1, this.type);
        if (this.underConstruction) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 10, 24, 3);
        } else {
            if (spawnQueueCount(this) > 0 && this.spawnCooldown > 0) {
                let pct = this.spawnTimer / this.spawnCooldown;
                ctx.fillStyle = QUEUE_BAR_TRACK; ctx.fillRect(this.x - 12, this.y + 6, 24, 3);
                ctx.fillStyle = pct > 0.8 ? '#4f4' : '#fa0'; ctx.fillRect(this.x - 12, this.y + 6, 24 * pct, 3);
            }
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 11, 20, 3);
        }
        if (this.textCanvas && shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);
    }
}
if (typeof structTableAccessors === 'function') structTableAccessors(BuilderSpawner, 0x44);

class HealerSpawner {
    constructor(gx, gy, owner, stacks = 1) {
        if (typeof structTableInit === 'function') structTableInit(this);
        this.gx = gx; this.gy = gy; this.owner = owner;
        this.x = gx * TILE + 16; this.y = gy * TILE + 16;
        this.stacks = stacks; this.type = 'healer_spawner';
        this.manualStacks = stacks;
        this.effectiveStacks = stacks;
        this.level = stackCountToLevel(this.stacks);
        this.effectiveLevel = this.level;
        this.isStacking = false;
        this.stackingWorkDone = 0;
        let stats = calculateItemStats('healer_spawner', this.level, this.owner);

        this.energy = stats.maxEnergy;
        this.underConstruction = true;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.queueEnabled = true;
        this._qN = 0; this.spawnTimer = 0;
        this.rallyX = null; this.rallyY = null; this.rallyTargetUnitId = null;

        updateItemTextCache(this);
    }
    getUnitCost() {
        let lvl = getThingBaseLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'healer_unit', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }
    gethealerDps() {
        let lvl = getThingBaseLevel(this);
        let dps = getUnitStatForOwner(this.owner, 'healer_unit', lvl, 'healerDps');
        let fallback = 1;
        return Math.max(1, Math.round(Number.isFinite(dps) ? dps : fallback));
    }
    update() {
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;

        if (spawnQueueCount(this) > 0) {
            updateSpawnerProductionProgress(this);
        } else { this.spawnTimer = 0; this._spawnReadyOrder = undefined; }
    }
    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
        if (this.owner >= 0) {
            ctx.strokeStyle = get2DRenderOwnerColor(this.owner); ctx.lineWidth = 1;
            ctx.strokeRect(this.x - 15, this.y - 15, 30, 30);
        }
        drawWorkerBuildingEmblem(ctx, this.x, this.y, 1, this.type);
        if (this.underConstruction) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 10, 24, 3);
        } else {
            if (spawnQueueCount(this) > 0 && this.spawnCooldown > 0) {
                let pct = this.spawnTimer / this.spawnCooldown;
                ctx.fillStyle = QUEUE_BAR_TRACK; ctx.fillRect(this.x - 12, this.y + 6, 24, 3);
                ctx.fillStyle = pct > 0.8 ? '#4f4' : '#fa0'; ctx.fillRect(this.x - 12, this.y + 6, 24 * pct, 3);
            }
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 11, 20, 3);
        }
        if (this.textCanvas && shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);
    }
}
if (typeof structTableAccessors === 'function') structTableAccessors(HealerSpawner, 0x44);

class ResearchSpawner {
    constructor(gx, gy, owner, stacks = 1) {
        if (typeof structTableInit === 'function') structTableInit(this);
        this.gx = gx; this.gy = gy; this.owner = owner;
        this.x = gx * TILE + 16; this.y = gy * TILE + 16;
        this.stacks = stacks; this.type = 'research';
        this.manualStacks = stacks;
        this.effectiveStacks = stacks;
        this.level = stackCountToLevel(this.stacks);
        this.effectiveLevel = this.level;
        this.isStacking = false;
        this.stackingWorkDone = 0;
        this.spawnTimer = 0;

        this._qN = 0;
        this.rallyX = null; this.rallyY = null;
        this.rallyTargetUnitId = null;
        let stats = calculateItemStats('research', this.level, this.owner);

        this.energy = stats.maxEnergy;
        this.underConstruction = true;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.queueEnabled = true;
        this.autoResearchEnabled = true;
        updateItemTextCache(this);
    }

    getUnitCost() {
        let lvl = getThingBaseLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'researcher_unit', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }

    getResearcherDps() {
        let lvl = getThingBaseLevel(this);
        let dps = getUnitStatForOwner(this.owner, 'researcher_unit', lvl, 'researcherDps');
        let fallback = 1;
        return Math.max(1, Math.round(Number.isFinite(dps) ? dps : fallback));
    }

    update() {
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;


        if (spawnQueueCount(this) > 0) {
            updateSpawnerProductionProgress(this);
        } else {
            this.spawnTimer = 0;
            this._spawnReadyOrder = undefined;
        }

        // (The player's research is one global pool: moved on at most once a
        // tick, by the first of its research buildings to update.)
        let task;
        if (_researchAdvancedTick[this.owner] === gameTime) task = getPlayerResearchTask(this.owner);
        else { _researchAdvancedTick[this.owner] = gameTime; task = tryAdvancePlayerResearchTask(this.owner); }
    }

    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
        if (this.owner >= 0) {
            ctx.strokeStyle = get2DRenderOwnerColor(this.owner); ctx.lineWidth = 1;
            ctx.strokeRect(this.x - 15, this.y - 15, 30, 30);
        }
        drawWorkerBuildingEmblem(ctx, this.x, this.y, 1, this.type);
        if (this.underConstruction) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 10, 24, 3);
        } else {
            if (spawnQueueCount(this) > 0 && this.spawnCooldown > 0) {
                let pct = this.spawnTimer / this.spawnCooldown;
                ctx.fillStyle = QUEUE_BAR_TRACK; ctx.fillRect(this.x - 12, this.y + 6, 24, 3);
                ctx.fillStyle = pct > 0.8 ? '#4f4' : '#fa0'; ctx.fillRect(this.x - 12, this.y + 6, 24 * pct, 3);
            }
            if (this.researchTask && this.researchTask.workRequired > 0) {
                let pct = Math.max(0, Math.min(1, (this.researchTask.workDone || 0) / this.researchTask.workRequired));
                ctx.fillStyle = QUEUE_BAR_TRACK; ctx.fillRect(this.x - 12, this.y + 2, 24, 3);
                ctx.fillStyle = pct > 0.8 ? '#4f4' : '#4af'; ctx.fillRect(this.x - 12, this.y + 2, 24 * pct, 3);
            }
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 11, 20, 3);
        }

        if (this.textCanvas && shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);
    }
}
if (typeof structTableAccessors === 'function') structTableAccessors(ResearchSpawner, 0x44);
// Its player's research task and whether it works on it: derived (the task
// is the player's; nothing is written into each research building when it
// changes). Writes are ignored. (The page's views define their own.)
Object.defineProperties(ResearchSpawner.prototype, {
    researchTask: { configurable: true, get() { return this.owner >= 0 && players[this.owner] ? getPlayerResearchTask(this.owner) || null : null; }, set(v) {} },
    isResearching: { configurable: true, get() { const t = this.researchTask; return !!(t && !this.isUpgrading && isAutoResearchEnabled(this) && (t.workDone || 0) < t.workRequired); }, set(v) {} },
});

// (The interface's copy of a queue: see spawnQueueCount.)
for (const C of [Barrack, CollectorSpawner, AstarSpawner, SalvagerSpawner, BuilderSpawner, HealerSpawner, ResearchSpawner]) Object.defineProperty(C.prototype, 'spawnQueue', _SPAWN_QUEUE_PROP);
