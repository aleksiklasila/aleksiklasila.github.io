"use strict";
// ============================================================
// PARALLEL SIMULATION JOBS (SharedArrayBuffer)
//
// With cross-origin isolation (coi-serviceworker.min.js) the simulation
// worker starts helper workers (sim_helper.js) and shares typed arrays with
// them. A job is a kernel run over chunks of work: every participant (the
// simulation worker and the helpers) takes the next chunk from a shared
// counter until none are left. A kernel is a pure function of its arrays
// and parameters and writes disjoint outputs per chunk, so the result is the
// same however the chunks were shared out, and the same as running them all
// in one thread (without isolation, in tests, on the page): lockstep peers
// with different core counts agree.
//
// Arrays reach the helpers by name (simParallelBind); a helper that has not
// yet received the latest arrays leaves a job to the others.
// ============================================================

const SIM_PAR_SHARED = typeof SharedArrayBuffer === 'function' && typeof Atomics === 'object' && typeof self !== 'undefined' && self.crossOriginIsolated === true;

// Control words.
const SIM_PAR_GEN = 0, SIM_PAR_KERNEL = 1, SIM_PAR_NEXT = 2, SIM_PAR_TOTAL = 3, SIM_PAR_DONE = 4, SIM_PAR_REGVER = 5, SIM_PAR_ACTIVE = 6;
// Background jobs (simParallelBackground), one per lane (lane 0: the tick's
// own jobs, taken first; lane 1: long jobs such as a navigation build;
// lanes 2-5: the tiers below the tick, see SIM_LANE_T10): its kernel, chunk
// count, done count, bindings version, ticket counter (job id << 24 | next
// chunk), the job's id (-1: closed, being written), the participants
// inside its claim section and its stage, at SIM_PAR_BG_BASE + lane * 8.
// A job is a chain of up to SIM_PAR_BG_STAGES stages (simParallelBackground
// is one stage): the participant that finishes a stage's last chunk posts
// the next one, so a pipeline runs to its end on the helpers. A lane is
// rewritten only once closed and empty (no claim in flight), so a late
// claim can never run a chunk of the next job.
const SIM_PAR_BG_BASE = 8, SIM_PAR_BG_KERNEL = 0, SIM_PAR_BG_TOTAL = 1, SIM_PAR_BG_DONE = 2, SIM_PAR_BG_REGVER = 3, SIM_PAR_BG_NEXT = 4, SIM_PAR_BG_LANES = 11;
const SIM_PAR_BG_ID = 5, SIM_PAR_BG_READERS = 6, SIM_PAR_BG_STAGE = 7, SIM_PAR_BG_STAGES = 24;
// (Control words: SIM_PAR_BG_BASE + lanes * 8, rounded up.)
const SIM_PAR_CTL_WORDS = 128;
// Bulk lanes (every live field remade over a new navigation build,
// SIM_LANE_NAVX): at most SIM_PAR_BG_CAP helpers inside their chunks at once
// (helpers - 3, at least 1; per lane at SIM_PAR_BG_RUN + lane), so the
// tick's foreground kernels always find helpers (all of them deep in a
// remake left the movement kernel to this thread alone: 114 ms ticks at
// 400k a team). Where chunks run never changes what they make.
const SIM_PAR_BG_CAP = 99, SIM_PAR_BG_RUN = 100;
// A helper's kernel threw (the chunk still counts as done, so nobody waits
// forever): the simulation thread throws at its next wait.
const SIM_PAR_ERR = 98;
function _simParCheckErr(ctl) {
    if (Atomics.load(ctl, SIM_PAR_ERR) !== 0) { Atomics.store(ctl, SIM_PAR_ERR, 0); throw new Error('a simulation helper kernel failed (see the helper log)'); }
}
// The tiers: work that need not run at the tick's rate (20 per second) goes
// to a lane of its rate, 10, 5, 1 or 0.5 per second (a period of 2, 4, 20 or
// 40 ticks). A tier's job takes its inputs at a fixed tick (a snapshot made
// then, or arrays nothing changes until it is done), runs on the helpers
// while the ticks go on, and is committed by the simulation thread at a
// fixed later tick (simParallelBackgroundWait: normally done by then), the
// same ticks on every peer, so the result is the same wherever it ran.
// Helpers take the lanes in priority order (SIM_PAR_BG_ORDER): the tick's
// own, then the tiers fastest first, then the long jobs.
// SIM_LANE_IX: the next tick's unit index, built after a tick's end (while
// the state hash and the time between ticks run; chunk.js
// spatialIndexPrebuild). SIM_LANE_BUILD: tables made once in a while and
// taken when done (the area range boxes of a new layout, path regions),
// never waited for by the tick's own work. SIM_LANE_NAV: the navigation's
// destination fields asked for in a tick, made by the next tick's flush
// (flownav.js navFieldsFlush). SIM_LANE_NAVX: every live field over a new
// navigation build, before it is installed (flownav.js _navNextStage).
const SIM_LANE_TICK = 0, SIM_LANE_LONG = 1, SIM_LANE_T10 = 2, SIM_LANE_T5 = 3, SIM_LANE_T1 = 4, SIM_LANE_T05 = 5, SIM_LANE_IX = 6, SIM_LANE_BUILD = 7, SIM_LANE_NAV = 8, SIM_LANE_NAVX = 9, SIM_LANE_HASH = 10;
const SIM_PAR_BG_ORDER = [SIM_LANE_TICK, SIM_LANE_HASH, SIM_LANE_IX, SIM_LANE_NAV, SIM_LANE_T10, SIM_LANE_T5, SIM_LANE_T1, SIM_LANE_T05, SIM_LANE_NAVX, SIM_LANE_BUILD, SIM_LANE_LONG];

// A typed array in shared memory when helpers may use it: in the wasm heap
// once it is up (freed when collected, as simHeapArrayAuto's), so the Rust
// kernels can read any array a kernel is given (the kernels are Rust only).
function simSharedArray(Type, n) {
    if (_simHeapAllocAuto !== null && typeof _simHeap !== 'undefined' && _simHeap.ready) return _simHeapAllocAuto(Type, n);
    return SIM_PAR_SHARED ? new Type(new SharedArrayBuffer(Math.max(1, n) * Type.BYTES_PER_ELEMENT)) : new Type(n);
}

// The wasm heap (sim_wasm.js installs it; without it, plain shared arrays):
// the arrays the Rust kernels read are allocated with simHeapArray, and an
// array replaced by another is given back with simHeapFree (its memory is
// reused only after SIM_HEAP_FREE_TICKS, once no name binds it).
let _simHeapAlloc = null, _simHeapRelease = null, _simHeapPtrOf = null, _simHeapAllocAuto = null;
function simHeapArray(Type, n) { return _simHeapAlloc !== null ? _simHeapAlloc(Type, n) : simSharedArray(Type, n); }
function simHeapFree(arr) { if (_simHeapRelease !== null && arr) _simHeapRelease(arr); }
// A view of part of a heap array (byte offset `off`, n elements of Type)
// with its heap address: the kernels take it like any array. Freed with its
// array, never alone.
let _simHeapViewReg = null;
function simHeapView(arr, Type, off, n) {
    const v = new Type(arr.buffer, arr.byteOffset + off, n);
    if (_simHeapViewReg !== null) _simHeapViewReg(arr, v, off);
    return v;
}
// An array given back by the collector (no simHeapFree): for arrays whose
// owners are dropped by many paths (a navigation build). Never take
// subarrays of one that could outlive it.
// (clear false: not zeroed when reused memory; only for arrays whose every
// element read is written first, e.g. a navigation rebuild's field pools.)
function simHeapArrayAuto(Type, n, clear = true) { return _simHeapAllocAuto !== null ? _simHeapAllocAuto(Type, n, clear) : simSharedArray(Type, n); }
// This thread's wasm kernels (null: none) and whether they run (shared by
// every thread of the simulation; sim_wasm.js simWasmKernels).
let _simWasmX = null, _simWasmOn = new Int32Array(1);
// This thread's view of the wasm memory and its scratch region (an
// address, a size in 32-bit words) for kernels that need work space.
let _simWasmMem = null, _simWasmScratch = 0, _simWasmScratchWords = 0;
// This thread's argument block for big kernels (sim_wasm.js): 1024 32-bit
// words (array addresses) at _simWasmArgs, then 512 doubles (parameters);
// views _simWasmArgI / _simWasmArgF.
let _simWasmArgs = 0, _simWasmArgI = null, _simWasmArgF = null;

// Arrays by name and scalar parameters (the same objects in every thread).
const _simParReg = {};
// Each bound array's address in the wasm heap (-1: not there).
const _simParWPtr = {};
let _simParRegVer = 0;
// Every binding made in this thread (the simulation thread's or a helper's):
// caches of registry lookups go by it (_simNavArrays).
let _simParBinds = 0;
const _simParams = simSharedArray(Float64Array, 64);
// The background jobs' parameters, per lane and stage (their own:
// foreground jobs rewrite _simParams): _simBgStageParams[lane][stage], views
// of one shared buffer per lane. _simBgParamsByLane[lane] is stage 0's;
// _simBgParams: lane 1 (long jobs), _simTickBgParams: lane 0 (the tick's).
const _simBgStageParams = [];
for (let lane = 0; lane < SIM_PAR_BG_LANES; lane++) {
    const all = simSharedArray(Float64Array, 64 * SIM_PAR_BG_STAGES), views = [];
    for (let st = 0; st < SIM_PAR_BG_STAGES; st++) views.push(all.subarray(st * 64, st * 64 + 64));
    _simBgStageParams.push(views);
}
const _simBgParamsByLane = _simBgStageParams.map(v => v[0]);
const _simTickBgParams = _simBgParamsByLane[0];
const _simBgParams = _simBgParamsByLane[1];
// Each lane's chain: its stage count, then [kernel, total] per stage.
const _simBgChain = simSharedArray(Int32Array, SIM_PAR_BG_LANES * (1 + 2 * SIM_PAR_BG_STAGES));

// ---- kernels: (arrays, params, chunk) ----
const SIM_KERNELS = [];
const SIM_KERNEL_VISIBILITY = 0, SIM_KERNEL_SEPARATION = 1, SIM_KERNEL_UNIT_FRAME = 2, SIM_KERNEL_UNIT_PACK = 3;
const SIM_KERNEL_SPATIAL_HISTOGRAM = 4, SIM_KERNEL_SPATIAL_SCATTER = 5, SIM_KERNEL_SEPARATION_PREPARE = 6;
const SIM_KERNEL_SEPARATION_FINISH = 7, SIM_KERNEL_MOVE = 8, SIM_KERNEL_SEPARATION_YIELD = 9;
const SIM_KERNEL_INDEX_CLEAR = 10, SIM_KERNEL_INDEX_COUNT = 11, SIM_KERNEL_INDEX_SCATTER = 12, SIM_KERNEL_INDEX_ORDER = 13;
const SIM_KERNEL_EFF_COUNT = 14, SIM_KERNEL_SNAP_REGION = 19, SIM_KERNEL_COMBAT_SCAN = 20, SIM_KERNEL_INDEX_KEYS = 23;
const SIM_KERNEL_VIS_SNAP = 30, SIM_KERNEL_VIS_SPREAD = 31;
const SIM_KERNEL_ACQ_SNAP = 32, SIM_KERNEL_ACQ_SCAN = 33, SIM_KERNEL_ACQ_COMMIT = 34, SIM_KERNEL_LASER_HITS = 35;
const SIM_KERNEL_UPD_CAND = 36, SIM_KERNEL_HELD_DEAD = 37, SIM_KERNEL_DRIVEBY = 38, SIM_KERNEL_WS_SCAN = 39, SIM_KERNEL_HEAL_CAND = 40, SIM_KERNEL_SP_COUNTS = 41, SIM_KERNEL_MOVE_STEP = 42, SIM_KERNEL_SAT_ROWS = 43, SIM_KERNEL_SAT_COLS = 44, SIM_KERNEL_WS_SELECT = 45, SIM_KERNEL_UPKEEP = 46;
const SIM_KERNEL_STATUS = 24, SIM_KERNEL_INDEX_FILL = 25, SIM_KERNEL_INDEX_RUNS = 26, SIM_KERNEL_EFF_UNITS = 27, SIM_KERNEL_VIS_SEED = 28;
const SIM_KERNEL_TILE_OWNERS = 29;
const SIM_KERNEL_HEAL_REDUCE = 47;
const SIM_KERNEL_WS_ORDER = 48;
const SIM_KERNEL_UNIT_RETIRE = 49;
// Ticks over which units whose flow look finds no way go back to Unit.update
// to re-route, each on its own (t + id) tick (a power of two).
const SIM_REROUTE_TICKS = 32;
const SIM_KERNEL_SEP_PACK = 50, SIM_KERNEL_SEP_MARK = 51, SIM_KERNEL_SEP_PAIRS = 52, SIM_KERNEL_ZERO = 53, SIM_KERNEL_SPATIAL_PREFIX = 54;
const SIM_KERNEL_AREA_BOX = 55, SIM_KERNEL_INDEX_MERGE = 56;

// One tick of an armed mover (see simMoveTryArm in unit.js): Unit.update
// for a unit marching along its path with nothing to react to, straight on
// the columns. It keeps a window of the path's nodes (mvNodes, path
// indices mvBase..), follows it like followPath and _followPathStep (the
// node scan when its tile or node changed, corridor and lane targets, the
// arrival step), checks the floor of a tile it enters and, for shooters and
// attack-movers, whether anything hostile may be in reach (per-block
// counts). Anything else leaves the whole tick to Unit.update: the kernel
// works on locals and writes nothing then (mvOn 0, mvOut 0). Written:
// position, speed, path index, node steps taken (mvSpent, charged by the
// main thread) and mvOut: 1 moved, 3 moved into another tile, 4 into a
// wall tile (x, y not yet quantized; the main thread pushes it out).
// Flow navigation (see flownav.js): the next tile from t toward dest, -1
// none. dfield: the destination field (costs over the box bx, by, bw x bh),
// used inside its box; elsewhere the cluster hop and the exit's local field.
// The flow look-ahead of a unit (unit state columns LC: the cache key
// mvNavT tile, mvNavD destination, mvNavV navigation build, mvNavW nearby walls, mvNavG
// destination field kind: 1 narrow, 2 wide (its slot and slot generation
// are this peer's own history, not a key: a field's content is a function
// of its destination, kind and build), and mvNavN1/N2/Far/Open; slot s) at tile tl
// = (gx, gy) toward dk, for the movement kernel and Unit._followNavNode
// alike: the next tile n1 (a wall the navigation predates in the way: the
// open side neighbour toward where the flow leads past it), the one after
// (n2), and on open ground up to 6 tiles ahead (Far; Open 1). Cached per
// tile; a new build or a nearby wall change makes it again only on the
// unit's refresh tick (`refresh`: a build does not redo every unit's at
// once; until then it steers by the old one, and slides along walls). 1: in
// LC; 0: no way there; -1: walled in on every side; -2: a step that is not
// to a neighbouring tile (a bad build).
const SIM_FLOW_REFRESH_TICKS = 4;
// Flow movement steers (the look-ahead, the side offset, the crowd) when it
// has no committed step, in another tile than the one it steered in (the
// look-ahead goes by tile), and when its step's time is up: SIM_STEER_TICKS
// ticks, SIM_STEER_NEAR_TICKS within 8 tiles of its destination (a crowd
// there); between, it goes on along the step its last steer committed
// (unit.mvCD destination, mvCTl tile, mvCT tick, mvCN ticks, mvCVx/y),
// sliding along a wall it runs into (then it steers next tick). The
// movement kernel and Unit._followNavNode alike. (Its crowd check compares
// the distance made good since its last steer: SIM_STEER_NEAR_TICKS ticks'
// worth.)
const SIM_STEER_TICKS = 16, SIM_STEER_NEAR_TICKS = 4;
// (The steps' tiles carried with their coordinates, a neighbour's from its
// index's difference: the divisions by the map width were a quarter of the
// movement kernel.) PL, PB: the build's parts (partL, partBase); ROWS, ro:
// the destination's row (every part's exit toward it, flownav.js).
function simFlowLook(LC, s, refresh, tl, gx, gy, dk, Wd, Hd, WL, navVer, wv, fgen,
    nC, ncw, PL, PB, ROWS, ro, NF, NB, NT, NP, df, doff, dbx, dby, dbw, dbh) {
    if (LC.mvNavT[s] === tl && LC.mvNavD[s] === dk && LC.mvNavG[s] === fgen && (!refresh || (LC.mvNavV[s] === navVer && LC.mvNavW[s] === wv))) return 1;
    // (Clusters are 16 or 32 tiles: a shift.)
    const cs = 31 - Math.clz32(nC);
    let n1 = simNavStepXY(Wd, cs, nC, ncw, PL, PB, ROWS, ro, NF, NB, NT, NP, df, doff, dbx, dby, dbw, dbh, tl, gx, gy, dk);
    if (n1 < 0) return 0;
    let n2 = -1, far = n1, open = false;
    const n1x = _simStepX(n1, tl, gx, Wd), n1y = _simStepY(n1, tl, gx, gy, Wd);
    if (WL[n1]) {
        let aim = simNavStepXY(Wd, cs, nC, ncw, PL, PB, ROWS, ro, NF, NB, NT, NP, df, doff, dbx, dby, dbw, dbh, n1, n1x, n1y, dk);
        if (!(aim >= 0) || WL[aim]) aim = dk;
        n1 = simNavDetour(WL, Wd, Hd, gx, gy, aim);
        if (n1 < 0) return -1;
        far = n1;
    } else {
        if (Math.abs(n1x - gx) + Math.abs(n1y - gy) !== 1) return -2;
        open = _simOpenBlockXY(WL, gx, gy, Wd, Hd) && _simOpenBlockXY(WL, n1x, n1y, Wd, Hd);
        let cur = n1, cx = n1x, cy = n1y;
        for (let k = 1; k < (open ? 6 : 2); k++) {
            const nx = simNavStepXY(Wd, cs, nC, ncw, PL, PB, ROWS, ro, NF, NB, NT, NP, df, doff, dbx, dby, dbw, dbh, cur, cx, cy, dk);
            if (nx < 0 || WL[nx]) break;
            if (k === 1) n2 = nx;
            if (!open) break;
            const nxx = _simStepX(nx, cur, cx, Wd), nxy = _simStepY(nx, cur, cx, cy, Wd);
            if (!_simOpenBlockXY(WL, nxx, nxy, Wd, Hd)) break;
            far = cur = nx; cx = nxx; cy = nxy;
        }
    }
    LC.mvNavT[s] = tl; LC.mvNavD[s] = dk; LC.mvNavV[s] = navVer; LC.mvNavW[s] = wv; LC.mvNavG[s] = fgen;
    LC.mvNavN1[s] = n1; LC.mvNavN2[s] = n2; LC.mvNavFar[s] = far; LC.mvNavOpen[s] = open ? 1 : 0;
    return 1;
}
// Tile n's column and row, n a step from tile t (column tx, row ty): a
// side neighbour's from the difference, anything else (a portal's pair)
// divided out.
function _simStepX(n, t, tx, W) {
    const d = n - t;
    if (d === W || d === -W) return tx;
    if (d === 1 && tx + 1 < W) return tx + 1;
    if (d === -1 && tx > 0) return tx - 1;
    return n % W;
}
function _simStepY(n, t, tx, ty, W) {
    const d = n - t;
    if (d === W) return ty + 1;
    if (d === -W) return ty - 1;
    if ((d === 1 && tx + 1 < W) || (d === -1 && tx > 0)) return ty;
    return (n - n % W) / W;
}
// The look-ahead's wall key at tile (gx, gy): the wall change counts of the
// 3x3 blocks of 8 tiles around it (WBLK; its walls within 8 tiles), else
// the global wall version.
// (The same from WBLK9, each block's 3x3 sum kept where WBLK changes:
// unit.js simMoveTileTypeChanged.)
function simWallKey9(WBLK9, WBW, gx, gy, wver) {
    return WBLK9 ? WBLK9[(gy >> 3) * WBW + (gx >> 3)] | 0 : wver;
}
function simWallKey(WBLK, WBW, WBH, gx, gy, wver) {
    if (!WBLK) return wver;
    const bx = gx >> 3, by = gy >> 3;
    let wv = 0;
    for (let yy = by - 1; yy <= by + 1; yy++) {
        if (yy < 0 || yy >= WBH) continue;
        for (let xx = bx - 1; xx <= bx + 1; xx++) if (xx >= 0 && xx < WBW) wv = (wv + WBLK[yy * WBW + xx]) | 0;
    }
    return wv;
}

