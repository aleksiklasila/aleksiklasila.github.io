'use strict';

// Counts are totals across both owners, never per-team fixture names.
function fixture({ units = 200, statics = 100, map = 80, seed = 1701,
    composition = 'mixed', staticComposition = 'mixed' } = {}) {
    for (const [key, value] of Object.entries({ units, statics, map, seed })) {
        if (!Number.isSafeInteger(value) || value < (key === 'map' ? 8 : 0)) throw Error(`Invalid ${key}: ${value}`);
    }
    if (units < 2 || units % 2 || statics % 2) throw Error('Two-owner fixtures require even totals and at least two units');
    if (!['mixed', 'combat'].includes(composition)) throw Error('Unknown unit composition');
    if (!['mixed', 'building', 'floor'].includes(staticComposition)) throw Error('Unknown static composition');
    const perOwner = units / 2, staticPerOwner = statics / 2;
    const workers = composition === 'mixed' ? Math.floor(perOwner / 5) : 0;
    const buildings = staticComposition === 'floor' ? 0 : staticComposition === 'building' ? staticPerOwner : Math.floor(staticPerOwner / 2);
    const spawnCounts = {};
    for (const [type, count] of Object.entries({ 'building:barrack_norm': buildings,
        'building:sand': staticPerOwner - buildings, 'unit:norm': perOwner - workers, 'unit:builder_unit': workers })) {
        if (count) spawnCounts[type] = { 1: count };
    }
    return { units, statics, map, seed, composition, staticComposition, owners: [0, 1],
        spawnCounts, name: `${units}u-${statics}s-${map}-${composition}-${staticComposition}-s${seed}` };
}

function matrix() {
    return [1000000, 2000000, 3000000, 4000000].flatMap(units =>
        [100000, 200000, 400000].flatMap(statics => [1000, 1500, 2000].map(map => fixture({ units, statics, map }))));
}

function balancedFixture({ units = 2000000, statics = 200000, map = 1000, seed = 1701 } = {}) {
    const result = fixture({ units, statics, map, seed });
    const H = require('./net-harness.cjs');
    const catalog = new H.World().spawn('load-fixture-catalog');
    const types = JSON.parse(catalog.eval(`JSON.stringify({units:Object.keys(BASE_UNIT_STATS).sort(),
        buildings:Object.keys(BASE_CARD_TYPES).filter(k=>!BASE_CARD_TYPES[k].notBuildable && ['wall','floor'].includes(BASE_CARD_TYPES[k].target)).sort(),
        portals:Object.keys(BASE_CARD_TYPES).filter(k=>BASE_CARD_TYPES[k].isCloud).sort()})`));
    result.spawnCounts = {};
    const allocate = (kind, names, total, rare) => {
        if (total < rare.length) throw Error('Population is too small for the special entities');
        for (const name of rare) result.spawnCounts[kind + ':' + name] = { 1: 1 };
        const ordinary = names.filter(name => !rare.includes(name)), remaining = total - rare.length;
        ordinary.forEach((name, i) => {
            const count = Math.floor(remaining / ordinary.length) + (i < remaining % ordinary.length ? 1 : 0);
            if (count) result.spawnCounts[kind + ':' + name] = { 1: count };
        });
    };
    allocate('unit', types.units, units / 2, ['king']);
    allocate('building', types.buildings, statics / 2, types.portals);
    result.composition = result.staticComposition = 'all';
    result.specialCountsPerOwner = { king: 1, portalEndpoints: Object.fromEntries(types.portals.map(k => [k, 1])) };
    result.excluded = ['shrine (passive, not buildable)', 'area_upgrader (area action, not a placed entity)'];
    result.name = `${units}u-${statics}s-${map}-all-s${seed}`;
    return result;
}

