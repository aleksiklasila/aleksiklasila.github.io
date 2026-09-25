// Feature coverage in multiplayer, each with a behavioral check plus
// per-tick agreement of every peer: research queue add/remove/reorder, unit
// and worker queue +/-, traps applying their effects to enemies, healing,
// victory by killing the king, victory by resignations, and a second match
// after "Play Again".
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const WAN = { latencyMs: 50, jitterMs: 10 };
const BASE = {
    ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '30', 'cfg-map-type': 'arena', 'cfg-gold-count': '16', 'cfg-astar-mine-count': '10',
    'cfg-starting-energy': '2000000', 'cfg-starting-astar': '2000000', 'cfg-max-pop': '5000'
};
const START = {
    'building:builder_spawner': { 3: 1 }, 'building:research': { 3: 1 }, 'building:house': { 8: 1 }, 'building:healer_spawner': { 3: 1 },
    'building:barrack_norm': { 3: 1 }, 'building:barrack_tank': { 2: 1 }, 'building:spawner': { 2: 1 },
    'unit:builder_unit': { 3: 4 }, 'unit:researcher_unit': { 3: 3 }, 'unit:healer_unit': { 3: 4 }, 'unit:norm': { 3: 6 }, 'unit:king': { 1: 1 }
};

async function match({ guests = 1, teams = null, controls = {}, spawnCounts = START }) {
    const world = new H.World({ network: WAN, controls: { ...BASE, ...controls }, hashEvery: 1, exactHashes: true });
    const res = await H.startHostedMatch(world, { guests, teams, hostSetup: `startingResourcesConfig = ${JSON.stringify({ spawnCounts, researchLevels: {} })};` });
    return { world, ...res, all: [res.host, ...res.guests] };
}

function assertInSync(world, all, label, fromTick = 0, minCompared = 50) {
    for (const inst of all) assert.deepEqual(inst.errors.map(e => String(e.stack || e).slice(0, 400)), [], label + ': ' + inst.name + ' threw');
    const cmp = world.compareHashes(all, fromTick, 'tickExact');
    assert.equal(cmp.mismatches.length, 0, label + ': diverged ' + JSON.stringify(cmp.mismatches.slice(0, 3)));
    assert.ok(cmp.compared >= minCompared, label + ': compared ' + cmp.compared);
    for (const inst of all) assert.equal(inst.eval('netCounters.desyncsDetected'), 0, label + ': ' + inst.name + ' desynced');
}

const q = (inst, a) => inst.eval(`queueAction(${JSON.stringify(a)})`);
const own = (inst, expr) => JSON.parse(inst.eval(`JSON.stringify(${expr})`));
const labOf = inst => own(inst, `(s => ({ gx: s.gx, gy: s.gy }))(collectorSpawners.find(s => s.owner === localPlayerId && s.type === 'research'))`);

