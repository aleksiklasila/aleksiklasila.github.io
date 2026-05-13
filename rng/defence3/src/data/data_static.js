
"use strict";

// ============================================================
// CONFIG
// ============================================================
let MINIMAP_SIZE = 160;
let TILE = 32;
let GRID_W = 80, GRID_H = 80;
let WORLD_W = GRID_W * TILE, WORLD_H = GRID_H * TILE;

// Gold mine config (adjustable from menu)
let GOLD_MINE_COUNT = 18;  // total mine tiles distributed across veins
let GOLD_MINE_MIN = 500;
let GOLD_MINE_MAX = 1500;
let GOLD_MINE_AREA = 70;   // area within which mines spawn (centered)
let ASTAR_MINE_COUNT = 12;
let ASTAR_MINE_MIN = 500;
let ASTAR_MINE_MAX = 1500;
let STARTING_MONEY = 2000;
let STARTING_ASTAR = 9000;
let MAP_TYPE = 'random';
let TYPE_FLOOR = 0, TYPE_WALL = 1;
let CONFIG_MAX_POP = 200;
let TICK_RATE = 20; // ticks per second (menu configurable)
let TICK_MS = 1000 / TICK_RATE;
let UNIT_EFFECTIVE_STATS_RECALC_TICKS = 5;
let UNIT_COLLISION_RECALC_TICKS = 5;
let ASTAR_MAX_ITERS_LIMIT = 18000;
let ASTAR_ITER_BUDGET_PER_PLAYER_TICK = 9000;
let WORKER_AI_TICK_DELAY = 3;
let INPUT_DELAY = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 2 : 0; // desktop: immediate lockstep input, touch: small safety buffer
let LOCKSTEP_PIPELINE_MIN = 2;
let LOCKSTEP_PIPELINE_TICKS = Math.max(INPUT_DELAY, LOCKSTEP_PIPELINE_MIN); // keep only a few ticks in flight to avoid strict-lockstep starvation
let LOCKSTEP_PACKET_RESEND_MS = Math.max(40, Math.floor(TICK_MS * 2));
let LOCKSTEP_BUNDLE_RESEND_MS = Math.max(40, Math.floor(TICK_MS * 2));
let LOCKSTEP_RESEND_REQUEST_MS = Math.max(200, Math.floor(TICK_MS * 4));
let LOCKSTEP_HARD_RESYNC_MS = Math.max(3000, Math.floor(TICK_MS * 60));
let LOCKSTEP_STATE_CHECK_INTERVAL = 10;
let LOCKSTEP_DEBUG_HASH_DETAILS = true;
let tickAlpha = 0; // 0..1 interpolation between ticks for smooth rendering

function secondsToTicks(seconds) {
    let sec = Math.max(0, Number(seconds) || 0);
    return Math.max(1, Math.round(sec * TICK_RATE));
}

const C_BG = '#111', C_WALL = '#3a3a3a', C_FLOOR = '#161616';

const PLAYER_COLORS = ['#4488ff', '#ff4444'];
const PLAYER_COLORS_DIM = ['rgba(68,136,255,0.3)', 'rgba(255,68,68,0.3)'];

const AREA_UNIT_TILE_EQUIVALENT = 5;

const RESOURCE_TYPES = {
    energy: {
        key: 'energy',
        label: 'Energy',
        stockpileKey: 'energy',
        icon: '⚡',
        color: '#da0',
        mineArrayKey: 'goldMines',
        mineStatKey: 'gold',
        mineTileType: 'mine',
        farmKey: 'farm',
        farmName: 'Energy Farm',
        farmIcon: '🌾',
        farmColor: '#da0',
        farmDescription: 'Energy collectors can harvest here; farm level multiplies energy gather speed.',
        collectorBuildingKey: 'spawner',
        collectorBuildingName: 'Collector',
        collectorBuildingIcon: '🏭',
        collectorBuildingColor: '#432',
        collectorBuildingDescription: 'Spawns collectors that gather energy from mines.',
        collectorUnitKey: 'collector',
        collectorUnitName: 'Collector',
        collectorUnitColor: '#aaa',
        collectorUnitVis: 'star',
        collectorUnitDescription: 'Resource worker. Mines energy tiles and refills the shared energy stockpile.',
        gatherPerTrip: 23,
        dropoffSound: 'gold_collected',
        carryGlyph: '⚡',
        emptyCarryGlyph: '⚡',
        supportsDropTarget: true,
    },
    astar: {
        key: 'astar',
        label: 'A*',
        stockpileKey: 'astar',
        icon: '★',
        color: '#9aa',
        mineArrayKey: 'astarMines',
        mineStatKey: 'astar',
        mineTileType: 'astar_mine',
        farmKey: 'astar_farm',
        farmName: 'A* Farm',
        farmIcon: '★',
        farmColor: '#9aa',
        farmDescription: 'A* collectors can harvest here; farm level multiplies A* gather speed.',
        collectorBuildingKey: 'astar_spawner',
        collectorBuildingName: 'A*',
        collectorBuildingIcon: '★',
        collectorBuildingColor: '#555',
        collectorBuildingDescription: 'Spawns A*ers that gather A* from gray mines and refill the shared A* stockpile.',
        collectorUnitKey: 'astar_collector',
        collectorUnitName: 'A* Collector',
        collectorUnitColor: '#bbb',
        collectorUnitVis: 'star',
        collectorUnitDescription: 'Resource worker. Mines gray A* tiles and refills the shared A* stockpile used by pathfinding.',
        gatherPerTrip: 30,
        dropoffSound: 'astar_collected',
        carryGlyph: '★',
        emptyCarryGlyph: '☆',
        supportsDropTarget: false,
    }
};

const RESOURCE_TYPE_LIST = Object.freeze(Object.values(RESOURCE_TYPES));
const RESOURCE_TYPE_BY_COLLECTOR_UNIT = Object.freeze(RESOURCE_TYPE_LIST.reduce((out, cfg) => {
    out[cfg.collectorUnitKey] = cfg;
    return out;
}, {}));
const RESOURCE_TYPE_BY_COLLECTOR_BUILDING = Object.freeze(RESOURCE_TYPE_LIST.reduce((out, cfg) => {
    out[cfg.collectorBuildingKey] = cfg;
    return out;
}, {}));
const RESOURCE_TYPE_BY_FARM = Object.freeze(RESOURCE_TYPE_LIST.reduce((out, cfg) => {
    out[cfg.farmKey] = cfg;
    return out;
}, {}));

function getResourceTypeConfig(resourceKey) {
    return RESOURCE_TYPES[resourceKey] || null;
}

