"use strict";

const RESOURCE_FIXED_POINT_SCALE = 1024;
const RESOURCE_NEGATIVE_PENALTY_BASE = 3.5;

function _toFixedResourceUnits(value) {
    let n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * RESOURCE_FIXED_POINT_SCALE);
}

function _fromFixedResourceUnits(value) {
    return (Math.floor(Number(value) || 0)) / RESOURCE_FIXED_POINT_SCALE;
}

function makeDefaultStartingResourcesConfig() {
    return {
        researchLevels: {},
        spawnCounts: {
            'building:builder_spawner': { 1: 1 },
            'building:healer_spawner': { 1: 1 },
            'building:house': { 6: 1 },
            'unit:builder_unit': { 1: 1 },
            'unit:healer_unit': { 1: 1 },
            'unit:king': { 1: 1 }
        }
    };
}

function parseStartingThingId(id) {
    let text = String(id || '');
    let sep = text.indexOf(':');
    if (sep < 1) return null;
    let kind = text.slice(0, sep);
    let key = text.slice(sep + 1);
    if ((kind !== 'unit' && kind !== 'building') || !key) return null;
    return { kind, key };
}

function refreshStartingResourcesPreviewPrecomputedStats() {
    if (gameStarted || !ensurePrecomputedStatsMap()) return;
    for (let playerId = 0; playerId < players.length; playerId++) rebuildPrecomputedStatsMapPlayer(playerId);
}

function _ensurePlayerResourceState(playerId) {
    let pid = Math.max(0, Math.floor(playerId || 0));
    if (!players[pid]) return null;
    let player = players[pid];
    if (!player.resourceMaxValues || typeof player.resourceMaxValues !== 'object') player.resourceMaxValues = {};
    if (!player._resourceFixedValues || typeof player._resourceFixedValues !== 'object') player._resourceFixedValues = {};
    if (!PLAYER_RESOURCE_STAT_MULTIPLIERS[pid] || typeof PLAYER_RESOURCE_STAT_MULTIPLIERS[pid] !== 'object') PLAYER_RESOURCE_STAT_MULTIPLIERS[pid] = {};
    for (let cfg of RESOURCE_TYPE_LIST) {
        let stockpileKey = String(cfg.stockpileKey || cfg.key || '');
        if (!stockpileKey) continue;
        let currentValue = Number(player[stockpileKey]);
        if (!Number.isFinite(currentValue)) currentValue = 0;
        let currentMax = Number(player.resourceMaxValues[stockpileKey]);
        let hasTrackedMax = Number.isFinite(currentMax) && currentMax > 0;
        if (!Number.isFinite(player._resourceFixedValues[stockpileKey]) || !hasTrackedMax) {
            player._resourceFixedValues[stockpileKey] = _toFixedResourceUnits(currentValue);
        }
        currentValue = _fromFixedResourceUnits(player._resourceFixedValues[stockpileKey]);
        player[stockpileKey] = currentValue;
        if (!Number.isFinite(currentMax)) currentMax = Math.max(1, currentValue);
        player.resourceMaxValues[stockpileKey] = Math.max(1, currentMax, currentValue);
        let multiplier = PLAYER_RESOURCE_STAT_MULTIPLIERS[pid][stockpileKey];
        if (!Number.isFinite(multiplier) || multiplier < 1) PLAYER_RESOURCE_STAT_MULTIPLIERS[pid][stockpileKey] = 1;
    }
    return player;
}

// The debt as a share of the most ever held, in steps of
// 1 / RESOURCE_PENALTY_STEP_DIV (the nearest step): the
// stat tables are rebuilt when the step changes, not on every spend while
// in debt (each rebuild sends every unit of the player through a stats
// refresh).
const RESOURCE_PENALTY_STEP_DIV = 16;
function _getResourcePenaltySteps(currentValue, maxValue) {
    let cur = Number(currentValue);
    let maxSeen = Math.max(1, Number(maxValue) || 0);
    if (!Number.isFinite(cur) || cur >= 0) return 0;
    return Math.max(0, Math.round(Math.abs(cur) / maxSeen * RESOURCE_PENALTY_STEP_DIV) / RESOURCE_PENALTY_STEP_DIV);
}

function _getPlayerResourcePenaltyMultiplier(playerId, resourceKey) {
    // A stockpile in debt no longer scales any stat (it switches the
    // player's boosts of that resource off instead: boostTick below).
    return 1;
    let player = _ensurePlayerResourceState(playerId);
    if (!player) return 1;
    let stockpileKey = String(resourceKey || '');
    if (!stockpileKey) return 1;
    let maxSeen = Math.max(1, Number(player.resourceMaxValues && player.resourceMaxValues[stockpileKey]) || 0);
    let currentValue = Number(player[stockpileKey]);
    if (!Number.isFinite(currentValue) || currentValue >= 0) return 1;
    let steps = _getResourcePenaltySteps(currentValue, maxSeen);
    return Math.max(1, detPow(RESOURCE_NEGATIVE_PENALTY_BASE, steps));
}

function _hasExplicitResourceStatMapping(resourceKey, kind, statKey) {
    let mapped = (((RESOURCE_PRECOMPUTED_STAT_MAP || {})[resourceKey] || {})[kind] || null);
    return Array.isArray(mapped) ? mapped.includes(statKey) : false;
}

// Static config: cached per kind/stat (the resource penalty rebuild asks for
// every stat of every thing).
const _resourceKeyForStatCache = new Map();
function _getResourceKeyForPrecomputedStat(kind, statKey) {
    let cacheKey = kind + '|' + statKey;
    let cached = _resourceKeyForStatCache.get(cacheKey);
    if (cached !== undefined) return cached;
    let resolved = _resolveResourceKeyForPrecomputedStat(kind, statKey);
    _resourceKeyForStatCache.set(cacheKey, resolved);
    return resolved;
}

function _resolveResourceKeyForPrecomputedStat(kind, statKey) {
    for (let cfg of RESOURCE_TYPE_LIST) {
        let stockpileKey = String(cfg.stockpileKey || cfg.key || '');
        if (!stockpileKey || stockpileKey === 'energy') continue;
        if (_hasExplicitResourceStatMapping(stockpileKey, kind, statKey)) return stockpileKey;
    }
    return 'energy';
}

// Stats a negative stockpile never scales.
const RESOURCE_PENALTY_EXEMPT_STATS = new Set(['upKeep', 'popCap', 'energy', 'maxEnergy', 'workerSearchDistance', 'visionRange', 'visionRangeArea', 'attackRange', 'attackRangeArea', 'blastRadius']);

// The penalty multiplier for one of a player's stats (1 = none).
function _getPlayerStatPenaltyMultiplier(playerId, kind, statKey) {
    if (RESOURCE_PENALTY_EXEMPT_STATS.has(statKey)) return 1;
    return _getPlayerResourcePenaltyMultiplier(playerId, _getResourceKeyForPrecomputedStat(kind, statKey));
}

function _penalizeStatValue(statKey, value, multiplier) {
    let numericValue = Number(value);
    if (!Number.isFinite(numericValue) || !(multiplier > 1)) return numericValue;
    return RESEARCH_DECREASE_STATS[statKey]
        ? (numericValue * multiplier)
        : (numericValue / multiplier);
}

// The multiplier each player's stat tables were last built with, per
// stockpile. The current one (above) runs ahead of it until the tick's flush
// (flushPendingResourceStatRebuilds); the tables follow this one only, so
// they are a function of research and these, which a snapshot carries
// (utils_snapshot.js statMult): a restored peer builds the same tables
// whatever its own were (they followed its own history before).
let _statAppliedMult = [];
function _statAppliedGet(playerId, stockpileKey) {
    let m = _statAppliedMult[playerId];
    let v = m ? m[stockpileKey] : undefined;
    return v >= 1 ? v : 1;
}
function _statAppliedSet(playerId, stockpileKey, multiplier) {
    if (!stockpileKey) return;
    (_statAppliedMult[playerId] || (_statAppliedMult[playerId] = {}))[stockpileKey] = Math.max(1, Number(multiplier) || 1);
}
function _statAppliedSetCurrent(playerId) {
    for (let cfg of RESOURCE_TYPE_LIST) {
        let stockpileKey = String(cfg.stockpileKey || cfg.key || '');
        if (stockpileKey) _statAppliedSet(playerId, stockpileKey, _getPlayerResourcePenaltyMultiplier(playerId, stockpileKey));
    }
}
function _getPlayerStatAppliedMultiplier(playerId, kind, statKey) {
    if (RESOURCE_PENALTY_EXEMPT_STATS.has(statKey)) return 1;
    return _statAppliedGet(playerId, _getResourceKeyForPrecomputedStat(kind, statKey));
}

function _applyPlayerResourcePenaltyToStatValue(playerId, kind, statKey, value) {
    let numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return numericValue;
    return _penalizeStatValue(statKey, numericValue, _getPlayerStatAppliedMultiplier(playerId, kind, statKey));
}

function _updatePlayerResourcePenaltyMultipliers(playerId) {
    let pid = Math.max(0, Math.floor(playerId || 0));
    let player = _ensurePlayerResourceState(pid);
    if (!player) return [];
    let changedResources = [];
    for (let cfg of RESOURCE_TYPE_LIST) {
        let stockpileKey = String(cfg.stockpileKey || cfg.key || '');
        if (!stockpileKey) continue;
        let currentValue = Number(player[stockpileKey]);
        if (!Number.isFinite(currentValue)) currentValue = 0;
        let prevMax = Math.max(1, Number(player.resourceMaxValues[stockpileKey]) || 0);
            let nextMax = Math.max(1, currentValue, prevMax);
        if (nextMax !== prevMax) player.resourceMaxValues[stockpileKey] = nextMax;
        let prevMultiplier = Math.max(1, Number((PLAYER_RESOURCE_STAT_MULTIPLIERS[pid] || {})[stockpileKey]) || 1);
        let nextMultiplier = _getPlayerResourcePenaltyMultiplier(pid, stockpileKey);
        PLAYER_RESOURCE_STAT_MULTIPLIERS[pid][stockpileKey] = nextMultiplier;
        if (nextMultiplier !== prevMultiplier) changedResources.push(stockpileKey);
    }
    return changedResources;
}

function _setPlayerResourceValue(playerId, resourceKey, value) {
    let pid = Math.max(0, Math.floor(playerId || 0));
    let player = _ensurePlayerResourceState(pid);
    if (!player) return 0;
    let stockpileKey = String(resourceKey || '');
    if (!stockpileKey) return 0;
    let nextValue = Number(value);
    if (!Number.isFinite(nextValue)) nextValue = 0;
    let fixedMap = player._resourceFixedValues || (player._resourceFixedValues = {});
    fixedMap[stockpileKey] = _toFixedResourceUnits(nextValue);
    nextValue = _fromFixedResourceUnits(fixedMap[stockpileKey]);
    player[stockpileKey] = nextValue;
    let changedResources = _updatePlayerResourcePenaltyMultipliers(pid);
    // A negative stockpile changes its penalty on every spend. Movement spends
    // per tile, so rebuilding here costs a full stat table per unit step.
    // During play, coalesce into one rebuild at fixed tick boundaries (see
    // gameTick). The rebuild reads live values, so it is idempotent and every
    // peer sees identical stats at the same simulation points.
    for (let changedResourceKey of changedResources) {
        if (typeof gameStarted !== 'undefined' && gameStarted) _pendingResourceStatRebuilds.add(pid + '|' + changedResourceKey);
        else rebuildPrecomputedStatsMapPlayerResource(pid, changedResourceKey);
    }
    return player[stockpileKey];
}

const _pendingResourceStatRebuilds = new Set();

// ============================================================
// BOOSTS
// ============================================================
// A player may boost each of its things (a unit type, a building type) with
// energy and, units only, with ★: BOOST_MAX_STEPS steps each, of +1, +2,
// +4 and +8 thing levels (boostStepLevels). A boosted thing's stats are read a few levels up its tables:
// every stat but its health (energy: as with effective levels, a thing's
// health stays its own level's), move speed and ★ per tile at its
// level + the energy boost; move speed and ★ per tile at its level +
// the ★ boost (never past MAX_THING_LEVEL). The thing's own level, stacks and counts stay what they
// are; upkeep and ★ per tile are stats like the rest, so a boost costs
// what the higher level costs. A boost of a resource does nothing while the
// player's stockpile of it is in debt (looked at every BOOST_CHECK_TICKS:
// player.boostOn), which is all a negative stockpile does now.
// State: player.boosts['unit:norm'] = [energy steps, ★ steps] (the
// setBoost action), player.boostOn = { energy, astar }. The tables are a
// function of research and these (snapshots carry both with the player).
// A change rebuilds the thing's tables in place and its units and buildings
// take them at their next staggered refresh, as after a research.
const BOOST_MAX_STEPS = 4, BOOST_CHECK_TICKS = 20;
const BOOST_ASTAR_STATS = new Set(['speed', 'astarCost']);
const BOOST_EXEMPT_STATS = new Set(['energy', 'maxEnergy']);
function _boostThingKey(branch, key) {
    return branch === 'building' ? _normalizePlayerPrecomputedBuildingKey(key) : _normalizePlayerPrecomputedUnitKey(key);
}
// The steps a player chose for a thing (0: none).
function getPlayerThingBoost(playerId, branch, key, resourceKey) {
    let p = players[playerId], b = p && p.boosts ? p.boosts[branch + ':' + key] : null;
    let v = b ? Math.floor(Number(b[resourceKey === 'astar' ? 1 : 0]) || 0) : 0;
    return v > 0 ? Math.min(BOOST_MAX_STEPS, v) : 0;
}
function isPlayerBoostOn(playerId, resourceKey) {
    let p = players[playerId];
    return !(p && p.boostOn && p.boostOn[resourceKey] === false);
}
// The levels up a thing's tables one of its stats is read at.
function _statBoostLevels(playerId, branch, key, statKey) {
    let p = players[playerId];
    if (!p || !p.boosts || BOOST_EXEMPT_STATS.has(statKey)) return 0;
    let res = BOOST_ASTAR_STATS.has(statKey) ? (branch === 'unit' ? 'astar' : '') : 'energy';
    return res && isPlayerBoostOn(playerId, res) ? getPlayerThingBoost(playerId, branch, key, res) : 0;
}
// (A step doubles the boost: +1, +2, +4, +8 levels.)
function boostStepLevels(steps) { return steps > 0 ? 1 << (Math.min(BOOST_MAX_STEPS, steps) - 1) : 0; }
function _boostedLevel(lvl, steps) {
    return steps > 0 ? Math.min(MAX_THING_LEVEL, Math.max(1, lvl) + boostStepLevels(steps)) : lvl;
}
// A thing's tables made again after its boost changed (or went on or off).
function rebuildPlayerThingBoost(playerId, branch, key) {
    if (!ensurePrecomputedStatsMap()) return;
    if (!(PRECOMPUTED_STATS_MAP[branch] || {})[key]) return;
    if (branch === 'building' && typeof simTrapResearchDone === 'function') simTrapResearchDone(playerId);
    for (let statKey of (branch === 'unit' ? PRECOMPUTED_UNIT_STAT_KEYS : PRECOMPUTED_BUILDING_STAT_KEYS)) {
        if (branch === 'building' && !_buildingStatHasValues(key, statKey)) continue;
        _rebuildPlayerThingStatLevels(playerId, branch, key, statKey, 1);
    }
    if (branch === 'building' && key === 'house' && typeof recomputePlayerPopCaps === 'function') recomputePlayerPopCaps();
}
// The setBoost action: steps of energy or ★ boost for one thing.
function setPlayerThingBoost(playerId, kind, key, resourceKey, steps) {
    let p = players[playerId];
    if (!p || !ensurePrecomputedStatsMap()) return false;
    let branch = kind === 'building' ? 'building' : 'unit', res = resourceKey === 'astar' ? 'astar' : 'energy';
    if (branch === 'building' && res === 'astar') return false;
    let k = _boostThingKey(branch, String(key || ''));
    if (!(PRECOMPUTED_STATS_MAP[branch] || {})[k]) return false;
    let next = Math.max(0, Math.min(BOOST_MAX_STEPS, Math.floor(Number(steps) || 0)));
    if (getPlayerThingBoost(playerId, branch, k, res) === next) return false;
    if (!p.boosts) p.boosts = {};
    let b = p.boosts[branch + ':' + k] || (p.boosts[branch + ':' + k] = [0, 0]);
    b[res === 'astar' ? 1 : 0] = next;
    if (b[0] === 0 && b[1] === 0) delete p.boosts[branch + ':' + k];
    if (isPlayerBoostOn(playerId, res)) rebuildPlayerThingBoost(playerId, branch, k);
    return true;
}
// Every BOOST_CHECK_TICKS: a stockpile that went into debt, or out of it,
// switches the player's boosts of that resource off or on.
function boostTick() {
    if (!simStepCrosses(0, BOOST_CHECK_TICKS)) return;
    for (let pid = 0; pid < players.length; pid++) {
        let p = players[pid];
        if (!p) continue;
        for (let res of ['energy', 'astar']) {
            let on = !(Number(p[res]) < 0), was = !(p.boostOn && p.boostOn[res] === false);
            if (on === was) continue;
            if (!p.boostOn) p.boostOn = { energy: true, astar: true };
            p.boostOn[res] = on;
            if (!p.boosts) continue;
            for (let id of Object.keys(p.boosts).sort()) {
                if (!(p.boosts[id][res === 'astar' ? 1 : 0] > 0)) continue;
                let cut = id.indexOf(':');
                rebuildPlayerThingBoost(pid, id.slice(0, cut), id.slice(cut + 1));
            }
        }
    }
}

function flushPendingResourceStatRebuilds() {
    boostTick();
    if (_pendingResourceStatRebuilds.size === 0) return;
    // Sort for a stable rebuild order regardless of which spend came first.
    let pending = Array.from(_pendingResourceStatRebuilds).sort();
    _pendingResourceStatRebuilds.clear();
    for (let entry of pending) {
        let split = entry.indexOf('|');
        rebuildPrecomputedStatsMapPlayerResource(Number(entry.slice(0, split)), entry.slice(split + 1));
    }
}

function addPlayerResource(playerId, resourceKey, delta) {
    let pid = Math.max(0, Math.floor(playerId || 0));
    let player = _ensurePlayerResourceState(pid);
    if (!player) return 0;
    let stockpileKey = String(resourceKey || '');
    if (!stockpileKey) return 0;
    let amount = Number(delta);
    if (!Number.isFinite(amount) || amount === 0) return Number(player[stockpileKey]) || 0;
    let fixedMap = player._resourceFixedValues || (player._resourceFixedValues = {});
    let currentFixed = Number.isFinite(fixedMap[stockpileKey])
        ? Math.floor(fixedMap[stockpileKey])
        : _toFixedResourceUnits(Number(player[stockpileKey]) || 0);
    let deltaFixed = _toFixedResourceUnits(amount);
    fixedMap[stockpileKey] = currentFixed + deltaFixed;
    return _setPlayerResourceValue(pid, stockpileKey, _fromFixedResourceUnits(fixedMap[stockpileKey]));
}

// ============================================================
// SHRINES (SHRINES_ENABLED)
// ============================================================
// \uD83D\uDC80 is damage taken: the energy a player's units and buildings
// lose to damage (never below 0: overkill is not counted) goes to the
// player's shrine, player.shrine (fixed point in _resourceFixedValues.shrine,
// like energy). Not healing, splitting or stat changes: only the damage
// sites call shrineDamageTaken. Every tick shrineTick adds the tick's damage
// (summed as fixed-point integers: the order damage came in does not
// matter) and drains up to drainRate / TICK_RATE of it (research: building
// 'shrine') into energy and \u2605, times its multiplier, as the player set
// with the shrineDrain action (player.shrineDrain: 1 energy, 2 \u2605, 3
// half each, 0 none; 3 at the start). Shrines off (the game's setting): the
// shrine still counts damage taken, but nothing drains from it (the drain
// mode reads 0; the HUD has no drain buttons).
const SHRINE_DRAIN_ENERGY = 1, SHRINE_DRAIN_ASTAR = 2, SHRINE_DRAIN_DEFAULT = 3;
let _shrinePendingFixed = new Float64Array(8);
function shrineDamageTaken(target, amount) {
    if (!target || !(amount > 0)) return;
    let o = target.owner;
    if (!Number.isInteger(o) || o < 0) return;
    let after = Number(target.energy);
    let lost = after < 0 ? amount + after : amount;
    if (!(lost > 0)) return;
    if (o >= _shrinePendingFixed.length) { let a = new Float64Array(o + 8); a.set(_shrinePendingFixed); _shrinePendingFixed = a; }
    _shrinePendingFixed[o] += _toFixedResourceUnits(lost);
}
function getPlayerShrineDrainMode(playerId) {
    let p = players[playerId];
    if (!p || !SHRINES_ENABLED) return 0;
    return p.shrineDrain === undefined ? SHRINE_DRAIN_DEFAULT : (Math.floor(Number(p.shrineDrain)) || 0) & 3;
}
// What the player's shrine gives this tick: [shrine drained, energy, \u2605]
// (fixed units). The gain is take x multiplier, split by the drain order;
// the fractions below a fixed unit carry over to the next ticks
// (player.shrineCarry: [energy, \u2605], fixed units; simulation state),
// so a small multiplier still pays out at its exact rate.
function _shrineDrainFixed(pid, curFixed, mode, carry = null) {
    if (!(curFixed > 0) || !mode) return null;
    let rate = Number(getBuildingStatForOwner(pid, 'shrine', 1, 'drainRate'));
    if (!(rate > 0)) return null;
    // (A step of several base ticks (simDk): their drain.)
    let take = Math.min(curFixed, Math.max(1, Math.floor(rate * RESOURCE_FIXED_POINT_SCALE * simDk / Math.max(1, TICK_RATE))));
    let mult = Number(getBuildingStatForOwner(pid, 'shrine', 1, 'multiplier'));
    let gain = take * (mult > 0 ? mult : 0);
    let shareE = mode === SHRINE_DRAIN_ENERGY ? 1 : (mode === SHRINE_DRAIN_ASTAR ? 0 : 0.5);
    let e = gain * shareE + (carry ? carry[0] : 0), a = gain * (1 - shareE) + (carry ? carry[1] : 0);
    let toEnergy = Math.floor(e), toAstar = Math.floor(a);
    if (carry) { carry[0] = e - toEnergy; carry[1] = a - toAstar; }
    return [take, toEnergy, toAstar];
}
function shrineTick() {
    let P = _shrinePendingFixed;
    for (let pid = 0; pid < players.length; pid++) {
        let player = players[pid];
        if (!player) continue;
        let fixedMap = player._resourceFixedValues || (player._resourceFixedValues = {});
        let cur = Math.floor(Number(fixedMap.shrine) || 0);
        if (pid < P.length && P[pid] !== 0) { cur += P[pid]; P[pid] = 0; }
        let carry = null;
        if (SHRINES_ENABLED && cur > 0) {
            if (!Array.isArray(player.shrineCarry) || player.shrineCarry.length !== 2) player.shrineCarry = [0, 0];
            carry = player.shrineCarry;
        }
        let d = carry ? _shrineDrainFixed(pid, cur, getPlayerShrineDrainMode(pid), carry) : null;
        if (d) {
            cur -= d[0];
            if (d[1] > 0) {
                addPlayerResource(pid, 'energy', d[1] / RESOURCE_FIXED_POINT_SCALE);
                if (typeof recordEnergyDelta === 'function') recordEnergyDelta(pid, 'shrine', d[1] / RESOURCE_FIXED_POINT_SCALE);
            }
            if (d[2] > 0) {
                addPlayerResource(pid, 'astar', d[2] / RESOURCE_FIXED_POINT_SCALE);
                if (typeof recordAstarDelta === 'function') recordAstarDelta(pid, d[2] / RESOURCE_FIXED_POINT_SCALE, null, 'shrine');
            }
        }
        if (fixedMap.shrine !== undefined || cur !== 0) { fixedMap.shrine = cur; player.shrine = _fromFixedResourceUnits(cur); }
    }
}
// Nothing pending between ticks (a restore starts clean).
function shrineResetPending() { _shrinePendingFixed.fill(0); }

