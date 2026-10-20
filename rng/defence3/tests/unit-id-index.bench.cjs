// Isolated lookup storage cost; run each backend in a fresh process.
// node --expose-gc tests/unit-id-index.bench.cjs map|paged [count=4000000]
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {performance}=require('node:perf_hooks');
if(!global.gc)throw Error('Run with --expose-gc');
const backend=process.argv[2]||'paged',count=Number(process.argv[3])||4000000;
const Index=new Function(fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8').match(/^class UnitIdIndex \{[\s\S]*?^\}/m)[0]+';return UnitIdIndex;')();
global.gc();const before=process.memoryUsage().heapUsed;
const index=backend==='map'?new Map():new Index(),unit={id:1};
const start=performance.now();for(let id=0;id<count;id++)index.set(id,unit);
const buildMs=performance.now()-start;
global.gc();const heapBytes=process.memoryUsage().heapUsed-before;
const queryStart=performance.now();let found=0;
for(let id=0;id<count;id++)if(index.get(id)===unit)found++;
if(found!==count||index.size!==count)throw Error('lookup mismatch');
console.log(JSON.stringify({backend,count,buildMs,lookupMs:performance.now()-queryStart,heapBytes}));
