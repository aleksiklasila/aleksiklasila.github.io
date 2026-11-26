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
//  - the routing atlas (wasm/src/atlas.rs): any destination by lookups over
//    a hierarchy of the parts, no search and no per-destination data. Every
//    route is on it (navRouteFid); a map with no open tile has no atlas and
//    no route (no way, as for an unreachable destination).
// A step: atlas lookups and a local field read (navStep, and the same in
// SIM_KERNEL_MOVE). Steps cost more next to walls (stepCostTable), so units
// keep to the middle of corridors.
// A destination a unit cannot reach (another component, or walls all around
// it): it goes to the closest tile it can reach, worked out by the helpers
// (navPathSubstitute). Nothing on the simulation thread searches: a unit's
// way is O(1) there, whatever the map.
// The data is built by navBuild; it only changes when navPublish installs a
// new build (on every peer at the same tick), so it may be computed ahead,
// off the simulation thread.

const NAV_UNREACHED = 0xFFFF;
const NAV_PROFILE_GROUND = 0, NAV_PROFILE_AIR = 1;
// The builders' walk class (navProfileOf): builders and salvagers of every
// player walk over every player's structure (_navClassWalls: their work is
// at those, in the middle of a base too): the ground's walls less the
// structures' (mines are neutral and stay walls). One navigation for all of them. Collectors
// fly (data_static.js isFlying): the air's.
const NAV_PROFILE_BUILD = 2, NAV_PROFILES = 3;

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
// The sixteen stages run as one helper chain. Rust sizes and fills the
// intermediate arrays in a fixed arena; JavaScript posts it and installs
// views of the completed header at deterministic simulation steps.
const NAV_NODES_PER_JOB = 16, NAV_GRAPH_PER_JOB = 256, NAV_LOCAL_PER_JOB = 32, NAV_COST_ROWS = 32;
// (A build keeps the installed build's fields of clusters that did not change: navBuildChain; false: every field made, an A/B switch.)
let NAV_FIELD_REUSE = true;
function navBuild(profile, wall, costs, W, H) {
    try { return _navBuildAll(profile, wall, costs, W, H, true); }
    catch (e) {
        if (e !== _NAV_SLOT_FULL) throw e;
        _navSlotFullNote(profile);
        return _navBuildAll(profile, wall, costs, W, H, false);
    }
    finally { _navSlots.cur = null; }
}
function _navBuildAll(profile, wall, costs, W, H, slot) {
    let capacity = 0;
    for (;;) {
        const b = navBuildStart(profile, wall, !!costs, W, H, slot, capacity);
        navBuildChain(b, false);
        if (!b.hdr[NAVH.FULL]) return navBuildFinish(b);
        if (b.slot) throw _NAV_SLOT_FULL;
        capacity = b.arena.length * 2;
        _navOwned.delete(b.arena); simHeapFreeAuto(b.arena);
        if (capacity > 0x7fffffff) throw _NAV_SLOT_FULL;
    }
}
// (A build too big for its slot: logged once.)
function _navSlotFullNote(profile) {
    _navSlots.dropped++;
    if (!_navSlots.warned) { _navSlots.warned = true; console.warn('[nav] a build of profile ' + profile + ' needs more than its slot (' + (_navSlots.slots && _navSlots.slots[profile] ? _navSlots.slots[profile][0].a.length : 0) + ' bytes): dropped'); }
}
// Every unreserved build arena (setup/tests) is
// navigation's (_navOwned): given back once no build in use reaches it
// (_navSweep: the installed builds, the next one, the job's), NAV_FREE_TICKS
// later. They waited for the JS collector before, which on a quiet JS heap
// rarely came: every rebuild stayed in the wasm heap (+20-40 MB each at
// 1000x1000, 4 to 9 builds over 4500 ticks of a battle).
const _navOwned = new Set(), _navFreeQ = [];
const NAV_FREE_TICKS = 40, NAV_SWEEP_TICKS = 32;
let _navFreeClock = 0;
// ---- Build memory: fixed slots (navReserve) ----
// Every array of a build and its atlas comes from a slot: one heap block,
// made at the match's start (main.js simMatchReserve: navReserve) at the
// most its profile's builds may take, never grown: the wasm32 heap's 4 GiB
// is shared out at the start. Two slots a profile that rebuilds (the
// installed build's and the next one's); one for the air's (its walls never
// change). A build takes the slot no build of its profile in use holds
// (the previous build lane is collected before reuse). A
// build that would need more than its slot is dropped (the installed one
// kept, the same on every peer: _navJobStep); its profile is built again
// once its walls change further. Without slots (no reserve: tests, the
// page) builds take heap arrays as before.
// Sizes: the ground's NAV_GROUND_BYTES_PER_TILE a tile (~2.4x the 1M-unit
// chaos scene's ground build); the builders' their build at the start's
// (terrain alone) with room for every mine run dry; the air's exact.
const NAV_GROUND_BYTES_PER_TILE = 96;
const _NAV_SLOT_FULL = { navSlotFull: true };
const _navSlots = { slots: null, cur: null, W: -1, H: -1, lastInstall: -1e9, capped: [-1, -1, -1], dropped: 0, warned: false };
// The bytes a build (with its atlas) may take on a W x H map with k exit
// nodes and np parts: every array placed by navg.rs, each
// rounded up to 64 bytes.
function _navBuildBytes(W, H, k, np) {
    const T = W * H, C = Math.max(W, H) > 512 ? 32 : 16, cw = Math.ceil(W / C), ch = Math.ceil(H / C), nc = cw * ch, NM = 2 * C, CC = C * C;
    k = Math.min(Math.max(1, k), nc * NM); np = Math.min(Math.max(1, np), T);
    let L = 0;
    for (let span = 1; L < 16;) { span *= 4; L++; if (Math.ceil(cw / span) <= 1 && Math.ceil(ch / span) <= 1) break; }
    const total = np * L, bw = Math.ceil(W / 8), bh = Math.ceil(H / 8), nb = bw * bh, pool = k * L * 16, nj = np * L;
    const r = n => Math.ceil(Math.max(1, n) / 64) * 64 + 64;
    // Header and the hierarchy's temporary arrays (released between stages).
    return NAV_BUILD_HEADER_BYTES + r(np * (36 + 10 * L)) + r(68) + 3 * r(T) + r(2 * T) + r(4 * nc) + r(4 * nc * NM) + r(16 * nc)
        + r(4 * (nc + 1)) + 3 * r(4 * k) + r(2 * k * CC)
        + r(4 * (nc + 1)) + 2 * r(4 * np) + r(4 * k) + r(4 * (np + 1)) + r(4 * np)
        + r(4 * (k + 1)) + 2 * r(4 * k * NM) + r(4 * Math.ceil(k / 8))
        + r(8 * nb) + r(T) + r(2 * nb) + r(4 * nc) + 2 * r(8 * np) + r(4 * np) + r(2 * np) + r(4 * np * L) + r(2 * total) + r(4 * total) + r(4 * (total + 1))
        + 2 * r(4 * k * L) + r(4 * total) + r(4 * pool) + r(12 * nj) + r(4 * (nc + 1)) + r(4 * nc * NM * 4) + r(4 * (bw + 1) * (bh + 1)) + r(96);
}
// The air's build: no walls, so its nodes and parts follow from the map.
function _navAirBytes(W, H) { const C = Math.max(W, H) > 512 ? 32 : 16, nc = Math.ceil(W / C) * Math.ceil(H / C); return _navBuildBytes(W, H, 8 * nc, nc); }
// The ground's slot: its share of the budget a tile, at most its largest build.
function _navGroundBytes(W, H) { const C = Math.max(W, H) > 512 ? 32 : 16, nc = Math.ceil(W / C) * Math.ceil(H / C); return Math.min(NAV_GROUND_BYTES_PER_TILE * W * H, _navBuildBytes(W, H, nc * 2 * C, Math.ceil(W * H / 2) + nc)); }
// The slots for this map (main.js simMatchReserve). The builders' build is
// made once here to size theirs (its walls: terrain alone, and mines while
// they have some left; each mine run dry adds at most 2 exit nodes and 3
// parts).
function navReserve() {
    if (typeof simHeapHas !== 'function' || typeof GRID_W !== 'number' || !(GRID_W > 0)) return;
    const S = _navSlots, W = GRID_W, H = GRID_H;
    if (S.slots && S.W === W && S.H === H && S.slots.every(L => L.every(e => simHeapHas(e.a)))) return;
    const prev = _navSlots.cur; S.cur = null;
    let builder = _navGroundBytes(W, H);
    try {
        const b = navBuild(NAV_PROFILE_BUILD, navWallTable(NAV_PROFILE_BUILD), true, W, H);
        // (A mine walled again adds exit nodes only on a cluster's border row
        // or column (2 at most), parts anywhere (3 at most).)
        let mines = 0, edge = 0;
        for (const list of [typeof goldMines !== 'undefined' ? goldMines : null, typeof astarMines !== 'undefined' ? astarMines : null]) if (list) for (const m of list) {
            if (!m) continue;
            mines++;
            const x = m.gx % b.C, y = m.gy % b.C;
            if (x === 0 || y === 0 || x === b.C - 1 || y === b.C - 1) edge++;
        }
        builder = Math.ceil(_navBuildBytes(W, H, b.k + 2 * edge, b.np + 3 * mines) * 1.1);
        // (The measuring build's arrays given back.)
        for (const k in b) { const a = b[k]; if (a && ArrayBuffer.isView(a) && _navOwned.has(a)) { _navOwned.delete(a); if (typeof simHeapFreeAuto === 'function') simHeapFreeAuto(a); } }
        if (b.atlas) for (const k in b.atlas) { const a = b.atlas[k]; if (a && ArrayBuffer.isView(a) && _navOwned.has(a)) { _navOwned.delete(a); if (typeof simHeapFreeAuto === 'function') simHeapFreeAuto(a); } }
    } catch (e) { if (e !== _NAV_SLOT_FULL) throw e; }
    const sizes = [];
    sizes[NAV_PROFILE_GROUND] = [_navGroundBytes(W, H), _navGroundBytes(W, H)];
    sizes[NAV_PROFILE_AIR] = [_navAirBytes(W, H)];
    sizes[NAV_PROFILE_BUILD] = [builder, builder];
    S.slots = sizes.map((L, p) => L.map((bytes, s) => ({ p, s, a: simSharedArray(Uint8Array, bytes), off: 0 })));
    S.W = W; S.H = H; S.cur = prev;
}
// The slots' bytes in all (the memory budget: data_static.js).
function navReserveBytes() { let n = 0; if (_navSlots.slots) for (const L of _navSlots.slots) for (const e of L) n += e.a.length; return n; }
// The slot a new build of the profile takes (null: none, heap arrays).
function _navSlotTake(profile) {
    const S = _navSlots;
    if (!S.slots || S.W !== GRID_W || S.H !== GRID_H || !S.slots[profile]) return null;
    const held = new Set();
    for (const b of _nav) if (b && b.slot) held.add(b.slot);
    if (_navJob) { if (_navJob.b && _navJob.b.slot) held.add(_navJob.b.slot); if (_navJob.next && _navJob.next.slot) held.add(_navJob.next.slot); }
    for (const e of S.slots[profile]) if (!held.has(e) && simHeapHas(e.a)) { e.off = 0; return e; }
    return null;
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
// One arena and one header for the whole build. Offsets/counts match navg.rs.
const NAVH = { K:0, NP:1, E:2, TOTAL:3, L:4, POOL:5, NJ:6, NCOMP:7, TOP:8, CAP:9, FULL:10, B:11, TEMP:12,
    WALL:16, COST:17, H:18, PARTL:19, PARTN:20, NS:21, NSC:22, NODEBASE:23, NODETILE:24, NODEPAIR:25, FIELDS:26,
    ADJN:27, ADJS:28, ADJA:29, ADJC:30, ADJMAX:31, PARTB:32, PCLU:33, NPART:34, PCOMP:35, CSTART:36, CPARTS:37,
    BM:38, BC:39, CB:40, CN:41, PSX:42, PSY:43, PSN:44, CIP:45, ANC:46, CIN:47, DN:48, DNO:49, DIDX:50,
    DNODES:51, RCO:52, RC:53, JOBS:54, CO:55, CT:56, CLEAR:57, ATLH:58 };
// Two immutable binding records per profile (installed/next). Sharing a
// build must not overwrite another profile's version. Reserved once with
// the arena, eliminating the last small allocation at every bind/install.
const NAV_BUILD_HEADER_BYTES = 256 + NAV_PROFILES * 128;
const SIM_KERNEL_NAV_CHAIN = 135, NAV_PARTS_PER_JOB = 16, NAV_ATLAS_CLUSTERS_PER_JOB = 8;
// (The route id of every route: on its profile's atlas, navRouteFid. wasm/src/mv.rs NAV_ATLAS_FID.)
const NAV_ATLAS_FID = 1 << 30;
function _navBuildLane() { return typeof SIM_LANE_LONG === 'number' ? SIM_LANE_LONG : 1; }
function navBuildCollect() { simParallelBackgroundWait(_navBuildLane()); }

function navBuildStart(profile, wallLive, withCosts, W, H, useSlot = true, capacity = 0) {
    // Slots can be read by other lanes until they finish using the old build.
    simParallelBackgroundWait();
    navBuildCollect();
    const slot = useSlot ? _navSlotTake(profile) : null;
    const C = Math.max(W, H) > 512 ? 32 : 16, cw = Math.ceil(W / C), ch = Math.ceil(H / C), nc = cw * ch, NM = 2 * C;
    // Unreserved builds are setup/tests only. On overflow navBuild retries
    // with a larger arena; gameplay uses only the reserved fixed slot.
    const arena = slot ? slot.a : simHeapArrayAuto(Uint8Array, capacity || Math.max(65536, _navAirBytes(W, H) * 2), false);
    if (!slot) _navOwned.add(arena);
    const hdr = simHeapView(arena, Int32Array, 0, 64);
    hdr.fill(0); hdr[NAVH.TOP] = NAV_BUILD_HEADER_BYTES; hdr[NAVH.CAP] = hdr[NAVH.TEMP] = arena.length;
    const put = (word, Type, n) => {
        const off = hdr[NAVH.TOP], bytes = Math.max(1, n) * Type.BYTES_PER_ELEMENT;
        if (off + bytes > arena.length) { hdr[NAVH.FULL] = 1; throw _NAV_SLOT_FULL; }
        hdr[word] = off; hdr[NAVH.TOP] = Math.ceil((off + bytes) / 64) * 64;
        return simHeapView(arena, Type, off, Math.max(1, n));
    };
    // These arrays are completely overwritten by their stages. Only the
    // snapshot is copied here: live walls may change before a helper runs.
    const wall = put(NAVH.WALL, Uint8Array, W * H);
    wall.set(wallLive.length === W * H ? wallLive : wallLive.subarray(0, W * H));
    if (withCosts) { put(NAVH.COST, Uint8Array, W * H); put(NAVH.H, Uint8Array, W * H); }
    put(NAVH.PARTL, Uint16Array, W * H); put(NAVH.PARTN, Int32Array, nc);
    put(NAVH.NS, Int32Array, nc * NM); put(NAVH.NSC, Int32Array, nc * 4);
    return { profile, C, cw, ch, nc, W, H, NM, arena, hdr, slot, wall, withCosts };
}

// All stages use the arena address carried in their immutable parameters,
// so another profile's foreground build cannot change their bindings.
// Dynamic stages split their actual native jobs across 128 tasks; this
// avoids posting millions of no-op jobs at a worst-case arena bound.
const _navChainArrays = [
    [16,18,17], [16,18,17], [16,21,22], null, null,
    [26,24,23,25,17,27,28,29,30,31], null,
    [26,24,23,25,17,27,28,29,30,31], [16,19,20], null,
    [16,19,32,38,39,40,41,42,43,44], null,
    [28,29,30,34,46,45,47,50,51,49,48,52,53,54], null,
    [38,39,40,41,55,56], null
];
const _navChainGlue = {3:1, 6:2, 9:3, 11:4, 13:5, 15:6};
let _navChainHdr = null, _navChainAddr = -1;
function _navRust(offsets, h, base) {
    const I = _simWasmArgI;
    for (let i = 0; i < offsets.length; i++) { const off = h[offsets[i]]; I[SIM_RUST_W0 + i] = off ? _simWEnc(base + off) : 0; }
}
SIM_KERNELS[SIM_KERNEL_NAV_CHAIN] = function (R, P, chunk) {
    const base = P[21], stage = P[20] | 0;
    if (!_navChainHdr || _navChainAddr !== base || _navChainHdr.buffer !== _simWasmMem.buffer) {
        _navChainAddr = base; _navChainHdr = new Int32Array(_simWasmMem.buffer, base, 64);
    }
    const h = _navChainHdr;
    if (h[NAVH.FULL]) return;
    if (stage >= 10 && (!P[23] || !h[NAVH.NP])) return;
    const I = _simWasmArgI, F = _simWasmArgF, X = _simWasmX, glue = _navChainGlue[stage];
    F.set(P);
    I[1000] = _simWEnc(_simWasmScratch); I[1001] = _simWasmScratchWords; I[1002] = _simThreadSlot;
    if (glue) {
        I[SIM_RUST_W0] = I[SIM_RUST_W0 + 1] = _simWEnc(base);
        F[0] = glue; F[1] = P[3]; F[2] = P[4]; F[3] = P[5]; F[4] = P[6]; F[5] = P[24];
        F[6] = P[7]; F[7] = P[11]; F[8] = P[23]; F[9] = NAV_GRAPH_PER_JOB;
        X.k_navg(_simWasmArgsW, 0); return;
    }
    const count = h[NAVH.K];
    F[8] = count; F[9] = h[NAVH.B]; F[10] = h[NAVH.E];
    if (stage === 4) {
        const W = P[3], H = P[4], C = P[5], cw = P[6], CC = C * C;
        const nt = new Int32Array(_simWasmMem.buffer, base + h[NAVH.NODETILE], Math.max(1, count));
        const jobs = Math.ceil(count / NAV_LOCAL_PER_JOB), groups = P[22];
        const start = Math.floor(chunk * jobs / groups) * NAV_LOCAL_PER_JOB, end = Math.min(count, Math.floor((chunk + 1) * jobs / groups) * NAV_LOCAL_PER_JOB);
        // (The installed build's, P[25]: a cluster the same in both keeps its
        // nodes' fields, copied: navBuildChain, wasm nav_cluster_same.)
        const prev = P[25] === 1 && typeof X.nav_cluster_same === 'function';
        const nb = prev ? new Int32Array(_simWasmMem.buffer, base + h[NAVH.NODEBASE], P[7] + 1) : null, onb = prev ? new Int32Array(_simWasmMem.buffer, P[28], P[7] + 1) : null;
        const mem = prev ? new Uint8Array(_simWasmMem.buffer) : null, nf = base + h[NAVH.FIELDS], of = P[30];
        let lastC = -1, same = 0;
        for (let i = start; i < end; i++) {
            const t = nt[i], c = _navClusterOf(t, W, C, cw), cx = c % cw, cy = (c - cx) / cw;
            if (prev) {
                if (c !== lastC) {
                    lastC = c;
                    same = X.nav_cluster_same(_simWEnc(base + h[NAVH.WALL]), _simWEnc(P[26]), h[NAVH.COST] ? _simWEnc(base + h[NAVH.COST]) : 0, P[27] ? _simWEnc(P[27]) : 0,
                        _simWEnc(base + h[NAVH.NODEBASE]), _simWEnc(base + h[NAVH.NODETILE]), _simWEnc(P[28]), _simWEnc(P[29]), c, W, H, C, cx * C, cy * C);
                }
                if (same) { const j = onb[c] + (i - nb[c]); mem.copyWithin(nf + i * CC * 2, of + j * CC * 2, of + (j + 1) * CC * 2); continue; }
            }
            X.nav_field(_simWEnc(base + h[NAVH.FIELDS]), i * CC, CC, cx * C, cy * C, C, C, W, H, t,
                _simWEnc(base + h[NAVH.WALL]), h[NAVH.COST] ? _simWEnc(base + h[NAVH.COST]) : 0,
                _simWEnc(_simWasmScratch), _simWasmScratchWords);
        }
        return;
    }
    _navRust(_navChainArrays[stage], h, base);
    if (stage < 2) { F[0] = stage; F[2] = NAV_COST_ROWS; X.k_nav_cost(_simWasmArgsW, chunk); }
    else if (stage === 2) { F[2] = NAV_NODES_PER_JOB; X.k_nav_nodes(_simWasmArgsW, chunk); }
    else if (stage === 5 || stage === 7) {
        F[0] = 0; F[1] = count; F[2] = NAV_GRAPH_PER_JOB; F[12] = stage === 7 ? 1 : 0;
        const jobs = Math.ceil(count / NAV_GRAPH_PER_JOB), groups = P[22];
        for (let j = Math.floor(chunk * jobs / groups), end = Math.floor((chunk + 1) * jobs / groups); j < end; j++) X.k_nav_graph(_simWasmArgsW, j);
    } else if (stage === 8) { F[2] = NAV_PARTS_PER_JOB; X.k_nav_parts(_simWasmArgsW, chunk); }
    else if (stage === 12) {
        const jobs = h[NAVH.NJ], groups = P[22]; F[0] = jobs; F[1] = h[NAVH.L];
        for (let j = Math.floor(chunk * jobs / groups), end = Math.floor((chunk + 1) * jobs / groups); j < end; j++) X.k_atl_route(_simWasmArgsW, j);
    } else {
        F[0] = P[7]; F[1] = NAV_ATLAS_CLUSTERS_PER_JOB; F[2] = P[3]; F[3] = P[4]; F[4] = P[5]; F[5] = P[6]; F[6] = Math.ceil(P[3] / 8);
        X[stage === 10 ? 'k_atl_blocks' : 'k_atl_tables'](_simWasmArgsW, chunk);
    }
};
// Whether a view is on the simulation's heap still: the current memory's buffer, or (shared
// memory) an earlier SharedArrayBuffer of it: a grow makes a new buffer object, the views made
// before stay good (same memory). Requiring the current buffer turned the installed build's
// field reuse off for the rest of a match after the first grow: every build made every node's
// field again (~9k a build at a 1024 map, ~48 ms of helper time a step at chaos-1m-250k).
function _navOnHeap(a) {
    if (!a || !a.byteLength || !_simWasmMem) return false;
    const B = _simWasmMem.buffer;
    return a.buffer === B || (typeof SharedArrayBuffer === 'function' && B instanceof SharedArrayBuffer && a.buffer instanceof SharedArrayBuffer && a.byteOffset + a.byteLength <= B.byteLength);
}
function navBuildChain(b, background = true) {
    const lane = _navBuildLane(), groups = Math.min(128, Math.max(1, b.nc));
    // (The installed build of the profile, the same grid and clusters, its
    // arrays in the wasm heap: its unchanged clusters' fields are kept. It
    // stays installed until this build is.)
    const q = _nav[b.profile], prev = NAV_FIELD_REUSE && background && q && q !== b && q.W === b.W && q.H === b.H && q.C === b.C && q.nc === b.nc && !!q.cost === !!b.withCosts
        && _navOnHeap(q.wall) && _navOnHeap(q.nodeBase) && _navOnHeap(q.nodeTile) && _navOnHeap(q.fields) ? q : null;
    const rows = b.withCosts ? Math.ceil(b.H / NAV_COST_ROWS) : 0, blocks = Math.ceil(b.nc / NAV_ATLAS_CLUSTERS_PER_JOB);
    const counts = [rows, rows, Math.ceil(b.nc / NAV_NODES_PER_JOB), 1, groups, groups, 1, groups,
        Math.ceil(b.nc / NAV_PARTS_PER_JOB), 1, blocks, 1, groups, 1, blocks, 1];
    const stages = [];
    for (let stage = 0; stage < counts.length; stage++) {
        const P = background ? simParallelStageParams(lane, stage) : _simParams;
        P.fill(0); P[3] = b.W; P[4] = b.H; P[5] = b.C; P[6] = b.cw; P[7] = b.nc; P[11] = b.NM;
        P[20] = stage; P[21] = _simHeapPtrOf(b.arena); P[22] = groups; P[23] = 1; P[24] = b.ch;
        if (stage === 4 && prev) { P[25] = 1; P[26] = prev.wall.byteOffset; P[27] = prev.cost ? prev.cost.byteOffset : 0; P[28] = prev.nodeBase.byteOffset; P[29] = prev.nodeTile.byteOffset; P[30] = prev.fields.byteOffset; }
        if (background) stages.push([SIM_KERNEL_NAV_CHAIN, counts[stage]]);
        else if (counts[stage]) simParallelRun(SIM_KERNEL_NAV_CHAIN, counts[stage]);
    }
    if (background) simParallelBackgroundChain(lane, stages);
}
function navBuildFinish(b) {
    const h = b.hdr;
    if (h[NAVH.FULL]) throw _NAV_SLOT_FULL;
    const view = (o, T, n) => simHeapView(b.arena, T, h[o], Math.max(1, n));
    const {W,H,C,cw,ch,nc,profile,slot,arena} = b, k = h[NAVH.K], np = h[NAVH.NP], ncomp = h[NAVH.NCOMP];
    const nav = {profile,C,cs:31-Math.clz32(C),cw,ch,nc,W,H,k,slot,arena,wall:b.wall,
        cost:h[NAVH.COST] ? view(NAVH.COST,Uint8Array,W*H) : null,
        nodeBase:view(NAVH.NODEBASE,Int32Array,nc+1),nodeTile:view(NAVH.NODETILE,Int32Array,k),nodePair:view(NAVH.NODEPAIR,Int32Array,k),
        fields:view(NAVH.FIELDS,Uint16Array,k*C*C),adjStart:view(NAVH.ADJS,Int32Array,k+1),adjA:view(NAVH.ADJA,Int32Array,h[NAVH.E]),adjC:view(NAVH.ADJC,Int32Array,h[NAVH.E]),B:h[NAVH.B],
        partL:view(NAVH.PARTL,Uint16Array,W*H),partBase:view(NAVH.PARTB,Int32Array,nc+1),np,nodePart:view(NAVH.NPART,Int32Array,k),
        partComp:view(NAVH.PCOMP,Int32Array,np),partCluster:view(NAVH.PCLU,Int32Array,np),ncomp,compStart:view(NAVH.CSTART,Int32Array,ncomp+1),compParts:view(NAVH.CPARTS,Int32Array,np),atlas:null};
    // (No parts (every tile a wall): no atlas, no route.)
    if (np > 0) {
        const L=h[NAVH.L],total=h[NAVH.TOTAL],bw=Math.ceil(W/8),bh=Math.ceil(H/8),nb=bw*bh;
        const co=view(NAVH.CO,Int32Array,nc+1);
        nav.atlas={slot,L,C,cw,bw,np,W,H,nc,bm:view(NAVH.BM,Uint32Array,nb*2),bc:view(NAVH.BC,Uint8Array,W*H),cb:view(NAVH.CB,Uint16Array,nb),
            cn:view(NAVH.CN,Int32Array,nc),co,ct:view(NAVH.CT,Uint32Array,co[nc]),anc:view(NAVH.ANC,Int32Array,np*L),cip:view(NAVH.CIP,Uint16Array,np),cin:view(NAVH.CIN,Uint16Array,total),
            rco:view(NAVH.RCO,Int32Array,total),rc:view(NAVH.RC,Uint32Array,h[NAVH.POOL]),dn:view(NAVH.DN,Int32Array,total),didx:view(NAVH.DIDX,Int32Array,k*L),
            nodes:total,poolEntries:h[NAVH.POOL],jobs:h[NAVH.NJ],nodePart:nav.nodePart,nodeBase:nav.nodeBase,
            clearPrefix:view(NAVH.CLEAR,Int32Array,(bw+1)*(bh+1)),header:view(NAVH.ATLH,Int32Array,24)};
    }
    if (slot) slot.off = h[NAVH.TOP];
    return nav;
}

const _navNoCost = new Uint8Array(0);
// The next tile from t toward dest on profile p's atlas (-1 none): the
// movement kernel's (atlas.rs nav_atlas_step).
function navAtlasStep(nav, t, dest) {
    const A = nav && nav.atlas;
    if (!A || !A.header || _simWasmX === null || !_simWasmX.nav_atlas_step) return -1;
    const c = _navAtlasPtrs(nav);
    return _simWasmX.nav_atlas_step(c.eh, c.epl, c.epb, c.ent, c.enp, c.ef, nav.W, t, dest);
}
// (The arrays' addresses worked out once while they stay the same arrays: past 2^30 a number is a heap
// allocation, six of them a call.)
function _navAtlasPtrs(nav) {
    const A = nav.atlas;
    let c = nav._asc;
    if (!c || c.h !== A.header || c.pl !== nav.partL || c.pb !== nav.partBase || c.nt !== nav.nodeTile || c.np !== nav.nodePair || c.f !== nav.fields) {
        const ptr = a => _simWEnc(_simHeapPtrOf(a));
        c = nav._asc = { h: A.header, pl: nav.partL, pb: nav.partBase, nt: nav.nodeTile, np: nav.nodePair, f: nav.fields,
            eh: ptr(A.header), epl: ptr(nav.partL), epb: ptr(nav.partBase), ent: ptr(nav.nodeTile), enp: ptr(nav.nodePair), ef: ptr(nav.fields) };
    }
    return c;
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

// ---- The installed builds (per profile) ----
let _nav = new Array(NAV_PROFILES).fill(null);
// The route id of a way toward tile `dest` (profile): NAV_ATLAS_FID, every
// route is on its profile's atlas (lookups, no destination field: ready at
// once); -1 without a build or off the map. (A build with no atlas, a map
// with no open tile: the same id, no step (navStep, the movement kernel's
// flow_key): no way.)
function navRouteFid(profile, dest) {
    const nav = _nav[profile];
    return nav && dest >= 0 && dest < nav.W * nav.H ? NAV_ATLAS_FID : -1;
}
// Every tick, after the orders, before anything moves: the substitutes
// asked for since the last flush (_navSubstitutesMake).
function navFieldsFlush() {
    if (typeof tickStartChainSettle === 'function') tickStartChainSettle();
    _navSubstitutesMake();
}
// After a restore: the substitutes the waiting units asked for, again.
function navFieldsRestore() { navSubstitutesRestore(); }
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
    // (Any player's structure; never a mine, it belongs to no player: tch.rs k_tile_changes, the same rule.)
    const e = typeof getTileEntityRef === 'function' ? getTileEntityRef(x, y) : null;
    if (!e) return false;
    // (Also a mine's record on a page that holds plain column views, not the class.)
    if ((typeof GoldMine !== 'undefined' && e instanceof GoldMine) || e._isGoldMine || (Number.isFinite(e.gold) && Number.isFinite(e.maxGold))) return false;
    if ((typeof AstarMine !== 'undefined' && e instanceof AstarMine) || e._isAstarMine || (Number.isFinite(e.astar) && Number.isFinite(e.maxAstar))) return false;
    return true;
}
function _navClassWalls(profile) {
    const ground = simMoveWallGrid();
    if (_navClassGrid !== grid) { _navClassWall.fill(null); _navClassGrid = grid; }
    let w = _navClassWall[profile];
    // (One made before the wasm heap was up (a plain array): made again in it, where the kernels read it.)
    if (w && w.length === ground.length && (typeof simHeapHas !== 'function' || simHeapHas(w))) return w;
    w = simHeapArrayAuto(Uint8Array, ground.length);
    w.set(ground);
    const W = GRID_W, H = GRID_H;
    const open = (gx, gy) => { if (gx >= 0 && gy >= 0 && gx < W && gy < H) { const t = gy * W + gx; if (w[t] && _navClassPass(profile, gx, gy)) w[t] = 0; } };
    for (const e of _activeTileEntities) if (e) open(e.gx, e.gy);
    for (const list of [goldMines, astarMines]) for (const m of list || []) if (m) open(m.gx, m.gy);
    _navClassWall[profile] = w;
    if (typeof simParallelBind === 'function') simParallelBind('mv.cwall.' + profile, w);
    return w;
}
// The ground walls were made whole again: the class walls too.
function navClassReset() {
    _navClassWall.fill(null);
    for (let p = NAV_PROFILE_BUILD; p < NAV_PROFILES; p++) if (_nav[p]) _navWallDiffReset(p);
}
// The profiles a match uses: ground, air, builders (made at its first
// tick, see navTick).
const _NAV_PROFILES_ALL = [0, 1, 2];
function _navProfilesInUse() { return _NAV_PROFILES_ALL; }

// Installs a build as the current one for its profile (every peer at the
// same tick).
// (_navVersion: this peer's count of installs, for caches; nav.seq: the
// profile's build number, the same on every peer: snapshotted, so waiting
// units can tell a new build, see _tryUpgradeAstarFallbackPath.)
let _navVersion = 0, _navSeq = new Array(NAV_PROFILES).fill(0);
// fromJob: the rebuild job's build (_navJobStep), whose walls have been the
// diff counter's reference since it was posted.
function navPublish(nav, fromJob = false) {
    simParallelBindBatch();
    try { _navPublishBody(nav, fromJob); } finally { simParallelBindFlush(); }
}
function _navPublishBody(nav, fromJob) {
    // (The flow looks' prewarm reads the builds: done first, tower.js tickStartChainSettle.)
    if (typeof tickStartChainSettle === 'function') tickStartChainSettle();
    _nav[nav.profile] = nav;
    _navVersion++;
    nav.seq = ++_navSeq[nav.profile];
    // (Its version, as the kernels read it from its meta: look-ahead keys.)
    nav.version = _navVersion;
    const p = nav.profile;
    _navBindBuild('nav.', nav);
    // (The build it replaced, and its job's own arrays: given back later.)
    _navSweep();
    // (Components changed: substitutes asked for again.)
    _navSubReset();
    // A completed rebuild has been the diff counter's reference since
    // it was posted; installing those same walls preserves the count.
    if (!fromJob && p !== NAV_PROFILE_AIR) _navWallDiffReset(p);
}
// A build's arrays for the kernels under names pre + profile + '.' + name
// ('nav.': the installed one).
function _navBindBuild(pre, nav) {
    const p = nav.profile;
    simParallelBind(pre + p + '.fields', nav.fields);
    // meta: [C, cw, ch, nc, W, H, version, parts, the graph's bucket count
    // (largest edge + 1), nodes, edges, components]
    const meta = simHeapView(nav.arena, Int32Array, 256 + p * 128, 12);
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
// (Off: every profile has its own slots (navReserve), so a shared build
// saves no memory, and the comparison of walls ran on this thread.)
let NAV_SHARE_BUILDS = false;
function _navShareBuild(profile, wall) {
    if (!NAV_SHARE_BUILDS) return null;
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
    // (A build's background stage: finished, dropped.)
    navBuildCollect();
    if (typeof simParallelBackgroundWait === 'function') simParallelBackgroundWait();
    _nav = new Array(NAV_PROFILES).fill(null);
    _navSeq = new Array(NAV_PROFILES).fill(0);
    _navJob = null; _navDiff.fill(0); _navLastJobProfile = -1;
    _navSlots.cur = null; _navSlots.lastInstall = -1e9; _navSlots.capped.fill(-1);
    _navSweep();
    // (The class walls made again from the grid as it is now: a restore.)
    _navClassWall.fill(null); _navClassGrid = null;
    _navSubReset();
    // (Build versions start again: the movement kernel's shared looks go.)
    if (typeof simMoveLookCacheClear === 'function') simMoveLookCacheClear();
}

// The next tile from `t` toward `dest` (profile) on its atlas, -1 when
// there is no way (or `t` is `dest`, or no build). Standing on a wall: its
// first open side (_simWallStepOut).
function navStep(profile, t, dest) {
    const nav = _nav[profile];
    if (!nav || t === dest) return -1;
    if (nav.partL[t] === 0xFFFF) return _simWallStepOut(nav.partL, nav.W, t, t % nav.W, (t - t % nav.W) / nav.W);
    return navAtlasStep(nav, t, dest);
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
    const n = _simWallStepOut(nav.partL, nav.W, t, t % nav.W, (t - t % nav.W) / nav.W);
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
function navPathReach(u, sx, sy, tx, ty, previous = null) {
    if (!(tx >= 0 && ty >= 0 && tx < GRID_W && ty < GRID_H)) return null;
    const profile = navProfileOf(u);
    navEnsure(profile);
    const to = navApproachTile(profile, ty * GRID_W + tx);
    if (to < 0) return null;
    const from = (sx >= 0 && sy >= 0 && sx < GRID_W && sy < GRID_H) ? sy * GRID_W + sx : Math.floor(u.y / TILE) * GRID_W + Math.floor(u.x / TILE);
    if (!navReachable(profile, from, to)) return null;
    const oldNode = previous?.length === 1 ? previous[0] : null;
    const gx = to % GRID_W;
    const node = navNode(profile, gx, (to - gx) / GRID_W, oldNode);
    return node === oldNode ? previous : [node];
}
// Substitutes: for a destination a unit cannot reach, the tile of its
// component nearest it (straight-line; ties: the lower tile), worked out
// by the helpers at the flush (SIM_KERNEL_NAV_SUBST) from a request. A unit
// asks once (its pending target's `sub`: the tick it may take the answer,
// NAV_SUB_TICKS later, whatever this peer has cached: the same tick on every
// peer, and a restore asks again for the waiting units). Cached per
// (profile, destination, component) until the next build.
const NAV_SUB_TICKS = 2;
// The answers: a table in the heap (tab; shared with pp.rs, which asks and
// reads them for the waiting units), entries of three words: (profile *
// 4194304 + component) + 1 (0 empty), destination tile, answer (-2 asked,
// -1 none, else the tile); open addressing, a power of two of them, at
// least two a unit. The requests since the last flush: list (n triples).
// used: entries taken since the table was last cleared; past a quarter of
// them the flush clears it and asks again for every waiting unit's (pp.rs
// mode 2), so what a unit finds there never depends on the table's history
// (a restored peer's has only those).
// asks: this tick's asks, found or not (counted alike on every peer: the room is theirs, not the table's; pp.rs
// sub_ask).
const _navSub = { tab: null, mask: 0, used: 0, n: 0, asks: 0, list: null, out: null, units: 0 };
// The substitutes' arrays for the match (main.js startGame): room for one
// request a unit (units: the population the budget holds), so none is made
// during play.
function navSubReserve(units) {
    // (The simulation's only: the page runs startGame too, without a heap.)
    if (typeof simHeapHas !== 'function' || typeof simParallelBind !== 'function') return;
    units = Math.max(1024, units | 0);
    if (_navSub.list && _navSub.units === units && simHeapHas(_navSub.list) && simHeapHas(_navSub.tab)) return;
    _navSub.units = units;
    _navSub.list = simHeapArrayAuto(Int32Array, units * 3); simParallelBind('nav.sreq', _navSub.list);
    _navSub.out = simHeapArrayAuto(Int32Array, units); simParallelBind('nav.sout', _navSub.out);
    const entries = 1 << Math.ceil(Math.log2(units * 2));
    _navSub.tab = simHeapArrayAuto(Int32Array, entries * 3); _navSub.mask = entries - 1;
    _navSubReset();
}
function _navSubReady() { if (!_navSub.tab || !simHeapHas(_navSub.tab) || !simHeapHas(_navSub.list)) navSubReserve(_navSub.units); return _navSub; }
function _navSubReset() { if (_navSub.tab) _navSub.tab.fill(0); _navSub.used = 0; _navSub.n = 0; _navSub.asks = 0; }
// (A tick's asks: the list's room, one a unit of the budget's population. Refused past it alike on every peer:
// the room once also counted the table's entries, which differ between peers (a restored one's holds only the
// waiting units'), and peers refused different asks. The table never fills: at most a quarter full at a tick's
// start (the flush clears it past that), the room's new entries a half more: it has two entries a unit.)
function navSubRoom() { return _navSub.list.length / 3; }
// The entry of a key (pp.rs sub_find): its word index, or -1 - the empty one's.
function _navSubFind(k1, to) {
    const T = _navSub.tab, mask = _navSub.mask;
    let h = ((Math.imul(k1, 0x9E3779B1) ^ Math.imul(to, 0x85EBCA77)) + (to >>> 7)) & mask;
    for (;;) {
        const e = h * 3, kw = T[e];
        if (kw === 0) return -1 - e;
        if (kw === k1 + 1 && T[e + 1] === to) return e;
        h = (h + 1) & mask;
    }
}
function navSubstituteRequest(profile, to, comp) {
    const N = _navSubReady();
    if (++N.asks > navSubRoom()) return false;
    const k1 = profile * 4194304 + comp, e = _navSubFind(k1, to);
    if (e >= 0) return true;
    const T = N.tab, f = -1 - e;
    T[f] = k1 + 1; T[f + 1] = to; T[f + 2] = -2; N.used++;
    const L = N.list, r = N.n * 3;
    L[r] = profile; L[r + 1] = to; L[r + 2] = comp; N.n++;
    return true;
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
    const e = _navSubReady() && _navSubFind(profile * 4194304 + comp, to), r = e >= 0 ? _navSub.tab[e + 2] : -2;
    if (r === -2) return _navSubAsk(u, profile, to, comp, pt);
    if (r < 0) return [];
    return [navNode(profile, r % GRID_W, (r - r % GRID_W) / GRID_W)];
}
function _navSubAsk(u, profile, to, comp, pt) {
    // (Refused (the tick's room): asked again next tick, nothing read meanwhile, as pp.rs sub_asked.)
    if (!navSubstituteRequest(profile, to, comp)) { pt.sub = 0; u._astarBudgetRetryTick = gameTime + 1; return null; }
    pt.sub = gameTime + NAV_SUB_TICKS; u._astarBudgetRetryTick = pt.sub;
    return null;
}
// The substitutes asked for (at the flush; one job each).
// (The arrays navSubReserve made at the match's start, bound once; one
// request a unit at most. New ones bound each flush made the helpers sit out
// this job and the next ones.)
function _navSubstitutesMake() {
    const N = _navSub;
    if (!N.tab) return;
    // (A quarter full: cleared, and every waiting unit's asked again, at once.)
    if (N.used > (N.mask + 1) >> 2) { _navSubReset(); pendingPathSubAskAll(); }
    const n = N.n;
    N.asks = 0;
    if (!n) return;
    N.n = 0;
    const P = _simParams;
    P[0] = n; P[1] = 1;
    simParallelRun(SIM_KERNEL_NAV_SUBST, n);
    // (The answers into the table: pp.rs k_nav_sub_store.)
    _navSubStoreP[0] = n; _navSubStoreP[1] = N.mask + 1;
    simRustDirect('k_nav_sub_store', [N.list, N.out, N.tab], _navSubStoreP);
}
const _navSubStoreP = new Float64Array(2);
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
// (The waiting units' requests by pp.rs k_pp_due mode 2.)
function navSubstitutesRestore() {
    if (typeof simHeapHas !== 'function' || typeof _simWasmX === 'undefined' || _simWasmX === null) return;
    _navSubReady();
    _navSubReset();
    pendingPathSubAskAll();
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
    if (wt === 'builder' || wt === 'salvager') return NAV_PROFILE_BUILD;
    return NAV_PROFILE_GROUND;
}
// Up to maxLen tiles from (gx, gy) toward dest (the start first), as path
// nodes; null when the navigation has no way from there. For the interface:
// it changes nothing (the atlas' steps). The open stretches in one wasm call
// each (atlas.rs nav_atlas_path, the look-ahead's run of steps), a wall's
// step out here.
let _navPathOut = null;
function navPath(profile, gx, gy, dest, maxLen) {
    const nav = _nav[profile];
    if (!nav || !(dest >= 0 && dest < nav.W * nav.H)) return null;
    const W = GRID_W, A = nav.atlas;
    let t = gy * W + gx;
    const path = [{ x: gx, y: gy }];
    while (t !== dest && path.length < maxLen) {
        if (nav.partL[t] === 0xFFFF || !A || !A.header) {
            const n = navStep(profile, t, dest);
            if (n < 0) return path.length > 1 ? path : null;
            path.push({ x: n % W, y: (n - n % W) / W });
            t = n;
            continue;
        }
        const want = maxLen - path.length;
        if (!_navPathOut || _navPathOut.length < want || !simHeapHas(_navPathOut)) _navPathOut = simHeapArray(Int32Array, Math.max(256, want));
        const c = _navAtlasPtrs(nav), O = _navPathOut;
        const k = _simWasmX.nav_atlas_path(c.eh, c.epl, c.epb, c.ent, c.enp, c.ef, nav.W, t, dest, want, _simWEnc(_simHeapPtrOf(O)));
        for (let i = 0; i < k; i++) { const n = O[i]; path.push({ x: n % W, y: (n - n % W) / W }); }
        if (!k) return path.length > 1 ? path : null;
        t = O[k - 1];
        // (Stopped short of dest and of maxLen on an open tile: no way on.)
        if (k < want && t !== dest && nav.partL[t] !== 0xFFFF) break;
    }
    return path;
}

// A path node that means "on to tile (x, y) by the navigation": a unit
// steps toward it one tile at a time (Unit.followPath, or the movement
// kernel in flow mode), O(1) a tick. `ready`: the tick the route may start
// (on the atlas at once: 0; a path block's word, sim_unit_state.js simPathStore).
function navNode(profile, tx, ty, previous = null) {
    navEnsure(profile);
    // (An unchanged, narrow route: the same node.)
    if (previous && previous.x === tx && previous.y === ty && previous.nav === profile + 1 && !previous.ready && !previous.w) return previous;
    return { x: tx, y: ty, nav: profile + 1, ready: 0 };
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

// Walls changed: post an immutable snapshot, collect the complete helper
// chain at a fixed simulation step, then install it.
// Stage identifiers retain their old values for saved pre-chain snapshots;
// scheduling uses _NAV_STAGES and J.gap, not elapsed base ticks.
const NAV_STEP_STAGE = 8, NAV_STEP_INSTALL = 12;
// (The tick a build was last installed by the job (gameTime), -1 none.)
let navInstalledAt = -1;
const NAV_BUILD_TICKS = 13; // Conservative step limit used by diagnostics.
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
        const c = p >= NAV_PROFILE_BUILD && classOk ? _navClassWall[p] : null;
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
        // last one built: none waits long behind another's changes. (Not one
        // whose last build was too big for its slot until its walls change.)
        let p = -1;
        for (let k = 1; k <= NAV_PROFILES && p < 0; k++) {
            const q = (_navLastJobProfile + k + NAV_PROFILES) % NAV_PROFILES;
            if (q !== NAV_PROFILE_AIR && _nav[q] && _navDiff[q] > 0 && _navSlots.capped[q] !== _navDiff[q]) p = q;
        }
        if (p < 0) return;
        _navLastJobProfile = p;
        _navJob = { profile: p, start: gameTime, step: 0, b: null, dests: null, destNew: null, si: 0, calls: 0, nextAt: 0, gap: _navStageGap() };
    }
    const J = _navJob;
    try { _navJobAdvance(J); }
    catch (e) {
        if (e !== _NAV_SLOT_FULL) throw e;
        // (Too big for its slot: dropped, the installed build kept.)
        _navSlotFullNote(J.profile);
        if (typeof simParallelBackgroundWait === 'function') simParallelBackgroundWait(_navBuildLane());
        _navSlots.capped[J.profile] = _navDiff[J.profile];
        _navSlots.lastInstall = gameTime;
        _navJob = null;
    }
    finally { _navSlots.cur = null; }
}
// Post the whole chain, collect it, then install. Completion time never
// chooses the step: a slow peer waits for the same data at the same
// scheduled step. At coarse steps this is two steps from post to install; at
// dk < 3 it is three. The complete build gets two short steps, then one
// step before its install (the schedule a snapshot's job carries).
const _NAV_STAGES = [0, NAV_STEP_STAGE, NAV_STEP_INSTALL];
// (The build's background work by the map's size, in ticks: NAV_BUILD_TILES_A_TICK
// tiles a tick (a 1024x1024 map: 8 ticks); as steps, at least 1 step apart at
// steps of 3+ ticks, else 2. The map and the step size are every peer's: the
// same schedule; a build that waited for its helpers stalled the tick.)
const NAV_BUILD_TILES_A_TICK = 131072;
function _navStageGap() {
    const dk = typeof simDk === 'number' && simDk >= 1 ? simDk : 1, ticks = Math.ceil(GRID_W * GRID_H / NAV_BUILD_TILES_A_TICK);
    return Math.max(dk >= 3 ? 1 : 2, Math.ceil(ticks / dk));
}
function _navJobAdvance(J) {
    J.calls++;
    if (J.calls < J.nextAt || J.si >= _NAV_STAGES.length) return;
    const s = _NAV_STAGES[J.si++];
    J.step = s + 1;
    J.nextAt = J.calls + (s === NAV_STEP_STAGE ? 1 : J.gap);
    _navJobStep(J, s);
}
function _navJobStep(J, step) {
    if (step === 0) {
        const wall = navWallTable(J.profile);
        J.shared = _navShareBuild(J.profile, wall);
        J.b = J.shared || navBuildStart(J.profile, wall, J.profile !== NAV_PROFILE_AIR, GRID_W, GRID_H);
        if (!J.shared) navBuildChain(J.b);
        // The snapshot is exactly the live walls at this step.
        _navDiff[J.profile] = 0;
    } else if (step === NAV_STEP_STAGE) {
        if (!J.shared) navBuildCollect();
        J.next = J.shared || navBuildFinish(J.b);
    } else if (step === NAV_STEP_INSTALL) {
        _navJob = null;
        _navSlots.lastInstall = gameTime;
        navPublish(J.next, true);
        // (The flow looks of its profile listed this tick: main.js, unit.js flowLooksInstallPost.)
        navInstalledAt = gameTime;
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
    return { built: g.built, seq: g.seq, profiles, last: _navLastJobProfile, inst: _navSlots.lastInstall, capped: _navSlots.capped.slice(),
        job: J ? { chain: 1, profile: J.profile, start: J.start, step: J.step, si: J.si, calls: J.calls, nextAt: J.nextAt, gap: J.gap, walls: diff(J.b.wall, navWallTable(J.profile)) } : null };
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
    // (The air one too, as the match's first tick made it: flyers' routes
    // need it now.)
    navEnsure(NAV_PROFILE_AIR);
    _navLastJobProfile = Number.isFinite(st.last) ? st.last | 0 : -1;
    _navSlots.lastInstall = Number.isFinite(st.inst) ? st.inst : -1e9;
    if (Array.isArray(st.capped)) for (let p = 0; p < NAV_PROFILES; p++) _navSlots.capped[p] = Number.isFinite(st.capped[p]) ? st.capped[p] : -1;
    if (st.job && Number.isFinite(st.job.start)) {
        // Its stages up to now run at once (the same result as spread out).
        const p = Number.isFinite(st.job.profile) ? st.job.profile | 0 : NAV_PROFILE_GROUND;
        const J = _navJob = { profile: p, start: st.job.start, step: 0, b: null, dests: null, destNew: null, si: 1, calls: 0, nextAt: 0, gap: _navStageGap() };
        if (st.job.walls) {
            // (Steps below `step` ran on the snapshot's peer.)
            const upTo = Math.min(Number(st.job.step) || 1, NAV_STEP_INSTALL);
            const wall = walls(navWallTable(p), st.job.walls);
            // (As on the snapshot's peer: a build too big for its slot dropped there too.)
            try {
                J.shared = _navShareBuild(p, wall);
                J.b = J.shared || navBuildStart(p, wall, p !== NAV_PROFILE_AIR, GRID_W, GRID_H);
                if (!J.shared) navBuildChain(J.b);
                if (st.job.chain === 1 && Number.isFinite(st.job.si)) {
                    // (By stages: those the snapshot's peer ran, at once.)
                    J.si = 1; J.gap = st.job.gap | 0 || 2;
                    for (; J.si < st.job.si; J.si++) _navJobStep(J, _NAV_STAGES[J.si]);
                    J.calls = st.job.calls | 0; J.nextAt = st.job.nextAt | 0; J.step = st.job.step | 0;
                } else {
                    // Migrate a saved pre-chain build to the corresponding
                    // geometry/window stage of the new schedule.
                    J.si = 1;
                    if (upTo > NAV_STEP_STAGE) { _navJobStep(J, NAV_STEP_STAGE); J.si = 2; }
                    J.step = _NAV_STAGES[J.si - 1] + 1;
                    J.calls = 0; J.nextAt = J.gap;
                }
            } catch (e) {
                if (e !== _NAV_SLOT_FULL) throw e;
                _navSlotFullNote(p);
                if (typeof simParallelBackgroundWait === 'function') simParallelBackgroundWait(_navBuildLane());
                _navSlots.capped[p] = -2;
                _navJob = null;
            } finally { _navSlots.cur = null; }
        }
    }
    for (let p = 0; p < NAV_PROFILES; p++) if (_nav[p] && p !== NAV_PROFILE_AIR) _navWallDiffReset(p);
}