// A stockpile's penalty multiplier changed: refresh the stats it scales.
// While a stockpile is negative this runs on every upkeep payment, so it
// only touches penalty-scaled stats (exempt ones cannot have changed; research
// rebuilds its own stats) and resolves the multiplier once per stat.
// (multiplierOverride: the one a snapshot's tables were built with, see
// _statAppliedMult; else the current one.)
function rebuildPrecomputedStatsMapPlayerResource(playerId, resourceKey, multiplierOverride) {
    if (!ensurePrecomputedStatsMap()) return;
    let pid = Math.max(0, Math.floor(playerId || 0));
    let stockpileKey = String(resourceKey || '');
    if (!stockpileKey) return;

    // Every stat handled here is scaled by this one stockpile's multiplier.
    let multiplier = multiplierOverride >= 1 ? multiplierOverride : _getPlayerResourcePenaltyMultiplier(pid, stockpileKey);
    _statAppliedSet(pid, stockpileKey, multiplier);
    for (let [branch, statKeys] of [['unit', PRECOMPUTED_UNIT_STAT_KEYS], ['building', PRECOMPUTED_BUILDING_STAT_KEYS]]) {
        let scaled = statKeys.filter(statKey => !RESOURCE_PENALTY_EXEMPT_STATS.has(statKey) && _getResourceKeyForPrecomputedStat(branch, statKey) === stockpileKey);
        if (scaled.length === 0) continue;
        let playerEntry = _ensurePrecomputedStatsMapPlayerEntry(pid);
        for (let key in PRECOMPUTED_STATS_MAP[branch]) {
            let normalizedKey = branch === 'unit' ? _normalizePlayerPrecomputedUnitKey(key) : _normalizePlayerPrecomputedBuildingKey(key);
            let levels = playerEntry[branch][normalizedKey];
            let complete = !!levels && levels.length > MAX_THING_LEVEL;
            for (let statKey of scaled) {
                // A building stat with no value at any level stays NaN
                // whatever the multiplier (most buildings use few stats).
                if (complete && branch === 'building' && !_buildingStatHasValues(normalizedKey, statKey)) continue;
                _rebuildPlayerThingStatLevels(pid, branch, normalizedKey, statKey, multiplier);
            }
        }
    }
}

function getStartingThingId(kind, key) {
    return `${kind}:${key}`;
}

function ensureResearchThingsReady() {
    if (RESEARCH_THINGS.length > 0) return true;
    // Without the stats table every starting unit/building would be dropped
    // as unknown, so build it on demand.
    if (!ensurePrecomputedStatsMap()) rebuildPrecomputedStatsMap();
    if (!ensurePrecomputedStatsMap()) return false;
    rebuildResearchThings();
    return RESEARCH_THINGS.length > 0;
}

function ensureMainMenuPrecomputedStateReady() {
    if (!ensurePrecomputedStatsMap()) rebuildPrecomputedStatsMap();
    else ensureResearchThingsReady();
    startingResourcesConfig = normalizeStartingResourcesConfig(startingResourcesConfig);
    ensureStartingResourcesSelectedThing();
}

function normalizeStartingSpawnCount(value) {
    let count = Number(value);
    return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

function normalizeStartingResourcesConfig(rawCfg) {
    ensureResearchThingsReady();
    let raw = (rawCfg && typeof rawCfg === 'object') ? rawCfg : {};
    let out = {
        researchLevels: {},
        spawnCounts: {}
    };

    if (raw.researchLevels && typeof raw.researchLevels === 'object') {
        for (let id in raw.researchLevels) {
            let parsed = parseStartingThingId(id);
            if (!parsed) continue;
            let thing = getResearchThing(parsed.kind, parsed.key);
            if (!thing) continue;
            let levelMap = raw.researchLevels[id];
            if (typeof levelMap === 'object' && levelMap !== null) {
                for (let statKey in levelMap) {
                    if (!getResearchStatEntry(parsed.kind, parsed.key, statKey)) continue;
                    let lvl = Math.max(0, Math.min(MAX_RESEARCH_LEVEL, Math.floor(Number(levelMap[statKey]) || 0)));
                    if (!out.researchLevels[id]) out.researchLevels[id] = {};
                    if (lvl > 0) out.researchLevels[id][statKey] = lvl;
                }
                if (out.researchLevels[id] && Object.keys(out.researchLevels[id]).length === 0) delete out.researchLevels[id];
            }
        }
    }

    if (raw.spawnCounts && typeof raw.spawnCounts === 'object') {
        for (let id in raw.spawnCounts) {
            let parsed = parseStartingThingId(id);
            if (!parsed) continue;
            let thing = getResearchThing(parsed.kind, parsed.key);
            if (!thing) continue;
            // (Never placed: research levels only.)
            if (parsed.kind === 'building' && (BASE_CARD_TYPES[parsed.key] || {}).notBuildable) continue;
            let countMap = raw.spawnCounts[id];
            if (typeof countMap === 'object' && countMap !== null) {
                for (let levelText in countMap) {
                    let level = Math.max(1, Math.min(MAX_THING_LEVEL, Math.floor(Number(levelText) || 0)));
                    let count = normalizeStartingSpawnCount(countMap[levelText]);
                    if (!out.spawnCounts[id]) out.spawnCounts[id] = {};
                    if (count > 0) out.spawnCounts[id][level] = count;
                }
                if (out.spawnCounts[id] && Object.keys(out.spawnCounts[id]).length === 0) delete out.spawnCounts[id];
            }
        }
    }

    return out;
}

function resetStartingResourcesConfig() {
    startingResourcesConfig = normalizeStartingResourcesConfig(makeDefaultStartingResourcesConfig());
    refreshStartingResourcesPreviewPrecomputedStats();
}

function ensureStartingResourcesSelectedThing() {
    if (!ensureResearchThingsReady()) {
        startingResourcesSelectedThingId = '';
        return;
    }
    let parsed = parseStartingThingId(startingResourcesSelectedThingId);
    if (parsed && getResearchThing(parsed.kind, parsed.key)) return;
    let first = RESEARCH_THINGS[0];
    if (!first) {
        startingResourcesSelectedThingId = '';
        return;
    }
    startingResourcesSelectedThingId = getStartingThingId(first.kind, first.key);
}

function setStartingResearchLevel(thingId, statKey, value) {
    let lvl = Math.max(0, Math.min(MAX_RESEARCH_LEVEL, Math.floor(Number(value) || 0)));
    let parsed = parseStartingThingId(thingId);
    if (!startingResourcesConfig.researchLevels[thingId]) startingResourcesConfig.researchLevels[thingId] = {};
    if (lvl <= 0) {
        delete startingResourcesConfig.researchLevels[thingId][statKey];
        if (Object.keys(startingResourcesConfig.researchLevels[thingId]).length <= 0) {
            delete startingResourcesConfig.researchLevels[thingId];
        }
        if (!gameStarted && parsed) {
            for (let playerId = 0; playerId < players.length; playerId++) {
                rebuildPrecomputedStatsMapPlayerThingStat(playerId, parsed.kind, parsed.key, statKey);
            }
        }
        return;
    }
    startingResourcesConfig.researchLevels[thingId][statKey] = lvl;
    if (!gameStarted && parsed) {
        for (let playerId = 0; playerId < players.length; playerId++) {
            rebuildPrecomputedStatsMapPlayerThingStat(playerId, parsed.kind, parsed.key, statKey);
        }
    }
}

function setStartingSpawnCount(thingId, level, value) {
    let lvl = Math.max(1, Math.min(MAX_THING_LEVEL, Math.floor(Number(level) || 1)));
    let count = Math.min(getStartingSpawnMaxForRow(thingId, lvl), normalizeStartingSpawnCount(value));
    if (!startingResourcesConfig.spawnCounts[thingId]) startingResourcesConfig.spawnCounts[thingId] = {};
    if (count <= 0) {
        delete startingResourcesConfig.spawnCounts[thingId][lvl];
        if (Object.keys(startingResourcesConfig.spawnCounts[thingId]).length <= 0) {
            delete startingResourcesConfig.spawnCounts[thingId];
        }
        return;
    }
    startingResourcesConfig.spawnCounts[thingId][lvl] = count;
}

function getStartingResourcesMaxPopulation() {
    let el = document.getElementById('cfg-max-pop');
    if (el) return Math.max(1, Math.floor(Number(el.value) || 200));
    return Math.max(1, Math.floor(Number(CONFIG_MAX_POP) || 200));
}

function getStartingResourcesTotalSpawnCount() {
    let total = 0;
    let map = (startingResourcesConfig && startingResourcesConfig.spawnCounts) || {};
    for (let thingId in map) {
        let parsed = parseStartingThingId(thingId);
        if (!parsed || parsed.kind !== 'unit') continue;
        let lvlMap = map[thingId] || {};
        for (let lvl in lvlMap) total += Math.max(0, Math.floor(Number(lvlMap[lvl]) || 0));
    }
    return total;
}

function getStartingSpawnCount(thingId, level) {
    let lvl = Math.max(1, Math.min(MAX_THING_LEVEL, Math.floor(Number(level) || 1)));
    let map = (startingResourcesConfig.spawnCounts && startingResourcesConfig.spawnCounts[thingId]) || {};
    return Math.max(0, Math.floor(Number(map[lvl]) || 0));
}

function getStartingSpawnMaxForRow(thingId, level) {
    let parsed = parseStartingThingId(thingId);
    if (!parsed || parsed.kind !== 'unit') return Infinity;
    let maxPop = getStartingResourcesMaxPopulation();
    let current = getStartingSpawnCount(thingId, level);
    let total = getStartingResourcesTotalSpawnCount();
    return Math.max(0, maxPop - Math.max(0, total - current));
}

function adjustStartingResearchLevelDelta(thingId, statKey, delta) {
    let parsed = parseStartingThingId(thingId);
    if (!parsed) return;
    if (!getResearchStatEntry(parsed.kind, parsed.key, statKey)) return;
    let cur = 0;
    if (startingResourcesConfig.researchLevels[thingId] && Number.isFinite(startingResourcesConfig.researchLevels[thingId][statKey])) {
        cur = Math.floor(startingResourcesConfig.researchLevels[thingId][statKey]);
    }
    let next = Math.max(0, Math.min(MAX_RESEARCH_LEVEL, cur + Math.floor(Number(delta) || 0)));
    setStartingResearchLevel(thingId, statKey, next);
}

function adjustStartingSpawnCountDelta(thingId, level, delta) {
    let lvl = Math.max(1, Math.min(MAX_THING_LEVEL, Math.floor(Number(level) || 1)));
    let cur = getStartingSpawnCount(thingId, lvl);
    let maxRow = getStartingSpawnMaxForRow(thingId, lvl);
    let next = Math.max(0, Math.min(maxRow, cur + Math.floor(Number(delta) || 0)));
    setStartingSpawnCount(thingId, lvl, next);
}


const RESOURCE_ABUNDANCE_PRESETS = [
    0,
    ...Array.from({ length: 10 }, (_, i) => 1000 * 2 ** i),
    ...Array.from({ length: 10 }, (_, i) => 1e6 * 2 ** i),
    ...[1e9, 1e12, 1e15].flatMap(scale => Array.from({ length: 5 }, (_, i) => scale * 4 ** i)),
    1e18
].map(amount => ({ value: String(amount), name: _resourceReserveLabel(amount) }));
const RESOURCE_ABUNDANCE_CONTROLS = [
    { id: 'cfg-gold-abundance', fields: ['cfg-gold-count', 'cfg-gold-min', 'cfg-gold-max'] },
    { id: 'cfg-astar-abundance', fields: ['cfg-astar-mine-count', 'cfg-astar-mine-min', 'cfg-astar-mine-max'] }
];
// Initial absolute values match the default 60x60 map, 8K energy / 16K stars per mine and 10% density. Keeping
// these controls allows existing exports and advanced configs to retain
// their exact settings while the regular menu uses fixed per-mine presets.
const _resourceAbundanceState = new Map(RESOURCE_ABUNDANCE_CONTROLS.map(c => {
    const amount = c.id === 'cfg-gold-abundance' ? '8000' : '16000';
    return [c.id, { preset: amount, absolute: `180,${amount},${amount}` }];
}));

function deriveResourceAbundance(value, width, height = width, density = 10) {
    const preset = RESOURCE_ABUNDANCE_PRESETS.find(p => p.value === String(value));
    if (!preset) return null;
    const amount = Number(preset.value);
    const area = Math.max(8, Math.floor(Number(width) || 60)) * Math.max(8, Math.floor(Number(height) || 60));
    // Each resource has half the density budget. Disabling one resource
    // leaves the other resource's count unchanged.
    const count = amount === 0 ? 0 : Math.floor(area * normalizeResourceMineDensity(density) / 200);
    return { count, min: amount, max: amount, total: count * amount };
}

function normalizeResourceMineDensity(value) {
    const number = String(value ?? '').trim() === '' ? NaN : Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(95, number)) : 10;
}

