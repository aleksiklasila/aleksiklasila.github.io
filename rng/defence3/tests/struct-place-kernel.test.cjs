'use strict';
// Structures placed by the placement kernel (plc.rs k_struct_place, things_utils.js _structPlace): every class through
// the place action and with the rules off (tests/struct-place-state.cjs). Each placed structure's row, tile entry and
// cell as a placement leaves them (under construction, energy 1, levels 0, owner on the tile and the cell), its object
// made only when read (data_state.js structRowObj); the refusals (a second cloud of a type, a tile out of sight, a
// wall, an occupied tile); two runs from the same start the same, state hash included. (Checked against the old
// object path at the conversion, 2026-11-26: identical rows, tables, counts and hashes, tests/test-runs/loop-20261126.)
const assert = require('node:assert/strict');
const { run } = require('./struct-place-state.cjs');

const a = run(), b = run();
assert.deepEqual(a, b, 'two runs from the same start differ');
const placed = new Map(a.tries.filter(t => t[3]).map(t => [t[0] + ',' + t[1], t[2]]));
assert.ok(a.rows.length >= 20, 'structures placed: ' + a.rows.length);
const codes = { Tower: 0x22, Barrack: 0x33, FloorItem: 0x55 };
for (const r of a.rows) {
    const [gx, gy] = r.at, what = placed.get(gx + ',' + gy);
    if (!what) continue;
    const code = codes[r.cls] || 0x44;
    assert.equal(r.tile[0], code, 'tile code ' + r.cls);
    assert.equal(r.tile[1], r.view.owner, 'tile owner');
    assert.equal(r.tile[2], 1, 'under construction on the tile');
    assert.equal(r.tile[3], 1, 'energy on the tile');
    assert.ok(r.tile[8] > 0, 'class on the tile');
    assert.equal(r.cell[1], r.view.owner, 'cell owner');
    assert.equal(r.view.uc, true, 'under construction');
    assert.equal(r.view.energy, 1, 'energy 1');
    assert.equal(r.view.level, 0, 'level 0');
    assert.ok(r.view.maxEnergy > 1, 'its maximum energy from the stat tables');
    assert.equal(r.view.x, gx * 32 + 16, 'x');
    assert.equal(r._stT, gy * 60 + gx, 'its tile in its row');
    assert.equal(r.type, what.startsWith('raw:') ? (what.slice(4).startsWith('barrack_') ? 'barrack' : what.slice(4)) : what.startsWith('barrack_') ? 'barrack' : what, 'type');
}
const tryAt = (gx, gy, key) => a.tries.find(t => t[0] === gx && t[1] === gy && t[2] === key);
// (The first cloud_0a placed, the next refused: one of a type a player.)
const clouds = a.tries.filter(t => t[2] === 'cloud_0a');
assert.equal(clouds.filter(t => t[3]).length, 1, 'one cloud_0a: ' + JSON.stringify(clouds));
assert.equal(tryAt(57, 57, 'pistol')[3], false, 'out of sight refused');
assert.equal(a.tries.filter(t => t[2] === 'raw:cloud_0a')[0][3], false, 'a second cloud with the rules off refused too');
assert.ok(a.moved.towers && a.moved.barracks && a.moved.spawners && a.moved.clouds && a.moved.lasers, 'list versions moved: ' + JSON.stringify(a.moved));
assert.ok(a.adj[0] > 0, 'adjacency marked');
assert.notDeepEqual(a.hash0, a.hash60, 'the match went on');
console.log('PASS: struct-place-kernel:', a.rows.length, 'structures,', a.tries.length, 'tries; rows, tiles, cells, refusals, two runs equal');
