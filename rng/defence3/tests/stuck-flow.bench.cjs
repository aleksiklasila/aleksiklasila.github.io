'use strict';
const fs=require('node:fs'),{performance}=require('node:perf_hooks'),assert=require('node:assert/strict');
if(process.argv.includes('--baseline'))process.env.DEFENCE_TEST_SOURCE_OVERRIDES=JSON.stringify({
 'src/sim/sim_wasm64_bin.js':'tests/test-runs/crowd-flow-20261021/baseline-wasm64.js',
 'src/sim/sim_wasm_bin.js':'tests/test-runs/crowd-flow-20261021/baseline-wasm.js'
});
const H=require('./net-harness.cjs');
const progress='tests/test-runs/crowd-flow-20261021/'+(process.argv.includes('--baseline')?'baseline':'current')+'-stuck.progress.log';
const out=process.argv.find(a=>a.startsWith('--out='))?.slice(6);
const log=(...a)=>fs.appendFileSync(progress,a.join(' ')+'\n');
(async()=>{
 log('starting',Date.now());
 const world=new H.World(),i=world.spawn('stuck',{simWorker:false});
 log('harness ready');
 // Decode locally, then validate every record through the production reader.
 i.scratch.records=JSON.parse(require('node:zlib').gunzipSync(fs.readFileSync('tests/4M-1K-stuck.gz')));
 log('decoded',i.scratch.records.length);
 i.scratch.scene=i.eval('(()=>{const r=soloSceneReader();for(const a of __scratch.records)r.line(JSON.stringify(a));return r.finish();})()');
 i.scratch.records=null;
 i.eval('startMainThreadLoops=()=>{};document.getElementById("starting-resources-popup").classList.add("hidden")');
 console.error('Read scene',i.scratch.scene.records.reduce((n,r)=>n+(r.units?.length||0),0),'units');
 const goals=[];for(const r of i.scratch.scene.records)for(const u of r.units||[])goals.push(u[7]?u[7][2]*1000+u[7][1]+1:0);
 i.scratch.goals=Int32Array.from(goals);
 log('validated');
 // Renderer preparation uses the harness clock; pump it until import completes.
 let done=false,error;
 i.eval('restoreSoloGameSnapshot(__scratch.scene)').then(()=>done=true,e=>{done=true;error=e;});
 while(!done)await world.run(20);
 if(error)throw error;
 log('restored');
 i.scratch.scene=null;i.scratch.file=null;
 i.scratch.now=()=>performance.now();
 i.scratch.log=log;
 const result=i.eval(`(()=>{
  performance.now=__scratch.now;simDk=${Number(process.env.FLOW_DK||20)};
  const samples=[],n=units.length,goals=__scratch.goals,initial=new Float32Array(n);let total=0;
  for(let k=0;k<n;k++)if(goals[k]){
   const g=goals[k]-1;initial[k]=Math.hypot(units[k].x-(g%GRID_W+.5)*TILE,units[k].y-(Math.floor(g/GRID_W)+.5)*TILE);
  }
  // Stable references survive the game's in-place deletion/compaction.
  const tracked=units.slice();
  for(let t=0;t<${Number(process.env.FLOW_TICKS||60)};t++){
   const begin=performance.now();gameTick();currentTick++;total+=performance.now()-begin;
   if((t+1)%10===0){let moving=0,ordered=0,distance=0;
    for(const u of units){if(u.dead)continue;if(u.path||u._pendingPathTarget){ordered++;const d=Math.hypot(u.x-u.prevX,u.y-u.prevY);distance+=d;if(d>1)moving++;}}
    let netGoalProgress=0,goalSamples=0;
    for(let k=0;k<n;k++)if(goals[k]&&!tracked[k].dead){
     const u=tracked[k],g=goals[k]-1;
     netGoalProgress+=initial[k]-Math.hypot(u.x-(g%GRID_W+.5)*TILE,u.y-(Math.floor(g/GRID_W)+.5)*TILE);goalSamples++;
    }
    const sample={tick:t+1,baseTicks:(t+1)*simDk,ordered,moving,distance,netGoalProgress,goalSamples,meanTickMs:total/(t+1)};samples.push(sample);__scratch.log(JSON.stringify(sample));
   }
  }
  return {initialUnits:n,liveUnits:units.length,samples,audit:occupancyAudit(),stats:occupancyStats()};
 })()`);
 if(out)fs.writeFileSync(out,JSON.stringify(result,null,2));
 console.log(JSON.stringify(result,null,2));assert.ok(result.audit.ok);assert.deepEqual(i.errors.map(String),[]);
})().catch(e=>{console.error(e);process.exitCode=1;});
