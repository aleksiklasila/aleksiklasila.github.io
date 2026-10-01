"use strict";
// ============================================================
// FLOW NAVIGATION: the next step from any tile toward any tile, O(1)
// ============================================================
// No unit searches for a path. The map is cut into clusters (NAV_C x NAV_C
// tiles); where walkable tiles face each other across a cluster border they
// form exits (spans of at most C / 2 tiles, one node on each side). The
// navigation data (a pure function of the walkable tiles and step costs):
//  - per cluster and exit node, a local field: every tile's cost to reach
//    that node inside the cluster;
//  - hop[from cluster][to cluster]: the exit of `from` to take toward `to`
//    (one Dijkstra over the exit graph per destination cluster);
//  - near a destination (its 3x3 cluster block), a field toward the exact
//    tile, made on first use and cached (navDestField).
// A step: at most a destination field read, or a hop read and a local field
// read (navStep, and the same in SIM_KERNEL_MOVE). Steps cost more next to
// walls (stepCostTable), so units keep to the middle of corridors.
// The data is built by navBuild; it only changes when navPublish installs a
// new build (on every peer at the same tick), so it may be computed ahead,
// off the simulation thread.

const NAV_UNREACHED = 0xFFFF;
const NAV_PROFILE_GROUND = 0, NAV_PROFILE_AIR = 1;

