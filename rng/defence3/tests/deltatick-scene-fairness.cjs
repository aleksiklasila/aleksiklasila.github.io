'use strict';
// Step-size fairness at scale: a restored scene (~200k units; dk above 1 only happens under such load) run for the
// same base ticks at dk 1 and at larger steps, from the same state, real helpers. Per unit type: the average progress
// toward each walker's own destination a base tick (its straight distance to its destination tile's centre at the
// start minus at the end; walkers with the same destination at both ends, in every run compared), and the damage a
// base tick (energy lost by everything alive at the start, by the victims' type). Ratios to dk 1: about 1.0 wanted.
// ORDER=move: every unit that is not a worker ordered first to the map's mirror point (a march across, all at once).
// Usage: node --max-old-space-size=14000 tests/deltatick-scene-fairness.cjs [scene.gz] [dks=1,4,8,16] [ticks=480] [helpers=8]
// One run (internal): ... --one=dk
const path = require('node:path'), fs = require('node:fs'), { spawnSync } = require('node:child_process');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const scene = path.resolve(args[0] || path.join(__dirname, 'scenes/attack-200k-8teams.gz'));
const dks = (args[1] || '1,4,8,16').split(',').map(Number), TICKS = Number(args[2]) || 480, helpers = args[3] !== undefined ? Number(args[3]) : 8;
const one = (process.argv.find(a => a.startsWith('--one=')) || '').slice(6);

async function run(dk) {
    globalThis.self = { crossOriginIsolated: true };
    const H = require('./net-harness.cjs');
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
    if (process.env.ORDER === 'move') {
        // (Grouped by owner, one order each: every fighter to its mirror point across the map's centre.)
        host.eval(`(() => { const by = new Map(); for (const u of units) { if (!u || u.dead || u.workerType || u.isKing || !u.unitType) continue; (by.get(u.owner) || by.set(u.owner, []).get(u.owner)).push(u); }
            for (const [o, a] of by) { let sx = 0, sy = 0; for (const u of a) { sx += u.x; sy += u.y; } const W = GRID_W * TILE, Hh = GRID_H * TILE;
                const tx = Math.max(TILE, Math.min(W - TILE, W - sx / a.length)), ty = Math.max(TILE, Math.min(Hh - TILE, Hh - sy / a.length));
                const prev = localPlayerId; localPlayerId = o; queueAction({ action: 'move', unitIds: a.map(u => u.id), targetX: tx, targetY: ty }); localPlayerId = prev; } })()`);
        for (let i = 0; i < 4; i++) host.eval('gameTick()');
    }
    host.eval('simDk=' + dk + ';netStepTicks=()=>' + dk);
    // (Per slot of a live unit: id, type, walking (a flow walker), its destination tile, x, y, energy.)
    const snap = () => JSON.parse(host.eval(`JSON.stringify((() => { const c = _simUnitState.columns, n = _simUnitState.owners.length, k = c.x instanceof Int32Array ? 0.125 : 1, out = [];
        for (let s = 0; s < n; s++) { if (c.dead0[s] || !_simUnitState.owners.at(s) || c.dead[s]) continue;
            out.push([c.id[s], c.upT[s], c.mvOn[s] === 1 && (c.mvFlags[s] & 64) ? 1 : 0, c.mvDest[s], Math.round(c.x[s] * k * 8) / 8, Math.round(c.y[s] * k * 8) / 8, Math.round(c.energy[s] * 100) / 100]); }
        return { g: gameTime, W: GRID_W, T: TILE, names: _simUnitTypeNames, u: out }; })())`));
    const a = snap();
    // (Damage taken, gross: the shrine's pending count of each tick (data_dynamic.js shrineDamageTaken: energy lost to damage, never past
    // zero, so overkill does not count; hits and statuses), summed before shrineTick drains it.)
    host.eval('__scratch.dmg = 0; { const st = shrineTick; shrineTick = function () { const P = _shrinePendingFixed; for (let i = 0; i < P.length; i++) __scratch.dmg += P[i]; return st.apply(this, arguments); }; }');
    // (By source: each damage site's change of the pending count.)
    host.eval('__scratch.src = {}; __scratch.wrapSrc = (n, f) => function () { const P = () => { let s = 0; for (let i = 0; i < _shrinePendingFixed.length; i++) s += _shrinePendingFixed[i]; return s; }; const a = P(); try { return f.apply(this, arguments); } finally { { const k = n === \'_structHitsRun\' ? n + \':\' + arguments[0] : n; __scratch.src[k] = (__scratch.src[k] || 0) + P() - a; } } };');
    for (const n of ['unitHitsResolve', '_structHitsRun', 'statusPrepassRun', 'structStatusTick', 'tickStatusEffects', '_shrineAdd']) host.eval(`if (typeof ${n} === 'function') ${n} = __scratch.wrapSrc('${n}', ${n});`);
    // (The economy's tick-dependent counts: births (barrack.js _spawnBirths, _sb.out[0]), the workers' deposits (worker.js _wai), research levels
    // gained (all players), buildings completed.)
    host.eval('__scratch.eco = { births: 0, built: 0 }; { const sb = _spawnBirths; _spawnBirths = function () { const r = sb.apply(this, arguments); __scratch.eco.births += _sb.out[0]; return r; }; const mc = markConstructionComplete; markConstructionComplete = function () { __scratch.eco.built++; return mc.apply(this, arguments); }; }');
    const eco = () => JSON.parse(host.eval('JSON.stringify((() => { let rl = 0; for (const p of players) if (p && p.researchLevels) for (const k in p.researchLevels) rl += p.researchLevels[k]; return { dmg: __scratch.dmg, hits: (__scratch.src.unitHitsResolve || 0) + (__scratch.src[\'_structHitsRun:k_struct_hits\'] || 0), births: __scratch.eco.births, built: __scratch.eco.built, research: rl, rdep: _wai.researchDeposits || 0, cdep: _wai.collectorDeposits || 0, adep: _wai.astarDeposits || 0 }; })())'));
    const series = [], STEP = Number(process.env.EVERY) || 240;
    series.push([0, eco()]);
    const t0 = performance.now(), ms = [];
    while (Number(host.eval('gameTime')) < a.g + TICKS) { const q = performance.now(); host.eval('gameTick()'); ms.push(performance.now() - q); const g = Number(host.eval('gameTime')) - a.g; if (Math.floor(g / STEP) > Math.floor(series[series.length - 1][0] / STEP)) series.push([g, eco()]); }
    const b = snap();
    b.dmg = Number(host.eval('__scratch.dmg')); b.src = JSON.parse(host.eval('JSON.stringify(__scratch.src)'));
    if (series[series.length - 1][0] !== b.g - a.g) series.push([b.g - a.g, eco()]);
    return { dk, a, b, series, wallMs: performance.now() - t0, stepMs: ms };
}

