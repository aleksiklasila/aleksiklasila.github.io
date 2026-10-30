'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const world=new H.World(),i=world.spawn('builder-research',{simWorker:false});
const result=JSON.parse(i.eval(`JSON.stringify((()=>{
 startSoloGame();
 const t=new Tower(8,8,'pistol',0);t.underConstruction=false;t.stacks=1;t.manualStacks=5;t.level=t.effectiveLevel=t.potentialEffectiveLevel=1;t.autoUpgradeEnabled=false;t.autoStackEnabled=true;t.isUpgrading=t.isStacking=false;t.energy=t.maxEnergy;
 setTileEntity(8,8,'pistol',t);
 const capped={flags:workSiteFlagsOf(t),work:_isBuilderWorkTarget(t,0)};
 applyResearchCompletion(0,{kind:'building',key:'pistol',statKey:'maxLevel'});
 const resumed={flags:workSiteFlagsOf(t),work:_isBuilderWorkTarget(t,0),stacking:t.isStacking};
 t.autoStackEnabled=false;t.isStacking=false;
 const disabled={flags:workSiteFlagsOf(t),work:_isBuilderWorkTarget(t,0)};
 t.autoStackEnabled=true;t.manualStacks=t.stacks;
 const empty={flags:workSiteFlagsOf(t),work:_isBuilderWorkTarget(t,0)};
 t.manualStacks=5;
 return{capped,resumed,disabled,empty,wrongOwner:_isBuilderWorkTarget(t,1),buildFlag:WSW_BUILD};
})())`));
assert.equal(result.capped.flags&result.buildFlag,0);assert.equal(result.capped.work,false);
assert.ok(result.resumed.flags&result.buildFlag);assert.equal(result.resumed.work,true);assert.equal(result.resumed.stacking,true);
for(const key of ['disabled','empty']){assert.equal(result[key].flags&result.buildFlag,0,key);assert.equal(result[key].work,false,key);}
assert.equal(result.wrongOwner,false);assert.deepEqual(i.errors.map(String),[]);
console.log('PASS: research unlocks queued builder stacks; caps, auto-stack toggle, empty queue and ownership retained');
