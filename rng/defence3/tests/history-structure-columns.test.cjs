// A remembered view's structure columns (Team + history: renderer.js
// _structureRenderFrame, _historyStructureFill) read a live structure from
// the page's table columns, not through its view's accessors (most of the
// time of the per-tick refresh): the same values as the accessors give, for
// every structure of a running match (the simulation in its worker, the
// page on the worker's tables).
//   node tests/history-structure-columns.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

(async () => {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '40' } });
    world.simWorker = true;
    const inst = world.spawn('page');
    inst.eval('startSoloGame();');
    await world.run(4000);
    const r = JSON.parse(inst.eval(`JSON.stringify((() => {
        const lists = [[towers, 0], [barracks, 1], [collectorSpawners, 2], [goldMines, 4], [astarMines, 5]];
        const n = lists.reduce((a, [l]) => a + l.length, 0), mk = () => { const F = {}; for (const f of ['alive','energy','owner','flags','type','utype','vision','angle','amount']) F[f] = new Float32Array(n); return F; };
        const fast = mk(), slow = mk(), codes = new Map(_pageFrameStrings.map((s, i) => [s, i])), view = { grid };
        let s = 0, viaTable = 0;
        for (const [list, kind] of lists) for (const e of list) {
            if (e._structView && e._s >= 0 && !e._det) viaTable++;
            _historyStructureFill(fast, s, e, kind, view, codes);
            // (Through the accessors: the same view, not marked a table view.)
            const a = Object.create(e); Object.defineProperty(a, '_structView', { value: false });
            _historyStructureFill(slow, s, a, kind, view, codes);
            s++;
        }
        const diffs = [];
        for (const f of Object.keys(fast)) for (let i = 0; i < n; i++) if (!Object.is(fast[f][i], slow[f][i])) diffs.push(f + '@' + i + ': ' + fast[f][i] + ' vs ' + slow[f][i]);
        return { n, viaTable, diffs: diffs.slice(0, 10), page: !simClientActive() ? 'page simulates' : 'worker' };
    })())`));
    console.log(JSON.stringify(r));
    assert.equal(r.page, 'worker', "the page draws from the worker's tables");
    assert.ok(r.n > 5 && r.viaTable === r.n, 'every structure read from the table: ' + r.viaTable + ' of ' + r.n);
    assert.deepEqual(r.diffs, [], 'the same values as the accessors');
    console.log('PASS history-structure-columns');
})().catch(e => { console.error(e); process.exit(1); });
