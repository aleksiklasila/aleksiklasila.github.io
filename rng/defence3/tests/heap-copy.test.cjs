// simParallelCopyHeap (sim_parallel.js, Rust k_copy): many typed arrays in
// the wasm heap, of odd lengths and element types, copied as one parallel
// job over 1 MB pieces of their concatenation: every destination equals its
// source, the bytes past a shorter source untouched; the same with real
// helper threads (7) and with none. Prints the time against set().
//   node tests/heap-copy.test.cjs
'use strict';
globalThis.self = { crossOriginIsolated: true };
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const { performance } = require('node:perf_hooks');
for (const helpers of [7, 0]) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS } });
    const inst = world.spawn('copy' + helpers, { simWorker: false });
    inst.eval('startSoloGame();');
    inst.scratch.now = () => performance.now();
    if (helpers) {
        inst.scratch.Worker = require('./real-sim-helper.cjs');
        assert.equal(inst.eval(`Worker = __scratch.Worker; navigator.hardwareConcurrency = 32; simParallelInit('', ${helpers})`), helpers);
    }
    const r = JSON.parse(inst.eval(`JSON.stringify((() => {
        let seed = 99;
        const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        const types = [Uint8Array, Int32Array, Float32Array, Float64Array, Uint16Array];
        const pairs = [], keep = [];
        let bytes = 0;
        for (let i = 0; i < 190; i++) {
            const T = types[i % types.length], n = 1 + Math.floor(rnd() * 60000), extra = i % 3 === 0 ? 1 + Math.floor(rnd() * 500) : 0;
            const src = simHeapArray(T, n), dst = simHeapArray(T, n + extra);
            const sb = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
            for (let k = 0; k < sb.length; k++) sb[k] = (k * 31 + i * 7) & 255;
            const db = new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength);
            db.fill(0xAB);
            pairs.push(dst, src); keep.push([dst, src, extra]);
            bytes += src.byteLength;
        }
        // (Twice: the first binds the copy table, which helpers take between jobs.)
        simParallelCopyHeap(pairs);
        const a = __scratch.now();
        simParallelCopyHeap(pairs);
        const ms = __scratch.now() - a;
        let bad = '';
        for (const [dst, src] of keep) {
            const db = new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength), sb = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
            for (let k = 0; k < sb.length && !bad; k++) if (db[k] !== sb[k]) bad = 'byte ' + k + ' of a ' + src.constructor.name;
            for (let k = sb.length; k < db.length && !bad; k++) if (db[k] !== 0xAB) bad = 'past the source, byte ' + k;
            if (bad) break;
        }
        // set() for comparison, the same copies.
        const b = __scratch.now();
        for (let i = 0; i < pairs.length; i += 2) pairs[i].set(pairs[i + 1]);
        const setMs = __scratch.now() - b;
        return { bad, MB: Math.round(bytes / 1048576), ms: Math.round(ms * 10) / 10, setMs: Math.round(setMs * 10) / 10 };
    })())`));
    assert.equal(r.bad, '', helpers + ' helpers: ' + r.bad);
    console.log(helpers + ' helpers: ' + r.MB + ' MB in 190 arrays copied in ' + r.ms + ' ms (set(): ' + r.setMs + ' ms)');
}
console.log('PASS: parallel heap copies equal their sources');
process.exit(0);
