// Move orders written straight to the unit columns (main.js _ordClearFast and
// _issueFlowOrder's fast branch) must leave every unit column exactly as the
// setters do (_ordFastOn = false), digest included, over units in varied
// states: targets, attack-move, held, workers, standing at the destination,
// unreachable, and an order given again before the last was applied.
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

function run(fast) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '60', 'cfg-map-type': 'arena' } });
    const inst = world.spawn('of' + (fast ? 1 : 0), { simWorker: false });
    inst.eval('startSoloGame();');
    return JSON.parse(inst.eval(`JSON.stringify((() => {
        _ordFastOn = ${fast};
        const ids = [], enemy = [];
        for (let i = 0; i < 400; i++) {
            const p = findNearestWalkable(8 + i % 30, 8 + Math.floor(i / 30));
            const u = new Unit(['norm', 'fast', 'tank', 'archer'][i % 4], i % 9 === 8 ? 1 : 0, p.x * TILE + 4 + i % 20, p.y * TILE + 6 + i % 17);
            units.push(u); updateUnitSpatial(u);
            (u.owner === 0 ? ids : enemy).push(u);
        }
        for (let t = 0; t < 3; t++) { gameTick(); currentTick++; }
        // (Varied states before the orders.)
        ids.forEach((u, i) => {
            if (i % 7 === 1) { u.targetUnit = enemy[i % enemy.length]; u.forcedAttackTarget = true; u.commandState = CMD_ATTACKING; u._forcedTargetLastSeenX = 5; }
            if (i % 11 === 2) u.holdPosition = true;
            if (i % 13 === 3) { u._pendingPathTarget = { gx: 3, gy: 4, cmd: CMD_MOVING }; u.pathIsFallbackAstar = true; }
            if (i % 17 === 4) u.targetBuilding = { gx: 1, gy: 1, energy: 5 };
            if (i % 5 === 0) { u._attackMoveGx = 3; u._attackMoveGy = 9; u.commandState = CMD_ATTACK_MOVING; }
        });
        const all = ids.map(u => u.id);
        ORDER_UNITS_PER_TICK_ALL = 150; ORDER_UNITS_PER_PLAYER_TICK = 150; ORDER_UNITS_PER_ROUND = 60;
        processAction({ action: 'move', unitIds: all, targetX: 40 * TILE + 16, targetY: 40 * TILE + 16 }, 0);
        gameTick(); currentTick++;
        processAction({ action: 'attackMove', unitIds: all.filter((_, i) => i % 3), targetX: 12 * TILE + 3, targetY: 50 * TILE + 9 }, 0);
        for (let t = 0; t < 4; t++) { gameTick(); currentTick++; }
        // (One standing on its destination; a small group, no crowd arrival.)
        const u0 = ids[0], gx = Math.floor(u0.x / TILE), gy = Math.floor(u0.y / TILE);
        processAction({ action: 'move', unitIds: [u0.id, ids[1].id, ids[2].id], targetX: gx * TILE + 16, targetY: gy * TILE + 16 }, 0);
        _refillOrderBudget(); runQueuedOrders();
        // Every unit's columns, slot by slot (references by their digest word,
        // paths by content).
        const c = units[0]._us, out = {};
        for (const k of Object.keys(c)) {
            const a = c[k];
            if (!a || typeof a.length !== 'number') continue;
            out[k] = units.map(u => { const v = a[u._si]; return v && typeof v === 'object' ? (Array.isArray(v) ? JSON.stringify(v) : _simHEnc(v)) : (typeof v === 'number' && v !== v ? 'NaN' : v); });
        }
        out.digestOk = units.every(u => simUnitHashDigest(u) === c.hObj[u._si]);
        out.hash = typeof computeStateHash === 'function' ? computeStateHash() : null;
        return out;
    })())`));
}
const a = run(true), b = run(false);
assert.equal(a.digestOk, true, 'fast path digest equals the fields');
assert.equal(b.digestOk, true, 'setter path digest equals the fields');
let diffs = [];
for (const k of Object.keys(b)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(k);
assert.deepEqual(diffs, [], 'columns differ: ' + diffs.join(', '));
console.log('order-fast: ok,', Object.keys(b).length, 'columns equal');
