'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const context=vm.createContext({atob,WebAssembly,console,Float32Array,Int32Array,Uint32Array});
for(const file of ['sim_rebase_bin.js','sim_rebase.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/sim',file),'utf8'),context);
function frame(n,shared=false) {
    const F={n,cap:n,renderBuckets:{},renderMoving:new Int32Array(n)};
    for(const k of ['x','y','px','py','id'])F[k]=new (k==='id'?Int32Array:Float32Array)(shared?new SharedArrayBuffer(n*4):new ArrayBuffer(n*4));
    return F;
}
function reference(F,old,a) {
    let pad=0;
    for(let i=0;i<Math.min(F.n,old.n);i++)if(F.id[i]>=0&&F.id[i]===old.id[i]){
        const x=old.px[i]+(old.x[i]-old.px[i])*a,y=old.py[i]+(old.y[i]-old.py[i])*a;
        F.px[i]=x;F.py[i]=y;pad=Math.max(pad,Math.abs(x-F.x[i]),Math.abs(y-F.y[i]));
    }
    return pad;
}
(async()=>{
    await vm.runInContext('_simRebaseReady',context);
    for(const n of [1,200,9000,600000,1100])for(const shared of [false,true]) {
        const F=frame(n,shared),old=frame(Math.max(1,n-20),shared);
        for(let i=0;i<n;i++) {
            F.id[i]=i%31===0?-1:i%29===0?i+n:i;
            F.x[i]=Math.sin(i)*32000;F.y[i]=Math.cos(i)*32000;F.px[i]=F.x[i]-3;F.py[i]=F.y[i]+2;
            if(i<old.n){old.id[i]=i;old.x[i]=F.x[i]-1;old.y[i]=F.y[i]+1;old.px[i]=old.x[i]-2;old.py[i]=old.y[i]+3;}
        }
        for(const a of [0,.123456,.99,1]) {
            const expected={...F,px:F.px.slice(),py:F.py.slice()};
            const pad=reference(expected,old,a);
            assert.equal(context.simRebaseNative(F,old,a),true);
            assert.deepEqual(F.px.subarray(0,n),expected.px.subarray(0,n));assert.deepEqual(F.py.subarray(0,n),expected.py.subarray(0,n));assert.equal(F.renderMotionPad,pad);
            const movers=[];for(let i=0;i<n;i++)if(F.px[i]!==F.x[i]||F.py[i]!==F.y[i])movers.push(i);
            assert.deepEqual(Array.from(F.renderMoving.subarray(0,F.renderMovingCount)),movers);
        }
        if(n===600000&&process.env.REBASE_BENCH)for(const fn of [reference,context.simRebaseNative]) {
            for(let i=0;i<10;i++)fn(F,old,.5);
            const start=performance.now();for(let i=0;i<40;i++)fn(F,old,.5);
            console.log(fn.name,((performance.now()-start)/40).toFixed(2)+' ms (600k moving, copies included, shared='+shared+')');
        }
    }
    // Live frame chain: old interpolation lives in the alternating native
    // arenas, including a capacity growth while the previous frame is live.
    let old=null,refOld=null;
    for(let tick=0;tick<30;tick++) {
        const n=tick<12?10000:20000,F=frame(n,true);
        for(let s=0;s<n;s++){F.id[s]=s;F.x[s]=s+tick*2;F.y[s]=s-tick*3;F.px[s]=F.x[s]-2;F.py[s]=F.y[s]+3;}
        const ref={...F,px:F.px.slice(),py:F.py.slice()};
        if(old){const pad=reference(ref,refOld,.37);context.simRebaseNative(F,old,.37);assert.deepEqual(F.px.subarray(0,n),ref.px);assert.deepEqual(F.py.subarray(0,n),ref.py);assert.equal(F.renderMotionPad,pad);}
        old=F;refOld=ref;
    }
    console.log('PASS: native interpolation matches JS exactly, including shared frames, slot reuse, arena rotation/growth and moving lists.');
})().catch(e=>{console.error(e);process.exitCode=1;});
