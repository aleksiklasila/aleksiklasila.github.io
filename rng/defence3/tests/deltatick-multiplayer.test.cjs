// The shared deltatick in a match: the host seals each step's base ticks
// (simDk) into its bundle; every peer runs that step size, so the state
// agrees at every step while the size changes (1, 3, 8, 20, 5 here, with
// commands of both players), across a repair of a diverged guest (the step
// carries, unit.atkL / wtcL, go with the patch), and game time is the sum of
// the step sizes on every peer.
// SIM_WORKER=1 node tests/deltatick-multiplayer.test.cjs (or 0)
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const WAN = { latencyMs: 50, jitterMs: 10 };
const CONTROLS = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '40', 'cfg-map-type': 'arena', 'cfg-max-pop': '5000', 'cfg-full-vis': 'team',
    'cfg-starting-energy': '200000', 'cfg-starting-astar': '200000' };

(async () => {
    const world = new H.World({ network: WAN, controls: CONTROLS, hashEvery: 1, recordParts: true });
    const spawnCounts = { 'unit:king': { 1: 1 }, 'unit:norm': { 1: 30 }, 'unit:fast': { 1: 8 }, 'unit:fire_resistant': { 1: 6 },
        'unit:collector_unit': { 1: 6 }, 'building:barrack_norm': { 1: 2 }, 'building:pistol': { 1: 3 } };
    const { host, guests } = await H.startHostedMatch(world, { guests: 1, hostSetup: `startingResourcesConfig = ${JSON.stringify({ spawnCounts, researchLevels: {} })};` });
    const all = [host, ...guests];
    // (The host's pace says the step size: forced here, as a slow machine's
    // pace would set it.)
    host.eval(`__scratch.dk = 1; netStepTicks = () => __scratch.dk;`);
    const sizes = (process.env.DK_SIZES || '1,3,8,20,5').split(',').map(Number);
    let seed = 7;
    for (const dk of sizes) {
        host.scratch.dk = dk;
        // Both armies into the middle now and then: fights at every size.
        for (const inst of all) inst.eval(`(() => {
            const mine = units.filter(u => u.owner === localPlayerId && !u.dead && !u.workerType && !u.isKing).map(u => u.id);
            if (mine.length) queueAction({ action: 'attackMove', unitIds: mine, targetX: GRID_W * TILE / 2, targetY: GRID_H * TILE / 2 });
        })()`);
        await H.playFor(world, all, Number(process.env.DK_PLAY_MS || 4000), { stepMs: 250, chance: 0.4, seed: seed++ });
    }
    const steps = JSON.parse(host.evalSim(`JSON.stringify({ g: gameTime, t: currentTick })`));
    const gsteps = JSON.parse(guests[0].evalSim(`JSON.stringify({ g: gameTime, t: currentTick })`));
    if (Math.max(...sizes) > 2) assert.ok(steps.g > steps.t * 2, `game time ran ahead of the steps (${steps.g} base ticks in ${steps.t} steps)`);
    let cmp = H.checkHealthy(world, all, { minCompared: 50, label: 'step sizes 1-20' });
    for (const inst of all) assert.equal(inst.eval('netCounters.desyncsDetected'), 0, inst.name + ' detected no desync');
    console.log(`  ${cmp.compared} steps compared; host at ${steps.g} base ticks / ${steps.t} steps, guest at ${gsteps.g} / ${gsteps.t}`);

    // A diverged guest is patched while the steps are of 7 base ticks; the
    // match then agrees again.
    host.scratch.dk = Number(process.env.DK_REPAIR || 7);
    await world.run(1500);
    const before = guests[0].patchesApplied + guests[0].snapshotsApplied;
    guests[0].evalSim(`(() => { const u = units.find(u => !u.dead && !u.isKing); u.energy = Math.max(1, u.energy - 3); u.x += 7; })()`);
    const ok = await world.runUntil(() => guests[0].patchesApplied + guests[0].snapshotsApplied > before && !guests[0].eval('lockstepResyncPauseActive'), 20000, 20);
    assert.ok(ok, 'the diverged guest was repaired');
    const from = Number(host.eval('currentTick'));
    if (process.env.DK_DEBUG) {
        const dump = i => JSON.parse(i.evalSim('JSON.stringify({ t: currentTick, u: units.filter(u => !u.dead).map(u => [u.id, u.atkL, u.wtcL, +(+u.attackTimer).toFixed(3), u.workerTransferCooldown]) })'));
        const a = dump(host), b = dump(guests[0]);
        const bm = new Map(b.u.map(r => [r[0], r]));
        const diff = a.u.filter(r => { const q = bm.get(r[0]); return !q || JSON.stringify(q) !== JSON.stringify(r); }).slice(0, 8).map(r => [r, bm.get(r[0])]);
        console.log('  steps', a.t, b.t, 'carry diffs', JSON.stringify(diff));
    }
    await H.playFor(world, all, 5000, { stepMs: 250, chance: 0.4, seed: 99 });
    {
        const c = world.compareHashes(all, from + 5);
        if (c.mismatches.length) {
            const m = c.mismatches[0], a = all.find(i => i.name === m.a), b = all.find(i => i.name === m.b);
            const pa = a.tickParts.get(m.tick) || {}, pb = b.tickParts.get(m.tick) || {};
            if (process.env.DIVNEAR) {
                const [id, t] = process.env.DIVNEAR.split(',').map(Number);
                for (const tt of [t - 1, t]) {
                    const A = (a.scratch.near || {})[tt] || {}, B = (b.scratch.near || {})[tt] || {};
                    for (const u of new Set([...Object.keys(A), ...Object.keys(B)])) {
                        const x = A[u] || {}, y = B[u] || {}, d = [];
                        for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (x[k] !== y[k]) d.push(k + ' ' + x[k] + ' | ' + y[k]);
                        if (d.length) console.log('  near', tt, u, d.slice(0, 30).join('; '));
                    }
                }
            }
            console.log('  first mismatch at step', m.tick, 'parts', Object.keys(pa).filter(k => pa[k] !== pb[k]), 'repair ended by step', from);
        }
    }
    cmp = H.checkHealthy(world, all, { minCompared: 20, fromTick: from + 5, label: 'after the repair at dk 7' });
    console.log(`  after the repair: ${cmp.compared} steps compared`);
    console.log('PASS: the step size goes with the bundles; peers agree at every size, and after a repair.');
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
