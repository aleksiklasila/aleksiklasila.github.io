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
/// (scratch: 8 words an entry and 65536). P: [0] jobs, [1] rows a job at most, [2] the
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
    // The new ones take their orders by tile (an LSD radix sort, 16 bits a
    // pass), not in the rows' order: a restore lays the structure tables'
    // rows out anew (by the snapshot's lists), and in row order a restored
    // peer's spawners took other orders than the others': other spawns in
    // the same tick, other unit ids (2026-11-05, 524k scene).
    // (spr.tmp words 5 cap + 65536 on: the new ones' words, tiles, order.)
    let (ix, ix2, hist) = (tmp.add(3 * cap), tmp.add(4 * cap), tmp.add(5 * cap));
    let (nwv, nkv, niv) = (tmp.add(5 * cap + 65536), tmp.add(6 * cap + 65536), tmp.add(7 * cap + 65536));
    let mut q = 0usize;
    for j in 0..jobs {
        let base = j * rmax * SJ_W;
        let nw = out.add(base + rmax * 3);
        for i in 0..g(cnt, j * 16 + 1).max(0) as usize {
            if m + q >= cap { break; }
            let w = g(nw, i);
            let (c, r) = ((w >> 24) as usize, (w & 0xFFFFFF) as usize);
            s(nwv, q, w as u32); s(nkv, q, g(col::<i32>(cls, c, SC_ST), r) as u32); q += 1;
        }
    }
    if q > 1 {
        for i in 0..q { s(ix, i, i as u32); }
        let (mut src, mut dst) = (ix, niv);
        for pass in 0..2 {
            let sh = pass * 16;
            for b in 0..65536usize { s(hist, b, 0); }
            for i in 0..q { let b = ((g(nkv, g(src, i) as usize) >> sh) & 65535) as usize; s(hist, b, g(hist, b) + 1); }
            let mut sum = 0u32;
            for b in 0..65536usize { let v = g(hist, b); s(hist, b, sum); sum += v; }
            for i in 0..q { let e = g(src, i); let b = ((g(nkv, e as usize) >> sh) & 65535) as usize; let p = g(hist, b); s(dst, p as usize, e); s(hist, b, p + 1); }
            let t = src; src = dst; dst = t;
        }
    } else if q == 1 { s(ix, 0, 0); }
    for k2 in 0..q {
        let e = g(ix, k2) as usize;
        let w = g(nwv, e) as i32;
        let (c, r) = ((w >> 24) as usize, (w & 0xFFFFFF) as usize);
        let o = counter; counter += 1;
        s(col::<i32>(cls, c, SC_RDY), r, o);
        if g(col::<u8>(cls, c, SC_QON), r) == 1 { continue; }
        s(ord, m, o as u32); s(tl, m, g(col::<i32>(cls, c, SC_ST), r) as u32); s(own, m, g(col::<i8>(cls, c, SC_OW), r) as i32 as u32); m += 1;
    }
    // By order: an LSD radix sort, 16 bits a pass, of entry indices.
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

