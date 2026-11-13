'use strict';
// Expired structure rows (data_state.js _sRowsFree: the heap columns by the
// wasm kernel k_rows_fill, vector stores over the row runs; the JavaScript
// reference columns here) end exactly as never-used rows: every column, the
// shared columns' values, the tokens, the token entries, the row's object.
// Rows in runs and alone, at the ends of runs, of towers and barracks.
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const w = new H.World({ controls: H.SMALL_MATCH_CONTROLS }), i = w.spawn('rows-fill', { simWorker: false });
const out = JSON.parse(i.eval(`(() => {
    startSoloGame();
    const spots = [];
    for (let gy = 2; gy < GRID_H - 2 && spots.length < 400; gy += 3) for (let gx = 2; gx < GRID_W - 2 && spots.length < 400; gx += 3)
        if (!getTileEntityRef(gx, gy) && cellType[(grid[gy][gx]) - 1] !== TYPE_WALL) spots.push([gx, gy]);
    const res = [];
    for (const [type, C, from] of [['pistol', Tower, 0], ['barrack_norm', Barrack, 1]]) {
        const T = _sTables.get(C);
        const built = spots.filter((_, k) => k % 2 === from).slice(0, 45).map(([gx, gy]) => { placeBuilding(gx, gy, type, 0, { silent: true, ignorePlacementRules: true }); return getTileEntityRef(gx, gy); }).filter(Boolean);
        // (Values in every column the structures have: energy, statuses, labels.)
        for (const b of built) { b.energy = 7; if ('burning' in b) b.burning = 9; b._levelTextLabel = 'x'; }
        // (Every other one, then a run: rows alone and in runs.)
        const gone = built.filter((b, k) => k % 2 === 0 || k > 30);
        const rows = gone.map(b => b._sr);
        for (const b of gone) destroyBuilding(b);
        gameTime += STRUCT_ROW_KEEP_TICKS + STRUCT_ROW_STAGGER_TICKS; structRowsExpire();
        const fresh = T.cap - 1;
        const bad = [];
        const same = (a, b) => Object.is(a, b);
        for (const r of rows) {
            for (const f of T.fields) {
                const a = T[f.col], x = f.shared ? a.get(r) : a[r], y = f.shared ? a.get(fresh) : a[fresh];
                if (!same(x, y)) bad.push([f.name, r, String(x), String(y)]);
            }
            for (let k = 0; k < 3; k++) { if (T.mTok[r * 3 + k] !== T.mTok[fresh * 3 + k]) bad.push(['mTok', r]); if (T.mEnt[r * 3 + k] !== undefined) bad.push(['mEnt', r]); }
            if (T.rowObj[r] !== null) bad.push(['rowObj', r]);
        }
        // (A live row next to the cleared ones keeps its values.)
        const live = built.find(b => !gone.includes(b));
        res.push({ type, rows: rows.length, bad: bad.slice(0, 10), liveEnergy: live ? live.energy : null });
    }
    return JSON.stringify(res);
})()`));
for (const r of out) {
    assert.ok(r.rows >= 5, JSON.stringify(r));
    assert.deepEqual(r.bad, [], r.type + ': expired rows differ from fresh ones: ' + JSON.stringify(r.bad));
    assert.equal(r.liveEnergy, 7, r.type + ': a live row beside them kept its values');
}
assert.deepEqual(i.errors, []);
console.log('PASS: expired structure rows equal fresh rows in every column ' + JSON.stringify(out.map(r => [r.type, r.rows])));
