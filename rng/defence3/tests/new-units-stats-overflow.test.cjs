// Units made at once (70k here, as a match start makes them): each has its
// stats from creation (a stat row, the stat tables' current version: no
// first-tick refresh pass, nothing for a restore to rebuild), and its
// effective level comes at its turn of the strided share like every unit's.
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
    ${save ? '__scratch.saved = JSON.stringify(snapEncodeState()); snapFlushHistoryCaches();' : ''}
    return { n, all: units.length, current: units.filter(u => u._us.statRow[u._si] >= 0 && u._us.esVer[u._si] === _unitStatsVerOf(u)).length };
})())`;
const made = peers.slice(0, 2).map((p, k) => { p.eval('startSoloGame();'); return JSON.parse(p.eval(make(k === 0))); });
console.log(JSON.stringify(made));
assert.ok(made[0].n >= 70000, 'units made: ' + made[0].n);
assert.equal(made[0].current, made[0].all, 'every new unit has its stat row and current stats');
// The third: restored from A's snapshot. (B made them without a snapshot
// sent: it flushes as A did, as every peer does at a resync.)
peers[1].eval('snapFlushHistoryCaches()');
peers[2].eval('startSoloGame();');
peers[2].scratch.saved = peers[0].scratch.saved;
peers[2].eval('snapDecodeState(JSON.parse(__scratch.saved))');
const hashes = [[], [], []];
for (let t = 0; t < 8; t++) peers.forEach((p, k) => { p.eval('gameTick()'); hashes[k].push(p.eval('computeLockstepStateHashFast(gameTime)')); });
const left = peers.map(p => Number(p.eval('units.filter(u => !u.dead && (u._us.statRow[u._si] < 0 || u._us.esVer[u._si] !== _unitStatsVerOf(u))).length')));
const exact = peers.map(p => p.eval('__exactStateHash()'));
console.log(JSON.stringify({ left, exact }));
assert.deepEqual(left, [0, 0, 0], 'every unit has its row and current stats');
assert.deepEqual(hashes[1], hashes[0], 'two peers stay equal');
assert.deepEqual(hashes[2], hashes[0], 'a peer restored right after they were made stays equal');
assert.equal(new Set(exact).size, 1, 'exact states equal');
assert.deepEqual(peers.map(p => p.errors.length), [0, 0, 0]);
console.log('PASS: ' + made[0].n + ' units made at once: all with their stats from creation; restored peer equal');
process.exit(0);
