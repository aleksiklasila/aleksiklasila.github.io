// Destination rows (wasm/src/lib.rs nav_field) depend on the destination's
// part alone (and the field's width), so fields share them (_navFieldsMake:
// one search per part, copies for the rest): every field's row, computed or
// copied, equals its own search, for many destinations on several maps,
// narrow and wide, before and after a rebuild. A rebuild makes the live
// fields over the new build in its window (_navNext: a background batch,
// and the fields asked for in the window over both builds), installed with
// it: every field (asked for before, in the window, after) then holds the
// new build's field and row; the same when the pools grow while a window
// is open (the next build's pools grown too, copied on the helpers:
// _navNextCopyFlush). With real helper threads (3) and none.
//   node tests/nav-rows.test.cjs
'use strict';
globalThis.self = { crossOriginIsolated: true };
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
// (The install's side: 0 the smaller copy, 1 the next arrays installed, -1
// the rebuilt profile's fields copied: flownav.js NAV_INSTALL_SIDE.)
for (const [helpers, side] of [[3, 0], [3, 1], [0, -1], [0, 1]]) for (const [map, seed] of [['crossroads', 3], ['islands', 5], ['arena', 9]]) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '120', 'cfg-map-type': map } });
    const inst = world.spawn('rows' + map + helpers, { simWorker: false });
    inst.eval('startSoloGame(); NAV_INSTALL_SIDE = ' + side + ';');
    if (helpers) {
        inst.scratch.Worker = require('./real-sim-helper.cjs');
        assert.equal(inst.eval(`Worker = __scratch.Worker; navigator.hardwareConcurrency = 32; simParallelInit('', ${helpers})`), helpers);
    }
    const r = JSON.parse(inst.eval(`JSON.stringify((() => {
        let s = ${seed};
        const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        gameTick();
        const PROFS = [NAV_PROFILE_GROUND, NAV_PROFILE_COLLECT, NAV_PROFILE_BUILD0].filter(p => _nav[p]);
        const ask = () => {
            const ids = [];
            for (let i = 0; i < 300; i++) {
                // (Ground, collectors, player 0's builders by turns: a rebuild
                // of one profile keeps the others' fields.)
                const pr = PROFS[i % PROFS.length];
                const t = navApproachTile(pr, Math.floor(rnd() * GRID_H) * GRID_W + Math.floor(rnd() * GRID_W));
                if (t >= 0) ids.push(navFieldRequest(pr, t, (i & 3) === 0));
            }
            // (Made by the next flush but one.)
            gameTick(); gameTick();
            return ids;
        };
        const check = ids => {
            let fields = 0, bad = '', shared = 0; const profiles = {};
            const keys = new Map();
            for (const id of ids) {
                const F = _navFieldPool(id), i = _navFieldIndex(id), m = i * NAV_FIELD_META, RW = F.rowW, size = F.span * F.span, off = i * size;
                const pr = F.meta[m], nav = _nav[pr];
                if (!(pr >= 0) || !nav) continue;
                if (F.meta[m + 7] !== 1) { bad = 'field ' + id + ' not made'; break; }
                // Its field: the installed build's.
                // (Its own search: the Rust kernel again, into fresh heap arrays.)
                const own = simHeapArray(Uint16Array, size), mine = simHeapArray(Uint8Array, RW);
                _navFieldRust(_simParReg, 'nav.', pr, _simHeapPtrOf(own), 0, size, F.meta, m, _simHeapPtrOf(mine), 0, nav.W, nav.H);
                for (let k = 0; k < size; k++) if (own[k] !== F.pool[off + k]) { bad = 'field ' + id + ' tile ' + k + ': ' + F.pool[off + k] + ' vs ' + own[k]; break; }
                if (bad) break;
                for (let p = 0; p < nav.np; p++) if (mine[p] !== F.rows[i * RW + p]) { bad = 'field ' + id + ' part ' + p + ': ' + F.rows[i * RW + p] + ' vs ' + mine[p]; break; }
                if (bad) break;
                const k = (F.wide ? 'w' : 'n') + F.rowKeyOf[i];
                keys.set(k, (keys.get(k) || 0) + 1);
                fields++; profiles[pr] = (profiles[pr] || 0) + 1;
            }
            for (const n of keys.values()) if (n > 1) shared += n - 1;
            return { fields, shared, bad, profiles };
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
        const r = { first, opened, stillOpen, installed, before: check(before), during: check(during), after: check(after), parts: _nav[0].np };
        // The other profiles' rebuilds (the walls changed for them too), one
        // after another: every field of every profile still its own search.
        const seqs = PROFS.map(p => _nav[p].seq);
        while ((_navJob || PROFS.some(p => _navDiff[p] > 0)) && n++ < 8 * NAV_BUILD_TICKS) gameTick();
        gameTick();
        r.rebuilt = PROFS.filter((p, k) => _nav[p].seq !== seqs[k]);
        r.final = check([...before, ...during, ...after, ...ask()]);
        // Pools grown (in the background, swapped at a flush: flownav.js
        // _navGrowPlan): every field before and after still its own search.
        const caps0 = _navFields.pools.map(F => F.cap), more = [];
        for (let k = 0; k < 6; k++) more.push(...ask());
        for (let k = 0; k < 4; k++) gameTick();
        r.grown = _navFields.pools.map((F, w) => F.cap > caps0[w]);
        r.afterGrowth = check([...before, ...during, ...after, ...more]);
        // Pools grown while a rebuild's window is open: the next build's
        // pools grow with them, their made fields copied on the helpers
        // (_navNextCopyFlush); every field still its own search after the
        // install.
        for (let i = 0; i < 40; i++) { const x = 2 + Math.floor(rnd() * (GRID_W - 4)), y = 2 + Math.floor(rnd() * (GRID_H - 4)), c = grid[y][x];
            if (c.item || getTileEntityRef(x, y)) continue; c.type = c.type === TYPE_WALL ? TYPE_FLOOR : TYPE_WALL; simMoveTileTypeChanged(x, y); }
        let m = 0;
        while (!_navNext.nav && m++ < 4 * NAV_BUILD_TICKS) gameTick();
        const realFlush = _navNextCopyFlush;
        let nextCopies = 0;
        _navNextCopyFlush = function () { if (_navNext.copyPairs && _navNext.copyPairs.length) nextCopies++; return realFlush.apply(this, arguments); };
        const caps1 = _navFields.pools.map(F => F.cap), more2 = [];
        for (let k = 0; k < 40 && _navNext.nav && !nextCopies; k++) { more2.push(...ask()); gameTick(); }
        while (_navNext.nav && m++ < 8 * NAV_BUILD_TICKS) gameTick();
        gameTick();
        _navNextCopyFlush = realFlush;
        r.nextCopies = nextCopies;
        r.grownInWindow = _navFields.pools.some((F, w) => F.cap > caps1[w]);
        r.afterWindowGrowth = check([...before, ...during, ...after, ...more, ...more2]);
        return r;
    })())`));
    assert.equal(r.first.bad, '', map + ' before: ' + r.first.bad);
    assert.ok(r.opened && r.stillOpen && r.installed, map + ': the rebuild window opened, fields were asked for in it, the build was installed');
    for (const k of ['before', 'during', 'after']) assert.equal(r[k].bad, '', map + ' after a rebuild (asked ' + k + '): ' + r[k].bad);
    assert.equal(r.final.bad, '', map + ' after the other profiles\' rebuilds: ' + r.final.bad);
    assert.ok(r.grown[0], map + ': the narrow pool grew');
    assert.equal(r.afterGrowth.bad, '', map + ' after the pools grew: ' + r.afterGrowth.bad);
    assert.ok(r.grownInWindow && r.nextCopies > 0, map + ': the pools grew in a rebuild window, the next build\'s copied (' + r.nextCopies + ')');
    assert.equal(r.afterWindowGrowth.bad, '', map + ' after the pools grew in a rebuild window: ' + r.afterWindowGrowth.bad);
    assert.ok(r.rebuilt.length >= 2, map + ': more profiles rebuilt (' + JSON.stringify(r.rebuilt) + ')');
    assert.ok(Object.keys(r.final.profiles).length >= 2, map + ': fields of several profiles checked ' + JSON.stringify(r.final.profiles));
    assert.ok(r.first.fields > 100 && r.before.fields > 100 && r.during.fields > 100 && r.after.fields > 100, map + ': fields checked');
    console.log(map + ' (' + helpers + ' helpers, install side ' + side + '): ' + r.parts + ' parts; fields and rows equal their own: ' + r.first.fields + ' before the rebuild, then ' + r.before.fields + ' / ' + r.during.fields + ' / ' + r.after.fields
        + ' asked before / in its window / after (' + r.first.shared + ' / ' + r.after.shared + ' rows shared); profiles rebuilt ' + JSON.stringify(r.rebuilt) + ', then ' + r.final.fields + ' fields ' + JSON.stringify(r.final.profiles));
}
console.log('PASS: destination fields and shared rows equal their own searches, across a rebuild window');
process.exit(0);
