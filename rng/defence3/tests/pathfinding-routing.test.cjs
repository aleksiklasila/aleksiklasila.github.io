const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const source = read('src/game/pathfinding.js');
const constants = read('src/data/data_static.js').split('let pathfindBudget = 0;')[1];
function world(w = 160, h = 100, code = source) {
    const c = vm.createContext({
        GRID_W: w, GRID_H: h, TYPE_WALL: 1, gameTime: 1, window: {}, performance,
        ASTAR_MAX_ITERS_LIMIT: 18000, _collectorCanWalk: () => false,
        _normalizeOwnerId: owner => owner == null ? -1 : owner,
        towers: [], grid: Array.from({ length: h }, () => Array.from({ length: w }, () => ({ type: 0 })))
    });
    vm.runInContext('let pathfindBudget = 0;' + constants + '\n' + code, c);
    c.nodes = 0;
    c._tryConsumeAstarNodeBudget = () => { c.nodes++; return true; };
    return c;
}
function route(c, id, sx = 145, sy = 85, ex = 5, ey = 10) {
    return c._findPathForUnitTagged('player_commands', { id, owner: 0 }, sx, sy, ex, ey, false, null, 0);
}
const c = world();
const routes = Array.from({ length: 1000 }, (_, i) => route(c, i));
assert.equal(new Set(routes).size, 1, '1000 units reuse one path array');
assert.equal(new Set(routes.map(p => JSON.stringify(p))).size, 1, 'unit IDs cannot change the route');
assert.ok(c.nodes < 2000, `open terrain search work stays near path length: ${c.nodes}`);
for (const p of new Set(routes)) {
    assert.equal(p.length, 216);
    let run = 0, longest = 0, last = '';
    for (let i = 1; i < p.length; i++) {
        const direction = p[i].x === p[i - 1].x ? 'y' : 'x';
        run = direction === last ? run + 1 : 1;
        longest = Math.max(longest, run); last = direction;
    }
    assert.ok(longest <= 12, `interleave axes instead of exhausting one: ${longest}`);
}
const replay = world();
// Diagonal preference means alternating cardinal steps in all four quadrants.
for (const [sx, sy, ex, ey] of [[10, 10, 30, 30], [30, 10, 10, 30], [10, 30, 30, 10], [30, 30, 10, 10]]) {
    const p = route(replay, 5, sx, sy, ex, ey);
    let lastAxis = null;
    for (let i = 1; i < p.length; i++) {
        const dx = Math.abs(p[i].x - p[i - 1].x), dy = Math.abs(p[i].y - p[i - 1].y);
        assert.equal(dx + dy, 1, 'never step directly between diagonal tiles');
        const axis = dx ? 'x' : 'y';
        assert.notEqual(axis, lastAxis, 'equal slopes alternate horizontal and vertical steps');
        lastAxis = axis;
    }
}
// Vary request ordering, perf clock and cache warmth. Route selection stays identical.
replay.performance = { now: () => 987654321 };
for (let i = 999; i >= 0; i--) assert.equal(JSON.stringify(route(replay, i)), JSON.stringify(routes[i]));

