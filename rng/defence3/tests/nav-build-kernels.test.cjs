// The navigation build's exit nodes and exit graph (kernels SIM_KERNEL_NAV_NODES
// and SIM_KERNEL_NAV_GRAPH, flownav.js) against a plain reference (the
// cluster-by-cluster loops they replaced): nodes, their order and pairs,
// edges, their order and costs, and the bucket count equal on random maps
// (sizes not multiples of the cluster size, both cluster sizes, with and
// without step costs), built at once and as the background stages of a
// rebuild (navBuildNodesBackground ... navBuildGraphBackground).
// Usage: node tests/nav-build-kernels.test.cjs
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = { console, Math, Uint8Array, Uint16Array, Int32Array, Float64Array, Uint32Array, Int8Array, Map, Set, Array, Object, Number };
ctx.globalThis = ctx;
vm.createContext(ctx);
// (Kernels run on this thread; background chains at their wait.)
vm.runInContext(`var SIM_KERNELS = {}; var _simParams = new Float64Array(64); var _simParReg = {};
    var _stage = Array.from({ length: 10 }, () => Array.from({ length: 8 }, () => new Float64Array(64))); var _simBgParams = _stage[1][0];
    var SIM_LANE_LONG = 1, _bgJob = null;
    function simSharedArray(T, n) { return new T(n); } function simParallelBind(n, a) { _simParReg[n] = a; }
    function simParallelRun(k, total) { for (let c = 0; c < total; c++) SIM_KERNELS[k](_simParReg, _simParams, c); }
    function simParallelStageParams(lane, st) { return _stage[lane][st]; }
    function simParallelBackgroundChain(lane, stages) { simParallelBackgroundWait(lane); _bgJob = { lane, stages }; }
    function simParallelBackground(k, total, lane = 1) { simParallelBackgroundChain(lane, [[k, total]]); }
    function simParallelBackgroundWait(lane = 1) { const J = _bgJob; if (!J || J.lane !== lane) return; _bgJob = null;
        J.stages.forEach(([k, total], i) => { for (let c = 0; c < total; c++) SIM_KERNELS[k](_simParReg, _stage[lane][i], c); }); }`, ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/game/flownav.js'), 'utf8'), ctx);

// The reference: nodes cluster by cluster (east and south borders make both
// sides), then each node's edges from the local fields and its pair.
function refNodes(W, H, C, wall) {
    const cw = Math.ceil(W / C), ch = Math.ceil(H / C), nc = cw * ch, SPAN = C >> 1;
    const clusterOf = t => { const x = t % W, y = (t - x) / W; return ((y / C) | 0) * cw + ((x / C) | 0); };
    const tiles = [], pairs = [], per = Array.from({ length: nc }, () => []);
    const add = (a, b) => { const ia = tiles.length; tiles.push(a); pairs.push(ia + 1); const ib = tiles.length; tiles.push(b); pairs.push(ia); per[clusterOf(a)].push(ia); per[clusterOf(b)].push(ib); };
    for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
        const x0 = cx * C, y0 = cy * C, x1 = Math.min(W, x0 + C) - 1, y1 = Math.min(H, y0 + C) - 1;
        if (x1 + 1 < W) { let st = -1; for (let y = y0; y <= y1 + 1; y++) { const ok = y <= y1 && !wall[y * W + x1] && !wall[y * W + x1 + 1]; if (ok && st < 0) st = y; const len = st < 0 ? 0 : (ok ? y - st + 1 : y - st); if (st >= 0 && (!ok || len === SPAN)) { const yy = st + (len >> 1); add(yy * W + x1, yy * W + x1 + 1); st = -1; } } }
        if (y1 + 1 < H) { let st = -1; for (let x = x0; x <= x1 + 1; x++) { const ok = x <= x1 && !wall[y1 * W + x] && !wall[(y1 + 1) * W + x]; if (ok && st < 0) st = x; const len = st < 0 ? 0 : (ok ? x - st + 1 : x - st); if (st >= 0 && (!ok || len === SPAN)) { const xx = st + (len >> 1); add(y1 * W + xx, (y1 + 1) * W + xx); st = -1; } } }
    }
    const order = [], base = [];
    for (let c = 0; c < nc; c++) { base.push(order.length); for (const i of per[c].slice(0, 250)) order.push(i); }
    base.push(order.length);
    const renum = new Int32Array(tiles.length).fill(-1);
    order.forEach((i, k) => { renum[i] = k; });
    return { base, tile: order.map(i => tiles[i]), pair: order.map(i => renum[pairs[i]]) };
}
function refGraph(b) {
    const { k, nc, cw, C, W, nodeBase, nodeTile, nodePair, fields, cost } = b, CC = C * C, start = [], adj = [], adjC = [];
    for (let c = 0; c < nc; c++) {
        const cx = c % cw, cy = (c - cx) / cw;
        for (let i = nodeBase[c]; i < nodeBase[c + 1]; i++) {
            start.push(adj.length);
            const t = nodeTile[i], lx = t % W - cx * C, ly = ((t - t % W) / W) - cy * C;
            for (let j = nodeBase[c]; j < nodeBase[c + 1]; j++) { if (j === i) continue; const v = fields[j * CC + ly * C + lx]; if (v !== 0xFFFF) { adj.push(j); adjC.push(v); } }
            if (nodePair[i] >= 0) { adj.push(nodePair[i]); adjC.push(cost ? cost[nodeTile[nodePair[i]]] : 1); }
        }
    }
    start.push(adj.length);
    return { start, adj, adjC, B: adjC.reduce((m, v) => Math.max(m, v), 0) + 1 };
}
const same = (a, b) => a.length === b.length && Array.prototype.every.call(a, (v, i) => v === b[i]);
let s = 4711, fails = 0, maps = 0;
const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
for (const [W, H, density, costs] of [[200, 150, 0.15, true], [333, 517, 0.3, true], [600, 600, 0.05, false], [64, 64, 0.45, true], [700, 530, 0.2, true], [97, 413, 0.6, false]]) {
    const wall = new Uint8Array(W * H);
    for (let i = 0; i < W * H * density / 8; i++) {
        const x = Math.floor(rnd() * W), y = Math.floor(rnd() * H), len = 1 + Math.floor(rnd() * 15), hor = rnd() < 0.5;
        for (let j = 0; j < len; j++) { const xx = hor ? x + j : x, yy = hor ? y : y + j; if (xx < W && yy < H) wall[yy * W + xx] = 1; }
    }
    // At once, and as a rebuild's stages.
    const now = ctx.navBuild(0, wall, costs, W, H);
    const st = ctx.navBuildStart(0, wall, costs, W, H);
    ctx.navBuildNodesBackground(st); ctx.navBuildCollect(); ctx.navBuildNodesFinish(st);
    ctx.navBuildLocalBackground(st); ctx.navBuildCollect(); ctx.navBuildGraphAlloc(st);
    ctx.navBuildGraphBackground(st); ctx.navBuildCollect(); ctx.navBuildGraphFinish(st); ctx.navBuildPartsFinish(st);
    const staged = ctx.navBuildFinish(st);
    for (const [name, b] of [['now', now], ['staged', staged]]) {
        const rn = refNodes(W, H, b.C, wall), rg = refGraph(b);
        const checks = { nodeBase: same(b.nodeBase, rn.base), nodeTile: same(b.nodeTile.subarray(0, b.k), rn.tile), nodePair: same(b.nodePair.subarray(0, b.k), rn.pair),
            adjStart: same(b.adjStart, rg.start), adjA: same(b.adjA.subarray(0, rg.adj.length), rg.adj) && b.adjA.length === Math.max(1, rg.adj.length),
            adjC: same(b.adjC.subarray(0, rg.adjC.length), rg.adjC), B: b.B === rg.B };
        for (const [k, ok] of Object.entries(checks)) if (!ok) { fails++; console.log('DIFF', name, W, H, k); }
    }
    for (const k of ['fields', 'partL', 'partComp', 'compParts', 'cost']) if (now[k] && !same(now[k], staged[k])) { fails++; console.log('DIFF now/staged', W, H, k); }
    maps++;
}
if (fails) { console.log('FAIL', fails); process.exit(1); }
console.log('PASS: nav build kernels', maps, 'maps');
