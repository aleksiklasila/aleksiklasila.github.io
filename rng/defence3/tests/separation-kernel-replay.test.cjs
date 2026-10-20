// Exact replay of the baseline and optimized pair kernels, including SIMD
// tails, nonparticipants, layers, coincident units and nonfinite positions.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const timings=[],differences=[];
const approximate=process.argv.includes('--approx');
function compare(now,old,label){
    for(const key of Object.keys(old)){
        if(!approximate||!['px','py','ov'].includes(key)){assert.deepEqual(now[key],old[key],key+' '+label);continue;}
        const Type=key==='ov'?Float32Array:Int32Array;
        const a=new Type(now[key].buffer,now[key].byteOffset,now[key].byteLength/4),b=new Type(old[key].buffer,old[key].byteOffset,old[key].byteLength/4);
        let max=0,changed=0;
        for(let i=0;i<a.length;i++)if(a[i]!==b[i]&&!(Number.isNaN(a[i])&&Number.isNaN(b[i]))){max=Math.max(max,Math.abs(a[i]-b[i]));changed++;}
        differences.push({label,key,max,changed});
        assert.ok(max<=(key==='ov'?0.0001:32),key+' excessive geometry error '+max+' '+label);
    }
}
function run(file,seed,still,edge=null,budget=0) {
    const initialSeed=seed;
    const ctx=vm.createContext({});vm.runInContext(fs.readFileSync(file,'utf8')+';this.bin=SIM_WASM_BIN;',ctx);
    const memory=new WebAssembly.Memory({initial:256,maximum:65536,shared:true});
    const exports=new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(ctx.bin,'base64')),{env:{memory}}).exports;
    const n=edge===null?2051:2,arrays={},ptrs=[];let at=2*1024*1024;
    const types=[Int32Array,Float32Array,Float32Array,Float32Array,Int32Array,Int32Array,Int32Array,Int32Array,Int32Array,Float32Array,Uint32Array,Int32Array,Int32Array,Int32Array,Int32Array,Int32Array];
    const names=['ord','qx','qy','qr','meta','id','key','px','py','ov','hit','qv','cx','cy','fx','fy'];
    for(let i=0;i<names.length;i++){ptrs.push(at);arrays[names[i]]=new types[i](memory.buffer,at,n);at+=Math.ceil((n*4+64)/64)*64;}
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
    for(let i=0;i<n;i++) {
        const key=Math.floor(i*64/n);arrays.ord[i]=i;arrays.key[i]=key;arrays.id[i]=i+1;
        arrays.qx[i]=(key%8)*32+random()*32;arrays.qy[i]=Math.floor(key/8)*32+random()*32;
        arrays.qr[i]=1+random()*14;arrays.meta[i]=(i%2)|((i%5===0?1:0)<<8)|(i%3?65536:0);
        arrays.qv[i]=!still&&i%7?((Math.floor(random()*1024)-512)<<16)|(Math.floor(random()*1024)-512)&65535:0;
        if(i%107===0){arrays.qx[i]=NaN;arrays.qy[i]=NaN;}
        else if(i%19===1){arrays.qx[i]=arrays.qx[i-1];arrays.qy[i]=arrays.qy[i-1];}
    }
    if(edge!==null)for(let i=0;i<2;i++){
        arrays.qx[i]=i;arrays.qy[i]=0;arrays.qr[i]=1;arrays.key[i]=0;arrays.meta[i]=65536;arrays.qv[i]=0;
    }
    const start=performance.now(),iterations=process.argv.includes('--bench')?100:1;
    for(let it=0;it<iterations;it++) {
        for(const key of ['px','py','ov','hit','cx','cy','fx','fy'])arrays[key].fill(0);
        for(let parity=0;parity<2;parity++)for(let chunk=0;chunk<2;chunk++)
            exports.sep_pairs(...ptrs,8,8,2,2,32,edge===null?1024:edge,edge===null?.5:1,1,n,32,.5,.6,parity,chunk,budget);
    }
    timings.push({file:path.basename(file),seed:initialSeed,still,edge,ms:performance.now()-start,iterations});
    return Object.fromEntries(['px','py','ov','hit','cx','cy','fx','fy'].map(k=>[k,Buffer.from(new Uint8Array(arrays[k].buffer,arrays[k].byteOffset,arrays[k].byteLength))]));
}
const baseline=process.argv.find(a=>a.startsWith('--baseline='))?.slice(11)||path.join(__dirname,'fixtures/checkerboard-kernels/wasm32.js');
assert.ok(fs.existsSync(baseline),'baseline kernel fixture is required');
for(const seed of [17,31,997]) for(const still of [false,true]) {
    const old=run(baseline,seed,still),now=run(path.join(__dirname,'../src/sim/sim_wasm_bin.js'),seed,still);
    compare(now,old,'seed '+seed+' still '+still);
}
// Opposite pushes at and immediately beside a half must retain Math.round's
// asymmetry. In particular, subtracting floor(-0.49999999999999994) rounds
// the fraction to 0.5; the opposite side must still round to zero.
for(const edge of [0.5-Number.EPSILON/4,0.5,0.5+Number.EPSILON/2,1.5-Number.EPSILON,1.5,1.5+Number.EPSILON,2147483648.5]){
    const old=run(baseline,0,true,edge),now=run(path.join(__dirname,'../src/sim/sim_wasm_bin.js'),0,true,edge);
    compare(now,old,'half-boundary '+edge);
}
console.log(approximate?'PASS: bounded f32 contact geometry error; contact counts, closing and flow outputs stay exact':'PASS: baseline and optimized separation kernels produce identical contact outputs for every replay');
if(process.argv.includes('--bench')){const out=process.argv.find(a=>a.startsWith('--out='))?.slice(6)||path.join(__dirname,'separation-kernel-bench.json');fs.writeFileSync(out,JSON.stringify({node:process.version,timings,differences},null,2)+'\n');console.log(JSON.stringify(timings));}

if(process.argv.includes('--total-budget')){
 const file=path.join(__dirname,'test-runs/structure-stats-20261020/experimental-wasm32.js');
 const outgoing=run(file,17,true,null,8),total=run(file,17,true,null,-8),repeat=run(file,17,true,null,-8);
 assert.deepEqual(total,repeat,'total contact budget is repeatable');
 const sum=b=>new Uint32Array(b.buffer,b.byteOffset,b.byteLength/4).reduce((n,x)=>n+x,0);
 assert.ok(sum(total.hit)<sum(outgoing.hit),'already received contacts save outgoing work');
 console.log('PASS: total contact budget preserves deterministic responses; counted contacts',sum(outgoing.hit),'->',sum(total.hit));
}
