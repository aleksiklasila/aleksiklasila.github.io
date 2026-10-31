
"use strict";

// ============================================================
// CONFIG
// ============================================================
let MINIMAP_SIZE = 160;
let TILE = 32;
let GRID_W = 128, GRID_H = 128;
let WORLD_W = GRID_W * TILE, WORLD_H = GRID_H * TILE;

// Gold mine config (adjustable from menu)
let RESOURCE_MINE_DENSITY = 30; // combined target coverage of map tiles, in percent
let GOLD_MINE_COUNT = 18;  // total mine tiles distributed across veins
let GOLD_MINE_MIN = 500;
let GOLD_MINE_MAX = 1500;
let GOLD_MINE_AREA = 70;   // area within which mines spawn (centered)
let ASTAR_MINE_COUNT = 12;
let ASTAR_MINE_MIN = 500;
let ASTAR_MINE_MAX = 1500;
let STARTING_MONEY = 2000;
let STARTING_ASTAR = 9000;
// Shrines (menu, Resources): damage a player's units and buildings take
// goes to the player's shrine (resource 💀), drained passively into energy
// and ★ (see shrineTick). Off: it still counts damage taken, but cannot be
// drained (no drain buttons, no shrine research).
let SHRINES_ENABLED = true;
let MAP_TYPE = 'islands';
let TYPE_FLOOR = 0, TYPE_WALL = 1;
let CONFIG_MAX_POP = 131072;
// Structures a player may hold at once (towers, buildings, floor items, sites):
// 0, the menu's: what the memory budget leaves for the population
// (memoryBudgetBuildings); a number given (an editable config, a fixture):
// that many, no more than the structure pool holds for each player
// (data_state.js structMemoryLimitPerPlayer).
let CONFIG_MAX_BUILDINGS = 0;

// ---- The match's memory budget ----
// One budget, wasm32's 4 GiB heap, allocated at the match's start. The
// population per player is the setting (a power of two, the menu's one
// dropdown); the rest follows: its units' slots (MEMORY_UNIT_BYTES each:
// columns, side records, index and kernel lists), the map's tile tables
// (MEMORY_TILE_BYTES a tile), the rest of the simulation (MEMORY_BASE_BYTES);
// of what is left half goes to structures (MEMORY_STRUCT_BYTES each: row
// and wasm side, measured 2026-10-29: ~260 + ~1000), the other half is
// headroom (projectiles, paths, scratch). The building limit per player is
// the largest power of two that fits, no more than the map's tiles allow.
// Integers only: every peer derives the same limits.
const MEMORY_BUDGET_BYTES = 4 * 1024 * 1024 * 1024, MEMORY_BASE_BYTES = 256 * 1024 * 1024, MEMORY_TILE_BYTES = 400;
const MEMORY_UNIT_BYTES = 900, MEMORY_STRUCT_BYTES = 1300;
// (No map holds more units than this many a tile, nor more structures than
// tiles: the slots and rows reserved stop there whatever the settings,
// sim_unit_state.js simUnitPopulationSlots.)
const MEMORY_UNITS_PER_TILE = 8;
// (The units a population reserves slots for: the teams', at most the map's.)
function memoryBudgetUnits(pop, teams, tiles) { return Math.min(Math.max(0, Math.floor(pop) || 0) * Math.max(1, Math.floor(teams) || 1), Math.max(1, Math.floor(tiles) || 1) * MEMORY_UNITS_PER_TILE); }
// The menu's population limits: 2^3 to 2^22 per player (those that fit).
const POP_LIMIT_POW_MIN = 3, POP_LIMIT_POW_MAX = 22;
// (The largest power of two at most n, 0 for n < 1.)
function _pow2Floor(n) { if (!(n >= 1)) return 0; let p = 1; while (p * 2 <= n) p *= 2; return p; }
// Structures per player the budget holds beside `pop` units per player
// (0: that population does not fit).
function memoryBudgetBuildings(pop, teams, tiles) {
    teams = Math.max(1, Math.floor(teams) || 1); tiles = Math.max(1, Math.floor(tiles) || 1);
    const free = MEMORY_BUDGET_BYTES - MEMORY_BASE_BYTES - tiles * MEMORY_TILE_BYTES - memoryBudgetUnits(pop, teams, tiles) * MEMORY_UNIT_BYTES;
    if (free <= 0) return 0;
    return _pow2Floor(Math.min(Math.floor(free / 2 / (teams * MEMORY_STRUCT_BYTES)), Math.floor(tiles / teams)));
}
// The menu's choices for a map and team count: [{ pop, buildings }], the
// populations that leave at least 64 structures a player, up to the first
// the map's units-per-tile cap reaches (a larger one reserves no more).
function popLimitOptions(teams, tiles) {
    const out = [];
    for (let k = POP_LIMIT_POW_MIN; k <= POP_LIMIT_POW_MAX; k++) {
        const pop = 2 ** k, buildings = memoryBudgetBuildings(pop, teams, tiles);
        if (buildings >= 64) out.push({ pop, buildings });
        if (pop * Math.max(1, teams) >= tiles * MEMORY_UNITS_PER_TILE) break;
    }
    return out;
}
// The population the budget holds at most (the menu's choice, halved until
// it leaves 64 structures a player on this map with these teams): applied at
// the match's start, so its slots are all reserved then, nothing grows in play.
function memoryBudgetPop(pop, teams, tiles) {
    let p = Math.max(1, Math.floor(pop) || 1);
    while (p > 8 && memoryBudgetBuildings(p, teams, tiles) < 64) p = Math.floor(p / 2);
    return p;
}
// The match's building limit per player (the menu's 0: the budget's).
function configuredMaxBuildings(teams, tiles) {
    const cfg = Math.floor(Number(CONFIG_MAX_BUILDINGS) || 0);
    return cfg > 0 ? cfg : memoryBudgetBuildings(CONFIG_MAX_POP, teams, tiles);
}
let TICK_RATE = 20; // ticks per second (menu configurable)
let TICK_MS = 1000 / TICK_RATE;
// A tier below the tick: a unit's stacks and effective level once a second.
let UNIT_EFFECTIVE_STATS_RECALC_TICKS = 20;
// (A guard behind the stat table version: every thing every 10 seconds.)
let THING_STATS_RECALC_INTERVAL_SECONDS = 10;
let UNIT_COLLISION_RECALC_TICKS = 5;
// Extra center-to-center spacing used only between units owned by different players.
let CROSS_TEAM_UNIT_COLLISION_PADDING = TILE * 0.5;
let ASTAR_MAX_ITERS_LIMIT = 18000;
let ASTAR_ITER_BUDGET_PER_PLAYER_TICK = 9000;
let WORKER_AI_TICK_DELAY = 3;
let INPUT_DELAY = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 2 : 0; // desktop: immediate lockstep input, touch: small safety buffer
let LOCKSTEP_PIPELINE_MIN = 2;
let LOCKSTEP_PIPELINE_TICKS = Math.max(INPUT_DELAY, LOCKSTEP_PIPELINE_MIN); // keep only a few ticks in flight to avoid strict-lockstep starvation

function getLockstepResendRequestMs() {
    let pipelineTicks = Math.max(1, Math.floor(Number(LOCKSTEP_PIPELINE_TICKS) || 0));
    return Math.max(60, Math.floor(TICK_MS * pipelineTicks));
}

function getLockstepHardResyncMs() {
    let pipelineTicks = Math.max(1, Math.floor(Number(LOCKSTEP_PIPELINE_TICKS) || 0));
    return Math.max(120, Math.floor(TICK_MS * Math.max(2, pipelineTicks * 2)));
}

function getLockstepPostSnapshotGraceMs() {
    let pipelineTicks = Math.max(1, Math.floor(Number(LOCKSTEP_PIPELINE_TICKS) || 0));
    return Math.max(50, Math.floor(TICK_MS * Math.max(2, pipelineTicks)));
}