// The flow's next tile from (gx, gy) is a wall the navigation predates (a
// building since its last build; the next build is made in the background):
// the open side neighbour (4-way) nearest to tile `aim` (where the flow leads
// past it), the first in N, S, W, E order on ties; -1 none.
function simNavDetour(WL, W, H, gx, gy, aim) {
    const ax = aim % W, ay = (aim - ax) / W;
    let best = -1, bd = Infinity;
    for (let k = 0; k < 4; k++) {
        const x = gx + (k === 2 ? -1 : k === 3 ? 1 : 0), y = gy + (k === 0 ? -1 : k === 1 ? 1 : 0);
        if (x < 0 || y < 0 || x >= W || y >= H || WL[y * W + x]) continue;
        const ex = ax - x, ey = ay - y, d = ex * ex + ey * ey;
        if (d < bd) { bd = d; best = y * W + x; }
    }
    return best;
}
// A ground unit on a flow at tile (gx, gy) whose step would end in tile
// (ngx, ngy), a wall or off the map (WL): it slides along the wall on one
// axis, x first, else stands. Returns which components to drop: 0 none,
// 2 the y step, 1 the x step, 3 both.
function simFlowSlide(WL, W, H, gx, gy, ngx, ngy) {
    // (Staying in its tile: nothing to slide along, even standing in a wall
    // tile (a building put down under it), which it could never leave.)
    if (ngx === gx && ngy === gy) return 0;
    const ox = ngx >= 0 && ngx < W, oy = ngy >= 0 && ngy < H;
    if (ox && oy && WL[ngy * W + ngx] === 0) return 0;
    if (ox && gy >= 0 && gy < H && WL[gy * W + ngx] === 0) return 2;
    if (oy && gx >= 0 && gx < W && WL[ngy * W + gx] === 0) return 1;
    return 3;
}
// The next tile from t toward dest: the destination field where it reaches
// the destination, else the exit of t's part in the destination's row
// (rows at ro; part = partBase[cluster] + partL[t]) and that exit's local
// field. -1: no way (or at dest).
function simNavStep(W, C, cw, partL, partBase, rows, ro, fields, nodeBase, nodeTile, nodePair, dfield, doff, bx, by, bw, bh, t, dest) {
    if (t === dest) return -1;
    const tx = t % W, ty = (t - tx) / W;
    if (dfield) {
        const lx = tx - bx, ly = ty - by;
        if (lx >= 0 && ly >= 0 && lx < bw && ly < bh) {
            const o = doff + ly * bw + lx, here = dfield[o];
            if (here !== 0xFFFF) {
                let best = -1, bv = here;
                if (lx + 1 < bw && dfield[o + 1] < bv) { bv = dfield[o + 1]; best = t + 1; }
                if (lx > 0 && dfield[o - 1] < bv) { bv = dfield[o - 1]; best = t - 1; }
                if (ly + 1 < bh && dfield[o + bw] < bv) { bv = dfield[o + bw]; best = t + W; }
                if (ly > 0 && dfield[o - bw] < bv) { bv = dfield[o - bw]; best = t - W; }
                return best;
            }
        }
    }
    const cxi = (tx / C) | 0, cyi = (ty / C) | 0, cf = cyi * cw + cxi, pl = partL[t];
    if (pl === 0xFFFF) return _simWallStepOut(partL, partBase, rows, ro, W, C, cw, t, tx, ty);
    const e = rows[ro + partBase[cf] + pl];
    if (e >= 254) return -1;
    const node = nodeBase[cf] + e;
    if (nodeTile[node] === t) { const p = nodePair[node]; return p >= 0 ? nodeTile[p] : -1; }
    const off = node * C * C, lx = tx - cxi * C, ly = ty - cyi * C;
    let best = -1, bv = fields[off + ly * C + lx];
    if (lx + 1 < C && fields[off + ly * C + lx + 1] < bv) { bv = fields[off + ly * C + lx + 1]; best = t + 1; }
    if (lx > 0 && fields[off + ly * C + lx - 1] < bv) { bv = fields[off + ly * C + lx - 1]; best = t - 1; }
    if (ly + 1 < C && fields[off + (ly + 1) * C + lx] < bv) { bv = fields[off + (ly + 1) * C + lx]; best = t + W; }
    if (ly > 0 && fields[off + (ly - 1) * C + lx] < bv) { bv = fields[off + (ly - 1) * C + lx]; best = t - W; }
    return best;
}

// Standing on a wall tile (a building put down under it): out to an open
// side neighbour, N, S, W, E: the first whose part has a way in the
// destination's row (rows null: the first open), else the first open; -1
// none. (H: from the parts' length.)
function _simWallStepOut(partL, partBase, rows, ro, W, C, cw, t, tx, ty) {
    const H = (partL.length / W) | 0;
    let first = -1;
    for (let k = 0; k < 4; k++) {
        const x = tx + (k === 2 ? -1 : k === 3 ? 1 : 0), y = ty + (k === 0 ? -1 : k === 1 ? 1 : 0);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const n = y * W + x, l = partL[n];
        if (l === 0xFFFF) continue;
        if (first < 0) first = n;
        if (!rows) return n;
        if (rows[ro + partBase[((y / C) | 0) * cw + ((x / C) | 0)] + l] !== 255) return n;
    }
    return first;
}
// simNavStep from tile t at column tx, row ty, 2^cs-tile clusters
// (simFlowLook's steps).
function simNavStepXY(W, cs, C, cw, partL, partBase, rows, ro, fields, nodeBase, nodeTile, nodePair, dfield, doff, bx, by, bw, bh, t, tx, ty, dest) {
    if (t === dest) return -1;
    if (dfield) {
        const lx = tx - bx, ly = ty - by;
        if (lx >= 0 && ly >= 0 && lx < bw && ly < bh) {
            const o = doff + ly * bw + lx, here = dfield[o];
            if (here !== 0xFFFF) {
                let best = -1, bv = here;
                if (lx + 1 < bw && dfield[o + 1] < bv) { bv = dfield[o + 1]; best = t + 1; }
                if (lx > 0 && dfield[o - 1] < bv) { bv = dfield[o - 1]; best = t - 1; }
                if (ly + 1 < bh && dfield[o + bw] < bv) { bv = dfield[o + bw]; best = t + W; }
                if (ly > 0 && dfield[o - bw] < bv) { bv = dfield[o - bw]; best = t - W; }
                return best;
            }
        }
    }
    const cxi = tx >> cs, cyi = ty >> cs, cf = cyi * cw + cxi, pl = partL[t];
    if (pl === 0xFFFF) return _simWallStepOut(partL, partBase, rows, ro, W, C, cw, t, tx, ty);
    const e = rows[ro + partBase[cf] + pl];
    if (e >= 254) return -1;
    const node = nodeBase[cf] + e;
    if (nodeTile[node] === t) { const p = nodePair[node]; return p >= 0 ? nodeTile[p] : -1; }
    const off = node * C * C, lx = tx - (cxi << cs), ly = ty - (cyi << cs), o = off + ly * C + lx;
    let best = -1, bv = fields[o];
    if (lx + 1 < C && fields[o + 1] < bv) { bv = fields[o + 1]; best = t + 1; }
    if (lx > 0 && fields[o - 1] < bv) { bv = fields[o - 1]; best = t - 1; }
    if (ly + 1 < C && fields[o + C] < bv) { bv = fields[o + C]; best = t + W; }
    if (ly > 0 && fields[o - C] < bv) { bv = fields[o - C]; best = t - W; }
    return best;
}
// _simOpenBlock at column x, row y.
function _simOpenBlockXY(WALL, x, y, W, H) {
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false;
    for (let yy = y - 1; yy <= y + 1; yy++) { const r = yy * W; if (WALL[r + x - 1] | WALL[r + x] | WALL[r + x + 1]) return false; }
    return true;
}

// Whether area b is within k steps of area a (data_state.js
// isAreaWithinDistance) on the area graph area.off / area.nb (CSR): 1 yes,
// 0 no, -1 not worked out here (k > 2).
// A source window's key at (x, y): its tile * 9 + zone (which third of the
// tile on each axis: the window covers the tile before or after below .3 or
// above .7), as isWorldTargetWithinAreaRange looks at it.
function simWindowKey(x, y, tile) {
    const fx = x / tile, fy = y / tile, gx = Math.floor(fx), gy = Math.floor(fy), rx = fx - gx, ry = fy - gy;
    return (gy * 65536 + gx) * 9 + (rx < .3 ? 0 : rx < .7 ? 1 : 2) * 3 + (ry < .3 ? 0 : ry < .7 ? 1 : 2);
}
function _simAreaNear(OFF, NB, a, b, k) {
    if (a === b) return 1;
    if (k <= 0) return 0;
    const a0 = OFF[a], a1 = OFF[a + 1];
    for (let i = a0; i < a1; i++) if (NB[i] === b) return 1;
    if (k === 1) return 0;
    if (k > 2) return -1;
    for (let i = a0; i < a1; i++) {
        const c = NB[i];
        for (let j = OFF[c], j1 = OFF[c + 1]; j < j1; j++) if (NB[j] === b) return 1;
    }
    return 0;
}
// isWorldTargetWithinAreaRange: a target at (tx, ty) within k area steps of
// any area of the source window at (x, y) (the tile, and the one before or
// after it on each axis nearer than .3 of a tile to that side). 1, 0, -1.
function _simInAreaRange(AG, OFF, NB, W, H, tile, x, y, tx, ty, k) {
    const tgx = Math.floor(tx / tile), tgy = Math.floor(ty / tile);
    if (tgx < 0 || tgy < 0 || tgx >= W || tgy >= H) return 0;
    const ta = AG[tgy * W + tgx];
    if (!(ta >= 0)) return 0;
    const fx = x / tile, fy = y / tile, gx = Math.floor(fx), gy = Math.floor(fy), rx = fx - gx, ry = fy - gy;
    const x0 = rx < .3 ? gx - 1 : gx, x1 = rx < .7 ? gx : gx + 1, y0 = ry < .3 ? gy - 1 : gy, y1 = ry < .7 ? gy : gy + 1;
    let unknown = 0;
    for (let yy = y0; yy <= y1; yy++) {
        if (yy < 0 || yy >= H) continue;
        for (let xx = x0; xx <= x1; xx++) {
            if (xx < 0 || xx >= W) continue;
            const a = AG[yy * W + xx];
            if (!(a >= 0)) continue;
            const r = _simAreaNear(OFF, NB, a, ta, k);
            if (r === 1) return 1;
            if (r < 0) unknown = 1;
        }
    }
    return unknown ? -1 : 0;
}


// Whether a drive-by shooter s at (x, y) (unit.js tryDriveByAttack, its
// timer run out) may find something to hit with its look (_driveByScan) in
// the tiles x0..x1, y0..y1 (those of the areas in its reach): an enemy unit
// listed there (the unit index: where it stood at the tick's start) in an
// area its player sees (cover cov) and in its attack range (k whole area
// steps, or touching; not worked out: yes); else (structs: hostile
// structures in those blocks) a hostile structure on a tile it sees there
// within its range by areas. Conservative: false only when the look finds
// nothing.
// Whether the acquisition tier's committed result (stamp: the commit tick,
// unit.js _acqCommitTick) has a target for unit s, alive and the same unit,
// looked for with its current range (as unit.js _combatScanHit).
function _simAcqHit(CBTK, CBT, CTI, CRS, RNG, ID, DEAD, s, stamp) {
    if (CBTK[s] !== stamp || CRS[s] !== RNG[s]) return false;
    const q = CBT[s];
    return q >= 0 && !DEAD[q] && (ID[q] | 0) === CTI[s];
}

// Flow movement between steers (SIM_STEER_TICKS), the common case of the
// movement kernel on its own (run just before it, the same parameters): a
// flow unit off its steer tick with a committed step, whose every per-tick
// check passes as SIM_KERNEL_MOVE's would (alive, indexed, on the map, its
// floor, a drive-by shooter's look, its field and route, not on its
// destination tile), takes the step exactly as SIM_KERNEL_MOVE would and is
// marked in the job-local _simMoveDone (by slot - s0), which the rest of
// SIM_KERNEL_MOVE skips: both run in the same scheduled chunk. Anything else
// is left untouched for SIM_KERNEL_MOVE (which decides it the same way).
// (The movement kernels' lists of units, by pass: see SIM_KERNEL_MOVE.)
let _simMoveDone = new Uint8Array(1024);
let _simMoveLists = new Int32Array(4096), _simMoveCounts = new Int32Array(4);
// In two passes (see the movement kernel's): the parked units' ticks and
// the flow units' candidates, then their steps (_simStepFlow, compiled on
// its own: the flow section first taken at a big order's first units, its
// first deoptimization and recompile were the whole kernel's, ~25 ms).
SIM_KERNELS[SIM_KERNEL_MOVE_STEP] = function (R, P, chunk) {
    const s0 = chunk * P[1], end = Math.min(P[0], s0 + P[1]), n = Math.max(0, end - s0);
    if (_simMoveWasm(R, P)) { _simWasmX.mv_step(_simWasmArgs, s0, end); return; }
    _simNoWasm('MOVE_STEP');
};
// The arrays of every navigation profile's build under a name (flownav.js
// binds them as nav.<profile>.<name>), and their walls: the ground's, the
// air's, a walk class's (mv.cwall.<profile>, see _navClassWalls).
// (Kept until a binding changes in this thread, or another registry is
// passed: each kernel job built them from ~80 string keys, ~5 ms a tick of
// the movement kernels' time at 200k.)
const _simNavArraysCache = new Map();
let _simNavArraysR = null, _simNavArraysBinds = -1;

