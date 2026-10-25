// The renderer's unit columns uploaded in part (renderer3d.js
// _columnStoreUpload / _columnStoreUploadChanged) from the blocks of slots
// the presentation worker marks changed (presentation_worker.js markDirty):
// through random ticks (moves, stops, turns, damage, deaths, spawns, slot
// reuse, flashes, metadata changes, more and fewer slots, a larger capacity)
// with the page drawing only some of the frames, the GPU buffer holds every
// live slot's values of the drawn frame bit for bit (and dead slots as
// dead); and the bytes uploaded are a fraction of whole columns.
//   node tests/column-dirty-upload.test.cjs
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const src = path.join(__dirname, '../src');
let seed = 9173;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

// ---- the presentation worker ----
const jobs = [], messages = [];
const W = vm.createContext({ console, performance, setTimeout: fn => jobs.push(fn), postMessage: m => messages.push(m) });
W.self = W;
W.importScripts = (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(src, 'sim', f.split('?')[0]), 'utf8'), W); };
vm.runInContext(fs.readFileSync(path.join(src, 'sim/presentation_worker.js'), 'utf8'), W);
const send = data => {
    W.onmessage({ data });
    while (jobs.length) jobs.shift()();
    assert.equal(messages.some(m => m.type === 'error'), false, JSON.stringify(messages.filter(m => m.type === 'error')));
};
// (Status timers by status record, stIx: here record s + 1 for slot s.)
const ST = ['stBu', 'stPo', 'stFr', 'stWe', 'stSa', 'stWa', 'stTh'];
const COLS = ['id', 'owner', 'x', 'y', 'prevX', 'prevY', 'vx', 'vy', 'energy', 'r', 'commandState', 'attackFlash', ...ST,
    'workerTransferCooldown', 'effectiveLevel', 'unitLevel', 'live', 'dead', 'maxE', 'stIx'];
let C = null, M = null, cap = 0, n = 0, nextId = 1;
const metaRev = new Int32Array(new SharedArrayBuffer(4));
function bind(newCap) {
    const C2 = {};
    for (const k of COLS) C2[k] = k === 'id' || k === 'stIx' ? new Int32Array(new SharedArrayBuffer(newCap * 4)) : new Float32Array(new SharedArrayBuffer((newCap + 1) * 4));
    for (let s = 0; s < newCap; s++) C2.stIx[s] = s + 1;
    const M2 = W.simMetaViews(new SharedArrayBuffer(newCap * vm.runInContext("SIM_META_SLOT_BYTES", W)), newCap);
    M2.id.fill(-1); C2.id.fill(-1);
    if (C) { for (const k of COLS) if (k !== 'stIx') C2[k].set(C[k].subarray(0, ST.includes(k) ? n + 1 : n)); for (const k of ['id', 'type', 'vision', 'watchedBy']) M2[k].set(M[k].subarray(0, n)); }
    C = C2; M = M2; cap = newCap;
    send({ type: 'bind', epoch: 1, generation: 1, columns: C, meta: { buf: M.buf, cap }, metaRev });
}
function spawn(s) {
    const id = nextId++;
    C.id[s] = id; C.live[s] = 1; C.dead[s] = 0; C.owner[s] = rnd() < .5 ? 0 : 1; C.energy[s] = 10 + Math.floor(rnd() * 20); C.r[s] = 6 + Math.floor(rnd() * 4);
    C.x[s] = C.prevX[s] = 100 + rnd() * 4000; C.y[s] = C.prevY[s] = 100 + rnd() * 4000; C.vx[s] = C.vy[s] = 0;
    M.id[s] = id; M.type[s] = 1 + Math.floor(rnd() * 5); M.vision[s] = 2 + Math.floor(rnd() * 3);
    Atomics.add(metaRev, 0, 1);
}
function kill(s) { C.live[s] = 0; C.dead[s] = 1; }

