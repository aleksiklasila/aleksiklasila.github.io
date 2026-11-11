// Serial, real simulation with mixed combat/economy and repeatable command bursts.
// node --max-old-space-size=8192 tests/chaos-spikes.bench.cjs --units=1000000 --ticks=240 --kernels --system-metrics --out=tests/test-runs/chaos-spikes/latest.json
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {performance,PerformanceObserver}=require('node:perf_hooks');
(async()=>{
const num=(key,value)=>Number(process.argv.find(a=>a.startsWith('--'+key+'='))?.split('=')[1]??value);
const count=num('units',1000000),ticks=num('ticks',240),helpers=num('helpers',11),dk=num('dk',1),burstEvery=num('burst-every',10);
const warmup=num('warmup',Math.min(20,ticks-1));
const structures=num('structures',250000),workerMinimum=num('worker-min',30000);
const unitLevelOffset=num('unit-level-offset',structures?8:0);
const layout=process.argv.find(a=>a.startsWith('--layout='))?.slice(9)||'mixed';
const towerMode=process.argv.find(a=>a.startsWith('--tower-mode='))?.slice(13)||'auto';
assert.ok(['mixed','front'].includes(layout));
assert.ok(['auto','js','verify'].includes(towerMode));
const profileStartStep=num('profile-start',warmup);
const metrics=process.argv.includes('--system-metrics');
const timeline=process.argv.includes('--timeline');
const eventMetrics=process.argv.includes('--event-metrics');
const yieldBetween=!process.argv.includes('--no-yield');
const gcEntries=[],gcObserver=metrics?new PerformanceObserver(list=>gcEntries.push(...list.getEntries().map(e=>({at:e.startTime,ms:e.duration,kind:e.detail.kind})))):null;
if(gcObserver)gcObserver.observe({entryTypes:['gc']});
const out=path.resolve(process.argv.find(a=>a.startsWith('--out='))?.slice(6)||'tests/test-runs/chaos-spikes/latest.json');
for(const n of [count,ticks,dk,burstEvery])assert.ok(Number.isInteger(n)&&n>0);
for(const n of [structures,workerMinimum,unitLevelOffset])assert.ok(Number.isInteger(n)&&n>=0);
assert.ok(Number.isInteger(helpers)&&helpers>=0);
assert.ok(Number.isInteger(warmup)&&warmup>=0&&warmup<ticks);
assert.ok(Number.isInteger(profileStartStep)&&profileStartStep>=0&&profileStartStep<ticks);
if(helpers)globalThis.self={crossOriginIsolated:true};
const H=require('./net-harness.cjs'),chaos=require('./chaos-spikes-scenario.cjs');
const data=JSON.parse(fs.readFileSync(path.join(__dirname,'chaos-mega-1000.json')));
const counts=data.startingResources.spawnCounts;
const original=Object.entries(counts).filter(([k])=>k.startsWith('unit:')&&k!=='unit:king').reduce((n,[,v])=>n+Object.values(v).reduce((a,b)=>a+b,0),0);
for(const [k,levels] of Object.entries(counts))if(k.startsWith('unit:')&&k!=='unit:king')for(const l in levels)levels[l]=Math.round(levels[l]*(count-2)/(2*original));
// Preserve the mixed army, but give every worker profession enough population
// to expose its steady work and assignment costs, including rare professions.
const workerKeys=['healer_unit','collector','astar_collector','builder_unit','researcher_unit','salvager_unit'].map(k=>'unit:'+k);
for(const k of workerKeys){const levels=counts[k],level=Object.keys(levels)[0];levels[level]=Math.max(levels[level],Math.ceil(workerMinimum/2));}
const workers=workerKeys.reduce((n,k)=>n+Object.values(counts[k]).reduce((a,b)=>a+b,0),0);
assert.ok(workers<count/2,'worker-min leaves no room for armies');
const combat=Object.entries(counts).filter(([k])=>k.startsWith('unit:')&&k!=='unit:king'&&!workerKeys.includes(k));
const combatTotal=combat.reduce((n,[,levels])=>n+Object.values(levels).reduce((a,b)=>a+b,0),0);
for(const [,levels]of combat)for(const l in levels)levels[l]=Math.round(levels[l]*(count/2-1-workers)/combatTotal);
// High research/boost towers otherwise erase most low-level starting armies
// during warm-up. Use normal higher-level units to retain a demanding scene.
for(const k of Object.keys(counts))if(k.startsWith('unit:')&&k!=='unit:king'){
 const levels={};for(const [l,n]of Object.entries(counts[k])){const next=Math.min(20,Number(l)+unitLevelOffset);levels[next]=(levels[next]||0)+n;}counts[k]=levels;
}
require('./menu-limits.cjs').settings(data,{population:num('population',Math.ceil(count/2)),map:num('map',1024)});
const controls={...H.SMALL_MATCH_CONTROLS};
for(const group of ['numbers','selects','checkboxes'])for(const [k,v] of Object.entries(data.lobby[group]||{}))controls[k]=typeof v==='boolean'?v:String(v);
const world=new H.World({controls}),inst=world.spawn('chaos-spikes',{controls,simWorker:false});
inst.scratch.now=()=>performance.now();
inst.eval(`MAX_THING_LEVEL=20; MAX_RESEARCH_LEVEL=10;
 startingResourcesConfig=normalizeStartingResourcesConfig(${JSON.stringify(data.startingResources)});
 applyMainMenuControlsToRuntimeState();applyEditableRuntimeConfigObject(${JSON.stringify(data.editableConfig)},{fromTransport:true});`);
assert.ok(count<=inst.eval('memoryBudgetPop(CONFIG_MAX_POP,2,GRID_W*GRID_H)*2'),'requested units exceed the menu match population limit');
if(helpers){inst.scratch.Worker=require('./real-sim-helper.cjs');inst.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=32;simParallelInit('',${helpers});`);}
// --live-heap: what the JavaScript heap holds at the end, by allocation site,
// from before the match starts (objects collected meanwhile left out), to a
// .liveheap sidecar (a sampling heap profile). Diagnostic, not for timing.
const liveHeapSession=process.argv.includes('--live-heap')?new(require('node:inspector').Session)():null;
if(liveHeapSession){liveHeapSession.connect();await new Promise((resolve,reject)=>liveHeapSession.post('HeapProfiler.startSampling',{samplingInterval:65536,includeObjectsCollectedByMajorGC:false,includeObjectsCollectedByMinorGC:false},err=>err?reject(err):resolve()));}
console.log('Starting mixed chaos',count,'units');
inst.eval('SIM_IN_WORKER=true;startSoloGame();');
if(process.argv.includes('--no-delta'))inst.eval('SPATIAL_INDEX_DELTA=false');
const limits=inst.eval('({population:getConfiguredMaxPop(),buildings:getPlayerStructureLimit(),map:GRID_W,slots:_simUnitState.cap})');
const options={mode:'mega',buildings:5000,level:6,towerSites:1500,collectorBuildings:600,structures:Math.min(structures,limits.buildings*2),layout,rallyMix:process.argv.includes('--rally-mix')};
console.log('Menu limits',JSON.stringify(limits));
const setup=JSON.parse(inst.eval(`JSON.stringify(${chaos.setup(options)})`));
assert.deepEqual(setup.errors,[]);
const {upgradeAreas,...setupSummary}=setup;
console.log('Setup',JSON.stringify(setupSummary));
// --export-scene=file.gz: the set-up match as a portable scene (the menu's Load,
// tests/perf-fuzz.cjs and tests/select-all-spike-probe.cjs read it), after
// --export-ticks=N steps (default 10, so workers have jobs and queues run), then exit.
const exportScene=process.argv.find(a=>a.startsWith('--export-scene='))?.slice(15);
if(exportScene){
 for(let i=0;i<num('export-ticks',10);i++)inst.eval('gameTick()');
 const parts=inst.eval(`(()=>{const settings=createMainMenuSettingsSnapshot();settings.editableConfig=serializeEditableRuntimeConfigForTransport();
  return soloGameSnapshotJsonParts(buildSoloGameSnapshotParts({createdAt:new Date().toISOString(),settings,player:0,teamColors:{...teamColorById},
   camera:{x:GRID_W/2,y:GRID_H/2,zoom:camera.zoom}}));})()`);
 const zlib=require('node:zlib'),gz=zlib.createGzip({level:6}),file=fs.createWriteStream(path.resolve(exportScene));
 gz.pipe(file);for(const p of parts)gz.write(p);gz.end();
 await new Promise(r=>file.on('close',r));
 console.log('scene',exportScene,(fs.statSync(exportScene).size/1048576).toFixed(1),'MB, units',inst.eval('units.filter(u=>!u.dead).length'));
 process.exit(0);
}
// (PRE=<js>: run in the instance after setup, before the measured ticks: A/B switches.)
if(process.env.PRE){const r=inst.eval(process.env.PRE);if(r!==undefined)console.log(r);}
if(process.argv.includes('--worker-brain=js'))inst.eval(`if(typeof WORKER_BRAIN_WASM!=='undefined')WORKER_BRAIN_WASM=false;`);
// Synthetic placement follows startGame, so finish the same load preparation
// that a real imported scene performs after its entities have been installed.
const prepareAt=performance.now();
inst.eval(`if(typeof simMatchPrepare==='function')simMatchPrepare();`);
const prepareMs=performance.now()-prepareAt;
inst.eval(`__scratch.work={spawns:0,armySpawns:0,researchDeposits:0,collectorDeposits:0,astarDeposits:0,constructionCompleted:0,destroyedStructures:0,healerDeliveries:0,salvagerReturns:0};{
 const spawn=_spawnEnd,deposit=_depositResourceCollectorPayload,complete=markConstructionComplete,destroy=destroyBuilding;
 _spawnEnd=function(k,s){const r=spawn.apply(this,arguments);if(r){__scratch.work.spawns++;if(s.type==='barrack')__scratch.work.armySpawns++;}return r;};
 // (Research deposits: the worker kernel counts them, worker.js _wai.researchDeposits.)
 // (A source without the kernel, an A/B baseline: its JavaScript deposit.)
 if(typeof waiRun==='function'){const run=waiRun;waiRun=function(){const was=[_wai.researchDeposits||0,_wai.collectorDeposits||0,_wai.astarDeposits||0];const r=run.apply(this,arguments);__scratch.work.researchDeposits+=(_wai.researchDeposits||0)-was[0];__scratch.work.collectorDeposits+=(_wai.collectorDeposits||0)-was[1];__scratch.work.astarDeposits+=(_wai.astarDeposits||0)-was[2];return r;};}
 else if(typeof _researcherDeposit==='function'){const research=_researcherDeposit;_researcherDeposit=function(){const r=research.apply(this,arguments);if(r)__scratch.work.researchDeposits++;return r;};}
 _depositResourceCollectorPayload=function(u,o,c){if(u.carryingValue>0&&c)__scratch.work[c.stockpileKey==='astar'?'astarDeposits':'collectorDeposits']++;return deposit.apply(this,arguments);};
 markConstructionComplete=function(t){if(t.underConstruction)__scratch.work.constructionCompleted++;return complete.apply(this,arguments);};
 destroyBuilding=function(){__scratch.work.destroyedStructures++;return destroy.apply(this,arguments);};
 if(typeof waiOutEvents==='function'){const events=waiOutEvents;waiOutEvents=function(n){for(let i=0;i<n;i++){
  const code=_wai.out[i*4];if(code===WAI_OUT_BUILT&&_wai.out[i*4+2]===0)__scratch.work.constructionCompleted++;
  if(code===WAI_OUT_SOUND_HEAL)__scratch.work.healerDeliveries++;
  if(code===WAI_OUT_SALVAGE)__scratch.work.salvagerReturns++;
 }return events.apply(this,arguments);};}
 if(typeof structDestroyTiles==='function'){const remove=structDestroyTiles;structDestroyTiles=function(list,n){
  const tiles=[...new Set(Array.from({length:n},(_,j)=>list[j]).filter(t=>_ST.code[t]>0&&_ST.code[t]<0x66))];
  const r=remove.apply(this,arguments);for(const t of tiles)if(_ST.code[t]===0)__scratch.work.destroyedStructures++;return r;
 };}
}
//# sourceURL=chaos-bench-instrumentation-work.js
`);
inst.eval(`simDk=${dk};netStepTicks=()=>${dk};__scratch.phases={};__scratch.intervals=[];
 for(const name of new Set([
  'processActions','gameTick','simMoveRun','simMoveEndTick','runUnitSeparationPass','_forEachUnitInTickOrder','spatialIndexRebuild','simUnitStateCollect',
  '_resolveDeferredPathsByGroup','_runAdjacencyRecalculation','syncVisibilityCoverage','sampleGameStats','recalculateUnitEffectiveLevel','processGlobalSpawnerQueue',
  'navTick','navFieldsFlush','compactRemovedUnits','unitHitsResolve','statusPrepassRun','runQueuedOrders','visCoverHoldEnd','updateAllPlayerVisibility','unitEventsRun',
  'towersTick','_towerAcqKernels','projectilesAdvance','laserBeamsTick','spawnerStructuresTick','adjacencyLaneStep','unitRetirePrepare',
  'updateVisibility','spatialIndexPrebuild','_upKeepSecond','ensureLaserConnections','healerCandidatesStep',
  'workerSearchTierStep','_wswBuild','flushPendingResourceStatRebuilds','resourceTick','researchDrainTick','shrineTick','recomputePlayerPopCaps','structRowsExpire',
  ...${JSON.stringify((process.env.SUBPHASES||'').split(',').filter(Boolean))}])) {
  let f;try{f=eval(name);}catch{continue;}if(typeof f!=='function')continue;
  // Per-unit diagnostics aggregate durations without allocating timeline
  // records for thousands of calls; keep those intervals at phase level.
  const recordInterval=${timeline}&&!${JSON.stringify((process.env.SUBPHASES||'').split(',').filter(Boolean))}.includes(name);
  const wrapped=function(){const a=__scratch.now();try{return f.apply(this,arguments);}finally{const ms=__scratch.now()-a;__scratch.phases[name]=(__scratch.phases[name]||0)+ms;if(recordInterval)__scratch.intervals.push([name,a,ms]);}};eval(name+'=wrapped');
 }
 __scratch.actions=[];queueAction=a=>__scratch.actions.push(a);
//# sourceURL=chaos-bench-instrumentation-phases.js
`);
if(process.argv.includes('--kernels'))inst.eval(`{
 const run=simParallelRun,wait=simParallelBackgroundWait,collect=_spatialIndexCollect;
 simParallelRun=function(kind,n){const key='kernel:'+kind+(kind===SIM_KERNEL_MOVE_OCCUPANCY?':'+_simParams[4]:'');const a=__scratch.now();try{return run.apply(this,arguments);}finally{const ms=__scratch.now()-a;__scratch.phases[key]=(__scratch.phases[key]||0)+ms;if(${timeline})__scratch.intervals.push([key,a,ms]);}};
 // (--rust-direct: the serial Rust calls on this thread too, as rust:<name>.)
 if(${process.argv.includes('--rust-direct')}){const rd=simRustDirect;simRustDirect=function(fn){const a=__scratch.now();try{return rd.apply(this,arguments);}finally{const key='rust:'+fn;__scratch.phases[key]=(__scratch.phases[key]||0)+__scratch.now()-a;}};}
 simParallelBackgroundWait=function(lane=1){const a=__scratch.now();try{return wait.apply(this,arguments);}finally{const key='wait:'+lane;__scratch.phases[key]=(__scratch.phases[key]||0)+__scratch.now()-a;}};
 _spatialIndexCollect=function(){const j=_sxPre;const r=collect.apply(this,arguments);if(j){const d=_sxPar&&_sxPar.ixd;__scratch.index={delta:j.delta,inserts:j.delta&&d?d.plan[j.dj]:null,bad:j.delta&&d?d.plan[j.dj+3]:null};}return r;};
}
//# sourceURL=chaos-bench-instrumentation-kernels.js
`);
// --occ-jobs (diagnostic): per occupancy phase (kernel 89) its wall, job count,
// summed job time, heaviest job and that block's units, in row.occ
// (par.ctrace, trace-only; as tests/occ-sched-probe.cjs).
if(process.argv.includes('--occ-jobs'))inst.eval(`{
 __scratch.ct=simHeapArray(Float64Array,32768);simParallelBind('par.ctrace',__scratch.ct);__scratch.occ=[];
 const pr=simParallelRun;simParallelRun=function(kk,n){
  if(kk!==SIM_KERNEL_MOVE_OCCUPANCY)return pr.apply(this,arguments);
  const T=__scratch.ct;T.fill(-1,0,n*2);const tr=_simParTrace;_simParTrace=tr||{};const a=__scratch.now();
  try{return pr.apply(this,arguments);}finally{
   _simParTrace=tr;const wall=__scratch.now()-a,J=_occ.jobs,F=_occ.offsets,ph=_simParams[4],at=8+J[ph];let work=0,heavy=0,hu=0,units=0;
   for(let c=0;c<n;c++){const d=Math.max(0,T[c*2+1]),u=F[J[at+c]+1]-F[J[at+c]];work+=d;units+=u;if(d>heavy){heavy=d;hu=u;}}
   __scratch.occ.push({ph,wall:+wall.toFixed(2),n,work:+work.toFixed(2),units,heavy:+heavy.toFixed(2),heavyUnits:hu});
  }};
 // (And each background wait over 1 ms: its lane, the chain's stages [kernel, chunks],
 // the stage still running at the wait and its done / total chunks.)
 // (ACQ_EAGER=1: the acquisition chain waited for right after its post, every
 // thread free: its cost alone, as acqEager. Changes the schedule: diagnostic.)
 if(${!!process.env.ACQ_EAGER}){const post=_acqPost;_acqPost=function(){const r=post.apply(this,arguments);const J=_simBg[ACQ_LANE];if(J){const t=__scratch.now();
  // (Per stage its wall on the helpers alone: the lane's stage id watched, not helped.)
  const ctl=_simPool.ctl,b=SIM_PAR_BG_BASE+ACQ_LANE*8,id0=_simBgIds[ACQ_LANE],L=J.stages.length,at=[];let last=-1,t1=t;
  for(;;){const s=(Atomics.load(ctl,b+SIM_PAR_BG_ID)-id0)&0x7F,dn=Atomics.load(ctl,b+SIM_PAR_BG_DONE)>=Atomics.load(ctl,b+SIM_PAR_BG_TOTAL);const now=__scratch.now();
   if(s>=L){if(now-t>2000)break;continue;}
   if(s!==last){if(last>=0)at.push(J.stages[last][0]+':'+(now-t1).toFixed(1));last=s;t1=now;}
   if(s===L-1&&dn){at.push(J.stages[s][0]+':'+(now-t1).toFixed(1));break;}if(now-t>2000)break;}
  __scratch.occ.push({acqStages:at.join(' ')});
  simParallelBackgroundWait(ACQ_LANE);__scratch.occ.push({acqEager:+(__scratch.now()-t).toFixed(1),chain:J.stages.map(s=>s[0]+'x'+s[1]).join(',')});_simBg[ACQ_LANE]=null;}return r;};}
 const bw=simParallelBackgroundWait;simParallelBackgroundWait=function(lane=1){
  const J=_simBg[lane];if(!J||J.sync)return bw.apply(this,arguments);
  const ctl=_simPool.ctl,b=SIM_PAR_BG_BASE+lane*8,at=(Atomics.load(ctl,b+SIM_PAR_BG_ID)-_simBgIds[lane])&0x7F;
  const st={lane,stage:at,kernel:J.stages[at]?J.stages[at][0]:-1,done:Atomics.load(ctl,b+SIM_PAR_BG_DONE),total:Atomics.load(ctl,b+SIM_PAR_BG_TOTAL)};
  const a=__scratch.now();try{return bw.apply(this,arguments);}finally{const ms=__scratch.now()-a;if(ms>1)__scratch.occ.push({wait:+ms.toFixed(1),...st,chain:J.stages.map(s=>s[0]+'x'+s[1]).join(',')});}
 };
}`);
// --mass-at=STEP: the mass command (see the step loop); --mass-team,
// --mass-gap (steps between clicks), --mass-clicks.
const massAt=num('mass-at',0),massTeam=num('mass-team',0),massGap=num('mass-gap',2),massClicks=num('mass-clicks',3);
const followupUnits=num('mass-followup-units',0);
const MASS_COMMAND=`((click)=>{
 const p=${massTeam},out=[],pts=[];
 for(let k=0;k<=click;k++)pts.push({x:Math.floor(GRID_W*(.35+k*.12))*TILE+16,y:Math.floor(GRID_H*.55)*TILE+16,targetUnitId:null});
 const sel=[];for(const u of units)if(u&&!u.dead&&u.owner===p&&!u.isKing)sel.push(u);
 if(${followupUnits}>0&&click>0){sel.length=Math.min(sel.length,${followupUnits});pts.splice(0,pts.length-1);}
 const n=sel.length,xs=new Float32Array(n),ys=new Float32Array(n),has=new Uint8Array(n).fill(1);
 for(let i=0;i<n;i++){xs[i]=sel[i].x;ys[i]=sel[i].y;}
 const pick=pts.length>1?assignNearestXY(xs,ys,has,pts):new Int32Array(n),byPt=pts.map(()=>[]);
 for(let i=0;i<n;i++)byPt[pick[i]].push(sel[i].id);
 if(${followupUnits}>0&&click>0)__scratch.response={click,items:sel.map((u,i)=>({u,x:u.x,y:u.y,target:pts[pick[i]],applied:false,moved:false})),started:0};
 byPt.forEach((ids,j)=>{for(let q=0;q<ids.length;q+=ACTION_MAX_UNIT_IDS){const part=ids.slice(q,q+ACTION_MAX_UNIT_IDS);out.push({action:'move',uidz:actionIdsEncode(part),targetX:pts[j].x,targetY:pts[j].y});}});
 const bs=[];for(const b of barracks)if(b&&b.owner===p&&!b.dead)bs.push(b);for(const b of collectorSpawners)if(b&&b.owner===p&&!b.dead&&isSpawnerEntity(b)&&('rallyX' in b))bs.push(b);
 if(${followupUnits}>0&&click>0)bs.length=0;
 const m=bs.length,bx=new Float32Array(m),by=new Float32Array(m),bh=new Uint8Array(m).fill(1);
 for(let i=0;i<m;i++){bx[i]=bs[i].x;by[i]=bs[i].y;}
 const bp=pts.length>1?assignNearestXY(bx,by,bh,pts):new Int32Array(m);
 const exp=__scratch.massRally=new Map();
 out.push(...(typeof massRallyActions==='function'?massRallyActions:__scratch.massRallyActions)(bs,bp,pts));
 for(let i=0;i<m;i++)exp.set(bs[i],pts[bp[i]]);
 __scratch.massSel={units:n,buildings:m};
 return out;
})`;
// Diagnostic only: end-of-tick upper bounds from simulation receipt to target
// application / changed position. Excludes UI, transport and rendering. A unit
// already at its destination need not move; deaths are reported separately.
const RESPONSE_PENDING=`(()=>{
 const r=__scratch.response;if(!r)return null;
 let applied=0,moved=0,dead=0;
 for(const e of r.items){const u=e.u;if(u.dead){dead++;continue;}
  if(u.targetPos&&u.targetPos.x===e.target.x&&u.targetPos.y===e.target.y)e.applied=true;
  if(e.applied&&(u.x!==e.x||u.y!==e.y))e.moved=true;
  applied+=e.applied;moved+=e.moved;
 }
 return {click:r.click,selected:r.items.length,applied,moved,dead,elapsedMs:__scratch.now()-r.started};
})()`;
// (The pending part of the mass command: units still to be ordered, buildings
// whose rally is not yet the last click's.)
const MASS_PENDING=`(()=>{
 let ids=0,coords=0,live=0,off=0;
 for(const e of _actionBacklog){const r=e[1];if(!r)continue;if(r.action==='setRallyMany')coords+=(typeof massRallyCount==='function'?massRallyCount:__scratch.massRallyCount)(r);else if(Array.isArray(r.unitIds))ids+=r.unitIds.length;else if(typeof r.uidz==='string')ids+=actionIdsCount(r.uidz);}
 for(const e of _orderQueue)live+=e.live;
 if(__scratch.massRally)for(const [b,pt] of __scratch.massRally)if(!b.dead&&(b.rallyX!==pt.x||b.rallyY!==pt.y))off++;
 return {backlogIds:ids,backlogRally:coords,queuedUnits:live,rallyOff:off,sel:__scratch.massSel||null};
})()`;
// (The rally as the page sends it: one action a point, tile keys
// (rallyAssignTiles); older sources, coordinate lists.)
if(massAt>0)inst.eval(`{
 __scratch.massRallyActions=typeof rallyAssignTiles==='function'?(bs,pick,pts)=>{
  const m=bs.length,keys=new Int32Array(m),xs=new Float32Array(m),ys=new Float32Array(m),has=new Uint8Array(m).fill(1);
  for(let i=0;i<m;i++){keys[i]=bs[i].gy*GRID_W+bs[i].gx;xs[i]=bs[i].x;ys[i]=bs[i].y;}
  const r=rallyAssignTiles(keys,xs,ys,has,pts);return r.tkz.map((tkz,j)=>({action:'setRallyMany',tkz,targetX:pts[j].x,targetY:pts[j].y,targetUnitId:null})).filter((a,j)=>r.keys[j].length);
 }:(bs,pick,pts)=>{const out=[],c=pts.map(()=>[]);for(let i=0;i<bs.length;i++)c[pick[i]].push(bs[i].gx,bs[i].gy);
  c.forEach((l,j)=>{for(let q=0;q<l.length;q+=2*ACTION_MAX_RALLY_COORDS)out.push({action:'setRallyMany',coords:l.slice(q,q+2*ACTION_MAX_RALLY_COORDS),targetX:pts[j].x,targetY:pts[j].y,targetUnitId:null});});return out;};
 __scratch.massRallyCount=r=>Array.isArray(r.coords)?r.coords.length/2:0;
}`);
const profileHelpers=process.argv.includes('--helper-profile');
// Diagnostic only: distinguish event volume from cost per event. Do not use
// these wrappers in acceptance timing runs (they add per-event overhead).
if(eventMetrics)inst.eval(`{
 const event=_unitEvent,ai=updateWorkerAI;
 _unitEvent=function(u,c,s,code){const m=__scratch.events;m.codes[code]=(m.codes[code]||0)+1;m[u.workerState?'workerEvents':'combatEvents']++;return event.apply(this,arguments);};
 updateWorkerAI=function(u){const m=__scratch.events,key=u.workerType+':'+u.workerState;m.ai[key]=(m.ai[key]||0)+1;const before=u.workerState;try{return ai.apply(this,arguments);}finally{if(u.workerState!==before){const k=key+'>'+u.workerState;m.transitions[k]=(m.transitions[k]||0)+1;}}};
 if(typeof _unitNoWayCommit==='function'){
  const commit=_unitNoWayCommit;
  _unitNoWayCommit=function(){const r=commit.apply(this,arguments);if(r){const m=__scratch.events;m.codes[2]=(m.codes[2]||0)+1;m.combatEvents++;m.fastRoutes=(m.fastRoutes||0)+1;}return r;};
 }
}`);
// --worker-post: what the browser's simulation worker does around each tick
// on its own heap: sounds/effects/alerts recorded as packed events
// (sim_worker.js _simStubUi), the tick's result encoded and posted
// (_simPostResult; the post itself dropped), the presentation publish and a
// metadata pump slice between ticks. For in-game allocation/GC measurements.
const workerPost=process.argv.includes('--worker-post');
// --no-census: no worker activity census (a harness scan of every unit's getters; its own garbage and survivors).
const census=!process.argv.includes('--no-census');
if(workerPost){
 // (The worker's script in the game's scope; its functions handed back.)
 inst.eval(`__scratch.W=(()=>{${fs.readFileSync(path.join(__dirname,'../src/sim/sim_worker.js'),'utf8')}
  ;return {_simStubUi,_simPostResult,get:{_simEpoch:()=>_simEpoch,_simError:()=>_simError,_simNowAbs:()=>_simNowAbs,_simPost:()=>_simPost,_simStream:()=>_simStream,
   _simTick:()=>_simTick,_simDefeatedTeams:()=>_simDefeatedTeams,_simLocalDefeat:()=>_simLocalDefeat,_simRef:()=>_simRef}};})()`);
 // (Worker globals the game-scope encoders name: unresolved there, they are
 // looked up on this realm's global object. Live values.)
 for(const [k,get] of Object.entries(inst.eval('__scratch.W.get')))Object.defineProperty(globalThis,k,{get,configurable:true});
 inst.eval(`self.postMessage=()=>{};__scratch.W._simStubUi();
  playSound=self._simRecordSound;recordDamageVisual=self._simRecordDamage;pushHostileDamageAlert=self._simRecordAlert;
  createExplosion=self._simRecordExplosion;createDirectedParticles=self._simRecordDirected;recordCombatFx=self._simRecordFx;
  {const RW=Worker;Worker=class{postMessage(){}terminate(){}};try{__scratch.presenting=simPresentationStart();}finally{Worker=RW;}}`);
 console.log('Worker post',JSON.stringify({presentation:inst.eval('!!__scratch.presenting')}));
}
const profileInterval=num('profile-interval',5000);
const session=process.argv.includes('--profile')||profileHelpers?new(require('node:inspector').Session)():null;
const allocationSession=process.argv.includes('--allocation-profile')?new(require('node:inspector').Session)():null;
const allocationHarnessScripts={};
let profileStart=performance.now();
let profileOrigins=null;
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out+'.jsonl','');
const rows=[];
const readStructRows=()=>inst.eval('typeof structRowStats!=="undefined"?({...structRowStats}):null');
const structRowsAtStart=readStructRows();
let structRowsAtSteady=null;
let previousUnits=setup.units,previousSpawns=0;
// --census=steps (with --helpers=0): the unit column census over those steps, to <out>.census.json (unit-column-census-hooks.js).
const censusSteps=new Set((process.argv.find(a=>a.startsWith('--census='))?.slice(9)||'').split(',').filter(Boolean).map(Number));
if(censusSteps.size){const src=fs.readFileSync(path.join(__dirname,'../src/sim/sim_parallel.js'),'utf8');inst.scratch.kernelNames=[...src.matchAll(/SIM_KERNEL_([A-Z0-9_]+)\s*=\s*(\d+)/g)].map(m=>m[1]+'='+m[2]).join(',');inst.eval(fs.readFileSync(path.join(__dirname,'unit-column-census-hooks.js'),'utf8'));}
let __dbgcRow,__evRow;const __stepEvalArg=process.argv.find(a=>a.startsWith('--step-eval='))?.slice(12);const __stepEval=__stepEvalArg?(__stepEvalArg[0]==='@'?fs.readFileSync(__stepEvalArg.slice(1),'utf8'):__stepEvalArg):null;
for(let i=0;i<ticks;i++){
 if(i===warmup)structRowsAtSteady=readStructRows();
 if(i===warmup&&allocationSession){
  allocationSession.connect();
  const labelScript=({params:{scriptId,url}})=>{if(url.includes('chaos-bench-instrumentation-'))allocationHarnessScripts[scriptId]=url;};
  allocationSession.on('Debugger.scriptParsed',labelScript);
  // V8's heap sampler omits sourceURL on some eval frames. Resolve their
  // script ids before sampling, and disable the debugger for the run.
  for(const method of ['Debugger.enable','Debugger.disable']) await new Promise((resolve,reject)=>allocationSession.post(method,err=>err?reject(err):resolve()));
  allocationSession.off('Debugger.scriptParsed',labelScript);
  await new Promise((resolve,reject)=>allocationSession.post('HeapProfiler.startSampling',{samplingInterval:32768,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:!process.argv.includes('--allocation-survivors')},err=>err?reject(err):resolve()));
 }
 if(i===profileStartStep&&session){
  const origins=profileHelpers?await Promise.all((require('./real-sim-helper.cjs').instances||[]).map(w=>w.benchProfile('start',profileInterval))):[];
  session.connect();session.post('Profiler.enable');session.post('Profiler.setSamplingInterval',{interval:profileInterval});profileStart=performance.now();session.post('Profiler.start');
  profileOrigins={beforeStart:true,startStep:profileStartStep,interval:profileInterval,main:profileStart,helpers:origins.map(r=>r.startedAt)};
 }
 // (--restore-at=N, diagnostic: a multiplayer resync of this peer before step
 // N, outside the timing: the whole state encoded and decoded in place (its
 // restore lays the unit slots out dense, simUnitStateCompact), then the
 // resync tick's flush every peer makes (snapFlushHistoryCaches, sim_worker.js
 // msg.flush). --flush-at=N: the flush alone, as a peer that was not restored:
 // the two give the same state from then on (2026-11-05).)
 // (RESTORE_JS=<js>: that instead, e.g. simUnitStateCompact(true) alone.
 // RESTORE_SPLIT=1: the restore's encode, decode and flush timed apart.)
 if(i===num('restore-at',-1)&&process.env.RESTORE_SPLIT&&!process.env.RESTORE_JS){
  for(const [name,js] of [['encode','__scratch.snap=snapEncodeState(),1'],['decode','snapDecodeState(__scratch.snap),__scratch.snap=null,1'],['flush','snapFlushHistoryCaches(),1']]){const t=performance.now();inst.eval(js);console.log('restore',name,(performance.now()-t).toFixed(0),'ms');}
 }else if(i===num('restore-at',-1)||i===num('flush-at',-1)){const t=performance.now();const rv=inst.eval(process.env.RESTORE_JS||(i===num('restore-at',-1)?'snapDecodeState(snapEncodeState()),snapFlushHistoryCaches(),1':'snapFlushHistoryCaches(),1'));if(process.env.RESTORE_JS)console.log('restore value',JSON.stringify(rv));console.log(i===num('restore-at',-1)?'restore':'flush',(performance.now()-t).toFixed(0),'ms',inst.eval('JSON.stringify({owners:_simUnitState.owners.length,cap:_simUnitState.cap,units:units.length})'));}
 inst.eval('__scratch.phases={};__scratch.index=null;__scratch.intervals=[]');
 if(eventMetrics)inst.eval('__scratch.events={codes:{},ai:{},transitions:{},workerEvents:0,combatEvents:0,budgetParked:0}');
 // Generating synthetic player inputs is outside tick timing; applying them is inside.
 const burst=i%burstEvery===0;
 // (As the page sends them: long id lists compact (worker.js _queueLocalAction),
 // the wire's JSON round trip, prepared as the simulation worker does on arrival.)
 if(burst)for(let team=0;team<2;team++)inst.eval(`localPlayerId=${team};__scratch.actions=[];${chaos.burst(options,Math.floor(i/burstEvery))};
  __scratch['actions'+${team}]=JSON.parse(JSON.stringify(__scratch.actions.map(a=>{if(!Array.isArray(a.unitIds)||a.unitIds.length<64)return a;const z=actionIdsEncode(a.unitIds);if(z===null)return a;const o={...a,uidz:z};delete o.unitIds;return o;})));
  actionsPrepare(__scratch['actions'+${team}]);`);
 // A player's whole selection (every unit and building) ctrl-clicked to
 // massClicks appended points, massGap steps apart, as the page sends them
 // (wire form: JSON round trip, ids compact). Outside the timing too.
 const massClick=massAt>0&&i>=massAt&&(i-massAt)%massGap===0&&(i-massAt)/massGap<massClicks?(i-massAt)/massGap:-1;
 if(massClick>=0){inst.eval(`__scratch.massActions=JSON.parse(JSON.stringify(${MASS_COMMAND}(${massClick})))`);}
 if(censusSteps.has(i))inst.eval('__scratch.census.begin()');
 const cpu0=metrics?process.cpuUsage():null;
 const a=performance.now();
 if(burst)for(let team=0;team<2;team++)inst.eval(`processActions(__scratch.actions${team},${team})`);
 if(massClick>=0)inst.eval(`if(__scratch.response&&__scratch.response.click===${massClick})__scratch.response.started=__scratch.now();processActions(__scratch.massActions,${massTeam})`);
 inst.eval(workerPost?'gameTick();simPresentTickEnd();{const t=currentTick++;__scratch.W._simPostResult(t,null,null,0);}':'gameTick();currentTick++;');
 const ms=performance.now()-a;
 if(censusSteps.has(i))inst.eval('__scratch.census.end()');
 // --dbgc (a --features=dbgc build, --helpers=0): the kernels's debug counters a step, in the row.
 // --step-eval=@file (or an expression): evaluated in the game after each step, its value in the row (ev).
 if(__stepEval)__evRow=inst.eval(__stepEval);
 if(process.argv.includes('--dbgc'))__dbgcRow=inst.eval('(()=>{const v=new Int32Array(_simWasmArgI.buffer,_simWasmArgI.byteOffset+1536*4,128);const a=Array.from(v);v.fill(0);return a;})()');
 // --heap-inventory=STEP (with SIM_HEAP_SITES=1): the wasm heap's live bytes by allocation site and every registered array by name, to <out>.heap.json.
 if(String(process.argv.find(a=>a.startsWith('--heap-inventory='))||'').slice(17).split(',').map(Number).includes(i))fs.writeFileSync(out+'.heap'+i+'.json',inst.eval(`JSON.stringify((()=>{const by=new Map();if(typeof _simHeapSiteOf!=="undefined")for(const [,e] of _simHeapSiteOf)by.set(e[0],(by.get(e[0])||0)+e[1]);const reg=Object.entries(_simParReg).filter(([k,v])=>ArrayBuffer.isView(v)).map(([k,v])=>[k,v.constructor.name,v.length,v.byteLength]).sort((x,y)=>y[3]-x[3]);const S=_simUnitState;const cols=Object.entries(S.columns).map(([k,v])=>[k,ArrayBuffer.isView(v)?v.byteLength:(v&&v.data?v.data.byteLength:0)]).sort((x,y)=>y[1]-x[1]);const sl=S.sl,ns=Math.ceil(S.owners.length/64);let empty=0,full=0,part=0,liveIn=0;for(let k=0;k<ns;k++){const f=sl.sfree[k];if(f>=64)empty++;else if(f===0)full++;else part++;}const navs=typeof _navSlots!=="undefined"&&_navSlots.slots?_navSlots.slots.map((L,p)=>L?L.map(e=>[p,e.a.length,e.off]):[]):null;return {navs,slabs:{n:ns,empty,full,part,nfree:sl.nfree},stats:simHeapStats(),cap:S.cap,slots:S.owners.length,units:units.length,sites:[...by].sort((x,y)=>y[1]-x[1]).map(([s,b])=>[b,s]),registry:reg,columns:cols};})())`));
 if(yieldBetween)await new Promise(setImmediate);
 const wallMs=performance.now()-a;
 const row={ev:__evRow,dbgc:typeof __dbgcRow!=="undefined"?__dbgcRow:undefined,step:i,ms,wallMs,gapMs:wallMs-ms,at:a,startMs:a-profileStart,burst,...inst.eval('({tick:gameTime,units:units.length,projectiles:projCount(),phases:__scratch.phases,index:__scratch.index,gameOver,work:{...__scratch.work}})')};
 // (ROWX=<js>: a diagnostic value per tick, outside the timing.)
 if(process.env.ROWX)row.x=inst.eval(process.env.ROWX);
 if(process.argv.includes('--occ-jobs'))row.occ=inst.eval('(()=>{const r=__scratch.occ;__scratch.occ=[];return r;})()');
 if(process.argv.includes('--memory-stats'))row.memory=inst.eval(`({ ...simMemoryStats(),
  navProfiles:_nav.map(n=>n?{atlas:!!n.atlas?.header,nodes:n.nodeTile.length}:null),
  navFieldBytes:_navFields.pools.reduce((n,f)=>n+(f.pool?.byteLength||0)+(f.rows?.byteLength||0),0) })`);
 row.births=row.work.spawns-previousSpawns;row.deaths=previousUnits+row.births-row.units;previousUnits=row.units;previousSpawns=row.work.spawns;
 row.towerBatch=inst.eval(`typeof _towerAcq==='undefined'?null:({queries:_towerAcq.lastN,active:_towerAcq.lastActive,used:_towerAcq.lastUsed,native:!!_towerAcq.native,prepared:_towerAcq.lastPrepared||0})`);
 row.workerBrain=inst.eval(`typeof _workerBrain==='undefined'?null:({prepared:_workerBrain.prepared,used:_workerBrain.used,misses:_workerBrain.misses,bytes:Object.values(_workerBrain.arrays).reduce((n,a)=>n+a.byteLength,0),recordBytes:_simUnitState?.wk?9*_simUnitState.wk.cap:0})`);
 if(i%10===0||i===ticks-1)row.stationary=inst.eval(`typeof _stationaryReach==='undefined'?null:(()=>{const R=_stationaryReach,A=R.active>=0?R.sets[R.active]:{},sz=s=>Object.values(s).reduce((n,a)=>n+(a&&a.byteLength||0),0);return{areas:areaNeighborIds.length,depth:R.depth,phase:R.phase,active:R.active,entries:A.meta?.[0],scratchWords:_simWasmScratchWords,bytes:(_ST.brain?.byteLength||0)+sz(R.sets[0])+sz(R.sets[1])+sz(_stationaryStats.arrays)};})()`);
 row.tileJournal=inst.eval(`({base:_teLogBase,end:typeof _teLogEnd==='number'?_teLogEnd:_teLogBase+_teLog.length,storageBytes:_teLog.byteLength||null})`);
 row.structRows=readStructRows();
 if(eventMetrics)row.events=inst.eval('__scratch.events');
 if(massAt>0&&i>=massAt-1){row.mass=inst.eval(MASS_PENDING);if(massClick>=0)row.mass.click=massClick;}
 if(followupUnits>0&&i>=massAt)row.response=inst.eval(RESPONSE_PENDING);
 if(timeline)row.intervals=inst.eval('__scratch.intervals');
 if(metrics){const m=process.memoryUsage();row.cpu=process.cpuUsage(cpu0);row.heapUsedMB=m.heapUsed/1048576;row.rssMB=m.rss/1048576;row.externalMB=m.external/1048576;row.arrayBuffersMB=m.arrayBuffers/1048576;row.freeMB=require('node:os').freemem()/1048576;}
 // Census is outside timing and intentionally sparse. Count actual targets and
 // work states rather than assuming that a spawned worker is doing useful work.
 if(census&&(i%10===0||i===ticks-1))row.activity=inst.eval(`(()=>{const roles={};for(let j=0;j<units.length;j++){const u=units[j];if(u.dead||!u.workerType)continue;const r=roles[u.workerType]||(roles[u.workerType]={total:0,targeted:0,carrying:0,coolingDown:0,states:{}});r.total++;if(u.workerTarget)r.targeted++;if(u.workerTransferCooldown>0)r.coolingDown++;if(u.carryingValue>0||u.healerHasMaterial)r.carrying++;const s=u.workerState||'NONE';r.states[s]=(r.states[s]||0)+1;}return {roles,researchQueued:[0,1].map(p=>getPlayerResearchQueueTotalLength(p)),pop:[0,1].map(p=>({count:players[p].popCount,cap:getPlayerPopCap(p)}))};})()`);
 rows.push(row);fs.appendFileSync(out+'.jsonl',JSON.stringify(row)+'\n');
 // (Between ticks, outside the timing. The harness clock is virtual, so a
 // pump call runs a whole metadata pass, not a 1 ms slice: every 5 steps.)
 if(workerPost&&i%5===4)inst.eval('simPresentationPump()');
 if(i%10===0)console.log('step',i,'ms',ms.toFixed(1),'units',row.units);
 assert.deepEqual(inst.errors.map(String),[]);assert.equal(row.gameOver,false);
}
// Capture the gameplay window, not final report construction or the optional
// exact-state hash (which materializes JS views and can allocate heavily).
if(liveHeapSession){
 const r=await new Promise((resolve,reject)=>liveHeapSession.post('HeapProfiler.stopSampling',(err,r)=>err?reject(err):resolve(r)));
 fs.writeFileSync(out+'.liveheap',JSON.stringify(r.profile));liveHeapSession.disconnect();
}
if(allocationSession){
 const r=await new Promise((resolve,reject)=>allocationSession.post('HeapProfiler.stopSampling',(err,r)=>err?reject(err):resolve(r)));
 r.profile.benchmarkInstrumentationScripts=allocationHarnessScripts;
 fs.writeFileSync(out+'.heapprofile',JSON.stringify(r.profile));allocationSession.disconnect();
}
function stats(rows){const a=rows.map(r=>r.ms).sort((a,b)=>a-b),mean=a.reduce((a,b)=>a+b,0)/a.length,tail=a.slice(Math.floor(a.length*.95));return{samples:a.length,mean,tps:1000/mean,p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],p99:a[Math.floor(a.length*.99)],p999:a[Math.floor(a.length*.999)],worst5Mean:tail.reduce((n,v)=>n+v,0)/tail.length,max:a.at(-1)};}
const steady=rows.slice(warmup);
if(gcObserver){gcEntries.push(...gcObserver.takeRecords().map(e=>({at:e.startTime,ms:e.duration,kind:e.detail.kind})));gcObserver.disconnect();for(const row of rows)row.gcMs=gcEntries.reduce((n,e)=>n+Math.max(0,Math.min(e.at+e.ms,row.at+row.wallMs)-Math.max(e.at,row.at)),0);}
const result={count,structures,workerMinimum,unitLevelOffset,ticks,warmup,helpers,dk,burstEvery,yieldBetween,profileOrigins,setup:setupSummary,node:process.version,heap:inst.eval('simHeapStats()'),jsScratch:inst.eval('({spatialCountQueueBytes:_spatialCountQ.byteLength||0,eventOrderBytes:typeof _unitEvSort!=="undefined"?[...new Set(Object.values(_unitEvSort))].reduce((n,a)=>n+(ArrayBuffer.isView(a)?a.byteLength:0),0):_unitEvKey.byteLength+_unitEvEnt.byteLength+_unitEvOrd.byteLength})'),all:stats(rows),steady:stats(steady),wall:stats(steady.map(r=>({ms:r.wallMs}))),bursts:stats(steady.filter(r=>r.burst).length?steady.filter(r=>r.burst):steady),worst:steady.slice().sort((a,b)=>b.wallMs-a.wallMs).slice(0,10),gcEntries,rows};
if(allocationSession)result.allocationWindow={firstStep:warmup,lastStep:ticks-1,finalDiagnostics:false};
if(process.argv.includes('--hash'))result.hash=inst.eval('__exactStateHash()');
result.menuLimits={...limits,finalSlots:inst.eval('_simUnitState.cap')};
assert.ok(result.menuLimits.finalSlots<=limits.slots,'unit columns must stay within their match-start reservation');
result.projFlight=inst.eval('({..._pj.stats,notMade:_pj.cap?_pj.hdr[3]:0,fired:_pj.cap?_pj.hdr[2]:0})');result.structRows=inst.eval('typeof structRowStats!=="undefined"?structRowStats:null');
result.structRowCheckpoints={beforeGameplay:structRowsAtStart,beforeSteady:structRowsAtSteady,afterGameplay:result.structRows};
if(session)result.wasmFunctionNames=require('./wasm-profile-exports.cjs')(inst.eval(`SIM_WASM64?SIM_WASM64_BIN:SIM_WASM_BIN`));
result.layout=layout;result.towerMode=towerMode;
result.prepareMs=prepareMs;
result.tower=inst.eval(`typeof _towerAcq==='undefined'?null:({scratchBytes:Object.values(_towerAcq.arrays).reduce((n,a)=>n+a.byteLength,0)})`);
result.population={min:Math.min(...steady.map(r=>r.units)),max:Math.max(...steady.map(r=>r.units)),births:steady.reduce((n,r)=>n+r.births,0),deaths:steady.reduce((n,r)=>n+r.deaths,0),work:rows.at(-1).work};
const workBefore=warmup?rows[warmup-1].work:{};
result.population.steadyWork=Object.fromEntries(Object.entries(rows.at(-1).work).map(([k,v])=>[k,v-(workBefore[k]||0)]));
result.population.measuredWallSeconds=steady.reduce((n,r)=>n+r.wallMs,0)/1000;
result.population.workPerWallSecond=Object.fromEntries(Object.entries(result.population.steadyWork).map(([k,v])=>[k,v/result.population.measuredWallSeconds]));
result.phases={};for(const r of steady)for(const [name,ms]of Object.entries(r.phases))result.phases[name]=(result.phases[name]||0)+ms/steady.length;
result.outliers={over500ms:steady.filter(r=>r.wallMs>500).length,overMedian1_5:steady.filter(r=>r.wallMs>result.wall.p50*1.5).length,maxToMedian:result.wall.max/result.wall.p50};
result.outliers.thresholds=Object.fromEntries([500,833.3333333333,1000,1500,2000].map(ms=>[String(ms),steady.filter(r=>r.wallMs>ms).length]));
result.outliers.excessOverMedian1_5Ms=steady.reduce((n,r)=>n+Math.max(0,r.wallMs-result.wall.p50*1.5),0);
result.gameplay={...stats(rows.map(r=>({ms:r.wallMs}))),note:'All ticks after setup, including warmup; see wall for the separately selected steady window.'};
fs.writeFileSync(out,JSON.stringify(result,null,2));
if(censusSteps.size)fs.writeFileSync(out+'.census.json',inst.eval(`JSON.stringify(__scratch.census.report(${JSON.stringify([...censusSteps])}))`));
if(session)session.post('Profiler.stop',(err,r)=>{if(err)throw err;fs.writeFileSync(out+'.cpuprofile',JSON.stringify(r.profile));session.disconnect();});
if(profileHelpers)await Promise.all((require('./real-sim-helper.cjs').instances||[]).map(async(w,i)=>{const r=await w.benchProfile('stop');fs.writeFileSync(out+'.helper'+i+'.cpuprofile',JSON.stringify(r.profile));}));
console.log(JSON.stringify({all:result.all,steady:result.steady,wall:result.wall,outliers:result.outliers,bursts:result.bursts,out}));
process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
