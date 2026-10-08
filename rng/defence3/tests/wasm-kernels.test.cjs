// The Rust/wasm kernels (wasm/src/lib.rs, loaded by src/sim/sim_wasm.js)
// write exactly what their JavaScript twins write, byte for byte, on the
// same inputs: the separation chain (SEP_PACK from the tick-start copy and
// from the live columns, SEP_MARK, SEP_PAIRS both parities, FINISH with and
// without the index update, power-of-two and other tile / quantization
// sizes) and the acquisition scan. Inputs are random crowds with the edge
// cases: exact overlaps, dead units and empty entries, zero and NaN radii,
// units at the map's edge (rounding to -0) and off it, walls, every
// separation mode, ids near 2^31, -0 carried pushes.
//   node tests/wasm-kernels.test.cjs [seeds=6]
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ctx = vm.createContext({});
vm.runInContext(['sim_parallel.js', 'sim_wasm_bin.js', 'sim_wasm.js'].map(f => fs.readFileSync(path.join(__dirname, '../src/sim', f), 'utf8')).join('\n;\n') +
    `\nglobalThis.W = { reg: _simParReg, bind: simParallelBind, heap: simHeapArray, init: () => simWasmInit(), K: SIM_KERNELS,
        count: () => { const o = _simWasmX, c = {}, x = {}; for (const k in o) x[k] = typeof o[k] === 'function' ? (...a) => { c[k] = (c[k] || 0) + 1; return o[k](...a); } : o[k]; _simWasmX = x; return c; },
        ids: { PACK: SIM_KERNEL_SEP_PACK, MARK: SIM_KERNEL_SEP_MARK, PAIRS: SIM_KERNEL_SEP_PAIRS, FINISH: SIM_KERNEL_SEPARATION_FINISH, ACQ: SIM_KERNEL_ACQ_SCAN, OMT: SIM_KERNEL_ACQ_OMT } };`, ctx);
const W = ctx.W;
if (!W.init()) { console.log('SKIP: no wasm in this runtime'); process.exit(0); }

const seeds = Number(process.argv[2]) || 6;
// (Every wasm call counted: each kernel must have run there.)
const calls = W.count();
let compared = 0;

function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// Two copies of every array: plain ones (JS kernels; R is not the
// registry) and heap ones bound by name (the wasm kernels).
function arrays() {
    const A = {};
    return {
        A,
        add(name, T, len, fill) {
            const a = new T(Math.max(1, len));
            if (fill) for (let i = 0; i < a.length; i++) a[i] = fill(i);
            const h = W.heap(T, a.length); h.set(a); W.bind(name, h); A[name] = a;
            return a;
        },
        check(label, names) {
            for (const name of names || Object.keys(A)) {
                const a = A[name], b = W.reg[name];
                const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, a.byteLength);
                for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) {
                    const k = Math.floor(i / a.BYTES_PER_ELEMENT);
                    assert.fail(`${label}: ${name}[${k}] JS ${a[k]} wasm ${b[k]}`);
                }
                compared++;
            }
        }
    };
}
const runBoth = (S, id, P, chunks) => {
    const fn = W.K[id];
    for (let c = 0; c < chunks; c++) fn(S.A, P, c);
    for (let c = 0; c < chunks; c++) fn(W.reg, P, c);
};

