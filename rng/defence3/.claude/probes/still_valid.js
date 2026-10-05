// Why kernel-moved chasers and held units fail their turn check
// (simChaseStillValid / simHoldStillValid): the first failing condition.
// Use: EVAL="$(cat .claude/probes/still_valid.js)" AFTER='JSON.stringify(__scratch.svTop())'
(() => {
    const T = __scratch.sv = {};
    const rec = k => { if (currentTick >= 48) T[k] = (T[k] || 0) + 1; };
    const walls = () => _simMoveWallDirty ? 'wallDirty' : _simMoveWallVer !== _simMoveRunWallVer ? 'wallVer' : _simMoveWallQ.length ? 'wallQ' : '';
    const fc = simChaseStillValid;
    simChaseStillValid = function (c, s, on = 4) {
        const r = fc.apply(this, arguments);
        if (r) { rec('chase' + on + ':ok'); return r; }
        let why = c.mvOn[s] !== on ? 'mvOn' + c.mvOn[s] : c.dead[s] ? 'dead' : !(c.energy[s] > 0) ? 'energy' : walls();
        if (!why) {
            const q = c.mvHT[s];
            why = !(q >= 0) ? 'noT' : c.dead0[q] ? 'tdead0' : (c.id[q] | 0) !== c.mvHTId[s] ? 'tid' : 'orders';
        }
        rec('chase' + on + ':' + why);
        return r;
    };
    const fh = simHoldStillValid;
    simHoldStillValid = function (c, s) {
        const r = fh.apply(this, arguments);
        const on = c.mvOn[s];
        if (r) { rec('hold' + on + ':ok'); return r; }
        let why = (on !== 3 && on !== 5) ? 'mvOn' + on : c.dead[s] ? 'dead' : !(c.energy[s] > 0) ? 'energy' : walls();
        if (!why) why = on === 5 ? 'bld' : 'target';
        rec('hold' + on + ':' + why);
        return r;
    };
    __scratch.svTop = () => { const n = Math.max(1, __scratch.tickMs.length - 48); return Object.fromEntries(Object.entries(T).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v / n)])); };
})();
