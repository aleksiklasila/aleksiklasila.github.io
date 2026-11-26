// A move order to held units (hold position): they take it in the kernels (ord.rs k_order_admit, mv.rs ord_pickup)
// like the others, not the JavaScript's per-unit path search; the controller parks them (park_held) while held, and
// once the hold ends (stop releases it) they walk to the order's destination. The units not held move at once.
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '60', 'cfg-map-type': 'arena' } });
const inst = world.spawn('hm', { simWorker: false });
inst.eval('startSoloGame();');
const r = JSON.parse(inst.eval(`JSON.stringify((() => {
    const mine = [];
    for (let i = 0; i < 300; i++) {
        const p = findNearestWalkable(6 + i % 20, 6 + Math.floor(i / 20));
        const u = new Unit(['norm', 'fast', 'tank'][i % 3], 0, p.x * TILE + 8 + i % 13, p.y * TILE + 9 + i % 11);
        units.push(u); updateUnitSpatial(u); mine.push(u);
    }
    for (let t = 0; t < 3; t++) { gameTick(); currentTick++; }
    const held = mine.filter((_, i) => i % 3 === 0), free = mine.filter((_, i) => i % 3 !== 0);
    // (The match's own workers, held too.)
    const wk = units.filter(u => u && !u.dead && u.owner === 0 && u.workerType && !u.isKing);
    held.push(...wk);
    processAction({ action: 'hold', unitIds: held.map(u => u.id) }, 0);
    gameTick(); currentTick++;
    const at = held.map(u => [u.x, u.y]);
    const dest = { x: 45 * TILE + 16, y: 45 * TILE + 16 };
    // (Units given the order by the JavaScript's per-unit path, counted.)
    const orig = _issueGroupMoveOrderList; let viaJs = 0;
    _issueGroupMoveOrderList = function (list) { viaJs += list.length; return orig.apply(this, arguments); };
    processAction({ action: 'move', unitIds: [...mine, ...wk].map(u => u.id), targetX: dest.x, targetY: dest.y }, 0);
    for (let t = 0; t < 80; t++) { gameTick(); currentTick++; }
    const heldMoved = held.filter((u, i) => Math.hypot(u.x - at[i][0], u.y - at[i][1]) > TILE).length;
    const c = held[0]._us, heldKeys = new Set(held.filter(u => !u.workerType).map(u => c.nvPK[u._si])), freeKeys = new Set(free.map(u => c.nvPK[u._si]));
    const wkMan = wk.filter(u => u.workerState === 'MANUAL_MOVE').length;
    const sameRoute = heldKeys.size === 1 && [...heldKeys][0] >= 0 && freeKeys.has([...heldKeys][0]);
    const heldCmd = held.filter(u => u.commandState === CMD_MOVING).length;
    const freeD = free.reduce((a, u) => a + Math.hypot(u.x - dest.x, u.y - dest.y), 0) / free.length;
    const heldD0 = held.reduce((a, u) => a + Math.hypot(u.x - dest.x, u.y - dest.y), 0) / held.length;
    processAction({ action: 'stop', unitIds: held.map(u => u.id) }, 0);
    for (let t = 0; t < 900; t++) { gameTick(); currentTick++; }
    const heldD1 = held.reduce((a, u) => a + Math.hypot(u.x - dest.x, u.y - dest.y), 0) / held.length;
    const stillHeld = held.filter(u => u.holdPosition).length;
    _issueGroupMoveOrderList = orig;
    return { n: held.length, heldMoved, heldCmd, freeD: freeD / TILE, heldD0: heldD0 / TILE, heldD1: heldD1 / TILE, stillHeld, viaJs, sameRoute, nw: wk.length, wkMan };
})())`));
console.log(JSON.stringify(r));
assert.equal(r.heldMoved, 0, 'held units stand while held');
assert.equal(r.heldCmd, r.n, 'held units took the move order');
assert.ok(r.nw > 0, 'held workers in the order: ' + r.nw);
assert.equal(r.wkMan, r.nw, 'held workers took it (manual move)');
assert.equal(r.viaJs, 0, 'no unit given the order by the JavaScript (per-unit path search)');
assert.equal(r.sameRoute, true, 'held units keep the order\'s route, the same as the others');
assert.ok(r.freeD < r.heldD0 - 5, 'units not held move at once: ' + r.freeD + ' vs held ' + r.heldD0);
assert.equal(r.stillHeld, 0, 'stop releases the hold');
assert.ok(r.heldD1 < 12 && r.heldD1 < r.heldD0 - 10, 'released units walk to the destination: ' + r.heldD0 + ' -> ' + r.heldD1);
console.log('hold-move-order: ok');
