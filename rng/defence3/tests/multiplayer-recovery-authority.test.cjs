// Who recovers what (audit 2026-10-16, MULTIPLAYER_AUDIT_2026-10-15.md 23,
// 25, 26, 27):
// 25. A join must prove every profile claim: one whose peer id equals a
//     disconnected player's public profile id, or reuses that player's
//     freed peer id, no longer takes that player's slot and team without
//     its key. The player itself still gets its slot back.
// 26. A host that resigned still resigns a leaving player's team (its
//     administrative commands were refused while it was defeated): in a
//     three-team match the last player wins.
// 27. A command sent while the guest's match reloads, never delivered,
//     runs once after the reload (sent was taken for safe and it was lost);
//     one delivered and kept as well runs once too (the host leaves copies
//     out).
// 23. A guest's (or the host's) simulation worker lost while it restores a
//     snapshot: noticed, a new worker, the match got again (it stood at its
//     tick for good, never ready).
//   node tests/multiplayer-recovery-authority.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 50, jitterMs: 5 };
// ONLY=25,27: those findings' parts alone (each fails on the code before its fix).
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const part = n => !ONLY || ONLY.includes(String(n));

// The guest's next snapshot decode waits until __scratch.release() is called.
const HOLD = `(() => {
    const f = netDecodeSnapshotPayload;
    netDecodeSnapshotPayload = function (payload) {
        if (!__scratch.holdNext) return f.apply(this, arguments);
        __scratch.holdNext = false; __scratch.holding = true;
        const p = f.apply(this, arguments);
        return new Promise(res => { __scratch.release = () => { __scratch.holding = false; res(p); }; });
    };
    __scratch.holdNext = true;
})()`;
// The host counts each command id in the bundles it seals.
const SEALS = `(() => {
    __scratch.sealed = {}; const seen = new WeakSet();
    const f = maybeBuildHostBundle;
    maybeBuildHostBundle = function () {
        const b = f.apply(this, arguments);
        if (b && !seen.has(b)) { seen.add(b); for (const p of b.packets) for (const a of p.actions || []) if (a && a.netId) __scratch.sealed[a.netId] = (__scratch.sealed[a.netId] || 0) + 1; }
        return b;
    };
})()`;
const hostOf = inst => inst.eval('isHost ? myPeerId : wsHostId');

