// The heavy periodic tier steps each run on a base tick of their own
// (data_static.js "The tier steps' ticks"): the visibility coverage's commit
// and post, the worker search's post and commit, the adjacency batch. Two of
// them on one tick made the 250k chaos scene's slow ticks (2026-11-06:
// 48 of 120 ticks carried two or more). Counted from the calls themselves
// over a solo match's ticks at one base tick a step.
//   node tests/tier-phase-schedule.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '200', 'cfg-map-type': 'arena' } });
const inst = world.spawn('tierphase', { simWorker: false });
inst.eval('startSoloGame();');
const r = JSON.parse(inst.eval(`JSON.stringify((() => {
    // (The first tick builds the coverage whole: _visCoverUnitsNow, not a tier step.)
    for (let t = 0; t < 4; t++) gameTick();
    const seen = { vis: [], wsPost: [], wsCommit: [], adjCommit: [], adjPost: [] };
    // (Wrapped by name: the game's functions are not properties of the global here.)
    const wrap = (k, f) => function (...a) { seen[k].push(gameTime); return f.apply(this, a); };
    _visCoverUnitsPost = wrap('vis', _visCoverUnitsPost);
    _wsPost = wrap('wsPost', _wsPost);
    _wsCommit = wrap('wsCommit', _wsCommit);
    _adjacencyLaneCommit = wrap('adjCommit', _adjacencyLaneCommit);
    _adjacencyLanePost = wrap('adjPost', _adjacencyLanePost);
    for (let t = 0; t < 48; t++) gameTick();
    return { seen, dk: simDk, wsAvail: _wsAvailable() };
})())`));
console.log(JSON.stringify(r));
assert.equal(r.dk, 1, 'one base tick a step');
const byTick = new Map();
for (const [k, ticks] of Object.entries(r.seen)) {
    // (wsPost / wsCommit only with the search tier's kernels.)
    if (k.startsWith('ws') && !r.wsAvail) continue;
    assert.ok(ticks.length >= 5, k + ' ran: ' + ticks.length);
    for (const t of ticks) { if (!byTick.has(t)) byTick.set(t, []); byTick.get(t).push(k); }
}
const shared = [...byTick].filter(([, ks]) => new Set(ks).size > 1);
assert.deepEqual(shared, [], 'tier steps sharing a tick: ' + JSON.stringify(shared));
console.log('tier-phase-schedule ok');
