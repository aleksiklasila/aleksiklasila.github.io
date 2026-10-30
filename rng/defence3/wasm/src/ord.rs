//! The order queue's per-unit work (main.js _queueGroupMoveOrder,
//! _runQueuedOrders): a move order's admission and each step's take, over the
//! unit columns. Each unit's latest queued order is its slot's ordSq (the
//! entry's seq, 0 none). Single job (chunk 0), on the simulation thread.
use super::*;
use super::k::K;

#[inline(always)]
unsafe fn g<T: Copy>(p: *const T, i: usize) -> T {
    *p.add(i)
}
#[inline(always)]
unsafe fn s<T>(p: *mut T, i: usize, v: T) {
    *p.add(i) = v;
}
/// main.js _orderIdH: a queued unit's share of its entry's sum.
#[inline(always)]
fn id_h(id: i32) -> i32 {
    let x = ((id ^ 0x5bd1e995u32 as i32) as u32).wrapping_mul(2654435761);
    (x ^ (x >> 15)) as i32
}

/// SIM_KERNEL_ORDER_ADMIT: a move order's ids (q.ids, ascending) made their
/// units' latest order. The ids are joined with the units in id order
/// (um.ids, ascending, um.slots their slots: main.js unitIdIndex): two
/// streams forward, the units' skipped four at a time (SIMD). A unit taken:
/// the player's, alive, not already this order's; an earlier queued order of
/// it (its ordSq) loses it (that entry's live count and sum, q.edl / q.eds,
/// by its seq in q.eseq, ascending). Its slot listed in q.out, in id order
/// (q.out2 unused); a unit outside the columns (slot -1) in q.loose (its
/// position in um.ids).
/// Arrays: q.ids, um.ids, um.slots, unit.owner, unit.dead, unit.isWk,
/// unit.ordSq, q.out, q.out2, q.loose, q.eseq, q.edl, q.eds, q.cnt.
/// P: [0] ids, [1] units, [2] player, [3] seq, [4] entries.
/// q.cnt: [kernel's, workers (both in q.out), loose, the taken ids' sum].
#[no_mangle]
pub unsafe extern "C" fn k_order_admit(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ids, uid, usl) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2));
    let (own, dead, iswk, sq) = (k.p::<i8>(3), k.p::<u8>(4), k.p::<u8>(5), k.p::<i32>(6));
    let (out, out2, loose, eseq, edl, eds, cnt) = (k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9), k.p::<i32>(10), k.p::<i32>(11), k.p::<i32>(12), k.p::<i32>(13));
    let (n, nu, player, seq, ne) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2), k.i(3), k.i(4).max(0) as usize);
    let (mut nn, mut nw, mut nl, mut sum) = (0usize, 0usize, 0usize, 0i32);
    let mut j = 0usize;
    // (The last entry looked up: an order's units mostly come from one earlier order.)
    let (mut last_seq, mut last_e) = (0i32, usize::MAX);
    for i in 0..n {
        let id = g(ids, i);
        // Skip the units with smaller ids, four at a time.
        while j + 4 <= nu {
            let m = i32x4_bitmask(i32x4_lt(v128_load(uid.add(j) as *const v128), i32x4_splat(id))) as u32;
            if m == 0xF { j += 4; continue; }
            j += m.trailing_ones() as usize;
            break;
        }
        while j < nu && g(uid, j) < id { j += 1; }
        if j >= nu { break; }
        if g(uid, j) != id { continue; }
        let q = g(usl, j);
        // (-2: a unit gone, its hole; -1: one outside the columns.)
        if q < -1 { continue; }
        if q < 0 { s(loose, nl, j as i32); nl += 1; continue; }
        let q = q as usize;
        if g(own, q) as i32 != player || g(dead, q) != 0 { continue; }
        let old = g(sq, q);
        if old == seq { continue; }
        if old > 0 {
            if old != last_seq {
                last_seq = old;
                // (Binary search: entries few, in cache.)
                let (mut lo, mut hi) = (0usize, ne);
                while lo < hi { let mid = (lo + hi) >> 1; if g(eseq, mid) < old { lo = mid + 1; } else { hi = mid; } }
                last_e = if lo < ne && g(eseq, lo) == old { lo } else { usize::MAX };
            }
            if last_e != usize::MAX {
                s(edl, last_e, g(edl, last_e) - 1);
                s(eds, last_e, g(eds, last_e).wrapping_sub(id_h(id)));
            }
        }
        s(sq, q, seq);
        sum = sum.wrapping_add(id_h(id));
        // (One list in id order, workers among the rest: a drain spreads them
        // over its steps, not all at its last.)
        s(out, nn + nw, q as i32);
        if g(iswk, q) != 0 { nw += 1; } else { nn += 1; }
    }
    s(cnt, 0, nn as i32); s(cnt, 1, nw as i32); s(cnt, 2, nl as i32); s(cnt, 3, sum);
}

/// SIM_KERNEL_ORDER_TAKE: an entry's next units to apply, from its slots in
/// the queue's ring (ord.ring, from P[0], P[1] of them): those still its
/// (ordSq its seq), at most P[2], their stamps cleared. The kernel's (no
/// worker, not held) to ord.slots (SIM_KERNEL_ORDER_MOVE's list), the rest
/// to q.out2.
/// Arrays: ord.ring, unit.ordSq, unit.isWk, unit.holdF, unit.id, ord.slots, q.out2, q.cnt.
/// P: [0] start, [1] slots, [2] need, [3] seq.
/// q.cnt: [slots passed, kernel's, others, the taken units' sum].
#[no_mangle]
pub unsafe extern "C" fn k_order_take(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ring, sq, iswk, holdf, uidc) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<u8>(2), k.p::<u8>(3), k.p::<i32>(4));
    let (out, out2, cnt) = (k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7));
    let (start, len, need, seq) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2).max(0) as usize, k.i(3));
    let (mut nn, mut nw, mut sum, mut i) = (0usize, 0usize, 0i32, 0usize);
    while i < len && nn + nw < need {
        let q = g(ring, start + i);
        i += 1;
        // (-1: its unit's slot gone in a compaction, main.js orderQueueRemapSlots.)
        if q < 0 { continue; }
        let q = q as usize;
        if g(sq, q) != seq { continue; }
        s(sq, q, 0);
        sum = sum.wrapping_add(id_h(g(uidc, q)));
        if g(iswk, q) == 0 && g(holdf, q) == 0 { s(out, nn, q as i32); nn += 1; } else { s(out2, nw, q as i32); nw += 1; }
    }
    s(cnt, 0, i as i32); s(cnt, 1, nn as i32); s(cnt, 2, nw as i32); s(cnt, 3, sum);
}

/// The wire form's character values (id_codec.js _UIDZ_ABC), -1 none.
#[inline(always)]
fn b64(c: u8) -> i32 {
    match c {
        b'A'..=b'Z' => (c - b'A') as i32,
        b'a'..=b'z' => (c - b'a') as i32 + 26,
        b'0'..=b'9' => (c - b'0') as i32 + 52,
        b'-' => 62,
        b'_' => 63,
        _ => -1,
    }
}
/// A varint of the wire form at *pos (5 bits a character, low first, bit 5:
/// more follow; at most 8): its value, -1 malformed.
#[inline(always)]
unsafe fn varint(b: *const u8, len: usize, pos: &mut usize) -> i64 {
    let (mut v, mut mul) = (0i64, 1i64);
    for _ in 0..8 {
        if *pos >= len { return -1; }
        let x = b64(g(b, *pos));
        *pos += 1;
        if x < 0 { return -1; }
        v += (x & 31) as i64 * mul;
        if x & 32 == 0 { return v; }
        mul *= 32;
    }
    -1
}

/// SIM_KERNEL_IDS_DECODE (id_codec.js actionIdsForEach): an order's ids (or a
/// rally's tile keys) from their wire form's bytes (q.bytes[0..P[0]]), at
/// most P[1]: to q.ids when P[2] (else only counted), sorted ascending when
/// P[3] and they are not. Malformed input ends the list where it breaks, as
/// the JavaScript's.
/// Arrays: q.bytes, q.ids, q.cnt. q.cnt: [4] ids, [5] 1 when ascending.
#[no_mangle]
pub unsafe extern "C" fn k_ids_decode(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (b, ids, cnt) = (k.p::<u8>(0) as *const u8, k.p::<i32>(1), k.p::<i32>(2));
    let (len, max, write, sort) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2) != 0, k.i(3) != 0);
    let (mut pos, mut prev, mut n, mut asc, mut last) = (0usize, 0i64, 0usize, true, -1i64);
    'all: while pos < len && n < max {
        let zf = varint(b, len, &mut pos);
        if zf < 0 { break; }
        let mut run = 0i64;
        if zf & 1 != 0 {
            let v = varint(b, len, &mut pos);
            if v < 0 { break; }
            run = v + 1;
        }
        let z = zf >> 1;
        let id = prev + if z & 1 == 0 { z / 2 } else { -(z + 1) / 2 };
        if !(0..=0x7fffffff).contains(&id) { break; }
        for r in 0..=run {
            if n >= max { break 'all; }
            let v = id + r;
            if v > 0x7fffffff { break 'all; }
            if v < last { asc = false; }
            last = v;
            if write { s(ids, n, v as i32); }
            n += 1;
        }
        prev = id + run;
    }
    if write && sort && !asc {
        core::slice::from_raw_parts_mut(ids, n).sort_unstable();
        asc = true;
    }
    s(cnt, 4, n as i32); s(cnt, 5, asc as i32);
}

/// Rally classes (data_state.js _ST_RALLY_CLASSES): a table's columns at
/// argument 5 + 7 * j: its owner (Int8), rallyX, rallyY, rallyTargetUnitId,
/// _rallyLastSeenX, _rallyLastSeenY (Float64, NaN none), _pendingRallyDetach
/// (Uint8: 2 true, 1 false).
const RALLY_TABLES: usize = 7;
/// SIM_KERNEL_RALLY_TILES (main.js _rallySetTiles): a rally point for the
/// player's rally structures at the tile keys q.ids[0..P[0]]: per tile its
/// table (st.rtab: 1 + the rally class, 0 none) and row (st.rrow), the row's
/// rally fields written, its owner the player's (P[1]). The tiles written to
/// q.out (for the presentation), how many at q.cnt[6].
/// P: [0] keys, [1] player, [2] / [3] the point (NaN none), [4] the target
/// unit's id (NaN none), [5] tiles.
#[no_mangle]
pub unsafe extern "C" fn k_rally_tiles(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (keys, rtab, rrow, out, cnt) = (k.p::<i32>(0), k.p::<u8>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4));
    let (n, player, x, y, tid, tiles) = (k.i(0).max(0) as usize, k.i(1), k.f(2), k.f(3), k.f(4), k.i(5).max(0) as usize);
    let mut m = 0usize;
    for i in 0..n {
        let t = g(keys, i);
        if t < 0 || t as usize >= tiles { continue; }
        let j = g(rtab, t as usize) as usize;
        if j == 0 || j > RALLY_TABLES { continue; }
        let base = 5 + 7 * (j - 1);
        let ow = k.p::<i8>(base);
        if ow.is_null() { continue; }
        let r = g(rrow, t as usize);
        if r < 0 { continue; }
        let r = r as usize;
        if g(ow, r) as i32 != player { continue; }
        s(k.p::<f64>(base + 1), r, x);
        s(k.p::<f64>(base + 2), r, y);
        s(k.p::<f64>(base + 3), r, tid);
        s(k.p::<f64>(base + 4), r, x);
        s(k.p::<f64>(base + 5), r, y);
        s(k.p::<u8>(base + 6), r, 1);
        s(out, m, t);
        m += 1;
    }
    s(cnt, 6, m as i32);
}

