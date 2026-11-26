// Mines in the kernel (tfx.rs k_mine_events, unit.js _unitMineEvents): the floor event of a unit of player 0 on a built
// mine of player 1 sets it off: the mine is gone from its tile; player 0's units within its blast radius (where they
// stood at the tick's start) lose the blast damage (one weaker than it falls), one outside and player 1's own keep their
// energy; player 0's shrine count takes what they lost; the hits are looks for the page (kind 1); the unit's floor
// tile is noted. A unit on a mine under construction sets off nothing. (Units made on the mines' tiles: navigation routes
// units around active mines, crowds push them on.)
//   node tests/mine-kernel.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '80', 'cfg-map-type': 'arena' } });
const inst = world.spawn('minek', { simWorker: false });
inst.eval('startSoloGame();');
inst.eval('SPATIAL_PARALLEL_MIN_UNITS = 0; SEPARATION_SLOT_MIN_UNITS = 0;');
const r = JSON.parse(inst.eval(`JSON.stringify((() => {
    for (const u of units) u.dead = true;
    gameTick();
    let found = null;
    for (let gy = 8; gy < GRID_H - 12 && !found; gy++) for (let gx = 8; gx < GRID_W - 24 && !found; gx++) {
        let ok = true;
        for (let y = gy - 5; y < gy + 6 && ok; y++) for (let x = gx; x < gx + 18 && ok; x++)
            if (cellType[(grid[y][x]) - 1] === TYPE_WALL || cellItemGet(grid[y][x]) || getTileEntityRef(x, y)) ok = false;
        if (ok && [...towers, ...barracks, ...collectorSpawners].some(b => Math.abs(b.gx - (gx + 9)) < 26 && Math.abs(b.gy - gy) < 20)) ok = false;
        if (ok) found = { gx, gy };
    }
    if (!found) return { err: 'no clear area' };
    const place = (gx, gy, built) => {
        if (!placeBuilding(gx, gy, 'mine', 1, { ignorePlacementRules: true, silent: true, autoUpgradeEnabled: false, buildEnabled: true })) return null;
        const it = cellItemGet(grid[gy][gx]);
        if (built) { it.underConstruction = false; it.energy = it.maxEnergy; it.level = 1; markConstructionComplete(it); }
        return it;
    };
    // (A wider blast than the stats' (half an area): the mine's tables made again from it, simTrapResearchDone.)
    { const f = getBuildingStatForOwner; getBuildingStatForOwner = function (o, key, lv, stat) { return key === 'mine' && stat === 'blastRadius' ? 0.5 : f.apply(this, arguments); }; }
    simTrapResearchDone(-1);
    const mx = found.gx + 8, my = found.gy, cx = mx * TILE + 16, cy = my * TILE + 16, br = 0.5 * AREA_UNIT_TILE_EQUIVALENT * TILE;
    const mine = place(mx, my, true), site = place(mx + 3, my + 4, false);
    if (!mine || !site) return { err: 'no mine' };
    const mk = (owner, x, y) => { const u = new Unit('norm', owner, x, y); units.push(u); updateUnitSpatial(u); return u; };
    const trig = mk(0, cx, cy), near = mk(0, cx - br * 0.5, cy - br * 0.3), weak = mk(0, cx - br * 0.3, cy + br * 0.5);
    const own1 = mk(1, cx + br * 0.7, cy + br * 0.2), far = mk(0, cx - br - 2 * TILE, cy), trig2 = mk(0, (mx + 3) * TILE + 16, (my + 4) * TILE + 16);
    const lvl = getThingEffectiveLevel(mine, stackCountToLevel(mine.stacks || 1));
    const bd = getBuildingStatForOwner(1, 'mine', lvl, 'blastDamage');
    // (Their energies as made, the weak one below the blast; then a tick: the unit made on the mine's tile looks at its
    // floor, the movement kernel's floor event, and the mine goes off.)
    weak.energy = Math.min(weak.energy, bd * 0.5);
    near.energy = bd * 2; trig.energy = bd * 2;
    const e0 = { trig: trig.energy, near: near.energy, weak: weak.energy, own1: own1.energy, far: far.energy };
    const shr0 = Number(_shrinePendingFixed[0]) || 0;
    let looks = 0;
    { const f = simHitLooksReplay; simHitLooksReplay = function (buf, unit) { if (buf) { const n = new Int32Array(buf, 0, 1)[0], B = new Uint8Array(buf, 4 + 28 * n, n); for (let i = 0; i < n; i++) if (B[i] === 1) looks++; } return f.apply(this, arguments); }; }
    let ev = 0;
    { const g = _unitMineEvents; _unitMineEvents = function (E, j) { const r = g.apply(this, arguments); ev += _mineCnt ? _mineCnt[0] : 0; return r; }; }
    gameTick();
    const at = u => ({ e: u.energy, dead: !!u.dead });
    const has = (gx, gy) => !!(cellItemGet(grid[gy][gx]) && cellItemGet(grid[gy][gx]).type === 'mine');
    return { bd, e0, trig: at(trig), near: at(near), weak: at(weak), own1: at(own1), far: at(far), mineLeft: has(mx, my), siteLeft: has(mx + 3, my + 4),
        mines: ev, floorTile: [trig._floorTile, my * GRID_W + mx], shr: _mineShr ? _mineShr[0] : 0, looks };
})())`));
assert.ok(!r.err, r.err);
console.log(JSON.stringify(r));
assert.equal(r.mineLeft, false, 'the mine went off and left its tile');
assert.equal(r.siteLeft, true, 'a mine under construction stays');
assert.equal(r.mines, 1, 'one mine went off, in the kernel');
assert.equal(r.floorTile[0], r.floorTile[1], "the unit's floor tile noted");
for (const k of ['trig', 'near']) assert.ok(Math.abs((r.e0[k] - r[k].e) - r.bd) < 1e-3 || (r[k].dead && r[k].e <= 0), k + ' within the blast lost its damage: ' + JSON.stringify(r[k]));
assert.ok(r.weak.dead, 'a weaker unit within the blast fell');
assert.equal(r.own1.e, r.e0.own1, "the mine owner's own unit kept its energy");
assert.equal(r.far.e, r.e0.far, 'a unit outside the blast kept its energy');
assert.ok(r.shr > 0, "player 0's shrine count took the blast's damage");
assert.ok(r.looks >= 3, 'the hits are looks for the page: ' + r.looks);
console.log('PASS: mines go off in the kernel (blast by owner and radius, the fallen, the shrine share, the looks)');
