// Every kind of state a determinism bug could leave different on one peer,
// in the middle of a busy four-player match: units (position, energy,
// orders, path, target, worker cargo, membership), buildings (energy,
// level, timers, membership), grid cells, the worker reservation table,
// list order, players (resources, research), globals (random state, unit
// ids, adjacency, areas), mines, dropped items and projectiles. Each one is
// detected and repaired on that guest alone, without a match-wide resync,
// and afterwards every peer holds exactly the same state (every region
// hashed at once, and the bit-exact fingerprint on every tick).
//
// Usage: node tests/multiplayer-corruption-fuzz.test.cjs [kind,kind,...]
const assert = require('node:assert/strict');
const C = require('./multiplayer-chaos-determinism.test.cjs');

// Each returns a short description of what it changed, or '' when there
// was nothing to change (then it is skipped).
const KINDS = {
    unitMove: `(() => { const u = units.find(u => !u.dead && !u.isKing); if (!u) return ''; u.x += 9; return 'u' + u.id + ' moved'; })()`,
    unitEnergy: `(() => { const u = units.filter(u => !u.dead)[7]; if (!u) return ''; u.energy = Math.max(1, u.energy - 3); return 'u' + u.id + ' energy'; })()`,
    unitOrders: `(() => { const u = units.filter(u => !u.dead && !u.workerState)[3]; if (!u) return ''; u.commandState = CMD_HOLDING; u.holdPosition = true; return 'u' + u.id + ' holds'; })()`,
    unitPath: `(() => { const u = units.find(u => !u.dead && u.path && u.path.length > 2); if (!u) return ''; u.path = null; u.pathIndex = 0; return 'u' + u.id + ' path dropped'; })()`,
    unitTarget: `(() => { const u = units.find(u => !u.dead && !u.workerState && !u.targetUnit); const e = u && units.find(e => !e.dead && e.owner !== u.owner); if (!e) return ''; u.targetUnit = e; u.commandState = CMD_ATTACKING; return 'u' + u.id + ' attacks u' + e.id; })()`,
    workerCargo: `(() => { const u = units.find(u => !u.dead && u.workerState); if (!u) return ''; u.carryingValue = (u.carryingValue || 0) + 3; return 'u' + u.id + ' cargo'; })()`,
    unitGone: `(() => { const i = units.findIndex(u => !u.dead && !u.isKing && !u.workerState); if (i < 0) return ''; const u = units[i]; removeUnitSpatial(u); units.splice(i, 1); return 'u' + u.id + ' gone'; })()`,
    unitExtra: `(() => { const k = units.find(u => !u.dead && u.isKing); if (!k) return ''; const u = new Unit('norm', k.owner, k.x + 20, k.y); units.push(u); updateUnitSpatial(u); return 'extra u' + u.id; })()`,
    buildingEnergy: `(() => { const b = [...towers, ...barracks, ...collectorSpawners].find(b => b.energy > 10); if (!b) return ''; b.energy -= 5; return b.type + ' energy'; })()`,
    buildingLevel: `(() => { const b = barracks.find(b => b.level < 5); if (!b) return ''; b.level += 1; return 'barrack level'; })()`,
    buildingTimer: `(() => { const b = [...barracks, ...collectorSpawners].find(b => Number.isFinite(b.spawnTimer)); if (!b) return ''; b.spawnTimer += 7; return b.type + ' timer'; })()`,
    towerGone: `(() => { const i = towers.findIndex(t => t.energy > 0 && !t.underConstruction); if (i < 0) return ''; const t = towers[i]; towers.splice(i, 1); clearTileEntity(t.gx, t.gy, t); recalculateLaserConnections(); return 'tower gone at ' + t.gx + ',' + t.gy; })()`,
    cellOwner: `(() => { const s = collectorSpawners.find(s => s.owner >= 0); if (!s) return ''; grid[s.gy][s.gx].owner = -1; return 'cell owner at ' + s.gx + ',' + s.gy; })()`,
    cellType: `(() => { for (let gy = 2; gy < GRID_H; gy += 3) for (let gx = 2; gx < GRID_W; gx += 3) { const c = grid[gy][gx]; if (!c.item && !getTileEntityRef(gx, gy) && c.type !== TYPE_WALL) { c.type = TYPE_WALL; return 'wall at ' + gx + ',' + gy; } } return ''; })()`,
    reservation: `(() => { const w = units.find(u => !u.dead && u.workerType); if (!w) return ''; for (let s = 5; s < workerReservedTiles.length; s += 97) if (!workerReservedTiles[s]) { workerReservedTiles[s] = w; return 'reservation ' + s + ' -> u' + w.id; } return ''; })()`,
    reservationDrop: `(() => { const s = workerReservedTiles.findIndex(u => u); if (s < 0) return ''; workerReservedTiles[s] = null; return 'reservation ' + s + ' dropped'; })()`,
    towerOrder: `(() => { if (towers.length < 4) return ''; const a = towers[1]; towers[1] = towers[towers.length - 2]; towers[towers.length - 2] = a; return 'tower order'; })()`,
    playerEnergy: `(addPlayerResource(1, 'energy', -321), 'player energy')`,
    playerResearch: `(() => { const t = RESEARCH_THINGS.find(t => t.kind === 'unit' && t.key === 'norm'); if (!t) return ''; applyResearchCompletion(2, { kind: t.kind, key: t.key, statKey: t.stats[0].statKey }); return 'research ' + t.stats[0].statKey; })()`,
    rng: `(rng(), rng(), 'random state')`,
    unitIds: `(nextUnitId += 3, 'unit ids')`,
    adjacency: `(_adjacencyNeedsRecalc = true, _adjacencyDirtyAll = true, 'adjacency pass')`,
    area: `(() => { const a = (areas || []).find(a => a && a.cells && a.cells.length > 0); if (!a) return ''; a.multiplierLevel = (a.multiplierLevel || 0) + 1; return 'area level'; })()`,
    mine: `(() => { const m = goldMines.find(m => m.gold > 100) || astarMines.find(m => m.astar > 100); if (!m) return ''; if (m.gold > 100) m.gold -= 50; else m.astar -= 50; return 'mine'; })()`,
    drop: `(() => { const d = droppedItems[0]; if (!d) return ''; d.value += 5; return 'dropped item'; })()`,
    projectile: `(() => { const p = projectiles[0]; if (!p) return ''; p.x += 13; return 'projectile'; })()`
};

