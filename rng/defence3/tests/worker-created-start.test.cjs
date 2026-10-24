// A match the simulation worker makes (sim_client.js simClientCreateMatch,
// ADAPTIVE_SIMULATION_AT_HIGH_SIMULATION_COST.md A2): the page makes the map
// only, the worker makes the whole world (starting units and buildings) and
// sends the page its copy without units; no world snapshot crosses to the
// worker. Checked: the worker's world at tick 0 is the one a page-only start
// of the same seed makes (state hash); the page has the buildings, floor
// items and players, its units only from frames; the match runs.
//   node tests/worker-created-start.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const CONTROLS = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '60', 'cfg-max-pop': '4000', 'cfg-full-vis': 'full' };
// Units of several kinds (workers too), buildings, towers, floor items.
const SETUP = `
    ensureMainMenuPrecomputedStateReady();
    startingResourcesConfig = { researchLevels: {}, spawnCounts: {
        'unit:king': { 1: 1 }, 'unit:norm': { 1: 300, 3: 40 }, 'unit:collector': { 1: 60 }, 'unit:builder_unit': { 1: 30 },
        'unit:tank': { 2: 50 }, 'unit:flying': { 1: 25 },
        'building:house': { 1: 20 }, 'building:barrack_norm': { 2: 6 }, 'building:pistol': { 1: 12 }, 'building:sniper': { 4: 4 },
        'building:lava': { 1: 15 }, 'building:research': { 1: 2 }, 'building:cloud_0a': { 1: 1 }, 'building:cloud_0b': { 1: 1 }
    } };
`;
const SUMMARY = `JSON.stringify({ tick: currentTick, units: units.length, items: getCellItemsRowMajor().length,
    floor: getCellItemsRowMajor().filter(b => BASE_CARD_TYPES[b.type] && BASE_CARD_TYPES[b.type].target === 'floor').length,
    pop: activeTeamIds.map(p => players[p].popCount), energy: activeTeamIds.map(p => players[p].energy) })`;

(async () => {
    // The same virtual start time in both worlds: the same seed.
    const page = new H.World({ controls: CONTROLS });
    const legacy=process.argv.includes('--legacy');
    const options=legacy?{url:'http://localhost/rng/defence3/?acq=exact&occupancy=0'}:undefined;
    // (The reference: the simulation on the page itself, whatever SIM_WORKER says.)
    const solo = page.spawn('page', { ...(options || {}), simWorker: false });
    await page.run(200);
    solo.eval(SETUP);
    solo.eval('startSoloGame();');
    const ref = { hash: solo.eval('computeLockstepStateHashFast(currentTick)'), seed: solo.eval('gameSeed'), ...JSON.parse(solo.eval(SUMMARY)) };
    assert.equal(ref.tick, 0);
    assert.ok(ref.units > 900 && ref.items > 60, 'the page-only start made the world: ' + JSON.stringify(ref));

    const wk = new H.World({ controls: CONTROLS });
    wk.simWorker = true;
    const inst = wk.spawn('worker',options);
    await wk.run(200);
    inst.eval(SETUP);
    // (The worker's 'started' hash: its world before its first tick.)
    inst.eval(`__scratch.started = null; { const on = _simClientOnMessage; _simClientOnMessage = function (msg) {
        if (msg && msg.type === 'started' && __scratch.started === null) __scratch.started = { hash: msg.hash, timings: msg.timings };
        if (msg && msg.type === 'startState') __scratch.pageTextBytes = msg.pageText.length;
        return on.apply(this, arguments); }; }`);
    inst.eval('startSoloGame();');
    // Right after the start: the page made no units and no buildings.
    const before = JSON.parse(inst.eval(SUMMARY));
    assert.equal(before.units, 0, 'the page made no starting units');
    assert.equal(before.items, 0, 'the page made no starting buildings');
    assert.equal(inst.eval('gameSeed'), ref.seed, 'same seed');
    await wk.runUntil(() => inst.eval('simClientWorldReady() && currentTick > 40'), 20000);
    const started = inst.scratch.started;
    assert.ok(started, 'the worker started the match');
    assert.equal(started.hash, ref.hash, 'the worker made the world a page-only start makes (state hash at tick 0)');
    assert.equal(started.timings.parse, undefined, 'no start snapshot parsed in the worker');
    const after = JSON.parse(inst.eval(SUMMARY));
    assert.ok(inst.eval('simClientActive()'), 'the worker runs the match');
    for(const setting of ['SIM_ACQ_AREA_TARGETS','SIM_OCCUPANCY_ENABLED']){
        assert.equal(inst.eval(setting),!legacy,'page setting '+setting);
        assert.equal(inst.simWorker.eval(setting),!legacy,'setting reaches the simulation worker '+setting);
    }
    if(!legacy)assert.equal(inst.simWorker.eval('occupancyAudit().ok'),true,'default worker occupancy is consistent');
    assert.equal(after.items, ref.items, 'the page has every building and floor item');
    assert.equal(after.floor, ref.floor);
    assert.equal(after.units, inst.simWorker.eval('units.length'), 'the page shows the worker\'s units (frames)');
    assert.ok(after.units > 900, 'units on the page from frames: ' + after.units);
    assert.deepEqual(after.pop, ref.pop, 'population counts');
    assert.ok(inst.scratch.pageTextBytes > 0, 'the page got its copy without units');
    // The next match on the same worker, the last one over there: it starts
    // anew (a worker kept the old end: the next match stood at tick 0).
    inst.simWorker.eval('gameOver = true; winner = 1;');
    inst.eval('gameOver = false; winner = -1;');
    inst.eval('startSoloGame();');
    assert.ok(await wk.runUntil(() => inst.eval('simClientWorldReady() && currentTick > 30'), 20000), 'the next match runs: ' + inst.eval('currentTick'));
    assert.equal(inst.simWorker.eval('gameOver'), false, 'the worker\'s next match is not over');
    assert.equal(inst.eval('gameOver'), false);
    const errors = inst.errors.map(e => String(e && e.message || e)).filter(m => !/test: /.test(m));
    assert.deepEqual(errors, []);
    console.log(`PASS worker-created-start: ${ref.units} units, ${ref.items} buildings/items; worker hash ${started.hash} = page-only start; page copy ${(inst.scratch.pageTextBytes / 1024).toFixed(0)} KB; tick ${after.tick}`);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