// ---- the renderer, on a GPU that keeps its buffers' bytes ----
const r3 = vm.createContext({ window: {}, console, performance, AREA_UNIT_TILE_EQUIVALENT: 5 });
vm.runInContext(fs.readFileSync(path.join(src, 'audio_visual/renderer3d.js'), 'utf8'), r3);
const R = Object.create(r3.window.Defence3Renderer3D.prototype);
const bound = {}, gpu = { subData: 0, copies: 0 };
R.gl = {
    ARRAY_BUFFER: 1, COPY_READ_BUFFER: 2, COPY_WRITE_BUFFER: 3, DYNAMIC_DRAW: 4, FLOAT: 5, INT: 6, SHORT: 7, UNSIGNED_BYTE: 8,
    createBuffer: () => ({ data: new Uint8Array(0) }), createVertexArray: () => ({}), bindVertexArray() { },
    bindBuffer(t, b) { bound[t] = b; },
    bufferData(t, size) { bound[t].data = new Uint8Array(size); },
    bufferSubData(t, dst, a, from = 0, length = a.length - from) {
        const bytes = new Uint8Array(a.buffer, a.byteOffset + from * a.BYTES_PER_ELEMENT, length * a.BYTES_PER_ELEMENT);
        assert.ok(dst >= 0 && dst + bytes.length <= bound[t].data.length, 'upload inside the buffer');
        bound[t].data.set(bytes, dst); gpu.subData++;
    },
    copyBufferSubData(rt, wt, ro, wo, size) {
        const a = bound[rt], b = bound[wt];
        assert.ok(a && b && a === b && (ro + size <= wo || wo + size <= ro), 'copy within the buffer, ranges apart');
        assert.ok(ro >= 0 && wo >= 0 && ro + size <= a.data.length && wo + size <= b.data.length);
        b.data.set(a.data.slice(ro, ro + size), wo); gpu.copies++;
        assert.fail('no GPU copies (they stall ANGLE)');
    },
    enableVertexAttribArray() { }, disableVertexAttribArray() { }, vertexAttrib1f() { }, vertexAttribPointer() { }
};
R.columnStores = [{}, {}];
// (As sim_client.js _simClientApplyFrame makes the page's frame.)
function pageFrame(m) {
    const u = m.world.units, F = W.simFrameViews(u.buf, u.cap);
    F.n = u.n; F.count = u.count;
    const D = u.dirty;
    F.dirty = { seq: D.seq, stream: D.stream, block: D.block, nb: D.nb, cols: D.cols, stamps: new Int32Array(F.buf, D.offset, D.cols.length * D.nb) };
    return F;
}
const GPU_COLS = ['x', 'y', 'px', 'py', 'r', 'energy', 'owner', 'flags', 'id', 'type', 'facing', 'phase', 'prate', 'vision', 'mode', 'amount'];
let checked = 0, liveChecked = 0, wholeBytes = 0;
function check(F) {
    const S = R.columnStores[1], data = S.buffer.data;
    for (const name of GPU_COLS) {
        const a = F[name], off = S.offsets.get(name);
        const g = new a.constructor(data.buffer, data.byteOffset + off, F.n);
        const bits = a.BYTES_PER_ELEMENT === 4 ? [new Int32Array(a.buffer, a.byteOffset, F.n), new Int32Array(data.buffer, data.byteOffset + off, F.n)] : [a, g];
        for (let s = 0; s < F.n; s++) {
            if (F.id[s] >= 0) assert.equal(bits[1][s], bits[0][s], `slot ${s} ${name}: the GPU holds the drawn frame's value`);
            else if (name === 'id') assert.ok(g[s] < 0, `slot ${s}: dead on the GPU`);
        }
        wholeBytes += F.n * a.BYTES_PER_ELEMENT;
    }
    for (let s = 0; s < F.n; s++) if (F.id[s] >= 0) liveChecked++;
    checked++;
}

