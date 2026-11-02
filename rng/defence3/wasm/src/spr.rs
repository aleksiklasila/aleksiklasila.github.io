//! Spawner production as table passes (TABLES_CONVERSION_PLAN.md S2;
//! barrack.js processGlobalSpawnerQueue, spawnerProduction*): every step the
//! barracks' and spawners' rows are brought up to date on the helpers (the
//! spawn timer from the queue front's payment, a ready order once paid), the
//! ready ones picked in ready order within their owners' population room
//! (the step's spawns, made by unit.js simSpawnBatch*), and the queues of
//! those that spawned moved on. Per spawner type, owner and base level, its
//! cooldown and its next unit's cost: spr.tab, filled by the JavaScript for
//! the keys this pass reports (barrack.js _spTabFill).
use super::*;
use super::k::K;

#[inline(always)]
unsafe fn g<T: Copy>(p: *const T, i: usize) -> T { *p.add(i) }
#[inline(always)]
unsafe fn s<T>(p: *mut T, i: usize, v: T) { *p.add(i) = v; }

/// A class's words in spr.cls: rows, class tag, then its columns' encoded
/// addresses (_stT, _ow, _en, _uc, queueEnabled, _qN, _qLv, _qReq, _qPaid,
/// _spt, _spawnReadyOrder: Int32, a ticket from the order counter, NONE not ready).
pub const SC_W: usize = 16;
const SC_N: usize = 0; const SC_TAG: usize = 1; const SC_ST: usize = 2; const SC_OW: usize = 3; const SC_EN: usize = 4; const SC_UC: usize = 5;
const SC_QON: usize = 6; const SC_QN: usize = 7; const SC_QLV: usize = 8; const SC_QREQ: usize = 9; const SC_QPAID: usize = 10; const SC_SPT: usize = 11; const SC_RDY: usize = 12;
/// Per job in spr.out, R rows: ready (order, tile, owner) triples, newly
/// ready rows (class << 24 | row), stale table keys.
pub const SJ_W: usize = 5;
/// A ready order's none (the Int32 column's undefined).
const NONE: i32 = i32::MIN;
#[inline(always)]
unsafe fn col<T>(cls: *const i32, k: usize, j: usize) -> *mut T { waddr(g(cls, k * SC_W + j) as u32) as *mut T }

/// A row's table key: ((owner + 1) * types + type) * 64 + base level (the
/// brain word: type + 1 in its low 16 bits, base level in bits 16-23); -1 none.
#[inline(always)]
fn key_of(brain: i32, owner: i32, types: i32) -> i32 {
    let ty = (brain & 65535) - 1;
    if ty < 0 || ty >= types || owner < -1 || owner > 62 { return -1; }
    let lv = ((brain >> 16) & 255).max(1).min(63);
    ((owner + 1) * types + ty) * 64 + lv
}

