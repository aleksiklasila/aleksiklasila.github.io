// Team + history's remembered structure columns (visibility_history.js
// historyStructureFrame: phases over a new table, the tiles in order, the
// emptied slots, the ghosts past the slots) against a plain model of what
// is remembered, structure by structure, over random matches: structures
// built and destroyed, slots taken over, energy at 0, light coming and
// going, passes with a new table or only new light. Every pass the frame's
// ghosts are exactly the model's remembered rows (as last seen), every
// structure seen now its table row and its live view, a ghost's source a
// frozen copy made once, a pass with nothing new keeps the version, and the
// renderer's GPU columns (uploaded by changed blocks) hold the frame's rows.
//   node tests/history-columns-model.test.cjs
'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const W = 40, HG = 32, CAP = 96;
const c = vm.createContext({ TILE: 32, GRID_W: W, GRID_H: HG, TICK_RATE: 20, gameTime: 0, visibilityVersion: 0, fullVisibility: false,
    units: [], projectiles: [], particles: [], droppedItems: [], grid: [], simClientActive: () => true, _simClient: { structMver: 0 } });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/audio_visual/visibility_history.js'), 'utf8'), c);
const COLS = vm.runInContext('HISTORY_COLUMNS', c), GHOST = vm.runInContext('HISTORY_GHOST_FLAG', c);
// (The renderer, on a GPU that keeps its buffers' bytes; partial: uploads
// of a part of a column.)
const r3 = vm.createContext({ window: {}, console, performance, AREA_UNIT_TILE_EQUIVALENT: 5 });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/audio_visual/renderer3d.js'), 'utf8'), r3);
const R = Object.create(r3.window.Defence3Renderer3D.prototype), bound = {};
const gl = R.gl = { partial: 0, ARRAY_BUFFER: 1, DYNAMIC_DRAW: 4, FLOAT: 5, INT: 6, SHORT: 7, UNSIGNED_BYTE: 8,
    createBuffer: () => ({ data: new Uint8Array(0) }), createVertexArray: () => ({}), bindVertexArray() { }, bindBuffer(t, b) { bound[t] = b; },
    bufferData(t, size) { bound[t].data = new Uint8Array(size); },
    bufferSubData(t, dst, a, from, length) {
        if (from !== undefined) this.partial++;
        from = from || 0; length = length === undefined ? a.length - from : length;
        const bytes = new Uint8Array(a.buffer, a.byteOffset + from * a.BYTES_PER_ELEMENT, length * a.BYTES_PER_ELEMENT);
        assert.ok(dst >= 0 && dst + bytes.length <= bound[t].data.length, 'upload inside the buffer');
        bound[t].data.set(bytes, dst);
    },
    enableVertexAttribArray() { }, disableVertexAttribArray() { }, vertexAttrib1f() { }, vertexAttribPointer() { } };
const TYPES = { x: Float32Array, y: Float32Array, energy: Float32Array, angle: Float32Array, vision: Float32Array, amount: Float32Array,
    serial: Int32Array, flags: Int32Array, kind: Int16Array, gx: Int16Array, gy: Int16Array, owner: Int16Array, type: Int16Array, utype: Int16Array, alive: Uint8Array };

