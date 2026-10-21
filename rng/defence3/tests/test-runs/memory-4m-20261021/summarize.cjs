'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../area-sample-20261021');
const names=['exact-4m-repeat','area-4m','memory-dense-exact-4m','memory-sparse-exact-4m','memory-direct-area-4m','memory-final-4m-exact','memory-final-4m-area'];
const rows=[];
for(const name of names){
    const file=path.join(root,name+'.json');if(!fs.existsSync(file))continue;
    const r=JSON.parse(fs.readFileSync(file)),paging=fs.readFileSync(path.join(root,name+'-paging.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(p=>p.at>=r.measuredStart&&p.at<=r.measuredEnd);
    const live=r.timeline.map(t=>t.heap.liveMB),rss=r.timeline.map(t=>t.memory.rss/1048576),ext=r.timeline.map(t=>t.memory.arrayBuffers/1048576);
    rows.push({name,tps:r.tps,meanMs:r.tickMs.mean,p50Ms:r.tickMs.p50,heapLiveMiB:Math.max(...live),peakRssMiB:Math.max(...rss),peakArrayBuffersMiB:Math.max(...ext),
        jsFieldMiB:r.inventory?r.inventory.jsFields.reduce((s,f)=>s+f.bytes,0)/1048576:null,
        pageReadsPerSec:paging.reduce((s,p)=>s+p.pageReadsPerSec,0)/paging.length,
        minAvailableMiB:Math.min(...paging.map(p=>p.availableMiB)),maxAvailableMiB:Math.max(...paging.map(p=>p.availableMiB)),
        finalUnits:r.final.units,hash:r.final.hash,occupancy:r.occupancyAuditResult.ok,kernel:r.timeline[0].heap.hash});
}
fs.writeFileSync(path.join(__dirname,'summary.json'),JSON.stringify(rows,null,2));console.table(rows);
