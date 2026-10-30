'use strict';
// Units' sight keys in the visibility cover's snapshot (k.rs k_vis_snap, from
// the shared stat rows, owners and watches) match the public-stat reference
// (getEntityEffectiveVisibilityRangeArea) with several owners, levels and
// watchers.
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const world=new H.World({controls:H.SMALL_MATCH_CONTROLS}),i=world.spawn('source-rows',{simWorker:false});
const r=i.eval(`(()=>{
 startSoloGame();
 for(let k=0;k<120;k++){
  const u=new Unit(['norm','flying','tank','builder_unit'][k%4],k&1,(5+k%20)*TILE,(8+Math.floor(k/20))*TILE);
  configureWorkerUnitFromType(u);applyUnitLevelScaling(u,1+k%7);units.push(u);players[u.owner].popCount++;
 }
 gameTick();spatialIndexRebuild();_visCoverEnsure();
 let n=0;
 for(const u of units){ if(!u._us)continue; u.watched=n%3===0?20:0;u.watchedByTeam=(u.owner+1)%2; n++; }
 // The snapshot as the cover's post makes it.
 const S=_simUnitState,C=_visCover,P=_simParams,ns=S.owners.length;
 if(!C.vtp||C.vtp.length<ns){C.vtp=simSharedArray(Int32Array,simReserveCap(ns));C.vtkey=simSharedArray(Int32Array,simReserveCap(ns));simParallelBind('vt.p',C.vtp);simParallelBind('vt.key',C.vtkey);}
 simParallelBind('eff.rVsA',_effRowCols.rVsA);
 P[0]=ns;P[1]=8192;P[2]=C.players;P[3]=SIM_SEP_ABSENT;P[4]=TILE;P[5]=GRID_W;P[6]=GRID_H;
 simParallelRun(SIM_KERNEL_VIS_SNAP,Math.ceil(ns/8192));
 let checked=0;
 for(const u of units){
  if(!u._us)continue;const s=u._si;
  const active=!u.dead&&u._spatialKey!==undefined;let steps=-1,p1=-1,p2=-1;
  // (Whole area steps: 0 is its own area, every unit sees.)
  if(active){const range=getEntityEffectiveVisibilityRangeArea(u);if(range>=0){steps=Math.min(VIS_COVER_MAX_STEPS,Math.floor(range));
   const owner=Math.floor(Number(u.owner));p1=owner>=0&&owner<C.players?owner:-1;
   if(u.watched>0){const w=Math.floor(Number(u.watchedByTeam));if(w>=0&&w<C.players&&w!==p1)p2=w;}
   if(p1<0&&p2<0)steps=-1;
  }}
  const expected=steps<0?-1:((steps&63)|((p1+1)<<8)|((p2+1)<<16)),actual=C.vtkey[s];
  if(expected!==actual)throw Error(JSON.stringify({expected,actual,steps,p1,p2,type:u.unitType}));
  checked++;
 }
 return checked;
})()`);
assert.ok(r>=120);assert.deepEqual(i.errors.map(String),[]);console.log('PASS: snapshot sight keys match the public-stat reference with multiple owners, levels and watchers.');
