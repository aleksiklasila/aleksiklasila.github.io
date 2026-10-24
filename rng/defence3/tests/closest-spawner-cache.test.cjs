// The nearest working spawner (worker.js _findClosestSpawner) through its
// per-tile cache of the nearest few (_spawnerNearOf) equals the plain scan
// (by tile distance, then row, column, id), over many queries from the same
// and other tiles while spawners stop and start working (energy, under
// construction) and new ones are placed (a new list, a new cache).
//   node tests/closest-spawner-cache.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '160', 'cfg-map-type': 'arena' } });
const inst = world.spawn('near', { simWorker: false });
inst.eval('startSoloGame();');
const r = JSON.parse(inst.eval(`JSON.stringify((() => {
    gameTick();
    let seed = 99;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const type = 'healer_spawner';
    const free = (gx, gy) => { const c = grid[gy][gx]; return c.type === TYPE_FLOOR && !c.item && !getTileEntityRef(gx, gy); };
    const place = owner => {
        for (let tries = 0; tries < 50; tries++) {
            const gx = 3 + Math.floor(rnd() * (GRID_W - 6)), gy = 3 + Math.floor(rnd() * (GRID_H - 6));
            if (!free(gx, gy)) continue;
            if (!placeBuilding(gx, gy, type, owner, { ignorePlacementRules: true, silent: true })) continue;
            const e = getTileEntityRef(gx, gy) || grid[gy][gx].item;
            if (e) { e.underConstruction = false; if (typeof structureWallSync === 'function') structureWallSync(e); e.energy = e.maxEnergy; return e; }
        }
        return null;
    };
    for (let i = 0; i < 120; i++) place(i % 3 === 0 ? 1 : 0);
    // (The plain scan: the order the cache keeps.)
    const ref = (u) => {
        const ux = Math.floor(u.x / TILE), uy = Math.floor(u.y / TILE);
        let best = null, bd = Infinity;
        for (const s of _getWorkerSpawnersByType(type)) {
            if (!s || s.type !== type || s.owner !== u.owner || !(s.energy > 0) || s.underConstruction) continue;
            const d = Math.abs(s.gx - ux) + Math.abs(s.gy - uy);
            if (d < bd || (d === bd && (s.gy < best.gy || (s.gy === best.gy && (s.gx < best.gx || (s.gx === best.gx && s.id < best.id)))))) { best = s; bd = d; }
        }
        return best;
    };
    const tiles = [];
    for (let i = 0; i < 40; i++) tiles.push([2 + Math.floor(rnd() * (GRID_W - 4)), 2 + Math.floor(rnd() * (GRID_H - 4))]);
    let checks = 0, bad = '', hits = 0, nulls = 0;
    for (let q = 0; q < 6000 && !bad; q++) {
        // Spawners stop and start working; now and then a new one.
        if (q % 7 === 0) {
            const all = _getWorkerSpawnersByType(type), s = all[Math.floor(rnd() * all.length)];
            if (s) { const k = rnd(); if (k < 0.4) s.energy = s.energy > 0 ? 0 : s.maxEnergy; else if (k < 0.8) s.underConstruction = !s.underConstruction; }
        }
        if (q % 997 === 0) place(q & 1);
        const [tx, ty] = tiles[Math.floor(rnd() * tiles.length)];
        const u = { x: tx * TILE + 5 + Math.floor(rnd() * 20), y: ty * TILE + 5 + Math.floor(rnd() * 20), owner: rnd() < 0.7 ? 0 : 1 };
        const got = _findClosestSpawner(u, type), want = ref(u);
        checks++;
        if (!want) nulls++;
        if (got !== want) bad = 'query ' + q + ' at ' + tx + ',' + ty + ' owner ' + u.owner + ': ' + (got && got.gx + ',' + got.gy) + ' vs ' + (want && want.gx + ',' + want.gy);
    }
    const T = _spawnerScanTable(_ownedSpawnersOfType(type, 0));
    return { checks, bad, nulls, cachedTiles: T.near ? T.near.size : 0, spawners: _getWorkerSpawnersByType(type).length };
})())`));
console.log(JSON.stringify(r));
assert.equal(r.bad, '', r.bad);
assert.ok(r.checks >= 6000 && r.cachedTiles > 0 && r.spawners > 100, 'exercised');
assert.deepEqual(inst.errors, []);
console.log('PASS: the cached nearest spawner equals the plain scan over ' + r.checks + ' queries (' + r.cachedTiles + ' tiles cached, ' + r.spawners + ' spawners)');
process.exit(0);
