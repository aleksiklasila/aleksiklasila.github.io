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
// own jobs, taken first; lane 1: long jobs such as a navigation build): its
// kernel, chunk count, done count, bindings version and ticket counter (job
// id << 24 | next chunk), at SIM_PAR_BG_BASE + lane * 8.
const SIM_PAR_BG_BASE = 8, SIM_PAR_BG_KERNEL = 0, SIM_PAR_BG_TOTAL = 1, SIM_PAR_BG_DONE = 2, SIM_PAR_BG_REGVER = 3, SIM_PAR_BG_NEXT = 4, SIM_PAR_BG_LANES = 2;

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

// ---- kernels: (arrays, params, chunk) ----
const SIM_KERNELS = [];
const SIM_KERNEL_VISIBILITY = 0, SIM_KERNEL_SEPARATION = 1, SIM_KERNEL_UNIT_FRAME = 2, SIM_KERNEL_UNIT_PACK = 3;
const SIM_KERNEL_SPATIAL_HISTOGRAM = 4, SIM_KERNEL_SPATIAL_SCATTER = 5, SIM_KERNEL_SEPARATION_PREPARE = 6;
const SIM_KERNEL_SEPARATION_FINISH = 7, SIM_KERNEL_MOVE = 8, SIM_KERNEL_SEPARATION_YIELD = 9;
const SIM_KERNEL_INDEX_CLEAR = 10, SIM_KERNEL_INDEX_COUNT = 11, SIM_KERNEL_INDEX_SCATTER = 12, SIM_KERNEL_INDEX_ORDER = 13;
const SIM_KERNEL_EFF_COUNT = 14, SIM_KERNEL_SNAP_REGION = 19, SIM_KERNEL_COMBAT_SCAN = 20, SIM_KERNEL_INDEX_KEYS = 23;
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
function _simHostileStructNear(SC, W, H, tile, owner, x, y, r) {
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
            const x0 = gx * tile, dx = x < x0 ? x0 - x : (x > x0 + tile ? x - x0 - tile : 0);
            if (dx * dx <= ry) return true;
        }
    }
    return false;
}

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
    const NVN1 = R['unit.mvNavN1'], NVN2 = R['unit.mvNavN2'], NVF = R['unit.mvNavFar'], NVO = R['unit.mvNavOpen'];
    const X = R['unit.x'], Y = R['unit.y'], PX = R['unit.prevX'], PY = R['unit.prevY'], VX = R['unit.vx'], VY = R['unit.vy'];
    const EN = R['unit.energy'], OWN = R['unit.owner'], ID = R['unit.id'], PIDX = R['unit.pathIndex'], SEP = R['unit.sepKey'];
    const HS = R['mv.hostile'], SC = R['mv.struct'], WALL = R['mv.wall'], AB = R['mv.areaBox'], ABOK = R['mv.areaBoxOk'];
    // This tick's combat scan (run before this kernel: the nearest enemy unit
    // in aggro range or -1, cbTick = t) and hostile structures alone (summed
    // area, as mv.hostile).
    const CBT = R['unit.cbT'], CBTK = R['unit.cbTick'], HSS = R['mv.hstruct'], CHS = R['unit.mvChs'], RNG = R['unit.cbRange'];
    // (The combat scan's crowd flag: arriving in a crowd, flow mode.)
    const CWN = R['unit.cwNear'], CWT = R['unit.cwTick'], CWD = R['unit.cwDense'];
    // Parked idle workers' version checks (worker.js _workerWorkHash): the
    // table, its layout (P[22..27]) and the healer candidates' generation (P[28]).
    const WKV = R['wk.ver'], WKTY = R['unit.wkType'], WKD = R['unit.wkD'], WKOX = R['unit.wkOx'], WKOY = R['unit.wkOy'], WKTW = R['unit.wkTwice'];
    const WKF = R['unit.wkFail'], WKU = R['unit.wkUntil'], WKSC = R['unit.wkSched'];
    const WKNP = P[22] | 0, WKTYPES = P[23] | 0, WKRW = P[24] | 0, WKRH = P[25] | 0, WKR = P[26] | 0, WKPER = Math.max(1, P[27] | 0), WKHGEN = P[28] | 0;
    const WKWATCH = Math.max(1, P[29] | 0), WKWX = R['unit.wkWx'], WKWY = R['unit.wkWy'];
    const t = P[2] | 0, tr = P[3] | 0, W = P[5] | 0, H = P[6] | 0, tile = P[7], q = P[8];
    const QZ = q;
    const bc = P[9] | 0, br = P[10] | 0, players = P[11] | 0, B = P[14], absent = P[15], WIN = P[16] | 0, BOXSTEPS = P[17] | 0;
    const wver = P[19] | 0, pad = P[20], wcheck = P[21] | 0, WK = R['unit.mvWk'], WTC = R['unit.workerTransferCooldown'];
    const stride = bc + 1, plane = stride * (br + 1), maxSide = tile * 0.8;
    for (let s = chunk * P[1], end = Math.min(P[0], s + P[1]); s < end; s++) {
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
                const gx = Math.floor(X[s] / tile), gy = Math.floor(Y[s] / tile), o = OWN[s] | 0;
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
        const x = X[s], y = Y[s], gx = Math.floor(x / tile), gy = Math.floor(y / tile);
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
        if (hold) {
            // Attack hold (see simMoveTryHold in unit.js): the target where
            // it was at the pass's start (x0, y0), as Unit.update sees it.
            const q = HT[s];
            if (!(q >= 0) || DEADC[q] || (ID[q] | 0) !== HTID[s] || WALL[tl] || !AOFF) { ON[s] = 0; continue; }
            const tx = X0[q], ty = Y0[q], qgx = Math.floor(tx / tile), qgy = Math.floor(ty / tile);
            if (qgx < 0 || qgy < 0 || qgx >= W || qgy >= H) { ON[s] = 0; continue; }
            const cov = COV ? COV[owner] : null, a = AG ? AG[qgy * W + qgx] : -1;
            if (!cov || !(a >= 0) || !(cov[a] > 0)) { ON[s] = 0; continue; }
            if (_simUnitInAttackRange(AG, AOFF, ANB, WALL, CRC, RRC, W, H, tile, pad, s, q, x, y, tx, ty, REACH[s]) !== 1) { ON[s] = 0; continue; }
            // (6: held; 10: its attack tick (the status pre-pass counted the
            // timer down), the attack made at its turn: simHoldFire.)
            PX[s] = x; PY[s] = y; OUT[s] = AT[s] > 0 ? 6 : 10;
            continue;
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
            if ((FL[s] & 1) === 0 && ((t + id) % 8) === 0) { ON[s] = 0; continue; }
            const cov = COV ? COV[owner] : null, a = AG[bt];
            if (!cov || !(a >= 0) || !(cov[a] > 0)) { ON[s] = 0; continue; }
            const bgx = bt % W, bgy = (bt - bgx) / W;
            if (_simInAreaRange(AG, AOFF, ANB, W, H, tile, x, y, bgx * tile + tile / 2, bgy * tile + tile / 2, REACH[s]) !== 1) { ON[s] = 0; continue; }
            // (6: held; 10: its attack tick, see simHoldFire.)
            PX[s] = x; PY[s] = y; OUT[s] = AT[s] > 0 ? 6 : 10;
            continue;
        }
        if (ON[s] === 4) {
            // Chase (see simMoveTryChase in unit.js), as doAttacking: the
            // target where it was at the pass's start, in sight, not in range,
            // within leash, and the straight step taken (close, flying, or
            // _isChaseStepOpen), not into a wall tile.
            const q = HT[s];
            if (!(q >= 0) || DEADC[q] || (ID[q] | 0) !== HTID[s] || !AOFF) { ON[s] = 0; continue; }
            const tx = X0[q], ty = Y0[q], qgx = Math.floor(tx / tile), qgy = Math.floor(ty / tile);
            if (qgx < 0 || qgy < 0 || qgx >= W || qgy >= H) { ON[s] = 0; continue; }
            const cov = COV ? COV[owner] : null, a = AG ? AG[qgy * W + qgx] : -1;
            if (!cov || !(a >= 0) || !(cov[a] > 0)) { ON[s] = 0; continue; }
            if (_simUnitInAttackRange(AG, AOFF, ANB, WALL, CRC, RRC, W, H, tile, pad, s, q, x, y, tx, ty, REACH[s]) !== 0) { ON[s] = 0; continue; }
            const dx = tx - x, dy = ty - y, d = Math.sqrt(dx * dx + dy * dy);
            if (!(d > 0) || d > 8 * tile) { ON[s] = 0; continue; }
            const fly = (f & 32) !== 0;
            if (!fly && WALL[tl]) { ON[s] = 0; continue; }
            // (With a path of its own (bit 1), flying is no reason: the path.)
            let direct = d < 2 * tile || (fly && (f & 1) === 0);
            if (!direct && d < 6 * tile) {
                const st = CHS[s], ax = x + dx / d * st, ay = y + dy / d * st, agx = Math.floor(ax / tile), agy = Math.floor(ay / tile);
                direct = agx >= 0 && agy >= 0 && agx < W && agy < H && !WALL[agy * W + agx] && !WALL[qgy * W + qgx];
            }
            if (!direct) { ON[s] = 0; continue; }
            let spd = SPD[s];
            if (FRZ[s] > 0) spd *= 0.5;
            if (SND[s] > 0) spd *= 0.5;
            const nx = x + (dx / d) * spd, ny = y + (dy / d) * spd;
            const ngx = Math.floor(nx / tile), ngy = Math.floor(ny / tile);
            if (!fly && (ngx < 0 || ngy < 0 || ngx >= W || ngy >= H || WALL[ngy * W + ngx])) { ON[s] = 0; continue; }
            const qx = Number.isFinite(nx) ? Math.round(nx * QZ) / QZ : 0, qy = Number.isFinite(ny) ? Math.round(ny * QZ) / QZ : 0;
            PX[s] = x; PY[s] = y; X[s] = qx; Y[s] = qy;
            const qgx2 = Math.floor(qx / tile), qgy2 = Math.floor(qy / tile);
            OUT[s] = qgx2 !== gx || qgy2 !== gy ? 9 : 7;
            continue;
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
            if (HTID[s] === 0 && ((t + id) % 8) === 0) { ON[s] = 0; continue; }
            const cov = COV ? COV[owner] : null, a = AG[bt];
            if (!cov || !(a >= 0) || !(cov[a] > 0)) { ON[s] = 0; continue; }
            const bgx = bt % W, bgy = (bt - bgx) / W;
            if (_simInAreaRange(AG, AOFF, ANB, W, H, tile, x, y, bgx * tile + tile / 2, bgy * tile + tile / 2, REACH[s]) !== 0) { ON[s] = 0; continue; }
        }
        // Hostiles possibly in reach: attack-movers every tick, drive-by
        // shooters on their scan ticks (the tiles of its areas in reach).
        const atk = (f & 16) !== 0;
        if (atk || ((f & 1) !== 0 && ((t + id) & 1) === 0)) {
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
                    if (!atk || CBTK[s] !== t || CBT[s] >= 0 || !HSS) { ON[s] = 0; continue; }
                    // (The look, _findAutoStructureTarget, finds nothing
                    // unless a hostile structure's tile comes within its
                    // aggro range: checked tile by tile when the blocks
                    // around hold one.)
                    if (((t + id) & 3) === 0 && HSS[i11] - HSS[i01] - HSS[i10] + HSS[i00] > 0
                        && _simHostileStructNear(SC, W, H, tile, owner, x, y, RNG[s])) { ON[s] = 0; continue; }
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
                if (last >= 0 && last - now < es * 0.3) {
                    if (near) { ON[s] = 0; continue; }
                    if (CWT[s] === t && CWN[s] === 1) { NLD[s] = -2 - dk; PX[s] = x; PY[s] = y; OUT[s] = 1; continue; }
                }
                navLD = now;
            }
            // The look-ahead from this tile (cached per tile: a pure
            // function of the tile, navigation, walls and destination).
            let n1, n2, far, open;
            if (NVT[s] === tl && NVV[s] === NM[6] && NVW[s] === wver && NVG[s] === FMETA[dm + 6]) {
                n1 = NVN1[s]; n2 = NVN2[s]; far = NVF[s]; open = NVO[s] === 1;
            } else {
                n1 = simNavStep(W, nC, ncw, nnc, NH, NF, NB, NT, NP, df, doff, dbx, dby, dbw, dbh, tl, dk);
                // No way there: a worker more than a tile away stands (as
                // _followNavNode), anything else is handed back (it arrives
                // as near as it gets).
                if (n1 < 0) { if (WK[s] && (Math.abs(dx0 - gx) > 1 || Math.abs(dy0 - gy) > 1)) { PX[s] = x; PY[s] = y; OUT[s] = 1; continue; } ON[s] = 0; continue; }
                if (WL[n1]) {
                    // A wall the navigation predates: around it (as
                    // _followNavNode), toward where the flow leads past it.
                    let aim = simNavStep(W, nC, ncw, nnc, NH, NF, NB, NT, NP, df, doff, dbx, dby, dbw, dbh, n1, dk);
                    if (!(aim >= 0) || WL[aim]) aim = dk;
                    n1 = simNavDetour(WL, W, H, gx, gy, aim);
                    // (Walled in on every side: it stands, as _followNavNode.)
                    if (n1 < 0) { PX[s] = x; PY[s] = y; OUT[s] = 1; continue; }
                    far = n1; n2 = -1; open = false;
                } else {
                    // A step across a border that is not to a neighbouring tile
                    // (a bad build): Unit.update.
                    if (Math.abs(n1 % W - gx) + Math.abs(((n1 - n1 % W) / W) - gy) !== 1) { ON[s] = 0; continue; }
                    // On open ground it looks up to 6 tiles ahead (all with open
                    // blocks) and heads straight there: walked as lines, not stairs.
                    far = n1; n2 = -1;
                    open = _simOpenBlock(WL, tl, W, H) && _simOpenBlock(WL, n1, W, H);
                    let cur = n1;
                    for (let k = 1; k < (open ? 6 : 2); k++) {
                        const nx = simNavStep(W, nC, ncw, nnc, NH, NF, NB, NT, NP, df, doff, dbx, dby, dbw, dbh, cur, dk);
                        if (nx < 0 || WL[nx]) break;
                        if (k === 1) n2 = nx;
                        if (!open || !_simOpenBlock(WL, nx, W, H)) break;
                        far = cur = nx;
                    }
                }
                NVT[s] = tl; NVV[s] = NM[6]; NVW[s] = wver; NVG[s] = FMETA[dm + 6];
                NVN1[s] = n1; NVN2[s] = n2; NVF[s] = far; NVO[s] = open ? 1 : 0;
            }
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
                const sl = simFlowSlide(WALL, W, H, gx, gy, Math.floor((x + vx) / tile), Math.floor((y + vy) / tile));
                if (sl & 1) vx = 0;
                if (sl & 2) vy = 0;
            }
            const nx = x + vx, ny = y + vy;
            const ngx = Math.floor(nx / tile), ngy = Math.floor(ny / tile);
            // Entering another tile is a step (charged like a path node).
            const stepped = ngx !== gx || ngy !== gy;
            PX[s] = x; PY[s] = y; VX[s] = vx; VY[s] = vy; SPENT[s] = stepped ? 1 : 0; FLOOR[s] = tl;
            const qx = Number.isFinite(nx) ? Math.round(nx * q) / q : 0, qy = Number.isFinite(ny) ? Math.round(ny * q) / q : 0;
            X[s] = qx; Y[s] = qy;
            const qgx = Math.floor(qx / tile), qgy = Math.floor(qy / tile);
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
        const ngx = Math.floor(nx / tile), ngy = Math.floor(ny / tile);
        if ((f & 32) === 0 && (ngx < 0 || ngy < 0 || ngx >= W || ngy >= H || WALL[ngy * W + ngx])) {
            X[s] = nx; Y[s] = ny; ON[s] = 0; OUT[s] = 4; continue;
        }
        const qx = Number.isFinite(nx) ? Math.round(nx * q) / q : 0, qy = Number.isFinite(ny) ? Math.round(ny * q) / q : 0;
        X[s] = qx; Y[s] = qy;
        const qgx = Math.floor(qx / tile), qgy = Math.floor(qy / tile);
        OUT[s] = qgx !== gx || qgy !== gy ? 3 : 1;
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
const _simBg = [null, null];
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
            if (regVer < ctl[SIM_PAR_REGVER] || regVer < ctl[SIM_PAR_BG_BASE + SIM_PAR_BG_REGVER] || regVer < ctl[SIM_PAR_BG_BASE + 8 + SIM_PAR_BG_REGVER]) await nextTask();
            // Background chunks while no foreground job is posted (checked
            // between chunks), lane 0 first. A ticket of another job (posted
            // after this one's last chunk was taken) is past its end.
            while (bgParams && Atomics.load(ctl, SIM_PAR_GEN) === seen) {
                let ran = false;
                for (let lane = 0; lane < SIM_PAR_BG_LANES && !ran; lane++) {
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
// [9] players, [10] MAX_THING_LEVEL, [11] stamp (unit.esTaken).
SIM_KERNELS[SIM_KERNEL_EFF_UNITS] = function (R, P, chunk) {
    const SL = R['ix.slots'], DEAD = R['unit.dead'], OK = R['unit.esOk'], RAD = R['unit.esRad'], TYP = R['unit.esType'], TAKEN = R['unit.esTaken'];
    const STK = R['unit.stackCount'], ULV = R['unit.unitLevel'], BLV = R['unit.baseLevel'], ESK = R['unit.effectiveStacks'], ELV = R['unit.effectiveLevel'], LAST = R['unit._lastAppliedEffectiveLevel'];
    const X = R['unit.x'], Y = R['unit.y'], OWN = R['unit.owner'], data = R['spatial.cplx'], F = R['eff.flag'];
    const step = P[2] | 0, phase = P[3] | 0, chunkPx = P[4], CW = P[5] | 0, CH = P[6] | 0, strideC = P[7] | 0, strideP = P[8] | 0, players = P[9] | 0, maxL = P[10], stamp = P[11] | 0;
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
    }
};

// Units' visibility seeds (renderer.js _visCoverUnits): every live,
// indexed unit registered this generation with a range (vsGen = P[5], vsR
// steps) marks the areas under its +-0.3 tile window (ix.agrid: the area of
// each tile, -1 none) for its player and a watching team (vsP1, vsP2) with
// the most steps per area: vis.useed[player * A + area] = stamp << 6 |
// steps (an older stamp is no seed). The first mark of an area this stamp
// lists it in vis.ulist (from player * A, vis.ucnt[player] entries, in no
// particular order).
// P: [0] slots, [1] per job, [2] TILE, [3]/[4] grid, [5] coverage
// generation, [6] areas, [7] players, [8] stamp, [9] SIM_SEP_ABSENT.
SIM_KERNELS[SIM_KERNEL_VIS_SEED] = function (R, P, chunk) {
    const X = R['unit.x'], Y = R['unit.y'], DEAD = R['unit.dead'], SK = R['unit.sepKey'];
    const VG = R['unit.vsGen'], VR = R['unit.vsR'], V1 = R['unit.vsP1'], V2 = R['unit.vsP2'];
    const SEED = R['vis.useed'], LIST = R['vis.ulist'], CNT = R['vis.ucnt'], AG = R['ix.agrid'];
    const tile = P[2], W = P[3] | 0, H = P[4] | 0, gen = P[5] | 0, A = P[6] | 0, np = P[7] | 0, stamp = P[8] | 0, absent = P[9];
    for (let s = chunk * P[1], end = Math.min(P[0], s + P[1]); s < end; s++) {
        if (VG[s] !== gen || DEAD[s] || SK[s] === absent) continue;
        const r = VR[s];
        if (r < 0) continue;
        const fx = X[s] / tile, fy = Y[s] / tile;
        if (!(fx > -1e9 && fx < 1e9 && fy > -1e9 && fy < 1e9)) continue;
        const gx = Math.floor(fx), gy = Math.floor(fy), rx = fx - gx, ry = fy - gy;
        const x0 = rx < .3 ? gx - 1 : gx, x1 = rx < .7 ? gx : gx + 1, y0 = ry < .3 ? gy - 1 : gy, y1 = ry < .7 ? gy : gy + 1;
        const p1 = V1[s], p2 = V2[s], val = (stamp << 6) | r;
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
// 4 died; st.count[chunk]: the chunk's units with events.
// P: [0] units, [1] per job.
SIM_KERNELS[SIM_KERNEL_STATUS] = function (R, P, chunk) {
    const SL = R['ix.slots'], DEAD = R['unit.dead'], EN = R['unit.energy'], AT = R['unit.attackTimer'], AF = R['unit.attackFlash'];
    const TH = R['unit.teleportHideTicks'], BU = R['unit.burning'], BD = R['unit.burnTickDamage'], PO = R['unit.poisoned'], PD = R['unit.poisonTickDamage'];
    const FR = R['unit.frozen'], ID = R['unit.iceTickDamage'], WE = R['unit.wet'], SA = R['unit.sandy'], WA = R['unit.watched'];
    const EV = R['unit.stEv'], DOT = R['unit.stDot'], CNT = R['st.count'];
    const X = R['unit.x'], Y = R['unit.y'], X0 = R['unit.x0'], Y0 = R['unit.y0'], WTC = R['unit.workerTransferCooldown'];
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

// The combat scan (unit.js combatScanRun): for each idle or attack-moving
// unit the kernel did not move, the nearest enemy unit (not dead) within
// its aggro range whose area the unit's player sees (vis.cover), nearest
// first then lowest id: slot into unit.cbT (-1 none), unit.cbTick = tick.
// The unit index (sep.*) lists units by the tile they had at its rebuild;
// positions are read live, so the rings are searched a tile further out.
// Empty surroundings end at once (mv.hostile: hostile structures and other
// players' units per block, summed-area).
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
        if (cmd !== cmdIdle && cmd !== cmdAM) continue;
        const owner = OWN[s] | 0, r = RNG[s];
        if (!(owner >= 0 && owner < players) || !(r > 0)) continue;
        const cov = COVER[owner];
        if (!cov) continue;
        const foe = owner < 8 ? (0xFF ^ (1 << owner)) : 0xFF;
        CTK[s] = t; CT[s] = -1;
        const x = X[s], y = Y[s], cx = Math.floor(x / cws), cy = Math.floor(y / cws);
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
                        if (q < 0 || DEAD[q] || (OWN[q] | 0) === owner) continue;
                        const qx = X0[q], qy = Y0[q], qgx = Math.floor(qx / tile), qgy = Math.floor(qy / tile);
                        if (qgx < 0 || qgy < 0 || qgx >= GW || qgy >= GH) continue;
                        const a = AG[qgy * GW + qgx];
                        if (!(a >= 0) || !(cov[a] > 0)) continue;
                        const dx = qx - x, dy = qy - y, d2 = dx * dx + dy * dy;
                        if (d2 > bd2) continue;
                        if (best < 0 || d2 < bd2 || ID[q] < ID[best]) { best = q; bd2 = d2; }
                    }
                }
            }
        }
        CT[s] = best;
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
