'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const world=new H.World({controls:H.SMALL_MATCH_CONTROLS}),i=world.spawn('source-rows',{simWorker:false});
const r=i.eval(`(()=>{
 startSoloGame();
 for(let k=0;k<120;k++){
  const u=new Unit(['norm','flying','tank','builder_unit'][k%4],k&1,(5+k%20)*TILE,(8+Math.floor(k/20))*TILE);
  configureWorkerUnitFromType(u);applyUnitLevelScaling(u,1+k%7);units.push(u);players[u.owner].popCount++;
 }
 gameTick();spatialIndexRebuild();_visCoverEnsure();
 let checked=0;
 for(const u of units){
  if(!u._us)continue;const c=u._us,s=u._si;
  u.watched=checked%3===0?20:0;u.watchedByTeam=(u.owner+1)%2;
  const active=!u.dead&&u._spatialKey!==undefined;let steps=-1,p1=-1,p2=-1;
  if(active){const range=getEntityEffectiveVisibilityRangeArea(u);if(range>0){steps=Math.min(VIS_COVER_MAX_STEPS,Math.floor(range));
   const owner=Math.floor(Number(u.owner));p1=owner>=0&&owner<_visCover.players?owner:-1;
   if(u.watched>0){const w=Math.floor(Number(u.watchedByTeam));if(w>=0&&w<_visCover.players&&w!==p1)p2=w;}
   if(p1<0&&p2<0)steps=-1;
  }}
  _visCoverSyncUnit(u);
  const expected=[_visCover.gen,steps,p1,p2,active?1:0],actual=[c.vsGen[s],c.vsR[s],c.vsP1[s],c.vsP2[s],c.vsA[s]];
  if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error(JSON.stringify({expected,actual,type:u.unitType}));
  checked++;
 }
 return checked;
})()`);
assert.ok(r>=120);assert.deepEqual(i.errors.map(String),[]);console.log('PASS: shared visibility rows match public-stat reference with multiple owners, levels and watchers.');
