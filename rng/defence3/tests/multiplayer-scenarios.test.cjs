// Focused multiplayer scenarios. Each sets up one mechanic, drives it with
// real commands from several players, checks the mechanic actually happened,
// and requires every peer to agree on the full state hash at every tick with
// no resync. Covered: building, stacking and auto-upgrades gated by research,
// area upgrades, collectors/salvagers/healers/researchers, production queues
// and rallies (including enemy-unit rallies seen by a spectator and a
// resigned player), splitting/merging, hold/stop, and combat.
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');

const WAN = { latencyMs: 60, jitterMs: 15 };
const CONTROLS = {
    ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '30', 'cfg-map-type': 'arena', 'cfg-gold-count': '24', 'cfg-astar-mine-count': '16',
    'cfg-starting-energy': '2000000', 'cfg-starting-astar': '2000000', 'cfg-max-pop': '5000', 'cfg-full-vis': 'team'
};

function setupCode(spawnCounts, researchLevels = {}) {
    return `startingResourcesConfig = ${JSON.stringify({ spawnCounts, researchLevels })};`;
}

async function match({ guests = 1, teams = null, spawnCounts, researchLevels = {}, network = WAN }) {
    const world = new H.World({ network, controls: CONTROLS, hashEvery: 1, recordParts: true });
    const res = await H.startHostedMatch(world, { guests, teams, hostSetup: setupCode(spawnCounts, researchLevels) });
    return { world, ...res, all: [res.host, ...res.guests] };
}

// Every peer agrees on every tick, no resync happened, nothing threw.
function assertLockstepClean(world, all, label, { snapshots = 1 } = {}) {
    for (const inst of all) {
        assert.deepEqual(inst.errors.map(e => String(e && e.stack || e).slice(0, 500)), [], label + ': ' + inst.name + ' threw');
    }
    const cmp = world.compareHashes(all.filter(i => !i.dead), 0);
    if (cmp.mismatches.length) {
        const m = cmp.mismatches[0];
        const a = all.find(i => i.name === m.a), b = all.find(i => i.name === m.b);
        const pa = a.tickParts.get(m.tick) || {}, pb = b.tickParts.get(m.tick) || {};
        assert.fail(`${label}: diverged at tick ${m.tick} (${m.a}/${m.b}) in [${Object.keys(pa).filter(k => pa[k] !== pb[k])}]`);
    }
    assert.ok(cmp.compared > 100, label + ': compared ' + cmp.compared);
    for (const inst of all) {
        assert.equal(inst.eval('netCounters.desyncsDetected'), 0, label + ': ' + inst.name + ' detected a desync');
        assert.equal(inst.snapshotsApplied, snapshots, label + ': ' + inst.name + ' snapshots');
    }
}

// Free buildable floor tiles around this player's king, nearest first.
function freeTilesNear(inst, count, skip = 0) {
    return JSON.parse(inst.eval(`(() => {
        const king = units.find(u => u.owner === localPlayerId && u.isKing);
        const kx = Math.floor(king.x / TILE), ky = Math.floor(king.y / TILE);
        const out = [];
        for (let r = 2; r < 12 && out.length < ${count + skip}; r++) {
            for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const gx = kx + dx, gy = ky + dy;
                if (gx < 1 || gy < 1 || gx >= GRID_W - 1 || gy >= GRID_H - 1) continue;
                const c = grid[gy][gx];
                if (c.type === TYPE_WALL || c.item || getTileEntityRef(gx, gy) || getGoldMineAt(gx, gy) || getAstarMineAt(gx, gy)) continue;
                if (!isTileActuallyVisibleToPlayer(localPlayerId, gx, gy)) continue;
                if (out.length < ${count + skip}) out.push({ gx, gy });
            }
        }
        return JSON.stringify(out.slice(${skip}));
    })()`));
}

const q = (inst, action) => inst.eval(`queueAction(${JSON.stringify(action)})`);
const thingAt = (inst, t) => JSON.parse(inst.eval(`JSON.stringify((() => { const e = getTileEntityRef(${t.gx}, ${t.gy}); return e ? { type: e.type, level: e.level, stacks: e.stacks, manualStacks: e.manualStacks, effectiveLevel: e.effectiveLevel, underConstruction: !!e.underConstruction, isUpgrading: !!e.isUpgrading } : null; })())`));

