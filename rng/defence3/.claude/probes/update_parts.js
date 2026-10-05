// For Unit.update calls of units in one worker state (default MOVING_TO),
// the time in its parts: updateWorkerAI, the state machine's do* methods,
// the end (push out, index, arming), and the rest (the preamble).
// Use: EVAL="$(cat .claude/probes/update_parts.js)" AFTER='JSON.stringify(__scratch.partsTop())'
// (Function names are looked up in the game's scope: the probe runs there.)
__scratch.partsState = 'MOVING_TO'; __scratch.partsOn = false; __scratch.parts = {}; __scratch.partsCalls = 0;
{
    const __pRec = (name, ms) => { if (__scratch.partsOn && gameTime >= 48) __scratch.parts[name] = (__scratch.parts[name] || 0) + ms; };
    const __pWrapG = (name) => { const f = eval(name); const w = function () { const a = __scratch.realNow(); try { return f.apply(this, arguments); } finally { __pRec(name, __scratch.realNow() - a); } }; eval(name + ' = w'); };
    for (const n of ['getCloudTowerAt', '_getCloudTowerFast', '_rebuildCloudTileCache', 'hasActiveResourceMineAt', 'getTileEntityRef', 'isResourceCollectorWorkerType', '_canBuilderPassTile', 'findNearestWalkable', 'canUnitOccupyTile', 'canUnitOccupyTileCached', 'updateWorkerAI', 'pushUnitOutOfBlockedTile', 'updateUnitSpatial', 'simMoveTryArm', 'simMoveTryPark', 'simMoveTryParkWork', 'simMoveTryHold', 'simMoveTryChase']) __pWrapG(n);
    for (const m of ['tryDriveByAttack', 'doMoving', 'doIdle', 'doAttackMoving', 'doAttacking', 'followPath', '_followNavNode']) {
        const f = Unit.prototype[m]; if (!f) continue;
        Unit.prototype[m] = function () { const a = __scratch.realNow(); try { return f.apply(this, arguments); } finally { __pRec('u.' + m, __scratch.realNow() - a); } };
    }
    const __pUpd = Unit.prototype.update;
    Unit.prototype.update = function () {
        const c = this._us;
        if (!c || c.mvOut[this._si] || this.workerState !== __scratch.partsState) return __pUpd.call(this);
        __scratch.partsOn = true; if (gameTime >= 48) __scratch.partsCalls++;
        const a = __scratch.realNow();
        try { return __pUpd.call(this); } finally { __pRec('update(total)', __scratch.realNow() - a); __scratch.partsOn = false; }
    };
    __scratch.partsTop = () => { const n = Math.max(1, __scratch.tickMs.length - 48); return { callsPerTick: Math.round(__scratch.partsCalls / n), msPerTick: Object.fromEntries(Object.entries(__scratch.parts).sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, Math.round(v / n * 100) / 100])) }; };
}
