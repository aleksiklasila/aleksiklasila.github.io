// Compare packed acquisition against the previous build and a brute-force
// nearest/lowest-ID oracle, then time both on the identical snapshot.
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
const files=process.argv.slice(2,4);assert.equal(files.length,2,'Pass baseline and candidate wasm64 JS files');
const wasm32=process.argv.includes('--wasm32');
const memory=new WebAssembly.Memory(wasm32?{initial:128,maximum:256,shared:true}:{initial:128n,maximum:256n,shared:true,address:'i64'});
const modules=files.map(file=>{const c={};vm.runInNewContext(fs.readFileSync(file,'utf8')+';this.bin='+(wasm32?'SIM_WASM_BIN':'SIM_WASM64_BIN'),c);return new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(c.bin,'base64')),{env:{memory}}).exports;});
let next=2*1024*1024;
const alloc=(T,n)=>{next=Math.ceil(next/64)*64;const a=new T(memory.buffer,next,n);next+=a.byteLength;return a;};
const n=4096,w=64,h=64,tile=32,players=2,areas=64,epoch=3;
const xs=alloc(Float32Array,n),ys=alloc(Float32Array,n),own=alloc(Int8Array,n),flags=alloc(Uint8Array,n),cmd=alloc(Uint8Array,n),range=alloc(Float32Array,n),id=alloc(Int32Array,n);
const out=alloc(Int32Array,n),tid=alloc(Int32Array,n),sout=alloc(Int32Array,n),ag=alloc(Int32Array,w*h),cov=alloc(Uint8Array,players*areas),hs=alloc(Int32Array,players*(w+1)*(h+1));
const rs=alloc(Int32Array,w*h),rc=alloc(Int32Array,w*h),stamp=alloc(Int32Array,w*h),es=alloc(Int32Array,n),om=alloc(Uint8Array,w*h+16);
const ex=alloc(Float32Array,n),ey=alloc(Float32Array,n),eo=alloc(Int32Array,n),ea=alloc(Int32Array,n),eid=alloc(Int32Array,n);
const scls=alloc(Int8Array,w*h+16),sown=alloc(Int8Array,w*h+16);
const ptr=a=>a?a.byteOffset/(wasm32?1:4):0;
const args=()=>[ptr(scls),ptr(sown),0,ptr(sout),...[xs,ys,own,flags,cmd,range,id,out,tid,ag,cov,hs,rs,rc,stamp,es,om].map(ptr),0,...[ex,ey,eo,ea,eid].map(ptr),n,n,w,h,tile,epoch,players,0,1,1,w,h,1,w,h,2,areas,cov.length,0,n,0];
let seed=12345;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)|0;return (seed>>>0)/4294967296;};
for(let p=0;p<players;p++)for(let y=0;y<=h;y++)for(let x=0;x<=w;x++)hs[p*(w+1)*(h+1)+y*(w+1)+x]=x*y*1000;
for(let y=0;y<h;y++)for(let x=0;x<w;x++)ag[y*w+x]=(y>>3)*8+(x>>3);
function setup(trial){
 rc.fill(0);om.fill(0);stamp.fill(epoch);
 for(let a=0;a<cov.length;a++)cov[a]=trial%3===0||random()>.25?1:0;
 for(let k=0;k<w*h;k++){scls[k]=random()<.12?1+Math.floor(random()*5):0;sown[k]=Math.floor(random()*3)-1;}
 const lists=Array.from({length:w*h},()=>[]);
 for(let s=0;s<n;s++){
  // Dense cells, sparse cells, exact ties, tile seams and short ranges.
  const gx=trial%2?Math.floor(random()*w):28+Math.floor(random()*8),gy=trial%2?Math.floor(random()*h):28+Math.floor(random()*8);
  xs[s]=gx*tile+(trial%4===0?16:random()*tile);ys[s]=gy*tile+(trial%4===0?16:random()*tile);
  own[s]=s%2;flags[s]=random()<.02?1:0;cmd[s]=trial>=6?s%3:2;range[s]=trial%5===0?8:32+random()*160;id[s]=n-s;
  lists[gy*w+gx].push(s);
 }
 let e=0;for(let k=0;k<lists.length;k++){
  rs[k]=e;rc[k]=lists[k].length;
  for(const s of lists[k]){es[e]=s;ex[e]=xs[s];ey[e]=ys[s];eo[e]=own[s];ea[e]=flags[s]&1?-1:ag[k];eid[e]=id[s];if(!(flags[s]&1))om[k]|=1<<own[s];e++;}
 }
}
for(let trial=0;trial<12;trial++){
 setup(trial);out.fill(-99);tid.fill(-99);sout.fill(-99);modules[0].acq_scan(...args());
 const expected=[out.slice(),tid.slice(),sout.slice()];out.fill(-99);tid.fill(-99);sout.fill(-99);modules[1].acq_scan(...args());
 for(const [j,a] of [out,tid,sout].entries())assert.deepEqual(a,expected[j],'trial '+trial+' output '+j);
 // A subset against all targets checks visibility, range and ID tie breaks.
 for(let s=0;s<32;s++){
  if(flags[s]&1)continue;let best=-1,b2=Math.fround(range[s]*range[s]),bid=0;
  for(let q=0;q<n;q++){
   const a=ag[Math.floor(ys[q]/tile)*w+Math.floor(xs[q]/tile)];
   if(flags[q]&1||own[q]===own[s]||!cov[own[s]*areas+a])continue;
   const dx=Math.fround(xs[q]-xs[s]),dy=Math.fround(ys[q]-ys[s]),d2=Math.fround(Math.fround(dx*dx)+Math.fround(dy*dy));
   if(d2<=b2&&(best<0||d2<b2||id[q]<bid)){best=q;b2=d2;bid=id[q];}
  }
  assert.equal(out[s],best,'oracle trial '+trial+' slot '+s);
  if(cmd[s]!==2){
   let tileBest=-1,bestClass=5,bestDistance=Infinity;
   for(let k=0;k<w*h;k++){
    const cls=scls[k]===5?1:scls[k];
    if(cls<=0||cls>bestClass||sown[k]===-1||sown[k]===own[s]||!cov[own[s]*areas+ag[k]])continue;
    const dx=(k%w+.5)*tile-xs[s],dy=(Math.floor(k/w)+.5)*tile-ys[s],d2=dx*dx+dy*dy;
    if(d2<range[s]*range[s]&&(cls<bestClass||d2<bestDistance)){tileBest=k;bestClass=cls;bestDistance=d2;}
   }
   assert.equal(sout[s],tileBest,'structure oracle trial '+trial+' slot '+s);
  }
 }
}
setup(8);const results=[];
for(const variant of [0,1,1,0,0,1,1,0]){
 const start=performance.now();for(let r=0;r<20;r++)modules[variant].acq_scan(...args());
 results.push({variant,ms:performance.now()-start});
}
console.log(JSON.stringify({n,trials:12,results}));