/// Navigation profiles (flownav.js NAV_PROFILES): ground, air, collectors,
/// builders and salvagers by owner.
const NAV_PROFILES: usize = 11;
/// A worker's navigation profile (flownav.js navProfileOf): its layer (air),
/// its worker record's type (unit.wbType: 1 collector, 2 astar collector, 3
/// salvager, 4 builder), its owner.
#[inline(always)]
fn worker_profile(layer: u8, wb: u8, owner: i32) -> usize {
    if layer == 1 { return 1; }
    match wb {
        1 | 2 => 2,
        3 | 4 => if (0..8).contains(&owner) { 3 + owner as usize } else { 0 },
        _ => 0,
    }
}
/// worker.js _workerResTerm: a reservation's share of its region's sum.
#[inline(always)]
fn res_term(slot: i32, id: i32) -> i32 {
    if id == 0 { return 0; }
    let h = ((slot.wrapping_add(1)) ^ (id.wrapping_add(0x3c6ef372)).wrapping_mul(2654435761u32 as i32)).wrapping_mul(2246822519u32 as i32);
    (h ^ ((h as u32) >> 13) as i32).wrapping_mul(3266489917u32 as i32)
}
/// worker.js _workerWorkMix.
#[inline(always)]
fn work_mix(i: i32) -> i32 {
    (i.wrapping_add(1) ^ 0x9e3779b9u32 as i32).wrapping_mul(2654435761u32 as i32)
}

/// SIM_KERNEL_ORDER_WORKERS (main.js _orderWorkers): the workers of a move
/// order (the take kernel's others, q.out2[0..P[1]]) let go of their tasks
/// and follow the order's flow, as _ordClearFast, _ordWorkerManual and
/// _issueFlowOrder did in JavaScript. P[0] 0: each profile's eligible
/// workers counted (cnt[8 + p]) and its first (cnt[20 + p]); 1: applied.
/// Eligible: the player's, alive, a worker, not held, indexed this epoch,
/// not a shooter; the others listed for the JavaScript (out, cnt[0]), as
/// are those of a profile without a destination (ow.pd valid 0). Units with
/// a pending way listed too (fix, cnt[1]): their references the
/// JavaScript's. The work versions' checksum change at cnt[2]; cnt[3] 1
/// when the work site grid's dirty list was full.
/// Per profile p, ow.pd[6p..]: destination tile, wide, flow, its
/// generation, ready, valid. Releases: the work version of the target's
/// region (a unit target's from its slot, um.ids / um.slots), the
/// reservation it holds (wk.resv; its region's count and sum when kept,
/// the work site grid's list); its state MANUAL_MOVE (13), target and type
/// null, its type's material false, reservation -1, next search now, idle
/// failure -1, its role memory's clear pending (rmClr: the tick + 1). The
/// route: rkF, rtEnd, nvProf, navRdy, the path index 0 and its window back
/// (unit.mvFree), nvPK (-1 at the destination), rsEnd, mvNavLD -1, flow armed
/// (unit.js simFlowArm: a worker the player sent, mvWk 2).
#[no_mangle]
pub unsafe extern "C" fn k_order_workers(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (list, out, fix, cnt, pd) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4));
    let (own, dead, iswk, holdf, ep, xs, ys, layer, sepk, uid) = (k.p::<i8>(5), k.p::<u8>(6), k.p::<u8>(7), k.p::<u8>(8), k.p::<i32>(9),
        k.p::<i32>(10), k.p::<i32>(11), k.p::<u8>(12), k.p::<u32>(13), k.p::<i32>(14));
    let (tus, tuid, tbt, acqb, fatf, lsx, lsy, cmdc, on, amgx, amgy, tgx, tgy) = (k.p::<i32>(15), k.p::<i32>(16), k.p::<i32>(17), k.p::<u8>(18),
        k.p::<u8>(19), k.p::<f32>(20), k.p::<f32>(21), k.p::<u8>(22), k.p::<u8>(23), k.p::<i16>(24), k.p::<i16>(25), k.p::<f32>(26), k.p::<f32>(27));
    let (agw, mvpp, mvpf) = (k.p::<i32>(28), k.p::<u8>(29), k.p::<u8>(30));
    let (wks, wkt, wkr, wkn, idlefv, rmclr, wkidle, wskind, wkix, wbtype) = (k.p::<u32>(31), k.p::<i32>(32), k.p::<i32>(33), k.p::<i32>(34),
        k.p::<i32>(35), k.p::<i32>(36), k.p::<u8>(37), k.p::<u8>(38), k.p::<i32>(39), k.p::<u8>(40));
    let (rkf, rte, nvp, navrdy, pidx, nvpk, mpath, mfree, mcd, rsend, nld) = (k.p::<u8>(41), k.p::<i32>(42), k.p::<i8>(43), k.p::<i32>(44),
        k.p::<i32>(45), k.p::<i32>(46), k.p::<i32>(47), k.p::<i32>(48), k.p::<i32>(49), k.p::<i32>(50), k.p::<f32>(51));
    let (mflags, mreach, mflow, mfgen, mdest, mready, mnp, msteady, mwk, mspent, mshoot) = (k.p::<u8>(52), k.p::<u8>(53), k.p::<i32>(54),
        k.p::<i32>(55), k.p::<i32>(56), k.p::<i32>(57), k.p::<u8>(58), k.p::<i32>(59), k.p::<u8>(60), k.p::<u8>(61), k.p::<u8>(62));
    let (resv, rcount, rsum, wswl, wver, umids, umslots, ttab) = (k.p::<i32>(63), k.p::<i32>(64), k.p::<i32>(65), k.p::<i32>(66), k.p::<i32>(67),
        k.p::<i32>(68), k.p::<i32>(69), k.p::<i32>(70));
    let (mode, n, player, epoch, now) = (k.i(0), k.i(1).max(0) as usize, k.i(2), k.i(3), k.i(4));
    let (px, py, gw, tile) = (k.f(5) as f32, k.f(6) as f32, k.i(7), k.f(8));
    let (nt, srt, rcols) = (k.i(9).max(1), k.i(10).max(1), k.i(11));
    let (vtypes, vrw, vrh, vnp, wrt, umn, cmd_move, absent, nres, nver) = (k.i(12), k.i(13), k.i(14), k.i(15), k.i(16).max(1), k.i(17).max(0) as usize,
        k.i(18) as u8, k.f(19) as u32, k.i(20).max(0), k.i(21).max(0));
    let itile = 1.0 / (tile * 8.0);
    let tile_of = |q: usize| floor(g(ys, q) as f64 * itile) as i32 * gw + floor(g(xs, q) as f64 * itile) as i32;
    let eligible = |q: usize| g(own, q) as i32 == player && g(dead, q) == 0 && g(iswk, q) != 0 && g(holdf, q) == 0 && g(ep, q) == epoch && g(mshoot, q) == 0;
    if mode == 0 {
        for p in 0..NAV_PROFILES { s(cnt, 8 + p, 0); s(cnt, 20 + p, -1); }
        for i in 0..n {
            let q = g(list, i);
            if q < 0 { continue; }
            let q = q as usize;
            if !eligible(q) { continue; }
            let p = worker_profile(g(layer, q), g(wbtype, g(wkix, q).max(0) as usize), g(own, q) as i32);
            s(cnt, 8 + p, g(cnt, 8 + p) + 1);
            if g(cnt, 20 + p) < 0 { s(cnt, 20 + p, q as i32); }
        }
        return;
    }
    let (mut no, mut nf, mut vsum, mut full) = (0usize, 0usize, 0i32, 0i32);
    for i in 0..n {
        let qv = g(list, i);
        if qv < 0 { continue; }
        let q = qv as usize;
        if !eligible(q) { s(out, no, qv); no += 1; continue; }
        let owner = g(own, q) as i32;
        let wb = g(wbtype, g(wkix, q).max(0) as usize);
        let p = worker_profile(g(layer, q), wb, owner);
        let pb = 6 * p;
        if g(pd, pb + 5) == 0 { s(out, no, qv); no += 1; continue; }
        let (dest, wide, fid, gen, ready) = (g(pd, pb), g(pd, pb + 1) != 0, g(pd, pb + 2), g(pd, pb + 3), g(pd, pb + 4));
        let id = g(uid, q);
        // The order's fields (_ordClearFast).
        s(tus, q, -1); s(tuid, q, 0); s(tbt, q, -1); s(acqb, q, 0); s(fatf, q, 0);
        s(lsx, q, f32::NAN); s(lsy, q, f32::NAN);
        if g(cmdc, q) != cmd_move { s(on, q, 0); s(cmdc, q, cmd_move); }
        s(amgx, q, -1); s(amgy, q, -1); s(tgx, q, px); s(tgy, q, py);
        s(agw, q, 0);
        if g(mvpp, q) != 0 { s(fix, nf, qv); nf += 1; }
        s(mvpf, q, 0);
        // Its task let go (_clearWorkerTarget, clearWorkerTaskMemoryForFreeRetarget).
        let w = g(wks, q);
        let kind = (w >> 10) & 7;
        let tt = g(ttab, wb as usize);
        let (li, wi) = (tt & 255, (tt >> 8) & 255);
        if kind >= 2 && wb != 0 {
            let mut tl = -1i32;
            if kind == 5 {
                // (A unit target: its slot by its id, the units' sorted ids.)
                let want = g(wkt, q);
                let (mut lo, mut hi) = (0usize, umn);
                while lo < hi { let mid = (lo + hi) >> 1; if g(umids, mid) < want { lo = mid + 1; } else { hi = mid; } }
                if lo < umn && g(umids, lo) == want {
                    let ts = g(umslots, lo);
                    if ts >= 0 && g(dead, ts as usize) == 0 { tl = tile_of(ts as usize); }
                }
            } else {
                tl = g(wkt, q);
            }
            if tl >= 0 && owner >= 0 && owner < vnp && wi < vtypes {
                let (gx, gy) = (irem(tl, gw), idiv(tl, gw));
                let vi = (owner * vtypes + wi) * (1 + vrw * vrh) + 1 + (gy / wrt).min(vrh - 1) * vrw + (gx / wrt).min(vrw - 1);
                if vi >= 0 && vi < nver {
                    s(wver, vi as usize, g(wver, vi as usize).wrapping_add(1));
                    vsum = vsum.wrapping_add(work_mix(vi));
                }
            }
        }
        let r = g(wkr, q);
        if r >= 0 && r < nres && g(resv, r as usize) == id {
            s(resv, r as usize, 0);
            if !rcount.is_null() {
                let t = r / nt;
                let rg = (idiv(t, gw) / srt) * rcols + irem(t, gw) / srt;
                s(rcount, rg as usize, g(rcount, rg as usize) - 1);
                s(rsum, rg as usize, g(rsum, rg as usize).wrapping_sub(res_term(r, id)));
            }
            if !wswl.is_null() {
                let m = g(wswl, 0);
                if m + 1 < k.i(22) { s(wswl, (m + 1) as usize, r); s(wswl, 0, m + 1); } else { full = 1; }
            }
        }
        let _ = li;
        // State MANUAL_MOVE, target and type null, its material false.
        let mut nw = (w & !((31 | (31 << 5) | (7 << 10)) as u32)) | 13 | (1 << 5) | (1 << 10);
        let mb = match wb { 4 => 13, 5 => 15, 6 => 17, _ => 0 };
        if mb != 0 { nw = (nw & !(3u32 << mb)) | (1u32 << mb); }
        if (w & 31) != 13 { s(on, q, 0); s(wskind, q, 0); s(wkidle, q, 0); }
        s(wks, q, nw);
        s(wkt, q, 0);
        s(wkr, q, -1);
        if g(wkn, q) != now { s(on, q, 0); s(wkn, q, now); }
        s(idlefv, q, -1);
        s(rmclr, q, now + 1);
        // Its route (_issueFlowOrder): the destination's flow.
        let tl = tile_of(q);
        let at = tl == dest;
        s(rkf, q, 1); s(rte, q, dest); s(nvp, q, p as i8); s(navrdy, q, ready);
        if g(pidx, q) != 0 { s(on, q, 0); s(pidx, q, 0); }
        s(nvpk, q, if at { -1 } else { ((p as i32) * 16777216 + dest) * 2 + wide as i32 });
        let h = g(mpath, q);
        if h >= 0 { let m = g(mfree, 0); s(mfree, (m + 1) as usize, h); s(mfree, 0, m + 1); s(mpath, q, -1); }
        s(on, q, 0); s(mcd, q, -1);
        s(rsend, q, if at { -1 } else { dest });
        s(nld, q, -1.0);
        if !at && fid >= 0 && g(sepk, q) != absent {
            s(mflags, q, 64 | if p == 1 { 32 } else { 0 } | 128);
            s(mreach, q, 0); s(mflow, q, fid); s(mfgen, q, gen); s(mdest, q, dest); s(mready, q, ready); s(mnp, q, p as u8);
            s(msteady, q, 0); s(mwk, q, 2); s(mspent, q, 0); s(on, q, 1);
        }
    }
    s(cnt, 0, no as i32); s(cnt, 1, nf as i32); s(cnt, 2, vsum); s(cnt, 3, full);
}

