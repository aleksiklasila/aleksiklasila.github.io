// A reloaded former host keeps looking for its match until a lone opponent has taken it over (audit row 76,
// MULTIPLAYER_AUDIT_2026-10-15.md, utils_host_migration.js MATCH_RECORD_SEEK_MS). 1v1: the host's page crashes (no
// link closes) and reloads at once. The guest, alone, takes the match over only after
// HOST_MIGRATION_ALONE_AFTER_SILENT_MS (60 s) and its attempt. Old code: the reloaded page gave up after six looks
// (~35 s): "Could not find that game", back to the menu, its team out. Now it looks ~85 s and joins the new host.
//   node tests/multiplayer-reload-seek.test.cjs   (SIM_WORKER=1: worker mode)
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 40, jitterMs: 5 };

(async () => {
    const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
    const { host, guests } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
    const g = guests[0], hostTeam = host.eval('localPlayerId'), oldHostId = host.eval('myPeerId');
    await H.playFor(world, [host, g], 2000, { seed: 201 });
    world.kill(host, { silent: true });
    const back = world.spawn('host-reloaded', { storage: host.storage, session: host.session, url: `http://localhost/rng/defence3/index.html?game=${oldHostId}&room=${oldHostId}` });
    back.eval(`loadOrCreateLocalIdentity(); joinGame(${JSON.stringify(oldHostId)})`);
    const t0 = world.now;
    const status = () => String(back.element('lobby-status') && back.element('lobby-status').textContent || '');
    const ok = await world.runUntil(() => back.eval('gameStarted') && g.eval('isHost') && back.eval('wsHostId') === g.eval('myPeerId')
        && !back.eval('lockstepResyncPauseActive') && back.eval('currentTick') > 0, 150000, 200);
    assert.ok(ok, 'the reloaded host found the match: ' + JSON.stringify([Math.round(world.now - t0), back.eval('gameStarted'), g.eval('isHost'), status()]));
    const ms = world.now - t0;
    assert.equal(back.eval('localPlayerId'), hostTeam, 'it plays its own team');
    assert.ok(!g.eval(`resignedTeams.has(${hostTeam})`), 'its team was not resigned');
    const from = Math.max(back.eval('currentTick'), g.eval('currentTick')) + 5;
    await H.playFor(world, [back, g], 3000, { seed: 202 });
    await world.run(1500);
    H.checkHealthy(world, [back, g], { minCompared: 10, fromTick: from, label: 'reload seek' });
    console.log('PASS multiplayer-reload-seek: back in the match ' + Math.round(ms / 1000) + ' s after its reload, the guest hosting');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
