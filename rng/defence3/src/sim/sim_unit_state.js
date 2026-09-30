"use strict";
// Authoritative numeric unit state. Float64 preserves JavaScript arithmetic;
// Float32 is reserved for render frames. Unit objects retain cold/reference
// fields and expose these columns through prototype accessors during migration.
// Slots are local addresses, never IDs or part of snapshots/lockstep hashes.
// Status effects: counted down (and their damage dealt) for every unit at
// once by SIM_KERNEL_STATUS (see statusPrepassRun in unit.js).
const SIM_UNIT_STATUS_COLUMNS = ['teleportHideTicks', 'burning', 'burnTickDamage', 'poisoned', 'poisonTickDamage',
    'frozen', 'iceTickDamage', 'wet', 'sandy', 'watched', 'workerTransferCooldown'];
const SIM_UNIT_COLUMNS = ['id', 'owner', 'x', 'y', 'prevX', 'prevY', 'vx', 'vy',
    'energy', 'r', 'collisionR', 'pathIndex', 'commandState', 'attackTimer', 'attackFlash', ...SIM_UNIT_STATUS_COLUMNS];
// Read and written through prototype accessors: the columns are the state
// (the movement kernel moves units without touching their objects).
const SIM_UNIT_ACCESSOR_COLUMNS = ['id', 'owner', 'x', 'y', 'prevX', 'prevY', 'vx', 'vy', 'energy', 'pathIndex', 'commandState', 'attackTimer', 'attackFlash', ...SIM_UNIT_STATUS_COLUMNS];
// Radii: plain fields on the unit, copied into the columns by
// simUnitMirror (the spatial index calls it; they rarely change).
const SIM_UNIT_MIRROR_COLUMNS = ['r', 'collisionR'];
// Accessor keys that are not columns (see simUnitStateKeys): the path is a
// plain reference behind a setter that disarms the movement kernel.
const SIM_UNIT_EXTRA_ACCESSORS = ['path', 'workerState', '_workerNextIdleRetargetTick', 'dead', '_navLastD'];

function simUnitMirror(u) {
    const c = u._us;
    if (!c) return;
    const s = u._si;
    c.r[s] = u.r; c.collisionR[s] = u.collisionR;
}

// Per-slot state of the movement kernel (see sim_move.js), in the columns
// object too (unit accessors disarm through it). [name, type, per slot].
const SIM_MOVE_WINDOW = 16;
const SIM_MOVE_COLUMNS = [['mvOn', Uint8Array, 1], ['mvOut', Uint8Array, 1], ['mvFlags', Uint8Array, 1],
    ['mvZmask', Uint16Array, 1], ['mvSpd', Float64Array, 1], ['mvLane', Float64Array, 1], ['mvCost', Float64Array, 1],
    ['mvSpent', Uint8Array, 1], ['mvReach', Uint8Array, 1], ['mvBase', Int32Array, 1], ['mvWlen', Uint8Array, 1],
    ['mvPlen', Int32Array, 1], ['mvScan', Int32Array, 1], ['mvFloor', Int32Array, 1], ['mvNodes', Int32Array, SIM_MOVE_WINDOW],
    // Parked idle workers (mvOn 2): the tick their Unit.update next does anything.
    ['mvWake', Int32Array, 1],
    // Flow mode (mvFlags 64): the flow slot and its generation, and the
    // destination tile. Stats kept current for orders that arm units
    // without reading them (see simMoveStatsChanged).
    ['mvFlow', Int32Array, 1], ['mvFGen', Int32Array, 1], ['mvDest', Int32Array, 1],
    ['mvReachD', Uint8Array, 1], ['mvReachA', Uint8Array, 1], ['mvShoot', Uint8Array, 1],
    // Flow mode's look-ahead from tile mvNavT (-1 none), made with the
    // navigation build mvNavV, wall version mvNavW and destination field
    // generation mvNavG: the next tile, the one after, the farthest one
    // it heads straight for, and whether that is over open ground.
    ['mvNavT', Int32Array, 1], ['mvNavV', Int32Array, 1], ['mvNavW', Int32Array, 1], ['mvNavG', Int32Array, 1],
    ['mvNavN1', Int32Array, 1], ['mvNavN2', Int32Array, 1], ['mvNavFar', Int32Array, 1], ['mvNavOpen', Uint8Array, 1],
    // The combat scan (SIM_KERNEL_COMBAT_SCAN): its aggro range (pixels),
    // and at tick cbTick the nearest visible enemy's slot (-1 none).
    ['cbRange', Float64Array, 1], ['cbT', Int32Array, 1], ['cbTick', Int32Array, 1],
    // Flow mode: the tick its route may start (see navFieldReadyTick).
    ['mvReady', Int32Array, 1],
    // Attack hold (mvOn 3; see simMoveTryHold): the target's slot and id,
    // the target's tile, and the unit's own tile and window zone, as when
    // the hold began.
    ['mvHT', Int32Array, 1], ['mvHTId', Int32Array, 1], ['mvHTT', Int32Array, 1], ['mvHOT', Int32Array, 1], ['mvHOZ', Int8Array, 1],
    // The status pre-pass's events (1 damaged, 2 its watch ended, 4 died)
    // and the damage dealt.
    ['stEv', Uint8Array, 1], ['stDot', Float64Array, 1],
    // Its position at the start of the unit pass (the pre-pass copies it):
    // where other units see it during the pass (see _unitTickX).
    ['x0', Float64Array, 1], ['y0', Float64Array, 1],
    // Flow mode: 1 for a worker (handed back on its check ticks, see
    // WORKER_MOVE_CHECK_TICKS).
    ['mvWk', Uint8Array, 1],
    // Unit._navLastD (-1 none): its distance to a group's destination last
    // tick (arriving in a crowd), one value for Unit.update and the kernel.
    ['mvNavLD', Float64Array, 1],
    // Unit.dead (1 dead), so the tick's dead-unit pass need not read objects.
    ['dead', Uint8Array, 1],
    // Where the spatial index and the visibility coverage have the unit
    // (Unit accessors _spatialTile... and _vsGen...; see chunk.js and
    // renderer.js), so their updates need not read the unit object.
    ['spTile', Int32Array, 1], ['spArea', Int32Array, 1], ['spOwner', Int32Array, 1], ['spEpoch', Int32Array, 1],
    ['spZone', Int8Array, 1], ['spType', Int16Array, 1], ['vsGen', Int32Array, 1], ['vsR', Int8Array, 1],
    ['vsA', Int32Array, 1], ['vsP1', Int8Array, 1], ['vsP2', Int8Array, 1], ['vsList', Int32Array, 1]];
