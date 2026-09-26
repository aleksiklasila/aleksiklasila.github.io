// A 2-player match with thousands of units and buildings, created
// identically on both peers, after some play (paths, targets, workers and
// projectiles in use). Shared by the snapshot benchmarks and diagnostics.
'use strict';
const H = require('./net-harness.cjs');

function setupCode(unitsPerTeam, buildingsPerTeam) {
    return `(() => {
    const types = ['norm','fast','tank','flying','mole','snake','boss','scout','poison_resistant','collector','astar_collector','salvager_unit','builder_unit','healer_unit','researcher_unit'];
    const bTypes = ['pistol','smg','water','poison','sniper','fire','ice','laser','barrack_norm','barrack_fast','barrack_tank','spawner','astar_spawner','builder_spawner','healer_spawner','salvager','research','house','farm','sand','lava','ice_patch','water_puddle','poison_puddle','mine'];
    let placed = [0, 0], made = [0, 0];
    for (let owner = 0; owner < 2; owner++) {
        let n = 0;
        for (let gy = 2; gy < GRID_H - 2 && n < ${buildingsPerTeam}; gy += 1) {
            for (let gx = owner ? GRID_W - 3 : 2; owner ? gx > GRID_W / 2 + 4 : gx < GRID_W / 2 - 4; gx += owner ? -1 : 1) {
                if (n >= ${buildingsPerTeam}) break;
                if ((gx + gy) % 3 === 0) continue;
                const type = bTypes[(gx * 7 + gy * 13) % bTypes.length];
                if (placeBuilding(gx, gy, type, owner, { autoUpgradeEnabled: true, buildEnabled: true, silent: true, ignorePlacementRules: true })) {
                    n++;
                    const e = getTileEntityRef(gx, gy);
                    if (e && (gx + gy) % 5 !== 0) { e.underConstruction = false; if (Number.isFinite(e.maxEnergy)) e.energy = e.maxEnergy; }
                }
            }
        }
        placed[owner] = n;
        for (let i = 0; i < ${unitsPerTeam}; i++) {
            const type = types[i % types.length];
            const x = (owner ? GRID_W * 0.55 : GRID_W * 0.2) * TILE + rng() * GRID_W * 0.25 * TILE;
            const y = 3 * TILE + rng() * (GRID_H - 6) * TILE;
            const u = new Unit(BASE_UNIT_STATS[type] ? type : 'norm', owner, x, y);
            configureWorkerUnitFromType(u);
            units.push(u);
            players[owner].popCount++;
            made[owner]++;
        }
    }
    __scratch.setup = JSON.stringify({ placed, made });
})()`;
}

async function buildScaleWorld({ unitsPerTeam = 1500, buildingsPerTeam = 1500, mapSize = 128, playMs = 9000, worldOptions = {} } = {}) {
    const controls = {
        ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': String(mapSize), 'cfg-map-type': 'arena', 'cfg-gold-count': '120', 'cfg-astar-mine-count': '60',
        'cfg-starting-energy': '900000000', 'cfg-starting-astar': '900000000', 'cfg-max-pop': '100000', 'cfg-full-vis': 'team'
    };
    const world = new H.World({ network: { latencyMs: 40, jitterMs: 5 }, controls, hashEvery: 100000, ...worldOptions });
    const { host, guests } = await H.startHostedMatch(world, { guests: 1, maxMs: 120000 });
    const guest = guests[0];
    const T = world.atNextSafeTick(setupCode(unitsPerTeam, buildingsPerTeam), 30);
    await world.runUntil(() => [host, guest].every(i => i.eval('currentTick') > T + 2), 600000, 200);
    const rounds = Math.max(1, Math.round(playMs / 1500));
    for (let round = 0; round < rounds; round++) {
        for (const inst of [host, guest]) inst.eval(`(() => {
            const mine = units.filter(u => u.owner === localPlayerId && !u.workerState);
            for (let i = 0; i < mine.length; i += 60) queueAction({ action: 'attackMove', unitIds: mine.slice(i, i + 60).map(u => u.id), targetX: (localPlayerId ? 10 : GRID_W - 10) * TILE, targetY: ((i / 60) % (GRID_H - 10) + 5) * TILE });
        })()`);
        await world.run(1500, 50);
    }
    // Both peers at the same tick.
    await world.runUntil(() => guest.eval('currentTick') === host.eval('currentTick'), 20000, 10);
    return { world, host, guest, setup: host.scratch.setup };
}

// Wall time of evaluating `code` on an instance, averaged over n runs.
function time(inst, code, n = 1) {
    let out;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) out = inst.eval(code);
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6 / n, out };
}

// Sampling profile of fn(); prints the functions with the most self time.
async function profiled(label, fn, enabled = true) {
    if (!enabled) return fn();
    const inspector = require('node:inspector');
    const session = new inspector.Session();
    session.connect();
    const post = (m, p) => new Promise((r, j) => session.post(m, p || {}, (e, res) => e ? j(e) : r(res)));
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: 100 });
    await post('Profiler.start');
    const out = fn();
    const { profile } = await post('Profiler.stop');
    session.disconnect();
    const dt = new Map();
    for (let i = 0; i < profile.samples.length; i++) dt.set(profile.samples[i], (dt.get(profile.samples[i]) || 0) + (profile.timeDeltas[i] || 0));
    const self = new Map();
    for (const n of profile.nodes) {
        const k = (n.callFrame.functionName || '(anon)') + ':' + n.callFrame.lineNumber;
        self.set(k, (self.get(k) || 0) + (dt.get(n.id) || 0));
    }
    const top = [...self].filter(([k]) => !/^(\(program\)|\(idle\)|post|\(root\))/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 12);
    console.log('  profile ' + label + ': ' + top.map(([k, us]) => k + ' ' + (us / 1000).toFixed(1)).join(', '));
    return out;
}

module.exports = { buildScaleWorld, time, profiled, setupCode };
