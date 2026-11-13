'use strict';
// Spawns' rallies (spr.rs k_spawn_births; wai.rs rally, the new workers' event):
// a barrack's unit attack-moves to its rally point's tile and gets there; a
// collector spawner's worker rallied onto a mine takes that mine; a builder
// spawner's worker rallied onto a site under construction builds it; a worker
// rallied to open ground walks there (a manual move); a barrack rallied onto a
// hostile unit its owner sees sends its unit to that unit's place.
//   node tests/spawn-rally.test.cjs
const assert = require('node:assert/strict');
const H = require('./net-harness.cjs');
const CONTROLS = { ...H.SMALL_MATCH_CONTROLS, 'cfg-mapsize': '64' };
(async () => {
    const world = new H.World({ controls: CONTROLS });
    const host = world.spawn('host', { controls: CONTROLS, simWorker: false });
    host.eval('startSoloGame();');
    await world.run(1500);
    const setup = JSON.parse(host.eval(`(() => {
        matchFullVisibility = true;
        const open = (gx, gy) => { const c = grid[gy] && grid[gy][gx]; return c && cellType[(c) - 1] === 0 && !cellItemGet(c) && !getTileEntityRef(gx, gy); };
        const clear = (gx, gy, r) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (!open(gx + dx, gy + dy)) return false; return true; };
        const spots = [];
        for (let gy = 4; gy < GRID_H - 4; gy += 5) for (let gx = 4; gx < GRID_W - 4; gx += 5) if (clear(gx, gy, 2)) spots.push([gx, gy]);
        let k = 0;
        const spot = () => spots[k++];
        const place = (key, at, owner = 0) => { if (!placeBuilding(at[0], at[1], key, owner, { ignorePlacementRules: true, silent: true })) return null; const b = getTileEntityRef(at[0], at[1]); if (b && b.underConstruction) markConstructionComplete(b); if (b) b.energy = b.maxEnergy; return b; };
        const queue = b => { spawnQueuePush(b, 1); b._qPaid = b._qReq; };
        const S = {};
        // A barrack rallied to an open tile some way off.
        { const b = place('barrack_norm', spot()), to = spot(); b.rallyX = to[0] * TILE + 16; b.rallyY = to[1] * TILE + 16; queue(b); S.barrack = { to }; }
        // A collector spawner rallied onto one of the map's gold mines.
        { const b = place('spawner', spot()), mine = goldMines.find(m => m && m.gold > 0); const m = mine ? [mine.gx, mine.gy] : null;
          if (m) { b.rallyX = m[0] * TILE + 16; b.rallyY = m[1] * TILE + 16; } queue(b); S.collector = { mine: m, hasMine: !!m }; }
        // A builder spawner rallied onto a site under construction.
        { const b = place('builder_spawner', spot()), at = spot(); placeBuilding(at[0], at[1], 'watch_tower', 0, { ignorePlacementRules: true, silent: true }); const site = getTileEntityRef(at[0], at[1]);
          b.rallyX = at[0] * TILE + 16; b.rallyY = at[1] * TILE + 16; queue(b); S.builder = { at, site: !!(site && site.underConstruction) }; }
        // A healer spawner rallied to open ground.
        { const b = place('healer_spawner', spot()), to = spot(); b.rallyX = to[0] * TILE + 16; b.rallyY = to[1] * TILE + 16; queue(b); S.walker = { to }; }
        // A barrack rallied onto an enemy unit (seen: full visibility).
        { const b = place('barrack_norm', spot()), at = spot(); const e = simSpawnUnit('norm', 1, at[0] * TILE + 16, at[1] * TILE + 16, 1); unitAdded(e); e.holdPosition = true;
          b.rallyTargetUnitId = e.id; b.rallyX = NaN; b.rallyY = NaN; queue(b); S.follow = { at, enemy: e.id }; }
        players[0].popCount = 0;
        const n0 = nextUnitId;
        processGlobalSpawnerQueue();
        S.born = nextUnitId - n0; S.first = n0;
        __scratch.S = S;
        return JSON.stringify(S);
    })()`));
    console.log('setup', JSON.stringify(setup));
    assert.equal(setup.born, 5, 'five births');
    const look = () => JSON.parse(host.eval(`(() => {
        const S = __scratch.S, out = [];
        for (let id = S.first; id < S.first + S.born; id++) { const u = getUnitById(id); out.push(u ? { id, type: u.unitType, gx: Math.floor(u.x / TILE), gy: Math.floor(u.y / TILE), cmd: u.commandState, ws: u.workerState || null,
            tgt: u.workerTarget ? [u.workerTarget.gx, u.workerTarget.gy] : null, path: u.path && u.path.length ? [u.path[0].x, u.path[0].y] : null } : { id, gone: true }); }
        return JSON.stringify(out);
    })()`));
    const t0 = look();
    console.log('at birth', JSON.stringify(t0));
    // The barrack's: its way to the rally tile, attack-moving.
    assert.equal(t0[0].cmd, 2, 'the barrack unit attack-moves');
    assert.deepEqual(t0[0].path, setup.barrack.to, 'its way: the rally tile');
    // The collector: the mine.
    if (setup.collector.hasMine) assert.deepEqual(t0[1].tgt, setup.collector.mine, 'the collector takes the rallied mine');
    // The builder: the site.
    if (setup.builder.site) assert.deepEqual(t0[2].tgt, setup.builder.at, 'the builder takes the rallied site');
    // The walker: a manual move there.
    assert.equal(t0[3].ws, 'MANUAL_MOVE', 'the worker with no work there walks there');
    assert.deepEqual(t0[3].path, setup.walker.to, 'its way: the rally tile');
    // Following: its way to the enemy's tile.
    assert.deepEqual(t0[4].path, setup.follow.at, 'the follower goes to the enemy unit');
    // (Sampled: once there, a worker goes on to its work.)
    const near = (u, at) => u && !u.gone && Math.abs(u.gx - at[0]) <= 2 && Math.abs(u.gy - at[1]) <= 2;
    let walkerThere = false, barrackThere = false;
    for (let i = 0; i < 30; i++) { await world.run(500); const t = look(); walkerThere ||= near(t[3], setup.walker.to); barrackThere ||= near(t[0], setup.barrack.to); }
    const t1 = look();
    console.log('later', JSON.stringify(t1));
    assert.ok(barrackThere, 'the barrack unit got to its rally point');
    assert.ok(walkerThere, 'the walker got to its rally point');
    console.log('ok: spawns rally');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