// Accessor defaults (the "not indexed / not registered" values).
const SIM_SPATIAL_DEFAULTS = { spTile: -1, spArea: -2, spOwner: -1, spEpoch: 0, spZone: -1, spType: -1, vsGen: 0, vsR: -1, vsA: -1, vsP1: -1, vsP2: -1, vsList: -1 };
let _simUnitState = null;
// Per-slot inputs of the collision pass, kept current by the spatial index
// (not read from unit objects every tick): the unit's chunk, or
// SIM_SEP_ABSENT when it is not indexed, and its layer (0 ground, 1 flying,
// 2 mole).
const SIM_SEP_ABSENT = 0xFFFFFF;

function simUnitStateReset() {
    // A whole-world replacement needs no slot recycling. Old objects retain
    // their own generation's columns, but no registry keeps its owners alive.
    _simUnitState = null;
    for (const k of SIM_UNIT_COLUMNS) simParallelBind('unit.' + k, null);
}

// The columns object has one fixed shape, every column declared up front by
// name: built by adding computed keys one by one, V8 turned it into a
// dictionary, and every unit accessor (x, y, owner...) did a hash lookup.
let _SimUnitColumns = null;
function _simUnitColumnsObject() {
    if (!_SimUnitColumns) {
        const names = [...SIM_UNIT_COLUMNS, ...SIM_MOVE_COLUMNS.map(c => c[0]), 'sepKey'];
        _SimUnitColumns = new Function(names.map(n => 'this.' + n + ' = null;').join(' '));
    }
    return new _SimUnitColumns();
}