// Compare independent BFS across unit IDs on seeded obstacle maps,
// with and without live, dead, incomplete and enemy portal pairs.
let seed = 17;
function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
for (let scenario = 0; scenario < 40; scenario++) {
    const m = world(26, 22);
    for (const row of m.grid) for (const cell of row) cell.type = random() < 0.22 ? 1 : 0;
    m.grid[1][1].type = m.grid[20][24].type = 0;
    if (scenario % 5) m.towers = [
        { gx: 3, gy: 2, owner: 0, energy: 1, baseStats: { isCloud: true, pairId: 'a' } },
        { gx: 22, gy: 19, owner: scenario % 5 === 4 ? 1 : 0, energy: scenario % 5 === 2 ? 0 : 1,
            underConstruction: scenario % 5 === 3, baseStats: { isCloud: true, pairId: 'a' } }
    ];
    const expected = m._findPathBfsReference(1, 1, 24, 20, false, null, 0, true);
    // Group orders give the same shortest routes, through portals too.
    const groupStartsHere = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }].filter(s => !m.grid[s.y][s.x].type);
    const grouped = m.findGroupPathsToTarget(groupStartsHere, 24, 20, null, 0);
    groupStartsHere.forEach((s, i) => {
        const single = m._findPathBfsReference(s.x, s.y, 24, 20, false, null, 0, true);
        assert.equal(grouped[i]?.length, single?.length, `group shortest path: scenario ${scenario}`);
        if (grouped[i]) assert.ok(m._isPathValidForScenario(grouped[i], s.x, s.y, 24, 20, false, null, 0, true));
    });
    for (let id = 0; id < 12; id++) {
        const actual = m._findPathForUnitTagged('player_commands', { id }, 1, 1, 24, 20, false, null, 0, null, false);
        assert.equal(actual?.length, expected?.length, `shortest path: scenario ${scenario}, unit ${id}`);
        if (actual) assert.ok(m._isPathValidForScenario(actual, 1, 1, 24, 20, false, null, 0, true));
    }
}
// A restricted walk profile must retain its wall-pass permissions.
const special = world(20, 20);
for (const row of special.grid) row[10].type = 1;
const canWalk = (x, y) => x === 10 && y === 8;
canWalk._pathProfileKey = 'test-worker';
const workerPath = special._findPathForUnitTagged('worker_ai', { id: 4 }, 1, 1, 18, 18, false, canWalk, 0);
assert.ok(workerPath.some(n => n.x === 10 && n.y === 8));
assert.equal(workerPath.length, 35);
special._bumpPathTopologyVersion();
assert.equal(vm.runInContext('sharedPathCache.size', special), 0);

// Deferred requests stay inside the same node budget and resume the shared route.
const roomy = world(32, 24);
for (let x = 4; x <= 24; x++) roomy.grid[5][x].type = 1;
const spaced = route(roomy, 1, 3, 6, 26, 10);
assert.equal(spaced.length, 28, 'clearance never buys a longer route');
assert.ok(spaced.filter(n => n.x >= 6 && n.x <= 23).every(n => n.y >= 8),
    'use two free rows between the path and a parallel wall');
const passMine = () => true;
passMine._pathProfileKey = 'pass-mine';
const mineWalker = roomy._findPathForUnitTagged('worker_ai', { id: 2 }, 3, 6, 26, 10, false, passMine, 0);
assert.ok(mineWalker.some(n => n.x >= 6 && n.y < 8), 'passable mines do not push their workers away');
assert.equal(roomy._getPathClearance(10, 6, null, 0, true), 1);
assert.equal(roomy._getPathClearance(10, 7, null, 0, true), 2);
assert.equal(roomy._getPathClearance(10, 8, null, 0, true), 3);
assert.equal(roomy._getPathClearance(10, 6, passMine, 0, true), 3);
// A constrained shortest route remains available even with no clearance.
const tight = route(roomy, 3, 3, 6, 26, 6);
assert.equal(tight.length, 24);
assert.ok(tight.every(n => n.y === 6));
// Terrain edits invalidate the lazy clearance cache along with the route cache.
roomy.grid[7][10].type = 1;
roomy._bumpPathTopologyVersion();
roomy._ensurePathClearanceCache();
assert.equal(roomy._getPathClearance(10, 8, null, 0, true), 1);

const deferred = world();
let allowance = 0;
deferred._tryConsumeAstarNodeBudget = () => allowance-- > 0;
assert.equal(route(deferred, 7), null);
assert.equal(vm.runInContext('_lastPathfindAbortedByBudget', deferred), true);
let resumed = null;
for (let tick = 0; tick < 20 && !resumed; tick++) {
    deferred.gameTime++;
    allowance = 24;
    resumed = route(deferred, 7);
    assert.ok(allowance >= -1, 'search stops as soon as its node allowance is exhausted');
}
assert.ok(resumed, 'partial cache makes progress under a small deterministic budget');
assert.equal(resumed.length, 216);
assert.ok(deferred._isPathValidForScenario(resumed, 145, 85, 5, 10, false, null, 0, true));

