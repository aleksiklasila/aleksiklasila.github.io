// Roles, teams and rematches under delayed messages (audit 2026-10-16,
// MULTIPLAYER_AUDIT_2026-10-15.md 36-39):
// 36. A player resigning with a teammate still playing stops playing itself;
//     its team plays on, whether its role update comes before or after its
//     resign action (delayed 1 s it resigned the whole team and the other
//     team won). The last player of a team resigning resigns the team; the
//     host resigning with a guest teammate leaves the team to the teammate.
// 37. A colour (team) change that reaches the host while it prepares a start
//     changes nothing: the guest plays the team it started as, and its
//     commands act (its Hold did nothing: the host made them another team's).
// 38. A RETURN_TO_LOBBY delayed past the rematch's start (4.5 s, 8 s) leaves
//     that guest in the rematch (it went back to the lobby for good).
// 39. A rematch keeps spectators and lobby visitors out of the teams (they
//     were made playing teams).
// ONLY=36,38: those parts alone.
//   node tests/multiplayer-roles-rematch.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 50, jitterMs: 5 };
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const part = n => !ONLY || ONLY.includes(String(n));
const url = hostId => `http://localhost/rng/defence3/index.html?game=${hostId}&room=${hostId}`;
// A guest's sends of a type go out `ms` later.
const DELAY_SEND = (type, ms) => `(() => { const c = connections[0], f = c.send.bind(c);
    c.send = d => { if (d && d.type === ${JSON.stringify(type)}) setTimeout(() => f(d), ${ms}); else f(d); }; })()`;
// A guest takes in messages of a type `ms` later.
const DELAY_RECV = (type, ms) => `(() => { const f = _handleConnectionMessage;
    _handleConnectionMessage = function (conn, data) { if (data && data.type === ${JSON.stringify(type)} && !data.__late) { const d = { ...data, __late: 1 }; setTimeout(() => _handleConnectionMessage(conn, d), ${ms}); return; } return f.apply(this, arguments); }; })()`;
async function endMatch(world, host, all) {
    const hostTeam = host.eval('localPlayerId');
    world.atNextSafeTick(`(() => { for (const u of units) if (u.isKing && u.owner !== ${hostTeam}) { u.energy = 0; u.dead = true; } })()`);
    assert.ok(await world.runUntil(() => all.every(i => i.dead || i.eval('gameOver')), 10000), 'match ended everywhere');
}
const resigned = i => JSON.parse(i.eval('JSON.stringify([...resignedTeams].sort())'));
// The Resign button (its handler before resignLocalPlayer, for the code before the fix).
const RESIGN = `(typeof resignLocalPlayer === 'function' ? resignLocalPlayer() : (queueAction({ action: 'resign' }), enterSpectateMode('defeated'), (isMultiplayer && !isHost && connections[0] && connections[0].send({ type: 'MATCH_ROLE_UPDATE', role: 'spectating' }))))`;

