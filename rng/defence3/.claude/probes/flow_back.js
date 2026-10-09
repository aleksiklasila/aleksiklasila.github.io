// EVAL probe (host): flow units (mvOn 1, mvFlags 64 before the movement
// kernel) the kernel handed back (mvOut 0), at the ticks listed in
// __FB_TICKS (default 210..216): by why, from the columns before the kernel:
// the field slot's destination / generation / made flag against the unit's,
// its tile at the destination, a worker's check tick. AFTER: JSON.stringify(__scratch.fb)
__scratch.fb = {};
{
    const want = new Set(typeof __FB_TICKS !== 'undefined' ? __FB_TICKS : [210, 211, 212, 213, 214, 215, 216]);
    const fr = simMoveRun;
    simMoveRun = function () {
        if (!want.has(currentTick)) return fr.apply(this, arguments);
        const S = _simUnitState, c = S.columns, n = S.owners.length;
        const on = c.mvOn.slice(0, n), fl = c.mvFlags.slice(0, n), flow = c.mvFlow.slice(0, n), gen = c.mvFGen.slice(0, n), dest = c.mvDest.slice(0, n);
        const r = fr.apply(this, arguments);
        const M = __scratch.fb[currentTick] || (__scratch.fb[currentTick] = {});
        for (let s = 0; s < n; s++) {
            if (on[s] !== 1 || !(fl[s] & 64) || c.mvOut[s] !== 0) continue;
            const fid = flow[s], wide = fid >= NAV_WIDE_BASE, did = wide ? fid - NAV_WIDE_BASE : fid, F = _navFields.pools[wide ? 1 : 0], m = did * NAV_FIELD_META;
            const meta = F.meta;
            let why = !meta || did < 0 ? 'nometa' : meta[m + 1] !== dest[s] ? 'otherdest' : meta[m + 6] !== gen[s] ? (meta[m + 7] === 1 ? 'gen-made' : 'gen-notmade') : meta[m + 7] !== 1 ? 'notmade' : 'ok';
            const t = Math.floor(c.y[s] / TILE) * GRID_W + Math.floor(c.x[s] / TILE);
            if (t === dest[s]) why += ':atdest';
            why += ':on' + c.mvOn[s] + ':nl' + c.mvNavN1[s];
            M[why] = (M[why] || 0) + 1;
        }
        return r;
    };
}
