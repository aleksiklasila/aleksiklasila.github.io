'use strict';
// Buildings' sight in the visibility cover comes from the structure table
// (vis.rs k_vis_seed_structs, with the units' cover run): a built tower alone
// lights its tile's area for its owner within two cover periods
// (VIS_COVER_UNITS_TICKS each), not the other player's; under construction
// it does not; destroyed, its sight goes within two periods.
//   node tests/visibility-buildings.test.cjs
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '80', 'cfg-map-type': 'arena' } });
const i = world.spawn('visbuild', { simWorker: false });
const r = JSON.parse(i.eval(`JSON.stringify((() => {
    startSoloGame();
    // No units: only the tower can light anything.
    for (const u of units.slice()) { u.energy = 0; }
    for (let k = 0; k < 4; k++) gameTick();
    const run = n => { for (let k = 0; k < n; k++) gameTick(); };
    let gx = -1, gy = -1;
    for (let y = 30; y < 50 && gx < 0; y++) for (let x = 30; x < 50; x++) { const c = grid[y][x]; if (c.type === TYPE_FLOOR && !c.item && !getTileEntityRef(x, y)) { gx = x; gy = y; break; } }
    const before = [_visCoverTileVisible(0, gx, gy), _visCoverTileVisible(1, gx, gy)];
    placeBuilding(gx, gy, 'pistol', 0, { ignorePlacementRules: true, silent: true });
    const t = getTileEntityRef(gx, gy);
    run(3 * VIS_COVER_UNITS_TICKS);
    const building = [_visCoverTileVisible(0, gx, gy), _visCoverTileVisible(1, gx, gy)];
    t.underConstruction = false; if (typeof structureWallSync === 'function') structureWallSync(t);
    run(3 * VIS_COVER_UNITS_TICKS);
    const built = [_visCoverTileVisible(0, gx, gy), _visCoverTileVisible(1, gx, gy)];
    destroyBuilding(t);
    run(3 * VIS_COVER_UNITS_TICKS);
    const gone = [_visCoverTileVisible(0, gx, gy), _visCoverTileVisible(1, gx, gy)];
    return { gx, gy, units: units.filter(u => !u.dead).length, before, building, built, gone };
})())`));
console.log(JSON.stringify(r));
assert.ok(r.gx >= 0, 'a free tile');
assert.deepEqual(r.before, [false, false], 'nothing lit without sources');
assert.deepEqual(r.building, [false, false], 'under construction: no sight');
assert.deepEqual(r.built, [true, false], 'built: its owner sees its area, the other player not');
assert.deepEqual(r.gone, [false, false], 'destroyed: its sight goes');
console.log('PASS: buildings light their area for their owner from the structure table, not while under construction, not once destroyed');
process.exit(0);
