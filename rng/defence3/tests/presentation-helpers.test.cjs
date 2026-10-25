// The presentation worker's frames split over helper threads
// (presentation_worker.js presentHelpers / runRanges): two readers of the
// same columns, one with three helpers (the same script, as present-helper;
// here in-process, their messages delivered at once), one alone, through
// random ticks (moves, turns, flashes, damage, deaths, spawns, slot reuse,
// more slots, Team + history ghosts from the shared fog and from a grid the
// helpers do not share): every frame buffer equal byte for byte (columns,
// order, render index, change marks), the same counts and membership.
//   node tests/presentation-helpers.test.cjs   (PRESENT_DELTA=1: frames by changes)
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const dir = path.join(__dirname, '../src/sim');
const code = fs.readFileSync(path.join(dir, 'presentation_worker.js'), 'utf8');
const load = ctx => { ctx.self = ctx; ctx.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(dir, f.split('?')[0]), 'utf8'), ctx); }; vm.runInContext(code, ctx); return ctx; };
let helperCount = 0;
function reader(withHelpers) {
    const jobs = [], messages = [];
    const ctx = vm.createContext({ console, performance, setTimeout: fn => jobs.push(fn), postMessage: m => messages.push(m) });
    ctx.presentPacing = false;   // (a frame every tick: these ticks take ~1 s each here)
    if (withHelpers) {
        ctx.navigator = { hardwareConcurrency: 16 };
        ctx.location = { href: 'presentation_worker.js' };
        ctx.Worker = class {
            constructor(url, opts) {
                this.pending = []; this.handler = null; helperCount++;
                const h = vm.createContext({ console, performance, setTimeout() { }, name: opts && opts.name });
                h.postMessage = m => { if (this.handler) this.handler({ data: m }); else this.pending.push(m); };
                this.ctx = load(h);
            }
            set onmessage(fn) { this.handler = fn; for (const m of this.pending.splice(0)) fn({ data: m }); }
            postMessage(m) { this.ctx.onmessage({ data: m }); }
            terminate() { }
        };
    }
    load(ctx);
    // (PRESENT_DELTA=1: frames by changes and the motion copy split over the
    // ranges from any size, presentation_worker.js fillRange / copyMotion.)
    if (process.env.PRESENT_DELTA) vm.runInContext('PRESENT_DELTA_MIN = 0;', ctx);
    const send = data => { ctx.onmessage({ data }); while (jobs.length) jobs.shift()(); };
    return { ctx, messages, send, held: [] };
}
const A = reader(true), B = reader(false);
const both = data => { A.send(data); B.send(data); };

// ---- the simulation's columns (shared by both readers, read only) ----
const COLS = ['id', 'owner', 'x', 'y', 'prevX', 'prevY', 'vx', 'vy', 'energy', 'r', 'commandState', 'attackFlash', 'stBu', 'stPo', 'stFr', 'stWe', 'stSa', 'stWa', 'stTh',
    'workerTransferCooldown', 'effectiveLevel', 'unitLevel', 'live', 'dead', 'maxE', 'stIx', 'cmMode', 'cmT'];
