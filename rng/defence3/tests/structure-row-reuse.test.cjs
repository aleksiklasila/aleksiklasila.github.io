'use strict';
// Structure table rows come back when a structure leaves the world (its tile
// cleared): placing and destroying many structures in a match no longer grows
// the tables for good. A stale reference to a destroyed structure (a worker's
// target, a selection) still reads its own values, from its record.
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const w = new H.World({ controls: H.SMALL_MATCH_CONTROLS }), i = w.spawn('row-reuse', { simWorker: false });
const out = JSON.parse(i.eval(`(() => {
    startSoloGame();
    const spots = [];
    for (let gy = 2; gy < GRID_H - 2 && spots.length < 60; gy++) for (let gx = 2; gx < GRID_W - 2 && spots.length < 60; gx++)
        if (!getTileEntityRef(gx, gy) && grid[gy][gx].type !== TYPE_WALL) spots.push([gx, gy]);
    const place = () => spots.map(([gx, gy]) => { placeBuilding(gx, gy, 'pistol', 0, { silent: true, ignorePlacementRules: true }); return getTileEntityRef(gx, gy); }).filter(Boolean);
    const first = place(), T = _sTables.get(Tower), n1 = T.n;
    const kept = first[7], view = { gx: kept.gx, gy: kept.gy, type: kept.type, owner: kept.owner, level: kept.level };
    for (const b of first) destroyBuilding(b);
    const after = { gx: kept.gx, gy: kept.gy, type: kept.type, owner: kept.owner, level: kept.level, sr: kept._sr };
    kept.energy = 3;
    const second = place(), n2 = T.n;
    for (const b of second) destroyBuilding(b);
    const third = place(), n3 = T.n;
    return JSON.stringify({ placed: first.length, n1, n2, n3, free: T.free.length, view, after, keptEnergy: kept.energy, liveOk: third.every(b => b._sr >= 0 && b.gx >= 0) });
})()`));
assert.ok(out.placed >= 30, JSON.stringify(out));
assert.equal(out.n2, out.n1, 'rows reused for the second placement: ' + JSON.stringify(out));
assert.equal(out.n3, out.n1, 'rows reused for the third placement: ' + JSON.stringify(out));
assert.deepEqual({ ...out.after, sr: undefined }, { ...out.view, sr: undefined }, 'a destroyed structure reads its own values');
assert.equal(out.after.sr, -1);
assert.equal(out.keptEnergy, 3, 'a destroyed structure takes writes into its record');
assert.ok(out.liveOk);
assert.deepEqual(i.errors, []);
console.log('PASS: structure rows reused after removal (' + out.n1 + ' rows for three rounds of ' + out.placed + '); removed structures keep their values');
