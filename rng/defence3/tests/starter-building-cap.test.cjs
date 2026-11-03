'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const inst=new H.World({controls:{'cfg-mapsize':'32','cfg-max-pop':'1048576','cfg-map-type':'arena'}}).spawn('starter-limits',{simWorker:false});
const result=inst.eval(`(()=>{
    applyMainMenuControlsToRuntimeState();
    startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{'building:house':{1:1000},'unit:king':{1:1}},researchLevels:{}});
    startSoloGame();
    return {limit:getPlayerStructureLimit(),counts:activeTeamIds.map(playerStructureCount),pop:getConfiguredMaxPop(),grown:structRowStats.grown};
})()`);
assert.ok(result.counts[0]>100,'the requested building population was exercised');
assert.ok(result.counts.every(n=>n<=result.limit),'starting resources respect the derived building capacity');
assert.ok(result.pop<1048576,'population is adjusted to the map');
assert.equal(result.grown,0,'starting buildings stay within the fixed class reservation');
assert.deepEqual(inst.errors.map(String),[]);
console.log('PASS starting building capacity',JSON.stringify(result));
