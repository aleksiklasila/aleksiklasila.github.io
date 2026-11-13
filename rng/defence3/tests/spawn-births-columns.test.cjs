'use strict';
// The spawners' births (barrack.js _spawnBirths, wasm/src/spr.rs k_spawn_births:
// no unit object, no per-unit JavaScript) leave every column of a new unit as
// the Unit constructor does (with configureWorkerUnitFromType, energy =
// maxEnergy as a spawner's), its worker record too: every barrack unit type and
// every worker spawner, a unit each, compared column by column with one made by
// the constructor, except what holds its place, id, handle and record index.
// Also: the births' units are in the id table and index, alive, counted.
//   node tests/spawn-births-columns.test.cjs
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const CONTROLS = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '64' };
(async () => {
    const world = new H.World({ controls: CONTROLS });
    const host = world.spawn('host', { controls: CONTROLS, simWorker: false });
    host.eval('startSoloGame();');
    await world.run(1500);
    const out = JSON.parse(host.eval(`(() => {
        const POS = new Set(['id', 'x', 'y', 'prevX', 'prevY', 'x0', 'y0', 'spTile', 'spArea', 'spEpoch', 'spKey', 'sepKey', 'spChunk', 'occX', 'occY', 'upB', 'cbTick', 'cbS', 'wkIx', 'hnd', 'hslot',
            'sepD0', 'sepR0', 'sepL0', 'mvNav', 'mvSteer']);
        const S = _simUnitState, C = S.columns, cap = S.cap, WK = new Set(SIM_UNIT_WK_SIDE.map(([k]) => k));
        const snap = s => {
            const o = {};
            for (const k of Object.keys(C)) {
                const c = C[k];
                if (!c || POS.has(k) || WK.has(k)) continue;
                if (ArrayBuffer.isView(c)) { if (c.length < cap) continue; const per = Math.max(1, Math.round(c.length / cap)); const v = []; for (let j = 0; j < per; j++) v.push(c[s * per + j]); o[k] = v.map(x => Object.is(x, -0) ? '-0' : x).join(','); }
                else if (typeof c.get === 'function') { const v = c.get(s); o[k] = v === undefined ? 'u' : v === null ? 'n' : typeof v === 'object' ? 'obj' : String(v); }
            }
            const w = C.wkIx[s];
            if (w > 0) for (const [k] of SIM_UNIT_WK_SIDE) { const a = C[k]; if (a) o['wk.' + k] = String(Object.is(a[w], -0) ? '-0' : a[w]); }
            return o;
        };
        const open = (gx, gy) => { const c = grid[gy] && grid[gy][gx]; return c && cellType[(c) - 1] === 0 && !cellItemGet(c) && !getTileEntityRef(gx, gy); };
        const keys = [];
        for (const t of Object.keys(BASE_UNIT_STATS)) if (BASE_CARD_TYPES['barrack_' + t]) keys.push('barrack_' + t);
        for (const k of ['spawner', 'astar_spawner', 'salvager', 'builder_spawner', 'healer_spawner', 'research']) if (BASE_CARD_TYPES[k]) keys.push(k);
        const diffs = [], made = [];
        let gx = 4, gy = 4;
        for (const key of keys) {
            // A built spawner of the key, its front paid, alone in a clear spot.
            let b = null;
            for (; gy < GRID_H - 6 && !b; gx += 6) {
                if (gx >= GRID_W - 6) { gx = 4; gy += 6; continue; }
                let ok = true;
                for (let dy = -1; dy <= 2 && ok; dy++) for (let dx = -1; dx <= 2 && ok; dx++) ok = open(gx + dx, gy + dy);
                if (!ok || !placeBuilding(gx, gy, key, 0, { ignorePlacementRules: true, silent: true })) continue;
                b = getTileEntityRef(gx, gy);
            }
            if (!b) continue;
            if (b.underConstruction) markConstructionComplete(b);
            b.energy = b.maxEnergy;
            spawnQueuePush(b, 1);
            b._qPaid = b._qReq;
            players[0].popCount = 0;
            const n0 = nextUnitId, uc0 = unitCount();
            processGlobalSpawnerQueue();
            if (nextUnitId !== n0 + 1) { diffs.push(key + ': ' + (nextUnitId - n0) + ' births'); continue; }
            const u = getUnitById(n0);
            if (!u || u.dead) { diffs.push(key + ': its unit not found by id'); continue; }
            if (unitCount() !== uc0 + 1) diffs.push(key + ': unit count ' + uc0 + ' -> ' + unitCount());
            const level = u.unitLevel;
            const a = new Unit(u.unitType, 0, (gx + 30) % (GRID_W - 4) * TILE + 16, 50 * TILE + 16, level, configureWorkerUnitFromType);
            a.energy = a.maxEnergy;
            const A = snap(a._si), B = snap(u._si);
            if (!u.workerType && (C.wkIx[a._si] !== 0 || C.wkIx[u._si] !== 0)) diffs.push(key + ': wkIx ' + C.wkIx[a._si] + ' / ' + C.wkIx[u._si] + ' isWk ' + C.isWk[a._si] + ' / ' + C.isWk[u._si]);
            for (const k of Object.keys(A)) if (A[k] !== B[k]) diffs.push(key + ' (' + u.unitType + ' L' + level + ') ' + k + ': ' + A[k] + ' (constructor) vs ' + B[k] + ' (birth)');
            if (Object.keys(B).length !== Object.keys(A).length) diffs.push(key + ': columns ' + Object.keys(A).length + ' vs ' + Object.keys(B).length);
            made.push(key);
            removeUnitNow(a);
        }
        return JSON.stringify({ keys: keys.length, made, diffs: diffs.slice(0, 60), nDiffs: diffs.length });
    })()`));
    console.log('spawner keys', out.keys, 'births compared', out.made.length, 'differences', out.nDiffs);
    for (const d of out.diffs) console.log('  ' + d);
    assert.ok(out.made.length >= 6, 'births compared');
    assert.equal(out.nDiffs, 0, 'columns differ');
    console.log('ok: births = the constructor, column by column');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
