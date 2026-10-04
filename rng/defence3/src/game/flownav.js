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
//  - parts: a cluster's walkable tiles connected inside it (an exit serves
//    the part it is in; walls may split a cluster, a maze many times), and
//    components: the parts connected through exits (who can reach whom);
//  - per destination (made on first use and cached, navFieldRequest): a
//    field toward the exact tile over the clusters around it, and a row of
//    every part's exit toward it (one search over the exit graph, by the
//    helpers).
// A step: at most a destination field read, or a row read and a local field
// read (navStep, and the same in SIM_KERNEL_MOVE). Steps cost more next to
// walls (stepCostTable), so units keep to the middle of corridors.
// A destination a unit cannot reach (another component, or walls all around
// it): it goes to the closest tile it can reach, worked out by the helpers
// (navPathSubstitute). Nothing on the simulation thread searches: a unit's
// way is O(1) there, whatever the map.
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
//   partL: Uint16Array per tile (its part in its cluster, 0xFFFF a wall),
//   partBase: Int32Array(nc + 1) (a cluster's parts are partBase[c]..),
//   nodePart, partComp (component per part), partCluster, compStart /
//   compParts (a component's parts, by part), adjStart / adjA / adjC (the
//   exit graph) }
// Made in stages (navBuildStart, navBuildNodes, navBuildLocal,
// navBuildGraph, navBuildParts, navBuildFinish) so that a rebuild can be
// spread over ticks (navTick): every pass over the map or the nodes is a
// kernel (on the helpers); the simulation thread only does O(clusters +
// nodes) bookkeeping between them (navBuildNodesFinish, navBuildGraphAlloc,
// navBuildPartsFinish).
const SIM_KERNEL_NAV_LOCAL = 15, SIM_KERNEL_NAV_PARTS = 16, SIM_KERNEL_NAV_NODES = 57, SIM_KERNEL_NAV_GRAPH = 58;
const NAV_NODES_PER_JOB = 16, NAV_GRAPH_PER_JOB = 256, NAV_LOCAL_PER_JOB = 32, NAV_COST_ROWS = 32;
function navBuild(profile, wall, costs, W, H) {
    const b = navBuildStart(profile, wall, !!costs, W, H);
    navBuildNodes(b);
    navBuildLocal(b);
    navBuildGraph(b);
    navBuildParts(b);
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
    const partL = simSharedArray(Uint16Array, W * H), partN = simSharedArray(Int32Array, nc);
    // (A cluster's exit nodes before they are numbered: NM slots each (a
    // border has at most C / 2 spans), and their count per border.)
    const NM = 2 * C, ns = simSharedArray(Int32Array, Math.max(1, nc * NM)), nsc = simSharedArray(Int32Array, Math.max(1, nc * 4));
    const bld = { profile, C, cw, ch, nc, W, H, k: 0, wall, cost, h, nodeBase: null, nodeTile: null, nodePair: null, fields: null,
        adjStart: null, adjA: null, adjC: null, adjN: null, adjMax: null, B: 1, partL, partN, NM, ns, nsc };
    simParallelBind('navb.wall', wall); simParallelBind('navb.cost', cost || _navNoCost); if (h) simParallelBind('navb.h', h);
    simParallelBind('navb.partL', partL); simParallelBind('navb.partN', partN);
    simParallelBind('navb.ns', ns); simParallelBind('navb.nsc', nsc);
    return bld;
}
// Step costs per tile (see navStepCosts; by the kernels; flyers pay 1
// everywhere), then the exit nodes (SIM_KERNEL_NAV_NODES) and their
// numbering, now.
function navBuildNodes(b) {
    if (b.cost) {
        const P = _navBuildParams(b);
        P[2] = NAV_COST_ROWS; P[0] = 0;
        simParallelRun(SIM_KERNEL_NAV_COST, Math.ceil(b.H / NAV_COST_ROWS));
        P[0] = 1;
        simParallelRun(SIM_KERNEL_NAV_COST, Math.ceil(b.H / NAV_COST_ROWS));
    }
    if (b.nc > 0) {
        const P = _navBuildParams(b);
        P[0] = 0; P[1] = b.nc; P[2] = NAV_NODES_PER_JOB;
        simParallelRun(SIM_KERNEL_NAV_NODES, Math.ceil(b.nc / NAV_NODES_PER_JOB));
    }
    navBuildNodesFinish(b);
}
// The same as a background chain (lane SIM_LANE_LONG): taken by
// navBuildCollect, then navBuildNodesFinish.
function navBuildNodesBackground(b) {
    const lane = _navBuildLane(), stages = [];
    for (let pass = 0; pass < 2; pass++) {
        const P = _navStageParams(b, lane, pass);
        P[0] = pass; P[2] = NAV_COST_ROWS;
        stages.push([SIM_KERNEL_NAV_COST, b.cost ? Math.ceil(b.H / NAV_COST_ROWS) : 0]);
    }
    const P = _navStageParams(b, lane, 2);
    P[0] = 0; P[1] = b.nc; P[2] = NAV_NODES_PER_JOB;
    stages.push([SIM_KERNEL_NAV_NODES, Math.ceil(b.nc / NAV_NODES_PER_JOB)]);
    simParallelBackgroundChain(lane, stages);
}
// Exit nodes (SIM_KERNEL_NAV_NODES, P[2] clusters a job): where walkable
// tiles face each other across a cluster border, spans of at most C / 2
// tiles, a node at each span's middle on either side. A cluster's nodes on
// its side, by border N, W, E, S (each along it): navb.ns (P[11] slots a
// cluster), their counts navb.nsc (4 a cluster). A border's spans are the
// same seen from either side: its nodes pair by their place.
SIM_KERNELS[SIM_KERNEL_NAV_NODES] = function (R, P, chunk) {
    const wall = R['navb.wall'], ns = R['navb.ns'], nsc = R['navb.nsc'];
    const W = P[3] | 0, H = P[4] | 0, C = P[5] | 0, cw = P[6] | 0, nc = P[7] | 0, NM = P[11] | 0, SPAN = C >> 1;
    for (let c = chunk * P[2], end = Math.min(nc, c + P[2]); c < end; c++) {
        const cx = c % cw, cy = (c - cx) / cw, x0 = cx * C, y0 = cy * C, x1 = Math.min(W, x0 + C) - 1, y1 = Math.min(H, y0 + C) - 1;
        const n0 = c * NM;
        let k = 0;
        // (Sides: 0 north (rows y0 - 1 | y0), 1 west (columns x0 - 1 | x0),
        // 2 east (x1 | x1 + 1), 3 south (y1 | y1 + 1).)
        for (let side = 0; side < 4; side++) {
            let cnt = 0;
            if (side === 0 ? cy > 0 : side === 1 ? cx > 0 : side === 2 ? x1 + 1 < W : y1 + 1 < H) {
                const along = side === 0 || side === 3, a0 = along ? x0 : y0, a1 = along ? x1 : y1;
                let start = -1;
                for (let a = a0; a <= a1 + 1; a++) {
                    let ok = false;
                    if (a <= a1) {
                        if (side === 0) ok = !wall[(y0 - 1) * W + a] && !wall[y0 * W + a];
                        else if (side === 1) ok = !wall[a * W + x0 - 1] && !wall[a * W + x0];
                        else if (side === 2) ok = !wall[a * W + x1] && !wall[a * W + x1 + 1];
                        else ok = !wall[y1 * W + a] && !wall[(y1 + 1) * W + a];
                    }
                    if (ok && start < 0) start = a;
                    const len = start < 0 ? 0 : (ok ? a - start + 1 : a - start);
                    if (start >= 0 && (!ok || len === SPAN)) {
                        const m = start + (len >> 1);
                        if (k < NM) ns[n0 + k] = side === 0 ? y0 * W + m : side === 1 ? m * W + x0 : side === 2 ? m * W + x1 : y1 * W + m;
                        k++; cnt++;
                        start = -1;
                    }
                }
            }
            nsc[c * 4 + side] = cnt;
        }
    }
};
// The nodes numbered cluster by cluster (nodeBase), each with the node
// across its border (nodePair), and the storage of their local fields.
function navBuildNodesFinish(b) {
    b.h = null;
    const { nc, cw, C, NM, ns, nsc } = b;
    const nodeBase = simSharedArray(Int32Array, nc + 1);
    let k = 0;
    for (let c = 0; c < nc; c++) { nodeBase[c] = k; k += Math.min(NM, nsc[c * 4] + nsc[c * 4 + 1] + nsc[c * 4 + 2] + nsc[c * 4 + 3]); }
    nodeBase[nc] = k;
    const nodeTile = simSharedArray(Int32Array, Math.max(1, k)), nodePair = simSharedArray(Int32Array, Math.max(1, k));
    for (let c = 0; c < nc; c++) {
        const b0 = nodeBase[c], n = nodeBase[c + 1] - b0, o = c * 4, nN = nsc[o], nW = nsc[o + 1], nE = nsc[o + 2];
        for (let i = 0; i < n; i++) {
            nodeTile[b0 + i] = ns[c * NM + i];
            // (North pairs with the south of the cluster above, west with the
            // east of the one to the left, and back.)
            let q, j;
            if (i < nN) { q = c - cw; j = nsc[q * 4] + nsc[q * 4 + 1] + nsc[q * 4 + 2] + i; }
            else if (i < nN + nW) { q = c - 1; j = nsc[q * 4] + nsc[q * 4 + 1] + (i - nN); }
            else if (i < nN + nW + nE) { q = c + 1; j = nsc[q * 4] + (i - nN - nW); }
            else { q = c + cw; j = i - nN - nW - nE; }
            nodePair[b0 + i] = j < nodeBase[q + 1] - nodeBase[q] ? nodeBase[q] + j : -1;
        }
    }
    // (Each node's field is preset by the kernel that makes it.)
    const CC = C * C, fields = simSharedArray(Uint16Array, Math.max(1, k * CC));
    const adjN = simSharedArray(Int32Array, Math.max(1, k));
    b.k = k; b.nodeBase = nodeBase; b.nodeTile = nodeTile; b.nodePair = nodePair; b.fields = fields; b.adjN = adjN;
    _navBuildBind(b);
    simParallelBind('navb.adjN', adjN);
}
// The build's arrays for the kernels (a new build is bound once; helpers
// get them before its first kernel runs, a tick later when staggered).
function _navBuildBind(b) {
    simParallelBind('navb.wall', b.wall); simParallelBind('navb.cost', b.cost || _navNoCost);
    simParallelBind('navb.nt', b.nodeTile); simParallelBind('navb.nb', b.nodeBase); simParallelBind('navb.np', b.nodePair);
    simParallelBind('navb.fields', b.fields);
    simParallelBind('navb.partL', b.partL); simParallelBind('navb.partN', b.partN);
}
const _navNoCost = new Uint8Array(0);
// A kernel's parameters: the build's (P[3..11]); the caller sets the range
// (P[0..2]) and the mode (P[12]).
function _navBuildParams(b, P = _simParams) {
    P[0] = P[1] = P[2] = P[12] = 0;
    P[3] = b.W; P[4] = b.H; P[5] = b.C; P[6] = b.cw; P[7] = b.nc; P[8] = b.k; P[9] = b.B; P[10] = b.adjA ? b.adjA.length : 0; P[11] = b.NM | 0;
    return P;
}
// A background chain stage's parameters (every one written: lane params
// persist between jobs).
function _navStageParams(b, lane, stage) {
    const P = simParallelStageParams(lane, stage);
    P.fill(0);
    return _navBuildParams(b, P);
}
function _navBuildLane() { return typeof SIM_LANE_LONG === 'number' ? SIM_LANE_LONG : 1; }
// The local fields of all nodes, then each node's edge count (the graph's,
// SIM_KERNEL_NAV_GRAPH mode 0), as a background chain: collected by
// navBuildCollect before the next stage.
function navBuildLocalBackground(b) {
    const lane = _navBuildLane();
    let P = _navStageParams(b, lane, 0);
    P[0] = 0; P[1] = b.k; P[2] = NAV_LOCAL_PER_JOB;
    P = _navStageParams(b, lane, 1);
    P[0] = 0; P[1] = b.k; P[2] = NAV_GRAPH_PER_JOB; P[12] = 0;
    simParallelBackgroundChain(lane, [[SIM_KERNEL_NAV_LOCAL, Math.ceil(b.k / NAV_LOCAL_PER_JOB)], [SIM_KERNEL_NAV_GRAPH, Math.ceil(b.k / NAV_GRAPH_PER_JOB)]]);
}
const NAV_PARTS_PER_JOB = 16;
// The graph's edges (SIM_KERNEL_NAV_GRAPH mode 1, after navBuildGraphAlloc)
// and the parts, as a background chain.
function navBuildGraphBackground(b) {
    const lane = _navBuildLane();
    let P = _navStageParams(b, lane, 0);
    P[0] = 0; P[1] = b.k; P[2] = NAV_GRAPH_PER_JOB; P[12] = 1;
    P = _navStageParams(b, lane, 1);
    P[0] = 0; P[1] = b.nc; P[2] = NAV_PARTS_PER_JOB;
    simParallelBackgroundChain(lane, [[SIM_KERNEL_NAV_GRAPH, Math.ceil(b.k / NAV_GRAPH_PER_JOB)], [SIM_KERNEL_NAV_PARTS, Math.ceil(b.nc / NAV_PARTS_PER_JOB)]]);
}
// The parts now (a build made at once), and what follows from them.
function navBuildParts(b) {
    if (b.nc > 0) {
        const P = _navBuildParams(b);
        P[0] = 0; P[1] = b.nc; P[2] = NAV_PARTS_PER_JOB;
        simParallelRun(SIM_KERNEL_NAV_PARTS, Math.ceil(b.nc / NAV_PARTS_PER_JOB));
    }
    navBuildPartsFinish(b);
}
// Parts per cluster (SIM_KERNEL_NAV_PARTS, P[2] clusters a job): the
// walkable tiles connected inside it (4-way, as units step), numbered in
// row-major order of their first tile: navb.partL per tile (0xFFFF a wall),
// navb.partN the count per cluster.
SIM_KERNELS[SIM_KERNEL_NAV_PARTS] = function (R, P, chunk) {
    const wall = R['navb.wall'], partL = R['navb.partL'], partN = R['navb.partN'];
    const W = P[3] | 0, H = P[4] | 0, C = P[5] | 0, cw = P[6] | 0, nc = P[7] | 0;
    let Q = _navPartsQ;
    if (!Q || Q.length < C * C) Q = _navPartsQ = new Int32Array(C * C);
    for (let c = chunk * P[2], end = Math.min(nc, c + P[2]); c < end; c++) {
        const cx = c % cw, cy = (c - cx) / cw, x0 = cx * C, y0 = cy * C, x1 = Math.min(W, x0 + C), y1 = Math.min(H, y0 + C);
        for (let y = y0; y < y1; y++) partL.fill(0xFFFF, y * W + x0, y * W + x1);
        let n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const t0 = y * W + x;
            if (wall[t0] || partL[t0] !== 0xFFFF) continue;
            partL[t0] = n;
            let qh = 0, qt = 0;
            Q[qt++] = t0;
            while (qh < qt) {
                const t = Q[qh++], tx = t % W, ty = (t - tx) / W;
                if (tx + 1 < x1 && !wall[t + 1] && partL[t + 1] === 0xFFFF) { partL[t + 1] = n; Q[qt++] = t + 1; }
                if (tx > x0 && !wall[t - 1] && partL[t - 1] === 0xFFFF) { partL[t - 1] = n; Q[qt++] = t - 1; }
                if (ty + 1 < y1 && !wall[t + W] && partL[t + W] === 0xFFFF) { partL[t + W] = n; Q[qt++] = t + W; }
                if (ty > y0 && !wall[t - W] && partL[t - W] === 0xFFFF) { partL[t - W] = n; Q[qt++] = t - W; }
            }
            n++;
        }
        partN[c] = n;
    }
};
let _navPartsQ = null;
// From the parts: their numbering (partBase), each node's part, the
// components (parts joined by an exit and its pair; a component numbered
// by its first part) and each component's parts. O(clusters + nodes +
// parts), at a build's end.
function navBuildPartsFinish(b) {
    const { nc, k, nodeBase, nodeTile, nodePair, partL, partN } = b;
    const partBase = simSharedArray(Int32Array, nc + 1);
    let np = 0;
    for (let c = 0; c < nc; c++) { partBase[c] = np; np += partN[c]; }
    partBase[nc] = np;
    const partCluster = simSharedArray(Int32Array, Math.max(1, np));
    for (let c = 0; c < nc; c++) for (let p = partBase[c]; p < partBase[c + 1]; p++) partCluster[p] = c;
    const nodePart = simSharedArray(Int32Array, Math.max(1, k));
    for (let c = 0; c < nc; c++) for (let i = nodeBase[c]; i < nodeBase[c + 1]; i++) nodePart[i] = partBase[c] + partL[nodeTile[i]];
    // (Union-find; a set's root its smallest part.)
    const uf = new Int32Array(np);
    for (let p = 0; p < np; p++) uf[p] = p;
    const find = x => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };
    for (let i = 0; i < k; i++) {
        const j = nodePair[i];
        if (j < 0) continue;
        const a = find(nodePart[i]), c = find(nodePart[j]);
        if (a < c) uf[c] = a; else if (c < a) uf[a] = c;
    }
    const partComp = simSharedArray(Int32Array, Math.max(1, np)), compOfRoot = new Int32Array(np).fill(-1);
    let ncomp = 0;
    for (let p = 0; p < np; p++) { const r = find(p); if (compOfRoot[r] < 0) compOfRoot[r] = ncomp++; partComp[p] = compOfRoot[r]; }
    const compStart = simSharedArray(Int32Array, ncomp + 1), compParts = simSharedArray(Int32Array, Math.max(1, np));
    for (let p = 0; p < np; p++) compStart[partComp[p] + 1]++;
    for (let i = 0; i < ncomp; i++) compStart[i + 1] += compStart[i];
    const fill = new Int32Array(ncomp);
    for (let p = 0; p < np; p++) { const q = partComp[p]; compParts[compStart[q] + fill[q]++] = p; }
    b.np = np; b.partBase = partBase; b.partCluster = partCluster; b.nodePart = nodePart; b.partComp = partComp;
    b.ncomp = ncomp; b.compStart = compStart; b.compParts = compParts;
}
function navBuildCollect() { simParallelBackgroundWait(_navBuildLane()); }
// Local fields of the nodes (Dijkstra inside the cluster from each), now.
function navBuildLocal(b) {
    if (b.k <= 0) return;
    const P = _navBuildParams(b);
    P[0] = 0; P[1] = b.k; P[2] = NAV_LOCAL_PER_JOB;
    simParallelRun(SIM_KERNEL_NAV_LOCAL, Math.ceil(b.k / NAV_LOCAL_PER_JOB));
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
// the border crossings (the step cost of the tile entered), now: the edge
// counts, their places, the edges.
function navBuildGraph(b) {
    if (b.k > 0) {
        const P = _navBuildParams(b);
        P[0] = 0; P[1] = b.k; P[2] = NAV_GRAPH_PER_JOB; P[12] = 0;
        simParallelRun(SIM_KERNEL_NAV_GRAPH, Math.ceil(b.k / NAV_GRAPH_PER_JOB));
    }
    navBuildGraphAlloc(b);
    if (b.k > 0) {
        const P = _navBuildParams(b);
        P[0] = 0; P[1] = b.k; P[2] = NAV_GRAPH_PER_JOB; P[12] = 1;
        simParallelRun(SIM_KERNEL_NAV_GRAPH, Math.ceil(b.k / NAV_GRAPH_PER_JOB));
    }
    navBuildGraphFinish(b);
}
// Each node's first edge (adjStart: the counts summed) and the edge arrays.
function navBuildGraphAlloc(b) {
    const k = b.k, N = b.adjN, adjStart = simSharedArray(Int32Array, k + 1);
    let e = 0;
    for (let i = 0; i < k; i++) { adjStart[i] = e; e += N[i]; }
    adjStart[k] = e;
    b.adjStart = adjStart; b.adjA = simSharedArray(Int32Array, Math.max(1, e)); b.adjC = simSharedArray(Int32Array, Math.max(1, e));
    b.adjMax = simSharedArray(Int32Array, Math.max(1, Math.ceil(k / NAV_GRAPH_PER_JOB)));
    simParallelBind('navb.adjS', adjStart); simParallelBind('navb.adjA', b.adjA); simParallelBind('navb.adjC', b.adjC); simParallelBind('navb.adjMax', b.adjMax);
}
// The graph's bucket count (largest edge + 1) from the jobs' largest.
function navBuildGraphFinish(b) {
    let m = 0;
    for (let i = 0; i < b.adjMax.length; i++) if (b.adjMax[i] > m) m = b.adjMax[i];
    b.B = m + 1;
    b.adjN = null; b.adjMax = null;
}
// The exit graph (SIM_KERNEL_NAV_GRAPH, P[2] nodes a job). Mode P[12] 0:
// each node's edge count into navb.adjN; 1: its edges from navb.adjS on
// (navb.adjA the node, navb.adjC the cost) and the job's largest cost into
// navb.adjMax. A node's edges: the other nodes of its cluster whose local
// field reaches its tile (by node, that field's value), then the node
// across its border (the step cost of that node's tile).
SIM_KERNELS[SIM_KERNEL_NAV_GRAPH] = function (R, P, chunk) {
    const fields = R['navb.fields'], nt = R['navb.nt'], nb = R['navb.nb'], np = R['navb.np'], costR = R['navb.cost'];
    const cost = costR && costR.length ? costR : null;
    const W = P[3] | 0, C = P[5] | 0, cw = P[6] | 0, CC = C * C, fill = P[12] === 1;
    const N = R['navb.adjN'], S = fill ? R['navb.adjS'] : null, A = fill ? R['navb.adjA'] : null, AC = fill ? R['navb.adjC'] : null;
    let mx = 0;
    for (let i = (P[0] | 0) + chunk * P[2], end = Math.min(P[1], i + P[2]); i < end; i++) {
        const t = nt[i], tx = t % W, ty = (t - tx) / W, cx = (tx / C) | 0, cy = (ty / C) | 0, c = cy * cw + cx, b0 = nb[c], b1 = nb[c + 1];
        const loc = (ty - cy * C) * C + (tx - cx * C);
        let e = fill ? S[i] : 0, n = 0;
        for (let j = b0; j < b1; j++) {
            if (j === i) continue;
            const v = fields[j * CC + loc];
            if (v === NAV_UNREACHED) continue;
            if (fill) { A[e] = j; AC[e] = v; e++; if (v > mx) mx = v; } else n++;
        }
        const p = np[i];
        if (p >= 0) {
            if (fill) { const v = cost ? cost[nt[p]] : 1; A[e] = p; AC[e] = v; e++; if (v > mx) mx = v; } else n++;
        }
        if (!fill) N[i] = n;
    }
    if (fill) R['navb.adjMax'][chunk] = mx;
};
function navBuildFinish(b) {
    return { profile: b.profile, C: b.C, cs: 31 - Math.clz32(b.C), cw: b.cw, ch: b.ch, nc: b.nc, W: b.W, H: b.H, k: b.k,
        nodeBase: b.nodeBase, nodeTile: b.nodeTile, nodePair: b.nodePair, fields: b.fields, wall: b.wall, cost: b.cost,
        adjStart: b.adjStart, adjA: b.adjA, adjC: b.adjC, B: b.B,
        partL: b.partL, partBase: b.partBase, np: b.np, nodePart: b.nodePart, partComp: b.partComp, partCluster: b.partCluster,
        ncomp: b.ncomp, compStart: b.compStart, compParts: b.compParts };
}
// A destination's row (in the field kernel, after its field): every part's
// exit toward it (the exit's index among its cluster's nodes; 254: the
// field covers it; 255: no way). One Dijkstra over the exit graph from the
// nodes inside the field that reach the destination there (reversed edges:
// the graph is symmetric in steps, not in costs; the cost of reaching node
// j from i is taken as i -> j's, close enough for choosing an exit), then
// each part's cheapest node to leave by (crossing to its pair).
// (pre: the build's names, 'nav.' the installed one's, 'navn.' the next's:
// _navNextStage.)
function _navFieldRow(R, p, pool, off, meta, m, rows, ro, pre = 'nav.') {
    const NM = R[pre + p + '.meta'];
    if (!NM) return;
    const C = NM[0] | 0, cw = NM[1] | 0, nc = NM[3] | 0, W = NM[4] | 0, np = NM[7] | 0, B = Math.max(1, NM[8] | 0), k = NM[9] | 0, edges = NM[10] | 0;
    const nb = R[pre + p + '.nb'], nt = R[pre + p + '.nt'], npair = R[pre + p + '.np'], npart = R[pre + p + '.npart'];
    const adjStart = R[pre + p + '.adjS'], adjA = R[pre + p + '.adjA'], adjC = R[pre + p + '.adjC'];
    const partL = R[pre + p + '.partL'], partB = R[pre + p + '.partB'];
    rows.fill(255, ro, ro + np);
    if (!nb || !npart || !adjStart || !partL) return;
    let S = _navRowScratch;
    if (!S || S.dist.length < k || S.head.length < B || S.val.length < edges + k + 16 || S.best.length < np) {
        S = _navRowScratch = { dist: new Int32Array(Math.max(1, k)), head: new Int32Array(Math.max(1, B)), val: new Int32Array(edges + k + 16),
            nxt: new Int32Array(edges + k + 16), best: new Int32Array(Math.max(1, np)) };
    }
    const dist = S.dist, head = S.head, val = S.val, nxt = S.nxt, best = S.best, INF = 0x3fffffff;
    const dest = meta[m + 1], bx = meta[m + 2], by = meta[m + 3], bw = meta[m + 4], bh = meta[m + 5];
    // (The destination's own part: the field, even without exits.)
    if (partL[dest] !== 0xFFFF) { const dx = dest % W, dc = ((((dest - dx) / W) / C) | 0) * cw + ((dx / C) | 0); rows[ro + partB[dc] + partL[dest]] = 254; }
    dist.fill(INF, 0, k); head.fill(-1, 0, B);
    // Dijkstra with a bucket queue (Dial): costs are small integers. Every
    // push lowers a distance, so the pool (edges + nodes) holds them all.
    let pool0 = 0, count = 0;
    const cx0 = (bx / C) | 0, cy0 = (by / C) | 0, cx1 = ((bx + bw - 1) / C) | 0, cy1 = ((by + bh - 1) / C) | 0;
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * cw + cx;
        for (let i = nb[c]; i < nb[c + 1]; i++) {
            const t = nt[i], tx = t % W, ty = (t - tx) / W;
            if (pool[off + (ty - by) * bw + (tx - bx)] === NAV_UNREACHED) continue;
            // (Its part reaches the destination inside the field.)
            rows[ro + npart[i]] = 254;
            dist[i] = 0; val[pool0] = i; nxt[pool0] = head[0]; head[0] = pool0++; count++;
        }
    }
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
                            const nbk = nd % B; val[pool0] = v; nxt[pool0] = head[nbk]; head[nbk] = pool0++; count++;
                        }
                    }
                }
                e = en;
            }
        }
    }
    best.fill(INF, 0, np);
    for (let c = 0; c < nc; c++) for (let i = nb[c]; i < nb[c + 1]; i++) {
        const q = npart[i];
        if (rows[ro + q] === 254) continue;
        // Leaving through node i: cross to its pair (the pair's distance).
        const j = npair[i], di = j >= 0 ? dist[j] : INF;
        if (di < best[q]) { best[q] = di; rows[ro + q] = i - nb[c]; }
    }
}
let _navRowScratch = null;

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
// (The sweep over 128 ticks: at 64 its share of the units' objects cost ~1.3
// ms a tick at 200k.)
// Each slot also holds its destination's row (rows, rowW bytes a slot: every
// part's exit toward it, see _navFieldRow); rowW follows the builds' part
// counts (nav.fhdr[w]).
const NAV_FIELD_META = 8, NAV_FIELD_SWEEP_TICKS = 128, NAV_WIDE_BASE = 1 << 22;
// (rowSrc: a slot holding each row made under the installed builds, by row
// key: the destination's part (rows depend on that alone, see _navFieldRow);
// rowKeyOf: each slot's.)
function _navNewPool(wide) { return { wide, span: 0, C: 0, cap: 0, pool: null, meta: null, rows: null, rowW: 0, byKey: new Map(), free: [], pending: [], seen: null, rowSrc: new Map(), rowKeyOf: null }; }
const _navFields = { pools: [_navNewPool(false), _navNewPool(true)], seenCycle: 0, flushedTick: -1, hdr: null };
// A rebuild's window (NAV_SWAP_TICKS ticks, _navJobStep): the next build
// made but not installed; every live field made over it in the background
// (SIM_LANE_NAVX) into second arrays (per pool: pool, rows, row keys and
// sources, the same slots), the fields asked for meanwhile over both builds
// (their jobs' second batches); at the window's end both installed at once
// (_navNextInstall), the same tick on every peer: no tick makes them all.
const NAV_SWAP_TICKS = 10;
const _navNext = { nav: null, rowW: 0, pools: [null, null] };
function _navFieldKey(profile, dest) { return profile * 16777216 + dest; }
function _navPoolEnsure(F, C) {
    if (F.C === C && F.pool) return F;
    // (The fields' job finished; its slots of this pool dropped: new ones.)
    _navFieldsLaneWait();
    const J = _navFieldsJob.slots;
    if (J) { const keep = []; for (let i = 0; i < J.length; i += 3) if (J[i] !== F) keep.push(J[i], J[i + 1], J[i + 2]); _navFieldsJob.slots = keep.length ? keep : null; }
    F.C = C; F.span = F.wide ? 3 * C : C; F.cap = 0; F.pool = null; F.meta = null; F.rows = null; F.byKey = new Map(); F.free = []; F.pending = []; F.seen = null; F.remake = null;
    F.rowSrc = new Map(); F.rowKeyOf = null;
    _navFieldsGrow(F, F.wide ? 64 : 1024);
    return F;
}
function _navFieldsGrow(F, cap) {
    // (The fields' job finished first: its slots copied whole; taken at the
    // next flush as always.)
    _navFieldsLaneWait();
    const size = F.span * F.span, pool = simSharedArray(Uint16Array, cap * size), meta = simSharedArray(Int32Array, cap * NAV_FIELD_META), seen = new Int32Array(cap);
    const rows = simSharedArray(Uint8Array, Math.max(1, cap * F.rowW));
    const rowKeyOf = new Float64Array(cap).fill(-1);
    if (F.pool) { pool.set(F.pool); meta.set(F.meta); seen.set(F.seen); rowKeyOf.set(F.rowKeyOf); }
    if (F.rows && F.rows.length <= rows.length) rows.set(F.rows);
    F.rowKeyOf = rowKeyOf;
    for (let s = cap - 1; s >= F.cap; s--) { F.free.push(s); meta[s * NAV_FIELD_META] = -1; }
    F.pool = pool; F.meta = meta; F.seen = seen; F.cap = cap; F.rows = rows;
    const w = F.wide ? 1 : 0;
    simParallelBind('nav.fpool.' + w, pool); simParallelBind('nav.fmeta.' + w, meta); simParallelBind('nav.frows.' + w, rows);
    _navFieldsHeader();
    if (_navNext.nav) _navNextPoolEnsure(F);
}
// Rows wide enough for the installed builds' parts (a build installed: every
// field is made again anyway, see navPublish).
function _navRowsEnsure() {
    let w = 1;
    for (const nav of _nav) if (nav && nav.np > w) w = nav.np;
    for (const F of _navFields.pools) {
        if (!F.pool || F.rowW >= w) continue;
        F.rowW = w;
        F.rows = simSharedArray(Uint8Array, Math.max(1, F.cap * w));
        F.rowSrc = new Map();
        simParallelBind('nav.frows.' + (F.wide ? 1 : 0), F.rows);
    }
    _navFieldsHeader();
}
// (nav.fhdr: the pools' row widths, then the next build's: _navNext.)
function _navFieldsHeader() {
    if (!_navFields.hdr) { _navFields.hdr = simSharedArray(Int32Array, 4); simParallelBind('nav.fhdr', _navFields.hdr); }
    for (const F of _navFields.pools) _navFields.hdr[F.wide ? 1 : 0] = F.rowW;
    for (let w = 0; w < 2; w++) _navFields.hdr[2 + w] = _navNext.pools[w] ? _navNext.pools[w].rowW : 0;
}
// The pool and index of a slot id.
function _navFieldPool(id) { return id >= NAV_WIDE_BASE ? _navFields.pools[1] : _navFields.pools[0]; }
function _navFieldIndex(id) { return id >= NAV_WIDE_BASE ? id - NAV_WIDE_BASE : id; }
// The tick a route asked for now may use its field: the fields asked for
// before a tick's flush are made by the helpers meanwhile and taken at the
// next tick's flush (navFieldsFlush), before anything moves; asked after it,
// a tick later.
function navFieldReadyTick() { return _navFields.flushedTick === gameTime ? gameTime + 2 : gameTime + 1; }
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
// Every tick, after the orders: the fields started at the last flush taken
// (made: marked so, the same tick on every peer, whenever the helpers
// finished), and those asked for since started in the background
// (SIM_LANE_NAV). Nothing waits for them on this thread but the taking,
// normally finished long before.
// (A build's remake, at once: before this tick's job; the slots it made
// leave the job. In a rebuild's window the job makes its fields over the
// next build too: _navNextStage.)
function navFieldsFlush() {
    _navFieldsCommit();
    _navFields.flushedTick = gameTime;
    if (_navFieldsRemakeStep()) for (const F of _navFields.pools) if (F.pending.length) F.pending = F.pending.filter(s => F.meta[s * NAV_FIELD_META + 7] !== 1);
    _navFieldsStart();
    navFieldsSweepStep();
    _navSubstitutesMake();
}
// Batches of fields: list ids (the kernel's lists, nav.flist.<w>.<id>):
// 0 the installed build's, 1 the next build's (this tick's job, or made
// now), 2 the next build's every live field (SIM_LANE_NAVX).
// The fields' job: [pool, slot, gen] of each slot it makes.
const _navFieldsJob = { slots: null };
function _navFieldsLaneWait() {
    if (typeof simParallelBackgroundWait === 'function' && typeof SIM_LANE_NAV === 'number') simParallelBackgroundWait(SIM_LANE_NAV);
}
function _navFieldsStart() {
    const lane = typeof SIM_LANE_NAV === 'number' ? SIM_LANE_NAV : -1;
    if (lane < 0) { for (const F of _navFields.pools) if (F.pending.length) { _navFieldsMake(F, F.pending); F.pending = []; } return; }
    // (Stages: the fields and rows of both pools, then the copies; then the
    // same over the next build.)
    const stages = [];
    for (let i = 0; i < 8; i++) stages.push([SIM_KERNEL_NAV_FIELDS, 0]);
    const taken = [];
    let any = false;
    for (const F of _navFields.pools) {
        if (!F.pending.length) continue;
        if (!any) { _navFieldsBindWalls(); any = true; }
        const w = F.wide ? 1 : 0;
        F.pending.sort((a, b) => a - b);
        _navFieldsStage(lane, stages, w, _navFieldsBatch(F, F.pending, false, 0, true));
        if (_navNext.nav) _navFieldsStage(lane, stages, 4 + w, _navFieldsBatch(F, F.pending, true, 1, true));
        for (const s of F.pending) taken.push(F, s, F.meta[s * NAV_FIELD_META + 6]);
        F.pending = [];
    }
    if (!taken.length) return;
    _navFieldsJob.slots = taken;
    simParallelBackgroundChain(lane, stages);
}
// A batch's two stages in a chain: its fields at stage st, its copies at
// st + 2.
function _navFieldsStage(lane, stages, st, b) {
    for (let ph = 0; ph < 2; ph++) {
        const P = simParallelStageParams(lane, st + 2 * ph);
        P.set(b.P);
        if (ph) { P[6] = 1; P[1] = 64; }
        stages[st + 2 * ph][1] = ph ? b.copy : b.make;
    }
}
function _navFieldsCommit() {
    const T = _navFieldsJob.slots;
    if (!T) return;
    _navFieldsJob.slots = null;
    simParallelBackgroundWait(SIM_LANE_NAV);
    // (A slot let go meanwhile, and maybe asked for again: not this one's.)
    for (let i = 0; i < T.length; i += 3) { const F = T[i], m = T[i + 1] * NAV_FIELD_META; if (F.meta && F.meta[m + 6] === T[i + 2] && F.meta[m] >= 0) F.meta[m + 7] = 1; }
}
// A slot's row key: its destination's part (+ profile), or (a wall
// destination) its own (-2 - slot: not shared). (next: the next build.)
function _navRowKey(F, s, next = null) {
    const m = s * NAV_FIELD_META, p = F.meta[m], dest = F.meta[m + 1], nav = next && next.profile === p ? next : _nav[p];
    if (!nav || !nav.partL || !(dest >= 0 && dest < nav.W * nav.H) || nav.partL[dest] === 0xFFFF) return -2 - s;
    const x = dest % nav.W, y = (dest - x) / nav.W;
    return p * 16777216 + nav.partBase[(y >> nav.cs) * nav.cw + (x >> nav.cs)] + nav.partL[dest];
}
// Makes fields now (and over the next build in a rebuild's window).
function _navFieldsMake(F, slots) {
    if (!slots.length) return;
    // (The job's lists rebound below: it is finished first.)
    _navFieldsLaneWait();
    slots.sort((a, b) => a - b);
    _navFieldsBindWalls();
    _navFieldsRunNow(_navFieldsBatch(F, slots, false, 0, false));
    if (_navNext.nav) _navFieldsRunNow(_navFieldsBatch(F, slots, true, 1, false));
}
function _navFieldsBindWalls() {
    for (let p = 0; p < 2; p++) {
        const nav = _nav[p];
        if (!nav) continue;
        simParallelBind('nav.fwall.' + p, nav.wall); simParallelBind('nav.fcost.' + p, nav.cost || _navNoCost);
    }
}
function _navFieldsRunNow(b) {
    const P = _simParams;
    P.set(b.P);
    simParallelRun(SIM_KERNEL_NAV_FIELDS, b.make);
    // (Then the copies: their sources are made.)
    if (b.copy) { P[1] = 64; P[6] = 1; simParallelRun(SIM_KERNEL_NAV_FIELDS, b.copy); }
}
// A batch of slots (sorted) to make into the installed arrays (next false)
// or the next build's (next: _navNext; never marks made: its install does).
// bg: made in the background (made marked at the job's taking,
// _navFieldsCommit), else by the kernel. Binds its lists (list id), returns
// its parameters (P: [count, per chunk, span, W, H, wide, phase, no made
// mark, next, list id]) and chunk counts (make, copy).
// Rows: one search per row key; the other slots of the key copy it (a slot
// made before under these builds, or the batch's first; for the next build
// the batch's only: its other batches may be running still).
function _navFieldsBatch(F, slots, next, id, bg) {
    const w = F.wide ? 1 : 0, n = slots.length, N = next ? _navNextPoolEnsure(F) : null;
    const list = simSharedArray(Int32Array, n), src = simSharedArray(Int32Array, n);
    list.set(slots);
    let copies = 0;
    if (!N) {
        for (let i = 0; i < n; i++) {
            const s = slots[i], key = _navRowKey(F, s), old = F.rowKeyOf[s];
            if (old !== key && F.rowSrc.get(old) === s) F.rowSrc.delete(old);
            F.rowKeyOf[s] = key;
            const from = F.rowSrc.get(key);
            if (from !== undefined && from !== s) { src[i] = from; copies++; }
            else { src[i] = -1; F.rowSrc.set(key, s); }
        }
    } else {
        const local = new Map();
        for (let i = 0; i < n; i++) {
            const s = slots[i], key = _navRowKey(F, s, _navNext.nav);
            N.rowKeyOf[s] = key;
            const from = local.get(key);
            if (from !== undefined) { src[i] = from; copies++; }
            else { src[i] = -1; local.set(key, s); if (!N.rowSrc.has(key)) N.rowSrc.set(key, s); }
        }
    }
    simParallelBind('nav.flist.' + w + '.' + id, list); simParallelBind('nav.fsrc.' + w + '.' + id, src);
    const per = F.wide ? 1 : 2, P = new Float64Array(10);
    P[0] = n; P[1] = per; P[2] = F.span; P[3] = _nav[0] ? _nav[0].W : GRID_W; P[4] = _nav[0] ? _nav[0].H : GRID_H; P[5] = w; P[6] = 0; P[7] = bg || N ? 1 : 0; P[8] = N ? 1 : 0; P[9] = id;
    return { P, make: Math.ceil(n / per), copy: copies ? Math.ceil(n / 64) : 0 };
}
const SIM_KERNEL_NAV_FIELDS = 21;
SIM_KERNELS[SIM_KERNEL_NAV_FIELDS] = function (R, P, chunk) {
    const w = P[5] | 0, next = P[8] === 1, id = P[9] | 0, list = R['nav.flist.' + w + '.' + id], src = R['nav.fsrc.' + w + '.' + id], meta = R['nav.fmeta.' + w];
    const pool = R[(next ? 'nav.npool.' : 'nav.fpool.') + w], rows = R[(next ? 'nav.nrows.' : 'nav.frows.') + w], hdr = R['nav.fhdr'], rowW = hdr ? hdr[(next ? 2 : 0) + w] | 0 : 0;
    const pre = next ? 'navn.' : 'nav.';
    const span = P[2] | 0, size = span * span, W = P[3] | 0, H = P[4] | 0;
    // (Phase 1: the rows copied from their key's slot, P[6].)
    if (P[6] === 1) {
        if (!rows || !(rowW > 0)) return;
        for (let i = chunk * P[1], end = Math.min(P[0], i + P[1]); i < end; i++) {
            const from = src[i];
            if (from >= 0) rows.copyWithin(list[i] * rowW, from * rowW, from * rowW + rowW);
        }
        return;
    }
    const S = _navKernelScratch && _navKernelScratch.q[0].length >= size * 3 ? _navKernelScratch : (_navKernelScratch = _navDialScratch(size));
    for (let i = chunk * P[1], end = Math.min(P[0], i + P[1]); i < end; i++) {
        const s = list[i], m = s * NAV_FIELD_META, p = meta[m];
        const wall = R[pre + 'fwall.' + p], costR = R[pre + 'fcost.' + p];
        if (!wall) continue;
        const cost = costR && costR.length ? costR : null;
        pool.fill(NAV_UNREACHED, s * size, s * size + size);
        _navLocalFieldDial(pool, s * size, meta[m + 2], meta[m + 3], W, H, meta[m + 1], wall, cost, meta[m + 4], meta[m + 5], S);
        if (rows && rowW > 0 && !(src && src[i] >= 0)) _navFieldRow(R, p, pool, s * size, meta, m, rows, s * rowW, pre);
        // (In the background, marked made at the job's taking; the next
        // build's, at its install.)
        if (P[7] !== 1) meta[m + 7] = 1;
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
    // (In a rebuild's window no slot is let go (the next build's batches
    // keep theirs): the drop waits a cycle, the marks of both kept.)
    if (_navNext.nav) return;
    for (const F of _navFields.pools) {
        if (!F.pool) continue;
        for (const [key, s] of F.byKey) {
            if (F.seen[s] >= mark) continue;
            F.byKey.delete(key); F.meta[s * NAV_FIELD_META] = -1; F.meta[s * NAV_FIELD_META + 6]++; F.free.push(s);
            if (F.rowKeyOf && F.rowSrc.get(F.rowKeyOf[s]) === s) F.rowSrc.delete(F.rowKeyOf[s]);
        }
        F.pending = F.pending.filter(s => F.meta[s * NAV_FIELD_META] >= 0);
    }
    _navFields.seenCycle++;
}
// Every field again (a build installed without a window: the map's first,
// a restore), all at the next flush (one parallel job). Not a share a tick:
// which fields a peer keeps differs (the sweep, a restore), and a field must
// hold the same build on every peer at every tick (its content a function of
// its destination and the build), whichever peer had it already. (A
// rebuild's: made in its window, see _navNext.)
const NAV_FIELD_REMAKE_PER_TICK = [Infinity, Infinity];
function _navFieldsRemakeAll() {
    for (const F of _navFields.pools) {
        if (!F.pool) continue;
        F.rowSrc = new Map();
        const all = [];
        for (const s of F.byKey.values()) all.push(s);
        all.sort((a, b) => a - b);
        F.remake = all; F.remakePos = 0;
    }
}
function _navFieldsRemakeStep() {
    let any = false;
    for (let w = 0; w < _navFields.pools.length; w++) {
        const F = _navFields.pools[w];
        if (!F.pool || !F.remake || F.remakePos >= F.remake.length) continue;
        const batch = [];
        while (F.remakePos < F.remake.length && batch.length < NAV_FIELD_REMAKE_PER_TICK[w]) {
            const s = F.remake[F.remakePos++];
            if (F.meta[s * NAV_FIELD_META] >= 0) batch.push(s);
        }
        if (batch.length) { _navFieldsMake(F, batch); any = true; }
    }
    return any;
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
    navSubstitutesRestore();
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
// (_navVersion: this peer's count of installs, for caches; nav.seq: the
// profile's build number, the same on every peer: snapshotted, so waiting
// units can tell a new build, see _tryUpgradeAstarFallbackPath.)
let _navVersion = 0, _navSeq = [0, 0];
// made: its fields made over it already (a rebuild's window, its arrays
// installed: _navNextInstall).
function navPublish(nav, made = false) {
    // (The fields' jobs finished: the arrays they write may be replaced. A
    // window still open is closed: its build installed as any, at its end.)
    _navFieldsLaneWait();
    if (!made && _navNext.nav) _navNextDrop();
    _nav[nav.profile] = nav;
    _navVersion++;
    nav.seq = ++_navSeq[nav.profile];
    // (Its version, as the kernels read it from its meta: look-ahead keys.)
    nav.version = _navVersion;
    const p = nav.profile;
    _navBindBuild('nav.', nav);
    for (const F of _navFields.pools) _navPoolEnsure(F, nav.C);
    _navRowsEnsure();
    // Every destination field again over the new build (same slots: the
    // routes keep following them), at the next flush (navFieldsFlush):
    // until then the old build's. (Rows: the new build's parts.)
    if (!made) _navFieldsRemakeAll();
    else _navFieldsHeader();
    // (Components changed: substitutes asked for again.)
    _navSubReset();
    if (p === NAV_PROFILE_GROUND) _navWallDiffReset();
}
// A build's arrays for the kernels under names pre + profile + '.' + name
// ('nav.': the installed one, 'navn.': the next, _navNextStage).
function _navBindBuild(pre, nav) {
    const p = nav.profile;
    simParallelBind(pre + p + '.fields', nav.fields);
    // meta: [C, cw, ch, nc, W, H, version, parts, the graph's bucket count
    // (largest edge + 1), nodes, edges]
    const meta = simSharedArray(Int32Array, 12);
    meta[0] = nav.C; meta[1] = nav.cw; meta[2] = nav.ch; meta[3] = nav.nc; meta[4] = nav.W; meta[5] = nav.H; meta[6] = nav.version | 0;
    meta[7] = nav.np | 0; meta[8] = nav.B | 0; meta[9] = nav.k | 0; meta[10] = nav.adjA ? nav.adjA.length : 0;
    simParallelBind(pre + p + '.meta', meta);
    simParallelBind(pre + p + '.nb', nav.nodeBase); simParallelBind(pre + p + '.nt', nav.nodeTile); simParallelBind(pre + p + '.np', nav.nodePair);
    simParallelBind(pre + p + '.partL', nav.partL); simParallelBind(pre + p + '.partB', nav.partBase); simParallelBind(pre + p + '.npart', nav.nodePart);
    simParallelBind(pre + p + '.adjS', nav.adjStart); simParallelBind(pre + p + '.adjA', nav.adjA); simParallelBind(pre + p + '.adjC', nav.adjC);
    simParallelBind(pre + p + '.pclu', nav.partCluster); simParallelBind(pre + p + '.cstart', nav.compStart); simParallelBind(pre + p + '.cparts', nav.compParts);
}

// ---- A rebuild's window (see _navNext) ----
// Opens it: the next build's arrays bound (the other profile's: the
// installed one), every live field made over it in the background. (Those
// asked for since the last flush: in this tick's job, both builds.)
function _navNextStage(nav) {
    if (_navNext.nav) _navNextDrop();
    _navNext.nav = nav;
    const other = _nav[1 - nav.profile];
    for (const b of [nav, other]) {
        if (!b) continue;
        _navBindBuild('navn.', b);
        simParallelBind('navn.fwall.' + b.profile, b.wall); simParallelBind('navn.fcost.' + b.profile, b.cost || _navNoCost);
    }
    _navNext.rowW = Math.max(1, nav.np | 0, other ? other.np | 0 : 0);
    const lane = SIM_LANE_NAVX, stages = [];
    for (let i = 0; i < 4; i++) stages.push([SIM_KERNEL_NAV_FIELDS, 0]);
    for (const F of _navFields.pools) {
        if (!F.pool) continue;
        _navNextPoolEnsure(F);
        const pend = new Set(F.pending), slots = [];
        for (const s of F.byKey.values()) if (!pend.has(s)) slots.push(s);
        if (!slots.length) continue;
        slots.sort((a, b) => a - b);
        _navFieldsStage(lane, stages, F.wide ? 1 : 0, _navFieldsBatch(F, slots, true, 2, true));
    }
    _navFieldsHeader();
    simParallelBackgroundChain(lane, stages);
}
// A pool's arrays over the next build (as many slots as the pool; grown
// with it, after the background batches that write them).
function _navNextPoolEnsure(F) {
    const w = F.wide ? 1 : 0;
    let N = _navNext.pools[w];
    if (N && N.cap === F.cap) return N;
    if (N) { _navFieldsLaneWait(); simParallelBackgroundWait(SIM_LANE_NAVX); }
    const rowW = _navNext.rowW, pool = simSharedArray(Uint16Array, F.cap * F.span * F.span), rows = simSharedArray(Uint8Array, Math.max(1, F.cap * rowW)), rowKeyOf = new Float64Array(F.cap).fill(-1);
    if (N) { pool.set(N.pool); rows.set(N.rows); rowKeyOf.set(N.rowKeyOf); }
    N = _navNext.pools[w] = { cap: F.cap, pool, rows, rowW, rowKeyOf, rowSrc: N ? N.rowSrc : new Map() };
    simParallelBind('nav.npool.' + w, pool); simParallelBind('nav.nrows.' + w, rows);
    _navFieldsHeader();
    return N;
}
// Closes it: the next build and its fields installed together.
function _navNextInstall(nav) {
    _navFieldsLaneWait();
    simParallelBackgroundWait(SIM_LANE_NAVX);
    // (Closed meanwhile: installed as any build.)
    if (_navNext.nav !== nav) { navPublish(nav); return; }
    for (let w = 0; w < 2; w++) {
        const F = _navFields.pools[w], N = _navNext.pools[w];
        if (!F.pool || !N || N.cap !== F.cap) continue;
        F.pool = N.pool; F.rows = N.rows; F.rowW = N.rowW; F.rowSrc = N.rowSrc; F.rowKeyOf = N.rowKeyOf;
        simParallelBind('nav.fpool.' + w, F.pool); simParallelBind('nav.frows.' + w, F.rows);
    }
    _navNext.nav = null; _navNext.pools = [null, null];
    navPublish(nav, true);
}
// (Dropped: its batches finished, its arrays let go.)
function _navNextDrop() {
    _navFieldsLaneWait();
    if (typeof SIM_LANE_NAVX === 'number') simParallelBackgroundWait(SIM_LANE_NAVX);
    _navNext.nav = null; _navNext.pools = [null, null];
    _navFieldsHeader();
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
    // (A build's background stage, the fields' jobs: finished, dropped.)
    if (typeof simParallelBackgroundWait === 'function') { simParallelBackgroundWait(); if (typeof SIM_LANE_NAV === 'number') simParallelBackgroundWait(SIM_LANE_NAV); }
    _navFieldsJob.slots = null;
    if (_navNext.nav) _navNextDrop();
    for (const F of _navFields.pools) {
        if (F.meta) for (const s of F.byKey.values()) { F.meta[s * NAV_FIELD_META] = -1; F.meta[s * NAV_FIELD_META + 6]++; F.free.push(s); }
        F.rowSrc = new Map();
        F.byKey = new Map(); F.pending = []; F.remake = null;
    }
    _navFields.flushedTick = -1;
    _nav = [null, null];
    _navSeq = [0, 0];
    _navJob = null; _navWallDiff = 0;
    _navSubReset();
}

// The next tile from `t` toward `dest` (profile), -1 when there is no way
// (or `t` is `dest`, or its field is not made: the rows are the field's).
// `destId`: its destination field (navFieldRequest).
function navStep(profile, t, dest, destId) {
    const nav = _nav[profile];
    if (!nav || t === dest || !(destId >= 0)) return -1;
    const F = _navFieldPool(destId), i = _navFieldIndex(destId), m = i * NAV_FIELD_META;
    if (!(F && F.meta && F.rows && F.meta[m] === profile && F.meta[m + 1] === dest && F.meta[m + 7] === 1)) return -1;
    return simNavStep(nav.W, nav.C, nav.cw, nav.partL, nav.partBase, F.rows, i * F.rowW, nav.fields, nav.nodeBase, nav.nodeTile, nav.nodePair,
        F.pool, i * F.span * F.span, F.meta[m + 2], F.meta[m + 3], F.meta[m + 4], F.meta[m + 5], t, dest);
}

// ---- Reachability and the closest reachable tile ----
// The component of tile t (profile): -1 for a wall, or without a build.
function navCompOf(profile, t) {
    const nav = _nav[profile];
    if (!nav || !nav.partL || !(t >= 0 && t < nav.W * nav.H)) return -1;
    const l = nav.partL[t];
    if (l === 0xFFFF) return -1;
    const x = t % nav.W, y = (t - x) / nav.W;
    return nav.partComp[nav.partBase[(y >> nav.cs) * nav.cw + (x >> nav.cs)] + l];
}
// A unit's component at tile t: its tile's, or (standing on a wall: a
// building put down under it) its way out's: the first open side
// neighbour, N, S, W, E, as the kernel steps out (_simWallStepOut), else
// the nearest open tile.
function _navUnitComp(profile, t) {
    const c = navCompOf(profile, t), nav = _nav[profile];
    if (c >= 0 || !nav || !(t >= 0 && t < nav.W * nav.H)) return c;
    const n = _simWallStepOut(nav.partL, nav.partBase, null, 0, nav.W, nav.C, nav.cw, t, t % nav.W, (t - t % nav.W) / nav.W);
    if (n >= 0) return navCompOf(profile, n);
    const a = navApproachTile(profile, t);
    return a >= 0 ? navCompOf(profile, a) : -1;
}
// Whether a unit at tile `from` can get to the open tile `to`. O(1). (On
// a wall tile: when any open side neighbour can, the one it steps out to,
// _simWallStepOut.)
function navReachable(profile, from, to) {
    const ct = navCompOf(profile, to);
    if (ct < 0) return false;
    const c = navCompOf(profile, from), nav = _nav[profile];
    if (c >= 0 || !nav) return c === ct;
    const W = nav.W, H = nav.H, x = from % W, y = (from - x) / W;
    if ((y > 0 && navCompOf(profile, from - W) === ct) || (y + 1 < H && navCompOf(profile, from + W) === ct)
        || (x > 0 && navCompOf(profile, from - 1) === ct) || (x + 1 < W && navCompOf(profile, from + 1) === ct)) return true;
    return _navUnitComp(profile, from) === ct;
}
// The path of a unit at (sx, sy) sent to tile (tx, ty): one nav node toward
// it (its open tile, navApproachTile) when it can get there, else null (the
// closest tile it can reach instead: navPathSubstitute). O(1).
function navPathReach(u, sx, sy, tx, ty) {
    if (!(tx >= 0 && ty >= 0 && tx < GRID_W && ty < GRID_H)) return null;
    const profile = navProfileOf(u);
    navEnsure(profile);
    const to = navApproachTile(profile, ty * GRID_W + tx);
    if (to < 0) return null;
    const from = (sx >= 0 && sy >= 0 && sx < GRID_W && sy < GRID_H) ? sy * GRID_W + sx : Math.floor(u.y / TILE) * GRID_W + Math.floor(u.x / TILE);
    if (!navReachable(profile, from, to)) return null;
    return [navNode(profile, to % GRID_W, (to - to % GRID_W) / GRID_W)];
}
// Substitutes: for a destination a unit cannot reach, the tile of its
// component nearest it (straight-line; ties: the lower tile), worked out
// by the helpers at the flush (SIM_KERNEL_NAV_SUBST) from a request. A unit
// asks once (its pending target's `sub`: the tick it may take the answer,
// NAV_SUB_TICKS later, whatever this peer has cached: the same tick on every
// peer, and a restore asks again for the waiting units). Cached per
// (profile, destination, component) until the next build.
const NAV_SUB_TICKS = 2;
const _navSub = { map: new Map(), req: [] };
function _navSubReset() { _navSub.map = new Map(); _navSub.req = []; }
function _navSubKey(profile, to, comp) { return (profile * 4194304 + comp) * 16777216 + to; }
function navSubstituteRequest(profile, to, comp) {
    const key = _navSubKey(profile, to, comp);
    if (_navSub.map.has(key)) return;
    _navSub.map.set(key, -2);
    _navSub.req.push(profile, to, comp);
}
// The path of a unit at (sx, sy) toward its pending target pt ({ gx, gy,
// ... }) that it cannot reach: toward the closest tile it can, once known
// (null while waiting: asked for at the first call), [] when it is walled
// in. O(1).
function navPathSubstitute(u, sx, sy, pt) {
    const profile = navProfileOf(u);
    navEnsure(profile);
    const to = Math.max(0, Math.min(GRID_H - 1, pt.gy | 0)) * GRID_W + Math.max(0, Math.min(GRID_W - 1, pt.gx | 0));
    const from = (sx >= 0 && sy >= 0 && sx < GRID_W && sy < GRID_H) ? sy * GRID_W + sx : Math.floor(u.y / TILE) * GRID_W + Math.floor(u.x / TILE);
    const comp = _navUnitComp(profile, from);
    if (comp < 0) return [];
    const ask = () => { navSubstituteRequest(profile, to, comp); pt.sub = gameTime + NAV_SUB_TICKS; u._astarBudgetRetryTick = pt.sub; return null; };
    if (!(pt.sub > 0) || gameTime < pt.sub) return pt.sub > 0 ? null : ask();
    const r = _navSub.map.get(_navSubKey(profile, to, comp));
    if (r === undefined || r === -2) return ask();
    if (r < 0) return [];
    return [navNode(profile, r % GRID_W, (r - r % GRID_W) / GRID_W)];
}
// The substitutes asked for (at the flush; one job each).
function _navSubstitutesMake() {
    const req = _navSub.req;
    if (!req.length) return;
    _navSub.req = [];
    const n = req.length / 3, list = simSharedArray(Int32Array, req.length), out = simSharedArray(Int32Array, n);
    list.set(req);
    simParallelBind('nav.sreq', list); simParallelBind('nav.sout', out);
    const P = _simParams;
    P[0] = n; P[1] = 1;
    simParallelRun(SIM_KERNEL_NAV_SUBST, n);
    for (let i = 0; i < n; i++) _navSub.map.set(_navSubKey(list[i * 3], list[i * 3 + 1], list[i * 3 + 2]), out[i]);
}
const SIM_KERNEL_NAV_SUBST = 17;
SIM_KERNELS[SIM_KERNEL_NAV_SUBST] = function (R, P, chunk) {
    const req = R['nav.sreq'], out = R['nav.sout'];
    for (let i = chunk * P[1], end = Math.min(P[0], i + P[1]); i < end; i++) out[i] = _navSubstituteFind(R, req[i * 3], req[i * 3 + 1], req[i * 3 + 2]);
};
// Component K's tile nearest tile `to` (profile p): its parts by their
// cluster's distance to `to`, nearest first; their tiles while a nearer one
// may still be found. -1 none.
function _navSubstituteFind(R, p, to, K) {
    const NM = R['nav.' + p + '.meta'];
    if (!NM) return -1;
    const C = NM[0] | 0, cw = NM[1] | 0, W = NM[4] | 0, H = NM[5] | 0;
    const partL = R['nav.' + p + '.partL'], partB = R['nav.' + p + '.partB'], pclu = R['nav.' + p + '.pclu'], cstart = R['nav.' + p + '.cstart'], cparts = R['nav.' + p + '.cparts'];
    if (!partL || !cstart || !(K >= 0 && K + 1 < cstart.length)) return -1;
    const tx = to % W, ty = (to - tx) / W, a = cstart[K], n = cstart[K + 1] - a;
    if (n <= 0) return -1;
    const SH = 2097152, keys = new Float64Array(n);
    for (let j = 0; j < n; j++) {
        const c = pclu[cparts[a + j]], cx = c % cw, cy = (c - cx) / cw, x0 = cx * C, y0 = cy * C, x1 = Math.min(W, x0 + C) - 1, y1 = Math.min(H, y0 + C) - 1;
        const dx = tx < x0 ? x0 - tx : (tx > x1 ? tx - x1 : 0), dy = ty < y0 ? y0 - ty : (ty > y1 ? ty - y1 : 0);
        keys[j] = (dx * dx + dy * dy) * SH + j;
    }
    keys.sort();
    let best = -1, bd = Infinity;
    for (let r = 0; r < n; r++) {
        const d2 = Math.floor(keys[r] / SH);
        if (d2 > bd) break;
        const j = keys[r] - d2 * SH, q = cparts[a + j], c = pclu[q], l = q - partB[c];
        const cx = c % cw, cy = (c - cx) / cw, x0 = cx * C, y0 = cy * C, x1 = Math.min(W, x0 + C), y1 = Math.min(H, y0 + C);
        for (let y = y0; y < y1; y++) for (let x = x0, t = y * W + x0; x < x1; x++, t++) {
            if (partL[t] !== l) continue;
            const dd = (x - tx) * (x - tx) + (y - ty) * (y - ty);
            if (dd < bd || (dd === bd && t < best)) { bd = dd; best = t; }
        }
    }
    return best;
}
// After a restore: the substitutes the waiting units asked for, again (now).
function navSubstitutesRestore() {
    _navSubReset();
    for (const u of units) {
        const pt = u && !u.dead ? u._pendingPathTarget : null;
        if (!pt || !(pt.sub > 0)) continue;
        const profile = navProfileOf(u), gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE);
        const comp = _navUnitComp(profile, gy * GRID_W + gx);
        if (comp >= 0) navSubstituteRequest(profile, Math.max(0, Math.min(GRID_H - 1, pt.gy | 0)) * GRID_W + Math.max(0, Math.min(GRID_W - 1, pt.gx | 0)), comp);
    }
    _navSubstitutesMake();
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
// heavy stages (the local fields, then the parts, then the destination
// fields in use: _navNext) run on the helpers between ticks, and the build is
// installed NAV_BUILD_TICKS after its start whatever the machine. Units
// follow the old one meanwhile (the kernel checks walls as they go). A new
// build starts once the last is installed, when the walls differ from the
// newest build's (_navWallDiff tiles: kept as walls change, and worked
// out again after a restore, which rebuilds from the snapshot's walls).
// (Long enough for the helpers to finish each background stage between the
// tick's own jobs: a collect that waits would stall the tick.)
const NAV_BUILD_SLICES = 64;
// The steps of a build (ticks after its start, _navJobStep): the costs and
// nodes start, they are numbered and the local fields start, the graph's
// edges and the parts start, the build is finished and staged, installed.
const NAV_STEP_NODES = 1, NAV_STEP_LOCAL = 4, NAV_STEP_GRAPH = NAV_STEP_LOCAL + NAV_BUILD_SLICES + 1;
const NAV_STEP_STAGE = NAV_STEP_GRAPH + NAV_BUILD_SLICES + 1, NAV_STEP_INSTALL = NAV_STEP_STAGE + NAV_SWAP_TICKS;
const NAV_BUILD_TICKS = NAV_STEP_INSTALL + 1;
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
    // (The map's first builds at its first tick, not at the first order:
    // on a big map that build takes long.)
    if (!_nav[NAV_PROFILE_GROUND]) { navEnsure(NAV_PROFILE_GROUND); navEnsure(NAV_PROFILE_AIR); return; }
    if (!_navJob) {
        if (_navWallDiff <= 0) return;
        _navJob = { start: gameTime, step: 0, b: null, dests: null, destNew: null };
    }
    const J = _navJob, off = gameTime - J.start;
    while (J.step <= off && _navJob === J) _navJobStep(J, J.step++);
}
// Step 0 copies the walls; NAV_STEP_NODES starts the costs and the exit
// nodes in the background (the helpers between the tick's other jobs);
// NAV_STEP_LOCAL numbers the nodes and starts their local fields and edge
// counts; NAV_STEP_GRAPH places the edges and starts them and the parts;
// NAV_STEP_STAGE finishes the build and opens its window (its fields made in
// the background, see _navNext); NAV_STEP_INSTALL installs both. The
// simulation thread does O(clusters + nodes) at a step. The steps' ticks are
// those of the build's start alone: when the helpers finish never changes
// what any peer does (a collect waits, or runs what is left itself).
function _navJobStep(J, step) {
    if (step === 0) {
        J.b = navBuildStart(NAV_PROFILE_GROUND, navWallTable(NAV_PROFILE_GROUND), true, GRID_W, GRID_H);
        _navWallDiffReset();
    } else if (step === NAV_STEP_NODES) {
        navBuildNodesBackground(J.b);
    } else if (step === NAV_STEP_LOCAL) {
        navBuildCollect();
        navBuildNodesFinish(J.b);
        navBuildLocalBackground(J.b);
    } else if (step === NAV_STEP_GRAPH) {
        navBuildCollect();
        navBuildGraphAlloc(J.b);
        navBuildGraphBackground(J.b);
    } else if (step === NAV_STEP_STAGE) {
        navBuildCollect();
        navBuildGraphFinish(J.b);
        navBuildPartsFinish(J.b);
        J.next = navBuildFinish(J.b);
        _navNextStage(J.next);
    } else if (step === NAV_STEP_INSTALL) {
        _navJob = null;
        _navNextInstall(J.next);
    }
}
// Snapshots: the walls of the installed ground build and of one being made,
// as their differences from the live walls, and when that one started.
function navSnapshotState() {
    const live = typeof _simMoveWall !== 'undefined' ? _simMoveWall : null, nav = _nav[NAV_PROFILE_GROUND];
    if (!nav || !live || live.length !== nav.wall.length) return null;
    const diff = w => { const out = []; for (let i = 0; i < w.length; i++) if (w[i] !== live[i]) out.push(i, w[i]); return out; };
    return { built: diff(nav.wall), seq: nav.seq | 0, job: _navJob && _navJob.b ? { start: _navJob.start, step: _navJob.step, walls: diff(_navJob.b.wall) } : null };
}
// After a restore (the live walls restored): the same builds again.
function navRestoreState(st) {
    navReset();
    if (!st || !Array.isArray(st.built)) return;
    const live = simMoveWallGrid();
    const walls = d => { const w = new Uint8Array(live.length); w.set(live); if (Array.isArray(d)) for (let i = 0; i + 1 < d.length; i += 2) if (d[i] >= 0 && d[i] < w.length) w[d[i]] = d[i + 1] ? 1 : 0; return w; };
    navPublish(navBuild(NAV_PROFILE_GROUND, walls(st.built), true, GRID_W, GRID_H));
    if (st.seq > 0) _nav[NAV_PROFILE_GROUND].seq = _navSeq[NAV_PROFILE_GROUND] = st.seq | 0;
    // (The air one too, as the match's first tick made it: flyers' fields
    // need it now.)
    navEnsure(NAV_PROFILE_AIR);
    if (st.job && Number.isFinite(st.job.start)) {
        // Its stages up to now run at once (the same result as spread out).
        const J = _navJob = { start: st.job.start, step: 0, b: null, dests: null, destNew: null };
        if (st.job.walls) {
            const w = walls(st.job.walls);
            // (Steps below `step` ran on the snapshot's peer.)
            const upTo = Math.min(Number(st.job.step) || 1, NAV_STEP_INSTALL);
            J.b = navBuildStart(NAV_PROFILE_GROUND, w, true, GRID_W, GRID_H);
            J.step = 1;
            for (; J.step < upTo; J.step++) _navJobStep(J, J.step);
        }
        _navWallDiffReset();
    }
}
