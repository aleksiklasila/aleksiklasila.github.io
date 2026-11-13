'use strict';
// The mover table (wasm/src/mvt.rs, sim_occupancy.js; movement plan stage 3):
// the movement's block jobs walk it in a small battle, its rows equal to the
// units' columns before and after every movement (?mvt=2 throws otherwise);
// one row a live unit;
// a write of a column without its mark is found by the audit, and a marked
// one is not; the table made whole again equals the one kept step by step
// (as rows by slot: the order of rows in a block is not compared).
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '64' } });
const i = world.spawn('mover-table', { simWorker: false, url: 'http://localhost/rng/defence3/index.html?mvt=2' });
const r = i.eval(`(() => {
    startSoloGame();
    const add = (type, owner, x, y) => { const u = new Unit(type, owner, x * TILE, y * TILE); applyUnitLevelScaling(u, 1); units.push(u); unitSlotMapPushed(u); return u; };
    const mine = [], theirs = [];
    for (let k = 0; k < 60; k++) mine.push(add(k % 3 ? 'norm' : 'tank', 0, 8.5 + (k % 10), 20.5 + ((k / 10) | 0)));
    for (let k = 0; k < 40; k++) theirs.push(add(k % 4 ? 'fast' : 'flying', 1, 40.5 + (k % 8), 20.5 + ((k / 8) | 0)));
    const out = { errors: [] };
    const rowsBySlot = () => { const M = _mvt, o = {}; for (let s = 0; s < M.cap; s++) { const h = M.hrow[s]; if (h < 0) continue; const a = []; for (let f = 0; f < MVT_ROW_W; f++) a.push(M.rows[(h >> 6) * MVT_SLAB * MVT_ROW_W + f * MVT_SLAB + (h & 63)]); o[s] = a.join(','); } return o; };
    const footprints = () => { let n = 0; const c = _simUnitState.columns; for (let s = 0; s < _simUnitState.owners.length; s++) if (c.live[s] && !c.dead[s]) n++; return n; };
    for (let t = 0; t < 40; t++) gameTick();
    // (Orders to both sides: steers, arrivals, a fight in the middle.)
    processAction(sanitizeAction({ action: 'move', unitIds: mine.map(u => u.id), targetX: 30.5 * TILE, targetY: 22.5 * TILE }), 0);
    processAction(sanitizeAction({ action: 'move', unitIds: theirs.map(u => u.id), targetX: 26.5 * TILE, targetY: 22.5 * TILE }), 1);
    for (let t = 0; t < 200; t++) gameTick();
    out.audits = _mvt.audits | 0;
    // The table as kept: synced (the marks of the last movement), audited, compared with one made whole.
    mvtSync(_mvt);
    out.afterSync = mvtCheck();
    out.rows = _mvt.cfg[6]; out.footprints = footprints();
    const kept = rowsBySlot();
    _mvtRun(_mvt, 'mvt_rebuild');
    out.afterRebuild = mvtCheck();
    out.sameAsWhole = JSON.stringify(kept) === JSON.stringify(rowsBySlot());
    // A write without its mark: found. With it: its row made again.
    const c = _simUnitState.columns, u = units.find(q => !q.dead && q._us && _mvt.hrow[q._si] >= 0), s = u._si;
    const own = c.owner[s];
    c.owner[s] = own ^ 1;
    const miss = mvtCheck();
    out.missFound = !!miss && miss.slot === s && miss.differs.some(d => /owner/.test(d));
    c.owner[mvtM(s)] = own ^ 1;
    mvtSync(_mvt);
    out.markedOk0 = mvtCheck();
    c.owner[mvtM(s)] = own;
    mvtSync(_mvt);
    out.markedOk = mvtCheck();
    // A position across a block's edge without a mark: found; marked: the row moves to the other block.
    const q8 = _mvt.cfg[4], before = c.x[s];
    c.x[s] = before + q8;
    const miss2 = mvtCheck();
    out.moveFound = !!miss2 && miss2.differs.some(d => /^x/.test(d));
    // (A marked position write moves the footprint with it: its record holds where the unit stands.)
    _occ.rec[s * 4] = c.x[s]; mvtM(s); mvtSync(_mvt);
    out.movedOk = mvtCheck();
    c.x[mvtM(s)] = before; _occ.rec[s * 4] = before; mvtSync(_mvt);
    out.backOk = mvtCheck();
    _mvt.two = true; c.x[mvtM(s)] = before + q8; _occ.rec[s * 4] = before + q8; mvtSync(_mvt); out.twoOk = mvtCheck();
    c.x[mvtM(s)] = before; _occ.rec[s * 4] = before; mvtSync(_mvt); out.twoBack = mvtCheck(); _mvt.two = false;
    // A unit gone: its row goes at the next movement (the kernels' marks).
    const victim = units.find(q => !q.dead && q._us && q !== u);
    victim.energy = 0;
    for (let t = 0; t < 5; t++) gameTick();
    mvtSync(_mvt);
    out.afterDeath = mvtCheck(); out.rows2 = _mvt.cfg[6]; out.footprints2 = footprints();
    return out;
})()`);
assert.deepEqual(i.errors, []);
assert(r.audits >= 400, 'audited before every movement: ' + r.audits);
assert.equal(r.afterSync, null, 'kept table equals the columns');
assert(r.rows > 50 && r.rows === r.footprints, 'one row a live unit: ' + r.rows + ' / ' + r.footprints);
assert.equal(r.afterRebuild, null);
assert(r.sameAsWhole, 'the table kept step by step equals the one made whole');
assert(r.missFound, 'a write without its mark is found');
assert.equal(r.markedOk0, null, 'a marked write is synced');
assert.equal(r.markedOk, null);
assert(r.moveFound, 'a position written without its mark is found');
assert.equal(r.movedOk, null, 'a row moves to its new block');
assert.equal(r.backOk, null);
assert.equal(r.twoOk, null, 'the block pass in two rounds');
assert.equal(r.twoBack, null);
assert.equal(r.afterDeath, null);
assert.equal(r.rows2, r.footprints2);
assert(r.rows2 < r.rows, 'a dead unit has no row');
console.log('PASS: mover table: ' + r.rows + ' rows, ' + r.audits + ' audits; unmarked writes found, marked ones synced, rows re-homed, the kept table equals a rebuilt one');
