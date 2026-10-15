// A page whose simulation worker fails runs its match itself (audit
// 2026-10-15, MULTIPLAYER_AUDIT_2026-10-15.md 11): a worker that did not
// load left the page without its wasm heap (the kernels are Rust only:
// every tick failed, a multiplayer match stood at tick 0); a worker that
// could not start the match left the start waiting for its world for good.
// Now the page makes its heap once its worker failed, and a failed start
// gives the match to the page, from the start state it kept.
//   node tests/sim-worker-failure.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const FAIL_LOAD = `simClientPreload(); _simClient.failed = 'test: did not load';`;
// (The worker's answer to the start: an error, as _simError('start') posts.)
const FAIL_START = `(() => {
    simClientPreload();
    const c = _simClient, post = c.worker.postMessage.bind(c.worker);
    c.worker.postMessage = (msg, t) => {
        if (msg && msg.type === 'start') { setTimeout(() => _simClientOnMessage({ type: 'error', where: 'start', message: 'test: could not start' }), 0); return; }
        return post(msg, t);
    };
})()`;
const errorsOf = i => i.errors.map(e => String(e.message || e).slice(0, 160)).filter(m => !/test: /.test(m));

(async () => {
    const rows = [];
    for (const [name, setup] of [['load', FAIL_LOAD], ['start', FAIL_START]]) {
        // Solo.
        {
            const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS } });
            world.simWorker = true;
            const inst = world.spawn('solo');
            await world.run(200);
            inst.eval(setup);
            inst.eval('startSoloGame();');
            await world.run(3000);
            const r = JSON.parse(inst.eval(`JSON.stringify({ tick: currentTick, active: simClientActive(), heap: _simHeap.ready, units: units.length })`));
            assert.ok(r.tick > 30, name + ': the solo match runs: ' + JSON.stringify(r));
            assert.equal(r.active, false, name + ': on the page');
            assert.ok(r.units > 0, name + ': with its units');
            assert.deepEqual(errorsOf(inst), [], name + ': no errors');
            rows.push(`${name} failure, solo: on the page, tick ${r.tick}`);
        }
    }
    // Multiplayer: the failure set up on the guest before the match starts.
    for (const [name, setup] of [['load', FAIL_LOAD], ['start', FAIL_START]]) {
        const world = new H.World({ network: { latencyMs: 40, jitterMs: 5 }, controls: H.SMALL_MATCH_CONTROLS });
        world.simWorker = true;
        const host = world.spawn('host', { controls: H.SMALL_MATCH_CONTROLS });
        host.eval('loadOrCreateLocalIdentity(); hostOnlineGame();');
        assert.ok(await world.runUntil(() => !!host.eval('myPeerId'), 5000));
        const hostId = host.eval('myPeerId');
        const g = world.spawn('guest1', { controls: H.SMALL_MATCH_CONTROLS, url: `http://localhost/rng/defence3/index.html?game=${hostId}&room=${hostId}` });
        await world.run(200);
        g.eval(setup);
        g.eval('loadOrCreateLocalIdentity()');
        g.eval(`joinGame(${JSON.stringify(hostId)})`);
        assert.ok(await world.runUntil(() => host.eval('lobbyPlayers.length') >= 2, 10000), 'joined');
        host.eval(`(() => { const me = lobbyPlayers.find(p => p.peerId === myPeerId); me.color = TEAM_PRESET_COLORS[0]; broadcastLobbyState(true); })()`);
        g.eval(`(() => { const me = lobbyPlayers.find(p => p.peerId === myPeerId); if (me) { me.color = TEAM_PRESET_COLORS[1]; connections[0].send({ type: 'LOBBY_UPDATE_SELF', name: me.name, color: me.color }); } })()`);
        await world.run(1000);
        host.eval('startHostedGame()');
        assert.ok(await world.runUntil(() => [host, g].every(i => i.eval('gameStarted') && !i.eval('matchStartWaitingForReady')) && host.eval('currentTick') > 40, 30000),
            name + ': the match starts and runs: ' + JSON.stringify([host, g].map(i => [i.name, i.eval('currentTick'), i.eval('matchStartWaitingForReady')])));
        assert.equal(g.eval('simClientActive()'), false, name + ': the guest runs it on its page');
        const from = host.eval('currentTick') + 5;
        await H.playFor(world, [host, g], 3000, { seed: 51 });
        await world.run(1500);
        assert.deepEqual(errorsOf(g), [], name + ': no errors on the guest');
        H.checkHealthy(world, [host, g], { minCompared: 10, fromTick: from, label: name + ' failure' });
        rows.push(`${name} failure, a guest: on its page, in sync with the host's worker`);
    }
    console.log('PASS sim-worker-failure\n  ' + rows.join('\n  '));
})().catch(e => { console.error(e); process.exit(1); });
