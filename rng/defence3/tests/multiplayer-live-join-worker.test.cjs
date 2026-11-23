// A join into a running match with the simulation worker (audit row 63, MULTIPLAYER_AUDIT_2026-10-15.md). The page's
// restore leaves out what only the worker keeps (a staged q / e, the navigation's state: utils_snapshot.js
// pageOnly); old code started the joiner's worker from a snapshot of that page, so the worker lacked them and the
// joiner diverged after the join (a repair followed). Now the worker starts from the host's own join text
// (sim_client.js simClientNoteJoinText / simClientTakeJoinText).
// Several rounds of a guest reloading the playing match (host's full sync), with movement and fights going on:
// after each, no repair, no second reload, every peer in sync.
//   node tests/multiplayer-live-join-worker.test.cjs   (worker mode always)
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 40, jitterMs: 5 };

(async () => {
    const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
    world.simWorker = true;
    const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
    const all = [host, ...guests];
    await H.playFor(world, all, 3000, { seed: 71 });
    assert.ok(all.every(i => i.eval('simClientActive()')), 'every page runs its match in a worker');
    const rows = [];
    for (let round = 0; round < 3; round++) {
        const g = guests[round % guests.length], gp = g.eval('myPeerId');
        const before = all.map(i => ({ patches: i.patchesApplied, snapshots: i.snapshotsApplied }));
        const tag = g.eval('String(simClientActive() && _simClient.epoch)');
        host.eval(`hostSendFullMatchSync(connections.find(c => c.peer === ${JSON.stringify(gp)}), 'playing')`);
        const joined = await world.runUntil(() => g.snapshotsApplied > before[all.indexOf(g)].snapshots
            && g.eval('gameStarted && !lockstepResyncPauseActive && simClientActive()') && g.eval('String(_simClient.epoch)') !== tag, 30000, 50);
        assert.ok(joined, 'round ' + round + ': the guest took the match again (worker restarted)');
        const from = Math.max(...all.map(i => i.eval('currentTick'))) + 3;
        await H.playFor(world, all, 4000, { seed: 72 + round });
        await world.run(1500);
        H.checkHealthy(world, all, { minCompared: 20, fromTick: from, label: 'round ' + round });
        for (const [k, i] of all.entries()) {
            assert.equal(i.patchesApplied, before[k].patches, 'round ' + round + ': ' + i.name + ' needed no repair after the join');
            assert.equal(i.snapshotsApplied, before[k].snapshots + (i === g ? 1 : 0), 'round ' + round + ': ' + i.name + ' reloaded only once');
            assert.equal(i.eval('netCounters.desyncsDetected | 0'), 0, 'round ' + round + ': ' + i.name + ' found no desync');
        }
        // (The host's checkpoint is the join's snapshot as the worker made it (gzipped there when it can,
        // sim_worker.js _simJoinPayload): it reads back as a whole snapshot, the state in it.)
        if (round === 0) {
            host.eval(`__scratch.ck = null; (typeof _netCkpt.text === 'string' ? Promise.resolve(_netCkpt.text) : netDecodeSnapshotPayload(_netCkpt.text)).then(t => { const s = JSON.parse(t); __scratch.ck = JSON.stringify({ kind: typeof _netCkpt.text === 'string' ? 'text' : (_netCkpt.text.z ? 'gzip' : 'json'), state: !!s.state, units: s.state && (s.state.units || s.state.u) ? 1 : 0, gameTime: Number.isFinite(s.gameTime), tick: _netCkpt.tick }); }, e => { __scratch.ck = 'error ' + e; })`);
            await world.runUntil(() => host.scratch.ck, 5000, 20);
            const ck = JSON.parse(host.scratch.ck);
            assert.ok(ck.state && ck.gameTime, 'the join checkpoint reads back as a whole snapshot: ' + host.scratch.ck);
            rows.push('the host\'s checkpoint is the join\'s payload (' + ck.kind + '), read back whole');
        }
        rows.push('round ' + round + ': ' + g.name + ' reloaded at tick ' + from + ', in sync, no repair');
    }
    console.log('PASS multiplayer-live-join-worker\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
