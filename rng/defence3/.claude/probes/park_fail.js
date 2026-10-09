// EVAL probe (host): after each Unit.update the kernels left, a unit not
// armed / parked again (mvOn 0): which of the park conditions failed, by
// kind. AFTER: JSON.stringify(__scratch.pf)
__scratch.pf = {};
{
    const f = Unit.prototype.update;
    Unit.prototype.update = function () {
        const c = this._us, s = this._si;
        if (!c || c.mvOut[s] || currentTick < 120 || this.dead) return f.call(this);
        const r = f.call(this);
        if (this.dead || c.mvOn[s] !== 0) return r;
        const why = [];
        if (this.holdPosition) why.push('hold');
        if (this.workerTransferCooldown > 0) why.push('cool');
        if (this._spatialEpoch !== spatialEpoch) why.push('epoch');
        if (c.sepKey[s] === SIM_SEP_ABSENT) why.push('absent');
        if (this.path && this.pathIndex < this.path.length) why.push('path');
        if (this._pendingPathTarget) why.push('pending' + (this.pathIsFallbackAstar ? 'FB' : ''));
        if (this.workerState && typeof _wsRegistered === 'function' && _wsRegistered(this)) why.push('ws');
        if (this.workerState && !Number.isFinite(this._workerNextIdleRetargetTick)) why.push('noNext');
        if (!(this._astarBudgetRetryTick > gameTime + 1)) why.push('noRetry');
        const k = (this.workerState ? 'w:' + this.workerState + ':' + this.workerType : 'c' + this.commandState) + ' ' + why.join(',');
        __scratch.pf[k] = (__scratch.pf[k] || 0) + 1;
        return r;
    };
}