// Kinds whose effect spreads to a whole team at once (a patch of much of
// the map or a full one is fine for these).
const BROAD = new Set(['playerResearch', 'adjacency', 'unitIds', 'rng']);

(async () => {
    const pick = process.argv[2] ? process.argv[2].split(',') : Object.keys(KINDS);
    const { world, host, guests, all } = await C.setupChaosWorld('crossroads', 9091, { teams: [0, 1, 2, 3], exactHashes: true, network: { latencyMs: 60, jitterMs: 15 } });
    let s = 4242;
    const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const play = async ms => { const end = world.now + ms; while (world.now < end) { for (const i of all) if (rand() < 0.5) i.eval(C.CHAOS_COMMAND + '(' + rand() + ')'); await world.run(200); } };
    const idle = i => i.eval('isHost ? resyncHostPending.size === 0 : (resyncGuest.T < 0 && !resyncGuest.outstanding)');
    const repairs = i => i.patchesApplied + i.snapshotsApplied;
    await play(4000);

    // The whole state, every region at once, on every peer after one tick.
    const wholeState = async () => {
        for (const i of all) i.scratch.full = undefined;
        const at = world.atNextSafeTick(`__scratch.full = snapTickHash(currentTick, true).sum`, 20);
        await world.runUntil(() => all.every(i => i.eval('currentTick') > at + 1), 10000, 20);
        return all.map(i => i.scratch.full);
    };
    const same = sums => sums.every(x => x === sums[0] && x !== undefined);
    const rows = [];
    let k = 0;
    for (const kind of pick) {
        const victim = guests[k++ % guests.length];
        const before = all.map(repairs);
        const fullBefore = victim.fullPatchesApplied;
        const what = victim.eval(KINDS[kind]);
        if (!what) { rows.push(`${kind}: nothing to change, skipped`); continue; }
        const t0 = world.now;
        // Keep playing until the victim is patched and nothing is in flight
        // (or long enough that it would have been).
        let patchedAt = 0;
        while (world.now - t0 < 6000) {
            await play(400);
            if (repairs(victim) > before[all.indexOf(victim)] && all.every(idle)) { patchedAt = world.now; break; }
        }
        if (!patchedAt) {
            // Nothing noticed: then the next ticks overwrote it the same way
            // on every peer. An unnoticed difference would be the failure.
            await world.runUntil(() => all.every(idle), 10000, 20);
            const sums = await wholeState();
            assert.ok(same(sums), `${kind} (${what}) on ${victim.name}: never patched, and the state differs: ${sums}`);
            assert.equal(repairs(victim), before[all.indexOf(victim)], `${kind}: a late repair`);
            rows.push(`${kind} (${what}) on ${victim.name}: overwritten by the next ticks alike on every peer, no patch needed`);
            continue;
        }
        const patches = repairs(victim) - before[all.indexOf(victim)];
        const full = victim.fullPatchesApplied - fullBefore;
        all.forEach((i, j) => { if (i !== victim) assert.equal(repairs(i), before[j], `${kind}: ${i.name} was repaired too`); });
        assert.equal(victim.snapshotsApplied, 1, `${kind}: match-wide resync`);
        if (!BROAD.has(kind)) assert.ok(patches <= 2 && full === 0, `${kind} (${what}): ${patches} patches, ${full} full`);
        else assert.ok(patches <= 3, `${kind} (${what}): ${patches} patches`);
        await play(1500);
        const sums = await wholeState();
        assert.ok(same(sums), `${kind} (${what}) on ${victim.name}: state differs after the patch: ${sums}`);
        rows.push(`${kind} (${what}) on ${victim.name}: ${patches} patch${patches > 1 ? 'es' : ''}${full ? ` (${full} full)` : ''} after ${Math.round(patchedAt - t0)} ms, whole state equal`);
    }

    // Everything settled: the fingerprints agree on every tick since the
    // last repair, and the whole state once more.
    await play(3000);
    await world.run(2000);
    for (const i of all) assert.deepEqual(i.errors.map(e => String(e && e.stack || e).slice(0, 500)), [], i.name + ' threw');
    for (const i of all) assert.equal(i.eval('runtimeErrorCount'), 0, i.name + ' runtime errors');
    const sums = await wholeState();
    assert.ok(same(sums), 'whole state equal at the end: ' + sums);
    const lastRepair = Math.max(...all.map(i => i.lastSnapshotTick || 0));
    const cmp = world.compareHashes(all, lastRepair, 'tickExact');
    assert.equal(cmp.mismatches.length, 0, 'bit-exact after the last repair: ' + JSON.stringify(cmp.mismatches.slice(0, 3)));
    assert.ok(cmp.compared > 100, 'compared ' + cmp.compared);
    console.log('PASS: corruption fuzz\n  ' + rows.join('\n  ') + `\n  whole state equal on all ${all.length} peers afterwards; ${cmp.compared} exact fingerprints since the last repair`);
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