function _resourceReserveLabel(amount) {
    for (const [scale, suffix] of [[1e18, 'Qi'], [1e15, 'Qa'], [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
        if (amount >= scale) return `${Number((amount / scale).toFixed(3))}${suffix}`;
    }
    return String(Math.round(amount));
}

function refreshResourceAbundanceMenu(force = false) {
    const size = Number((document.getElementById('cfg-mapsize') || {}).value) || GRID_W;
    const density = normalizeResourceMineDensity((document.getElementById('cfg-mine-density') || {}).value);
    for (const control of RESOURCE_ABUNDANCE_CONTROLS) {
        const select = document.getElementById(control.id);
        const fields = control.fields.map(id => document.getElementById(id));
        if (!select || fields.some(el => !el)) continue;
        const state = _resourceAbundanceState.get(control.id);
        const absolute = fields.map(el => String(el.value)).join(',');
        const derived = deriveResourceAbundance(select.value, size, size, density);
        if (derived && (force || select.value !== state.preset || absolute === state.absolute)) {
            [derived.count, derived.min, derived.max].forEach((value, i) => { fields[i].value = String(value); });
        } else if (!derived || absolute !== state.absolute) select.value = 'custom';
        state.preset = select.value;
        state.absolute = fields.map(el => String(el.value)).join(',');
        for (const option of select.options) {
            const preset = RESOURCE_ABUNDANCE_PRESETS.find(p => p.value === option.value);
            if (preset) {
                option.textContent = preset.name;
            } else if (option.value === 'custom') {
                const [, min, max] = fields.map(el => Math.max(0, Number(el.value) || 0));
                option.hidden = select.value !== 'custom';
                option.textContent = `Custom (${min !== max ? '≈' : ''}${_resourceReserveLabel((min + max) / 2)})`;
            }
        }
        const [count, min, max] = fields.map(el => Math.max(0, Number(el.value) || 0));
        select.title = `${min.toLocaleString('en-US')}${min !== max ? '–' + max.toLocaleString('en-US') : ''} per mine; up to ${count.toLocaleString('en-US')} mines on a ${size}×${size} map.`;
    }
}

function syncResourceAbundanceFromRuntime() {
    const settings = [[GOLD_MINE_COUNT, GOLD_MINE_MIN, GOLD_MINE_MAX], [ASTAR_MINE_COUNT, ASTAR_MINE_MIN, ASTAR_MINE_MAX]];
    RESOURCE_ABUNDANCE_CONTROLS.forEach((control, i) => {
        const select = document.getElementById(control.id);
        if (!select) return;
        const values = settings[i];
        const matches = preset => {
            const d = deriveResourceAbundance(preset.value, GRID_W, GRID_H, RESOURCE_MINE_DENSITY);
            return d.count === values[0] && d.min === values[1] && d.max === values[2];
        };
        const preset = RESOURCE_ABUNDANCE_PRESETS.find(p => p.value === select.value && matches(p))
            || RESOURCE_ABUNDANCE_PRESETS.find(matches);
        select.value = preset ? preset.value : 'custom';
        const state = _resourceAbundanceState.get(control.id);
        state.preset = select.value; state.absolute = values.join(',');
    });
    refreshResourceAbundanceMenu();
}

function initResourceAbundanceMenu() {
    refreshResourceAbundanceMenu();
    for (const id of ['cfg-mapsize', 'cfg-mine-density', ...RESOURCE_ABUNDANCE_CONTROLS.map(c => c.id)]) {
        const el = document.getElementById(id);
        if (!el || el.dataset.resourceAbundanceInit) continue;
        el.dataset.resourceAbundanceInit = '1';
        el.addEventListener('change', () => refreshResourceAbundanceMenu(true));
    }
}

function parseConfigEditorObject(text) {
    let src = String(text || '').trim();
    if (!src) throw new Error('Config editor is empty.');
    let obj = (new Function('"use strict"; return (' + src + ');'))();
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error('Config must evaluate to an object literal.');
    }
    return obj;
}


function createEditableRuntimeConfigSnapshot() {
    return {
        version: 1,
        config: {
            MINIMAP_SIZE,
            TILE,
            GRID_W,
            GRID_H,
            RESOURCE_MINE_DENSITY,
            GOLD_MINE_COUNT,
            GOLD_MINE_MIN,
            GOLD_MINE_MAX,
            GOLD_MINE_AREA,
            ASTAR_MINE_COUNT,
            ASTAR_MINE_MIN,
            ASTAR_MINE_MAX,
            STARTING_MONEY,
            STARTING_ASTAR,
            SHRINES_ENABLED: !!SHRINES_ENABLED,
            MAP_TYPE,
            GAME_MODE: gameMode,
            // During a match the setting, not a spectator's local full view.
            MAP_VISIBILITY: (gameStarted ? matchFullVisibility : fullVisibility) ? 'full' : teamVisibilityHistory ? 'history' : 'team',
            TYPE_FLOOR,
            TYPE_WALL,
            CONFIG_MAX_POP,
            TICK_RATE,
            LOCKSTEP_PIPELINE_MIN,
            THING_STATS_RECALC_INTERVAL_SECONDS,
            LOCKSTEP_STRICT_DEBUG_MODE: !!lockstepStrictDebugMode,
            FAIR_INPUT_DELAY: !!netFairInputDelay,
            UNIT_EFFECTIVE_STATS_RECALC_TICKS,
            UNIT_COLLISION_RECALC_TICKS,
            ASTAR_MAX_ITERS_LIMIT,
            ASTAR_ITER_BUDGET_PER_PLAYER_TICK,
            WORKER_AI_TICK_DELAY,
        },
        progression: {
            RESEARCH_COST_EXP,
            RESEARCH_WORK_EXP,
            RESEARCH_WORK_BASE,
            MAX_THING_LEVEL,
            MAX_RESEARCH_LEVEL,
        },
        tables: {
            THING_STATS: cloneJsValue(THING_STATS),
            BUILD_CATEGORIES: cloneJsValue(BUILD_CATEGORIES),
            RESEARCH_STAT_LABELS: cloneJsValue(RESEARCH_STAT_LABELS),
        }
    };
}

function serializeEditableRuntimeConfigForTransport() {
    return encodeFunctionsForTransport(createEditableRuntimeConfigSnapshot());
}

function ensureDefaultEditableRuntimeConfigSnapshot() {
    ensureMainMenuPrecomputedStateReady();
    if (defaultEditableRuntimeConfigSnapshot) return;
    defaultEditableRuntimeConfigSnapshot = cloneJsValue(createEditableRuntimeConfigSnapshot());
}

function syncMainMenuFromRuntimeConfig() {
    let setValue = (id, value) => {
        let el = document.getElementById(id);
        if (!el) return;
        el.value = String(value);
    };

    setValue('cfg-mapsize', GRID_W);
    setValue('cfg-mine-density', RESOURCE_MINE_DENSITY);
    setValue('cfg-gold-count', GOLD_MINE_COUNT);
    setValue('cfg-gold-min', GOLD_MINE_MIN);
    setValue('cfg-gold-max', GOLD_MINE_MAX);
    setValue('cfg-astar-mine-count', ASTAR_MINE_COUNT);
    setValue('cfg-astar-mine-min', ASTAR_MINE_MIN);
    setValue('cfg-astar-mine-max', ASTAR_MINE_MAX);
    syncResourceAbundanceFromRuntime();
    setValue('cfg-max-pop', CONFIG_MAX_POP);
    setValue('cfg-starting-energy', STARTING_MONEY);
    setValue('cfg-starting-astar', STARTING_ASTAR);
    setValue('cfg-map-type', MAP_TYPE);
    setValue('cfg-gamemode', gameMode);
    setValue('cfg-full-vis', fullVisibility ? 'full' : teamVisibilityHistory ? 'history' : 'team');
    setValue('cfg-tick-rate', TICK_RATE);
    setValue('cfg-pipeline-delay', LOCKSTEP_PIPELINE_MIN);
    setValue('cfg-thing-stats-seconds', THING_STATS_RECALC_INTERVAL_SECONDS);
    let exactLockstepEl = document.getElementById('cfg-exact-lockstep');
    if (exactLockstepEl) exactLockstepEl.checked = !!lockstepStrictDebugMode;
    let fairDelayEl = document.getElementById('cfg-fair-delay');
    if (fairDelayEl) fairDelayEl.checked = !!netFairInputDelay;
    setValue('cfg-unit-eff-stats-ticks', UNIT_EFFECTIVE_STATS_RECALC_TICKS);
    setValue('cfg-unit-collision-ticks', UNIT_COLLISION_RECALC_TICKS);
    setValue('cfg-astar-iter-budget-per-player', ASTAR_ITER_BUDGET_PER_PLAYER_TICK);
    setValue('cfg-worker-ai-tick-delay', WORKER_AI_TICK_DELAY);
    setValue('cfg-max-thing-level', MAX_THING_LEVEL);
    setValue('cfg-max-research-level', MAX_RESEARCH_LEVEL);
    let shrinesEl = document.getElementById('cfg-shrines');
    if (shrinesEl) shrinesEl.checked = !!SHRINES_ENABLED;
}

function applyEditableRuntimeConfigObject(rawConfig, options = null) {
    let opts = options && typeof options === 'object' ? options : {};
    let cfgObject = rawConfig;
    if (opts.fromTransport) cfgObject = decodeFunctionsFromTransport(cfgObject);

    if (!cfgObject || typeof cfgObject !== 'object' || Array.isArray(cfgObject)) {
        throw new Error('Runtime config must be an object.');
    }

    let cfg = (cfgObject.config && typeof cfgObject.config === 'object') ? cfgObject.config : {};
    let prog = (cfgObject.progression && typeof cfgObject.progression === 'object') ? cfgObject.progression : {};
    let tables = (cfgObject.tables && typeof cfgObject.tables === 'object') ? cfgObject.tables : {};

    if (Number.isFinite(Number(cfg.MINIMAP_SIZE))) MINIMAP_SIZE = Math.max(32, Math.floor(Number(cfg.MINIMAP_SIZE)));
    if (Number.isFinite(Number(cfg.TILE))) TILE = Math.max(8, Math.floor(Number(cfg.TILE)));
    if (Number.isFinite(Number(cfg.TYPE_FLOOR))) TYPE_FLOOR = Math.floor(Number(cfg.TYPE_FLOOR));
    if (Number.isFinite(Number(cfg.TYPE_WALL))) TYPE_WALL = Math.floor(Number(cfg.TYPE_WALL));

    let nextGridW = Number(cfg.GRID_W);
    let nextGridH = Number(cfg.GRID_H);
    if (Number.isFinite(nextGridW)) GRID_W = Math.max(8, Math.floor(nextGridW));
    if (Number.isFinite(nextGridH)) GRID_H = Math.max(8, Math.floor(nextGridH));
    else GRID_H = GRID_W;
    WORLD_W = GRID_W * TILE;
    WORLD_H = GRID_H * TILE;

    if (cfg.RESOURCE_MINE_DENSITY !== undefined) RESOURCE_MINE_DENSITY = normalizeResourceMineDensity(cfg.RESOURCE_MINE_DENSITY);
    if (Number.isFinite(Number(cfg.GOLD_MINE_COUNT))) GOLD_MINE_COUNT = Math.max(0, Math.floor(Number(cfg.GOLD_MINE_COUNT)));
    if (Number.isFinite(Number(cfg.GOLD_MINE_MIN))) GOLD_MINE_MIN = Math.max(0, Math.floor(Number(cfg.GOLD_MINE_MIN)));
    if (Number.isFinite(Number(cfg.GOLD_MINE_MAX))) GOLD_MINE_MAX = Math.max(0, Math.floor(Number(cfg.GOLD_MINE_MAX)));
    if (Number.isFinite(Number(cfg.GOLD_MINE_AREA))) GOLD_MINE_AREA = Math.max(1, Math.floor(Number(cfg.GOLD_MINE_AREA)));
    if (Number.isFinite(Number(cfg.ASTAR_MINE_COUNT))) ASTAR_MINE_COUNT = Math.max(0, Math.floor(Number(cfg.ASTAR_MINE_COUNT)));
    if (Number.isFinite(Number(cfg.ASTAR_MINE_MIN))) ASTAR_MINE_MIN = Math.max(0, Math.floor(Number(cfg.ASTAR_MINE_MIN)));
    if (Number.isFinite(Number(cfg.ASTAR_MINE_MAX))) ASTAR_MINE_MAX = Math.max(0, Math.floor(Number(cfg.ASTAR_MINE_MAX)));
    if (Number.isFinite(Number(cfg.STARTING_MONEY))) STARTING_MONEY = Math.max(0, Math.floor(Number(cfg.STARTING_MONEY)));
    if (Number.isFinite(Number(cfg.STARTING_ASTAR))) STARTING_ASTAR = Math.max(0, Number(cfg.STARTING_ASTAR));
    if (cfg.SHRINES_ENABLED !== undefined) SHRINES_ENABLED = !!cfg.SHRINES_ENABLED;
    if (typeof cfg.MAP_TYPE === 'string' && cfg.MAP_TYPE.trim()) MAP_TYPE = cfg.MAP_TYPE.trim();
    if (['destroy', 'killking'].includes(cfg.GAME_MODE)) gameMode = cfg.GAME_MODE;
    if (['full', 'team', 'history'].includes(cfg.MAP_VISIBILITY)) {
        fullVisibility = cfg.MAP_VISIBILITY === 'full';
        teamVisibilityHistory = cfg.MAP_VISIBILITY === 'history';
    }
    if (Number.isFinite(Number(cfg.CONFIG_MAX_POP))) CONFIG_MAX_POP = Math.max(1, Math.floor(Number(cfg.CONFIG_MAX_POP)));

    let nextTickRate = Number(cfg.TICK_RATE);
    let nextPipelineDelay = Number(cfg.LOCKSTEP_PIPELINE_MIN);
    applyTimingConfig(nextTickRate, nextPipelineDelay);
    if (Number.isFinite(Number(cfg.THING_STATS_RECALC_INTERVAL_SECONDS))) {
        THING_STATS_RECALC_INTERVAL_SECONDS = Math.max(0.05, Math.min(600, Number(cfg.THING_STATS_RECALC_INTERVAL_SECONDS)));
    }
    if (cfg.LOCKSTEP_STRICT_DEBUG_MODE !== undefined) {
        lockstepStrictDebugMode = !!cfg.LOCKSTEP_STRICT_DEBUG_MODE;
    }
    if (cfg.FAIR_INPUT_DELAY !== undefined) netFairInputDelay = !!cfg.FAIR_INPUT_DELAY;
    if (Number.isFinite(Number(cfg.UNIT_EFFECTIVE_STATS_RECALC_TICKS))) {
        UNIT_EFFECTIVE_STATS_RECALC_TICKS = Math.max(1, Math.min(240, Math.floor(Number(cfg.UNIT_EFFECTIVE_STATS_RECALC_TICKS))));
    }
    if (Number.isFinite(Number(cfg.UNIT_COLLISION_RECALC_TICKS))) {
        UNIT_COLLISION_RECALC_TICKS = Math.max(1, Math.min(240, Math.floor(Number(cfg.UNIT_COLLISION_RECALC_TICKS))));
    }
    if (Number.isFinite(Number(cfg.ASTAR_MAX_ITERS_LIMIT))) {
        ASTAR_MAX_ITERS_LIMIT = Math.max(256, Math.min(18000, Math.floor(Number(cfg.ASTAR_MAX_ITERS_LIMIT))));
    }
    if (Number.isFinite(Number(cfg.ASTAR_ITER_BUDGET_PER_PLAYER_TICK))) {
        ASTAR_ITER_BUDGET_PER_PLAYER_TICK = Math.max(256, Math.min(500000, Math.floor(Number(cfg.ASTAR_ITER_BUDGET_PER_PLAYER_TICK))));
    }
    let workerAiTickDelay = Number(cfg.WORKER_AI_TICK_DELAY);
    if (!Number.isFinite(workerAiTickDelay)) workerAiTickDelay = Number(cfg.WORKER_HEAVY_AI_STRIDE);
    if (Number.isFinite(workerAiTickDelay)) {
        WORKER_AI_TICK_DELAY = Math.max(1, Math.min(60, Math.floor(workerAiTickDelay)));
    }

    if (Number.isFinite(Number(prog.RESEARCH_COST_EXP))) RESEARCH_COST_EXP = Math.max(1, Number(prog.RESEARCH_COST_EXP));
    if (Number.isFinite(Number(prog.RESEARCH_WORK_EXP))) RESEARCH_WORK_EXP = Math.max(1, Number(prog.RESEARCH_WORK_EXP));
    if (Number.isFinite(Number(prog.RESEARCH_WORK_BASE))) RESEARCH_WORK_BASE = Math.max(1, Math.floor(Number(prog.RESEARCH_WORK_BASE)));
    if (Number.isFinite(Number(prog.MAX_THING_LEVEL))) MAX_THING_LEVEL = Math.max(1, Math.floor(Number(prog.MAX_THING_LEVEL)));
    if (Number.isFinite(Number(prog.MAX_RESEARCH_LEVEL))) MAX_RESEARCH_LEVEL = Math.max(1, Math.floor(Number(prog.MAX_RESEARCH_LEVEL)));
    // Backward compatibility for older config payloads.


    if (tables.THING_STATS) {
        validateThingStats(tables.THING_STATS);
        replaceObjectContents(THING_STATS, tables.THING_STATS);
    }
    else importLegacyThingTables(tables,prog);
    if (tables.BUILD_CATEGORIES) replaceObjectContents(BUILD_CATEGORIES, tables.BUILD_CATEGORIES);
    if (tables.RESEARCH_STAT_LABELS) replaceObjectContents(RESEARCH_STAT_LABELS, tables.RESEARCH_STAT_LABELS);
    rebuildThingDefinitionViews();
    normalizeBaseCardDefinitions();
    PRECOMPUTED_STATS_READY = false;
    if (!opts.deferPrecompute) rebuildPrecomputedStatsMap();
    startingResourcesConfig = normalizeStartingResourcesConfig(startingResourcesConfig);
    refreshStartingResourcesPreviewPrecomputedStats();
    syncMainMenuFromRuntimeConfig();
}

// Old snapshots used separate base-stat tables. Import their base values into the
// unified definitions; subsequent exports contain only THING_STATS.
function importLegacyThingTables(tables, progression = {}) {
    for (const [kind, table] of [['unit',tables.BASE_UNIT_STATS],['building',tables.BASE_CARD_TYPES]]) {
        for (const [key, old] of Object.entries(table || {})) {
            const thing = THING_STATS[key];
            if (!thing || thing.kind !== kind) continue;
            if (typeof old.unitType === 'string') thing.spawns = old.unitType;
            for (const [field,value] of Object.entries(old)) {
                if (['unitType','energyCost','towerEnergy','maxAttackRange','minAttackCooldown','maxVisionRange','rangeGrowthPerLevel'].includes(field)) continue;
                const stat = kind === 'building' && field === 'energy' ? 'maxEnergy' : field;
                if (thing.stats[stat] && Number.isFinite(value)) {
                    if (!thing.stats[stat].from) thing.stats[stat].base = value;
                } else if (typeof value !== 'number' && field !== 'stats') thing[field] = value;
            }
            if (Number.isFinite(old.maxAttackRange) && thing.stats.attackRange) thing.stats.attackRange.softCap = old.maxAttackRange;
            if (Number.isFinite(old.minAttackCooldown) && thing.stats.atkCd) thing.stats.atkCd.softCap = old.minAttackCooldown;
            if (Number.isFinite(old.rangeGrowthPerLevel) && thing.stats.attackRange) thing.stats.attackRange.level.linear = old.rangeGrowthPerLevel;
            if (Number.isFinite(old.maxVisionRange) && thing.stats.visionRange) thing.stats.visionRange.level.max = old.maxVisionRange;
        }
    }
    for (const [key, old] of Object.entries(tables.BARRACK_SPAWN_CONFIG || {})) {
        const stat = THING_STATS[key]?.stats.trainingTime;
        if (!stat) continue;
        if (Number.isFinite(old.baseTime)) stat.base = old.baseTime;
        if (Number.isFinite(old.reduction)) stat.level.factor = 1-old.reduction;
    }
    for (const [key,thing] of Object.entries(THING_STATS)) {
        if (thing.kind !== 'unit') continue;
        const c = tables.UNIT_LEVEL_SCALING?.[key] || tables.UNIT_LEVEL_SCALING?._default;
        if (c) {
            for (const [stat,field] of [['energy','energyExp'],['atk','dmgExp'],['speed','speedExp'],['atkCd','cdExp'],['visionRange','visionExp']]) {
                if (Number.isFinite(c[field])) thing.stats[stat].level.factor = c[field];
            }
            if (Number.isFinite(c.minCd)) thing.stats.atkCd.level.min = c.minCd;
            if (Number.isFinite(c.speedCapAbs)) thing.stats.speed.level.max = c.speedCapAbs;
            else if (Number.isFinite(c.speedCapMul)) thing.stats.speed.level.max = thing.stats.speed.base*c.speedCapMul;
            if (Number.isFinite(c.visionCapBonus)) thing.stats.visionRange.level.max = thing.stats.visionRange.base+c.visionCapBonus;
            thing.stats.attackRange.level.factor = c.rangeExp ?? c.visionExp ?? thing.stats.attackRange.level.factor;
            thing.stats.attackRange.level.max = thing.stats.attackRange.base+(c.rangeCapBonus ?? c.visionCapBonus ?? 1.2);
        }
        const eligible = tables.RESEARCHABLE_UNIT_STATS?.[key] || tables.RESEARCHABLE_UNIT_STATS?._default;
        if (eligible) for (const [stat,rule] of Object.entries(thing.stats)) rule.researchable = eligible.includes(stat);
    }
    for (const [key,description] of Object.entries(tables.DESCRIPTIONS || {})) if (THING_STATS[key]) THING_STATS[key].description = description;
    const building = tables.BUILDING_FORMULA_CONFIG || {}, unit = tables.UNIT_FORMULA_CONFIG || {}, research = tables.RESEARCH_FORMULA_CONFIG || {};
    for (const [key,thing] of Object.entries(THING_STATS)) {
        const stats = thing.stats, isUnit = thing.kind === 'unit';
        const setLevel = (stat,field,value) => { if (stats[stat] && Number.isFinite(value)) stats[stat].level[field] = value; };
        if (isUnit) {
            setLevel('upKeep','factor',progression.UNIT_UPKEEP_EXP);
            setLevel('astarCost','factor',unit.astarCostLevelExp);
            if (stats.gatherPerTrip?.base > 0) setLevel('gatherPerTrip','power',unit.collectorGatherLevelExp);
            if (thing.isWorker) setLevel('transferCooldown','factor',unit.workerTransferCooldownLevelExp);
            for (const stat of ['builderDps','healerDps','researcherDps']) if (stats[stat]?.base > 0) setLevel(stat,'factor',unit.workerSpecialistLevelExp);
        } else {
            setLevel('upKeep','factor',building.upKeepExp ?? progression.BUILDING_UPKEEP_EXP);
            setLevel('maxEnergy','factor',building.energyLevelExp);
            for (const stat of ['damage','blastDamage','burnDps','poisonDps','freezeDps']) if (stats[stat]?.level.factor !== undefined) setLevel(stat,'factor',stats[stat].level.factor === 1.6 ? building.levelMultExp : building.damageLevelExp);
            if (thing.target === 'wall') setLevel('visionRange','linear',building.linearVisionBonusPerLevel);
            if (key === 'house') setLevel('popCap','factor',building.levelMultExp);
            if (key === 'research') { setLevel('efficiency','factor',building.researchEfficiencyLevelExp); setLevel('efficiency','max',building.researchEfficiencyCap); }
            if (['pistol','smg','water'].includes(key)) {
                if (Number.isFinite(building.linearCdReductionPerLevel)) setLevel('cd','linear',-building.linearCdReductionPerLevel);
                setLevel('cd','min',building.directTowerCdFloor);
            }
            if (key === 'sand_gun') setLevel('cd','factor',building.sandGunCdLevelExp);
            if (['farm','astar_farm'].includes(key)) { setLevel('multiplier','coefficient',building.farmLevelPolyCoeff); setLevel('multiplier','power',building.farmLevelPowerExp); }
            const durationFields = {fire:['burnDuration','fireBurnDurationLevelAdd'],poison:['poisonDuration','poisonDurationLevelAdd'],ice:['freezeDuration','iceFreezeDurationLevelAdd'],water:['wetDuration','waterWetDurationLevelAdd'],watch_tower:['watchDuration','watchDurationLevelAdd']};
            if (durationFields[key]) { const [stat,field] = durationFields[key]; setLevel(stat,'add',building[field]); }
            if (key === 'elements') for (const stat of ['burnDuration','poisonDuration','freezeDuration']) setLevel(stat,'add',building.elementsDurationLevelAdd);
        }
        if (key === 'scout') setLevel('watchDuration','add',building.watchDurationLevelAdd);
        for (const [stat,rule] of Object.entries(stats)) {
            let factor = isUnit ? progression.RESEARCH_BONUS_EXP_UNITS : progression.RESEARCH_BONUS_EXP_OTHER;
            if (stat === 'visionRange') factor = isUnit ? research.unitVisionRangeBonusExp : research.buildingVisionRangeBonusExp;
            if (isUnit && stat === 'attackRange') factor = research.unitAttackRangeBonusExp;
            if (stat === 'unitPrice') factor = research.unitPriceBonusExp;
            if (stat === 'popCap') factor = progression.RESEARCH_BONUS_EXP_OTHER_HOUSE_POPCAP;
            if (key === 'shrine') factor = stat === 'multiplier' ? research.shrineMultiplierBonusExp : stat === 'drainRate' ? research.shrineDrainRateBonusExp : factor;
            if (Number.isFinite(factor)) rule.research.factor = factor;
        }
    }
}

function validateThingStats(table) {
    const checkReference = (id, seen = new Set()) => {
        if (seen.has(id)) throw Error('Cyclic stat reference: '+id);
        seen.add(id);
        const [key,stat] = id.split('.'), rule = table[key]?.stats?.[stat];
        if (!rule) throw Error('Unknown stat reference: '+id);
        if (rule.from) checkReference(rule.from,seen);
    };
    for (const [key,thing] of Object.entries(table)) {
        if (!['unit','building'].includes(thing.kind) || !thing.stats) throw Error('Invalid thing: '+key);
        for (const [stat,rule] of Object.entries(thing.stats)) {
            const id = key+'.'+stat;
            if (!rule || typeof rule.researchable !== 'boolean') throw Error('Missing researchable flag: '+id);
            if (rule.from) checkReference(id);
            else if (rule.base !== null && !Number.isFinite(rule.base)) throw Error('Invalid stat base: '+id);
            if (rule.researchable && (!(rule.research?.factor >= 1) || !Number.isFinite(rule.research.factor) || !['increase','decrease'].includes(rule.research.direction))) throw Error('Invalid research rule: '+id);
            const level = rule.level || {};
            if (level.model && !['population','farm'].includes(level.model)) throw Error('Unknown level model: '+id);
            for (const field of ['factor','linear','power','add','offset','coefficient','min','max']) if (level[field] !== undefined && !Number.isFinite(level[field])) throw Error('Invalid level '+field+': '+id);
            for (const limits of [rule,level]) if (Number.isFinite(limits.min) && Number.isFinite(limits.max) && limits.min > limits.max) throw Error('Inverted stat limits: '+id);
            if (rule.softCap !== null && rule.softCap !== undefined && !(Number.isFinite(rule.softCap) && rule.softCap >= 0) && rule.softCap?.model !== 'populationLimit') throw Error('Invalid soft cap: '+id);
        }
    }
}

function normalizeBaseCardDefinitions() { rebuildThingDefinitionViews(); }

function makeConfigEditorTextFromCurrentConfig() {
    return stringifyJsLike(gameStarted ? createEditableRuntimeConfigSnapshot() : createEditableRuntimeConfigSnapshotFromMainMenu());
}

function setConfigPopupOpen(open) {
    let popup = document.getElementById('config-popup');
    if (!popup) return false;
    let wasOpen = !popup.classList.contains('hidden');
    popup.classList.toggle('hidden', !open);
    if (open) {
        ensureDefaultEditableRuntimeConfigSnapshot();
        let ta = document.getElementById('config-editor-text');
        if (ta) ta.value = makeConfigEditorTextFromCurrentConfig();
    }
    return wasOpen !== open;
}

function setOptimizationPopupOpen(open) {
    let popup = document.getElementById('optimization-popup');
    if (!popup) return false;
    let wasOpen = !popup.classList.contains('hidden');
    popup.classList.toggle('hidden', !open);
    return wasOpen !== open;
}

function applyConfigEditorChanges() {
    let ta = document.getElementById('config-editor-text');
    if (!ta) return;
    try {
        let parsed = parseConfigEditorObject(ta.value);
        applyEditableRuntimeConfigObject(parsed);
        ta.value = makeConfigEditorTextFromCurrentConfig();
        showUiBanner('Runtime config applied.', 'success');
    } catch (err) {
        showUiBanner(`Config parse/apply error: ${err && err.message ? err.message : 'Unknown error'}`, 'error', 3600);
    }
}

function resetConfigEditorToDefaults() {
    ensureDefaultEditableRuntimeConfigSnapshot();
    if (!confirm('Reset runtime config to startup defaults?')) return;
    applyEditableRuntimeConfigObject(cloneJsValue(defaultEditableRuntimeConfigSnapshot));
    let ta = document.getElementById('config-editor-text');
    if (ta) ta.value = makeConfigEditorTextFromCurrentConfig();
}

function createEditableRuntimeConfigSnapshotFromMainMenu() {
    refreshResourceAbundanceMenu();
    let snapshot = createEditableRuntimeConfigSnapshot();
    let cfg = snapshot.config;
    let getNumber = (id, fallback) => {
        let el = document.getElementById(id);
        if (!el) return fallback;
        let value = Number(el.value);
        return Number.isFinite(value) ? value : fallback;
    };
    let getString = (id, fallback) => {
        let el = document.getElementById(id);
        if (!el) return fallback;
        let value = String(el.value || '').trim();
        return value || fallback;
    };

    cfg.GRID_W = Math.max(8, Math.floor(getNumber('cfg-mapsize', cfg.GRID_W)));
    cfg.GRID_H = cfg.GRID_W;
    cfg.RESOURCE_MINE_DENSITY = normalizeResourceMineDensity(getNumber('cfg-mine-density', cfg.RESOURCE_MINE_DENSITY));
    cfg.GOLD_MINE_COUNT = Math.max(0, Math.floor(getNumber('cfg-gold-count', cfg.GOLD_MINE_COUNT)));
    cfg.GOLD_MINE_MIN = Math.max(0, Math.floor(getNumber('cfg-gold-min', cfg.GOLD_MINE_MIN)));
    cfg.GOLD_MINE_MAX = Math.max(0, Math.floor(getNumber('cfg-gold-max', cfg.GOLD_MINE_MAX)));
    cfg.ASTAR_MINE_COUNT = Math.max(0, Math.floor(getNumber('cfg-astar-mine-count', cfg.ASTAR_MINE_COUNT)));
    cfg.ASTAR_MINE_MIN = Math.max(0, Math.floor(getNumber('cfg-astar-mine-min', cfg.ASTAR_MINE_MIN)));
    cfg.ASTAR_MINE_MAX = Math.max(0, Math.floor(getNumber('cfg-astar-mine-max', cfg.ASTAR_MINE_MAX)));
    cfg.STARTING_MONEY = Math.max(0, Math.floor(getNumber('cfg-starting-energy', cfg.STARTING_MONEY)));
    cfg.STARTING_ASTAR = Math.max(0, getNumber('cfg-starting-astar', cfg.STARTING_ASTAR));
    { let el = document.getElementById('cfg-shrines'); if (el) cfg.SHRINES_ENABLED = !!el.checked; }
    cfg.MAP_TYPE = getString('cfg-map-type', cfg.MAP_TYPE);
    cfg.GAME_MODE = getString('cfg-gamemode', cfg.GAME_MODE);
    cfg.MAP_VISIBILITY = getString('cfg-full-vis', cfg.MAP_VISIBILITY);
    cfg.CONFIG_MAX_POP = Math.max(1, Math.floor(getNumber('cfg-max-pop', cfg.CONFIG_MAX_POP)));
    cfg.TICK_RATE = Math.max(5, Math.floor(getNumber('cfg-tick-rate', cfg.TICK_RATE)));
    cfg.LOCKSTEP_PIPELINE_MIN = Math.max(0, Math.floor(getNumber('cfg-pipeline-delay', cfg.LOCKSTEP_PIPELINE_MIN)));
    cfg.THING_STATS_RECALC_INTERVAL_SECONDS = Math.max(0.05, Math.min(600, getNumber('cfg-thing-stats-seconds', cfg.THING_STATS_RECALC_INTERVAL_SECONDS)));
    cfg.LOCKSTEP_STRICT_DEBUG_MODE = !!((document.getElementById('cfg-exact-lockstep') || {}).checked);
    cfg.FAIR_INPUT_DELAY = readFairDelayFromMenu();
    cfg.UNIT_EFFECTIVE_STATS_RECALC_TICKS = Math.max(1, Math.min(240, Math.floor(getNumber('cfg-unit-eff-stats-ticks', cfg.UNIT_EFFECTIVE_STATS_RECALC_TICKS))));
    cfg.UNIT_COLLISION_RECALC_TICKS = Math.max(1, Math.min(240, Math.floor(getNumber('cfg-unit-collision-ticks', cfg.UNIT_COLLISION_RECALC_TICKS))));
    cfg.ASTAR_ITER_BUDGET_PER_PLAYER_TICK = Math.max(256, Math.min(500000, Math.floor(getNumber('cfg-astar-iter-budget-per-player', cfg.ASTAR_ITER_BUDGET_PER_PLAYER_TICK))));
    cfg.WORKER_AI_TICK_DELAY = Math.max(1, Math.min(60, Math.floor(getNumber('cfg-worker-ai-tick-delay', cfg.WORKER_AI_TICK_DELAY))));

    snapshot.progression.MAX_THING_LEVEL = Math.max(1, Math.floor(getNumber('cfg-max-thing-level', snapshot.progression.MAX_THING_LEVEL)));
    snapshot.progression.MAX_RESEARCH_LEVEL = Math.max(1, Math.floor(getNumber('cfg-max-research-level', snapshot.progression.MAX_RESEARCH_LEVEL)));

    return snapshot;
}

function applyMainMenuControlsToRuntimeState() {
    let snapshot = createEditableRuntimeConfigSnapshotFromMainMenu();
    let cfg = snapshot.config;
    let prog = snapshot.progression;

    GRID_W = cfg.GRID_W;
    GRID_H = cfg.GRID_H;
    WORLD_W = GRID_W * TILE;
    WORLD_H = GRID_H * TILE;
    RESOURCE_MINE_DENSITY = cfg.RESOURCE_MINE_DENSITY;
    GOLD_MINE_COUNT = cfg.GOLD_MINE_COUNT;
    GOLD_MINE_MIN = cfg.GOLD_MINE_MIN;
    GOLD_MINE_MAX = cfg.GOLD_MINE_MAX;
    ASTAR_MINE_COUNT = cfg.ASTAR_MINE_COUNT;
    ASTAR_MINE_MIN = cfg.ASTAR_MINE_MIN;
    ASTAR_MINE_MAX = cfg.ASTAR_MINE_MAX;
    STARTING_MONEY = cfg.STARTING_MONEY;
    STARTING_ASTAR = cfg.STARTING_ASTAR;
    SHRINES_ENABLED = cfg.SHRINES_ENABLED !== undefined ? !!cfg.SHRINES_ENABLED : SHRINES_ENABLED;
    MAP_TYPE = cfg.MAP_TYPE;
    CONFIG_MAX_POP = cfg.CONFIG_MAX_POP;
    MAX_THING_LEVEL = prog.MAX_THING_LEVEL;
    MAX_RESEARCH_LEVEL = prog.MAX_RESEARCH_LEVEL;
    THING_STATS_RECALC_INTERVAL_SECONDS = Math.max(0.05, Math.min(600, Number(cfg.THING_STATS_RECALC_INTERVAL_SECONDS) || THING_STATS_RECALC_INTERVAL_SECONDS));
    UNIT_EFFECTIVE_STATS_RECALC_TICKS = Math.max(1, Math.min(240, Math.floor(Number(cfg.UNIT_EFFECTIVE_STATS_RECALC_TICKS) || UNIT_EFFECTIVE_STATS_RECALC_TICKS)));
    UNIT_COLLISION_RECALC_TICKS = Math.max(1, Math.min(240, Math.floor(Number(cfg.UNIT_COLLISION_RECALC_TICKS) || UNIT_COLLISION_RECALC_TICKS)));
    ASTAR_ITER_BUDGET_PER_PLAYER_TICK = Math.max(256, Math.min(500000, Math.floor(Number(cfg.ASTAR_ITER_BUDGET_PER_PLAYER_TICK) || ASTAR_ITER_BUDGET_PER_PLAYER_TICK)));
    WORKER_AI_TICK_DELAY = Math.max(1, Math.min(60, Math.floor(Number(cfg.WORKER_AI_TICK_DELAY) || WORKER_AI_TICK_DELAY)));
    applyTimingConfig(cfg.TICK_RATE, cfg.LOCKSTEP_PIPELINE_MIN);
    lockstepStrictDebugMode = !!cfg.LOCKSTEP_STRICT_DEBUG_MODE;
    if (cfg.FAIR_INPUT_DELAY !== undefined) netFairInputDelay = !!cfg.FAIR_INPUT_DELAY;

    let gameModeEl = document.getElementById('cfg-gamemode');
    if (gameModeEl) gameMode = String(gameModeEl.value || gameMode || 'destroy');
    let fullVisEl = document.getElementById('cfg-full-vis');
    if (fullVisEl) { fullVisibility = fullVisEl.value === 'full'; teamVisibilityHistory = fullVisEl.value === 'history'; }
}

// Every lobby, optimization and display setting control. Map size and map
// type are selects, so values are stored by control kind, not by a fixed
// list of number inputs.
const MAIN_MENU_SETTING_CONTROL_SELECTOR = '[id^="cfg-"], [id^="setting-"], #btn-level-visibility, #btn-render-range, #jukebox-music, #jukebox-effects';

function _getMainMenuSettingControls() {
    return Array.from(document.querySelectorAll(MAIN_MENU_SETTING_CONTROL_SELECTOR))
        .filter(el => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && el.type !== 'file' && el.type !== 'button');
}

function createMainMenuSettingsSnapshot() {
    let out = {
        version: 4,
        createdAt: Date.now(),
        lobby: {
            numbers: {},
            selects: {},
            checks: {}
        },
        startingResources: cloneStartingResourcesConfig(),
        editableConfig: encodeFunctionsForTransport(createEditableRuntimeConfigSnapshotFromMainMenu())
    };
    for (let el of _getMainMenuSettingControls()) {
        if (el.type === 'checkbox') out.lobby.checks[el.id] = !!el.checked;
        else if (el.type === 'number' || el.type === 'range') out.lobby.numbers[el.id] = Number(el.value);
        else out.lobby.selects[el.id] = String(el.value);
    }
    // Display settings that have no control (audio, outlines, placement mode).
    out.ui = createUiSettingsSnapshot();
    return out;
}

function applyMainMenuSettingsSnapshot(rawData) {
    let data = (rawData && typeof rawData === 'object') ? rawData : {};
    let lobby = (data.lobby && typeof data.lobby === 'object') ? data.lobby : {};
    let numbers = (lobby.numbers && typeof lobby.numbers === 'object') ? lobby.numbers : {};
    let selects = (lobby.selects && typeof lobby.selects === 'object') ? lobby.selects : {};
    let checks = (lobby.checks && typeof lobby.checks === 'object') ? lobby.checks : {};

    if (data.ui && typeof data.ui === 'object') {
        try {
            localStorage.setItem(LS_UI_SETTINGS_KEY, JSON.stringify(data.ui));
            loadUiSettingsFromStorage();
            // Retain only player preferences, including for older exports
            // whose UI blob also contained map settings.
            saveUiSettingsToStorage();
        } catch { }
    }
    let changed = [];
    let setControl = (id, value, isCheck) => {
        let el = document.getElementById(id);
        if (!el || !el.matches(MAIN_MENU_SETTING_CONTROL_SELECTOR) || el.type === 'file') return;
        if (isCheck || el.type === 'checkbox') el.checked = !!value;
        else if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === String(value))) return;
        else el.value = String(value);
        changed.push(el);
    };
    // Older exports stored the map size select under numbers; accept any kind.
    for (let id in numbers) setControl(id, numbers[id], false);
    for (let id in selects) setControl(id, selects[id], false);
    for (let id in checks) setControl(id, checks[id], true);
    // Display controls apply themselves through their change listeners; the
    // game settings (cfg-*) are applied below in one pass.
    for (let el of changed) {
        if (el.id.startsWith('cfg-')) continue;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    let importedMaxThingLevel = Math.max(1, Math.floor(Number((document.getElementById('cfg-max-thing-level') || {}).value) || MAX_THING_LEVEL));
    let importedMaxResearchLevel = Math.max(1, Math.floor(Number((document.getElementById('cfg-max-research-level') || {}).value) || MAX_RESEARCH_LEVEL));
    MAX_THING_LEVEL = importedMaxThingLevel;
    MAX_RESEARCH_LEVEL = importedMaxResearchLevel;
    startingResourcesConfig = normalizeStartingResourcesConfig(data.startingResources || makeDefaultStartingResourcesConfig());
    refreshStartingResourcesPreviewPrecomputedStats();
    applyMainMenuControlsToRuntimeState();
    if (typeof syncNetAutoMenuState === 'function') syncNetAutoMenuState();
    let appliedAdvancedConfig = false;
    if (data.editableConfig && typeof data.editableConfig === 'object') {
        try {
            applyEditableRuntimeConfigObject(data.editableConfig, { fromTransport: true });
            appliedAdvancedConfig = true;
        } catch {
            // Keep imported non-advanced settings even if advanced config payload is invalid.
        }
    }
    if (appliedAdvancedConfig) {
        syncMainMenuFromRuntimeConfig();
        let gameModeEl = document.getElementById('cfg-gamemode');
        if (gameModeEl) gameModeEl.value = gameMode;
        let fullVisEl = document.getElementById('cfg-full-vis');
        if (fullVisEl) fullVisEl.value = fullVisibility ? 'full' : teamVisibilityHistory ? 'history' : 'team';
    }

    let popup = document.getElementById('starting-resources-popup');
    if (popup && !popup.classList.contains('hidden')) renderStartingResourcesPopupContent();
}

