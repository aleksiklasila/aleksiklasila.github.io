'use strict';
// Structure table rows are a pool reserved at the match's start and reused,
// never copied: a structure that leaves the world (its tile cleared) keeps its
// row, so a stale reference (a worker's target, a selection) still reads and
// writes its own values; STRUCT_ROW_KEEP_TICKS later the row expires and goes
// to the next structure, and the old object reads as destroyed. Placing and
// destroying many structures neither grows the tables nor copies records.
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const w = new H.World({ controls: H.SMALL_MATCH_CONTROLS }), i = w.spawn('row-reuse', { simWorker: false });
const out = JSON.parse(i.eval(`(() => {
    startSoloGame();
    const spots = [];
    for (let gy = 2; gy < GRID_H - 2 && spots.length < 60; gy++) for (let gx = 2; gx < GRID_W - 2 && spots.length < 60; gx++)
        if (!getTileEntityRef(gx, gy) && grid[gy][gx].type !== TYPE_WALL) spots.push([gx, gy]);
    const place = () => spots.map(([gx, gy]) => { placeBuilding(gx, gy, 'pistol', 0, { silent: true, ignorePlacementRules: true }); return getTileEntityRef(gx, gy); }).filter(Boolean);
    const T = _sTables.get(Tower), cap0 = T.cap, grown0 = structRowStats.grown;
    const first = place(), n1 = T.n;
    const kept = first[7], view = { gx: kept.gx, gy: kept.gy, type: kept.type, owner: kept.owner, level: kept.level };
    for (const b of first) destroyBuilding(b);
    const after = { gx: kept.gx, gy: kept.gy, type: kept.type, owner: kept.owner, level: kept.level }, keptRow = kept._sr;
    kept.energy = 3;
    const keptEnergy = kept.energy, retired = T.qn;
    // (Placing again within the keep: fresh rows, the retired ones untouched.)
    const second = place(), n2 = T.n, stillKept = kept._sr === keptRow && kept.gx === view.gx;
    for (const b of second) destroyBuilding(b);
    // (Past the keep: the rows expire and the next placement takes them.)
    gameTime += STRUCT_ROW_KEEP_TICKS; structRowsExpire();
    const gone = { sr: kept._sr, energy: kept.energy, stT: kept._stT, gxUnset: kept.gx === undefined }, goneKeys = Object.keys(kept).filter(k => k.startsWith('_s'));
    kept.energy = 5;
    const third = place(), n3 = T.n;
    // (A retired structure placed again keeps its row and leaves the queue.)
    const back = third[3], ty = getTileEntityType(back.gx, back.gy), bgx = back.gx, bgy = back.gy; destroyBuilding(back); const q1 = T.qn;
    setTileEntity(bgx, bgy, ty, back); const q2 = T.qn;
    return JSON.stringify({ placed: first.length, n1, n2, n3, cap0, cap: T.cap, grown: structRowStats.grown - grown0, retired, view, after, keptEnergy, stillKept, gone,
        goneEnergyAfterWrite: kept.energy, goneKeys, liveOk: third.every(b => b._sr >= 0 && b.gx >= 0), q1, q2, backRow: back._sr >= 0 });
})()`));
assert.ok(out.placed >= 30, JSON.stringify(out));
assert.ok(out.cap0 >= 1024, 'the table is reserved at the match start: ' + JSON.stringify(out));
assert.equal(out.cap, out.cap0, 'no growth: ' + JSON.stringify(out));
assert.equal(out.grown, 0);
assert.deepEqual(out.after, out.view, 'a destroyed structure reads its own values');
assert.equal(out.keptEnergy, 3, 'a destroyed structure takes writes while it keeps its row');
assert.equal(out.retired, out.placed);
assert.ok(out.stillKept, 'retired rows are not handed out within the keep');
assert.equal(out.n2, out.n1 + out.placed);
assert.equal(out.n3, out.n2, 'expired rows reused for the third placement: ' + JSON.stringify(out));
assert.deepEqual(out.gone, { sr: -1, energy: 0, stT: -1, gxUnset: true }, 'an expired structure reads as destroyed');
assert.equal(out.goneEnergyAfterWrite, 0, 'writes to an expired structure go nowhere');
assert.deepEqual(out.goneKeys, [], 'no snapshot keys for the pool bookkeeping');
assert.ok(out.liveOk);
assert.equal(out.q2, out.q1 - 1, 'placed again: out of the retire queue');
assert.ok(out.backRow);
assert.deepEqual(i.errors, []);
console.log('PASS: structure rows kept ' + STRUCT_ROW_KEEP_TICKS_TEXT() + ' after removal and reused (' + out.n3 + ' rows for three rounds of ' + out.placed + ', reserved ' + out.cap + ')');
function STRUCT_ROW_KEEP_TICKS_TEXT() { return i.eval('STRUCT_ROW_KEEP_TICKS') + ' ticks'; }
