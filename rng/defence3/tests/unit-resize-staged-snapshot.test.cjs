'use strict';
// A staged q / e (main.js _rzStart / rzCommitDue, UNIT_BIRTH_WASM_PLAN.md)
// in a snapshot taken while it is pending: peer A encodes the state after the
// x2 action; A and peer B both restore it and tick on. Their state hashes match tick
// by tick (as tests/action-budget.test.cjs checks a waiting action), the
// resize happened on both, and their slot books and occupancy stay consistent.
// Usage: node tests/unit-resize-staged-snapshot.test.cjs
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
// (q / e is off for now (main.js UNIT_RESIZE_ENABLED): nothing to test until it comes back.)
if (!/const UNIT_RESIZE_ENABLED = true;/.test(require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/main.js'), 'utf8'))) { console.log('SKIP: q / e is off (main.js UNIT_RESIZE_ENABLED)'); process.exit(0); }
globalThis.self = { crossOriginIsolated: true };
const controls = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '160', 'cfg-map-type': 'arena', 'cfg-max-pop': '20000' };
const world = new H.World({ controls });
const a = world.spawn('rzA', { controls, simWorker: false }), b = world.spawn('rzB', { controls, simWorker: false });
for (const p of [a, b]) p.eval('startSoloGame();');
// (Both fresh: a restore after different histories diverges without q / e too (2026-11-08, open: UNIT_BIRTH_WASM_PLAN.md).)
const r = JSON.parse(a.eval(`JSON.stringify((() => {
    const ids = [];
    for (let i = 0; i < 1600; i++) { const gx = 20 + (i % 80), gy = 30 + Math.floor(i / 80); if (grid[gy][gx].type === TYPE_WALL) continue; const u = new Unit(i % 4 ? 'norm' : 'tank', 0, gx * TILE + 16, gy * TILE + 16); u.stackCount = 4; units.push(u); unitSlotMapPushed(u); ids.push(u.id); }
    for (let t = 0; t < 3; t++) gameTick();
    const before = units.filter(u => u && !u.dead && u.owner === 0).length;
    processActions([{ action: 'resizeUnitGroup', unitIds: ids, mode: 'x2', bySub: true, byLevel: false }], 0);
    const pending = _rzJob !== null;
    __scratch.saved = JSON.stringify(snapEncodeState());
    return { before, pending };
})())`));
assert.ok(r.pending, 'the resize is pending when the snapshot is taken');
b.scratch.saved = a.scratch.saved;
a.eval('snapDecodeState(JSON.parse(__scratch.saved))');
b.eval('snapDecodeState(JSON.parse(__scratch.saved))');
assert.ok(b.eval('_rzJob !== null'), 'the restored peer has the pending resize');
const ha = [], hb = [];
for (let t = 0; t < 30; t++) {
    a.eval('gameTick()'); b.eval('gameTick()');
    ha.push(a.eval('computeLockstepStateHashFast(gameTime)')); hb.push(b.eval('computeLockstepStateHashFast(gameTime)'));
}
const count = p => p.eval('units.filter(u => u && !u.dead && u.owner === 0).length');
const [na, nb] = [count(a), count(b)];
assert.ok(na > r.before, 'x2 made units on A: ' + r.before + ' -> ' + na);
assert.equal(nb, na, 'B made the same units');
assert.deepEqual(hb, ha, 'two peers restored from the snapshot stay equal');
assert.equal(a.eval('__exactStateHash()'), b.eval('__exactStateHash()'), 'exact states equal');
for (const p of [a, b]) { const au = JSON.parse(p.eval('JSON.stringify({ slabs: simUnitSlabAudit(), occ: occupancyAudit() })')); assert.ok(au.slabs.ok && au.occ.ok, 'slot books and occupancy ' + JSON.stringify(au)); }
assert.deepEqual([...a.errors, ...b.errors].map(String), []);
console.log('PASS: staged q / e through a snapshot', JSON.stringify({ before: r.before, after: na, ticks: ha.length }));

// The same through a snapshot taken in the middle of the commit's steps:
// ~6000 new units (RZ_COMMIT_PARTS parts), encoded by E after two parts
// made their units, restored by two other peers (a peer restoring over a
// different history of its own diverges without q / e too: open,
// UNIT_BIRTH_WASM_PLAN.md) (the population cap raised in all, test only).
{
    const world2 = new H.World({ controls });
    const e = world2.spawn('rzE', { controls, simWorker: false }), c = world2.spawn('rzC', { controls, simWorker: false }), d = world2.spawn('rzD', { controls, simWorker: false });
    for (const p of [e, c, d]) { p.eval('startSoloGame();'); p.eval('{ const f = getPlayerPopCap; getPlayerPopCap = p => f(p) + 100000; }'); }
    const r2 = JSON.parse(e.eval(`JSON.stringify((() => {
        const ids = [];
        for (let i = 0; i < 6400; i++) { const gx = 10 + (i % 100), gy = 20 + Math.floor(i / 100); if (grid[gy][gx].type === TYPE_WALL) continue; const u = new Unit('norm', 0, gx * TILE + 16, gy * TILE + 16); u.stackCount = 4; units.push(u); unitSlotMapPushed(u); ids.push(u.id); }
        for (let t = 0; t < 3; t++) gameTick();
        const before = units.filter(u => u && !u.dead && u.owner === 0).length;
        processActions([{ action: 'resizeUnitGroup', unitIds: ids, mode: 'x2', bySub: true, byLevel: false }], 0);
        let k = 0;
        while (_rzJob !== null && !(_rzJob.cs >= 2) && k < 20) { gameTick(); k++; }
        const mid = units.filter(u => u && !u.dead && u.owner === 0).length;
        const parts = _rzJob ? _rzJob.parts.length : 0, cs = _rzJob ? _rzJob.cs : -1;
        __scratch.saved = JSON.stringify(snapEncodeState());
        return { before, mid, parts, cs };
    })())`));
    assert.ok(r2.parts >= 2 && r2.cs === 2 && r2.mid > r2.before, 'snapshot in the middle of the commit ' + JSON.stringify(r2));
    d.scratch.saved = e.scratch.saved; c.scratch.saved = e.scratch.saved;
    c.eval('snapDecodeState(JSON.parse(__scratch.saved))'); d.eval('snapDecodeState(JSON.parse(__scratch.saved))');
    const hc = [], hd = [];
    for (let t = 0; t < 20; t++) { c.eval('gameTick()'); d.eval('gameTick()'); hc.push(c.eval('computeLockstepStateHashFast(gameTime)')); hd.push(d.eval('computeLockstepStateHashFast(gameTime)')); }
    const nc = c.eval('units.filter(u => u && !u.dead && u.owner === 0).length'), nd = d.eval('units.filter(u => u && !u.dead && u.owner === 0).length');
    assert.ok(nc > r2.mid, 'the rest of the units made after the restore: ' + r2.mid + ' -> ' + nc);
    assert.equal(nd, nc, 'both made the same units');
    assert.deepEqual(hd, hc, 'two peers restored in the middle of the commit stay equal');
    for (const p of [c, d]) { const au = JSON.parse(p.eval('JSON.stringify({ slabs: simUnitSlabAudit(), occ: occupancyAudit(), job: _rzJob === null })')); assert.ok(au.slabs.ok && au.occ.ok && au.job, 'slot books, occupancy, done ' + JSON.stringify(au)); }
    assert.deepEqual([...e.errors, ...c.errors, ...d.errors].map(String), []);
    console.log('PASS: staged q / e through a snapshot in its commit', JSON.stringify({ ...r2, after: nc }));
}
