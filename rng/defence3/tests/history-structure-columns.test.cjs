// Team + history beside the simulation worker: the remembered structures
// are columns over the page's structure table (visibility_history.js
// historyStructureFrame), slot by slot in the table's own types. In a running
// match (the simulation in its worker, the page on the worker's tables):
// every structure seen now is its table row exactly and its live view, every
// other row of the frame is either the table's (hidden where nothing sees, as
// with Team) or a ghost; the renderer takes that frame; a pass with nothing
// new changes nothing (no upload).
//   node tests/history-structure-columns.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

(async () => {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '40', 'cfg-full-vis': 'history' } });
    world.simWorker = true;
    const inst = world.spawn('page');
    inst.eval('startSoloGame();');
    await world.run(4000);
    const r = JSON.parse(inst.eval(`JSON.stringify((() => {
        const h = visibilityHistoryState, view = getLiveRenderView(), F = _structureRenderFrame(view), T = _pageTables.s;
        const out = { page: !simClientActive() ? 'page simulates' : 'worker', history: teamVisibilityHistory, columns: !!view.historyColumns,
            same: F === historyStructureFrame(h), n: F && F.n, tn: T && T.n, seen: 0, ghosts: 0, hidden: 0, diffs: [], typed: [] };
        if (!F) return out;
        const L = h.light._flat;
        for (const k of HISTORY_COLUMNS) if (F[k].constructor !== T[k].constructor) out.typed.push(k);
        for (let s = 0; s < F.n; s++) {
            if (F.flags[s] & HISTORY_GHOST_FLAG) { out.ghosts++; continue; }
            if (s >= T.n) { out.diffs.push('past the slots, not a ghost: ' + s); continue; }
            for (const k of HISTORY_COLUMNS) if (!Object.is(F[k][s], T[k][s])) out.diffs.push(k + '@' + s + ': ' + F[k][s] + ' vs ' + T[k][s]);
            const present = T.alive[s] && T.kind[s] !== 6 && (T.kind[s] >= 4 || T.energy[s] > 0);
            if (!present) continue;
            if (L[T.gy[s] * GRID_W + T.gx[s]] > 0) { out.seen++; if (F.sources[s] !== _pageStructViews[s]) out.diffs.push('source@' + s); }
            else out.hidden++;
        }
        const ver = F.ver;
        visibilityVersion++;
        out.unchanged = historyStructureFrame(h).ver === ver;
        // A structure seen now put out of sight (its tile's light, here):
        // its row as last seen, a ghost, its source a frozen copy of its
        // view; in sight again: the live row and view.
        let s = -1;
        for (let q = 0; q < T.n && s < 0; q++) if (T.alive[q] && T.kind[q] < 4 && T.energy[q] > 0 && L[T.gy[q] * GRID_W + T.gx[q]] > 0) s = q;
        if (s >= 0) {
            const i = T.gy[s] * GRID_W + T.gx[s], was = L[i], row = HISTORY_COLUMNS.map(k => T[k][s]);
            L[i] = 0; visibilityVersion++;
            const G = historyStructureFrame(h), snap = G.sources[s];
            out.ghost = { flag: !!(G.flags[s] & HISTORY_GHOST_FLAG), alive: G.alive[s], ghost: !!(snap && snap._historyGhost),
                type: snap && snap.type === _pageStructViews[s].type, energy: snap && snap.energy === T.energy[s], ver: G.ver > ver,
                row: HISTORY_COLUMNS.filter((k, c) => k !== 'flags' && !Object.is(G[k][s], row[c])) };
            L[i] = was; visibilityVersion++;
            const B = historyStructureFrame(h);
            out.back = { flag: !!(B.flags[s] & HISTORY_GHOST_FLAG), source: B.sources[s] === _pageStructViews[s] };
        }
        return out;
    })())`));
    console.log(JSON.stringify(r));
    assert.equal(r.page, 'worker', "the page draws from the worker's tables");
    assert.ok(r.history && r.columns, 'Team + history, the columns view');
    assert.ok(r.same, 'the renderer takes the remembered columns');
    assert.ok(r.seen >= 2, 'structures seen now: ' + r.seen);
    assert.ok(r.n >= r.tn, 'every slot of the table');
    assert.deepEqual(r.typed, [], "the table's own column types");
    assert.deepEqual(r.diffs.slice(0, 10), [], 'what is not remembered is the table row as it is');
    assert.ok(r.unchanged, 'nothing new: no new version (no upload)');
    assert.deepEqual(r.ghost, { flag: true, alive: 1, ghost: true, type: true, energy: true, ver: true, row: [] }, 'out of sight: remembered as last seen');
    assert.deepEqual(r.back, { flag: false, source: true }, 'in sight again: the live row and view');
    console.log('PASS history-structure-columns');
})().catch(e => { console.error(e); process.exit(1); });
