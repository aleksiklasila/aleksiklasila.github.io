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
    if (!_navDropList || !simHeapHas(_navDropList)) _navDropList = simSharedArray(Int32Array, Math.max(NAV_FIELDS_NARROW, NAV_FIELDS_WIDE));
    if (!_navDropHdr || !simHeapHas(_navDropHdr)) _navDropHdr = simSharedArray(Int32Array, 2);
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
    if (_navNext.nav && _navNext.nav.slot) held.add(_navNext.nav.slot);
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
let NAV_ATLAS = true;
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
    return { profile, C, cw, ch, nc, W, H, NM, arena, hdr, slot, wall, withCosts, withAtlas: NAV_ATLAS };
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
                0,0,0,0,0,0,0,0,0,0, 0,0,0,0, 1,0,0, 0,0, _simWEnc(_simWasmScratch), _simWasmScratchWords);
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
    const rows = b.withCosts ? Math.ceil(b.H / NAV_COST_ROWS) : 0, blocks = b.withAtlas ? Math.ceil(b.nc / NAV_ATLAS_CLUSTERS_PER_JOB) : 0;
    const counts = [rows, rows, Math.ceil(b.nc / NAV_NODES_PER_JOB), 1, groups, groups, 1, groups,
        Math.ceil(b.nc / NAV_PARTS_PER_JOB), 1, blocks, 1, b.withAtlas ? groups : 0, 1, blocks, 1];
    const stages = [];
    for (let stage = 0; stage < counts.length; stage++) {
        const P = background ? simParallelStageParams(lane, stage) : _simParams;
        P.fill(0); P[3] = b.W; P[4] = b.H; P[5] = b.C; P[6] = b.cw; P[7] = b.nc; P[11] = b.NM;
        P[20] = stage; P[21] = _simHeapPtrOf(b.arena); P[22] = groups; P[23] = b.withAtlas ? 1 : 0; P[24] = b.ch;
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
    if (b.withAtlas && np > 0) {
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
function _navNewPool(wide) { return { wide, span: 0, C: 0, cap: 0, pool: null, meta: null, rows: null, rowW: 0, ht: null, free: [], pending: [], seen: null, rowSrc: new Map(), rowKeyOf: null }; }
// A pool's fields by key (profile * 2^24 + dest): an open-addressing table in
// the heap (F.ht: key, slot + 1 pairs, 0 empty; linear probing; a power of
// two of pairs, at least twice the slots), the sweep's kernel's too
// (wasm/src/nfs.rs, the same hash). Live fields: meta[s * NAV_FIELD_META] >= 0.
function _navHtHash(key, mask) { return (Math.imul(key, 0x9E3779B1) >>> 0) & mask; }
function _navHtFit(F) {
    let n = 64;
    while (n < F.cap * 2) n *= 2;
    if (F.ht && F.ht.length === n * 2 && simHeapHas(F.ht)) return;
    const old = F.ht;
    F.ht = simSharedArray(Int32Array, n * 2); F.ht.fill(0);
    if (old) { for (let i = 0; i < old.length; i += 2) if (old[i + 1]) _navHtPut(F, old[i], old[i + 1] - 1); simHeapFree(old); }
}
// (A pool's live fields.)
function navFieldsLive(F) { let n = 0; if (F.meta) for (let s = 0; s < F.cap; s++) if (F.meta[s * NAV_FIELD_META] >= 0) n++; return n; }
function _navHtSlot(F, key) {
    const T = F.ht;
    if (!T) return -1;
    const mask = (T.length >> 1) - 1;
    for (let h = _navHtHash(key, mask); ; h = (h + 1) & mask) { const v = T[2 * h + 1]; if (v === 0) return -1; if (T[2 * h] === key) return v - 1; }
}
function _navHtPut(F, key, s) {
    const T = F.ht, mask = (T.length >> 1) - 1;
    let h = _navHtHash(key, mask);
    while (T[2 * h + 1] !== 0) h = (h + 1) & mask;
    T[2 * h] = key; T[2 * h + 1] = s + 1;
}
const _navFields = { pools: [_navNewPool(false), _navNewPool(true)], seenCycle: 0, flushedTick: -1, hdr: null };
// A rebuild's window (one simulation step, _navJobStep): the next build
// made but not installed; every live field made over it in the background
// (SIM_LANE_NAVX) into second arrays (per pool: pool, rows, row keys and
// sources, the same slots), the fields asked for meanwhile over both builds
// (their jobs' second batches); at the window's end both installed at once
// (_navNextInstall), the same tick on every peer: no tick makes them all.
// The atlas is already complete when the window opens. Routes use it
// directly; the remaining destination fields are prepared on SIM_LANE_NAVX.
const _navNext = { nav: null, empty: false, rowW: 0, pools: [null, null], stages: null, spare: [null, null] };
function _navFieldKey(profile, dest) { return profile * 16777216 + dest; }
function _navPoolEnsure(F, C) {
    if (F.C === C && F.pool) return F;
    // (The fields' job finished; its slots of this pool dropped: new ones.)
    _navFieldsLaneWait();
    const J = _navFieldsJob.slots;
    if (J) { const keep = []; for (let i = 0; i < J.length; i += 3) if (J[i] !== F) keep.push(J[i], J[i + 1], J[i + 2]); _navFieldsJob.slots = keep.length ? keep : null; }
    F.C = C; F.span = F.wide ? 3 * C : C; F.cap = 0; F.pool = null; F.meta = null; F.rows = null; if (F.ht) simHeapFree(F.ht); F.ht = null; F.free = []; F.pending = []; F.seen = null; F.remake = null;
    F.rowSrc = new Map(); F.rowKeyOf = null;
    _navFieldsGrow(F, F.wide ? NAV_FIELDS_WIDE : NAV_FIELDS_NARROW);
    return F;
}
// The pools' slots, fixed (made once, never grown: the wasm32 heap's 4 GiB
// is shared out at the match's start). Routes use the atlas (every
// destination by lookups, no field): fields are its fallback; a request
// with every slot in use gets none (-1: no way this tick, asked again).
const NAV_FIELDS_NARROW = 4096, NAV_FIELDS_WIDE = 256, NAV_FIELDS_FIXED = true;
function _navFieldsGrow(F, cap) {
    // (A growth on its way (_navGrowPlan): finished first, then grown no more
    // if that gave room.)
    if (_navGrow[F.wide ? 1 : 0]) { _navGrowSwap(); if (F.cap >= cap || F.free.length) return; }
    // (The fields' job finished first: its slots copied whole; taken at the
    // next flush as always.)
    _navFieldsLaneWait();
    const size = F.span * F.span, pool = simHeapArrayAuto(Uint16Array, cap * size), meta = simSharedArray(Int32Array, cap * NAV_FIELD_META), seen = simSharedArray(Int32Array, cap);
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
    _navHtFit(F);
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
    F.used = true;
    // The first fallback request can arrive after an atlas-only window
    // opened. Materialize its field staging before accepting that request.
    if (_navNext.empty) { const next = _navNext.nav; _navNext.empty = false; _navNextStage(next); }
    let s = _navHtSlot(F, key);
    if (s < 0) {
        if (!F.free.length) return -1;
        s = F.free.pop();
        const { C, cw, W, H } = nav, c = _navClusterOf(dest, W, C, cw), cx = c % cw, cy = (c - cx) / cw, m = s * NAV_FIELD_META;
        const bx = wide ? Math.max(0, (cx - 1) * C) : cx * C, by = wide ? Math.max(0, (cy - 1) * C) : cy * C;
        const ex = Math.min(W, (cx + (wide ? 2 : 1)) * C), ey = Math.min(H, (cy + (wide ? 2 : 1)) * C);
        F.meta[m] = profile; F.meta[m + 1] = dest; F.meta[m + 2] = bx; F.meta[m + 3] = by; F.meta[m + 4] = ex - bx; F.meta[m + 5] = ey - by;
        F.meta[m + 6]++; F.meta[m + 7] = 0;
        _navHtPut(F, key, s);
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
    if (typeof tickStartChainSettle === 'function') tickStartChainSettle();
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
    return !J;
}
function _navGrowPlan(lane) {
    // (The pools are fixed: NAV_FIELDS_NARROW / NAV_FIELDS_WIDE.)
    if (NAV_FIELDS_FIXED || typeof simParallelCopyStage !== 'function' || !_navGrowAllowed()) return null;
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
        const meta = simSharedArray(Int32Array, G.cap * NAV_FIELD_META), seen = simSharedArray(Int32Array, G.cap), rowKeyOf = new Float64Array(G.cap).fill(-1);
        meta.set(F.meta); seen.set(F.seen); rowKeyOf.set(F.rowKeyOf);
        for (let s = G.cap - 1; s >= F.cap; s--) { F.free.push(s); meta[s * NAV_FIELD_META] = -1; }
        F.pool = G.pool; F.rows = G.rows; F.meta = meta; F.seen = seen; F.rowKeyOf = rowKeyOf; F.cap = G.cap;
        _navHtFit(F);
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
    const F = _navFields.pools[wide ? 1 : 0], s = _navHtSlot(F, _navFieldKey(profile, dest));
    if (s >= 0) F.seen[s] = mark;
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
    // (From the slots' columns, by the units list's order through the slot
    // map (by slot, which fields a cycle drops would depend on each peer's
    // slot layout): wasm/src/nfs.rs k_nav_sweep_mark.)
    const S = typeof _simUnitState !== 'undefined' ? _simUnitState : null;
    const slots = S && typeof _unitSlotMapEnsure === 'function' ? _unitSlotMapEnsure() : null;
    const Fn = _navFields.pools[0], Fw = _navFields.pools[1];
    if (!S || !slots || !Fn.ht || !Fw.ht) return;
    const C = S.columns, P = _navSweepP;
    P[0] = k; P[1] = step; P[2] = count; P[3] = units.length; P[4] = mark; P[5] = Fn.ht.length >> 1; P[6] = Fw.ht.length >> 1;
    // (Its runs split over the helpers from 64k units: the marks are one value whichever thread writes them.)
    const A = [slots, C.live, C.dead, C.rtEnd, C.rkF, C.nvProf, C.nvPK, Fn.ht, Fn.seen, Fw.ht, Fw.seen];
    const jobs = units.length >= 65536 && typeof simRustParallel === 'function' && typeof _simPool !== 'undefined' && _simPool ? 16 : 1;
    P[7] = jobs;
    if (jobs > 1) simRustParallel(SIM_BLOCK_NAV_SWEEP, A, P, jobs); else simRustDirect('k_nav_sweep_mark', A, P);
}
const _navSweepP = new Float64Array(8);
let _navDropList = null, _navDropHdr = null;
function _navFieldsSweepEnd(k, step, mark) {
    // (In a rebuild's window no slot is let go (the next build's batches
    // keep theirs): the drop waits a cycle, the marks of both kept.)
    if (_navNext.nav) return;
    for (const F of _navFields.pools) {
        if (!F.pool || !F.ht) continue;
        if (!_navDropList || _navDropList.length < F.cap || !simHeapHas(_navDropList)) _navDropList = simSharedArray(Int32Array, Math.max(1024, F.cap));
        if (!_navDropHdr || !simHeapHas(_navDropHdr)) _navDropHdr = simSharedArray(Int32Array, 2);
        const P = _navSweepP;
        P[0] = F.cap; P[1] = F.ht.length >> 1; P[2] = mark; P[3] = NAV_FIELD_META;
        simRustDirect('k_nav_sweep_drop', [F.ht, F.meta, F.seen, _navDropList, _navDropHdr], P);
        for (let i = 0, nd = _navDropHdr[0]; i < nd; i++) {
            const s = _navDropList[i];
            F.free.push(s);
            if (F.rowKeyOf && F.rowSrc.get(F.rowKeyOf[s]) === s) F.rowSrc.delete(F.rowKeyOf[s]);
        }
        if (_navDropHdr[0] > 0) F.pending = F.pending.filter(s => F.meta[s * NAV_FIELD_META] >= 0);
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
        for (let s = 0; s < F.cap; s++) if (F.meta[s * NAV_FIELD_META] >= 0) all.push(s);
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
    if (w && w.length === ground.length) return w;
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
// same tick). Destination fields of the old build are dropped.
// (_navVersion: this peer's count of installs, for caches; nav.seq: the
// profile's build number, the same on every peer: snapshotted, so waiting
// units can tell a new build, see _tryUpgradeAstarFallbackPath.)
let _navVersion = 0, _navSeq = new Array(NAV_PROFILES).fill(0);
// made: its fields made over it already (a rebuild's window, its arrays
// installed: _navNextInstall).
function navPublish(nav, made = false) {
    simParallelBindBatch();
    try { _navPublishBody(nav, made); } finally { simParallelBindFlush(); }
}
function _navPublishBody(nav, made) {
    // (The flow looks' prewarm reads the builds: done first, tower.js tickStartChainSettle.)
    if (typeof tickStartChainSettle === 'function') tickStartChainSettle();
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
    // A completed rebuild has been the diff counter's reference since
    // it was posted; installing those same walls preserves the count.
    if (!made && p !== NAV_PROFILE_AIR) _navWallDiffReset(p);
}
// A build's arrays for the kernels under names pre + profile + '.' + name
// ('nav.': the installed one, 'navn.': the next, _navNextStage).
function _navBindBuild(pre, nav) {
    const p = nav.profile;
    simParallelBind(pre + p + '.fields', nav.fields);
    // meta: [C, cw, ch, nc, W, H, version, parts, the graph's bucket count
    // (largest edge + 1), nodes, edges, components]
    const meta = simHeapView(nav.arena, Int32Array, 256 + p * 128 + (pre === 'navn.' ? 64 : 0), 12);
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
    // Atlas routes never requested destination fields: there is nothing
    // to scan, copy, bind or remake. Keep the same deterministic window,
    // and expand it lazily if the first fallback field is requested.
    _navNext.empty = !!(NAV_ATLAS && nav.atlas && _navFields.pools.every(F => !F.used));
    if (_navNext.empty) return;
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
    if (_navNext.nav === nav && _navNext.empty) {
        _navNext.nav = null; _navNext.empty = false;
        navPublish(nav, true); return;
    }
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
    _navNext.nav = null; _navNext.empty = false; _navNext.copyPairs = null; _navNext.copying = false;
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
    // (A build's background stage, the fields' jobs: finished, dropped.)
    navBuildCollect();
    if (typeof simParallelBackgroundWait === 'function') { simParallelBackgroundWait(); if (typeof SIM_LANE_NAV === 'number') simParallelBackgroundWait(SIM_LANE_NAV); }
    _navFieldsJob.slots = null;
    _navGrow[0] = _navGrow[1] = null;
    if (_navNext.nav) _navNextDrop();
    for (const F of _navFields.pools) {
        if (F.meta) for (let s = 0; s < F.cap; s++) if (F.meta[s * NAV_FIELD_META] >= 0) { F.meta[s * NAV_FIELD_META] = -1; F.meta[s * NAV_FIELD_META + 6]++; F.free.push(s); }
        F.rowSrc = new Map();
        if (F.ht) F.ht.fill(0); F.pending = []; F.remake = null;
    }
    _navFields.flushedTick = -1;
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
const _navSub = { map: new Map(), req: [] };
// The substitutes' request and result arrays for the match (main.js
// startGame): room for one request a unit (units: the population the budget
// holds), so none is made during play.
function navSubReserve(units) {
    // (The simulation's only: the page runs startGame too, without a heap.)
    if (typeof simHeapHas !== 'function' || typeof simParallelBind !== 'function') return;
    units = Math.max(1024, units | 0);
    if (_navSub.list && _navSub.units === units && simHeapHas(_navSub.list)) return;
    _navSub.units = units;
    _navSub.list = simHeapArrayAuto(Int32Array, units * 3); simParallelBind('nav.sreq', _navSub.list);
    _navSub.out = simHeapArrayAuto(Int32Array, units); simParallelBind('nav.sout', _navSub.out);
}
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
    // (The arrays navSubReserve made at the match's start, bound once; one
    // request a unit at most. New ones bound each flush made the helpers sit
    // out this job and the next ones.)
    const n = req.length / 3;
    if (!_navSub.list || _navSub.list.length < req.length || !simHeapHas(_navSub.list)) navSubReserve(Math.max(n, _navSub.units || 0));
    const list = _navSub.list, out = _navSub.out;
    list.set(req);
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
    if (wt === 'builder' || wt === 'salvager') return NAV_PROFILE_BUILD;
    return NAV_PROFILE_GROUND;
}
// Up to maxLen tiles from (gx, gy) toward dest (the start first), as path
// nodes; null when the navigation has no way from there. For the interface:
// it changes nothing (a destination field it would ask for, or a build,
// would exist on the peer that shows the unit only): an existing field of
// the destination when there is one, else the coarse steps.
function navPath(profile, gx, gy, dest, maxLen) {
    const nav = _nav[profile];
    if (!nav || !(dest >= 0 && dest < nav.W * nav.H)) return null;
    const W = GRID_W, F = _navFields.pools[1], s = F && F.ht ? _navHtSlot(F, _navFieldKey(profile, dest)) : -1;
    const did = NAV_ATLAS && nav.atlas && nav.atlas.header ? NAV_ATLAS_FID : s < 0 ? -1 : NAV_WIDE_BASE + s;
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
function navNode(profile, tx, ty, previous = null) {
    navEnsure(profile);
    const id = navFieldRequest(profile, ty * GRID_W + tx);
    const ready = navFieldReadyFor(id);
    // Reuse an unchanged, narrow route without skipping the field request.
    if (previous && previous.x === tx && previous.y === ty && previous.nav === profile + 1 && previous.ready === ready && !previous.w) return previous;
    return { x: tx, y: ty, nav: profile + 1, ready };
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
// chain at a fixed simulation step, then install its destination fields.
// Stage identifiers retain their old values for saved pre-chain snapshots;
// scheduling uses _NAV_STAGES and J.gap, not elapsed base ticks.
const NAV_STEP_STAGE = 8, NAV_STEP_INSTALL = 12;
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
        if (_navNext.nav) _navNextDrop();
        _navSlots.capped[J.profile] = _navDiff[J.profile];
        _navSlots.lastInstall = gameTime;
        _navJob = null;
    }
    finally { _navSlots.cur = null; }
    _navRushCheck();
}
// The window's second half with its fields not made: the helpers take them
// first, more of them at once (simParallelBulkRush), so the install does not
// make the rest on this thread. Scheduling only: the same fields.
let _navRush = false;
function _navRushCheck() {
    const J = _navJob;
    const rush = !!J && !!J.next && typeof simParallelBackgroundPending === 'function' && simParallelBackgroundPending(SIM_LANE_NAVX);
    if (rush === _navRush) return;
    _navRush = rush;
    if (typeof simParallelBulkRush === 'function') simParallelBulkRush(rush ? SIM_LANE_NAVX : -1);
}
// Post the whole chain, collect and stage destination fields, then install.
// Completion time never chooses the step: a slow peer waits for the same
// data at the same scheduled step. At coarse steps this is two steps from
// post to install; at dk < 3 it is three. The complete build gets two short
// steps, followed by one step for the destination-field window.
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
        _navNextStage(J.next);
    } else if (step === NAV_STEP_INSTALL) {
        _navJob = null;
        _navSlots.lastInstall = gameTime;
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
    // (The air one too, as the match's first tick made it: flyers' fields
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
                if (_navNext.nav) _navNextDrop();
                _navSlots.capped[p] = -2;
                _navJob = null;
            } finally { _navSlots.cur = null; }
        }
    }
    for (let p = 0; p < NAV_PROFILES; p++) if (_nav[p] && p !== NAV_PROFILE_AIR) _navWallDiffReset(p);
}
