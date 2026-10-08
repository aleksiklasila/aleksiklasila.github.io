// Main-thread time blocked in background-lane waits, per lane and per top
// phase (ms a tick from tick 120 on). Use (host has helpers):
//   EVAL="$(cat .claude/probes/lane_waits.js)" AFTER='JSON.stringify(__scratch.lwTop())'
__scratch.lw = {}; __scratch.lwTicks = new Set();
{
    const wrap = (name) => {
        const f = globalThis[name] !== undefined ? globalThis[name] : eval(name);
        const g = function (lane) {
            const a = __scratch.realNow();
            try { return f.apply(this, arguments); } finally {
                if (gameTime >= 120) {
                    const ms = __scratch.realNow() - a, k = name.replace('simParallelBackground', '') + ':' + (lane === undefined ? 1 : lane) + ':' + (__scratch.lwPhase || '?');
                    __scratch.lw[k] = (__scratch.lw[k] || 0) + ms; __scratch.lwTicks.add(gameTime);
                }
            }
        };
        return g;
    };
    simParallelBackgroundWait = wrap('simParallelBackgroundWait');
    simParallelBackgroundWaitStage = wrap('simParallelBackgroundWaitStage');
    for (const ph of ['runUnitSeparationPass', 'resyncAfterTick', 'simMoveRun', 'spatialIndexRebuild', 'navTick', 'recalculateUnitEffectiveStats', 'statusPrepassRun', 'updateAllPlayerVisibility', '_forEachUnitInTickOrder', 'navFieldsFlush', 'runQueuedOrders', 'unitHitsResolve', 'ensureLaserConnections', 'gameStatsStep', 'healerCandidatesStep', 'syncVisibilityCoverage']) {
        let f; try { f = eval(ph); } catch { continue; }
        if (typeof f !== 'function') continue;
        const g = function () { const prev = __scratch.lwPhase; __scratch.lwPhase = ph; try { return f.apply(this, arguments); } finally { __scratch.lwPhase = prev; } };
        eval(ph + ' = g');
    }
}
__scratch.lwTop = () => { const n = Math.max(1, __scratch.lwTicks.size); return Object.fromEntries(Object.entries(__scratch.lw).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v / n * 100) / 100])); };
