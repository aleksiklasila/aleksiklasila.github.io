// Lockstep under different link qualities: the match must stay in sync, run
// near the target tick rate, execute every command, and keep command latency
// close to what the link allows.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const PROFILES = [
    // name, link, min share of target TPS, max guest command latency p50 (ms)
    { name: 'lan', link: { latencyMs: 2, jitterMs: 1 }, minTps: 0.95, maxLatency: 160 },
    { name: 'wan', link: { latencyMs: 60, jitterMs: 10 }, minTps: 0.95, maxLatency: 300 },
    { name: 'high-ping', link: { latencyMs: 250, jitterMs: 30 }, minTps: 0.95, maxLatency: 750 },
    { name: 'intercontinental-vpn', link: { latencyMs: 400, jitterMs: 120, lossRate: 0.01 }, minTps: 0.85, maxLatency: 1450 },
    { name: 'unstable', link: { latencyMs: 80, jitterMs: 150, lossRate: 0.03, spikeEveryMs: 7000, spikeMs: 600 }, minTps: 0.85, maxLatency: 1000 },
];

(async () => {
    const rows = [];
    for (const profile of PROFILES) {
        const world = new H.World({ network: profile.link, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        const all = [host, ...guests];
        const startTick = host.eval('currentTick');
        const startAt = world.now;
        await H.playFor(world, all, 20000, { seed: 7 });
        // Let in-flight commands land before checking them.
        const issuedBefore = world.now;
        await world.run(3000);
        const seconds = (world.now - startAt) / 1000;
        const tps = (host.eval('currentTick') - startTick) / seconds;
        H.checkHealthy(world, all, { minCompared: 50, label: profile.name });
        for (const inst of all) H.assertAllCommandsExecuted(world, inst, profile.name, issuedBefore);
        const target = host.eval('TICK_RATE');
        assert.ok(tps >= target * profile.minTps, `${profile.name}: ${tps.toFixed(1)} TPS of ${target}`);
        for (const inst of all) assert.equal(inst.snapshotsApplied, 1, `${profile.name}: ${inst.name} needed a resync (only the start snapshot is expected)`);
        const lat = world.actionLatencies(guests[0]);
        const p50 = H.percentile(lat, 0.5);
        assert.ok(p50 <= profile.maxLatency, `${profile.name}: guest command latency p50 ${Math.round(p50)}ms`);
        // Messages per second each peer sends (was ~60-120/s before).
        const rate = Math.max(...all.map(i => i.netStats.sentMessages)) / ((world.now) / 1000);
        assert.ok(rate < 45, `${profile.name}: ${rate.toFixed(1)} messages/s`);
        rows.push(`${profile.name}: ${tps.toFixed(1)}/${target} TPS, guest latency p50 ${Math.round(p50)}ms, input delay ${guests[0].eval('LOCKSTEP_PIPELINE_TICKS')} ticks, ${rate.toFixed(0)} msg/s`);
    }

    // Asymmetric links: one guest on LAN, one far away. Each guest's input
    // delay follows its own link.
    {
        const world = new H.World({ network: { latencyMs: 5 }, controls: H.SMALL_MATCH_CONTROLS });
        const hostPromise = H.startHostedMatch(world, { guests: 2, guestNames: ['near', 'far'] });
        // Links are keyed by instance name, so they can be set before connecting.
        world.net.setProfile({ latencyMs: 300, jitterMs: 40 }, 'host', 'far');
        const { host, guests } = await hostPromise;
        const [near, far] = guests;
        await H.playFor(world, [host, near, far], 15000, { seed: 3 });
        await world.run(3000);
        H.checkHealthy(world, [host, near, far], { minCompared: 40, label: 'asymmetric' });
        const nearDelay = near.eval('LOCKSTEP_PIPELINE_TICKS');
        const farDelay = far.eval('LOCKSTEP_PIPELINE_TICKS');
        assert.ok(nearDelay <= 2, 'LAN guest keeps a small input delay: ' + nearDelay);
        assert.ok(farDelay >= 6, 'far guest raises its own delay: ' + farDelay);
        const nearP50 = H.percentile(world.actionLatencies(near), 0.5);
        assert.ok(nearP50 <= 160, 'near guest stays responsive next to a far one: ' + nearP50);
        rows.push(`asymmetric: near delay ${nearDelay} (${Math.round(nearP50)}ms), far delay ${farDelay}`);
    }

    console.log('PASS: multiplayer network profiles\n  ' + rows.join('\n  '));
})().catch(err => { console.error(err); process.exit(1); });
