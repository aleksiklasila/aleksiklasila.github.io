// Background lanes on real threads: chains of stages run in order (a stage
// sees every chunk of the one before), each chunk exactly once, with each
// stage's own parameters, across lane reuse, several lanes at once and
// 0, 1 and 7 helpers.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker, MessageChannel } = require('node:worker_threads');
const parallel = fs.readFileSync(path.join(__dirname, '../src/sim/sim_parallel.js'), 'utf8');
// Test kernels 100-102 (lane L's arrays are t.<name>.L).
const kernels = `
SIM_KERNELS[100] = function (R, P, c) { const L = P[1] | 0; Atomics.add(R['t.claims.' + L], c, 1); R['t.a.' + L][c] = c * P[0] + 1; };
SIM_KERNELS[101] = function (R, P, c) { const L = P[1] | 0, A = R['t.a.' + L], n = P[2] | 0; let s = 0; for (let i = 0; i < n; i++) s += A[i]; Atomics.add(R['t.claims.' + L], 64 + c, 1); R['t.b.' + L][c] = s * P[0] + c; };
SIM_KERNELS[102] = function (R, P, c) { const L = P[1] | 0, B = R['t.b.' + L], n = P[2] | 0; Atomics.add(R['t.claims.' + L], 128 + c, 1); R['t.c.' + L][c] = B[(c + 1) % n] + P[0]; };
`;
const workerCode = `const { parentPort, workerData, MessageChannel } = require('node:worker_threads');
    globalThis.self = { crossOriginIsolated: true }; globalThis.MessageChannel = MessageChannel;
    (0, eval)(workerData.source + '\\nsimParallelHelperMain();');
    parentPort.on('message', m => self.onmessage({ data: m }));`;

async function run(helpers) {
    globalThis.self = { crossOriginIsolated: true };
    Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 32 }, configurable: true });
    globalThis.Worker = class { constructor() { this.w = new Worker(workerCode, { eval: true, workerData: { source: parallel + '\n' + kernels } }); this.w.on('error', e => { throw e; }); } postMessage(m) { this.w.postMessage(m); } terminate() { return this.w.terminate(); } };
    const ctx = {};
    (0, eval)(parallel + '\n' + kernels + '\nglobalThis.__P = { simParallelInit, simParallelBind, simSharedArray, simParallelBackgroundChain, simParallelBackgroundWait, simParallelStageParams, simParallelRun, pool: () => _simPool };');
    const P = globalThis.__P;
    if (helpers) assert.equal(P.simParallelInit('', helpers), helpers);
    const lanes = [0, 2, 3, 5];
    const arr = {};
    for (const L of lanes) for (const k of ['claims', 'a', 'b', 'c']) { arr[k + L] = P.simSharedArray(k === 'claims' ? Int32Array : Float64Array, 192); P.simParallelBind('t.' + k + '.' + L, arr[k + L]); }
    // Helpers take their bindings between tasks.
    await new Promise(r => setTimeout(r, 300));
    let seed = 7 + helpers;
    const rnd = n => { seed = (seed * 16807) % 2147483647; return seed % n; };
    const posted = new Map();
    let checked = 0;
    for (let it = 0; it < 3000; it++) {
        const L = lanes[rnd(lanes.length)];
        // Collect the lane's previous chain (sometimes late, as tiers do).
        const prev = posted.get(L);
        if (prev && (rnd(3) === 0 || it > 2990)) {
            P.simParallelBackgroundWait(L);
            const { n, m, q, mul } = prev;
            const claims = arr['claims' + L], A = arr['a' + L], B = arr['b' + L], C = arr['c' + L];
            for (let c = 0; c < n; c++) { assert.equal(claims[c], 1, 'stage 1 chunk ' + c + ' once'); assert.equal(A[c], c * mul[0] + 1); }
            let s = 0; for (let i = 0; i < n; i++) s += A[i];
            for (let c = 0; c < m; c++) { assert.equal(claims[64 + c], 1, 'stage 2 chunk once'); assert.equal(B[c], s * mul[1] + c, 'stage 2 after all of stage 1'); }
            for (let c = 0; c < q; c++) { assert.equal(claims[128 + c], 1, 'stage 3 chunk once'); assert.equal(C[c], B[(c + 1) % m] + mul[2]); }
            posted.delete(L); checked++;
        }
        if (posted.has(L)) continue;
        const n = 1 + rnd(60), m = 1 + rnd(60), q = 1 + rnd(m), mul = [1 + rnd(5), 1 + rnd(5), 1 + rnd(5)];
        arr['claims' + L].fill(0);
        for (let st = 0; st < 3; st++) { const sp = P.simParallelStageParams(L, st); sp[0] = mul[st]; sp[1] = L; sp[2] = st === 1 ? n : m; }
        P.simParallelBackgroundChain(L, [[100, n], [101, m], [102, q]]);
        posted.set(L, { n, m, q, mul });
        // Foreground jobs in between (the helpers leave the lanes for them).
        if (rnd(4) === 0) { const sp = P.simParallelStageParams(L, 0); P.simParallelRun(100, 0); }
    }
    for (const L of [...posted.keys()]) P.simParallelBackgroundWait(L);
    const pool = P.pool();
    if (pool) for (const w of pool.helpers) await w.terminate();
    return checked;
}

(async () => {
    const out = [];
    for (const h of [0, 1, 7]) out.push(h + ' helpers: ' + await run(h) + ' chains');
    console.log('PASS: background chains run in order, each chunk once, across lane reuse (' + out.join(', ') + ')');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
