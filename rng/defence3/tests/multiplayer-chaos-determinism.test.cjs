// Determinism stress test. Several players on one map with every unit and
// building type, random research levels, and a command stream that uses
// every action (placement, production, research, rallies, attacks, worker
// assignment, salvage, toggles, tower targeting, group resizing...). The
// full state hash is compared on every tick across all peers. One peer also
// runs the UI refresh code every frame, so UI code that mutates simulation
// state would show up as a divergence. Forced divergences check that a
// resync restores identical state in the middle of all this.
//
// Usage: node tests/multiplayer-chaos-determinism.test.cjs [seconds-per-map]
const assert = require('node:assert/strict');
if (Number(process.env.CHAOS_HOST_HELPERS) > 0) globalThis.self = { crossOriginIsolated: true };
const H = require('./net-harness.cjs');

const SECONDS = Number(process.argv[2]) || 40;

const BUILDINGS = ['pistol', 'smg', 'water', 'poison', 'fire', 'sand_gun', 'ice', 'sniper', 'elements', 'laser', 'watch_tower',
    'sand', 'lava', 'poison_puddle', 'ice_patch', 'water_puddle', 'mine', 'farm', 'spawner', 'astar_farm', 'astar_spawner',
    'salvager', 'builder_spawner', 'healer_spawner', 'research', 'house', 'area_upgrader',
    'cloud_0a', 'cloud_0b', 'cloud_1a', 'cloud_1b', 'cloud_2a', 'cloud_2b', 'cloud_3a', 'cloud_3b',
    'barrack_norm', 'barrack_fast', 'barrack_tank', 'barrack_boss', 'barrack_flying', 'barrack_mole', 'barrack_poison_resistant',
    'barrack_fire_resistant', 'barrack_water_resistant', 'barrack_ice_resistant', 'barrack_laser_resistant', 'barrack_snake', 'barrack_scout'];
const UNITS = ['norm', 'fast', 'tank', 'boss', 'flying', 'mole', 'poison_resistant', 'fire_resistant', 'water_resistant', 'ice_resistant',
    'laser_resistant', 'snake', 'scout', 'collector', 'astar_collector', 'salvager_unit', 'builder_unit', 'healer_unit', 'researcher_unit', 'king'];

function startingResources(seed) {
    let s = seed;
    const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const spawnCounts = {};
    for (const b of BUILDINGS) spawnCounts['building:' + b] = { [1 + Math.floor(r() * 3)]: 1 };
    spawnCounts['building:house'] = { 8: 2 };
    for (const u of UNITS) spawnCounts['unit:' + u] = u === 'king' ? { 1: 1 } : { [1 + Math.floor(r() * 4)]: 2 + Math.floor(r() * 3) };
    return { researchLevels: {}, spawnCounts };
}

