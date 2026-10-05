// The slowest Unit.update calls of workers in a moving state (default
// MOVING_TO; SLOW_STATE=...), with what they were and became: type, state
// and command before and after, path length and index, target type, and
// whether their tile changed. Also time by (type, before -> after).
// Use: EVAL="$(cat .claude/probes/slow_updates.js)" AFTER='JSON.stringify(__scratch.slowTop())'
(() => {
    const want = (typeof process === 'undefined' ? null : null) || 'MOVING_TO';
    const top = [], agg = {};
    const f = Unit.prototype.update;
    Unit.prototype.update = function () {
        const c = this._us;
        if (!c || c.mvOut[this._si] || this.workerState !== want || gameTime < 48) return f.call(this);
        const b = { type: this.workerType, cmd: this.commandState, path: this.path ? this.path.length : -1, idx: this.pathIndex, tt: this.workerTargetType, tile: Math.floor(this.x / TILE) + ',' + Math.floor(this.y / TILE), nav: !!(this.path && this.path[this.pathIndex] && this.path[this.pathIndex].nav) };
        const a = __scratch.realNow();
        try { return f.call(this); } finally {
            const ms = __scratch.realNow() - a;
            const after = this.workerState + '/c' + this.commandState;
            const k = b.type + ':' + want + '/c' + b.cmd + (b.nav ? ':nav' : b.path >= 0 ? ':path' : ':nopath') + ' -> ' + after;
            const e = (agg[k] ||= [0, 0]); e[0] += ms; e[1]++;
            if (top.length < 25 || ms > top[top.length - 1].ms) {
                top.push({ ms: Math.round(ms * 1000) / 1000, t: gameTime, id: this.id, ...b, after, pathAfter: this.path ? this.path.length : -1 });
                top.sort((x, y) => y.ms - x.ms); if (top.length > 25) top.length = 25;
            }
        }
    };
    __scratch.slowTop = () => { const n = Math.max(1, __scratch.tickMs.length - 48); return { agg: Object.fromEntries(Object.entries(agg).sort((x, y) => y[1][0] - x[1][0]).map(([k, v]) => [k, [Math.round(v[0] / n * 100) / 100, Math.round(v[1] / n * 10) / 10]])), top: top.slice(0, 12) }; };
})();
