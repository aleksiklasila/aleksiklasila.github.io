'use strict';
const fs=require('node:fs'),path=require('node:path'),{performance}=require('node:perf_hooks');
const arg=(key,fallback)=>process.argv.find(a=>a.startsWith('--'+key+'='))?.slice(key.length+3)??fallback;
const root='tests/test-runs/crowd-front-20261021',out=arg('out',root+'/latest.json');
const helpers=Number(arg('helpers',7)),ticks=Number(arg('ticks',60)),warmup=Number(arg('warmup',3)),dk=Number(arg('dk',20));
const overrides=JSON.parse(process.env.DEFENCE_TEST_SOURCE_OVERRIDES||'{}');
if(process.argv.includes('--baseline')){
 const walk=(dir,pre='')=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=pre+e.name;if(e.isDirectory())walk(path.join(dir,e.name),p+'/');else overrides[p]=dir+'/'+e.name;}};
 walk(root+'/baseline');
}
if(arg('wasm64',null))overrides['src/sim/sim_wasm64_bin.js']=arg('wasm64');
process.env.DEFENCE_TEST_SOURCE_OVERRIDES=JSON.stringify(overrides);
if(helpers)globalThis.self={crossOriginIsolated:true};
const H=require('./net-harness.cjs'),RealWorker=require('./real-sim-helper.cjs');
fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out+'.jsonl','');
const log=value=>{fs.appendFileSync(out+'.jsonl',JSON.stringify(value)+'\n');console.error(JSON.stringify(value));};
const session=new(require('node:inspector').Session)(),post=(method)=>new Promise((resolve,reject)=>session.post(method,(e,r)=>e?reject(e):resolve(r)));
(async()=>{
 const began=performance.now(),world=new H.World(),i=world.spawn('front',{simWorker:false});
 if(process.argv.includes('--short-reach'))i.eval('for(const [key,def]of Object.entries(THING_STATS))if(def.stats.attackRange?.base>0)def.stats.attackRange.softCap=key==="sniper"?1.6:key==="watch_tower"?2:1;');
 i.eval(`if(typeof SIM_TRAFFIC_MODE!=='undefined')SIM_TRAFFIC_MODE=${Number(arg('mode',3))};`);
 i.eval(`if(typeof SIM_TRAFFIC_RESPONSE!=='undefined')SIM_TRAFFIC_RESPONSE=${Number(arg('response',1))};`);
 i.eval(`if(typeof SIM_TRAFFIC_PASSES!=='undefined')SIM_TRAFFIC_PASSES=${Number(arg('passes',2))};`);
 i.eval(`if(typeof SIM_TRAFFIC_LOCAL!=='undefined')SIM_TRAFFIC_LOCAL=${Number(arg('local',1))};`);
 if(helpers){i.scratch.Worker=RealWorker;i.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=16;simParallelInit('',${helpers});`);}
 let records=JSON.parse(require('node:zlib').gunzipSync(fs.readFileSync(arg('scene','tests/4M-1K-stuck2.gz'))));
 if(process.argv.includes('--current-balance'))records[0].settings.editableConfig.tables=i.eval('serializeEditableRuntimeConfigForTransport().tables');
 if(process.argv.includes('--max-stats')){
  const levels=i.eval(`(()=>{const out={};for(const [kind,keys,stats]of [['unit',BASE_UNIT_STATS,PRECOMPUTED_UNIT_STAT_KEYS],['building',BASE_CARD_TYPES,PRECOMPUTED_BUILDING_STAT_KEYS]])for(const key of Object.keys(keys))for(const stat of stats)out[makeResearchLevelId(kind,key,stat)]=MAX_RESEARCH_LEVEL;return out;})()`);
  for(const record of records){
   for(const p of record.players||[]){p.researchLevels={...levels};p.researchOrders=[];p.energy=p.astar=1e20;}
   for(const u of record.units||[]){u[5]=20;u[6]=524288;u[4]=1e20;}
   for(const b of record.buildings||[]){b[4]=524288;b[5]=1e20;b[11]=null;}
  }
 }
 const width=records[0].width;let goals=[];
 for(const r of records)for(const u of r.units||[])goals.push(u[7]?u[7][2]*width+u[7][1]+1:0);
 i.scratch.records=records;
 i.scratch.scene=i.eval('(()=>{const r=soloSceneReader();for(const a of __scratch.records)r.line(JSON.stringify(a));return r.finish();})()');
 i.scratch.records=null;i.scratch.goals=Int32Array.from(goals);
 i.eval('startMainThreadLoops=()=>{};document.getElementById("starting-resources-popup").classList.add("hidden")');
 let done=false,error;i.eval('restoreSoloGameSnapshot(__scratch.scene)').then(()=>done=true,e=>{error=e;done=true;});
 while(!done)await world.run(20);if(error)throw error;i.scratch.scene=null;
 records=null;goals=null;
 i.scratch.now=()=>performance.now();
 i.eval(`performance.now=__scratch.now;simDk=${dk};__scratch.tracked=units.slice();__scratch.initial=new Float32Array(units.length);
  for(let k=0;k<units.length;k++)if(__scratch.goals[k]){const g=__scratch.goals[k]-1,u=units[k];__scratch.initial[k]=Math.hypot(u.x-(g%GRID_W+.5)*TILE,u.y-(Math.floor(g/GRID_W)+.5)*TILE);}`);
 if(process.argv.includes('--max-stats'))i.eval('for(const u of units)u.energy=u.maxEnergy;for(const b of getCellItemsRowMajor())if(Number.isFinite(b.maxEnergy))b.energy=b.maxEnergy;');
 log({stage:'restored',units:i.eval('units.length'),helpers,maxStats:process.argv.includes('--max-stats'),currentBalance:process.argv.includes('--current-balance'),loadMs:performance.now()-began,stats:i.eval('({research:getPlayerResearchLevel(0,"unit","norm","atkCd"),range:getUnitStatForOwner(0,"scout",20,"attackRange"),cooldown:getUnitStatForOwner(0,"norm",20,"atkCd")})')});
 for(let t=0;t<warmup;t++){const a=performance.now();i.eval('gameTick();currentTick++');log({warmup:t+1,ms:performance.now()-a});}
 i.eval(`__scratch.phases={};__scratch.phaseSelf={};__scratch.phaseStack=[];
  for(const name of ['spatialIndexRebuild','navTick','navFieldsFlush','recalculateUnitEffectiveLevel','updateAllPlayerVisibility','towersTick','statusPrepassRun','unitPassBegin','simMoveRun','combatScanRun','_forEachUnitInTickOrder','unitHitsResolve','unitRetirePrepare','simParallelRun','simParallelBackgroundWait','simUnitStateCollect','occupancyPrepareMovement','spawnerStructuresTick','processGlobalSpawnerQueue']){
   const original=eval(name),wrapped=function(){const stack=__scratch.phaseStack,frame={start:__scratch.now(),child:0};stack.push(frame);try{return original.apply(this,arguments);}finally{const dt=__scratch.now()-frame.start;stack.pop();const label=name==='simParallelRun'?name+':'+arguments[0]:name;__scratch.phases[label]=(__scratch.phases[label]||0)+dt;__scratch.phaseSelf[label]=(__scratch.phaseSelf[label]||0)+dt-frame.child;if(stack.length)stack[stack.length-1].child+=dt;}};eval(name+'=wrapped');
  }`);
 if(process.argv.includes('--profile')){session.connect();await post('Profiler.enable');await post('Profiler.start');await Promise.all((RealWorker.instances||[]).map(w=>w.benchProfile('start')));}
 const samples=[],timings=[];
 for(let t=0;t<ticks;t++){
  const a=performance.now();i.eval('gameTick();currentTick++');const ms=performance.now()-a;timings.push(ms);log({tick:t+1,ms});
  if((t+1)%10===0||t===ticks-1){
   const sample=i.eval(`(()=>{
    const c=_simUnitState.columns,modes={},onCounts={},speedBins=[0,0,0,0,0],perMode={};let ordered=0,moving=0,distance=0,netGoalProgress=0;
    for(const u of units){if(u.dead)continue;const s=u._si,cm=c.cmMode[s]&3,mode=cm===1?'hold':cm===2?'chase':((c.mvOn[s]===1||c.mvOn[s]===6)&&(c.mvFlags[s]&64))?'flow':c.mvOn[s]===1?'task':'other';
     modes[mode]=(modes[mode]||0)+1;
     onCounts[c.mvOn[s]]=(onCounts[c.mvOn[s]]||0)+1;
     if(mode!=='hold'&&(cm===2||c.mvOn[s]===6||u.path||u._pendingPathTarget)){
      const d=Math.hypot(u.x-u.prevX,u.y-u.prevY),spd=simUnitStatValue(c,s,0)*simDk,ratio=spd>0?d/spd:0;
      const bin=ratio<.01?0:ratio<.1?1:ratio<.5?2:ratio<.9?3:4;speedBins[bin]++;
      const b=perMode[mode]||=([]);b[bin]=(b[bin]||0)+1;ordered++;distance+=d;if(d>1)moving++;
     }
    }
    for(let k=0;k<__scratch.tracked.length;k++){const u=__scratch.tracked[k],g=__scratch.goals[k]-1;if(g>=0&&!u.dead)netGoalProgress+=__scratch.initial[k]-Math.hypot(u.x-(g%GRID_W+.5)*TILE,u.y-(Math.floor(g/GRID_W)+.5)*TILE);}
    return {ordered,moving,distance,netGoalProgress,modes,onCounts,speedBins,perMode,occupancy:occupancyStats()};
   })()`);
   samples.push({tick:t+1,...sample});log(samples.at(-1));
  }
  await new Promise(r=>setImmediate(r));
 }
 if(process.argv.includes('--profile')){
  const p=await post('Profiler.stop');session.disconnect();fs.writeFileSync(out+'.cpuprofile',JSON.stringify(p.profile));
  const ps=await Promise.all((RealWorker.instances||[]).map(w=>w.benchProfile('stop')));ps.forEach((p,k)=>fs.writeFileSync(out+'.worker-'+(k+1)+'.cpuprofile',JSON.stringify(p.profile)));
 }
 const phases=i.eval('__scratch.phases'),phaseSelf=i.eval('__scratch.phaseSelf');for(const p of [phases,phaseSelf])for(const k in p)p[k]/=ticks;
 const sorted=timings.slice().sort((a,b)=>a-b),result={scene:arg('scene','tests/4M-1K-stuck2.gz'),helpers,ticks,warmup,dk,tickMs:{mean:timings.reduce((a,b)=>a+b,0)/ticks,p50:sorted[sorted.length>>1]},phases,phaseSelf,samples,audit:i.eval('occupancyAudit()'),errors:i.errors.map(String),memory:process.memoryUsage()};
 fs.writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 if(!result.audit.ok||result.errors.length)throw Error('Simulation validation failed');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await Promise.all((RealWorker.instances||[]).map(w=>w.terminate()));});