let LOCKSTEP_PACKET_RESEND_MS = Math.max(40, Math.floor(TICK_MS * 2));
let LOCKSTEP_BUNDLE_RESEND_MS = Math.max(40, Math.floor(TICK_MS * 2));
let LOCKSTEP_RESEND_REQUEST_MS = getLockstepResendRequestMs();
let LOCKSTEP_HARD_RESYNC_MS = getLockstepHardResyncMs();
let LOCKSTEP_STATE_CHECK_INTERVAL = 10;
// Full per-entity digests travel with every state hash only in exact-lockstep
// debug mode; normal matches send per-subsystem hashes, which are enough to
// tell which part of the state diverged.
let LOCKSTEP_DEBUG_HASH_DETAILS = false;
// Ticks the host seals ahead of its own clock. Guests' commands arrive early
// enough on their own; a small window gives them jitter headroom without
// delaying the host's commands.
let LOCKSTEP_HOST_PREBUILD_TICKS = 1;
// Sealed ticks the host keeps for resends and reconnecting guests.
function getLockstepHistoryKeepTicks() {
    return Math.max(600, Math.floor(TICK_RATE * 90));
}
let tickAlpha = 0; // 0..1 interpolation between ticks for smooth rendering
// The step's deltatick: how many base ticks (TICK_MS of game time each) the
// simulation step being run covers. gameTime counts base ticks and moves on
// by it; currentTick counts steps (commands are keyed by step). Every peer
// runs the same step sizes: the host seals each step's into its bundle
// (maybeBuildHostBundle, bundle.dk), from the match's shared pace, so a
// match whose slowest machine manages 2 steps a second plays at 10 base
// ticks a step and keeps game time at wall time. Rates (speed, damage over
// time, cooldowns, production) are applied for the step's base ticks at
// once: approximately per base tick, fair over time.
let simDk = 1;
// (At most a second a step: per-second work (upkeep, the stats' second)
// then comes at most once a step.)
const SIM_DK_MAX = 20;
// The step size for a step interval of `ms` (the shared pace): whole base
// ticks, rounded up from just above (a pace of 70 ms is 2 base ticks: the
// match stays at wall time instead of a step of 1 every 70 ms).
function simStepTicksForMs(ms) {
    const k = Math.ceil((Number(ms) || 0) / TICK_MS - 0.1);
    return k > 1 ? Math.min(SIM_DK_MAX, k) : 1;
}
// Whether a periodic event of period `period` (base ticks) at phase
// `phase` falls in the step just begun (gameTime - simDk, gameTime]: at one
// base tick a step, (gameTime + phase) % period === 0.
function simStepCrosses(phase, period) {
    if (!(period > 1)) return true;
    const r = (gameTime + phase) % period;
    return (r < 0 ? r + period : r) < simDk;
}
// The phases (base tick % period) of the base ticks the step covers, in
// their order, one period's at most (each once): a sweep of a slice a base
// tick visits all of them (at one base tick a step: [gameTime % period]).
function simStepPhases(period) {
    const n = Math.max(1, Math.min(simDk, period)), out = new Array(n);
    for (let i = 0; i < n; i++) { const b = gameTime - n + 1 + i; out[i] = ((b % period) + period) % period; }
    return out;
}

function secondsToTicks(seconds) {
    let sec = Math.max(0, Number(seconds) || 0);
    return Math.max(1, Math.round(sec * TICK_RATE));
}

const C_BG = '#111', C_WALL = '#3a3a3a', C_FLOOR = '#161616';

const PLAYER_COLORS = ['#4488ff', '#ff4444'];
const PLAYER_COLORS_DIM = ['rgba(68,136,255,0.3)', 'rgba(255,68,68,0.3)'];

