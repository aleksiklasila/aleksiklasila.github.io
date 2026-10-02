// The separation's pair kernel (every touching pair once, both sides'
// pushes) gives each slot exactly the sums the per-unit kernel gathers
// (SIM_KERNEL_SEPARATION) on the same packed entries: crowded tiles, mixed
// owners, layers and radii, units taking part or not, moved or at rest,
// exact overlaps, empty and dead entries, and band boundaries.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ctx = vm.createContext({ Math, Atomics, Infinity, Float64Array, Int32Array, Uint8Array, Uint32Array, Array, Number });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/sim/sim_parallel.js'), 'utf8') +
    '\nglobalThis.K = { gather: SIM_KERNELS[SIM_KERNEL_SEPARATION], pairs: SIM_KERNELS[SIM_KERNEL_SEP_PAIRS] };', ctx);

function world(seed, CW, CH, n, opts) {
    let s = seed;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const cws = 32, units = [];
    for (let i = 0; i < n; i++) {
        // Crowds: a few clusters, some exactly on top of each other.
        const c = Math.floor(rnd() * 4), cx = (0.2 + 0.2 * c) * CW * cws, cy = (0.25 + 0.15 * c) * CH * cws;
        let x = cx + (rnd() - 0.5) * opts.spread, y = cy + (rnd() - 0.5) * opts.spread;
        if (i > 0 && rnd() < 0.05) { x = units[i - 1].x; y = units[i - 1].y; }
        x = Math.max(0, Math.min(CW * cws - 0.01, x)); y = Math.max(0, Math.min(CH * cws - 0.01, y));
        const key = Math.floor(y / cws) * CW + Math.floor(x / cws);
        units.push({ x, y, r: opts.radii[Math.floor(rnd() * opts.radii.length)], o: Math.floor(rnd() * 3), l: rnd() < 0.15 ? 1 : 0,
            sc: (rnd() < 0.5 ? 1 : 0) | (rnd() < 0.6 ? 2 : 0), id: 1 + Math.floor(rnd() * 1e6) * 7 + i, dead: rnd() < 0.03, key });
    }
    // Entries sorted by chunk (stable), slots a permutation.
    const order = units.map((u, i) => i).sort((a, b) => units[a].key - units[b].key || a - b);
    const slotOf = order.map((_, k) => (k * 7919) % n);
    const R = {}, A = (name, T, len) => (R['sep.' + name] = new T(len));
    for (const [nm, T] of [['ord', Int32Array], ['sx', Float64Array], ['sy', Float64Array], ['sr', Float64Array], ['so', Int32Array], ['sl', Uint8Array], ['sc', Uint8Array],
        ['sid', Float64Array], ['sdx', Float64Array], ['sdy', Float64Array], ['keys', Int32Array], ['ekey', Int32Array], ['jobs', Int32Array]]) A(nm, T, n);
    const nc = CW * CH;
    for (const [nm, T] of [['rs', Int32Array], ['rc', Int32Array], ['rstamp', Int32Array], ['chunkR', Float64Array], ['sole', Int32Array], ['chunkP', Uint8Array]]) A(nm, T, nc);
    A('box', Int32Array, nc * 4).fill(2e9);
    A('margin', Float64Array, 1);
    order.forEach((ui, k) => {
        const u = units[ui], slot = slotOf[k];
        R['sep.ord'][k] = u.dead ? -1 : slot; R['sep.keys'][k] = R['sep.ekey'][k] = u.key; R['sep.jobs'][k] = k;
        if (u.dead) { R['sep.sx'][k] = 1e9; R['sep.sy'][k] = 1e9; R['sep.sr'][k] = .1; R['sep.so'][k] = -3; R['sep.sl'][k] = 255; return; }
        // (Float32 values: the pair kernel's records hold them exactly.)
        R['sep.sx'][k] = Math.fround(u.x); R['sep.sy'][k] = Math.fround(u.y); R['sep.sr'][k] = Math.fround(u.r); R['sep.so'][k] = u.o; R['sep.sl'][k] = u.l; R['sep.sc'][k] = u.sc; R['sep.sid'][k] = u.id;
        const d = u.id & 3; R['sep.sdx'][k] = d === 0 ? 1 : d === 2 ? -1 : 0; R['sep.sdy'][k] = d === 1 ? 1 : d === 3 ? -1 : 0;
    });
    // The pair kernel's records (from the same values).
    R['sep.rec'] = new Float32Array(n * 4); R['sep.meta'] = new Int32Array(n);
    for (let k = 0; k < n; k++) {
        R['sep.rec'][k * 4] = R['sep.sx'][k]; R['sep.rec'][k * 4 + 1] = R['sep.sy'][k]; R['sep.rec'][k * 4 + 2] = R['sep.sr'][k];
        R['sep.meta'][k] = R['sep.ord'][k] < 0 ? (255 << 8 | 255) : (R['sep.sc'][k] << 16 | (R['sep.sl'][k] & 255) << 8 | (R['sep.so'][k] & 255));
    }
    for (let k = 0; k < n; k++) {
        const key = R['sep.keys'][k];
        if (k === 0 || R['sep.keys'][k - 1] !== key) { R['sep.rs'][key] = k; R['sep.rstamp'][key] = 5; R['sep.sole'][key] = -2; }
        R['sep.rc'][key]++;
        if (R['sep.ord'][k] < 0) continue;
        const b = key * 4, x = R['sep.sx'][k], y = R['sep.sy'][k];
        if (R['sep.box'][b] === 2e9) { R['sep.box'][b] = Math.floor(x); R['sep.box'][b + 1] = Math.ceil(x); R['sep.box'][b + 2] = Math.floor(y); R['sep.box'][b + 3] = Math.ceil(y); }
        else { R['sep.box'][b] = Math.min(R['sep.box'][b], Math.floor(x)); R['sep.box'][b + 1] = Math.max(R['sep.box'][b + 1], Math.ceil(x)); R['sep.box'][b + 2] = Math.min(R['sep.box'][b + 2], Math.floor(y)); R['sep.box'][b + 3] = Math.max(R['sep.box'][b + 3], Math.ceil(y)); }
        R['sep.chunkR'][key] = Math.max(R['sep.chunkR'][key], R['sep.sr'][k]);
        const so = R['sep.sole'][key]; R['sep.sole'][key] = so === -2 ? R['sep.so'][k] : (so === R['sep.so'][k] ? so : -1);
        if (R['sep.sc'][k] & 1) R['sep.chunkP'][key] = 1;
    }
    return { R, n, slotOf };
}

