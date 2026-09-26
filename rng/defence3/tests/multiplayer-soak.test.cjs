// One long match with everything happening to it, while four players keep
// sending the chaos command stream: the network goes from LAN to 200 ms, to
// lossy, to unstable and back; a guest's link goes silent for a while; a
// guest reloads its page; another diverges and is patched; a spectator
// joins. Then the match ends and a rematch starts. Throughout, every peer
// must agree on every tick (apart from the diverged guest until its patch),
// never throw, and keep the match moving.
//
// Usage: node tests/multiplayer-soak.test.cjs [seconds]
const assert = require('node:assert/strict');
const C = require('./multiplayer-chaos-determinism.test.cjs');

const SECONDS = Number(process.argv[2]) || 110;

(async () => {
    const { world, host, guests, all: players0 } = await C.setupChaosWorld('crossroads', 8080, { teams: [0, 1, 2, 3], mapSize: 48, exactHashes: true, network: { latencyMs: 4, jitterMs: 1 } });
    const hostId = host.eval('myPeerId');
    // What the host finds differing in each repair request (for failures).
    host.scratch.requests = [];
    host.eval(`(() => { const orig = resyncHostHandleRequest; resyncHostHandleRequest = function (conn, data) {
        const codes = new Set(); for (const r of (data && data.rotation) || []) { const mine = snapGetTickHash(r.tick); if (mine) for (const c of snapDiffTickHash(mine, r)) codes.add(c); }
        __scratch.requests.push({ peer: String(conn.peer), tick: data && data.tick, differs: snapDescribeCodes(codes, 12) });
        return orig.apply(this, arguments); }; })()`);
    let all = [...players0];
    let s = 77;
    const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const log = [];
    const start = world.now;
    const at = sec => start + sec * 1000 * SECONDS / 110;
    const events = [
        [at(10), 'network 200 ms', () => world.net.setProfile({ latencyMs: 200, jitterMs: 30 })],
        [at(20), 'network lossy', () => world.net.setProfile({ latencyMs: 120, jitterMs: 20, lossRate: 0.01 })],
        [at(30), 'guest1 silent 5 s', async () => { world.setOffline(guests[0], true); await world.run(5000); world.setOffline(guests[0], false); }],
        [at(45), 'guest2 reloads', async () => {
            const old = guests[1];
            const storage = old.storage;
            world.kill(old);
            await world.run(1500);
            const fresh = world.spawn('guest2-reloaded', { storage, url: `http://localhost/rng/defence3/index.html?game=${hostId}` });
            fresh.eval('loadOrCreateLocalIdentity()');
            fresh.eval(`joinGame(${JSON.stringify(hostId)})`);
            assert.ok(await world.runUntil(() => fresh.eval('gameStarted && !lockstepResyncPauseActive && !resyncGuest.joining && !resyncGuest.awaitingLive'), 30000, 20), 'reloaded guest back');
            all = all.map(i => i === old ? fresh : i);
            guests[1] = fresh;
        }],
        [at(60), 'guest3 diverges', () => {
            const g = guests[2];
            divergence = { name: g.name, tick: g.eval('currentTick') - 1, patchesBefore: g.patchesApplied };
            g.eval(`(() => { const us = units.filter(u => !u.dead); for (let i = 0; i < 5; i++) { const u = us[(i * 31) % us.length]; u.x += 6; u.energy = Math.max(1, u.energy - 2); } })()`);
        }],
        [at(70), 'spectator joins', async () => {
            const spec = world.spawn('spectator', { url: `http://localhost/rng/defence3/index.html?game=${hostId}` });
            spec.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(hostId)})`);
            assert.ok(await world.runUntil(() => spec.eval('remoteMatchRunning'), 10000), 'spectator sees the match');
            spec.eval('requestSpectateCurrentMatch()');
            assert.ok(await world.runUntil(() => spec.eval('gameStarted && !lockstepResyncPauseActive'), 20000), 'spectating');
            spectator = spec;
        }],
        [at(80), 'network unstable', () => world.net.setProfile({ latencyMs: 80, jitterMs: 120, lossRate: 0.02, spikeEveryMs: 7000, spikeMs: 500 })],
        [at(100), 'network LAN', () => world.net.setProfile({ latencyMs: 4, jitterMs: 1 })],
    ];
    let divergence = null, spectator = null;
    const startTick = host.eval('currentTick');
    while (world.now < at(110)) {
        while (events.length && world.now >= events[0][0]) {
            const [, name, fn] = events.shift();
            log.push(`${Math.round((world.now - start) / 1000)}s ${name}`);
            await fn();
        }
        for (const inst of all) if (!inst.dead && rand() < 0.6) inst.eval(C.CHAOS_COMMAND + '(' + rand() + ')');
        await world.run(250);
    }
    await world.run(3000);
    const secs = (world.now - start) / 1000;
    const tps = (host.eval('currentTick') - startTick) / secs;
    const live = [...all, spectator].filter(i => i && !i.dead);
    for (const i of live) {
        assert.deepEqual(i.errors.map(e => String(e && e.stack || e).slice(0, 500)), [], i.name + ' threw');
        assert.equal(i.eval('runtimeErrorCount'), 0, i.name + ' runtime errors');
    }
    // The diverged guest was patched; nobody else needed anything.
    const g3 = guests[2];
    assert.ok(g3.patchesApplied > divergence.patchesBefore, 'diverged guest patched');
    for (const i of live) if (i !== g3) assert.equal(i.patchesApplied, 0, i.name + ' patched: ' + i.warnings.filter(w => /patch|Patch|mismatch/.test(JSON.stringify(w.a))).slice(-4).map(w => JSON.stringify(w.a).slice(0, 600)).join(' || ')
        + ' host saw: ' + JSON.stringify(host.scratch.requests.filter(r => r.peer === i.eval('myPeerId'))));
    // (A second patch may follow for what spread while the first was on its way.)
    const repairTicks = (g3.patchTicks || []).filter(t => t > divergence.tick);
    assert.ok(repairTicks.length >= 1 && repairTicks.length <= 2 && g3.fullPatchesApplied === 0, 'patches for the divergence: ' + repairTicks);
    const patchTick = Math.max(...repairTicks);
    const cmp = world.compareHashes(live, startTick, 'tickExact');
    const bad = cmp.mismatches.filter(m => !((m.a === g3.name || m.b === g3.name) && m.tick >= divergence.tick && m.tick < patchTick));
    assert.deepEqual(bad.slice(0, 3), [], 'bit-exact apart from the diverged guest before its patch');
    assert.ok(cmp.compared > 1500, 'compared ' + cmp.compared);
    assert.ok(tps > host.eval('TICK_RATE') * 0.75, 'match kept moving: ' + tps.toFixed(1) + ' TPS');

    // End it, and play again.
    const hostTeam = host.eval('localPlayerId');
    for (const g of guests) if (g.eval('localPlayerId') !== hostTeam && !g.eval('gameOver')) g.eval(`queueAction({ action: 'resign' })`);
    assert.ok(await world.runUntil(() => live.every(i => i.eval('gameOver')), 20000, 20), 'ended everywhere');
    const endings = live.map(i => i.eval('JSON.stringify([winner, gameTime])'));
    assert.ok(endings.every(e => e === endings[0]), 'same ending: ' + endings);
    host.eval('hostRematch()');
    const players = [host, ...guests];
    assert.ok(await world.runUntil(() => players.every(i => i.eval('gameStarted && !gameOver && !matchStartWaitingForReady')) && host.eval('currentTick') > 20, 30000, 20), 'rematch started');
    const from = host.eval('currentTick');
    await world.run(4000);
    const cmp2 = world.compareHashes(players, from, 'tickExact');
    assert.equal(cmp2.mismatches.length, 0, 'rematch in sync');
    console.log(`PASS: soak (${Math.round(secs)}s, ${cmp.compared} fingerprints, ${tps.toFixed(1)} TPS)\n  ` + log.join('\n  ') + `\n  ended together, rematch in sync`);
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
