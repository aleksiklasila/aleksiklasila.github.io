// Units behind their stat tables (a research done for their type) take
// their new tables in the kernel (SIM_KERNEL_EFF_UNITS, from the base entry
// and row the full path made: things_utils.js _effBaseNote), not the full
// path one by one: the same state either way. Two equal worlds, armies of
// several levels fighting while researches finish every few ticks (energy,
// speed, vision, attack: new maxEnergy, energy clamps, movement columns,
// vision cover), one with the kernel's way off: the same state hash every
// tick, the same units' energy and maxEnergy; the kernel took many.
//   node tests/eff-behind-kernel.test.cjs
'use strict';
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

function run(inKernel) {
    const world = new H.World({ controls: { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '60', 'cfg-map-type': 'arena' } });
    const inst = world.spawn('eff' + (inKernel ? 'K' : 'J'), { simWorker: false });
    inst.eval('startSoloGame();');
    inst.eval(`SEPARATION_SLOT_MIN_UNITS = 0; SPATIAL_PARALLEL_MIN_UNITS = 0; SNAP_HASH_KERNEL_MIN_UNITS = 0; EFF_STATS_KERNEL_MIN_UNITS = 0; EFF_BEHIND_IN_KERNEL = ${inKernel ? 'true' : 'false'};`);
    const out = JSON.parse(inst.eval(`JSON.stringify((() => {
        let s = 11;
        const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        const cx = Math.floor(GRID_W / 2), cy = Math.floor(GRID_H / 2), ids = [[], []];
        for (let team = 0; team < 2; team++) for (let i = 0; i < 260; i++) {
            const gx = cx + (team ? 9 : -9) + Math.floor(rnd() * 7) - 3, gy = cy + Math.floor(rnd() * 11) - 5;
            const t = findNearestWalkable(gx, gy);
            const u = new Unit(i % 5 === 0 ? 'tank' : 'norm', team, t.x * TILE + 4 + rnd() * 24, t.y * TILE + 4 + rnd() * 24);
            // (Several base levels.)
            if (i % 3 === 0) u.stackCount = 1 + (i % 9);
            units.push(u); updateUnitSpatial(u); ids[team].push(u.id);
        }
        for (let team = 0; team < 2; team++) processAction({ action: 'attackMove', unitIds: ids[team], targetX: (cx + (team ? -6 : 6)) * TILE, targetY: cy * TILE }, team);
        const stats = ['energy', 'speed', 'visionRange', 'atk', 'atkCd'], keys = ['norm', 'tank'];
        const hashes = [], snaps = [];
        for (let t = 0; t < 240; t++) {
            if (t % 7 === 3) applyResearchCompletion(t % 2, { kind: 'unit', key: keys[(t >> 1) % 2], statKey: stats[(t >> 2) % stats.length] });
            gameTick();
            hashes.push(computeLockstepStateHashFast(gameTime));
            if (t % 30 === 29) snaps.push(units.map(u => { if (u.dead) return null; const c = u._us, q = u._si, pc = u.preComputed || {};
                return [u.id, u.energy, u.maxEnergy, u.effectiveLevel, u.x, u.y, pc.speed, pc.attackDamage, pc.visionRange, pc.maxEnergy, u.preComputedBase && u.preComputedBase.maxEnergy,
                    c ? [c.mvSpd[q], c.atkDmg[q], c.atkCd[q], c.maxE[q], c.esRad[q], c.vsR[q]] : null]; }));
        }
        return { hashes, snaps, units: units.filter(u => !u.dead).length, taken: _effBehindInKernel };
    })())`));
    assert.deepEqual(inst.errors.map(String), []);
    return out;
}

const js = run(false), kern = run(true);
assert.ok(js.units > 50, 'the armies are there: ' + js.units);
assert.equal(js.taken, 0, 'off: none in the kernel');
assert.ok(kern.taken > 200, 'on: the kernel took units behind their tables: ' + kern.taken);
const first = js.hashes.findIndex((h, i) => h !== kern.hashes[i]);
assert.equal(first, -1, 'state hashes differ from tick ' + first);
assert.deepEqual(kern.snaps, js.snaps);
console.log('PASS: eff-behind-kernel (' + js.hashes.length + ' ticks, ' + js.units + ' units, ' + kern.taken + ' taken in the kernel)');
