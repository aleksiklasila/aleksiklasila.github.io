// Serial, real simulation with mixed combat/economy and repeatable command bursts.
// node --max-old-space-size=8192 tests/chaos-spikes.bench.cjs --units=1000000 --ticks=240 --kernels --system-metrics --out=tests/test-runs/chaos-spikes/latest.json
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {performance,PerformanceObserver}=require('node:perf_hooks');
(async()=>{
const num=(key,value)=>Number(process.argv.find(a=>a.startsWith('--'+key+'='))?.split('=')[1]??value);
const count=num('units',1000000),ticks=num('ticks',240),helpers=num('helpers',11),dk=num('dk',20),burstEvery=num('burst-every',10);
const warmup=num('warmup',Math.min(20,ticks-1));
const profileStartStep=num('profile-start',warmup);
const metrics=process.argv.includes('--system-metrics');
const timeline=process.argv.includes('--timeline');
const yieldBetween=!process.argv.includes('--no-yield');
const gcEntries=[],gcObserver=metrics?new PerformanceObserver(list=>gcEntries.push(...list.getEntries().map(e=>({at:e.startTime,ms:e.duration,kind:e.detail.kind})))):null;
if(gcObserver)gcObserver.observe({entryTypes:['gc']});
const out=path.resolve(process.argv.find(a=>a.startsWith('--out='))?.slice(6)||'tests/test-runs/chaos-spikes/latest.json');
for(const n of [count,ticks,dk,burstEvery])assert.ok(Number.isInteger(n)&&n>0);
assert.ok(Number.isInteger(helpers)&&helpers>=0);
assert.ok(Number.isInteger(warmup)&&warmup>=0&&warmup<ticks);
assert.ok(Number.isInteger(profileStartStep)&&profileStartStep>=warmup&&profileStartStep<ticks);
if(helpers)globalThis.self={crossOriginIsolated:true};
const H=require('./net-harness.cjs'),chaos=require('./chaos-spikes-scenario.cjs');
const data=JSON.parse(fs.readFileSync(path.join(__dirname,'chaos-mega-1000.json')));
const counts=data.startingResources.spawnCounts;
const original=Object.entries(counts).filter(([k])=>k.startsWith('unit:')&&k!=='unit:king').reduce((n,[,v])=>n+Object.values(v).reduce((a,b)=>a+b,0),0);
for(const [k,levels] of Object.entries(counts))if(k.startsWith('unit:')&&k!=='unit:king')for(const l in levels)levels[l]=Math.round(levels[l]*(count-2)/(2*original));
data.lobby.numbers['cfg-max-pop']=Math.max(2000000,count);
if(data.editableConfig?.config)data.editableConfig.config.CONFIG_MAX_POP=data.lobby.numbers['cfg-max-pop'];
const controls={...H.SMALL_MATCH_CONTROLS};
for(const group of ['numbers','selects','checkboxes'])for(const [k,v] of Object.entries(data.lobby[group]||{}))controls[k]=typeof v==='boolean'?v:String(v);
const world=new H.World({controls}),inst=world.spawn('chaos-spikes',{controls,simWorker:false});
inst.scratch.now=()=>performance.now();
inst.eval(`MAX_THING_LEVEL=20; MAX_RESEARCH_LEVEL=10;
 startingResourcesConfig=normalizeStartingResourcesConfig(${JSON.stringify(data.startingResources)});
 applyMainMenuControlsToRuntimeState();applyEditableRuntimeConfigObject(${JSON.stringify(data.editableConfig)},{fromTransport:true});`);
if(helpers){inst.scratch.Worker=require('./real-sim-helper.cjs');inst.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=32;simParallelInit('',${helpers});`);}
console.log('Starting mixed chaos',count,'units');
inst.eval('SIM_IN_WORKER=true;startSoloGame();');
if(process.argv.includes('--no-delta'))inst.eval('SPATIAL_INDEX_DELTA=false');
if(process.argv.includes('--no-merge'))inst.eval('SPATIAL_INDEX_MERGE=false');
const options={mode:'mega',buildings:5000,level:6,towerSites:1500,collectorBuildings:600};
const setup=JSON.parse(inst.eval(`JSON.stringify(${chaos.setup(options)})`));
assert.deepEqual(setup.errors,[]);
const {upgradeAreas,...setupSummary}=setup;
console.log('Setup',JSON.stringify(setupSummary));
inst.eval(`simDk=${dk};netStepTicks=()=>${dk};__scratch.phases={};
 for(const name of new Set(['processActions','gameTick','simMoveRun','simMoveEndTick','runUnitSeparationPass','_forEachUnitInTickOrder','spatialIndexRebuild','simUnitStateCollect','_resolveDeferredPathsByGroup','_runAdjacencyRecalculation','syncVisibilityCoverage','sampleGameStats','recalculateUnitEffectiveLevel','processGlobalSpawnerQueue','navTick','navFieldsFlush','compactRemovedUnits','unitHitsResolve','statusPrepassRun','runQueuedOrders','visCoverHoldEnd','updateAllPlayerVisibility','unitEventsRun','towersTick','spawnerStructuresTick','adjacencyLaneStep','unitRetirePrepare','updateVisibility','spatialIndexPrebuild','_upKeepSecond','ensureLaserConnections','healerCandidatesStep','pathRegionsWarm',...${JSON.stringify((process.env.SUBPHASES||'').split(',').filter(Boolean))}])) {
  let f;try{f=eval(name);}catch{continue;}if(typeof f!=='function')continue;
  // Per-unit diagnostics aggregate durations without allocating timeline
  // records for thousands of calls; keep those intervals at phase level.
  const recordInterval=${timeline}&&!${JSON.stringify((process.env.SUBPHASES||'').split(',').filter(Boolean))}.includes(name);
  const wrapped=function(){const a=__scratch.now();try{return f.apply(this,arguments);}finally{const ms=__scratch.now()-a;__scratch.phases[name]=(__scratch.phases[name]||0)+ms;if(recordInterval)__scratch.intervals.push([name,a,ms]);}};eval(name+'=wrapped');
 }
 __scratch.actions=[];queueAction=a=>__scratch.actions.push(a);`);
if(process.argv.includes('--kernels'))inst.eval(`{
 const run=simParallelRun,wait=simParallelBackgroundWait,collect=_spatialIndexCollect;
 simParallelRun=function(kind,n){const key='kernel:'+kind+(kind===SIM_KERNEL_MOVE_OCCUPANCY?':'+_simParams[4]:'');const a=__scratch.now();try{return run.apply(this,arguments);}finally{const ms=__scratch.now()-a;__scratch.phases[key]=(__scratch.phases[key]||0)+ms;if(${timeline})__scratch.intervals.push([key,a,ms]);}};
 simParallelBackgroundWait=function(lane=1){const a=__scratch.now();try{return wait.apply(this,arguments);}finally{const key='wait:'+lane;__scratch.phases[key]=(__scratch.phases[key]||0)+__scratch.now()-a;}};
 _spatialIndexCollect=function(){const j=_sxPre;const r=collect.apply(this,arguments);if(j){const d=_sxPar&&_sxPar.ixd;__scratch.index={delta:j.delta,inserts:j.delta&&d?d.plan[j.dj]:null,bad:j.delta&&d?d.plan[j.dj+3]:null};}return r;};
}`);
const profileHelpers=process.argv.includes('--helper-profile');
const profileInterval=num('profile-interval',5000);
const session=process.argv.includes('--profile')||profileHelpers?new(require('node:inspector').Session)():null;
const allocationSession=process.argv.includes('--allocation-profile')?new(require('node:inspector').Session)():null;
let profileStart=performance.now();
let profileOrigins=null;
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out+'.jsonl','');
const rows=[];
for(let i=0;i<ticks;i++){
 if(i===warmup&&allocationSession){
  allocationSession.connect();
  await new Promise((resolve,reject)=>allocationSession.post('HeapProfiler.startSampling',{samplingInterval:32768,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true},err=>err?reject(err):resolve()));
 }
 if(i===profileStartStep&&session){
  const origins=profileHelpers?await Promise.all((require('./real-sim-helper.cjs').instances||[]).map(w=>w.benchProfile('start',profileInterval))):[];
  session.connect();session.post('Profiler.enable');session.post('Profiler.setSamplingInterval',{interval:profileInterval});profileStart=performance.now();session.post('Profiler.start');
  profileOrigins={beforeStart:true,startStep:profileStartStep,interval:profileInterval,main:profileStart,helpers:origins.map(r=>r.startedAt)};
 }
 inst.eval('__scratch.phases={};__scratch.index=null;__scratch.intervals=[]');
 // Generating synthetic player inputs is outside tick timing; applying them is inside.
 const burst=i%burstEvery===0;
 if(burst)for(let team=0;team<2;team++)inst.eval(`localPlayerId=${team};__scratch.actions=[];${chaos.burst(options,Math.floor(i/burstEvery))};__scratch['actions'+${team}]=__scratch.actions;`);
 const cpu0=metrics?process.cpuUsage():null;
 const a=performance.now();
 if(burst)for(let team=0;team<2;team++)inst.eval(`processActions(__scratch.actions${team},${team})`);
 inst.eval('gameTick();currentTick++;');
 const ms=performance.now()-a;
 if(yieldBetween)await new Promise(setImmediate);
 const wallMs=performance.now()-a;
 const row={step:i,ms,wallMs,gapMs:wallMs-ms,at:a,startMs:a-profileStart,burst,...inst.eval('({tick:gameTime,units:units.length,phases:__scratch.phases,index:__scratch.index,gameOver})')};
 if(timeline)row.intervals=inst.eval('__scratch.intervals');
 if(metrics){row.cpu=process.cpuUsage(cpu0);row.heapUsedMB=require('node:v8').getHeapStatistics().used_heap_size/1048576;row.freeMB=require('node:os').freemem()/1048576;}
 rows.push(row);fs.appendFileSync(out+'.jsonl',JSON.stringify(row)+'\n');
 if(i%10===0)console.log('step',i,'ms',ms.toFixed(1),'units',row.units);
 assert.deepEqual(inst.errors.map(String),[]);assert.equal(row.gameOver,false);
}
function stats(rows){const a=rows.map(r=>r.ms).sort((a,b)=>a-b),mean=a.reduce((a,b)=>a+b,0)/a.length;return{samples:a.length,mean,tps:1000/mean,p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],p99:a[Math.floor(a.length*.99)],max:a.at(-1)};}
const steady=rows.slice(warmup);
if(gcObserver){gcEntries.push(...gcObserver.takeRecords().map(e=>({at:e.startTime,ms:e.duration,kind:e.detail.kind})));gcObserver.disconnect();for(const row of rows)row.gcMs=gcEntries.reduce((n,e)=>n+Math.max(0,Math.min(e.at+e.ms,row.at+row.wallMs)-Math.max(e.at,row.at)),0);}
const result={count,ticks,warmup,helpers,dk,burstEvery,yieldBetween,profileOrigins,setup:setupSummary,node:process.version,heap:inst.eval('simHeapStats()'),jsScratch:inst.eval('({spatialCountQueueBytes:_spatialCountQ.byteLength||0,eventOrderBytes:_unitEvKey.byteLength+_unitEvEnt.byteLength+_unitEvOrd.byteLength})'),all:stats(rows),steady:stats(steady),wall:stats(steady.map(r=>({ms:r.wallMs}))),bursts:stats(steady.filter(r=>r.burst).length?steady.filter(r=>r.burst):steady),worst:steady.slice().sort((a,b)=>b.wallMs-a.wallMs).slice(0,10),gcEntries,rows};
if(process.argv.includes('--hash'))result.hash=inst.eval('__exactStateHash()');
result.outliers={over500ms:steady.filter(r=>r.wallMs>500).length,overMedian1_5:steady.filter(r=>r.wallMs>result.wall.p50*1.5).length,maxToMedian:result.wall.max/result.wall.p50};
fs.writeFileSync(out,JSON.stringify(result,null,2));
if(session)session.post('Profiler.stop',(err,r)=>{if(err)throw err;fs.writeFileSync(out+'.cpuprofile',JSON.stringify(r.profile));session.disconnect();});
if(profileHelpers)await Promise.all((require('./real-sim-helper.cjs').instances||[]).map(async(w,i)=>{const r=await w.benchProfile('stop');fs.writeFileSync(out+'.helper'+i+'.cpuprofile',JSON.stringify(r.profile));}));
if(allocationSession){
 const r=await new Promise((resolve,reject)=>allocationSession.post('HeapProfiler.stopSampling',(err,r)=>err?reject(err):resolve(r)));
 fs.writeFileSync(out+'.heapprofile',JSON.stringify(r.profile));allocationSession.disconnect();
}
console.log(JSON.stringify({all:result.all,steady:result.steady,wall:result.wall,outliers:result.outliers,bursts:result.bursts,out}));
process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
