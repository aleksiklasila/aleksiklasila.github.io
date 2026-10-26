const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/things/worker.js'), 'utf8');
const make = new Function(`
let TILE=32, GRID_W=128, GRID_H=128, gameTime=1, CMD_IDLE=0;
let RESOURCE_COLLECTOR_UNIT_KEYS=['collector','astar_collector'], units=[], collectorSpawners=[], _tileEntityVersion=0;
const _resolveMovementProfile=()=>null;
const getResourceTypeByCollectorUnit=t=>RESOURCE_COLLECTOR_UNIT_KEYS.includes(t)?{key:t}:null;
const _thingTickX=t=>t.x, _thingTickY=t=>t.y, _unitTickX=t=>t.x, _unitTickY=t=>t.y;
const simSharedArray=(T,n)=>new T(n), simHeapArrayAuto=(T,n)=>new T(n), simParallelBind=()=>{};
const navPathTo=(u,x,y)=>[{x,y,nav:1,ready:0}];
${source}
return { units, spawners:collectorSpawners, set:_setWorkerTarget, clear:_clearWorkerTarget,
 conflict:_findConflictingWorkerOnTargetTile, tile:_getWorkerTargetTileIndex, reset:_invalidateWorkerTargetLoadCache,
 closest:_findClosestSpawner, near:(list,x,y)=>_spawnerNearOf(_spawnerScanTable(list),y*GRID_W+x,x,y,list),
 release:_releaseManualWorkerAssignmentConflicts,
 route:u=>_findBestSpawnerRoute(u,'spawner',()=>true,{cacheOnly:true}), tick:()=>gameTime++, version:()=>_tileEntityVersion++ };
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
// Cache misses at dense/sparse bucket edges must retain all four exact
// candidates, including ties and duplicate coordinates with different ids.
let seed=731;
const rnd=()=>{seed=Math.imul(seed,1664525)+1013904223|0;return (seed>>>0)/4294967296;};
for(const sparse of [false,true]){
 const list=Array.from({length:1500},(_,i)=>({id:1500-i,gx:sparse?100+(i%3):Math.floor(rnd()*128),gy:sparse?100+((i/3|0)%3):Math.floor(rnd()*128)}));
 for(let q=0;q<300;q++){
  const x=q<4?[0,15,16,127][q]:Math.floor(rnd()*128),y=q<4?[127,16,15,0][q]:Math.floor(rnd()*128);
  const want=list.map((s,i)=>({s,i,d:Math.abs(s.gx-x)+Math.abs(s.gy-y)})).sort((a,b)=>a.d-b.d||a.s.gy-b.s.gy||a.s.gx-b.s.gx||a.s.id-b.s.id).slice(0,4).map(e=>e.i);
  assert.deepEqual(Array.from(w.near(list,x,y)),want);
 }
}
// Manual reassignment releases every conflict, including a patient that
// moved since indexing and a worker present in both stale and live buckets.
const release=make(),site={gx:20,gy:20,x:640,y:640},patient2={x:960,y:960};
const assigning={id:10,owner:0,workerType:'healer',workerState:'IDLE'};
release.units.push(assigning);
for(let i=0;i<8;i++)release.units.push({id:20+i,owner:i===6?1:0,workerType:i===7?'builder':'healer',workerState:'MOVING_TO_HEAL',commandState:1});
for(let i=1;i<release.units.length;i++)assert.ok(release.set(release.units[i],{gx:i,gy:1,x:i*32,y:32},'unit'));
const a=release.units[1],b=release.units[2],c=release.units[3];
release.clear(a);release.set(a,site,'queue');
release.clear(b);release.set(b,patient2,'unit');
release.clear(c);release.set(c,{gx:21,gy:20,x:21*32,y:20*32},'queue');
patient2.x=21*32;patient2.y=20*32;
const target={gx:21,gy:20,x:21*32,y:20*32};
release.release(assigning,target,'queue');
assert.equal(a.workerTarget,site);
assert.equal(b.workerTarget,null);assert.equal(c.workerTarget,null);
for(const u of [b,c]){assert.equal(u.workerState,'IDLE');assert.equal(u.commandState,0);}
console.log('PASS: nearest four match exhaustive sorts across 600 dense/sparse edge queries; manual conflict release checks moving targets live.');
// Optional subsystem timing; assertions never depend on wall-clock thresholds.
if(process.argv.includes('--bench')) {
 const queries=Array.from({length:3000},(_,i)=>targets[i%targets.length]);
 const run=fn=>{const start=performance.now(); for(let n=0;n<20;n++) for(const t of queries) fn(seeker,t); return performance.now()-start;};
 run(w.conflict); run(reference);
 const indexed=run(w.conflict), exhaustive=run(reference);
 console.log(JSON.stringify({queries:60000,indexedMs:indexed,exhaustiveMs:exhaustive,speedup:exhaustive/indexed}));
}
