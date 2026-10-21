// Browser helper-worker adapter for headless scale measurements.
'use strict';
const { Worker, isMainThread, parentPort, MessageChannel, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
if (!isMainThread) {
    globalThis.self = { crossOriginIsolated: true };
    globalThis.MessageChannel = MessageChannel;
    globalThis.importScripts = (...files) => {
        const overrides=JSON.parse(process.env.DEFENCE_TEST_SOURCE_OVERRIDES||'{}');
        for (const file of files) {const target=path.join(__dirname,'../src/sim',file.split('?')[0]),key=path.relative(path.join(__dirname,'..'),target).split(path.sep).join('/');vm.runInThisContext(fs.readFileSync(overrides[key]?path.resolve(__dirname,'..',overrides[key]):target,'utf8'), { filename:file });}
    };
    importScripts('sim_helper.js');
    if (workerData?.contactTrace) {
        globalThis.__contactTraceConfig = workerData.contactTrace;
        vm.runInThisContext(fs.readFileSync(path.join(__dirname, 'contact-trace.js'), 'utf8'), { filename: 'contact-trace.js' });
    }
    let profileSession=null;
    parentPort.on('message', async data => {
        if(data.type!=='bench-profile'){self.onmessage({data});return;}
        try{
            const counters=()=>vm.runInThisContext('Array.from(new Uint32Array(_simWasmMem.buffer,_simWasmArgs+1536*4,64))');
            if(data.action==='start'){
                vm.runInThisContext('new Uint32Array(_simWasmMem.buffer,_simWasmArgs+1536*4,64).fill(0)');
                profileSession=new (require('node:inspector').Session)();profileSession.connect();
                await new Promise((ok,bad)=>profileSession.post('Profiler.enable',e=>e?bad(e):ok()));
                await new Promise((ok,bad)=>profileSession.post('Profiler.start',e=>e?bad(e):ok()));
                parentPort.postMessage({benchProfile:data.id,result:{}});
            }else{
                const result=await new Promise((ok,bad)=>profileSession.post('Profiler.stop',(e,r)=>e?bad(e):ok(r)));
                profileSession.disconnect();profileSession=null;result.counters=counters();
                parentPort.postMessage({benchProfile:data.id,result});
            }
        }catch(e){parentPort.postMessage({benchProfile:data.id,error:String(e.stack||e)});}
    });
} else {
    module.exports = class RealSimHelper {
        constructor() {
            const trace = module.exports.contactTrace;
            this.worker = new Worker(__filename, trace ? { workerData: { contactTrace: { ...trace, thread: ++module.exports.traceThread } } } : undefined);
            this.worker.on('error', err => { throw err; });
            this.profileRequests=new Map();this.profileSerial=0;
            this.worker.on('message',m=>{if(!m.benchProfile)return;const q=this.profileRequests.get(m.benchProfile);if(!q)return;this.profileRequests.delete(m.benchProfile);m.error?q.reject(Error(m.error)):q.resolve(m.result);});
            (module.exports.instances ||= []).push(this);
        }
        benchProfile(action){return new Promise((resolve,reject)=>{const id=++this.profileSerial;this.profileRequests.set(id,{resolve,reject});this.worker.postMessage({type:'bench-profile',action,id});});}
        postMessage(msg) { this.worker.postMessage(msg); }
        terminate() { return this.worker.terminate(); }
    };
}
