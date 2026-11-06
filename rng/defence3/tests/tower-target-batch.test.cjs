'use strict';
// towerTarget's batch (main.js: the target code into the towers' rows and the
// preferred bit of their brain words, by the tile table) leaves each tower as
// its setters would: _ptK / _ptV as set, the brain word the one
// stationaryBrainChanged makes. Through a chaos replay's tower orders (a
// unit, a structure, none, by turns).
// Usage: node tests/tower-target-batch.test.cjs
const assert = require('node:assert/strict'), H = require('./net-harness.cjs'), chaos = require('./chaos-spikes-scenario.cjs');
globalThis.self = { crossOriginIsolated: true };
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '192', 'cfg-map-type': 'arena', 'cfg-gold-count': '200', 'cfg-astar-mine-count': '200', 'cfg-max-pop': '20000', 'cfg-starting-energy': '1000000000000', 'cfg-starting-astar': '1000000000000' };
const world = new H.World({ controls }), i = world.spawn('towers', { controls, simWorker: false });
i.eval(`MAX_THING_LEVEL=20;MAX_RESEARCH_LEVEL=10;startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{'unit:king':{1:1},'unit:norm':{12:1000},'unit:builder_unit':{10:60}},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();simDk=20;netStepTicks=()=>20;`);
const setup = JSON.parse(i.eval('JSON.stringify(' + chaos.setup({ mode: 'mega', layout: 'mixed', buildings: 50, level: 6, towerSites: 30, collectorBuildings: 20, structures: 4000 }) + ')'));
assert.deepEqual(setup.errors, []);
i.eval('__scratch.actions=[];queueAction=a=>__scratch.actions.push(a);');
let targeted = 0, set = 0;
for (let step = 0; step < 40; step++) {
    if (step % 10 === 0) for (let owner = 0; owner < 2; owner++) i.eval(`localPlayerId=${owner};${chaos.burst({ mode: 'mega' }, step / 10)};processActions(__scratch.actions.splice(0),${owner});`);
    // (Every tower's brain word made anew by its setters' path: it must not change.)
    const r = JSON.parse(i.eval(`(() => { let bad = 0, n = 0, pref = 0, ex = null;
        for (const t of towers) { if (!t || !(t._stT >= 0)) continue; n++; if (t._ptK > 0) pref++;
            const before = _ST.brain[t._stT]; stationaryBrainChanged(t); const after = _ST.brain[t._stT];
            if (before !== after) { bad++; if (!ex) ex = [t.gx, t.gy, before, after, t._ptK, t._ptV]; } }
        return JSON.stringify({ bad, n, pref, ex }); })()`));
    assert.equal(r.bad, 0, 'step ' + step + ': brain words differ from stationaryBrainChanged ' + JSON.stringify(r));
    targeted = r.n; set = Math.max(set, r.pref);
    i.eval('gameTick();currentTick++');
}
assert.ok(set > 0, 'some towers got a preferred target');
assert.deepEqual(i.errors.map(String), []);
console.log('PASS: towerTarget batches leave every brain word as stationaryBrainChanged makes it (' + targeted + ' towers, up to ' + set + ' with a target)');
