// Units created since the last stats pass (things_utils.js
// _newUnitsForStats): more than the list's cap (65536) made at once are
// not lost. Their first tick clears every one's _needsStatsInit (a lost
// unit kept it forever and took the slow effective-stats path every turn:
// ~5 ms a tick in a match started with 180k units; and a peer restored from
// a snapshot, its list made from the flags, cleared what the others kept).
// Two peers making the same units stay equal tick by tick, and so does a
// third restored from a snapshot taken right after they were made (the
// sender flushing its caches as it does when it sends one).
//   node tests/new-units-stats-overflow.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '300', 'cfg-map-type': 'arena', 'cfg-max-pop': '200000' } });
const peers = [world.spawn('ovA', { simWorker: false }), world.spawn('ovB', { simWorker: false }), world.spawn('ovC', { simWorker: false })];
// (As a barrack's spawn: level scaling, full energy, the population.)
const make = save => `JSON.stringify((() => {
    gameTick();
    let n = 0;
    for (let i = 0; n < 70000 && i < 200000; i++) {
        const gx = 10 + (i % 280), gy = 10 + Math.floor(i / 280) % 280, owner = i & 1;
        if (grid[gy][gx].type === TYPE_WALL) continue;
        const u = new Unit(owner ? 'fast' : 'norm', owner, gx * TILE + 8 + (i % 3) * 6, gy * TILE + 8 + (i % 5) * 4);
        configureWorkerUnitFromType(u); applyUnitLevelScaling(u, 1); u.energy = u.maxEnergy;
        units.push(u); unitSlotMapPushed(u); players[owner].popCount++; n++;
    }
    const lost = _newUnitsForStatsLost;
    ${save ? '__scratch.saved = JSON.stringify(snapEncodeState()); snapFlushHistoryCaches();' : ''}
    return { n, flagged: units.filter(u => u._needsStatsInit).length, lost };
})())`;
const made = peers.slice(0, 2).map((p, k) => { p.eval('startSoloGame();'); return JSON.parse(p.eval(make(k === 0))); });
console.log(JSON.stringify(made));
assert.ok(made[0].n >= 70000, 'units made: ' + made[0].n);
assert.ok(made[0].lost, 'the list went over its cap');
// The third: restored from A's snapshot. (B made them without a snapshot
// sent: it flushes as A did, as every peer does at a resync.)
peers[1].eval('snapFlushHistoryCaches()');
peers[2].eval('startSoloGame();');
peers[2].scratch.saved = peers[0].scratch.saved;
peers[2].eval('snapDecodeState(JSON.parse(__scratch.saved))');
const hashes = [[], [], []];
for (let t = 0; t < 8; t++) peers.forEach((p, k) => { p.eval('gameTick()'); hashes[k].push(p.eval('computeLockstepStateHashFast(gameTime)')); });
const left = peers.map(p => Number(p.eval('units.filter(u => !u.dead && u._needsStatsInit).length')));
const exact = peers.map(p => p.eval('__exactStateHash()'));
console.log(JSON.stringify({ left, exact }));
assert.deepEqual(left, [0, 0, 0], 'every new unit had its first stats pass');
assert.deepEqual(hashes[1], hashes[0], 'two peers stay equal');
assert.deepEqual(hashes[2], hashes[0], 'a peer restored right after they were made stays equal');
assert.equal(new Set(exact).size, 1, 'exact states equal');
assert.deepEqual(peers.map(p => p.errors.length), [0, 0, 0]);
console.log('PASS: ' + made[0].n + ' units made at once: none lost from the first stats pass; restored peer equal');
process.exit(0);