const pad = 16, Q = 1024, BOTH = 0.42, ONE = 0.6, MOVER = 0.2, YIELD = 0.65;
let cases = 0, contacts = 0;
for (const [seed, CW, CH, n, spread, radii] of [[3, 40, 30, 3000, 300, [4, 6, 8]], [11, 25, 25, 2500, 120, [8, 12]], [29, 60, 9, 1800, 500, [3, 12, 20]], [41, 12, 50, 2200, 200, [8]]]) {
    const { R, n: N } = world(seed, CW, CH, n, { spread, radii });
    const maxR = Math.max(...radii), farAny = 2 * maxR + pad, cws = 32, reach = Math.max(1, Math.ceil(farAny / cws)), H = Math.max(2, reach);
    const out = () => ({ px: new Float64Array(N), py: new Float64Array(N), ov: new Float64Array(N), hit: new Uint32Array(N) });
    const G = out(), Pp = out();
    const bind = o => { R['sep.px'] = o.px; R['sep.py'] = o.py; R['sep.ov'] = o.ov; R['sep.hit'] = o.hit; };
    bind(G);
    const Pg = [CW, CH, 64, pad, farAny, Q, BOTH, ONE, 0, N, cws, 5, MOVER, YIELD, 1];
    for (let c = 0; c < Math.ceil(N / 64); c++) ctx.K.gather(R, Pg, c);
    bind(Pp);
    const bands = Math.ceil(CH / H);
    for (const parity of [0, 1]) for (let c = 0; c < (parity ? Math.floor(bands / 2) : Math.ceil(bands / 2)); c++)
        ctx.K.pairs(R, [CW, CH, H, pad, farAny, Q, BOTH, ONE, 0, N, cws, 5, MOVER, YIELD, parity], c);
    for (let s = 0; s < N; s++) {
        assert.equal(Pp.hit[s], G.hit[s], `seed ${seed}: slot ${s} contacts`);
        assert.equal(Pp.px[s], G.px[s], `seed ${seed}: slot ${s} push x`);
        assert.equal(Pp.py[s], G.py[s], `seed ${seed}: slot ${s} push y`);
        assert.equal(Pp.ov[s], G.ov[s], `seed ${seed}: slot ${s} overlap`);
        contacts += G.hit[s];
    }
    cases++;
}
console.log(`PASS: pair kernel sums equal the per-unit kernel's (${cases} worlds, ${contacts} contact sides)`);
