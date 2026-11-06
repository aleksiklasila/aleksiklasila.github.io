// The due kernel's row table (tower.js towerDueReset, tower.rs k_tower_due):
// a tower placed under construction sleeps there (i32::MAX) and fires once
// its construction ends; a cooldown set lower (Tower.cd) makes it act again
// at once; its target is the acquisition tier's committed answer (Tower._aqI).
'use strict';
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '64', 'cfg-map-type': 'arena', 'cfg-gold-count': '0', 'cfg-astar-mine-count': '0', 'cfg-max-pop': '20000', 'cfg-full-vis': 'full' };
const world = new H.World({ controls }), i = world.spawn('tower-due-table', { controls, simWorker: false });
const result = JSON.parse(i.eval(`JSON.stringify((()=>{
 startSoloGame();gameTime=100;
 if(!placeBuilding(20,20,'pistol',0,{silent:true,ignorePlacementRules:true}))throw Error('place');
 const t=getTileEntityRef(20,20);t.energy=t.maxEnergy;structTableRefresh(t);
 const u=new Unit('tank',1,19*TILE+16,20*TILE+16);u.energy=u.maxEnergy=1e6;units.push(u);updateUnitSpatial(u);
 recalculateAdjacency(true);
 const out={uc:!!t.underConstruction};
 for(let k=0;k<5;k++)gameTick();
 out.dueWhileBuilt=_towerDue.a[t._sr];out.lossWhileBuilt=1e6-u.energy;
 markConstructionComplete(t);t.energy=t.maxEnergy;
 out.dueAfterBuilt=_towerDue.a[t._sr];
 
 const e0=u.energy;for(let k=0;k<60;k++)gameTick();
 out.loss=e0-u.energy;out.aq=t._aqI===u.id;out.due=_towerDue.a[t._sr];
 t.cd=0;out.dueAfterCd=_towerDue.a[t._sr];
 return out;
})())`));
console.log(JSON.stringify(result));
assert.deepEqual(i.errors.map(String), []);
assert.equal(result.uc, true, 'placed under construction');
assert.equal(result.lossWhileBuilt, 0, 'no shots while built');
assert.equal(result.dueWhileBuilt, 2147483647, 'a row being built sleeps in the table');
assert.equal(result.dueAfterBuilt, 0, 'construction end wakes the row');
assert.ok(result.loss > 0, 'the tower shoots once built');
assert.equal(result.aq, true, 'the committed answer is the unit (by id)');
assert.ok(result.due > 100, 'the row holds its next tick');
assert.equal(result.dueAfterCd, 0, 'a cooldown set wakes the row');
console.log('PASS: tower due table: built towers wake, cooldowns wake, its target from the acquisition tier');
