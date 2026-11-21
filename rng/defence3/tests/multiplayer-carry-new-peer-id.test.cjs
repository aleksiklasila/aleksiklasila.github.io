// A late command the host carries for a player survives that player coming back under a new peer id (audit row 66,
// MULTIPLAYER_AUDIT_2026-10-15.md, utils_networking.js migratePeerIdByUid). The host accepted a guest's late
// command (carried to its next packets, lockstepHostCarryByPeer); before a packet came, the guest's page reloaded
// and joined again under a new peer id. Old code: the carry stayed under the old id and never ran. Now it moves with
// the roster entry and runs on every peer.
//   node tests/multiplayer-carry-new-peer-id.test.cjs   (SIM_WORKER=1: worker mode)
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 40, jitterMs: 5 };
const url = hostId => `http://localhost/rng/defence3/index.html?game=${hostId}&room=${hostId}`;

(async () => {
    const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
    const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
    await H.playFor(world, [host, ...guests], 2000, { seed: 221 });
    const [g, other] = guests, gp = g.eval('myPeerId'), team = g.eval('localPlayerId');
    const netId = gp + ':late-1';
    // (Its link cut first and the messages on their way gone: no packet of its old id comes to take the carry.)
    world.setLink(g, host, 'blackhole');
    await world.run(1500);
    host.eval(`(() => {
        const u = units.find(u => u.owner === ${team} && !u.dead);
        const a = normalizeLockstepPayload({ action: 'move', unitIds: [u.id], targetX: u.x + 64, targetY: u.y, teamId: ${team}, netId: ${JSON.stringify(netId)} });
        lockstepHostCarryByPeer[${JSON.stringify(gp)}] = [a];
    })()`);
    world.kill(g);
    const fresh = world.spawn('reloaded', { storage: g.storage, url: url(hostId) });
    fresh.eval('loadOrCreateLocalIdentity()');
    fresh.eval(`joinGame(${JSON.stringify(hostId)})`);
    const live = i => i.eval('gameStarted && !resyncGuest.joining && !resyncGuest.awaitingLive && !lockstepResyncPauseActive');
    assert.ok(await world.runUntil(() => live(fresh) && fresh.eval('currentTick') > 0, 40000, 100), 'the guest is back');
    const np = fresh.eval('myPeerId');
    assert.notEqual(np, gp, 'under a new peer id');
    assert.equal(fresh.eval('localPlayerId'), team, 'playing its team');
    const all = [host, other, fresh];
    // (The reloaded page has it in the state it joined with when it ran before that join; the hashes below compare.)
    assert.ok(await world.runUntil(() => [host, other].every(i => i.executedActions.has(netId)), 15000, 50),
        'the carried command ran on the host and the other guest: ' + JSON.stringify([all.map(i => [i.name, i.executedActions.has(netId)]), host.eval(`Object.keys(lockstepHostCarryByPeer).map(k => k + ':' + lockstepHostCarryByPeer[k].length)`)]));
    const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
    await H.playFor(world, all, 3000, { seed: 222 });
    await world.run(1500);
    H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: 'carry under a new id' });
    console.log('PASS multiplayer-carry-new-peer-id: the carried command ran after the reconnect (' + gp.slice(0, 8) + ' -> ' + np.slice(0, 8) + ')');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