// Runs unchanged in the real worker and the existing VM startup/snapshot tests.
// Return summaries, not a second serialized copy of the world.
function inspectLoadWorld(expected, withHash = true) {
    const errors = [], ids = new Set(), byOwner = {}, counts = {};
    const fail = message => { if (errors.length < 32) errors.push(message); };
    for (const owner of expected.owners) byOwner[owner] = { units: 0, buildings: 0, floor: 0, types: {} };
    let alive = 0;
    for (const u of units) {
        if (!Number.isSafeInteger(u.id) || u.id < 1 || ids.has(u.id)) fail(`Invalid/duplicate unit ID ${u.id}`);
        ids.add(u.id);
        if (u.dead) continue;
        alive++;
        const row = byOwner[u.owner];
        if (!row) { fail(`Unknown unit owner ${u.owner}`); continue; }
        row.units++;
        const key = 'unit:' + u.unitType;
        row.types[key] = (row.types[key] || 0) + 1;
        const gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE), cell = grid[gy]?.[gx];
        if (!Number.isFinite(u.x) || !Number.isFinite(u.y) || !cell || cell.type === TYPE_WALL) fail(`Illegal unit placement ${u.id}`);
        if (getUnitById(u.id) !== u) fail(`Broken unit lookup ${u.id}`);
        if (u.targetUnit && getUnitById(u.targetUnit.id) !== u.targetUnit) fail(`Broken target reference ${u.id}`);
        if (u.workerTarget != null) fail(`Unexpected initial worker target ${u.id}`);
    }
    let buildings = 0, floor = 0;
    const occupied = new Set();
    for (const list of ['t', 'b', 's', 'f']) for (const e of _snapListEntities(list)) {
        const cell = grid[e.gy]?.[e.gx], key = e.gx + ',' + e.gy;
        if (occupied.has(key)) fail(`Duplicate static placement ${key}`);
        occupied.add(key);
        if (!cell || (list === 'f' ? cell.item !== e : getTileEntityRef(e.gx, e.gy) !== e)) fail(`Broken static reference ${key}`);
        const owner = list === 'f' ? cell?.owner : e.owner, row = byOwner[owner];
        if (!row) { fail(`Unknown static owner ${owner}`); continue; }
        if (list === 'f') { floor++; row.floor++; } else { buildings++; row.buildings++; }
        const type = 'building:' + (list === 'b' ? 'barrack_' + e.unitType : e.type);
        row.types[type] = (row.types[type] || 0) + 1;
    }
    for (const owner of expected.owners) {
        const row = byOwner[owner];
        if (players[owner].popCount !== row.units) fail(`Owner ${owner} population accounting differs`);
        for (const [type, levels] of Object.entries(expected.spawnCounts)) {
            const want = Object.values(levels).reduce((a, b) => a + b, 0);
            if ((row.types[type] || 0) !== want) fail(`Owner ${owner} ${type}: requested ${want}, created ${row.types[type] || 0}; insufficient placement or startup truncation`);
        }
    }
    if (units.length !== expected.units || alive !== expected.units) fail(`Unit total: requested ${expected.units}, created ${units.length}, surviving ${alive}`);
    if (buildings + floor !== expected.statics) fail(`Static total: requested ${expected.statics}, created ${buildings + floor}`);
    if (GRID_W !== expected.map || GRID_H !== expected.map) fail('Map dimensions differ');
    if (currentTick !== 0 || gameTime !== 0) fail(`Gameplay advanced: tick ${currentTick}, time ${gameTime}`);
    Object.assign(counts, { createdUnits: units.length, survivingUnits: alive, buildings, floor, byOwner });
    return { counts, errors, tick: currentTick, gameTime,
        // Full rotation of the canonical snapshot digest, not the fast sampled hash.
        hash: withHash ? snapTickHash(currentTick, true).pairs : null,
        memory: typeof simMemoryStats === 'function' ? simMemoryStats() : null };
}

module.exports = { fixture, matrix, balancedFixture, inspectLoadWorld };
