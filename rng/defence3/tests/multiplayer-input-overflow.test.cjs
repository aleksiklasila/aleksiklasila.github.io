// Legitimate local bursts must survive the host's per-packet flood limit.
'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
(async()=>{
 const world=new H.World({controls:H.SMALL_MATCH_CONTROLS,network:{latencyMs:60,jitterMs:100,lossRate:.03},exactHashes:true,hashEvery:1});
 const {host,guests}=await H.startHostedMatch(world,{guests:2,teams:[0,1,0]});
 const all=[host,...guests],from=host.eval('currentTick');
 for(const i of all)i.evalSim(`__scratch.applied=[];{const f=processAction;processAction=function(a,p){if(a.netId)__scratch.applied.push(a.netId);return f.apply(this,arguments);};}`);
 const ids=[];
 for(const i of all){
  const before=new Set(world.issued.keys());
  const sizes=i.eval(`(()=>{for(let j=0;j<LOCKSTEP_MAX_ACTIONS_PER_PACKET*2+1;j++)queueAction({action:'shrineDrain',drain:j&3});return Object.values(localInputBuffer).map(a=>a.length);})()`);
  assert.ok(sizes.every(n=>n<=256),'local packets stay within the flood limit');
  ids.push(...[...world.issued.keys()].filter(id=>!before.has(id)));
  // Match-reload requeues preserve the original ids and use the same limit.
  i.eval(`for(let j=0;j<257;j++)requeueLocalAction({action:'shrineDrain',drain:j&3,teamId:localPlayerId,netId:myPeerId+':requeued:'+j});`);
  ids.push(...i.eval(`Array.from({length:257},(_,j)=>myPeerId+':requeued:'+j)`));
 }
 assert.equal(ids.length,3*(513+257));
 assert.ok(await world.runUntil(()=>all.every(i=>ids.every(id=>i.executedActions.has(id))),30000,20),'all original and requeued commands delivered to every peer');
 assert.ok(await world.runUntil(()=>all.every(i=>i.evalSim('_actionBacklog.length===0')),30000,20),'simulation action backlogs drained');
 await world.run(1000);
 for(const i of all){
  const applied=i.evalSim('__scratch.applied'),counts=new Map();for(const id of applied)counts.set(id,(counts.get(id)||0)+1);
  for(const id of ids)assert.equal(counts.get(id),1,i.name+' applies '+id+' exactly once');
  assert.equal(i.eval('netCounters.desyncsDetected'),0);assert.equal(i.patchesApplied,0);
 }
 H.checkHealthy(world,all,{fromTick:from,minCompared:20});
 assert.equal(world.compareHashes(all,from,'tickExact').mismatches.length,0);
 console.log('PASS: 2310 original/requeued commands across three peers, packet cap respected, applied once without repair');
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