function getResourceTypeByCollectorUnit(unitType) {
    return RESOURCE_TYPE_BY_COLLECTOR_UNIT[unitType] || null;
}

function getResourceTypeByCollectorBuilding(buildingKey) {
    return RESOURCE_TYPE_BY_COLLECTOR_BUILDING[buildingKey] || null;
}

function getResourceTypeByFarmKey(farmKey) {
    return RESOURCE_TYPE_BY_FARM[farmKey] || null;
}

function getCollectorUnitTypeForResource(resourceKey) {
    let cfg = getResourceTypeConfig(resourceKey);
    return cfg ? cfg.collectorUnitKey : null;
}

function getCollectorBuildingKeyForResource(resourceKey) {
    let cfg = getResourceTypeConfig(resourceKey);
    return cfg ? cfg.collectorBuildingKey : null;
}

function getCollectorFarmKeyForResource(resourceKey) {
    let cfg = getResourceTypeConfig(resourceKey);
    return cfg ? cfg.farmKey : null;
}

function buildResourceCollectorCardTypes() {
    let out = {};
    for (let cfg of RESOURCE_TYPE_LIST) {
        out[cfg.farmKey] = { name: cfg.farmName, price: cfg.key === 'astar' ? 50 : 40, icon: cfg.farmIcon, color: cfg.farmColor, visionRange: 0, multiplier: 0.02, target: 'floor', resourceKey: cfg.key };
        out[cfg.collectorBuildingKey] = { name: cfg.collectorBuildingName, price: cfg.key === 'astar' ? 170 : 150, icon: cfg.collectorBuildingIcon, color: cfg.collectorBuildingColor, visionRange: 0.6, energy: 60, target: 'floor', resourceKey: cfg.key };
    }
    return out;
}

function buildResourceCollectorDescriptions() {
    let out = {};
    for (let cfg of RESOURCE_TYPE_LIST) {
        out[cfg.farmKey] = cfg.farmDescription;
        out[cfg.collectorBuildingKey] = cfg.collectorBuildingDescription;
        out[cfg.collectorUnitKey] = cfg.collectorUnitDescription;
    }
    return out;
}

function buildResourceCollectorSpawnConfig() {
    let out = {};
    for (let cfg of RESOURCE_TYPE_LIST) {
        out[cfg.collectorUnitKey] = { baseTime: 15, reduction: 0.10 };
    }
    return out;
}

function buildResourceCollectorUnitStats() {
    let out = {};
    for (let cfg of RESOURCE_TYPE_LIST) {
        out[cfg.collectorUnitKey] = {
            energy: 15,
            price: 15,
            speed: 2.0,
            atk: 0,
            attackRange: 0,
            visionRange: 0.6,
            atkCd: 49.95,
            astarCost: 10,
            gatherPerTrip: cfg.gatherPerTrip,
            transferCooldown: 2.0,
            workerSearchDistance: 2.0,
            color: cfg.collectorUnitColor,
            r: 6,
            vis: cfg.collectorUnitVis,
            isWorker: true,
            resourceKey: cfg.key,
        };
    }
    return out;
}

function buildResourceCollectorUnitScaling() {
    let out = {};
    for (let cfg of RESOURCE_TYPE_LIST) {
        out[cfg.collectorUnitKey] = { energyExp: 1.13, dmgExp: 1.0, speedExp: 1.05, speedCapAbs: 4.8, cdExp: 1.0, minCd: 49.95, visionExp: 1.03, visionCapBonus: 1.6 };
    }
    return out;
}

function buildResourceCollectorResearchableStats() {
    let out = {};
    for (let cfg of RESOURCE_TYPE_LIST) {
        out[cfg.collectorUnitKey] = ['energy', 'speed', 'visionRange', 'workerSearchDistance', 'gatherPerTrip', 'transferCooldown', 'astarCost'];
    }
    return out;
}

const RESOURCE_COLLECTOR_CARD_TYPES = Object.freeze(buildResourceCollectorCardTypes());
const RESOURCE_COLLECTOR_DESCRIPTIONS = Object.freeze(buildResourceCollectorDescriptions());
const RESOURCE_COLLECTOR_SPAWN_CONFIG = Object.freeze(buildResourceCollectorSpawnConfig());
const RESOURCE_COLLECTOR_UNIT_STATS = Object.freeze(buildResourceCollectorUnitStats());
const RESOURCE_COLLECTOR_UNIT_SCALING = Object.freeze(buildResourceCollectorUnitScaling());
const RESOURCE_COLLECTOR_RESEARCHABLE_STATS = Object.freeze(buildResourceCollectorResearchableStats());
const RESOURCE_FARM_KEYS = Object.freeze(RESOURCE_TYPE_LIST.map(cfg => cfg.farmKey));
const RESOURCE_COLLECTOR_BUILDING_KEYS = Object.freeze(RESOURCE_TYPE_LIST.map(cfg => cfg.collectorBuildingKey));
const RESOURCE_COLLECTOR_UNIT_KEYS = Object.freeze(RESOURCE_TYPE_LIST.map(cfg => cfg.collectorUnitKey));



