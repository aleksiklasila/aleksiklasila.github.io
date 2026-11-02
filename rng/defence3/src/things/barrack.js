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
function spawnerProductionChanged(s) {
    if (!s || !hasSpawnQueue(s) || !(s.energy > 0) || s.underConstruction) return;

    const had = Number.isFinite(s._spawnReadyOrder);
    if (spawnQueueCount(s) > 0) updateSpawnerProductionProgress(s);
    else { s.spawnTimer = 0; s._spawnReadyOrder = undefined; }
    // (Ready already: listed again, its entry may have been passed while it
    // could not spawn.)
    if (had && Number.isFinite(s._spawnReadyOrder)) spawnerReadyNoted(s);
}
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
function updateSpawnerProductionProgress(spawner) {
    if (!spawner) return;
    // (The production pass does this for every spawner each step.)
    if (_spProdOn()) return;
    if (!(spawnQueueCount(spawner) > 0)) {
        spawner.spawnTimer = 0;
        spawner._spawnReadyOrder = undefined;
        return;
    }
    let front = spawnQueueFront(spawner);

    let cooldown = Math.max(1, Math.round(spawner.spawnCooldown || 1));

    let paidPct = front.energyRequired > 0 ? (front.energyPaid / front.energyRequired) : 0;
    spawner.spawnTimer = Math.max(0, Math.min(cooldown, Math.round(cooldown * paidPct)));
    if (front.energyPaid >= front.energyRequired && !Number.isFinite(spawner._spawnReadyOrder)) {
        spawner._spawnReadyOrder = globalSpawnerReadyOrderCounter++;
        spawnerReadyNoted(spawner);
    } else if (front.energyPaid < front.energyRequired) {
        spawner._spawnReadyOrder = undefined;
    }
}

