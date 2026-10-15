// A tick's actions within a budget (main.js processActions,
// ACTION_BUDGET_PER_TICK): a burst far over it in one tick leaves actions
// waiting; every one runs within the next ticks, in order (two move orders
// for the same units: the later one wins); a snapshot taken while actions
// wait carries them, and a peer restored from it goes on exactly as the
// original (state hashes equal every tick).
//   node tests/action-budget.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '160', 'cfg-map-type': 'arena' } });
const a = world.spawn('budgetA', { simWorker: false }), b = world.spawn('budgetB', { simWorker: false });
for (const inst of [a, b]) inst.eval('startSoloGame();');
const r = JSON.parse(a.eval(`JSON.stringify((() => {
    const ids = [];
    for (let i = 0; i < 3000; i++) { const gx = 20 + (i % 100), gy = 30 + Math.floor(i / 100); if (grid[gy][gx].type === TYPE_WALL) continue; const u = new Unit('norm', 0, gx * TILE + 16, gy * TILE + 16); units.push(u); unitSlotMapPushed(u); ids.push(u.id); }
    for (let t = 0; t < 3; t++) gameTick();
    // The burst: 300 small actions (stops, holds of a unit each), then two
    // move orders of every unit (the second to another corner), then more.
    const acts = [];
    for (let i = 0; i < 300; i++) acts.push({ action: i & 1 ? 'hold' : 'stop', unitIds: [ids[i]] });
    acts.push({ action: 'move', unitIds: ids, targetX: 30 * TILE, targetY: 120 * TILE });
    acts.push({ action: 'move', unitIds: ids, targetX: 130 * TILE, targetY: 120 * TILE });
    for (let i = 0; i < 100; i++) acts.push({ action: 'stop', unitIds: [ids[300 + i]] });
    processActions(acts, 0);
    const waiting = _actionBacklog.length;
    // A snapshot while they wait.
    __scratch.saved = JSON.stringify(snapEncodeState());
    let ticks = 0;
    while (_actionBacklog.length && ticks < 20) { gameTick(); ticks++; }
    // (The orders' slices applied: ORDER_UNITS_PER_TICK_ALL a tick.)
    for (let t = 0; t < 4; t++) gameTick();
    const last = ids.slice(400).map(id => getUnitById(id)).filter(u => u && !u.dead);
    const west = last.filter(u => u.targetPos && u.targetPos.x < 80 * TILE).length, east = last.filter(u => u.targetPos && u.targetPos.x > 80 * TILE).length;
    return { waiting, ticks, units: last.length, east, west };
})())`));
console.log(JSON.stringify(r));
assert.ok(r.waiting > 0, 'some actions waited');
assert.ok(r.ticks > 0 && r.ticks < 20, 'the backlog ran out within a few ticks');
assert.equal(r.west, 0, 'no unit kept the earlier move order');
assert.ok(r.east > r.units * 0.95, 'the later move order won: ' + r.east + ' of ' + r.units + ' units');
// A peer restored from the snapshot taken with actions waiting: the same
// ticks, the same states.
b.scratch.saved = a.scratch.saved;
a.eval('snapDecodeState(JSON.parse(__scratch.saved))');
b.eval('snapDecodeState(JSON.parse(__scratch.saved))');
const ha = [], hb = [];
for (let t = 0; t < 60; t++) {
    a.eval('gameTick()'); b.eval('gameTick()');
    ha.push(a.eval('computeLockstepStateHashFast(gameTime)')); hb.push(b.eval('computeLockstepStateHashFast(gameTime)'));
}
assert.equal(a.eval('_actionBacklog.length'), 0, 'restored: the waiting actions ran');
assert.deepEqual(ha, hb, 'two peers restored from a snapshot with waiting actions stay equal');
const exact = [a, b].map(p => p.eval('__exactStateHash()'));
assert.equal(exact[0], exact[1], 'exact states equal');
console.log('PASS: actions over a tick\'s budget wait in order, run within ' + r.ticks + ' ticks, and travel in snapshots');
process.exit(0);
