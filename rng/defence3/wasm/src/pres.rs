//! The presentation worker's frame passes (presentation_worker.js), on its
//! own memory where its frames live: no sort or bucket pass in JS.
use super::k::K;
use super::{waddr, floor};

// n slots by unit id: LSD radix sort, 8-bit passes, of (id, slot) pairs.
// Live ids are unique and non-negative, so the order is the one by id
// alone. Passes whose byte is the same in every key are skipped. scratch:
// 3 * n words.
unsafe fn radix_by_id(slots: *mut i32, id: *const i32, n: usize, scratch: *mut u32) {
    if n < 2 { return; }
    // keys and slots, then the other halves of the ping-pong
    let (ka, sa) = (scratch, slots as *mut u32);
    let (kb, sb) = (scratch.add(n), scratch.add(2 * n));
    let mut hist = [[0u32; 256]; 4];
    for i in 0..n {
        let key = *id.add(*slots.add(i) as usize) as u32;
        *ka.add(i) = key;
        for b in 0..4 { hist[b][((key >> (8 * b)) & 255) as usize] += 1; }
    }
    let (mut ks, mut ss, mut kd, mut sd) = (ka, sa, kb, sb);
    for b in 0..4 {
        let h = &mut hist[b];
        if h.iter().any(|&c| c as usize == n) { continue; }
        let mut sum = 0u32;
        for c in h.iter_mut() { let t = *c; *c = sum; sum += t; }
        let sh = 8 * b as u32;
        for i in 0..n {
            let key = *ks.add(i);
            let d = &mut h[((key >> sh) & 255) as usize];
            *kd.add(*d as usize) = key; *sd.add(*d as usize) = *ss.add(i);
            *d += 1;
        }
        core::mem::swap(&mut ks, &mut kd); core::mem::swap(&mut ss, &mut sd);
    }
    if ss != sa { core::ptr::copy_nonoverlapping(ss, sa, n); }
}

/// A frame's first count order entries (slots) by unit id, sorted whole.
/// Arrays: 0 order (i32 slots, sorted in place), 1 id (i32 by slot),
/// 2 scratch (u32, 3 * count). P: 0 count.
#[no_mangle]
pub unsafe extern "C" fn k_pres_order(a: u32, _: i32) {
    let k = K::new(waddr(a) as *const i32);
    radix_by_id(k.p::<i32>(0), k.p::<i32>(1), k.i(0).max(0) as usize, k.p::<u32>(2));
}

/// The camera's buckets of a frame (16x16-tile cells), a part: order
/// entries k0..k1 into this part's lists a cell (k_pres_bucket_merge joins
/// the parts: the same lists as one pass over all, k descending a cell),
/// its largest move a cell (tiles), its slots that moved (or changed
/// position since the last frame built: teleports, stops) at moving[k0..];
/// then the positions for the next frame.
/// Arrays: 0 order, 1 x, 2 y, 3 px, 4 py, 5 next (by order entry), 6
/// moving, 7 prev x, 8 prev y, 9 heads (i32, cells a part), 10 tails (i32),
/// 11 motion (f32), 12 moved (i32 a part). P: 0 k0, 1 k1, 2 columns, 3
/// rows, 4 tile, 5 previous ready, 6 part.
#[no_mangle]
pub unsafe extern "C" fn k_pres_bucket_part(a: u32, _: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (order, x, y, px, py) = (k.p::<i32>(0), k.p::<f32>(1), k.p::<f32>(2), k.p::<f32>(3), k.p::<f32>(4));
    let (next, moving, prx, pry) = (k.p::<i32>(5), k.p::<i32>(6), k.p::<f32>(7), k.p::<f32>(8));
    let (k0, k1) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize);
    let (cols, rows) = (k.i(2).max(1), k.i(3).max(1));
    let tile = k.f(4);
    let ready = k.i(5) != 0;
    let part = k.i(6).max(0) as usize;
    let cells = (cols * rows) as usize;
    let (head, tail, motion, moved) = (k.p::<i32>(9).add(part * cells), k.p::<i32>(10).add(part * cells), k.p::<f32>(11).add(part * cells), k.p::<i32>(12).add(part));
    for c in 0..cells { *head.add(c) = -1; *motion.add(c) = 0.0; }
    let inv_cell = 1.0 / (tile * 16.0);
    let inv_tile = 1.0 / tile;
    let mut m = 0usize;
    for i in k0..k1 {
        let s = *order.add(i) as usize;
        let (xf, yf) = (*x.add(s), *y.add(s));
        let (xd, yd) = (xf as f64, yf as f64);
        let bx = (floor(xd * inv_cell) as i32).min(cols - 1).max(0);
        let by = (floor(yd * inv_cell) as i32).min(rows - 1).max(0);
        let b = (by * cols + bx) as usize;
        let h = *head.add(b);
        if h < 0 { *tail.add(b) = i as i32; }
        *next.add(i) = h; *head.add(b) = i as i32;
        // (The largest move: f32 of the largest f64 distance, whatever the
        // order the parts are taken in: rounding is monotonic.)
        let dist = (*px.add(s) as f64 - xd).abs().max((*py.add(s) as f64 - yd).abs()) * inv_tile;
        if dist > *motion.add(b) as f64 { *motion.add(b) = dist as f32; }
        if dist > 0.0 || (ready && (*prx.add(s) != xf || *pry.add(s) != yf)) { *moving.add(k0 + m) = s as i32; m += 1; }
        *prx.add(s) = xf; *pry.add(s) = yf;
    }
    *moved = m as i32;
}

/// The parts joined: a cell's list the last part's (k descending), its tail
/// on to the part before's, ...; the largest move of all; the moving slots
/// one after another. Arrays: 0 head, 1 motion (cells), 2 next, 3 moving,
/// 4 heads, 5 tails, 6 motion (parts' cells), 7 moved (parts), 8 out (i32:
/// moving count). P: 0 parts, 1 cells, 2 order entries a part.
#[no_mangle]
pub unsafe extern "C" fn k_pres_bucket_merge(a: u32, _: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (head, motion, next, moving) = (k.p::<i32>(0), k.p::<f32>(1), k.p::<i32>(2), k.p::<i32>(3));
    let (heads, tails, pmo, moved, out) = (k.p::<i32>(4), k.p::<i32>(5), k.p::<f32>(6), k.p::<i32>(7), k.p::<i32>(8));
    let (parts, cells, per) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2).max(0) as usize);
    for b in 0..cells {
        let (mut h, mut mo) = (-1i32, 0.0f32);
        for p in 0..parts {
            let ph = *heads.add(p * cells + b);
            if ph >= 0 { *next.add(*tails.add(p * cells + b) as usize) = h; h = ph; }
            let v = *pmo.add(p * cells + b);
            if v > mo { mo = v; }
        }
        *head.add(b) = h; *motion.add(b) = mo;
    }
    let mut m = 0usize;
    for p in 0..parts {
        let (c, at) = ((*moved.add(p)).max(0) as usize, p * per);
        if at != m && c > 0 { core::ptr::copy(moving.add(at), moving.add(m), c); }
        m += c;
    }
    *out = m as i32;
}