/// A group's spawn queue changes (main.js spawnCounts): per tile [1][i] its
/// count [2][i] (+ pushed, - taken off) on the structure there (st.ctab [3],
/// st.rrow [4]) of a barrack class (P[3] 0: class 0) or a spawner class
/// (P[3] 1: the others), owned by P[2]; pushes on a built one with energy,
/// at most P[8] queued. A front made from nothing: the base level (st.brain
/// [5]), its cost (spr.tab [6] at the key, P[7] its version), nothing paid.
/// P[6] 0: only the keys of fronts to make whose cost is not in the table
/// listed ([7], count [8][1]); 1: done, the changed tiles listed ([7],
/// [8][0]), a queue emptied with its timer 0 and no ready order.
/// Arrays: [0] spr.cls, [9] st.tim. P: [0] count, [1] types, [4] classes, [5] tiles.
#[no_mangle]
pub unsafe extern "C" fn k_spawn_counts(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (cls, tiles, counts, ctab, rrow, brain, tab, out, cnt) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<u8>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<f64>(6), k.p::<i32>(7), k.p::<i32>(8));
    let tim = k.p::<f64>(9);
    let (n, types, player, worker, ncls, ntiles, phase, cap) = (k.i(0).max(0) as usize, k.i(1).max(1), k.i(2), k.i(3) != 0, k.i(4).max(0) as usize, k.i(5).max(0), k.i(6), k.i(8).max(0));
    let ver = k.f(7);
    let (mut m, mut miss) = (0usize, 0usize);
    for i in 0..n {
        let t = g(tiles, i);
        let d = g(counts, i);
        if t < 0 || t >= ntiles || d == 0 { continue; }
        let tu = t as usize;
        let tag = g(ctab, tu) as i32;
        let mut c = usize::MAX;
        for j in 0..ncls { if tag != 0 && g(cls, j * SC_W + SC_TAG) == tag && g(cls, j * SC_W + SC_N) > 0 { c = j; break; } }
        if c == usize::MAX || (c == 0) == worker { continue; }
        let r = g(rrow, tu);
        if r < 0 { continue; }
        let r = r as usize;
        let ow = col::<i8>(cls, c, SC_OW);
        let o = g(ow, r) as i32;
        if o != player { continue; }
        let (en, uc, qn, qlv, qreq, qpaid, spt, rdy) = (col::<f64>(cls, c, SC_EN), col::<u8>(cls, c, SC_UC), col::<i8>(cls, c, SC_QN), col::<f64>(cls, c, SC_QLV),
            col::<f64>(cls, c, SC_QREQ), col::<f64>(cls, c, SC_QPAID), col::<f64>(cls, c, SC_SPT), col::<i32>(cls, c, SC_RDY));
        let q0 = g(qn, r);
        let mut q = if q0 == -128 { 0 } else { q0 as i32 };
        let b = g(brain, tu);
        let key = key_of(b, o, types);
        if d > 0 {
            if !(g(en, r) > 0.0) || g(uc, r) == 2 { continue; }
            let add = d.min(cap - q).max(0);
            if add == 0 { continue; }
            if phase == 0 {
                if q <= 0 && key >= 0 && g(tab, key as usize * 3 + 2) != ver { s(out, miss, key); miss += 1; }
                continue;
            }
            if q <= 0 {
                q = 0;
                let cost = if key >= 0 { g(tab, key as usize * 3 + 1) } else { f64::NAN };
                s(qlv, r, ((b >> 16) & 255).max(1) as f64);
                s(qreq, r, js_max(1.0, floor(if cost.is_finite() { cost } else { 1.0 })));
                s(qpaid, r, 0.0);
            }
            s(qn, r, (q + add) as i8);
        } else {
            if q <= 0 { continue; }
            // (Taken off one by one, the next front made each time: as spawnQueueShift.)
            let take = (-d).min(q);
            if phase == 0 {
                if q - take > 0 && key >= 0 && g(tab, key as usize * 3 + 2) != ver { s(out, miss, key); miss += 1; }
                continue;
            }
            q -= take;
            s(qn, r, q as i8);
            if q <= 0 { s(qlv, r, 0.0); s(qreq, r, 0.0); s(qpaid, r, 0.0); }
            else {
                let cost = if key >= 0 { g(tab, key as usize * 3 + 1) } else { f64::NAN };
                s(qlv, r, ((b >> 16) & 255).max(1) as f64);
                s(qreq, r, js_max(1.0, floor(if cost.is_finite() { cost } else { 1.0 })));
                s(qpaid, r, 0.0);
            }
        }
        // (barrack.js spawnerProductionChanged: an empty queue's timer 0, no ready order.)
        // (st.tim [9] with it: the tile table's copy of the timer, which the state hash reads.)
        if q <= 0 && g(en, r) > 0.0 && g(uc, r) != 2 { s(spt, r, 0.0); s(rdy, r, i32::MIN); if !tim.is_null() { s(tim, tu, 0.0); } }
        s(out, m, t); m += 1;
    }
    s(cnt, 0, m as i32); s(cnt, 1, miss as i32);
}

// ---- The step's spawns as births (barrack.js _processSpawnsByTables; UNIT_BIRTH_WASM_PLAN.md "Production spawns") ----

