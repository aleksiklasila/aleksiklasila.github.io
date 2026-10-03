// tickbench EVALALL probe (with DUMPBIN=dir): like kdump.js, for several
// ticks: the inputs of kernels __KERNEL__ (+-separated) at each gameTime in
// __TICKS__ (comma-separated), saved as `<name>~<tick>@<array>` entries for
// .claude/kseq.cjs (replays the ticks in order, e.g. under --trace-deopt).
(() => {
    if (typeof _simPool !== 'undefined' && _simPool) return;
    const ticks = new Set('__TICKS__'.split(',').map(Number));
    const bin = __scratch.bin || (__scratch.bin = {});
    for (const name of '__KERNEL__'.split('+')) {
        const id = globalThis[name] !== undefined ? globalThis[name] : eval(name);
        const orig = SIM_KERNELS[id];
        // (Its source and the _sim* functions it calls: e.g. the movement
        // kernel's passes.)
        const seen = new Set(), srcOf = fn => { let t = fn.toString(); for (const m of t.matchAll(/\b(_sim[A-Za-z0-9_]+)\(/g)) { if (seen.has(m[1])) continue; seen.add(m[1]); let g = null; try { g = eval(m[1]); } catch { } if (typeof g === 'function') t += srcOf(g); } return t; };
        const keys = [...new Set([...srcOf(orig).matchAll(/R\['([^']+)'\]/g)].map(m => m[1]))];
        let tick = -1, calls = null, params = null;
        SIM_KERNELS[id] = function (R, P, chunk) {
            if (gameTime !== tick) {
                tick = gameTime; calls = null;
                if (ticks.has(tick)) {
                    calls = []; params = [];
                    for (const k of keys) if (R[k] && ArrayBuffer.isView(R[k])) bin[name + '~' + tick + '@' + k] = R[k].slice();
                }
            }
            if (calls) {
                let pi = params.findIndex(q => q.length === P.length && q.every((v, i) => v === P[i] || (v !== v && P[i] !== P[i])));
                if (pi < 0) { pi = params.length; params.push(Float64Array.from(P)); }
                calls.push(chunk, pi);
                params.forEach((q, i) => { bin[name + '~' + tick + '@P' + i] = q; });
                bin[name + '~' + tick + '@calls'] = Int32Array.from(calls);
            }
            return orig.apply(this, arguments);
        };
    }
})();
