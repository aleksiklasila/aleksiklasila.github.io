"use strict";
// Authoritative numeric unit state. Float64 preserves JavaScript arithmetic;
// Float32 is reserved for render frames. Unit objects retain cold/reference
// fields and expose these columns through prototype accessors during migration.
// Slots are local addresses, never IDs or part of snapshots/lockstep hashes.
const SIM_UNIT_COLUMNS = ['id', 'owner', 'x', 'y', 'prevX', 'prevY', 'vx', 'vy',
    'energy', 'r', 'collisionR', 'pathIndex', 'commandState'];
let _simUnitState = null;

function simUnitStateReset() {
    // A whole-world replacement needs no slot recycling. Old objects retain
    // their own generation's columns, but no registry keeps its owners alive.
    _simUnitState = null;
    for (const k of SIM_UNIT_COLUMNS) simParallelBind('unit.' + k, null);
}

function simUnitStateAllocate(u) {
    let S = _simUnitState;
    if (!S) S = _simUnitState = { cap: 0, owners: [], free: [], columns: {}, stamp: null, epoch: 0 };
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
        S.stamp = stamp; S.cap = cap;
    }
    S.owners[s] = u;
    Object.defineProperties(u, { _us: { value: S.columns, writable: true }, _si: { value: s, writable: true } });
}

// Removed units may still be attack targets, selected, or referenced in a
// snapshot. Detach their values before reusing the slot; stale object references
// must never read or overwrite a newly spawned unit.
function simUnitStateDetach(S, s) {
    const u = S.owners[s];
    if (!u) return;
    for (const k of SIM_UNIT_COLUMNS) Object.defineProperty(u, k,
        { value: S.columns[k][s], writable: true, enumerable: true, configurable: true });
    u._us = null; u._si = -1;
    S.owners[s] = null; S.free.push(s);
}

function simUnitStateCollect() {
    const S = _simUnitState;
    if (!S) return;
    if (++S.epoch === 0xffffffff) { S.stamp.fill(0); S.epoch = 1; }
    for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (u._us === S.columns) S.stamp[u._si] = S.epoch;
    }
    for (let s = 0; s < S.owners.length; s++) if (S.owners[s] && S.stamp[s] !== S.epoch) simUnitStateDetach(S, s);
}

// Serialization enumerates gameplay fields, including prototype columns.
function simUnitStateKeys(u) {
    const keys = Object.keys(u);
    if (u._us) for (const k of SIM_UNIT_COLUMNS) keys.push(k);
    return keys;
}
