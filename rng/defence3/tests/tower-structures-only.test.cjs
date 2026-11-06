// Towers with no units on the map at all: the acquisition tier still runs
// (tower.js towersTick steps it when no unit is listed) and its structure
// answers give the towers the enemy buildings in reach (Tower._aqT).
'use strict';
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '64', 'cfg-map-type': 'arena', 'cfg-gold-count': '0', 'cfg-astar-mine-count': '0', 'cfg-max-pop': '20000', 'cfg-full-vis': 'full' };
const world = new H.World({ controls }), i = world.spawn('tower-structures-only', { controls, simWorker: false });
const result = JSON.parse(i.eval(`JSON.stringify((()=>{
 startSoloGame();gameTime=100;
 for(const u of units)u.dead=true;
 for(let k=0;k<3;k++)gameTick();
 const put=(gx,gy,type,owner)=>{if(!placeBuilding(gx,gy,type,owner,{silent:true,ignorePlacementRules:true}))throw Error('place '+type);const t=getTileEntityRef(gx,gy);markConstructionComplete(t);t.energy=t.maxEnergy;structTableRefresh(t);return t;};
 const a=put(20,20,'pistol',0),foe=put(21,20,'pistol',1);foe.energy=foe.maxEnergy=1e6;structTableRefresh(foe);
 recalculateAdjacency(true);
 const e0=foe.energy;
 for(let k=0;k<60;k++)gameTick();
 return {units:units.filter(u=>!u.dead).length,entries:spatialIndexEntries(),loss:e0-foe.energy,aqT:a._aqT,foeTile:foe.gy*GRID_W+foe.gx};
})())`));
console.log(JSON.stringify(result));
assert.deepEqual(i.errors.map(String), []);
assert.equal(result.entries, 0, 'no unit listed');
assert.equal(result.aqT, result.foeTile, 'the tower holds the enemy tower as its answer');
assert.ok(result.loss > 0, 'the tower shoots the enemy structure with no units on the map');
console.log('PASS: towers shoot structures with no units on the map');
