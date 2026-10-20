// Heap transport carries addresses as Numbers, never serialized view offsets.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ctx=vm.createContext({console,SharedArrayBuffer,Atomics});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/sim/sim_parallel.js'),'utf8'),ctx);
const check=(memory,offset)=>{
    ctx.memory=memory;vm.runInContext('_simWasmMem=memory',ctx);
    for(const Type of [Int8Array,Uint8Array,Int16Array,Uint16Array,Int32Array,Uint32Array,Float32Array,Float64Array]) {
        const source=new Type(memory.buffer,offset,8);source[0]=71;ctx.array=source;ctx.offset=offset;
        const descriptor=vm.runInContext('_simBindValue(array,offset)',ctx);
        assert.equal(descriptor.heapType,Type.name);assert.equal(descriptor.length,8);
        ctx.descriptor=structuredClone(descriptor);
        const received=vm.runInContext('_simBindArray(descriptor,offset)',ctx);
        assert.equal(received.byteOffset,offset);assert.equal(received[0],71);
        received[1]=39;assert.equal(source[1],39);
    }
};
check({buffer:new SharedArrayBuffer(65536)},128);
let memory64;
try {memory64=new WebAssembly.Memory({initial:1n,maximum:100000n,address:'i64',shared:true});}catch{}
if(memory64) {
    // Reserve address space; touch only two tiny views, not 4 GiB of pages.
    memory64.grow(65537n);
    check(memory64,2**31+64);check(memory64,2**32+64);
    console.log('PASS: all heap view types share their exact data above 2 and 4 GiB after transport');
} else console.log('PASS: heap descriptors; memory64 addresses require Node 24+');
const plain=new Uint8Array([1,2]);ctx.plain=plain;
assert.equal(vm.runInContext('_simBindValue(plain,-1)',ctx),plain);
