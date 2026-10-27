// Shared stationary descriptors, background reach publication, and exact
// native/legacy query equivalence, including changes after publication.
'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const helpers=Number(process.argv.find(a=>a.startsWith('--helpers='))?.slice(10)||0);
if(helpers)globalThis.self={crossOriginIsolated:true};
const controls={...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'128','cfg-map-type':'arena','cfg-gold-count':'0','cfg-astar-mine-count':'0','cfg-max-pop':'20000','cfg-full-vis':'full'};
const world=new H.World({controls}),i=world.spawn('stationary-brains',{controls,simWorker:false});
if(helpers){i.scratch.Worker=require('./real-sim-helper.cjs');i.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=16;simParallelInit('',${helpers});`);}
const result=JSON.parse(i.eval(`JSON.stringify((()=>{
 startSoloGame();gameTime=100;simDk=20;
 let seed=819;const rnd=()=>{seed=Math.imul(seed,1664525)+1013904223|0;return(seed>>>0)/4294967296;};
 const keys=['pistol','smg','sniper','fire','water','poison','ice','elements','sand_gun','watch_tower'];
 for(let j=0;j<2400;j++){
  const u=new Unit(j%13===0?'king':'norm',j%2,(4+Math.floor(rnd()*120))*TILE+16,(4+Math.floor(rnd()*120))*TILE+16);
  if(u.dead)continue;units.push(u);updateUnitSpatial(u);if(j%7===0)u.wet=10;
 }
 for(let gy=5,j=0;gy<123;gy+=4)for(let gx=5;gx<123;gx+=4,j++)if(placeBuilding(gx,gy,keys[j%keys.length],j%2,{silent:true,ignorePlacementRules:true})){
  const t=getTileEntityRef(gx,gy);markConstructionComplete(t);t._cdUntil=gameTime-1-j%25;structTableRefresh(t);
 }
 recalculateAdjacency(true);spatialIndexRebuild();
 const stats=_stationaryStatsPrepare();
 for(let guard=0;guard<20&&!_stationaryReach.ready;guard++){
  simParallelBackgroundWait(SIM_LANE_BUILD);_stationaryReachStep(stats.maxRange);
 }
 simParallelBackgroundWait(SIM_LANE_BUILD);_stationaryReachStep(stats.maxRange);
 if(!_stationaryReach.ready)throw Error('Stationary reach tier did not publish: '+JSON.stringify({phase:_stationaryReach.phase,meta:_stationaryReach.arrays.meta?.[0],areas:areaNeighborIds.length}));
 let reachChecks=0,queryChecks=0;
 const S=_stationaryReach,D=S.depth+1;
 for(let source=0;source<areaNeighborIds.length;source+=Math.max(1,Math.floor(areaNeighborIds.length/256))){
  if(!_areaById[source])continue;
  for(let d=0;d<D;d++){
   const row=source*(D+1),actual=Array.from(S.arrays.ids.subarray(S.arrays.off[row],S.arrays.off[row+d+1]));
   const expected=getAreaIdsWithinDistance(source,d);
   if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Reach order differs at '+source+'/'+d);
   const box=Array.from(getAreaRangeTileBox([source],d)),b=(source*D+d)*4;
   if(box.some((v,k)=>v!==S.arrays.box[b+k]))throw Error('Reach box differs at '+source+'/'+d);
   reachChecks++;
  }
 }
 const read=()=>{const T=_towerAcq,A=T.arrays,out=new Map();for(let q=0;q<T.list.length;q++){
  if(T.native&&!A.valid[q])continue;
  const u=A.out[q]>=0?_simUnitState.owners[A.out[q]]:null;
  out.set(T.list[q],JSON.stringify([u?.id||-1,A.sout[q],A.idle[q],A.owner[q],A.type[q],A.base[q],A.qx[q],A.qy[q]]));
 }return out;};
 const compare=due=>{
  _towerAcqPrepare(due);if(!_towerAcq.native)throw Error('Native preparation did not activate');
  for(let q=0;q<_towerAcq.list.length;q++)if(_towerAcq.arrays.valid[q]===1){
   const t=_towerAcq.list[q],A=_towerAcq.arrays,st=t.currentStats;
   const late=Math.max(0,Math.min(simDk-1,gameTime-(Math.ceil(t._cdUntil)+1))),N=secondsToTicks(st.cd||1.5),shots=1+Math.floor(late/(N+1));
   if(A.shots[q]!==shots||A.shotCd[q]!==shots*(N+1)-1-late||A.level[q]!==getThingEffectiveLevel(t)||A.damage[q]!==st.damage*shots)throw Error('Adaptive shot proposal differs at '+q);
   const blast=shots>1&&st.blastDamage?st.blastDamage*shots:st.blastDamage;
   if(!Object.is(A.blast[q],blast===undefined?NaN:blast)||!Object.is(A.radius[q],st.blastRadius===undefined?NaN:st.blastRadius))throw Error('Blast proposal differs');
  }
  const actual=read();_towerAcqPrepareLegacy(due);const expected=read();
  if(actual.size!==expected.size)throw Error('Eligibility differs '+actual.size+'/'+expected.size);
  for(const [t,v]of expected){if(actual.get(t)!==v)throw Error('Query differs at '+t.gx+','+t.gy+' '+actual.get(t)+' / '+v);queryChecks++;}
 };
 const due=()=>towers.slice().sort(_towerTileOrder);
 compare(due());
 const t=towers[10];t.owner=1-t.owner;t.level=3;t.preferredTargetSpec={kind:'unit',id:units[0].id};compare(due());
 t.preferredTargetSpec=null;t.level=1;compare(due());
 // A custom override retains exactly the legacy SIMD query arithmetic on
 // both cold and warm tiers, independent of helper completion timing.
 t.currentStats={...t.currentStats,attackRangeArea:2};_towerAcqPrepare(due());
 if(_towerAcq.native)throw Error('Custom query must use the complete legacy batch');
 t.currentStats=null;compare(due());
 const old=towers[20],gx=old.gx,gy=old.gy;destroyBuilding(old);
 placeBuilding(gx,gy,'fire',0,{silent:true,ignorePlacementRules:true});const fresh=getTileEntityRef(gx,gy);markConstructionComplete(fresh);fresh._cdUntil=gameTime-1;structTableRefresh(fresh);
 const changed=due();changed.push(old,changed[0]);changed.sort(_towerTileOrder);compare(changed);
 return{helpers:${helpers},reachChecks,queryChecks,areas:areaNeighborIds.length,depth:S.depth,entries:S.arrays.meta[0],bytes:Object.values(S.arrays).reduce((n,a)=>n+a.byteLength,0)+_ST.brain.byteLength};
})())`));
assert.ok(result.reachChecks>100&&result.queryChecks>3000);
assert.deepEqual(i.errors.map(String),[]);console.log('PASS: stationary shared preparation',JSON.stringify(result));process.exit(0);
