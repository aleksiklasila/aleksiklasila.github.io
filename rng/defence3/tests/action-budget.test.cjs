// A tick's actions, all of them whole at their tick (main.js processActions:
// no budget, nothing deferred): a burst of hundreds of actions leaves none
// waiting, in order (two move orders for the same units: the later one wins);
// a snapshot taken right after, restored on two peers, goes on equally (state
// hashes equal every tick). A big attack order gives every unit the order at
// once, in the order of its ids.
//   node tests/action-budget.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '160', 'cfg-map-type': 'arena' } });
const a = world.spawn('budgetA', { simWorker: false }), b = world.spawn('budgetB', { simWorker: false });
for (const inst of [a, b]) inst.eval('startSoloGame();');
const r = JSON.parse(a.eval(`JSON.stringify((() => {
    const ids = [];
    for (let i = 0; i < 3000; i++) { const gx = 20 + (i % 100), gy = 30 + Math.floor(i / 100); if (cellType[(grid[gy][gx]) - 1] === TYPE_WALL) continue; const u = new Unit('norm', 0, gx * TILE + 16, gy * TILE + 16); units.push(u); unitSlotMapPushed(u); ids.push(u.id); }
    for (let t = 0; t < 3; t++) gameTick();
    // The burst: 300 small actions (stops, holds of a unit each), then two
    // move orders of every unit (the second to another corner), then more.
    const acts = [];
    for (let i = 0; i < 300; i++) acts.push({ action: i & 1 ? 'hold' : 'stop', unitIds: [ids[i]] });
    acts.push({ action: 'move', unitIds: ids, targetX: 30 * TILE, targetY: 120 * TILE });
    acts.push({ action: 'move', unitIds: ids, targetX: 130 * TILE, targetY: 120 * TILE });
    for (let i = 0; i < 100; i++) acts.push({ action: 'stop', unitIds: [ids[300 + i]] });
    processActions(acts, 0);
    const waiting = _actionBacklog.length;
    // A snapshot while they wait.
    __scratch.saved = JSON.stringify(snapEncodeState());
    let ticks = 0;
    while (_actionBacklog.length && ticks < 20) { gameTick(); ticks++; }
    // (The orders' slices applied: ORDER_UNITS_PER_TICK_ALL a tick.)
    for (let t = 0; t < 4; t++) gameTick();
    const last = ids.slice(400).map(id => getUnitById(id)).filter(u => u && !u.dead);
    const west = last.filter(u => u.targetPos && u.targetPos.x < 80 * TILE).length, east = last.filter(u => u.targetPos && u.targetPos.x > 80 * TILE).length;
    return { waiting, ticks, units: last.length, east, west };
})())`));
console.log(JSON.stringify(r));
assert.equal(r.waiting, 0, 'no action waited');
assert.equal(r.ticks, 0, 'nothing left for later ticks');
assert.equal(r.west, 0, 'no unit kept the earlier move order');
assert.ok(r.east > r.units * 0.95, 'the later move order won: ' + r.east + ' of ' + r.units + ' units');
// A peer restored from the snapshot taken after the burst: the same
// ticks, the same states.
b.scratch.saved = a.scratch.saved;
a.eval('snapDecodeState(JSON.parse(__scratch.saved))');
b.eval('snapDecodeState(JSON.parse(__scratch.saved))');
const ha = [], hb = [];
for (let t = 0; t < 60; t++) {
    a.eval('gameTick()'); b.eval('gameTick()');
    ha.push(a.eval('computeLockstepStateHashFast(gameTime)')); hb.push(b.eval('computeLockstepStateHashFast(gameTime)'));
}
assert.equal(a.eval('_actionBacklog.length'), 0, 'restored: nothing waits');
assert.deepEqual(ha, hb, 'two peers restored from the snapshot stay equal');
const exact = [a, b].map(p => p.eval('__exactStateHash()'));
assert.equal(exact[0], exact[1], 'exact states equal');
// A big attack order, its ids as on the wire (uidz, counted exactly): every
// unit gets it at once, once, in order.
const sp = JSON.parse(a.eval(`JSON.stringify((() => {
    const mine = units.filter(u => !u.dead && u.owner === 0 && u.unitType === 'norm').map(u => u.id);
    const foe = new Unit('tank', 1, 150 * TILE + 16, 20 * TILE + 16); units.push(foe); unitSlotMapPushed(foe);
    gameTick();
    const uidz = actionIdsEncode(mine);
    // (The units of each part as it runs.)
    const got = [], real = processAction;
    processAction = function (act, pid) { if (act.action === 'attack') for (const id of act.unitIds) got.push(id); return real.apply(this, arguments); };
    processActions([{ action: 'attack', uidz, targetId: foe.id, targetX: foe.x, targetY: foe.y }], 0);
    const later = _actionBacklog.length ? _actionBacklog[0][1].unitIds.length : 0;
    let ticks = 0;
    while (_actionBacklog.length && ticks < 40) { gameTick(); ticks++; }
    processAction = real;
    return { n: mine.length, uidzChars: uidz.length, counted: actionIdsCount(uidz), later, ticks, ordered: got.length, once: new Set(got).size === got.length && got.every((id, i) => id === mine[i]) };
})())`));
console.log(JSON.stringify(sp));
assert.equal(sp.counted, sp.n, 'a uidz counts its ids exactly');
assert.equal(sp.later, 0, 'the attack order whole at once');
assert.equal(sp.ticks, 0, 'nothing of it later');
assert.equal(sp.ordered, sp.n, 'every unit of the order got it');
assert.ok(sp.once, 'once each, in the order of its ids');
console.log('PASS: a burst of actions runs whole at its tick, the later order wins, snapshots restore equally; a big attack order runs whole (' + sp.n + ' units)');
// A rally order goes whole when it comes (column writes), after an older
// snapshot's backlog: tile keys and coordinates alike.
const rally = JSON.parse(a.eval(`JSON.stringify((() => {
    resetOrderQueue();
    const keys = []; for (let i = 0; i < 5000; i++) keys.push(Math.floor(i / 100) * GRID_W + i % 100);
    const got = [], real = _rallySetTiles;
    _rallySetTiles = (x, p) => { const k = []; if (x.tkz) actionIdsForEach(x.tkz, 1e9, v => k.push(v)); else for (let i = 0; i < x.coords.length; i += 2) k.push(x.coords[i + 1] * GRID_W + x.coords[i]); got.push(k); };
    _actionBacklog.push([0, { action: 'hold', unitIds: [1, 2, 3] }, -5]);
    processActions([{ action: 'setRallyMany', tkz: actionIdsEncode(keys), targetX: 100, targetY: 200 }, { action: 'setRallyMany', coords: [3, 4], targetX: 1, targetY: 2 }], 0);
    _rallySetTiles = real;
    const waiting = _actionBacklog.length; resetOrderQueue();
    return { calls: got.length, all: got[0].length, ordered: got[0].every((v, i) => v === keys[i]), coords: got[1], waiting };
})())`));
assert.deepEqual(rally, { calls: 2, all: 5000, ordered: true, coords: [4 * a.eval("GRID_W") + 3], waiting: 0 }, 'rallies apply whole on arrival, an old backlog drained first');
console.log('PASS: rally orders apply whole on arrival');

