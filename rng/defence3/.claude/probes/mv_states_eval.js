// EVAL: at tick 190 (steady, before the mass order) and 214 (after it),
// after the tick: slots by mvOn value, by mvFlags flow bit, live/dead, and
// units by command / worker state.
{
    __scratch.mvs = {};
    const f = runOneTick;
    runOneTick = function () {
        const r = f.apply(this, arguments);
        if (currentTick === 190 || currentTick === 214) {
            const S = _simUnitState, C = S.columns, n = S.owners.length, on = {}, out = {}, cmd = {};
            let live = 0, dead = 0, flow = 0, path = 0;
            for (let s = 0; s < n; s++) {
                if (!C.live[s]) continue;
                if (C.dead[s]) { dead++; continue; }
                live++;
                on[C.mvOn[s]] = (on[C.mvOn[s]] || 0) + 1;
                out[C.mvOut[s]] = (out[C.mvOut[s]] || 0) + 1;
                if (C.mvFlags[s] & 64) flow++;
                const u = S.owners[s];
                const k = u.workerState ? 'w:' + u.workerState : 'c' + C.commandState[s];
                cmd[k] = (cmd[k] || 0) + 1;
                if (u.path && u.pathIndex < u.path.length) path++;
            }
            __scratch.mvs[currentTick] = { n, live, dead, flow, path, on, out, cmd };
        }
        return r;
    };
}
