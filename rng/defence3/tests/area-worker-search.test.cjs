'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const wasm64=process.argv.includes('--wasm64');
const ctx=vm.createContext({self:{crossOriginIsolated:true,SIM_WASM64_OPT:wasm64},console});
const source=['sim_parallel.js','sim_wasm_bin.js',...(wasm64?['sim_wasm64_bin.js']:[]),'sim_wasm.js'].map(f=>fs.readFileSync(path.join(__dirname,'../src/sim',f),'utf8')).join('\n');
vm.runInContext(source+';globalThis.scan=SIM_KERNELS[SIM_KERNEL_WS_SCAN];globalThis.eligible=SIM_KERNELS[SIM_KERNEL_WS_ELIGIBLE];simWasmInit();',ctx);
assert.equal(vm.runInContext('SIM_WASM64',ctx),wasm64);
const R={};
function put(name,type,values){const a=vm.runInContext(`simHeapArray(${type},${Math.max(1,values.length)})`,ctx);a.set(values);R[name]=a;ctx.__a=a;ctx.__name=name;vm.runInContext('simParallelBind(__name,__a)',ctx);return a;}
const n=5,w=16,h=8;
for(const name of ['rkind','rowner','rak','rgrp','rneed','rjid','rcur','rmy'])put('ws.'+name,'Int32Array',Array(n).fill(0));
for(const name of ['rox','roy','rux','ruy','rr','rax','ray'])put('ws.'+name,'Float32Array',Array(n).fill(name==='rr'?32:16));
R['ws.rkind'].set([3,4,1,3,3]);R['ws.rak'].fill(1);R['ws.rneed'].fill(1);R['ws.rjid'].fill(-1);R['ws.rcur'].fill(-1);R['ws.rmy'].fill(-1);
// Repeat the source window to exercise membership reuse, then change its
// range to ensure the cached membership cannot leak into the next request.
R['ws.rak'][4]=0;
put('ws.rpre','Int32Array',[0,n]);put('ws.res','Int32Array',Array(n*3).fill(-1));put('ws.score','Float32Array',Array(n*3).fill(Infinity));put('ws.ures','Int32Array',Array(n*3).fill(-1));
const ag=Array.from({length:w*h},(_,i)=>i%w<8?0:i%w<12?1:2);
put('ws.agrid','Int32Array',ag);put('ws.aoff','Int32Array',[0,1,2,2]);put('ws.anb','Int32Array',[1,0]);
put('area.bounds','Int32Array',[0,0,7,7,8,0,11,7,12,0,15,7]);
const flags=put('wsw.flags','Uint8Array',Array(w*h).fill(0));flags[10]=1;flags[14]=1;
put('wsw.own','Int8Array',Array(w*h).fill(0));put('wsw.area','Int32Array',ag);put('wsw.cnt','Int32Array',Array(16).fill(1));
put('wsh.x','Float32Array',[336]);put('wsh.y','Float32Array',[16]);put('wsh.a','Int32Array',[1]);put('wsh.n','Int32Array',[1]);
put('wsg0.meta','Int32Array',[2,0,0,2,1]);put('wsg0.sx','Float32Array',[336,464]);put('wsg0.sy','Float32Array',[16,16]);
put('wsg0.st','Int32Array',[1,1]);put('wsg0.so','Int32Array',[-1,-1]);put('wsg0.bs','Int32Array',[0,0]);put('wsg0.bc','Int32Array',[0,2]);put('wsg0.bi','Int32Array',[0,1]);
put('wsg0.abc','Int32Array',[0,0]);put('wsg0.abi','Int32Array',[-1,-1]);
const E=Array(64).fill(0);Object.assign(E,{0:1,1:2,2:0,3:1,4:0});ctx.eligible(R,E,0);
const P=Array(64).fill(0);Object.assign(P,{0:n,1:n,2:3,3:32,4:8,5:1,8:w,9:h,10:2,11:1,12:n,13:1,14:1,15:3,16:0});
ctx.scan(R,P,0);assert.equal(R['ws.res'][0],-1);assert.equal(R['ws.ures'][3],-1);assert.equal(R['ws.res'][6],-1);
P[56]=1;ctx.scan(R,P,0);
assert.equal(R['ws.res'][0],10,'builder finds work outside pixel radius');
assert.equal(R['ws.ures'][3],0,'healer finds damaged ally outside pixel radius');
assert.equal(R['ws.res'][6],0,'collector finds resource outside pixel radius');
assert.equal(R['ws.res'][7],-1,'collector excludes resource in disconnected area');
assert.equal(R['ws.res'][9],10,'reused source membership matches');
assert.equal(R['ws.res'][12],-1,'changed range invalidates cached membership');
console.log('PASS: area worker kernel finds distant eligible builders, healers and resources; excludes disconnected areas; caches by source and range');