async function downloadMainMenuSettings(compressed = true) {
    const button = document.getElementById('btn-export-settings');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    try {
        const data = createMainMenuSettingsSnapshot();
        const blob = await makeJsonExportBlob([JSON.stringify(data, null, 2)], compressed);
        downloadJsonExport(blob, 'defence3-settings', compressed);
    } catch (error) {
        showUiBanner('Settings export failed: ' + error.message, 'error', 6000);
    } finally { if (button) button.disabled = false; }
}

async function importMainMenuSettingsFromFile(file) {
    if (!file) return;
    try {
        const parsed = await new Response(await openJsonFileStream(file)).json();
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
            || !(parsed.lobby || parsed.startingResources || parsed.editableConfig)) throw new Error('Choose a settings export.');
        applyMainMenuSettingsSnapshot(parsed);
        saveUiSettingsToStorage();
        showUiBanner('Settings imported.', 'success');
    } catch (error) {
        showUiBanner('Settings import failed: ' + error.message, 'error', 6000);
    }
}
function getGameModeLabel(mode = gameMode) {
    return mode === 'killking' ? 'Kill King' : 'Destroy Base';
}

function getTeamDisplayColor(pid) {
    return teamColorById[pid] || PLAYER_COLORS[pid] || '#ccc';
}

function isTeamAliveByAssets(pid) {
    if (resignedTeams.has(pid)) return false;
    for (let t of towers) if (t.owner === pid) return true;
    for (let b of barracks) if (b.owner === pid) return true;
    for (let s of collectorSpawners) if (s.owner === pid) return true;
    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            if (grid[y][x].item && grid[y][x].owner === pid) return true;
        }
    }
    return false;
}

function eliminateTeamAssets(pid) {
    for (let i = units.length - 1; i >= 0; i--) {
        let u = units[i];
        if (u.owner !== pid) continue;
        u.dead = true;
        removeUnitSpatial(u);
        selectedUnits = selectedUnits.filter(su => su !== u);
        units.splice(i, 1); unitSlotMapInvalidate(); if (typeof unitByIdRemoved === 'function') unitByIdRemoved(u);
    }
    players[pid].popCount = 0;
    _bumpPathTopologyVersion();

    for (let i = towers.length - 1; i >= 0; i--) {
        let t = towers[i];
        if (t.owner !== pid) continue;
        towers.splice(i, 1); towerJoinedOrLeft(t);
        clearTileEntity(t.gx, t.gy, t);
        if (grid[t.gy] && grid[t.gy][t.gx]) {
            grid[t.gy][t.gx].type = TYPE_FLOOR;
            grid[t.gy][t.gx].owner = -1;
            if (typeof simMoveTileTypeChanged === 'function') simMoveTileTypeChanged(t.gx, t.gy);
            _markCombinedBgTileDirty(t.gx, t.gy, 0, true);
        }
    }
    for (let i = barracks.length - 1; i >= 0; i--) {
        let b = barracks[i];
        if (b.owner !== pid) continue;
        barracks.splice(i, 1); barracksChanged();
        clearTileEntity(b.gx, b.gy, b);
        if (grid[b.gy] && grid[b.gy][b.gx]) {
            grid[b.gy][b.gx].item = null;
            grid[b.gy][b.gx].owner = -1;
        }
    }
    for (let i = collectorSpawners.length - 1; i >= 0; i--) {
        let s = collectorSpawners[i];
        if (s.owner !== pid) continue;
        collectorSpawners.splice(i, 1); collectorSpawnersChanged();
        clearTileEntity(s.gx, s.gy, s);
        if (grid[s.gy] && grid[s.gy][s.gx]) {
            grid[s.gy][s.gx].item = null;
            grid[s.gy][s.gx].owner = -1;
        }
    }
    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            let cell = grid[y][x];
            if (cell.item && cell.owner === pid) {
                clearTileEntity(x, y, cell.item);
                cell.item = null;
                cell.owner = -1;
            }
        }
    }
    dirtyGrid = true;
    recalculateAdjacency();
    recalculateLaserConnections();
    updateInfoPanel();
}

function getSpawnerRallyTargetWorld(spawner) {
    if (spawner.rallyTargetUnitId != null) {
        // (By id: a search of every unit per spawner per frame stalled the
        // page with thousands of spawners selected.)
        let tu = typeof getUnitById === 'function' ? getUnitById(spawner.rallyTargetUnitId) : units.find(u => u.id === spawner.rallyTargetUnitId);
        if (tu && (tu.dead || tu.owner === spawner.owner)) tu = null;
        if (tu) {
            let tgx = Math.floor(tu.x / TILE), tgy = Math.floor(tu.y / TILE);
            if (isTileVisibleToPlayer(spawner.owner, tgx, tgy)) {
                spawner.rallyX = tu.x;
                spawner.rallyY = tu.y;
                spawner._rallyLastSeenX = tu.x;
                spawner._rallyLastSeenY = tu.y;
                spawner._pendingRallyDetach = false;
                return { x: tu.x, y: tu.y };
            }

            let lockX = Number.isFinite(spawner._rallyLastSeenX) ? spawner._rallyLastSeenX : spawner.rallyX;
            let lockY = Number.isFinite(spawner._rallyLastSeenY) ? spawner._rallyLastSeenY : spawner.rallyY;
            if (Number.isFinite(lockX) && Number.isFinite(lockY)) {
                spawner.rallyX = lockX;
                spawner.rallyY = lockY;
            }
            // Stop following when target leaves owner's visibility.
            spawner.rallyTargetUnitId = null;
            spawner._pendingRallyDetach = false;
        }
    }
    if (spawner.rallyX !== null && spawner.rallyY !== null && Number.isFinite(spawner.rallyX) && Number.isFinite(spawner.rallyY)) {
        return { x: spawner.rallyX, y: spawner.rallyY };
    }
    return null;
}

function normalizeTowerTargetSpec(spec) {
    if (!spec || typeof spec !== 'object' || typeof spec.type !== 'string') return null;
    if (spec.type === 'unit' && Number.isFinite(spec.id)) {
        return { type: 'unit', id: Math.floor(spec.id) };
    }
    if ((spec.type === 'tower' || spec.type === 'barrack' || spec.type === 'spawner' || spec.type === 'item') && Number.isFinite(spec.gx) && Number.isFinite(spec.gy)) {
        return { type: spec.type, gx: Math.floor(spec.gx), gy: Math.floor(spec.gy) };
    }
    return null;
}

function getTowerTargetSpecFromEntity(target) {
    if (!target) return null;
    if (target instanceof Unit) return { type: 'unit', id: target.id };
    if (target instanceof Tower) return { type: 'tower', gx: target.gx, gy: target.gy };
    if (target instanceof Barrack) return { type: 'barrack', gx: target.gx, gy: target.gy };
    if ((target instanceof CollectorSpawner) || (target instanceof AstarSpawner) || (target instanceof SalvagerSpawner) || (target instanceof BuilderSpawner) || (target instanceof HealerSpawner) || (target instanceof ResearchSpawner)) {
        return { type: 'spawner', gx: target.gx, gy: target.gy };
    }
    if (Number.isFinite(target.gx) && Number.isFinite(target.gy)) {
        return { type: 'item', gx: target.gx, gy: target.gy };
    }
    return null;
}

function resolveTowerPreferredTarget(tower) {
    if (!tower || !tower.preferredTargetSpec) return null;
    let spec = normalizeTowerTargetSpec(tower.preferredTargetSpec);
    if (!spec) return null;
    if (spec.type === 'unit') {
        // (By the id map: a scan of every unit, for each of 2000 towers given
        // one target, was 300 ms a tick once that unit died.)
        const u = getUnitById(spec.id);
        return u && !u.dead && u.owner !== tower.owner ? u : null;
    }
    if (spec.type === 'tower') {
        let t = getTowerAtTile(spec.gx, spec.gy);
        return (t && t.energy > 0 && t.owner !== tower.owner) ? t : null;
    }
    if (spec.type === 'barrack') {
        let b = getBarrackAtTile(spec.gx, spec.gy);
        return (b && b.energy > 0 && b.owner !== tower.owner) ? b : null;
    }
    if (spec.type === 'spawner') {
        let s = getSpawnerAtTile(spec.gx, spec.gy);
        return (s && s.energy > 0 && s.owner !== tower.owner) ? s : null;
    }
    if (spec.type === 'item') {
        let item = getFloorItemAtTile(spec.gx, spec.gy);
        if (item && item.energy > 0 && item.owner !== tower.owner) return item;
    }
    return null;
}

function _isTowerPreferredTargetVisibleToOwner(tower, target) {
    if (!tower || !target) return false;
    let gx = Number.isFinite(target.gx) ? Math.floor(Number(target.gx)) : Math.floor((Number(target.x) || 0) / TILE);
    let gy = Number.isFinite(target.gy) ? Math.floor(Number(target.gy)) : Math.floor((Number(target.y) || 0) / TILE);
    return isGameplayTargetVisibleToPlayer(tower.owner, gx, gy);
}

function _isTowerPreferredTargetWithinRange(tower, target, rangeArea) {
    if (!tower || !target) return false;
    let maxAreaDistance = Math.max(0, Math.floor(Number(rangeArea) || 0));
    return isWorldTargetWithinAreaRange(tower.x, tower.y, target.x, target.y, maxAreaDistance);
}

function getTowerPreferredTargetInRange(tower, rangeArea) {
    if (!tower) return null;
    let pt = tower.preferredTarget;
    if (!pt || pt.dead || (pt.energy !== undefined && pt.energy <= 0) || (pt.owner !== undefined && pt.owner === tower.owner)) {
        pt = resolveTowerPreferredTarget(tower);
    }
    if (!pt) {
        tower.preferredTarget = null;
        tower.preferredTargetSpec = null;
        return null;
    }
    if (!_isTowerPreferredTargetVisibleToOwner(tower, pt)) {
        tower.preferredTarget = null;
        tower.preferredTargetSpec = null;
        return null;
    }
    if (!_isTowerPreferredTargetWithinRange(tower, pt, rangeArea)) return null;
    tower.preferredTarget = pt;
    if (!tower.preferredTargetSpec) tower.preferredTargetSpec = getTowerTargetSpecFromEntity(pt);
    return pt;
}

function resolveTowerPreferredTargetVisual(tower) {
    if (!tower) return null;
    let spec = normalizeTowerTargetSpec(tower.preferredTargetSpec);
    if (!spec) return null;
    if (spec.type === 'unit') {
        // (By the id map: no scan of every unit.)
        let u = getUnitById(spec.id);
        if (u && u.dead) u = null;
        if (u) {
            let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
            if (!isGameplayTargetVisibleToPlayer(tower.owner, ugx, ugy)) return null;
        }
        return u ? { x: u.x, y: u.y, locked: true } : null;
    }
    if (!isGameplayTargetVisibleToPlayer(tower.owner, spec.gx, spec.gy)) return null;
    if (spec.type === 'tower') {
        let t = getTowerAtTile(spec.gx, spec.gy);
        if (!(t && t.energy > 0)) t = null;
        return t ? { x: t.x, y: t.y, locked: true } : { x: spec.gx * TILE + 16, y: spec.gy * TILE + 16, locked: false };
    }
    if (spec.type === 'barrack') {
        let b = getBarrackAtTile(spec.gx, spec.gy);
        if (!(b && b.energy > 0)) b = null;
        return b ? { x: b.x, y: b.y, locked: true } : { x: spec.gx * TILE + 16, y: spec.gy * TILE + 16, locked: false };
    }
    if (spec.type === 'spawner') {
        let s = getSpawnerAtTile(spec.gx, spec.gy);
        if (!(s && s.energy > 0)) s = null;
        return s ? { x: s.x, y: s.y, locked: true } : { x: spec.gx * TILE + 16, y: spec.gy * TILE + 16, locked: false };
    }
    if (spec.type === 'item') {
        let item = getFloorItemAtTile(spec.gx, spec.gy);
        if (!(item && item.energy > 0)) item = null;
        return item ? { x: item.x, y: item.y, locked: true } : { x: spec.gx * TILE + 16, y: spec.gy * TILE + 16, locked: false };
    }
    return null;
}

function getTowerPreferredTargetDisplay(tower) {
    let spec = normalizeTowerTargetSpec(tower && tower.preferredTargetSpec);
    if (!spec) return 'None';
    if (spec.type === 'unit') {
        // (By the id map: no scan of every unit.)
        let u = getUnitById(spec.id);
        if (u && u.dead) u = null;
        if (u) {
            let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
            if (!isGameplayTargetVisibleToPlayer(tower.owner, ugx, ugy)) return 'None';
        }
        if (u) return `Unit ${u.id} (${Math.floor(u.x / TILE)},${Math.floor(u.y / TILE)})`;
        return `Unit ${spec.id}`;
    }
    if (!isGameplayTargetVisibleToPlayer(tower.owner, spec.gx, spec.gy)) return 'None';
    let label = spec.type === 'tower' ? 'Tower' : spec.type === 'barrack' ? 'Barrack' : spec.type === 'spawner' ? 'Spawner' : 'Item';
    return `${label} (${spec.gx},${spec.gy})`;
}

