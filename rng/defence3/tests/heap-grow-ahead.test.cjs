// The wasm heap grown ahead of need on a helper (sim_wasm.js
// _simHeapGrowAhead, SIM_KERNEL_HEAP_GROW on SIM_LANE_GROW): allocations
// over ~480 MB, time passing between them as between ticks (nothing waits
// for the growth lane: the next allocation takes its finished job back),
// never grow the memory on the simulation thread after the first (made
// before any grow ahead); arrays freed meanwhile go back to the heap (a
// growth job still counted as pending held every free back, and the memory
// grew without end); arrays in the memory a helper grew work there and on
// the helpers (a parallel heap copy over them). Without helpers the thread
// grows it itself, as before.
//   node tests/heap-grow-ahead.test.cjs
'use strict';
globalThis.self = { crossOriginIsolated: true };
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
for (const helpers of [7, 0]) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS } });
    const inst = world.spawn('grow' + helpers, { simWorker: false });
    inst.eval('startSoloGame();');
    if (helpers) {
        inst.scratch.Worker = require('./real-sim-helper.cjs');
        assert.equal(inst.eval(`Worker = __scratch.Worker; navigator.hardwareConcurrency = 32; simParallelInit('', ${helpers})`), helpers);
    }
    inst.scratch.now = () => performance.now();
    const r = JSON.parse(inst.eval(`JSON.stringify((() => {
        const M = _simHeap.memory, real = M.grow.bind(M);
        let mainGrows = 0;
        M.grow = n => { mainGrows++; return real(n); };
        const startMB = M.buffer.byteLength / 1048576, keep = [];
        let aheadSeen = 0, freed = 0;
        // (Time between allocations, as between ticks: up to 0.5 s for the
        // growth job, never waited for.)
        const pass = () => { const t = __scratch.now(); while (simParallelBackgroundPending(SIM_LANE_GROW) && !simParallelBackgroundDone(SIM_LANE_GROW) && __scratch.now() - t < 500) { } };
        for (let i = 0; i < 30; i++) {
            if (simParallelBackgroundPending(SIM_LANE_GROW)) aheadSeen++;
            pass();
            const a = simHeapArray(Int32Array, 4 << 20);
            a[0] = i; a[a.length - 1] = -i;
            keep.push(a);
            // (A small array made and freed each time: back once the frees run.)
            simHeapFree(simHeapArray(Int32Array, 1024)); simHeapTick();
            // (The first may need more than was left before any grow ahead.)
            if (i === 0) mainGrows = 0;
        }
        for (let k = 0; k < SIM_HEAP_FREE_TICKS + 2; k++) simHeapTick();
        const pending = _simHeap.pending.length;
        pass();
        // The last arrays (in memory a helper grew) copied by the helpers.
        const src = keep[keep.length - 1], dst = keep[keep.length - 2];
        for (let k = 0; k < src.length; k += 997) src[k] = k ^ 0x5a5a;
        simParallelCopyHeap([dst, src]);
        let bad = 0;
        for (let k = 0; k < src.length; k += 997) if (dst[k] !== (k ^ 0x5a5a)) bad++;
        let lost = 0;
        for (let i = 0; i < keep.length - 2; i++) if (keep[i][0] !== i || keep[i][keep[i].length - 1] !== -i) lost++;
        M.grow = real;
        return { startMB: Math.round(startMB), endMB: Math.round(M.buffer.byteLength / 1048576), mainGrows, aheadSeen, pendingFrees: pending, bad, lost };
    })())`));
    console.log(helpers + ' helpers: ' + JSON.stringify(r));
    assert.equal(r.bad, 0, 'the helpers copy over memory a helper grew');
    assert.equal(r.lost, 0, 'every array keeps its contents');
    assert.ok(r.endMB >= r.startMB + 480, 'the memory grew');
    assert.equal(r.pendingFrees, 0, 'freed arrays went back to the heap');
    if (helpers) {
        assert.ok(r.aheadSeen > 0, 'grows went to the helpers');
        assert.equal(r.mainGrows, 0, 'no grow on the simulation thread');
    } else assert.ok(r.mainGrows > 0, 'without helpers the thread grows it');
}
console.log('PASS: the wasm heap grows ahead on a helper, taken back by the next allocation; frees go back; arrays there work on every thread');
process.exit(0);