// One build: { C, cw, ch, nc, W, H, profile,
//   wall, cost: the walls it was made for (a copy) and their step costs,
//   nodeBase: Int32Array(nc + 1) (a cluster's nodes are nodeBase[c]..),
//   nodeTile, nodePair (the node across the border), fields: Uint16Array
//   (per node C * C costs, cluster-local row-major, at node * C * C),
//   hop: Uint8Array(nc * nc) (exit index, 255 none; the same cluster 254) }
// Made in stages (navBuildStart, navBuildLocal, navBuildGraph, navBuildHop,
// navBuildFinish) so that a rebuild can be spread over ticks (navTick); the
// two heavy ones run as kernels on the helpers.
const SIM_KERNEL_NAV_LOCAL = 15, SIM_KERNEL_NAV_HOP = 16;
function navBuild(profile, wall, costs, W, H) {
    const b = navBuildStart(profile, wall, !!costs, W, H);
    navBuildNodes(b);
    navBuildLocal(b, 0, b.k);
    navBuildGraph(b);
    navBuildHop(b, 0, b.nc);
    return navBuildFinish(b);
}
// The walls (copied) and room for their step costs, bound for the kernels.
function navBuildStart(profile, wallLive, withCosts, W, H) {
    // (A build's background stage still running reads the names bound here.)
    if (typeof simParallelBackgroundWait === 'function') simParallelBackgroundWait();
    const C = Math.max(W, H) > 512 ? 32 : 16;
    const wall = simSharedArray(Uint8Array, W * H);
    wall.set(wallLive.length === W * H ? wallLive : wallLive.subarray(0, W * H));
    const cost = withCosts ? simSharedArray(Uint8Array, W * H) : null, h = withCosts ? simSharedArray(Uint8Array, W * H) : null;
    const cw = Math.ceil(W / C), ch = Math.ceil(H / C), nc = cw * ch;
    const bld = { profile, C, cw, ch, nc, W, H, k: 0, wall, cost, h, nodeBase: null, nodeTile: null, nodePair: null, fields: null,
        adjStart: null, adjA: null, adjC: null, B: 1, hop: null };
    simParallelBind('navb.wall', wall); simParallelBind('navb.cost', cost || _navNoCost); if (h) simParallelBind('navb.h', h);
    return bld;
}
// Step costs per tile (see navStepCosts; by the kernels; flyers pay 1
// everywhere), exit nodes and the field storage.
function navBuildNodes(bld) {
    const { W, H, C, cw, ch, nc, wall, cost } = bld, NAV_SPAN = C >> 1;
    if (cost) {
        const P = _simParams, rows = 32;
        P[3] = W; P[4] = H; P[2] = rows; P[0] = 0;
        simParallelRun(SIM_KERNEL_NAV_COST, Math.ceil(H / rows));
        P[0] = 1;
        simParallelRun(SIM_KERNEL_NAV_COST, Math.ceil(H / rows));
        bld.h = null;
    }
    // Exit nodes, cluster by cluster (east and south borders make both sides).
    const tiles = [], clusters = [], pairs = [];
    const perCluster = Array.from({ length: nc }, () => []);
    const addPair = (a, b) => {
        const ca = _navClusterOf(a, W, C, cw), cb = _navClusterOf(b, W, C, cw);
        const ia = tiles.length; tiles.push(a); clusters.push(ca); pairs.push(ia + 1);
        const ib = tiles.length; tiles.push(b); clusters.push(cb); pairs.push(ia);
        perCluster[ca].push(ia); perCluster[cb].push(ib);
    };
    for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
        const x0 = cx * C, y0 = cy * C, x1 = Math.min(W, x0 + C) - 1, y1 = Math.min(H, y0 + C) - 1;
        // East border (x1 | x1 + 1), rows y0..y1.
        if (x1 + 1 < W) {
            let start = -1;
            for (let y = y0; y <= y1 + 1; y++) {
                const ok = y <= y1 && !wall[y * W + x1] && !wall[y * W + x1 + 1];
                if (ok && start < 0) start = y;
                const len = start < 0 ? 0 : (ok ? y - start + 1 : y - start);
                if (start >= 0 && (!ok || len === NAV_SPAN)) {
                    const yy = start + (len >> 1);
                    addPair(yy * W + x1, yy * W + x1 + 1);
                    start = -1;
                }
            }
        }
        if (y1 + 1 < H) {
            let start = -1;
            for (let x = x0; x <= x1 + 1; x++) {
                const ok = x <= x1 && !wall[y1 * W + x] && !wall[(y1 + 1) * W + x];
                if (ok && start < 0) start = x;
                const len = start < 0 ? 0 : (ok ? x - start + 1 : x - start);
                if (start >= 0 && (!ok || len === NAV_SPAN)) {
                    const xx = start + (len >> 1);
                    addPair(y1 * W + xx, (y1 + 1) * W + xx);
                    start = -1;
                }
            }
        }
    }
    const n = tiles.length;
    const nodeBase = simSharedArray(Int32Array, nc + 1), order = new Int32Array(n);
    let k = 0;
    for (let c = 0; c < nc; c++) { nodeBase[c] = k; if (perCluster[c].length > 250) perCluster[c].length = 250; for (const i of perCluster[c]) order[k++] = i; }
    nodeBase[nc] = k;
    const renum = new Int32Array(n).fill(-1);
    for (let i = 0; i < k; i++) renum[order[i]] = i;
    const nodeTile = simSharedArray(Int32Array, Math.max(1, k)), nodePair = simSharedArray(Int32Array, Math.max(1, k));
    for (let i = 0; i < k; i++) { nodeTile[i] = tiles[order[i]]; nodePair[i] = renum[pairs[order[i]]]; }
    // (Each node's field is preset by the kernel that makes it.)
    const CC = C * C, fields = simSharedArray(Uint16Array, Math.max(1, k * CC));
    bld.k = k; bld.nodeBase = nodeBase; bld.nodeTile = nodeTile; bld.nodePair = nodePair; bld.fields = fields;
    _navBuildBind(bld);
}
// The build's arrays for the kernels (a new build is bound once; helpers
// get them before its first kernel runs, a tick later when staggered).
function _navBuildBind(b) {
    simParallelBind('navb.wall', b.wall); simParallelBind('navb.cost', b.cost || _navNoCost);
    simParallelBind('navb.nt', b.nodeTile); simParallelBind('navb.nb', b.nodeBase); simParallelBind('navb.np', b.nodePair);
    simParallelBind('navb.fields', b.fields);
    if (b.adjStart) { simParallelBind('navb.adjS', b.adjStart); simParallelBind('navb.adjA', b.adjA); simParallelBind('navb.adjC', b.adjC); simParallelBind('navb.hop', b.hop); }
}
const _navNoCost = new Uint8Array(0);
function _navBuildParams(b, P = _simParams) {
    P[3] = b.W; P[4] = b.H; P[5] = b.C; P[6] = b.cw; P[7] = b.nc; P[8] = b.k; P[9] = b.B; P[10] = b.adjA ? b.adjA.length : 0;
    return P;
}
// The local fields of all nodes, or the hop table, as a background job
// (simParallelBackground): collected by navBuildCollect before the next stage.
function navBuildLocalBackground(b) {
    if (b.k <= 0) return;
    const P = _navBuildParams(b, _simBgParams), per = 32;
    P[0] = 0; P[1] = b.k; P[2] = per;
    simParallelBackground(SIM_KERNEL_NAV_LOCAL, Math.ceil(b.k / per));
}
function navBuildHopBackground(b) {
    if (b.nc <= 0) return;
    const P = _navBuildParams(b, _simBgParams), per = 4;
    P[0] = 0; P[1] = b.nc; P[2] = per;
    simParallelBackground(SIM_KERNEL_NAV_HOP, Math.ceil(b.nc / per));
}
function navBuildCollect() { simParallelBackgroundWait(); }
// Local fields of nodes i0..i1-1 (Dijkstra inside the cluster from each).
function navBuildLocal(b, i0, i1) {
    if (i1 <= i0) return;
    const P = _navBuildParams(b), per = 32;
    P[0] = i0; P[1] = i1; P[2] = per;
    simParallelRun(SIM_KERNEL_NAV_LOCAL, Math.ceil((i1 - i0) / per));
}
SIM_KERNELS[SIM_KERNEL_NAV_LOCAL] = function (R, P, chunk) {
    const wall = R['navb.wall'], costR = R['navb.cost'], nt = R['navb.nt'], fields = R['navb.fields'];
    const cost = costR && costR.length ? costR : null;
    const W = P[3] | 0, H = P[4] | 0, C = P[5] | 0, cw = P[6] | 0, CC = C * C;
    const S = _navKernelScratch || (_navKernelScratch = _navDialScratch(CC));
    for (let i = (P[0] | 0) + chunk * P[2], end = Math.min(P[1], i + P[2]); i < end; i++) {
        const t = nt[i], c = _navClusterOf(t, W, C, cw), cx = c % cw, cy = (c - cx) / cw;
        fields.fill(NAV_UNREACHED, i * CC, (i + 1) * CC);
        _navLocalFieldDial(fields, i * CC, cx * C, cy * C, W, H, t, wall, cost, C, C, S);
    }
};
let _navKernelScratch = null;
// navStepCosts by rows (P[2] a job): pass P[0] 0 the rows' horizontal
// reach flags into navb.h (bit 0: a wall within 1, bit 1: within 2), pass 1
// the costs from those of the rows around.
const SIM_KERNEL_NAV_COST = 18;
SIM_KERNELS[SIM_KERNEL_NAV_COST] = function (R, P, chunk) {
    const wall = R['navb.wall'], h = R['navb.h'], out = R['navb.cost'], W = P[3] | 0, H = P[4] | 0;
    const y0 = chunk * P[2], y1 = Math.min(H, y0 + P[2]);
    if (P[0] === 0) {
        for (let y = y0; y < y1; y++) {
            const o = y * W;
            for (let x = 0; x < W; x++) {
                let a1 = (wall[o + x] || x < 1 || x >= W - 1 || wall[o + x - 1] || wall[o + x + 1]) ? 1 : 0;
                let a2 = (a1 || x < 2 || x >= W - 2 || wall[o + x - 2] || wall[o + x + 2]) ? 2 : 0;
                h[o + x] = a1 | a2;
            }
        }
        return;
    }
    for (let y = y0; y < y1; y++) {
        const o = y * W;
        for (let x = 0; x < W; x++) {
            const t = o + x;
            if ((h[t] & 1) || y < 1 || y >= H - 1 || (h[t - W] & 1) || (h[t + W] & 1)) { out[t] = 3; continue; }
            out[t] = ((h[t] & 2) || y < 2 || y >= H - 2 || (h[t - W] & 2) || (h[t + W] & 2) || (h[t - 2 * W] & 2) || (h[t + 2 * W] & 2)) ? 2 : 1;
        }
    }
};
// Abstract graph: intra-cluster edges (costs from the local fields) and
// the border crossings (the step cost of the tile entered).
function navBuildGraph(b) {
    const { k, nc, cw, C, W, nodeBase, nodeTile, nodePair, fields, cost } = b, CC = C * C;
    const adjStart = simSharedArray(Int32Array, k + 1), adj = [], adjCost = [];
    for (let c = 0; c < nc; c++) {
        const cx = c % cw, cy = (c - cx) / cw, b0 = nodeBase[c], b1 = nodeBase[c + 1];
        for (let i = b0; i < b1; i++) {
            adjStart[i] = adj.length;
            const t = nodeTile[i], lx = t % W - cx * C, ly = ((t - t % W) / W) - cy * C;
            for (let j = b0; j < b1; j++) {
                if (j === i) continue;
                const v = fields[j * CC + ly * C + lx];
                if (v !== NAV_UNREACHED) { adj.push(j); adjCost.push(v); }
            }
            const p = nodePair[i];
            if (p >= 0) { adj.push(p); adjCost.push(cost ? cost[nodeTile[p]] : 1); }
        }
    }
    adjStart[k] = adj.length;
    const adjA = simSharedArray(Int32Array, Math.max(1, adj.length)), adjC = simSharedArray(Int32Array, Math.max(1, adj.length));
    adjA.set(adj); adjC.set(adjCost);
    let maxEdge = 0;
    for (let e = 0; e < adjCost.length; e++) if (adjCost[e] > maxEdge) maxEdge = adjCost[e];
    b.adjStart = adjStart; b.adjA = adjA; b.adjC = adjC; b.B = maxEdge + 1;
    b.hop = simSharedArray(Uint8Array, nc * nc);
    b.hop.fill(255);
    _navBuildBind(b);
}
// hop[a][d] for destination clusters d0..d1-1: for each, a Dijkstra toward
// d's nodes (reversed edges: the graph is symmetric in steps, not in costs;
// the cost of reaching node j from i is taken as i -> j's, close enough for
// choosing an exit), then each cluster's cheapest node.
function navBuildHop(b, d0, d1) {
    if (d1 <= d0) return;
    const P = _navBuildParams(b), per = 4;
    P[0] = d0; P[1] = d1; P[2] = per;
    simParallelRun(SIM_KERNEL_NAV_HOP, Math.ceil((d1 - d0) / per));
}
SIM_KERNELS[SIM_KERNEL_NAV_HOP] = function (R, P, chunk) {
    const nb = R['navb.nb'], np = R['navb.np'], adjStart = R['navb.adjS'], adjA = R['navb.adjA'], adjC = R['navb.adjC'], hop = R['navb.hop'];
    const nc = P[7] | 0, k = P[8] | 0, B = P[9] | 0, edges = P[10] | 0;
    let S = _navHopScratch;
    if (!S || S.dist.length < k || S.head.length < B || S.val.length < edges + k + 16) {
        S = _navHopScratch = { dist: new Int32Array(Math.max(1, k)), head: new Int32Array(Math.max(1, B)), val: new Int32Array(edges + k + 16), nxt: new Int32Array(edges + k + 16) };
    }
    const dist = S.dist, head = S.head, val = S.val, nxt = S.nxt, INF = 0x3fffffff;
    for (let d = (P[0] | 0) + chunk * P[2], end = Math.min(P[1], d + P[2]); d < end; d++) {
        hop[d * nc + d] = 254;
        const b0 = nb[d], b1 = nb[d + 1];
        if (b0 === b1) continue;
        dist.fill(INF, 0, k); head.fill(-1, 0, B);
        // Dijkstra with a bucket queue (Dial): costs are small integers.
        // Every push lowers a distance, so the pool (edges + nodes) holds
        // them all. Only the distances matter below.
        let pool = 0, count = 0;
        for (let i = b0; i < b1; i++) { dist[i] = 0; val[pool] = i; nxt[pool] = head[0]; head[0] = pool++; count++; }
        for (let cur = 0; count > 0; cur++) {
            const bk = cur % B;
            // (Zero-cost edges add to the bucket being emptied: again.)
            while (head[bk] !== -1) {
                let e = head[bk]; head[bk] = -1;
                while (e !== -1) {
                    const u = val[e], en = nxt[e]; count--;
                    if (dist[u] === cur) {
                        for (let x = adjStart[u], x1 = adjStart[u + 1]; x < x1; x++) {
                            const v = adjA[x], nd = cur + adjC[x];
                            if (nd < dist[v]) {
                                dist[v] = nd;
                                const nbk = nd % B; val[pool] = v; nxt[pool] = head[nbk]; head[nbk] = pool++; count++;
                            }
                        }
                    }
                    e = en;
                }
            }
        }
        for (let a = 0; a < nc; a++) {
            if (a === d) continue;
            let best = 255, bd = INF;
            for (let i = nb[a]; i < nb[a + 1]; i++) {
                // Leaving through node i: cross to its pair (the pair's
                // distance), since i itself is in a.
                const p = np[i];
                const di = p >= 0 ? dist[p] : INF;
                if (di < bd) { bd = di; best = i - nb[a]; }
            }
            hop[a * nc + d] = best;
        }
    }
};
let _navHopScratch = null;
function navBuildFinish(b) {
    return { profile: b.profile, C: b.C, cw: b.cw, ch: b.ch, nc: b.nc, W: b.W, H: b.H, nodeBase: b.nodeBase, nodeTile: b.nodeTile, nodePair: b.nodePair,
        fields: b.fields, hop: b.hop, wall: b.wall, cost: b.cost };
}