function countTeamUnits(pid) {
    let owner = Math.floor(Number(pid));
    if (owner >= 0 && owner < spatialUnitsComplexPlayerCount && spatialUnitsComplexStridePerChunk > 0 && spatialUnitsComplexStridePerPlayer > 0 && spatialUnitsComplex.length > 0) {
        let n = 0;
        let chunkCount = CHUNKS_W * CHUNKS_H;
        for (let chunkKey = 0; chunkKey < chunkCount; chunkKey++) {
            let playerBase = (chunkKey * spatialUnitsComplexStridePerChunk) + (owner * spatialUnitsComplexStridePerPlayer);
            n += spatialUnitsComplex[playerBase] || 0;
        }
        return n;
    }
    let fallback = 0;
    for (let u of units) if (u.owner === pid && !u.dead) fallback++;
    return fallback;
}

function countTeamStructures(pid) {
    let n = 0;
    // Count all non-unit owned things from grid ownership once.
    // Towers/barracks/spawners are also grid items, so this avoids double-counting.
    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            let cell = grid[y][x];
            if (!cell) continue;
            let item = cell.item;
            if (!item) continue;
            if (cell.owner !== pid) continue;
            if (!(Number(item.energy) > 0)) continue;
            n++;
        }
    }
    return n;
}

// Counts for the game stats graph (never read by the simulation): each tick
// a TICK_RATE-th of the units and structures (by position), so a second's
// ticks together see every one; the finished counts serve the next sample.
let _gameStatsAcc = null, _gameStatsDone = null;
// (The graph's counts: a slice a tick, of a sample of 1 in `sample` units
// and items, rotating each second, scaled up; unit totals are exact.)
const GAME_STATS_SAMPLE = 10;
function _gameStatsSlice(k, step, into = null, sample = 1, rot = 0) {
    let a = into || { workers: {}, idle: {}, units: {}, structures: {} };
    let add = (m, pid) => { m[pid] = (m[pid] || 0) + sample; };
    if (sample > 1) {
        // (Every live unit is counted in its owner's population.)
        for (let pid = 0; pid < players.length; pid++) if (k === 0) a.units[pid] = players[pid] ? players[pid].popCount : 0;
    }
    k += step * (rot % sample); step *= sample;
    // (Units from the unit state's columns: owner, worker, idle state; no
    // object read.)
    // (By the units list's order through the slot map, the same on every
    // peer; by slot, a sample's units depended on each peer's slot layout.)
    const S = typeof _simUnitState !== 'undefined' ? _simUnitState : null;
    const slots = S && typeof _unitSlotMapEnsure === 'function' ? _unitSlotMapEnsure() : null;
    if (S && slots) {
        const C = S.columns, LIVE = C.live, DEAD = C.dead, OWN = C.owner, WK = C.isWk, IDLE = C.wkIdle;
        for (let i = k, n = units.length; i < n; i += step) {
            const s = slots[i];
            if (!(s >= 0) || !LIVE[s] || DEAD[s]) continue;
            const pid = OWN[s];
            if (sample === 1) add(a.units, pid);
            if (!WK[s]) continue;
            add(a.workers, pid);
            if (IDLE[s]) add(a.idle, pid);
        }
    }
    let items = getCellItemsRowMajor();
    for (let i = k, n = items.length; i < n; i += step) {
        let item = items[i], cell = grid[item.gy] && grid[item.gy][item.gx];
        if (!cell || cell.item !== item || !(Number(item.energy) > 0)) continue;
        add(a.structures, cell.owner);
    }
    return a;
}
function gameStatsStep(tick) {
    let step = Math.max(1, TICK_RATE | 0), k = ((tick % step) + step) % step;
    if (k === 0 || !_gameStatsAcc) { if (_gameStatsAcc && k === 0) _gameStatsDone = _gameStatsAcc; _gameStatsAcc = { workers: {}, idle: {}, units: {}, structures: {} }; }
    _gameStatsSlice(k, step, _gameStatsAcc, GAME_STATS_SAMPLE, Math.floor(tick / step));
}

function sampleGameStats() {
    if (!gameStarted) return;
    let teams = (activeTeamIds && activeTeamIds.length > 0) ? activeTeamIds : [0, 1];
    let sample = {
        tick: gameTime,
        energy: {},
        astar: {},
        shrine: {},
        pop: {},
        units: {},
        workers: {},
        combat: {},
        idleWorkers: {},
        structures: {}
    };
    // The counts of the last whole second, gathered a slice a tick
    // (gameStatsStep); before the first one, gathered now.
    let acc = _gameStatsDone || _gameStatsSlice(0, 1);
    let workersByTeam = acc.workers, idleWorkersByTeam = acc.idle, unitsByTeam = acc.units, structuresByTeam = acc.structures;
    for (let pid of teams) {
        sample.energy[pid] = players[pid] ? players[pid].energy : 0;
        sample.astar[pid] = players[pid] ? (Number(players[pid].astar) || 0) : 0;
        sample.shrine[pid] = players[pid] ? (Number(players[pid].shrine) || 0) : 0;
        sample.pop[pid] = players[pid] ? players[pid].popCount : 0;
        sample.units[pid] = unitsByTeam[pid] || 0;
        sample.workers[pid] = workersByTeam[pid] || 0;
        sample.combat[pid] = Math.max(0, sample.units[pid] - sample.workers[pid]);
        sample.idleWorkers[pid] = idleWorkersByTeam[pid] || 0;
        sample.structures[pid] = structuresByTeam[pid] || 0;
    }
    gameStatsHistory.push(sample);
    if (gameStatsHistory.length > 3600) gameStatsHistory.shift();
}

function renderGameGraph(metric = graphMetric) {
    let metricDefs = {
        units: { title: 'Units', yTitle: 'UNITS' },
        workers: { title: 'Workers', yTitle: 'WORKERS' },
        combat: { title: 'Combat Units', yTitle: 'COMBAT UNITS' },
        idleWorkers: { title: 'Idle Workers', yTitle: 'IDLE WORKERS' },
        structures: { title: 'Structures', yTitle: 'STRUCTURES' },
        pop: { title: 'Population', yTitle: 'POPULATION' },
        energy: { title: 'Energy', yTitle: 'ENERGY' },
        astar: { title: '★', yTitle: '★' },
        shrine: { title: '\uD83D\uDC80 Shrine (damage taken)', yTitle: '\uD83D\uDC80' }
    };
    metric = metricDefs[metric] ? metric : 'units';
    graphMetric = metric;
    let metricDef = metricDefs[metric];
    let plotEl = document.getElementById('go-graph-plot');
    if (!plotEl || typeof Plotly === 'undefined') return;
    let samples = gameStatsHistory;
    if (!samples || samples.length === 0) {
        Plotly.react(plotEl, [], {
            paper_bgcolor: '#0d0d0d',
            plot_bgcolor: '#0d0d0d',
            xaxis: { visible: false },
            yaxis: { visible: false },
            annotations: [{ text: 'No graph data recorded.', x: 0.5, y: 0.5, showarrow: false, font: { color: '#999', size: 14 } }],
            margin: { l: 24, r: 24, t: 20, b: 20 }
        }, { displayModeBar: false, responsive: true });
        return;
    }

    let teams = (activeTeamIds && activeTeamIds.length > 0) ? activeTeamIds : [0, 1];

    let traces = teams.map(pid => ({
        x: samples.map(s => (s.tick || 0) / TICK_RATE),
        y: samples.map(s => (s[metric] && s[metric][pid]) || 0),
        mode: 'lines',
        name: `P${pid + 1}`,
        line: { color: getTeamDisplayColor(pid), width: 2 }
    }));

    let maxSeconds = (samples[samples.length - 1].tick || 0) / TICK_RATE;
    Plotly.react(plotEl, traces, {
        paper_bgcolor: '#0d0d0d',
        plot_bgcolor: '#0d0d0d',
        font: { color: '#cfd8dc', family: 'monospace', size: 11 },
        margin: { l: 48, r: 12, t: 26, b: 36 },
        legend: { orientation: 'h', x: 0, y: 1.15 },
        xaxis: {
            title: 'Time (s)',
            range: [0, Math.max(10, maxSeconds)],
            gridcolor: '#2a2a2a',
            zerolinecolor: '#333'
        },
        yaxis: {
            title: metricDef.yTitle,
            rangemode: 'normal',
            gridcolor: '#2a2a2a',
            zerolinecolor: '#333'
        },
        title: { text: metricDef.title, font: { size: 12, color: '#cfd8dc' } }
    }, {
        displayModeBar: false,
        responsive: true
    });
}

let activeHelpTab = 'keybinds';

function setHelpTab(tabId) {
    activeHelpTab = tabId || 'keybinds';
    let popup = document.getElementById('help-popup');
    if (!popup) return;
    popup.querySelectorAll('.help-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === activeHelpTab);
    });
    popup.querySelectorAll('.help-tab-panel').forEach(panel => {
        panel.classList.toggle('active', panel.dataset.tabPanel === activeHelpTab);
    });
}

function getOwnedActiveResearchLabs(owner) {
    return collectorSpawners.filter(s => s && s.type === 'research' && s.owner === owner && s.energy > 0 && !s.underConstruction);
}

function setResearchQueueDragGuard(active, rerenderPopup = false) {
    let wasActive = researchQueueDragInProgress;
    researchQueueDragInProgress = !!active;
    if (wasActive && !researchQueueDragInProgress && rerenderPopup) {
        let researchPopup = document.getElementById('research-popup');
        if (researchPopup && !researchPopup.classList.contains('hidden')) {
            renderResearchPopupContent();
        }
    }
}

function ensureResearchQueueDragReleaseHooks() {
    if (researchQueueDragReleaseHooksBound) return;
    researchQueueDragReleaseHooksBound = true;
    window.addEventListener('mouseup', () => setResearchQueueDragGuard(false, true), true);
    window.addEventListener('dragend', () => setResearchQueueDragGuard(false, true), true);
    window.addEventListener('blur', () => setResearchQueueDragGuard(false, false), true);
}

function renderResearchPopupContent() {
    let holder = document.getElementById('research-popup-content');
    if (!holder) return;
    let popupSnapshot = null;
    if (activePopupControlGroupKey) {
        normalizePopupControlGroup(activePopupControlGroupKey);
        popupSnapshot = getPopupControlGroupSnapshot(activePopupControlGroupKey);
        if (!popupSnapshot) activePopupControlGroupKey = '';
    }

    let unitsSnapshot = popupSnapshot
        ? (popupSnapshot.units || []).filter(u => u && !u.dead)
        : selectedUnits.filter(u => u && !u.dead);
    let entitiesSnapshot = popupSnapshot
        ? (popupSnapshot.entities || []).filter(e => e && !(e.energy !== undefined && e.energy <= 0))
        : selectedEntities.filter(e => e && !(e.energy !== undefined && e.energy <= 0));
    let subgroupSnapshot = popupSnapshot
        ? { ...(popupSnapshot.activeSubGroups || {}) }
        : { ...activeSubGroups };

    let infoPanel = holder.querySelector('#research-popup-info-panel');
    if (!infoPanel) {
        holder.innerHTML = `
        <div id="queue-multiplier-bar-popup" class="mult-toggle-bar" style="padding:3px 4px;border-bottom:1px solid #2a2a2a;background:#101010;"></div>
        <div class="subgroup-options-popup" style="display:flex;gap:4px;padding:3px 4px;border-bottom:1px solid #2a2a2a;background:#101010;margin-bottom:4px;">
            <button id="btn-ignore-level-popup">Collapse Same Type: OFF</button>
        </div>
        <div id="research-popup-info-panel"></div>
    `;
        infoPanel = holder.querySelector('#research-popup-info-panel');
        updatePurchaseMultiplierBars();
    }

    let popupIgnoreBtn = holder.querySelector('#btn-ignore-level-popup');
    if (popupIgnoreBtn && popupIgnoreBtn.dataset.bound !== '1') {
        popupIgnoreBtn.dataset.bound = '1';
        bindInstantPress(popupIgnoreBtn, () => {
            ignoreLevelSubgroups = !ignoreLevelSubgroups;
            updateIgnoreLevelButton();
            if (activePopupControlGroupKey) {
                normalizePopupControlGroup(activePopupControlGroupKey);
                let snap = getPopupControlGroupSnapshot(activePopupControlGroupKey);
                if (snap) snap.activeSubGroups = {};
            }
            renderResearchPopupContent();
            updateInfoPanel();
        });
    }

    let prevUnits = selectedUnits;
    let prevEntities = selectedEntities;

    selectedUnits = unitsSnapshot;
    selectedEntities = entitiesSnapshot;
    updateInfoPanel(infoPanel, {
        skipGlobalSync: true,
        subgroupState: subgroupSnapshot,
        onRefresh: () => {
            if (!researchQueueDragInProgress) renderResearchPopupContent();
        },
        onSubgroupStateChange: (nextState) => {
            subgroupSnapshot = { ...(nextState || {}) };
            if (popupSnapshot) popupSnapshot.activeSubGroups = { ...subgroupSnapshot };
        }
    });

    selectedUnits = prevUnits;
    selectedEntities = prevEntities;
    updateIgnoreLevelButton();
}

function setResearchPopupOpen(open) {
    let popup = document.getElementById('research-popup');
    if (!popup) return false;
    let wasOpen = !popup.classList.contains('hidden');
    if (open) renderResearchPopupContent();
    popup.classList.toggle('hidden', !open);
    if (!open) {
        activePopupControlGroupKey = '';
        setResearchQueueDragGuard(false, false);
    }
    return wasOpen !== open;
}

// (The stats map popup: hud.js.)

function buildResearchStatMatrixGrid(kind, key, statKey) {
    let grid = [];
    let header = [''];
    for (let rl = 0; rl <= MAX_RESEARCH_LEVEL; rl++) header.push(`R${rl}`);
    grid.push(header);

    let levels = researchMatrixThingLevels(kind, key);
    for (let tl = 1; tl <= levels; tl++) {
        let row = [levels > 1 ? `L${tl}` : 'Value'];
        for (let rl = 0; rl <= MAX_RESEARCH_LEVEL; rl++) {
            let v = getResearchStatValueAtLevel(kind, key, statKey, rl, tl);
            row.push(formatResearchStatValue(statKey, v));
        }
        grid.push(row);
    }

    return grid;
}

function formatShopStatMatrixCellValue(value, statKey = '') {
    if (Number.isFinite(value)) {
        if (statKey) return formatResearchStatValue(statKey, value);
        return formatBigNumber(value, 2);
    }
    if (value === null || value === undefined) return '-';
    return String(value);
}

function buildStatMatrixGridFromDescriptor(d) {
    if (!d) return null;

    let grid = [];
    let header = [''];
    for (let rl = 0; rl <= MAX_RESEARCH_LEVEL; rl++) header.push(`R${rl}`);
    grid.push(header);

    let levels = researchMatrixThingLevels(d.kind, d.key);
    for (let tl = 1; tl <= levels; tl++) {
        let row = [levels > 1 ? `L${tl}` : 'Value'];
        for (let rl = 0; rl <= MAX_RESEARCH_LEVEL; rl++) {
            let raw = null;
            if (typeof d.getValue === 'function') {
                raw = d.getValue(tl, rl);
            } else if (d.kind && d.key && d.statKey) {
                let hasResearchEntry = !!getResearchStatEntry(d.kind, d.key, d.statKey);
                let useRl = hasResearchEntry ? rl : 0;
                raw = d.kind === 'unit'
                    ? getUnitStatFromMap(d.key, tl, d.statKey, useRl)
                    : getBuildingStatFromMap(d.key, tl, d.statKey, useRl);
            } else {
                raw = d.fixedValue;
            }
            row.push(formatShopStatMatrixCellValue(raw, d.statKey || ''));
        }
        grid.push(row);
    }

    return grid;
}

function buildShopStatMatrixGrid(matrixId) {
    let d = shopStatMatrixDescriptorById[matrixId];
    return buildStatMatrixGridFromDescriptor(d);
}

function buildInfoPanelStatMatrixGrid(matrixId) {
    let d = infoPanelStatMatrixDescriptorById[matrixId];
    return buildStatMatrixGridFromDescriptor(d);
}

