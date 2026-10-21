// Identical-snapshot quality and cost of exact vs bounded area acquisition.
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
const file=process.argv.slice(2).find(a=>!a.startsWith('--'))||'src/sim/sim_wasm64_bin.js',wasm32=process.argv.includes('--wasm32');
const outFile=process.argv.find(a=>a.startsWith('--out='))?.slice(6);
const areaTargets=process.argv.includes('--area-targets');
const directPack=process.argv.includes('--direct-area-pack');
const n=Number(process.argv.find(a=>a.startsWith('--units='))?.slice(8)||8192);
const ctx={};vm.runInNewContext(fs.readFileSync(file,'utf8')+';this.bin='+(wasm32?'SIM_WASM_BIN':'SIM_WASM64_BIN'),ctx);
const memory=new WebAssembly.Memory(wasm32?{initial:1024,maximum:2048,shared:true}:{initial:1024n,maximum:2048n,shared:true,address:'i64'});
const x=new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(ctx.bin,'base64')),{env:{memory}}).exports;
let next=2*1024*1024;const alloc=(T,n)=>{next=Math.ceil(next/64)*64;const a=new T(memory.buffer,next,n);next+=a.byteLength;return a;};
const w=64,h=64,tile=32,players=2,A=w*h/8,epoch=3;
const block=alloc(Int32Array,2048),P=new Float64Array(memory.buffer,block.byteOffset+4096,64);
const xs=alloc(Float32Array,n),ys=alloc(Float32Array,n),own=alloc(Int8Array,n),flags=alloc(Uint8Array,n),cmd=alloc(Uint8Array,n),range=alloc(Float32Array,n),id=alloc(Int32Array,n);
const out=alloc(Int32Array,n),tid=alloc(Int32Array,n),sout=alloc(Int32Array,n),ag=alloc(Int32Array,w*h),cov=alloc(Uint8Array,players*A),hs=alloc(Int32Array,players*(w+1)*(h+1));
const rs=alloc(Int32Array,w*h),rc=alloc(Int32Array,w*h),stamp=alloc(Int32Array,w*h),es=alloc(Int32Array,n),om=alloc(Uint8Array,w*h+16);
const ex=alloc(Float32Array,n),ey=alloc(Float32Array,n),eo=alloc(Int32Array,n),ea=alloc(Int32Array,n),eid=alloc(Int32Array,n);
const scls=alloc(Int8Array,w*h+16),sown=alloc(Int8Array,w*h+16),off=alloc(Int32Array,A*players+1);
const ax=alloc(Float32Array,n),ay=alloc(Float32Array,n),ao=alloc(Int32Array,n),aid=alloc(Int32Array,n),slots=alloc(Int32Array,n);
const near=alloc(Int32Array,A*64),nearN=alloc(Int32Array,A),counts=alloc(Int32Array,A*players),cursor=alloc(Int32Array,A*players),seen=alloc(Int32Array,A),graphOff=alloc(Int32Array,A+1),graph=alloc(Int32Array,A*4);
const nearest=alloc(Int32Array,A*players),nearestDistance=alloc(Int32Array,A*players),queue=alloc(Int32Array,A),structureAnswers=alloc(Int32Array,A*players*4),structureDistance=alloc(Int32Array,A*players*4);
const ptr=a=>a?a.byteOffset/(wasm32?1:4):0;
const names=[scls,sown,null,sout,xs,ys,own,flags,cmd,range,id,out,tid,ag,cov,hs,rs,rc,stamp,es,om,null,ex,ey,eo,ea,eid,off,ax,ay,ao,aid,slots,near,nearN,counts,cursor,seen,graphOff,graph,nearest,nearestDistance,queue,structureAnswers,structureDistance];
names.forEach((a,j)=>block[512+j]=ptr(a));
let edges=0;for(let a=0;a<A;a++){graphOff[a]=edges;const gx=a%(w/2),gy=Math.floor(a/(w/2));for(const [dx,dy]of [[-1,0],[1,0],[0,-1],[0,1]]){const xx=gx+dx,yy=gy+dy;if(xx>=0&&xx<w/2&&yy>=0&&yy<h/4)graph[edges++]=yy*(w/2)+xx;}}graphOff[A]=edges;
for(let y=0;y<h;y++)for(let xx=0;xx<w;xx++)ag[y*w+xx]=Math.floor(y/4)*(w/2)+Math.floor(xx/2);
for(let p=0;p<players;p++)for(let y=0;y<=h;y++)for(let xx=0;xx<=w;xx++)hs[p*(w+1)*(h+1)+y*(w+1)+xx]=xx*y*1000;
const params=()=>{P.fill(0);P[0]=n;P[1]=n;P[3]=w;P[4]=h;P[5]=tile;P[6]=epoch;P[7]=players;P[8]=0;P[9]=1;P[10]=1;P[11]=w;P[12]=h;P[14]=1;P[15]=w;P[16]=h;P[18]=2;P[20]=A;P[28]=areaTargets?1:0;P[29]=5;P[30]=directPack?1:0;};
const exact=()=>x.acq_scan(...names.slice(0,27).map(ptr),n,n,w,h,tile,epoch,players,0,1,1,w,h,1,w,h,2,A,cov.length,0,n,0);
const sample=(budget,seed=2)=>{P[24]=budget;P[25]=seed;x.k_acq_sample(ptr(block),0);};
let randomState=12345;const random=()=>{randomState=(Math.imul(randomState,1664525)+1013904223)|0;return(randomState>>>0)/4294967296;};
function setup(kind){
 randomState=12345;rc.fill(0);om.fill(0);stamp.fill(epoch);cov.fill(1);scls.fill(0);sown.fill(-1);
 if(kind==='visibility')for(let a=0;a<cov.length;a++)cov[a]=random()>.3?1:0;
 if(areaTargets)for(let t=0;t<w*h;t++){scls[t]=random()<.08?1+Math.floor(random()*5):0;sown[t]=Math.floor(random()*4)-2;}
 const lists=Array.from({length:w*h},()=>[]);
 for(let s=0;s<n;s++){
  const span=kind==='dense'?16:kind==='frontline'?32:64,base=(64-span)/2;
  const gx=base+Math.floor(random()*span),gy=base+Math.floor(random()*span);
  xs[s]=(gx+random())*tile;ys[s]=(gy+random())*tile;
  own[s]=kind==='frontline'?(gx<32?0:1):s%2;flags[s]=random()<.02?1:0;cmd[s]=areaTargets?s%3:2;range[s]=144;id[s]=n-s;
  lists[gy*w+gx].push(s);
 }
 let e=0;for(let k=0;k<lists.length;k++){rs[k]=e;rc[k]=lists[k].length;for(const s of lists[k]){
  es[e]=s;ex[e]=xs[s];ey[e]=ys[s];eo[e]=own[s];ea[e]=flags[s]&1?-1:ag[k];eid[e]=id[s];if(!(flags[s]&1))om[k]|=1<<own[s];e++;
 }}params();
}
const distance=(s,q)=>Math.hypot(xs[s]-xs[q],ys[s]-ys[q]);
const percentile=(a,p)=>a.slice().sort((a,b)=>a-b)[Math.min(a.length-1,Math.floor(a.length*p))]||0;
// Independent forward BFS of the eligible areas for each source window.
// This oracle never consults the Rust nearest-area tables.
function reachable(s,cache){
 const fx=xs[s]/tile,fy=ys[s]/tile,gx=Math.floor(fx),gy=Math.floor(fy),rx=fx-gx,ry=fy-gy;
 const sources=new Set();for(let y=gy-(ry<.3?1:0);y<=gy+(ry>=.7?1:0);y++)for(let xx=gx-(rx<.3?1:0);xx<=gx+(rx>=.7?1:0);xx++)if(xx>=0&&y>=0&&xx<w&&y<h)sources.add(ag[y*w+xx]);
 const depth=Math.ceil(range[s]/(tile*5)),key=[...sources].sort((a,b)=>a-b).join(',')+':'+depth;
 if(cache.has(key))return cache.get(key);const visited=new Set(sources);let front=[...sources];
 for(let d=0;d<depth;d++){const next=[];for(const a of front)for(let j=graphOff[a];j<graphOff[a+1];j++){const b=graph[j];if(!visited.has(b)){visited.add(b);next.push(b);}}front=next;}
 cache.set(key,visited);return visited;
}
const results=[];
for(const scenario of ['dense','frontline','sparse','visibility']){
 setup(scenario);P[26]=1;
 let packedOracle;
 if(directPack){P[30]=0;x.k_acq_area_build(ptr(block),0);packedOracle=[off,ax,ay,ao,aid,slots].map(a=>a.slice());P[30]=1;}
 let start=performance.now();x.k_acq_area_build(ptr(block),0);const coldBuildMs=performance.now()-start;P[26]=0;
 if(directPack)[off,ax,ay,ao,aid,slots].forEach((a,j)=>assert.deepEqual(a,packedOracle[j],'direct area packing matches packed snapshot'));
 start=performance.now();for(let r=0;r<8;r++)x.k_acq_area_build(ptr(block),0);const indexMs=(performance.now()-start)/8;
 assert.equal(off[A*players],flags.reduce((n,f)=>n+!(f&1),0));
 for(let key=0;key<A*players;key++)for(let e=off[key];e<off[key+1];e++){
  assert.equal(ag[Math.floor(ay[e]/tile)*w+Math.floor(ax[e]/tile)],Math.floor(key/players),'CSR area membership');assert.equal(ao[e],key%players,'CSR owner membership');
 }
 out.fill(-1);exact();const pixelTargets=out.slice();let exactTargets=pixelTargets,eligible=pixelTargets.reduce((n,q)=>n+(q>=0),0);
 const reachableCache=new Map(),areaReferences=[];
 if(areaTargets){
  exactTargets=new Int32Array(n).fill(-1);eligible=0;
  for(let s=0;s<n;s++){
   if(flags[s]&7)continue;const areas=reachable(s,reachableCache);areaReferences[s]=areas;let best=Infinity;
   for(const a of areas)if(cov[own[s]*A+a])for(let foe=0;foe<players;foe++)if(foe!==own[s]){
    const key=a*players+foe;for(let e=off[key];e<off[key+1];e++){const q=slots[e],d=distance(s,q);if(d<best){best=d;exactTargets[s]=q;}}
   }
   eligible+=exactTargets[s]>=0;
  }
 }
 start=performance.now();for(let r=0;r<8;r++)exact();const exactMs=(performance.now()-start)/8;
 for(const budget of areaTargets?[4]:[4,16,64,256]){
  out.fill(-1);sample(budget);const targets=out.slice(),savedTid=tid.slice();sample(budget);assert.deepEqual(out,targets,'repeatable sample');assert.deepEqual(tid,savedTid);
  const targetChecksum=targets.reduce((h,q)=>Math.imul(h^q,16777619)>>>0,2166136261).toString(16);
  let found=0,same=0,sumExact=0,sumSelected=0,sourceAreaHits=0;const extras=[];
  for(let s=0;s<n;s++)if(targets[s]>=0){
   const q=targets[s],a=ag[Math.floor(ys[q]/tile)*w+Math.floor(xs[q]/tile)];
   assert.ok(!(flags[q]&1)&&own[q]!==own[s]&&cov[own[s]*A+a],'eligible live visible enemy');
   assert.equal(tid[s],id[q]);const dx=Math.fround(xs[q]-xs[s]),dy=Math.fround(ys[q]-ys[s]);
   if(areaTargets)assert.ok(areaReferences[s].has(a),'area range');
   else assert.ok(Math.fround(Math.fround(dx*dx)+Math.fround(dy*dy))<=Math.fround(range[s]*range[s]),'range');
   assert.ok(exactTargets[s]>=0,'sample cannot invent a valid enemy');
   found++;same+=q===exactTargets[s];const d0=distance(s,exactTargets[s]),d=distance(s,q);sumExact+=d0;sumSelected+=d;extras.push(d-d0);
   sourceAreaHits+=a===ag[Math.floor(ys[s]/tile)*w+Math.floor(xs[s]/tile)];
  }
  if(areaTargets){
   assert.equal(found,eligible,'every eligible unit lookup succeeds on the first attempt');
   for(let s=0;s<n;s++)if(!(flags[s]&7)&&cmd[s]!==2){
    let bestClass=5,exists=false;const chosen=sout[s];
    for(let t=0;t<w*h;t++){const cls=scls[t]===5?1:scls[t];if(cls<1||cls>4||sown[t]===-1||sown[t]===own[s]||!cov[own[s]*A+ag[t]]||!areaReferences[s].has(ag[t]))continue;exists=true;bestClass=Math.min(bestClass,cls);}
    assert.equal(chosen>=0,exists,'every eligible structure lookup succeeds');
    if(chosen>=0){assert.ok(areaReferences[s].has(ag[chosen])&&cov[own[s]*A+ag[chosen]]&&sown[chosen]!==own[s]&&sown[chosen]!==-1);assert.equal(scls[chosen]===5?1:scls[chosen],bestClass,'structure class priority');}
   }
  }
  sample(budget,6);let changed=0;for(let s=0;s<n;s++)changed+=targets[s]>=0&&out[s]>=0&&targets[s]!==out[s];
  const everFound=targets.map(q=>q>=0?1:0);
  for(const seed of [6,10,14]){sample(budget,seed);for(let s=0;s<n;s++)if(out[s]>=0)everFound[s]=1;}
  const foundOverFour=everFound.reduce((n,v)=>n+v,0);
  const times=[];for(let trial=0;trial<4;trial++){start=performance.now();for(let r=0;r<8;r++)sample(budget,r*4+2);times.push((performance.now()-start)/8);}
  results.push({scenario,n,budget,targetChecksum,eligible,found,coveragePercent:100*found/eligible,coverageOverFourSamplesPercent:100*foundOverFour/eligible,sameTargetPercent:100*same/Math.max(found,1),meanExactDistancePx:sumExact/Math.max(found,1),meanSampleDistancePx:sumSelected/Math.max(found,1),p95ExtraDistancePx:percentile(extras,.95),sameAreaPercent:100*sourceAreaHits/Math.max(found,1),resampledTargetChangePercent:100*changed/Math.max(found,1),coldBuildMs,indexMs,exactMs,sampleMs:times.reduce((s,x)=>s+x,0)/times.length,scanTimesMs:times});
 }
}
if(areaTargets){
 // An eligible neighbouring area may contain targets outside the old pixel
 // circle. Both unit and structure lookups must still succeed immediately.
 flags.fill(1);flags[0]=flags[1]=0;own[0]=0;own[1]=1;cmd[0]=0;cmd[1]=2;
 xs[0]=ys[0]=1;xs[1]=ys[1]=127;range[0]=range[1]=144;cov.fill(1);
 scls.fill(0);sown.fill(-1);const targetTile=3*w+3;scls[targetTile]=1;sown[targetTile]=1;
 for(let e=0;e<n;e++){es[e]=e;ex[e]=xs[e];ey[e]=ys[e];eo[e]=own[e];eid[e]=id[e];ea[e]=flags[e]&1?-1:ag[Math.floor(ys[e]/tile)*w+Math.floor(xs[e]/tile)];}
 params();x.k_acq_area_build(ptr(block),0);out.fill(-1);sout.fill(-1);sample(4);
 assert.ok(distance(0,1)>range[0]);assert.equal(out[0],1,'unit outside pixel circle, inside eligible area');
 assert.ok(Math.hypot(112-xs[0],112-ys[0])>range[0]);assert.equal(sout[0],targetTile,'structure outside pixel circle, inside eligible area');
}
const report={wasm32,areaTargets,areaBoundaryCheck:areaTargets,bytes:next,results};if(outFile)fs.writeFileSync(outFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
