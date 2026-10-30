// A helper must never see a published registry version missing its arrays.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const workers=[];
class Worker {constructor(){this.messages=[];workers.push(this);}postMessage(message){this.messages.push(message);}}
const ctx=vm.createContext({console,SharedArrayBuffer,Atomics,Worker,self:{crossOriginIsolated:true},navigator:{hardwareConcurrency:16}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/sim/sim_parallel.js'),'utf8'),ctx);
vm.runInContext(`for(let n=0;n<400;n++) simParallelBind('test.'+n,simSharedArray(Int32Array,4));
    simParallelInit('',7);`,ctx);
assert.equal(workers.length,7);
for(const worker of workers) {
    const expected=vm.runInContext('Object.keys(_simParReg)',ctx), bound=new Set();
    const finalVersion=vm.runInContext('_simParRegVer',ctx);
    for(const msg of worker.messages) {
        if(msg.type==='bind')bound.add(msg.name);
        if(msg.type==='binds')for(let i=0;i<msg.list.length;i+=3)bound.add(msg.list[i]);
        // A helper may claim a job at this version immediately after any
        // message handler: every name advertised by it must already exist.
        if(msg.ver===finalVersion)for(const name of expected)assert.ok(bound.has(name),'published version is missing '+name);
    }
    assert.equal(bound.size,expected.length);
}
console.log('PASS: all seven helpers receive the complete initial registry before publishing its version');
// A helper passed its outer version check, then the simulation replaced
// that lane with a job needing newer bindings before it entered the claim.
const claimCtx=vm.createContext({console,SharedArrayBuffer,Atomics,self:{crossOriginIsolated:true}});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/sim/sim_parallel.js'),'utf8'),claimCtx);
const claim=vm.runInContext(`(() => {
    const ctl=new Int32Array(new SharedArrayBuffer(SIM_PAR_CTL_WORDS*4)), chain=new Int32Array(49), params=[new Float64Array(64)];
    const b=SIM_PAR_BG_BASE;
    chain[0]=1; ctl[b+SIM_PAR_BG_ID]=0; ctl[b+SIM_PAR_BG_TOTAL]=1; ctl[b+SIM_PAR_BG_REGVER]=5;
    let calls=0; SIM_KERNELS[0]=()=>{calls++;};
    const stale=_simBgClaim(ctl,0,chain,params,4);
    const staleCalls=calls, claimed=ctl[b+SIM_PAR_BG_NEXT], readers=ctl[b+SIM_PAR_BG_READERS];
    const ready=_simBgClaim(ctl,0,chain,params,5);
    return {stale,staleCalls,claimed,readers,ready,calls,done:ctl[b+SIM_PAR_BG_DONE]};
})()`,claimCtx);
assert.deepEqual(JSON.parse(JSON.stringify(claim)),{stale:0,staleCalls:0,claimed:0,readers:0,ready:1,calls:1,done:1});
console.log('PASS: a replaced background lane cannot run on stale helper bindings');
