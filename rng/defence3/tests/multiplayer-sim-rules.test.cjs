// The simulation's rule switches a page reads from its URL (?occupancy=0, ?traffic=N, ?acq=exact) are the host's
// in a match (static audit 2026-11-18): matchStartConfig.simRules, adopted by every guest (netSimRulesApply) before
// its world is made and sent to its worker. Before, each page ran its own: a guest opened with ?occupancy=0 accepted
// the host's snapshots and diverged again in every crowd.
// A guest whose page has other switches (as from its URL) plays a match in sync, its page and worker on the host's.
// Both modes (SIM_WORKER=1 / page), and a guest reloading into the running match.
//   node tests/multiplayer-sim-rules.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const OTHER = 'SIM_OCCUPANCY_ENABLED = false; SIM_TRAFFIC_MODE = 0; SIM_ACQ_AREA_TARGETS = false;';
const READ = 'JSON.stringify([!!SIM_OCCUPANCY_ENABLED, SIM_TRAFFIC_MODE | 0, !!SIM_ACQ_AREA_TARGETS])';
const MODES = process.env.MODES ? process.env.MODES.split(',') : ['page', 'worker'];

(async () => {
    const rows = [];
    for (const mode of MODES) {
        const world = new H.World({ network: { latencyMs: 40, jitterMs: 5 }, controls: H.SMALL_MATCH_CONTROLS });
        world.simWorker = mode === 'worker';
        const spawn = world.spawn.bind(world);
        world.spawn = (name, opts) => { const i = spawn(name, opts); if (name !== 'host') i.eval(OTHER); return i; };
        const { host, guests } = await H.startHostedMatch(world, { guests: 1, teams: [0, 1] });
        const g = guests[0], all = [host, g];
        const want = host.eval(READ);
        assert.equal(g.eval(READ), want, mode + ': the guest page runs the host\'s switches');
        if (mode === 'worker') assert.equal(g.simWorker.eval(READ), want, mode + ': the guest worker runs the host\'s switches');
        // (The start's snapshot counts as one; repairs after it are what matters.)
        const rep0 = g.patchesApplied + g.snapshotsApplied;
        // (A crowd in motion: occupancy and traffic decide where units stand.)
        await H.playFor(world, all, 6000, { seed: 7 });
        await world.run(1500);
        H.checkHealthy(world, all, { minCompared: 20, fromTick: 0, label: mode + ' switches' });
        assert.equal(g.patchesApplied + g.snapshotsApplied - rep0, 0, mode + ': no repair needed');
        rows.push(`${mode}: guest with other switches runs the host's ${want}, in sync, no repairs`);
    }
    console.log('PASS multiplayer-sim-rules\n  ' + rows.join('\n  '));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
