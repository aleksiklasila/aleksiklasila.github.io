//! The units by id (main.js _uix: ids ascending with their slots, a removed
//! one a hole, slot -2): the removed units of a retire pass marked in one
//! call, and the holes squeezed out once they are a quarter.
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

/// k_uix_remove. Arrays: [0] ids, [1] slots, [2] the removed ids (P[0] of
/// them), [3] header in/out ([0] entries, [1] holes). P[1] 1: every hole
/// squeezed out now (main.js unitRows: the rows the passes read).
#[no_mangle]
pub unsafe extern "C" fn k_uix_remove(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ids, slots, rm, hdr) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3));
    let m = k.i(0).max(0) as usize;
    let mut n = g(hdr, 0).max(0) as usize;
    let mut holes = g(hdr, 1);
    for j in 0..m {
        let id = g(rm, j);
        let (mut lo, mut hi) = (0usize, n);
        while lo < hi {
            let mid = (lo + hi) >> 1;
            if g(ids, mid) < id { lo = mid + 1; } else { hi = mid; }
        }
        if lo < n && g(ids, lo) == id && g(slots, lo) != -2 {
            s(slots, lo, -2);
            holes += 1;
        }
    }
    if holes as usize * 4 > n || (k.i(1) != 0 && holes > 0) {
        let mut w = 0usize;
        for r in 0..n {
            let sl = g(slots, r);
            if sl != -2 {
                s(ids, w, g(ids, r));
                s(slots, w, sl);
                w += 1;
            }
        }
        n = w;
        holes = 0;
    }
    s(hdr, 0, n as i32);
    s(hdr, 1, holes);
}

/// k_uid_delete: the removed units out of the id table (main.js UnitIdIndex:
/// slots by a hash of their id, linear probing, -1 empty). Arrays: [0] the
/// table (P[1] entries, a power of two), [1] the id column, [2] the removed
/// units' slots (P[0] of them; their ids still in the column), [3] out: [0]
/// how many were found and deleted.
#[no_mangle]
pub unsafe extern "C" fn k_uid_delete(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (t, idc, rm, out) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3));
    let (m, len) = (k.i(0).max(0) as usize, k.i(1).max(0) as u32);
    if len == 0 { s(out, 0, 0); return; }
    let mask = len - 1;
    let hash = |id: i32| -> u32 { (id as u32).wrapping_mul(2654435761u32) & mask };
    let mut del = 0;
    for j in 0..m {
        let sl = g(rm, j);
        if sl < 0 { continue; }
        let id = g(idc, sl as usize);
        let mut h = hash(id);
        let mut found = false;
        loop {
            let v = g(t, h as usize);
            if v == -1 { break; }
            if v == sl && g(idc, v as usize) == id { found = true; break; }
            h = (h + 1) & mask;
        }
        if !found { continue; }
        // (Backward shift, as UnitIdIndex.delete.)
        let mut hole = h;
        let mut q = h;
        loop {
            q = (q + 1) & mask;
            let v = g(t, q as usize);
            if v == -1 { break; }
            let home = hash(g(idc, v as usize));
            if (q > hole && (home <= hole || home > q)) || (q < hole && home <= hole && home > q) {
                s(t, hole as usize, v);
                hole = q;
            }
        }
        s(t, hole as usize, -1);
        del += 1;
    }
    s(out, 0, del);
}
