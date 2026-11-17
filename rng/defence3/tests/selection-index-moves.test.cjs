'use strict';
// The page's selection index (hud.js _selIndex: the live selected units' slots, a mask a slot, their places) kept
// through deaths (selectionNoteDead: the dead entry taken out) and the simulation's slot moves (selectionSlotsMoved:
// the selected movers' bits and entries follow them, chains and moves into a dead unit's slot included) equals the
// index made anew from the selection's views (selectionIndex after a remap), frame after frame; and the compaction
// leaves the selection's live units, each once.
// Usage: node tests/selection-index-moves.test.cjs
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const hud = fs.readFileSync('src/audio_visual/hud.js', 'utf8');
const a = hud.indexOf('// ---- the selection by the frame\'s slots ----'), b = hud.indexOf('// Whether a unit group (the frame\'s type code');
assert.ok(a > 0 && b > a, 'the selection block of hud.js');
const ctx = vm.createContext({ Int32Array, Uint8Array, Math, performance, Map, Set, Array, Object, selectedUnits: [], frame: null, views: [] });
vm.runInContext(hud.slice(a, b) + `
;var simClientCurrentUnitVis = () => frame, _pageSlotViews = views, _pageUnitsById = new Map(), infoPanelSelectionCompacted = null;
this.api = { selectionIndex, selectionNoteDead, selectionSlotsMoved, selectionIndexRemapped, selectionCompactDead, X: _selIndex,
    sel: () => selectedUnits, setSel: v => { selectedUnits = v; } };`, ctx);
const { api } = ctx;
let seed = 11;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
const CAP = 4096;
ctx.frame = { cap: CAP, n: CAP };
// Views: one a unit, at its slot (u._s), framed.
const views = ctx.views;
let nextId = 1;
const units = [];
const place = (u, s) => { u._s = s; views[s] = u; };
for (let s = 0; s < 3000; s++) { const u = { id: nextId++, _s: s, dead: false, _frameView: true }; units.push(u); place(u, s); }
const selected = units.filter(() => rnd() < 0.6);
api.setSel(selected.slice());
api.selectionIndex();
const check = (label) => {
    const X = api.X;
    const live = new Set(api.sel().filter(u => !u.dead).map(u => u._s));
    const listed = Array.from(X.slots.subarray(0, X.n));
    assert.equal(new Set(listed).size, listed.length, label + ': a slot listed twice');
    assert.deepEqual(new Set(listed), live, label + ': the listed slots are the live selected units\' slots');
    for (let s = 0; s < CAP; s++) assert.equal(X.mask[s] === 1, live.has(s), label + ': mask at ' + s);
    for (let j = 0; j < X.n; j++) assert.equal(X.pos[X.slots[j]], j, label + ': place of slot ' + X.slots[j]);
};
check('start');
for (let frameNo = 0; frameNo < 400; frameNo++) {
    // Deaths: their slots freed (the frame's membership: the page notes each).
    const alive = units.filter(u => !u.dead);
    for (let k = 0; k < 8; k++) { const u = alive[Math.floor(rnd() * alive.length)]; if (u.dead) continue; u.dead = true; api.selectionNoteDead(u._s); views[u._s] = undefined; }
    // Moves: live units to free slots (often a dead one's), some chains (a unit into the slot another just left).
    const from = [], to = [];
    const free = []; for (let s = 0; s < CAP; s++) if (!views[s]) free.push(s);
    const movers = alive.filter(u => !u.dead && rnd() < 0.02);
    for (const u of movers) {
        if (!free.length) break;
        const t = free.splice(Math.floor(rnd() * free.length), 1)[0], s0 = u._s;
        views[s0] = undefined; free.push(s0);
        from.push(s0); to.push(t); place(u, t);
    }
    api.selectionSlotsMoved(Int32Array.from(from), Int32Array.from(to), from.length);
    // Births at free slots (never selected).
    for (let k = 0; k < 6; k++) { const fr = []; for (let s = 0; s < CAP; s++) if (!views[s]) fr.push(s); if (!fr.length) break; const s = fr[Math.floor(rnd() * fr.length)]; const u = { id: nextId++, dead: false, _frameView: true }; units.push(u); place(u, s); }
    check('frame ' + frameNo);
    if (frameNo % 50 === 49) {
        // The compaction: the live selected units, each once; the index current after it.
        api.selectionCompactDead(true);
        const sel = api.sel();
        assert.equal(sel.filter(u => u.dead).length, 0, 'compacted: no dead');
        assert.equal(new Set(sel).size, sel.length, 'compacted: each unit once');
        check('compacted ' + frameNo);
    }
}
// And a remap (a restore's) rebuilds the same.
const before = new Set(Array.from(api.X.slots.subarray(0, api.X.n)));
api.selectionIndexRemapped(); api.selectionIndex();
assert.deepEqual(new Set(Array.from(api.X.slots.subarray(0, api.X.n))), before, 'a rebuild lists the same slots');
console.log('PASS: the selection index follows deaths and slot moves (400 frames), each live selected unit once, as a rebuild');
