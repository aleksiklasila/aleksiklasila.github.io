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
// count, done count, bindings version and ticket counter (job id << 24 |
// next chunk), at SIM_PAR_BG_BASE + lane * 8.
const SIM_PAR_BG_BASE = 8, SIM_PAR_BG_KERNEL = 0, SIM_PAR_BG_TOTAL = 1, SIM_PAR_BG_DONE = 2, SIM_PAR_BG_REGVER = 3, SIM_PAR_BG_NEXT = 4, SIM_PAR_BG_LANES = 6;
// The tiers: work that need not run at the tick's rate (20 per second) goes
// to a lane of its rate, 10, 5, 1 or 0.5 per second (a period of 2, 4, 20 or
// 40 ticks). A tier's job takes its inputs at a fixed tick (a snapshot made
// then, or arrays nothing changes until it is done), runs on the helpers
// while the ticks go on, and is committed by the simulation thread at a
// fixed later tick (simParallelBackgroundWait: normally done by then), the
// same ticks on every peer, so the result is the same wherever it ran.
// Helpers take the lanes in priority order (SIM_PAR_BG_ORDER): the tick's
// own, then the tiers fastest first, then the long jobs.
const SIM_LANE_TICK = 0, SIM_LANE_LONG = 1, SIM_LANE_T10 = 2, SIM_LANE_T5 = 3, SIM_LANE_T1 = 4, SIM_LANE_T05 = 5;
const SIM_PAR_BG_ORDER = [SIM_LANE_TICK, SIM_LANE_T10, SIM_LANE_T5, SIM_LANE_T1, SIM_LANE_T05, SIM_LANE_LONG];

// A typed array in shared memory when helpers may use it.
function simSharedArray(Type, n) {
    return SIM_PAR_SHARED ? new Type(new SharedArrayBuffer(Math.max(1, n) * Type.BYTES_PER_ELEMENT)) : new Type(n);
}

