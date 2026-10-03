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
vm.runInContext(`
var C={};
for(const k of ['id','owner','x','y','prevX','prevY','vx','vy','energy','r','commandState','attackFlash','burning','poisoned','frozen','wet','sandy','watched','teleportHideTicks','workerTransferCooldown','effectiveLevel','unitLevel','live','dead','maxE']) C[k]=new Float64Array(new SharedArrayBuffer(64*8));
var M=simFrameViews(new SharedArrayBuffer(64*SIM_FRAME_SLOT_BYTES),64);M.id.fill(-1);
for(let s=0;s<4;s++) { C.id[s]=10+s;C.live[s]=1;C.x[s]=100+s;C.energy[s]=20;C.r[s]=8;M.id[s]=10+s;M.type[s]=1;M.vision[s]=2; }
`,c);
const send=data=>{c.onmessage({data});while(jobs.length)jobs.shift()();assert.equal(messages.some(m=>m.type==='error'),false,JSON.stringify(messages.filter(m=>m.type==='error')));};
send({type:'bind',epoch:2,generation:7,columns:c.C,meta:{buf:c.M.buf,cap:64}});
send({type:'strings',strings:['','norm']});
const tick=n=>send({type:'tick',epoch:2,tick:n,time:n,rate:20,player:0,areaUnit:2,n:4});
tick(0);assert.equal(messages.length,0,'wait for initial metadata before replacing the complete startup frame');
send({type:'ready'});
assert.equal(messages.length,1);
const first=messages[0], f=c.simFrameViews(first.world.units.buf,64);
assert.equal(first.world.units.count,4);assert.equal(f.x[0],100);
const saved=Buffer.from(new Uint8Array(first.world.units.buf));
c.C.x[0]=500;c.C.burning[0]=1;c.C.teleportHideTicks[2]=3;
tick(1);tick(2);tick(3);tick(4);
assert.equal(messages.length,3,'a stalled page owns at most three unit snapshots');
assert.deepEqual(Buffer.from(new Uint8Array(first.world.units.buf)),saved,'reader never rewrites a page-owned snapshot');
send({type:'release',buf:first.world.units.buf});
assert.equal(messages.length,4);assert.equal(messages.at(-1).tick,4,'resume at newest tick; do not queue stale visual work');
let frame=c.simFrameViews(messages.at(-1).world.units.buf,64);
assert.equal(frame.x[0],500);assert.ok(frame.flags[0]&16);assert.ok(frame.flags[2]&1024);
assert.equal(c.C.x[0],500,'presentation leaves authority columns untouched');
// Slot reuse must not attach the previous unit's metadata to a new identity.
c.C.id[1]=99;
send({type:'release',buf:messages[1].world.units.buf});tick(5);
frame=c.simFrameViews(messages.at(-1).world.units.buf,64);
assert.equal(frame.id[1],-1);assert.equal(messages.at(-1).world.units.count,3);
c.M.id[1]=99;c.M.type[1]=2;
send({type:'release',buf:messages[2].world.units.buf});tick(6);
frame=c.simFrameViews(messages.at(-1).world.units.buf,64);
assert.equal(frame.id[1],99);assert.equal(frame.type[1],2);
assert.deepEqual(Array.from(frame.order.subarray(0,4),s=>frame.id[s]),[10,12,13,99]);
// A delayed buffer return from a terminated reader cannot free this reader's
// identically numbered buffer (which may still be in use on the page).
vm.runInContext('var foreign=new SharedArrayBuffer(12);var trailer=new DataView(foreign);trailer.setInt32(0,6,true);trailer.setInt32(4,1,true);trailer.setInt32(8,PRESENT_MAGIC,true);',c);
const busy=vm.runInContext('[...buffers.values()].filter(e=>e.busy).length',c);
send({type:'release',buf:c.foreign});
assert.equal(vm.runInContext('[...buffers.values()].filter(e=>e.busy).length',c),busy);
console.log('PASS: independent shared reader, bounded pool, newest-frame backpressure, slot reuse, immutable outputs and stale returns');
