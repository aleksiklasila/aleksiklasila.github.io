// Background and foreground jobs whose kernel throws (audit 2026-10-30, B),
// on real threads with 0, 1 and 7 helpers: the failure is thrown at the
// lane's wait whichever thread failed; only after the lane is drained (no
// chunk of it runs after the throw); the stage after a failed one never
// runs; the job is unlisted; a helper's background failure is not taken by
// a foreground job's check in between; the lane's next chain is unaffected.
// A foreground chunk throwing on the simulation thread returns only once
// the helpers left the job. Old code: the simulation thread's throw left the
// stage's other chunks running on helpers after the wait returned, and a
// foreground run took a helper's background failure (the wait then
// reported success).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const parallel = fs.readFileSync(path.join(__dirname, '../src/sim/sim_parallel.js'), 'utf8');
// 110: stage 0 (P[0] mode: 0 none, 1 throw once on the simulation thread,
// 2 once on a helper, 3 once anywhere); 111: stage 1; 112: no-op; 113:
// foreground, throws once on the simulation thread.
const kernels = `
function _tOnSim() { return !!(typeof _simPool !== 'undefined' && _simPool); }
function _tSpin(ms) { const t0 = performance.now(); while (performance.now() - t0 < ms) { } }
SIM_KERNELS[110] = function (R, P, c) {
    const L = P[1] | 0, mode = P[0] | 0; _tSpin(0.05); Atomics.add(R['f.claims.' + L], c, 1);
    const on = _tOnSim();
    if ((mode === 1 && on) || (mode === 2 && !on) || mode === 3) { if (Atomics.add(R['f.thrown.' + L], 0, 1) === 0) throw new Error('injected lane ' + L); }
};
SIM_KERNELS[111] = function (R, P, c) { Atomics.add(R['f.claims.' + (P[1] | 0)], 256 + c, 1); };
SIM_KERNELS[112] = function () { };
SIM_KERNELS[113] = function (R, P, c) { _tSpin(0.05); Atomics.add(R['f.fg'], c, 1); if (_tOnSim() && Atomics.add(R['f.fg'], 255, 1) === 0) throw new Error('injected foreground'); };
`;
const workerCode = `const { parentPort, workerData, MessageChannel } = require('node:worker_threads');
    globalThis.self = { crossOriginIsolated: true }; globalThis.MessageChannel = MessageChannel;
    (0, eval)(workerData.source + '\\nsimParallelHelperMain();');
    parentPort.on('message', m => self.onmessage({ data: m }));`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(helpers) {
    globalThis.self = { crossOriginIsolated: true };
    Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 32 }, configurable: true });
    globalThis.Worker = class { constructor() { this.w = new Worker(workerCode, { eval: true, workerData: { source: parallel + '\n' + kernels } }); this.w.on('error', e => { throw e; }); } postMessage(m) { this.w.postMessage(m); } terminate() { return this.w.terminate(); } };
    (0, eval)(parallel + '\n' + kernels + '\nglobalThis.__P = { simParallelInit, simParallelBind, simSharedArray, simParallelBackgroundChain, simParallelBackgroundWait, simParallelBackgroundWaitStage, simParallelBackgroundPending, simParallelStageParams, simParallelRun, pool: () => _simPool };');
    const P = globalThis.__P;
    if (helpers) assert.equal(P.simParallelInit('', helpers), helpers);
    const L = 3, N = 200, M = 50;
    const claims = P.simSharedArray(Int32Array, 512), thrown = P.simSharedArray(Int32Array, 4), fg = P.simSharedArray(Int32Array, 256);
    P.simParallelBind('f.claims.' + L, claims); P.simParallelBind('f.thrown.' + L, thrown); P.simParallelBind('f.fg', fg);
    await sleep(300);
    const post = (mode) => {
        claims.fill(0); thrown[0] = 0;
        const s0 = P.simParallelStageParams(L, 0), s1 = P.simParallelStageParams(L, 1);
        s0[0] = mode; s0[1] = L; s1[1] = L;
        P.simParallelBackgroundChain(L, [[110, N], [111, M]]);
    };
    const settled = async (what) => {
        const before = Array.from(claims);
        await sleep(40);
        assert.deepEqual(Array.from(claims), before, what + ': no chunk ran after the wait threw');
        for (let c = 0; c < N; c++) assert.ok(claims[c] <= 1, what + ': stage 0 chunk at most once');
        for (let c = 0; c < M; c++) assert.equal(claims[256 + c], 0, what + ': the stage after the failed one never ran');
        assert.equal(P.simParallelBackgroundPending(L), false, what + ': unlisted');
    };
    const clean = (what) => {
        post(0);
        P.simParallelBackgroundWait(L);
        for (let c = 0; c < N; c++) assert.equal(claims[c], 1, what + ': next chain stage 0 once');
        for (let c = 0; c < M; c++) assert.equal(claims[256 + c], 1, what + ': next chain stage 1 once');
    };
    const modes = helpers ? [1, 2, 3] : [3];
    let cases = 0;
    for (const mode of modes) {
        let hit = false;
        for (let attempt = 0; attempt < 20 && !hit; attempt++) {
            post(mode);
            if (mode === 2) {
                for (const t0 = Date.now(); !thrown[0] && Date.now() - t0 < 3000;) await sleep(1);
                // (A foreground job between: it must not take the lane's failure.)
                assert.doesNotThrow(() => P.simParallelRun(112, 8), 'a foreground run does not take a background failure');
            }
            let threw = null;
            try { P.simParallelBackgroundWait(L); } catch (err) { threw = err; }
            if (!thrown[0]) { assert.equal(threw, null, 'no failure, no throw'); continue; }
            hit = true;
            assert.ok(threw, 'mode ' + mode + ': the wait throws');
            await settled('mode ' + mode);
            clean('mode ' + mode);
            cases++;
        }
        assert.ok(hit, 'mode ' + mode + ' injected a failure');
    }
    // A stage wait on a failed chain.
    post(3);
    assert.throws(() => P.simParallelBackgroundWaitStage(L, 0), /injected|failed/);
    await settled('stage wait');
    clean('stage wait');
    // Foreground: a chunk failing on the simulation thread.
    if (helpers) {
        let hit = false;
        for (let attempt = 0; attempt < 20 && !hit; attempt++) {
            fg.fill(0);
            let threw = null;
            try { P.simParallelRun(113, 128); } catch (err) { threw = err; }
            if (!fg[255]) continue;
            hit = true;
            assert.ok(threw, 'foreground failure thrown');
            const before = Array.from(fg); await sleep(40);
            assert.deepEqual(Array.from(fg), before, 'no foreground chunk ran after the throw');
            assert.doesNotThrow(() => P.simParallelRun(112, 8), 'the next foreground job is clean');
        }
        assert.ok(hit, 'foreground failure injected');
        cases++;
    }
    const pool = P.pool();
    if (pool) for (const w of pool.helpers) await w.terminate();
    return cases + 1;
}

(async () => {
    const out = [];
    for (const h of [0, 1, 7]) out.push(h + ' helpers: ' + await run(h) + ' cases');
    console.log('PASS: failed background/foreground jobs drain before throwing, skip dependent stages, and do not leak into other jobs (' + out.join(', ') + ')');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
