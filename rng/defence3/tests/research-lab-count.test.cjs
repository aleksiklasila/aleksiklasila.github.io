'use strict';
// The structure table's research lab counts per owner (data_state.js
// structLabCount, structLabBuilt: kept where its entries change, the destroy
// kernel's batches too) equal a count over the research table's live rows,
// through a chaos replay that places, builds and destroys structures, and
// through a snapshot restore.
// Usage: node tests/research-lab-count.test.cjs
const assert = require('node:assert/strict'), H = require('./net-harness.cjs'), chaos = require('./chaos-spikes-scenario.cjs');
globalThis.self = { crossOriginIsolated: true };
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '192', 'cfg-map-type': 'arena', 'cfg-gold-count': '200', 'cfg-astar-mine-count': '200', 'cfg-max-pop': '20000', 'cfg-starting-energy': '1000000000000', 'cfg-starting-astar': '1000000000000' };
const world = new H.World({ controls }), i = world.spawn('labs', { controls, simWorker: false });
i.eval(`MAX_THING_LEVEL=20;MAX_RESEARCH_LEVEL=10;startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{'unit:king':{1:1},'unit:norm':{12:1000},'unit:collector':{10:60},'unit:builder_unit':{10:60},'unit:salvager_unit':{10:60},'unit:researcher_unit':{12:60},'building:house':{10:40}},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();simDk=20;netStepTicks=()=>20;`);
const setup = JSON.parse(i.eval('JSON.stringify(' + chaos.setup({ mode: 'mega', layout: 'mixed', buildings: 50, level: 6, towerSites: 30, collectorBuildings: 20, structures: 4000 }) + ')'));
assert.deepEqual(setup.errors, []);
i.eval('__scratch.actions=[];queueAction=a=>__scratch.actions.push(a);');
const check = label => {
    const r = JSON.parse(i.eval(`(() => { const T = _sTables.get(ResearchSpawner), all = new Array(8).fill(0), built = new Array(8).fill(0);
        for (let r = 0; T && r < T.n; r++) { const s = T.rowObj[r]; if (!s || T.ret[r] || !(s._stT >= 0) || getTileEntityRef(s.gx, s.gy) !== s) continue; all[s.owner]++; if (!s.underConstruction) built[s.owner]++; }
        return JSON.stringify({ all, built, labs: Array.from(structLabCount.subarray(0, 8)), labsBuilt: Array.from(structLabBuilt.subarray(0, 8)) }); })()`));
    assert.deepEqual(r.labs, r.all, label + ': lab counts ' + JSON.stringify(r));
    assert.deepEqual(r.labsBuilt, r.built, label + ': built lab counts ' + JSON.stringify(r));
    return r;
};
let last = check('setup');
// (Labs destroyed and placed too: a few killed by their energy, new ones placed for each player.)
for (let step = 0; step < 60; step++) {
    if (step % 10 === 0) for (let owner = 0; owner < 2; owner++) i.eval(`localPlayerId=${owner};${chaos.burst({ mode: 'mega' }, step / 10)};processActions(__scratch.actions.splice(0),${owner});`);
    if (step % 15 === 5) i.eval(`(() => { const L = collectorSpawners.filter(s => s && s.type === 'research' && s.energy > 0); for (let k = 0; k < Math.min(3, L.length); k++) L[k * 7 % L.length].energy = 0; })()`);
    i.eval('gameTick();currentTick++');
    last = check('step ' + step);
}
assert.deepEqual(i.errors.map(String), []);
console.log('PASS: research lab counts exact through 60 replay steps', JSON.stringify(last.labs), JSON.stringify(last.labsBuilt));
