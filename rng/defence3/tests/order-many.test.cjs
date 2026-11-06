'use strict';
// orderMany (main.js: a multi-point move / attack-move / worker assign as one
// command, one id group a point) leaves the state the separate orders did.
// Usage: node tests/order-many.test.cjs
const assert = require('node:assert/strict'), H = require('./net-harness.cjs'), chaos = require('./chaos-spikes-scenario.cjs');
globalThis.self = { crossOriginIsolated: true };
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '192', 'cfg-map-type': 'arena', 'cfg-gold-count': '200', 'cfg-astar-mine-count': '200', 'cfg-max-pop': '20000', 'cfg-starting-energy': '1000000000000', 'cfg-starting-astar': '1000000000000' };
const run = many => {
    const world = new H.World({ controls }), i = world.spawn('om' + many, { controls, simWorker: false });
    i.eval(`MAX_THING_LEVEL=20;MAX_RESEARCH_LEVEL=10;startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{'unit:king':{1:1},'unit:norm':{12:1000},'unit:builder_unit':{10:60}},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();`);
    const setup = JSON.parse(i.eval('JSON.stringify(' + chaos.setup({ mode: 'mega', layout: 'mixed', buildings: 50, level: 6, towerSites: 30, collectorBuildings: 20, structures: 4000 }) + ')'));
    assert.deepEqual(setup.errors, []);
    const hashes = [];
    for (let step = 0; step < 30; step++) {
        if (step % 10 === 0) i.eval(`(() => { const army = units.filter(u => u && !u.dead && u.owner === 0 && !u.workerType && !u.isKing), half = army.length >> 1;
            const gs = [{ unitIds: army.slice(0, half).map(u => u.id), targetX: (40 + ${step}) * TILE, targetY: 60 * TILE }, { unitIds: army.slice(half).map(u => u.id), targetX: 120 * TILE, targetY: (90 + ${step}) * TILE }];
            const mode = ${step} % 20 ? 'attackMove' : 'move';
            processActions(${many} ? [{ action: 'orderMany', mode, groups: gs }] : gs.map(g => ({ action: mode, ...g })), 0); })()`);
        i.eval('gameTick();currentTick++');
        hashes.push(i.eval('__exactStateHash()'));
    }
    assert.deepEqual(i.errors.map(String), []);
    return hashes;
};
const a = run(true), b = run(false);
const first = a.findIndex((h, k) => h !== b[k]);
assert.equal(first, -1, 'orderMany differs from the separate orders from step ' + first);
console.log('PASS: orderMany equals its separate orders over', a.length, 'steps');
