// Continuous crowd motion at 1, 2 and 20 TPS, through the real presentation
// worker. Long simulation steps must not reset the visual separation lag.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const dir = path.join(__dirname, '../src/sim');
const code = fs.readFileSync(path.join(dir, 'presentation_worker.js'), 'utf8');

function reader(n) {
    const jobs = [], messages = [];
    const ctx = vm.createContext({ console, performance, setTimeout: f => jobs.push(f), postMessage: m => messages.push(m) });
    ctx.self = ctx; ctx.presentPacing = false;
    ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(dir, f.split('?')[0]), 'utf8'), ctx); };
    vm.runInContext(code, ctx);
    const C = {};
    for (const k of ['id', 'owner', 'x', 'y', 'prevX', 'prevY', 'vx', 'vy', 'energy', 'r', 'commandState', 'attackFlash', 'stBu', 'stPo', 'stFr', 'stWe', 'stSa', 'stWa', 'stTh', 'workerTransferCooldown', 'effectiveLevel', 'unitLevel', 'live', 'dead', 'maxE']) C[k] = new Float32Array(n);
    for (const k of ['stBu', 'stPo', 'stFr', 'stWe', 'stSa', 'stWa', 'stTh']) C[k] = new Float32Array(n + 1);
    C.stIx = new Int32Array(n);
    const M = ctx.simMetaViews(new SharedArrayBuffer(n * 48), n);
    for (let s = 0; s < n; s++) { C.id[s] = M.id[s] = s + 1; C.live[s] = 1; C.energy[s] = 20; C.r[s] = 8; M.type[s] = 1; }
    const send = data => { ctx.onmessage({ data }); while (jobs.length) jobs.shift()(); };
    send({ type: 'bind', epoch: 1, generation: 1, columns: C, meta: { buf: M.buf, cap: n } });
    send({ type: 'ready' });
    let held;
    return { C, M, tick(tick) {
        if (held) send({ type: 'release', buf: held });
        messages.length = 0;
        send({ type: 'tick', epoch: 1, tick, time: tick, rate: 20, player: 0, areaUnit: 2, n });
        assert.equal(messages.some(m => m.type === 'error'), false, JSON.stringify(messages));
        const msg = messages.find(m => m.type === 'presentation');
        assert.ok(msg, 'reader published a frame');
        held = msg.world.units.buf;
        const F = ctx.simFrameViews(held, n);
        return ['x', 'y', 'px', 'py'].map(k => Array.from(F[k]));
    } };
}

function measure(samples, step) {
    const R = reader(samples[0].length), C = R.C;
    let prev, maxJoin = 0, maxLag = 0, maxFrameStep = 0;
    for (let t = 0; t < samples.length; t++) {
        for (let s = 0; s < C.x.length; s++) {
            C.prevX[s] = C.x[s]; C.prevY[s] = C.y[s];
            [C.x[s], C.y[s]] = samples[t][s];
        }
        const F = R.tick(t);
        if (prev) for (let s = 0; s < C.x.length; s++) {
            maxJoin = Math.max(maxJoin, Math.hypot(F[2][s] - prev[0][s], F[3][s] - prev[1][s]));
            maxLag = Math.max(maxLag, Math.abs(C.x[s] - F[0][s]) + Math.abs(C.y[s] - F[1][s]));
            // What the existing linear GPU interpolation moves in one 60 Hz frame.
            maxFrameStep = Math.max(maxFrameStep, Math.hypot(F[0][s] - F[2][s], F[1][s] - F[3][s]) / (step * 3));
        }
        prev = F;
    }
    return { maxJoin, maxLag, maxFrameStep };
}

for (const step of [1, 10, 20]) {
    // Normal travel with alternating collision corrections, then settling.
    // At 1 TPS an ordinary fast unit covers more than the old snap threshold.
    const samples = Array.from({ length: 90 }, (_, t) => [[100 + Math.min(t, 55) * 3 * step, 100 + (t < 55 ? (t % 2 ? 6 : -6) : 0)]]);
    const result = measure(samples, step);
    console.log(`${20 / step} TPS motion:`, result);
    assert.ok(result.maxJoin <= .021, `continuous frame boundaries at ${20 / step} TPS: ${result.maxJoin}px jump`);
    assert.ok(result.maxLag <= 64.001, 'bounded visual lag even on long movement steps');
    assert.ok(result.maxFrameStep < 2, 'no single-frame teleport at 60 Hz');
}

// A portal must still reset while hidden; a reused slot must not inherit lag.
{
    const R = reader(1), C = R.C;
    C.x[0] = C.prevX[0] = 100; R.tick(0);
    C.x[0] = 130; R.tick(1);
    C.x[0] = 2000; C.stIx[0] = 1; C.stTh[1] = 2;
    const hidden = R.tick(2);
    assert.equal(hidden[0][0], 2000); assert.equal(hidden[2][0], 2000);
    C.stTh[1] = 0; C.stIx[0] = 0; C.prevX[0] = C.x[0]; C.x[0] += 10;
    assert.equal(R.tick(3)[2][0], 2000, 'portal exit continues at its destination');
    C.id[0] = R.M.id[0] = 99; C.x[0] = C.prevX[0] = 500;
    const reused = R.tick(4);
    assert.equal(reused[0][0], 500); assert.equal(reused[2][0], 500);
}

// Real movement and separation: a selected crowd ordered into its middle,
// with the same adaptive step sizes used by a large world at low TPS.
const H = require('./net-harness.cjs');
for (const step of [1, 10, 20]) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '60', 'cfg-map-type': 'arena' } });
    const inst = world.spawn('crowd' + step, { simWorker: false });
    inst.eval('startSoloGame();');
    const samples = JSON.parse(inst.eval(`JSON.stringify((() => {
        for (const u of units) u.dead = true;
        gameTick(); currentTick++;
        const crowd = [], cx = 30 * TILE + 16, cy = 30 * TILE + 16;
        let seed = 17;
        const rnd = () => { seed = seed * 16807 % 2147483647; return seed / 2147483647; };
        for (let i = 0; i < 320; i++) {
            const p = findNearestWalkable(23 + Math.floor(rnd() * 15), 23 + Math.floor(rnd() * 15));
            const u = new Unit(i % 4 ? 'norm' : 'fast', 0, p.x * TILE + 4 + rnd() * 24, p.y * TILE + 4 + rnd() * 24);
            units.push(u); updateUnitSpatial(u); crowd.push(u);
        }
        processAction({ action: 'move', unitIds: crowd.map(u => u.id), targetX: cx, targetY: cy }, 0);
        const samples = [crowd.map(u => [u.x, u.y])];
        simDk = ${step};
        for (let t = 0; t < 100; t++) { gameTick(); currentTick++; samples.push(crowd.map(u => [u.x, u.y])); }
        return samples;
    })())`));
    assert.deepEqual(inst.errors.map(String), []);
    const result = measure(samples, step);
    console.log(`${20 / step} TPS rally crowd:`, result);
    assert.ok(result.maxJoin <= .021, `rally crowd remains continuous at ${20 / step} TPS`);
    assert.ok(result.maxLag <= 64.001, 'rally crowd lag remains bounded');
}

console.log('PASS: low-TPS separation corrections interpolate continuously with bounded lag');
