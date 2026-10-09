// EVAL probe (host): flow units the movement kernel handed back at ticks
// 211..216 (mvOn 1 + mvFlags 64 before, mvOut 0 after): after their
// Unit.update, are they armed again, toward the same destination, with a
// pending target, a substitute? AFTER: JSON.stringify(__scratch.ra)
__scratch.ra = {};
{
    let back = null;
    const fr = simMoveRun;
    simMoveRun = function () {
        back = null;
        if (currentTick < 211 || currentTick > 216) return fr.apply(this, arguments);
        const S = _simUnitState, c = S.columns, n = S.owners.length;
        const on = c.mvOn.slice(0, n), fl = c.mvFlags.slice(0, n), dest = c.mvDest.slice(0, n), flow = c.mvFlow.slice(0, n);
        const r = fr.apply(this, arguments);
        back = new Map();
        for (let s = 0; s < n; s++) if (on[s] === 1 && (fl[s] & 64) && c.mvOut[s] === 0) back.set(s, [dest[s], flow[s]]);
        return r;
    };
    const f = Unit.prototype.update;
    Unit.prototype.update = function () {
        const s = this._si, b = back && back.get(s);
        const r = f.call(this);
        if (b) {
            const c = this._us;
            const k = 'on' + c.mvOn[s] + (c.mvDest[s] === b[0] ? ':samedest' : ':otherdest') + (c.mvFlow[s] === b[1] ? ':sameflow' : '') + (this._pendingPathTarget ? ':pending' : '') + (this.path ? ':path' + this.path.length : ':nopath') + ':cmd' + this.commandState;
            __scratch.ra[k] = (__scratch.ra[k] || 0) + 1;
        }
        return r;
    };
}
