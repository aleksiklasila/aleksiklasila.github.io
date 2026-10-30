'use strict';
// Probe: multiplayer-features section 2: the units' columns on both peers at the same ticks.
const H = require('./net-harness.cjs');
const WAN = { latencyMs: 50, jitterMs: 10 };
const START = { 'building:builder_spawner': { 3: 1 }, 'building:research': { 3: 1 }, 'building:house': { 8: 1 }, 'building:healer_spawner': { 3: 1 }, 'building:barrack_norm': { 3: 1 }, 'building:barrack_tank': { 2: 1 }, 'building:spawner': { 2: 1 }, 'unit:builder_unit': { 3: 4 }, 'unit:researcher_unit': { 3: 3 }, 'unit:healer_unit': { 3: 4 }, 'unit:norm': { 3: 6 }, 'unit:king': { 1: 1 } };
(async () => {
    const BASE = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '30', 'cfg-map-type': 'arena', 'cfg-gold-count': '16', 'cfg-astar-mine-count': '10', 'cfg-starting-energy': '2000000', 'cfg-starting-astar': '2000000', 'cfg-max-pop': '5000' };
    const world = new H.World({ network: WAN, controls: BASE, hashEvery: 1, exactHashes: true });
    const res = await H.startHostedMatch(world, { guests: 1, hostSetup: `startingResourcesConfig = ${JSON.stringify({ spawnCounts: START, researchLevels: {} })};` });
    const all = [res.host, ...res.guests];
    const q = (inst, a) => inst.eval('queueAction(' + JSON.stringify(a) + ')');
    for (const inst of all) {
        const b = JSON.parse(inst.eval('JSON.stringify((b => ({ gx: b.gx, gy: b.gy }))(barracks.find(b => b.owner === localPlayerId && b.unitType === "norm")))'));
        const sp = JSON.parse(inst.eval('JSON.stringify((b => ({ gx: b.gx, gy: b.gy }))(collectorSpawners.find(b => b.owner === localPlayerId && b.type === "spawner")))'));
        q(inst, { action: 'queueUnit', gx: b.gx, gy: b.gy, count: 6 }); q(inst, { action: 'queueWorker', gx: sp.gx, gy: sp.gy, count: 4 });
    }
    const DUMP = `(() => { const S = _simUnitState, C = S.columns, out = {}; for (const u of units) { const s = u._si, o = {}; for (const k of SIM_UNIT_COLUMNS) o[k] = C[k][s]; for (const [k,,per] of SIM_MOVE_COLUMNS) o[k] = Array.from(C[k].subarray(s*per, s*per+per)).join(); const w = C.wkIx[s]; for (const [k] of SIM_UNIT_WK_SIDE) o['R.' + k] = C[k] ? C[k][w] : null; delete o.wkIx; out[u.id] = o; } (__scratch.d || (__scratch.d = {}))[currentTick] = JSON.stringify(out); })()`;
    for (let t = 55; t <= 70; t++) world.atTick(t, DUMP);
    await world.run(Number(process.env.RUNMS || 8000));
    const d = all.map(i => JSON.parse(i.eval('JSON.stringify(__scratch.d || {})')));
    for (let t = 55; t <= 70; t++) {
        if (!d[0][t] || !d[1][t]) continue;
        const a = JSON.parse(d[0][t]), b = JSON.parse(d[1][t]);
        const diffs = [];
        for (const id in a) { if (!b[id]) { diffs.push(id + ' missing on guest'); continue; } for (const k in a[id]) if (k !== 'esVer' && String(a[id][k]) !== String(b[id][k])) diffs.push(id + '.' + k + ' ' + a[id][k] + ' / ' + b[id][k]); }
        for (const id in b) if (!a[id]) diffs.push(id + ' missing on host');
        console.log('tick', t, diffs.length, diffs.slice(0, 12).join(' | '));
    }
    process.exit(0);
})();