// ============================================================
// CARD/BUILDING TYPES
// ============================================================
const BASE_CARD_TYPES = {
    // Towers (target: wall)
    pistol: { name: "Pistol", price: 35, icon: "\u26A1", color: "#964B00", visionRange: 0.6, cd: 2.0, damage: 8, target: 'wall', towerEnergy: 30 },
    smg: { name: "SMG", price: 45, icon: "\u26A1", color: "#aaf", visionRange: 0.6, cd: 1.25, damage: 5, target: 'wall', towerEnergy: 25 },
    water: { name: "Water", price: 74, icon: "\uD83D\uDCA7", color: "#4af", visionRange: 0.6, cd: 1.75, damage: 10, wetDuration: 7, target: 'wall', towerEnergy: 95 },
    poison: { name: "Poison", price: 173, icon: "\uD83E\uDDEA", color: "#2d2", visionRange: 0.6, cd: 2.5, damage: 3, poisonDps: 28, poisonDuration: 5, target: 'wall', towerEnergy: 200 },
    fire: { name: "Fire", price: 375, icon: "\uD83D\uDD25", color: "#f50", visionRange: 0.6, cd: 5.5, damage: 45, burnDps: 2.25, burnDuration: 3.5, blastDamage: 10, blastRadius: 0.06, target: 'wall', towerEnergy: 350 },
    sand_gun: { name: "Sand Gun", price: 60, icon: "\u231B", color: "#c96", visionRange: 0.8, cd: 7.5, damage: 5, sandDuration: 9, target: 'wall', towerEnergy: 180 },
    ice: { name: "Ice", price: 700, icon: "\u2744\uFE0F", color: "#afe", visionRange: 0.6, cd: 2.0, damage: 65, freezeDps: 6.6, freezeDuration: 3.5, target: 'wall', towerEnergy: 400 },
    sniper: { name: "Sniper", price: 1500, icon: "\uD83C\uDFAF", color: "#888", visionRange: 1.6, cd: 12.0, damage: 170, target: 'wall', towerEnergy: 1500 },
    elements: { name: "Elements", price: 50, icon: "\uD83C\uDF08", color: "#fff", visionRange: 0.6, cd: 1.75, damage: 1, burnDps: 0.2, poisonDps: 0.2, freezeDps: 0.2, burnDuration: 6, poisonDuration: 6, freezeDuration: 6, wetDuration: 7, sandDuration: 9, target: 'wall', towerEnergy: 150 },
    laser: { name: "Laser", price: 125, icon: "\u26A1", color: "#f00", visionRange: 0, damage: 750, target: 'wall', towerEnergy: 300 },
    watch_tower: { name: "Watch Tower", price: 25, icon: "\uD83D\uDC41\uFE0F", color: "#fd0", visionRange: 2.0, cd: 1.4, damage: 1, watchDuration: 5, target: 'wall', towerEnergy: 15, isWatchTower: true, maxVisionRange: 4.8 },

    // Floor items
    sand: { name: "Sand", price: 30, icon: "\u231B", color: "#c96", visionRange: 0, sandDuration: 0.5, target: 'floor' },
    lava: { name: "Lava", price: 50, icon: "\uD83C\uDF0B", color: "#d22", visionRange: 0, burnDps: 1, burnDuration: 1.5, target: 'floor' },
    poison_puddle: { name: "Poison Puddle", price: 90, icon: "\u2620\uFE0F", color: "#2d2", visionRange: 0, poisonDps: 1, poisonDuration: 1.5, target: 'floor' },
    ice_patch: { name: "Ice Patch", price: 60, icon: "\u2744\uFE0F", color: "#afe", visionRange: 0, freezeDps: 1, freezeDuration: 1.5, target: 'floor' },
    water_puddle: { name: "Water Puddle", price: 50, icon: "\uD83D\uDCA7", color: "#4af", visionRange: 0, wetDuration: 3, target: 'floor' },
    mine: { name: "Mine", price: 20, icon: "\uD83D\uDCA3", color: "#666", visionRange: 0, blastDamage: 135, blastRadius: 0.084, target: 'floor' },
    ...RESOURCE_COLLECTOR_CARD_TYPES,

    // Special
    salvager: { name: "Salvager", price: 150, icon: "\u267B\uFE0F", color: "#543", visionRange: 0.6, energy: 60, target: 'floor' },
    builder_spawner: { name: "Builder", price: 180, icon: "\uD83D\uDEA7", color: "#354", visionRange: 0.6, energy: 60, target: 'floor' },
    healer_spawner: { name: "Healer", price: 180, icon: "\u25B3\u2695\uFE0F", color: "#355", visionRange: 0.6, energy: 60, target: 'floor' },
    research: { name: "Research", price: 260, icon: "\u25B3\uD83E\uDDEA", color: "#446", visionRange: 0.6, energy: 70, efficiency: 1, target: 'floor' },
    house: { name: "House", price: 110, icon: "\uD83C\uDFE0", color: "#c95", visionRange: 0.4, energy: 30, target: 'floor' },
    area_upgrader: { name: "Area Up", price: 100, icon: "\u2B06\uFE0F", color: "#fd0", visionRange: 0.2, target: 'area_upgrade' },

    // Clouds
    cloud_0a: { name: "Cloud R1", price: 100, icon: "\u2601\uFE0F", color: "#f66", visionRange: 0, target: 'wall', towerEnergy: 200, isCloud: true, pairId: 0 },
    cloud_0b: { name: "Cloud R2", price: 100, icon: "\u2601\uFE0F", color: "#f66", visionRange: 0, target: 'wall', towerEnergy: 200, isCloud: true, pairId: 0 },
    cloud_1a: { name: "Cloud B1", price: 100, icon: "\u2601\uFE0F", color: "#66f", visionRange: 0, target: 'wall', towerEnergy: 200, isCloud: true, pairId: 1 },
    cloud_1b: { name: "Cloud B2", price: 100, icon: "\u2601\uFE0F", color: "#66f", visionRange: 0, target: 'wall', towerEnergy: 200, isCloud: true, pairId: 1 },
    cloud_2a: { name: "Cloud G1", price: 100, icon: "\u2601\uFE0F", color: "#6f6", visionRange: 0, target: 'wall', towerEnergy: 200, isCloud: true, pairId: 2 },
    cloud_2b: { name: "Cloud G2", price: 100, icon: "\u2601\uFE0F", color: "#6f6", visionRange: 0, target: 'wall', towerEnergy: 200, isCloud: true, pairId: 2 },
    cloud_3a: { name: "Cloud Y1", price: 100, icon: "\u2601\uFE0F", color: "#ff6", visionRange: 0, target: 'wall', towerEnergy: 200, isCloud: true, pairId: 3 },
    cloud_3b: { name: "Cloud Y2", price: 100, icon: "\u2601\uFE0F", color: "#ff6", visionRange: 0, target: 'wall', towerEnergy: 200, isCloud: true, pairId: 3 },

    // Barracks (one per unit type)
    barrack_norm: { name: "Barrack", price: 100, icon: "\u26FA", color: "#686", visionRange: 0.8, target: 'floor', unitType: 'norm' },
    barrack_fast: { name: "Fast Brk", price: 80, icon: "\u26FA", color: "#eee", visionRange: 1.0, target: 'floor', unitType: 'fast' },
    barrack_tank: { name: "Tank Brk", price: 200, icon: "\u26FA", color: "#555", visionRange: 0.6, target: 'floor', unitType: 'tank' },
    barrack_boss: { name: "Boss Brk", price: 500, icon: "\u26FA", color: "#222", visionRange: 0.8, target: 'floor', unitType: 'boss' },
    barrack_flying: { name: "Flying Brk", price: 150, icon: "\u26FA", color: "#dd0", visionRange: 1.0, target: 'floor', unitType: 'flying' },
    barrack_mole: { name: "Mole Brk", price: 120, icon: "\u26FA", color: "#543", visionRange: 0.8, target: 'floor', unitType: 'mole' },
    barrack_poison_resistant: { name: "Psn Res Brk", price: 160, icon: "\u26FA", color: "#2d2", visionRange: 0.8, target: 'floor', unitType: 'poison_resistant' },
    barrack_fire_resistant: { name: "Fire Res Brk", price: 160, icon: "\u26FA", color: "#f50", visionRange: 0.8, target: 'floor', unitType: 'fire_resistant' },
    barrack_water_resistant: { name: "Wtr Res Brk", price: 160, icon: "\u26FA", color: "#4af", visionRange: 1.0, target: 'floor', unitType: 'water_resistant' },
    barrack_ice_resistant: { name: "Ice Res Brk", price: 160, icon: "\u26FA", color: "#afe", visionRange: 0.8, target: 'floor', unitType: 'ice_resistant' },
    barrack_laser_resistant: { name: "Lsr Res Brk", price: 160, icon: "\u26FA", color: "#d0f", visionRange: 0.8, target: 'floor', unitType: 'laser_resistant' },
    barrack_snake: { name: "Snake Brk", price: 400, icon: "\u26FA", color: "#0f0", visionRange: 0.8, target: 'floor', unitType: 'snake' },
    barrack_scout: { name: "Scout Brk", price: 90, icon: "\u26FA", color: "#9cf", visionRange: 1.8, target: 'floor', unitType: 'scout' },
};