// The movement kernel in passes over the chunk, each a function of its own
// (compiled on its own: a section first taken, e.g. the flow section at a
// big order's first units, deoptimizes and recompiles that pass, not one
// 23 KB kernel: TurboFan took 50-110 ms over it, the whole kernel at
// baseline speed meanwhile, ~10x slower, on every helper at once). A unit
// goes through them as through the one loop before (its sections in order;
// units do not read what another unit's sections write): the checks, holds,
// chases and looks, then the flow's or the path's step, handed on in the
// chunk's lists (_simMoveLists, n slots each from 2n: the flow's, the
// path's; their lengths in _simMoveCounts[2], [3]). (A pass visits its own
// units: a mode per slot tested in each mispredicted on mixed chunks; in six
// passes, ~2x the kernel.)
SIM_KERNELS[SIM_KERNEL_MOVE] = function (R, P, chunk) {
    const s0 = chunk * P[1], end = Math.min(P[0], s0 + P[1]), n = Math.max(0, end - s0);
    if (_simMoveWasm(R, P)) { _simWasmX.mv_move(_simWasmArgs, s0, end, chunk); return; }
    _simNoWasm('MOVE');
};

// The hostile tables (unit.js _simMoveBuildHostile) in two passes: per
// player and block row, its prefix along the row (SIM_KERNEL_SAT_ROWS), then
// per player and column, the rows summed down (SIM_KERNEL_SAT_COLS); integer
// sums, the same as the serial build. mv.hostile: other players' units
// (ix.bcount) plus structures hostile to the player (mv.stblk); mv.hstruct:
// the structures alone. Row and column 0 stay 0. P: [0] players, [1] blocks
// wide, [2] blocks high, [3] rows (columns) per job.
const _simSatRowsW = _simWK(['mv.hostile', 'mv.hstruct', 'ix.bcount', 'mv.stblk']), _simSatColsW = _simWK(['mv.hostile', 'mv.hstruct']);
SIM_KERNELS[SIM_KERNEL_SAT_ROWS] = function (R, P, chunk) { _simRust(_simSatRowsW, P, chunk, 'k_sat_rows', 'SAT_ROWS'); };
SIM_KERNELS[SIM_KERNEL_SAT_COLS] = function (R, P, chunk) { _simRust(_simSatColsW, P, chunk, 'k_sat_cols', 'SAT_COLS'); };

// The movement kernel's chunk moves into the counts (chunk.js
// spatialCountsDeferEnd): per slot with one (spMvOwn), its owner's total of
// the chunk it left less one, of the chunk it entered plus one, its type's
// count of their type blocks (spatial.types) and the 8x8 blocks' totals
// (Atomics: chunks are shared between slots).
// P: [0] slots, [1] per job, [2] players, [3] stride per chunk, [4] stride
// per player, [5] chunks wide, [6] blocks wide, [7] block size, [8] unit
// types, [9] type blocks wide, [10] type block size.
const _simSpCountsW = _simWK(['unit.spMvOld', 'unit.spMvNew', 'unit.spMvOwn', 'unit.spType', 'ix.complex', 'ix.bcount', 'spatial.types']);
SIM_KERNELS[SIM_KERNEL_SP_COUNTS] = function (R, P, chunk) { _simRust(_simSpCountsW, P, chunk, 'k_sp_counts', 'SP_COUNTS'); };

// (The collision correction: the movement kernel's epilogue, wasm/src/mv.rs
// move_epilogue, applies the pair kernel's pushes where each unit moved.)

// Stable radix ordering: each partition owns one histogram and scatter cursor.
// Prefixes are reduced in partition order, never in worker claim order. Memory
// is O(units + partitions*256), independent of map area or helper count.
// (Per key slot P[5]: spatial.keys, spatial.keys.1, ...)
const _simRadixW = [];
function _simRadixK(slot) {
    slot |= 0;
    return _simRadixW[slot] || (_simRadixW[slot] = _simWK([slot ? 'spatial.keys.' + slot : 'spatial.keys', 'spatial.orderA', 'spatial.orderB', 'spatial.hist']));
}
SIM_KERNELS[SIM_KERNEL_SPATIAL_HISTOGRAM] = function (R, P, chunk) { _simRust(_simRadixK(P[5]), P, chunk, 'k_radix_hist', 'SPATIAL_HISTOGRAM'); };
SIM_KERNELS[SIM_KERNEL_SPATIAL_SCATTER] = function (R, P, chunk) { _simRust(_simRadixK(P[5]), P, chunk, 'k_radix_scatter', 'SPATIAL_SCATTER'); };

// The histograms' cursors (the serial step between SIM_KERNEL_SPATIAL_HISTOGRAM
// and SCATTER, as one job of a chain): per digit, per partition in order.
// P: [0] partitions.
// The area range boxes (unit.js _simMoveAreaBoxes, getAreaRangeTileBox's
// boxes) of every area at every distance d < P[2], one stage per d: the
// areas within d steps of an area are itself and those within d - 1 of a
// neighbour, so its box at d is its box at d - 1 joined with its
// neighbours' at d - 1 (d = 0: its own tiles' box). abox.out[(a * P[2] + d)
// * 4]: min gx, min gy, max gx, max gy; empty [1, 1, 0, 0] (an area without
// tiles, which has no neighbours either). P: [0] areas, [1] per job, [2]
// distances, [3] d.
const _simAreaBoxW = _simWK(['abox.own', 'abox.out', 'abox.off', 'abox.nb']);
SIM_KERNELS[SIM_KERNEL_AREA_BOX] = function (R, P, chunk) { _simRust(_simAreaBoxW, P, chunk, 'k_area_box', 'AREA_BOX'); };

// The unit index's order (ix.ordC: units indices by (chunk, index), the
// radix sort's result) made from the last index instead of sorted anew
// (chunk.js spatialIndexPrebuild): its entries (sep.eslot / sep.ekey /
// ix.eid, P[1] of them, by (chunk, index) as the units list was then) whose
// unit holds the same slot and stands in the same chunk keep their order
// (removals keep the list's order, additions come last); the others (moved,
// new, a slot given to another unit) sorted by (chunk, index) and merged
// in. One job: a pass over the last entries and over the units, a sort of
// the movers. Disorder (never expected): a counting sort of everything,
// the same order. P: [0] units, [1] last entries, [2] chunks, [3] epoch.
const _simIxMergeW = _simWK(['sep.eslot', 'sep.ekey', 'ix.eid', 'ix.keys', 'ix.slots', 'unit.id', 'ix.inv', 'ix.invStamp', 'ix.kept', 'ix.ordC', 'ix.chg']);
SIM_KERNELS[SIM_KERNEL_INDEX_MERGE] = function (R, P, chunk) { _simRust(_simIxMergeW, P, chunk, 'k_ix_merge', 'INDEX_MERGE'); };

// A range of the wasm heap zeroed in jobs (bytes P[0] to P[0] + P[1], P[2]
// a job): simParallelZeroHeap. (Over the memory's current buffer, which
// every helper has: no binding, which helpers busy elsewhere would not have
// taken yet, leaving the whole job to this thread.)
const _simZeroW = _simWK([]);
SIM_KERNELS[SIM_KERNEL_ZERO] = function (R, P, chunk) { _simRust(_simZeroW, P, chunk, 'k_zero', 'ZERO'); };
// A big zeroing of the wasm heap (its allocations, sim_wasm.js) by the
// helpers and this thread together: a foreground run over the memory's
// buffer, the caller's kernel parameters kept (an allocation comes between
// a caller's parameters and its run). A navigation rebuild's fields (~300 MB
// at 400k a team) took ~100-150 ms on this thread alone.
const SIM_ZERO_PAR_MIN = 1 << 23, SIM_ZERO_PER = 1 << 20;
let _simParRunning = 0;
function simParallelZeroHeap(buf, off, bytes) {
    // (Never inside a job this thread is running: that job's state is in use.)
    if (!_simPool || bytes < SIM_ZERO_PAR_MIN || _simParRunning || _simWasmMem === null || _simWasmMem.buffer !== buf) { new Uint8Array(buf, off, bytes).fill(0); return; }
    const P = _simParams, saved = P.slice();
    P[0] = off; P[1] = bytes; P[2] = SIM_ZERO_PER;
    simParallelRun(SIM_KERNEL_ZERO, Math.ceil(bytes / SIM_ZERO_PER));
    P.set(saved);
}

const _simRadixPrefixW = _simWK(['spatial.hist']);
SIM_KERNELS[SIM_KERNEL_SPATIAL_PREFIX] = function (R, P, chunk) { _simRust(_simRadixPrefixW, P, chunk, 'k_radix_prefix', 'SPATIAL_PREFIX'); };

const _simSpatialOrder = { cap: 0 };
// The stages of a stable radix ordering (simSpatialStableOrder's) for a
// background chain: [[kernel, jobs, params], ...] and the array the order
// ends in. The keys must be bound (spatial.keys.<keySlot>) by the caller.
function simSpatialStableOrderStages(count, maxKey, keySlot) {
    const S = _simSpatialOrder, partition = 4096, parts = Math.ceil(count / partition);
    if (!S.a || count > S.cap) {
        S.cap = Math.max(1024, count, S.cap * 2);
        S.a = simSharedArray(Int32Array, S.cap); S.b = simSharedArray(Int32Array, S.cap);
        S.hist = simSharedArray(Int32Array, Math.ceil(S.cap / partition) * 256);
        simParallelBind('spatial.orderA', S.a); simParallelBind('spatial.orderB', S.b);
        simParallelBind('spatial.hist', S.hist);
    }
    const stages = [];
    let flip = 0;
    for (let shift = 0; shift === 0 || (maxKey >>> shift) !== 0; shift += 8) {
        const p = [count, partition, shift, shift === 0 ? 1 : 0, flip, keySlot];
        stages.push([SIM_KERNEL_SPATIAL_HISTOGRAM, parts, p], [SIM_KERNEL_SPATIAL_PREFIX, 1, [parts]], [SIM_KERNEL_SPATIAL_SCATTER, parts, p]);
        flip ^= 1;
        if (shift === 24) break;
    }
    return { stages, out: flip ? S.b : S.a };
}
// (keySlot: the name the keys are bound under, so that callers sorting
// different key arrays each keep theirs bound.)
function simSpatialStableOrder(keys, count, maxKey, keySlot = 0) {
    const S = _simSpatialOrder, partition = 4096, parts = Math.ceil(count / partition);
    if (!S.a || count > S.cap) {
        S.cap = Math.max(1024, count, S.cap * 2);
        S.a = simSharedArray(Int32Array, S.cap); S.b = simSharedArray(Int32Array, S.cap);
        S.hist = simSharedArray(Int32Array, Math.ceil(S.cap / partition) * 256);
        simParallelBind('spatial.orderA', S.a); simParallelBind('spatial.orderB', S.b);
        simParallelBind('spatial.hist', S.hist);
    }
    simParallelBind(keySlot ? 'spatial.keys.' + keySlot : 'spatial.keys', keys);
    let flip = 0;
    for (let shift = 0; shift === 0 || (maxKey >>> shift) !== 0; shift += 8) {
        _simParams[0] = count; _simParams[1] = partition; _simParams[2] = shift;
        _simParams[3] = shift === 0 ? 1 : 0; _simParams[4] = flip; _simParams[5] = keySlot;
        simParallelRun(SIM_KERNEL_SPATIAL_HISTOGRAM, parts);
        let cursor = 0;
        for (let digit = 0; digit < 256; digit++) for (let part = 0; part < parts; part++) {
            const index = part * 256 + digit, n = S.hist[index];
            S.hist[index] = cursor; cursor += n;
        }
        simParallelRun(SIM_KERNEL_SPATIAL_SCATTER, parts);
        flip ^= 1;
        if (shift === 24) break;
    }
    return flip ? S.b : S.a;
}



// Frame ownership: only the simulation writes a buffer until this job joins.
// The page then owns that immutable buffer until it explicitly returns it.
// Helpers read authoritative Float64 unit columns, never mutable Unit objects.
let _simKernelFrame = null;
SIM_KERNELS[SIM_KERNEL_UNIT_FRAME] = function (R, P, chunk) {
    const buf = R['frame.buffer.' + P[9]].buffer, cap = P[0];
    let F = _simKernelFrame;
    if (!F || F.buf !== buf || F.cap !== cap) F = _simKernelFrame = simFrameViews(buf, cap);
    const X = R['unit.x'], Y = R['unit.y'], VX = R['unit.vx'], VY = R['unit.vy'];
    const PREVX = R['unit.prevX'], PREVY = R['unit.prevY'], ID = R['unit.id'];
    const ENERGY = R['unit.energy'], OWNER = R['unit.owner'], RAD = R['unit.r'], CMD = R['unit.commandState'];
    const BURN = R['unit.burning'], POISON = R['unit.poisoned'], FROZEN = R['unit.frozen'], WET = R['unit.wet'], SAND = R['unit.sandy'];
    const WATCH = R['unit.watched'], HIDE = R['unit.teleportHideTicks'], TRANSFER = R['unit.workerTransferCooldown'];
    const LEVEL = R['unit.effectiveLevel'], BASE = R['unit.unitLevel'], FLASH = R['unit.attackFlash'];
    const slots = R['frame.slot'], lastX = R['frame.lastX'], lastY = R['frame.lastY'];
    const targetX = R['frame.targetX'], targetY = R['frame.targetY'], still = R['frame.still'], flash = R['frame.flash'];
    const time = P[3], rate = P[4], tile = P[5];
    for (let i = chunk * P[2], end = Math.min(P[1], i + P[2]); i < end; i++) {
        const s = F.order[i], u = slots[s], x = X[u], y = Y[u], vx = VX[u] || 0, vy = VY[u] || 0;
        F.id[s] = ID[u]; F.owner[s] = OWNER[u]; F.energy[s] = ENERGY[u]; F.r[s] = RAD[u]; F.cmd[s] = CMD[u] | 0;
        F.flags[s] |= (BURN[u] > 0 ? SIM_UF_BURNING : 0) | (POISON[u] > 0 ? SIM_UF_POISONED : 0)
            | (FROZEN[u] > 0 ? SIM_UF_FROZEN : 0) | (WET[u] > 0 ? SIM_UF_WET : 0) | (SAND[u] > 0 ? SIM_UF_SANDY : 0)
            | (WATCH[u] > 0 ? SIM_UF_WATCHED : 0) | (HIDE[u] > 0 ? SIM_UF_HIDDEN : 0) | (TRANSFER[u] > 0 ? SIM_UF_TRANSFER : 0);
        F.level[s] = Number.isFinite(LEVEL[u]) ? LEVEL[u] : -1;
        F.blevel[s] = Number.isFinite(BASE[u]) ? BASE[u] : -1;
        F.flash[s] = Math.max(0, Math.min(255, FLASH[u]));
        F.x[s] = x; F.y[s] = y; F.vx[s] = vx; F.vy[s] = vy;
        F.px[s] = lastX[s]; F.py[s] = lastY[s]; lastX[s] = x; lastY[s] = y;
        if (F.flags[s] & SIM_UF_SNAKE) {
            F.mode[s] = 0; F.amount[s] = 0; F.facing[s] = Math.atan2(vx, vy || 1); F.phase[s] = 0; F.prate[s] = 0;
            continue;
        }
        let mode = F.mode[s], amount = F.amount[s];
        if (mode === 0 && !(amount > 0)) {
            const rest = (time + P[6] - still[s]) / Math.max(1, rate) - P[7];
            if (rest > 0) { mode = 7; amount = Math.min(1, rest / P[8]); if (F.status[s] === 0) F.status[s] = 3; }
        }
        let fx = vx, fy = vy;
        if (Number.isFinite(targetX[s])) { fx = targetX[s] - x; fy = targetY[s] - y; }
        F.mode[s] = mode;
        F.amount[s] = Math.max(0, Math.min(1, amount || Math.min(1, Math.hypot(x - PREVX[u], y - PREVY[u]) / Math.max(.01, tile * .025)) || 0));
        F.facing[s] = Math.atan2(fx, fy || .0001) || 0;
        if (mode === 1) {
            const b = (8 - flash[s]) / 8;
            F.phase[s] = b >= 1 ? Math.PI : b <= -1 / 8 ? 0 : Math.max(0, b) * Math.PI;
            F.prate[s] = b >= 1 || b <= -1 / 8 ? 0 : Math.PI / 8;
        } else {
            const speed = mode === 2 ? 8 : mode === 4 ? 14 : mode === 7 ? 2 : 10;
            F.phase[s] = time / rate * speed + (ID[u] || 0) * 2.399; F.prate[s] = speed / rate;
        }
    }
};

