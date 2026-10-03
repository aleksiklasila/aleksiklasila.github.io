// Background lanes are shared (lane 0: the separation chain and the state
// hash's region kernel), and their per-stage params persist between jobs.
// A job must write every param its kernels read: one left over from another
// job can change what the kernel does (the separation's pack read the live
// positions, which the unit pass moves, instead of the tick-start copy: a
// peer with helpers and one without then diverged). Two equal worlds on the
// large-world paths, one with every lane's stage params overwritten before
// each tick and before each hash: the same state, tick by tick.
//   node tests/lane-params-poison.test.cjs   (POISON_LANES=0,3: those lanes only)
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

function run(poison) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '60', 'cfg-map-type': 'arena' } });
    const inst = world.spawn('lanes' + (poison ? 'P' : 'C'), { simWorker: false });
    inst.eval('startSoloGame();');
    inst.eval('SEPARATION_SLOT_MIN_UNITS = 0; SPATIAL_PARALLEL_MIN_UNITS = 0; SNAP_HASH_KERNEL_MIN_UNITS = 0; EFF_STATS_KERNEL_MIN_UNITS = 0;');
    const out = JSON.parse(inst.eval(`JSON.stringify((() => {
        const poison = ${poison ? 'true' : 'false'};
        // (Lanes with a job still to run keep theirs: tier jobs span ticks.)
        const only = ${JSON.stringify(String(process.env.POISON_LANES || ''))}.split(',').filter(Boolean).map(Number);
        const spoil = () => { if (!poison) return; for (let lane = 0; lane < SIM_PAR_BG_LANES; lane++) {
            if ((only.length && !only.includes(lane)) || simParallelBackgroundPending(lane)) continue;
            for (let st = 0; st < SIM_PAR_BG_STAGES; st++) simParallelStageParams(lane, st).fill(1); } };
        let s = 7;
        const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        const cx = Math.floor(GRID_W / 2), cy = Math.floor(GRID_H / 2), ids = [[], []];
        for (let team = 0; team < 2; team++) for (let i = 0; i < 220; i++) {
            const gx = cx + (team ? 8 : -8) + Math.floor(rnd() * 5) - 2, gy = cy + Math.floor(rnd() * 9) - 4;
            const t = findNearestWalkable(gx, gy);
            const u = new Unit(i % 7 === 0 ? 'tank' : 'norm', team, t.x * TILE + 4 + rnd() * 24, t.y * TILE + 4 + rnd() * 24);
            units.push(u); updateUnitSpatial(u); ids[team].push(u.id);
        }
        for (let team = 0; team < 2; team++) processAction({ action: 'move', unitIds: ids[team], targetX: (cx + (team ? 1.5 : -1.5)) * TILE, targetY: cy * TILE }, team);
        const hashes = [], positions = [];
        for (let t = 0; t < 160; t++) {
            spoil();
            gameTick();
            spoil();
            hashes.push(computeLockstepStateHashFast(gameTime));
            if (t % 20 === 19) positions.push(units.map(u => u.dead ? null : [u.id, u.x, u.y]));
        }
        return { hashes, positions, units: units.filter(u => !u.dead).length };
    })())`));
    assert.deepEqual(inst.errors.map(String), []);
    return out;
}

const clean = run(false), poisoned = run(true);
assert.ok(clean.units > 300, 'the armies are there: ' + clean.units);
const first = clean.hashes.findIndex((h, i) => h !== poisoned.hashes[i]);
assert.equal(first, -1, 'state hashes differ from tick ' + first);
assert.deepEqual(poisoned.positions, clean.positions);
console.log('PASS: lane params poison (' + clean.hashes.length + ' ticks, ' + clean.units + ' units)');
