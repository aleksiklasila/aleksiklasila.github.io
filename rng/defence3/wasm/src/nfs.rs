//! The destination fields' sweep (flownav.js navFieldsSweepStep): a share of
//! the units (by the units list's order, through the slot map) marks the
//! fields their route and path refer to; at a cycle's end the fields not
//! marked are dropped. A pool's fields by key are an open-addressing table
//! (flownav.js _navHt*: key, slot + 1 pairs, 0 empty; linear probing; a
//! power of two of pairs), the same hash as the JavaScript's.
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
#[inline(always)]
fn hash(key: i32, mask: u32) -> u32 {
    (key as u32).wrapping_mul(0x9E37_79B1) & mask
}
/// The slot of the field with key, -1 none. (n: the table's pairs.)
#[inline(always)]
unsafe fn slot_of(ht: *const i32, n: u32, key: i32) -> i32 {
    if ht.is_null() || n == 0 {
        return -1;
    }
    let mask = n - 1;
    let mut h = hash(key, mask);
    loop {
        let v = g(ht, (2 * h + 1) as usize);
        if v == 0 {
            return -1;
        }
        if g(ht, (2 * h) as usize) == key {
            return v - 1;
        }
        h = (h + 1) & mask;
    }
}
/// Key out of the table (backward shift, so lookups never stop early).
unsafe fn del(ht: *mut i32, n: u32, key: i32) {
    let mask = n - 1;
    let mut h = hash(key, mask);
    loop {
        if g(ht, (2 * h + 1) as usize) == 0 {
            return;
        }
        if g(ht, (2 * h) as usize) == key {
            break;
        }
        h = (h + 1) & mask;
    }
    s(ht, (2 * h + 1) as usize, 0);
    let mut j = h;
    loop {
        j = (j + 1) & mask;
        let v = g(ht, (2 * j + 1) as usize);
        if v == 0 {
            return;
        }
        let k = hash(g(ht, (2 * j) as usize), mask);
        // (Its home k cyclically outside (h, j]: it moves into the hole.)
        let keep = if j > h { k > h && k <= j } else { k > h || k <= j };
        if !keep {
            s(ht, (2 * h) as usize, g(ht, (2 * j) as usize));
            s(ht, (2 * h + 1) as usize, v);
            s(ht, (2 * j + 1) as usize, 0);
            h = j;
        }
    }
}

/// Marks. Arrays: [0] ix.slots, [1] unit.live, [2] unit.dead, [3]
/// unit.rtEnd, [4] unit.rkF, [5] unit.nvProf, [6] unit.nvPK, [7] the narrow
/// pool's table, [8] its marks, [9] the wide pool's table, [10] its marks.
/// P: [0] k, [1] step, [2] count, [3] units, [4] mark, [5] / [6] the tables'
/// pairs (narrow, wide).
#[no_mangle]
pub unsafe extern "C" fn k_nav_sweep_mark(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (sl, live, dead, re, rk, pr, pk) = (k.p::<i32>(0), k.p::<u8>(1), k.p::<u8>(2), k.p::<i32>(3), k.p::<u8>(4), k.p::<i8>(5), k.p::<i32>(6));
    let (htn, seenn, htw, seenw) = (k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9), k.p::<i32>(10));
    let (k0, step, count, n, mark) = (k.i(0).max(0) as usize, k.i(1).max(1) as usize, k.i(2).max(1) as usize, k.i(3).max(0) as usize, k.i(4));
    let (nn, nw) = (k.i(5).max(0) as u32, k.i(6).max(0) as u32);
    let mut base = k0;
    while base < n {
        let end = (base + count).min(n);
        for i in base..end {
            let q = g(sl, i);
            if q < 0 {
                continue;
            }
            let q = q as usize;
            if g(live, q) == 0 || g(dead, q) != 0 {
                continue;
            }
            let e = g(re, q);
            if e >= 0 && g(rk, q) == 1 {
                let f = slot_of(htw, nw, (g(pr, q) as i32).wrapping_mul(16_777_216).wrapping_add(e));
                if f >= 0 {
                    s(seenw, f as usize, mark);
                }
            }
            let p = g(pk, q);
            if p >= 0 {
                let (ht, nh, seen) = if p & 1 != 0 { (htw, nw, seenw) } else { (htn, nn, seenn) };
                let f = slot_of(ht, nh, p >> 1);
                if f >= 0 {
                    s(seen, f as usize, mark);
                }
            }
        }
        base += step;
    }
}