/// SIM_KERNEL_SPAWN_PROD: per job (spr.jobs: class, first row, end row) the
/// rows' production. P[1] 0: the table keys missing or stale listed; 1: each
/// row brought up to date (barrack.js updateSpawnerProductionProgress): no
/// queue: timer 0, not ready; else its timer from its front's payment, not
/// ready while unpaid, newly ready listed (an order from the select), and
/// listed with its order when it may spawn (_spawnReadyValid). Arrays: [0]
/// spr.cls, [1] spr.jobs, [2] st.brain, [3] st.ctab, [4] st.rrow, [5]
/// st.tim, [6] spr.tab (cooldown, cost, version a key), [7] spr.out, [8]
/// spr.cnt (per job: ready, new, stale). P: [0] jobs, [1] mode, [2] the
/// stat tables' version, [3] types, [4] rows a job at most.
#[no_mangle]
pub unsafe extern "C" fn k_spawn_prod(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (cls, jobs, brain, ctab, rrow, tim, tab, out, cnt) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<u8>(3), k.p::<i32>(4), k.p::<f64>(5), k.p::<f64>(6), k.p::<i32>(7), k.p::<i32>(8));
    let j = chunk.max(0) as usize;
    if chunk >= k.i(0) { return; }
    let (mode, ver, types, rmax) = (k.i(1), k.f(2), k.i(3).max(1), k.i(4).max(1) as usize);
    let (c, r0, r1) = (g(jobs, j * 3) as usize, g(jobs, j * 3 + 1).max(0) as usize, g(jobs, j * 3 + 2).max(0) as usize);
    let base = j * rmax * SJ_W;
    let (rd, nw, st) = (out.add(base), out.add(base + rmax * 3), out.add(base + rmax * 4));
    let (mut nr, mut nn, mut ns) = (0usize, 0usize, 0usize);
    let tag = g(cls, c * SC_W + SC_TAG);
    let (stt, ow, en, uc, qon, qn) = (col::<i32>(cls, c, SC_ST), col::<i8>(cls, c, SC_OW), col::<f64>(cls, c, SC_EN), col::<u8>(cls, c, SC_UC), col::<u8>(cls, c, SC_QON), col::<i8>(cls, c, SC_QN));
    let (qreq, qpaid, spt, rdy) = (col::<f64>(cls, c, SC_QREQ), col::<f64>(cls, c, SC_QPAID), col::<f64>(cls, c, SC_SPT), col::<i32>(cls, c, SC_RDY));
    let n = g(cls, c * SC_W + SC_N).max(0) as usize;
    for r in r0..r1.min(n) {
        let t = g(stt, r);
        if t < 0 { continue; }
        let tu = t as usize;
        // (In the world: the structure at its tile is this row.)
        if g(ctab, tu) as i32 != tag || g(rrow, tu) != r as i32 { continue; }
        if !(g(en, r) > 0.0) || g(uc, r) == 2 { continue; }
        let q = g(qn, r);
        let qc = if q == -128 { 0 } else { q as i32 };
        let o = g(ow, r) as i32;
        let key = key_of(g(brain, tu), if o == -128 { -1 } else { o }, types);
        if mode == 0 {
            if qc > 0 && key >= 0 && g(tab, key as usize * 3 + 2) != ver && ns < rmax { s(st, ns, key); ns += 1; }
            continue;
        }
        if qc <= 0 {
            if g(spt, r) != 0.0 { s(spt, r, 0.0); s(tim, tu, 0.0); }
            s(rdy, r, NONE);
            continue;
        }
        let (paid, req) = (g(qpaid, r), g(qreq, r));
        if key >= 0 && g(tab, key as usize * 3 + 2) == ver {
            let cd0 = g(tab, key as usize * 3);
            let cd = js_max(1.0, js_round(if cd0 == cd0 && cd0 != 0.0 { cd0 } else { 1.0 }));
            let pct = if req > 0.0 { paid / req } else { 0.0 };
            let tv = js_max(0.0, js_min(cd, js_round(cd * pct)));
            s(spt, r, tv); s(tim, tu, tv);
        }
        if paid >= req {
            let ro = g(rdy, r);
            if ro == NONE { if nn < rmax { s(nw, nn, ((c as i32) << 24) | r as i32); nn += 1; } }
            else if g(qon, r) != 1 && nr < rmax { s(rd, nr * 3, ro); s(rd, nr * 3 + 1, t); s(rd, nr * 3 + 2, o); nr += 1; }
        } else { s(rdy, r, NONE); }
    }
    s(cnt, j * 16, nr as i32); s(cnt, j * 16 + 1, nn as i32); s(cnt, j * 16 + 2, ns as i32);
}

