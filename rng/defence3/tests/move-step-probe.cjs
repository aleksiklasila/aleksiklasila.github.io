'use strict';
// The movement's cost a step in a restored scene, real helpers: the step's
// time (p50 / p95 / max), the foreground wall of each kernel a step (the
// movement's first stage 8, the occupancy 89, the look listing 151 and the
// rest by id), the flow looks listed a step, and where the units ended up
// (alive, walking a flow, a hash of the positions by id in slot order, their mean distance to their destination: the
// progress made, for comparing behaviour between builds).
// DK=n: n base ticks a step. WARM=n warm-up steps (15). OUT=file: raw JSON.
// Usage: node --max-old-space-size=14000 tests/move-step-probe.cjs [scene.gz] [helpers] [steps]
const path = require('node:path'), fs = require('node:fs');
globalThis.self = { crossOriginIsolated: true };
const H = require('./net-harness.cjs');
const scene = path.resolve(process.argv[2] || path.join(__dirname, 'scenes/chaos-1m-250k.gz'));
const helpers = process.argv[3] !== undefined ? Number(process.argv[3]) : 8, N = Number(process.argv[4]) || 30, WARM = Number(process.env.WARM) || 15;
(async () => {
    const controls = { ...H.SMALL_MATCH_CONTROLS };
    const world = new H.World({ controls, hashEvery: 1e9 });
    const host = world.spawn('host', { controls, simWorker: false });
    host.scratch.records = JSON.parse(require('node:zlib').gunzipSync(fs.readFileSync(scene)));
    host.scratch.scene = host.eval('(() => { const r = soloSceneReader(); for (const a of __scratch.records) r.line(JSON.stringify(a)); return r.finish(); })()');
    host.scratch.records = null;
    host.eval('document.getElementById("starting-resources-popup").classList.add("hidden")');
    let done = false, error;
    host.eval('restoreSoloGameSnapshot(__scratch.scene)').then(() => done = true, e => { done = true; error = e; });
    while (!done) await world.run(20);
    if (error) throw error;
    host.scratch.scene = null;
    if (helpers > 0) {
        host.scratch.Worker = require('./real-sim-helper.cjs');
        host.eval(`Worker = __scratch.Worker; navigator.hardwareConcurrency = 32; simParallelInit('', ${helpers})`);
    }
    if (process.env.DK) host.eval('simDk=' + Number(process.env.DK) + ';netStepTicks=()=>' + Number(process.env.DK));
    const state = () => JSON.parse(host.eval(`JSON.stringify((() => { const c = _simUnitState.columns, n = _simUnitState.owners.length, W = GRID_W; let alive = 0, walk = 0, sum = 0, park = 0, hash = 0;
        for (let s = 0; s < n; s++) { if (c.dead0[s] || !_simUnitState.owners.at(s)) continue; alive++; hash = (Math.imul(hash, 16777619) ^ (c.x[s] * 8 | 0) ^ Math.imul(c.y[s] * 8 | 0, 40503) ^ Math.imul(c.id[s], 2654435761)) | 0; const on = c.mvOn[s]; if (on === 2) park++; if (on !== 1 || !(c.mvFlags[s] & 64)) continue; walk++;
            const d = c.mvDest[s], k = c.x instanceof Int32Array ? 0.125 : 1, dx = (d % W) * TILE + 16 - c.x[s] * k, dy = ((d / W) | 0) * TILE + 16 - c.y[s] * k; sum += Math.hypot(dx, dy); }
        return { alive, walk, park, meanDist: walk ? sum / walk : 0, hash }; })())`));
    for (let i = 0; i < WARM; i++) host.eval('gameTick()');
    host.scratch.now = () => performance.now();
    host.eval(`{ __scratch.kw = {}; const pr = simParallelRun, now = __scratch.now; simParallelRun = function (kk) { const a = now(); try { return pr.apply(this, arguments); } finally { __scratch.kw[kk] = (__scratch.kw[kk] || 0) + now() - a; } }; }`);
    const s0 = state();
    const ms = [], pend = [], kw = {};
    for (let i = 0; i < N; i++) {
        host.eval('__scratch.kw = {}');
        const a = performance.now(); host.eval('gameTick()'); ms.push(performance.now() - a);
        pend.push(host.eval('_flowLooks.pend|0'));
        const k = JSON.parse(host.eval('JSON.stringify(__scratch.kw)'));
        for (const id in k) kw[id] = (kw[id] || 0) + k[id];
    }
    const s1 = state();
    const sorted = ms.slice().sort((a, b) => a - b), q = p => sorted[Math.min(N - 1, Math.floor(p * N))], r1 = v => Math.round(v * 10) / 10;
    const kernels = Object.entries(kw).map(([id, v]) => [Number(id), r1(v / N)]).sort((a, b) => b[1] - a[1]);
    const res = { scene: path.basename(scene), helpers, steps: N, dk: Number(process.env.DK) || 1, stepMs: { p50: r1(q(.5)), p95: r1(q(.95)), max: r1(q(1)), mean: r1(ms.reduce((a, b) => a + b, 0) / N) },
        looksListedAStep: Math.round(pend.reduce((a, b) => a + b, 0) / N), kernelWallMsAStep: Object.fromEntries(kernels.slice(0, 14).map(([id, v]) => ['k' + id, v])),
        before: s0, after: s1, meanDistGain: r1(s0.meanDist - s1.meanDist) };
    console.log(JSON.stringify(res, null, 1));
    if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ res, ms, pend }));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
