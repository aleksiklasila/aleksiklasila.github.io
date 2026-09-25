const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/things/worker.js'), 'utf8');
const make = new Function(`
let TILE=32, GRID_W=128, GRID_H=128, gameTime=1, CMD_IDLE=0;
let RESOURCE_COLLECTOR_UNIT_KEYS=['collector','astar_collector'], units=[], collectorSpawners=[], _tileEntityVersion=0;
const _resolveMovementProfile=()=>null;
${source}
return { units, spawners:collectorSpawners, set:_setWorkerTarget, clear:_clearWorkerTarget,
 conflict:_findConflictingWorkerOnTargetTile, tile:_getWorkerTargetTileIndex, reset:_invalidateWorkerTargetLoadCache,
 closest:_findClosestSpawner, route:u=>_findBestSpawnerRoute(u,'spawner',()=>true,{cacheOnly:true}), tick:()=>gameTime++, version:()=>_tileEntityVersion++ };
`);
const w=make();
const targets=Array.from({length:500},(_,i)=>({gx:i%100,gy:Math.floor(i/100),x:i%100*32,y:Math.floor(i/100)*32}));
for(let i=0;i<3000;i++) w.units.push({id:i+1, owner:i%2, workerType:['builder','healer','researcher'][i%3],
 workerState:'IDLE',workerTarget:targets[i%500],workerTargetType:null});
const seeker={id:4000,owner:0,workerType:'builder'};
const reference=(unit,target)=>w.units.find(o=>o!==unit && !o.dead && o.workerTarget && o.owner===unit.owner && o.workerType===unit.workerType && w.tile(o.workerTarget)===w.tile(target)) || null;
function compare() {
 for(let i=0;i<100;i++) {
  seeker.owner=i%2; seeker.workerType=['builder','healer','researcher'][i%3];
  assert.equal(w.conflict(seeker,targets[i*5]),reference(seeker,targets[i*5]));
 }
}
compare();
// Real setters extend the index within the tick; release and death are live.
for(let i=0;i<80;i++) {
 const u=w.units[i]; w.clear(u); w.set(u,targets[(i*19)%500]);
 w.units[100+i].dead=true;
}
compare();
// Moving targets have no fixed tile: healers must see their new tile immediately.
const patient={x:32,y:32};
const healer=w.units.find(u=>u.workerType==='healer');
w.clear(healer); w.set(healer,patient,'unit');
seeker.owner=healer.owner; seeker.workerType='healer';
for(let i=0;i<50;i++) {
 patient.x=(i+50)*32; patient.y=60*32;
 assert.equal(w.conflict(seeker,patient),reference(seeker,patient));
}
healer.dead=true;
assert.equal(w.conflict(seeker,patient),null);
w.tick(); compare(); w.reset(); compare();
// Type index preserves Manhattan distance and row/column ties. Eligibility is
// deliberately changed after the first query, without advancing the tick.
for(let i=0;i<1000;i++) w.spawners.push({type:['spawner','builder_spawner','healer_spawner','research'][i%4],
 owner:i%2,gx:i%80,gy:Math.floor(i/80),energy:100,underConstruction:false});
const closest=(u,type)=>w.spawners.filter(s=>s.type===type && s.owner===u.owner && s.energy>0 && !s.underConstruction)
 .sort((a,b)=>(Math.abs(a.gx-Math.floor(u.x/32))+Math.abs(a.gy-Math.floor(u.y/32)))-(Math.abs(b.gx-Math.floor(u.x/32))+Math.abs(b.gy-Math.floor(u.y/32))) || a.gy-b.gy || a.gx-b.gx)[0] || null;
for(let i=0;i<100;i++) {
 const u={owner:i%2,x:i*19,y:i*17}; const type=['spawner','builder_spawner','healer_spawner','research'][i%4];
 assert.equal(w.closest(u,type),closest(u,type));
 w.spawners[i].energy=0; w.spawners[200+i].underConstruction=true;
}
w.spawners.push({type:'spawner',owner:0,gx:0,gy:0,energy:1});
assert.equal(w.closest({owner:0,x:0,y:0},'spawner'),closest({owner:0,x:0,y:0},'spawner'));
// Route ties include id, unlike the simpler closest-spawner helper. Removing
// the per-request sort must still pick the same (distance, y, x, id) minimum.
w.spawners.push({id:9,type:'spawner',owner:0,gx:110,gy:110,energy:1});
w.spawners.push({id:2,type:'spawner',owner:0,gx:110,gy:110,energy:1});
assert.equal(w.route({owner:0,x:110*32,y:110*32}).spawner.id,2);
// Replacement without a length change is invalidated by tile-entity version.
w.spawners[w.spawners.length-1]={id:1,type:'spawner',owner:0,gx:110,gy:110,energy:1}; w.version();
assert.equal(w.route({owner:0,x:110*32,y:110*32}).spawner.id,1);
console.log('PASS: 3000-worker occupancy agrees with exhaustive scans; assignment, release, death, mobile targets, tick/reset and live spawner eligibility.');
// Optional subsystem timing; assertions never depend on wall-clock thresholds.
if(process.argv.includes('--bench')) {
 const queries=Array.from({length:3000},(_,i)=>targets[i%targets.length]);
 const run=fn=>{const start=performance.now(); for(let n=0;n<20;n++) for(const t of queries) fn(seeker,t); return performance.now()-start;};
 run(w.conflict); run(reference);
 const indexed=run(w.conflict), exhaustive=run(reference);
 console.log(JSON.stringify({queries:60000,indexedMs:indexed,exhaustiveMs:exhaustive,speedup:exhaustive/indexed}));
}
