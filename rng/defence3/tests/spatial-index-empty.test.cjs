'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const world=new H.World(),i=world.spawn('empty-index',{simWorker:false});
const r=i.eval(`(()=>{
 startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{},researchLevels:{}});
 applyMainMenuControlsToRuntimeState();startSoloGame();
 for(let t=0;t<3;t++)gameTick();
 const initial={units:units.length,listed:_sxListed,prebuild:_sxPre!==null};
 const u=new Unit('norm',0,30*TILE+16,30*TILE+16);units.push(u);unitByIdAdded(u);players[0].popCount++;
 gameTick();spatialIndexEnsure();const populated=_sxListed;
 removeUnitNow(u);units.length=0;spatialIndexInvalidate();spatialIndexEnsure();
 return {initial,populated,remaining:units.length,listed:_sxListed};
})()`);
assert.deepEqual(r.initial,{units:0,listed:0,prebuild:false});
assert.equal(r.populated,1);assert.equal(r.remaining,0);assert.equal(r.listed,0);
assert.deepEqual(i.errors.map(String),[]);
console.log('PASS: initially empty and newly emptied matches rebuild their spatial index');
