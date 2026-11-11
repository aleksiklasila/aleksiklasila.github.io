//! The presentation worker's frame passes (presentation_worker.js), on its
//! own memory where its frames live: no sort or bucket pass in JS.
use super::k::K;
use super::{waddr, floor};

/// A frame's first count order entries (slots) by unit id: LSD radix sort,
/// 8-bit passes, of (id, slot) pairs. Live ids are unique and non-negative,
/// so the order is the one by id alone. Passes whose byte is the same in
/// every key are skipped.
/// Arrays: 0 order (i32 slots, sorted in place), 1 id (i32 by slot),
/// 2 scratch (u32, 3 * count). P: 0 count.
#[no_mangle]
pub unsafe extern "C" fn k_pres_order(a: u32, _: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (order, id, scratch) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<u32>(2));
    let n = k.i(0).max(0) as usize;
    if n < 2 { return; }
    // keys and slots, then the other halves of the ping-pong
    let (ka, sa) = (scratch, order as *mut u32);
    let (kb, sb) = (scratch.add(n), scratch.add(2 * n));
    let mut hist = [[0u32; 256]; 4];
    for i in 0..n {
        let key = *id.add(*order.add(i) as usize) as u32;
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

/// The camera's buckets of a frame (16x16-tile cells): a list per cell
/// through next (by order entry), each cell's largest move this frame in
/// tiles, and the slots that moved (or changed position since the last
/// frame built: teleports, stops). Then the positions for the next frame.
/// Arrays: 0 order, 1 x, 2 y, 3 px, 4 py, 5 head (i32 cells), 6 motion
/// (f32 cells), 7 next, 8 moving, 9 prev x, 10 prev y, 11 out (i32: moving
/// count). P: 0 count, 1 columns, 2 rows, 3 tile, 4 previous ready.
#[no_mangle]
pub unsafe extern "C" fn k_pres_buckets(a: u32, _: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (order, x, y, px, py) = (k.p::<i32>(0), k.p::<f32>(1), k.p::<f32>(2), k.p::<f32>(3), k.p::<f32>(4));
    let (head, motion, next, moving) = (k.p::<i32>(5), k.p::<f32>(6), k.p::<i32>(7), k.p::<i32>(8));
    let (prx, pry, out) = (k.p::<f32>(9), k.p::<f32>(10), k.p::<i32>(11));
    let n = k.i(0).max(0) as usize;
    let (cols, rows) = (k.i(1).max(1), k.i(2).max(1));
    let tile = k.f(3);
    let ready = k.i(4) != 0;
    let cells = (cols * rows) as usize;
    for c in 0..cells { *head.add(c) = -1; *motion.add(c) = 0.0; }
    let inv_cell = 1.0 / (tile * 16.0);
    let inv_tile = 1.0 / tile;
    let mut m = 0usize;
    for i in 0..n {
        let s = *order.add(i) as usize;
        let (xf, yf) = (*x.add(s), *y.add(s));
        let (xd, yd) = (xf as f64, yf as f64);
        let bx = (floor(xd * inv_cell) as i32).min(cols - 1).max(0);
        let by = (floor(yd * inv_cell) as i32).min(rows - 1).max(0);
        let b = (by * cols + bx) as usize;
        *next.add(i) = *head.add(b); *head.add(b) = i as i32;
        let dist = (*px.add(s) as f64 - xd).abs().max((*py.add(s) as f64 - yd).abs()) * inv_tile;
        if dist > *motion.add(b) as f64 { *motion.add(b) = dist as f32; }
        if dist > 0.0 || (ready && (*prx.add(s) != xf || *pry.add(s) != yf)) { *moving.add(m) = s as i32; m += 1; }
        *prx.add(s) = xf; *pry.add(s) = yf;
    }
    *out = m as i32;
}
