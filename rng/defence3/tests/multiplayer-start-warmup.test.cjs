// The start's initialization ticks (the warmup barrier, utils_networking.js _matchInitializationPoll) survive a join
// and a restore (audit rows 60 and 72, MULTIPLAYER_AUDIT_2026-10-15.md). The initialization is held unsettled
// (matchInitializationWorkSettled false) until the event happened, then allowed to settle.
// join (row 60): a guest reloads during the initialization. Its join marks its own barrier done, so it reports no
//   status; old code: the host's barrier waited for that status: startup froze for every peer. Now the joiner is
//   exempt (_matchInit.exempt, utils_resync.js resyncHostScheduleJoin).
// migration (rows 72 and 78): the host is lost during the initialization; the guest taking over restores the
//   match (a new worker epoch). Old code: the warmup loop (_matchLoadOverlayUntilRunning), which grants the
//   initialization ticks, ended on the epoch change: every peer stopped at that tick. Now it ends only with the
//   match or the worker gone. Row 78 (found here, 2026-11-20, page mode too): the new host's barrier waited for the
//   lost host's status, which never comes (it is still a player until back or dropped): the start stood even
//   after the old host came back or was dropped. The barrier now skips players with no link.
//   Both ends: migration-back (the old host reloads and rejoins), migration-drop (the new host drops it).
//   node tests/multiplayer-start-warmup.test.cjs   (ONLY=join|migration; MODES=page,worker)
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 40, jitterMs: 5 };
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const want = k => !ONLY.length || ONLY.includes(k);
const MODES = process.env.MODES ? process.env.MODES.split(',') : (process.env.SIM_WORKER === '1' ? ['worker'] : ['page', 'worker']);
const url = hostId => `http://localhost/rng/defence3/index.html?game=${hostId}&room=${hostId}`;
const HOLD = `(() => { const f = matchInitializationWorkSettled; matchInitializationWorkSettled = s => __scratch.settle ? f(s) : false; })()`;
const live = i => i.eval('gameStarted && !lockstepResyncPauseActive && !resyncGuest.joining && !resyncGuest.awaitingLive');

async function held(mode, guests) {
    const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
    world.simWorker = mode === 'worker';
    const spawn = world.spawn.bind(world);
    world.spawn = (name, o) => { const i = spawn(name, o); i.eval(HOLD); return i; };
    const m = await H.startHostedMatch(world, { guests, teams: [...Array(guests + 1).keys()], waitForInitialization: false });
    assert.equal(m.host.eval('_matchInit.released'), false, mode + ': still initializing');
    return { world, ...m };
}
const settle = all => { for (const i of all) if (!i.dead) i.eval('__scratch.settle = true'); };
async function runsOn(world, all, label) {
    const t = all.map(i => i.eval('currentTick'));
    const ok = await world.runUntil(() => all.every((i, k) => i.eval('_matchInit.released') && live(i) && i.eval('currentTick') > t[k] + 30), 60000, 100);
    assert.ok(ok, label + ': initialization released, every peer ticks on: ' + JSON.stringify(all.map((i, k) => [i.name, i.eval('isHost'), t[k], i.eval('currentTick'), i.eval('JSON.stringify({ r: _matchInit.released, t: _matchInit.tick, a: _matchInit.allowed, s: _matchInit.started })')])));
    const from = Math.max(...all.map(i => i.eval('currentTick'))) + 3;
    await H.playFor(world, all, 3000, { seed: 111 });
    await world.run(1500);
    H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label });
}

(async () => {
    const rows = [];
    for (const mode of MODES) {
        if (want('join')) {
            const { world, host, guests, hostId } = await held(mode, 2);
            const g = guests[0], storage = g.storage;
            world.kill(g);
            const fresh = world.spawn('reloaded', { storage, url: url(hostId) });
            fresh.eval('loadOrCreateLocalIdentity()');
            fresh.eval(`joinGame(${JSON.stringify(hostId)})`);
            assert.ok(await world.runUntil(() => live(fresh) && fresh.snapshotsApplied > 0, 30000, 100), mode + ' join: the reloaded guest has the match');
            assert.equal(host.eval('_matchInit.released'), false, mode + ' join: joined during the initialization');
            settle([host, guests[1], fresh]);
            await runsOn(world, [host, guests[1], fresh], mode + ' join');
            rows.push(mode + ': reload during the initialization: released, in sync');
        }
        // (The match waits for the lost host's player, as after any migration, until it is back (reloaded) or the
        // new host drops it: both here.)
        for (const end of ['back', 'drop']) {
            if (!want('migration') && !want('migration-' + end)) continue;
            const { world, host, guests } = await held(mode, 2);
            const oldHostId = host.eval('myPeerId');
            world.kill(host);
            const ok = await world.runUntil(() => guests.some(i => i.eval('isHost')) && guests.every(i => live(i)), 60000, 100);
            assert.ok(ok, mode + ' migration: a guest took over: ' + JSON.stringify(guests.map(i => [i.name, i.eval('isHost'), i.eval('currentTick')])));
            const nh = guests.find(i => i.eval('isHost'));
            assert.equal(nh.eval('_matchInit.released'), false, mode + ' migration: taken over during the initialization');
            let all = guests;
            if (end === 'drop') nh.eval(`hostRemovePlayerFromMatch(${JSON.stringify(oldHostId)})`);
            else {
                const back = world.spawn('host-back', { storage: host.storage, session: host.session, url: url(oldHostId) });
                back.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(oldHostId)})`);
                assert.ok(await world.runUntil(() => live(back) && back.snapshotsApplied > 0, 40000, 100), mode + ' migration-back: the old host is back as a player');
                all = [...guests, back];
            }
            settle(all);
            await runsOn(world, all, mode + ' migration-' + end);
            rows.push(mode + ': host lost during the initialization, ' + nh.name + ' took over, old host ' + (end === 'back' ? 'back' : 'dropped') + ': released, in sync');
        }
    }
    console.log('PASS multiplayer-start-warmup\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
