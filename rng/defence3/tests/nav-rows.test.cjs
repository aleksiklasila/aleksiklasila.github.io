// Destination rows (flownav.js _navFieldRow) depend on the destination's
// part alone (and the field's width), so fields share them (_navFieldsMake:
// one search per part, copies for the rest): every field's row, computed or
// copied, equals its own search, for many destinations on several maps,
// narrow and wide, before and after a rebuild. A rebuild makes the live
// fields over the new build in its window (_navNext: a background batch,
// and the fields asked for in the window over both builds), installed with
// it: every field (asked for before, in the window, after) then holds the
// new build's field and row. With real helper threads (3) and none.
//   node tests/nav-rows.test.cjs
'use strict';
globalThis.self = { crossOriginIsolated: true };
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
for (const helpers of [3, 0]) for (const [map, seed] of [['crossroads', 3], ['islands', 5], ['arena', 9]]) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '120', 'cfg-map-type': map } });
    const inst = world.spawn('rows' + map + helpers, { simWorker: false });
    inst.eval('startSoloGame();');
    if (helpers) {
        inst.scratch.Worker = require('./real-sim-helper.cjs');
        assert.equal(inst.eval(`Worker = __scratch.Worker; navigator.hardwareConcurrency = 32; simParallelInit('', ${helpers})`), helpers);
    }
    const r = JSON.parse(inst.eval(`JSON.stringify((() => {
        let s = ${seed};
        const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        gameTick();
        const ask = () => {
            const ids = [];
            for (let i = 0; i < 300; i++) {
                const t = navApproachTile(0, Math.floor(rnd() * GRID_H) * GRID_W + Math.floor(rnd() * GRID_W));
                if (t >= 0) ids.push(navFieldRequest(0, t, (i & 3) === 0));
            }
            // (Made by the next flush but one.)
            gameTick(); gameTick();
            return ids;
        };
        const check = ids => {
            let fields = 0, bad = '', shared = 0;
            const keys = new Map(), nav = _nav[0];
            for (const id of ids) {
                const F = _navFieldPool(id), i = _navFieldIndex(id), m = i * NAV_FIELD_META, RW = F.rowW, size = F.span * F.span, off = i * size;
                if (F.meta[m] !== 0) continue;
                if (F.meta[m + 7] !== 1) { bad = 'field ' + id + ' not made'; break; }
                // Its field: the installed build's.
                const own = new Uint16Array(size).fill(NAV_UNREACHED);
                _navLocalFieldDial(own, 0, F.meta[m + 2], F.meta[m + 3], nav.W, nav.H, F.meta[m + 1], nav.wall, nav.cost && nav.cost.length ? nav.cost : null, F.meta[m + 4], F.meta[m + 5], _navDialScratch(size));
                for (let k = 0; k < size; k++) if (own[k] !== F.pool[off + k]) { bad = 'field ' + id + ' tile ' + k + ': ' + F.pool[off + k] + ' vs ' + own[k]; break; }
                if (bad) break;
                const mine = new Uint8Array(RW);
                _navFieldRow(_simParReg, 0, F.pool, off, F.meta, m, mine, 0);
                for (let p = 0; p < nav.np; p++) if (mine[p] !== F.rows[i * RW + p]) { bad = 'field ' + id + ' part ' + p + ': ' + F.rows[i * RW + p] + ' vs ' + mine[p]; break; }
                if (bad) break;
                const k = (F.wide ? 'w' : 'n') + F.rowKeyOf[i];
                keys.set(k, (keys.get(k) || 0) + 1);
                fields++;
            }
            for (const n of keys.values()) if (n > 1) shared += n - 1;
            return { fields, shared, bad };
        };
        const before = ask(), first = check(before);
        // A rebuild: walls changed; fields asked for in its window; installed.
        for (let i = 0; i < 40; i++) { const x = 2 + Math.floor(rnd() * (GRID_W - 4)), y = 2 + Math.floor(rnd() * (GRID_H - 4)), c = grid[y][x];
            if (c.item || getTileEntityRef(x, y)) continue; c.type = c.type === TYPE_WALL ? TYPE_FLOOR : TYPE_WALL; simMoveTileTypeChanged(x, y); }
        const seq = _nav[0].seq;
        let n = 0;
        while (!_navNext.nav && n++ < NAV_BUILD_TICKS) gameTick();
        const opened = !!_navNext.nav, during = ask(), stillOpen = !!_navNext.nav;
        while (_navNext.nav && n++ < 2 * NAV_BUILD_TICKS) gameTick();
        gameTick();
        const installed = _nav[0].seq !== seq, after = ask();
        return { first, opened, stillOpen, installed, before: check(before), during: check(during), after: check(after), parts: _nav[0].np };
    })())`));
    assert.equal(r.first.bad, '', map + ' before: ' + r.first.bad);
    assert.ok(r.opened && r.stillOpen && r.installed, map + ': the rebuild window opened, fields were asked for in it, the build was installed');
    for (const k of ['before', 'during', 'after']) assert.equal(r[k].bad, '', map + ' after a rebuild (asked ' + k + '): ' + r[k].bad);
    assert.ok(r.first.fields > 100 && r.before.fields > 100 && r.during.fields > 100 && r.after.fields > 100, map + ': fields checked');
    console.log(map + ' (' + helpers + ' helpers): ' + r.parts + ' parts; fields and rows equal their own: ' + r.first.fields + ' before the rebuild, then ' + r.before.fields + ' / ' + r.during.fields + ' / ' + r.after.fields
        + ' asked before / in its window / after (' + r.first.shared + ' / ' + r.after.shared + ' rows shared)');
}
console.log('PASS: destination fields and shared rows equal their own searches, across a rebuild window');
process.exit(0);
