// Stale messages, loading and host loss (audit 2026-10-17,
// MULTIPLAYER_AUDIT_2026-10-15.md 42-48):
// 42. A live join replayed after it was taken (same match: no roll back) or
//     after a rematch's start (the guest kept the rematch; it loaded the old
//     match and stood at its tick) is dropped.
// 43. Two copies of a recovery's snapshot decoding at once restore it once
//     (the slower one restored it again after the recovery: a roll back).
// 44. The host's page encodes no state of its own for a join or a recovery
//     in worker mode (the worker's text goes out).
// 45. A reloaded player whose snapshot takes 45 s to decode is not waited
//     for meanwhile (the host fell to ~10 TPS after 30 s); one silent while
//     loading gets the match again and joins.
// 46. A resignation's role update delayed past a rematch's start changes
//     nothing in the rematch (it resigned the guest's team there).
// 47. A player disconnecting while loading the start, the other ready: the
//     match starts (it stood at tick 0 for good).
// 48. A guest's false victory, then the host lost: the match moves on, that
//     guest's end undone by the new host's state (it stood at its tick); alone
//     it takes over and the end is the match's.
// 61. As 48 with a silent host (no link closes): the guest of the false end still notices and the match moves
//     on (row 61, 2026-11-18 audit).
// 62. A player reloading after the host's end gets the final state and the same result (it waited on a join for a
//     tick that never runs).
// 75. A host start that fails after its prepare sends the guests back to the lobby; the next start runs.
// 64. A removed player's team is resigned only if no player is left on it: a teammate loading a join counts, a
//     host that resigned does not.
// 70. A guest with the host's result but not the bundles to its end asks for the final state and ends.
// 79. The previous match's PLAYER_REMOVED_FROM_MATCH is dropped (it sent a playing guest to spectating).
// 80. A member of the match comes back with its role: a player as a player (no Spectate button; a spectate request
//     changes nothing), resigning the usual way after; one whose team lost meanwhile as a spectator.
// ONLY=42,47: those parts alone (each fails on the code before its fix).
//   node tests/multiplayer-stale-loading.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 50, jitterMs: 5 };
const CONTROLS = { ...H.SMALL_MATCH_CONTROLS, 'cfg-gamemode': 'killking' };
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const part = n => !ONLY || ONLY.includes(String(n));
const MODES = process.env.MODES ? process.env.MODES.split(',') : ['page', 'worker'];
const url = hostId => `http://localhost/rng/defence3/index.html?game=${hostId}&room=${hostId}`;
const live = g => g.eval('gameStarted && !resyncGuest.joining && !resyncGuest.awaitingLive && !lockstepResyncPauseActive');
const resigned = i => JSON.parse(i.eval('JSON.stringify([...resignedTeams].sort())'));
// A guest's sends of a type go out `ms` later.
const DELAY_SEND = (type, ms) => `(() => { const c = connections[0], f = c.send.bind(c);
    c.send = d => { if (d && d.type === ${JSON.stringify(type)}) setTimeout(() => f(d), ${ms}); else f(d); }; })()`;
// The guest's first snapshot decode takes `ms` longer.
const SLOW_DECODE = ms => `(() => { const f = netDecodeSnapshotPayload; let first = true;
    netDecodeSnapshotPayload = function () { const r = f.apply(this, arguments); if (!first) return r; first = false; return new Promise(res => setTimeout(() => res(r), ${ms})); }; })()`;
