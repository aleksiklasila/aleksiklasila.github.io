'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const world=new H.World({controls:H.SMALL_MATCH_CONTROLS}),inst=world.spawn('area-search',{simWorker:false});
const result=inst.eval(`(()=>{
    SIM_ACQ_AREA_TARGETS=true;startSoloGame();
    const cells=gridCellsByArea.find(c=>c&&c.length>=2),a=cells[0],b=cells[cells.length-1];
    const source=new Unit('norm',0,(a.x+.5)*TILE,(a.y+.5)*TILE);
    const target=new Unit('norm',0,(b.x+.5)*TILE,(b.y+.5)*TILE);
    units.push(source,target);target.energy=target.maxEnergy*.5;
    let found=false;
    forEachUnitInAreaRange(source.x,source.y,0,u=>{if(u===target)found=true;});
    if(!found)throw Error('same-area unit rejected by pixel distance');
    // Isolate the fallback lookup from its cache cadence/reservations; the
    // real area predicate and scoring still run.
    _healerDamagedCandidatesByOwner=[[{u:target}]];
    _ensureHealerDamagedCandidatesCacheCurrent=()=>{};
    _getWorkerAutoSearchDistancePx=()=>1;_getWorkerAutoSearchDistanceArea=()=>0;
    _canAssignWorkerTargetExclusive=()=>true;
    if(_findNearestDamagedFriendlyUnit(source)!==target)throw Error('healer fallback kept pixel cutoff');
    const tower={x:source.x,y:source.y,currentStats:{attackRangeArea:0}};
    if(!isWorldTargetWithinAreaRange(tower.x,tower.y,target.x,target.y,Math.floor(tower.currentStats.attackRangeArea)))throw Error('tower range differs from areas');
    SIM_ACQ_AREA_TARGETS=false;found=false;
    forEachUnitInAreaRange(source.x,source.y,0,u=>{if(u===target)found=true;});
    if(found)throw Error('legacy pixel-limited mode was lost');
    return {distance:detHypot(source.x-target.x,source.y-target.y)};
})()`);
assert.ok(result.distance>1);assert.deepEqual(inst.errors.map(String),[]);
console.log('PASS: JS area iteration, healer fallback and tower range admit distant same-area targets; legacy mode retained');
