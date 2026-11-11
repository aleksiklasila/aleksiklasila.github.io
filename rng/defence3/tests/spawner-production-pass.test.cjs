'use strict';
// The production pass (barrack.js spawnerProductionPass, wasm/src/spr.rs):
// 150 built barracks, each with two units queued and its front paid, spawn
// one unit each in one step and their queues move on (one left, unpaid); the
// next step spawns none. (A list of the spawners whose queues move on that
// lost entries past 64 a step once made every barrack spawn every step.)
//   node tests/spawner-production-pass.test.cjs
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const CONTROLS = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '64' };
(async () => {
    const world = new H.World({ controls: CONTROLS });
    const host = world.spawn('host', { controls: CONTROLS, simWorker: false });
    host.eval('startSoloGame();');
    await world.run(1500);
    const r = JSON.parse(host.eval(`(() => {
        const open = (gx, gy) => { const c = grid[gy] && grid[gy][gx]; return c && cellType[(c) - 1] === 0 && !cellItemGet(c) && !getTileEntityRef(gx, gy); };
        const made = [];
        for (let gy = 2; gy < GRID_H - 2 && made.length < 150; gy += 2) for (let gx = 2; gx < GRID_W - 2 && made.length < 150; gx += 2) {
            if (!open(gx, gy) || !open(gx + 1, gy) || !open(gx, gy + 1)) continue;
            if (!placeBuilding(gx, gy, 'barrack_norm', 0, { ignorePlacementRules: true, silent: true })) continue;
            const b = getTileEntityRef(gx, gy);
            if (!b || b.type !== 'barrack') continue;
            if (b.underConstruction) markConstructionComplete(b);
            b.energy = b.maxEnergy;
            spawnQueuePush(b, 2);
            b._qPaid = b._qReq;
            made.push(b);
        }
        players[0].popCount = 0;
        __scratch.made = made;
        const on = _spProdOn();
        const n0 = nextUnitId;
        processGlobalSpawnerQueue();
        const first = nextUnitId - n0, left = made.map(b => [b._qN, b._qPaid]);
        const n1 = nextUnitId;
        processGlobalSpawnerQueue();
        return JSON.stringify({ on, barracks: made.length, first, second: nextUnitId - n1, cap: getPlayerPopCap(0),
            queuesOne: left.filter(([n]) => n === 1).length, unpaid: left.filter(([, p]) => p === 0).length });
    })()`));
    console.log(JSON.stringify(r));
    assert.ok(r.on, 'the production pass runs (wasm)');
    assert.ok(r.barracks >= 100, 'barracks placed');
    const want = Math.min(r.barracks, r.cap);
    assert.equal(r.first, want, 'one spawn each in the first step');
    assert.equal(r.queuesOne, want, 'each queue moved on to one');
    assert.equal(r.unpaid, want, 'its new front unpaid');
    assert.equal(r.second, 0, 'none the next step');
    console.log('ok: production pass spawns once per paid front, queues move on');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