// Visibility of one player (see computeVisibilityGridForPlayer, which this
// reproduces exactly on typed arrays). Params: W, H, TILE,
// AREA_UNIT_TILE_EQUIVALENT, area count. Arrays: vis.jobs (player, grid)
// pairs, vis.src (x, y, range) triples, vis.srcOff (offset, length) per
// player, vis.areaGrid, vis.nbOff/vis.nb (area neighbours), vis.cellOff/
// vis.cells (area tiles), vis.areaExists, and the output grid vis.g.<player>.<k>;
// [5] work words a job in vis.wk (0: the thread's scratch). Rust: k.rs
// k_visibility.
const _simVisW = new Map();
SIM_KERNELS[SIM_KERNEL_VISIBILITY] = function (R, P, chunk) {
    const J = R['vis.jobs'], name = 'vis.g.' + J[chunk * 2] + '.' + J[chunk * 2 + 1];
    let K = _simVisW.get(name);
    if (!K) _simVisW.set(name, K = _simWK([name, 'vis.src', 'vis.srcOff', 'vis.jobs', 'vis.areaGrid', 'vis.nbOff', 'vis.nb', 'vis.cellOff', 'vis.cells', 'vis.areaExists', '?vis.wk']));
    _simRust(K, P, chunk, 'k_visibility', 'VISIBILITY');
};


// The separation tier (unit.js separationStart): a chain on the helpers,
// started at the tick's start and collected after the unit pass, reading
// the tick-start copy (x0/y0, sepD0/sepR0/sepL0, written by
// SIM_KERNEL_STATUS) while the pass moves units:
//   SEP_PACK: each entry of the unit index packed (Float32 position and
//     radius in sep.qx / qy / qr: quantized positions are exact; sep.meta:
//     owner, layer << 8, bits << 16: 1 takes part, 2 moved by itself last
//     tick; sep.qid; sep.ord its slot or -1).
//   SEP_MARK: units at rest beside a chunk where one moved take part too.
//   SEP_PAIRS (twice: even bands of chunk rows, then odd): every touching
//     pair once, from the side of its first entry, the push of each side
//     that takes part summed into its slot (integers: the order of the sums
//     does not change them). Bands are P[2] rows high, at least the reach,
//     so two bands of one stage never write the same slot.
// Mark and pairs find a unit's neighbouring chunks' units through the
// entries alone (sorted by chunk key): per neighbouring row a cursor that
// only moves forward with the entry, so nothing of the chunk grid (a
// million chunks on a 1000 x 1000 map, most of them empty) is read.
// Each has a Rust twin (wasm/src/lib.rs: sep_pack, sep_mark, sep_pairs;
// longer runs of pairs four at a time with SIMD), the same results bit for
// bit: it runs when the arrays are in the wasm heap (see sim_wasm.js).
// Staggered (UNIT_SEPARATION_MODE 0): a unit takes part on its own ticks,
// (t + id) even (each unit's contacts 10 times a second;
// SIM_KERNEL_SEPARATION_FINISH spreads its push over that tick and the
// next); 1: every unit every tick; 2: every unit every other tick.
// P (PACK): [0] entries, [1] per job, [2] rest ticks, [3] tick, [4] mode.
// (P[5] 1: between ticks, from the live columns (x, y, dead, radii, layer:
// the next tick's start state) and the entries the unit index build listed.)
const _simSepPackW = [false, true].map(live => _simWK(['sep.eslot', live ? 'unit.x' : 'unit.x0', live ? 'unit.y' : 'unit.y0', live ? 'unit.dead' : 'unit.sepD0', 'unit.sepR0',
    live ? 'unit.sepLayer' : 'unit.sepL0', 'unit.collisionR', 'unit.r', 'unit.owner', 'unit.id', 'unit.sepMov',
    'sep.ord', 'sep.qx', 'sep.qy', 'sep.qr', 'sep.meta', 'sep.qid']));
SIM_KERNELS[SIM_KERNEL_SEP_PACK] = function (R, P, chunk) {
    const live = P[5] === 1, NL = live ? R['ix.listed'][0] | 0 : P[0] | 0, per = P[1] | 0;
    const mode = P[4] | 0, t0 = P[3] | 0, rest0 = P[2] | 0;
    if (_simWasmOk(R)) {
        const A = _simWPtrs(_simSepPackW[live ? 1 : 0]);
        if (A !== null) {
            _simWasmX.sep_pack(A[0], A[1], A[2], A[3], A[4], A[5], A[6], A[7], A[8], A[9], A[10], A[11], A[12], A[13], A[14], A[15], A[16],
                NL, per, rest0, t0, mode, live ? 1 : 0, chunk);
            return;
        }
    }
    _simNoWasm('SEP_PACK');
};
// P: [0] entries, [1] per job, [3] chunks across, [4] chunks down, [5]
// tick, [6] mode, [7] 1: the entries the index build listed. A chunk is
// one where a unit moved when an entry in it has the moved bit (empty and
// dead entries never do).
const _simSepMarkW = _simWK(['sep.meta', 'sep.ekey', 'sep.ord', 'sep.qid']);
SIM_KERNELS[SIM_KERNEL_SEP_MARK] = function (R, P, chunk) {
    const CW = P[3] | 0, CH = P[4] | 0, t0 = P[5] | 0, stag = (P[6] | 0) === 0, NL = P[7] === 1 ? R['ix.listed'][0] | 0 : P[0] | 0;
    if (_simWasmOk(R)) {
        const A = _simWPtrs(_simSepMarkW);
        if (A !== null) { _simWasmX.sep_mark(A[0], A[1], A[2], A[3], NL, P[1] | 0, CW, CH, t0, stag ? 1 : 0, chunk); return; }
    }
    _simNoWasm('SEP_MARK');
};
// P: [0] chunks across, [1] chunks down, [2] band rows, [3] pad, [4] farAny,
// [5] Q, [6] BOTH, [7] ONE, [9] listed entries, [10] chunk px, [11] index
// epoch, [12] MOVER, [13] YIELD, [14] band parity (job c: band 2c + it),
// [15] 1: the entries the index build listed.
// Every touching pair of units of the same layer, at least one taking part,
// once: found by the unit that takes part (both: the earlier entry), which
// looks at every chunk around it in reach. The units of a band of chunk
// rows look; a band's pushes reach P[2] (at least 2 * the reach) rows past
// it, so two bands of one stage never write the same slot.
const _simSepPairsW = _simWK(['sep.ord', 'sep.qx', 'sep.qy', 'sep.qr', 'sep.meta', 'sep.qid', 'sep.ekey', 'sep.px', 'sep.py', 'sep.ov', 'sep.hit']);
SIM_KERNELS[SIM_KERNEL_SEP_PAIRS] = function (R, P, chunk) {
    const CW = P[0] | 0, CH = P[1] | 0, H = P[2] | 0, pad = P[3], farAny = P[4], Q = P[5], BOTH = P[6], ONE = P[7];
    const listed = P[15] === 1 ? R['ix.listed'][0] | 0 : P[9] | 0, cws = P[10], ep = P[11] | 0, MOVER = P[12], YIELD = P[13];
    const band = chunk * 2 + (P[14] | 0), row0 = band * H, row1 = Math.min(CH, row0 + H);
    if (row0 >= CH) return;
    if (_simWasmOk(R)) {
        const A = _simWPtrs(_simSepPairsW);
        if (A !== null) {
            _simWasmX.sep_pairs(A[0], A[1], A[2], A[3], A[4], A[5], A[6], A[7], A[8], A[9], A[10],
                CW, CH, H, pad, farAny, Q, BOTH, ONE, listed, cws, MOVER, YIELD, P[14] | 0, chunk);
            return;
        }
    }
    _simNoWasm('SEP_PAIRS');
};


// ---- the pool (simulation worker) ----
let _simPool = null;

// Starts the helpers (simulation worker, with shared memory and 3+ cores).
function simParallelInit(helperUrl, maxHelpers = null) {
    // Helpers idle on Atomics.waitAsync (missing in some browsers, e.g. older
    // Firefox): without it the worker runs every chunk itself.
    if (_simPool || !SIM_PAR_SHARED || typeof Worker !== 'function' || typeof Atomics.waitAsync !== 'function') return 0;
    let cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
    // Start with roughly one simulation participant per physical core on an
    // SMT machine. Larger CPUs must not be permanently capped at 7 helpers;
    // the explicit override can use the other hardware threads as well.
    let n = Math.max(0, Math.ceil(cores / 2) - 1);
    if (Number.isFinite(maxHelpers)) n = Math.min(Math.max(0, cores - 2), Math.max(0, Math.floor(maxHelpers)));
    if (n < 1) return 0;
    let ctl = new Int32Array(new SharedArrayBuffer(SIM_PAR_CTL_WORDS * 4));
    for (let lane = 0; lane < SIM_PAR_BG_LANES; lane++) ctl[SIM_PAR_BG_BASE + lane * 8 + SIM_PAR_BG_ID] = -1;
    // (The wasm heap first: the helpers instantiate the kernels over it.)
    if (typeof simWasmInit === 'function') simWasmInit();
    let helpers = [];
    for (let i = 0; i < n; i++) {
        try {
            let w = new Worker(helperUrl);
            // A failed helper is not fatal (the worker takes its chunks): keep
            // its error from propagating up to the page's worker as well.
            w.onerror = e => { e.preventDefault(); console.error('[sim helper]', e.message || 'failed to load', e.filename ? `${e.filename}:${e.lineno}` : helperUrl); };
            const wasm = typeof simWasmHelperPayload === 'function' ? simWasmHelperPayload() : null;
            w.postMessage({ type: 'init', ctl, params: _simParams, bgParams: _simBgStageParams, bgChain: _simBgChain, index: i, wasm });
            for (let name in _simParReg) w.postMessage({ type: 'bind', name, arr: _simParReg[name], ver: _simParRegVer, wptr: _simParWPtr[name] ?? -1 });
            helpers.push(w);
        } catch (err) { break; }
    }
    if (!helpers.length) return 0;
    ctl[SIM_PAR_BG_CAP] = Math.max(1, helpers.length - 3);
    _simPool = { ctl, helpers };
    return helpers.length;
}

function simParallelHelpers() { return _simPool ? _simPool.helpers.length : 0; }

// Names an array for the kernels (and gives it to the helpers when new).
function simParallelBind(name, arr) {
    if (_simParReg[name] === arr) return;
    _simParReg[name] = arr;
    const wptr = _simParWPtr[name] = _simHeapPtrOf !== null ? _simHeapPtrOf(arr) : -1;
    _simParRegVer++; _simParBinds++;
    if (_simPool) for (let w of _simPool.helpers) w.postMessage({ type: 'bind', name, arr, ver: _simParRegVer, wptr });
}

// A wasm kernel's arrays by name ('?name': optional, address 0 when
// unbound): their addresses, cached until a binding changes, or null when
// one is not in the heap (the JS kernel runs).
function _simWK(names) {
    return { names: names.map(n => n.replace(/^\?/, '')), opt: names.map(n => n[0] === '?'), binds: -1, ok: false, ptrs: new Array(names.length).fill(0) };
}
function _simWPtrs(K) {
    if (K.binds !== _simParBinds) {
        K.binds = _simParBinds; K.ok = true;
        for (let i = 0; i < K.names.length; i++) {
            const nm = K.names[i];
            // (An optional array bound empty counts as unbound: e.g. no step costs.)
            if (!_simParReg[nm] || (K.opt[i] && _simParReg[nm].length === 0)) { if (K.opt[i]) { K.ptrs[i] = 0; continue; } K.ok = false; break; }
            const p = _simParWPtr[nm];
            if (!(p >= 0)) { K.ok = false; break; }
            K.ptrs[i] = p;
        }
    }
    return K.ok ? K.ptrs : null;
}
// The Rust kernel could not run (no module on this thread, or an array not in
// the wasm heap): the kernels are Rust only, so that is a bug, not a fallback.
function _simNoWasm(name) {
    throw new Error('SIM_KERNEL_' + name + ': the Rust kernel cannot run here (wasm module missing or an array outside the wasm heap)');
}
// A Rust kernel of wasm/src/k.rs over the arrays of K: their addresses into
// words 512.. of this thread's argument block (the movement kernels' words
// are below), the params P as doubles at byte 4096, then fn(block, chunk).
const SIM_RUST_W0 = 512;
function _simRust(K, P, chunk, fn, name) {
    const A = _simWPtrs(K);
    if (A === null || _simWasmArgI === null || _simWasmX === null) _simNoWasm(name);
    const I = _simWasmArgI;
    for (let i = 0; i < A.length; i++) I[SIM_RUST_W0 + i] = A[i];
    // (The thread's scratch: k.rs scratch().)
    I[1000] = _simWasmScratch; I[1001] = _simWasmScratchWords;
    _simWasmArgF.set(P.length > 64 ? P.subarray(0, 64) : P);
    _simWasmX[fn](_simWasmArgs, chunk);
}
// Whether a kernel call may run its Rust kernel (on the registry's arrays).
function _simWasmOk(R) { return _simWasmX !== null && _simWasmOn[0] === 1 && R === _simParReg; }

// The movement kernels' Rust twins (wasm/src/mv.rs: SIM_KERNEL_MOVE_STEP,
// SIM_KERNEL_MOVE, SIM_KERNEL_DRIVEBY) take their arrays in the thread's
// argument block: word i the address of _SIM_MOVE_WNAMES[i] (mv.rs W_*, the
// same order; '?' optional, 0 unbound), from word 160 eight per navigation
// profile (its build's fields, partL, partB, nb, nt, np, meta, its walls),
// then lengths (partL per profile at 250, area.off, wk.ver, nav.fmeta.0/1,
// the cover's players and stride at 262..267); the params P as doubles.
const _SIM_MOVE_WNAMES = ['unit.mvOn', 'unit.mvOut', 'unit.mvFlags', 'unit.id', 'unit.mvPath', 'unit.energy', 'unit.sepKey', 'unit.dead',
    'unit.owner', 'unit.x', 'unit.y', 'unit.prevX', 'unit.prevY', 'unit.mvFloor', 'mv.struct', 'unit.dead0', 'unit.mvWake', 'unit.wkWx', 'unit.wkWy',
    'unit.mvDest', 'unit.mvCD', 'unit.mvCT', 'unit.mvCVx', 'unit.mvCVy', 'unit.mvCTl', 'unit.mvCN', 'unit.vx', 'unit.vy', 'unit.mvSpent', 'mv.wall',
    'unit.spArea', 'unit.mvReach', 'mv.areaBox', 'mv.areaBoxOk', '?mv.hostile', 'unit.attackTimer', 'unit.dbT', 'unit.dbS', 'unit.dbTick', 'unit.mvWk',
    'unit.workerTransferCooldown', 'unit.mvFlow', 'unit.mvFGen', 'unit.mvReady', '?nav.fmeta.0', '?nav.fmeta.1', 'unit.mvNP', 'unit.mvSpd', 'unit.mvHT',
    'unit.mvHTId', 'unit.x0', 'unit.y0', 'unit.collisionR', 'unit.r', '?area.off', '?area.nb', '?vis.coverf', '?ix.agrid', 'unit.frozen', 'unit.sandy',
    'unit.cbT', 'unit.cbTick', 'unit.mvChs', 'unit.cbRange', '?wk.ver', 'unit.wkType', 'unit.wkD', 'unit.wkOx', 'unit.wkOy', 'unit.wkTwice',
    'unit.wkFail', 'unit.wkUntil', 'unit.wkSched', 'unit.mvHWin', 'unit.mvHTT', 'unit.mvHVer', 'unit.cbTId', 'unit.cbRangeS', 'unit.cbS',
    'unit.fLsX', 'unit.fLsY', 'unit.fLsPX', 'unit.fLsPY', 'unit.fLsT', 'unit.mvLane', '?mv.airwall', '?nav.frows.0', '?nav.frows.1', '?nav.fhdr',
    '?nav.fpool.0', '?nav.fpool.1', 'unit.mvNavT', 'unit.mvNavV', 'unit.mvNavW', 'unit.mvNavG', 'unit.mvNavD', 'unit.mvNavN1', 'unit.mvNavN2',
    'unit.mvNavFar', 'unit.mvNavOpen', 'unit.mvNavLD', 'unit.cwNear', 'unit.cwTick', 'unit.cwDense', '?mv.wallBlk9', 'unit.mvBase', 'unit.mvWlen',
    'unit.mvPlen', 'unit.mvScan', 'unit.mvNodes', 'unit.pathIndex', '?mv.post', '?mv.postc', 'unit.spEpoch', 'unit.spOwner', 'unit.spTile',
    'unit.spType', 'unit.vsGen', 'unit.spMvOld', 'unit.spMvNew', 'unit.spMvOwn', 'unit.mvBlk', '?mv.astarRem', '?mv.chFix', '?mv.chUse', 'unit.mvCost',
    'unit.commandState', 'unit.mvShoot', 'unit.mvReachD', 'unit.mvRangeK', 'unit.lzFlags', '?sep.rs', '?sep.rc', '?sep.rstamp', '?sep.eslot',
    '?ix.omask', '?mv.scls', '?mv.hstruct', 'unit.dbTI', 'unit.mvFire',
    'unit.atkCd', 'unit.attackFlash', '?mv.hita', '?mv.hitt', '?mv.hitc', 'unit.tmOn', 'unit.cmMode', 'unit.cmT', 'unit.cmTId', 'unit.sepLayer',
    '?unit.mvTgX', '?unit.mvTgY', '?unit.mvTgTol', '?unit.mvSteady', '?unit.wkLmt',
    // (The separation's finish, fused into the epilogue: mv.rs W_SPX...)
    '?sep.px', '?sep.py', '?sep.ov', '?sep.hit', '?unit.sepCx'];