/// worker.js _wsGroupBuild: a collector group's sites and spawners from the
/// per-tile structure table (data_state.js _ST: code, owner, under
/// construction, value, the stationary descriptor), in tile order (the same
/// on every peer). P[0] 0: counted (cnt[0] sites, cnt[1] spawners); 1:
/// written. Sites: mines of code P[3] with a value > 0 (kind 1, no owner),
/// floor items (0x55) of type P[4] (descriptor low 16 bits, 0 none) with
/// energy > 0 (kind 2, their owner, P[7] while under construction).
/// Spawners (0x44) of type P[5] with energy > 0: tile, owner (-9 none), id
/// (their tile), centre, P[7] while under construction. Centres of P[6]-px
/// tiles. Empty tiles skipped 16 at a time.
/// Arrays: st.code, st.own, st.uc, st.val, st.brain, cnt, sx, sy, st, so,
/// sready, tile, pgx, pgy, po, pid, px, py, pready. P: [0] mode, [1] tiles,
/// [2] width, [3] mine code, [4] / [5] farm / spawner type + 1, [6] tile px,
/// [7] not built, [8] no owner.
#[no_mangle]
pub unsafe extern "C" fn k_ws_group(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (code, own, uc, val, brain, cnt) = (k.p::<u8>(0), k.p::<i32>(1), k.p::<u8>(2), k.p::<f64>(3), k.p::<i32>(4), k.p::<i32>(5));
    let (sx, sy, st, so, sr, tl) = (k.p::<f32>(6), k.p::<f32>(7), k.p::<i32>(8), k.p::<i32>(9), k.p::<i32>(10), k.p::<i32>(11));
    let (pgx, pgy, po, pid, px, py, pr) = (k.p::<i32>(12), k.p::<i32>(13), k.p::<i32>(14), k.p::<i32>(15), k.p::<f32>(16), k.p::<f32>(17), k.p::<i32>(18));
    let (mode, n, w, mine, farm, spt, tile, nb, none) = (k.i(0), k.i(1).max(0) as usize, k.i(2).max(1), k.i(3) as u8, k.i(4), k.i(5), k.f(6) as f32, k.i(7), k.i(8));
    let write = mode == 1;
    let (mut ns, mut np) = (0usize, 0usize);
    // (The candidate tiles, ascending (k_ws_candidates), when given: the same
    // sites in the same order as the whole map's.)
    let (cand, ncand) = (k.p::<i32>(19), k.i(9).max(0) as usize);
    let listed = !cand.is_null() && k.i(9) >= 0;
    let (mut t, mut ci) = (0usize, 0usize);
    loop {
        if listed { if ci >= ncand { break; } t = g(cand, ci) as usize; ci += 1; if t >= n { continue; } }
        else { if t >= n { break; } if t + 16 <= n && !v128_any_true(v128_load(code.add(t) as *const v128)) { t += 16; continue; } }
        let c = g(code, t);
        if c != 0 {
            let v = g(val, t);
            let ty = g(brain, t) & 0xffff;
            let (gx, gy) = ((t as i32) % w, (t as i32) / w);
            let (cx, cy) = (gx as f32 * tile + tile * 0.5, gy as f32 * tile + tile * 0.5);
            if c == mine && v > 0.0 {
                if write { s(sx, ns, cx); s(sy, ns, cy); s(st, ns, 1); s(so, ns, -1); s(sr, ns, 0); s(tl, ns, t as i32); }
                ns += 1;
            } else if c == 0x55 && farm != 0 && ty == farm && v > 0.0 {
                if write {
                    let o = g(own, t);
                    s(sx, ns, cx); s(sy, ns, cy); s(st, ns, 2); s(so, ns, if o == none { -1 } else { o }); s(sr, ns, if g(uc, t) != 0 { nb } else { 0 }); s(tl, ns, t as i32);
                }
                ns += 1;
            } else if c == 0x44 && spt != 0 && ty == spt && v > 0.0 {
                if write {
                    let o = g(own, t);
                    s(pgx, np, gx); s(pgy, np, gy); s(po, np, if o == none { -9 } else { o }); s(pid, np, t as i32); s(px, np, cx); s(py, np, cy);
                    s(pr, np, if g(uc, t) != 0 { nb } else { 0 });
                }
                np += 1;
            }
        }
        if !listed { t += 1; }
    }
    s(cnt, 0, ns as i32); s(cnt, 1, np as i32);
}

/// SIM_KERNEL (direct) k_struct_status (renderer.js tickStatusEffects, for
/// the structures of one table): rows in the world (_stT >= 0) with a status
/// running or no energy: their unset fields made 0 (watchedByTeam -1, as
/// ensureStatusState), each timer down by P[1] base ticks (at most what it
/// has), burn and poison damage while they run, ice damage while frozen and
/// wet; a tick damage whose status ended 0; the energy lost into its owner's
/// shrine sum (shrine[owner] += floor(lost * P[2] + 0.5), Math.round: integers, any order);
/// watch ended: watchedByTeam -1, listed (wend); energy at 0 or less: 0,
/// listed (died). Counts: cnt[0] died, cnt[1] watch ended. Unset: Int32
/// i32::MIN, Float32 / Float64 NaN, Int8 -128.
/// Arrays: _stT, burning, burnTickDamage, poisoned, poisonTickDamage,
/// frozen, iceTickDamage, wet, sandy, watched, watchedByTeam, _en, _ow, cnt,
/// died, wend, shrine (f64 per owner, P[3] of them). P: [0] rows, [1] base
/// ticks, [2] fixed-point scale, [3] owners.
#[no_mangle]
pub unsafe extern "C" fn k_struct_status(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (stt, burn, btd, pois, ptd, froz, itd, wet, sandy, wat) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<f32>(2), k.p::<i32>(3), k.p::<f32>(4),
        k.p::<i32>(5), k.p::<f32>(6), k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9));
    let (wteam, en, ow, cnt, died, wend, shrine) = (k.p::<i8>(10), k.p::<f64>(11), k.p::<i8>(12), k.p::<i32>(13), k.p::<i32>(14), k.p::<i32>(15), k.p::<f64>(16));
    let (n, dk, scale, nown) = (k.i(0).max(0) as usize, k.i(1).max(1), k.f(2), k.i(3).max(0));
    let (mut nd, mut nw) = (0usize, 0usize);
    const UNSET: i32 = i32::MIN;
    let iz = |v: i32| if v == UNSET { 0 } else { v };
    let fz = |v: f32| if v != v { 0.0f32 } else { v };
    for r in 0..n {
        if g(stt, r) < 0 { continue; }
        let (b0, p0, f0, w0, s0, t0) = (g(burn, r), g(pois, r), g(froz, r), g(wet, r), g(sandy, r), g(wat, r));
        let e0 = g(en, r);
        if !(b0 > 0 || p0 > 0 || f0 > 0 || w0 > 0 || s0 > 0 || t0 > 0 || e0 <= 0.0) { continue; }
        let (mut b, mut p, mut f, mut w, mut sd, mut t) = (iz(b0), iz(p0), iz(f0), iz(w0), iz(s0), iz(t0));
        let (mut bd, mut pdm, mut id) = (fz(g(btd, r)), fz(g(ptd, r)), fz(g(itd, r)));
        let mut team = g(wteam, r);
        if team == -128 { team = -1; }
        let mut e = e0;
        let o = g(ow, r) as i32;
        let mut hurt = |e: &mut f64, d: f64| {
            *e -= d;
            if o >= 0 && o < nown {
                let lost = if *e < 0.0 { d + *e } else { d };
                if lost > 0.0 { s(shrine, o as usize, g(shrine, o as usize) + floor(lost * scale + 0.5)); }
            }
        };
        if b > 0 {
            let m = dk.min(b);
            b -= m;
            if bd > 0.0 { hurt(&mut e, if m > 1 { bd as f64 * m as f64 } else { bd as f64 }); }
        }
        if p > 0 {
            let m = dk.min(p);
            p -= m;
            if pdm > 0.0 { hurt(&mut e, if m > 1 { pdm as f64 * m as f64 } else { pdm as f64 }); }
        }
        if f > 0 && w > 0 && id > 0.0 {
            let m = dk.min(f).min(w);
            hurt(&mut e, if m > 1 { id as f64 * m as f64 } else { id as f64 });
        }
        if f > 0 { f -= dk.min(f); }
        if b <= 0 { bd = 0.0; }
        if p <= 0 { pdm = 0.0; }
        if f <= 0 { id = 0.0; }
        if w > 0 { w -= dk.min(w); }
        if sd > 0 { sd -= dk.min(sd); }
        if t > 0 {
            t -= dk.min(t);
            if t <= 0 { team = -1; s(wend, nw, r as i32); nw += 1; }
        }
        if e <= 0.0 { e = 0.0; s(died, nd, r as i32); nd += 1; }
        s(burn, r, b); s(pois, r, p); s(froz, r, f); s(wet, r, w); s(sandy, r, sd); s(wat, r, t);
        s(btd, r, bd); s(ptd, r, pdm); s(itd, r, id); s(wteam, r, team as i8);
        if e0 == e0 { s(en, r, e); }
    }
    s(cnt, 0, nd as i32); s(cnt, 1, nw as i32);
}

