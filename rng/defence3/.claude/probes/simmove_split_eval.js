{
    const now = __scratch.realNow;
    const T = __scratch.sm = { n: 0, total: 0, wait: 0, kernel: 0, combat: 0, hostile: 0, post: 0 };
    let inMove = false;
    { const f = simMoveRun; simMoveRun = function () { const a = now(); inMove = true; try { return f.apply(this, arguments); } finally { inMove = false; T.total += now() - a; T.n++; } }; }
    { const f = simParallelBackgroundWait; simParallelBackgroundWait = function () { const a = now(); try { return f.apply(this, arguments); } finally { if (inMove) T.wait += now() - a; } }; }
    { const f = simParallelRun; simParallelRun = function (k) { const a = now(); try { return f.apply(this, arguments); } finally { if (inMove && k === SIM_KERNEL_MOVE) T.kernel += now() - a; } }; }
    { const f = combatScanRun; combatScanRun = function () { const a = now(); try { return f.apply(this, arguments); } finally { if (inMove) T.combat += now() - a; } }; }
    { const f = _simMoveBuildHostile; _simMoveBuildHostile = function () { const a = now(); try { return f.apply(this, arguments); } finally { if (inMove) T.hostile += now() - a; } }; }
    { const f = _simMoveSepListed; _simMoveSepListed = function () { const a = now(); try { return f.apply(this, arguments); } finally { T.post += now() - a; } }; }
}
{
    const C = __scratch.smc = { calls: 0, f0: 0, f2: 0, retry: 0 };
    const f = _simMoveSepListed;
    _simMoveSepListed = function (chunks, per) {
        const S = _sep, EX = S.ex, EXC = S.exc, fast = S.fast, c = _simUnitState.columns;
        C.calls++;
        for (let k = 0; k < chunks; k++) for (let j = k * per, e = j + EXC[k]; j < e; j++) { const i = EX[j]; if (fast[i] === 0) C.f0++; else { C.f2++; if (((gameTime + c.id[i]) | 0) % UNIT_SEPARATION_PATH_RETRY_TICKS === 0) C.retry++; } }
        return f.apply(this, arguments);
    };
}
