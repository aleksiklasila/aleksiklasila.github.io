// Summarize --allocation-profile output, separating synthetic input generation.
// node tests/chaos-allocation-profile.cjs tests/test-runs/.../run.json
'use strict';
const fs=require('node:fs'),path=require('node:path');
const input=path.resolve(process.argv[2]);
const file=input.endsWith('.heapprofile')?input:input+'.heapprofile';
const profile=JSON.parse(fs.readFileSync(file));
const functions=new Map(),categories={simulation:0,syntheticInputs:0,harnessAndOther:0};
const sampledRows=new Map();
let instrumentationInSimulation=0;
function visit(node,parents,instrumentation=false){
 const name=node.callFrame.functionName||'(anonymous)',stack=[...parents,name];
 const category=stack.includes('chaosBurst')?'syntheticInputs':stack.some(n=>['gameTick','_gameTickBody','processActions','_processActions'].includes(n))?'simulation':'harnessAndOther';
 const {scriptId}=node.callFrame,url=profile.benchmarkInstrumentationScripts?.[scriptId]||node.callFrame.url;
 // Native and Node built-in frames inherit the origin of their JS caller.
 if(scriptId!=='0'&&!url.startsWith('node:')) instrumentation=url.includes('chaos-bench-instrumentation-');
 const taggedHarness=category==='simulation'&&instrumentation;
 if(taggedHarness)instrumentationInSimulation+=node.selfSize;
 categories[category]+=node.selfSize;
 const key=category+'|'+name+'|'+node.callFrame.lineNumber+'|'+taggedHarness;
 const row=functions.get(key)||{category,name,line:node.callFrame.lineNumber+1,bytes:0,exampleStack:stack.slice(-6)};
 if(taggedHarness)row.benchmarkInstrumentation=true;
 row.bytes+=node.selfSize;functions.set(key,row);
 if(node.selfSize)sampledRows.set(node.id,row);
 for(const child of node.children||[])visit(child,stack,instrumentation);
}
visit(profile.head,[]);
const mib=bytes=>bytes/1048576;
for(const sample of profile.samples||[]){
 const row=sampledRows.get(sample.nodeId);
 if(!row)continue;
 row.sampleCount=(row.sampleCount||0)+1;
 row.largestSampleMiB=Math.max(row.largestSampleMiB||0,mib(sample.size));
}
const result={note:'Estimated sampled allocations, including collected objects; not live heap size. Simulation includes tagged benchmark instrumentation for historical comparability. Untagged captures cannot break it out. Synthetic inputs are outside tick timing but can cause later GC.',categoriesMiB:Object.fromEntries(Object.entries(categories).map(([k,v])=>[k,mib(v)])),instrumentationInSimulationMiB:mib(instrumentationInSimulation),functions:[...functions.values()].sort((a,b)=>b.bytes-a.bytes).map(({bytes,...row})=>({...row,estimatedMiB:mib(bytes)}))};
fs.writeFileSync(file+'.analysis.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,functions:result.functions.slice(0,20)},null,2));