function _escapeHtml(text) {
    return String(text === undefined || text === null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderMatrixGridToPopup(grid, emptyText = 'No matrix data.') {
    let container = document.getElementById('research-matrix-json');
    if (!container) return;
    if (!Array.isArray(grid) || grid.length === 0 || !Array.isArray(grid[0]) || grid[0].length === 0) {
        container.innerHTML = `<div class="matrix-empty">${_escapeHtml(emptyText)}</div>`;
        return;
    }

    let html = '<table class="matrix-table"><thead><tr>';
    let head = grid[0];
    for (let i = 0; i < head.length; i++) {
        if (i === 0) html += `<th class="matrix-row-head">${_escapeHtml(head[i])}</th>`;
        else html += `<th>${_escapeHtml(head[i])}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (let r = 1; r < grid.length; r++) {
        let row = grid[r] || [];
        html += '<tr>';
        for (let c = 0; c < row.length; c++) {
            if (c === 0) html += `<th class="matrix-row-head">${_escapeHtml(row[c])}</th>`;
            else html += `<td>${_escapeHtml(row[c])}</td>`;
        }
        html += '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
    container.scrollTop = 0;
    container.scrollLeft = 0;
}

function refreshResearchStatMatrixPopupText() {
    let ta = document.getElementById('research-matrix-json');
    let title = document.getElementById('research-matrix-title');
    if (!ta) return;
    let p = researchStatMatrixPopupPayload;
    if (!p) {
        renderMatrixGridToPopup(null, '{"error":"No stat selected"}');
        if (title) title.textContent = 'Research Stat Matrix';
        return;
    }
    try {
        if (Number.isFinite(Number(p.shopMatrixId))) {
            let d = shopStatMatrixDescriptorById[p.shopMatrixId];
            if (title) title.textContent = d && d.title ? `Research Stat Matrix: ${d.title}` : 'Research Stat Matrix';
            renderMatrixGridToPopup(buildShopStatMatrixGrid(Number(p.shopMatrixId)), 'No stat descriptor found.');
        } else if (Number.isFinite(Number(p.infoPanelMatrixId))) {
            let d = infoPanelStatMatrixDescriptorById[p.infoPanelMatrixId];
            if (title) title.textContent = d && d.title ? `Research Stat Matrix: ${d.title}` : 'Research Stat Matrix';
            renderMatrixGridToPopup(buildInfoPanelStatMatrixGrid(Number(p.infoPanelMatrixId)), 'No stat descriptor found.');
        } else {
            if (title) title.textContent = `Research Stat Matrix: ${p.kind}:${p.key}:${p.statKey}`;
            renderMatrixGridToPopup(buildResearchStatMatrixGrid(p.kind, p.key, p.statKey));
        }
    } catch {
        renderMatrixGridToPopup(null, 'Unable to build matrix');
    }
}

function setResearchStatMatrixPopupOpen(open) {
    let popup = document.getElementById('research-matrix-popup');
    if (!popup) return false;
    let wasOpen = !popup.classList.contains('hidden');
    popup.classList.toggle('hidden', !open);
    if (open) refreshResearchStatMatrixPopupText();
    return wasOpen !== open;
}


function cloneStartingResourcesConfig() {
    return {
        researchLevels: { ...(startingResourcesConfig.researchLevels || {}) },
        spawnCounts: JSON.parse(JSON.stringify(startingResourcesConfig.spawnCounts || {}))
    };
}













function renderStartingResourcesThingRowsForPanel() {
    ensureStartingResourcesSelectedThing();
    let selectedThing = RESEARCH_THINGS_BY_ID[startingResourcesSelectedThingId];
    if (!selectedThing) return '<div style="font-size:11px;color:#777">No thing selected.</div>';

    let owner = localPlayerId;
    let thingId = getStartingThingId(selectedThing.kind, selectedThing.key);
    let html = '';

    html += `<div class="info-row" style="display:flex;flex-wrap:wrap;gap:4px;align-items:flex-start">`;
    for (let thing of RESEARCH_THINGS) {
        let id = `${thing.kind}:${thing.key}`;
        let isSelected = id === thingId;
        let borderRadius = thing.kind === 'unit' ? '50%' : '4px';
        html += `<button class="info-research-thing-btn info-startres-thing-btn" data-thing-id="${id}" title="${thing.label}" style="width:32px;height:32px;padding:0;border:2px solid ${isSelected ? '#8cf' : '#333'};border-radius:${borderRadius};background:${isSelected ? '#1a2730' : '#111'};cursor:pointer;display:flex;align-items:center;justify-content:center">`;
        html += `<img src="${getItemThumbnail(thing.key, 24)}" width="24" height="24" style="display:block;${thing.kind === 'unit' ? 'border-radius:50%;' : ''}">`;
        html += `</button>`;
    }
    html += `</div>`;

    html += `<div style="margin-top:4px;border:1px solid #2f2f2f;border-radius:4px;padding:4px;background:#121212">`;
    html += `<div style="font-size:10px;color:#ddd;margin-bottom:3px">${selectedThing.label}</div>`;

    for (let stat of (selectedThing.stats || [])) {
        let curLevel = 0;
        if (startingResourcesConfig.researchLevels[thingId] && Number.isFinite(startingResourcesConfig.researchLevels[thingId][stat.statKey])) {
            curLevel = Math.max(0, Math.min(MAX_RESEARCH_LEVEL, Math.floor(Number(startingResourcesConfig.researchLevels[thingId][stat.statKey]) || 0)));
        }
        let nextLevel = Math.min(MAX_RESEARCH_LEVEL, curLevel + 1);

        let selectedThingLevel = getResearchPreviewThingLevel();
        let currentValue = getResearchStatValueAtLevel(selectedThing.kind, selectedThing.key, stat.statKey, curLevel, selectedThingLevel);
        let projectedValue = getResearchStatValueAtLevel(selectedThing.kind, selectedThing.key, stat.statKey, nextLevel, selectedThingLevel);
        if (!Number.isFinite(projectedValue)) projectedValue = currentValue;

        html += `<div class="compact-research-row"><span class="compact-research-name">${stat.label}</span>`;
        html += countBarHtml(curLevel, 0, MAX_RESEARCH_LEVEL, { type: 'preset-research', thingId, statKey: stat.statKey }, stat.label + ' starting research', 'R', isMultiplayer && !isHost);
        html += `</div>`;
    }

    html += `<div style="margin-top:4px;padding-top:4px;border-top:1px solid #2c2c2c">`;
    html += `<div style="font-size:10px;color:#8cf;margin-bottom:3px">Starting Spawn Counts (Per Level)</div>`;
    for (let lvl = 1; lvl <= MAX_THING_LEVEL; lvl++) {
        let cur = getStartingSpawnCount(thingId, lvl);
        let maxRow = getStartingSpawnMaxForRow(thingId, lvl);
        html += `<div class="info-row" style="align-items:center;gap:8px;margin:1px 0;">`;
        html += `<span style="color:#bbb;flex:0 0 48px">L${lvl}</span>`;
        html += `<div style="display:flex;align-items:center;justify-content:flex-end;gap:4px;flex:1 1 0">`;
        html += countBarHtml(cur, 0, maxRow, { type: 'preset-spawn', thingId, level: lvl }, selectedThing.label + ' L' + lvl + ' starting count', '', isMultiplayer && !isHost);
        html += `</div>`;
        html += `</div>`;
    }
    html += `</div>`;

    html += `</div>`;
    return html;
}

function renderStartingResourcesPopupContent() {
    let holder = document.getElementById('starting-resources-content');
    if (!holder || countBarBusy(holder)) return;
    holder.innerHTML = `
        <div id="starting-resources-panel" style="display:block">${renderStartingResourcesThingRowsForPanel()}</div>
        <div class="info-row" style="justify-content:flex-end;gap:8px;margin-top:6px;border-top:1px solid #2b2b2b;padding-top:6px;">
            <button id="btn-startres-reset-selected" type="button" style="font-size:11px;padding:3px 8px;">Reset Selected Thing</button>
            <button id="btn-startres-reset-all" type="button" style="font-size:11px;padding:3px 8px;">Reset All</button>
        </div>
    `;


    let resetSelected = document.getElementById('btn-startres-reset-selected');
    if (resetSelected) {
        bindInstantPress(resetSelected, () => {
            let selectedThingId = startingResourcesSelectedThingId;
            if (!selectedThingId) return;
            delete startingResourcesConfig.researchLevels[selectedThingId];
            delete startingResourcesConfig.spawnCounts[selectedThingId];
            renderStartingResourcesPopupContent();
        });
    }

    let resetAll = document.getElementById('btn-startres-reset-all');
    if (resetAll) {
        bindInstantPress(resetAll, () => {
            if (!confirm('Reset all starting resources and research presets?')) return;
            resetStartingResourcesConfig();
            renderStartingResourcesPopupContent();
        });
    }

    holder.querySelectorAll('.info-startres-thing-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let thingId = String(btn.dataset.thingId || '');
            if (!thingId) return;
            startingResourcesSelectedThingId = thingId;
            renderStartingResourcesPopupContent();
        });
    });

    holder.querySelectorAll('.info-startres-level-preview-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let kind = btn.dataset.kind;
            let key = btn.dataset.key;
            let statKey = btn.dataset.statKey;
            let fromLevel = Number.parseInt(btn.dataset.fromLevel, 10);
            let toLevel = Number.parseInt(btn.dataset.toLevel, 10);
            openResearchThingLevelDropdown(btn, { kind, key, statKey, fromLevel, toLevel });
        });
    });
}

function setStartingResourcesPopupOpen(open) {
    let popup = document.getElementById('starting-resources-popup');
    if (!popup) return false;
    let wasOpen = !popup.classList.contains('hidden');
    popup.classList.toggle('hidden', !open);
    if (open) renderStartingResourcesPopupContent();
    return wasOpen !== open;
}

let defaultEditableRuntimeConfigSnapshot = null;

function cloneJsValue(value) {
    if (Array.isArray(value)) return value.map(v => cloneJsValue(v));
    if (typeof value === 'function') return value;
    if (value && typeof value === 'object') {
        let out = {};
        for (let k in value) out[k] = cloneJsValue(value[k]);
        return out;
    }
    return value;
}

function replaceObjectContents(target, source) {
    if (!target || typeof target !== 'object') return;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    for (let k of Object.keys(target)) delete target[k];
    for (let k of Object.keys(source)) target[k] = cloneJsValue(source[k]);
}

function replaceArrayContents(target, source) {
    if (!Array.isArray(target) || !Array.isArray(source)) return;
    target.length = 0;
    for (let item of source) target.push(cloneJsValue(item));
}

function stringifyJsLike(value, depth = 0) {
    const pad = '  '.repeat(depth);
    const nextPad = '  '.repeat(depth + 1);

    if (typeof value === 'function') return value.toString();
    if (value === null) return 'null';
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';

    let t = typeof value;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
    if (t === 'string') return JSON.stringify(value);
    if (t === 'undefined') return 'undefined';

    if (Array.isArray(value)) {
        if (value.length <= 0) return '[]';
        let parts = value.map(v => `${nextPad}${stringifyJsLike(v, depth + 1)}`);
        return `[\n${parts.join(',\n')}\n${pad}]`;
    }

    if (value && t === 'object') {
        let keys = Object.keys(value);
        if (keys.length <= 0) return '{}';
        let parts = keys.map(k => `${nextPad}${JSON.stringify(k)}: ${stringifyJsLike(value[k], depth + 1)}`);
        return `{\n${parts.join(',\n')}\n${pad}}`;
    }

    return 'null';
}


function encodeFunctionsForTransport(value) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
        if (Number.isNaN(value)) return { __specialNumber__: 'NaN' };
        if (value === Infinity) return { __specialNumber__: 'Infinity' };
        if (value === -Infinity) return { __specialNumber__: '-Infinity' };
    }
    if (typeof value === 'function') return { __fn__: value.toString() };
    if (Array.isArray(value)) return value.map(v => encodeFunctionsForTransport(v));
    if (value && typeof value === 'object') {
        let out = {};
        for (let k in value) out[k] = encodeFunctionsForTransport(value[k]);
        return out;
    }
    return value;
}

function decodeFunctionsFromTransport(value) {
    if (Array.isArray(value)) return value.map(v => decodeFunctionsFromTransport(v));
    if (value && typeof value === 'object') {
        if (Object.keys(value).length === 1 && typeof value.__specialNumber__ === 'string') {
            if (value.__specialNumber__ === 'NaN') return NaN;
            if (value.__specialNumber__ === 'Infinity') return Infinity;
            if (value.__specialNumber__ === '-Infinity') return -Infinity;
        }
        if (Object.keys(value).length === 1 && typeof value.__fn__ === 'string') {
            let fn = (new Function('"use strict"; return (' + value.__fn__ + ');'))();
            if (typeof fn !== 'function') throw new Error('Invalid function in transported config.');
            return fn;
        }
        let out = {};
        for (let k in value) out[k] = decodeFunctionsFromTransport(value[k]);
        return out;
    }
    return value;
}

function mulberry32(seed) {
    let s = seed | 0;
    let fn = function () {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    fn.getState = () => (s | 0);
    fn.setState = (nextState) => { s = (Number(nextState) | 0); };
    return fn;
}

function clampThingLevel(level) {
    return Math.max(0, Math.min(MAX_THING_LEVEL, Math.floor(Number(level) || 0)));
}

function clampResearchLevel(level) {
    return Math.max(0, Math.min(MAX_RESEARCH_LEVEL, Math.floor(Number(level) || 0)));
}

function getUnitResearchStatKeys(unitType) {
    return Object.entries(THING_STATS[unitType]?.stats || {}).filter(([,s])=>s.researchable).map(([key])=>key);
}



// Rows of a stat matrix: the thing's levels; one for a thing without levels
// (the shrine: research alone scales it).
function researchMatrixThingLevels(kind, key) {
    return kind === 'building' && (BASE_CARD_TYPES[key] || {}).notBuildable ? 1 : MAX_THING_LEVEL;
}

function getResearchBonusExpForStat(kind, statKey, key) {
    const rule = THING_STATS[key]?.stats[statKey];
    return rule?.researchable ? Number(rule.research?.factor) || 1 : 1;
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

function applyPrecomputedSoftCap(value, cap, statKey, baseValue, maxValueBeforeCap) {
    if (!Number.isFinite(value)) return value;
    if (!Number.isFinite(cap) || cap <= 0) return value;
    if (!Number.isFinite(baseValue) || !Number.isFinite(maxValueBeforeCap)) return value;

    let denom = maxValueBeforeCap - baseValue;
    if (!Number.isFinite(denom) || Math.abs(denom) < 1e-9) return value;

    let canUseLog = value > 0 && baseValue > 0 && maxValueBeforeCap > 0 && cap > 0;
    if (canUseLog) {
        let logDenom = detLog(maxValueBeforeCap / baseValue);
        if (Number.isFinite(logDenom) && Math.abs(logDenom) >= 1e-9) {
            let tLog = detLog(value / baseValue) / logDenom;
            if (Number.isFinite(tLog)) {
                tLog = Math.max(0, Math.min(1, tLog));
                let logCapSpan = detLog(cap / baseValue);
                if (Number.isFinite(logCapSpan)) {
                    return baseValue * detExp(logCapSpan * tLog);
                }
            }
        }
    }

    // Fallback for non-positive domains or degenerate logarithmic spans.
    let t = (value - baseValue) / denom;
    if (!Number.isFinite(t)) return value;
    t = Math.max(0, Math.min(1, t));
    return baseValue + (cap - baseValue) * t;
}

function getUnitStatFallbackValue(unitType, statKey) {
    const value = getThingStatBase(unitType,statKey);
    return Number.isFinite(value) ? value : 0;
}
function normalizePrecomputedUnitStatValue(unitType, statKey, value) {
    const rule = THING_STATS[unitType]?.stats[statKey];
    if (!Number.isFinite(value)) value = getUnitStatFallbackValue(unitType,statKey);
    if (rule?.round === 'floor') value = Math.floor(value);
    if (rule?.round === 'round') value = Math.round(value);
    return clampThingStatValue(unitType,statKey,value);
}

// This evaluator runs when shared stat rows are rebuilt, never per moving unit.
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

function rebuildPrecomputedStatsMap() {
    rebuildThingDefinitionViews();
    PRECOMPUTED_STATS_MAP = { unit: {}, building: {} };

    for (let unitType in BASE_UNIT_STATS) {
        PRECOMPUTED_STATS_MAP.unit[unitType] = [];
        let baseAtLevel1 = computeBaseUnitStatsAtLevel(unitType, 1);
        let baseAtMaxLevel = computeBaseUnitStatsAtLevel(unitType, MAX_THING_LEVEL);
        for (let lvl = 0; lvl <= MAX_THING_LEVEL; lvl++) {
            let base = computeBaseUnitStatsAtLevel(unitType, lvl);
            let levelEntry = {};
            for (let statKey of PRECOMPUTED_UNIT_STAT_KEYS) {
                let arr = new Array(MAX_RESEARCH_LEVEL + 1);
                let cap = getPrecomputedSoftCap('unit', unitType, statKey, { baseAtLevel1, baseAtMaxLevel });
                let baselineValue = applyResearchLevelToBaseValue('unit', baseAtLevel1[statKey], statKey, 0, unitType);
                let maxValueBeforeCap = applyResearchLevelToBaseValue('unit', baseAtMaxLevel[statKey], statKey, MAX_RESEARCH_LEVEL, unitType);
                for (let r = 0; r <= MAX_RESEARCH_LEVEL; r++) {
                    let researched = applyResearchLevelToBaseValue('unit', base[statKey], statKey, r, unitType);
                    let capped = applyPrecomputedSoftCap(researched, cap, statKey, baselineValue, maxValueBeforeCap);
                    arr[r] = clampThingStatValue(unitType, statKey, normalizePrecomputedUnitStatValue(unitType, statKey, capped));
                }
                levelEntry[statKey] = arr;
            }
            PRECOMPUTED_STATS_MAP.unit[unitType][lvl] = levelEntry;
        }
    }

    for (let buildingKey in BASE_CARD_TYPES) {
        PRECOMPUTED_STATS_MAP.building[buildingKey] = [];
        let baseAtLevel1 = computeBaseBuildingStatsAtLevel(buildingKey, 1);
        let baseAtMaxLevel = computeBaseBuildingStatsAtLevel(buildingKey, MAX_THING_LEVEL);
        for (let lvl = 0; lvl <= MAX_THING_LEVEL; lvl++) {
            let base = computeBaseBuildingStatsAtLevel(buildingKey, lvl);
            let levelEntry = {};
            for (let statKey of PRECOMPUTED_BUILDING_STAT_KEYS) {
                let arr = new Array(MAX_RESEARCH_LEVEL + 1);
                let cap = getPrecomputedSoftCap('building', buildingKey, statKey, { baseAtLevel1, baseAtMaxLevel });
                let baselineValue = applyResearchLevelToBaseValue('building', baseAtLevel1[statKey], statKey, 0, buildingKey);
                let maxValueBeforeCap = applyResearchLevelToBaseValue('building', baseAtMaxLevel[statKey], statKey, MAX_RESEARCH_LEVEL, buildingKey);
                for (let r = 0; r <= MAX_RESEARCH_LEVEL; r++) {
                    let researched = applyResearchLevelToBaseValue('building', base[statKey], statKey, r, buildingKey);
                    arr[r] = clampThingStatValue(buildingKey, statKey, applyPrecomputedSoftCap(researched, cap, statKey, baselineValue, maxValueBeforeCap));
                }
                levelEntry[statKey] = arr;
            }
            PRECOMPUTED_STATS_MAP.building[buildingKey][lvl] = levelEntry;
        }
    }

    PRECOMPUTED_STATS_READY = true;
    rebuildPrecomputedStatsMapPlayer();
    rebuildResearchThings();
}

function _normalizePlayerPrecomputedUnitKey(unitType) {
    return PRECOMPUTED_STATS_MAP.unit[unitType] ? unitType : 'norm';
}

function _normalizePlayerPrecomputedBuildingKey(buildingKey) {
    if (!buildingKey) return 'farm';
    if (buildingKey === 'barrack') return 'barrack_norm';
    return PRECOMPUTED_STATS_MAP.building[buildingKey] ? buildingKey : 'farm';
}

// Numeric stat storage belongs to owner/type tables, never instances.
// Layout is selected before creating a match for controlled A/B benchmarks.
let SIM_THING_STATS_LAYOUT='soa';
const _thingStatTables=new Map(),_thingStatViews=new WeakSet(),_thingStatSchemas=new Map();
function _flatThingStatEntry(owner,kind,type,level,values) {
    const keys=Object.keys(values), signature=keys.join('|'), id=owner+'|'+kind+'|'+type;
    let schema=_thingStatSchemas.get(signature);
    if(!schema){
        const descriptors={};
        keys.forEach((name,k)=>descriptors[name]={enumerable:true,configurable:false,
            get:function(){const t=this._flatStats;return t.data[this._flatLevel*t.rowStride+k*t.statStride];},
            set:function(v){const t=this._flatStats;t.data[this._flatLevel*t.rowStride+k*t.statStride]=v;}});
        schema={keys,descriptors};_thingStatSchemas.set(signature,schema);
    }
    let t=_thingStatTables.get(id);
    const levels=MAX_THING_LEVEL+1,width=(keys.length+3)&~3;
    if(!t || t.layout!==SIM_THING_STATS_LAYOUT || t.schema!==schema){
        const soa=SIM_THING_STATS_LAYOUT==='soa';
        t={schema,layout:SIM_THING_STATS_LAYOUT,width,levels,rowStride:soa?1:width,statStride:soa?levels:1,data:new Float32Array(levels*width),entries:[]};
        t.data.fill(NaN);_thingStatTables.set(id,t);
    }
    let entry=t.entries[level];
    if(!entry){entry={};Object.defineProperties(entry,{_flatStats:{value:t},_flatLevel:{value:level}});Object.defineProperties(entry,schema.descriptors);t.entries[level]=entry;_thingStatViews.add(entry);}
    for(const name of keys)entry[name]=values[name];
    return entry;
}
function _getUnitPlayerPrecomputedEntry(owner,type,level) {
    return _flatThingStatEntry(owner,'unit',_normalizePlayerPrecomputedUnitKey(type),Math.max(1,clampThingLevel(level)),_getUnitPlayerPrecomputedEntryObject(owner,type,level));
}
function _getBuildingPlayerPrecomputedEntry(owner,type,level) {
    return _flatThingStatEntry(owner,'building',_normalizePlayerPrecomputedBuildingKey(type),Math.max(1,clampThingLevel(level)),_getBuildingPlayerPrecomputedEntryObject(owner,type,level));
}
function _simF32Stats(entry) {
    if(_thingStatViews.has(entry)) return entry;
    for (const k of Object.keys(entry)) if (typeof entry[k] === 'number') entry[k] = Math.fround(entry[k]);
    return entry;
}

function _getUnitPlayerPrecomputedEntryObject(playerId, unitType, level) {
    let key = _normalizePlayerPrecomputedUnitKey(unitType);
    let lvl = Math.max(1, clampThingLevel(level || 1));
    let levelEntries = PRECOMPUTED_STATS_MAP.unit[key] || [];
    let values = {};

    for (let statKey of PRECOMPUTED_UNIT_STAT_KEYS) {
        // (A boosted thing: the stat of a higher level, see BOOSTS.)
        let levelEntry = levelEntries[_boostedLevel(lvl, _statBoostLevels(playerId, 'unit', key, statKey))] || {};
        let arr = levelEntry[statKey] || null;
        let rLvl = getPlayerResearchLevel(playerId, 'unit', key, statKey);
        let rawValue = arr ? arr[rLvl] : normalizePrecomputedUnitStatValue(key, statKey, NaN);
        values[statKey] = _applyPlayerResourcePenaltyToStatValue(playerId, 'unit', statKey, rawValue);
    }

    let maxEnergy = Math.max(1, Math.floor(Number(values.energy) || 1));
    let attackCooldownSec = Math.max(0.01, Number(values.atkCd) || 0.01);
    let attackRangeArea = Math.max(0, Number(values.attackRange) || 0);
    let visionRangeArea = Math.max(0.05, Number(values.visionRange) || 0.05, attackRangeArea);
    let transferCooldownSec = Math.max(0.01, Number(values.transferCooldown) || 0.01);

    return _simF32Stats({
        maxEnergy,
        attackDamage: Math.max(0, Number(values.atk) || 0),
        attackCooldownSec,
        attackCooldown: secondsToTicks(attackCooldownSec),
        speed: Math.max(0.1, Number(values.speed) || 0.1),
        visionRangeArea,
        visionRange: visionRangeArea * AREA_UNIT_TILE_EQUIVALENT,
        attackRangeArea,
        attackRange: attackRangeArea * AREA_UNIT_TILE_EQUIVALENT * TILE,
        watchDuration: Math.max(0, Number(values.watchDuration) || 0),
        workerSearchDistance: Math.max(0, Number(values.workerSearchDistance) || 0),
        gatherPerTrip: Math.max(0, Number(values.gatherPerTrip) || 0),
        builderDps: Math.max(0, Number(values.builderDps) || 0),
        healerDps: Math.max(0, Number(values.healerDps) || 0),
        researcherDps: Math.max(0, Number(values.researcherDps) || 0),
        transferCooldownSec,
        transferCooldownTicks: secondsToTicks(transferCooldownSec),
        astarCost: Math.max(0.01, Number(values.astarCost) || 0.1),
        upKeep: Math.max(0.01, Number(values.upKeep) || 0.01),
    });
}

function _getBuildingPlayerPrecomputedEntryObject(playerId, buildingKey, level) {
    let key = _normalizePlayerPrecomputedBuildingKey(buildingKey);
    let lvl = Math.max(1, clampThingLevel(level || 1));
    let levelEntries = PRECOMPUTED_STATS_MAP.building[key] || [];
    let values = {};

    for (let statKey of PRECOMPUTED_BUILDING_STAT_KEYS) {
        let levelEntry = levelEntries[_boostedLevel(lvl, _statBoostLevels(playerId, 'building', key, statKey))] || {};
        let arr = levelEntry[statKey] || null;
        let rLvl = getPlayerResearchLevel(playerId, 'building', key, statKey);
        let rawValue = arr ? arr[rLvl] : NaN;
        values[statKey] = _applyPlayerResourcePenaltyToStatValue(playerId, 'building', statKey, rawValue);
    }

    let maxEnergy = Number(values.maxEnergy);
    let cd = Number(values.cd);
    let spawnCd = Number(values.spawnCd);
    let visionRange = Number(values.visionRange);
    let attackRangeArea = Math.max(0, Number(values.attackRange) || 0);

    if (attackRangeArea > 0) visionRange = Math.max(visionRange || 0, attackRangeArea);

    return _simF32Stats({
        maxEnergy: Number.isFinite(maxEnergy) ? Math.max(1, Math.floor(maxEnergy)) : NaN,
        damage: Number(values.damage),
        blastDamage: Number(values.blastDamage),
        blastRadius: Number.isFinite(values.blastRadius) ? Math.max(0, Number(values.blastRadius)) : NaN,
        cd,
        cdTicks: Number.isFinite(cd) ? secondsToTicks(Math.max(0.001, cd)) : 0,
        spawnCd,
        spawnCdTicks: Number.isFinite(spawnCd) ? secondsToTicks(Math.max(0.001, spawnCd)) : 0,
        unitPrice: Number(values.unitPrice),
        visionRange: Number.isFinite(visionRange) ? Math.max(0, visionRange) : NaN,
        visionRangeArea: Number.isFinite(visionRange) ? Math.max(0, visionRange) : NaN,
        attackRangeArea,
        attackRange: attackRangeArea * AREA_UNIT_TILE_EQUIVALENT * TILE,
        multiplier: Number(values.multiplier),
        popCap: Number(values.popCap),
        burnDps: Number(values.burnDps),
        burnDuration: Number(values.burnDuration),
        poisonDps: Number(values.poisonDps),
        poisonDuration: Number(values.poisonDuration),
        freezeDps: Number(values.freezeDps),
        freezeDuration: Number(values.freezeDuration),
        wetDuration: Number(values.wetDuration),
        sandDuration: Number(values.sandDuration),
        watchDuration: Number(values.watchDuration),
        efficiency: Number(values.efficiency),
        upKeep: Math.max(0.01, Number(values.upKeep) || 0.01),
        drainRate: Number(values.drainRate),
    });
}

function rebuildPrecomputedStatsMapPlayer(targetPlayerId = null) {
    if (!ensurePrecomputedStatsMap()) return [];

    let targetIds = [];
    if (Number.isFinite(targetPlayerId)) {
        targetIds.push(Math.max(0, Math.floor(targetPlayerId)));
    } else if (Array.isArray(players)) {
        for (let playerId = 0; playerId < players.length; playerId++) targetIds.push(playerId);
    }

    PRECOMPUTED_STATS_MAP_PLAYER.length = Array.isArray(players) ? players.length : PRECOMPUTED_STATS_MAP_PLAYER.length;
    // Players with the same research levels and resource penalties get the
    // same values: build those once and copy the (flat) entries. Entries are
    // later updated in place per player, so each player owns its copies.
    let builtBySignature = new Map();
    let previewLevels = gameStarted ? null : ((startingResourcesConfig || {}).researchLevels || null);
    for (let playerId of targetIds) {
        _ensurePlayerResourceState(playerId);
        _updatePlayerResourcePenaltyMultipliers(playerId);
        // (Built with the current multipliers: they are the applied ones now.)
        _statAppliedSetCurrent(playerId);
        let signature = null;
        try {
            signature = JSON.stringify([
                previewLevels, (players[playerId] && players[playerId].researchLevels) || null,
                (players[playerId] && players[playerId].boosts) || null, (players[playerId] && players[playerId].boostOn) || null
            ]);
        } catch { signature = null; }
        let template = signature !== null ? builtBySignature.get(signature) : null;
        if (template) {
            let copy = { unit: {}, building: {} };
            for (let kind of ['unit', 'building']) {
                for (let key in template[kind]) copy[kind][key] = template[kind][key].map((entry,level) => entry ? _flatThingStatEntry(playerId,kind,key,level,{...entry}) : entry);
            }
            PRECOMPUTED_STATS_MAP_PLAYER[playerId] = copy;
            if (typeof simTrapResearchDone === 'function') simTrapResearchDone(playerId);
            continue;
        }
        let playerEntry = { unit: {}, building: {} };
        for (let unitType in PRECOMPUTED_STATS_MAP.unit) {
            playerEntry.unit[unitType] = [];
            for (let lvl = 0; lvl <= MAX_THING_LEVEL; lvl++) {
                playerEntry.unit[unitType][lvl] = _getUnitPlayerPrecomputedEntry(playerId, unitType, lvl);
            }
        }
        for (let buildingKey in PRECOMPUTED_STATS_MAP.building) {
            playerEntry.building[buildingKey] = [];
            for (let lvl = 0; lvl <= MAX_THING_LEVEL; lvl++) {
                playerEntry.building[buildingKey][lvl] = _getBuildingPlayerPrecomputedEntry(playerId, buildingKey, lvl);
            }
        }
        PRECOMPUTED_STATS_MAP_PLAYER[playerId] = playerEntry;
        if (signature !== null) builtBySignature.set(signature, playerEntry);
        if (typeof simTrapResearchDone === 'function') simTrapResearchDone(playerId);
    }

    return PRECOMPUTED_STATS_MAP_PLAYER;
}

function _ensurePrecomputedStatsMapPlayerEntry(playerId) {
    let pid = Math.max(0, Math.floor(playerId || 0));
    if (!PRECOMPUTED_STATS_MAP_PLAYER[pid]) PRECOMPUTED_STATS_MAP_PLAYER[pid] = { unit: {}, building: {} };
    return PRECOMPUTED_STATS_MAP_PLAYER[pid];
}

// Compute linked values before Float32 stores, matching a full table rebuild.
function _applyUnitPlayerPrecomputedStat(entry, statKey, value) {
    if (!entry) return entry;
    if (statKey === 'energy') entry.maxEnergy = Math.max(1, Math.floor(Number(value) || 1));
    else if (statKey === 'atk') entry.attackDamage = Math.max(0, Number(value) || 0);
    else if (statKey === 'atkCd') {
        const v = Math.max(0.01, Number(value) || 0.01);
        entry.attackCooldownSec = v;
        entry.attackCooldown = secondsToTicks(v);
    }
    else if (statKey === 'speed') entry.speed = Math.max(0.1, Number(value) || 0.1);
    else if (statKey === 'visionRange') {
        const v = Math.max(0.05, Number(value) || 0.05);
        entry.visionRangeArea = v;
        entry.visionRange = v * AREA_UNIT_TILE_EQUIVALENT;
    }
    else if (statKey === 'attackRange') {
        const v = Math.max(0, Number(value) || 0);
        entry.attackRangeArea = v;
        entry.attackRange = v * AREA_UNIT_TILE_EQUIVALENT * TILE;
    }
    else if (statKey === 'watchDuration') entry.watchDuration = Math.max(0, Number(value) || 0);
    else if (statKey === 'workerSearchDistance') entry.workerSearchDistance = Math.max(0, Number(value) || 0);
    else if (statKey === 'gatherPerTrip') entry.gatherPerTrip = Math.max(0, Number(value) || 0);
    else if (statKey === 'builderDps') entry.builderDps = Math.max(0, Number(value) || 0);
    else if (statKey === 'healerDps') entry.healerDps = Math.max(0, Number(value) || 0);
    else if (statKey === 'researcherDps') entry.researcherDps = Math.max(0, Number(value) || 0);
    else if (statKey === 'transferCooldown') {
        const v = Math.max(0.01, Number(value) || 0.01);
        entry.transferCooldownSec = v;
        entry.transferCooldownTicks = secondsToTicks(v);
    }
    else if (statKey === 'astarCost') entry.astarCost = Math.max(0.01, Number(value) || 0.01);
    else if (statKey === 'upKeep') entry.upKeep = Math.max(0.01, Number(value) || 0.01);
    return _simF32Stats(entry);
}

function _applyBuildingPlayerPrecomputedStat(entry, statKey, value) {
    if (!entry) return entry;
    if (statKey === 'maxEnergy') entry.maxEnergy = Number.isFinite(value) ? Math.max(1, Math.floor(Number(value))) : NaN;
    else if (statKey === 'cd') {
        const v = Number(value);
        entry.cd = v;
        entry.cdTicks = Number.isFinite(v) ? secondsToTicks(Math.max(0.001, v)) : 0;
    }
    else if (statKey === 'spawnCd') {
        const v = Number(value);
        entry.spawnCd = v;
        entry.spawnCdTicks = Number.isFinite(v) ? secondsToTicks(Math.max(0.001, v)) : 0;
    }
    else if (statKey === 'visionRange') {
        entry.visionRange = Number.isFinite(value) ? Math.max(0, Number(value)) : NaN;
        entry.visionRangeArea = entry.visionRange;
    }
    else if (statKey === 'attackRange') {
        const v = Number.isFinite(value) ? Math.max(0, Number(value)) : NaN;
        entry.attackRangeArea = v;
        entry.attackRange = Number.isFinite(v) ? (v * AREA_UNIT_TILE_EQUIVALENT * TILE) : NaN;
    }
    else if (statKey === 'blastRadius') entry.blastRadius = Number.isFinite(value) ? Math.max(0, Number(value)) : NaN;
    else entry[statKey] = Number(value);
    return _simF32Stats(entry);
}

function rebuildPrecomputedStatsMapPlayerThingStat(playerId, kind, key, statKey = null) {
    if (!ensurePrecomputedStatsMap()) return null;
    let pid = Math.max(0, Math.floor(playerId || 0));
    let playerEntry = _ensurePrecomputedStatsMapPlayerEntry(pid);
    let branch = kind === 'building' ? 'building' : 'unit';
    let normalizedKey = branch === 'unit'
        ? _normalizePlayerPrecomputedUnitKey(key)
        : _normalizePlayerPrecomputedBuildingKey(key);

    if (!statKey) {
        if (branch === 'building' && typeof simTrapResearchDone === 'function') simTrapResearchDone(pid);
        if (!playerEntry[branch][normalizedKey]) playerEntry[branch][normalizedKey] = [];
        let levels = playerEntry[branch][normalizedKey];
        for (let lvl = 0; lvl <= MAX_THING_LEVEL; lvl++) {
            levels[lvl] = branch === 'unit'
                ? _getUnitPlayerPrecomputedEntry(pid, normalizedKey, lvl)
                : _getBuildingPlayerPrecomputedEntry(pid, normalizedKey, lvl);
        }
        return levels;
    }
    // (Building stats: the movement kernel's trap strengths, its owner's.)
    if (branch === 'building' && typeof simTrapResearchDone === 'function') simTrapResearchDone(pid);
    // (With the multiplier its table follows: a newer one comes with the
    // tick's flush, for every stat of its stockpile at once.)
    return _rebuildPlayerThingStatLevels(pid, branch, normalizedKey, statKey, _getPlayerStatAppliedMultiplier(pid, branch, statKey));
}

// Whether a building's precomputed stat has any finite value (any level,
// any research level). Cached per source table, so rebuilding the stats map
// starts a fresh cache.
const _buildingStatValueCache = new WeakMap();
function _buildingStatHasValues(buildingKey, statKey) {
    let sources = PRECOMPUTED_STATS_MAP.building[buildingKey];
    if (!sources) return false;
    let cache = _buildingStatValueCache.get(sources);
    if (!cache) _buildingStatValueCache.set(sources, cache = new Map());
    let known = cache.get(statKey);
    if (known !== undefined) return known;
    let found = false;
    for (let lvl = 0; lvl < sources.length && !found; lvl++) {
        let values = sources[lvl] && sources[lvl][statKey];
        if (!values) continue;
        for (let i = 0; i < values.length; i++) if (Number.isFinite(Number(values[i]))) { found = true; break; }
    }
    cache.set(statKey, found);
    return found;
}

// One stat of one thing at every level. Research level, penalty and the unit
// fallback do not depend on the thing level, so they are resolved once.
function _rebuildPlayerThingStatLevels(pid, branch, normalizedKey, statKey, multiplier) {
    _precomputedStatsVersion++;
    if (branch === 'unit') unitStatsTablesChanged(pid, normalizedKey);
    let playerEntry = _ensurePrecomputedStatsMapPlayerEntry(pid);
    if (!playerEntry[branch][normalizedKey]) playerEntry[branch][normalizedKey] = [];
    let levels = playerEntry[branch][normalizedKey];
    let levelSources = (PRECOMPUTED_STATS_MAP[branch] || {})[normalizedKey] || [];
    let isUnit = branch === 'unit';
    let rLvl = getPlayerResearchLevel(pid, branch, normalizedKey, statKey);
    let boost = _statBoostLevels(pid, branch, normalizedKey, statKey);
    let fallback;
    for (let lvl = 0; lvl <= MAX_THING_LEVEL; lvl++) {
        let entry = levels[lvl];
        // Reach and sight are linked: recompute their small stat row together,
        // including when research is lowered or an old scene is imported.
        if (!entry || statKey === 'attackRange' || statKey === 'visionRange') {
            levels[lvl] = isUnit
                ? _getUnitPlayerPrecomputedEntry(pid, normalizedKey, lvl)
                : _getBuildingPlayerPrecomputedEntry(pid, normalizedKey, lvl);
            continue;
        }
        let levelSource = levelSources[_boostedLevel(lvl, boost)];
        let source = levelSource ? levelSource[statKey] : null;
        let rawValue;
        if (source) rawValue = source[rLvl];
        else if (isUnit) rawValue = fallback !== undefined ? fallback : (fallback = normalizePrecomputedUnitStatValue(normalizedKey, statKey, NaN));
        else rawValue = NaN;
        let value = _penalizeStatValue(statKey, rawValue, multiplier);
        if (isUnit) _applyUnitPlayerPrecomputedStat(entry, statKey, value);
        else _applyBuildingPlayerPrecomputedStat(entry, statKey, value);
    }
    if (isUnit && typeof effSharedTablesChanged === 'function') effSharedTablesChanged(pid, normalizedKey);
    return levels;
}

function ensurePrecomputedStatsMap() {
    return !!PRECOMPUTED_STATS_READY;
}

function getUnitStatFromMap(unitType, level, statKey, researchLevel = 0) {
    if (!ensurePrecomputedStatsMap()) return normalizePrecomputedUnitStatValue(unitType, statKey, NaN);
    let key = PRECOMPUTED_STATS_MAP.unit[unitType] ? unitType : 'norm';
    let lvl = clampThingLevel(level);
    let rLvl = clampResearchLevel(researchLevel);
    let arr = (((PRECOMPUTED_STATS_MAP.unit[key] || [])[lvl] || {})[statKey] || null);
    if (!arr) return normalizePrecomputedUnitStatValue(key, statKey, NaN);
    return normalizePrecomputedUnitStatValue(key, statKey, arr[rLvl]);
}

function getBuildingStatFromMap(buildingKey, level, statKey, researchLevel = 0) {
    if (!ensurePrecomputedStatsMap()) return NaN;
    let key = PRECOMPUTED_STATS_MAP.building[buildingKey] ? buildingKey : 'farm';
    let lvl = clampThingLevel(level);
    let rLvl = clampResearchLevel(researchLevel);
    let arr = (((PRECOMPUTED_STATS_MAP.building[key] || [])[lvl] || {})[statKey] || null);
    if (!arr) return NaN;
    return arr[rLvl];
}

function getUnitStatForOwner(playerId, unitType, level, statKey) {
    let ownerMap = PRECOMPUTED_STATS_MAP_PLAYER[playerId];
    let key = _normalizePlayerPrecomputedUnitKey(unitType);
    let lvl = Math.max(1, clampThingLevel(level || 1));
    let entry = ownerMap && ownerMap.unit && ownerMap.unit[key] ? ownerMap.unit[key][lvl] : null;
    if (entry) {
        if (statKey === 'energy') return entry.maxEnergy;
        if (statKey === 'atk') return entry.attackDamage;
        if (statKey === 'atkCd') return entry.attackCooldownSec;
        if (statKey === 'speed') return entry.speed;
        if (statKey === 'visionRange') return entry.visionRangeArea;
        if (statKey === 'attackRange') return entry.attackRangeArea;
        if (statKey === 'watchDuration') return entry.watchDuration;
        if (statKey === 'workerSearchDistance') return entry.workerSearchDistance;
        if (statKey === 'gatherPerTrip') return entry.gatherPerTrip;
        if (statKey === 'builderDps') return entry.builderDps;
        if (statKey === 'healerDps') return entry.healerDps;
        if (statKey === 'researcherDps') return entry.researcherDps;
        if (statKey === 'transferCooldown') return entry.transferCooldownSec;
        if (statKey === 'astarCost') return entry.astarCost;
        if (statKey === 'upKeep') return entry.upKeep;
    }
    let rLevel = getPlayerResearchLevel(playerId, 'unit', unitType, statKey);
    return getUnitStatFromMap(unitType, level, statKey, rLevel);
}

function getBuildingStatForOwner(playerId, buildingKey, level, statKey) {
    let ownerMap = PRECOMPUTED_STATS_MAP_PLAYER[playerId];
    let key = _normalizePlayerPrecomputedBuildingKey(buildingKey);
    let lvl = Math.max(1, clampThingLevel(level || 1));
    let entry = ownerMap && ownerMap.building && ownerMap.building[key] ? ownerMap.building[key][lvl] : null;
    if (entry && Object.prototype.hasOwnProperty.call(entry, statKey)) return entry[statKey];
    let rLevel = getPlayerResearchLevel(playerId, 'building', buildingKey, statKey);
    return getBuildingStatFromMap(buildingKey, level, statKey, rLevel);
}

function getUnitBaseResearchPrice(unitType) {
    let basePrice = Number((BASE_UNIT_STATS[unitType] || {}).price);
    if (Number.isFinite(basePrice) && basePrice > 0) return Math.max(1, Math.round(basePrice));
    let cfg = BARRACK_SPAWN_CONFIG[unitType];
    if (cfg && Number.isFinite(cfg.baseTime)) return Math.max(1, Math.round(cfg.baseTime * 10));
    return 20;
}

function makeResearchLevelId(kind, key, statKey) {
    return `${kind}:${key}:${statKey}`;
}

function getBaseBuildingmaxEnergyForResearch(buildingKey) {
    if (!buildingKey) return 1;
    let def = BASE_CARD_TYPES[buildingKey] || {};
    if (Number.isFinite(def.energy)) return def.energy;
    return 1;
}

function getResearchStatEntriesForThing(kind, key) {
    const thing = THING_STATS[key];
    if (!thing || thing.kind !== kind) return [];
    return Object.entries(thing.stats).filter(([,s])=>s.researchable).map(([statKey])=>({
        statKey, label:RESEARCH_STAT_LABELS[statKey] || statKey,
        baseValue:statKey === 'maxLevel' ? 1 : evaluateThingStatAtLevel(key,statKey,1)
    })).filter(s=>Number.isFinite(s.baseValue) && Math.abs(s.baseValue)>=1e-4);
}

let RESEARCH_THINGS = [];
let RESEARCH_THINGS_BY_ID = {};

function rebuildResearchThings() {
    let things = [];
    for (let key in BASE_CARD_TYPES) {
        let def = BASE_CARD_TYPES[key];
        if (!def || !Number.isFinite(def.price) || def.price <= 0) continue;
        let stats = getResearchStatEntriesForThing('building', key);
        things.push({
            kind: 'building',
            key,
            label: def.name || key,
            basePrice: Math.max(1, Math.floor(def.price)),
            stats
        });
    }
    for (let key in BASE_UNIT_STATS) {
        let stats = getResearchStatEntriesForThing('unit', key);
        things.push({
            kind: 'unit',
            key,
            label: getUnitDisplayName(key),
            basePrice: getUnitBaseResearchPrice(key),
            stats
        });
    }
    RESEARCH_THINGS = things;
    let out = {};
    for (let t of RESEARCH_THINGS) out[`${t.kind}:${t.key}`] = t;
    RESEARCH_THINGS_BY_ID = out;
}

function getResearchThing(kind, key) {
    return RESEARCH_THINGS_BY_ID[`${kind}:${key}`] || null;
}

function getResearchStatEntry(kind, key, statKey) {
    let thing = getResearchThing(kind, key);
    if (!thing) return null;
    return (thing.stats || []).find(s => s.statKey === statKey) || null;
}

function ensurePlayerResearchLevels(playerId) {
    if (!players[playerId]) return {};
    if (!players[playerId].researchLevels || typeof players[playerId].researchLevels !== 'object') {
        players[playerId].researchLevels = {};
    }
    return players[playerId].researchLevels;
}

function ensurePlayerResearchMultipliers(playerId) {
    if (!players[playerId]) return {};
    if (!players[playerId].researchMultipliers || typeof players[playerId].researchMultipliers !== 'object') {
        players[playerId].researchMultipliers = {};
    }
    return players[playerId].researchMultipliers;
}

function getPlayerResearchLevel(playerId, kind, key, statKey) {
    if (!gameStarted) {
        let thingId = getStartingThingId(kind, key);
        let previewLevel = Number((((startingResourcesConfig || {}).researchLevels || {})[thingId] || {})[statKey]);
        if (Number.isFinite(previewLevel)) return clampResearchLevel(previewLevel);
    }
    let levels = ensurePlayerResearchLevels(playerId);
    let id = makeResearchLevelId(kind, key, statKey);
    return clampResearchLevel(levels[id] || 0);
}

function getResearchMultiplier(playerId, kind, key, statKey) {
    if (!statKey) return 1;
    let mults = ensurePlayerResearchMultipliers(playerId);
    let id = makeResearchLevelId(kind, key, statKey);
    if (!Number.isFinite(mults[id])) {
        mults[id] = detPow(getResearchBonusExpForStat(kind, statKey, key), getPlayerResearchLevel(playerId, kind, key, statKey));
    }
    return Math.max(1, mults[id]);
}

function applyResearchMultiplierToValue(baseValue, mult, statKey) {
    if (!Number.isFinite(baseValue)) return baseValue;
    if (RESEARCH_DECREASE_STATS[statKey]) return baseValue / Math.max(1e-6, mult);
    return baseValue * mult;
}

function formatResearchStatValue(statKey, value) {
    if (!Number.isFinite(value)) return '-';
    let compact = (v, d = 2) => formatBigNumber(v, d);
    let areaCompact = (v) => `${Math.max(0, Math.floor(Number(v) || 0))} areas`;
    if (statKey === 'maxLevel') return `L${Math.max(1, Math.floor(Number(value) || 1))}`;
    if (statKey === 'burnDuration' || statKey === 'poisonDuration' || statKey === 'freezeDuration' || statKey === 'wetDuration' || statKey === 'sandDuration' || statKey === 'watchDuration') {
        return `${compact(value, 2)}s`;
    }
    if (statKey === 'burnDps' || statKey === 'poisonDps' || statKey === 'freezeDps') return compact(value, 2);
    if (statKey === 'blastDamage') return compact(value, 2);
    if (statKey === 'blastRadius') return areaCompact(value);
    if (statKey === 'workerSearchDistance') return areaCompact(value);
    if (statKey === 'attackRange' || statKey === 'visionRange') return areaCompact(value);
    if (statKey === 'speed' || statKey === 'multiplier' || statKey === 'astarCost') return compact(value, 2);
    if (statKey === 'efficiency') return compact(value, 2);
    if (statKey === 'drainRate') return `${compact(value, 1)}\uD83D\uDC80/ s`;
    if (statKey === 'spawnCd') return `${compact(value, 2)}s`;
    if (statKey === 'builderDps' || statKey === 'healerDps' || statKey === 'researcherDps' || statKey === 'gatherPerTrip') return compact(value, 1);
    if (statKey === 'upKeep') return `${compact(value, 2)}⚡/ s`;
    if (statKey === 'cd' || statKey === 'atkCd' || statKey === 'transferCooldown') return `${compact(value, 2)}s`;
    return compact(value, 0);
}

function formatResearchMultiplierValue(mult) {
    if (!Number.isFinite(mult)) return '-';
    return formatBigNumber(mult, 2);
}

function getResearchBuildingEfficiency(researchBuilding) {
    if (!researchBuilding || researchBuilding.type !== 'research') return 1;
    let lvl = Math.max(1, getThingBaseLevel(researchBuilding));
    let owner = Number.isFinite(researchBuilding.owner) ? researchBuilding.owner : localPlayerId;
    let mapped = getBuildingStatForOwner(owner, 'research', lvl, 'efficiency');
    if (Number.isFinite(mapped)) return Math.max(0, mapped);
    let baseEfficiency = Number((BASE_CARD_TYPES.research || {}).efficiency);
    return Number.isFinite(baseEfficiency) ? Math.max(0, baseEfficiency) : 1;
}

function getResearchCurrentStatValue(playerId, kind, key, statKey) {
    if (kind === 'building' && statKey === 'maxLevel') {
        let researched = Math.max(0, Math.floor(getPlayerResearchLevel(playerId, 'building', key, 'maxLevel') || 0));
        return Math.max(1, Math.min(MAX_THING_LEVEL, 1 + Math.round(researched * (MAX_THING_LEVEL - 1) / Math.max(1, MAX_RESEARCH_LEVEL))));
    }
    if (kind === 'unit') return getUnitStatForOwner(playerId, key, 1, statKey);
    if (kind === 'building') return getBuildingStatForOwner(playerId, key, 1, statKey);
    return NaN;
}

function getEffectiveCardTypeForPlayer(playerId, key) {
    let base = BASE_CARD_TYPES[key];
    if (!base) return null;
    let out = { ...base };
    for (let stat of getResearchStatEntriesForThing('building', key)) {
        let val = getResearchCurrentStatValue(playerId, 'building', key, stat.statKey);
        if (!Number.isFinite(val)) continue;
        if (stat.statKey === 'maxEnergy') {
            out.energy = val;
            if (Number.isFinite(base.towerEnergy)) out.towerEnergy = val;
        } else {
            out[stat.statKey] = val;
        }
    }
    return out;
}

function getEffectiveUnitStatsForPlayer(playerId, key) {
    let base = BASE_UNIT_STATS[key];
    if (!base) return null;
    let out = { ...base };
    for (let stat of getResearchStatEntriesForThing('unit', key)) {
        let val = getResearchCurrentStatValue(playerId, 'unit', key, stat.statKey);
        if (Number.isFinite(val)) out[stat.statKey] = val;
    }
    return out;
}

function getResearchStatCostWeight(kind, key, statKey, currentLevel) {
    let stat = getResearchStatEntry(kind, key, statKey);
    if (!stat) return 1;

    let lvl = Math.max(0, Math.floor(currentLevel || 0));
    let baseValue = getResearchStatValueAtLevel(kind, key, statKey, 0, 1);
    if (!Number.isFinite(baseValue)) baseValue = Number(stat.baseValue);

    let value = getResearchStatValueAtLevel(kind, key, statKey, lvl, 1);
    if (!Number.isFinite(value)) value = baseValue;

    let orientedBase = THING_STATS[key]?.stats[statKey]?.research?.direction === 'decrease'
        ? (1 / Math.max(1e-6, Math.abs(baseValue || 0)))
        : Math.abs(baseValue || 0);
    let orientedValue = THING_STATS[key]?.stats[statKey]?.research?.direction === 'decrease'
        ? (1 / Math.max(1e-6, Math.abs(value || 0)))
        : Math.abs(value || 0);

    if (!Number.isFinite(orientedBase) || orientedBase <= 0) orientedBase = 1;
    if (!Number.isFinite(orientedValue) || orientedValue <= 0) orientedValue = orientedBase;

    // Normalize different stat scales while still rewarding higher-value upgrades.
    let magnitudeNorm = Math.log10(1 + orientedBase);
    let relativeNorm = Math.max(1, orientedValue / orientedBase);
    let weight = detPow(1 + magnitudeNorm, 0.85) * detPow(relativeNorm, 0.65);

    return Math.max(0.1, Math.min(1000, weight));
}

function getResearchCost(kind, key, statKey, currentLevel) {
    let thing = getResearchThing(kind, key);
    let stat = getResearchStatEntry(kind, key, statKey);
    if (!thing || !stat) return 0;
    let lvl = Math.max(0, Math.floor(currentLevel || 0));
    if (lvl >= MAX_RESEARCH_LEVEL) return 0;
    let weight = getResearchStatCostWeight(kind, key, statKey, lvl);
    return Math.max(1, Math.floor(RESEARCH_WORK_BASE * weight * detPow(RESEARCH_COST_EXP, lvl)));
}

function getResearchWork(kind, key, statKey, currentLevel) {
    let thing = getResearchThing(kind, key);
    let stat = getResearchStatEntry(kind, key, statKey);
    if (!thing || !stat) return 0;
    let lvl = Math.max(0, Math.floor(currentLevel || 0));
    if (lvl >= MAX_RESEARCH_LEVEL) return 0;
    let weight = getResearchStatCostWeight(kind, key, statKey, lvl);
    return Math.max(1, Math.floor(RESEARCH_WORK_BASE * weight * detPow(RESEARCH_WORK_EXP, lvl)));
}

function ensurePlayerResearchQueueState(playerId) {
    if (!players[playerId]) return { researchQueue: [], researchTask: null };
    if (!Array.isArray(players[playerId].researchQueue)) players[playerId].researchQueue = [];
    if (!Object.prototype.hasOwnProperty.call(players[playerId], 'researchTask')) players[playerId].researchTask = null;
    return players[playerId];
}

function getPlayerResearchQueue(playerId) {
    return ensurePlayerResearchQueueState(playerId).researchQueue;
}

function getPlayerResearchTask(playerId) {
    return ensurePlayerResearchQueueState(playerId).researchTask;
}

function getResearchQueueCapacityForPlayer(playerId) {
    let labs = 0;
    // (The labs alone, from the worker buildings' index by type: a pass over
    // every worker building was ~0.4 ms with 4k of them, at every research
    // order.)
    const list = typeof _getWorkerSpawnersByType === 'function' ? _getWorkerSpawnersByType('research') : collectorSpawners;
    for (let s of list) {
        if (!s || s.type !== 'research' || s.owner !== playerId || s.energy <= 0) continue;
        labs++;
    }
    return Math.max(0, labs * 20);
}

function getPlayerResearchQueueTotalLength(playerId) {
    let queue = getPlayerResearchQueue(playerId);
    let task = getPlayerResearchTask(playerId);
    return (task ? 1 : 0) + queue.length;
}

function _researchTasksEquivalent(a, b) {
    if (!a || !b) return false;
    return String(a.kind || '') === String(b.kind || '')
        && String(a.key || '') === String(b.key || '')
        && String(a.statKey || '') === String(b.statKey || '')
        && Math.max(0, Math.floor(Number(a.fromLevel) || 0)) === Math.max(0, Math.floor(Number(b.fromLevel) || 0))
        && Math.max(0, Math.floor(Number(a.toLevel) || 0)) === Math.max(0, Math.floor(Number(b.toLevel) || 0));
}

function _normalizeResearchTaskForOwner(task, owner) {
    if (!task || typeof task !== 'object') return null;
    let kind = String(task.kind || '');
    let key = String(task.key || '');
    let statKey = String(task.statKey || '');
    if (!kind || !key || !statKey) return null;
    if (!getResearchStatEntry(kind, key, statKey)) return null;

    let normalizedOwner = Math.max(0, Math.floor(Number(owner) || 0));
    // maxLevel research maps 0..MAX_RESEARCH_LEVEL onto thing levels, so every stat shares one cap.
    let capLevel = MAX_RESEARCH_LEVEL;

    let fromLevel = Math.max(0, Math.floor(Number(task.fromLevel) || 0));
    let toLevel = Math.max(fromLevel, Math.floor(Number(task.toLevel) || (fromLevel + 1)));
    if (fromLevel >= capLevel) {
        toLevel = fromLevel;
    } else {
        toLevel = Math.min(capLevel, Math.max(fromLevel + 1, toLevel));
    }

    let workRequired = Number(task.workRequired);
    if (!Number.isFinite(workRequired) || workRequired < 0) {
        workRequired = fromLevel >= capLevel ? 0 : getResearchWork(kind, key, statKey, fromLevel);
    }
    workRequired = Math.max(0, Number(workRequired) || 0);

    let cost = Number(task.cost);
    if (!Number.isFinite(cost) || cost < 0) {
        cost = fromLevel >= capLevel ? 0 : getResearchCost(kind, key, statKey, fromLevel);
    }
    cost = Math.max(0, Number(cost) || 0);

    let workDone = Math.max(0, Number(task.workDone) || 0);
    if (workRequired > 0) workDone = Math.min(workRequired, workDone);
    else workDone = 0;

    task.owner = normalizedOwner;
    task.kind = kind;
    task.key = key;
    task.statKey = statKey;
    task.fromLevel = fromLevel;
    task.toLevel = toLevel;
    task.cost = cost;
    task.workRequired = workRequired;
    task.workDone = workDone;
    return task;
}

function tryAdvancePlayerResearchTask(playerId) {
    let p = ensurePlayerResearchQueueState(playerId);
    while (true) {
        if (p.researchTask) {
            p.researchTask = _normalizeResearchTaskForOwner(p.researchTask, playerId);
        }

        // Safety net: never let a completed/invalid active task stall the queue at 100%.
        if (p.researchTask) {
            let required = Math.max(0, Number(p.researchTask.workRequired) || 0);
            let done = Math.max(0, Number(p.researchTask.workDone) || 0);
            if (!(required > 0) || done >= required) {
                applyResearchCompletion(playerId, p.researchTask);
                p.researchTask = null;
                continue;
            }
            break;
        }

        if (!Array.isArray(p.researchQueue) || p.researchQueue.length <= 0) break;
        let nextTask = _normalizeResearchTaskForOwner(p.researchQueue.shift(), playerId);
        if (!nextTask) continue;
        p.researchTask = nextTask;
    }
    return p.researchTask;
}

function getResearchQueueDepthForStat(researchBuilding, kind, key, statKey) {
    if (!researchBuilding) return 0;
    let owner = researchBuilding.owner;
    if (!Number.isFinite(owner)) return 0;
    let task = getPlayerResearchTask(owner);
    let queue = getPlayerResearchQueue(owner);
    let n = 0;
    if (task && task.kind === kind && task.key === key && task.statKey === statKey) n++;
    for (let q of queue) {
        if (q && q.kind === kind && q.key === key && q.statKey === statKey) n++;
    }
    return n;
}

function getResearchQueuedDepthForPlayer(playerId, kind, key, statKey) {
    let task = getPlayerResearchTask(playerId);
    let queue = getPlayerResearchQueue(playerId);
    let n = 0;
    if (task && task.kind === kind && task.key === key && task.statKey === statKey) n++;
    for (let q of queue) {
        if (q && q.kind === kind && q.key === key && q.statKey === statKey) n++;
    }
    return n;
}

function makeResearchTask(owner, kind, key, statKey, projectedLevel) {
    let lvl = Math.max(0, Math.floor(projectedLevel || 0));
    return {
        owner,
        kind,
        key,
        statKey,
        fromLevel: lvl,
        toLevel: lvl + 1,
        cost: getResearchCost(kind, key, statKey, lvl),
        workRequired: getResearchWork(kind, key, statKey, lvl),
        workDone: 0
    };
}

// The queue's levels, costs and progress made again from its order. With
// `only` (tasks standing for their stats), those stats' tasks alone: a
// move, a removal or an insertion keeps every other stat's tasks in their
// order (a pass over every task's tables was ~5 ms with 600 queued). A
// stat whose tasks' levels do not follow their order (a queue an older
// build left so) is made again too: any move or removal heals the queue.
function researchStatId(task) { return `${task.kind || ''}:${task.key || ''}:${task.statKey || ''}`; }
function _researchTaskOfStats(task, only) {
    for (let i = 0; i < only.length; i++) { const o = only[i]; if (task.statKey === o.statKey && task.key === o.key && task.kind === o.kind) return true; }
    return false;
}
// (Levels only, from the research levels and the order: no tables read.)
function _researchStatsOutOfOrder(playerId, ordered, only) {
    const seen = new Map();
    for (const task of ordered) {
        let byKey = seen.get(task.kind);
        if (!byKey) seen.set(task.kind, byKey = new Map());
        let byStat = byKey.get(task.key);
        if (!byStat) byKey.set(task.key, byStat = new Map());
        let e = byStat.get(task.statKey);
        if (!e) byStat.set(task.statKey, e = { next: Math.max(0, Math.floor(Number(getPlayerResearchLevel(playerId, task.kind, task.key, task.statKey)) || 0)), bad: false });
        const from = e.next++, to = from >= MAX_RESEARCH_LEVEL ? from : Math.min(MAX_RESEARCH_LEVEL, from + 1);
        if (e.bad || (task.fromLevel === from && task.toLevel === to)) continue;
        e.bad = true;
        if (!_researchTaskOfStats(task, only)) only.push(task);
    }
}
function rebasePlayerResearchQueueState(playerId, only = null) {
    let p = ensurePlayerResearchQueueState(playerId);
    let ordered = [];
    if (p.researchTask) ordered.push(p.researchTask);
    if (Array.isArray(p.researchQueue) && p.researchQueue.length > 0) {
        for (let task of p.researchQueue) {
            if (task) ordered.push(task);
        }
    }
    if (ordered.length <= 0) return p;
    if (only) _researchStatsOutOfOrder(playerId, ordered, only);

    // Progress belongs to the level, not the task object: same-stat tasks are interchangeable,
    // so the lowest queued level keeps the most-advanced progress after reordering.
    let workDoneByStat = Object.create(null);
    for (let task of ordered) {
        if (only && !_researchTaskOfStats(task, only)) continue;
        let statKey = researchStatId(task);
        (workDoneByStat[statKey] || (workDoneByStat[statKey] = [])).push(task);
    }
    for (let statKey in workDoneByStat) {
        let tasks = workDoneByStat[statKey];
        tasks.sort((a, b) => (Math.floor(Number(a.fromLevel) || 0)) - (Math.floor(Number(b.fromLevel) || 0)));
        workDoneByStat[statKey] = tasks.map(t => Math.max(0, Number(t.workDone) || 0));
    }

    let queuedLevelsByStat = Object.create(null);
    for (let task of ordered) {
        if (!task) continue;
        if (only && !_researchTaskOfStats(task, only)) continue;
        let statKey = researchStatId(task);
        let baseLevel = Math.max(0, Math.floor(Number(getPlayerResearchLevel(playerId, task.kind, task.key, task.statKey)) || 0));
        let priorSameStat = Math.max(0, Math.floor(Number(queuedLevelsByStat[statKey]) || 0));
        let fromLevel = baseLevel + priorSameStat;
        let capLevel = MAX_RESEARCH_LEVEL;
        let atCap = fromLevel >= capLevel;
        let nextWorkRequired = atCap ? 0 : Math.max(0, Number(getResearchWork(task.kind, task.key, task.statKey, fromLevel)) || 0);

        task.owner = playerId;
        task.fromLevel = fromLevel;
        task.toLevel = atCap ? fromLevel : Math.min(capLevel, fromLevel + 1);
        task.cost = atCap ? 0 : Math.max(0, Number(getResearchCost(task.kind, task.key, task.statKey, fromLevel)) || 0);
        task.workRequired = nextWorkRequired;
        task.workDone = Math.max(0, Math.min(nextWorkRequired, Number(workDoneByStat[statKey][priorSameStat]) || 0));

        queuedLevelsByStat[statKey] = priorSameStat + 1;
    }

    p.researchTask = ordered[0] || null;
    p.researchQueue.length = 0;
    for (let i = 1; i < ordered.length; i++) p.researchQueue.push(ordered[i]);
    return p;
}

// The units take the new tables at their next effective-stats refresh (a
// twentieth of them a tick, UNIT_EFFECTIVE_STATS_RECALC_TICKS): their
// (owner, type) table version (unitStatsTablesChanged) no longer matches
// theirs (esVer), so the refresh applies their level scaling anew (and the
// energy bound). No pass over every unit at the research's tick.
function applyUnitResearchUpgradeToExistingUnits(owner, unitType, statKey) {
    rebuildPrecomputedStatsMapPlayerThingStat(owner, 'unit', unitType, statKey);
}

// Building/floor stats are shared views. Publishing research requires no
// instance versions, catch-up jobs or staggered building sweep.
function applyBuildingResearchUpgradeToExisting(owner,buildingKey,statKey) {
    rebuildPrecomputedStatsMapPlayerThingStat(owner,'building',buildingKey,statKey);
}
function applyResearchCompletion(owner, task) {
    if (!task) return;
    let levels = ensurePlayerResearchLevels(owner);
    let mults = ensurePlayerResearchMultipliers(owner);
    let id = makeResearchLevelId(task.kind, task.key, task.statKey);
    let prevLevel = clampResearchLevel(levels[id] || 0);
    let nextLevel = clampResearchLevel(prevLevel + 1);
    if (nextLevel <= prevLevel) return;
    levels[id] = nextLevel;
    mults[id] = detPow(getResearchBonusExpForStat(task.kind, task.statKey, task.key), nextLevel);
    if (task.kind === 'unit') applyUnitResearchUpgradeToExistingUnits(owner, task.key, task.statKey);
    if (task.kind === 'building') applyBuildingResearchUpgradeToExisting(owner, task.key, task.statKey);
    if (task.kind === 'building' && task.key === 'house' && task.statKey === 'popCap') {
        recomputePlayerPopCaps();
    }
    // maxLevel changes upgrade eligibility; numeric stat publication needs no instance work.
    if (task.kind === 'building' && task.statKey === 'maxLevel') recalculateAdjacency();
}

function completeActiveResearchTaskForPlayer(owner, completedTask) {
    if (!Number.isFinite(owner) || !completedTask) return;
    let p = ensurePlayerResearchQueueState(owner);
    p.researchTask = _normalizeResearchTaskForOwner(p.researchTask, owner);
    if (!p.researchTask) {
        tryAdvancePlayerResearchTask(owner);
        return;
    }

    let isMatchingTask = (p.researchTask === completedTask) || _researchTasksEquivalent(p.researchTask, completedTask);
    if (!isMatchingTask) {
        let required = Math.max(0, Number(p.researchTask.workRequired) || 0);
        let done = Math.max(0, Number(p.researchTask.workDone) || 0);
        if (required > 0 && done < required) return;
    }

    applyResearchCompletion(owner, p.researchTask);
    p.researchTask = null;
    tryAdvancePlayerResearchTask(owner);
}

function getResearchQueueTotalLength(researchBuilding) {
    if (!researchBuilding || !Number.isFinite(researchBuilding.owner)) return 0;
    return getPlayerResearchQueueTotalLength(researchBuilding.owner);
}

function computeUnitLevelScaledStats(unit, level) {
    if (!unit) return null;
    let lvl = Math.max(1, clampThingLevel(level || 1));
    let owner = Number.isFinite(unit.owner) ? unit.owner : localPlayerId;
    if (!PRECOMPUTED_STATS_MAP_PLAYER[owner]) rebuildPrecomputedStatsMapPlayer(owner);
    let unitType = _normalizePlayerPrecomputedUnitKey(unit.unitType || 'norm');
    return (((PRECOMPUTED_STATS_MAP_PLAYER[owner] || {}).unit || {})[unitType] || [])[lvl] || _getUnitPlayerPrecomputedEntry(owner, unitType, lvl);
}

// Clones remember their source, so a snapshot can send one as a reference to
// the source plus its maxEnergy (snapshots check the rest still matches).
const precomputedCloneSource = new WeakMap();
// Every unit with the same effective table and base maxEnergy shares one
// clone (per source table, per base maxEnergy) instead of allocating its
// own on each refresh. Source tables are updated in place when a stat is
// rebuilt (research, resource penalties): that bumps the version and drops
// the clones made from their old values.
const _precomputedCloneCache = new WeakMap();
let _precomputedStatsVersion = 0;

function clonePrecomputedWithBaseMaxEnergy(baseStats, effectiveStats) {
        let preserveBaseMaxEnergy = arguments.length < 3 ? true : !!arguments[2];
        if (!effectiveStats || typeof effectiveStats !== 'object') return effectiveStats;
        if (!preserveBaseMaxEnergy) return effectiveStats;
        let baseMaxEnergy = Number(baseStats && baseStats.maxEnergy);
        if (!Number.isFinite(baseMaxEnergy)) return effectiveStats;
        if (Number(effectiveStats.maxEnergy) === baseMaxEnergy) return effectiveStats;
        let byBase = _precomputedCloneCache.get(effectiveStats);
        if (!byBase || byBase.version !== _precomputedStatsVersion) {
            _precomputedCloneCache.set(effectiveStats, byBase = new Map());
            byBase.version = _precomputedStatsVersion;
        }
        let clone = byBase.get(baseMaxEnergy);
        if (clone) return clone;
        clone = { ...effectiveStats, maxEnergy: baseMaxEnergy };
        precomputedCloneSource.set(clone, effectiveStats);
        byBase.set(baseMaxEnergy, clone);
        return clone;
}

// While set (_refreshThingPrecomputedStats: the level scaling, then the
// effective one), the movement columns are told of the stats once, at the
// end, not of the step between (a change that is undone at once must not
// count: simMoveStatsChanged disarms a unit whose stats changed).
let _unitStatsNotifyHeld = false;
function applyUnitLevelScaling(unit, level) {
    const previousRow=unit && unit._us ? unit._us.statRow[unit._si] : -1;
    if (!unit) return;
    let lvl = Math.max(1, Math.floor(level || 1));
    unit.unitLevel = lvl;
    let shouldSyncStackFromLevel = !(Number.isFinite(unit.stackCount) && unit.stackCount >= 1)
        || !Number.isFinite(unit.baseLevel)
        || Math.max(1, Math.floor(unit.baseLevel || 1)) !== lvl;
    if (shouldSyncStackFromLevel) {
        unit.stackCount = getRequiredStacksForLevel(lvl);
    }

    let scaled = computeUnitLevelScaledStats(unit, lvl);
    if (!scaled) return;

    let prevEnergyAbs = Number(unit.energy);
    if (!Number.isFinite(prevEnergyAbs)) prevEnergyAbs = Number(scaled.maxEnergy) || 1;
    unit.preComputedBase = scaled;
    unit.preComputedEffective = clonePrecomputedWithBaseMaxEnergy(unit.preComputedBase, scaled);
    unit.basePreComputed = unit.preComputedBase;
    unit.preComputed = unit.preComputedEffective;

    let unitDef = BASE_UNIT_STATS[unit.unitType] || BASE_UNIT_STATS.norm || {};
    unit.isFlying = !!unitDef.isFlying;
    unit.maxEnergy = unit.preComputedBase.maxEnergy;
    if (typeof simUnitMaxE === 'function') simUnitMaxE(unit);
    unit.energy = Math.max(1, Math.min(unit.preComputedBase.maxEnergy, Math.floor(prevEnergyAbs)));

    unit.baseLevel = lvl;
    unit.effectiveStacks = Math.max(1, Number.isFinite(unit.stackCount) ? Math.floor(unit.stackCount) : 1);
    unit.effectiveLevel = lvl;
    if (typeof effStatsUnitBaseChanged === 'function') effStatsUnitBaseChanged(unit);
    if (typeof _effRowAttach === 'function') _effRowAttach(unit);
    if (!_unitStatsNotifyHeld && typeof simMoveStatsChanged === 'function') simMoveStatsChanged(unit, previousRow);
    if (typeof visCoverOnUnitSpatialChanged === 'function') visCoverOnUnitSpatialChanged(unit);
}

// A restored unit's effective tables (utils_snapshot.js decode): its base
// tables came with it, the effective ones are derived; made as
// applyUnitEffectiveScaling makes them, with no energy, level or cover side
// effects (the unit's fields are the snapshot's).
function unitDerivedStatsRestore(unit) {
    if (!unit || unit._needsStatsInit || unit.preComputed) return;
    const base = unit.preComputedBase || unit.basePreComputed;
    if (!base) { unit._needsStatsInit = true; return; }
    const lvl = Math.max(1, Math.floor(Number(unit.effectiveLevel) || Number(unit.unitLevel) || 1));
    const scaled = computeUnitLevelScaledStats(unit, lvl);
    if (!scaled) { unit._needsStatsInit = true; return; }
    unit.preComputedEffective = clonePrecomputedWithBaseMaxEnergy(base, scaled);
    unit.preComputed = unit.preComputedEffective;
}

function applyUnitEffectiveScaling(unit, effectiveLevel, previousRow) {
    if (!Number.isInteger(previousRow)) previousRow=unit && unit._us ? unit._us.statRow[unit._si] : -1;
    if (!unit) return;
    let lvl = Math.max(1, Math.floor(effectiveLevel || 1));
    let scaled = computeUnitLevelScaledStats(unit, lvl);
    if (!scaled) return;

    unit.preComputedEffective = clonePrecomputedWithBaseMaxEnergy(unit.preComputedBase, scaled);
    unit.preComputed = unit.preComputedEffective;

    let unitDef = BASE_UNIT_STATS[unit.unitType] || BASE_UNIT_STATS.norm || {};
    unit.isFlying = !!unitDef.isFlying;
    unit.maxEnergy = Number(unit.preComputedBase && unit.preComputedBase.maxEnergy) || unit.preComputedEffective.maxEnergy;
    if (typeof simUnitMaxE === 'function') simUnitMaxE(unit);
    if (!Number.isFinite(unit.energy)) unit.energy = Math.max(1, unit.maxEnergy);
    unit.energy = Math.max(1, Math.min(unit.maxEnergy, Math.floor(unit.energy)));

    unit.effectiveLevel = lvl;
    if (typeof visCoverOnUnitSpatialChanged === 'function') visCoverOnUnitSpatialChanged(unit);
    // (Its tables as a stat row: units of the same tables take it in the kernel.)
    if (typeof _effRowAttach === 'function') _effRowAttach(unit);
    if (!_unitStatsNotifyHeld && typeof simMoveStatsChanged === 'function') simMoveStatsChanged(unit, previousRow);
}