/// The step's spawns (processGlobalSpawnerQueue's order): the newly ready
/// rows get orders from the counter (in the jobs' order), then the ready
/// ones by order (a radix sort), each taken while its owner has room (P[3 +
/// owner]: population cap less population; P[62] the entries spr.tmp holds). Arrays: [0] spr.cls, [1]
/// spr.out, [2] spr.cnt, [3] spr.sel ([0] count, then tiles), [4] spr.tmp
/// (scratch: 5 words an entry and 65536). P: [0] jobs, [1] rows a job at most, [2] the
/// order counter (returned in spr.sel's last word + 1), [3..] owners' room;
/// P[63] owners.
#[no_mangle]
pub unsafe extern "C" fn k_spawn_select(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (cls, out, cnt, sel, tmp) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<u32>(4));
    let (jobs, rmax) = (k.i(0).max(0) as usize, k.i(1).max(1) as usize);
    let mut counter = k.i(2);
    let np = k.i(63).max(0).min(56) as usize;
    let mut room = [0i32; 56];
    for o in 0..np { room[o] = k.i(3 + o); }
    // Gather: the ready ones, then the new ones with their orders.
    let mut m = 0usize;
    let cap = k.i(62).max(1) as usize;
    let (ord, tl, own) = (tmp, tmp.add(cap), tmp.add(2 * cap));
    for j in 0..jobs {
        let base = j * rmax * SJ_W;
        let rd = out.add(base);
        for i in 0..g(cnt, j * 16).max(0) as usize { if m >= cap { break; } s(ord, m, g(rd, i * 3) as u32); s(tl, m, g(rd, i * 3 + 1) as u32); s(own, m, g(rd, i * 3 + 2) as u32); m += 1; }
    }
    for j in 0..jobs {
        let base = j * rmax * SJ_W;
        let nw = out.add(base + rmax * 3);
        for i in 0..g(cnt, j * 16 + 1).max(0) as usize {
            let w = g(nw, i);
            let (c, r) = ((w >> 24) as usize, (w & 0xFFFFFF) as usize);
            if m >= cap { break; }
            let o = counter; counter += 1;
            s(col::<i32>(cls, c, SC_RDY), r, o);
            if g(col::<u8>(cls, c, SC_QON), r) == 1 { continue; }
            s(ord, m, o as u32); s(tl, m, g(col::<i32>(cls, c, SC_ST), r) as u32); s(own, m, g(col::<i8>(cls, c, SC_OW), r) as i32 as u32); m += 1;
        }
    }
    // By order: an LSD radix sort, 16 bits a pass, of entry indices.
    let (ix, ix2, hist) = (tmp.add(3 * cap), tmp.add(4 * cap), tmp.add(5 * cap));
    for i in 0..m { s(ix, i, i as u32); }
    let (mut src, mut dst) = (ix, ix2);
    for pass in 0..2 {
        let sh = pass * 16;
        for b in 0..65536usize { s(hist, b, 0); }
        for i in 0..m { let b = ((g(ord, g(src, i) as usize) >> sh) & 65535) as usize; s(hist, b, g(hist, b) + 1); }
        let mut sum = 0u32;
        for b in 0..65536usize { let v = g(hist, b); s(hist, b, sum); sum += v; }
        for i in 0..m { let e = g(src, i); let b = ((g(ord, e as usize) >> sh) & 65535) as usize; let p = g(hist, b); s(dst, p as usize, e); s(hist, b, p + 1); }
        let t = src; src = dst; dst = t;
    }
    let mut n = 0usize;
    for i in 0..m {
        let e = g(src, i) as usize;
        let o = g(own, e) as i32;
        if o < 0 || o as usize >= np || room[o as usize] <= 0 { continue; }
        room[o as usize] -= 1;
        n += 1; s(sel, n, g(tl, e) as i32);
    }
    s(sel, 0, n as i32);
    // (The counter back.)
    s(sel, n + 1, counter); s(sel, n + 2, 0);
}

/// The queues of the spawners that spawned moved on (spawnQueueShift): one
/// less; the next front's level (the base level), cost (spr.tab) and nothing
/// paid. Arrays: [0] spr.cls, [1] the spawners (class << 24 | row), [2]
/// st.brain, [3] spr.tab. P: [0] count, [1] types.
#[no_mangle]
pub unsafe extern "C" fn k_spawn_shift(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (cls, list, brain, tab) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<f64>(3));
    let (n, types) = (k.i(0).max(0) as usize, k.i(1).max(1));
    for i in 0..n {
        let w = g(list, i);
        let (c, r) = ((w >> 24) as usize, (w & 0xFFFFFF) as usize);
        let (qn, qlv, qreq, qpaid) = (col::<i8>(cls, c, SC_QN), col::<f64>(cls, c, SC_QLV), col::<f64>(cls, c, SC_QREQ), col::<f64>(cls, c, SC_QPAID));
        let q = g(qn, r);
        if q == -128 || q <= 0 { continue; }
        let left = q - 1;
        s(qn, r, left);
        if left <= 0 { s(qlv, r, 0.0); s(qreq, r, 0.0); s(qpaid, r, 0.0); continue; }
        let t = g(col::<i32>(cls, c, SC_ST), r);
        let o = g(col::<i8>(cls, c, SC_OW), r) as i32;
        let b = if t >= 0 { g(brain, t as usize) } else { 0 };
        let key = key_of(b, if o == -128 { -1 } else { o }, types);
        let lv = ((b >> 16) & 255).max(1) as f64;
        let cost = if key >= 0 { g(tab, key as usize * 3 + 1) } else { f64::NAN };
        s(qlv, r, lv);
        s(qreq, r, js_max(1.0, floor(if cost.is_finite() { cost } else { 1.0 })));
        s(qpaid, r, 0.0);
    }
}
