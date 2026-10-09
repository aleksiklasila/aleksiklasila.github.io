// EVAL: Unit.update calls the simulation thread made on ticks 160..210, by
// kind: worker state or command, the slot's mvOn before the movement kernel,
// what the unit holds (path / nav node, pending way, unit target, structure
// target, hold), and its mvOn after the update (re-armed or not). ms, calls.
{
    const now = __scratch.realNow;
    const W = __scratch.uw = { ticks: 0, k: {} };
    let pre = null, preTick = -1;
    const inRange = () => currentTick >= 160 && currentTick <= 210;
    { const f = simMoveRun; simMoveRun = function () { if (inRange()) { const S = _simUnitState; pre = S.columns.mvOn.slice(0, S.owners.length); preTick = currentTick; W.ticks++; } return f.apply(this, arguments); }; }
    const f = Unit.prototype.update;
    Unit.prototype.update = function () {
        const c = this._us;
        if (!inRange() || !c || c.mvOut[this._si]) return f.call(this);
        const s = this._si, on0 = preTick === currentTick && pre ? pre[s] : -1;
        const p = this.path, nd = p && this.pathIndex < p.length ? p[this.pathIndex] : null;
        const what = (nd ? (nd.nav ? 'nav' : 'path') : 'nopath') + (this._pendingPathTarget ? '+pend' : '') + (this.targetUnit ? '+tU' : '') + (this.targetBuilding ? '+tB' : '') + (this.holdPosition ? '+hold' : '') + (c.cmMode[s] ? '+cm' + c.cmMode[s] : '');
        const kind = this.workerState ? 'w:' + this.workerState : 'c' + this.commandState;
        const a = now();
        try { return f.call(this); } finally {
            const k = kind + ' on' + on0 + ' ' + what + ' ->on' + c.mvOn[s];
            const e = (W.k[k] ||= [0, 0]); e[0] += now() - a; e[1]++;
        }
    };
}
