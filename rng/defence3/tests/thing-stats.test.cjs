'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const world=new H.World({controls:H.SMALL_MATCH_CONTROLS}),i=world.spawn('thing-stats',{simWorker:false});
const result=i.eval(`(()=>{
 startSoloGame();validateThingStats(THING_STATS);
 if(Object.getOwnPropertyDescriptor(BASE_UNIT_STATS.norm,'atk').get)throw Error('Runtime stat views must be plain data');
 let buildings=false;
 for(const [key,t]of Object.entries(THING_STATS)){
  if(t.kind==='building')buildings=true;
  else if(buildings)throw Error('Unit after buildings: '+key);
  if(!t.strength||!t.weakness)throw Error('Missing role: '+key);
 }
 const boss=PRECOMPUTED_STATS_MAP.unit.boss[20],norm=PRECOMPUTED_STATS_MAP.unit.norm[20];
 if(boss.energy[10]/norm.energy[10]>40||boss.atkCd[10]<norm.atkCd[10]*1.9)throw Error('Boss loses high-level tradeoffs');
 const config=serializeEditableRuntimeConfigForTransport();
 for(const key of ['BASE_UNIT_STATS','BASE_CARD_TYPES','UNIT_LEVEL_SCALING','PRECOMPUTED_SOFT_CAP_MAP','RESEARCHABLE_UNIT_STATS'])if(key in config.tables)throw Error('Duplicate balance table: '+key);
 const before=computeBaseUnitStatsAtLevel('tank',4).atk;
 const rule=config.tables.THING_STATS.norm.stats.atk;
 rule.base=7;rule.level={factor:2};rule.research={factor:3,direction:'increase'};rule.softCap=null;rule.min=0;rule.max=1000;
 applyEditableRuntimeConfigObject(JSON.parse(JSON.stringify(config)),{fromTransport:true});
 if(BASE_UNIT_STATS.norm.atk!==7||computeBaseUnitStatsAtLevel('norm',3).atk!==28||PRECOMPUTED_STATS_MAP.unit.norm[3].atk[2]!==252)throw Error('Descriptor edits did not propagate');
 if(computeBaseUnitStatsAtLevel('tank',4).atk!==before)throw Error('Neighbor changed');
 if(PRECOMPUTED_STATS_MAP.unit.norm[20].atk[10]!==1000)throw Error('Hard cap ignored');
 config.tables.THING_STATS.norm.stats.atk.researchable=false;
 applyEditableRuntimeConfigObject(config,{fromTransport:true});
 if(getResearchStatEntry('unit','norm','atk')||PRECOMPUTED_STATS_MAP.unit.norm[3].atk[10]!==28)throw Error('Researchable false ignored');
 const linked=config.tables.THING_STATS.norm.stats.trainingTime;linked.base=80;linked.level.factor=.8;
 config.tables.THING_STATS.norm.stats.price.base=600;
 applyEditableRuntimeConfigObject(config,{fromTransport:true});
 if(Math.abs(computeBaseBuildingStatsAtLevel('barrack_norm',3).spawnCd-51.2)>1e-6||computeBaseBuildingStatsAtLevel('barrack_norm',3).unitPrice!==2400)throw Error('Linked training stats diverged');
 if(Math.abs(getBarrackSpawnCooldown('norm',3)-51.2)>1e-6)throw Error('Training bypassed the precomputed rule');
 config.tables.THING_STATS.norm.stats.atk.from='norm.atk';
 let rejected=false;try{applyEditableRuntimeConfigObject(config,{fromTransport:true});}catch(e){rejected=/Cyclic/.test(e.message);}
 if(!rejected||THING_STATS.norm.stats.atk.from)throw Error('Invalid reference mutated live table');
 applyEditableRuntimeConfigObject({tables:{BASE_UNIT_STATS:{norm:{atk:9,maxAttackRange:2}},BARRACK_SPAWN_CONFIG:{norm:{baseTime:90,reduction:.2}}}});
 if(BASE_UNIT_STATS.norm.atk!==9||THING_STATS.norm.stats.attackRange.softCap!==2||BARRACK_SPAWN_CONFIG.norm.baseTime!==90)throw Error('Legacy import lost base values');
 return {things:Object.keys(THING_STATS).length,fastDamage:THING_STATS.fast.stats.atk.base,smgDamage:THING_STATS.smg.stats.damage.base,poisonDps:THING_STATS.poison.stats.poisonDps.base};
})()`);
assert.equal(result.fastDamage,4);assert.equal(result.smgDamage,6);assert.equal(result.poisonDps,12);assert.deepEqual(i.errors,[]);
console.log('PASS: one editable table, per-stat scaling/research/limits, role definitions, linked producer costs, config transport and legacy import',result);
