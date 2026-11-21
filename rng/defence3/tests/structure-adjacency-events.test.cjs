// Structures' groups after each kind of change, on the adjacency lane, equal
// a full recompute (tests/adjacency-reference.js): construction finished, a
// structure destroyed, a stack order, an area filled (its multiplier) and
// emptied again, an area upgrade, cloud portals built and destroyed (both
// ends' groups). A change not seeding every group it alters leaves that
// group's sizes and levels stale until some later change near it.
//   node tests/structure-adjacency-events.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '200', 'cfg-map-type': 'arena' } });
const inst = world.spawn('adjevents', { simWorker: false });
inst.eval('startSoloGame();');
// (The reference's cloud partner, as the flood kernel takes it (k.rs
// k_adj_flood): the first other operational portal of the same pair and owner
// with energy, in tile order.)
const REF = require('node:fs').readFileSync(require('node:path').join(__dirname, 'adjacency-reference.js'), 'utf8') + `
function getPairedCloudTower(cloud, owner) {
    const pair = BASE_CARD_TYPES[cloud.type] && BASE_CARD_TYPES[cloud.type].pairId;
    let best = null;
    for (const t of towers) {
        if (!t || t === cloud || t.owner !== owner || !_isOperationalAdjacencyEntity(t) || !(t.baseStats && t.baseStats.isCloud) || !(t.energy > 0)) continue;
        if (BASE_CARD_TYPES[t.type].pairId !== pair) continue;
        if (!best || t.gy * GRID_W + t.gx < best.gy * GRID_W + best.gx) best = t;
    }
    return best;
}`;
const r = JSON.parse(inst.eval(REF + `;JSON.stringify((() => {
    const P = localPlayerId;
    const used = new Set();
    const free = (gx, gy) => { const c = grid[gy] && grid[gy][gx]; return !!c && cellType[(c) - 1] === TYPE_FLOOR && !cellItemGet(c) && !getTileEntityRef(gx, gy) && !getGoldMineAt(gx, gy) && !used.has(gy * GRID_W + gx); };
    const idle = () => { for (let t = 0; t < 400; t++) { gameTick(); if (!_adjacencyNeedsRecalc && !_adjL.posted) { for (let k = 0; k < 2 * ADJACENCY_BATCH_TICKS; k++) gameTick(); return; } } };
    const finish = (e) => { structProgressOps(e, 0, 0); _waiBuilt(e.gy * GRID_W + e.gx, 0, 0); if (_wai.adjDue) { _wai.adjDue = false; recalculateAdjacency(); } };
    const ent = (gx, gy) => getTileEntityRef(gx, gy) || cellItemGet(grid[gy][gx]);
    const build = (gx, gy, key, stacks = 1) => {
        used.add(gy * GRID_W + gx);
        if (!placeBuilding(gx, gy, key, P, { ignorePlacementRules: true, silent: true, stacks })) throw new Error('place ' + key + ' ' + gx + ',' + gy);
        const e = ent(gx, gy); finish(e); return e;
    };
    const all = [];
    const tiles = new Set();
    const state = () => { for (const e of all) if (e && Number.isFinite(e.gx)) tiles.add(e.gy * GRID_W + e.gx); return [...tiles].sort((x, y) => x - y).map(t => ent(t % GRID_W, Math.floor(t / GRID_W))).filter(e => e && !e.underConstruction && e.type !== 'area_upgrader')
        .map(e => e.type + '@' + e.gx + ',' + e.gy + ' ' + [e.effectiveGroupSize, e.effectiveAreaMult, e.effectiveLevel, e.effectiveStacks, e.potentialEffectiveLevel].join(',')); };
    const steps = [];
    const check = (name) => {
        idle();
        const lane = state();
        _adjacencyLastRecalcTick = -1; _adjacencyDirtyAll = true; _adjacencyNeedsRecalc = true; _adjacencyPassiveRefreshMode = false;
        _refAdjRecalc();
        const ref = state();
        const diffs = [];
        for (let i = 0; i < lane.length; i++) if (lane[i] !== ref[i]) diffs.push('lane ' + lane[i] + ' / ref ' + ref[i].split(' ')[1]);
        steps.push({ name, n: lane.length, diffs: diffs.slice(0, 4), nd: diffs.length });
        idle();
    };
    // An area of free floor (4..12 cells), away from the base.
    let area = null;
    for (let a = 0; a < areas.length && !area; a++) {
        const cells = _getCanonicalAreaCellsById(a, getAreaById(a));
        if (cells.length < 4 || cells.length > 12) continue;
        if (cells.every(cp => free(cp % GRID_W, Math.floor(cp / GRID_W)) && Math.floor(cp / GRID_W) > 60)) area = { id: a, cells };
    }
    if (!area) return { error: 'no area' };
    const cxy = cp => [cp % GRID_W, Math.floor(cp / GRID_W)];
    // 1. The area but one cell built, one at a time.
    for (const cp of area.cells.slice(0, -1)) all.push(build(...cxy(cp), 'house'));
    check('area but one built');
    // 2. Its last cell: the area uniform, its multiplier.
    all.push(build(...cxy(area.cells[area.cells.length - 1]), 'house'));
    check('area filled');
    const filledMult = all[0].effectiveAreaMult;
    // 3. An area upgrade.
    placeBuilding(...cxy(area.cells[0]), 'area_upgrader', P, { silent: true });
    check('area upgraded');
    const upMult = all[0].effectiveAreaMult;
    // 4. One of its houses destroyed (the one farthest from the first).
    const far = all[all.length - 1];
    tiles.add(far.gy * GRID_W + far.gx);
    destroyBuilding(far);
    check('area cell destroyed');
    // 5. A stack order.
    placeBuilding(all[0].gx, all[0].gy, 'house', P, { ignorePlacementRules: true, silent: true, stacks: 64 });
    check('stack order');
    // 6. Two groups joined by a cloud pair: a row of houses with a portal at
    // its end, far apart.
    const row = (y0) => {
        for (let gy = y0; gy < GRID_H - 4; gy++) for (let gx = 4; gx < GRID_W - 8; gx++) {
            let ok = true;
            for (let d = 0; d < 4 && ok; d++) ok = free(gx + d, gy) && free(gx + d, gy + 1) && free(gx + d, gy - 1);
            if (ok) return [gx, gy];
        }
        return null;
    };
    const A = row(20); if (!A) return { error: 'no row A' };
    const hA = [build(A[0], A[1], 'barrack_norm'), build(A[0] + 1, A[1], 'barrack_norm'), build(A[0] + 2, A[1], 'barrack_norm')];
    all.push(...hA);
    const B = row(A[1] + 30); if (!B) return { error: 'no row B' };
    const hB = [build(B[0], B[1], 'barrack_norm'), build(B[0] + 1, B[1], 'barrack_norm')];
    all.push(...hB);
    check('two rows');
    let cA = build(A[0] + 3, A[1], 'cloud_0a');
    all.push(cA);
    check('portal A');
    const cB = build(B[0] + 2, B[1], 'cloud_0b'); all.push(cB);
    check('portal B: joined');
    const joined = [hA[0].effectiveGroupSize, hB[0].effectiveGroupSize];
    tiles.add(cB.gy * GRID_W + cB.gx);
    destroyBuilding(cB);
    check('portal B destroyed');
    const apart = [hA[0].effectiveGroupSize, hB[0].effectiveGroupSize];
    all.push(build(B[0] + 2, B[1], 'cloud_0b'));
    check('portal B rebuilt');
    tiles.add(hA[1].gy * GRID_W + hA[1].gx);
    destroyBuilding(hA[1]);
    check('row A cut');
    return { area: area.cells.length, filledMult, upMult, joined, apart, steps };
})())`));
for (const s of r.steps || []) console.log((s.nd ? 'FAIL ' : 'ok   ') + s.name + ' (' + s.n + ')' + (s.nd ? ': ' + s.nd + ' differ; ' + s.diffs.join(' | ') : ''));
console.log(JSON.stringify({ ...r, steps: undefined }));
assert.ok(!r.error, r.error);
assert.ok(r.filledMult > 1, 'a filled area multiplies');
assert.ok(r.upMult > r.filledMult, 'an upgraded area multiplies more');
assert.deepEqual(r.joined, [5, 5], 'the portals join both rows');
assert.deepEqual(r.apart, [3, 2], 'apart again without portal B');
for (const s of r.steps) assert.equal(s.nd, 0, s.name + ': lane equals the full recompute');
console.log('PASS: structure groups current after every kind of change');
process.exit(0);