const packedRally = JSON.parse(a.eval(`JSON.stringify((() => {
    const coords = [null, 2, -1, 3, 1.9, 2.1];
    for (let i = 0; i < 5100; i++) coords.push(i % GRID_W, 4);
    coords.push(7);
    const raw = { action: 'setRallyMany', coords, targetX: 10, targetY: 20 };
    const original = JSON.stringify(raw), lists = [[], []];
    let pass = 0;
    const run = _rallyKernelRun, set = _rallySetTile;
    _rallyKernelRun = n => { const ids = orderQueueReserve().ids; for (let i = 0; i < n; i++) lists[pass].push(ids[i]); };
    _rallySetTile = tile => lists[pass].push(tile);
    try {
        processAction(sanitizeAction(raw), 0);
        pass++;
        processActions([raw], 0);
    } finally { _rallyKernelRun = run; _rallySetTile = set; }
    return { lists, unchanged: JSON.stringify(raw) === original };
})())`));
// (No cap: every valid pair of the 5100 and the leading ones that pass validation.)
assert.ok(packedRally.lists[0].length >= 5100, 'every valid rally tile: ' + packedRally.lists[0].length);
assert.deepEqual(packedRally.lists[1], packedRally.lists[0], 'immediate rally packing preserves validation and order');
assert.equal(packedRally.unchanged, true, 'rally packing leaves packet coordinates intact');
const largeSelection = JSON.parse(a.eval(`JSON.stringify((() => {
    // (This synchronous test never presents the frames that end loading, which blocks input until then: the match as running.)
    const saved = localInputBuffer, blocked = _matchLoadInputBlocked;
    localInputBuffer = {}; _matchLoadInputBlocked = false;
    try {
        const ids = Array.from({ length: 200000 }, (_, i) => i + 1);
        queueAction({ action: 'move', unitIds: ids, targetX: 10, targetY: 20 });
        const pieces = Object.values(localInputBuffer).flat();
        let seen = 0, ordered = true;
        for (const piece of pieces) actionIdsForEach(piece.uidz, ACTION_MAX_UNIT_IDS, id => {
            if (id !== ++seen) ordered = false;
        });
        return { pieces: pieces.length, seen, ordered };
    } finally { localInputBuffer = saved; _matchLoadInputBlocked = blocked; }
})())`));
// (One piece: no cap on the ids an action carries.)
assert.deepEqual(largeSelection, { pieces: 1, seen: 200000, ordered: true },
    'one move command sends the entire 200,000-unit selection in order');
process.exit(0);
