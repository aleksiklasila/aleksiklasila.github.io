'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'test-runs/collision-tps-20261020');
const names=['baseline','rounding','simd-budget8','paged-budget8','shared-hot','cached-stats-final','direct-stats-final','removed-cache-final','cached-monitored','removed-monitored','cached-budget4-monitored','removed-budget4-monitored','cached-final-monitored','removed-final-monitored','cached-compact-monitored','removed-compact-monitored','removed-rowcheck-monitored','cached-rowcheck-monitored'];
const avg=a=>a.length?a.reduce((a,b)=>a+b,0)/a.length:null;
const statNames=new Set(['mvSpd','mvCost','mvChs','cbRange','atkCd','atkDmg'].map(k=>'unit.'+k));
const rows=[];
for(const name of names){
 const file=path.join(root,name+'.json');if(!fs.existsSync(file))continue;
 const r=JSON.parse(fs.readFileSync(file,'utf8'));if(!r.tps)continue;
 const before=r.resourceUsage?.before,after=r.resourceUsage?.after;
 let paging=[];const pf=path.join(root,name.replace(/-monitored$/,'-paging')+'.jsonl');
 if(fs.existsSync(pf))paging=fs.readFileSync(pf,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(p=>p.at>=r.measuredStart&&p.at<=r.measuredEnd);
 rows.push({name,ticks:r.ticks,contactBudget:r.contactBudget??null,tickMs:r.tickMs.mean,tps:r.tps,finalUnits:r.final.units,
  movementMs:r.phases['simParallelRun:8'],waitMs:r.phases.simParallelBackgroundWait,
  liveWasmMiB:r.timeline.at(-1).heap.liveMB,meanJsHeapMiB:avg(r.timeline.map(t=>t.memory.heapUsed/1048576)),meanRssMiB:avg(r.timeline.map(t=>t.memory.rss/1048576)),
  staticCacheMiB:r.bindings.filter(e=>statNames.has(e.name)).reduce((n,e)=>n+e.bytes,0)/1048576,
  processTotalPageFaults:before?after.majorPageFault-before.majorPageFault:null,
  processCpuMsPerTick:before?((after.userCPUTime-before.userCPUTime)+(after.systemCPUTime-before.systemCPUTime))/1000/r.ticks:null,
  pagingSamples:paging.length,systemPaging:paging.length?{pageReadsPerSec:avg(paging.map(p=>p.pageReadsPerSec)),pageWritesPerSec:avg(paging.map(p=>p.pageWritesPerSec)),pagesInPerSec:avg(paging.map(p=>p.pagesInputPerSec)),pagesOutPerSec:avg(paging.map(p=>p.pagesOutputPerSec)),minimumAvailableMiB:Math.min(...paging.map(p=>p.availableMiB))}:null});
}
fs.writeFileSync(path.join(root,'comparison.json'),JSON.stringify(rows,null,2)+'\n');
const fmt=v=>v==null?'—':v.toFixed(2);
let md='# All retained benchmark runs\n\nRuns have different tick counts/contact budgets; compare matched workloads. All actual paging and stalls remain included. `static cache` means the six removed Float32 arrays, not all unit memory.\n\n| Run | Ticks | Contact budget | ms/tick | TPS | Live WASM MiB | Mean JS heap MiB | Static cache MiB |\n|---|---:|---:|---:|---:|---:|---:|---:|\n';
for(const r of rows)md+=`| ${r.name} | ${r.ticks} | ${r.contactBudget??'—'} | ${fmt(r.tickMs)} | ${fmt(r.tps)} | ${fmt(r.liveWasmMiB)} | ${fmt(r.meanJsHeapMiB)} | ${fmt(r.staticCacheMiB)} |\n`;
md+='\nMeasured Windows paging during tick windows (system-wide, competing applications included):\n\n| Run | Process total page faults | Page reads/s | Page writes/s | Pages in/s | Pages out/s | Min available MiB |\n|---|---:|---:|---:|---:|---:|---:|\n';
for(const r of rows)if(r.systemPaging){const p=r.systemPaging;md+=`| ${r.name} | ${r.processTotalPageFaults} | ${fmt(p.pageReadsPerSec)} | ${fmt(p.pageWritesPerSec)} | ${fmt(p.pagesInPerSec)} | ${fmt(p.pagesOutPerSec)} | ${p.minimumAvailableMiB} |\n`;}
md+='\nPage-fault values are total process faults on Windows, including soft faults. Hardware cache/DRAM traffic is unmeasured: WPR counter start returned access denied. The acquisition per-instance stat input falls from 32 bytes to 16 bytes per four units plus shared-row accesses; that is an access-size calculation, not measured bus traffic.\n';
fs.writeFileSync(path.join(root,'comparison.md'),md);console.log('Summarized '+rows.length+' runs.');