const RESIGN = `(typeof resignLocalPlayer === 'function' ? resignLocalPlayer() : (queueAction({ action: 'resign' }), enterSpectateMode('defeated'), connections[0].send({ type: 'MATCH_ROLE_UPDATE', role: 'spectating' })))`;
async function endMatch(world, host, all) {
    const hostTeam = host.eval('localPlayerId');
    world.atNextSafeTick(`(() => { for (const u of units) if (u.isKing && u.owner !== ${hostTeam}) { u.energy = 0; u.dead = true; } })()`);
    assert.ok(await world.runUntil(() => all.every(i => i.dead || i.eval('gameOver')), 10000), 'match ended everywhere');
}
const rematch = async (world, host, all, label) => {
    host.eval('hostRematch()');
    assert.ok(await world.runUntil(() => all.every(i => i.eval('gameStarted && !gameOver && !matchStartWaitingForReady')) && host.eval('currentTick') > 30, 30000),
        label + ': the rematch runs: ' + JSON.stringify(all.map(i => [i.name, i.eval('gameStarted'), i.eval('gameOver'), i.eval('currentTick')])));
};
// The largest step back an instance's tick takes over `ms` (0: none).
const rollBackOver = async (world, inst, ms) => {
    let peak = inst.eval('currentTick'), back = 0;
    await world.runUntil(() => { const t = inst.eval('currentTick'); peak = Math.max(peak, t); back = Math.max(back, peak - t); return false; }, ms);
    return back;
};
const healthy = async (world, all, seed, label) => {
    const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
    await H.playFor(world, all, 2500, { seed });
    await world.run(1500);
    H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label });
};
// A lobby of a host and `n` guests, each its own team, not started.
async function lobby(world, n) {
    const host = world.spawn('host');
    host.eval('loadOrCreateLocalIdentity(); hostOnlineGame();');
    assert.ok(await world.runUntil(() => !!host.eval('myPeerId'), 5000));
    const hostId = host.eval('myPeerId');
    const guests = [];
    for (let k = 1; k <= n; k++) { const g = world.spawn('guest' + k, { url: url(hostId) }); g.eval('loadOrCreateLocalIdentity()'); g.eval(`joinGame(${JSON.stringify(hostId)})`); guests.push(g); }
    assert.ok(await world.runUntil(() => host.eval('lobbyPlayers.length') >= n + 1 && host.eval('connections.length') >= n, 20000));
    host.eval(`(() => { const me = lobbyPlayers.find(p => p.peerId === myPeerId); me.color = TEAM_PRESET_COLORS[0]; broadcastLobbyState(true); })()`);
    guests.forEach((g, i) => g.eval(`(() => { const me = lobbyPlayers.find(p => p.peerId === myPeerId); me.color = TEAM_PRESET_COLORS[${i + 1}]; connections[0].send({ type: 'LOBBY_UPDATE_SELF', name: me.name, color: me.color }); })()`));
    await world.run(1000);
    return { host, guests, hostId };
}

