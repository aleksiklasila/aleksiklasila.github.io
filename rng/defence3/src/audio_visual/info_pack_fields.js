'use strict';
// The info panel's numbers per group, as the packer thread writes them
// (info_pack_worker.js) and the page shows them (info_panel_static.js):
// one Float64Array row of IPF_N fields per group of the panel's catalogue.
// Loaded by both (a script on the page, importScripts in the packer).
const IPF_NAMES = [
    // Members and states.
    'n', 'ready', 'uc', 'upg', 'stacking',
    // Energy: current, upgrade trigger and effective maximum (sums).
    'energy', 'trig', 'effMax', 'maxCol',
    // Upkeep of the buildings, of their units / workers; vision (tile sums).
    'upB', 'upE', 'uupB', 'uupE', 'visB', 'visE',
    // Production queue: queued, members with a queue, estimated energy left, the front entries' cost.
    'queued', 'withQ', 'qcost', 'qreq',
    // Toggles: members with each on.
    'salvage', 'autoUp', 'autoStack', 'queueOn', 'buildOn', 'autoRes', 'researching',
    // Mines' amounts; rally tiles (gx * 65536 + gy, -1 none) smallest / largest.
    'amount', 'amountMax', 'rallyMin', 'rallyMax',
    // Houses' population cap, farms' multiplier (sums at base / effective levels).
    'popB', 'popE', 'multB', 'multE',
    // Levels: base / effective smallest and largest; distinct level-state tokens.
    'lvMin', 'lvMax', 'elvMin', 'elvMax', 'tokens',
    // The member standing for the group (its bin's first): slot, levels, stacks, manual stacks, effective stacks.
    'repSlot', 'repLv', 'repElv', 'repStacks', 'repMStacks', 'repEStacks', 'repRally', 'local',
    // Its stats at its base / effective level: damage, attack range (areas), cooldown, burn/poison/freeze dps and duration...
    'dmgB', 'dmgE', 'rangeB', 'rangeE', 'cdB', 'cdE', 'x1', 'x2', 'x3', 'x4',
    // A barrack's unit at the standing member's effective level.
    'uEnergy', 'uAtk', 'uRange', 'uSpd',
    // Units: shown energy over base maximum, stacks, attack, dps, speed, range, vision, watch, upkeep, work, transfer cooldown, salvage levels, holding.
    'uBe', 'uBm', 'uSt', 'uEst', 'uBa', 'uEa', 'uBd', 'uEd', 'uBs', 'uEs', 'uBr', 'uEr', 'uBv', 'uEv', 'uBw', 'uEw', 'uBu', 'uEu',
    'uWork', 'uEwork', 'uTcd', 'uEtcd', 'uSl', 'uEsl', 'uHold', 'uEnergySum', 'uMaxSum'
];
const IPF = {};
IPF_NAMES.forEach((k, i) => { IPF[k] = i; });
const IPF_N = IPF_NAMES.length;
// Building / unit stat columns the packer reads from the stat tables (data_dynamic.js _flatThingStatEntry), by name.
const IPF_BUILDING_STATS = ['maxEnergy', 'upKeep', 'visionRangeArea', 'damage', 'cd', 'attackRangeArea', 'popCap', 'multiplier',
    'burnDps', 'burnDuration', 'poisonDps', 'poisonDuration', 'freezeDps', 'freezeDuration', 'wetDuration', 'sandDuration', 'watchDuration'];
const IPF_UNIT_STATS = ['maxEnergy', 'attackDamage', 'attackCooldown', 'speed', 'attackRangeArea', 'visionRange', 'upKeep', 'watchDuration',
    'gatherPerTrip', 'builderDps', 'healerDps', 'researcherDps', 'transferCooldownSec'];