let partialAll = 0, deferredAll = 0;
// (budget: ghosts' sources made a pass; 1: most of them later, drawn as
// glyphs meanwhile.)
for (const [seed0, budget] of [[1, 150], [2, 150], [3, 150], [4, 150], [5, 150], [6, 150], [7, 150], [8, 150], [9, 1], [10, 1], [11, 1], [12, 1]]) {
    vm.runInContext('HISTORY_SNAPSHOTS_PER_PASS = ' + budget, c);
    let seed = seed0 * 7919;
    const rnd = () => ((seed = Math.imul(seed, 1664525) + 1013904223 | 0) >>> 0) / 4294967296;
    const pick = n => Math.floor(rnd() * n);
    let T = { n: 0, cap: CAP };
    for (const k of COLS) T[k] = new TYPES[k](CAP);
    const views = [];
    c._pageTables = { s: T }; c._pageStructViews = views; c._simClient.structMver = 0;
    let serial = 0;
    const light = new Float32Array(W * HG);
    const rows = flat => { const r = Array.from({ length: HG }, (_, y) => flat.subarray(y * W, (y + 1) * W)); r._flat = flat; return r; };
    const h = { light: rows(light), fog: rows(new Float32Array(W * HG)), width: W, height: HG, explored: new Uint8Array(W * HG) };
    c.__h = h; vm.runInContext('visibilityHistoryState = __h; teamVisibilityHistory = true;', c);
    c.updateLocalVisibilityHistory(h);
    const present = s => T.alive[s] !== 0 && T.kind[s] !== 6 && (T.kind[s] >= 4 || T.energy[s] > 0);
    const lit = (gx, gy) => light[gy * W + gx] > 0;
    const rowOf = s => COLS.map(k => T[k][s]);
    // (A slot's new structure: a new serial, somewhere, a new view.)
    const build = s => {
        const kind = rnd() < .08 ? 6 : pick(6), gx = pick(W), gy = pick(HG);
        T.alive[s] = 1; T.serial[s] = ++serial; T.kind[s] = kind; T.gx[s] = gx; T.gy[s] = gy; T.x[s] = (gx + .5) * 32; T.y[s] = (gy + .5) * 32;
        T.energy[s] = kind < 4 ? 1 + pick(50) : 0; T.amount[s] = kind === 4 || kind === 5 ? pick(500) : 0; T.owner[s] = pick(4) - 1;
        T.type[s] = pick(9); T.utype[s] = pick(5); T.angle[s] = rnd(); T.vision[s] = pick(8); T.flags[s] = pick(3);
        views[s] = { _s: s, _serial: serial, _structView: true, dead: false, gx, gy, x: T.x[s], y: T.y[s], type: 't' + T.type[s], energy: T.energy[s], owner: T.owner[s] };
        if (s >= T.n) T.n = s + 1;
    };
    for (let s = 0; s < 40; s++) build(s);
    // The model: what is remembered, by serial.
    const mem = new Map();
    const modelStep = () => {
        const at = new Map();
        for (let s = 0; s < T.n; s++) if (present(s)) at.set(T.serial[s], s);
        for (const [ser, m] of mem) if (!at.has(ser)) { if (lit(m.gx, m.gy)) mem.delete(ser); else m.ghost = true; }
        for (const [ser, s] of at) {
            const m = mem.get(ser);
            if (lit(T.gx[s], T.gy[s])) mem.set(ser, { ghost: false, row: rowOf(s), gx: T.gx[s], gy: T.gy[s] });
            else if (m) m.ghost = true;
        }
    };
    const snaps = new Map();
    let passes = 0, ghostsSeen = 0, detached = 0, kept = 0, partial = 0, deferred = 0;
    // The renderer's structure columns (renderer3d.js _columnStoreUpload) on
    // a GPU that keeps its buffers' bytes: whole columns on a new stream,
    // else the blocks stamped after the version the buffer holds.
    R.columnStores = [{}, {}];
    const before = gl.partial;
    for (let step = 0; step < 400; step++) {
        const newTable = rnd() < .35;
        if (newTable) {
            // (A new table from the worker: new column arrays, the old rows copied.)
            const next = { n: T.n, cap: CAP };
            for (const k of COLS) next[k] = T[k].slice();
            T = next; c._pageTables.s = T;
            let membership = false;
            for (let k = pick(4); k > 0; k--) {
                const s = pick(T.n + 1 < CAP ? T.n + 1 : T.n);
                if (s < T.n && T.alive[s] && rnd() < .5) { T.alive[s] = 0; views[s].dead = true; membership = true; }
                else { build(s); membership = true; }
            }
            for (let k = pick(6); k > 0; k--) { const s = pick(T.n); if (T.alive[s] && T.kind[s] < 4) T.energy[s] = rnd() < .2 ? 0 : 1 + pick(50); }
            for (let k = pick(6); k > 0; k--) { const s = pick(T.n); if (T.alive[s]) { T.angle[s] = rnd(); T.amount[s] = pick(500); } }
            if (membership) c._simClient.structMver++;
        }
        for (let k = pick(12); k > 0; k--) { const i = pick(W * HG); light[i] = rnd() < .5 ? 0 : 1 + rnd() * 5; }
        if (rnd() < .1) { const x0 = pick(W - 8), y0 = pick(HG - 8), v = rnd() < .5 ? 0 : 3; for (let y = y0; y < y0 + 8; y++) light.fill(v, y * W + x0, y * W + x0 + 8); }
        c.visibilityVersion++; c.gameTime++;
        modelStep();
        const F = c.historyStructureFrame(h);
        passes++;
        R._columnStoreUpload(0, F);
        const S = R.columnStores[0], data = S.buffer.data;
        for (const k of F.dirty.cols) {
            const a = F[k], g = new a.constructor(data.buffer, data.byteOffset + S.offsets.get(k), F.n);
            for (let s = 0; s < F.n; s++) assert.ok(Object.is(g[s], a[s]), `seed ${seed0} step ${step}: the GPU's ${k}@${s} as the frame's`);
        }
        const ghosts = new Map();
        for (let s = 0; s < F.n; s++) {
            if (F.flags[s] & GHOST) {
                const ser = F.serial[s];
                assert.ok(!ghosts.has(ser), 'one ghost per structure');
                ghosts.set(ser, s);
                if (s >= T.n) detached++;
                const src = F.sources[s];
                assert.ok(src ? src._historyGhost && src.gx === F.gx[s] && src.gy === F.gy[s] : budget < 150, 'a ghost\'s source is a frozen copy at its place (or to be made)');
                if (!src) deferred++;
                else if (snaps.has(ser) && snaps.get(ser).src === src) kept++;
                snaps.set(ser, { src });
                continue;
            }
            assert.ok(s < T.n, 'past the slots only ghosts');
            for (const k of COLS) assert.ok(Object.is(F[k][s], T[k][s]), `seed ${seed0} step ${step}: a row not remembered is the table's (${k}@${s})`);
            if (present(s) && lit(T.gx[s], T.gy[s])) assert.equal(F.sources[s], views[s], 'seen now: the live view');
        }
        const expected = [...mem].filter(([, m]) => m.ghost);
        ghostsSeen += expected.length;
        assert.equal(ghosts.size, expected.length, `seed ${seed0} step ${step}: as many ghosts as the model remembers`);
        for (const [ser, m] of expected) {
            const s = ghosts.get(ser);
            assert.ok(s !== undefined, `seed ${seed0} step ${step}: structure ${ser} remembered`);
            COLS.forEach((k, i) => { if (k !== 'flags' && k !== 'alive') assert.ok(Object.is(F[k][s], m.row[i]), `seed ${seed0} step ${step}: ${k} of ${ser} as last seen`); });
            assert.equal(F.flags[s], m.row[COLS.indexOf('flags')] | GHOST);
            assert.equal(F.alive[s], 1);
        }
        for (const [ser] of snaps) if (!ghosts.has(ser)) snaps.delete(ser);
        // Nothing new: the same version (no upload).
        if (rnd() < .2) { const ver = F.ver; c.visibilityVersion++; assert.equal(c.historyStructureFrame(h).ver, ver, 'nothing new, no new version'); }
    }
    // (Passes with nothing new: every ghost's source made.)
    for (let k = 0; k < 300; k++) {
        c.visibilityVersion++;
        const F = c.historyStructureFrame(h);
        let missing = 0;
        for (let s = 0; s < F.n; s++) if ((F.flags[s] & GHOST) && !F.sources[s]) missing++;
        if (!missing) break;
        assert.ok(k < 299, 'every ghost\'s source made in time');
    }
    deferredAll += deferred;
    partial = gl.partial - before; partialAll += partial;
    assert.ok(ghostsSeen > 50 && detached > 0 && kept > 0 && partial > 2, `seed ${seed0}: ghosts ${ghostsSeen}, past the slots ${detached}, kept copies ${kept}, partial uploads ${partial}`);
}
assert.ok(partialAll > 60 && deferredAll > 5, 'partial uploads: ' + partialAll + ', sources made later: ' + deferredAll);
console.log(`PASS history-columns-model: 12 random matches x 400 passes, the frame is the model's remembered and seen structures, the GPU's copy kept by changed blocks (${partialAll} partial uploads)`);
