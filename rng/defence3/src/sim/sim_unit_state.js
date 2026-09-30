"use strict";
// Authoritative numeric unit state. Float64 preserves JavaScript arithmetic;
// Float32 is reserved for render frames. Unit objects retain cold/reference
// fields and expose these columns through prototype accessors during migration.
// Slots are local addresses, never IDs or part of snapshots/lockstep hashes.
const SIM_UNIT_COLUMNS = ['id', 'owner', 'x', 'y', 'prevX', 'prevY', 'vx', 'vy',
    'energy', 'r', 'collisionR', 'pathIndex', 'commandState'];
// Read through prototype accessors from the columns: small integers, and
// energy (changed from many places, and render frames must see it exact).
const SIM_UNIT_ACCESSOR_COLUMNS = ['id', 'owner', 'energy', 'pathIndex', 'commandState'];
// Fractional values: plain fields on the unit (a double read through an
// accessor from a typed array is boxed into a new heap number on every
// read that is not inlined, which in the per-unit code was most of the
// garbage), copied into the columns by simUnitMirror, which the spatial
// index calls after every move (see updateUnitSpatial): the kernels and
// render frames read them there.
const SIM_UNIT_MIRROR_COLUMNS = ['x', 'y', 'prevX', 'prevY', 'vx', 'vy', 'r', 'collisionR'];

function simUnitMirror(u) {
    const c = u._us;
    if (!c) return;
    const s = u._si;
    c.x[s] = u.x; c.y[s] = u.y; c.prevX[s] = u.prevX; c.prevY[s] = u.prevY;
    c.vx[s] = u.vx; c.vy[s] = u.vy; c.r[s] = u.r; c.collisionR[s] = u.collisionR;
}
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

function simUnitStateAllocate(u) {
    let S = _simUnitState;
    if (!S) S = _simUnitState = { cap: 0, owners: [], free: [], columns: {}, stamp: null, epoch: 0, unitsRef: null };
    const s = S.free.length ? S.free.pop() : S.owners.length;
    if (s >= S.cap) {
        const cap = Math.max(1024, S.cap * 2);
        for (const k of SIM_UNIT_COLUMNS) {
            const a = simSharedArray(Float64Array, cap);
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
        S.sepKey = sepKey; S.sepLayer = sepLayer;
        simParallelBind('unit.sepKey', sepKey); simParallelBind('unit.sepLayer', sepLayer);
        S.cap = cap;
    }
    S.sepKey[s] = SIM_SEP_ABSENT;
    S.owners[s] = u;
    Object.defineProperties(u, { _us: { value: S.columns, writable: true }, _si: { value: s, writable: true }, _det: { value: null, writable: true } });
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
    u._det = values;
    u._us = null; u._si = -1;
    S.sepKey[s] = SIM_SEP_ABSENT;
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
    return keys;
}
