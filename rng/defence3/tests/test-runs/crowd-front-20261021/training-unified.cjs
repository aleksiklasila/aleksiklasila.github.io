const fs=require('fs'),save=(p,s)=>{fs.writeFileSync(p+'.new',s);fs.renameSync(p+'.new',p)};
let p='src/things/barrack.js',s=fs.readFileSync(p,'utf8');
s=s.replace(/    let cfg = BARRACK_SPAWN_CONFIG\[unitType\] \|\| BARRACK_SPAWN_CONFIG.norm;\r?\n    let reduction = Number.isFinite\(cfg.reduction\) \? cfg.reduction : 0.10;\r?\n    let baseCd =[^\n]+;/,"    let baseCd = Math.max(0.05, getUnitStatFromMap(unitType, level, 'trainingTime', 0));");save(p,s);
s=s.replace("let baseCd = Math.max(0.05, getUnitStatFromMap(unitType, level, 'trainingTime', 0));", "let baseCd = getUnitStatFromMap(unitType, level, 'trainingTime', 0);\n    if (!(baseCd > 0)) baseCd = getUnitStatFromMap('norm', level, 'trainingTime', 0);");
s=s.replace('if (Number.isFinite(researched)) return Math.max(0.05, researched);','if (Number.isFinite(researched) && researched > 0) return researched;');save(p,s);
p='src/data/data_static.js';s=fs.readFileSync(p,'utf8').replace('reduction:1-thing.stats.trainingTime.level.factor','reduction:1-(thing.stats.trainingTime.level.factor ?? 1)').replace("const PRECOMPUTED_UNIT_STAT_KEYS = ['energy'", "const PRECOMPUTED_UNIT_STAT_KEYS = ['trainingTime', 'energy'");save(p,s);
