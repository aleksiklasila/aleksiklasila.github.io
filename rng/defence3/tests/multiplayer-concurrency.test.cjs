// Several players acting on exactly the same tick, within a team (sharing
// units, buildings and research) and across teams (contesting tiles, mines
// and targets). Every case must resolve identically on every peer; the
// bit-exact state fingerprint is compared on every tick.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const C = require('./multiplayer-chaos-determinism.test.cjs');

const CONTROLS = {
    ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '30', 'cfg-map-type': 'arena', 'cfg-gold-count': '20', 'cfg-astar-mine-count': '12',
    'cfg-starting-energy': '3000000', 'cfg-starting-astar': '3000000', 'cfg-max-pop': '5000'
};
const START = {
    'building:builder_spawner': { 3: 1 }, 'building:research': { 3: 1 }, 'building:house': { 8: 1 }, 'building:healer_spawner': { 3: 1 },
    'building:barrack_norm': { 3: 1 }, 'building:spawner': { 3: 1 }, 'building:pistol': { 3: 2 },
    'unit:builder_unit': { 3: 4 }, 'unit:researcher_unit': { 3: 2 }, 'unit:healer_unit': { 3: 2 }, 'unit:collector': { 3: 4 },
    'unit:norm': { 4: 8 }, 'unit:fast': { 2: 4 }, 'unit:king': { 1: 1 }
};

