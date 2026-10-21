'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const read=n=>JSON.parse(fs.readFileSync(path.join(__dirname,n+'.json'),'utf8'));
const q64=read('quality-final64'),q32=read('quality-final32');
assert.equal(q64.results.length,q32.results.length);
for(let j=0;j<q64.results.length;j++)for(const key of ['scenario','budget','targetChecksum','eligible','found','coverageOverFourSamplesPercent','meanExactDistancePx','meanSampleDistancePx'])assert.equal(q64.results[j][key],q32.results[j][key],key+' case '+j);
const rows=[['exact',['exact-1m','exact-1m-repeat']],['4 candidates',['sample4-1m','sample4-1m-repeat']],['16 candidates',['sample16-1m']],['64 candidates',['sample64-1m']]].map(([variant,files])=>{
 const runs=files.map(read),ticks=runs.reduce((n,r)=>n+r.ticks,0),meanMs=runs.reduce((n,r)=>n+r.tickMs.mean*r.ticks,0)/ticks;
 assert.ok(runs.every(r=>r.occupancyAuditResult.ok));
 if(runs.length>1)assert.deepEqual(runs[0].final,runs[1].final,'repeat result '+variant);
 return{variant,runs:runs.length,ticks,meanMs,tps:1000/meanMs,survivors:runs[0].final.units,finalHash:runs[0].final.hash,liveMiB:runs[0].timeline[0].heap.liveMB,minAvailableMiB:Math.min(...runs.flatMap(r=>r.timeline.map(t=>t.freeBytes/1048576)))};
});
for(const row of rows)row.tpsGainPercent=100*(row.tps/rows[0].tps-1);
const report={wholeSimulation:rows,quality:q64.results,wasm32MatchesWasm64:true};
fs.writeFileSync(path.join(__dirname,'summary.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(rows,null,2));
console.log('PASS: identical sampled choices in WASM32/64, repeated runs reproduce full final state, occupancy audits pass.');
