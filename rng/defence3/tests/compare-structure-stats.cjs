'use strict';
const fs=require('node:fs'),path=require('node:path');
const dir=path.join(__dirname,'test-runs/structure-stats-20261020');
const names=['cached','aos','soa','direct-lookup','total-contact-budget','total-contact-repeat','outgoing-contact-repeat','cached-repeat'];
const rows=[];
for(const name of names){const file=path.join(dir,name+'.json');if(!fs.existsSync(file))continue;const r=JSON.parse(fs.readFileSync(file));rows.push({name,meanMs:r.tickMs.mean,tps:r.tps,p50:r.tickMs.p50,p95:r.tickMs.p95,towerMs:r.phases.towersTick,moveMs:r.phases.simMoveRun,waitMs:r.phaseSelf.simParallelBackgroundWait,contactCpuMs:(r.top.find(x=>x.name==='sep_pairs')?.selfMs||0)/r.ticks,finalUnits:r.final.units,rssMiB:r.memory.rss/1048576,heapMiB:r.memory.heapUsed/1048576,minFreeMiB:Math.min(...r.timeline.map(x=>x.freeBytes))/1048576,windowsPageFaults:r.resourceUsage.after.majorPageFault-r.resourceUsage.before.majorPageFault});}
fs.writeFileSync(path.join(dir,'comparison.json'),JSON.stringify(rows,null,2)+'\n');
let text='| Run | ms/tick | TPS | towers ms | contacts CPU ms | waits ms | final units |\n|---|---:|---:|---:|---:|---:|---:|\n';
for(const r of rows)text+='| '+[r.name,r.meanMs.toFixed(2),r.tps.toFixed(3),r.towerMs.toFixed(2),r.contactCpuMs.toFixed(2),r.waitMs.toFixed(2),r.finalUnits].join(' | ')+' |\n';
fs.writeFileSync(path.join(dir,'comparison.md'),text);console.log(text);
