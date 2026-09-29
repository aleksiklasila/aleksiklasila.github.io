// Run the production helper protocol on real threads, not the virtual-clock
// Worker shim. Compare every output byte for 0, 1 and 7 helpers, including
// rebindings between jobs. Instrument claims only in the test workers.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Worker, MessageChannel } = require('node:worker_threads');
const H = require('./net-harness.cjs');
const root = path.join(__dirname, '..');
const parallel = fs.readFileSync(path.join(root, 'src/sim/sim_parallel.js'), 'utf8');
const frame = fs.readFileSync(path.join(root, 'src/sim/sim_frame.js'), 'utf8');
const workerCode = `const { parentPort, workerData, MessageChannel } = require('node:worker_threads');
    globalThis.self = { crossOriginIsolated:true }; globalThis.MessageChannel = MessageChannel;
    (0,eval)(workerData.source + '\\nlet testIndex = 0; const testFns = SIM_KERNELS.slice(); for (let k = 0; k < testFns.length; k++) SIM_KERNELS[k] = (R,P,c) => { testFns[k](R,P,c); if (R["test.claims"]) Atomics.add(R["test.claims"], testIndex, 1); }; simParallelHelperMain(); globalThis.testSetIndex = n => testIndex = n;');
    parentPort.on('message', m => { if(m.type === 'init') testSetIndex(m.index); self.onmessage({data:m}); if(m.type === 'bind') parentPort.postMessage({bound:m.ver}); });
    parentPort.postMessage({ready:true});`;

