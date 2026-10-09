// EVAL probe (host): attack-movers (commandState 2) that run Unit.update with
// mvOn 0 before the movement kernel: their mvOn / mvFlags right after the
// update, and at the next tick's kernel start (what disarmed them).
// AFTER: JSON.stringify(__scratch.c2)
__scratch.c2 = { after: {}, next: {} };
{
    let pre = null, watch = new Map();
    const fr = simMoveRun;
    simMoveRun = function () {
        const S = _simUnitState, c = S.columns, n = S.owners.length;
        if (currentTick >= 120) {
            for (const [s, v] of watch) { const k = v + '->' + c.mvOn[s] + ':f' + c.mvFlags[s]; __scratch.c2.next[k] = (__scratch.c2.next[k] || 0) + 1; }
        }
        watch = new Map();
        pre = c.mvOn.slice(0, n);
        return fr.apply(this, arguments);
    };
    const f = Unit.prototype.update;
    Unit.prototype.update = function () {
        const c = this._us, s = this._si;
        if (!c || c.mvOut[s] || currentTick < 120 || this.commandState !== CMD_ATTACK_MOVING || !pre || pre[s] !== 0) return f.call(this);
        const r = f.call(this);
        const k = 'on' + c.mvOn[s] + ':f' + c.mvFlags[s] + (this._pendingPathTarget ? ':pend' : '') + (this.pathIsFallbackAstar ? ':fb' : '') + (this.path && this.pathIndex < this.path.length ? ':path' : '') + ':cmd' + this.commandState;
        __scratch.c2.after[k] = (__scratch.c2.after[k] || 0) + 1;
        if (c.mvOn[s] !== 0) watch.set(s, 'on' + c.mvOn[s]);
        return r;
    };
}
