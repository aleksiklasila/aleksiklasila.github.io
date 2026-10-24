"use strict";

const MAX_CAMERA_ZOOM = 15;
const UPKEEP_FIXED_SCALE = 1024;

// ============================================================
function _stableNumberOr(v, fallback = 0) {
    let n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function _compareThingsDeterministic(a, b) {
    if (a === b) return 0;
    if (!a) return 1;
    if (!b) return -1;

    let aid = _stableNumberOr(a.id, -1);
    let bid = _stableNumberOr(b.id, -1);
    if (aid !== bid) return aid - bid;

    let ao = _stableNumberOr(a.owner, -1);
    let bo = _stableNumberOr(b.owner, -1);
    if (ao !== bo) return ao - bo;

    let at = String(a.unitType || a.type || '');
    let bt = String(b.unitType || b.type || '');
    if (at !== bt) return at < bt ? -1 : 1;

    let agx = _stableNumberOr(a.gx, Math.floor(_stableNumberOr(a.x, 0) / TILE));
    let bgx = _stableNumberOr(b.gx, Math.floor(_stableNumberOr(b.x, 0) / TILE));
    if (agx !== bgx) return agx - bgx;

    let agy = _stableNumberOr(a.gy, Math.floor(_stableNumberOr(a.y, 0) / TILE));
    let bgy = _stableNumberOr(b.gy, Math.floor(_stableNumberOr(b.y, 0) / TILE));
    if (agy !== bgy) return agy - bgy;

    return 0;
}

// The sorted order of a list (_compareThingsDeterministic), kept per list
// slot. A thing's sort keys (id, owner, type, tile) never change in place
// (a snapshot decode, which can, drops these caches), so the cache stands
// while the list holds the same objects in the same order (references
// compared); a list with things only removed keeps the order of the rest;
// otherwise it is sorted again on numeric keys (types ranked as strings),
// ties kept in list order as the stable comparator sort keeps them.
const _deterministicSortCaches = new Map();
function deterministicSortCachesReset() { _deterministicSortCaches.clear(); }

// (ver: the list's membership version when it has one, towersVersion and
// the like: unchanged, the same list, nothing to compare.)
let _detSortStamp = 0;
function _sortedForDeterministicOrder(slot, list, ver = null) {
    let cache = _deterministicSortCaches.get(slot);
    let n = list.length;
    if (cache && ver !== null && cache.ver === ver && cache.list === list && cache.input.length === n) return cache.sorted;
    if (cache) {
        let input = cache.input, m = input.length;
        if (m === n) {
            let same = true;
            for (let i = 0; i < n; i++) if (list[i] !== input[i]) { same = false; break; }
            if (same) { cache.ver = ver; cache.list = list; return cache.sorted; }
        } else if (n < m) {
            // Only removals (the rest in the same order): the order of the rest.
            let j = 0;
            for (let i = 0; i < m && j < n; i++) if (input[i] === list[j]) j++;
            if (j === n) {
                // (The rest marked with a stamp: no set of every thing.)
                const st = ++_detSortStamp;
                let keepNull = false;
                for (let i = 0; i < n; i++) { const e = list[i]; if (e) e._detSortStamp = st; else keepNull = true; }
                let sorted = cache.sorted.filter(e => e ? e._detSortStamp === st : keepNull);
                _deterministicSortCaches.set(slot, { input: list.slice(), sorted, ver, list });
                return sorted;
            }
        }
    }
    let sorted = _deterministicSortFresh(list);
    _deterministicSortCaches.set(slot, { input: list.slice(), sorted, ver, list });
    return sorted;
}
// list.slice().sort(_compareThingsDeterministic), on numeric keys.
function _deterministicSortFresh(list) {
    let n = list.length;
    let kId = new Float64Array(n), kOwner = new Float64Array(n), kType = new Int32Array(n), kGx = new Float64Array(n), kGy = new Float64Array(n);
    let types = new Map(), idx = [], nulls = [];
    for (let i = 0; i < n; i++) {
        let a = list[i];
        if (!a) { nulls.push(a); continue; }
        idx.push(i);
        kId[i] = _stableNumberOr(a.id, -1);
        kOwner[i] = _stableNumberOr(a.owner, -1);
        let t = String(a.unitType || a.type || '');
        let r = types.get(t);
        if (r === undefined) types.set(t, r = types.size);
        kType[i] = r;
        kGx[i] = _stableNumberOr(a.gx, Math.floor(_stableNumberOr(a.x, 0) / TILE));
        kGy[i] = _stableNumberOr(a.gy, Math.floor(_stableNumberOr(a.y, 0) / TILE));
    }
    // Type strings in code unit order (as `<` compares them).
    let names = [...types.keys()].sort(), rankOf = new Int32Array(types.size);
    for (let k = 0; k < names.length; k++) rankOf[types.get(names[k])] = k;
    for (let i = 0; i < n; i++) kType[i] = rankOf[kType[i]] || 0;
    idx.sort((i, j) => (kId[i] - kId[j]) || (kOwner[i] - kOwner[j]) || (kType[i] - kType[j]) || (kGx[i] - kGx[j]) || (kGy[i] - kGy[j]) || (i - j));
    let sorted = new Array(n);
    for (let k = 0; k < idx.length; k++) sorted[k] = list[idx[k]];
    for (let k = 0; k < nulls.length; k++) sorted[idx.length + k] = nulls[k];
    return sorted;
}

// Units update in a fresh deterministic order each tick, so no unit is
// always first (A* budget contention, who strikes first). The order keeps
// memory locality: the id order is cut into blocks of UNIT_UPDATE_ORDER_BLOCK
// units (allocated, and so stored, close together), the blocks are shuffled,
// and each block is walked from a random start in a random direction. Units
// in different blocks come in either order with even odds, and so do two
// units of one block (a random rotation, averaged over both directions). A
// full per-unit shuffle made every update a cache miss: at 10k units the
// tick ran ~20% slower. Buildings use the same scheme.
const UNIT_UPDATE_ORDER_BLOCK = 64;
let _updateOrderBlocks = new Int32Array(0);
// (out: an array to fill, reused tick after tick.)
function _blockLocalShuffledOrder(sorted, seed, out = null) {
    let n = sorted.length;
    if (n <= 1) { if (!out) return sorted.slice(); out.length = n; if (n) out[0] = sorted[0]; return out; }
    let B = UNIT_UPDATE_ORDER_BLOCK, nb = Math.ceil(n / B);
    if (_updateOrderBlocks.length < nb) _updateOrderBlocks = new Int32Array(Math.max(nb, _updateOrderBlocks.length * 2));
    let blocks = _updateOrderBlocks;
    for (let b = 0; b < nb; b++) blocks[b] = b;
    let s = seed >>> 0;
    for (let i = nb - 1; i > 0; i--) {
        s = ((s * 1664525) + 1013904223) >>> 0;
        let j = s % (i + 1);
        let tmp = blocks[i]; blocks[i] = blocks[j]; blocks[j] = tmp;
    }
    let order = out || new Array(n), k = 0;
    if (out) out.length = n;
    for (let bi = 0; bi < nb; bi++) {
        let b0 = blocks[bi] * B, len = Math.min(B, n - b0);
        s = ((s * 1664525) + 1013904223) >>> 0;
        let start = (s >>> 8) % len, backward = s & 1;
        if (backward) for (let q = 0; q < len; q++) order[k++] = sorted[b0 + (start - q + len) % len];
        else for (let q = 0; q < len; q++) order[k++] = sorted[b0 + (start + q) % len];
    }
    return order;
}

function _buildDeterministicUnitUpdateOrderForTick() {
    return _blockLocalShuffledOrder(units, ((gameTime + 1) * 1664525) + ((units.length + 1) * 1013904223));
}

// The same order as _buildDeterministicUnitUpdateOrderForTick, visited in
// place (no per-tick array of every unit).
// Slot of each unit in `units`, by index, kept in step where the array
// changes (pushes, the dead-unit compaction) and rebuilt when it is not:
// the update pass skips units the movement kernel already moved without
// reading their objects. A stale entry only costs a read (Unit.update
// checks its own slot too).
// (ver: counts every change of the list it follows, for the prebuilt
// unit index's check.)
const _unitSlotMap = { ref: null, len: -1, slots: new Int32Array(0), ver: 0 };
function _unitSlotMapEnsure() {
    const M = _unitSlotMap, n = units.length;
    if (M.ref === units && M.len === n) return M.slots;
    // (Shared: the index kernels read it.)
    // (In the wasm heap: Rust kernels read it.)
    if (M.slots.length < n) { const old = M.slots; M.slots = simHeapArray(Int32Array, simReserveCap(n)); if (old.length) simHeapFree(old); }
    for (let i = 0; i < n; i++) { const u = units[i]; M.slots[i] = u && u._us ? u._si : -1; }
    M.ref = units; M.len = n; M.ver++;
    return M.slots;
}
// After units.push(u).
function unitSlotMapPushed(u) {
    if (typeof unitByIdAdded === 'function') unitByIdAdded(u);
    const M = _unitSlotMap;
    if (M.ref !== units || M.len !== units.length - 1) return;
    if (M.slots.length < units.length) { const a = simHeapArray(Int32Array, simReserveCap(units.length)); a.set(M.slots); if (M.slots.length) simHeapFree(M.slots); M.slots = a; }
    M.slots[M.len++] = u && u._us ? u._si : -1;
    M.ver++;
}
function unitSlotMapInvalidate() { _unitSlotMap.ref = null; _unitSlotMap.ver++; }

// Buildings: the same order scheme, seeded per building type.
const _buildingOrderOut = new Map();
function _buildDeterministicBuildingUpdateOrderForTick(buildings, seedOffset = 0) {
    const ver = buildings === towers ? towersVersion : buildings === barracks ? barracksVersion : buildings === collectorSpawners ? collectorSpawnersVersion : null;
    let out = _buildingOrderOut.get(seedOffset);
    if (!out) _buildingOrderOut.set(seedOffset, out = []);
    return _blockLocalShuffledOrder(_sortedForDeterministicOrder(seedOffset, buildings, ver),
        ((gameTime + 2 + seedOffset) * 1664525) + ((buildings.length + 1) * 1013904223), out);
}


function _createEmptyUpKeepBreakdown() {
    return {
        total: 0,
        units: 0,
        buildings: 0,
        turrets: 0,
        unitTypes: Object.create(null),
        buildingTypes: Object.create(null),
        _totalFixed: 0,
        _unitsFixed: 0,
        _buildingsFixed: 0,
        _turretsFixed: 0,
        _unitTypesFixed: Object.create(null),
        _buildingTypesFixed: Object.create(null),
    };
}

function _fixedToUpKeep(value) {
    return (Math.floor(Number(value) || 0)) / UPKEEP_FIXED_SCALE;
}

function _addUpKeepFixed(row, fixedAmount, bucket) {
    if (!row || !(fixedAmount > 0)) return;
    if (!bucket) {
        row._totalFixed = (Math.floor(Number(row._totalFixed) || 0) + fixedAmount);
        row.total = _fixedToUpKeep(row._totalFixed);
        return;
    }

    if (bucket === 'units') {
        row._unitsFixed = (Math.floor(Number(row._unitsFixed) || 0) + fixedAmount);
        row.units = _fixedToUpKeep(row._unitsFixed);
        return;
    }
    if (bucket === 'buildings') {
        row._buildingsFixed = (Math.floor(Number(row._buildingsFixed) || 0) + fixedAmount);
        row.buildings = _fixedToUpKeep(row._buildingsFixed);
        return;
    }
    if (bucket === 'turrets') {
        row._turretsFixed = (Math.floor(Number(row._turretsFixed) || 0) + fixedAmount);
        row.turrets = _fixedToUpKeep(row._turretsFixed);
    }
}

function _addUpKeepTypeFixed(typeMap, fixedMap, key, fixedAmount) {
    if (!typeMap || !fixedMap || !key || !(fixedAmount > 0)) return;
    let nextFixed = (Math.floor(Number(fixedMap[key]) || 0) + fixedAmount);
    fixedMap[key] = nextFixed;
    typeMap[key] = _fixedToUpKeep(nextFixed);
}

let _upKeepRateByPlayer = [];

// The second's upkeep, worked out on its last tick from running counts:
// units and buildings are kept in bins (by owner, type and level: a few
// hundred in all), each moved between bins in O(1) where its upkeep may
// change; the second multiplies each bin's count by its price (cached until
// research changes the stats). Upkeep follows a unit's level as of its
// last stats refresh (upkeepUnitRefresh), a building's as of its last
// placement, construction or upgrade. The bins are made anew on every peer
// after a resync (upkeepReset), so they agree everywhere.
function _upKeepSecond() {
    const np = players.length, rows = Array.from({ length: np }, () => _createEmptyUpKeepBreakdown());
    if (_upkPriceVer !== _precomputedStatsVersion) { _upkPriceVer = _precomputedStatsVersion; _upkUPrice = []; _upkBPrice = []; }
    const U = typeof _simUnitState !== 'undefined' && _simUnitState && typeof SIM_KERNEL_UPKEEP === 'number' ? _upkUnitsStep(np) : null;
    if (U) {
        const L1 = U.L1, cnt = U.cnt;
        for (let b = 1, e = Math.min(cnt.length, U.NT * np * L1); b < e; b++) {
            const c = cnt[b];
            if (!c) continue;
            const l = b % L1, q = (b - l) / L1, o = q % np, t = (q - o) / np, type = _simUnitTypeNames[t];
            let f = _upkUPrice[b];
            if (f === undefined) {
                let upKeep = Number(getUnitStatForOwner(o, type, l, 'upKeep'));
                let perSecond = Number.isFinite(upKeep) ? Math.max(0, upKeep) : Math.max(0, Number((BASE_UNIT_STATS[type] || BASE_UNIT_STATS.norm || {}).upKeep) || 1);
                f = _upkUPrice[b] = Math.max(0, Math.floor(Number(perSecond * UPKEEP_FIXED_SCALE) || 0));
            }
            if (!(f > 0)) continue;
            f *= c;
            const row = rows[o];
            _addUpKeepFixed(row, f, null); _addUpKeepFixed(row, f, 'units');
            _addUpKeepTypeFixed(row.unitTypes, row._unitTypesFixed, String(type || 'other'), f);
        }
    } else {
        for (const u of units) if (u && !u.dead) _accumulateUpKeepForThing(rows, u, true);
    }
    // Buildings: their bins (owner, type, level), each priced once.
    const B = _upkBuildingsStep();
    for (let b = 0; b < B.n; b++) {
        const c = B.cnt[b];
        if (!c) continue;
        const owner = B.owner[b], statsType = B.stats[b], type = B.type[b], lvl = B.lvl[b];
        if (owner >= np) continue;
        let p = _upkBPrice[b];
        if (p === undefined) {
            let upKeep = Number(getBuildingStatForOwner(owner, statsType, lvl, 'upKeep')), perSecond;
            if (Number.isFinite(upKeep)) perSecond = Math.max(0, upKeep);
            else { let def = BASE_CARD_TYPES[statsType] || {}, base = Number(def.upKeep); perSecond = Number.isFinite(base) ? Math.max(0, base) : (def.target === 'wall' ? 3 : 1); }
            let isTurret = B.tower[b] === 1;
            if (!isTurret && type) { let def = BASE_CARD_TYPES[statsType] || BASE_CARD_TYPES[type] || {}; isTurret = def.target === 'wall'; }
            p = _upkBPrice[b] = { f: Math.max(0, Math.floor(Number(perSecond * UPKEEP_FIXED_SCALE) || 0)), tur: isTurret };
        }
        if (!(p.f > 0)) continue;
        const f = p.f * c, row = rows[owner];
        _addUpKeepFixed(row, f, null); _addUpKeepFixed(row, f, 'buildings');
        _addUpKeepTypeFixed(row.buildingTypes, row._buildingTypesFixed, String(statsType || type || 'unknown'), f);
        if (p.tur) _addUpKeepFixed(row, f, 'turrets');
    }
    return rows;
}
// (Prices per bin, until the stats change.)
let _upkPriceVer = -1, _upkUPrice = [], _upkBPrice = [];
// The units' bins: per slot its bin (unit.upB), per bin how many (upk.h).
let _upkU = null, _upkHist = null;
function _upkUnitBin(U, c, s) {
    const ow = c.owner[s], t = c.upT[s];
    if (!(ow >= 0 && ow < U.np) || t < 0) return -1;
    // (getUnitEffectiveLevel, as SIM_KERNEL_UPKEEP.)
    let l = c.effectiveLevel[s];
    if (!(l - l === 0)) {
        l = c.unitLevel[s];
        if (!(l - l === 0)) {
            l = c.baseLevel[s];
            if (!(l - l === 0)) {
                const sc = c.stackCount[s];
                if (sc - sc === 0) { let v = Math.floor(Math.max(1, sc || 1)), k = 0; while (v >= 2) { v = Math.floor(v / 2); k++; } l = k + 1; }
                else l = 1;
            }
        }
    }
    const b = (t * U.np + Math.floor(ow)) * U.L1 + Math.max(1, Math.max(0, Math.min(U.L1 - 1, Math.floor(l))));
    if (b >= U.cnt.length) { const a = simSharedArray(Int32Array, Math.max(b + 1, U.cnt.length * 2)); a.set(U.cnt); U.cnt = _upkHist = a; simParallelBind('upk.h', a); }
    return b;
}
// Where a unit's stats are applied (simUnitMaxE): its bin again.
function upkeepUnitRefresh(u) {
    const U = _upkU, c = u && u._us;
    if (!U || !c || c !== _simUnitState.columns) return;
    const s = u._si, b = _upkUnitBin(U, c, s), o = c.upB[s];
    if (b === o) return;
    if (o >= 0) U.cnt[o]--;
    if (b >= 0) U.cnt[b]++;
    c.upB[s] = b;
}
// A unit removed (gameTick's removals): out of its bin.
function upkeepUnitGone(u) {
    const U = _upkU, c = u && u._us;
    if (!U || !c || c !== _simUnitState.columns) return;
    const o = c.upB[u._si];
    if (o >= 0) U.cnt[o]--;
    c.upB[u._si] = -1;
}
function _upkUnitsStep(np) {
    let U = _upkU;
    if (U && U.np === np && U.L1 === MAX_THING_LEVEL + 1 && U.cols === _simUnitState.columns) { U.NT = _simUnitTypeNames.length; return U; }
    // Made anew: every unit in its bin (SIM_KERNEL_UPKEEP on the helpers).
    const n = units.length, NT = Math.max(1, _simUnitTypeNames.length), L1 = MAX_THING_LEVEL + 1, nh = NT * np * L1;
    if (!_upkHist || _upkHist.length < nh) { _upkHist = simSharedArray(Int32Array, Math.max(4096, nh * 2)); simParallelBind('upk.h', _upkHist); }
    _upkHist.fill(0);
    U = _upkU = { np, L1, NT, cnt: _upkHist, cols: _simUnitState.columns };
    if (n > 0) {
        const slots = _unitSlotMapEnsure(), P = _simParams;
        simParallelBind('ix.slots', slots);
        P[0] = n; P[1] = 8192; P[2] = np; P[3] = NT; P[4] = MAX_THING_LEVEL;
        simParallelRun(SIM_KERNEL_UPKEEP, Math.ceil(n / 8192));
    }
    return U;
}

// The buildings' upkeep bins: a building counts (owned, alive, built) in
// one bin, by owner, stats type, type, base level and whether it is a
// tower; per tile the bin of the building anchored there (-1 none), per bin
// how many. A building moves bins only when it is placed or removed (the
// tile journal), built or its level changes (upkeepThingDirty); research
// changes the bins' prices, which the second works out. Made anew on every
// peer after a resync (upkeepReset; the next second makes it).
let _upkB = null;
function upkeepReset() { _upkB = null; _upkU = null; _upkPriceVer = -1; }
function upkeepThingDirty(e) {
    if (_upkB && e && e.gx >= 0 && e.gy >= 0 && e.gx < _upkB.w && e.gy < _upkB.h) _upkB.dirty.push(e.gy * _upkB.w + e.gx);
}
function _upkBinOf(B, e) {
    const owner = Number.isFinite(Number(e.owner)) ? Math.floor(Number(e.owner)) : -1;
    if (owner < 0 || !(Number(e.energy) > 0) || e.underConstruction) return -1;
    const statsType = getEntityStatsCalcType(e);
    if (!statsType) return -1;
    const lvl = Math.max(1, getThingBaseLevel(e)), tower = e instanceof Tower ? 1 : 0, type = e.type || '';
    const key = owner + ':' + lvl + ':' + tower + ':' + statsType + ':' + type;
    let b = B.ids.get(key);
    if (b === undefined) {
        b = B.n++; B.ids.set(key, b);
        B.owner.push(owner); B.stats.push(statsType); B.type.push(type); B.lvl.push(lvl); B.tower.push(tower); B.cnt.push(0);
    }
    return b;
}
function _upkTile(B, t) {
    const e = _ownedStructureAtTile(t), b = e ? _upkBinOf(B, e) : -1, o = B.bin[t];
    if (b === o) return;
    if (o >= 0) B.cnt[o]--;
    if (b >= 0) B.cnt[b]++;
    B.bin[t] = b;
}
function _upkBuildingsStep() {
    let B = _upkB;
    const changes = B && B.w === GRID_W && B.h === GRID_H && B.set === _activeTileEntities ? tileEntityChangesSince(B.cursor) : null;
    if (changes === null) {
        B = _upkB = { w: GRID_W, h: GRID_H, set: _activeTileEntities, cursor: { epoch: -1, pos: 0 }, bin: new Int32Array(GRID_W * GRID_H).fill(-1), dirty: [],
            ids: new Map(), n: 0, owner: [], stats: [], type: [], lvl: [], tower: [], cnt: [] };
        tileEntityChangesSince(B.cursor);
        for (const e of _activeTileEntities) if (e && e.gx >= 0 && e.gy >= 0 && e.gx < GRID_W && e.gy < GRID_H) _upkTile(B, e.gy * GRID_W + e.gx);
        return B;
    }
    for (let i = 0; i < changes.length; i++) _upkTile(B, changes[i]);
    if (B.dirty.length) { const d = B.dirty; B.dirty = []; for (let i = 0; i < d.length; i++) _upkTile(B, d[i]); }
    return B;
}

function _ensureUpKeepRateCacheSize() {
    let targetLen = Array.isArray(players) ? players.length : 0;
    while (_upKeepRateByPlayer.length < targetLen) _upKeepRateByPlayer.push(_createEmptyUpKeepBreakdown());
    if (_upKeepRateByPlayer.length > targetLen) _upKeepRateByPlayer.length = targetLen;
}

function _getPlayerUpKeepBreakdown(owner) {
    let pid = Math.max(0, Math.floor(Number(owner) || 0));
    let b = _upKeepRateByPlayer[pid];
    if (!b) return _createEmptyUpKeepBreakdown();
    return {
        total: Number(b.total) || 0,
        units: Number(b.units) || 0,
        buildings: Number(b.buildings) || 0,
        turrets: Number(b.turrets) || 0,
        unitTypes: { ...(b.unitTypes || {}) },
        buildingTypes: { ...(b.buildingTypes || {}) },
    };
}

function _getThingUpKeepPerSecond(thing) {
    if (!thing) return 0;
    let owner = Number.isFinite(Number(thing.owner)) ? Math.floor(Number(thing.owner)) : -1;
    if (owner < 0 || owner >= players.length) return 0;

    // No upKeep for dead/disabled/under-construction things.
    if (!(Number(thing.energy) > 0)) return 0;
    if (thing.underConstruction) return 0;

    if (thing.unitType) {
        let lvl = Math.max(1, getUnitEffectiveLevel(thing));
        let upKeep = Number(getUnitStatForOwner(owner, thing.unitType, lvl, 'upKeep'));
        if (Number.isFinite(upKeep)) return Math.max(0, upKeep);
        let uDef = BASE_UNIT_STATS[thing.unitType] || BASE_UNIT_STATS.norm || {};
        return Math.max(0, Number(uDef.upKeep) || 1);
    }

    let statsType = typeof getEntityStatsCalcType === 'function' ? getEntityStatsCalcType(thing) : (thing.type || '');
    if (!statsType) return 0;
    let lvl = Math.max(1, getThingBaseLevel(thing));
    let upKeep = Number(getBuildingStatForOwner(owner, statsType, lvl, 'upKeep'));
    if (Number.isFinite(upKeep)) return Math.max(0, upKeep);

    let def = BASE_CARD_TYPES[statsType] || {};
    let baseUpKeep = Number(def.upKeep);
    if (Number.isFinite(baseUpKeep)) return Math.max(0, baseUpKeep);
    return def.target === 'wall' ? 3 : 1;
}

function _accumulateUpKeepForThing(breakdowns, thing, isUnit) {
    if (!thing || !breakdowns) return;
    let owner = Number.isFinite(Number(thing.owner)) ? Math.floor(Number(thing.owner)) : -1;
    if (owner < 0 || owner >= breakdowns.length) return;
    let perSecond = _getThingUpKeepPerSecond(thing);
    if (!(perSecond > 0)) return;
    let perSecondFixed = Math.max(0, Math.floor(Number(perSecond * UPKEEP_FIXED_SCALE) || 0));
    if (!(perSecondFixed > 0)) return;

    let row = breakdowns[owner];
    _addUpKeepFixed(row, perSecondFixed, null);
    if (isUnit) {
        _addUpKeepFixed(row, perSecondFixed, 'units');
        let unitType = String((thing && thing.unitType) || 'other');
        _addUpKeepTypeFixed(row.unitTypes, row._unitTypesFixed, unitType, perSecondFixed);
    } else {
        _addUpKeepFixed(row, perSecondFixed, 'buildings');
        let statsType = typeof getEntityStatsCalcType === 'function' ? getEntityStatsCalcType(thing) : (thing.type || 'unknown');
        let buildingType = String(statsType || thing.type || 'unknown');
        _addUpKeepTypeFixed(row.buildingTypes, row._buildingTypesFixed, buildingType, perSecondFixed);
    }

    let type = thing.type || '';
    let isTurret = thing instanceof Tower;
    if (!isTurret && !isUnit && type) {
        let statsType = typeof getEntityStatsCalcType === 'function' ? getEntityStatsCalcType(thing) : type;
        let def = BASE_CARD_TYPES[statsType] || BASE_CARD_TYPES[type] || {};
        isTurret = def.target === 'wall';
    }
    if (isTurret) _addUpKeepFixed(row, perSecondFixed, 'turrets');
}

// ============================================================
// GAME TICK
// ============================================================
// The upkeep breakdown of the second in progress (see gameTick). Dropped
// with the other cross-tick caches at a resync, on every peer.
let _upKeepAccum = null;
// The laser towers the buzzer sound looks at (see _gameTickBody).
let _laserSoundList = null;

const UNIT_RETIRE_BLOCK = 8192;
let _unitRetireList = new Int32Array(0), _unitRetireCounts = new Int32Array(0);
function unitRetirePrepare() {
    const S = _simUnitState, n = units.length, ns = S ? S.owners.length : n;
    const blocks = Math.ceil(Math.max(n, ns) / UNIT_RETIRE_BLOCK);
    if (_unitRetireList.length < n) { _unitRetireList = simSharedArray(Int32Array, simReserveCap(n)); simParallelBind('retire.list', _unitRetireList); }
    if (_unitRetireCounts.length < blocks) { _unitRetireCounts = simSharedArray(Int32Array, Math.max(16, blocks * 2)); simParallelBind('retire.count', _unitRetireCounts); }
    if (S) {
        simParallelBind('ix.slots', _unitSlotMapEnsure());
        const P = _simParams;
        P[0] = n; P[1] = UNIT_RETIRE_BLOCK; P[2] = ns;
        simParallelRun(SIM_KERNEL_UNIT_RETIRE, blocks);
    } else for (let b = 0; b < blocks; b++) {
        let count = 0, start = b * UNIT_RETIRE_BLOCK;
        for (let i = start; i < Math.min(n, start + UNIT_RETIRE_BLOCK); i++) if (units[i].dead) _unitRetireList[start + count++] = i;
        _unitRetireCounts[b] = count;
    }
    return blocks;
}
// (True while gameTick runs: work requested mid-tick that can wait for the
// tick's end, such as the adjacency recalculation, waits.)
let _inGameTick = false;
function gameTick() {
    if (gameOver) return;
    _inGameTick = true;
    try { _gameTickBody(); } finally { _inGameTick = false; }
}
// How many ticks one pass over the buildings' and floor items' status guard takes.
const THING_STATUS_GUARD_TICKS = 512;
function _gameTickBody() {
    // (Actions left from earlier ticks, on a tick that brought none; then the
    // next tick's action budget.)
    actionBacklogTick();
    // (The step's base ticks: simDk, set by whoever runs the step.)
    gameTime += simDk;
    // (The wasm heap's clock: freed arrays are reused some ticks later.)
    if (typeof simHeapTick === 'function') simHeapTick();
    // (The unit columns' next size allocated ahead, a share a tick.)
    if (typeof simUnitStatePrepareStep === 'function') simUnitStatePrepareStep();
    // The unit index for this tick's queries and collision pass, from the
    // state as the tick begins (the same on a peer that just restored it).
    spatialIndexRebuild();
    // Queued slices of big orders first (this tick's budget is shared with
    // the orders that came in for it), then a fresh budget for the next.
    runQueuedOrders();
    navTick();
    // (Made ahead of the orders that use them: the first tick, a restore.)
    if (typeof pathRegionsWarm === 'function') pathRegionsWarm();
    if (gameTime >= 3 && !_actionSanitizeWarm) actionSanitizeWarm();
    // The destination fields asked for so far (the orders'), for this tick.
    navFieldsFlush();
    _refillOrderBudget();
    _resetPathfindPerfTick();
    _resetPathBudgetTrackingPerTick();
    _ensureUpKeepRateCacheSize();
    // Upkeep is deducted once per second. The second's breakdown is built
    // over its ticks: each tick adds one TICK_RATE-th of the units and
    // buildings (by their position in the tick's visiting order), so no
    // tick walks them all. Completed on the second's last tick; the info
    // panel shows the latest complete one.
    // (A step of several base ticks: their slices, the second's tick when
    // it is one of them.)
    let upKeepThisTick = simStepPhases(TICK_RATE).includes(0);
    _upKeepAccum = null;

    let floorChanged = false;
    // Buildings and floor items: a TICK_RATE-th of them a tick (by their
    // place in row-major order) count their upkeep and are looked at for
    // statuses (a guard for the hooks); then the statuses of those with
    // something running (thingStatusWake: status effects, damage), in
    // row-major order.
    {
        const cellItems = getCellItemsRowMajor();
        // (A guard for the hooks, which wake an item at once: a 512th of the
        // items a tick. A TICK_RATE-th read seven columns of each of ~200k
        // items a tick at 4M units: ~100 ms.)
        for (const guardSlice of simStepPhases(THING_STATUS_GUARD_TICKS)) for (let i = guardSlice; i < cellItems.length; i += THING_STATUS_GUARD_TICKS) {
            const item = cellItems[i];
            if (grid[item.gy][item.gx].item !== item) continue;
            // (No ensureStatusState: applyStatusEffect and tickStatusEffects
            // make the fields; ten reads of 10k items a tick at 200k.)
            if (thingStatusPending(item)) thingStatusWake(item);
        }
        for (const item of thingStatusDue()) {
            let cell = grid[item.gy][item.gx];
            if (cell.item !== item) { thingStatusDone(item); continue; }
            if (tickStatusEffects(item)) {
                clearTileEntity(item.gx, item.gy, item);
                cell.item = null;
                cell.owner = -1;
                floorChanged = true;
                thingStatusDone(item);
            } else if (!thingStatusPending(item)) thingStatusDone(item);
        }
    }
    if (floorChanged) {
        _minimapStaticDirty = true;
        _requestStaticCacheCommit();
        recalculateAdjacency();
    }

    recomputePlayerPopCaps();
    healerCandidatesStep();

    // Previous positions for interpolation: units set theirs in update().
    for (let p of projectiles) { p.prevX = p.x; p.prevY = p.y; }

    // Units waiting for their way (a pending target: the helpers' answer of
    // the closest tile they can reach, or a look again), in id order, by
    // source priority: O(1) each (_tryUpgradeAstarFallbackPath). Only the
    // units due this tick are visited; those still waiting afterwards are
    // scheduled again.
    if (_pendingPathDue.size > 0) {
        let waiting = takeDuePendingPathUnits(gameTime);
        let pendingBuckets = [[], [], [], [], []];
        for (let u of waiting) {
            let src = u._pendingPathTarget && u._pendingPathTarget.src;
            let srcTier = Math.max(0, Math.min(4, _pendingPathPriority(src)));
            pendingBuckets[srcTier].push(u);
        }

        for (let srcTier = 0; srcTier <= 4; srcTier++) {
            for (let u of pendingBuckets[srcTier]) if (u && !u.dead && u._pendingPathTarget) _tryUpgradeAstarFallbackPath(u);
        }
        for (let u of waiting) {
            if (u.dead || !u._pendingPathTarget) _pendingPathUnits.delete(u);
            else schedulePendingPathUnit(u, _pendingPathDueTick(u, gameTime));
        }
    }

    flushPendingMovementAstarSpend();
    flushPendingResourceStatRebuilds();
    recalculateUnitEffectiveLevel();

    // Every player's gameplay visibility for this tick, from positions at
    // this point. Computing it here, rather than at whichever query happens
    // to come first, keeps targeting independent of query order and lets
    // scans be skipped freely.
    updateAllPlayerVisibility();

    // Laser beams (the beam map, a helper kernel for the units on them).
    laserBeamsTick();

    // Towers: those due act (towersTick: cooldowns end at known ticks), in
    // tile order; statuses and removals.
    towersTick();

    // Projectiles
    // (Last to first, as ever; spent shots removed in one pass after, the
    // rest keeping their order.)
    projectilesBegin();
    try {
        let n0 = projectiles.length, spent = null;
        for (let i = n0 - 1; i >= 0; i--) { if (!projectiles[i].update()) (spent || (spent = new Uint8Array(n0)))[i] = 1; }
        if (spent) {
            let w = 0;
            for (let i = 0; i < projectiles.length; i++) if (i >= n0 || !spent[i]) projectiles[w++] = projectiles[i];
            projectiles.length = w;
        }
    } finally { projectilesEnd(); }

    // Units: the movement kernel (simMoveRun: every unit's order, its
    // movement and its attacks, the combat brain's instructions) and what it
    // leaves to this thread, in O(events) (unitEventsRun: workers' AI, mines,
    // ways that are not there). No unit is visited one by one here.
    visCoverHoldBegin();
    statusPrepassRun();
    // The separation's contacts, from where units stand now, run on the
    // helpers during the pass (committed by runUnitSeparationPass).
    separationStart();
    // Workers' searches: posted and committed by the search tier.
    if (typeof workerSearchTierStep === 'function') workerSearchTierStep();
    // (From here to the events' end other units are seen where they were at
    // the start: _unitTickX.)
    unitPassBegin();
    try {
        simMoveRun();
        // (What the kernels left to this thread: unit.js unitEventsRun.)
        unitEventsRun();
    } finally { unitPassEnd(); }
    unitHitsResolve();
    visCoverHoldEnd();
    const retireBlocks = unitRetirePrepare();

    // Dead units are processed in the same order as ever and removed in one
    // pass afterwards: a splice per death shifted the whole list each time,
    // which in big fights (hundreds of deaths a tick) cost most of the tick.
    // Dead units are found in the dead column (through the slot map, no
    // object reads) and marked by index; the compaction moves references.
    const removedIndices = [], removedUnits = [], removedSet = selectedUnits.length ? new Set() : null;
    const DS = _simUnitState, dslots = DS ? _unitSlotMapEnsure() : null, DEAD = DS ? DS.columns.dead : null, downers = DS ? DS.owners : null;
    let compactRemovedUnits = () => {
        if (!removedIndices.length) return;
        const M = _unitSlotMap, keep = M.ref === units && M.len === units.length, ms = M.slots;
        // Swap-remove, highest index first (the order they were recorded
        // in): the list's last unit takes each removed one's place, O(1) a
        // removal (the same order on every peer; copying the list's tail
        // down behind every removal was ~5 ms a tick of a battle at 800k).
        let n = units.length;
        for (let k = 0; k < removedIndices.length; k++) {
            const i = removedIndices[k];
            n--;
            if (i !== n) { units[i] = units[n]; if (keep) ms[i] = ms[n]; }
        }
        units.length = n;
        if (keep) { M.len = n; M.ver++; }
        if (removedSet) selectedUnits = selectedUnits.filter(su => !removedSet.has(su));
        for (let k = 0; k < removedIndices.length; k++) unitByIdRemoved(removedUnits[k]);
    };
    for (let b = retireBlocks - 1; b >= 0; b--) for (let j = _unitRetireCounts[b] - 1; j >= 0; j--) {
        const i = _unitRetireList[b * UNIT_RETIRE_BLOCK + j];
        let u = units[i];
        const si = dslots ? dslots[i] : -1;
        if (si >= 0 && downers[si] === u ? DEAD[si] === 0 : !u.dead) continue;
        upkeepUnitGone(u);
        if (u._removedNow) {
            // Removed by removeUnitNow (spatial and population already done).
            removedIndices.push(i); removedUnits.push(u); if (removedSet) removedSet.add(u);
        } else {
            if (!u.isKing && !u.workerState) playSound('unit_death', u.x, u.y, u.unitType);
            // Release worker lock on target
            _clearWorkerTarget(u);
            if (u.workerTarget && u.workerTarget.lockedBy === u) {
                u.workerTarget.lockedBy = null;
            }
            if (u.isKing) checkWinCondition();
            removeUnitSpatial(u);
            players[u.owner].popCount--;
            removedIndices.push(i); removedUnits.push(u); if (removedSet) removedSet.add(u);
            if (gameOver) { compactRemovedUnits(); return; }
        }
    }
    compactRemovedUnits();
    simUnitStateCollect();
    runUnitSeparationPass();

    // Barracks and spawners: no tick of their own (production moves on
    // with payments and queue changes, construction with builders): their
    // statuses, removals and the players' research (spawnerStructuresTick).
    spawnerStructuresTick();
    // (Buildings behind their owner's research: a TICK_RATE-th a tick.)

    processGlobalSpawnerQueue();

    // Dropped items decay
    for (let i = droppedItems.length - 1; i >= 0; i--) {
        droppedItems[i].timer -= simDk;
        if (droppedItems[i].timer <= 0) {
            removeDroppedItem(droppedItems[i]);
        }
    }

    // Particles
    for (let i = particles.length - 1; i >= 0; i--) { if (!particles[i].update()) particles.splice(i, 1); }

    // Laser buzzer sound control (presentation): the active laser nearest
    // the camera, from the laser towers (listed again every TICK_RATE ticks).
    if (!_laserSoundList || simStepCrosses(0, TICK_RATE)) _laserSoundList = towers.filter(t => t.type === 'laser');
    {
        let anyLaserActive = false, laserSoundX = 0, laserSoundY = 0, bestLaserDist2 = Infinity;
        const cameraCx = camera.x + viewW / camera.zoom / 2, cameraCy = camera.y + viewH / camera.zoom / 2;
        for (const t of _laserSoundList) {
            if (t.laserState !== 1 || t.underConstruction || t.dead) continue;
            anyLaserActive = true;
            const dx = t.x - cameraCx, dy = t.y - cameraCy, dist2 = dx * dx + dy * dy;
            if (dist2 < bestLaserDist2) { bestLaserDist2 = dist2; laserSoundX = t.x; laserSoundY = t.y; }
        }
        if (anyLaserActive) startLaserSound(laserSoundX, laserSoundY);
        else stopLaserSound();
    }

    // (Adjacency is not lag-sensitive: its dirty tiles are taken in batches
    // every ADJACENCY_BATCH_TICKS ticks (fixed ticks, every peer): a group
    // dirtied again and again is flooded once per batch.)
    if (ADJACENCY_LANE) adjacencyLaneStep();
    if (_winCheckDue) { _winCheckDue = false; checkWinCondition(); }
    else if (_adjacencyNeedsRecalc && simStepCrosses(-3, ADJACENCY_BATCH_TICKS)) _runAdjacencyRecalculation();

    // Upkeep, once a second: worked out now (_upKeepSecond; the info panel
    // shows it), deducted.
    if (upKeepThisTick) {
        const upKeepBreakdown = _upKeepRateByPlayer = _upKeepSecond();
        for (let pid = 0; pid < upKeepBreakdown.length; pid++) {
            let totalPerSecond = Number(upKeepBreakdown[pid].total) || 0;
            if (!(totalPerSecond > 0)) continue;
            addPlayerResource(pid, 'energy', -totalPerSecond);
        }
    }
    // The tick's damage into the shrines, and their drain (see shrineTick).
    shrineTick();
    // Research pools into the research queues (every RESEARCH_DRAIN_TICKS).
    researchDrainTick();
    flushPendingMovementAstarSpend();
    flushPendingResourceStatRebuilds();
    // Laser links of the structures placed and removed this tick (the state
    // between ticks has them; hashes and snapshots include them).
    ensureLaserConnections();

    // The fog's presentation (light smoothing, fading, the remembered view)
    // is the page's: the simulation worker keeps the raw grid (gameplay
    // reads only raw grids). It walked every tile, and in Team + history
    // snapshotted what was seen, every tick: ~6% of a tick, and most of one
    // with history.
    if (typeof SIM_IN_WORKER !== 'undefined' && SIM_IN_WORKER) visibilityGrid = getRawVisibilityGridForPlayer(localPlayerId);
    else updateVisibility(localPlayerId);
    _finalizePathfindPerfTick(_countPendingPathBacklog());
    // The next tick's unit index, on the helpers while the state hash runs.
    if (typeof spatialIndexPrebuild === 'function') spatialIndexPrebuild();
    // (The units by id, made after a match's first tick or a restore, not at
    // the first big order: a peer-local lookup, kept up to date from then.)
    if (_unitByIdFor !== units) _unitByIdMap();
}

// ============================================================
// INPUT HANDLING
// ============================================================
function screenToWorld(sx, sy) {
    let gameArea = document.getElementById('game-area');
    let rect = gameArea.getBoundingClientRect();
    if (renderDimensionMode === '3d' && renderer3dInstance && typeof renderer3dInstance.screenToGround === 'function') {
        let picked = renderer3dInstance.screenToGround(sx, sy, rect);
        if (picked && Number.isFinite(picked.x) && Number.isFinite(picked.y)) {
            return {
                x: picked.x * TILE,
                y: picked.y * TILE,
            };
        }
    }
    let x = (sx - rect.left) / camera.zoom + camera.x;
    let y = (sy - rect.top) / camera.zoom + camera.y;
    return { x, y };
}

function _isCollectorGatherTargetType(targetType) {
    if (!targetType) return false;
    if (targetType === 'drop') return true;
    for (let cfg of RESOURCE_TYPE_LIST) {
        if (cfg && (targetType === cfg.mineTileType || targetType === cfg.farmKey)) return true;
    }
    return false;
}

function _getResourceCollectorConfigForSpawnerType(spawnerType) {
    let resourceKey = getResourceTypeByCollectorBuilding(spawnerType);
    return resourceKey ? getResourceTypeConfig(resourceKey) : null;
}

function _getGatherTargetNearForCollectorWorkerType(workerType, worldX, worldY, owner, radius = 22) {
    let cfg = getResourceCollectorConfigByWorkerType(workerType);
    return cfg ? _getResourceCollectorGatherTargetNear(worldX, worldY, owner, cfg, radius) : null;
}

function _getGatherTargetAtForCollectorWorkerType(workerType, gx, gy, owner, preferredType = null) {
    let cfg = getResourceCollectorConfigByWorkerType(workerType);
    return cfg ? _getResourceCollectorGatherTargetAt(gx, gy, owner, cfg, preferredType) : null;
}

function _isValidGatherTargetForCollectorWorkerType(workerType, target, targetType, owner) {
    let cfg = getResourceCollectorConfigByWorkerType(workerType);
    return !!(cfg && _isResourceCollectorTargetValid(target, targetType, owner, cfg));
}

function initInput() {
    let gameArea = document.getElementById('game-area');
    let multiRallyPoints = [];
    let multiUnitCommandPoints = [];
    let multiTowerTargetPoints = [];
    let multiBuilderAssignTargets = [];
    let multiCollectorAssignTargets = [];
    let multiHealerAssignTargets = [];
    let multiResearcherAssignTargets = [];

    function isCtrlMultiCommand(evt) {
        if (!evt) return false;
        // Use only event modifier state here to avoid sticky-key issues when
        // browser context menus swallow keyup events (e.g. Firefox Shift+RMB).
        return !!(evt.shiftKey || evt.ctrlKey || evt.metaKey ||
            (evt.getModifierState && (
                evt.getModifierState('Shift') ||
                evt.getModifierState('Control') ||
                evt.getModifierState('Meta')
            )));
    }

    // Split selected things across ctrl multi-points by proximity: each point
    // an equal share, the nearest pairs first (assign_nearest.js
    // assignNearestXY: by cells of a grid over the things).
    function _assignToNearestPoints(things, points, thingXY, pointXY, fillXY = null) {
        const n = things.length;
        if (points.length <= 1 || n === 0) return new Int32Array(n);
        const xs = new Float32Array(n), ys = new Float32Array(n), has = new Uint8Array(n);
        if (fillXY) fillXY(xs, ys, has);
        else for (let i = 0; i < n; i++) { const a = thingXY(things[i]); if (a) { xs[i] = a.x; ys[i] = a.y; has[i] = 1; } }
        return assignNearestXY(xs, ys, has, points.map(pointXY));
    }

    let _entityWorldXY = e => e ? { x: Number.isFinite(e.x) ? e.x : (e.gx * TILE + 16), y: Number.isFinite(e.y) ? e.y : (e.gy * TILE + 16) } : null;

    function applyRallyTargets(selSpawners, targetX, targetY, appendToMultiRally, targetUnitId = null) {
        if (!selSpawners || selSpawners.length === 0) return;
        if (appendToMultiRally && multiRallyPoints.length > 0) {
            multiRallyPoints.push({ x: targetX, y: targetY, targetUnitId });
        } else {
            multiRallyPoints = [{ x: targetX, y: targetY, targetUnitId }];
        }
        if (multiRallyPoints.length === 0) multiRallyPoints = [{ x: targetX, y: targetY, targetUnitId }];
        // (Positions straight into the split's arrays: no object a building.)
        let pick = _assignToNearestPoints(selSpawners, multiRallyPoints, null, p => p, (xs, ys, has) => {
            for (let i = 0; i < selSpawners.length; i++) {
                const e = selSpawners[i];
                if (!e) continue;
                xs[i] = Number.isFinite(e.x) ? e.x : e.gx * TILE + 16; ys[i] = Number.isFinite(e.y) ? e.y : e.gy * TILE + 16; has[i] = 1;
            }
        });
        // One action per point with its buildings' tiles (setRallyMany; at
        // most ACTION_MAX_RALLY_COORDS each): an action per building could
        // not carry thousands of them (a packet holds 256 actions).
        // (One point: all the buildings' pending rally is that one, see
        // renderer.js noteRallyCover; a unit to follow keeps its own keys.)
        const single = multiRallyPoints.length === 1 && !multiRallyPoints[0].targetUnitId && typeof noteRallyCover === 'function';
        if (single) noteRallyCover(selSpawners, multiRallyPoints[0].x, multiRallyPoints[0].y);
        try {
        let byPoint = multiRallyPoints.map(() => []);
        for (let i = 0; i < selSpawners.length; i++) {
            let b = selSpawners[i];
            let rp = multiRallyPoints[pick[i]];
            byPoint[pick[i]].push(b.gx, b.gy);
        }
        for (let j = 0; j < byPoint.length; j++) {
            let rp = multiRallyPoints[j], c = byPoint[j];
            for (let k = 0; k < c.length; k += 2 * ACTION_MAX_RALLY_COORDS) queueAction({ action: 'setRallyMany', coords: c.slice(k, k + 2 * ACTION_MAX_RALLY_COORDS), targetX: rp.x, targetY: rp.y, targetUnitId: rp.targetUnitId || null });
        }
        } finally { if (single) noteRallyCoverDone(); }
    }

    function _findResearchRallyTargetNear(worldX, worldY, owner, radius = 48) {
        let gx = Math.floor(worldX / TILE), gy = Math.floor(worldY / TILE);
        let exact = getTileEntityRef(gx, gy);
        if (_isResearcherTargetBuilding(exact, owner, true)) return exact;
        let best = null;
        let bestDist = Infinity;
        for (let s of collectorSpawners) {
            if (!_isResearcherTargetBuilding(s, owner, true)) continue;
            if (!isTileVisible(s.gx, s.gy)) continue;
            let d = detHypot(s.x - worldX, s.y - worldY);
            if (d > radius || d >= bestDist) continue;
            bestDist = d;
            best = s;
        }
        return best;
    }

    function _findSalvagerRallyTargetNear(worldX, worldY, owner, radius = 22) {
        let best = null;
        let bestDist = Infinity;
        let consider = (item) => {
            if (!item || item.owner !== owner || !item.markedForSalvage) return;
            if (item.energy !== undefined && item.energy <= 0) return;
            if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) return;
            let gx = Math.floor(item.x / TILE), gy = Math.floor(item.y / TILE);
            if (!isTileVisible(gx, gy)) return;
            let d = detHypot(item.x - worldX, item.y - worldY);
            if (d > radius || d >= bestDist) return;
            bestDist = d;
            best = item;
        };

        for (let t of towers) consider(t);
        for (let b of barracks) consider(b);
        for (let s of collectorSpawners) consider(s);
        for (let y = 0; y < GRID_H; y++) {
            for (let x = 0; x < GRID_W; x++) {
                let cell = grid[y][x];
                if (!cell || !cell.item) continue;
                consider(cell.item);
            }
        }
        return best;
    }

    function _resolveSpawnerRallyPointForClick(spawner, worldX, worldY, clickedEnemyUnit = null) {
        if (!spawner) return { x: worldX, y: worldY, targetUnitId: null };

        let clickGx = Math.max(0, Math.min(GRID_W - 1, Math.floor(worldX / TILE)));
        let clickGy = Math.max(0, Math.min(GRID_H - 1, Math.floor(worldY / TILE)));
        if (!isGameplayTargetVisibleToPlayer(localPlayerId, clickGx, clickGy)) {
            return { x: worldX, y: worldY, targetUnitId: null };
        }

        if (clickedEnemyUnit && spawner.type === 'barrack') {
            return { x: clickedEnemyUnit.x, y: clickedEnemyUnit.y, targetUnitId: clickedEnemyUnit.id };
        }

        let anchor = null;
        let resourceCollectorCfg = _getResourceCollectorConfigForSpawnerType(spawner.type);
        if (resourceCollectorCfg) {
            let gather = _getResourceCollectorGatherTargetNear(worldX, worldY, localPlayerId, resourceCollectorCfg, 22);
            if (gather && gather.target) anchor = gather.target;
        } else if (spawner.type === 'builder_spawner') {
            anchor = _getBuilderWorkTargetNear(worldX, worldY, localPlayerId, 22, true);
        } else if (spawner.type === 'healer_spawner') {
            let gx = Math.floor(worldX / TILE), gy = Math.floor(worldY / TILE);
            let exact = getTileEntityRef(gx, gy);
            if (_isHealerQueueAnchorTarget(exact, localPlayerId)) anchor = exact;
            if (!anchor) anchor = _getHealerQueueTargetNear(worldX, worldY, localPlayerId, 48, false);
        } else if (spawner.type === 'research') {
            anchor = _findResearchRallyTargetNear(worldX, worldY, localPlayerId, 48);
        } else if (spawner.type === 'salvager') {
            anchor = _findSalvagerRallyTargetNear(worldX, worldY, localPlayerId, 22);
        }

        if (!anchor) anchor = findOwnRallyAnchorNear(worldX, worldY);
        if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
            return { x: anchor.x, y: anchor.y, targetUnitId: null };
        }
        return { x: worldX, y: worldY, targetUnitId: null };
    }

    const RALLY_CAPABLE_TYPES = new Set(['barrack', 'spawner', 'astar_spawner', 'salvager', 'builder_spawner', 'healer_spawner', 'research']);
    function isRallyCapableEntity(ent) {
        if (!ent || ent.owner !== localPlayerId) return false;
        if (RALLY_CAPABLE_TYPES.has(ent.type)) return true;
        return Number.isFinite(ent.gx) && Number.isFinite(ent.gy) && ('rallyX' in ent) && ('rallyY' in ent);
    }

    // The selected buildings that rally and the own towers among them, found
    // once for a selection: a click is not a pass over thousands of buildings
    // (the rally order and the tower order both asked for it). What a
    // building is, and whose, does not change while it is selected; only the
    // towers' energy is read again.
    let _structSelection = { ents: null, len: -1, off: '', rally: [], towers: [] };
    function activeStructureSelection() {
        const S = _structSelection;
        let off = '';
        for (const key in activeSubGroups) if (activeSubGroups[key] === false) off += key + ';';
        if (!(S.ents === selectedEntities && S.len === selectedEntities.length && S.off === off)) {
            const active = getActiveEntities();
            S.rally = active.filter(isRallyCapableEntity);
            S.allTowers = active.filter(e => e instanceof Tower && e.owner === localPlayerId);
            S.ents = selectedEntities; S.len = selectedEntities.length; S.off = off;
        }
        S.towers = S.allTowers.filter(t => t.energy > 0);
        return S;
    }

    // A right click's marker at once, before the work of finding what it
    // orders (renderer.js noteOrderPing): a rally arrow when buildings that
    // rally are selected, a cross when own units are.
    function noteOrderClickPing(worldX, worldY) {
        if (typeof noteOrderPing !== 'function') return;
        // (The first few of a selection tell what it is: no pass over it
        // before the marker is drawn.)
        let rally = false, own = false;
        for (let i = 0, n = Math.min(selectedEntities.length, 64); i < n && !rally; i++) rally = isRallyCapableEntity(selectedEntities[i]);
        for (let i = 0, n = Math.min(selectedUnits.length, 8); i < n && !own; i++) { const u = selectedUnits[i]; own = !!u && !u.dead && u.owner === localPlayerId; }
        if (rally) noteOrderPing(worldX, worldY, 'arrow', '#9aa');
        if (own) noteOrderPing(worldX, worldY, 'plus', attackMoveMode ? '#f66' : '#4f4');
    }

    // A big selection's order (a pass over its units, buildings and ids: tens
    // of ms) goes after the click's marker has been shown: the click only
    // draws the marker (noteOrderClickPing), the order follows once the frame
    // with it is out (the next animation frame, then a task), still before
    // any other input is handled (flushDeferredOrders, from a capturing
    // listener on every key and press) and always within ~120 ms (a hidden
    // page has no frames). The simulation takes the order a few ticks after
    // the click anyway (the command lead).
    const ORDER_DEFER_MIN = 2000;
    const deferredOrders = [];
    function flushDeferredOrders() {
        while (deferredOrders.length) {
            const run = deferredOrders.shift();
            try { run(); } catch (err) { reportRuntimeError('order', err); }
        }
    }
    function deferOrderWork(run) {
        deferredOrders.push(run);
        if (deferredOrders.length > 1) return;
        requestAnimationFrame(() => setTimeout(flushDeferredOrders, 0));
        setTimeout(flushDeferredOrders, 120);
    }
    // (Not in the test harness: its clicks expect their orders at once.)
    const deferBigOrders = typeof requestAnimationFrame === 'function' && !/harness/.test(navigator.userAgent || '');
    for (const type of ['mousedown', 'pointerdown', 'keydown', 'touchstart']) document.addEventListener(type, flushDeferredOrders, true);

    function findOwnRallyAnchorNear(worldX, worldY) {
        // (Only the tiles a hit can reach: the click's and its neighbours', not
        // every barracks and spawner of the map.)
        let candidates = [];
        let cgx = Math.floor(worldX / TILE), cgy = Math.floor(worldY / TILE);
        for (let gy = cgy - 1; gy <= cgy + 1; gy++) for (let gx = cgx - 1; gx <= cgx + 1; gx++) {
            let b = getTileEntityRef(gx, gy);
            if (!b || !RALLY_CAPABLE_TYPES.has(b.type) || b.owner !== localPlayerId || b.energy <= 0 || b.underConstruction) continue;
            if (!isTileVisible(b.gx, b.gy)) continue;
            candidates.push({ ref: b, x: b.x, y: b.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
        }
        let hit = pickNearestHitCandidate(candidates, worldX, worldY);
        return hit ? hit.ref : null;
    }

    function getUnitClickShape(u) {
        if (!u) return { kind: 'circle', r: 0 };
        let r = Math.max(0, Number(u.r) || 0);
        let vis = u.vis || 'circle';
        if (vis === 'rect') {
            return { kind: 'rect', hw: r, hh: r * 0.7 };
        }
        if (vis === 'mole') {
            return { kind: 'ellipse', rx: r * 0.8, ry: r * 1.1 };
        }
        return { kind: 'circle', r };
    }

    function isPointInsideCandidate(c, dx, dy) {
        if (!c || !c.hitShape) return false;
        let s = c.hitShape;
        if (s.kind === 'rect') {
            let hw = Math.max(0, Number(s.hw) || 0);
            let hh = Math.max(0, Number(s.hh) || 0);
            return Math.abs(dx) <= hw && Math.abs(dy) <= hh;
        }
        if (s.kind === 'ellipse') {
            let rx = Math.max(0.001, Number(s.rx) || 0.001);
            let ry = Math.max(0.001, Number(s.ry) || 0.001);
            let nx = dx / rx, ny = dy / ry;
            return (nx * nx + ny * ny) <= 1;
        }
        let r = Math.max(0, Number(s.r) || 0);
        return (dx * dx + dy * dy) <= (r * r);
    }

    function pick3DHitCandidate(candidates, screenX, screenY) {
        if (!renderer3dInstance || typeof renderer3dInstance.pickRenderedSource !== 'function') return null;
        let bySource = new Map(candidates.map(candidate => [candidate.ref, candidate]));
        let source = renderer3dInstance.pickRenderedSource(screenX, screenY, bySource);
        return bySource.get(source) || null;
    }

    function pickNearestHitCandidate(candidates, worldX, worldY, screenX = NaN, screenY = NaN) {
        if (renderDimensionMode === '3d' && Number.isFinite(screenX) && Number.isFinite(screenY)) {
            return pick3DHitCandidate(candidates, screenX, screenY);
        }
        let bestPointHit = null;
        let bestPointZ = -Infinity;
        let bestPointD2 = Infinity;

        let bestFallback = null;
        let bestFallbackD2 = Infinity;
        for (let c of candidates) {
            if (!c) continue;
            let cx = Number(c.x), cy = Number(c.y), hr = Number(c.hitRadius);
            if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
            let dx = cx - worldX, dy = cy - worldY;
            let d2 = dx * dx + dy * dy;

            // Precise shape hit takes priority, with draw-order style tie-break.
            if (isPointInsideCandidate(c, dx, dy)) {
                let z = Number.isFinite(c.hitZ) ? c.hitZ : 0;
                if (z > bestPointZ || (z === bestPointZ && d2 < bestPointD2)) {
                    bestPointHit = c;
                    bestPointZ = z;
                    bestPointD2 = d2;
                }
            }

            // Fallback: nearest candidate still inside permissive click radius.
            if (Number.isFinite(hr) && hr > 0 && d2 <= hr * hr && d2 < bestFallbackD2) {
                bestFallback = c;
                bestFallbackD2 = d2;
            }
        }
        return bestPointHit || bestFallback;
    }

    // Units within `reach` px of a point (own ones or the others'), from the
    // frame's columns: a click's candidates (every unit's view, twice a
    // click, cost tens of ms at 200k units). Without a frame: every unit.
    const CLICK_UNIT_REACH = TILE * 4;
    // The frame's list positions (k: F.order[k] its slot, units[k] its view)
    // in the render buckets' cells over a world box (presentation_worker.js
    // buildRenderBuckets: cells of 16 tiles, chained by list position),
    // ascending; null without buckets. (A click or a box looks at the cells
    // under it, not at every unit: a pass over millions per input.)
    let _frameCellPos = new Int32Array(1024);
    function _frameListInBox(F, x0, y0, x1, y1) {
        const B = F && F.renderBuckets;
        if (!B || !B.head || !B.next || !(B.columns > 0)) return null;
        const cell = 16 * (B.tile || TILE), cols = B.columns, rows = B.rows, head = B.head, next = B.next;
        // (A cell more around: a frame's drawn positions may have moved off
        // the cell its buckets put them in.)
        const cx0 = Math.max(0, Math.floor(x0 / cell) - 1), cx1 = Math.min(cols - 1, Math.floor(x1 / cell) + 1);
        const cy0 = Math.max(0, Math.floor(y0 / cell) - 1), cy1 = Math.min(rows - 1, Math.floor(y1 / cell) + 1);
        let out = _frameCellPos, m = 0;
        for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
            for (let k = head[cy * cols + cx]; k >= 0; k = next[k]) {
                if (m >= out.length) { const g = new Int32Array(out.length * 2); g.set(out); out = _frameCellPos = g; }
                out[m++] = k;
            }
        }
        const list = out.subarray(0, m);
        list.sort();
        return list;
    }
    function _unitsNearPoint(x, y, reach, own) {
        const F = typeof simClientCurrentUnitVis === 'function' ? simClientCurrentUnitVis() : null;
        if (!F) return units;
        const out = [], ord = F.order, X = F.x, Y = F.y, O = F.owner, n = Math.min(F.count, units.length), me = localPlayerId;
        const near = (k) => {
            const s = ord[k];
            if ((O[s] === me) !== own) return;
            const dx = X[s] - x, dy = Y[s] - y;
            if (dx > reach || dx < -reach || dy > reach || dy < -reach) return;
            out.push(units[k]);
        };
        const cells = _frameListInBox(F, x - reach, y - reach, x + reach, y + reach);
        if (cells) { for (let i = 0; i < cells.length; i++) if (cells[i] < n) near(cells[i]); }
        else for (let k = 0; k < n; k++) near(k);
        return out;
    }
    // This player's live units inside a world box, on tiles it sees: a box
    // selection, from the frame's columns (through every unit's view the
    // release of a box over 300k units took ~150 ms). Without a frame: the
    // units' own fields.
    let _boxUnitSlots = new Int32Array(0), _boxUnitSlotCount = 0, _boxUnitSlotsFor = null;
    function _ownUnitsInBox(sx, sy, ex, ey) {
        const F = typeof simClientCurrentUnitVis === 'function' ? simClientCurrentUnitVis() : null;
        const out = [];
        if (!F) {
            for (let u of units) {
                if (u.owner !== localPlayerId || u.dead) continue;
                if (!isTileVisible(Math.floor(u.x / TILE), Math.floor(u.y / TILE))) continue;
                if (u.x >= sx && u.x <= ex && u.y >= sy && u.y <= ey) out.push(u);
            }
            return out;
        }
        // (Slot by slot: the columns read in memory order, ~3x faster than
        // in the list's order; the selection is then in slot order. Their
        // slots are kept for the selection's index: selectionIndexAdopt.)
        const X = F.x, Y = F.y, O = F.owner, ID = F.id, n = F.n, me = localPlayerId, full = fullVisibility, it = 1 / TILE, views = _pageSlotViews;
        let slots = _boxUnitSlots;
        if (slots.length < n) slots = _boxUnitSlots = new Int32Array(Math.max(1024, Math.ceil(n * 1.25)));
        let c = 0;
        // (The cells under the box when the frame has buckets: their slots,
        // sorted, so the selection is in slot order as from the pass. A box
        // over much of the map: the pass, no gathering and two sorts of
        // millions of entries, ~0.5 s for a whole 4M-unit map.)
        const B = F.renderBuckets, cellPx = B && B.columns > 0 ? 16 * (B.tile || TILE) : 0;
        const boxCells = cellPx ? (Math.floor(ex / cellPx) - Math.floor(sx / cellPx) + 3) * (Math.floor(ey / cellPx) - Math.floor(sy / cellPx) + 3) : 0;
        const cells = cellPx && boxCells * 4 < B.columns * B.rows ? _frameListInBox(F, sx, sy, ex, ey) : null;
        if (cells) {
            const ord = F.order;
            let m = 0;
            for (let i = 0; i < cells.length; i++) { const sl = ord[cells[i]]; if (sl >= 0 && sl < n) cells[m++] = sl; }
            const sl = cells.subarray(0, m);
            sl.sort();
            for (let i = 0; i < m; i++) {
                const s = sl[i];
                if (O[s] !== me || ID[s] < 0) continue;
                const x = X[s], y = Y[s];
                if (x < sx || x > ex || y < sy || y > ey) continue;
                if (!full && !isTileVisible(Math.floor(x * it), Math.floor(y * it))) continue;
                const u = views[s];
                if (u) { out.push(u); slots[c++] = s; }
            }
        } else for (let s = 0; s < n; s++) {
            if (O[s] !== me || ID[s] < 0) continue;
            const x = X[s], y = Y[s];
            if (x < sx || x > ex || y < sy || y > ey) continue;
            if (!full && !isTileVisible(Math.floor(x * it), Math.floor(y * it))) continue;
            // (A slot with an id holds a live unit's view: the view itself
            // is not read.)
            const u = views[s];
            if (u) { out.push(u); slots[c++] = s; }
        }
        _boxUnitSlotCount = c; _boxUnitSlotsFor = out;
        return out;
    }
    const CLICK_STRUCT_REACH_3D = 4, CLICK_STRUCT_REACH_2D = 2;
    // (A structure's kind for picking: a frame view's table kind, else its class.)
    function _clickStructKind(e) {
        if (e._kind !== undefined) return e._kind === 0 ? 'tower' : e._kind === 1 ? 'barrack' : e._kind === 2 ? 'spawner' : null;
        return e instanceof Tower ? 'tower' : e instanceof Barrack ? 'barrack' : isSpawnerEntity(e) ? 'spawner' : null;
    }
    function collectEnemyClickTargetCandidates(worldX, worldY, includeUnits = true) {
        let out = [];
        if (includeUnits) {
            for (let u of _unitsNearPoint(worldX, worldY, CLICK_UNIT_REACH, false)) {
                if (u.owner === localPlayerId || u.dead) continue;
                let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                if (!isGameplayTargetVisibleToPlayer(localPlayerId, ugx, ugy)) continue;
                out.push({
                    kind: 'unit',
                    ref: u,
                    x: u.x,
                    y: u.y,
                    hitShape: getUnitClickShape(u),
                    hitRadius: (Number(u.r) || 0) + 10,
                    hitZ: 30,
                });
            }
        }
        // Structures by their tiles within a few of the click's ground point
        // (a tall one drawn over the point stands at most ~2 tiles behind it
        // at the 3D camera's pitch): every enemy building of the map, an
        // object each, was a right click's cost at a hundred thousand.
        const reach = renderDimensionMode === '3d' ? CLICK_STRUCT_REACH_3D : CLICK_STRUCT_REACH_2D;
        const cgx = Math.floor(worldX / TILE), cgy = Math.floor(worldY / TILE);
        for (let gy = Math.max(0, cgy - reach); gy <= Math.min(GRID_H - 1, cgy + reach); gy++) for (let gx = Math.max(0, cgx - reach); gx <= Math.min(GRID_W - 1, cgx + reach); gx++) {
            const e = getTileEntityRef(gx, gy);
            if (!e || e.gx !== gx || e.gy !== gy || e.owner === localPlayerId || !(e.energy > 0)) continue;
            const kind = _clickStructKind(e);
            if (!kind || !isGameplayTargetVisibleToPlayer(localPlayerId, gx, gy)) continue;
            out.push(kind === 'tower' ? { kind, ref: e, x: e.x, y: e.y, hitShape: { kind: 'rect', hw: 15, hh: 15 }, hitRadius: 20, hitZ: 20 }
                : { kind, ref: e, x: e.x, y: e.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
        }
        let addEnemyFloorItem = (cell, gx, gy) => {
            if (cell && cell.item && cell.item.energy > 0 && cell.owner !== localPlayerId && isGameplayTargetVisibleToPlayer(localPlayerId, gx, gy)) {
                out.push({
                    kind: 'item',
                    ref: cell.item,
                    x: gx * TILE + TILE * 0.5,
                    y: gy * TILE + TILE * 0.5,
                    hitShape: { kind: 'rect', hw: 14, hh: 14 },
                    hitRadius: 20,
                    hitZ: 10,
                    gx,
                    gy,
                });
            }
        };
        let clickGx = Math.floor(worldX / TILE), clickGy = Math.floor(worldY / TILE);
        if (renderDimensionMode === '3d') {
            // (The same few tiles: every visible tile was a million at a zoomed-out view.)
            for (let gy = Math.max(0, clickGy - reach); gy <= Math.min(GRID_H - 1, clickGy + reach); gy++) {
                for (let gx = Math.max(0, clickGx - reach); gx <= Math.min(GRID_W - 1, clickGx + reach); gx++) addEnemyFloorItem(grid[gy] && grid[gy][gx], gx, gy);
            }
        } else if (clickGx >= 0 && clickGx < GRID_W && clickGy >= 0 && clickGy < GRID_H) {
            addEnemyFloorItem(grid[clickGy][clickGx], clickGx, clickGy);
        }
        return out;
    }

    function findNearestOwnedSelectableClickTarget(worldX, worldY, screenX = NaN, screenY = NaN) {
        let candidates = [];
        for (let u of _unitsNearPoint(worldX, worldY, CLICK_UNIT_REACH, true)) {
            if (u.owner !== localPlayerId || u.dead) continue;
            let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
            if (!isTileVisible(ugx, ugy)) continue;
            candidates.push({
                kind: 'unit',
                ref: u,
                x: u.x,
                y: u.y,
                hitShape: getUnitClickShape(u),
                hitRadius: (Number(u.r) || 0) + 8,
                hitZ: 30,
            });
        }
        for (let b of barracks) {
            if (b.owner !== localPlayerId || b.energy <= 0) continue;
            if (!isTileVisible(b.gx, b.gy)) continue;
            candidates.push({ kind: 'entity', ref: b, x: b.x, y: b.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
        }
        for (let t of towers) {
            if (t.owner !== localPlayerId || t.energy <= 0) continue;
            if (!isTileVisible(t.gx, t.gy)) continue;
            candidates.push({ kind: 'entity', ref: t, x: t.x, y: t.y, hitShape: { kind: 'rect', hw: 15, hh: 15 }, hitRadius: 20, hitZ: 20 });
        }
        for (let s of collectorSpawners) {
            if (s.owner !== localPlayerId || s.energy <= 0) continue;
            if (!isTileVisible(s.gx, s.gy)) continue;
            candidates.push({ kind: 'entity', ref: s, x: s.x, y: s.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
        }
        let addOwnedFloorItem = (cell, gx, gy) => {
            if (cell.item && cell.owner === localPlayerId) {
                candidates.push({
                    kind: 'entity',
                    ref: cell.item,
                    x: gx * TILE + TILE * 0.5,
                    y: gy * TILE + TILE * 0.5,
                    hitShape: { kind: 'rect', hw: 14, hh: 14 },
                    hitRadius: 20,
                    hitZ: 10,
                    post: () => { cell.item._gx = gx; cell.item._gy = gy; cell.item._cell = cell; }
                });
            }
        };
        let gx = Math.floor(worldX / TILE), gy = Math.floor(worldY / TILE);
        if (renderDimensionMode === '3d') {
            let bounds = get3DVisibleWorldBounds();
            for (let scanGy = bounds.minGy; scanGy <= bounds.maxGy; scanGy++) {
                for (let scanGx = bounds.minGx; scanGx <= bounds.maxGx; scanGx++) {
                    if (!isTileVisible(scanGx, scanGy)) continue;
                    let cell = grid[scanGy] && grid[scanGy][scanGx];
                    if (cell) addOwnedFloorItem(cell, scanGx, scanGy);
                }
            }
        } else if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H && isTileVisible(gx, gy)) {
            addOwnedFloorItem(grid[gy][gx], gx, gy);
        }
        for (let m of goldMines) {
            if (!isTileVisible(m.gx, m.gy)) continue;
            candidates.push({
                kind: 'entity',
                ref: m,
                x: m.x,
                y: m.y,
                hitShape: { kind: 'circle', r: 12 },
                hitRadius: 20,
                hitZ: 5,
                pick3DKind: 'mine',
                post: () => { m._isGoldMine = true; }
            });
        }
        for (let m of astarMines) {
            if (!isTileVisible(m.gx, m.gy)) continue;
            candidates.push({
                kind: 'entity',
                ref: m,
                x: m.x,
                y: m.y,
                hitShape: { kind: 'circle', r: 12 },
                hitRadius: 20,
                hitZ: 5,
                pick3DKind: 'mine',
                post: () => { m._isAstarMine = true; }
            });
        }
        return pickNearestHitCandidate(candidates, worldX, worldY, screenX, screenY);
    }

    function createCurrentViewPointTester() {
        if (
            renderDimensionMode === '3d' &&
            renderer3dInstance &&
            typeof renderer3dInstance.buildViewProjection === 'function' &&
            typeof renderer3dInstance.projectWorldToScreenDetailed === 'function'
        ) {
            renderer3dInstance.buildViewProjection(get3DProjectionSnapshot());
            let viewportWidth = Math.max(1, Number(renderer3dInstance.cssWidth) || viewW || 1);
            let viewportHeight = Math.max(1, Number(renderer3dInstance.cssHeight) || viewH || 1);
            return (x, y, pad = 0, lift = 0.12) => {
                if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
                let tileX = x / TILE;
                let tileY = y / TILE;
                let projected = renderer3dInstance.projectWorldToScreenDetailed(tileX, lift, tileY);
                if (!projected || !Number.isFinite(projected.x) || !Number.isFinite(projected.y) ||
                    !Number.isFinite(projected.ndcZ) || projected.ndcZ < -1 || projected.ndcZ > 1) return false;
                let screenPad = 0;
                if (pad > 0 && typeof renderer3dInstance.getScreenPixelsPerTile === 'function') {
                    screenPad = renderer3dInstance.getScreenPixelsPerTile(tileX, lift, tileY) * pad / TILE;
                }
                return projected.x >= -screenPad && projected.x <= viewportWidth + screenPad &&
                    projected.y >= -screenPad && projected.y <= viewportHeight + screenPad;
            };
        }

        let worldViewW = viewW / camera.zoom;
        let worldViewH = viewH / camera.zoom;
        return (x, y, pad = 0) => Number.isFinite(x) && Number.isFinite(y) &&
            x >= camera.x - pad && x <= camera.x + worldViewW + pad &&
            y >= camera.y - pad && y <= camera.y + worldViewH + pad;
    }

    function getVisibleSameTypeUnits(sampleUnit) {
        if (!sampleUnit) return [];
        let typeKey = sampleUnit.unitType;
        let out = [];
        let isPointInView = createCurrentViewPointTester();
        for (let u of units) {
            if (!u || u.dead || u.owner !== localPlayerId) continue;
            if (u.unitType !== typeKey) continue;
            let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
            if (!isTileVisible(ugx, ugy)) continue;
            if (!isPointInView(u.x, u.y, Math.max(4, Number(u.r) || 0), 0.28)) continue;
            out.push(u);
        }
        return out;
    }

    function getVisibleSameTypeEntities(sampleEntity) {
        if (!sampleEntity) return [];
        let out = [];
        let isPointInView = createCurrentViewPointTester();

        if (sampleEntity._isGoldMine) {
            for (let m of goldMines) {
                if (!m || !isTileVisible(m.gx, m.gy)) continue;
                if (!isPointInView(m.x, m.y, 12, 0.08)) continue;
                m._isGoldMine = true;
                out.push(m);
            }
            return out;
        }

        if (sampleEntity._isAstarMine) {
            for (let m of astarMines) {
                if (!m || !isTileVisible(m.gx, m.gy)) continue;
                if (!isPointInView(m.x, m.y, 12, 0.08)) continue;
                m._isAstarMine = true;
                out.push(m);
            }
            return out;
        }

        if (barracks.includes(sampleEntity)) {
            for (let b of barracks) {
                if (!b || b.energy <= 0 || b.owner !== localPlayerId) continue;
                if (b.unitType !== sampleEntity.unitType) continue;
                if (!isTileVisible(b.gx, b.gy)) continue;
                if (!isPointInView(b.x, b.y, 14, 0.12)) continue;
                out.push(b);
            }
            return out;
        }

        if (towers.includes(sampleEntity)) {
            for (let t of towers) {
                if (!t || t.energy <= 0 || t.owner !== localPlayerId) continue;
                if (t.type !== sampleEntity.type) continue;
                if (!isTileVisible(t.gx, t.gy)) continue;
                if (!isPointInView(t.x, t.y, 15, 0.18)) continue;
                out.push(t);
            }
            return out;
        }

        if (collectorSpawners.includes(sampleEntity)) {
            for (let s of collectorSpawners) {
                if (!s || s.energy <= 0 || s.owner !== localPlayerId) continue;
                if (s.type !== sampleEntity.type) continue;
                if (!isTileVisible(s.gx, s.gy)) continue;
                if (!isPointInView(s.x, s.y, 14, 0.14)) continue;
                out.push(s);
            }
            return out;
        }

        let sampleType = sampleEntity.type;
        for (let item of getCellItemsRowMajor()) {
            let gx = item.gx, gy = item.gy;
            let cell = grid[gy] && grid[gy][gx];
            if (!cell || cell.item !== item || cell.owner !== localPlayerId || item.energy <= 0) continue;
            if (item.type !== sampleType || !isTileVisible(gx, gy)) continue;
            if (!isPointInView(gx * TILE + TILE * 0.5, gy * TILE + TILE * 0.5, 14, 0.08)) continue;
            item._gx = gx; item._gy = gy; item._cell = cell;
            out.push(item);
        }
        return out;
    }

    function toggleVisibleSameTypeSelectionFromHit(hit) {
        if (!hit || !hit.ref) return;

        if (hit.kind === 'unit') {
            let group = getVisibleSameTypeUnits(hit.ref);
            if (group.length <= 0) return;
            let isSelected = selectedUnits.includes(hit.ref);
            if (isSelected) {
                let groupSet = new Set(group);
                selectedUnits = selectedUnits.filter(u => !groupSet.has(u));
            } else {
                let selected = new Set(selectedUnits);
                for (let u of group) {
                    if (!selected.has(u)) { selectedUnits.push(u); selected.add(u); }
                }
            }
            return;
        }

        if (hit.kind === 'entity') {
            let group = getVisibleSameTypeEntities(hit.ref);
            if (group.length <= 0) return;
            let isSelected = selectedEntities.includes(hit.ref);
            if (isSelected) {
                let groupSet = new Set(group);
                selectedEntities = selectedEntities.filter(ent => !groupSet.has(ent));
            } else {
                let selected = new Set(selectedEntities);
                for (let ent of group) {
                    if (!selected.has(ent)) { selectedEntities.push(ent); selected.add(ent); }
                }
            }
        }
    }

    function findEnemyUnitNear(worldX, worldY, screenX = NaN, screenY = NaN) {
        let cands = collectEnemyClickTargetCandidates(worldX, worldY, true)
            .filter(c => c.kind === 'unit');
        let best = pickNearestHitCandidate(cands, worldX, worldY, screenX, screenY);
        return best ? best.ref : null;
    }

    // The multi-point split's worker (lazily; null without workers).
    const ASSIGN_ASYNC_MIN = 2000;
    let _assignWorker = null, _assignSeq = 0, _assignPending = null, _assignWorkerFailed = false;
    function _assignWorkerGet() {
        if (_assignWorker || _assignWorkerFailed) return _assignWorker;
        try {
            _assignWorker = new Worker('./src/sim/assign_worker.js?v=20261024-cells');
            _assignWorker.onmessage = ev => {
                const m = ev.data || {}, P = _assignPending;
                if (!P || m.seq !== P.seq) return;
                _assignPending = null;
                localUnitOrderHook = null;
                if (!m.buckets) { console.error('[assign worker]', m.error); return; }
                // (Units ordered since the click: theirs is the later order.)
                const later = P.later.length ? new Set(P.later.flat()) : null;
                // (Each point's ids, split there: an array each for the actions.)
                for (let i = 0; i < m.buckets.length; i++) {
                    let ids = Array.from(m.buckets[i]);
                    if (later) ids = ids.filter(id => !later.has(id));
                    if (ids.length === 0) continue;
                    queueAction({ action: P.actionName, unitIds: ids, targetX: P.points[i].x, targetY: P.points[i].y });
                }
            };
            _assignWorker.onerror = () => { _assignWorkerFailed = true; _assignWorker = null; };
        } catch (err) { _assignWorkerFailed = true; _assignWorker = null; }
        return _assignWorker;
    }
    function applyUnitCommandTargets(unitIds, targetX, targetY, appendToMultiPoints, actionName = 'move', unitObjs = null) {
        if (!unitIds || unitIds.length === 0) return;
        if (appendToMultiPoints && multiUnitCommandPoints.length > 0) {
            multiUnitCommandPoints.push({ x: targetX, y: targetY });
        } else {
            multiUnitCommandPoints = [{ x: targetX, y: targetY }];
        }
        if (multiUnitCommandPoints.length === 0) multiUnitCommandPoints = [{ x: targetX, y: targetY }];

        // One point: all of them, in their order (no pass over the ids; a
        // long list is only encoded for the wire, never changed).
        if (multiUnitCommandPoints.length === 1) {
            queueAction({ action: actionName, unitIds: unitIds.length >= 64 ? unitIds : unitIds.slice(), targetX: multiUnitCommandPoints[0].x, targetY: multiUnitCommandPoints[0].y });
            return;
        }
        // The units' positions by their ids: beside the worker from the frame's
        // columns (its id map is an array; no view getters, no object a unit),
        // else from the units. (Not from a list of views: in a fight the ids
        // and the views of a selection differ by the dead, and a million
        // units took the slow way, a map look-up and an object each.)
        const F = typeof simClientCurrentUnitVis === 'function' ? simClientCurrentUnitVis() : null;
        const n = unitIds.length, xs = new Float32Array(n), ys = new Float32Array(n), has = new Uint8Array(n);
        if (F && typeof _pageUnitsById !== 'undefined') {
            const PU = _pageUnitsById, FID = F.id, FX = F.x, FY = F.y;
            for (let i = 0; i < n; i++) {
                const id = unitIds[i], u = PU.get(id), s = u ? u._s : -1;
                if (s >= 0 && FID[s] === id) { xs[i] = FX[s]; ys[i] = FY[s]; has[i] = 1; }
                else if (u) { const a = _entityWorldXY(u); if (a) { xs[i] = a.x; ys[i] = a.y; has[i] = 1; } }
            }
        } else {
            // (The kept id map: no map of every unit per click.)
            const unitById = typeof _unitByIdMap === 'function' ? _unitByIdMap() : new Map(units.map(u => [u.id, u]));
            for (let i = 0; i < n; i++) { const u = unitById.get(unitIds[i]); if (u) { xs[i] = u.x; ys[i] = u.y; has[i] = 1; } }
        }
        const points = multiUnitCommandPoints.map(p => ({ x: p.x, y: p.y }));
        // A big split runs on a worker (assign_worker.js), the ids split by
        // point there too; the orders go when the answer comes (a later
        // click's answer replaces an earlier one's).
        if (n >= ASSIGN_ASYNC_MIN && _assignWorkerGet()) {
            const seq = ++_assignSeq, ids = Int32Array.from(unitIds);
            const pending = _assignPending = { seq, points, actionName, later: [] };
            localUnitOrderHook = a => { if (_assignPending === pending) pending.later.push(a.unitIds); };
            _assignWorker.postMessage({ seq, xs, ys, has, points, ids }, [xs.buffer, ys.buffer, has.buffer, ids.buffer]);
            return;
        }
        const pick = assignNearestXY(xs, ys, has, points);
        const buckets = Array.from({ length: points.length }, () => []);
        for (let i = 0; i < n; i++) buckets[pick[i]].push(unitIds[i]);

        for (let i = 0; i < buckets.length; i++) {
            if (buckets[i].length === 0) continue;
            let rp = multiUnitCommandPoints[i];
            queueAction({ action: actionName, unitIds: buckets[i], targetX: rp.x, targetY: rp.y });
        }
    }

    function applyTowerTargetAssignments(selTowers, targetSpec, appendToMultiTargets) {
        if (!selTowers || selTowers.length === 0 || !targetSpec) return;
        if (appendToMultiTargets && multiTowerTargetPoints.length > 0) {
            multiTowerTargetPoints.push({ ...targetSpec });
        } else {
            multiTowerTargetPoints = [{ ...targetSpec }];
        }
        if (multiTowerTargetPoints.length === 0) multiTowerTargetPoints = [{ ...targetSpec }];

        let buckets = Array.from({ length: multiTowerTargetPoints.length }, () => []);
        let targetXY = spec => spec.type === 'unit' ? _entityWorldXY(getUnitById(spec.id))
            : (Number.isFinite(spec.gx) ? { x: spec.gx * TILE + 16, y: spec.gy * TILE + 16 } : null);
        let pick = _assignToNearestPoints(selTowers, multiTowerTargetPoints, _entityWorldXY, targetXY);
        for (let i = 0; i < selTowers.length; i++) buckets[pick[i]].push(selTowers[i]);

        for (let i = 0; i < buckets.length; i++) {
            if (buckets[i].length === 0) continue;
            let target = multiTowerTargetPoints[i];
            let towerCoords = buckets[i].map(t => ({ gx: t.gx, gy: t.gy }));
            queueAction({ action: 'towerTarget', towerCoords, target });
        }
    }

    function applyWorkerAssignTargets(workerUnits, targetType, targetGx, targetGy, appendToMultiTargets) {
        if (!workerUnits || workerUnits.length === 0) return;
        let multiTargets = targetType === 'build'
            ? multiBuilderAssignTargets
            : _isCollectorGatherTargetType(targetType)
                ? multiCollectorAssignTargets
                : (targetType === 'research')
                    ? multiResearcherAssignTargets
                    : multiHealerAssignTargets;
        if (appendToMultiTargets && multiTargets.length > 0) {
            multiTargets.push({ targetType, targetGx, targetGy });
        } else {
            multiTargets.length = 0;
            multiTargets.push({ targetType, targetGx, targetGy });
        }
        if (multiTargets.length === 0) multiTargets.push({ targetType, targetGx, targetGy });

        let unitIds = workerUnits.map(u => u.id);
        let buckets = Array.from({ length: multiTargets.length }, () => []);
        let pick = _assignToNearestPoints(workerUnits, multiTargets, _entityWorldXY,
            t => ({ x: t.targetGx * TILE + 16, y: t.targetGy * TILE + 16 }));
        for (let i = 0; i < unitIds.length; i++) {
            buckets[pick[i]].push(unitIds[i]);
        }

        for (let i = 0; i < buckets.length; i++) {
            if (buckets[i].length === 0) continue;
            let target = multiTargets[i];
            queueAction({
                action: 'workerAssign',
                unitIds: buckets[i],
                targetType: target.targetType,
                targetGx: target.targetGx,
                targetGy: target.targetGy
            });
        }
    }

    function screenToWorldClamped(sx, sy) {
        let rect = gameArea.getBoundingClientRect();
        let clampedX = Math.max(rect.left, Math.min(rect.right - 1, sx));
        let clampedY = Math.max(rect.top, Math.min(rect.bottom - 1, sy));
        return screenToWorld(clampedX, clampedY);
    }

    // The tile of the drag's last mouse event (see tryBuildPlacementDragAtClient).
    let buildPlacementDragLastTile = null;
    function stopBuildPlacementDrag() {
        buildPlacementDragActive = false;
        buildPlacementDragVisitedTiles = null;
        buildPlacementDragLastTile = null;
    }

    function canPlaceSelectedBuildItemAt(gx, gy, purchaseCount) {
        if (!selectedBuildItem) return false;
        if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return false;
        let _cd = BASE_CARD_TYPES[selectedBuildItem];
        if (selectedBuildItem === 'area_upgrader') {
            let aId = grid[gy][gx].areaId;
            if (_areaHasForeignBuildPresence(aId, localPlayerId)) return false;
            let area = getAreaById(aId);
            if (!area) return false;
            let areaCells = _getCanonicalAreaCellsById(aId, area);
            if (areaCells.length <= 0) return false;
            let filledCount = 0;
            for (let cp of areaCells) {
                let c = grid[cp.y][cp.x];
                if (c.type === TYPE_WALL && getTowerAtTile(cp.x, cp.y)) filledCount++;
                else if (c.item) filledCount++;
                else if (getBarrackAtTile(cp.x, cp.y)) filledCount++;
                else if (getSpawnerAtTile(cp.x, cp.y)) filledCount++;
            }
            return filledCount === areaCells.length && (area.multiplierLevel || 0) < 5;
        }
        return _cd &&
            (canStackAt(gx, gy, selectedBuildItem, localPlayerId) || canBuildAt(gx, gy, localPlayerId));
    }

    function tryPlaceSelectedBuildAt(gx, gy, playCantPlaceSound = true) {
        if (!selectedBuildItem) return false;
        if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H || !isTileActuallyVisibleToPlayer(localPlayerId, gx, gy)) {
            if (playCantPlaceSound) playSound('cant_place');
            return false;
        }
        let purchaseCount = Math.max(1, Math.floor(buildPurchaseMultiplier || 1));
        let canPlace = canPlaceSelectedBuildItemAt(gx, gy, purchaseCount);
        if (!canPlace) {
            if (playCantPlaceSound) playSound('cant_place');
            return false;
        }
        const tick = queueAction({ action: 'place', gx, gy, itemType: selectedBuildItem, autoUpgradeEnabled: defaultAutoUpgradeEnabled, buildEnabled: defaultAutoBuildEnabled, count: purchaseCount });
        // (Shown at once on the tile: the order takes a few ticks to come back
        // as a building; until the simulation has run its tick.)
        if (typeof notePendingBuildGhost === 'function') notePendingBuildGhost(gx, gy, selectedBuildItem, tick);
        requestBuildMenuRefresh();
        return true;
    }

    function tryBuildPlacementDragAtClient(clientX, clientY) {
        if (!buildPlacementDragActive || !selectedBuildItem || !buildPlacementDragVisitedTiles) return;
        let world = screenToWorldClamped(clientX, clientY);
        let gx = Math.floor(world.x / TILE), gy = Math.floor(world.y / TILE);
        if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return;
        // Every tile the mouse passed since its last event, not only the one
        // it is on now: a fast drag moves more than a tile between two mouse
        // events and left holes in the row.
        let last = buildPlacementDragLastTile || { gx, gy };
        buildPlacementDragLastTile = { gx, gy };
        let steps = Math.max(1, Math.abs(gx - last.gx), Math.abs(gy - last.gy));
        for (let k = steps > 96 ? steps : 1; k <= steps; k++) {
            let x = Math.round(last.gx + (gx - last.gx) * k / steps), y = Math.round(last.gy + (gy - last.gy) * k / steps);
            let tileKey = `${x},${y}`;
            if (buildPlacementDragVisitedTiles.has(tileKey)) continue;
            buildPlacementDragVisitedTiles.add(tileKey);
            tryPlaceSelectedBuildAt(x, y, false);
        }
    }

    gameArea.addEventListener('mousedown', (e) => {
        if (!gameStarted || gameOver) return;
        if (renderDimensionMode === '3d' && e.button === 1) {
            renderer3dRotateDrag = { clientX: e.clientX, clientY: e.clientY };
            e.preventDefault();
            return;
        }
        let rect = gameArea.getBoundingClientRect();
        let world = screenToWorld(e.clientX, e.clientY);
        let clickScreenX = e.clientX - rect.left;
        let clickScreenY = e.clientY - rect.top;

        if (e.button === 0) { // Left click
            if (selectedBuildItem) {
                if (localDefeated) {
                    selectedBuildItem = null;
                    requestBuildMenuRefresh();
                    stopBuildPlacementDrag();
                    return;
                }
                let gx = Math.floor(world.x / TILE), gy = Math.floor(world.y / TILE);
                let shiftHeld = !!e.shiftKey;
                let dragPlace = shouldShiftDragBuildPlace(shiftHeld);
                let keepSelected = shouldKeepBuildSelectionAfterLeftClick(shiftHeld);

                if (dragPlace) {
                    buildPlacementDragActive = true;
                    buildPlacementDragVisitedTiles = new Set();
                    buildPlacementDragVisitedTiles.add(`${gx},${gy}`);
                    buildPlacementDragLastTile = { gx, gy };
                    tryPlaceSelectedBuildAt(gx, gy, true);
                } else {
                    stopBuildPlacementDrag();
                    tryPlaceSelectedBuildAt(gx, gy, true);
                }
                // (The ordered tile drawn now, not with the next frame.)
                if (typeof redrawBuildPreviewNow === 'function') redrawBuildPreviewNow(true);

                if (!keepSelected) {
                    selectedBuildItem = null;
                    requestBuildMenuRefresh();
                    stopBuildPlacementDrag();
                }
                return;
            }
            // Start box selection
            isBoxSelecting = true;
            selectionBox = { sx: world.x, sy: world.y, ex: world.x, ey: world.y };
            selectionBoxScreen = {
                sx: e.clientX - rect.left,
                sy: e.clientY - rect.top,
                ex: e.clientX - rect.left,
                ey: e.clientY - rect.top,
            };
        } else if (e.button === 2) { // Right click
            e.preventDefault();
            if (localDefeated) return;
            if (selectedBuildItem) { selectedBuildItem = null; requestBuildMenuRefresh(); stopBuildPlacementDrag(); return; }
            let isCtrlMulti = isCtrlMultiCommand(e);
            noteOrderClickPing(world.x, world.y);
            const issueOrders = () => {
            let clickGx = Math.max(0, Math.min(GRID_W - 1, Math.floor(world.x / TILE)));
            let clickGy = Math.max(0, Math.min(GRID_H - 1, Math.floor(world.y / TILE)));
            let clickTileVisible = isGameplayTargetVisibleToPlayer(localPlayerId, clickGx, clickGy);
            let clickedEnemyUnit = clickTileVisible ? findEnemyUnitNear(world.x, world.y, clickScreenX, clickScreenY) : null;
            let issuedStructureCommand = false;
            // Set rally for active selected barracks and spawners
            let selSpawners = activeStructureSelection().rally;
            if (selSpawners.length > 0) {
                let seed = _resolveSpawnerRallyPointForClick(selSpawners[0], world.x, world.y, clickedEnemyUnit);
                applyRallyTargets(selSpawners, seed.x, seed.y, isCtrlMulti, seed.targetUnitId || null);
                issuedStructureCommand = true;
            } else if (!isCtrlMulti) {
                multiRallyPoints = [];
            }
            // Set preferred target for selected own towers
            let selTowers = activeStructureSelection().towers;
            if (selTowers.length > 0) {
                // Pick nearest clicked enemy target (unit/building/item) by center distance.
                let towerTarget = null;
                let targetHit = pickNearestHitCandidate(collectEnemyClickTargetCandidates(world.x, world.y, true), world.x, world.y, clickScreenX, clickScreenY);
                if (targetHit) {
                    if (targetHit.kind === 'unit') towerTarget = { type: 'unit', id: targetHit.ref.id };
                    else if (targetHit.kind === 'tower') towerTarget = { type: 'tower', gx: targetHit.ref.gx, gy: targetHit.ref.gy };
                    else if (targetHit.kind === 'barrack') towerTarget = { type: 'barrack', gx: targetHit.ref.gx, gy: targetHit.ref.gy };
                    else if (targetHit.kind === 'spawner') towerTarget = { type: 'spawner', gx: targetHit.ref.gx, gy: targetHit.ref.gy };
                    else if (targetHit.kind === 'item') towerTarget = { type: 'item', gx: targetHit.gx, gy: targetHit.gy };
                }
                if (towerTarget) {
                    applyTowerTargetAssignments(selTowers, towerTarget, isCtrlMulti);
                    issuedStructureCommand = true;
                } else {
                    // Right-click on ground: clear preferred target for selected towers
                    let towerCoords = selTowers.map(t => ({ gx: t.gx, gy: t.gy }));
                    queueAction({ action: 'towerTarget', towerCoords, target: null });
                    if (!isCtrlMulti) multiTowerTargetPoints = [];
                    issuedStructureCommand = true;
                }
            }
            const SC = getActiveUnitClasses(true);
            // (Counts and ids, not the unit lists: they are made only when asked for.)
            const activeCount = SC.count;
            if (issuedStructureCommand && activeCount === 0) {
                requestInfoPanelRefresh();
                return;
            }

            // Non-visible tiles must always use direct location commands (no target snapping).
            if (!clickTileVisible && activeCount > 0) {
                applyUnitCommandTargets(SC.allIds, world.x, world.y, isCtrlMulti, 'move', () => SC.active);
                requestInfoPanelRefresh();
                return;
            }

            // Right-click own barrack to queue unit (only if no workers or combat units selected)
            if (selSpawners.length === 0 && activeCount === 0) {
                let ownBarrackHits = [];
                for (let b of barracks) {
                    if (b.owner !== localPlayerId || b.energy <= 0 || b.underConstruction) continue;
                    if (!isTileVisible(b.gx, b.gy)) continue;
                    ownBarrackHits.push({ ref: b, x: b.x, y: b.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
                }
                let clickedBarrack = pickNearestHitCandidate(ownBarrackHits, world.x, world.y, clickScreenX, clickScreenY);
                if (clickedBarrack) {
                    queueAction({ action: 'queueUnit', gx: clickedBarrack.ref.gx, gy: clickedBarrack.ref.gy, count: queuePurchaseMultiplier });
                    return;
                }
            }
            if (activeCount > 0) {
                let forceManualWorkerMove = issuedStructureCommand;
                // --- Worker targeting logic ---
                let builderUnits = SC.of('builder');
                let collectorUnitGroups = RESOURCE_TYPE_LIST.map(cfg => {
                    return cfg ? {
                        resourceKey: cfg.key,
                        cfg,
                        units: SC.of(cfg.collectorUnitKey)
                    } : null;
                }).filter(group => group && group.units.length > 0);
                let salvagerUnits = SC.of('salvager');
                let healerUnits = SC.of('healer');
                let researcherUnits = SC.of('researcher');
                let workerIds = SC.workerCount > 0 ? SC.workerIds : [];

                if (!forceManualWorkerMove && builderUnits.length > 0) {
                    // Generic builder-targeting for any placeable object that can be built/upgraded.
                    let buildTarget = _getBuilderWorkTargetNear(world.x, world.y, localPlayerId, 22, true);
                    if (buildTarget) {
                        applyWorkerAssignTargets(builderUnits, 'build', buildTarget.gx, buildTarget.gy, isCtrlMulti);
                        requestInfoPanelRefresh();
                        // If no non-worker units, return
                        if (SC.combatCount === 0) return;
                    }
                } else if (!isCtrlMulti) {
                    multiBuilderAssignTargets = [];
                }

                if (!forceManualWorkerMove && collectorUnitGroups.length > 0) {
                    let issuedCollectorAssign = false;
                    let clickGx = Math.floor(world.x / TILE);
                    let clickGy = Math.floor(world.y / TILE);
                    for (let group of collectorUnitGroups) {
                        let workerType = group.cfg.collectorUnitKey;
                        let gatherTarget = _getGatherTargetAtForCollectorWorkerType(workerType, clickGx, clickGy, localPlayerId);
                        if (!gatherTarget) continue;
                        applyWorkerAssignTargets(group.units, gatherTarget.type, gatherTarget.target.gx, gatherTarget.target.gy, isCtrlMulti);
                        issuedCollectorAssign = true;
                    }
                    if (issuedCollectorAssign) {
                        requestInfoPanelRefresh();
                        if (SC.combatCount === 0) return;
                    }
                } else if (!isCtrlMulti) {
                    multiCollectorAssignTargets = [];
                }

                if (!forceManualWorkerMove && healerUnits.length > 0) {
                    let queueTarget = _getHealerQueueTargetNear(world.x, world.y, localPlayerId, 22, false);
                    if (queueTarget) {
                        applyWorkerAssignTargets(healerUnits, 'queue', queueTarget.gx, queueTarget.gy, isCtrlMulti);
                        requestInfoPanelRefresh();
                        if (SC.combatCount === 0) return;
                    }
                } else if (!isCtrlMulti) {
                    multiHealerAssignTargets = [];
                }

                if (!forceManualWorkerMove && researcherUnits.length > 0) {
                    let researchTarget = null;
                    let researchBestDist = Infinity;
                    for (let s of collectorSpawners) {
                        if (!_isResearcherTargetBuilding(s, localPlayerId, true)) continue;
                        if (!isTileVisible(s.gx, s.gy)) continue;
                        let d = detHypot(s.x - world.x, s.y - world.y);
                        if (d > 22 || d >= researchBestDist) continue;
                        researchBestDist = d;
                        researchTarget = s;
                    }
                    if (researchTarget) {
                        applyWorkerAssignTargets(researcherUnits, 'research', researchTarget.gx, researchTarget.gy, isCtrlMulti);
                        requestInfoPanelRefresh();
                        if (SC.combatCount === 0) return;
                    }
                } else if (!isCtrlMulti) {
                    multiResearcherAssignTargets = [];
                }

                // --- Normal combat unit targeting ---
                const combatUnits = () => SC.combat;
                if (SC.combatCount > 0) {
                    let targetUnit = null, targetBuilding = null;
                    let targetBuildingGx = null, targetBuildingGy = null;
                    let combatHit = pickNearestHitCandidate(collectEnemyClickTargetCandidates(world.x, world.y, true), world.x, world.y, clickScreenX, clickScreenY);
                    if (combatHit) {
                        if (combatHit.kind === 'unit') targetUnit = combatHit.ref;
                        else {
                            targetBuilding = combatHit.ref;
                            if (combatHit.kind === 'item') {
                                targetBuildingGx = combatHit.gx;
                                targetBuildingGy = combatHit.gy;
                            } else {
                                targetBuildingGx = combatHit.ref.gx;
                                targetBuildingGy = combatHit.ref.gy;
                            }
                        }
                    }
                    let unitIds = SC.combatIds;
                    if (targetUnit) {
                        if (isCtrlMulti) {
                            // Allow enemy clicks to be part of multi-point command chains.
                            applyUnitCommandTargets(unitIds, targetUnit.x, targetUnit.y, true, 'attackMove', combatUnits);
                        } else {
                            queueAction({ action: 'attack', unitIds, targetId: targetUnit.id, targetX: targetUnit.x, targetY: targetUnit.y });
                            multiUnitCommandPoints = [];
                        }
                        if (workerIds.length > 0) {
                            // Keep mixed selections moving; workers cannot attack unit targets directly.
                            queueAction({ action: 'move', unitIds: workerIds, targetX: targetUnit.x, targetY: targetUnit.y });
                        }
                    } else if (targetBuilding) {
                        let targetBuildingX = Number.isFinite(targetBuilding.x) ? targetBuilding.x : (targetBuildingGx * TILE + TILE * 0.5);
                        let targetBuildingY = Number.isFinite(targetBuilding.y) ? targetBuilding.y : (targetBuildingGy * TILE + TILE * 0.5);
                        if (isCtrlMulti) {
                            // Allow enemy clicks to be part of multi-point command chains.
                            applyUnitCommandTargets(unitIds, targetBuildingX, targetBuildingY, true, 'attackMove', combatUnits);
                        } else {
                            queueAction({ action: 'attackBuilding', unitIds, targetGx: targetBuildingGx, targetGy: targetBuildingGy });
                            multiUnitCommandPoints = [];
                        }
                        if (workerIds.length > 0) {
                            // Keep mixed selections moving; workers cannot attack building targets directly.
                            queueAction({ action: 'move', unitIds: workerIds, targetX: targetBuildingX, targetY: targetBuildingY });
                        }
                    } else if (attackMoveMode) {
                        applyUnitCommandTargets(unitIds, world.x, world.y, isCtrlMulti, 'attackMove', combatUnits);
                        attackMoveMode = false;
                    } else {
                        // Workers also move to the position if no special target found
                        applyUnitCommandTargets(SC.allIds, world.x, world.y, isCtrlMulti, 'move', () => SC.active);
                    }
                } else if (workerIds.length > 0) {
                    // Only workers selected and no special target - move them
                    applyUnitCommandTargets(workerIds, world.x, world.y, isCtrlMulti, 'move', () => SC.workers);
                }
            } else if (!isCtrlMulti) {
                multiUnitCommandPoints = [];
            }
            requestInfoPanelRefresh();
            };
            if (deferBigOrders && selectedUnits.length + selectedEntities.length >= ORDER_DEFER_MIN) deferOrderWork(issueOrders);
            else issueOrders();
        }
    });

    gameArea.addEventListener('mousemove', (e) => {
        if (renderer3dRotateDrag && renderDimensionMode === '3d' && renderer3dInstance && typeof renderer3dInstance.adjustOrbit === 'function') {
            let dx = e.clientX - renderer3dRotateDrag.clientX;
            let dy = e.clientY - renderer3dRotateDrag.clientY;
            renderer3dRotateDrag.clientX = e.clientX;
            renderer3dRotateDrag.clientY = e.clientY;
            renderer3dInstance.adjustOrbit(-dx * 0.008, dy * 0.006);
        }
        let rect = gameArea.getBoundingClientRect();
        let world = screenToWorldClamped(e.clientX, e.clientY);
        mouseWorldX = world.x; mouseWorldY = world.y;
        mouseScreenX = e.clientX; mouseScreenY = e.clientY;
        tryBuildPlacementDragAtClient(e.clientX, e.clientY);
        // (The build preview at the mouse's own rate: renderer.js.)
        if (selectedBuildItem && typeof redrawBuildPreviewNow === 'function') redrawBuildPreviewNow();
        if (isBoxSelecting && selectionBox) {
            selectionBox.ex = world.x; selectionBox.ey = world.y;
            if (selectionBoxScreen) {
                selectionBoxScreen.ex = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
                selectionBoxScreen.ey = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
            }
        }
    });

    window.addEventListener('mousemove', (e) => {
        // A drag whose button is no longer held lost its mouseup (a native
        // drag and drop, an OS dialog, a release outside the window): end it
        // here, or the selection box/orbit/placement follows the bare mouse.
        if (!(e.buttons & 4)) renderer3dRotateDrag = null;
        if (!(e.buttons & 1) && (isBoxSelecting || buildPlacementDragActive)) {
            stopBuildPlacementDrag();
            if (isBoxSelecting) gameArea.dispatchEvent(new MouseEvent('mouseup', { button: 0, clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey }));
        }
        if (renderer3dRotateDrag && renderDimensionMode === '3d' && renderer3dInstance && typeof renderer3dInstance.adjustOrbit === 'function') {
            let dx = e.clientX - renderer3dRotateDrag.clientX;
            let dy = e.clientY - renderer3dRotateDrag.clientY;
            renderer3dRotateDrag.clientX = e.clientX;
            renderer3dRotateDrag.clientY = e.clientY;
            renderer3dInstance.adjustOrbit(-dx * 0.008, dy * 0.006);
        }
        tryBuildPlacementDragAtClient(e.clientX, e.clientY);
        if (!isBoxSelecting || !selectionBox) return;
        let rect = gameArea.getBoundingClientRect();
        let world = screenToWorldClamped(e.clientX, e.clientY);
        mouseWorldX = world.x; mouseWorldY = world.y;
        selectionBox.ex = world.x; selectionBox.ey = world.y;
        if (selectionBoxScreen) {
            selectionBoxScreen.ex = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
            selectionBoxScreen.ey = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
        }
    });

    gameArea.addEventListener('mouseup', (e) => {
        if (e.button === 1) renderer3dRotateDrag = null;
        if (e.button === 0) stopBuildPlacementDrag();
        if (e.button === 0 && isBoxSelecting) {
            isBoxSelecting = false;
            let boxSelected = false;
            let unchangedBoxSelection = false;
            if (selectionBox) {
                let sx = Math.min(selectionBox.sx, selectionBox.ex);
                let sy = Math.min(selectionBox.sy, selectionBox.ey);
                let ex = Math.max(selectionBox.sx, selectionBox.ex);
                let ey = Math.max(selectionBox.sy, selectionBox.ey);
                let w = ex - sx, h = ey - sy;
                let screenW = selectionBoxScreen ? Math.abs(selectionBoxScreen.ex - selectionBoxScreen.sx) : w;
                let screenH = selectionBoxScreen ? Math.abs(selectionBoxScreen.ey - selectionBoxScreen.sy) : h;

                if (screenW < 5 && screenH < 5) {
                    // Click select: choose nearest hit among units/buildings/items/mines.
                    let clickHit = findNearestOwnedSelectableClickTarget(
                        selectionBox.sx,
                        selectionBox.sy,
                        selectionBoxScreen ? selectionBoxScreen.sx : NaN,
                        selectionBoxScreen ? selectionBoxScreen.sy : NaN
                    );
                    if (clickHit && clickHit.post) clickHit.post();
                    let isCtrlLeftClick = !!(e.ctrlKey || e.metaKey || (e.getModifierState && (e.getModifierState('Control') || e.getModifierState('Meta'))));
                    if (isCtrlLeftClick && clickHit) {
                        toggleVisibleSameTypeSelectionFromHit(clickHit);
                    } else if (clickHit && clickHit.kind === 'unit') {
                        let clicked = clickHit.ref;
                        if (e.shiftKey) {
                            let idx = selectedUnits.indexOf(clicked);
                            if (idx >= 0) selectedUnits.splice(idx, 1);
                            else selectedUnits.push(clicked);
                        } else { selectedUnits = [clicked]; selectedEntities = []; }
                    } else if (clickHit && clickHit.kind === 'entity') {
                        let clickedEntity = clickHit.ref;
                        if (e.shiftKey) {
                            let idx = selectedEntities.indexOf(clickedEntity);
                            if (idx >= 0) selectedEntities.splice(idx, 1);
                            else selectedEntities.push(clickedEntity);
                        } else { selectedEntities = [clickedEntity]; selectedUnits = []; }
                    } else {
                        if (!e.shiftKey) { selectedUnits = []; selectedEntities = []; }
                    }
                } else {
                    // Box select - pick up units AND buildings
                    boxSelected = true;
                    let newUnits = [];
                    let newEntities = [];
                    let projectedSlots = null, projectedSlotCount = 0;
                    if (renderDimensionMode === '3d' && selectionBoxScreen) {
                        let projectedSelection = get3DBoxSelection(selectionBoxScreen);
                        newUnits = projectedSelection.units;
                        newEntities = projectedSelection.entities;
                        projectedSlots = projectedSelection.unitSlots; projectedSlotCount = projectedSelection.unitSlotCount;
                    } else {
                        newUnits = _ownUnitsInBox(sx, sy, ex, ey);
                        for (let b of barracks) {
                            if (b.energy > 0 && b.owner === localPlayerId && isTileVisible(b.gx, b.gy) && b.x >= sx && b.x <= ex && b.y >= sy && b.y <= ey) newEntities.push(b);
                        }
                        for (let t of towers) {
                            if (t.energy > 0 && t.owner === localPlayerId && isTileVisible(t.gx, t.gy) && t.x >= sx && t.x <= ex && t.y >= sy && t.y <= ey) newEntities.push(t);
                        }
                        for (let s of collectorSpawners) {
                            if (s.energy > 0 && s.owner === localPlayerId && isTileVisible(s.gx, s.gy) && s.x >= sx && s.x <= ex && s.y >= sy && s.y <= ey) newEntities.push(s);
                        }
                        let minGx = Math.max(0, Math.floor(sx / TILE)), maxGx = Math.min(GRID_W - 1, Math.floor(ex / TILE));
                        let minGy = Math.max(0, Math.floor(sy / TILE)), maxGy = Math.min(GRID_H - 1, Math.floor(ey / TILE));
                        let seenItems = new Set(newEntities);
                        let items = getCellItemsRowMajor();
                        for (let i = findCellItemRowStart(items, minGy); i < items.length; i++) {
                            let item = items[i], gx = item.gx, gy = item.gy;
                            if (gy > maxGy) break;
                            if (gx < minGx || gx > maxGx || seenItems.has(item)) continue;
                            let cell = grid[gy] && grid[gy][gx];
                            if (!cell || cell.item !== item || cell.owner !== localPlayerId || !isTileVisible(gx, gy)) continue;
                            item._gx = gx; item._gy = gy; item._cell = cell;
                            newEntities.push(item);
                            seenItems.add(item);
                        }
                        for (let m of goldMines) {
                            if (!isTileVisible(m.gx, m.gy)) continue;
                            if (m.x >= sx && m.x <= ex && m.y >= sy && m.y <= ey) { m._isGoldMine = true; newEntities.push(m); }
                        }
                        for (let m of astarMines) {
                            if (!isTileVisible(m.gx, m.gy)) continue;
                            if (m.x >= sx && m.x <= ex && m.y >= sy && m.y <= ey) { m._isAstarMine = true; newEntities.push(m); }
                        }
                    }
                    if (e.shiftKey) {
                        let haveUnits = new Set(selectedUnits), haveEntities = new Set(selectedEntities);
                        for (let u of newUnits) { if (!haveUnits.has(u)) selectedUnits.push(u); }
                        for (let ent of newEntities) { if (!haveEntities.has(ent)) selectedEntities.push(ent); }
                    } else {
                        // Repeating the same drag should retain panel nodes and
                        // their listeners. A fresh subgroup object forces a full
                        // panel rebuild even when nothing actually changed.
                        unchangedBoxSelection = selectedUnits.length === newUnits.length
                            && selectedEntities.length === newEntities.length
                            && selectedUnits.every((u, i) => u === newUnits[i])
                            && selectedEntities.every((e, i) => e === newEntities[i])
                            && !Object.values(activeSubGroups).some(value => value === false);
                        if (!unchangedBoxSelection) {
                            selectedUnits = newUnits;
                            selectedEntities = newEntities;
                            // (Its slots are known already: no pass over its units for them.)
                            if (_boxUnitSlotsFor === newUnits) selectionIndexAdopt(newUnits, _boxUnitSlots, _boxUnitSlotCount);
                            else if (projectedSlots) selectionIndexAdopt(newUnits, projectedSlots, projectedSlotCount);
                        }
                    }
                }
                if (!unchangedBoxSelection) activeSubGroups = {};
                selectionBox = null;
                selectionBoxScreen = null;
            }
            // A box selection's panel (hundreds of things: tens of ms of
            // markup and layout) is built on the next frame, so the frame
            // right after the release already shows the new selection, and
            // quick repeated drags build the panel once.
            if (boxSelected) requestInfoPanelRefreshAfterFrame();
            else updateInfoPanel();
        }
    });

    window.addEventListener('mouseup', (e) => {
        if (e.button === 1) renderer3dRotateDrag = null;
        if (e.button === 0) stopBuildPlacementDrag();
        if (e.button !== 0 || !isBoxSelecting) return;
        let syntheticUp = new MouseEvent('mouseup', { button: 0, clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey });
        gameArea.dispatchEvent(syntheticUp);
    });

    gameArea.addEventListener('contextmenu', e => e.preventDefault());
    // In a match, a stray right click anywhere (side panels, bars, popups) must
    // not open the browser menu. Text fields and links keep theirs for copy/paste.
    document.addEventListener('contextmenu', (e) => {
        if (!gameStarted) return;
        let t = e.target instanceof Element ? e.target : null;
        if (t && t.closest('input, textarea, select, a[href], [contenteditable="true"]')) return;
        e.preventDefault();
    });
    gameArea.addEventListener('auxclick', (e) => {
        if (e.button === 1) e.preventDefault();
    });

    gameArea.addEventListener('wheel', (e) => {
        if (!gameStarted || gameOver || !Number.isFinite(e.deltaY) || e.deltaY === 0) return;
        e.preventDefault();
        let minZoom = getMinCameraZoom();
        let from = _cameraZoomAnim ? _cameraZoomAnim.target : camera.zoom;
        let nextZoom = e.deltaY < 0 ? Math.min(MAX_CAMERA_ZOOM, from * 1.2) : Math.max(minZoom, from / 1.2);
        // Trackpads keep emitting at the limit.
        if (nextZoom === from) return;
        _cameraZoomAnim = { target: nextZoom, clientX: e.clientX, clientY: e.clientY, applied: camera.zoom };
    }, { passive: false });

    minimapCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Minimap click / command
    minimapCanvas.addEventListener('mousedown', (e) => {
        let rect = minimapCanvas.getBoundingClientRect();
        let mx = (e.clientX - rect.left) * (MINIMAP_SIZE / rect.width);
        let my = (e.clientY - rect.top) * (MINIMAP_SIZE / rect.height);
        let scale = MINIMAP_SIZE / GRID_W;
        let gx = Math.max(0, Math.min(GRID_W - 1, Math.floor(mx / scale)));
        let gy = Math.max(0, Math.min(GRID_H - 1, Math.floor(my / scale)));
        let worldX = gx * TILE + TILE / 2;
        let worldY = gy * TILE + TILE / 2;

        if (e.button === 2) {
            e.preventDefault();
            if (!gameStarted || gameOver) return;
            if (localDefeated) return;
            if (selectedBuildItem) { selectedBuildItem = null; requestBuildMenuRefresh(); stopBuildPlacementDrag(); return; }

            let isCtrlMulti = isCtrlMultiCommand(e);
            noteOrderClickPing(worldX, worldY);
            const issueOrders = () => {
            let selSpawners = activeStructureSelection().rally;
            if (selSpawners.length > 0) {
                applyRallyTargets(selSpawners, worldX, worldY, isCtrlMulti);
            } else if (!isCtrlMulti) {
                multiRallyPoints = [];
            }

            const SC = getActiveUnitClasses(true);
            if (SC.count > 0) {
                let combatUnits = SC.combatCount > 0 ? SC.combatIds : [];
                let workerUnits = SC.workerCount > 0 ? SC.workerIds : [];
                if (combatUnits.length > 0) {
                    if (attackMoveMode) {
                        applyUnitCommandTargets(combatUnits, worldX, worldY, isCtrlMulti, 'attackMove');
                        attackMoveMode = false;
                    } else {
                        applyUnitCommandTargets(combatUnits, worldX, worldY, isCtrlMulti, 'move');
                    }
                }
                if (workerUnits.length > 0) {
                    applyUnitCommandTargets(workerUnits, worldX, worldY, isCtrlMulti, 'move');
                }
            } else if (!isCtrlMulti) {
                multiUnitCommandPoints = [];
            }

            requestInfoPanelRefresh();
            };
            if (deferBigOrders && selectedUnits.length + selectedEntities.length >= ORDER_DEFER_MIN) deferOrderWork(issueOrders);
            else issueOrders();
            return;
        }

        // Left click centers camera
        camera.x = (mx / scale) * TILE - viewW / camera.zoom / 2;
        camera.y = (my / scale) * TILE - viewH / camera.zoom / 2;
        clampCamera();
    });

    // Keyboard
    // Space: short press team colours, held 2D <-> 3D (at once when held
    // long enough, not at the release).
    let spaceTimer = 0, spaceLong = false, spaceDown = false;
    const typingTarget = t => t instanceof Element && !!t.closest('input, textarea, select, [contenteditable="true"]');
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && gameStarted && !typingTarget(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) {
            // (Not a focused button's click either.)
            e.preventDefault();
            if (e.repeat || spaceDown) return;
            spaceDown = true; spaceLong = false;
            clearTimeout(spaceTimer);
            spaceTimer = setTimeout(() => { if (spaceDown) { spaceLong = true; toggleRenderDimension(); } }, 400);
            return;
        }
        let wasDown = !!keysDown[e.key.toLowerCase()];
        keysDown[e.key.toLowerCase()] = true;
        if (!wasDown) noteCameraPanInput(e.timeStamp);
        if (!gameStarted) return;
        // § is an alias for Esc that never leaves fullscreen (except while typing).
        let escAlias = e.key === '§' && !(e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable="true"]'));
        if (escAlias) {
            e.preventDefault();
            let jukebox = document.getElementById('jukebox-panel');
            if (jukebox && jukebox.open) { jukebox.close(); return; }
        }
        if (e.key === 'Escape' || escAlias) {
            if (researchThingLevelDropdown) {
                closeResearchThingLevelDropdown();
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (setResearchStatMatrixPopupOpen(false)) return;
            if (setResearchPopupOpen(false)) return;
            if (setStartingResourcesPopupOpen(false)) return;
            if (setUnitStateHelpPopupOpen(false)) return;
            if (setHelpPopupOpen(false)) return;
            if (typeof closeBottomBarMenus === 'function' && closeBottomBarMenus()) return;
            stopBuildPlacementDrag();
            selectedBuildItem = null; selectedUnits = []; selectedEntities = []; activeSubGroups = {}; attackMoveMode = false; requestBuildMenuRefresh(); updateInfoPanel();
        }

        let popupGroupKey = String(e.key || '').toLowerCase();
        if (!e.ctrlKey && !e.metaKey && !e.altKey && POPUP_CONTROL_GROUP_KEYS.includes(popupGroupKey)) {
            handlePopupControlGroupKey(popupGroupKey, !!e.shiftKey);
            return;
        }

        if ((e.key === 'z' || e.key === 'Z') && selectedUnits.length > 0) attackMoveMode = true;
        if ((e.key === 'x' || e.key === 'X') && selectedUnits.length > 0) { let au = getActiveUnits(); if (au.length) queueAction({ action: 'stop', unitIds: au.map(u => u.id) }); }
        if (e.key === 'c' || e.key === 'C') { let au = getActiveUnits(); if (au.length) queueAction({ action: 'hold', unitIds: au.map(u => u.id) }); }
        if (e.key === 'f' || e.key === 'F') {
            cycleLevelVisibilityMode();
        }
        if (e.key === '/' || e.code === 'NumpadDivide' || e.key === 'q' || e.key === 'Q') {
            queueResizeForEachActiveUnitSubgroup('d2');
        }
        if (e.key === '*' || e.code === 'NumpadMultiply' || e.key === 'e' || e.key === 'E') {
            queueResizeForEachActiveUnitSubgroup('x2');
        }
        // Control groups
        let num = null;
        if (e.code && e.code.startsWith('Digit')) {
            let d = e.code.slice(5);
            if (d >= '1' && d <= '9') num = d;
        } else if (e.code && e.code.startsWith('Numpad')) {
            let d = e.code.slice(6);
            if (d >= '1' && d <= '9') num = d;
        } else if (e.key >= '1' && e.key <= '9') {
            num = e.key;
        }
        if (num) {
            handleControlGroupKey(num, !!e.shiftKey);
        }
    });
    document.addEventListener('keyup', (e) => {
        if (e.code === 'Space' && spaceDown) {
            e.preventDefault();
            spaceDown = false; clearTimeout(spaceTimer);
            if (!spaceLong && gameStarted) toggleRenderTeamColors();
            return;
        }
        keysDown[e.key.toLowerCase()] = false; noteCameraPanInput(e.timeStamp);
    });
    window.addEventListener('blur', () => { keysDown = {}; spaceDown = false; clearTimeout(spaceTimer); noteCameraPanInput(); renderer3dRotateDrag = null; stopBuildPlacementDrag(); });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            keysDown = {};
            renderer3dRotateDrag = null;
            stopBuildPlacementDrag();
        }
    });

    // HUD Settings
    const goldMineTextToggle = document.getElementById('setting-gold-mine-text');
    const rallyLineTypeSelect = document.getElementById('setting-rally-line-type');
    const rallyLineScopeSelect = document.getElementById('setting-show-rally-lines');
    const selectionOutlineScopeSelect = document.getElementById('setting-show-selection-outlines');
    const selectionOutlineTypeSelect = document.getElementById('setting-selection-outline-type');
    const selectionOutlineSeeThroughToggle = document.getElementById('setting-selection-outline-see-through');
    if (selectionOutlineSeeThroughToggle) {
        selectionOutlineSeeThroughToggle.checked = selectionOutlineSeeThrough;
        selectionOutlineSeeThroughToggle.addEventListener('change', () => {
            selectionOutlineSeeThrough = selectionOutlineSeeThroughToggle.checked;
            saveUiSettingsToStorage(); applyVisualSettingChange();
        });
    }
    // Settings > Rendering > Graphics. The preset select mirrors the
    // individual options ('custom' when they match no preset).
    const gfxControls = {
        aa: document.getElementById('setting-gfx-aa'),
        shadows: document.getElementById('setting-gfx-shadows'),
        ao: document.getElementById('setting-gfx-ao'),
        outline: document.getElementById('setting-gfx-outline'),
        bloom: document.getElementById('setting-gfx-bloom'),
        grade: document.getElementById('setting-gfx-grade'),
        sharpen: document.getElementById('setting-gfx-sharpen'),
        resolution: document.getElementById('setting-gfx-resolution')
    };
    const cameraSlideToggle = document.getElementById('setting-camera-slide');
    if (cameraSlideToggle) {
        cameraSlideToggle.checked = cameraSlideEnabled;
        cameraSlideToggle.addEventListener('change', () => {
            setCameraSlideEnabled(cameraSlideToggle.checked);
            saveUiSettingsToStorage();
        });
    }
    const renderMaxHeightSelect = document.getElementById('setting-render-max-height');
    if (renderMaxHeightSelect) {
        renderMaxHeightSelect.value = String(renderMaxHeight);
        renderMaxHeightSelect.addEventListener('change', () => {
            setRenderMaxHeight(renderMaxHeightSelect.value);
            renderMaxHeightSelect.value = String(renderMaxHeight);
            saveUiSettingsToStorage();
        });
    }
    const pixelSnapToggle = document.getElementById('setting-pixel-snap');
    if (pixelSnapToggle) {
        pixelSnapToggle.checked = pixelSnapCamera;
        pixelSnapToggle.addEventListener('change', () => {
            pixelSnapCamera = pixelSnapToggle.checked;
            saveUiSettingsToStorage();
        });
    }
    const fpsTargetSelect = document.getElementById('setting-fps-target');
    if (fpsTargetSelect) {
        fpsTargetSelect.innerHTML = '<option value="auto">Auto</option>'
            + FPS_TARGET_CHOICES.map(v => `<option value="${v}">${v}</option>`).join('');
        refreshFpsTargetAutoLabel();
        fpsTargetSelect.addEventListener('change', () => {
            setFpsTargetSetting(fpsTargetSelect.value);
            fpsTargetSelect.value = String(getFpsTargetSetting());
            saveUiSettingsToStorage();
        });
        // The window may have moved to another display since.
        let btnSettings = document.getElementById('btn-help');
        if (btnSettings) btnSettings.addEventListener('click', refreshFpsTargetAutoLabel);
    }
    const gfxPresetSelect = document.getElementById('setting-gfx-preset');
    const syncGraphicsControls = () => {
        for (let key in gfxControls) {
            let el = gfxControls[key];
            if (!el) continue;
            if (el.type === 'checkbox') el.checked = !!graphicsOptions[key];
            else el.value = String(graphicsOptions[key]);
        }
        if (gfxPresetSelect) gfxPresetSelect.value = matchGraphicsPreset(graphicsOptions);
    };
    const setGraphicsOptions = next => {
        graphicsOptions = normalizeGraphicsOptions(next);
        syncGraphicsControls();
        saveUiSettingsToStorage();
    };
    for (let key in gfxControls) {
        let el = gfxControls[key];
        if (!el) continue;
        el.addEventListener('change', () => {
            let value = el.type === 'checkbox' ? el.checked : (key === 'resolution' ? Number(el.value) : el.value);
            // Sharpen: 'false' / 'true' select values are the booleans.
            if (key === 'sharpen') value = value === 'true' ? true : value === 'false' ? false : value;
            setGraphicsOptions({ ...graphicsOptions, [key]: value });
        });
    }
    if (gfxPresetSelect) {
        gfxPresetSelect.addEventListener('change', () => {
            let preset = GRAPHICS_PRESETS[gfxPresetSelect.value];
            // 'custom' keeps the current options.
            if (preset) setGraphicsOptions({ ...preset });
            else syncGraphicsControls();
        });
    }
    syncGraphicsControls();
    if (goldMineTextToggle) {
        goldMineTextToggle.checked = !!showGoldMineAmountText;
        goldMineTextToggle.addEventListener('change', () => {
            showGoldMineAmountText = goldMineTextToggle.checked;
            saveUiSettingsToStorage(); applyVisualSettingChange();
        });
    }
    if (rallyLineTypeSelect) {
        rallyLineTypeSelect.value = rallyLineType;
        rallyLineTypeSelect.addEventListener('change', () => {
            rallyLineType = rallyLineTypeSelect.value === OVERLAY_LINE_SOLID ? OVERLAY_LINE_SOLID : OVERLAY_LINE_DOTTED;
            saveUiSettingsToStorage(); applyVisualSettingChange();
        });
    }
    if (rallyLineScopeSelect) {
        rallyLineScopeSelect.value = rallyLineScope;
        rallyLineScopeSelect.addEventListener('change', () => {
            let v = String(rallyLineScopeSelect.value || OVERLAY_SCOPE_BUILDINGS);
            if (v !== OVERLAY_SCOPE_BUILDINGS && v !== OVERLAY_SCOPE_BUILDINGS_UNITS && v !== OVERLAY_SCOPE_NONE) v = OVERLAY_SCOPE_BUILDINGS;
            rallyLineScope = v;
            saveUiSettingsToStorage(); applyVisualSettingChange();
        });
    }
    if (selectionOutlineScopeSelect) {
        selectionOutlineScopeSelect.value = selectionOutlineScope;
        selectionOutlineScopeSelect.addEventListener('change', () => {
            let v = String(selectionOutlineScopeSelect.value || OVERLAY_SCOPE_BUILDINGS_UNITS);
            if (v !== OVERLAY_SCOPE_UNITS && v !== OVERLAY_SCOPE_BUILDINGS_UNITS && v !== OVERLAY_SCOPE_NONE) v = OVERLAY_SCOPE_BUILDINGS_UNITS;
            selectionOutlineScope = v;
            saveUiSettingsToStorage(); applyVisualSettingChange();
        });
    }
    if (selectionOutlineTypeSelect) {
        selectionOutlineTypeSelect.value = selectionOutlineType;
        selectionOutlineTypeSelect.addEventListener('change', () => {
            selectionOutlineType = selectionOutlineTypeSelect.value === OVERLAY_LINE_SOLID ? OVERLAY_LINE_SOLID : OVERLAY_LINE_DOTTED;
            saveUiSettingsToStorage(); applyVisualSettingChange();
        });
    }

    updateControlGroupBar();

    // Fullscreen
    const btnFs = document.getElementById('btn-fullscreen');
    function syncFullscreenUi() {
        let isNativeFullscreen = !!document.fullscreenElement;
        appFullscreen = false;
        document.body.classList.remove('app-fullscreen');
        if (btnFs) btnFs.textContent = isNativeFullscreen ? '\uD83D\uDDD6 FS' : '\u26F6 FS';
        // Chromium: while fullscreen, Esc reaches the game (cancel build,
        // close popups) instead of leaving fullscreen; holding Esc still leaves.
        let keyboard = navigator.keyboard;
        let canLockEsc = !!(keyboard && typeof keyboard.lock === 'function');
        if (btnFs) {
            btnFs.title = canLockEsc
                ? 'Fullscreen. Esc works in game while fullscreen; hold Esc (or click FS) to leave. § also works as Esc.'
                : 'Fullscreen. In this browser Esc always leaves fullscreen: use § instead of Esc, '
                    + 'or use browser fullscreen, where Esc stays in game: F11 (on laptops often Fn + F11), '
                    + 'or the ⤢ button in the browser menu (☰). Leave it the same way.';
        }
        if (canLockEsc) {
            if (isNativeFullscreen) keyboard.lock(['Escape']).catch(() => { });
            else if (typeof keyboard.unlock === 'function') keyboard.unlock();
        }
        window.dispatchEvent(new Event('resize'));
    }
    document.addEventListener('fullscreenchange', syncFullscreenUi);
    if (btnFs) {
        btnFs.addEventListener('click', () => {
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => { });
                return;
            }
            let root = document.documentElement;
            if (root && root.requestFullscreen) {
                root.requestFullscreen().catch(() => {
                    appFullscreen = false;
                    document.body.classList.remove('app-fullscreen');
                    btnFs.textContent = '\u26F6 FS';
                    window.dispatchEvent(new Event('resize'));
                });
            } else {
                appFullscreen = false;
                document.body.classList.remove('app-fullscreen');
                btnFs.textContent = '\u26F6 FS';
                window.dispatchEvent(new Event('resize'));
            }
        });
        syncFullscreenUi();
    }

    const btnView2d = document.getElementById('btn-view-2d');
    const btnView3d = document.getElementById('btn-view-3d');
    if (btnView2d) btnView2d.addEventListener('click', () => setRenderDimensionMode('2d'));
    if (btnView3d) btnView3d.addEventListener('click', () => setRenderDimensionMode('3d'));
    for (const id of ['btn-view-2d5', 'btn-view-3d5']) {
        const b = document.getElementById(id);
        if (b) b.addEventListener('click', () => setRenderDimensionMode(b.dataset.viewMode));
    }
    syncRenderModeUi();

    const btnLevelVisibility = document.getElementById('btn-level-visibility');
    if (btnLevelVisibility) {
        updateLevelVisibilityButton();
        btnLevelVisibility.addEventListener('change', () => {
            levelVisibilityMode = Number(btnLevelVisibility.value);
            saveUiSettingsToStorage(); applyVisualSettingChange();
        });
    }

    const rangeTeam = document.getElementById('setting-range-team');
    if (rangeTeam) {
        rangeTeam.value = renderRangeAllTeam ? 'team' : 'selected';
        rangeTeam.addEventListener('change', () => { renderRangeAllTeam = rangeTeam.value === 'team'; saveUiSettingsToStorage(); applyVisualSettingChange(); });
    }
    const rangeThrough = document.getElementById('setting-range-through');
    if (rangeThrough) {
        rangeThrough.value = String(renderRangeSeeThrough);
        rangeThrough.addEventListener('change', () => { renderRangeSeeThrough = rangeThrough.value === 'true'; saveUiSettingsToStorage(); applyVisualSettingChange(); });
    }
    const btnRenderRange = document.getElementById('btn-render-range');
    if (btnRenderRange) {
        updateRenderRangeButton();
        btnRenderRange.addEventListener('change', () => {
            renderRangeMode = Number(btnRenderRange.value);
            saveUiSettingsToStorage(); applyVisualSettingChange();
        });
    }

    const btnBuildPlaceMode = document.getElementById('btn-build-place-mode');
    if (btnBuildPlaceMode) {
        updateBuildPlacementModeButton();
        btnBuildPlaceMode.addEventListener('click', () => {
            cycleBuildPlacementMode();
        });
    }

    const btnDefaultBuild = document.getElementById('btn-default-build');
    if (btnDefaultBuild) {
        btnDefaultBuild.addEventListener('click', () => {
            defaultAutoBuildEnabled = !defaultAutoBuildEnabled;
            updateDefaultToggleButtons();
        });
    }

    const btnDefaultAutoUpgrade = document.getElementById('btn-default-auto-upgrade');
    if (btnDefaultAutoUpgrade) {
        btnDefaultAutoUpgrade.addEventListener('click', () => {
            defaultAutoUpgradeEnabled = !defaultAutoUpgradeEnabled;
            updateDefaultToggleButtons();
        });
    }

    const btnIgnoreLevel = document.getElementById('btn-ignore-level');
    if (btnIgnoreLevel) {
        btnIgnoreLevel.addEventListener('click', () => {
            ignoreLevelSubgroups = !ignoreLevelSubgroups;
            updateIgnoreLevelButton();
            activeSubGroups = {};
            updateInfoPanel();
        });
    }
    updateDefaultToggleButtons();
    updateIgnoreLevelButton();
    updatePurchaseMultiplierBars();

    const btnHelp = document.getElementById('btn-help');
    const btnHelpClose = document.getElementById('btn-help-close');
    const btnResearchClose = document.getElementById('btn-research-close');
    const btnOpenStartingResources = document.getElementById('btn-open-starting-resources');
    const btnStartingResourcesClose = document.getElementById('btn-starting-resources-close');
    const btnOpenOptimization = document.getElementById('btn-open-optimization');
    const btnOptimizationClose = document.getElementById('btn-optimization-close');
    const btnOpenConfig = document.getElementById('btn-open-config');
    const btnConfigClose = document.getElementById('btn-config-close');
    const btnConfigApply = document.getElementById('btn-config-apply');
    const btnConfigReset = document.getElementById('btn-config-reset');
    const btnExportSettings = document.getElementById('btn-export-settings');
    initSoloSnapshotControls();
    const btnImportSettings = document.getElementById('btn-import-settings');
    const inputImportSettings = document.getElementById('input-import-settings');
    const btnShowStatsMap = document.getElementById('btn-show-statsmap');
    const btnRefreshStatsMap = document.getElementById('btn-refresh-statsmap');
    const btnStatsMapClose = document.getElementById('btn-statsmap-close');
    const btnResearchMatrixClose = document.getElementById('btn-research-matrix-close');
    const btnUnitStateHelpClose = document.getElementById('btn-unit-state-help-close');
    const helpPopup = document.getElementById('help-popup');
    const unitStateHelpPopup = document.getElementById('unit-state-help-popup');
    const researchPopup = document.getElementById('research-popup');
    const startingResourcesPopup = document.getElementById('starting-resources-popup');
    const statsMapPopup = document.getElementById('statsmap-popup');
    const researchMatrixPopup = document.getElementById('research-matrix-popup');
    const optimizationPopup = document.getElementById('optimization-popup');
    const configPopup = document.getElementById('config-popup');
    const btnResign = document.getElementById('btn-resign');
    const goBtnSpectate = document.getElementById('go-btn-spectate');
    const goBtnGraph = document.getElementById('go-btn-graph');
    const goBtnPlayAgain = document.getElementById('go-btn-play-again');
    const goGraphWrap = document.getElementById('go-graph-wrap');
    if (btnHelp) {
        btnHelp.addEventListener('click', () => {
            setHelpPopupOpen(true);
        });
    }
    if (btnShowStatsMap) {
        btnShowStatsMap.addEventListener('click', () => {
            setStatsMapPopupOpen(true);
        });
    }
    if (btnOpenStartingResources) {
        btnOpenStartingResources.addEventListener('click', () => {
            setStartingResourcesPopupOpen(true);
        });
    }
    if (btnOpenOptimization) {
        btnOpenOptimization.addEventListener('click', () => {
            setOptimizationPopupOpen(true);
        });
    }
    if (btnOptimizationClose) {
        btnOptimizationClose.addEventListener('click', () => {
            setOptimizationPopupOpen(false);
        });
    }
    if (btnOpenConfig) {
        btnOpenConfig.addEventListener('click', () => {
            setConfigPopupOpen(true);
        });
    }
    if (btnConfigApply) {
        btnConfigApply.addEventListener('click', () => {
            applyConfigEditorChanges();
        });
    }
    if (btnConfigReset) {
        btnConfigReset.addEventListener('click', () => {
            resetConfigEditorToDefaults();
        });
    }
    if (btnConfigClose) {
        btnConfigClose.addEventListener('click', () => {
            setConfigPopupOpen(false);
        });
    }
    if (btnStartingResourcesClose) {
        btnStartingResourcesClose.addEventListener('click', () => {
            setStartingResourcesPopupOpen(false);
        });
    }
    if (btnExportSettings) {
        btnExportSettings.addEventListener('click', () => {
            showExportOptions(btnExportSettings, downloadMainMenuSettings);
        });
    }
    if (btnImportSettings && inputImportSettings) {
        btnImportSettings.addEventListener('click', () => {
            inputImportSettings.value = '';
            let opened = false;
            if (typeof inputImportSettings.showPicker === 'function') {
                try {
                    inputImportSettings.showPicker();
                    opened = true;
                } catch { }
            }
            if (!opened) inputImportSettings.click();
        });
        inputImportSettings.addEventListener('change', () => {
            let file = inputImportSettings.files && inputImportSettings.files[0] ? inputImportSettings.files[0] : null;
            importMainMenuSettingsFromFile(file);
        });
    }
    if (btnRefreshStatsMap) {
        btnRefreshStatsMap.addEventListener('click', () => {
            refreshStatsMapPopupText();
        });
    }
    if (btnResign) {
        btnResign.addEventListener('click', () => {
            let el = document.getElementById('game-over');
            if (gameOver) {
                if (spectateMode === 'postgame' && el && el.style.display === 'none') {
                    el.style.display = 'flex';
                }
                return;
            }
            if (!gameStarted || localDefeated) return;
            if (!confirm('Resign and become a spectator?')) return;
            resignLocalPlayer();
        });
    }
    if (goBtnSpectate) {
        goBtnSpectate.addEventListener('click', () => {
            if (!gameOver) return;
            enterSpectateMode('postgame');
            let el = document.getElementById('game-over');
            if (el) el.style.display = 'none';
        });
    }
    if (goBtnGraph) {
        goBtnGraph.addEventListener('click', () => {
            if (!goGraphWrap) return;
            goGraphWrap.style.display = goGraphWrap.style.display === 'none' ? 'block' : 'none';
            if (goGraphWrap.style.display !== 'none') renderGameGraph(graphMetric);
        });
    }
    if (goBtnPlayAgain) {
        goBtnPlayAgain.addEventListener('click', () => {
            if (!gameOver || !isHost || !isMultiplayer) return;
            hostPlayAgain();
        });
    }
    let goBtnRematch = document.getElementById('go-btn-rematch');
    if (goBtnRematch) {
        goBtnRematch.addEventListener('click', () => {
            if (!gameOver || !isMultiplayer) return;
            if (isHost) hostRematch();
            else guestToggleRematchVote();
        });
    }
    let goBtnMainMenu = document.getElementById('go-btn-main-menu');
    if (goBtnMainMenu) {
        goBtnMainMenu.addEventListener('click', () => {
            if (isMultiplayer && gameStarted && !gameOver && !confirm('Leave the match and return to the main menu?')) return;
            leaveMultiplayerToMainMenu('');
        });
    }
    syncNetAutoMenuState();
    document.querySelectorAll('.go-graph-metric').forEach(btn => {
        btn.addEventListener('click', () => {
            let metric = btn.dataset.metric || 'units';
            renderGameGraph(metric);
        });
    });
    if (btnHelpClose) {
        btnHelpClose.addEventListener('click', () => {
            setHelpPopupOpen(false);
        });
    }
    if (btnUnitStateHelpClose) {
        btnUnitStateHelpClose.addEventListener('click', () => {
            setUnitStateHelpPopupOpen(false);
        });
    }
    if (btnResearchClose) {
        btnResearchClose.addEventListener('click', () => {
            setResearchPopupOpen(false);
        });
    }
    if (btnStatsMapClose) {
        btnStatsMapClose.addEventListener('click', () => {
            setStatsMapPopupOpen(false);
        });
    }
    if (btnResearchMatrixClose) {
        btnResearchMatrixClose.addEventListener('click', () => {
            setResearchStatMatrixPopupOpen(false);
        });
    }
    if (helpPopup) {
        helpPopup.addEventListener('click', (e) => {
            let tabBtn = e.target.closest('.help-tab-btn');
            if (tabBtn && tabBtn.dataset.tab) setHelpTab(tabBtn.dataset.tab);
        });
        helpPopup.addEventListener('mousedown', (e) => {
            if (e.target === helpPopup) setHelpPopupOpen(false);
        });
    }
    if (unitStateHelpPopup) {
        unitStateHelpPopup.addEventListener('mousedown', (e) => {
            if (e.target === unitStateHelpPopup) setUnitStateHelpPopupOpen(false);
        });
    }
    if (researchPopup) {
        researchPopup.addEventListener('mousedown', (e) => {
            if (e.target === researchPopup) setResearchPopupOpen(false);
        });
    }
    if (startingResourcesPopup) {
        startingResourcesPopup.addEventListener('mousedown', (e) => {
            if (e.target === startingResourcesPopup) setStartingResourcesPopupOpen(false);
        });
    }
    if (statsMapPopup) {
        statsMapPopup.addEventListener('mousedown', (e) => {
            if (e.target === statsMapPopup) setStatsMapPopupOpen(false);
        });
    }
    if (researchMatrixPopup) {
        researchMatrixPopup.addEventListener('mousedown', (e) => {
            if (e.target === researchMatrixPopup) setResearchStatMatrixPopupOpen(false);
        });
    }
    if (optimizationPopup) {
        optimizationPopup.addEventListener('mousedown', (e) => {
            if (e.target === optimizationPopup) setOptimizationPopupOpen(false);
        });
    }
    if (configPopup) {
        configPopup.addEventListener('mousedown', (e) => {
            if (e.target === configPopup) setConfigPopupOpen(false);
        });
    }

    ensureDefaultEditableRuntimeConfigSnapshot();

    // Minimap toggle
    const btnMap = document.getElementById('btn-minimap');
    const mapCont = document.getElementById('minimap-container');
    const statsCont = document.getElementById('shop-stats-container');
    if (btnMap && mapCont) {
        btnMap.addEventListener('click', () => {
            let isCollapsed = btnMap.innerText === '\u25B2';
            btnMap.innerText = isCollapsed ? '\u25BC' : '\u25B2';
            let showPanel = btnMap.innerText === '\u25BC';
            mapCont.style.display = showPanel ? 'block' : 'none';
            if (statsCont) statsCont.style.display = 'none';
        });
    }

    // Touch events for gameArea
    let activeTouches = {};
    let touchDistInitial = 0;
    let touchCenterInitial = null;
    let cameraZoomInitial = 1;
    let cameraXInitial = 0;
    let cameraYInitial = 0;
    let singleTouchId = null;
    let longPressTimer = null;
    let longPressFired = false;
    let touchStartX = 0;
    let touchStartY = 0;

    gameArea.addEventListener('touchstart', (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            activeTouches[e.changedTouches[i].identifier] = e.changedTouches[i];
        }
        let keys = Object.keys(activeTouches);

        if (keys.length === 1) {
            let t = activeTouches[keys[0]];
            singleTouchId = t.identifier;
            longPressFired = false;
            touchStartX = t.clientX;
            touchStartY = t.clientY;

            let syntheticDown = new MouseEvent('mousedown', { button: 0, clientX: t.clientX, clientY: t.clientY });
            gameArea.dispatchEvent(syntheticDown);

            if (longPressRallyEnabled) {
                longPressTimer = setTimeout(() => {
                    longPressTimer = null;
                    longPressFired = true;
                    isBoxSelecting = false;
                    selectionBox = null;
                    let syntheticRight = new MouseEvent('mousedown', { button: 2, clientX: t.clientX, clientY: t.clientY });
                    gameArea.dispatchEvent(syntheticRight);
                }, 300);
            }
        } else if (keys.length === 2) {
            if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
            isBoxSelecting = false;
            selectionBox = null;
            let t1 = activeTouches[keys[0]], t2 = activeTouches[keys[1]];
            let dx = t1.clientX - t2.clientX;
            let dy = t1.clientY - t2.clientY;
            touchDistInitial = detHypot(dx, dy);
            touchCenterInitial = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
            cameraZoomInitial = camera.zoom;
            cameraXInitial = camera.x;
            cameraYInitial = camera.y;
        }
    }, { passive: false });

    gameArea.addEventListener('touchmove', (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            activeTouches[e.changedTouches[i].identifier] = e.changedTouches[i];
        }
        let keys = Object.keys(activeTouches);

        if (keys.length === 1 && keys[0] == singleTouchId) {
            let t = activeTouches[keys[0]];

            if (longPressTimer) {
                let limit = Math.min(gameArea.clientWidth, gameArea.clientHeight) * 0.10;
                let dx = t.clientX - touchStartX;
                let dy = t.clientY - touchStartY;
                if (detHypot(dx, dy) > limit) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
            }

            if (!longPressFired) {
                let syntheticMove = new MouseEvent('mousemove', { clientX: t.clientX, clientY: t.clientY });
                gameArea.dispatchEvent(syntheticMove);
            }
        } else if (keys.length === 2 && touchCenterInitial) {
            let t1 = activeTouches[keys[0]], t2 = activeTouches[keys[1]];
            let dx = t1.clientX - t2.clientX;
            let dy = t1.clientY - t2.clientY;
            let dist = detHypot(dx, dy);
            let cx = (t1.clientX + t2.clientX) / 2;
            let cy = (t1.clientY + t2.clientY) / 2;

            // Zoom
            let zoomRatio = dist / touchDistInitial;
            let minZoom = getMinCameraZoom();
            camera.zoom = Math.max(minZoom, Math.min(MAX_CAMERA_ZOOM, cameraZoomInitial * zoomRatio));

            if (renderDimensionMode !== '3d') {
                // Keep 2D pinch zoom centered on the gesture focus.
                let rect = gameArea.getBoundingClientRect();
                let worldBeforeX = cameraXInitial + (touchCenterInitial.x - rect.left) / cameraZoomInitial;
                let worldBeforeY = cameraYInitial + (touchCenterInitial.y - rect.top) / cameraZoomInitial;

                camera.x = worldBeforeX - (cx - rect.left) / camera.zoom;
                camera.y = worldBeforeY - (cy - rect.top) / camera.zoom;
            }

            clampCamera();
        }
    }, { passive: false });

    gameArea.addEventListener('touchend', (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            delete activeTouches[e.changedTouches[i].identifier];
        }
        let keys = Object.keys(activeTouches);

        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

        if (keys.length === 0) {
            if (!longPressFired) {
                let t = e.changedTouches[0];
                let syntheticUp = new MouseEvent('mouseup', { button: 0, clientX: t.clientX, clientY: t.clientY });
                gameArea.dispatchEvent(syntheticUp);
            }

            touchCenterInitial = null;
            singleTouchId = null;
            longPressFired = false;
        }
    }, { passive: false });

    gameArea.addEventListener('touchcancel', (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            delete activeTouches[e.changedTouches[i].identifier];
        }
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        isBoxSelecting = false;
        selectionBox = null;
        touchCenterInitial = null;
        singleTouchId = null;
        longPressFired = false;
    }, { passive: false });

    let longPressToggle = document.getElementById('setting-long-press');
    if (longPressToggle) {
        longPressToggle.checked = longPressRallyEnabled;
        longPressToggle.addEventListener('change', (e) => {
            longPressRallyEnabled = e.target.checked;
        });
    }
}

// Shared group path searches (one reverse search per destination) are
// limited per player per tick; groups over the limit wait as pending paths
// and are routed on the next ticks by the deferred resolver, in order. A
// many-point rally of a big army is then spread over a few ticks instead of
// one very long tick.
const GROUP_PATH_SEARCHES_PER_PLAYER_TICK = 2;
// A unit waits at most this many ticks for its group's shared search, then
// searches on its own (u._awaitGroupPath holds the tick it waits until).
const GROUP_PATH_WAIT_TICKS = 20;
let _groupPathSearchTick = -1;
let _groupPathSearchesByPlayer = new Map();

// Commands are processed before gameTick advances gameTime; the resolver runs
// after (inTick): both count against the same tick.
function _takeGroupPathSearch(playerId, inTick = false) {
    let tick = inTick ? gameTime - 1 : gameTime;
    if (_groupPathSearchTick !== tick) { _groupPathSearchTick = tick; _groupPathSearchesByPlayer.clear(); }
    let used = _groupPathSearchesByPlayer.get(playerId) || 0;
    if (used >= GROUP_PATH_SEARCHES_PER_PLAYER_TICK) return false;
    _groupPathSearchesByPlayer.set(playerId, used + 1);
    return true;
}

// Whether a unit on tile (gx, gy) can walk into path region `region`: its
// tile is in it, or (standing on a blocked tile, which it may leave) a
// neighbouring tile is.
function _pathStartInRegion(labels, region, gx, gy) {
    let k = gy * GRID_W + gx, l = labels[k];
    if (l >= 0) return l === region;
    return (gx > 0 && labels[k - 1] === region) || (gx < GRID_W - 1 && labels[k + 1] === region)
        || (gy > 0 && labels[k - GRID_W] === region) || (gy < GRID_H - 1 && labels[k + GRID_W] === region);
}

// Units by id with their index in the units array, rebuilt when the array
// changed: actions look up their selected units instead of scanning every
// unit per action.
// Units by id, kept as the list changes (a unit added: unitSlotMapPushed;
// removed: the dead-unit pass, eliminateTeamAssets) and made anew when the
// list is replaced (a new match, a restore). It may still hold a unit that
// died (callers skip dead ones), never one of another list.
// IDs are mostly consecutive. A hash-table entry for every unit costs far
// more than a reference in a small page (and growing a multi-million-entry
// Map temporarily keeps both tables). Empty pages are released on death;
// widely separated IDs allocate only their own pages.
class UnitIdIndex {
    constructor() { this.pages = new Map(); this.size = 0; this.lastKey = NaN; this.lastPage = undefined; }
    get(id) {
        if (!Number.isSafeInteger(id)) return undefined;
        const key = Math.floor(id / 1024);
        const page = key === this.lastKey ? this.lastPage : (this.lastPage = this.pages.get(this.lastKey = key));
        return page ? page.values[id - key * 1024] : undefined;
    }
    set(id, unit) {
        const key = Math.floor(id / 1024), offset = id - key * 1024;
        let page = key === this.lastKey ? this.lastPage : this.pages.get(key);
        if (!page) { page = { values: new Array(1024).fill(undefined), count: 0 }; this.pages.set(key, page); }
        this.lastKey = key; this.lastPage = page;
        if (page.values[offset] === undefined) { page.count++; this.size++; }
        page.values[offset] = unit;
        return this;
    }
    delete(id) {
        if (!Number.isSafeInteger(id)) return false;
        const key = Math.floor(id / 1024), page = this.pages.get(key), offset = id - key * 1024;
        if (!page || page.values[offset] === undefined) return false;
        page.values[offset] = undefined; this.size--;
        if (--page.count === 0) { this.pages.delete(key); if (this.lastKey === key) this.lastPage = undefined; }
        return true;
    }
}
let _unitById = new UnitIdIndex(), _unitByIdFor = null;
function _unitByIdMap() {
    // (The page beside a simulation worker: its units are the frame's views,
    // kept by id as frames come. A map made here was made again after every
    // birth or death: 600k entries.)
    if (typeof simClientCurrentUnitVis === 'function' && simClientCurrentUnitVis()) return _pageUnitsById;
    // (Kept as units are added and retired; a unit put into the list another
    // way (tools, tests) shows as a size that does not match: made again.)
    if (_unitByIdFor !== units || _unitById.size !== units.length) {
        _unitById = new UnitIdIndex();
        for (let i = 0; i < units.length; i++) { const u = units[i]; if (u) _unitById.set(u.id, u); }
        _unitByIdFor = units;
    }
    return _unitById;
}
function unitByIdAdded(u) { if (_unitByIdFor === units && u) _unitById.set(u.id, u); }
function unitByIdRemoved(u) { if (_unitByIdFor === units && u && _unitById.get(u.id) === u) _unitById.delete(u.id); }
function getUnitById(id) {
    const u = _unitByIdMap().get(id);
    return u === undefined ? null : u;
}
// An action's selected units that exist, in the units array's order (the
// list is in id order: units are added with rising ids and removed in
// place, and a restore keeps the order).
function _actionUnits(a) {
    const map = _unitByIdMap(), out = [];
    for (let id of (a.unitIdSet || new Set(a.unitIds || []))) {
        const u = map.get(id);
        if (u !== undefined) out.push(u);
    }
    return _unitsInIdOrder(out);
}
// (Selections are mostly in id order already: sorted only when not.)
function _unitsInIdOrder(list) {
    for (let i = 1; i < list.length; i++) if (list[i - 1].id > list[i].id) { list.sort((x, y) => x.id - y.id); break; }
    return list;
}

// The units of a move order: the destination's flow, each following it
// from its columns. Units that cannot reach it (another component of the
// navigation: O(1) a unit) head for the closest tile they can reach,
// their order kept (a pending target, _makeFallbackPathForUnit).
// (members: the units, their tiles from their positions: no object per
// unit, a click's 158k of them made garbage enough for several scavenges.)
const NAV_GROUP_MIN = 8;
// Move orders written straight to the unit columns (see _issueGroupMoveOrder;
// off: every unit through its setters, for checks: tests/order-fast.test.cjs).
let _ordFastOn = true;
// (The digest keys of the fields an order sets.)
let _ordK = null;
function _ordKeys() {
    if (_ordK) return _ordK;
    const k = _simHKey;
    _ordK = { ppt: k('_pendingPathTarget'), pfa: k('pathIsFallbackAstar') };
    _ordK.pptNull = _simHTerm(_ordK.ppt, null); _ordK.pfaFalse = _simHTerm(_ordK.pfa, false);
    return _ordK;
}
// (A digest field set to v, its term tv: the digest's change.)
function _ordSet(a, s, key, v, tv) { const o = a.set(s, v); if (o === v) return 0; return (tv - _simHTerm(key, o)) | 0; }
// A move order's first writes to a unit of the columns (no worker, so its
// command is the order's), as targetUnit = null ... _pendingPathTarget =
// null, pathIsFallbackAstar = false make them. Its route key is set with
// its route (_issueFlowOrder).
function _ordClearFast(c, s, K, cmd, amGx, amGy, tAmx, tAmy, targetPos, tTp) {
    let h = c.hObj[s];
    c.tuS[s] = -1; c.tuId[s] = 0; c.tbT[s] = -1; c.acqB[s] = 0; c.fatF[s] = 0;
    c.fLsX[s] = NaN; c.fLsY[s] = NaN;
    if (c.commandState[s] !== cmd) { c.mvOn[s] = 0; c.commandState[s] = cmd; }
    c.amGx[s] = amGx === null ? -1 : amGx; c.amGy[s] = amGy === null ? -1 : amGy;
    c.mvTgX[s] = targetPos.x; c.mvTgY[s] = targetPos.y;
    c.j__awaitGroupPath.clear(s);
    h += _ordSet(c.jr__ppt, s, K.ppt, null, K.pptNull);
    h += _ordSet(c.jr__pfa, s, K.pfa, false, K.pfaFalse);
    c.mvPF[s] = 0;
    c.hObj[s] = h | 0;
}
// A group member's distance to its destination tile's middle (mvNavLD, as
// the movement kernel's flow look keeps it within 64 tiles; -1 further):
// set with the order, so its first look already sees whether it stands at
// its destination's crowd (the crowd scan stamps only units with one).
function _ordNavLD(c, s, destKey) {
    const dx = destKey % GRID_W, dy = (destKey - dx) / GRID_W, x = c.x[s] * 0.125, y = c.y[s] * 0.125;
    if (Math.abs(dx - Math.floor(x / TILE)) > 64 || Math.abs(dy - Math.floor(y / TILE)) > 64) return -1;
    const ex = dx * TILE + 16 - x, ey = dy * TILE + 16 - y;
    return Math.sqrt(ex * ex + ey * ey);
}
// (The members' route fields (path, pathIndex, _routeEnd, _routeSegEnd) are
// written here, once each: _issueGroupMoveOrder leaves them.)
function _issueFlowOrder(playerId, cmd, dest, members, applyPath, profile) {
    navEnsure(profile);
    const destTile = dest.y * GRID_W + dest.x;
    // (The destination's open tile: the flow's.)
    const to = navApproachTile(profile, dest.y * GRID_W + dest.x);
    let reachable = [], outliers = null;
    for (let u of members) (to >= 0 && navReachable(profile, Math.floor(u.y / TILE) * GRID_W + Math.floor(u.x / TILE), to) ? reachable : (outliers ||= [])).push(u);
    if (reachable.length) {
        dest = { x: to % GRID_W, y: (to - to % GRID_W) / GRID_W };
        // A group (NAV_GROUP_MIN units or more): the wide field, and its units
        // may arrive short of the tile in their own crowd; a few go all the
        // way (no crowd settling beside idle units of their own).
        const group = reachable.length >= NAV_GROUP_MIN;
        const destKey = to, did = navFieldRequest(profile, destKey, group), ready = navFieldReadyFor(did);
        // (One path for the order's units: paths are replaced, never changed
        // in place.)
        const navPath = [group ? { x: dest.x, y: dest.y, nav: profile + 1, w: 1, ready } : { x: dest.x, y: dest.y, nav: profile + 1, ready }];
        const K = _ordFastOn ? _ordKeys() : null, pk = ((profile * 16777216 + destKey) * 2) + (group ? 1 : 0);
        const flying = profile === NAV_PROFILE_AIR;
        for (let u of reachable) {
            const c = u._us, s = u._si;
            // (A unit of the columns, no worker: the setters' writes below, as
            // they make them, straight to its columns.)
            if (K && c && !c.jr__ws.get(s)) {
                c.rkF[s] = 1;
                c.rtEnd[s] = destKey; c.nvProf[s] = profile; c.j__navReady.set(s, ready);
                if (c.pathIndex[s] !== 0) { c.mvOn[s] = 0; c.pathIndex[s] = 0; }
                const at = Math.floor(c.y[s] * 0.125 / TILE) * GRID_W + Math.floor(c.x[s] * 0.125 / TILE) === destKey;
                c.nvPK[s] = at ? -1 : pk;
                simUnitPathRelease(c, s);
                c.jr__path.set(s, at ? null : navPath);
                c.mvOn[s] = 0; c.mvCD[s] = -1;
                c.j__routeSegEnd.set(s, at ? -1 : destKey);
                c.mvNavLD[s] = group && !at ? _ordNavLD(c, s, destKey) : -1;
                if (!at && did >= 0) simFlowArm(c, s, did, navFieldGen(did), destKey, cmd, flying, ready, !group, 0, profile);
                // (A group's unit on the destination tile has arrived: only lone
                // units and workers go to its middle.)
                if (at && group) simFlowArrive(u);
                continue;
            }
            u._routeKey = NAV_ROUTE_KEY; u._routeEnd = destKey; u._navReady = ready; u.pathIndex = 0;
            if (Math.floor(u.y / TILE) * GRID_W + Math.floor(u.x / TILE) === destKey) { u.path = null; u._routeSegEnd = -1; if (u._us) u._us.mvNavLD[u._si] = -1; if (group && !u.workerState) simFlowArrive(u); continue; }
            // Its way: one nav node to the end (as continueUnitRoute gives),
            // walked by the kernel from its columns.
            u.path = navPath; u._routeSegEnd = destKey;
            if (u._us) u._us.mvNavLD[u._si] = group && !u.workerState ? _ordNavLD(u._us, u._si, destKey) : -1;
            // (A worker goes all the way and is looked at on its check ticks,
            // as simMoveTryArm arms it.)
            if (did >= 0) simFlowArm(u._us, u._si, did, navFieldGen(did), destKey, u.workerState ? CMD_MOVING : cmd, profile === NAV_PROFILE_AIR, ready, !!u.workerState || !group, _simWorkerKind(u), profile);
        }
    }
    if (outliers) for (let u of outliers) {
        // (Off any earlier flow: the fast pass, _ordClearFast, leaves it.)
        u._routeKey = null;
        const ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
        u._routeSegEnd = -1; u._routeEnd = destTile;
        applyPath(u, ugx, ugy, null);
    }
}

// Move and attack-move orders: every unit on the destination's flow (the
// flow navigation; flying ones on the air one); a unit the kernel cannot
// arm (held, not indexed) a nav node of its own (Unit.update follows it).
// No search: O(1) a unit. Unit order and every tie-break are deterministic.
// The order's units by the kernel (SIM_KERNEL_ORDER_MOVE): their slots, the
// slots it leaves to the JavaScript, per job. (Off: every unit by the
// JavaScript below, as before.)
let ORDER_KERNEL = true;
const ORDER_KERNEL_PER_JOB = 16384;
let _ordSlots = null, _ordOut = null, _ordCnt = null;
// (Returns how many units the JavaScript took: the budget's measure, the
// kernel's a fraction of it, see _runQueuedOrders.)
function _issueGroupMoveOrder(a, playerId, cmd) {
    let targetGx = Math.floor(a.targetX / TILE), targetGy = Math.floor(a.targetY / TILE);
    // (One target position for the order's units: never changed in place,
    // only replaced.)
    const targetPos = { x: targetGx * TILE + 16, y: targetGy * TILE + 16 };
    let list;
    const S = typeof _simUnitState !== 'undefined' ? _simUnitState : null;
    if (ORDER_KERNEL && S && a.distinct && !a.unitIdSet && a.unitIds.length >= 64 && typeof SIM_KERNEL_ORDER_MOVE === 'number' && typeof _simWasmOk === 'function' && _simWasmOk(_simParReg)) {
        list = _orderMoveByKernel(a, playerId, cmd, targetGx, targetGy, targetPos, S);
    } else if (a.distinct && !a.unitIdSet) {
        const map = _unitByIdMap();
        list = [];
        for (const id of a.unitIds) { const u = map.get(id); if (u !== undefined) list.push(u); }
        _unitsInIdOrder(list);
    } else list = _actionUnits(a);
    let applyPath = (u, ugx, ugy, path) => {
        if (path && path.length > 0) {
            u.path = path;
            u.pathIndex = (path.length > 1 && path[0].x === ugx && path[0].y === ugy) ? 1 : 0;
            u._pendingPathTarget = null;
        } else {
            u.path = _makeFallbackPathForUnit(u, ugx, ugy, targetGx, targetGy, u.workerState ? CMD_MOVING : cmd, 'player_commands');
            u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
        }
    };
    let flowDest = [null, null], flowMembers = [null, null];
    const K = _ordFastOn ? _ordKeys() : null, amGx = cmd === CMD_ATTACK_MOVING ? targetGx : null, amGy = cmd === CMD_ATTACK_MOVING ? targetGy : null;
    const tAmx = 0, tAmy = 0, tTp = 0;
    for (let u of list) {
        const c = u._us, s = u._si;
        // A unit of the columns, no worker, not held, indexed (the common
        // case): what the setters below write, straight to its columns, its
        // digest moved once (~25 accessor calls a unit were most of an
        // order's cost).
        if (K && c && c.owner[s] === playerId && c.dead[s] !== 1 && !c.jr__ws.get(s) && !c.oc_holdPosition.get(s) && c.spEpoch[s] === spatialEpoch) {
            _ordClearFast(c, s, K, cmd, amGx, amGy, tAmx, tAmy, targetPos, tTp);
            const ugx = Math.floor(c.x[s] * 0.125 / TILE), ugy = Math.floor(c.y[s] * 0.125 / TILE);
            const profile = navProfileOf(u);
            if (!flowDest[profile]) flowDest[profile] = findNearestWalkable(targetGx, targetGy, ugx, ugy, u);
            (flowMembers[profile] ||= []).push(u);
            continue;
        }
        if (u.owner !== playerId || u.dead) continue;
        u.targetUnit = null; u.targetBuilding = null; u.forcedAttackTarget = false;
        u._forcedTargetLastSeenX = null; u._forcedTargetLastSeenY = null;
        // (Workers only move: MANUAL_MOVE keeps them moving, set here at
        // once, as their flow is armed.)
        const ucmd = u.workerState ? CMD_MOVING : cmd;
        u.commandState = ucmd;
        // Attack-move resumes toward this tile after each engagement.
        u._attackMoveGx = ucmd === CMD_ATTACK_MOVING ? targetGx : null;
        u._attackMoveGy = ucmd === CMD_ATTACK_MOVING ? targetGy : null;
        if (u.workerState) interruptWorkerForManualMove(u);
        u.targetPos = targetPos;
        u._awaitGroupPath = 0;
        // Off any earlier flow (a route below sets it again).
        u._routeKey = null;
        let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
        // Units follow the destination's flow (in the movement kernel): no
        // path or search of their own. See simFlowArm. So do workers sent by
        // the player (MANUAL_MOVE: they arrive where the flow ends, as at a
        // path's end; a group route each, a reverse search over the map,
        // cost 30-120 ms a tick with a few thousand workers ordered around).
        if ((!u.workerState || u.workerState === 'MANUAL_MOVE') && !u.holdPosition && u._us && u._spatialEpoch === spatialEpoch) {
            // (By navigation profile: ground, air, a walk class: workers that
            // may walk over mines or their own buildings, navProfileOf.)
            let profile = navProfileOf(u);
            let fdest = flowDest[profile] || (flowDest[profile] = findNearestWalkable(targetGx, targetGy, ugx, ugy, u));
            u._pendingPathTarget = null; u.pathIsFallbackAstar = false;
            (flowMembers[profile] ||= []).push(u);
            continue;
        }
        let dest = findNearestWalkable(targetGx, targetGy, ugx, ugy, u);
        applyPath(u, ugx, ugy, _findPathForUnitTagged('player_commands', u, ugx, ugy, dest.x, dest.y, !!u.isFlying, null, u.owner));
    }
    for (let p = 0; p < flowMembers.length; p++) if (flowMembers[p]) _issueFlowOrder(playerId, cmd, flowDest[p], flowMembers[p], applyPath, p);
    return list.length;
}
// The kernel's part of a move order: the destination by each navigation (the
// ground's, the air's: from the order's first unit of each, as the JavaScript
// takes it), each unit's columns in parallel; returns the units it left, in
// the order's order (unit objects), for the JavaScript.
function _orderMoveByKernel(a, playerId, cmd, targetGx, targetGy, targetPos, S) {
    const c = S.columns, map = _unitByIdMap(), ids = a.unitIds, n = ids.length;
    if (!_ordSlots || _ordSlots.length < n) { _ordSlots = simSharedArray(Int32Array, simReserveCap(n, 16384)); _ordOut = simSharedArray(Int32Array, _ordSlots.length + ORDER_KERNEL_PER_JOB); simParallelBind('ord.slots', _ordSlots); simParallelBind('ord.out', _ordOut); }
    const jobs = Math.ceil(n / ORDER_KERNEL_PER_JOB);
    if (!_ordCnt || _ordCnt.length < jobs) { _ordCnt = simSharedArray(Int32Array, Math.max(64, jobs * 2)); simParallelBind('ord.cnt', _ordCnt); }
    const slots = _ordSlots, objs = [];
    // (Units not of the columns: the JavaScript's; their slot -1. The kernel's
    // own: off a group path's wait and any pending way or fallback path (their
    // digest fields, as _ordClearFast clears them: a fight's army had a tenth
    // of its units waiting for a way, each left to the JavaScript).)
    const first = [-1, -1], count = [0, 0], layer = S.sepLayer, ppt = c.jr__ppt, pfa = c.jr__pfa, wait = c.j__awaitGroupPath, K = _ordKeys();
    for (let i = 0; i < n; i++) {
        const u = map.get(ids[i]);
        if (u === undefined || u._us !== c || !(u._si >= 0)) { slots[i] = -1; if (u !== undefined) objs.push(u); continue; }
        const s = u._si;
        slots[i] = s;
        if (c.owner[s] !== playerId || c.dead[s] === 1 || c.isWk[s] !== 0) continue;
        if (c.holdF[s] === 0 && c.spEpoch[s] === spatialEpoch && (ppt.get(s) != null || pfa.get(s))) {
            let h = c.hObj[s];
            h += _ordSet(ppt, s, K.ppt, null, K.pptNull);
            h += _ordSet(pfa, s, K.pfa, false, K.pfaFalse);
            c.hObj[s] = h | 0; c.mvPF[s] = 0;
        }
        wait.clear(s);
        const prof = layer[s] === 1 ? 1 : 0;
        count[prof]++;
        if (first[prof] < 0) first[prof] = s;
    }
    // (Each navigation's destination: as _issueFlowOrder's, from its first
    // unit's tile; -1 none: those units the JavaScript's.)
    const dest = [-1, -1], wide = [0, 0];
    for (let p = 0; p < 2; p++) {
        if (first[p] < 0) continue;
        const profile = p === 1 ? NAV_PROFILE_AIR : NAV_PROFILE_GROUND, s = first[p];
        navEnsure(profile);
        const u = S.owners[s], ugx = Math.floor(c.x[s] * 0.125 / TILE), ugy = Math.floor(c.y[s] * 0.125 / TILE);
        const fd = findNearestWalkable(targetGx, targetGy, ugx, ugy, u);
        const to = navApproachTile(profile, fd.y * GRID_W + fd.x);
        if (to < 0) continue;
        dest[p] = to;
        // (A group: the order's units of it, NAV_GROUP_MIN or more.)
        wide[p] = count[p] >= NAV_GROUP_MIN ? 1 : 0;
        navFieldRequest(profile, to, wide[p] === 1);
    }
    const P = _simParams;
    P[0] = n; P[1] = ORDER_KERNEL_PER_JOB; P[2] = playerId; P[3] = cmd;
    P[4] = cmd === CMD_ATTACK_MOVING ? targetGx : -1; P[5] = cmd === CMD_ATTACK_MOVING ? targetGy : -1;
    P[6] = targetPos.x; P[7] = targetPos.y; P[8] = spatialEpoch; P[9] = dest[0]; P[10] = dest[1]; P[11] = wide[0]; P[12] = wide[1];
    P[13] = GRID_W; P[14] = TILE;
    simParallelRun(SIM_KERNEL_ORDER_MOVE, jobs);
    // (The units it left: in the order's order, job by job.)
    for (let k = 0; k < jobs; k++) for (let i = k * ORDER_KERNEL_PER_JOB, e = i + _ordCnt[k]; i < e; i++) { const u = S.owners[_ordOut[i]]; if (u) objs.push(u); }
    return objs;
}

// Actions come from other players' machines. Malformed fields are dropped or
// clamped the same way on every peer, so a bad action can neither throw
// halfway, loop for long, nor act for another team.
const ACTION_MAX_COUNT = 100;
const LOCKSTEP_MAX_ACTIONS_PER_PACKET = 256;
// The match's commands only the host gives (worker.js queueHostAdminAction):
// a guest's are dropped (_hostSanitizeTickPacket); the host's go in its
// packet also while it does not play (maybeBuildHostBundle).
const HOST_ADMIN_ACTIONS = new Set(['forceResignTeam']);
const ACTION_MAX_UNIT_IDS = 20000;
const ACTION_MAX_TOWER_COORDS = 5000;
// Buildings per setRallyMany action (coords: gx, gy, ...).
const ACTION_MAX_RALLY_COORDS = 5000;

function _actionInt(v) {
    return (typeof v === 'number' && Number.isFinite(v)) ? Math.floor(v) : null;
}

function _actionNum(v) {
    return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

// Never a name objects inherit ('__proto__', 'constructor'...): these strings
// index lookup tables. A fixed list, not `in Object.prototype`, which differs
// between browsers and would make peers disagree.
const ACTION_RESERVED_STRINGS = new Set(['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'isPrototypeOf',
    'propertyIsEnumerable', 'toLocaleString', 'toString', 'valueOf', '__defineGetter__', '__defineSetter__',
    '__lookupGetter__', '__lookupSetter__', 'toSource', 'watch', 'unwatch']);

function _actionStr(v) {
    return (typeof v === 'string' && !ACTION_RESERVED_STRINGS.has(v)) ? v.slice(0, 64) : null;
}

// The action ids' stamps (sanitizeAction's duplicates), by unit id.
const ACTION_ID_STAMP_MAX = 1 << 26;
let _actionIdStamp = new Int32Array(1 << 16), _actionIdStampNow = 0;
function _actionIdStampNext() {
    if (++_actionIdStampNow >= 0x7fffffff) { _actionIdStamp.fill(0); _actionIdStampNow = 1; }
    return _actionIdStampNow;
}
function _actionIdStampGrow(id) {
    let n = _actionIdStamp.length;
    while (n <= id) n *= 2;
    const a = new Int32Array(Math.min(n, ACTION_ID_STAMP_MAX));
    a.set(_actionIdStamp);
    _actionIdStamp = a;
}

// Big orders' id loops warmed up (compiled, the id stamps grown) early in
// a match, not at its first big order: a click's 180k ids took ~30 ms cold
// (deopts and recompiles), ~5 warm. Fed as a packet's lists are (parsed:
// packed small integers): warmed on other shapes they deopted at the first
// real order. Peer-local scratch only (the order stamps' are a scratch
// table; seqs no order has, the supersede cache kept).
let _actionSanitizeWarm = false;
function actionSanitizeWarm() {
    if (_actionSanitizeWarm) return;
    _actionSanitizeWarm = true;
    const ids = JSON.parse(JSON.stringify(Array.from({ length: 5000 }, (_, i) => 3 + i * 61)));
    for (let k = 0; k < 16; k++) _actionCleanIds(ids);
    const T = { a: new Int32Array(1 << 12), m: null }, f = Float64Array.from(ids), sq = _orderSupSeq, se = _orderSupEntry;
    for (let k = 0; k < 16; k++) _orderStampIds(T, f, 0x7ffffff1 + k);
    _orderSupSeq = sq; _orderSupEntry = se;
}
// The distinct integer ids of a list in the order given, at most
// ACTION_MAX_UNIT_IDS (sanitizeAction: a stamp per id, no set of them).
function _actionCleanIds(ids) {
    const clean = [], now = _actionIdStampNext();
    let odd = null;
    for (let i = 0; i < ids.length && clean.length < ACTION_MAX_UNIT_IDS; i++) {
        const id = ids[i];
        if (!(typeof id === 'number' && Number.isInteger(id))) continue;
        if (id >= 0 && id < ACTION_ID_STAMP_MAX) {
            if (id >= _actionIdStamp.length) _actionIdStampGrow(id);
            if (_actionIdStamp[id] === now) continue;
            _actionIdStamp[id] = now;
        } else if ((odd || (odd = new Set())).has(id)) continue;
        else odd.add(id);
        clean.push(id);
    }
    return clean;
}
// An order's unit ids on the wire (`uidz`): per id its difference from the
// previous one (zigzag, times two, plus one when a run follows) and then, if
// so, how many more ids follow it one by one, as base-64 varints. The same ids in the same order; a big army's order was
// ~7 bytes an id (2-3 MB for 400k units, sent to every player).
const _UIDZ_ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const _UIDZ_VAL = (() => { const t = new Int8Array(128).fill(-1); for (let i = 0; i < 64; i++) t[_UIDZ_ABC.charCodeAt(i)] = i; return t; })();
// (Only plain non-negative integer ids; anything else stays a list.)
function actionIdsEncode(ids) {
    if (!Array.isArray(ids)) return null;
    for (let i = 0; i < ids.length; i++) { const v = ids[i]; if (!(Number.isInteger(v) && v >= 0 && v <= 0x7fffffff)) return null; }
    let out = '', prev = 0;
    const put = v => { while (v >= 32) { out += _UIDZ_ABC[32 | (v & 31)]; v = Math.floor(v / 32); } out += _UIDZ_ABC[v]; };
    for (let i = 0; i < ids.length;) {
        const id = ids[i], d = id - prev;
        let run = 0;
        while (i + 1 + run < ids.length && ids[i + 1 + run] === id + 1 + run) run++;
        put((d >= 0 ? d * 2 : -d * 2 - 1) * 2 + (run > 0 ? 1 : 0));
        if (run > 0) put(run - 1);
        prev = id + run;
        i += 1 + run;
    }
    return out;
}
// How many ids actionIdsDecode(s, max) gives, without the list (an order's
// cost: a run of ids is a few characters).
function actionIdsCount(s, max = ACTION_MAX_UNIT_IDS) {
    if (typeof s !== 'string') return 0;
    let pos = 0, prev = 0, n = 0;
    const get = () => {
        let v = 0, mul = 1;
        for (let k = 0; k < 8 && pos < s.length; k++) {
            const c = s.charCodeAt(pos++), x = c < 128 ? _UIDZ_VAL[c] : -1;
            if (x < 0) return -1;
            v += (x & 31) * mul;
            if (!(x & 32)) return v;
            mul *= 32;
        }
        return -1;
    };
    while (pos < s.length && n < max) {
        const zf = get();
        if (zf < 0) break;
        const z = Math.floor(zf / 2), run = zf % 2 ? get() + 1 : 0;
        if (run < 0) break;
        const id = prev + (z % 2 === 0 ? z / 2 : -(z + 1) / 2);
        if (!(id >= 0 && id <= 0x7fffffff)) break;
        n = Math.min(max, n + 1 + run);
        prev = id + run;
    }
    return n;
}
// Malformed or oversized input decodes to at most `max` ids (others' actions).
function actionIdsDecode(s, max = ACTION_MAX_UNIT_IDS) {
    const out = [];
    if (typeof s !== 'string') return out;
    let pos = 0, prev = 0;
    const get = () => {
        let v = 0, mul = 1;
        for (let k = 0; k < 8 && pos < s.length; k++) {
            const c = s.charCodeAt(pos++), x = c < 128 ? _UIDZ_VAL[c] : -1;
            if (x < 0) return -1;
            v += (x & 31) * mul;
            if (!(x & 32)) return v;
            mul *= 32;
        }
        return -1;
    };
    while (pos < s.length && out.length < max) {
        const zf = get();
        if (zf < 0) break;
        const z = Math.floor(zf / 2), run = zf % 2 ? get() + 1 : 0;
        if (run < 0) break;
        const id = prev + (z % 2 === 0 ? z / 2 : -(z + 1) / 2);
        if (!(id >= 0 && id <= 0x7fffffff)) break;
        out.push(id);
        for (let r = 1; r <= run && out.length < max; r++) out.push(id + r);
        prev = id + run;
    }
    return out;
}
function sanitizeAction(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.action !== 'string') return null;
    let a = { ...raw };
    // (Ids sent compactly: the list they stand for.)
    if (typeof a.uidz === 'string') { if (!Array.isArray(a.unitIds)) a.unitIds = actionIdsDecode(a.uidz); delete a.uidz; }
    for (let k of ['gx', 'gy', 'targetGx', 'targetGy']) if (k in a) a[k] = _actionInt(a[k]) ?? -1;
    // World positions stay on the map (paths and tiles are looked up there).
    if ('targetX' in a) { let v = _actionNum(a.targetX); a.targetX = v === null ? null : Math.max(0, Math.min(GRID_W * TILE - 1, v)); }
    if ('targetY' in a) { let v = _actionNum(a.targetY); a.targetY = v === null ? null : Math.max(0, Math.min(GRID_H * TILE - 1, v)); }
    for (let k of ['targetId', 'unitId', 'targetUnitId', 'targetTeam', 'unitLevel', 'fromIndex', 'toIndex']) if (k in a) a[k] = _actionInt(a[k]);
    for (let k of ['itemType', 'kind', 'key', 'statKey', 'targetType', 'mode', 'unitType']) if (k in a) a[k] = _actionStr(a[k]);
    if ('itemType' in a && !(a.itemType && Object.prototype.hasOwnProperty.call(BASE_CARD_TYPES, a.itemType))) a.itemType = null;
    if ('count' in a) a.count = Math.max(1, Math.min(ACTION_MAX_COUNT, _actionInt(a.count) ?? 1));
    // (Each id once, in the order given.)
    const clean = Array.isArray(a.unitIds) ? _actionCleanIds(a.unitIds) : [];
    a.unitIds = clean;
    // (Distinct now: the order queue takes them as they are.)
    Object.defineProperty(a, '_idsDistinct', { value: clean, enumerable: false, configurable: true });
    // Membership tests against every unit: a set, not a scan of the ids
    // (made at its first use: a move order needs none).
    Object.defineProperty(a, 'unitIdSet', {
        configurable: true, enumerable: false,
        get() { const set = new Set(this.unitIds); Object.defineProperty(this, 'unitIdSet', { value: set, writable: true, configurable: true }); return set; },
        set(v) { Object.defineProperty(this, 'unitIdSet', { value: v, writable: true, configurable: true }); }
    });
    if ('towerCoords' in a) {
        let coords = Array.isArray(a.towerCoords) ? a.towerCoords : [];
        a.towerCoords = [];
        for (let i = 0; i < coords.length && a.towerCoords.length < ACTION_MAX_TOWER_COORDS; i++) {
            let c = coords[i];
            let gx = c && _actionInt(c.gx), gy = c && _actionInt(c.gy);
            if (gx !== null && gy !== null) a.towerCoords.push({ gx, gy });
        }
    }
    if ('coords' in a) {
        let coords = Array.isArray(a.coords) ? a.coords : [];
        a.coords = [];
        for (let i = 0; i + 1 < coords.length && a.coords.length < 2 * ACTION_MAX_RALLY_COORDS; i += 2) {
            let gx = _actionInt(coords[i]), gy = _actionInt(coords[i + 1]);
            if (gx !== null && gy !== null) a.coords.push(gx, gy);
        }
    }
    if ('target' in a) {
        let t = a.target;
        a.target = (t && typeof t === 'object' && typeof t.type === 'string')
            ? { type: t.type, id: _actionInt(t.id), gx: _actionInt(t.gx) ?? -1, gy: _actionInt(t.gy) ?? -1 }
            : null;
    }
    return a;
}

// A tick's actions within a budget (ACTION_BUDGET_PER_TICK, by a cost per
// action: _actionCost, ~0.05 ms a unit of it); the rest wait in a backlog,
// in order, and go first the next tick (before its own actions; on a tick
// with none, at gameTick's start: actionBacklogTick). Every peer defers the
// same actions: the backlog is state (snapshotted and hashed with the
// globals). One player's burst, or several players' at once, never makes a
// tick of more than ~10 ms of actions (both teams' bursts in a chaos
// scenario were 10-22 ms on one tick). An action runs whole, but for unit
// orders whose units are each handled alone (ACTION_SPLIT_UNITS: an attack
// order paths every unit, ~5 us each; 20k units were ~90 ms): over the
// budget left, the units it pays for now (at least ACTION_SPLIT_MIN_UNITS),
// the rest as the same order at the backlog's front.
const ACTION_BUDGET_PER_TICK = 200;
const ACTION_SPLIT_UNITS = new Set(['attack', 'attackBuilding', 'hold', 'stop', 'killUnit']);
const ACTION_SPLIT_MIN_UNITS = 64;
// [now, later] of a unit order over `budget`, or null (it runs whole).
function _actionSplit(raw, budget) {
    if (!raw || !ACTION_SPLIT_UNITS.has(raw.action)) return null;
    const cost = _actionCost(raw);
    if (cost <= budget) return null;
    const ids = Array.isArray(raw.unitIds) ? raw.unitIds : (typeof raw.uidz === 'string' ? actionIdsDecode(raw.uidz) : null);
    if (!ids || ids.length <= ACTION_SPLIT_MIN_UNITS) return null;
    const base = _actionCost({ action: raw.action, unitIds: [] }), per = (cost - base) / ids.length;
    const k = Math.max(ACTION_SPLIT_MIN_UNITS, Math.floor((budget - base) / Math.max(1e-9, per)));
    if (k >= ids.length) return null;
    const part = from => { const o = {}; for (const key in raw) if (key !== 'uidz' && key !== 'unitIds' && key !== 'unitIdSet') o[key] = raw[key]; o.unitIds = from; return o; };
    return [part(ids.slice(0, k)), part(ids.slice(k))];
}
let _actionBacklog = [], _actionBudgetLeft = ACTION_BUDGET_PER_TICK;
function _actionCost(raw) {
    if (!raw || typeof raw !== 'object') return 1;
    const ids = Array.isArray(raw.unitIds) ? raw.unitIds.length : (typeof raw.uidz === 'string' ? actionIdsCount(raw.uidz) : 0);
    const coords = Array.isArray(raw.coords) ? raw.coords.length / 2 : (Array.isArray(raw.towerCoords) ? raw.towerCoords.length : 0);
    const count = Math.max(1, Math.min(ACTION_MAX_COUNT, Math.floor(Number(raw.count) || 1)));
    // (Measured in a chaos scenario: a unit of cost ~0.05 ms. Per kind, the
    // mega scenario's averages (ACTSPLIT): an attack order ~5 us a unit,
    // hold and stop ~1.5 us, a tower's target or a rally ~0.5 us.)
    switch (raw.action) {
        case 'move': case 'attackMove': return 2 + ids / 400;
        case 'attack': case 'attackBuilding': return 2 + ids / 12;
        case 'hold': case 'stop': return 1 + ids / 40;
        case 'killUnit': return 1 + ids / 300;
        case 'towerTarget': return 1 + coords / 100;
        case 'setRallyMany': return 1 + coords / 100;
        // (A task put in the queue's middle: its stat's tasks made again, ~0.2 ms.)
        case 'queueResearch': return 1 + (raw.insertAt !== undefined && raw.insertAt !== null ? 4 : 1) * count;
        // (The moved or removed tasks' stats made again: ~0.2-0.4 ms with 900
        // tasks queued.)
        case 'dequeueResearch': case 'moveResearch': case 'reorderResearch': return 8;
        case 'setBoost': return 15;
        case 'place': return count;
        default: return 1 + ids / 1000 + coords / 200;
    }
}
// Small actions given while a backlog waits go at once, ahead of it (a click
// on a few units right after ten clicks on a whole army waited out the army's
// backlog: seconds at 1 TPS; a building's placement waited past its ghost and
// seemed lost). Each action has its arrival (a sequence, state). Unit orders
// and rally changes may always go ahead: the units (or the buildings' tiles)
// such an action took are marked with its arrival, and an older action still
// waiting passes them over when its turn comes: the latest order wins as
// before. Any other small action goes ahead only of a backlog of unit orders
// and rallies alone (which it does not touch). The marks go once no older
// action waits.
const ACTION_JUMP_UNITS = new Set(['move', 'attackMove', 'attack', 'attackBuilding', 'stop', 'hold']);
const ACTION_JUMP_COST = 12;
// (Within an allowance a tick, as the budget's: a flood of small actions
// waits like any other.)
const ACTION_JUMP_BUDGET_PER_TICK = 48;
let _actionArrival = 0, _actionJumpLeft = ACTION_JUMP_BUDGET_PER_TICK;
function _actionMarked(raw) { return !!raw && (ACTION_JUMP_UNITS.has(raw.action) || raw.action === 'setRally' || raw.action === 'setRallyMany'); }
function _actionJumps(raw) {
    if (!raw) return false;
    const cost = _actionCost(raw);
    if (cost > ACTION_JUMP_COST || cost > _actionJumpLeft) return false;
    if (_actionMarked(raw)) return true;
    for (const e of _actionBacklog) if (!_actionMarked(e[1])) return false;
    return true;
}
// The latest unit order by arrival. While older actions wait, each unit
// order or rally change that arrives records itself as the latest for its
// units (or its buildings' tiles: rallies) at once (arrival + 1; 0 none), and
// each waiting one keeps how many of them it still is the latest for (its
// live count, made less as later ones take them; as the order queue's
// stamps). A waiting action whose units all were ordered again is passed
// over in O(1) when its turn comes, one with some ordered again applies to
// the rest: the latest order wins as before, but ten ctrl clicks on an army
// no longer process nine superseded orders' millions of ids ahead of the
// tenth (seconds at 1 TPS). In arrival order still (rallies, placements and
// unit orders keep their order), every peer alike. Dropped once no action
// waits.
let _actLatest = [], _actLive = new Map();
function _actLatestOf(p) { return _actLatest[p] || (_actLatest[p] = { u: { a: new Int32Array(1 << 12), m: null }, t: null }); }
// (Its units' ids or its buildings' tiles (tile index), as given: before
// the action is cleaned, any id it carries; an invalid one never matches.)
function _actionMarkKeys(raw) {
    if (ACTION_JUMP_UNITS.has(raw.action)) return { ids: Array.isArray(raw.unitIds) ? raw.unitIds : (typeof raw.uidz === 'string' ? actionIdsDecode(raw.uidz) : []), tiles: null };
    const c = raw.action === 'setRally' ? [raw.gx, raw.gy] : (Array.isArray(raw.coords) ? raw.coords : []), tiles = [];
    for (let k = 0; k + 1 < c.length; k += 2) { const x = c[k], y = c[k + 1]; if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < GRID_W && y < GRID_H) tiles.push(y * GRID_W + x); }
    return { ids: null, tiles };
}
function _actionRecordArrival(raw, p, seq, waits) {
    const L = _actLatestOf(p), mark = seq + 1, K = _actionMarkKeys(raw);
    let live = 0, lastS = -1, lastE = null;
    const dec = old => { if (old !== lastS) { lastS = old; lastE = _actLive.get(old - 1) || null; } if (lastE) lastE.live--; };
    if (K.ids) for (const id of K.ids) {
        if (!Number.isInteger(id)) continue;
        const old = _orderStampGet(L.u, id);
        if (old === mark) continue;
        if (old > 0) dec(old);
        _orderStampSet(L.u, id, mark); live++;
    }
    if (K.tiles) {
        const T = L.t || (L.t = new Int32Array(GRID_W * GRID_H));
        for (const k of K.tiles) { const old = T[k]; if (old === mark) continue; if (old > 0) dec(old); T[k] = mark; live++; }
    }
    if (waits) _actLive.set(seq, { live });
}
// (The keys an action recorded at its arrival is still the latest for.)
function _actionKeepLatest(a, p, seq) {
    const L = _actLatest[p], mark = seq + 1;
    if (!L) return true;
    if (ACTION_JUMP_UNITS.has(a.action)) {
        const ids = (a.unitIds || []).filter(id => _orderStampGet(L.u, id) === mark);
        a.unitIds = ids;
        Object.defineProperty(a, '_idsDistinct', { value: ids, enumerable: false, configurable: true });
        return ids.length > 0;
    }
    const T = L.t, c = a.action === 'setRally' ? [a.gx, a.gy] : (Array.isArray(a.coords) ? a.coords : []), keep = [];
    if (!T) return true;
    for (let k = 0; k + 1 < c.length; k += 2) if (T[c[k + 1] * GRID_W + c[k]] === mark) keep.push(c[k], c[k + 1]);
    if (a.action === 'setRally') return keep.length > 0;
    a.coords = keep;
    return keep.length > 0;
}
function _actionMarksClear() { if (_actLatest.length) _actLatest = []; if (_actLive.size) _actLive.clear(); }
// (In a snapshot: the arrival, the marks that waiting actions read (those
// of their arrivals and later: unit ids, tiles as -(tile + 1)), the live counts.)
function actionEarlySnapshot() {
    const marks = [], lives = [];
    let min = Infinity;
    for (const e of _actionBacklog) if (e[2] < min) min = e[2];
    if (_actionBacklog.length) for (let p = 0; p < _actLatest.length; p++) {
        const L = _actLatest[p];
        if (!L) continue;
        const A = L.u.a;
        for (let id = 0; id < A.length; id++) if (A[id] > min) marks.push(p, id, A[id]);
        if (L.u.m) for (const [id, s] of L.u.m) if (s > min) marks.push(p, id, s);
        if (L.t) for (let k = 0; k < L.t.length; k++) if (L.t[k] > min) marks.push(p, -(k + 1), L.t[k]);
    }
    for (const [s, v] of _actLive) lives.push(s, v.live);
    return { arrival: _actionArrival, marks, lives, v: 2 };
}
function actionEarlyRestore(v) {
    _actionArrival = v && Number.isFinite(v.arrival) ? v.arrival : 0;
    _actionMarksClear();
    if (!v || v.v !== 2) return;
    const m = Array.isArray(v.marks) ? v.marks : [], l = Array.isArray(v.lives) ? v.lives : [];
    for (let i = 0; i + 2 < m.length; i += 3) {
        const L = _actLatestOf(m[i] | 0), key = m[i + 1], s = m[i + 2] | 0;
        if (key >= 0) _orderStampSet(L.u, key, s);
        else { const T = L.t || (L.t = new Int32Array(GRID_W * GRID_H)); const k = -key - 1; if (k < T.length) T[k] = s; }
    }
    for (let i = 0; i + 1 < l.length; i += 2) _actLive.set(l[i] | 0, { live: l[i + 1] | 0 });
}
// (seq: its arrival, -1 unknown (an old snapshot's); recorded: its arrival
// recorded the latest marks (it waited, or went ahead of waiting ones): only
// what it still is the latest for.)
function _processRawAction(raw, playerId, seq = -1, recorded = false) {
    let a = sanitizeAction(raw);
    if (!a) return;
    if (recorded && seq >= 0 && _actionMarked(a) && !_actionKeepLatest(a, playerId, seq)) return;
    // One bad action must not take the rest of the tick's actions with
    // it (it throws the same way on every peer).
    try { processAction(a, playerId); } catch (err) { reportRuntimeError('action ' + a.action, err); }
}
function _actionBacklogDrain() {
    if (!_actionBacklog.length || _actionBudgetLeft <= 0) return;
    let i = 0;
    for (; i < _actionBacklog.length && _actionBudgetLeft > 0; i++) {
        const e = _actionBacklog[i], lv = _actLive.get(e[2]);
        // (Every unit of it ordered again since: passed over, nearly free.)
        if (lv && lv.live <= 0) { _actionBudgetLeft -= 1; _actLive.delete(e[2]); continue; }
        const split = _actionSplit(e[1], _actionBudgetLeft);
        if (split) {
            // (Its units paid for now; the rest stays first.)
            _actionBudgetLeft = 0;
            e[1] = split[1];
            _processRawAction(split[0], e[0], e[2], !!lv);
            break;
        }
        _actionBudgetLeft -= _actionCost(e[1]);
        _processRawAction(e[1], e[0], e[2], !!lv);
        if (lv) _actLive.delete(e[2]);
    }
    _actionBacklog.splice(0, i);
    if (!_actionBacklog.length) _actionMarksClear();
}
function processActions(actions, playerId) {
    if (!Array.isArray(actions)) return;
    const t0 = performance.now();
    try { _processActions(actions, playerId); } finally { simOrderStats.actionsMs += performance.now() - t0; }
}
function _processActions(actions, playerId) {
    _stepBudgets();
    // (The unit index built after the last tick, and what of it reads live
    // state, done before an action changes anything.)
    if (typeof spatialIndexPrebuildSettle === 'function') spatialIndexPrebuildSettle();
    _actionBacklogDrain();
    for (let raw of actions) {
        const seq = _actionArrival++, marked = _actionMarked(raw);
        if (_actionBacklog.length || _actionBudgetLeft <= 0) {
            const older = _actionBacklog.length > 0;
            // (A small unit order: now, ahead of those waiting.)
            if (_actionJumps(raw)) {
                const cost = _actionCost(raw); _actionBudgetLeft -= cost; _actionJumpLeft -= cost;
                if (marked && older) _actionRecordArrival(raw, playerId, seq, false);
                _processRawAction(raw, playerId, seq, marked && older);
                continue;
            }
            if (marked) _actionRecordArrival(raw, playerId, seq, true);
            _actionBacklog.push([playerId, raw, seq]); continue;
        }
        const split = _actionSplit(raw, _actionBudgetLeft);
        if (split) {
            if (marked) _actionRecordArrival(raw, playerId, seq, true);
            _actionBudgetLeft = 0; _actionBacklog.push([playerId, split[1], seq]); _processRawAction(split[0], playerId, seq, marked);
            continue;
        }
        _actionBudgetLeft -= _actionCost(raw);
        _processRawAction(raw, playerId, seq);
    }
}
// At gameTick's start: the backlog's share of a tick without actions, then
// the budget again for the next tick's.
function actionBacklogTick() {
    _stepBudgets();
    if (_actionBacklog.length && _actionBudgetLeft > 0) {
        if (typeof spatialIndexPrebuildSettle === 'function') spatialIndexPrebuildSettle();
        _actionBacklogDrain();
    }
    _actionBudgetLeft = ACTION_BUDGET_PER_TICK; _actionJumpLeft = ACTION_JUMP_BUDGET_PER_TICK;
}
function actionBacklogSnapshot() { return _actionBacklog.map(e => [e[0], e[1], e[2]]); }
function actionBacklogRestore(rows) {
    _actionBacklog = Array.isArray(rows) ? rows.filter(r => Array.isArray(r) && (r.length === 2 || r.length === 3)).map(r => [r[0] | 0, r[1], Number.isFinite(r[2]) ? r[2] : -1]) : [];
    _actionBudgetLeft = ACTION_BUDGET_PER_TICK; _actionJumpLeft = ACTION_JUMP_BUDGET_PER_TICK;
}
// (The state hash's share: each waiting action's player and content, in
// order (its kind and size alone, summed, missed a changed destination and
// a changed order: audit 2026-10-15). Each action's digest is made once.)
const _actionDigests = new WeakMap();
function _actionDigest(raw) {
    if (!raw || typeof raw !== 'object') return 0;
    let d = _actionDigests.get(raw);
    if (d !== undefined) return d;
    // (Its own fields as a snapshot carries them: not the ones processing
    // adds (_..., unitIdSet), which a restored copy lacks.)
    let h = 2166136261 | 0;
    for (const k of Object.keys(raw).sort()) {
        if (k.charCodeAt(0) === 95 || k === 'unitIdSet') continue;
        const v = raw[k];
        if (typeof v === 'function' || v === undefined) continue;
        h = _lsHashStr(h, k);
        h = _lsHashValue(Math.imul(h ^ 58, 16777619), v);
    }
    d = h | 0;
    _actionDigests.set(raw, d);
    return d;
}
function actionBacklogChecksum() {
    let h = Math.imul(_actionBacklog.length + 1, 2654435761) | 0;
    for (const [p, raw, seq] of _actionBacklog) {
        h = Math.imul(h ^ (p | 0), 16777619);
        h = Math.imul(h ^ _actionDigest(raw), 2246822519);
        h = Math.imul(h ^ (seq | 0), 16777619);
    }
    h = Math.imul(h ^ (_actionArrival | 0), 2246822519);
    // (The waiting actions' live counts: what the latest marks left them.)
    for (const [s, v] of _actLive) h = (h + Math.imul((s | 0) ^ Math.imul(v.live | 0, 2654435761), 16777619)) | 0;
    return h | 0;
}

// Move orders over many units are applied in slices: each player at most
// ORDER_UNITS_PER_PLAYER_TICK units a tick (a budget of its own: one
// player's huge order never slows another player's orders, nor a tick by
// more than its share), the rest queued and applied at the start of the next
// ticks in order. The first slice moves at once; a later order (or any
// other order) for a unit drops it from the queued ones, so the latest order
// always wins. The queue and the budgets are simulation state (snapshotted
// with the globals).
// (Once 2-2.5 us a unit, 2500 a tick; the columns' fast path and the order
// kernel made it ~0.4-0.5 us a unit (tests/test-runs/probe_workermove.cjs):
// 10000 a tick are ~5 ms, 200k units a second.)
let ORDER_UNITS_PER_PLAYER_TICK = 8000, ORDER_UNITS_PER_TICK_ALL = 10000, ORDER_UNITS_PER_ROUND = 2000;
// (A unit the order kernel takes costs a fraction of one the JavaScript does: 1/ORDER_KERNEL_GAIN.)
const ORDER_KERNEL_GAIN = 16;
let _orderQueue = [], _orderBudgets = [], _orderAllLeft = ORDER_UNITS_PER_TICK_ALL;
function _orderBudgetOf(p) { const b = _orderBudgets[p]; return b === undefined || b === null ? ORDER_UNITS_PER_PLAYER_TICK + _orderPlayerBonus : b; }
// A step of several base ticks (simDk): the budgets of its base ticks, the
// action and order rates a second as at one a step (added at the step's
// first use, simDk known then; every peer alike).
let _budgetStep = -1, _orderPlayerBonus = 0;
function _stepBudgets() {
    if (_budgetStep === currentTick) return;
    _budgetStep = currentTick;
    const k = simDk > 1 ? simDk - 1 : 0;
    _orderPlayerBonus = ORDER_UNITS_PER_PLAYER_TICK * k;
    if (!k) return;
    _actionBudgetLeft += ACTION_BUDGET_PER_TICK * k; _actionJumpLeft += ACTION_JUMP_BUDGET_PER_TICK * k;
    _orderAllLeft += ORDER_UNITS_PER_TICK_ALL * k;
}
// Per player, each unit's latest order (its queue entry's seq, or a drop's):
// a queued unit is applied only by the entry that ordered it last, so a new
// order supersedes the queued ones by stamping its own units (no pass over
// everything queued: ten ctrl-click orders over 56k queued units scanned
// 560k ids). Cleared when the queue empties. An applied unit's stamp is
// cleared (0), and each entry counts its units still to apply (live, less
// those ordered again since): an entry whose units were all ordered again
// is dropped at once, not walked id by id (a click's 158k superseded ids
// cost ~9 ms a tick).
let _orderSeq = 0, _unitOrderSeq = [], _orderBySeq = new Map();
// (A unit's stamp changing from `old`: that entry has one live unit less.
// The last entry looked up is kept: a new order's units mostly come from
// one earlier order.)
let _orderSupSeq = 0, _orderSupEntry = null;
function _orderStampSuperseded(old, id) {
    if (!(old > 0)) return;
    if (old !== _orderSupSeq) { _orderSupSeq = old; _orderSupEntry = _orderBySeq.get(old) || null; }
    if (_orderSupEntry) { _orderSupEntry.live--; _orderSupEntry.sum = (_orderSupEntry.sum - _orderIdH(id)) | 0; }
}
// (A queued unit's share of its entry's sum: the entry's units still to
// apply, order-free, kept as they are applied or ordered again; the state
// hash reads it, orderQueueChecksum.)
function _orderIdH(id) { const x = Math.imul((id | 0) ^ 0x5bd1e995, 2654435761); return (x ^ (x >>> 15)) | 0; }
function _orderIdsSum(ids) { let s = 0; for (let i = 0; i < ids.length; i++) s = (s + _orderIdH(ids[i])) | 0; return s; }
// (Per player: { a: Int32Array by unit id, m: Map for ids past it }.)
function _unitOrderSeqOf(p) { return _unitOrderSeq[p] || (_unitOrderSeq[p] = { a: new Int32Array(1 << 12), m: null }); }
function _orderStampSet(T, id, seq) {
    if (id >= 0 && id < ACTION_ID_STAMP_MAX) {
        if (id >= T.a.length) { let n = T.a.length; while (n <= id) n *= 2; const a = new Int32Array(Math.min(n, ACTION_ID_STAMP_MAX)); a.set(T.a); T.a = a; }
        T.a[id] = seq;
    } else (T.m || (T.m = new Map())).set(id, seq);
}
function _orderStampGet(T, id) {
    if (id >= 0 && id < ACTION_ID_STAMP_MAX) return id < T.a.length ? T.a[id] : 0;
    const v = T.m ? T.m.get(id) : undefined;
    return v === undefined ? 0 : v;
}
function _orderSeqNext() {
    if (_orderSeq >= 0x7ffffff0) { _unitOrderSeq = []; _orderSeq = 0; }
    return ++_orderSeq;
}
// An action's ids, each once in the order given (a set given with it: its order).
function _actionDistinctIds(a) {
    if (a._idsDistinct && a._idsDistinct === a.unitIds) return a.unitIds;
    const d = Object.getOwnPropertyDescriptor(a, 'unitIdSet');
    if (d && !d.get && d.value) return Array.from(d.value);
    const now = _actionIdStampNext(), out = [];
    let odd = null;
    for (const id of a.unitIds || []) {
        if (!(typeof id === 'number' && Number.isInteger(id))) continue;
        if (id >= 0 && id < ACTION_ID_STAMP_MAX) {
            if (id >= _actionIdStamp.length) _actionIdStampGrow(id);
            if (_actionIdStamp[id] === now) continue;
            _actionIdStamp[id] = now;
        } else if ((odd || (odd = new Set())).has(id)) continue;
        else odd.add(id);
        out.push(id);
    }
    return out;
}
function _dropQueuedOrderUnits(idSet, playerId) {
    if (!_orderQueue.length || !idSet || !idSet.size) return;
    const T = _unitOrderSeqOf(playerId), seq = _orderSeqNext();
    for (const id of idSet) { _orderStampSuperseded(_orderStampGet(T, id), id); _orderStampSet(T, id, seq); }
}
// An order's ids made their units' latest order (seq) in T (the entries
// ordering them before lose them).
function _orderStampIds(T, ids, seq) {
    // (The table grown once for the largest id; the common ids stamped inline.)
    let max = -1;
    for (let i = 0; i < ids.length; i++) { const id = ids[i]; if (id > max && id < ACTION_ID_STAMP_MAX) max = id; }
    if (max >= T.a.length) { let n = T.a.length; while (n <= max) n *= 2; const a = new Int32Array(Math.min(n, ACTION_ID_STAMP_MAX)); a.set(T.a); T.a = a; }
    const A = T.a;
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (id >= 0 && id < ACTION_ID_STAMP_MAX) {
            const old = A[id];
            if (old > 0) _orderStampSuperseded(old, id);
            A[id] = seq;
        } else { _orderStampSuperseded(_orderStampGet(T, id), id); _orderStampSet(T, id, seq); }
    }
}
function _orderWorkersLast(ids) {
    const S = typeof _simUnitState !== 'undefined' ? _simUnitState : null;
    if (!S) return ids;
    const map = _unitByIdMap(), c = S.columns, wk = c.isWk, out = new Float64Array(ids.length);
    let a = 0, b = 0, late = null;
    for (let i = 0; i < ids.length; i++) {
        const u = map.get(ids[i]), s = u !== undefined && u._us === c ? u._si : -1;
        if (s >= 0 && wk[s] !== 0) (late || (late = new Float64Array(ids.length)))[b++] = ids[i];
        else out[a++] = ids[i];
    }
    if (!late) return ids;
    out.set(late.subarray(0, b), a);
    return out;
}
function _queueGroupMoveOrder(a, playerId, cmd) {
    // (Each id once, in the order given (sanitizeAction); the units' latest
    // order now. Kept typed: queued ids are nothing for the collector to
    // trace.)
    let ids = Float64Array.from(_actionDistinctIds(a));
    const seq = _orderSeqNext(), T = _unitOrderSeqOf(playerId);
    // (A big order's units the kernel takes first, its workers after (the
    // JavaScript's, ~30x the budget a unit): an army with a third of it
    // workers moved at the workers' pace. The same order on every peer: by
    // the units' columns at the order.)
    if (ORDER_KERNEL && ids.length >= 64) ids = _orderWorkersLast(ids);
    _orderStampIds(T, ids, seq);
    const e = { playerId, cmd, action: a.action, targetX: a.targetX, targetY: a.targetY, ids, next: 0, seq, live: ids.length, sum: _orderIdsSum(ids) };
    _orderQueue.push(e); _orderBySeq.set(seq, e);
    // (Its first slice at gameTick's start, the same tick (runQueuedOrders,
    // within the tick's order budget): applied here, a big order's 2500
    // units (~6 ms) were the action's cost, on top of the order budget's own
    // work at the start of the tick.)
}
// Applies queued orders within this tick's budgets, in queue order (a
// player whose budget is spent waits, its later orders too). Units ordered
// again since are passed over (no budget).
// (Diagnostics: the time and units of the queued orders applied, the
// actions' time; reset by whoever reads them.)
const simOrderStats = globalThis.simOrderStats = { ms: 0, units: 0, calls: 0, actionsMs: 0 };
function runQueuedOrders() {
    _stepBudgets();
    const t0 = performance.now(), b0 = _orderAllLeft;
    try { _runQueuedOrders(); } finally { simOrderStats.ms += performance.now() - t0; simOrderStats.units += Math.max(0, b0 - _orderAllLeft); simOrderStats.calls++; }
}
function _runQueuedOrders() {
    // In rounds of at most ORDER_UNITS_PER_ROUND units per player (its
    // newest unfinished order only: a click on a few units right after big
    // orders moves them at once; the latest order wins by the stamps anyway),
    // until the players' budgets or the tick's (ORDER_UNITS_PER_TICK_ALL) run
    // out: players ordering at once share the tick evenly.
    for (let progress = true; progress && _orderQueue.length && _orderAllLeft > 0;) {
        progress = false;
        const seen = new Set();
        for (let qi = _orderQueue.length - 1; qi >= 0 && _orderAllLeft > 0; qi--) {
            let e = _orderQueue[qi], p = e.playerId;
            if (seen.has(p)) continue;
            seen.add(p);
            const left = Math.min(_orderBudgetOf(p), _orderAllLeft, ORDER_UNITS_PER_ROUND);
            if (left <= 0) continue;
            // (The kernel's units cost a fraction: ORDER_KERNEL_GAIN as many taken,
            // the slice charged by the JavaScript's share and the kernel's.)
            const gain = ORDER_KERNEL ? ORDER_KERNEL_GAIN : 1;
            const T = _unitOrderSeqOf(p), ids = [];
            while (e.live > 0 && e.next < e.ids.length && ids.length < left * gain) {
                const id = e.ids[e.next++];
                if (_orderStampGet(T, id) === e.seq) { ids.push(id); _orderStampSet(T, id, 0); e.live--; e.sum = (e.sum - _orderIdH(id)) | 0; }
            }
            let charge = ids.length;
            // (Finished: the player's next order may run in this round.)
            if (e.live <= 0 || e.next >= e.ids.length) { _orderQueue.splice(qi, 1); _orderBySeq.delete(e.seq); if (_orderSupSeq === e.seq) { _orderSupSeq = 0; _orderSupEntry = null; } seen.delete(p); }
            progress = true;
            // (The slice's ids are distinct: its units are looked up in order,
            // no set of them.)
            if (ids.length) {
                try {
                    const js = _issueGroupMoveOrder({ action: e.action, targetX: e.targetX, targetY: e.targetY, unitIds: ids, unitIdSet: null, distinct: true }, e.playerId, e.cmd);
                    if (gain > 1 && Number.isFinite(js)) charge = js + Math.ceil((ids.length - js) / gain);
                }
                catch (err) { reportRuntimeError('queued order', err); }
            }
            _orderBudgets[p] = _orderBudgetOf(p) - charge; _orderAllLeft -= charge;
        }
    }
}
function _refillOrderBudget() { _orderBudgets.length = 0; _orderAllLeft = ORDER_UNITS_PER_TICK_ALL; }
function resetOrderQueue() { _orderQueue = []; _orderBudgets = []; _unitOrderSeq = []; _orderBySeq = new Map(); _orderSupSeq = 0; _orderSupEntry = null; _orderSeq = 0; _orderAllLeft = ORDER_UNITS_PER_TICK_ALL; _actionBacklog = []; _actionBudgetLeft = ACTION_BUDGET_PER_TICK; _actionJumpLeft = ACTION_JUMP_BUDGET_PER_TICK; _actionArrival = 0; _actionMarksClear(); }
// The queue as state (snapshots): each entry's units still to apply that
// it ordered last, entries with none left out.
function orderQueueSnapshot() {
    const out = [];
    for (const e of _orderQueue) {
        const T = _unitOrderSeqOf(e.playerId), ids = [];
        for (let i = e.next; i < e.ids.length; i++) if (_orderStampGet(T, e.ids[i]) === e.seq) ids.push(e.ids[i]);
        if (ids.length) out.push([e.playerId, e.cmd, e.action, e.targetX, e.targetY, ids]);
    }
    return out;
}
function orderQueueRestore(rows) {
    resetOrderQueue();
    for (const r of rows || []) {
        const ids = Float64Array.from(Array.isArray(r[5]) ? r[5] : []), seq = _orderSeqNext(), T = _unitOrderSeqOf(r[0]);
        _orderStampIds(T, ids, seq);
        const e = { playerId: r[0], cmd: r[1], action: r[2], targetX: r[3], targetY: r[4], ids, next: 0, seq, live: ids.length, sum: _orderIdsSum(ids) };
        _orderQueue.push(e); _orderBySeq.set(seq, e);
    }
}

// (The state hash's share: each queued order in turn, its player, kind,
// target, and its units still to apply (their count and order-free sum: the
// same for a peer restored from a snapshot, which carries those alone); the
// tick's budgets. It was not hashed: a pending move order showed nowhere.)
function orderQueueChecksum() {
    // (Entries with none left are passed over: a restored peer has none.)
    let h = 2654435761 | 0;
    for (const e of _orderQueue) {
        if (!(e.live > 0)) continue;
        h = Math.imul(h ^ (e.playerId | 0), 16777619);
        h = Math.imul(h ^ (e.cmd | 0), 16777619);
        h = _lsHashStr(h, String(e.action || ''));
        h = _lsHashValue(h, e.targetX); h = _lsHashValue(h, e.targetY);
        h = Math.imul(h ^ (e.live | 0), 16777619);
        h = Math.imul(h ^ (e.sum | 0), 2246822519);
    }
    h = Math.imul(h ^ (_orderAllLeft | 0), 16777619);
    for (let p = 0; p < _orderBudgets.length; p++) if (_orderBudgets[p] !== undefined && _orderBudgets[p] !== null) h = Math.imul(h ^ ((p + 1) * 65599 + (_orderBudgets[p] | 0)), 16777619);
    return h | 0;
}

function processAction(a, playerId) {
    {
        // An order may give the player's idle workers something to do.
        workerWorkChanged(playerId);
        // Any order for units supersedes queued move orders for them.
        if (a.action !== 'move' && a.action !== 'attackMove' && a.unitIdSet && a.unitIdSet.size) _dropQueuedOrderUnits(a.unitIdSet, playerId);
        if (a.action === 'place') {
            let count = Math.max(1, Math.floor(a.count || 1));
            for (let i = 0; i < count; i++) {
                placeBuilding(a.gx, a.gy, a.itemType, playerId, { autoUpgradeEnabled: a.autoUpgradeEnabled, buildEnabled: a.buildEnabled });
            }
        } else if (a.action === 'move' || a.action === 'attackMove') {
            if (!Number.isFinite(a.targetX) || !Number.isFinite(a.targetY)) return;
            _queueGroupMoveOrder(a, playerId, a.action === 'move' ? CMD_MOVING : CMD_ATTACK_MOVING);
        } else if (a.action === 'attack') {
            let target = getUnitById(a.targetId);
            if (target) {
                for (let u of _actionUnits(a)) {
                    // (Not workers: they do not attack, and a target left on one would stay after it is gone.)
                    if (a.unitIdSet.has(u.id) && u.owner === playerId && !u.dead && !u.workerState) {
                        // (The movement kernel's attack order, mv.rs forced: it closes in by the atlas, no way of its own.)
                        unitAttackOrder(u);
                        u.targetUnit = target; u.targetBuilding = null; u.forcedAttackTarget = true;
                        u._forcedTargetLastSeenX = target.x; u._forcedTargetLastSeenY = target.y;
                        u.targetPos = { x: target.x, y: target.y };
                    }
                }
            } else if (Number.isFinite(a.targetX) && Number.isFinite(a.targetY)) {
                // Target vanished before processing: continue toward last known position.
                // (Now, within this action: not through the tick's budget.)
                _processRawAction({ action: 'attackMove', unitIds: a.unitIds, targetX: a.targetX, targetY: a.targetY }, playerId);
            }
        } else if (a.action === 'attackBuilding') {
            let tb = getTileEntityRef(a.targetGx, a.targetGy);
            if (!(tb && tb.energy > 0)) tb = null;
            if (tb) {
                for (let u of _actionUnits(a)) {
                    if (a.unitIdSet.has(u.id) && u.owner === playerId && !u.dead && !u.workerState) {
                        unitAttackOrder(u);
                        u.targetBuilding = tb; u.targetUnit = null; u.forcedAttackTarget = false;
                        u._forcedTargetLastSeenX = null; u._forcedTargetLastSeenY = null;
                        u.targetPos = { x: tb.x, y: tb.y };
                    }
                }
            }
        } else if (a.action === 'stop') {
            for (let u of _actionUnits(a)) {
                if (a.unitIdSet.has(u.id) && u.owner === playerId) {
                    // Releasing hold resumes the unit's current orders
                    // (route, rally, worker task). Only free units stop.
                    if (u.holdPosition) { u.holdPosition = false; simMoveDisarm(u); continue; }
                    u.commandState = CMD_IDLE; u.path = null; u.targetUnit = null; u.targetBuilding = null; u._pendingPathTarget = null; u.forcedAttackTarget = false; u._forcedTargetLastSeenX = null; u._forcedTargetLastSeenY = null;
                    u._attackMoveGx = u._attackMoveGy = null;
                    if (u.workerState) {
                        _clearWorkerTarget(u);
                        clearWorkerTaskMemoryForFreeRetarget(u);
                        u.workerState = 'IDLE';
                    }
                }
            }
        } else if (a.action === 'hold') {
            for (let u of _actionUnits(a)) {
                // Hold only disables movement. Orders, routes, targets and
                // worker tasks are kept, and new orders queue up while held.
                if (a.unitIdSet.has(u.id) && u.owner === playerId) { u.holdPosition = true; simMoveDisarm(u); }
            }
        } else if (a.action === 'queueUnit') {
            let b = getBarrackAtTile(a.gx, a.gy);
            if (!(b && b.owner === playerId)) b = null;
            if (b && b.energy > 0 && !b.underConstruction) {
                let count = Math.max(1, Math.floor(a.count || 1));
                for (let i = 0; i < count; i++) {
                    if (b.spawnQueue.length >= 20) break;
                    let queuedLevel = getThingBaseLevel(b);
                    b.spawnQueue.push(getQueuedSpawnInfo({ unitType: b.unitType, level: queuedLevel }, b.unitType, queuedLevel, playerId));
                }
                if (typeof workSiteDirty === 'function') workSiteDirty(b.gx, b.gy);
                spawnerProductionChanged(b);
            }
        } else if (a.action === 'queueWorker') {
            let s = getSpawnerAtTile(a.gx, a.gy);
            if (!(s && s.owner === playerId)) s = null;
            if (s && s.energy > 0 && !s.underConstruction) {
                let count = Math.max(1, Math.floor(a.count || 1));
                for (let i = 0; i < count; i++) {
                    if (s.spawnQueue.length >= 10) break;
                    let queuedLevel = getThingBaseLevel(s);
                    let queuedType = getSpawnedUnitTypeForBuildingKey(s.type)
                        || (s.type === 'builder_spawner'
                            ? 'builder_unit'
                            : s.type === 'healer_spawner'
                                ? 'healer_unit'
                                : s.type === 'research'
                                    ? 'researcher_unit'
                                    : 'salvager_unit');
                    s.spawnQueue.push(getQueuedSpawnInfo({ unitType: queuedType, level: queuedLevel }, queuedType, queuedLevel, playerId));
                }
                if (typeof workSiteDirty === 'function') workSiteDirty(s.gx, s.gy);
                spawnerProductionChanged(s);
            }
        } else if (a.action === 'queueResearch') {
            let r = getSpawnerAtTile(a.gx, a.gy);
            if (!(r && r.owner === playerId && r.type === 'research')) r = null;
            let stat = getResearchStatEntry(a.kind, a.key, a.statKey);
            if (r && r.energy > 0 && !r.underConstruction && stat) {
                let p = ensurePlayerResearchQueueState(playerId);
                let count = Math.max(1, Math.floor(a.count || 1));
                // Optional position in the ordered queue (0 = the active task).
                let insertAt = Number.isFinite(Number(a.insertAt)) ? Math.max(0, Math.floor(Number(a.insertAt))) : -1;
                // (The capacity (a pass over every worker building) and the
                // stat's depth (a pass over the queue) once an action, each
                // task added counted on: ~0.2 ms a task with 4k worker
                // buildings and 900 tasks queued. The research level read
                // again: a task completed by tryAdvance changes it, and
                // the depth with it.)
                const capacity = getResearchQueueCapacityForPlayer(playerId);
                let total = getPlayerResearchQueueTotalLength(playerId);
                let depthKnown = false, queuedDepth = 0, depthLevel = 0;
                for (let i = 0; i < count; i++) {
                    if (total >= capacity) break;
                    let baseLevel = getPlayerResearchLevel(playerId, a.kind, a.key, a.statKey);
                    if (!depthKnown || baseLevel !== depthLevel) { queuedDepth = getResearchQueuedDepthForPlayer(playerId, a.kind, a.key, a.statKey); depthLevel = baseLevel; depthKnown = true; }
                    let projected = baseLevel + queuedDepth;
                    let capLevel = MAX_RESEARCH_LEVEL;
                    if (projected >= capLevel) break;
                    let task = makeResearchTask(playerId, a.kind, a.key, a.statKey, projected);
                    if (insertAt >= 0) {
                        let ordered = [];
                        if (p.researchTask) ordered.push(p.researchTask);
                        for (let t of p.researchQueue) ordered.push(t);
                        ordered.splice(Math.min(ordered.length, insertAt + i), 0, task);
                        p.researchTask = ordered[0] || null;
                        p.researchQueue.length = 0;
                        for (let k = 1; k < ordered.length; k++) p.researchQueue.push(ordered[k]);
                        rebasePlayerResearchQueueState(playerId, [task]);
                    } else {
                        p.researchQueue.push(task);
                    }
                    tryAdvancePlayerResearchTask(playerId);
                    // (Only this task more: the stat's depth one more; any
                    // task taken off (completed, dropped): counted again.)
                    const now = getPlayerResearchQueueTotalLength(playerId);
                    if (now === total + 1) queuedDepth++; else depthKnown = false;
                    total = now;
                }
            }
        } else if (a.action === 'workerAssign') {
            if (!(a.targetGx >= 0 && a.targetGy >= 0 && a.targetGx < GRID_W && a.targetGy < GRID_H)) return;
            // Assign selected worker units to a specific target
            for (let u of _actionUnits(a)) {
                if (!a.unitIdSet.has(u.id) || u.owner !== playerId || u.dead || !u.workerState) continue;
                let myGx = Math.floor(u.x / TILE), myGy = Math.floor(u.y / TILE);
                if (u.workerType === 'builder' && a.targetType === 'build') {
                    // Generic lookup: includes both under-construction and upgrading targets.
                    let target = _getBuilderWorkTargetAt(a.targetGx, a.targetGy, playerId, true);
                    if (target) {
                        _releaseManualWorkerAssignmentConflicts(u, target, null);
                        if (!_canAssignWorkerTargetExclusive(u, target, null)) {
                            issueWorkerBlockedAssignFallbackMove(u, a.targetGx, a.targetGy);
                            continue;
                        }
                        // Manual assignment should always allow builders to work this target,
                        // even if auto-build for new objects is currently disabled.
                        target.buildEnabled = true;
                        _clearWorkerTarget(u); // clear old target
                        _builderAssignTarget(u, target, myGx, myGy);
                    }
                } else if (isResourceCollectorWorkerType(u.workerType) && _isCollectorGatherTargetType(a.targetType)) {
                    let gather = _getGatherTargetAtForCollectorWorkerType(u.workerType, a.targetGx, a.targetGy, playerId, a.targetType);
                    if (gather && _isValidGatherTargetForCollectorWorkerType(u.workerType, gather.target, gather.type, playerId)) {
                        // Keep the existing collector's reservation. Other selected
                        // collectors move to this area and find free sources on arrival.
                        if (!_canAssignWorkerTargetExclusive(u, gather.target, gather.type)) {
                            issueWorkerBlockedAssignFallbackMove(u, a.targetGx, a.targetGy);
                            continue;
                        }
                        _clearWorkerTarget(u);
                        _setResourceCollectorPinnedTarget(u, gather.target, gather.type);
                        _resourceCollectorAssignTarget(u, gather.target, gather.type, getResourceCollectorConfigByWorkerType(u.workerType));
                    }
                } else if (u.workerType === 'healer' && a.targetType === 'queue') {
                    let qTarget = getTileEntityRef(a.targetGx, a.targetGy);
                    if (!(qTarget && qTarget.owner === playerId && ((qTarget instanceof Barrack) || isSpawnerEntity(qTarget)))) qTarget = null;
                    if (_isHealerQueueAnchorTarget(qTarget, playerId)) {
                        _releaseManualWorkerAssignmentConflicts(u, qTarget, 'queue');
                        if (!_canAssignWorkerTargetExclusive(u, qTarget, 'queue')) {
                            issueWorkerBlockedAssignFallbackMove(u, a.targetGx, a.targetGy);
                            continue;
                        }
                        _clearWorkerTarget(u);
                        u._healerPinnedQueueTarget = qTarget;
                        if (_isHealerQueueTarget(qTarget, playerId)) _setHealerQueueCommit(u, qTarget);
                        else _clearHealerQueueCommit(u);
                        _healerFindTarget(u, myGx, myGy);
                    }
                } else if (u.workerType === 'researcher' && a.targetType === 'research') {
                    let rTarget = getTileEntityRef(a.targetGx, a.targetGy);
                    if (!_isResearcherTargetBuilding(rTarget, playerId)) rTarget = null;
                    if (rTarget) {
                        _releaseManualWorkerAssignmentConflicts(u, rTarget, 'research');
                        if (!_canAssignWorkerTargetExclusive(u, rTarget, 'research')) {
                            issueWorkerBlockedAssignFallbackMove(u, a.targetGx, a.targetGy);
                            continue;
                        }
                        _clearWorkerTarget(u);
                        if (!_setWorkerTarget(u, rTarget, 'research')) {
                            issueWorkerBlockedAssignFallbackMove(u, a.targetGx, a.targetGy);
                            continue;
                        }
                        u.workerState = 'MOVING_TO_RESEARCH';
                        u._workerNextIdleRetargetTick = gameTime;
                        u._researchSpawnerTarget = null;
                        let path = _requestWorkerPath(u, myGx, myGy, rTarget.gx, rTarget.gy, null, null);
                        if (path && path.length > 0) {
                            u.path = path;
                            u.pathIndex = 0;
                            u.commandState = CMD_MOVING;
                        } else {
                            u.commandState = CMD_IDLE;
                        }
                    }
                }
            }
        } else if (a.action === 'setRally' || a.action === 'setRallyMany') {
            const coords = a.action === 'setRally' ? [a.gx, a.gy] : (a.coords || []);
            for (let k = 0; k + 1 < coords.length; k += 2) {
                let b = getTileEntityRef(coords[k], coords[k + 1]);
                if (!(b && b.owner === playerId && ((b instanceof Barrack) || isSpawnerEntity(b)))) b = null;
                if (b) {
                    b.rallyX = a.targetX;
                    b.rallyY = a.targetY;
                    b.rallyTargetUnitId = (a.targetUnitId != null) ? a.targetUnitId : null;
                    b._rallyLastSeenX = Number.isFinite(a.targetX) ? a.targetX : null;
                    b._rallyLastSeenY = Number.isFinite(a.targetY) ? a.targetY : null;
                    b._pendingRallyDetach = false;
                }
            }
        } else if (a.action === 'resign') {
            resignedTeams.add(playerId);
            if (playerId === localPlayerId) enterSpectateMode('defeated');
            checkWinCondition();
        } else if (a.action === 'forceResignTeam') {
            let targetTeam = Number.isFinite(a.targetTeam) ? Math.floor(a.targetTeam) : null;
            if (targetTeam !== null) {
                resignedTeams.add(targetTeam);
                if (targetTeam === localPlayerId) enterSpectateMode('defeated');
                checkWinCondition();
            }
        } else if (a.action === 'dequeueUnit') {
            let b = getBarrackAtTile(a.gx, a.gy);
            if (!(b && b.owner === playerId)) b = null;
            if (b) {
                let count = Math.max(1, Math.floor(a.count || 1));
                for (let i = 0; i < count; i++) {
                    if (b.spawnQueue.length <= 0) break;
                    b.spawnQueue.shift();
                }
                spawnerProductionChanged(b);
            }
        } else if (a.action === 'dequeueWorker') {
            let s = getSpawnerAtTile(a.gx, a.gy);
            if (!(s && s.owner === playerId)) s = null;
            if (s) {
                let count = Math.max(1, Math.floor(a.count || 1));
                for (let i = 0; i < count; i++) {
                    if (s.spawnQueue.length <= 0) break;
                    s.spawnQueue.shift();
                }
                spawnerProductionChanged(s);
            }
        } else if (a.action === 'dequeueResearch') {
            let r = getSpawnerAtTile(a.gx, a.gy);
            if (!(r && r.owner === playerId && r.type === 'research')) r = null;
            if (r) {
                let p = ensurePlayerResearchQueueState(playerId);
                let count = Math.max(1, Math.floor(a.count || 1));
                const touched = [];
                for (let i = 0; i < count; i++) {
                    let idx = -1;
                    if (a.kind && a.key && a.statKey) {
                        for (let qi = p.researchQueue.length - 1; qi >= 0; qi--) {
                            let q = p.researchQueue[qi];
                            if (q && q.kind === a.kind && q.key === a.key && q.statKey === a.statKey) {
                                idx = qi;
                                break;
                            }
                        }
                    } else if (p.researchQueue.length > 0) {
                        idx = p.researchQueue.length - 1;
                    }

                    if (idx >= 0) {
                        const [gone] = p.researchQueue.splice(idx, 1);
                        if (gone && !_researchTaskOfStats(gone, touched)) touched.push(gone);
                        continue;
                    }

                    if (p.researchTask) {
                        if (!a.kind || !a.key || !a.statKey || (p.researchTask.kind === a.kind && p.researchTask.key === a.key && p.researchTask.statKey === a.statKey)) {
                            if (!_researchTaskOfStats(p.researchTask, touched)) touched.push(p.researchTask);
                            p.researchTask = null;
                            tryAdvancePlayerResearchTask(playerId);
                            // (The next task, now active, may have finished
                            // its stat: its stat made again too.)
                            if (p.researchTask && !_researchTaskOfStats(p.researchTask, touched)) touched.push(p.researchTask);
                        }
                    }
                }
                rebasePlayerResearchQueueState(playerId, touched);
                tryAdvancePlayerResearchTask(playerId);
            }
        } else if (a.action === 'reorderResearch') {
            let r = getSpawnerAtTile(a.gx, a.gy);
            if (!(r && r.owner === playerId && r.type === 'research')) r = null;
            if (r || getOwnedActiveResearchLabs(playerId).length > 0) {
                let p = ensurePlayerResearchQueueState(playerId);
                let fromIsActive = !!a.fromActive;
                let toIsActive = !!a.toActive;
                let ordered = [];
                if (p.researchTask) ordered.push(p.researchTask);
                for (let task of p.researchQueue) ordered.push(task);
                if (ordered.length <= 1) return;

                let from = fromIsActive ? 0 : (Math.floor(Number(a.fromIndex)) + 1);
                if (!Number.isFinite(from) || from < 0 || from >= ordered.length) return;

                let rawTo = Math.floor(Number(a.toIndex));
                let to = 0;
                if (toIsActive) {
                    to = 0;
                } else {
                    if (!Number.isFinite(rawTo)) return;
                    if (fromIsActive) {
                        to = Math.max(0, Math.min(ordered.length - 1, rawTo + 1));
                    } else {
                        to = rawTo <= 0
                            ? 0
                            : Math.max(0, Math.min(ordered.length - 1, rawTo + 1));
                    }
                }
                if (from === to) return;

                let [task] = ordered.splice(from, 1);
                if (!task) return;
                ordered.splice(to, 0, task);

                p.researchTask = ordered[0] || null;
                p.researchQueue.length = 0;
                for (let i = 1; i < ordered.length; i++) p.researchQueue.push(ordered[i]);
                rebasePlayerResearchQueueState(playerId, [task]);
                tryAdvancePlayerResearchTask(playerId);
            }
        } else if (a.action === 'moveResearch') {
            // Move one task within the ordered queue (index 0 = the active task).
            if (getOwnedActiveResearchLabs(playerId).length > 0) {
                let p = ensurePlayerResearchQueueState(playerId);
                let ordered = [];
                if (p.researchTask) ordered.push(p.researchTask);
                for (let task of p.researchQueue) ordered.push(task);
                let from = Math.floor(Number(a.from));
                let to = Math.floor(Number(a.to));
                if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from >= ordered.length) return;
                to = Math.max(0, Math.min(ordered.length - 1, to));
                if (from === to) return;
                let [task] = ordered.splice(from, 1);
                ordered.splice(to, 0, task);
                p.researchTask = ordered[0] || null;
                p.researchQueue.length = 0;
                for (let i = 1; i < ordered.length; i++) p.researchQueue.push(ordered[i]);
                rebasePlayerResearchQueueState(playerId, task ? [task] : null);
                tryAdvancePlayerResearchTask(playerId);
            }
        } else if (a.action === 'markSalvage') {
            // Toggle salvage mark on a building at gx,gy
            let target = getTileEntityRef(a.gx, a.gy);
            if (target && target.owner === playerId && target.markedForSalvage !== undefined) {
                target.markedForSalvage = !target.markedForSalvage;
                if (typeof salvageMarksChanged === 'function') salvageMarksChanged();
                if (typeof workSiteDirty === 'function') workSiteDirty(target.gx, target.gy);
            }
        } else if (a.action === 'setSalvage') {
            let target = getTileEntityRef(a.gx, a.gy);
            if (target && target.owner === playerId && target.markedForSalvage !== undefined) {
                target.markedForSalvage = !!a.marked;
                if (typeof salvageMarksChanged === 'function') salvageMarksChanged();
                if (typeof workSiteDirty === 'function') workSiteDirty(target.gx, target.gy);
            }
        } else if (a.action === 'setAutoUpgrade') {
            let target = getTileEntityRef(a.gx, a.gy);
            if (!(target && target.owner === playerId)) target = null;
            if (target) {
                target.autoUpgradeEnabled = !!a.enabled;
                if (!target.autoUpgradeEnabled) {
                    target.isUpgrading = false;
                }
                refreshThingProgressState(target);
            }
        } else if (a.action === 'setAutoStack') {
            let target = getTileEntityRef(a.gx, a.gy);
            if (!(target && target.owner === playerId)) target = null;
            if (target) {
                target.autoStackEnabled = !!a.enabled;
                refreshThingProgressState(target);
            }
        } else if (a.action === 'setBuildEnabled') {
            let target = getTileEntityRef(a.gx, a.gy);
            if (!(target && target.owner === playerId)) target = null;
            if (target) {
                target.buildEnabled = !!a.enabled;
            }
        } else if (a.action === 'setQueueEnabled') {
            let target = getTileEntityRef(a.gx, a.gy);
            if (!(target && target.owner === playerId && ((target instanceof Barrack) || isSpawnerEntity(target)))) target = null;
            if (target) {
                target.queueEnabled = !!a.enabled;
                spawnerProductionChanged(target);
            }
        } else if (a.action === 'setAutoResearch') {
            let target = getSpawnerAtTile(a.gx, a.gy);
            if (!(target && target.owner === playerId && target.type === 'research')) target = null;
            if (target) {
                target.autoResearchEnabled = !!a.enabled;
                if (target.autoResearchEnabled) {
                    let task = getPlayerResearchTask(playerId);
                    target.researchTask = task || null;
                    if (!target.isUpgrading && task && task.workDone < task.workRequired) {
                        target.isResearching = true;
                    }
                } else {
                    target.isResearching = false;
                }
            }
        } else if (a.action === 'setBoost') {
            // A thing's energy or ★ boost (data_dynamic.js BOOSTS).
            setPlayerThingBoost(playerId, a.kind, a.key, a.res, a.steps);
        } else if (a.action === 'shrineDrain') {
            // Where the player's shrine drains to: 1 energy, 2 \u2605, 3 both, 0 neither
            // (shrines off: no draining, the order is ignored).
            if (SHRINES_ENABLED && players[playerId]) players[playerId].shrineDrain = (Math.floor(Number(a.drain)) || 0) & 3;
        } else if (a.action === 'killUnit') {
            // One unit (unitId) or a group's (unitIds: one order, not one per
            // unit, each found by a scan of every unit: a 50k group's kill
            // was 50k orders of 600k compares). By the id map.
            // gameTick's dead-unit sweep releases the population slot.
            const byId = _unitByIdMap();
            const kill = u => { if (u && u.owner === playerId && !u.dead && !u.isKing) { u.energy = 0; u.dead = true; } };
            if (a.unitId !== undefined && a.unitId !== null) kill(byId.get(a.unitId));
            for (const id of a.unitIds) kill(byId.get(id));
        } else if (a.action === 'resizeUnitGroup') {
            let subgroupFilter = {
                unitType: a.unitType || null,
                unitLevel: Number.isFinite(a.unitLevel) ? a.unitLevel : null
            };
            resizeUnitSubgroup(playerId, a.unitIds || [], a.mode, subgroupFilter);
        } else if (a.action === 'towerTarget') {
            // Set preferredTarget on own towers. (A unit target looked up
            // once, by id: a scan of every unit per tower took seconds for
            // thousands of towers.)
            let targetUnit = null;
            if (a.target && a.target.type === 'unit') { const tu = getUnitById(a.target.id); targetUnit = tu && !tu.dead && tu.owner !== playerId ? tu : null; }
            for (let tc of (a.towerCoords || [])) {
                let t = getTowerAtTile(tc.gx, tc.gy);
                if (!(t && t.owner === playerId)) t = null;
                if (!t) continue;
                if (!a.target) { t.preferredTarget = null; t.preferredTargetSpec = null; continue; }
                if (a.target.type === 'unit') {
                    let tu = targetUnit;
                    t.preferredTarget = tu || null;
                    t.preferredTargetSpec = tu ? { type: 'unit', id: tu.id } : null;
                } else if (a.target.type === 'tower') {
                    let tb = getTowerAtTile(a.target.gx, a.target.gy);
                    t.preferredTarget = (tb && tb.energy > 0 && tb.owner !== playerId) ? tb : null;
                    t.preferredTargetSpec = t.preferredTarget ? { type: 'tower', gx: a.target.gx, gy: a.target.gy } : null;
                } else if (a.target.type === 'barrack') {
                    let b = getBarrackAtTile(a.target.gx, a.target.gy);
                    t.preferredTarget = (b && b.energy > 0 && b.owner !== playerId) ? b : null;
                    t.preferredTargetSpec = t.preferredTarget ? { type: 'barrack', gx: a.target.gx, gy: a.target.gy } : null;
                } else if (a.target.type === 'spawner') {
                    let s = getSpawnerAtTile(a.target.gx, a.target.gy);
                    t.preferredTarget = (s && s.energy > 0 && s.owner !== playerId) ? s : null;
                    t.preferredTargetSpec = t.preferredTarget ? { type: 'spawner', gx: a.target.gx, gy: a.target.gy } : null;
                } else if (a.target.type === 'item') {
                    let item = getFloorItemAtTile(a.target.gx, a.target.gy);
                    t.preferredTarget = (item && item.energy > 0 && item.owner !== playerId) ? item : null;
                    t.preferredTargetSpec = t.preferredTarget ? { type: 'item', gx: a.target.gx, gy: a.target.gy } : null;
                } else {
                    t.preferredTarget = null;
                    t.preferredTargetSpec = null;
                }
            }
        }
    }
}

// ============================================================
// CAMERA CONTROLS
// ============================================================
// The view's centre stays on the map: up to half a view past each edge, so
// edges and corners can be centred, zoomed into and worked at.
function cameraRange() {
    let vw = viewW / camera.zoom, vh = viewH / camera.zoom;
    return { minX: -vw / 2, maxX: WORLD_W - vw / 2, minY: -vh / 2, maxY: WORLD_H - vh / 2 };
}
function clampCamera() {
    let r = cameraRange();
    camera.x = Math.max(r.minX, Math.min(r.maxX, camera.x));
    camera.y = Math.max(r.minY, Math.min(r.maxY, camera.y));
}

// Settings > Target FPS: the Auto option shows the rate it currently uses.
// Also shows this display's choice (the window may have moved displays).
function refreshFpsTargetAutoLabel() {
    let select = document.getElementById('setting-fps-target');
    let opt = select && select.querySelector('option[value="auto"]');
    if (!opt) return;
    let text = `Auto (${getDisplayRefreshRate()} Hz)`;
    if (opt.textContent !== text) opt.textContent = text;
    let value = String(getFpsTargetSetting());
    if (select.value !== value) select.value = value;
}

function getMinCameraZoom() {
    return Math.max(.001, Math.min(viewW / WORLD_W, viewH / WORLD_H) * .9);
}

// Camera motion is time based, from the frame clock (see _runLoopFrame):
// every frame moves by exactly its share of time, whatever the frame rate.
// Keyboard panning: 1440 screen px/s (12 px per frame at 120 FPS), eased
// out over a few frames. Wheel zoom: 1.2x per notch, eased toward the
// target around the cursor.
const CAMERA_PAN_SPEED = 1440;
// A key pressed (or the direction changed): full speed at once, from the
// moment of the key, so the very next frame has moved by the whole time since
// (eased in, the first frames moved a few px and the camera felt late). Keys
// released: eased out over CAMERA_PAN_EASE_MS, a short glide to a stop.
const CAMERA_PAN_START_EASE_MS = 0;
// A press from rest counts from this much before the key (at most from the
// last drawn frame): the first frame after the key, and the slide at once,
// show a whole step, however shortly before that frame the key came. (At its
// own time a key 1 ms before a frame moved 1.4 px in it: nothing to see
// until the frame after, 8 ms later at 120 Hz, 17 ms at 60.)
const CAMERA_PAN_HEAD_START_MS = 12;
const CAMERA_PAN_EASE_MS = 20;
const CAMERA_ZOOM_EASE_MS = 45;
let _cameraFrameTime = 0;
let _cameraPanVel = { x: 0, y: 0 };
// Velocity the pan eases toward (from the keys held), world px per second.
let _cameraPanTarget = { x: 0, y: 0 };
let _cameraZoomAnim = null; // { target, clientX, clientY, applied }

// Sets the zoom keeping the world point under (clientX, clientY) in place.
function setCameraZoomAt(zoom, clientX, clientY) {
    let gameArea = document.getElementById('game-area');
    if (!gameArea || !(zoom > 0)) return;
    let rect = gameArea.getBoundingClientRect();
    let screenX = clientX - rect.left;
    let screenY = clientY - rect.top;
    let worldBeforeX = camera.x + screenX / camera.zoom;
    let worldBeforeY = camera.y + screenY / camera.zoom;
    let r3 = renderDimensionMode === '3d' && renderer3dInstance
        && typeof renderer3dInstance.buildViewProjection === 'function' && typeof renderer3dInstance.screenToGround === 'function'
        ? renderer3dInstance : null;
    let worldBefore3D = null;
    if (r3) {
        r3.buildViewProjection(get3DProjectionSnapshot());
        let picked = r3.screenToGround(clientX, clientY, rect);
        if (picked && Number.isFinite(picked.x) && Number.isFinite(picked.y)) worldBefore3D = { x: picked.x * TILE, y: picked.y * TILE };
    }
    camera.zoom = zoom;
    if (!r3) {
        camera.x = worldBeforeX - screenX / camera.zoom;
        camera.y = worldBeforeY - screenY / camera.zoom;
    } else if (worldBefore3D) {
        r3.buildViewProjection(get3DProjectionSnapshot());
        let picked = r3.screenToGround(clientX, clientY, rect);
        if (picked && Number.isFinite(picked.x) && Number.isFinite(picked.y)) {
            camera.x += worldBefore3D.x - picked.x * TILE;
            camera.y += worldBefore3D.y - picked.y * TILE;
        }
    }
    clampCamera();
}

// Target pan velocity (world px per second) for the keys held now.
function getCameraPanTargetVelocity() {
    let moveX = 0;
    let moveY = 0;
    let up = keysDown['arrowup'] || keysDown['w'];
    let down = keysDown['arrowdown'] || keysDown['s'];
    let right = keysDown['arrowright'] || keysDown['d'];
    let left = keysDown['arrowleft'] || keysDown['a'];
    if (renderDimensionMode === '3d' && renderer3dInstance && typeof renderer3dInstance.getGroundMovementBasis === 'function') {
        let basis = renderer3dInstance.getGroundMovementBasis();
        if (up) { moveX += basis.forwardX; moveY += basis.forwardZ; }
        if (down) { moveX -= basis.forwardX; moveY -= basis.forwardZ; }
        if (right) { moveX += basis.rightX; moveY += basis.rightZ; }
        if (left) { moveX -= basis.rightX; moveY -= basis.rightZ; }
    } else {
        if (up) moveY -= 1;
        if (down) moveY += 1;
        if (left) moveX -= 1;
        if (right) moveX += 1;
    }
    let moveLen = detHypot(moveX, moveY);
    let speed = CAMERA_PAN_SPEED / camera.zoom;
    return { x: moveLen > 0 ? moveX / moveLen * speed : 0, y: moveLen > 0 ? moveY / moveLen * speed : 0 };
}

// Pan key changes since the camera last moved, with the time they happened
// (the event's own time, even when the page was busy when it was pressed):
// the camera turns at that moment, not at the next frame. The camera slide
// is rebuilt at once, so the picture turns without waiting for a frame.
let _cameraPanInputs = [];
function noteCameraPanInput(time) {
    if (!gameStarted) return;
    let target = getCameraPanTargetVelocity();
    let last = _cameraPanInputs.length ? _cameraPanInputs[_cameraPanInputs.length - 1] : _cameraPanTarget;
    if (target.x === last.x && target.y === last.y) return;
    let t = Number.isFinite(time) && time > 0 ? Math.min(time, performance.now()) : performance.now();
    if (last.x === 0 && last.y === 0 && _cameraPanVel.x === 0 && _cameraPanVel.y === 0) t -= CAMERA_PAN_HEAD_START_MS;
    _cameraPanInputs.push({ t, x: target.x, y: target.y });
    if (typeof refreshCameraSlideForInput === 'function') refreshCameraSlideForInput();
}

// Pan motion over `sec` seconds from time t0 (ms): velocity (v0x, v0y) eases
// toward the target (tx, ty) with time constant CAMERA_PAN_EASE_MS (none
// toward a moving target: CAMERA_PAN_START_EASE_MS), and the
// target switches at each input's time. Returns the distance moved (world
// px) and the velocity and target at the end. Inputs from before t0 already
// apply at t0.
function cameraPanTravel(v0x, v0y, tx, ty, t0, sec, inputs) {
    let x = 0, y = 0, vx = v0x, vy = v0y, t = t0, end = t0 + sec * 1000;
    let step = to => {
        let s = (to - t) / 1000;
        if (!(s > 0)) return;
        let tau = (tx !== 0 || ty !== 0 ? CAMERA_PAN_START_EASE_MS : CAMERA_PAN_EASE_MS) / 1000;
        if (!(tau > 0)) { x += tx * s; y += ty * s; vx = tx; vy = ty; t = to; return; }
        let k = Math.exp(-s / tau);
        x += tx * s + (vx - tx) * (1 - k) * tau;
        y += ty * s + (vy - ty) * (1 - k) * tau;
        vx = tx + (vx - tx) * k;
        vy = ty + (vy - ty) * k;
        t = to;
    };
    for (let input of inputs) {
        if (input.t > t) {
            if (input.t >= end) break;
            step(input.t);
        }
        tx = input.x; ty = input.y;
    }
    step(end);
    return { x, y, vx, vy, tx, ty };
}

function updateCamera(frameTime) {
    let t = Number.isFinite(frameTime) ? frameTime : performance.now();
    let dt = _cameraFrameTime ? t - _cameraFrameTime : 0;
    _cameraFrameTime = t;
    // Long stalls (hidden tab, loading) must not fling the camera, but
    // ordinary hitches must be covered in full: a camera that drops time
    // during a hitch visibly slows down and speeds up again.
    dt = Math.max(0, Math.min(250, dt));

    let zoomAnim = _cameraZoomAnim;
    if (zoomAnim) {
        if (zoomAnim.applied !== camera.zoom) {
            // Something else set the zoom (pinch, minimap, tools): it wins.
            _cameraZoomAnim = null;
        } else {
            let k = 1 - Math.exp(-dt / CAMERA_ZOOM_EASE_MS);
            let z = Math.exp(Math.log(camera.zoom) + (Math.log(zoomAnim.target) - Math.log(camera.zoom)) * k);
            if (Math.abs(z / zoomAnim.target - 1) < 0.002) z = zoomAnim.target;
            z = Math.max(getMinCameraZoom(), Math.min(MAX_CAMERA_ZOOM, z));
            setCameraZoomAt(z, zoomAnim.clientX, zoomAnim.clientY);
            zoomAnim.applied = camera.zoom;
            if (z === zoomAnim.target || camera.zoom !== z) _cameraZoomAnim = null;
        }
    }

    // Pan: the eased motion through this frame's key changes (see
    // cameraPanTravel), so every frame moves by exactly its share of time.
    let vel = _cameraPanVel;
    let inputs = _cameraPanInputs;
    _cameraPanInputs = [];
    if (dt > 0) {
        let r = cameraPanTravel(vel.x, vel.y, _cameraPanTarget.x, _cameraPanTarget.y, t - dt, dt / 1000, inputs);
        camera.x += r.x;
        camera.y += r.y;
        vel.x = r.vx;
        vel.y = r.vy;
    }
    // The keys held now (zoom or 3D rotation may also have changed the speed).
    let target = getCameraPanTargetVelocity();
    _cameraPanTarget.x = target.x;
    _cameraPanTarget.y = target.y;
    if (Math.abs(vel.x) < 1 && target.x === 0) vel.x = 0;
    if (Math.abs(vel.y) < 1 && target.y === 0) vel.y = 0;

    clampCamera();
}

// ============================================================
// GAME INIT & MAIN LOOP
// ============================================================
let _simShadowStartedThisMatch = false;
let _simShadowMatchTick = -1;
let _simClientStartedThisMatch = false;

function startGame() {
    resetOrderMarkers();
    _simShadowStartedThisMatch = false;
    _simClientStartedThisMatch = false;
    if (typeof simClientStop === 'function') simClientStop();
    document.getElementById('lobby').style.display = 'none';
    let go = document.getElementById('game-over');
    if (go) go.style.display = 'none';

    resetWorldState();
    matchFullVisibility = !!fullVisibility;

    rebuildPrecomputedStatsMap();

    mapAlerts = [];
    controlGroupAlertState = {};
    controlGroups = {};
    popupControlGroups = {};
    activePopupControlGroupKey = '';
    localDefeated = false;
    localDefeatAuto = false;
    spectateMode = 'none';
    resignedTeams = new Set();
    graphMetric = 'units';
    gameStatsHistory = [];
    researchPanelOpenState = {};
    researchQueuePanelOpenState = {};

    for (let p of players) {
        p.energy = STARTING_MONEY;
        p.astar = STARTING_ASTAR;
        p.resourceMaxValues = {};
        p.resourceStatMultipliers = {};
        p.popCount = 0;
        p.researchLevels = {};
        p.researchMultipliers = {};
        p.researchQueue = [];
        p.researchTask = null;
        p.shrine = 0;
        p.shrineDrain = SHRINE_DRAIN_DEFAULT;
        p.boosts = {};
        p.boostOn = { energy: true, astar: true };
        if (p._resourceFixedValues) p._resourceFixedValues.shrine = 0;
    }
    shrineResetPending();
    for (let playerId = 0; playerId < players.length; playerId++) {
        _ensurePlayerResourceState(playerId);
        _updatePlayerResourcePenaltyMultipliers(playerId);
    }

    rng = mulberry32(gameSeed);
    visualRng = mulberry32(gameSeed ^ 0xDEADBEEF); // separate RNG for visual effects
    generateAreas();
    let teams = (activeTeamIds && activeTeamIds.length > 0) ? activeTeamIds : [0, 1];
    let spawns = pickPlayerSpawns(teams.length);
    generateResourceMinesMixed(spawns);
    // (Every player starts within reach of both resources: map.js.)
    spawns = settleSpawnsNearResources(spawns);

    let teamSpawnPos = {};
    let teamStarterSpawnState = {};

    startingResourcesConfig = normalizeStartingResourcesConfig(startingResourcesConfig);

    // The nearest buildable tile to `origin`: least Manhattan distance, ties
    // by row then column (the origin itself excluded). Tiles only fill up
    // while the match is set up, so each origin keeps a cursor into that
    // order and the next search resumes where the last one stopped: all the
    // starting buildings of a base cost one pass over the tiles they cover.
    let starterBuildCursors = new Map();
    let findStarterBuildSpot = (origin) => {
        let isBuildableStarterTile = (gx, gy) => {
            if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
            let cell = grid[gy][gx];
            if (!cell || cell.type === TYPE_WALL || cell.item) return false;
            if (getGoldMineAt(gx, gy) || getAstarMineAt(gx, gy)) return false;
            return true;
        };
        let ox = origin.gx, oy = origin.gy;
        let key = ox + ',' + oy;
        // Position in the order: ring r, row offset dy, and side (0: -dx, 1: +dx).
        let cur = starterBuildCursors.get(key);
        if (!cur) { cur = { r: 1, dy: -1, side: 0 }; starterBuildCursors.set(key, cur); }
        let maxR = GRID_W + GRID_H;
        for (; cur.r <= maxR; cur.r++, cur.dy = -cur.r, cur.side = 0) {
            let r = cur.r;
            // Rows of the ring that lie on the map.
            if (cur.dy < -r) cur.dy = -r;
            if (oy + cur.dy < 0) { cur.dy = -oy; cur.side = 0; }
            let dyEnd = Math.min(r, GRID_H - 1 - oy);
            for (; cur.dy <= dyEnd; cur.dy++, cur.side = 0) {
                let adx = r - Math.abs(cur.dy);
                for (; cur.side < 2; cur.side++) {
                    if (cur.side === 1 && adx === 0) continue;
                    let fx = ox + (cur.side === 0 ? -adx : adx), fy = oy + cur.dy;
                    if (isBuildableStarterTile(fx, fy)) return { gx: fx, gy: fy };
                }
            }
        }
        return null;
    };

    let applyWorkerDefaults = (u) => {
        if (!u) return;
        let resourceCollectorKey = getResourceTypeByCollectorUnit(u.unitType);
        if (resourceCollectorKey) {
            u.workerState = 'IDLE'; u.workerType = u.unitType; u.carryingValue = 0; _clearWorkerTarget(u);
        } else if (u.unitType === 'salvager_unit') {
            u.workerState = 'IDLE'; u.workerType = 'salvager'; u.carryingValue = 0; _clearWorkerTarget(u);
        } else if (u.unitType === 'builder_unit') {
            u.workerState = 'IDLE'; u.workerType = 'builder'; u.carryingValue = 0; _clearWorkerTarget(u); u.builderHasMaterial = false;
        } else if (u.unitType === 'healer_unit') {
            u.workerState = 'IDLE'; u.workerType = 'healer'; u.carryingValue = 0; _clearWorkerTarget(u); u.healerHasMaterial = false;
        } else if (u.unitType === 'researcher_unit') {
            u.workerState = 'IDLE'; u.workerType = 'researcher'; u.carryingValue = 0; _clearWorkerTarget(u); u.researcherHasMaterial = false;
        }
    };

    let completeStarterBuilding = (item, itemKey, owner, level) => {
        if (!item) return;
        let lvl = Math.max(1, clampThingLevel(level || 1));
        let stacks = getRequiredStacksForLevel(lvl);
        item.stacks = stacks;
        item.effectiveStacks = stacks;
        item.level = lvl;
        item.effectiveLevel = lvl;
        item.potentialEffectiveLevel = lvl;
        item.underConstruction = false;
        upkeepThingDirty(item);
        item.isUpgrading = false;

        if (item instanceof Tower) {
            item.updateStats();
        } else {
            let calcType = itemKey;
            if (item.type === 'barrack') calcType = `barrack_${item.unitType}`;
            let stats = calculateItemStats(calcType, lvl, owner);
            if (Number.isFinite(stats.maxEnergy)) {
                item.maxEnergy = Math.max(1, Math.floor(stats.maxEnergy));
                item.energy = item.maxEnergy;
            }
            if (Number.isFinite(stats.damage)) item.damage = stats.damage;
            if (item.spawnCooldown !== undefined) {
                let fallbackType = getSpawnerFallbackUnitType(item);
                let buildingKey = (item.type === 'barrack') ? `barrack_${item.unitType}` : item.type;
                item.spawnCooldown = Math.round(getBarrackSpawnCooldown(fallbackType, lvl, owner, buildingKey) * TICK_RATE);
            }
        }
        updateItemTextCache(item);
        // Built at once: it sees from now (visibility coverage).
        if (typeof visCoverOnBuildingChanged === 'function') visCoverOnBuildingChanged(item);
    };

    let getPlacedBuildingEntityAt = (gx, gy, itemKey, owner) => {
        if ((BASE_CARD_TYPES[itemKey] || {}).target === 'wall') {
            let t = getTowerAtTile(gx, gy);
            return (t && t.owner === owner && t.type === itemKey) ? t : null;
        }
        if (itemKey.startsWith('barrack_')) {
            let unitType = (BASE_CARD_TYPES[itemKey] || {}).unitType || 'norm';
            let b = getBarrackAtTile(gx, gy);
            return (b && b.owner === owner && b.unitType === unitType) ? b : null;
        }
        if (itemKey === 'spawner' || itemKey === 'salvager' || itemKey === 'builder_spawner' || itemKey === 'healer_spawner' || itemKey === 'research') {
            let s = getSpawnerAtTile(gx, gy);
            return (s && s.owner === owner && s.type === itemKey) ? s : null;
        }
        return (grid[gy] && grid[gy][gx]) ? grid[gy][gx].item : null;
    };

    let spawnStartingBuilding = (pid, origin, itemKey, level) => {
        let spot = findStarterBuildSpot(origin);
        if (!spot) return null;
        let ok = placeBuilding(spot.gx, spot.gy, itemKey, pid, {
            autoUpgradeEnabled: true,
            buildEnabled: true,
            silent: true,
            ignorePlacementRules: true,
        });
        if (!ok) return null;
        let placed = getPlacedBuildingEntityAt(spot.gx, spot.gy, itemKey, pid);
        if (!placed) return null;
        completeStarterBuilding(placed, itemKey, pid, level);
        return placed;
    };

    // Free tiles by distance from `origin` (BFS). The search passes through
    // buildings (a base can wall its own middle in), not terrain walls.
    // With `floorItems`, walkable tiles holding a floor item count too.
    // Only tiles clearly nearer this team's spawn than any other team's
    // (1.2x: a neutral band between the armies), so a starting army never
    // begins among its enemies.
    // The first `limit` such tiles (typed arrays; it stops there).
    let starterSpawnTilesFirst = (origin, limit, floorItems, others) => {
        const W = GRID_W, H = GRID_H, n = W * H, out = [];
        const seen = new Uint8Array(n), q = new Int32Array(n);
        const startGx = Math.max(0, Math.min(W - 1, Math.floor(origin.gx))), startGy = Math.max(0, Math.min(H - 1, Math.floor(origin.gy)));
        let qh = 0, qt = 0;
        q[qt++] = startGy * W + startGx; seen[startGy * W + startGx] = 1;
        while (qh < qt && out.length < limit) {
            const t = q[qh++], gx = t % W, gy = (t - gx) / W;
            if (gx !== startGx || gy !== startGy) {
                let own = (gx - startGx) * (gx - startGx) + (gy - startGy) * (gy - startGy), foreign = false;
                for (let o of others) if ((gx - o.gx) * (gx - o.gx) + (gy - o.gy) * (gy - o.gy) <= own * 1.44) { foreign = true; break; }
                if (foreign) continue;
            }
            const cell = grid[gy] ? grid[gy][gx] : null;
            const isFloorTile = !!cell && cell.type !== TYPE_WALL;
            if (isFloorTile && (!cell.item || floorItems) && !getGoldMineAt(gx, gy)) out.push({ gx, gy });
            if (!isFloorTile && !(cell && getTileEntityRef(gx, gy))) continue;
            if (gx + 1 < W && !seen[t + 1]) { seen[t + 1] = 1; q[qt++] = t + 1; }
            if (gx > 0 && !seen[t - 1]) { seen[t - 1] = 1; q[qt++] = t - 1; }
            if (gy + 1 < H && !seen[t + W]) { seen[t + W] = 1; q[qt++] = t + W; }
            if (gy > 0 && !seen[t - W]) { seen[t - W] = 1; q[qt++] = t - W; }
        }
        if (out.length <= 0) {
            let fallback = findNearestWalkable(startGx, startGy, startGx, startGy);
            out.push({ gx: fallback.x, gy: fallback.y });
        }
        return out;
    };

    // Starting units spread over enough free tiles for at most
    // STARTER_UNITS_PER_TILE each (the area grows with the army), dealt out
    // round robin; units sharing a tile stand at distinct offsets in it, so
    // no two start on the same point. With occupancy the area is the units'
    // own footprints (starterUnitTilesByTeam): three to a tile packed more
    // than it holds, and the units it could not place were never made (the
    // 200k fixture started with 168k).
    const STARTER_UNITS_PER_TILE = 3;
    let starterUnitCountByTeam = {}, starterUnitTilesByTeam = {}, starterRejectedByTeam = {};
    const STARTER_TILE_OFFSETS = [[0, 0], [-9, -9], [9, 9], [9, -9], [-9, 9], [0, -11], [0, 11], [-11, 0], [11, 0]];
    // A unit's exclusive footprint in tiles: occupancy holds a disk of
    // ceil(R / cell) cells, neighbours at least two radii apart, dealt on the
    // tiles' grid (a 24 px disk takes a whole 32 px tile, a 16 px one a
    // quarter); a tenth more for the relocation's slack (sim_occupancy.js
    // occupancySpawn).
    let starterUnitFootprintTiles = (unitType) => {
        let st = BASE_UNIT_STATS[unitType] || BASE_UNIT_STATS.norm || {};
        let cell = TILE / SIM_OCCUPANCY_SUBCELLS, cells = Math.max(1, Math.ceil((Number(st.collisionR) || Number(st.r) || 8) / cell));
        let d = 2 * cells * cell, side = Math.floor(TILE / d);
        return 1.1 * (side >= 1 ? 1 / (side * side) : Math.ceil(d / TILE) ** 2);
    };
    let starterOccupancy = () => typeof SIM_OCCUPANCY_ENABLED !== 'undefined' && SIM_OCCUPANCY_ENABLED;
    let getNextStarterUnitSpawnTile = (pid, origin) => {
        let state = teamStarterSpawnState[pid];
        if (!state) {
            let want = starterOccupancy() && starterUnitTilesByTeam[pid] > 0 ? Math.ceil(starterUnitTilesByTeam[pid])
                : Math.ceil(Math.max(1, starterUnitCountByTeam[pid] || 0) / STARTER_UNITS_PER_TILE);
            let others = [];
            for (let other in teamSpawnPos) if (Number(other) !== Number(pid) && teamSpawnPos[other]) others.push(teamSpawnPos[other]);
            // The nearest tiles (BFS order) that hold the army; a small army
            // still takes a tile per unit. One traversal that stops once it
            // has them (the search grown by 8 tiles and redone from the start
            // until it did was ~9 s a team at 1M units); with floor items too
            // when the free tiles are too few.
            let count = Math.max(1, starterUnitCountByTeam[pid] || 0);
            let keep = Math.max(want, Math.min(count, 64));
            let tiles = starterSpawnTilesFirst(origin, keep, false, others);
            if (tiles.length < want) tiles = starterSpawnTilesFirst(origin, keep, true, others);
            if (tiles.length > keep) tiles.length = keep;
            state = { tiles, cursor: 0 };
            teamStarterSpawnState[pid] = state;
        }
        if (!state.tiles || state.tiles.length <= 0) {
            let fallback = findNearestWalkable(origin.gx, origin.gy, origin.gx, origin.gy);
            return { gx: fallback.x, gy: fallback.y, ox: 0, oy: 0 };
        }
        let n = state.tiles.length;
        let tile = state.tiles[state.cursor % n];
        let off = STARTER_TILE_OFFSETS[Math.floor(state.cursor / n) % STARTER_TILE_OFFSETS.length];
        state.cursor++;
        return { gx: tile.gx, gy: tile.gy, ox: off[0], oy: off[1] };
    };

    // (A start snapshot replaces every entity at once: the simulation
    // worker's start makes none; startGameSkipStarters.)
    let spawnStartingUnit = (pid, origin, unitType, level) => {
        // (Occupancy found no room within its search of the dealt tile: the
        // next tiles; once many found none, the area is full (more units than
        // the map holds) and each further try would be a failed search.)
        let rejected = starterRejectedByTeam[pid] || 0;
        let u = null, tries = rejected < Math.max(256, (starterUnitCountByTeam[pid] || 0) >> 6) ? 8 : 1;
        for (let k = 0; k < tries; k++) {
            let spawnTile = getNextStarterUnitSpawnTile(pid, origin);
            u = new Unit(unitType, pid, spawnTile.gx * TILE + 16 + spawnTile.ox, spawnTile.gy * TILE + 16 + spawnTile.oy);
            if (!u.dead) break;
            starterRejectedByTeam[pid] = ++rejected;
        }
        if (u.dead) return null;
        applyWorkerDefaults(u);
        applyUnitLevelScaling(u, Math.max(1, clampThingLevel(level || 1)));
        u.energy = u.preComputed.maxEnergy;
        units.push(u); unitSlotMapPushed(u);
        players[pid].popCount++;
        return u;
    };

    for (let pid of teams) {
        let researchByThing = startingResourcesConfig.researchLevels || {};
        for (let thingId in researchByThing) {
            let parsed = parseStartingThingId(thingId);
            if (!parsed) continue;
            let levelMap = researchByThing[thingId];
            if (!levelMap || typeof levelMap !== 'object') continue;
            for (let statKey in levelMap) {
                if (!getResearchStatEntry(parsed.kind, parsed.key, statKey)) continue;
                let lvl = Math.max(0, Math.min(MAX_RESEARCH_LEVEL, Math.floor(Number(levelMap[statKey]) || 0)));
                if (lvl <= 0) continue;
                let id = makeResearchLevelId(parsed.kind, parsed.key, statKey);
                players[pid].researchLevels[id] = lvl;
                players[pid].researchMultipliers[id] = detPow(getResearchBonusExpForStat(parsed.kind, statKey, parsed.key), lvl);
            }
        }
    }

    rebuildPrecomputedStatsMapPlayer();

    for (let i = 0; i < teams.length; i++) {
        let pid = teams[i];
        let pos = spawns[i] || spawns[0];
        teamSpawnPos[pid] = pos;
    }

    // (Room for every starting unit at once: see simUnitStateReserve.)
    if (!startGameSkipStarters && typeof simUnitStateReserve === 'function') {
        let spawnByThing = startingResourcesConfig.spawnCounts || {}, perTeam = 0;
        for (let thingId in spawnByThing) {
            let parsed = parseStartingThingId(thingId), levelMap = spawnByThing[thingId];
            if (!parsed || parsed.kind === 'building' || !levelMap || typeof levelMap !== 'object') continue;
            for (let levelText in levelMap) perTeam += normalizeStartingSpawnCount(levelMap[levelText]);
        }
        // (And the whole population's slots from the start: no growth later,
        // see simUnitPopulationSlots.)
        simUnitStateReserve(Math.min(perTeam, getConfiguredMaxPop()) * teams.length,
            typeof simUnitPopulationSlots === 'function' ? simUnitPopulationSlots() : 0);
        // (And the starting workers' records: sim_unit_state.js simUnitWk.)
        if (typeof simUnitWkReserve === 'function') {
            let workers = 0;
            for (let thingId in spawnByThing) {
                let parsed = parseStartingThingId(thingId), levelMap = spawnByThing[thingId];
                if (!parsed || parsed.kind === 'building' || !levelMap || typeof levelMap !== 'object') continue;
                if (!(getResourceTypeByCollectorUnit(parsed.key) || ['salvager_unit', 'builder_unit', 'healer_unit', 'researcher_unit'].includes(parsed.key))) continue;
                for (let levelText in levelMap) workers += normalizeStartingSpawnCount(levelMap[levelText]);
            }
            simUnitWkReserve(Math.min(workers, getConfiguredMaxPop()) * teams.length);
        }
    }
    for (let pid of (startGameSkipStarters ? [] : teams)) {
        let pos = teamSpawnPos[pid];
        let spawnByThing = startingResourcesConfig.spawnCounts || {};
        // Buildings first, then units on the tiles left free.
        let unitCount = 0, unitTiles = 0;
        for (let thingId in spawnByThing) {
            let parsed = parseStartingThingId(thingId), levelMap = spawnByThing[thingId];
            if (!parsed || parsed.kind === 'building' || !levelMap || typeof levelMap !== 'object') continue;
            let n = 0;
            for (let levelText in levelMap) n += normalizeStartingSpawnCount(levelMap[levelText]);
            unitCount += n;
            if (starterOccupancy()) unitTiles += n * starterUnitFootprintTiles(parsed.key);
        }
        starterUnitCountByTeam[pid] = Math.min(unitCount, getConfiguredMaxPop());
        starterUnitTilesByTeam[pid] = unitCount > 0 ? unitTiles * starterUnitCountByTeam[pid] / unitCount : 0;
        // (Units: the population cap takes them in the listed order; with
        // occupancy the largest footprints are placed first, the small ones
        // then fill the gaps between them. Listed order, small types came
        // first and left only holes too small for the big ones: 11k of the
        // 200k fixture's tanks and bosses were not made.)
        let unitJobs = [], popLeft = Math.max(0, getConfiguredMaxPop() - players[pid].popCount);
        for (let pass = 0; pass < 2; pass++) for (let thingId in spawnByThing) {
            let parsed = parseStartingThingId(thingId);
            if (!parsed) continue;
            if ((parsed.kind === 'building') !== (pass === 0)) continue;
            let levelMap = spawnByThing[thingId];
            if (!levelMap || typeof levelMap !== 'object') continue;
            if (parsed.kind === 'building' && (BASE_CARD_TYPES[parsed.key] || {}).notBuildable) continue;
            for (let levelText in levelMap) {
                let lvl = Math.max(1, Math.min(MAX_THING_LEVEL, Math.floor(Number(levelText) || 1)));
                let count = normalizeStartingSpawnCount(levelMap[levelText]);
                if (parsed.kind === 'unit') {
                    count = Math.min(count, popLeft); popLeft -= count;
                    if (count > 0) unitJobs.push({ key: parsed.key, lvl, count, order: unitJobs.length,
                        size: starterOccupancy() ? starterUnitFootprintTiles(parsed.key) : 0 });
                    continue;
                }
                for (let i = 0; i < count; i++) if (!spawnStartingBuilding(pid, pos, parsed.key, lvl)) break;
            }
        }
        // (Up to 64 units each has a tile of its own: the listed order, as
        // it always was; small scenarios keep their layouts and ids.)
        if (starterUnitCountByTeam[pid] > 64) unitJobs.sort((a, b) => b.size - a.size || a.order - b.order);
        for (let job of unitJobs) {
            let count = Math.min(job.count, Math.max(0, getConfiguredMaxPop() - players[pid].popCount));
            for (let i = 0; i < count; i++) spawnStartingUnit(pid, pos, job.key, job.lvl);
        }
    }

    recomputePlayerPopCaps();

    // Center camera on own base
    let localSpawn = teamSpawnPos[localPlayerId] || spawns[0];
    camera.x = localSpawn.gx * TILE - viewW / 2;
    camera.y = localSpawn.gy * TILE - viewH / 2;
    clampCamera();

    recalculateAdjacency();
    dirtyGrid = true; dirtyAreas = true;
    gameStarted = true;
    const snapshotButton = document.getElementById('btn-export-snapshot');
    if (snapshotButton) snapshotButton.style.display = isMultiplayer ? 'none' : '';
    requestBuildMenuRefresh();
    updateControlGroupBar();
    startBackgroundMusic();

    if (isMultiplayer) {
        lockstepLocalPacketByTick = {};
        lockstepHostPacketsByTick = {};
        lockstepBundleByTick = {};
        lockstepPendingBundleByTick = {};
        lockstepPendingCommitByTick = {};
        lockstepCommittedByTick = {};
        lockstepLastPacketSentAtByTick = {};
        lockstepLastBundleSentAtByTick = {};
        lockstepLastResendRequestAtByTick = {};
        lockstepHighestSentLocalTick = -1;
        lockstepHostWaitRequestByPeer = {};
        lockstepHostLateByTick = {};
        lockstepHostCarryByPeer = {};
        lockstepHostLastOnTimeAt = {};
        lockstepHostLastPacketAt = {};
        lockstepHostLastPacketTick = {};
        lockstepGuestWaitRequest = null;
        lockstepFatalStopActive = false;
        lockstepFatalStopReason = '';
        lockstepFatalStopDetails = null;
        LOCKSTEP_DEBUG_HASH_DETAILS = !!lockstepStrictDebugMode;
        lockstepLastHardResyncRequestAt = 0;
        lockstepHardResyncInFlightUntil = 0;
        lockstepPostSnapshotGraceUntilAt = 0;
        lockstepSnapshotLastSentAtByPeer = {};
        lockstepExpectedStateHashByTick = {};
        lockstepLocalStateHashByTick = {};
        lockstepExpectedStateDigestByTick = {};
        lockstepLocalStateDigestByTick = {};
        lockstepDesyncDetected = false;
    }

    // Start unified game loop
    _lastTickTime = performance.now();
    _tickAccumulator = 0;
    _tpsTickCount = 0;
    _tpsDisplay = 0;
    _tpsLastTime = _lastTickTime;
    startMainThreadLoops();
    prewarmItemThumbnails();
}

// Set while a start that a whole-world snapshot follows runs startGame (the
// simulation worker's): the starting units and buildings are not made (the
// snapshot brings them; at 200k units they were seconds of work thrown away).
let startGameSkipStarters = false;

let _lastTickTime = 0;
let _tickAccumulator = 0;
let _simulationFrameHandle = 0;
let _renderFrameHandle = 0;

function stableSerializeForLockstep(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableSerializeForLockstep).join(',') + ']';
    if (typeof v === 'object') {
        let keys = Object.keys(v).sort();
        return '{' + keys.map(k => JSON.stringify(k) + ':' + stableSerializeForLockstep(v[k])).join(',') + '}';
    }
    return JSON.stringify(String(v));
}

function normalizeLockstepPayload(v) {
    if (v === null || v === undefined) return null;
    let t = typeof v;
    if (t === 'number') return Number.isFinite(v) ? v : null;
    if (t === 'string' || t === 'boolean') return v;
    if (Array.isArray(v)) {
        const out = new Array(v.length);
        for (let i = 0; i < v.length; i++) { const e = v[i]; out[i] = typeof e === 'number' ? (Number.isFinite(e) ? e : null) : normalizeLockstepPayload(e); }
        return out;
    }
    if (t === 'object') {
        let out = {};
        for (let k of Object.keys(v)) {
            let vv = v[k];
            if (vv === undefined || typeof vv === 'function' || typeof vv === 'symbol') continue;
            out[k] = normalizeLockstepPayload(vv);
        }
        return out;
    }
    return null;
}

function hashStringLockstep(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

// hashStringLockstep(stableSerializeForLockstep(v)) without the string: the
// same characters fed to the same hash as they would be written (an order
// of 20000 unit ids made ~20000 strings and their joins per checksum, the
// most garbage of a click's tick on every peer).
function hashStableLockstep(v) {
    return (_lsHashValue(2166136261 | 0, v) >>> 0).toString(16).padStart(8, '0');
}
function _lsHashStr(h, s) { for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h; }
const _lsDigits = new Uint8Array(24);
function _lsHashValue(h, v) {
    if (v === null || v === undefined) return _lsHashStr(h, 'null');
    const t = typeof v;
    if (t === 'number') {
        // (Whole numbers below 1e21: JSON writes their digits; -0 as 0.)
        if (Number.isInteger(v) && Math.abs(v) < 1e21) {
            let n = v;
            if (n < 0) { h = Math.imul(h ^ 45, 16777619); n = -n; }
            if (n < 4294967296) {
                let k = 0;
                do { const q = Math.floor(n / 10); _lsDigits[k++] = n - q * 10; n = q; } while (n > 0);
                while (k > 0) h = Math.imul(h ^ (48 + _lsDigits[--k]), 16777619);
                return h;
            }
            return _lsHashStr(h, JSON.stringify(n));
        }
        return _lsHashStr(h, JSON.stringify(v));
    }
    if (t === 'boolean') return _lsHashStr(h, v ? 'true' : 'false');
    if (t === 'string') return _lsHashStr(h, JSON.stringify(v));
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        if (!Array.isArray(v)) return _lsHashStr(h, stableSerializeForLockstep(v));
        h = Math.imul(h ^ 91, 16777619);
        for (let i = 0; i < v.length; i++) { if (i) h = Math.imul(h ^ 44, 16777619); h = _lsHashValue(h, v[i]); }
        return Math.imul(h ^ 93, 16777619);
    }
    if (t === 'object') {
        const keys = Object.keys(v).sort();
        h = Math.imul(h ^ 123, 16777619);
        for (let i = 0; i < keys.length; i++) {
            if (i) h = Math.imul(h ^ 44, 16777619);
            h = _lsHashStr(h, JSON.stringify(keys[i]));
            h = Math.imul(h ^ 58, 16777619);
            h = _lsHashValue(h, v[keys[i]]);
        }
        return Math.imul(h ^ 125, 16777619);
    }
    return _lsHashStr(h, JSON.stringify(String(v)));
}

function computeTickPacketChecksum(tick, peerId, teamId, actions) {
    return hashStableLockstep({
        tick: Math.floor(tick),
        peerId: String(peerId || ''),
        teamId: Math.floor(Number(teamId) || 0),
        actions: Array.isArray(actions) ? actions : []
    });
}

// The packets of a bundle run in its order: peer ids by UTF-16 code units,
// the same on every peer (localeCompare's order is the locale's: peers of
// different languages sorted, and checked, differently).
function tickPacketOrder(a, b) {
    const x = String(a.peerId), y = String(b.peerId);
    return x < y ? -1 : x > y ? 1 : 0;
}
// (In the bundle's order, the order its commands run in: sorted here, two
// packets swapped kept the checksum and changed what happened.)
function computeTickBundleChecksum(tick, packets, flush = 0, dk = 1) {
    let list = (Array.isArray(packets) ? packets : [])
        .map(p => ({
            tick: Math.floor(Number(p.tick) || 0),
            peerId: String(p.peerId || ''),
            teamId: Math.floor(Number(p.teamId) || 0),
            actions: Array.isArray(p.actions) ? p.actions : [],
            checksum: String(p.checksum || '')
        }));
    let body = { tick: Math.floor(tick), packets: list };
    // A resync tick: every peer drops its history caches before running it.
    if (flush) body.flush = 1;
    // (The step's base ticks, simDk: covered too. One, the common case, is
    // left out: the checksums of bundles from before step sizes stand.)
    if (dk > 1) body.dk = dk | 0;
    return hashStableLockstep(body);
}

let runtimeErrorCount = 0;
let _runtimeErrorLastLogAt = {};

// Logged, but at most once per second per kind so a repeating error does not
// flood the console and slow the game further.
function reportRuntimeError(kind, err) {
    runtimeErrorCount++;
    let now = performance.now();
    if ((now - (_runtimeErrorLastLogAt[kind] || -Infinity)) < 1000) return;
    _runtimeErrorLastLogAt[kind] = now;
    try { console.error('[' + kind + ' error, tick ' + currentTick + ', total ' + runtimeErrorCount + ']', err); } catch { }
}

function logLockstepWarning(reason, details = {}) {
    try {
        console.warn('[LOCKSTEP]', reason, details);
    } catch { }
}

function isPeerExplicitlyRemoved(peerId) {
    let pid = String(peerId || '').trim();
    return !!pid && removedFromMatchPeerIds.has(pid);
}

function markPeerRemovedFromMatch(peerId) {
    let pid = String(peerId || '').trim();
    if (!pid) return;
    removedFromMatchPeerIds.add(pid);
    delete lockstepHostWaitRequestByPeer[pid];
}

function clearPeerRemovedFromMatch(peerId) {
    let pid = String(peerId || '').trim();
    if (!pid) return;
    removedFromMatchPeerIds.delete(pid);
}

function hostRemovePlayerFromMatch(peerId) {
    let pid = String(peerId || '').trim();
    if (!isHost || !pid || pid === myPeerId) return;
    let teamId = getTeamIdForPeer(pid);
    let uid = getPeerProfileUid(pid);
    markPeerRemovedFromMatch(pid);
    delete matchRoleByPeerId[pid];
    if (uid) delete matchRoleByUid[uid];
    delete peerUidByPeerId[pid];
    delete netDisconnectedSinceByPeer[pid];
    delete netWaitingSinceByPeer[pid];
    lobbyPlayers = lobbyPlayers.filter(p => p && p.peerId !== pid);
    matchStartLobbyPlayers = matchStartLobbyPlayers.filter(p => p && p.peerId !== pid);
    peerPresenceById[pid] = false;
    let removedMsg = { type: 'PLAYER_REMOVED_FROM_MATCH', peerId: pid, teamId };
    connections.forEach(c => {
        if (!c) return;
        try { c.send(removedMsg); } catch { }
        if (c.peer === pid) { try { c.close(); } catch { } }
    });
    // A resync still waiting for this peer can finish without it.
    if (lockstepResyncPauseActive && lockstepResyncPendingAckByPeer && Object.prototype.hasOwnProperty.call(lockstepResyncPendingAckByPeer, pid)) {
        delete lockstepResyncPendingAckByPeer[pid];
        if (_isHostResyncPauseComplete()) _finishHostResyncPause('removed peer');
    }
    // A team with other players still in the match keeps playing.
    let teammatesLeft = getActiveMatchPeerIds().some(other => other !== pid && getTeamIdForPeer(other) === teamId);
    if (teamId >= 0 && !resignedTeams.has(teamId) && !teammatesLeft) {
        queueHostAdminAction({ action: 'forceResignTeam', targetTeam: teamId });
    }
    broadcastLobbyState(true);
    renderOnlineLobby();
    updateInfoPanel();
}

function scheduleGuestAutoReconnect(reason = 'Connection lost') {
    if (isHost || !isMultiplayer || !gameStarted || !wsHostId) return;
    if (duplicateUidBlocked) return;
    if (isPeerExplicitlyRemoved(myPeerId)) return;
    // Lost the successor we were moving to: try the next one.
    if (hostMigration) { hostMigrationCandidateFailed(wsHostId); return; }
    if (guestReconnectTimer) return;
    // Host gone for long enough: move the match to another player.
    if (guestShouldMigrate() && guestStartHostMigration(reason)) return;
    if (guestReconnectAttempt >= GUEST_RECONNECT_MAX_ATTEMPTS) {
        netHostUnreachable = true;
        return;
    }
    let st = document.getElementById('lobby-status');
    if (st) {
        st.textContent = `${reason}. Reconnecting...`;
        st.style.color = '#fa4';
    }
    // Short gaps: an attempt made while the route is still down costs little,
    // and the next one should come soon after it recovers.
    let waitMs = Math.min(2000, 300 + guestReconnectAttempt * 400);
    guestReconnectTimer = setTimeout(() => {
        guestReconnectTimer = null;
        guestReconnectAttempt++;
        netCounters.reconnectAttempts++;
        joinGame(wsHostId, { rejoin: true });
    }, waitMs);
}

function getActiveMatchPeerIds() {
    if (gameStarted) {
        let ids = [];
        let sourcePlayers = (Array.isArray(matchStartLobbyPlayers) && matchStartLobbyPlayers.length > 0)
            ? matchStartLobbyPlayers
            : lobbyPlayers;
        if (Array.isArray(sourcePlayers) && sourcePlayers.length > 0) {
            for (let p of sourcePlayers) {
                let pid = String((p && p.peerId) || '');
                if (!pid) continue;
                if (normalizeMatchRole(matchRoleByPeerId[pid], 'playing') !== 'playing') continue;
                if (isPeerExplicitlyRemoved(pid)) continue;
                if (isHost && resyncHostIsJoining(pid)) continue;
                if (!ids.includes(pid)) ids.push(pid);
            }
        } else {
            for (let pid of Object.keys(matchRoleByPeerId || {})) {
                if (normalizeMatchRole(matchRoleByPeerId[pid], '') !== 'playing') continue;
                if (isPeerExplicitlyRemoved(pid)) continue;
                ids.push(pid);
            }
        }
        if (myPeerId && !ids.includes(myPeerId) && !isPeerExplicitlyRemoved(myPeerId)) {
            ids.push(myPeerId);
        }
        if (ids.length > 0) {
            ids.sort();
            return ids;
        }
    }
    let ids = [];
    for (let lp of (lobbyPlayers || [])) {
        if (!lp || !lp.peerId) continue;
        if (isPeerExplicitlyRemoved(lp.peerId)) continue;
        ids.push(lp.peerId);
    }
    if (myPeerId && !ids.includes(myPeerId)) ids.push(myPeerId);
    ids.sort();
    return ids;
}

function buildLocalTickPacket(tick) {
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0 || !myPeerId) return null;
    let actions = (localInputBuffer[t] || []).map(a => normalizeLockstepPayload({ ...a, teamId: localPlayerId }));
    let packet = {
        tick: t,
        peerId: myPeerId,
        teamId: localPlayerId,
        actions
    };
    packet = normalizeLockstepPayload(packet) || packet;
    packet.checksum = computeTickPacketChecksum(packet.tick, packet.peerId, packet.teamId, packet.actions);
    lockstepLocalPacketByTick[t] = packet;
    return packet;
}

function validateTickPacket(packet) {
    if (!packet || typeof packet !== 'object') return false;
    let t = Math.floor(Number(packet.tick));
    if (!Number.isFinite(t) || t < 0) return false;
    let peerId = String(packet.peerId || '');
    if (!peerId) return false;
    let teamId = Math.floor(Number(packet.teamId) || 0);
    let actions = Array.isArray(packet.actions) ? packet.actions : [];
    let expected = computeTickPacketChecksum(t, peerId, teamId, actions);
    return String(packet.checksum || '') === expected;
}

// Wire form of a sealed bundle: packets without what the receiver rebuilds
// (their tick and checksum), and without empty action lists. The combined
// checksum still covers everything.
function packTickBundleForWire(b) {
    let p = [];
    for (let pk of b.packets) {
        let row = [pk.peerId, pk.teamId];
        if (Array.isArray(pk.actions) && pk.actions.length > 0) row.push(pk.actions);
        p.push(row);
    }
    let w = { t: b.tick, c: b.combinedChecksum, p };
    if (b.flush) w.f = 1;
    if (b.dk > 1) w.k = b.dk;
    if (matchStartSessionId) w.m = matchStartSessionId;
    return w;
}
// Tick messages carry their match (its session id, w.m / m): a rematch
// counts its ticks from 0 again, and a late bundle of the previous match was
// taken as this one's (divergence). Untagged ones (no session) pass.
function netMatchTagOk(m) {
    return m === undefined || m === null || String(m) === String(matchStartSessionId || '');
}

// A repeated earlier bundle: when no one sent a command in it and the same
// players took part as in `current`, a tick and checksum are enough.
function packRepeatedTickBundleForWire(b, current) {
    let same = b.packets.length === current.packets.length;
    for (let i = 0; same && i < b.packets.length; i++) {
        let a = b.packets[i], c = current.packets[i];
        if (a.peerId !== c.peerId || a.teamId !== c.teamId || (Array.isArray(a.actions) && a.actions.length > 0)) same = false;
    }
    if (!same) return packTickBundleForWire(b);
    let w = { t: b.tick, c: b.combinedChecksum, s: 1 };
    if (b.flush) w.f = 1;
    if (b.dk > 1) w.k = b.dk;
    if (matchStartSessionId) w.m = matchStartSessionId;
    return w;
}

// Bundles rebuilt from the wire have checksums computed here, not received.
const _rebuiltTickBundles = new WeakSet();

function unpackTickBundleFromWire(w, current = null) {
    if (!w || typeof w !== 'object') return null;
    let t = Math.floor(Number(w.t));
    if (!Number.isFinite(t) || t < 0) return null;
    let rows = w.s ? (current ? current.packets.map(p => [p.peerId, p.teamId]) : null) : w.p;
    if (!Array.isArray(rows)) return null;
    let packets = [];
    for (let row of rows) {
        if (!Array.isArray(row)) return null;
        let peerId = String(row[0] || ''), teamId = Math.floor(Number(row[1]) || 0);
        let actions = Array.isArray(row[2]) ? row[2] : [];
        packets.push({ tick: t, peerId, teamId, actions, checksum: computeTickPacketChecksum(t, peerId, teamId, actions) });
    }
    let b = { tick: t, packets, combinedChecksum: String(w.c || '') };
    if (w.f) b.flush = 1;
    if (w.k > 1) b.dk = Math.min(SIM_DK_MAX, w.k | 0);
    _rebuiltTickBundles.add(b);
    return b;
}

function validateTickBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') return false;
    let t = Math.floor(Number(bundle.tick));
    if (!Number.isFinite(t) || t < 0) return false;
    let packets = Array.isArray(bundle.packets) ? bundle.packets : [];
    if (!_rebuiltTickBundles.has(bundle)) {
        for (let p of packets) {
            if (!validateTickPacket(p)) return false;
        }
    }
    let expected = computeTickBundleChecksum(t, packets, bundle.flush ? 1 : 0, bundle.dk | 0);
    return String(bundle.combinedChecksum || '') === expected;
}

function _lockstepWarnRateLimited(key, reason, details = {}, intervalMs = 3000) {
    let now = performance.now();
    let last = Number(lockstepLastWarnAtByKey[key]) || 0;
    if (last && (now - last) < intervalMs) return;
    lockstepLastWarnAtByKey[key] = now;
    logLockstepWarning(reason, details);
}

// Data channels are reliable, so a resend only matters across a reconnect or
// when a message was refused while the channel was reopening.
function getLockstepPacketSafetyResendMs() {
    let link = isHost ? null : netGetHostLinkStats();
    let rtt = (link && Number.isFinite(link.srtt)) ? link.srtt + 4 * link.rttvar : 300;
    return Math.max(700, Math.floor(rtt * 2 + 250));
}

// How long a peer waits for missing lockstep data before asking for it.
function getLockstepResendRequestDelayMs(peerId = null) {
    let link = peerId ? netGetLinkStats(peerId) : (isHost ? null : netGetHostLinkStats());
    let rtt = (link && Number.isFinite(link.srtt)) ? link.srtt + 4 * link.rttvar : 250;
    return Math.max(150, Math.floor(rtt + 2 * TICK_MS));
}

// Guest: send packets for every tick up to the input-delay horizon. A packet,
// once sent, is never changed (see queueAction), so the host may seal it at
// any time.
function sendLocalTickPacketWindow(tick, force = false) {
    if (!isMultiplayer || isHost) return;
    let hostConn = netGetHostConnection();
    if (!hostConn || hostConn.open === false) return;
    let baseTick = Math.floor(Number(tick));
    if (!Number.isFinite(baseTick) || baseTick < 0) return;
    baseTick = Math.max(baseTick, resyncPacketHorizonTick());
    let lead = Math.max(0, Math.floor(Number(LOCKSTEP_PIPELINE_TICKS) || 0));
    let completedTick = netCompletedSimulationTick();
    // Anchor the future input window to the same visible tick as commands.
    // Keep any additional resync horizon, but not the worker's unshown ticks.
    let horizonTick = baseTick - (currentTick - completedTick);
    let horizon = Math.max(baseTick, horizonTick + lead);
    let endTick = Math.max(horizon, lockstepHighestSentLocalTick);
    let now = performance.now();
    let resendMs = getLockstepPacketSafetyResendMs();
    let batch = [];
    for (let t = baseTick; t <= endTick; t++) {
        if (lockstepCommittedByTick[t]) continue;
        let last = Number(lockstepLastPacketSentAtByTick[t]) || 0;
        if (!last && t > horizon && t > lockstepHighestSentLocalTick) continue;
        if (!force && last && (now - last) < resendMs) continue;
        let packet = lockstepLocalPacketByTick[t] || buildLocalTickPacket(t);
        if (!packet) continue;
        if (last) netCounters.packetsResent++;
        batch.push(packet);
        lockstepLastPacketSentAtByTick[t] = now;
        if (t > lockstepHighestSentLocalTick) lockstepHighestSentLocalTick = t;
    }
    if (batch.length === 0) return;
    // The last packets sent, again: one lost message then costs a tick, not
    // a retransmission timeout.
    let first = batch[0].tick;
    for (let t = first - 1, n = 0; n < NET_TICK_REDUNDANCY && t >= baseTick; t--) {
        if (lockstepCommittedByTick[t] || !lockstepLastPacketSentAtByTick[t]) continue;
        let packet = lockstepLocalPacketByTick[t];
        if (!packet) continue;
        batch.unshift(packet);
        n++;
    }
    try {
        hostConn.send({ type: 'TICK_PACKETS', packets: batch, m: matchStartSessionId || undefined });
        netCounters.messagesOut++;
    } catch { }
}

// Guest: the host asked for packets it is waiting on. Ticks beyond the
// current horizon are sent too, which lets the host continue while this
// client catches up (its later commands then land after them).
function resendLocalTickPackets(fromTick, count) {
    if (isHost) return;
    let hostConn = netGetHostConnection();
    if (!hostConn) return;
    let start = Math.max(0, Math.floor(Number(fromTick) || 0));
    let n = Math.max(1, Math.min(64, Math.floor(Number(count) || 1)));
    let now = performance.now();
    let batch = [];
    for (let t = start; t < start + n; t++) {
        if (t < currentTick || lockstepCommittedByTick[t]) continue;
        let packet = lockstepLocalPacketByTick[t] || buildLocalTickPacket(t);
        if (!packet) continue;
        batch.push(packet);
        lockstepLastPacketSentAtByTick[t] = now;
        if (t > lockstepHighestSentLocalTick) lockstepHighestSentLocalTick = t;
    }
    if (batch.length === 0) return;
    netCounters.packetsResent += batch.length;
    try { hostConn.send({ type: 'TICK_PACKETS', packets: batch, m: matchStartSessionId || undefined }); } catch { }
}

function handleIncomingTickPacket(conn, data) {
    if (!isHost) return;
    _hostAcceptTickPacket(conn, data && data.packet ? data.packet : null);
    _hostAdvanceBundles(performance.now());
}

function handleIncomingTickPackets(conn, data) {
    if (!isHost) return;
    if (!data || !netMatchTagOk(data.m)) { netCounters.otherMatchDropped = (netCounters.otherMatchDropped | 0) + 1; return; }
    let list = data && Array.isArray(data.packets) ? data.packets : [];
    for (let packet of list) _hostAcceptTickPacket(conn, packet);
    _hostAdvanceBundles(performance.now());
}

function _hostAcceptTickPacket(conn, rawPacket) {
    let packet = rawPacket;
    if (!packet || typeof packet !== 'object') return;
    let connPeerId = String((conn && conn.peer) || '');
    if (!connPeerId || isPeerExplicitlyRemoved(connPeerId)) return;
    lockstepHostLastPacketAt[connPeerId] = performance.now();
    let pt = Math.floor(Number(packet.tick));
    if (Number.isFinite(pt) && !(lockstepHostLastPacketTick[connPeerId] >= pt)) lockstepHostLastPacketTick[connPeerId] = pt;
    packet.tick = Math.floor(Number(packet.tick));
    if (!Number.isFinite(packet.tick) || packet.tick < 0) return;
    // Late packets for sealed ticks are expected after resends; ignore them,
    // unless the tick was sealed without this one (it came too late): then
    // its commands run on the guest's next open tick.
    if (packet.tick < currentTick || lockstepCommittedByTick[packet.tick] || lockstepBundleByTick[packet.tick]) {
        let late = lockstepHostLateByTick[packet.tick];
        if (late && late.has(connPeerId)) _hostCarryLatePacket(connPeerId, packet, late);
        else if (resyncHostIsJoining(connPeerId)) _hostCarryJoiningCommands(connPeerId, packet);
        return;
    }
    packet.teamId = Math.floor(Number(packet.teamId) || 0);
    packet.actions = Array.isArray(packet.actions) ? packet.actions.map(a => normalizeLockstepPayload(a)) : [];
    packet = normalizeLockstepPayload(packet) || packet;

    if (String(packet.peerId || '') !== connPeerId || !validateTickPacket(packet)) {
        // A guest that reconnected under a new peer id rebuilds its packets;
        // anything else is corrupt and is simply requested again.
        _lockstepWarnRateLimited('bad-packet:' + connPeerId, 'Rejected tick packet; requesting resend', {
            tick: packet.tick, packetPeerId: String(packet.peerId || ''), fromPeer: connPeerId
        });
        try { conn.send({ type: 'TICK_RESEND_REQUEST', tick: packet.tick, count: 1, packetPeerId: connPeerId, rebuild: true }); } catch { }
        return;
    }

    _hostSanitizeTickPacket(packet);

    if (!lockstepHostPacketsByTick[packet.tick]) lockstepHostPacketsByTick[packet.tick] = {};
    lockstepHostPacketsByTick[packet.tick][packet.peerId] = packet;
    lockstepHostLastOnTimeAt[packet.peerId] = currentTick;
    let req = lockstepHostWaitRequestByPeer[packet.peerId];
    if (req && req.tick <= packet.tick) delete lockstepHostWaitRequestByPeer[packet.peerId];
}

// This player resigns (the Resign button). Alone: its team resigns (the
// resign action). In multiplayer the player stops playing, and its team
// resigns only once no teammate plays it: the host decides that
// (utils_networking.js hostPeerStopsPlaying), from the guest's resign
// action or its role update, whichever comes first.
function resignLocalPlayer() {
    if (!gameStarted || localDefeated || gameOver) return;
    if (!isMultiplayer) { queueAction({ action: 'resign' }); enterSpectateMode('defeated'); return; }
    if (!isHost) queueAction({ action: 'resign' });
    // (Host: hostPeerStopsPlaying(myPeerId); guest: MATCH_ROLE_UPDATE.)
    enterSpectateMode('defeated');
}

// Host: a guest packet as the host seals it: the guest's own team, no
// host-only actions, no more than a player could send in a tick (a flood
// would stall every peer). A resign action is the player stopping
// (hostPeerStopsPlaying), not sealed: it resigned the whole team, teammates
// still playing, when it came before the role update (audit 2026-10-16, 36).
function _hostSanitizeTickPacket(packet) {
    let setup = computeTeamSetupFromLobby();
    let enforcedTeamId = setup.teamByPeer[packet.peerId] ?? packet.teamId;
    let actions = packet.actions;
    if (actions.some(a => a && a.action === 'resign') && typeof hostPeerStopsPlaying === 'function') hostPeerStopsPlaying(packet.peerId);
    let filtered = actions.filter(a => !(a && (HOST_ADMIN_ACTIONS.has(a.action) || a.action === 'resign'))).slice(0, LOCKSTEP_MAX_ACTIONS_PER_PACKET);
    for (let i = 0; i < filtered.length; i++) {
        let a = filtered[i];
        if (a && Array.isArray(a.unitIds) && a.unitIds.length > ACTION_MAX_UNIT_IDS) filtered[i] = { ...a, unitIds: a.unitIds.slice(0, ACTION_MAX_UNIT_IDS) };
    }
    if (packet.teamId !== enforcedTeamId || filtered.length !== actions.length || filtered.some((a, i) => a !== actions[i]) || actions.some(a => Math.floor(Number(a && a.teamId) || 0) !== enforcedTeamId)) {
        packet.teamId = enforcedTeamId;
        packet.actions = filtered.map(a => normalizeLockstepPayload({ ...(a || {}), teamId: enforcedTeamId }));
        packet.checksum = computeTickPacketChecksum(packet.tick, packet.peerId, packet.teamId, packet.actions);
    }
    return packet;
}

// Host: the packet of a tick that was sealed without it. Its commands join
// the guest's next open tick (once: later copies find the mark gone).
function _hostCarryLatePacket(peerId, rawPacket, late) {
    let packet = rawPacket;
    packet.teamId = Math.floor(Number(packet.teamId) || 0);
    packet.actions = Array.isArray(packet.actions) ? packet.actions.map(a => normalizeLockstepPayload(a)) : [];
    packet = normalizeLockstepPayload(packet) || packet;
    if (String(packet.peerId || '') !== peerId || !validateTickPacket(packet)) return;
    _hostSanitizeTickPacket(packet);
    late.delete(peerId);
    if (packet.actions.length === 0) return;
    let carry = lockstepHostCarryByPeer[peerId] || (lockstepHostCarryByPeer[peerId] = []);
    for (let a of packet.actions) {
        if (lockstepCommandRan(a)) { netCounters.ranCommandsDropped = (netCounters.ranCommandsDropped | 0) + 1; continue; }
        carry.push(a);
        netCounters.lateCommandsCarried = (netCounters.lateCommandsCarried || 0) + 1;
    }
}

// Host: commands of a peer the match is being reloaded on (resyncHostIsJoining:
// left out of the bundles until it says it is live). Sent before it knew,
// they were dropped; carried (each id once: packets are resent), they run
// in its first packets once it is live (_hostWithCarriedCommands).
function _hostCarryJoiningCommands(peerId, rawPacket) {
    let packet = rawPacket;
    if (!packet || typeof packet !== 'object' || !Array.isArray(packet.actions) || packet.actions.length === 0) return;
    if (String(packet.peerId || '') !== peerId) return;
    packet.actions = packet.actions.map(a => normalizeLockstepPayload(a));
    if (!validateTickPacket(packet)) return;
    _hostSanitizeTickPacket(packet);
    let carry = lockstepHostCarryByPeer[peerId] || (lockstepHostCarryByPeer[peerId] = []);
    let seen = carry._ids || (carry._ids = new Set());
    for (let a of packet.actions) {
        let id = a && a.netId;
        if (id && seen.has(id)) continue;
        // (A copy of a packet that was in a sealed tick before the reload: a
        // resend or a delay. Its commands ran.)
        if (lockstepCommandRan(a)) { netCounters.ranCommandsDropped = (netCounters.ranCommandsDropped | 0) + 1; continue; }
        if (id) seen.add(id);
        carry.push(a);
        netCounters.lateCommandsCarried = (netCounters.lateCommandsCarried || 0) + 1;
    }
}

// Every peer: the ids of the commands in the ticks sealed (host) or run, for
// LOCKSTEP_RAN_KEEP_TICKS (on every peer: a successor host has them too).
// A command is run once: a copy of a sealed tick's packet that reaches the
// host late (a resend, a delay) while its sender rejoins is not carried on
// to run again (audit 2026-10-15, 16). (Ids are unique over a guest's
// reloads: worker.js queueAction, _localActionEpoch.)
const LOCKSTEP_RAN_KEEP_TICKS = 2400;
let _lockstepRan = { match: '', ids: new Map(), byTick: new Map(), unconfirmed: [] };
function _lockstepRanOfMatch() {
    let R = _lockstepRan, m = String(matchStartSessionId || '');
    if (R.match !== m) R = _lockstepRan = { match: m, ids: new Map(), byTick: new Map(), unconfirmed: [] };
    return R;
}
// Guest: its commands whose tick ran without them (the host sealed it
// without its packet: late, lost, or while its match reloads), kept until
// they run (the host carries on the ones it gets) for a reload to send
// again (utils_networking.js _takeUnsentLocalActions; the host leaves out
// copies of what it had: _hostCommandsOnce). A command sent while a reload
// decoded, never delivered, was lost (audit 2026-10-16, 27).
const LOCKSTEP_UNCONFIRMED_MAX = 512;
function lockstepNoteUnconfirmed(list, tick) {
    if (!Array.isArray(list) || list.length === 0) return;
    let R = _lockstepRanOfMatch();
    for (let a of list) if (a && a.netId && !lockstepCommandRan(a)) R.unconfirmed.push({ a, tick });
    if (R.unconfirmed.length > LOCKSTEP_UNCONFIRMED_MAX) R.unconfirmed.splice(0, R.unconfirmed.length - LOCKSTEP_UNCONFIRMED_MAX);
}
function lockstepTakeUnconfirmed() {
    let R = _lockstepRanOfMatch(), out = [];
    for (let e of R.unconfirmed) if (!lockstepCommandRan(e.a) && e.tick > currentTick - LOCKSTEP_RAN_KEEP_TICKS) out.push(e.a);
    R.unconfirmed = [];
    return out;
}
function lockstepNoteRanCommands(packets, tick) {
    if (!Array.isArray(packets)) return;
    let R = _lockstepRanOfMatch(), list = R.byTick.get(tick);
    for (let p of packets) {
        if (!p || !Array.isArray(p.actions)) continue;
        for (let a of p.actions) {
            let id = a && a.netId;
            if (typeof id !== 'string' || !id || R.ids.has(id)) continue;
            R.ids.set(id, tick);
            (list || (R.byTick.set(tick, list = []), list)).push(id);
        }
    }
    // (The window: the oldest ticks' ids leave.)
    if (R.byTick.size > LOCKSTEP_RAN_KEEP_TICKS) {
        for (let [t, ids] of R.byTick) {
            if (t > tick - LOCKSTEP_RAN_KEEP_TICKS) break;
            for (let id of ids) if (R.ids.get(id) === t) R.ids.delete(id);
            R.byTick.delete(t);
        }
    }
}
function lockstepCommandRan(a) {
    let id = a && a.netId;
    return typeof id === 'string' && !!id && _lockstepRanOfMatch().ids.has(id);
}

// Host: an empty packet for a guest whose own did not come in time.
function _hostLatePlaceholderPacket(tick, peerId) {
    let setup = computeTeamSetupFromLobby();
    let teamId = Math.floor(Number(setup.teamByPeer[peerId]) || 0);
    let packet = { tick, peerId, teamId, actions: [] };
    packet.checksum = computeTickPacketChecksum(tick, peerId, teamId, packet.actions);
    return packet;
}

// Host: a guest's packet for this tick with its carried commands in front
// (as many as fit in one packet; the rest wait for the next tick).
function _hostWithCarriedCommands(tick, peerId, packet) {
    let carry = lockstepHostCarryByPeer[peerId];
    if (!carry || carry.length === 0) return packet;
    let room = LOCKSTEP_MAX_ACTIONS_PER_PACKET - packet.actions.length;
    if (room <= 0) return packet;
    let moved = carry.splice(0, room).filter(a => !lockstepCommandRan(a));
    if (carry.length === 0) delete lockstepHostCarryByPeer[peerId];
    if (moved.length === 0) return packet;
    let merged = { tick, peerId, teamId: packet.teamId, actions: moved.concat(packet.actions) };
    merged.checksum = computeTickPacketChecksum(tick, peerId, merged.teamId, merged.actions);
    return merged;
}

// Host: its own packet as it goes in while it does not play: its
// administrative commands alone (null: none).
function _hostAdminPacket(packet) {
    let actions = Array.isArray(packet && packet.actions) ? packet.actions : [];
    let admin = actions.filter(a => a && HOST_ADMIN_ACTIONS.has(a.action));
    if (admin.length === 0) return null;
    if (admin.length === actions.length) return packet;
    let p = { tick: packet.tick, peerId: packet.peerId, teamId: packet.teamId, actions: admin };
    p.checksum = computeTickPacketChecksum(p.tick, p.peerId, p.teamId, p.actions);
    return p;
}

// Host, sealing: a packet without the commands that ran already (an id in
// lockstepCommandRan), that are in this bundle already (`seen`), or that
// still wait in the sender's carry (they run from there). A peer's commands
// are kept over a reload of its match until known to have run, with their
// ids (utils_networking.js _takeUnsentLocalActions): one sent but never
// delivered was lost, and the copies of delivered ones are left out here
// (audit 2026-10-16, 27).
function _hostCommandsOnce(pid, packet, seen) {
    let actions = packet && Array.isArray(packet.actions) ? packet.actions : null;
    if (!actions || actions.length === 0) return packet;
    let carry = lockstepHostCarryByPeer[pid], waiting = null;
    if (carry && carry.length) { waiting = new Set(); for (let a of carry) if (a && a.netId) waiting.add(a.netId); }
    let kept = null;
    for (let i = 0; i < actions.length; i++) {
        let a = actions[i], id = a && a.netId;
        let dup = typeof id === 'string' && !!id && (seen.has(id) || lockstepCommandRan(a) || (waiting && waiting.has(id)));
        if (typeof id === 'string' && id) seen.add(id);
        if (dup) { if (!kept) kept = actions.slice(0, i); netCounters.ranCommandsDropped = (netCounters.ranCommandsDropped | 0) + 1; }
        else if (kept) kept.push(a);
    }
    if (!kept) return packet;
    let p = { tick: packet.tick, peerId: packet.peerId, teamId: packet.teamId, actions: kept };
    p.checksum = computeTickPacketChecksum(p.tick, p.peerId, p.teamId, p.actions);
    return p;
}

// Host: whether a guest delivered a packet in time since the given tick.
function lockstepHostOnTimeSince(peerId, tick) {
    let at = lockstepHostLastOnTimeAt[peerId];
    return Number.isFinite(at) && at >= tick;
}

// Host: a guest silent this long is having an outage, not a late packet.
const HOST_LATE_SEAL_MAX_SILENCE_MS = 1000;

// Host: how long a due tick waits for a late guest packet before it is
// sealed without it. A lag spike or a silent guest then delays only that
// guest's commands instead of freezing every peer.
function hostLateSealGraceMs() {
    return Math.max(TICK_MS, 40);
}
// Host, ticks dispatched ahead to the simulation worker: a tick still
// missing a packet is sealed without it once the worker has this many ticks
// left to run (of its lead of SIM_CLIENT_LEAD_TICKS): early enough that
// neither this peer's worker nor the others', which get the bundle a
// transit later, run a tick late for it.
const HOST_LATE_SEAL_LEAD_TICKS = 2;

function maybeBuildHostBundle(tick, participants = null, sealLate = false) {
    if (!isHost) return null;
    if (lockstepResyncPauseActive || matchStartWaitingForReady) return null;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return null;
    if (lockstepBundleByTick[t]) return lockstepBundleByTick[t];
    if (!lockstepHostPacketsByTick[t]) lockstepHostPacketsByTick[t] = {};
    if (myPeerId && !lockstepHostPacketsByTick[t][myPeerId]) {
        let own = lockstepLocalPacketByTick[t] || buildLocalTickPacket(t);
        if (own) lockstepHostPacketsByTick[t][myPeerId] = own;
    }

    let ids = participants || getActiveMatchPeerIds();
    let pmap = lockstepHostPacketsByTick[t];
    // (A peer the match is being reloaded on is not in the bundles: its
    // commands here are carried to its first ticks once it is live.)
    for (let pid in pmap) if (pid !== myPeerId && !ids.includes(pid) && resyncHostIsJoining(pid)) { _hostCarryJoiningCommands(pid, pmap[pid]); delete pmap[pid]; }
    let missing = null;
    for (let pid of ids) {
        if (pmap[pid]) continue;
        if (!sealLate) return null;
        (missing || (missing = [])).push(pid);
    }
    // (The host's simulation worker seals ticks itself while this page is
    // stalled: then this one is its, and its note brings the bundle,
    // lockstepAdoptAutoSeal.)
    if (typeof simClientSealClaim === 'function' && !simClientSealClaim(t)) return null;
    if (missing) {
        let late = lockstepHostLateByTick[t] || (lockstepHostLateByTick[t] = new Set());
        for (let pid of missing) { pmap[pid] = _hostLatePlaceholderPacket(t, pid); late.add(pid); }
        netCounters.lateSeals = (netCounters.lateSeals || 0) + 1;
    }
    for (let pid in lockstepHostCarryByPeer) if (pmap[pid]) pmap[pid] = _hostWithCarriedCommands(t, pid, pmap[pid]);
    // (A host that does not play (it resigned, it spectates) still runs the
    // match: its administrative commands go in, in a packet of its own with
    // those alone.)
    let sealIds = ids;
    if (myPeerId && !ids.includes(myPeerId) && pmap[myPeerId]) {
        let own = _hostAdminPacket(pmap[myPeerId]);
        if (own) { pmap[myPeerId] = own; sealIds = [...ids, myPeerId]; }
    }
    // (Each command once: a copy of one that ran, or is in this bundle or
    // waits in its sender's carry, is left out.)
    let seen = new Set();
    let packets = sealIds.map(pid => pmap[pid] = _hostCommandsOnce(pid, pmap[pid], seen)).sort(tickPacketOrder);
    let flush = resyncHostFlushTicks.has(t) ? 1 : 0;
    // (The step's base ticks: from the match's pace as it is now.)
    let dk = netStepTicks();
    let combinedChecksum = computeTickBundleChecksum(t, packets, flush, dk);
    let bundle = { tick: t, packets, combinedChecksum };
    if (flush) bundle.flush = 1;
    if (dk > 1) bundle.dk = dk;
    // Building a bundle seals and commits the tick in one step.
    lockstepBundleByTick[t] = bundle;
    lockstepCommittedByTick[t] = true;
    lockstepNoteRanCommands(packets, t);
    // (The simulation worker holds it from now on, and sends it to the
    // guests' workers: its ticks run whatever the pages are doing.)
    if (typeof simClientNoteSealed === 'function') {
        let msg = { type: 'TICK_BUNDLE', w: packTickBundleForWire(bundle), c: 1, d: netMatchInputDelay, pace: netSimulationTickMs() };
        if (missing) msg.l = missing;
        simClientNoteSealed(t, { msg });
    }
    return bundle;
}

// A bundle without anyone's commands, for a tick sealed without waiting for
// them: a stalled host page's simulation worker seals these (sim_worker.js),
// and the page builds the same from its note. participants: [peer, team].
function buildEmptyTickBundle(tick, participants, dk = 1) {
    let packets = participants.map(([peerId, teamId]) => {
        let p = { tick, peerId, teamId, actions: [] };
        p.checksum = computeTickPacketChecksum(tick, peerId, teamId, p.actions);
        return p;
    }).sort(tickPacketOrder);
    const b = { tick, packets, combinedChecksum: computeTickBundleChecksum(tick, packets, 0, dk) };
    if (dk > 1) b.dk = dk;
    return b;
}

// How far the simulation worker may go by itself while this page is stalled
// (sim_client.js simClientAutoArm): the first tick it must leave to the page
// (one with work before it: a resync patch, a join, a flush), none while the
// match is not simply running.
function lockstepAutoLimit() {
    if (!gameStarted || gameOver) return 0;
    if (typeof simClientWorldReady === 'function' && !simClientWorldReady()) return 0;
    if (!isMultiplayer) return 0x7fffffff;
    if (lockstepFatalStopActive || lockstepResyncPauseActive || matchStartWaitingForReady) return 0;
    let limit = 0x7fffffff;
    if (isHost) {
        for (let [, p] of resyncHostPending) if (p.T < limit) limit = p.T;
        for (let t of resyncHostFlushTicks) if (t >= currentTick && t < limit) limit = t;
    } else {
        if (lockstepDesyncDetected || hostMigration) return 0;
        if (resyncGuest && resyncGuest.T >= 0 && resyncGuest.T < limit) limit = resyncGuest.T;
    }
    return Math.max(0, limit);
}
// What the worker needs for it: the pace, and a host's bundle of nobody's
// commands (who plays, on which team; whose links must have a worker's
// channel for it: everyone following the match).
function lockstepAutoInfo() {
    let tickMs = netSimulationTickMs();
    let dk = netStepTicks();
    if (!isMultiplayer) return { role: 'solo', tickMs, dk };
    if (!isHost) return { role: 'guest', tickMs, host: String(wsHostId || '') };
    let ids = getActiveMatchPeerIds(), setup = computeTeamSetupFromLobby();
    return {
        role: 'host', tickMs, d: netMatchInputDelay, pace: tickMs, dk,
        participants: ids.map(pid => [pid, pid === myPeerId ? localPlayerId : Math.floor(Number(setup.teamByPeer[pid]) || 0)]),
        peers: connections.filter(c => c && c.peer).map(c => String(c.peer)).sort()
    };
}
// Host: the worker sealed `tick` without anyone's commands (this page was
// stalled; the guests have its bundle from the worker). The page's lockstep
// takes the bundle as a tick sealed without every packet: commands that
// were here for it, or come for it later, run on a later tick.
const _lockstepAutoSealedTicks = new Set();
function lockstepAdoptAutoSeal(tick, msg) {
    if (!isHost || !isMultiplayer || lockstepBundleByTick[tick]) return;
    let bundle = unpackTickBundleFromWire(msg && msg.w);
    if (!bundle || bundle.tick !== tick) return;
    let pmap = lockstepHostPacketsByTick[tick] || {};
    let late = new Set();
    for (let p of bundle.packets) {
        let pid = String(p.peerId);
        // (Its own: what was queued for this tick.)
        let have = pid === myPeerId ? (lockstepLocalPacketByTick[tick] || ((localInputBuffer[tick] || []).length > 0 ? buildLocalTickPacket(tick) : null)) : pmap[pid];
        if (!have) { if (pid !== myPeerId) late.add(pid); continue; }
        if (!Array.isArray(have.actions) || have.actions.length === 0) continue;
        let carry = lockstepHostCarryByPeer[pid] || (lockstepHostCarryByPeer[pid] = []);
        for (let a of have.actions) carry.push(a);
        netCounters.lateCommandsCarried = (netCounters.lateCommandsCarried || 0) + have.actions.length;
    }
    // (A host that does not play has no packet in it: its administrative
    // commands queued for this tick go on to the next it seals.)
    if (myPeerId && !bundle.packets.some(p => String(p.peerId) === myPeerId)) {
        let own = _hostAdminPacket({ tick, peerId: myPeerId, teamId: localPlayerId, actions: localInputBuffer[tick] || [] });
        if (own) {
            let carry = lockstepHostCarryByPeer[myPeerId] || (lockstepHostCarryByPeer[myPeerId] = []);
            for (let a of own.actions) carry.push(a);
        }
    }
    delete localInputBuffer[tick];
    delete lockstepLocalPacketByTick[tick];
    lockstepHostPacketsByTick[tick] = {};
    for (let p of bundle.packets) lockstepHostPacketsByTick[tick][p.peerId] = p;
    if (late.size > 0) lockstepHostLateByTick[tick] = late;
    lockstepBundleByTick[tick] = bundle;
    lockstepCommittedByTick[tick] = true;
    lockstepNoteRanCommands(bundle.packets, tick);
    _lockstepAutoSealedTicks.add(tick);
    for (let t of _lockstepAutoSealedTicks) if (t < tick - 600) _lockstepAutoSealedTicks.delete(t);
    netCounters.autoSeals = (netCounters.autoSeals || 0) + 1;
    // (Over the page's links too: a peer whose worker has no channel, or
    // missed it.)
    sendHostBundle(tick);
}
// The worker ran `tick` by itself (this page was stalled): the page's
// lockstep moves on as if it had dispatched it. Commands of this player
// that were queued for it and did not make it run on a later tick.
let _lockstepAdoptingTick = null;
function lockstepAdoptAutoTick(tick, dueAbs) {
    if (tick !== currentTick) { logLockstepWarning('The simulation worker ran a tick out of the page\'s order', { tick, currentTick }); return; }
    if (!isMultiplayer) {
        let acts = localInputBuffer[tick];
        if (acts && acts.length) { localInputBuffer[tick + 1] = acts.concat(localInputBuffer[tick + 1] || []); delete localInputBuffer[tick]; }
    } else if (isHost) {
        if (!lockstepBundleByTick[tick]) logLockstepWarning('The simulation worker ran a tick the page has no bundle of', { tick });
    } else {
        // (The host tells from its own marks whether it sealed the tick
        // without them: a copy of a packet it had in time is ignored.)
        let bundle = lockstepBundleByTick[tick] || lockstepPendingBundleByTick[tick] || null;
        let hostConn = netGetHostConnection();
        if (bundle) _guestResendIfSealedWithout(tick, bundle, hostConn);
        else if (hostConn) {
            let own = lockstepLocalPacketByTick[tick] || ((localInputBuffer[tick] || []).length > 0 ? buildLocalTickPacket(tick) : null);
            if (own && Array.isArray(own.actions) && own.actions.length > 0) { try { hostConn.send({ type: 'TICK_PACKETS', packets: [own], m: matchStartSessionId || undefined }); netCounters.messagesOut++; } catch { } }
        }
    }
    netCounters.autoTicks = (netCounters.autoTicks || 0) + 1;
    _lockstepAdoptingTick = { due: dueAbs };
    try { runOneTick(); } finally { _lockstepAdoptingTick = null; }
    // (Its slot of the tick clock is taken; the page may dispatch ahead
    // again at once.)
    let tickMs = netSimulationTickMs();
    if (typeof _tickAccumulator === 'number') _tickAccumulator = Math.max(_tickAccumulator - tickMs, -tickMs);
    if (typeof _hiddenTickAccumulator === 'number') _hiddenTickAccumulator = Math.max(_hiddenTickAccumulator - tickMs, -tickMs);
    waitingForRemoteSince = 0;
}

function sendHostBundle(tick, force = false) {
    if (!isHost) return;
    let t = Math.floor(Number(tick));
    let bundle = lockstepBundleByTick[t];
    if (!bundle) return;
    if (!force && lockstepLastBundleSentAtByTick[t]) return;
    lockstepLastBundleSentAtByTick[t] = performance.now();
    let msg = { type: 'TICK_BUNDLE', w: packTickBundleForWire(bundle), c: 1, d: netMatchInputDelay, pace: netSimulationTickMs() };
    // Whose packet this tick was sealed without (they lengthen their lead).
    let late = lockstepHostLateByTick[t];
    if (late && late.size > 0) msg.l = Array.from(late);
    // (One the host's worker sealed while this page was stalled: nobody's
    // packet was late for it.)
    if (_lockstepAutoSealedTicks.has(t)) msg.auto = 1;
    let prev = [];
    for (let k = NET_TICK_REDUNDANCY; k >= 1; k--) {
        let b = lockstepBundleByTick[t - k] || lockstepHistoryByTick[t - k];
        if (b) prev.push(packRepeatedTickBundleForWire(b, bundle));
    }
    if (prev.length > 0) msg.prev = prev;
    let hashes = resyncTakeHostHashes();
    if (hashes) msg.h = hashes;
    for (let c of connections) {
        if (!c) continue;
        try { c.send(msg); } catch { }
    }
    netCounters.messagesOut += connections.length;
}

// Host: seal and send every tick in the prebuild window whose packets are in.
function _hostAdvanceBundles(now) {
    if (!isHost || !isMultiplayer || !gameStarted || gameOver) return;
    if (lockstepResyncPauseActive || matchStartWaitingForReady) return;
    let participants = getActiveMatchPeerIds();
    let end = currentTick + Math.max(0, Math.floor(Number(LOCKSTEP_HOST_PREBUILD_TICKS) || 0));
    // The current tick is due and still missing a guest's packet: after a
    // short grace it goes without it; at once while that guest is still
    // behind (the tick before went without it too, and nothing came since).
    // A guest that has sent nothing for a while, or only packets for ticks
    // long past (stuck, or far behind), is gone for now (an outage, a
    // reload): then every peer waits for it, as its units cannot be
    // commanded meanwhile.
    let sealLate = false;
    // With ticks dispatched ahead to the simulation worker, the tick is
    // needed before it is due: once the worker has one tick or none left to
    // run, waiting any longer for a packet costs every peer a late tick. The
    // lead up to there is the packet's grace (no tick waits for it).
    let ahead = typeof simClientDispatchAhead === 'function' && simClientDispatchAhead() && simClientWorldReady() && simClientTickFree(currentTick);
    let needed = ahead && simClientWorkerAhead() <= Math.min(HOST_LATE_SEAL_LEAD_TICKS, simClientLeadTicks() - 1);
    if (!lockstepBundleByTick[currentTick] && (waitingForRemoteSince > 0 || ahead)) {
        let pmap = lockstepHostPacketsByTick[currentTick] || {};
        let missing = participants.filter(pid => pid !== myPeerId && !pmap[pid]);
        let behindLimit = Math.ceil(HOST_LATE_SEAL_MAX_SILENCE_MS / netSimulationTickMs());
        let alive = pid => (now - (lockstepHostLastPacketAt[pid] || 0)) < HOST_LATE_SEAL_MAX_SILENCE_MS
            && (currentTick - (Number.isFinite(lockstepHostLastPacketTick[pid]) ? lockstepHostLastPacketTick[pid] : -Infinity)) <= behindLimit;
        if (missing.length > 0 && missing.every(alive)) {
            sealLate = needed || (waitingForRemoteSince > 0 && (now - waitingForRemoteSince) >= hostLateSealGraceMs());
            if (!sealLate) {
                // (Still behind: the bundles go out as early as ever, so the
                // other peers keep their whole lead while this one is away.)
                let prev = lockstepHostLateByTick[currentTick - 1];
                sealLate = !!prev && missing.every(pid => prev.has(pid) && !lockstepHostOnTimeSince(pid, currentTick - 1));
            }
        }
    }
    for (let pt = currentTick; pt <= end; pt++) {
        if (!maybeBuildHostBundle(pt, participants, sealLate && pt === currentTick)) break;
        sendHostBundle(pt);
    }
    // Late marks only matter while a copy of the packet may still come.
    if (sealLate || (currentTick & 63) === 0) {
        for (let k in lockstepHostLateByTick) if (+k < currentTick - 600) delete lockstepHostLateByTick[k];
    }
}

// Host: ask guests for packets it has been waiting on for a while. Requests
// back off so a slow link is not flooded.
function _hostRequestMissingPackets(t, now) {
    let pmap = lockstepHostPacketsByTick[t] || {};
    for (let pid of getActiveMatchPeerIds()) {
        if (pid === myPeerId || pmap[pid]) continue;
        let conn = connections.find(c => c && c.peer === pid);
        if (!conn) continue;
        let req = lockstepHostWaitRequestByPeer[pid];
        if (!req || req.tick !== t) {
            lockstepHostWaitRequestByPeer[pid] = { tick: t, at: now, n: 0 };
            continue;
        }
        let delay = getLockstepResendRequestDelayMs(pid) * detPow(2, Math.min(4, req.n));
        if ((now - req.at) < delay) continue;
        req.at = now;
        req.n++;
        netCounters.resendRequestsSent++;
        try { conn.send({ type: 'TICK_RESEND_REQUEST', tick: t, count: 1 + Math.max(0, Math.floor(Number(LOCKSTEP_HOST_PREBUILD_TICKS) || 0)), packetPeerId: pid }); } catch { }
    }
}

function handleIncomingTickBundle(conn, data) {
    if (isHost) return;
    // (Another match's: dropped, its hashes too.)
    if (!data || !netMatchTagOk(data.w ? data.w.m : data.m)) { netCounters.otherMatchDropped = (netCounters.otherMatchDropped | 0) + 1; return; }
    if (data && data.h) resyncGuestReceiveHashes(data.h);
    if (data && Number.isFinite(data.d)) netMatchInputDelay = Math.max(0, Math.min(NET_MAX_INPUT_DELAY_TICKS, Math.floor(data.d)));
    if (data && Number.isFinite(data.pace) && data.pace >= TICK_MS) netMatchTickMs = data.pace;
    if (data && Array.isArray(data.l) && myPeerId && data.l.includes(myPeerId) && !data.auto) netNoteOwnPacketLate();
    let bundle = data && data.bundle ? data.bundle : unpackTickBundleFromWire(data && data.w);
    if (!bundle || typeof bundle !== 'object') return;
    // Guests normally wait for START_GAME_ALL_READY; ticks from the host mean
    // the match is running, so never stay blocked if that message was lost.
    if (matchStartWaitingForReady) matchStartWaitingForReady = false;
    // Copies of the previous bundles ride along, so a message that is lost
    // (and retransmitted much later) does not hold this peer up.
    if (Array.isArray(data.prev)) {
        for (let w of data.prev) {
            let t = Math.floor(Number(w && w.t));
            if (!w || !netMatchTagOk(w.m) || !(t >= currentTick) || (lockstepCommittedByTick[t] && lockstepBundleByTick[t]) || lockstepPendingBundleByTick[t]) continue;
            _guestAcceptBundle(unpackTickBundleFromWire(w, bundle), !!data.c);
        }
    }
    _guestAcceptBundle(bundle, !!data.c);
}

function _guestAcceptBundle(bundle, sealed) {
    if (!bundle || typeof bundle !== 'object') return;
    let t = Math.floor(Number(bundle.tick));
    if (!Number.isFinite(t) || t < currentTick) return;
    bundle.tick = t;
    if (lockstepCommittedByTick[t] && lockstepBundleByTick[t]) return;
    if (lockstepPendingBundleByTick[t] && lockstepPendingBundleByTick[t].combinedChecksum === bundle.combinedChecksum) return;
    lockstepPendingBundleByTick[t] = bundle;
    if (sealed) lockstepPendingCommitByTick[t] = String(bundle.combinedChecksum || '');
}

function handleIncomingTickBundleAck(conn, data) {
    // Kept so older clients do not trip over the message; the host no longer
    // needs acknowledgements because bundles travel on a reliable channel.
}

function handleIncomingTickCommit(conn, data) {
    if (isHost) return;
    let t = Math.floor(Number(data && data.tick));
    if (!Number.isFinite(t) || t < currentTick) return;
    lockstepPendingCommitByTick[t] = String(data.combinedChecksum || '');
}

function quantizeLockstepNumber(v) {
    let n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 1000) / 1000;
}

function quantizeLockstepUnitPosition(v) {
    let n = Number(v);
    if (!Number.isFinite(n)) return 0;
    // Unit pathing/interaction logic is tile-based; quarter-pixel precision is enough for desync diagnostics.
    return Math.round(n * 4) / 4;
}

// House pop caps for every player in one grid pass (same per-owner summation
// order as a per-owner scan).
function _computeLockstepPopCaps() {
    let cfgCap = Math.max(1, Math.floor(CONFIG_MAX_POP || 200));
    let housePop = new Array(players.length).fill(0);
    // The houses themselves (kept up to date as tiles change, in the grid
    // scan's row-major order): O(houses), not O(map).
    let houses = typeof _cellItemsOfType === 'function' ? _cellItemsOfType('house') : getCellItemsRowMajor().filter(i => i.type === 'house');
    for (let i = 0; i < houses.length; i++) {
        let item = houses[i];
        let cell = grid[item.gy] && grid[item.gy][item.gx];
        if (!cell || cell.item !== item) continue;
        let owner = Math.floor(Number(cell.owner) || 0);
        if (!(owner >= 0 && owner < housePop.length)) continue;
        if (!(Number(item.energy) > 0) || !!item.underConstruction) continue;
        let lvl = Math.max(1, Math.floor(getThingBaseLevel(item) || 1));
        housePop[owner] += getHousePopCapContribution(owner, lvl);
    }
    return housePop.map(pop => Math.min(cfgCap, pop));
}

// The periodic lockstep state hash. It covers the same fields as
// computeLockstepStateDigest in the same sorted order, but mixes integers
// directly instead of serializing a JSON-like string (~5ms per check with
// hundreds of units and thousands of mines). Every peer runs this same code.
// With `partsOut`, the same pass also hashes each subsystem on its own so a
// mismatch report can say which part of the state diverged.
function computeLockstepStateHashFast(tick, partsOut = null) {
    let h = 2166136261 >>> 0;
    let hp = 2166136261 >>> 0;
    let partName = '';
    let beginPart = (name) => {
        if (!partsOut) return;
        if (partName) partsOut[partName] = (hp >>> 0).toString(16).padStart(8, '0');
        partName = name;
        hp = 2166136261 >>> 0;
    };
    let mixInt = partsOut
        ? (v) => {
            v = v | 0;
            h = Math.imul(h ^ (v & 0xff), 16777619);
            h = Math.imul(h ^ ((v >>> 8) & 0xff), 16777619);
            h = Math.imul(h ^ ((v >>> 16) & 0xff), 16777619);
            h = Math.imul(h ^ (v >>> 24), 16777619);
            hp = Math.imul(hp ^ (v & 0xff), 16777619);
            hp = Math.imul(hp ^ ((v >>> 8) & 0xff), 16777619);
            hp = Math.imul(hp ^ ((v >>> 16) & 0xff), 16777619);
            hp = Math.imul(hp ^ (v >>> 24), 16777619);
        }
        : (v) => {
            v = v | 0;
            h = Math.imul(h ^ (v & 0xff), 16777619);
            h = Math.imul(h ^ ((v >>> 8) & 0xff), 16777619);
            h = Math.imul(h ^ ((v >>> 16) & 0xff), 16777619);
            h = Math.imul(h ^ (v >>> 24), 16777619);
        };
    // Quantized values can exceed 32 bits: mix both halves.
    let mixNum = (n) => {
        if (!Number.isFinite(n)) n = 0;
        let hi = Math.floor(n / 4294967296);
        mixInt(n - hi * 4294967296);
        mixInt(hi);
    };
    let q3 = v => { let n = Number(v); return Number.isFinite(n) ? Math.round(n * 1000) : 0; };
    let q4 = v => { let n = Number(v); return Number.isFinite(n) ? Math.round(n * 4) : 0; };
    let strCodes = new Map();
    let mixStr = (str) => {
        str = String(str || '');
        let code = strCodes.get(str);
        if (code === undefined) {
            code = 2166136261 >>> 0;
            for (let i = 0; i < str.length; i++) code = Math.imul(code ^ str.charCodeAt(i), 16777619);
            strCodes.set(str, code);
        }
        mixInt(code);
    };
    let int = v => Math.floor(Number(v) || 0);
    let watchedTeam = e => Number.isFinite(Number(e.watchedByTeam)) ? Math.floor(Number(e.watchedByTeam)) : -1;
    let t = Math.floor(Number(tick));
    beginPart('time');
    mixNum(Number.isFinite(t) ? t : currentTick);
    mixNum(gameTime);
    beginPart('players');
    let popCaps = _computeLockstepPopCaps();
    mixInt(players.length);
    for (let idx = 0; idx < players.length; idx++) {
        let p = players[idx];
        mixNum(q3(p && p.money)); mixNum(q3(p && p.energy)); mixNum(q3(p && p.astar));
        mixInt(int(p && p.popCount)); mixInt(int(popCaps[idx]));
    }
    beginPart('units');
    let live = units.filter(u => u && !u.dead).sort((a, b) => int(a.id) - int(b.id));
    mixInt(live.length);
    for (let u of live) {
        mixInt(int(u.id)); mixInt(int(u.owner)); mixStr(u.unitType);
        mixNum(q4(u.x)); mixNum(q4(u.y)); mixNum(q3(u.energy));
        mixInt(int(u.commandState)); mixStr(u.workerState); mixStr(u.workerType);
        mixInt(int(u.stackCount || 1)); mixInt(Math.max(0, int(u.watched))); mixInt(watchedTeam(u));
    }
    let byTile = (a, b) => (int(a.gy) - int(b.gy)) || (int(a.gx) - int(b.gx)) || (int(a.owner) - int(b.owner));
    let mixBuilding = (list, kindKey) => {
        let sorted = list.filter(x => !!x).sort(byTile);
        mixInt(sorted.length);
        for (let b of sorted) {
            mixInt(int(b.gx)); mixInt(int(b.gy)); mixInt(int(b.owner)); mixStr(b[kindKey]);
            mixInt(Math.floor(Number(b.level) || 1)); mixNum(q3(b.energy));
            if (kindKey !== 'type' || list !== towers) mixInt(Array.isArray(b.spawnQueue) ? b.spawnQueue.length : 0);
            mixInt(b.underConstruction ? 1 : 0); mixInt(b.isUpgrading ? 1 : 0);
            mixInt(Math.max(0, int(b.watched))); mixInt(watchedTeam(b));
        }
    };
    beginPart('towers');
    mixBuilding(towers, 'type');
    beginPart('barracks');
    mixBuilding(barracks, 'unitType');
    beginPart('spawners');
    mixBuilding(collectorSpawners, 'type');
    beginPart('floor');
    for (let gy = 0; gy < GRID_H; gy++) {
        for (let gx = 0; gx < GRID_W; gx++) {
            let cell = grid[gy][gx];
            if (!cell || !cell.item) continue;
            let item = cell.item;
            if ((item instanceof Tower) || (item instanceof Barrack) || isSpawnerEntity(item)) continue;
            mixInt(gx); mixInt(gy); mixInt(int(cell.owner)); mixStr(item.type);
            mixInt(Math.floor(Number(item.level) || 1)); mixNum(q3(item.energy));
            mixInt(item.underConstruction ? 1 : 0); mixInt(item.isUpgrading ? 1 : 0);
            mixInt(Math.max(0, int(item.watched))); mixInt(watchedTeam(item));
        }
    }
    let mixMines = (list, key) => {
        let sorted = list.slice().sort((a, b) => (int(a.gy) - int(b.gy)) || (int(a.gx) - int(b.gx)));
        mixInt(sorted.length);
        for (let m of sorted) { mixInt(int(m.gx)); mixInt(int(m.gy)); mixNum(int(m[key])); }
    };
    beginPart('mines');
    mixMines(goldMines, 'gold');
    mixMines(astarMines, 'astar');
    beginPart('');
    return (h >>> 0).toString(16).padStart(8, '0');
}

function computeLockstepStateDigest(tick) {
    let t = Math.floor(Number(tick));
    let popCaps = _computeLockstepPopCaps();
    let computePopCapFromGrid = (pid) => popCaps[Math.floor(Number(pid) || 0)] || 0;

    let digest = {
        tick: Number.isFinite(t) ? t : currentTick,
        gameTime,
        players: players.map((p, idx) => ({
            idx,
            money: quantizeLockstepNumber(p && p.money),
            energy: quantizeLockstepNumber(p && p.energy),
            astar: quantizeLockstepNumber(p && p.astar),
            popCount: Math.floor(Number((p && p.popCount) || 0)),
            popCap: Math.floor(Number(computePopCapFromGrid(idx) || 0))
        })),
        units: units
            .filter(u => u && !u.dead)
            .map(u => ({
                id: Math.floor(Number(u.id) || 0),
                owner: Math.floor(Number(u.owner) || 0),
                type: String(u.unitType || ''),
                x: quantizeLockstepUnitPosition(u.x),
                y: quantizeLockstepUnitPosition(u.y),
                energy: quantizeLockstepNumber(u.energy),
                cmd: Math.floor(Number(u.commandState) || 0),
                workerState: String(u.workerState || ''),
                workerType: String(u.workerType || ''),
                stack: Math.floor(Number(u.stackCount || 1)),
                watched: Math.max(0, Math.floor(Number(u.watched) || 0)),
                watchedByTeam: Number.isFinite(Number(u.watchedByTeam)) ? Math.floor(Number(u.watchedByTeam)) : -1
            }))
            .sort((a, b) => a.id - b.id),
        towers: towers
            .filter(tw => !!tw)
            .map(tw => ({
                gx: Math.floor(Number(tw.gx) || 0),
                gy: Math.floor(Number(tw.gy) || 0),
                owner: Math.floor(Number(tw.owner) || 0),
                type: String(tw.type || ''),
                level: Math.floor(Number(tw.level) || 1),
                energy: quantizeLockstepNumber(tw.energy),
                underConstruction: !!tw.underConstruction,
                isUpgrading: !!tw.isUpgrading,
                watched: Math.max(0, Math.floor(Number(tw.watched) || 0)),
                watchedByTeam: Number.isFinite(Number(tw.watchedByTeam)) ? Math.floor(Number(tw.watchedByTeam)) : -1
            }))
            .sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx) || (a.owner - b.owner)),
        barracks: barracks
            .filter(b => !!b)
            .map(b => ({
                gx: Math.floor(Number(b.gx) || 0),
                gy: Math.floor(Number(b.gy) || 0),
                owner: Math.floor(Number(b.owner) || 0),
                unitType: String(b.unitType || ''),
                level: Math.floor(Number(b.level) || 1),
                energy: quantizeLockstepNumber(b.energy),
                queueLen: Array.isArray(b.spawnQueue) ? b.spawnQueue.length : 0,
                underConstruction: !!b.underConstruction,
                isUpgrading: !!b.isUpgrading,
                watched: Math.max(0, Math.floor(Number(b.watched) || 0)),
                watchedByTeam: Number.isFinite(Number(b.watchedByTeam)) ? Math.floor(Number(b.watchedByTeam)) : -1
            }))
            .sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx) || (a.owner - b.owner)),
        spawners: collectorSpawners
            .filter(s => !!s)
            .map(s => ({
                gx: Math.floor(Number(s.gx) || 0),
                gy: Math.floor(Number(s.gy) || 0),
                owner: Math.floor(Number(s.owner) || 0),
                type: String(s.type || ''),
                level: Math.floor(Number(s.level) || 1),
                energy: quantizeLockstepNumber(s.energy),
                queueLen: Array.isArray(s.spawnQueue) ? s.spawnQueue.length : 0,
                underConstruction: !!s.underConstruction,
                isUpgrading: !!s.isUpgrading,
                watched: Math.max(0, Math.floor(Number(s.watched) || 0)),
                watchedByTeam: Number.isFinite(Number(s.watchedByTeam)) ? Math.floor(Number(s.watchedByTeam)) : -1
            }))
            .sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx) || (a.owner - b.owner)),
        floorItems: [],
        mines: goldMines
            .map(m => ({
                gx: Math.floor(Number(m.gx) || 0),
                gy: Math.floor(Number(m.gy) || 0),
                gold: Math.floor(Number(m.gold) || 0)
            }))
            .sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx)),
        astarMines: astarMines
            .map(m => ({
                gx: Math.floor(Number(m.gx) || 0),
                gy: Math.floor(Number(m.gy) || 0),
                astar: Math.floor(Number(m.astar) || 0)
            }))
            .sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx))
    };

    for (let gy = 0; gy < GRID_H; gy++) {
        for (let gx = 0; gx < GRID_W; gx++) {
            let cell = grid[gy][gx];
            if (!cell || !cell.item) continue;
            if ((cell.item instanceof Tower) || (cell.item instanceof Barrack) || isSpawnerEntity(cell.item)) continue;
            digest.floorItems.push({
                gx,
                gy,
                owner: Math.floor(Number(cell.owner) || 0),
                type: String(cell.item.type || ''),
                level: Math.floor(Number(cell.item.level) || 1),
                energy: quantizeLockstepNumber(cell.item.energy),
                underConstruction: !!cell.item.underConstruction,
                isUpgrading: !!cell.item.isUpgrading,
                watched: Math.max(0, Math.floor(Number(cell.item.watched) || 0)),
                watchedByTeam: Number.isFinite(Number(cell.item.watchedByTeam)) ? Math.floor(Number(cell.item.watchedByTeam)) : -1
            });
        }
    }

    return digest;
}

function computeLockstepStateHash(tick) {
    return computeLockstepStateHashFast(tick);
}

// Exact-lockstep debug mode: freeze the match at the first inconsistency so
// it can be inspected, instead of recovering.
function stopLockstepDebugMatch(reason, details = {}) {
    if (lockstepFatalStopActive) return;
    lockstepFatalStopActive = true;
    lockstepFatalStopTick = Math.floor(Number(currentTick) || 0);
    lockstepFatalStopReason = String(reason || 'lockstep mismatch');
    lockstepFatalStopDetails = details || null;
    try { console.error('[LOCKSTEP] Exact lockstep stopped the match:', lockstepFatalStopReason, details); } catch { }
    // (Detailed: names what differs. A plain notice arriving later must not
    // replace it: the channel is unordered.)
    let detailed = !!(details && ((Array.isArray(details.differs) && details.differs.length > 0) || details.detailed));
    if (lockstepFatalStopDetails) lockstepFatalStopDetails.detailed = detailed;
    if (isHost) {
        for (let c of connections) {
            if (!c) continue;
            try { c.send({ type: 'LOCKSTEP_FATAL_STOP', reason: lockstepFatalStopReason, tick: lockstepFatalStopTick, detailed }); } catch { }
        }
    } else {
        let hostConn = netGetHostConnection();
        if (hostConn) { try { hostConn.send({ type: 'LOCKSTEP_FATAL_STOP', reason: lockstepFatalStopReason, tick: lockstepFatalStopTick }); } catch { } }
    }
}

// Guest: ask the host for a full state snapshot. The guest stays paused until
// it arrives; the request repeats if the host never answers.
function requestHardLockstepResync(tick, reason = 'tick timeout', now = performance.now()) {
    if (isHost || !isMultiplayer || !gameStarted) return false;
    let conn = netGetHostConnection();
    if (!conn) return false;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return false;
    if (lockstepStrictDebugMode) {
        stopLockstepDebugMatch(String(reason || 'resync requested'), { tick: t });
        return false;
    }
    if (lockstepResyncRequestedAt && (now - lockstepResyncRequestedAt) < 4000) return false;

    lockstepLastHardResyncRequestAt = now;
    lockstepResyncRequestedAt = now;
    lockstepResyncPauseActive = true;
    waitingForRemoteSince = now;
    logLockstepWarning('Requesting full match sync', {
        tick: t,
        reason: String(reason || 'tick timeout')
    });
    try { conn.send({ type: 'REQUEST_MATCH_SYNC', tick: t, reason: String(reason || 'tick timeout') }); } catch { }
    return true;
}

function maybeRequestHardLockstepResync(now, tick, reason = 'tick timeout') {
    if (isHost || !isMultiplayer || !gameStarted || matchStartWaitingForReady || lockstepResyncPauseActive) return;
    requestHardLockstepResync(tick, reason, now);
}

// Guest: validate and commit the bundles the host sent.
function processDeferredGuestLockstepWindow(now, tick) {
    if (isHost) return;
    let baseTick = Math.floor(Number(tick));
    if (!Number.isFinite(baseTick) || baseTick < 0) return;
    let hostConn = netGetHostConnection();

    for (let key of Object.keys(lockstepPendingBundleByTick)) {
        let t = Math.floor(Number(key));
        let pendingBundle = lockstepPendingBundleByTick[key];
        delete lockstepPendingBundleByTick[key];
        if (!Number.isFinite(t) || t < baseTick || !pendingBundle) continue;
        if (!validateTickBundle(pendingBundle)) {
            _lockstepWarnRateLimited('bad-bundle', 'Bundle checksum mismatch; requesting resend', {
                tick: t,
                combinedChecksum: String(pendingBundle.combinedChecksum || '')
            });
            if (hostConn) { try { hostConn.send({ type: 'TICK_RESEND_REQUEST', tick: t, count: 1 }); } catch { } }
            delete lockstepPendingCommitByTick[t];
            continue;
        }
        lockstepBundleByTick[t] = pendingBundle;
    }

    for (let key of Object.keys(lockstepPendingCommitByTick)) {
        let t = Math.floor(Number(key));
        if (!Number.isFinite(t) || t < baseTick) { delete lockstepPendingCommitByTick[key]; continue; }
        let bundle = lockstepBundleByTick[t];
        if (!bundle) continue;
        let commitChecksum = lockstepPendingCommitByTick[key];
        delete lockstepPendingCommitByTick[key];
        if (String(bundle.combinedChecksum || '') !== String(commitChecksum || '')) {
            _lockstepWarnRateLimited('bad-commit', 'Commit checksum mismatch; requesting resend', { tick: t });
            delete lockstepBundleByTick[t];
            if (hostConn) { try { hostConn.send({ type: 'TICK_RESEND_REQUEST', tick: t, count: 1 }); } catch { } }
            continue;
        }
        lockstepCommittedByTick[t] = true;
        // (The simulation worker holds it from now on: it runs on time
        // whatever this page is doing.)
        if (typeof simClientNoteSealed === 'function') simClientNoteSealed(t, { actions: (bundle.packets || []).flatMap(p => Array.isArray(p.actions) ? p.actions : []), flush: !!bundle.flush, dk: bundle.dk | 0 || 1 });
        _guestResendIfSealedWithout(t, bundle, hostConn);
    }
}

// Guest: the host sealed this tick without our commands for it (our packet
// came too late, or was lost with a dropped link). Send the packet again:
// the host runs its commands on our next open tick (once, however many
// copies reach it).
function _guestResendIfSealedWithout(t, bundle, hostConn) {
    if (!hostConn) return;
    // (Commands queued while the link was down may not have a packet yet.)
    let own = lockstepLocalPacketByTick[t] || ((localInputBuffer[t] || []).length > 0 ? buildLocalTickPacket(t) : null);
    if (!own || !Array.isArray(own.actions) || own.actions.length === 0) return;
    let sealed = (bundle.packets || []).find(p => p && String(p.peerId) === String(myPeerId));
    let ids = new Set(((sealed && sealed.actions) || []).map(a => a && a.netId));
    if (own.actions.every(a => a && ids.has(a.netId))) return;
    try { hostConn.send({ type: 'TICK_PACKETS', packets: [own], m: matchStartSessionId || undefined }); netCounters.messagesOut++; } catch { }
}

// Guest: the next tick has not arrived. On a live channel it is only late,
// so wait; ask again with backoff in case it was lost over a reconnect.
function _guestRequestMissingBundle(t, now) {
    let hostConn = netGetHostConnection();
    if (!hostConn) return;
    let req = lockstepGuestWaitRequest;
    if (!req || req.tick !== t) {
        lockstepGuestWaitRequest = { tick: t, at: now, n: 0 };
        return;
    }
    let delay = getLockstepResendRequestDelayMs() * detPow(2, Math.min(4, req.n));
    if ((now - req.at) < delay) return;
    req.at = now;
    req.n++;
    netCounters.resendRequestsSent++;
    let count = 1 + Math.max(0, Math.floor(Number(LOCKSTEP_PIPELINE_TICKS) || 0));
    try { hostConn.send({ type: 'TICK_RESEND_REQUEST', tick: t, count }); } catch { }
    // Our own packets may be what the host is missing.
    sendLocalTickPacketWindow(t, true);
}

function getHostResendBundleForTick(tick) {
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return null;

    let liveBundle = lockstepBundleByTick[t];
    if (liveBundle) {
        return {
            bundle: liveBundle,
            committed: !!lockstepCommittedByTick[t]
        };
    }

    let historyBundle = lockstepHistoryByTick[t];
    if (!historyBundle || !Array.isArray(historyBundle.packets)) return null;
    let bundle = {
        tick: t,
        packets: historyBundle.packets,
        combinedChecksum: String(historyBundle.combinedChecksum || '')
    };
    // A patch's flush tick: the checksum covers the mark (and the step size).
    if (historyBundle.flush) bundle.flush = 1;
    if (historyBundle.dk > 1) bundle.dk = historyBundle.dk;
    return { bundle, committed: true };
}

function getHostOldestHistoryTick() {
    let oldest = Infinity;
    for (let key in lockstepHistoryByTick) {
        let t = Number(key);
        if (t < oldest) oldest = t;
    }
    return Number.isFinite(oldest) ? oldest : currentTick;
}

function handleIncomingTickResendRequest(conn, data) {
    let t = Math.floor(Number(data && data.tick));
    if (!Number.isFinite(t) || t < 0) return;
    let count = Math.max(1, Math.min(64, Math.floor(Number(data && data.count) || 1)));

    if (isHost) {
        // Legacy form: a guest asking the host to relay another peer's packet.
        if (data && data.packetPeerId && String(data.packetPeerId) !== String(conn && conn.peer)) return;
        netCounters.resendRequestsServed++;
        for (let tt = t; tt < t + count; tt++) {
            let resend = getHostResendBundleForTick(tt);
            if (!resend) {
                if (tt < currentTick) {
                    // Older than the kept history: only a snapshot can help.
                    try { conn.send({ type: 'TICK_UNAVAILABLE', tick: tt, oldest: getHostOldestHistoryTick() }); } catch { }
                }
                break;
            }
            try { conn.send({ type: 'TICK_BUNDLE', w: packTickBundleForWire(resend.bundle), c: 1 }); } catch { }
        }
        return;
    }

    let packetPeerId = data && data.packetPeerId ? String(data.packetPeerId) : '';
    if (packetPeerId && packetPeerId !== myPeerId) return;
    if (t < currentTick && !lockstepCommittedByTick[t]) {
        // The host is missing input for a tick we already ran: our states
        // cannot match. Only a snapshot resolves it.
        requestHardLockstepResync(currentTick, 'host asked for an executed tick');
    }
    if (data && data.rebuild) {
        for (let tt = t; tt < t + count; tt++) {
            if (!lockstepCommittedByTick[tt]) delete lockstepLocalPacketByTick[tt];
        }
    }
    netCounters.resendRequestsServed++;
    resendLocalTickPackets(t, count);
}

function driveStrictLockstep(now, tick) {
    if (!isMultiplayer) return;
    if (lockstepFatalStopActive) return;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return;
    if (isHost) {
        if (lockstepResyncPauseActive) {
            if (!waitingForRemoteSince) waitingForRemoteSince = now;
            if (lockstepResyncDeadlineAt && now > lockstepResyncDeadlineAt) {
                logLockstepWarning('Resync acknowledgements timed out; resuming', { pending: Object.keys(lockstepResyncPendingAckByPeer || {}).filter(pid => !lockstepResyncPendingAckByPeer[pid]) });
                _finishHostResyncPause('ack timeout');
            }
            return;
        }
        if (matchStartWaitingForReady) {
            if (!waitingForRemoteSince) waitingForRemoteSince = now;
            return;
        }
        _hostAdvanceBundles(now);
        if (!lockstepBundleByTick[t]) _hostRequestMissingPackets(t, now);
        return;
    }

    if (lockstepResyncPauseActive) {
        if (!waitingForRemoteSince) waitingForRemoteSince = now;
        // Waiting for a snapshot that never came (lost request, host busy).
        // (Not while the simulation worker restores one: acknowledged once
        // it has, however long that takes.)
        if (!lockstepResyncRequestedAt) lockstepResyncRequestedAt = now;
        else if (typeof simClientLoading === 'function' && simClientLoading()) lockstepResyncRequestedAt = now;
        else if ((now - lockstepResyncRequestedAt) > 8000) {
            lockstepResyncRequestedAt = 0;
            requestHardLockstepResync(t, 'resync timeout', now);
        }
        return;
    }
    if (matchStartWaitingForReady) {
        if (!waitingForRemoteSince) waitingForRemoteSince = now;
        // Pre-send the first ticks during the start countdown so the host
        // can seal them the moment the match begins.
        if (gameStarted) {
            processDeferredGuestLockstepWindow(now, t);
            sendLocalTickPacketWindow(t);
        }
        return;
    }
    if (lockstepDesyncDetected) {
        requestHardLockstepResync(t, 'state hash mismatch', now);
        return;
    }

    processDeferredGuestLockstepWindow(now, t);
    sendLocalTickPacketWindow(t);
    if (!lockstepCommittedByTick[t]) _guestRequestMissingBundle(t, now);
}

function isStrictTickReady(tick) {
    if (!isMultiplayer) return true;
    if (lockstepFatalStopActive) return false;
    if (lockstepResyncPauseActive) return false;
    if (matchStartWaitingForReady) return false;
    if (!isHost && lockstepDesyncDetected) return false;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return false;
    return !!lockstepCommittedByTick[t] && !!lockstepBundleByTick[t];
}

// Guest: ticks sealed by the host but not yet run. Normally a few; more
// means this client fell behind and should run faster for a while.
function getLockstepBufferedTicks(limit = 400) {
    let n = 0;
    while (n < limit && lockstepCommittedByTick[currentTick + n] && lockstepBundleByTick[currentTick + n]) n++;
    return n;
}

let _researchPopupRefreshRequested = false;

function requestResearchPopupRefresh() {
    _researchPopupRefreshRequested = true;
}

function flushTickUiRequests() {
    if (!_researchPopupRefreshRequested) return;
    _researchPopupRefreshRequested = false;
    let researchPopup = document.getElementById('research-popup');
    if (researchPopup && !researchPopup.classList.contains('hidden') && !researchQueueDragInProgress) {
        renderResearchPopupContent();
    }
}

function runOneTick() {
    // Simulation worker check (?simworker=shadow): the worker starts from the
    // same snapshot, restored on the page too (as a multiplayer host does).
    if (typeof simShadowEnabled !== 'undefined' && simShadowEnabled && _simShadowMatchTick !== currentTick && !_simShadowStartedThisMatch) {
        _simShadowStartedThisMatch = true;
        let text = JSON.stringify(buildHostAuthoritativeStateSnapshot({ includeConfig: false, includeStaticMapState: true, includeGridTypes: true }));
        applyAuthoritativeStateSnapshot(JSON.parse(text));
        simShadowStartMatch(text);
    }
    // Simulation worker (?simworker=1): it starts from the page's state at
    // the match's first tick.
    if (typeof simClientEnabled !== 'undefined' && simClientEnabled && !simClientActive() && !_simClientStartedThisMatch) {
        _simClientStartedThisMatch = true;
        simClientStartMatch();
    }
    let inWorker = typeof simClientActive === 'function' && simClientActive();
    // Reset pathfinding budget before processing actions
    pathfindBudget = 0;
    let processedTick = currentTick;
    let tickWorkStart = performance.now();

    if (isHost && isMultiplayer) {
        // Sealed bundles are never mutated, so the history keeps the object
        // itself. Only a bounded window is kept for resends and soft rejoins.
        let b = lockstepBundleByTick[currentTick];
        if (b && Array.isArray(b.packets)) lockstepHistoryByTick[currentTick] = b;
        delete lockstepHistoryByTick[currentTick - getLockstepHistoryKeepTicks()];
    }

    // A resync tick: every peer starts it without history caches, like the
    // peer that is restored from a patch.
    let flushTick = !!(isMultiplayer && lockstepBundleByTick[currentTick] && lockstepBundleByTick[currentTick].flush);
    if (flushTick && !inWorker) snapFlushHistoryCaches();
    // The step's base ticks: the sealed bundle's in a match, this machine's
    // pace alone.
    let stepDk = isMultiplayer
        ? Math.max(1, (lockstepBundleByTick[currentTick] && lockstepBundleByTick[currentTick].dk) | 0)
        : netStepTicks();
    // (Its commands' budgets are the step's: simDk before them.)
    if (!inWorker) simDk = stepDk;

    // Process deterministic combined actions for this tick.
    let allActs = isMultiplayer
        ? ((lockstepBundleByTick[currentTick] && Array.isArray(lockstepBundleByTick[currentTick].packets))
            ? lockstepBundleByTick[currentTick].packets.flatMap(p => Array.isArray(p.actions) ? p.actions : [])
            : [])
        : (localInputBuffer[currentTick] || []);
    if (isMultiplayer && lockstepBundleByTick[currentTick]) lockstepNoteRanCommands(lockstepBundleByTick[currentTick].packets, currentTick);
    let teams = (activeTeamIds && activeTeamIds.length > 0) ? [...activeTeamIds].sort((a, b) => a - b) : [0, 1];
    // Commands of the same tick that compete (the same tile, the same
    // target) go to each team in turn: the first team to act rotates.
    let firstTeam = processedTick % teams.length;
    for (let k = 0; k < teams.length && !inWorker; k++) {
        let teamId = teams[(firstTeam + k) % teams.length];
        let acts = allActs.filter(a => (a.teamId ?? 0) === teamId);
        if (acts.length > 0) {
            try { processActions(acts, teamId); } catch (err) { reportRuntimeError('actions', err); }
        }
    }

    if (isMultiplayer && !isHost) lockstepNoteUnconfirmed(localInputBuffer[currentTick], currentTick);
    delete localInputBuffer[currentTick];
    delete lockstepLocalPacketByTick[currentTick];
    delete lockstepHostPacketsByTick[currentTick];
    delete lockstepBundleByTick[currentTick];
    delete lockstepPendingBundleByTick[currentTick];
    delete lockstepPendingCommitByTick[currentTick];
    delete lockstepCommittedByTick[currentTick];
    delete lockstepLastPacketSentAtByTick[currentTick];
    delete lockstepLastBundleSentAtByTick[currentTick];
    delete lockstepLastResendRequestAtByTick[currentTick];

    // A bug in one tick must not stop the game (or, in multiplayer, everyone
    // waiting on this peer). The tick still completes: a deterministic error
    // happens identically on every peer, anything else shows up in the state
    // hash and is repaired by a resync.
    if (inWorker) {
        // The worker runs it; the page applies the result when it comes
        // (sim_client.js), including the per-tick page work below. (One the
        // worker ran by itself, lockstepAdoptAutoTick: only noted.)
        if (_lockstepAdoptingTick) simClientNoteAutoTick(processedTick, _lockstepAdoptingTick.due);
        else simClientRunTick(processedTick, allActs, teams, flushTick, stepDk);
    } else {
        simDk = stepDk;
        try { gameTick(); } catch (err) { reportRuntimeError('tick', err); }
        netNoteSimulationTick(performance.now(), performance.now() - tickWorkStart);
        if (typeof simShadowEnabled !== 'undefined' && simShadowEnabled) simShadowAfterTick(processedTick, allActs, teams, flushTick, stepDk);

        gameStatsStep(currentTick);
        if (currentTick % TICK_RATE === 0) sampleGameStats();
        requestResearchPopupRefresh();

        // Every peer hashes a slice of the state each tick; guests compare
        // with the host's (see utils_resync.js).
        if (isMultiplayer) resyncAfterTick(processedTick);
    }

    _tpsTickCount++;
    let tpsNow = performance.now();
    if (tpsNow - _tpsLastTime >= 1000) {
        _tpsDisplay = Math.round(_tpsTickCount * 1000 / (tpsNow - _tpsLastTime));
        _tpsTickCount = 0;
        _tpsLastTime = tpsNow;
    }

    currentTick++;
}

Object.assign(globalThis, {
    gameTick,
    screenToWorld,
    initInput,
    startGame,
    runOneTick,
    getPlayerUpKeepBreakdown: _getPlayerUpKeepBreakdown,
});
