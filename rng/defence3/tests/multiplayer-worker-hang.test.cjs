// A simulation worker never falls behind its page for good (static audit 2026-11-18, MULTIPLAYER_ROBUSTNESS_PROGRESS.md
// "Simulation-thread hangs"). Old code: a tick whose command preparation threw was never queued, and a throw in a
// tick's pre-steps (presentation begin, history flush) skipped currentTick++: the worker refused every later tick
// ("tick N arrived at N-1") while the page's link stayed alive, so a host looked connected and never advanced.
// 1. A guest worker's command preparation throws once: the tick still runs (reported as failed, repaired), the
//    match goes on in sync.
// 2. A host worker's presentation begin throws once: the tick still runs, the match goes on in sync.
// 3. A guest worker is a tick behind its page (a tick it never ran): the page counts it lost and gets the match
//    again, in sync afterwards.
//   node tests/multiplayer-worker-hang.test.cjs   (worker mode always)
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 40, jitterMs: 5 };
const EXPECTED = /injected (prepare|presentation) failure|lost during the match|simulation worker was lost|arrived at/;
const dropExpected = all => { for (const i of all) i.errors = i.errors.filter(e => !EXPECTED.test(String(e && e.stack || e))); };
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);

async function match(seed) {
    const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
    world.simWorker = true;
    const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
    const all = [host, ...guests];
    await H.playFor(world, all, 2000, { seed });
    assert.ok(all.every(i => i.eval('simClientActive()')), 'every page runs its match in a worker');
    return { world, host, g: guests[0], all };
}
async function goesOn(world, all, label, seed) {
    const ticks = all.map(i => i.eval('currentTick'));
    await world.runUntil(() => all.every(i => i.eval('gameStarted && !lockstepResyncPauseActive && simClientActive()')), 40000, 100);
    await world.run(3000);
    assert.ok(all.every((i, k) => i.eval('currentTick') > ticks[k] + 30), label + ': every page ticks on: ' + JSON.stringify(all.map((i, k) => [ticks[k], i.eval('currentTick'), i.simWorker && i.simWorker.eval('currentTick')])));
    const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
    await H.playFor(world, all, 3000, { seed });
    await world.run(1500);
    dropExpected(all);
    H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label });
}

(async () => {
    const rows = [];
    if (!ONLY.length || ONLY.includes('prepare')) {
        const { world, g, all } = await match(31);
        const fails0 = g.eval('netCounters.tickFailures | 0');
        g.simWorker.eval(`(() => { const f = actionsPrepare; let n = 1; actionsPrepare = function () { if (n-- > 0) throw new Error('injected prepare failure'); return f.apply(this, arguments); }; })()`);
        assert.ok(await world.runUntil(() => g.eval('netCounters.tickFailures | 0') > fails0, 5000), 'the failed preparation was reported as the tick\'s');
        await goesOn(world, all, 'prepare throws', 32);
        rows.push('guest worker command preparation threw: tick ran, repaired, in sync');
    }
    if (!ONLY.length || ONLY.includes('presentation')) {
        const { world, host, all } = await match(41);
        host.simWorker.eval(`(() => { const f = simPresentTickBegin; let n = 1; simPresentTickBegin = function () { if (n-- > 0) throw new Error('injected presentation failure'); return f.apply(this, arguments); }; })()`);
        await goesOn(world, all, 'presentation throws', 42);
        rows.push('host worker presentation begin threw: tick ran, in sync');
    }
    if (!ONLY.length || ONLY.includes('behind')) {
        const { world, g, all } = await match(51);
        // (Between two ticks: the worker forgets the tick it just ran; the page's next tick is one ahead of it.)
        g.simWorker.eval('currentTick--');
        assert.ok(await world.runUntil(() => g.errors.some(e => /lost during the match/.test(String(e && e.message || e))), 10000), 'the page noticed the worker behind it: ' + JSON.stringify([g.eval('currentTick'), g.simWorker.eval('currentTick'), g.errors.slice(-3).map(String)]));
        await goesOn(world, all, 'worker behind', 52);
        rows.push('guest worker a tick behind: counted lost, match back, in sync');
    }
    if (!ONLY.length || ONLY.includes('handover-late')) {
        // 4. The host's worker is lost; the player it hands the match to answers after the 4 s wait
        //    (HOST_HANDOVER_MS), when the host already asked the next one. One host in the end, every page on it,
        //    in sync. (Old code: the late answer was dropped, that player hosted anyway: two hosts.)
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        world.simWorker = true;
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 2000, { seed: 61 });
        for (const g of guests) g.eval(`(() => { const c = connections.find(x => x.peer === wsHostId), f = c.send.bind(c);
            c.send = d => { if (d && d.type === 'HOST_HANDOVER_DONE') setTimeout(() => f(d), 6000); else f(d); }; })()`);
        host.simWorker.terminate();
        host.eval("_simClientOnMessage({ type: 'restoreFailed', epoch: _simClient.epoch, message: 'state lost (test)' })");
        const hostOf = i => i.eval('isHost ? myPeerId : wsHostId');
        const one = await world.runUntil(() => {
            if (all.some(i => i.eval('simClientLostPending()'))) return false;
            if (!all.every(i => i.eval('gameStarted && !lockstepResyncPauseActive && simClientActive()'))) return false;
            return new Set(all.map(hostOf)).size === 1 && all.filter(i => i.eval('isHost')).length === 1;
        }, 60000, 100);
        assert.ok(one, 'handover-late: one host: ' + JSON.stringify(all.map(i => [i.name, i.eval('isHost'), hostOf(i), i.eval('currentTick')])));
        await goesOn(world, all, 'handover-late', 62);
        assert.equal(all.filter(i => i.eval('isHost')).length, 1, 'handover-late: still one host');
        rows.push('handover answered after the wait: one host (' + all.find(i => i.eval('isHost')).name + '), in sync');
    }
    console.log('PASS multiplayer-worker-hang\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
