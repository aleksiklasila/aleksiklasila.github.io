// The A* engine (pathfinding.js findPathAStar) and the group routes: units
// no longer use them (every unit's way is on the flow navigation, flownav.js;
// tests/nav-reach.test.cjs); kept for tools, checked here as a library.
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
        // (The heap helpers as plain memory: no wasm in this library check.)
        simSharedArray: (T, n) => new T(n), simHeapHas: () => true, simHeapFree: () => {},
        _normalizeOwnerId: owner => owner == null ? -1 : owner,
        towers: [], grid: Array.from({ length: h }, () => Array.from({ length: w }, () => ({ type: 0 })))
    });
    vm.runInContext(read('src/utils/utils_common.js') + '\nlet pathfindBudget = 0;' + constants + '\n' + code, c);
    // (Region labels without the kernels: one region of every open tile, so
    // the search never takes the other-region shortcut here; pathfinding.js
    // getPathRegions and its kernels: tests/path-regions-*.test.cjs.)
    c.getPathRegions = () => { const L = new Int32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) L[y * w + x] = c.grid[y][x].type === 1 ? -1 : 0; return L; };
    c.nodes = 0;
    c._tryConsumeAstarNodeBudget = () => { c.nodes++; return true; };
    return c;
}
function route(c, id, sx = 145, sy = 85, ex = 5, ey = 10) {
    return c.findPathAStarTagged('player_commands', sx, sy, ex, ey, false, null, 0);
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
        const actual = m.findPathAStarTagged('player_commands', 1, 1, 24, 20, false, null, 0, null, false);
        assert.equal(actual?.length, expected?.length, `shortest path: scenario ${scenario}, unit ${id}`);
        if (actual) assert.ok(m._isPathValidForScenario(actual, 1, 1, 24, 20, false, null, 0, true));
    }
}
// A restricted walk profile must retain its wall-pass permissions.
const special = world(20, 20);
for (const row of special.grid) row[10].type = 1;
const canWalk = (x, y) => x === 10 && y === 8;
canWalk._pathProfileKey = 'test-worker';
const workerPath = special.findPathAStarTagged('worker_ai', 1, 1, 18, 18, false, canWalk, 0);
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
const mineWalker = roomy.findPathAStarTagged('worker_ai', 3, 6, 26, 10, false, passMine, 0);
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

// Group orders: one shared reverse search gives every unit its own shortest
// path. Compare with per-unit A* on a map with a gate and a block.
const obstacles = [];
for (let y = 15; y < 70; y++) if (y < 38 || y > 42) for (let x = 35; x <= 37; x++) obstacles.push([x, y]);
for (let y = 22; y <= 32; y++) for (let x = 50; x <= 58; x++) obstacles.push([x, y]);
const gw = world(160, 100);
for (const [x, y] of obstacles) gw.grid[y][x].type = 1;
const groupStarts = Array.from({ length: 150 }, (_, i) => ({ x: 4 + i % 15, y: 45 + Math.floor(i / 15) }));
const groupPaths = gw.findGroupPathsToTarget(groupStarts, 72, 12, null, 0);
const astarPaths = groupStarts.map((s, i) => gw.findPathAStarTagged('player_commands', s.x, s.y, 72, 12, false, null, 0));
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
groupStarts.forEach((s, i) => gw.findPathAStarTagged('player_commands', s.x, s.y, 72, 12, false, null, 0));
assert.ok(groupNodes * 3 < gw.nodes, `shared search expands far fewer nodes: ${groupNodes} vs ${gw.nodes}`);

console.log(`group order: ${groupNodes} vs ${gw.nodes} nodes; identical routes ${groupPaths.filter((p, i) => JSON.stringify(p) === JSON.stringify(astarPaths[i])).length}`);

// Report timing, assert deterministic work counts rather than machine speed.
const benchmark = world();
const start = performance.now();
for (let i = 0; i < 1000; i++) route(benchmark, i);
console.log(`PASS: 1000 shared requests, ${benchmark.nodes} expansions, ${(performance.now() - start).toFixed(1)}ms; shortest paths, replay and movement checks passed.`);
