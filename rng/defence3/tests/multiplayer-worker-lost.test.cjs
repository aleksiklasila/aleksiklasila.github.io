// A simulation worker lost mid-match (audit 2026-10-15,
// MULTIPLAYER_AUDIT_2026-10-15.md 19): its match state gone, it stayed marked
// active, and its ticks never came back: a guest's left that guest stuck, the
// host's stalled the match, with healthy heartbeats. Now the page drops it
// when it says so (sim_client.js _simClientWorkerLost; silence alone is not a
// loss: a slow 2M-unit tick is waited for), starts a new worker and gets the
// match again: a guest from its host (the whole match, as a reload), a host
// by handing the match to a player and joining it. Every team plays on, in
// sync.
//   node tests/multiplayer-worker-lost.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 50, jitterMs: 5 };
const hostOf = inst => inst.eval('isHost ? myPeerId : wsHostId');

(async () => {
    const rows = [];
    for (const who of ['guest', 'host']) {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        world.simWorker = true;
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 2000, { seed: 61 });
        assert.ok(all.every(i => i.eval('simClientActive()')), 'every page runs its match in a worker');
        const victim = who === 'host' ? host : guests[0];
        const teams = all.map(i => i.eval('localPlayerId'));
        // The worker loses the match's state (as for a restore it could not
        // make) and says no more. (Stopped first: the page's new worker
        // replaces victim.simWorker.)
        victim.simWorker.terminate();
        victim.eval("_simClientOnMessage({ type: 'restoreFailed', epoch: _simClient.epoch, message: 'state lost (test)' })");
        const t0 = world.now;
        assert.ok(await world.runUntil(() => victim.eval('simClientLostPending()'), 20000), 'the page noticed the lost worker');
        const noticed = world.now - t0;
        // The match comes back to every page, a worker under each again.
        const back = await world.runUntil(() => {
            if (victim.eval('simClientLostPending()')) return false;
            if (!all.every(i => i.eval('gameStarted && !lockstepResyncPauseActive && simClientActive()'))) return false;
            return new Set(all.map(hostOf)).size === 1;
        }, 40000, 100);
        const backAfter = world.now - t0 - noticed;
        assert.ok(back, who + ': the match came back: ' + JSON.stringify(all.map(i => [i.name, i.eval('isHost'), i.eval('simClientLostPending()'), i.eval('simClientActive()'), i.eval('currentTick'), hostOf(i)])));
        const ticks = all.map(i => i.eval('currentTick'));
        await world.run(3000);
        assert.ok(all.every((i, k) => i.eval('currentTick') > ticks[k] + 30), who + ': every page ticks on: ' + JSON.stringify(all.map((i, k) => [ticks[k], i.eval('currentTick')])));
        // (Nobody resigned: the victim's team plays on.)
        assert.deepEqual(all.map(i => i.eval('[...resignedTeams]').length), [0, 0, 0], who + ': no team resigned');
        assert.deepEqual(all.map(i => i.eval('localPlayerId')), teams, who + ': every page on its own team');
        if (who === 'host') assert.equal(host.eval('isHost'), false, 'the old host is a guest now');
        const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
        await H.playFor(world, all, 3000, { seed: 62 });
        await world.run(1500);
        // (The lost worker's error lines are expected.)
        for (const i of all) i.errors = i.errors.filter(e => !/lost during the match|simulation worker was lost/.test(String(e && e.message || e)));
        H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: who + ' worker lost' });
        rows.push(`${who}'s worker lost: noticed after ${noticed} ms, the match back ${backAfter} ms later`);
    }
    console.log('PASS multiplayer-worker-lost\n  ' + rows.join('\n  '));
})().catch(e => { console.error(e); process.exit(1); });
