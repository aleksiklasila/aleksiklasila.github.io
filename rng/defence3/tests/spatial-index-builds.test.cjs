// The unit index's two builds (chunk.js: serial with object lists, parallel
// kernels with slots) answer every query the same, on chaotic worlds: range
// and area-range queries (all filters), units in range, closest enemy.
const assert = require('node:assert/strict');
const C = require('./multiplayer-chaos-determinism.test.cjs');
(async () => {
    const rows = [];
    for (const [map, seed] of [['crossroads', 3], ['islands', 4], ['solar_system', 5]]) {
        const { world, host, all } = await C.setupChaosWorld(map, seed);
        let s = seed;
        const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        for (let k = 0; k < 40; k++) { for (const i of all) if (rand() < 0.7) i.eval(C.CHAOS_COMMAND + '(' + rand() + ')'); await world.run(200); }
        const res = JSON.parse(host.evalSim(`(() => {
            let s = ${seed};
            const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
            const qs = [];
            for (let k = 0; k < 400; k++) qs.push({ x: rnd() * GRID_W * TILE, y: rnd() * GRID_H * TILE, r: 20 + rnd() * 300, ra: rnd() * 4, p: Math.floor(rnd() * players.length), kind: k % 6 });
            const run = () => qs.map(q => {
                const ids = [];
                const v = u => { ids.push(u.id); };
                if (q.kind === 0) forEachUnitInRange(q.x, q.y, q.r, v);
                else if (q.kind === 1) forEachUnitInRange(q.x, q.y, q.r, v, { enemyOfPlayer: q.p });
                else if (q.kind === 2) forEachUnitInRange(q.x, q.y, q.r, v, { player: q.p });
                else if (q.kind === 3) forEachUnitInAreaRange(q.x, q.y, q.ra, v, { enemyOfPlayer: q.p, areaOnly: true });
                else if (q.kind === 4) for (const u of getUnitsInRange(q.x, q.y, q.r)) ids.push(u.id);
                else { const e = _findClosestEnemyUnitByChunks(q.p, q.x, q.y, q.r); ids.push(e ? e.id : -1); }
                return ids.join(',');
            });
            const old = SPATIAL_PARALLEL_MIN_UNITS;
            SPATIAL_PARALLEL_MIN_UNITS = 1e9; spatialIndexRebuild(); const a = run();
            SPATIAL_PARALLEL_MIN_UNITS = 0; spatialIndexRebuild(); const b = run(), bySlot = _sxBySlot;
            SPATIAL_PARALLEL_MIN_UNITS = old; spatialIndexRebuild();
            let diff = -1, found = 0;
            for (let i = 0; i < a.length; i++) { if (a[i] !== b[i] && diff < 0) diff = i; if (a[i]) found += a[i].split(',').length; }
            return JSON.stringify({ diff, a: diff >= 0 ? a[diff] : '', b: diff >= 0 ? b[diff] : '', q: diff >= 0 ? qs[diff] : null, bySlot, found, units: units.length });
        })()`));
        assert.ok(res.bySlot, map + ': the parallel build ran');
        assert.equal(res.diff, -1, map + ': query ' + JSON.stringify(res.q) + ' serial ' + res.a + ' parallel ' + res.b);
        assert.ok(res.found > 200, map + ': queries found units (' + res.found + ')');
        rows.push(`${map}: 400 queries over ${res.units} units, identical (${res.found} results)`);
    }
    console.log('PASS: serial and parallel unit index builds\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
