'use strict';
// The movement kernel's structure tables by tch.rs k_move_structs (mv.struct
// codes, mv.scls classes, mv.stblk hostile counts per block) equal what the
// JavaScript made them from the structures' objects (kept here as the
// reference), whole and after a chaos scene's placements, constructions and
// destructions changed tiles.
// Usage: node tests/move-structs-kernel.test.cjs
const assert = require('node:assert/strict'), H = require('./net-harness.cjs'), chaos = require('./chaos-spikes-scenario.cjs');
globalThis.self = { crossOriginIsolated: true };
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '192', 'cfg-map-type': 'arena', 'cfg-gold-count': '200', 'cfg-astar-mine-count': '200', 'cfg-max-pop': '20000', 'cfg-starting-energy': '1000000000000', 'cfg-starting-astar': '1000000000000' };
const world = new H.World({ controls }), i = world.spawn('ms', { controls, simWorker: false });
i.eval(`MAX_THING_LEVEL=20;MAX_RESEARCH_LEVEL=10;startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{'unit:king':{1:1},'unit:norm':{12:600},'unit:builder_unit':{10:60}},researchLevels:{}});applyMainMenuControlsToRuntimeState();startSoloGame();simDk=20;netStepTicks=()=>20;`);
const setup = JSON.parse(i.eval('JSON.stringify(' + chaos.setup({ mode: 'mega', layout: 'mixed', buildings: 50, level: 6, towerSites: 30, collectorBuildings: 20, structures: 3000 }) + ')'));
assert.deepEqual(setup.errors, []);
i.eval(`__scratch.actions=[];queueAction=a=>__scratch.actions.push(a);
__scratch.check = () => { _simMoveStructs();
    // (The JavaScript's rules, from the objects.)
    const code = (gx, gy) => { const e = getTileEntityRef(gx, gy); if (!e || e._stMine) return -1; const cell = grid[gy] && grid[gy][gx]; const co = cell && cell.item === e ? cell.owner : e.owner;
        return Number.isInteger(e.owner) && e.owner >= 0 && e.owner === co && e.owner < 127 ? e.owner : -2; };
    const cls = (gx, gy) => { const e = getTileEntityRef(gx, gy); if (!e || e._stMine) return 0; if (e instanceof Tower) return String(e.type || '').startsWith('cloud') ? 5 : 1;
        if (e instanceof Barrack || isSpawnerEntity(e)) return 3; const cell = grid[gy] && grid[gy][gx]; if (cell && cell.item === e) return isTrapItem(e) ? 2 : 4; return 0; };
    const players = spatialUnitsComplexPlayerCount, B = SPATIAL_BLOCK_SIZE * CHUNK_SIZE, blk = new Int32Array(_simMoveStructBlocks.length);
    let bad = [], n = 0;
    for (let gy = 0; gy < GRID_H; gy++) for (let gx = 0; gx < GRID_W; gx++) {
        const t = gy * GRID_W + gx, c = code(gx, gy), k = cls(gx, gy);
        if (c !== -1) { n++; const b = (Math.floor(gy / B) * spatialBlockCols + Math.floor(gx / B)) * players; for (let p = 0; p < players; p++) if (c !== p) blk[b + p]++; }
        if (_simMoveStruct[t] !== c || _simStructCls[t] !== k) bad.push([gx, gy, _simMoveStruct[t], c, _simStructCls[t], k]);
    }
    let bb = 0; for (let j = 0; j < blk.length; j++) if (blk[j] !== _simMoveStructBlocks[j]) bb++;
    return { n, bad: bad.slice(0, 8), nbad: bad.length, blocks: bb }; };`);
let r0 = JSON.parse(i.eval('JSON.stringify(__scratch.check())'));
assert.deepEqual([r0.nbad, r0.blocks], [0, 0], 'whole tables ' + JSON.stringify(r0));
let last = r0;
for (let step = 0; step < 40; step++) {
    if (step % 10 === 0) for (let owner = 0; owner < 2; owner++) i.eval(`localPlayerId=${owner};${chaos.burst({ mode: 'mega' }, step / 10)};processActions(__scratch.actions.splice(0),${owner});`);
    i.eval('gameTick();currentTick++');
    if (step % 8 === 7) { last = JSON.parse(i.eval('JSON.stringify(__scratch.check())')); assert.deepEqual([last.nbad, last.blocks], [0, 0], 'step ' + step + ' ' + JSON.stringify(last)); }
}
// (A layout made anew: whole again.)
i.eval('_simMoveStructW = -1;');
const r1 = JSON.parse(i.eval('JSON.stringify(__scratch.check())'));
assert.deepEqual([r1.nbad, r1.blocks], [0, 0], 'rebuilt ' + JSON.stringify(r1));
assert.ok(r0.n > 1000, 'structures ' + r0.n);
assert.deepEqual(i.errors.map(String), []);
console.log('PASS: k_move_structs tables equal the structures\' (' + r0.n + ' then ' + last.n + ' tiles)');