/// data_static.js secondsToTicks.
#[inline(always)]
pub(crate) fn sec_ticks(sec: f64, rate: f64) -> i32 { (floor(sec.max(0.0) * rate + 0.5) as i32).max(1) }

/// Statuses a hit gives (structures here; units: k.rs hit_one, the first five).
pub(crate) const FX_FIRE: u32 = 1;
pub(crate) const FX_WATER: u32 = 2;
pub(crate) const FX_ICE: u32 = 4;
pub(crate) const FX_POISON: u32 = 8;
pub(crate) const FX_SAND: u32 = 16;
pub(crate) const FX_WATCH: u32 = 32;

// The structure hit kernels' arrays: the common ones at 14..19, per class j
// (9) at CLS0 + CLSW j: _en, _stT, burning, burnTickDamage, poisoned,
// poisonTickDamage, frozen, iceTickDamage, wet, watched, watchedByTeam,
// sandy; _ow at OWN0 + j; the outputs at OUT0.
const CLS0: usize = 20;
const CLSW: usize = 12;
const OWN0: usize = 128;
const OUT0: usize = 140;

/// One hit on a structure (applyStatusEffect, then the damage): the statuses
/// fx (FX_*) it is not immune to, timers by max with dur [fire, water, ice,
/// poison, sand, watch], tick damage by max td [fire, ice, poison], a watch
/// for team; the damage (gate: only with one of fx applied); `look` the
/// hitter's slot for the looks list.
pub(crate) struct SHit {
    pub t: i32,
    pub dmg: f64,
    pub fx: u32,
    pub gate: bool,
    pub dur: [i32; 6],
    pub td: [f32; 3],
    pub team: i8,
    pub look: i32,
}
pub(crate) struct SCtx {
    stab: *mut u8, rrow: *mut i32, stval: *mut f64, brain: *mut i32, imm: *mut u8,
    dead_l: *mut i32, look_l: *mut i32, watch_l: *mut i32, shrine: *mut f64,
    nimm: i32, nown: i32, tiles: i32, looks: usize, scale: f64,
    nd: usize, nl: usize, nw: usize,
}
impl SCtx {
    pub(crate) unsafe fn new(k: &K) -> SCtx {
        SCtx { stab: k.p::<u8>(14), rrow: k.p::<i32>(15), stval: k.p::<f64>(16), brain: k.p::<i32>(17), imm: k.p::<u8>(18),
            dead_l: k.p::<i32>(OUT0), look_l: k.p::<i32>(OUT0 + 1), watch_l: k.p::<i32>(OUT0 + 2), shrine: k.p::<f64>(OUT0 + 3),
            looks: k.i(2).max(0) as usize, nown: k.i(3).max(0), tiles: k.i(7).max(0), nimm: k.i(8).max(0), scale: k.f(9), nd: 0, nl: 0, nw: 0 }
    }
    pub(crate) unsafe fn done(&self, k: &K) {
        let cnt = k.p::<i32>(19);
        s(cnt, 0, self.nd as i32); s(cnt, 1, self.nl as i32); s(cnt, 2, self.nw as i32);
    }
    /// (True: it hit a structure with energy at its tile.)
    pub(crate) unsafe fn hit(&mut self, k: &K, h: &SHit) -> bool {
        const UNSET: i32 = i32::MIN;
        let t = h.t;
        if t < 0 || t >= self.tiles { return false; }
        let tu = t as usize;
        let cls = g(self.stab, tu) as usize;
        if cls == 0 || cls > 9 { return false; }
        let b = CLS0 + CLSW * (cls - 1);
        let (en, stt) = (k.p::<f64>(b), k.p::<i32>(b + 1));
        let r = g(self.rrow, tu);
        if r < 0 { return false; }
        let r = r as usize;
        let before = g(en, r);
        if !(before > 0.0) || g(stt, r) != t { return false; }
        let ty = (g(self.brain, tu) & 0xffff) as usize;
        let im = if ty > 0 && (ty as i32) < self.nimm { g(self.imm, ty) as u32 } else { 0 };
        let fx = h.fx & !im;
        let iz = |p: *mut i32| { let v = g(p, r); if v == UNSET { 0 } else { v } };
        let fz = |p: *mut f32| { let v = g(p, r); if v != v { 0.0f32 } else { v } };
        let timer = |slot: usize, dur: i32| { let p = k.p::<i32>(b + slot); if !p.is_null() { s(p, r, iz(p).max(dur)); } };
        let tick = |slot: usize, d: f32| { let p = k.p::<f32>(b + slot); s(p, r, fz(p).max(d)); };
        if fx & FX_FIRE != 0 { timer(2, h.dur[0]); tick(3, h.td[0]); }
        if fx & FX_WATER != 0 { timer(8, h.dur[1]); }
        if fx & FX_ICE != 0 { timer(6, h.dur[2]); tick(7, h.td[1]); }
        if fx & FX_POISON != 0 { timer(4, h.dur[3]); tick(5, h.td[2]); }
        if fx & FX_SAND != 0 { timer(11, h.dur[4]); }
        if fx & FX_WATCH != 0 {
            let (wp, tp) = (k.p::<i32>(b + 9), k.p::<i8>(b + 10));
            let cur = iz(wp);
            s(wp, r, if cur > 0 && g(tp, r) == h.team { cur.max(h.dur[5]) } else { h.dur[5] });
            s(tp, r, h.team);
            s(self.watch_l, self.nw, t); self.nw += 1;
        }
        let mut e = before;
        if !h.gate || h.fx == 0 || fx != 0 { e -= h.dmg; }
        let amount = before - e;
        let o = g(k.p::<i8>(OWN0 + cls - 1), r) as i32;
        if o >= 0 && o < self.nown && amount > 0.0 {
            let lost = if e < 0.0 { amount + e } else { amount };
            if lost > 0.0 { s(self.shrine, o as usize, g(self.shrine, o as usize) + floor(lost * self.scale + 0.5)); }
        }
        s(en, r, e); s(self.stval, tu, e);
        if self.nl < self.looks {
            let l = self.nl;
            s(self.look_l, 3 * l, h.look); s(self.look_l, 3 * l + 1, t); s(self.look_l, 3 * l + 2, floor(amount * 1024.0 + 0.5) as i32);
            self.nl += 1;
        }
        if e <= 0.0 { s(self.dead_l, self.nd, t); self.nd += 1; }
        true
    }
}

/// k_struct_hits (unit.js _structHitsApply): the movement kernel's attacks
/// on structures (its chunk lists: counts HC[0..P[0]], attackers HA and
/// targets HT per chunk of P[1], a structure -(tile + 2)), in the order of
/// their attackers' ids, each on the structure standing at its tile
/// (st.stab: its class, 1 + the index in STRUCT_STATUS_CLASSES; st.rrow its
/// row; energy > 0, still at the tile; SCtx::hit): its style's status (as
/// applyStatusEffect with no source type: fire, water, ice, poison
/// durations from the attacker's level, their tick damage from the hit's;
/// none on a structure immune, st immune bits by its type id: FX_*), the
/// damage (not with an immune status style), a scout's watch (atkWatch
/// ticks, else 4 + its effective level seconds; its owner's), the energy
/// lost into the structure owner's shrine sum, energy and the tile table's
/// copy (st.val). Lists: destroyed tiles in hit order (cnt[0]), the first
/// P[2] hits' looks [slot, tile, damage * 1024] (cnt[1]), watched tiles
/// (cnt[2]).
#[no_mangle]
pub unsafe extern "C" fn k_struct_hits(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (hc, ha, ht, keys, uid, uown, natk, sty, hot, srow) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<u64>(3), k.p::<i32>(4),
        k.p::<i8>(5), k.p::<u8>(6), k.p::<u8>(7), k.p::<f32>(8), k.p::<i16>(9));
    let (ulvl, blvl, elvl, awatch) = (k.p::<i8>(10), k.p::<i8>(11), k.p::<i8>(12), k.p::<i32>(13));
    let (kc, ch, hw, rate, maxlvl) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(4).max(1) as usize, k.f(5), k.i(6).max(1));
    let mut c = SCtx::new(&k);
    // The hits, keyed by attacker id (ids are the same on every peer, slots are not).
    let mut m = 0usize;
    for ci in 0..kc {
        let n = g(hc, ci);
        if n <= 0 { continue; }
        for j in ci * ch..ci * ch + n as usize {
            if g(ht, j) > -2 || g(ha, j) < 0 { continue; }
            s(keys, m, ((g(uid, g(ha, j) as usize) as u32 as u64) << 25) | j as u64);
            m += 1;
        }
    }
    core::slice::from_raw_parts_mut(keys, m).sort_unstable();
    for i in 0..m {
        let j = (g(keys, i) & ((1u64 << 25) - 1)) as usize;
        let sl = g(ha, j);
        if sl < 0 { continue; }
        let sl = sl as usize;
        let row = g(srow, sl) as i32;
        if row < 0 { continue; }
        let shots = (g(natk, sl) as i32).max(1);
        let base = g(hot, row as usize * hw + 5) as f64;
        let dmg = if shots > 1 { base * shots as f64 } else { base };
        let lv = { let u = g(ulvl, sl) as i32; let bl = g(blvl, sl) as i32; (if u > 0 { u } else if bl > 0 { bl } else { 1 }).min(maxlvl).max(1) as f64 };
        let mut h = SHit { t: -g(ht, j) - 2, dmg, fx: 0, gate: true, dur: [0; 6], td: [0.0; 3], team: -1, look: sl as i32 };
        let tick = |d: f64, lo: f64| (if d > 0.0 { d } else { 0.5 }).max(lo) as f32;
        match g(sty, sl) {
            1 => { h.fx = FX_FIRE; h.dur[0] = sec_ticks(3.0 + lv * 0.5, rate); h.td[0] = tick((dmg * 0.04).max(0.0), 0.1); }
            2 => { h.fx = FX_WATER; h.dur[1] = sec_ticks(6.0 + lv, rate); }
            3 => { h.fx = FX_ICE; h.dur[2] = sec_ticks(3.0 + lv * 0.5, rate); h.td[1] = tick(dmg * 0.2, 0.2); }
            4 => { h.fx = FX_POISON; h.dur[3] = sec_ticks(5.0 + lv, rate); h.td[2] = tick(dmg * 0.04, 0.1); }
            5 => {
                let el = (g(elvl, sl) as i32).max(1) as f64;
                let aw = g(awatch, sl);
                h.fx = FX_WATCH; h.gate = false; h.team = g(uown, sl);
                h.dur[5] = if aw > 0 { aw } else { sec_ticks(4.0 + el, rate) };
            }
            _ => {}
        }
        c.hit(&k, &h);
    }
    c.done(&k);
}

