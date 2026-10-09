// EVAL probe (host): one salvager in MOVING_TO that leaves Unit.update with
// no path (from tick 130), traced for 12 updates. AFTER: JSON.stringify(__scratch.st)
__scratch.st = []; __scratch.sid = -1;
{
    const f = Unit.prototype.update;
    const snap = (u, tag) => {
        const t = u.workerTarget, p = u.path;
        return [tag, currentTick, Math.round(u.x), Math.round(u.y), u.workerState, u.commandState, p ? (p.length + '@' + u.pathIndex + (p[u.pathIndex] ? ':' + (p[u.pathIndex].nav ? 'nav' : '') + p[u.pathIndex].x + ',' + p[u.pathIndex].y : '')) : 'null',
            t ? t.gx + ',' + t.gy + (t.markedForSalvage ? 'M' : '') : 'none', u.workerTransferCooldown, !!u._pendingPathTarget, t ? _isWorkerWithinTileInteractionRange(u, t, 1) : null,
            t ? navApproachTile(navProfileOf(u), t.gy * GRID_W + t.gx) : null, u._us.mvOn[u._si], u._us.mvOut[u._si]];
    };
    Unit.prototype.update = function () {
        const c = this._us, s = this._si;
        if (!c || c.mvOut[s] || this.dead) return f.call(this);
        const watch = this.id === __scratch.sid;
        if (watch && __scratch.st.length < 40) __scratch.st.push(snap(this, 'pre'));
        const r = f.call(this);
        if (watch && __scratch.st.length < 40) __scratch.st.push(snap(this, 'post'));
        if (__scratch.sid < 0 && currentTick >= 130 && this.workerType === 'salvager' && this.workerState === 'MOVING_TO' && !this.path) { __scratch.sid = this.id; __scratch.st.push(snap(this, 'first')); }
        return r;
    };
}
