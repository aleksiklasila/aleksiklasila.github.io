// Workers walk where they may and do their work (tests/oneofall.json: one of
// every building around each base, a builder, a healer). A multiplayer match
// (host + guest). One worker of every kind each base can make:
//  - walking: sent 10 tiles away in four directions in turn (a move order,
//    as a right-click), it must reach the target (within a tile) during the
//    move (it may go back to work after). Builders walk over their own
//    buildings, collectors over mines, flyers over anything (their walk
//    classes in the flow navigation: flownav.js navProfileOf). A builder
//    starts inside its base's ring of towers.
//  - working, left alone: collectors deliver loads, builders build (their
//    base's sites, repairs), a salvager takes down a building marked for it (in the
//    middle of the base), healers spend their loads (spawn queues, hurt
//    units), researchers research (research queued at the lab), collectors
//    collect from a mine in the middle of mines (walking over the others).
// Peers agree throughout (checkHealthy).
// Usage: node tests/worker-walk.test.cjs   (WALK_VERBOSE=1: per order)
const assert = require('node:assert/strict');
const path = require('node:path');
const H = require('./net-harness.cjs');
const data = require(path.join(__dirname, 'oneofall.json'));

(async () => {
    const controls = { ...H.SMALL_MATCH_CONTROLS };
    for (const [k, v] of Object.entries(data.lobby.numbers)) controls[k] = String(v);
    for (const [k, v] of Object.entries(data.lobby.selects)) controls[k] = String(v);
    const world = new H.World({ controls, network: { latencyMs: 20 } });
    const hostSetup = `
        startingResourcesConfig = normalizeStartingResourcesConfig(${JSON.stringify(data.startingResources)});
        applyMainMenuControlsToRuntimeState();
        applyEditableRuntimeConfigObject(${JSON.stringify(data.editableConfig)}, { fromTransport: true });`;
    const { host, guests } = await H.startHostedMatch(world, { guests: 1, controls, hostSetup, maxMs: 60000 });
    const all = [host, ...guests];
    const q = code => JSON.parse(host.evalSim(`JSON.stringify(${code})`));
    // A worker of every kind: one queued at each worker spawner of the host.
    host.eval(`(() => { for (const s of collectorSpawners) if (s.owner === localPlayerId && !s.underConstruction) queueAction({ action: 'queueWorker', gx: s.gx, gy: s.gy, count: 1 }); })()`);
    await world.run(15000);
    const workers = q(`units.filter(u => !u.dead && u.owner === 0 && u.workerType).map(u => ({ id: u.id, type: u.workerType }))`);
    const kinds = [...new Set(workers.map(w => w.type))];
    console.log('workers', workers.length, kinds.join(','));
    assert.ok(kinds.length >= 6, 'every kind of worker made: ' + kinds.join(','));
    const fails = [];
    const pos = id => q(`(() => { const u = units.find(x => x.id === ${id}); return u && !u.dead ? [Math.floor(u.x / TILE), Math.floor(u.y / TILE), u.workerState || ''] : null; })()`);
    for (const kind of kinds) {
        const w = workers.find(x => x.type === kind);
        for (const [dx, dy] of [[0, -10], [10, 0], [0, 10], [-10, 0]]) {
            const at = pos(w.id);
            if (!at) { fails.push(kind + ' died'); break; }
            // (A tile it can reach: one walkable for it may still lie in a
            // pocket closed to it, e.g. inside a ring of its base's towers;
            // ordered there, a unit rightly stops at the closest point.)
            const target = q(`(() => { const gx0 = Math.max(1, Math.min(GRID_W - 2, ${at[0] + dx})), gy0 = Math.max(1, Math.min(GRID_H - 2, ${at[1] + dy}));
                const u = units.find(x => x.id === ${w.id}), ux = Math.floor(u.x / TILE), uy = Math.floor(u.y / TILE), p = navProfileOf(u), from = uy * GRID_W + ux;
                let first = null;
                for (let r = 0; r <= 4; r++) for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
                    if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
                    const gx = Math.max(1, Math.min(GRID_W - 2, gx0 + ox)), gy = Math.max(1, Math.min(GRID_H - 2, gy0 + oy));
                    const t = findNearestWalkable(gx, gy, ux, uy, u);
                    if (!first) first = [t.x, t.y];
                    const ap = p >= 0 ? navApproachTile(p, t.y * GRID_W + t.x) : -1;
                    if (p < 0 || (ap >= 0 && navReachable(p, from, ap))) return [t.x, t.y];
                }
                return first; })()`);
            host.eval(`queueAction({ action: 'move', unitIds: [${w.id}], targetX: ${target[0] * 32 + 16}, targetY: ${target[1] * 32 + 16} })`);
            let best = Infinity, last = null;
            for (let k = 0; k < 40 && best > 1; k++) {
                await world.run(350);
                last = pos(w.id);
                if (!last) break;
                best = Math.min(best, Math.max(Math.abs(last[0] - target[0]), Math.abs(last[1] - target[1])));
            }
            if (process.env.WALK_VERBOSE) console.log(kind, [dx, dy], 'from', at.slice(0, 2), 'to', target, 'closest', best, 'last', last);
            if (best > 1) {
                // (The target tile and where the flow approaches it from the unit's tile.)
                const why = q(`(() => { const u = units.find(x => x.id === ${w.id}), t = ${JSON.stringify(target)}, p = u ? navProfileOf(u) : -1;
                    const at = u ? Math.floor(u.y / TILE) * GRID_W + Math.floor(u.x / TILE) : -1, ap = p >= 0 ? navApproachTile(p, t[1] * GRID_W + t[0]) : -1;
                    return { wall: grid[t[1]][t[0]].type === TYPE_WALL, entity: getTileEntityType(t[0], t[1]), profile: p, approach: ap >= 0 ? [ap % GRID_W, Math.floor(ap / GRID_W)] : null,
                        reachable: p >= 0 && ap >= 0 ? navReachable(p, at, ap) : null }; })()`);
                fails.push(`${kind} ${JSON.stringify([dx, dy])}: came no closer than ${best} tiles to ${JSON.stringify(target)} from ${JSON.stringify(at.slice(0, 2))} (last ${JSON.stringify(last)}; ${JSON.stringify(why)})`);
            }
            await world.run(500);
        }
    }
    // Work, left alone (orders stopped): the builder on the base's
    // construction sites (and one more placed for it), the salvager on a
    // tower marked for it (in the middle of the base: it walks over its own
    // buildings), research queued at the lab, the healers on spawn queues
    // and units hurt for them.
    const plan = q(`(() => {
        const b = collectorSpawners.find(s => s.owner === 0 && s.type === 'builder_spawner');
        let site = null;
        for (let d = 4; d < 12 && !site; d++) for (let k = 0; k < 8 * d && !site; k++) {
            const a = k / (8 * d) * Math.PI * 2, x = Math.round(b.gx + Math.cos(a) * d), y = Math.round(b.gy + Math.sin(a) * d);
            if (x < 2 || y < 2 || x >= GRID_W - 2 || y >= GRID_H - 2) continue;
            const c = grid[y][x]; if (c.type !== TYPE_FLOOR || c.item || getTileEntityRef(x, y)) continue;
            if (units.some(u => !u.dead && Math.floor(u.x / TILE) === x && Math.floor(u.y / TILE) === y)) continue;
            site = [x, y];
        }
        const salv = towers.find(t => t.owner === 0 && t.type === 'pistol' && !t.underConstruction);
        const lab = collectorSpawners.find(s => s.owner === 0 && s.type === 'research');
        return { site, salvage: salv ? [salv.gx, salv.gy] : null, lab: lab ? [lab.gx, lab.gy] : null };
    })()`);
    if (process.env.WALK_VERBOSE) console.log('work plan', JSON.stringify(plan));
    for (const kind of kinds) host.eval(`(() => { const ids = units.filter(u => !u.dead && u.owner === localPlayerId && u.workerType === ${JSON.stringify(kind)}).map(u => u.id); if (ids.length) queueAction({ action: 'stop', unitIds: ids }); })()`);
    if (plan.site) host.eval(`queueAction({ action: 'place', gx: ${plan.site[0]}, gy: ${plan.site[1]}, itemType: 'pistol', count: 1, buildEnabled: true })`);
    if (plan.salvage) host.eval(`queueAction({ action: 'markSalvage', gx: ${plan.salvage[0]}, gy: ${plan.salvage[1]} })`);
    if (plan.lab) host.eval(`queueAction({ action: 'queueResearch', gx: ${plan.lab[0]}, gy: ${plan.lab[1]}, kind: 'unit', key: 'norm', statKey: 'atk', count: 3 })`);
    // (Damage on every peer at one tick: half of the energy of the host's
    // first combat units.)
    world.atNextSafeTick(`(() => { let n = 0; for (const u of units) if (!u.dead && u.owner === 0 && !u.workerType && u.unitType !== 'king' && n < 4) { u.energy = Math.max(1, Math.floor(u.energy / 2)); n++; } })()`);
    // The work, measured: the energy of the owner's buildings (sites built,
    // damaged ones repaired: the fixture's start low; the salvager's target
    // left out), research work done (points and levels), the
    // healers' and builders' loads used up (their material: fetched at a
    // spawner, spent at the work), collectors' loads delivered.
    const progress = () => q(`(() => {
        let build = 0, sites = 0;
        for (const list of [towers, barracks, collectorSpawners]) for (const e of list) if (e.owner === 0 && !(${plan.salvage ? `e.gx === ${plan.salvage[0]} && e.gy === ${plan.salvage[1]}` : 'false'})) { if (e.underConstruction) sites++; build += Number(e.energy) || 0; }
        const t = getPlayerResearchTask(0), lv = players[0].researchLevels || {};
        let levels = 0; const walk = o => { for (const v of Object.values(o || {})) { if (typeof v === 'number') levels += v; else if (v && typeof v === 'object') walk(v); } }; walk(lv);
        return { build, sites, research: (t ? Number(t.workDone) || 0 : 0) + (Number(players[0].researchPoints) || 0) + levels * 1e6 };
    })()`);
    const before = progress();
    const seen = {}, mark = k => { seen[k] = true; };
    const last = new Map();
    for (let k = 0; k < 150; k++) {
        await world.run(300);
        const s = q(`units.filter(u => !u.dead && u.owner === 0 && u.workerType).map(u => [u.id, u.workerType, u.workerState || '', Number(u.carryingValue) || 0, (u.builderHasMaterial || u.healerHasMaterial) ? 1 : 0])`);
        for (const [id, type, state, c, m] of s) {
            mark(type + ':' + state);
            const prev = last.get(id);
            if (prev && prev[0] > 0 && c === 0) mark(type + ':delivered');
            if (prev && prev[1] && !m) mark(type + ':spent');
            last.set(id, [c, m]);
        }
    }
    const after = progress();
    const end = q(`(() => { const out = {};
        ${plan.site ? `const e = getTileEntityRef(${plan.site[0]}, ${plan.site[1]}); out.site = e ? { uc: !!e.underConstruction, energy: e.energy } : null;` : ''}
        ${plan.salvage ? `out.salvaged = !getTileEntityRef(${plan.salvage[0]}, ${plan.salvage[1]});` : ''}
        return out; })()`);
    console.log('worker states seen', Object.keys(seen).sort().join(' '));
    console.log('work', JSON.stringify({ before, after, end }));
    for (const c of ['collector', 'astar_collector']) if (kinds.includes(c) && !seen[c + ':delivered']) fails.push(c + ': delivered nothing');
    if (kinds.includes('builder') && !(after.build > before.build && seen['builder:spent'])) fails.push('builder: built nothing ' + JSON.stringify({ before, after }));
    if (kinds.includes('salvager') && plan.salvage && !end.salvaged) fails.push('salvager: the marked building still stands');
    if (kinds.includes('healer') && !seen['healer:spent'] && !seen['healer:HEALING']) fails.push('healer: never healed');
    if (kinds.includes('researcher') && plan.lab && !(after.research > before.research)) fails.push('researcher: never researched ' + JSON.stringify({ before, after }));
    // A mine in the middle of mines: a 3x3 of them near the base (made on
    // every peer at one tick), the middle a gold one, the ring ★ ones (both
    // a collector walks over). The energy collectors, sent to the middle one
    // (a right-click on it), must walk onto the ring to collect from it.
    if (kinds.includes('collector')) {
        const cl = q(`(() => {
            const s = collectorSpawners.find(x => x.owner === 0 && x.type === 'spawner');
            const free = (x, y) => x > 1 && y > 1 && x < GRID_W - 2 && y < GRID_H - 2 && grid[y][x].type === TYPE_FLOOR && !grid[y][x].item && !getTileEntityRef(x, y)
                && !units.some(u => !u.dead && Math.floor(u.x / TILE) === x && Math.floor(u.y / TILE) === y);
            for (let d = 4; d < 14; d++) for (let k = 0; k < 8 * d; k++) {
                const a = k / (8 * d) * Math.PI * 2, x = Math.round(s.gx + Math.cos(a) * d), y = Math.round(s.gy + Math.sin(a) * d);
                let ok = true;
                for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2 && ok; dx++) ok = free(x + dx, y + dy);
                if (ok) return [x, y];
            }
            return null;
        })()`);
        if (!cl) fails.push('mine cluster: no room near the base');
        else {
            world.atNextSafeTick(`(() => { const cx = ${cl[0]}, cy = ${cl[1]};
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                    const gx = cx + dx, gy = cy + dy, x = gx * TILE + 16, y = gy * TILE + 16;
                    if (dx === 0 && dy === 0) { const m = { gx, gy, gold: 5000, maxGold: 5000, x, y }; goldMines.push(m); setTileEntity(gx, gy, TILE_ENTITY_GOLDMINE, m); }
                    else { const m = { gx, gy, astar: 5000, maxAstar: 5000, x, y }; astarMines.push(m); setTileEntity(gx, gy, TILE_ENTITY_ASTARMINE, m); }
                    grid[gy][gx].type = TYPE_WALL; simMoveTileTypeChanged(gx, gy);
                } })()`);
            for (let k = 0; k < 40 && q(`!getGoldMineAt(${cl[0]}, ${cl[1]})`); k++) await world.run(250);
            host.eval(`(() => { const ids = units.filter(u => !u.dead && u.owner === localPlayerId && u.workerType === 'collector').map(u => u.id);
                queueAction({ action: 'workerAssign', unitIds: ids, targetType: 'mine', targetGx: ${cl[0]}, targetGy: ${cl[1]} }); })()`);
            let onRing = false, gold = 5000;
            for (let k = 0; k < 100 && gold >= 5000; k++) {
                await world.run(300);
                const st = q(`units.filter(u => !u.dead && u.owner === 0 && u.workerType === 'collector').map(u => [Math.floor(u.x / TILE), Math.floor(u.y / TILE)])`);
                for (const [x, y] of st) if (Math.max(Math.abs(x - cl[0]), Math.abs(y - cl[1])) <= 1) onRing = true;
                gold = q(`(() => { const m = getGoldMineAt(${cl[0]}, ${cl[1]}); return m ? m.gold : -1; })()`);
            }
            console.log('mine cluster at', JSON.stringify(cl), 'collector on it', onRing, 'middle gold', gold);
            if (!(onRing && gold < 5000)) fails.push(`collector: did not collect from the mine in the middle of mines (on it ${onRing}, its gold ${gold})`);
        }
    }
    H.checkHealthy(world, all, { minCompared: 20, label: 'worker walk' });
    if (fails.length) { console.log('FAIL:\n  ' + fails.join('\n  ')); process.exit(1); }
    console.log('PASS: worker walk and work', kinds.join(', '));
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
