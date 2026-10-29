// Adjacency on its lane (things_utils.js adjacencyLaneStep) applies all of a
// batch's group members at its commit (the apply kernel, k_adj_apply). Blocks
// of thousands of alike buildings, some removed while a batch is in flight:
// once the lane is idle, every building's group
// size, area multiplier and effective level equal a synchronous full
// recompute (tests/adjacency-reference.js). And a full refresh (the
// signatures only at structures' tiles) equals the pass over every tile,
// and the kernel's cells by area (from the area grid) the areas' lists.
//   node tests/adjacency-lane-carry.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '200', 'cfg-map-type': 'arena' } });
const inst = world.spawn('adjcarry', { simWorker: false });
inst.eval('startSoloGame();');
// (The oracle: the JavaScript recompute as it was before the kernels; in the
// same eval as the test body: each eval has its own scope.)
const REF = require('node:fs').readFileSync(require('node:path').join(__dirname, 'adjacency-reference.js'), 'utf8');
const r = JSON.parse(inst.eval(REF + `;JSON.stringify((() => {
    const placed = [];
    const put = (gx, gy, key, p) => {
        const c = grid[gy] && grid[gy][gx];
        if (!c || c.type !== TYPE_FLOOR || c.item || getTileEntityRef(gx, gy) || getGoldMineAt(gx, gy)) return;
        if (!placeBuilding(gx, gy, key, p, { ignorePlacementRules: true, silent: true })) return;
        const e = getTileEntityRef(gx, gy) || c.item;
        if (!e) return;
        // (Built at level 1, as main.js completeStarterBuilding: under
        // construction, its effective level is 0 and it is in no group.)
        e.underConstruction = false; if (typeof structureWallSync === 'function') structureWallSync(e); e.buildProgress = 1; e.isUpgrading = false;
        e.stacks = e.effectiveStacks = getRequiredStacksForLevel(1); e.level = e.effectiveLevel = e.potentialEffectiveLevel = 1;
        if (e instanceof Tower) e.updateStats();
        e.energy = e.maxEnergy;
        placed.push(e);
    };
    // Three blocks of one barrack type, one of towers; both players.
    for (let gy = 20; gy < 80; gy++) for (let gx = 20; gx < 80; gx++) put(gx, gy, 'barrack_norm', 0);
    for (let gy = 20; gy < 70; gy++) for (let gx = 110; gx < 170; gx++) put(gx, gy, 'barrack_fast', 0);
    for (let gy = 120; gy < 170; gy++) for (let gx = 20; gx < 70; gx++) put(gx, gy, 'pistol', 1);
    for (let gy = 120; gy < 170; gy++) for (let gx = 110; gx < 160; gx++) put(gx, gy, 'barrack_tank', 1);
    recalculateAdjacency(true);
    // A batch in flight, then a cut through two blocks (their groups change).
    let t = 0;
    for (; t < 12; t++) gameTick();
    for (let gx = 20; gx < 80; gx++) { const e = getTileEntityRef(gx, 50); if (e) destroyBuilding(e); }
    for (let gy = 120; gy < 170; gy++) { const e = getTileEntityRef(130, gy); if (e) destroyBuilding(e); }
    for (; t < 400 && (_adjacencyNeedsRecalc || _adjL.posted); t++) gameTick();
    const live = placed.filter(e => getTileEntityRef(e.gx, e.gy) === e);
    const state = () => live.map(e => [e.effectiveGroupSize, e.effectiveAreaMult, e.effectiveLevel, e.effectiveStacks].join(','));
    const lane = state();
    // The reference recompute of everything (tests/adjacency-reference.js).
    _adjacencyLastRecalcTick = -1; _adjacencyDirtyAll = true; _adjacencyNeedsRecalc = true;
    _refAdjRecalc();
    const sync = state();
    // (Group size and effective level exactly; the area multiplier and the
    // stacks from it to 1e-12: the lane's flood (Rust) multiplies in another
    // order than the synchronous pass, the last digits differ. Each is the
    // same on every peer.)
    const near = (a, b) => a === b || Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b));
    let diff = 0, first = '';
    for (let i = 0; i < live.length; i++) {
        const a = lane[i].split(',').map(Number), b = sync[i].split(',').map(Number);
        if (a[0] === b[0] && a[2] === b[2] && near(a[1], b[1]) && near(a[3], b[3])) continue;
        diff++; if (!first) first = live[i].type + '@' + live[i].gx + ',' + live[i].gy + ': lane ' + lane[i] + ' sync ' + sync[i];
    }
    // The post kernel's signature grid against the reference's signatures:
    // the same tiles, one kernel id per reference signature and back.
    _adjacencyDirtyAll = true; _adjacencyNeedsRecalc = true;
    while (gameTime % ADJACENCY_BATCH_TICKS !== 2) gameTick();
    gameTick();
    const fast = _simParReg['adj.sig'];
    const byRef = new Map(), byId = new Map();
    let sigDiff = 0;
    for (let gy = 0; gy < GRID_H; gy++) for (let gx = 0; gx < GRID_W; gx++) {
        const s = _refAdjSig(gx, gy), id = fast[gy * GRID_W + gx];
        if (!s) { if (id >= 0) sigDiff++; continue; }
        if (id < 0) { sigDiff++; continue; }
        if (byRef.has(s.sigKey) ? byRef.get(s.sigKey) !== id : byId.has(id)) sigDiff++;
        byRef.set(s.sigKey, id); byId.set(id, s.sigKey);
    }
    // The kernel's cells by area (made from the area grid) hold each area's cells.
    const CO = _simParReg['adj.coff'], CT = _simParReg['adj.ctile'];
    let areaDiff = 0;
    for (let a = 0; a < areas.length; a++) {
        const want = (gridCellsByArea[a] || []).map(c => c.y * GRID_W + c.x).sort((x, y) => x - y).join();
        if (Array.from(CT.subarray(CO[a], CO[a + 1])).join() !== want) areaDiff++;
    }
    return { buildings: live.length, ticks: t, diff, first, sigDiff, areaDiff, areas: areas.length, groups: new Set(sync.map(s => s.split(',')[0])).size };
})())`));
console.log(JSON.stringify(r));
assert.ok(r.buildings > 8000, 'buildings placed: ' + r.buildings);
assert.equal(r.diff, 0, 'lane equals the synchronous recompute: ' + r.first);
assert.equal(r.sigDiff, 0, 'full refresh signatures equal the pass over every tile');
assert.ok(r.areas > 10, 'areas ' + r.areas);
assert.equal(r.areaDiff, 0, "the kernel's cells by area equal the areas' cell lists");
console.log('PASS: adjacency kernels equal the JavaScript reference recompute (' + r.buildings + ' buildings, ' + r.groups + ' group sizes)');
process.exit(0);