// (From word 268, after the navigation profiles' words and their lengths.)
const _SIM_MOVE_WNAMES2 = ['?unit.sepCy', '?unit.sepMov', '?sep.nextX', '?sep.nextY', '?sep.fast', '?sep.ex', '?sep.exc', '?unit.mvPF'];
const _SIM_MOVE_NAV = 11, _SIM_MOVE_WNAV = 160, _SIM_MOVE_W2 = 268;
const _simMoveW = _simWK([..._SIM_MOVE_WNAMES, ...Array.from({ length: _SIM_MOVE_NAV * 8 }, (_, i) => {
    const p = i >> 3, j = i & 7;
    return '?' + (j < 7 ? 'nav.' + p + '.' + ['fields', 'partL', 'partB', 'nb', 'nt', 'np', 'meta'][j] : p === 0 ? 'mv.wall' : p === 1 ? 'mv.airwall' : 'mv.cwall.' + p);
}), ..._SIM_MOVE_WNAMES2]);
let _simMoveWFill = -1, _simMoveWArgs = 0;
// Fills the argument block for a movement kernel's Rust twin; false: the
// JavaScript kernel runs (no wasm, or an array not in the heap).
function _simMoveWasm(R, P) {
    if (!_simWasmOk(R) || _simWasmArgI === null) return false;
    const A = _simWPtrs(_simMoveW);
    if (A === null) return false;
    if (_simMoveWFill !== _simMoveW.binds || _simMoveWArgs !== _simWasmArgs) {
        const I = _simWasmArgI, nb = _SIM_MOVE_WNAMES.length;
        I.fill(0, 0, 299);
        for (let i = 0; i < nb; i++) I[i] = A[i];
        for (let i = 0; i < _SIM_MOVE_NAV * 8; i++) I[_SIM_MOVE_WNAV + i] = A[nb + i];
        for (let i = 0; i < _SIM_MOVE_WNAMES2.length; i++) I[_SIM_MOVE_W2 + i] = A[nb + _SIM_MOVE_NAV * 8 + i];
        for (let p = 0; p < _SIM_MOVE_NAV; p++) { const a = R['nav.' + p + '.partL']; I[250 + p] = a ? a.length : 0; }
        const len = nm => R[nm] ? R[nm].length : 0, COV = R['vis.cover'];
        I[262] = len('area.off'); I[263] = len('wk.ver'); I[264] = len('nav.fmeta.0'); I[265] = len('nav.fmeta.1');
        I[266] = COV ? COV.length : 0; I[267] = COV && COV[0] ? COV[0].length : 0;
        _simMoveWFill = _simMoveW.binds; _simMoveWArgs = _simWasmArgs;
    }
    _simWasmArgF.set(P);
    return true;
}

// Runs a kernel over chunks 0..total-1 (with the helpers when there are).
function simParallelRun(kernel, total) {
    let fn = SIM_KERNELS[kernel];
    let pool = _simPool;
    if (!pool || total <= 1) { _simParRunning++; try { for (let c = 0; c < total; c++) fn(_simParReg, _simParams, c); } finally { _simParRunning--; } return; }
    let ctl = pool.ctl;
    // Closed (odd) while this job is written; the last one's helpers leave.
    Atomics.add(ctl, SIM_PAR_GEN, 1);
    for (let a; (a = Atomics.load(ctl, SIM_PAR_ACTIVE)) !== 0;) Atomics.wait(ctl, SIM_PAR_ACTIVE, a, 5);
    ctl[SIM_PAR_KERNEL] = kernel; ctl[SIM_PAR_TOTAL] = total; ctl[SIM_PAR_DONE] = 0; ctl[SIM_PAR_REGVER] = _simParRegVer;
    Atomics.store(ctl, SIM_PAR_NEXT, 0);
    Atomics.add(ctl, SIM_PAR_GEN, 1);
    Atomics.notify(ctl, SIM_PAR_GEN);
    _simParRunning++;
    try {
        for (;;) {
            let c = Atomics.add(ctl, SIM_PAR_NEXT, 1);
            if (c >= total) break;
            fn(_simParReg, _simParams, c);
            Atomics.add(ctl, SIM_PAR_DONE, 1);
        }
    } finally { _simParRunning--; }
    for (let d; (d = Atomics.load(ctl, SIM_PAR_DONE)) < total;) Atomics.wait(ctl, SIM_PAR_DONE, d, 5);
    _simParCheckErr(ctl);
}

// ---- background jobs ----
// A kernel run whose result is needed later (the tick's separation, a
// navigation build's stages, the tiers): the helpers take its chunks
// whenever no foreground job waits for them (by lane priority), the
// simulation thread none until simParallelBackgroundWait, where it takes
// what is left and waits for the rest. Its inputs must stay as they are
// until then (the kernels are pure; its parameters are the lane's,
// simParallelStageParams, set by the caller before this). One per lane at a
// time: a new one waits for the lane's last. Without helpers it runs at the
// wait, the same result.
const _simBg = new Array(SIM_PAR_BG_LANES).fill(null);
// (Per lane: the first stage's job id of its current chain, and the next
// chain's: stages take consecutive ids.)
const _simBgIds = new Int32Array(SIM_PAR_BG_LANES), _simBgNextIds = new Int32Array(SIM_PAR_BG_LANES);
// (Per lane: chains posted so far. The wasm heap reuses a freed array once
// every chain in flight when it was freed is done: sim_wasm.js.)
const _simBgPosted = new Int32Array(SIM_PAR_BG_LANES);
function simParallelBackground(kernel, total, lane = 1) { simParallelBackgroundChain(lane, [[kernel, total]]); }
// The parameters of a lane's chain stage (stage 0: _simBgParamsByLane[lane]).
function simParallelStageParams(lane, stage) { return _simBgStageParams[lane][stage]; }
// A chain on one lane: stages [[kernel, total], ...] (at most
// SIM_PAR_BG_STAGES), each run once the one before is done, with its own
// parameters (simParallelStageParams). Stages of no chunks are left out.
// eager: without helpers, run now (a chain reading live state, which must
// not run later at its wait, after the state changed).
function simParallelBackgroundChain(lane, stages, eager = false) {
    simParallelBackgroundWait(lane);
    const list = stages.filter(st => st[1] > 0);
    if (!list.length) return;
    if (list.length > SIM_PAR_BG_STAGES) throw new Error('simParallelBackgroundChain: too many stages');
    // (Stage params by their place in the given list; a stage left out
    // keeps its slot.)
    const slots = [];
    for (let i = 0; i < stages.length; i++) if (stages[i][1] > 0) slots.push(i);
    const pool = _simPool;
    _simBg[lane] = { stages: list, slots, sync: !pool };
    _simBgPosted[lane]++;
    if (!pool) { if (eager) simParallelBackgroundWait(lane); return; }
    const ctl = pool.ctl, b = SIM_PAR_BG_BASE + lane * 8, CT = _simBgChain, cb = lane * (1 + 2 * SIM_PAR_BG_STAGES);
    _simBgClose(ctl, b, 0);
    CT[cb] = list.length;
    for (let i = 0; i < list.length; i++) { CT[cb + 1 + 2 * i] = list[i][0]; CT[cb + 2 + 2 * i] = list[i][1]; }
    // (The stage's params slot rides with the kernel: slot << 16 | kernel.)
    for (let i = 0; i < list.length; i++) CT[cb + 1 + 2 * i] = (slots[i] << 16) | list[i][0];
    ctl[b + SIM_PAR_BG_REGVER] = _simParRegVer;
    _simBgIds[lane] = _simBgNextIds[lane];
    _simBgNextIds[lane] = (_simBgIds[lane] + list.length) & 0x7F;
    _simBgOpen(ctl, b, CT, cb, 0, _simBgIds[lane]);
    // Idle helpers wake (no new foreground job: the generation stays even).
    Atomics.add(ctl, SIM_PAR_GEN, 2);
    Atomics.notify(ctl, SIM_PAR_GEN);
}
// Closes a lane (claims see id -1) and waits until no other participant is
// inside its claim section (`self`: the caller's own count, 0 or 1).
function _simBgClose(ctl, b, self) {
    Atomics.store(ctl, b + SIM_PAR_BG_ID, -1);
    for (let r; (r = Atomics.load(ctl, b + SIM_PAR_BG_READERS)) > self;) Atomics.wait(ctl, b + SIM_PAR_BG_READERS, r, 1);
}
// Opens stage `st` of the lane's chain under job id `id`.
function _simBgOpen(ctl, b, CT, cb, st, id) {
    Atomics.store(ctl, b + SIM_PAR_BG_KERNEL, CT[cb + 1 + 2 * st]);
    Atomics.store(ctl, b + SIM_PAR_BG_TOTAL, CT[cb + 2 + 2 * st]);
    Atomics.store(ctl, b + SIM_PAR_BG_DONE, 0);
    Atomics.store(ctl, b + SIM_PAR_BG_STAGE, st);
    Atomics.store(ctl, b + SIM_PAR_BG_NEXT, id << 24);
    Atomics.store(ctl, b + SIM_PAR_BG_ID, id);
}
// One claim on a lane by a participant (helper or simulation thread):
// runs a chunk of the open stage if one is left. Returns 1 when it ran one,
// 2 when the lane's chain is complete, 0 otherwise. The participant that
// finishes a stage's last chunk opens the next stage.
function _simBgClaim(ctl, lane, CT, paramsByStage) {
    const b = SIM_PAR_BG_BASE + lane * 8;
    Atomics.add(ctl, b + SIM_PAR_BG_READERS, 1);
    let out = 0;
    try {
        const id = Atomics.load(ctl, b + SIM_PAR_BG_ID);
        if (id < 0) return 0;
        const total = Atomics.load(ctl, b + SIM_PAR_BG_TOTAL), st = Atomics.load(ctl, b + SIM_PAR_BG_STAGE);
        const cb = lane * (1 + 2 * SIM_PAR_BG_STAGES), n = CT[cb];
        if (Atomics.load(ctl, b + SIM_PAR_BG_DONE) >= total) return st >= n - 1 ? 2 : 0;
        const v = Atomics.add(ctl, b + SIM_PAR_BG_NEXT, 1), c = v & 0xFFFFFF;
        if ((v >>> 24) !== id || c >= total) return 0;
        const kw = Atomics.load(ctl, b + SIM_PAR_BG_KERNEL);
        _simParRunning++;
        try { SIM_KERNELS[kw & 0xFFFF](_simParReg, paramsByStage[kw >>> 16], c); }
        catch (err) { if (typeof _simPool !== 'undefined' && _simPool) throw err; console.error('[sim helper] background kernel ' + (kw & 0xFFFF) + ' failed:', err && err.stack || err); Atomics.store(ctl, SIM_PAR_ERR, 1); }
        finally { _simParRunning--; }
        out = 1;
        if (Atomics.add(ctl, b + SIM_PAR_BG_DONE, 1) + 1 === total) {
            if (st + 1 < n) {
                // The next stage: once the lane is empty but for this claim.
                _simBgClose(ctl, b, 1);
                _simBgOpen(ctl, b, CT, cb, st + 1, (id + 1) & 0x7F);
                Atomics.add(ctl, SIM_PAR_GEN, 2);
                Atomics.notify(ctl, SIM_PAR_GEN);
            }
            Atomics.notify(ctl, b + SIM_PAR_BG_DONE);
        }
    } finally {
        Atomics.sub(ctl, b + SIM_PAR_BG_READERS, 1);
        Atomics.notify(ctl, b + SIM_PAR_BG_READERS);
    }
    return out;
}
function simParallelBackgroundWait(lane = 1) {
    const J = _simBg[lane];
    if (!J) return;
    _simBg[lane] = null;
    const views = _simBgStageParams[lane];
    if (J.sync) {
        for (let i = J.ran | 0; i < J.stages.length; i++) { const fn = SIM_KERNELS[J.stages[i][0]], P = views[J.slots[i]]; for (let c = 0; c < J.stages[i][1]; c++) fn(_simParReg, P, c); }
        return;
    }
    const ctl = _simPool.ctl, b = SIM_PAR_BG_BASE + lane * 8, last = J.stages.length - 1, id0 = _simBgIds[lane];
    // (The last stage's id: one more per stage.)
    const idLast = (id0 + last) & 0x7F;
    for (;;) {
        const r = _simBgClaim(ctl, lane, _simBgChain, views);
        if (r === 2) break;
        if (r === 1) continue;
        // Nothing to claim: the rest is running elsewhere (or a stage is
        // being opened).
        if (Atomics.load(ctl, b + SIM_PAR_BG_ID) === idLast && Atomics.load(ctl, b + SIM_PAR_BG_DONE) >= Atomics.load(ctl, b + SIM_PAR_BG_TOTAL)) break;
        const d = Atomics.load(ctl, b + SIM_PAR_BG_DONE);
        Atomics.wait(ctl, b + SIM_PAR_BG_DONE, d, 1);
    }
    // (Closed until the lane's next job: late claims leave at once.)
    _simBgClose(ctl, b, 0);
    _simParCheckErr(ctl);
}
function simParallelBackgroundPending(lane = 1) { return !!_simBg[lane]; }
// Waits until the lane's chain has finished its stages up to `stage` (by
// their place in the posted list, stages of no chunks counted as done),
// taking chunks of those meanwhile; the job stays posted (the rest runs on).
function simParallelBackgroundWaitStage(lane, stage) {
    const J = _simBg[lane];
    if (!J) return;
    // (The stage's place among the posted, non-empty stages.)
    let k = -1;
    for (let i = 0; i < J.slots.length; i++) if (J.slots[i] <= stage) k = i;
    if (k < 0) return;
    const views = _simBgStageParams[lane];
    if (J.sync) {
        for (let i = J.ran | 0; i <= k; i++) { const fn = SIM_KERNELS[J.stages[i][0]], P = views[J.slots[i]]; for (let c = 0; c < J.stages[i][1]; c++) fn(_simParReg, P, c); }
        J.ran = Math.max(J.ran | 0, k + 1);
        return;
    }
    if (k >= J.stages.length - 1) { simParallelBackgroundWait(lane); return; }
    const ctl = _simPool.ctl, b = SIM_PAR_BG_BASE + lane * 8, idAfter = (_simBgIds[lane] + k + 1) & 0x7F;
    for (;;) {
        // Done once the stage after it is open (its id), or later ones.
        const id = Atomics.load(ctl, b + SIM_PAR_BG_ID), st = Atomics.load(ctl, b + SIM_PAR_BG_STAGE);
        if (id >= 0 && st > k) break;
        if (id === idAfter) break;
        const r = _simBgClaim(ctl, lane, _simBgChain, views);
        if (r === 2) break;
        if (r === 1) continue;
        const d = Atomics.load(ctl, b + SIM_PAR_BG_DONE);
        Atomics.wait(ctl, b + SIM_PAR_BG_DONE, d, 1);
    }
}
// Whether the lane's job is complete (without waiting or taking chunks):
// for jobs whose result may be collected early.
function simParallelBackgroundDone(lane = 1) {
    const J = _simBg[lane];
    if (!J) return true;
    if (J.sync) return false;
    const ctl = _simPool.ctl, b = SIM_PAR_BG_BASE + lane * 8, idLast = (_simBgIds[lane] + J.stages.length - 1) & 0x7F;
    return Atomics.load(ctl, b + SIM_PAR_BG_ID) === idLast && Atomics.load(ctl, b + SIM_PAR_BG_DONE) >= Atomics.load(ctl, b + SIM_PAR_BG_TOTAL);
}

