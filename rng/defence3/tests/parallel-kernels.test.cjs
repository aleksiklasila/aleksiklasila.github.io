// The parallel simulation kernels (src/sim/sim_parallel.js) compute exactly
// what the serial code computes: every player's visibility grid equals
// computeVisibilityGridForPlayer's, and the gathered separation pushes equal
// the pairwise ones, on real matches (islands, walls, battles, flyers).
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

// Each player's grid by the kernel vs the reference, same sources.
const VIS_CHECK = `(() => {
    const lists = _buildVisibilitySourceLists();
    _visibilitySourceLists = lists;
    let diffs = 0, cells = 0, lit = 0, checked = 0;
    try {
        for (let pid = 0; pid < players.length; pid++) {
            const src = lists.lists[pid] || new Float64Array(0), len = lists.lengths[pid] || 0;
            const ref = createEmptyVisibilityGrid();
            computeVisibilityGridForPlayer(pid, ref, src, len);
            const pool = { grids: [null, null] };
            const rows = _visibilityPoolGrid(pool, 0, 'check' + pid);
            simParallelBind('vis.g.' + pid + '.0', rows._flat);
            _runVisibilityJobs([pid, 0]);
            for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) { cells++; if (ref[y][x] > 0) lit++; if (!Object.is(ref[y][x], rows[y][x])) diffs++; }
            checked++;
        }
    } finally { _visibilitySourceLists = null; }
    return JSON.stringify({ diffs, cells, lit, checked });
})()`;

// The pushes of the last separation pass, recomputed by the pairwise
// algorithm the kernel replaced (each touching pair once, pushing both), from
// the same packed arrays.
const SEP_CHECK = `(() => {
    const S = _sep, nChunks = CHUNKS_W * CHUNKS_H;
    if (!S.start) return JSON.stringify({ units: 0 });
    const n = units.length, px = new Float64Array(n), py = new Float64Array(n), ov = new Float64Array(n), hit = new Float64Array(n);
    const { ord, sx, sy, sr, so, sl, sc, sid, sdx, sdy, start, chunkR, chunkC, sole } = S;
    const pad = Math.max(0, Number(CROSS_TEAM_UNIT_COLLISION_PADDING) || 0), farAny = 2 * Math.max(0.1, _maxUnitCollisionRadius()) + pad, cws = CHUNK_SIZE * TILE;
    const reach = Math.max(1, Math.ceil(farAny / cws));
    const dir = (p, q) => { let mdx = sdx[p], mdy = sdy[p], sign = sid[p] < sid[q] ? -1 : 1; return Math.abs(mdx) >= Math.abs(mdy) ? [0, (mdx >= 0 ? -1 : 1) * sign] : [(mdy >= 0 ? 1 : -1) * sign, 0]; };
    const hitPair = (p, q, dx, dy, d2, minDist) => {
        const a = ord[p], b = ord[q], d = Math.sqrt(d2), overlap = minDist - Math.max(d, 0.001);
        // Shares (sc bit 0: takes part, bit 1: moved): even between movers or
        // units at rest; a mover against one at rest that gives way little.
        const share = (x, y) => ((sc[x] & 2) !== 0) === ((sc[y] & 2) !== 0) ? ((sc[y] & 1) ? UNIT_SEPARATION_SHARE_BOTH : UNIT_SEPARATION_SHARE_ONE)
            : ((sc[x] & 2) ? ((sc[y] & 1) ? UNIT_SEPARATION_SHARE_MOVER : UNIT_SEPARATION_SHARE_ONE) : UNIT_SEPARATION_SHARE_YIELD);
        const fp = overlap * share(p, q) * UNIT_SEPARATION_Q, fq = overlap * share(q, p) * UNIT_SEPARATION_Q;
        if (sc[p] & 1) { const [nx, ny] = d > 0.001 ? [-dx / d, -dy / d] : dir(p, q); px[a] += Math.round(nx * fp); py[a] += Math.round(ny * fp); if (overlap > ov[a]) ov[a] = overlap; hit[a]++; }
        if (sc[q] & 1) { const [nx, ny] = d > 0.001 ? [dx / d, dy / d] : dir(q, p); px[b] += Math.round(nx * fq); py[b] += Math.round(ny * fq); if (overlap > ov[b]) ov[b] = overlap; hit[b]++; }
    };
    const range = (p0, p1, q0, q1, same) => { for (let p = p0; p < p1; p++) for (let q = same ? p + 1 : q0; q < q1; q++) {
        if (!((sc[p] | sc[q]) & 1) || sl[q] !== sl[p]) continue;
        const dx = sx[q] - sx[p], dy = sy[q] - sy[p], d2 = dx * dx + dy * dy, minDist = sr[p] + sr[q] + (so[q] === so[p] ? 0 : pad);
        if (d2 < minDist * minDist) hitPair(p, q, dx, dy, d2, minDist); } };
    // Chunks holding a unit that takes part this tick.
    const part = new Uint8Array(nChunks);
    for (let c = 0; c < nChunks; c++) for (let k = start[c]; k < start[c + 1]; k++) if (sc[k] & 1) { part[c] = 1; break; }
    for (let cy = 0; cy < CHUNKS_H; cy++) for (let cx = 0; cx < CHUNKS_W; cx++) {
        const key = cy * CHUNKS_W + cx, a0 = start[key], a1 = start[key + 1];
        if (a0 === a1) continue;
        if (part[key] && a1 - a0 > 1) range(a0, a1, a0, a1, true);
        for (let oy = 0; oy <= reach; oy++) for (let ox = -reach; ox <= reach; ox++) {
            if (oy === 0 && ox <= 0) continue;
            const gap = Math.sqrt(Math.max(0, Math.abs(ox) - 1) ** 2 + Math.max(0, oy - 1) ** 2) * cws;
            if (gap >= farAny) continue;
            const nx = cx + ox, ny = cy + oy;
            if (nx < 0 || nx >= CHUNKS_W || ny >= CHUNKS_H) continue;
            const key2 = ny * CHUNKS_W + nx, b0 = start[key2], b1 = start[key2 + 1];
            if (b0 === b1 || !(part[key] | part[key2])) continue;
            const near = chunkR[key] + chunkR[key2];
            if (gap >= near + pad) continue;
            if (gap >= near && sole[key] >= 0 && sole[key2] === sole[key]) continue;
            range(a0, a1, b0, b1, false);
        }
    }
    let diffs = 0, touching = 0;
    for (let i = 0; i < n; i++) { if (hit[i]) touching++; if (px[i] !== S.px[i] || py[i] !== S.py[i] || ov[i] !== S.ov[i] || hit[i] !== S.hit[i]) diffs++; }
    return JSON.stringify({ units: n, touching, diffs });
})()`;

