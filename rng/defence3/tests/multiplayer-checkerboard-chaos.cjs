// Extreme mixed checkerboard through the real hosted-match command transport.
// node --max-old-space-size=8192 tests/multiplayer-checkerboard-chaos.cjs --units=50000 --map=384 --structures=20000 --ticks=240 --dk=20
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const num=(k,v)=>Number(process.argv.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??v);
const count=num('units',12000),map=num('map',192),structures=num('structures',5000),ticks=num('ticks',160),dk=num('dk',4);
const seed=num('seed',777),mapType=process.argv.find(a=>a.startsWith('--map-type='))?.slice(11)||'arena';
const networkName=process.argv.find(a=>a.startsWith('--network='))?.slice(10)||'wan';
const network={wan:{latencyMs:60,jitterMs:35},unstable:{latencyMs:80,jitterMs:150,lossRate:.03,spikeEveryMs:7000,spikeMs:600},slow:{latencyMs:400,jitterMs:120,lossRate:.01}}[networkName];
assert.ok(network,'known network profile');
const helperCounts=(process.argv.find(a=>a.startsWith('--helpers='))?.slice(10)||'7,0,3').split(',').map(Number);
const teams=(process.argv.find(a=>a.startsWith('--teams='))?.slice(8)||helperCounts.map((_,i)=>i&1).join(',')).split(',').map(Number);
const teamCount=new Set(teams).size;
assert.equal(teams.length,helperCounts.length,'one team per peer');
assert.ok(teamCount>=2&&teams.every(t=>Number.isInteger(t)&&t>=0&&t<teamCount),'contiguous teams starting at zero');
const legacyCollisions=process.argv.includes('--legacy-collisions');
const out=path.resolve(process.argv.find(a=>a.startsWith('--out='))?.slice(6)||'tests/test-runs/multiplayer-checkerboard/latest.json');
if(process.argv.includes('--trace')){process.env.DIVTRACE='2';process.env.DIVTRACE_TICKS='4';process.env.DIVTRACE_FROM=String(num('trace-from',0));}
globalThis.self={crossOriginIsolated:true};
const H=require('./net-harness.cjs'),chaos=require('./chaos-spikes-scenario.cjs');
const data=JSON.parse(fs.readFileSync(path.join(__dirname,'chaos-mega-1000.json')));
const spawnCounts=data.startingResources.spawnCounts;
const workerKeys=new Set(['collector','astar_collector','builder_unit','salvager_unit','healer_unit','researcher_unit'].map(k=>'unit:'+k));
const combat=Object.entries(spawnCounts).filter(([k])=>k.startsWith('unit:')&&k!=='unit:king'&&!workerKeys.has(k));
const totalCombat=combat.reduce((n,[,levels])=>n+Object.values(levels).reduce((a,b)=>a+b,0),0);
const workers=Math.max(30,Math.floor(count*.25/(teamCount*6))),perTeam=Math.floor(count/teamCount)-workers*6-1;
for(const k of Object.keys(spawnCounts)) {
 if(k==='unit:king')spawnCounts[k]={1:1};
 else if(workerKeys.has(k))spawnCounts[k]={10:workers};
 else if(k.startsWith('unit:'))spawnCounts[k]={10:Math.max(1,Math.round(Object.values(spawnCounts[k]).reduce((a,b)=>a+b,0)*perTeam/totalCombat))};
 else spawnCounts[k]={10:k==='building:house'?20:1};
}
const controls={...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':String(map),'cfg-map-type':mapType,'cfg-gold-count':String(Math.floor(map*1.5)),
 'cfg-astar-mine-count':String(map),'cfg-max-pop':String(count*4),'cfg-full-vis':'full','cfg-starting-energy':'1000000000000','cfg-starting-astar':'1000000000000'};
