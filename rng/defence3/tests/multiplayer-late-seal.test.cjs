// One player's bad link must not freeze everyone else. When a guest's packet
// for a tick is late (a latency spike, jitter), the host seals the tick
// without it after a short grace and that guest's commands run on its next
// open tick; the host and the other players keep a steady rhythm. Every
// command still runs exactly once and every peer agrees on every tick. A
// guest that goes silent (an outage) or falls far behind still pauses the
// match for everyone, as its units could not be commanded meanwhile.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

// Frame gaps (ms) between ticks on each instance, from now on.
function trackRhythm(world, instances) {
    for (const i of instances) {
        i.scratch.now = () => world.now;
        i.scratch.rh = [];
        i.eval(`(() => { const o = runOneTick; runOneTick = function () { const r = o.apply(this, arguments); __scratch.rh.push(__scratch.now()); return r; }; })()`);
    }
    return i => {
        const frames = [...new Set(i.scratch.rh)];
        const gaps = [];
        for (let k = 1; k < frames.length; k++) gaps.push(frames[k] - frames[k - 1]);
        return { max: Math.round(Math.max(...gaps)), over150: gaps.filter(g => g > 150).length, ticks: i.scratch.rh.length };
    };
}

// Every command in the host's sealed history, counted by id.
function sealedCommandCounts(host) {
    return new Map(JSON.parse(host.eval(`JSON.stringify((() => {
        const n = {};
        const all = { ...lockstepHistoryByTick, ...lockstepBundleByTick };
        for (const k in all) for (const p of (all[k].packets || [])) for (const a of (p.actions || [])) if (a && a.netId) n[a.netId] = (n[a.netId] || 0) + 1;
        return Object.entries(n);
    })())`)));
}

(async () => {
    const rows = [];

    // 1. One guest's link spikes: the others do not notice.
    {
        const world = new H.World({ network: { latencyMs: 80, jitterMs: 15 }, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 4000, { seed: 1 });
        world.net.setProfile({ latencyMs: 80, jitterMs: 40, lossRate: 0.01, spikeEveryMs: 5000, spikeMs: 500 }, 'host', 'guest1');
        const rhythm = trackRhythm(world, all);
        const fromTick = host.eval('currentTick');
        const t0 = world.now;
        await H.playFor(world, all, 40000, { seed: 2, chance: 0.7 });
        await world.run(3000);
        const r = all.map(rhythm);
        // (At most the grace and some jitter on top of a tick; the spikes
        // themselves are 500 ms.)
        assert.ok(r[0].max <= 200 && r[2].max <= 200, 'host and the other guest keep their rhythm: max gaps ' + r.map(x => x.max).join('/'));
        assert.ok(r[0].ticks / ((world.now - t0) / 1000) > 19, 'host at full speed: ' + r[0].ticks);
        assert.ok(host.eval('netCounters.lateSeals') > 0, 'the spiky guest was sealed without');
        H.checkHealthy(world, all, { minCompared: 300, fromTick, label: 'spiky guest' });
        for (const i of all) H.assertAllCommandsExecuted(world, i, 'spiky guest', world.now - 3000);
        const counts = sealedCommandCounts(host);
        const twice = [...counts].filter(([, n]) => n > 1);
        assert.deepEqual(twice, [], 'a command sealed more than once');
        const leads = all.map(i => i.eval('netCommandLeadTicks()'));
        assert.ok(leads.every(l => l === leads[0]), 'same command delay for everyone: ' + leads);
        rows.push(`one guest's link spiking 500 ms: host and other guest max frame gap ${r[0].max}/${r[2].max} ms (spiky guest ${r[1].max} ms), `
            + `${host.eval('netCounters.lateSeals')} ticks sealed without it, ${host.eval('netCounters.lateCommandsCarried')} of its commands carried, each run once, in sync`);
    }

    // 2. A guest goes silent for 3 s: after about a second the match waits
    // for it, then resumes with every command.
    {
        const world = new H.World({ network: { latencyMs: 60, jitterMs: 10 }, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 4000, { seed: 3 });
        world.setLink(host, guests[0], 'blackhole');
        const before = host.eval('currentTick');
        await H.playFor(world, all, 3000, { seed: 4 });
        const during = host.eval('currentTick') - before;
        assert.ok(during < 1600 / host.eval('TICK_MS'), 'the match waited for the silent guest: ' + during + ' ticks in 3 s');
        assert.ok(host.eval('netGetWaitingPeerIds().length') === 1, 'host shows whom it waits for');
        world.setLink(host, guests[0], 'up');
        await H.playFor(world, all, 6000, { seed: 5 });
        await world.run(3000);
        H.checkHealthy(world, all, { minCompared: 60, label: 'silent guest' });
        for (const i of all) H.assertAllCommandsExecuted(world, i, 'silent guest', world.now - 3000);
        assert.deepEqual([...sealedCommandCounts(host)].filter(([, n]) => n > 1), [], 'a command sealed more than once');
        rows.push(`guest silent 3 s: the match went on for ${during} ticks, then waited; afterwards every command ran once, in sync`);
    }

    // 3. A link that suddenly gets slower: late packets (arriving several
    // times, as redundant copies and resends) are carried once each while
    // the lead catches up.
    {
        const world = new H.World({ network: { latencyMs: 60, jitterMs: 10 }, controls: { ...H.SMALL_MATCH_CONTROLS } });
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        const all = [host, ...guests];
        await H.playFor(world, all, 3000, { seed: 6 });
        const lead0 = guests[0].eval('netCommandLeadTicks()');
        // The guest's link gets 250 ms slower each way: its packets come
        // late until its lead covers the new round trip.
        world.net.setProfile({ latencyMs: 310, jitterMs: 10 }, 'guest1', 'host');
        await H.playFor(world, all, 15000, { seed: 7, chance: 0.8 });
        await world.run(3000);
        const lead1 = guests[0].eval('netCommandLeadTicks()');
        assert.ok(lead1 > lead0, `lead grew for the slow link: ${lead0} -> ${lead1}`);
        H.checkHealthy(world, all, { minCompared: 60, label: 'slow link' });
        for (const i of all) H.assertAllCommandsExecuted(world, i, 'slow link', world.now - 3000);
        assert.deepEqual([...sealedCommandCounts(host)].filter(([, n]) => n > 1), [], 'a command sealed more than once');
        rows.push(`guest link 250 ms slower each way: lead ${lead0} -> ${lead1} ticks, commands meanwhile carried once each, in sync`);
    }

    console.log('PASS: late seal\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