// ---- a helper's side (sim_helper.js) ----
function simParallelHelperMain() {
    let ctl = null, seen = 0, regVer = 0, bgParams = null, bgChain = null;
    // (A helper allocates nothing in the wasm heap: the simulation thread
    // owns it; anything made here is plain shared memory.)
    _simHeapAlloc = null; _simHeapAllocAuto = null;
    self.onmessage = ev => {
        let m = ev.data || {};
        if (m.type === 'init') {
            ctl = m.ctl;
            _simParHelperParams = m.params;
            bgParams = m.bgParams;
            bgChain = m.bgChain;
            if (m.wasm && typeof simWasmHelperInit === 'function') simWasmHelperInit(m.wasm);
            loop();
        } else if (m.type === 'bind') {
            _simParReg[m.name] = m.arr;
            _simParWPtr[m.name] = m.wptr >= 0 ? m.wptr : -1;
            _simParBinds++;
            if (m.ver > regVer) regVer = m.ver;
        }
    };
    // A task boundary (bind messages are handled between tasks).
    const channel = new MessageChannel();
    const nextTask = () => new Promise(res => { channel.port1.onmessage = () => res(); channel.port2.postMessage(0); });
    async function loop() {
        for (;;) {
            let r = Atomics.waitAsync(ctl, SIM_PAR_GEN, seen);
            if (r.async) await r.value;
            let g = Atomics.load(ctl, SIM_PAR_GEN);
            seen = g;
            if (g & 1) continue;   // being written
            Atomics.add(ctl, SIM_PAR_ACTIVE, 1);
            if (Atomics.load(ctl, SIM_PAR_GEN) === g && regVer >= ctl[SIM_PAR_REGVER]) {
                let fn = SIM_KERNELS[ctl[SIM_PAR_KERNEL]], total = ctl[SIM_PAR_TOTAL];
                for (;;) {
                    let c = Atomics.add(ctl, SIM_PAR_NEXT, 1);
                    if (c >= total) break;
                    try { fn(_simParReg, _simParHelperParams, c); }
                    catch (err) { console.error('[sim helper] kernel ' + ctl[SIM_PAR_KERNEL] + ' failed:', err && err.stack || err); Atomics.store(ctl, SIM_PAR_ERR, 1); }
                    Atomics.add(ctl, SIM_PAR_DONE, 1);
                    Atomics.notify(ctl, SIM_PAR_DONE);
                }
            }
            Atomics.sub(ctl, SIM_PAR_ACTIVE, 1);
            Atomics.notify(ctl, SIM_PAR_ACTIVE);
            // Missing arrays of the latest jobs: take the messages bringing them.
            let behind = regVer < ctl[SIM_PAR_REGVER];
            for (let lane = 0; lane < SIM_PAR_BG_LANES && !behind; lane++) behind = regVer < ctl[SIM_PAR_BG_BASE + lane * 8 + SIM_PAR_BG_REGVER];
            if (behind) await nextTask();
            // Background chunks while no foreground job is posted (checked
            // between chunks), by lane priority (SIM_PAR_BG_ORDER). A ticket
            // of another job (posted after this one's last chunk was taken)
            // is past its end.
            while (bgParams && Atomics.load(ctl, SIM_PAR_GEN) === seen) {
                let ran = false;
                for (let li = 0; li < SIM_PAR_BG_ORDER.length && !ran; li++) {
                    const lane = SIM_PAR_BG_ORDER[li];
                    const b = SIM_PAR_BG_BASE + lane * 8;
                    if (Atomics.load(ctl, b + SIM_PAR_BG_ID) < 0 || regVer < ctl[b + SIM_PAR_BG_REGVER]) continue;
                    // (A bulk lane: only while under its cap of helpers.)
                    const capped = lane === SIM_LANE_NAVX;
                    if (capped && Atomics.add(ctl, SIM_PAR_BG_RUN + lane, 1) >= Atomics.load(ctl, SIM_PAR_BG_CAP)) { Atomics.sub(ctl, SIM_PAR_BG_RUN + lane, 1); continue; }
                    try { ran = _simBgClaim(ctl, lane, bgChain, bgParams[lane]) === 1; }
                    finally { if (capped) Atomics.sub(ctl, SIM_PAR_BG_RUN + lane, 1); }
                }
                if (!ran) break;
            }
        }
    }
}
let _simParHelperParams = null;


// Same-owner same-type units around each due unit (things_utils.js
// _countNearbySameTypeUnits): the sum of its window of the per-type block
// counts (spatial.types). eff.win per due unit: x1, y1, x2, y2 (blocks),
// lane (-1: none). P: [0] due units, [1] per job, [2] blocks per row, [3]
// ints per block.
// Units' effective stats (things_utils.js recalculateUnitEffectiveStats):
// for the strided share (entry j: units[P[3] + j * P[2]]), from the columns,
// as _effStatsFullUnit does it: base stacks and level, the same-owner
// same-type count over its window of the spatial chunk counts, effective
// stacks and level. eff.flag[j]: 0 done, 1 done and its effective level
// changed (the caller applies its tables), 2 for the caller (no slot, base
// tables to make, no window or count), 3 nothing (dead, taken already).
// P: [0] entries, [1] per job, [2] step, [3] phase, [4] chunk px,
// [5]/[6] chunks wide/high, [7] type counts' stride per block, [8] unit
// types, [9] players, [15]/[16] type blocks wide / their size in chunks, [10] MAX_THING_LEVEL, [11] stamp (unit.esTaken); [12] the
// upkeep bins' players (0: no bins), [13] their levels + 1: a unit whose
// levels it wrote moves bins (unit.upB, upk.h; main.js _upkUnitBin).
const _simEffUnitsW = _simWK(['ix.slots', 'unit.dead', 'unit.esOk', 'unit.esRad', 'unit.esType', 'unit.esTaken', 'unit.stackCount', 'unit.unitLevel', 'unit.baseLevel',
    'unit.effectiveStacks', 'unit.effectiveLevel', 'unit._lastAppliedEffectiveLevel', 'unit.x', 'unit.y', 'unit.owner', 'spatial.types', 'eff.flag', '?unit.upT', '?unit.upB',
    '?upk.h', '?eff.tver', 'unit.esVer', 'unit.statRow', '?eff.rowOf', '?eff.rowVer', '?eff.rSpd', '?eff.rCost', '?eff.rRD', '?eff.rRA', '?eff.rRK', '?eff.rLzW',
    '?eff.rCb', '?eff.rCd', '?eff.rDmg', '?eff.rVis', '?eff.rChs', 'unit.mvOn', 'unit.mvFlags', 'unit.mvReach', 'unit.mvChs', 'unit.mvSpd', 'unit.mvCost',
    'unit.mvReachD', 'unit.mvReachA', 'unit.mvShoot', 'unit.mvRangeK', 'unit.lzFlags', 'unit.cbRange', 'unit.atkCd', 'unit.atkDmg', 'unit.spArea', 'unit.energy',
    'unit.maxE', '?mv.areaBoxOk']);
SIM_KERNELS[SIM_KERNEL_EFF_UNITS] = function (R, P, chunk) { _simRust(_simEffUnitsW, P, chunk, 'k_eff_units', 'EFF_UNITS'); };

// The units' visibility snapshot (renderer.js _visCoverUnits, a tier's
// input): per slot its position (vt.x, vt.y) and, for a live, indexed unit
// registered this generation with a range (vsGen = P[2], vsR steps), its
// key vt.key = steps | (vsP1 + 1) << 8 | (vsP2 + 1) << 16 (its player and a
// watching team), else -1.
// P: [0] slots, [1] per job, [2] coverage generation, [3] SIM_SEP_ABSENT.
const _simVisSnapW = _simWK(['unit.x', 'unit.y', 'unit.dead', 'unit.sepKey', 'unit.vsGen', 'unit.vsR', 'unit.vsP1', 'unit.vsP2', 'vt.x', 'vt.y', 'vt.key']);
SIM_KERNELS[SIM_KERNEL_VIS_SNAP] = function (R, P, chunk) { _simRust(_simVisSnapW, P, chunk, 'k_vis_snap', 'VIS_SNAP'); };

// Units' visibility seeds (renderer.js _visCoverUnits): every unit of the
// snapshot (vt.*, SIM_KERNEL_VIS_SNAP) with a key marks the areas under its
// +-0.3 tile window (vt.agrid: the area of each tile, -1 none) for its
// player and a watching team with the most steps per area:
// vis.useed[player * A + area] = stamp << 6 | steps (an older stamp is no
// seed). The first mark of an area this stamp lists it in vis.ulist (from
// player * A, vis.ucnt[player] entries, in no particular order).
// P: [0] slots, [1] per job, [2] TILE, [3]/[4] grid, [6] areas, [7]
// players, [8] stamp.
const _simVisSeedW = [false, true].map(live => _simWK([live ? 'unit.x' : 'vt.x', live ? 'unit.y' : 'vt.y', live ? '?vt.key' : 'vt.key', 'vis.useed', 'vis.ulist', 'vis.ucnt', 'vt.agrid',
    'unit.vsGen', 'unit.dead', 'unit.sepKey', 'unit.vsR', 'unit.vsP1', 'unit.vsP2']));
SIM_KERNELS[SIM_KERNEL_VIS_SEED] = function (R, P, chunk) { _simRust(_simVisSeedW[P[9] === 1 ? 1 : 0], P, chunk, 'k_vis_seed', 'VIS_SEED'); };
// Laser beams on units (tower.js laserBeamsTick): a unit on a tile of a
// beam (lz.head: per tile the first entry, lz.next / lz.beam: the tile's
// entries) of another owner (lz.bown) takes its damage (lz.bdmg, per tick)
// unless immune to towers (lzFlags 1); laser resistant (2) it lights the
// beam only. Each beam that lit marks lz.hit. The damage comes off its
// energy now (dead at none left); its record (flash, shrines, alert, a
// retaliation: lzEv 1) every P[6] ticks per unit by id or as it dies, the
// sum since (lzAcc, lzBeam the last beam). lz.count[chunk]: its reports.
// P: [0] slots, [1] per job, [2] TILE, [3]/[4] grid, [5] tick, [6] report
// period, [7] SIM_SEP_ABSENT.
const _simLaserHitsW = _simWK(['unit.x', 'unit.y', 'unit.dead', 'unit.sepKey', 'unit.owner', 'unit.energy', 'unit.id', 'unit.lzFlags', 'unit.lzAcc', 'unit.lzBeam', 'unit.lzEv',
    'lz.head', 'lz.next', 'lz.beam', 'lz.bown', 'lz.bdmg', 'lz.hit', 'lz.count']);
SIM_KERNELS[SIM_KERNEL_LASER_HITS] = function (R, P, chunk) { _simRust(_simLaserHitsW, P, chunk, 'k_laser_hits', 'LASER_HITS'); };

// The drive-by look (unit.js _driveByScan) of every moving shooter whose
// attack timer ran out, on its look tick ((tick + id) & 1), worked out on
// the helpers before the movement kernel (unit.js combatScanRun): the
// nearest (then lowest id) enemy unit listed in the tiles of the areas in
// its reach (mv.areaBox of its area, unit.mvReachD steps), its tile's area
// in sight, in its attack range (lzFlags 4, a whole range: within
// unit.mvRangeK area steps; else that or touching one further); none: the
// structure its look takes (mv.scls: turrets not cloud towers first, then
// traps, then any other), the nearest by its centre, then the lowest tile,
// hostile (mv.struct), in sight, within its range by areas. Writes unit.dbT
// / dbTI / dbS / dbTick (above); -2 where the range is beyond what the
// kernel works out (more than 2 area steps) or its area box is not made.
// P: [0] slots, [1] per job, [2] tick, [3]/[4] chunks wide/high, [5] TILE,
// [6] index stamp, [7] players, [8] CMD_MOVING, [9]/[10] grid, [11]
// CHUNK_SIZE, [12] SIM_SEP_ABSENT, [13] SIM_MOVE_BOX_STEPS, [14] contact
// padding, [15] block size (tiles), [16]/[17] blocks wide/high, [18] 1 when
// ix.omask is this tick's.
// The combat brain (a helper lane, chained after the acquisition scan; see
// BRAIN_OFF_MAIN_THREAD_PLAN.md): per unit of the snapshot (acq.*), its
// instruction: keep its target while alive and in sight, else take the
// scan's (acq.out); in its attack range by areas (any number of steps: a
// search over the area graph, here on the helpers) -> 1 hold, else 2 chase;
// none -> 0. acq.bm 255: no instruction (not the brain's unit).
// P: [0] slots, [1] per job, [2] CMD_IDLE, [3] CMD_ATTACK_MOVING, [4] TILE,
// [5]/[6] grid, [7] players, [8] areas.
const SIM_KERNEL_COMBAT_BRAIN = 62, SIM_KERNEL_COMBAT_COMMIT = 63;
const _simCombatBrainW = _simWK(['acq.x', 'acq.y', 'acq.own', 'acq.flags', 'acq.cmd', 'acq.id', 'acq.out', 'acq.cm', 'acq.ct', 'acq.ctid', 'acq.rk', 'acq.agrid', 'acq.cover',
    '?acq.aoff', '?acq.anb', 'acq.bm', 'acq.bt', 'acq.btid']);
SIM_KERNELS[SIM_KERNEL_COMBAT_BRAIN] = function (R, P, chunk) { _simRust(_simCombatBrainW, P, chunk, 'k_combat_brain', 'COMBAT_BRAIN'); };
// The brain's instructions into the units' columns at the commit tick (the
// same unit still in the slot, alive): O(1) a slot.
// P: [0] slots, [1] per job.
const _simCombatCommitW = _simWK(['acq.bm', 'acq.bt', 'acq.btid', 'acq.id', 'unit.id', 'unit.dead', 'unit.cmMode', 'unit.cmT', 'unit.cmTId']);
SIM_KERNELS[SIM_KERNEL_COMBAT_COMMIT] = function (R, P, chunk) { _simRust(_simCombatCommitW, P, chunk, 'k_combat_commit', 'COMBAT_COMMIT'); };
// Adjacency groups on a helper lane (things_utils.js adjacencyLaneStep):
// from the signature grid's snapshot (adj.sig: an id per operational
// structure's (owner, type) signature, -1 none), the groups (4-connected,
// equal signature, joined through paired cloud portals: adj.cloud [tile,
// partner tile or -1, owner] triples) reached from the dirty tiles
// (adj.seed, each with its 3x3), their member tiles in order (adj.otile,
// adj.ogrp the group), each group's size and area multiplier (adj.gsize,
// adj.gmul: each touched area whose cells all bear the group's signature
// multiplies it by cells^(level + 1)), and every touched area with whether
// it is uniform (adj.oarea, adj.oact). Counts in adj.ocnt [members, groups,
// areas]. One job (P: [0] W, [1] H, [2] seeds, [3] cloud triples, [4] areas;
// adj.wk its stamps, kept from run to run). Rust: k.rs k_adj_flood.
const SIM_KERNEL_ADJ_FLOOD = 64;
const _simAdjFloodW = _simWK(['adj.sig', 'adj.seed', 'adj.cloud', 'adj.ag', 'adj.coff', 'adj.ctile', 'adj.mul', 'adj.otile', 'adj.ogrp', 'adj.gsize', 'adj.gmul', 'adj.oarea',
    'adj.oact', 'adj.ocnt', 'adj.wk']);
SIM_KERNELS[SIM_KERNEL_ADJ_FLOOD] = function (R, P, chunk) { _simRust(_simAdjFloodW, P, chunk, 'k_adj_flood', 'ADJ_FLOOD'); };

// (Its candidates' list, per thread: slot and squared distance.)
const SIM_DB_CANDS = 64, _simDbCandQ = new Int32Array(SIM_DB_CANDS), _simDbCandD = new Float64Array(SIM_DB_CANDS);
SIM_KERNELS[SIM_KERNEL_DRIVEBY] = function (R, P, chunk) {
    const CMD = R['unit.commandState'], DEAD = R['unit.dead'], SEP = R['unit.sepKey'], AT = R['unit.attackTimer'], SHOOT = R['unit.mvShoot'];
    const ID = R['unit.id'], OWN = R['unit.owner'], X = R['unit.x'], Y = R['unit.y'], AREA = R['unit.spArea'], RD = R['unit.mvReachD'], RK = R['unit.mvRangeK'], LZF = R['unit.lzFlags'];
    const CRC = R['unit.collisionR'], RRC = R['unit.r'], X0 = R['unit.x0'], Y0 = R['unit.y0'];
    const AG = R['ix.agrid'], AOFF = R['area.off'], ANB = R['area.nb'], WALL = R['mv.wall'], AB = R['mv.areaBox'], ABOK = R['mv.areaBoxOk'], COV = R['vis.cover'];
    const rs = R['sep.rs'], rc = R['sep.rc'], rst = R['sep.rstamp'], es = R['sep.eslot'], OM = P[18] ? R['ix.omask'] : null;
    const SC = R['mv.struct'], SCLS = R['mv.scls'], HSS = R['mv.hstruct'], HS = R['mv.hostile'];
    const DBT = R['unit.dbT'], DBTI = R['unit.dbTI'], DBS = R['unit.dbS'], DBTK = R['unit.dbTick'];
    const t = P[2] | 0, CW = P[3] | 0, CH = P[4] | 0, tile = P[5], ep = P[6] | 0, players = P[7] | 0, cmdMove = P[8], W = P[9] | 0, H = P[10] | 0;
    const cs = P[11] | 0, absent = P[12], BOXSTEPS = P[13] | 0, pad = P[14], Bk = P[15] | 0, bc = P[16] | 0, br = P[17] | 0;
    const stride = bc + 1, plane = stride * (br + 1), half = tile / 2;
    if (!AG || !AOFF || !AB || !ABOK || !COV || !rs || !SC || !SCLS) return;
    // (Its Rust twin: wasm/src/mv.rs mv_driveby.)
    if (_simMoveWasm(R, P)) { const s0 = chunk * P[1]; _simWasmX.mv_driveby(_simWasmArgs, s0, Math.min(P[0], s0 + P[1])); return; }
    _simNoWasm('DRIVEBY');
};