// Step costs (the rule of _stepCostAt in pathfinding.js): 3 within one
// tile (any direction; the map's edge counts as wall) of a wall, 2 within
// two, else 1. Two separable dilations, O(tiles).
function navStepCosts(wall, W, H) {
    const N = W * H, h1 = new Uint8Array(N), h2 = new Uint8Array(N), out = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
        const o = y * W;
        for (let x = 0; x < W; x++) {
            let a1 = wall[o + x] ? 1 : 0;
            if (x < 1 || x >= W - 1 || wall[o + x - 1] || wall[o + x + 1]) a1 = 1;
            let a2 = a1;
            if (!a2 && (x < 2 || x >= W - 2 || wall[o + x - 2] || wall[o + x + 2])) a2 = 1;
            h1[o + x] = a1; h2[o + x] = a2;
        }
    }
    for (let y = 0; y < H; y++) {
        const o = y * W;
        for (let x = 0; x < W; x++) {
            const t = o + x;
            if (h1[t] || y < 1 || y >= H - 1 || h1[t - W] || h1[t + W]) { out[t] = 3; continue; }
            out[t] = (h2[t] || y < 2 || y >= H - 2 || h2[t - W] || h2[t + W] || h2[t - 2 * W] || h2[t + 2 * W]) ? 2 : 1;
        }
    }
    return out;
}
// The bucket pool is full: rebuilt from its live entries (an entry is live
// when its node's distance puts it in the bucket it sits in).
function _navDialCompact(head, nxt, val, dist, B, cap) {
    const keepV = [], keepB = [];
    for (let b = 0; b < B; b++) for (let e = head[b]; e !== -1; e = nxt[e]) if (dist[val[e]] % B === b) { keepV.push(val[e]); keepB.push(b); }
    head.fill(-1);
    let p = 0;
    for (let i = 0; i < keepV.length && p < cap; i++) { val[p] = keepV[i]; nxt[p] = head[keepB[i]]; head[keepB[i]] = p++; }
    return p;
}
function _navDialScratch(n) { return { q: [new Int32Array(n * 3), new Int32Array(n * 3), new Int32Array(n * 3), new Int32Array(n * 3)], n: new Int32Array(4) }; }
// Costs to reach `target` from every tile of the box (bx, by, bw x bh),
// into out[off + local index] (preset to NAV_UNREACHED). Stepping onto a
// tile costs that tile's cost (1..3: a queue of 4 buckets); walls are never
// entered.
function _navLocalFieldDial(out, off, bx, by, W, H, target, wall, cost, bw, bh, S) {
    const tx = target % W, ty = (target - tx) / W;
    const lx0 = tx - bx, ly0 = ty - by;
    if (lx0 < 0 || ly0 < 0 || lx0 >= bw || ly0 >= bh) return;
    if (S.q[0].length < bw * bh * 3) for (let i = 0; i < 4; i++) S.q[i] = new Int32Array(bw * bh * 3);
    const Q = S.q, N = S.n;
    N[0] = N[1] = N[2] = N[3] = 0;
    out[off + ly0 * bw + lx0] = 0;
    Q[0][N[0]++] = ly0 * bw + lx0;
    let pending = 1;
    for (let d = 0; pending > 0; d++) {
        const b = d & 3, q = Q[b];
        // (Nothing joins the bucket being emptied: every step costs >= 1.)
        for (let i = 0; i < N[b]; i++) {
            const l = q[i]; pending--;
            if (out[off + l] !== d) continue;
            const lx = l % bw, ly = (l - lx) / bw, x = bx + lx, y = by + ly, t = y * W + x;
            const nd = d + (cost ? cost[t] : 1);
            if (nd > 0xFFFE) continue;
            const nq = Q[nd & 3], nb = nd & 3;
            if (lx + 1 < bw && x + 1 < W && !wall[t + 1] && nd < out[off + l + 1]) { out[off + l + 1] = nd; nq[N[nb]++] = l + 1; pending++; }
            if (lx > 0 && !wall[t - 1] && nd < out[off + l - 1]) { out[off + l - 1] = nd; nq[N[nb]++] = l - 1; pending++; }
            if (ly + 1 < bh && y + 1 < H && !wall[t + W] && nd < out[off + l + bw]) { out[off + l + bw] = nd; nq[N[nb]++] = l + bw; pending++; }
            if (ly > 0 && !wall[t - W] && nd < out[off + l - bw]) { out[off + l - bw] = nd; nq[N[nb]++] = l - bw; pending++; }
        }
        N[b] = 0;
    }
}

