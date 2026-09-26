// Units that see an enemy across an area border must be able to fight it.
// Attack range is area based (a range below one area is the unit's own area)
// and cross-team collision keeps enemy bodies apart, so a king chasing a
// soldier standing just beyond the border used to stay "attacking" forever
// without striking. Bodies in contact now count as within reach of the next
// area. Units that cannot see each other still do not engage.
//
// Two peers play: the host places the units at game start (the guest loads
// that state from the initial snapshot) and every peer must agree on every
// tick's state hash.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const CONTROLS = {
    ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '30', 'cfg-map-type': 'arena',
    'cfg-starting-energy': '2000000', 'cfg-starting-astar': '2000000', 'cfg-max-pop': '5000', 'cfg-full-vis': 'team'
};

// Runs once when the host's game starts (after the starting units spawned):
// finds horizontal floor tile pairs in adjacent areas and moves one unit of
// each pair of the scenario onto them.
function placementSetup(pairs) {
    return `
startingResourcesConfig = ${JSON.stringify({ researchLevels: {}, spawnCounts: {
        'unit:king': { 1: 1 }, 'unit:norm': { 1: 3 }, 'unit:laser_resistant': { 1: 1 }, 'building:house': { 1: 1 } } })};
(() => {
    const original = recomputePlayerPopCaps;
    let placed = false;
    recomputePlayerPopCaps = function (...args) {
        if (!placed && gameTime === 0 && units.length > 0) {
            placed = true;
            const floor = (gx, gy) => grid[gy] && grid[gy][gx] && grid[gy][gx].type !== TYPE_WALL && !grid[gy][gx].item && !getTileEntityRef(gx, gy);
            const borders = [];
            for (let gy = 3; gy < GRID_H - 3; gy += 2) for (let gx = 3; gx < GRID_W - 4; gx++) {
                const a = getAreaIdAtTile(gx, gy), b = getAreaIdAtTile(gx + 1, gy);
                if (a < 0 || b < 0 || a === b || getAreaDistance(a, b) !== 1) continue;
                if (!floor(gx - 1, gy) || !floor(gx, gy) || !floor(gx + 1, gy) || !floor(gx + 2, gy)) continue;
                if (getAreaIdAtTile(gx - 1, gy) !== a || getAreaIdAtTile(gx + 2, gy) !== b) continue;
                if (borders.some(p => Math.abs(p.gy - gy) < 6 && Math.abs(p.gx - gx) < 6)) continue;
                borders.push({ gx, gy });
            }
            const pick = (owner, type, used) => units.find(u => u.owner === owner && u.unitType === type && !used.has(u));
            const used = new Set();
            ${JSON.stringify(pairs)}.forEach((pair, i) => {
                const b = borders[i];
                const left = pick(pair[0][0], pair[0][1], used), right = pick(pair[1][0], pair[1][1], used);
                if (!b || !left || !right) return;
                used.add(left); used.add(right);
                for (const [u, x] of [[left, b.gx - 1 + .5], [right, b.gx + 1 + .4]]) {
                    u.x = u.prevX = x * TILE; u.y = u.prevY = (b.gy + .5) * TILE;
                    u.path = null; u.commandState = CMD_IDLE;
                    updateUnitSpatial(u);
                }
            });
        }
        return original.apply(this, args);
    };
})();`;
}

(async () => {
    const world = new H.World({ network: { latencyMs: 40, jitterMs: 8 }, controls: CONTROLS, hashEvery: 1, recordParts: true });
    // Left sees right: a king (vision 1 area) facing a soldier (vision .6)
    // beyond the border, for each owner; a laser caster facing a soldier.
    const pairs = [[[0, 'king'], [1, 'norm']], [[1, 'king'], [0, 'norm']], [[0, 'laser_resistant'], [1, 'norm']]];
    const { host, guests } = await H.startHostedMatch(world, { guests: 1, controls: CONTROLS, hostSetup: placementSetup(pairs) });
    const all = [host, ...guests];
    const energy = () => JSON.parse(host.eval(`JSON.stringify(units.filter(u => !u.dead).map(u => [u.owner, u.unitType, Math.round(u.energy)]))`));
    const start = energy();
    const kingsHit = () => {
        const now = host.eval(`JSON.stringify(units.map(u => [u.owner, u.unitType, u.dead ? -1 : Math.round(u.energy)]))`);
        const rows = JSON.parse(now);
        // Each side lost a soldier or had one damaged next to the enemy king.
        const hurt = owner => rows.filter(r => r[0] === owner && r[1] === 'norm' && r[2] < 40).length;
        return hurt(0) > 0 && hurt(1) > 0;
    };
    const ok = await world.runUntil(kingsHit, 30000, 100);
    assert.ok(ok, 'kings strike the soldiers they see across an area border: ' + JSON.stringify({ start, now: energy() }));
    // Keep playing (retaliation, the rest of the fight) under hash checks.
    await world.run(6000);

    for (const inst of all) assert.deepEqual(inst.errors.map(e => String(e && e.stack || e).slice(0, 300)), [], inst.name + ' threw');
    const cmp = world.compareHashes(all, 0);
    assert.equal(cmp.mismatches.length, 0, 'peers diverged at tick ' + (cmp.mismatches[0] && cmp.mismatches[0].tick));
    assert.ok(cmp.compared > 100, 'compared ' + cmp.compared);
    for (const inst of all) assert.equal(inst.eval('netCounters.desyncsDetected'), 0, inst.name + ' detected a desync');
    console.log(`PASS: kings fight visible soldiers across area borders in lockstep (${cmp.compared} tick hashes compared, ${JSON.stringify(energy())}).`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
