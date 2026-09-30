// Shared group path searches are limited per player per tick; groups over the
// limit wait and are routed on the next ticks. A group that stays pending (its
// shared search keeps failing, e.g. a destination nothing can reach) must not
// take that limit forever: every waiting unit is routed, or searches on its
// own, soon after.
// Regression: in tests/1500.json, after other subgroups' multi-point rallies,
// a 5-point rally of all water-resistant units left most of them standing for
// good behind a stuck group that took the only search slot every tick.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

(async () => {
    const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '40', 'cfg-map-type': 'arena', 'cfg-max-pop': '5000' };
    const world = new H.World({ controls });
    const host = world.spawn('solo', { controls });
    host.eval(`startingResourcesConfig = ${JSON.stringify({ spawnCounts: { 'unit:norm': { 1: 200 } }, researchLevels: {} })}; startSoloGame();`);
    await world.run(1500);
    assert.equal(host.eval('gameStarted && !isMultiplayer'), true, 'solo match running');

    // The stuck group: the lowest-id units (first in the resolver's order),
    // whose shared search never answers and whose own searches never finish.
    // (In the simulation: with the worker, there.)
    host.evalSim(`(() => {
        const mine = units.filter(u => !u.dead && u.owner === localPlayerId && !u.workerType).sort((a, b) => a.id - b.id);
        __scratch.stuck = new Set(mine.slice(0, 6).map(u => u.id));
        __scratch.bad = { gx: 3, gy: 3 };
        // Group orders go through the shared routes (routeGroupMembers).
        const group = routeGroupMembers;
        routeGroupMembers = function (owner, ex, ey, canWalk, members) {
            if (ex === __scratch.bad.gx && ey === __scratch.bad.gy) return members.map(() => null);
            return group.apply(this, arguments);
        };
        const single = _findPathForUnitTagged;
        _findPathForUnitTagged = function (tag, u) { if (u && __scratch.stuck.has(u.id)) return null; return single.apply(this, arguments); };
        const own = _tryUpgradeAstarFallbackPath;
        _tryUpgradeAstarFallbackPath = function (u) { if (u && __scratch.stuck.has(u.id)) return; return own.apply(this, arguments); };
    })()`);
    host.eval(`queueAction({ action: 'move', unitIds: [...__scratch.stuck], targetX: 3 * TILE + 16, targetY: 3 * TILE + 16 })`);
    await world.run(500);
    assert.equal(host.evalSim('units.filter(u => __scratch.stuck.has(u.id) && u._pendingPathTarget).length'), 6, 'the stuck group stays pending');

    // The rest over 5 points, as shift right-click does (one order per point).
    host.eval(`(() => {
        const sel = units.filter(u => !u.dead && u.owner === localPlayerId && !u.workerType && !__scratch.stuck.has(u.id));
        __scratch.selIds = sel.map(u => u.id);
        const pts = [[.3, .3], [.8, .3], [.5, .6], [.25, .85], [.75, .85]];
        pts.forEach(([fx, fy], i) => queueAction({ action: 'move', unitIds: sel.filter((u, k) => k % pts.length === i).map(u => u.id),
            targetX: fx * GRID_W * TILE, targetY: fy * GRID_H * TILE }));
    })()`);
    await world.run(2000);
    const r = JSON.parse(host.evalSim(`JSON.stringify((() => {
        const ids = new Set(__scratch.selIds), sel = units.filter(u => ids.has(u.id) && !u.dead);
        return { n: sel.length, waiting: sel.filter(u => u._awaitGroupPath > gameTime).length,
            stillPending: sel.filter(u => u._pendingPathTarget && !(u.path && u.path.length)).length };
    })())`));
    assert.equal(r.waiting, 0, 'nobody still waits for a shared search 2 s later');
    assert.equal(r.stillPending, 0, `the selection is routed: ${r.stillPending}/${r.n} still without a path`);
    assert.deepEqual(host.errors.map(e => String(e.stack || e).slice(0, 300)), [], 'no errors');
    console.log(`PASS: ${r.n}/${r.n} units of a 5-point order routed while a group whose searches keep failing stays pending ahead of them.`);
})().catch(err => { console.error(err); process.exitCode = 1; });