/// A cycle's end, one pool: every field (slot order) not marked since mark
/// out of the table, its meta freed (meta[0] -1, its generation meta[6] on),
/// listed in drop. Arrays: [0] table, [1] meta, [2] marks, [3] drop out,
/// [4] hdr out ([0] dropped). P: [0] slots, [1] pairs, [2] mark, [3] meta
/// words a slot.
#[no_mangle]
pub unsafe extern "C" fn k_nav_sweep_drop(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ht, meta, seen, drop, hdr) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4));
    let (cap, n, mark, mw) = (k.i(0).max(0) as usize, k.i(1).max(0) as u32, k.i(2), k.i(3).max(1) as usize);
    let mut nd = 0usize;
    for f in 0..cap {
        let m = f * mw;
        if g(meta, m) < 0 || g(seen, f) >= mark {
            continue;
        }
        del(ht, n, g(meta, m).wrapping_mul(16_777_216).wrapping_add(g(meta, m + 1)));
        s(meta, m, -1);
        s(meta, m + 6, g(meta, m + 6).wrapping_add(1));
        s(drop, nd, f as i32);
        nd += 1;
    }
    s(hdr, 0, nd as i32);
}

/// The visibility cover's commit (renderer.js _visCoverUnitsCommit): per
/// player its run's change, the areas no longer covered first (their count
/// down; at 0 not visible, their tiles dark in the player's visual rows),
/// then the newly covered (count up; at 1 visible, tiles lit).
/// Arrays: [0] udiff (per player: plus count, minus count), [1] uplus, [2]
/// uminus (A per player), [3] cover (i32, stride per player), [4] visible
/// (u8, stride), [5] per player its visual rows (f32 tiles; encoded
/// address, 0 none), [6] / [7] the areas' tiles (offsets, A + 1; tiles).
/// P: [0] areas, [1] players, [2] stride, [3] the lit value.
#[no_mangle]
pub unsafe extern "C" fn k_vis_commit(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (d, pl, mi, cover, vis, vtab, aoff, atil) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<u8>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7));
    let (na, np, st) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2).max(0) as usize);
    let lit = k.f(3) as f32;
    for p in 0..np {
        let base = p * na;
        let cb = p * st;
        let rows = { let v = g(vtab, p); if v == 0 { core::ptr::null_mut() } else { waddr(v as u32) as *mut f32 } };
        let paint = |ar: usize, v: f32| {
            if rows.is_null() || aoff.is_null() {
                return;
            }
            for i in g(aoff, ar)..g(aoff, ar + 1) {
                s(rows, g(atil, i as usize) as usize, v);
            }
        };
        for i in 0..g(d, 2 * p + 1).max(0) as usize {
            let ar = g(mi, base + i) as usize;
            let c = g(cover, cb + ar) - 1;
            s(cover, cb + ar, c);
            if c == 0 {
                s(vis, cb + ar, 0);
                paint(ar, 0.0);
            }
        }
        for i in 0..g(d, 2 * p).max(0) as usize {
            let ar = g(pl, base + i) as usize;
            let c = g(cover, cb + ar) + 1;
            s(cover, cb + ar, c);
            if c == 1 {
                s(vis, cb + ar, 1);
                paint(ar, lit);
            }
        }
    }
}

/// The movement kernel's charges (unit.js _simMoveChargeSteps): per chunk
/// that charged anything (its flag after the players' sums), its fixed
/// charges per player and usage per (player, type) added up, chunk by chunk
/// (the JavaScript's order: the same double sums). Arrays: [0] fix ((NP + 1)
/// a chunk), [1] use (NP * NT a chunk), [2] fix sums out (NP), [3] use sums
/// out (NP * NT), [4] hdr out ([0] any chunk charged). P: [0] chunks, [1]
/// NP, [2] NT.
#[no_mangle]
pub unsafe extern "C" fn k_charge_sum(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (fix, used, of, ou, hdr) = (k.p::<f64>(0), k.p::<f64>(1), k.p::<f64>(2), k.p::<f64>(3), k.p::<i32>(4));
    let (chunks, np, nt) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2).max(0) as usize);
    let w = np + 1;
    for i in 0..np {
        s(of, i, 0.0);
    }
    for i in 0..np * nt {
        s(ou, i, 0.0);
    }
    let mut any = 0;
    for c in 0..chunks {
        if g(fix, c * w + np) == 0.0 {
            continue;
        }
        any = 1;
        for p in 0..np {
            s(of, p, g(of, p) + g(fix, c * w + p));
        }
        let o = c * np * nt;
        for i in 0..np * nt {
            s(ou, i, g(ou, i) + g(used, o + i));
        }
    }
    s(hdr, 0, any);
}

/// Per-job shares summed per owner (unit.js statusPrepassRun: the shrines'
/// fixed-point shares, whole numbers in doubles: exact in any order).
/// Arrays: [0] shares (NO a job), [1] sums out (NO). P: [0] jobs, [1] NO.
#[no_mangle]
pub unsafe extern "C" fn k_owner_sum(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (sh, out) = (k.p::<f64>(0), k.p::<f64>(1));
    let (jobs, no) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize);
    for o in 0..no {
        s(out, o, 0.0);
    }
    for j in 0..jobs {
        for o in 0..no {
            let v = g(sh, j * no + o);
            if v != 0.0 {
                s(out, o, g(out, o) + v);
            }
        }
    }
}