// Arrays by name and scalar parameters (the same objects in every thread).
const _simParReg = {};
let _simParRegVer = 0;
const _simParams = simSharedArray(Float64Array, 64);
// The background jobs' parameters, per lane (their own: foreground jobs
// rewrite _simParams). _simBgParams: lane 1 (long jobs), _simTickBgParams:
// lane 0 (the tick's).
const _simTickBgParams = simSharedArray(Float64Array, 64);
const _simBgParams = simSharedArray(Float64Array, 64);
const _simBgParamsByLane = [_simTickBgParams, _simBgParams];
// (The tiers' lanes: _simBgParamsByLane[SIM_LANE_T10] and on.)
for (let lane = 2; lane < SIM_PAR_BG_LANES; lane++) _simBgParamsByLane.push(simSharedArray(Float64Array, 64));

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
function simFlowLook(LC, s, refresh, tl, gx, gy, dk, Wd, Hd, WL, navVer, wv, fgen,
    nC, ncw, nnc, NH, NF, NB, NT, NP, df, doff, dbx, dby, dbw, dbh) {
    if (LC.mvNavT[s] === tl && LC.mvNavD[s] === dk && LC.mvNavG[s] === fgen && (!refresh || (LC.mvNavV[s] === navVer && LC.mvNavW[s] === wv))) return 1;
    let n1 = simNavStep(Wd, nC, ncw, nnc, NH, NF, NB, NT, NP, df, doff, dbx, dby, dbw, dbh, tl, dk);
    if (n1 < 0) return 0;
    let n2 = -1, far = n1, open = false;
    if (WL[n1]) {
        let aim = simNavStep(Wd, nC, ncw, nnc, NH, NF, NB, NT, NP, df, doff, dbx, dby, dbw, dbh, n1, dk);
        if (!(aim >= 0) || WL[aim]) aim = dk;
        n1 = simNavDetour(WL, Wd, Hd, gx, gy, aim);
        if (n1 < 0) return -1;
        far = n1;
    } else {
        if (Math.abs(n1 % Wd - gx) + Math.abs(((n1 - n1 % Wd) / Wd) - gy) !== 1) return -2;
        open = _simOpenBlock(WL, tl, Wd, Hd) && _simOpenBlock(WL, n1, Wd, Hd);
        let cur = n1;
        for (let k = 1; k < (open ? 6 : 2); k++) {
            const nx = simNavStep(Wd, nC, ncw, nnc, NH, NF, NB, NT, NP, df, doff, dbx, dby, dbw, dbh, cur, dk);
            if (nx < 0 || WL[nx]) break;
            if (k === 1) n2 = nx;
            if (!open || !_simOpenBlock(WL, nx, Wd, Hd)) break;
            far = cur = nx;
        }
    }
    LC.mvNavT[s] = tl; LC.mvNavD[s] = dk; LC.mvNavV[s] = navVer; LC.mvNavW[s] = wv; LC.mvNavG[s] = fgen;
    LC.mvNavN1[s] = n1; LC.mvNavN2[s] = n2; LC.mvNavFar[s] = far; LC.mvNavOpen[s] = open ? 1 : 0;
    return 1;
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
    const ox = ngx >= 0 && ngx < W, oy = ngy >= 0 && ngy < H;
    if (ox && oy && WL[ngy * W + ngx] === 0) return 0;
    if (ox && gy >= 0 && gy < H && WL[gy * W + ngx] === 0) return 2;
    if (oy && gx >= 0 && gx < W && WL[ngy * W + gx] === 0) return 1;
    return 3;
}
function simNavStep(W, C, cw, nc, hop, fields, nodeBase, nodeTile, nodePair, dfield, doff, bx, by, bw, bh, t, dest) {
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
    const cxi = (tx / C) | 0, cyi = (ty / C) | 0, cf = cyi * cw + cxi;
    const dx = dest % W, dy = (dest - dx) / W, ct = ((dy / C) | 0) * cw + ((dx / C) | 0);
    const e = hop[cf * nc + ct];
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

// Whether tile t's whole 3x3 block is open terrain (see _isTileBlockOpen).
function _simOpenBlock(WALL, t, W, H) {
    const x = t % W, y = (t - x) / W;
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return false;
    for (let yy = y - 1; yy <= y + 1; yy++) { const r = yy * W; if (WALL[r + x - 1] | WALL[r + x] | WALL[r + x + 1]) return false; }
    return true;
}

// Window node i of a unit (window at nb, path indices base..base+wl-1):
// its tile key, -2 when the window does not hold it.
function _simMoveNode(NODES, nb, base, wl, i) { return (i >= base && i < base + wl) ? NODES[nb + i - base] : -2; }
// Whether node i is roomy (see _isPathNodeRoomy): 1 yes, 0 no, -1 unknown.
function _simMoveRoomy(NODES, WALL, nb, base, wl, len, W, H, i) {
    if (i + 1 >= len) return 0;
    const k = _simMoveNode(NODES, nb, base, wl, i), nk = _simMoveNode(NODES, nb, base, wl, i + 1);
    if (k < 0 || nk < 0) return -1;
    const kx = k % W, ky = (k - kx) / W, nx = nk % W, ny = (nk - nx) / W;
    if (Math.abs(nx - kx) + Math.abs(ny - ky) !== 1) return 0;
    if (kx < 1 || ky < 1 || kx >= W - 1 || ky >= H - 1) return 0;
    for (let yy = ky - 1; yy <= ky + 1; yy++) { const r = yy * W; if (WALL[r + kx - 1] | WALL[r + kx] | WALL[r + kx + 1]) return 0; }
    return 1;
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
// unit.js _isTargetWithinUnitAttackAreaRange for unit s and unit q at
// (tx, ty) (s can attack: damage above 0): in range by areas (k steps), or
// touching one step beyond (reach: the bodies' radii and padding; no wall
// corner between their tiles). 1, 0, -1.
function _simUnitInAttackRange(AG, OFF, NB, WALL, CR, RR, W, H, tile, pad, s, q, x, y, tx, ty, k) {
    const r = _simInAreaRange(AG, OFF, NB, W, H, tile, x, y, tx, ty, k);
    if (r !== 0) return r;
    const rs = Math.max(0.1, CR[s] || RR[s] || 0.1), rq = Math.max(0.1, CR[q] || RR[q] || 0.1);
    const reach = rs + rq + pad, dx = tx - x, dy = ty - y;
    if (dx * dx + dy * dy > reach * reach) return 0;
    const ugx = Math.floor(x / tile), ugy = Math.floor(y / tile), tgx = Math.floor(tx / tile), tgy = Math.floor(ty / tile);
    const sx = tgx - ugx, sy = tgy - ugy;
    if (sx > 1 || sx < -1 || sy > 1 || sy < -1) return 0;
    if (sx !== 0 && sy !== 0) {
        const in1 = tgx >= 0 && tgx < W && ugy >= 0 && ugy < H, in2 = ugx >= 0 && ugx < W && tgy >= 0 && tgy < H;
        if ((!in1 || WALL[ugy * W + tgx]) && (!in2 || WALL[tgy * W + ugx])) return 0;
    }
    return _simInAreaRange(AG, OFF, NB, W, H, tile, x, y, tx, ty, k + 1);
}

// Whether a structure hostile to `owner` (mv.struct codes: -1 none, p
// owned by p alone, -2 hostile to all) may lie within distance r of (x, y):
// some tile holding one has a point that near (a structure stands inside its
// tile). Conservative for unit.js _findAutoStructureTarget, which only
// takes structures nearer than r.
// (Only tiles in an area its player sees, with the cover cov: its look
// takes visible structures only.)
function _simHostileStructNear(SC, W, H, tile, owner, x, y, r, cov, AG) {
    if (!(r > 0)) return false;
    const r2 = r * r;
    const gx0 = Math.max(0, Math.floor((x - r) / tile)), gx1 = Math.min(W - 1, Math.floor((x + r) / tile));
    const gy0 = Math.max(0, Math.floor((y - r) / tile)), gy1 = Math.min(H - 1, Math.floor((y + r) / tile));
    for (let gy = gy0; gy <= gy1; gy++) {
        const y0 = gy * tile, dy = y < y0 ? y0 - y : (y > y0 + tile ? y - y0 - tile : 0), ry = r2 - dy * dy;
        if (ry < 0) continue;
        for (let gx = gx0, k = gy * W + gx0; gx <= gx1; gx++, k++) {
            const c = SC[k];
            if (c === -1 || c === owner) continue;
            if (cov && AG) { const a = AG[k]; if (!(a >= 0) || !(cov[a] > 0)) continue; }
            const x0 = gx * tile, dx = x < x0 ? x0 - x : (x > x0 + tile ? x - x0 - tile : 0);
            if (dx * dx <= ry) return true;
        }
    }
    return false;
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
function _simDriveByAny(D, cov, s, owner, x, y, x0, y0, x1, y1, k, structs) {
    const cs = D.cs, CW = D.CW, W = D.W, H = D.H, tile = D.tile, AG = D.AG;
    if (!(cs > 0) || !(CW > 0)) return true;
    const foe = owner < 8 ? (0xFF ^ (1 << owner)) : 0xFF;
    const cx0 = Math.floor(x0 / cs), cy0 = Math.floor(y0 / cs), cx1 = Math.min(CW - 1, Math.floor(x1 / cs)), cy1 = Math.min(D.CH - 1, Math.floor(y1 / cs));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        const ck = cy * CW + cx;
        if (D.rst[ck] !== D.ep || (D.OM && (D.OM[ck] & foe) === 0)) continue;
        for (let e = D.rs[ck], e1 = e + D.rc[ck]; e < e1; e++) {
            const q = D.es[e];
            if (q < 0 || D.DEAD[q] || (D.OWN[q] | 0) === owner) continue;
            const tx = D.X0[q], ty = D.Y0[q], qgx = Math.floor(tx / tile), qgy = Math.floor(ty / tile);
            if (qgx < x0 || qgy < y0 || qgx > x1 || qgy > y1) continue;
            const a = AG[qgy * W + qgx];
            if (!(a >= 0) || !(cov[a] > 0)) continue;
            if (_simUnitInAttackRange(AG, D.AOFF, D.ANB, D.WALL, D.CRC, D.RRC, W, H, tile, D.pad, s, q, x, y, tx, ty, k) !== 0) return true;
        }
    }
    if (!structs) return false;
    const SC = D.SC, half = tile / 2;
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0, t = gy * W + x0; gx <= x1; gx++, t++) {
        const c = SC[t];
        if (c === -1 || c === owner) continue;
        const a = AG[t];
        if (!(a >= 0) || !(cov[a] > 0)) continue;
        if (_simInAreaRange(AG, D.AOFF, D.ANB, W, H, tile, x, y, gx * tile + half, gy * tile + half, k) !== 0) return true;
    }
    return false;
}

// Flow movement between steers (SIM_STEER_TICKS), the common case of the
// movement kernel on its own (run just before it, the same parameters): a
// flow unit off its steer tick with a committed step, whose every per-tick
// check passes as SIM_KERNEL_MOVE's would (alive, indexed, on the map, its
// floor, a drive-by shooter's look, its field and route, not on its
// destination tile), takes the step exactly as SIM_KERNEL_MOVE would and is
// stamped (mvStepT = tick + 1, which SIM_KERNEL_MOVE skips). Anything else is
// left untouched for SIM_KERNEL_MOVE (which decides it the same way).
SIM_KERNELS[SIM_KERNEL_MOVE_STEP] = function (R, P, chunk) {
    const ON = R['unit.mvOn'], OUT = R['unit.mvOut'], FL = R['unit.mvFlags'], ID = R['unit.id'], DEST = R['unit.mvDest'];
    const CD = R['unit.mvCD'], CTK = R['unit.mvCT'], CVX = R['unit.mvCVx'], CVY = R['unit.mvCVy'], STEPT = R['unit.mvStepT'], CTL = R['unit.mvCTl'], CN = R['unit.mvCN'];
    const EN = R['unit.energy'], SEP = R['unit.sepKey'], DEADC = R['unit.dead'], OWN = R['unit.owner'];
    const X = R['unit.x'], Y = R['unit.y'], PX = R['unit.prevX'], PY = R['unit.prevY'], VX = R['unit.vx'], VY = R['unit.vy'];
    const FLOOR = R['unit.mvFloor'], SC = R['mv.struct'], SPENT = R['unit.mvSpent'], WALL = R['mv.wall'];
    const AREA = R['unit.spArea'], REACH = R['unit.mvReach'], AB = R['mv.areaBox'], ABOK = R['mv.areaBoxOk'], HS = R['mv.hostile'];
    const AT = R['unit.attackTimer'], DBT = R['unit.dbT'], DBS = R['unit.dbS'], DBTK = R['unit.dbTick'];
    const WK = R['unit.mvWk'], WTC = R['unit.workerTransferCooldown'], FLOWC = R['unit.mvFlow'], MFGEN = R['unit.mvFGen'], RDY = R['unit.mvReady'];
    const FMN = R['nav.fmeta.0'], FMW = R['nav.fmeta.1'];
    const t = P[2] | 0, tr = P[3] | 0, W = P[5] | 0, H = P[6] | 0, tile = P[7], q = P[8];
    // (x * itile for x / tile, n * iq for n / q: the same for powers of two.)
    const itile = 1 / tile, iq = 1 / q;
    const bc = P[9] | 0, br = P[10] | 0, players = P[11] | 0, B = P[14], absent = P[15], BOXSTEPS = P[17] | 0, wcheck = P[21] | 0, acqT = Math.max(1, P[38] | 0);
    const stride = bc + 1, plane = stride * (br + 1), ST = SIM_STEER_TICKS;
    const D0 = R['unit.dead0'], WAKE = R['unit.mvWake'], WKWX = R['unit.wkWx'], WKWY = R['unit.wkWy'], WKWATCH = Math.max(1, P[29] | 0);
    for (let s = chunk * P[1], end = Math.min(P[0], s + P[1]); s < end; s++) {
        D0[s] = DEADC[s];
        const on = ON[s];
        // A parked unit before its wake tick: stands (its floor and, on its
        // acquisition ticks, its look are SIM_KERNEL_MOVE's).
        if (on === 2) {
            const f = FL[s], id = ID[s] | 0;
            if (t >= WAKE[s] || (f & 1) !== 0 || ((f & 16) !== 0 && (((t + id) % acqT) === 0 || ((t + id) & 3) === 0))) continue;
            if ((f & 4) && ((t + id) % WKWATCH) === 0 && (X[s] !== WKWX[s] || Y[s] !== WKWY[s])) continue;
            if (!(EN[s] > 0) || SEP[s] === absent || DEADC[s]) continue;
            const owner = OWN[s] | 0, x = X[s], y = Y[s], gx = Math.floor(x * itile), gy = Math.floor(y * itile);
            if (!(owner >= 0 && owner < players) || !(gx >= 0 && gy >= 0 && gx < W && gy < H)) continue;
            const tl = gy * W + gx;
            if (FLOOR[s] !== tl || ((t + id) | 0) % tr === 0) {
                const code = SC[tl];
                if (code !== -1 && code !== owner) continue;
                FLOOR[s] = tl;
            }
            PX[s] = x; PY[s] = y; OUT[s] = 1; STEPT[s] = t + 1;
            continue;
        }
        if (on !== 1) continue;
        const f = FL[s];
        if ((f & 64) === 0) continue;
        const id = ID[s] | 0, dk = DEST[s];
        if (CD[s] !== dk || t - CTK[s] >= CN[s]) continue;
        if (!(EN[s] > 0) || SEP[s] === absent || DEADC[s]) continue;
        const owner = OWN[s] | 0, x = X[s], y = Y[s], gx = Math.floor(x * itile), gy = Math.floor(y * itile);
        if (!(owner >= 0 && owner < players) || !(gx >= 0 && gy >= 0 && gx < W && gy < H)) continue;
        const tl = gy * W + gx;
        if (tl === dk || tl !== CTL[s]) continue;
        if (FLOOR[s] !== tl || ((t + id) | 0) % tr === 0) {
            const code = SC[tl];
            if (code !== -1 && code !== owner) continue;
        }
        // (An attack-mover's look: its acquisition ticks only, the main
        // kernel's; a drive-by shooter's on its even ticks, as there.)
        if ((f & 16) !== 0) { if (((t + id) % acqT) === 0 || ((t + id) & 3) === 0) continue; }
        else if ((f & 1) !== 0 && ((t + id) & 1) === 0 && !(AREA[s] >= 0)) continue;
        else if ((f & 1) !== 0 && ((t + id) & 1) === 0 && !(AT[s] > 0) && DBTK[s] === t && DBT[s] !== -2) { if (DBT[s] !== -1 || DBS[s] >= 0) continue; }
        else if ((f & 1) !== 0 && ((t + id) & 1) === 0 && !(AT[s] > 0)) {
            const area = AREA[s], k = area * BOXSTEPS + REACH[s];
            if (!ABOK[k]) continue;
            let x0 = AB[k * 4], y0 = AB[k * 4 + 1], x1 = AB[k * 4 + 2], y1 = AB[k * 4 + 3];
            x0 = x0 < 0 ? 0 : x0; y0 = y0 < 0 ? 0 : y0; x1 = x1 >= W ? W - 1 : x1; y1 = y1 >= H ? H - 1 : y1;
            if (x0 <= x1 && y0 <= y1) {
                const bx0 = Math.floor(x0 / B), by0 = Math.floor(y0 / B), bx1 = Math.floor(x1 / B), by1 = Math.floor(y1 / B), o = owner * plane;
                const i11 = o + (by1 + 1) * stride + bx1 + 1, i01 = o + by0 * stride + bx1 + 1, i10 = o + (by1 + 1) * stride + bx0, i00 = o + by0 * stride + bx0;
                if (HS[i11] - HS[i01] - HS[i10] + HS[i00] > 0 && !(AT[s] > 0) && (DBTK[s] !== t || DBT[s] !== -1 || DBS[s] >= 0)) continue;
            }
        }
        if (WK[s] && ((t + id) | 0) % wcheck === 0 && !(WTC[s] > 0)) continue;
        const fid = FLOWC[s], wide = fid >= 4194304, did = wide ? fid - 4194304 : fid, dm = did * 8, FMETA = wide ? FMW : FMN;
        if (!(fid >= 0) || !FMETA || FMETA[dm + 6] !== MFGEN[s] || FMETA[dm + 1] !== dk || FMETA[dm + 7] !== 1) continue;
        if (t < RDY[s]) continue;
        // The step (as SIM_KERNEL_MOVE's between steers).
        let vx = CVX[s], vy = CVY[s];
        const sgx = Math.floor((x + vx) * itile), sgy = Math.floor((y + vy) * itile);
        if ((f & 32) === 0 && (sgx !== gx || sgy !== gy)) {
            const sl = simFlowSlide(WALL, W, H, gx, gy, sgx, sgy);
            if (sl) { if (sl & 1) vx = 0; if (sl & 2) vy = 0; CD[s] = -1; }
        }
        const nx = x + vx, ny = y + vy;
        PX[s] = x; PY[s] = y; VX[s] = vx; VY[s] = vy; SPENT[s] = Math.floor(nx * itile) !== gx || Math.floor(ny * itile) !== gy ? 1 : 0; FLOOR[s] = tl;
        const qx = Number.isFinite(nx) ? Math.round(nx * q) * iq : 0, qy = Number.isFinite(ny) ? Math.round(ny * q) * iq : 0;
        X[s] = qx; Y[s] = qy;
        OUT[s] = Math.floor(qx * itile) !== gx || Math.floor(qy * itile) !== gy ? 3 : 1;
        STEPT[s] = t + 1;
    }
};

SIM_KERNELS[SIM_KERNEL_MOVE] = function (R, P, chunk) {
    const ON = R['unit.mvOn'], OUT = R['unit.mvOut'], FL = R['unit.mvFlags'];
    const SPD = R['unit.mvSpd'], LANE = R['unit.mvLane'], SPENT = R['unit.mvSpent'], REACH = R['unit.mvReach'];
    const BASE = R['unit.mvBase'], WLEN = R['unit.mvWlen'], PLEN = R['unit.mvPlen'], SCAN = R['unit.mvScan'], FLOOR = R['unit.mvFloor'];
    const NODES = R['unit.mvNodes'], AREA = R['unit.spArea'], WAKE = R['unit.mvWake'], DEADC = R['unit.dead'];
    const FLOWC = R['unit.mvFlow'], MFGEN = R['unit.mvFGen'], DEST = R['unit.mvDest'];
    const AIRW = R['mv.airwall'];
    const NF0 = R['nav.0.fields'], NH0 = R['nav.0.hop'], NB0 = R['nav.0.nb'], NT0 = R['nav.0.nt'], NP0 = R['nav.0.np'], NM0 = R['nav.0.meta'];
    const NF1 = R['nav.1.fields'], NH1 = R['nav.1.hop'], NB1 = R['nav.1.nb'], NT1 = R['nav.1.nt'], NP1 = R['nav.1.np'], NM1 = R['nav.1.meta'];
    const FPN = R['nav.fpool.0'], FMN = R['nav.fmeta.0'], FPW = R['nav.fpool.1'], FMW = R['nav.fmeta.1'], RDY = R['unit.mvReady'];
    const NVT = R['unit.mvNavT'], NVV = R['unit.mvNavV'], NVW = R['unit.mvNavW'], NVG = R['unit.mvNavG'];
    const HT = R['unit.mvHT'], HTID = R['unit.mvHTId'], X0 = R['unit.x0'], Y0 = R['unit.y0'], CRC = R['unit.collisionR'], RRC = R['unit.r'];
    const AOFF = R['area.off'], ANB = R['area.nb'];
    const AT = R['unit.attackTimer'], COV = R['vis.cover'], AG = R['ix.agrid'];
    // (Speed: halved while frozen, again while sandy, as in Unit.update.)
    const FRZ = R['unit.frozen'], SND = R['unit.sandy'], NLD = R['unit.mvNavLD'];
    const CD = R['unit.mvCD'], CTK = R['unit.mvCT'], CVX = R['unit.mvCVx'], CVY = R['unit.mvCVy'], CTL = R['unit.mvCTl'], CN = R['unit.mvCN'];
    const NVN1 = R['unit.mvNavN1'], NVN2 = R['unit.mvNavN2'], NVF = R['unit.mvNavFar'], NVO = R['unit.mvNavOpen'];
    const LC = { mvNavT: NVT, mvNavD: R['unit.mvNavD'], mvNavV: NVV, mvNavW: NVW, mvNavG: NVG, mvNavN1: NVN1, mvNavN2: NVN2, mvNavFar: NVF, mvNavOpen: NVO };
    const X = R['unit.x'], Y = R['unit.y'], PX = R['unit.prevX'], PY = R['unit.prevY'], VX = R['unit.vx'], VY = R['unit.vy'];
    const EN = R['unit.energy'], OWN = R['unit.owner'], ID = R['unit.id'], PIDX = R['unit.pathIndex'], SEP = R['unit.sepKey'];
    const HS = R['mv.hostile'], SC = R['mv.struct'], WALL = R['mv.wall'], AB = R['mv.areaBox'], ABOK = R['mv.areaBoxOk'];
    // This tick's combat scan (run before this kernel: the nearest enemy unit
    // in aggro range or -1, cbTick = t) and hostile structures alone (summed
    // area, as mv.hostile).
    const CBT = R['unit.cbT'], CBTK = R['unit.cbTick'], HSS = R['mv.hstruct'], CHS = R['unit.mvChs'], RNG = R['unit.cbRange'];
    // (The combat scan's crowd flag: arriving in a crowd, flow mode.)
    const CWN = R['unit.cwNear'], CWT = R['unit.cwTick'], CWD = R['unit.cwDense'];
    // Drive-by looks (_simDriveByAny): the unit index by chunk.
    const DB = R['sep.rs'] && R['sep.rc'] && R['sep.rstamp'] && R['sep.eslot'] ? {
        rs: R['sep.rs'], rc: R['sep.rc'], rst: R['sep.rstamp'], es: R['sep.eslot'], OM: P[37] ? R['ix.omask'] : null,
        ep: P[33] | 0, CW: P[34] | 0, CH: P[35] | 0, cs: P[36] | 0, DEAD: DEADC, OWN, X0, Y0, AG, AOFF, ANB, WALL, CRC, RRC,
        W: P[5] | 0, H: P[6] | 0, tile: P[7], pad: P[20], SC } : null;
    const RK = R['unit.mvRangeK'];
    // Parked idle workers' version checks (worker.js _workerWorkHash): the
    // table, its layout (P[22..27]) and the healer candidates' generation (P[28]).
    const WKV = R['wk.ver'], WKTY = R['unit.wkType'], WKD = R['unit.wkD'], WKOX = R['unit.wkOx'], WKOY = R['unit.wkOy'], WKTW = R['unit.wkTwice'];
    const WKF = R['unit.wkFail'], WKU = R['unit.wkUntil'], WKSC = R['unit.wkSched'];
    const WKNP = P[22] | 0, WKTYPES = P[23] | 0, WKRW = P[24] | 0, WKRH = P[25] | 0, WKR = P[26] | 0, WKPER = Math.max(1, P[27] | 0), WKHGEN = P[28] | 0;
    const WKWATCH = Math.max(1, P[29] | 0), WKWX = R['unit.wkWx'], WKWY = R['unit.wkWy'];
    const t = P[2] | 0, tr = P[3] | 0, W = P[5] | 0, H = P[6] | 0, tile = P[7], q = P[8];
    // (x * itile for x / tile, n * iq for n / q: the same for powers of two.)
    const itile = 1 / tile, iq = 1 / q;
    const QZ = q;
    const bc = P[9] | 0, br = P[10] | 0, players = P[11] | 0, B = P[14], absent = P[15], WIN = P[16] | 0, BOXSTEPS = P[17] | 0;
    const wver = P[19] | 0, pad = P[20], wcheck = P[21] | 0, WK = R['unit.mvWk'], WTC = R['unit.workerTransferCooldown'];
    const WBLK = R['mv.wallBlk'], WBLK9 = R['mv.wallBlk9'], WBW = P[30] | 0, WBH = P[31] | 0;
    const HWIN = R['unit.mvHWin'], HTT = R['unit.mvHTT'], HVER = R['unit.mvHVer'], areaVer = P[32] | 0, D0 = R['unit.dead0'], acqT = Math.max(1, P[38] | 0);
    const CTI = R['unit.cbTId'], CRS = R['unit.cbRangeS'], acqStamp = P[39] | 0, CBS = R['unit.cbS'];
    const DBT = R['unit.dbT'], DBS = R['unit.dbS'], DBTK = R['unit.dbTick'];
    const stride = bc + 1, plane = stride * (br + 1), maxSide = tile * 0.8;
    const STEPT = R['unit.mvStepT'], stepRan = P[46] === 1;
    for (let s = chunk * P[1], end = Math.min(P[0], s + P[1]); s < end; s++) {
        // (dead0: the step kernel's, when it ran.)
        if (!stepRan) D0[s] = DEADC[s];
        // (Moved by SIM_KERNEL_MOVE_STEP this tick: done.)
        if (STEPT[s] === t + 1) continue;
        OUT[s] = 0;
        if (!ON[s]) continue;
        if (!(EN[s] > 0) || SEP[s] === absent || DEADC[s]) { ON[s] = 0; continue; }
        const parked = ON[s] === 2, hold = ON[s] === 3, bhold = ON[s] === 5;
        // Parked (an idle worker, a unit waiting for its route): until its
        // wake tick, a tick is its floor and hostile checks.
        // (A parked builder pushed off its watchdog's last sample: woken at
        // the next sample tick, see simMoveTryPark.)
        if (parked && (FL[s] & 4) && ((t + (ID[s] | 0)) % WKWATCH) === 0 && (X[s] !== WKWX[s] || Y[s] !== WKWY[s])) { ON[s] = 0; continue; }
        if (parked && t >= WAKE[s]) {
            // An idle worker woken for its periodic search (every WKPER
            // ticks by id) stays parked while its search would return at
            // once: the same work version as at its failed search (around
            // where it stands now, and its search origin), in that backoff,
            // nothing else due.
            let stay = false;
            if ((FL[s] & 2) && WKV && t < WKSC[s] && t < WKU[s] && ((t + (ID[s] | 0)) % WKPER) === 0) {
                const gx = Math.floor(X[s] * itile), gy = Math.floor(Y[s] * itile), o = OWN[s] | 0;
                if (o >= 0 && o < WKNP) {
                    const span = 1 + WKRW * WKRH, all = (o * WKTYPES) * span, mine = (o * WKTYPES + WKTY[s]) * span, d = WKD[s], tw = WKTW[s];
                    let h = (Math.imul(WKV[all], 31) + WKV[mine]) | 0;
                    if (tw & 2) h = (Math.imul(h, 31) + WKHGEN) | 0;
                    for (let pass = 0; pass < ((tw & 1) ? 2 : 1); pass++) {
                        // (An origin that is the worker itself: where it stands.)
                        const cx = pass || !(tw & 1) ? gx : WKOX[s], cy = pass || !(tw & 1) ? gy : WKOY[s];
                        for (let ry = Math.max(0, Math.floor((cy - d) / WKR)), ry1 = Math.min(WKRH - 1, Math.floor((cy + d) / WKR)); ry <= ry1; ry++)
                            for (let rx = Math.max(0, Math.floor((cx - d) / WKR)), rx1 = Math.min(WKRW - 1, Math.floor((cx + d) / WKR)); rx <= rx1; rx++) {
                                const r = 1 + ry * WKRW + rx;
                                h = (Math.imul(h, 31) + Math.imul(WKV[all + r], 7) + WKV[mine + r]) | 0;
                            }
                    }
                    if (h === WKF[s]) { stay = true; WAKE[s] = Math.min(t + WKPER, WKSC[s]); }
                }
            }
            if (!stay) { ON[s] = 0; continue; }
        }
        const f = FL[s], id = ID[s] | 0, owner = OWN[s] | 0;
        const x = X[s], y = Y[s], gx = Math.floor(x * itile), gy = Math.floor(y * itile);
        if (!(owner >= 0 && owner < players) || !(gx >= 0 && gy >= 0 && gx < W && gy < H)) { ON[s] = 0; continue; }
        const tl = gy * W + gx;
        // The floor of a tile it entered (and the once-a-second refresh):
        // only a hostile structure there does anything. Checked: the tile
        // is the unit's _floorTile, as Unit.update's check leaves it.
        if (FLOOR[s] !== tl || ((t + id) | 0) % tr === 0) {
            const code = SC[tl];
            if (code !== -1 && code !== owner) { ON[s] = 0; continue; }
            FLOOR[s] = tl;
        }
        // (A hold whose target stepped out of its range: the chase's step.)
        let hchase = false;
        if (hold) {
            // Attack hold (see simMoveTryHold in unit.js): the target where
            // it was at the pass's start (x0, y0), as Unit.update sees it.
            const q = HT[s];
            if (!(q >= 0) || DEADC[q] || (ID[q] | 0) !== HTID[s] || WALL[tl] || !AOFF) { ON[s] = 0; continue; }
            const tx = X0[q], ty = Y0[q], qgx = Math.floor(tx * itile), qgy = Math.floor(ty * itile);
            if (qgx < 0 || qgy < 0 || qgx >= W || qgy >= H) { ON[s] = 0; continue; }
            const cov = COV ? COV[owner] : null, a = AG ? AG[qgy * W + qgx] : -1;
            if (!cov || !(a >= 0) || !(cov[a] > 0)) { ON[s] = 0; continue; }
            if (REACH[s] <= 1) {
                const ir = _simUnitInAttackRange(AG, AOFF, ANB, WALL, CRC, RRC, W, H, tile, pad, s, q, x, y, tx, ty, REACH[s]);
                // (Out of range: doAttacking steps after it, below.)
                if (ir === 0) hchase = true;
                else if (ir !== 1) { ON[s] = 0; continue; }
            }
            // (Longer range: still in its window, the target on its tile, the
            // area layout the same, as when found in range by areas.)
            else if (HVER[s] !== areaVer || HTT[s] !== qgy * W + qgx || HWIN[s] !== simWindowKey(x, y, tile)) { ON[s] = 0; continue; }
            // (6: held; 10: its attack tick (the status pre-pass counted the
            // timer down), the attack made at its turn: simHoldFire.)
            if (!hchase) { PX[s] = x; PY[s] = y; OUT[s] = AT[s] > 0 ? 6 : 10; continue; }
        }
        if (bhold) {
            // Building hold (see _simMoveTryHoldBuilding in unit.js): the
            // structure's tile (mvDest) still holds a hostile structure, its
            // area is in sight, it is within the unit's area range, the
            // timer runs; not an automatic target's look for units (every
            // 8 ticks by id).
            const bt = DEST[s];
            if (!(bt >= 0 && bt < W * H) || WALL[tl] || !AOFF || !AG) { ON[s] = 0; continue; }
            const code = SC[bt];
            if (code === -1 || code === owner) { ON[s] = 0; continue; }
            if ((FL[s] & 1) === 0 && ((t + id) % 8) === 0 && _simAcqHit(CBTK, CBT, CTI, CRS, RNG, ID, DEADC, s, acqStamp)) { ON[s] = 0; continue; }
            const cov = COV ? COV[owner] : null, a = AG[bt];
            if (!cov || !(a >= 0) || !(cov[a] > 0)) { ON[s] = 0; continue; }
            const bgx = bt % W, bgy = (bt - bgx) / W;
            if (_simInAreaRange(AG, AOFF, ANB, W, H, tile, x, y, bgx * tile + tile / 2, bgy * tile + tile / 2, REACH[s]) !== 1) { ON[s] = 0; continue; }
            // (6: held; 10: its attack tick, see simHoldFire.)
            PX[s] = x; PY[s] = y; OUT[s] = AT[s] > 0 ? 6 : 10;
            continue;
        }
        if (ON[s] === 4 || hchase) {
            // Chase (see simMoveTryChase in unit.js), as doAttacking: the
            // target where it was at the pass's start, in sight, not in range,
            // within leash, and the straight step taken (close, flying, or
            // _isChaseStepOpen), not into a wall tile. (Also a hold whose
            // target stepped out of range, checked above: outputs 11, 12 as
            // 7, 9.) Come in range: held from now on (output 13).
            // (11-13: the rest of Unit.update at its turn, simHoldChaseCommit.)
            const q = HT[s];
            if (!hchase && (!(q >= 0) || DEADC[q] || (ID[q] | 0) !== HTID[s] || !AOFF)) { ON[s] = 0; continue; }
            const tx = X0[q], ty = Y0[q], qgx = Math.floor(tx * itile), qgy = Math.floor(ty * itile);
            if (!hchase) {
                if (qgx < 0 || qgy < 0 || qgx >= W || qgy >= H) { ON[s] = 0; continue; }
                const cov = COV ? COV[owner] : null, a = AG ? AG[qgy * W + qgx] : -1;
                if (!cov || !(a >= 0) || !(cov[a] > 0)) { ON[s] = 0; continue; }
                const ir = _simUnitInAttackRange(AG, AOFF, ANB, WALL, CRC, RRC, W, H, tile, pad, s, q, x, y, tx, ty, REACH[s]);
                if (ir === 1) { ON[s] = 3; PX[s] = x; PY[s] = y; OUT[s] = 13; continue; }
                if (ir !== 0) { ON[s] = 0; continue; }
            }
            const dx = tx - x, dy = ty - y, d = Math.sqrt(dx * dx + dy * dy);
            if (!(d > 0) || d > 8 * tile) { ON[s] = 0; continue; }
            const fly = (f & 32) !== 0;
            if (!fly && WALL[tl]) { ON[s] = 0; continue; }
            // (With a path of its own (bit 2), flying is no reason: the path.)
            let direct = d < 2 * tile || (fly && (f & 2) === 0);
            if (!direct && d < 6 * tile) {
                const st = CHS[s], ax = x + dx / d * st, ay = y + dy / d * st, agx = Math.floor(ax * itile), agy = Math.floor(ay * itile);
                direct = agx >= 0 && agy >= 0 && agx < W && agy < H && !WALL[agy * W + agx] && !WALL[qgy * W + qgx];
            }
            // Not straight: along its path, a nav node's flow field (bit 64,
            // armed with its field: simMoveTryChase), as followPath does it:
            // the flow section below (outputs 1, 3, no turn check: the target
            // is judged as at the pass's start, _unitTickDead). Else
            // Unit.update.
            if (!direct && (hchase || (f & 64) === 0)) { ON[s] = 0; continue; }
            if (direct) {
            let spd = SPD[s];
            if (FRZ[s] > 0) spd *= 0.5;
            if (SND[s] > 0) spd *= 0.5;
            const nx = x + (dx / d) * spd, ny = y + (dy / d) * spd;
            const ngx = Math.floor(nx * itile), ngy = Math.floor(ny * itile);
            if (!fly && (ngx < 0 || ngy < 0 || ngx >= W || ngy >= H || WALL[ngy * W + ngx])) { ON[s] = 0; continue; }
            const qx = Number.isFinite(nx) ? Math.round(nx * QZ) / QZ : 0, qy = Number.isFinite(ny) ? Math.round(ny * QZ) / QZ : 0;
            PX[s] = x; PY[s] = y; X[s] = qx; Y[s] = qy;
            const qgx2 = Math.floor(qx * itile), qgy2 = Math.floor(qy * itile);
            OUT[s] = qgx2 !== gx || qgy2 !== gy ? (hchase ? 12 : 9) : (hchase ? 11 : 7);
            continue;
            }
        }
        if (ON[s] === 6) {
            // Approach (see _simMoveTryApproachBuilding in unit.js): the
            // structure still hostile at its tile (mvHT), in sight, not in
            // range; an automatic target's look for units every 8 ticks (by
            // id) is Unit.update's. Then the path or flow field, as a move.
            const bt = HT[s];
            if (!(bt >= 0 && bt < W * H) || !AOFF || !AG) { ON[s] = 0; continue; }
            const code = SC[bt];
            if (code === -1 || code === owner) { ON[s] = 0; continue; }
            // (Its look found no enemy unit: the scan, this tick.)
            if (HTID[s] === 0 && ((t + id) % 8) === 0 && _simAcqHit(CBTK, CBT, CTI, CRS, RNG, ID, DEADC, s, acqStamp)) { ON[s] = 0; continue; }
            const cov = COV ? COV[owner] : null, a = AG[bt];
            if (!cov || !(a >= 0) || !(cov[a] > 0)) { ON[s] = 0; continue; }
            const bgx = bt % W, bgy = (bt - bgx) / W;
            if (_simInAreaRange(AG, AOFF, ANB, W, H, tile, x, y, bgx * tile + tile / 2, bgy * tile + tile / 2, REACH[s]) !== 0) { ON[s] = 0; continue; }
        }
        // Hostiles possibly in reach: attack-movers every tick, drive-by
        // shooters on their scan ticks (the tiles of its areas in reach).
        // (An attack-mover hands back only on its acquisition tick, below:
        // nothing to look at on the others.)
        const atk = (f & 16) !== 0;
        // (A drive-by shooter: with its timer running nothing comes of the look
        // (tryDriveByAttack returns at once); the drive-by kernel's verdict
        // when it looked this tick (its box and tables are these: something
        // found, or nothing); else the box, as below.)
        let dbLook = !atk && (f & 1) !== 0 && ((t + id) & 1) === 0;
        if (dbLook) {
            if (!(AREA[s] >= 0)) { ON[s] = 0; continue; }
            if (AT[s] > 0) dbLook = false;
            else if (DBTK[s] === t && DBT[s] !== -2) {
                if (DBT[s] !== -1 || DBS[s] >= 0) { ON[s] = 0; continue; }
                dbLook = false;
            }
        }
        if (atk ? ((t + id) % acqT) === 0 || ((t + id) & 3) === 0 : dbLook) {
            let x0, y0, x1, y1;
            if (atk) { const r = REACH[s]; x0 = gx - r; y0 = gy - r; x1 = gx + r; y1 = gy + r; }
            else {
                const area = AREA[s], k = area * BOXSTEPS + REACH[s];
                if (!(area >= 0) || !ABOK[k]) { ON[s] = 0; continue; }
                x0 = AB[k * 4]; y0 = AB[k * 4 + 1]; x1 = AB[k * 4 + 2]; y1 = AB[k * 4 + 3];
            }
            x0 = x0 < 0 ? 0 : x0; y0 = y0 < 0 ? 0 : y0; x1 = x1 >= W ? W - 1 : x1; y1 = y1 >= H ? H - 1 : y1;
            if (x0 <= x1 && y0 <= y1) {
                const bx0 = Math.floor(x0 / B), by0 = Math.floor(y0 / B), bx1 = Math.floor(x1 / B), by1 = Math.floor(y1 / B), o = owner * plane;
                const i11 = o + (by1 + 1) * stride + bx1 + 1, i01 = o + by0 * stride + bx1 + 1, i10 = o + (by1 + 1) * stride + bx0, i00 = o + by0 * stride + bx0;
                if (HS[i11] - HS[i01] - HS[i10] + HS[i00] > 0) {
                    // Aggro (attack-move, idle): as doAttackMoving / doIdle,
                    // which take the scan's enemy unit, else look for
                    // structures on a quarter of the ticks (by id). The scan
                    // found none and no structure look is due (or none can
                    // be in reach): nothing to react to, the move goes on.
                    // (A drive-by shooter whose attack timer still runs:
                    // tryDriveByAttack returns at once, the move goes on.)
                    // (Its timer run out: only when _driveByScan may find
                    // something, see _simDriveByAny.)
                    // (Its timer run out: when the drive-by look found
                    // something, or was not worked out: SIM_KERNEL_DRIVEBY.)
                    if (!atk) {
                        if (!(AT[s] > 0) && (DBTK[s] !== t || DBT[s] !== -1 || DBS[s] >= 0)) { ON[s] = 0; continue; }
                    }
                    // (Only on its acquisition tick, every P[38], and for a
                    // target the tier found: _simAcqHit.)
                    else if (((t + id) % acqT) === 0 && _simAcqHit(CBTK, CBT, CTI, CRS, RNG, ID, DEADC, s, acqStamp)) { ON[s] = 0; continue; }
                    // (The look, _findAutoStructureTarget, finds nothing
                    // unless a hostile structure's tile comes within its
                    // aggro range: checked tile by tile when the blocks
                    // around hold one.)
                    // (The structure the tier found, still hostile there and
                    // in sight: _acqStructureHit decides.)
                    if (atk && ((t + id) & 3) === 0 && CBTK[s] === acqStamp && CRS[s] === RNG[s] && CBS[s] >= 0 && SC[CBS[s]] !== -1 && SC[CBS[s]] !== owner
                        && COV && AG && AG[CBS[s]] >= 0 && COV[owner] && COV[owner][AG[CBS[s]]] > 0) { ON[s] = 0; continue; }
                }
            }
        }
        if (parked) { PX[s] = x; PY[s] = y; OUT[s] = 1; continue; }
        if ((f & 64) !== 0) {
            // A worker's check tick: its task looked at (Unit.update), unless
            // its transfer cooldown runs (then it only walks: updateWorkerAI).
            if (WK[s] && ((t + id) | 0) % wcheck === 0 && !(WTC[s] > 0)) { ON[s] = 0; continue; }
            // Following the flow navigation (flownav.js) toward its
            // destination, steered like _followPathStep.
            const dk = DEST[s], dx0 = dk % W, dy0 = (dk - dx0) / W;
            const prof = (f & 32) !== 0 ? 1 : 0, WL = prof ? AIRW : WALL;
            const fid = FLOWC[s], wide = fid >= 4194304, did = wide ? fid - 4194304 : fid, dm = did * 8;
            const FMETA = wide ? FMW : FMN, FPOOL = wide ? FPW : FPN;
            // (Its field: the slot as armed, made.)
            if (!(fid >= 0) || !FMETA || FMETA[dm + 6] !== MFGEN[s] || FMETA[dm + 1] !== dk || FMETA[dm + 7] !== 1) { ON[s] = 0; continue; }
            // Its route starts next tick (asked for after this tick's flush).
            if (t < RDY[s]) { PX[s] = x; PY[s] = y; OUT[s] = 1; continue; }
            // Between its steers: on along its committed step (see
            // SIM_STEER_TICKS); on its destination tile, Unit.update arrives.
            // (After the field's checks: a field made again or dropped hands
            // it back, where Unit.update asks for it again.)
            if (CD[s] === dk && CTL[s] === tl && t - CTK[s] < CN[s]) {
                if (tl === dk) { ON[s] = 0; continue; }
                let vx = CVX[s], vy = CVY[s];
                const sgx = Math.floor((x + vx) * itile), sgy = Math.floor((y + vy) * itile);
                if ((f & 32) === 0 && (sgx !== gx || sgy !== gy)) {
                    const sl = simFlowSlide(WALL, W, H, gx, gy, sgx, sgy);
                    if (sl) { if (sl & 1) vx = 0; if (sl & 2) vy = 0; CD[s] = -1; }
                }
                const nx = x + vx, ny = y + vy;
                PX[s] = x; PY[s] = y; VX[s] = vx; VY[s] = vy; SPENT[s] = Math.floor(nx * itile) !== gx || Math.floor(ny * itile) !== gy ? 1 : 0; FLOOR[s] = tl;
                const qx = Number.isFinite(nx) ? Math.round(nx * q) * iq : 0, qy = Number.isFinite(ny) ? Math.round(ny * q) * iq : 0;
                X[s] = qx; Y[s] = qy;
                OUT[s] = Math.floor(qx * itile) !== gx || Math.floor(qy * itile) !== gy ? 3 : 1;
                continue;
            }
            // (A steer: commits again below, if it moves.)
            CD[s] = -1;
            const NF = prof ? NF1 : NF0, NH = prof ? NH1 : NH0, NB = prof ? NB1 : NB0, NT = prof ? NT1 : NT0, NP = prof ? NP1 : NP0, NM = prof ? NM1 : NM0;
            if (!NF || !NM) { ON[s] = 0; continue; }
            const nC = NM[0], ncw = NM[1], nnc = NM[3];
            const span = wide ? 3 * nC : nC, df = FPOOL, doff = did * span * span, dbx = FMETA[dm + 2], dby = FMETA[dm + 3], dbw = FMETA[dm + 4], dbh = FMETA[dm + 5];
            // On the destination tile: Unit.update arrives.
            if (tl === dk) { ON[s] = 0; continue; }
            // Near it and held back by the crowd (under a third of its speed
            // made good toward it last tick, pushes included): arrived where
            // it is (not all of a big group fit on one tile).
            // (As _followNavNode, with its last distance, unit.mvNavLD: the
            // arrival itself is Unit.update's.)
            // Waiting in a crowd (mvNavLD -2 - dest, see Unit._followNavNode):
            // still, but for its look every 16 ticks (by id: on when the crowd
            // around thinned out) and a try every 64.
            if (NLD[s] === -2 - dk) {
                const look = ((t + id) & 15) === 0;
                if (!look || (((t + id) & 63) !== 0 && !(CWT[s] === t && CWD[s] < 9))) { PX[s] = x; PY[s] = y; OUT[s] = 1; continue; }
                NLD[s] = -1;
            }
            // (Further out, up to 64 tiles: held back beside an idle or
            // waiting unit of its own, cwNear, it waits: a big crowd settles
            // outward, and goes on as it thins.)
            let navLD = -1;
            if ((f & 128) === 0 && Math.abs(dx0 - gx) <= 64 && Math.abs(dy0 - gy) <= 64) {
                const ex = dx0 * tile + 16 - x, ey = dy0 * tile + 16 - y, now = Math.sqrt(ex * ex + ey * ey), last = NLD[s];
                let es = SPD[s];
                if (FRZ[s] > 0) es *= 0.5;
                if (SND[s] > 0) es *= 0.5;
                const near = Math.abs(dx0 - gx) <= 8 && Math.abs(dy0 - gy) <= 8;
                if (last >= 0 && last - now < es * 0.3 * SIM_STEER_NEAR_TICKS) {
                    if (near) { ON[s] = 0; continue; }
                    if (CWT[s] === t && CWN[s] === 1) { NLD[s] = -2 - dk; PX[s] = x; PY[s] = y; OUT[s] = 1; continue; }
                }
                navLD = now;
            }
            // The look-ahead from this tile (simFlowLook, cached).
            const lk = simFlowLook(LC, s, ((t + id) & (SIM_FLOW_REFRESH_TICKS - 1)) === 0, tl, gx, gy, dk, W, H, WL, NM[6], simWallKey9(WBLK9, WBW, gx, gy, wver), wide ? 2 : 1,
                nC, ncw, nnc, NH, NF, NB, NT, NP, df, doff, dbx, dby, dbw, dbh);
            // No way there: a worker more than a tile away stands (as
            // _followNavNode), anything else is handed back (it arrives as
            // near as it gets). Walled in: it stands. A bad build:
            // Unit.update.
            if (lk === 0) { if (WK[s] && (Math.abs(dx0 - gx) > 1 || Math.abs(dy0 - gy) > 1)) { PX[s] = x; PY[s] = y; OUT[s] = 1; continue; } ON[s] = 0; continue; }
            if (lk === -1) { PX[s] = x; PY[s] = y; OUT[s] = 1; continue; }
            if (lk === -2) { ON[s] = 0; continue; }
            const n1 = NVN1[s], n2 = NVN2[s], far = NVF[s], open = NVO[s] === 1;
            NLD[s] = navLD;
            const kx = far % W, ky = (far - kx) / W;
            const baseTx = kx * tile + 16, baseTy = ky * tile + 16;
            let tx, ty;
            if (open) {
                // Its own side offset from the flow's line (through the tile
                // centres), drifting back gently: a group moves as a wide
                // stream, each unit in its lane.
                const routeDx = kx - gx, routeDy = ky - gy, routeLen = Math.sqrt(routeDx * routeDx + routeDy * routeDy);
                const sx = -routeDy / routeLen, sy = routeDx / routeLen;
                let side = ((x - (gx * tile + 16)) * sx + (y - (gy * tile + 16)) * sy) * 0.875;
                side = side > maxSide ? maxSide : (side < -maxSide ? -maxSide : side);
                tx = baseTx + sx * side; ty = baseTy + sy * side;
            } else {
                const lane = LANE[s], segDx = kx - gx, segDy = ky - gy;
                let lx = 0, ly = 0;
                if (Math.abs(segDx) >= Math.abs(segDy)) ly = (segDx < 0 ? lane : -lane);
                else lx = (segDy < 0 ? -lane : lane);
                tx = baseTx + lx; ty = baseTy + ly;
            }
            let dx = tx - x, dy = ty - y, dist = Math.sqrt(dx * dx + dy * dy);
            // Never turn back for a point it has passed (the next tile's
            // centre behind it, stepping around a corner): the one after.
            if (n2 >= 0 && far === n1 && VX[s] * dx + VY[s] * dy < 0) {
                const n2x = n2 % W;
                tx = n2x * tile + 16; ty = ((n2 - n2x) / W) * tile + 16;
                dx = tx - x; dy = ty - y; dist = Math.sqrt(dx * dx + dy * dy);
            }
            if (dist < 4) {
                // At the next tile's point already: on toward the one after.
                if (n2 < 0) { PX[s] = x; PY[s] = y; OUT[s] = 1; continue; }
                const n2x = n2 % W;
                tx = n2x * tile + 16; ty = ((n2 - n2x) / W) * tile + 16;
                dx = tx - x; dy = ty - y; dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 4) { PX[s] = x; PY[s] = y; OUT[s] = 1; continue; }
            }
            let spd = SPD[s];
            if (FRZ[s] > 0) spd *= 0.5;
            if (SND[s] > 0) spd *= 0.5;
            let vx = (dx / dist) * spd, vy = (dy / dist) * spd;
            // Into a wall (on the ground): along it, one axis, else it
            // stands (simFlowSlide, as _followNavNode).
            if ((f & 32) === 0) {
                const sl = simFlowSlide(WALL, W, H, gx, gy, Math.floor((x + vx) * itile), Math.floor((y + vy) * itile));
                if (sl & 1) vx = 0;
                if (sl & 2) vy = 0;
            }
            const nx = x + vx, ny = y + vy;
            const ngx = Math.floor(nx * itile), ngy = Math.floor(ny * itile);
            // Entering another tile is a step (charged like a path node).
            const stepped = ngx !== gx || ngy !== gy;
            PX[s] = x; PY[s] = y; VX[s] = vx; VY[s] = vy; SPENT[s] = stepped ? 1 : 0; FLOOR[s] = tl;
            CD[s] = dk; CTK[s] = t; CVX[s] = vx; CVY[s] = vy; CTL[s] = tl;
            CN[s] = Math.abs(dx0 - gx) <= 8 && Math.abs(dy0 - gy) <= 8 ? SIM_STEER_NEAR_TICKS : SIM_STEER_TICKS;
            const qx = Number.isFinite(nx) ? Math.round(nx * q) * iq : 0, qy = Number.isFinite(ny) ? Math.round(ny * q) * iq : 0;
            X[s] = qx; Y[s] = qy;
            const qgx = Math.floor(qx * itile), qgy = Math.floor(qy * itile);
            OUT[s] = qgx !== gx || qgy !== gy ? 3 : 1;
            continue;
        }
        // A worker's check tick, as in flow mode.
        if (WK[s] && ((t + id) | 0) % wcheck === 0 && !(WTC[s] > 0)) { ON[s] = 0; continue; }
        // The path window (see _simMoveNode): a node it does not hold means
        // the tick needs the path itself.
        const len = PLEN[s], base = BASE[s], wl = WLEN[s], nb = s * WIN;
        let idx = PIDX[s] | 0, spent = 0, bail = false;
        if (idx >= len) { ON[s] = 0; continue; }
        // The node scan (followPath) when the tile or the node changed.
        if (SCAN[s] !== tl) {
            const first = idx - 1 > 0 ? idx - 1 : 0, limit = Math.min(len - 1, idx + 6);
            let reached = -1, r1 = 0;
            for (let i = first; i <= limit; i++) {
                r1 = 0;
                const k = _simMoveNode(NODES, nb, base, wl, i);
                if (k < 0) { bail = true; break; }
                const kx = k % W, ky = (k - kx) / W, dx = kx - gx, dy = ky - gy;
                if (i + 1 < len) {
                    const nk = _simMoveNode(NODES, nb, base, wl, i + 1);
                    if (nk < 0) { bail = true; break; }
                    const nx = nk % W, ny = (nk - nx) / W;
                    // A portal link ends the window, so none are inside it.
                    if (Math.abs(nx - kx) + Math.abs(ny - ky) !== 1) { bail = true; break; }
                }
                if ((dx === 0 && dy === 0) || (dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1 && (r1 = _simMoveRoomy(NODES, WALL, nb, base, wl, len, W, H, i)) === 1)) reached = i;
                if (r1 < 0) { bail = true; break; }
            }
            if (bail) { ON[s] = 0; continue; }
            while (idx <= reached) { if (idx > 0) spent++; idx++; }
            if (idx >= len) { ON[s] = 0; continue; }
            // Stale nodes on its own tile.
            for (;;) {
                const k = _simMoveNode(NODES, nb, base, wl, idx);
                if (k < 0) { bail = true; break; }
                if (k !== tl) break;
                if (idx > 0) spent++;
                idx++;
                if (idx >= len) { bail = true; break; }
            }
            if (bail) { ON[s] = 0; continue; }
        }
        // The step toward node idx (_followPathStep).
        const k = _simMoveNode(NODES, nb, base, wl, idx);
        if (k < 0) { ON[s] = 0; continue; }
        if ((f & (8 | 32)) === 0 && WALL[k]) { ON[s] = 0; continue; }
        const kx = k % W, ky = (k - kx) / W;
        const baseTx = kx * tile + 16, baseTy = ky * tile + 16;
        let segDx = 0, segDy = 0;
        const pk = idx > 0 ? _simMoveNode(NODES, nb, base, wl, idx - 1) : -1;
        if (idx > 0 && pk < 0) { ON[s] = 0; continue; }
        let px = 0, py = 0;
        if (idx > 0) { px = pk % W; py = (pk - px) / W; segDx = kx - px; segDy = ky - py; }
        else if (idx + 1 < len) {
            const nk = _simMoveNode(NODES, nb, base, wl, idx + 1);
            if (nk < 0) { ON[s] = 0; continue; }
            const nx = nk % W; segDx = nx - kx; segDy = (nk - nx) / W - ky;
        }
        if (segDx === 0 && segDy === 0) {
            if (kx !== gx) segDx = kx - gx;
            else if (ky !== gy) segDy = ky - gy;
            else if (idx + 1 < len) {
                const nk = _simMoveNode(NODES, nb, base, wl, idx + 1);
                if (nk < 0) { ON[s] = 0; continue; }
                const nx = nk % W; segDx = nx - kx; segDy = (nk - nx) / W - ky;
            } else segDx = 1;
        }
        let tx, ty, lx = 0, ly = 0;
        let rA = 0, rB = 0;
        if (idx > 0 && Math.abs(px - gx) <= 1 && Math.abs(py - gy) <= 1) {
            rA = _simMoveRoomy(NODES, WALL, nb, base, wl, len, W, H, idx - 1);
            if (rA === 1) rB = _simMoveRoomy(NODES, WALL, nb, base, wl, len, W, H, idx);
            if (rA < 0 || rB < 0) { ON[s] = 0; continue; }
        }
        if (rA === 1 && rB === 1) {
            let ak = _simMoveNode(NODES, nb, base, wl, idx + 1);
            const fk = idx + 2 < len ? _simMoveNode(NODES, nb, base, wl, idx + 2) : -1;
            if (ak < 0 || (idx + 2 < len && fk < 0)) { ON[s] = 0; continue; }
            let ax = ak % W, ay = (ak - ax) / W;
            if (fk >= 0) { const fx = fk % W, fy = (fk - fx) / W; if (Math.abs(fx - ax) + Math.abs(fy - ay) === 1) { ax = fx; ay = fy; } }
            const routeDx = ax - px, routeDy = ay - py, routeLen = Math.sqrt(routeDx * routeDx + routeDy * routeDy);
            lx = -routeDy / routeLen; ly = routeDx / routeLen;
            let side = ((x - baseTx) * lx + (y - baseTy) * ly) * 0.875;
            side = side > maxSide ? maxSide : (side < -maxSide ? -maxSide : side);
            tx = baseTx + lx * side; ty = baseTy + ly * side;
        } else {
            const lane = LANE[s];
            if (Math.abs(segDx) >= Math.abs(segDy)) ly = (segDx < 0 ? lane : -lane);
            else lx = (segDy < 0 ? -lane : lane);
            tx = baseTx + lx; ty = baseTy + ly;
        }
        const dx = tx - x, dy = ty - y, dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 4) {
            // Arrived at the node: the next one from the next tick (a portal
            // link would have ended the window).
            if (idx + 1 < len && _simMoveNode(NODES, nb, base, wl, idx + 1) < 0) { ON[s] = 0; continue; }
            if (idx > 0) spent++;
            idx++;
            if (idx >= len) { ON[s] = 0; continue; }
            PX[s] = x; PY[s] = y; PIDX[s] = idx; SPENT[s] = spent; SCAN[s] = -1; FLOOR[s] = tl;
            OUT[s] = 1;
            continue;
        }
        let spd = SPD[s];
        if (FRZ[s] > 0) spd *= 0.5;
        if (SND[s] > 0) spd *= 0.5;
        const vx = (dx / dist) * spd, vy = (dy / dist) * spd;
        const nx = x + vx, ny = y + vy;
        PX[s] = x; PY[s] = y; VX[s] = vx; VY[s] = vy; PIDX[s] = idx; SPENT[s] = spent; FLOOR[s] = tl;
        SCAN[s] = tl;
        const ngx = Math.floor(nx * itile), ngy = Math.floor(ny * itile);
        if ((f & 32) === 0 && (ngx < 0 || ngy < 0 || ngx >= W || ngy >= H || WALL[ngy * W + ngx])) {
            X[s] = nx; Y[s] = ny; ON[s] = 0; OUT[s] = 4; continue;
        }
        const qx = Number.isFinite(nx) ? Math.round(nx * q) * iq : 0, qy = Number.isFinite(ny) ? Math.round(ny * q) * iq : 0;
        X[s] = qx; Y[s] = qy;
        const qgx = Math.floor(qx * itile), qgy = Math.floor(qy * itile);
        OUT[s] = qgx !== gx || qgy !== gy ? 3 : 1;
    }
    // The chunk's epilogue, in slot order:
    //  - node steps charged (spatialSlotUpdate's twin for the budget): per
    //    owner the fixed-point spend (mv.chFix[chunk][owner]) and per owner
    //    and unit type the spend (mv.chUse[...][type], P[44] types, the last
    //    for none), by the budget at the pass's start (mv.astarRem): a step
    //    it does not cover marks the unit (mvBlk);
    //  - a unit in another tile, indexed (epoch P[40], same owner) and its
    //    sight window as it was (vsGen P[41], or P[42]): its tile, area and
    //    chunk in the columns (spatialSlotMove's), the chunk move kept for
    //    the counts at the pass's end (spMv*);
    //  - the slots the simulation thread still looks at (an arrival, a wall,
    //    a mark, a unit the above did not cover, a drive-by shooter in
    //    another area), at mv.post[chunk * P[1]...], how many at
    //    mv.postc[chunk].
    const PL = R['mv.post'], PC = R['mv.postc'];
    if (PL && PC) {
        const SPE = R['unit.spEpoch'], SPO = R['unit.spOwner'], SPT = R['unit.spTile'], SPTY = R['unit.spType'], VSG = R['unit.vsGen'];
        const MVO = R['unit.spMvOld'], MVN = R['unit.spMvNew'], MVW = R['unit.spMvOwn'], BLK = R['unit.mvBlk'], AGF = R['ix.agrid'];
        const REM = R['mv.astarRem'], FIX = R['mv.chFix'], USE = R['mv.chUse'], COST = R['unit.mvCost'];
        const epoch = P[40] | 0, visGen = P[41] | 0, visAll = P[42] | 0, CW = P[34] | 0, CS = P[36] | 0, NP = P[43] | 0, NT = P[44] | 0, SCALE = P[45];
        const b0 = chunk * P[1], f0 = chunk * NP, u0 = f0 * NT;
        for (let i = 0; i < NP; i++) FIX[f0 + i] = 0;
        for (let i = 0; i < NP * NT; i++) USE[u0 + i] = 0;
        let m = 0;
        for (let s = b0, end = Math.min(P[0], b0 + P[1]); s < end; s++) {
            const o = OUT[s];
            if (o === 0) continue;
            let list = o === 4 || o === 5;
            const k = SPENT[s];
            if (k) {
                SPENT[s] = 0;
                const pid = OWN[s], cost = COST[s];
                if (cost > 0 && pid >= 0 && pid < NP) {
                    if (REM[pid] < cost) { BLK[s] = 1; list = true; }
                    FIX[f0 + pid] += k * Math.round(-cost * SCALE);
                    const ty = SPTY[s], r = u0 + pid * NT + (ty >= 0 && ty < NT - 1 ? ty : NT - 1);
                    for (let j = 0; j < k; j++) USE[r] += cost;
                }
            }
            if (o === 3 || o === 9 || o === 12) {
                let gx = Math.floor(X[s] * itile), gy = Math.floor(Y[s] * itile);
                if (!(gx >= 0)) gx = 0; else if (gx >= W) gx = W - 1;
                if (!(gy >= 0)) gy = 0; else if (gy >= H) gy = H - 1;
                const t = gy * W + gx;
                if (SPE[s] === epoch && SPO[s] === OWN[s] && SEP[s] !== absent && (visAll || VSG[s] === visGen)) {
                    if (t !== SPT[s]) {
                        const key = CS === 1 ? t : Math.floor(gy / CS) * CW + Math.floor(gx / CS), old = SEP[s];
                        if (old !== key) {
                            if (!MVW[s]) MVO[s] = old;
                            MVN[s] = key; MVW[s] = SPO[s] + 1; SEP[s] = key;
                        }
                        const a = AGF[t], a0 = AREA[s];
                        AREA[s] = a >= 0 ? a : -1;
                        SPT[s] = t;
                        // (A drive-by shooter in another area whose box is not made: its box.)
                        if (o === 3 && (FL[s] & 1) && AREA[s] !== a0 && AREA[s] >= 0 && !ABOK[AREA[s] * BOXSTEPS + REACH[s]]) list = true;
                    }
                } else list = true;
            }
            if (list) PL[b0 + m++] = s;
        }
        PC[chunk] = m;
    }
};

