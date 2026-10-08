// The update pass's candidates per tick (SIM_KERNEL_UPD_CAND's lists) by the
// kernel output of their slot at the pass's start (o0..o15, fire: mvFire,
// noslot), averaged over the ticks from 48 on.
// Use: EVAL="$(cat .claude/probes/cand_stats.js)" AFTER='JSON.stringify(__scratch.candTop())'
__scratch.cand = {}; __scratch.candTicks = 0;
{
    const __cf = _forEachUnitInTickOrder;
    _forEachUnitInTickOrder = function (fn) {
        const S = _simUnitState;
        if (!S || gameTime < 48) return __cf.apply(this, arguments);
        const OUT0 = S.columns.mvOut.slice(0, S.owners.length), FIRE0 = S.columns.mvFire ? S.columns.mvFire.slice(0, S.owners.length) : null;
        const r = __cf.apply(this, arguments);
        const n = units.length, B = UNIT_UPDATE_ORDER_BLOCK, nb = Math.ceil(n / B), slots = _unitSlotMapEnsure();
        const H = __scratch.cand;
        for (let b = 0; b < nb; b++) for (let k = b * B, e = k + _updateOrderRun[b]; k < e; k++) {
            const idx = _updateOrderCand[k], s = idx < slots.length ? slots[idx] : -1;
            const key = s < 0 ? 'noslot' : (FIRE0 && FIRE0[s] ? 'fire' : 'o' + OUT0[s]);
            H[key] = (H[key] || 0) + 1;
        }
        __scratch.candTicks++;
        return r;
    };
}
__scratch.candTop = () => { const o = {}, t = Math.max(1, __scratch.candTicks); for (const [k, v] of Object.entries(__scratch.cand).sort((a, b) => b[1] - a[1])) o[k] = Math.round(v / t); return o; };