function _navClusterOf(t, W, C, cw) { const x = t % W, y = (t - x) / W; return ((y / C) | 0) * cw + ((x / C) | 0); }

// Small binary heaps (key, value).
class _NavHeap {
    constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.size = 0; }
    clear() { this.size = 0; }
    push(key, val) {
        if (this.size >= this.k.length) { const k2 = new Float64Array(this.k.length * 2), v2 = new Int32Array(this.v.length * 2); k2.set(this.k); v2.set(this.v); this.k = k2; this.v = v2; }
        const K = this.k, V = this.v;
        let i = this.size++;
        while (i > 0) { const p = (i - 1) >> 1; if (K[p] < key || (K[p] === key && V[p] <= val)) break; K[i] = K[p]; V[i] = V[p]; i = p; }
        K[i] = key; V[i] = val;
    }
    topKey() { return this.k[0]; }
    pop() {
        const K = this.k, V = this.v, top = V[0], n = --this.size, lk = K[n], lv = V[n];
        let i = 0;
        for (;;) {
            let c = 2 * i + 1;
            if (c >= n) break;
            if (c + 1 < n && (K[c + 1] < K[c] || (K[c + 1] === K[c] && V[c + 1] < V[c]))) c++;
            if (K[c] > lk || (K[c] === lk && V[c] >= lv)) break;
            K[i] = K[c]; V[i] = V[c]; i = c;
        }
        K[i] = lk; V[i] = lv;
        return top;
    }
}
const _NavQueue = _NavHeap;

