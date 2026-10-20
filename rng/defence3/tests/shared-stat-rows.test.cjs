'use strict';
const assert=require('node:assert/strict');
const H=require('./net-harness.cjs');
const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'64'}});
const inst=world.spawn('shared-stat-rows',{simWorker:false});
const result=inst.eval(`(()=>{
 startSoloGame();
 const group=[];
 for(let i=0;i<128;i++) { const u=new Unit('norm',0,(20+i%8)*TILE,(20+(i>>3))*TILE);units.push(u);updateUnitSpatial(u);group.push(u); }
 gameTick();gameTick();
 const u=group[0],c=u._us,s=u._si,r=c.statRow[s];
 if(r<0)throw Error('missing shared row');
 const before=_effHot[r*EFF_HOT_WIDTH], rows=_effRowN;
 const levels=ensurePlayerResearchLevels(0),id=makeResearchLevelId('unit','norm','speed');
 levels[id]=(levels[id]||0)+1;
 const saved=units,owners=_simUnitState.owners;
 // The stat publication must not enumerate or inspect instances.
 const unavailable=new Proxy([],{get(){throw Error('instance scan during table publication');}});
 units=unavailable;_simUnitState.owners=unavailable;
 try {applyUnitResearchUpgradeToExistingUnits(0,'norm','speed');}
 finally {units=saved;_simUnitState.owners=owners;}
 const after=_effHot[r*EFF_HOT_WIDTH],pc=u.preComputed.speed;
 const sameHandle=c.statRow[s]===r,cacheRemoved=!Object.hasOwn(c,'mvSpd');
 for(const v of group)_effStatsFullUnit(v,true,CHUNK_SIZE*TILE);
 c.mvOn[s]=1;c.mvFlags[s]=0;
 applyUnitEffectiveScaling(u,u.effectiveLevel);
 const unchangedMovePreserved=c.mvOn[s]===1;
 return {before,after,pc,sameHandle,cacheRemoved,unchangedMovePreserved,stableAfterRefresh:c.statRow[s]===r,rowsBefore:rows,rowsAfter:_effRowN};
})()`);
assert.equal(result.sameHandle,true);assert.equal(result.cacheRemoved,true);
assert.notEqual(result.after,result.before);assert.equal(result.pc,result.after);
assert.equal(result.stableAfterRefresh,true);assert.equal(result.unchangedMovePreserved,true);
assert.deepEqual(inst.errors.map(String),[]);
console.log('PASS: shared stat publication updates existing handles without accessing units or owners',result);