// Single place for building Energy scaling across all building/card types.
let BUILDING_ENERGY_LEVEL_EXP = 2;
let BUILDING_LEVEL_MULT_EXP = 1.6;
let BUILDING_DAMAGE_LEVEL_EXP = 1.4;
let BUILDING_LINEAR_CD_REDUCTION_PER_LEVEL = 0.10;
let BUILDING_LINEAR_VISION_BONUS_PER_LEVEL = 0.20;
let SAND_GUN_CD_LEVEL_EXP = 0.9;
let RESEARCH_BUILDING_EFFICIENCY_LEVEL_EXP = 1.05;
let RESEARCH_BUILDING_EFFICIENCY_CAP = 3;
let UNIT_COLLECTOR_GATHER_LEVEL_EXP = 1;
let UNIT_WORKER_SPECIALIST_BASE_RATE = 5;
let UNIT_WORKER_SPECIALIST_LEVEL_EXP = 1.22;

const BUILDING_FORMULA_CONFIG = {
    levelMultExp: 1.6,
    energyLevelExp: 2,
    damageLevelExp: 1.4,
    linearCdReductionPerLevel: 0.10,
    linearVisionBonusPerLevel: 0.20,
    sandGunCdLevelExp: 0.9,
    researchEfficiencyLevelExp: 1.05,
    researchEfficiencyCap: 3,
    spawnCdFloor: 0.05,
    spawnedUnitPriceLevelExp: 2,
    farmBaseMultiplierFallback: 1,
    farmLevelPolyCoeff: 1,
    farmLevelPowerExp: 3,
    sandFloorDamageBase: 0.05,
    lavaFloorDamageBase: 1,
    mineFloorDamageBase: 135,
    poisonPuddleFloorDamageBase: 1,
    icePatchFloorDamageBase: 1,
    directTowerCdFloor: 0.25,
    fireBurnDpsMin: 0.1,
    fireBurnDpsFromDamageMul: 0.05,
    fireBurnDurationLevelAdd: 0.5,
    fireBurnDurationFallbackBase: 3,
    fireBurnDurationFallbackLevelAdd: 0.5,
    poisonDpsMin: 0.1,
    poisonDpsFromDamageMul: 0.10,
    poisonDurationLevelAdd: 2.5,
    poisonDurationFallbackBase: 7.5,
    poisonDurationFallbackLevelAdd: 2.5,
    iceFreezeDpsMin: 0.2,
    iceFreezeDpsFromDamageMul: 0.20,
    iceFreezeDurationLevelAdd: 0.5,
    iceFreezeDurationFallbackBase: 3,
    iceFreezeDurationFallbackLevelAdd: 0.5,
    elementsDotMin: 0.1,
    elementsDotFromDamageMul: 0.20,
    elementsDurationLevelAdd: 1,
    elementsDurationFallbackBase: 5,
    lavaBurnDpsMin: 0.1,
    lavaBurnDurationFallback: 1.5,
    poisonPuddleDpsMin: 0.1,
    poisonPuddleDurationFallback: 1.5,
    icePatchDpsMin: 0.2,
    icePatchDurationFallback: 1.5,
    waterWetDurationFallbackBase: 6,
    waterWetDurationFallbackLevelAdd: 1,
    waterPuddleWetDurationFallback: 3,
    waterWetDurationLevelAdd: 1,
    sandGunDurationFallback: 9,
    sandDurationFallback: 0.5,
    watchDurationLevelAdd: 1,
    watchDurationFallbackBase: 4,
};

const UNIT_FORMULA_CONFIG = {
    collectorGatherLevelExp: 1,
    workerSpecialistBaseRate: 5,
    workerSpecialistLevelExp: 1.46,
    workerTransferCooldownLevelExp: 0.9,
    astarCostLevelExp: 1.75,
    baseAttackCooldownFallback: 1.5,
    baseSpeedFallback: 1,
    baseVisionMin: 0.05,
    baseVisionFallback: 0.8,
};

const RESEARCH_FORMULA_CONFIG = {
    unitPriceBonusExp: 1.8,
    unitVisionRangeBonusExp: 1.08,
    unitAttackRangeBonusExp: 1.08,
    buildingVisionRangeBonusExp: 1.06,
};

// Ensure every card/building type has a canonical base Energy in BASE_CARD_TYPES.
// Keep towerEnergy mirrored for compatibility with existing checks/UI code paths.
const BASE_CARD_DEFAULT_ENERGY = {
    sand: 30,
    lava: 30,
    poison_puddle: 30,
    ice_patch: 30,
    water_puddle: 30,
    mine: 30,
    salvager: 60,
    builder_spawner: 60,
    healer_spawner: 60,
    research: 70,
    house: 120,
    area_upgrader: 1,
    ...RESOURCE_TYPE_LIST.reduce((out, cfg) => {
        out[cfg.farmKey] = 1000;
        out[cfg.collectorBuildingKey] = 60;
        return out;
    }, {}),
};

const DEFAULT_BARRACK_BUILDING_ENERGY = 60;

for (let [key, def] of Object.entries(BASE_CARD_TYPES)) {
    if (!def || typeof def !== 'object') continue;
    let fallbackEnergy = Number.isFinite(def.energy) && def.energy > 0
        ? def.energy
        : (Number.isFinite(def.towerEnergy) && def.towerEnergy > 0
            ? def.towerEnergy
            : (key.startsWith('barrack_')
                ? DEFAULT_BARRACK_BUILDING_ENERGY
                : BASE_CARD_DEFAULT_ENERGY[key]));
    if (!(Number.isFinite(fallbackEnergy) && fallbackEnergy > 0)) continue;
    def.energy = fallbackEnergy;
    if (def.target === 'wall' || Number.isFinite(def.towerEnergy)) def.towerEnergy = fallbackEnergy;
}

