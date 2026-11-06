'use strict';
// The flow looks off the turns (unit.js flowLooksPost / flowLooksCommit;
// mv.rs flow_look_approx, mv_flow_pending / _exact / _commit): a turn whose
// record misses takes an O(1) answer, the exact one is made on the helpers
// and committed at the tick's end. A chaos scene with move and attack-move
// orders every few steps hashes the same with no helpers as with 3 (the
// answers made at the commit's wait, or beside the tick), every step; and
// the commits sharpen the records (most walkers' records exact after).
// Usage: node tests/flow-looks-commit.test.cjs
const assert = require('node:assert/strict'), H = require('./net-harness.cjs'), chaos = require('./chaos-spikes-scenario.cjs');
globalThis.self = { crossOriginIsolated: true };
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '192', 'cfg-map-type': 'arena', 'cfg-gold-count': '200', 'cfg-astar-mine-count': '200', 'cfg-max-pop': '20000' };
const run = helpers => {
    const world = new H.World({ controls }), i = world.spawn('fl' + helpers, { controls, simWorker: false });
    if (helpers) { i.scratch.Worker = require('./real-sim-helper.cjs'); i.eval(`Worker=__scratch.Worker;navigator.hardwareConcurrency=16;simParallelInit('',${helpers});`); }
    i.eval(`MAX_THING_LEVEL=20;MAX_RESEARCH_LEVEL=10;startingResourcesConfig=normalizeStartingResourcesConfig({spawnCounts:{'unit:king':{1:1},'unit:norm':{12:1500},'unit:flying':{6:300},'unit:builder_unit':{10:60}},research:{}});startSoloGame();`);
    const setup = JSON.parse(i.eval('JSON.stringify(' + chaos.setup({ mode: 'mega', layout: 'mixed', buildings: 50, level: 6, towerSites: 30, collectorBuildings: 20, structures: 4000 }) + ')'));
    assert.deepEqual(setup.errors, []);
    const hashes = [], records = [];
    for (let step = 0; step < 40; step++) {
        if (step % 6 === 1) i.eval(`(() => { for (const p of [0, 1]) { const army = units.filter(u => u && !u.dead && u.owner === p && !u.workerType && !u.isKing), half = army.length >> 1;
            const mode = ${step} % 12 === 1 ? 'move' : 'attackMove';
            processActions([{ action: mode, unitIds: army.slice(0, half).map(u => u.id), targetX: (30 + ${step} * 3) * TILE, targetY: (40 + p * 90) * TILE },
                { action: mode, unitIds: army.slice(half).map(u => u.id), targetX: (150 - ${step} * 2) * TILE, targetY: (100 - p * 40) * TILE }], p); } })()`);
        i.eval('gameTick();currentTick++');
        hashes.push(i.eval('__exactStateHash()'));
        // (Flow walkers whose record is an answer (exact) or the approximation (kind | 1 << 16).)
        records.push(JSON.parse(i.eval(`JSON.stringify((() => { const c = _simUnitState.columns, R = c.mvNav, n = _simUnitState.owners.length; let exact = 0, approx = 0;
            for (let s = 0; s < n; s++) { if (c.mvOn[s] !== 1 || c.dead[s]) continue; const g = R[s * 8 + 4]; if (g & 65536) approx++; else if (g > 0) exact++; } return [exact, approx]; })())`)));
    }
    assert.deepEqual(i.errors.map(String), []);
    return { hashes, records };
};
const none = run(0), three = run(3);
const first = none.hashes.findIndex((h, k) => h !== three.hashes[k]);
assert.equal(first, -1, 'no helpers and three differ from step ' + first);
const [exact, approx] = three.records.reduce((a, r) => [a[0] + r[0], a[1] + r[1]], [0, 0]);
console.log(JSON.stringify({ exact, approx, last: three.records.slice(-3) }));
assert.ok(exact > 0, 'committed answers reach the records');
assert.ok(exact > approx * 2, 'most walkers hold exact answers between orders');
console.log('PASS: flow looks off the turns: the same with 0 and 3 helpers over', none.hashes.length, 'steps; records sharpened');
process.exit(0);
