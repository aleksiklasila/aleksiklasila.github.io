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

/// Sanitize an action's integer IDs in input order, using the same table and
/// per-slot duplicate stamps as UnitIdIndex / _actionCleanIds. Detached slots
/// are ignored; dead units still in the world remain valid IDs. All pointers
/// are reserved scratch or existing columns, and no gameplay order is issued.
/// P: input count, hash mask, stamp, output limit. Arrays: input IDs, hash
/// table, ID/live/stamp columns, output IDs, output count.
#[no_mangle]
pub unsafe extern "C" fn k_uid_clean(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ids, tab, idc, live, stamps, out, cnt) =
        (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<u8>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6));
    let (n, mask, stamp, limit) = (k.i(0).max(0) as usize, k.i(1) as u32, k.i(2), k.i(3).max(0) as usize);
    let mut count = 0;
    for j in 0..n {
        if count >= limit { break; }
        let id = g(ids, j);
        let mut h = (id as u32).wrapping_mul(2654435761u32) & mask;
        loop {
            let slot = g(tab, h as usize);
            if slot < 0 { break; }
            let slot = slot as usize;
            if g(idc, slot) == id && g(live, slot) != 0 {
                if g(stamps, slot) != stamp {
                    s(stamps, slot, stamp); s(out, count, id); count += 1;
                }
                break;
            }
            h = (h + 1) & mask;
        }
    }
    s(cnt, 0, count as i32);
}

/// Record an action's arrival on its player's indexed units. Duplicate IDs,
/// including those in earlier chunks, already carry this mark and do nothing.
/// Return the changed-unit count and runs of superseded marks/counts, so JS
/// updates its waiting-action records without resolving every unit object.
/// P: input count, hash mask, new mark, player. Arrays: input IDs, hash table,
/// ID/live/owner/arrival columns, old marks, run counts, result counts.
#[no_mangle]
pub unsafe extern "C" fn k_uid_arrival(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ids, tab, idc, live, owner, marks) =
        (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<u8>(3), k.p::<i8>(4), k.p::<i32>(5));
    let (old_marks, runs, cnt) = (k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8));
    let (n, mask, mark, player) = (k.i(0).max(0) as usize, k.i(1) as u32, k.i(2), k.i(3));
    let (mut changed, mut count) = (0, 0usize);
    for j in 0..n {
        let id = g(ids, j);
        let mut h = (id as u32).wrapping_mul(2654435761u32) & mask;
        loop {
            let slot = g(tab, h as usize);
            if slot < 0 { break; }
            let slot = slot as usize;
            if g(idc, slot) == id && g(live, slot) != 0 {
                if g(owner, slot) as i32 == player {
                    let old = g(marks, slot);
                    if old != mark {
                        s(marks, slot, mark); changed += 1;
                        if old > 0 {
                            if count > 0 && g(old_marks, count - 1) == old {
                                s(runs, count - 1, g(runs, count - 1) + 1);
                            } else {
                                s(old_marks, count, old); s(runs, count, 1); count += 1;
                            }
                        }
                    }
                }
                break;
            }
            h = (h + 1) & mask;
        }
    }
    s(cnt, 0, changed); s(cnt, 1, count as i32);
}