// Descriptions
const DESCRIPTIONS = {
    // Towers
    pistol: "Basic single-shot tower. Reliable damage, decent range.",
    smg: "Rapid-fire tower. Low damage per hit but high fire rate.",
    water: "Soaks enemies, making them vulnerable to freeze DPS.",
    poison: "Applies stacking poison DoT. Low base damage.",
    fire: "Splash damage and burn DoT. Strong vs groups.",
    sand_gun: "Slows enemies drastically. Low damage.",
    ice: "Freezes enemies. Combo with water for freeze DPS.",
    sniper: "Long-range precision tower with very high single-shot damage.",
    elements: "Applies all status effects. Jack of all trades.",
    laser: "Beam between aligned laser towers. Constant very high DPS. Difficult to use effectively.",
    watch_tower: "Marks enemies with Watch and grants shared sight around marked targets. Low Energy, large vision.",
    // Floor
    sand: "Slows enemies walking over it. Fast to build. Strong agains moles. Low health.",
    lava: "Burns enemies walking over it. Fast to build. Strong agains moles. Low health.",
    poison_puddle: "Poisons enemies walking over it. Fast to build. Strong agains moles. Low health.",
    ice_patch: "Freezes enemies walking over it. Fast to build. Strong agains moles. Low health.",
    water_puddle: "Soaks enemies walking over it. Fast to build. Strong agains moles. Low health.",
    mine: "Explodes once when an enemy walks over it. Fast to build. Strong agains moles. Low health.",
    // Special
    salvager: "Spawns salvagers that recycle marked buildings.",
    builder_spawner: "Spawns builders that construct buildings. All placed buildings start at 1 energy and need builders to become functional.",
    healer_spawner: "Spawns healers that restore damaged friendly units. Healers fetch supplies from healer spawners before each heal.",
    research: "Runs queued research projects and spawns researchers that complete research tasks.",
    house: "Raises max population by 1.6^{level} while operational.",
    cloud_0a: "Cloud bridge endpoint. Connects areas for adjacency.",
    cloud_0b: "Cloud bridge endpoint. Connects areas for adjacency.",
    cloud_1a: "Cloud bridge endpoint. Connects areas for adjacency.",
    cloud_1b: "Cloud bridge endpoint. Connects areas for adjacency.",
    cloud_2a: "Cloud bridge endpoint. Connects areas for adjacency.",
    cloud_2b: "Cloud bridge endpoint. Connects areas for adjacency.",
    cloud_3a: "Cloud bridge endpoint. Connects areas for adjacency.",
    cloud_3b: "Cloud bridge endpoint. Connects areas for adjacency.",
    area_upgrader: "Upgrade a fully-filled area's multiplier level. Exponential cost.",
    // Barracks
    barrack_norm: "Trains basic infantry. Balanced stats.",
    barrack_fast: "Trains fast scouts. Fragile but quick.",
    barrack_tank: "Trains heavy units. Slow but tough.",
    barrack_boss: "Trains super-heavy units. Expensive powerhouse.",
    barrack_flying: "Trains flying units. Ignores walls, ranged attack.",
    barrack_mole: "Trains moles. Immune to towers, very fragile.",
    barrack_poison_resistant: "Trains poison-immune units.",
    barrack_fire_resistant: "Trains fire-immune units.",
    barrack_water_resistant: "Trains water-immune units.",
    barrack_ice_resistant: "Trains ice-immune units.",
    barrack_laser_resistant: "Trains laser-immune units.",
    barrack_snake: "Trains snakes. Massive Energy, leaves a trail.",
    barrack_scout: "Trains scouts. Fast flying recon units that roam the map.",
    // Units
    norm: "Basic infantry. Balanced stats, cheap to produce.",
    fast: "Fast scout. Low Energy but high speed.",
    tank: "Heavy infantry. High Energy and damage, slow.",
    boss: "Super-heavy unit. Extremely tough and powerful.",
    flying: "Air unit. Ignores walls, has ranged attack.",
    mole: "Stealth unit. Immune to tower fire, very fragile.",
    poison_resistant: "Poison-immune. Attacks with toxic clouds.",
    fire_resistant: "Fire-immune. Attacks with flame bursts.",
    water_resistant: "Water-immune. Attacks with water jets.",
    ice_resistant: "Ice-immune. Attacks with frost shards.",
    laser_resistant: "Laser-immune. Shoots laser beams from range.",
    snake: "Massive serpent. Rams targets, takes self-damage.",
    scout: "Fast flying recon. Very high vision, low Energy, low attack. Patrols random points continuously.",
    healer_unit: "Support worker. Fetches healing supplies from healer spawners and restores nearby damaged friendly units.",
    researcher_unit: "Research worker. Fetches supplies from research labs and converts them into research progress.",
    ...RESOURCE_COLLECTOR_DESCRIPTIONS,
};

// Build menu categories
const BUILD_CATEGORIES = {
    barracks: ['barrack_norm', 'barrack_fast', 'barrack_tank', 'barrack_boss', 'barrack_flying', 'barrack_mole', 'barrack_poison_resistant', 'barrack_fire_resistant', 'barrack_water_resistant', 'barrack_ice_resistant', 'barrack_laser_resistant', 'barrack_snake', 'barrack_scout'],
    towers: ['pistol', 'smg', 'water', 'poison', 'fire', 'sand_gun', 'ice', 'sniper', 'elements', 'laser', 'watch_tower'],
    floor: ['sand', 'lava', 'poison_puddle', 'ice_patch', 'water_puddle', 'mine', ...RESOURCE_FARM_KEYS],
    special: [...RESOURCE_COLLECTOR_BUILDING_KEYS, 'salvager', 'builder_spawner', 'healer_spawner', 'research', 'house', 'area_upgrader', 'cloud_0a', 'cloud_0b', 'cloud_1a', 'cloud_1b', 'cloud_2a', 'cloud_2b', 'cloud_3a', 'cloud_3b'],
};