// ---- The installed builds (per profile) and destination fields ----
let _nav = [null, null];
// Destination fields: costs to reach tile `dest` from every tile of a box
// around it, one field a slot of a shared pool with its meta [profile,
// dest, bx, by, bw, bh, gen, made]. Two sizes: narrow (dest's cluster; a
// worker's task, a lone unit's way) and wide (the 3x3 clusters around it:
// a group's destination, so a crowd comes in along the whole front, not
// through the cluster's exits). Slot ids: narrow ones as they are, wide
// ones NAV_WIDE_BASE + slot.
// Requests (navFieldRequest) are made by the kernels at the flush point
// (navFieldsFlush: every tick after the orders, before anything moves). A
// route asked for before the flush uses its field this tick, asked after
// it from the next: the tick is kept with the route (a node's `ready`, the
// unit's mvReady column), so whether this peer happened to have the field
// already never changes what units do. Fields no route refers to are
// dropped by a staggered sweep (memory only); every field is made again
// when a new build is installed; a restore makes those of every route
// (navFieldsRestore).
const NAV_FIELD_META = 8, NAV_FIELD_SWEEP_TICKS = 64, NAV_WIDE_BASE = 1 << 22;
function _navNewPool(wide) { return { wide, span: 0, C: 0, cap: 0, pool: null, meta: null, byKey: new Map(), free: [], pending: [], seen: null }; }
const _navFields = { pools: [_navNewPool(false), _navNewPool(true)], seenCycle: 0, flushedTick: -1 };
function _navFieldKey(profile, dest) { return profile * 16777216 + dest; }
function _navPoolEnsure(F, C) {
    if (F.C === C && F.pool) return F;
    F.C = C; F.span = F.wide ? 3 * C : C; F.cap = 0; F.pool = null; F.meta = null; F.byKey = new Map(); F.free = []; F.pending = []; F.seen = null;
    _navFieldsGrow(F, F.wide ? 64 : 1024);
    return F;
}
function _navFieldsGrow(F, cap) {
    const size = F.span * F.span, pool = simSharedArray(Uint16Array, cap * size), meta = simSharedArray(Int32Array, cap * NAV_FIELD_META), seen = new Int32Array(cap);
    if (F.pool) { pool.set(F.pool); meta.set(F.meta); seen.set(F.seen); }
    for (let s = cap - 1; s >= F.cap; s--) { F.free.push(s); meta[s * NAV_FIELD_META] = -1; }
    F.pool = pool; F.meta = meta; F.seen = seen; F.cap = cap;
    const w = F.wide ? 1 : 0;
    simParallelBind('nav.fpool.' + w, pool); simParallelBind('nav.fmeta.' + w, meta);
}
// The pool and index of a slot id.
function _navFieldPool(id) { return id >= NAV_WIDE_BASE ? _navFields.pools[1] : _navFields.pools[0]; }
function _navFieldIndex(id) { return id >= NAV_WIDE_BASE ? id - NAV_WIDE_BASE : id; }
// Whether a route asked for now uses its field this tick (asked before the
// tick's flush) or the next.
function navFieldReadyTick() { return _navFields.flushedTick === gameTime ? gameTime + 1 : gameTime; }
// The slot id of the field toward `dest` (profile; wide or narrow), asked
// for if new; -1 without a build.
function navFieldRequest(profile, dest, wide = false) {
    const nav = _nav[profile];
    if (!nav || !(dest >= 0 && dest < nav.W * nav.H)) return -1;
    const F = _navPoolEnsure(_navFields.pools[wide ? 1 : 0], nav.C), key = _navFieldKey(profile, dest);
    let s = F.byKey.get(key);
    if (s === undefined) {
        if (!F.free.length) _navFieldsGrow(F, F.cap * 2);
        s = F.free.pop();
        const { C, cw, W, H } = nav, c = _navClusterOf(dest, W, C, cw), cx = c % cw, cy = (c - cx) / cw, m = s * NAV_FIELD_META;
        const bx = wide ? Math.max(0, (cx - 1) * C) : cx * C, by = wide ? Math.max(0, (cy - 1) * C) : cy * C;
        const ex = Math.min(W, (cx + (wide ? 2 : 1)) * C), ey = Math.min(H, (cy + (wide ? 2 : 1)) * C);
        F.meta[m] = profile; F.meta[m + 1] = dest; F.meta[m + 2] = bx; F.meta[m + 3] = by; F.meta[m + 4] = ex - bx; F.meta[m + 5] = ey - by;
        F.meta[m + 6]++; F.meta[m + 7] = 0;
        F.byKey.set(key, s);
        F.pending.push(s);
        // (Kept this sweep cycle; after it, while a unit's route or path
        // leads to it: navFieldsSweepStep. Asking again marks nothing, or
        // eviction would depend on which units ran Unit.update.)
        F.seen[s] = _navFields.seenCycle + 1;
    }
    return wide ? NAV_WIDE_BASE + s : s;
}
function navFieldGen(id) { return id >= 0 ? _navFieldPool(id).meta[_navFieldIndex(id) * NAV_FIELD_META + 6] : 0; }
// Makes the fields asked for (every tick, after the orders; see above).
function navFieldsFlush() {
    _navFields.flushedTick = gameTime;
    for (const F of _navFields.pools) if (F.pending.length) { _navFieldsMake(F, F.pending); F.pending = []; }
    navFieldsSweepStep();
}
function _navFieldsMake(F, slots) {
    if (!slots.length) return;
    slots.sort((a, b) => a - b);
    const list = simSharedArray(Int32Array, slots.length);
    list.set(slots);
    simParallelBind('nav.flist', list);
    for (let p = 0; p < 2; p++) {
        const nav = _nav[p];
        if (!nav) continue;
        simParallelBind('nav.fwall.' + p, nav.wall); simParallelBind('nav.fcost.' + p, nav.cost || _navNoCost);
    }
    const P = _simParams, per = F.wide ? 1 : 8;
    P[0] = slots.length; P[1] = per; P[2] = F.span; P[3] = _nav[0] ? _nav[0].W : GRID_W; P[4] = _nav[0] ? _nav[0].H : GRID_H; P[5] = F.wide ? 1 : 0;
    simParallelRun(SIM_KERNEL_NAV_FIELDS, Math.ceil(slots.length / per));
}
const SIM_KERNEL_NAV_FIELDS = 21;
SIM_KERNELS[SIM_KERNEL_NAV_FIELDS] = function (R, P, chunk) {
    const w = P[5] | 0, list = R['nav.flist'], pool = R['nav.fpool.' + w], meta = R['nav.fmeta.' + w];
    const span = P[2] | 0, size = span * span, W = P[3] | 0, H = P[4] | 0;
    const S = _navKernelScratch && _navKernelScratch.q[0].length >= size * 3 ? _navKernelScratch : (_navKernelScratch = _navDialScratch(size));
    for (let i = chunk * P[1], end = Math.min(P[0], i + P[1]); i < end; i++) {
        const s = list[i], m = s * NAV_FIELD_META, p = meta[m];
        const wall = R['nav.fwall.' + p], costR = R['nav.fcost.' + p];
        if (!wall) continue;
        const cost = costR && costR.length ? costR : null;
        pool.fill(NAV_UNREACHED, s * size, s * size + size);
        _navLocalFieldDial(pool, s * size, meta[m + 2], meta[m + 3], W, H, meta[m + 1], wall, cost, meta[m + 4], meta[m + 5], S);
        meta[m + 7] = 1;
    }
};
// Staggered sweep: over NAV_FIELD_SWEEP_TICKS ticks every unit marks the
// fields its route refers to (requests mark theirs); then the fields not
// marked in the cycle are dropped. (Memory only: a route's field is never
// dropped while it is followed.)
function _navFieldMark(profile, dest, wide, mark) {
    const F = _navFields.pools[wide ? 1 : 0], s = F.byKey.get(_navFieldKey(profile, dest));
    if (s !== undefined) F.seen[s] = mark;
}
function navFieldsSweepStep() {
    const step = NAV_FIELD_SWEEP_TICKS, k = gameTime % step, mark = _navFields.seenCycle + 1;
    for (let i = k, n = units.length; i < n; i += step) {
        const u = units[i];
        if (!u || u.dead) continue;
        const p = navProfileOf(u);
        if (u._routeKey === NAV_ROUTE_KEY && u._routeEnd >= 0) _navFieldMark(p, u._routeEnd, true, mark);
        const path = u.path;
        if (path && path.length) { const nd = path[path.length - 1]; if (nd && nd.nav) _navFieldMark(nd.nav - 1, nd.y * GRID_W + nd.x, !!nd.w, mark); }
    }
    if (k !== step - 1) return;
    for (const F of _navFields.pools) {
        if (!F.pool) continue;
        for (const [key, s] of F.byKey) {
            if (F.seen[s] >= mark) continue;
            F.byKey.delete(key); F.meta[s * NAV_FIELD_META] = -1; F.meta[s * NAV_FIELD_META + 6]++; F.free.push(s);
        }
        F.pending = F.pending.filter(s => F.meta[s * NAV_FIELD_META] >= 0);
    }
    _navFields.seenCycle++;
}
// Every field again (a new build installed).
function _navFieldsRemakeAll() {
    for (const F of _navFields.pools) {
        if (!F.pool) continue;
        const all = [];
        for (const s of F.byKey.values()) all.push(s);
        _navFieldsMake(F, all);
        F.pending = [];
    }
}
// After a restore: the fields of every route, made now.
function navFieldsRestore() {
    for (const u of units) {
        if (!u || u.dead) continue;
        const p = navProfileOf(u);
        if (u._routeKey === NAV_ROUTE_KEY && u._routeEnd >= 0) navFieldRequest(p, u._routeEnd, true);
        const path = u.path;
        if (path) for (const nd of path) if (nd && nd.nav) navFieldRequest(nd.nav - 1, nd.y * GRID_W + nd.x, !!nd.w);
    }
    for (const F of _navFields.pools) if (F.pending.length) { _navFieldsMake(F, F.pending); F.pending = []; }
}
// A group's destination field (wide).
function navDestField(profile, dest) { return navFieldRequest(profile, dest, true); }
let _navQ = null;
function _navScratchDial() { if (!_navQ) _navQ = _navDialScratch(1024); return _navQ; }

