// Per-unit cost of applying a move order (the order queue's slices), with a
// CPU profile of the slice: node tests/_dbg_order_cost.cjs [units]
'use strict';
const realPerf = require('node:perf_hooks').performance;
const H = require('./net-harness.cjs');
const N = Number(process.argv[2]) || 20000;
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '200', 'cfg-map-type': 'arena' } });
const inst = world.spawn('orders', { simWorker: false });
inst.scratch.realNow = () => realPerf.now();
inst.eval('startSoloGame();');
inst.eval(`SEPARATION_SLOT_MIN_UNITS = 0; SPATIAL_PARALLEL_MIN_UNITS = 0; SNAP_HASH_KERNEL_MIN_UNITS = 0; EFF_STATS_KERNEL_MIN_UNITS = 0;`);
console.log(inst.eval(`(() => {
    let s = 7; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < ${N}; i++) { const t = findNearestWalkable(20 + Math.floor(rnd() * 160), 20 + Math.floor(rnd() * 160)); const u = new Unit(i % 5 === 0 ? 'tank' : 'norm', i & 1, t.x * TILE + 4 + rnd() * 24, t.y * TILE + 4 + rnd() * 24); units.push(u); updateUnitSpatial(u); }
    for (let i = 0; i < 3; i++) gameTick();
    return units.length;
})()`));
const inspector = require('node:inspector'), fs = require('fs');
const session = new inspector.Session(); session.connect(); session.post('Profiler.enable'); session.post('Profiler.setSamplingInterval', { interval: 50 });
const run = (label, k) => {
    const r = JSON.parse(inst.eval(`(() => {
        const mine = units.filter(u => !u.dead && u.owner === 0).map(u => u.id);
        const now = __scratch.realNow ? __scratch.realNow : () => Date.now();
        _orderBudgets[0] = 1e9;
        const a = sanitizeAction({ action: 'move', unitIds: mine, targetX: ${k} * GRID_W * TILE, targetY: 0.5 * GRID_H * TILE });
        const t0 = now(); processAction(a, 0); const t1 = now();
        return JSON.stringify({ n: mine.length, ms: t1 - t0 });
    })()`));
    console.log(label, r.n, 'units', r.ms.toFixed(1), 'ms', (1000 * r.ms / r.n).toFixed(2), 'us/unit');
};
if (process.env.PROF_FIRST) session.post('Profiler.start');
run('first', 0.3);
for (let i = 0; i < 3; i++) inst.eval('gameTick()');
if (!process.env.PROF_FIRST) session.post('Profiler.start');
run('second', 0.7);
for (let i = 0; i < 3; i++) inst.eval('gameTick()');
run('third', 0.4);
session.post('Profiler.stop', (err, { profile }) => { fs.writeFileSync(process.env.OUT || 'order.cpuprofile', JSON.stringify(profile)); process.exit(0); });
