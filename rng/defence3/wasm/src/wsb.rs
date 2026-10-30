//! The worker search tier's group buckets (worker.js _wsGroupBuild): the
//! candidate sites and the spawners counted into buckets of WS_BUCKET tiles
//! and listed by bucket (counting sorts), the spawners' per-owner counts.
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
fn clampi(v: f64, hi: i32) -> i32 {
    // (As Math.max(0, Math.min(hi, Math.floor(v))).)
    let f = floor(v);
    if !(f < hi as f64) { hi } else if !(f > 0.0) { 0 } else { f as i32 }
}

/// k_ws_buckets. Arrays: sites [0] sx, [1] sy (world, f32), out [2] bs (a
/// bucket's first), [3] bc (its count), [4] bi (the sites by bucket); the
/// spawners in tile order [5] qgx, [6] qgy, [7] qo, [8] qid, [9] qx, [10] qy,
/// [11] qready; out in bucket order [12] pgx, [13] pgy, [14] po, [15] pid,
/// [16] px, [17] py, [18] pready, [19] qp (tile order -> bucket order), [20]
/// sbk (each spawner's bucket), [21] meta (5 + 2 b: a bucket's first, 6 + 2
/// b: its count, 5 + 2 nb + owner: the owner's count (16), 5 + 2 nb + 16 +
/// owner: -1; [0] sites, [1] spawners, [2] 1, [3] columns, [4] rows); [22] rk
/// (place in tile order -> bucket order), [23] ro (its inverse), [24] the
/// set's hashes (2: order-free, bucket order; _wsNearField's keys).
/// P: [0] sites, [1] spawners, [2] bucket columns, [3] rows, [4] TILE, [5]
/// WS_BUCKET.
#[no_mangle]
pub unsafe extern "C" fn k_ws_buckets(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (sx, sy, bs, bc, bi) = (k.p::<f32>(0), k.p::<f32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4));
    let (qgx, qgy, qo, qid, qx, qy, qr) = (k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8), k.p::<f32>(9), k.p::<f32>(10), k.p::<i32>(11));
    let (pgx, pgy, po, pid, px, py, pr, qp, sbk, meta) = (k.p::<i32>(12), k.p::<i32>(13), k.p::<i32>(14), k.p::<i32>(15), k.p::<f32>(16), k.p::<f32>(17), k.p::<i32>(18), k.p::<i32>(19), k.p::<i32>(20), k.p::<i32>(21));
    let (cap, np, bcols, brows) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2), k.i(3));
    let (tile, wsb) = (k.f(4), k.f(5));
    let nb = (bcols * brows).max(0) as usize;
    let bk = |i: usize| -> usize {
        let by = clampi(g(sy, i) as f64 / tile / wsb, brows - 1);
        let bx = clampi(g(sx, i) as f64 / tile / wsb, bcols - 1);
        (by * bcols + bx) as usize
    };
    for b in 0..nb {
        s(bc, b, 0);
    }
    for i in 0..cap {
        let b = bk(i);
        s(bc, b, g(bc, b) + 1);
    }
    let mut fill = 0;
    for b in 0..nb {
        s(bs, b, fill);
        fill += g(bc, b);
        s(bc, b, 0);
    }
    for i in 0..cap {
        let b = bk(i);
        let c = g(bc, b);
        s(bi, (g(bs, b) + c) as usize, i as i32);
        s(bc, b, c + 1);
    }
    // The spawners.
    let mlen = 5 + 2 * nb + 32;
    for i in 0..mlen {
        s(meta, i, 0);
    }
    for o in 0..16 {
        s(meta, 5 + 2 * nb + 16 + o, -1);
    }
    for q in 0..np {
        let by = clampi(idiv(g(qgy, q), wsb as i32) as f64, brows - 1);
        let bx = clampi(idiv(g(qgx, q), wsb as i32) as f64, bcols - 1);
        let b = (by * bcols + bx) as usize;
        s(sbk, q, b as i32);
        s(meta, 6 + 2 * b, g(meta, 6 + 2 * b) + 1);
        let o = g(qo, q);
        if o >= 0 && o < 16 {
            s(meta, 5 + 2 * nb + o as usize, g(meta, 5 + 2 * nb + o as usize) + 1);
        }
    }
    let mut at = 0;
    for b in 0..nb {
        s(meta, 5 + 2 * b, at);
        at += g(meta, 6 + 2 * b);
        s(meta, 6 + 2 * b, 0);
    }
    for kk in 0..np {
        let b = g(sbk, kk) as usize;
        let q = (g(meta, 5 + 2 * b) + g(meta, 6 + 2 * b)) as usize;
        s(meta, 6 + 2 * b, g(meta, 6 + 2 * b) + 1);
        s(pgx, q, g(qgx, kk)); s(pgy, q, g(qgy, kk)); s(po, q, g(qo, kk)); s(pid, q, g(qid, kk));
        s(px, q, g(qx, kk)); s(py, q, g(qy, kk)); s(pr, q, g(qr, kk)); s(qp, kk, q as i32);
    }
    // The spawners in tile order (the q arrays') and back; the set's hashes.
    let (rk, ro, hs) = (k.p::<i32>(22), k.p::<i32>(23), k.p::<i32>(24));
    for r in 0..np {
        let q = g(qp, r);
        s(rk, r, q);
        s(ro, q as usize, r as i32);
    }
    let (mut h1, mut h2) = (0i32, 0x9e3779b9u32 as i32);
    for p in 0..np {
        let v = ((g(pgx, p) as i64 * 73856093) as i32) ^ ((g(pgy, p) as i64 * 19349663) as i32) ^ ((g(pid, p) as i64 * 83492791) as i32) ^ (((g(po, p) as i64 + 16) * 2654435761) as i32);
        let hh = v.wrapping_mul(0x85ebca6bu32 as i32);
        h1 = h1.wrapping_add(hh);
        h2 = (h2 ^ hh).wrapping_mul(0x01000193);
    }
    s(hs, 0, h1);
    s(hs, 1, h2);
    s(meta, 0, cap as i32);
    s(meta, 1, np as i32);
    s(meta, 2, 1);
    s(meta, 3, bcols);
    s(meta, 4, brows);
}