function navWallTable(profile) {
    return profile === NAV_PROFILE_AIR ? _airWallTable() : simMoveWallGrid();
}

// Installs a build as the current one for its profile (every peer at the
// same tick). Destination fields of the old build are dropped.
let _navVersion = 0;
function navPublish(nav) {
    _nav[nav.profile] = nav;
    _navVersion++;
    const p = nav.profile;
    simParallelBind('nav.' + p + '.fields', nav.fields); simParallelBind('nav.' + p + '.hop', nav.hop);
    const meta = simSharedArray(Int32Array, 8);
    meta[0] = nav.C; meta[1] = nav.cw; meta[2] = nav.ch; meta[3] = nav.nc; meta[4] = nav.W; meta[5] = nav.H; meta[6] = _navVersion;
    simParallelBind('nav.' + p + '.meta', meta);
    simParallelBind('nav.' + p + '.nb', nav.nodeBase); simParallelBind('nav.' + p + '.nt', nav.nodeTile); simParallelBind('nav.' + p + '.np', nav.nodePair);
    // Every destination field again over the new build (same slots: the
    // routes keep following them).
    for (const F of _navFields.pools) _navPoolEnsure(F, nav.C);
    _navFieldsRemakeAll();
    if (p === NAV_PROFILE_GROUND) _navWallDiffReset();
}