const unitGrid = Array.from({ length: 100 }, () => Array.from({ length: 160 }, () => ({ type: 0 })));
const unitContext = vm.createContext({ TILE: 32, GRID_W: 160, GRID_H: 100, TYPE_WALL: 1, grid: unitGrid });
vm.runInContext(read('src/things/unit.js'), unitContext);

// Follow the real shared paths with 1000 units. Each reaches the target tile,
// charges every traversed edge and leaves the cached array untouched.
unitContext.isCloudPortalLink = () => false;
unitContext.canUnitOccupyTile = () => true;
let chargedEdges = 0;
unitContext._tryConsumeAstarMoveCostForTransition = () => { chargedEdges++; return true; };
const Unit = vm.runInContext('Unit', unitContext);
const pathCopies = [...new Set(routes)].map(p => JSON.stringify(p));
for (let id = 0; id < 1000; id++) {
    const moving = Object.assign(Object.create(Unit.prototype), {
        id, owner: 0, r: 6, x: 145 * 32 + 16, y: 85 * 32 + 16,
        path: routes[id], pathIndex: 1, getCollisionRadius: () => 6
    });
    let reached = false;
    for (let tick = 0; tick < 3000 && !reached; tick++) reached = moving.followPath(4);
    assert.ok(reached);
    assert.equal(Math.floor(moving.x / 32), 5);
    assert.equal(Math.floor(moving.y / 32), 10);
}
assert.equal(chargedEdges, 215000);
assert.deepEqual([...new Set(routes)].map(p => JSON.stringify(p)), pathCopies);

// A shove onto a later waypoint must not send a unit backwards. Catch-up
// remains bounded and keeps the shared route and movement accounting intact.
const shovePath = Array.from({ length: 12 }, (_, x) => ({ x, y: 4 }));
function shoved(x, y = 4, routePath = shovePath) {
    return Object.assign(Object.create(Unit.prototype), {
        id: 1, owner: 0, r: 6, x: x * 32 + 16, y: y * 32 + 16,
        path: routePath, pathIndex: 1
    });
}
function setCorridor(walled) {
    for (let x = 0; x < 12; x++) unitGrid[3][x].type = unitGrid[5][x].type = walled ? 1 : 0;
}
// Open terrain is a corridor: every node whose 3x3 block holds the unit
// counts as reached, so a unit skirts beside the exact tiles.
for (const [x, y, index] of [[2, 4, 4], [4, 4, 6], [7, 4, 8], [4, 5, 6], [4, 3, 6], [8, 4, 9]]) {
    const u = shoved(x, y), before = chargedEdges;
    u.followPath(4);
    assert.equal(u.pathIndex, index, `open ${x},${y}`);
    assert.ok(u.vx > 0, 'steer forward after displacement');
    assert.equal(chargedEdges - before, index - 1, 'each consumed edge is charged once');
    assert.equal(u.path, shovePath);
    u.followPath(4);
    assert.equal(chargedEdges - before, u.pathIndex - 1, 'subsequent ticks never recharge consumed nodes');
}
for (const [x, y] of [[4, 6], [4, 2], [0, 6]]) {
    const u = shoved(x, y);
    u.followPath(4);
    assert.equal(u.pathIndex, 1, 'two tiles off the route is not on it');
}
// Inside a one-tile corridor only the exact tiles count, as before.
setCorridor(true);
for (const tile of [2, 4, 7]) {
    const u = shoved(tile), before = chargedEdges;
    u.followPath(4);
    assert.equal(u.pathIndex, tile + 1);
    assert.equal(chargedEdges - before, tile);
}
for (const [x, y] of [[0, 4], [8, 4]]) {
    const u = shoved(x, y);
    u.followPath(4);
    assert.equal(u.pathIndex, 1, 'previous and beyond-lookahead tiles do not skip in a corridor');
}
setCorridor(false);
// Keep the side offset in open terrain rather than converging on the center.
{
    const u = shoved(3, 4);
    u.y += 20;
    u.followPath(2);
    assert.ok(u.y > 4 * 32 + 16 + 10, 'a unit beside the route stays beside it');
    assert.ok(u.vx > 1.8, 'and keeps moving along it');
}
const shortPath = shovePath.slice(0, 5);
const atEnd = shoved(4, 4, shortPath);
assert.equal(atEnd.followPath(4), true);
assert.equal(atEnd.pathIndex, shortPath.length);
const portalPath = [{ x: 0, y: 4 }, { x: 1, y: 4 }, { x: 20, y: 4 }, { x: 21, y: 4 }];
const acrossPortal = shoved(21, 4, portalPath);
acrossPortal.followPath(4);
assert.equal(acrossPortal.pathIndex, 1, 'local recovery never skips a nonlocal portal edge');
assert.deepEqual(shovePath, Array.from({ length: 12 }, (_, x) => ({ x, y: 4 })));

