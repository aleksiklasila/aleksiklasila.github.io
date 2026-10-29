'use strict';
const assert = require('node:assert/strict');
const { fixture, matrix, balancedFixture, inspectLoadWorld } = require('./load-fixtures.cjs');
const { settingsFor } = require('./make-load-fixtures.cjs');
const H = require('./net-harness.cjs');

const cases = matrix();
assert.equal(cases.length, 36);
assert.equal(new Set(cases.map(f => f.name)).size, 36);
const balanced = balancedFixture();
assert.equal(balanced.spawnCounts['unit:king'][1], 1);
for (const [key, levels] of Object.entries(balanced.spawnCounts)) if (key.startsWith('building:cloud_')) assert.equal(levels[1], 1);
assert.equal(Object.entries(balanced.spawnCounts).filter(([key])=>key.startsWith('unit:')).reduce((sum,[,levels])=>sum+levels[1],0), 1000000);
assert.equal(Object.entries(balanced.spawnCounts).filter(([key])=>key.startsWith('building:')).reduce((sum,[,levels])=>sum+levels[1],0), 100000);
for (const f of cases) {
    const sum = kind => Object.entries(f.spawnCounts).filter(([key]) => key.startsWith(kind + ':'))
        .reduce((total, [, levels]) => total + Object.values(levels).reduce((a, b) => a + b, 0), 0) * f.owners.length;
    assert.equal(sum('unit'), f.units); assert.equal(sum('building'), f.statics);
}
assert.throws(() => fixture({ units: 3 }));
assert.throws(() => fixture({ statics: Infinity }));
for (const millions of [2, 4, 8]) {
    const imported = new H.World().spawn('import-' + millions);
    imported.eval("document.getElementById('starting-resources-popup').classList.add('hidden');");
    imported.eval(`applyMainMenuSettingsSnapshot(${JSON.stringify(settingsFor(millions * 1000000))});`);
    assert.equal(imported.eval('getStartingResourcesTotalSpawnCount()'), millions * 500000, 'real settings import preserves per-team units');
    // (The menu's choices: powers of two up to 2^20 a player, the nearest; map sizes the same.)
    assert.equal(imported.eval('CONFIG_MAX_POP'), Math.min(2 ** 20, 2 ** Math.round(Math.log2(millions * 500000))), 'an import takes the nearest population choice');
    assert.equal(imported.eval("getStartingSpawnCount('unit:king',1)"), 1);
    assert.equal(imported.eval('GRID_W'), 1024, 'and the nearest map size');
    assert.deepEqual(imported.errors, []);
}

const spec = fixture({ units: 100, statics: 40, map: 40 });
const w = new H.World();
// (These inspect the simulation's own state on the page: page mode whatever SIM_WORKER says.)
const g = w.spawn('load-startup', { simWorker: false, controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': String(spec.map),
    'cfg-max-pop': '100', 'cfg-gold-count': '0', 'cfg-astar-mine-count': '0' } });
g.eval(`ensureMainMenuPrecomputedStateReady();
    startingResourcesConfig={spawnCounts:${JSON.stringify(spec.spawnCounts)},researchLevels:{}};
    startSoloGame();`);
const inspect = `(${inspectLoadWorld.toString()})(${JSON.stringify(spec)})`;
const initial = JSON.parse(g.eval(`JSON.stringify(${inspect})`));
assert.deepEqual(initial.errors, []);
assert.equal(initial.counts.survivingUnits, 100);
assert.equal(initial.counts.buildings, 20);
assert.equal(initial.counts.floor, 20);
g.eval('snapDecodeState(snapEncodeState());');
const restored = JSON.parse(g.eval(`JSON.stringify(${inspect})`));
assert.deepEqual(restored.errors, []);
assert.deepEqual(restored.counts, initial.counts, 'snapshot preserves populations and ownership');
g.eval('snapDecodeState(snapEncodeState());');
assert.deepEqual(JSON.parse(g.eval(`JSON.stringify(${inspect})`)).hash, restored.hash, 'normalized snapshot digest is stable on repeated restore');
g.eval('units[1].id=units[0].id');
assert.ok(JSON.parse(g.eval(`JSON.stringify(${inspect})`)).errors.some(e => /duplicate unit ID/.test(e)));

const impossible = fixture({ units: 2, statics: 1000, map: 8 });
const bad = w.spawn('load-truncated', { simWorker: false, controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '8', 'cfg-max-pop': '2',
    'cfg-gold-count': '0', 'cfg-astar-mine-count': '0' } });
bad.eval(`ensureMainMenuPrecomputedStateReady(); startingResourcesConfig={spawnCounts:${JSON.stringify(impossible.spawnCounts)},researchLevels:{}};startSoloGame();`);
const truncated = JSON.parse(bad.eval(`JSON.stringify((${inspectLoadWorld.toString()})(${JSON.stringify(impossible)}))`));
assert.ok(truncated.errors.some(e => /insufficient placement/.test(e)), 'impossible placement is an explicit fixture failure');
assert.deepEqual(g.errors, []); assert.deepEqual(bad.errors, []);
console.log('PASS: 2M/4M/8M real settings imports, 36 exact-total fixtures, production startup, snapshot validation, duplicate IDs and impossible placement.');
