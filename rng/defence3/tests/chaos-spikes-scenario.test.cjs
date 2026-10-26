// Small structural/work checks for the same generator used at million-unit
// scale. Performance captures themselves remain serial, separate processes.
'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs'),chaos=require('./chaos-spikes-scenario.cjs');
for(const layout of ['mixed','front']){
 const controls={...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'192','cfg-map-type':'arena','cfg-gold-count':'200','cfg-astar-mine-count':'200','cfg-max-pop':'20000','cfg-starting-energy':'1000000000000','cfg-starting-astar':'1000000000000'};
 const world=new H.World({controls}),i=world.spawn(layout,{controls,simWorker:false});
 i.eval(`MAX_THING_LEVEL=20;MAX_RESEARCH_LEVEL=10;startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{'unit:king':{1:1},'unit:norm':{12:1000},'unit:healer_unit':{12:100},'unit:collector':{10:60},'unit:astar_collector':{10:60},'unit:builder_unit':{10:60},'unit:salvager_unit':{10:60},'unit:researcher_unit':{12:60},'building:house':{10:40}},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();`);
 const options={mode:'mega',layout,buildings:50,level:6,towerSites:30,collectorBuildings:20,structures:4000};
 const setup=JSON.parse(i.eval('JSON.stringify('+chaos.setup(options)+')'));
 assert.deepEqual(setup.errors,[]);assert.ok(setup.structures>=4000);
 for(const role of ['collector','astar_collector','researcher','healer','builder','salvager'])assert.ok(setup.jobs[role]>0,role+' job sites');
 const info=JSON.parse(i.eval(`JSON.stringify((()=>{
  const roles={},hist={};for(const u of units)if(u.workerType&&u.workerTarget)roles[u.workerType]=(roles[u.workerType]||0)+1;
  for(const p of players)for(const v of Object.values(p.researchLevels))hist[v]=(hist[v]||0)+1;
  return{roles,hist,queues:barracks.filter(b=>b.spawnQueue.length===20).length,portals:towers.filter(t=>t.type.startsWith('cloud')).length,
   front:(${JSON.stringify(layout)}==='front'?__scratch.chaosFrontBuildings.every(f=>f.b.rallyY===f.targetY*TILE+16):true)};
 })())`));
 for(const role of ['collector','astar_collector','researcher','healer','builder','salvager'])assert.ok(info.roles[role]>0,role+' assigned workers');
 assert.ok(info.hist[0]&&info.hist[10],'research covers both endpoints');
 assert.ok(info.queues>0&&info.portals>0);assert.ok(info.front,'front rally points cross the gap');
 if(layout==='front')assert.ok(setup.frontBarracks>100&&setup.frontFighters>0);
 assert.deepEqual(i.errors.map(String),[]);
 console.log('PASS:',layout,'job districts, research variation, queues, portals and rally placement',JSON.stringify(info.roles));
}
process.exit(0);
