// Recoveries and what comes late (audit 2026-10-15,
// MULTIPLAYER_AUDIT_2026-10-15.md 17, 18, 21):
// 17. A recovery's pause that reaches a guest after the recovery's snapshot
//     and resume does not pause it again (it stood still until its 8 s
//     timeout).
// 21. A visitor in the lobby (connected, without the match) does not hold up
//     a recovery: it says it has no match, and the host stops waiting for it
//     (it waited 20 s).
// 18. A guest's simulation worker takes the bundles of a new host (a
//     migration) whose count of generations is lower than the old host's.
//   node tests/multiplayer-recovery-late.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 50, jitterMs: 5 };

(async () => {
    const rows = [];
    // 17 and 21.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
        const g = guests[0], all = [host, g];
        await H.playFor(world, all, 1500, { seed: 51 });
        // A visitor: in the host's lobby, without the match.
        const v = world.spawn('visitor', { controls: H.SMALL_MATCH_CONTROLS, url: `http://localhost/rng/defence3/index.html?game=${hostId}&room=${hostId}` });
        v.eval('loadOrCreateLocalIdentity()');
        v.eval(`joinGame(${JSON.stringify(hostId)})`);
        assert.ok(await world.runUntil(() => host.eval(`connections.some(c => c.peer === ${JSON.stringify(v.eval('myPeerId'))})`), 10000), 'the visitor is connected');
        await world.run(500);
        assert.equal(v.eval('gameStarted'), false, 'the visitor has no match');
        // (The guest keeps every pause message it is sent.)
        g.eval(`(() => { __scratch.pauses = []; const f = _handleConnectionMessage; _handleConnectionMessage = function (conn, data) {
            if (data && data.type === 'LOCKSTEP_RESYNC_PAUSE' && data.active) __scratch.pauses.push(JSON.parse(JSON.stringify(data)));
            return f.apply(this, arguments); }; })()`);
        const t0 = world.now;
        host.eval(`_startHostResyncPause('test')`);
        assert.ok(await world.runUntil(() => !host.eval('lockstepResyncPauseActive') && !g.eval('lockstepResyncPauseActive') && g.eval('__scratch.pauses.length') > 0, 25000), 'the recovery finished');
        const took = world.now - t0;
        assert.ok(took < 5000, 'the visitor did not hold the recovery up: ' + took + ' ms');
        assert.ok(host.eval('netCounters.resyncNoMatchPeers | 0') >= 1, 'the visitor said it has no match');
        rows.push('a lobby visitor held a recovery up for nothing (' + took + ' ms)');
        // The recovery's pause again, late.
        const tick = g.eval('currentTick');
        g.eval(`_handleConnectionMessage(connections[0], __scratch.pauses[0])`);
        assert.equal(g.eval('lockstepResyncPauseActive'), false, 'not paused by the late pause');
        assert.ok(g.eval('netCounters.lateResyncPausesDropped | 0') >= 1, 'dropped as late');
        await world.run(2000);
        assert.ok(g.eval('currentTick') > tick + 20, 'the guest plays on: ' + tick + ' -> ' + g.eval('currentTick'));
        rows.push('a late pause of a finished recovery: the guest played on');
        // A second recovery passes over the visitor at once.
        const t1 = world.now;
        host.eval(`_startHostResyncPause('test 2')`);
        assert.ok(await world.runUntil(() => !host.eval('lockstepResyncPauseActive') && !g.eval('lockstepResyncPauseActive'), 25000), 'the second recovery finished');
        assert.ok(world.now - t1 < 5000, 'quick: ' + (world.now - t1) + ' ms');
        const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
        await H.playFor(world, all, 2500, { seed: 52 });
        await world.run(1500);
        H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: 'after the recoveries' });
    }
    // 18: the worker's own bundle channel, a guest's, its host replaced.
    {
        const world = new H.World({ controls: H.SMALL_MATCH_CONTROLS });
        world.simWorker = true;
        const inst = world.spawn('page');
        inst.eval('startSoloGame();');
        await world.run(3000);
        assert.ok(inst.eval('simClientActive()'), 'the worker runs the match');
        const r = JSON.parse(inst.simWorker.eval(`JSON.stringify((() => {
            const saved = _simAuto.arm, mode = _simMode, out = [];
            const bundle = (t, e) => JSON.stringify({ t: 'B', e, m: { w: packTickBundleForWire({ tick: t, packets: [], combinedChecksum: computeTickBundleChecksum(t, [], 0) }) } });
            try {
                _simMode = 'authority';
                _simAuto.arm = { ...(saved || {}), role: 'guest', host: 'hostA' };
                const t = currentTick + 50;
                _simNetMessage('hostA', {}, bundle(t, 7));
                out.push(_simSealed.has(t));
                // (Migrated: the new host counts from its own start.)
                _simAuto.arm = { ...(saved || {}), role: 'guest', host: 'hostB' };
                _simNetMessage('hostB', {}, bundle(t + 1, 0));
                out.push(_simSealed.has(t + 1));
                // (The old host's, after: not its host now.)
                _simNetMessage('hostA', {}, bundle(t + 2, 9));
                out.push(_simSealed.has(t + 2));
                _simSealed.delete(t); _simSealed.delete(t + 1); _simSealed.delete(t + 2);
            } finally { _simAuto.arm = saved; _simMode = mode; }
            return out;
        })())`));
        assert.deepEqual(r, [true, true, false], 'the old host\'s bundle, the new host\'s (a lower count), not the old one\'s after');
        rows.push("a guest's worker took the new host's bundles after a migration");
    }
    console.log('PASS multiplayer-recovery-late\n  ' + rows.join('\n  '));
})().catch(e => { console.error(e); process.exit(1); });
