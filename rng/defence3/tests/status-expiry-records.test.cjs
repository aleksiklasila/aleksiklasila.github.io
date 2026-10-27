'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
for(const effect of ['fire','poison','ice']){
 const world=new H.World(),i=world.spawn('status-expiry',{simWorker:false});
 const r=i.eval(`(()=>{
  startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();simDk=20;
  const effect=${JSON.stringify(effect)},timer={fire:'burning',poison:'poisoned',ice:'frozen'}[effect],damage={fire:'burnTickDamage',poison:'poisonTickDamage',ice:'iceTickDamage'}[effect];
  const group=[];
  // One chunk, more reports than its presentation budget. Some expired
  // records stay allocated for the report; the others return to the pool.
  for(let j=0;j<STATUS_LOOKS_PER_JOB+2;j++){
   const u=new Unit('norm',0,(10+j)*TILE+16,12*TILE+16);units.push(u);group.push(u);u.energy=10000;
   applyStatusEffect(u,effect,1,10);u[timer]=1;if(effect==='ice')u.wet=1;
  }
  statusPrepassRun();
  const retained=group.filter(u=>u._us.stIx[u._si]!==0).length;
  const expired=group.map(u=>u[damage]);
  for(const u of group){applyStatusEffect(u,effect,1,1);u[timer]=20;if(effect==='ice')u.wet=20;}
  statusPrepassRun();
  const energy=group.map(u=>u.energy);
  const plain={owner:0,energy:10000};applyStatusEffect(plain,effect,1,10);plain[timer]=1;if(effect==='ice')plain.wet=1;
  tickStatusEffects(plain);const plainExpired=plain[damage];
  return {retained,total:group.length,expired,energy,plainExpired};
 })()`);
 assert.ok(r.retained>0&&r.retained<r.total,'exercise both retained and released records');
 assert.ok(r.expired.every(x=>x===0),effect+': expired damage must clear even in retained records');
 assert.ok(r.energy.every(x=>x===r.energy[0]),effect+': weaker reapplication must not depend on visual-report retention');
 assert.equal(r.energy[0],effect==='ice'?9955:9970,effect+': only the new, weaker damage applies');
 assert.equal(r.plainExpired,0,effect+': building/fallback status path clears expired damage too');
 assert.deepEqual(i.errors.map(String),[]);
 console.log('PASS:',effect,'expiry and weaker reapplication across status-record retention');
}
