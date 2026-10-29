'use strict';
// (The reference is a unit's _scoutTarget, which holds any object: a worker's
// target is its tile in its columns, read back from the world: gone, null.)
// A structure no longer in its list but still referenced (a builder walking to
// a site that was removed) is sent as a pooled object. Decoded, each such
// structure must keep its own fields: without its own table row they all read
// one shared stray slot (the last one this peer decoded), and a restored
// peer's builder walked to another peer's site (multiplayer-snapshot round 3).
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const w = new H.World({ controls: H.SMALL_MATCH_CONTROLS }), i = w.spawn('pooled-structure', { simWorker: false });
const out = JSON.parse(i.eval(`(() => {
    startSoloGame();
    const a = new Unit('builder_unit', 0, 5 * TILE, 5 * TILE), b = new Unit('builder_unit', 0, 6 * TILE, 6 * TILE);
    for (const u of [a, b]) { units.push(u); unitSlotMapPushed(u); }
    // Two sites that are in no list (removed), at different tiles.
    const s1 = new Barrack(11, 12, 'norm', 0), s2 = new Barrack(13, 20, 'fast', 0);
    s1.underConstruction = true; s2.underConstruction = false;
    a._scoutTarget = s1; b._scoutTarget = s2;
    const ids = [a.id, b.id];
    const view = w => w && { gx: w.gx, gy: w.gy, uc: w.underConstruction, type: w.unitType, row: w._sr !== undefined };
    const before = [view(s1), view(s2)];
    const text = JSON.stringify(snapEncodeState());
    // Decoded twice: the second decode must not see the first's structures.
    snapDecodeState(JSON.parse(text));
    snapDecodeState(JSON.parse(text));
    const after = ids.map(id => view(units.find(u => u.id === id)._scoutTarget));
    return JSON.stringify({ before, after });
})()`));
assert.deepEqual(out.before.map(v => [v.gx, v.gy, v.uc]), [[11, 12, true], [13, 20, false]]);
assert.deepEqual(out.after, out.before, JSON.stringify(out));
assert.deepEqual(i.errors, []);
console.log('PASS: removed structures referenced by units keep their own fields through a restore');
