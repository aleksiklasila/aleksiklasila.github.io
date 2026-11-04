'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const world=new H.World({controls:H.SMALL_MATCH_CONTROLS}),inst=world.spawn('spawner-reuse',{simWorker:false});
const result=inst.eval(`(()=>{
 startSoloGame();
 const a={type:'research',gx:2,gy:2},b={type:'research',gx:20,gy:20};
 structListsSetView([[],[],[a]]);collectorSpawnersVersion++;_workerSpawnerIndex=null;
 const first=_getWorkerSpawnersByType('research'),old=_structureBuckets(first);
 structListsSetView([[],[],[b]]);collectorSpawnersVersion++;
 const next=_getWorkerSpawnersByType('research'),fresh=_structureBuckets(next);
 if(first!==next||next.length!==1||next[0]!==b||fresh===old)throw Error('replacement/cache invalidation');
 structListsSetView([[],[],[]]);collectorSpawnersVersion++;
 if(_getWorkerSpawnersByType('research').length)throw Error('stale removed spawner');
 structListsSetView([[],[],[a,b]]);collectorSpawnersVersion++;
 const grown=_getWorkerSpawnersByType('research');
 if(grown!==first||grown[0]!==a||grown[1]!==b)throw Error('growth/order');
 resetSimulationTickCaches();
 if(_getWorkerSpawnersByType('research')===first)throw Error('restore retained cache');
 return true;
})()`);
assert.equal(result,true);assert.deepEqual(inst.errors.map(String),[]);
console.log('PASS: spawner list replacement, shrink, growth, ordering and reset');

