// Opt-in benchmark instrumentation, loaded into the main VM and real helpers.
// Each thread owns its log: no per-chunk shared atomic increment.
(() => {
    const cfg = globalThis.__contactTraceConfig || __scratch.contactTrace;
    const ctl = new Int32Array(cfg.control), log = new Float64Array(cfg.events);
    const thread = cfg.thread, base = thread * cfg.capacity * 6;
    const clock = typeof __scratch !== 'undefined' ? __scratch.now : () => performance.now();
    let written = 0;
    const captured = new Set();
    function capture(R,P,c,tick) {
        if(thread!==0 || typeof __scratch.captureContact!=='function' || ![1,6,12].includes(tick) || captured.has(tick))return;
        captured.add(tick);
        const n=P[15]===1?R['ix.listed'][0]:P[9],cw=P[0],h=P[2],reach=Math.max(1,Math.ceil(P[4]/P[10]));
        const row0=(c*2+P[14])*h,row1=Math.min(P[1],row0+h),keys=R['sep.ekey'];
        const bound=k=>{let a=0,b=n;while(a<b){const m=(a+b)>>>1;if(keys[m]<k)a=m+1;else b=m;}return a;};
        const lo=bound(Math.max(0,row0-reach)*cw),hi=bound(Math.min(P[1],row1+reach)*cw),slots=new Map();
        const inputs={};
        for(const name of ['ord','qx','qy','qr','meta','qid','ekey','qv'])inputs[name]=Array.from(R['sep.'+name].subarray(lo,hi));
        inputs.ord=inputs.ord.map(s=>{if(s<0)return -1;if(!slots.has(s))slots.set(s,slots.size);return slots.get(s);});
        const outputs={};for(const name of ['px','py','ov','hit','cx','cy','fx','fy'])outputs[name]=Array.from(slots.keys(),s=>R['sep.'+name][s]);
        const params=Array.from(P);params[9]=hi-lo;params[15]=0;
        __scratch.captureContact({tick,chunk:c,originalRange:[lo,hi],originalListed:n,rows:[row0,row1],params,originalSlots:Array.from(slots.keys()),inputs,outputs});
    }
    function record(kind, start, end, a, b, tick) {
        if (written >= cfg.capacity) { Atomics.store(ctl, 16 + thread, -1); return; }
        const p = base + written++ * 6;
        log[p] = kind; log[p+1] = start; log[p+2] = end;
        log[p+3] = a; log[p+4] = b; log[p+5] = tick;
        Atomics.store(ctl, 16 + thread, written);
    }
    for (let k = 0; k < SIM_KERNELS.length; k++) {
        if (typeof SIM_KERNELS[k] !== 'function') continue;
        const fn = SIM_KERNELS[k];
        SIM_KERNELS[k] = function(R, P, c) {
            if (!Atomics.load(ctl, 0)) return fn(R, P, c);
            const tick = Atomics.load(ctl, 1), start = clock();
            if(k===SIM_KERNEL_SEP_PAIRS && thread===0)capture(R,P,c,tick);
            try { return fn(R, P, c); }
            finally { record(0, start, clock(), k, c, tick); }
        };
    }
    // Main-thread waits: wall time includes claiming and running kernels.
    if (thread === 0) {
        for (const name of ['simParallelBackgroundWait', 'simParallelBackgroundWaitStage', 'simParallelRun']) {
            const fn = eval(name);
            const kind = name === 'simParallelRun' ? 3 : name === 'simParallelBackgroundWaitStage' ? 2 : 1;
            const wrap = function(a = 1, b = -1) {
                if (!Atomics.load(ctl, 0)) return fn.apply(this, arguments);
                const tick = Atomics.load(ctl, 1), start = clock();
                try { return fn.apply(this, arguments); }
                finally { record(kind, start, clock(), a, b, tick); }
            };
            eval(name + '=wrap');
        }
        const wait = Atomics.wait;
        Atomics.wait = function(a, i, v, timeout) {
            if (!Atomics.load(ctl, 0)) return wait(a, i, v, timeout);
            const tick = Atomics.load(ctl, 1), start = clock();
            try { return wait(a, i, v, timeout); }
            finally { record(4, start, clock(), i, timeout, tick); }
        };
    }
})();
