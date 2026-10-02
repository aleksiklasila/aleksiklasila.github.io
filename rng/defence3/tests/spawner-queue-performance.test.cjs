const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'../src/things/barrack.js'),'utf8');
// The ready list and the scheduler (barrack.js: from the ready list's state
// to the Barrack class).
const optimized=source.slice(source.indexOf('let _spawnReady = null;'),source.indexOf('\nclass Barrack'));
// Exhaustive scheduler retained as a behavioral oracle: a spawner is ready
// once its payment gave it an order (no scan assigns orders); the smallest
// order among owners below their cap spawns, a failed spawn ends the tick, a
// paid next front is ready again with a new order, at most 2048 a tick.
const reference=`function processGlobalSpawnerQueue() {
 let guard=0;
 while(guard++<2048) {
  let chosen=null, order=Infinity;
  for(const s of [...barracks,...collectorSpawners]) {
   if(!s || s.energy<=0 || s.underConstruction || !isQueueEnabled(s) || !s.spawnQueue.length) continue;
   if(!Number.isFinite(s._spawnReadyOrder)) continue;
   const f=getQueuedSpawnInfo(s.spawnQueue[0]);
   if(f.energyPaid<f.energyRequired) continue;
   if(!(players[s.owner].popCount<getPlayerPopCap(s.owner))) continue;
   if(s._spawnReadyOrder<order) {order=s._spawnReadyOrder;chosen=s;}
  }
  if(!chosen || !spawnQueuedUnitFromSpawner(chosen)) break;
  const s=chosen;
  if(guard<2048 && s.energy>0 && !s.underConstruction && isQueueEnabled(s) && s.spawnQueue.length) {
   const f=getQueuedSpawnInfo(s.spawnQueue[0]);
   if(f.energyPaid>=f.energyRequired && !Number.isFinite(s._spawnReadyOrder)) s._spawnReadyOrder=globalSpawnerReadyOrderCounter++;
  }
 }
}`;
function make(code, data) {
 return new Function('data',`
 const {buildings,caps,fail}=data, players=caps.map(()=>({popCount:0}));
 const barracks=buildings.slice(0,Math.floor(buildings.length/2)), collectorSpawners=buildings.slice(barracks.length);
 let globalSpawnerReadyOrderCounter=100000, checks=0, events=[];
 const localPlayerId=0, isQueueEnabled=s=>s.enabled, getThingBaseLevel=()=>1, getSpawnerFallbackUnitType=()=> 'norm';
 const getQueuedSpawnInfo=f=>{checks++;return f;}, getPlayerPopCap=owner=>caps[owner];
 const spawnQueuedUnitFromSpawner=s=>{
   if(s.id===fail) return false;
   events.push(s.id); players[s.owner].popCount++; s.spawnQueue.shift(); s._spawnReadyOrder=undefined; return true;
 };
 ${code}
 return {run:processGlobalSpawnerQueue,result:()=>({events,players,buildings,counter:globalSpawnerReadyOrderCounter}),checks:()=>checks};
 `)(structuredClone(data));
}
let seed=73;
const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
// Paid fronts hold distinct orders (as their payments gave them); some
// orders went stale (unpaid again, disabled, emptied).
function fixture(count, uniform=false) {
 const order=Array.from({length:count},(_,i)=>i+1);
 for(let i=count-1;i>0;i--){const j=random(i+1);[order[i],order[j]]=[order[j],order[i]];}
 return {caps:uniform?[10000,10000]:[random(count*2),random(count*2)],fail:uniform?-1:random(count*2),
 buildings:Array.from({length:count},(_,i)=>{
  const spawnQueue=Array.from({length:uniform?1:random(5)},()=>({energyRequired:2,energyPaid:uniform?2:random(5)}));
  const paid=spawnQueue.length>0 && spawnQueue[0].energyPaid>=2;
  return {id:i,owner:i%2,energy:uniform?1:random(4),enabled:uniform||random(8)>0,underConstruction:!uniform&&random(9)===0,
   _spawnReadyOrder:paid||random(4)===0?order[i]:undefined,spawnQueue};
 })};
}
for(let i=0;i<120;i++) {
 const data=fixture(i===119?3000:100,i===119);
 const a=make(optimized,data), b=make(reference,data); a.run(); b.run();
 assert.deepEqual(a.result(),b.result(),'spawn order, queue state and counter must match');
 a.run(); b.run();
 assert.deepEqual(a.result(),b.result(),'remaining queues also match on the next tick');
}
const data=fixture(1000,true), a=make(optimized,data), b=make(reference,data);
a.run(); b.run(); assert.deepEqual(a.result(),b.result());
assert.ok(a.checks()<=3000,'readiness checks '+a.checks()); assert.ok(b.checks()>400000);
console.log(`PASS: 120 scheduler replays; ready orders from payments, full queues, caps, failures and 2048 limit; 1000 ready buildings: ${b.checks()} -> ${a.checks()} readiness checks.`);
if(process.argv.includes('--bench')) {
 const times={baseline:[],optimized:[]};
 for(let i=0;i<7;i++) for(const [key,code] of [['baseline',reference],['optimized',optimized]]) {
  const game=make(code,data), start=performance.now(); game.run(); const elapsed=performance.now()-start;
  if(i>=2) times[key].push(elapsed);
 }
 const avg=a=>a.reduce((s,x)=>s+x,0)/a.length;
 console.log(JSON.stringify({baselineMs:avg(times.baseline),optimizedMs:avg(times.optimized),speedup:avg(times.baseline)/avg(times.optimized)}));
}
