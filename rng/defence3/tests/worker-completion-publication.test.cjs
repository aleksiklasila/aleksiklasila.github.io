'use strict';
// The collectors' groups and a construction finished (worker.js _wsPost, wsb.rs k_ws_mirror / k_ws_gbuild): the
// groups are made on the search lane from the tile mirror as of the post; a structure finished while a search is
// in flight leaves that search's groups as they were (unfinished: every peer's search read the same), its tile is
// journaled, and the next post's groups have it finished. Eligible buckets and the near field follow the groups'
// readiness; a post with nothing changed makes nothing again; a reset (a restore) makes the same groups whole; the
// mirror kept from the journal equals one made whole from the structure table.
//   node tests/worker-completion-publication.test.cjs [--helpers=N]
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
 const gid=RESOURCE_TYPE_LIST.findIndex(c=>c.farmKey==='farm');
 for(const name of ['rkind','rowner','rox','roy','rux','ruy','rr','rak','rax','ray','rgrp','rneed','rjid','rcur','rmy','rpre','res','score'])
  if(!_simParReg['ws.'+name])simParallelBind('ws.'+name,simSharedArray(['rox','roy','rux','ruy','rr','rax','ray','score'].includes(name)?Float32Array:Int32Array,64));
 // A post's group part: the mirror, the changed groups' stages, eligibility and the near fields (the chain's slots 0-6).
 let built=0;
 const post=epoch=>{
  const {gl,stages}=_wsgStages(_wsgPrepare());built+=gl.includes(gid)?1:0;
  const G=_wsGroupById[gid],nb=Math.ceil(GRID_W/WS_BUCKET)*Math.ceil(GRID_H/WS_BUCKET),jobs=Math.ceil(nb/16);
  const E=_simBgStageParams[WS_LANE][3];E.fill(0);E[0]=1;E[1]=16;E[2]=epoch;E[3]=jobs;E[4]=gid;
  const pairs=gl.includes(gid)?Array.from({length:_wsgS.slots},(_,o)=>gid*16+o):[];
  for(const [slot,mode] of [[4,3],[5,1],[6,2]]){const P=_simBgStageParams[WS_LANE][slot];P.fill(0);P[0]=pairs.length;P[1]=GRID_W;P[2]=GRID_H;P[63]=epoch;P[62]=mode;
   const rowJobs=Math.min(64,GRID_H),per=Math.max(rowJobs,Math.ceil(GRID_W/WS_NF_COLS));P[61]=Math.ceil(GRID_H/rowJobs);P[60]=WS_NF_COLS;P[59]=per;pairs.forEach((p,k)=>{P[3+k]=p;});}
  const per=Math.max(Math.min(64,GRID_H),Math.ceil(GRID_W/WS_NF_COLS));
  simParallelBackgroundChain(WS_LANE,[...stages,[SIM_KERNEL_WS_ELIGIBLE,jobs],[SIM_KERNEL_WS_NEARFIELD,pairs.length],[SIM_KERNEL_WS_NEARFIELD,pairs.length*per],[SIM_KERNEL_WS_NEARFIELD,pairs.length*per]]);
 };
 const G=_wsGroupById[gid],A=G.arrays,TL=A.tile,SX=A.sx;
 const ft=farm.gy*GRID_W+farm.gx,pt=spawner.gy*GRID_W+spawner.gx;
 const site=()=>Array.from(A.tile.subarray(0,G.n)).indexOf(ft),spawnerAt=()=>Array.from(A.pid.subarray(0,G.np)).indexOf(pt);
 post(10);simParallelBackgroundWait(WS_LANE);
 let fi=site(),pi=spawnerAt();
 if(fi<0||pi<0)throw Error('unfinished structures missing from the group');
 if(A.sready[fi]!==WS_NOT_BUILT||A.pready[pi]!==WS_NOT_BUILT)throw Error('unfinished eligibility');
 let queries=0;
 const check=(epoch,built)=>{const nb=A.meta[3]*A.meta[4],slot=A.meta[5+2*nb+16];
  for(let b=0;b<nb;b++){const expected=[];for(let p=A.bs[b];p<A.bs[b]+A.bc[b];p++){const s=A.bi[p];if(A.sready[s]<=epoch)expected.push(s);}
   const actual=Array.from(A.abi.subarray(A.bs[b],A.bs[b]+A.abc[b]));if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('eligible bucket '+b);}
  if(slot<0)throw Error('owner field slot');
  // (A field holds its nearest spawner's tile, by (steps, tile order: ro), all ones for none: k.rs nearfield.)
  for(let t=0;t<GRID_W*GRID_H;t+=31){let best=0xffffffff,bq=-1;
   for(let q=0;q<A.meta[1];q++)if(A.po[q]===0&&A.pready[q]<=epoch){
    const d=Math.abs(A.pgx[q]-t%GRID_W)+Math.abs(A.pgy[q]-Math.floor(t/GRID_W));const k=d*65536+A.ro[q];if(k<best){best=k;bq=q;}}
   const want=bq<0?0xffffffff:A.pid[bq];if(A.nf[slot*GRID_W*GRID_H+t]!==want)throw Error('field '+epoch+' tile '+t+': '+A.nf[slot*GRID_W*GRID_H+t]+' want '+want);queries++;
  }};
 check(10);
 // Finished while a search is in flight: that search's groups unfinished.
 put(70,30,'farm');post(11);markConstructionComplete(farm);markConstructionComplete(spawner);simParallelBackgroundWait(WS_LANE);
 if(A.sready[site()]!==WS_NOT_BUILT||A.pready[spawnerAt()]!==WS_NOT_BUILT)throw Error('a search in flight saw the completion');
 // The next post's: finished.
 const b0=built;post(12);simParallelBackgroundWait(WS_LANE);
 if(built!==b0+1)throw Error('the completion did not make the group again');
 fi=site();pi=spawnerAt();
 if(A.sready[fi]!==0||A.pready[pi]!==0)throw Error('next post publication');
 check(12);
 // Nothing changed: nothing made again, the same arrays.
 const b1=built;post(13);simParallelBackgroundWait(WS_LANE);
 if(built!==b1)throw Error('a post with nothing changed made the group again');
 if(A.tile!==TL||A.sx!==SX||_wsGroupById[gid]!==G)throw Error('group arrays replaced');
 check(13);
 const mc=workerSearchMirrorCheck();if(mc.diff)throw Error('mirror kept != made whole: '+JSON.stringify(mc));
 // A reset (a restore): made whole, the same group.
 const before=JSON.stringify([Array.from(A.tile.subarray(0,G.n)),Array.from(A.sready.subarray(0,G.n)),Array.from(A.pid.subarray(0,G.np))]);
 workerSearchTierReset();post(14);simParallelBackgroundWait(WS_LANE);
 const after=JSON.stringify([Array.from(A.tile.subarray(0,G.n)),Array.from(A.sready.subarray(0,G.n)),Array.from(A.pid.subarray(0,G.np))]);
 if(before!==after)throw Error('reset group differs');
 check(14);
 return {queries,sites:G.n,spawners:G.np,set:mc.set};
})())`));
assert.ok(result.queries>1000);assert.deepEqual(i.errors.map(String),[]);console.log(JSON.stringify({helpers,...result}));
for(const w of require('./real-sim-helper.cjs').instances||[])w.terminate();
