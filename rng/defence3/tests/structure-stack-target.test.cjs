// Structures' build orders and their group levels (things_utils.js
// placeBuilding, the adjacency lane):
//  - a build order on a structure standing there sets its stacks up to the
//    selected level's (2^(level - 1)), never down, not that many more;
//  - a structure finishing construction joins its group at the next batch
//    (its group's sizes and effective levels counted again), not only at some
//    later change elsewhere;
//  - a stack order shows its potential level at the next batch;
//  - a label never names a researched maximum below the structure's level
//    (a starting structure above the cap: L6->L8, not L6->L1->L8).
//   node tests/structure-stack-target.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '200', 'cfg-map-type': 'arena' } });
const inst = world.spawn('stacktarget', { simWorker: false });
inst.eval('startSoloGame();');
const r = JSON.parse(inst.eval(`JSON.stringify((() => {
    const P = localPlayerId;
    const free = (gx, gy) => { const c = grid[gy] && grid[gy][gx]; return c && cellType[(c) - 1] === TYPE_FLOOR && !cellItemGet(c) && !getTileEntityRef(gx, gy) && !getGoldMineAt(gx, gy) && canBuildAt(gx, gy, P); };
    // A free 2x2 block, away from the starting base.
    let ox = -1, oy = -1;
    for (let gy = 1; gy < GRID_H - 2 && ox < 0; gy++) for (let gx = 1; gx < GRID_W - 2; gx++) {
        if (free(gx, gy) && free(gx + 1, gy) && free(gx, gy + 1) && free(gx + 1, gy + 1)) { ox = gx; oy = gy; break; }
    }
    const at = (dx, dy) => cellItemGet(grid[oy + dy][ox + dx]);
    const idle = () => { for (let t = 0; t < 400; t++) { gameTick(); if (!_adjacencyNeedsRecalc && !_adjL.posted) { for (let k = 0; k < 2 * ADJACENCY_BATCH_TICKS; k++) gameTick(); return; } } };
    const place = (dx, dy, count) => processAction({ action: 'place', gx: ox + dx, gy: oy + dy, itemType: 'house', autoUpgradeEnabled: false, buildEnabled: true, count }, P);
    // Builds as the builders finish them (worker.js _waiBuilt kind 0, after
    // the progress kernel's p_complete), one at a time, the lane idle between.
    const finish = (e) => { structProgressOps(e, 0, 0); _waiBuilt(e.gy * GRID_W + e.gx, 0, 0); if (_wai.adjDue) { _wai.adjDue = false; recalculateAdjacency(); } };
    const out = {};
    place(0, 0, 1); place(1, 0, 1); place(0, 1, 1); place(1, 1, 1);
    const hs = [at(0, 0), at(1, 0), at(0, 1), at(1, 1)];
    if (hs.some(e => !e)) return { ox, oy, missing: hs.map(e => !!e) };
    out.newManual = hs.map(e => getThingManualStacks(e));
    idle();
    for (const e of hs) { finish(e); idle(); }
    out.afterBuilt = hs.map(e => [e.effectiveGroupSize, e.effectiveLevel, getLevelLabelText(e)].join(' '));
    // A stack order at level 10 (512 stacks) on the first.
    place(0, 0, 512);
    out.manual10 = getThingManualStacks(hs[0]);
    idle();
    out.pot10 = hs[0].potentialEffectiveLevel; out.label10 = getLevelLabelText(hs[0]);
    // Level 8 there: stays at 512.
    place(0, 0, 128);
    out.manual8 = getThingManualStacks(hs[0]);
    // A new structure ordered at level 5: 16 stacks.
    let nx = -1; for (let gx = ox + 4; gx < GRID_W; gx++) if (free(gx, oy)) { nx = gx; break; }
    processAction({ action: 'place', gx: nx, gy: oy, itemType: 'house', autoUpgradeEnabled: false, buildEnabled: true, count: 16 }, P);
    const n = cellItemGet(grid[oy][nx]);
    out.new5 = [getThingManualStacks(n), n.level, n.underConstruction];
    // The label of a level above the researched maximum.
    out.capLabel = simLabelText((1 << 28) | 6 | (8 << 7) | (8 << 14) | (1 << 21));
    out.capLabel2 = simLabelText((1 << 28) | 1 | (3 << 7) | (3 << 14) | (1 << 21));
    out.rmax = getThingResearchedMaxLevel(hs[0]);
    return out;
})())`));
console.log(JSON.stringify(r));
assert.deepEqual(r.newManual, [1, 1, 1, 1], 'a new structure at level 1: one stack');
for (const s of r.afterBuilt) assert.match(s, /^4 3 /, 'built, each in the group of 4 (effective L3): ' + r.afterBuilt.join(' | '));
assert.equal(r.manual10, 512, 'stacks up to level 10');
assert.ok(r.pot10 >= 10, 'its potential at the next batch: ' + r.pot10 + ' ' + r.label10);
assert.equal(r.manual8, 512, 'a lower level keeps its stacks');
assert.deepEqual(r.new5, [16, 0, true], 'a new structure ordered with its stacks');
assert.equal(r.capLabel, 'L6->L8|BLOCKED');
assert.equal(r.capLabel2, 'L1->L3|BLOCKED');
console.log('PASS: build orders stack up to the selected level; groups and labels current at the next batch');
process.exit(0);
