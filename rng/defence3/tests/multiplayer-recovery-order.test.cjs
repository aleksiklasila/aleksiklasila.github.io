// Recovery messages out of order, refused or broken (audit 2026-10-16,
// MULTIPLAYER_AUDIT_2026-10-15.md 22, 24, 28, 29, 30):
// 22. A recovery's messages are numbered by their host: a replayed older
//     snapshot no longer restores an old state (a guest went back from tick
//     425 to 386, paused), an older recovery's resume no longer ends a newer
//     one's pause, and a patch that finishes decoding after a host change is
//     dropped.
// 28. A snapshot the decoder refuses (another format), or one the guest's
//     simulation worker cannot restore, is neither counted nor acknowledged
//     as applied; the guest gets the match again and plays on.
// 29. A newer repair's patch that comes before its announcement is kept (it
//     was dropped, the guest then waited for it again).
// 30. A malformed patch no longer holds the page's ticks for good: dropped,
//     the match asked for again (page and worker).
// 24. A guest's worker takes no bundle of another match over its own
//     channel, and drops the host's sealed ticks of an older state.
//   node tests/multiplayer-recovery-order.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 50, jitterMs: 5 };
// ONLY=22,30: those findings' parts alone (each fails on the code before its fix).
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const part = n => !ONLY || ONLY.includes(String(n));

// The guest keeps every recovery message it is sent (the objects as they
// came); __scratch.dropSnap: the next snapshot is kept but not handled.
const CAPTURE = `(() => {
    __scratch.rec = [];
    const f = _handleConnectionMessage;
    _handleConnectionMessage = function (conn, data) {
        if (data && (data.type === 'LOCKSTEP_RESYNC_PAUSE' || data.type === 'MATCH_STATE_SNAPSHOT')) {
            __scratch.rec.push(data);
            if (data.type === 'MATCH_STATE_SNAPSHOT' && __scratch.dropSnap) { __scratch.dropSnap = false; return; }
        }
        return f.apply(this, arguments);
    };
})()`;
// The host counts the snapshot acknowledgements, by session.
const ACKS = `(() => {
    __scratch.acks = {};
    const f = _handleConnectionMessage;
    _handleConnectionMessage = function (conn, data) {
        if (data && data.type === 'MATCH_STATE_SNAPSHOT_APPLIED') __scratch.acks[data.sessionId] = (__scratch.acks[data.sessionId] || 0) + 1;
        return f.apply(this, arguments);
    };
})()`;
const idle = (world, insts) => world.runUntil(() => insts.every(i => i.eval('gameStarted && !lockstepResyncPauseActive && !(typeof simClientLostPending === "function" && simClientLostPending())')), 40000, 100);
const tickOn = async (world, insts, ms = 2000) => {
    const t = insts.map(i => i.eval('currentTick'));
    await world.run(ms);
    insts.forEach((i, k) => assert.ok(i.eval('currentTick') > t[k] + 10, i.name + ' ticks on: ' + t[k] + ' -> ' + i.eval('currentTick')));
};
const healthy = async (world, all, seed, label) => {
    const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
    await H.playFor(world, all, 2500, { seed });
    await world.run(1500);
    H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label });
};