// Spawn timing config for non-barrack producers and barrack level-reduction rules.
const BARRACK_SPAWN_CONFIG = {
    norm: { baseTime: 40, reduction: 0.10 },
    fast: { baseTime: 20, reduction: 0.10 },
    tank: { baseTime: 80, reduction: 0.08 },
    boss: { baseTime: 400, reduction: 0.06 },
    mole: { baseTime: 10, reduction: 0.12 },
    snake: { baseTime: 800, reduction: 0.05 },
    flying: { baseTime: 45, reduction: 0.09 },
    poison_resistant: { baseTime: 60, reduction: 0.08 },
    fire_resistant: { baseTime: 70, reduction: 0.08 },
    water_resistant: { baseTime: 50, reduction: 0.09 },
    ice_resistant: { baseTime: 65, reduction: 0.08 },
    laser_resistant: { baseTime: 55, reduction: 0.08 },
    scout: { baseTime: 14, reduction: 0.11 },
    ...RESOURCE_COLLECTOR_SPAWN_CONFIG,
    salvager_unit: { baseTime: 20, reduction: 0.10 },
    builder_unit: { baseTime: 25, reduction: 0.10 },
    healer_unit: { baseTime: 25, reduction: 0.10 },
    researcher_unit: { baseTime: 25, reduction: 0.10 },
};

// Unit combat stats
const BASE_UNIT_STATS = {
    norm: { energy: 40, price: 400, speed: 2.6, atk: 5, attackRange: 0.1, visionRange: 0.8, atkCd: 1.5, astarCost: 10, color: '#fff', r: 8, vis: 'circle', attackStyle: 'melee' },
    fast: { energy: 20, price: 200, speed: 4.8, atk: 3, attackRange: 0.1, visionRange: 1.0, atkCd: 1.0, astarCost: 10, color: '#eee', r: 6, vis: 'circle', attackStyle: 'melee' },
    tank: { energy: 80, price: 800, speed: 1.4, atk: 8, attackRange: 0.1, visionRange: 0.6, atkCd: 2.25, astarCost: 10, color: '#555', r: 10, vis: 'circle', attackStyle: 'melee' },
    boss: { energy: 400, price: 4000, speed: 1.2, atk: 20, attackRange: 0.1, visionRange: 0.8, atkCd: 3.0, astarCost: 10, color: '#222', r: 12, vis: 'circle', attackStyle: 'melee' },
    flying: { energy: 45, price: 450, speed: 3.0, atk: 4, attackRange: 0.3, visionRange: 1.0, atkCd: 1.75, astarCost: 10, color: '#dd0', r: 7, vis: 'triangle', isFlying: true, attackStyle: 'swoop' },
    mole: { energy: 10, price: 100, speed: 1.6, atk: 2, attackRange: 0.1, visionRange: 0.8, atkCd: 1.25, astarCost: 10, color: '#543', r: 7.5, vis: 'mole', turretImmune: true },
    poison_resistant: { energy: 60, price: 600, speed: 2.4, atk: 6, attackRange: 0.2, visionRange: 0.8, atkCd: 1.75, astarCost: 10, color: '#2d2', r: 9, vis: 'circle', poisonResistant: true, attackStyle: 'poison' },
    fire_resistant: { energy: 70, price: 700, speed: 2.0, atk: 7, attackRange: 0.2, visionRange: 0.8, atkCd: 2.0, astarCost: 10, color: '#f50', r: 10, vis: 'circle', fireResistant: true, attackStyle: 'fire' },
    water_resistant: { energy: 50, price: 500, speed: 3.2, atk: 5, attackRange: 0.2, visionRange: 1.0, atkCd: 1.5, astarCost: 10, color: '#4af', r: 8, vis: 'circle', waterResistant: true, attackStyle: 'water' },
    ice_resistant: { energy: 65, price: 650, speed: 2.2, atk: 6, attackRange: 0.2, visionRange: 0.8, atkCd: 1.75, astarCost: 10, color: '#afe', r: 9, vis: 'circle', iceResistant: true, attackStyle: 'ice' },
    laser_resistant: { energy: 55, price: 550, speed: 2.3, atk: 5, attackRange: 0.5, visionRange: 0.8, atkCd: 1.75, astarCost: 10, color: '#d0f', r: 9, vis: 'circle', laserResistant: true, attackStyle: 'laser' },
    snake: { energy: 800, price: 8000, speed: 3.2, atk: 15, attackRange: 0.1, visionRange: 0.8, atkCd: 1.5, astarCost: 10, color: '#0f0', r: 7, vis: 'snake', isSnake: true, snakeMaxHistory: 20, attackStyle: 'ram' },
    scout: { energy: 14, price: 140, speed: 5.4, atk: 1, attackRange: 0.1, visionRange: 1.8, atkCd: 1.6, astarCost: 10, color: '#9cf', r: 5.5, vis: 'triangle', isFlying: true, attackStyle: 'swoop' },
    ...RESOURCE_COLLECTOR_UNIT_STATS,
    salvager_unit: { energy: 20, price: 20, speed: 1.8, atk: 0, attackRange: 0, visionRange: 0.6, atkCd: 49.95, astarCost: 10, transferCooldown: 2.0, workerSearchDistance: 2.0, color: '#765', r: 6, vis: 'triangle_down', isWorker: true },
    builder_unit: { energy: 25, price: 18, speed: 1.9, atk: 0, attackRange: 0, visionRange: 0.6, atkCd: 49.95, astarCost: 10, builderDps: 25, transferCooldown: 2.0, workerSearchDistance: 2.0, color: '#8b5', r: 6, vis: 'rect', isWorker: true },
    healer_unit: { energy: 25, price: 18, speed: 1.9, atk: 0, attackRange: 0, visionRange: 0.6, atkCd: 49.95, astarCost: 10, healerDps: 5, transferCooldown: 2.0, workerSearchDistance: 2.0, color: '#fff', r: 6, collisionR: 3, vis: 'triangle', isWorker: true, isFlying: true },
    researcher_unit: { energy: 25, price: 18, speed: 1.9, atk: 0, attackRange: 0, visionRange: 0.6, atkCd: 49.95, astarCost: 10, researcherDps: 15, transferCooldown: 2.0, workerSearchDistance: 2.0, color: '#6af', r: 6, collisionR: 3, vis: 'triangle', isWorker: true, isFlying: true },
    king: { energy: 250, price: 1000, speed: 1.8, atk: 12, attackRange: 0.1, visionRange: 1.0, atkCd: 2.0, astarCost: 10, color: '#ffd700', r: 12, vis: 'king', attackStyle: 'melee' },
};

