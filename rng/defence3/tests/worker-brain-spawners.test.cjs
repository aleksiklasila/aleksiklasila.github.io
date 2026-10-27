'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const helpers=Number(process.argv.find(a=>a.startsWith('--helpers='))?.slice(10)||0);
if(helpers)globalThis.self={crossOriginIsolated:true};
const controls={...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'128','cfg-map-type':'arena','cfg-gold-count':'0','cfg-astar-mine-count':'0','cfg-max-pop':'20000','cfg-full-vis':'full'};
const world=new H.World({controls}),i=world.spawn('worker-brain-spawners',{controls,simWorker:false});
if(helpers){i.scratch.Worker=require('./real-sim-helper.cjs');i.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=16;simParallelInit('',${helpers});`);}
const result=JSON.parse(i.eval(`JSON.stringify((()=>{
 startSoloGame();gameTime=100;
 let seed=177;const rnd=()=>{seed=Math.imul(seed,1664525)+1013904223|0;return(seed>>>0)/4294967296;};
 const keys=_workerBrainSpawnerTypes,types=['collector','astar_collector','salvager_unit','builder_unit','healer_unit','researcher_unit'];
 for(let y=4,j=0;y<124;y+=4)for(let x=4;x<124;x+=4,j++)if(placeBuilding(x,y,keys[j%6],Math.floor(j/6)%2,{silent:true,ignorePlacementRules:true})){
  const s=getTileEntityRef(x,y);if(j%7)markConstructionComplete(s);if(j%29===0)s.energy=0;
 }
 const workers=[];
 for(let j=0;j<1600;j++){
  const u=new Unit(types[j%6],j%2,(1+rnd()*125)*TILE,(1+rnd()*125)*TILE);configureWorkerUnitFromType(u);
  if(u.dead)continue;units.push(u);updateUnitSpatial(u);workers.push(u);
 }
 const prepare=()=>{_unitEventSortReserve(workers.length);for(let q=0;q<workers.length;q++)_unitEvSort.ent[q]=workers[q]._si*8;workerBrainsPrepare(workers.length);};
 const tile=s=>s?s.gy*GRID_W+s.gx:-1;
 let checks=0;
 const compare=()=>{
  const before=__exactStateHash();prepare();if(_workerBrain.tick!==gameTime)throw Error('Worker brain batch did not run');
  if(before!==__exactStateHash())throw Error('Read-only brain preparation changed authoritative state');
  for(const u of workers){const wt=u._us.wbType[u._us.wkIx[u._si]],type=keys[wt-1];
   WORKER_BRAIN_WASM=false;const expected=_findClosestSpawner(u,type);WORKER_BRAIN_WASM=true;const actual=_findClosestSpawner(u,type);
   if(tile(actual)!==tile(expected))throw Error('Nearest mismatch '+u.workerType+' '+u.x+','+u.y+' '+tile(actual)+'/'+tile(expected));checks++;
  }
  if(_workerBrain.used<workers.length*.95)throw Error('Most decisions fell back to JS: '+_workerBrain.used+'/'+workers.length);
 };
 compare();
 const u=workers[10],type=keys[u._us.wbType[u._us.wkIx[u._si]]-1],s=_findClosestSpawner(u,type);
 if(s){destroyBuilding(s);WORKER_BRAIN_WASM=false;const expected=_findClosestSpawner(u,type);WORKER_BRAIN_WASM=true;
  if(tile(_findClosestSpawner(u,type))!==tile(expected))throw Error('Destroyed prepared target did not revalidate');}
 for(const s of collectorSpawners.slice())if(s.type==='research'&&s.owner===1)destroyBuilding(s);
 gameTime++;compare();
 const researcher=workers.find(u=>u.workerType==='researcher'&&u.owner===1);
 if(researcher){
  if(_findClosestSpawner(researcher,'research')!==null)throw Error('Expected empty frozen research roster');
  placeBuilding(5,6,'research',1,{silent:true,ignorePlacementRules:true});const added=getTileEntityRef(5,6);markConstructionComplete(added);
  if(_findClosestSpawner(researcher,'research')!==null)throw Error('An in-phase completion must not depend on helper scheduling');
  gameTime++;compare();if(!_findClosestSpawner(researcher,'research'))throw Error('Next brain batch missed completion');
  workerBrainsEnd();WORKER_BRAIN_WASM=false;const expected=_findClosestSpawner(researcher,'research');WORKER_BRAIN_WASM=true;
  if(_findClosestSpawner(researcher,'research')!==expected)throw Error('Out-of-phase call used a stale brain cache');
 }
 // A worker record's profession changes invalidate the old stamped answer.
 workers[0].workerType='healer';if(workers[0]._us.wbTick[workers[0]._us.wkIx[workers[0]._si]]!==-1)throw Error('Profession change retained a stamped answer');
 for(let q=0;q<workers.length;q++){
  const u=workers[q];if(q%101===0)u.workerTransferCooldown=5;
  if(q%157===0)u._us.wsKind[u._si]=1;
 }
 gameTime++;compare();
 for(const u of workers)if((u.workerTransferCooldown>0||u._us.wsKind[u._si])&&u._us.wbTick[u._us.wkIx[u._si]]===gameTime)throw Error('Cooling or tier-owned brain did unnecessary search work');
 return{helpers:${helpers},checks,used:_workerBrain.used,bytes:Object.values(_workerBrain.arrays).reduce((n,a)=>n+a.byteLength,0),recordBytes:9*_simUnitState.wk.cap};
})())`));
assert.ok(result.checks>4000);assert.deepEqual(i.errors.map(String),[]);
console.log('PASS: batched SIMD worker spawner decisions',JSON.stringify(result));process.exit(0);
