// simParallelDiffCount (sim_parallel.js, Rust k_diff_count): the bytes two
// heap arrays differ in, counted by the helpers and this thread, equal a
// plain count, for odd lengths and differences anywhere (a job's edges,
// eight-byte words partly equal); with real helpers (7) and none. (The
// navigation's wall difference after an install: flownav.js
// _navWallDiffReset.)
//   node tests/diff-count.test.cjs
'use strict';
globalThis.self = { crossOriginIsolated: true };
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
for (const helpers of [7, 0]) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS } });
    const inst = world.spawn('diff' + helpers, { simWorker: false });
    inst.eval('startSoloGame();');
    if (helpers) {
        inst.scratch.Worker = require('./real-sim-helper.cjs');
        assert.equal(inst.eval(`Worker = __scratch.Worker; navigator.hardwareConcurrency = 32; simParallelInit('', ${helpers})`), helpers);
    }
    const r = JSON.parse(inst.eval(`JSON.stringify((() => {
        let seed = 7;
        const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        const out = [];
        for (const n of [1, 7, 8, 9, 1000, 262143, 262144, 262145, 1000003]) {
            const a = simHeapArray(Uint8Array, n), b = simHeapArray(Uint8Array, n);
            for (let i = 0; i < n; i++) a[i] = b[i] = (i * 31) & 255;
            const k = Math.min(n, 1 + Math.floor(rnd() * 5000));
            for (let i = 0; i < k; i++) { const t = Math.floor(rnd() * n); b[t] = (b[t] + 1 + Math.floor(rnd() * 200)) & 255; }
            // (The edges: the first and last bytes, a job's last byte.)
            b[0] ^= 1; b[n - 1] ^= 2; if (n > 262144) b[262143] ^= 4;
            let plain = 0;
            for (let i = 0; i < n; i++) if (a[i] !== b[i]) plain++;
            out.push([n, plain, simParallelDiffCount(a, b)]);
            simHeapFree(a); simHeapFree(b);
        }
        return out;
    })())`));
    for (const [n, plain, got] of r) assert.equal(got, plain, helpers + ' helpers, ' + n + ' bytes');
    console.log(helpers + ' helpers: ' + r.map(([n, p]) => n + ':' + p).join(' '));
}
console.log('PASS: the parallel difference count equals a plain one');
process.exit(0);
