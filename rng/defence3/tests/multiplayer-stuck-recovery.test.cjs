// Recovery that stopped with every page still linked (audit rows 81-98, MULTIPLAYER_AUDIT_2026-10-15.md, the
// 2026-11-20 audits). Each part makes the fault, then asks that every surviving peer advances, agrees on its state
// and runs new commands (H.checkHealthy over the ticks after, with every command issued then executed).
//  81 worker: a guest's tick result fails to publish once, then its state differs: the patch applies (a phantom
//     tick in flight held the patch gate for good).
//  82 worker: the host's worker goes silent (no error): judged against the guest's progress, it is lost; the match
//     goes on (it froze with the host page answering the network).
//  83 worker: both peers' workers lost at once: the host runs the match again from its checkpoint, the guest gets it
//     (both stood at the loss for good, asking each other).
//  84 a guest-only player difference that comes back after every patch: escalated to a full repair (partial patches
//     for good).
//  85 page: a host's statistics throw once after a tick ran: the step does not run twice (the guest patched to the
//     host's extra step).
//  86 the host leaves after the guests loaded, before the countdown: the new host starts the match (tick 0 for good).
//  87 a guest that found its state diverged does not win the host migration over a healthy one (its state became
//     the match's).
//  88 a guest's one START_GAME_READY is lost: it is still counted ready (dropped at the deadline as loading).
//  89 page: the host's start snapshot fails to build once: both sides back in the lobby, the next start runs (both
//     stood at tick 0 / "Match Starting").
//  90 the host's peer closes for good with every page alive: one host again, one match (two hosts for good).
//  91 a live join's restore throws once: the next join comes at once (ten minutes).
//  92 worker: a join snapshot slower to encode than the 45 s silence: still delivered (each discarded).
//  93 a final state's encode outlasts the match: its result is not sent as the rematch's (the rematch reloaded).
//  94 a guest with another winner and a slow decode: one final state applied (each answer dropped the one decoding).
//  95 a rejoin scheduled for a tick after the end: the player gets the final state (stranded).
//  96 the host's end announcement lost: the guest's request past the last tick brings it (asked for good).
//  97 a hidden guest's false victory: repaired (it stopped checking).
//  98 the same winner, another final world: repaired (confirmed as it was).
// 101 worker: the host's worker is lost while the first successor knows it diverged: the healthy guest takes the
//     match (the diverged state became everyone's).
// 102 a START_GAME_COUNTDOWN 8.5 s late, after ALL_READY: the running match is not covered (for good).
// 103 a live join's decode outlasts a match-wide recovery: its older state is not restored over the newer one, and
//     the host sends no further join.
// 104 the same winner, units' energy differs at the end: repaired (the end tick's partial hash agreed).
// 105 a starting player resigned and spectates, then the host is lost: the successor's rematch has it playing.
// 106 a spectator's first restore throws: it asks again and spectates (stood on the loading screen).
// 107 the host's snapshot for a reloaded player fails once: made again (the match stood, waiting for that player).
// 108 a late patch request reaches the host the tick before a guest's join: the join still goes (the guest stood).
// 109 worker: a match-wide recovery's snapshot is a guest's checkpoint; that guest hosts after a migration and every
//     simulation is lost: run again from it (stood at the loss).
// 110 an order queued for a tick before a recovery's snapshot, not sent: run after the restore (dropped).
// 111 a copy of a visitor's RESYNC_NO_MATCH comes after it spectates: it still takes part in the next pause.
// 112 a guest's request of the last match reaches the host in the rematch: dropped (reloaded the rematch).
// 113 worker: the preferred successor lost its simulation just before the host: the healthy guest takes over (the
//     empty world became the match's).
// 114 worker, shared memory: both workers stop publishing on the same tick: lost by their own progress, the match
//     goes on (stood for good, no peer completing the tick).
// 115 a guest's setup fails once at the start: applied again (the host waited ten minutes, dropped it and won).
// 116 page: a cancelled start's prepare arrives after the retry's: dropped, the retry runs (the guest dropped it).
// 117 worker: a host order sealed, not run, the bundle not delivered, then the host's worker lost: it runs on both.
// 118 the host's peer closes while it prepares the start: no lone start (it started and won alone).
// 119 a three-player split heals with crossing probes: the host with a player stays (both demoted).
// 120 orders under the start's loading overlay (input blocked): queued at the release, run on both (dropped).
// 121 the preferred successor waits for the whole match (its request) when the host is lost: the guest with the
//     running match takes over, a Hold both ran survives (the waiting guest's tick 8 became the match's).
// 122 worker: the guest's link closes, then its worker is lost: the reconnected guest gets the whole match (it offered
//     a soft resume, its recovery loop ended with the old link: stood for good).
// 123 a guest's setup fails once after the world reset cleared the match id: applied again (the host waited ten
//     minutes and dropped it).
// 124 a JOIN_LIVE_ACK of the last match's join reaches the guest in the rematch: dropped (a Hold ran 227 ticks late).
// 125 a held order (awaiting JOIN_LIVE_ACK), then the next join's apply throws once: the order still runs (lost).
// 126 the guest's link closes after its join was scheduled, before it is sent: the reconnected guest gets a join
//     (every request taken for a repeat of the unsent one, for good).
// 127 the host's START_GAME to a guest is lost: sent again on the guest's beat (ten minutes, then dropped).
// 128 a duplicate START_GAME reaches a running guest: dropped (it went back to tick 0).
//   node tests/multiplayer-stuck-recovery.test.cjs   (ONLY=81,85; MODES=page,worker)
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 40, jitterMs: 5 };
const KING = { ...H.SMALL_MATCH_CONTROLS, 'cfg-gamemode': 'killking' };
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const part = n => !ONLY || ONLY.includes(String(n));
const MODES = process.env.MODES ? process.env.MODES.split(',') : (process.env.SIM_WORKER === '1' ? ['worker'] : ['page', 'worker']);
const url = hostId => `http://localhost/rng/defence3/index.html?game=${hostId}&room=${hostId}`;
// The whole file: each part in its own process (the harness has no world teardown; ~45 parts in one process reached
// the 4 GB heap).
if (!ONLY && !process.env.STUCK_PART_CHILD) {
    const { spawnSync } = require('node:child_process');
    const parts = [...new Set([...require('node:fs').readFileSync(__filename, 'utf8').matchAll(/part\((\d+)\)/g)].map(m => m[1]))];
    const failed = [];
    let ran = 0;
    for (const mode of MODES) for (const p of parts) {
        const r = spawnSync(process.execPath, [__filename], { env: { ...process.env, ONLY: p, MODES: mode, STUCK_PART_CHILD: '1' }, encoding: 'utf8', maxBuffer: 256e6 });
        const out = (r.stdout || '') + (r.stderr || '');
        for (const l of out.split('\n')) if (/^  \S/.test(l)) { console.log(l); ran++; }
        if (r.status !== 0) { failed.push(mode + ' ' + p); console.error('FAIL ' + mode + ' ' + p + ':\n' + out.split('\n').filter(l => !/^\s+at /.test(l)).slice(-30).join('\n')); }
    }
    if (failed.length) { console.error('FAIL multiplayer-stuck-recovery: ' + failed.join(', ')); process.exit(1); }
    console.log('PASS multiplayer-stuck-recovery (' + ran + ' parts, one process each)');
    process.exit(0);
}
const RESIGN = `(typeof resignLocalPlayer === 'function' ? resignLocalPlayer() : (queueAction({ action: 'resign' }), enterSpectateMode('defeated'), connections[0].send({ type: 'MATCH_ROLE_UPDATE', role: 'spectating' })))`;
const live = i => i.eval('gameStarted && !gameOver && !lockstepResyncPauseActive && !resyncGuest.joining && !resyncGuest.awaitingLive && !matchStartWaitingForReady');
const ticks = all => all.map(i => i.eval('currentTick'));
const state = i => i.eval(`JSON.stringify({ host: isHost, t: currentTick, go: gameOver, w: winner, pause: lockstepResyncPauseActive, wait: matchStartWaitingForReady,
    act: typeof simClientActive === 'function' && simClientActive(), lost: typeof simClientLostPending === 'function' && simClientLostPending(), applied: _simClient ? _simClient.appliedTick : null,
    inflight: _simClient ? _simClient.inFlight : null, T: resyncGuest.T, out: resyncGuest.outstanding, join: resyncGuest.joining, conns: connections.length, wh: String(wsHostId || '').slice(0, 6) })`);
const report = all => JSON.stringify(all.filter(i => !i.dead).map(i => [i.name, state(i), i.errors.slice(-3).map(e => String(e && e.message || e).slice(0, 160))]));
// Every live peer runs on (by `by` ticks) out of any pause.
async function runsOn(world, all, by, ms, label) {
    const t = ticks(all);
    const ok = await world.runUntil(() => all.every((i, k) => live(i) && i.eval('currentTick') > t[k] + by), ms, 100);
    assert.ok(ok, label + ': every peer runs on: ' + report(all));
}
// Then agrees, and runs the commands issued from now on.
async function healthy(world, all, seed, label, dropErrors = null) {
    const from = Math.max(...ticks(all)) + 5, at = world.now;
    await H.playFor(world, all, 3000, { seed });
    await world.run(2500);
    if (dropErrors) for (const i of all) i.errors = i.errors.filter(e => !dropErrors.test(String(e && e.stack || e)));
    H.checkHealthy(world, all, { minCompared: 8, fromTick: from, label });
    for (const i of all) H.assertAllCommandsExecuted(world, i, label, world.now - 2500);
    return at;
}
function newWorld(mode, controls = H.SMALL_MATCH_CONTROLS) {
    const world = new H.World({ network: WAN, controls });
    world.simWorker = mode === 'worker';
    return world;
}
const repairs = g => g.patchesApplied + g.snapshotsApplied;
const INJECTED = /injected|state lost \(test\)|simulation worker was lost|lost during the match|Failed to start|Failed to apply match start|no start snapshot/;

