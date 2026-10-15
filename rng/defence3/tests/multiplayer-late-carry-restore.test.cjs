// Late commands the host has accepted (a guest's packet that came after its
// tick was sealed without it: its commands carried to the guest's next
// packets, _hostCarryLatePacket) are not lost to a restore of the whole
// match on the host (audit 2026-10-15, MULTIPLAYER_AUDIT_2026-10-15.md 13):
// snapshots carry them (lockstepCarry), the host keeps them, and they run on
// every peer after the resync.
//   node tests/multiplayer-late-carry-restore.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

(async () => {
    const world = new H.World({ network: { latencyMs: 40, jitterMs: 5 }, controls: H.SMALL_MATCH_CONTROLS });
    const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
    const all = [host, ...guests];
    await H.playFor(world, all, 2000, { seed: 41 });
    const g = guests[0], gp = g.eval('myPeerId');
    // A late command of the guest's, accepted and carried by the host.
    const netId = gp + ':late-1';
    host.eval(`(() => {
        const u = units.find(u => u.owner === ${g.eval('localPlayerId')} && !u.dead);
        const a = normalizeLockstepPayload({ action: 'move', unitIds: [u.id], targetX: u.x + 64, targetY: u.y, teamId: ${g.eval('localPlayerId')}, netId: ${JSON.stringify(netId)} });
        lockstepHostCarryByPeer[${JSON.stringify(gp)}] = [a];
    })()`);
    // A snapshot carries it.
    const snap = JSON.parse(host.eval(`JSON.stringify(buildHostAuthoritativeStateSnapshot({ includeConfig: false, includeStaticMapState: false }).lockstepCarry)`));
    assert.equal(snap[gp] && snap[gp][0] && snap[gp][0].netId, netId, 'the snapshot carries it');
    // The whole match restored (a match-wide resync) before it ran.
    host.eval(`_startHostResyncPause('test: restore with a carried command')`);
    assert.ok(await world.runUntil(() => all.every(i => i.executedActions.has(netId)), 15000),
        'it ran on every peer: ' + JSON.stringify(all.map(i => [i.name, i.executedActions.has(netId)])));
    assert.ok(await world.runUntil(() => all.every(i => !i.eval('lockstepResyncPauseActive')), 10000));
    const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
    await H.playFor(world, all, 2000, { seed: 42 });
    await world.run(1500);
    H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: 'carried command' });
    console.log('PASS multiplayer-late-carry-restore');
})().catch(e => { console.error(e); process.exit(1); });