/// k_proj_struct_hits (projectile.js projectilesAdvance): the step's shots
/// that hit a structure or their floor target (pj.sev, P[0] of them; their
/// tile pj.arg), in the order of their ids (pj.id), each as
/// Projectile.hitBuilding: its type's statuses (pj.ty, _towerAcqTypes: 1
/// fire 2 water 3 poison 4 ice 5 elements 6 sand_gun 7 watch_tower; level
/// pj.lvl; the duration and tick damage its owner's stats map, pj.sd /
/// pj.sp, 0 / NaN their defaults, as applyStatusEffect), the damage plus 2
/// a level for the elemental ones (elements: only with a status applied; a
/// watch tower's none), through SCtx::hit. Arrays 0..13: pj.sev, keys
/// (u64), pj.id, pj.dmg, pj.ty, pj.lvl, pj.own, pj.sd, pj.sp, pj.shots,
/// pj.arg; the rest as k_struct_hits. P: [0] shots, [2] looks, [3] owners,
/// [5] tick rate, [7] tiles, [8] immunity types, [9] fixed-point scale.
#[no_mangle]
pub unsafe extern "C" fn k_proj_struct_hits(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (sev, keys, pid, pdmg, pty, plvl, pown, psd, psp, pshots, parg) = (k.p::<i32>(0), k.p::<u64>(1), k.p::<i32>(2), k.p::<f64>(3), k.p::<u8>(4),
        k.p::<i32>(5), k.p::<i8>(6), k.p::<i32>(7), k.p::<f32>(8), k.p::<i32>(9), k.p::<i32>(10));
    let (n, rate) = (k.i(0).max(0) as usize, k.f(5));
    let mut c = SCtx::new(&k);
    for i in 0..n { let sl = g(sev, i); s(keys, i, ((g(pid, sl as usize) as u32 as u64) << 32) | sl as u32 as u64); }
    core::slice::from_raw_parts_mut(keys, n).sort_unstable();
    for i in 0..n {
        let sl = (g(keys, i) & 0xffff_ffff) as usize;
        let (dmg, ty, lvl, sd, sp) = (g(pdmg, sl), g(pty, sl), g(plvl, sl), g(psd, sl), g(psp, sl));
        let lv = lvl.max(1) as f64;
        let shots = g(pshots, sl);
        let dot = dmg / if shots > 1 { shots as f64 } else { 1.0 };
        let dur = |def: f64| if sd > 0 { sd } else { sec_ticks(def, rate) };
        let tick = |f: f64, lo: f64| if sp >= 0.0 { sp } else { (if dot * f > 0.0 { dot * f } else { 0.5 }).max(lo) as f32 };
        let elem = ty >= 1 && ty <= 6;
        let mut h = SHit { t: g(parg, sl), dmg: if elem { dmg + lvl as f64 * 2.0 } else { dmg }, fx: 0, gate: true, dur: [0; 6], td: [0.0; 3], team: g(pown, sl), look: sl as i32 };
        match ty {
            1 => { h.fx = FX_FIRE; h.dur[0] = dur(3.0 + lv * 0.5); h.td[0] = tick(0.05, 0.1); }
            2 => { h.fx = FX_WATER; h.dur[1] = dur(6.0 + lv); }
            3 => { h.fx = FX_POISON; h.dur[3] = dur(5.0 + lv); h.td[2] = tick(0.1, 0.1); }
            4 => { h.fx = FX_ICE; h.dur[2] = dur(3.0 + lv * 0.5); h.td[1] = tick(0.2, 0.2); }
            5 => {
                h.fx = FX_FIRE | FX_POISON | FX_WATER | FX_ICE | FX_SAND;
                let td = |lo: f64| (if dot * 0.2 > 0.0 { dot * 0.2 } else { 0.5 }).max(lo) as f32;
                h.dur = [sec_ticks(3.0 + lv * 0.5, rate), sec_ticks(6.0 + lv, rate), sec_ticks(3.0 + lv * 0.5, rate), sec_ticks(5.0 + lv, rate), sec_ticks(9.0, rate), 0];
                h.td = [td(0.1), td(0.2), td(0.1)];
            }
            6 => { h.fx = FX_SAND; h.dur[4] = dur(9.0); }
            7 => { h.fx = FX_WATCH; h.gate = false; h.dmg = 0.0; h.dur[5] = dur(4.0 + lv); }
            _ => {}
        }
        c.hit(&k, &h);
    }
    c.done(&k);
}

/// The structures' tiles worth a look, ascending (worker.js _wsCandidates):
/// the tiles of the rows of up to 8 structure tables (arrays 0..7, P[1 + j]
/// rows each; a row counts when st.rrow of its tile is the row) and of the
/// mines (array 8, P[9] of them), each once. Out: tiles (array 12), cnt[0]
/// how many. P: [0] tables, [10] tiles on the map. Arrays 9..11: st.rrow,
/// st.code, scratch (i32, room for all: the radix sort's).
#[no_mangle]
pub unsafe extern "C" fn k_ws_candidates(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (mines, rrow, code, out, cnt) = (k.p::<i32>(8), k.p::<i32>(9), k.p::<u8>(10), k.p::<i32>(12), k.p::<i32>(13));
    let (nt, nm, tiles) = (k.i(0).max(0).min(8) as usize, k.i(9).max(0) as usize, k.i(10).max(0));
    let mut n = 0usize;
    for j in 0..nt {
        let stt = k.p::<i32>(j);
        if stt.is_null() { continue; }
        for r in 0..k.i(1 + j).max(0) as usize {
            let t = g(stt, r);
            if t < 0 || t >= tiles || g(rrow, t as usize) != r as i32 || g(code, t as usize) == 0 { continue; }
            s(out, n, t); n += 1;
        }
    }
    if !mines.is_null() { for i in 0..nm { let t = g(mines, i); if t >= 0 && t < tiles { s(out, n, t); n += 1; } } }
    // (Ascending by an LSD radix sort, 8 bits a pass, over the scratch
    // keys (array 11, room for all): tiles below 2^24 take three passes.)
    let tmp = k.p::<i32>(11);
    let passes = if tiles <= 1 << 16 { 2 } else if tiles <= 1 << 24 { 3 } else { 4 };
    let (mut src, mut dst) = (out, tmp);
    for p in 0..passes {
        let sh = 8 * p as u32;
        let mut hist = [0usize; 257];
        for i in 0..n { hist[((g(src, i) as u32 >> sh) & 255) as usize + 1] += 1; }
        for b in 0..256 { hist[b + 1] += hist[b]; }
        for i in 0..n { let v = g(src, i); let b = ((v as u32 >> sh) & 255) as usize; s(dst, hist[b], v); hist[b] += 1; }
        core::mem::swap(&mut src, &mut dst);
    }
    if src != out { for i in 0..n { s(out, i, g(src, i)); } }
    let mut w = 0usize;
    for i in 0..n { if i == 0 || g(out, i) != g(out, i - 1) { s(out, w, g(out, i)); w += 1; } }
    s(cnt, 0, w as i32);
}

/// Spawners (code 0x44) by (type, owner), in tile order (worker.js
/// _spawnerIndex): from the candidate tiles (array 0, P[0] of them; tile
/// order), bucket ty * P[2] + owner + 1 (owner -1 .. P[2] - 2; no owner
/// skipped), its tiles at off[b] .. off[b + 1] of `tiles`. Arrays: cand,
/// st.code, st.own, st.brain, tiles, off. P: [0] candidates, [1] types,
/// [2] owner slots, [3] no owner.
#[no_mangle]
pub unsafe extern "C" fn k_spawner_index(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (cand, code, own, brain, tl, off) = (k.p::<i32>(0), k.p::<u8>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5));
    let (n, nty, no, none) = (k.i(0).max(0) as usize, k.i(1).max(0), k.i(2).max(1), k.i(3));
    let nb = (nty * no) as usize;
    for b in 0..=nb { s(off, b, 0); }
    let bucket = |t: usize| -> i32 {
        if g(code, t) != 0x44 { return -1; }
        let ty = (g(brain, t) & 0xffff) - 1; let o = g(own, t);
        if ty < 0 || ty >= nty || o == none || o < -1 || o >= no - 1 { -1 } else { ty * no + o + 1 }
    };
    for i in 0..n { let b = bucket(g(cand, i) as usize); if b >= 0 { s(off, b as usize + 1, g(off, b as usize + 1) + 1); } }
    for b in 0..nb { s(off, b + 1, g(off, b + 1) + g(off, b)); }
    // (Filled in candidate order, which is tile order: each bucket ascending.)
    let cur = off.add(nb + 1);
    for b in 0..nb { s(cur, b, g(off, b)); }
    for i in 0..n {
        let t = g(cand, i); let b = bucket(t as usize);
        if b < 0 { continue; }
        let at = g(cur, b as usize); s(tl, at as usize, t); s(cur, b as usize, at + 1);
    }
}

/// The nearest working spawner of a bucket (worker.js _findClosestSpawner):
/// least tile Manhattan distance from (P[1], P[2]), then row, then column,
/// with energy (st.val > 0) and built (st.uc 0). Arrays: tiles, off, st.val,
/// st.uc, out (its tile, -1 none). P: [0] bucket, [1] x, [2] y, [3] width.
#[no_mangle]
pub unsafe extern "C" fn k_spawner_nearest(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (tl, off, val, uc, out) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<f64>(2), k.p::<u8>(3), k.p::<i32>(4));
    let (b, ux, uy, w) = (k.i(0).max(0) as usize, k.i(1), k.i(2), k.i(3).max(1));
    let (mut best, mut bd) = (-1i32, i32::MAX);
    for i in g(off, b)..g(off, b + 1) {
        let t = g(tl, i as usize);
        let (sx, sy) = (t % w, t / w);
        let d = (sx - ux).abs() + (sy - uy).abs();
        // (Tile order: the first of a distance is the lowest row, column.)
        if d >= bd { continue; }
        if !(g(val, t as usize) > 0.0) || g(uc, t as usize) != 0 { continue; }
        best = t; bd = d;
    }
    s(out, 0, best);
}