(async () => {
    const rows = [];
    for (const mode of MODES) {
        const worker = mode === 'worker';
        if (part(81) && worker) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 811 });
            g.simWorker.eval(`(() => { const f = _simPostResult; let n = 1; _simPostResult = function () { if (n-- > 0) throw new Error('injected publish failure'); return f.apply(this, arguments); }; })()`);
            await world.run(600);
            const r0 = repairs(g);
            g.evalSim(`players[localPlayerId].energy += 321`);
            assert.ok(await world.runUntil(() => repairs(g) > r0 && g.eval('resyncGuest.T') < 0, 20000, 100), mode + ' 81: the patch applied: ' + report(all));
            await runsOn(world, all, 40, 15000, mode + ' 81');
            await healthy(world, all, 812, mode + ' 81', INJECTED);
            rows.push(mode + ' 81: a failed publication, then a patch: applied, in sync');
        }
        if (part(82) && worker) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 821 });
            // (Its results stop: nothing posted, no error.)
            host.simWorker._sandbox.postMessage = () => { };
            const t0 = Math.max(...ticks(all));
            await world.run(5000);
            await runsOn(world, all, 60, 90000, mode + ' 82');
            assert.ok(Math.min(...ticks(all)) > t0 + 60, mode + ' 82: past the stall');
            await healthy(world, all, 822, mode + ' 82', INJECTED);
            rows.push(mode + ' 82: a silent host worker: lost, the match goes on (host now ' + (host.eval('isHost') ? 'host' : 'guest') + ')');
        }
        if (part(83) && worker) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 2500, { seed: 831 });
            const t0 = Math.max(...ticks(all));
            for (const i of all) {
                i.simWorker.terminate();
                i.eval("_simClientOnMessage({ type: 'restoreFailed', epoch: _simClient.epoch, message: 'state lost (test)' })");
            }
            await runsOn(world, all, 40, 120000, mode + ' 83');
            assert.ok(host.eval('netCounters.checkpointRestores | 0') >= 1, mode + ' 83: from the checkpoint');
            assert.ok(Math.min(...ticks(all)) > t0, mode + ' 83: past the loss');
            await healthy(world, all, 832, mode + ' 83', INJECTED);
            rows.push(mode + ' 83: both workers lost: the match again from the host\'s checkpoint');
        }
        if (part(84)) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 841 });
            const f0 = g.fullPatchesApplied, s0 = g.snapshotsApplied;
            // (Guest-only: a little energy every tick, for 20 s.)
            g.evalSim(`(() => { const f = resourceTick; const until = gameTime + 400; resourceTick = function () { const r = f.apply(this, arguments); if (gameTime < until) players[localPlayerId].energy += 3; return r; }; })()`);
            assert.ok(await world.runUntil(() => g.fullPatchesApplied > f0 || g.snapshotsApplied > s0, 40000, 100),
                mode + ' 84: escalated to a full repair: ' + JSON.stringify([g.patchesApplied, g.fullPatchesApplied, g.snapshotsApplied]));
            await world.run(25000);
            await runsOn(world, all, 40, 30000, mode + ' 84');
            await healthy(world, all, 842, mode + ' 84');
            rows.push(mode + ' 84: a recurring player difference: ' + (g.fullPatchesApplied - f0) + ' full patches, ' + (g.snapshotsApplied - s0) + ' reloads');
        }
        if (part(85) && !worker) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 851 });
            const r0 = repairs(g);
            host.eval(`(() => { const f = gameStatsStep; let n = 1; gameStatsStep = function () { if (n-- > 0) throw new Error('injected stats failure'); return f.apply(this, arguments); }; })()`);
            await runsOn(world, all, 60, 15000, mode + ' 85');
            assert.equal(repairs(g), r0, mode + ' 85: no repair (the host ran no step twice)');
            await healthy(world, all, 852, mode + ' 85', INJECTED);
            rows.push(mode + ' 85: a statistics failure after the step: one step');
        }
        if (part(86)) {
            const world = newWorld(mode);
            const spawn = world.spawn.bind(world);
            let first = true;
            // (The host never starts the countdown: it leaves in the wait.)
            world.spawn = (name, o) => { const i = spawn(name, o); if (first) { first = false; i.eval('_hostMaybeStartCountdown = () => { }'); } return i; };
            const p = H.startHostedMatch(world, { guests: 2, maxMs: 15000 }).catch(e => e);
            let host = null;
            await world.runUntil(() => { host = world.instances[0]; return world.instances.length === 3 && world.instances.slice(1).every(i => i.eval('gameStarted && matchStartWaitingForReady')) && world.instances.slice(1).every(i => i.eval('_matchStartPlayerStatuses && _matchStartPlayerStatuses[myPeerId] === "ready"')); }, 30000, 100);
            await world.run(1500);
            const others = world.instances.slice(1);
            assert.ok(others.every(i => i.eval('gameStarted && matchStartWaitingForReady')), mode + ' 86: the guests wait for the countdown');
            const oldId = host.eval('myPeerId');
            world.kill(host);
            await p;
            // (The lost host stays a player until back or dropped: the new host drops it, as the match's players would.)
            assert.ok(await world.runUntil(() => others.some(i => i.eval('isHost')), 90000, 100), mode + ' 86: a new host: ' + report(others));
            others.find(i => i.eval('isHost')).eval('hostRemovePlayerFromMatch(' + JSON.stringify(oldId) + ')');
            await runsOn(world, others, 60, 90000, mode + ' 86');
            await healthy(world, others, 862, mode + ' 86');
            rows.push(mode + ' 86: the host lost before the countdown: the new host started the match');
        }
        if (part(87)) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
            const all = [host, ...guests];
            await H.playFor(world, all, 1500, { seed: 871 });
            // (The successor order: the smaller id first. That one diverges; its mismatch is seen, not repaired.)
            const ids = guests.map(g => g.eval('myPeerId'));
            const [bad, good] = ids[0] < ids[1] ? guests : [guests[1], guests[0]];
            host.eval('resyncHostHandleRequest = () => { }');
            const nid0 = good.evalSim('nextUnitId');
            bad.evalSim('nextUnitId += 1000000');
            assert.ok(await world.runUntil(() => bad.eval('netCounters.desyncsDetected | 0') > 0, 20000, 100), mode + ' 87: the divergence was found');
            const oldId = host.eval('myPeerId');
            world.kill(host);
            assert.ok(await world.runUntil(() => [bad, good].some(i => i.eval('isHost')), 90000, 100), mode + ' 87: a new host: ' + report([bad, good]));
            assert.ok(good.eval('isHost'), mode + ' 87: the healthy guest took over: ' + report([bad, good]));
            good.eval('hostRemovePlayerFromMatch(' + JSON.stringify(oldId) + ')');
            await runsOn(world, [bad, good], 40, 60000, mode + ' 87');
            assert.ok(Math.abs(bad.evalSim('nextUnitId') - nid0) < 1000000 && Math.abs(good.evalSim('nextUnitId') - nid0) < 1000000, mode + ' 87: the healthy state stands');
            await healthy(world, [bad, good], 872, mode + ' 87');
            rows.push(mode + ' 87: a diverged guest passed over in the migration');
        }
        if (part(88)) {
            const world = newWorld(mode);
            const spawn = world.spawn.bind(world);
            let n = 0;
            world.spawn = (name, o) => {
                const i = spawn(name, o);
                if (n++ === 1) i.eval(`(() => { let dropped = false; const wrap = () => { const c = connections[0]; if (!c || c.__w) return; c.__w = true; const f = c.send.bind(c); c.send = d => { if (d && d.type === 'START_GAME_READY' && !dropped) { dropped = true; return; } f(d); }; }; setInterval(wrap, 20); })()`);
                return i;
            };
            const { host, guests } = await H.startHostedMatch(world, { guests: 1, maxMs: 30000 });
            const all = [host, ...guests];
            await runsOn(world, all, 40, 30000, mode + ' 88');
            await healthy(world, all, 882, mode + ' 88');
            rows.push(mode + ' 88: a lost START_GAME_READY: counted by the beat');
        }
        if (part(89) && !worker) {
            const world = newWorld(mode);
            const spawn = world.spawn.bind(world);
            let first = true;
            world.spawn = (name, o) => { const i = spawn(name, o); if (first) { first = false; i.eval(`(() => { const f = buildHostAuthoritativeStateSnapshot; let n = 1; buildHostAuthoritativeStateSnapshot = function (o) { if (o && o.includeGridTypes && !o.includeConfig && n-- > 0) throw new Error('injected snapshot failure'); return f.apply(this, arguments); }; })()`); } return i; };
            const err = await H.startHostedMatch(world, { guests: 1, maxMs: 8000 }).then(() => null, e => e);
            assert.ok(err, mode + ' 89: the first start failed');
            const [host, g] = world.instances;
            assert.ok(await world.runUntil(() => !host.eval('gameStarted') && !g.eval('gameStarted') && !g.eval('_matchStartPlayerStatuses'), 10000, 100), mode + ' 89: both back in the lobby: ' + report([host, g]));
            host.errors = host.errors.filter(e => !INJECTED.test(String(e && e.stack || e)));
            host.eval('startHostedGame()');
            assert.ok(await world.runUntil(() => [host, g].every(i => i.eval('gameStarted && !matchStartWaitingForReady')) && host.eval('currentTick') > 10, 20000, 100), mode + ' 89: the next start runs: ' + report([host, g]));
            await healthy(world, [host, g], 892, mode + ' 89', INJECTED);
            rows.push(mode + ' 89: a failed start snapshot: back in the lobby, the next start runs');
        }
        if (part(90)) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
            const all = [host, ...guests];
            await H.playFor(world, all, 1500, { seed: 901 });
            for (const p of host.peers) if (!p.destroyed) p.destroy();
            assert.ok(await world.runUntil(() => all.filter(i => i.eval('isHost')).length === 1 && all.every(live) && all.every(i => i.eval('connections.length') >= 1), 120000, 200), mode + ' 90: one host again: ' + report(all));
            await runsOn(world, all, 40, 60000, mode + ' 90');
            await healthy(world, all, 902, mode + ' 90');
            rows.push(mode + ' 90: the host\'s peer closed: one host, one match');
        }
        if (part(91)) {
            const world = newWorld(mode);
            const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 1 });
            await H.playFor(world, [host, ...guests], 1500, { seed: 911 });
            const g0 = guests[0], storage = g0.storage;
            world.kill(g0);
            const g = world.spawn('reloaded', { storage, url: url(hostId) });
            // (It throws once its join's loading beat runs: the beat kept the failed join alive at the host.)
            g.eval(`(() => { const f = startGame; let n = 1; startGame = function () { if (_guestJoinLoadingTimer && n-- > 0) throw new Error('injected restore failure'); return f.apply(this, arguments); }; })()`);
            g.eval('loadOrCreateLocalIdentity()');
            g.eval(`joinGame(${JSON.stringify(hostId)})`);
            // (Within the 45 s a silent join waits: the next join came only after ten minutes.)
            await runsOn(world, [host, g], 40, 40000, mode + ' 91');
            await healthy(world, [host, g], 912, mode + ' 91', INJECTED);
            rows.push(mode + ' 91: a join that threw: the next one at once');
        }
        if (part(92) && worker) {
            const world = newWorld(mode);
            const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 1 });
            await H.playFor(world, [host, ...guests], 1500, { seed: 921 });
            // (Every join snapshot of the host's worker takes 60 s to encode.)
            host.eval(`(() => { const f = simClientSnapshotText; simClientSnapshotText = function () { const r = f.apply(this, arguments); return new Promise((res, rej) => setTimeout(() => r.then(res, rej), 60000)); }; })()`);
            const g0 = guests[0], storage = g0.storage;
            world.kill(g0);
            const g = world.spawn('reloaded', { storage, url: url(hostId) });
            g.eval('loadOrCreateLocalIdentity()');
            g.eval(`joinGame(${JSON.stringify(hostId)})`);
            // (The first join's snapshot, finished at 60 s, is the one that comes: old code dropped it at the 45 s silence and got
            // through only with a later one.)
            assert.ok(await world.runUntil(() => g.snapshotsApplied > 0, 75000, 100), mode + ' 92: the first join arrived: ' + report([host, g]));
            await runsOn(world, [host, g], 40, 60000, mode + ' 92');
            await healthy(world, [host, g], 922, mode + ' 92');
            rows.push(mode + ' 92: a join slower than the silence limit: delivered');
        }
        if (part(93)) {
            const world = newWorld(mode, KING);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 931 });
            // (The host's final state for the guest encodes 15 s; the guest's own end differs: it asks for one.)
            host.eval(`(() => { const f = netEncodeSnapshotText; netEncodeSnapshotText = function (text) { const r = f.apply(this, arguments); return gameOver ? new Promise(res => setTimeout(() => res(r), 15000)) : r; }; })()`);
            const hostTeam = host.eval('localPlayerId');
            world.atNextSafeTick(`(() => { for (const u of units) if (u.isKing && u.owner !== ${hostTeam}) { u.energy = 0; u.dead = true; } })()`);
            assert.ok(await world.runUntil(() => all.every(i => i.eval('gameOver')), 15000, 100), mode + ' 93: ended');
            g.eval(`connections[0].send({ type: 'REQUEST_MATCH_SYNC', tick: currentTick, reason: 'test' })`);
            await world.run(1000);
            host.eval('hostRematch()');
            assert.ok(await world.runUntil(() => all.every(i => i.eval('gameStarted && !gameOver && !matchStartWaitingForReady')) && host.eval('currentTick') > 30, 30000, 100), mode + ' 93: the rematch runs');
            const s0 = g.snapshotsApplied;
            await world.run(30000);
            assert.equal(g.snapshotsApplied, s0, mode + ' 93: no reload of the rematch');
            assert.ok(!g.eval('gameOver'), mode + ' 93: the rematch goes on');
            await healthy(world, all, 932, mode + ' 93');
            rows.push(mode + ' 93: a late final state: not the rematch\'s');
        }
        if (part(94)) {
            const world = newWorld(mode, KING);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 941 });
            const hostTeam = host.eval('localPlayerId'), gTeam = g.eval('localPlayerId');
            // (Each decode on the guest takes 7 s.)
            g.eval(`(() => { const f = netDecodeSnapshotPayload; netDecodeSnapshotPayload = function () { const r = f.apply(this, arguments); return new Promise(res => setTimeout(() => res(r), 7000)); }; })()`);
            // (Opposite ends: the host's king falls on the guest, the guest's on the host.)
            world.atNextSafeTick(`(() => { const lose = isHost ? ${gTeam} : ${hostTeam}; for (const u of units) if (u.isKing && u.owner === lose) { u.energy = 0; u.dead = true; } })()`);
            assert.ok(await world.runUntil(() => all.every(i => i.eval('gameOver')), 15000, 100), mode + ' 94: ended');
            assert.ok(await world.runUntil(() => g.eval('winner') === host.eval('winner') && g.eval('netMatchEndFinal()'), 90000, 100), mode + ' 94: the host\'s end applied: ' + report(all) + ' ' + g.eval('netCounters.resultRepairs'));
            rows.push(mode + ' 94: another winner, slow decodes: the final state applied (' + g.snapshotsApplied + ' snapshots)');
        }
        if (part(95)) {
            const world = newWorld(mode, KING);
            const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
            const all = [host, ...guests];
            await H.playFor(world, all, 1500, { seed: 951 });
            const hostTeam = host.eval('localPlayerId'), back = guests[1], storage = back.storage;
            // (The returning player's join is due well after the end.)
            host.eval('{ const f = _resyncHostFirstOpenTick; _resyncHostFirstOpenTick = () => f() + 200; }');
            world.kill(back);
            await world.run(500);
            const g = world.spawn('reloaded', { storage, url: url(hostId) });
            g.eval('loadOrCreateLocalIdentity()');
            g.eval(`joinGame(${JSON.stringify(hostId)})`);
            assert.ok(await world.runUntil(() => host.eval('resyncHostPending.size') > 0, 20000, 50), mode + ' 95: a join scheduled');
            world.atNextSafeTick(`(() => { for (const u of units) if (u.isKing && u.owner !== ${hostTeam}) { u.energy = 0; u.dead = true; } })()`, 10);
            assert.ok(await world.runUntil(() => host.eval('gameOver'), 15000, 100), mode + ' 95: ended');
            assert.ok(await world.runUntil(() => g.eval('gameStarted && gameOver') && g.eval('winner') === host.eval('winner'), 60000, 100), mode + ' 95: the returning player has the end: ' + report([host, g]));
            rows.push(mode + ' 95: a rejoin due after the end: the final state');
        }
        if (part(96)) {
            const world = newWorld(mode, KING);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 961 });
            const gTeam = g.eval('localPlayerId');
            // (Only the host sees the end; its first MATCH_RESULT is lost.)
            host.eval(`(() => { const c = connections[0], f = c.send.bind(c); let n = 1; c.send = d => { if (d && d.type === 'MATCH_RESULT' && n-- > 0) return; f(d); }; })()`);
            const t = world.atNextSafeTick(`if (isHost) { for (const u of units) if (u.isKing && u.owner === ${gTeam}) { u.energy = 0; u.dead = true; } }`);
            assert.ok(await world.runUntil(() => host.eval('gameOver'), 15000, 100), mode + ' 96: the host ended');
            assert.ok(await world.runUntil(() => g.eval('gameOver') && g.eval('winner') === host.eval('winner') && g.eval('netMatchEndFinal()'), 60000, 100), mode + ' 96: the guest has the end: ' + report(all));
            rows.push(mode + ' 96: a lost end announcement: brought by the guest\'s request (end at ' + t + ')');
        }
        if (part(97)) {
            const world = newWorld(mode, KING);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 971 });
            const hostTeam = host.eval('localPlayerId');
            world.setHidden(g, true);
            await world.run(1000);
            // (The guest alone sees the host's king fall: a false victory, hidden.)
            world.atNextSafeTick(`if (!isHost) { for (const u of units) if (u.isKing && u.owner === ${hostTeam}) { u.energy = 0; u.dead = true; } }`);
            assert.ok(await world.runUntil(() => g.eval('gameOver'), 15000, 100), mode + ' 97: the guest ended');
            await runsOn(world, all, 40, 60000, mode + ' 97');
            world.setHidden(g, false);
            await healthy(world, all, 972, mode + ' 97');
            rows.push(mode + ' 97: a hidden false victory: repaired');
        }
        if (part(98)) {
            const world = newWorld(mode, KING);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 981 });
            const gTeam = g.eval('localPlayerId');
            // (The same end on both; the guest's last step adds energy.)
            world.atNextSafeTick(`(() => { for (const u of units) if (u.isKing && u.owner === ${gTeam}) { u.energy = 0; u.dead = true; } if (!isHost) players[localPlayerId].energy += 321; })()`);
            assert.ok(await world.runUntil(() => all.every(i => i.eval('gameOver')), 15000, 100), mode + ' 98: ended');
            const team = host.eval('localPlayerId');
            assert.ok(await world.runUntil(() => g.eval('netMatchEndFinal()') && g.evalSim(`players[${team}].energy`) === host.evalSim(`players[${team}].energy`)
                && g.evalSim(`players[${gTeam}].energy`) === host.evalSim(`players[${gTeam}].energy`), 60000, 100),
                mode + ' 98: the final world is the host\'s: ' + JSON.stringify([g.evalSim(`players[${gTeam}].energy`), host.evalSim(`players[${gTeam}].energy`), g.eval('netCounters.resultRepairs')]));
            rows.push(mode + ' 98: another final world with the same winner: repaired');
        }
        if (part(101) && worker) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
            const all = [host, ...guests];
            await H.playFor(world, all, 1500, { seed: 1011 });
            // (The successor order: the smaller id first. That one diverges; its mismatch is seen, not repaired.)
            const ids = guests.map(g => g.eval('myPeerId'));
            const [bad, good] = ids[0] < ids[1] ? guests : [guests[1], guests[0]];
            host.eval('resyncHostHandleRequest = () => { }');
            const nid0 = good.evalSim('nextUnitId');
            bad.evalSim('nextUnitId += 1000000');
            assert.ok(await world.runUntil(() => bad.eval('netCounters.desyncsDetected | 0') > 0, 20000, 100), mode + ' 101: the divergence was found');
            host.simWorker.terminate();
            host.eval("_simClientOnMessage({ type: 'restoreFailed', epoch: _simClient.epoch, message: 'state lost (test)' })");
            assert.ok(await world.runUntil(() => [bad, good].some(i => i.eval('isHost')), 60000, 100), mode + ' 101: a new host: ' + report(all));
            assert.ok(good.eval('isHost') && !bad.eval('isHost'), mode + ' 101: the healthy guest took the match: ' + report(all));
            await runsOn(world, all, 40, 90000, mode + ' 101');
            for (const i of all) assert.ok(Math.abs(i.evalSim('nextUnitId') - nid0) < 1000000, mode + ' 101: the healthy state stands on ' + i.name);
            await healthy(world, all, 1012, mode + ' 101', INJECTED);
            rows.push(mode + ' 101: a diverged guest refused the handover; the healthy one took it');
        }
        if (part(102)) {
            const world = newWorld(mode);
            const spawn = world.spawn.bind(world);
            let first = true;
            // (The host's countdown reaches the guest 8.5 s late: after its ALL_READY.)
            world.spawn = (name, o) => { const i = spawn(name, o); if (first) { first = false; i.eval(`setInterval(() => { for (const c of connections) { if (!c || c.__w) continue; c.__w = true; const f = c.send.bind(c); c.send = d => { if (d && d.type === 'START_GAME_COUNTDOWN') { setTimeout(() => f(d), 8500); return; } f(d); }; } }, 20)`); } return i; };
            const { host, guests } = await H.startHostedMatch(world, { guests: 1, maxMs: 30000 });
            const g = guests[0], all = [host, g];
            await world.run(15000);
            await runsOn(world, all, 40, 15000, mode + ' 102');
            assert.ok(!g.eval('_matchLoadInputBlocked') && !g.eval('_matchStartCountdownHandle'), mode + ' 102: the guest\'s match is not covered: ' + report(all));
            await healthy(world, all, 1022, mode + ' 102');
            rows.push(mode + ' 102: a late countdown: ignored');
        }
        if (part(103)) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 1031 });
            // (The guest's next decode (its join's) takes 8 s.)
            g.eval(`globalThis.__decodeHeld = 0; (() => { const f = netDecodeSnapshotPayload; let n = 1; netDecodeSnapshotPayload = function () { const r = f.apply(this, arguments); if (n-- > 0) { globalThis.__decodeHeld = 1; return new Promise(res => setTimeout(() => res(r), 8000)); } return r; }; })()`);
            g.eval(`connections[0].send({ type: 'REQUEST_MATCH_SYNC', tick: currentTick, reason: 'test' })`);
            assert.ok(await world.runUntil(() => g.eval('globalThis.__decodeHeld'), 15000, 20), mode + ' 103: the join decodes');
            const s0 = g.snapshotsApplied;
            host.eval("_startHostResyncPause('test')");
            assert.ok(await world.runUntil(() => g.snapshotsApplied > s0, 15000, 20), mode + ' 103: the recovery applied first');
            const R = g.lastSnapshotTick;
            await world.run(10000);
            const after = g.snapshotTicks.slice(s0);
            assert.ok(after.every(t => t >= R), mode + ' 103: nothing older than the recovery restored: ' + JSON.stringify([R, after]));
            await runsOn(world, all, 40, 20000, mode + ' 103');
            assert.ok(!g.eval('_matchLoadInputBlocked'), mode + ' 103: not covered by the dropped join');
            await world.run(45000);
            assert.equal(g.snapshotsApplied, s0 + 1, mode + ' 103: no further join: ' + JSON.stringify(g.snapshotTicks.slice(s0)));
            await healthy(world, all, 1032, mode + ' 103');
            rows.push(mode + ' 103: a join older than a recovery: dropped');
        }
        if (part(104)) {
            const world = newWorld(mode, KING);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 1041 });
            const gTeam = g.eval('localPlayerId'), hostTeam = host.eval('localPlayerId');
            // (The same end on both; the guest's last step takes 3 energy from two units far apart in the list, so a
            // rotating slice holds at most one of them.)
            const uids = host.evalSim(`JSON.stringify((() => { const a = units.filter(u => !u.dead && !u.isKing && u.owner === ${hostTeam}); return [a[0].id, a[a.length - 1].id]; })())`);
            world.atNextSafeTick(`(() => { const ids = ${uids}; for (const u of units) if (u.isKing && u.owner === ${gTeam}) { u.energy = 0; u.dead = true; } if (!isHost) for (const u of units) if (ids.includes(u.id)) u.energy -= 3; })()`);
            assert.ok(await world.runUntil(() => all.every(i => i.eval('gameOver')), 15000, 100), mode + ' 104: ended');
            const en = i => i.evalSim(`JSON.stringify(${uids}.map(id => { const u = units.find(u => u.id === id); return u ? u.energy : null; }))`);
            assert.ok(await world.runUntil(() => g.eval('netMatchEndFinal()') && en(g) === en(host), 60000, 100),
                mode + ' 104: the final world is the host\'s: ' + JSON.stringify([en(g), en(host), g.eval('netCounters.resultRepairs')]));
            rows.push(mode + ' 104: a unit difference at the end: repaired');
        }
        if (part(105)) {
            const world = newWorld(mode, KING);
            const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
            const all = [host, ...guests];
            await H.playFor(world, all, 1500, { seed: 1051 });
            const ids = guests.map(g => g.eval('myPeerId'));
            // (The later successor resigns and spectates on; the first takes the match.)
            const [succ, spec] = ids[0] < ids[1] ? guests : [guests[1], guests[0]];
            const specId = JSON.stringify(spec.eval('myPeerId')), specTeam = spec.eval('localPlayerId');
            const issued0 = new Set(world.issued.keys());
            spec.eval(RESIGN);
            // (The resign command itself is not counted: its role change resigns the team first, and the command then
            // has nothing to do, so it never counts as run.)
            for (const id of [...world.issued.keys()]) if (!issued0.has(id) && world.issued.get(id).by === spec.name) world.issued.delete(id);
            assert.ok(await world.runUntil(() => host.eval(`resignedTeams.has(${specTeam})`) && host.eval(`matchRoleByPeerId[${specId}]`) === 'spectating' &&succ.eval(`remoteRoleByPeerId[${specId}]`) === 'spectating', 15000, 50), mode + ' 105: resigned, spectating');
            const oldId = host.eval('myPeerId');
            world.kill(host);
            assert.ok(await world.runUntil(() => succ.eval('isHost'), 90000, 100), mode + ' 105: a new host: ' + report([succ, spec]));
            succ.eval('hostRemovePlayerFromMatch(' + JSON.stringify(oldId) + ')');
            const sTeam = succ.eval('localPlayerId');
            world.atNextSafeTick(`(() => { for (const u of units) if (u.isKing && u.owner !== ${sTeam}) { u.energy = 0; u.dead = true; } })()`);
            assert.ok(await world.runUntil(() => [succ, spec].every(i => i.eval('gameOver')), 30000, 100), mode + ' 105: ended');
            succ.eval('hostRematch()');
            assert.ok(await world.runUntil(() => [succ, spec].every(i => i.eval('gameStarted && !gameOver && !matchStartWaitingForReady')) && succ.eval('currentTick') > 30, 40000, 100), mode + ' 105: the rematch runs on both: ' + report([succ, spec]));
            assert.equal(succ.eval(`matchRoleByPeerId[${specId}]`), 'playing', mode + ' 105: the resigned starting player plays the rematch');
            assert.ok(spec.eval('spectateMode === "none" && !localDefeated'), mode + ' 105: not spectating: ' + spec.eval('spectateMode'));
            await healthy(world, [succ, spec], 1052, mode + ' 105');
            rows.push(mode + ' 105: a resigned starting player: in the successor\'s rematch');
        }
        if (part(106)) {
            const world = newWorld(mode);
            const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0];
            await H.playFor(world, [host, g], 1500, { seed: 1061 });
            const spec = world.spawn('spectator', { url: url(hostId) });
            spec.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(hostId)})`);
            assert.ok(await world.runUntil(() => spec.eval('remoteMatchRunning'), 10000, 50), mode + ' 106: sees the match');
            // (Its first restore throws, once its join's loading beat runs.)
            spec.eval(`(() => { const f = startGame; let n = 1; startGame = function () { if (_guestJoinLoadingTimer && n-- > 0) throw new Error('injected restore failure'); return f.apply(this, arguments); }; })()`);
            spec.eval('requestSpectateCurrentMatch()');
            assert.ok(await world.runUntil(() => spec.eval('gameStarted && !lockstepResyncPauseActive && !_guestJoinLoadingTimer') && spec.eval('currentTick') > host.eval('currentTick') - 40, 40000, 100), mode + ' 106: spectating: ' + report([host, spec]));
            spec.errors = spec.errors.filter(e => !INJECTED.test(String(e && e.stack || e)));
            const from = Math.max(host.eval('currentTick'), spec.eval('currentTick')) + 5;
            await healthy(world, [host, g], 1062, mode + ' 106');
            H.checkHealthy(world, [host, spec], { minCompared: 8, fromTick: from, label: mode + ' 106 spectator' });
            rows.push(mode + ' 106: a spectator\'s failed restore: asked again, spectating');
        }
        if (part(107)) {
            const world = newWorld(mode);
            const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 1 });
            await H.playFor(world, [host, ...guests], 1500, { seed: 1071 });
            // (The host's next join snapshot fails once: the worker's text, or the page's build.)
            if (worker) host.eval(`(() => { const f = simClientSnapshotText; let n = 1; simClientSnapshotText = function () { if (n-- > 0) return Promise.reject(new Error('injected snapshot failure')); return f.apply(this, arguments); }; })()`);
            else host.eval(`(() => { const f = buildHostAuthoritativeStateSnapshot; let n = 1; buildHostAuthoritativeStateSnapshot = function (o) { if (o && o.includeConfig && o.includeStaticMapState && n-- > 0) throw new Error('injected snapshot failure'); return f.apply(this, arguments); }; })()`);
            const g0 = guests[0], storage = g0.storage;
            world.kill(g0);
            const g = world.spawn('reloaded', { storage, url: url(hostId) });
            g.eval('loadOrCreateLocalIdentity()');
            g.eval(`joinGame(${JSON.stringify(hostId)})`);
            await runsOn(world, [host, g], 40, 40000, mode + ' 107');
            host.errors = host.errors.filter(e => !INJECTED.test(String(e && e.stack || e)));
            await healthy(world, [host, g], 1072, mode + ' 107', INJECTED);
            rows.push(mode + ' 107: a failed join snapshot: made again');
        }
        if (part(108)) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 1081 });
            const gid = JSON.stringify(g.eval('myPeerId'));
            // (An older patch request of this guest reaches the host the tick before its join goes.)
            host.eval(`(() => { const f = resyncHostScheduleJoin; resyncHostScheduleJoin = function (conn) { const r = f.apply(this, arguments); if (conn && conn.peer === ${gid} && !globalThis.__lateAsk) { globalThis.__lateAsk = setInterval(() => { const p = resyncHostPending.get(${gid}); if (!p || !p.join) return; if (currentTick < p.T - 1) return; clearInterval(globalThis.__lateAsk); resyncHostHandleRequest(conn, { type: 'RESYNC_REQUEST', tick: currentTick - 3, from: currentTick - 3, at: currentTick - 3, rotation: [], full: true, id: 0 }); globalThis.__lateAskDone = 1; }, 5); } return r; }; })()`);
            if (worker) { g.simWorker.terminate(); g.eval("_simClientOnMessage({ type: 'restoreFailed', epoch: _simClient.epoch, message: 'state lost (test)' })"); }
            else g.eval("requestHardLockstepResync(currentTick, 'test')");
            assert.ok(await world.runUntil(() => host.eval('!!globalThis.__lateAskDone'), 20000, 20), mode + ' 108: the late patch request came');
            await runsOn(world, all, 40, 40000, mode + ' 108');
            await healthy(world, all, 1082, mode + ' 108', INJECTED);
            rows.push(mode + ' 108: a late patch request: the join went on');
        }
        if (part(109) && worker) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
            const all = [host, ...guests];
            await H.playFor(world, all, 1500, { seed: 1091 });
            const ids = guests.map(g => g.eval('myPeerId'));
            const [succ, other] = ids[0] < ids[1] ? guests : [guests[1], guests[0]];
            // (A match-wide recovery: the state every guest restores is its checkpoint.)
            const s0 = succ.snapshotsApplied;
            host.eval("_startHostResyncPause('test')");
            assert.ok(await world.runUntil(() => succ.snapshotsApplied > s0 && live(succ), 20000, 50), mode + ' 109: recovered');
            const R = succ.lastSnapshotTick;
            assert.ok(succ.eval('_netCkpt && _netCkpt.tick') >= R, mode + ' 109: the recovery is the checkpoint: ' + JSON.stringify([R, succ.eval('_netCkpt && _netCkpt.tick')]));
            await H.playFor(world, all, 1500, { seed: 1092 });
            const oldId = host.eval('myPeerId');
            world.kill(host);
            assert.ok(await world.runUntil(() => succ.eval('isHost'), 90000, 100), mode + ' 109: a new host: ' + report([succ, other]));
            succ.eval('hostRemovePlayerFromMatch(' + JSON.stringify(oldId) + ')');
            await runsOn(world, [succ, other], 20, 60000, mode + ' 109 after the migration');
            // (Then every simulation is lost: the new host runs the match again from its checkpoint.)
            const t0 = Math.max(...ticks([succ, other]));
            for (const i of [succ, other]) { i.simWorker.terminate(); i.eval("_simClientOnMessage({ type: 'restoreFailed', epoch: _simClient.epoch, message: 'state lost (test)' })"); }
            await runsOn(world, [succ, other], 40, 120000, mode + ' 109');
            assert.ok(succ.eval('netCounters.checkpointRestores | 0') >= 1 && Math.min(...ticks([succ, other])) > t0, mode + ' 109: from the checkpoint');
            await healthy(world, [succ, other], 1093, mode + ' 109', INJECTED);
            rows.push(mode + ' 109: a recovery\'s snapshot kept as the checkpoint; restored from it after a migration');
        }
        if (part(110)) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 1101 });
            // (The guest's next decode (the recovery's) takes 3 s; it queues an order meanwhile, for a tick before the
            // snapshot's: a lagging guest's own tick. Here placed there, as the harness's guest does not lag.)
            g.eval(`(() => { const f = netDecodeSnapshotPayload; let n = 1; netDecodeSnapshotPayload = function () { const r = f.apply(this, arguments); if (n-- > 0) { globalThis.__decodeHeld = 1; return new Promise(res => setTimeout(() => res(r), 3000)); } return r; }; })()`);
            host.eval("_startHostResyncPause('test')");
            assert.ok(await world.runUntil(() => g.eval('!!globalThis.__decodeHeld'), 15000, 20), mode + ' 110: decoding');
            const R = host.eval('lockstepResyncSnapshotCache ? lockstepResyncSnapshotCache.tick : currentTick');
            const n0 = world.issued.size;
            g.eval(`(() => { const u = units.find(u => u.owner === localPlayerId && !u.dead); const t = queueAction({ action: 'stop', unitIds: [u.id] }); const a = localInputBuffer[t].pop(); if (!localInputBuffer[t].length) delete localInputBuffer[t]; const old = ${R} - 6; (localInputBuffer[old] || (localInputBuffer[old] = [])).push(a); })()`);
            assert.equal(world.issued.size, n0 + 1, mode + ' 110: the order was issued');
            assert.ok(await world.runUntil(() => g.snapshotsApplied > 1 && live(g), 20000, 50), mode + ' 110: recovered');
            await runsOn(world, all, 40, 20000, mode + ' 110');
            await healthy(world, all, 1102, mode + ' 110');
            rows.push(mode + ' 110: an order queued before the snapshot\'s tick: run after the restore');
        }
        if (part(111)) {
            const world = newWorld(mode);
            const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 1111 });
            const spec = world.spawn('visitor', { url: url(hostId) });
            spec.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(hostId)})`);
            assert.ok(await world.runUntil(() => spec.eval('remoteMatchRunning'), 10000, 50), mode + ' 111: in the lobby');
            // (A pause while it is in the lobby: it answers RESYNC_NO_MATCH; a copy of that answer comes again later.)
            host.eval("_startHostResyncPause('test')");
            const sid1 = host.eval('lockstepResyncSessionId');
            assert.ok(await world.runUntil(() => all.every(live), 20000, 50), mode + ' 111: the first pause ended');
            spec.eval('requestSpectateCurrentMatch()');
            assert.ok(await world.runUntil(() => spec.eval('gameStarted && !lockstepResyncPauseActive && !_guestJoinLoadingTimer') && spec.eval('currentTick') > host.eval('currentTick') - 20, 30000, 100), mode + ' 111: spectating');
            spec.eval(`connections[0].send({ type: 'RESYNC_NO_MATCH', sessionId: ${JSON.stringify(sid1)} })`);
            await world.run(1000);
            const sp0 = spec.snapshotsApplied;
            host.eval("_startHostResyncPause('test 2')");
            const sid2 = host.eval('lockstepResyncSessionId');
            assert.ok(await world.runUntil(() => all.every(live) && spec.eval('lockstepAppliedResyncSessionId') === sid2, 20000, 50), mode + ' 111: the spectator took part in the next pause: ' + JSON.stringify([spec.eval('lockstepAppliedResyncSessionId'), sid2, spec.eval('currentTick'), host.eval('currentTick')]));
            assert.equal(spec.snapshotsApplied, sp0 + 1, mode + ' 111: no extra reload');
            const from = Math.max(host.eval('currentTick'), spec.eval('currentTick')) + 5;
            await healthy(world, all, 1112, mode + ' 111');
            H.checkHealthy(world, [host, spec], { minCompared: 8, fromTick: from, label: mode + ' 111 spectator' });
            rows.push(mode + ' 111: a late no-match answer: the spectator stays in the recoveries');
        }
        if (part(112)) {
            const world = newWorld(mode, KING);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 1121 });
            const hostTeam = host.eval('localPlayerId'), gTeam = g.eval('localPlayerId');
            // (The guest's request for the match reaches the host 12 s late, once.)
            g.eval(`(() => { const c = connections[0], f = c.send.bind(c); let n = 1; c.send = d => { if (d && d.type === 'REQUEST_MATCH_SYNC' && n-- > 0) { setTimeout(() => f(d), 12000); return; } f(d); }; })()`);
            // (Opposite ends: another winner on the guest.)
            world.atNextSafeTick(`(() => { const lose = isHost ? ${gTeam} : ${hostTeam}; for (const u of units) if (u.isKing && u.owner === lose) { u.energy = 0; u.dead = true; } })()`);
            assert.ok(await world.runUntil(() => all.every(i => i.eval('gameOver')), 15000, 100), mode + ' 112: ended');
            assert.ok(await world.runUntil(() => (g.eval('netCounters.resultRepairs') | 0) > 0, 15000, 50), mode + ' 112: the guest asked');
            host.eval('hostRematch()');
            assert.ok(await world.runUntil(() => all.every(i => i.eval('gameStarted && !gameOver && !matchStartWaitingForReady')) && host.eval('currentTick') > 20, 30000, 100), mode + ' 112: the rematch runs');
            const s0 = g.snapshotsApplied;
            await world.run(20000);
            assert.equal(g.snapshotsApplied, s0, mode + ' 112: the late request reloaded nothing');
            await healthy(world, all, 1122, mode + ' 112');
            rows.push(mode + ' 112: a late request of the last match: dropped');
        }
        if (part(113) && worker) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
            const all = [host, ...guests];
            await H.playFor(world, all, 1500, { seed: 1131 });
            // (The preferred successor (the smaller id) loses its simulation just before the host is lost.)
            const ids = guests.map(g => g.eval('myPeerId'));
            const [pref, healthyG] = ids[0] < ids[1] ? guests : [guests[1], guests[0]];
            pref.simWorker.terminate();
            pref.eval("_simClientOnMessage({ type: 'restoreFailed', epoch: _simClient.epoch, message: 'state lost (test)' })");
            const oldId = host.eval('myPeerId');
            world.kill(host);
            assert.ok(await world.runUntil(() => [pref, healthyG].some(i => i.eval('isHost')), 90000, 100), mode + ' 113: a new host: ' + report([pref, healthyG]));
            assert.ok(healthyG.eval('isHost') && !pref.eval('isHost'), mode + ' 113: the guest with a simulation took over: ' + report([pref, healthyG]));
            healthyG.eval('hostRemovePlayerFromMatch(' + JSON.stringify(oldId) + ')');
            await runsOn(world, [pref, healthyG], 40, 90000, mode + ' 113');
            await healthy(world, [pref, healthyG], 1132, mode + ' 113', INJECTED);
            rows.push(mode + ' 113: a successor without its simulation deferred; the healthy guest took the match');
        }
        if (part(114) && worker) {
            // (The page and worker share their control block, as in a browser with cross-origin isolation.)
            const shared0 = process.env.SIM_SHARED;
            process.env.SIM_SHARED = '1';
            try {
                const world = newWorld(mode);
                const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
                const g = guests[0], all = [host, g];
                await H.playFor(world, all, 1500, { seed: 1141 });
                assert.ok(host.eval('!!(_simClient && _simClient.ctl)'), mode + ' 114: shared control block');
                // (Both workers stop publishing results on the same tick: no peer completes it.)
                // (Each worker still runs its ticks; their results go nowhere.)
                const T = Math.max(...ticks(all)) + 5;
                for (const i of all) i.simWorker.eval(`(() => { const f = _simPostResult, b = _simPostBareResult; _simPostResult = function (tick) { if (tick >= ${T}) return; return f.apply(this, arguments); }; _simPostBareResult = function (tick) { if (tick >= ${T}) return; return b.apply(this, arguments); }; })()`);
                const t0 = Math.max(...ticks(all));
                // (The harness hands the worker's progress block to the page with its messages (modelling worker time);
                // a browser's shared memory shows it at once: mirrored here every step, with no message coming.)
                const mirror = () => { for (const i of all) { const w = i.simWorker; if (w && w._ctl && w._pageCtl) { w._pageCtl[1] = w._ctl[1]; w._pageCtl[0] = w._ctl[0]; } } };
                assert.ok(await world.runUntil(() => { mirror(); return all.every(i => live(i) && i.eval('currentTick') > t0 + 40); }, 150000, 100), mode + ' 114: every peer runs on: ' + report(all));
                assert.ok(Math.min(...ticks(all)) > t0 + 40, mode + ' 114: past the stall');
                await healthy(world, all, 1142, mode + ' 114', INJECTED);
                rows.push(mode + ' 114: both workers silent with their ticks run: lost by their own progress, the match goes on');
            } finally { if (shared0 === undefined) delete process.env.SIM_SHARED; else process.env.SIM_SHARED = shared0; }
        }
        if (part(115)) {
            const world = newWorld(mode);
            const spawn = world.spawn.bind(world);
            let n = 0;
            // (The guest's renderer preparation for the start fails once.)
            world.spawn = (name, o) => { const i = spawn(name, o); if (n++ === 1) i.eval(`(() => { const f = prepareRendererLodAssets; let k = 1; prepareRendererLodAssets = function (full) { if (full === true && k-- > 0) { globalThis.__setupFailed = 1; return Promise.reject(new Error('injected setup failure')); } return f.apply(this, arguments); }; })()`); return i; };
            const { host, guests } = await H.startHostedMatch(world, { guests: 1, maxMs: 30000 });
            const g = guests[0], all = [host, g];
            assert.ok(g.eval('globalThis.__setupFailed === 1'), mode + ' 115: the failure happened');
            g.errors = g.errors.filter(e => !INJECTED.test(String(e && e.stack || e)) && !/injected setup failure/.test(String(e && e.stack || e)));
            await runsOn(world, all, 40, 30000, mode + ' 115');
            await healthy(world, all, 1152, mode + ' 115', /injected setup failure/);
            rows.push(mode + ' 115: a guest setup failure at the start: applied again');
        }
        if (part(116) && !worker) {
            const world = newWorld(mode);
            const spawn = world.spawn.bind(world);
            let first = true;
            // (The host's first start fails at its start text (cancelled), and its prepare reaches the guest only after the
            // retry's prepare; the cancel comes before it.)
            world.spawn = (name, o) => {
                const i = spawn(name, o);
                if (first) {
                    first = false;
                    i.eval(`(() => { const f = buildHostAuthoritativeStateSnapshot; let n = 1; buildHostAuthoritativeStateSnapshot = function (o) { if (o && o.includeGridTypes && !o.includeConfig && n-- > 0) throw new Error('injected snapshot failure'); return f.apply(this, arguments); }; })()`);
                    i.eval(`(() => { let held = null, n = 1; setInterval(() => { for (const c of connections) { if (!c || c.__w) continue; c.__w = true; const f = c.send.bind(c); c.send = d => { if (d && d.type === 'START_GAME_PREPARE') { if (n-- > 0) { held = d; return; } f(d); if (held) { const h = held; held = null; f(h); } return; } f(d); }; } }, 20); })()`);
                }
                return i;
            };
            const err = await H.startHostedMatch(world, { guests: 1, maxMs: 8000 }).then(() => null, e => e);
            assert.ok(err, mode + ' 116: the first start failed');
            const [host, g] = world.instances;
            assert.ok(await world.runUntil(() => !host.eval('gameStarted'), 10000, 50), mode + ' 116: the host is back in the lobby');
            host.errors = host.errors.filter(e => !INJECTED.test(String(e && e.stack || e)));
            host.eval('startHostedGame()');
            assert.ok(await world.runUntil(() => [host, g].every(i => i.eval('gameStarted && !matchStartWaitingForReady')) && host.eval('currentTick') > 10 && g.eval('matchStartSessionId') === host.eval('matchStartSessionId'), 30000, 100), mode + ' 116: the retry runs on both: ' + report([host, g]));
            await healthy(world, [host, g], 1162, mode + ' 116', INJECTED);
            rows.push(mode + ' 116: a late prepare of a cancelled start: dropped, the retry runs');
        }
        if (part(117) && worker) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 1171 });
            await world.run(2000);
            // (From now the host's bundles do not reach the guest; the host queues an order, seals it, and loses its worker
            // before the worker runs it.)
            host.eval(`(() => { for (const c of connections) { const f = c.send.bind(c); c.send = d => { if (d && d.type === 'TICK_BUNDLE' && isHost) return; f(d); }; } })()`);
            const n0 = world.issued.size;
            host.eval(`(() => { const u = units.find(u => u.owner === localPlayerId && !u.dead); queueAction({ action: 'stop', unitIds: [u.id] }); })()`);
            const id = [...world.issued.keys()][n0];
            assert.ok(id, mode + ' 117: the order was issued');
            const sealedAt = `(() => { for (const k in lockstepBundleByTick) { const b = lockstepBundleByTick[k]; if (b.packets.some(p => p.actions.some(a => a.netId === ${JSON.stringify(id)}))) return +k; } return -1; })()`;
            assert.ok(await world.runUntil(() => host.eval(sealedAt) >= 0, 5000, 1), mode + ' 117: sealed');
            const T = host.eval(sealedAt), ran = host.eval('_simClient.appliedTick');
            host.simWorker.terminate();
            host.eval("_simClientOnMessage({ type: 'restoreFailed', epoch: _simClient.epoch, message: 'state lost (test)' })");
            await runsOn(world, all, 60, 90000, mode + ' 117');
            await world.run(3000);
            assert.ok(host.executedActions.has(id) && g.executedActions.has(id), mode + ' 117: the order ran on both (sealed for ' + T + ', the worker at ' + ran + '): ' + JSON.stringify([host.executedActions.has(id), g.executedActions.has(id)]));
            await healthy(world, all, 1172, mode + ' 117', INJECTED);
            rows.push(mode + ' 117: a sealed, unrun host order across the handover: ran (sealed ' + T + ', worker at ' + ran + ')');
        }
        if (part(118)) {
            const world = newWorld(mode);
            const spawn = world.spawn.bind(world);
            let first = true;
            // (The host's renderer preparation for the start takes 3 s.)
            world.spawn = (name, o) => { const i = spawn(name, o); if (first) { first = false; i.eval(`(() => { const f = prepareRendererLodAssets; prepareRendererLodAssets = function (full) { const r = f.apply(this, arguments); return full === true && isHost ? new Promise(res => setTimeout(() => res(r), 3000)) : r; }; })()`); } return i; };
            const p = H.startHostedMatch(world, { guests: 1, maxMs: 10000 }).catch(e => e);
            assert.ok(await world.runUntil(() => world.instances.length === 2 && world.instances[0].eval('_hostMatchStarting'), 20000, 20), mode + ' 118: starting');
            const host = world.instances[0];
            for (const pr of host.peers) if (!pr.destroyed) pr.destroy();
            await p;
            await world.run(20000);
            assert.ok(!host.eval('gameStarted'), mode + ' 118: no match started alone: ' + JSON.stringify([host.eval('gameStarted'), host.eval('gameOver'), host.eval('winner'), host.eval('connections.length')]));
            rows.push(mode + ' 118: the host\'s peer closed while preparing: no lone start');
        }
        if (part(119)) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
            const all = [host, ...guests];
            await H.playFor(world, all, 1500, { seed: 1191 });
            // (The host is cut off from both guests: they move the match to one of them; the old host hosts alone.)
            for (const g of guests) world.setLink(host, g, 'blackhole');
            assert.ok(await world.runUntil(() => guests.some(g => g.eval('isHost')), 150000, 200), mode + ' 119: the guests moved the match');
            const groupHost = guests.find(g => g.eval('isHost'));
            assert.ok(host.eval('isHost'), mode + ' 119: the old host still hosts, alone');
            // (Long enough that the group's host looks for the missing old host too: HOST_SEEK_AFTER_MISSING_MS.)
            await world.run(21000);
            for (const g of guests) world.setLink(host, g, 'up');
            // (Both hosts look for the other at once: their probes cross.)
            for (const i of [host, groupHost]) i.eval('_hostLastSeekAt = 0; _hostSeekActive = false; hostMaybeSeekOtherHost()');
            const hosts = () => all.filter(i => i.eval('isHost'));
            assert.ok(await world.runUntil(() => hosts().length === 1 && all.every(i => i.eval('gameStarted && !gameOver && !lockstepResyncPauseActive'))
                && all.every(i => i.eval('isHost ? myPeerId : wsHostId') === hosts()[0].eval('myPeerId')), 120000, 200), mode + ' 119: one host: ' + report(all));
            assert.equal(hosts()[0], groupHost, mode + ' 119: the host with a player keeps the match (the lone one joins it)');
            assert.equal(groupHost.eval('netCounters.hostMigrations | 0') <= 1, true, mode + ' 119: the group host never gave the match up');
            await runsOn(world, all, 40, 30000, mode + ' 119');
            await healthy(world, all, 1192, mode + ' 119');
            rows.push(mode + ' 119: a three-player split healed: the host with players stays');
        }
        if (part(120)) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1, waitForInitialization: false });
            const g = guests[0], all = [host, g];
            // (Each player orders a Hold under the start's loading overlay: its initialization blocks input.)
            assert.ok(await world.runUntil(() => all.every(i => i.eval('matchInitializationBlocksInput()')), 10000, 5), mode + ' 120: initializing: ' + report(all));
            const held = all.map(i => i.eval(`(() => { const u = units.find(u => u.owner === localPlayerId && !u.dead && !u.workerType); queueAction({ action: 'hold', unitIds: [u.id] }); return u.id; })()`));
            assert.ok(await world.runUntil(() => all.every(i => i.eval('_matchInit.released')), 30000, 50), mode + ' 120: released');
            await runsOn(world, all, 40, 20000, mode + ' 120');
            const holding = all.map(i => held.map(id => i.evalSim(`(u => !!(u && u.holdPosition))(units.find(u => u.id === ${id}))`)));
            assert.deepEqual(holding, [[true, true], [true, true]], mode + ' 120: both held orders ran on both peers');
            await healthy(world, all, 1202, mode + ' 120');
            rows.push(mode + ' 120: orders under the start\'s overlay: queued at the release, run on both');
        }
        if (part(121)) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
            const all = [host, ...guests];
            await H.playFor(world, all, 1000, { seed: 1211 });
            const ids = guests.map(g => g.eval('myPeerId'));
            const [pref, healthyG] = ids[0] < ids[1] ? guests : [guests[1], guests[0]];
            const prefId = JSON.stringify(pref.eval('myPeerId'));
            // (The preferred successor asks for the whole match; the host's join for it never arrives.)
            host.eval(`(() => { for (const c of connections) { if (c.peer !== ${prefId}) continue; const f = c.send.bind(c); c.send = d => { if (d && (d.type === 'START_GAME' || d.type === 'START_SPECTATE' || d.type === 'MATCH_STATE_SNAPSHOT')) return; f(d); }; } })()`);
            pref.eval(`requestHardLockstepResync(currentTick, 'test')`);
            const stuckAt = pref.eval('currentTick');
            await runsOn(world, [host, healthyG], 150, 60000, mode + ' 121 the others');
            assert.ok(pref.eval('currentTick') <= stuckAt + 2, mode + ' 121: the preferred successor waits: ' + report(all));
            // (The healthy guest orders a Hold; it runs on the host and on it.)
            const n0 = world.issued.size;
            const unit = healthyG.eval(`(() => { const u = units.find(u => u.owner === localPlayerId && !u.dead && !u.workerType); queueAction({ action: 'hold', unitIds: [u.id] }); return u.id; })()`);
            const id = [...world.issued.keys()][n0];
            assert.ok(await world.runUntil(() => host.executedActions.has(id) && healthyG.executedActions.has(id), 10000, 20), mode + ' 121: the hold ran');
            await world.run(500);
            const oldId = host.eval('myPeerId');
            world.kill(host);
            assert.ok(await world.runUntil(() => [pref, healthyG].some(i => i.eval('isHost')), 90000, 100), mode + ' 121: a new host: ' + report([pref, healthyG]));
            assert.ok(healthyG.eval('isHost') && !pref.eval('isHost'), mode + ' 121: the guest with the running match took over: ' + report([pref, healthyG]));
            healthyG.eval('hostRemovePlayerFromMatch(' + JSON.stringify(oldId) + ')');
            await runsOn(world, [pref, healthyG], 40, 90000, mode + ' 121');
            const holding = [pref, healthyG].map(i => i.evalSim(`(u => !!(u && u.holdPosition))(units.find(u => u.id === ${unit}))`));
            assert.deepEqual(holding, [true, true], mode + ' 121: the hold survived the migration on both');
            await healthy(world, [pref, healthyG], 1212, mode + ' 121', INJECTED);
            rows.push(mode + ' 121: a successor waiting for the whole match deferred; the running match went on');
        }
        if (part(122) && worker) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 1221 });
            // (The guest's link closes; then its worker is lost, before its recovery asks for the match.)
            for (const c of g.eval('connections.length') ? [0] : []) g.eval('connections[0].close()');
            await world.run(200);
            g.simWorker.terminate();
            g.eval("_simClientOnMessage({ type: 'restoreFailed', epoch: _simClient.epoch, message: 'state lost (test)' })");
            const t0 = g.eval('currentTick');
            await runsOn(world, all, 40, 60000, mode + ' 122');
            assert.ok(g.eval('currentTick') > t0 + 40, mode + ' 122: the guest got the match again');
            await healthy(world, all, 1222, mode + ' 122', INJECTED);
            rows.push(mode + ' 122: link closed, then the worker lost: the reconnected guest asks for the whole match');
        }
        if (part(123)) {
            const world = newWorld(mode);
            const spawn = world.spawn.bind(world);
            let n = 0;
            // (The guest's stat rebuild in the start's world setup fails once, after the world reset cleared the match id.)
            world.spawn = (name, o) => { const i = spawn(name, o); if (n++ === 1) i.eval(`(() => { const f = rebuildPrecomputedStatsMap; let k = 1; rebuildPrecomputedStatsMap = function () { if (_guestStartTakenSessionId && !matchStartSessionId && k-- > 0) { globalThis.__setupFailed = 1; throw new Error('injected setup failure'); } return f.apply(this, arguments); }; })()`); return i; };
            const { host, guests } = await H.startHostedMatch(world, { guests: 1, maxMs: 30000 });
            const g = guests[0], all = [host, g];
            assert.ok(g.eval('globalThis.__setupFailed === 1'), mode + ' 123: the failure happened');
            g.errors = g.errors.filter(e => !/injected setup failure/.test(String(e && e.stack || e)));
            await runsOn(world, all, 40, 30000, mode + ' 123');
            await healthy(world, all, 1232, mode + ' 123', /injected setup failure/);
            rows.push(mode + ' 123: a setup failure after the world reset: the start applied again');
        }
        if (part(124)) {
            const world = newWorld(mode, KING);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 1241 });
            await world.run(10000);
            // (The host's acknowledgements of the guest's join this match are held back.)
            host.eval(`(() => { globalThis.__acks = []; globalThis.__hold = 1; for (const c of connections) { const f = c.send.bind(c); c.__f = f; c.send = d => { if (d && d.type === 'JOIN_LIVE_ACK' && globalThis.__hold) { globalThis.__acks.push(d); return; } f(d); }; } })()`);
            g.eval(`requestHardLockstepResync(currentTick, 'test')`);
            assert.ok(await world.runUntil(() => host.eval('globalThis.__acks.length') > 0, 30000, 50), mode + ' 124: an acknowledgement held');
            const old = host.eval('JSON.stringify(globalThis.__acks[0])');
            // (The match ends; the rematch starts; the guest joins it again (its own request).)
            const hostTeam = host.eval('localPlayerId'), gTeam = g.eval('localPlayerId');
            world.atNextSafeTick(`(() => { for (const u of units) if (u.isKing && u.owner === ${gTeam}) { u.energy = 0; u.dead = true; } })()`);
            assert.ok(await world.runUntil(() => all.every(i => i.eval('gameOver')), 30000, 100), mode + ' 124: ended');
            host.eval('globalThis.__hold = 0');
            host.eval('hostRematch()');
            assert.ok(await world.runUntil(() => all.every(i => i.eval('gameStarted && !gameOver && !matchStartWaitingForReady && _matchInit.released')) && host.eval('currentTick') > 10, 30000, 100), mode + ' 124: the rematch runs');
            // (In the rematch the guest joins again; the old acknowledgement reaches it just before the current one.)
            host.eval(`(() => { const old = ${old}; for (const c of connections) { const f = c.__f || c.send.bind(c), g = c.send; let n = 1; c.send = d => { if (d && d.type === 'JOIN_LIVE_ACK' && n-- > 0) f(old); g(d); }; } })()`);
            g.eval(`requestHardLockstepResync(currentTick, 'test 2')`);
            assert.ok(await world.runUntil(() => g.eval('!resyncGuest.joining && !resyncGuest.awaitingLive && !lockstepResyncPauseActive') && live(g), 30000, 50), mode + ' 124: rejoined');
            // (A Hold now runs within the input delay, not at the old acknowledgement's tick.)
            const n0 = world.issued.size;
            g.eval(`(() => { const u = units.find(u => u.owner === localPlayerId && !u.dead && !u.workerType); queueAction({ action: 'hold', unitIds: [u.id] }); })()`);
            const id = [...world.issued.keys()][n0], at = g.eval('currentTick');
            assert.ok(await world.runUntil(() => host.executedActions.has(id) && g.executedActions.has(id), 20000, 20), mode + ' 124: the hold ran');
            const ran = g.executedActions.get(id).tick;
            assert.ok(JSON.parse(old).tick > at + 100, mode + ' 124: the old acknowledgement is far ahead: ' + old);
            assert.ok(ran - at < 20, mode + ' 124: the hold ran on time (issued at ' + at + ', ran at ' + ran + '; the old acknowledgement said ' + JSON.parse(old).tick + ')');
            await healthy(world, all, 1242, mode + ' 124');
            rows.push(mode + ' 124: a delayed join acknowledgement of the last match: dropped (hold issued ' + at + ', ran ' + ran + ')');
        }
        if (part(125)) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 1251 });
            // (The guest rejoins; the host's acknowledgement that it is live is held, so its Hold waits with it.)
            host.eval(`(() => { globalThis.__hold = 1; globalThis.__acks = []; for (const c of connections) { const f = c.send.bind(c); c.send = d => { if (d && d.type === 'JOIN_LIVE_ACK' && globalThis.__hold) { globalThis.__acks.push(d); return; } f(d); }; } })()`);
            g.eval(`requestHardLockstepResync(currentTick, 'test')`);
            assert.ok(await world.runUntil(() => g.eval('resyncGuest.awaitingLive'), 30000, 20), mode + ' 125: awaiting the acknowledgement');
            const n0 = world.issued.size;
            const unit = g.eval(`(() => { const u = units.find(u => u.owner === localPlayerId && !u.dead && !u.workerType); queueAction({ action: 'hold', unitIds: [u.id] }); return u.id; })()`);
            assert.ok(g.eval('resyncGuest.heldActions.length') > 0, mode + ' 125: the hold is held');
            // (A second full sync, whose first apply throws once.)
            g.eval(`(() => { const f = applyAuthoritativeStateSnapshot; let k = 1; applyAuthoritativeStateSnapshot = function () { if (k-- > 0) { globalThis.__applyFailed = 1; throw new Error('injected apply failure'); } return f.apply(this, arguments); }; })()`);
            host.eval(`globalThis.__hold = 0`);
            g.eval(`lockstepResyncRequestedAt = 0; requestHardLockstepResync(currentTick, 'test 2')`);
            assert.ok(await world.runUntil(() => g.eval('globalThis.__applyFailed === 1'), 20000, 20), mode + ' 125: the apply failed once');
            g.errors = g.errors.filter(e => !/injected apply failure/.test(String(e && e.stack || e)));
            await runsOn(world, all, 40, 60000, mode + ' 125');
            await world.run(2000);
            const holding = all.map(i => i.evalSim(`(u => !!(u && u.holdPosition))(units.find(u => u.id === ${unit}))`));
            assert.deepEqual(holding, [true, true], mode + ' 125: the held order ran on both after the failed apply');
            await healthy(world, all, 1252, mode + ' 125', /injected apply failure/);
            rows.push(mode + ' 125: a failed replacement snapshot: the held order still ran');
        }
        if (part(126)) {
            const world = newWorld(mode);
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 1500, { seed: 1261 });
            const gid = JSON.stringify(g.eval('myPeerId'));
            // (The guest asks for the match; its link closes after the host scheduled the join, before it is sent.)
            g.eval(`requestHardLockstepResync(currentTick, 'test')`);
            assert.ok(await world.runUntil(() => host.eval(`resyncHostPending.has(${gid})`), 10000, 5), mode + ' 126: scheduled');
            host.eval(`(() => { for (const c of connections) if (c.peer === ${gid}) c.close(); })()`);
            assert.ok(await world.runUntil(() => host.eval(`!resyncHostPending.has(${gid})`), 10000, 5), mode + ' 126: its tick passed');
            await runsOn(world, all, 40, 90000, mode + ' 126');
            await healthy(world, all, 1262, mode + ' 126', INJECTED);
            rows.push(mode + ' 126: a scheduled join unsent (the link closed): the reconnected guest gets one');
        }
        if (part(127)) {
            const world = newWorld(mode);
            const spawn = world.spawn.bind(world);
            let first = true;
            // (The host's first START_GAME to the guest is lost (its send failed).)
            world.spawn = (name, o) => {
                const i = spawn(name, o);
                if (first) { first = false; i.eval(`(() => { let n = 1; setInterval(() => { for (const c of connections) { if (!c || c.__w) continue; c.__w = true; const f = c.send.bind(c); c.send = d => { if (d && d.type === 'START_GAME' && !Number.isFinite(d.joinTick) && n-- > 0) { globalThis.__startLost = 1; throw new Error('injected send failure'); } f(d); }; } }, 20); })()`); }
                return i;
            };
            const { host, guests } = await H.startHostedMatch(world, { guests: 1, maxMs: 40000 });
            const g = guests[0], all = [host, g];
            assert.ok(host.eval('globalThis.__startLost === 1'), mode + ' 127: the start was lost once');
            assert.ok(g.eval('connections.length') > 0 && host.eval('matchStartExpectedReadyPeerIds.length + Object.keys(matchStartReadyByPeerId).length') >= 0, mode + ' 127: still linked');
            await runsOn(world, all, 40, 30000, mode + ' 127');
            await healthy(world, all, 1272, mode + ' 127');
            rows.push(mode + ' 127: a lost start snapshot: sent again (the guest is in the match)');
        }
        if (part(128)) {
            const world = newWorld(mode);
            const spawn = world.spawn.bind(world);
            let first = true;
            // (The host keeps a copy of its START_GAME to send it again later: a duplicate.)
            world.spawn = (name, o) => {
                const i = spawn(name, o);
                if (first) { first = false; i.eval(`(() => { setInterval(() => { for (const c of connections) { if (!c || c.__w) continue; c.__w = true; const f = c.send.bind(c); c.__f = f; c.send = d => { if (d && d.type === 'START_GAME' && !Number.isFinite(d.joinTick)) globalThis.__start = d; f(d); }; } }, 20); })()`); }
                return i;
            };
            const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
            const g = guests[0], all = [host, g];
            await H.playFor(world, all, 2000, { seed: 1281 });
            const t0 = g.eval('currentTick');
            host.eval(`(() => { for (const c of connections) (c.__f || c.send.bind(c))(globalThis.__start); })()`);
            let lowest = t0;
            await world.runUntil(() => { lowest = Math.min(lowest, g.eval('currentTick')); return false; }, 4000, 20);
            assert.ok(lowest >= t0 - 2, mode + ' 128: the running guest did not go back to the start (' + t0 + ' -> ' + lowest + ')');
            await runsOn(world, all, 40, 20000, mode + ' 128');
            await healthy(world, all, 1282, mode + ' 128');
            rows.push(mode + ' 128: a duplicate START_GAME: dropped (the guest stayed at ' + lowest + '+)');
        }
    }
    for (const r of rows) console.log('  ' + r);
    console.log('PASS multiplayer-stuck-recovery (' + rows.length + ' parts)');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