const UNIT_LEVEL_SCALING = {
    _default: { energyExp: 1.22, dmgExp: 1.16, speedExp: 1.03, speedCapMul: 1.8, cdExp: 0.985, minCd: 0.4, visionExp: 1.04, visionCapBonus: 2.4 },
    boss: { energyExp: 1.36, dmgExp: 1.14, speedExp: 1.015, speedCapAbs: 2.6, cdExp: 0.99, minCd: 0.9, visionExp: 1.03, visionCapBonus: 2.0 },
    flying: { energyExp: 1.12, dmgExp: 1.12, speedExp: 1.06, speedCapAbs: 6.2, cdExp: 0.98, minCd: 0.5, visionExp: 1.06, visionCapBonus: 3.6 },
    snake: { energyExp: 1.24, dmgExp: 1.14, speedExp: 1.03, speedCapAbs: 4.8, cdExp: 0.985, minCd: 0.7, visionExp: 1.04, visionCapBonus: 2.6 },
    tank: { energyExp: 1.25, dmgExp: 1.15, speedExp: 1.02, speedCapAbs: 3.2, cdExp: 0.985, minCd: 0.6, visionExp: 1.04, visionCapBonus: 2.0 },
    scout: { energyExp: 1.1, dmgExp: 1.05, speedExp: 1.04, speedCapAbs: 7.4, cdExp: 0.99, minCd: 0.6, visionExp: 1.08, visionCapBonus: 6.4 },
    ...RESOURCE_COLLECTOR_UNIT_SCALING,
    salvager_unit: { energyExp: 1.14, dmgExp: 1.0, speedExp: 1.045, speedCapAbs: 4.6, cdExp: 1.0, minCd: 49.95, visionExp: 1.03, visionCapBonus: 1.6 },
    builder_unit: { energyExp: 1.16, dmgExp: 1.0, speedExp: 1.05, speedCapAbs: 4.7, cdExp: 1.0, minCd: 49.95, visionExp: 1.03, visionCapBonus: 1.6 },
    healer_unit: { energyExp: 1.16, dmgExp: 1.0, speedExp: 1.05, speedCapAbs: 4.7, cdExp: 1.0, minCd: 49.95, visionExp: 1.03, visionCapBonus: 1.6 },
    researcher_unit: { energyExp: 1.16, dmgExp: 1.0, speedExp: 1.05, speedCapAbs: 4.7, cdExp: 1.0, minCd: 49.95, visionExp: 1.03, visionCapBonus: 1.6 },
    king: { energyExp: 1.2, dmgExp: 1.12, speedExp: 1.025, speedCapAbs: 3.2, cdExp: 0.99, minCd: 0.6, visionExp: 1.04, visionCapBonus: 2.4 },
};

let RESEARCH_COST_EXP = 3;
let RESEARCH_WORK_EXP = 3;
let RESEARCH_WORK_BASE = 110;
let RESEARCH_BONUS_EXP_UNITS = 2.0;
let RESEARCH_BONUS_EXP_OTHER = 1.25;
let RESEARCH_BONUS_EXP_OTHER_HOUSE_POPCAP = 1.5;

let MAX_THING_LEVEL = 20;
let MAX_RESEARCH_LEVEL = 10;

const RESEARCH_DECREASE_STATS = { cd: true, atkCd: true, transferCooldown: true, astarCost: true, baseTime: true, spawnCd: true };
const RESEARCH_STAT_LABELS = {
    maxEnergy: 'Max Energy',
    popCap: 'Pop Cap',
    damage: 'Damage',
    blastDamage: 'Blast Damage',
    blastRadius: 'Blast Radius',
    cd: 'Cooldown',
    spawnCd: 'Spawn CD',
    visionRange: 'Vision',
    multiplier: 'Multiplier',
    burnDps: 'Burn DPS',
    burnDuration: 'Burn Duration',
    poisonDps: 'Poison DPS',
    poisonDuration: 'Poison Duration',
    freezeDps: 'Freeze DPS',
    freezeDuration: 'Freeze Duration',
    wetDuration: 'Wet Duration',
    sandDuration: 'Slow Duration',
    watchDuration: 'Watch Duration',
    efficiency: 'Efficiency',
    energy: 'Energy',
    speed: 'Speed',
    atk: 'Attack',
    attackRange: 'Range',
    atkCd: 'Atk Cooldown',
    astarCost: 'A* / Tile',
    transferCooldown: 'Cooldown',
    workerSearchDistance: 'Work Distance',
    gatherPerTrip: 'Gather Speed',
    builderDps: 'Build Speed',
    healerDps: 'Heal Speed',
    researcherDps: 'Research Speed',
    unitPrice: 'Unit Energy'
};

const RESEARCHABLE_UNIT_STATS = {
    _default: ['energy', 'speed', 'atk', 'attackRange', 'visionRange', 'atkCd', 'astarCost'],
    ...RESOURCE_COLLECTOR_RESEARCHABLE_STATS,
    salvager_unit: ['energy', 'speed', 'visionRange', 'workerSearchDistance', 'transferCooldown', 'astarCost'],
    builder_unit: ['energy', 'speed', 'visionRange', 'workerSearchDistance', 'builderDps', 'transferCooldown', 'astarCost'],
    healer_unit: ['energy', 'speed', 'visionRange', 'workerSearchDistance', 'healerDps', 'transferCooldown', 'astarCost'],
    researcher_unit: ['energy', 'speed', 'visionRange', 'workerSearchDistance', 'researcherDps', 'transferCooldown', 'astarCost'],
    king: ['energy', 'speed', 'atk', 'attackRange', 'visionRange', 'atkCd', 'astarCost']
};

const PRECOMPUTED_UNIT_STAT_KEYS = ['energy', 'atk', 'atkCd', 'speed', 'visionRange', 'attackRange', 'workerSearchDistance', 'gatherPerTrip', 'builderDps', 'healerDps', 'researcherDps', 'transferCooldown', 'astarCost'];
const PRECOMPUTED_BUILDING_STAT_KEYS = ['maxEnergy', 'popCap', 'damage', 'blastDamage', 'blastRadius', 'cd', 'spawnCd', 'unitPrice', 'visionRange', 'multiplier', 'burnDps', 'burnDuration', 'poisonDps', 'poisonDuration', 'freezeDps', 'freezeDuration', 'wetDuration', 'sandDuration', 'watchDuration', 'efficiency'];

function getSpawnedUnitTypeForBuildingKey(key) {
    if (!key) return null;
    if (key.startsWith('barrack_')) return (BASE_CARD_TYPES[key] || {}).unitType || 'norm';
    let resourceCollectorBuilding = getResourceTypeByCollectorBuilding(key);
    if (resourceCollectorBuilding) return resourceCollectorBuilding.collectorUnitKey;
    if (key === 'salvager') return 'salvager_unit';
    if (key === 'builder_spawner') return 'builder_unit';
    if (key === 'healer_spawner') return 'healer_unit';
    if (key === 'research') return 'researcher_unit';
    return null;
}