// A crowd sharing one diagonal route flows as a wide column instead of a
// single-file staircase, and replays bit-for-bit.
function crowdRun() {
    const route = [{ x: 10, y: 60 }];
    for (let x = 10, y = 60; x !== 70 || y !== 10;) {
        if (70 - x >= y - 10 && x !== 70) x++; else y--;
        route.push({ x, y });
    }
    unitContext.canUnitOccupyTile = (u, x, y) => x >= 0 && y >= 0 && x < 160 && y < 100 && unitGrid[y][x].type !== 1;
    const separate = vm.runInContext('applyUnitSeparation', unitContext);
    const crowd = Array.from({ length: 150 }, (_, i) => Object.assign(Object.create(Unit.prototype), {
        id: i, owner: 0, r: 7, x: (2 + i % 15) * 32 + 16 + i % 5, y: (50 + Math.floor(i / 15)) * 32 + 16 + i % 3,
        path: route, pathIndex: 1, getCollisionRadius: () => 9, done: false
    }));
    let done = 0, tick = 0;
    for (; tick < 4000 && done < crowd.length; tick++) {
        for (const u of crowd) {
            if (u.done) continue;
            u.followPath(3.2);
            if (u.pathIndex >= route.length - 3) { u.done = true; done++; continue; }
            let px = 0, py = 0, overlap = 0;
            for (const o of crowd) {
                if (o === u || o.done) continue;
                const dx = u.x - o.x, dy = u.y - o.y, d2 = dx * dx + dy * dy;
                if (d2 >= 324 || d2 < 1e-6) continue;
                const d = Math.sqrt(d2);
                px += dx / d * (18 - d) * .6; py += dy / d * (18 - d) * .6; overlap = Math.max(overlap, 18 - d);
            }
            if (px || py) separate(u, px, py, overlap);
            u.x = Math.round(u.x * 8) / 8; u.y = Math.round(u.y * 8) / 8;
        }
    }
    return { tick, done, state: JSON.stringify(crowd.map(u => [u.x, u.y, u.pathIndex])) };
}
const crowdA = crowdRun(), crowdB = crowdRun();
assert.equal(crowdA.done, 150, 'the whole crowd passes along the route');
// 110 route tiles at 3.2px/tick is ~1100 ticks for the lead; a single-file
// column of 150 units took several times longer.
assert.ok(crowdA.tick < 2600, `crowd throughput: ${crowdA.tick} ticks`);
assert.deepEqual(crowdB, crowdA, 'crowd movement replays deterministically');

