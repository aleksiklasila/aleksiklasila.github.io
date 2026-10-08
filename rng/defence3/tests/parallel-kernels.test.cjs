// The parallel simulation kernels (src/sim/sim_parallel.js) compute exactly
// what the serial code computes: every player's visibility grid equals
// computeVisibilityGridForPlayer's, and the gathered separation pushes equal
// the pairwise ones, on real matches (islands, walls, battles, flyers).
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

// Each player's grid by the kernel vs the reference, same sources.
const VIS_CHECK = `(() => {
    const lists = _buildVisibilitySourceLists();
    _visibilitySourceLists = lists;
    let diffs = 0, cells = 0, lit = 0, checked = 0;
    try {
        for (let pid = 0; pid < players.length; pid++) {
            const src = lists.lists[pid] || new Float64Array(0), len = lists.lengths[pid] || 0;
            const ref = createEmptyVisibilityGrid();
            computeVisibilityGridForPlayer(pid, ref, src, len);
            const pool = { grids: [null, null] };
            const rows = _visibilityPoolGrid(pool, 0, 'check' + pid);
            simParallelBind('vis.g.' + pid + '.0', rows._flat);
            _runVisibilityJobs([pid, 0]);
            for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) { cells++; if (ref[y][x] > 0) lit++; if (!Object.is(ref[y][x], rows[y][x])) diffs++; }
            checked++;
        }
    } finally { _visibilitySourceLists = null; }
    return JSON.stringify({ diffs, cells, lit, checked });
})()`;

(async () => {
    const results = [];
    for (const [mapType, seed] of [['islands', 11], ['crossroads', 12], ['random', 13]]) {
        const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '40', 'cfg-map-type': mapType, 'cfg-max-pop': '5000', 'cfg-full-vis': 'team' };
        const world = new H.World({ controls });
        const inst = world.spawn('solo', { controls });
        const spawnCounts = { 'unit:norm': { 1: 40, 2: 40 }, 'unit:flying': { 1: 10 }, 'unit:scout': { 2: 10 }, 'building:pistol': { 1: 4, 2: 4 }, 'building:house': { 1: 2 } };
        inst.eval(`startingResourcesConfig = ${JSON.stringify({ spawnCounts, researchLevels: {} })}; startSoloGame();`);
        await world.run(1000);
        inst.eval(`(() => { const mine = units.filter(u => !u.dead && !u.workerType); queueAction({ action: 'attackMove', unitIds: mine.filter(u => u.owner === localPlayerId).map(u => u.id), targetX: GRID_W * TILE * .7, targetY: GRID_H * TILE * .5 }); })()`);
        for (let k = 0; k < 6; k++) {
            await world.run(1500);
            const r = JSON.parse(inst.evalSim(VIS_CHECK));
            assert.equal(r.diffs, 0, `${mapType}: visibility kernel differs on ${r.diffs} of ${r.cells} tiles`);
            assert.ok(r.lit > 0 && r.checked > 1);
            results.push(r.lit);
        }
        assert.deepEqual(inst.errors.map(e => String(e.stack || e).slice(0, 300)), [], mapType + ': no errors');
    }
    console.log(`PASS: parallel kernels match the serial code (visibility: ${results.length} checks, ${Math.max(...results)} lit tiles at most).`);
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