// One random command covering every action type the game accepts.
const CHAOS_COMMAND = `(r => {
    if (!gameStarted || gameOver || localDefeated) return '';
    const R = (() => { let s = Math.floor(r * 2147483646) + 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
    const pick = a => a.length ? a[Math.floor(R() * a.length) % a.length] : null;
    const me = localPlayerId;
    const mine = units.filter(u => u.owner === me && !u.dead);
    const enemies = units.filter(u => u.owner !== me && !u.dead);
    const myB = [...towers, ...barracks, ...collectorSpawners, ...getCellItemsRowMajor()].filter(b => b && b.owner === me);
    const theirB = [...towers, ...barracks, ...collectorSpawners, ...getCellItemsRowMajor()].filter(b => b && b.owner !== me && b.owner >= 0);
    const ids = n => { const out = []; for (let i = 0; i < n && mine.length; i++) out.push(pick(mine).id); return out; };
    const tile = () => ({ gx: Math.floor(R() * GRID_W), gy: Math.floor(R() * GRID_H) });
    const near = (x, y, d) => ({ gx: Math.max(0, Math.min(GRID_W - 1, Math.floor(x / TILE) + Math.floor(R() * (2 * d + 1)) - d)), gy: Math.max(0, Math.min(GRID_H - 1, Math.floor(y / TILE) + Math.floor(R() * (2 * d + 1)) - d)) });
    const kinds = ['place', 'place', 'move', 'attackMove', 'attack', 'attackBuilding', 'stop', 'hold', 'queueUnit', 'queueWorker',
        'queueResearch', 'workerAssign', 'setRally', 'setRallyUnit', 'markSalvage', 'setSalvage', 'setAutoUpgrade', 'setAutoStack',
        'setBuildEnabled', 'setQueueEnabled', 'setAutoResearch', 'dequeueUnit', 'dequeueWorker', 'dequeueResearch', 'reorderResearch',
        'killUnit', 'resizeUnitGroup', 'towerTarget'];
    const kind = pick(kinds);
    const b = pick(myB);
    switch (kind) {
        case 'place': {
            const anchor = pick(myB) || pick(mine);
            const t = anchor ? near(anchor.x, anchor.y, 4) : tile();
            queueAction({ action: 'place', gx: t.gx, gy: t.gy, itemType: pick(${JSON.stringify(BUILDINGS)}), count: 1 + Math.floor(R() * 2), autoUpgradeEnabled: R() < 0.5, buildEnabled: R() < 0.8 });
            break;
        }
        case 'move': case 'attackMove': {
            const target = R() < 0.6 && (enemies.length || theirB.length) ? (pick(enemies) || pick(theirB)) : null;
            const t = target ? { gx: Math.floor(target.x / TILE), gy: Math.floor(target.y / TILE) } : tile();
            queueAction({ action: kind, unitIds: ids(1 + Math.floor(R() * 12)), targetX: t.gx * TILE + 16, targetY: t.gy * TILE + 16 });
            break;
        }
        case 'attack': { const e = pick(enemies); if (e) queueAction({ action: 'attack', unitIds: ids(6), targetId: e.id, targetX: e.x, targetY: e.y }); break; }
        case 'attackBuilding': { const e = pick(theirB); if (e) queueAction({ action: 'attackBuilding', unitIds: ids(6), targetGx: e.gx, targetGy: e.gy }); break; }
        case 'stop': case 'hold': queueAction({ action: kind, unitIds: ids(3) }); break;
        case 'queueUnit': { const x = pick(barracks.filter(x => x.owner === me)); if (x) queueAction({ action: 'queueUnit', gx: x.gx, gy: x.gy, count: 1 + Math.floor(R() * 3) }); break; }
        case 'queueWorker': { const x = pick(collectorSpawners.filter(x => x.owner === me)); if (x) queueAction({ action: 'queueWorker', gx: x.gx, gy: x.gy, count: 1 + Math.floor(R() * 2) }); break; }
        case 'queueResearch': case 'dequeueResearch': {
            const lab = pick(collectorSpawners.filter(x => x.owner === me && x.type === 'research'));
            const thing = pick(RESEARCH_THINGS);
            const stat = thing && pick(thing.stats || []);
            if (lab && stat) queueAction({ action: kind, gx: lab.gx, gy: lab.gy, kind: thing.kind, key: thing.key, statKey: stat.statKey, count: 1 + Math.floor(R() * 2) });
            break;
        }
        case 'reorderResearch': { const lab = pick(collectorSpawners.filter(x => x.owner === me && x.type === 'research')); if (lab) queueAction({ action: 'reorderResearch', gx: lab.gx, gy: lab.gy, fromIndex: Math.floor(R() * 3), toIndex: Math.floor(R() * 3), fromActive: R() < 0.2, toActive: R() < 0.2 }); break; }
        case 'workerAssign': {
            const workers = mine.filter(u => u.workerState);
            if (!workers.length) break;
            const w = pick(workers);
            let targetType = null, target = null;
            if (w.workerType === 'builder') { targetType = 'build'; target = pick(myB.filter(x => x.underConstruction || x.isUpgrading)) || b; }
            else if (w.workerType === 'healer') { targetType = 'queue'; target = pick([...barracks, ...collectorSpawners].filter(x => x.owner === me)); }
            else if (w.workerType === 'researcher') { targetType = 'research'; target = pick(collectorSpawners.filter(x => x.owner === me && x.type === 'research')); }
            else if (w.workerType === 'collector') { targetType = R() < 0.7 ? 'mine' : 'farm'; target = targetType === 'mine' ? pick(goldMines) : pick(myB.filter(x => x.type === 'farm')); }
            else if (w.workerType === 'astar_collector') { targetType = R() < 0.7 ? 'astar_mine' : 'astar_farm'; target = targetType === 'astar_mine' ? pick(astarMines) : pick(myB.filter(x => x.type === 'astar_farm')); }
            if (target) queueAction({ action: 'workerAssign', unitIds: workers.filter(x => x.workerType === w.workerType).slice(0, 4).map(x => x.id), targetType, targetGx: target.gx, targetGy: target.gy });
            break;
        }
        case 'setRally': case 'setRallyUnit': {
            const x = pick([...barracks, ...collectorSpawners].filter(x => x.owner === me));
            if (!x) break;
            if (kind === 'setRallyUnit') { const u = pick([...mine, ...enemies]); if (u) queueAction({ action: 'setRally', gx: x.gx, gy: x.gy, targetX: u.x, targetY: u.y, targetUnitId: u.id }); }
            else { const t = tile(); queueAction({ action: 'setRally', gx: x.gx, gy: x.gy, targetX: t.gx * TILE + 16, targetY: t.gy * TILE + 16 }); }
            break;
        }
        case 'markSalvage': if (b && R() < 0.3) queueAction({ action: 'markSalvage', gx: b.gx, gy: b.gy }); break;
        case 'setSalvage': if (b) queueAction({ action: 'setSalvage', gx: b.gx, gy: b.gy, marked: R() < 0.2 }); break;
        case 'setAutoUpgrade': case 'setAutoStack': case 'setBuildEnabled': case 'setQueueEnabled': case 'setAutoResearch':
            if (b) queueAction({ action: kind, gx: b.gx, gy: b.gy, enabled: R() < 0.7 }); break;
        case 'dequeueUnit': { const x = pick(barracks.filter(x => x.owner === me)); if (x) queueAction({ action: 'dequeueUnit', gx: x.gx, gy: x.gy, count: 1 }); break; }
        case 'dequeueWorker': { const x = pick(collectorSpawners.filter(x => x.owner === me)); if (x) queueAction({ action: 'dequeueWorker', gx: x.gx, gy: x.gy, count: 1 }); break; }
        case 'killUnit': { const u = pick(mine.filter(u => !u.isKing)); if (u && R() < 0.3) queueAction({ action: 'killUnit', unitId: u.id }); break; }
        case 'resizeUnitGroup': queueAction({ action: 'resizeUnitGroup', unitIds: ids(8), mode: R() < 0.5 ? 'x2' : 'd2', unitType: R() < 0.5 ? (pick(mine) || {}).unitType || null : null }); break;
        case 'towerTarget': {
            const myTowers = towers.filter(t => t.owner === me);
            if (!myTowers.length) break;
            const coords = myTowers.slice(0, 4).map(t => ({ gx: t.gx, gy: t.gy }));
            const e = pick(enemies), eb = pick(theirB);
            let target = null;
            if (R() < 0.4 && e) target = { type: 'unit', id: e.id };
            else if (eb && R() < 0.8) target = { type: eb instanceof Tower ? 'tower' : eb instanceof Barrack ? 'barrack' : isSpawnerEntity(eb) ? 'spawner' : 'item', gx: eb.gx, gy: eb.gy };
            queueAction({ action: 'towerTarget', towerCoords: coords, target });
            break;
        }
    }
    return kind;
})`;

