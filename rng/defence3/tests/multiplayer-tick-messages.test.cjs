// Tick messages of another match, and bundles in another order (audit
// 2026-10-15, MULTIPLAYER_AUDIT_2026-10-15.md 8, 9):
// 8. Tick bundles, tick packets, hash sums and repair messages carry their
//    match (its session id): a rematch counts its ticks from 0 again, and a
//    late bundle of the previous match was taken as this one's. Another
//    match's are dropped, this match's taken.
// 9. A bundle's checksum covers its packets in their order, the order their
//    commands run in (it sorted them: two packets swapped kept the checksum
//    and changed the result); the order is by peer id in code units, the
//    same in every locale (localeCompare's was the locale's).
//   node tests/multiplayer-tick-messages.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

(async () => {
    const world = new H.World({ network: { latencyMs: 40, jitterMs: 5 }, controls: H.SMALL_MATCH_CONTROLS });
    const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 1] });
    const all = [host, ...guests];
    await H.playFor(world, all, 2000, { seed: 11 });
    const g = guests[0];

    // 9. Order.
    const order = JSON.parse(host.eval(`JSON.stringify((() => {
        const t = currentTick + 900;
        const A = { tick: t, peerId: 'Bpeer', teamId: 0, actions: [{ action: 'move', unitIds: [1], targetX: 10, targetY: 10 }] };
        const B = { tick: t, peerId: 'apeer', teamId: 1, actions: [{ action: 'move', unitIds: [1], targetX: 99, targetY: 99 }] };
        for (const p of [A, B]) p.checksum = computeTickPacketChecksum(p.tick, p.peerId, p.teamId, p.actions);
        const sorted = [A, B].sort(tickPacketOrder);
        const c = computeTickBundleChecksum(t, sorted, 0);
        const swapped = computeTickBundleChecksum(t, sorted.slice().reverse(), 0);
        const bundle = { tick: t, packets: sorted.slice().reverse(), combinedChecksum: c };
        // (The bundles sealed in this match: in that order.)
        let inOrder = true;
        for (const k in lockstepBundleByTick) { const ps = lockstepBundleByTick[k].packets; for (let i = 1; i < ps.length; i++) if (tickPacketOrder(ps[i - 1], ps[i]) > 0) inOrder = false; }
        return { first: sorted[0].peerId, differs: c !== swapped, swappedValid: validateTickBundle(bundle), inOrder };
    })())`));
    assert.equal(order.first, 'Bpeer', 'code-unit order (B before a), not the locale\'s');
    assert.equal(order.differs, true, 'swapped packets change the checksum');
    assert.equal(order.swappedValid, false, 'a bundle with its packets swapped fails its checksum');
    assert.equal(order.inOrder, true, 'sealed bundles are in that order');

    // 8. Another match's bundle (as a late one from the match before a
    // rematch, ticks numbered from 0 again): dropped; this match's: taken.
    const feed = tag => JSON.parse(g.eval(`JSON.stringify((() => {
        const t = currentTick + 700;
        const own = { tick: t, peerId: myPeerId, teamId: localPlayerId, actions: [] };
        own.checksum = computeTickPacketChecksum(t, own.peerId, own.teamId, own.actions);
        const b = { tick: t, packets: [own], combinedChecksum: computeTickBundleChecksum(t, [own], 0) };
        const w = packTickBundleForWire(b);
        ${tag === null ? 'delete w.m;' : `w.m = ${JSON.stringify(tag)};`}
        const before = netCounters.otherMatchDropped | 0;
        handleIncomingTickBundle(null, { type: 'TICK_BUNDLE', w, c: 1 });
        const taken = !!lockstepPendingBundleByTick[t];
        delete lockstepPendingBundleByTick[t]; delete lockstepPendingCommitByTick[t];
        return { taken, dropped: (netCounters.otherMatchDropped | 0) - before, session: matchStartSessionId };
    })())`));
    const session = g.eval('matchStartSessionId');
    assert.ok(session, 'the match has a session id');
    assert.equal(host.eval('matchStartSessionId'), session);
    assert.deepEqual(feed('an-earlier-match'), { taken: false, dropped: 1, session }, 'another match\'s bundle is dropped');
    assert.equal(feed(session).taken, true, 'this match\'s is taken');
    assert.equal(feed(null).taken, true, 'an untagged one is taken');
    // Hash sums and packets of another match.
    g.eval(`(() => { __scratch.hashes = 0; const f = resyncGuestReceiveHashes; resyncGuestReceiveHashes = function () { __scratch.hashes++; return f.apply(this, arguments); }; })()`);
    g.eval(`_handleConnectionMessage(connections[0], { type: 'TICK_HASHES', h: [currentTick + 5, 123], m: 'an-earlier-match' })`);
    assert.equal(g.eval('__scratch.hashes'), 0, 'another match\'s hash sums are dropped');
    const hostDropped = host.eval('netCounters.otherMatchDropped | 0');
    host.eval(`handleIncomingTickPackets(connections[0], { type: 'TICK_PACKETS', packets: [], m: 'an-earlier-match' })`);
    assert.equal(host.eval('netCounters.otherMatchDropped | 0'), hostDropped + 1, 'another match\'s packets are dropped');

    // The match goes on in sync (its own messages all tagged).
    const from = host.eval('currentTick') + 5;
    await H.playFor(world, all, 3000, { seed: 12 });
    await world.run(1500);
    H.checkHealthy(world, all, { minCompared: 20, fromTick: from, label: 'tagged messages' });
    for (const i of all) H.assertAllCommandsExecuted(world, i, 'tagged messages', world.now - 2500);
    assert.equal(g.eval('netCounters.otherMatchDropped | 0'), 1, 'none of this match\'s own were dropped');
    console.log('PASS multiplayer-tick-messages: packets in code-unit order, checksum over that order, other matches\' messages dropped');
})().catch(e => { console.error(e); process.exit(1); });
