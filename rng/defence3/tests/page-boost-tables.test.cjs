// The page's stat tables after boost changes (sim_frame_world.js _pageBoostRebuild: the changed things' tables, as the
// simulation remakes them, not the player's whole table) equal the simulation worker's: unit and building boosts of
// both resources, a boost cleared, and a stockpile's debt switching a resource's boosts off and on again.
process.env.SIM_WORKER = '1';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

(async () => {
    const world = new H.World({ seed: 11 });
    const { host } = await H.startHostedMatch(world, { guests: 1, controls: H.SMALL_MATCH_CONTROLS });
    assert.ok(host.simWorker && host.eval('simClientActive()'), 'the match runs in the simulation worker');
    const tables = `JSON.stringify((() => { const e = PRECOMPUTED_STATS_MAP_PLAYER[0], out = {};
        for (const br of ['unit', 'building']) for (const k of Object.keys(e[br]).sort()) out[br + ':' + k] = (e[br][k] || []).map(r => r ? Object.keys(r).sort().filter(s => typeof r[s] === 'number').map(s => s + '=' + r[s]).join(',') : null);
        return out; })())`;
    host.eval('__scratch.whole = 0; { const f = rebuildPrecomputedStatsMapPlayer; rebuildPrecomputedStatsMapPlayer = function () { __scratch.whole++; return f.apply(this, arguments); }; }');
    const same = async (what) => {
        await world.run(1500);
        const page = JSON.parse(host.eval(tables)), sim = JSON.parse(host.simWorker.eval(tables));
        const keys = Object.keys(sim);
        assert.deepEqual(Object.keys(page), keys, what + ': the same things');
        for (const k of keys) assert.deepEqual(page[k], sim[k], what + ': ' + k);
        return keys.length;
    };
    const bkey = host.simWorker.eval(`Object.keys(PRECOMPUTED_STATS_MAP.building).find(k => _buildingStatHasValues(k, 'attackDamage')) || Object.keys(PRECOMPUTED_STATS_MAP.building)[0]`);
    const act = a => host.eval(`queueAction(${JSON.stringify(a)})`);
    await same('start');
    act({ action: 'setBoost', kind: 'unit', key: 'norm', res: 'energy', steps: 2 }); await same('unit energy boost');
    act({ action: 'setBoost', kind: 'unit', key: 'norm', res: 'astar', steps: 3 }); await same('unit star boost');
    act({ action: 'setBoost', kind: 'building', key: bkey, res: 'energy', steps: 1 }); await same('building boost');
    act({ action: 'setBoost', kind: 'unit', key: 'norm', res: 'energy', steps: 0 }); await same('unit energy boost cleared');
    // (Debt: the energy boosts off at the next check, then on again.)
    host.simWorker.eval("_setPlayerResourceValue(0, 'energy', -1e7);");
    await same('energy in debt');
    const off = JSON.parse(host.simWorker.eval('JSON.stringify([players[0].energy, players[0].boostOn])'));
    assert.ok(off[0] < 0 && off[1] && off[1].energy === false, 'energy boosts off in debt: ' + JSON.stringify(off));
    host.simWorker.eval("_setPlayerResourceValue(0, 'energy', 1e9);");
    const n = await same('energy back');
    const whole = host.eval('__scratch.whole');
    assert.equal(whole, 0, 'boost changes remake the changed things only on the page');
    console.log(`PASS: page stat tables equal the worker's through boost changes (${n} things, ${whole} whole rebuilds on the page)`);
    process.exit(0);
})().catch(e => { console.error('FAIL', e && e.stack || e); process.exit(1); });