// The current build of a profile, made now when there is none (the map's
// first) or the map size changed.
function navEnsure(profile) {
    let nav = _nav[profile];
    if (nav && nav.W === GRID_W && nav.H === GRID_H) return nav;
    const wall = navWallTable(profile);
    nav = navBuild(profile, wall, profile === NAV_PROFILE_GROUND, GRID_W, GRID_H);
    navPublish(nav);
    return nav;
}
function navReset() {
    // (A build's background stage: finished, its result dropped.)
    if (typeof simParallelBackgroundWait === 'function') simParallelBackgroundWait();
    for (const F of _navFields.pools) {
        if (F.meta) for (const s of F.byKey.values()) { F.meta[s * NAV_FIELD_META] = -1; F.meta[s * NAV_FIELD_META + 6]++; F.free.push(s); }
        F.byKey = new Map(); F.pending = [];
    }
    _navFields.flushedTick = -1;
    _nav = [null, null];
    _navJob = null; _navWallDiff = 0;
}

// The next tile from `t` toward `dest` (profile), -1 when there is no way
// (or `t` is `dest`). `destId`: its destination field (navDestField).
function navStep(profile, t, dest, destId) {
    const nav = _nav[profile];
    if (!nav || t === dest) return -1;
    const F = destId >= 0 ? _navFieldPool(destId) : null, i = destId >= 0 ? _navFieldIndex(destId) : 0, m = i * NAV_FIELD_META;
    const has = !!(F && F.meta && F.meta[m] === profile && F.meta[m + 1] === dest && F.meta[m + 7] === 1);
    return simNavStep(nav.W, nav.C, nav.cw, nav.nc, nav.hop, nav.fields, nav.nodeBase, nav.nodeTile, nav.nodePair,
        has ? F.pool : null, has ? i * F.span * F.span : 0, has ? F.meta[m + 2] : 0, has ? F.meta[m + 3] : 0, has ? F.meta[m + 4] : 0, has ? F.meta[m + 5] : 0, t, dest);
}


// Units on the flow navigation carry u._routeKey = NAV_ROUTE_KEY and their
// destination tile in u._routeEnd (both snapshotted). Where Unit.update
// needs a path of theirs (near things to react to, the interface), it walks
// the navigation: navPath.
const NAV_ROUTE_KEY = 'nav';
function navProfileOf(u) { return u && u.isFlying ? NAV_PROFILE_AIR : NAV_PROFILE_GROUND; }
// Up to maxLen tiles from (gx, gy) toward dest (the start first), as path
// nodes; null when the navigation has no way from there. For the interface:
// it changes nothing (a destination field it would ask for, or a build,
// would exist on the peer that shows the unit only): an existing field of
// the destination when there is one, else the coarse steps.
function navPath(profile, gx, gy, dest, maxLen) {
    const nav = _nav[profile];
    if (!nav || !(dest >= 0 && dest < nav.W * nav.H)) return null;
    const W = GRID_W, F = _navFields.pools[1], s = F && F.byKey ? F.byKey.get(_navFieldKey(profile, dest)) : undefined;
    const did = s === undefined ? -1 : NAV_WIDE_BASE + s;
    let t = gy * W + gx;
    const path = [{ x: gx, y: gy }];
    while (t !== dest && path.length < maxLen) {
        const n = navStep(profile, t, dest, did);
        if (n < 0) return path.length > 1 ? path : null;
        path.push({ x: n % W, y: (n - n % W) / W });
        t = n;
    }
    return path;
}

// A path node that means "on to tile (x, y) by the navigation": a unit
// steps toward it one tile at a time (Unit.followPath, or the movement
// kernel in flow mode), O(1) a tick. `ready`: the tick the route may start
// (its destination field is made by then; see navFieldReadyTick).
function navNode(profile, tx, ty) {
    navEnsure(profile);
    navFieldRequest(profile, ty * GRID_W + tx);
    return { x: tx, y: ty, nav: profile + 1, ready: navFieldReadyTick() };
}
// Where a unit goes to reach tile t (profile): t itself when open, else the
// nearest open tile around it (rings outward, up to NAV_APPROACH_MAX tiles;
// in each ring the order is fixed), -1 when none. A pure function of the
// walls (cached per wall version).
const NAV_APPROACH_MAX = 6;
let _navApproach = new Map(), _navApproachVer = -1;
function navApproachTile(profile, t) {
    const wall = navWallTable(profile), W = GRID_W, H = GRID_H;
    if (!(t >= 0 && t < W * H)) return -1;
    if (!wall[t]) return t;
    const ver = (typeof _simMoveWallVer === 'number' ? _simMoveWallVer : 0) * 2 + profile;
    if (_navApproachVer !== ver) { _navApproach = new Map(); _navApproachVer = ver; }
    let r = _navApproach.get(t);
    if (r !== undefined) return r;
    const tx = t % W, ty = (t - tx) / W;
    r = -1;
    for (let d = 1; d <= NAV_APPROACH_MAX && r < 0; d++) {
        let bestD = Infinity;
        for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
            const x = tx + dx, y = ty + dy;
            if (x < 0 || y < 0 || x >= W || y >= H || wall[y * W + x]) continue;
            // Nearest in steps, then the fixed scan order.
            const dd = Math.abs(dx) + Math.abs(dy);
            if (dd < bestD) { bestD = dd; r = y * W + x; }
        }
    }
    if (_navApproach.size > 65536) _navApproach = new Map();
    _navApproach.set(t, r);
    return r;
}
// The path for a unit going to tile (tx, ty): one nav node toward it (or
// the open tile nearest it), or null when there is none near.
function navPathTo(u, tx, ty) {
    if (!(tx >= 0 && ty >= 0 && tx < GRID_W && ty < GRID_H)) return null;
    const profile = navProfileOf(u), t = navApproachTile(profile, ty * GRID_W + tx);
    if (t < 0) return null;
    return [navNode(profile, t % GRID_W, (t - t % GRID_W) / GRID_W)];
}

