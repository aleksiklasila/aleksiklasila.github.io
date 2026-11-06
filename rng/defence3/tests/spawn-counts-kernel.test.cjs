'use strict';
// spawnCounts by k_spawn_counts (wasm/src/spr.rs) leaves the state the
// per-building queue functions did: a chaos replay with group queue / dequeue
// changes each burst, with the kernel and without it (hidden), its exact state
// hashes step by step.
// Usage: node tests/spawn-counts-kernel.test.cjs
const assert = require('node:assert/strict'), H = require('./net-harness.cjs'), chaos = require('./chaos-spikes-scenario.cjs');
globalThis.self = { crossOriginIsolated: true };
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '192', 'cfg-map-type': 'arena', 'cfg-gold-count': '200', 'cfg-astar-mine-count': '200', 'cfg-max-pop': '20000', 'cfg-starting-energy': '1000000000000', 'cfg-starting-astar': '1000000000000' };
const run = kernel => {
    const world = new H.World({ controls }), i = world.spawn('sc' + kernel, { controls, simWorker: false });
    i.eval(`MAX_THING_LEVEL=20;MAX_RESEARCH_LEVEL=10;startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{'unit:king':{1:1},'unit:norm':{12:1000},'unit:builder_unit':{10:60}},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();simDk=20;netStepTicks=()=>20;`);
    const setup = JSON.parse(i.eval('JSON.stringify(' + chaos.setup({ mode: 'mega', layout: 'mixed', buildings: 50, level: 6, towerSites: 30, collectorBuildings: 20, structures: 4000 }) + ')'));
    assert.deepEqual(setup.errors, []);
    if (!kernel) i.eval('SPAWN_COUNTS_KERNEL = false;');
    i.eval('__scratch.actions=[];queueAction=a=>__scratch.actions.push(a);');
    const hashes = [];
    for (let step = 0; step < 40; step++) {
        if (step % 5 === 0) for (let owner = 0; owner < 2; owner++) i.eval(`(() => { const w = ${step} % 10 === 5;
            const L = (w ? collectorSpawners : barracks).filter(b => b && b.owner === ${owner}).map(b => b.gy * GRID_W + b.gx).sort((x, y) => x - y);
            processActions([{ action: 'spawnCounts', worker: w, tkz: actionIdsEncode(L), counts: L.map((t, k) => ((k + ${step}) % 7) - 3) }], ${owner}); })()`);
        i.eval('gameTick();currentTick++');
        hashes.push(i.eval('__exactStateHash()'));
    }
    assert.deepEqual(i.errors.map(String), []);
    return hashes;
};
const a = run(true), b = run(false);
const first = a.findIndex((h, k) => h !== b[k]);
assert.equal(first, -1, 'kernel and queue functions differ from step ' + first);
console.log('PASS: spawnCounts by k_spawn_counts equals the queue functions over', a.length, 'steps');
