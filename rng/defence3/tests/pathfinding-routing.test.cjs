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

const unitContext = vm.createContext({ TILE: 32 });
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
for (const tile of [2, 4, 7]) {
    const u = shoved(tile), before = chargedEdges;
    u.followPath(4);
    assert.equal(u.pathIndex, tile + 1);
    assert.ok(u.vx > 0, 'steer forward after displacement');
    assert.equal(chargedEdges - before, tile, 'each consumed edge is charged once');
    assert.equal(u.path, shovePath);
    u.followPath(4);
    assert.equal(chargedEdges - before, tile, 'subsequent ticks do not recharge skipped nodes');
}
for (const [x, y] of [[0, 4], [4, 5], [8, 4]]) {
    const u = shoved(x, y);
    u.followPath(4);
    assert.equal(u.pathIndex, 1, 'previous, off-route and beyond-lookahead tiles do not skip');
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

// Report timing, assert deterministic work counts rather than machine speed.
const benchmark = world();
const start = performance.now();
for (let i = 0; i < 1000; i++) route(benchmark, i);
console.log(`PASS: 1000 shared requests, ${benchmark.nodes} expansions, ${(performance.now() - start).toFixed(1)}ms; shortest paths, replay and movement checks passed.`);
