// A host's TICK_RESEND_REQUEST reaching a guest late (audit row 67, MULTIPLAYER_AUDIT_2026-10-15.md, main.js
// handleIncomingTickResendRequest).
// 1. stale: a request for a tick the guest already ran (it crossed the host's sealed bundle of that tick). Old code:
//    "host asked for an executed tick" -> a full match reload for nothing. Now: the ticks already run are skipped.
// 2. other-match: a request of the previous match (a rematch reuses the link, ticks start at 0 again) asking for
//    ticks far ahead. Old code: the guest made packets for those far ticks and every later command queued behind
//    them. Now: dropped by the match tag. The guest's commands still run at once.
//   node tests/multiplayer-resend-request.test.cjs   (SIM_WORKER=1: worker mode)
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 40, jitterMs: 5 };
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = k => !ONLY.length || ONLY.includes(k);

async function match(seed) {
    const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
    const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
    const all = [host, ...guests];
    await H.playFor(world, all, 2000, { seed });
    return { world, host, g: guests[0], all };
}
// The guest's move runs on every peer within the usual delay (lead + latency), not seconds later.
async function commandRunsSoon(world, all, g, label) {
    const before = new Set(world.issued.keys());
    g.eval(`(() => { const u = units.find(u => u.owner === localPlayerId && !u.dead); queueAction({ action: 'move', unitIds: [u.id], targetX: u.x + 48, targetY: u.y + 16 }); })()`);
    const netId = [...world.issued].find(([id, i]) => !before.has(id) && i.by === g.name)?.[0];
    assert.ok(netId, label + ': command queued');
    const t0 = world.now;
    assert.ok(await world.runUntil(() => all.every(i => i.executedActions.has(netId)), 6000, 20), label + ': the command ran on every peer');
    const ms = world.now - t0;
    assert.ok(ms < 2000, label + ': the command ran within 2 s (' + ms + ' ms)');
    return ms;
}

(async () => {
    const rows = [];
    if (want('stale')) {
        const { world, host, g, all } = await match(81);
        const before = all.map(i => ({ patches: i.patchesApplied, snapshots: i.snapshotsApplied }));
        const t = g.eval('currentTick') - 2;
        g.eval(`handleIncomingTickResendRequest(netGetHostConnection(), { type: 'TICK_RESEND_REQUEST', tick: ${t}, count: 4, packetPeerId: myPeerId, m: matchStartSessionId || undefined })`);
        const from = Math.max(...all.map(i => i.eval('currentTick'))) + 3;
        await H.playFor(world, all, 3000, { seed: 82 });
        await world.run(1500);
        H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: 'stale' });
        for (const [k, i] of all.entries()) {
            assert.equal(i.snapshotsApplied, before[k].snapshots, 'stale: ' + i.name + ' did not reload the match');
            assert.equal(i.patchesApplied, before[k].patches, 'stale: ' + i.name + ' needed no repair');
        }
        const ms = await commandRunsSoon(world, all, g, 'stale');
        rows.push('request for ticks already run (' + t + '): no reload, in sync, next command in ' + ms + ' ms');
    }
    if (want('other-match')) {
        const { world, host, g, all } = await match(91);
        const far = g.eval('currentTick') + 400;
        g.eval(`handleIncomingTickResendRequest(netGetHostConnection(), { type: 'TICK_RESEND_REQUEST', tick: ${far}, count: 8, packetPeerId: myPeerId, m: 'previous-match' })`);
        await world.run(200);
        const ms = await commandRunsSoon(world, all, g, 'other-match');
        const from = Math.max(...all.map(i => i.eval('currentTick'))) + 3;
        await H.playFor(world, all, 3000, { seed: 92 });
        await world.run(1500);
        H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: 'other-match' });
        assert.ok(g.eval('netCounters.otherMatchDropped | 0') >= 1, 'other-match: the request was dropped as another match\'s');
        rows.push('previous match\'s request for tick ' + far + ': dropped, next command in ' + ms + ' ms, in sync');
    }
    console.log('PASS multiplayer-resend-request\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