async function until(world, pred, maxMs, label) {
    const t0 = world.now;
    const ok = await world.runUntil(pred, maxMs, 100);
    assert.ok(ok, label + ' (waited ' + maxMs + 'ms)');
    return world.now - t0;
}

const ECONOMY = {
    'building:builder_spawner': { 3: 1 }, 'building:research': { 3: 1 }, 'building:house': { 8: 1 },
    'unit:builder_unit': { 3: 6 }, 'unit:researcher_unit': { 3: 4 }, 'unit:king': { 1: 1 }
};

(async () => {
    const rows = [];

    // A. Build, stack and upgrade, gated by the researched max level.
    {
        const { world, host, guests, all } = await match({ guests: 1, spawnCounts: ECONOMY });
        const plans = all.map(inst => {
            const [t1, t2, t3] = freeTilesNear(inst, 3);
            q(inst, { action: 'place', gx: t1.gx, gy: t1.gy, itemType: 'pistol', count: 5, autoUpgradeEnabled: true, buildEnabled: true });
            q(inst, { action: 'place', gx: t2.gx, gy: t2.gy, itemType: 'pistol', count: 5, autoUpgradeEnabled: true, buildEnabled: true });
            q(inst, { action: 'place', gx: t3.gx, gy: t3.gy, itemType: 'pistol', count: 1, autoUpgradeEnabled: true, buildEnabled: false });
            return { inst, t1, t2, t3 };
        });
        await world.run(1000);
        for (const p of plans) q(p.inst, { action: 'setAutoStack', gx: p.t2.gx, gy: p.t2.gy, enabled: false });
        const built = await until(world, () => plans.every(p => { const a = thingAt(p.inst, p.t1); return a && !a.underConstruction; }), 60000, 'builders finish the pistols');
        await world.run(5000);
        for (const p of plans) {
            const a = thingAt(p.inst, p.t1);
            assert.equal(a.stacks, 1, 'without research the stack stays at level 1');
            assert.ok(a.manualStacks >= 5, 'extra stacks are queued');
            assert.equal(thingAt(p.inst, p.t3).underConstruction, true, 'build-disabled pistol is not built');
        }
        // Research the pistol's max level; stacking resumes.
        for (const p of plans) {
            const lab = JSON.parse(p.inst.eval(`JSON.stringify((s => ({ gx: s.gx, gy: s.gy }))(collectorSpawners.find(s => s.owner === localPlayerId && s.type === 'research')))`));
            q(p.inst, { action: 'queueResearch', gx: lab.gx, gy: lab.gy, kind: 'building', key: 'pistol', statKey: 'maxLevel', count: 2 });
        }
        const researched = await until(world, () => plans.every(p => p.inst.eval(`getPlayerResearchLevel(localPlayerId, 'building', 'pistol', 'maxLevel')`) >= 1), 180000, 'research completes');
        const stacked = await until(world, () => plans.every(p => thingAt(p.inst, p.t1).stacks >= 2), 120000, 'stacking resumes after research');
        for (const p of plans) assert.equal(thingAt(p.inst, p.t2).stacks, 1, 'auto-stack off keeps the stack');
        assertLockstepClean(world, all, 'build/stack/research');
        rows.push(`build ${Math.round(built / 1000)}s, research ${Math.round(researched / 1000)}s, stack after research ${Math.round(stacked / 1000)}s; build/auto-stack toggles respected`);
    }

    // B. Area upgrade: fill an area, upgrade it, and see levels follow only
    // as far as research allows.
    {
        const { world, host, guests, all } = await match({
            guests: 1, spawnCounts: { ...ECONOMY, 'unit:builder_unit': { 3: 10 } },
            researchLevels: {}
        });
        // Pick a small area near the host's king that is completely free.
        const area = JSON.parse(host.eval(`(() => {
            const king = units.find(u => u.owner === localPlayerId && u.isKing);
            const kx = Math.floor(king.x / TILE), ky = Math.floor(king.y / TILE);
            let best = null;
            for (const a of areas) {
                const cells = _getCanonicalAreaCellsById(a.id, a);
                if (cells.length < 3 || cells.length > 14) continue;
                if (!cells.every(c => grid[c.y][c.x].type !== TYPE_WALL && !grid[c.y][c.x].item && !getTileEntityRef(c.x, c.y) && !getGoldMineAt(c.x, c.y) && !getAstarMineAt(c.x, c.y) && isTileActuallyVisibleToPlayer(localPlayerId, c.x, c.y))) continue;
                const d = Math.min(...cells.map(c => Math.abs(c.x - kx) + Math.abs(c.y - ky)));
                if (!best || d < best.d) best = { id: a.id, d, cells: cells.map(c => ({ gx: c.x, gy: c.y })) };
            }
            return JSON.stringify(best);
        })()`));
        assert.ok(area, 'found a free area near the base');
        for (const c of area.cells) q(host, { action: 'place', gx: c.gx, gy: c.gy, itemType: 'sand', count: 1, autoUpgradeEnabled: true, buildEnabled: true });
        const filled = await until(world, () => area.cells.every(c => { const t = thingAt(host, c); return t && !t.underConstruction; }), 120000, 'area filled and built');
        const c0 = area.cells[0];
        q(host, { action: 'place', gx: c0.gx, gy: c0.gy, itemType: 'area_upgrader', count: 1 });
        await until(world, () => all.every(i => i.eval(`(getAreaById(${area.id}) || {}).multiplierLevel || 0`) >= 1), 5000, 'area upgraded on every peer');
        await world.run(4000);
        const lifted = area.cells.map(c => thingAt(host, c)).filter(t => t.effectiveLevel > t.level).length;
        assert.ok(lifted > 0, 'area upgrade raises effective levels');
        assert.ok(area.cells.every(c => thingAt(host, c).level === 1), 'base levels wait for research');
        const lab = JSON.parse(host.eval(`JSON.stringify((s => ({ gx: s.gx, gy: s.gy }))(collectorSpawners.find(s => s.owner === localPlayerId && s.type === 'research')))`));
        q(host, { action: 'queueResearch', gx: lab.gx, gy: lab.gy, kind: 'building', key: 'sand', statKey: 'maxLevel', count: 1 });
        const upgraded = await until(world, () => area.cells.some(c => thingAt(host, c).level >= 2 || thingAt(host, c).isUpgrading), 240000, 'upgrades start once research allows');
        assertLockstepClean(world, all, 'area upgrade');
        rows.push(`area of ${area.cells.length} filled in ${Math.round(filled / 1000)}s, upgraded, base levels followed research after ${Math.round(upgraded / 1000)}s`);
    }

    // C. Collectors, astar collectors, salvagers and healers doing their jobs.
    {
        const { world, host, guests, all } = await match({
            guests: 1, spawnCounts: {
                ...ECONOMY, 'building:spawner': { 3: 1 }, 'building:astar_spawner': { 3: 1 }, 'building:salvager': { 3: 1 },
                'building:healer_spawner': { 3: 1 }, 'building:barrack_norm': { 2: 1 },
                'unit:collector': { 3: 4 }, 'unit:astar_collector': { 3: 3 }, 'unit:salvager_unit': { 3: 2 }, 'unit:healer_unit': { 3: 3 }
            }
        });
        const goldBefore = host.eval('goldMines.reduce((s, m) => s + m.gold, 0)');
        const astarBefore = host.eval('astarMines.reduce((s, m) => s + m.astar, 0)');
        const salvage = all.map(inst => { const [t] = freeTilesNear(inst, 1, 4); q(inst, { action: 'place', gx: t.gx, gy: t.gy, itemType: 'sand', count: 1, autoUpgradeEnabled: false, buildEnabled: true }); return { inst, t }; });
        const states = new Set();
        const seenStates = async ms => { const end = world.now + ms; while (world.now < end) { for (const s of JSON.parse(host.eval('JSON.stringify([...new Set(units.map(u => u.workerState).filter(Boolean))])'))) states.add(s); await world.run(500); } };
        await until(world, () => salvage.every(s => { const t = thingAt(s.inst, s.t); return t && !t.underConstruction; }), 60000, 'salvage target built');
        for (const s of salvage) q(s.inst, { action: 'setSalvage', gx: s.t.gx, gy: s.t.gy, marked: true });
        // Healers fund production queues.
        for (const inst of all) {
            const b = JSON.parse(inst.eval(`JSON.stringify((b => ({ gx: b.gx, gy: b.gy }))(barracks.find(b => b.owner === localPlayerId)))`));
            q(inst, { action: 'queueUnit', gx: b.gx, gy: b.gy, count: 4 });
            const lab = JSON.parse(inst.eval(`JSON.stringify((s => ({ gx: s.gx, gy: s.gy }))(collectorSpawners.find(s => s.owner === localPlayerId && s.type === 'research')))`));
            q(inst, { action: 'queueResearch', gx: lab.gx, gy: lab.gy, kind: 'unit', key: 'norm', statKey: 'atk', count: 2 });
            q(inst, { action: 'queueResearch', gx: lab.gx, gy: lab.gy, kind: 'unit', key: 'collector', statKey: 'gatherPerTrip', count: 1 });
            q(inst, { action: 'reorderResearch', gx: lab.gx, gy: lab.gy, fromIndex: 0, toIndex: 0, fromActive: false, toActive: true });
        }
        await seenStates(40000);
        assert.ok(host.eval('goldMines.reduce((s, m) => s + m.gold, 0)') < goldBefore, 'collectors mined gold');
        assert.ok(host.eval('astarMines.reduce((s, m) => s + m.astar, 0)') < astarBefore, 'A* collectors mined');
        await until(world, () => salvage.every(s => !thingAt(s.inst, s.t)), 60000, 'salvagers removed marked buildings');
        for (const s of ['MOVING_TO_HEAL', 'MOVING_TO_RESEARCH']) assert.ok(states.has(s), 'workers entered ' + s + ' (seen: ' + [...states] + ')');
        assertLockstepClean(world, all, 'workers');
        rows.push(`workers: mining, A* mining, salvage and healer/researcher trips (${states.size} worker states seen)`);
    }

    // D. Production queues and rallies with three teams; one player resigns
    // and one joins to spectate, so local full-visibility views exist while
    // rallies follow enemy units.
    {
        const world = new H.World({ network: WAN, controls: CONTROLS, hashEvery: 1, recordParts: true });
        const spawnCounts = { ...ECONOMY, 'building:healer_spawner': { 3: 1 }, 'unit:healer_unit': { 3: 4 }, 'building:barrack_fast': { 3: 2 }, 'building:barrack_norm': { 3: 1 }, 'unit:norm': { 2: 6 } };
        const { host, guests, hostId } = await H.startHostedMatch(world, { guests: 2, teams: [0, 1, 2], hostSetup: setupCode(spawnCounts) });
        const all = [host, ...guests];
        // A late visitor spectates the running match.
        const spec = world.spawn('spectator');
        spec.eval('loadOrCreateLocalIdentity()');
        spec.eval(`joinGame(${JSON.stringify(hostId)})`);
        await until(world, () => spec.eval('remoteMatchRunning'), 10000, 'spectator sees the running match');
        spec.eval('requestSpectateCurrentMatch()');
        await until(world, () => spec.eval('gameStarted') && !spec.eval('lockstepResyncPauseActive') && !host.eval('lockstepResyncPauseActive'), 15000, 'spectator joined');
        const specFrom = spec.eval('currentTick');
        for (const inst of all) {
            const bs = JSON.parse(inst.eval(`JSON.stringify(barracks.filter(b => b.owner === localPlayerId).map(b => ({ gx: b.gx, gy: b.gy })))`));
            const enemy = JSON.parse(inst.eval(`JSON.stringify((u => u && ({ id: u.id, x: u.x, y: u.y }))(units.find(u => u.owner !== localPlayerId && !u.dead)))`));
            q(inst, { action: 'queueUnit', gx: bs[0].gx, gy: bs[0].gy, count: 5 });
            q(inst, { action: 'setRally', gx: bs[0].gx, gy: bs[0].gy, targetX: enemy.x, targetY: enemy.y, targetUnitId: enemy.id });
            q(inst, { action: 'queueUnit', gx: bs[1].gx, gy: bs[1].gy, count: 5 });
            q(inst, { action: 'dequeueUnit', gx: bs[1].gx, gy: bs[1].gy, count: 2 });
            q(inst, { action: 'setRally', gx: bs[1].gx, gy: bs[1].gy, targetX: 15 * 32 + 16, targetY: 15 * 32 + 16 });
            q(inst, { action: 'queueUnit', gx: bs[2].gx, gy: bs[2].gy, count: 3 });
            q(inst, { action: 'setQueueEnabled', gx: bs[2].gx, gy: bs[2].gy, enabled: false });
        }
        const unitsBefore = host.eval('units.length');
        await world.run(8000);
        // Guest 2 resigns (its client switches to a full-visibility view).
        guests[1].eval(`queueAction({ action: 'resign' }); enterSpectateMode('defeated'); connections[0].send({ type: 'MATCH_ROLE_UPDATE', role: 'spectating' });`);
        await world.run(30000);
        assert.ok(host.eval('units.length') > unitsBefore, 'barracks produced units');
        assert.equal(guests[1].eval('fullVisibility'), true);
        assert.equal(guests[1].eval('matchFullVisibility'), false);
        const rallyFollow = host.eval(`barracks.filter(b => b.rallyTargetUnitId != null).length`);
        assertLockstepClean(world, all, 'production/rally', { snapshots: 2 });
        H.checkHealthy(world, [host, spec], { minCompared: 200, fromTick: specFrom, label: 'spectator' });
        rows.push(`production queues, dequeue, disabled queue and rallies (${rallyFollow} following enemy units) with a spectator and a resigned player in sync`);
    }

    // E. Split and merge stacked units, hold/stop, and a fight.
    {
        const { world, host, guests, all } = await match({
            guests: 1, network: { latencyMs: 30, jitterMs: 5 },
            spawnCounts: { 'building:house': { 8: 2 }, 'unit:king': { 1: 1 }, 'unit:norm': { 4: 6 }, 'unit:tank': { 3: 3 }, 'unit:fast': { 2: 4 }, 'building:healer_spawner': { 1: 1 } }
        });
        const ids = inst => JSON.parse(inst.eval(`JSON.stringify(units.filter(u => u.owner === localPlayerId && !u.isKing && u.unitType === 'norm').map(u => u.id))`));
        const count = inst => inst.eval(`units.filter(u => u.owner === localPlayerId && !u.isKing && u.unitType === 'norm').length`);
        const before = count(host);
        q(host, { action: 'resizeUnitGroup', unitIds: ids(host), mode: 'x2', unitType: 'norm' });
        await world.run(1500);
        const split = count(host);
        assert.ok(split > before, `split ${before} -> ${split}`);
        q(host, { action: 'resizeUnitGroup', unitIds: ids(host), mode: 'd2', unitType: 'norm' });
        await world.run(1500);
        assert.ok(count(host) < split, 'merged back');
        // Hold: a held group ignores a move order until released.
        const held = ids(guests[0]).slice(0, 3);
        q(guests[0], { action: 'hold', unitIds: held });
        await world.run(500);
        const pos = guests[0].eval(`JSON.stringify(units.filter(u => ${JSON.stringify(held)}.includes(u.id)).map(u => [u.x, u.y]))`);
        q(guests[0], { action: 'move', unitIds: held, targetX: 15 * 32, targetY: 15 * 32 });
        await world.run(3000);
        assert.equal(guests[0].eval(`JSON.stringify(units.filter(u => ${JSON.stringify(held)}.includes(u.id)).map(u => [u.x, u.y]))`), pos, 'held units stay put');
        q(guests[0], { action: 'stop', unitIds: held });
        // Everyone attacks the other base.
        const deathsBefore = host.eval('units.length');
        for (const inst of all) {
            const enemyKing = JSON.parse(inst.eval(`JSON.stringify((u => ({ x: u.x, y: u.y }))(units.find(u => u.owner !== localPlayerId && u.isKing)))`));
            const mine = JSON.parse(inst.eval(`JSON.stringify(units.filter(u => u.owner === localPlayerId && !u.isKing).map(u => u.id))`));
            q(inst, { action: 'attackMove', unitIds: mine, targetX: enemyKing.x, targetY: enemyKing.y });
        }
        await until(world, () => host.eval('units.length') < deathsBefore - 3 || host.eval('gameOver'), 90000, 'combat kills units');
        assertLockstepClean(world, all, 'split/merge/hold/combat');
        rows.push(`split ${before}->${split} and merge, hold/stop, and a battle, all in sync`);
    }

    console.log('PASS: multiplayer scenarios\n  ' + rows.join('\n  '));
})().catch(err => { console.error(err); process.exit(1); });
