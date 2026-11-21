// Two lone hosts after a network split heals: exactly one keeps hosting (audit row 71, MULTIPLAYER_AUDIT_2026-10-15.md,
// utils_host_migration.js hostMaybeSeekOtherHost, HOST_SEEK_REPLY `players`). 1v1: the link is cut long enough
// that the guest, alone, takes the match over (HOST_MIGRATION_ALONE_AFTER_SILENT_MS); the old host is alone too.
// The link comes back. Old code: each host, alone, gave up hosting for the other's match: both demoted, nobody
// hosted, the match stood. Now only the larger id moves: one host, both in the match, in sync.
//   node tests/multiplayer-split-heal.test.cjs   (SIM_WORKER=1: worker mode)
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 40, jitterMs: 5 };

(async () => {
    const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
    const { host, guests } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
    const g = guests[0], all = [host, g];
    await H.playFor(world, all, 2000, { seed: 211 });
    world.setLink(host, g, 'blackhole');
    assert.ok(await world.runUntil(() => g.eval('isHost'), 150000, 200), 'the guest, alone, took the match over');
    assert.ok(host.eval('isHost'), 'the old host still hosts, alone');
    await world.run(3000);
    world.setLink(host, g, 'up');
    // (Both look for the other host at the same moment: their probes cross, as when a split heals for both at once.)
    for (const i of all) i.eval('_hostLastSeekAt = 0; _hostSeekActive = false; hostMaybeSeekOtherHost()');
    const hosts = () => all.filter(i => i.eval('isHost'));
    const one = await world.runUntil(() => hosts().length === 1 && all.every(i => i.eval('gameStarted && !gameOver && !lockstepResyncPauseActive'))
        && all.every(i => i.eval('isHost ? myPeerId : wsHostId') === hosts()[0].eval('myPeerId')), 120000, 200);
    assert.ok(one, 'one host after the split healed: ' + JSON.stringify(all.map(i => [i.name, i.eval('myPeerId'), i.eval('isHost'), i.eval('wsHostId'), i.eval('currentTick'), i.eval('gameOver')])));
    const h = hosts()[0], ids = all.map(i => i.eval('myPeerId')).sort();
    assert.equal(h.eval('myPeerId'), ids[0], 'the smaller id hosts (the larger one moved)');
    const t = all.map(i => i.eval('currentTick'));
    await world.run(3000);
    assert.ok(all.every((i, k) => i.eval('currentTick') > t[k] + 30), 'the match runs on');
    const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
    await H.playFor(world, all, 3000, { seed: 212 });
    await world.run(1500);
    H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: 'split healed' });
    console.log('PASS multiplayer-split-heal: ' + h.name + ' hosts after the split, in sync');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
