// tickbench EVALALL probe (with DUMPBIN=dir): the separation pair stage's
// inputs on the guest (no helpers: every chunk runs here) at the first pair
// job of gameTime __SEPDUMP_TICK__ (set by the caller with sed, default
// 150), and both parities' stage params. For .claude/sepbench.cjs.
(() => {
    if (typeof _simPool !== 'undefined' && _simPool) return;
    const T = Number('__SEPDUMP_TICK__') || 150;
    const orig = SIM_KERNELS[SIM_KERNEL_SEP_PAIRS];
    let done = false;
    SIM_KERNELS[SIM_KERNEL_SEP_PAIRS] = function (R, P, chunk) {
        if (!done && gameTime + 1 >= T && (P[14] | 0) === 0 && chunk === 0) {
            done = true;
            const bin = {};
            for (const k of ['sep.ord', 'sep.rec', 'sep.meta', 'sep.sid', 'sep.ekey', 'sep.rs', 'sep.rc', 'sep.rstamp', 'sep.chunkR', 'sep.sole', 'sep.box', 'sep.chunkP', 'sep.px', 'sep.py', 'sep.ov', 'sep.hit', 'ix.listed'])
                if (R[k]) bin[k.replace('.', '_')] = R[k].slice();
            bin.P0 = Float64Array.from(P);
            const P1 = Float64Array.from(P); P1[14] = 1; bin.P1 = P1;
            __scratch.bin = bin;
            __scratch.binTick = gameTime;
        }
        return orig.apply(this, arguments);
    };
})();
