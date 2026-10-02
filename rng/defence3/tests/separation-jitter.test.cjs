// Crowd separation quality on the large-world path (contacts on the
// helpers' chain, each unit every other tick, pushes spread over two
// ticks) against the small-world path (every unit every tick): two armies
// walk into one point and stand there. Measures, for the standing crowd:
// overlap between friends and between teams (padding), per-tick movement
// of units that have stopped (jitter: back-and-forth steps), and the
// largest single-tick move (no teleporting).
//   node tests/separation-jitter.test.cjs [--print]
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

function run(mode, seed, teams) {
    const slotPath = mode !== 'old';
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '60', 'cfg-map-type': 'arena' } });
    const inst = world.spawn('jitter' + (slotPath ? 'S' : 'O'), { simWorker: false });
    inst.eval('startSoloGame();');
    inst.eval(slotPath ? 'SEPARATION_SLOT_MIN_UNITS = 0; SPATIAL_PARALLEL_MIN_UNITS = 0;' : 'SEPARATION_SLOT_MIN_UNITS = 1e9;');
    if (mode === 'every') inst.eval('UNIT_SEPARATION_MODE = 1;');
    if (mode === 'global') inst.eval('UNIT_SEPARATION_MODE = 2;');
    const out = JSON.parse(inst.eval(`JSON.stringify((() => {
        for (const u of units) u.dead = true;
        gameTick();
        let s = ${seed};
        const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        const cx = Math.floor(GRID_W / 2), cy = Math.floor(GRID_H / 2), ids = [[], []];
        // Two armies, 8 tiles each side of the middle, walking in.
        for (let team = 0; team < 2; team++) for (let i = 0; i < 260; i++) {
            const gx = cx + (team ? 8 : -8) + Math.floor(rnd() * 5) - 2, gy = cy + Math.floor(rnd() * 9) - 4;
            const t = findNearestWalkable(gx, gy);
            const u = new Unit(i % 7 === 0 ? 'tank' : 'norm', ${teams} === 2 ? team : 0, t.x * TILE + 4 + rnd() * 24, t.y * TILE + 4 + rnd() * 24);
            units.push(u); updateUnitSpatial(u); ids[team].push(u.id);
        }
        for (let team = 0; team < 2; team++) processAction({ action: 'move', unitIds: ids[team], targetX: (cx + (team ? 1.5 : -1.5)) * TILE, targetY: cy * TILE }, ${teams} === 2 ? team : 0);
        const byId = new Map(units.map(u => [u.id, u]));
        const all = [...ids[0], ...ids[1]];
        const pos = [];
        for (let t = 0; t < 260; t++) {
            gameTick();
            pos.push(all.map(id => { const u = byId.get(id); return u && !u.dead ? [u.x, u.y] : null; }));
        }
        // The standing crowd: the last 80 ticks.
        let steps = 0, reversals = 0, still = 0, maxStep = 0, sumStep = 0;
        for (let k = 0; k < all.length; k++) {
            for (let t = 181; t < pos.length; t++) {
                const a = pos[t - 2][k], b = pos[t - 1][k], c = pos[t][k];
                if (!a || !b || !c) continue;
                const d1x = b[0] - a[0], d1y = b[1] - a[1], d2x = c[0] - b[0], d2y = c[1] - b[1];
                const m = Math.hypot(d2x, d2y);
                sumStep += m; steps++;
                if (m < 0.01) still++;
                if (d1x * d2x + d1y * d2y < -0.01) reversals++;
            }
            for (let t = 1; t < pos.length; t++) { const a = pos[t - 1][k], b = pos[t][k]; if (a && b) maxStep = Math.max(maxStep, Math.hypot(b[0] - a[0], b[1] - a[1])); }
        }
        // Overlap at the end: friends (radii) and teams (radii + padding).
        const pad = Math.max(0, Number(CROSS_TEAM_UNIT_COLLISION_PADDING) || 0), alive = all.map(id => byId.get(id)).filter(u => u && !u.dead);
        let pairs = 0, ovF = 0, ovE = 0, deepF = 0, deepE = 0, nf = 0, ne = 0;
        for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) {
            const a = alive[i], b = alive[j];
            if (!!a.isFlying !== !!b.isFlying) continue;
            const ra = +a.collisionR || +a.r, rb = +b.collisionR || +b.r, same = a.owner === b.owner;
            const want = ra + rb + (same ? 0 : pad), d = Math.hypot(a.x - b.x, a.y - b.y);
            if (d >= want) continue;
            const o = (want - d) / want;
            if (same) { ovF += o; nf++; deepF = Math.max(deepF, o); } else { ovE += o; ne++; deepE = Math.max(deepE, o); }
            pairs++;
        }
        return { units: alive.length, meanStep: sumStep / Math.max(1, steps), still: still / Math.max(1, steps), reversals: reversals / Math.max(1, steps), maxStep,
            friendOverlapPairs: nf, friendOverlap: nf ? ovF / nf : 0, friendDeepest: deepF, enemyOverlapPairs: ne, enemyOverlap: ne ? ovE / ne : 0, enemyDeepest: deepE };
    })())`));
    assert.deepEqual(inst.errors.map(String), []);
    return out;
}

const rows = [], print = process.argv.includes('--print');
for (const [seed, teams] of [[5, 1], [17, 1], [5, 2], [17, 2]]) {
    const old = run('old', seed, teams), now = run('tier', seed, teams);
    rows.push({ seed, teams, old, now });
    if (print) {
        const every = run('every', seed, teams);
        for (const [k, v] of [['old', old], ['every', every], ['tier', now]]) console.log(seed, teams, k, Object.entries(v).map(([a, b]) => a + '=' + (+b).toFixed(3)).join(' '));
        continue;
    }
    // No teleporting: one tick's move stays within what walking and the
    // bounded pushes give.
    assert.ok(now.maxStep <= Math.max(16, old.maxStep * 1.25), `seed ${seed}/${teams}: largest tick move ${now.maxStep} (old ${old.maxStep})`);
    if (teams === 1) {
        // A standing crowd settles: little back-and-forth; not packed.
        assert.ok(now.reversals <= old.reversals * 1.25 + 0.02, `seed ${seed}: reversals ${now.reversals} (old ${old.reversals})`);
        assert.ok(now.meanStep <= old.meanStep * 1.25 + 0.05, `seed ${seed}: mean step ${now.meanStep} (old ${old.meanStep})`);
        assert.ok(now.friendOverlap <= old.friendOverlap * 1.6 + 0.01, `seed ${seed}: friend overlap ${now.friendOverlap} (old ${old.friendOverlap})`);
    } else {
        // Fighting: teams kept apart by the padding.
        assert.ok(now.enemyOverlap <= old.enemyOverlap * 1.6 + 0.03, `seed ${seed}: enemy overlap ${now.enemyOverlap} (old ${old.enemyOverlap})`);
    }
}
if (!print) console.log('PASS: crowd separation (helpers, 10/s per unit, spread pushes) about as smooth and spaced as every-tick separation: ' +
    rows.map(r => `seed ${r.seed}/${r.teams}: reversals ${r.now.reversals.toFixed(3)}/${r.old.reversals.toFixed(3)}, step ${r.now.meanStep.toFixed(3)}/${r.old.meanStep.toFixed(3)}, overlap ${r.now.friendOverlap.toFixed(3)}/${r.old.friendOverlap.toFixed(3)} (teams ${r.now.enemyOverlap.toFixed(3)}/${r.old.enemyOverlap.toFixed(3)}), max move ${r.now.maxStep.toFixed(1)}/${r.old.maxStep.toFixed(1)}`).join('; '));
