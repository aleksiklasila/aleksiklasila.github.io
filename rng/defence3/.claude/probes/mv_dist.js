// EVAL probe (host): per tick (from 130), slots by mvOn before the movement
// kernel and by mvOut after it. AFTER: JSON.stringify(__scratch.md)
__scratch.md = { T: 0, on: {}, out: {}, n: 0, cm: 0 };
{ const fr = simMoveRun; simMoveRun = function () {
    const S = _simUnitState, c = S.columns, n = S.owners.length, M = __scratch.md;
    const on = currentTick >= 130 ? c.mvOn.slice(0, n) : null;
    const r = fr.apply(this, arguments);
    if (on) { M.T++; M.n += n; for (let s = 0; s < n; s++) { const a = on[s], b = c.mvOut[s]; M.on[a] = (M.on[a] || 0) + 1; M.out[b] = (M.out[b] || 0) + 1; if (c.cmMode[s]) M.cm++; } }
    return r; }; }