/// k_spawn_births' arguments, by index (barrack.js _spawnBirthArgs).
const B_SEL: usize = 0; const B_CLS: usize = 1; const B_BRAIN: usize = 2; const B_CTAB: usize = 3; const B_RROW: usize = 4; const B_TIM: usize = 5;
const B_WALL: usize = 6; const B_BOOKS: usize = 7; const B_USED: usize = 13; const B_EVER: usize = 14;
const B_ZTAB: usize = 16; const B_KIND: usize = 17; const B_COLIX: usize = 18; const B_STY: usize = 19; const B_UT: usize = 20; const B_STK: usize = 21;
const B_HSLOT: usize = 22; const B_HFREE: usize = 23; const B_UIDS: usize = 24; const B_USLOTS: usize = 25; const B_IDT: usize = 26;
const B_OBITS: usize = 27; const B_OMASK: usize = 28; const B_OREC: usize = 29;
const B_RMAXE: usize = 31; const B_HOT: usize = 32; const B_TYS: usize = 33; const B_RWCH: usize = 34; const B_BRAD: usize = 35; const B_SVER: usize = 36;
const B_WFREE: usize = 37; const B_WTAB: usize = 38; const B_WDEFS: usize = 39; const B_WVER: usize = 40;
const B_OUT: usize = 41; const B_SHIFT: usize = 42; const B_LIST: usize = 43; const B_DIRTY: usize = 44; const B_SEPKEY: usize = 45; const B_MVTD: usize = 46;
const B_WKIND: usize = 47;
/// The rally: per class (spr.cls's order) its rally columns' encoded addresses (RW_W words: rallyX, rallyY, rallyTargetUnitId,
/// _rallyLastSeenX, _rallyLastSeenY (f64), _pendingRallyDetach (u8)); the new workers' rally events (slot * 8 + 6, out[12]); the
/// air's walls; each player's visibility cover (encoded, by area: renderer.js _visCover.cover) and the tiles' areas (map.js cellArea).
const B_RALLY: usize = 48; const B_EVL: usize = 49; const B_AIRW: usize = 50; const B_COVER: usize = 51; const B_CAREA: usize = 52;
const RW_W: usize = 8;
/// The unit columns it writes: their places in the slot table (spw.colix, barrack.js _SPAWN_BIRTH_COLS' order; -1 none).
const C_ID: usize = 0; const C_OWNER: usize = 1; const C_UPT: usize = 2; const C_X: usize = 3; const C_Y: usize = 4; const C_PX: usize = 5; const C_PY: usize = 6;
const C_X0: usize = 7; const C_Y0: usize = 8; const C_R: usize = 9; const C_CR: usize = 10; const C_ULV: usize = 11; const C_STK: usize = 12; const C_ESTK: usize = 13;
const C_ELV: usize = 14; const C_BLV: usize = 15; const C_TUS: usize = 16; const C_TUID: usize = 17; const C_TBT: usize = 18; const C_ACQB: usize = 19; const C_TGX: usize = 20;
const C_TGY: usize = 21; const C_HND: usize = 22; const C_DEAD: usize = 23; const C_DEAD0: usize = 24; const C_EN: usize = 25; const C_LIVE: usize = 26; const C_TMON: usize = 27;
const C_MAXE: usize = 28; const C_JMAXE: usize = 29; const C_LAST: usize = 30; const C_SROW: usize = 31; const C_BSROW: usize = 32; const C_ESOK: usize = 33; const C_ESRAD: usize = 34;
const C_ESTY: usize = 35; const C_ESVER: usize = 36; const C_JFLY: usize = 37; const C_LZ: usize = 38; const C_LANE: usize = 39; const C_RD: usize = 40; const C_RA: usize = 41;
const C_SHOOT: usize = 42; const C_RK: usize = 43; const C_ASTY: usize = 44; const C_WCH: usize = 45; const C_WKS: usize = 46; const C_WKR: usize = 47; const C_WKIX: usize = 48;
const C_ISWK: usize = 49; const C_HOBJ: usize = 50; const C_WKIDLE: usize = 51; const C_OCWT: usize = 52; const C_SD0: usize = 53; const C_SR0: usize = 54; const C_SL0: usize = 55;
const C_NVPK: usize = 56; const C_PIDX: usize = 57; const C_CMD: usize = 58;
/// A unit type's spawn words (spw.ut, f64, UT_W a type, by its index unit.upT): its effective-stats type, radius,
/// collision radius, footprint radius (cells) and layer, worker kind (wbType, 0 none), first wkS, hObj's change for
/// its workerType, that type's shared id, flying, esOk.
const UT_W: usize = 12;
const UT_TY: usize = 0; const UT_R: usize = 1; const UT_CR: usize = 2; const UT_OR: usize = 3; const UT_OL: usize = 4; const UT_WB: usize = 5; const UT_WKS: usize = 6;
const UT_HOBJ: usize = 7; const UT_WTID: usize = 8; const UT_FLY: usize = 9; const UT_ESOK: usize = 10;
/// Out words (spw.out): [0] births, [1] blocked, [2] handles off the free stack, [3] handles new, [4] worker records
/// off the free stack, [5] new, [6] the order counter after, [7] the work versions' checksum change, [8] dirty tiles,
/// [9] footprints moved from the exit, [10] a worker record past the pool (none expected), [11] shifts; [16 + o]
/// owner o's births; [80 + r] births of footprint radius r.
const O_POP: usize = 16; const O_RAD: usize = 80;

