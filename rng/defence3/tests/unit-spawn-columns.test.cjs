'use strict';
// simSpawnUnit (unit.js: a new unit's slot and its own columns written
// directly) leaves every column as the Unit constructor does: units of every
// type, at levels 1-6, workers configured as spawns are, each made both ways
// at two open tiles of the same match; every column of the two slots
// compared, except those that hold the position, the id and the spatial
// index's place and its worker record's index (they differ by construction).
// (The spawners' births: tests/spawn-births-columns.test.cjs.)
//   node tests/unit-spawn-columns.test.cjs
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
(async () => {
    const world = new H.World({ controls: H.SMALL_MATCH_CONTROLS });
    const host = world.spawn('host', { controls: H.SMALL_MATCH_CONTROLS, simWorker: false });
    host.eval('startSoloGame();');
    await world.run(1500);
    const out = JSON.parse(host.eval(`(() => {
        const POS = new Set(['id', 'x', 'y', 'prevX', 'prevY', 'x0', 'y0', 'spTile', 'spArea', 'spEpoch', 'spKey', 'sepKey', 'spChunk', 'occX', 'occY', 'upB', 'cbTick', 'cbS', 'wkIx', 'hnd', 'hslot']);
        const snap = (C, s) => {
            const o = {};
            for (const k of Object.keys(C)) {
                const c = C[k];
                if (!c || POS.has(k)) continue;
                if (ArrayBuffer.isView(c)) { const per = Math.max(1, Math.round(c.length / _simUnitState.cap)); const v = []; for (let j = 0; j < per; j++) v.push(c[s * per + j]); o[k] = v.map(x => Object.is(x, -0) ? '-0' : x).join(','); }
                else if (typeof c.get === 'function') { const v = c.get(s); o[k] = v === undefined ? 'u' : v === null ? 'n' : typeof v === 'object' ? 'obj:' + (v.maxEnergy !== undefined ? v.maxEnergy : '') : String(v); }
            }
            return o;
        };
        // Two open tiles apart from everything (the same terrain, no neighbours).
        const open = [];
        for (let gy = 2; gy < GRID_H - 2 && open.length < 3000; gy += 3) for (let gx = 2; gx < GRID_W - 2 && open.length < 3000; gx += 3) {
            const c = grid[gy] && grid[gy][gx];
            if (c && !cellItemGet(c) && cellType[(c) - 1] === 0 && !getTileEntityRef(gx, gy)) open.push([gx, gy]);
        }
        const diffs = [], made = { n: 0 };
        // (The same tiles for every type and level: the last one's units
        // removed first, their occupancy let go.)
        let k = 0, prev = [];
        for (const type of Object.keys(BASE_UNIT_STATS)) for (let level = 1; level <= 6; level += 5) {
            for (const u of prev) if (!u.dead) { occupancyRelease(u); removeUnitNow(u); }
            k = 0;
            const [ax, ay] = open[k++], [bx, by] = open[k++], [cx, cy] = open[k++];
            const a = new Unit(type, 1, ax * TILE + 16, ay * TILE + 16, level, configureWorkerUnitFromType);
            const b = simSpawnUnit(type, 1, bx * TILE + 16, by * TILE + 16, level, configureWorkerUnitFromType);
            // (The second of its key: its stats copied, _spawnStats.)
            const b2 = simSpawnUnit(type, 1, cx * TILE + 16, cy * TILE + 16, level, configureWorkerUnitFromType);
            prev = [a, b, b2];
            if (a.dead || b.dead || b2.dead) continue;
            made.n++;
            const A = snap(a._us, a._si), B = snap(b._us, b._si);
            const B2 = snap(b2._us, b2._si);
            for (const c of Object.keys(A)) { if (A[c] !== B[c]) diffs.push(type + ' L' + level + ' ' + c + ': ' + A[c] + ' vs ' + B[c]); if (A[c] !== B2[c]) diffs.push(type + ' L' + level + ' (copied) ' + c + ': ' + A[c] + ' vs ' + B2[c]); }
            if (Object.getOwnPropertyNames(a).join() !== Object.getOwnPropertyNames(b).join()) diffs.push(type + ': own fields ' + Object.getOwnPropertyNames(a) + ' vs ' + Object.getOwnPropertyNames(b));
        }
        return JSON.stringify({ open: open.length, grid: GRID_W + "x" + GRID_H, made: made.n, wasm: _simWasmX !== null, diffs: diffs.slice(0, 40), nDiffs: diffs.length });
    })()`));
    console.log('open tiles', out.open, out.grid, 'pairs', out.made, 'wasm', out.wasm, 'differences', out.nDiffs);
    for (const d of out.diffs) console.log('  ' + d);
    assert.ok(out.made >= 10, 'pairs made');
    assert.equal(out.nDiffs, 0, 'columns differ');
    console.log('ok: simSpawnUnit = the constructor, column by column');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
