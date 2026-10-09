{
    const now = __scratch.realNow || (() => Date.now());
    const T = __scratch.ht = { n: 0, total: 0, stat: 0, wait: 0, merge: 0, core: 0, full: 0, res: 0, glob: 0 };
    { const f = snapTickHash; snapTickHash = function () { const t0 = now(); try { return f.apply(this, arguments); } finally { T.total += now() - t0; T.n++; } }; }
    { const f = _snapTickHashStatic; _snapTickHashStatic = function () { const t0 = now(); try { return f.apply(this, arguments); } finally { T.stat += now() - t0; } }; }
    { const f = _snapForReservations; _snapForReservations = function () { const t0 = now(); try { return f.apply(this, arguments); } finally { T.res += now() - t0; } }; }
    { const f = _snapHashGlobals; _snapHashGlobals = function () { const t0 = now(); try { return f.apply(this, arguments); } finally { T.glob += now() - t0; } }; }
    { const f = SIM_KERNELS[SIM_KERNEL_SNAP_MERGE]; SIM_KERNELS[SIM_KERNEL_SNAP_MERGE] = function () { const t0 = now(); try { return f.apply(this, arguments); } finally { T.merge += now() - t0; } }; }
    { const f = simParallelBackgroundWait; simParallelBackgroundWait = function (lane) { const t0 = now(); try { return f.apply(this, arguments); } finally { if (lane === SIM_LANE_HASH) T.wait += now() - t0; } }; }
}
__scratch.snapHT = { now: __scratch.realNow, slices: 0, ents: 0, drops: 0, grid: 0, rebuilds: 0, order: 0 };
{ const f = _snapHashOrder; _snapHashOrder = function () { const t0 = __scratch.realNow(); try { return f.apply(this, arguments); } finally { __scratch.snapHT.order += __scratch.realNow() - t0; } }; }
