'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {performance}=require('node:perf_hooks');
const root=path.join(__dirname,'../src/sim');
const jobs=[],messages=[];
const c=vm.createContext({console,performance,setTimeout:fn=>jobs.push(fn),postMessage:m=>messages.push(m)});
c.self=c;
c.importScripts=(...files)=>{for(const f of files)vm.runInContext(fs.readFileSync(path.join(root,f.split('?')[0]),'utf8'),c);};
vm.runInContext(fs.readFileSync(path.join(root,'presentation_worker.js'),'utf8'),c);
// (The simulation's heap: presentation_worker.js reads its columns there in place. Positions in eighths of a pixel.)
const H=require('./present-sim.cjs')(c,64,{records:65});c.C=H.C;c.M=H.M;c.M.id.fill(-1);
for(let s=0;s<4;s++) { c.C.id[s]=10+s;c.C.live[s]=1;c.C.x[s]=8*(100+s);c.C.prevX[s]=c.C.x[s];c.C.energy[s]=20;c.C.r[s]=8;c.M.id[s]=10+s;c.M.type[s]=1;c.M.vision[s]=2;c.M.orderDest[s]=s===3?-41:23;c.M.orderTick[s]=7; }
const send=data=>{c.onmessage({data});while(jobs.length)jobs.shift()();assert.equal(messages.some(m=>m.type==='error'),false,JSON.stringify(messages.filter(m=>m.type==='error')));};
send(H.bind({epoch:2,generation:7}));
send({type:'strings',strings:['','norm']});
const tick=n=>send({type:'tick',epoch:2,tick:n,time:n,rate:20,player:0,areaUnit:2,n:4});
tick(0);assert.equal(messages.length,0,'wait for initial metadata before replacing the complete startup frame');
send({type:'ready'});
assert.equal(messages.length,1);
const U=m=>m.world.units, V=m=>c.simFrameViews(U(m).buf,64,U(m).base), bytes=m=>Buffer.from(new Uint8Array(U(m).buf,U(m).base,c.simFrameBytes(64)));
const rel=m=>send({type:'release',rid:U(m).rid,gen:U(m).gen});
const first=messages[0], f=V(first);
assert.equal(first.world.units.count,4);assert.equal(f.x[0],100);
assert.equal(f.orderDest[0],23);assert.equal(f.orderDest[3],-41);assert.equal(f.orderTick[0],7);
const saved=bytes(first);
c.C.x[0]=8*500;c.C.stIx[0]=1;c.C.stBu[1]=1;c.C.stIx[2]=3;c.C.stTh[3]=3;
tick(1);tick(2);tick(3);tick(4);
assert.equal(messages.length,3,'a stalled page owns at most three unit snapshots');
assert.deepEqual(bytes(first),saved,'reader never rewrites a page-owned snapshot');
rel(first);
assert.equal(messages.length,4);assert.equal(messages.at(-1).tick,4,'resume at newest tick; do not queue stale visual work');
let frame=V(messages.at(-1));
assert.ok(frame.x[0]>=436 && frame.x[0]<=500, 'large movement catches up within the visual lag budget');
assert.ok(frame.flags[0]&16);assert.ok(frame.flags[2]&1024);
assert.equal(c.C.x[0],8*500,'presentation leaves authority columns untouched');
// Slot reuse must not attach the previous unit's metadata to a new identity.
c.C.id[1]=99;
rel(messages[1]);tick(5);
frame=V(messages.at(-1));
assert.equal(frame.id[1],-1);assert.equal(messages.at(-1).world.units.count,3);
c.M.id[1]=99;c.M.type[1]=2;
rel(messages[2]);tick(6);
frame=V(messages.at(-1));
assert.equal(frame.id[1],99);assert.equal(frame.type[1],2);
assert.deepEqual(Array.from(frame.order.subarray(0,4),s=>frame.id[s]),[10,12,13,99]);
// A delayed buffer return from a terminated reader cannot free this reader's
// identically numbered buffer (which may still be in use on the page).
vm.runInContext('var foreign=new SharedArrayBuffer(12);var trailer=new DataView(foreign);trailer.setInt32(0,6,true);trailer.setInt32(4,1,true);trailer.setInt32(8,PRESENT_MAGIC,true);',c);
const busy=vm.runInContext('[...buffers.values()].filter(e=>e.busy).length',c);
send({type:'release',buf:c.foreign});send({type:'release',rid:U(messages.at(-1)).rid,gen:6});
assert.equal(vm.runInContext('[...buffers.values()].filter(e=>e.busy).length',c),busy);
console.log('PASS: independent shared reader, bounded pool, newest-frame backpressure, slot reuse, immutable outputs and stale returns');
