'use strict';
// Differential checks for the grouped native tower/resource changes. Run
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
 spatialIndexRebuild();_simMoveStructs();simParallelBind('mv.stblk',_simMoveStructBlocks);
 const n=1031,boxes=_towerAcqArray('boxes',Int32Array,n*4),own=_towerAcqArray('owner',Int32Array,n),live=_towerAcqArray('live',Uint32Array,n),expected=[];
 for(let q=0;q<n;q++){
  const x=rnd(GRID_W),y=rnd(GRID_H),x1=Math.min(GRID_W-1,x+rnd(25)),y1=Math.min(GRID_H-1,y+rnd(25)),o=q%17===0?-1:rnd(2),empty=q%19===0;
  boxes.set([x,y,empty?-1:x1,y1],q*4);own[q]=o;
  expected[q]=!empty&&(_regionMayHaveEnemyUnits(o,x,y,x1,y1)||hasHostileStructureInTileRect(o,x,y,x1,y1));
 }
 const P=_simParams;P[0]=n;P[1]=32;P[2]=spatialUnitsComplexPlayerCount;P[3]=spatialBlockCols;P[4]=GRID_W;P[5]=SPATIAL_BLOCK_SIZE;
 simParallelRun(SIM_KERNEL_TOWER_COARSE,Math.ceil(n/32));
 for(let q=0;q<n;q++)if(!!live[q]!==expected[q])throw Error('Tower broad-phase differs at '+q);
 const keys=_towerAcqArray('sortKeys',Int32Array,n),order=_towerAcqArray('sortOrder',Int32Array,n);_towerAcqArray('sortTmp',Int32Array,n);
 for(let q=0;q<n;q++)keys[q]=q%3===0?7:rnd(200)-100;
 const sorted=Array.from({length:n},(_,q)=>q).sort((a,b)=>keys[a]-keys[b]);
 simParallelStageParams(SIM_LANE_TICK,0)[0]=n;simParallelBackground(SIM_KERNEL_TOWER_ORDER,1,SIM_LANE_TICK);simParallelBackgroundWait(SIM_LANE_TICK);
 for(let q=0;q<n;q++)if(order[q]!==sorted[q])throw Error('Stable native tile order differs at '+q);
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
 gameTime=1000;for(const t of towers){t._cdUntil=0;structTableRefresh(t);}
 _towerAcqPrepare(towers.slice().sort(_towerTileOrder));
 if(!_towerAcq.ready)throw Error('Native idle batch did not run');
 let idles=0,buildings=0;_towerAcq.ready=false;
 for(let q=0;q<_towerAcq.list.length;q++){
  const A=_towerAcq,t=A.list[q],empty=A.arrays.out[q]<0&&A.arrays.sout[q]===-1;
  if(A.arrays.out[q]<0&&A.arrays.sout[q]!==-2){
   const target=_findTowerBuildingTarget(t,t.currentStats.attackRangeArea),tile=target?target.gy*GRID_W+target.gx:-1;
   if(tile!==A.arrays.sout[q])throw Error('Native building priority/tile target differs at '+q);
   buildings++;
  }
  const expected=empty?towerIdleCooldown(t,secondsToTicks(t.currentStats.cd||1.5)):0;
  if(A.arrays.idle[q]!==expected)throw Error('Native idle deadline differs at '+q);
  if(empty)idles++;
 }
 if(!idles)throw Error('Idle path was not exercised');
 return{coarseQueries:n,stableOrder:n,resourceMutations:ops.length,idles,buildings,wasm64:SIM_WASM64};
})())`));
assert.equal(result.coarseQueries,1031);assert.equal(result.resourceMutations,6400);
assert.deepEqual(i.errors.map(String),[]);
console.log('PASS: native tower broad phase/order and batched resource boundary checks',JSON.stringify({helpers,...result}));process.exit(0);
