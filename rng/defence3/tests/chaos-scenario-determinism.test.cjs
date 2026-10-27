'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs'),chaos=require('./chaos-spikes-scenario.cjs');
globalThis.self={crossOriginIsolated:true};
const controls={...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'192','cfg-map-type':'arena','cfg-gold-count':'200','cfg-astar-mine-count':'200','cfg-max-pop':'20000','cfg-starting-energy':'1000000000000','cfg-starting-astar':'1000000000000'};
const rows=[];
for(const helpers of [0,0,3]){
 const world=new H.World({controls}),i=world.spawn('dense-replay',{controls,simWorker:false});
 if(helpers){i.scratch.Worker=require('./real-sim-helper.cjs');i.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=16;simParallelInit('',${helpers});`);}
 i.eval(`MAX_THING_LEVEL=20;MAX_RESEARCH_LEVEL=10;startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{'unit:king':{1:1},'unit:norm':{12:1000},'unit:healer_unit':{12:100},'unit:collector':{10:60},'unit:astar_collector':{10:60},'unit:builder_unit':{10:60},'unit:salvager_unit':{10:60},'unit:researcher_unit':{12:60},'building:house':{10:40}},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();simDk=20;netStepTicks=()=>20;`);
 const setup=JSON.parse(i.eval('JSON.stringify('+chaos.setup({mode:'mega',layout:'mixed',buildings:50,level:6,towerSites:30,collectorBuildings:20,structures:4000})+')'));
 assert.deepEqual(setup.errors,[]);
 i.eval('__scratch.actions=[];queueAction=a=>__scratch.actions.push(a);');
 const hashes=[i.eval('__exactStateHash()')];
 for(let step=0;step<64;step++){
  if(step%10===0)for(let owner=0;owner<2;owner++)i.eval(`localPlayerId=${owner};${chaos.burst({mode:'mega'},step/10)};processActions(__scratch.actions.splice(0),${owner});`);
  try{i.eval('gameTick();currentTick++');}catch(err){err.message='Replay step '+step+', helpers '+helpers+': '+err.message;throw err;}
  hashes.push(i.eval('__exactStateHash()'));
 }
 assert.deepEqual(i.errors.map(String),[]);
 rows.push({helpers,hashes});
 if(rows.length>1)assert.deepEqual(hashes,rows[0].hashes,'mixed worker/combat replay, helpers='+helpers);
 console.log('PASS: mixed replay',helpers,'helpers,',hashes.length,'state hashes');
}
for(const w of require('./real-sim-helper.cjs').instances||[])w.terminate();