// The hostile tables (unit.js _simMoveBuildHostile) in two passes: per
// player and block row, its prefix along the row (SIM_KERNEL_SAT_ROWS), then
// per player and column, the rows summed down (SIM_KERNEL_SAT_COLS); integer
// sums, the same as the serial build. mv.hostile: other players' units
// (ix.bcount) plus structures hostile to the player (mv.stblk); mv.hstruct:
// the structures alone. Row and column 0 stay 0. P: [0] players, [1] blocks
// wide, [2] blocks high, [3] rows (columns) per job.
SIM_KERNELS[SIM_KERNEL_SAT_ROWS] = function (R, P, chunk) {
    const H = R['mv.hostile'], HS = R['mv.hstruct'], counts = R['ix.bcount'], st = R['mv.stblk'];
    const players = P[0] | 0, bc = P[1] | 0, br = P[2] | 0, per = P[3] | 0, stride = bc + 1, plane = stride * (br + 1);
    const jobs = Math.ceil(br / per), p = Math.floor(chunk / jobs), o = p * plane;
    const by0 = (chunk % jobs) * per, by1 = Math.min(br, by0 + per);
    if (by0 === 0) { H.fill(0, o, o + stride); HS.fill(0, o, o + stride); }
    for (let by = by0; by < by1; by++) {
        const row = o + (by + 1) * stride;
        H[row] = 0; HS[row] = 0;
        let run = 0, runS = 0;
        for (let bx = 0; bx < bc; bx++) {
            const base = (by * bc + bx) * players;
            let v = st[base + p];
            runS += v;
            for (let q = 0; q < players; q++) if (q !== p) v += counts[base + q];
            run += v;
            H[row + bx + 1] = run; HS[row + bx + 1] = runS;
        }
    }
};
SIM_KERNELS[SIM_KERNEL_SAT_COLS] = function (R, P, chunk) {
    const H = R['mv.hostile'], HS = R['mv.hstruct'];
    const bc = P[1] | 0, br = P[2] | 0, per = P[3] | 0, stride = bc + 1, plane = stride * (br + 1);
    const jobs = Math.ceil(bc / per), p = Math.floor(chunk / jobs), o = p * plane;
    const c0 = 1 + (chunk % jobs) * per, c1 = Math.min(bc, c0 - 1 + per);
    for (let by = 2; by <= br; by++) {
        const row = o + by * stride, above = row - stride;
        for (let c = c0; c <= c1; c++) { H[row + c] += H[above + c]; HS[row + c] += HS[above + c]; }
    }
};