(async () => {
    const rows = [];
    // 25.
    if (part(25)) {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        await H.playFor(world, [host, ...guests], 1500, { seed: 81 });
        const url = `http://localhost/rng/defence3/index.html?game=${hostId}&room=${hostId}`;
        const victim = guests[1], victimPeer = victim.eval('myPeerId'), victimUid = victim.eval('localPersistentPeerId');
        const victimTeam = host.eval(`getTeamIdForPeer(${JSON.stringify(victimPeer)})`);
        const storage = victim.storage;
        world.kill(victim);
        await world.run(2000);
        const refused0 = host.eval('netCounters.profileClaimsRefused | 0');
        // A peer id equal to the victim's profile id, no key.
        const imp = world.spawn('impostor', { url });
        imp.eval(`(() => { const P = window.Peer; window.Peer = class extends P { constructor() { super(${JSON.stringify(victimUid)}); } }; localPersistentPeerId = ''; joinGame(${JSON.stringify(hostId)}); })()`);
        assert.ok(await world.runUntil(() => host.eval(`connections.some(c => c.peer === ${JSON.stringify(victimUid)})`), 10000), 'the impostor is connected');
        await world.run(3000);
        assert.equal(imp.eval('myPeerId'), victimUid, 'its peer id is the victim\'s profile id');
        assert.notEqual(host.eval(`matchRoleByPeerId[${JSON.stringify(victimUid)}] || ''`), 'playing', 'it does not play the victim\'s slot');
        assert.notEqual(host.eval(`getTeamIdForPeer(${JSON.stringify(victimUid)})`), victimTeam, 'nor its team');
        assert.equal(host.eval(`peerUidByPeerId[${JSON.stringify(victimUid)}]`), 'peer:' + victimUid, 'it stands under its connection id');
        assert.equal(host.eval(`matchRoleByUid[${JSON.stringify(victimUid)}]`), 'playing', 'the victim\'s role stays the victim\'s');
        world.kill(imp);
        rows.push('a peer id equal to a profile id, no key: joined as itself');
        // The victim's own (freed) peer id, under another profile.
        const imp2 = world.spawn('impostor2', { url });
        imp2.eval(`(() => { loadOrCreateLocalIdentity(); const P = window.Peer; window.Peer = class extends P { constructor() { super(${JSON.stringify(victimPeer)}); } }; joinGame(${JSON.stringify(hostId)}); })()`);
        assert.ok(await world.runUntil(() => host.eval('netCounters.profileClaimsRefused | 0') > refused0, 10000), 'the join under the victim\'s peer id is refused');
        await world.run(2000);
        assert.equal(imp2.eval('gameStarted'), false, 'it got no match');
        assert.equal(host.eval(`peerUidByPeerId[${JSON.stringify(victimPeer)}]`), victimUid, 'the peer id stays the victim\'s');
        world.kill(imp2);
        rows.push("another profile under a gone player's peer id: refused");
        // The player itself (its storage: id and key) gets the slot back.
        const back = world.spawn('back', { storage, url });
        back.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(hostId)})`);
        assert.ok(await world.runUntil(() => back.eval('gameStarted') && host.eval(`matchRoleByPeerId[${JSON.stringify(back.eval('myPeerId'))}] || ''`) === 'playing', 20000), 'the player is back in its slot');
        assert.equal(host.eval(`getTeamIdForPeer(${JSON.stringify(back.eval('myPeerId'))})`), victimTeam, 'on its team');
        const all = [host, guests[0], back];
        assert.ok(await world.runUntil(() => all.every(i => !i.eval('lockstepResyncPauseActive')), 10000));
        const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
        await H.playFor(world, all, 2500, { seed: 82 });
        await world.run(1500);
        H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: 'after the claims' });
        rows.push('the player with its key: back in its slot');
    }
    // 26, page and worker.
    for (const simWorker of part(26) ? [false, true] : []) {
        const mode = simWorker ? 'worker' : 'page';
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        world.simWorker = simWorker;
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 1500, { seed: 83 });
        const team = i => i.eval('localPlayerId');
        const [hostTeam, t1, t2] = all.map(team);
        host.eval(`queueAction({ action: 'resign' })`);
        assert.ok(await world.runUntil(() => all.every(i => i.eval(`resignedTeams.has(${hostTeam})`)), 10000), mode + ': the host resigned');
        assert.equal(host.eval('localDefeated'), true);
        guests[1].eval('leaveMultiplayerToMainMenu()');
        const rest = [host, guests[0]];
        assert.ok(await world.runUntil(() => rest.every(i => i.eval(`resignedTeams.has(${t2})`)), 10000),
            mode + ': the leaver\'s team resigned: ' + JSON.stringify(rest.map(i => i.eval('[...resignedTeams]'))));
        assert.ok(await world.runUntil(() => rest.every(i => i.eval('gameOver')), 15000), mode + ': the match ended');
        assert.deepEqual(rest.map(i => i.eval('winner')), [t1, t1], mode + ': the last player won');
        assert.deepEqual(rest.flatMap(i => i.errors.map(e => String(e && e.message || e).slice(0, 200))), [], mode + ': no errors');
        rows.push(mode + ': a resigned host resigned a leaving player\'s team; the last player won');
    }
    // 27: a command while the guest's match reloads, delivered or not.
    for (const kind of part(27) ? ['lost', 'delivered'] : []) {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 1500, { seed: 84 });
        const g = guests[0], gp = g.eval('myPeerId');
        host.eval(SEALS);
        // (The host gets none of the guest's packets while __scratch.drop.)
        host.eval(`(() => { const f = _handleConnectionMessage; _handleConnectionMessage = function (conn, data) {
            if (__scratch.drop && data && data.type === 'TICK_PACKETS' && conn && conn.peer === ${JSON.stringify(gp)}) return;
            return f.apply(this, arguments); }; })()`);
        g.eval(HOLD);
        host.eval(`hostSendFullMatchSync(connections.find(c => c.peer === ${JSON.stringify(gp)}), 'playing')`);
        assert.ok(await world.runUntil(() => g.eval('!!__scratch.holding'), 5000), 'the reload is decoding');
        if (kind === 'lost') host.eval('__scratch.drop = true');
        const before = new Set(world.issued.keys());
        g.eval(`(() => { const u = units.find(u => u.owner === localPlayerId && !u.dead); queueAction({ action: 'move', unitIds: [u.id], targetX: u.x + 48, targetY: u.y + 16 }); })()`);
        const netId = [...world.issued].find(([id, i]) => !before.has(id) && i.by === g.name)?.[0];
        assert.ok(netId, 'queued while decoding');
        const at = g.eval(`Number(Object.keys(localInputBuffer).find(k => localInputBuffer[k].some(a => a.netId === ${JSON.stringify(netId)})))`);
        // (Its tick runs on the guest meanwhile, sealed without it: the
        // host leaves a joining player out.)
        await world.run(400);
        assert.ok(g.eval(`lockstepHighestSentLocalTick >= ${at} && currentTick > ${at}`), kind + ': sent, and its tick ran on the guest');
        host.eval('__scratch.drop = false');
        g.eval('__scratch.release()');
        assert.ok(await world.runUntil(() => all.every(i => i.executedActions.has(netId)), 15000),
            kind + ': the command ran on every peer: ' + JSON.stringify(all.map(i => [i.name, i.executedActions.has(netId)])));
        await world.run(3000);
        assert.equal(host.eval(`__scratch.sealed[${JSON.stringify(netId)}] | 0`), 1, kind + ': sealed once');
        const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
        await H.playFor(world, all, 2500, { seed: 85 });
        await world.run(1500);
        H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: kind + ' command during a reload' });
        rows.push(`a command sent while the guest's match reloaded (${kind === 'lost' ? 'never delivered' : 'delivered too'}): ran once on every peer`);
    }
    // 23: a worker lost while it restores a snapshot.
    for (const who of part(23) ? ['guest', 'host'] : []) {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        world.simWorker = true;
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 1500, { seed: 86 });
        const victim = who === 'host' ? host : guests[0];
        const teams = all.map(i => i.eval('localPlayerId'));
        // (Killed right after the page hands it the restore.)
        victim.eval(`(() => { const f = simClientAfterSnapshotApplied; simClientAfterSnapshotApplied = function () {
            const r = f.apply(this, arguments);
            if (__scratch.killOnRestore && simClientActive()) { __scratch.killOnRestore = false; _simClient.worker.terminate(); }
            return r; }; __scratch.killOnRestore = true; })()`);
        const t0 = world.now;
        host.eval(`_startHostResyncPause('restore, worker killed')`);
        assert.ok(await world.runUntil(() => victim.eval('!__scratch.killOnRestore'), 10000), who + ': the worker was killed in the restore');
        assert.ok(await world.runUntil(() => victim.eval('simClientLostPending()'), 30000), who + ': the page noticed the lost worker');
        const noticed = world.now - t0;
        const back = await world.runUntil(() => {
            if (all.some(i => i.eval('simClientLostPending()'))) return false;
            if (!all.every(i => i.eval('gameStarted && !lockstepResyncPauseActive && simClientActive()'))) return false;
            return new Set(all.map(hostOf)).size === 1;
        }, 60000, 100);
        assert.ok(back, who + ': the match came back: ' + JSON.stringify(all.map(i => [i.name, i.eval('isHost'), i.eval('simClientLostPending()'), i.eval('simClientActive()'), i.eval('lockstepResyncPauseActive'), i.eval('currentTick'), hostOf(i)])));
        const ticks = all.map(i => i.eval('currentTick'));
        await world.run(3000);
        assert.ok(all.every((i, k) => i.eval('currentTick') > ticks[k] + 30), who + ': every page ticks on: ' + JSON.stringify(all.map((i, k) => [ticks[k], i.eval('currentTick')])));
        assert.deepEqual(all.map(i => i.eval('[...resignedTeams]').length), [0, 0, 0], who + ': no team resigned');
        assert.deepEqual(all.map(i => i.eval('localPlayerId')), teams, who + ': every page on its own team');
        const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
        await H.playFor(world, all, 2500, { seed: 87 });
        await world.run(1500);
        for (const i of all) i.errors = i.errors.filter(e => !/lost during the match|simulation worker was lost|while loading the match/.test(String(e && e.message || e)));
        H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: who + ' worker lost in a restore' });
        rows.push(`${who}'s worker lost in a restore: noticed after ${Math.round(noticed)} ms, the match back`);
    }
    console.log('PASS multiplayer-recovery-authority\n  ' + rows.join('\n  '));
})().catch(e => { console.error(e); process.exit(1); });
