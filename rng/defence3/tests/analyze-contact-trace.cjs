'use strict';
const fs=require('node:fs');
const file=process.argv[2];
if(!file)throw Error('Usage: node tests/analyze-contact-trace.cjs result.json');
const result=JSON.parse(fs.readFileSync(file)),trace=JSON.parse(fs.readFileSync(file+'.trace.json'));
if(trace.truncatedThreads?.length)throw Error('Incomplete contact trace: threads '+trace.truncatedThreads.join(', '));
const names=Object.fromEntries(Object.entries(trace.kernels).map(([k,v])=>[v,k.replace('SIM_KERNEL_','')]));
const threads=trace.threads.map((flat,thread)=>Array.from({length:flat.length/6},(_,i)=>{
 const [kind,start,end,a,b,tick]=flat.slice(i*6,i*6+6);return {thread,kind,start,end,a,b,tick,ms:end-start};
}));
const events=threads.flat(),kernelEvents=events.filter(e=>e.kind===0);
const quantile=(a,q)=>a.length?[...a].sort((a,b)=>a-b)[Math.min(a.length-1,Math.floor(a.length*q))]:0;
const sum=a=>a.reduce((a,b)=>a+b,0),overlap=(a,b)=>Math.max(0,Math.min(a.end,b.end)-Math.max(a.start,b.start));
const kernels=Object.entries(Object.groupBy(kernelEvents,e=>e.a)).map(([id,rows])=>({
 id:Number(id),name:names[id],chunks:rows.length,threadMsPerTick:sum(rows.map(e=>e.ms))/result.ticks,
 mainMsPerTick:sum(rows.filter(e=>e.thread===0).map(e=>e.ms))/result.ticks,
 p50ChunkMs:quantile(rows.map(e=>e.ms),.5),p95ChunkMs:quantile(rows.map(e=>e.ms),.95),maxChunkMs:rows.reduce((m,e)=>Math.max(m,e.ms),0),
 threadMs:threads.map(t=>sum(t.filter(e=>e.kind===0&&e.a===Number(id)).map(e=>e.ms))),
 threadChunks:threads.map(t=>t.filter(e=>e.kind===0&&e.a===Number(id)).length)
})).sort((a,b)=>b.threadMsPerTick-a.threadMsPerTick);
const main=threads[0],mainKernels=main.filter(e=>e.kind===0),atomic=main.filter(e=>e.kind===4);
const waits=main.filter(e=>e.kind===1||e.kind===2).map(w=>({
 ...w,kernelMs:sum(mainKernels.map(e=>overlap(w,e))),atomicMs:sum(atomic.map(e=>overlap(w,e))),
 kernels:Object.fromEntries(Object.entries(Object.groupBy(mainKernels.filter(e=>overlap(w,e)>0),e=>names[e.a])).map(([k,es])=>[k,sum(es.map(e=>overlap(w,e)))]))
}));
// Stage waits may delegate to full waits. Report each kind separately.
const waitSummary=Object.entries(Object.groupBy(waits,e=>e.kind+':lane'+e.a)).map(([name,rows])=>({name,calls:rows.length,
 wallMsPerTick:sum(rows.map(e=>e.ms))/result.ticks,kernelMsPerTick:sum(rows.map(e=>e.kernelMs))/result.ticks,
 atomicMsPerTick:sum(rows.map(e=>e.atomicMs))/result.ticks,
 kernels:Object.fromEntries(Object.entries(Object.groupBy(rows.flatMap(e=>Object.entries(e.kernels)),e=>e[0])).map(([k,es])=>[k,sum(es.map(e=>e[1]))/result.ticks]))
})).sort((a,b)=>b.wallMsPerTick-a.wallMsPerTick);
const atomicByWord=Object.entries(Object.groupBy(atomic,e=>e.a)).map(([word,rows])=>({word:Number(word),calls:rows.length,msPerTick:sum(rows.map(e=>e.ms))/result.ticks})).sort((a,b)=>b.msPerTick-a.msPerTick);
const pagingFile=file.replace(/\.json$/,'-paging.jsonl');
const paging=fs.existsSync(pagingFile)?fs.readFileSync(pagingFile,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(e=>e.at>=result.measuredStart&&e.at<=result.measuredEnd):[];
// Restrict CPU samples to the measured window. Older trace runs serialized
// logs before stopping the inspector; that post-window work is excluded here.
const cpuFile=file+'.cpuprofile';let measuredCpu=null;
if(fs.existsSync(cpuFile)){
 const p=JSON.parse(fs.readFileSync(cpuFile)),totals=new Map(),byTick=result.timeline.map(()=>new Map());let elapsed=0;
 const nodes=new Map(p.nodes.map(n=>[n.id,n]));
 let startOffsetMs=0;
 for(let i=0;i<p.samples.length&&nodes.get(p.samples[i]).callFrame.functionName==='post';i++)startOffsetMs+=p.timeDeltas[i]/1000;
 for(let i=0;i<p.samples.length;i++){
  const start=elapsed;elapsed+=p.timeDeltas[i]/1000;
  const dt=Math.max(0,Math.min(elapsed,startOffsetMs+result.measuredEnd-result.measuredStart)-Math.max(start,startOffsetMs));
  if(!dt){if(elapsed<=startOffsetMs)continue;break;}
  totals.set(p.samples[i],(totals.get(p.samples[i])||0)+dt);
  const ti=result.timeline.findIndex(e=>e.at-result.measuredStart>=start-startOffsetMs);
  if(ti>=0)byTick[ti].set(p.samples[i],(byTick[ti].get(p.samples[i])||0)+dt);
 }
 const list=m=>[...m].map(([id,ms])=>({name:nodes.get(id).callFrame.functionName,ms,msPerTick:ms/result.ticks})).sort((a,b)=>b.ms-a.ms);
 measuredCpu={windowMs:result.measuredEnd-result.measuredStart,startOffsetMs,alignment:'Leading inspector post sample excluded; then measuredStart..measuredEnd duration retained. Approximate boundaries within sampling/epoch-ms rounding.',top:list(totals).slice(0,40),byTick:byTick.map((m,i)=>({tick:i+1,top:list(m).slice(0,8)}))};
}
const report={file,ticks:result.ticks,tickMs:result.tickMs,phases:result.phases,phaseSelf:result.phaseSelf,kernels,waitSummary,atomicByWord,measuredCpu,
 atomicMsPerTick:sum(atomic.map(e=>e.ms))/result.ticks,
 paging:{samples:paging.length,meanReadsPerSec:paging.length?sum(paging.map(e=>e.pageReadsPerSec))/paging.length:null,maxReadsPerSec:paging.length?Math.max(...paging.map(e=>e.pageReadsPerSec)):null,
 meanInputPagesPerSec:paging.length?sum(paging.map(e=>e.pagesInputPerSec))/paging.length:null},
 minFreeMiB:Math.min(...result.timeline.map(e=>e.freeBytes))/1048576,
 rssMiB:result.timeline.at(-1).memory.rss/1048576,heapMiB:result.timeline.at(-1).memory.heapUsed/1048576,
 pageFaults:result.timeline.at(-1).resourceUsage.majorPageFault-result.resourceUsage.before.majorPageFault,
 top:result.top,waits:waits.filter(e=>e.ms>1)};
fs.writeFileSync(file+'.analysis.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,waits:undefined},null,2));