(async () => {
    const results = [];
    let sepTouching = 0;
    for (const [mapType, seed] of [['islands', 11], ['crossroads', 12], ['random', 13]]) {
        const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '40', 'cfg-map-type': mapType, 'cfg-max-pop': '5000', 'cfg-full-vis': 'team' };
        const world = new H.World({ controls });
        const inst = world.spawn('solo', { controls });
        const spawnCounts = { 'unit:norm': { 1: 40, 2: 40 }, 'unit:flying': { 1: 10 }, 'unit:scout': { 2: 10 }, 'building:pistol': { 1: 4, 2: 4 }, 'building:house': { 1: 2 } };
        inst.eval(`startingResourcesConfig = ${JSON.stringify({ spawnCounts, researchLevels: {} })}; startSoloGame();`);
        await world.run(1000);
        inst.eval(`(() => { const mine = units.filter(u => !u.dead && !u.workerType); queueAction({ action: 'attackMove', unitIds: mine.filter(u => u.owner === localPlayerId).map(u => u.id), targetX: GRID_W * TILE * .7, targetY: GRID_H * TILE * .5 }); })()`);
        for (let k = 0; k < 6; k++) {
            await world.run(1500);
            const r = JSON.parse(inst.evalSim(VIS_CHECK));
            assert.equal(r.diffs, 0, `${mapType}: visibility kernel differs on ${r.diffs} of ${r.cells} tiles`);
            assert.ok(r.lit > 0 && r.checked > 1);
            results.push(r.lit);
            const sep = JSON.parse(inst.evalSim(SEP_CHECK));
            assert.equal(sep.diffs, 0, `${mapType}: separation kernel differs for ${sep.diffs} of ${sep.units} units`);
            sepTouching = Math.max(sepTouching, sep.touching);
        }
        assert.deepEqual(inst.errors.map(e => String(e.stack || e).slice(0, 300)), [], mapType + ': no errors');
    }
    assert.ok(sepTouching > 10, 'separation checked with units in contact: ' + sepTouching);
    console.log(`PASS: parallel kernels match the serial code (visibility: ${results.length} checks, ${Math.max(...results)} lit tiles at most; separation: up to ${sepTouching} units in contact).`);
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