// The worker search tier (worker.js workerSearchTierStep).
// SIM_KERNEL_WS_SELECT (the post, every slot chunk of P[1]): a registered
// worker (unit.wsKind, alive) due a search, the first post after it
// registered (within P[3] ticks) and then once in P[4] ticks ((tick + id) %
// P[4] < P[3]): its request at ws.r*[chunk * P[1] + m] (its registry's
// values; its origin where it stands without one or before unit.wsOU), how
// many at ws.rcnt[chunk]. P: [0] slots, [1] per job, [2] tick, [3] WS_TICKS,
// [4] retry ticks.
const _simWsSelectW = _simWK(['unit.wsKind', 'unit.wsCfg', 'unit.wsT', 'unit.wsOU', 'unit.wsOx', 'unit.wsOy', 'unit.wsR', 'unit.wsAx', 'unit.wsAy', 'unit.wsAk',
    'unit.wsNeed', 'unit.wsJid', 'unit.wsCur', 'unit.wsMy', 'unit.x', 'unit.y', 'unit.owner', 'unit.id', 'unit.dead',
    '?ws.rslot', '?ws.rid', '?ws.rwt', '?ws.rkind', '?ws.rowner', '?ws.rox', '?ws.roy', '?ws.rux', '?ws.ruy', '?ws.rr', '?ws.rak', '?ws.rax', '?ws.ray', '?ws.rgrp',
    '?ws.rneed', '?ws.rjid', '?ws.rcur', '?ws.rmy', 'ws.rcnt', '?ws.rpre']);
SIM_KERNELS[SIM_KERNEL_WS_SELECT] = function (R, P, chunk) { _simRust(_simWsSelectW, P, chunk, 'k_ws_select', 'WS_SELECT'); };
// SIM_KERNEL_WS_SCAN (a tier job, P[1] requests a job over the selected ones:
// request g the m-th of select chunk c, ws.rpre[c] <= g < ws.rpre[c + 1], at
// c * P[12] + m): its K best sites, best first (then lower site): ws.res the
// site (-1 none), ws.score its score. Within the radius of the origin and,
// with area steps, in an area within that many steps of the origin's window
// (as _isTargetWithinWorkerSearchArea).
//  Kind 1, a resource collector: the sites of its type's group (wsg<P[16 +
//   type]>.*: world place, site kind, owner or -1 any; by bucket of P[4]
//   tiles; spawners), the owner's own or anyone's, not reserved by another
//   worker of its type (wsw.resv; but its own, ws.rmy); score from the
//   anchor (or the group's nearest working spawner of the owner by tile
//   steps, then row, column, id; or the worker) plus 0.22 of the distance
//   from the origin, plus P[7] for a drop (site kind 0). The site: its index
//   in the group.
//  Kinds 3, 4 and 5, the work site grid (wsw.*): the owner's tiles offering
//   all of ws.rneed's bits (low byte; count index in the next, the
//   reservation bit above; kind 5, a researcher: the bits its owner's
//   research needs, P[24 + owner], 0 none), not reserved by a worker of the
//   type (but its own tile); score the distance, less TILE * 0.75 for its
//   current target's tile (ws.rcur) and plus _scoreWorkerTaskCandidate's
//   jitter for ws.rjid >= 0. The site: its tile. Kind 4, a healer: also its
//   owner's damaged units (wsh.*, P[13] an owner) by squared distance plus
//   0.08 of the squared distance from the worker, the best 3 in ws.ures.
// P: [0] requests, [1] per job, [2] K, [3] TILE, [4] bucket tiles, [5] owners
// (wsh.n), [7] drop penalty, [8]/[9] grid, [10] the work grid's 8x8 blocks
// wide, [11] select chunks, [12] slots a select chunk, [13] healer units an
// owner, [14] 1: requests by position, [15] areas. Rust: k.rs k_ws_scan.
const _simWsScanW = _simWK(['ws.rkind', 'ws.rowner', 'ws.rox', 'ws.roy', 'ws.rux', 'ws.ruy', 'ws.rr', 'ws.rak', 'ws.rax', 'ws.ray', 'ws.rgrp', 'ws.rneed', 'ws.rjid', 'ws.rcur', 'ws.rmy',
    'ws.rpre', 'ws.res', 'ws.score', '?ws.ures', '?ws.agrid', '?ws.aoff', '?ws.anb', '?wsh.x', '?wsh.y', '?wsh.a', '?wsh.n', '?wsw.flags', '?wsw.own', '?wsw.area', '?wsw.resv',
    '?wsg0.meta', '?wsg0.sx', '?wsg0.sy', '?wsg0.st', '?wsg0.so', '?wsg0.pgx', '?wsg0.pgy', '?wsg0.po', '?wsg0.pid', '?wsg0.px', '?wsg0.py', '?wsg0.bs', '?wsg0.bc', '?wsg0.bi', '?wsg1.meta', '?wsg1.sx', '?wsg1.sy', '?wsg1.st', '?wsg1.so', '?wsg1.pgx', '?wsg1.pgy', '?wsg1.po', '?wsg1.pid', '?wsg1.px', '?wsg1.py', '?wsg1.bs', '?wsg1.bc', '?wsg1.bi', '?wsg2.meta', '?wsg2.sx', '?wsg2.sy', '?wsg2.st', '?wsg2.so', '?wsg2.pgx', '?wsg2.pgy', '?wsg2.po', '?wsg2.pid', '?wsg2.px', '?wsg2.py', '?wsg2.bs', '?wsg2.bc', '?wsg2.bi', '?wsg3.meta', '?wsg3.sx', '?wsg3.sy', '?wsg3.st', '?wsg3.so', '?wsg3.pgx', '?wsg3.pgy', '?wsg3.po', '?wsg3.pid', '?wsg3.px', '?wsg3.py', '?wsg3.bs', '?wsg3.bc', '?wsg3.bi', '?wsg4.meta', '?wsg4.sx', '?wsg4.sy', '?wsg4.st', '?wsg4.so', '?wsg4.pgx', '?wsg4.pgy', '?wsg4.po', '?wsg4.pid', '?wsg4.px', '?wsg4.py', '?wsg4.bs', '?wsg4.bc', '?wsg4.bi', '?wsg5.meta', '?wsg5.sx', '?wsg5.sy', '?wsg5.st', '?wsg5.so', '?wsg5.pgx', '?wsg5.pgy', '?wsg5.po', '?wsg5.pid', '?wsg5.px', '?wsg5.py', '?wsg5.bs', '?wsg5.bc', '?wsg5.bi', '?wsg6.meta', '?wsg6.sx', '?wsg6.sy', '?wsg6.st', '?wsg6.so', '?wsg6.pgx', '?wsg6.pgy', '?wsg6.po', '?wsg6.pid', '?wsg6.px', '?wsg6.py', '?wsg6.bs', '?wsg6.bc', '?wsg6.bi', '?wsg7.meta', '?wsg7.sx', '?wsg7.sy', '?wsg7.st', '?wsg7.so', '?wsg7.pgx', '?wsg7.pgy', '?wsg7.po', '?wsg7.pid', '?wsg7.px', '?wsg7.py', '?wsg7.bs', '?wsg7.bc', '?wsg7.bi', '?wsw.cnt']);
SIM_KERNELS[SIM_KERNEL_WS_SCAN] = function (R, P, chunk) { _simRust(_simWsScanW, P, chunk, 'k_ws_scan', 'WS_SCAN'); };

// The units' upkeep bins made anew (main.js _upkUnitsBuild, after a
// resync), per block of P[1] units-array indices: a unit of an owner below
// P[2] with a type index (upT) below P[3] in its bin ((type * P[2] + owner)
// * (P[4] + 1) + its effective level as getUnitEffectiveLevel, 1..P[4]):
// upB its bin (-1 none), counted in upk.h (Atomics: integer counts).
const _simUpkeepW = _simWK(['ix.slots', 'unit.owner', 'unit.upT', 'unit.upB', 'unit.effectiveLevel', 'unit.unitLevel', 'unit.baseLevel', 'unit.stackCount', 'upk.h']);
SIM_KERNELS[SIM_KERNEL_UPKEEP] = function (R, P, chunk) { _simRust(_simUpkeepW, P, chunk, 'k_upkeep', 'UPKEEP'); };

// The healer candidates (worker.js healerCandidatesStep): per chunk of P[1]
// slots of a snapshot (hc.e energy, hc.m max energy, hc.o owner, hc.id, hc.l
// live, hc.d dead), per owner below P[2] the P[3] damaged (0 < energy <
// max) with the lowest (energy / max, id): hc.res their slots, best first
// (-1 none), hc.rat their ratios. P[0] slots.
const _simHealCandW = _simWK(['hc.e', 'hc.m', 'hc.o', 'hc.id', 'hc.l', 'hc.d', 'hc.res', 'hc.rat']);
SIM_KERNELS[SIM_KERNEL_HEAL_CAND] = function (R, P, chunk) { _simRust(_simHealCandW, P, chunk, 'k_heal_cand', 'HEAL_CAND'); };

// Merge the healer scan's chunk lists on the same background lane, one
// job per owner. P: [0] chunks, [1] owners, [2] candidate limit. Only the
// immutable posted inputs are read; the tick validates the final K slots.
const _simHealReduceW = _simWK(['hc.res', 'hc.rat', 'hc.id', 'hc.best', 'hc.bestRat']);
SIM_KERNELS[SIM_KERNEL_HEAL_REDUCE] = function (R, P, owner) { _simRust(_simHealReduceW, P, owner, 'k_heal_reduce', 'HEAL_REDUCE'); };

// Worker replies in canonical id order, prepared entirely from the posted
// request/results. No live columns: withdrawals/deaths are checked by the
// tick as it consumes its bounded share. P: chunks, chunk size, K, healer kind.
const _simWsOrderW = _simWK(['ws.rcnt', 'ws.rkind', 'ws.rid', 'ws.res', '?ws.ures', 'ws.order', 'ws.orderCount']);
SIM_KERNELS[SIM_KERNEL_WS_ORDER] = function (R, P, chunk) { _simRust(_simWsOrderW, P, chunk, 'k_ws_order', 'WS_ORDER'); };

// Tick-end lifecycle: clear movement outputs and list only dead units (or
// unbacked objects to check), in units-array order within each block.
// P: units count, block size, slot count. The tick visits the sparse list
// backwards, preserving death/bounty/win-condition ordering exactly.
const _simRetireW = _simWK(['ix.slots', 'unit.dead', 'unit.mvOut', 'retire.list', 'retire.count']);
SIM_KERNELS[SIM_KERNEL_UNIT_RETIRE] = function (R, P, chunk) { _simRust(_simRetireW, P, chunk, 'k_unit_retire', 'UNIT_RETIRE'); };

// The unit pass's candidates (main.js _forEachUnitInTickOrder): per block
// of P[1] units-array indices, those still needing their update (no slot,
// or a kernel output 0 or above 6: moved, parked and held ones are done),
// in index order at upd.cand[block * P[1]...], how many at upd.cnt[block].
// P: [0] units, [1] block size, [2] blocks per job.
const _simUpdCandW = _simWK(['ix.slots', 'unit.mvOut', 'unit.mvFire', 'upd.cand', 'upd.cnt']);
SIM_KERNELS[SIM_KERNEL_UPD_CAND] = function (R, P, chunk) { _simRust(_simUpdCandW, P, chunk, 'k_upd_cand', 'UPD_CAND'); };
// After the pass: units the kernel moved or held (outputs 1-9, 11, 12, not
// visited in the pass) whose energy ran out during it (a mine) are dead now,
// where they stood, as Unit.update would have left them at their turn.
// P: [0] slots, [1] per job.
const _simHeldDeadW = _simWK(['unit.mvOut', 'unit.energy', 'unit.dead', 'unit.x', 'unit.y', 'unit.prevX', 'unit.prevY']);
SIM_KERNELS[SIM_KERNEL_HELD_DEAD] = function (R, P, chunk) { _simRust(_simHeldDeadW, P, chunk, 'k_held_dead', 'HELD_DEAD'); };

// The units' cover of one player (chunk = player; renderer.js
// _visCoverUnits): from this stamp's seeds (vis.useed / ulist / ucnt; areas
// that exist, vt.aok), the steps spread over the area graph (vt.aoff /
// vt.anb, CSR), one less per neighbour; every area reached is covered. Then
// against the areas covered at the last run (vis.uprev, vis.uprevn; vis.ust
// 1 for those): newly covered ones listed in vis.uplus, no longer covered
// ones in vis.uminus (vis.udiff[2p], [2p + 1] entries, from player * A),
// for the simulation thread to count in the cover. Scratch per player:
// vis.urem (-1 between runs), vis.ubufB (seeds by steps), vis.ubufA /
// ubufC (level lists, in turn), vis.ucur.
// P: [0] areas, [1] players, [2] stamp.
const _simVisSpreadW = _simWK(['vis.useed', 'vis.ulist', 'vis.ucnt', 'vt.aok', 'vt.aoff', 'vt.anb', 'vis.urem', 'vis.ubufB', 'vis.ucur', 'vis.ubufA', 'vis.ubufC', 'vis.ust',
    'vis.uprev', 'vis.uprevn', 'vis.uplus', 'vis.uminus', 'vis.udiff']);
SIM_KERNELS[SIM_KERNEL_VIS_SPREAD] = function (R, P, chunk) { _simRust(_simVisSpreadW, P, chunk, 'k_vis_spread', 'VIS_SPREAD'); };


const _simEffCountW = _simWK(['eff.win', 'eff.out', 'spatial.types']);
SIM_KERNELS[SIM_KERNEL_EFF_COUNT] = function (R, P, chunk) { _simRust(_simEffCountW, P, chunk, 'k_eff_count', 'EFF_COUNT'); };

// The state hash's units (utils_snapshot.js snapTickHash): one slice of the
// units list, every hashed field from the columns (the object fields
// through their digest, unit.hObj), summed per region and listed per job;
// the list's order sum (wasm/src/k.rs k_snap_units). Then
// SIM_KERNEL_SNAP_MERGE (one job, on the caller): the jobs' lists into the
// tick's region sums, every region as a pair (k_snap_merge).
// One position of the units list in the state hash's order part.
function _snapOrderMix(i, id) {
    let h = Math.imul((i + 1) | 0, 2654435761) ^ Math.imul(((id | 0) + 0x3c6ef372) | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 15), 3266489917);
    return h ^ (h >>> 13);
}
const SIM_KERNEL_SNAP_MERGE = 65;
const _simSnapW = _simWK(['unit.live', 'unit.dead', 'unit.x', 'unit.y', 'unit.id', 'ix.slots', 'unit.owner', 'unit.vx', 'unit.vy', 'unit.energy', 'unit.commandState',
    'unit.attackTimer', 'unit.attackFlash', 'unit.teleportHideTicks', 'unit.poisoned', 'unit.burning', 'unit.frozen', 'unit.wet', 'unit.sandy', 'unit.watched',
    'unit.workerTransferCooldown', 'unit.stackCount', 'unit.unitLevel', 'unit.effectiveStacks', 'unit.effectiveLevel', 'unit.pathIndex', 'unit.hObj',
    'snap.pr', 'snap.ph', 'snap.nl', 'snap.nlh', 'snap.nu', 'snap.cc', 'snap.ord']);
SIM_KERNELS[SIM_KERNEL_SNAP_REGION] = function (R, P, chunk) { _simRust(_simSnapW, P, chunk, 'k_snap_units', 'SNAP_REGION'); };
const _simSnapMergeW = _simWK(['snap.pr', 'snap.ph', 'snap.cc', 'snap.racc', 'snap.rstamp', 'snap.rlist', 'snap.pout', 'snap.pres']);
SIM_KERNELS[SIM_KERNEL_SNAP_MERGE] = function (R, P, chunk) { _simRust(_simSnapMergeW, P, chunk, 'k_snap_merge', 'SNAP_MERGE'); };