// The movement kernel's chunk moves into the counts (chunk.js
// spatialCountsDeferEnd): per slot with one (spMvOwn), its owner's and type's
// counts of the chunk it left less one, of the chunk it entered plus one,
// and the 8x8 blocks' (Atomics: chunks are shared between slots).
// P: [0] slots, [1] per job, [2] players, [3] stride per chunk, [4] stride
// per player, [5] chunks wide, [6] blocks wide, [7] block size.
SIM_KERNELS[SIM_KERNEL_SP_COUNTS] = function (R, P, chunk) {
    const MVO = R['unit.spMvOld'], MVN = R['unit.spMvNew'], MVW = R['unit.spMvOwn'], SPTY = R['unit.spType'], CX = R['ix.complex'], BC = R['ix.bcount'];
    const NP = P[2] | 0, SC = P[3] | 0, SP = P[4] | 0, CW = P[5] | 0, BW = P[6] | 0, BS = P[7] | 0, nb = BC.length;
    for (let s = chunk * P[1], end = Math.min(P[0], s + P[1]); s < end; s++) {
        const w = MVW[s];
        if (!w) continue;
        MVW[s] = 0;
        const owner = w - 1;
        if (!(owner < NP)) continue;
        const ty = SPTY[s];
        for (let pass = 0; pass < 2; pass++) {
            const key = pass ? MVN[s] : MVO[s], d = pass ? 1 : -1, base = key * SC + owner * SP;
            Atomics.add(CX, base, d); Atomics.add(CX, base + 1 + ty, d);
            const cx = key % CW, cy = (key - cx) / CW, bi = (Math.floor(cy / BS) * BW + Math.floor(cx / BS)) * NP + owner;
            if (bi >= 0 && bi < nb) Atomics.add(BC, bi, d);
        }
    }
};

// The common collision correction stays inside one tile. Compute it in
// parallel; the commit checks terrain/membership and handles tile crossings
// with the full swept collision routine. No approximate contact budget.
// A push that stays in the unit's tile is committed here (fast 1), and
// fast 2 when the main thread still has work: a path retry tick of a unit
// that may be waiting on a fallback path (see runUnitSeparationPass).
SIM_KERNELS[SIM_KERNEL_SEPARATION_FINISH] = function (R, P, chunk) {
    const X = R['unit.x'], Y = R['unit.y'], ON = R['unit.mvOn'], FL = R['unit.mvFlags'], ID = R['unit.id'];
    const PX = R['sep.px'], PY = R['sep.py'], OV = R['sep.ov'], HIT = R['sep.hit'];
    const outX = R['sep.nextX'], outY = R['sep.nextY'], fast = R['sep.fast'];
    const tile = P[2], quant = P[3], contacts = P[4], pushQuant = P[5], t = P[6] | 0, retry = P[7] | 0;
    const WALL = R['mv.wall'], LAYER = R['unit.sepLayer'], GW = P[8] | 0, GH = P[9] | 0;
    // Whether each unit moved by itself this tick (before the pushes), for
    // the next tick's separationStart.
    const SMV = R['unit.sepMov'], PRX = R['unit.prevX'], PRY = R['unit.prevY'];
    for (let i = chunk * P[1], end = Math.min(P[0], i + P[1]); i < end; i++) {
        SMV[i] = X[i] !== PRX[i] || Y[i] !== PRY[i] ? 1 : 0;
        fast[i] = 0;
        const hits = HIT[i];
        if (!hits) continue;
        const s = i, x = X[s], y = Y[s];
        const scale = hits <= contacts ? 1 : Math.sqrt(contacts / hits);
        let dx = PX[i] * scale / pushQuant, dy = PY[i] * scale / pushQuant;
        const length = Math.sqrt(dx * dx + dy * dy), limit = Math.max(0, OV[i]);
        if (length > limit) { dx *= limit / length; dy *= limit / length; }
        // Preserve the sweep's last-step arithmetic (dx * steps / steps),
        // including its rounding before the final quantization.
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (tile / 4)));
        const rawX = x + dx * steps / steps, rawY = y + dy * steps / steps;
        const nx = Number.isFinite(rawX) ? Math.round(rawX * quant) / quant : 0;
        const ny = Number.isFinite(rawY) ? Math.round(rawY * quant) / quant : 0;
        outX[i] = nx; outY[i] = ny;
        const gx = Math.floor(nx / tile), gy = Math.floor(ny / tile), ox = Math.floor(x / tile), oy = Math.floor(y / tile);
        if (gx !== ox || gy !== oy) {
            // Into another tile: committed here when the sweep cannot meet
            // a blocked tile (a flyer, or open ground over the tiles
            // between; off the map counts as blocked). Otherwise
            // _commitUnitSeparation, in id order.
            if (!WALL || !LAYER) continue;
            if (LAYER[s] !== 1) {
                if (Math.abs(gx - ox) > 1 || Math.abs(gy - oy) > 1) continue;
                const x0 = gx < ox ? gx : ox, x1 = gx < ox ? ox : gx, y0 = gy < oy ? gy : oy, y1 = gy < oy ? oy : gy;
                if (x0 < 0 || y0 < 0 || x1 >= GW || y1 >= GH) continue;
                if (WALL[y0 * GW + x0] | WALL[y0 * GW + x1] | WALL[y1 * GW + x0] | WALL[y1 * GW + x1]) continue;
            }
            X[s] = nx; Y[s] = ny;
            fast[i] = 2;
            continue;
        }
        X[s] = nx; Y[s] = ny;
        fast[i] = (((t + ID[s]) | 0) % retry) === 0 && !(ON[s] && (FL[s] & 4) === 0) ? 2 : 1;
    }
};

// Stable radix ordering: each partition owns one histogram and scatter cursor.
// Prefixes are reduced in partition order, never in worker claim order. Memory
// is O(units + partitions*256), independent of map area or helper count.
SIM_KERNELS[SIM_KERNEL_SPATIAL_HISTOGRAM] = function (R, P, chunk) {
    const keys = R[P[5] ? 'spatial.keys.' + P[5] : 'spatial.keys'], a = R['spatial.orderA'], b = R['spatial.orderB'];
    const input = P[4] ? b : a, hist = R['spatial.hist'];
    const base = chunk * 256, shift = P[2];
    hist.fill(0, base, base + 256);
    for (let i = chunk * P[1], end = Math.min(P[0], i + P[1]); i < end; i++) {
        const u = P[3] ? i : input[i];
        hist[base + ((keys[u] >>> shift) & 255)]++;
    }
};
SIM_KERNELS[SIM_KERNEL_SPATIAL_SCATTER] = function (R, P, chunk) {
    const keys = R[P[5] ? 'spatial.keys.' + P[5] : 'spatial.keys'], a = R['spatial.orderA'], b = R['spatial.orderB'];
    const input = P[4] ? b : a, output = P[4] ? a : b, hist = R['spatial.hist'];
    const base = chunk * 256, shift = P[2];
    for (let i = chunk * P[1], end = Math.min(P[0], i + P[1]); i < end; i++) {
        const u = P[3] ? i : input[i];
        output[hist[base + ((keys[u] >>> shift) & 255)]++] = u;
    }
};

const _simSpatialOrder = { cap: 0 };
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

SIM_KERNELS[SIM_KERNEL_SEPARATION_PREPARE] = function (R, P, chunk) {
    // Entries of the unit index (spatialIndexRebuild): its slot and chunk,
    // grouped by chunk (sep.rs / sep.rc: a chunk's first entry and count).
    const eslot = R['sep.eslot'], ekey = R['sep.ekey'], rs = R['sep.rs'], rc = R['sep.rc'];
    const flags = R['unit.sepLayer'], X = R['unit.x'], Y = R['unit.y'], DEADS = R['unit.dead'];
    const VX = R['unit.vx'], VY = R['unit.vy'], PREVX = R['unit.prevX'], PREVY = R['unit.prevY'];
    const CR = R['unit.collisionR'], RAD = R['unit.r'], OWNER = R['unit.owner'], ID = R['unit.id'];
    const ord = R['sep.ord'], slots = R['sep.slots'], keys = R['sep.keys'], jobs = R['sep.jobs'];
    const sx = R['sep.sx'], sy = R['sep.sy'], sr = R['sep.sr'], so = R['sep.so'], sid = R['sep.sid'];
    const sl = R['sep.sl'], sc = R['sep.sc'], sdx = R['sep.sdx'], sdy = R['sep.sdy'];
    const chunkR = R['sep.chunkR'], sole = R['sep.sole'], chunkC = R['sep.chunkC'], box = R['sep.box'];
    const rest = P[2] | 0, t0 = P[3] | 0;
    // P[4] 1: at the tick's start (separationStart): moved means moved by
    // itself last tick (unit.sepMov, kept with the unit), not x != prevX.
    const early = P[4] === 1, SMV = R['unit.sepMov'];
    for (let k = chunk * P[1], end = Math.min(P[0], k + P[1]); k < end; k++) {
        const s0 = eslot[k], key = ekey[k];
        // (Units that died since the index was built take no part.)
        const s = s0 >= 0 && DEADS[s0] ? -1 : s0;
        ord[k] = s; slots[k] = s; keys[k] = key; jobs[k] = k;
        if (s < 0) { sc[k] = 0; sx[k] = 1e9; sy[k] = 1e9; sr[k] = .1; so[k] = -3; sl[k] = 255; sid[k] = 0; continue; }
        const x = X[s], y = Y[s], r = Math.max(.1, CR[s] || RAD[s] || .1), owner = OWNER[s];
        sx[k] = x; sy[k] = y; sr[k] = r; so[k] = owner; sid[k] = ID[s] || 0;
        sl[k] = flags[s];
        // Bit 0: takes part this tick; bit 1: moved this tick.
        const movedHere = early ? SMV[s] === 1 : (x !== PREVX[s] || y !== PREVY[s]);
        sc[k] = (movedHere ? 3 : 0) | (rest <= 1 || ((t0 + ID[s]) | 0) % rest === 0 ? 1 : 0);
        // Exact overlaps leave sideways to the motion; a unit at rest picks
        // a side by id.
        let dx = VX[s], dy = VY[s];
        if (Math.sqrt(dx * dx + dy * dy) < .001) { const d = (ID[s] || 0) & 3; dx = d === 0 ? 1 : d === 2 ? -1 : 0; dy = d === 1 ? 1 : d === 3 ? -1 : 0; }
        sdx[k] = dx; sdy[k] = dy;
        // The chunk's first entry: its largest radius, sole owner and
        // whether a unit in it moved.
        if (rs[key] === k) {
            let maxR = 0, oneOwner = -2, moved = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
            for (let j = k, e = k + rc[key]; j < e; j++) {
                const slot = eslot[j];
                if (slot < 0 || DEADS[slot]) continue;
                const otherR = Math.max(.1, CR[slot] || RAD[slot] || .1);
                if (otherR > maxR) maxR = otherR;
                oneOwner = oneOwner === -2 ? OWNER[slot] : (OWNER[slot] === oneOwner ? oneOwner : -1);
                if (early ? SMV[slot] === 1 : (X[slot] !== PREVX[slot] || Y[slot] !== PREVY[slot])) moved = 1;
                const ux = X[slot], uy = Y[slot];
                if (ux < x0) x0 = ux; if (ux > x1) x1 = ux; if (uy < y0) y0 = uy; if (uy > y1) y1 = uy;
            }
            chunkR[key] = maxR; sole[key] = oneOwner; chunkC[key] = moved;
            // Where its members stand now (whole pixels, outward; none: an
            // empty box far away): SIM_KERNEL_SEPARATION skips it beyond reach.
            if (box) {
                const b = key * 4;
                if (x0 <= x1 && y0 <= y1) { box[b] = Math.floor(x0); box[b + 1] = Math.ceil(x1); box[b + 2] = Math.floor(y0); box[b + 3] = Math.ceil(y1); }
                else { box[b] = 2e9; box[b + 1] = 2e9; box[b + 2] = 2e9; box[b + 3] = 2e9; }
            }
        }
    }
};

