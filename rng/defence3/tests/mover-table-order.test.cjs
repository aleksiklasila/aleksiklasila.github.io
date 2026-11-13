'use strict';
// The mover table's row order is a peer's own history (wasm/src/mvt.rs: a row
// gone is replaced by its block's last, a restore makes the table whole in
// slot order): it must not show in any outcome. Two runs of the same crowded
// battle, one with every block's rows reversed before each movement (and,
// every tenth tick, the table made whole again from the columns): the same
// positions for every unit at the end, and at checkpoints on the way.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
function run(name, permute) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '64' } });
    const i = world.spawn(name, { simWorker: false, url: 'http://localhost/rng/defence3/index.html?mvt=2' });
    const r = i.eval(`(() => {
        startSoloGame();
        const add = (type, owner, x, y) => { const u = new Unit(type, owner, x * TILE, y * TILE); applyUnitLevelScaling(u, 1); units.push(u); unitSlotMapPushed(u); return u; };
        const mine = [], theirs = [];
        for (let k = 0; k < 240; k++) mine.push(add(k % 3 ? 'norm' : 'tank', 0, 6.5 + (k % 16) * 0.5, 16.5 + ((k / 16) | 0) * 0.5));
        for (let k = 0; k < 240; k++) theirs.push(add(k % 4 ? 'fast' : 'norm', 0, 44.5 + (k % 16) * 0.5, 16.5 + ((k / 16) | 0) * 0.5));
        // (Every block's rows in reverse order: the rows' words swapped end for end over the chain, the slots' row indices after them.)
        const reverse = () => {
            const M = _mvt; let n = 0;
            for (let b = 0; b < M.bw * M.bh; b++) {
                const cnt = M.bcount[b]; if (cnt < 2) continue;
                const hs = []; for (let sl = M.bhead[b], k = 0; k < cnt; k++) { hs.push(sl * MVT_SLAB + k % MVT_SLAB); if ((k + 1) % MVT_SLAB === 0) sl = M.snext[sl]; }
                const at = (h, f) => (h >> 6) * MVT_SLAB * MVT_ROW_W + f * MVT_SLAB + (h & 63);
                for (let a = 0, z = cnt - 1; a < z; a++, z--) for (let f = 0; f < MVT_ROW_W; f++) { const p = at(hs[a], f), q = at(hs[z], f), v = M.rows[p]; M.rows[p] = M.rows[q]; M.rows[q] = v; }
                for (const h of hs) M.hrow[M.rows[at(h, 3)]] = h;
                n += cnt;
            }
            return n;
        };
        const state = () => { const c = _simUnitState.columns, a = []; for (const u of units) if (u && !u.dead && u._us) a.push(u.id + ':' + c.x[u._si] + ',' + c.y[u._si]); return a.sort().join(' '); };
        const out = { marks: [], reversed: 0, moved: 0 };
        for (let t = 0; t < 30; t++) gameTick();
        const start = state();
        const order = (g, x, y) => processAction(sanitizeAction({ action: 'move', unitIds: g.map(u => u.id), targetX: x * TILE, targetY: y * TILE }), 0);
        order(mine, 46.5, 20.5); order(theirs, 8.5, 20.5);
        const permute = ${permute ? 'true' : 'false'};
        // (Before each movement: the table as synced by the last one's marks is permuted, then the tick syncs and moves.)
        const before = occupancyPrepareMovement;
        let tick = 0;
        occupancyPrepareMovement = function () {
            const r = before.apply(this, arguments);
            if (permute && _mvt && _mvt.whole) { if (tick % 10 === 9) { _mvtRun(_mvt, 'mvt_rebuild'); } out.reversed += reverse(); const bad = mvtCheck(); if (bad) throw new Error('permuted table fails its audit: ' + JSON.stringify(bad)); }
            tick++;
            return r;
        };
        for (let t = 0; t < 300; t++) { gameTick(); if (t % 50 === 49) out.marks.push(state()); }
        occupancyPrepareMovement = before;
        out.moved = out.marks[out.marks.length - 1] !== start;
        out.units = units.filter(u => u && !u.dead).length;
        return out;
    })()`);
    assert.deepEqual(i.errors, []);
    return r;
}
const a = run('order-kept', false), b = run('order-reversed', true);
assert(a.moved, 'the units moved');
assert(b.reversed > 100000, 'rows were permuted: ' + b.reversed);
assert.equal(a.units, b.units);
for (let k = 0; k < a.marks.length; k++) assert.equal(b.marks[k], a.marks[k], 'positions differ at checkpoint ' + k + ' with the rows permuted');
console.log('PASS: mover table row order: ' + a.units + ' units, ' + b.reversed + ' rows reversed over 300 ticks, positions equal at ' + a.marks.length + ' checkpoints');
