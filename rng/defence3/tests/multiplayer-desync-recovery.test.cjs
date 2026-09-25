// Desync detection and recovery, including races: divergence on guests or
// the host, several at once, commands issued during a resync, peers leaving
// or reloading mid-resync, reordered messages, repeated divergence and
// exact-lockstep debug mode.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const WAN = { latencyMs: 60, jitterMs: 10 };

// Change simulated state on one peer only, the way a determinism bug would.
function corrupt(inst, kind = 'unit') {
    if (kind === 'unit') return inst.eval(`(() => { const u = units.find(u => !u.dead); u.energy = Math.max(1, u.energy - 3); u.x += 7; return u.id; })()`);
    if (kind === 'player') return inst.eval(`(addPlayerResource(0, 'energy', -123), 0)`);
    if (kind === 'mine') return inst.eval(`(() => { const m = goldMines.find(m => m.gold > 100); m.gold -= 50; return 0; })()`);
    throw new Error('kind');
}

// Time until every live instance agrees again and keeps agreeing.
async function recoverTime(world, instances, fromMs, maxMs = 15000, label = '') {
    const base = new Map(instances.map(i => [i, i.snapshotsApplied]));
    const ok = await world.runUntil(() => {
        const live = instances.filter(i => !i.dead);
        if (live.some(i => i.eval('lockstepResyncPauseActive || lockstepDesyncDetected'))) return false;
        const ticks = live.map(i => i.eval('currentTick'));
        return Math.min(...ticks) > 0 && live.every(i => i.eval('computeLockstepStateHashFast(currentTick)') !== null)
            && live.every(i => i.snapshotsApplied > base.get(i));
    }, maxMs, 20);
    assert.ok(ok, label + ' recovered within ' + maxMs + 'ms: ' + JSON.stringify(instances.filter(i => !i.dead).map(i => [i.name, i.snapshotsApplied,
        i.eval('JSON.stringify({t: currentTick, pause: lockstepResyncPauseActive, desync: lockstepDesyncDetected, dd: netCounters.desyncsDetected})'),
        i.warnings.slice(-3).map(w => JSON.stringify(w.a).slice(0, 300))])));
    return world.now - fromMs;
}