// Gather the immutable collision snapshot in spatial order from the unit
// columns. The simulation only supplies the permutation and cold path inputs.
SIM_KERNELS[SIM_KERNEL_UNIT_PACK] = function (R, P, chunk) {
    const slots = R['sep.slots'], X = R['unit.x'], Y = R['unit.y'], CR = R['unit.collisionR'], RAD = R['unit.r'];
    const OWNER = R['unit.owner'], ID = R['unit.id'];
    const sx = R['sep.sx'], sy = R['sep.sy'], sr = R['sep.sr'], so = R['sep.so'], sid = R['sep.sid'];
    for (let k = chunk * P[1], end = Math.min(P[0], k + P[1]); k < end; k++) {
        const s = slots[k], r = CR[s] || RAD[s] || .1;
        sx[k] = X[s]; sy[k] = Y[s]; sr[k] = r < .1 ? .1 : r; so[k] = OWNER[s]; sid[k] = ID[s] || 0;
    }
};

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
    const slots = R['frame.slot'], lastX = R['frame.lastX'], lastY = R['frame.lastY'];
    const targetX = R['frame.targetX'], targetY = R['frame.targetY'], still = R['frame.still'], flash = R['frame.flash'];
    const time = P[3], rate = P[4], tile = P[5];
    for (let i = chunk * P[2], end = Math.min(P[1], i + P[2]); i < end; i++) {
        const s = F.order[i], u = slots[s], x = X[u], y = Y[u], vx = VX[u] || 0, vy = VY[u] || 0;
        F.id[s] = ID[u]; F.owner[s] = OWNER[u]; F.energy[s] = ENERGY[u]; F.r[s] = RAD[u]; F.cmd[s] = CMD[u] | 0;
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

// Per-thread scratch.
const _simParScratch = { inc: null, span0: null, span1: null, rem: null, buckets: [], areaMax: null, touched: null, stamps: new Float64Array(3 * 256) };

// Visibility of one player (see computeVisibilityGridForPlayer, which this
// reproduces exactly on typed arrays). Params: W, H, TILE,
// AREA_UNIT_TILE_EQUIVALENT, area count. Arrays: vis.jobs (player, grid)
// pairs, vis.src (x, y, range) triples, vis.srcOff (offset, length) per
// player, vis.areaGrid, vis.nbOff/vis.nb (area neighbours), vis.cellOff/
// vis.cells (area tiles), vis.areaExists, and the output grid vis.g.<player>.<k>.
SIM_KERNELS[SIM_KERNEL_VISIBILITY] = function (R, P, chunk) {
    const W = P[0] | 0, H = P[1] | 0, TILEv = P[2], AUTE = P[3], areaCount = P[4] | 0, N = W * H;
    const jobs = R['vis.jobs'], pid = jobs[chunk * 2], k = jobs[chunk * 2 + 1];
    const out = R['vis.g.' + pid + '.' + k];
    const src = R['vis.src'], srcOff = R['vis.srcOff'];
    const so = srcOff[pid * 2], sn = srcOff[pid * 2 + 1];
    const areaGrid = R['vis.areaGrid'], nbOff = R['vis.nbOff'], nb = R['vis.nb'], cellOff = R['vis.cellOff'], cells = R['vis.cells'], exists = R['vis.areaExists'];
    const S = _simParScratch;
    if (!S.inc || S.inc.length < N) { S.inc = new Uint8Array(N); S.span0 = new Int32Array(H); S.span1 = new Int32Array(H); }
    if (S.span0.length < H) { S.span0 = new Int32Array(H); S.span1 = new Int32Array(H); }
    if (!S.areaMax || S.areaMax.length < areaCount) { S.areaMax = new Float64Array(areaCount).fill(-1); S.touched = new Int32Array(areaCount); S.rem = new Int32Array(areaCount).fill(-1); }
    const inc = S.inc, areaMax = S.areaMax, touched = S.touched, rem = S.rem;
    out.fill(0, 0, N);
    inc.fill(0, 0, N);
    const areaAtTile = (gx, gy) => (gx < 0 || gx >= W || gy < 0 || gy >= H) ? -1 : areaGrid[gy * W + gx];
    let nTouched = 0, stamps = S.stamps, stampCount = 0;
    for (let i = 0; i < sn; i++) {
        let o = (so + i) * 3;
        let x = src[o], y = src[o + 1];
        let range = Math.max(0, Number(src[o + 2]) || 0);
        let areaId = areaAtTile(Math.floor(x / TILEv), Math.floor(y / TILEv));
        let rangeTiles = range * AUTE;
        // Areas under the source's +-0.3 tile window, and the light stamped
        // across area borders (addVisibilitySourceAreas).
        if (range > 0 && Number.isFinite(x) && Number.isFinite(y)) {
            let fx = x / TILEv, fy = y / TILEv;
            let minX = Math.floor(fx - .3), maxX = Math.floor(fx + .3), minY = Math.floor(fy - .3), maxY = Math.floor(fy + .3);
            let centerArea = areaAtTile(Math.floor(fx), Math.floor(fy));
            for (let gy = minY; gy <= maxY; gy++) for (let gx = minX; gx <= maxX; gx++) {
                let area = areaAtTile(gx, gy);
                if (area < 0) continue;
                if (areaMax[area] < 0) { touched[nTouched++] = area; areaMax[area] = 0; }
                if (range > areaMax[area]) areaMax[area] = range;
                if (area !== centerArea) { let t = gy * W + gx, v = range * AUTE; if (v > out[t]) out[t] = v; }
            }
        }
        if (!(range > 0) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (stampCount + 3 > stamps.length) { let g = new Float64Array(stamps.length * 2); g.set(stamps); stamps = S.stamps = g; }
        stamps[stampCount++] = Math.floor(x / TILEv);
        stamps[stampCount++] = Math.floor(y / TILEv);
        stamps[stampCount++] = rangeTiles;
        // The source's own tile.
        {
            let sx = Math.floor(x / TILEv), sy = Math.floor(y / TILEv), r = Math.max(0, rangeTiles);
            if (sx >= 0 && sx < W && sy >= 0 && sy < H && r > 0) { let t = sy * W + sx; if (r > out[t]) out[t] = r; }
        }
        // Outside every area: a circle of tiles around it.
        if (areaId < 0) {
            let cx = Math.floor(x / TILEv), cy = Math.floor(y / TILEv), r = Math.max(0, Math.ceil(rangeTiles));
            if (cx >= 0 && cx < W && cy >= 0 && cy < H && r > 0) {
                let y0 = Math.max(0, cy - r), y1 = Math.min(H - 1, cy + r), x0 = Math.max(0, cx - r), x1 = Math.min(W - 1, cx + r), r2 = r * r;
                for (let yy = y0; yy <= y1; yy++) { let dy = yy - cy; for (let xx = x0; xx <= x1; xx++) { let dx = xx - cx; if (dx * dx + dy * dy <= r2) inc[yy * W + xx] = 1; } }
            }
        }
    }
    if (sn === 0) return;
    // Areas within each source area's range (hop distance over neighbours):
    // one spread from every source at once, most range left first.
    let maxR = 0, buckets = S.buckets;
    for (let i = 0; i < nTouched; i++) {
        let a = touched[i], r = Math.floor(Math.max(0, areaMax[a]));
        areaMax[a] = -1;
        if (!exists[a]) continue;
        if (r > rem[a]) { rem[a] = r; if (r > maxR) maxR = r; }
    }
    for (let d = 0; d <= maxR; d++) { if (buckets[d]) buckets[d].length = 0; else buckets[d] = []; }
    for (let i = 0; i < nTouched; i++) { let a = touched[i]; if (rem[a] >= 0) buckets[rem[a]].push(a); }
    let covered = [];
    for (let d = maxR; d >= 0; d--) {
        let bucket = buckets[d];
        for (let q = 0; q < bucket.length; q++) {
            let a = bucket[q];
            if (rem[a] !== d) continue;
            rem[a] = -2 - d;   // visited
            covered.push(a);
            if (d === 0) continue;
            for (let j = nbOff[a], e = nbOff[a + 1]; j < e; j++) { let n = nb[j]; if (rem[n] >= -1 && rem[n] < d - 1) { rem[n] = d - 1; buckets[d - 1].push(n); } }
        }
    }
    for (let a of covered) { rem[a] = -1; for (let j = cellOff[a], e = cellOff[a + 1]; j < e; j++) inc[cells[j]] = 1; }
    // Values fall by one per tile away from a stamp; only each row's span of
    // tiles within reach of a stamp can be lit (as the reference sweeps).
    const span0 = S.span0, span1 = S.span1;
    span0.fill(W, 0, H); span1.fill(-1, 0, H);
    let y0s = H, y1s = -1;
    for (let i = 0; i < stampCount; i += 3) {
        let reach = Math.ceil(stamps[i + 2]) + 1;
        let x0 = Math.max(0, stamps[i] - reach), x1 = Math.min(W - 1, stamps[i] + reach);
        let y0 = Math.max(0, stamps[i + 1] - reach), y1 = Math.min(H - 1, stamps[i + 1] + reach);
        if (x0 > x1 || y0 > y1) continue;
        if (y0 < y0s) y0s = y0;
        if (y1 > y1s) y1s = y1;
        for (let y = y0; y <= y1; y++) { if (x0 < span0[y]) span0[y] = x0; if (x1 > span1[y]) span1[y] = x1; }
    }
    const lastX = W - 1;
    for (let y = y0s; y <= y1s; y++) {
        if (span1[y] < 0) continue;
        let row = y * W, prev = row - W, hasPrev = y > 0;
        for (let x = span0[y], end = span1[y]; x <= end; x++) {
            if (!inc[row + x]) { out[row + x] = 0; continue; }
            let v = out[row + x];
            if (x > 0 && inc[row + x - 1]) { let n = out[row + x - 1] - 1; if (n > v) v = n; }
            if (hasPrev) {
                if (inc[prev + x]) { let n = out[prev + x] - 1; if (n > v) v = n; }
                if (x > 0 && inc[prev + x - 1]) { let n = out[prev + x - 1] - 1; if (n > v) v = n; }
                if (x < lastX && inc[prev + x + 1]) { let n = out[prev + x + 1] - 1; if (n > v) v = n; }
            }
            out[row + x] = v;
        }
    }
    for (let y = y1s; y >= y0s; y--) {
        if (span1[y] < 0) continue;
        let row = y * W, next = row + W, hasNext = y < H - 1;
        for (let x = span1[y], start = span0[y]; x >= start; x--) {
            if (!inc[row + x]) { out[row + x] = 0; continue; }
            let v = out[row + x];
            if (x < lastX && inc[row + x + 1]) { let n = out[row + x + 1] - 1; if (n > v) v = n; }
            if (hasNext) {
                if (inc[next + x]) { let n = out[next + x] - 1; if (n > v) v = n; }
                if (x < lastX && inc[next + x + 1]) { let n = out[next + x + 1] - 1; if (n > v) v = n; }
                if (x > 0 && inc[next + x - 1]) { let n = out[next + x - 1] - 1; if (n > v) v = n; }
            }
            out[row + x] = v;
        }
    }
};

// Units at rest next to a moving one take part too (they give way to it,
// both sharing the correction), not only on their staggered checks: a unit
// walking into a standing crowd is not pushed back alone. Chunk flags from
// SEPARATION_PREPARE (sep.chunkC, valid where sep.rstamp is the epoch P[2]).
SIM_KERNELS[SIM_KERNEL_SEPARATION_YIELD] = function (R, P, chunk) {
    const sc = R['sep.sc'], keys = R['sep.keys'], ord = R['sep.ord'], chunkC = R['sep.chunkC'], rstamp = R['sep.rstamp'];
    const CW = P[3] | 0, CH = P[4] | 0, ep = P[2] | 0;
    for (let k = chunk * P[1], end = Math.min(P[0], k + P[1]); k < end; k++) {
        if ((sc[k] & 1) || ord[k] < 0) continue;
        const key = keys[k] | 0, cx = key % CW, cy = (key - cx) / CW;
        let near = 0;
        for (let oy = -1; oy <= 1 && !near; oy++) {
            const ny = cy + oy;
            if (ny < 0 || ny >= CH) continue;
            for (let ox = -1; ox <= 1; ox++) {
                const nx = cx + ox;
                if (nx < 0 || nx >= CW) continue;
                const k2 = ny * CW + nx;
                if (rstamp[k2] === ep && chunkC[k2]) { near = 1; break; }
            }
        }
        if (near) sc[k] |= 1;
    }
};

// Unit separation, gathered per unit: each unit that checks this tick sums
// the pushes of every unit touching it, from its own side (a pair is seen
// from both units; each unit is written by one chunk only). Chunks are
// batches of active units. Params: CHUNKS_W, CHUNKS_H, units per job,
// pad, farAny, Q, SHARE_BOTH, SHARE_ONE. Arrays (sorted entries): sep.ord,
// sep.sx/sy/sr (position, radius), sep.so (owner), sep.sl (layer), sep.sc
// (checks), sep.sid (id), sep.sdx/sdy (motion, for exact overlaps); per
// chunk: sep.rs/rc (first entry, count; empty unless sep.rstamp is the
// epoch P[11]), sep.chunkR (largest radius), sep.sole (sole owner); outputs
// by unit index: sep.px/py (integer sums), sep.ov (deepest overlap), sep.hit.
SIM_KERNELS[SIM_KERNEL_SEPARATION] = function (R, P, chunk) {
    const CW = P[0] | 0, CH = P[1] | 0, unitsPerJob = P[2] | 0, pad = P[3], farAny = P[4], Q = P[5], BOTH = P[6], ONE = P[7], cws = P[10], ep = P[11] | 0;
    const MOVER = P[12], YIELD = P[13];
    // Units listed by the tile they had at the index rebuild (the start of
    // the tick): chunks are culled that much more loosely.
    const marginArr = R['sep.margin'], MARGIN = marginArr && marginArr.length ? marginArr[0] : 0;
    const ord = R['sep.ord'], sx = R['sep.sx'], sy = R['sep.sy'], sr = R['sep.sr'], so = R['sep.so'], sl = R['sep.sl'], sc = R['sep.sc'];
    const sid = R['sep.sid'], sdx = R['sep.sdx'], sdy = R['sep.sdy'];
    // Chunk ranges: stamped this epoch, else empty.
    const rs = R['sep.rs'], rc = R['sep.rc'], rstamp = R['sep.rstamp'], chunkR = R['sep.chunkR'], sole = R['sep.sole'];
    const PX = R['sep.px'], PY = R['sep.py'], OV = R['sep.ov'], HIT = R['sep.hit'];
    const jobs = R['sep.jobs'], keys = R['sep.keys'];
    // (P[14]: sep.box holds each stamped chunk's members' box: a neighbour
    // chunk is skipped when the unit is out of reach of all of them.)
    const BOX = P[14] === 1 ? R['sep.box'] : null;
    // Neighbour chunks within reach of any pair (farAny = 2 * the largest
    // radius + padding), and that largest radius.
    const reach = Math.max(1, Math.ceil((farAny + MARGIN) / cws)), maxR = (farAny - pad) / 2;
    for (let j = chunk * unitsPerJob, end = Math.min(P[9], j + unitsPerJob); j < end; j++) {
        const p = jobs[j], a = ord[p];
        if (a < 0) continue;
        if ((sc[p] & 1) === 0) { PX[a] = 0; PY[a] = 0; OV[a] = 0; HIT[a] = 0; continue; }
        const pMoved = (sc[p] & 2) !== 0;
        const key = keys[p] | 0, cx = key % CW, cy = (key - cx) / CW;
        const xp = sx[p], yp = sy[p], rp = sr[p], op = so[p], lp = sl[p];
        // Its distance to its chunk's edges; the neighbour chunks it can
        // touch (a member of one farther than its radius + that chunk's
        // largest + padding is out of reach).
        const ex0 = xp - cx * cws, ex1 = (cx + 1) * cws - xp, ey0 = yp - cy * cws, ey1 = (cy + 1) * cws - yp;
        const lim = rp + maxR + pad + MARGIN;
        const ox0 = ex0 >= lim ? 0 : -Math.min(reach, Math.ceil((lim - ex0) / cws)), ox1 = ex1 >= lim ? 0 : Math.min(reach, Math.ceil((lim - ex1) / cws));
        const oy0 = ey0 >= lim ? 0 : -Math.min(reach, Math.ceil((lim - ey0) / cws)), oy1 = ey1 >= lim ? 0 : Math.min(reach, Math.ceil((lim - ey1) / cws));
        let px = 0, py = 0, ov = 0, hit = 0;
        for (let oy = oy0; oy <= oy1; oy++) {
            const ny = cy + oy;
            if (ny < 0 || ny >= CH) continue;
            const ddy = oy < 0 ? ey0 + (-oy - 1) * cws : (oy > 0 ? ey1 + (oy - 1) * cws : 0);
            for (let ox = ox0; ox <= ox1; ox++) {
                let b0, b1;
                if (ox === 0 && oy === 0) { b0 = rs[key]; b1 = b0 + rc[key]; }
                else {
                    const nx = cx + ox;
                    if (nx < 0 || nx >= CW) continue;
                    const key2 = ny * CW + nx;
                    if (rstamp[key2] !== ep) continue;
                    if (BOX) {
                        const b = key2 * 4, bx = xp < BOX[b] ? BOX[b] - xp : (xp > BOX[b + 1] ? xp - BOX[b + 1] : 0);
                        const by = yp < BOX[b + 2] ? BOX[b + 2] - yp : (yp > BOX[b + 3] ? yp - BOX[b + 3] : 0);
                        const reachB = rp + chunkR[key2] + (sole[key2] === op ? 0 : pad);
                        if (bx * bx + by * by >= reachB * reachB) continue;
                    } else {
                        const ddx = ox < 0 ? ex0 + (-ox - 1) * cws : (ox > 0 ? ex1 + (ox - 1) * cws : 0);
                        const reachP = rp + chunkR[key2] + (sole[key2] === op ? 0 : pad) + MARGIN;
                        if (ddx * ddx + ddy * ddy >= reachP * reachP) continue;
                    }
                    b0 = rs[key2]; b1 = b0 + rc[key2];
                }
                for (let q = b0; q < b1; q++) {
                    if (q === p || sl[q] !== lp) continue;
                    const dx = sx[q] - xp, dy = sy[q] - yp, d2 = dx * dx + dy * dy;
                    const minDist = rp + sr[q] + (so[q] === op ? 0 : pad);
                    if (d2 >= minDist * minDist) continue;
                    const d = Math.sqrt(d2);
                    const overlap = minDist - Math.max(d, 0.001);
                    // The share of the overlap it corrects: even between two
                    // movers or two at rest; a mover against a unit at rest
                    // that gives way (takes part) little, the other most.
                    const qs = sc[q], qMoved = (qs & 2) !== 0;
                    const share = pMoved === qMoved ? ((qs & 1) ? BOTH : ONE) : (pMoved ? ((qs & 1) ? MOVER : ONE) : YIELD);
                    const f = overlap * share * Q;
                    let nxv, nyv;
                    if (d > 0.001) { nxv = -dx / d; nyv = -dy / d; }
                    else {
                        // Exact overlap: sideways to its motion, split by id.
                        const mdx = sdx[p], mdy = sdy[p];
                        const pairSign = sid[p] < sid[q] ? -1 : 1;
                        if (Math.abs(mdx) >= Math.abs(mdy)) { nxv = 0; nyv = (mdx >= 0 ? -1 : 1) * pairSign; }
                        else { nxv = (mdy >= 0 ? 1 : -1) * pairSign; nyv = 0; }
                    }
                    px += Math.round(nxv * f); py += Math.round(nyv * f);
                    if (overlap > ov) ov = overlap;
                    hit++;
                }
            }
        }
        PX[a] = px; PY[a] = py; OV[a] = ov; HIT[a] = hit;
    }
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
    let ctl = new Int32Array(new SharedArrayBuffer(64 * 4));
    let helpers = [];
    for (let i = 0; i < n; i++) {
        try {
            let w = new Worker(helperUrl);
            // A failed helper is not fatal (the worker takes its chunks): keep
            // its error from propagating up to the page's worker as well.
            w.onerror = e => { e.preventDefault(); console.error('[sim helper]', e.message || 'failed to load', e.filename ? `${e.filename}:${e.lineno}` : helperUrl); };
            w.postMessage({ type: 'init', ctl, params: _simParams, bgParams: _simBgParamsByLane, index: i });
            for (let name in _simParReg) w.postMessage({ type: 'bind', name, arr: _simParReg[name], ver: _simParRegVer });
            helpers.push(w);
        } catch (err) { break; }
    }
    if (!helpers.length) return 0;
    _simPool = { ctl, helpers };
    return helpers.length;
}

function simParallelHelpers() { return _simPool ? _simPool.helpers.length : 0; }

// Names an array for the kernels (and gives it to the helpers when new).
function simParallelBind(name, arr) {
    if (_simParReg[name] === arr) return;
    _simParReg[name] = arr;
    _simParRegVer++;
    if (_simPool) for (let w of _simPool.helpers) w.postMessage({ type: 'bind', name, arr, ver: _simParRegVer });
}

// Runs a kernel over chunks 0..total-1 (with the helpers when there are).
function simParallelRun(kernel, total) {
    let fn = SIM_KERNELS[kernel];
    let pool = _simPool;
    if (!pool || total <= 1) { for (let c = 0; c < total; c++) fn(_simParReg, _simParams, c); return; }
    let ctl = pool.ctl;
    // Closed (odd) while this job is written; the last one's helpers leave.
    Atomics.add(ctl, SIM_PAR_GEN, 1);
    for (let a; (a = Atomics.load(ctl, SIM_PAR_ACTIVE)) !== 0;) Atomics.wait(ctl, SIM_PAR_ACTIVE, a, 5);
    ctl[SIM_PAR_KERNEL] = kernel; ctl[SIM_PAR_TOTAL] = total; ctl[SIM_PAR_DONE] = 0; ctl[SIM_PAR_REGVER] = _simParRegVer;
    Atomics.store(ctl, SIM_PAR_NEXT, 0);
    Atomics.add(ctl, SIM_PAR_GEN, 1);
    Atomics.notify(ctl, SIM_PAR_GEN);
    for (;;) {
        let c = Atomics.add(ctl, SIM_PAR_NEXT, 1);
        if (c >= total) break;
        fn(_simParReg, _simParams, c);
        Atomics.add(ctl, SIM_PAR_DONE, 1);
    }
    for (let d; (d = Atomics.load(ctl, SIM_PAR_DONE)) < total;) Atomics.wait(ctl, SIM_PAR_DONE, d, 5);
}

// ---- background jobs ----
// A kernel run whose result is needed later (the tick's separation, a
// navigation build's stages): the helpers take its chunks whenever no
// foreground job waits for them (lane 0 before lane 1), the simulation
// thread none until simParallelBackgroundWait, where it takes what is left
// and waits for the rest. Its inputs must stay as they are until then (the
// kernels are pure; its parameters are the lane's, _simBgParamsByLane, set
// by the caller before this). One per lane at a time: a new one waits for
// the lane's last. Without helpers it runs at the wait, the same result.
const _simBg = new Array(SIM_PAR_BG_LANES).fill(null);
let _simBgId = 0;
function simParallelBackground(kernel, total, lane = 1) {
    simParallelBackgroundWait(lane);
    if (!(total > 0)) return;
    const pool = _simPool;
    _simBgId = (_simBgId + 1) & 0x7F;
    _simBg[lane] = { kernel, total, id: _simBgId, sync: !pool };
    if (!pool) return;
    const ctl = pool.ctl, b = SIM_PAR_BG_BASE + lane * 8;
    ctl[b + SIM_PAR_BG_KERNEL] = kernel; ctl[b + SIM_PAR_BG_TOTAL] = total; ctl[b + SIM_PAR_BG_DONE] = 0; ctl[b + SIM_PAR_BG_REGVER] = _simParRegVer;
    Atomics.store(ctl, b + SIM_PAR_BG_NEXT, _simBgId << 24);
    // Idle helpers wake (no new foreground job: the generation stays even).
    Atomics.add(ctl, SIM_PAR_GEN, 2);
    Atomics.notify(ctl, SIM_PAR_GEN);
}
function simParallelBackgroundWait(lane = 1) {
    const J = _simBg[lane];
    if (!J) return;
    _simBg[lane] = null;
    const fn = SIM_KERNELS[J.kernel], P = _simBgParamsByLane[lane];
    if (J.sync) { for (let c = 0; c < J.total; c++) fn(_simParReg, P, c); return; }
    const ctl = _simPool.ctl, b = SIM_PAR_BG_BASE + lane * 8;
    for (;;) {
        const v = Atomics.add(ctl, b + SIM_PAR_BG_NEXT, 1), c = v & 0xFFFFFF;
        if (c >= J.total) break;
        fn(_simParReg, P, c);
        Atomics.add(ctl, b + SIM_PAR_BG_DONE, 1);
    }
    for (let d; (d = Atomics.load(ctl, b + SIM_PAR_BG_DONE)) < J.total;) Atomics.wait(ctl, b + SIM_PAR_BG_DONE, d, 5);
}
function simParallelBackgroundPending(lane = 1) { return !!_simBg[lane]; }

// ---- a helper's side (sim_helper.js) ----
function simParallelHelperMain() {
    let ctl = null, seen = 0, regVer = 0, bgParams = null;
    self.onmessage = ev => {
        let m = ev.data || {};
        if (m.type === 'init') {
            ctl = m.ctl;
            _simParHelperParams = m.params;
            bgParams = m.bgParams;
            loop();
        } else if (m.type === 'bind') {
            _simParReg[m.name] = m.arr;
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
                    fn(_simParReg, _simParHelperParams, c);
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
                    if (regVer < ctl[b + SIM_PAR_BG_REGVER]) continue;
                    const v = Atomics.add(ctl, b + SIM_PAR_BG_NEXT, 1), c = v & 0xFFFFFF;
                    if (c >= ctl[b + SIM_PAR_BG_TOTAL]) continue;
                    SIM_KERNELS[ctl[b + SIM_PAR_BG_KERNEL]](_simParReg, bgParams[lane], c);
                    Atomics.add(ctl, b + SIM_PAR_BG_DONE, 1);
                    Atomics.notify(ctl, b + SIM_PAR_BG_DONE);
                    ran = true;
                }
                if (!ran) break;
            }
        }
    }
}
let _simParHelperParams = null;

// ---- The unit index (chunk.js spatialIndexRebuild), in parallel ----
// Entries grouped by chunk (tile) in chunk order and by area in area order,
// each group in the units array's order (shared by every peer): counts
// (atomic), prefix sums (the simulation thread), atomic placement, then
// each group sorted back into units order. Arrays: ix.slots (units index ->
// slot), ix.keys / ix.areas (per units index), ix.cnt / ix.fill / ix.start
// per chunk, ix.acnt / ix.afill / ix.astart / ix.aown per area, ix.ent /
// ix.aent (entry -> units index), sep.eslot / sep.ekey.
// P: [0] units, [1] per job, [2] chunks, [3] areas, [4] players, [5] absent,
// [6] chunk jobs (INDEX_CLEAR / INDEX_ORDER: jobs past it are areas), [7] per chunk job, [8] per area job.
SIM_KERNELS[SIM_KERNEL_INDEX_CLEAR] = function (R, P, chunk) {
    const cj = P[6] | 0;
    if (chunk < cj) {
        const a = chunk * P[7], b = Math.min(P[2], a + P[7]);
        R['ix.cnt'].fill(0, a, b); R['ix.fill'].fill(0, a, b);
    } else {
        const a = (chunk - cj) * P[8], b = Math.min(P[3], a + P[8]), players = P[4] | 0;
        R['ix.acnt'].fill(0, a, b); R['ix.afill'].fill(0, a, b); R['ix.aown'].fill(0, a * players, b * players);
    }
};
SIM_KERNELS[SIM_KERNEL_INDEX_COUNT] = function (R, P, chunk) {
    const SL = R['ix.slots'], X = R['unit.x'], Y = R['unit.y'], DEAD = R['unit.dead'], AG = R['ix.agrid'], OWN = R['unit.owner'];
    const keys = R['ix.keys'], areas = R['ix.areas'], cnt = R['ix.cnt'], acnt = R['ix.acnt'], aown = R['ix.aown'], bad = R['ix.bad'];
    const nChunks = P[2] | 0, A = P[3] | 0, players = P[4] | 0;
    const tile = P[9], GW = P[10] | 0, GH = P[11] | 0, CS = P[12] | 0, CW = P[13] | 0;
    for (let i = chunk * P[1], end = Math.min(P[0], i + P[1]); i < end; i++) {
        const si = SL[i];
        if (si < 0) { keys[i] = -1; areas[i] = -1; Atomics.store(bad, 0, 1); continue; }
        // Every unit not dead, by the tile it stands on (clamped to the map).
        if (DEAD[si]) { keys[i] = -1; areas[i] = -1; continue; }
        let gx = Math.floor(X[si] / tile), gy = Math.floor(Y[si] / tile);
        if (!(gx >= 0)) gx = 0; else if (gx >= GW) gx = GW - 1;
        if (!(gy >= 0)) gy = 0; else if (gy >= GH) gy = GH - 1;
        const k = CS === 1 ? gy * GW + gx : Math.floor(gy / CS) * CW + Math.floor(gx / CS);
        if (!(k >= 0 && k < nChunks)) { keys[i] = -1; areas[i] = -1; continue; }
        keys[i] = k;
        Atomics.add(cnt, k, 1);
        const a = AG[gy * GW + gx];
        if (!(a >= 0 && a < A)) { areas[i] = -1; continue; }
        areas[i] = a;
        Atomics.add(acnt, a, 1);
        const o = OWN[si];
        if (o >= 0 && o < players) Atomics.add(aown, a * players + o, 1);
    }
};
SIM_KERNELS[SIM_KERNEL_INDEX_SCATTER] = function (R, P, chunk) {
    const keys = R['ix.keys'], areas = R['ix.areas'], start = R['ix.start'], fill = R['ix.fill'], ent = R['ix.ent'];
    const astart = R['ix.astart'], afill = R['ix.afill'], aent = R['ix.aent'];
    for (let i = chunk * P[1], end = Math.min(P[0], i + P[1]); i < end; i++) {
        const k = keys[i];
        if (k < 0) continue;
        ent[start[k] + Atomics.add(fill, k, 1)] = i;
        const a = areas[i];
        if (a >= 0) aent[astart[a] + Atomics.add(afill, a, 1)] = i;
    }
};
function _simIndexSortRange(E, a, b) {
    for (let j = a + 1; j < b; j++) {
        const v = E[j];
        let q = j - 1;
        while (q >= a && E[q] > v) { E[q + 1] = E[q]; q--; }
        E[q + 1] = v;
    }
}
SIM_KERNELS[SIM_KERNEL_INDEX_ORDER] = function (R, P, chunk) {
    const cj = P[6] | 0;
    if (chunk < cj) {
        const cnt = R['ix.cnt'], start = R['ix.start'], ent = R['ix.ent'], SL = R['ix.slots'];
        const eslot = R['sep.eslot'], ekey = R['sep.ekey'];
        for (let k = chunk * P[7], end = Math.min(P[2], k + P[7]); k < end; k++) {
            const c = cnt[k];
            if (c === 0) continue;
            const a = start[k], b = a + c;
            if (c > 1) _simIndexSortRange(ent, a, b);
            for (let e = a; e < b; e++) { eslot[e] = SL[ent[e]]; ekey[e] = k; }
        }
    } else {
        const acnt = R['ix.acnt'], astart = R['ix.astart'], aent = R['ix.aent'];
        for (let k = (chunk - cj) * P[8], end = Math.min(P[3], k + P[8]); k < end; k++) {
            const c = acnt[k];
            if (c > 1) _simIndexSortRange(aent, astart[k], astart[k] + c);
        }
    }
};

