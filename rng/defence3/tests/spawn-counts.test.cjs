'use strict';
// spawnCounts (main.js: a group's spawn queue changes in one command): each
// owned producer's queue changes by its count (capped at 20 / 10), others not.
// Usage: node tests/spawn-counts.test.cjs
const assert = require('node:assert/strict'), H = require('./net-harness.cjs'), chaos = require('./chaos-spikes-scenario.cjs');
globalThis.self = { crossOriginIsolated: true };
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '192', 'cfg-map-type': 'arena', 'cfg-gold-count': '200', 'cfg-astar-mine-count': '200', 'cfg-max-pop': '20000', 'cfg-starting-energy': '1000000000000', 'cfg-starting-astar': '1000000000000' };
const world = new H.World({ controls }), i = world.spawn('spawn', { controls, simWorker: false });
i.eval(`MAX_THING_LEVEL=20;MAX_RESEARCH_LEVEL=10;startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{'unit:king':{1:1},'unit:builder_unit':{10:60}},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();`);
const setup = JSON.parse(i.eval('JSON.stringify(' + chaos.setup({ mode: 'mega', layout: 'mixed', buildings: 50, level: 6, towerSites: 30, collectorBuildings: 20, structures: 4000 }) + ')'));
assert.deepEqual(setup.errors, []);
const r = JSON.parse(i.eval(`(() => {
    const mine = barracks.filter(b => b && b.owner === 0 && b.energy > 0 && !b.underConstruction).slice(0, 40), theirs = barracks.filter(b => b && b.owner === 1).slice(0, 10);
    for (const b of [...mine, ...theirs]) while (spawnQueueCount(b) > 0) spawnQueueShift(b);
    const all = [...mine, ...theirs].map(b => [b.gy * GRID_W + b.gx, b]).sort((x, y) => x[0] - y[0]);
    const send = d => processActions([{ action: 'spawnCounts', worker: false, tkz: actionIdsEncode(all.map(x => x[0])), counts: all.map((x, k) => d(k)) }], 0);
    send(k => 3 + (k % 30));
    const after1 = mine.map(b => spawnQueueCount(b)), want1 = mine.map(b => { const k = all.findIndex(x => x[1] === b); return Math.min(20, 3 + (k % 30)); });
    send(() => -2);
    const after2 = mine.map(b => spawnQueueCount(b));
    return JSON.stringify({ n: mine.length, ok1: after1.every((v, k) => v === want1[k]), ok2: after2.every((v, k) => v === Math.max(0, want1[k] - 2)), theirs: theirs.map(b => spawnQueueCount(b)).reduce((a, b) => a + b, 0) }); })()`));
assert.ok(r.n > 0 && r.ok1 && r.ok2, JSON.stringify(r));
assert.equal(r.theirs, 0, 'the other player\'s producers untouched');
assert.deepEqual(i.errors.map(String), []);
console.log('PASS: spawnCounts', JSON.stringify(r));