// (A spawner's rally path from its exit: spawnQueuedUnitFromSpawner. Weak: no property on the structure.)
const _spawnerRallyTpl = new WeakMap();
// A step's spawns are one batch (unit.js simSpawnBatchAdd/Write/Finish): the
// scheduler (processGlobalSpawnerQueue) begins each in order (_spawnBegin:
// its checks, its exit, its unit's slot and id), the batch's columns are
// written at once, then each ends in the same order (_spawnEnd: the unit
// finished (occupancy, spatial index), the queue moved on, the rally).
// Exits by batch index (tile x, y).
// (Room for a batch's spawns: unit.js SPB_CAP, which loads after this file.)
const _spawnBatch = { ex: new Int32Array(2 * 16384), n: 0 };
// A spawner's next unit begun: false when it may not spawn. Its owner's
// population counts it at once (given back when it finds no room at its
// exit): a step's spawns are decided before any is placed.
function _spawnBegin(spawner) {
    if (!spawner || !(spawnQueueCount(spawner) > 0)) return false;
    if (spawner.energy <= 0 || spawner.underConstruction) return false;
    if (!isQueueEnabled(spawner)) return false;
    const owner = spawner.owner;
    if (!(players[owner].popCount < getPlayerPopCap(owner))) return false;
    const front = spawnQueueFront(spawner), unitType = front.unitType, level = front.level;
    const p = findNearestWalkable(spawner.gx, spawner.gy), B = _spawnBatch, k = B.n++;
    B.ex[2 * k] = p.x; B.ex[2 * k + 1] = p.y;
    simSpawnBatchAdd(unitType, owner, p.x * TILE + 16, p.y * TILE + 16, level, configureWorkerUnitFromType);
    players[owner].popCount++;
    return true;
}
// One spawner's spawn alone (a batch of one): whether it spawned.
function spawnQueuedUnitFromSpawner(spawner) {
    if (_spawnBatch.n !== 0) throw new Error('spawnQueuedUnitFromSpawner during a spawn batch');
    if (!_spawnBegin(spawner)) return false;
    simSpawnBatchWrite();
    const ok = _spawnEnd(0, spawner);
    _spawnBatch.n = 0; simSpawnBatchClear();
    return ok;
}
// The batch's spawn k (spawner's) ended: false when its unit found no room.
function _spawnEnd(k, spawner) {
    const u = simSpawnBatchFinish(k), owner = spawner.owner, spawnPos = { x: _spawnBatch.ex[2 * k], y: _spawnBatch.ex[2 * k + 1] };
    if (u.dead) { players[owner].popCount--; return false; }
    // (In the production pass: the queues move on together after the batch, spr.rs k_spawn_shift.)
    if (_spp.on) _spShiftNote(spawner); else spawnQueueShift(spawner);
    // The queue moved on: its next item may need healers' energy.
    if (typeof workerWorkChanged === 'function') workerWorkChanged(spawner.owner, 'healer', spawner.gx, spawner.gy);
    if (typeof workSiteDirty === 'function') workSiteDirty(spawner.gx, spawner.gy);
    unitAdded(u);

    // For worker units, rally is a direct move order that must be followed before auto-search resumes.
    if (u.workerType && typeof applyWorkerRallyFromSpawner === 'function') {
        if (applyWorkerRallyFromSpawner(u, spawner)) {
            spawner.spawnTimer = 0;
            spawner._spawnReadyOrder = undefined;
            return true;
        }
    }

    let rallyTarget = getSpawnerRallyTargetWorld(spawner);
    if (rallyTarget) {
        let rgx = Math.floor(rallyTarget.x / TILE), rgy = Math.floor(rallyTarget.y / TILE);
        let rallyPath = null;
        if (_canUsePathfindRequestBudget(u.owner, u)) {
            _consumePathfindRequestBudget(u.owner, u);
            // (The spawner's own: its exit, its rally tile and the unit's
            // movement profile as of the path topology's version, for
            // SPAWNER_RALLY_TEMPLATE_TTL_TICKS. Was a shared map by a ten-part
            // string key made each spawn: ~1.1k spawns a tick in a big match.)
            const canWalk = getPathCanWalkForUnit(u), prof = _resolveMovementProfile(!!u.isFlying, canWalk, null) || 'dynamic';
            let T = _spawnerRallyTpl.get(spawner);
            if (T && T.sx === spawnPos.x && T.sy === spawnPos.y && T.ex === rgx && T.ey === rgy && T.prof === prof && T.version === pathTopologyVersion
                && !(gameTime - T.tick > SPAWNER_RALLY_TEMPLATE_TTL_TICKS)) rallyPath = T.path;
            if (!rallyPath) {
                rallyPath = _findPathForUnitTagged('spawner_rally', u, spawnPos.x, spawnPos.y, rgx, rgy, u.isFlying, canWalk, u.owner);
                _spawnerRallyTpl.set(spawner, { sx: spawnPos.x, sy: spawnPos.y, ex: rgx, ey: rgy, prof, version: pathTopologyVersion, tick: gameTime, path: rallyPath });
            }
        }

        if (spawner.type === 'barrack') {
            if (!rallyPath || rallyPath.length <= 0) {
                rallyPath = _makeFallbackPathForUnit(u, spawnPos.x, spawnPos.y, rgx, rgy, CMD_ATTACK_MOVING, 'spawner_rally');
            }
            u.path = rallyPath;
            u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === spawnPos.x && u.path[0].y === spawnPos.y) ? 1 : 0;
            if (u.path && u.path.length > 0) u.commandState = CMD_ATTACK_MOVING;
        } else {
            if (!rallyPath || rallyPath.length <= 0) {
                rallyPath = _makeFallbackPathForUnit(u, spawnPos.x, spawnPos.y, rgx, rgy, CMD_MOVING, 'spawner_rally');
            }
            u.path = rallyPath;
            u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === spawnPos.x && u.path[0].y === spawnPos.y) ? 1 : 0;
            u.commandState = CMD_MOVING;
            u.workerState = 'MANUAL_MOVE';
            u.targetPos = { x: rgx * TILE + 16, y: rgy * TILE + 16 };
            u._manualMoveIssuedTick = gameTime;
        }
    }

    spawner.spawnTimer = 0;
    spawner._spawnReadyOrder = undefined;
    return true;
}