// Same-owner same-type units around each due unit (things_utils.js
// _countNearbySameTypeUnits): the sum of its window of the per-chunk counts
// (spatial.cplx). eff.win per due unit: x1, y1, x2, y2, lane (-1: none).
// P: [0] due units, [1] per job, [2] chunks per row, [3] ints per chunk.
// Units' effective stats (things_utils.js recalculateUnitEffectiveStats):
// for the strided share (entry j: units[P[3] + j * P[2]]), from the columns,
// as _effStatsFullUnit does it: base stacks and level, the same-owner
// same-type count over its window of the spatial chunk counts, effective
// stacks and level. eff.flag[j]: 0 done, 1 done and its effective level
// changed (the caller applies its tables), 2 for the caller (no slot, base
// tables to make, no window or count), 3 nothing (dead, taken already).
// P: [0] entries, [1] per job, [2] step, [3] phase, [4] chunk px,
// [5]/[6] chunks wide/high, [7] stride per chunk, [8] per player,
// [9] players, [10] MAX_THING_LEVEL, [11] stamp (unit.esTaken); [12] the
// upkeep bins' players (0: no bins), [13] their levels + 1: a unit whose
// levels it wrote moves bins (unit.upB, upk.h; main.js _upkUnitBin).
SIM_KERNELS[SIM_KERNEL_EFF_UNITS] = function (R, P, chunk) {
    const SL = R['ix.slots'], DEAD = R['unit.dead'], OK = R['unit.esOk'], RAD = R['unit.esRad'], TYP = R['unit.esType'], TAKEN = R['unit.esTaken'];
    const STK = R['unit.stackCount'], ULV = R['unit.unitLevel'], BLV = R['unit.baseLevel'], ESK = R['unit.effectiveStacks'], ELV = R['unit.effectiveLevel'], LAST = R['unit._lastAppliedEffectiveLevel'];
    const X = R['unit.x'], Y = R['unit.y'], OWN = R['unit.owner'], data = R['spatial.cplx'], F = R['eff.flag'];
    const step = P[2] | 0, phase = P[3] | 0, chunkPx = P[4], CW = P[5] | 0, CH = P[6] | 0, strideC = P[7] | 0, strideP = P[8] | 0, players = P[9] | 0, maxL = P[10], stamp = P[11] | 0;
    const UNP = P[12] | 0, UL1 = P[13] | 0, UT = R['unit.upT'], UB = R['unit.upB'], UH = R['upk.h'];
    // stackCountToLevel (detFloorLog2, clampThingLevel).
    const lvl = st => {
        let v = Math.floor(Math.max(1, Number(st) || 1)), k = 0;
        if (v < 2147483648) k = 31 - Math.clz32(v); else while (v >= 2) { v = Math.floor(v / 2); k++; }
        return Math.max(1, Math.max(0, Math.min(maxL, Math.floor(k + 1))));
    };
    for (let j = chunk * P[1], end = Math.min(P[0], j + P[1]); j < end; j++) {
        const s = SL[phase + j * step];
        if (s < 0) { F[j] = 2; continue; }
        if (DEAD[s] || TAKEN[s] === stamp) { F[j] = 3; continue; }
        const sc = STK[s];
        if (!OK[s] || !(sc >= 1 && sc < Infinity)) { F[j] = 2; continue; }
        const base = Math.floor(sc), bl = lvl(base);
        if (BLV[s] !== bl) { F[j] = 2; continue; }
        STK[s] = base; ULV[s] = bl;
        const o = Math.floor(OWN[s]);
        if (!(o >= 0 && o < players)) { F[j] = 2; continue; }
        const cx = Math.floor(X[s] / chunkPx), cy = Math.floor(Y[s] / chunkPx), r = RAD[s];
        const x1 = Math.max(0, Math.min(CW - 1, cx - r)), y1 = Math.max(0, Math.min(CH - 1, cy - r));
        const x2 = Math.max(0, Math.min(CW - 1, cx + r)), y2 = Math.max(0, Math.min(CH - 1, cy + r));
        if (!(x1 <= x2 && y1 <= y2)) { F[j] = 2; continue; }
        const lane = o * strideP + 1 + TYP[s];
        let sum = 0;
        for (let y = y1; y <= y2; y++) {
            let idx = (y * CW + x1) * strideC + lane;
            for (let x = x1; x <= x2; x++, idx += strideC) sum += data[idx];
        }
        sum |= 0;
        if (sum <= 0) { F[j] = 2; continue; }
        const effS = Math.max(1, Math.floor(sum * base)), el = lvl(effS);
        ESK[s] = effS; ELV[s] = el; TAKEN[s] = stamp;
        F[j] = LAST[s] === el ? 0 : 1;
        if (UNP) {
            // (Its effective level is finite now: the bin's level.)
            const t = UT[s], b = t >= 0 && o < UNP ? (t * UNP + o) * UL1 + Math.max(1, Math.min(UL1 - 1, el)) : -1, ob = UB[s];
            if (b !== ob && b < UH.length) { if (ob >= 0) Atomics.sub(UH, ob, 1); if (b >= 0) Atomics.add(UH, b, 1); UB[s] = b; }
        }
    }
};

// The units' visibility snapshot (renderer.js _visCoverUnits, a tier's
// input): per slot its position (vt.x, vt.y) and, for a live, indexed unit
// registered this generation with a range (vsGen = P[2], vsR steps), its
// key vt.key = steps | (vsP1 + 1) << 8 | (vsP2 + 1) << 16 (its player and a
// watching team), else -1.
// P: [0] slots, [1] per job, [2] coverage generation, [3] SIM_SEP_ABSENT.
SIM_KERNELS[SIM_KERNEL_VIS_SNAP] = function (R, P, chunk) {
    const X = R['unit.x'], Y = R['unit.y'], DEAD = R['unit.dead'], SK = R['unit.sepKey'];
    const VG = R['unit.vsGen'], VR = R['unit.vsR'], V1 = R['unit.vsP1'], V2 = R['unit.vsP2'];
    const TX = R['vt.x'], TY = R['vt.y'], KEY = R['vt.key'], gen = P[2] | 0, absent = P[3];
    for (let s = chunk * P[1], end = Math.min(P[0], s + P[1]); s < end; s++) {
        TX[s] = X[s]; TY[s] = Y[s];
        const r = VR[s];
        KEY[s] = VG[s] !== gen || DEAD[s] || SK[s] === absent || r < 0 ? -1 : (r & 63) | ((V1[s] + 1) << 8) | ((V2[s] + 1) << 16);
    }
};

// Units' visibility seeds (renderer.js _visCoverUnits): every unit of the
// snapshot (vt.*, SIM_KERNEL_VIS_SNAP) with a key marks the areas under its
// +-0.3 tile window (vt.agrid: the area of each tile, -1 none) for its
// player and a watching team with the most steps per area:
// vis.useed[player * A + area] = stamp << 6 | steps (an older stamp is no
// seed). The first mark of an area this stamp lists it in vis.ulist (from
// player * A, vis.ucnt[player] entries, in no particular order).
// P: [0] slots, [1] per job, [2] TILE, [3]/[4] grid, [6] areas, [7]
// players, [8] stamp.
SIM_KERNELS[SIM_KERNEL_VIS_SEED] = function (R, P, chunk) {
    const X = R['vt.x'], Y = R['vt.y'], KEY = R['vt.key'];
    const SEED = R['vis.useed'], LIST = R['vis.ulist'], CNT = R['vis.ucnt'], AG = R['vt.agrid'];
    const tile = P[2], W = P[3] | 0, H = P[4] | 0, A = P[6] | 0, np = P[7] | 0, stamp = P[8] | 0;
    for (let s = chunk * P[1], end = Math.min(P[0], s + P[1]); s < end; s++) {
        const key = KEY[s];
        if (key < 0) continue;
        const r = key & 63;
        const fx = X[s] / tile, fy = Y[s] / tile;
        if (!(fx > -1e9 && fx < 1e9 && fy > -1e9 && fy < 1e9)) continue;
        const gx = Math.floor(fx), gy = Math.floor(fy), rx = fx - gx, ry = fy - gy;
        const x0 = rx < .3 ? gx - 1 : gx, x1 = rx < .7 ? gx : gx + 1, y0 = ry < .3 ? gy - 1 : gy, y1 = ry < .7 ? gy : gy + 1;
        const p1 = ((key >> 8) & 255) - 1, p2 = ((key >> 16) & 255) - 1, val = (stamp << 6) | r;
        for (let ty = y0; ty <= y1; ty++) {
            if (ty < 0 || ty >= H) continue;
            for (let tx = x0; tx <= x1; tx++) {
                if (tx < 0 || tx >= W) continue;
                const a = AG[ty * W + tx];
                if (!(a >= 0 && a < A)) continue;
                if (p1 >= 0 && p1 < np) _simVisSeed(SEED, LIST, CNT, p1, p1 * A, a, val, stamp);
                if (p2 >= 0 && p2 < np) _simVisSeed(SEED, LIST, CNT, p2, p2 * A, a, val, stamp);
            }
        }
    }
};
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
SIM_KERNELS[SIM_KERNEL_LASER_HITS] = function (R, P, chunk) {
    const X = R['unit.x'], Y = R['unit.y'], DEAD = R['unit.dead'], SEP = R['unit.sepKey'], OWN = R['unit.owner'], EN = R['unit.energy'], UID = R['unit.id'];
    const LZF = R['unit.lzFlags'], ACC = R['unit.lzAcc'], LB = R['unit.lzBeam'], EV = R['unit.lzEv'];
    const HEAD = R['lz.head'], NEXT = R['lz.next'], BEAM = R['lz.beam'], BOWN = R['lz.bown'], BDMG = R['lz.bdmg'], HIT = R['lz.hit'], CNT = R['lz.count'];
    const tile = P[2], W = P[3] | 0, H = P[4] | 0, t = P[5] | 0, per = Math.max(1, P[6] | 0), absent = P[7];
    let n = 0;
    for (let s = chunk * P[1], end = Math.min(P[0], s + P[1]); s < end; s++) {
        EV[s] = 0;
        if (DEAD[s] || SEP[s] === absent) continue;
        const gx = Math.floor(X[s] / tile), gy = Math.floor(Y[s] / tile);
        if (gx < 0 || gy < 0 || gx >= W || gy >= H) continue;
        let e = HEAD[gy * W + gx];
        if (e < 0) continue;
        const own = OWN[s] | 0, fl = LZF[s];
        if (fl & 1) continue;
        let dmg = 0, last = -1;
        for (; e >= 0; e = NEXT[e]) {
            const b = BEAM[e];
            if ((BOWN[b] | 0) === own) continue;
            HIT[b] = 1;
            if (fl & 2) continue;
            dmg += BDMG[b]; last = b;
        }
        if (!(dmg > 0)) continue;
        EN[s] -= dmg; ACC[s] += dmg; LB[s] = last;
        const died = !(EN[s] > 0);
        if (died) DEAD[s] = 1;
        if (died || ((t + (UID[s] | 0)) % per) === 0) { EV[s] = 1; n++; }
    }
    CNT[chunk] = n;
};

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
    for (let s = chunk * P[1], end = Math.min(P[0], s + P[1]); s < end; s++) {
        if (CMD[s] !== cmdMove || DEAD[s] || SEP[s] === absent || !SHOOT[s] || AT[s] > 0) continue;
        const id = ID[s] | 0;
        if (((t + id) & 1) !== 0) continue;
        DBTK[s] = t; DBT[s] = -2; DBS[s] = -1;
        const owner = OWN[s] | 0, area = AREA[s], steps = RD[s];
        if (!(owner >= 0 && owner < players) || !(area >= 0) || steps === 255) continue;
        const kb = area * BOXSTEPS + steps;
        if (!ABOK[kb]) continue;
        const cov = COV[owner];
        if (!cov) continue;
        const x0 = Math.max(0, AB[kb * 4]), y0 = Math.max(0, AB[kb * 4 + 1]), x1 = Math.min(W - 1, AB[kb * 4 + 2]), y1 = Math.min(H - 1, AB[kb * 4 + 3]);
        const k = RK[s], whole = (LZF[s] & 4) !== 0, x = X[s], y = Y[s];
        const foe = owner < 8 ? (0xFF ^ (1 << owner)) : 0xFF;
        // Nothing hostile (units or structures) in the blocks of its box:
        // nothing to find (mv.hostile).
        if (HS && x0 <= x1 && y0 <= y1) {
            const bx0 = Math.floor(x0 / Bk), by0 = Math.floor(y0 / Bk), bx1 = Math.min(bc - 1, Math.floor(x1 / Bk)), by1 = Math.min(br - 1, Math.floor(y1 / Bk)), o = owner * plane;
            if (bx0 <= bx1 && by0 <= by1 && HS[o + (by1 + 1) * stride + bx1 + 1] - HS[o + by0 * stride + bx1 + 1] - HS[o + (by1 + 1) * stride + bx0] + HS[o + by0 * stride + bx0] <= 0) { DBT[s] = -1; continue; }
        }
        let best = -1, bd2 = Infinity, unknown = false;
        if (x0 <= x1 && y0 <= y1) {
            const cx0 = Math.floor(x0 / cs), cy0 = Math.floor(y0 / cs), cx1 = Math.min(CW - 1, Math.floor(x1 / cs)), cy1 = Math.min(CH - 1, Math.floor(y1 / cs));
            for (let cy = cy0; cy <= cy1 && !unknown; cy++) for (let cx = cx0; cx <= cx1 && !unknown; cx++) {
                const ck = cy * CW + cx;
                if (rst[ck] !== ep || (OM && (OM[ck] & foe) === 0)) continue;
                for (let e = rs[ck], e1 = e + rc[ck]; e < e1; e++) {
                    const q = es[e];
                    if (q < 0 || DEAD[q] || (OWN[q] | 0) === owner) continue;
                    const tx = X0[q], ty = Y0[q], qgx = Math.floor(tx / tile), qgy = Math.floor(ty / tile);
                    if (qgx < x0 || qgy < y0 || qgx > x1 || qgy > y1) continue;
                    const a = AG[qgy * W + qgx];
                    if (!(a >= 0) || !(cov[a] > 0)) continue;
                    const r = whole ? _simInAreaRange(AG, AOFF, ANB, W, H, tile, x, y, tx, ty, k) : _simUnitInAttackRange(AG, AOFF, ANB, WALL, CRC, RRC, W, H, tile, pad, s, q, x, y, tx, ty, k);
                    if (r < 0) { unknown = true; break; }
                    if (r !== 1) continue;
                    const dx = tx - x, dy = ty - y, d2 = dx * dx + dy * dy;
                    if (d2 < bd2 || (d2 === bd2 && (ID[q] | 0) < (ID[best] | 0))) { best = q; bd2 = d2; }
                }
            }
        }
        if (unknown) continue;
        if (best >= 0) { DBT[s] = best; DBTI[s] = ID[best] | 0; continue; }
        DBT[s] = -1;
        if (!(x0 <= x1 && y0 <= y1)) continue;
        if (HSS) {
            const bx0 = Math.floor(x0 / Bk), by0 = Math.floor(y0 / Bk), bx1 = Math.min(bc - 1, Math.floor(x1 / Bk)), by1 = Math.min(br - 1, Math.floor(y1 / Bk)), o = owner * plane;
            if (bx0 <= bx1 && by0 <= by1 && HSS[o + (by1 + 1) * stride + bx1 + 1] - HSS[o + by0 * stride + bx1 + 1] - HSS[o + (by1 + 1) * stride + bx0] + HSS[o + by0 * stride + bx0] <= 0) continue;
        }
        let bestT = -1, bestR = 9, bestD = Infinity;
        for (let gy = y0; gy <= y1 && !unknown; gy++) for (let gx = x0, tt = gy * W + x0; gx <= x1; gx++, tt++) {
            const cls = SCLS[tt];
            if (cls <= 0) continue;
            const rank = cls === 1 ? 0 : cls === 2 ? 2 : 3;
            if (rank > bestR) continue;
            const code = SC[tt];
            if (code === -1 || code === owner) continue;
            const a = AG[tt];
            if (!(a >= 0) || !(cov[a] > 0)) continue;
            const cxp = gx * tile + half, cyp = gy * tile + half, dx = cxp - x, dy = cyp - y, d2 = dx * dx + dy * dy;
            if (rank === bestR && (d2 > bestD || (d2 === bestD && tt > bestT))) continue;
            const r = _simInAreaRange(AG, AOFF, ANB, W, H, tile, x, y, cxp, cyp, k);
            if (r < 0) { unknown = true; break; }
            if (r !== 1) continue;
            bestT = tt; bestR = rank; bestD = d2;
        }
        if (unknown) { DBT[s] = -2; continue; }
        DBS[s] = bestT;
    }
};

