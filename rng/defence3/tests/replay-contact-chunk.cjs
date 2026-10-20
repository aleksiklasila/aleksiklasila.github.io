// Replay a real packed contact band, with its halo and initial output sums.
// Hot and rotating copies separate a small resident replay from full-world stalls.
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const args=process.argv.slice(2),file=args.find(a=>!a.startsWith('--'));
const option=(k,d)=>args.find(a=>a.startsWith('--'+k+'='))?.slice(k.length+3)??d;
if(!file)throw Error('Usage: node tests/replay-contact-chunk.cjs chunk.json [--kernel=file] [--counters] [--copies=1]');
const sample=JSON.parse(fs.readFileSync(file)),kernel=option('kernel','src/sim/sim_wasm64_bin.js');
const copies=Number(option('copies',1)),iterations=Number(option('iterations',160));
const ctx={};vm.runInNewContext(fs.readFileSync(kernel,'utf8')+';this.bin=SIM_WASM64_BIN;',ctx);
const memory=new WebAssembly.Memory({initial:4096n,maximum:262144n,address:'i64',shared:true});
const x=new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(ctx.bin,'base64')),{env:{memory}}).exports;
let at=2*1024*1024;
function alloc(Type,n){at=Math.ceil(at/64)*64;const p=at;at+=Math.max(4,n+4)*Type.BYTES_PER_ELEMENT;if(at>memory.buffer.byteLength)throw Error('Replay exceeds 256 MiB');return new Type(memory.buffer,p,n+4);}
const inputTypes={ord:Int32Array,qx:Float32Array,qy:Float32Array,qr:Float32Array,meta:Int32Array,qid:Int32Array,ekey:Int32Array,qv:Int32Array};
const outputTypes={px:Int32Array,py:Int32Array,ov:Float32Array,hit:Uint32Array,cx:Int32Array,cy:Int32Array,fx:Int32Array,fy:Int32Array};
const compact=args.includes('--compact'),originalSlots=sample.originalSlots;
const low=originalSlots?Math.min(...originalSlots):0;
const outLength=originalSlots&&!compact?Math.max(...originalSlots)-low+1:sample.outputs.px.length;
const fixtures=Array.from({length:copies},()=>{
 const arrays={};
 for(const [name,Type]of Object.entries(inputTypes)){arrays[name]=alloc(Type,sample.inputs[name].length);arrays[name].set(sample.inputs[name]);}
 if(originalSlots&&!compact)for(let i=0;i<sample.inputs.ord.length;i++)if(arrays.ord[i]>=0)arrays.ord[i]=originalSlots[arrays.ord[i]]-low;
 const saved={};
 for(const[name,Type]of Object.entries(outputTypes)){
  arrays[name]=alloc(Type,outLength);saved[name]=new Type(outLength+4);
  for(let i=0;i<sample.outputs[name].length;i++)saved[name][originalSlots&&!compact?originalSlots[i]-low:i]=sample.outputs[name][i];
 }
 const counts=alloc(BigUint64Array,32);
 const ptrs=['ord','qx','qy','qr','meta','qid','ekey','px','py','ov','hit','qv','cx','cy','fx','fy'].map(n=>arrays[n].byteOffset/4);
 const P=sample.params;
 const mover=args.includes('--counters')?counts.byteOffset/4:P[12];
 const call=()=>x.sep_pairs(...ptrs,P[0],P[1],P[2],P[3],P[4],P[5],P[6],P[7],P[9],P[10],mover,P[13],P[14],sample.chunk,P[16]);
 const reset=()=>{for(const name of Object.keys(outputTypes))arrays[name].set(saved[name]);counts.fill(0n);};
 return {arrays,counts,call,reset};
});
for(let i=0;i<Math.max(12,copies);i++){const f=fixtures[i%copies];f.reset();f.call();}
const session=new(require('node:inspector').Session)(),post=(m,p={})=>new Promise((r,j)=>session.post(m,p,(e,v)=>e?j(e):r(v)));
async function main(){
 if(args.includes('--profile')){session.connect();await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:100});await post('Profiler.start');}
 const times=[];
 for(let i=0;i<iterations;i++){const f=fixtures[i%copies];f.reset();const t=performance.now();f.call();times.push(performance.now()-t);}
 let top;
 if(args.includes('--profile')){
  const {profile}=await post('Profiler.stop');session.disconnect();fs.writeFileSync(option('out',file+'.replay.json')+'.cpuprofile',JSON.stringify(profile));
  const totals=new Map();for(let i=0;i<profile.samples.length;i++)totals.set(profile.samples[i],(totals.get(profile.samples[i])||0)+profile.timeDeltas[i]/1000);
  top=profile.nodes.map(n=>({name:n.callFrame.functionName,ms:totals.get(n.id)||0})).filter(n=>n.ms).sort((a,b)=>b.ms-a.ms);
 }
 const names=['entries','participants','neighborRows','simdVectors','ineligibleVectors','eligibleCandidates','broadHits','stillCalls','stillContacts','exactCalls','exactContacts','exactOtherWrites','stillOtherWrites','budgetReached','tableEntries','selfWrites','unused','contacts'];
 const counters=Object.fromEntries(names.map((n,i)=>[n,Number(fixtures[0].counts[i])]));
 const outputs=Object.fromEntries(Object.keys(outputTypes).map(n=>[n,Buffer.from(fixtures[0].arrays[n].buffer,fixtures[0].arrays[n].byteOffset,fixtures[0].arrays[n].byteLength).toString('base64')]));
 const oracle=option('oracle',null);if(oracle){const previous=JSON.parse(fs.readFileSync(oracle));assert.deepEqual(outputs,previous.outputs,'replayed output columns differ');}
 times.sort((a,b)=>a-b);
 const topByName=top?Object.entries(Object.groupBy(top,e=>e.name)).map(([name,rows])=>({name,ms:rows.reduce((s,e)=>s+e.ms,0)})).sort((a,b)=>b.ms-a.ms):undefined;
 const report={file,kernel,copies,compact,outLength,allocatedMiB:at/1048576,iterations,meanMs:times.reduce((a,b)=>a+b,0)/times.length,p50:times[times.length>>1],p95:times[Math.floor(times.length*.95)],counters,top,topByName,outputs};
 fs.writeFileSync(option('out',file+'.replay.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,outputs:undefined}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