// ---- random ticks ----
bind(3000);
n = 1500;
for (let s = 0; s < n; s++) spawn(s);
send({ type: 'strings', strings: [''] });
send({ type: 'ready' });
const held = [];
let tick = 0, lastSeen = 0;
// Movers: a few groups of nearby slots (squads: spawned together) and strays.
const movers = new Set();
function pickMovers() {
    movers.clear();
    for (let g = 0; g < 3; g++) { const s0 = Math.floor(rnd() * n), len = 20 + Math.floor(rnd() * 200); for (let s = s0; s < Math.min(n, s0 + len); s++) movers.add(s); }
    for (let k = 0; k < 15; k++) movers.add(Math.floor(rnd() * n));
}
pickMovers();
for (tick = 1; tick <= 500; tick++) {
    if (tick % 40 === 0) pickMovers();
    for (let s = 0; s < n; s++) { C.prevX[s] = C.x[s]; C.prevY[s] = C.y[s]; C.vx[s] = 0; C.vy[s] = 0; if (C.attackFlash[s] > 0) C.attackFlash[s]--; }
    for (const s of movers) if (s < n && C.live[s]) { const dx = (rnd() - .3) * 4, dy = (rnd() - .6) * 4; C.x[s] += dx; C.y[s] += dy; C.vx[s] = dx; C.vy[s] = dy; }
    // (A teleport: a jump past the smoothing's snap distance.)
    if (rnd() < .2) { const s = Math.floor(rnd() * n); C.x[s] += 500; }
    for (let k = 0; k < 4; k++) { const s = Math.floor(rnd() * n); if (C.live[s]) C.energy[s] -= 3; }
    for (let k = 0; k < 3; k++) { const s = Math.floor(rnd() * n); C.attackFlash[s] = 8; }
    if (rnd() < .3) { const s = Math.floor(rnd() * n); C.stBu[s + 1] = C.stBu[s + 1] > 0 ? 0 : 5; }
    if (rnd() < .1) { const s = Math.floor(rnd() * n); C.owner[s] = 1 - C.owner[s]; }
    // (+0 / -0: equal as numbers, not as bits; a word of two zero radii.)
    if (rnd() < .3) { const s = 2 * Math.floor(rnd() * n / 2); C.r[s] = 0; C.r[s + 1] = Object.is(C.r[s + 1], -0) ? 0 : -0; }
    if (rnd() < .1) { const s = Math.floor(rnd() * n); M.type[s] = 1 + Math.floor(rnd() * 5); Atomics.add(metaRev, 0, 1); }
    for (let k = 0; k < 3; k++) { const s = Math.floor(rnd() * n); if (C.live[s]) kill(s); }
    // Slot reuse: a dead slot dealt to a new unit (sometimes in the same tick).
    for (let k = 0; k < 3; k++) { const s = Math.floor(rnd() * n); if (!C.live[s] || rnd() < .05) spawn(s); }
    if (rnd() < .08 && n + 300 <= cap) { for (let s = n; s < n + 300; s++) spawn(s); n += 300; }
    if (rnd() < .04 && n > 900) { for (let s = n - 200; s < n; s++) kill(s); n -= 200; }
    if (tick === 300) bind(5000);
    send({ type: 'tick', epoch: 1, tick, time: tick, rate: 20, player: 0, areaUnit: 2, n });
    for (const m of messages.splice(0)) {
        if (m.type !== 'presentation') continue;
        lastSeen = m.tick;
        // The page draws some frames; every frame is shown, then given back.
        if (rnd() < .65) { const F = pageFrame(m); R._columnStoreUpload(1, F); check(F); }
        held.push(m.world.units.buf);
        while (held.length > 1 + (rnd() < .3 ? 1 : 0)) send({ type: 'release', buf: held.shift() });
    }
}
assert.ok(lastSeen > 450 && checked > 250, `frames drawn: ${checked}`);
const st = R.columnUploadStats;
assert.ok(st.full <= 4, `whole uploads only at the start and a new capacity: ${st.full}`);
assert.ok(st.bytes < wholeBytes * .75, `uploaded ${st.bytes} of ${wholeBytes} bytes`);
console.log(`PASS column-dirty-upload: ${checked} drawn frames (${liveChecked} live slots) matched on the GPU; uploaded ${(st.bytes / wholeBytes * 100).toFixed(1)}% of whole columns, ${st.full} whole uploads, ${st.calls} calls`);