// The worker search tier (worker.js workerSearchTierStep).
// SIM_KERNEL_WS_SELECT (the post, every slot chunk of P[1]): a registered
// worker (unit.wsKind, alive) due a search, the first post after it
// registered (within P[3] ticks) and then once in P[4] ticks ((tick + id) %
// P[4] < P[3]): its request at ws.r*[chunk * P[1] + m] (its registry's
// values; its origin where it stands without one or before unit.wsOU), how
// many at ws.rcnt[chunk]. P: [0] slots, [1] per job, [2] tick, [3] WS_TICKS,
// [4] retry ticks.
SIM_KERNELS[SIM_KERNEL_WS_SELECT] = function (R, P, chunk) {
    const KIND = R['unit.wsKind'], CFG = R['unit.wsCfg'], WT = R['unit.wsT'], OU = R['unit.wsOU'], WOX = R['unit.wsOx'], WOY = R['unit.wsOy'], WR = R['unit.wsR'];
    const WAX = R['unit.wsAx'], WAY = R['unit.wsAy'], WAK = R['unit.wsAk'], WN = R['unit.wsNeed'], WJ = R['unit.wsJid'], WC = R['unit.wsCur'], WM = R['unit.wsMy'];
    const X = R['unit.x'], Y = R['unit.y'], OWN = R['unit.owner'], ID = R['unit.id'], DEAD = R['unit.dead'];
    const RS = R['ws.rslot'], RID = R['ws.rid'], RWT = R['ws.rwt'], RK = R['ws.rkind'], RO = R['ws.rowner'], ROX = R['ws.rox'], ROY = R['ws.roy'], RUX = R['ws.rux'], RUY = R['ws.ruy'];
    const RR = R['ws.rr'], RAK = R['ws.rak'], RAX = R['ws.rax'], RAY = R['ws.ray'], RG = R['ws.rgrp'], RN = R['ws.rneed'], RJ = R['ws.rjid'], RC = R['ws.rcur'], RM = R['ws.rmy'], CNT = R['ws.rcnt'];
    const t = P[2] | 0, WT4 = P[3] | 0, RETRY = Math.max(1, P[4] | 0), b0 = chunk * P[1];
    let m = 0;
    for (let s = b0, end = Math.min(P[0], b0 + P[1]); s < end; s++) {
        const k = KIND[s];
        if (!k || DEAD[s]) continue;
        const id = ID[s] | 0;
        if (!(t - WT[s] < WT4 || ((t + id) % RETRY) < WT4)) continue;
        const i = b0 + m++, x = X[s], y = Y[s], ox = WOX[s], self = !(ox === ox) || t < OU[s];
        RS[i] = s; RID[i] = id; RWT[i] = WT[s]; RK[i] = k; RO[i] = OWN[s] | 0; ROX[i] = self ? x : ox; ROY[i] = self ? y : WOY[s]; RUX[i] = x; RUY[i] = y;
        RR[i] = WR[s]; RAK[i] = WAK[s]; RAX[i] = WAX[s]; RAY[i] = WAY[s]; RG[i] = CFG[s]; RN[i] = WN[s]; RJ[i] = WJ[s]; RC[i] = WC[s]; RM[i] = WM[s];
    }
    CNT[chunk] = m;
};
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
// P: [0] requests, [1] per job, [2] K, [3] TILE, [4] bucket tiles, [7] drop
// penalty, [8]/[9] grid, [10] the work grid's 8x8 blocks wide, [11] select
// chunks, [12] slots a select chunk.
let _wsAreaStamp = null, _wsAreaStampV = 0;
function _wsAreasWithin(AG, OFF, NB, W, H, tile, x, y, k) {
    const A = OFF.length - 1;
    if (!_wsAreaStamp || _wsAreaStamp.length < A) { _wsAreaStamp = new Int32Array(Math.max(1024, A)); _wsAreaStampV = 0; }
    const st = ++_wsAreaStampV, S = _wsAreaStamp;
    const fx = x / tile, fy = y / tile, gx = Math.floor(fx), gy = Math.floor(fy), rx = fx - gx, ry = fy - gy;
    const x0 = rx < .3 ? gx - 1 : gx, x1 = rx < .7 ? gx : gx + 1, y0 = ry < .3 ? gy - 1 : gy, y1 = ry < .7 ? gy : gy + 1;
    let cur = [];
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const a = AG[yy * W + xx];
        if (a >= 0 && a < A && S[a] !== st) { S[a] = st; cur.push(a); }
    }
    for (let d = 0; d < k && cur.length; d++) {
        const nx = [];
        for (const a of cur) for (let j = OFF[a], j1 = OFF[a + 1]; j < j1; j++) { const q = NB[j]; if (S[q] !== st) { S[q] = st; nx.push(q); } }
        cur = nx;
    }
    return st;
}
// Into the K best at o0 (score, then lower site).
function _wsInsert(OUT, OSC, o0, K, s, sc) {
    let k = K - 1;
    if (sc > OSC[o0 + k] || (sc === OSC[o0 + k] && OUT[o0 + k] >= 0 && s > OUT[o0 + k])) return;
    while (k > 0 && (sc < OSC[o0 + k - 1] || (sc === OSC[o0 + k - 1] && (OUT[o0 + k - 1] < 0 || s < OUT[o0 + k - 1])))) { OSC[o0 + k] = OSC[o0 + k - 1]; OUT[o0 + k] = OUT[o0 + k - 1]; k--; }
    OSC[o0 + k] = sc; OUT[o0 + k] = s;
}
SIM_KERNELS[SIM_KERNEL_WS_SCAN] = function (R, P, chunk) {
    const RK = R['ws.rkind'], RO = R['ws.rowner'], ROX = R['ws.rox'], ROY = R['ws.roy'], RUX = R['ws.rux'], RUY = R['ws.ruy'], RR = R['ws.rr'], RAK = R['ws.rak'], RAX = R['ws.rax'], RAY = R['ws.ray'], RG = R['ws.rgrp'];
    const RN = R['ws.rneed'], RJ = R['ws.rjid'], RC = R['ws.rcur'], RM = R['ws.rmy'], PRE = R['ws.rpre'];
    const OUT = R['ws.res'], OSC = R['ws.score'], UOUT = R['ws.ures'], AG = R['ws.agrid'], AOFF = R['ws.aoff'], ANB = R['ws.anb'];
    const HX = R['wsh.x'], HY = R['wsh.y'], HA = R['wsh.a'], HN = R['wsh.n'], HMAX = P[13] | 0;
    const F = R['wsw.flags'], O = R['wsw.own'], SA = R['wsw.area'], RV = R['wsw.resv'], WCNT = R['wsw.cnt'];
    const K = P[2] | 0, tile = P[3], BT = P[4] | 0, dropPen = P[7], W = P[8] | 0, H = P[9] | 0, GBW = P[10] | 0, nreg = P[11] | 0, CH = P[12] | 0, half = tile * 0.5;
    const g0 = chunk * P[1], g1 = Math.min(P[0], g0 + P[1]);
    // (The select chunk of g0: the last whose first request is at or before it.)
    let c = 0;
    { let lo = 0, hi = nreg - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (PRE[mid] <= g0) lo = mid; else hi = mid - 1; } c = lo; }
    for (let g = g0; g < g1; g++) {
        while (c + 1 < nreg && PRE[c + 1] <= g) c++;
        const i = c * CH + (g - PRE[c]), o0 = i * K;
        for (let k = 0; k < K; k++) { OUT[o0 + k] = -1; OSC[o0 + k] = Infinity; }
        const kind = RK[i], owner = RO[i] | 0, ox = ROX[i], oy = ROY[i], r = RR[i], r2 = r * r, ak = RAK[i] | 0;
        if (kind === 4) { UOUT[i * 3] = -1; UOUT[i * 3 + 1] = -1; UOUT[i * 3 + 2] = -1; }
        // (The areas within the steps: stamped.)
        const st = ak >= 0 && AG && AOFF && ANB ? _wsAreasWithin(AG, AOFF, ANB, W, H, tile, ox, oy, ak) : 0, AS = _wsAreaStamp;
        if (kind >= 3) {
            if (!F) continue;
            const nd = RN[i], rb = (nd >> 16) & 255, jid = RJ[i], cur = RC[i], my = RM[i];
            let need = nd & 255, ci = (nd >> 8) & 255;
            if (kind === 5) { need = owner >= 0 && owner < 32 ? P[24 + owner] | 0 : 0; ci = 3; }
            if (need) {
                const gx0 = Math.max(0, Math.floor((ox - r) / tile)), gx1 = Math.min(W - 1, Math.floor((ox + r) / tile));
                const gy0 = Math.max(0, Math.floor((oy - r) / tile)), gy1 = Math.min(H - 1, Math.floor((oy + r) / tile));
                for (let by = gy0 >> 3, by1 = gy1 >> 3; by <= by1; by++) for (let bx = gx0 >> 3, bx1 = gx1 >> 3; bx <= bx1; bx++) {
                    if (!WCNT[(by * GBW + bx) * 8 + ci]) continue;
                    for (let ty = Math.max(gy0, by << 3), ty1 = Math.min(gy1, (by << 3) + 7); ty <= ty1; ty++) for (let tx = Math.max(gx0, bx << 3), tx1 = Math.min(gx1, (bx << 3) + 7); tx <= tx1; tx++) {
                        const t = ty * W + tx;
                        if ((F[t] & need) !== need || O[t] !== owner) continue;
                        const dx = tx * tile + half - ox, dy = ty * tile + half - oy, d2 = dx * dx + dy * dy;
                        if (!(d2 <= r2)) continue;
                        if (st && !(SA[t] >= 0 && AS[SA[t]] === st)) continue;
                        if ((RV[t] & rb) && t !== my) continue;
                        let sc = Math.sqrt(d2);
                        if (jid >= 0) {
                            if (t === cur) sc -= tile * 0.75;
                            sc += ((((jid * 1103515245 + tx * 12345 + ty * 54321) >>> 0) % 1024) / 1024) * tile * 0.35;
                        }
                        _wsInsert(OUT, OSC, o0, K, t, sc);
                    }
                }
            }
            // A healer: its owner's damaged units too (_findNearestDamagedFriendlyUnit).
            if (kind === 4 && HX && owner >= 0 && owner < HN.length) {
                const ux = RUX[i], uy = RUY[i];
                let b0 = -1, b1 = -1, b2 = -1, s0 = Infinity, s1 = Infinity, s2 = Infinity;
                for (let q = 0, e = HN[owner]; q < e; q++) {
                    const h = owner * HMAX + q, dx = HX[h] - ox, dy = HY[h] - oy, d2 = dx * dx + dy * dy;
                    if (d2 > r2) continue;
                    if (st && !(HA[h] >= 0 && AS[HA[h]] === st)) continue;
                    const wx = HX[h] - ux, wy = HY[h] - uy, sc = d2 + (wx * wx + wy * wy) * 0.08;
                    if (sc < s0) { b2 = b1; s2 = s1; b1 = b0; s1 = s0; b0 = q; s0 = sc; }
                    else if (sc < s1) { b2 = b1; s2 = s1; b1 = q; s1 = sc; }
                    else if (sc < s2) { b2 = q; s2 = sc; }
                }
                UOUT[i * 3] = b0; UOUT[i * 3 + 1] = b1; UOUT[i * 3 + 2] = b2;
            }
            continue;
        }
        const grp = RG[i], gid = grp >= 0 && grp < 8 ? P[16 + grp] : -1, pre = 'wsg' + gid + '.', meta = R[pre + 'meta'];
        if (kind !== 1 || !meta || !(gid >= 0)) continue;
        const n = meta[0], np = meta[1], bcols = meta[3], brows = meta[4];
        const SX = R[pre + 'sx'], SY = R[pre + 'sy'], ST = R[pre + 'st'], SO = R[pre + 'so'];
        const ux = RUX[i], uy = RUY[i];
        let ax = RAX[i], ay = RAY[i];
        if (!(ax === ax)) {
            const PGX = R[pre + 'pgx'], PGY = R[pre + 'pgy'], PO = R[pre + 'po'], PID = R[pre + 'pid'], PX = R[pre + 'px'], PY = R[pre + 'py'];
            const utx = Math.floor(ux / tile), uty = Math.floor(uy / tile);
            let best = -1, bd = Infinity;
            for (let p = 0; p < np; p++) {
                if ((PO[p] | 0) !== owner) continue;
                const d = Math.abs(PGX[p] - utx) + Math.abs(PGY[p] - uty);
                if (d < bd || (d === bd && (PGY[p] < PGY[best] || (PGY[p] === PGY[best] && (PGX[p] < PGX[best] || (PGX[p] === PGX[best] && PID[p] < PID[best])))))) { bd = d; best = p; }
            }
            if (best >= 0) { ax = PX[best]; ay = PY[best]; } else { ax = ux; ay = uy; }
        }
        const BS = R[pre + 'bs'], BC = R[pre + 'bc'], BI = R[pre + 'bi'], rb = RV ? (RN[i] >> 16) & 255 : 0, my = RM[i];
        const bx0 = Math.max(0, Math.floor((ox - r) / tile / BT)), bx1 = Math.min(bcols - 1, Math.floor((ox + r) / tile / BT));
        const by0 = Math.max(0, Math.floor((oy - r) / tile / BT)), by1 = Math.min(brows - 1, Math.floor((oy + r) / tile / BT));
        for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
            const b = by * bcols + bx;
            for (let e = BS[b], e1 = e + BC[b]; e < e1; e++) {
                const s = BI[e];
                if (s >= n) continue;
                const so = SO[s] | 0;
                if (so >= 0 && so !== owner) continue;
                const dx = SX[s] - ox, dy = SY[s] - oy, d2 = dx * dx + dy * dy;
                if (!(d2 <= r2)) continue;
                if (rb) { const t = Math.floor(SY[s] / tile) * W + Math.floor(SX[s] / tile); if ((RV[t] & rb) && t !== my) continue; }
                const ex = SX[s] - ax, ey = SY[s] - ay;
                _wsInsert(OUT, OSC, o0, K, s, Math.sqrt(ex * ex + ey * ey) + Math.sqrt(d2) * 0.22 + (ST[s] === 0 ? dropPen : 0));
            }
        }
    }
};

// The units' upkeep bins made anew (main.js _upkUnitsBuild, after a
// resync), per block of P[1] units-array indices: a unit of an owner below
// P[2] with a type index (upT) below P[3] in its bin ((type * P[2] + owner)
// * (P[4] + 1) + its effective level as getUnitEffectiveLevel, 1..P[4]):
// upB its bin (-1 none), counted in upk.h (Atomics: integer counts).
SIM_KERNELS[SIM_KERNEL_UPKEEP] = function (R, P, chunk) {
    const SL = R['ix.slots'], OWN = R['unit.owner'], UT = R['unit.upT'], UB = R['unit.upB'];
    const EL = R['unit.effectiveLevel'], UL = R['unit.unitLevel'], BL = R['unit.baseLevel'], SC = R['unit.stackCount'];
    const HIST = R['upk.h'];
    const NP = P[2] | 0, NT = P[3] | 0, MAXL = P[4] | 0, L1 = MAXL + 1, b0 = chunk * P[1];
    for (let i = b0, end = Math.min(P[0], b0 + P[1]); i < end; i++) {
        const s = SL[i];
        if (s < 0) continue;
        UB[s] = -1;
        const ow = OWN[s], t = UT[s];
        if (!(ow >= 0 && ow < NP) || t < 0 || t >= NT) continue;
        // (getUnitEffectiveLevel: the first finite of the levels, else the
        // stack count's level, else 1; clamped.)
        let l = EL[s];
        if (!(l - l === 0)) {
            l = UL[s];
            if (!(l - l === 0)) {
                l = BL[s];
                if (!(l - l === 0)) {
                    const sc = SC[s];
                    if (sc - sc === 0) { let v = Math.floor(Math.max(1, sc || 1)), k = 0; while (v >= 2) { v = Math.floor(v / 2); k++; } l = k + 1; }
                    else l = 1;
                }
            }
        }
        const lv = Math.max(1, Math.max(0, Math.min(MAXL, Math.floor(l)))), b = (t * NP + Math.floor(ow)) * L1 + lv;
        UB[s] = b;
        Atomics.add(HIST, b, 1);
    }
};

// The healer candidates (worker.js healerCandidatesStep): per chunk of P[1]
// slots of a snapshot (hc.e energy, hc.m max energy, hc.o owner, hc.id, hc.l
// live, hc.d dead), per owner below P[2] the P[3] damaged (0 < energy <
// max) with the lowest (energy / max, id): hc.res their slots, best first
// (-1 none), hc.rat their ratios. P[0] slots.
SIM_KERNELS[SIM_KERNEL_HEAL_CAND] = function (R, P, chunk) {
    const E = R['hc.e'], M = R['hc.m'], O = R['hc.o'], ID = R['hc.id'], L = R['hc.l'], D = R['hc.d'], RES = R['hc.res'], RAT = R['hc.rat'];
    const n = P[0] | 0, per = P[1] | 0, np = P[2] | 0, K = P[3] | 0, base = chunk * np * K;
    for (let k = 0; k < np * K; k++) { RES[base + k] = -1; RAT[base + k] = Infinity; }
    for (let s = chunk * per, end = Math.min(n, s + per); s < end; s++) {
        if (!L[s] || D[s]) continue;
        const o = Math.floor(O[s]), e = E[s], m = M[s];
        if (!(o >= 0 && o < np) || !(m > 0) || !(e > 0) || !(e < m)) continue;
        const r = e / m, id = Math.floor(ID[s]), b = base + o * K;
        let k = K - 1;
        if (RES[b + k] >= 0 && (r > RAT[b + k] || (r === RAT[b + k] && id >= Math.floor(ID[RES[b + k]])))) continue;
        while (k > 0 && (RES[b + k - 1] < 0 || r < RAT[b + k - 1] || (r === RAT[b + k - 1] && id < Math.floor(ID[RES[b + k - 1]])))) { RES[b + k] = RES[b + k - 1]; RAT[b + k] = RAT[b + k - 1]; k--; }
        RES[b + k] = s; RAT[b + k] = r;
    }
};

// The unit pass's candidates (main.js _forEachUnitInTickOrder): per block
// of P[1] units-array indices, those still needing their update (no slot,
// or a kernel output 0 or above 6: moved, parked and held ones are done),
// in index order at upd.cand[block * P[1]...], how many at upd.cnt[block].
// P: [0] units, [1] block size, [2] blocks per job.
SIM_KERNELS[SIM_KERNEL_UPD_CAND] = function (R, P, chunk) {
    const SL = R['ix.slots'], OUT = R['unit.mvOut'], CAND = R['upd.cand'], CNT = R['upd.cnt'], n = P[0] | 0, B = P[1] | 0, per = P[2] | 0;
    const nb = Math.ceil(n / B);
    for (let b = chunk * per, bend = Math.min(nb, b + per); b < bend; b++) {
        let m = 0;
        for (let idx = b * B, end = Math.min(n, idx + B); idx < end; idx++) {
            const sl = SL[idx];
            if (sl >= 0) { const o = OUT[sl]; if (o !== 0 && o <= 6) continue; }
            CAND[b * B + m++] = idx;
        }
        CNT[b] = m;
    }
};
// After the pass: held units (output 6) whose energy ran out during it are
// dead now, as Unit.update would have marked them. P: [0] slots, [1] per job.
SIM_KERNELS[SIM_KERNEL_HELD_DEAD] = function (R, P, chunk) {
    const OUT = R['unit.mvOut'], EN = R['unit.energy'], DEAD = R['unit.dead'];
    for (let s = chunk * P[1], end = Math.min(P[0], s + P[1]); s < end; s++) if (OUT[s] === 6 && !(EN[s] > 0) && !DEAD[s]) DEAD[s] = 1;
};

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
SIM_KERNELS[SIM_KERNEL_VIS_SPREAD] = function (R, P, p) {
    const A = P[0] | 0, stamp = P[2] | 0, base = p * A;
    const SEED = R['vis.useed'], LIST = R['vis.ulist'], CNT = R['vis.ucnt'], AOK = R['vt.aok'], OFF = R['vt.aoff'], NB = R['vt.anb'];
    const REM = R['vis.urem'], BB = R['vis.ubufB'], CUR = R['vis.ucur'];
    let LV = R['vis.ubufA'], NX = R['vis.ubufC'];
    const ST = R['vis.ust'], PREV = R['vis.uprev'], PREVN = R['vis.uprevn'], PLUS = R['vis.uplus'], MINUS = R['vis.uminus'], DIFF = R['vis.udiff'];
    const n = CNT[p];
    // Seeds by steps (counting sort into BB), the covered list started.
    const cnt = new Int32Array(65);
    let nc = 0, top = -1;
    for (let i = 0; i < n; i++) {
        const a = LIST[base + i];
        if (!(a >= 0 && a < A) || !AOK[a]) continue;
        const v = SEED[base + a];
        if ((v >> 6) !== stamp) continue;
        const r = v & 63;
        if (REM[base + a] < 0) CUR[base + nc++] = a;
        if (r > REM[base + a]) { REM[base + a] = r; cnt[r + 1]++; if (r > top) top = r; }
    }
    for (let r = 1; r <= 64; r++) cnt[r] += cnt[r - 1];
    const pos = cnt.slice(0, 64);
    for (let i = 0; i < nc; i++) {
        const a = CUR[base + i], r = REM[base + a];
        BB[base + pos[r]++] = a;
    }
    // Level by level, most steps first: the level's seeds and the areas
    // reached from the level above (LV), each expanded once; the areas
    // they reach make the next level's list (NX).
    let nl = 0;
    for (let r = top; r > 0; r--) {
        let nn = 0;
        const expand = (a) => {
            const o1 = OFF[a + 1];
            for (let j = OFF[a]; j < o1; j++) {
                const q = NB[j];
                if (REM[base + q] >= r - 1) continue;
                if (REM[base + q] < 0) CUR[base + nc++] = q;
                REM[base + q] = r - 1;
                if (r > 1) NX[base + nn++] = q;
            }
        };
        for (let i = 0; i < nl; i++) { const a = LV[base + i]; if (REM[base + a] === r) expand(a); }
        for (let i = cnt[r], e = cnt[r + 1]; i < e; i++) { const a = BB[base + i]; if (REM[base + a] === r) expand(a); }
        const sw = LV; LV = NX; NX = sw;
        nl = nn;
    }
    // Against the last run.
    let nm = 0, np = 0;
    for (let i = 0, e = PREVN[p]; i < e; i++) {
        const a = PREV[base + i];
        if (REM[base + a] < 0) { MINUS[base + nm++] = a; ST[base + a] = 0; }
    }
    for (let i = 0; i < nc; i++) {
        const a = CUR[base + i];
        if (!ST[base + a]) { PLUS[base + np++] = a; ST[base + a] = 1; }
        REM[base + a] = -1;
        PREV[base + i] = a;
    }
    PREVN[p] = nc; DIFF[2 * p] = np; DIFF[2 * p + 1] = nm;
};

// The most steps for one player's area (an atomic maximum), listing the
// area at its first mark of the stamp.
function _simVisSeed(SEED, LIST, CNT, p, base, a, val, stamp) {
    const k = base + a;
    let cur = SEED[k];
    while (cur < val) {
        const prev = Atomics.compareExchange(SEED, k, cur, val);
        if (prev === cur) { if ((cur >> 6) !== stamp) LIST[base + Atomics.add(CNT, p, 1)] = a; return; }
        cur = prev;
    }
}

SIM_KERNELS[SIM_KERNEL_EFF_COUNT] = function (R, P, chunk) {
    const win = R['eff.win'], out = R['eff.out'], data = R['spatial.cplx'];
    const CW = P[2] | 0, stride = P[3] | 0;
    for (let i = chunk * P[1], end = Math.min(P[0], i + P[1]); i < end; i++) {
        const o = i * 5, lane = win[o + 4];
        if (lane < 0) continue;
        const x1 = win[o], y1 = win[o + 1], x2 = win[o + 2], y2 = win[o + 3];
        let sum = 0;
        for (let y = y1; y <= y2; y++) {
            let idx = (y * CW + x1) * stride + lane;
            for (let x = x1; x <= x2; x++, idx += stride) sum += data[idx];
        }
        out[i] = sum | 0;
    }
};

