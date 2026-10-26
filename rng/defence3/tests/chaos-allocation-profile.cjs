// Summarize --allocation-profile output, separating synthetic input generation.
// node tests/chaos-allocation-profile.cjs tests/test-runs/.../run.json
'use strict';
const fs=require('node:fs'),path=require('node:path');
const input=path.resolve(process.argv[2]);
const file=input.endsWith('.heapprofile')?input:input+'.heapprofile';
const profile=JSON.parse(fs.readFileSync(file));
const functions=new Map(),categories={simulation:0,syntheticInputs:0,harnessAndOther:0};
function visit(node,parents){
 const name=node.callFrame.functionName||'(anonymous)',stack=[...parents,name];
 const category=stack.includes('chaosBurst')?'syntheticInputs':stack.some(n=>['gameTick','_gameTickBody','processActions','_processActions'].includes(n))?'simulation':'harnessAndOther';
 categories[category]+=node.selfSize;
 const key=category+'|'+name+'|'+node.callFrame.lineNumber;
 const row=functions.get(key)||{category,name,line:node.callFrame.lineNumber+1,bytes:0,exampleStack:stack.slice(-6)};
 row.bytes+=node.selfSize;functions.set(key,row);
 for(const child of node.children||[])visit(child,stack);
}
visit(profile.head,[]);
const mib=bytes=>bytes/1048576;
const result={note:'Estimated sampled allocations, including collected objects; not live heap size. Synthetic inputs are outside tick timing but can cause later GC.',categoriesMiB:Object.fromEntries(Object.entries(categories).map(([k,v])=>[k,mib(v)])),functions:[...functions.values()].sort((a,b)=>b.bytes-a.bytes).map(({bytes,...row})=>({...row,estimatedMiB:mib(bytes)}))};
fs.writeFileSync(file+'.analysis.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,functions:result.functions.slice(0,20)},null,2));
