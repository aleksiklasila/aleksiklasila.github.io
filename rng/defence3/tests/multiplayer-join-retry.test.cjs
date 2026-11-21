// A join that is slow to make, or that the joiner could not use, still ends in a joined player
// (MULTIPLAYER_ROBUSTNESS_PROGRESS.md 2026-11-18 / 2026-11-19).
// slow:   the host's snapshot for a guest that asked for the whole match takes 20 s to encode each time. The player asks for the match
//         again every 8 s meanwhile; each request made a new join that dropped the one being encoded, so none was
//         ever sent (2026-11-18 fix: resyncHostJoinInFlight). It joins once, from the first join.
// failed: the reloaded player's first join does not decode. It asks again naming that join (failedJoin) and gets a
//         new one at once; before, its request was taken for a repeat of the join in flight (its own loading notes
//         kept that join alive) until the host's 45 s silence check.
// ONLY=slow,failed; MODES=page,worker.
//   node tests/multiplayer-join-retry.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 50, jitterMs: 5 };
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const part = n => !ONLY.length || ONLY.includes(n);
const MODES = process.env.MODES ? process.env.MODES.split(',') : ['page', 'worker'];
const url = hostId => `http://localhost/rng/defence3/index.html?game=${hostId}&room=${hostId}`;
const live = g => g.eval('gameStarted && !resyncGuest.joining && !resyncGuest.awaitingLive && !lockstepResyncPauseActive');
const COUNT_JOINS = `(() => { __scratch.joins = 0; const f = _handleConnectionMessage;
    _handleConnectionMessage = function (conn, data) { if (data && data.type === 'START_GAME' && Number.isFinite(data.joinTick)) __scratch.joins++; return f.apply(this, arguments); }; })()`;

async function reloaded(world, mode, seed) {
    world.simWorker = mode === 'worker';
    const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
    const g = guests[0];
    await H.playFor(world, [host, g], 1500, { seed });
    const storage = g.storage;
    world.kill(g);
    const fresh = world.spawn('reloaded', { storage, url: url(hostId) });
    fresh.eval('loadOrCreateLocalIdentity()');
    fresh.eval(COUNT_JOINS);
    return { host, fresh, hostId };
}
async function healthy(world, all, seed, label) {
    const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
    await H.playFor(world, all, 3000, { seed });
    await world.run(1500);
    for (const i of all) i.errors = i.errors.filter(e => !/injected/.test(String(e && e.stack || e)));
    H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label });
}

(async () => {
    const rows = [];
    for (const mode of MODES) {
        if (part('slow')) {
            const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
            world.simWorker = mode === 'worker';
            const { host, guests } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
            const fresh = guests[0];
            await H.playFor(world, [host, fresh], 1500, { seed: 11 });
            fresh.eval(COUNT_JOINS);
            host.eval(`(() => { const f = netEncodeSnapshotText; netEncodeSnapshotText = function () { const r = f.apply(this, arguments); return new Promise(res => setTimeout(() => res(r), 20000)); }; })()`);
            const at = world.now;
            // (A guest that asks for the whole match, as after a failed recovery; it asks again while it waits.)
            fresh.eval(`requestHardLockstepResync(currentTick, 'test: full match')`);
            const joined = await world.runUntil(() => fresh.eval('__scratch.joins') >= 1 && live(fresh), 60000, 100);
            assert.ok(joined, mode + ' slow: the reloaded player joined: ' + JSON.stringify([fresh.eval('__scratch.joins'), fresh.eval('gameStarted'), host.eval('netCounters.repeatMatchSyncIgnored | 0')]));
            const took = world.now - at;
            await healthy(world, [host, fresh], 12, mode + ' slow');
            rows.push(`${mode}: join encoded 20 s a time: joined after ${(took / 1000).toFixed(1)} s, ${fresh.eval('__scratch.joins')} join(s) sent, ${host.eval('netCounters.repeatMatchSyncIgnored | 0')} repeat(s) ignored`);
        }
        if (part('failed')) {
            const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
            const { host, fresh, hostId } = await reloaded(world, mode, 21);
            // (Its first join's snapshot does not decode.)
            fresh.eval(`(() => { const f = applyAuthoritativeStateSnapshot; let n = 1; applyAuthoritativeStateSnapshot = function () { if (n-- > 0) return false; return f.apply(this, arguments); }; })()`);
            fresh.eval(`joinGame(${JSON.stringify(hostId)})`);
            assert.ok(await world.runUntil(() => fresh.eval('__scratch.joins') >= 1, 20000), mode + ' failed: the match was sent');
            const at = world.now;
            const joined = await world.runUntil(() => fresh.eval('__scratch.joins') >= 2 && live(fresh), 60000, 100);
            const took = world.now - at;
            assert.ok(joined, mode + ' failed: joined again: ' + JSON.stringify([fresh.eval('__scratch.joins'), fresh.eval('gameStarted'), host.eval('netCounters.repeatMatchSyncIgnored | 0')]));
            assert.ok(took < 15000, mode + ' failed: a new join at once, not after the silence check: ' + took + ' ms');
            await healthy(world, [host, fresh], 22, mode + ' failed');
            rows.push(`${mode}: first join did not decode: joined from a new one ${(took / 1000).toFixed(1)} s later`);
        }
    }
    for (const mode of MODES) {
        if (!part('warmup')) break;
        // warmup: the start's initialization never settles (a periodic cost spike: the work test is never met), and
        // a guest reloads during it. The initialization ends after MATCH_INIT_MAX_TICKS (before: every peer stayed
        // on "Initializing simulation" for good), the host does not wait for the reloaded guest's barrier status
        // (it joined: _matchInit.exempt), and the guest joins and plays.
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        world.simWorker = mode === 'worker';
        const spawn = world.spawn.bind(world);
        world.spawn = (name, opts) => { const i = spawn(name, opts); i.eval('matchInitializationWorkSettled = () => false'); return i; };
        const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1], waitForInitialization: false });
        const g = guests[0];
        assert.equal(host.eval('_matchInit.released'), false, mode + ' warmup: still initializing');
        const storage = g.storage;
        world.kill(g);
        const fresh = world.spawn('reloaded', { storage, url: url(hostId) });
        fresh.eval('loadOrCreateLocalIdentity()');
        fresh.eval(COUNT_JOINS);
        fresh.eval(`joinGame(${JSON.stringify(hostId)})`);
        const t0 = host.eval('currentTick');
        const ok = await world.runUntil(() => host.eval('_matchInit.released') && fresh.eval('__scratch.joins') >= 1 && live(fresh) && fresh.eval('currentTick') > t0 + 20, 60000, 100);
        assert.ok(ok, mode + ' warmup: released and joined: ' + JSON.stringify([host.eval('JSON.stringify(_matchInit)'), host.eval('currentTick'), fresh.eval('gameStarted'), fresh.eval('currentTick'), fresh.eval('__scratch.joins')]));
        const t1 = host.eval('currentTick');
        await world.run(3000);
        assert.ok(host.eval('currentTick') > t1 + 40, mode + ' warmup: the match runs on');
        await healthy(world, [host, fresh], 32, mode + ' warmup');
        rows.push(`${mode}: reload during an initialization that never settles: released at its tick cap, joined, in sync`);
    }
    console.log('PASS multiplayer-join-retry\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