// The state hash's region of each unit (utils_snapshot.js snapTickHash),
// from its position columns: snap.reg[i] for units[i] (-1: no slot).
// P: [0] units, [1] per job, [2] region size in pixels.
// With it, snap.hc[i]: the hash of the unit's column fields (snap.kc: the
// fields' codes, in utils_snapshot.js SNAP_HASH_UNIT_COLUMNS order), as the
// generated field hashers mix numbers.
// P[5] 1 (one slice): each unit of the slice is also summed into its
// region (snap.acc[region], mod 2^32), the region listed once (snap.list,
// snap.cnt[0]; snap.stamp: P[8]) - except the units of this rotation's
// group (id % P[7] === P[6]: their object fields too; snap.rot, cnt[1]),
// and units without a slot or outside 0..P[9] regions (snap.noslot,
// cnt[2]), left to the caller.
const _snapKF64 = new Float64Array(1), _snapKI32 = new Int32Array(_snapKF64.buffer);
SIM_KERNELS[SIM_KERNEL_SNAP_REGION] = function (R, P, chunk) {
    const SL = R['ix.slots'], X = R['unit.x'], Y = R['unit.y'], out = R['snap.reg'], ts = P[2];
    const HC = R['snap.hc'], KC = R['snap.kc'];
    const acc = P[5] === 1, ACC = R['snap.acc'], STAMP = R['snap.stamp'], LIST = R['snap.list'], ROTL = R['snap.rot'], NOSL = R['snap.noslot'], CNT = R['snap.cnt'], ID = R['unit.id'];
    const rot = P[6] | 0, groups = P[7] | 0, stamp = P[8] | 0, rmax = P[9] | 0;
    // (In SNAP_HASH_UNIT_COLUMNS order.)
    const cols = KC ? [R['unit.owner'], X, Y, R['unit.vx'], R['unit.vy'], R['unit.energy'], R['unit.commandState'], R['unit.dead'], R['unit.attackTimer'], R['unit.attackFlash'],
        R['unit.teleportHideTicks'], R['unit.poisoned'], R['unit.burning'], R['unit.frozen'], R['unit.wet'], R['unit.sandy'], R['unit.watched'], R['unit.workerTransferCooldown']] : null;
    for (let i = chunk * P[1], end = Math.min(P[0], i + P[1]); i < end; i++) {
        const si = SL[i];
        const r = si < 0 ? -1 : Math.floor(Y[si] / ts) * 1024 + Math.floor(X[si] / ts);
        out[i] = r;
        if (acc && si < 0) { NOSL[Atomics.add(CNT, 2, 1)] = i; continue; }
        // (Only this tick's slice: P[3] slices, P[4] the slice.)
        if (!HC || si < 0 || (P[3] > 0 && r % P[3] !== P[4])) continue;
        let h = 0;
        for (let k = 0; k < cols.length; k++) {
            const x = cols[k][si], kc = KC[k];
            let v;
            if ((x | 0) === x && (x !== 0 || 1 / x > 0)) v = Math.imul(kc ^ x, 16777619);
            else if (x !== x) v = kc ^ 0x7ff8;
            else { _snapKF64[0] = x; v = Math.imul(Math.imul(kc ^ _snapKI32[0], 16777619) ^ _snapKI32[1], 0x5bd1e995); }
            h = (h + Math.imul(v, 2654435761)) | 0;
        }
        HC[i] = h;
        if (!acc) continue;
        if (!(r >= 0 && r < rmax)) { NOSL[Atomics.add(CNT, 2, 1)] = i; continue; }
        if (Atomics.exchange(STAMP, r, stamp) !== stamp) LIST[Atomics.add(CNT, 0, 1)] = r;
        const id = ID[si];
        if ((((id % groups) + groups) % groups) === rot) { ROTL[Atomics.add(CNT, 1, 1)] = i; continue; }
        let hh = (Math.imul(id, 7919) ^ 0x11) + h | 0;
        hh = Math.imul(hh ^ (hh >>> 15), 2246822519);
        Atomics.add(ACC, r, hh);
    }
};

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
SIM_KERNELS[SIM_KERNEL_STATUS] = function (R, P, chunk) {
    const SL = R['ix.slots'], DEAD = R['unit.dead'], EN = R['unit.energy'], AT = R['unit.attackTimer'], AF = R['unit.attackFlash'];
    const TH = R['unit.teleportHideTicks'], BU = R['unit.burning'], BD = R['unit.burnTickDamage'], PO = R['unit.poisoned'], PD = R['unit.poisonTickDamage'];
    const FR = R['unit.frozen'], ID = R['unit.iceTickDamage'], WE = R['unit.wet'], SA = R['unit.sandy'], WA = R['unit.watched'];
    const EV = R['unit.stEv'], DOT = R['unit.stDot'], CNT = R['st.count'];
    const X = R['unit.x'], Y = R['unit.y'], X0 = R['unit.x0'], Y0 = R['unit.y0'], WTC = R['unit.workerTransferCooldown'];
    const ACC = R['unit.stAcc'], UID = R['unit.id'], t = P[2] | 0, per = Math.max(1, P[3] | 0);
    let n = 0;
    for (let i = chunk * P[1], end = Math.min(P[0], i + P[1]); i < end; i++) {
        const s = SL[i];
        if (s < 0) continue;
        X0[s] = X[s]; Y0[s] = Y[s];
        if (DEAD[s]) continue;
        let ev = 0, dot = 0;
        if (TH[s] > 0) TH[s]--;
        if (BU[s] > 0) { BU[s]--; const d = BD[s]; if (d > 0) { EN[s] -= d; dot += d; ev = 1; } }
        if (PO[s] > 0) { PO[s]--; const d = PD[s]; if (d > 0) { EN[s] -= d; dot += d; ev = 1; } }
        if (FR[s] > 0 && WE[s] > 0 && ID[s] > 0) { const d = ID[s] * 1.5; EN[s] -= d; dot += d; ev = 1; }
        if (FR[s] > 0) FR[s]--;
        if (WE[s] > 0) WE[s]--;
        if (SA[s] > 0) SA[s]--;
        if (WA[s] > 0) { WA[s]--; if (WA[s] <= 0) ev |= 2; }
        if (EN[s] <= 0) { DEAD[s] = 1; ev |= 4; }
        else { if (AT[s] > 0) AT[s]--; if (AF[s] > 0) AF[s]--; if (WTC[s] > 0) WTC[s]--; }
        // (Reported every per ticks, or now that it died.)
        const acc = ACC[s] + dot;
        ev &= ~1;
        if (acc > 0 && ((ev & 4) || ((t + (UID[s] | 0)) % per) === 0)) { ev |= 1; dot = acc; ACC[s] = 0; }
        else ACC[s] = acc;
        EV[s] = ev;
        if (ev !== 0) { DOT[s] = dot; n++; }
    }
    CNT[chunk] = n;
};

// Owners per tile of the unit index (ix.omask: bit p set when a unit of
// player p is listed there; dead units too). The entries are grouped by
// tile (sep.ekey); a job owns the runs that start in its range (finishing
// them past its end), so no two write one tile. P: [0] entries, [1] per job.
SIM_KERNELS[SIM_KERNEL_TILE_OWNERS] = function (R, P, chunk) {
    const es = R['sep.eslot'], ek = R['sep.ekey'], OWN = R['unit.owner'], M = R['ix.omask'], n = P[0] | 0;
    for (let e = chunk * P[1], end = Math.min(n, e + P[1]); e < end; e++) {
        const k = ek[e];
        if (e > 0 && ek[e - 1] === k) continue;
        let m = 0;
        for (let g = e; g < n && ek[g] === k; g++) {
            const q = es[g];
            if (q < 0) continue;
            const o = OWN[q] | 0;
            m |= (o >= 0 && o < 8) ? (1 << o) : 0xFF;
        }
        M[k] = m;
    }
};

// The crowd flags (unit.js combatScanRun, every tick): for moving units
// near a group's destination or waiting, whether an idle or waiting unit of
// their owner stands beside them and how dense it is there (the movement
// kernel's and _followNavNode's arrival in a crowd). The search for enemy
// units is the acquisition tier's (SIM_KERNEL_ACQ_SCAN).
SIM_KERNELS[SIM_KERNEL_COMBAT_SCAN] = function (R, P, chunk) {
    const OUT = R['unit.mvOut'], CMD = R['unit.commandState'], DEAD = R['unit.dead'], X = R['unit.x'], Y = R['unit.y'];
    const OWN = R['unit.owner'], ID = R['unit.id'], AR = R['unit.spArea'], SEP = R['unit.sepKey'];
    const RNG = R['unit.cbRange'], CT = R['unit.cbT'], CTK = R['unit.cbTick'];
    // (Enemies where they were at the pass's start, and their areas there.)
    const X0 = R['unit.x0'], Y0 = R['unit.y0'], AG = R['ix.agrid'], GW = P[15] | 0, GH = P[16] | 0;
    const rs = R['sep.rs'], rc = R['sep.rc'], rst = R['sep.rstamp'], es = R['sep.eslot'], COVER = R['vis.cover'], HS = R['mv.hostile'];
    // (Tiles with no unit of another player are passed over: ix.omask.)
    const OM = R['ix.omask'];
    const t = P[2] | 0, CW = P[3] | 0, CH = P[4] | 0, tile = P[5], ep = P[6] | 0, players = P[7] | 0, cmdIdle = P[8], cmdAM = P[9];
    const B = P[10] | 0, bc = P[11] | 0, br = P[12] | 0, absent = P[13], cs = P[14] | 0, cws = tile * cs;
    const stride = bc + 1, plane = stride * (br + 1);
    const CWN = R['unit.cwNear'], CWT = R['unit.cwTick'], CWD = R['unit.cwDense'], NLDS = R['unit.mvNavLD'], cmdMove = P[17], CMDS = CMD;
    // (Units attacking a structure they chose themselves, held or on their
    // way there (mvOn 5, 6, see the movement kernel), on their look for
    // enemy units: every 8 ticks by id, doAttacking.)
    const cmdAtk = P[18], MON = R['unit.mvOn'], MFL = R['unit.mvFlags'], MHT = R['unit.mvHTId'], acq = Math.max(1, P[19] | 0);
    for (let s = chunk * P[1], end = Math.min(P[0], s + P[1]); s < end; s++) {
        if (OUT[s] !== 0 || DEAD[s] || SEP[s] === absent) continue;
        const cmd = CMD[s];
        // Moving (or attack-moving): whether an idle or waiting (mvNavLD at
        // most -2) unit of its owner stands in its tile or one beside it, and
        // how many units are listed in those tiles (the index: the tick's start).
        // (Only near a group's destination or waiting does it matter:
        // mvNavLD at least 0 or at most -2; -1 elsewhere.)
        if ((cmd === cmdMove || cmd === cmdAM) && NLDS[s] !== -1) {
            const own = OWN[s] | 0, gx = Math.floor(X[s] / cws), gy = Math.floor(Y[s] / cws);
            let near = 0, dense = 0;
            for (let ty = gy - 1; ty <= gy + 1; ty++) {
                if (ty < 0 || ty >= CH) continue;
                for (let tx = gx - 1; tx <= gx + 1; tx++) {
                    if (tx < 0 || tx >= CW) continue;
                    const k = ty * CW + tx;
                    if (rst[k] !== ep) continue;
                    dense += rc[k];
                    if (near) continue;
                    for (let e = rs[k], e1 = e + rc[k]; e < e1; e++) {
                        const q = es[e];
                        if (q >= 0 && q !== s && !DEAD[q] && (OWN[q] | 0) === own && (CMDS[q] === cmdIdle || NLDS[q] <= -2)) { near = 1; break; }
                    }
                }
            }
            CWN[s] = near; CWT[s] = t; CWD[s] = dense > 65535 ? 65535 : dense;
        }
    }
};

// The acquisition tier (unit.js _acqTierStep): the snapshot of what the
// scan reads, per slot (as at the tick it is taken: positions at the pass's
// start, owner, dead, absent from the index, command, aggro range, id, the
// result cleared (acq.out -2: not looked for); nothing of the movement
// kernel's arming (a peer may run without it). P: [0] slots, [1] per job,
// [2] SIM_SEP_ABSENT.
SIM_KERNELS[SIM_KERNEL_ACQ_SNAP] = function (R, P, chunk) {
    const X0 = R['unit.x0'], Y0 = R['unit.y0'], OWN = R['unit.owner'], DEAD = R['unit.dead'], SEP = R['unit.sepKey'], CMD = R['unit.commandState'];
    const RNG = R['unit.cbRange'], ID = R['unit.id'];
    const SX = R['acq.x'], SY = R['acq.y'], SO = R['acq.own'], SF = R['acq.flags'], SC = R['acq.cmd'], SR = R['acq.rng'], SI = R['acq.id'], OUTA = R['acq.out'];
    const absent = P[2];
    for (let s = chunk * P[1], end = Math.min(P[0], s + P[1]); s < end; s++) {
        SX[s] = X0[s]; SY[s] = Y0[s]; SO[s] = OWN[s]; SC[s] = CMD[s]; SR[s] = RNG[s]; SI[s] = ID[s]; OUTA[s] = -2;
        // (1 dead, 2 absent from the index.)
        SF[s] = (DEAD[s] ? 1 : 0) | (SEP[s] === absent ? 2 : 0);
    }
};
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
SIM_KERNELS[SIM_KERNEL_ACQ_SCAN] = function (R, P, chunk) {
    const SCLS = R['acq.scls'], SOWN = R['acq.sown'], HSSn = R['acq.hss'], SOUT = R['acq.sout'];
    const X = R['acq.x'], Y = R['acq.y'], OWN = R['acq.own'], FLG = R['acq.flags'], CMD = R['acq.cmd'], RNG = R['acq.rng'], ID = R['acq.id'];
    const OUTA = R['acq.out'], TID = R['acq.tid'], AG = R['acq.agrid'], COVF = R['acq.cover'], HS = R['acq.hs'];
    const rs = R['acq.rs'], rc = R['acq.rc'], rst = R['acq.rst'], es = R['acq.es'], OM = R['acq.om'];
    const CW = P[3] | 0, CH = P[4] | 0, tile = P[5], ep = P[6] | 0, players = P[7] | 0, cmdIdle = P[8], cmdAM = P[9];
    const B = P[10] | 0, bc = P[11] | 0, br = P[12] | 0, cs = P[14] | 0, cws = tile * cs, GW = P[15] | 0, GH = P[16] | 0, cmdAtk = P[18], A = P[20] | 0;
    const stride = bc + 1, plane = stride * (br + 1);
    for (let s = chunk * P[1], end = Math.min(P[0], s + P[1]); s < end; s++) {
        const fl = FLG[s];
        if (fl & 3) continue;
        const cmd = CMD[s];
        if (cmd !== cmdIdle && cmd !== cmdAM && cmd !== cmdAtk) continue;
        const owner = OWN[s] | 0, r = RNG[s];
        if (!(owner >= 0 && owner < players) || !(r > 0)) continue;
        const cbase = owner * A;
        const foe = owner < 8 ? (0xFF ^ (1 << owner)) : 0xFF;
        OUTA[s] = -1; TID[s] = 0; SOUT[s] = -1;
        const x = X[s], y = Y[s], cx = Math.floor(x / cws), cy = Math.floor(y / cws);
        if (cmd !== cmdAtk) SOUT[s] = _simAcqStructure(SCLS, SOWN, HSSn, AG, COVF, cbase, owner, x, y, r, tile, GW, GH, B, bc, br, stride, plane);
        const rt = Math.ceil(r / cws) + 1;
        // Nothing hostile in the blocks around: none.
        {
            const x0 = Math.max(0, cx - rt) * cs, y0 = Math.max(0, cy - rt) * cs, x1 = Math.min(CW - 1, cx + rt) * cs, y1 = Math.min(CH - 1, cy + rt) * cs;
            const bx0 = Math.floor(x0 / B), by0 = Math.floor(y0 / B), bx1 = Math.min(bc - 1, Math.floor(x1 / B)), by1 = Math.min(br - 1, Math.floor(y1 / B)), o = owner * plane;
            if (bx0 <= bx1 && by0 <= by1 && HS[o + (by1 + 1) * stride + bx1 + 1] - HS[o + by0 * stride + bx1 + 1] - HS[o + (by1 + 1) * stride + bx0] + HS[o + by0 * stride + bx0] <= 0) continue;
        }
        let best = -1, bd2 = r * r;
        for (let ring = 0; ring <= rt; ring++) {
            if (best >= 0 && (ring - 2) * cws > Math.sqrt(bd2)) break;
            for (let oy = -ring; oy <= ring; oy++) {
                const ty = cy + oy;
                if (ty < 0 || ty >= CH) continue;
                const edge = oy === -ring || oy === ring;
                for (let ox = -ring; ox <= ring; ox += (edge || ring === 0) ? 1 : 2 * ring) {
                    const tx = cx + ox;
                    if (tx < 0 || tx >= CW) continue;
                    const k = ty * CW + tx;
                    if (rst[k] !== ep || (OM[k] & foe) === 0) continue;
                    for (let e = rs[k], e1 = e + rc[k]; e < e1; e++) {
                        const q = es[e];
                        if (q < 0 || (FLG[q] & 1) || (OWN[q] | 0) === owner) continue;
                        const qx = X[q], qy = Y[q], qgx = Math.floor(qx / tile), qgy = Math.floor(qy / tile);
                        if (qgx < 0 || qgy < 0 || qgx >= GW || qgy >= GH) continue;
                        const a = AG[qgy * GW + qgx];
                        if (!(a >= 0) || !(COVF[cbase + a] > 0)) continue;
                        const dx = qx - x, dy = qy - y, d2 = dx * dx + dy * dy;
                        if (d2 > bd2) continue;
                        if (best < 0 || d2 < bd2 || ID[q] < ID[best]) { best = q; bd2 = d2; }
                    }
                }
            }
        }
        OUTA[s] = best; TID[s] = best >= 0 ? (ID[best] | 0) : 0;
    }
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
SIM_KERNELS[SIM_KERNEL_ACQ_COMMIT] = function (R, P, chunk) {
    const OUTA = R['acq.out'], TID = R['acq.tid'], SI = R['acq.id'], SR = R['acq.rng'], ID = R['unit.id'], SOUT = R['acq.sout'], CBS = R['unit.cbS'];
    const CT = R['unit.cbT'], CTK = R['unit.cbTick'], CTI = R['unit.cbTId'], CRS = R['unit.cbRangeS'], t = P[2] | 0;
    for (let s = chunk * P[1], end = Math.min(P[0], s + P[1]); s < end; s++) {
        const o = OUTA[s];
        if (o === -2 || (ID[s] | 0) !== (SI[s] | 0)) continue;
        CT[s] = o; CTI[s] = TID[s]; CRS[s] = SR[s]; CTK[s] = t; CBS[s] = SOUT[s];
    }
};

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
SIM_KERNELS[SIM_KERNEL_INDEX_FILL] = function (R, P, chunk) {
    const area = P[14] === 1, SL = R['ix.slots'], ORD = area ? R['ix.ordA'] : R['ix.ordC'], KEY = area ? R['ix.areas'] : R['ix.keys'];
    const OUTS = area ? R['ix.aslot'] : R['sep.eslot'], OUTK = area ? null : R['sep.ekey'];
    const START = area ? R['ix.astart'] : R['ix.start'], STAMP = area ? R['ix.astamp'] : R['ix.stamp'], LISTED = R['ix.listed'];
    const lim = area ? P[3] | 0 : P[2] | 0, ep = P[15] | 0, n = P[0] | 0;
    for (let pos = chunk * P[1], end = Math.min(n, pos + P[1]); pos < end; pos++) {
        const i = ORD[pos], k = KEY[i];
        if (k >= lim) { if (pos === 0 || KEY[ORD[pos - 1]] < lim) LISTED[area ? 1 : 0] = pos; continue; }
        OUTS[pos] = SL[i];
        if (OUTK) OUTK[pos] = k;
        if (pos === 0 || KEY[ORD[pos - 1]] !== k) { START[k] = pos; STAMP[k] = ep; }
    }
};
// Each key's count at the end of its range; for areas, the units of each
// owner too (counted by the range's first position). P as INDEX_FILL's, [4] players.
SIM_KERNELS[SIM_KERNEL_INDEX_RUNS] = function (R, P, chunk) {
    const area = P[14] === 1, SL = R['ix.slots'], ORD = area ? R['ix.ordA'] : R['ix.ordC'], KEY = area ? R['ix.areas'] : R['ix.keys'];
    const START = area ? R['ix.astart'] : R['ix.start'], CNT = area ? R['ix.acnt'] : R['ix.cnt'], LISTED = R['ix.listed'];
    const AOWN = R['ix.aown'], OWN = R['unit.owner'], players = P[4] | 0;
    const listed = LISTED[area ? 1 : 0] | 0;
    for (let pos = chunk * P[1], end = Math.min(listed, pos + P[1]); pos < end; pos++) {
        const k = KEY[ORD[pos]];
        if (pos + 1 === listed || KEY[ORD[pos + 1]] !== k) CNT[k] = pos + 1 - START[k];
        if (area && (pos === 0 || KEY[ORD[pos - 1]] !== k)) {
            const o0 = k * players;
            for (let p = 0; p < players; p++) AOWN[o0 + p] = 0;
            for (let q = pos; q < listed; q++) {
                const i = ORD[q];
                if (KEY[i] !== k) break;
                const o = OWN[SL[i]];
                if (o >= 0 && o < players) AOWN[o0 + o]++;
            }
        }
    }
};

SIM_KERNELS[SIM_KERNEL_INDEX_KEYS] = function (R, P, chunk) {
    const SL = R['ix.slots'], X = R['unit.x'], Y = R['unit.y'], DEAD = R['unit.dead'], AG = R['ix.agrid'];
    const keys = R['ix.keys'], areas = R['ix.areas'], bad = R['ix.bad'];
    const nChunks = P[2] | 0, A = P[3] | 0, tile = P[9], GW = P[10] | 0, GH = P[11] | 0, CS = P[12] | 0, CW = P[13] | 0;
    for (let i = chunk * P[1], end = Math.min(P[0], i + P[1]); i < end; i++) {
        const si = SL[i];
        if (si < 0) { keys[i] = nChunks; areas[i] = A; Atomics.store(bad, 0, 1); continue; }
        if (DEAD[si]) { keys[i] = nChunks; areas[i] = A; continue; }
        let gx = Math.floor(X[si] / tile), gy = Math.floor(Y[si] / tile);
        if (!(gx >= 0)) gx = 0; else if (gx >= GW) gx = GW - 1;
        if (!(gy >= 0)) gy = 0; else if (gy >= GH) gy = GH - 1;
        const k = CS === 1 ? gy * GW + gx : Math.floor(gy / CS) * CW + Math.floor(gx / CS);
        keys[i] = k >= 0 && k < nChunks ? k : nChunks;
        const a = AG[gy * GW + gx];
        areas[i] = a >= 0 && a < A ? a : A;
    }
};