function separationCase(seed) {
    const rnd = rng(seed * 7919 + 13), pick = a => a[Math.floor(rnd() * a.length)];
    const CW = 24 + Math.floor(rnd() * 40), CH = 20 + Math.floor(rnd() * 40), tile = pick([32, 32, 30]), quant = pick([8, 8, 10]);
    const n = 1500 + Math.floor(rnd() * 3000), nc = CW * CH, S = arrays();
    // Units: clusters (tight crowds), some on top of each other, some at
    // the map's left/top edge, some off it.
    const xs = [], ys = [];
    for (let i = 0; i < n; i++) {
        const c = Math.floor(rnd() * 5), cx = (0.1 + 0.2 * c) * CW * tile, cy = (0.15 + 0.17 * c) * CH * tile, spread = pick([60, 150, 400]);
        let x = cx + (rnd() - 0.5) * spread, y = cy + (rnd() - 0.5) * spread;
        if (i > 0 && rnd() < 0.06) { x = xs[i - 1]; y = ys[i - 1]; }
        if (rnd() < 0.02) { x = rnd() * 3 - 0.5; }
        if (rnd() < 0.02) { y = rnd() * 3 - 0.5; }
        x = Math.round(Math.min(CW * tile - 0.25, x) * quant) / quant; y = Math.round(Math.min(CH * tile - 0.25, y) * quant) / quant;
        xs.push(x); ys.push(y);
    }
    const slots = n + 37, slotOf = Array.from({ length: n }, (_, i) => (i * 7919 + 11) % slots);
    const col = (name, T, f) => S.add('unit.' + name, T, slots, f);
    const unitOf = new Int32Array(slots).fill(-1);
    slotOf.forEach((s, i) => { unitOf[s] = i; });
    const U = s => unitOf[s];
    const X = col('x', Float32Array, s => U(s) >= 0 ? xs[U(s)] : 0), Y = col('y', Float32Array, s => U(s) >= 0 ? ys[U(s)] : 0);
    // (The tick-start copy: a little behind.)
    col('x0', Float32Array, s => X[s] + (rnd() < 0.3 ? (rnd() - 0.5) * 4 : 0)); col('y0', Float32Array, s => Y[s]);
    col('prevX', Float32Array, s => rnd() < 0.5 ? X[s] : X[s] - 1); col('prevY', Float32Array, s => Y[s]);
    const dead = col('dead', Uint8Array, () => rnd() < 0.03 ? 1 : 0);
    col('sepD0', Uint8Array, s => rnd() < 0.02 ? 1 : dead[s]);
    const cr = col('collisionR', Float32Array, () => pick([4, 6, 8, 9, 12, 0, NaN]));
    const rr = col('r', Float32Array, () => pick([5, 7, 0, 0.05]));
    col('sepR0', Float32Array, s => Math.max(.1, cr[s] || rr[s] || .1));
    col('sepLayer', Uint8Array, () => pick([0, 0, 0, 1, 2])); col('sepL0', Uint8Array, s => W.reg['unit.sepLayer'][s]);
    col('owner', Int8Array, () => Math.floor(rnd() * 4));
    col('id', Int32Array, s => pick([s * 13 + 1, 2147483000 + s, 1 + Math.floor(rnd() * 1e6)]));
    col('sepMov', Uint8Array, () => rnd() < 0.5 ? 1 : 0);
    col('mvOn', Uint8Array, () => pick([0, 0, 1, 3])); col('mvFlags', Uint8Array, () => pick([0, 4, 64, 68]));
    col('sepCx', Float32Array, () => pick([0, 0, 0, -0, 0.75, -1.5, 3.25])); col('sepCy', Float32Array, () => pick([0, 0, -0, 0.5, -2]));
    col('spEpoch', Int32Array, () => rnd() < 0.9 ? 77 : 76); col('spOwner', Int8Array, s => rnd() < 0.95 ? W.reg['unit.owner'][s] : 3);
    col('sepKey', Uint32Array, () => rnd() < 0.95 ? Math.floor(rnd() * nc) : 0xFFFFFF); col('vsGen', Int32Array, () => rnd() < 0.9 ? 5 : 4);
    col('spTile', Int32Array, () => Math.floor(rnd() * nc)); col('spArea', Int32Array, () => -1);
    col('spMvOld', Int32Array, () => 0); col('spMvNew', Int32Array, () => 0); col('spMvOwn', Int8Array, () => rnd() < 0.1 ? 2 : 0);
    S.add('mv.wall', Uint8Array, nc, () => rnd() < 0.08 ? 1 : 0);
    S.add('ix.agrid', Int32Array, nc, () => rnd() < 0.1 ? -1 : Math.floor(rnd() * 50));
    // The index: alive units (as at its build) by chunk, a few empty entries.
    const ent = [];
    for (let i = 0; i < n; i++) {
        const s = slotOf[i];
        if (W.reg['unit.dead'][s] && rnd() < 0.5) continue;
        const gx = Math.min(CW - 1, Math.max(0, Math.floor(X[s] / tile))), gy = Math.min(CH - 1, Math.max(0, Math.floor(Y[s] / tile)));
        ent.push([gy * CW + gx, rnd() < 0.01 ? -1 : s]);
    }
    ent.sort((a, b) => a[0] - b[0]);
    const ne = ent.length, cap = ne + 64, ep = 9;
    S.add('sep.eslot', Int32Array, cap, k => k < ne ? ent[k][1] : -1); S.add('sep.ekey', Int32Array, cap, k => k < ne ? ent[k][0] : 0);
    const rs = new Int32Array(nc), rc = new Int32Array(nc), rst = new Int32Array(nc);
    for (let k = 0; k < ne; k++) { const key = ent[k][0]; if (rst[key] !== ep) { rst[key] = ep; rs[key] = k; } rc[key]++; }
    // (Stale ranges in chunks not stamped: never read.)
    S.add('sep.rs', Int32Array, nc, i => rst[i] === ep ? rs[i] : 99999); S.add('sep.rc', Int32Array, nc, i => rst[i] === ep ? rc[i] : 5); S.add('sep.rstamp', Int32Array, nc, i => rst[i] || (rnd() < 0.1 ? 3 : 0));
    S.add('ix.listed', Int32Array, 2, () => ne);
    for (const [nm, T, len] of [['ord', Int32Array, cap], ['qx', Float32Array, cap], ['qy', Float32Array, cap], ['qr', Float32Array, cap], ['meta', Int32Array, cap], ['qid', Int32Array, cap],
        ['chunkR', Float64Array, nc], ['chunkC', Uint8Array, nc], ['chunkP', Uint8Array, nc], ['sole', Int32Array, nc], ['box', Int32Array, nc * 4],
        ['px', Float64Array, slots], ['py', Float64Array, slots], ['ov', Float32Array, slots], ['hit', Uint32Array, slots],
        ['nextX', Float32Array, slots], ['nextY', Float32Array, slots], ['fast', Uint8Array, slots], ['ex', Int32Array, slots + 512], ['exc', Int32Array, Math.ceil(slots / 512) + 1], ['moves', Int32Array, 1]])
        S.add('sep.' + nm, T, len, () => 0);

    const mode = pick([0, 0, 1, 2]), rest = pick([4, 1, 6]), tick = 100 + Math.floor(rnd() * 50), live = rnd() < 0.5 ? 1 : 0;
    const PER = pick([1024, 64, 7]);
    runBoth(S, W.ids.PACK, [ne, PER, rest, tick, mode, live], Math.ceil(ne / PER) + 1);
    S.check(`seed ${seed} pack (mode ${mode}, live ${live}, per ${PER})`);
    runBoth(S, W.ids.MARK, [ne, 256, ep, CW, CH, tick, mode, live], Math.ceil(ne / 256));
    S.check(`seed ${seed} mark`);
    const pad = 16, maxR = 12, farAny = 2 * maxR + pad, cws = tile, reach = Math.max(1, Math.ceil(farAny / cws)), H = Math.max(2, 2 * reach), bands = Math.ceil(CH / H);
    for (const parity of [0, 1]) runBoth(S, W.ids.PAIRS, [CW, CH, H, pad, farAny, 1024, 0.42, 0.6, 0, ne, cws, ep, 0.2, 0.65, parity, live], parity ? Math.floor(bands / 2) : Math.ceil(bands / 2));
    S.check(`seed ${seed} pairs`);
    let hits = 0;
    for (let s = 0; s < slots; s++) hits += S.A['sep.hit'][s];
    const ix = rnd() < 0.7 ? 1 : 0, once = mode === 1;
    // (Without the walls sometimes: every crossing is listed.)
    if (rnd() < 0.2) { W.bind('mv.wall', null); delete S.A['mv.wall']; }
    runBoth(S, W.ids.FINISH, [slots, 512, tile, quant, 3, 1024, tick, 4, CW, CH, once ? 1 : pick([1, 1.3]), once ? 1 : 0.5, ix, 77, 5, rnd() < 0.5 ? 1 : 0, 1, CW, 0xFFFFFF], Math.ceil(slots / 512));
    S.check(`seed ${seed} finish (tile ${tile}, quant ${quant}, ix ${ix})`);
    let fast = [0, 0, 0, 0];
    for (let s = 0; s < slots; s++) fast[S.A['sep.fast'][s]]++;
    return `entries ${ne}, contacts ${hits}, fast ${fast.join('/')}`;
}

