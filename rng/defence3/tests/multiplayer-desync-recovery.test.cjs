// Desync detection and repair. A diverged guest is patched on its own (the
// others keep playing, nobody pauses); races: divergence on guests or the
// host, several at once, commands issued meanwhile, peers leaving or
// reloading while a patch is on its way, reordered and lost messages,
// repeated and persistent divergence, and exact-lockstep debug mode.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const WAN = { latencyMs: 60, jitterMs: 10 };

// Change simulated state on one peer only, the way a determinism bug would.
function corrupt(inst, kind = 'unit') {
    if (kind === 'unit') return inst.eval(`(() => { const u = units.find(u => !u.dead); u.energy = Math.max(1, u.energy - 3); u.x += 7; return u.id; })()`);
    if (kind === 'player') return inst.eval(`(addPlayerResource(0, 'energy', -123), 0)`);
    if (kind === 'mine') return inst.eval(`(() => { const m = goldMines.find(m => m.gold > 100); m.gold -= 50; return 0; })()`);
    if (kind === 'building') return inst.eval(`(() => { const b = [...towers, ...barracks, ...collectorSpawners].find(b => b.energy > 10); b.energy -= 5; b.spawnTimer = (b.spawnTimer || 0) + 3; return 0; })()`);
    throw new Error('kind');
}

const repairs = i => i.patchesApplied + i.snapshotsApplied;
const stallMs = i => i.eval('netCounters.stallMs');

// Wait until each of `patched` got a repair (and nothing is in flight).
async function awaitRepair(world, instances, patched, maxMs = 15000, label = '') {
    const base = new Map(instances.map(i => [i, repairs(i)]));
    const t0 = world.now;
    const ok = await world.runUntil(() => {
        const live = instances.filter(i => !i.dead);
        if (live.some(i => i.eval('lockstepResyncPauseActive'))) return false;
        if (!patched.every(i => i.dead || repairs(i) > base.get(i))) return false;
        return live.every(i => i.eval('isHost ? resyncHostPending.size === 0 : (resyncGuest.T < 0 && !resyncGuest.outstanding)'));
    }, maxMs, 20);
    assert.ok(ok, label + ' repaired within ' + maxMs + 'ms: ' + JSON.stringify(instances.filter(i => !i.dead).map(i => [i.name, i.patchesApplied, i.snapshotsApplied,
        i.eval('JSON.stringify({t: currentTick, pause: lockstepResyncPauseActive, g: isHost ? [...resyncHostPending.values()].map(p => p.T) : resyncGuest, dd: netCounters.desyncsDetected})'),
        i.warnings.slice(-3).map(w => JSON.stringify(w.a).slice(0, 300))])));
    return world.now - t0;
}

// Every command issued before `before` ran once on every live instance.
function assertCommandsRanEverywhere(world, instances, before, label) {
    for (const inst of instances.filter(i => !i.dead)) {
        const missing = [];
        for (const [netId, info] of world.issued) if (info.at <= before && !inst.executedActions.has(netId)) missing.push(netId);
        assert.deepEqual(missing, [], label + ': commands missing on ' + inst.name);
    }
}

