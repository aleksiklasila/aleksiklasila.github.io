const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const world = new H.World();
const game = world.spawn('starting-spawn-limits', { controls: {
    ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '80', 'cfg-map-type': 'arena',
    'cfg-max-pop': '12000', 'cfg-gold-count': '0', 'cfg-astar-mine-count': '0'
} });
game.eval(`
    ensureMainMenuPrecomputedStateReady();
    startingResourcesConfig = { researchLevels: {}, spawnCounts: {} };
    adjustStartingSpawnCountDelta('building:house', 1, 65536);
    adjustStartingSpawnCountDelta('unit:norm', 1, 11000);
    adjustStartingSpawnCountDelta('unit:norm', 2, 4096);
`);
assert.equal(game.eval("getStartingSpawnCount('building:house', 1)"), 65536, 'buildings have no 1k or 10k clamp');
assert.equal(game.eval("getStartingSpawnCount('unit:norm', 1)"), 11000, 'units can exceed 10k');
assert.equal(game.eval("getStartingSpawnCount('unit:norm', 2)"), 1000, 'levels share the population cap');
game.eval("setStartingSpawnCount('unit:king', 1, 100);");
assert.equal(game.eval("getStartingSpawnCount('unit:king', 1)"), 0, 'unit types share the population cap');
game.eval('startingResourcesConfig = normalizeStartingResourcesConfig(startingResourcesConfig);');
assert.equal(game.eval("getStartingSpawnCount('building:house', 1)"), 65536, 'normalization preserves large building counts');
assert.equal(game.eval("getStartingSpawnCount('unit:norm', 1)"), 11000, 'normalization preserves large unit counts');
for (const value of ['Infinity', 'NaN', '-5']) {
    assert.equal(game.eval(`normalizeStartingSpawnCount(${value})`), 0, 'invalid counts cannot cause unbounded spawn loops');
}

// Imported settings can exceed the current cap (or the cap can be lowered).
// Match startup must enforce the total cap, while preserving counts above 10k.
game.eval(`
    startingResourcesConfig = { researchLevels: {}, spawnCounts: {
        'building:house': { 1: 1025 },
        'unit:norm': { 1: 11000, 2: 2000 },
        'unit:king': { 1: 100 }
    } };
    startSoloGame();
`);
for (const pid of JSON.parse(game.eval('JSON.stringify(activeTeamIds)'))) {
    assert.equal(game.eval(`players[${pid}].popCount`), 12000, 'startup uses configured population cap');
    assert.equal(game.eval(`units.filter(u => u.owner === ${pid} && u.unitType === 'norm' && getUnitBaseLevel(u) === 1).length`), 11000);
    assert.equal(game.eval(`units.filter(u => u.owner === ${pid} && u.unitType === 'norm' && getUnitBaseLevel(u) === 2).length`), 1000);
    assert.equal(game.eval(`getCellItemsRowMajor().filter(b => b.type === 'house' && grid[b.gy][b.gx].owner === ${pid}).length`), 1025);
}
assert.deepEqual(game.errors, []);
console.log('PASS: unrestricted building settings, units above 10k, shared population limit, and actual match startup.');