(async () => {
    const rows = [];
    // 2v2: host and guest2 share team A, guest1 and guest3 share team B.
    const world = new H.World({ network: { latencyMs: 70, jitterMs: 40 }, controls: CONTROLS, hashEvery: 1, exactHashes: true });
    const { host, guests } = await H.startHostedMatch(world, { guests: 3, teams: [0, 1, 0, 1], hostSetup: `startingResourcesConfig = ${JSON.stringify({ spawnCounts: START, researchLevels: {} })};` });
    const all = [host, ...guests];
    const [gB1, gA2, gB2] = guests;
    const own = (inst, expr) => JSON.parse(inst.eval(`JSON.stringify(${expr})`));
    const future = (lead = 60) => Math.max(...all.map(i => i.eval('currentTick'))) + lead;
    const runPast = async t => { assert.ok(await world.runUntil(() => all.every(i => i.eval('currentTick') > t + 2), 15000, 20), 'reached tick ' + t); };
    // Evaluate `expr` on every peer right after the same tick and compare.
    const sameAt = async (tick, expr, label) => {
        world.atTick(tick, `__scratch.view = JSON.stringify(${expr})`);
        await runPast(tick);
        const v = all.map(i => i.scratch.view);
        assert.ok(v.every(x => x === v[0]), label + ': ' + v.map(x => String(x).slice(0, 120)).join(' | '));
        return v[0];
    };
    const teamUnits = (inst, filter = '!u.isKing && !u.workerState') => own(inst, `units.filter(u => u.owner === localPlayerId && !u.dead && ${filter}).map(u => u.id)`);

    // 1. Teammates give the same units different orders on the same tick.
    {
        const ids = teamUnits(host);
        const T = future();
        host.queueAt(T, { action: 'move', unitIds: ids, targetX: 5 * 32 + 16, targetY: 5 * 32 + 16 });
        gA2.queueAt(T, { action: 'attackMove', unitIds: ids, targetX: 25 * 32 + 16, targetY: 25 * 32 + 16 });
        gA2.queueAt(T, { action: 'hold', unitIds: ids.slice(0, 2) });
        host.queueAt(T, { action: 'stop', unitIds: ids.slice(0, 2) });
        await runPast(T);
        const views = all.map(i => i.eval(`JSON.stringify(units.filter(u => ${JSON.stringify(ids)}.includes(u.id)).map(u => [u.id, u.commandState, !!u.holdPosition, u.targetPos && Math.round(u.targetPos.x)]))`));
        assert.ok(views.every(v => v === views[0]), 'same resolution everywhere');
        rows.push('teammates ordering the same units on one tick');
    }

    // 2. Teammates build on the same tile on the same tick: same type stacks,
    // different types -> the first applied wins, identically everywhere.
    {
        const tiles = own(host, `(() => { const k = units.find(u => u.owner === localPlayerId && u.isKing); const out = []; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const gx = Math.floor(k.x / TILE) + dx, gy = Math.floor(k.y / TILE) + dy; if (gx > 0 && gy > 0 && gx < GRID_W - 1 && gy < GRID_H - 1 && grid[gy][gx].type !== TYPE_WALL && !grid[gy][gx].item && !getTileEntityRef(gx, gy) && !getGoldMineAt(gx, gy) && !getAstarMineAt(gx, gy)) out.push({ gx, gy }); } return out.slice(0, 4); })()`);
        assert.ok(tiles.length >= 3);
        const T = future();
        host.queueAt(T, { action: 'place', gx: tiles[0].gx, gy: tiles[0].gy, itemType: 'pistol', count: 1, autoUpgradeEnabled: true, buildEnabled: true });
        gA2.queueAt(T, { action: 'place', gx: tiles[0].gx, gy: tiles[0].gy, itemType: 'pistol', count: 2, autoUpgradeEnabled: false, buildEnabled: true });
        host.queueAt(T, { action: 'place', gx: tiles[1].gx, gy: tiles[1].gy, itemType: 'barrack_fast', count: 1, autoUpgradeEnabled: true, buildEnabled: true });
        gA2.queueAt(T, { action: 'place', gx: tiles[1].gx, gy: tiles[1].gy, itemType: 'sand', count: 1, autoUpgradeEnabled: true, buildEnabled: true });
        // An opponent tries the same tile on the same tick.
        gB1.queueAt(T, { action: 'place', gx: tiles[2].gx, gy: tiles[2].gy, itemType: 'lava', count: 1, autoUpgradeEnabled: true, buildEnabled: true });
        host.queueAt(T, { action: 'place', gx: tiles[2].gx, gy: tiles[2].gy, itemType: 'smg', count: 1, autoUpgradeEnabled: true, buildEnabled: true });
        await runPast(T);
        const view = i => i.eval(`JSON.stringify(${JSON.stringify(tiles.slice(0, 3))}.map(t => (e => e && [e.type, e.owner, e.manualStacks, e.autoUpgradeEnabled])(getTileEntityRef(t.gx, t.gy))))`);
        const v0 = view(host);
        assert.ok(all.every(i => view(i) === v0), 'same buildings everywhere: ' + v0);
        assert.equal(JSON.parse(v0)[0][2], 3, 'same-type placements stacked');
        rows.push('teammates and an opponent building on the same tiles on one tick');
    }

    // 3. Teammates operate one research lab on the same tick.
    {
        const lab = own(host, `(s => ({ gx: s.gx, gy: s.gy }))(collectorSpawners.find(s => s.owner === localPlayerId && s.type === 'research'))`);
        let T = future();
        host.queueAt(T, { action: 'queueResearch', gx: lab.gx, gy: lab.gy, kind: 'unit', key: 'norm', statKey: 'atk', count: 2 });
        gA2.queueAt(T, { action: 'queueResearch', gx: lab.gx, gy: lab.gy, kind: 'unit', key: 'fast', statKey: 'speed', count: 2 });
        gA2.queueAt(T, { action: 'queueResearch', gx: lab.gx, gy: lab.gy, kind: 'building', key: 'pistol', statKey: 'damage', count: 1 });
        await runPast(T);
        T = future();
        host.queueAt(T, { action: 'reorderResearch', gx: lab.gx, gy: lab.gy, fromIndex: 3, toIndex: 0, fromActive: false, toActive: true });
        gA2.queueAt(T, { action: 'dequeueResearch', gx: lab.gx, gy: lab.gy, kind: 'unit', key: 'norm', statKey: 'atk', count: 1 });
        gA2.queueAt(T, { action: 'setAutoResearch', gx: lab.gx, gy: lab.gy, enabled: false });
        host.queueAt(T, { action: 'setAutoResearch', gx: lab.gx, gy: lab.gy, enabled: true });
        await runPast(T);
        const team = host.eval('localPlayerId');
        const view = i => i.eval(`JSON.stringify((p => [p.researchTask && p.researchTask.key + p.researchTask.statKey, p.researchQueue.map(t => t.key + t.statKey)])(ensurePlayerResearchQueueState(${team})))`);
        assert.ok(all.every(i => view(i) === view(host)), 'same research queue everywhere');
        rows.push('teammates adding, removing and reordering research on one tick');
    }

    // 4. Both teams send collectors to the same mine, and teammates assign
    // the same builders to different targets, on the same tick.
    {
        const mine = own(host, `(m => ({ gx: m.gx, gy: m.gy }))(goldMines.find(m => m.gold > 0))`);
        const T = future();
        for (const inst of all) {
            const collectors = teamUnits(inst, "u.workerType === 'collector'");
            inst.queueAt(T, { action: 'workerAssign', unitIds: collectors, targetType: 'mine', targetGx: mine.gx, targetGy: mine.gy });
        }
        const builders = teamUnits(host, "u.workerType === 'builder'");
        const sites = own(host, `[...towers, ...barracks, ...collectorSpawners, ...getCellItemsRowMajor()].filter(b => b.owner === localPlayerId && (b.underConstruction || b.isUpgrading)).map(b => ({ gx: b.gx, gy: b.gy }))`);
        if (sites.length >= 1) {
            host.queueAt(T, { action: 'workerAssign', unitIds: builders, targetType: 'build', targetGx: sites[0].gx, targetGy: sites[0].gy });
            gA2.queueAt(T, { action: 'workerAssign', unitIds: builders, targetType: 'build', targetGx: sites[sites.length - 1].gx, targetGy: sites[sites.length - 1].gy });
        }
        await sameAt(T + 100, `units.filter(u => u.workerState).map(u => [u.id, u.workerState, u.workerTarget ? u.workerTarget.gx + ',' + u.workerTarget.gy : null])`, 'same worker assignments everywhere');
        rows.push('both teams contesting one mine and teammates reassigning the same builders on one tick');
    }

    // 5. Split/merge the same group while a teammate orders it and an enemy
    // kills part of it, all on one tick.
    {
        const ids = teamUnits(host, "!u.isKing && !u.workerState && u.unitType === 'norm'");
        const enemyTeam = gB1.eval('localPlayerId');
        const T = future();
        host.queueAt(T, { action: 'resizeUnitGroup', unitIds: ids, mode: 'x2', unitType: 'norm' });
        gA2.queueAt(T, { action: 'move', unitIds: ids, targetX: 15 * 32, targetY: 15 * 32 });
        gA2.queueAt(T, { action: 'killUnit', unitId: ids[0] });
        gB1.queueAt(T, { action: 'attack', unitIds: teamUnits(gB1), targetId: ids[1], targetX: 0, targetY: 0 });
        host.queueAt(T, { action: 'resizeUnitGroup', unitIds: ids, mode: 'd2', unitType: 'norm' });
        await sameAt(T + 60, `units.filter(u => u.unitType === 'norm').map(u => [u.id, u.owner, u.stackCount, u.energy, u.x, u.y])`, 'same units everywhere');
        assert.ok(enemyTeam !== host.eval('localPlayerId'));
        rows.push('split, merge, move, kill and enemy attack on the same group on one tick');
    }

    // 6. Bursts: every player fires 40 random commands of every kind at the
    // same tick, several times.
    {
        let s = 4711;
        const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        for (let burst = 0; burst < 4; burst++) {
            const T = future(50);
            for (const inst of all) {
                // Generate with the chaos generator, then move each command to tick T.
                const before = inst.eval('JSON.stringify(Object.keys(localInputBuffer))');
                for (let k = 0; k < 40; k++) inst.eval(C.CHAOS_COMMAND + '(' + rand() + ')');
                inst.eval(`(() => {
                    const keep = new Set(${before});
                    const moved = [];
                    for (const key of Object.keys(localInputBuffer)) {
                        if (keep.has(key) || Number(key) >= ${T}) continue;
                        if (Number(key) <= lockstepHighestSentLocalTick && !isHost) continue;
                        moved.push(...localInputBuffer[key]);
                        delete localInputBuffer[key];
                        delete lockstepLocalPacketByTick[key];
                        if (isHost && lockstepHostPacketsByTick[key] && myPeerId) delete lockstepHostPacketsByTick[key][myPeerId];
                    }
                    (localInputBuffer[${T}] ||= []).push(...moved);
                    delete lockstepLocalPacketByTick[${T}];
                })()`);
            }
            await runPast(T);
            await world.run(1500);
        }
        rows.push('4 bursts of 40 simultaneous commands from each of 4 players');
    }

    await world.run(5000);
    for (const inst of all) {
        assert.deepEqual(inst.errors.map(e => String(e.stack || e).slice(0, 400)), [], inst.name + ' threw');
        assert.equal(inst.eval('netCounters.desyncsDetected'), 0, inst.name + ' desynced');
        assert.equal(inst.snapshotsApplied, 1, inst.name + ' resynced');
    }
    const cmp = world.compareHashes(all, 0, 'tickExact');
    assert.equal(cmp.mismatches.length, 0, 'diverged: ' + JSON.stringify(cmp.mismatches.slice(0, 3)));
    console.log(`PASS: concurrency (${cmp.compared} bit-exact tick comparisons)\n  ` + rows.join('\n  '));
})().catch(err => { console.error(err); process.exit(1); });
