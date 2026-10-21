const fs=require('fs');const save=(p,s)=>{fs.writeFileSync(p+'.new',s);fs.renameSync(p+'.new',p)};
let p='src/data/data_static.js',s=fs.readFileSync(p,'utf8');
s=s.replace(/^        (farmName|farmIcon|farmColor|farmDescription|collectorBuildingName|collectorBuildingIcon|collectorBuildingColor|collectorBuildingDescription|collectorUnitName|collectorUnitColor|collectorUnitVis|collectorUnitDescription):.*\r?\n/gm,'');
s=s.replace(/, unitType: "[^"]+"/g,'');
s=s.replace("        } else {\n            Object.defineProperty(view, 'energy'", "        } else {\n            if (thing.spawns && key.startsWith('barrack_')) Object.defineProperty(view, 'unitType', {enumerable:true, get:()=>thing.spawns});\n            Object.defineProperty(view, 'energy'");
s=s.replace(/function getSpawnedUnitTypeForBuildingKey\(key\) \{[\s\S]*?\n\}/,`function getSpawnedUnitTypeForBuildingKey(key) { return THING_STATS[key]?.spawns || null; }`);
s=s.replace(/const RESEARCH_DECREASE_STATS = \{[^\n]+;/,`// Semantic direction index for generic resource penalties; derived from the definitions.
const RESEARCH_DECREASE_STATS = Object.fromEntries(Object.values(THING_STATS).flatMap(t=>Object.entries(t.stats).filter(([,s])=>s.research?.direction === 'decrease').map(([key])=>[key,true])));`);
save(p,s);
p='tests/crowd-front.bench.cjs';s=fs.readFileSync(p,'utf8');s=s.replace("for(const def of Object.values(BASE_UNIT_STATS))if(def.maxAttackRange>0)def.maxAttackRange=1;for(const [key,def]of Object.entries(BASE_CARD_TYPES))if(def.maxAttackRange>0)def.maxAttackRange=key===\"sniper\"?1.6:key===\"watch_tower\"?2:1;", "for(const [key,def]of Object.entries(THING_STATS))if(def.stats.attackRange?.base>0)def.stats.attackRange.softCap=key===\"sniper\"?1.6:key===\"watch_tower\"?2:1;");save(p,s);
// New definitions must reach the page, simulation worker, and helpers together.
for(p of ['index.html','src/sim/sim_client.js','src/sim/sim_worker.js','src/sim/sim_helper.js'])save(p,fs.readFileSync(p,'utf8').replaceAll('20261021-traffic-reach3','20261021-thing-stats1'));
p='src/utils/utils_snapshot.js';save(p,fs.readFileSync(p,'utf8').replace('SIM_RULES_REVISION = 27','SIM_RULES_REVISION = 28'));
