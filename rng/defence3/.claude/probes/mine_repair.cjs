// The desync-recovery test's guest divergence case for one kind, timed:
// when it was corrupted, detected and repaired.
//   node .claude/probes/mine_repair.cjs [kind=mine]
const H = require('../../tests/net-harness.cjs');
const kind = process.argv[2] || 'mine';
const WAN = { latencyMs: 60, jitterMs: 10 };
function corrupt(inst) {
    if (kind === 'unit') return inst.evalSim(`(() => { const u = units.find(u => !u.dead); u.energy = Math.max(1, u.energy - 3); u.x += 7; return u.id; })()`);
    if (kind === 'mine') return inst.evalSim(`(() => { const m = goldMines.find(m => m.gold > 100); m.gold -= 50; return m.gx + ',' + m.gy; })()`);
    if (kind === 'building') return inst.evalSim(`(() => { const b = [...towers, ...barracks, ...collectorSpawners].find(b => b.energy > 10); b.energy -= 5; b.spawnTimer = (b.spawnTimer || 0) + 3; return 0; })()`);
}
(async () => {
    for (let rep = 0; rep < 3; rep++) {
        const world = new H.World({ network: WAN, controls: H.SMALL_MATCH_CONTROLS });
        const { host, guests } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2] });
        const all = [host, ...guests];
        await H.playFor(world, all, 6000, { seed: 5 });
        const g = guests[0];
        const t0 = world.now, tick0 = g.eval('currentTick');
        const what = corrupt(g);
        let det = -1, rep0 = g.patchesApplied;
        await world.runUntil(() => {
            if (det < 0 && g.eval('netCounters.desyncsDetected') > 0) det = world.now - t0;
            return g.patchesApplied > rep0;
        }, 15000, 20);
        console.log(kind, what, 'tick', tick0, 'detected', det, 'ms, patched', world.now - t0, 'ms, desync tick', g.eval('netCounters.lastDesyncTick'));
    }
    process.exit(0);
})();
