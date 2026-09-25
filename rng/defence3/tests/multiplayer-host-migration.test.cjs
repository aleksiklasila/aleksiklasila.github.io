// Host migration: losing the host must not end the match. The others agree
// on a successor, move the match there and continue in sync; a host that
// was only cut off, or reloads, finds the match again; a guest with its own
// network trouble or a single broken link never splits the match.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const WAN = { latencyMs: 60, jitterMs: 10 };

const hostOf = inst => inst.eval('isHost ? myPeerId : wsHostId');
const settled = insts => insts.every(i => i.eval('gameStarted') && !i.eval('lockstepResyncPauseActive') && !i.eval('hostMigration'));

// All of `insts` agree on a host among them, and ticks are advancing.
async function waitForNewHost(world, insts, maxMs) {
    const t0 = world.now;
    const ok = await world.runUntil(() => {
        if (!settled(insts)) return false;
        const hosts = new Set(insts.map(hostOf));
        return hosts.size === 1 && insts.some(i => i.eval('isHost'));
    }, maxMs, 50);
    return ok ? world.now - t0 : Infinity;
}

async function progressWithin(world, insts, ms) {
    const start = insts.map(i => i.eval('currentTick'));
    return world.runUntil(() => insts.every((i, k) => i.eval('currentTick') > start[k] + 20), ms, 50);
}

function expectedSuccessor(insts) {
    return insts.map(i => i.eval('myPeerId')).sort()[0];
}

