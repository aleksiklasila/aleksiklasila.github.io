'use strict';
// Ten construction sites and ten idle builders on one spot (all wanting the
// same nearest site first): the worker kernel's parallel takes (wai.rs
// k_wai_apply; worker.js _waiParallel) give each builder of a take a
// different site in the same step: one that lost its first site to a lower
// id takes its next in another round. Checked against the serial pass
// (WAI_PARALLEL = false): its first take gives as many builders a site;
// rounds were needed; as many sites held at the last take.
//   node tests/worker-take-rounds.test.cjs
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
// (A 64-tile map: room for a row of 22 open tiles.)
const CONTROLS = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '64' };
async function run(parallel) {
    const world = new H.World({ controls: CONTROLS });
    const host = world.spawn('host', { controls: CONTROLS, simWorker: false });
    host.eval('startSoloGame();');
    await world.run(1500);
    const setup = JSON.parse(host.eval(`(() => {
        WAI_PARALLEL = ${parallel};
        const key = Object.keys(BASE_CARD_TYPES).find(k => k === 'tower') || Object.keys(BASE_CARD_TYPES).find(k => !BASE_CARD_TYPES[k].notBuildable && /tower/.test(k));
        // A row of open floor: sites on every other tile, builders on the row below.
        const open = (gx, gy) => { const c = grid[gy] && grid[gy][gx]; return c && c.type === 0 && !c.item && !getTileEntityRef(gx, gy); };
        let row = null;
        for (let gy = 3; gy < GRID_H - 4 && !row; gy++) for (let gx = 2; gx + 22 < GRID_W && !row; gx++) {
            let ok = true;
            for (let k = 0; k < 22 && ok; k++) ok = open(gx + k, gy) && open(gx + k, gy + 1) && open(gx + k, gy + 2);
            if (ok) row = [gx, gy];
        }
        if (!row) return JSON.stringify({ error: 'no open row' });
        const sites = [];
        for (let k = 0; k < 10; k++) { const gx = row[0] + k * 2, gy = row[1]; if (placeBuilding(gx, gy, key, 0, { ignorePlacementRules: true, silent: true })) sites.push(gy * GRID_W + gx); }
        const ids = [];
        for (let k = 0; k < 10; k++) {
            // (All on the same spot: they all want the same nearest site first.)
            const u = simSpawnUnit('builder_unit', 0, (row[0] + 9) * TILE + 16 + (k % 3) * 4, (row[1] + 2) * TILE + 16 + Math.floor(k / 3) * 4, 1, configureWorkerUnitFromType);
            if (u.dead) continue;
            unitAdded(u); players[0].popCount++; ids.push(u.id);
        }
        players[0].energy = 1e6;
        __scratch.ids = ids; __scratch.sites = new Set(sites); __scratch.log = [];
        const f = waiTake;
        waiTake = function () {
            f.apply(this, arguments);
            const held = new Set();
            for (const id of __scratch.ids) {
                const u = getUnitById(id), t = u && !u.dead ? u.workerTarget : null;
                if (t && __scratch.sites.has(t.gy * GRID_W + t.gx)) held.add(t.gy * GRID_W + t.gx);
            }
            __scratch.log.push([gameTime, held.size, typeof _wai !== 'undefined' ? _wai.rounds || 0 : 0]);
        };
        return JSON.stringify({ key, sites: sites.length, builders: ids.length });
    })()`));
    assert.ok(!setup.error, setup.error);
    await world.run(12000);
    const log = JSON.parse(host.eval('JSON.stringify(__scratch.log)'));
    const first = log.find(e => e[1] > 0);
    const end = log.length ? log[log.length - 1][1] : 0, rounds = Math.max(0, ...log.map(e => e[2]));
    return { setup, first, end, rounds, log: log.slice(0, 8) };
}
(async () => {
    const par = await run(true), ser = await run(false);
    console.log('parallel', JSON.stringify(par));
    console.log('serial  ', JSON.stringify(ser));
    assert.ok(par.setup.sites === 10 && par.setup.builders === 10, 'ten sites and builders');
    assert.ok(par.first, 'a take gave sites');
    assert.ok(par.first[1] >= ser.first[1], 'the first take gives at least as many builders a site as the serial pass');
    assert.ok(par.rounds > 1, 'contended sites took more than one round');
    assert.ok(par.end >= ser.end, 'as many sites held at the takes as the serial pass (sites finish meanwhile)');
    console.log('ok: contended takes matched in rounds within a step');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
