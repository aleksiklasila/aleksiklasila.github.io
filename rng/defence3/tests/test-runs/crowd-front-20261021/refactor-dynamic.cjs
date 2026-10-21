const fs=require('fs'),p='src/data/data_dynamic.js';let s=fs.readFileSync(p,'utf8');
s=s.replace(/        tables: \{[\s\S]*?\n        \}\r?\n    \};\r?\n\}/,`        tables: {
            THING_STATS: cloneJsValue(THING_STATS),
            BUILD_CATEGORIES: cloneJsValue(BUILD_CATEGORIES),
            RESEARCH_STAT_LABELS: cloneJsValue(RESEARCH_STAT_LABELS),
        }
    };
}`);
// Retire global balance knobs in snapshots/application: each thing owns these values now.
const retired=['BUILDING_ENERGY_LEVEL_EXP','BUILDING_LEVEL_MULT_EXP','BUILDING_DAMAGE_LEVEL_EXP','BUILDING_LINEAR_CD_REDUCTION_PER_LEVEL','BUILDING_LINEAR_VISION_BONUS_PER_LEVEL','SAND_GUN_CD_LEVEL_EXP','RESEARCH_BUILDING_EFFICIENCY_LEVEL_EXP','RESEARCH_BUILDING_EFFICIENCY_CAP','UNIT_COLLECTOR_GATHER_LEVEL_EXP','UNIT_WORKER_SPECIALIST_BASE_RATE','UNIT_WORKER_SPECIALIST_LEVEL_EXP','BUILDING_UPKEEP_EXP','UNIT_UPKEEP_EXP','RESEARCH_BONUS_EXP_UNITS','RESEARCH_BONUS_EXP_OTHER','RESEARCH_BONUS_EXP_OTHER_HOUSE_POPCAP'];
for(const key of retired){s=s.replace(new RegExp('^.*\\b'+key+'\\b.*\\r?\\n','gm'),line=>line.includes('let upKeep')?line:'');}
const a=s.indexOf('    BUILDING_FORMULA_CONFIG.energyLevelExp'),b=s.indexOf('    normalizeBaseCardDefinitions();',a);
// The alias assignment lines above were already removed, so begin at the first remaining formula assignment.
const begin=a>=0?a:s.indexOf('    if (tables.BASE_CARD_TYPES) replaceObjectContents');
const end=s.indexOf('    normalizeBaseCardDefinitions();',begin);
s=s.slice(0,begin)+`    if (tables.THING_STATS) replaceObjectContents(THING_STATS, tables.THING_STATS);
    else importLegacyThingTables(tables);
    if (tables.BUILD_CATEGORIES) replaceObjectContents(BUILD_CATEGORIES, tables.BUILD_CATEGORIES);
    if (tables.RESEARCH_STAT_LABELS) replaceObjectContents(RESEARCH_STAT_LABELS, tables.RESEARCH_STAT_LABELS);
    rebuildThingDefinitionViews();
`+s.slice(end);
s=s.replace(/function normalizeBaseCardDefinitions\(\) \{[\s\S]*?\n\}\r?\n/,`function normalizeBaseCardDefinitions() { rebuildThingDefinitionViews(); }
`);
s=s.replace(/function getUnitResearchStatKeys\(unitType\) \{[\s\S]*?\n\}/,`function getUnitResearchStatKeys(unitType) {
    return Object.entries(THING_STATS[unitType]?.stats || {}).filter(([,s])=>s.researchable).map(([key])=>key);
}`);
s=s.replace(/function getResearchBonusExp\(kind\) \{[\s\S]*?\n\}/,'');
let start=s.indexOf('// (key: the thing, for things with their own exponents: the shrine.)'),finish=s.indexOf('function applyPrecomputedSoftCap',start);
s=s.slice(0,start)+`function getResearchBonusExpForStat(kind, statKey, key) {
    return Number(THING_STATS[key]?.stats[statKey]?.research?.factor) || 1;
}
function applyResearchLevelToBaseValue(kind, baseValue, statKey, researchLevel, key) {
    if (!Number.isFinite(baseValue)) return NaN;
    const rule = THING_STATS[key]?.stats[statKey];
    if (!rule?.researchable) return baseValue;
    const mult = detPow(getResearchBonusExpForStat(kind,statKey,key), clampResearchLevel(researchLevel));
    return rule.research.direction === 'decrease' ? baseValue / Math.max(1e-6,mult) : baseValue * mult;
}
function getPrecomputedSoftCap(kind, key, statKey) {
    const cap = THING_STATS[key]?.stats[statKey]?.softCap;
    if (cap?.model === 'populationLimit') return getConfiguredMaxPop();
    return Number.isFinite(cap) ? Math.max(0,cap) : Infinity;
}

`+s.slice(finish);
s=s.replace(/    let unitCfg = UNIT_FORMULA_CONFIG \|\| \{\};\r?\n/g,'');
s=s.replace(/Math.max\(0.05, Number\(unitCfg.baseAttackCooldownFallback\) \|\| 1.5\)/g,'1.5').replace(/Math.max\(0.1, Number\(unitCfg.baseSpeedFallback\) \|\| 1\)/g,'1').replace(/Math.max\(0.05, Number\(unitCfg.baseVisionFallback\) \|\| 0.8\)/g,'0.8');
start=s.indexOf('function computeBaseUnitStatsAtLevel');finish=s.indexOf('function rebuildPrecomputedStatsMap()',start);
s=s.slice(0,start)+`// This evaluator runs when shared stat rows are rebuilt, never per moving unit.
function evaluateThingStatAtLevel(key, stat, level, seen = new Set()) {
    const rule = THING_STATS[key]?.stats[stat], id = key+'.'+stat;
    if (!rule || seen.has(id)) return NaN;
    seen.add(id);
    let base = getThingStatBase(key,stat), l = rule.level || {};
    if (rule.from && !Object.keys(l).length) {
        const [other, field] = rule.from.split('.');
        return evaluateThingStatAtLevel(other,field,level,seen);
    }
    if (!Number.isFinite(base)) return NaN;
    const n = Math.max(1,clampThingLevel(level));
    let value = base;
    if (l.model === 'population') {
        const m = detPow(l.factor,n); value = base * m * m * Math.max(1,Math.floor(m));
    } else if (l.model === 'farm') value = base + Math.floor(l.coefficient * n * detLog(n+1) * detPow(n,l.power));
    else {
        if (l.factor !== undefined) value *= detPow(l.factor,n-(l.offset ?? 1));
        if (l.linear !== undefined) value *= 1+(n-1)*l.linear;
        if (l.power !== undefined) value *= detPow(n,l.power);
        if (l.add !== undefined) value += (n-1)*l.add;
        if (l.round === 'floor') value = Math.floor(value);
        if (l.round === 'round') value = Math.round(value);
    }
    if (Number.isFinite(l.min)) value = Math.max(l.min,value);
    if (Number.isFinite(l.max)) value = Math.min(l.max,value);
    return value;
}
function computeThingBaseStatsAtLevel(key, level, keys) {
    return Object.fromEntries(keys.map(stat=>[stat,evaluateThingStatAtLevel(key,stat,level)]));
}
function computeBaseUnitStatsAtLevel(unitType, level) {
    return computeThingBaseStatsAtLevel(THING_STATS[unitType]?.kind === 'unit' ? unitType : 'norm',level,PRECOMPUTED_UNIT_STAT_KEYS);
}
function computeBaseBuildingStatsAtLevel(type, level) {
    return computeThingBaseStatsAtLevel(type || 'farm',level,PRECOMPUTED_BUILDING_STAT_KEYS);
}
function clampThingStatValue(key, stat, value) {
    const rule = THING_STATS[key]?.stats[stat];
    if (!rule || !Number.isFinite(value)) return value;
    if (Number.isFinite(rule.min)) value = Math.max(rule.min,value);
    if (Number.isFinite(rule.max)) value = Math.min(rule.max,value);
    return value;
}

`+s.slice(finish);
for(const expr of ['baseAtLevel1[statKey], statKey, 0','baseAtMaxLevel[statKey], statKey, MAX_RESEARCH_LEVEL','base[statKey], statKey, r'])s=s.replace("applyResearchLevelToBaseValue('unit', "+expr+")","applyResearchLevelToBaseValue('unit', "+expr+", unitType)");
s=s.replace('normalizePrecomputedUnitStatValue(unitType, statKey, capped)','clampThingStatValue(unitType, statKey, normalizePrecomputedUnitStatValue(unitType, statKey, capped))');
s=s.replace('arr[r] = applyPrecomputedSoftCap(researched, cap, statKey, baselineValue, maxValueBeforeCap);','arr[r] = clampThingStatValue(buildingKey, statKey, applyPrecomputedSoftCap(researched, cap, statKey, baselineValue, maxValueBeforeCap));');
start=s.indexOf('function getResearchStatEntriesForThing');finish=s.indexOf('let RESEARCH_THINGS =',start);
s=s.slice(0,start)+`function getResearchStatEntriesForThing(kind, key) {
    const thing = THING_STATS[key];
    if (!thing || thing.kind !== kind) return [];
    return Object.entries(thing.stats).filter(([,s])=>s.researchable).map(([statKey])=>({
        statKey, label:RESEARCH_STAT_LABELS[statKey] || statKey,
        baseValue:statKey === 'maxLevel' ? 1 : evaluateThingStatAtLevel(key,statKey,1)
    })).filter(s=>Number.isFinite(s.baseValue) && Math.abs(s.baseValue)>=1e-4);
}

`+s.slice(finish);
fs.writeFileSync(p+'.new',s);fs.renameSync(p+'.new',p);