async function setupChaosWorld(mapType, seed, { guestOptions = [], exactHashes = false, teams = [0, 1, 2, 0], mapSize = 40, network = { latencyMs: 30, jitterMs: 20 }, controls: extra = {} } = {}) {
    const controls = {
        ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': String(mapSize), 'cfg-map-type': mapType, 'cfg-gold-count': '40', 'cfg-astar-mine-count': '25',
        'cfg-starting-energy': '5000000', 'cfg-starting-astar': '5000000', 'cfg-max-pop': '100000', 'cfg-full-vis': 'history', ...extra
    };
    const world = new H.World({ network, controls, hashEvery: 1, recordParts: true, exactHashes });
    const origSpawn = world.spawn.bind(world);
    world.spawn = (name, opts) => {
        const inst = origSpawn(name, opts);
        if (name === 'host') inst.set('startingResourcesConfig', startingResources(seed));
        return inst;
    };
    // By default three teams, one of them shared by two players.
    const { host, guests } = await H.startHostedMatch(world, { guests: teams.length - 1, teams, maxMs: 90000, guestOptions });
    const all = [host, ...guests];
    // CHAOS_HOST_HELPERS=n: the host's simulation gets n real helper threads
    // (shared memory, as a cross-origin isolated browser), the guests none:
    // background jobs then run at other times on the host than on the
    // guests, which must not change anything.
    if (Number(process.env.CHAOS_HOST_HELPERS) > 0) {
        if (!(globalThis.self && globalThis.self.crossOriginIsolated)) throw new Error('CHAOS_HOST_HELPERS needs the shared-memory mode: run with CHAOS_HOST_HELPERS set before loading the harness');
        host.scratch.Worker = require('./real-sim-helper.cjs');
        host.eval(`Worker = __scratch.Worker; navigator.hardwareConcurrency = 32; simParallelInit('', ${Number(process.env.CHAOS_HOST_HELPERS)})`);
    }
    // Every building and unit the game has is in the mix (new ones too).
    const missing = JSON.parse(host.eval(`JSON.stringify([...Object.keys(BASE_CARD_TYPES).filter(k => !BASE_CARD_TYPES[k].notBuildable && !${JSON.stringify(BUILDINGS)}.includes(k)), ...Object.keys(BASE_UNIT_STATS).filter(k => !${JSON.stringify(UNITS)}.includes(k))])`));
    assert.deepEqual(missing, [], 'chaos lists miss these buildings/units');
    const setupCounts = host.eval(`JSON.stringify({ units: units.length, towers: towers.length, barracks: barracks.length, spawners: collectorSpawners.length, floor: getCellItemsRowMajor().length })`);
    // CHAOS_SIM_EVAL: code every peer's simulation runs after the same tick,
    // e.g. the large-world paths on these small worlds:
    //   SPATIAL_PARALLEL_MIN_UNITS = 0; SNAP_HASH_KERNEL_MIN_UNITS = 0
    if (process.env.CHAOS_SIM_EVAL) {
        const at = world.atNextSafeTick(process.env.CHAOS_SIM_EVAL, 10);
        await world.runUntil(() => all.every(i => i.eval('currentTick') > at + 1), 20000, 20);
    }

    return { world, host, guests, all, setupCounts };
}

