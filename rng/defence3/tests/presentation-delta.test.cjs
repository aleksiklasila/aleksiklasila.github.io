// The presentation worker's frames by changes (presentation_worker.js
// fillRange with dl: slots filled only where they may have changed, the
// rest copied forward or left) equal whole frames: two readers of the same
// columns, one building by changes from any size, one never, through random
// ticks (squads moving and stopping, easing to rest, fire targets, flashes,
// damage, burning, owners changed, deaths, spawns, slot reuse, more slots):
// every frame equal: every live slot's columns, the order, the render index
// and change marks byte for byte.
//   node tests/presentation-delta.test.cjs
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const dir = path.join(__dirname, '../src/sim');
const code = fs.readFileSync(path.join(dir, 'presentation_worker.js'), 'utf8');
const load = ctx => { ctx.self = ctx; ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(dir, f.split('?')[0]), 'utf8'), ctx); }; vm.runInContext(code, ctx); return ctx; };
function reader(delta) {
    const jobs = [], messages = [];
    const ctx = vm.createContext({ console, performance, setTimeout: fn => jobs.push(fn), postMessage: m => messages.push(m) });
    ctx.presentPacing = false;   // (a frame every tick)
    load(ctx);
    vm.runInContext(`PRESENT_DELTA_MIN = ${delta ? 0 : 'Infinity'};`, ctx);
    // (DEBUG: a frame not made, why.)
    if (delta && process.env.DEBUG) vm.runInContext(`{ const d = draw; draw = function () { const before = latest; try { d(); } catch (e) { console.log('draw threw', e.stack); throw e; }
        if (latest === before && before) console.log('draw kept latest', before.tick, JSON.stringify([...buffers.values()].map(e => e.busy))); }; }`, ctx);
    const send = data => { ctx.onmessage({ data }); while (jobs.length) jobs.shift()(); };
    return { ctx, messages, send, held: [] };
}
const A = reader(true), B = reader(false);
const both = data => { A.send(data); B.send(data); };

const COLS = ['id', 'owner', 'x', 'y', 'prevX', 'prevY', 'vx', 'vy', 'energy', 'r', 'commandState', 'attackFlash', 'burning', 'poisoned', 'frozen', 'wet', 'sandy',
    'watched', 'teleportHideTicks', 'workerTransferCooldown', 'effectiveLevel', 'unitLevel', 'live', 'dead', 'maxE', 'stOn', 'cmMode', 'cmT', 'pvAt'];
