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
// Walk classes (navProfileOf): units that may walk over more than the ground
// allows (canUnitOccupyTile) have a navigation of their own: collectors over
// active mines, a player's builders and salvagers over the player's own
// buildings (_navClassWalls: their work is at those, in the middle of a base
// too). (Up to NAV_BUILD_PLAYERS players; others' keep the ground's.)
const NAV_PROFILE_COLLECT = 2, NAV_PROFILE_BUILD0 = 3, NAV_BUILD_PLAYERS = 8, NAV_PROFILES = NAV_PROFILE_BUILD0 + NAV_BUILD_PLAYERS;

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
// Every array of a build and its atlas (navBuildStart .. navAtlasHeader) is
// navigation's (_navOwned): given back once no build in use reaches it
// (_navSweep: the installed builds, the next one, the job's), NAV_FREE_TICKS
// later. They waited for the JS collector before, which on a quiet JS heap
// rarely came: every rebuild stayed in the wasm heap (+20-40 MB each at
// 1000x1000, 4 to 9 builds over 4500 ticks of a battle).
const _navOwned = new Set(), _navFreeQ = [];
const NAV_FREE_TICKS = 40, NAV_SWEEP_TICKS = 32;
let _navFreeClock = 0;
function _navArr(Type, n, clear = true) {
    const a = simHeapArrayAuto(Type, n, clear);
    _navOwned.add(a);
    return a;
}
function _navReach(o, seen, out, depth) {
    if (!o || typeof o !== 'object' || depth > 5) return;
    if (ArrayBuffer.isView(o)) { out.add(o); return; }
    if (seen.has(o) || o instanceof Map || o instanceof Set) return;
    seen.add(o);
    if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) { const v = o[i]; if (v && typeof v === 'object') _navReach(v, seen, out, depth + 1); } return; }
    for (const k in o) { const v = o[k]; if (v && typeof v === 'object') _navReach(v, seen, out, depth + 1); }
}
// Arrays of navigation no build in use reaches: queued (given back
// NAV_FREE_TICKS later, by then no job of any lane started before reads them).
function _navSweep() {
    if (!_navOwned.size) return;
    const live = new Set(), seen = new Set();
    for (const b of _nav) _navReach(b, seen, live, 0);
    _navReach(_navNext.nav, seen, live, 0);
    const J = _navJob;
    if (J) { _navReach(J.b, seen, live, 0); _navReach(J.next, seen, live, 0); _navReach(J.atl, seen, live, 0); _navReach(J.shared, seen, live, 0); }
    for (const a of _navOwned) if (!live.has(a)) { _navOwned.delete(a); _navFreeQ.push(_navFreeClock, a); }
}
// Each tick (navTick): the sweep now and then, the queued arrays due given back.
function _navFreeTick() {
    _navFreeClock++;
    if (_navFreeClock % NAV_SWEEP_TICKS === 0) _navSweep();
    let i = 0;
    while (i < _navFreeQ.length && _navFreeClock - _navFreeQ[i] >= NAV_FREE_TICKS) { if (typeof simHeapFreeAuto === 'function') simHeapFreeAuto(_navFreeQ[i + 1]); i += 2; }
    if (i) _navFreeQ.splice(0, i);
}
// The walls (copied) and room for their step costs, bound for the kernels.
function navBuildStart(profile, wallLive, withCosts, W, H) {
    // (A build's background stage still running reads the names bound here.)
    if (typeof simParallelBackgroundWait === 'function') simParallelBackgroundWait();
    const C = Math.max(W, H) > 512 ? 32 : 16;
    const wall = _navArr(Uint8Array, W * H);
    wall.set(wallLive.length === W * H ? wallLive : wallLive.subarray(0, W * H));
    const cost = withCosts ? _navArr(Uint8Array, W * H) : null, h = withCosts ? _navArr(Uint8Array, W * H) : null;
    const cw = Math.ceil(W / C), ch = Math.ceil(H / C), nc = cw * ch;
    const partL = _navArr(Uint16Array, W * H), partN = _navArr(Int32Array, nc);
    // (A cluster's exit nodes before they are numbered: NM slots each (a
    // border has at most C / 2 spans), and their count per border.)
    const NM = 2 * C, ns = _navArr(Int32Array, Math.max(1, nc * NM)), nsc = _navArr(Int32Array, Math.max(1, nc * 4));
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
    _navBuildBind(b);
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
    _navBuildBind(b);
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
const _navNodesW = _simWK(['navb.wall', 'navb.ns', 'navb.nsc']);
SIM_KERNELS[SIM_KERNEL_NAV_NODES] = function (R, P, chunk) { _simRust(_navNodesW, P, chunk, 'k_nav_nodes', 'NAV_NODES'); };
// The nodes numbered cluster by cluster (nodeBase), each with the node
// across its border (nodePair), and the storage of their local fields.
function navBuildNodesFinish(b) {
    b.h = null;
    const { nc, cw, C, NM, ns, nsc } = b;
    const nodeBase = _navArr(Int32Array, nc + 1);
    let k = 0;
    for (let c = 0; c < nc; c++) { nodeBase[c] = k; k += Math.min(NM, nsc[c * 4] + nsc[c * 4 + 1] + nsc[c * 4 + 2] + nsc[c * 4 + 3]); }
    nodeBase[nc] = k;
    const nodeTile = _navArr(Int32Array, Math.max(1, k)), nodePair = _navArr(Int32Array, Math.max(1, k));
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
    const CC = C * C, fields = _navArr(Uint16Array, Math.max(1, k * CC));
    const adjN = _navArr(Int32Array, Math.max(1, k));
    b.k = k; b.nodeBase = nodeBase; b.nodeTile = nodeTile; b.nodePair = nodePair; b.fields = fields; b.adjN = adjN;
    _navBuildBind(b);
    simParallelBind('navb.adjN', adjN);
}
// The build's arrays for the kernels (a new build is bound once; helpers
// get them before its first kernel runs, a tick later when staggered).
function _navBuildBind(b) {
    // Another profile may have built synchronously between these stages.
    // Finish any reader before restoring this build's complete bindings.
    if (typeof simParallelBackgroundWait === 'function') simParallelBackgroundWait(_navBuildLane());
    simParallelBind('navb.wall', b.wall); simParallelBind('navb.cost', b.cost || _navNoCost);
    simParallelBind('navb.h', b.h); simParallelBind('navb.ns', b.ns); simParallelBind('navb.nsc', b.nsc);
    simParallelBind('navb.nt', b.nodeTile); simParallelBind('navb.nb', b.nodeBase); simParallelBind('navb.np', b.nodePair);
    simParallelBind('navb.fields', b.fields);
    simParallelBind('navb.partL', b.partL); simParallelBind('navb.partN', b.partN);
    simParallelBind('navb.adjN', b.adjN); simParallelBind('navb.adjS', b.adjStart);
    simParallelBind('navb.adjA', b.adjA); simParallelBind('navb.adjC', b.adjC); simParallelBind('navb.adjMax', b.adjMax);
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
    _navBuildBind(b);
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
    _navBuildBind(b);
    const lane = _navBuildLane();
    let P = _navStageParams(b, lane, 0);
    P[0] = 0; P[1] = b.k; P[2] = NAV_GRAPH_PER_JOB; P[12] = 1;
    P = _navStageParams(b, lane, 1);
    P[0] = 0; P[1] = b.nc; P[2] = NAV_PARTS_PER_JOB;
    simParallelBackgroundChain(lane, [[SIM_KERNEL_NAV_GRAPH, Math.ceil(b.k / NAV_GRAPH_PER_JOB)], [SIM_KERNEL_NAV_PARTS, Math.ceil(b.nc / NAV_PARTS_PER_JOB)]]);
}
// The parts now (a build made at once), and what follows from them.
function navBuildParts(b) {
    _navBuildBind(b);
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
const _navPartsW = _simWK(['navb.wall', 'navb.partL', 'navb.partN']);
SIM_KERNELS[SIM_KERNEL_NAV_PARTS] = function (R, P, chunk) { _simRust(_navPartsW, P, chunk, 'k_nav_parts', 'NAV_PARTS'); };
// From the parts: their numbering (partBase), each node's part, the
// components (parts joined by an exit and its pair; a component numbered
// by its first part) and each component's parts. O(clusters + nodes +
// parts), at a build's end.
function navBuildPartsFinish(b) {
    const { nc, k, nodeBase, nodeTile, nodePair, partL, partN } = b;
    const partBase = _navArr(Int32Array, nc + 1);
    let np = 0;
    for (let c = 0; c < nc; c++) { partBase[c] = np; np += partN[c]; }
    partBase[nc] = np;
    const partCluster = _navArr(Int32Array, Math.max(1, np));
    for (let c = 0; c < nc; c++) for (let p = partBase[c]; p < partBase[c + 1]; p++) partCluster[p] = c;
    const nodePart = _navArr(Int32Array, Math.max(1, k));
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
    const partComp = _navArr(Int32Array, Math.max(1, np)), compOfRoot = new Int32Array(np).fill(-1);
    let ncomp = 0;
    for (let p = 0; p < np; p++) { const r = find(p); if (compOfRoot[r] < 0) compOfRoot[r] = ncomp++; partComp[p] = compOfRoot[r]; }
    const compStart = _navArr(Int32Array, ncomp + 1), compParts = _navArr(Int32Array, Math.max(1, np));
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
    _navBuildBind(b);
    if (b.k <= 0) return;
    const P = _navBuildParams(b);
    P[0] = 0; P[1] = b.k; P[2] = NAV_LOCAL_PER_JOB;
    simParallelRun(SIM_KERNEL_NAV_LOCAL, Math.ceil(b.k / NAV_LOCAL_PER_JOB));
}
SIM_KERNELS[SIM_KERNEL_NAV_LOCAL] = function (R, P, chunk) {
    // (Rust: nav_field without a row, over the node's cluster.)
    const WP = _simParWPtr, nt = R['navb.nt'], costR = R['navb.cost'];
    const fieldsP = WP['navb.fields'], wallP = WP['navb.wall'], costP = costR && costR.length ? WP['navb.cost'] : 0;
    if (_simWasmX === null || !(fieldsP >= 0) || !(wallP >= 0) || !(costP >= 0)) _simNoWasm('NAV_LOCAL');
    const W = P[3] | 0, H = P[4] | 0, C = P[5] | 0, cw = P[6] | 0, CC = C * C;
    for (let i = (P[0] | 0) + chunk * P[2], end = Math.min(P[1], i + P[2]); i < end; i++) {
        const t = nt[i], c = _navClusterOf(t, W, C, cw), cx = c % cw, cy = (c - cx) / cw;
        // (Pointers as the kernels' 32-bit words: _simWEnc.)
        _simWasmX.nav_field(_simWEnc(fieldsP), i * CC, CC, cx * C, cy * C, C, C, W, H, t, _simWEnc(wallP), _simWEnc(costP),
            /* no row */ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, /* csz cw nc np */ 0, 0, 0, 0, /* buckets k edges */ 1, 0, 0, /* rows ro */ 0, 0, _simWEnc(_simWasmScratch), _simWasmScratchWords);
    }
};
// navStepCosts by rows (P[2] a job): pass P[0] 0 the rows' horizontal
// reach flags into navb.h (bit 0: a wall within 1, bit 1: within 2), pass 1
// the costs from those of the rows around.
const SIM_KERNEL_NAV_COST = 18;
const _navCostW = _simWK(['navb.wall', 'navb.h', 'navb.cost']);
SIM_KERNELS[SIM_KERNEL_NAV_COST] = function (R, P, chunk) { _simRust(_navCostW, P, chunk, 'k_nav_cost', 'NAV_COST'); };
// Abstract graph: intra-cluster edges (costs from the local fields) and
// the border crossings (the step cost of the tile entered), now: the edge
// counts, their places, the edges.
function navBuildGraph(b) {
    _navBuildBind(b);
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
    _navBuildBind(b);
    const k = b.k, N = b.adjN, adjStart = _navArr(Int32Array, k + 1);
    let e = 0;
    for (let i = 0; i < k; i++) { adjStart[i] = e; e += N[i]; }
    adjStart[k] = e;
    b.adjStart = adjStart; b.adjA = _navArr(Int32Array, Math.max(1, e)); b.adjC = _navArr(Int32Array, Math.max(1, e));
    b.adjMax = _navArr(Int32Array, Math.max(1, Math.ceil(k / NAV_GRAPH_PER_JOB)));
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
const _navGraphW = _simWK(['navb.fields', 'navb.nt', 'navb.nb', 'navb.np', '?navb.cost', 'navb.adjN', '?navb.adjS', '?navb.adjA', '?navb.adjC', '?navb.adjMax']);
SIM_KERNELS[SIM_KERNEL_NAV_GRAPH] = function (R, P, chunk) { _simRust(_navGraphW, P, chunk, 'k_nav_graph', 'NAV_GRAPH'); };
function navBuildFinish(b, atlas = true) {
    return { profile: b.profile, C: b.C, cs: 31 - Math.clz32(b.C), cw: b.cw, ch: b.ch, nc: b.nc, W: b.W, H: b.H, k: b.k,
        nodeBase: b.nodeBase, nodeTile: b.nodeTile, nodePair: b.nodePair, fields: b.fields, wall: b.wall, cost: b.cost,
        adjStart: b.adjStart, adjA: b.adjA, adjC: b.adjC, B: b.B,
        partL: b.partL, partBase: b.partBase, np: b.np, nodePart: b.nodePart, partComp: b.partComp, partCluster: b.partCluster,
        ncomp: b.ncomp, compStart: b.compStart, compParts: b.compParts,
        // (Its routing atlas: every destination by lookups.)
        atlas: atlas ? navAtlasBuild(b) : null };
}

// ---- The routing atlas (NAVIGATION_OPTIMIZATION.md; wasm/src/atlas.rs) ----
// Every destination by lookups: no destination field, row or search per
// order. Made with each build (navBuildFinish), from its walls, parts and
// exit nodes alone: per 8x8 block its wall mask and components, per cluster
// the next block component toward any other of the same part, and over the
// parts a hierarchy of domains (4 x 4 children a level) with each node's
// all-pairs crossings. Routes on it carry NAV_ATLAS_FID as their field id
// (navFieldRequest), are ready at once, and step by nav_step's atlas branch
// (the movement kernel) or nav_atlas_step (navStep).
let NAV_ATLAS = true;
const NAV_ATLAS_FID = 1 << 30;
const SIM_KERNEL_ATL_BLOCKS = 86, SIM_KERNEL_ATL_TABLES = 87, SIM_KERNEL_ATL_ROUTE = 88;
const _atlBlocksW = _simWK(['navb.wall', 'navb.partL', 'atl.partB', 'atl.bm', 'atl.bc', 'atl.cb', 'atl.cn', 'atl.psx', 'atl.psy', 'atl.psn']);
SIM_KERNELS[SIM_KERNEL_ATL_BLOCKS] = function (R, P, chunk) { _simRust(_atlBlocksW, P, chunk, 'k_atl_blocks', 'ATL_BLOCKS'); };
const _atlTablesW = _simWK(['atl.bm', 'atl.bc', 'atl.cb', 'atl.cn', 'atl.co', 'atl.ct']);
SIM_KERNELS[SIM_KERNEL_ATL_TABLES] = function (R, P, chunk) { _simRust(_atlTablesW, P, chunk, 'k_atl_tables', 'ATL_TABLES'); };
const _atlRouteW = _simWK(['navb.adjS', 'navb.adjA', 'navb.adjC', 'atl.npart', 'atl.anc', 'atl.cip', 'atl.cin', 'atl.didx', 'atl.dnodes', 'atl.dno', 'atl.dn', 'atl.rco', 'atl.rc', 'atl.jobs']);
SIM_KERNELS[SIM_KERNEL_ATL_ROUTE] = function (R, P, chunk) { _simRust(_atlRouteW, P, chunk, 'k_atl_route', 'ATL_ROUTE'); };
const NAV_ATLAS_CLUSTERS_PER_JOB = 8;
// The build's atlas (null: off, or no build arrays), its kernels run now
// (the helpers help): a map's first builds. A rebuild's go on the build's
// lane between its stages (navAtlasStart, navAtlasTables, navAtlasFinish:
// _navJobStep), installed with it.
function navAtlasBuild(b) {
    if (typeof simParallelBackgroundWait === 'function') simParallelBackgroundWait(_navBuildLane());
    const A = navAtlasStart(b, false);
    if (!A) return null;
    navAtlasTables(A, false);
    return navAtlasFinish(A);
}
// Its arrays, the hierarchy over the parts (O(exit nodes x levels), here),
// then its blocks and the costs on to each node's children: kernels now, or
// (bg) a chain on the build's lane.
function navAtlasStart(b, bg) {
    if (!NAV_ATLAS || !(b.np > 0) || typeof simParallelRun !== 'function') return null;
    if (typeof simParallelBackgroundWait === 'function') simParallelBackgroundWait(_navBuildLane());
    const { W, H, C, cw, ch, nc, np, k, nodePair, nodePart, partCluster } = b;
    const bw = Math.ceil(W / 8), bh = Math.ceil(H / 8), nb = bw * bh;
    const bm = _navArr(Uint32Array, nb * 2), bc = _navArr(Uint8Array, W * H), cb = _navArr(Uint16Array, nb), cn = _navArr(Int32Array, nc);
    const psx = _navArr(Float64Array, np), psy = _navArr(Float64Array, np), psn = _navArr(Int32Array, np);
    // ---- The hierarchy over the parts ----
    // Items of the level below (parts first) with their domain coordinates
    // (clusters, then the domains of the level below); each part's item.
    let n0 = np;
    let ix = new Int32Array(np), iy = new Int32Array(np);
    for (let p = 0; p < np; p++) { const c = partCluster[p]; ix[p] = c % cw; iy[p] = (c - ix[p]) / cw; }
    const partItem = new Int32Array(np);
    for (let p = 0; p < np; p++) partItem[p] = p;
    const levels = [], cip = _navArr(Uint16Array, np);
    let total = 0, span = 1;
    for (let lv = 0; lv < 16; lv++) {
        span *= 4;
        const dwx = Math.ceil(cw / span), dhy = Math.ceil(ch / span);
        // (Domain of an item: its coordinates at the level below, / 4.)
        const dom = new Int32Array(n0);
        for (let i = 0; i < n0; i++) dom[i] = (iy[i] >> 2) * dwx + (ix[i] >> 2);
        // Components of the items within a domain (exit pairs joining
        // them): union-find, a set's root its lowest item.
        const uf = new Int32Array(n0);
        for (let i = 0; i < n0; i++) uf[i] = i;
        const find = x => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };
        for (let e = 0; e < k; e++) {
            const f = nodePair[e];
            if (f < 0) continue;
            const a = partItem[nodePart[e]], c = partItem[nodePart[f]];
            if (a === c || dom[a] !== dom[c]) continue;
            const ra = find(a), rc = find(c);
            if (ra < rc) uf[rc] = ra; else if (rc < ra) uf[ra] = rc;
        }
        // Nodes in the order of their first item; children in item order.
        const node = new Int32Array(n0), rootNode = new Int32Array(n0).fill(-1);
        let n1 = 0;
        for (let i = 0; i < n0; i++) { const r = find(i); if (rootNode[r] < 0) rootNode[r] = n1++; node[i] = rootNode[r]; }
        const nch = new Int32Array(n1), cin = new Uint16Array(n0);
        for (let i = 0; i < n0; i++) cin[i] = nch[node[i]]++;
        if (lv === 0) cip.set(cin);
        else levels[lv - 1].cinUp = cin;
        // The nodes as the next level's items.
        const nx = new Int32Array(n1), ny = new Int32Array(n1);
        for (let i = 0; i < n0; i++) { const d = node[i]; nx[d] = ix[i] >> 2; ny[d] = iy[i] >> 2; }
        const anc = new Int32Array(np);
        for (let p = 0; p < np; p++) { partItem[p] = node[partItem[p]]; anc[p] = total + partItem[p]; }
        levels.push({ n: n1, nch, anc, base: total, cinUp: null });
        total += n1;
        ix = nx; iy = ny; n0 = n1;
        if (dwx <= 1 && dhy <= 1) break;
    }
    const L = levels.length;
    const anc = _navArr(Int32Array, Math.max(1, np * L)), cinA = _navArr(Uint16Array, Math.max(1, total)), nchA = new Int32Array(Math.max(1, total));
    for (let lv = 0; lv < L; lv++) { const Lv = levels[lv], A = Lv.anc; for (let p = 0; p < np; p++) anc[p * L + lv] = A[p]; for (let d = 0; d < Lv.n; d++) { nchA[Lv.base + d] = Lv.nch[d]; if (Lv.cinUp) cinA[Lv.base + d] = Lv.cinUp[d]; } }
    // Each node's exit nodes (those of its parts), in node order, and each
    // exit node's place in its node at every level.
    const dn = _navArr(Int32Array, Math.max(1, total)), dno = _navArr(Int32Array, total + 1), didx = _navArr(Int32Array, Math.max(1, k * L));
    for (let lv = 0; lv < L; lv++) for (let e = 0; e < k; e++) dn[anc[nodePart[e] * L + lv]]++;
    for (let d = 0; d < total; d++) dno[d + 1] = dno[d] + dn[d];
    const dnodes = _navArr(Int32Array, Math.max(1, dno[total])), fill = new Int32Array(total);
    for (let lv = 0; lv < L; lv++) for (let e = 0; e < k; e++) { const d = anc[nodePart[e] * L + lv], x = fill[d]++; dnodes[dno[d] + x] = e; didx[e * L + lv] = x; }
    // The costs on to each child of a node from each of its exit nodes
    // (kernel ATL_ROUTE, a job a node and child: nodes of one child need
    // none).
    const rco = _navArr(Int32Array, Math.max(1, total));
    let pool = 0, nj = 0;
    for (let d = 0; d < total; d++) { rco[d] = pool; if (nchA[d] > 1) { pool += nchA[d] * dn[d]; nj += nchA[d]; } }
    const rc = _navArr(Uint32Array, Math.max(1, pool), false), jobs = _navArr(Int32Array, Math.max(3, nj * 3));
    let jx = 0;
    for (let lv = 0; lv < L; lv++) { const Lv = levels[lv]; for (let d = Lv.base; d < Lv.base + Lv.n; d++) if (nchA[d] > 1) for (let t = 0; t < nchA[d]; t++) { jobs[jx++] = d; jobs[jx++] = t; jobs[jx++] = lv; } }
    simParallelBind('navb.wall', b.wall); simParallelBind('navb.partL', b.partL); simParallelBind('atl.partB', b.partBase);
    simParallelBind('atl.bm', bm); simParallelBind('atl.bc', bc); simParallelBind('atl.cb', cb); simParallelBind('atl.cn', cn);
    simParallelBind('atl.psx', psx); simParallelBind('atl.psy', psy); simParallelBind('atl.psn', psn);
    simParallelBind('navb.adjS', b.adjStart); simParallelBind('navb.adjA', b.adjA); simParallelBind('navb.adjC', b.adjC);
    simParallelBind('atl.npart', nodePart); simParallelBind('atl.anc', anc); simParallelBind('atl.cip', cip); simParallelBind('atl.cin', cinA);
    simParallelBind('atl.didx', didx); simParallelBind('atl.dnodes', dnodes); simParallelBind('atl.dno', dno); simParallelBind('atl.dn', dn);
    simParallelBind('atl.rco', rco); simParallelBind('atl.rc', rc); simParallelBind('atl.jobs', jobs);
    const blockJobs = Math.ceil(nc / NAV_ATLAS_CLUSTERS_PER_JOB);
    const blockP = P => { P[0] = nc; P[1] = NAV_ATLAS_CLUSTERS_PER_JOB; P[2] = W; P[3] = H; P[4] = C; P[5] = cw; P[6] = bw; };
    const routeP = P => { P[0] = nj; P[1] = L; };
    if (bg) {
        const lane = _navBuildLane();
        const P0 = simParallelStageParams(lane, 0), P1 = simParallelStageParams(lane, 1);
        P0.fill(0); P1.fill(0); blockP(P0); routeP(P1);
        simParallelBackgroundChain(lane, [[SIM_KERNEL_ATL_BLOCKS, blockJobs], [SIM_KERNEL_ATL_ROUTE, nj]]);
    } else {
        const P = _simParams;
        blockP(P);
        simParallelRun(SIM_KERNEL_ATL_BLOCKS, blockJobs);
        routeP(P);
        if (nj > 0) simParallelRun(SIM_KERNEL_ATL_ROUTE, nj);
    }
    return { L, C, cw, bw, np, W, H, nc, bm, bc, cb, co: null, ct: null, cn, anc, cip, cin: cinA, rco, rc, dn, didx, nodes: total, poolEntries: pool, jobs: nj,
        nodePart, nodeBase: b.nodeBase, header: null, blockP };
}
// The clusters' tables (n x n entries each, from the block counts: after
// navAtlasStart's kernels), now or (bg) on the build's lane.
function navAtlasTables(A, bg) {
    if (!A) return;
    if (typeof simParallelBackgroundWait === 'function') simParallelBackgroundWait(_navBuildLane());
    const { nc, cn } = A;
    const co = _navArr(Int32Array, nc + 1);
    for (let c = 0; c < nc; c++) co[c + 1] = co[c] + cn[c] * cn[c];
    const ct = _navArr(Uint32Array, Math.max(1, co[nc]), false);
    A.co = co; A.ct = ct;
    simParallelBind('atl.bm', A.bm); simParallelBind('atl.bc', A.bc); simParallelBind('atl.cb', A.cb); simParallelBind('atl.cn', cn);
    simParallelBind('atl.co', co); simParallelBind('atl.ct', ct);
    const jobs = Math.ceil(nc / NAV_ATLAS_CLUSTERS_PER_JOB);
    if (bg) {
        const lane = _navBuildLane(), P = simParallelStageParams(lane, 0);
        P.fill(0); A.blockP(P);
        simParallelBackgroundChain(lane, [[SIM_KERNEL_ATL_TABLES, jobs]]);
    } else {
        A.blockP(_simParams);
        simParallelRun(SIM_KERNEL_ATL_TABLES, jobs);
    }
}
// Made (its kernels done): the header the kernels read; the scratch names
// let go.
function navAtlasFinish(A) {
    if (!A || !A.ct) return null;
    // Four reads certify an empty rectangle of 8x8 blocks. This belongs to
    // the shared immutable geometry (~63 KiB for a 1000x1000 map).
    const stride=A.bw+1,bh=(A.H+7)>>3;
    A.clearPrefix=_navArr(Int32Array,stride*(bh+1));
    for(let y=0;y<bh;y++){
        let row=0;
        for(let x=0;x<A.bw;x++){
            const k=(y*A.bw+x)*2;
            row+=(A.bm[k]|A.bm[k+1])!==0?1:0;
            A.clearPrefix[(y+1)*stride+x+1]=A.clearPrefix[y*stride+x+1]+row;
        }
    }
    simParallelBind('atl.jobs', null); simParallelBind('atl.dnodes', null); simParallelBind('atl.dno', null);
    simParallelBind('atl.psx', null); simParallelBind('atl.psy', null); simParallelBind('atl.psn', null);
    A.header = navAtlasHeader(A, A.nodePart, A.nodeBase);
    A.blockP = null;
    return A.header ? A : null;
}
// The header the kernels read (atlas.rs Atl): sizes, the arrays' addresses.
function navAtlasHeader(A, nodePart, nodeBase) {
    // Validate byte addresses before storing them in signed ABI words:
    // valid wasm32 addresses in the upper 2 GiB have a negative Int32 value.
    for (const a of [A.bm, A.bc, A.cb, A.co, A.ct, A.anc, A.cip, A.cin, A.rco, A.rc, A.dn, nodePart, A.cn, A.didx, nodeBase]) {
        if (!(_simHeapPtrOf(a) > 0)) return null;
    }
    const h = _navArr(Int32Array, 24), ptr = a => _simWEnc(_simHeapPtrOf(a));
    h[0] = A.L; h[1] = A.C; h[2] = A.cw; h[3] = A.bw; h[4] = A.np;
    h[5] = ptr(A.bm); h[6] = ptr(A.bc); h[7] = ptr(A.cb); h[8] = ptr(A.co); h[9] = ptr(A.ct); h[10] = ptr(A.anc); h[11] = ptr(A.cip);
    h[12] = ptr(A.cin); h[13] = ptr(A.rco); h[14] = ptr(A.rc); h[15] = ptr(A.dn); h[16] = ptr(nodePart); h[17] = ptr(A.cn);
    h[18] = ptr(A.didx); h[19] = ptr(nodeBase);
    h[20] = A.clearPrefix ? ptr(A.clearPrefix) : 0;
    return h;
}
// The next tile from t toward dest on profile p's atlas (-1 none): the
// movement kernel's (atlas.rs nav_atlas_step).
function navAtlasStep(nav, t, dest) {
    const A = nav && nav.atlas;
    if (!A || !A.header || _simWasmX === null || !_simWasmX.nav_atlas_step) return -1;
    // (The arrays' addresses worked out once while they stay the same arrays: past 2^30 a number is a heap
    // allocation, six of them a call.)
    let c = nav._asc;
    if (!c || c.h !== A.header || c.pl !== nav.partL || c.pb !== nav.partBase || c.nt !== nav.nodeTile || c.np !== nav.nodePair || c.f !== nav.fields) {
        const ptr = a => _simWEnc(_simHeapPtrOf(a));
        c = nav._asc = { h: A.header, pl: nav.partL, pb: nav.partBase, nt: nav.nodeTile, np: nav.nodePair, f: nav.fields,
            eh: ptr(A.header), epl: ptr(nav.partL), epb: ptr(nav.partBase), ent: ptr(nav.nodeTile), enp: ptr(nav.nodePair), ef: ptr(nav.fields) };
    }
    return _simWasmX.nav_atlas_step(c.eh, c.epl, c.epb, c.ent, c.enp, c.ef, nav.W, t, dest);
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
let _nav = new Array(NAV_PROFILES).fill(null);
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
// (30: ~16k live ground fields at 80k units (workers' sites, rally points)
// did not fit 10 on the lane's capped helpers: the install waited ~60 ms
// for the rest. A build is ~150 ticks; units follow the old one meanwhile.)
const NAV_SWAP_TICKS = 30;
const _navNext = { nav: null, rowW: 0, pools: [null, null], stages: null, spare: [null, null] };
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
    // (A growth on its way (_navGrowPlan): finished first, then grown no more
    // if that gave room.)
    if (_navGrow[F.wide ? 1 : 0]) { _navGrowSwap(); if (F.cap >= cap || F.free.length) return; }
    // (The fields' job finished first: its slots copied whole; taken at the
    // next flush as always.)
    _navFieldsLaneWait();
    const size = F.span * F.span, pool = simHeapArrayAuto(Uint16Array, cap * size), meta = simHeapArrayAuto(Int32Array, cap * NAV_FIELD_META), seen = new Int32Array(cap);
    const rows = simHeapArrayAuto(Uint8Array, Math.max(1, cap * F.rowW));
    const rowKeyOf = new Float64Array(cap).fill(-1);
    // (The heap arrays in one parallel copy: ~100 MB of rows at 32k slots.)
    const copies = [];
    if (F.pool) { copies.push(pool, F.pool, meta, F.meta); seen.set(F.seen); rowKeyOf.set(F.rowKeyOf); }
    if (F.rows && F.rows.length <= rows.length) copies.push(rows, F.rows);
    if (typeof simParallelCopyHeap === 'function') simParallelCopyHeap(copies); else for (let i = 0; i < copies.length; i += 2) copies[i].set(copies[i + 1]);
    F.rowKeyOf = rowKeyOf;
    for (let s = cap - 1; s >= F.cap; s--) { F.free.push(s); meta[s * NAV_FIELD_META] = -1; }
    F.pool = pool; F.meta = meta; F.seen = seen; F.cap = cap; F.rows = rows;
    const w = F.wide ? 1 : 0;
    simParallelBind('nav.fpool.' + w, pool); simParallelBind('nav.fmeta.' + w, meta); simParallelBind('nav.frows.' + w, rows);
    _navFieldsHeader();
    if (_navNext.nav) { _navNextPoolEnsure(F); _navNextCopyFlush(); }
    _navNextExpect();
}
// Rows wide enough for the installed builds' parts (a build installed: every
// field is made again anyway, see navPublish).
// A row width for builds of up to `parts` parts: the pools' own while it
// fits (every pool has the same), else a quarter more, in 64-byte steps.
// (A build with a few more parts than the last changed the width, and the
// install then copied every field of every profile, one by one, into wider
// rows: ~60 ms for 20k fields.)
function _navRowWidthFor(parts) {
    let cur = 0;
    for (const F of _navFields.pools) if (F.pool && F.rowW > cur) cur = F.rowW;
    if (cur >= parts) return cur;
    return Math.ceil(Math.max(1, parts) * 1.25 / 64) * 64;
}
function _navRowsEnsure() {
    let w = 1;
    for (const nav of _nav) if (nav && nav.np > w) w = nav.np;
    for (const F of _navFields.pools) {
        if (!F.pool || F.rowW >= w) continue;
        F.rowW = _navRowWidthFor(w);
        F.rows = simHeapArrayAuto(Uint8Array, Math.max(1, F.cap * F.rowW));
        F.rowSrc = new Map();
        simParallelBind('nav.frows.' + (F.wide ? 1 : 0), F.rows);
    }
    _navFieldsHeader();
}
// (nav.fhdr: the pools' row widths, then the next build's: _navNext.)
function _navFieldsHeader() {
    if (!_navFields.hdr) { _navFields.hdr = simHeapArrayAuto(Int32Array, 4); simParallelBind('nav.fhdr', _navFields.hdr); }
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
    // (On the atlas: no field, the same id for every destination.)
    if (NAV_ATLAS && nav.atlas && nav.atlas.header) return NAV_ATLAS_FID;
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
function navFieldGen(id) { return id === NAV_ATLAS_FID ? 0 : id >= 0 ? _navFieldPool(id).meta[_navFieldIndex(id) * NAV_FIELD_META + 6] : 0; }
// The tick a route on field id may start: on the atlas at once.
function navFieldReadyFor(id) { return id === NAV_ATLAS_FID ? 0 : navFieldReadyTick(); }
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
    // (A pool grown in the background: its arrays swapped now, the job and
    // its copy done. See _navGrowPlan.)
    _navGrowSwap();
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
    // same over the next build; last, a pool's growth copy: _navGrowPlan.)
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
    const grow = _navGrowPlan(lane);
    if (grow) stages.push(grow);
    if (!taken.length && !grow) return;
    if (taken.length) _navFieldsJob.slots = taken;
    simParallelBackgroundChain(lane, stages);
}
// A pool's growth off the simulation thread: at the job's post, when under
// a quarter of its slots are free, the pool and rows of twice the slots
// are allocated and the old ones copied into them by the job's last stage
// (after its fields: those are in the copy); the next flush, the job taken,
// swaps them in with the meta (small, copied then: requests and the sweep
// write it meanwhile). Grown at a request, mid-tick, the copy (~50-100 MB:
// a field's row has a byte per part) was 12-40 ms, and the job in flight
// was waited for first. Not while a rebuild window is open or opens before
// the swap (its install writes the pools). Slots are this peer's
// bookkeeping, as the sweep's: when this happens changes nothing else.
const _navGrow = [null, null];
function _navGrowAllowed() {
    if (_navNext.nav) return false;
    const J = _navJob;
    return !(J && gameTime + 1 - J.start >= NAV_STEP_STAGE);
}
function _navGrowPlan(lane) {
    if (typeof simParallelCopyStage !== 'function' || !_navGrowAllowed()) return null;
    const pairs = [];
    for (let w = 0; w < 2; w++) {
        const F = _navFields.pools[w];
        if (!F.pool || _navGrow[w] || F.free.length >= Math.max(F.cap >> 2, F.wide ? 16 : 256)) continue;
        const cap = F.cap * 2, size = F.span * F.span;
        const G = { cap, C: F.C, rowW: F.rowW, pool: simHeapArrayAuto(Uint16Array, cap * size, false), rows: simHeapArrayAuto(Uint8Array, Math.max(1, cap * F.rowW), false) };
        _navGrow[w] = G;
        pairs.push(G.pool, F.pool, G.rows, F.rows);
    }
    if (!pairs.length) return null;
    const stage = simParallelCopyStage(pairs, simParallelStageParams(lane, 8));
    if (stage) return stage;
    // (Not in the heap: copied at the swap, after the job: its fields are
    // written into the old arrays.)
    for (let w = 0; w < 2; w++) if (_navGrow[w]) _navGrow[w].copyAtSwap = true;
    return null;
}
function _navGrowSwap() {
    if (!_navGrow[0] && !_navGrow[1]) return;
    // (The job with the copy: done. A job of no fields is not waited for by
    // the commit.)
    _navFieldsLaneWait();
    let any = false;
    for (let w = 0; w < 2; w++) {
        const G = _navGrow[w], F = _navFields.pools[w];
        if (!G) continue;
        _navGrow[w] = null;
        // (Rows made wider or a new cluster size meanwhile: dropped.)
        if (!F.pool || F.C !== G.C || F.rowW !== G.rowW || G.cap <= F.cap) continue;
        if (G.copyAtSwap) { G.pool.set(F.pool); G.rows.set(F.rows); }
        if (!any) { simParallelBindBatch(); any = true; }
        const meta = simHeapArrayAuto(Int32Array, G.cap * NAV_FIELD_META), seen = new Int32Array(G.cap), rowKeyOf = new Float64Array(G.cap).fill(-1);
        meta.set(F.meta); seen.set(F.seen); rowKeyOf.set(F.rowKeyOf);
        for (let s = G.cap - 1; s >= F.cap; s--) { F.free.push(s); meta[s * NAV_FIELD_META] = -1; }
        F.pool = G.pool; F.rows = G.rows; F.meta = meta; F.seen = seen; F.rowKeyOf = rowKeyOf; F.cap = G.cap;
        simParallelBind('nav.fpool.' + w, F.pool); simParallelBind('nav.fmeta.' + w, F.meta); simParallelBind('nav.frows.' + w, F.rows);
    }
    if (!any) return;
    simParallelBindFlush();
    _navFieldsHeader();
    for (const F of _navFields.pools) if (_navNext.nav && F.pool) _navNextPoolEnsure(F);
    _navNextCopyFlush();
    _navNextExpect();
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
// A slot's row key: its destination tile (+ profile), or (a wall
// destination) its own (-2 - slot: not shared). (next: the next build.)
function _navRowKey(F, s, next = null) {
    const m = s * NAV_FIELD_META, p = F.meta[m], dest = F.meta[m + 1], nav = next && next.profile === p ? next : _nav[p];
    if (!nav || !nav.partL || !(dest >= 0 && dest < nav.W * nav.H) || nav.partL[dest] === 0xFFFF) return -2 - s;
    // (Per destination tile: a row's searches start from the field's exits
    // at their distances to the destination, see _navFieldRow; the same
    // destination's fields share it.)
    return p * 16777216 + dest;
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
    for (let p = 0; p < NAV_PROFILES; p++) {
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
    // (A slot's row is its destination's: one slot a destination in a pool,
    // so every slot makes its own; nav.fsrc all -1, no copies.)
    const w = F.wide ? 1 : 0, n = slots.length, N = next ? _navNextPoolEnsure(F) : null;
    // (The next build's pools still being copied into: done before a batch
    // over them goes out on another lane.)
    if (N) _navNextCopyFlush();
    if (N && _navNext.copying) { simParallelBackgroundWait(SIM_LANE_NAVX); _navNext.copying = false; }
    if (N) for (let i = 0; i < n; i++) N.made[slots[i]] = 1;
    const list = simHeapArrayAuto(Int32Array, n), src = simHeapArrayAuto(Int32Array, n, false);
    list.set(slots);
    src.fill(-1);
    const copies = 0;
    simParallelBind('nav.flist.' + w + '.' + id, list); simParallelBind('nav.fsrc.' + w + '.' + id, src);
    const per = F.wide ? 1 : 2, P = new Float64Array(10);
    P[0] = n; P[1] = per; P[2] = F.span; P[3] = _nav[0] ? _nav[0].W : GRID_W; P[4] = _nav[0] ? _nav[0].H : GRID_H; P[5] = w; P[6] = 0; P[7] = bg || N ? 1 : 0; P[8] = N ? 1 : 0; P[9] = id;
    return { P, make: Math.ceil(n / per), copy: copies ? Math.ceil(n / 64) : 0 };
}
const SIM_KERNEL_NAV_FIELDS = 21;
// One destination field (slot at pool address poolP, element off, size
// elements) of profile p under the build named pre ('nav.' / 'navn.'), and its
// row at rowsP + ro (rowsP 0: none): Rust, wasm/src/lib.rs nav_field.
function _navFieldRust(R, pre, p, poolP, off, size, meta, m, rowsP, ro, W, H) {
    const WP = _simParWPtr, wallP = WP[pre + 'fwall.' + p], costR = R[pre + 'fcost.' + p], costP = costR && costR.length ? WP[pre + 'fcost.' + p] : 0;
    const row = rowsP > 0, g = pre + p + '.', NM = R[g + 'meta'];
    if (_simWasmX === null || !(poolP >= 0) || !(wallP >= 0) || !(costP >= 0) || (row && !NM)) _simNoWasm('NAV_FIELDS');
    // (Pointers as the kernels' 32-bit words: _simWEnc.)
    const E = _simWEnc;
    if (!_simWasmX.nav_field(E(poolP), off, size, meta[m + 2], meta[m + 3], meta[m + 4], meta[m + 5], W, H, meta[m + 1], E(wallP), E(costP),
        row ? 1 : 0, row ? E(WP[g + 'nb']) : 0, row ? E(WP[g + 'nt']) : 0, row ? E(WP[g + 'np']) : 0, row ? E(WP[g + 'npart']) : 0,
        row ? E(WP[g + 'adjS']) : 0, row ? E(WP[g + 'adjA']) : 0, row ? E(WP[g + 'adjC']) : 0, row ? E(WP[g + 'partL']) : 0, row ? E(WP[g + 'partB']) : 0,
        row ? NM[0] | 0 : 0, row ? NM[1] | 0 : 0, row ? NM[3] | 0 : 0, row ? NM[7] | 0 : 0, row ? Math.max(1, NM[8] | 0) : 1, row ? NM[9] | 0 : 0, row ? NM[10] | 0 : 0,
        E(rowsP), ro, E(_simWasmScratch), _simWasmScratchWords)) _simNoWasm('NAV_FIELDS');
}
SIM_KERNELS[SIM_KERNEL_NAV_FIELDS] = function (R, P, chunk) {
    // (Rust: wasm/src/lib.rs nav_field / nav_rows_copy, on the arrays' heap
    // addresses.)
    const w = P[5] | 0, next = P[8] === 1, id = P[9] | 0, WP = _simParWPtr;
    const fl = 'nav.flist.' + w + '.' + id, fs = 'nav.fsrc.' + w + '.' + id, list = R[fl], src = R[fs], meta = R['nav.fmeta.' + w];
    const poolName = (next ? 'nav.npool.' : 'nav.fpool.') + w, rowsName = (next ? 'nav.nrows.' : 'nav.frows.') + w;
    const hdr = R['nav.fhdr'], rowW = hdr ? hdr[(next ? 2 : 0) + w] | 0 : 0, rowsP = R[rowsName] && rowW > 0 ? WP[rowsName] : 0;
    const pre = next ? 'navn.' : 'nav.';
    const span = P[2] | 0, size = span * span, W = P[3] | 0, H = P[4] | 0, i0 = chunk * P[1], i1 = Math.min(P[0], i0 + P[1]);
    if (_simWasmX === null || !(WP[poolName] >= 0) || !(WP[fl] >= 0) || !(WP[fs] >= 0) || (R[rowsName] && rowW > 0 && !(rowsP >= 0))) _simNoWasm('NAV_FIELDS');
    // (Phase 1: the rows copied from their key's slot, P[6].)
    if (P[6] === 1) { if (rowsP > 0) _simWasmX.nav_rows_copy(_simWEnc(rowsP), _simWEnc(WP[fl]), _simWEnc(WP[fs]), rowW, i0, i1); return; }
    for (let i = i0; i < i1; i++) {
        const s = list[i], m = s * NAV_FIELD_META, p = meta[m];
        if (!R[pre + 'fwall.' + p]) continue;
        _navFieldRust(R, pre, p, WP[poolName], s * size, size, meta, m, rowsP > 0 && !(src && src[i] >= 0) ? rowsP : 0, s * rowW, W, H);
        // (In the background, marked made at the job's taking; the next
        // build's, at its install.)
        if (P[7] !== 1) meta[m + 7] = 1;
    }
};;
// Staggered sweep: over NAV_FIELD_SWEEP_TICKS ticks every unit marks the
// fields its route refers to (requests mark theirs); then the fields not
// marked in the cycle are dropped. (Memory only: a route's field is never
// dropped while it is followed.)
function _navFieldMark(profile, dest, wide, mark) {
    const F = _navFields.pools[wide ? 1 : 0], s = F.byKey.get(_navFieldKey(profile, dest));
    if (s !== undefined) F.seen[s] = mark;
}
function navFieldsSweepStep() {
    const step = NAV_FIELD_SWEEP_TICKS;
    // (The slices of the step's base ticks in turn; a cycle ends with its
    // last, the next one's marks after it.)
    const phases = simStepPhases(step);
    for (let i = 0; i < phases.length;) {
        const k = phases[i];
        let end = i + 1;
        while (end < phases.length && phases[end] === phases[end - 1] + 1) end++;
        const mark = _navFields.seenCycle + 1;
        _navFieldsSweepSlice(k, step, mark, end - i);
        if (phases[end - 1] === step - 1) _navFieldsSweepEnd(step - 1, step, mark);
        i = end;
    }
}
function _navFieldsSweepSlice(k, step, mark, count = 1) {
    // (From the slots' columns: a unit's route field (rtEnd, nvProf, its
    // route key in oc__routeKey) and its path's last flow node's (nvPK, the
    // path setter's). No unit object is read.)
    // (By the units list's order, the same on every peer, through the slot
    // map: by slot, which units a cycle visits, and so which fields it
    // drops, depended on each peer's slot layout (a restore, a join).)
    const S = typeof _simUnitState !== 'undefined' ? _simUnitState : null;
    const slots = S && typeof _unitSlotMapEnsure === 'function' ? _unitSlotMapEnsure() : null;
    if (S && slots) {
        const C = S.columns, LIVE = C.live, DEAD = C.dead, RE = C.rtEnd, PR = C.nvProf, PK = C.nvPK, RK = C.rkF, n = units.length;
        const Fn = _navFields.pools[0], Fw = _navFields.pools[1];
        // Adjacent base-tick shares touch adjacent entries. Visit them together
        // so a long adaptive step reads each cache line once, while retaining
        // the same shares and the cycle boundary's field-expiry decisions.
        for (let base = k; base < n; base += step) for (let i = base, end = Math.min(n, base + count); i < end; i++) {
            const s = slots[i];
            if (!(s >= 0) || !LIVE[s] || DEAD[s]) continue;
            const e = RE[s];
            if (e >= 0 && RK[s] === 1) { const sl = Fw.byKey.get(PR[s] * 16777216 + e); if (sl !== undefined) Fw.seen[sl] = mark; }
            const pk = PK[s];
            if (pk >= 0) { const F = (pk & 1) ? Fw : Fn, sl = F.byKey.get(pk >> 1); if (sl !== undefined) F.seen[sl] = mark; }
        }
    }
}
function _navFieldsSweepEnd(k, step, mark) {
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
let _navQ = null;

function navWallTable(profile) {
    if (profile === NAV_PROFILE_AIR) return _airWallTable();
    if (profile === NAV_PROFILE_GROUND) return simMoveWallGrid();
    return _navClassWalls(profile);
}

// ---- Walk classes' walls ----
// A class profile's walls: the ground's, but for the tiles its units may
// walk over (canUnitOccupyTile): active mines for collectors, the player's
// own buildings for its builders. Kept per tile as walls and tile entities
// change (wasm/src/tch.rs k_tile_changes: from simMoveTileTypeChanged and
// simMoveTileEntityChanged, deferred through the unit pass as the walls
// are), made whole when missing or the grid was replaced. Bound as
// 'mv.cwall.<profile>' (the movement kernel's walls for its units). A pure
// function of the grid and its tile entities: the same on every peer.
const _navClassWall = new Array(NAV_PROFILES).fill(null);
let _navClassGrid = null;
function _navClassPass(profile, x, y) {
    if (profile === NAV_PROFILE_COLLECT) return hasActiveGoldMineAt(x, y) || hasActiveAstarMineAt(x, y);
    return _hasOwnedTileEntityAt(profile - NAV_PROFILE_BUILD0, x, y);
}
function _navClassWalls(profile) {
    const ground = simMoveWallGrid();
    if (_navClassGrid !== grid) { _navClassWall.fill(null); _navClassGrid = grid; }
    let w = _navClassWall[profile];
    if (w && w.length === ground.length) return w;
    w = simHeapArrayAuto(Uint8Array, ground.length);
    w.set(ground);
    const W = GRID_W, H = GRID_H;
    const open = (gx, gy) => { if (gx >= 0 && gy >= 0 && gx < W && gy < H) { const t = gy * W + gx; if (w[t] && _navClassPass(profile, gx, gy)) w[t] = 0; } };
    if (profile === NAV_PROFILE_COLLECT) { for (const list of [goldMines, astarMines]) for (const m of list || []) if (m) open(m.gx, m.gy); }
    else for (const e of _activeTileEntities) if (e && e.owner === profile - NAV_PROFILE_BUILD0) open(e.gx, e.gy);
    _navClassWall[profile] = w;
    if (typeof simParallelBind === 'function') simParallelBind('mv.cwall.' + profile, w);
    return w;
}
// The ground walls were made whole again: the class walls too.
function navClassReset() {
    _navClassWall.fill(null);
    for (let p = NAV_PROFILE_COLLECT; p < NAV_PROFILES; p++) if (_nav[p]) _navWallDiffReset(p);
}
// The profiles a match uses: ground, air, collectors, every player's
// builders (made at its first tick, see navTick).
function _navProfilesInUse() {
    const n = Math.min(NAV_BUILD_PLAYERS, typeof players !== 'undefined' && players ? players.length : 0), out = [NAV_PROFILE_GROUND, NAV_PROFILE_AIR, NAV_PROFILE_COLLECT];
    for (let p = 0; p < n; p++) out.push(NAV_PROFILE_BUILD0 + p);
    return out;
}

// Installs a build as the current one for its profile (every peer at the
// same tick). Destination fields of the old build are dropped.
// (_navVersion: this peer's count of installs, for caches; nav.seq: the
// profile's build number, the same on every peer: snapshotted, so waiting
// units can tell a new build, see _tryUpgradeAstarFallbackPath.)
let _navVersion = 0, _navSeq = new Array(NAV_PROFILES).fill(0);
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
    // (The build it replaced, and its job's own arrays: given back later.)
    _navSweep();
    // Every destination field again over the new build (same slots: the
    // routes keep following them), at the next flush (navFieldsFlush):
    // until then the old build's. (Rows: the new build's parts.)
    if (!made) _navFieldsRemakeAll();
    else _navFieldsHeader();
    // (Components changed: substitutes asked for again.)
    _navSubReset();
    if (p !== NAV_PROFILE_AIR) _navWallDiffReset(p);
}
// A build's arrays for the kernels under names pre + profile + '.' + name
// ('nav.': the installed one, 'navn.': the next, _navNextStage).
function _navBindBuild(pre, nav) {
    const p = nav.profile;
    simParallelBind(pre + p + '.fields', nav.fields);
    // meta: [C, cw, ch, nc, W, H, version, parts, the graph's bucket count
    // (largest edge + 1), nodes, edges, components]
    const meta = simHeapArrayAuto(Int32Array, 12);
    meta[0] = nav.C; meta[1] = nav.cw; meta[2] = nav.ch; meta[3] = nav.nc; meta[4] = nav.W; meta[5] = nav.H; meta[6] = nav.version | 0;
    meta[7] = nav.np | 0; meta[8] = nav.B | 0; meta[9] = nav.k | 0; meta[10] = nav.adjA ? nav.adjA.length : 0; meta[11] = nav.ncomp | 0;
    simParallelBind(pre + p + '.meta', meta);
    simParallelBind(pre + p + '.nb', nav.nodeBase); simParallelBind(pre + p + '.nt', nav.nodeTile); simParallelBind(pre + p + '.np', nav.nodePair);
    simParallelBind(pre + p + '.partL', nav.partL); simParallelBind(pre + p + '.partB', nav.partBase); simParallelBind(pre + p + '.npart', nav.nodePart);
    simParallelBind(pre + p + '.pcomp', nav.partComp);
    simParallelBind(pre + p + '.adjS', nav.adjStart); simParallelBind(pre + p + '.adjA', nav.adjA); simParallelBind(pre + p + '.adjC', nav.adjC);
    simParallelBind(pre + p + '.pclu', nav.partCluster); simParallelBind(pre + p + '.cstart', nav.compStart); simParallelBind(pre + p + '.cparts', nav.compParts);
    simParallelBind(pre + p + '.atl', nav.atlas && nav.atlas.header ? nav.atlas.header : null);
}

// ---- A rebuild's window (see _navNext) ----
// Opens it: the next build's arrays bound (the other profile's: the
// installed one), every live field made over it in the background. (Those
// asked for since the last flush: in this tick's job, both builds.)
function _navNextStage(nav) {
    if (_navNext.nav) _navNextDrop();
    _navNext.nav = nav;
    // (Its bindings, ~100, to the helpers in one message each, before the
    // job is posted: simParallelBindBatch.)
    simParallelBindBatch();
    try { _navNextStageBody(nav); } finally { simParallelBindFlush(); }
    simParallelBackgroundChain(SIM_LANE_NAVX, _navNext.stages);
    _navNext.stages = null;
}
function _navNextStageBody(nav) {
    // (The other profiles' installed builds under the next's names too: the
    // fields asked for in the window are made over the next builds of every
    // profile, theirs the same ones.)
    let rowW = Math.max(1, nav.np | 0);
    for (const b of [nav, ..._nav.filter(x => x && x.profile !== nav.profile)]) {
        _navBindBuild('navn.', b);
        simParallelBind('navn.fwall.' + b.profile, b.wall); simParallelBind('navn.fcost.' + b.profile, b.cost || _navNoCost);
        rowW = Math.max(rowW, b.np | 0);
    }
    // (The pools' row width when the builds fit it: the install then copies
    // the rebuilt profile's fields in place. Wider: with headroom.)
    _navNext.rowW = _navRowWidthFor(rowW);
    const lane = SIM_LANE_NAVX, stages = [], prof = nav.profile;
    for (let i = 0; i < 4; i++) stages.push([SIM_KERNEL_NAV_FIELDS, 0]);
    for (const F of _navFields.pools) {
        if (!F.pool) continue;
        _navNextPoolEnsure(F);
        // (Its live slots of the rebuilt profile not pending, in order: from
        // the meta, not the map. The other profiles' fields are over the same
        // builds after the install: theirs are kept, see _navNextInstall. All
        // of them, ~16k at 80k units in a chaos scenario, did not fit the
        // window: the install waited 50-350 ms for the rest.)
        const pend = F.pending.length ? new Set(F.pending) : null, meta = F.meta;
        let slots = new Int32Array(F.cap), n = 0;
        for (let s = 0; s < F.cap; s++) if (meta[s * NAV_FIELD_META] === prof && !(pend && pend.has(s))) slots[n++] = s;
        if (!n) continue;
        _navFieldsStage(lane, stages, F.wide ? 1 : 0, _navFieldsBatch(F, slots.subarray(0, n), true, 2, true));
    }
    _navFieldsHeader();
    // (Both pools made: no headroom kept for them any more.)
    if (typeof simHeapExpectDone === 'function') simHeapExpectDone('navNext');
    // (Posted by _navNextStage once the bindings are sent.)
    _navNext.stages = stages;
}
// A pool's arrays over the next build (as many slots as the pool; grown
// with it, after the background batches that write them).
function _navNextPoolEnsure(F) {
    const w = F.wide ? 1 : 0;
    let N = _navNext.pools[w];
    if (N && N.cap === F.cap) return N;
    if (N) { _navFieldsLaneWait(); simParallelBackgroundWait(SIM_LANE_NAVX); }
    // (Not cleared: a slot's field and row are written whole before it is
    // marked made, and nothing reads a slot not made; clearing ~300 MB at
    // 400k a team took 60-150 ms of the rebuild's first tick. Grown: the
    // made slots' fields copied on the helpers, both pools' in one stage on
    // SIM_LANE_NAVX (_navNextCopyFlush: whatever reads or writes the pools
    // waits for that lane first; a batch over this build on the fields'
    // lane too, see _navFieldsBatch): ~100 MB copied here were 15-25 ms ticks.)
    // (A window's opening: the last window's arrays when they fit (kept by
    // _navNextRelease), not ~230 MB allocated anew: 10-13 ms an array.)
    const rowW = _navNext.rowW, sp = N ? null : _navNext.spare[w];
    _navNext.spare[w] = null;
    const reuse = !!sp && sp.cap === F.cap && sp.rowW === rowW && sp.span === F.span;
    const pool = reuse ? sp.pool : simHeapArrayAuto(Uint16Array, F.cap * F.span * F.span, false), rows = reuse ? sp.rows : simHeapArrayAuto(Uint8Array, Math.max(1, F.cap * rowW), false), rowKeyOf = new Float64Array(F.cap).fill(-1);
    // (made: the slots a batch over this build was given, written before the
    // install waits for them; see _navNextInstall.)
    const made = new Uint8Array(F.cap);
    if (N) {
        rowKeyOf.set(N.rowKeyOf); made.set(N.made);
        const pairs = _navNext.copyPairs || (_navNext.copyPairs = []);
        pairs.push(pool, N.pool);
        if (N.rows.length <= rows.length) pairs.push(rows, N.rows);
    }
    N = _navNext.pools[w] = { cap: F.cap, span: F.span, pool, rows, rowW, rowKeyOf, made, rowSrc: N ? N.rowSrc : new Map() };
    simParallelBind('nav.npool.' + w, pool); simParallelBind('nav.nrows.' + w, rows);
    _navFieldsHeader();
    return N;
}
// (Tests: the install's side forced, 1 the next arrays installed, -1 the
// rebuilt profile's fields copied; 0 the smaller copy.)
let NAV_INSTALL_SIDE = 0;
// (Slots made only at an install, for want of a batch: diagnostics.)
let _navNextMissed = 0, _navNextKept = 0;
// Closes it: the next build and its fields installed together.
function _navNextInstall(nav) {
    _navFieldsLaneWait();
    simParallelBackgroundWait(SIM_LANE_NAVX);
    // (Closed meanwhile: installed as any build.)
    if (_navNext.nav !== nav) { navPublish(nav); return; }
    const prof = nav.profile;
    for (let w = 0; w < 2; w++) {
        const F = _navFields.pools[w], N = _navNext.pools[w];
        if (!F.pool || !N || N.cap !== F.cap) continue;
        // Every live slot of the rebuilt profile written over this build
        // first: the pool is not cleared, and a slot no batch was given read
        // what the memory held before (on each peer what its collector had
        // freed there: desyncs). The other profiles' slots hold fields over
        // the builds they keep: as they are. A slot let go but still made (the
        // movement kernel takes a new generation of a made slot with its
        // destination as the field made again, and goes on reading it) keeps
        // what it held.
        // (One pass: the rebuilt profile's live slots (all made over the next
        // build once the missed ones are), the missed ones, and how many
        // other slots hold a field (live, or let go but made). Three passes
        // over 65k slots were ~7 ms of an install.)
        const size = F.span * F.span, meta = F.meta, made = N.made, M = NAV_FIELD_META;
        const mineList = new Int32Array(F.cap), missed = [];
        let mine = 0, others = 0;
        for (let s = 0, m = 0; s < F.cap; s++, m += M) {
            const v = meta[m];
            if (v === prof) { mineList[mine++] = s; if (!made[s]) missed.push(s); }
            else if (v >= 0 || meta[m + 7] === 1) others++;
        }
        if (missed.length) { _navNextMissed += missed.length; _navFieldsRunNow(_navFieldsBatch(F, Int32Array.from(missed), true, 1, false)); }
        // (Rows as wide: the smaller side copied, a field's ~8-32 KB each:
        // the rebuilt profile's ~10k fields into the installed arrays were
        // 10-19 ms. Fewer of the other profiles' fields: those go into the
        // next arrays, as for wider rows below, and the installed arrays
        // are kept for the next window.)
        if (N.rowW === F.rowW && (NAV_INSTALL_SIDE < 0 || (NAV_INSTALL_SIDE === 0 && mine <= others))) {
            // (Rows as wide: the rebuilt profile's fields copied into the
            // installed arrays, in runs of slots. N.made holds every slot
            // written over the next build: the window's, the missed ones,
            // and fields asked for meanwhile, the other profiles' among them,
            // the same over the same builds.)
            const rw = F.rowW;
            for (let i = 0; i < mine;) {
                const s = mineList[i];
                let j = i + 1;
                while (j < mine && mineList[j] === s + (j - i)) j++;
                const e = s + (j - i);
                F.pool.set(N.pool.subarray(s * size, e * size), s * size);
                F.rows.set(N.rows.subarray(s * rw, e * rw), s * rw);
                i = j;
            }
            continue;
        }
        // (Rows wider, or fewer other fields: the next arrays installed,
        // every other slot that holds a field (live, or let go but made)
        // copied over, its row widened when wider.)
        const old = N.rowW === F.rowW ? { cap: F.cap, span: F.span, rowW: F.rowW, pool: F.pool, rows: F.rows } : null;
        for (let s = 0; s < F.cap; s++) {
            const m = s * NAV_FIELD_META;
            if (N.made[s] && F.meta[m] === prof) continue;
            if (!(F.meta[m] >= 0 || F.meta[m + 7] === 1)) continue;
            N.pool.set(F.pool.subarray(s * size, (s + 1) * size), s * size);
            const rw = Math.min(F.rowW, N.rowW);
            N.rows.set(F.rows.subarray(s * F.rowW, s * F.rowW + rw), s * N.rowW);
            if (rw < N.rowW) N.rows.fill(0, s * N.rowW + rw, (s + 1) * N.rowW);
            _navNextKept++;
        }
        F.pool = N.pool; F.rows = N.rows; F.rowW = N.rowW; F.rowSrc = N.rowSrc; F.rowKeyOf = N.rowKeyOf;
        simParallelBind('nav.fpool.' + w, F.pool); simParallelBind('nav.frows.' + w, F.rows);
        // (Its arrays are the installed ones now; the old ones, as wide,
        // kept for the next window instead.)
        _navNext.pools[w] = null;
        if (old) _navNext.spare[w] = old;
    }
    _navNextRelease();
    _navNext.nav = null;
    navPublish(nav, true);
}
// The next window's pools, when no spares fit the fields' pools as they
// are now: the heap told to grow ahead for them (sim_wasm.js
// simHeapExpect), so the first window's opening does not grow the memory
// on this thread (~230 MB: two 10-13 ms allocations).
function _navNextExpect() {
    if (typeof simHeapExpect !== 'function') return;
    let bytes = 0;
    for (const F of _navFields.pools) {
        if (!F.pool) continue;
        const sp = _navNext.spare[F.wide ? 1 : 0];
        if (sp && sp.cap === F.cap && sp.span === F.span) continue;
        bytes += F.cap * F.span * F.span * 2 + F.cap * Math.max(1, F.rowW);
    }
    if (bytes) simHeapExpect('navNext', bytes); else simHeapExpectDone('navNext');
}
// The window over: its pools' arrays kept for the next window (the lanes
// that wrote them waited for), the slots' contents left as they are (a
// slot is read only once made over the build it belongs to).
function _navNextRelease() {
    for (let w = 0; w < 2; w++) {
        const N = _navNext.pools[w];
        if (N && N.pool) _navNext.spare[w] = { cap: N.cap, span: N.span, rowW: N.rowW, pool: N.pool, rows: N.rows };
    }
    _navNext.pools = [null, null];
}
// (Dropped: its batches finished, its arrays let go.)
// The grown next pools' copies (_navNextPoolEnsure) as one stage on
// SIM_LANE_NAVX.
function _navNextCopyFlush() {
    const pairs = _navNext.copyPairs;
    if (!pairs || !pairs.length) return;
    _navNext.copyPairs = null;
    const stage = typeof simParallelCopyStage === 'function' ? simParallelCopyStage(pairs, simParallelStageParams(SIM_LANE_NAVX, 0), 1) : null;
    if (stage) { simParallelBackgroundChain(SIM_LANE_NAVX, [stage]); _navNext.copying = true; }
    else for (let i = 0; i < pairs.length; i += 2) pairs[i].set(pairs[i + 1]);
}
function _navNextDrop() {
    _navFieldsLaneWait();
    if (typeof SIM_LANE_NAVX === 'number') simParallelBackgroundWait(SIM_LANE_NAVX);
    _navNextRelease();
    _navNext.nav = null; _navNext.copyPairs = null; _navNext.copying = false;
    _navFieldsHeader();
    _navSweep();
}

// The current build of a profile, made now when there is none (the map's
// first) or the map size changed.
function navEnsure(profile) {
    let nav = _nav[profile];
    if (nav && nav.W === GRID_W && nav.H === GRID_H) return nav;
    const wall = navWallTable(profile);
    nav = _navShareBuild(profile, wall) || navBuild(profile, wall, profile !== NAV_PROFILE_AIR, GRID_W, GRID_H);
    navPublish(nav);
    return nav;
}
// Installed geometry is immutable. Collectors without mines and builders
// of players without structures often have exactly the ground's walls;
// keep one set of local fields, graph, components and atlas for them.
// Each profile still owns its wrapper, sequence, version and destination
// fields, and rebuilds independently when its live walls change.
function _navShareBuild(profile, wall) {
    const costs = profile !== NAV_PROFILE_AIR, seen = new Set();
    for (const b of _nav) {
        if (!b || b.W !== GRID_W || b.H !== GRID_H || !!b.cost !== costs || seen.has(b.wall)) continue;
        seen.add(b.wall);
        let different = typeof simParallelDiffCount === 'function' ? simParallelDiffCount(b.wall, wall) : null;
        if (different === null) {
            different = b.wall.length !== wall.length ? 1 : 0;
            for (let i = 0; !different && i < wall.length; i++) if (b.wall[i] !== wall[i]) different = 1;
        }
        if (!different) return { ...b, profile };
    }
    return null;
}
function navReset() {
    // (A build's background stage, the fields' jobs: finished, dropped.)
    if (typeof simParallelBackgroundWait === 'function') { simParallelBackgroundWait(); if (typeof SIM_LANE_NAV === 'number') simParallelBackgroundWait(SIM_LANE_NAV); }
    _navFieldsJob.slots = null;
    _navGrow[0] = _navGrow[1] = null;
    if (_navNext.nav) _navNextDrop();
    for (const F of _navFields.pools) {
        if (F.meta) for (const s of F.byKey.values()) { F.meta[s * NAV_FIELD_META] = -1; F.meta[s * NAV_FIELD_META + 6]++; F.free.push(s); }
        F.rowSrc = new Map();
        F.byKey = new Map(); F.pending = []; F.remake = null;
    }
    _navFields.flushedTick = -1;
    _nav = new Array(NAV_PROFILES).fill(null);
    _navSeq = new Array(NAV_PROFILES).fill(0);
    _navJob = null; _navDiff.fill(0); _navLastJobProfile = -1;
    _navSweep();
    // (The class walls made again from the grid as it is now: a restore.)
    _navClassWall.fill(null); _navClassGrid = null;
    _navSubReset();
    // (Build versions start again: the movement kernel's shared looks go.)
    if (typeof simMoveLookCacheClear === 'function') simMoveLookCacheClear();
}

// The next tile from `t` toward `dest` (profile), -1 when there is no way
// (or `t` is `dest`, or its field is not made: the rows are the field's).
// `destId`: its destination field (navFieldRequest).
function navStep(profile, t, dest, destId) {
    const nav = _nav[profile];
    if (!nav || t === dest || !(destId >= 0)) return -1;
    if (destId === NAV_ATLAS_FID) {
        if (nav.partL[t] === 0xFFFF) return _simWallStepOut(nav.partL, nav.partBase, null, 0, nav.W, nav.C, nav.cw, t, t % nav.W, (t - t % nav.W) / nav.W);
        return navAtlasStep(nav, t, dest);
    }
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
    return navPathSubstitutePrepared(u, profile, to, comp, pt);
}
// Same ordered request/retry commit with a component prepared by helpers.
// Navigation geometry is immutable throughout the unit-event phase.
function navPathSubstitutePrepared(u, profile, to, comp, pt) {
    if (comp < 0) return [];
    if (!(pt.sub > 0) || gameTime < pt.sub) return pt.sub > 0 ? null : _navSubAsk(u, profile, to, comp, pt);
    const r = _navSub.map.get(_navSubKey(profile, to, comp));
    if (r === undefined || r === -2) return _navSubAsk(u, profile, to, comp, pt);
    if (r < 0) return [];
    return [navNode(profile, r % GRID_W, (r - r % GRID_W) / GRID_W)];
}
function _navSubAsk(u, profile, to, comp, pt) {
    navSubstituteRequest(profile, to, comp);
    pt.sub = gameTime + NAV_SUB_TICKS; u._astarBudgetRetryTick = pt.sub;
    return null;
}
// The substitutes asked for (at the flush; one job each).
function _navSubstitutesMake() {
    const req = _navSub.req;
    if (!req.length) return;
    _navSub.req = [];
    const n = req.length / 3, list = simHeapArrayAuto(Int32Array, req.length), out = simHeapArrayAuto(Int32Array, n);
    list.set(req);
    simParallelBind('nav.sreq', list); simParallelBind('nav.sout', out);
    const P = _simParams;
    P[0] = n; P[1] = 1;
    simParallelRun(SIM_KERNEL_NAV_SUBST, n);
    for (let i = 0; i < n; i++) _navSub.map.set(_navSubKey(list[i * 3], list[i * 3 + 1], list[i * 3 + 2]), out[i]);
}
const SIM_KERNEL_NAV_SUBST = 17;
const _navSubstW = [];
SIM_KERNELS[SIM_KERNEL_NAV_SUBST] = function (R, P, chunk) {
    const req = R['nav.sreq'];
    for (let i = chunk * P[1], end = Math.min(P[0], i + P[1]); i < end; i++) {
        const p = req[i * 3] | 0, pre = 'nav.' + p + '.';
        const K = _navSubstW[p] || (_navSubstW[p] = _simWK(['nav.sreq', 'nav.sout', '?' + pre + 'meta', '?' + pre + 'partL', '?' + pre + 'partB', '?' + pre + 'pclu', '?' + pre + 'cstart', '?' + pre + 'cparts']));
        _simRust(K, P, i, 'k_nav_subst', 'NAV_SUBST');
    }
};
// (k.rs k_nav_subst: component K's tile nearest tile `to` of profile p's
// build, the lowest tile of those as near; -1 none.)
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
function navProfileOf(u) {
    if (!u) return NAV_PROFILE_GROUND;
    if (u.isFlying) return NAV_PROFILE_AIR;
    const wt = u.workerType;
    if (!wt) return NAV_PROFILE_GROUND;
    if (wt === 'builder' || wt === 'salvager') { const o = u.owner; return o >= 0 && o < NAV_BUILD_PLAYERS ? NAV_PROFILE_BUILD0 + o : NAV_PROFILE_GROUND; }
    return typeof isResourceCollectorWorkerType === 'function' && isResourceCollectorWorkerType(wt) ? NAV_PROFILE_COLLECT : NAV_PROFILE_GROUND;
}
// Up to maxLen tiles from (gx, gy) toward dest (the start first), as path
// nodes; null when the navigation has no way from there. For the interface:
// it changes nothing (a destination field it would ask for, or a build,
// would exist on the peer that shows the unit only): an existing field of
// the destination when there is one, else the coarse steps.
function navPath(profile, gx, gy, dest, maxLen) {
    const nav = _nav[profile];
    if (!nav || !(dest >= 0 && dest < nav.W * nav.H)) return null;
    const W = GRID_W, F = _navFields.pools[1], s = F && F.byKey ? F.byKey.get(_navFieldKey(profile, dest)) : undefined;
    const did = NAV_ATLAS && nav.atlas && nav.atlas.header ? NAV_ATLAS_FID : s === undefined ? -1 : NAV_WIDE_BASE + s;
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
    const id = navFieldRequest(profile, ty * GRID_W + tx);
    return { x: tx, y: ty, nav: profile + 1, ready: navFieldReadyFor(id) };
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
    const ver = (typeof _simMoveWallVer === 'number' ? _simMoveWallVer : 0) * NAV_PROFILES + profile;
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
// (The atlas's cluster tables: this many ticks into the window, its blocks
// done by then.)
const NAV_ATLAS_TABLES_STEP = 10;
let _navJob = null;
// Per profile: tiles whose walls differ from those of its newest build (the
// one being made, else the installed one). (The air's never change.)
// (In the wasm heap once it is up: the tile changes' kernel keeps them, see navTileTables.)
let _navDiff = new Int32Array(NAV_PROFILES);
// The profile the last job built (the next is looked for after it).
let _navLastJobProfile = -1;
function _navNewestWalls(p) { return _navJob && _navJob.profile === p && _navJob.b ? _navJob.b.wall : (_nav[p] ? _nav[p].wall : null); }
function _navWallDiffReset(p = NAV_PROFILE_GROUND) {
    _navDiff[p] = 0;
    if (p === NAV_PROFILE_AIR) return;
    const w = _navNewestWalls(p), live = p === NAV_PROFILE_GROUND ? (typeof _simMoveWall !== 'undefined' ? _simMoveWall : null) : _navClassWalls(p);
    if (!w || !live || live.length !== w.length) return;
    // (In the kernels when both are heap arrays: ~2.6 ms here at 1M tiles.)
    let d = typeof simParallelDiffCount === 'function' ? simParallelDiffCount(w, live) : null;
    if (d === null) { d = 0; for (let i = 0; i < w.length; i++) if (w[i] !== live[i]) d++; }
    _navDiff[p] = d;
}
// For the tile changes' kernel (unit.js simTileChangesRun, wasm/src/tch.rs):
// the diff counts (heap), per profile its newest build's walls (tabN) and
// its class walls (tabC) as encoded addresses, 0 none. Arrays outside the
// heap are listed (made whole after the batch: navTileTablesRedo).
const _navTileRedo = { count: [], cls: [] };
function navTileTables(tabN, tabC) {
    if (!simHeapHas(_navDiff)) { const a = simSharedArray(Int32Array, NAV_PROFILES); a.set(_navDiff); _navDiff = a; }
    const R = _navTileRedo, ground = typeof _simMoveWall !== 'undefined' ? _simMoveWall : null, classOk = _navClassGrid === grid && !!ground;
    R.count.length = 0; R.cls.length = 0;
    for (let p = 0; p < NAV_PROFILES; p++) {
        const w = p === NAV_PROFILE_AIR ? null : _navNewestWalls(p);
        tabN[p] = 0;
        if (w) { if (simHeapHas(w)) tabN[p] = _simWEnc(_simHeapPtrOf(w)); else R.count.push(p); }
        tabC[p] = 0;
        const c = p >= NAV_PROFILE_COLLECT && classOk ? _navClassWall[p] : null;
        if (c && c.length === ground.length) { if (simHeapHas(c)) tabC[p] = _simWEnc(_simHeapPtrOf(c)); else R.cls.push(p); }
    }
    return _navDiff;
}
// After the batch: class walls outside the heap made again from the world
// (true: the ground's wall versions must move on), counts outside recounted.
function navTileTablesRedo() {
    const R = _navTileRedo;
    for (const p of R.cls) { _navClassWall[p] = null; _navWallDiffReset(p); }
    for (const p of R.count) _navWallDiffReset(p);
    return R.cls.length > 0;
}
function navTick() {
    _navFreeTick();
    // (The map's first builds at its first tick, not at the first order:
    // on a big map that build takes long.)
    // (Every profile in use, not only the ground's: the worker kernel sets ways on
    // them without asking for their builds, wai.rs path_to.)
    { let made = false; for (const p of _navProfilesInUse()) if (!_nav[p]) { navEnsure(p); made = true; } if (made) return; }
    if (!_navJob) {
        // The next profile whose walls changed, round the profiles from the
        // last one built: none waits long behind another's changes.
        let p = -1;
        for (let k = 1; k <= NAV_PROFILES && p < 0; k++) {
            const q = (_navLastJobProfile + k + NAV_PROFILES) % NAV_PROFILES;
            if (q !== NAV_PROFILE_AIR && _nav[q] && _navDiff[q] > 0) p = q;
        }
        if (p < 0) return;
        _navLastJobProfile = p;
        _navJob = { profile: p, start: gameTime, step: 0, b: null, dests: null, destNew: null };
    }
    const J = _navJob, off = gameTime - J.start;
    while (J.step <= off && _navJob === J) _navJobStep(J, J.step++);
    _navRushCheck();
}
// The window's second half with its fields not made: the helpers take them
// first, more of them at once (simParallelBulkRush), so the install does not
// make the rest on this thread. Scheduling only: the same fields.
const NAV_RUSH_TICKS = Math.floor(NAV_SWAP_TICKS / 2);
let _navRush = false;
function _navRushCheck() {
    const J = _navJob;
    const rush = !!J && !!J.next && gameTime - J.start >= NAV_STEP_INSTALL - NAV_RUSH_TICKS && typeof simParallelBackgroundPending === 'function' && simParallelBackgroundPending(SIM_LANE_NAVX);
    if (rush === _navRush) return;
    _navRush = rush;
    if (typeof simParallelBulkRush === 'function') simParallelBulkRush(rush ? SIM_LANE_NAVX : -1);
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
        const wall = navWallTable(J.profile);
        J.shared = _navShareBuild(J.profile, wall);
        J.b = J.shared || navBuildStart(J.profile, wall, J.profile !== NAV_PROFILE_AIR, GRID_W, GRID_H);
        _navWallDiffReset(J.profile);
    } else if (step === NAV_STEP_NODES) {
        if (!J.shared) navBuildNodesBackground(J.b);
    } else if (step === NAV_STEP_LOCAL) {
        if (!J.shared) { navBuildCollect(); navBuildNodesFinish(J.b); navBuildLocalBackground(J.b); }
    } else if (step === NAV_STEP_GRAPH) {
        if (!J.shared) { navBuildCollect(); navBuildGraphAlloc(J.b); navBuildGraphBackground(J.b); }
    } else if (step === NAV_STEP_STAGE) {
        if (!J.shared) { navBuildCollect(); navBuildGraphFinish(J.b); navBuildPartsFinish(J.b); }
        // (Its atlas on the build's lane meanwhile: installed with it.)
        J.next = J.shared || navBuildFinish(J.b, false);
        J.atl = J.shared ? null : navAtlasStart(J.b, true);
        _navNextStage(J.next);
    } else if (step === NAV_STEP_STAGE + NAV_ATLAS_TABLES_STEP && J.atl) {
        navBuildCollect();
        navAtlasTables(J.atl, true);
    } else if (step === NAV_STEP_INSTALL) {
        _navJob = null;
        if (J.atl) { navBuildCollect(); J.next.atlas = navAtlasFinish(J.atl); J.atl = null; }
        _navNextInstall(J.next);
    }
}
// Snapshots: the walls of every installed build (but the air's: its walls
// never change) and of one being made, as their differences from the
// profile's live walls, and when that one started; the profile the last job
// built (the next job's choice). (Older snapshots: the ground's alone.)
function navSnapshotState() {
    const nav = _nav[NAV_PROFILE_GROUND];
    if (!nav) return null;
    const diff = (w, live) => { const out = []; for (let i = 0; i < w.length; i++) if (w[i] !== live[i]) out.push(i, w[i]); return out; };
    const profiles = [];
    for (let p = 0; p < NAV_PROFILES; p++) {
        const b = _nav[p];
        if (!b || p === NAV_PROFILE_AIR) continue;
        const live = navWallTable(p);
        if (!live || live.length !== b.wall.length) return null;
        profiles.push({ p, built: diff(b.wall, live), seq: b.seq | 0 });
    }
    const J = _navJob && _navJob.b ? _navJob : null, g = profiles[0];
    return { built: g.built, seq: g.seq, profiles, last: _navLastJobProfile,
        job: J ? { profile: J.profile, start: J.start, step: J.step, walls: diff(J.b.wall, navWallTable(J.profile)) } : null };
}
// After a restore (the live walls restored): the same builds again.
function navRestoreState(st) {
    navReset();
    if (!st || !Array.isArray(st.built)) return;
    const walls = (live, d) => { const w = new Uint8Array(live.length); w.set(live); if (Array.isArray(d)) for (let i = 0; i + 1 < d.length; i += 2) if (d[i] >= 0 && d[i] < w.length) w[d[i]] = d[i + 1] ? 1 : 0; return w; };
    const list = Array.isArray(st.profiles) ? st.profiles : [{ p: NAV_PROFILE_GROUND, built: st.built, seq: st.seq }];
    for (const e of list) {
        const p = e.p | 0;
        if (p === NAV_PROFILE_AIR || p < 0 || p >= NAV_PROFILES) continue;
        const wall = walls(navWallTable(p), e.built);
        navPublish(_navShareBuild(p, wall) || navBuild(p, wall, true, GRID_W, GRID_H));
        if (e.seq > 0) _nav[p].seq = _navSeq[p] = e.seq | 0;
    }
    // (The air one too, as the match's first tick made it: flyers' fields
    // need it now.)
    navEnsure(NAV_PROFILE_AIR);
    _navLastJobProfile = Number.isFinite(st.last) ? st.last | 0 : -1;
    if (st.job && Number.isFinite(st.job.start)) {
        // Its stages up to now run at once (the same result as spread out).
        const p = Number.isFinite(st.job.profile) ? st.job.profile | 0 : NAV_PROFILE_GROUND;
        const J = _navJob = { profile: p, start: st.job.start, step: 0, b: null, dests: null, destNew: null };
        if (st.job.walls) {
            // (Steps below `step` ran on the snapshot's peer.)
            const upTo = Math.min(Number(st.job.step) || 1, NAV_STEP_INSTALL);
            const wall = walls(navWallTable(p), st.job.walls);
            J.shared = _navShareBuild(p, wall);
            J.b = J.shared || navBuildStart(p, wall, p !== NAV_PROFILE_AIR, GRID_W, GRID_H);
            J.step = 1;
            for (; J.step < upTo; J.step++) _navJobStep(J, J.step);
        }
    }
    for (let p = 0; p < NAV_PROFILES; p++) if (_nav[p] && p !== NAV_PROFILE_AIR) _navWallDiffReset(p);
}