(async () => {
    const rows = [];

    // 1. One guest diverges: only it is patched, the host and the other
    // guest do not wait. The match keeps agreeing afterwards, which also
    // checks that patches carry everything that matters.
    for (const kind of ['unit', 'player', 'mine', 'building']) {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 6000, { seed: 5 });
        const beforeTick = host.eval('currentTick');
        const stalls = all.map(stallMs);
        const snaps = all.map(i => i.snapshotsApplied);
        corrupt(guests[0], kind);
        const ms = await awaitRepair(world, all, [guests[0]], 15000, kind);
        const stalled = all.map((i, k) => Math.round(stallMs(i) - stalls[k]));
        assert.ok(guests[0].eval('netCounters.desyncsDetected') >= 1);
        assert.equal(guests[0].patchesApplied, 1, kind + ': one patch');
        assert.equal(host.patchesApplied + guests[1].patchesApplied, 0, kind + ': nobody else patched');
        assert.deepEqual(all.map(i => i.snapshotsApplied), snaps, kind + ': no match-wide resync');
        assert.ok(stalled[0] < 150 && stalled[2] < 150, kind + ': host and other guest kept playing (stalled ' + stalled.join('/') + ' ms)');
        const fromTick = host.eval('currentTick');
        await H.playFor(world, all, 20000, { seed: 6 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 80, fromTick, label: 'after patch (' + kind + ')' });
        for (const inst of all) assert.equal(repairs(inst), (inst === guests[0] ? 2 : 1), kind + ': no repeated repair on ' + inst.name);
        assert.ok(ms < 1500, kind + ': repair took ' + ms);
        assert.ok(host.eval('currentTick') > beforeTick + 300);
        rows.push(`guest ${kind} divergence patched in ${Math.round(ms)}ms (guest waited ${Math.round(guests[0].eval('netCounters.patchStallMs'))}ms, others ${stalled[0]}/${stalled[2]}ms), in sync 20s after`);
    }

    // 2. The host diverges: every guest reports it and each is patched to
    // the host's state.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 3, teams: [0, 1, 0, 1] });
        const all = [host, ...guests];
        await H.playFor(world, all, 5000, { seed: 8 });
        corrupt(host, 'unit');
        const ms = await awaitRepair(world, all, guests);
        for (const g of guests) assert.ok(g.patchesApplied >= 1 && g.patchesApplied <= 2, 'patches on ' + g.name + ': ' + g.patchesApplied);
        assert.equal(host.snapshotsApplied, 1, 'no match-wide resync');
        const fromTick = host.eval('currentTick');
        await H.playFor(world, all, 8000, { seed: 9 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 40, fromTick, label: 'host divergence' });
        rows.push(`host divergence in 2v2: each guest patched, in ${Math.round(ms)}ms`);
    }

    // 3. Two guests diverge in the same tick, differently.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 3, teams: [0, 1, 2, 3] });
        const all = [host, ...guests];
        await H.playFor(world, all, 4000, { seed: 10 });
        corrupt(guests[0], 'unit');
        corrupt(guests[2], 'player');
        const ms = await awaitRepair(world, all, [guests[0], guests[2]]);
        assert.equal(guests[1].patchesApplied, 0);
        const fromTick = host.eval('currentTick');
        await H.playFor(world, all, 6000, { seed: 11 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 30, fromTick, label: 'double divergence' });
        rows.push(`two guests diverging together patched in ${Math.round(ms)}ms`);
    }

    // 4. Commands issued while a patch is on its way are neither lost nor
    // doubled, on every peer.
    {
        const world = new H.World({ network: { latencyMs: 150, jitterMs: 20 }, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 4000, { seed: 12 });
        corrupt(guests[0], 'unit');
        await H.playFor(world, all, 3000, { seed: 13, stepMs: 50, chance: 0.6 });
        await world.run(3000);
        assert.ok(guests[0].patchesApplied >= 1);
        assertCommandsRanEverywhere(world, all, world.now - 2500, 'commands during patch');
        const fromTick = host.eval('currentTick');
        await H.playFor(world, all, 5000, { seed: 14 });
        await world.run(1500);
        H.checkHealthy(world, all, { minCompared: 10, fromTick, label: 'commands during patch' });
        rows.push('commands issued while a patch was pending ran once everywhere');
    }

    // 5. Disconnects while a patch is pending: another guest dropping out
    // (the match waits for it) does not lose the patch; the patched guest
    // dropping out rejoins in sync.
    {
        const world = new H.World({ network: { latencyMs: 120, jitterMs: 20 }, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 4000, { seed: 15 });
        const base = repairs(guests[0]);
        corrupt(guests[0], 'unit');
        assert.ok(await world.runUntil(() => host.eval('resyncHostPending.size > 0'), 3000, 5), 'patch scheduled');
        world.setLink(host, guests[1], 'blackhole');
        host.eval(`connections.find(c => c.peer === ${JSON.stringify(guests[1].eval('myPeerId'))}).close()`);
        await world.run(1500);
        world.setLink(host, guests[1], 'up');
        assert.ok(await world.runUntil(() => guests[1].eval('netCounters.reconnects') > 0 && guests[1].eval('gameStarted && !lockstepResyncPauseActive'), 20000), 'leaver rejoined');
        assert.ok(await world.runUntil(() => repairs(guests[0]) > base && guests[0].eval('resyncGuest.T < 0'), 20000), 'patched while another guest dropped out');

        corrupt(guests[1], 'player');
        assert.ok(await world.runUntil(() => host.eval('resyncHostPending.size > 0'), 3000, 5), 'second patch scheduled');
        world.setLink(host, guests[1], 'blackhole');
        host.eval(`connections.find(c => c.peer === ${JSON.stringify(guests[1].eval('myPeerId'))}).close()`);
        await world.run(1500);
        world.setLink(host, guests[1], 'up');
        assert.ok(await world.runUntil(() => guests[1].eval('netCounters.reconnects') > 1 && guests[1].eval('gameStarted && !lockstepResyncPauseActive && resyncGuest.T < 0'), 20000), 'patched guest rejoined');
        const fromTick = host.eval('currentTick') + 20;
        await H.playFor(world, all, 6000, { seed: 16 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 20, fromTick, label: 'disconnect during patch' });
        rows.push('disconnects mid-patch: the patch survives another guest dropping out; the patched one rejoins in sync');
    }

    // 6. The diverged guest reloads its page while its patch is pending.
    {
        const world = new H.World({ network: { latencyMs: 100, jitterMs: 10 }, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 1] });
        await H.playFor(world, [host, ...guests], 3000, { seed: 17 });
        corrupt(guests[1], 'player');
        assert.ok(await world.runUntil(() => host.eval('resyncHostPending.size > 0'), 3000, 5), 'patch scheduled');
        const storage = guests[1].storage;
        world.kill(guests[1]);
        const fresh = world.spawn('reloaded', { storage });
        fresh.eval('loadOrCreateLocalIdentity()');
        fresh.eval(`joinGame(${JSON.stringify(hostId)})`);
        const ok = await world.runUntil(() => fresh.eval('gameStarted') && !fresh.eval('lockstepResyncPauseActive') && !host.eval('lockstepResyncPauseActive'), 20000);
        assert.ok(ok, 'reloaded player joined');
        const all = [host, guests[0], fresh];
        const fromTick = fresh.eval('currentTick') + 5;
        await H.playFor(world, all, 6000, { seed: 18 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 20, fromTick, label: 'reload during patch' });
        rows.push('reload while a patch is pending joins cleanly');
    }

    // 7. Heavy jitter reorders messages (hash sums, RESYNC_AT and the patch
    // overtake each other); repairs still complete.
    {
        const world = new H.World({ network: { latencyMs: 80, jitterMs: 400 }, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        for (let round = 0; round < 3; round++) {
            await H.playFor(world, all, 3000, { seed: 19 + round });
            corrupt(guests[round % 2], 'unit');
            await awaitRepair(world, all, [guests[round % 2]], 20000, 'jitter round ' + round);
        }
        const fromTick = host.eval('currentTick');
        await H.playFor(world, all, 6000, { seed: 30 });
        await world.run(3000);
        H.checkHealthy(world, all, { minCompared: 20, fromTick, label: 'reordered messages' });
        assert.equal(host.snapshotsApplied, 1, 'no match-wide resync');
        rows.push('3 repairs under 400ms jitter (reordered messages)');
    }

    // 8. Divergence every 2s for 30s: repair never gets stuck and the
    // match keeps its pace.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        const all = [host, ...guests];
        const startTick = host.eval('currentTick');
        const t0 = world.now;
        for (let i = 0; i < 15; i++) {
            await H.playFor(world, all, 2000, { seed: 40 + i });
            corrupt(guests[0], i % 2 ? 'unit' : 'player');
        }
        await world.run(5000);
        const fromTick = host.eval('currentTick');
        await H.playFor(world, all, 5000, { seed: 60 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 10, fromTick, label: 'repeated divergence' });
        const secs = (world.now - t0) / 1000;
        const tps = (host.eval('currentTick') - startTick) / secs;
        const rate = host.eval('TICK_RATE');
        assert.ok(tps > rate * 0.95, 'match kept its pace: ' + tps.toFixed(1) + ' TPS');
        assert.ok(guests[0].patchesApplied >= 14, 'each divergence patched: ' + guests[0].patchesApplied);
        assert.equal(host.snapshotsApplied, 1, 'no match-wide resync');
        rows.push(`15 divergences in 30s: all patched, ${tps.toFixed(1)} of ${rate} TPS`);
    }

    // 9. A patch lost in transit: the guest gives up waiting, keeps
    // playing and asks again.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 3000, { seed: 80 });
        host.eval(`(() => {
            const c = connections.find(c => c.peer === ${JSON.stringify(guests[0].eval('myPeerId'))});
            const send = c.send.bind(c); let dropped = 0;
            c.send = m => { if (m && m.type === 'RESYNC_PATCH' && dropped++ === 0) return; return send(m); };
        })()`);
        const stalls = all.map(stallMs);
        corrupt(guests[0], 'unit');
        const ms = await awaitRepair(world, all, [guests[0]], 20000, 'lost patch');
        const stalled = all.map((i, k) => Math.round(stallMs(i) - stalls[k]));
        assert.ok(stalled[0] < 150 && stalled[2] < 150, 'others kept playing: ' + stalled.join('/'));
        await H.playFor(world, all, 5000, { seed: 81 });
        await world.run(2000);
        // (The first repair may be followed by one for what spread while the
        // guest waited.)
        assert.ok(guests[0].patchesApplied <= 2, 'patches: ' + guests[0].patchesApplied);
        H.checkHealthy(world, all, { minCompared: 20, fromTick: guests[0].lastSnapshotTick, label: 'lost patch' });
        rows.push(`lost patch: guest waited ${Math.round(guests[0].eval('netCounters.patchStallMaxMs'))}ms at most, re-asked and was patched after ${Math.round(ms)}ms; others unaffected`);
    }

    // 10. A persistent bug on one guest (diverges again every 1.5s): repairs
    // escalate (delta, full, at most one reload of the match on that guest
    // alone) and the others never pause.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 3000, { seed: 90 });
        const startTick = host.eval('currentTick');
        const t0 = world.now;
        guests[0].eval(`(() => {
            const orig = runOneTick;
            runOneTick = function () { const r = orig.apply(this, arguments); if (currentTick % 30 === 0) { const u = units.find(u => !u.dead); if (u) u.x += 3; } return r; };
        })()`);
        await H.playFor(world, all, 40000, { seed: 91 });
        const secs = (world.now - t0) / 1000;
        const tps = (host.eval('currentTick') - startTick) / secs;
        const g = guests[0];
        assert.ok(g.patchesApplied >= 10, 'kept patching: ' + g.patchesApplied);
        assert.ok(g.fullPatchesApplied >= 1, 'escalated to full patches');
        assert.equal(host.snapshotsApplied + guests[1].snapshotsApplied, 2, 'the others never restored anything');
        assert.ok(g.snapshotsApplied <= 2, 'at most one reload of the match on the buggy guest: ' + g.snapshotsApplied);
        assert.ok(tps > host.eval('TICK_RATE') * 0.9, 'match kept moving: ' + tps.toFixed(1) + ' TPS');
        for (const i of all) assert.deepEqual(i.errors, [], i.name + ' threw');
        rows.push(`persistent bug on a guest for 40s: ${g.patchesApplied} patches (${g.fullPatchesApplied} full), ${g.snapshotsApplied - 1} reload(s) of the match on it alone, ${tps.toFixed(1)} TPS`);
    }

    // 11. Exact-lockstep debug mode stops instead of repairing.
    {
        const world = new H.World({ network: WAN, controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-exact-lockstep': true } });
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        await world.run(2000);
        const movedId = corrupt(guests[0], 'unit');
        await world.run(3000);
        for (const inst of [host, guests[0]]) assert.equal(inst.eval('lockstepFatalStopActive'), true, 'stopped on ' + inst.name);
        const t = host.eval('currentTick');
        await world.run(2000);
        assert.equal(host.eval('currentTick'), t, 'no ticks after the stop');
        assert.equal(repairs(guests[0]), 1, 'no repair');
        assert.match(guests[0].element('net-wait-overlay').innerHTML, /Exact lockstep stopped/);
        // Everyone is told what differs: the moved unit's tiles.
        for (const inst of [host, guests[0]]) assert.match(inst.eval('lockstepFatalStopReason'), new RegExp('unit ' + movedId + ' '), inst.name + ': ' + inst.eval('lockstepFatalStopReason'));
        rows.push('exact-lockstep mode freezes every peer at the first mismatch and names what differs: ' + host.eval('lockstepFatalStopReason').slice(0, 120));
    }

    // 12. A bug that throws mid-tick must not freeze the match. Thrown on
    // every peer at the same tick it leaves identical partial state (no
    // repair); thrown on one guest only it is caught and patched.
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
        const before = all.map(repairs);
        await H.playFor(world, all, 4000, { seed: 72 });
        for (const i of all) {
            assert.ok(i.eval('currentTick') > t1 + 20, i.name + ' kept ticking after the error');
            assert.equal(i.eval('runtimeErrorCount'), 1, i.name + ' error counted');
            assert.ok(i.errors.length === 1 && /injected tick bug/.test(i.errors[0].message), i.name + ' error logged');
            i.errors.length = 0;
        }
        assert.deepEqual(all.map(repairs), before, 'identical partial tick needs no repair');
        H.checkHealthy(world, all, { minCompared: 10, fromTick: t1 - 20, label: 'deterministic throw' });

        const t2 = world.atNextSafeTick('', 30);
        armThrow(guests[1], t2);
        await H.playFor(world, all, 6000, { seed: 73 });
        await world.run(2000);
        assert.ok(guests[1].eval('currentTick') > t2 + 40, 'the throwing guest kept going');
        guests[1].errors.length = 0;
        assert.ok(guests[1].patchesApplied > 0, 'one-sided error repaired by a patch');
        H.checkHealthy(world, all, { minCompared: 10, fromTick: guests[1].lastSnapshotTick, label: 'one-sided throw' });
        rows.push('exception mid-tick: match keeps running; same-on-all needs no repair, one-sided is patched');
    }

    console.log('PASS: multiplayer desync recovery\n  ' + rows.join('\n  '));
})().catch(err => { console.error(err); process.exit(1); });
