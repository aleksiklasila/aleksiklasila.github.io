// Who may say what (audit 2026-10-15, MULTIPLAYER_AUDIT_2026-10-15.md 10, 14):
// 10. What only the host says (back to the lobby, a player removed, ticks,
//     repairs...) is taken from the host alone: a guest's RETURN_TO_LOBBY
//     sent the host back to the lobby.
// 14. A profile id is public (lobby states list it); the slot of a
//     disconnected player went to anyone joining with it. A join's id now
//     stands only with its key (kept by that browser; the id is made from
//     it): an impostor joins as itself, the player itself still gets its
//     slot back.
//   node tests/multiplayer-authority.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 50, jitterMs: 5 };

(async () => {
    const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
    const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
    await H.playFor(world, [host, ...guests], 2000, { seed: 21 });

    // 10. A guest's host-only messages.
    const g = guests[0];
    const t0 = host.eval('currentTick');
    g.eval(`connections[0].send({ type: 'RETURN_TO_LOBBY', lobbyPlayers: lobbyPlayers, status: 'a guest says so' })`);
    g.eval(`connections[0].send({ type: 'PLAYER_REMOVED_FROM_MATCH', peerId: ${JSON.stringify(guests[1].eval('myPeerId'))} })`);
    g.eval(`connections[0].send({ type: 'START_GAME_ALL_READY', startSessionId: matchStartSessionId })`);
    await world.run(1000);
    assert.equal(host.eval('gameStarted'), true, 'the host stays in the match');
    assert.ok(host.eval('currentTick') > t0 + 10, 'and it runs');
    assert.equal(host.eval(`isPeerExplicitlyRemoved(${JSON.stringify(guests[1].eval('myPeerId'))})`), false, 'nobody removed by a guest');
    assert.ok(host.eval('netCounters.notFromHostDropped') >= 3, 'dropped: ' + host.eval('netCounters.notFromHostDropped'));

    // 14. guests[1] drops; an impostor joins with its profile id, without
    // its key.
    const victim = guests[1], victimPeer = victim.eval('myPeerId'), victimUid = victim.eval('localPersistentPeerId');
    assert.match(victimUid, /^k[0-9a-f]{32}$/, 'a profile id made from a key');
    assert.equal(host.eval(`matchRoleByUid[${JSON.stringify(victimUid)}]`), 'playing');
    const storage = victim.storage;
    world.kill(victim);
    await world.run(2000);
    const impostor = world.spawn('impostor', { url: `http://localhost/rng/defence3/index.html?game=${hostId}&room=${hostId}` });
    impostor.eval(`loadOrCreateLocalIdentity(); localPersistentPeerId = ${JSON.stringify(victimUid)}; joinGame(${JSON.stringify(hostId)})`);
    assert.ok(await world.runUntil(() => host.eval('netCounters.profileClaimsRefused | 0') > 0, 10000), 'the claim is refused');
    await world.run(3000);
    const impostorPeer = impostor.eval('myPeerId');
    assert.notEqual(host.eval(`matchRoleByPeerId[${JSON.stringify(impostorPeer)}] || ''`), 'playing', 'the impostor does not play the victim\'s slot');
    assert.notEqual(host.eval(`peerUidByPeerId[${JSON.stringify(impostorPeer)}] || ''`), victimUid, 'nor holds its profile');
    assert.notEqual(host.eval(`getTeamIdForPeer(${JSON.stringify(impostorPeer)})`), host.eval(`getTeamIdForPeer(${JSON.stringify(victimPeer)})`), 'nor its team');

    // The player itself (its storage: id and key) gets the slot back.
    const back = world.spawn('back', { storage, url: `http://localhost/rng/defence3/index.html?game=${hostId}&room=${hostId}` });
    back.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(hostId)})`);
    assert.equal(back.eval('localPersistentPeerId'), victimUid, 'the same profile after a reload');
    assert.ok(await world.runUntil(() => back.eval('gameStarted') && host.eval(`matchRoleByPeerId[${JSON.stringify(back.eval('myPeerId'))}] || ''`) === 'playing', 20000), 'the player is back in its slot');
    const all = [host, guests[0], back];
    assert.ok(await world.runUntil(() => all.every(i => !i.eval('lockstepResyncPauseActive')), 10000));
    const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
    await H.playFor(world, all, 3000, { seed: 22 });
    await world.run(1500);
    H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: 'after the claim' });
    console.log('PASS multiplayer-authority: host-only messages from the host alone; a profile id stands only with its key');
})().catch(e => { console.error(e); process.exit(1); });
