'use strict';
// Replay the production work-readiness rule against retained raw tick traces.
// This validates the selected boundary; it is not a browser latency measurement.
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/utils/utils_networking.js'),'utf8');
const ctx=vm.createContext({});
vm.runInContext(source.match(/const MATCH_INIT_WORK_SAMPLES = \d+;/)[0] + '\n' +
    source.slice(source.indexOf('function matchInitializationWorkSettled('),source.indexOf('function matchInitializationNoteTick(')),ctx);
const summaries=[];
for(const file of process.argv.slice(2)) {
    const d=JSON.parse(fs.readFileSync(file)),rows=d.rows;
    const boundary=rows.findIndex((r,i)=>ctx.matchInitializationWorkSettled(rows.slice(0,i+1).map(x=>x.ms)))+1;
    if(!boundary || boundary>=rows.length) throw new Error('No measured post-initialization ticks: '+file);
    const after=rows.slice(boundary), values=after.map(r=>r.ms).sort((a,b)=>a-b);
    const mean=values.reduce((s,v)=>s+v,0)/values.length;
    const q=p=>values[Math.min(values.length-1,Math.ceil(values.length*p)-1)];
    const seconds=after.reduce((s,r)=>s+r.wallMs,0)/1000;
    const work=Object.fromEntries(Object.entries(rows.at(-1).work).map(([k,v])=>[k,v-(rows[boundary-1].work[k]||0)]));
    // Population falls during chaos runs, so the whole-run mean understates
    // the cost at the boundary. Also compare with the next ticks (same scale).
    const near=after.slice(1,21), nearMean=near.reduce((s,r)=>s+r.ms,0)/Math.max(1,near.length);
    summaries.push({file,ticks:rows.length,boundary,initialMs:rows[0].ms,firstGameplayMs:after[0].ms,mean,
        firstToMean:after[0].ms/mean,next20Mean:nearMean,firstToNext20:after[0].ms/nearMean,p95:q(.95),p99:q(.99),max:q(1),
        over150ms:values.filter(v=>v>150).length,overMean1_5:values.filter(v=>v>mean*1.5).length,
        population:{min:Math.min(...after.map(r=>r.units)),max:Math.max(...after.map(r=>r.units)),
            births:after.reduce((s,r)=>s+r.births,0),deaths:after.reduce((s,r)=>s+r.deaths,0)},
        work,measuredWallSeconds:seconds,workPerWallSecond:Object.fromEntries(Object.entries(work).map(([k,v])=>[k,v/seconds]))});
}
console.log(JSON.stringify(summaries,null,2));
