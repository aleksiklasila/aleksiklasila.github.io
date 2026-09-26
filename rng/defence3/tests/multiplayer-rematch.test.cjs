// Starting the next match: guests can ask for a rematch and everyone sees
// who did; the host's Rematch button starts the same match again (same
// players, teams and settings) in one click, without whoever dropped out;
// back-to-back rematches start from a clean state every time.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

async function endMatch(world, host, all) {
    const hostTeam = host.eval('localPlayerId');
    world.atNextSafeTick(`(() => { for (const u of units) if (u.isKing && u.owner !== ${hostTeam}) { u.energy = 0; u.dead = true; } })()`);
    assert.ok(await world.runUntil(() => all.every(i => i.dead || i.eval('gameOver')), 10000), 'match ended everywhere');
}

function startState(i) {
    return i.eval(`JSON.stringify({ units: units.length, towers: towers.length, barracks: barracks.length, map: MAP_TYPE, mode: gameMode, team: localPlayerId,
        players: players.length, tick: currentTick < 200, patches: netCounters.patches, resyncs: netCounters.hardResyncs, over: gameOver })`);
}

(async () => {
    const rows = [];
    const world = new H.World({ network: { latencyMs: 80, jitterMs: 10 }, controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-gamemode': 'killking' } });
    const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
    const all = [host, ...guests];
    const first = all.map(startState);
    await H.playFor(world, all, 3000, { seed: 1 });
    await endMatch(world, host, all);

    // A guest asks; everyone sees it.
    guests[0].eval('guestToggleRematchVote()');  // the button's handler (UI wiring is not loaded here)
    assert.ok(await world.runUntil(() => host.eval('rematchVotePeerIds.size') === 1 && guests[1].eval('rematchVotePeerIds.size') === 1, 3000), 'vote reached everyone');
    const name0 = guests[0].eval('(lobbyPlayers.find(p => p.peerId === myPeerId) || {}).name');
    assert.match(host.element('go-rematch-status').textContent, new RegExp(name0));
    assert.match(host.element('go-btn-rematch').textContent, /1 want/);
    assert.match(guests[0].element('go-btn-rematch').textContent, /requested/);
    assert.match(guests[1].element('go-rematch-status').textContent, /Waiting for the host/);

    // One click: the same match again.
    const t0 = world.now;
    host.eval('hostRematch()');
    const again = await world.runUntil(() => all.every(i => i.eval('gameStarted && !gameOver && !matchStartWaitingForReady')) && host.eval('currentTick') > 20, 20000);
    assert.ok(again, 'rematch started for everyone');
    const startMs = world.now - t0;
    const second = all.map(startState);
    for (let k = 0; k < all.length; k++) {
        const a = JSON.parse(first[k]), b = JSON.parse(second[k]);
        assert.deepEqual([b.map, b.mode, b.team, b.players], [a.map, a.mode, a.team, a.players], all[k].name + ' same setup');
        assert.equal(b.patches + b.resyncs, 0, all[k].name + ' counters reset');
    }
    assert.equal(host.eval('rematchVotePeerIds.size'), 0, 'votes cleared');
    const from = host.eval('currentTick');
    await H.playFor(world, all, 6000, { seed: 2 });
    await world.run(2000);
    H.checkHealthy(world, all, { minCompared: 20, fromTick: from, label: 'rematch' });
    rows.push(`vote shown to all; one-click rematch running for everyone ${Math.round(startMs)}ms later, same teams and settings, in sync`);

    // Rematch after a guest dropped at game over: it starts without them.
    await endMatch(world, host, all);
    world.kill(guests[1]);
    const t1 = world.now;
    host.eval('hostRematch()');
    const without = await world.runUntil(() => [host, guests[0]].every(i => i.eval('gameStarted && !gameOver && !matchStartWaitingForReady')) && host.eval('currentTick') > 20, 20000);
    assert.ok(without, 'rematch without the leaver');
    assert.equal(host.eval('getActiveMatchPeerIds().length'), 2);
    rows.push(`guest gone at game over: rematch started without them after ${Math.round(world.now - t1)}ms`);

    // Three more, back to back.
    const pair = [host, guests[0]];
    for (let k = 0; k < 3; k++) {
        await H.playFor(world, pair, 2000, { seed: 10 + k });
        await endMatch(world, host, pair);
        host.eval('hostRematch()');
        assert.ok(await world.runUntil(() => pair.every(i => i.eval('gameStarted && !gameOver && !matchStartWaitingForReady')) && host.eval('currentTick') > 20, 20000), 'rematch ' + k);
        const st = pair.map(i => JSON.parse(startState(i)));
        assert.equal(st[0].units, st[1].units, 'same start on both');
    }
    const fromTick = host.eval('currentTick');
    const t2 = world.now;
    await H.playFor(world, pair, 5000, { seed: 20 });
    await world.run(2000);
    const tps = (host.eval('currentTick') - fromTick) / ((world.now - t2) / 1000);
    assert.ok(tps > host.eval('TICK_RATE') * 0.9, 'full speed after rematches: ' + tps.toFixed(1));
    H.checkHealthy(world, pair, { minCompared: 10, fromTick, label: 'back-to-back rematches' });
    rows.push('three back-to-back rematches: clean start and in sync each time');

    console.log('PASS: rematch\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
