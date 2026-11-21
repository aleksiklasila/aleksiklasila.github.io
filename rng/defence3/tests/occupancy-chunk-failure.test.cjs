// A failed chunk of the occupancy job never hangs the simulation (static audit 2026-11-18,
// MULTIPLAYER_ROBUSTNESS_PROGRESS.md "Simulation-thread hangs"). Old code: after a chunk threw on the dispatching
// thread, simParallelRun skipped its remaining chunks (counted as done), and a chunk that threw before its wasm call
// never published its block's finish: a helper waiting on that block, and the simulation thread waiting for the
// helper, waited forever (Atomics.wait: the whole thread, the page or worker frozen with its network alive).
// The host gets 3 real helper threads (shared memory); its simulation thread's occupancy chunks throw on a few
// ticks. The match must go on (the failed ticks repaired) and agree afterwards.
//   node tests/occupancy-chunk-failure.test.cjs
// (The scenario runs in a child process: a hang is a timeout there, not a frozen test.)
'use strict';
if (!process.env.OCC_FAIL_CHILD) {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, [__filename], { env: { ...process.env, OCC_FAIL_CHILD: '1' }, encoding: 'utf8', timeout: Number(process.env.OCC_FAIL_TIMEOUT_MS) || 300000 });
    process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
    if (r.error && r.error.code === 'ETIMEDOUT') { console.error('FAIL occupancy-chunk-failure: the match hung (timeout)'); process.exit(1); }
    process.exit(r.status == null ? 1 : r.status);
}
globalThis.self = { crossOriginIsolated: true };
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const EXPECTED = /injected occupancy failure/;

(async () => {
    // (A crowd over a bigger map: many occupancy blocks a tick, neighbours waiting on each other.)
    const world = new H.World({ network: { latencyMs: 40, jitterMs: 5 }, controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '64' }, simWorker: false });
    const crowd = { researchLevels: {}, spawnCounts: { 'unit:king': { 1: 1 }, 'unit:norm': { 1: 400 }, 'unit:fast': { 1: 300 }, 'unit:tank': { 1: 200 } } };
    const { host, guests } = await H.startHostedMatch(world, { guests: 1, hostSetup: 'startingResourcesConfig = ' + JSON.stringify(crowd) });
    const all = [host, ...guests];
    host.scratch.Worker = require('./real-sim-helper.cjs');
    host.eval(`Worker = __scratch.Worker; navigator.hardwareConcurrency = 32; simParallelInit('', 3)`);
    await H.playFor(world, all, 3000, { seed: 71 });
    assert.ok(host.eval('typeof SIM_OCCUPANCY_ENABLED !== "undefined" && SIM_OCCUPANCY_ENABLED'), 'the occupancy job runs');
    // (Counts the occupancy jobs and their chunks on the simulation thread, then throws in the first such chunk
    // of 6 ticks, before its wasm call, 30 ms late: the helpers hold blocks of later phases by then.)
    host.eval(`(() => { const k = SIM_KERNELS[SIM_KERNEL_MOVE_OCCUPANCY], f = _simMoveWasm, o = __scratch.occ = { chunks: 0, thrown: 0, tick: -1, inOcc: false };
        SIM_KERNELS[SIM_KERNEL_MOVE_OCCUPANCY] = function () { o.chunks++; o.inOcc = true; try { return k.apply(this, arguments); } finally { o.inOcc = false; } };
        _simMoveWasm = function () { if (o.inOcc && o.tick !== currentTick && o.thrown < 6) { o.tick = currentTick; o.thrown++; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30); throw new Error('injected occupancy failure'); } return f.apply(this, arguments); };
        return 0; })()`);
    const t0 = host.eval('currentTick');
    await H.playFor(world, all, 4000, { seed: 72 });
    const occ = host.eval('JSON.stringify(__scratch.occ)');
    assert.ok(JSON.parse(occ).thrown >= 3, 'occupancy chunks failed on the simulation thread: ' + occ);
    assert.ok(host.eval('currentTick') > t0 + 40, 'the host ticked on: ' + JSON.stringify([t0, host.eval('currentTick')]));
    const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
    await H.playFor(world, all, 3000, { seed: 73 });
    await world.run(1500);
    for (const i of all) i.errors = i.errors.filter(e => !EXPECTED.test(String(e && e.stack || e)));
    H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: 'after failed occupancy chunks' });
    console.log('PASS occupancy-chunk-failure: ' + occ + ' ' + host.eval('JSON.stringify({ units: units.length, cfg: Array.from(_simParReg["occ.config"] || []).slice(0, 8), jobs: Array.from(_simParReg["occ.jobs"] || []).slice(0, 8) })'));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
