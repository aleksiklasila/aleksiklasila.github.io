'use strict';
// Released slots must be indistinguishable from fresh ones, including NaNs,
// negative zero and the trailing elements of strided columns. Check sparse
// lists, skipped entries, job boundaries and the contiguous-range ABI.
const assert = require('node:assert/strict');
globalThis.self = { crossOriginIsolated: true };
const H = require('./net-harness.cjs');
const world = new H.World({ controls: H.SMALL_MATCH_CONTROLS });
const inst = world.spawn('slot-zero', { simWorker: false });
inst.scratch.Worker = require('./real-sim-helper.cjs');
inst.eval('startSoloGame();Worker=__scratch.Worker;navigator.hardwareConcurrency=8;simParallelInit("",3);');
const result = inst.eval(`(() => {
    const cap=257, specs=[
        [Uint8Array,1,undefined], [Int8Array,1,-1], [Uint16Array,1,65535], [Int16Array,3,-32768],
        [Uint32Array,1,4294967295], [Int32Array,1,-2147483648], [Float32Array,1,NaN],
        [Float32Array,1,-0], [Float32Array,5,1.25], [Float64Array,1,NaN],
        [Float64Array,1,-0], [Float64Array,3,-Infinity], [Float64Array,1,Math.PI]
    ];
    const cols=specs.map(([T,per])=>simSharedArray(T,cap*per));
    const tab=simSharedArray(Int32Array,specs.length*3),defs=simSharedArray(Float64Array,specs.length*2);
    const keys=simSharedArray(Uint32Array,cap),layers=simSharedArray(Uint8Array,cap),list=simSharedArray(Int32Array,cap);
    specs.forEach(([T,per,v],i)=>{tab.set([_simWEnc(_simHeapPtrOf(cols[i])),T.BYTES_PER_ELEMENT,per],i*3);defs.set(_simSlotDefWord(cols[i],v),i*2);});
    const bind=(name,a)=>simParallelBind(name,a);
    bind('slz.tab',tab);bind('slz.defs',defs);bind('unit.sepKey',keys);bind('unit.sepLayer',layers);
    let checked=0;
    for(const mode of ['sparse','contiguous','no-defaults']){
        cols.forEach(a=>a.fill(17));keys.fill(23);layers.fill(7);
        const selected=new Set(),n=mode==='contiguous'?129:193,from=33,per=16;
        for(let i=0;i<n;i++){const s=i%11===0?-1:(i*73)%cap;list[i]=s;if(s>=0)selected.add(s);}
        if(mode==='contiguous'){selected.clear();for(let s=from;s<from+n;s++)selected.add(s);}
        bind('slz.list',mode==='contiguous'?null:list);bind('slz.defs',mode==='no-defaults'?null:defs);
        _simParams[0]=n;_simParams[1]=per;_simParams[2]=specs.length;_simParams[3]=SIM_SEP_ABSENT;_simParams[4]=from;
        if(mode==='sparse')simParallelRun(SIM_KERNEL_SLOT_ZERO,Math.ceil(n/per));
        else {_simParams[1]=n;simRustDirect('k_slot_zero',[mode==='contiguous'?null:list,tab,keys,layers,mode==='no-defaults'?null:defs,null],_simParams);}
        specs.forEach(([T,width,value],c)=>{
            const converted=new T(1);converted[0]=value===undefined?0:value;
            for(let s=0;s<cap;s++)for(let j=0;j<width;j++){
                const want=!selected.has(s)?17:mode==='no-defaults'||j>0?0:converted[0];
                if(!Object.is(cols[c][s*width+j],want))throw Error(mode+' column '+c+' slot '+s+' element '+j);
                checked++;
            }
        });
        for(let s=0;s<cap;s++)if(keys[s]!== (selected.has(s)?SIM_SEP_ABSENT:23)||layers[s]!== (selected.has(s)?0:7))throw Error('separation guard '+mode+' '+s);
    }
    return {checked,helpers:simParallelHelpers()};
})()`);
assert.equal(result.helpers, 3);
assert.ok(result.checked > 10000);
assert.deepEqual(inst.errors.map(String), []);
console.log('PASS: slot defaults, strides, guards and job boundaries (' + result.checked + ' values, 3 helpers)');
process.exit(0);