/// SIM_KERNEL_UNIT_GONE (main.js _gameTickBody's retire pass): the units
/// removed this tick (list[0..P[0]]: their slots; ~slot for one removeUnitNow
/// took out already: only its upkeep bin, order stamp and movement state) let go of what they
/// hold, as removeUnitSpatial, _clearWorkerTarget, upkeepUnitGone and the
/// detach did in JavaScript. Nothing here depends on the list's order (counts
/// and sums). Per unit:
/// - out of its upkeep bin (upB, upk.h; when kept);
/// - its queued order's slot listed (olist, cnt[0]; the entry is the
///   JavaScript's);
/// - (not removed already) its spatial counts (indexed this epoch: chunk
///   sepKey, owner spOwner, type spType) out of the chunk, type block and 8x8
///   block totals (chunk.js _spatialCountAdd); its occupancy cells cleared
///   (occ.rs occ_release; per radius released, cnt[32 + r]); its visibility
///   registration that of a dead source (renderer.js _visCoverSyncUnit; when
///   the coverage is current, P[13]); out of the index (spTile -1, spArea -2,
///   spEpoch 0, sepKey absent, sepLayer 0); one less of its owner's
///   population (cnt[72 + owner]);
/// - a worker's task: its target region's work version bumped (the checksum
///   change at cnt[1]), its reservation let go (its region's count and sum
///   when kept, the work site grid's list; cnt[2] 1 when that was full);
/// - its path window back to the pool; statRow -1, disarmed, no output, not
///   live.
/// Arrays: list, cnt, olist, owner, id, x, y, spEpoch, sepKey, sepLayer,
/// spOwner, spType, spTile, spArea, mvOn, mvOut, live, statRow, vsGen, vsR,
/// vsP1, vsP2, vsA, occ.bits, occ.mask, occ.rec, ix.complex, spatial.types,
/// ix.bcount, upB, upk.h, ordSq, wkS, wkT, wkR, wkIx, wbType, ttab, wk.resv,
/// rcount, rsum, wsw list, work versions, um.ids, um.slots, mvPath, the path
/// pool's free stack, dead (a unit target dead: gone, no work version).
/// P: [0] n, [1] spatial epoch, [2] absent key, [3] players, [4] chunk
/// stride, [5] CHUNKS_W, [6] type blocks wide, [7] type block, [8] type block
/// stride, [9] unit types, [10] block columns, [11] block size, [12] block
/// counts, [13] coverage current, [14] its generation, [15..19] occupancy w,
/// h, stride, cell, planes (planes 0: none), [20] GRID_W, [21] TILE, [22]
/// load types, [23] region tiles, [24] region columns, [25] work types, [26]
/// / [27] work regions wide / high, [28] work players, [29] work region
/// tiles, [30] ids in um, [31] reservations, [32] work versions, [33] the
/// grid list's length, [34] upkeep bins.
#[no_mangle]
pub unsafe extern "C" fn k_unit_gone(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (list, cnt, olist, own, uid, xs, ys) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i8>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6));
    let (spep, sepk, sepl, spown, sptype, sptile, sparea) = (k.p::<i32>(7), k.p::<u32>(8), k.p::<u8>(9), k.p::<i8>(10), k.p::<i16>(11), k.p::<i32>(12), k.p::<i32>(13));
    let (on, mout, live, srow) = (k.p::<u8>(14), k.p::<u8>(15), k.p::<u8>(16), k.p::<i16>(17));
    let (vsgen, vsr, vsp1, vsp2, vsa) = (k.p::<i32>(18), k.p::<i8>(19), k.p::<i8>(20), k.p::<i8>(21), k.p::<i8>(22));
    let orec = k.p::<i32>(25);
    let (cplx, tcnt, bcnt, upb, upk, ordsq) = (k.p::<i32>(26), k.p::<i32>(27), k.p::<i32>(28), k.p::<i32>(29), k.p::<i32>(30), k.p::<i32>(31));
    let (wks, wkt, wkr, wkix, wbtype, ttab) = (k.p::<u32>(32), k.p::<i32>(33), k.p::<i32>(34), k.p::<i32>(35), k.p::<u8>(36), k.p::<i32>(37));
    let (resv, rcount, rsum, wswl, wver, umids, umslots) = (k.p::<i32>(38), k.p::<i32>(39), k.p::<i32>(40), k.p::<i32>(41), k.p::<i32>(42), k.p::<i32>(43), k.p::<i32>(44));
    let (mpath, mfree, dead) = (k.p::<i32>(45), k.p::<i32>(46), k.p::<u8>(47));
    let n = k.i(0).max(0) as usize;
    let (epoch, absent, np, cstride, cw, tbw, tb, tbstride, ntypes, bcols, bsize, nb) = (k.i(1), k.f(2) as u32, k.i(3), k.i(4), k.i(5).max(1),
        k.i(6), k.i(7).max(1), k.i(8), k.i(9), k.i(10), k.i(11).max(1), k.i(12));
    let (vis, vgen) = (k.i(13) != 0, k.i(14));
    let (ow, oh, ostride, ocell, oplanes) = (k.i(15), k.i(16), k.i(17), k.i(18), k.i(19));
    let (gw, tile, nt, srt, rcols) = (k.i(20).max(1), k.f(21), k.i(22).max(1), k.i(23).max(1), k.i(24));
    let (vtypes, vrw, vrh, vnp, wrt, umn, nres, nver, nwsl, nupk) = (k.i(25), k.i(26), k.i(27), k.i(28), k.i(29).max(1), k.i(30).max(0) as usize,
        k.i(31).max(0), k.i(32).max(0), k.i(33), k.i(34).max(0));
    let itile = 1.0 / (tile * 8.0);
    let tile_of = |q: usize| floor(g(ys, q) as f64 * itile) as i32 * gw + floor(g(xs, q) as f64 * itile) as i32;
    for r in 0..33 { s(cnt, 32 + r, 0); }
    for p in 0..64 { s(cnt, 72 + p, 0); }
    let (mut no, mut vsum, mut full) = (0usize, 0i32, 0i32);
    for i in 0..n {
        let v = g(list, i);
        let removed = v < 0;
        let q = (if removed { !v } else { v }) as usize;
        // Upkeep bin, queued order.
        let b = g(upb, q);
        if b >= 0 && !upk.is_null() && b < nupk { s(upk, b as usize, g(upk, b as usize) - 1); }
        s(upb, q, -1);
        if g(ordsq, q) > 0 { s(olist, no, q as i32); no += 1; }
        // The slot's movement state let go.
        let h = g(mpath, q);
        if h >= 0 && !mfree.is_null() { let m = g(mfree, 0); s(mfree, (m + 1) as usize, h); s(mfree, 0, m + 1); s(mpath, q, -1); }
        s(srow, q, -1); s(on, q, 0); s(mout, q, 0);
        if removed { s(live, q, 0); continue; }
        let owner = g(own, q) as i32;
        // The spatial index's counts and registrations.
        let key = g(sepk, q);
        if g(spep, q) == epoch && key != absent {
            let o = g(spown, q) as i32;
            if o >= 0 && o < np {
                let key = key as i32;
                let ci = (key * cstride + o) as usize;
                s(cplx, ci, g(cplx, ci) - 1);
                let (cx, cy) = (irem(key, cw), idiv(key, cw));
                let ty = g(sptype, q) as i32;
                if ty >= 0 {
                    let ti = (idiv(cy, tb) * tbw + idiv(cx, tb)) * tbstride + o * ntypes + ty;
                    s(tcnt, ti as usize, g(tcnt, ti as usize) - 1);
                }
                let bi = (idiv(cy, bsize) * bcols + idiv(cx, bsize)) * np + o;
                if bi >= 0 && bi < nb { s(bcnt, bi as usize, g(bcnt, bi as usize) - 1); }
            }
            if vis { s(vsgen, q, vgen); s(vsr, q, -1); s(vsp1, q, -1); s(vsp2, q, -1); s(vsa, q, 0); }
        }
        if oplanes > 0 && !orec.is_null() {
            let meta = g(orec, q * 4 + 2);
            if (meta >> 16) & 255 != 0 {
                let r = (meta & 255).min(32) as usize;
                super::occ::occ_release(k.raw(23), k.raw(24), k.raw(25), ow, oh, ostride, ocell, oplanes, q as i32);
                s(cnt, 32 + r, g(cnt, 32 + r) + 1);
            }
        }
        s(sptile, q, -1); s(sparea, q, -2); s(spep, q, 0); s(sepk, q, absent); s(sepl, q, 0);
        if owner >= 0 && owner < 64 { s(cnt, 72 + owner as usize, g(cnt, 72 + owner as usize) + 1); }
        // A worker's task let go.
        let wi = g(wkix, q);
        let wb = if wi > 0 { g(wbtype, wi as usize) } else { 0 };
        let w = g(wks, q);
        let kind = (w >> 10) & 7;
        if kind >= 2 && wb != 0 {
            let typ = (g(ttab, wb as usize) >> 8) & 255;
            let mut tl = -1i32;
            if kind == 5 {
                let want = g(wkt, q);
                let (mut lo, mut hi) = (0usize, umn);
                while lo < hi { let mid = (lo + hi) >> 1; if g(umids, mid) < want { lo = mid + 1; } else { hi = mid; } }
                if lo < umn && g(umids, lo) == want {
                    let ts = g(umslots, lo);
                    if ts >= 0 && g(dead, ts as usize) == 0 { tl = tile_of(ts as usize); }
                }
            } else {
                tl = g(wkt, q);
            }
            if tl >= 0 && owner >= 0 && owner < vnp && typ < vtypes {
                let (gx, gy) = (irem(tl, gw), idiv(tl, gw));
                let vi = (owner * vtypes + typ) * (1 + vrw * vrh) + 1 + idiv(gy, wrt).min(vrh - 1) * vrw + idiv(gx, wrt).min(vrw - 1);
                if vi >= 0 && vi < nver {
                    s(wver, vi as usize, g(wver, vi as usize).wrapping_add(1));
                    vsum = vsum.wrapping_add(work_mix(vi));
                }
            }
        }
        let r = g(wkr, q);
        let id = g(uid, q);
        if r >= 0 && r < nres && g(resv, r as usize) == id {
            s(resv, r as usize, 0);
            if !rcount.is_null() {
                let t = idiv(r, nt);
                let rg = idiv(idiv(t, gw), srt) * rcols + idiv(irem(t, gw), srt);
                s(rcount, rg as usize, g(rcount, rg as usize) - 1);
                s(rsum, rg as usize, g(rsum, rg as usize).wrapping_sub(res_term(r, id)));
            }
            if !wswl.is_null() {
                let m = g(wswl, 0);
                if m + 1 < nwsl { s(wswl, (m + 1) as usize, r); s(wswl, 0, m + 1); } else { full = 1; }
            }
        }
        s(live, q, 0);
    }
    s(cnt, 0, no as i32); s(cnt, 1, vsum); s(cnt, 2, full);
}

