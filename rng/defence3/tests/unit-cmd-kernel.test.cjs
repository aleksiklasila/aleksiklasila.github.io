'use strict';
// hold / stop / attack / attackBuilding / killUnit by k_unit_cmd (main.js
// _unitCmdKernel, wasm/src/uix.rs) leave the state as the per-unit setters do:
// a chaos replay's command bursts with the kernel and without it (hidden),
// their exact state hashes step by step.
// Usage: node tests/unit-cmd-kernel.test.cjs
const assert = require('node:assert/strict'), H = require('./net-harness.cjs'), chaos = require('./chaos-spikes-scenario.cjs');
globalThis.self = { crossOriginIsolated: true };
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '192', 'cfg-map-type': 'arena', 'cfg-gold-count': '200', 'cfg-astar-mine-count': '200', 'cfg-max-pop': '20000', 'cfg-starting-energy': '1000000000000', 'cfg-starting-astar': '1000000000000' };
const run = kernel => {
    const world = new H.World({ controls }), i = world.spawn('cmd' + kernel, { controls, simWorker: false });
    i.eval(`MAX_THING_LEVEL=20;MAX_RESEARCH_LEVEL=10;startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{'unit:king':{1:1},'unit:norm':{12:1000},'unit:builder_unit':{10:60}},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();simDk=20;netStepTicks=()=>20;`);
    const setup = JSON.parse(i.eval('JSON.stringify(' + chaos.setup({ mode: 'mega', layout: 'mixed', buildings: 50, level: 6, towerSites: 30, collectorBuildings: 20, structures: 4000 }) + ')'));
    assert.deepEqual(setup.errors, []);
    if (!kernel) i.eval('_unitCmdKernel = () => false; _orderDropKernel = () => false;');
    i.eval('__scratch.actions=[];queueAction=a=>__scratch.actions.push(a);');
    const hashes = [];
    for (let step = 0; step < 40; step++) {
        if (step % 5 === 0) for (let owner = 0; owner < 2; owner++) i.eval(`localPlayerId=${owner};${chaos.burst({ mode: 'mega' }, step / 5)};processActions(__scratch.actions.splice(0),${owner});`);
        // (Workers stopped too: their tasks let go, k_order_workers mode 2.)
        if (step % 5 === 0) for (let owner = 0; owner < 2; owner++) i.eval(`processActions([{ action: 'stop', unitIds: units.filter((u, k) => u && !u.dead && u.owner === ${owner} && u.workerType && (k % 3) === (${step} % 3)).map(u => u.id) }], ${owner})`);
        i.eval('gameTick();currentTick++');
        hashes.push(i.eval('__exactStateHash()'));
    }
    assert.deepEqual(i.errors.map(String), []);
    return hashes;
};
const a = run(true), b = run(false);
const first = a.findIndex((h, k) => h !== b[k]);
assert.equal(first, -1, 'kernel and setters differ from step ' + first);
console.log('PASS: unit commands by k_unit_cmd equal the setters over', a.length, 'steps');