const AREA_UNIT_TILE_EQUIVALENT = 5;
// Area distances are whole steps (small ints): 0 its own area, 1 its own and the areas next to it, and so on. The data's
// factors give fractions; the tables keep the whole part (0.2 -> 0a, 1.2 -> 1a). AREA_STEPS_MAX fits an int8.
const AREA_STEPS_MAX = 63;
function areaSteps(v) { v = Number(v); return v > 0 ? Math.min(AREA_STEPS_MAX, Math.floor(v + 1e-9)) : 0; }
// The tile reach used by the per-tile searches for a vision of k steps (0a: 3 tiles, 1a: 5, 2a: 10, ...).
function areaStepsVisionTiles(k) { return Math.max(0.6, k) * AREA_UNIT_TILE_EQUIVALENT; }

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
        collectorBuildingKey: 'spawner',
        collectorUnitKey: 'collector',
        dropoffSound: 'gold_collected',
        carryGlyph: '⚡',
        emptyCarryGlyph: '⚡',
        supportsDropTarget: true,
    },
    astar: {
        key: 'astar',
        label: '★',
        stockpileKey: 'astar',
        icon: '★',
        color: '#9aa',
        mineArrayKey: 'astarMines',
        mineStatKey: 'astar',
        mineTileType: 'astar_mine',
        farmKey: 'astar_farm',
        collectorBuildingKey: 'astar_spawner',
        collectorUnitKey: 'astar_collector',
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

// One authored definition per thing. Units first, then buildings.
// Stat: base; level {factor^(level-1), linear, add, power, round, min/max};
// researchable controls both the research menu and bonuses. research.factor is per research level.
// softCap: null = unbounded; number = endpoint at maximum level/research (log interpolation);
// {model:'populationLimit'} follows the map population setting. min/max are optional hard limits.
// from references another thing's stat; its level rule is used unless an explicit rule replaces it.
const THING_STATS = {
    norm: { kind: "unit", color: "#fff", vis: "circle", attackStyle: "melee", name: "Norm", description: "Basic infantry. Balanced stats, cheap to produce.", strength: "Affordable frontline damage", weakness: "Melee reach and ordinary mobility",
        stats: {
            energy: {base: 40, level: {factor: 1.22, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 5, level: {factor: 1.16, round: "round", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 1.5, level: {factor: 0.985, min: 0.4}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.025, min: 0.01},
            speed: {base: 2.6, level: {factor: 1.03, max: 4.680000000000001}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 7.800000000000001, min: 0.1},
            visionRange: {base: 0.6, level: {factor: 1.04, max: 3}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 2.4},
            attackRange: {base: 1, level: {factor: 1.04, max: 3.4}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 1, min: 0},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: null, level: {}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0},
            astarCost: {base: 10, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 0.4, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 400, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 8, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 40, level: {factor: 0.9, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    fast: { kind: "unit", color: "#eee", vis: "circle", attackStyle: "melee", name: "Fast", description: "Fast mounted raider. Low Energy but high speed.", strength: "Fast worker raider with high close-range damage", weakness: "Low health and melee reach",
        stats: {
            energy: {base: 20, level: {factor: 1.22, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 4, level: {factor: 1.16, round: "round", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 1, level: {factor: 0.985, min: 0.4}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.025, min: 0.01},
            speed: {base: 4.8, level: {factor: 1.03, max: 8.64}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 8.48, min: 0.1},
            visionRange: {base: 0.6, level: {factor: 1.04, max: 3}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 2.4},
            attackRange: {base: 1, level: {factor: 1.04, max: 3.4}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 1, min: 0},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: null, level: {}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0},
            astarCost: {base: 6, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 0.3, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 200, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 6, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 20, level: {factor: 0.9, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    tank: { kind: "unit", color: "#555", vis: "circle", attackStyle: "melee", name: "Tank", description: "Heavy infantry. High Energy and damage, slow.", strength: "Durable frontline anchor", weakness: "Slow, short reach and low damage for its cost",
        stats: {
            energy: {base: 200, level: {factor: 1.25, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 8, level: {factor: 1.15, round: "round", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 2.25, level: {factor: 0.985, min: 0.6}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.025, min: 0.01},
            speed: {base: 1.4, level: {factor: 1.02, max: 3.2}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 4.199999999999999, min: 0.1},
            visionRange: {base: 0.6, level: {factor: 1.04, max: 2.6}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 2.4},
            attackRange: {base: 1, level: {factor: 1.04, max: 3}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 1, min: 0},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: null, level: {}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0},
            astarCost: {base: 16, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 0.7, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 800, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 10, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 80, level: {factor: 0.92, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    boss: { kind: "unit", color: "#222", vis: "circle", attackStyle: "melee", name: "Boss", description: "Super-heavy unit. Extremely tough and powerful.", strength: "Heavy frontline health and damage", weakness: "Very slow, costly and slow to train",
        stats: {
            energy: {base: 400, level: {factor: 1.28, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 20, level: {factor: 1.14, round: "round", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 3, level: {factor: 0.99, min: 0.9}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.05, min: 0.01},
            speed: {base: 1.2, level: {factor: 1.015, max: 2.6}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 3.5999999999999996, min: 0.1},
            visionRange: {base: 0.8, level: {factor: 1.03, max: 2.8}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 3.2},
            attackRange: {base: 1, level: {factor: 1.03, max: 3}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 1, min: 0},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: null, level: {}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0},
            astarCost: {base: 23, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 2, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 4000, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 12, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 400, level: {factor: 0.94, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    flying: { kind: "unit", color: "#dd0", vis: "triangle", isFlying: true, attackStyle: "swoop", name: "Flying", description: "Winged lancer. Flies over walls and swoops onto targets.", strength: "Flies over buildings to raid workers", weakness: "Low health and slower attacks than melee",
        stats: {
            energy: {base: 36, level: {factor: 1.12, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 4, level: {factor: 1.12, round: "round", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 2.25, level: {factor: 0.98, min: 0.5}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.06, min: 0.01},
            speed: {base: 3, level: {factor: 1.06, max: 6.2}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 8.3, min: 0.1},
            visionRange: {base: 1, level: {factor: 1.06, max: 4.6}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 4},
            attackRange: {base: 1, level: {factor: 1.06, max: 4.6}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 4, min: 0},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: null, level: {}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0},
            astarCost: {base: 12, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 0.45, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 450, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 7, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 45, level: {factor: 0.91, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    mole: { kind: "unit", color: "#543", vis: "mole", turretImmune: true, name: "Mole", description: "Stealth unit. Immune to tower fire, very fragile.", strength: "Turret immunity enables attacks on defenses", weakness: "Very low health; ground hazards and melee defenders counter it",
        stats: {
            energy: {base: 10, level: {factor: 1.22, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 2, level: {factor: 1.16, round: "round", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 1.25, level: {factor: 0.985, min: 0.4}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.025, min: 0.01},
            speed: {base: 2, level: {factor: 1.03, max: 3.6}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 6, min: 0.1},
            visionRange: {base: 0.8, level: {factor: 1.04, max: 3.2}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 3.2},
            attackRange: {base: 1, level: {factor: 1.04, max: 3.4}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 1, min: 0},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: null, level: {}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0},
            astarCost: {base: 0.05, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 0.05, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 100, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 7.5, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 10, level: {factor: 0.88, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    poison_resistant: { kind: "unit", color: "#2d2", vis: "circle", poisonResistant: true, attackStyle: "poison", name: "Poison Resistant", description: "Poison-immune. Attacks with toxic clouds.", strength: "Poison immunity and ranged pressure", weakness: "Moderate health, speed and slow attacks",
        stats: {
            energy: {base: 50, level: {factor: 1.22, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 6, level: {factor: 1.16, round: "round", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 2.25, level: {factor: 0.985, min: 0.4}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.06, min: 0.01},
            speed: {base: 2.4, level: {factor: 1.03, max: 4.32}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 7.199999999999999, min: 0.1},
            visionRange: {base: 0.8, level: {factor: 1.04, max: 3.2}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 3.2},
            attackRange: {base: 1, level: {factor: 1.04, max: 3.4}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 4.5, min: 0},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: null, level: {}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0},
            astarCost: {base: 11, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 0.5, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 600, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 9, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 60, level: {factor: 0.92, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    fire_resistant: { kind: "unit", color: "#f50", vis: "circle", fireResistant: true, attackStyle: "fire", name: "Fire Resistant", description: "Fire-immune. Attacks with flame bursts.", strength: "Fire immunity and sturdy mid-range pressure", weakness: "Slow movement and shorter reach than ranged specialists",
        stats: {
            energy: {base: 70, level: {factor: 1.22, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 7, level: {factor: 1.16, round: "round", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 2, level: {factor: 0.985, min: 0.4}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.045, min: 0.01},
            speed: {base: 2, level: {factor: 1.03, max: 3.6}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 6, min: 0.1},
            visionRange: {base: 0.8, level: {factor: 1.04, max: 3.2}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 3.2},
            attackRange: {base: 1, level: {factor: 1.04, max: 3.4}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 3, min: 0},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: null, level: {}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0},
            astarCost: {base: 13, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 0.55, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 700, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 10, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 70, level: {factor: 0.92, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    water_resistant: { kind: "unit", color: "#4af", vis: "circle", waterResistant: true, attackStyle: "water", name: "Water Resistant", description: "Water-immune. Attacks with water jets.", strength: "Water immunity, speed and long reach", weakness: "Low health and slow attacks",
        stats: {
            energy: {base: 40, level: {factor: 1.22, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 5, level: {factor: 1.16, round: "round", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 2.25, level: {factor: 0.985, min: 0.4}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.075, min: 0.01},
            speed: {base: 3.2, level: {factor: 1.03, max: 5.760000000000001}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 8.32, min: 0.1},
            visionRange: {base: 1, level: {factor: 1.04, max: 3.4}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 4},
            attackRange: {base: 1, level: {factor: 1.04, max: 3.4}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 5, min: 0},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: null, level: {}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0},
            astarCost: {base: 8, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 0.4, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 500, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 8, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 50, level: {factor: 0.91, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    ice_resistant: { kind: "unit", color: "#afe", vis: "circle", iceResistant: true, attackStyle: "ice", name: "Ice Resistant", description: "Ice-immune. Attacks with frost shards.", strength: "Ice immunity and reliable mid-range damage", weakness: "Slow movement and limited reach",
        stats: {
            energy: {base: 65, level: {factor: 1.22, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 6, level: {factor: 1.16, round: "round", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 1.75, level: {factor: 0.985, min: 0.4}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.045, min: 0.01},
            speed: {base: 2.2, level: {factor: 1.03, max: 3.9600000000000004}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 6.6000000000000005, min: 0.1},
            visionRange: {base: 0.8, level: {factor: 1.04, max: 3.2}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 3.2},
            attackRange: {base: 1, level: {factor: 1.04, max: 3.4}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 3.5, min: 0},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: null, level: {}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0},
            astarCost: {base: 12, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 0.5, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 650, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 9, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 65, level: {factor: 0.92, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    laser_resistant: { kind: "unit", color: "#d0f", vis: "circle", laserResistant: true, attackStyle: "laser", name: "Laser Resistant", description: "Laser-immune. Shoots laser beams from range.", strength: "Laser immunity and long reach", weakness: "Low health, slow attacks and modest speed",
        stats: {
            energy: {base: 32, level: {factor: 1.22, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 5, level: {factor: 1.16, round: "round", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 2.75, level: {factor: 0.985, min: 0.4}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.075, min: 0.01},
            speed: {base: 2.3, level: {factor: 1.03, max: 4.14}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 6.8999999999999995, min: 0.1},
            visionRange: {base: 0.8, level: {factor: 1.04, max: 3.2}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 3.2},
            attackRange: {base: 1, level: {factor: 1.04, max: 3.4}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 5, min: 0},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: null, level: {}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0},
            astarCost: {base: 11, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 0.6, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 550, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 9, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 55, level: {factor: 0.92, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    snake: { kind: "unit", color: "#0f0", vis: "snake", isSnake: true, attackStyle: "ram", name: "Snake", description: "Massive serpent. Rams targets, takes self-damage.", strength: "Durable charging melee attacker", weakness: "Very expensive, slow to train and cannot retaliate at range",
        stats: {
            energy: {base: 800, level: {factor: 1.24, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 15, level: {factor: 1.14, round: "round", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 1.5, level: {factor: 0.985, min: 0.7}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.025, min: 0.01},
            speed: {base: 1.8, level: {factor: 1.03, max: 4.8}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 5.4, min: 0.1},
            visionRange: {base: 0.8, level: {factor: 1.04, max: 3.4000000000000004}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 3.2},
            attackRange: {base: 1, level: {factor: 1.04, max: 3.6}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 1, min: 0},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: null, level: {}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0},
            astarCost: {base: 28, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 2.5, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 8000, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 7, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            collisionR: {base: 9, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            snakeMaxHistory: {base: 20, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 800, level: {factor: 0.95, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    scout: { kind: "unit", color: "#9cf", vis: "triangle", isFlying: true, attackStyle: "swoop", name: "Scout", description: "Fast flying recon. Very high vision, low Energy, low attack. Attacks reveal targets to its team and it patrols random points continuously.", strength: "Fast flying scout with the longest unit reach and Watch", weakness: "Very low health and damage",
        stats: {
            energy: {base: 14, level: {factor: 1.1, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 1, level: {factor: 1.05, round: "round", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 1.6, level: {factor: 0.99, min: 0.6}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.1, min: 0.01},
            speed: {base: 5.4, level: {factor: 1.04, max: 7.4}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 8.54, min: 0.1},
            visionRange: {base: 1.35, level: {factor: 1.08, max: 7.75}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 5.4},
            attackRange: {base: 1, level: {factor: 1.08, max: 7.4}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 6, min: 0},
            watchDuration: {base: 5, level: {add: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: null, level: {}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0},
            astarCost: {base: 3, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 0.15, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 140, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 5.5, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 14, level: {factor: 0.89, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    collector: { kind: "unit", color: "#aaa", vis: "star", isWorker: true, resourceKey: "energy", name: "⚡ Collector", description: "Resource worker. Gathers energy from energy mines and farms and refills the shared energy stockpile.", strength: "Harvests energy", weakness: "Unarmed and vulnerable to raiders",
        stats: {
            energy: {base: 15, level: {factor: 1.13, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 0, level: {factor: 1, round: "round", min: 0}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 49.95, level: {factor: 1, min: 49.95}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.025, min: 0.01},
            speed: {base: 2, level: {factor: 1.05, max: 4.8}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 6, min: 0.1},
            visionRange: {base: 0.6, level: {factor: 1.03, max: 2.2}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 2.4},
            attackRange: {base: 2, level: {}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 5, min: 0.2},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 38, level: {power: 1, min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: 2, level: {factor: 0.9, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0.01},
            astarCost: {base: 3, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 1.4, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 15, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 6, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 15, level: {factor: 0.9, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    astar_collector: { kind: "unit", color: "#bbb", vis: "star", isWorker: true, resourceKey: "astar", name: "★ Collector", description: "Resource worker. Gathers ★ from gray ★ mines and farms and refills the shared ★ stockpile used by pathfinding.", strength: "Harvests astar", weakness: "Unarmed and vulnerable to raiders",
        stats: {
            energy: {base: 15, level: {factor: 1.13, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 0, level: {factor: 1, round: "round", min: 0}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 49.95, level: {factor: 1, min: 49.95}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.025, min: 0.01},
            speed: {base: 2, level: {factor: 1.05, max: 4.8}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 6, min: 0.1},
            visionRange: {base: 0.6, level: {factor: 1.03, max: 2.2}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 2.4},
            attackRange: {base: 2, level: {}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 5, min: 0.2},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 40, level: {power: 1, min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: 2, level: {factor: 0.9, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0.01},
            astarCost: {base: 3, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 1.4, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 15, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 6, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 15, level: {factor: 0.9, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    salvager_unit: { kind: "unit", color: "#765", vis: "triangle_down", isWorker: true, name: "Salvager", description: "Recycling worker. Dismantles buildings marked for salvage and returns their resources.", strength: "Recovers value from structures", weakness: "Unarmed and slow",
        stats: {
            energy: {base: 20, level: {factor: 1.14, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 0, level: {factor: 1, round: "round", min: 0}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 49.95, level: {factor: 1, min: 49.95}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.025, min: 0.01},
            speed: {base: 1.8, level: {factor: 1.045, max: 4.6}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 5.4, min: 0.1},
            visionRange: {base: 0.6, level: {factor: 1.03, max: 2.2}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 2.4},
            attackRange: {base: 2, level: {}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 5, min: 0.2},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: 2, level: {factor: 0.9, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0.01},
            astarCost: {base: 10, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 0.4, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 20, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 6, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 20, level: {factor: 0.9, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    builder_unit: { kind: "unit", color: "#8b5", vis: "rect", isWorker: true, name: "Builder", description: "Construction worker. Fetches materials from builder spawners and constructs and upgrades buildings.", strength: "Builds and repairs structures", weakness: "Unarmed; requires access to worksites",
        stats: {
            energy: {base: 25, level: {factor: 1.16, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 0, level: {factor: 1, round: "round", min: 0}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 49.95, level: {factor: 1, min: 49.95}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.025, min: 0.01},
            speed: {base: 1.9, level: {factor: 1.05, max: 4.7}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 5.699999999999999, min: 0.1},
            visionRange: {base: 0.6, level: {factor: 1.03, max: 2.2}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 2.4},
            attackRange: {base: 2, level: {}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 5, min: 0.2},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 25, level: {factor: 1.46, round: "round", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "round"},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: 2, level: {factor: 0.9, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0.01},
            astarCost: {base: 10, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 0.4, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 18, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 6, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 25, level: {factor: 0.9, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    healer_unit: { kind: "unit", color: "#fff", vis: "triangle", isWorker: true, isFlying: true, name: "Healer", description: "Support worker. Fetches healing supplies from healer spawners and restores nearby damaged friendly units.", strength: "Flying healing and queue support", weakness: "Unarmed and fragile",
        stats: {
            energy: {base: 25, level: {factor: 1.16, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 0, level: {factor: 1, round: "round", min: 0}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 49.95, level: {factor: 1, min: 49.95}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.025, min: 0.01},
            speed: {base: 1.9, level: {factor: 1.05, max: 4.7}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 5.699999999999999, min: 0.1},
            visionRange: {base: 0.6, level: {factor: 1.03, max: 2.2}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 2.4},
            attackRange: {base: 2, level: {}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 5, min: 0.2},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 5, level: {factor: 1.46, round: "round", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "round"},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: 2, level: {factor: 0.9, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0.01},
            astarCost: {base: 10, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 0.4, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 18, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 6, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            collisionR: {base: 3, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 25, level: {factor: 0.9, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    researcher_unit: { kind: "unit", color: "#6af", vis: "triangle", isWorker: true, isFlying: true, name: "Researcher", description: "Research worker. Fetches supplies from research labs and converts them into research progress.", strength: "Flying research worker", weakness: "Unarmed and fragile",
        stats: {
            energy: {base: 25, level: {factor: 1.16, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 0, level: {factor: 1, round: "round", min: 0}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 49.95, level: {factor: 1, min: 49.95}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.025, min: 0.01},
            speed: {base: 1.9, level: {factor: 1.05, max: 4.7}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 5.699999999999999, min: 0.1},
            visionRange: {base: 0.6, level: {factor: 1.03, max: 2.2}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 2.4},
            attackRange: {base: 2, level: {}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 5, min: 0.2},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 15, level: {factor: 1.46, round: "round", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "round"},
            transferCooldown: {base: 2, level: {factor: 0.9, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0.01},
            astarCost: {base: 10, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 0.4, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 18, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 6, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            collisionR: {base: 3, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            trainingTime: {base: 25, level: {factor: 0.9, min: 0.05}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    king: { kind: "unit", color: "#ffd700", vis: "king", attackStyle: "melee", name: "King", description: "Commander. In Kill King mode, a team whose king dies loses.", strength: "Durable command unit with solid melee damage", weakness: "Limited melee reach",
        stats: {
            energy: {base: 250, level: {factor: 1.2, round: "floor", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 1, round: "floor"},
            atk: {base: 12, level: {factor: 1.12, round: "round", min: 1}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            atkCd: {base: 2, level: {factor: 0.99, min: 0.6}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: 0.025, min: 0.01},
            speed: {base: 1.8, level: {factor: 1.025, max: 3.2}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: 5.4, min: 0.1},
            visionRange: {base: 1, level: {factor: 1.04, max: 3.4}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 4},
            attackRange: {base: 1, level: {factor: 1.04, max: 3.4}, researchable: true, research: {factor: 1.08, direction: "increase"}, softCap: 1, min: 0},
            watchDuration: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null, min: 0},
            gatherPerTrip: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            builderDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            healerDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            researcherDps: {base: 0, level: {}, researchable: false, research: {factor: 2, direction: "increase"}, softCap: null},
            transferCooldown: {base: null, level: {}, researchable: false, research: {factor: 2, direction: "decrease"}, softCap: 0.3, min: 0},
            astarCost: {base: 15, level: {factor: 1.75, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            upKeep: {base: 0.8, level: {factor: 1.45, min: 0.01}, researchable: true, research: {factor: 2, direction: "decrease"}, softCap: null, min: 0.01},
            price: {base: 1000, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            r: {base: 12, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    pistol: { kind: "building", name: "Pistol", icon: "⚡", color: "#964B00", target: "wall", description: "Basic single-shot tower. Reliable damage, decent range.", strength: "Cheap dependable direct fire", weakness: "Short reach and low health",
        stats: {
            maxEnergy: {base: 30, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            damage: {base: 8, level: {factor: 1.4}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            cd: {base: 2, level: {linear: -0.1, min: 0.25}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 0.6309297535714574},
            visionRange: {base: 0.6, level: {linear: 0.2}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 1.7999999999999998},
            attackRange: {base: 1, level: {linear: 0.06}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: 3},
            upKeep: {base: 1, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 35, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    smg: { kind: "building", name: "SMG", icon: "⚡", color: "#aaf", target: "wall", description: "Rapid-fire tower. Low damage per hit but high fire rate.", strength: "Higher direct-fire throughput at close range", weakness: "Shorter reach and less health than Pistol",
        stats: {
            maxEnergy: {base: 25, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            damage: {base: 6, level: {factor: 1.4}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            cd: {base: 1.25, level: {linear: -0.1, min: 0.25}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 0.20311401357501227},
            visionRange: {base: 0.6, level: {linear: 0.2}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 1.7999999999999998},
            attackRange: {base: 1, level: {linear: 0.06}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: 2.5},
            upKeep: {base: 0.8, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 45, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    water: { kind: "building", name: "Water", icon: "💧", color: "#4af", target: "wall", description: "Soaks enemies, making them vulnerable to freeze DPS.", strength: "Wet enables freeze combinations", weakness: "Modest direct damage and short reach",
        stats: {
            maxEnergy: {base: 95, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            damage: {base: 10, level: {factor: 1.4}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            cd: {base: 1.75, level: {linear: -0.1, min: 0.25}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 0.5093842420185073},
            visionRange: {base: 0.6, level: {linear: 0.2}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 1.7999999999999998},
            attackRange: {base: 1, level: {linear: 0.06}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: 3.5},
            wetDuration: {base: 7, level: {add: 1}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            upKeep: {base: 1.1, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 74, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    poison: { kind: "building", name: "Poison", icon: "🧪", color: "#2d2", target: "wall", description: "Applies stacking poison DoT. Low base damage.", strength: "Strong sustained poison damage", weakness: "Low direct damage; poison-resistant units counter it",
        stats: {
            maxEnergy: {base: 200, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            damage: {base: 3, level: {factor: 1.4}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            cd: {base: 2.5, level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 0.8340437671464697},
            visionRange: {base: 0.6, level: {linear: 0.2}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 1.7999999999999998},
            attackRange: {base: 1, level: {linear: 0.06}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: 4},
            poisonDps: {base: 12, level: {factor: 1.4, min: 0.1}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            poisonDuration: {base: 5, level: {add: 2.5}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            upKeep: {base: 1.6, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 173, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    fire: { kind: "building", name: "Fire", icon: "🔥", color: "#f50", target: "wall", description: "Splash damage and burn DoT. Strong vs groups.", strength: "Splash and burn punish packed groups", weakness: "Long cooldown, short reach and fire-resistant counters",
        stats: {
            maxEnergy: {base: 350, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            damage: {base: 45, level: {factor: 1.4}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            blastDamage: {base: 10, level: {factor: 1.4}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            blastRadius: {base: 0.06, level: {}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            cd: {base: 5.5, level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 1.5517285850726805},
            visionRange: {base: 0.6, level: {linear: 0.2}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 1.7999999999999998},
            attackRange: {base: 1, level: {linear: 0.06}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: 3},
            burnDps: {base: 2.25, level: {factor: 1.4, min: 0.1}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            burnDuration: {base: 3.5, level: {add: 0.5}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            upKeep: {base: 1.9, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 375, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    sand_gun: { kind: "building", name: "Sand Gun", icon: "⌛", color: "#c96", target: "wall", description: "Slows enemies drastically. Low damage.", strength: "Long-range slowing helps hold a front", weakness: "Very low damage and long cooldown",
        stats: {
            maxEnergy: {base: 180, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            damage: {base: 5, level: {factor: 1.4}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            cd: {base: 7.5, level: {factor: 0.9, offset: 0}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 1.7381404928570852},
            visionRange: {base: 0.8, level: {linear: 0.2}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 2.4000000000000004},
            attackRange: {base: 1, level: {linear: 0.06}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: 4},
            sandDuration: {base: 9, level: {}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            upKeep: {base: 1.2, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 60, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    ice: { kind: "building", name: "Ice", icon: "❄️", color: "#afe", target: "wall", description: "Freezes enemies. Combo with water for freeze DPS.", strength: "High damage and freeze control", weakness: "Expensive; ice-resistant units counter it",
        stats: {
            maxEnergy: {base: 400, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            damage: {base: 65, level: {factor: 1.4}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            cd: {base: 2, level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 0.6309297535714574},
            visionRange: {base: 0.6, level: {linear: 0.2}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 1.7999999999999998},
            attackRange: {base: 1, level: {linear: 0.06}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: 4.5},
            freezeDps: {base: 6.6, level: {factor: 1.4, min: 0.1}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            freezeDuration: {base: 3.5, level: {add: 0.5}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            upKeep: {base: 2.4, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 700, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    sniper: { kind: "building", name: "Sniper", icon: "🎯", color: "#888", target: "wall", description: "Long-range precision tower with very high single-shot damage.", strength: "Very long reach and heavy single-target hits", weakness: "Very long cooldown, high price and fragile for its cost",
        stats: {
            maxEnergy: {base: 600, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            damage: {base: 170, level: {factor: 1.4}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            cd: {base: 12, level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 2.2618595071429146},
            visionRange: {base: 1.6, level: {linear: 0.2}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 4.800000000000001},
            attackRange: {base: 1.6, level: {linear: 0.06}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: 8},
            upKeep: {base: 2.8, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 1500, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    elements: { kind: "building", name: "Elements", icon: "🌈", color: "#fff", target: "wall", description: "Applies all status effects. Jack of all trades.", strength: "Flexible mixed status support", weakness: "Very low direct damage and modest health",
        stats: {
            maxEnergy: {base: 150, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            damage: {base: 1, level: {factor: 1.4}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            cd: {base: 1.75, level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 0.5093842420185073},
            visionRange: {base: 0.6, level: {linear: 0.2}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 1.7999999999999998},
            attackRange: {base: 1, level: {linear: 0.06}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: 5},
            burnDps: {base: 0.2, level: {factor: 1.4, min: 0.1}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            burnDuration: {base: 6, level: {add: 1}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            poisonDps: {base: 0.2, level: {factor: 1.4, min: 0.1}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            poisonDuration: {base: 6, level: {add: 1}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            freezeDps: {base: 0.2, level: {factor: 1.4, min: 0.1}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            freezeDuration: {base: 6, level: {add: 1}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            wetDuration: {base: 7, level: {}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            sandDuration: {base: 9, level: {}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            upKeep: {base: 1.5, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 50, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    laser: { kind: "building", name: "Laser", icon: "⚡", color: "#f00", target: "wall", description: "Beam between aligned laser towers. Constant very high DPS. Difficult to use effectively.", strength: "Very high damage along linked beams", weakness: "Requires alignment; laser-resistant units counter it",
        stats: {
            maxEnergy: {base: 300, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            damage: {base: 750, level: {factor: 1.4}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {linear: 0.2}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            attackRange: {base: 0, level: {}, researchable: false, research: {factor: 1.25, direction: "increase"}, softCap: 0},
            upKeep: {base: 2, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 125, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    watch_tower: { kind: "building", name: "Watch Tower", icon: "👁️", color: "#fd0", target: "wall", isWatchTower: true, description: "Marks enemies with Watch and grants shared sight around marked targets. Low Energy, large vision.", strength: "Extreme reach and Watch support", weakness: "Very low damage and health",
        stats: {
            maxEnergy: {base: 15, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            damage: {base: 1, level: {factor: 1.4}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            cd: {base: 1.4, level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 0.306270228443495},
            visionRange: {base: 2, level: {linear: 0.2, max: 4.8}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 6},
            attackRange: {base: 2, level: {linear: 0.06}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: 10},
            watchDuration: {base: 5, level: {add: 1}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            upKeep: {base: 0.2, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 25, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    sand: { kind: "building", name: "Sand", icon: "⌛", color: "#c96", target: "floor", description: "Slows enemies walking over it. Fast to build. Strong agains moles. Low health.", strength: "Ground area denial", weakness: "Immobile; flying units bypass it",
        stats: {
            maxEnergy: {base: 30, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            damage: {base: 0.05, level: {factor: 1.6}, researchable: false, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            sandDuration: {base: 0.5, level: {}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            upKeep: {base: 1, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 30, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    lava: { kind: "building", name: "Lava", icon: "🌋", color: "#d22", target: "floor", description: "Burns enemies walking over it. Fast to build. Strong agains moles. Low health.", strength: "Ground area denial", weakness: "Immobile; flying units bypass it",
        stats: {
            maxEnergy: {base: 30, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            damage: {base: 1, level: {factor: 1.6}, researchable: false, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            burnDps: {base: 1, level: {factor: 1.6, min: 0.1}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            burnDuration: {base: 1.5, level: {}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            upKeep: {base: 1.2, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 50, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    poison_puddle: { kind: "building", name: "Poison Puddle", icon: "☠️", color: "#2d2", target: "floor", description: "Poisons enemies walking over it. Fast to build. Strong agains moles. Low health.", strength: "Ground area denial", weakness: "Immobile; flying units bypass it",
        stats: {
            maxEnergy: {base: 30, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            damage: {base: 1, level: {factor: 1.6}, researchable: false, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            poisonDps: {base: 1, level: {factor: 1.6, min: 0.1}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            poisonDuration: {base: 1.5, level: {}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            upKeep: {base: 1, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 90, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    ice_patch: { kind: "building", name: "Ice Patch", icon: "❄️", color: "#afe", target: "floor", description: "Freezes enemies walking over it. Fast to build. Strong agains moles. Low health.", strength: "Ground area denial", weakness: "Immobile; flying units bypass it",
        stats: {
            maxEnergy: {base: 30, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            damage: {base: 1, level: {factor: 1.6}, researchable: false, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            freezeDps: {base: 1, level: {factor: 1.6, min: 0.2}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            freezeDuration: {base: 1.5, level: {}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            upKeep: {base: 1.4, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 60, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    water_puddle: { kind: "building", name: "Water Puddle", icon: "💧", color: "#4af", target: "floor", description: "Soaks enemies walking over it. Fast to build. Strong agains moles. Low health.", strength: "Ground area denial", weakness: "Immobile; flying units bypass it",
        stats: {
            maxEnergy: {base: 30, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            wetDuration: {base: 3, level: {}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            upKeep: {base: 0.2, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 50, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    mine: { kind: "building", name: "Mine", icon: "💣", color: "#666", target: "floor", description: "Explodes once when an enemy walks over it. Fast to build. Strong agains moles. Low health.", strength: "Ground area denial", weakness: "Immobile; flying units bypass it",
        stats: {
            maxEnergy: {base: 30, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            damage: {base: 135, level: {factor: 1.6, round: "floor"}, researchable: false, research: {factor: 1.25, direction: "increase"}, softCap: null},
            blastDamage: {base: 135, level: {factor: 1.4}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            blastRadius: {base: 0.084, level: {}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            upKeep: {base: 0.2, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 20, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    farm: { kind: "building", name: "⚡ Farm", icon: "🌾", color: "#da0", target: "floor", resourceKey: "energy", description: "A tree growing energy. ⚡ Collectors harvest it; farm level multiplies energy work speed.", strength: "Renewable resources close to base", weakness: "Needs collectors and protection",
        stats: {
            maxEnergy: {base: 1000, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            multiplier: {base: 0.02, level: {model: "farm", coefficient: 1, power: 3}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: 10},
            upKeep: {base: 2.8, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 40, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    spawner: { kind: "building", name: "⚡ Collector", shopName: "Collector", icon: "🏭", color: "#432", target: "floor", resourceKey: "energy", description: "Spawns ⚡ collectors that gather energy from energy mines and farms.", spawns: "collector", strength: "Produces collector", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 1, from: "collector.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "collector.price"},
            visionRange: {base: 0.6, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 1.7999999999999998},
            upKeep: {base: 2.8, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 150, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    astar_farm: { kind: "building", name: "★ Farm", icon: "★", color: "#9aa", target: "floor", resourceKey: "astar", description: "A mine entrance producing ★. ★ Collectors harvest it; farm level multiplies ★ work speed.", strength: "Renewable resources close to base", weakness: "Needs collectors and protection",
        stats: {
            maxEnergy: {base: 1000, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            multiplier: {base: 0.02, level: {model: "farm", coefficient: 1, power: 3}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: 10},
            upKeep: {base: 2.8, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 50, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    astar_spawner: { kind: "building", name: "★ Collector", shopName: "Collector", icon: "★", color: "#432", target: "floor", resourceKey: "astar", description: "Spawns ★ collectors that gather ★ from gray ★ mines and farms and refill the shared ★ stockpile.", spawns: "astar_collector", strength: "Produces astar_collector", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 1, from: "astar_collector.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "astar_collector.price"},
            visionRange: {base: 0.6, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 1.7999999999999998},
            upKeep: {base: 2.8, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 170, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    salvager: { kind: "building", name: "Salvager", icon: "♻️", color: "#543", target: "floor", description: "Spawns salvagers that recycle marked buildings.", spawns: "salvager_unit", strength: "Produces salvager_unit", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 1.106232178537418, from: "salvager_unit.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "salvager_unit.price"},
            visionRange: {base: 0.6, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 1.7999999999999998},
            upKeep: {base: 0.5, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 150, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    builder_spawner: { kind: "building", name: "Builder", icon: "🚧", color: "#354", target: "floor", description: "Spawns builders that construct buildings. All placed buildings start at 1 energy and need builders to become functional.", spawns: "builder_unit", strength: "Produces builder_unit", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 1.1886322578355741, from: "builder_unit.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "builder_unit.price"},
            visionRange: {base: 0.6, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 1.7999999999999998},
            upKeep: {base: 0.5, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 180, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    healer_spawner: { kind: "building", name: "Healer", icon: "△⚕️", color: "#355", target: "floor", description: "Spawns healers that restore damaged friendly units. Healers fetch supplies from healer spawners before each heal.", spawns: "healer_unit", strength: "Produces healer_unit", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 1.1886322578355741, from: "healer_unit.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "healer_unit.price"},
            visionRange: {base: 0.6, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 1.7999999999999998},
            upKeep: {base: 0.5, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 180, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    research: { kind: "building", name: "Research", icon: "△🧪", color: "#446", target: "floor", description: "Runs queued research projects and spawns researchers that complete research tasks.", spawns: "researcher_unit", strength: "Produces researcher_unit", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 70, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 1.1886322578355741, from: "researcher_unit.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "researcher_unit.price"},
            visionRange: {base: 0.6, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 1.7999999999999998},
            efficiency: {base: 1, level: {factor: 1.05, max: 3}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: 3},
            upKeep: {base: 0.5, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 260, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    house: { kind: "building", name: "House", icon: "🏠", color: "#c95", target: "floor", description: "Raises max population by 1.6^{level} while operational.", strength: "Raises population capacity", weakness: "No direct combat power; vulnerable infrastructure",
        stats: {
            maxEnergy: {base: 30, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            popCap: {base: 1, level: {model: "population", factor: 1.6}, researchable: true, research: {factor: 1.5, direction: "increase"}, softCap: {model: "populationLimit"}},
            visionRange: {base: 0.4, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 1.2000000000000002},
            upKeep: {base: 0.5, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 110, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    area_upgrader: { kind: "building", name: "Area Up", icon: "⬆️", color: "#fd0", target: "area_upgrade", description: "Upgrade a fully-filled area's multiplier level. Exponential cost.", strength: "Improves territory", weakness: "No direct combat damage",
        stats: {
            maxEnergy: {base: 1, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0.2, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 0.6000000000000001},
            upKeep: {base: 0.5, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 100, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    shrine: { kind: "building", name: "Shrine", icon: "💀", color: "#c9b", target: "none", notBuildable: true, description: "💀 is damage taken: every bit of energy your units and buildings lose to damage goes to your shrine. It drains passively into ⚡ and/or ★ (the buttons beside 💀 at the bottom left; both: half each, neither: it keeps filling), up to Drain / s, times Multiplier. Research raises both; leave draining off to bank 💀 for a higher multiplier.", strength: "Recovers resources from losses", weakness: "Recovery depends on taking losses",
        stats: {
            maxEnergy: {base: 1, level: {factor: 2, round: "floor"}, researchable: false, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            multiplier: {base: 0.01, level: {}, researchable: true, research: {factor: 2, direction: "increase"}, softCap: null},
            upKeep: {base: 0.01, level: {factor: 1.85, min: 0.01}, researchable: false, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            drainRate: {base: 1, level: {}, researchable: true, research: {factor: 10, direction: "increase"}, softCap: null},
            price: {base: 200, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    cloud_0a: { kind: "building", name: "Cloud R1", icon: "☁️", color: "#f66", target: "wall", isCloud: true, description: "Cloud portal endpoint. Links its area with the paired portal's area for adjacency.", strength: "Paired transport across obstacles", weakness: "Requires both endpoints and sustained upkeep",
        stats: {
            maxEnergy: {base: 200, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {linear: 0.2}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            attackRange: {base: 0, level: {}, researchable: false, research: {factor: 1.25, direction: "increase"}, softCap: 0},
            upKeep: {base: 10, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 100, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            pairId: {base: 0, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    cloud_0b: { kind: "building", name: "Cloud R2", icon: "☁️", color: "#f66", target: "wall", isCloud: true, description: "Cloud portal endpoint. Links its area with the paired portal's area for adjacency.", strength: "Paired transport across obstacles", weakness: "Requires both endpoints and sustained upkeep",
        stats: {
            maxEnergy: {base: 200, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {linear: 0.2}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            attackRange: {base: 0, level: {}, researchable: false, research: {factor: 1.25, direction: "increase"}, softCap: 0},
            upKeep: {base: 10, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 100, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            pairId: {base: 0, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    cloud_1a: { kind: "building", name: "Cloud B1", icon: "☁️", color: "#66f", target: "wall", isCloud: true, description: "Cloud portal endpoint. Links its area with the paired portal's area for adjacency.", strength: "Paired transport across obstacles", weakness: "Requires both endpoints and sustained upkeep",
        stats: {
            maxEnergy: {base: 200, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {linear: 0.2}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            attackRange: {base: 0, level: {}, researchable: false, research: {factor: 1.25, direction: "increase"}, softCap: 0},
            upKeep: {base: 10, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 100, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            pairId: {base: 1, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    cloud_1b: { kind: "building", name: "Cloud B2", icon: "☁️", color: "#66f", target: "wall", isCloud: true, description: "Cloud portal endpoint. Links its area with the paired portal's area for adjacency.", strength: "Paired transport across obstacles", weakness: "Requires both endpoints and sustained upkeep",
        stats: {
            maxEnergy: {base: 200, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {linear: 0.2}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            attackRange: {base: 0, level: {}, researchable: false, research: {factor: 1.25, direction: "increase"}, softCap: 0},
            upKeep: {base: 10, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 100, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            pairId: {base: 1, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    cloud_2a: { kind: "building", name: "Cloud G1", icon: "☁️", color: "#6f6", target: "wall", isCloud: true, description: "Cloud portal endpoint. Links its area with the paired portal's area for adjacency.", strength: "Paired transport across obstacles", weakness: "Requires both endpoints and sustained upkeep",
        stats: {
            maxEnergy: {base: 200, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {linear: 0.2}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            attackRange: {base: 0, level: {}, researchable: false, research: {factor: 1.25, direction: "increase"}, softCap: 0},
            upKeep: {base: 10, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 100, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            pairId: {base: 2, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    cloud_2b: { kind: "building", name: "Cloud G2", icon: "☁️", color: "#6f6", target: "wall", isCloud: true, description: "Cloud portal endpoint. Links its area with the paired portal's area for adjacency.", strength: "Paired transport across obstacles", weakness: "Requires both endpoints and sustained upkeep",
        stats: {
            maxEnergy: {base: 200, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {linear: 0.2}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            attackRange: {base: 0, level: {}, researchable: false, research: {factor: 1.25, direction: "increase"}, softCap: 0},
            upKeep: {base: 10, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 100, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            pairId: {base: 2, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    cloud_3a: { kind: "building", name: "Cloud Y1", icon: "☁️", color: "#ff6", target: "wall", isCloud: true, description: "Cloud portal endpoint. Links its area with the paired portal's area for adjacency.", strength: "Paired transport across obstacles", weakness: "Requires both endpoints and sustained upkeep",
        stats: {
            maxEnergy: {base: 200, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {linear: 0.2}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            attackRange: {base: 0, level: {}, researchable: false, research: {factor: 1.25, direction: "increase"}, softCap: 0},
            upKeep: {base: 10, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 100, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            pairId: {base: 3, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    cloud_3b: { kind: "building", name: "Cloud Y2", icon: "☁️", color: "#ff6", target: "wall", isCloud: true, description: "Cloud portal endpoint. Links its area with the paired portal's area for adjacency.", strength: "Paired transport across obstacles", weakness: "Requires both endpoints and sustained upkeep",
        stats: {
            maxEnergy: {base: 200, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            visionRange: {base: 0, level: {linear: 0.2}, researchable: false, research: {factor: 1.06, direction: "increase"}, softCap: 32},
            attackRange: {base: 0, level: {}, researchable: false, research: {factor: 1.25, direction: "increase"}, softCap: 0},
            upKeep: {base: 10, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 100, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
            pairId: {base: 3, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    barrack_norm: { kind: "building", name: "Barrack", icon: "⛺", color: "#686", target: "floor", description: "Trains basic infantry. Balanced stats.", spawns: "norm", strength: "Produces norm", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 1.3621902033472335, from: "norm.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "norm.price"},
            visionRange: {base: 0.8, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 2.4000000000000004},
            upKeep: {base: 0.2, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 100, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    barrack_fast: { kind: "building", name: "Fast Brk", icon: "⛺", color: "#eee", target: "floor", description: "Trains fast riders. Fragile but quick.", spawns: "fast", strength: "Produces fast", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 1.106232178537418, from: "fast.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "fast.price"},
            visionRange: {base: 1, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 3},
            upKeep: {base: 0.2, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 80, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    barrack_tank: { kind: "building", name: "Tank Brk", icon: "⛺", color: "#555", target: "floor", description: "Trains heavy units. Slow but tough.", spawns: "tank", strength: "Produces tank", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 1.618148228157049, from: "tank.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "tank.price"},
            visionRange: {base: 0.6, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 1.7999999999999998},
            upKeep: {base: 0.3, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 200, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    barrack_boss: { kind: "building", name: "Boss Brk", icon: "⛺", color: "#222", target: "floor", description: "Trains super-heavy units. Expensive powerhouse.", spawns: "boss", strength: "Produces boss", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 2.212464357074836, from: "boss.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "boss.price"},
            visionRange: {base: 0.8, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 2.4000000000000004},
            upKeep: {base: 0.4, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 500, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    barrack_flying: { kind: "building", name: "Flying Brk", icon: "⛺", color: "#dd0", target: "floor", description: "Trains winged lancers. They fly over walls and swoop onto targets.", spawns: "flying", strength: "Produces flying", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 1.4056838710822128, from: "flying.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "flying.price"},
            visionRange: {base: 1, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 3},
            upKeep: {base: 0.2, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 150, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    barrack_mole: { kind: "building", name: "Mole Brk", icon: "⛺", color: "#543", target: "floor", description: "Trains moles. Immune to towers, very fragile.", spawns: "mole", strength: "Produces mole", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 0.8502741537276026, from: "mole.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "mole.price"},
            visionRange: {base: 0.8, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 2.4000000000000004},
            upKeep: {base: 0.2, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 120, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    barrack_poison_resistant: { kind: "building", name: "Psn Res Brk", icon: "⛺", color: "#2d2", target: "floor", description: "Trains poison-immune units.", spawns: "poison_resistant", strength: "Produces poison_resistant", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 1.5119160496196309, from: "poison_resistant.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "poison_resistant.price"},
            visionRange: {base: 0.8, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 2.4000000000000004},
            upKeep: {base: 0.56, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 160, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    barrack_fire_resistant: { kind: "building", name: "Fire Res Brk", icon: "⛺", color: "#f50", target: "floor", description: "Trains fire-immune units.", spawns: "fire_resistant", strength: "Produces fire_resistant", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 1.5688391745175807, from: "fire_resistant.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "fire_resistant.price"},
            visionRange: {base: 0.8, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 2.4000000000000004},
            upKeep: {base: 0.56, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 160, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    barrack_water_resistant: { kind: "building", name: "Wtr Res Brk", icon: "⛺", color: "#4af", target: "floor", description: "Trains water-immune units.", spawns: "water_resistant", strength: "Produces water_resistant", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 1.4445902826453896, from: "water_resistant.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "water_resistant.price"},
            visionRange: {base: 1, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 3},
            upKeep: {base: 0.56, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 160, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    barrack_ice_resistant: { kind: "building", name: "Ice Res Brk", icon: "⛺", color: "#afe", target: "floor", description: "Trains ice-immune units.", spawns: "ice_resistant", strength: "Produces ice_resistant", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 1.5414733701009713, from: "ice_resistant.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "ice_resistant.price"},
            visionRange: {base: 0.8, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 2.4000000000000004},
            upKeep: {base: 0.56, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 160, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    barrack_laser_resistant: { kind: "building", name: "Lsr Res Brk", icon: "⛺", color: "#d0f", target: "floor", description: "Trains laser-immune units.", spawns: "laser_resistant", strength: "Produces laser_resistant", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 1.4797854129888126, from: "laser_resistant.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "laser_resistant.price"},
            visionRange: {base: 0.8, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 2.4000000000000004},
            upKeep: {base: 0.56, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 160, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    barrack_snake: { kind: "building", name: "Snake Brk", icon: "⛺", color: "#0f0", target: "floor", description: "Trains snakes. Massive Energy, leaves a trail.", spawns: "snake", strength: "Produces snake", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 2.468422381884652, from: "snake.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "snake.price"},
            visionRange: {base: 0.8, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 2.4000000000000004},
            upKeep: {base: 0.64, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 400, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
    barrack_scout: { kind: "building", name: "Scout Brk", icon: "⛺", color: "#9cf", target: "floor", description: "Trains scouts. Fast flying recon units that roam the map.", spawns: "scout", strength: "Produces scout", weakness: "Needs time, resources and protection from raiders",
        stats: {
            maxEnergy: {base: 60, level: {factor: 2, round: "floor"}, researchable: true, research: {factor: 1.25, direction: "increase"}, softCap: null},
            spawnCd: {level: {}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: 0.9745230455997934, from: "scout.trainingTime"},
            unitPrice: {level: {factor: 2, min: 1}, researchable: true, research: {factor: 1.8, direction: "increase"}, softCap: null, from: "scout.price"},
            visionRange: {base: 1.8, level: {}, researchable: true, research: {factor: 1.06, direction: "increase"}, softCap: 5.4},
            upKeep: {base: 0.2, level: {factor: 1.85, min: 0.01}, researchable: true, research: {factor: 1.25, direction: "decrease"}, softCap: null},
            maxLevel: {base: 1, level: {}, researchable: true, research: {factor: 1, direction: "increase"}, softCap: null},
            price: {base: 90, level: {}, researchable: false, research: {factor: 1, direction: "increase"}, softCap: null},
        }
    },
};

const RESOURCE_FARM_KEYS = Object.freeze(RESOURCE_TYPE_LIST.map(cfg => cfg.farmKey));
const RESOURCE_COLLECTOR_BUILDING_KEYS = Object.freeze(RESOURCE_TYPE_LIST.map(cfg => cfg.collectorBuildingKey));
const RESOURCE_COLLECTOR_UNIT_KEYS = Object.freeze(RESOURCE_TYPE_LIST.map(cfg => cfg.collectorUnitKey));



// Compatibility views are generated from THING_STATS; never edit them for balance.
const BASE_UNIT_STATS = {}, BASE_CARD_TYPES = {}, DESCRIPTIONS = {}, UNIT_DISPLAY_NAMES = {}, BARRACK_SPAWN_CONFIG = {};
function rebuildThingDefinitionViews() {
    for (const view of [BASE_UNIT_STATS, BASE_CARD_TYPES, DESCRIPTIONS, UNIT_DISPLAY_NAMES, BARRACK_SPAWN_CONFIG]) {
        for (const key of Object.keys(view)) delete view[key];
    }
    for (const [key, thing] of Object.entries(THING_STATS)) {
        const view = {};
        for (const field of Object.keys(thing)) if (field !== 'stats' && field !== 'unitType') view[field] = thing[field];
        for (const stat of Object.keys(thing.stats)) view[stat] = getThingStatBase(key, stat);
        if (thing.kind === 'unit') {
            BASE_UNIT_STATS[key] = view; UNIT_DISPLAY_NAMES[key] = thing.name;
            if (thing.stats.trainingTime) BARRACK_SPAWN_CONFIG[key] = {baseTime:getThingStatBase(key,'trainingTime'),reduction:1-(thing.stats.trainingTime.level.factor ?? 1)};
        } else {
            if (thing.spawns && key.startsWith('barrack_')) view.unitType = thing.spawns;
            view.energy = getThingStatBase(key,'maxEnergy');
            if (thing.target === 'wall') view.towerEnergy = view.energy;
            BASE_CARD_TYPES[key] = view;
        }
        DESCRIPTIONS[key] = thing.description || '';
    }
}
function getThingStatBase(key, stat, seen = new Set()) {
    const id = key+'.'+stat, rule = THING_STATS[key]?.stats[stat];
    if (!rule || seen.has(id)) return NaN;
    if (rule.from) { seen.add(id); const [other, field] = rule.from.split('.'); return getThingStatBase(other, field, seen); }
    return rule.base === null ? NaN : Number(rule.base);
}
rebuildThingDefinitionViews();

function _prettyKeyLabel(key) {
    return String(key || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function getUnitDisplayName(unitType) {
    return UNIT_DISPLAY_NAMES[unitType] || _prettyKeyLabel(unitType || 'Unit');
}

// Building card names (BASE_CARD_TYPES), for any building key.
function getBuildingDisplayName(key) {
    let def = BASE_CARD_TYPES[key];
    return def && def.name ? String(def.name) : _prettyKeyLabel(key || 'Building');
}

// Fallback description of a unit type without one of its own.
function getUnitDescription(unitType) {
    if (DESCRIPTIONS[unitType]) return DESCRIPTIONS[unitType];
    let stats = BASE_UNIT_STATS[unitType];
    return stats && stats.isWorker ? 'Worker unit.' : 'Combat unit.';
}

// Build menu categories
const BUILD_CATEGORIES = {
    barracks: ['barrack_norm', 'barrack_fast', 'barrack_tank', 'barrack_boss', 'barrack_flying', 'barrack_mole', 'barrack_poison_resistant', 'barrack_fire_resistant', 'barrack_water_resistant', 'barrack_ice_resistant', 'barrack_laser_resistant', 'barrack_snake', 'barrack_scout'],
    towers: ['pistol', 'smg', 'water', 'poison', 'fire', 'sand_gun', 'ice', 'sniper', 'elements', 'laser', 'watch_tower'],
    floor: ['sand', 'lava', 'poison_puddle', 'ice_patch', 'water_puddle', 'mine', ...RESOURCE_FARM_KEYS],
    special: [...RESOURCE_COLLECTOR_BUILDING_KEYS, 'salvager', 'builder_spawner', 'healer_spawner', 'research', 'house', 'area_upgrader', 'cloud_0a', 'cloud_0b', 'cloud_1a', 'cloud_1b', 'cloud_2a', 'cloud_2b', 'cloud_3a', 'cloud_3b'],
};

let RESEARCH_COST_EXP = 3;
let RESEARCH_WORK_EXP = 3;
let RESEARCH_WORK_BASE = 110;

let MAX_THING_LEVEL = 20;
// (The stationary descriptor holds the effective level in 6 bits: data_state.js
// stationaryBrainChanged, the adjacency kernel.)
const THING_LEVEL_CAP = 63;
let MAX_RESEARCH_LEVEL = 10;

// Semantic direction index for generic resource penalties; derived from the definitions.
const RESEARCH_DECREASE_STATS = Object.fromEntries(Object.values(THING_STATS).flatMap(t=>Object.entries(t.stats).filter(([,s])=>s.research?.direction === 'decrease').map(([key])=>[key,true])));
const RESEARCH_STAT_LABELS = {
    maxLevel: 'Max Level',
    maxEnergy: 'Max Energy',
    popCap: 'Pop Cap',
    damage: 'Damage',
    blastDamage: 'Blast Damage',
    blastRadius: 'Blast Radius',
    cd: 'Cooldown',
    spawnCd: 'Spawn CD',
    visionRange: 'Vision',
    multiplier: 'Multiplier',
    drainRate: '\uD83D\uDC80 Drain / s',
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
    astarCost: '★ / Tile',
    transferCooldown: 'Cooldown',
    gatherPerTrip: 'Work Speed',
    builderDps: 'Work Speed',
    healerDps: 'Work Speed',
    researcherDps: 'Work Speed',
    upKeep: '⚡/ s',
    unitPrice: 'Unit Energy'
};

const PRECOMPUTED_UNIT_STAT_KEYS = ['trainingTime', 'energy', 'atk', 'atkCd', 'speed', 'visionRange', 'attackRange', 'watchDuration', 'gatherPerTrip', 'builderDps', 'healerDps', 'researcherDps', 'transferCooldown', 'astarCost', 'upKeep'];
const PRECOMPUTED_BUILDING_STAT_KEYS = ['maxEnergy', 'popCap', 'damage', 'blastDamage', 'blastRadius', 'cd', 'spawnCd', 'unitPrice', 'visionRange', 'attackRange', 'multiplier', 'burnDps', 'burnDuration', 'poisonDps', 'poisonDuration', 'freezeDps', 'freezeDuration', 'wetDuration', 'sandDuration', 'watchDuration', 'efficiency', 'upKeep', 'drainRate'];
function getSpawnedUnitTypeForBuildingKey(key) { return THING_STATS[key]?.spawns || null; }

let PRECOMPUTED_STATS_MAP = { unit: {}, building: {} };
let PRECOMPUTED_STATS_MAP_PLAYER = [];
let PRECOMPUTED_STATS_READY = false;

// Spatial hash (10x10 tile chunks)
const CHUNK_SIZE = 1;
let CHUNKS_W = Math.ceil(GRID_W / CHUNK_SIZE);
let CHUNKS_H = Math.ceil(GRID_H / CHUNK_SIZE);
let spatialUnits = []; // flat array of Sets
let spatialUnitsComplex = new Int32Array(0); // [chunk][player]: unit totals (stride per player 1)
// Units per owner and unit type, by blocks of SPATIAL_TYPE_BLOCK x
// SPATIAL_TYPE_BLOCK chunks ([block][player][type]): the effective stats'
// same-type windows and the unit-type filter of range queries. Per chunk
// (with every player slot) it was 640 MB on a 1000x1000 map.
const SPATIAL_TYPE_BLOCK = 4;
let spatialTypeCounts = new Int32Array(0);
let spatialTypeBlocksW = 0, spatialTypeBlocksH = 0, spatialTypeStridePerBlock = 0;
let spatialUnitTypeToIndex = Object.create(null);
let spatialNormUnitTypeIndex = 0;
let spatialUnitsComplexUnitTypeCount = 0;
let spatialUnitsComplexPlayerCount = 0;
let spatialUnitsComplexStridePerPlayer = 0;
let spatialUnitsComplexStridePerChunk = 0;
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
