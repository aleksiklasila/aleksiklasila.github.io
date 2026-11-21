// A tick that throws part way is not taken as healthy (audit 2026-10-30, C).
// 1. One guest's tick throws once (late in gameTick, after part of it ran):
//    it asks for a full repair at once, is repaired, and the match agrees
//    and runs commands afterwards. (Old code: nothing asked; a hash
//    mismatch, if the half tick showed in one, got a partial patch later.)
// 2. Every peer's ticks throw alike for a while (a fault the host's state
//    carries): the guest asks for a full repair at most once a minute (no
//    snapshot loop), the match keeps going, and agrees once the fault ends.
// 3. A second guest-only failure inside that minute is repaired once it ends (audit row 74, 2026-11-18).
// Page and worker simulation (SIM_WORKER=1).
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const inject = (inst, n) => inst.evalSim(`(() => { const f = resourceTick; let n = ${n}; resourceTick = function () { if (n-- > 0) throw new Error('injected tick failure'); return f.apply(this, arguments); }; return 0; })()`);
const full = i => i.eval('resyncGuest.fullPatches | 0');
// (The injected errors only: anything else still fails checkHealthy.)
const dropInjected = all => { for (const i of all) i.errors = i.errors.filter(e => !/injected tick failure/.test(String(e && e.stack || e))); };

(async () => {
    {
        const world = new H.World({ network: { latencyMs: 40, jitterMs: 5 }, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        const all = [host, ...guests], g = guests[0];
        await H.playFor(world, all, 2000, { seed: 11 });
        const full0 = full(g), rep0 = g.patchesApplied + g.snapshotsApplied;
        inject(g, 1);
        assert.ok(await world.runUntil(() => g.eval('netCounters.tickFailures | 0') >= 1, 5000), 'the failure was noted');
        assert.ok(await world.runUntil(() => g.patchesApplied + g.snapshotsApplied > rep0 && !g.eval('resyncGuest.outstanding') && g.eval('resyncGuest.T') < 0, 8000),
            'repaired: ' + JSON.stringify([g.patchesApplied, g.snapshotsApplied, g.eval('JSON.stringify(resyncGuest)')]));
        assert.ok(full(g) > full0 || g.snapshotsApplied > 0, 'a full repair');
        const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
        await H.playFor(world, all, 3000, { seed: 12 });
        await world.run(1500);
        dropInjected(all);
        H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: 'after a failed tick' });
    }
    {
        const world = new H.World({ network: { latencyMs: 40, jitterMs: 5 }, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        const all = [host, ...guests], g = guests[0];
        await H.playFor(world, all, 2000, { seed: 21 });
        const full0 = full(g), snaps0 = g.snapshotsApplied, t0 = host.eval('currentTick');
        // ~3 s of failing ticks on both.
        for (const i of all) inject(i, 60);
        await H.playFor(world, all, 6000, { seed: 22 });
        await world.run(1500);
        assert.ok(g.eval('netCounters.tickFailures | 0') >= 30, 'the guest failed alike');
        assert.ok(host.eval('currentTick') > t0 + 80, 'the match kept going');
        assert.ok(full(g) - full0 + g.snapshotsApplied - snaps0 <= 2, 'no repair loop: ' + (full(g) - full0) + ' full patches, ' + (g.snapshotsApplied - snaps0) + ' snapshots');
        const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
        await H.playFor(world, all, 3000, { seed: 23 });
        await world.run(1500);
        dropInjected(all);
        H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: 'after a shared fault' });
    }
    {
        // 3. Two guest-only failures, the second ~20 s after the first's repair, within RESYNC_GLOBAL_MIN_INTERVAL_MS
        //    (60 s): the second is owed and repaired once the interval ends (audit row 74, utils_resync.js
        //    failOwed). Old code: taken off the list while the interval ran and dropped: never repaired. (A tick that
        //    throws after it ran: the state agrees, so only the failure report can bring the repair.)
        const after = (inst, n) => inst.evalSim(`(() => { const f = gameTick; let n = ${n}; gameTick = function () { const r = f.apply(this, arguments); if (n-- > 0) throw new Error('injected tick failure'); return r; }; return 0; })()`);
        const world = new H.World({ network: { latencyMs: 40, jitterMs: 5 }, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 1 });
        const all = [host, ...guests], g = guests[0];
        await H.playFor(world, all, 2000, { seed: 31 });
        const rep = () => g.patchesApplied + g.snapshotsApplied, settled = () => !g.eval('resyncGuest.outstanding') && g.eval('resyncGuest.T') < 0;
        const rep0 = rep();
        after(g, 1);
        assert.ok(await world.runUntil(() => rep() > rep0 && settled(), 10000), 'the first failure was repaired');
        const t1 = world.now;
        await H.playFor(world, all, 20000, { seed: 32 });
        const rep1 = rep(), fails1 = g.eval('netCounters.tickFailures | 0');
        after(g, 1);
        assert.ok(await world.runUntil(() => g.eval('netCounters.tickFailures | 0') > fails1, 5000), 'the second failure was noted');
        assert.ok(await world.runUntil(() => rep() > rep1 && settled(), 60000), 'the second failure, inside the interval, was repaired after it: ' + JSON.stringify([rep1, rep(), g.eval('resyncGuest.failOwed')]));
        const waited = world.now - t1;
        assert.ok(waited >= 55000, 'not before the interval (' + Math.round(waited) + ' ms after the first)');
        const from = Math.max(...all.map(i => i.eval('currentTick'))) + 5;
        await H.playFor(world, all, 3000, { seed: 33 });
        await world.run(1500);
        dropInjected(all);
        H.checkHealthy(world, all, { minCompared: 10, fromTick: from, label: 'after an owed repair' });
    }
    console.log('PASS multiplayer-tick-failure');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