const cap = 90000, SLOT = vm.runInContext('SIM_FRAME_SLOT_BYTES', B.ctx);
const C = {};
for (const k of COLS) C[k] = k === 'id' || k === 'cmT' || k === 'stIx' ? new Int32Array(new SharedArrayBuffer(cap * 4)) : new Float32Array(new SharedArrayBuffer((cap + 1) * 4));
const M = B.ctx.simMetaViews(new SharedArrayBuffer(cap * 48), cap);
C.id.fill(-1); M.id.fill(-1); C.cmT.fill(-1);
const metaRev = new Int32Array(new SharedArrayBuffer(4));
let seed = 777, nextId = 1, n = 70000;
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
const sight64 = new Float32Array(64 * 64), sight32 = new Float32Array(32 * 32);
let frames = 0, threads = 0;
for (let tick = 1; tick <= 60; tick++) {
    for (let s = 0; s < n; s++) { C.prevX[s] = C.x[s]; C.prevY[s] = C.y[s]; C.vx[s] = 0; C.vy[s] = 0; if (C.attackFlash[s] > 0) C.attackFlash[s]--; }
    // Squads moving (nearby slots), some with fire targets; strays.
    for (let g = 0; g < 6; g++) {
        const s0 = Math.floor(rnd() * n), len = 500 + Math.floor(rnd() * 3000), dx = (rnd() - .5) * 4, dy = (rnd() - .5) * 4;
        for (let s = s0; s < Math.min(n, s0 + len); s++) if (C.live[s]) { C.x[s] += dx; C.y[s] += dy; C.vx[s] = dx; C.vy[s] = dy; C.cmMode[s] = s % 3 ? 0 : 4; C.cmT[s] = s % 3 ? -1 : (s * 7919) % n; }
    }
    for (let k = 0; k < 200; k++) { const s = Math.floor(rnd() * n); if (C.live[s]) { C.x[s] += rnd() * 3; C.vx[s] = 1; } }
    for (let k = 0; k < 50; k++) C.attackFlash[Math.floor(rnd() * n)] = 8;
    for (let k = 0; k < 100; k++) C.energy[Math.floor(rnd() * n)] -= 1;
    for (let k = 0; k < 20; k++) { const s = Math.floor(rnd() * n); C.stIx[s] = s + 1; C.stBu[s + 1] = rnd() < .5 ? 3 : 0; }
    // (From tick 50 units die and are made only in the first helper's slots.)
    const span = tick >= 50 ? 10000 : n;
    for (let k = 0; k < 40; k++) { const s = Math.floor(rnd() * span); C.live[s] = 0; C.dead[s] = 1; }
    for (let k = 0; k < 40; k++) { const s = Math.floor(rnd() * span); if (!C.live[s]) spawn(s); }
    if (tick % 15 === 0 && n + 2000 <= cap) { for (let s = n; s < n + 2000; s++) spawn(s); n += 2000; }
    // Team + history: from tick 20 the fog (shared) is the ghosts' grid; from
    // tick 40 a sight grid of another size (not shared: ghosts after the ranges).
    for (let i = 0; i < sight64.length; i++) sight64[i] = ((i * 31 + tick) % 7) < 4 ? 6 : 0;
    for (let i = 0; i < sight32.length; i++) sight32[i] = ((i * 17 + tick) % 5) < 3 ? 6 : 0;
    const history = tick >= 20, big = tick < 40, gw = big ? 64 : 32;
    both({ type: 'tick', epoch: 1, tick, time: tick, rate: 20, player: 0, areaUnit: 2, n, gw, gh: gw, tile: big ? 32 : 64,
        history, fog: history && big, sight: big ? sight64 : sight32, rise: 6, fall: 3, lightRange: 6 });
    const ma = A.messages.splice(0).filter(m => m.type === 'presentation'), mb = B.messages.splice(0).filter(m => m.type === 'presentation');
    assert.equal(ma.length, mb.length, `tick ${tick}: as many frames`);
    for (let i = 0; i < ma.length; i++) {
        const ua = ma[i].world.units, ub = mb[i].world.units;
        assert.equal(ua.count, ub.count, `tick ${tick}: listed`); assert.equal(ua.mver, ub.mver, `tick ${tick}: membership`); assert.equal(ua.n, ub.n);
        const bytes = ua.buf.byteLength - 12;
        assert.equal(bytes, ub.buf.byteLength - 12);
        // (F.order past the count listed is not read: what the ranges left there.)
        const xa = new Uint8Array(ua.buf.slice(0, bytes)), xb = new Uint8Array(ub.buf.slice(0, bytes));
        const order = vm.runInContext('simFrameViews', B.ctx)(new SharedArrayBuffer(cap * SLOT), cap).order.byteOffset;
        xa.fill(0, order + ua.count * 4, order + cap * 4); xb.fill(0, order + ub.count * 4, order + cap * 4);
        if (Buffer.compare(Buffer.from(xa), Buffer.from(xb)) !== 0) {
            let k = 0; while (xa[k] === xb[k]) k++;
            assert.fail(`tick ${tick}: frames differ from byte ${k} (slot field offset ${Math.floor(k / cap)})`);
        }
        threads = Math.max(threads, ma[i].phases[4]);
        frames++;
        A.held.push(ua.buf); B.held.push(ub.buf);
    }
    while (A.held.length > 1) { A.send({ type: 'release', buf: A.held.shift() }); B.send({ type: 'release', buf: B.held.shift() }); }
}
assert.equal(helperCount, 3, 'three helpers on 16 cores');
assert.equal(threads, 4, 'frames made by four threads');
assert.ok(frames >= 55, `frames compared: ${frames}`);
console.log(`PASS presentation-helpers: ${frames} frames of ${n} slots made by 4 threads equal the one-thread frames byte for byte (fill, ghosts shared and not, marks, order, index)`);