async function chaosMatch(mapType, seed, { corruptions = 2 } = {}) {
    const { world, host, guests, all, setupCounts } = await setupChaosWorld(mapType, seed);
    // What the host finds differing in each repair request (for failures).
    host.scratch.requests = [];
    host.eval(`(() => { const orig = resyncHostHandleRequest; resyncHostHandleRequest = function (conn, data) {
        const codes = new Set(); for (const r of (data && data.rotation) || []) { const mine = snapGetTickHash(r.tick); if (mine) for (const c of snapDiffTickHash(mine, r)) codes.add(c); }
        __scratch.requests.push({ peer: String(conn.peer), tick: data && data.tick, differs: snapDescribeCodes(codes, 12) });
        return orig.apply(this, arguments); }; })()`);
    let s = seed;
    const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const commandKinds = new Map();
    const unitTypesSeen = new Set();
    let maxUnits = 0;
    const endAt = world.now + SECONDS * 1000;
    const corruptAt = [];
    const corruptTicks = [];
    // Halfway, the third team resigns: its client keeps simulating with a
    // local full-visibility view, which must not affect its simulation.
    let resignAt = world.now + SECONDS * 500;
    // A third of the way: every peer moves a few units and kills one between
    // two ticks (as a restore or a scripted setup does): whatever was built
    // ahead from the old positions (the unit index, the separation) must be
    // dropped alike on every peer, with or without helpers.
    let shiftAt = world.now + SECONDS * 333;
    for (let i = 1; i <= corruptions; i++) corruptAt.push(world.now + SECONDS * 1000 * i / (corruptions + 1));
    while (world.now < endAt) {
        for (const inst of all) {
            for (let k = 0; k < 2; k++) {
                if (rand() < 0.7) {
                    const kind = inst.eval(CHAOS_COMMAND + '(' + rand() + ')');
                    if (kind) commandKinds.set(kind, (commandKinds.get(kind) || 0) + 1);
                }
            }
        }
        // The host also runs the in-game UI refreshes, with a live selection.
        host.eval(`(() => {
            selectedUnits = units.filter(u => u.owner === localPlayerId && !u.dead).slice(0, 30);
            selectedEntities = collectorSpawners.filter(s => s.owner === localPlayerId).slice(0, 3);
            for (const k of ['updateInfoPanel', 'updateHUD', 'updateBuildMenu', 'updateControlGroupBar']) { try { __orig[k](); } catch (e) {} }
        })()`);
        if (shiftAt && world.now >= shiftAt) {
            shiftAt = 0;
            world.atNextSafeTick(`(() => { const us = units.filter(u => !u.dead).sort((a, b) => a.id - b.id);
                for (let i = 0; i < us.length && i < 40; i += 4) { const u = us[i]; u.x += 3; u.y -= 2; updateUnitSpatial(u); }
                const k = us[us.length >> 1]; if (k && !k.isKing) k.dead = true; })()`, 10);
        }
        if (resignAt && world.now >= resignAt) {
            resignAt = 0;
            guests[1].eval("queueAction({ action: 'resign' }); enterSpectateMode('defeated'); connections[0].send({ type: 'MATCH_ROLE_UPDATE', role: 'spectating' });");
        }
        if (corruptAt.length && world.now >= corruptAt[0]) {
            corruptAt.shift();
            const victim = guests[Math.floor(rand() * guests.length)];
            corruptTicks.push({ victim: victim.name, tick: victim.eval('currentTick') - 1 });
            // The healthiest unit (lowest id on ties): a unit about to die
            // anyway can take the divergence with it before any hash shows it.
            victim.evalSim(`(() => { let u = null; for (const c of units) if (!c.dead && (!u || c.energy > u.energy)) u = c;
                if (u) { u.x += 11; u.energy = Math.max(1, u.energy - 5); } })()`);
        }
        for (const t of JSON.parse(host.eval('JSON.stringify([...new Set(units.map(u => u.unitType))])'))) unitTypesSeen.add(t);
        maxUnits = Math.max(maxUnits, host.eval('units.length'));
        await world.run(200);
    }
    await world.run(3000);

    // Only the corrupted guest may disagree, and only between the forced
    // divergence and the patches that repair it; any other mismatch is real
    // nondeterminism. A patch carries the regions found to differ; effects
    // that reach elsewhere before it lands (a unit alive on one side only
    // changes the whole update order) are repaired by a follow-up patch, so
    // repairs within FOLLOW_UP ticks of the first count as the same one.
    const FOLLOW_UP = 60;
    const repairTicks = name => { const i = all.find(i => i.name === name); return [...(i.patchTicks || []), ...(i.snapshotTicks || [])]; };
    const repairWindow = c => {
        const after = repairTicks(c.victim).filter(st => st > c.tick).sort((a, b) => a - b);
        if (!after.length) return { first: Infinity, last: Infinity, count: 0 };
        const inWindow = after.filter(st => st <= after[0] + FOLLOW_UP);
        return { first: after[0], last: inWindow[inWindow.length - 1], count: inWindow.length };
    };
    const allowed = m => corruptTicks.some(c => (c.victim === m.a || c.victim === m.b) && c.tick <= m.tick && m.tick <= repairWindow(c).last);
    for (const inst of all) {
        assert.deepEqual(inst.errors.map(e => String(e && e.stack || e).slice(0, 600)), [], mapType + ' ' + inst.name + ' threw');
    }
    const cmp = world.compareHashes(all, 0);
    const real = cmp.mismatches.filter(m => !allowed(m));
    if (real.length) {
        // Name the subsystem that diverged first.
        const m = real[0];
        const a = all.find(i => i.name === m.a), b = all.find(i => i.name === m.b);
        const pa = a.tickParts.get(m.tick) || {}, pb = b.tickParts.get(m.tick) || {};
        const parts = Object.keys(pa).filter(k => pa[k] !== pb[k]);
        throw new Error(`${mapType}: nondeterministic divergence at tick ${m.tick} (${m.a} vs ${m.b}) in [${parts.join(', ')}]; `
            + `forced ${JSON.stringify(corruptTicks)}, repairs ${JSON.stringify(all.map(i => [i.name, repairTicks(i.name)]))}: ` + JSON.stringify(real.slice(0, 4))
            + '\n  host saw: ' + JSON.stringify(host.scratch.requests)
            + '\n  patched: ' + all.map(i => i.name + ' ' + JSON.stringify(i.warnings.filter(w => /Patched/.test(JSON.stringify(w.a))).map(w => JSON.stringify(w.a).slice(0, 500)))).join('\n  '));
    }
    assert.ok(cmp.compared > SECONDS * 20 * 3 * 0.8, mapType + ' compared ' + cmp.compared);
    const hostResyncs = all.reduce((n, i) => n + i.patchesApplied, 0);
    // Every forced divergence was repaired (by a patch and at most one
    // follow-up), and no patch happened for anything else.
    const windows = corruptTicks.map(repairWindow);
    for (const w of windows) assert.ok(w.count >= 1 && w.count <= 2, mapType + ': repairs per forced divergence ' + JSON.stringify(windows));
    assert.equal(hostResyncs, windows.reduce((n, w) => n + w.count, 0), mapType + ': patches only for forced divergences'
        + ` (forced ${JSON.stringify(corruptTicks)}, repairs ${JSON.stringify(all.map(i => [i.name, repairTicks(i.name)]))}; host saw ${JSON.stringify(host.scratch.requests)})`);
    for (const i of all) assert.equal(i.snapshotsApplied, 1, mapType + ': no match-wide resync on ' + i.name);
    const desyncs = all.reduce((n, i) => n + i.eval('netCounters.desyncsDetected'), 0);
    return {
        mapType, setupCounts: JSON.parse(setupCounts), maxUnits, unitTypesSeen: unitTypesSeen.size, commandKinds: commandKinds.size,
        compared: cmp.compared, hostResyncs, desyncs, ticks: host.eval('currentTick')
    };
}