(async () => {
    const world = new H.World({controls:H.SMALL_MATCH_CONTROLS});
    const inst = world.spawn('source', {simWorker:false}); inst.eval('startSoloGame();');
    // Dense enough to expose poor work distribution, mixed owners/layers and
    // exact overlaps; large frame exercises enough chunks to engage all cores.
    inst.eval(`const runKernel = simParallelRun;
        simParallelRun = function(kernel, total) {
            if (kernel === SIM_KERNEL_SEPARATION_PREPARE) {
                __scratch.prepareParams = Array.from(_simParams);
                __scratch.prepareReg = Object.fromEntries(Object.entries(_simParReg).filter(([k])=>k.startsWith('sep.')||k.startsWith('unit.')||k==='spatial.keys').map(([k,v])=>[k,v.slice()]));
            }
            if (kernel === SIM_KERNEL_SEPARATION || kernel === SIM_KERNEL_SEPARATION_FINISH) {
                const prefix = kernel === SIM_KERNEL_SEPARATION ? 'sep' : 'finish';
                __scratch[prefix + 'Params'] = Array.from(_simParams);
                __scratch[prefix + 'Reg'] = Object.fromEntries(Object.entries(_simParReg).filter(([k])=>k.startsWith('sep.')||k.startsWith('unit.')).map(([k,v])=>[k,v.slice()]));
            }
            return runKernel(kernel, total);
        };
        for (let i=0;i<6000;i++) { const u=new Unit(i%5===0?'flying':'norm',i&1,100+(i%80)*3,100+Math.floor(i/80)*3); units.push(u); }
        gameTick(); runUnitSeparationPass();
        simFrameEncode(); __scratch.frameParams=Array.from(_simParams);
        __scratch.frameReg=Object.fromEntries(Object.entries(_simParReg).filter(([k])=>k.startsWith('frame.')||k.startsWith('unit.')).map(([k,v])=>[k,v.slice()]));`);
    assert.deepEqual(inst.errors.map(String), []);
    const scenarios = [
        {kernel:6, params:inst.scratch.prepareParams, reg:inst.scratch.prepareReg,
            outputs:['sep.ord','sep.slots','sep.keys','sep.jobs','sep.sx','sep.sy','sep.sr','sep.so','sep.sid','sep.sl','sep.sc','sep.sdx','sep.sdy','sep.start','sep.chunkR','sep.sole','sep.chunkC'], total:p=>Math.ceil(p[0]/p[1])},
        {kernel:7, params:inst.scratch.finishParams, reg:inst.scratch.finishReg,
            outputs:['sep.nextX','sep.nextY','sep.fast'], total:p=>Math.ceil(p[0]/p[1])},
        {kernel:3, params:[inst.scratch.sepReg['sep.start'][inst.scratch.sepParams[0]*inst.scratch.sepParams[1]],512], reg:{...inst.scratch.sepReg,...Object.fromEntries(Object.entries(inst.scratch.frameReg).filter(([k])=>k.startsWith('unit.')))}, outputs:['sep.sx','sep.sy','sep.sr','sep.so','sep.sid'], total:p=>Math.ceil(p[0]/p[1])},
        {kernel:1, params:inst.scratch.sepParams, reg:inst.scratch.sepReg, outputs:['sep.px','sep.py','sep.ov','sep.hit'], total:p=>Math.ceil(p[9]/p[2])},
        {kernel:2, params:inst.scratch.frameParams, reg:inst.scratch.frameReg, outputs:['frame.buffer.0'], total:p=>Math.ceil(p[1]/p[2])}
    ];
    const expected = [];
    for (const helpers of [0,1,7]) {
        const workers=[];
        class BrowserWorker {
            constructor() {
                this.bound=0;
                this.worker=new Worker(workerCode,{eval:true,workerData:{source:parallel+'\n'+frame}});
                this.worker.on('error',e=>{throw e;});
                this.worker.on('message',m=>{if(m.bound) this.bound=m.bound;});
                workers.push(this);
            }
            postMessage(m) { this.worker.postMessage(m); }
        }
        const ctx=vm.createContext({self:{crossOriginIsolated:true},Worker:BrowserWorker,navigator:{hardwareConcurrency:16},MessageChannel,console});
        vm.runInContext(parallel+'\n'+frame,ctx);
        vm.runInContext(`simParallelInit('',${helpers});`,ctx);
        try {
            for(let round=0;round<3;round++) for(let j=0;j<scenarios.length;j++) {
                const sc=scenarios[j];
                for(const [name,arr] of Object.entries(sc.reg)) {
                    const copy=new arr.constructor(new SharedArrayBuffer(arr.byteLength)); copy.set(arr);
                    if(name.startsWith('sep.')&&sc.outputs.includes(name)) copy.fill(0);
                    ctx.binding={name,arr:copy}; vm.runInContext('simParallelBind(binding.name,binding.arr)',ctx);
                }
                const claims=new Int32Array(new SharedArrayBuffer(7*4)); ctx.binding={name:'test.claims',arr:claims};
                vm.runInContext('simParallelBind(binding.name,binding.arr)',ctx);
                const version=vm.runInContext('_simParRegVer',ctx);
                const deadline=Date.now()+15000;
                while(workers.some(w=>w.bound<version)) { if(Date.now()>deadline) throw new Error('helper bind timeout'); await new Promise(r=>setTimeout(r,5)); }
                ctx.params=sc.params; vm.runInContext('_simParams.set(params)',ctx);
                vm.runInContext(`simParallelRun(${sc.kernel},${sc.total(sc.params)})`,ctx,{timeout:30000});
                const output=sc.outputs.map(name=>{ctx.name=name;const a=vm.runInContext('_simParReg[name]',ctx);return Buffer.from(a.buffer,a.byteOffset,a.byteLength);});
                if(helpers===0&&round===0) expected[j]=output.map(b=>Buffer.from(b));
                else output.forEach((b,k)=>assert.deepEqual(b,expected[j][k],`${helpers} helpers round ${round} ${sc.outputs[k]}`));
                if(helpers) assert.ok(claims.some(n=>n>0),'real helpers must claim work');
            }
        } finally { await Promise.all(workers.map(w=>w.worker.terminate())); }
    }
    console.log('PASS: actual SharedArrayBuffer workers: every separation/frame output byte identical with 0, 1 and 7 helpers over repeated rebindings.');
})().catch(e=>{console.error(e);process.exit(1);});