/// A row's maxEnergy override set / cleared, its table's count with it
/// (atomically: the apply kernel's jobs share the word).
#[inline(always)]
unsafe fn set_mxo(col: *mut f64, n: *mut i32, r: usize, v: f64) {
    let o = g(col, r);
    if !(o == o) { (*(n as *const core::sync::atomic::AtomicI32)).fetch_add(1, core::sync::atomic::Ordering::Relaxed); }
    s(col, r, v);
}
#[inline(always)]
unsafe fn clear_mxo(col: *mut f64, n: *mut i32, r: usize) {
    let o = g(col, r);
    if o == o { (*(n as *const core::sync::atomic::AtomicI32)).fetch_sub(1, core::sync::atomic::Ordering::Relaxed); s(col, r, f64::NAN); }
}

/// unit.js stackCountToLevel over a number of stacks (detFloorLog2 + 1,
/// clamped to 1..max).
#[inline(always)]
fn stack_level(x: f64, max: i32) -> i32 {
    let v = if x == x && x != 0.0 { x } else { 1.0 };
    let v = if v < 1.0 { 1.0 } else { floor(v) };
    let lg = if v == f64::INFINITY { 1024 } else { ((v.to_bits() >> 52) & 0x7ff) as i32 - 1023 };
    (lg + 1).min(max).max(1)
}


/// Per class (renderer.js STRUCT_STATUS_CLASSES, _ST.stab - 1) the adjacency
/// kernel's columns, as words in adj.ctab (ADJ_COLS a class): gx, gy (Int16),
/// stacks, manualStacks, effectiveStacks (Int32), level, effectiveLevel,
/// potentialEffectiveLevel (Int8), isStacking (flag), stackingWorkDone
/// (Float64), autoUpgradeEnabled, isUpgrading (flags), effectiveGroupSize
/// (Int32), effectiveAreaMult (Float64), autoStackEnabled (flag), _ow (Int8),
/// _en (Float64), _vsGen (Int32), _vsR (Int8), the stat entries' tokens
/// (Int32, three a row), upgrademaxEnergy, the maxEnergy override _mxOv, the
/// preComputedBase override's maxEnergy _ovMx (Float64, NaN none), the
/// preComputedEffective override's vision steps _ovVs (Int8, -128 none), the
/// table's count of maxEnergy overrides (an Int32 word), watched (Int32),
/// watchedByTeam (Int8; the visibility seed reads them). Flags: 0 unset, 1
/// false, 2 true; Int32 unset i32::MIN, Int8 -128, Float64 NaN.
const ADJ_CLASSES: usize = 9;

#[inline(always)]
fn job(chunk: i32, per: i32, n: i32) -> (usize, usize) {
    let a = (chunk.max(0) as i64 * per.max(0) as i64).min(n.max(0) as i64) as usize;
    let b = (a as i64 + per.max(0) as i64).min(n.max(0) as i64) as usize;
    (a, b)
}
const ADJ_COLS: usize = 27;

#[inline(always)]
pub(crate) unsafe fn col<T>(tab: *const i32, c: usize, j: usize) -> *mut T {
    waddr(*tab.add(c * ADJ_COLS + j) as u32) as *mut T
}

/// SIM_KERNEL_ADJ_APPLY (things_utils.js adjacencyLaneStep, at the flood's
/// commit; what _adjApplyMember did one member at a time in JavaScript): every
/// member of the flood's groups (adj.otile, its group adj.ogrp, the groups'
/// sizes adj.gsize and area multipliers adj.gmul), the job's share of them
/// (P[1] a job). A member still standing at its tile (its class and row by
/// _ST.stab / rrow, its row's tile; its signature now, adj_sig, still the
/// flood's, adj.sig) gets, in this one pass over its row: its
/// stacks, potential and effective level, upgrade (an upgrade begun: its
/// target's energy, adj.upm) and stacking state, group size and area
/// multiplier (P[2] passive: only the adjacency's own); with its stacks or
/// levels changed its stat entries' tokens cleared and its stationary
/// descriptor's effective level; with its levels, upgrade, group or area
/// changed its energy brought within its maximum (adj.mxe; an upgrading one's
/// its upgrade's). Tables by (owner, stationary type: the descriptor's low 16
/// bits - 1, level): adj.rml [owner row * P[5] + type] researched maximum
/// level, adj.mxe / adj.upm / adj.vst [(owner row * P[5] + type) * P[11] + level] the
/// maximum energy at a level, an upgrade's to it, vision steps (-2 unknown).
/// Events for the JavaScript (adj.ev: class, row, flags, member; per job from
/// job * P[1], adj.evn[job * 16] of them): 2 its effective level changed
/// (work sites, traps), 16 its vision registration to make again, 32 a laser
/// whose stats changed.
/// P: [0] members, [1] per job, [2] passive, [3] GRID_W, [4] MAX_THING_LEVEL,
/// [5] types, [6] owner rows (players + 1; row 0: no owner), [7] unused, [8]
/// vision coverage current, [9] its generation, [10] the laser's type (-1),
/// [11] levels + 1, [12] ST_OWNER_NONE. Arrays (argument 5 unused, 18 / 19:
/// st.code, st.own).
#[no_mangle]
pub unsafe extern "C" fn k_adj_apply(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ot, og, gsz, gml, sig) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<f64>(3), k.p::<i32>(4));
    let (scode, sown, snone) = (k.p::<u8>(18), k.p::<i32>(19), k.i(12));
    let (stab, rrow, stuc, brain, stval) = (k.p::<u8>(6), k.p::<i32>(7), k.p::<u8>(8), k.p::<i32>(9), k.p::<f64>(10));
    let (rml, smxe, svis, satk, ev, evn) = (k.p::<i32>(11), k.p::<f64>(12), k.p::<i32>(13), k.p::<i32>(14), k.p::<i32>(15), k.p::<i32>(16));
    let (tykey, rlv, bl) = (k.p::<i32>(20), k.p::<i32>(21), k.p::<i32>(22));
    let (ntypes, r1) = (k.i(13), k.i(14).max(1) as usize);
    let tab = k.p::<i32>(17) as *const i32;
    let (passive, gw, maxl, nt, np) = (k.i(2) != 0, k.i(3).max(1), k.i(4).max(1), k.i(5), k.i(6));
    let (vis, vgen, laser, l1) = (k.i(8) != 0, k.i(9), k.i(10), k.i(11).max(1) as usize);
    let per = k.i(1).max(1);
    let (i0, i1) = job(chunk, per, k.i(0));
    let evb = chunk.max(0) as usize * per as usize;
    let mut ne = 0usize;
    for i in i0..i1 {
        let t = g(ot, i);
        if t < 0 { continue; }
        let tu = t as usize;
        let c = g(stab, tu) as usize;
        if c == 0 || c > ADJ_CLASSES || adj_sig(scode, sown, stuc, brain, stab, rrow, tab, tu, snone) != g(sig, tu) { continue; }
        let c = c - 1;
        let row = g(rrow, tu);
        if row < 0 { continue; }
        let r = row as usize;
        let cgx = col::<i16>(tab, c, 0);
        if cgx.is_null() || g(cgx, r) as i32 != irem(t, gw) || g(col::<i16>(tab, c, 1), r) as i32 != idiv(t, gw) { continue; }
        let grp = g(og, i) as usize;
        let (gs, gm) = (g(gsz, grp), g(gml, grp));
        let owner = g(col::<i8>(tab, c, 15), r) as i32;
        let ty = (g(brain, tu) & 65535) - 1;
        // (Tables' owner rows: 0 none, 1 + the player; a type not known yet:
        // no stats, the maximum level researched.)
        let oi = if owner < 0 || owner + 1 >= np { 0 } else { owner + 1 };
        // (Its building key in the static stat tables, -1 none.)
        let kb = if ty >= 0 && ty < ntypes { g(tykey, ty as usize) } else { -1 };
        let typed = kb >= 0 && kb < nt;
        let (cst, cman, ceff) = (col::<i32>(tab, c, 2), col::<i32>(tab, c, 3), col::<i32>(tab, c, 4));
        let (clev, celev, cpot) = (col::<i8>(tab, c, 5), col::<i8>(tab, c, 6), col::<i8>(tab, c, 7));
        let (cstk, cswd, cauto, cupg) = (col::<u8>(tab, c, 8), col::<f64>(tab, c, 9), col::<u8>(tab, c, 10), col::<u8>(tab, c, 11));
        let (cgs, cgm, cast, cen) = (col::<i32>(tab, c, 12), col::<f64>(tab, c, 13), col::<u8>(tab, c, 14), col::<f64>(tab, c, 16));
        let (cvg, cvr, ctok, cum) = (col::<i32>(tab, c, 17), col::<i8>(tab, c, 18), col::<i32>(tab, c, 19), col::<f64>(tab, c, 20));
        let (cmxo, covmx, covvs, cmxn) = (col::<f64>(tab, c, 21), col::<f64>(tab, c, 22), col::<i8>(tab, c, 23), col::<i32>(tab, c, 24));
        let (prior_lev, prior_pot, prior_upg, prior_gs, prior_gm) = (g(celev, r), g(cpot, r), g(cupg, r), g(cgs, r), g(cgm, r));
        let (st0, man0, eff0) = (g(cst, r), g(cman, r), g(ceff, r));
        // Stacks (getThingStackedStacks, getThingManualStacks) and levels.
        let stacked = if st0 == i32::MIN || st0 < 1 { 1 } else { st0 };
        let manual = if man0 == i32::MIN { stacked } else { man0 };
        let mans = stacked.max(manual.max(1));
        let mul = gs as f64 * gm;
        let effs = stacked as f64 * mul;
        let pot_l = stack_level(stacked.max(mans) as f64 * mul, maxl);
        let eff_l = stack_level(effs, maxl);
        let mut upg = prior_upg == 2;
        let auto_up = g(cauto, r) != 1;
        if !passive {
            let cur = if prior_lev == -128 || prior_lev == 0 { 1 } else { prior_lev as i32 };
            if eff_l < cur.max(1) || !auto_up { upg = false; }
            s(cst, r, stacked); s(cman, r, mans);
        }
        // (Stacks past the Int32 range: its largest, "huge"; the levels are capped long before.)
        let effs32 = if effs >= 2147483647.0 { i32::MAX } else { effs as i32 };
        s(ceff, r, effs32);
        s(cpot, r, pot_l as i8);
        s(celev, r, eff_l as i8);
        let mut flags = 0i32;
        let eff_changed = prior_lev as i32 != eff_l;
        if eff_changed { flags |= 2; }
        if (!passive && (st0 != stacked || man0 != mans)) || eff0 != effs32 || prior_pot as i32 != pot_l || eff_changed {
            // (_sDerivedReconcile: the entries made again at their next read;
            // stationaryBrainChanged: the descriptor's effective level.)
            s(ctok, 3 * r, 0); s(ctok, 3 * r + 1, 0); s(ctok, 3 * r + 2, 0);
            let bw = g(brain, tu);
            s(brain, tu, (bw & !(63 << 26)) | (eff_l.min(63) << 26));
        }
        // getThingBaseLevel, getThingResearchedMaxLevel.
        let lv = g(clev, r);
        let st1 = g(cst, r);
        let base = if lv != -128 { (lv as i32).min(maxl).max(1) } else if st1 != i32::MIN { stack_level(if st1 == 0 { 1.0 } else { st1 as f64 }, maxl) } else { 1 };
        // (Per owner row and key: research levels of maxEnergy, visionRange,
        // attackRange; boost levels; researched maximum level.)
        let otx = if typed { (oi * nt + kb) as usize } else { 0 };
        let rmax = if typed { g(rml, otx) } else { maxl };
        let (rme, rvi, rat, blv) = if typed { (g(rlv, 4 * otx) as usize, g(rlv, 4 * otx + 1) as usize, g(rlv, 4 * otx + 2) as usize, g(bl, otx)) } else { (0, 0, 0, 0) };
        let mx_at = |lvl: i32| -> f64 { g(smxe, ((kb as usize * l1) + lvl.max(1).min(maxl) as usize) * r1 + rme) };
        let vis_at = |lvl: i32| -> i32 {
            let lv = (if blv > 0 { (lvl.max(1) + blv).min(maxl) } else { lvl.max(1).min(maxl) }) as usize;
            let b = (kb as usize * l1 + lv) * r1;
            g(svis, b + rvi).max(g(satk, b + rat))
        };
        let uc = g(stuc, tu) != 0;
        let mut energy = g(cen, r);
        let mut en_set = false;
        let mxe_base = if typed { mx_at(base) } else { f64::NAN };
        // (The maxEnergy getter: its override, else the derived value.)
        let mxo = g(cmxo, r);
        if !passive {
            if base < eff_l.min(rmax) && !uc && !upg && auto_up {
                // beginUpgradeProgress: its target's energy, its own within it.
                let mut tm = if typed { mx_at(base + 1) } else { 0.0 };
                if !(tm > 0.0) { tm = if mxo == mxo { mxo } else { mxe_base }; }
                let tm = if tm > 0.0 { floor(tm).max(1.0) } else { 1.0 };
                upg = true; s(cstk, r, 1); s(cum, r, tm);
                // (item.maxEnergy = the target's: the derived value now, no override.)
                clear_mxo(cmxo, cmxn, r);
                if !(energy == energy && energy.abs() != f64::INFINITY) || energy < 1.0 { energy = 1.0; }
                if energy > tm { energy = tm; }
                en_set = true;
            }
            s(cupg, r, if upg { 2 } else { 1 });
            if !uc && !upg {
                let stk = mans - stacked > 0 && g(cast, r) != 1 && stack_level((stacked + 1) as f64, maxl) <= rmax;
                s(cstk, r, if stk { 2 } else { 1 });
                if !stk { s(cswd, r, 0.0); }
            } else if upg {
                s(cstk, r, 1);
            }
        }
        s(cgs, r, gs);
        s(cgm, r, gm);
        let upg_now = g(cupg, r);
        if eff_changed || prior_pot as i32 != pot_l || prior_upg != upg_now || prior_gs != gs || !(prior_gm == gm) {
            // Tower.updateStats / the others': energy within the maximum.
            let um = g(cum, r);
            let upgrading = upg_now == 2 && um > 0.0;
            let derived = if upgrading { floor(um).max(1.0) } else { mxe_base };
            let finite = energy == energy && energy.abs() != f64::INFINITY;
            let mxo = g(cmxo, r);
            if c == 0 {
                // Tower.updateStats: maxEnergy set (an override where it differs from the derived value).
                let ovmx = g(covmx, r);
                // (No stat entry for it: its energy and maximum left as they are.)
                let newmax = if upgrading { derived } else if ovmx == ovmx { floor(ovmx).max(1.0) } else { mxe_base };
                if newmax == newmax {
                    if !(derived == derived) || newmax != derived { set_mxo(cmxo, cmxn, r, newmax); } else { clear_mxo(cmxo, cmxn, r); }
                    if upgrading { if !finite || energy < 1.0 { energy = 1.0; } if energy > newmax { energy = newmax; } }
                    else { let p = if finite { energy } else { newmax }; energy = floor(p).min(newmax).max(1.0); }
                    en_set = true;
                }
            } else {
                let maxe = if mxo == mxo { mxo } else { derived };
                if maxe == maxe {
                    let p = if finite { energy } else { maxe };
                    energy = p.min(maxe).max(1.0);
                    en_set = true;
                }
            }
            if vis {
                let ov = g(covvs, r) as i32;
                let steps = if uc || !(energy > 0.0) { -1 } else if ov != -128 { ov } else if typed { vis_at(eff_l) } else { -2 };
                let known = g(cvg, r) == vgen;
                if steps == -2 || (known && g(cvr, r) as i32 != steps) || (!known && steps >= 0) { flags |= 16; }
            }
            if ty == laser { flags |= 32; }
        }
        if en_set && !(energy == g(cen, r)) { s(cen, r, energy); s(stval, tu, energy); }
        if flags & (2 | 16 | 32) != 0 {
            let e = 4 * (evb + ne);
            s(ev, e, c as i32); s(ev, e + 1, row); s(ev, e + 2, flags); s(ev, e + 3, i as i32); ne += 1;
        }
    }
    s(evn, chunk.max(0) as usize * 16, ne as i32);
}

