// A completed foreground dependency must not wait for unrelated background work.
// Real helper plus a handshake: the caller exhausts its target's chunks while
// the helper holds the last one. It must not claim the newly posted other lane.
// PARALLEL_SOURCE=path selects a saved scheduler; optional argument foreground
// or lane isolates one wait when checking that an older implementation fails.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const source = fs.readFileSync(process.env.PARALLEL_SOURCE || path.join(__dirname, '../src/sim/sim_parallel.js'), 'utf8');
const kernels = `
SIM_KERNELS[110] = function (R) {
    const A = R.test;
    if (_simPool) {
        while (!Atomics.load(A, 0)) {
            if (Atomics.wait(A, 0, 0, 5000) === 'timed-out') throw Error('helper never entered target');
        }
        simParallelBackground(111, 1, SIM_LANE_TICK);
        Atomics.store(A, 1, 1); Atomics.notify(A, 1);
    } else {
        Atomics.store(A, 0, 1); Atomics.notify(A, 0);
        while (!Atomics.load(A, 1)) {
            if (Atomics.wait(A, 1, 0, 5000) === 'timed-out') throw Error('caller never posted other lane');
        }
        Atomics.wait(A, 2, 0, 30);
    }
};
SIM_KERNELS[111] = function (R) {
    Atomics.add(R.test, _simPool ? 3 : 4, 1);
    Atomics.wait(R.test, 2, 0, 80);
};
`;
const workerCode = `const { parentPort, workerData, MessageChannel } = require('node:worker_threads');
globalThis.self = { crossOriginIsolated: true }; globalThis.MessageChannel = MessageChannel;
(0, eval)(workerData + '\\nsimParallelHelperMain();');
parentPort.on('message', m => self.onmessage({ data: m }));`;
(async () => {
    globalThis.self = { crossOriginIsolated: true };
    Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 8 }, configurable: true });
    globalThis.Worker = class {
        constructor() { this.w = new Worker(workerCode, { eval: true, workerData: source + '\n' + kernels }); }
        postMessage(m) { this.w.postMessage(m); }
        terminate() { return this.w.terminate(); }
    };
    (0, eval)(source + '\n' + kernels + '\nglobalThis.P = { simParallelInit, simParallelBind, simParallelRun, simParallelBackground, simParallelBackgroundWait, pool: () => _simPool };');
    P.simParallelInit('', 1);
    const A = new Int32Array(new SharedArrayBuffer(32));
    P.simParallelBind('test', A);
    await new Promise(r => setTimeout(r, 300));
    try {
        for (const kind of process.argv[2] ? [process.argv[2]] : ['foreground', 'lane']) {
            A.fill(0);
            const start = performance.now();
            if (kind === 'foreground') P.simParallelRun(110, 2);
            else { P.simParallelBackground(110, 2, 3); P.simParallelBackgroundWait(3); }
            const elapsed = performance.now() - start;
            const stolen = A[3];
            P.simParallelBackgroundWait(0);
            console.log(kind + ' wait: ' + elapsed.toFixed(1) + ' ms; unrelated chunks claimed: ' + stolen);
            assert.equal(A[3] + A[4], 1, 'unrelated work still completes exactly once');
            assert.equal(stolen, 0, kind + ' wait claimed unrelated background work');
        }
    } finally { for (const w of P.pool().helpers) await w.terminate(); }
    console.log('PASS: waits take only their dependency; unrelated work completes at its own wait');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
