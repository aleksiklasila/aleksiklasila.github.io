// Rally-into-own-crowd scenario (the user's in/out pulse report): a dense
// field of units, a square of them selected, ordered to the square's own
// centre. Per sample: mean/percentile distance to the goal, units moving in
// vs out, idle count, tick ms. Pulsing shows as repeated out-waves.
//   node --max-old-space-size=12000 tests/rally-pulse.bench.cjs --units=400000 --map=1000 --group=50000 --dk=1 --secs=40 --helpers=7
// 4M needs Node 24 (memory64). --walker=1 adds one unit walking from outside
// into the settled crowd (its closest distance to the goal is reported).
// --repeat=k re-issues the same order every k seconds (re-rally).
'use strict';
const fs = require('node:fs'), path = require('node:path');
const { performance } = require('node:perf_hooks');
const arg = (k, d) => { const a = process.argv.find(v => v.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const count = Number(arg('units', 400000)), map = Number(arg('map', 1000)), groupN = Number(arg('group', 50000));
const dk = Number(arg('dk', 1)), secs = Number(arg('secs', 40)), helpers = Number(arg('helpers', 7));
const perTile = Number(arg('per-tile', 4)), every = Number(arg('every', 1)), walker = Number(arg('walker', 0));
const leaver = Number(arg('leaver', 0)), repeat = Number(arg('repeat', 0)), tune = arg('tune', ''), out = arg('out', '');
const types = arg('types', 'norm,norm,fast,tank').split(',');
if (helpers) globalThis.self = { crossOriginIsolated: true };
const H = require('./net-harness.cjs');
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': String(map), 'cfg-map-type': 'arena',
    'cfg-gold-count': '0', 'cfg-astar-mine-count': '0', 'cfg-full-vis': 'full',
    'cfg-max-pop': String(Math.ceil(count / 2) + 1000), 'cfg-starting-energy': '1000000000000000', 'cfg-starting-astar': '1000000000000000' };
const world = new H.World({ controls });
const inst = world.spawn('rallypulse', { controls, simWorker: false });
inst.scratch.now = () => performance.now();
if (helpers) {
    inst.scratch.Worker = require('./real-sim-helper.cjs');
    inst.eval(`Worker=__scratch.Worker; navigator.hardwareConcurrency=32; simParallelInit('',${helpers});`);
}
const t0 = performance.now();
// Two owners, each a square block at perTile units a tile (2x2 at 16 px for
// 4); owner 0's block centred on the map's left half, owner 1's on the right.
inst.eval(`startingResourcesConfig = normalizeStartingResourcesConfig({spawnCounts:{},researchLevels:{}});
    applyMainMenuControlsToRuntimeState(); startSoloGame();
    {
        const per = ${perTile}, side = Math.round(Math.sqrt(per)), sp = TILE / side;
        const each = Math.floor((${count} - units.length) / 2), tilesSide = Math.ceil(Math.sqrt(each / per));
        if (tilesSide * 2 + 8 > GRID_W) throw Error('map too small for ' + ${count} + ' units at ' + per + ' a tile');
        simUnitStateReserve(each * 2 + 1024);
        const reserved = units.map(u => [u.x, u.y, Math.max(48, u.r + 24)]);
        const types = ${JSON.stringify(types)};
        __scratch.blocks = [];
        for (let owner = 0; owner < 2; owner++) {
            const cx = owner ? Math.floor(GRID_W * 3 / 4) : Math.floor(GRID_W / 4), cy = Math.floor(GRID_H / 2);
            const x0 = Math.max(2, cx - (tilesSide >> 1)), y0 = Math.max(2, cy - (tilesSide >> 1));
            __scratch.blocks.push({ x0, y0, tilesSide, cx, cy });
            let added = 0;
            for (let ty = 0; ty < tilesSide && added < each; ty++) for (let tx = 0; tx < tilesSide && added < each; tx++)
                for (let k = 0; k < per && added < each; k++) {
                    const x = (x0 + tx) * TILE + sp / 2 + (k % side) * sp, y = (y0 + ty) * TILE + sp / 2 + Math.floor(k / side) * sp;
                    if (getTileEntityRef(x0 + tx, y0 + ty)) continue;
                    if (reserved.some(v => Math.abs(x - v[0]) < v[2] && Math.abs(y - v[1]) < v[2])) continue;
                    const u = new Unit(types[(tx + ty * 7 + k) % types.length], owner, x, y);
                    if (u.dead) continue;
                    units.push(u); players[owner].popCount++; updateUnitSpatial(u); added++;
                }
        }
        simDk = ${dk};
    }
    ${tune}`);
for (let i = 0; i < 3; i++) inst.eval('gameTick();currentTick++');
// The selection: owner 0's units inside a square around its block centre,
// the groupN closest by Chebyshev distance (as a box drag would take).
const sel = inst.eval(`(() => {
    const b = __scratch.blocks[0], gx = b.cx * TILE + 16, gy = b.cy * TILE + 16;
    const mine = units.filter(u => u.owner === 0 && !u.dead && !u.isKing && !u.workerState);
    mine.sort((a, c) => Math.max(Math.abs(a.x - gx), Math.abs(a.y - gy)) - Math.max(Math.abs(c.x - gx), Math.abs(c.y - gy)) || a.id - c.id);
    const g = mine.slice(0, ${groupN});
    __scratch.group = g; __scratch.goal = [gx, gy];
    __scratch.order = () => { const ids = g.filter(u => !u.dead).map(u => u.id); for (let i = 0; i < ids.length; i += 20000) processAction(sanitizeAction({ action: 'move', unitIds: ids.slice(i, i + 20000), targetX: gx, targetY: gy }), 0); };
    let half = 0; for (const u of g) half = Math.max(half, Math.max(Math.abs(u.x - gx), Math.abs(u.y - gy)));
    return { n: g.length, halfTiles: half / TILE, goal: [gx, gy], total: units.length };
})()`);
console.error('setup', JSON.stringify({ ...sel, ms: Math.round(performance.now() - t0) }));
inst.eval(`__scratch.order();`);
if (walker) inst.eval(`(() => {
    // A lone unit placed outside the selection (a few tiles beyond its edge),
    // ordered to the same goal once the crowd has had time to settle.
    // (Outside owner 0's whole block: it walks in through any resting
    // units beside the selection, then into the settled group.)
    const [gx, gy] = __scratch.goal, b = __scratch.blocks[0];
    let x = (b.x0 - 6) * TILE + 16, y = gy;
    for (const u of units) if (!u.dead && Math.abs(u.x - x) < 20 && Math.abs(u.y - y) < 20) { u.dead = true; }
    const w = new Unit('norm', 0, x, y); units.push(w); players[0].popCount++; updateUnitSpatial(w);
    __scratch.walker = w; __scratch.walkerMin = Infinity;
})()`);
const ticks = Math.round(secs * 20 / dk), sampleEvery = Math.max(1, Math.round(every * 20 / dk));
inst.eval(`__scratch.prev = null; __scratch.sample = () => {
    const g = __scratch.group, [gx, gy] = __scratch.goal, n = g.length, prev = __scratch.prev || new Float64Array(n * 2);
    const ds = new Float64Array(n); let inn = 0, outt = 0, mov = 0, idle = 0, sum = 0, speed = 0;
    const cur = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) { const u = g[i]; if (u.dead) { ds[i] = NaN; continue; }
        const x = u.x, y = u.y, d = Math.hypot(x - gx, y - gy); ds[i] = d; sum += d; cur[2 * i] = x; cur[2 * i + 1] = y;
        if (__scratch.prev) { const pd = Math.hypot(prev[2 * i] - gx, prev[2 * i + 1] - gy), step = Math.hypot(x - prev[2 * i], y - prev[2 * i + 1]);
            speed += step; if (step > 0.5) mov++; if (d - pd > 0.5) outt++; else if (d - pd < -0.5) inn++; }
        if (u.commandState === CMD_IDLE) idle++; }
    __scratch.prev = cur;
    const sorted = Array.from(ds).filter(v => v === v).sort((a, b) => a - b), q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] / TILE;
    const r = { mean: sum / n / TILE, p10: q(.1), p50: q(.5), p90: q(.9), max: q(1), inPct: 100 * inn / n, outPct: 100 * outt / n, movPct: 100 * mov / n, idlePct: 100 * idle / n, pxPerUnit: speed / n };
    if (__scratch.leaver) { const l = __scratch.leaver, d = Math.hypot(l.x - gx, l.y - gy) / TILE; __scratch.leaverMax = Math.max(__scratch.leaverMax, d); r.leaver = d; r.leaverType = l.unitType + ":" + _occ.radius[l._si]; r.leaverOn = l._us.mvOn[l._si]; r.leaverCmd = l.commandState; r.leaverCm = l._us.cmMode[l._si]; r.leaverRt = l._us.rtEnd[l._si]; r.nb = units.filter(u => !u.dead && Math.abs(u.x - l.x) < 26 && Math.abs(u.y - l.y) < 26 && u !== l).map(u => [Math.round((u.x - l.x)*10)/10, Math.round((u.y - l.y)*10)/10, u._us.mvOn[u._si], u._us.cmMode[u._si], u._us.rtEnd[u._si], u.owner, _occ.active[u._si], _occ.radius[u._si]]); r.dbg = _traffic ? [_traffic.config[14], _traffic.config[15], _traffic.config[31]] : null; r.lv = [l._us.vx[l._si], l._us.vy[l._si], l._us.mvCVx[l._si], l._us.mvCVy[l._si], l._us.mvSteady ? l._us.mvSteady[l._si] : null, l._us.mvNavLD[l._si], l._us.mvFlags[l._si], l.x, l.y]; }
    if (__scratch.walker) { const w = __scratch.walker, d = Math.hypot(w.x - gx, w.y - gy) / TILE; __scratch.walkerMin = Math.min(__scratch.walkerMin, d); r.walker = d; r.walkerCmd = w.commandState; }
    return r;
}; __scratch.sample(); 0`);
const rows = [], tickMs = [];
let walkerSent = false, __leaverSent = false;
for (let t = 1; t <= ticks; t++) {
    const sec = t * dk / 20;
    if (repeat && t > 1 && (t % Math.round(repeat * 20 / dk)) === 0) inst.eval('__scratch.order()');
    if (walker && !walkerSent && sec >= secs / 2) { walkerSent = true; inst.eval(`processAction(sanitizeAction({ action: 'move', unitIds: [__scratch.walker.id], targetX: __scratch.goal[0], targetY: __scratch.goal[1] }), 0)`); }
    if (leaver && !__leaverSent && sec >= secs / 2) { __leaverSent = true; inst.eval(`(() => { const [gx, gy] = __scratch.goal, b = __scratch.blocks[0]; let best = null, bd = 1e9; for (const u of __scratch.group) if (!u.dead) { const d = Math.hypot(u.x - gx, u.y - gy); if (d < bd) { bd = d; best = u; } }
        __scratch.leaver = best; __scratch.leaverMax = 0; if (_traffic) { _traffic.config[15] = best.id; _traffic.config[14] = 0; _traffic.config[31] = 0; } processAction(sanitizeAction({ action: 'move', unitIds: [best.id], targetX: (b.x0 - 6) * TILE + 16, targetY: gy }), 0); })()`); }
    const a = performance.now(); inst.eval('gameTick();currentTick++'); tickMs.push(performance.now() - a);
    if (t % sampleEvery === 0) {
        const r = inst.eval('__scratch.sample()');
        const row = { sec: Math.round(sec * 100) / 100, ms: Math.round(tickMs.slice(-sampleEvery).reduce((x, y) => x + y, 0) / sampleEvery), ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 100) / 100 : v])) };
        rows.push(row); console.log(JSON.stringify(row));
    }
}
// Pulse measure: sign changes of (in - out) once the bulk has arrived, and
// the mean out-share over the last half (a settled crowd: ~0).
const late = rows.slice(Math.floor(rows.length / 2));
let flips = 0; for (let i = 1; i < late.length; i++) if (Math.sign(late[i].inPct - late[i].outPct) * Math.sign(late[i - 1].inPct - late[i - 1].outPct) < 0 && Math.abs(late[i].inPct - late[i].outPct) > 2) flips++;
const meanOf = (a, k) => a.reduce((s, r) => s + r[k], 0) / Math.max(1, a.length);
const sortedMs = tickMs.slice().sort((a, b) => a - b);
const summary = { units: count, group: groupN, dk, secs, lateOutPct: meanOf(late, 'outPct'), lateInPct: meanOf(late, 'inPct'), lateMovPct: meanOf(late, 'movPct'), lateMeanR: meanOf(late, 'mean'), lateIdlePct: meanOf(late, 'idlePct'), flips,
    walkerMin: walker ? inst.eval('__scratch.walkerMin') : undefined, leaverMax: leaver ? inst.eval('__scratch.leaverMax') : undefined, msMean: tickMs.reduce((a, b) => a + b, 0) / tickMs.length, msP50: sortedMs[sortedMs.length >> 1], msP90: sortedMs[Math.floor(sortedMs.length * .9)], errors: inst.errors.length };