module.exports = { setupChaosWorld, CHAOS_COMMAND, BUILDINGS, UNITS, startingResources };

if (require.main === module) (async () => {
    const results = [];
    const maps = (process.env.CHAOS_MAPS || 'arena,random,islands,crossroads,solar_system,island').split(',');
    const allMaps = ['arena', 'random', 'islands', 'crossroads', 'solar_system', 'island'];
    for (const m of maps) results.push(await chaosMatch(m, 1000 + Math.max(0, allMaps.indexOf(m)) * 77));
    for (const r of results) {
        assert.ok(r.setupCounts.units >= 150, r.mapType + ' start units ' + r.setupCounts.units);
        assert.ok(r.unitTypesSeen >= 18, r.mapType + ' unit types seen ' + r.unitTypesSeen);
        assert.ok(r.commandKinds >= 24, r.mapType + ' command kinds used ' + r.commandKinds);
    }
    console.log('PASS: chaos determinism\n  ' + results.map(r => `${r.mapType}: ${r.setupCounts.units} units + ${r.setupCounts.towers + r.setupCounts.barracks + r.setupCounts.spawners + r.setupCounts.floor} buildings at start (max ${r.maxUnits} units), ${r.unitTypesSeen} unit types, ${r.commandKinds} command kinds, ${r.compared} tick hashes compared, ${r.hostResyncs} patches for forced divergences`).join('\n  '));
    // (Helper threads keep the process alive.)
    if (Number(process.env.CHAOS_HOST_HELPERS) > 0) process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
