'use strict';
// Shared structure stats update immediately, without research/refresh sweeps.
const assert=require('node:assert/strict'),fs=require('node:fs');
const H=require('./net-harness.cjs');
function run(layout){
 const world=new H.World({seed:11});const i=world.spawn('stats-'+layout,{simWorker:false});
 const result=i.eval(`(()=>{
  SIM_THING_STATS_LAYOUT=${JSON.stringify(layout)};startSoloGame();
  const objects=[];
  const tower=new Tower(8,8,'pistol',0);tower.underConstruction=false;tower.level=tower.effectiveLevel=3;objects.push(tower);
  const producer=new Barrack(9,8,0,'norm');producer.underConstruction=false;producer.level=producer.effectiveLevel=3;objects.push(producer);
  const floor=Object.assign(new FloorItem(),{gx:10,gy:8,type:'lava',owner:0,level:3,effectiveLevel:3,underConstruction:false});objects.push(floor);
  const read=()=>objects.map(e=>{const st=e.preComputedBase;return [e.maxEnergy,st.damage,st.visionRange,e.spawnCooldown,e.damage,st.burnDps];});
  const before=read(), levels=ensurePlayerResearchLevels(0);
  const saved=[getCellItemsRowMajor,recalculateAdjacency];
  const unavailable=new Proxy([],{get(){throw Error('instance scan while publishing shared building stats');}});
  // (The lists are views: a list of the stand-in for each, through their view hooks.)
  structListsSetView([unavailable,unavailable,unavailable]);unitsSetView(unavailable);getCellItemsRowMajor=()=>{throw Error('floor scan');};recalculateAdjacency=()=>{throw Error('numeric research triggered adjacency refresh');};
  try{
   for(const [key,stat] of [['pistol','damage'],['pistol','visionRange'],['pistol','attackRange'],['pistol','cd'],['barrack_norm','spawnCd'],['lava','burnDps']]){
    applyResearchCompletion(0,{kind:'building',key,statKey:stat});
   }
  }finally{structListsSetView(null);unitsSetView(null);[getCellItemsRowMajor,recalculateAdjacency]=saved;}
  const after=read(), absent=[];
  for(const e of objects){const T=_sTables.get(e.constructor);for(const k of ['maxEnergy','preComputedBase','preComputedEffective','preComputed','preComputedPotential','currentStats','baseStats','damage','spawnCooldown','x','y'])if(T.fields.some(f=>f.name===k))absent.push(e.constructor.name+'.'+k);}
  floor.effectiveLevel=5;const floorEffective=floor.damage===calculateItemStats('lava',5,0).damage;floor.effectiveLevel=3;
  const expected=tower.maxEnergy;tower.maxEnergy=123.5;const override=tower.maxEnergy;tower.maxEnergy=expected;
  const restored=tower.maxEnergy;
  const canonical=objects.every(e=>e.preComputedBase===calculateItemStats(e.type==='barrack'?'barrack_'+e.unitType:e.type,3,0));
  const inPlace=JSON.stringify(PRECOMPUTED_STATS_MAP_PLAYER[0]);rebuildPrecomputedStatsMapPlayer(0);const rebuildMatches=inPlace===JSON.stringify(PRECOMPUTED_STATS_MAP_PLAYER[0]);
  return {rebuildMatches,floorEffective,before,after,absent,override,restored,expected,canonical,sweep:typeof buildingResearchSweep,layout:[..._thingStatTables.values()][0].layout};
 })()`);
 assert.deepEqual(i.errors.map(String),[]);assert.deepEqual(result.absent,[]);assert.equal(result.rebuildMatches,true);assert.equal(result.canonical,true);assert.equal(result.floorEffective,true);assert.equal(result.override,123.5);assert.equal(result.restored,result.expected);assert.equal(result.sweep,'undefined');
 for(let j=0;j<3;j++)assert.notDeepEqual(result.after[j],result.before[j]);
 return result;
}
const aos=run('aos'),soa=run('soa');assert.deepEqual(aos.after,soa.after);
assert.ok(!fs.readFileSync(require('node:path').join(__dirname,'../src/main.js'),'utf8').includes('buildingResearchSweep()'));
console.log('PASS: building/floor research updates shared AoS/SoA tables without touching instances; cached columns and sweep are removed; unique overrides survive');