console.log('SUMMARY ' + JSON.stringify(summary));
if (process.env.SWAPDIAG) console.log('SWAPDIAG ' + inst.eval(`JSON.stringify((() => { const l = __scratch.leaver, O = _occ, A = _occupancyAddresses(), out = []; const sl = l._si;
  const sp = (s, x, y, r) => _simWasmX.occ_spawn(...A, O.w, O.h, O.stride, O.cell, O.planes, s, x, y, r, O.layer[s], 0);
  for (const u of units) { if (u.dead || u === l || Math.hypot(u.x - l.x, u.y - l.y) > 30) continue; const b = u._si;
    const lx = O.x[sl], ly = O.y[sl], bx = O.x[b], by = O.y[b], lr = O.radius[sl], br = O.radius[b];
    _simWasmX.occ_release(...A, O.w, O.h, O.stride, O.cell, O.planes, sl); _simWasmX.occ_release(...A, O.w, O.h, O.stride, O.cell, O.planes, b);
    const ok1 = sp(sl, bx, by, lr), ok2 = sp(b, lx, ly, br);
    if (ok1) _simWasmX.occ_release(...A, O.w, O.h, O.stride, O.cell, O.planes, sl); if (ok2) _simWasmX.occ_release(...A, O.w, O.h, O.stride, O.cell, O.planes, b);
    sp(sl, lx, ly, lr); sp(b, bx, by, br);
    out.push([(bx - lx) / 8, (by - ly) / 8, lr, br, ok1, ok2, l.x - lx / 8, u.x - bx / 8]); }
  return { pos: [O.x[sl] / 8, O.y[sl] / 8], out, audit: occupancyAudit() }; })())`));
if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ args: process.argv.slice(2), sel, summary, rows }, null, 1)); }
process.exit(0);
