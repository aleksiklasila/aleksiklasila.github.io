// The structure table (data_state.js _ST): every structure on a tile
// (towers, barracks, spawners, floor items, mines) has its hash core (kind
// code, owner, construction, energy / mine amount) mirrored per tile by its
// accessors; cleared when it leaves; rebuilt alike by a snapshot restore
// (the restored peer's table and tick hash equal the original's).
//   node tests/structure-table.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '80', 'cfg-map-type': 'arena' } });
const a = world.spawn('sta', { simWorker: false });
const b = world.spawn('stb', { simWorker: false });
for (const i of [a, b]) i.eval('startSoloGame();');

// Every tile's table entry against the entity standing there.
const CHECK = `(() => {
    const bad = [];
    let n = 0;
    for (let gy = 0; gy < GRID_H; gy++) for (let gx = 0; gx < GRID_W; gx++) {
        const t = gy * GRID_W + gx, e = getTileEntityRef(gx, gy), c = _ST.n ? _ST.code[t] : 0;
        if (!e) { if (c) bad.push('stale ' + t); continue; }
        n++;
        if (c !== e._stCode) { bad.push('code ' + t + ' ' + c + ' ' + e._stCode + ' ' + (e.constructor && e.constructor.name)); continue; }
        if (e._stT !== t) bad.push('tile ' + t);
        if (e._stMine) { const v = e instanceof GoldMine ? e.gold : e.astar; if (!Object.is(_ST.val[t], Number(v))) bad.push('amount ' + t); continue; }
        if (_ST.own[t] !== ((e.owner | 0) === e.owner ? e.owner : ST_OWNER_NONE)) bad.push('owner ' + t);
        if (_ST.uc[t] !== (e.underConstruction ? 1 : 0)) bad.push('uc ' + t);
        if (!Object.is(_ST.val[t], Number(e.energy))) bad.push('energy ' + t + ' ' + _ST.val[t] + ' ' + e.energy);
        if (e._stCode === 0x22 && !Object.is(_ST.tim[t], Number(e._cdUntil) || 0)) bad.push('cooldown ' + t);
        if (e._stTimer && !Object.is(_ST.tim[t], Number(e.spawnTimer) || 0)) bad.push('spawn timer ' + t);
    }
    // (The per-region counts the hash skips empty regions by.)
    if (_ST.n) {
        const cnt = new Uint8Array(_ST.rcnt.length);
        for (let t = 0; t < _ST.n; t++) if (_ST.code[t]) cnt[_stRegion(t)]++;
        for (let r = 0; r < cnt.length; r++) if (cnt[r] !== _ST.rcnt[r]) { bad.push('region count ' + r + ' ' + _ST.rcnt[r] + ' ' + cnt[r]); break; }
    }
    return JSON.stringify({ n, bad: bad.slice(0, 10), nbad: bad.length });
})()`;

const placed = JSON.parse(a.eval(`JSON.stringify((() => {
    let found = null;
    for (let gy = 4; gy < GRID_H - 10 && !found; gy++) for (let gx = 4; gx < GRID_W - 10 && !found; gx++) {
        let ok = true;
        for (let y = gy; y < gy + 3 && ok; y++) for (let x = gx; x < gx + 6 && ok; x++)
            if (grid[y][x].type === TYPE_WALL || grid[y][x].item || getTileEntityRef(x, y)) ok = false;
        if (ok) found = { gx, gy };
    }
    const kinds = ['pistol', 'barrack_norm', 'lava', 'sand'];
    const out = [];
    kinds.forEach((k, i) => {
        const gx = found.gx + i, gy = found.gy;
        out.push([k, placeBuilding(gx, gy, k, 0, { ignorePlacementRules: true, silent: true, autoUpgradeEnabled: false, buildEnabled: true }), gx, gy]);
    });
    return { found, out, mines: goldMines.length + astarMines.length, floorClass: (grid[found.gy][found.gx + 2].item || {}).constructor.name };
})())`));
console.log('placed', JSON.stringify(placed));
assert.ok(placed.out.every(p => p[1]), 'all placed');
assert.equal(placed.floorClass, 'FloorItem');
assert.ok(placed.mines > 0, 'the map has mines');

let c = JSON.parse(a.eval(CHECK));
assert.equal(c.nbad, 0, 'after placing: ' + c.bad.join('; '));

// Writes through the accessors; a destroyed structure leaves the table.
a.eval(`(() => {
    const { gx, gy } = ${JSON.stringify(placed.found)};
    const t = getTileEntityRef(gx, gy); t.energy = 7.5; t.underConstruction = false; t.owner = 1; t.cd = 13;
    const f = getTileEntityRef(gx + 2, gy); f.energy = 3;
    const m = goldMines[0]; m.gold = m.gold - 11;
    destroyBuilding(getTileEntityRef(gx + 1, gy));
})()`);
c = JSON.parse(a.eval(CHECK));
assert.equal(c.nbad, 0, 'after writes and a destroy: ' + c.bad.join('; '));
assert.equal(a.eval(`_ST.code[${placed.found.gy * 80 + placed.found.gx + 1}]`), 0, 'destroyed tile cleared');

for (let k = 0; k < 40; k++) a.eval('gameTick()');
c = JSON.parse(a.eval(CHECK));
assert.equal(c.nbad, 0, 'after ticks: ' + c.bad.join('; '));

// A full restore on the other instance: same table, same tick hash.
const snap = a.eval('JSON.stringify(snapEncodeState())');
b.eval(`snapDecodeState(JSON.parse(${JSON.stringify(snap)}))`);
const cb = JSON.parse(b.eval(CHECK));
assert.equal(cb.nbad, 0, 'restored: ' + cb.bad.join('; '));
assert.equal(cb.n, c.n, 'same structure count');
const tableSum = `(() => { let h = 0; for (let t = 0; t < _ST.n; t++) if (_ST.code[t]) h = (Math.imul(h ^ t, 16777619) + _ST.code[t] * 7 + _ST.own[t] * 31 + _ST.uc[t] + Math.round(_ST.val[t] * 1024)) | 0; return h; })()`;
assert.equal(b.eval(tableSum), a.eval(tableSum), 'same table');
// The hash's structure core of every slice. (Whole tick hashes are not
// compared: the globals part and towers' status fields (undefined until set,
// 0 once restored) differ after a restore into another solo instance at
// HEAD already.)
const coreOf = (i, s) => i.eval(`(() => { const R = _snapRegionsBegin(); _snapStaticCoreSweep(${s}, -1, R); const o = []; for (let k = 0; k < R.n; k++) o.push(R.list[k] + ':' + R.acc[R.list[k]]); return o.sort().join(); })()`);
let regionsHashed = 0;
for (let s = 0, S = Number(a.eval('SNAP_HASH_SLICES')); s < S; s++) {
    const ca = coreOf(a, s);
    assert.equal(coreOf(b, s), ca, 'structure core, slice ' + s);
    regionsHashed += ca ? ca.split(',').length : 0;
}
assert.ok(regionsHashed > 0, 'regions with structures hashed');
// Every structure of the restored peer has the class it had.
assert.equal(b.eval(`[...new Set(_snapFloorItems().map(e => e.constructor.name))].join()`), 'FloorItem');
assert.equal(b.eval(`goldMines.every(m => m instanceof GoldMine) && astarMines.every(m => m instanceof AstarMine)`), true);
console.log('structures', c.n);
console.log('PASS: structure table');
