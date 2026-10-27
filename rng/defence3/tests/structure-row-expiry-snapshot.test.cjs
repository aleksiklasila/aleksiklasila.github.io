'use strict';
// A destroyed structure keeps its row (its values) until STRUCT_ROW_KEEP_TICKS
// after its destruction, then reads as destroyed. That moment is state: a
// peer restored from a snapshot must expire the structure (a unit's stale
// target, sent as a pooled object) at the same tick as the peer that
// destroyed it, and one already expired must come back expired.
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const w = new H.World({ controls: H.SMALL_MATCH_CONTROLS }), i = w.spawn('row-expiry-snapshot', { simWorker: false });
const out = JSON.parse(i.eval(`(() => {
    startSoloGame();
    const spots = [];
    for (let gy = 4; gy < GRID_H - 4 && spots.length < 2; gy++) for (let gx = 4; gx < GRID_W - 4 && spots.length < 2; gx++)
        if (!getTileEntityRef(gx, gy) && grid[gy][gx].type !== TYPE_WALL) spots.push([gx, gy]);
    const placed = spots.map(([gx, gy]) => { placeBuilding(gx, gy, 'pistol', 0, { silent: true, ignorePlacementRules: true }); return getTileEntityRef(gx, gy); });
    const a = new Unit('builder_unit', 0, 5 * TILE, 5 * TILE), b = new Unit('builder_unit', 0, 6 * TILE, 6 * TILE);
    for (const u of [a, b]) { units.push(u); unitSlotMapPushed(u); }
    a.workerTarget = placed[0]; b.workerTarget = placed[1];
    const ids = [a.id, b.id];
    // The first destroyed long ago (expired), the second recently (kept).
    destroyBuilding(placed[0]);
    gameTime += STRUCT_ROW_KEEP_TICKS; structRowsExpire();
    destroyBuilding(placed[1]);
    const t1 = gameTime;
    gameTime += 50; structRowsExpire();
    const look = s => s && { at: s._retiredAt, gx: s.gx, energy: s.energy };
    const before = [look(placed[0]), look(placed[1])];
    const text = JSON.stringify(snapEncodeState());
    snapDecodeState(JSON.parse(text));
    const got = ids.map(id => units.find(u => u.id === id).workerTarget);
    const after = got.map(look);
    // Past the second's keep: it expires on the restored peer too.
    gameTime = t1 + STRUCT_ROW_KEEP_TICKS - 1; structRowsExpire();
    const justBefore = look(got[1]);
    gameTime = t1 + STRUCT_ROW_KEEP_TICKS; structRowsExpire();
    const expired = look(got[1]);
    return JSON.stringify({ t1, before, after, justBefore, expired });
})()`));
assert.equal(out.before[0].at, -2, 'the first reads as expired: ' + JSON.stringify(out));
assert.equal(out.before[1].at, out.t1, 'the second is kept, retired at its tick');
assert.ok(out.before[1].gx >= 0 && out.before[1].energy > 0, 'a kept structure reads its own values');
assert.deepEqual(out.after, out.before, 'restored: the same retire state and values');
assert.equal(out.justBefore.at, out.t1, 'kept until its tick');
assert.equal(out.expired.at, -2, 'and expires at the same tick as on the peer that destroyed it');
assert.deepEqual(i.errors, []);
console.log('PASS: destroyed structures keep their expiry tick through a snapshot (retired at ' + out.t1 + ', expired at ' + (out.t1 + 200) + ')');