// Spawners whose queue front is paid, by ready order (_spawnReadyOrder,
// assigned from an increasing counter: appended, each owner's list stays
// sorted): per owner its entries (spawner, order) from a head index. An
// entry whose spawner no longer holds that order (spawned, dequeued,
// removed) is dropped when reached. Made anew from the spawners on every
// peer after a resync (spawnerReadyReset).
let _spawnReady = null;
function spawnerReadyReset() { _spawnReady = null; }
// After s._spawnReadyOrder was assigned.
function spawnerReadyNoted(s) {
    if (_spProdOn()) return;
    const R = _spawnReady;
    if (!R || !s || !Number.isFinite(s._spawnReadyOrder)) return;
    const o = Number.isFinite(s.owner) ? s.owner : -1;
    let L = R.byOwner.get(o);
    if (!L) R.byOwner.set(o, L = { e: [], head: 0 });
    const order = s._spawnReadyOrder, e = L.e;
    if (e.length <= L.head || e[e.length - 1] <= order) e.push(s, order);
    else {
        // (An older order again, e.g. its queue enabled again: in its place.)
        let lo = L.head >> 1, hi = e.length >> 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (e[mid * 2 + 1] <= order) lo = mid + 1; else hi = mid; }
        e.splice(lo * 2, 0, s, order);
    }
    // (Stale entries pile up only behind an owner at its cap: compacted now and then.)
    if (L.e.length - L.head > 4 * structLiveRows(1, 2) + 64) _spawnReadyCompact(L);
}
function _spawnReadyCompact(L) {
    const e = [];
    for (let k = L.head; k < L.e.length; k += 2) if (L.e[k]._spawnReadyOrder === L.e[k + 1]) e.push(L.e[k], L.e[k + 1]);
    L.e = e; L.head = 0;
}
function _spawnReadyBuild() {
    const R = _spawnReady = { byOwner: new Map() }, all = [];
    for (const b of barracks) if (b && Number.isFinite(b._spawnReadyOrder)) all.push(b);
    for (const s of collectorSpawners) if (s && Number.isFinite(s._spawnReadyOrder)) all.push(s);
    all.sort((a, b) => a._spawnReadyOrder - b._spawnReadyOrder);
    for (const s of all) spawnerReadyNoted(s);
    return R;
}
// Whether s (holding a ready order) may spawn: in the world, alive, built,
// its queue enabled and its front paid.
function _spawnReadyValid(s) {
    if (!s || s.energy <= 0 || s.underConstruction || !isQueueEnabled(s)) return false;
    if (!(spawnQueueCount(s) > 0)) return false;
    if (typeof getTileEntityRef === 'function' && getTileEntityRef(s.gx, s.gy) !== s) return false;
    const front = spawnQueueFront(s);
    return front.energyPaid >= front.energyRequired;
}
// An owner's first entry that may spawn now: its order (its list's head
// moved past the stale ones), Infinity when none or the owner is at its
// population cap.
function _spawnHeadOrder(o, L) {
    if (L.head >= L.e.length) return Infinity;
    if (!(o >= 0 && players[o] && players[o].popCount < getPlayerPopCap(o))) return Infinity;
    while (L.head < L.e.length) {
        const s = L.e[L.head], order = L.e[L.head + 1];
        if (s._spawnReadyOrder === order && _spawnReadyValid(s)) return order;
        L.head += 2;
    }
    L.e = []; L.head = 0;
    return Infinity;
}
// (Per owner taking part this tick: its list and its head's order. A spawn
// changes only its own owner's head (that spawner, that owner's population):
// the others' are found once a tick, not again for every spawn.)
const _spawnPickL = [], _spawnPickO = [], _spawnPicked = [];
// (The batch emptied.)
function _spawnBatchDone() { _spawnBatch.n = 0; simSpawnBatchClear(); }
let _spawnPickOrd = new Float64Array(64);
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
    _spArr('sel', Int32Array, rows + 4); _spArr('tmp', Uint32Array, 5 * rows + 65536); _spArr('shift', Int32Array, SPB_CAP + 1);
}
const _SP_COLS = ['_stT', '_ow', '_en', '_uc', 'queueEnabled', '_qN', '_qLv', '_qReq', '_qPaid', '_spt', '_spawnReadyOrder'];
function _spClasses() {
    if (!_spp.classes) {
        _spp.classes = [Barrack, CollectorSpawner, AstarSpawner, typeof SalvagerSpawner !== 'undefined' ? SalvagerSpawner : null, typeof BuilderSpawner !== 'undefined' ? BuilderSpawner : null,
            typeof HealerSpawner !== 'undefined' ? HealerSpawner : null, typeof ResearchSpawner !== 'undefined' ? ResearchSpawner : null].filter(Boolean);
        _spp.ix = new Map(_spp.classes.map((C, k) => [C, k]));
    }
    return _spp.classes;
}
// A spawner that spawned: its queue moves on after the batch.
function _spShiftNote(s) {
    const k = _spp.ix.get(s.constructor), L = _spp.shift;
    if (k === undefined || !(s._sr >= 0) || !L || _spp.ns >= L.length) { spawnQueueShift(s); return; }
    L[_spp.ns++] = (k << 24) | s._sr;
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
function spawnerProductionPass() {
    const S = _spp, CL = _spClasses();
    if (globalSpawnerReadyOrderCounter > 1073741824) _spRebase(CL);
    if (typeof structRallyClasses === 'function') structRallyClasses();
    const cls = _spArr('cls', Int32Array, CL.length * 16);
    const jobs = [];
    CL.forEach((C, k) => {
        const T = _sTables.get(C), b = k * 16;
        cls.fill(0, b, b + 16);
        if (!T || !(T.n > 0)) return;
        const cols = _SP_COLS.map(f => T['c_' + f]);
        if (cols.some(a => !a || !simHeapHas(a))) return;
        cls[b] = T.n; cls[b + 1] = _stAllIx.get(C) || 0;
        cols.forEach((a, j) => { cls[b + 2 + j] = _simWEnc(_simHeapPtrOf(a)); });
        for (let r = 0; r < T.n; r += SPAWN_PROD_ROWS) jobs.push(k, r, Math.min(T.n, r + SPAWN_PROD_ROWS));
    });
    const J = jobs.length / 3, sel = _spArr('sel', Int32Array, 8);
    if (J === 0) { sel[0] = 0; return sel; }
    const JB = _spArr('jobs', Int32Array, jobs.length); JB.set(jobs);
    const np1 = players.length + 1, tab = _spArr('tab', Float64Array, np1 * SPAWN_PROD_TYPES * 64 * 3);
    if (S.np !== np1) { tab.fill(NaN); S.np = np1; }
    const out = _spArr('out', Int32Array, J * SPAWN_PROD_ROWS * 5), cnt = _spArr('cnt', Int32Array, J * 16);
    for (const [nm, a] of [['spr.cls', cls], ['spr.jobs', JB], ['st.brain', _ST.brain], ['st.ctab', _ST.ctab], ['st.rrow', _ST.rrow], ['st.tim', _ST.tim], ['spr.tab', tab], ['spr.out', out], ['spr.cnt', cnt]]) simParallelBind(nm, a);
    const ver = _precomputedStatsVersion, P = _simParams;
    // The table's missing or stale keys, then every row.
    P[0] = J; P[1] = 0; P[2] = ver; P[3] = SPAWN_PROD_TYPES; P[4] = SPAWN_PROD_ROWS;
    simParallelRun(SIM_KERNEL_SPAWN_PROD, J);
    for (let j = 0; j < J; j++) { const b = j * SPAWN_PROD_ROWS * 5 + SPAWN_PROD_ROWS * 4; for (let i = 0, m = cnt[j * 16 + 2]; i < m; i++) { const key = out[b + i]; if (tab[key * 3 + 2] !== ver) _spTabFill(tab, key, ver); } }
    P[0] = J; P[1] = 1; P[2] = ver; P[3] = SPAWN_PROD_TYPES; P[4] = SPAWN_PROD_ROWS;
    simParallelRun(SIM_KERNEL_SPAWN_PROD, J);
    let cap = 0;
    for (let j = 0; j < J; j++) cap += cnt[j * 16] + cnt[j * 16 + 1];
    const sl = _spArr('sel', Int32Array, cap + 4), tmp = _spArr('tmp', Uint32Array, 5 * Math.max(1, cap) + 65536), AP = S.AP;
    AP.fill(0); AP[0] = J; AP[1] = SPAWN_PROD_ROWS; AP[2] = globalSpawnerReadyOrderCounter; AP[62] = Math.max(1, cap); AP[63] = Math.min(56, players.length);
    for (let o = 0; o < players.length && o < 56; o++) AP[3 + o] = players[o] ? Math.max(0, getPlayerPopCap(o) - players[o].popCount) : 0;
    simRustDirect('k_spawn_select', [cls, out, cnt, sl, tmp], AP);
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
    if (S.ns > 0) { const BP = S.BP; BP[0] = S.ns; BP[1] = SPAWN_PROD_TYPES; simRustDirect('k_spawn_shift', [S.cls, S.shift, _ST.brain, S.tab], BP); }
    S.ns = 0;
}
function processGlobalSpawnerQueue() {
    if (_spProdOn()) { _processSpawnsByTables(); return; }
    _spp.on = false;
    _processGlobalSpawnerQueueJs();
}
// The production pass's spawns: its list in order, one batch.
function _processSpawnsByTables() {
    const S = _spp;
    S.on = true; S.ns = 0;
    const sel = spawnerProductionPass(), n = sel[0], blocked = [], picked = _spawnPicked;
    // (In batches of at most SPB_CAP spawns, each written and ended before
    // the next begins: the batch's buffers are the match's, made once.)
    for (let i = 1; i <= n;) {
        for (; i <= n && !(typeof simSpawnBatchFull === 'function' && simSpawnBatchFull()); i++) {
            const t = sel[i], s = getTileEntityRef(t % GRID_W, Math.floor(t / GRID_W));
            if (!s) continue;
            if (!_spawnBegin(s)) { blocked.push(s); continue; }
            s._spawnReadyOrder = undefined;
            picked.push(s);
        }
        simSpawnBatchWrite();
        // (Room for every spawner's shift first: _spShiftNote fills it.)
        _spArr('shift', Int32Array, SPB_CAP + 1);
        for (let k = 0; k < picked.length; k++) { const s = picked[k]; if (!_spawnEnd(k, s)) blocked.push(s); }
        _spShiftRun();
        picked.length = 0; _spawnBatchDone();
    }
    // (A full exit: its turn again behind those ready now, on a later step.)
    for (const s of blocked) s._spawnReadyOrder = globalSpawnerReadyOrderCounter++;
}
function _processGlobalSpawnerQueueJs() {
    // The ready spawners in ready order across owners (each owner's list is
    // sorted; owners at their population cap are passed over whole), every
    // ready one (no cap a tick); a spawner ready again after spawning goes to
    // the end (a new order: the next tick's), as ever.
    const R = _spawnReady || _spawnReadyBuild();
    const Ls = _spawnPickL, Os = _spawnPickO;
    let m = 0;
    for (const [o, L] of R.byOwner) {
        if (m >= _spawnPickOrd.length) { const g = new Float64Array(m * 2); g.set(_spawnPickOrd); _spawnPickOrd = g; }
        Ls[m] = L; Os[m] = o; _spawnPickOrd[m] = _spawnHeadOrder(o, L); m++;
    }
    const ord = _spawnPickOrd;
    const blocked = [], picked = _spawnPicked;
    // (Those ready now: one spawn each this tick, its next front the next tick.)
    const again = [];
    while (blocked.length < 64 && !(typeof simSpawnBatchFull === 'function' && simSpawnBatchFull())) {
        let bi = -1, bestOrder = Infinity;
        for (let i = 0; i < m; i++) if (ord[i] < bestOrder) { bestOrder = ord[i]; bi = i; }
        if (bi < 0) break;
        const best = Ls[bi], s = best.e[best.head];
        best.head += 2;
        if (!_spawnBegin(s)) blocked.push(s);
        else {
            // (Taken this tick: its other entries are stale.)
            s._spawnReadyOrder = undefined;
            picked.push(s);
            if (best.head > 4096 && best.head * 2 > best.e.length) { best.e = best.e.slice(best.head); best.head = 0; }
        }
        ord[bi] = _spawnHeadOrder(Os[bi], best);
    }
    for (let i = 0; i < m; i++) Ls[i] = null;
    // The batch's units written, then each spawn ended in order. (A full
    // occupancy footprint at one exit must not stop production at every
    // other spawner: retried once on a later tick, in order.)
    simSpawnBatchWrite();
    for (let k = 0; k < picked.length; k++) {
        const s = picked[k];
        if (!_spawnEnd(k, s)) { blocked.push(s); continue; }
        // Its next front, if paid already: ready again (a new order).
        if (_spawnReadyValid(s) && !Number.isFinite(s._spawnReadyOrder)) again.push(s);
    }
    picked.length = 0; _spawnBatchDone();
    for (const s of again) { s._spawnReadyOrder = globalSpawnerReadyOrderCounter++; spawnerReadyNoted(s); }
    for (const s of blocked) { s._spawnReadyOrder = globalSpawnerReadyOrderCounter++; spawnerReadyNoted(s); }
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
    researchTask: { configurable: true, get() { const p = this.owner >= 0 ? players[this.owner] : null; return (p && p.researchTask) || null; }, set(v) {} },
    isResearching: { configurable: true, get() { const t = this.researchTask; return !!(t && !this.isUpgrading && isAutoResearchEnabled(this) && (t.workDone || 0) < t.workRequired); }, set(v) {} },
});

