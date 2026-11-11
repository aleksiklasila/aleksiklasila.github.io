'use strict';
// The presentation worker's wasm frame passes (presentation_worker.js:
// frameIdOrder, buildRenderBuckets) for a test's vm context: the worker runs
// in a context of its own (its module over its memory and a small
// simulation memory); its functions are set on ctx, and frames made by hand
// are moved into its memory (the kernels read and write only there).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const COLS = ['x', 'y', 'px', 'py', 'id', 'order'];
module.exports = function presentPm(ctx) {
    const dir = path.join(__dirname, '../src/sim');
    const w = vm.createContext({ console, performance, setTimeout() { }, postMessage() { } });
    w.self = w;
    w.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(dir, f.split('?')[0]), 'utf8'), w); };
    vm.runInContext(fs.readFileSync(path.join(dir, 'presentation_worker.js'), 'utf8'), w);
    vm.runInContext('pmInit(new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true }))', w);
    ctx.frameIdOrder = (F, count) => w.frameIdOrder(F, count);
    ctx.buildRenderBuckets = (F, count, columns, rows, tile) => w.buildRenderBuckets(F, count, columns, rows, tile);
    const pm = vm.runInContext('pm', w), slot = vm.runInContext('SIM_FRAME_SLOT_BYTES', w);
    return {
        // F's x, y, px, py, id and order (as they are) into a region of cap
        // slots and the buckets of cells; F's views replaced; F.buf, F.base set.
        frame(F, cells) {
            const cap = F.cap;
            const r = w.pmAlloc(cap * slot + cells * 8 + cap * 8);
            const buf = pm.mem.buffer;
            COLS.forEach((k, i) => {
                const T = k === 'id' || k === 'order' ? Int32Array : Float32Array, v = new T(buf, r.base + i * 4 * cap, cap);
                if (F[k]) v.set(F[k].subarray ? F[k].subarray(0, cap) : F[k]);
                F[k] = v;
            });
            F.buf = buf; F.base = r.base;
            return F;
        },
        // Arrays of n in its memory (ids, orders made by hand).
        array(T, n) { const r = w.pmAlloc(n * T.BYTES_PER_ELEMENT); return new T(pm.mem.buffer, r.base, n); }
    };
};
