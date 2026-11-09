'use strict';
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const world = new H.World({ controls: H.SMALL_MATCH_CONTROLS });
const inst = world.spawn('load-preparation', { simWorker: false });
inst.eval('startSoloGame();');
const result = inst.eval(`(() => {
    // A completed import replaces the list and invalidates derived caches.
    unitsReplaced([...units]);simMoveWallsDirty();_upkB=null;spatialIndexInvalidate();
    const time=gameTime,tick=currentTick,phase=_simUnitState.collectPhase;
    _actionBacklog.push([0,{action:'queueUnit',gx:0,gy:0,count:1}]);
    const queued=JSON.stringify(_actionBacklog);
    const state=__exactStateHash();
    simMatchPrepare();
    const caches=[_wsw,_simMoveStruct,_laserMap.hdr,..._navProfilesInUse().map(p=>_nav[p])];
    simMatchPrepare();
    const again=[_wsw,_simMoveStruct,_laserMap.hdr,..._navProfilesInUse().map(p=>_nav[p])];
    return {same:state===__exactStateHash(),time:time===gameTime&&tick===currentTick,
        queued:queued===JSON.stringify(_actionBacklog),phase:phase===_simUnitState.collectPhase,
        collected:_simUnitState.unitsRef===_simUnitsEpoch(),walls:!_simMoveWallDirty,bins:_upkB!==null,index:!_sxDirty,
        workerScratch:['sites','count','any'].every(k=>simHeapHas(_workerBrain.arrays[k])),
        cachesReady:caches.every(Boolean),reused:caches.every((c,i)=>c===again[i])};
})()`);
for (const [key, value] of Object.entries(result)) assert.equal(value, true, key);
assert.deepEqual(inst.errors.map(String), []);
console.log('PASS: loading prepares derived caches without ticks, queue consumption or gameplay-state changes');