// Soft caps for precomputed stats. Infinity means "no soft cap".
const PRECOMPUTED_SOFT_CAP_MAP = {
    unit: {
        energy: Infinity,
        atk: Infinity,
        atkCd: 0.025,
        speed: ({ baseAtLevel1 }) => {
            let baseSpeed = Number(baseAtLevel1 && baseAtLevel1.speed);
            if (!Number.isFinite(baseSpeed) || baseSpeed <= 0) return 8.5;
            return Math.min(baseSpeed * 3, 8 + baseSpeed / 10);
        },
        visionRange: ({ baseAtLevel1 }) => {
            let baseVision = Number(baseAtLevel1 && baseAtLevel1.visionRange);
            return (Number.isFinite(baseVision) && baseVision > 0) ? (baseVision * 4) : 20;
        },
        attackRange: ({ baseAtLevel1 }) => {
            let baseRange = Number(baseAtLevel1 && baseAtLevel1.attackRange);
            return (Number.isFinite(baseRange) && baseRange > 0) ? (baseRange * 4) : 14;
        },
        gatherPerTrip: Infinity,
        builderDps: Infinity,
        healerDps: Infinity,
        researcherDps: Infinity,
        transferCooldown: 0.3,
        workerSearchDistance: 5,
        // Keep unit A* / tile fully driven by level/research precompute output.
        // A hard soft-cap here can flatten level growth when decreasing research is also applied.
        astarCost: Infinity,
    },
    building: {
        maxEnergy: Infinity,
        popCap: ({ key }) => key === 'house' ? getConfiguredMaxPop() : Infinity,
        damage: Infinity,
        cd: ({ baseAtLevel1 }) => {
            let baseCd = Number(baseAtLevel1 && baseAtLevel1.cd);
            if (!Number.isFinite(baseCd) || baseCd <= 0) return 0.5;
            return Math.log(baseCd) / Math.log(3);
        },
        spawnCd: ({ baseAtLevel1 }) => {
            let baseSpawnCd = Number(baseAtLevel1 && baseAtLevel1.spawnCd);
            if (!Number.isFinite(baseSpawnCd) || baseSpawnCd <= 0) return 0.5;
            return Math.log(baseSpawnCd) / Math.log(15);
        },
        visionRange: ({ baseAtLevel1 }) => {
            let baseVision = Number(baseAtLevel1 && baseAtLevel1.visionRange);
            return (Number.isFinite(baseVision) && baseVision > 0) ? (baseVision * 3) : 32;
        },
        multiplier: ({ key }) => (key === 'farm' || key === 'astar_farm') ? 10 : Infinity,
        efficiency: 3,
    }
};

let PRECOMPUTED_STATS_MAP = { unit: {}, building: {} };
let PRECOMPUTED_STATS_READY = false;

// Spatial hash (10x10 tile chunks)
const CHUNK_SIZE = 1;
let CHUNKS_W = Math.ceil(GRID_W / CHUNK_SIZE);
let CHUNKS_H = Math.ceil(GRID_H / CHUNK_SIZE);
let spatialUnits = []; // flat array of Sets
let spatialUnitsComplex = new Int32Array(0); // [chunk][player][total + perUnitType...]
let spatialUnitTypeToIndex = Object.create(null);
let spatialNormUnitTypeIndex = 0;
let spatialUnitsComplexUnitTypeCount = 0;
let spatialUnitsComplexPlayerCount = 0;
let spatialUnitsComplexStridePerPlayer = 0;
let spatialUnitsComplexStridePerChunk = 0;
let spatialUnitsComplexMaxUnitVisOffset = -1;
let spatialUnitsComplexMaxThingVisOffset = -1;
const SPATIAL_VISIBILITY_SCALE = 100;
const ENABLE_SPATIAL_LOWEST_HEALTH_CACHE = false;
let spatialUnitsComplexLowestHealthUnit = []; // [chunk][player] => lowest damaged living unit
const CLOSEST_ENEMY_CHUNK_CACHE_MAX = 12000;
let closestEnemyChunkQueryCache = new Map();

// ============================================================
// A* PATHFINDING
// ============================================================
let pathfindBudget = 0; // fallback budget for non-player-owned path requests
let MAX_PATHS_PER_TICK = 30;
const MIN_PATHS_PER_TICK = 12;
const MAX_PATHS_PER_TICK_HARD = 64;
let pendingPathResolveCursor = 0;
let pathTopologyVersion = 1;
const PATH_CACHE_TTL_TICKS = 24;
const PATH_CACHE_MAX_ENTRIES = 3000;
const PATH_CACHE_TRIM_CHUNK = 96;
const PARTIAL_PATH_CACHE_TTL_TICKS = 36;
const PARTIAL_PATH_CACHE_MAX_ENTRIES = 2000;
const SPAWNER_ROUTE_CACHE_TTL_TICKS = 10;
const SPAWNER_ROUTE_CACHE_MAX_ENTRIES = 800;
const SPAWNER_RALLY_TEMPLATE_TTL_TICKS = 20;
const SPAWNER_RALLY_TEMPLATE_MAX_ENTRIES = 1000;
const ASTAR_MAX_ITERS_BASE = 2048;
const ASTAR_MAX_ITERS_HARD = 18000;
const ASTAR_NODE_BUDGET_PER_PATH = 360;
const ASTAR_NODE_BUDGET_MIN_PER_TICK = 2400;
const ASTAR_NODE_BUDGET_MAX_PER_TICK = 22000;
let astarNodeBudgetPerTick = 9000; // fallback for non-player-owned path requests
let astarNodeBudgetRemaining = 9000; // fallback for non-player-owned path requests
let pathfindBudgetByPlayer = new Int32Array(0);
let astarNodeBudgetPerTickByPlayer = new Int32Array(0);
let astarNodeBudgetRemainingByPlayer = new Int32Array(0);
let sharedPathCache = new Map();
let sharedPartialPathCache = new Map();
let sharedSpawnerRouteCache = new Map();
let sharedSpawnerRallyTemplateCache = new Map();

const PATH_SOURCE_UNSPECIFIED = 'unspecified';
let _activePathfindSource = PATH_SOURCE_UNSPECIFIED;
let _activePathfindUnitId = null;
let _activePathfindUnitType = '';
let _activePathfindOwner = -1;
let _lastPathfindAbortedByBudget = false;
let _pathfindPerfTick = null;
let _pathfindPerfHistory = [];
const PATHFIND_PERF_HISTORY_MAX = 480;