const cap = 30000, SLOT = vm.runInContext('SIM_FRAME_SLOT_BYTES', B.ctx);
const C = {};
for (const k of COLS) C[k] = k === 'id' || k === 'cmT' || k === 'pvAt' ? new Int32Array(new SharedArrayBuffer(cap * 4)) : new Float32Array(new SharedArrayBuffer(cap * 4));
// The simulation's marks (wasm/src/k.rs k_pv_marks), as the kernel makes them
// at a tick's end: the tick of each slot's last visible change.
const PV = { id: new Int32Array(cap).fill(0), e: new Float32Array(cap), o: new Float32Array(cap), c: new Float32Array(cap), l: new Int16Array(cap), v: new Uint8Array(cap) };
function marks(tick) {
    for (let s = 0; s < cap; s++) {
        const alive = C.live[s] !== 0 && C.dead[s] === 0, idv = alive ? C.id[s] : -1, lv = C.effectiveLevel[s], li = lv >= 0 && lv < 32767 ? Math.trunc(lv) : -1;
        const vel = (C.vx[s] !== 0 || C.vy[s] !== 0 ? 1 : 0) | (C.attackFlash[s] !== 0 ? 2 : 0);
        const changed = idv !== PV.id[s] || (alive && (C.x[s] !== C.prevX[s] || C.y[s] !== C.prevY[s] || C.energy[s] !== PV.e[s] || C.owner[s] !== PV.o[s]
            || C.commandState[s] !== PV.c[s] || li !== PV.l[s] || C.stOn[s] !== 0 || (C.cmMode[s] & 4) !== 0 || vel !== 0 || PV.v[s] !== 0));
        if (changed) { C.pvAt[s] = tick; PV.v[s] = vel; PV.id[s] = idv; PV.e[s] = C.energy[s]; PV.o[s] = C.owner[s]; PV.c[s] = C.commandState[s]; PV.l[s] = li; }
    }
}
const M = B.ctx.simMetaViews(new SharedArrayBuffer(cap * 48), cap);
C.id.fill(-1); M.id.fill(-1); C.cmT.fill(-1);
const metaRev = new Int32Array(new SharedArrayBuffer(4));
let seed = 4242, nextId = 1, n = 20000;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
function spawn(s) {
    const id = nextId++;
    C.id[s] = id; C.live[s] = 1; C.dead[s] = 0; C.owner[s] = rnd() < .5 ? 0 : 1; C.energy[s] = 20; C.r[s] = 8;
    C.x[s] = C.prevX[s] = 16 + rnd() * 2000; C.y[s] = C.prevY[s] = 16 + rnd() * 2000; C.effectiveLevel[s] = 1; C.unitLevel[s] = 1;
    M.id[s] = id; M.type[s] = 1 + Math.floor(rnd() * 5); M.vision[s] = 2 + Math.floor(rnd() * 3); M.watchedBy[s] = -1;
    Atomics.add(metaRev, 0, 1);
}
for (let s = 0; s < n; s++) spawn(s);
both({ type: 'bind', epoch: 1, generation: 1, columns: C, meta: { buf: M.buf, cap }, metaRev });
both({ type: 'strings', strings: [''] });
both({ type: 'ready' });
let frames = 0, deltas = 0;
for (let tick = 1; tick <= 90; tick++) {
    for (let s = 0; s < n; s++) { C.prevX[s] = C.x[s]; C.prevY[s] = C.y[s]; C.vx[s] = 0; C.vy[s] = 0; if (C.attackFlash[s] > 0) C.attackFlash[s]--; }
    // Squads moving for a while, then standing (their drawn places ease to rest).
    for (let g = 0; g < 3; g++) {
        const s0 = Math.floor(rnd() * n), len = 200 + Math.floor(rnd() * 800), dx = (rnd() - .5) * 4, dy = (rnd() - .5) * 4;
        if (tick % 20 < 12) for (let s = s0; s < Math.min(n, s0 + len); s++) if (C.live[s]) { C.x[s] += dx; C.y[s] += dy; C.vx[s] = dx; C.vy[s] = dy; C.cmMode[s] = s % 3 ? 0 : 4; C.cmT[s] = s % 3 ? -1 : (s * 7919) % n; }
    }
    // (Fire targets end: their facing stays.)
    if (tick % 7 === 0) for (let s = 0; s < n; s++) if (C.cmMode[s] && rnd() < .3) C.cmMode[s] = 0;
    for (let k = 0; k < 30; k++) { const s = Math.floor(rnd() * n); if (C.live[s]) { C.x[s] += rnd() * 3; C.vx[s] = 1; } }
    for (let k = 0; k < 30; k++) C.attackFlash[Math.floor(rnd() * n)] = 8;
    for (let k = 0; k < 60; k++) C.energy[Math.floor(rnd() * n)] -= 1;
    for (let k = 0; k < 10; k++) { const s = Math.floor(rnd() * n), on = rnd() < .5; C.burning[s] = on ? 3 : 0; C.stOn[s] = on ? 1 : C.stOn[s]; }
    for (let s = 0; s < n; s++) if (C.stOn[s] && !C.burning[s] && rnd() < .5) C.stOn[s] = 0;
    for (let k = 0; k < 5; k++) { const s = Math.floor(rnd() * n); C.owner[s] = 1 - C.owner[s]; }
    for (let k = 0; k < 5; k++) C.commandState[Math.floor(rnd() * n)] = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < 20; k++) { const s = Math.floor(rnd() * n); C.live[s] = 0; C.dead[s] = 1; }
    for (let k = 0; k < 20; k++) { const s = Math.floor(rnd() * n); if (!C.live[s]) spawn(s); }
    if (tick % 30 === 0 && n + 1000 <= cap) { for (let s = n; s < n + 1000; s++) spawn(s); n += 1000; }
    marks(tick);
    both({ type: 'tick', epoch: 1, tick, time: tick, rate: 20, player: 0, areaUnit: 2, n, gw: 64, gh: 64, tile: 32, history: false, fog: false, sight: null, rise: 6, fall: 3, lightRange: 6 });
    const ma0 = 0; const ma = A.messages.splice(0).filter(m => m.type === 'presentation'), mb = B.messages.splice(0).filter(m => m.type === 'presentation');
    const errs = A.messages.concat(B.messages).filter(m => m.type === 'error'); if (process.env.DEBUG) console.log(tick, A.messages.map(m => m.type).join(','), '|', B.messages.map(m => m.type).join(','));
    assert.equal(ma.length, mb.length, `tick ${tick}: as many frames ${JSON.stringify(errs.slice(0, 2))}`);
    for (let i = 0; i < ma.length; i++) {
        const ua = ma[i].world.units, ub = mb[i].world.units;
        assert.equal(ua.count, ub.count, `tick ${tick}: listed`); assert.equal(ua.mver, ub.mver, `tick ${tick}: membership`);
        const Fa = B.ctx.simFrameViews(ua.buf, cap), Fb = B.ctx.simFrameViews(ub.buf, cap);
        // Live slots' columns (a dead slot is not drawn nor compared for
        // change marks: what it holds is not read), the order as listed,
        // then the render index and change marks after the columns, whole.
        const keys = vm.runInContext('[...SIM_FRAME_F32, ...SIM_FRAME_I32, ...SIM_FRAME_I16, ...SIM_FRAME_U8]', B.ctx);
        assert.deepEqual(Array.from(Fa.order.subarray(0, ua.count)), Array.from(Fb.order.subarray(0, ub.count)), `tick ${tick}: order`);
        for (let s = 0; s < ua.n; s++) {
            if (Fa.id[s] !== Fb.id[s]) assert.fail(`tick ${tick}: slot ${s} id ${Fa.id[s]} / ${Fb.id[s]}`);
            if (Fa.id[s] < 0) continue;
            for (const k of keys) if (!Object.is(Fa[k][s], Fb[k][s])) {
                if (process.env.DEBUG) console.log(JSON.stringify({ k, a: Fa[k][s], b: Fb[k][s], x: [Fa.x[s], Fb.x[s], C.x[s], C.vx[s]], fullAt: vm.runInContext(`fullAt[${s}]`, A.ctx) }));
                assert.fail(`tick ${tick}: slot ${s} (id ${Fa.id[s]}) ${k} ${Fa[k][s]} / ${Fb[k][s]}`);
            }
        }
        const tail = cap * SLOT, bytes = ua.buf.byteLength - 12;
        assert.equal(bytes, ub.buf.byteLength - 12);
        if (Buffer.compare(Buffer.from(new Uint8Array(ua.buf, tail, bytes - tail)), Buffer.from(new Uint8Array(ub.buf, tail, bytes - tail))) !== 0) {
            const xa = new Uint8Array(ua.buf, tail, bytes - tail), xb = new Uint8Array(ub.buf, tail, bytes - tail);
            let k = 0; while (xa[k] === xb[k]) k++;
            assert.fail(`tick ${tick}: render index / change marks differ at byte ${k} past the columns`);
        }
        frames++;
        A.held.push(ua.buf); B.held.push(ub.buf);
    }
    if (tick > 3) deltas++;
    while (A.held.length > 1) { A.send({ type: 'release', buf: A.held.shift() }); B.send({ type: 'release', buf: B.held.shift() }); }
}
assert.ok(frames >= 85, `frames compared: ${frames}`);
console.log(`PASS presentation-delta: ${frames} frames of ${n} slots by changes equal whole frames byte for byte`);
