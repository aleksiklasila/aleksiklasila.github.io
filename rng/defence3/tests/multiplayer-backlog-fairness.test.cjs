const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

async function latencyCase(slowHost) {
    const world = new H.World({ simWorker: true, network: { latencyMs: 20 }, controls: H.SMALL_MATCH_CONTROLS });
    const spawn = world.spawn.bind(world);
    world.spawn = (name, options) => spawn(name, { ...options, simWorkerMs: (name === 'host') === slowHost ? 300 : 5 });
    const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
    const all = [host, ...guests];
    for (const inst of all) {
        assert.equal(inst.eval('simClientActive()'), true, inst.name + ' uses the worker');
        inst.eval('netAutoEnabled = false; LOCKSTEP_PIPELINE_MIN = 15; LOCKSTEP_PIPELINE_TICKS = isHost ? 0 : 15; netMatchInputDelay = 15;');
    }
    await world.run(5000);
    const completed = inst => inst.eval('_simClient.appliedTick + 1');
    const startedAt = world.now;
    const startedTicks = all.map(completed);
    let maxGap = 0;
    for (let n = 0; n < 30; n++) {
        for (const inst of all) inst.eval(`queueAction({ action: 'hold', unitIds: [] });`);
        await world.run(200 + (n * 37) % 200);
        // Read completed results directly so this regression also runs against
        // the old implementation with DEFENCE_TEST_BASELINE=HEAD.
        maxGap = Math.max(maxGap, completed(host) - completed(guests[0]));
    }
    const tps = all.map((inst, i) => (completed(inst) - startedTicks[i]) * 1000 / (world.now - startedAt));
    assert.ok(Math.abs(tps[0] - tps[1]) < 0.6, 'completed TPS converges for host and client: ' + tps.join(', '));
    await world.run(8000);
    const latencies = all.map(inst => world.actionLatencies(inst));
    for (const samples of latencies) assert.equal(samples.length, 30, 'all commands completed');
    const mean = a => a.reduce((sum, n) => sum + n, 0) / a.length;
    const averages = latencies.map(mean);
    assert.ok(Math.abs(averages[0] - averages[1]) < 120, 'visible command latency is fair: ' + averages.join(', '));
    assert.ok(maxGap <= 4, 'host cannot keep a full input pipeline of completed simulation ahead: ' + maxGap);
    H.checkHealthy(world, all, { minCompared: 20, label: 'slow worker fairness' });
    for (const inst of all) {
        assert.equal(inst.eval('netCounters.desyncsDetected'), 0, 'no desync on ' + inst.name);
        assert.equal(inst.patchesApplied, 0, 'no repair needed on ' + inst.name);
    }
    console.log(`PASS: slow ${slowHost ? 'host' : 'guest'} worker, 16-tick lead: host ${Math.round(averages[0])} ms, guest ${Math.round(averages[1])} ms; maximum host lead ${maxGap} completed ticks.`);
}

async function recoveryCase() {
    const world = new H.World({ simWorker: true, network: { latencyMs: 20 }, controls: H.SMALL_MATCH_CONTROLS });
    const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
    guests[0].frameMs = 400;
    await world.run(12000);
    assert.ok(host.eval('netSimulationTickMs()') > 50, 'a sustained busy client adjusts the shared pace');
    guests[0].frameMs = 1000 / 60;
    await world.run(12000);
    assert.equal(host.eval('netSimulationTickMs()'), 50, 'host returns to full speed after recovery');
    assert.equal(guests[0].eval('netSimulationTickMs()'), 50, 'client receives the recovered pace');
    H.checkHealthy(world, [host, ...guests], { minCompared: 20, label: 'pace recovery' });
    console.log('PASS: temporary slow client recovers to 20 TPS without changing simulation state.');
}

(async () => {
    await latencyCase(false);
    await latencyCase(true);
    await recoveryCase();
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
