// Connection problems during a match: silent link loss, closed links, page
// reloads, dropped and leaving players, hidden tabs. The match must pause
// while a player is missing, recover quickly and stay in sync.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const WAN = { latencyMs: 60, jitterMs: 10 };

async function progressWithin(world, inst, ms) {
    const start = inst.eval('currentTick');
    const t0 = world.now;
    const ok = await world.runUntil(() => inst.eval('currentTick') > start + 5, ms, 20);
    return ok ? world.now - t0 : Infinity;
}

(async () => {
    const rows = [];

    // A: a teammate's route goes dark for 6s (messages vanish, no close
    // event). Everyone waits; when it comes back the match resumes without
    // a snapshot, using resend requests.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 3, teams: [0, 1, 0, 1] });
        const all = [host, ...guests];
        await H.playFor(world, all, 5000, { seed: 11 });
        world.setLink(host, guests[1], 'blackhole');
        await H.playFor(world, all, 6000, { seed: 12 });
        const stalledTick = host.eval('currentTick');
        assert.ok(host.eval('netGetWaitingPeerIds().length') === 1, 'host reports whom it waits for');
        const overlay = host.element('net-wait-overlay');
        assert.equal(overlay.style.display, 'block', 'waiting overlay shown');
        assert.match(overlay.innerHTML, /Waiting for players/);
        world.setLink(host, guests[1], 'up');
        const recoverMs = await progressWithin(world, host, 5000);
        assert.ok(recoverMs < 1500, 'resumed after the link came back: ' + recoverMs);
        await H.playFor(world, all, 5000, { seed: 13 });
        await world.run(2000);
        assert.ok(host.eval('currentTick') > stalledTick + 60);
        H.checkHealthy(world, all, { minCompared: 40, label: 'blackhole-6s' });
        for (const inst of all) assert.equal(inst.snapshotsApplied, 1, 'no resync needed for ' + inst.name);
        for (const inst of all) H.assertAllCommandsExecuted(world, inst, 'blackhole-6s', world.now - 2500);
        rows.push(`silent 6s outage in 2v2: resumed ${Math.round(recoverMs)}ms after the link returned, no resync`);
    }

    // B: a longer outage. The guest notices the host is silent, reconnects
    // once the route works again and resumes from its own state.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        const all = [host, ...guests];
        await H.playFor(world, all, 4000, { seed: 21 });
        world.setLink(host, guests[0], 'blackhole');
        // Commands issued while disconnected must still run later.
        await H.playFor(world, all, 20000, { seed: 22 });
        assert.ok(guests[0].eval('netCounters.reconnectAttempts') > 0, 'guest tried to reconnect');
        world.setLink(host, guests[0], 'up');
        const t0 = world.now;
        const ok = await world.runUntil(() => guests[0].eval('netCounters.softRejoins') > 0 && guests[0].eval('currentTick') > host.eval('currentTick') - 20, 20000);
        assert.ok(ok, 'guest rejoined');
        const rejoinMs = world.now - t0;
        await H.playFor(world, all, 5000, { seed: 23 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 30, label: 'reconnect' });
        for (const inst of all) assert.equal(inst.snapshotsApplied, 1, 'soft rejoin needs no snapshot: ' + inst.name);
        H.assertAllCommandsExecuted(world, guests[0], 'reconnect', world.now - 2500);
        assert.ok(rejoinMs < 12000, 'rejoin time ' + rejoinMs);
        rows.push(`20s outage: guest reconnected and resumed in ${(rejoinMs / 1000).toFixed(1)}s without a snapshot`);
    }

    // C: the host closes the link outright (a peer connection failure).
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 4000, { seed: 31 });
        host.eval(`connections.find(c => c.peer !== myPeerId && c.peer === ${JSON.stringify(guests[0].eval('myPeerId'))}).close()`);
        const t0 = world.now;
        const ok = await world.runUntil(() => guests[0].eval('netCounters.reconnects') > 0, 10000);
        assert.ok(ok, 'reconnected after close');
        const ms = world.now - t0;
        await H.playFor(world, all, 5000, { seed: 32 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 30, label: 'closed link' });
        assert.ok(ms < 3000, 'reconnect after close took ' + ms);
        rows.push(`closed link in 3-team FFA: reconnected in ${Math.round(ms)}ms`);
    }

    // D: a guest reloads the page mid-match. The fresh page rejoins as the
    // same player: it alone loads the match and catches up, while the others
    // play on without pausing or restoring anything.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 1] });
        await H.playFor(world, [host, ...guests], 5000, { seed: 41 });
        const old = guests[0];
        const storage = old.storage;
        const oldTeam = old.eval('localPlayerId');
        world.kill(old);
        await world.run(3000);
        const fresh = world.spawn('guest1-reloaded', { storage, url: `http://localhost/rng/defence3/index.html?game=${hostId}` });
        fresh.eval('loadOrCreateLocalIdentity()');
        const others = [host, guests[1]];
        const snaps = others.map(i => i.snapshotsApplied);
        fresh.eval(`joinGame(${JSON.stringify(hostId)})`);
        const t0 = world.now;
        // (Until the page is back the host waits for the missing player.)
        assert.ok(await world.runUntil(() => host.eval('resyncHostJoining.size') > 0 || fresh.eval('gameStarted'), 15000), 'join scheduled');
        const hostTick0 = host.eval('currentTick'), t1 = world.now;
        const ok = await world.runUntil(() => fresh.eval('gameStarted') && !fresh.eval('lockstepResyncPauseActive') && fresh.eval('currentTick') > 0 && !host.eval('lockstepResyncPauseActive'), 15000);
        assert.ok(ok, 'reloaded guest is back in the match');
        const joinMs = world.now - t0;
        assert.ok(await world.runUntil(() => !host.eval('resyncHostJoining.size'), 15000), 'reloaded guest caught up');
        await world.run(1000);
        const tps = (host.eval('currentTick') - hostTick0) / ((world.now - t1) / 1000);
        assert.ok(tps > 18, 'the others kept their pace while it loaded and caught up: ' + tps.toFixed(1) + ' TPS');
        assert.deepEqual(others.map(i => i.snapshotsApplied), snaps, 'nobody else restored anything');
        assert.equal(fresh.eval('localPlayerId'), oldTeam, 'same team after reload');
        const all = [host, guests[1], fresh];
        const fromTick = fresh.eval('currentTick');
        await H.playFor(world, all, 6000, { seed: 42 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 20, fromTick, label: 'reload' });
        H.assertAllCommandsExecuted(world, fresh, 'reload', world.now - 2500);
        assert.ok(joinMs < 4000, 'reload rejoin took ' + joinMs);
        rows.push(`page reload: rejoined same team in ${Math.round(joinMs)}ms; the others kept ${tps.toFixed(1)} TPS while it loaded and caught up`);
    }

    // E: a player vanishes for good in a 2v2. The host drops them; their
    // teammate keeps playing, so the team is not resigned.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 3, teams: [0, 1, 0, 1] });
        await H.playFor(world, [host, ...guests], 3000, { seed: 51 });
        const gone = guests[2];
        const goneId = gone.eval('myPeerId');
        world.kill(gone);
        await world.run(10000);
        const overlay = host.element('net-wait-overlay');
        assert.match(overlay.innerHTML, /data-net-action="drop"/, 'host offered a drop button');
        host.eval(`hostRemovePlayerFromMatch(${JSON.stringify(goneId)})`);
        const all = [host, guests[0], guests[1]];
        const ms = await progressWithin(world, host, 3000);
        assert.ok(ms < 1000, 'match resumed after the drop');
        await H.playFor(world, all, 5000, { seed: 52 });
        await world.run(2000);
        for (const inst of all) assert.equal(inst.eval('resignedTeams.size'), 0, 'team with a remaining player is not resigned');
        H.checkHealthy(world, all, { minCompared: 20, label: 'drop' });
        rows.push('player dropped in 2v2: teammate keeps the team alive');
    }

    // F: nobody clicks drop: the host drops a player gone for 3 minutes.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        world.kill(guests[1]);
        await world.run(170000);
        assert.equal(host.eval('isPeerExplicitlyRemoved(' + JSON.stringify(guests[1].eval('myPeerId')) + ')'), false, 'not dropped early');
        await world.run(15000);
        assert.equal(host.eval('isPeerExplicitlyRemoved(' + JSON.stringify(guests[1].eval('myPeerId')) + ')'), true, 'auto-dropped');
        const ms = await progressWithin(world, host, 3000);
        assert.ok(ms < 1500);
        await world.run(3000);
        H.checkHealthy(world, [host, guests[0]], { minCompared: 5, label: 'auto-drop' });
        rows.push('player gone for 3 minutes is dropped automatically');
    }

    // G: a guest leaves a 3-team match from the menu; the others continue.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        await H.playFor(world, [host, ...guests], 3000, { seed: 71 });
        const leaverTeam = guests[0].eval('localPlayerId');
        guests[0].eval(`leaveMultiplayerToMainMenu('')`);
        await world.run(3000);
        assert.equal(guests[0].eval('isMultiplayer'), false);
        assert.equal(guests[0].element('lobby-buttons').style.display, 'flex', 'leaver is back at the main menu');
        const all = [host, guests[1]];
        await H.playFor(world, all, 5000, { seed: 72 });
        await world.run(2000);
        for (const inst of all) assert.ok(inst.eval(`resignedTeams.has(${leaverTeam})`), 'leaver resigned');
        assert.equal(host.eval('gameOver'), false);
        H.checkHealthy(world, all, { minCompared: 20, label: 'leave' });
        rows.push('guest leaving a 3-team match resigns and the match continues');
    }

    // H: the host leaves a running 1v1: the guest takes over and, as the
    // host's team resigned, wins. After the match, the host leaving sends
    // the guest back to the menu.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        host.eval(`leaveMultiplayerToMainMenu('')`);
        assert.ok(await world.runUntil(() => guests[0].eval('isHost && gameOver'), 10000), 'guest took over and the match ended');
        assert.equal(guests[0].eval('winner'), guests[0].eval('localPlayerId'));
        const w2 = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const m2 = await H.startHostedMatch(w2, { guests: 1 });
        m2.host.eval('gameOver = true');
        m2.guests[0].eval('gameOver = true');
        m2.host.eval(`leaveMultiplayerToMainMenu('')`);
        await w2.run(2000);
        assert.equal(m2.guests[0].eval('gameStarted'), false);
        assert.match(m2.guests[0].element('lobby-status').textContent, /closed the lobby/i);
        rows.push('host leaving a running 1v1 hands the win to the guest; after the match it sends the guest to the menu');
    }

    // I: a hidden tab keeps ticking at full rate (worker timer), so it does
    // not slow down the other players.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        world.setHidden(guests[0], true);
        const t0 = host.eval('currentTick');
        await world.run(10000);
        const tps = (host.eval('currentTick') - t0) / 10;
        world.setHidden(guests[0], false);
        await world.run(2000);
        assert.ok(tps > 18, 'hidden guest keeps pace: ' + tps);
        H.checkHealthy(world, [host, guests[0]], { minCompared: 20, label: 'hidden' });
        rows.push(`hidden guest tab: host keeps ${tps.toFixed(1)} TPS`);
    }

    // J: a guest's tab crashes (or its network switches) and the page comes
    // straight back. The host never saw the old connection close, so the
    // same profile arrives while the old peer still looks connected: it must
    // be recognized as silent and replaced, not refused as a second tab.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        await H.playFor(world, [host, ...guests], 5000, { seed: 51 });
        const old = guests[0];
        const oldTeam = old.eval('localPlayerId');
        world.kill(old, { silent: true });
        await world.run(500);
        assert.equal(host.eval(`connections.some(c => c.peer === ${JSON.stringify(old.eval('myPeerId'))})`), true, 'host still holds the dead connection');
        const fresh = world.spawn('guest1-crashed', { storage: old.storage, url: `http://localhost/rng/defence3/index.html?game=${hostId}` });
        fresh.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(hostId)})`);
        const t0 = world.now;
        const ok = await world.runUntil(() => fresh.eval('gameStarted') && !fresh.eval('lockstepResyncPauseActive') && fresh.eval('currentTick') > 0 && !host.eval('lockstepResyncPauseActive'), 20000);
        assert.ok(ok, 'crashed guest is back in the match');
        const joinMs = world.now - t0;
        assert.equal(fresh.eval('localPlayerId'), oldTeam, 'same team after the crash');
        const all = [host, guests[1], fresh];
        const fromTick = fresh.eval('currentTick');
        await H.playFor(world, all, 6000, { seed: 52 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 20, fromTick, label: 'crash rejoin' });
        H.assertAllCommandsExecuted(world, fresh, 'crash rejoin', world.now - 2500);
        assert.ok(joinMs < 7000, 'crash rejoin took ' + joinMs);
        rows.push(`tab crash (host never saw the close): rejoined same team in ${Math.round(joinMs)}ms`);
    }

    // K: a real second tab with the same profile is turned away with a
    // message (not left hanging), and the first tab's match is unaffected.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 1 });
        const all = [host, guests[0]];
        await H.playFor(world, all, 3000, { seed: 61 });
        const twin = world.spawn('guest1-twin', { storage: guests[0].storage, url: `http://localhost/rng/defence3/index.html?game=${hostId}` });
        twin.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(hostId)})`);
        const fromTick = guests[0].eval('currentTick');
        await H.playFor(world, all, 6000, { seed: 62 });
        assert.equal(twin.element('lobby-buttons').style.display, 'flex', 'second tab is back at the main menu');
        assert.match(twin.element('lobby-status').textContent, /another tab/);
        assert.equal(twin.eval('gameStarted'), false);
        assert.equal(host.eval('getActiveMatchPeerIds().length'), 2, 'no phantom player');
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 20, fromTick, label: 'twin tab' });
        H.assertAllCommandsExecuted(world, guests[0], 'twin tab', world.now - 2500);
        rows.push('second tab with the same profile: refused with a message, match unaffected');
    }

    console.log('PASS: multiplayer disconnect/reconnect\n  ' + rows.join('\n  '));
})().catch(err => { console.error(err); process.exit(1); });
