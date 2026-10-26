'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const controls={...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'128','cfg-map-type':'arena','cfg-gold-count':'0','cfg-astar-mine-count':'0','cfg-max-pop':'20000'};
const world=new H.World({controls}),i=world.spawn('tower-buildings',{controls,simWorker:false});
const result=JSON.parse(i.eval(`JSON.stringify((()=>{
 startSoloGame();let seed=718;
 const rnd=()=>{seed=Math.imul(seed,1664525)+1013904223|0;return(seed>>>0)/4294967296;};
 const types=['pistol','smg','fire','water','poison','ice','elements','sniper','farm','astar_farm','spawner','astar_spawner','healer_spawner','builder_spawner','salvager','research','barrack_norm','house','mine','lava','sand','ice_patch'];
 let placed=0;
 for(let y=4;y<124;y+=2)for(let x=4;x<124;x+=2){
  if(!placeBuilding(x,y,types[Math.floor(rnd()*types.length)],rnd()<.5?0:1,{silent:true,ignorePlacementRules:true}))continue;
  const t=getTileEntityRef(x,y);if(!t)continue;placed++;
  if(rnd()<.8)markConstructionComplete(t);
  if(rnd()<.04)t.energy=0;
 }
 recalculateAdjacency(true);
 const queries=towers.slice();let checks=0,targets=0;
 for(const t of queries)for(let range=0;range<=4;range++){
  let expected=null;
  if(_towerHostileStructureNear(t,range,range)){
   expected=_findTowerStructureTarget(t,range,'tower')||_findTowerFloorTarget(t,range,true)||_findTowerStructureTarget(t,range,'producer')||_findTowerFloorTarget(t,range,false);
  }
  const actual=_findTowerBuildingTarget(t,range);
  if(actual!==expected)throw Error('Structure target priority/tie mismatch at '+t.gx+','+t.gy+' range '+range);
  checks++;if(actual)targets++;
 }
 return{placed,checks,targets};
})())`));
assert.ok(result.placed>2000&&result.checks>5000&&result.targets>1000);
assert.deepEqual(i.errors.map(String),[]);
console.log('PASS: one-pass tower building targeting preserves class, distance and tile priorities',JSON.stringify(result));