(async () => {
    const rows = [];
    for (const simWorker of [false, true]) {
        const mode = simWorker ? 'worker' : 'page';
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        world.simWorker = simWorker;
        const { host, guests } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
        const g = guests[0], all = [host, g];
        await H.playFor(world, all, 1500, { seed: 71 });
        g.eval(CAPTURE);
        host.eval(ACKS);
        const recover = async label => {
            host.eval(`_startHostResyncPause(${JSON.stringify(label)})`);
            assert.ok(await world.runUntil(() => !host.eval('lockstepResyncPauseActive') && !g.eval('lockstepResyncPauseActive'), 25000), label + ' finished');
        };
        const snaps = () => JSON.parse(g.eval('JSON.stringify(__scratch.rec.map((m, i) => [i, m.type, m.sessionId, !!m.active]))'));
        // 22: two recoveries, then the first one's snapshot again.
        if (part(22)) {
        await recover('first');
        const s1 = snaps().find(r => r[1] === 'MATCH_STATE_SNAPSHOT');
        const r1 = snaps().find(r => r[1] === 'LOCKSTEP_RESYNC_PAUSE' && !r[3] && r[2] === s1[2]);
        assert.ok(s1 && r1, 'the first recovery seen');
        await H.playFor(world, all, 1500, { seed: 72 });
        await recover('second');
        await world.run(1500);
        const before = g.eval('currentTick'), dropped0 = g.eval('netCounters.staleRecoveryDropped | 0');
        g.eval(`_handleConnectionMessage(connections[0], __scratch.rec[${s1[0]}])`);
        await world.run(600);
        assert.equal(g.eval('lockstepResyncPauseActive'), false, mode + ': not paused by the old snapshot');
        assert.ok(g.eval('currentTick') >= before, mode + ': no roll back: ' + before + ' -> ' + g.eval('currentTick'));
        assert.ok(g.eval('netCounters.staleRecoveryDropped | 0') > dropped0, mode + ': dropped as an older recovery\'s');
        rows.push(mode + ': an older recovery\'s snapshot replayed: dropped, no roll back');
        // 22: a third recovery whose snapshot is held back; the first one's
        // resume meanwhile does not end its pause.
        g.eval('__scratch.dropSnap = true');
        const n = g.eval('__scratch.rec.length');
        host.eval(`_startHostResyncPause('third')`);
        assert.ok(await world.runUntil(() => g.eval('lockstepResyncPauseActive') && g.eval(`__scratch.rec.slice(${n}).some(m => m.type === 'MATCH_STATE_SNAPSHOT')`), 10000), 'the third recovery paused the guest');
        g.eval(`_handleConnectionMessage(connections[0], __scratch.rec[${r1[0]}])`);
        await world.run(300);
        assert.equal(g.eval('lockstepResyncPauseActive'), true, mode + ': an older recovery\'s resume does not end the pause');
        g.eval(`_handleConnectionMessage(connections[0], __scratch.rec.slice(${n}).find(m => m.type === 'MATCH_STATE_SNAPSHOT'))`);
        assert.ok(await world.runUntil(() => !host.eval('lockstepResyncPauseActive') && !g.eval('lockstepResyncPauseActive'), 10000), mode + ': the third recovery finished once its snapshot came');
        await tickOn(world, all);
        rows.push(mode + ': an older recovery\'s resume left a newer one\'s pause alone');
        // 22: a patch that finishes decoding after a host change.
        const ph = JSON.parse(g.eval(`JSON.stringify((() => { __scratch.maxId = resyncGuest.maxId; __scratch.host = wsHostId;
            resyncGuestHandlePatch({ tick: currentTick + 300, id: resyncGuest.maxId + 1, full: false, m: matchStartSessionId, payload: { json: '{"v":7}' } });
            wsHostId = 'another-host'; return 1; })())`));
        assert.equal(ph, 1);
        await new Promise(r => setImmediate(r));
        const patched = JSON.parse(g.eval(`JSON.stringify((() => { wsHostId = __scratch.host; const r = [resyncGuest.patch, resyncGuest.T];
            resyncGuest.maxId = __scratch.maxId; resyncGuest.idHost = wsHostId; return r; })())`));
        assert.deepEqual(patched, [null, -1], mode + ': a patch of the former host is dropped');
        rows.push(mode + ': a patch decoded across a host change: dropped');
        }
        // 29: a newer repair's patch before its announcement.
        if (part(29)) {
        const order = JSON.parse(g.eval(`JSON.stringify((() => { __scratch.maxId = resyncGuest.maxId; __scratch.t = currentTick; const id = resyncGuest.maxId + 1;
            resyncGuestHandleAt({ tick: __scratch.t + 300, id, full: false, m: matchStartSessionId });
            resyncGuestHandlePatch({ tick: __scratch.t + 400, id: id + 1, full: false, m: matchStartSessionId, payload: { json: '{"v":7}' } });
            return id; })())`));
        await new Promise(r => setImmediate(r));
        const kept = JSON.parse(g.eval(`JSON.stringify((() => { resyncGuestHandleAt({ tick: __scratch.t + 400, id: ${order + 1}, full: false, m: matchStartSessionId });
            const r = { T: resyncGuest.T - __scratch.t, patch: resyncGuest.patch ? resyncGuest.patch.id : null };
            resyncGuest.T = -1; resyncGuest.patch = null; resyncGuest.maxId = __scratch.maxId; return r; })())`));
        assert.deepEqual(kept, { T: 400, patch: order + 1 }, mode + ': the patch that came first is kept for its announcement');
        rows.push(mode + ': a newer repair\'s patch before its announcement: kept, applied at its tick');
        }
        // 30: a malformed patch at a tick just ahead.
        if (part(30)) {
        const failed0 = g.eval('netCounters.patchesFailed | 0');
        const T = g.eval('currentTick') + 6;
        g.eval(`(() => { const id = resyncGuest.maxId + 1;
            resyncGuestHandleAt({ tick: ${T}, id, full: false, m: matchStartSessionId });
            resyncGuestHandlePatch({ tick: ${T}, id, full: false, m: matchStartSessionId, payload: { json: '{"v":' } }); })()`);
        // (Counted before the match's reload starts the counters again.)
        await world.runUntil(() => g.eval(`currentTick > ${T} || (netCounters.patchesFailed | 0) > ${failed0}`), 5000);
        const counted = g.eval('netCounters.patchesFailed | 0') > failed0;
        assert.ok(await world.runUntil(() => g.eval(`currentTick > ${T} + 10 && !lockstepResyncPauseActive`), 15000), mode + ': the guest goes on past the patch tick: ' + T + ' -> ' + g.eval('currentTick'));
        assert.ok(await idle(world, all), mode + ': the guest is back');
        assert.ok(counted, mode + ': the malformed patch counted as failed');
        await tickOn(world, all);
        rows.push(mode + ': a malformed patch: dropped, the match got again, ticking');
        }
        // 28: a snapshot in a format the decoder refuses.
        if (part(28)) {
        const refused0 = g.eval('netCounters.snapshotsRefused | 0'), hard0 = g.eval('netCounters.hardResyncs');
        // (Numbered past the host's last recovery.)
        const gen = host.eval(`typeof _hostResyncGen === 'number' ? _hostResyncGen + 1 : 0`);
        g.eval(`_handleConnectionMessage(connections[0], { type: 'MATCH_STATE_SNAPSHOT', sessionId: 'refused-1', tick: currentTick, g: ${gen}, m: matchStartSessionId,
            payload: { json: JSON.stringify({ currentTick, state: { v: -999 } }) } })`);
        // (Read before the match's reload starts the counters again.)
        await world.run(150);
        assert.equal(host.eval(`__scratch.acks['refused-1'] | 0`), 0, mode + ': not acknowledged');
        assert.equal(g.eval('netCounters.hardResyncs'), hard0, mode + ': not counted as applied');
        assert.ok(g.eval('netCounters.snapshotsRefused | 0') > refused0, mode + ': counted as refused');
        assert.ok(await idle(world, all), mode + ': the guest is back after a refused snapshot');
        await tickOn(world, all);
        rows.push(mode + ': a snapshot the decoder refused: not acknowledged nor counted; the match got again');
        if (simWorker) {
            // 28: the worker cannot restore the snapshot the page took.
            g.simWorker.eval(`(() => { const f = applyAuthoritativeStateSnapshot; applyAuthoritativeStateSnapshot = function () { applyAuthoritativeStateSnapshot = f; throw new Error('injected restore failure'); }; })()`);
            const r0 = g.eval('netCounters.snapshotsRefused | 0'), k = g.eval('__scratch.rec.length');
            host.eval(`_startHostResyncPause('worker refuses')`);
            assert.ok(await world.runUntil(() => g.eval('netCounters.snapshotsRefused | 0') > r0, 20000), 'worker: the failed restore is refused');
            const sid = g.eval(`(__scratch.rec.slice(${k}).find(m => m.type === 'MATCH_STATE_SNAPSHOT') || {}).sessionId`);
            assert.ok(await idle(world, all), 'worker: the guest is back after its worker failed to restore');
            assert.equal(host.eval(`__scratch.acks[${JSON.stringify(sid)}] | 0`), 0, 'worker: the failed restore is not acknowledged');
            await tickOn(world, all);
            rows.push('worker: a restore the worker could not make: not acknowledged; the match got again');
        }
        }
        for (const i of all) i.errors = i.errors.filter(e => !/injected restore failure|could not restore the match|lost during the match|simulation worker was lost|request applyPatch|JSON/.test(String(e && e.message || e)));
        await healthy(world, all, 73, mode + ' recovery order');
    }
    // 24: a guest's worker and its own bundle channel.
    if (part(24)) {
        const world = new H.World({ controls: H.SMALL_MATCH_CONTROLS });
        world.simWorker = true;
        const inst = world.spawn('page');
        inst.eval('startSoloGame();');
        await world.run(3000);
        assert.ok(inst.eval('simClientActive()'), 'the worker runs the match');
        const r = JSON.parse(inst.simWorker.eval(`JSON.stringify((() => {
            const saved = _simAuto.arm, mode = _simMode, session = matchStartSessionId, out = [];
            const bundle = (t, e, m) => { const w = packTickBundleForWire({ tick: t, packets: [], combinedChecksum: computeTickBundleChecksum(t, [], 0) }); if (m === null) delete w.m; else w.m = m; return JSON.stringify({ t: 'B', e, m: { w } }); };
            try {
                _simMode = 'authority';
                matchStartSessionId = 'this-match';
                _simAuto.arm = { ...(saved || {}), role: 'guest', host: 'hostA' };
                const t = currentTick + 50;
                _simNetMessage('hostA', {}, bundle(t, 3, 'previous-match'));
                out.push(_simSealed.has(t));
                _simNetMessage('hostA', {}, bundle(t, 3, null));
                out.push(_simSealed.has(t));
                _simNetMessage('hostA', {}, bundle(t, 3, 'this-match'));
                out.push(_simSealed.has(t));
                // (The host restored: a newer state's bundle drops the older's.)
                _simNetMessage('hostA', {}, bundle(t + 1, 4, 'this-match'));
                out.push(_simSealed.has(t), _simSealed.has(t + 1));
                _simSealed.delete(t); _simSealed.delete(t + 1);
            } finally { _simAuto.arm = saved; _simMode = mode; matchStartSessionId = session; }
            return out;
        })())`));
        assert.deepEqual(r, [false, false, true, false, true], 'another match\'s and an untagged bundle refused; this match\'s taken; an older state\'s dropped');
        rows.push("a guest's worker took no bundle of another match, and dropped an older state's");
    }
    console.log('PASS multiplayer-recovery-order\n  ' + rows.join('\n  '));
})().catch(e => { console.error(e); process.exit(1); });