if (one) {
    run(Number(one)).then(r => { fs.writeFileSync(process.env.OUT, JSON.stringify(r)); process.exit(0); }, e => { console.error(e); process.exit(1); });
    return;
}

const dir = process.env.DIR || path.join(__dirname, 'test-runs', 'dk-scene-fairness');
fs.mkdirSync(dir, { recursive: true });
const runs = [];
for (const dk of dks) {
    const out = path.join(dir, `${path.basename(scene, '.gz')}-dk${dk}${process.env.ORDER ? '-' + process.env.ORDER : ''}.json`);
    const t = Date.now();
    const r = spawnSync(process.execPath, ['--max-old-space-size=14000', __filename, scene, String(dk), String(TICKS), String(helpers), '--one=' + dk], { env: { ...process.env, OUT: out }, stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) { console.error('dk ' + dk + ' failed'); process.exit(1); }
    const j = JSON.parse(fs.readFileSync(out, 'utf8'));
    const sm = j.stepMs.slice().sort((x, y) => x - y);
    console.log(`dk ${dk}: ${j.b.g - j.a.g} base ticks in ${j.stepMs.length} steps (${((Date.now() - t) / 1000).toFixed(0)} s); alive ${j.a.u.length} -> ${j.b.u.length}; step p50 ${sm[sm.length >> 1].toFixed(1)} ms`);
    runs.push(j);
}
// ---- the per-type averages ----
const per = j => {
    const W = j.a.W, T = j.a.T, end = new Map(j.b.u.map(r => [r[0], r]));
    const walk = new Map(), lost = new Map();
    for (const r of j.a.u) {
        const e = end.get(r[0]);
        // (Energy lost: a unit gone by the end lost all it had; a healed one counts nothing.)
        lost.set(r[1], (lost.get(r[1]) || 0) + Math.max(0, r[6] - (e ? e[6] : 0)));
        if (!r[2] || !e || e[3] !== r[3]) continue;
        const cx = (r[3] % W) * T + T / 2, cy = Math.floor(r[3] / W) * T + T / 2;
        walk.set(r[0], [r[1], Math.hypot(cx - r[4], cy - r[5]) - Math.hypot(cx - e[4], cy - e[5])]);
    }
    return { ticks: j.b.g - j.a.g, walk, lost, names: j.a.names };
};
const P = runs.map(per), A = P[0];
const typeName = t => (A.names && A.names[t]) || ('type' + t);
for (let i = 1; i < P.length; i++) {
    const B = P[i], rows = [];
    // (Walkers in both runs, the same destination in each.)
    const byType = new Map();
    for (const [id, [t, d]] of A.walk) { const o = B.walk.get(id); if (!o) continue; const v = byType.get(t) || [0, 0, 0]; v[0] += d; v[1] += o[1]; v[2]++; byType.set(t, v); }
    for (const [t, [da, db, n]] of [...byType].sort((x, y) => y[1][2] - x[1][2])) if (n >= 50) rows.push(`${typeName(t)} n ${n} progress ${(da / n / A.ticks).toFixed(3)} -> ${(db / n / B.ticks).toFixed(3)} px/tick = ${((db / B.ticks) / (da / A.ticks)).toFixed(3)}x`);
    let la = 0, lb = 0; for (const v of A.lost.values()) la += v; for (const v of B.lost.values()) lb += v;
    const ga = runs[0].b.dmg / A.ticks, gb = runs[i].b.dmg / B.ticks;
    const dmg = [`gross (shrine count) ${ga.toExponential(3)} -> ${gb.toExponential(3)} = ${(gb / ga).toFixed(3)}x; net energy lost, by victim type: all ${((lb / B.ticks) / (la / A.ticks)).toFixed(3)}x`];
    for (const [t, v] of [...A.lost].sort((x, y) => y[1] - x[1]).slice(0, 6)) { const w = B.lost.get(t) || 0; if (v > 0) dmg.push(`${typeName(t)} ${((w / B.ticks) / (v / A.ticks)).toFixed(3)}x`); }
    const srcs = Object.keys({ ...runs[0].b.src, ...runs[i].b.src }).map(k => { const x = (runs[0].b.src[k] || 0) / A.ticks, y = (runs[i].b.src[k] || 0) / B.ticks; return `${k} ${x.toExponential(2)} -> ${(y / x).toFixed(3)}x`; });
    console.log(`  by source: ${srcs.join(', ')}`);
    // (Per base tick over the whole run, and the unit attacks in each interval.)
    const S0 = runs[0].series, S1 = runs[i].series, e0 = S0[S0.length - 1], e1 = S1[S1.length - 1];
    const rate = (s, k) => (s[s.length - 1][1][k] - s[0][1][k]) / s[s.length - 1][0];
    console.log('  economy: ' + ['births', 'built', 'research', 'rdep', 'cdep', 'adep'].map(k => { const x = rate(S0, k), y = rate(S1, k); return `${k} ${x.toFixed(3)} -> ${x ? (y / x).toFixed(3) + 'x' : y.toFixed(3)}`; }).join(', '));
    const iv = []; for (let j = 1; j < Math.min(S0.length, S1.length); j++) { const x = (S0[j][1].hits - S0[j - 1][1].hits) / (S0[j][0] - S0[j - 1][0]), y = (S1[j][1].hits - S1[j - 1][1].hits) / (S1[j][0] - S1[j - 1][0]); iv.push(x ? (y / x).toFixed(2) : '-'); }
    console.log('  unit attacks by interval: ' + iv.join(' '));
    console.log(`== dk ${runs[i].dk} / dk ${runs[0].dk}\n  movement: ${rows.join('\n            ')}\n  damage a base tick: ${dmg.join(', ')}`);
}
