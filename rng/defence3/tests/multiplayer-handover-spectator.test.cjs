// A host whose simulation worker is lost hands the match to a spectator when no other player is linked (audit row 73,
// MULTIPLAYER_AUDIT_2026-10-15.md, utils_host_migration.js hostHandOverMatch). Old code: players only; with the other
// player gone and a spectator linked, the host held its ticks and asked nobody: the match froze for good.
// Three teams: guest2 resigns (spectates), guest1 is lost, then the host's worker. The spectator takes the match; it
// drops the lost player; the host's team is the last one: the match ends the same on both, with the host's win.
//   node tests/multiplayer-handover-spectator.test.cjs   (worker mode always)
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 40, jitterMs: 5 };
const RESIGN = `(typeof resignLocalPlayer === 'function' ? resignLocalPlayer() : (queueAction({ action: 'resign' }), enterSpectateMode('defeated'), connections[0].send({ type: 'MATCH_ROLE_UPDATE', role: 'spectating' })))`;

(async () => {
    const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
    world.simWorker = true;
    const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
    const [g1, g2] = guests;
    await H.playFor(world, [host, ...guests], 2000, { seed: 191 });
    const g2Team = g2.eval('localPlayerId'), hostTeam = host.eval('localPlayerId'), g1Id = g1.eval('myPeerId');
    g2.eval(RESIGN);
    assert.ok(await world.runUntil(() => host.eval(`resignedTeams.has(${g2Team})`) && host.eval(`matchRoleByPeerId[${JSON.stringify(g2.eval('myPeerId'))}]`) === 'spectating', 15000, 50), 'guest2 resigned and spectates');
    world.kill(g1);
    await world.run(1500);
    assert.ok(!host.eval('gameOver'), 'the match goes on (waiting for guest1)');
    host.simWorker.terminate();
    host.eval("_simClientOnMessage({ type: 'restoreFailed', epoch: _simClient.epoch, message: 'state lost (test)' })");
    // (The match waits for the lost guest1 until dropped, and with it the old host's own rejoin (scheduled for a tick):
    // its page shows its worker lost meanwhile.)
    const moved = await world.runUntil(() => g2.eval('isHost') && host.eval('!isHost && wsHostId') === g2.eval('myPeerId')
        && g2.eval('gameStarted && !lockstepResyncPauseActive && simClientActive()'), 60000, 100);
    const STATE = `JSON.stringify({ host: isHost, wh: wsHostId, t: currentTick, gs: gameStarted, go: gameOver, pause: lockstepResyncPauseActive, act: simClientActive(),
        lost: simClientLostPending(), loaded: !!(_simClient && _simClient.loaded), failed: _simClient && _simClient.failed, joining: resyncGuest.joining, live: resyncGuest.awaitingLive,
        role: matchRoleByPeerId[myPeerId] || null, spectate: spectateMode, conns: connections.map(c => c.peer.slice(0, 6)) })`;
    assert.ok(moved, 'the spectator took the match over: ' + JSON.stringify([host, g2].map(i => [i.name, i.eval(STATE), i.errors.slice(-4).map(e => String(e && e.message || e).slice(0, 200))])));
    const t = Math.max(host.eval('currentTick'), g2.eval('currentTick'));
    g2.eval(`hostRemovePlayerFromMatch(${JSON.stringify(g1Id)})`);
    assert.ok(await world.runUntil(() => [host, g2].every(i => i.eval('gameOver')), 30000, 100), 'the match ran on to its end: ' + JSON.stringify([host, g2].map(i => [i.name, i.eval('currentTick'), i.eval('gameOver'), i.eval('JSON.stringify([...resignedTeams])')])));
    assert.equal(host.eval('winner'), hostTeam, 'the host\'s team won');
    assert.equal(g2.eval('winner'), hostTeam, 'the same result on the new host');
    assert.ok(host.eval('currentTick') > t, 'ticks ran after the handover');
    const errs = i => i.errors.map(e => String(e && e.message || e)).filter(s => !/state lost|simulation worker was lost|lost during the match/.test(s));
    assert.deepEqual([...errs(host), ...errs(g2)], [], 'no errors');
    console.log('PASS multiplayer-handover-spectator: the spectator took the match over at tick ' + t + ', the match ended at ' + host.eval('currentTick') + ', team ' + hostTeam + ' won');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
