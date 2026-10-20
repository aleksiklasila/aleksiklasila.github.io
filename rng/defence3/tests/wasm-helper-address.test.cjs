// Helper initialization must preserve byte addresses beyond 2/4 GiB.
// Mock only the storage: no multi-gigabyte allocation needed to exercise
// the real init/argument-view code and memory64 export adapter.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/sim/sim_wasm.js'),'utf8');
for(const w64 of [false,true]) for(const address of (w64?[2**31+64,2**32+64,12*2**30+64]:[1024,2**31+64])) {
    const views=[], errors=[];
    const context=vm.createContext({console:{error:(...args)=>errors.push(args)},
        Int32Array:class {constructor(buffer,offset,length){views.push({offset,length,type:'i32'});}},
        Float64Array:class {constructor(buffer,offset,length){views.push({offset,length,type:'f64'});}},
        WebAssembly:{Instance:class {constructor(){this.exports={__stack_pointer:{value:0},probe:v=>v};}}},
        _simHeapAlloc:null,_simHeapAllocAuto:null,_simHeapRelease:null,_simHeapPtrOf:null,_simHeapViewReg:null,
        _simWShift:0,_simWasmArgs:0,_simWasmArgsW:0,_simWasmArgI:null,_simWasmArgF:null,
        _simWasmScratch:0,_simWasmScratchWords:0,_simWasmX:null,_simWasmMem:null,_simWasmOn:false,
        _simWEnc:p=>w64?p/4:p});
    vm.runInContext(source,context);
    context.payload={w64,module:{},memory:{buffer:{}},i64:{probe:[0]},on:true,
        stackTop:address+262144,scratch:address+8192,scratchWords:1048576,args:address};
    vm.runInContext('simWasmHelperInit(payload)',context);
    assert.deepEqual(errors,[]);
    assert.equal(context._simWasmArgs,address);
    assert.equal(context._simWasmArgsW,w64?address/4:address);
    assert.equal(context._simWasmScratch,address+8192);
    assert.equal(context._simWasmScratchWords,1048576);
    assert.deepEqual(views,[{offset:address,length:1024,type:'i32'},{offset:address+4096,length:512,type:'f64'}]);
    assert.equal(context._simWasmX.__stack_pointer.value,w64?BigInt(address+262144):address+262144);
    assert.equal(context._simWasmX.probe(address),w64?BigInt(address):address);
}
console.log('PASS: wasm32/64 helper pointers retain addresses above 2 and 4 GiB');