// The status pre-pass (unit.js statusPrepassRun): for each unit (units[i]
// at slot ix.slots[i]) its position copied (unit.x0, y0), and if not dead,
// its status effects counted down and their
// damage dealt, then its attack timers counted down, as Unit.update did
// them. unit.stEv: 1 damaged (unit.stDot: how much), 2 its watch ended,
// 4 died; st.count[chunk]: the chunk's units with events. Damage over time
// is reported (event 1, for its flash and the shrines) every P[3] ticks per
// unit ((tick + id) % P[3] === 0, tick P[2]) and when it dies, as the sum
// since the last report (unit.stAcc): the same damage, its record later by
// at most P[3] - 1 ticks.
// P: [0] units, [1] per job, [2] tick, [3] report period.
const _simStatusW = _simWK(['ix.slots', 'unit.dead', 'unit.energy', 'unit.attackTimer', 'unit.attackFlash', 'unit.teleportHideTicks', 'unit.burning',
    'unit.burnTickDamage', 'unit.poisoned', 'unit.poisonTickDamage', 'unit.frozen', 'unit.iceTickDamage', 'unit.wet', 'unit.sandy', 'unit.watched', 'unit.stEv',
    'unit.stDot', 'st.count', 'unit.x', 'unit.y', 'unit.x0', 'unit.y0', 'unit.workerTransferCooldown', 'unit.stAcc', 'unit.id', 'unit.sepD0', 'unit.sepR0',
    'unit.sepL0', 'unit.collisionR', 'unit.r', 'unit.sepLayer', 'unit.stOn', 'unit.tmOn', '?st.list']);
SIM_KERNELS[SIM_KERNEL_STATUS] = function (R, P, chunk) { _simRust(_simStatusW, P, chunk, 'k_status', 'STATUS'); };

// Owners per tile of the unit index (ix.omask: bit p set when a unit of
// player p is listed there; dead units too). The entries are grouped by
// tile (sep.ekey); a job owns the runs that start in its range (finishing
// them past its end), so no two write one tile. P: [0] entries, [1] per job.
// (P[2] 1: the entries listed by this build, ix.listed, not P[0].)
const _simTileOwnersW = _simWK(['sep.eslot', 'sep.ekey', 'unit.owner', 'ix.omask', 'ix.listed']);
SIM_KERNELS[SIM_KERNEL_TILE_OWNERS] = function (R, P, chunk) { _simRust(_simTileOwnersW, P, chunk, 'k_tile_owners', 'TILE_OWNERS'); };

// The crowd flags (unit.js combatScanRun, every tick): for moving units
// near a group's destination or waiting, whether an idle or waiting unit of
// their owner stands beside them and how dense it is there (the movement
// kernel's and _followNavNode's arrival in a crowd). The search for enemy
// units is the acquisition tier's (SIM_KERNEL_ACQ_SCAN).
const _simCombatScanW = _simWK(['unit.mvOut', 'unit.commandState', 'unit.dead', 'unit.x', 'unit.y', 'unit.owner', 'unit.sepKey', 'sep.rs', 'sep.rc', 'sep.rstamp', 'sep.eslot',
    'unit.cwNear', 'unit.cwTick', 'unit.cwDense', 'unit.mvNavLD']);
SIM_KERNELS[SIM_KERNEL_COMBAT_SCAN] = function (R, P, chunk) { _simRust(_simCombatScanW, P, chunk, 'k_combat_scan', 'COMBAT_SCAN'); };

// The acquisition tier (unit.js _acqTierStep): the snapshot of what the
// scan reads, per slot (as at the tick it is taken: positions at the pass's
// start, owner, dead, absent from the index, command, aggro range, id, the
// result cleared (acq.out -2: not looked for); nothing of the movement
// kernel's arming (a peer may run without it). P: [0] slots, [1] per job,
// [2] SIM_SEP_ABSENT.
const _simAcqSnapW = _simWK(['unit.x0', 'unit.y0', 'unit.owner', 'unit.dead', 'unit.sepKey', 'unit.commandState', 'unit.cbRange', 'unit.id', 'unit.acqB', 'acq.tid', 'acq.sout',
    'acq.x', 'acq.y', 'acq.own', 'acq.flags', 'acq.cmd', 'acq.rng', 'acq.id', 'acq.out', 'unit.cmMode', 'unit.cmT', 'unit.cmTId', 'unit.isWk', 'unit.atkDmg', 'unit.mvRangeK',
    'acq.cm', 'acq.ct', 'acq.ctid', 'acq.rk']);
SIM_KERNELS[SIM_KERNEL_ACQ_SNAP] = function (R, P, chunk) { _simRust(_simAcqSnapW, P, chunk, 'k_acq_snap', 'ACQ_SNAP'); };
// The scan (a tier job on the helpers, over the snapshot alone): for each
// idle, attack-moving or attacking unit (the last for doAttacking's look of
// a unit attacking a structure it chose itself), the nearest enemy unit (not dead) within its
// aggro range whose area its player sees (acq.cover, players x areas),
// nearest first then lowest id: acq.out its slot (-1 none), acq.tid its id.
// The index (acq.rs / rc / rst / es, stamp P[6]) lists units by their tile;
// empty surroundings end at once (acq.hs: hostile structures and other
// players' units per block, summed-area). P: [0] slots, [1] per job, [3]/[4]
// chunks wide/high, [5] TILE, [6] index stamp, [7] players, [8] CMD_IDLE,
// [9] CMD_ATTACK_MOVING, [10] block size (tiles), [11]/[12] blocks wide/high,
// [14] CHUNK_SIZE, [15]/[16] grid, [18] CMD_ATTACKING, [20] areas.
// Idle and attack-moving units also get the structure their look would
// take (acq.sout: its tile, -1 none; _findAutoStructureTarget): of the
// classes (acq.scls: 1 turret, 2 trap, 3 barrack or spawner, 4 other
// building) the first with one, of that class the nearest whose tile is
// nearer than the range (by its centre), lowest tile first on a tie;
// hostile (acq.sown, see mv.struct) and in sight; the blocks around holding
// none (acq.hss) end it at once.
// (Its Rust twin: wasm/src/lib.rs acq_scan; the structure look skips
// sixteen empty tiles at a time.)
const _simAcqScanW = _simWK(['acq.scls', 'acq.sown', '?acq.hss', 'acq.sout', 'acq.x', 'acq.y', 'acq.own', 'acq.flags', 'acq.cmd', 'acq.rng', 'acq.id',
    'acq.out', 'acq.tid', 'acq.agrid', 'acq.cover', 'acq.hs', 'acq.rs', 'acq.rc', 'acq.rst', 'acq.es', 'acq.om', '?acq.omt',
    '?acq.ex', '?acq.ey', '?acq.eo', '?acq.ea', '?acq.eid']);
SIM_KERNELS[SIM_KERNEL_ACQ_SCAN] = function (R, P, chunk) {
    // (The commands as integers: the snapshot's column is Int32. P[21] 1:
    // acq.omt and the packed entries made by the job's first stage,
    // SIM_KERNEL_ACQ_OMT.)
    if (_simWasmOk(R) && (P[8] | 0) === P[8] && (P[9] | 0) === P[9] && (P[18] | 0) === P[18]) {
        const A = _simWPtrs(_simAcqScanW);
        if (A !== null) {
            _simWasmX.acq_scan(A[0], A[1], A[2], A[3], A[4], A[5], A[6], A[7], A[8], A[9], A[10], A[11], A[12], A[13], A[14], A[15], A[16], A[17], A[18], A[19], A[20],
                P[21] === 1 ? A[21] : 0, P[21] === 1 ? A[22] : 0, P[21] === 1 ? A[23] : 0, P[21] === 1 ? A[24] : 0, P[21] === 1 ? A[25] : 0, P[21] === 1 ? A[26] : 0,
                P[0] | 0, P[1] | 0, P[3] | 0, P[4] | 0, P[5], P[6] | 0, P[7] | 0, P[8], P[9], P[10] | 0, P[11] | 0, P[12] | 0, P[14] | 0, P[15] | 0, P[16] | 0, P[18], P[20] | 0,
                R['acq.cover'].length, P[22] === 1 ? 1 : 0, P[23] | 0, chunk);
            return;
        }
    }
    _simNoWasm('ACQ_SCAN');
};
// The scan's first stage, for its Rust twin (the JS scan reads neither):
// the owners per chunk transposed (acq.omt[tx * CH + ty] = acq.om[ty * CW
// + tx]: a ring's left and right columns are runs too), and each entry of
// the index packed in its order (acq.ex / ey its position, acq.eo its
// owner, acq.ea its area where its player looks it up, -1 when the scan
// passes it over (dead, empty, off the map, no area), acq.eid its id): a
// chunk's units read as one run, not by slot. P: [0] chunks wide, [1]
// high, [2] rows per job, [3] entries, [4] entries per job, [5] TILE, [6]
// / [7] grid.
const SIM_KERNEL_ACQ_OMT = 59;
const _simAcqOmtW = _simWK(['acq.om', 'acq.omt', 'acq.es', 'acq.x', 'acq.y', 'acq.own', 'acq.flags', 'acq.id', 'acq.agrid', 'acq.ex', 'acq.ey', 'acq.eo', 'acq.ea', 'acq.eid']);
SIM_KERNELS[SIM_KERNEL_ACQ_OMT] = function (R, P, chunk) {
    const CW = P[0] | 0, CH = P[1] | 0, per = P[2] | 0, y0 = chunk * per, y1 = Math.min(CH, y0 + per);
    const ne = P[3] | 0, eper = P[4] | 0, e0 = chunk * eper, e1 = Math.min(ne, e0 + eper), tile = P[5], GW = P[6] | 0, GH = P[7] | 0;
    if (_simWasmOk(R)) {
        const A = _simWPtrs(_simAcqOmtW);
        if (A !== null) {
            if (y0 < y1) _simWasmX.acq_omt(A[0], A[1], CW, CH, y0, y1);
            if (e0 < e1) _simWasmX.acq_pack(A[2], A[3], A[4], A[5], A[6], A[7], A[8], A[9], A[10], A[11], A[12], A[13], e0, e1, tile, GW, GH);
            return;
        }
    }
    _simNoWasm('ACQ_OMT');
};
// The structure an idle or attack-moving unit at (x, y) of player owner
// would take with its look at range r (see SIM_KERNEL_ACQ_SCAN): its tile or -1.
function _simAcqStructure(SCLS, SOWN, HSS, AG, COVF, cbase, owner, x, y, r, tile, GW, GH, B, bc, br, stride, plane) {
    const reach = Math.ceil(r / tile) + 1, ugx = Math.floor(x / tile), ugy = Math.floor(y / tile);
    const x0 = Math.max(0, ugx - reach), x1 = Math.min(GW - 1, ugx + reach), y0 = Math.max(0, ugy - reach), y1 = Math.min(GH - 1, ugy + reach);
    if (x0 > x1 || y0 > y1) return -1;
    if (HSS) {
        const bx0 = Math.floor(x0 / B), by0 = Math.floor(y0 / B), bx1 = Math.min(bc - 1, Math.floor(x1 / B)), by1 = Math.min(br - 1, Math.floor(y1 / B)), o = owner * plane;
        if (bx0 <= bx1 && by0 <= by1 && HSS[o + (by1 + 1) * stride + bx1 + 1] - HSS[o + by0 * stride + bx1 + 1] - HSS[o + (by1 + 1) * stride + bx0] + HSS[o + by0 * stride + bx0] <= 0) return -1;
    }
    const r2 = r * r, half = tile / 2;
    let bestC = 5, bestD = Infinity, best = -1;
    for (let gy = y0; gy <= y1; gy++) {
        const dy = gy * tile + half - y;
        for (let gx = x0, t = gy * GW + x0; gx <= x1; gx++, t++) {
            const cl0 = SCLS[t], cls = cl0 === 5 ? 1 : cl0;
            if (cls <= 0 || cls > bestC) continue;
            const code = SOWN[t];
            if (code === -1 || code === owner) continue;
            const dx = gx * tile + half - x, d2 = dx * dx + dy * dy;
            if (!(d2 < r2) || (cls === bestC && d2 >= bestD)) continue;
            const a = AG[t];
            if (!(a >= 0) || !(COVF[cbase + a] > 0)) continue;
            bestC = cls; bestD = d2; best = t;
        }
    }
    return best;
}
// The commit (at a fixed tick, every peer): each slot still holding the unit
// looked for takes the result: unit.cbT (slot, -1 none), cbTId (its id),
// cbRangeS (the range looked with), cbTick = P[2] (the commit tick, see
// _acqTierStep). P: [0] slots, [1] per job, [2] tick.
// The tick's hits on units (unit.js unitHitsResolve): hits ranked by their
// attackers' ids (hit.* by rank), grouped by target (hit.g: ranks, by
// target then rank; job j's groups hit.jb[j]..hit.jb[j + 1]). Per target in
// rank order, as _unitHitUnit: none once it has fallen; its energy, its
// statuses by the attack's style (hit.sty: 1 fire, 2 water, 3 ice, 4 poison),
// fallen at none left. hit.flag[rank]: 1 landed, 2 on an idle unit (a
// retaliation to look at); hit.shr: the energy lost per owner (fixed point,
// the shrines'), per job. P: [0] owners (shr stride), [1] fixed-point
// scale, [2] CMD_IDLE.
const SIM_KERNEL_HITS = 60;
const _simHitsW = _simWK(['hit.g', 'hit.jb', 'hit.q', 'hit.dmg', 'hit.sty', 'hit.flag', 'hit.shr', 'unit.energy', 'unit.dead', 'unit.owner', 'unit.commandState', 'unit.stOn',
    'unit.burning', 'unit.burnTickDamage', 'unit.wet', 'unit.frozen', 'unit.poisoned', 'unit.poisonTickDamage']);
SIM_KERNELS[SIM_KERNEL_HITS] = function (R, P, chunk) { _simRust(_simHitsW, P, chunk, 'k_hits', 'HITS'); };

const _simAcqCommitW = _simWK(['acq.out', 'acq.tid', 'acq.id', 'acq.rng', 'unit.id', 'acq.sout', 'unit.cbS', 'unit.cbT', 'unit.cbTick', 'unit.cbTId', 'unit.cbRangeS']);
SIM_KERNELS[SIM_KERNEL_ACQ_COMMIT] = function (R, P, chunk) { _simRust(_simAcqCommitW, P, chunk, 'k_acq_commit', 'ACQ_COMMIT'); };

// The unit index's keys (chunk.js _spatialIndexRebuildParallel): per units
// index, its chunk (every unit not dead, by the tile it stands on; others
// nChunks) and that tile's area (none: A), for the radix sorts.
// P as SIM_KERNEL_INDEX_COUNT's.
// The unit index from the sorted orders (chunk.js _spatialIndexRebuildParallel):
// per position in key order its unit's slot (and chunk), and where each key's
// range starts (stamped). P[14] 0: chunks (ix.ordC, ix.keys -> sep.eslot,
// sep.ekey, ix.start, ix.stamp), 1: areas (ix.ordA, ix.areas -> ix.aslot,
// ix.astart, ix.astamp). P: [0] units, [1] per job, [2] chunks, [3] areas,
// [15] epoch; ix.listed[k]: the first position past the valid keys.
const _simIxFillW = [_simWK(['ix.slots', 'ix.ordC', 'ix.keys', 'sep.eslot', 'sep.ekey', 'ix.start', 'ix.stamp', 'ix.listed', 'ix.eid', 'unit.id']),
    _simWK(['ix.slots', 'ix.ordA', 'ix.areas', 'ix.aslot', '?ix.none', 'ix.astart', 'ix.astamp', 'ix.listed', '?ix.none', 'unit.id'])];
SIM_KERNELS[SIM_KERNEL_INDEX_FILL] = function (R, P, chunk) { _simRust(_simIxFillW[P[14] === 1 ? 1 : 0], P, chunk, 'k_ix_fill', 'INDEX_FILL'); };
// Each key's count at the end of its range; for areas, the units of each
// owner too (counted by the range's first position). P as INDEX_FILL's, [4] players.
const _simIxRunsW = [_simWK(['ix.slots', 'ix.ordC', 'ix.keys', 'ix.start', 'ix.cnt', 'ix.listed', '?ix.aown', 'unit.owner']),
    _simWK(['ix.slots', 'ix.ordA', 'ix.areas', 'ix.astart', 'ix.acnt', 'ix.listed', 'ix.aown', 'unit.owner'])];
SIM_KERNELS[SIM_KERNEL_INDEX_RUNS] = function (R, P, chunk) { _simRust(_simIxRunsW[P[14] === 1 ? 1 : 0], P, chunk, 'k_ix_runs', 'INDEX_RUNS'); };

const _simIxKeysW = _simWK(['ix.slots', 'unit.x', 'unit.y', 'unit.dead', 'ix.agrid', 'ix.keys', 'ix.areas', 'ix.bad']);
SIM_KERNELS[SIM_KERNEL_INDEX_KEYS] = function (R, P, chunk) { _simRust(_simIxKeysW, P, chunk, 'k_ix_keys', 'INDEX_KEYS'); };