function acquisitionCase(seed) {
    const rnd = rng(seed * 104729 + 7), pick = a => a[Math.floor(rnd() * a.length)];
    const CW = 30 + Math.floor(rnd() * 50), CH = 30 + Math.floor(rnd() * 50), tile = 32, cs = 1, GW = CW, GH = CH, nc = CW * CH;
    const B = 4, bc = Math.ceil(CW / B), br = Math.ceil(CH / B), players = 3, Ar = 60, stride = bc + 1, plane = stride * (br + 1);
    const n = 2000 + Math.floor(rnd() * 3000), S = arrays(), ep = 4;
    const xs = new Float64Array(n), ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const c = Math.floor(rnd() * 4);
        xs[i] = (0.15 + 0.22 * c) * CW * tile + (rnd() - 0.5) * 900; ys[i] = (0.2 + 0.2 * c) * CH * tile + (rnd() - 0.5) * 900;
        xs[i] = Math.max(0, Math.min(CW * tile - 1, xs[i])); ys[i] = Math.max(0, Math.min(CH * tile - 1, ys[i]));
        if (rnd() < 0.01) xs[i] = -5;
    }
    S.add('acq.x', Float32Array, n, i => xs[i]); S.add('acq.y', Float32Array, n, i => ys[i]);
    S.add('acq.own', Int8Array, n, () => pick([0, 1, 2, 2, 5]));
    S.add('acq.flags', Uint8Array, n, () => pick([0, 0, 0, 1, 2, 4]));
    S.add('acq.cmd', Uint8Array, n, () => pick([0, 3, 2, 1]));
    S.add('acq.rng', Float32Array, n, () => pick([96, 160, 250, 0, 400.5]));
    S.add('acq.id', Int32Array, n, i => pick([i * 3 + 1, 1000 - i, 77]));
    for (const nm of ['out', 'tid', 'sout']) S.add('acq.' + nm, Int32Array, n, () => 5);
    S.add('acq.scls', Int8Array, nc, () => rnd() < 0.85 ? 0 : pick([1, 2, 3, 4, 5, -1]));
    S.add('acq.sown', Int8Array, nc, () => pick([-1, 0, 1, 2, -2]));
    S.add('acq.agrid', Int32Array, nc, () => rnd() < 0.05 ? -1 : Math.floor(rnd() * Ar));
    S.add('acq.cover', Uint8Array, Math.max(1024, players * Ar), () => rnd() < 0.8 ? 1 : 0);
    S.add('acq.hs', Int32Array, players * plane, () => pick([0, 1, 3]));
    if (rnd() < 0.7) S.add('acq.hss', Int32Array, players * plane, () => pick([0, 2])); else W.bind('acq.hss', null);
    const ent = [];
    for (let i = 0; i < n; i++) { if (rnd() < 0.02) continue; const gx = Math.min(CW - 1, Math.max(0, Math.floor(xs[i] / tile))), gy = Math.min(CH - 1, Math.floor(ys[i] / tile)); ent.push([gy * CW + gx, rnd() < 0.01 ? -1 : i]); }
    ent.sort((a, b) => a[0] - b[0]);
    const rs = new Int32Array(nc), rc = new Int32Array(nc), rst = new Int32Array(nc), om = new Uint8Array(nc);
    for (let k = 0; k < ent.length; k++) { const [key, s] = ent[k]; if (rst[key] !== ep) { rst[key] = ep; rs[key] = k; } rc[key]++; if (s >= 0) om[key] |= 1 << (S.A['acq.own'][s] & 7); }
    S.add('acq.es', Int32Array, ent.length + 4, k => k < ent.length ? ent[k][1] : -1);
    S.add('acq.rs', Int32Array, nc, i => rs[i]); S.add('acq.rc', Int32Array, nc, i => rc[i]); S.add('acq.rst', Int32Array, nc, i => rst[i]);
    S.add('acq.om', Uint8Array, nc, i => rnd() < 0.05 ? 0xFF : om[i]);
    // (The transposed owners first, as the tier's chain; half the seeds
    // without them: the scan's other path.)
    const omt = seed % 2 === 1;
    if (omt) {
        S.add('acq.omt', Uint8Array, nc, () => 7);
        for (const [nm, T] of [['ex', Float32Array], ['ey', Float32Array], ['eo', Int32Array], ['ea', Int32Array], ['eid', Int32Array]]) S.add('acq.' + nm, T, ent.length + 8, () => 3);
        runBoth(S, W.ids.OMT, [CW, CH, 16, ent.length, 333, tile, GW, GH], Math.max(Math.ceil(CH / 16), Math.ceil(ent.length / 333)));
        S.check(`seed ${seed} acquisition transpose and packing`);
    }
    // (By the index's entries on some seeds, by slot on the others.)
    const byEntry = seed % 3 !== 0;
    const P = [n, 256, 0, CW, CH, tile, ep, players, 0, 3, B, bc, br, 0, cs, GW, GH, 0, 2, 0, Ar, omt ? 1 : 0, byEntry ? 1 : 0, ent.length];
    runBoth(S, W.ids.ACQ, P, Math.ceil((byEntry ? ent.length : n) / 256));
    S.check(`seed ${seed} acquisition`);
    let found = 0, structs = 0;
    for (let i = 0; i < n; i++) { if (S.A['acq.out'][i] >= 0) found++; if (S.A['acq.sout'][i] >= 0) structs++; }
    return `units ${n}, targets ${found}, structures ${structs}`;
}

for (let seed = 1; seed <= seeds; seed++) {
    const a = separationCase(seed), b = acquisitionCase(seed);
    console.log(`seed ${seed}: separation ${a}; acquisition ${b}`);
}
for (const k of ['sep_pack', 'sep_mark', 'sep_pairs', 'sep_finish', 'acq_scan', 'acq_omt', 'acq_pack']) assert.ok(calls[k] > 0, 'no wasm call of ' + k);
console.log('wasm calls', JSON.stringify(calls));
console.log(`PASS: wasm kernels write what the JS kernels write (${compared} array comparisons, ${seeds} seeds)`);