(async () => {
    const rows = [];

    // 1. Research queue: add, remove, reorder (up to the front / down).
    {
        const { world, host, guests, all } = await match({});
        const lab = labOf(host);
        const add = (key, statKey, count = 1) => q(host, { action: 'queueResearch', gx: lab.gx, gy: lab.gy, kind: 'unit', key, statKey, count });
        add('norm', 'atk'); add('norm', 'energy'); add('tank', 'speed'); add('fast', 'atk', 2);
        await world.run(1500);
        const queueOf = inst => own(inst, `(p => [p.researchTask && p.researchTask.key + '.' + p.researchTask.statKey, ...p.researchQueue.map(t => t.key + '.' + t.statKey)])(ensurePlayerResearchQueueState(localPlayerId))`);
        const before = queueOf(host);
        assert.equal(before.length, 5, 'five research entries: ' + before);
        q(host, { action: 'dequeueResearch', gx: lab.gx, gy: lab.gy, kind: 'unit', key: 'tank', statKey: 'speed', count: 1 });
        await world.run(1000);
        const removed = queueOf(host);
        assert.ok(!removed.includes('tank.speed'), 'removed: ' + removed);
        // Move the last queued item to the active slot, then one down.
        q(host, { action: 'reorderResearch', gx: lab.gx, gy: lab.gy, fromIndex: removed.length - 2, toIndex: 0, fromActive: false, toActive: true });
        await world.run(1000);
        const reordered = queueOf(host);
        assert.equal(reordered[0], removed[removed.length - 1], 'moved to the front: ' + reordered);
        q(host, { action: 'reorderResearch', gx: lab.gx, gy: lab.gy, fromIndex: 0, toIndex: 1, fromActive: false, toActive: false });
        await world.run(1000);
        assert.deepEqual(queueOf(guests[0].eval('localPlayerId') === host.eval('localPlayerId') ? guests[0] : host), queueOf(host));
        const hostTeam = host.eval('localPlayerId');
        assert.deepEqual(own(guests[0], `(p => [p.researchTask && p.researchTask.key, ...p.researchQueue.map(t => t.key)])(ensurePlayerResearchQueueState(${hostTeam}))`),
            own(host, `(p => [p.researchTask && p.researchTask.key, ...p.researchQueue.map(t => t.key)])(ensurePlayerResearchQueueState(${hostTeam}))`), 'guest sees the same queue');
        const researched = await world.runUntil(() => host.eval('Object.keys(players[localPlayerId].researchLevels || {}).length') > 0, 90000, 250);
        assert.ok(researched, 'research completed');
        assertInSync(world, all, 'research queue');
        rows.push(`research queue: add ${before.length}, remove 1, reorder to front and down; researched ${host.eval('Object.keys(players[localPlayerId].researchLevels || {}).length')} stats`);
    }

    // 2. Unit and worker queues: + and -, with the queue paused.
    {
        const { world, host, guests, all } = await match({});
        for (const inst of all) {
            const b = own(inst, `(b => ({ gx: b.gx, gy: b.gy }))(barracks.find(b => b.owner === localPlayerId && b.unitType === 'norm'))`);
            const s = own(inst, `(b => ({ gx: b.gx, gy: b.gy }))(collectorSpawners.find(b => b.owner === localPlayerId && b.type === 'spawner'))`);
            q(inst, { action: 'setQueueEnabled', gx: b.gx, gy: b.gy, enabled: false });
            q(inst, { action: 'setQueueEnabled', gx: s.gx, gy: s.gy, enabled: false });
            q(inst, { action: 'queueUnit', gx: b.gx, gy: b.gy, count: 6 });
            q(inst, { action: 'queueWorker', gx: s.gx, gy: s.gy, count: 4 });
            inst.scratch.b = b; inst.scratch.s = s;
        }
        await world.run(1500);
        const lens = inst => own(inst, `[getBarrackAtTile(__scratch.b.gx, __scratch.b.gy).spawnQueue.length, getSpawnerAtTile(__scratch.s.gx, __scratch.s.gy).spawnQueue.length]`);
        for (const inst of all) assert.deepEqual(lens(inst), [6, 4], inst.name + ' queued');
        for (const inst of all) {
            q(inst, { action: 'dequeueUnit', gx: inst.scratch.b.gx, gy: inst.scratch.b.gy, count: 2 });
            q(inst, { action: 'dequeueWorker', gx: inst.scratch.s.gx, gy: inst.scratch.s.gy, count: 3 });
        }
        await world.run(1500);
        for (const inst of all) assert.deepEqual(lens(inst), [4, 1], inst.name + ' dequeued');
        const unitsBefore = host.eval('units.length');
        for (const inst of all) {
            q(inst, { action: 'setQueueEnabled', gx: inst.scratch.b.gx, gy: inst.scratch.b.gy, enabled: true });
            q(inst, { action: 'setQueueEnabled', gx: inst.scratch.s.gx, gy: inst.scratch.s.gy, enabled: true });
        }
        await world.run(30000);
        assert.ok(host.eval('units.length') > unitsBefore, 'production resumed');
        assertInSync(world, all, 'queues');
        rows.push(`unit/worker queues: +6/+4, -2/-3, paused and resumed (${host.eval('units.length') - unitsBefore} units produced)`);
    }

    // 3. Traps: completed traps in the path of enemy units apply their effects.
    {
        const { world, host, guests, all } = await match({ spawnCounts: { ...START, 'unit:norm': { 3: 10 } } });
        const hostTeam = host.eval('localPlayerId');
        const guestKing = own(guests[0], `(u => ({ x: u.x, y: u.y }))(units.find(u => u.owner === localPlayerId && u.isKing))`);
        const hostKing = own(host, `(u => ({ x: u.x, y: u.y }))(units.find(u => u.owner === localPlayerId && u.isKing))`);
        // A line of finished traps around the host's base, placed on every peer at the same tick.
        world.atNextSafeTick(`(() => {
            const kx = Math.floor(${hostKing.x} / TILE), ky = Math.floor(${hostKing.y} / TILE);
            // Closed rings, so attackers must cross every kind of trap
            // (pathfinding otherwise routes around them).
            const ringTypes = { 2: ['sand', 'water_puddle'], 3: ['ice_patch', 'poison_puddle'], 4: ['lava', 'mine'] };
            let n = 0;
            for (let r = 2; r <= 4; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const gx = kx + dx, gy = ky + dy;
                if (gx < 1 || gy < 1 || gx >= GRID_W - 1 || gy >= GRID_H - 1 || grid[gy][gx].type === TYPE_WALL || grid[gy][gx].item || getTileEntityRef(gx, gy)) continue;
                const type = ringTypes[r][(dx + dy + 100) % 2];
                if (!placeBuilding(gx, gy, type, ${hostTeam}, { ignorePlacementRules: true, silent: true, autoUpgradeEnabled: false, buildEnabled: true })) continue;
                const it = grid[gy][gx].item;
                if (it) { it.underConstruction = false; it.energy = it.maxEnergy; it.level = 1; }
                n++;
            }
        })()`);
        await world.run(3000);
        const trapCount = host.eval(`getCellItemsRowMajor().filter(i => ['sand','lava','poison_puddle','ice_patch','water_puddle','mine'].includes(i.type) && !i.underConstruction).length`);
        assert.ok(trapCount >= 12, 'traps placed: ' + trapCount);
        // One held enemy unit on one trap of each kind, set on every peer at
        // the same tick; the next ticks must apply that trap's effect.
        const guestTeam = guests[0].eval('localPlayerId');
        const kinds = ['sand', 'water_puddle', 'ice_patch', 'poison_puddle', 'lava', 'mine'];
        const effectOf = { sand: 'sandy', water_puddle: 'wet', ice_patch: 'frozen', poison_puddle: 'poisoned', lava: 'burning' };
        const probeTick = world.atNextSafeTick(`(() => {
            const traps = getCellItemsRowMajor().filter(i => i.owner === ${hostTeam});
            const probes = units.filter(u => u.owner === ${guestTeam} && !u.isKing && !u.workerState && !u.dead);
            __scratch.probe = {};
            ${JSON.stringify(kinds)}.forEach((kind, i) => {
                const t = traps.find(x => x.type === kind), u = probes[i];
                if (!t || !u) return;
                removeUnitSpatial(u); u.x = u.prevX = t.gx * TILE + 16; u.y = u.prevY = t.gy * TILE + 16; updateUnitSpatial(u);
                u.path = null; u.commandState = CMD_IDLE; u.holdPosition = true; u.energy = u.maxEnergy || u.energy;
                __scratch.probe[kind] = { id: u.id, gx: t.gx, gy: t.gy };
            });
        })()`);
        await world.runUntil(() => host.eval('currentTick') > probeTick + 3, 5000, 10);
        const probes = host.scratch.probe;
        const seen = {};
        for (const kind of Object.keys(effectOf)) {
            assert.ok(probes[kind], 'probe placed on ' + kind);
            seen[kind] = host.eval(`(u => u ? u.${effectOf[kind]} : -1)(units.find(u => u.id === ${probes[kind].id}))`);
            assert.ok(seen[kind] > 0, `${kind} applies ${effectOf[kind]}: ${seen[kind]}`);
        }
        assert.ok(probes.mine, 'probe placed on mine');
        assert.equal(host.eval(`(g => !!(g && g.item && g.item.type === 'mine'))(grid[${probes.mine.gy}][${probes.mine.gx}])`), false, 'mine exploded');
        // Then an ordinary assault through the rings.
        const attackers = own(guests[0], `units.filter(u => u.owner === localPlayerId && !u.isKing && !u.workerState && !u.dead).map(u => u.id)`);
        q(guests[0], { action: 'stop', unitIds: attackers });
        q(guests[0], { action: 'attackMove', unitIds: attackers, targetX: hostKing.x, targetY: hostKing.y });
        await world.run(20000);
        assertInSync(world, all, 'traps');
        rows.push(`traps: ${trapCount} traps; sand/water/ice/poison/lava applied their effects and a mine exploded`);
    }

    // 4. Healing: a damaged building is repaired by healers.
    {
        const { world, host, guests, all } = await match({});
        const hostTeam = host.eval('localPlayerId');
        const b = own(host, `(b => ({ gx: b.gx, gy: b.gy }))(barracks.find(b => b.owner === localPlayerId))`);
        const t = world.atNextSafeTick(`(() => { const b = getBarrackAtTile(${b.gx}, ${b.gy}); b.energy = Math.max(1, Math.floor(b.maxEnergy * 0.25)); })()`);
        await world.runUntil(() => host.eval('currentTick') > t + 2, 5000);
        const damaged = host.eval(`getBarrackAtTile(${b.gx}, ${b.gy}).energy`);
        await world.run(30000);
        const healed = host.eval(`getBarrackAtTile(${b.gx}, ${b.gy}).energy`);
        assert.ok(healed > damaged, `healed ${damaged} -> ${healed}`);
        assertInSync(world, all, 'healing');
        rows.push(`healing: damaged barrack ${Math.round(damaged)} -> ${Math.round(healed)} energy`);
    }

    // 5. Kill-king victory ends the match at the same tick everywhere; then
    // the host returns everyone to the lobby and a second match runs.
    {
        const { world, host, guests, all } = await match({ guests: 2, teams: [0, 1, 2], controls: { 'cfg-gamemode': 'killking' } });
        const g0Team = guests[0].eval('localPlayerId'), g1Team = guests[1].eval('localPlayerId');
        world.atNextSafeTick(`(() => { for (const u of units) if (u.isKing && (u.owner === ${g0Team} || u.owner === ${g1Team})) { u.energy = 0; u.dead = true; } })()`);
        await world.runUntil(() => all.every(i => i.eval('gameOver')), 10000);
        const over = all.map(i => [i.eval('winner'), i.eval('gameTime')]);
        assert.ok(over.every(o => o[0] === host.eval('localPlayerId')), 'host wins everywhere: ' + JSON.stringify(over));
        assert.ok(over.every(o => o[1] === over[0][1]), 'ended on the same tick: ' + JSON.stringify(over));
        for (const g of guests) assert.equal(g.eval('localDefeated'), true, 'losers see defeat');
        assertInSync(world, all, 'victory');
        host.eval('hostPlayAgain()');
        await world.runUntil(() => guests.every(g => !g.eval('gameStarted')), 5000);
        host.eval('startHostedGame()');
        const again = await world.runUntil(() => all.every(i => i.eval('gameStarted') && !i.eval('matchStartWaitingForReady') && !i.eval('gameOver')) && host.eval('currentTick') > 40, 20000);
        assert.ok(again, 'second match started for everyone');
        const fromTick = host.eval('currentTick');
        await H.playFor(world, all, 8000, { seed: 5 });
        await world.run(2000);
        const cmp = world.compareHashes(all, fromTick, 'tickExact');
        assert.equal(cmp.mismatches.length, 0, 'second match in sync');
        for (const inst of all) assert.equal(inst.eval('netCounters.desyncsDetected'), 0, 'second match: ' + inst.name + ' desynced');
        rows.push(`kill-king victory at the same tick on all peers, defeat shown to losers, second match after Play Again in sync`);
    }

    // 6. Destroy mode: the last team standing after resignations wins.
    {
        const { world, host, guests, all } = await match({ guests: 2, teams: [0, 1, 2] });
        for (const g of guests) g.eval(`queueAction({ action: 'resign' }); enterSpectateMode('defeated'); connections[0].send({ type: 'MATCH_ROLE_UPDATE', role: 'spectating' });`);
        await world.runUntil(() => all.every(i => i.eval('gameOver')), 10000);
        assert.ok(all.every(i => i.eval('winner') === host.eval('localPlayerId')), 'host wins after both resign');
        assertInSync(world, all, 'resign victory', 0, 10);
        rows.push('destroy mode: two resignations leave the host as winner on every peer');
    }

    console.log('PASS: multiplayer features\n  ' + rows.join('\n  '));
})().catch(err => { console.error(err); process.exit(1); });
