'use strict';
// Differential checks for the grouped native resource changes. Run
// after timing acceptance; these are not performance measurements.
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const helpers=Number(process.argv.find(a=>a.startsWith('--helpers='))?.slice(10)||0);
if(helpers)globalThis.self={crossOriginIsolated:true};
const controls={...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'128','cfg-map-type':'arena','cfg-gold-count':'0','cfg-astar-mine-count':'0','cfg-max-pop':'20000'};
const world=new H.World({controls}),i=world.spawn('wasm-batch',{controls,simWorker:false});
if(helpers){i.scratch.Worker=require('./real-sim-helper.cjs');i.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=16;simParallelInit('',${helpers});`);}
const result=JSON.parse(i.eval(`JSON.stringify((()=>{
 startSoloGame();let seed=77183;const rnd=n=>{seed=Math.imul(seed,1664525)+1013904223|0;return Math.floor((seed>>>0)/4294967296*n);};
 const types=['pistol','fire','farm','research','spawner','mine','lava'];
 for(let y=4;y<124;y+=3)for(let x=4;x<124;x+=3){
  if(placeBuilding(x,y,types[rnd(types.length)],rnd(2),{silent:true,ignorePlacementRules:true})){
   const t=getTileEntityRef(x,y);markConstructionComplete(t);if(rnd(20)===0)t.energy=0;
  }
 }
 for(let j=0;j<1000;j++){const u=new Unit('norm',rnd(2),(4+rnd(28))*TILE+16,(4+rnd(28))*TILE+16);units.push(u);updateUnitSpatial(u);}
 // (The towers' broad phase it checked is gone: towers take the acquisition tier's answers, tower.js towerAcqPost.)
 // Compare public resource mutations with/without batching, including
 // intermediate flushes, explicit writes, fractional debt and extra keys.
 const initial=players.map(p=>({energy:-3.25,astar:17.125,shrine:2,resourceMaxValues:{energy:9,astar:20,shrine:3},_resourceFixedValues:{energy:-3328,astar:17536,shrine:2048}}));
 const ops=Array.from({length:6400},(_,j)=>[rnd(players.length),['energy','astar','shrine','custom'][j%97===0?2+rnd(2):rnd(2)],(rnd(200001)-100000)/4096,j%211===0]);
 function run(batch){
  playerResourceBatchEnd();for(let p=0;p<players.length;p++){delete players[p].custom;Object.assign(players[p],JSON.parse(JSON.stringify(initial[p])));}
  const returns=[];
  for(let j=0;j<ops.length;j++){
   if(batch&&j%128===0)playerResourceBatchBegin();
   const [pid,key,delta,set]=ops[j];returns.push(set?_setPlayerResourceValue(pid,key,delta):addPlayerResource(pid,key,delta));
   if(j%13===0)playerResourceBatchFlush();
   if(j%17===0)_ensurePlayerResourceState(pid);
   if(j%128===127)playerResourceBatchEnd();
  }
  playerResourceBatchEnd();
  return JSON.stringify({returns,players:players.map(p=>({energy:p.energy,astar:p.astar,shrine:p.shrine,custom:p.custom,max:p.resourceMaxValues,fixed:p._resourceFixedValues}))});
 }
 const plain=run(false),batch=run(true);if(plain!==batch)throw Error('Batched resource mutations differ from immediate public mutations');
 return{resourceMutations:ops.length,wasm64:SIM_WASM64};
})())`));
assert.equal(result.resourceMutations,6400);
assert.deepEqual(i.errors.map(String),[]);
console.log('PASS: batched resource boundary checks',JSON.stringify({helpers,...result}));process.exit(0);
