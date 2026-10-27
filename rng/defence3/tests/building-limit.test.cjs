'use strict';
// The building limit: structures per player counted on the tile table as they
// are placed, destroyed and change owner (the same as a scan of every tile);
// a new structure past the limit (the menu's Max Buildings, no more than each
// team's share of the structure pool) is refused; stacking in place is not.
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const w = new H.World({ controls: H.SMALL_MATCH_CONTROLS }), i = w.spawn('building-limit', { simWorker: false });
const out = JSON.parse(i.eval(`(() => {
    startSoloGame();
    const scan = pid => { let n = 0; for (let gy = 0; gy < GRID_H; gy++) for (let gx = 0; gx < GRID_W; gx++) { const e = getTileEntityRef(gx, gy); if (e && !e._stMine && e.owner === pid && e._stT >= 0) n++; } return n; };
    const spots = [];
    for (let gy = 2; gy < GRID_H - 2 && spots.length < 20; gy++) for (let gx = 2; gx < GRID_W - 2 && spots.length < 20; gx++)
        if (!getTileEntityRef(gx, gy) && grid[gy][gx].type !== TYPE_WALL) spots.push([gx, gy]);
    const start = { count: playerStructureCount(0), scan: scan(0) };
    const placed = spots.slice(0, 10).map(([gx, gy]) => { placeBuilding(gx, gy, 'pistol', 0, { silent: true, ignorePlacementRules: true }); return getTileEntityRef(gx, gy); }).filter(Boolean);
    const afterPlace = { count: playerStructureCount(0), scan: scan(0) };
    destroyBuilding(placed[0]); destroyBuilding(placed[1]);
    const afterDestroy = { count: playerStructureCount(0), scan: scan(0) };
    placed[2].owner = 1;
    const afterOwner = { c0: playerStructureCount(0), s0: scan(0), c1: playerStructureCount(1), s1: scan(1) };
    const memory = structMemoryLimitPerPlayer();
    CONFIG_MAX_BUILDINGS = playerStructureCount(0);
    const atLimit = getPlayerStructureLimit();
    const [gx, gy] = spots[15];
    const refused = placeBuilding(gx, gy, 'pistol', 0, { silent: true }) === false && !getTileEntityRef(gx, gy);
    const forced = placeBuilding(gx, gy, 'pistol', 0, { silent: true, ignorePlacementRules: true }) !== false && !!getTileEntityRef(gx, gy);
    CONFIG_MAX_BUILDINGS = 1e9;
    const capped = getPlayerStructureLimit();
    return JSON.stringify({ start, placed: placed.length, afterPlace, afterDestroy, afterOwner, memory, atLimit, refused, forced, capped, cfg: CONFIG_MAX_BUILDINGS });
})()`));
assert.equal(out.start.count, out.start.scan, JSON.stringify(out));
assert.equal(out.placed, 10);
assert.deepEqual(out.afterPlace, { count: out.start.count + 10, scan: out.start.scan + 10 });
assert.deepEqual(out.afterDestroy, { count: out.start.count + 8, scan: out.start.scan + 8 });
assert.equal(out.afterOwner.c0, out.afterOwner.s0);
assert.equal(out.afterOwner.c1, out.afterOwner.s1);
assert.equal(out.afterOwner.c0, out.start.count + 7);
assert.ok(out.memory >= 1, 'a memory limit per player');
assert.equal(out.atLimit, out.afterOwner.c0);
assert.ok(out.refused, 'a new structure past the limit is refused: ' + JSON.stringify(out));
assert.ok(out.forced, 'scripted placement (ignorePlacementRules) still places');
assert.equal(out.capped, out.memory, 'no more than the structure memory per player');
assert.deepEqual(i.errors, []);
console.log('PASS: building limit (' + out.memory + ' per player from the structure pool); counts follow place, destroy and owner changes');