/// A tile's adjacency signature (things_utils.js _getAdjacencySignatureAt)
/// from the per-tile structure table: a tabled structure (st.stab), built,
/// operational (its effective level, else its level, not 0 or below), not a
/// mine, with an owner (st.own) and a known type: (type + 1) << 8 | owner
/// (the flood compares them and takes the owner from the low byte); -1 none.
#[inline(always)]
unsafe fn adj_sig(code: *const u8, own: *const i32, uc: *const u8, brain: *const i32, stab: *const u8, rrow: *const i32, tab: *const i32, t: usize, none: i32) -> i32 {
    let cd = g(code, t);
    if cd == 0 || cd >= 0x66 || g(uc, t) != 0 { return -1; }
    let c = g(stab, t) as usize;
    if c == 0 || c > ADJ_CLASSES { return -1; }
    let r = g(rrow, t);
    if r < 0 { return -1; }
    let el = g(col::<i8>(tab, c - 1, 6), r as usize);
    let lv = if el != -128 { el } else { g(col::<i8>(tab, c - 1, 5), r as usize) };
    if lv != -128 && lv <= 0 { return -1; }
    let o = g(own, t);
    if o < 0 || o > 254 || o == none { return -1; }
    let ty = g(brain, t) & 65535;
    if ty <= 0 { return -1; }
    (ty << 8) | o
}

/// SIM_KERNEL_ADJ_POST (things_utils.js _adjacencyLanePost, on the helpers,
/// P[1] 256-tile blocks a job): per block, every tile's signature into
/// adj.sig (adj_sig); the seeds (P[3] all: every tile with a structure;
/// else the dirty tiles, adj.dflag, their flags and adj.dblk counts cleared)
/// as offsets in the block (u8) at adj.seed8[block * 256..], adj.scnt[block]
/// of them; the operational cloud portals (a tower, st.stab 1, whose type is
/// a cloud: adj.tyf bit 0; its pair id + 1 in bits 8..) appended to adj.cls4
/// (tile, owner, pair id, alive: energy > 0; room P[6], adj.ccnt[0] their
/// count, cleared before; any order: the flood sorts them); adj.pflag[job * 16]
/// 1 when a seed holds a spawner or a cloud (paths change: adj.tyf bit 1 or
/// st.stab 4..9). Arrays: st.code, st.own, st.uc, st.brain, st.stab,
/// st.rrow, st.val, adj.ctab, adj.sig, adj.dflag, adj.dblk, adj.seed8,
/// adj.scnt, adj.tyf, adj.cls4, adj.ccnt, adj.pflag. P: [0] blocks, [1]
/// blocks a job, [2] tiles, [3] all, [4] ST_OWNER_NONE, [5] types, [6]
/// portal room.
#[no_mangle]
pub unsafe extern "C" fn k_adj_post(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (code, own, uc, brain, stab, rrow, val) = (k.p::<u8>(0), k.p::<i32>(1), k.p::<u8>(2), k.p::<i32>(3), k.p::<u8>(4), k.p::<i32>(5), k.p::<f64>(6));
    let tab = k.p::<i32>(7) as *const i32;
    let (sig, dflag, dblk, seed, scnt, tyf, cls4, ccnt, pflag) = (k.p::<i32>(8), k.p::<u8>(9), k.p::<i32>(10), k.p::<u8>(11), k.p::<i32>(12),
        k.p::<i32>(13), k.p::<i32>(14), k.p::<i32>(15), k.p::<i32>(16));
    let (n, all, none, nt, ccap) = (k.i(2).max(0) as usize, k.i(3) != 0, k.i(4), k.i(5), k.i(6));
    let (b0, b1) = job(chunk, k.i(1), k.i(0));
    let mut paths = 0;
    for b in b0..b1 {
        let (t0, t1) = (b * 256, ((b + 1) * 256).min(n));
        let (mut ns, mut nc) = (0usize, 0usize);
        let dirty_block = !all && !dblk.is_null() && g(dblk, b) > 0;
        for t in t0..t1 {
            let sg = adj_sig(code, own, uc, brain, stab, rrow, tab, t, none);
            s(sig, t, sg);
            let cd = g(code, t);
            let c = g(stab, t);
            let ty = (g(brain, t) & 65535) - 1;
            let tf = if ty >= 0 && ty < nt { g(tyf, ty as usize) } else { 0 };
            let is_seed = if all { cd != 0 } else if dirty_block && g(dflag, t) != 0 { s(dflag, t, 0); true } else { false };
            if is_seed {
                s(seed, b * 256 + ns, (t - b * 256) as u8); ns += 1;
                if (c >= 4 && c as usize <= ADJ_CLASSES) || (c == 1 && tf & 2 != 0) { paths = 1; }
            }
            if c == 1 && tf & 1 != 0 && sg >= 0 {
                // (Appended, any order: the flood sorts them by tile.)
                let at = (*(ccnt as *const core::sync::atomic::AtomicI32)).fetch_add(1, core::sync::atomic::Ordering::Relaxed);
                if at < ccap {
                    let e = 4 * at as usize;
                    s(cls4, e, t as i32); s(cls4, e + 1, g(own, t)); s(cls4, e + 2, (tf >> 8) - 1); s(cls4, e + 3, (g(val, t) > 0.0) as i32);
                }
                nc += 1;
            }
        }
        if dirty_block { s(dblk, b, 0); }
        s(scnt, b, ns as i32);
        let _ = nc;
    }
    s(pflag, chunk.max(0) as usize * 16, paths);
}
