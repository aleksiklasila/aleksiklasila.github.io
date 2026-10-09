// EVAL probe (host): every Unit.update the kernels left (mvOut 0), by kind
// (worker state:type or command), armed before the kernel (mvOn), and
// whether the call changed anything a unit's fields show (state, command,
// path, position, target, cargo, cooldown, timers): "noop" calls are ticks
// the kernel could have handled itself. AFTER: JSON.stringify(__scratch.un)
__scratch.un = {}; __scratch.unT = new Set();
{
    let pre = null;
    const fr = simMoveRun;
    simMoveRun = function () { const S = _simUnitState; pre = S.columns.mvOn.slice(0, S.owners.length); return fr.apply(this, arguments); };
    const keys = ['workerState', 'commandState', 'path', 'pathIndex', 'x', 'y', 'workerTarget', 'targetUnit', 'targetBuilding', 'carryingValue', 'workerTransferCooldown',
        'builderHasMaterial', 'healerHasMaterial', 'researcherHasMaterial', '_pendingPathTarget', 'targetPos', 'holdPosition', 'attackTimer', '_builderNextRecheckTick', '_workerNextIdleRetargetTick'];
    const f = Unit.prototype.update;
    Unit.prototype.update = function () {
        const c = this._us, s = this._si;
        if (!c || c.mvOut[s] || currentTick < 120 || this.dead) return f.call(this);
        __scratch.unT.add(currentTick);
        const before = keys.map(k => this[k]);
        const r = f.call(this);
        let ch = '';
        for (let i = 0; i < keys.length; i++) if (this[keys[i]] !== before[i] && !(keys[i] === 'x' || keys[i] === 'y' ? false : false)) { ch = keys[i]; break; }
        const kind = (this.workerState ? 'w:' + this.workerState + ':' + this.workerType : 'c' + before[1]) + ':on' + (pre ? pre[s] : '-')
            + (this.workerState && typeof _wsRegistered === 'function' && _wsRegistered(this) ? ':ws' : '');
        const e = __scratch.un[kind] || (__scratch.un[kind] = { n: 0, noop: 0, ch: {} });
        e.n++;
        if (!ch) e.noop++; else e.ch[ch] = (e.ch[ch] || 0) + 1;
        return r;
    };
}
