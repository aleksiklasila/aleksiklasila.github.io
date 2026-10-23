'use strict';
const assert=require('node:assert/strict'),H=require('./net-harness.cjs');
const world=new H.World({controls:{...H.SMALL_MATCH_CONTROLS,'cfg-mapsize':'64'}});
const i=world.spawn('combat-reach',{simWorker:false});
const result=i.eval(`(()=>{
 startSoloGame();const rows=[];
 for(const [key,def]of Object.entries(THING_STATS)){
  const kind=def.kind,max=def.stats.attackRange?.softCap;
  if(!Number.isFinite(max)||!(def.stats.attackRange.base>0))continue;
  const source=PRECOMPUTED_STATS_MAP[kind][key],start=source[1].attackRange[0],end=source[20].attackRange[10];
  let previous=start;for(let level=1;level<=20;level++)for(let research=0;research<=10;research++){
   const value=source[level].attackRange[research];if(value<1-1e-6||value>max+1e-6)throw Error(key+' range '+value);
   if(research>0&&value<source[level].attackRange[research-1]-1e-6)throw Error('research decreased range');
   if(level>1&&value<source[level-1].attackRange[research]-1e-6)throw Error('level decreased range');
  }
  const id=makeResearchLevelId(kind,key,'attackRange');players[0].researchLevels[id]=10;players[0].researchMultipliers={};
  rebuildPrecomputedStatsMapPlayerThingStat(0,kind,key,'attackRange');
  const row=PRECOMPUTED_STATS_MAP_PLAYER[0][kind][key][20];
  if(row.visionRangeArea+1e-6<row.attackRangeArea)throw Error(key+' cannot see its range');
  if(kind==='unit'&&max>=3&&source[20].atkCd[10]<=PRECOMPUTED_STATS_MAP.unit.norm[20].atkCd[10])throw Error(key+' lost its fire-rate tradeoff');
  rows.push({kind,key,start,end,max});
 }
 for(const [key,s]of Object.entries(BASE_UNIT_STATS))if(s.isWorker&&PRECOMPUTED_STATS_MAP.unit[key][20].attackRange[10]!==0)throw Error('armed worker');
 return rows;
})()`);
// (Areas are whole: a fractional cap reached as its floor.)
for(const r of result)assert(Math.abs(r.end-Math.floor(r.max))<1e-5,JSON.stringify(r));
assert.deepEqual(i.errors,[]);console.log(JSON.stringify(result));console.log('PASS: bounded monotonic area reach, melee limits, range research publishes adequate sight, unarmed workers');
const edited=i.eval(`(()=>{
 const config=serializeEditableRuntimeConfigForTransport();
 config.tables.THING_STATS.water_resistant.stats.attackRange.softCap=7;
 config.tables.THING_STATS.water_resistant.stats.attackRange.base=0.5;
 config.tables.THING_STATS.water_resistant.stats.atkCd.softCap=0.12;
 config.tables.THING_STATS.pistol.stats.attackRange.softCap=6;
 config.tables.THING_STATS.pistol.stats.attackRange.base=0.75;
 config.tables.THING_STATS.pistol.stats.attackRange.level.linear=0.03;
 applyEditableRuntimeConfigObject(config,{fromTransport:true});
 return [PRECOMPUTED_STATS_MAP.unit.water_resistant[20].attackRange[10],PRECOMPUTED_STATS_MAP.unit.water_resistant[20].atkCd[10],PRECOMPUTED_STATS_MAP.building.pistol[20].attackRange[10],PRECOMPUTED_STATS_MAP.unit.water_resistant[1].attackRange[0],PRECOMPUTED_STATS_MAP.building.pistol[1].attackRange[0],computeBaseBuildingStatsAtLevel('pistol',20).attackRange];
})()`);
// (Published ranges are whole areas: the edited fractional bases floor to 0; the base row itself stays raw.)
for(const [k,value]of [7,.12,6,0,0,.75*(1+19*.03)].entries())assert(Math.abs(edited[k]-value)<1e-6);
console.log('PASS: editing only the existing static rows changes range and cooldown endpoints after config transport');
