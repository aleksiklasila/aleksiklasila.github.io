'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
const file=process.argv[2],out=process.argv[3],n=Number(process.argv[4]||4000000),ctx={};
vm.runInNewContext(fs.readFileSync(file,'utf8')+';this.bin=SIM_WASM64_BIN',ctx);
const memory=new WebAssembly.Memory({initial:8192n,maximum:262144n,shared:true,address:'i64'});
assert.equal(n%64,0,'target pairing requires a multiple of 64 slots');
const module_=new WebAssembly.Module(Buffer.from(ctx.bin,'base64')),x=new WebAssembly.Instance(module_,{env:{memory}}).exports;
let next=2*1024*1024;const arrays=[];
const alloc=(T,len)=>{next=Math.ceil(next/64)*64;const a=new T(memory.buffer,next,len);next+=a.byteLength;arrays.push(a);return a;};
const args=alloc(Int32Array,2048),make=T=>alloc(T,n+4);
const mode=make(Uint8Array),target=make(Int32Array),targetId=make(Int32Array),id=make(Int32Array),dead=make(Uint8Array),energy=make(Float32Array),sep=make(Uint32Array);
const px=make(Int32Array),py=make(Int32Array),oldx=make(Int32Array),oldy=make(Int32Array),vx=make(Float32Array),vy=make(Float32Array),d0=make(Uint8Array),output=make(Uint8Array);
const timer=make(Float32Array),cooldown=make(Float32Array),flash=make(Uint8Array),timerOn=make(Uint8Array),hitA=make(Int32Array),hitT=make(Int32Array),hitCount=make(Int32Array),carry=make(Uint8Array),shots=make(Uint8Array);
cooldown.fill(5);
const cols=[mode,target,targetId,id,dead,energy,sep,px,py,oldx,oldy,vx,vy,d0,output,timer,cooldown,flash,timerOn,hitA,hitT,hitCount,carry,shots];
for(let s=0;s<n;s++){mode[s]=1;target[s]=s^32;targetId[s]=(s^32)+1;id[s]=s+1;energy[s]=40;px[s]=oldx[s]=(s&255)*128;py[s]=oldy[s]=(s>>>8)*128;}
cols.forEach((a,j)=>args[512+j]=a.byteOffset/4);
// Compare every written byte, including the neighbouring lanes a spatial
// pair does not own. Exercise rejected targets and partially valid pairs.
const saved=cols.map(a=>a.slice(0,68));
for(let trial=0;trial<24;trial++){
 cols.forEach((a,j)=>a.set(saved[j]));
 for(let s=0;s<64;s++){
  mode[s]=trial&1?5:1;oldx[s]=px[s]+(s%3);oldy[s]=py[s]-(s%5);
  vx[s]=s%2?-0:3;vy[s]=s%3?0:-2;d0[s]=7;output[s]=9;
  timer[s]=s%3?0:2;carry[s]=s%13;
  const q=trial%3===0?((s&~1)^32):trial%3===1?(s^32):((s*7+11)%64);
  target[s]=q;targetId[s]=id[q];
 }
 if(trial>=3)for(let s=0;s<64;s+=7){
  switch(trial%8){
   case 0:targetId[s]++;break;case 1:dead[target[s]]=1;break;
   case 2:target[s]=-1;break;case 3:energy[s]=0;break;
   case 4:energy[s]=NaN;break;case 5:sep[s]=0xffffffff;break;
   case 6:dead[s]=1;break;case 7:mode[s]=0;break;
  }
 }
 const fixture=cols.map(a=>a.slice(0,68));
 const ref=x.mv_hold_bench(args.byteOffset/4,64,1,1,1);
 const expected=cols.map(a=>Buffer.from(a.buffer,a.byteOffset,68*a.BYTES_PER_ELEMENT).slice());
 cols.forEach((a,j)=>a.set(fixture[j]));
 assert.equal(x.mv_hold_bench(args.byteOffset/4,64,1,1,2),ref,'completed lanes trial '+trial);
 cols.forEach((a,j)=>assert.deepEqual(Buffer.from(a.buffer,a.byteOffset,expected[j].length),expected[j],'column '+j+' trial '+trial));
}
cols.forEach((a,j)=>a.set(saved[j]));
const run=(skip,bulk)=>x.mv_hold_bench(args.byteOffset/4,n,4,skip,bulk);
for(const [skip,bulk] of [[0,0],[1,0],[1,1],[0,1],[1,2]])assert.equal(run(skip,bulk),n*4);
const results=[];
for(const [skip,bulk] of [[1,1],[1,2],[1,2],[1,1],[1,1],[1,2],[1,2],[1,1]]){const start=performance.now(),checksum=run(skip,bulk);assert.equal(checksum,n*4);results.push({skipUnchangedStores:!!skip,bulkTargets:!!bulk,pairHolds:bulk===2,ms:performance.now()-start,checksum});}
const report={n,bytes:next,results};fs.writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
