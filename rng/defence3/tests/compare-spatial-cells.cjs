'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const dir=path.join(__dirname,'test-runs/spatial-cells-20261021'),rows=[];
for(const name of fs.readdirSync(dir).filter(n=>/^cell-\d+[^.]*\.json$/.test(n))){
 const file=path.join(dir,name),r=JSON.parse(fs.readFileSync(file));
 if(!fs.existsSync(file+'.analysis.json')){
  const p=cp.spawnSync(process.execPath,[path.join(__dirname,'analyze-contact-trace.cjs'),file],{encoding:'utf8',maxBuffer:16e6});
  if(p.status!==0)throw Error(p.stderr||p.stdout);
 }
 const a=JSON.parse(fs.readFileSync(file+'.analysis.json'));
 const k=n=>a.kernels.find(k=>k.name===n);
 rows.push({name,cellTiles:r.chunkSize,cellCount:Math.ceil(r.initial.map[0]/r.chunkSize)*Math.ceil(r.initial.map[1]/r.chunkSize),
  meanMs:r.tickMs.mean,p50:r.tickMs.p50,p95:r.tickMs.p95,tps:r.tps,
  spatialMs:r.phaseSelf.spatialIndexRebuild,fullWaitMs:r.phaseSelf.simParallelBackgroundWait,atomicWaitMs:a.atomicMsPerTick,
  moveMs:r.phases['simParallelRun:8'],towerMs:r.phaseSelf.towersTick,
  pairThreadMs:k('SEP_PAIRS')?.threadMsPerTick,pairMainMs:k('SEP_PAIRS')?.mainMsPerTick,pairChunkP50:k('SEP_PAIRS')?.p50ChunkMs,
  acquisitionThreadMs:k('ACQ_SCAN')?.threadMsPerTick,indexMergeThreadMs:k('IXD_MERGE')?.threadMsPerTick,
  wasmLiveMiB:r.timeline.at(-1).heap.liveMB,wasmReservedMiB:r.timeline.at(-1).heap.memoryMB,
  rssMiB:a.rssMiB,minFreeMiB:a.minFreeMiB,meanPageReadsPerSec:a.paging.meanReadsPerSec,
  firstMeasuredUnits:r.timeline[0].units,finalUnits:r.final.units,finalHash:r.final.hash,
  warmupMs:r.warmupMs,measuredStart:r.measuredStart});
}
rows.sort((a,b)=>a.measuredStart-b.measuredStart);
fs.writeFileSync(path.join(dir,'comparison.json'),JSON.stringify(rows,null,2)+'\n');
let md='| Run | Cell tiles | Mean ms | TPS | Index ms | Pair thread-ms | Acquire thread-ms | WASM live MiB | Survivors |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n';
for(const r of rows)md+='| '+[r.name,r.cellTiles,r.meanMs.toFixed(1),r.tps.toFixed(3),r.spatialMs.toFixed(1),r.pairThreadMs?.toFixed(1),r.acquisitionThreadMs?.toFixed(1),r.wasmLiveMiB,r.finalUnits].join(' | ')+' |\n';
fs.writeFileSync(path.join(dir,'comparison.md'),md);console.log(md);
