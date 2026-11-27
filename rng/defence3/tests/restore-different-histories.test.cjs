'use strict';
// Two peers with different histories restore one snapshot (as a resync or a join does: the sender's caches flushed
// first, utils_networking.js / sim_client.js snapFlushHistoryCaches) and play on: their state hashes must agree tick by
// tick. Peer A plays a battle (units, structures placed, orders, deaths) and encodes; peer B played a different one
// (other units and structures, a different order of births, rows and slots) before restoring A's state.
//   node tests/restore-different-histories.test.cjs [ticks=120]
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const TICKS = Number(process.argv[2] || 120);
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '96', 'cfg-map-type': 'arena', 'cfg-max-pop': '20000' };
const world = new H.World({ controls });
const a = world.spawn('rhA', { controls, simWorker: false }), b = world.spawn('rhB', { controls, simWorker: false });
for (const p of [a, b]) p.eval('startSoloGame();');
// A history: units of both sides, structures placed, orders, ticks (the seed decides what).
const play = (p, seed, n) => p.eval(`(() => {
    let s = ${seed}; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const types = ['norm', 'fast', 'tank', 'archer', 'flying', 'snake'];
    for (let i = 0; i < 700; i++) { const o = i % 2, gx = o ? 60 + Math.floor(rnd() * 25) : 8 + Math.floor(rnd() * 25), gy = 10 + Math.floor(rnd() * 70);
        if (cellType[gy * GRID_W + gx] === TYPE_WALL) continue; const u = new Unit(types[i % types.length], o, gx * TILE + 16, gy * TILE + 16); units.push(u); updateUnitSpatial(u); }
    const keys = ['pistol', 'sniper', 'barrack_norm', 'spawner', 'house', 'sand', 'laser'];
    for (let i = 0; i < 60; i++) { const o = i % 2, gx = o ? 55 + Math.floor(rnd() * 30) : 5 + Math.floor(rnd() * 30), gy = 5 + Math.floor(rnd() * 80); placeBuilding(gx, gy, keys[i % keys.length], o, { ignorePlacementRules: true, silent: true }); }
    for (let t = 0; t < ${n}; t++) {
        if (t % 20 === 0) for (const o of [0, 1]) { const ids = units.filter(u => u && !u.dead && u.owner === o && !u.workerType && !u.isKing).map(u => u.id); if (ids.length) processActions([{ action: t % 40 ? 'attackMove' : 'move', unitIds: ids, targetX: (o ? 20 : 70) * TILE, targetY: (20 + Math.floor(rnd() * 50)) * TILE }], o); }
        gameTick(); currentTick++;
    }
})()`);
play(a, 4242, 150);
play(b, 777, 90);
a.eval('snapFlushHistoryCaches(); __scratch.saved = JSON.stringify(snapEncodeState());');
b.scratch.saved = a.scratch.saved;
for (const p of [a, b]) p.eval('snapFlushHistoryCaches(); snapDecodeState(JSON.parse(__scratch.saved));');
const ha = [], hb = [];
let first = -1;
for (let t = 0; t < TICKS; t++) {
    for (const p of [a, b]) p.eval('gameTick(); currentTick++;');
    const x = a.eval('computeLockstepStateHashFast(gameTime)'), y = b.eval('computeLockstepStateHashFast(gameTime)');
    ha.push(x); hb.push(y);
    if (first < 0 && JSON.stringify(x) !== JSON.stringify(y)) first = t;
}
const full = p => JSON.stringify(p.eval('snapTickHash(currentTick, true)'));
const fa = full(a), fb = full(b);
let parts = null;
if (first >= 0 || fa !== fb) {
    const A = JSON.parse(fa), B = JSON.parse(fb);
    parts = Object.keys(A.pairs || {}).filter(k => A.pairs[k] !== (B.pairs || {})[k]);
}
console.log(JSON.stringify({ ticks: TICKS, firstDiff: first, fullEqual: fa === fb, parts, units: a.eval('units.filter(u => u && !u.dead).length') }));
assert.equal(first, -1, 'the peers diverge after the restore at tick +' + first + ' (hash parts ' + JSON.stringify(parts) + ')');
assert.equal(fa, fb, 'the full hashes differ: parts ' + JSON.stringify(parts));
assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
console.log('PASS: restore-different-histories:', TICKS, 'ticks equal after a restore over different histories');
