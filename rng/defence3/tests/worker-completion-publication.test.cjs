'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const helpers=Number(process.argv.find(a=>a.startsWith('--helpers='))?.slice(10)||0);
if(helpers)globalThis.self={crossOriginIsolated:true};
const controls={...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'128','cfg-map-type':'arena','cfg-gold-count':'0','cfg-astar-mine-count':'0'};
const world=new H.World({controls}),i=world.spawn('completion-publication',{controls,simWorker:false});
if(helpers){i.scratch.Worker=require('./real-sim-helper.cjs');i.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=16;simParallelInit('',${helpers});`);}
const result=JSON.parse(i.eval(`JSON.stringify((()=>{
 startSoloGame();
 const put=(x,y,type)=>{if(!placeBuilding(x,y,type,0,{silent:true,ignorePlacementRules:true}))throw Error('placement '+type);return getTileEntityRef(x,y);};
 const farm=put(60,30,'farm'),spawner=put(62,30,'spawner');
 if(!farm.underConstruction||!spawner.underConstruction)throw Error('unfinished fixture');
 const cfg=RESOURCE_TYPE_LIST.find(c=>c.farmKey==='farm');
 _wsPostEpoch=10;const G=_wsCollectorGroup(cfg),objs=G.objs,types=G.types,SX=G.arrays.sx;
 const fi=G.objs.indexOf(farm),pi=G.spawnerObjs.indexOf(spawner);
 if(fi<0||pi<0)throw Error('unfinished structures missing from stable roster');
 if(G.arrays.sready[fi]!==WS_NOT_BUILT||G.arrays.pready[pi]!==WS_NOT_BUILT)throw Error('unfinished eligibility');
 for(const name of ['rkind','rowner','rox','roy','rux','ruy','rr','rak','rax','ray','rgrp','rneed','rjid','rcur','rmy','rpre','res','score'])
  if(!_simParReg['ws.'+name])simParallelBind('ws.'+name,simSharedArray(['rox','roy','rux','ruy','rr','rax','ray','score'].includes(name)?Float32Array:Int32Array,64));
 const post=epoch=>{const P=simParallelStageParams(WS_LANE,1);P.fill(0);P[0]=1;P[1]=GRID_W;P[2]=GRID_H;P[3]=G.id*16;P[63]=epoch;
  const E=simParallelStageParams(WS_LANE,0),jobs=Math.ceil(G.arrays.meta[3]*G.arrays.meta[4]/16);E.fill(0);E[0]=1;E[1]=16;E[2]=epoch;E[3]=jobs;E[4]=G.id;
  simParallelBackgroundChain(WS_LANE,[[SIM_KERNEL_WS_ELIGIBLE,jobs],[SIM_KERNEL_WS_NEARFIELD,1]]);};
 // Completion may race with the search's read. Both possible values must
 // reject this building in the already-posted epoch.
 post(10);markConstructionComplete(farm);markConstructionComplete(spawner);simParallelBackgroundWait(WS_LANE);
 if(G.arrays.sready[fi]!==11||G.arrays.pready[pi]!==11)throw Error('next-batch publication');
 let queries=0;
 const check=epoch=>{const A=G.arrays,nb=A.meta[3]*A.meta[4],slot=A.meta[5+2*nb+16];
  for(let b=0;b<nb;b++){const expected=[];for(let p=A.bs[b];p<A.bs[b]+A.bc[b];p++){const s=A.bi[p];if(A.sready[s]<=epoch)expected.push(s);}
   const actual=Array.from(A.abi.subarray(A.bs[b],A.bs[b]+A.abc[b]));if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('eligible bucket '+b);}
  if(slot<0)throw Error('owner field slot');
  for(let t=0;t<GRID_W*GRID_H;t+=31){let best=0xffffffff;
   for(let q=0;q<G.spawnerObjs.length;q++)if(A.po[q]===0&&A.pready[q]<=epoch){
    const d=Math.abs(A.pgx[q]-t%GRID_W)+Math.abs(A.pgy[q]-Math.floor(t/GRID_W));best=Math.min(best,d*65536+A.ro[q]);}
   if(A.nf[slot*GRID_W*GRID_H+t]!==best)throw Error('eligibility field '+epoch+' tile '+t);queries++;
  }};
 check(10);
 const same=_wsCollectorGroup(cfg);
 if(same!==G||same.objs!==objs||same.types!==types||same.arrays.sx!==SX)throw Error('completion rebuilt roster');
 if(!G.nfBuild)throw Error('nearest field was not invalidated for helper refresh');
 post(11);simParallelBackgroundWait(WS_LANE);check(11);
 _wsPostEpoch=20;workSiteBuilt(farm);workSiteBuilt(spawner);
 if(G.arrays.sready[fi]!==11||G.arrays.pready[pi]!==11)throw Error('duplicate completion changed active eligibility');
 // Force a roster rebuild after completion: finished structures need no
 // new completion registration; reused arrays must still hold the right rows.
 const oldBuckets=G.spawnerBuckets, oldSpawners=G.spawnerObjs;
 const note=_wsNoteCompletionRow;let finishedNotes=0;
 _wsNoteCompletionRow=function(item,row){if(!item.underConstruction)finishedNotes++;return note(item,row);};
 G.sig=null;_wsCollectorGroup(cfg);_wsNoteCompletionRow=note;
 if(finishedNotes)throw Error('completed structures registered completion rows');
 if(G.objs!==objs||G.types!==types||G.spawnerObjs!==oldSpawners||G.spawnerBuckets!==oldBuckets)throw Error('roster buffers not reused');
 if(G.objs[fi]!==farm||G.spawnerObjs[pi]!==spawner||G.arrays.sready[fi]!==0||G.arrays.pready[pi]!==0)throw Error('rebuilt completed rows');
 workerSearchTierReset();const restored=_wsCollectorGroup(cfg);
 if(restored.arrays.sready[restored.objs.indexOf(farm)]!==0)throw Error('reset eligibility');
 return {queries,rosterStable:true,nextEpoch:11,duplicateStable:true};
})())`));
assert.ok(result.queries>1000);assert.deepEqual(i.errors.map(String),[]);console.log(JSON.stringify({helpers,...result}));
for(const w of require('./real-sim-helper.cjs').instances||[])w.terminate();
