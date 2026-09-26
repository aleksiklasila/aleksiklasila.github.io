// Lobby flows: dead or wrong game links, leaving and closing lobbies, the
// way back to single player, the Auto network setting reaching guests,
// joining while a match is starting, and spectating.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const WAN = { latencyMs: 60, jitterMs: 10 };
const url = id => `http://localhost/rng/defence3/index.html?game=${id}&room=${id}`;

async function lobby(world, guests = 1) {
    const host = world.spawn('host');
    host.eval('loadOrCreateLocalIdentity(); hostOnlineGame();');
    assert.ok(await world.runUntil(() => !!host.eval('myPeerId'), 5000));
    const hostId = host.eval('myPeerId');
    const list = [];
    for (let i = 0; i < guests; i++) {
        const g = world.spawn('guest' + (i + 1), { url: url(hostId) });
        g.eval('loadOrCreateLocalIdentity()');
        g.eval(`joinGame(${JSON.stringify(hostId)})`);
        list.push(g);
    }
    assert.ok(await world.runUntil(() => host.eval('lobbyPlayers.length') === guests + 1 && list.every(g => g.eval('lobbyPlayers.length') === guests + 1), 10000), 'lobby filled');
    return { host, guests: list, hostId };
}

(async () => {
    const rows = [];

    // A link to a game that does not exist returns to the main menu with a
    // message, and clears the invite from the address bar.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const g = world.spawn('lost', { url: url('no-such-game') });
        g.eval('loadOrCreateLocalIdentity(); joinGame("no-such-game")');
        assert.ok(await world.runUntil(() => g.element('lobby-buttons').style.display === 'flex', 20000), 'back at the main menu');
        assert.match(g.element('lobby-status').textContent, /Could not/);
        assert.equal(g.window.location.search.includes('game='), false, 'invite removed from the URL');
        assert.equal(g.eval('isMultiplayer'), false);
        g.eval('startSoloGame()');
        assert.equal(g.eval('gameStarted && !isMultiplayer'), true, 'single player works afterwards');
        rows.push('missing game: back to the menu with a message, URL cleaned, solo playable');
    }

    // A host that never answers (unreachable) times out the same way.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const h2 = world.spawn('silent-host');
        h2.eval('loadOrCreateLocalIdentity(); hostOnlineGame();');
        await world.runUntil(() => !!h2.eval('myPeerId'), 5000);
        const g = world.spawn('waiter');
        world.setLink(h2, g, 'blackhole');
        g.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(h2.eval('myPeerId'))})`);
        assert.ok(await world.runUntil(() => g.element('lobby-buttons').style.display === 'flex', 25000), 'gave up and returned to the menu');
        rows.push('unreachable host: join times out to the menu');
    }

    // Leaving a lobby, closing a lobby, and a host going back to single play.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await lobby(world, 2);
        guests[0].eval('leaveOnlineLobby()');
        assert.ok(await world.runUntil(() => host.eval('lobbyPlayers.length') === 2 && guests[1].eval('lobbyPlayers.length') === 2 && guests[0].element('lobby-buttons').style.display === 'flex', 5000), 'others see the guest leave; leaver is at the main menu');
        host.eval('leaveOnlineLobby()');
        assert.ok(await world.runUntil(() => guests[1].element('lobby-buttons').style.display === 'flex' && !host.eval('isHost'), 5000), 'guest sent home when the host closes');
        assert.match(guests[1].element('lobby-status').textContent, /closed the lobby/);
        assert.equal(host.eval('isHost || isMultiplayer'), false);
        host.eval('startSoloGame()');
        assert.equal(host.eval('gameStarted && !isMultiplayer'), true);
        rows.push('leave lobby, close lobby (guests informed), then single player');
    }

    // The host's Auto setting reaches guests; manual mode keeps fixed delays.
    {
        const world = new H.World({ network: WAN, controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-net-auto': false, 'cfg-pipeline-delay': '4', 'cfg-tick-rate': '25' } });
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        await world.run(3000);
        assert.equal(guests[0].eval('netAutoEnabled'), false);
        assert.equal(guests[0].eval('TICK_RATE'), 25, 'manual tick rate used');
        assert.equal(guests[0].eval('LOCKSTEP_PIPELINE_TICKS'), 4, 'manual delay used');
        const world2 = new H.World({ network: WAN, controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-tick-rate': '40' } });
        const m2 = await H.startHostedMatch(world2, { guests: 1 });
        await world2.run(3000);
        assert.equal(m2.guests[0].eval('netAutoEnabled'), true);
        assert.equal(m2.guests[0].eval('TICK_RATE'), 20, 'auto ignores the manual tick rate');
        m2.host.eval('syncNetAutoMenuState()'); // page init does this
        assert.equal(m2.host.element('cfg-tick-rate').disabled, true, 'manual fields greyed out');
        rows.push('Auto on by default (manual fields disabled); manual tick rate and delay honored when off');
    }

    // Someone joins while the host is starting: they are not put into the
    // match as a phantom player, and can spectate it.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests, hostId } = await lobby(world, 1);
        guests[0].eval(`(() => { const me = lobbyPlayers.find(p => p.peerId === myPeerId); me.color = TEAM_PRESET_COLORS[1]; connections[0].send({ type: 'LOBBY_UPDATE_SELF', name: me.name, color: me.color }); })()`);
        await world.run(1000);
        host.eval('startHostedGame()');
        const late = world.spawn('late', { url: url(hostId) });
        late.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(hostId)})`);
        await world.runUntil(() => host.eval('gameStarted') && !host.eval('matchStartWaitingForReady'), 20000);
        await world.run(3000);
        assert.equal(late.eval('gameStarted'), false, 'late joiner did not get the match start');
        assert.equal(host.eval('getActiveMatchPeerIds().length'), 2, 'not a participant');
        assert.ok(await world.runUntil(() => late.eval('remoteMatchRunning'), 5000), 'sees a match in progress');
        const players = [host, guests[0]];
        const snaps = players.map(i => i.snapshotsApplied);
        const tick0 = host.eval('currentTick'), t0 = world.now;
        const stall0 = players.map(i => i.eval('netCounters.stallMs'));
        late.eval('requestSpectateCurrentMatch()');
        assert.ok(await world.runUntil(() => late.eval('gameStarted') && !late.eval('lockstepResyncPauseActive'), 15000), 'spectating');
        await world.run(1500);
        // The players never paused for the spectator.
        assert.deepEqual(players.map(i => i.snapshotsApplied), snaps, 'players restored nothing');
        const stalled = players.map((i, k) => i.eval('netCounters.stallMs') - stall0[k]);
        assert.ok(stalled.every(ms => ms < 150), 'players did not wait: ' + stalled.join('/'));
        assert.ok((host.eval('currentTick') - tick0) / ((world.now - t0) / 1000) > 18.5, 'players kept their pace');
        const from = late.eval('currentTick') + 2;
        await H.playFor(world, [host, guests[0]], 6000, { seed: 3 });
        await world.run(2000);
        H.checkHealthy(world, [host, guests[0], late], { minCompared: 10, fromTick: from, label: 'late spectator' });
        assert.equal(late.eval('localDefeated || spectateMode !== "none"'), true);
        rows.push('joining during the start is kept out of the match, then spectates in sync without pausing the players');
    }

    // The host is gone for good: the guest takes over the match, and can
    // still leave to the main menu from the overlay.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        world.kill(host);
        assert.ok(await world.runUntil(() => guests[0].eval('isHost') && /Drop/.test(guests[0].element('net-wait-overlay').innerHTML), 15000), 'guest took over and waits for the host player');
        assert.match(guests[0].element('net-wait-overlay').innerHTML, /Leave|Drop/);
        guests[0].eval(`leaveMultiplayerToMainMenu('')`);
        await world.run(500);
        assert.equal(guests[0].element('lobby-buttons').style.display, 'flex');
        rows.push('host gone for good: guest takes over (drop button shown), and can leave to the menu');
    }

    console.log('PASS: lobby flows\n  ' + rows.join('\n  '));
})().catch(err => { console.error(err); process.exit(1); });
