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

// A typed array in shared memory when helpers may use it.
function simSharedArray(Type, n) {
    return SIM_PAR_SHARED ? new Type(new SharedArrayBuffer(Math.max(1, n) * Type.BYTES_PER_ELEMENT)) : new Type(n);
}

// Arrays by name and scalar parameters (the same objects in every thread).
const _simParReg = {};
let _simParRegVer = 0;
const _simParams = simSharedArray(Float64Array, 64);

// ---- kernels: (arrays, params, chunk) ----
const SIM_KERNELS = [];
const SIM_KERNEL_VISIBILITY = 0, SIM_KERNEL_SEPARATION = 1;

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

// Unit separation, gathered per unit: each unit that checks this tick sums
// the pushes of every unit touching it, from its own side (a pair is seen
// from both units; each unit is written by one chunk only). Chunks are
// ranges of tiles. Params: CHUNKS_W, CHUNKS_H, tiles per chunk (rows),
// pad, farAny, Q, SHARE_BOTH, SHARE_ONE. Arrays (sorted entries): sep.ord,
// sep.sx/sy/sr (position, radius), sep.so (owner), sep.sl (layer), sep.sc
// (checks), sep.sid (id), sep.sdx/sdy (motion, for exact overlaps); per
// tile: sep.start, sep.chunkR, sep.chunkC, sep.sole; offsets: sep.offs
// (dx, dy, gap triples over the whole neighbourhood); outputs by unit
// index: sep.px/py (integer sums), sep.ov (deepest overlap), sep.hit.
SIM_KERNELS[SIM_KERNEL_SEPARATION] = function (R, P, chunk) {
    const CW = P[0] | 0, CH = P[1] | 0, rowsPer = P[2] | 0, pad = P[3], farAny = P[4], Q = P[5], BOTH = P[6], ONE = P[7], nOffs = P[8] | 0;
    const ord = R['sep.ord'], sx = R['sep.sx'], sy = R['sep.sy'], sr = R['sep.sr'], so = R['sep.so'], sl = R['sep.sl'], sc = R['sep.sc'];
    const sid = R['sep.sid'], sdx = R['sep.sdx'], sdy = R['sep.sdy'];
    const start = R['sep.start'], chunkR = R['sep.chunkR'], chunkC = R['sep.chunkC'], sole = R['sep.sole'], offs = R['sep.offs'];
    const PX = R['sep.px'], PY = R['sep.py'], OV = R['sep.ov'], HIT = R['sep.hit'];
    const cy0 = chunk * rowsPer, cy1 = Math.min(CH, cy0 + rowsPer);
    for (let cy = cy0; cy < cy1; cy++) for (let cx = 0; cx < CW; cx++) {
        let key = cy * CW + cx;
        let a0 = start[key], a1 = start[key + 1];
        if (a0 === a1 || !chunkC[key]) continue;
        let rA = chunkR[key];
        for (let p = a0; p < a1; p++) {
            if (!sc[p]) continue;
            let xp = sx[p], yp = sy[p], rp = sr[p], op = so[p], lp = sl[p];
            let px = 0, py = 0, ov = 0, hit = 0;
            for (let k = -1; k < nOffs; k++) {
                let b0, b1;
                if (k < 0) { b0 = a0; b1 = a1; }
                else {
                    let gap = offs[k * 3 + 2];
                    if (gap >= farAny) continue;
                    let nx = cx + offs[k * 3], ny = cy + offs[k * 3 + 1];
                    if (nx < 0 || nx >= CW || ny < 0 || ny >= CH) continue;
                    let key2 = ny * CW + nx;
                    b0 = start[key2]; b1 = start[key2 + 1];
                    if (b0 === b1) continue;
                    let near = rA + chunkR[key2];
                    if (gap >= near + pad) continue;
                    if (gap >= near && sole[key] >= 0 && sole[key2] === sole[key]) continue;
                }
                for (let q = b0; q < b1; q++) {
                    if (q === p || sl[q] !== lp) continue;
                    let dx = sx[q] - xp, dy = sy[q] - yp, d2 = dx * dx + dy * dy;
                    let minDist = rp + sr[q] + (so[q] === op ? 0 : pad);
                    if (d2 >= minDist * minDist) continue;
                    let d = Math.sqrt(d2);
                    let overlap = minDist - Math.max(d, 0.001);
                    let f = overlap * (sc[q] ? BOTH : ONE) * Q;
                    let nxv, nyv;
                    if (d > 0.001) { nxv = -dx / d; nyv = -dy / d; }
                    else {
                        // Exact overlap: sideways to its motion, split by id.
                        let mdx = sdx[p], mdy = sdy[p];
                        let pairSign = sid[p] < sid[q] ? -1 : 1;
                        if (Math.abs(mdx) >= Math.abs(mdy)) { nxv = 0; nyv = (mdx >= 0 ? -1 : 1) * pairSign; }
                        else { nxv = (mdy >= 0 ? 1 : -1) * pairSign; nyv = 0; }
                    }
                    px += Math.round(nxv * f); py += Math.round(nyv * f);
                    if (overlap > ov) ov = overlap;
                    hit++;
                }
            }
            let a = ord[p];
            PX[a] = px; PY[a] = py; OV[a] = ov; HIT[a] = hit;
        }
    }
};

// ---- the pool (simulation worker) ----
let _simPool = null;

// Starts the helpers (simulation worker, with shared memory and 3+ cores).
function simParallelInit(helperUrl, maxHelpers = null) {
    if (_simPool || !SIM_PAR_SHARED || typeof Worker !== 'function') return 0;
    let cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
    let n = Math.max(0, Math.min(7, cores - 2));
    if (Number.isFinite(maxHelpers)) n = Math.min(n, Math.max(0, maxHelpers));
    if (n < 1) return 0;
    let ctl = new Int32Array(new SharedArrayBuffer(64 * 4));
    let helpers = [];
    for (let i = 0; i < n; i++) {
        try {
            let w = new Worker(helperUrl);
            w.onerror = e => { console.error('[sim helper]', e.message || e); };
            w.postMessage({ type: 'init', ctl, params: _simParams, index: i });
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

// ---- a helper's side (sim_helper.js) ----
function simParallelHelperMain() {
    let ctl = null, seen = 0, regVer = 0;
    self.onmessage = ev => {
        let m = ev.data || {};
        if (m.type === 'init') {
            ctl = m.ctl;
            _simParHelperParams = m.params;
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
            if (regVer < ctl[SIM_PAR_REGVER]) await nextTask();
        }
    }
}
let _simParHelperParams = null;
