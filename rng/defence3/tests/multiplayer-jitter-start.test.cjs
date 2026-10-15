// Match starts under heavy jitter (audit 2026-10-15,
// MULTIPLAYER_AUDIT_2026-10-15.md 15: a start under high jitter failed
// there): latency 60-210 ms, jitter 200-600 ms, 1-3 guests, with and
// without the simulation worker; every match starts, plays and stays in
// sync.
//   node tests/multiplayer-jitter-start.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

(async () => {
    const rows = [];
    for (let seed = 0; seed < 6; seed++) {
        const latencyMs = 60 + (seed % 4) * 50, jitterMs = 200 + (seed % 3) * 200;
        const world = new H.World({ network: { latencyMs, jitterMs }, controls: H.SMALL_MATCH_CONTROLS, compressSnapshots: seed % 2 === 0 });
        world.net.rngState = (0x9e3779b9 + (911 + seed) * 7919) >>> 0;
        world.simWorker = seed % 2 === 1;
        const t0 = world.now;
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 + (seed % 3), maxMs: 30000 });
        const started = world.now - t0;
        const all = [host, ...guests];
        const from = host.eval('currentTick') + 5;
        await H.playFor(world, all, 3000, { seed: 70 + seed });
        await world.run(2500);
        H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: 'jitter start ' + seed });
        assert.ok(all.every(i => i.eval('currentTick') > 60), 'every peer runs');
        rows.push(`latency ${latencyMs} ms, jitter ${jitterMs} ms, ${guests.length} guest(s)${world.simWorker ? ', workers' : ''}: started in ${Math.round(started)} ms, in sync`);
    }
    console.log('PASS multiplayer-jitter-start\n  ' + rows.join('\n  '));
})().catch(e => { console.error(e); process.exit(1); });
