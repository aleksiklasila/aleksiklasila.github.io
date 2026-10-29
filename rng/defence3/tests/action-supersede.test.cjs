// Unit orders superseded by later ones (main.js order queue stamps,
// _actionRecordArrival, _actionKeepLatest): ten big move orders of every unit
// (ctrl clicks), a stop of a few of them and a rally in between: the
// later orders win (every unit carries the tenth order's target, the stopped
// ones stand), the waiting superseded orders pass by within a tick or two;
// a snapshot taken while they wait, restored on two peers, gives equal state
// hashes every tick and equal exact states.
//   node tests/action-supersede.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '160', 'cfg-map-type': 'arena' } });
const a = world.spawn('supA', { simWorker: false }), b = world.spawn('supB', { simWorker: false });
for (const inst of [a, b]) inst.eval('startSoloGame(); checkWinCondition = function () {};');
const r = JSON.parse(a.eval(`JSON.stringify((() => {
    const ids = [];
    for (let i = 0; i < 4000; i++) { const gx = 20 + (i % 100), gy = 30 + Math.floor(i / 100); if (grid[gy][gx].type === TYPE_WALL) continue; const u = new Unit('norm', 0, gx * TILE + 16, gy * TILE + 16); units.push(u); unitSlotMapPushed(u); ids.push(u.id); }
    for (let t = 0; t < 3; t++) gameTick();
    // (Big enough that the backlog holds most of them: an action of 100 ids costs 2.25.)
    const acts = [];
    for (let k = 0; k < 10; k++) for (let i = 0; i < ids.length; i += 100) acts.push({ action: 'move', unitIds: ids.slice(i, i + 100), targetX: (40 + k * 8) * TILE, targetY: (100 + k) * TILE });
    // (Between the fifth and sixth: the first 10 units stopped; the sixth on moves them again.)
    acts.splice(5 * Math.ceil(ids.length / 100), 0, { action: 'stop', unitIds: ids.slice(0, 10) });
    // (After the tenth: a stop of units 10-19, which must win.)
    acts.push({ action: 'stop', unitIds: ids.slice(10, 20) });
    processActions(acts, 0);
    const waiting = _actionBacklog.length, live = [..._actLive.values()].filter(v => v.live > 0).length;
    __scratch.saved = JSON.stringify(snapEncodeState());
    let ticks = 0, drain = 0;
    while ((_actionBacklog.length || _orderQueue.length) && ticks < 40) { gameTick(); currentTick++; ticks++; if (_orderQueue.length) drain = ticks + 1; }
    for (let t = 0; t < 4; t++) gameTick();
    const tenth = 40 + 9 * 8, last = ids.slice(20).map(id => getUnitById(id)).filter(u => u && !u.dead);
    const onTenth = last.filter(u => u.targetPos && Math.floor(u.targetPos.x / TILE) === tenth).length;
    const stopped = ids.slice(10, 20).map(id => getUnitById(id)).filter(u => u && !u.dead && u.commandState === CMD_IDLE).length;
    const first = ids.slice(0, 10).map(id => getUnitById(id)).filter(u => u && !u.dead && u.targetPos && Math.floor(u.targetPos.x / TILE) === tenth).length;
    return { waiting, live, ticks, drain, units: last.length, onTenth, stopped, first };
})())`));
console.log(JSON.stringify(r));
// (Move orders go to the order queue at once, not the action backlog; the
// queue applies each within ORDER_DRAIN_STEPS.)
assert.ok(r.waiting <= 2, 'move orders did not wait in the action backlog: ' + r.waiting);
assert.ok(r.drain <= a.eval('ORDER_DRAIN_STEPS'), 'the order queue drained by its deadline: ' + r.drain);
assert.ok(r.live <= Math.ceil(4000 / 100) + 2, 'only the latest orders have units left to them: ' + r.live);
assert.ok(r.ticks <= 3, 'the superseded waiting orders passed by within a few ticks: ' + r.ticks);
assert.equal(r.onTenth, r.units, 'every unit carries the tenth order');
assert.equal(r.stopped, 10, 'the last stop won');
assert.equal(r.first, 10, 'units stopped between the orders took the later ones');
// Two peers restored from the snapshot taken while the orders waited.
b.scratch.saved = a.scratch.saved;
a.eval('snapDecodeState(JSON.parse(__scratch.saved))');
b.eval('snapDecodeState(JSON.parse(__scratch.saved))');
const ha = [], hb = [];
for (let t = 0; t < 40; t++) {
    a.eval('gameTick()'); b.eval('gameTick()');
    ha.push(a.eval('computeLockstepStateHashFast(gameTime)')); hb.push(b.eval('computeLockstepStateHashFast(gameTime)'));
}
assert.deepEqual(ha, hb, 'two peers restored with superseded orders waiting stay equal');
assert.equal(a.eval('__exactStateHash()'), b.eval('__exactStateHash()'), 'exact states equal');
const after = JSON.parse(a.eval(`JSON.stringify((() => { const tenth = 40 + 9 * 8; const us = units.filter(u => u.owner === 0 && !u.dead && u.unitType === 'norm'); return { n: us.length, on: us.filter(u => u.targetPos && Math.floor(u.targetPos.x / TILE) === tenth).length, idle: us.filter(u => u.commandState === CMD_IDLE).length }; })())`));
assert.ok(after.on >= after.n - 10, 'restored: the tenth order won there too: ' + JSON.stringify(after));
assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
console.log('PASS: superseded waiting unit orders pass by, later orders win, and the marks travel in snapshots');
process.exit(0);
