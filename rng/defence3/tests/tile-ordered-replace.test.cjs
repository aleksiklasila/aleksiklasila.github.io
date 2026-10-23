'use strict';
// The tile-ordered lists' batch update (data_state.js _tileOrderedReplaceMany) equals the replacements one by one, and leaves the list itself when
// nothing changed.
const assert = require('node:assert/strict'), H = require('./net-harness.cjs');
const world = new H.World({ controls: H.SMALL_MATCH_CONTROLS }), inst = world.spawn('tor', { simWorker: false });
const result = JSON.parse(inst.eval(`JSON.stringify((() => {
    let seed = 99; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const W = GRID_W, H = GRID_H, ents = new Map(), key = (x, y) => y * W + x, mk = t => ({ gx: t % W, gy: Math.floor(t / W), id: t });
    let bad = 0, same = 0, rounds = 0;
    for (let round = 0; round < 300; round++) {
        // a list of random entities in tile order, a batch of distinct ascending tiles each added, replaced or removed
        const n = Math.floor(rnd() * 60), set = new Set();
        while (set.size < n) set.add(Math.floor(rnd() * W * H));
        const tiles0 = [...set].sort((a, b) => a - b), list = tiles0.map(mk);
        const m = Math.floor(rnd() * 12), ch = new Set();
        while (ch.size < m) ch.add(Math.floor(rnd() * W * H));
        if (rnd() < 0.3) for (let i = 0; i < Math.min(3, list.length); i++) ch.add(key(list[Math.floor(rnd() * list.length)].gx, list[Math.floor(rnd() * list.length)].gy));
        const tiles = [...ch].sort((a, b) => a - b), now = new Map();
        for (const t of tiles) { const r = rnd(); const old = list.find(e => key(e.gx, e.gy) === t); now.set(t, r < 0.35 ? null : r < 0.5 && old ? old : mk(t)); }
        let one = list;
        for (const t of tiles) one = _tileOrderedReplace(one, t, now.get(t));
        const many = _tileOrderedReplaceMany(list, tiles, t => now.get(t));
        const ok = one.length === many.length && one.every((e, i) => e === many[i]) && many.every((e, i) => i === 0 || key(many[i - 1].gx, many[i - 1].gy) < key(e.gx, e.gy));
        if (!ok) bad++;
        if (tiles.every(t => { const old = list.find(e => key(e.gx, e.gy) === t); return now.get(t) === (old || null); })) { if (many !== list) bad++; same++; }
        rounds++;
    }
    return { bad, same, rounds, empty: _tileOrderedReplaceMany([], [], () => null).length };
})())`));
assert.equal(result.bad, 0, 'batch update differs from one by one: ' + JSON.stringify(result));
assert.ok(result.same >= 0 && result.rounds === 300);
console.log('PASS: batch tile-ordered update equals the one-by-one replacements', JSON.stringify(result));