(async () => {
    const rows = [];
    for (const mode of MODES) {
        const simWorker = mode === 'worker';
        const newWorld = () => { const w = new H.World({ network: WAN, controls: CONTROLS }); w.simWorker = simWorker; return w; };
        // 42.
        if (part(42)) {
            const world = newWorld();
            const { host, guests } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
            const g = guests[0], all = [host, g], gp = g.eval('myPeerId');
            await H.playFor(world, all, 1500, { seed: 101 });
            g.eval(`(() => { __scratch.joins = []; const f = _handleConnectionMessage;
                _handleConnectionMessage = function (conn, data) { if (data && data.type === 'START_GAME' && Number.isFinite(data.joinTick) && !data.__replay) __scratch.joins.push(data); return f.apply(this, arguments); }; })()`);
            host.eval(`hostSendFullMatchSync(connections.find(c => c.peer === ${JSON.stringify(gp)}), 'playing')`);
            assert.ok(await world.runUntil(() => g.eval('__scratch.joins.length') === 1 && live(g) && g.eval('currentTick') > 0, 20000), mode + ' 42: the guest reloaded the match');
            await H.playFor(world, all, 1500, { seed: 102 });
            const replay = `_handleConnectionMessage(connections[0], { ...__scratch.joins[0], __replay: 1 })`;
            // A copy in the same match.
            let d0 = g.eval('netCounters.staleJoinsDropped | 0');
            g.eval(replay);
            const back = await rollBackOver(world, g, 2000);
            assert.equal(back, 0, mode + ' 42: no roll back from the copy');
            assert.ok(g.eval('netCounters.staleJoinsDropped | 0') > d0, mode + ' 42: the copy dropped');
            // After a rematch's start.
            await endMatch(world, host, all);
            await rematch(world, host, all, mode + ' 42');
            const session = host.eval('matchStartSessionId');
            d0 = g.eval('netCounters.staleJoinsDropped | 0');
            g.eval(replay);
            await world.run(3000);
            assert.equal(g.eval('matchStartSessionId'), session, mode + ' 42: the guest kept the rematch');
            const gap = host.eval('currentTick') - g.eval('currentTick');
            assert.ok(gap < 20 && g.eval('currentTick') > 60, `${mode} 42: the guest ticks with the host: host ${host.eval('currentTick')}, guest ${g.eval('currentTick')}`);
            assert.ok(g.eval('netCounters.staleJoinsDropped | 0') > d0, mode + ' 42: the old match\'s join dropped');
            await healthy(world, all, 103, mode + ' 42');
            rows.push(`${mode}: a live join replayed in its match and after a rematch's start: dropped, no roll back, the rematch played on`);
        }
        // 43.
        if (part(43)) {
            const world = newWorld();
            const { host, guests } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 111 });
            // Each snapshot comes twice at once; a second decode takes 6 s longer.
            g.eval(`(() => { const f = _handleConnectionMessage;
                _handleConnectionMessage = function (conn, data) {
                    if (data && data.type === 'MATCH_STATE_SNAPSHOT' && !data.__copy) { f.apply(this, arguments); return f.call(this, conn, { ...data, __copy: 1 }); }
                    return f.apply(this, arguments);
                };
                const d = netDecodeSnapshotPayload; let n = 0;
                netDecodeSnapshotPayload = function () { const r = d.apply(this, arguments); if (++n % 2 === 0) return new Promise(res => setTimeout(() => res(r), 6000)); return r; }; })()`);
            host.eval(`_startHostResyncPause('twice')`);
            assert.ok(await world.runUntil(() => !host.eval('lockstepResyncPauseActive') && !g.eval('lockstepResyncPauseActive') && g.eval('currentTick') > 0, 20000), mode + ' 43: the recovery finished');
            const back = await rollBackOver(world, g, 8000);
            assert.equal(back, 0, mode + ' 43: no roll back after the recovery');
            assert.ok(g.eval('netCounters.duplicateSnapshotsDropped | 0') >= 1, mode + ' 43: the copy dropped');
            await healthy(world, all, 112, mode + ' 43');
            rows.push(`${mode}: two copies of a recovery's snapshot at once: restored once, no roll back`);
        }
        // 44 (the worker's state; page mode has no worker).
        if (part(44) && simWorker) {
            const world = newWorld();
            const { host, guests } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
            const g = guests[0], all = [host, g], gp = g.eval('myPeerId');
            assert.equal(host.eval('simClientActive()'), true, 'the host simulates in its worker');
            await H.playFor(world, all, 1500, { seed: 121 });
            host.eval(`(() => { __scratch.enc = 0; const f = snapEncodeState; snapEncodeState = function () { __scratch.enc++; return f.apply(this, arguments); }; })()`);
            host.eval(`hostSendFullMatchSync(connections.find(c => c.peer === ${JSON.stringify(gp)}), 'playing')`);
            assert.ok(await world.runUntil(() => g.eval('resyncGuest.joinTick') > 0 && live(g), 20000), mode + ' 44: the guest reloaded the match');
            assert.equal(host.eval('__scratch.enc'), 0, mode + ' 44: the host page encoded no state for the join');
            host.eval(`_startHostResyncPause('worker text')`);
            assert.ok(await world.runUntil(() => !host.eval('lockstepResyncPauseActive') && !g.eval('lockstepResyncPauseActive'), 20000), mode + ' 44: the recovery finished');
            assert.equal(host.eval('__scratch.enc'), 0, mode + ' 44: nor for the recovery');
            await healthy(world, all, 122, mode + ' 44');
            rows.push(`${mode}: a join and a recovery: the host page encoded no state (the worker's text went out), in sync`);
        }
        // 45.
        if (part(45)) for (const silent of [false, true]) {
            const world = newWorld();
            const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
            const g = guests[0];
            await H.playFor(world, [host, g], 1500, { seed: 131 });
            const storage = g.storage;
            world.kill(g);
            const fresh = world.spawn('reloaded', { storage, url: url(hostId) });
            fresh.eval('loadOrCreateLocalIdentity()');
            fresh.eval(SLOW_DECODE(silent ? 50000 : 45000));
            fresh.eval(`(() => { __scratch.joins = 0; const f = _handleConnectionMessage;
                _handleConnectionMessage = function (conn, data) { if (data && data.type === 'START_GAME' && Number.isFinite(data.joinTick)) __scratch.joins++; return f.apply(this, arguments); }; })()`);
            // (Silent: says nothing while it loads.)
            if (silent) fresh.eval('_guestJoinLoadingBeat = function () { }');
            fresh.eval(`joinGame(${JSON.stringify(hostId)})`);
            assert.ok(await world.runUntil(() => fresh.eval('__scratch.joins') >= 1, 20000), mode + ' 45: the match was sent');
            await world.run(1000);
            const t0 = host.eval('currentTick'), at0 = world.now;
            await world.run(silent ? 40000 : 42000);
            const tps = (host.eval('currentTick') - t0) / ((world.now - at0) / 1000);
            assert.ok(tps > 18.5, `${mode} 45${silent ? ' silent' : ''}: the host kept its pace while the joiner loaded: ${tps.toFixed(1)} TPS`);
            assert.ok(await world.runUntil(() => live(fresh) && fresh.eval('currentTick') > t0, 40000), mode + ' 45: the joiner loaded and plays: ' + JSON.stringify([fresh.eval('gameStarted'), fresh.eval('resyncGuest.joining'), fresh.eval('resyncGuest.awaitingLive'), fresh.eval('currentTick'), host.eval('currentTick')]));
            if (silent) assert.equal(fresh.eval('__scratch.joins'), 2, mode + ' 45: silent, it was sent the match again');
            // (Live once caught up: in worker mode it said so ~870 ticks
            // behind, and the host waited for it at ~12 TPS meanwhile.)
            assert.ok(host.eval('currentTick') - fresh.eval('currentTick') < 20, mode + ' 45: live once caught up: host ' + host.eval('currentTick') + ', joiner ' + fresh.eval('currentTick'));
            const tpsAll = (host.eval('currentTick') - t0) / ((world.now - at0) / 1000);
            assert.ok(tpsAll > 18.5, `${mode} 45: the host kept its pace through the catch-up: ${tpsAll.toFixed(1)} TPS`);
            await healthy(world, [host, fresh], 132, mode + ' 45');
            rows.push(silent ? `${mode}: a joiner silent while loading 50 s: not waited for, sent the match again, joined (${tps.toFixed(1)} TPS meanwhile)`
                : `${mode}: a joiner decoding 45 s: not waited for (${tps.toFixed(1)} TPS), then joined`);
        }
        // 46.
        if (part(46)) {
            const world = newWorld();
            const { host, guests } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
            const g = guests[0], all = [host, g], gp = g.eval('myPeerId');
            await H.playFor(world, all, 1500, { seed: 141 });
            g.eval(DELAY_SEND('MATCH_ROLE_UPDATE', 15000));
            const at = world.now;
            g.eval(RESIGN);
            assert.ok(await world.runUntil(() => all.every(i => i.eval('gameOver')), 10000), mode + ' 46: the resignation ended the match');
            await rematch(world, host, all, mode + ' 46');
            assert.ok(world.now - at < 14000, mode + ' 46: the rematch runs before the role update comes');
            const d0 = host.eval('netCounters.otherMatchDropped | 0');
            await world.run(15000 - (world.now - at) + 2000);
            assert.deepEqual(all.map(resigned), [[], []], mode + ' 46: nobody resigned in the rematch');
            assert.ok(all.every(i => !i.eval('gameOver')), mode + ' 46: the rematch goes on');
            assert.equal(host.eval(`matchRoleByPeerId[${JSON.stringify(gp)}]`), 'playing', mode + ' 46: the guest plays');
            assert.ok(host.eval('netCounters.otherMatchDropped | 0') > d0, mode + ' 46: the late role update dropped');
            await healthy(world, all, 142, mode + ' 46');
            rows.push(`${mode}: a resignation's role update 15 s late, past the rematch's start: dropped, the rematch played on`);
        }
        // 47.
        if (part(47)) {
            const world = newWorld();
            const { host, guests } = await lobby(world, 2);
            const [g1, g2] = guests, g1p = g1.eval('myPeerId');
            g2.eval(SLOW_DECODE(120000));
            host.eval('startHostedGame()');
            assert.ok(await world.runUntil(() => host.eval(`!!(matchStartReadyByPeerId || {})[${JSON.stringify(g1p)}]`), 30000), mode + ' 47: guest1 is ready');
            world.kill(g2);
            assert.ok(await world.runUntil(() => [host, g1].every(i => i.eval('gameStarted && !matchStartWaitingForReady')) && host.eval('currentTick') > 20 && g1.eval('currentTick') > 20, 15000),
                mode + ' 47: the match started without the player who left: ' + JSON.stringify([host, g1].map(i => [i.name, i.eval('matchStartWaitingForReady'), i.eval('currentTick')])));
            await healthy(world, [host, g1], 143, mode + ' 47');
            rows.push(`${mode}: a player disconnecting while loading, the other ready: the match started`);
        }
        // 48.
        if (part(48)) {
            for (const which of [0, 1]) {
                const world = newWorld();
                const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
                const order = JSON.parse(guests[0].eval('JSON.stringify(computeHostMigrationCandidates(wsHostId))'));
                const X = guests.find(g => g.eval('myPeerId') === order[which]), Y = guests.find(g => g !== X);
                await H.playFor(world, [host, ...guests], 1500, { seed: 151 + which });
                // (Its repair request is lost: the host goes before it answers.)
                X.eval(`(() => { const c = connections[0], f = c.send.bind(c); c.send = d => { if (d && d.type === 'REQUEST_MATCH_SYNC') return; f(d); }; })()`);
                X.evalSim(`units.filter(u => u.isKing && u.owner !== localPlayerId && !u.dead).forEach(k => { k.energy = 0; })`);
                assert.ok(await world.runUntil(() => X.eval('gameOver'), 5000), mode + ' 48: a false victory on ' + X.name);
                world.kill(host);
                const both = [X, Y];
                assert.ok(await world.runUntil(() => both.some(i => i.eval('isHost')) && both.every(i => i.eval('gameStarted && !gameOver && !lockstepResyncPauseActive')) && X.eval('currentTick') > 0, 60000),
                    `${mode} 48 (${which ? 'second' : 'first'} successor): the match moved on: ` + JSON.stringify(both.map(i => [i.name, i.eval('isHost'), i.eval('gameOver'), i.eval('currentTick'), i.eval('netCounters.reconnectAttempts | 0')])));
                assert.equal(Y.eval('isHost'), true, mode + ' 48: the other guest took over');
                // (The match waits for the lost host's player: its drop button.)
                Y.eval(`hostRemovePlayerFromMatch(${JSON.stringify(host.eval('myPeerId'))})`);
                const t = X.eval('currentTick');
                await world.run(2000);
                assert.ok(X.eval('currentTick') > t + 20, mode + ' 48: the guest of the false end plays on');
                await healthy(world, both, 153 + which, mode + ' 48');
                rows.push(`${mode}: a false victory on the ${which ? 'second' : 'first'} successor, then the host lost: the other guest took over, the false end undone`);
            }
            // Alone: it takes over, its end the match's.
            const world = newWorld();
            const { host, guests } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
            const X = guests[0];
            await H.playFor(world, [host, X], 1500, { seed: 155 });
            X.eval(`(() => { const c = connections[0], f = c.send.bind(c); c.send = d => { if (d && d.type === 'REQUEST_MATCH_SYNC') return; f(d); }; })()`);
            X.evalSim(`units.filter(u => u.isKing && u.owner !== localPlayerId && !u.dead).forEach(k => { k.energy = 0; })`);
            assert.ok(await world.runUntil(() => X.eval('gameOver'), 5000), mode + ' 48: a false victory');
            world.kill(host);
            assert.ok(await world.runUntil(() => X.eval('isHost'), 90000), mode + ' 48 alone: it took over: ' + JSON.stringify([X.eval('netCounters.reconnectAttempts | 0'), X.eval('netHostUnreachable')]));
            assert.equal(X.eval('gameOver'), true, mode + ' 48 alone: the match ended');
            assert.deepEqual(X.errors.map(e => String(e.message || e).slice(0, 200)), [], mode + ' 48 alone: no errors');
            rows.push(`${mode}: alone after a false victory and the host lost: took over, the end the match's`);
        }
        if (part(61)) {
            // 61. As 48, but the host goes silent (a crash, a network switch: no link closes). Old code: a guest's own
            //     end the host had not confirmed turned off its silent-host checks (netMaintain): no reconnect, no
            //     migration, both guests frozen (the other one waited for the first successor).
            const world = newWorld();
            const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
            const order = JSON.parse(guests[0].eval('JSON.stringify(computeHostMigrationCandidates(wsHostId))'));
            const X = guests.find(g => g.eval('myPeerId') === order[0]), Y = guests.find(g => g !== X);
            await H.playFor(world, [host, ...guests], 1500, { seed: 161 });
            X.eval(`(() => { const c = connections[0], f = c.send.bind(c); c.send = d => { if (d && d.type === 'REQUEST_MATCH_SYNC') return; f(d); }; })()`);
            X.evalSim(`units.filter(u => u.isKing && u.owner !== localPlayerId && !u.dead).forEach(k => { k.energy = 0; })`);
            assert.ok(await world.runUntil(() => X.eval('gameOver'), 5000), mode + ' 61: a false victory on ' + X.name);
            const hostId = host.eval('myPeerId');
            world.kill(host, { silent: true });
            const both = [X, Y];
            assert.ok(await world.runUntil(() => both.some(i => i.eval('isHost')) && both.every(i => i.eval('gameStarted && !gameOver && !lockstepResyncPauseActive')), 120000),
                `${mode} 61: the match moved on after the host went silent: ` + JSON.stringify(both.map(i => [i.name, i.eval('isHost'), i.eval('gameOver'), i.eval('currentTick'), i.eval('netCounters.reconnectAttempts | 0')])));
            const nh = both.find(i => i.eval('isHost'));
            nh.eval(`hostRemovePlayerFromMatch(${JSON.stringify(hostId)})`);
            const t = X.eval('currentTick');
            await world.run(2000);
            assert.ok(X.eval('currentTick') > t + 20, mode + ' 61: the guest of the false end plays on');
            await healthy(world, both, 162, mode + ' 61');
            rows.push(`${mode}: a false victory, then the host went silent: ${nh.name} took over, the false end undone`);
        }
        if (part(62)) {
            // 62. A player reloads after the host's end. Old code: its full join was scheduled for a tick after the
            //     end, which never runs: it waited on "Joining" for good. Now it gets the final state and the result.
            const world = newWorld();
            const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
            const all = [host, ...guests];
            await H.playFor(world, all, 1500, { seed: 171 });
            await endMatch(world, host, all);
            await world.run(1000);
            const g = guests[0], storage = g.storage, endTick = host.eval('currentTick'), winner = host.eval('winner');
            world.kill(g);
            const fresh = world.spawn('reloaded', { storage, url: url(hostId) });
            fresh.eval('loadOrCreateLocalIdentity()');
            fresh.eval(`joinGame(${JSON.stringify(hostId)})`);
            // (Its join stays "joining" (no tick runs to catch up on): it only holds commands, and the next match's
            // resetWorldState clears it.)
            const ok = await world.runUntil(() => fresh.eval('gameStarted && gameOver'), 30000, 100);
            assert.ok(ok, mode + ' 62: the reloaded player has the ended match: ' + JSON.stringify([fresh.eval('gameStarted'), fresh.eval('gameOver'), fresh.eval('currentTick'), endTick, fresh.eval('resyncGuest.joining'), fresh.snapshotsApplied]));
            assert.equal(fresh.eval('winner'), winner, mode + ' 62: the same result');
            assert.ok(Math.abs(fresh.eval('currentTick') - endTick) <= 2, mode + ' 62: at the end\'s tick (' + fresh.eval('currentTick') + ' vs ' + endTick + ')');
            assert.deepEqual(fresh.errors.map(e => String(e.message || e).slice(0, 200)), [], mode + ' 62: no errors');
            rows.push(`${mode}: reloaded after the end: final state at tick ${fresh.eval('currentTick')}, the same result`);
        }
        if (part(75)) {
            // 75. The host's start fails after it told the guests to prepare (its world making threw). Old code: the
            //     guests stayed on "Waiting for host to generate world" until another start. Now START_GAME_CANCEL:
            //     back on the lobby; the next start runs.
            const world = newWorld();
            const { host, guests } = await lobby(world, 2);
            host.eval(`(() => { const f = prepareRendererLodAssets; let n = 1; prepareRendererLodAssets = function (force) { if (force === true && n-- > 0) return new Promise((res, rej) => setTimeout(() => rej(new Error('injected start failure')), 2000)); return f.apply(this, arguments); }; })()`);
            host.eval('startHostedGame()');
            assert.ok(await world.runUntil(() => guests.every(g => g.eval('_matchLoadInputBlocked')), 5000, 20), mode + ' 75: the guests prepare');
            const back = await world.runUntil(() => guests.every(g => !g.eval('_matchLoadInputBlocked') && !g.eval('gameStarted')) && !host.eval('gameStarted'), 10000, 50);
            assert.ok(back, mode + ' 75: the guests left the loading overlay: ' + JSON.stringify(guests.map(g => [g.name, g.eval('_matchLoadInputBlocked'), g.element('match-load-overlay-detail') && g.element('match-load-overlay-detail').textContent])));
            assert.ok(guests.every(g => /could not start/.test(g.element('lobby-status').textContent)), mode + ' 75: told why');
            host.errors = host.errors.filter(e => !/injected start failure/.test(String(e && e.stack || e)));
            host.eval('startHostedGame()');
            const all = [host, ...guests];
            assert.ok(await world.runUntil(() => all.every(i => i.eval('gameStarted && !matchStartWaitingForReady')) && host.eval('currentTick') > 20, 30000), mode + ' 75: the next start runs');
            await healthy(world, all, 175, mode + ' 75');
            rows.push(`${mode}: a host start failing after the prepare: guests back on the lobby, the next start runs`);
        }
        if (part(70)) {
            // 70. A guest that has the host's result but not the bundles up to its end (here: every bundle dropped
            //     from the moment the host ends the match). Old code: it waited for the next bundle for good. Now it
            //     asks for the final state after 5 s (guestReviewMatchResult) and ends with the host's result.
            const world = newWorld();
            const { host, guests } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
            const g = guests[0], hostTeam = host.eval('localPlayerId');
            await H.playFor(world, [host, g], 1500, { seed: 191 });
            g.eval(`(() => { const f = handleIncomingTickBundle; handleIncomingTickBundle = function () { if (__scratch.dropBundles) return; return f.apply(this, arguments); }; __scratch.dropBundles = true; })()`);
            host.evalSim(`(() => { for (const u of units) if (u.isKing && u.owner !== ${hostTeam}) { u.energy = 0; u.dead = true; } })()`);
            assert.ok(await world.runUntil(() => host.eval('gameOver'), 10000, 50), mode + ' 70: the host ended the match');
            const endTick = host.eval('currentTick');
            const ok = await world.runUntil(() => g.eval('gameOver'), 30000, 100);
            assert.ok(ok, mode + ' 70: the guest without the last bundles ended too: ' + JSON.stringify([g.eval('currentTick'), endTick, g.eval('gameOver'), g.snapshotsApplied]));
            assert.equal(g.eval('winner'), hostTeam, mode + ' 70: with the host\'s result');
            assert.ok(Math.abs(g.eval('currentTick') - endTick) <= 2, mode + ' 70: at the end\'s tick (' + g.eval('currentTick') + ' vs ' + endTick + ')');
            rows.push(`${mode}: the host's result without the last bundles: the guest took the final state and ended`);
        }
        if (part(79)) {
            // 79. The previous match's PLAYER_REMOVED_FROM_MATCH naming this guest arrives in the new match (late past
            //     a rematch's start: the channel is unordered). Old code (no tag): the guest marked itself removed and
            //     went to spectating in a match it plays. Now dropped as another match's.
            const world = newWorld();
            const { host, guests } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
            const g = guests[0];
            await H.playFor(world, [host, g], 1500, { seed: 195 });
            g.eval(`_handleConnectionMessage(netGetHostConnection(), { type: 'PLAYER_REMOVED_FROM_MATCH', peerId: myPeerId, teamId: localPlayerId, m: 'previous-match' })`);
            await world.run(500);
            assert.equal(g.eval('spectateMode'), 'none', mode + ' 79: still playing');
            assert.ok(!g.eval('isPeerExplicitlyRemoved(myPeerId)'), mode + ' 79: not marked removed');
            await healthy(world, [host, g], 196, mode + ' 79');
            rows.push(`${mode}: the previous match's removal message: dropped, the guest plays on`);
        }
        if (part(80)) {
            // 80. A member of the running match comes back with its role (utils_networking.js hostRejoinRole): a
            //     player as a player (no Spectate button meanwhile; a spectate request anyway changes nothing), then
            //     resigns the usual way; one whose team is out meanwhile (defeated) as a spectator. Old code: a
            //     player's spectate request made it a spectator (its team neither played nor resigned) for good.
            const world = newWorld();
            const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
            const [g1, g2] = guests;
            await H.playFor(world, [host, ...guests], 1500, { seed: 197 });
            const t1 = g1.eval('localPlayerId'), t2 = g2.eval('localPlayerId');
            world.kill(g1);
            const back = world.spawn('reloaded', { storage: g1.storage, url: url(hostId) });
            back.eval('loadOrCreateLocalIdentity()');
            back.eval(SLOW_DECODE(4000));
            back.eval(`joinGame(${JSON.stringify(hostId)})`);
            assert.ok(await world.runUntil(() => back.eval('remoteMatchRunning && !gameStarted && remoteRoleByPeerId[myPeerId] === "playing"'), 20000, 20), mode + ' 80: the host knows the reloaded page as a player');
            back.eval('updateSpectateButtonVisibility()');
            assert.equal(back.element('btn-spectate-online').style.display, 'none', mode + ' 80: no Spectate button for a player of the match');
            back.eval('requestSpectateCurrentMatch()');
            const all = [host, g2, back];
            assert.ok(await world.runUntil(() => live(back) && back.eval('currentTick') > 0, 40000, 100), mode + ' 80: back in the match');
            await world.run(1000);
            assert.equal(back.eval('spectateMode'), 'none', mode + ' 80: back as a player');
            assert.equal(back.eval('localPlayerId'), t1, mode + ' 80: of its team');
            assert.equal(host.eval(`matchRoleByPeerId[${JSON.stringify(back.eval('myPeerId'))}]`), 'playing', mode + ' 80: playing on the host');
            await healthy(world, all, 198, mode + ' 80');
            back.eval(RESIGN);
            assert.ok(await world.runUntil(() => all.every(i => i.eval(`resignedTeams.has(${t1})`)), 10000, 50), mode + ' 80: then resigned the usual way');
            assert.ok(!host.eval('gameOver'), mode + ' 80: the other two play on');
            // (b) guest2's team defeated, then it reloads: back as a spectator.
            world.atNextSafeTick(`(() => { for (const u of units) if (u.isKing && u.owner === ${t2}) { u.energy = 0; u.dead = true; } })()`);
            assert.ok(await world.runUntil(() => host.eval(`matchRoleByPeerId[${JSON.stringify(g2.eval('myPeerId'))}]`) === 'spectating', 10000, 50), mode + ' 80b: the defeated team spectates');
            world.kill(g2);
            const back2 = world.spawn('reloaded2', { storage: g2.storage, url: url(hostId) });
            back2.eval('loadOrCreateLocalIdentity()');
            back2.eval(`joinGame(${JSON.stringify(hostId)})`);
            assert.ok(await world.runUntil(() => back2.eval('gameStarted') && back2.eval('spectateMode') !== 'none' && back2.eval('currentTick') > 0, 40000, 100),
                mode + ' 80b: the defeated player is back as a spectator: ' + JSON.stringify([back2.eval('gameStarted'), back2.eval('spectateMode'), back2.eval('currentTick')]));
            rows.push(`${mode}: a player reloading: back as a player (no Spectate), resigned the usual way; a defeated one: back spectating`);
        }
        if (part(64)) {
            // 64. Whether a removed player's team still has a player (main.js hostRemovePlayerFromMatch,
            //     utils_networking.js hostTeamStillPlayed). Old code read the tick-input list: (a) a teammate loading a
            //     join was not on it: the team was resigned under it; (b) a host who had resigned was: its team kept,
            //     played by nobody.
            {
                const world = newWorld();
                const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 1] });
                const [g1, g2] = guests, team = g2.eval('localPlayerId');
                await H.playFor(world, [host, ...guests], 1500, { seed: 181 });
                world.kill(g2);
                const fresh = world.spawn('reloaded', { storage: g2.storage, session: g2.session, url: url(hostId) });
                fresh.eval('loadOrCreateLocalIdentity()');
                fresh.eval(SLOW_DECODE(15000));
                fresh.eval(`joinGame(${JSON.stringify(hostId)})`);
                assert.ok(await world.runUntil(() => host.eval(`resyncHostIsJoining(${JSON.stringify(fresh.eval('myPeerId'))})`), 20000, 50), mode + ' 64a: the teammate is loading its join');
                host.eval(`hostRemovePlayerFromMatch(${JSON.stringify(g1.eval('myPeerId'))})`);
                await world.run(1000);
                assert.ok(!host.eval(`resignedTeams.has(${team})`), mode + ' 64a: the team of a teammate loading a join is not resigned');
                assert.ok(await world.runUntil(() => live(fresh) && fresh.eval('currentTick') > 0, 40000, 100), mode + ' 64a: the teammate joined');
                const both = [host, fresh];
                await healthy(world, both, 182, mode + ' 64a');
                assert.ok(both.every(i => !i.eval(`resignedTeams.has(${team})`) && !i.eval('gameOver')), mode + ' 64a: its team plays on');
                rows.push(`${mode}: a player removed while its teammate loaded a join: the team kept`);
            }
            {
                const world = newWorld();
                const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 0, 1] });
                const [g1, g2] = guests, hostTeam = host.eval('localPlayerId'), other = g2.eval('localPlayerId');
                await H.playFor(world, [host, ...guests], 1500, { seed: 183 });
                host.eval(RESIGN);
                await world.run(1000);
                assert.ok(!host.eval(`resignedTeams.has(${hostTeam})`), mode + ' 64b: the team plays on with guest1');
                host.eval(`hostRemovePlayerFromMatch(${JSON.stringify(g1.eval('myPeerId'))})`);
                const ended = await world.runUntil(() => [host, g2].every(i => i.eval(`resignedTeams.has(${hostTeam})`) && i.eval('gameOver')), 15000, 50);
                assert.ok(ended, mode + ' 64b: the team of a resigned host and a removed teammate is resigned: ' + JSON.stringify([host, g2].map(i => [i.name, i.eval('JSON.stringify([...resignedTeams])'), i.eval('gameOver')])));
                assert.equal(g2.eval('winner'), other, mode + ' 64b: the other team won');
                rows.push(`${mode}: the resigned host's teammate removed: the team resigned, the match over`);
            }
        }
    }
    console.log('PASS multiplayer-stale-loading\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
