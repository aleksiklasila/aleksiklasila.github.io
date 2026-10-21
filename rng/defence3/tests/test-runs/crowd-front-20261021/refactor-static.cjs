const fs=require('fs'),p='src/data/',old=JSON.parse(fs.readFileSync(__dirname+'/static-before.json'));
for(const f of ['data_static.js','data_dynamic.js'])fs.copyFileSync(p+f,__dirname+'/'+f+'.before-unified');
const things={};
for(const [key,row] of Object.entries(old.rows)){
 const unit=row.kind==='unit',def=(unit?old.units:old.buildings)[key],cfg=old.scaling[key]||old.scaling._default,one=row.base[1];
 const t=things[key]={kind:row.kind,...Object.fromEntries(Object.entries(def).filter(([s,v])=>typeof v!=='number')),name:unit?old.names[key]:def.name,description:old.descriptions[key],stats:{}};
 const add=(s,base,level={})=>t.stats[s]={base,level,researchable:row.research.includes(s),research:{factor:row.factors[s]||1,direction:old.decrease[s]?'decrease':'increase'},softCap:row.caps[s]??null};
 for(const s of (unit?old.unitKeys:old.buildingKeys)){
  if(one[s]===null&&!(unit&&s==='transferCooldown'))continue;
  let base=def[s]??one[s],l={};
  if(unit){
   if(s==='energy')l={factor:cfg.energyExp,round:'floor',min:1};
   if(s==='atk')l={factor:cfg.dmgExp,round:'round',min:base>0?1:0};
   if(s==='atkCd')l={factor:cfg.cdExp,min:cfg.minCd};
   if(s==='speed')l={factor:cfg.speedExp,max:cfg.speedCapAbs??base*cfg.speedCapMul};
   if(s==='visionRange')l={factor:cfg.visionExp,max:base+cfg.visionCapBonus};
   if(s==='attackRange')l={factor:cfg.rangeExp??cfg.visionExp,max:base+(cfg.rangeCapBonus??cfg.visionCapBonus)};
   if(s==='watchDuration'&&key==='scout')l={add:1};
   if(s==='gatherPerTrip'&&base>0)l={power:1,min:1};
   if(['builderDps','healerDps','researcherDps'].includes(s)&&base>0)l={factor:1.46,round:'round',min:1};
   if(s==='transferCooldown'&&base!==null)l={factor:.9,min:.01};
   if(s==='astarCost')l={factor:1.75,min:.01};
   if(s==='upKeep')l={factor:1.45,min:.01};
  }else{
   if(s==='maxEnergy'){base=def.energy;l={factor:2,round:'floor'};}
   if(s==='upKeep'){base=Math.max(.01,def.upKeep);l={factor:1.85,min:.01};}
   if(['damage','blastDamage'].includes(s)){
    if(Number.isFinite(def[s]))l={factor:1.4};else l={factor:1.6,...(key==='mine'?{round:'floor'}:{})};
   }
   if(s==='popCap'){base=1;l={model:'population',factor:1.6};}
   if(s==='multiplier'&&['farm','astar_farm'].includes(key)){base=def.multiplier;l={model:'farm',coefficient:1,power:3};}
   if(s==='efficiency')l={factor:1.05,max:3};
   if(s==='visionRange'&&def.target==='wall')l={linear:.2,...(def.maxVisionRange!==undefined?{max:def.maxVisionRange}:{})};
   if(s==='attackRange'&&def.maxAttackRange!==undefined)l={linear:def.rangeGrowthPerLevel};
   if(s==='cd'&&['pistol','smg','water'].includes(key))l={linear:-.1,min:.25};
   if(s==='cd'&&key==='sand_gun')l={factor:.9,offset:0};
   if(s.endsWith('Dps'))l={factor:['lava','poison_puddle','ice_patch'].includes(key)?1.6:1.4,min:s==='freezeDps'&&key==='ice_patch'?.2:.1};
   if(s.endsWith('Duration')){
    const n=key==='fire'?.5:key==='poison'?2.5:key==='ice'?.5:key==='elements'&&['burnDuration','poisonDuration','freezeDuration'].includes(s)?1:key==='water'&&s==='wetDuration'?1:key==='watch_tower'?1:0;
    if(n)l={add:n};
   }
  }
  add(s,base,l);
 }
 if(!unit&&key!=='shrine')add('maxLevel',1,{});
 for(const [s,value]of Object.entries(def))if(typeof value==='number'&&!['maxAttackRange','minAttackCooldown','maxVisionRange','rangeGrowthPerLevel','towerEnergy','energy'].includes(s)&&!t.stats[s])add(s,value,{});
 if(unit){const train=old.spawn[key];if(train)add('trainingTime',train.baseTime,{factor:1-train.reduction,min:.05});}
 else{
  const spawn=def.unitType||(key==='spawner'?'collector':key==='astar_spawner'?'astar_collector':({salvager:'salvager_unit',builder_spawner:'builder_unit',healer_spawner:'healer_unit',research:'researcher_unit'})[key]);
  if(spawn){t.spawns=spawn;t.stats.spawnCd={...t.stats.spawnCd,from:spawn+'.trainingTime',base:undefined,level:{}};t.stats.unitPrice={...t.stats.unitPrice,from:spawn+'.price',base:undefined,level:{factor:2,min:1}};}
 }
}
// Preserve explicit stat order: the old unit research UI has a different order from the matrix.
for(const [key,t]of Object.entries(things))t.researchOrder=old.rows[key].research;
let src=fs.readFileSync(p+'data_static.js','utf8');
const table=`// One authored definition per thing. Units first, then buildings.\n// Stat: base; level {factor^(level-1), linear, add, power, round, min/max};\n// researchable controls both the research menu and bonuses. research.factor is per research level.\n// softCap: null = unbounded; number = endpoint at maximum level/research (log interpolation);\n// {model:'populationLimit'} follows the map population setting. min/max are optional hard limits.\n// from references another thing's stat; its level rule is used unless an explicit rule replaces it.\nconst THING_STATS = {\n`+Object.entries(things).map(([key,t])=>{
 const {stats,researchOrder,...meta}=t;
 return `    ${key}: { ${Object.entries(meta).filter(([,v])=>v!==undefined).map(([k,v])=>k+': '+JSON.stringify(v)).join(', ')},\n        stats: {\n`+Object.entries(stats).map(([s,d])=>`            ${s}: ${JSON.stringify(s==='popCap'&&key==='house'?{...d,softCap:{model:'populationLimit'}}:d)},`).join('\n')+'\n        }\n    },';
}).join('\n')+'\n};\n\n';
// Resource routing metadata remains; per-thing numeric data moves into THING_STATS.
src=src.replace(/function buildResourceCollectorCardTypes\(\)[\s\S]*?const RESOURCE_FARM_KEYS/,table+'const RESOURCE_FARM_KEYS');
const start=src.indexOf('// ============================================================\r\n// CARD/BUILDING TYPES');
const end=src.indexOf('function _prettyKeyLabel');
src=src.slice(0,start)+`// Compatibility views are generated from THING_STATS; never edit them for balance.\nconst BASE_UNIT_STATS = {}, BASE_CARD_TYPES = {}, DESCRIPTIONS = {}, UNIT_DISPLAY_NAMES = {}, BARRACK_SPAWN_CONFIG = {};\nfunction rebuildThingDefinitionViews() {\n    for (const view of [BASE_UNIT_STATS, BASE_CARD_TYPES, DESCRIPTIONS, UNIT_DISPLAY_NAMES, BARRACK_SPAWN_CONFIG]) {\n        for (const key of Object.keys(view)) delete view[key];\n    }\n    for (const [key, thing] of Object.entries(THING_STATS)) {\n        const view = {};\n        for (const field of Object.keys(thing)) if (field !== 'stats') Object.defineProperty(view, field, {enumerable:true, get:()=>thing[field]});\n        for (const [stat, rule] of Object.entries(thing.stats)) {\n            Object.defineProperty(view, stat, {enumerable:true, get:()=>getThingStatBase(key, stat)});\n        }\n        if (thing.kind === 'unit') {\n            BASE_UNIT_STATS[key] = view; UNIT_DISPLAY_NAMES[key] = thing.name;\n            if (thing.stats.trainingTime) BARRACK_SPAWN_CONFIG[key] = {get baseTime(){return getThingStatBase(key,'trainingTime');},get reduction(){return 1-thing.stats.trainingTime.level.factor;}};\n        } else {\n            Object.defineProperty(view, 'energy', {enumerable:true, get:()=>getThingStatBase(key,'maxEnergy')});\n            if (thing.target === 'wall') Object.defineProperty(view, 'towerEnergy', {enumerable:true, get:()=>view.energy});\n            BASE_CARD_TYPES[key] = view;\n        }\n        DESCRIPTIONS[key] = thing.description || '';\n    }\n}\nfunction getThingStatBase(key, stat, seen = new Set()) {\n    const id = key+'.'+stat, rule = THING_STATS[key]?.stats[stat];\n    if (!rule || seen.has(id)) return NaN;\n    if (rule.from) { seen.add(id); const [other, field] = rule.from.split('.'); return getThingStatBase(other, field, seen); }\n    return rule.base === null ? NaN : Number(rule.base);\n}\nrebuildThingDefinitionViews();\n\n`+src.slice(end);
src=src.replace(/\/\/ Spawn timing config[\s\S]*?let RESEARCH_COST_EXP = 3;/,'let RESEARCH_COST_EXP = 3;');
src=src.replace(/const RESEARCHABLE_UNIT_STATS = \{[\s\S]*?\n\};\s*/, '');
src=src.replace(/\/\/ Soft caps for precomputed stats[\s\S]*?let PRECOMPUTED_STATS_MAP =/,'let PRECOMPUTED_STATS_MAP =');
src=src.replace(/        gatherPerTrip: (38|40),\r?\n/g,'');
fs.writeFileSync(p+'data_static.js.new',src);fs.renameSync(p+'data_static.js.new',p+'data_static.js');