#[inline(always)]
unsafe fn bput(ix: *const i32, zt: *const i32, kind: *const i32, c: usize, q: usize, v: f64) {
    let e = g(ix, c);
    if e >= 0 { super::nfs::spawn_put(zt, kind, e as usize, q, v); }
}
#[inline(always)]
unsafe fn bget(ix: *const i32, zt: *const i32, kind: *const i32, c: usize, q: usize) -> f64 {
    let e = g(ix, c);
    if e < 0 { return f64::NAN; }
    let e = e as usize;
    let base = waddr(g(zt, 3 * e) as u32) as *const u8;
    let (bytes, per) = (g(zt, 3 * e + 1) as usize, g(zt, 3 * e + 2) as usize);
    let at = base.add(q * per * bytes);
    match (g(kind, e), bytes) { (2, 4) => *(at as *const f32) as f64, (3, 8) => *(at as *const f64), (_, 1) => *(at as *const i8) as f64, (_, 2) => *(at as *const i16) as f64, (_, 4) => *(at as *const i32) as f64, _ => f64::NAN }
}
/// navApproachTile on a profile's walls (wai.rs approach): t when open, else the open tile nearest it within 6 rings (steps, then
/// the scan's order), -1 none.
unsafe fn approach_open(wall: *const u8, gw: i32, gh: i32, t: i32) -> i32 {
    if !(t >= 0 && t < gw * gh) { return -1; }
    if wall.is_null() || g(wall, t as usize) == 0 { return t; }
    let (tx, ty) = (t % gw, t / gw);
    let mut r = -1;
    let mut d: i32 = 1;
    while d <= 6 && r < 0 {
        let mut best = i32::MAX;
        for dy in -d..=d { for dx in -d..=d {
            if dx.abs().max(dy.abs()) != d { continue; }
            let (x, y) = (tx + dx, ty + dy);
            if x < 0 || y < 0 || x >= gw || y >= gh || g(wall, (y * gw + x) as usize) != 0 { continue; }
            let dd = dx.abs() + dy.abs();
            if dd < best { best = dd; r = y * gw + x; }
        } }
        d += 1;
    }
    r
}
/// findNearestWalkable(gx, gy) with no unit (tch.rs k_nearest_walk, mode 0): the map's walls only.
unsafe fn exit_tile(wall: *const u8, w: i32, h: i32, gx: i32, gy: i32) -> (i32, i32) {
    let ok = |x: i32, y: i32| -> bool { x >= 0 && y >= 0 && x < w && y < h && (wall.is_null() || g(wall, (y * w + x) as usize) == 0) };
    if ok(gx, gy) { return (gx, gy); }
    let maxr = w.max(h);
    for r in 1..=maxr {
        let mut x = gx - r;
        while x <= gx + r { if ok(x, gy - r) { return (x, gy - r); } if ok(x, gy + r) { return (x, gy + r); } x += 1; }
        let mut y = gy - r + 1;
        while y <= gy + r - 1 { if ok(gx - r, y) { return (gx - r, y); } if ok(gx + r, y) { return (gx + r, y); } y += 1; }
    }
    (gx.max(0).min(w - 1), gy.max(0).min(h - 1))
}

