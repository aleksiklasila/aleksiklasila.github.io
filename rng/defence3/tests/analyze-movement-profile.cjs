'use strict';
const fs=require('node:fs'),path=require('node:path');
const input=process.argv[2];if(!input)throw Error('Usage: node tests/analyze-movement-profile.cjs run.json');
const r=JSON.parse(fs.readFileSync(input,'utf8')),totals=new Map(),movement=new Map();let totalUs=0,moveUs=0;
const names=['MoveGrid','free_special','mark_special','free_r','mark_r','clear_or_mark','motion','3occ4free','checked_position','commit_step','move_job','move_span','step4','combat4','park4','idle4','step_slot','step_flow','move_pre','move_combat','move_flow','move_path','epi_slot','epi_begin','epi_end','Mv4load','mv_move_occupancy'];
const label=n=>names.find(s=>n.includes(s))||n;
const profiles=[input+'.cpuprofile',...Array.from({length:r.helpers},(_,j)=>input+'.worker-'+(j+1)+'.cpuprofile')].filter(f=>fs.existsSync(f));
for(const file of profiles){
 const p=JSON.parse(fs.readFileSync(file,'utf8')),nodes=new Map(p.nodes.map(n=>[n.id,n])),parents=new Map();
 for(const n of p.nodes)for(const c of n.children||[])parents.set(c,n.id);
 for(let j=0;j<p.samples.length;j++){
  const dt=p.timeDeltas[j],node=nodes.get(p.samples[j]),fn=node.callFrame.functionName,key=label(fn);totalUs+=dt;
  totals.set(key,(totals.get(key)||0)+dt);
  const chain=[];for(let id=node.id;id;id=parents.get(id))chain.push(nodes.get(id).callFrame.functionName);
  if(chain.some(n=>n.includes('move_job')||n.includes('mv_move_occupancy'))){moveUs+=dt;movement.set(key,(movement.get(key)||0)+dt);}
 }
}
const top=m=>[...m].map(([name,us])=>({name,cpuMsPerTick:us/1000/r.ticks,percent:100*us/(m===movement?moveUs:totalUs)})).sort((a,b)=>b.cpuMsPerTick-a.cpuMsPerTick).slice(0,40);
let jobs=null;
if(fs.existsSync(input+'.trace.json')){
 const tr=JSON.parse(fs.readFileSync(input+'.trace.json','utf8'));
 const perThread=tr.threads.map((flat,thread)=>{const times=[];for(let i=0;i<flat.length;i+=6)if(flat[i]===0&&flat[i+3]===89)times.push(flat[i+2]-flat[i+1]);times.sort((a,b)=>a-b);return {thread,jobs:times.length,totalJobWallMs:times.reduce((s,v)=>s+v,0),p50:times[times.length>>1],p95:times[Math.floor(times.length*.95)],max:times.at(-1)};});
 const main=tr.threads[0],phases=[];let wait=0;
 for(let i=0;i<main.length;i+=6)if(main[i]===3&&main[i+3]===89)phases.push([main[i+1],main[i+2]]);
 for(let i=0;i<main.length;i+=6)if(main[i]===4&&phases.some(([a,b])=>main[i+1]>=a&&main[i+2]<=b))wait+=main[i+2]-main[i+1];
 const wall=phases.reduce((s,[a,b])=>s+b-a,0),work=perThread[0].totalJobWallMs;
 jobs={perThread,truncated:tr.truncatedThreads,mainPerTick:{scheduledWallMs:wall/r.ticks,executingJobsWallMs:work/r.ticks,atomicWaitWallMs:wait/r.ticks,schedulerOtherWallMs:(wall-work-wait)/r.ticks}};
}
const counters=r.movementCounters?r.movementCounters[0].map((_,j)=>r.movementCounters.reduce((sum,a)=>sum+a[j],0)/r.ticks):null;
const report={input,ticks:r.ticks,profiledThreads:profiles.length,tickMs:r.tickMs,phases:r.phases,phaseSelf:r.phaseSelf,
 movementCpuMsPerTick:moveUs/1000/r.ticks,topMovement:top(movement),topAll:top(totals),jobs,countersPerTick:counters,
 counterNames:{0:'lanes seen by non-idle groups',1:'lanes completed by vector paths',2:'combat4 lanes',3:'park4 lanes',4:'scalar mvOn0',5:'scalar flow',6:'scalar park',7:'scalar hold',8:'scalar chase',9:'scalar structure hold',10:'scalar approach',11:'scalar brain',12:'scalar dead',13:'scalar step already ran',14:'scalar move_flow calls',15:'scalar move_path calls',18:'navigation look-cache probes',19:'idle4 lanes',20:'steady candidates',21:'steady expired',22:'steady state rejected',23:'steady tile cross',24:'steady field rejected',25:'flow without flag64',26:'steady no energy/index',27:'steady wrong committed tile',28:'steady wrong floor',29:'steady hostile floor',30:'steady open tile cross',32:'scalar fallback lanes'}};
Object.assign(report.counterNames,{34:'shots recorded inside vector combat',35:'SIMD hold lanes',36:'SIMD wall-slide lanes',37:'hold groups with changed position/velocity',38:'hold groups skipping unchanged stores',40:'occupancy free queries',41:'occupancy sweep calls',42:'same-cell sweep accepts',43:'x-slide retries',44:'y-slide retries',45:'footprints painted',46:'footprints cleared',48:'blocked axial moves skipping redundant retries',49:'radius-2 fringe queries',50:'vertical fringe queries',51:'horizontal fringe queries',52:'diagonal fringe queries'});
const out=input+'.analysis.json';fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({out,movementCpuMsPerTick:report.movementCpuMsPerTick,topMovement:report.topMovement.slice(0,12),countersPerTick:counters,jobs},null,2));