(async () => {
    const rows = [];

    // 1. One guest diverges; it is detected at the next state check and a
    // single resync restores everyone. The match keeps agreeing afterwards,
    // which also checks that snapshots restore everything that matters.
    for (const kind of ['unit', 'player', 'mine']) {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 6000, { seed: 5 });
        const t0 = world.now;
        const beforeTick = host.eval('currentTick');
        corrupt(guests[0], kind);
        const ms = await recoverTime(world, all, t0, 15000, kind);
        assert.equal(guests[0].eval('netCounters.desyncsDetected'), 1);
        assert.equal(host.eval('netCounters.hardResyncs'), 1, 'one resync');
        const fromTick = host.eval('currentTick');
        await H.playFor(world, all, 20000, { seed: 6 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 80, fromTick, label: 'after resync (' + kind + ')' });
        for (const inst of all) assert.equal(inst.snapshotsApplied, 2, kind + ': no repeated resync on ' + inst.name);
        assert.ok(ms < 1500, kind + ': recovery took ' + ms);
        assert.ok(host.eval('currentTick') > beforeTick + 300);
        rows.push(`guest ${kind} divergence recovered in ${Math.round(ms)}ms, stayed in sync for 20s after`);
    }

    // 2. The host diverges: every guest reports it, yet one resync fixes all.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 3, teams: [0, 1, 0, 1] });
        const all = [host, ...guests];
        await H.playFor(world, all, 5000, { seed: 8 });
        const t0 = world.now;
        corrupt(host, 'unit');
        const ms = await recoverTime(world, all, t0);
        const resyncs = host.eval('netCounters.hardResyncs');
        assert.ok(resyncs <= 2, 'host divergence resolved with few resyncs: ' + resyncs);
        const fromTick = host.eval('currentTick');
        await H.playFor(world, all, 8000, { seed: 9 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 40, fromTick, label: 'host divergence' });
        rows.push(`host divergence in 2v2 recovered in ${Math.round(ms)}ms with ${resyncs} resync(s)`);
    }

    // 3. Two guests diverge in the same tick.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 3, teams: [0, 1, 2, 3] });
        const all = [host, ...guests];
        await H.playFor(world, all, 4000, { seed: 10 });
        const t0 = world.now;
        corrupt(guests[0], 'unit');
        corrupt(guests[2], 'player');
        const ms = await recoverTime(world, all, t0);
        const fromTick = host.eval('currentTick');
        await H.playFor(world, all, 6000, { seed: 11 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 30, fromTick, label: 'double divergence' });
        assert.ok(host.eval('netCounters.hardResyncs') <= 2);
        rows.push(`two guests diverging together recovered in ${Math.round(ms)}ms`);
    }

    // 4. Commands issued while a resync runs are neither lost nor doubled.
    {
        const world = new H.World({ network: { latencyMs: 150, jitterMs: 20 }, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        const all = [host, ...guests];
        await H.playFor(world, all, 4000, { seed: 12 });
        corrupt(guests[0], 'unit');
        // Keep commanding through detection, pause, snapshot and resume.
        await H.playFor(world, all, 3000, { seed: 13, stepMs: 50, chance: 0.6 });
        await world.run(3000);
        const executedOnHost = new Map([...host.executedActions]);
        for (const [netId, info] of world.issued) {
            if (info.at > world.now - 2500) continue;
            assert.ok(executedOnHost.has(netId), 'command ' + netId + ' from ' + info.by + ' ran');
        }
        // Each command id runs once on every peer.
        for (const inst of all) {
            const ids = inst.eval(`JSON.stringify(Object.values(localInputBuffer).flat().map(a => a.netId))`);
            assert.ok(Array.isArray(JSON.parse(ids)));
        }
        const fromTick = host.eval('currentTick');
        await H.playFor(world, all, 5000, { seed: 14 });
        await world.run(1500);
        H.checkHealthy(world, all, { minCompared: 10, fromTick, label: 'commands during resync' });
        rows.push('commands issued during a resync all executed');
    }

    // 5. A guest disconnects in the middle of a resync; the others resume
    // without it and it rejoins afterwards.
    {
        const world = new H.World({ network: { latencyMs: 120, jitterMs: 20 }, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 4000, { seed: 15 });
        corrupt(guests[0], 'unit');
        await world.runUntil(() => host.eval('lockstepResyncPauseActive'), 3000, 5);
        world.setLink(host, guests[1], 'blackhole');
        host.eval(`connections.find(c => c.peer === ${JSON.stringify(guests[1].eval('myPeerId'))}).close()`);
        const resumed = await world.runUntil(() => !host.eval('lockstepResyncPauseActive'), 5000, 10);
        assert.ok(resumed, 'resync finished without the leaver');
        world.setLink(host, guests[1], 'up');
        const back = await world.runUntil(() => guests[1].eval('netCounters.reconnects') > 0 && !guests[1].eval('lockstepResyncPauseActive'), 20000);
        assert.ok(back, 'leaver rejoined');
        const fromTick = host.eval('currentTick') + 20;
        await H.playFor(world, all, 6000, { seed: 16 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 20, fromTick, label: 'disconnect during resync' });
        rows.push('peer lost mid-resync: others resumed, it rejoined in sync');
    }

    // 6. A page reload while a resync is still pausing the match.
    {
        const world = new H.World({ network: { latencyMs: 100, jitterMs: 10 }, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 1] });
        await H.playFor(world, [host, ...guests], 3000, { seed: 17 });
        corrupt(guests[0], 'player');
        await world.runUntil(() => host.eval('lockstepResyncPauseActive'), 3000, 5);
        const storage = guests[1].storage;
        world.kill(guests[1]);
        const fresh = world.spawn('reloaded', { storage });
        fresh.eval('loadOrCreateLocalIdentity()');
        fresh.eval(`joinGame(${JSON.stringify(hostId)})`);
        const ok = await world.runUntil(() => fresh.eval('gameStarted') && !fresh.eval('lockstepResyncPauseActive') && !host.eval('lockstepResyncPauseActive'), 20000);
        assert.ok(ok, 'reloaded player joined during/after the resync');
        const all = [host, guests[0], fresh];
        const fromTick = fresh.eval('currentTick') + 5;
        await H.playFor(world, all, 6000, { seed: 18 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 20, fromTick, label: 'reload during resync' });
        rows.push('reload during a resync joins cleanly');
    }

    // 7. Heavy jitter reorders resync messages (resume can overtake the
    // snapshot); recovery still completes.
    {
        const world = new H.World({ network: { latencyMs: 80, jitterMs: 400 }, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        for (let round = 0; round < 3; round++) {
            await H.playFor(world, all, 3000, { seed: 19 + round });
            corrupt(guests[round % 2], 'unit');
            await recoverTime(world, all, world.now, 20000);
        }
        const fromTick = host.eval('currentTick');
        await H.playFor(world, all, 6000, { seed: 30 });
        await world.run(3000);
        H.checkHealthy(world, all, { minCompared: 20, fromTick, label: 'reordered resync' });
        rows.push('3 recoveries under 400ms jitter (reordered messages)');
    }

    // 8. Divergence every 2s for 30s: recovery never gets stuck.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        const all = [host, ...guests];
        const startTick = host.eval('currentTick');
        for (let i = 0; i < 15; i++) {
            await H.playFor(world, all, 2000, { seed: 40 + i });
            corrupt(guests[0], i % 2 ? 'unit' : 'player');
        }
        await world.run(5000);
        const fromTick = host.eval('currentTick');
        await H.playFor(world, all, 5000, { seed: 60 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 10, fromTick, label: 'repeated divergence' });
        const progressed = host.eval('currentTick') - startTick;
        assert.ok(progressed > 20 * 30, 'match kept moving: ' + progressed + ' ticks in ~42s');
        rows.push(`15 divergences in 30s: all recovered, ${Math.round(progressed / 42)} TPS average`);
    }

    // 9. Exact-lockstep debug mode stops instead of recovering.
    {
        const world = new H.World({ network: WAN, controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-exact-lockstep': true } });
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        await world.run(2000);
        corrupt(guests[0], 'unit');
        await world.run(3000);
        for (const inst of [host, guests[0]]) assert.equal(inst.eval('lockstepFatalStopActive'), true, 'stopped on ' + inst.name);
        const t = host.eval('currentTick');
        await world.run(2000);
        assert.equal(host.eval('currentTick'), t, 'no ticks after the stop');
        assert.equal(host.eval('netCounters.hardResyncs'), 0);
        assert.match(guests[0].element('net-wait-overlay').innerHTML, /Exact lockstep stopped/);
        rows.push('exact-lockstep mode freezes every peer at the first mismatch');
    }

    // A bug that throws mid-tick must not freeze the match. Thrown on every
    // peer at the same tick it leaves identical partial state (no resync);
    // thrown on one guest only it is caught by the hash check and resynced.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 3000, { seed: 71 });
        const armThrow = (inst, tick) => inst.eval(`(() => {
            const orig = recomputePlayerPopCaps;
            recomputePlayerPopCaps = function () { if (currentTick === ${tick}) throw new Error('injected tick bug'); return orig.apply(this, arguments); };
        })()`);
        const t1 = world.atNextSafeTick('', 30);
        for (const i of all) armThrow(i, t1);
        const snaps = all.map(i => i.snapshotsApplied);
        await H.playFor(world, all, 4000, { seed: 72 });
        for (const i of all) {
            assert.ok(i.eval('currentTick') > t1 + 20, i.name + ' kept ticking after the error');
            assert.equal(i.eval('runtimeErrorCount'), 1, i.name + ' error counted');
            assert.ok(i.errors.length === 1 && /injected tick bug/.test(i.errors[0].message), i.name + ' error logged');
            i.errors.length = 0;
        }
        assert.deepEqual(all.map(i => i.snapshotsApplied), snaps, 'identical partial tick needs no resync');
        H.checkHealthy(world, all, { minCompared: 10, fromTick: t1 - 20, label: 'deterministic throw' });

        const t2 = world.atNextSafeTick('', 30);
        armThrow(guests[1], t2);
        await H.playFor(world, all, 6000, { seed: 73 });
        await world.run(2000);
        assert.ok(guests[1].eval('currentTick') > t2 + 40, 'the throwing guest kept going');
        guests[1].errors.length = 0;
        assert.ok(guests[1].snapshotsApplied > snaps[2], 'one-sided error repaired by a resync');
        H.checkHealthy(world, all, { minCompared: 10, fromTick: guests[1].lastSnapshotTick, label: 'one-sided throw' });
        rows.push('exception mid-tick: match keeps running; same-on-all needs no resync, one-sided is resynced');
    }

    console.log('PASS: multiplayer desync recovery\n  ' + rows.join('\n  '));
})().catch(err => { console.error(err); process.exit(1); });