const options={mode:'mega',layout:'mixed',teams:teamCount,seed,buildings:Math.max(30,Math.floor(map/3)),level:6,towerSites:Math.floor(map/4),collectorBuildings:Math.floor(map/6),structures,keepKings:true};
const metrics=`__scratch.stressWork={spawns:0,armySpawns:0,researchDeposits:0,collectorDeposits:0,astarDeposits:0,constructionCompleted:0,destroyedStructures:0,placed:0,healerDeliveries:0,salvagerReturns:0,contestedPlacements:0};{
 __scratch.actionKinds={};const action=processAction;processAction=function(a,p){if(a?.netId)__scratch.actionKinds[a.action]=(__scratch.actionKinds[a.action]||0)+1;return action.apply(this,arguments);};
 const spawn=spawnQueuedUnitFromSpawner,research=_researcherDeposit,deposit=_depositResourceCollectorPayload,complete=markConstructionComplete,destroy=destroyBuilding,place=placeBuilding;
 spawnQueuedUnitFromSpawner=function(s){const r=spawn.apply(this,arguments);if(r){__scratch.stressWork.spawns++;if(s.type==='barrack')__scratch.stressWork.armySpawns++;}return r;};
 _researcherDeposit=function(){const r=research.apply(this,arguments);if(r)__scratch.stressWork.researchDeposits++;return r;};
 _depositResourceCollectorPayload=function(u,o,c){if(u.carryingValue>0&&c)__scratch.stressWork[c.stockpileKey==='astar'?'astarDeposits':'collectorDeposits']++;return deposit.apply(this,arguments);};
 markConstructionComplete=function(t){if(t.underConstruction)__scratch.stressWork.constructionCompleted++;return complete.apply(this,arguments);};
 destroyBuilding=function(){__scratch.stressWork.destroyedStructures++;return destroy.apply(this,arguments);};
 const attempts=new Map();placeBuilding=function(gx,gy,key,owner){const k=gameTime+':'+gx+':'+gy;if(attempts.has(k))__scratch.stressWork.contestedPlacements++;attempts.set(k,owner);if(attempts.size>4096)attempts.clear();const r=place.apply(this,arguments);if(r)__scratch.stressWork.placed++;return r;};
 const ai=updateWorkerAI;updateWorkerAI=function(u){const role=u.workerType,material=u.healerHasMaterial,cooldown=u.workerTransferCooldown,carry=u.carryingValue;
  const r=ai.apply(this,arguments);if(role==='healer'&&material&&!u.healerHasMaterial&&u.workerTransferCooldown>cooldown)__scratch.stressWork.healerDeliveries++;
  if(role==='salvager'&&!carry&&u.carryingValue>0)__scratch.stressWork.salvagerReturns++;return r;};
}__scratch.stressMines=[...goldMines.map(m=>[m,'gold']),...astarMines.map(m=>[m,'astar'])];`;
const rows=[],bursts=[];let recovery=null,cleanComparisons=0,initialSnapshots=[];
let world,all,start;
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out+'.jsonl','');
const state=i=>i.eval(`(()=>{const roles={};for(const u of units)if(u.workerType){const r=roles[u.workerType]||(roles[u.workerType]={count:0,assigned:0,carrying:0});r.count++;if(u.workerTarget)r.assigned++;if(u.carryingValue||u.builderHasMaterial||u.healerHasMaterial)r.carrying++;}
 return {name:${JSON.stringify(i.name)},tick:currentTick,units:units.length,work:{...__scratch.stressWork},actionKinds:{...__scratch.actionKinds},roles,depletedMines:__scratch.stressMines?.filter(([m,key])=>m[key]<=0).length,desyncs:netCounters.desyncsDetected,patches:${i.patchesApplied},snapshots:${i.snapshotsApplied},heap:simHeapStats(),occupancy:occupancyAudit(),gameOver};})()`);
function persist(status,error){fs.writeFileSync(out,JSON.stringify({status,error:String(error?.stack||error||''),count,map,mapType,networkName,structures,ticks,dk,helperCounts,teams,legacyCollisions,options,cleanComparisons,recovery,bursts,rows,states:all?.map(state),hashes:all?.map(i=>({name:i.name,fast:[...i.tickHashes],exact:[...i.tickExact],parts:[...i.tickParts]}))},null,2));
 if(error&&process.argv.includes('--trace'))fs.writeFileSync(out+'.trace.json.gz',require('node:zlib').gzipSync(JSON.stringify(all.map(i=>({name:i.name,trace:[...(i.scratch.div||[])]}))),{level:1}));}
