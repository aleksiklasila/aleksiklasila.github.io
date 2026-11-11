'use strict';
// A simulation heap for tests that drive the presentation worker
// (presentation_worker.js reads the simulation's columns in place, as the
// second memory of its kernels): a shared wasm memory, the unit columns of
// the types the simulation has (sim_unit_state.js: positions Int32 eighths
// of a pixel, owners Int8, timers Uint16...), the status records' timers
// and the presentation metadata table there.
//   const H = presentSim(ctx, cap, { records, cols });  H.C, H.M, H.memory, H.bind(extra)
const TYPES = {
    id: Int32Array, owner: Int8Array, x: Int32Array, y: Int32Array, prevX: Int32Array, prevY: Int32Array, vx: Float32Array, vy: Float32Array,
    energy: Float32Array, r: Float32Array, commandState: Uint8Array, attackFlash: Uint8Array, workerTransferCooldown: Uint16Array,
    effectiveLevel: Int8Array, unitLevel: Int8Array, live: Uint8Array, dead: Uint8Array, maxE: Float32Array, stIx: Int32Array,
    cmMode: Uint8Array, cmT: Int32Array, pvAt: Int32Array, pvOD: Int32Array,
    stBu: Uint16Array, stPo: Uint16Array, stFr: Uint16Array, stWe: Uint16Array, stSa: Uint16Array, stWa: Uint16Array, stTh: Uint16Array
};
const BASE = ['id', 'owner', 'x', 'y', 'prevX', 'prevY', 'vx', 'vy', 'energy', 'r', 'commandState', 'attackFlash', 'stBu', 'stPo', 'stFr', 'stWe', 'stSa', 'stWa', 'stTh',
    'workerTransferCooldown', 'effectiveLevel', 'unitLevel', 'live', 'dead', 'maxE', 'stIx'];
function pixelView(a) {
    return new Proxy(a, {
        get(t, k) { if (typeof k === 'string' && /^\d+$/.test(k)) return t[k] / 8; const v = t[k]; return typeof v === 'function' && k !== 'constructor' ? v.bind(t) : v; },
        set(t, k, v) { if (typeof k === 'string' && /^\d+$/.test(k)) t[k] = Math.round(v * 8); else t[k] = v; return true; }
    });
}
module.exports = function presentSim(ctx, cap, opts = {}) {
    const records = opts.records || cap + 1;
    const cols = [...BASE, ...(opts.cols || [])];
    const memory = new WebAssembly.Memory({ initial: 16, maximum: 65536, shared: true });
    let top = 1024;
    const arr = (T, n) => {
        top = Math.ceil(top / 8) * 8;
        const end = top + n * T.BYTES_PER_ELEMENT;
        if (end > memory.buffer.byteLength) memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
        const a = new T(memory.buffer, top, n); top = end; return a;
    };
    const C = {};
    for (const k of cols) C[k] = arr(TYPES[k], k.startsWith('st') && k !== 'stIx' ? records : cap);
    // (opts.pixels: x, y, prevX, prevY read and written in pixels here, as
    // eighths in the heap, rounded as the simulation's setters round.)
    if (opts.pixels) for (const k of ['x', 'y', 'prevX', 'prevY']) C[k] = pixelView(C[k]);
    const slot = require('node:vm').runInContext('SIM_META_SLOT_BYTES', ctx);
    const mb = arr(Uint8Array, cap * slot);
    const M = ctx.simMetaViews(memory.buffer, cap, mb.byteOffset);
    return { memory, C, M, arr, bind: extra => ({ type: 'bind', simMemory: memory, columns: C, meta: { buf: memory.buffer, cap, off: mb.byteOffset }, ...extra }) };
};
