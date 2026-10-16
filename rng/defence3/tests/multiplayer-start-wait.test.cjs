// A match start waits for players still loading (found 2026-10-16 with three
// real Edge tabs on one machine: the host dropped both guests, their teams
// resigned, as they were still making their model views 45 s after the
// start; tests/browser-mp-gui-fuzz with 3 players never started):
// - a guest loads (its model views) for 60 s: it says so every 2 s
//   (START_GAME_LOADING) and the host waits; the match starts with it;
// - a guest gone silent while loading is dropped after 45 s of silence;
// - a guest makes its model views from START_GAME_PREPARE on (the match's
//   teams and rules, which the prepare now carries), while the host makes
//   the world: not only once the world has come.
//   node tests/multiplayer-start-wait.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 50, jitterMs: 5 };
const url = hostId => `http://localhost/rng/defence3/index.html?game=${hostId}&room=${hostId}`;
// This page's model views take `ms` from the first preparation; later calls
// wait for the same (as the renderer's atlas in progress); calls are noted.
const SLOW_VIEWS = ms => `(() => { let done = null; __scratch.prep = [];
    prepareRendererLodAssets = () => { __scratch.prep.push([performance.now(), gameStarted, typeof matchStartWaitingForReady !== 'undefined' && matchStartWaitingForReady]);
        return done || (done = new Promise(r => setTimeout(r, ${ms}))); }; })()`;

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
    return { host, guests };
}

(async () => {
    const rows = [];
    // A slow guest is waited for; a silent one is dropped.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await lobby(world, 2);
        const [slow, gone] = guests;
        slow.eval(SLOW_VIEWS(60000));
        gone.eval(SLOW_VIEWS(600000));
        host.eval('startHostedGame()');
        await world.run(3000);
        // (gone: its page stops: no word from it again.)
        world.kill(gone, { silent: true });
        const t0 = world.now;
        assert.ok(await world.runUntil(() => [host, slow].every(i => i.eval('gameStarted && !matchStartWaitingForReady')) && host.eval('currentTick') > 10, 120000), 'the match started');
        const took = world.now - t0;
        assert.ok(took > 55000, 'it waited for the slow guest: ' + took);
        const slowPid = slow.eval('myPeerId'), gonePid = gone.eval('myPeerId');
        assert.equal(host.eval(`matchRoleByPeerId[${JSON.stringify(slowPid)}]`), 'playing', 'the slow guest plays');
        assert.notEqual(host.eval(`matchRoleByPeerId[${JSON.stringify(gonePid)}] || ''`), 'playing', 'the silent one was dropped');
        const prep = JSON.parse(slow.eval('JSON.stringify(__scratch.prep)'));
        assert.ok(prep.length >= 1 && prep[0][1] === false, 'the guest began its model views before its match: ' + JSON.stringify(prep));
        const from = host.eval('currentTick') + 5;
        await H.playFor(world, [host, slow], 2500, { seed: 97 });
        await world.run(1000);
        H.checkHealthy(world, [host, slow], { minCompared: 10, fromTick: from, label: 'slow start' });
        rows.push(`a guest loading 60 s was waited for (the start ${Math.round(took / 1000)} s after), one silent was dropped`);
    }
    // The prepare carries the match's rules and teams.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await lobby(world, 1);
        const g = guests[0];
        g.eval(`(() => { const f = _handleConnectionMessage; _handleConnectionMessage = function (c, d) { if (d && d.type === 'START_GAME_PREPARE') __scratch.prepare = { cfg: !!d.editableConfig, teams: null }; return f.apply(this, arguments); }; })()`);
        g.eval(SLOW_VIEWS(100));
        host.eval('startHostedGame()');
        assert.ok(await world.runUntil(() => [host, g].every(i => i.eval('gameStarted && !matchStartWaitingForReady')) && host.eval('currentTick') > 10, 30000), 'started');
        assert.equal(g.eval('__scratch.prepare && __scratch.prepare.cfg'), true, 'the prepare carried the rules');
        const prep = JSON.parse(g.eval('JSON.stringify(__scratch.prep)'));
        assert.equal(prep[0][1], false, 'model views begun at the prepare');
        rows.push('the prepare carries the rules; the guest began its model views then');
    }
    // A prepare arriving while its START_GAME is being applied changes
    // nothing (it set the rules back to the host's from before it read its
    // menu: the guest made a 80x80 world for a 20x20 match and diverged at
    // tick 0), and the prepare carries the rules the match has.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await lobby(world, 1);
        const g = guests[0];
        g.eval(`(() => { const f = _handleConnectionMessage, prep = prepareRendererLodAssets; let held = null;
            __scratch.late = {};
            _handleConnectionMessage = function (c, d) {
                if (d && d.type === 'START_GAME_PREPARE') { __scratch.late.prepGrid = d.editableConfig && d.editableConfig.config && d.editableConfig.config.GRID_W; held = [this, c, d]; return; }
                if (d && d.type === 'START_GAME') __scratch.late.startGrid = d.cfg && d.cfg.gridW;
                return f.apply(this, arguments); };
            // (Delivered as the start is applied: after its rules, before its world.)
            prepareRendererLodAssets = function (now) { if (now && held) { const h = held; held = null; f.call(h[0], h[1], h[2]); __scratch.late.delivered = true; } return prep.apply(this, arguments); }; })()`);
        host.eval('startHostedGame()');
        assert.ok(await world.runUntil(() => [host, g].every(i => i.eval('gameStarted && !matchStartWaitingForReady')) && host.eval('currentTick') > 10, 30000), 'started');
        const late = JSON.parse(g.eval('JSON.stringify(__scratch.late)'));
        assert.equal(late.delivered, true, 'the prepare came during the start: ' + JSON.stringify(late));
        assert.equal(late.prepGrid, late.startGrid, 'the prepare carried the match\'s map size');
        assert.equal(g.eval('GRID_W'), host.eval('GRID_W'), 'the guest has the match\'s map');
        await H.playFor(world, [host, g], 2500, { seed: 31 });
        await world.run(1000);
        H.checkHealthy(world, [host, g], { minCompared: 10, label: 'late prepare' });
        rows.push(`a prepare arriving while its start was applied changed nothing (map ${late.startGrid}, in sync from tick 0)`);
    }
    console.log('PASS multiplayer-start-wait\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
