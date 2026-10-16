// The state hash takes every mine every hash as its region's sum of the
// mines' terms, kept by the structure table as amounts change
// (data_state.js _stMineTerm, mineSum): the same sums as each mine's term
// added there (the hash as it was). Checked from scratch after mining,
// mines depleted and placed, and a restore.
//   node tests/mine-region-sums.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const CHECK = `JSON.stringify((() => {
    const T = _ST, want = new Map();
    for (let i = 0; i < T.mineN; i++) {
        const tl = T.mineArr[i], gx = tl % GRID_W, gy = (tl - gx) / GRID_W, v = T.val[tl];
        let h = ((Math.imul(gx, 4099) + gy) ^ T.code[tl]) ^ 0x6d1;
        h = (v | 0) === v ? Math.imul(h ^ v, 16777619) : _snapHNum(h, v);
        const r = _stRegion(tl);
        want.set(r, ((want.get(r) || 0) + (Math.imul(h ^ (h >>> 15), 2246822519) >>> 0)) | 0);
    }
    const bad = [];
    const listed = new Set();
    for (let k = 0; k < T.mineRegN; k++) listed.add(T.mineRegArr[k]);
    for (const [r, s] of want) { if (T.mineSum[r] !== s) bad.push('sum ' + r + ': ' + T.mineSum[r] + ' vs ' + s); if (!listed.has(r)) bad.push('unlisted ' + r); }
    for (const r of listed) if (!want.has(r)) bad.push('listed without mines ' + r);
    let mines = goldMines.length + astarMines.length;
    return { mines, tableMines: T.mineN, regions: listed.size, bad: bad.slice(0, 8) };
})())`;

(async () => {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '40', 'cfg-gold-count': '20', 'cfg-astar-mine-count': '12' } });
    const inst = world.spawn('mines', { simWorker: false });
    inst.eval('startSoloGame();');
    await world.run(1000);
    const a = JSON.parse(inst.eval(CHECK));
    assert.ok(a.mines > 10 && a.tableMines === a.mines, 'the mines are in the table: ' + JSON.stringify(a));
    assert.deepEqual(a.bad, [], 'at the start');
    // Mined: amounts down (collectors, and directly), one depleted.
    await world.run(15000);
    inst.eval(`(() => { const m = goldMines[0]; m.gold = Math.max(0, m.gold - 77.5); const m2 = astarMines[0]; if (m2) m2.astar = 3; })()`);
    await world.run(500);
    const b = JSON.parse(inst.eval(CHECK));
    assert.deepEqual(b.bad, [], 'after mining: ' + JSON.stringify(b));
    // A mine removed and one placed elsewhere.
    inst.eval(`(() => { const m = goldMines[goldMines.length - 1]; clearTileEntity(m.gx, m.gy, m); goldMines.splice(goldMines.indexOf(m), 1); })()`);
    const c = JSON.parse(inst.eval(CHECK));
    assert.deepEqual(c.bad, [], 'after a removal: ' + JSON.stringify(c));
    assert.equal(c.tableMines, b.tableMines - 1, 'one fewer');
    // A restore of the match's own snapshot.
    inst.eval(`applyAuthoritativeStateSnapshot(JSON.parse(JSON.stringify(buildHostAuthoritativeStateSnapshot({ includeConfig: false, includeStaticMapState: true, includeGridTypes: true }))))`);
    const d = JSON.parse(inst.eval(CHECK));
    assert.deepEqual(d.bad, [], 'after a restore: ' + JSON.stringify(d));
    assert.equal(d.tableMines, c.tableMines, 'the same mines');
    await world.run(3000);
    const e = JSON.parse(inst.eval(CHECK));
    assert.deepEqual(e.bad, [], 'later: ' + JSON.stringify(e));
    assert.deepEqual(inst.errors.map(x => String(x && x.message || x).slice(0, 200)), []);
    console.log('PASS mine-region-sums (' + a.mines + ' mines, ' + a.regions + ' regions)');
})().catch(e => { console.error(e); process.exit(1); });
