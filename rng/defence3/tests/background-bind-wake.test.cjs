// A helper must resume an already posted job when its late bindings arrive.
// Hold the bindings until the helper has observed the job and gone to sleep;
// no new foreground generation or caller participation may rescue the job.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { Worker } = require('node:worker_threads');
const source = fs.readFileSync(process.env.PARALLEL_SOURCE || path.join(__dirname, '../src/sim/sim_parallel.js'), 'utf8');
const kernel = `SIM_KERNELS[110] = function(R) { Atomics.add(R.test, 0, 1); if (!_simPool) parentPort.postMessage({ done: true }); };`;
const workerCode = `const { parentPort, workerData, MessageChannel } = require('node:worker_threads');
globalThis.parentPort = parentPort;
globalThis.self = { crossOriginIsolated: true }; globalThis.MessageChannel = MessageChannel;
const wait = Atomics.waitAsync;
Atomics.waitAsync = function(...args) { const r = wait(...args); if(r.async) parentPort.postMessage({ waiting: args[2] }); return r; };
(0, eval)(workerData + '\\nsimParallelHelperMain();');
parentPort.on('message', m => self.onmessage({data:m}));`;
async function run(batch) {
    globalThis.self = { crossOriginIsolated: true };
    Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 8 }, configurable: true });
    let helper;
    globalThis.Worker = class {
        constructor() {
            helper = this; this.held = []; this.messages = [];
            this.w = new Worker(workerCode, { eval: true, workerData: source + '\n' + kernel });
            this.w.on('message', m => { this.messages.push(m); if(this.changed) this.changed(); });
        }
        postMessage(m) { if(m.type === 'bind' || m.type === 'binds') this.held.push(m); else this.w.postMessage(m); }
        async until(test) {
            if(this.messages.some(test)) return;
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => { this.changed = null; reject(Error('helper did not resume the pending job after its bindings arrived')); }, 3000);
                this.changed = () => { if(this.messages.some(test)) { clearTimeout(timer); this.changed = null; resolve(); } };
            });
        }
    };
    (0, eval)(source + '\n' + kernel + '\nglobalThis.P = {simParallelInit,simParallelBind,simParallelBindBatch,simParallelBindFlush,simParallelBackground,simParallelBackgroundWait,pool:()=>_simPool};');
    P.simParallelInit('',1);
    try {
        const A = new Int32Array(new SharedArrayBuffer(4));
        if(batch) P.simParallelBindBatch();
        P.simParallelBind('test',A);
        if(batch) P.simParallelBindFlush();
        P.simParallelBackground(110,1,3);
        const generation = P.pool().ctl[0];
        await helper.until(m => m.waiting === generation);
        assert.equal(A[0],0);
        for(const m of helper.held) helper.w.postMessage(m);
        await helper.until(m => m.done);
        P.simParallelBackgroundWait(3);
        assert.equal(A[0],1,'helper completed the chunk exactly once');
        assert.equal(P.pool().ctl[0],generation,'binding arrival must not change foreground generation');
    } finally { await helper.w.terminate(); }
}
(async()=>{for(const batch of [false,true]) await run(batch);console.log('PASS: single and batched late bindings wake pending background work');})().catch(e=>{console.error(e);process.exitCode=1;});
