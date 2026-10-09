// tickbench EVALALL probe (with DUMPBIN=dir): one kernel's inputs on the
// guest (no helpers: every chunk runs on its thread), for .claude/kbench.cjs.
// Placeholders set by the caller (sed): SIM_KERNEL_MOVE+SIM_KERNEL_SEP_PAIRS+SIM_KERNEL_STATUS+SIM_KERNEL_SEP_PACK+SIM_KERNEL_SEP_MARK (e.g. SIM_KERNEL_SEP_PAIRS,
// several separated by +), 180 (gameTime at or after which the first
// call of each is taken). Saved per kernel K: the arrays its source names
// (R['...']), its params (K.P), the calls it got that tick with each
// chunk's params when they differ (K.chunks: chunk, param set), as
// __scratch.bin entries.
(() => {
    if (typeof _simPool !== 'undefined' && _simPool) return;
    const T = Number('180') || 150;
    const bin = __scratch.bin || (__scratch.bin = {});
    for (const name of 'SIM_KERNEL_MOVE+SIM_KERNEL_SEP_PAIRS+SIM_KERNEL_STATUS+SIM_KERNEL_SEP_PACK+SIM_KERNEL_SEP_MARK'.split('+')) {
        const id = globalThis[name] !== undefined ? globalThis[name] : eval(name);
        const orig = SIM_KERNELS[id];
        // (Its source and the _sim* functions it calls: e.g. the movement
        // kernel's passes.)
        const seen = new Set(), srcOf = fn => { let t = fn.toString(); for (const m of t.matchAll(/\b(_sim[A-Za-z0-9_]+)\(/g)) { if (seen.has(m[1])) continue; seen.add(m[1]); let g = null; try { g = eval(m[1]); } catch { } if (typeof g === 'function') t += srcOf(g); } return t; };
        const full = srcOf(orig), keys = [...new Set([...full.matchAll(/R\['([^']+)'\]/g)].map(m => m[1]))];
        // (Rust kernels: the names of their _simWK lists, _sim...W / _nav...W.)
        for (const m of full.matchAll(/\b(_(?:sim|nav)[A-Za-z0-9_]*W)\b/g)) {
            let K = null; try { K = eval(m[1]); } catch { }
            for (const k of (Array.isArray(K) ? K : K instanceof Map ? [...K.values()] : [K])) if (k && Array.isArray(k.names)) for (const nm of k.names) if (!keys.includes(nm)) keys.push(nm);
        }
        let state = 0, tick = -1;
        const calls = [], params = [];
        SIM_KERNELS[id] = function (R, P, chunk) {
            if (state === 0 && gameTime >= T) {
                state = 1; tick = gameTime;
                for (const k of keys) if (R[k] && ArrayBuffer.isView(R[k])) bin[name + '@' + k] = R[k].slice();
                // (Names made in the kernels' helpers, e.g. _simNavArrays:
                // every navigation build's arrays and walls.)
                if (/_simNav(Arrays|Walls)\(/.test(full))
                    for (const k in R) if (/^(nav\.\d+\.|mv\.cwall\.|mv\.airwall$)/.test(k) && ArrayBuffer.isView(R[k])) bin[name + '@' + k] = R[k].slice();
                // (And every array the Rust twin of a movement kernel takes:
                // _SIM_MOVE_WNAMES, nav.fmeta / frows / fpool / fhdr...)
                if (/_simMoveWasm\(/.test(full) && typeof _SIM_MOVE_WNAMES !== 'undefined')
                    for (const k0 of [..._SIM_MOVE_WNAMES, ...(typeof _SIM_MOVE_WNAMES2 !== "undefined" ? _SIM_MOVE_WNAMES2 : [])]) { const k = k0.replace(/^\?/, ''); if (R[k] && ArrayBuffer.isView(R[k]) && !bin[name + '@' + k]) bin[name + '@' + k] = R[k].slice(); }
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