/// Spawn births (direct, one job: barrack.js _processSpawnsByTables): each spawner the production pass picked
/// (spr.sel, in order) makes its queue front's unit, or is blocked (out of the world, no energy, building, its queue
/// off or empty, no free footprint near its exit, no slot): the exit (its tile's nearest open one), the footprint's
/// place (occ.rs occ_find), the slot (the slab books, by the place's block), its handle, id, core columns, stats
/// from the effective rows (as k_unit_stats_apply: levels, rows, maxEnergy, energy = maxEnergy, the movement
/// columns), its worker set-up (a record at its defaults, wbType, wkS, workerType's shared id and digest term), the
/// footprint, the id table's row and hash; the spawner's timer 0 and its ready order none, its queue's shift
/// listed; its healers' work version, its tile on the sweep's dirty list. The blocked get new ready orders, in order.
/// The births' slots in order into the list (their spatial entries and upkeep bins: the JavaScript's kernels).
/// P: [0] picked, [1] W, [2] H, [3] TILE, [4] slots the columns have, [5] slack min, [6] slack shift, [7] slab key
/// tiles, [8] kw, [9] kh, [10] first id, [11] free handles, [12] next handle, [13..17] occupancy w, h, stride, cell,
/// planes, [18] free worker records, [19] used, [20] records, [21] NT, [22] L1, [23] NP, [25] the order counter,
/// [26] id hash mask, [27] id table rows, [28] SIM_SEP_ABSENT, [29] work region tiles, [30] work types, [31] the
/// healers' work type, [32] the stationary types, [33] unit types, [34] worker side columns, [35] box steps.
#[no_mangle]
pub unsafe extern "C" fn k_spawn_births(a: u32, _chunk: i32) {
    use super::nfs::{Books, slab_alloc};
    let k = K::new(waddr(a) as *const i32);
    let (sel, cls, brain, ctab, rrow, tim) = (k.p::<i32>(B_SEL), k.p::<i32>(B_CLS), k.p::<i32>(B_BRAIN), k.p::<u8>(B_CTAB), k.p::<i32>(B_RROW), k.p::<f64>(B_TIM));
    let wall = k.p::<u8>(B_WALL);
    let (used, ever) = (k.p::<u32>(B_USED), k.p::<u32>(B_EVER));
    let (zt, kind, ix) = (k.p::<i32>(B_ZTAB), k.p::<i32>(B_KIND), k.p::<i32>(B_COLIX));
    let (sty, ut, stk) = (k.p::<i32>(B_STY), k.p::<f64>(B_UT), k.p::<f64>(B_STK));
    let (hslot, hfree, uids, uslots, idt) = (k.p::<i32>(B_HSLOT), k.p::<i32>(B_HFREE), k.p::<i32>(B_UIDS), k.p::<i32>(B_USLOTS), k.p::<i32>(B_IDT));
    let (obits, omask, orec) = (k.p::<u32>(B_OBITS), k.p::<i8>(B_OMASK), k.p::<i32>(B_OREC));
    let (rmaxe, hot, tys, rwch, brad, sver) = (k.p::<f32>(B_RMAXE), k.p::<f32>(B_HOT), k.p::<i32>(B_TYS), k.p::<i32>(B_RWCH), k.p::<i32>(B_BRAD), k.p::<i32>(B_SVER));
    let (wfree, wtab, wdefs, wver, wkind) = (k.p::<i32>(B_WFREE), k.p::<i32>(B_WTAB), k.p::<f64>(B_WDEFS), k.p::<i32>(B_WVER), k.p::<i32>(B_WKIND));
    let (out, shift, list, dirty, sepkey, mvtd) = (k.p::<i32>(B_OUT), k.p::<i32>(B_SHIFT), k.p::<i32>(B_LIST), k.p::<i32>(B_DIRTY), k.p::<u32>(B_SEPKEY), k.p::<u8>(B_MVTD));
    let (n, gw, gh, tile) = (k.i(0).max(0) as usize, k.i(1).max(1), k.i(2).max(1), k.f(3));
    let books = Books::from(&k, B_BOOKS, k.i(4));
    let (smin, ssh, ktiles, kw, kh) = (k.i(5), k.i(6), k.i(7).max(1), k.i(8).max(1), k.i(9).max(1));
    let id0 = k.i(10);
    let (mut hfn, mut hnx) = (k.i(11), k.i(12));
    let (ow_, oh_, ostride, ocell, oplanes) = (k.i(13), k.i(14), k.i(15), k.i(16), k.i(17));
    let (mut wfn, mut wused, wcap) = (k.i(18), k.i(19), k.i(20));
    let (nt, l1, np) = (k.i(21).max(1), k.i(22).max(2), k.i(23).max(1));
    let mut counter = k.i(25);
    let (mask, u0, absent) = (k.i(26) as u32, k.i(27).max(0) as usize, k.i(28) as u32);
    let (wreg, wtypes, whealer, nsty, nut, nwc, bsteps) = (k.i(29).max(1), k.i(30).max(1), k.i(31), k.i(32).max(0), k.i(33).max(0), k.i(34).max(0) as usize, k.i(35).max(1));
    let (rw, rh) = ((gw + wreg - 1) / wreg, (gh + wreg - 1) / wreg);
    for i in 0..128 { s(out, i, 0); }
    let (mut nb, mut nbl, mut nsh, mut nd, mut moved) = (0usize, 0usize, 0usize, 0usize, 0i32);
    let mut wsum = 0i32;
    // (The blocked ones: in the list's second half.)
    let blocked = list.add(n.max(1) + 4);
    let put = |c: usize, q: usize, v: f64| bput(ix, zt, kind, c, q, v);
    let get = |c: usize, q: usize| bget(ix, zt, kind, c, q);
    let (rtab, evl, airw, cover, carea) = (k.p::<i32>(B_RALLY), k.p::<i32>(B_EVL), k.p::<u8>(B_AIRW), k.p::<i32>(B_COVER), k.p::<i32>(B_CAREA));
    let (fullvis, cmd_am, ncov) = (k.i(37) != 0, k.i(38), k.i(39).max(0));
    let mut nev = 0usize;
    // A spawner's rally point now (_refreshSpawnerRallyTarget): following a hostile unit while its owner sees it (then its
    // place, also its last seen), else locked where it was last seen; none: None.
    let rally_point = |c: usize, r: usize, o: i32| -> Option<(f64, f64)> {
        if rtab.is_null() { return None; }
        let col = |j: usize| waddr(g(rtab, c * RW_W + j) as u32);
        if col(0) == 0 { return None; }
        let (rxc, ryc, tidc, lxc, lyc, dtc) = (col(0) as *mut f64, col(1) as *mut f64, col(2) as *mut f64, col(3) as *mut f64, col(4) as *mut f64, col(5) as *mut u8);
        let tid = g(tidc, r);
        if tid == tid && !idt.is_null() {
            let id = tid as i32;
            let mut hq = (id as u32).wrapping_mul(2654435761u32) & mask;
            let mut sl = -1i32;
            loop { let v = g(idt, hq as usize); if v == -1 { break; } if v >= 0 && get(C_ID, v as usize) as i32 == id && get(C_HND, v as usize) > 0.0 { sl = v; break; } hq = (hq + 1) & mask; }
            if sl >= 0 && get(C_DEAD, sl as usize) == 0.0 && get(C_OWNER, sl as usize) as i32 != o {
                let (ux, uy) = (get(C_X, sl as usize) * 0.125, get(C_Y, sl as usize) * 0.125);
                let (tgx, tgy) = (floor(ux / tile) as i32, floor(uy / tile) as i32);
                let vis = fullvis || (tgx >= 0 && tgy >= 0 && tgx < gw && tgy < gh && o >= 0 && o < ncov && !cover.is_null() && !carea.is_null() && {
                    let a = g(carea, (tgy * gw + tgx) as usize);
                    let cv = waddr(g(cover, o as usize) as u32) as *const i32;
                    a >= 0 && !cv.is_null() && g(cv, a as usize) > 0 });
                if vis { s(rxc, r, ux); s(ryc, r, uy); s(lxc, r, ux); s(lyc, r, uy); s(dtc, r, 1); }
                else {
                    let (lx, ly) = (g(lxc, r), g(lyc, r));
                    let (lx, ly) = (if lx.is_finite() { lx } else { g(rxc, r) }, if ly.is_finite() { ly } else { g(ryc, r) });
                    if lx.is_finite() && ly.is_finite() { s(rxc, r, lx); s(ryc, r, ly); }
                    s(tidc, r, f64::NAN); s(dtc, r, 1);
                }
            }
        }
        let (x, y) = (g(rxc, r), g(ryc, r));
        if x.is_finite() && y.is_finite() { Some((x, y)) } else { None }
    };
    for i in 0..n {
        let t = g(sel, 1 + i);
        if t < 0 || t >= gw * gh { continue; }
        let tu = t as usize;
        // (Its class by the tile's tag, its row.)
        let tag = g(ctab, tu) as i32;
        let mut c = usize::MAX;
        for j in 0..16usize { if g(cls, j * SC_W + SC_N) > 0 && g(cls, j * SC_W + SC_TAG) == tag { c = j; break; } }
        if c == usize::MAX { continue; }
        let r = g(rrow, tu);
        if r < 0 { continue; }
        let r = r as usize;
        let (ow, en, uc, qon, qn, qlv) = (col::<i8>(cls, c, SC_OW), col::<f64>(cls, c, SC_EN), col::<u8>(cls, c, SC_UC), col::<u8>(cls, c, SC_QON), col::<i8>(cls, c, SC_QN), col::<f64>(cls, c, SC_QLV));
        let o = g(ow, r) as i32;
        let q = g(qn, r);
        let block = ((c as i32) << 24) | r as i32;
        // (_spawnBegin's checks: a queue, energy, built, its queue on.)
        let ok0 = q != -128 && q > 0 && g(en, r) > 0.0 && g(uc, r) != 2 && g(qon, r) != 1 && o >= 0 && o < np;
        let st = (g(brain, tu) & 65535) - 1;
        let uti = if st >= 0 && st < nsty { g(sty, st as usize) } else { -1 };
        if !ok0 || uti < 0 || uti >= nut { s(blocked, nbl, block); nbl += 1; continue; }
        let u = ut.add(uti as usize * UT_W);
        let ty = *u.add(UT_TY) as i32;
        let lvl = (js_max(1.0, floor(g(qlv, r))) as i32).min(l1 - 1).max(1);
        // The exit, the footprint's place there.
        let (ex, ey) = exit_tile(wall, gw, gh, t % gw, t / gw);
        let (x8, y8) = (js_round((ex as f64 * tile + 16.0) * 8.0) as i32, js_round((ey as f64 * tile + 16.0) * 8.0) as i32);
        let (orr, olay) = (*u.add(UT_OR) as i32, *u.add(UT_OL) as i32);
        let (fx, fy) = if obits.is_null() { (x8, y8) } else {
            match super::occ::occ_find(obits, omask, ow_, oh_, ostride, ocell, oplanes, x8, y8, orr, olay, 32) { Some(p) => p, None => { s(blocked, nbl, block); nbl += 1; continue; } }
        };
        // Its slot, by the place's block (sim_unit_state.js _simSlabKey).
        let (px, py) = (fx as f64 * 0.125, fy as f64 * 0.125);
        let key = { let kx = ((px / (tile * ktiles as f64)) as i32).min(kw - 1).max(0); let ky = ((py / (tile * ktiles as f64)) as i32).min(kh - 1).max(0); ky * kw + kx };
        let sl = slab_alloc(&books, key, smin, ssh);
        if sl < 0 { s(blocked, nbl, block); nbl += 1; continue; }
        let su = sl as usize;
        { let (wd, m) = ((sl >> 5) as usize, 1u32 << (sl & 31)); *used.add(wd) |= m; *ever.add(wd) |= m; }
        if !obits.is_null() { super::occ::occ_mark(obits, omask, orec, ow_, oh_, ostride, ocell, oplanes, su, fx, fy, orr, olay); }
        if fx != x8 || fy != y8 { moved += 1; }
        if (orr as usize) < 48 { s(out, O_RAD + orr as usize, g(out, O_RAD + orr as usize) + 1); }
        // Its handle and id.
        let hd = if hfn > 0 { hfn -= 1; s(out, 2, g(out, 2) + 1); g(hfree, hfn as usize) } else { hnx += 1; s(out, 3, g(out, 3) + 1); hnx - 1 };
        s(hslot, hd as usize, sl);
        let id = id0 + nb as i32;
        // The core (unit.js _SPB_CORE), then the stats from the rows.
        put(C_ID, su, id as f64); put(C_OWNER, su, o as f64); put(C_UPT, su, uti as f64);
        for (cc, v) in [(C_X, fx), (C_Y, fy), (C_PX, fx), (C_PY, fy), (C_X0, fx), (C_Y0, fy)] { put(cc, su, v as f64); }
        put(C_R, su, *u.add(UT_R)); put(C_CR, su, *u.add(UT_CR));
        put(C_TUS, su, -1.0); put(C_TUID, su, 0.0); put(C_TBT, su, -1.0); put(C_ACQB, su, 0.0); put(C_TGX, su, f64::NAN); put(C_TGY, su, f64::NAN);
        put(C_HND, su, hd as f64); put(C_DEAD, su, 0.0); put(C_DEAD0, su, 0.0); put(C_LIVE, su, 1.0); put(C_TMON, su, 1.0);
        put(C_SD0, su, 0.0); put(C_SR0, su, 0.0); put(C_SL0, su, 0.0);
        if !sepkey.is_null() { s(sepkey, su, absent); }
        let sk = g(stk, lvl as usize);
        put(C_ULV, su, lvl as f64); put(C_BLV, su, lvl as f64); put(C_ELV, su, lvl as f64); put(C_LAST, su, lvl as f64);
        put(C_STK, su, sk); put(C_ESTK, su, sk);
        let row = (o * nt + ty) * l1 + lvl;
        let ru = row as usize;
        let mx = if rmaxe.is_null() { 1.0 } else { (g(rmaxe, ru) as f64).max(1.0) };
        put(C_SROW, su, row as f64); put(C_BSROW, su, row as f64);
        put(C_MAXE, su, mx); put(C_JMAXE, su, mx); put(C_EN, su, mx);
        put(C_ESOK, su, *u.add(UT_ESOK)); put(C_ESRAD, su, if brad.is_null() { 0.0 } else { g(brad, ru) as f64 }); put(C_ESTY, su, ty as f64);
        put(C_ESVER, su, if sver.is_null() { 0.0 } else { g(sver, (o * 64 + ty) as usize) as f64 });
        put(C_JFLY, su, *u.add(UT_FLY));
        if !hot.is_null() {
            // (k_unit_stats_apply's movement columns from the row's hot values.)
            let h = ru * 16;
            let (dmg, rd, ra, rk) = (g(hot, h + 5), g(hot, h + 7) as i32, g(hot, h + 8) as i32, g(hot, h + 9) as i32);
            let tv = if tys.is_null() { 0 } else { g(tys, ty as usize) };
            let stl = tv & 255;
            put(C_ASTY, su, stl as f64);
            put(C_WCH, su, if stl == 5 && !rwch.is_null() { g(rwch, ru) as f64 } else { 0.0 });
            put(C_LANE, su, js_max(1.5, js_min(4.0, *u.add(UT_R) * 0.6)));
            put(C_RD, su, if rd >= 0 && rd < bsteps { rd as f64 } else { 255.0 });
            put(C_RA, su, if ra >= 0 && ra < 255 { ra as f64 } else { 255.0 });
            put(C_SHOOT, su, if dmg > 0.0 { 1.0 } else { 0.0 });
            put(C_RK, su, rk.max(0).min(255) as f64);
            put(C_LZ, su, (((tv >> 8) & 3) | 4) as f64);
        }
        // A worker: its record (fresh: the side columns' defaults), its kind, state and workerType.
        let wb = *u.add(UT_WB) as i32;
        if wb > 0 {
            let wi = if wfn > 0 { wfn -= 1; s(out, 4, g(out, 4) + 1); g(wfree, wfn as usize) } else { wused += 1; s(out, 5, g(out, 5) + 1); wused - 1 };
            if wi >= wcap { s(out, 10, 1); }
            let wu = wi as usize;
            for j in 0..nwc { super::nfs::spawn_put(wtab, wkind, j, wu, g(wdefs, j)); }
            put(C_WKIX, su, wi as f64); put(C_ISWK, su, 1.0);
            put(C_WKS, su, *u.add(UT_WKS)); put(C_WKR, su, -1.0); put(C_WKIDLE, su, 1.0);
            put(C_OCWT, su, *u.add(UT_WTID));
            // (hObj += the workerType's term: the slot's digest.)
            let e = g(ix, C_HOBJ);
            if e >= 0 { let p = waddr(g(zt, 3 * e as usize) as u32) as *mut i32; *p.add(su) = (*p.add(su)).wrapping_add(*u.add(UT_HOBJ) as i64 as i32); }
            // (wbType and wbTick: the side table's entries at wkind's words nwc and nwc + 1.)
            let (jt, jk) = (g(wkind, nwc) as usize, g(wkind, nwc + 1) as usize);
            super::nfs::spawn_put(wtab, wkind, jt, wu, wb as f64);
            super::nfs::spawn_put(wtab, wkind, jk, wu, -1.0);
            // (configureWorkerUnitFromType: carrying 0; a collector's task memory cleared: its target types null (P[36]).)
            let (jc, jp, jw, jm) = (g(wkind, nwc + 2), g(wkind, nwc + 3), g(wkind, nwc + 4), g(wkind, nwc + 5));
            if jc >= 0 { super::nfs::spawn_put(wtab, wkind, jc as usize, wu, 0.0); }
            if wb == 1 || wb == 2 { for j in [jp, jw, jm] { if j >= 0 { super::nfs::spawn_put(wtab, wkind, j as usize, wu, k.f(36)); } } }
        }
        if !mvtd.is_null() { s(mvtd, su, 1); }
        // The id table's row and the id hash (main.js unitAdded, UnitIdIndex._put).
        s(uids, u0 + nb, id); s(uslots, u0 + nb, sl);
        if !idt.is_null() {
            let mut hq = (id as u32).wrapping_mul(2654435761u32) & mask;
            while g(idt, hq as usize) != -1 { hq = (hq + 1) & mask; }
            s(idt, hq as usize, sl);
        }
        // Its rally: a barrack's unit to the point's open tile, attack-moving (navPathReach: its one navigation node, unit.nvPK); a
        // worker, its rally event for the worker pass (wai.rs rally: the work there, else a move there), its targetPos the point's tile.
        if let Some((rx, ry)) = rally_point(c, r, o) {
            let (rgx, rgy) = (floor(rx / tile) as i32, floor(ry / tile) as i32);
            if wb > 0 {
                let (cgx, cgy) = (rgx.max(0).min(gw - 1), rgy.max(0).min(gh - 1));
                put(C_TGX, su, cgx as f64 * tile + 16.0); put(C_TGY, su, cgy as f64 * tile + 16.0);
                if !evl.is_null() { s(evl, nev, sl * 8 + 6); nev += 1; }
            } else if rgx >= 0 && rgy >= 0 && rgx < gw && rgy < gh {
                let prof = if *u.add(UT_FLY) != 0.0 { 1 } else { 0 };
                let to = approach_open(if prof == 1 { airw } else { wall }, gw, gh, rgy * gw + rgx);
                if to >= 0 {
                    put(C_NVPK, su, ((prof * 16777216 + to) * 2) as f64);
                    put(C_PIDX, su, if to == ey * gw + ex { 1.0 } else { 0.0 });
                    put(C_CMD, su, cmd_am as f64);
                }
            }
        }
        s(list, nb, sl);
        nb += 1;
        s(out, O_POP + o as usize, g(out, O_POP + o as usize) + 1);
        // The spawner: its timer, its ready order, its queue's shift; its healers' work version, its tile dirty.
        s(col::<f64>(cls, c, SC_SPT), r, 0.0); s(tim, tu, 0.0);
        s(col::<i32>(cls, c, SC_RDY), r, NONE);
        s(shift, nsh, block); nsh += 1;
        if !wver.is_null() && whealer >= 0 {
            let (sx, sy) = (t % gw, t / gw);
            let vi = (o * wtypes + whealer) * (1 + rw * rh) + 1 + (sy / wreg).min(rh - 1) * rw + (sx / wreg).min(rw - 1);
            s(wver, vi as usize, g(wver, vi as usize).wrapping_add(1));
            wsum = wsum.wrapping_add((vi.wrapping_add(1) ^ 0x9e3779b9u32 as i32).wrapping_mul(2654435761u32 as i32));
        }
        if !dirty.is_null() { s(dirty, nd, t); nd += 1; }
    }
    // The blocked: their turn again behind those ready now, in order.
    for j in 0..nbl {
        let w = g(blocked, j);
        let (c, r) = ((w >> 24) as usize, (w & 0xFFFFFF) as usize);
        s(col::<i32>(cls, c, SC_RDY), r, counter); counter += 1;
    }
    s(out, 12, nev as i32);
    s(out, 0, nb as i32); s(out, 1, nbl as i32); s(out, 6, counter); s(out, 7, wsum); s(out, 8, nd as i32); s(out, 9, moved); s(out, 11, nsh as i32);
    let _ = (hnx, wused);
}
