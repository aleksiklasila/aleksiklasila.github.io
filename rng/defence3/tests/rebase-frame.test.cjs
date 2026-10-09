'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/sim/sim_client.js'),'utf8');
const rebase=new Function('return ('+source.slice(source.indexOf('function _simClientRebaseFrame('),source.indexOf('function _simClientApplyFrame('))+')')();
function reference(F,old,shown) {
    let pad=0;
    for(let s=0;s<Math.min(F.n,old.n);s++) {
        if(F.id[s]<0||old.id[s]!==F.id[s])continue;
        const x=old.px[s]+(old.x[s]-old.px[s])*shown,y=old.py[s]+(old.y[s]-old.py[s])*shown;
        F.px[s]=x;F.py[s]=y;
        if(F.renderBuckets)pad=Math.max(pad,Math.abs(x-F.x[s]),Math.abs(y-F.y[s]));
    }
    F.renderMotionPad=pad;
}
function frame(n) {return {n,id:Int32Array.from({length:n},(_,s)=>s),x:new Float32Array(n),y:new Float32Array(n),px:new Float32Array(n),py:new Float32Array(n)};}
function copy(F) {return {...F,px:F.px.slice(),py:F.py.slice()};}
const old=frame(2000),next=frame(2200);
for(let s=0;s<old.n;s++) {
    old.x[s]=old.px[s]=next.x[s]=next.px[s]=s*1.7;
    old.y[s]=old.py[s]=next.y[s]=next.py[s]=s*.3;
    if(s%4===0){old.px[s]-=1.25;old.py[s]+=3.75;next.x[s]+=12;next.y[s]-=30;}
    if(s%7===0){next.px[s]-=3;next.py[s]+=7;}
    if(s%11===0)next.id[s]=-1;
    if(s%13===0)next.id[s]+=4000;
}
for(const indexed of [false,true])for(const shown of [0,.15,.5,.999,1]) {
    const a=copy(next),b=copy(next);if(indexed)a.renderBuckets=b.renderBuckets={};
    reference(a,old,shown);rebase(b,old,shown);
    assert.deepEqual(b.px,a.px);assert.deepEqual(b.py,a.py);assert.equal(b.renderMotionPad,a.renderMotionPad);
}
const context=vm.createContext({SIM_FRAME_SLOT_BYTES:108});
vm.runInContext(source.slice(source.indexOf('let _simRebaseMarks'),source.indexOf('function _simClientApplyFrame(')),context);
const worker=fs.readFileSync(path.join(__dirname,'../src/sim/presentation_worker.js'),'utf8');
vm.runInContext(worker.slice(worker.indexOf('function buildRenderBuckets('),worker.indexOf('function draw()')),context);
const N=512,sim=frame(N);let lastFrame=null,lastReference=null,stamp=1000;
for(let s=0;s<N;s++){sim.x[s]=s*32;sim.y[s]=(s%50)*32;}
for(let tick=0;tick<30;tick++) {
    const F=frame(N);F.cap=N;F.count=N;
    F.x.set(sim.x);F.y.set(sim.y);F.px.set(sim.x);F.py.set(sim.y);F.id.set(sim.id);
    if(tick>0)for(let s=0;s<N;s++) {
        if(s%17===0){F.x[s]+=tick%3?13:0;F.y[s]-=tick%4?7:0;}
        if(s%37===0&&tick%3===0){F.x[s]+=300;F.px[s]=F.x[s];F.py[s]=F.y[s];} // teleport
        if(s%41===0&&tick%5===0)F.id[s]=-1;
        if(s%41===0&&tick%5===1)F.id[s]=++stamp; // slot reuse
    }
    sim.x.set(F.x);sim.y.set(F.y);sim.id.set(F.id);
    F.order=Int32Array.from(Array.from({length:N},(_,s)=>s).filter(s=>F.id[s]>=0));F.count=F.order.length;
    F.buf=new ArrayBuffer(N*108+64*64*8+N*8);
    const B=context.buildRenderBuckets(F,F.count,64,64,32);F.renderBuckets=B;
    F.renderMoving=new Int32Array(F.buf,B.movingOffset,N);F.renderMovingCount=B.movingCount;
    const expected=copy(F);
    if(lastFrame) {
        const alpha=tick%7===0?0:tick%6===0?1:.35;
        reference(expected,lastReference,alpha);context._simClientRebaseFrame(F,lastFrame,alpha);
        assert.deepEqual(F.px,expected.px,`sparse x at tick ${tick}`);
        assert.deepEqual(F.py,expected.py,`sparse y at tick ${tick}`);
        assert.ok(F.renderMotionPad>=expected.renderMotionPad-1e-6,'motion bounds remain conservative');
        assert.equal(new Set(F.renderMoving.subarray(0,F.renderMovingCount)).size,F.renderMovingCount);
        assert.ok(F.renderMovingCount<N/3,'static majority never enters the page interpolation loop');
    }
    lastFrame=F;lastReference=expected;
}
if(process.env.REBASE_BENCH) {
    const a=frame(600000),b=frame(600000);a.renderBuckets={};
    for(const fn of [reference,rebase]) {
        for(let i=0;i<10;i++)fn(a,b,.5);
        const start=performance.now();for(let i=0;i<30;i++)fn(a,b,.5);
        console.log(fn.name,((performance.now()-start)/30).toFixed(2)+' ms');
    }
}
console.log('PASS: interpolation rebase matches reference for idle/moving/dead/reused/new slots and conservative bounds.');