(async () => {
    const rows = [];
    // 36.
    if (part(36)) for (const simWorker of [false, true]) {
        const mode = simWorker ? 'worker' : 'page';
        for (const delayed of [true, false]) {
            const world = new H.World({ network: WAN, controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-gamemode': 'killking' } });
            world.simWorker = simWorker;
            const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 0, 1] });
            const all = [host, ...guests], [mate, other] = guests;
            await H.playFor(world, all, 1500, { seed: 91 });
            const team0 = host.eval('localPlayerId'), team1 = other.eval('localPlayerId');
            assert.equal(mate.eval('localPlayerId'), team0, 'teammates');
            if (delayed) mate.eval(DELAY_SEND('MATCH_ROLE_UPDATE', 1000));
            mate.eval(RESIGN);
            await world.run(4000);
            assert.deepEqual(all.map(resigned), [[], [], []], `${mode}${delayed ? ', role update late' : ''}: the team plays on`);
            assert.ok(all.every(i => !i.eval('gameOver')), mode + ': no end');
            assert.equal(host.eval(`matchRoleByPeerId[${JSON.stringify(mate.eval('myPeerId'))}]`), 'spectating', 'the teammate spectates');
            assert.equal(host.eval('localDefeated'), false, 'the host plays on');
            if (delayed) {
                // The last player of the team: the host itself.
                host.eval(RESIGN);
                assert.ok(await world.runUntil(() => all.every(i => resigned(i).includes(team0) && i.eval('gameOver')), 8000), mode + ': the team resigned with its last player');
                assert.deepEqual(all.map(i => i.eval('winner')), [team1, team1, team1], mode + ': the other team won');
                rows.push(`${mode}: a teammate's resign, its role update 1 s late: only it stopped; the last player's resign ended the team`);
            } else {
                other.eval(RESIGN);
                assert.ok(await world.runUntil(() => all.every(i => resigned(i).includes(team1) && i.eval('gameOver')), 8000), mode + ': a team alone resigned');
                assert.deepEqual(all.map(i => i.eval('winner')), [team0, team0, team0], mode + ': the team with a player left won');
                rows.push(`${mode}: a teammate's resign: only it stopped; a lone player's resign ended its team`);
            }
        }
        // The host resigning with a guest teammate.
        {
            const world = new H.World({ network: WAN, controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-gamemode': 'killking' } });
            world.simWorker = simWorker;
            const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 0, 1] });
            const all = [host, ...guests], mate = guests[0];
            await H.playFor(world, all, 1500, { seed: 92 });
            host.eval(RESIGN);
            await world.run(3000);
            assert.deepEqual(all.map(resigned), [[], [], []], mode + ': the host resigned, its teammate plays on');
            assert.equal(host.eval(`matchRoleByPeerId[${JSON.stringify(mate.eval('myPeerId'))}]`), 'playing', 'the teammate still plays');
            const before = new Set(world.issued.keys());
            mate.eval(`(() => { const u = units.find(u => u.owner === localPlayerId && !u.dead && !u.workerType); queueAction({ action: 'move', unitIds: [u.id], targetX: u.x + 40, targetY: u.y }); })()`);
            const netId = [...world.issued].find(([id, i]) => !before.has(id) && i.by === mate.name)?.[0];
            assert.ok(await world.runUntil(() => all.every(i => i.executedActions.has(netId)), 5000), mode + ': the teammate\'s command runs');
            const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
            await H.playFor(world, [mate, guests[1]], 2000, { seed: 93 });
            await world.run(1000);
            H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: mode + ' host resigned' });
            rows.push(`${mode}: the host resigned with a guest teammate: the team played on, the teammate's commands ran`);
        }
    }
    // 37: a colour change while the host prepares the start.
    if (part(37)) for (const simWorker of [false, true]) {
        const mode = simWorker ? 'worker' : 'page';
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        world.simWorker = simWorker;
        const host = world.spawn('host');
        host.eval('loadOrCreateLocalIdentity(); hostOnlineGame();');
        assert.ok(await world.runUntil(() => !!host.eval('myPeerId'), 5000));
        const hostId = host.eval('myPeerId');
        const guests = [1, 2].map(k => { const g = world.spawn('guest' + k, { url: url(hostId) }); g.eval('loadOrCreateLocalIdentity()'); g.eval(`joinGame(${JSON.stringify(hostId)})`); return g; });
        assert.ok(await world.runUntil(() => host.eval('lobbyPlayers.length') >= 3 && host.eval('connections.length') >= 2, 20000));
        host.eval(`(() => { const me = lobbyPlayers.find(p => p.peerId === myPeerId); me.color = TEAM_PRESET_COLORS[0]; broadcastLobbyState(true); })()`);
        guests.forEach((g, i) => g.eval(`(() => { const me = lobbyPlayers.find(p => p.peerId === myPeerId); me.color = TEAM_PRESET_COLORS[${i + 1}]; connections[0].send({ type: 'LOBBY_UPDATE_SELF', name: me.name, color: me.color }); })()`));
        await world.run(1000);
        // (The host's preparation takes 500 ms; guest1 picks another colour meanwhile.)
        host.eval(`(() => { const f = prepareRendererLodAssets; prepareRendererLodAssets = (...a) => new Promise(r => setTimeout(() => r(f(...a)), 500)); })()`);
        host.eval('startHostedGame()');
        await world.run(150);
        const g = guests[0];
        g.eval(`connections[0].send({ type: 'LOBBY_UPDATE_SELF', name: 'guest1', color: TEAM_PRESET_COLORS[3] })`);
        const all = [host, ...guests];
        assert.ok(await world.runUntil(() => all.every(i => i.eval('gameStarted') && !i.eval('matchStartWaitingForReady')) && host.eval('currentTick') > 10, 20000), mode + ': started');
        const gp = g.eval('myPeerId'), team = g.eval('localPlayerId');
        assert.equal(host.eval(`getTeamIdForPeer(${JSON.stringify(gp)})`), team, mode + ': the host has the guest on the team it started as');
        assert.equal(host.eval(`computeTeamSetupFromLobby().teamByPeer[${JSON.stringify(gp)}]`), team, mode + ': and seals its packets for that team');
        // Its Hold acts.
        const before = new Set(world.issued.keys());
        g.eval(`(() => { const ids = units.filter(u => u.owner === localPlayerId && !u.dead && !u.workerType).map(u => u.id); queueAction({ action: 'hold', unitIds: ids }); })()`);
        const netId = [...world.issued].find(([id, i]) => !before.has(id) && i.by === g.name)?.[0];
        assert.ok(await world.runUntil(() => all.every(i => i.executedActions.has(netId)), 5000), mode + ': the hold ran');
        await world.run(500);
        const held = JSON.parse(host.evalSim(`JSON.stringify(units.filter(u => u.owner === ${team} && !u.dead && !u.workerType).map(u => !!u.holdPosition))`));
        assert.ok(held.length > 0 && held.every(Boolean), mode + ': its units hold: ' + JSON.stringify(held));
        rows.push(`${mode}: a colour change during the start's preparation: the guest kept its team, its Hold held its ${held.length} units`);
    }
    // 38: RETURN_TO_LOBBY late for one guest.
    if (part(38)) for (const simWorker of [false, true]) for (const lateMs of [4500, 8000]) {
        const mode = simWorker ? 'worker' : 'page';
        const world = new H.World({ network: { latencyMs: 80, jitterMs: 10 }, controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-gamemode': 'killking' } });
        world.simWorker = simWorker;
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests], late = guests[1];
        await H.playFor(world, all, 2000, { seed: 94 });
        await endMatch(world, host, all);
        late.eval(DELAY_RECV('RETURN_TO_LOBBY', lateMs));
        host.eval('hostRematch()');
        const ok = await world.runUntil(() => all.every(i => i.eval('gameStarted && !gameOver && !matchStartWaitingForReady')) && host.eval('currentTick') > 20, 30000);
        assert.ok(ok, `${mode} ${lateMs} ms: the rematch runs for everyone: ` + JSON.stringify(all.map(i => [i.name, i.eval('gameStarted'), i.eval('currentTick')])));
        await world.run(lateMs + 3000);
        const session = host.eval('matchStartSessionId');
        assert.ok(all.every(i => i.eval('gameStarted && !gameOver') && i.eval('matchStartSessionId') === session), `${mode} ${lateMs} ms: still in the rematch: ` + JSON.stringify(all.map(i => [i.name, i.eval('gameStarted'), i.eval('currentTick')])));
        assert.equal(host.eval('getActiveMatchPeerIds().length'), 3, 'all three play');
        assert.ok(late.eval('netCounters.lateLobbyReturnsDropped | 0') >= 1, 'the late message dropped');
        const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
        await H.playFor(world, all, 2000, { seed: 95 });
        await world.run(1000);
        H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: mode + ' late lobby return' });
        rows.push(`${mode}: RETURN_TO_LOBBY ${lateMs} ms late: the guest stayed in the rematch`);
    }
    // 39: a spectator and a lobby visitor at a rematch.
    if (part(39)) {
        const world = new H.World({ network: WAN, controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-gamemode': 'killking' } });
        const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
        const players = [host, guests[0]];
        await H.playFor(world, players, 1500, { seed: 96 });
        const spec = world.spawn('spectator', { url: url(hostId) });
        spec.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(hostId)})`);
        assert.ok(await world.runUntil(() => spec.eval('remoteMatchRunning'), 10000));
        spec.eval('requestSpectateCurrentMatch()');
        assert.ok(await world.runUntil(() => spec.eval('gameStarted') && !spec.eval('lockstepResyncPauseActive'), 15000), 'spectating');
        const visitor = world.spawn('visitor', { url: url(hostId) });
        visitor.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(hostId)})`);
        assert.ok(await world.runUntil(() => host.eval(`connections.some(c => c.peer === ${JSON.stringify(visitor.eval('myPeerId'))})`), 10000));
        await world.run(1000);
        await endMatch(world, host, [...players, spec]);
        host.eval('hostRematch()');
        assert.ok(await world.runUntil(() => players.every(i => i.eval('gameStarted && !gameOver && !matchStartWaitingForReady')) && host.eval('currentTick') > 20, 20000), 'the rematch runs');
        await world.run(1500);
        const ids = JSON.parse(host.eval('JSON.stringify(getActiveMatchPeerIds())'));
        assert.deepEqual(ids.sort(), [host.eval('myPeerId'), guests[0].eval('myPeerId')].sort(), 'its players alone play: ' + JSON.stringify({ ids, start: host.eval('JSON.stringify(matchStartLobbyPlayers.map(p => p.peerId))'), roles: host.eval('JSON.stringify(matchRoleByPeerId)'), spec: spec.eval('myPeerId'), visitor: visitor.eval('myPeerId') }));
        assert.equal(host.eval('activeTeamIds.length'), 2, 'two teams');
        for (const o of [spec, visitor]) {
            const pid = o.eval('myPeerId');
            assert.notEqual(host.eval(`matchRoleByPeerId[${JSON.stringify(pid)}] || ''`), 'playing', o.name + ' does not play');
            assert.ok(!(o.eval('gameStarted') && !o.eval('localDefeated') && o.eval('spectateMode') === 'none'), o.name + ' was not made a player');
        }
        rows.push('rematch: the spectator and the lobby visitor stayed out of the teams');
    }
    console.log('PASS multiplayer-roles-rematch\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
