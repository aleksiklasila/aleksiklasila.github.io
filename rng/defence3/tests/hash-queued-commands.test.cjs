// Commands waiting in the simulation are in the state hash (audit
// 2026-10-15, MULTIPLAYER_AUDIT_2026-10-15.md 6): the action backlog by its
// actions' content, in order (its kind and size, summed, missed a changed
// destination and a changed order); the queued move orders by their units
// still to apply (not hashed at all: a pending order showed nowhere). A peer
// restored from a snapshot (which carries what is left alone) hashes the
// same as the one that ran.
//   node tests/hash-queued-commands.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

(async () => {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '60' } });
    const inst = world.spawn('hash', { simWorker: false });
    inst.eval('startSoloGame();');
    await world.run(1500);
    const r = JSON.parse(inst.eval(`JSON.stringify((() => {
        const g = () => _snapHashGlobals();
        const out = {};
        // The backlog.
        const mv = (x, y) => ({ action: 'move', unitIds: [1, 2, 3], targetX: x, targetY: y, teamId: 0 });
        _actionBacklog = [[0, mv(100, 100)], [0, mv(200, 200)]];
        const h0 = g();
        _actionBacklog = [[0, mv(100, 100)], [0, mv(200, 232)]];
        out.destination = g() !== h0;
        _actionBacklog = [[0, mv(200, 200)], [0, mv(100, 100)]];
        out.order = g() !== h0;
        _actionBacklog = [[0, mv(100, 100)], [0, mv(200, 200)]];
        out.same = g() === h0;
        // (Fields processing adds are not content.)
        _actionBacklog[0][1]._idsDistinct = [1, 2, 3]; _actionBacklog[0][1].unitIdSet = new Set([1, 2, 3]);
        out.added = g() === h0;
        _actionBacklog = [];
        // The queue of move orders.
        // (Six of the player's units: the queue takes real units of the player
        // only; it is emptied before any tick.)
        const mine = [];
        for (let k = 0; k < 6; k++) { const u = new Unit('norm', localPlayerId, (10 + k) * TILE + 16, 10 * TILE + 16); units.push(u); unitSlotMapPushed(u); updateUnitSpatial(u); mine.push(u.id); }
        out.mine = mine.length;
        const q0 = orderQueueChecksum();
        _queueGroupMoveOrder({ action: 'move', unitIds: mine, targetX: 640, targetY: 640 }, localPlayerId, CMD_MOVING);
        const q1 = orderQueueChecksum();
        out.pending = q1 !== q0;
        // Another target: another hash.
        resetOrderQueue();
        _queueGroupMoveOrder({ action: 'move', unitIds: mine, targetX: 640, targetY: 672 }, localPlayerId, CMD_MOVING);
        out.target = orderQueueChecksum() !== q1;
        // Units ordered again (superseded) and some applied: a restore from
        // the snapshot of what is left hashes the same.
        resetOrderQueue();
        _queueGroupMoveOrder({ action: 'move', unitIds: mine, targetX: 640, targetY: 640 }, localPlayerId, CMD_MOVING);
        _queueGroupMoveOrder({ action: 'attackMove', unitIds: mine.slice(0, 2), targetX: 320, targetY: 320 }, localPlayerId, CMD_ATTACK_MOVING);
        _dropQueuedOrderUnits(new Set([mine[2]]), localPlayerId);
        // (One unit applied, as runQueuedOrders does.)
        _orderTake(_orderQueue[0], 1);
        const before = orderQueueChecksum(), snap = orderQueueSnapshot();
        orderQueueRestore(snap);
        out.restored = orderQueueChecksum() === before;
        out.left = snap.map(r => r[5].length);
        resetOrderQueue();
        return out;
    })())`));
    console.log(JSON.stringify(r));
    assert.equal(r.destination, true, 'a backlogged action\'s destination is hashed');
    assert.equal(r.order, true, 'the backlog\'s order is hashed');
    assert.equal(r.same, true, 'the same backlog, the same hash');
    assert.equal(r.added, true, 'fields processing adds are not hashed');
    assert.ok(r.mine >= 4, 'units to order');
    assert.equal(r.pending, true, 'a pending move order is hashed');
    assert.equal(r.target, true, 'its target too');
    assert.equal(r.restored, true, 'a restore of what is left hashes the same');
    assert.deepEqual(r.left, [r.mine - 4, 2], 'what is left: less the applied, the superseded and the dropped');
    console.log('PASS hash-queued-commands');
})().catch(e => { console.error(e); process.exit(1); });