function simUnitStateAllocate(u) {
    let S = _simUnitState;
    if (!S) S = _simUnitState = { cap: 0, owners: [], free: [], columns: _simUnitColumnsObject(), stamp: null, epoch: 0, unitsRef: null };
    const s = S.free.length ? S.free.pop() : S.owners.length;
    if (s >= S.cap) {
        const cap = Math.max(1024, S.cap * 2);
        for (const k of SIM_UNIT_COLUMNS) {
            const a = simSharedArray(Float64Array, cap);
            if (S.columns[k]) a.set(S.columns[k]);
            S.columns[k] = a;
            simParallelBind('unit.' + k, a);
        }
        for (const [k, Type, per] of SIM_MOVE_COLUMNS) {
            const a = simSharedArray(Type, cap * per);
            if (S.columns[k]) a.set(S.columns[k]);
            S.columns[k] = a;
            simParallelBind('unit.' + k, a);
        }
        const stamp = new Uint32Array(cap);
        if (S.stamp) stamp.set(S.stamp);
        S.stamp = stamp;
        const sepKey = simSharedArray(Uint32Array, cap), sepLayer = simSharedArray(Uint8Array, cap);
        sepKey.fill(SIM_SEP_ABSENT);
        if (S.sepKey) { sepKey.set(S.sepKey); sepLayer.set(S.sepLayer); }
        S.sepKey = sepKey; S.sepLayer = sepLayer; S.columns.sepKey = sepKey;
        simParallelBind('unit.sepKey', sepKey); simParallelBind('unit.sepLayer', sepLayer);
        S.cap = cap;
    }
    S.sepKey[s] = SIM_SEP_ABSENT;
    S.columns.mvOn[s] = 0; S.columns.mvOut[s] = 0; S.columns.mvZmask[s] = 0; S.columns.dead[s] = 0; S.columns.mvNavT[s] = -1; S.columns.mvNavLD[s] = -1;
    for (const k in SIM_SPATIAL_DEFAULTS) S.columns[k][s] = SIM_SPATIAL_DEFAULTS[k];
    S.owners[s] = u;
    Object.defineProperties(u, { _us: { value: S.columns, writable: true }, _si: { value: s, writable: true }, _det: { value: null, writable: true },
        _path: { value: null, writable: true }, _ws: { value: undefined, writable: true }, _wnr: { value: undefined, writable: true } });
}

// Removed units may still be attack targets, selected, or referenced in a
// snapshot. Detach their values before reusing the slot; stale object references
// must never read or overwrite a newly spawned unit.
function simUnitStateDetach(S, s) {
    const u = S.owners[s];
    if (!u) return;
    // Its values move to one plain object the accessors fall back to (a
    // property definition per column made releasing many units slow).
    const values = {};
    for (const k of SIM_UNIT_ACCESSOR_COLUMNS) values[k] = S.columns[k][s];
    values.dead = S.columns.dead[s] === 1;
    values._navLastD = S.columns.mvNavLD[s];
    u._det = values;
    u._us = null; u._si = -1;
    S.sepKey[s] = SIM_SEP_ABSENT;
    S.columns.mvOn[s] = 0; S.columns.mvOut[s] = 0;
    S.owners[s] = null; S.free.push(s);
}

// The spatial index reports where a unit is (chunk key, layer) or that it
// left (key SIM_SEP_ABSENT).
function simUnitSetSepKey(u, key, layer) {
    const S = _simUnitState;
    if (!S || u._us !== S.columns) return;
    S.sepKey[u._si] = key;
    S.sepLayer[u._si] = layer;
}

// Every slot leaves the index (the spatial buckets were replaced).
function simUnitClearSepKeys() {
    if (_simUnitState) _simUnitState.sepKey.fill(SIM_SEP_ABSENT);
}

// Slots of removed units are reclaimed by a sliced sweep: every removal
// path marks the unit dead, and each tick checks 1/SIM_UNIT_COLLECT_SLICES
// of the slots (a dead unit keeps its values, detached, for any reference
// still holding it).
const SIM_UNIT_COLLECT_SLICES = 64;
function simUnitStateCollect(all = false) {
    const S = _simUnitState;
    if (!S) return;
    const owners = S.owners;
    // The units array was replaced (a new match, a restore): every slot whose
    // unit is not in it is released at once (they need not be dead).
    if (S.unitsRef !== units) {
        S.unitsRef = units;
        if (++S.epoch === 0xffffffff) { S.stamp.fill(0); S.epoch = 1; }
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (u && u._us === S.columns) S.stamp[u._si] = S.epoch;
        }
        for (let s = 0; s < owners.length; s++) if (owners[s] && S.stamp[s] !== S.epoch) simUnitStateDetach(S, s);
        return;
    }
    const step = all ? 1 : SIM_UNIT_COLLECT_SLICES;
    for (let s = all ? 0 : (typeof gameTime === 'number' ? gameTime : 0) % step; s < owners.length; s += step) {
        const u = owners[s];
        if (u && u.dead) simUnitStateDetach(S, s);
    }
}

// Serialization enumerates gameplay fields, including prototype columns.
function simUnitStateKeys(u) {
    const keys = Object.keys(u);
    if (u._us || u._det) for (const k of SIM_UNIT_ACCESSOR_COLUMNS) keys.push(k);
    if (u instanceof Unit) for (const k of SIM_UNIT_EXTRA_ACCESSORS) if (!Object.prototype.hasOwnProperty.call(u, k)) keys.push(k);
    return keys;
}