(async () => {
    const rows = [];

    // A: the host leaves a 3-team match from the menu. The first player in
    // id order takes over at once, the host's team resigns, and the other
    // two keep playing in sync.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        await H.playFor(world, [host, ...guests], 5000, { seed: 101 });
        const hostTeam = host.eval('localPlayerId');
        host.eval(`leaveMultiplayerToMainMenu('')`);
        const ms = await waitForNewHost(world, guests, 10000);
        assert.ok(ms < 3000, 'successor took over in ' + ms);
        assert.equal(hostOf(guests[0]), expectedSuccessor(guests), 'successor is the first player by id');
        assert.ok(await world.runUntil(() => guests.every(g => g.eval(`resignedTeams.has(${hostTeam})`)), 5000), 'the leaving host resigned');
        assert.ok(await progressWithin(world, guests, 5000), 'match continues');
        const from = Math.max(...guests.map(g => g.lastSnapshotTick || 0));
        const t0 = world.now;
        await H.playFor(world, guests, 8000, { seed: 102 });
        await world.run(2000);
        H.checkHealthy(world, guests, { minCompared: 20, fromTick: from, label: 'host left' });
        for (const g of guests) H.assertAllCommandsExecuted(world, g, 'host left', world.now - 2500);
        assert.ok(world.issued.size > 0 && [...world.issued.values()].some(i => i.at > t0));
        rows.push(`host left a 3-team match: successor took over in ${Math.round(ms)}ms, host's team resigned, others in sync`);
    }

    // B: the host's tab closes in a 2v2 (its peer id disappears). The others
    // move the match at once and wait for the host's player; the host
    // reloads, finds the match through its tab's record, and is back on its
    // team without anyone dropping it.
    {
        // Real gzip: the match start is decoded asynchronously, as in a
        // browser, which once let it overwrite the roster that arrived meanwhile.
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS, compressSnapshots: true });
        const { host, guests } = await H.startHostedMatch(world, { guests: 3, teams: [0, 1, 0, 1], hostSetup: 'NET_SNAPSHOT_COMPRESS_MIN_BYTES = 0' });
        await H.playFor(world, [host, ...guests], 5000, { seed: 111 });
        for (const g of guests) assert.equal(g.eval(`remoteRoleByPeerId[${JSON.stringify(host.eval('myPeerId'))}]`), 'playing', g.name + ' knows the host plays');
        const hostTeam = host.eval('localPlayerId');
        const oldHostId = host.eval('myPeerId');
        world.kill(host);
        const ms = await waitForNewHost(world, guests, 10000);
        assert.ok(ms < 4000, 'successor took over in ' + ms);
        const newHost = guests.find(g => g.eval('isHost'));
        assert.equal(newHost.eval('getActiveMatchPeerIds().length'), 4, 'the host player keeps its slot');
        await world.run(1500);
        assert.ok(newHost.eval(`netGetWaitingPeerIds().includes(${JSON.stringify(oldHostId)})`), 'waits for the host player');
        const back = world.spawn('host-reloaded', { storage: host.storage, session: host.session, url: `http://localhost/rng/defence3/index.html?game=${oldHostId}&room=${oldHostId}` });
        back.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(oldHostId)})`);
        const all = [back, ...guests];
        const t0 = world.now;
        assert.ok(await world.runUntil(() => back.eval('gameStarted') && settled(all) && !newHost.eval('netGetWaitingPeerIds().length') && back.eval('currentTick') > 0, 20000), 'reloaded host is back in the match');
        const backMs = world.now - t0;
        assert.equal(back.eval('isHost'), false);
        assert.equal(back.eval('localPlayerId'), hostTeam, 'same team as before');
        assert.equal(hostOf(back), newHost.eval('myPeerId'));
        const from = back.eval('currentTick');
        await H.playFor(world, all, 8000, { seed: 112 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 20, fromTick: from, label: 'host reload' });
        for (const i of all) H.assertAllCommandsExecuted(world, i, 'host reload', world.now - 2500);
        rows.push(`host tab closed in 2v2: moved in ${Math.round(ms)}ms; reloaded host found the match and rejoined its team in ${Math.round(backMs)}ms`);
    }

    // B2: the same in a 1v1, as a real browser reload does it: the guest
    // takes over, the reloaded host page (whose invite names its own old id)
    // goes straight to looking for the match and rejoins as a player.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS, compressSnapshots: true });
        const { host, guests } = await H.startHostedMatch(world, { guests: 1, hostSetup: 'NET_SNAPSHOT_COMPRESS_MIN_BYTES = 0' });
        const g = guests[0];
        await H.playFor(world, [host, g], 4000, { seed: 115 });
        const hostTeam = host.eval('localPlayerId');
        const oldHostId = host.eval('myPeerId');
        world.kill(host);
        const back = world.spawn('host-reloaded-1v1', { storage: host.storage, session: host.session, url: `http://localhost/rng/defence3/index.html?game=${oldHostId}&room=${oldHostId}` });
        back.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(oldHostId)})`);
        const all = [back, g];
        const t0 = world.now;
        assert.ok(await world.runUntil(() => back.eval('gameStarted') && settled(all) && g.eval('isHost') && !g.eval('netGetWaitingPeerIds().length') && back.eval('currentTick') > 0, 20000), 'reloaded 1v1 host is back');
        const backMs = world.now - t0;
        assert.equal(g.eval('gameOver'), false, 'the reload did not forfeit');
        assert.equal(back.eval('localPlayerId'), hostTeam);
        const from = back.eval('currentTick');
        await H.playFor(world, all, 6000, { seed: 116 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 20, fromTick: from, label: '1v1 host reload' });
        for (const i of all) H.assertAllCommandsExecuted(world, i, '1v1 host reload', world.now - 2500);
        assert.equal(back.window.location.search.includes('game=' + g.eval('myPeerId')), true, 'address bar invite follows the host');
        // Reload again, from the original (now stale) invite link.
        world.kill(back);
        const again = world.spawn('host-reloaded-twice', { storage: back.storage, session: back.session, url: `http://localhost/rng/defence3/index.html?game=${oldHostId}&room=${oldHostId}` });
        again.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(oldHostId)})`);
        assert.ok(await world.runUntil(() => again.eval('gameStarted') && settled([again, g]) && !g.eval('netGetWaitingPeerIds().length') && again.eval('currentTick') > 0, 25000), 'second reload from a stale link is back');
        assert.equal(again.eval('localPlayerId'), hostTeam);
        rows.push(`1v1 host reload (gzip start): guest took over, host back as a player in ${Math.round(backMs)}ms, no forfeit; a second reload from the stale link rejoins too`);
    }

    // C: the host dies silently (crash, cable pulled: no close, peer id
    // still registered). The others notice the silence, move the match, and
    // can drop the host's player to continue.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        await H.playFor(world, [host, ...guests], 4000, { seed: 121 });
        const oldHostId = host.eval('myPeerId');
        const hostTeam = host.eval('localPlayerId');
        world.kill(host, { silent: true });
        const ms = await waitForNewHost(world, guests, 60000);
        assert.ok(ms < 35000, 'moved after ' + ms);
        const newHost = guests.find(g => g.eval('isHost'));
        newHost.eval(`hostRemovePlayerFromMatch(${JSON.stringify(oldHostId)})`);
        assert.ok(await progressWithin(world, guests, 5000), 'continues after dropping the old host');
        assert.ok(guests.every(g => g.eval(`resignedTeams.has(${hostTeam})`)));
        const from = Math.max(...guests.map(g => g.lastSnapshotTick || 0));
        await H.playFor(world, guests, 6000, { seed: 122 });
        await world.run(2000);
        H.checkHealthy(world, guests, { minCompared: 20, fromTick: from, label: 'silent host' });
        for (const g of guests) H.assertAllCommandsExecuted(world, g, 'silent host', world.now - 2500);
        rows.push(`silent host death: match moved ${(ms / 1000).toFixed(1)}s after the host went quiet`);
    }

    // D: the host's whole network drops for 40s. The others move on; when
    // the old host is back it finds itself alone, looks for the match,
    // joins the new host and plays on as a guest, same team.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        await H.playFor(world, [host, ...guests], 4000, { seed: 131 });
        const hostTeam = host.eval('localPlayerId');
        world.setOffline(host, true);
        const ms = await waitForNewHost(world, guests, 45000);
        assert.ok(ms < 35000, 'moved after ' + ms);
        await world.run(40000 - ms);
        world.setOffline(host, false);
        const all = [host, ...guests];
        const t0 = world.now;
        assert.ok(await world.runUntil(() => !host.eval('isHost') && settled(all) && new Set(all.map(hostOf)).size === 1 && !guests.find(g => g.eval('isHost')).eval('netGetWaitingPeerIds().length'), 40000), 'old host rejoined as a guest');
        const backMs = world.now - t0;
        assert.equal(host.eval('localPlayerId'), hostTeam);
        const from = Math.max(...all.map(i => i.lastSnapshotTick || 0));
        await H.playFor(world, all, 8000, { seed: 132 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 20, fromTick: from, label: 'host back' });
        for (const i of all) H.assertAllCommandsExecuted(world, i, 'host back', world.now - 2500);
        rows.push(`host offline 40s: others moved after ${(ms / 1000).toFixed(1)}s; old host rejoined as guest ${(backMs / 1000).toFixed(1)}s after its network returned`);
    }

    // E: a guest's own network drops for 30s. It must not take the match
    // over (it cannot even reach the signaling server); it rejoins the
    // same host afterwards.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 4000, { seed: 141 });
        const hostId = host.eval('myPeerId');
        // The guest first in successor order is the one most tempted to take over.
        const lone = guests.slice().sort((a, b) => (a.eval('myPeerId') < b.eval('myPeerId') ? -1 : 1))[0];
        world.setOffline(lone, true);
        await world.run(30000);
        assert.equal(lone.eval('isHost'), false, 'offline guest did not take over');
        world.setOffline(lone, false);
        assert.ok(await world.runUntil(() => settled(all) && all.every(i => hostOf(i) === hostId) && !host.eval('netGetWaitingPeerIds().length'), 30000), 'guest back with the same host');
        const from = lone.eval('currentTick');
        await H.playFor(world, all, 6000, { seed: 142 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 20, fromTick: from, label: 'guest offline' });
        assert.equal(host.eval('netCounters.hostMigrations'), 0);
        rows.push('guest offline 30s: never took over, rejoined the same host');
    }

    // F: only one guest's link to the host breaks (others still reach the
    // host). Whichever way the successor order falls, the match must not
    // split: the guest keeps coming back to the real host.
    for (const firstInOrder of [true, false]) {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 4000, { seed: 151 });
        const hostId = host.eval('myPeerId');
        const sorted = guests.slice().sort((a, b) => (a.eval('myPeerId') < b.eval('myPeerId') ? -1 : 1));
        const cut = firstInOrder ? sorted[0] : sorted[1];
        world.setLink(host, cut, 'blackhole');
        await world.run(45000);
        assert.ok(all.every(i => !i.eval('isHost') || i === host), 'nobody else became host');
        world.setLink(host, cut, 'up');
        assert.ok(await world.runUntil(() => settled(all) && all.every(i => hostOf(i) === hostId) && !host.eval('netGetWaitingPeerIds().length'), 30000), 'all back on the original host');
        const from = cut.eval('currentTick');
        await H.playFor(world, all, 6000, { seed: 152 });
        await world.run(2000);
        H.checkHealthy(world, all, { minCompared: 20, fromTick: from, label: 'partition' });
        rows.push(`one broken guest-host link (guest ${firstInOrder ? 'first' : 'second'} in successor order): no split, back on the original host`);
    }

    // G: host crash in a 1v1: the guest takes over; dropping the absent host
    // player ends the match in the guest's favor.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        const g = guests[0];
        await H.playFor(world, [host, g], 3000, { seed: 161 });
        const oldHostId = host.eval('myPeerId');
        world.kill(host);
        const ms = await waitForNewHost(world, [g], 10000);
        assert.ok(ms < 4000, '1v1 takeover in ' + ms);
        assert.ok(await world.runUntil(() => /Waiting for players/.test(g.element('net-wait-overlay').innerHTML) && /Drop/.test(g.element('net-wait-overlay').innerHTML), 5000), 'new host shows whom it waits for, with a drop button');
        g.eval(`hostRemovePlayerFromMatch(${JSON.stringify(oldHostId)})`);
        assert.ok(await world.runUntil(() => g.eval('gameOver'), 10000), 'match ends');
        assert.equal(g.eval('winner'), g.eval('localPlayerId'), 'remaining player wins');
        assert.deepEqual(g.errors, []);
        rows.push('1v1 host crash: guest takes over, dropping the host ends the match in its favor');
    }

    // H: hosts keep leaving: 4 players, the host leaves, then the new host
    // leaves too; the last two finish in sync.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 3, teams: [0, 1, 2, 3] });
        await H.playFor(world, [host, ...guests], 4000, { seed: 171 });
        host.eval(`leaveMultiplayerToMainMenu('')`);
        assert.ok((await waitForNewHost(world, guests, 10000)) < 4000);
        await H.playFor(world, guests, 3000, { seed: 172 });
        const second = guests.find(g => g.eval('isHost'));
        second.eval(`leaveMultiplayerToMainMenu('')`);
        const rest = guests.filter(g => g !== second);
        assert.ok((await waitForNewHost(world, rest, 10000)) < 4000);
        const from = Math.max(...rest.map(g => g.lastSnapshotTick || 0));
        await H.playFor(world, rest, 6000, { seed: 173 });
        await world.run(2000);
        H.checkHealthy(world, rest, { minCompared: 20, fromTick: from, label: 'two hosts left' });
        assert.equal(rest[0].eval('netCounters.hostMigrations'), 2);
        rows.push('two hosts leave in a row: the last two players continue in sync');
    }

    // I: with a spectator present, a player (not the spectator) takes over,
    // and the spectator follows the match to the new host.
    {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const spec = world.spawn('spectator', { url: `http://localhost/rng/defence3/index.html?game=${hostId}` });
        spec.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(hostId)})`);
        assert.ok(await world.runUntil(() => spec.eval('remoteMatchRunning'), 10000));
        spec.eval('requestSpectateCurrentMatch()');
        assert.ok(await world.runUntil(() => spec.eval('gameStarted') && !spec.eval('lockstepResyncPauseActive'), 15000));
        await H.playFor(world, [host, ...guests], 3000, { seed: 181 });
        host.eval(`leaveMultiplayerToMainMenu('')`);
        const rest = [...guests, spec];
        assert.ok((await waitForNewHost(world, rest, 10000)) < 5000);
        assert.equal(spec.eval('isHost'), false, 'a player hosts, not the spectator');
        const from = Math.max(...rest.map(i => i.lastSnapshotTick || 0));
        await H.playFor(world, guests, 6000, { seed: 182 });
        await world.run(2000);
        H.checkHealthy(world, rest, { minCompared: 20, fromTick: from, label: 'spectator follows' });
        rows.push('spectator present: a player takes over, the spectator follows in sync');
    }

    // J: seed sweep of the most common case (host tab closes, then reloads)
    // over varied latency and jitter with real gzip, whose timing is real:
    // races between links opening, snapshots and joins show up here. One
    // once left a guest without its snapshot (sent while its link opened).
    {
        const times = [];
        for (let seed = 0; seed < 8; seed++) {
            const world = new H.World({ network: { latencyMs: 40 + (seed % 5) * 30, jitterMs: 10 + (seed % 3) * 20 }, controls: H.SMALL_MATCH_CONTROLS, compressSnapshots: true });
            world.net.rngState = (0x9e3779b9 + (503 + seed) * 7919) >>> 0;
            const { host, guests } = await H.startHostedMatch(world, { guests: 3, teams: [0, 1, 0, 1], hostSetup: 'NET_SNAPSHOT_COMPRESS_MIN_BYTES = 0' });
            await H.playFor(world, [host, ...guests], 3000 + (seed % 4) * 700, { seed: 600 + seed });
            const oldHostId = host.eval('myPeerId');
            world.kill(host);
            const ms = await waitForNewHost(world, guests, 10000);
            assert.ok(ms < 5000, `seed ${seed}: moved in ${ms}`);
            const nh = guests.find(g => g.eval('isHost'));
            const back = world.spawn('back', { storage: host.storage, session: host.session, url: `http://localhost/rng/defence3/index.html?game=${oldHostId}&room=${oldHostId}` });
            back.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(oldHostId)})`);
            const t1 = world.now;
            assert.ok(await world.runUntil(() => back.eval('gameStarted') && settled([back, ...guests]) && !nh.eval('netGetWaitingPeerIds().length') && back.eval('currentTick') > 0, 15000), `seed ${seed}: host back`);
            times.push([ms, world.now - t1]);
            const all = [back, ...guests];
            const from = Math.max(...all.map(i => i.eval('currentTick')));
            await H.playFor(world, all, 3000, { seed: 700 + seed });
            await world.run(1500);
            H.checkHealthy(world, all, { minCompared: 5, fromTick: from, label: 'sweep ' + seed });
        }
        const worst = times.reduce((m, t) => [Math.max(m[0], t[0]), Math.max(m[1], t[1])], [0, 0]);
        rows.push(`8-seed sweep (latency 40-160ms, jitter 10-50ms, gzip): moved within ${worst[0]}ms, host back within ${worst[1]}ms, in sync`);
    }

    console.log('PASS: host migration\n  ' + rows.join('\n  '));
})().catch(err => { console.error(err); process.exit(1); });