// Group orders: one shared reverse search gives every unit its own shortest
// path. Compare with per-unit A* on a map with a gate and a block, then check
// that a crowd flows at least as well along the shared-search routes.
const obstacles = [];
for (let y = 15; y < 70; y++) if (y < 38 || y > 42) for (let x = 35; x <= 37; x++) obstacles.push([x, y]);
for (let y = 22; y <= 32; y++) for (let x = 50; x <= 58; x++) obstacles.push([x, y]);
const gw = world(160, 100);
for (const [x, y] of obstacles) gw.grid[y][x].type = unitGrid[y][x].type = 1;
const groupStarts = Array.from({ length: 150 }, (_, i) => ({ x: 4 + i % 15, y: 45 + Math.floor(i / 15) }));
const groupPaths = gw.findGroupPathsToTarget(groupStarts, 72, 12, null, 0);
const astarPaths = groupStarts.map((s, i) => gw._findPathForUnitTagged('player_commands', { id: i, owner: 0 }, s.x, s.y, 72, 12, false, null, 0));
for (let i = 0; i < groupStarts.length; i++) {
    assert.ok(groupPaths[i], `group path ${i}`);
    assert.equal(groupPaths[i].length, astarPaths[i].length, 'group paths are shortest paths');
    assert.ok(gw._isPathValidForScenario(groupPaths[i], groupStarts[i].x, groupStarts[i].y, 72, 12, false, null, 0, true));
}
assert.equal(JSON.stringify(gw.findGroupPathsToTarget(groupStarts, 72, 12, null, 0)), JSON.stringify(groupPaths), 'replays');
assert.equal(new Set(groupPaths.map(p => JSON.stringify(p.slice(0, 4)))).size, groupStarts.length, 'each unit starts on its own route');
gw.nodes = 0;
gw.findGroupPathsToTarget(groupStarts, 72, 12, null, 0);
const groupNodes = gw.nodes;
gw.nodes = 0;
gw._bumpPathTopologyVersion();
groupStarts.forEach((s, i) => gw._findPathForUnitTagged('player_commands', { id: i, owner: 0 }, s.x, s.y, 72, 12, false, null, 0));
assert.ok(groupNodes * 3 < gw.nodes, `shared search expands far fewer nodes: ${groupNodes} vs ${gw.nodes}`);

function crowdAlong(paths) {
    const separate = vm.runInContext('applyUnitSeparation', unitContext);
    const crowd = paths.map((p, i) => Object.assign(Object.create(Unit.prototype), {
        id: i, owner: 0, r: 7, x: p[0].x * 32 + 16 + i % 5, y: p[0].y * 32 + 16 + i % 3,
        path: p, pathIndex: 1, getCollisionRadius: () => 9, done: false
    }));
    let done = 0, tick = 0;
    for (; tick < 6000 && done < crowd.length; tick++) {
        for (const u of crowd) {
            if (u.done) continue;
            u.followPath(3.2);
            if (u.pathIndex >= u.path.length - 3) { u.done = true; done++; continue; }
            let px = 0, py = 0, overlap = 0;
            for (const o of crowd) {
                if (o === u || o.done) continue;
                const dx = u.x - o.x, dy = u.y - o.y, d2 = dx * dx + dy * dy;
                if (d2 >= 324 || d2 < 1e-6) continue;
                const d = Math.sqrt(d2);
                px += dx / d * (18 - d) * .6; py += dy / d * (18 - d) * .6; overlap = Math.max(overlap, 18 - d);
            }
            if (px || py) separate(u, px, py, overlap);
            u.x = Math.round(u.x * 8) / 8; u.y = Math.round(u.y * 8) / 8;
        }
    }
    return { tick, done };
}
const viaGroup = crowdAlong(groupPaths), viaAstar = crowdAlong(astarPaths);
assert.equal(viaGroup.done, 150);
assert.ok(viaGroup.tick <= viaAstar.tick * 1.1 + 20, `group routes flow as well as per-unit A*: ${viaGroup.tick} vs ${viaAstar.tick}`);
for (const [x, y] of obstacles) unitGrid[y][x].type = 0;
console.log(`group order: ${groupNodes} vs ${gw.nodes} nodes; crowd ${viaGroup.tick} vs ${viaAstar.tick} ticks; identical routes ${groupPaths.filter((p, i) => JSON.stringify(p) === JSON.stringify(astarPaths[i])).length}`);

// Report timing, assert deterministic work counts rather than machine speed.
const benchmark = world();
const start = performance.now();
for (let i = 0; i < 1000; i++) route(benchmark, i);
console.log(`PASS: 1000 shared requests, ${benchmark.nodes} expansions, ${(performance.now() - start).toFixed(1)}ms; shortest paths, replay and movement checks passed.`);
