// Slice every thread's profile around one slow step and a nearby normal step.
// node tests/chaos-spike-profile.cjs tests/test-runs/.../run.json [--step=N] [--reference=N]
'use strict';
const fs=require('node:fs'),path=require('node:path');
const file=path.resolve(process.argv[2]),run=JSON.parse(fs.readFileSync(file));
const option=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.split('=')[1];
const phase=option('phase');
const rows=run.rows.slice(Math.max(run.warmup??20,run.profileOrigins?.startStep??0)),duration=r=>r.wallMs??r.ms;
const spike=option('step')!==undefined?run.rows.find(r=>r.step===Number(option('step'))):rows.slice().sort((a,b)=>duration(b)-duration(a))[0];
if(!spike||!run.profileOrigins)throw Error('Need an existing step and a run captured with --profile or --helper-profile.');
let candidates=rows.filter(r=>r.step!==spike.step&&r.burst===spike.burst&&Math.abs(r.step-spike.step)<=20);
if(!candidates.length)candidates=rows.filter(r=>r.step!==spike.step);
candidates.sort((a,b)=>duration(a)-duration(b));
const reference=option('reference')!==undefined?run.rows.find(r=>r.step===Number(option('reference'))):candidates[Math.floor(candidates.length/2)];
if(!reference)throw Error('Need a reference step.');
const label=frame=>{
 let name=frame.functionName||'(anonymous)';
 const numeric=/^wasm-function\[(\d+)\]$/.exec(name);
 if(numeric&&run.wasmFunctionNames?.[numeric[1]])name=run.wasmFunctionNames[numeric[1]]+' '+name;
 const at=name.indexOf('12defence3_sim');
 if(at>=0)name=name.slice(at+14).replace(/NtB\d+_/g,'_').replace(/\d+/g,'::').replace(/^:+/,'');
 const url=frame.url||'';
 return name+(url&&!/wasm/.test(url)?' '+path.basename(url)+':'+(frame.lineNumber+1):'');
};
const noise=name=>/^(\(root\)|\(idle\)|\(program\)|wrapped|eval |inst\.eval |gameTick|_gameTickBody|loop |executeUserEntryPoint|wrapModuleLoad|\(anonymous\) (loader|run_main)|\(anonymous\)$)/.test(name);
function slice(profile,row,origin,allowEmpty=false){
 const nodes=new Map(profile.nodes.map(n=>[n.id,n])),parent=new Map();
 for(const n of profile.nodes)for(const id of n.children||[])parent.set(id,n.id);
 const self=new Map(),total=new Map();
 const intervals=phase?(row.intervals||[]).filter(x=>x[0]===phase).map(x=>[x[1]-origin,x[1]-origin+x[2]]):[[row.at-origin,row.at-origin+duration(row)]];
 if(!intervals.length){
  if(allowEmpty)return {self,total,sampledMs:0,idleMs:0};
  throw Error('No timeline interval for '+phase+' in step '+row.step+'; capture with --timeline.');
 }
 const from=Math.min(...intervals.map(x=>x[0])),to=Math.max(...intervals.map(x=>x[1]));
 let time=0,sampledMs=0,idleMs=0;
 for(let i=0;i<profile.samples.length;i++){
  const next=time+(profile.timeDeltas[i]||0)/1000;
  const ms=intervals.reduce((sum,[a,b])=>sum+Math.max(0,Math.min(next,b)-Math.max(time,a)),0);time=next;
  if(time<from)continue;if(time>to&&ms===0)break;if(!ms)continue;
  const node=nodes.get(profile.samples[i]);if(!node)continue;
  sampledMs+=ms;
  if(node.callFrame.functionName==='(idle)'){idleMs+=ms;continue;}
  const key=label(node.callFrame);self.set(key,(self.get(key)||0)+ms);
  const seen=new Set();let id=node.id;
  while(id!==undefined){const n=nodes.get(id);if(!n)break;const name=label(n.callFrame);
   if(!seen.has(name)){seen.add(name);total.set(name,(total.get(name)||0)+ms);}id=parent.get(id);
  }
 }
 return{self,total,sampledMs,idleMs};
}
const sum=(dest,src)=>{for(const[k,v]of src)dest.set(k,(dest.get(k)||0)+v);};
const steps={spike,reference};
for(const [name,offset]of [['previous',-1],['next',1]]){
 const r=run.rows.find(r=>r.step===spike.step+offset);
 if(r&&r.step>=(run.profileOrigins.startStep||0))steps[name]=r;
}
const tables=Object.fromEntries(Object.keys(steps).map(name=>[name,{self:new Map(),total:new Map()}])),threads=[];
const profiles=[{name:'main',file:file+'.cpuprofile',origin:run.profileOrigins.main},...(run.profileOrigins.helpers||[]).map((origin,i)=>({name:'helper'+i,file:file+'.helper'+i+'.cpuprofile',origin}))];
for(const item of profiles){
 if(!fs.existsSync(item.file))continue;
 const profile=JSON.parse(fs.readFileSync(item.file)),row={thread:item.name};
 // Earlier captures timestamped the synchronous start call's return. Its
 // substantial profiler-start overhead is the profile's first time delta.
 const origin=run.profileOrigins.beforeStart?item.origin:item.origin-(profile.timeDeltas[0]||0)/1000;
 for(const [name,step]of Object.entries(steps)){
  const s=slice(profile,step,origin,name==='previous'||name==='next');sum(tables[name].self,s.self);sum(tables[name].total,s.total);
  row[name]={sampledMs:s.sampledMs,idleMs:s.idleMs,top:[...s.self].filter(([k])=>!noise(k)).sort((a,b)=>b[1]-a[1]).slice(0,6)};
 }threads.push(row);
}
const top=(table,other)=>[...table].filter(([name])=>!noise(name)).map(([name,ms])=>({name,ms,referenceMs:other.get(name)||0,extraMs:ms-(other.get(name)||0)}));
const topSelf=top(tables.spike.self,tables.reference.self),topTotal=top(tables.spike.total,tables.reference.total);
const describe=r=>({step:r.step,ms:r.ms,wallMs:duration(r),gcMs:r.gcMs,cpuMs:r.cpu?(r.cpu.user+r.cpu.system)/1000:null,freeMB:r.freeMB,heapUsedMB:r.heapUsedMB,phases:r.phases,index:r.index});
const result={phase,note:'Sampled thread time across concurrent threads; inclusive values overlap. Process CPU time is reported separately.',spike:describe(spike),reference:describe(reference),self:topSelf.sort((a,b)=>b.ms-a.ms).slice(0,25),extraSelf:topSelf.slice().sort((a,b)=>b.extraMs-a.extraMs).slice(0,25),extraInclusive:topTotal.sort((a,b)=>b.extraMs-a.extraMs).slice(0,25),threads};
result.neighbors=Object.fromEntries(['previous','next'].filter(name=>steps[name]).map(name=>[name,{...describe(steps[name]),self:top(tables[name].self,tables.reference.self).sort((a,b)=>b.ms-a.ms).slice(0,15)}]));
fs.writeFileSync(file+(phase?'.'+phase.replace(/[^a-z0-9_-]/gi,'-'):'')+'.spike-analysis.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({spike:result.spike,reference:result.reference,neighbors:result.neighbors,extraSelf:result.extraSelf.slice(0,14),extraInclusive:result.extraInclusive.slice(0,12)},null,2));