// Walls changed: the ground navigation is built again, spread over ticks
// on every peer alike (navTick): the walls are copied at the start, the
// heavy stages (the local fields, then the hop table and the destination
// fields in use) run a slice a tick on the helpers, and the build is
// installed NAV_BUILD_TICKS after its start whatever the machine. Units
// follow the old one meanwhile (the kernel checks walls as they go). A new
// build starts once the last is installed, when the walls differ from the
// newest build's (_navWallDiff tiles: kept as walls change, and worked
// out again after a restore, which rebuilds from the snapshot's walls).
const NAV_BUILD_SLICES = 16;
const NAV_BUILD_TICKS = 2 * NAV_BUILD_SLICES + 4;
let _navJob = null, _navWallDiff = 0;
// Tiles whose walls differ from those of the newest build (the one being
// made, else the installed one).
function _navNewestWalls() { return _navJob ? _navJob.b.wall : (_nav[NAV_PROFILE_GROUND] ? _nav[NAV_PROFILE_GROUND].wall : null); }
function _navWallDiffReset() {
    const w = _navNewestWalls(), live = typeof _simMoveWall !== 'undefined' ? _simMoveWall : null;
    _navWallDiff = 0;
    if (!w || !live || live.length !== w.length) return;
    for (let i = 0; i < w.length; i++) if (w[i] !== live[i]) _navWallDiff++;
}
// A wall tile changed from `was` to `now` (simMoveTileTypeChanged).
function navWallChanged(t, was, now) {
    const w = _navNewestWalls();
    if (!w || t < 0 || t >= w.length) return;
    if (was !== w[t]) _navWallDiff--;
    if (now !== w[t]) _navWallDiff++;
}
function navTick() {
    if (!_nav[NAV_PROFILE_GROUND]) return;
    if (!_navJob) {
        if (_navWallDiff <= 0) return;
        _navJob = { start: gameTime, step: 0, b: null, dests: null, destNew: null };
    }
    const J = _navJob, off = gameTime - J.start;
    while (J.step <= off && _navJob === J) _navJobStep(J, J.step++);
}
// Step 0 copies the walls, 1 makes the costs and nodes and starts the local
// fields in the background (the helpers between the tick's other jobs), S+2
// collects them and makes the graph, then starts the hop table in the
// background, 2S+3 collects it and installs the build. The steps' ticks are
// those of the build's start alone: when the helpers finish never changes
// what any peer does (a collect waits, or runs what is left itself).
function _navJobStep(J, step) {
    const S = NAV_BUILD_SLICES;
    if (step === 0) {
        J.b = navBuildStart(NAV_PROFILE_GROUND, navWallTable(NAV_PROFILE_GROUND), true, GRID_W, GRID_H);
        _navWallDiffReset();
    } else if (step === 1) {
        navBuildNodes(J.b);
        navBuildLocalBackground(J.b);
    } else if (step === S + 2) {
        navBuildCollect();
        navBuildGraph(J.b);
        navBuildHopBackground(J.b);
    } else if (step === 2 * S + 3) {
        navBuildCollect();
        _navJob = null;
        navPublish(navBuildFinish(J.b));
    }
}
// Snapshots: the walls of the installed ground build and of one being made,
// as their differences from the live walls, and when that one started.
function navSnapshotState() {
    const live = typeof _simMoveWall !== 'undefined' ? _simMoveWall : null, nav = _nav[NAV_PROFILE_GROUND];
    if (!nav || !live || live.length !== nav.wall.length) return null;
    const diff = w => { const out = []; for (let i = 0; i < w.length; i++) if (w[i] !== live[i]) out.push(i, w[i]); return out; };
    return { built: diff(nav.wall), job: _navJob && _navJob.b ? { start: _navJob.start, step: _navJob.step, walls: diff(_navJob.b.wall) } : null };
}
// After a restore (the live walls restored): the same builds again.
function navRestoreState(st) {
    navReset();
    if (!st || !Array.isArray(st.built)) return;
    const live = simMoveWallGrid();
    const walls = d => { const w = new Uint8Array(live.length); w.set(live); if (Array.isArray(d)) for (let i = 0; i + 1 < d.length; i += 2) if (d[i] >= 0 && d[i] < w.length) w[d[i]] = d[i + 1] ? 1 : 0; return w; };
    navPublish(navBuild(NAV_PROFILE_GROUND, walls(st.built), true, GRID_W, GRID_H));
    if (st.job && Number.isFinite(st.job.start)) {
        // Its stages up to now run at once (the same result as spread out).
        const J = _navJob = { start: st.job.start, step: 0, b: null, dests: null, destNew: null };
        if (st.job.walls) {
            const w = walls(st.job.walls);
            // (Steps below `step` ran on the snapshot's peer.)
            const upTo = Math.min(Number(st.job.step) || 1, 2 * NAV_BUILD_SLICES + 3);
            J.b = navBuildStart(NAV_PROFILE_GROUND, w, true, GRID_W, GRID_H);
            J.step = 1;
            for (; J.step < upTo; J.step++) _navJobStep(J, J.step);
        }
        _navWallDiffReset();
    }
}
