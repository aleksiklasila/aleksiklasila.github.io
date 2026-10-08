'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const RealWorker = require('./real-sim-helper.cjs');
// (The kernels are Rust: the wasm module and its heap, where the keys live.)
const source = ['sim_parallel.js', 'sim_wasm_bin.js', 'sim_wasm.js'].map(f => fs.readFileSync(path.join(__dirname, '../src/sim', f), 'utf8')).join('\n');

(async () => {
    for (const helpers of [0, 1, 7, 11]) {
        const workers = [];
        class Worker extends RealWorker { constructor(...args) { super(...args); workers.push(this); } }
        const ctx = vm.createContext({ self: { crossOriginIsolated: true }, Worker,
            navigator: { hardwareConcurrency: 16 }, console });
        vm.runInContext(source, ctx);
        assert.ok(vm.runInContext('simWasmInit()', ctx), 'wasm module');
        vm.runInContext(`simParallelInit('', ${helpers})`, ctx);
        assert.equal(vm.runInContext('simParallelHelpers()', ctx), helpers);
        try {
            // Grow, shrink, repeated equal keys, dense crowd, empty world,
            // map-independent storage and all four bytes of a uint32 key.
            for (const [n, maxKey] of [[0, 0], [19, 1], [100003, 999999], [70000, 255], [4101, 0xffffffff], [8000, 0]]) {
                let seed = 31;
                const keys = vm.runInContext(`simHeapArray(Uint32Array, ${Math.max(1, n)})`, ctx);
                for (let i = 0; i < n; i++) {
                    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                    keys[i] = i % 7 === 0 ? maxKey : seed % (maxKey + 1);
                }
                const expected = Array.from({ length: n }, (_, i) => i).sort((a, b) => keys[a] - keys[b] || a - b);
                ctx.keys = keys; ctx.count = n; ctx.maxKey = maxKey;
                for (let round = 0; round < 3; round++) {
                    const actual = vm.runInContext('Array.from(simSpatialStableOrder(keys, count, maxKey).subarray(0, count))', ctx);
                    assert.deepEqual(Array.from(actual), expected, `${helpers} helpers, ${n} entries, round ${round}`);
                    await new Promise(resolve => setImmediate(resolve));
                }
            }
        } finally { await Promise.all(workers.map(w => w.terminate())); }
    }
    console.log('PASS: stable shared spatial ordering matches scalar sort with 0, 1, 7 and 11 real helpers, including resize/reuse and uint32 keys.');
})().catch(e => { console.error(e); process.exitCode = 1; });
