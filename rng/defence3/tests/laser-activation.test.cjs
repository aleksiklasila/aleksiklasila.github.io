// Laser towers must link as soon as both finish construction.
//
// Links are gated by effectiveLevel (gap between towers <= min level), and a
// tower is level 0 while under construction. Links used to be computed only
// when a wall-type structure was placed or destroyed, so two lasers placed two
// tiles apart stayed unlinked after completing until some unrelated third
// structure was placed. This plays the real flow on two peers: place two
// lasers through queued actions, let builders finish them, and require the
// beam to exist (and to fire at an enemy in it) with no further placements,
// with both peers agreeing on the state hash until the test pokes a unit
// into the beam.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const CONTROLS = {
    ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '30', 'cfg-map-type': 'arena',
    'cfg-starting-energy': '2000000', 'cfg-starting-astar': '2000000', 'cfg-max-pop': '5000'
};

(async () => {
    const world = new H.World({ seed: 71 });
    const hostSetup = `(() => { const c = makeDefaultStartingResourcesConfig(); c.spawnCounts['unit:builder_unit'] = { 1: 8 }; c.spawnCounts['unit:norm'] = { 1: 2 }; startingResourcesConfig = c; })()`;
    const { host, guests } = await H.startHostedMatch(world, { guests: 1, controls: CONTROLS, hostSetup });
    const guest = guests[0];

    // Three free floor tiles in a row near the host's starting units, inside
    // one area, so the only thing gating the link is construction/level.
    const spot = host.eval(`(() => {
        const free = (gx, gy) => grid[gy] && grid[gy][gx] && grid[gy][gx].type !== TYPE_WALL && !grid[gy][gx].item && !getTileEntityRef(gx, gy);
        const mine = units.filter(u => u.owner === localPlayerId);
        const cx = mine.reduce((s, u) => s + u.x, 0) / mine.length / TILE, cy = mine.reduce((s, u) => s + u.y, 0) / mine.length / TILE;
        let best = null;
        for (let gy = 1; gy < GRID_H - 1; gy++) for (let gx = 1; gx < GRID_W - 3; gx++) {
            if (!free(gx, gy) || !free(gx + 1, gy) || !free(gx + 2, gy)) continue;
            const a = getAreaIdAtTile(gx, gy);
            if (a < 0 || getAreaIdAtTile(gx + 2, gy) !== a) continue;
            const d = (gx + 1 - cx) ** 2 + (gy - cy) ** 2;
            if (!best || d < best.d) best = { gx, gy, d };
        }
        return best;
    })()`);
    assert.ok(spot, 'found a free 3-tile strip');

    host.eval(`queueAction({ action: 'place', gx: ${spot.gx}, gy: ${spot.gy}, itemType: 'laser', autoUpgradeEnabled: true, buildEnabled: true })`);
    await world.run(500);
    host.eval(`queueAction({ action: 'place', gx: ${spot.gx + 2}, gy: ${spot.gy}, itemType: 'laser', autoUpgradeEnabled: true, buildEnabled: true })`);
    await world.run(500);

    const lasers = inst => inst.eval(`towers.filter(t => t.type === 'laser').map(t => ({ gx: t.gx, gy: t.gy, uc: !!t.underConstruction, lvl: t.effectiveLevel, links: t.connectedLasers.length }))`);
    const placed = lasers(host);
    assert.equal(placed.length, 2, 'both lasers placed: ' + JSON.stringify(placed));
    assert.ok(placed.every(t => t.links === 0), 'no link while under construction');
    const structuresAtPlacement = host.eval('towers.length + barracks.length + collectorSpawners.length');

    // Builders finish the towers; nothing else gets placed meanwhile.
    const done = await world.runUntil(() => lasers(host).every(t => !t.uc), 120000);
    assert.ok(done, 'lasers finished construction: ' + JSON.stringify(lasers(host)));
    await world.run(200);
    assert.equal(host.eval('towers.length + barracks.length + collectorSpawners.length'), structuresAtPlacement, 'no other structure was placed');

    for (const inst of [host, guest]) {
        const ls = lasers(inst);
        assert.ok(ls.every(t => t.links === 1), `${inst.name}: lasers linked right after construction: ${JSON.stringify(ls)}`);
    }

    // An enemy unit parked in the beam takes damage and the beam turns on.
    const enemyBefore = host.eval(`(() => {
        const u = units.find(u => u.owner !== localPlayerId && !u.dead && !u.laserResistant && !u.turretImmune && !u.isFlying);
        return u ? { id: u.id, energy: u.energy } : null;
    })()`);
    assert.ok(enemyBefore, 'enemy unit available');
    const park = `(() => { const u = units.find(u => u.id === ${enemyBefore.id}); if (!u) return;
        u.x = u.prevX = ${(spot.gx + 1) * 32 + 16}; u.y = u.prevY = ${spot.gy * 32 + 16}; u.vx = u.vy = 0; u.path = null; u.holdPosition = true; })()`;
    // Direct mutation on both peers (not tick-aligned), so hashes are only
    // compared up to this point.
    H.checkHealthy(world, [host, guest], { label: 'laser link' });
    let fired = false;
    for (let i = 0; i < 20 && !fired; i++) {
        host.eval(park); guest.eval(park);
        await world.run(50);
        fired = host.eval(`towers.some(t => t.type === 'laser' && t.laserState === 1)`) ||
            host.eval(`(() => { const u = units.find(u => u.id === ${enemyBefore.id}); return !u || u.dead || u.energy < ${enemyBefore.energy}; })()`);
    }
    assert.ok(fired, 'beam hit the enemy in its path');

    console.log('PASS: lasers placed 2 tiles apart link on construction completion (no extra placement) and fire;', JSON.stringify(lasers(host)));
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