function check(){
 for(const i of all)assert.deepEqual(i.errors.map(e=>String(e.stack||e)),[],i.name+' threw');
 for(const field of ['tickHashes','tickExact']){
  const cmp=world.compareHashes(all,start,field);
  if(cmp.mismatches.length){const m=cmp.mismatches[0];const a=all.find(i=>i.name===m.a),b=all.find(i=>i.name===m.b),pa=a.tickParts.get(m.tick)||{},pb=b.tickParts.get(m.tick)||{};
   throw Error(field+' mismatch '+JSON.stringify({...m,parts:Object.keys(pa).filter(k=>pa[k]!==pb[k]),detail:H.divergenceReport(a,b,start)}));}
 }
 for(const [j,i] of all.entries()){assert.equal(i.eval('netCounters.desyncsDetected'),0,i.name+' detected a desync');assert.equal(i.patchesApplied,0,i.name+' repaired state');assert.equal(i.snapshotsApplied,initialSnapshots[j],i.name+' reloaded state');}
}
(async()=>{
 world=new H.World({controls,network,hashEvery:1,recordParts:true,exactHashes:true});
 const match=await H.startHostedMatch(world,{guests:helperCounts.length-1,teams,maxMs:90000,
  hostSetup:`MAX_THING_LEVEL=20;MAX_RESEARCH_LEVEL=10;startingResourcesConfig=normalizeStartingResourcesConfig(${JSON.stringify({spawnCounts,researchLevels:{}})});`});
 all=[match.host,...match.guests];
 initialSnapshots=all.map(i=>i.snapshotsApplied);
 for(let j=0;j<all.length;j++){
  const i=all[j];if(helperCounts[j]){i.scratch.Worker=require('./real-sim-helper.cjs');i.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=32;simParallelInit('',${helperCounts[j]});`);}
 }
 const at=world.atNextSafeTick(`netStepTicks=()=>${dk};__scratch.stressSetup=${chaos.setup(options)};${metrics}
  for(let j=0;j<goldMines.length;j+=3)goldMines[j].gold=Math.min(goldMines[j].gold,20+(j%7)*10);
  for(let j=0;j<astarMines.length;j+=3)astarMines[j].astar=Math.min(astarMines[j].astar,20+(j%7)*10);`,4);
 assert.ok(await world.runUntil(()=>all.every(i=>i.eval('currentTick')>at+2),90000,20),'bulk scene setup completed');
 for(const i of all){assert.deepEqual(i.scratch.stressSetup.errors,[]);for(const role of ['collector','astar_collector','builder','salvager','healer','researcher']){
  assert.ok(i.scratch.stressSetup.jobs[role]>0,role+' jobs');
  for(let p=0;p<teamCount;p++)assert.ok(i.scratch.stressSetup.jobsByTeam[p][role]>0,'team '+p+' '+role+' jobs');
 }}
 start=at;check();
 console.log('Setup',JSON.stringify({peers:all.map((i,j)=>[i.name,helperCounts[j]]),...all[0].scratch.stressSetup,upgradeAreas:undefined}));
 const end=Math.min(...all.map(i=>i.eval('currentTick')))+ticks;
 let round=0,nextBurst=0,lastLog=-1;
 while(Math.min(...all.map(i=>i.eval('currentTick')))<end){
  const current=Math.min(...all.map(i=>i.eval('currentTick')));
  if(current>=nextBurst){
   const T=Math.max(...all.map(i=>i.eval('Math.max(currentTick+24,lockstepHighestSentLocalTick+3)')));
   const shared=all[0].eval(`(()=>{const tiles=[],cx=GRID_W>>1,cy=GRID_H>>1;for(let r=0;r<GRID_W&&tiles.length<10;r++)for(let dy=-r;dy<=r&&tiles.length<10;dy++)for(let dx=-r;dx<=r&&tiles.length<10;dx++){
    if(Math.max(Math.abs(dx),Math.abs(dy))!==r)continue;const gx=cx+dx,gy=cy+dy;if(gx<2||gy<2||gx>=GRID_W-2||gy>=GRID_H-2)continue;
    if(grid[gy][gx].type===TYPE_FLOOR&&!getTileEntityRef(gx,gy)&&!grid[gy][gx].item&&!getGoldMineAt(gx,gy)&&!getAstarMineAt(gx,gy))tiles.push({gx,gy});}
    const point=m=>m&&({gx:m.gx,gy:m.gy});const near=(list,key)=>{let best=null,d=Infinity;for(const m of list)if(m[key]>0){const q=Math.abs(m.gx-cx)+Math.abs(m.gy-cy);if(q<d){d=q;best=m;}}return point(best);};return{tiles,gold:${legacyCollisions?"point(goldMines.find(m=>m.gold>0))":"near(goldMines,'gold')"},astar:${legacyCollisions?"point(astarMines.find(m=>m.astar>0))":"near(astarMines,'astar')"}};})()`);
   const issued=[];
   for(let j=0;j<all.length;j++){const i=all[j];
    const actions=i.eval(`(()=>{const old=queueAction,a=[];queueAction=x=>a.push(x);try{${chaos.burst(options,legacyCollisions?round:round*all.length+j)}}finally{queueAction=old;}return (${chaos.conflicts(legacyCollisions?options:{...options,clientVariant:j},round,shared)}).concat(a);})()`);
    // queueAt deliberately bypasses the input queue. Respect the transport's
    // flood limit here too, retaining overflow rather than silently losing it.
    const cap=i.eval('LOCKSTEP_MAX_ACTIONS_PER_PACKET'),kinds={};let lastTick=T;
    for(let n=0;n<actions.length;n++){const a=actions[n];lastTick=T+Math.floor(n/cap);i.queueAt(lastTick,a);kinds[a.action]=(kinds[a.action]||0)+1;}
    issued.push({peer:i.name,actions:actions.length,kinds,lastTick});
   }
   bursts.push({round,tick:T,shared,issued});round++;nextBurst=current+12;
  }
  await world.run(100,10);check();
  const common=Math.min(...all.map(i=>i.eval('currentTick')));
  if(Math.floor((common-at)/20)>lastLog){lastLog=Math.floor((common-at)/20);const r={tick:common,states:all.map(state)};rows.push(r);fs.appendFileSync(out+'.jsonl',JSON.stringify(r)+'\n');console.log('tick',common,'units',r.states.map(s=>s.units).join('/'),'work',JSON.stringify(r.states[0].work));}
  assert.ok(world.now<600000,'match continued advancing');
 }
 // Drain the scheduled collision bursts before checking command delivery.
 const last=Math.max(...bursts.flatMap(b=>b.issued.map(i=>i.lastTick)));
 assert.ok(await world.runUntil(()=>all.every(i=>i.eval('currentTick')>last+3&&i.eval('_actionBacklog.length===0')),60000,20),'last collision burst and action backlog executed');check();
 for(const [netId]of world.issued)for(const i of all)assert.ok(i.executedActions.has(netId),i.name+' missed '+netId);
 // Resignation and host administration end play; their dedicated transport
 // suites exercise those lifecycle actions separately from this live battle.
 const gameplay=['place','move','attackMove','attack','attackBuilding','stop','hold','queueUnit','queueWorker','queueResearch','workerAssign','setRally','setRallyMany','dequeueUnit','dequeueWorker','dequeueResearch','reorderResearch','moveResearch','markSalvage','setSalvage','setAutoUpgrade','setAutoStack','setBuildEnabled','setQueueEnabled','setAutoResearch','setBoost','shrineDrain','killUnit','resizeUnitGroup','towerTarget'];
 for(const i of all){const kinds=i.eval('__scratch.actionKinds');for(const kind of gameplay)assert.ok(kinds[kind]>0,i.name+' applied gameplay action '+kind);}
 for(const i of all){const s=state(i);assert.ok(s.occupancy.ok,i.name+' collision occupancy');assert.equal(s.gameOver,false);for(const k of ['spawns','collectorDeposits','astarDeposits','researchDeposits','constructionCompleted','destroyedStructures','placed','healerDeliveries','salvagerReturns','contestedPlacements'])assert.ok(s.work[k]>0,i.name+' exercised '+k);}
 cleanComparisons=world.compareHashes(all,start,'tickExact').compared;
 if(process.argv.includes('--recover')){
  const guest=all[1],before=all.map(i=>({patches:i.patchesApplied,snapshots:i.snapshotsApplied})),began=world.now;
  const id=guest.eval(`(()=>{const u=units.find(u=>!u.dead&&!u.isKing&&u.energy>300);u.energy-=123;return u.id;})()`);
  assert.ok(await world.runUntil(()=>guest.patchesApplied>before[1].patches&&all.every(i=>i.eval('isHost ? resyncHostPending.size===0 : resyncGuest.T<0&&!resyncGuest.outstanding')),120000,20),'large-scene guest repair completed');
  const from=Math.max(...all.map(i=>i.eval('currentTick')))+4;
  const repairs=all.map(i=>i.patchesApplied);
  assert.ok(await world.runUntil(()=>all.every(i=>i.eval('currentTick')>from+64),120000,20),'continued after repair');
  for(const field of ['tickHashes','tickExact'])assert.equal(world.compareHashes(all,from,field).mismatches.length,0,'repaired checkerboard stays in sync: '+field);
  for(let j=0;j<all.length;j++){
   assert.equal(all[j].patchesApplied,repairs[j],'repair did not repeat');
   assert.equal(all[j].snapshotsApplied,before[j].snapshots,'no match-wide snapshot');
   assert.ok(state(all[j]).occupancy.ok,'repaired occupancy remains exclusive');
   assert.deepEqual(all[j].errors.map(String),[]);
  }
  assert.equal(guest.patchesApplied,before[1].patches+1,'only one patch required');
  for(let j=0;j<all.length;j++)if(j!==1)assert.equal(all[j].patchesApplied,before[j].patches,'other peers kept playing');
  recovery={id,from,virtualMs:world.now-began,exactComparisons:world.compareHashes(all,from,'tickExact').compared};
  console.log('PASS: large-scene repair',JSON.stringify(recovery));
 }
 persist('passed');console.log('PASS: mixed checkerboard multiplayer,',cleanComparisons,'clean exact peer/tick comparisons,',bursts.length,'same-tick collision bursts, all 30 gameplay actions,',recovery?'one intentional repair':'no repair');
})().catch(e=>{try{persist('failed',e);}catch{}console.error(e);process.exitCode=1;}).finally(()=>{for(const w of require('./real-sim-helper.cjs').instances||[])w.terminate();});
