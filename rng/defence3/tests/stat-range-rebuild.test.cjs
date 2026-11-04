'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const w=new H.World({controls:H.SMALL_MATCH_CONTROLS}),i=w.spawn('stat-ranges',{simWorker:false});
const result=i.eval(`(()=>{
 startSoloGame();
 let native=0,checks=0;
 const direct=simRustDirect;
 simRustDirect=function(name,arrays,p){if(name==='k_stat_ranges')native++;return direct(name,arrays,p);};
 for(const layout of ['soa','aos']){
  SIM_THING_STATS_LAYOUT=layout;rebuildPrecomputedStatsMapPlayer();
  for(const branch of ['unit','building'])for(const key of Object.keys(PRECOMPUTED_STATS_MAP[branch])){
   const levels=PRECOMPUTED_STATS_MAP_PLAYER[0][branch][key];
   for(const research of [10,0,4])for(const boost of [4,0]){
    const rs=ensurePlayerResearchLevels(0);
    rs[makeResearchLevelId(branch,key,'attackRange')]=research;
    rs[makeResearchLevelId(branch,key,'visionRange')]=10-research;
    players[0].boosts||={};players[0].boosts[branch+':'+key]=[boost,0];
    // Save complete expected rows independently, then publish both linked fields.
    const expected=[];
    for(let l=0;l<=MAX_THING_LEVEL;l++)expected.push(branch==='unit'?_getUnitPlayerPrecomputedEntryObject(0,key,l):_getBuildingPlayerPrecomputedEntryObject(0,key,l));
    for(const scalar of [false,true]){
     if(scalar)for(let l=0;l<levels.length;l++)levels[l]={...levels[l]};
     const before=levels.slice();
     const untouched=levels.map(e=>({...e}));
     _rebuildPlayerThingStatLevels(0,branch,key,'attackRange');
     for(let l=0;l<=MAX_THING_LEVEL;l++){
      if(levels[l]!==before[l])throw Error('row identity changed');
      for(const f of ['visionOwn','attackRangeArea','attackRange','visionRangeArea','visionRange']){
       if(!Object.is(levels[l][f],expected[l][f]))throw Error([layout,branch,key,research,boost,l,f,levels[l][f],expected[l][f]].join(' '));
       checks++;
      }
      for(const f of Object.keys(untouched[l]))if(!['visionOwn','attackRangeArea','attackRange','visionRangeArea','visionRange','rangeIsWork'].includes(f)){
       if(!Object.is(levels[l][f],untouched[l][f]))throw Error('unrelated stat changed: '+f);
      }
     }
     if(scalar)for(let l=0;l<=MAX_THING_LEVEL;l++)levels[l]=branch==='unit'?_getUnitPlayerPrecomputedEntry(0,key,l):_getBuildingPlayerPrecomputedEntry(0,key,l);
    }
   }
  }
 }
 // A reserved native update must neither create full rows nor grow the heap.
 const oldU=_getUnitPlayerPrecomputedEntryObject,oldB=_getBuildingPlayerPrecomputedEntryObject,heap=simHeapArray;
 _getUnitPlayerPrecomputedEntryObject=_getBuildingPlayerPrecomputedEntryObject=simHeapArray=()=>{throw Error('allocation/full rebuild in reserved update');};
 try{for(let n=0;n<100;n++)_rebuildPlayerThingStatLevels(0,'unit','norm',n%2?'attackRange':'visionRange');}
 finally{_getUnitPlayerPrecomputedEntryObject=oldU;_getBuildingPlayerPrecomputedEntryObject=oldB;simHeapArray=heap;}
 return {native,checks};
})()`);
assert.ok(result.native>100,'native path must run');
assert.deepEqual(i.errors.map(String),[]);
console.log('PASS: linked stat ranges, full-row equivalence, plain fallback, SoA/AoS and reserved storage',result);
