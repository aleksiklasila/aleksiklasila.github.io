// tickbench EVALALL probe (with DUMPBIN=dir): one kernel's inputs on the
// guest (no helpers: every chunk runs on its thread), for .claude/kbench.cjs.
// Placeholders set by the caller (sed): __KERNEL__ (e.g. SIM_KERNEL_SEP_PAIRS,
// several separated by +), __TICK__ (gameTime at or after which the first
// call of each is taken). Saved per kernel K: the arrays its source names
// (R['...']), its params (K.P), the calls it got that tick with each
// chunk's params when they differ (K.chunks: chunk, param set), as
// __scratch.bin entries.
(() => {
    if (typeof _simPool !== 'undefined' && _simPool) return;
    const T = Number('__TICK__') || 150;
    const bin = __scratch.bin || (__scratch.bin = {});
    for (const name of '__KERNEL__'.split('+')) {
        const id = globalThis[name] !== undefined ? globalThis[name] : eval(name);
        const orig = SIM_KERNELS[id];
        const keys = [...new Set([...orig.toString().matchAll(/R\['([^']+)'\]/g)].map(m => m[1]))];
        let state = 0, tick = -1;
        const calls = [], params = [];
        SIM_KERNELS[id] = function (R, P, chunk) {
            if (state === 0 && gameTime >= T) {
                state = 1; tick = gameTime;
                for (const k of keys) if (R[k] && ArrayBuffer.isView(R[k])) bin[name + '@' + k] = R[k].slice();
            }
            if (state === 1) {
                if (gameTime !== tick) state = 2;
                else {
                    let pi = params.findIndex(q => q.length === P.length && q.every((v, i) => v === P[i] || (v !== v && P[i] !== P[i])));
                    if (pi < 0) { pi = params.length; params.push(Float64Array.from(P)); }
                    calls.push(chunk, pi);
                    params.forEach((q, i) => { bin[name + '@P' + i] = q; });
                    bin[name + '@calls'] = Int32Array.from(calls);
                }
            }
            return orig.apply(this, arguments);
        };
    }
})();