function _makeSpawnerRallyTemplateKey(spawner, startGx, startGy, endGx, endGy, unit) {
    let movementProfile = _resolveMovementProfile(!!(unit && unit.isFlying), getPathCanWalkForUnit(unit), null) || 'dynamic';
    return [
        spawner.type,
        spawner.owner,
        spawner.gx,
        spawner.gy,
        startGx,
        startGy,
        endGx,
        endGy,
        movementProfile,
        pathTopologyVersion
    ].join('|');
}

function _getSpawnerRallyTemplatePath(cacheKey) {
    let entry = sharedSpawnerRallyTemplateCache.get(cacheKey);
    if (entry && !_isPathCacheExpired(entry, SPAWNER_RALLY_TEMPLATE_TTL_TICKS)) {
        return entry.path;
    }
    if (entry) sharedSpawnerRallyTemplateCache.delete(cacheKey);
    return null;
}

function _setSpawnerRallyTemplatePath(cacheKey, path) {
    sharedSpawnerRallyTemplateCache.set(cacheKey, {
        path,
        tick: gameTime,
        version: pathTopologyVersion
    });
    _trimPathCacheIfNeeded(sharedSpawnerRallyTemplateCache, SPAWNER_RALLY_TEMPLATE_MAX_ENTRIES);
}
// (The interface's copy of a queue: see spawnQueueCount.)
for (const C of [Barrack, CollectorSpawner, AstarSpawner, SalvagerSpawner, BuilderSpawner, HealerSpawner, ResearchSpawner]) Object.defineProperty(C.prototype, 'spawnQueue', _SPAWN_QUEUE_PROP);
