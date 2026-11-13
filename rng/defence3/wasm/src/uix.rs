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

/// k_slots_by_id: a list of (slot, id) pairs whose units may have moved to
/// other slots (the online relayout) made current: a slot whose unit is
/// live and still has the id stays; else the id's slot by the id index (a
/// hole, a unit without columns or no such id: -1). Arrays: [0] slots
/// (in / out), [1] ids, [2] unit.id, [3] unit.live, [4] index ids, [5]
/// index slots. P: [0] pairs, [1] index entries, [2] slots (columns' length).
#[no_mangle]
pub unsafe extern "C" fn k_slots_by_id(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (rs, ri, cid, live, xid, xsl) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<u8>(3), k.p::<i32>(4), k.p::<i32>(5));
    let (n, nx, ns) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2).max(0));
    for i in 0..n {
        let (sl, id) = (g(rs, i), g(ri, i));
        if sl >= 0 && sl < ns && g(live, sl as usize) != 0 && g(cid, sl as usize) == id { continue; }
        let (mut lo, mut hi) = (0usize, nx);
        while lo < hi { let m = (lo + hi) >> 1; if g(xid, m) < id { lo = m + 1; } else { hi = m; } }
        s(rs, i, if lo < nx && g(xid, lo) == id { let q = g(xsl, lo); if q >= 0 && q < ns { q } else { -1 } } else { -1 });
    }
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
        // (From the first hole; branchless: every row written, kept ones
        // advance. Holes fall anywhere: a branch per row mispredicted.)
        let mut w = 0usize;
        while w < n && g(slots, w) != -2 { w += 1; }
        for r in w..n {
            let sl = g(slots, r);
            s(ids, w, g(ids, r));
            s(slots, w, sl);
            w += (sl != -2) as usize;
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


/// A unit command over its ids (main.js processAction hold / stop / attack /
/// attackBuilding / killUnit: _unitCmdKernel), each unit once (the id
/// stamps), the player's own: its columns as the setters write them.
/// Arrays: [0] ids, [1] the id table, [2] unit.id, [3] unit.live, [4]
/// unit.idStp, [5] slots left to the JavaScript (stop: workers), [6] counts
/// ([0] left, [1] paths let go, [2] changed), [7] owner, [8] dead, [9] isWk,
/// [10] upT, [11] commandState, [12] mvOn, [13] holdF, [14] holdPosition's
/// value ids (width P[20]), [15] hObj, [16] tuS, [17] tuId, [18] tbT, [19]
/// acqB, [20] fatF, [21] fLsX, [22] fLsY, [23] amGx, [24] amGy, [25] mvTgX,
/// [26] mvTgY, [27] rkF, [28] nvPK, [29] pathIndex, [30] mvPath, [31] the
/// path pool's free stack ([0] its top), [32] mvCD, [33] cmMode, [34] mvWk,
/// [35] ptSt, [36] ptGx, [37] ptGy, [38] mvPP, [39] mvPF, [40] energy, [41]
/// slots whose path went (for their JavaScript path, P[19] 1).
/// P: [0] ids, [1] table mask, [2] stamp, [3] op (1 hold, 2 stop, 3 attack a
/// unit, 4 attack a structure, 5 kill), [4] player, [5] CMD_IDLE, [6]
/// CMD_ATTACKING, [7] / [8] / [9] the digest keys of holdPosition, the
/// pending target, the fallback flag, [10] / [11] / [12] holdPosition's ids
/// of undefined / false / true, [13] / [14] the target unit's slot and id,
/// [15] / [16] the target's position, [17] the target structure's tile,
/// [18] the king's type index, [19] list paths, [20] the hold ids' width.
#[no_mangle]
pub unsafe extern "C" fn k_unit_cmd(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ids, tab, idc, live, stamps, left, cnt) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<u8>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6));
    let (own, dead, iswk, upt, cmd, on, holdf) = (k.p::<i8>(7), k.p::<u8>(8), k.p::<u8>(9), k.p::<i16>(10), k.p::<u8>(11), k.p::<u8>(12), k.p::<u8>(13));
    let (hold_ids, hobj, tus, tuid, tbt, acqb, fatf) = (k.p::<u8>(14), k.p::<i32>(15), k.p::<i32>(16), k.p::<i32>(17), k.p::<i32>(18), k.p::<u8>(19), k.p::<u8>(20));
    let (lsx, lsy, amgx, amgy, tgx, tgy, rkf) = (k.p::<f32>(21), k.p::<f32>(22), k.p::<i16>(23), k.p::<i16>(24), k.p::<f32>(25), k.p::<f32>(26), k.p::<u8>(27));
    let (nvpk, pidx, mpath, pfs, mcd, cmm, mvwk) = (k.p::<i32>(28), k.p::<i32>(29), k.p::<i32>(30), k.p::<i32>(31), k.p::<i32>(32), k.p::<u8>(33), k.p::<u8>(34));
    let (pst, pgx, pgy, mpp, mpf, en, pout) = (k.p::<u8>(35), k.p::<i16>(36), k.p::<i16>(37), k.p::<u8>(38), k.p::<u8>(39), k.p::<f32>(40), k.p::<i32>(41));
    // (The path store: [42] unit.pthH, [43] its arena, [44] its free lists.)
    let (pth, parena, pfree) = (k.p::<i32>(42), k.p::<i32>(43), k.p::<i32>(44));
    let (n, mask, stamp, op, player) = (k.i(0).max(0) as usize, k.i(1) as u32, k.i(2), k.i(3), k.i(4));
    let (cmd_idle, cmd_att) = (k.i(5) as u8, k.i(6) as u8);
    let (k_hold, k_ppt, k_pfa) = (k.i(7), k.i(8), k.i(9));
    let (h_undef, h_false, h_true) = (k.i(10) as u32, k.i(11) as u32, k.i(12) as u32);
    let (t_slot, t_id, t_x, t_y, t_tile, king, list_paths, hw) = (k.i(13), k.i(14), k.f(15) as f32, k.f(16) as f32, k.i(17), k.i(18), k.i(19) != 0, k.i(20));
    // (holdPosition's value id at slot q, and written.)
    let hget = |q: usize| -> u32 { match hw { 2 => *(hold_ids as *const u16).add(q) as u32, 4 => *(hold_ids as *const u32).add(q), _ => *hold_ids.add(q) as u32 } };
    let hset = |q: usize, v: u32| { match hw { 2 => *(hold_ids as *mut u16).add(q) = v as u16, 4 => *(hold_ids as *mut u32).add(q) = v, _ => *hold_ids.add(q) = v as u8 } };
    let henc = |id: u32| -> i32 { if id == h_true { 0x3bd } else if id == h_false { 0x2bd } else { H_UNDEF } };
    let (mut nl, mut np, mut nc) = (0usize, 0usize, 0i32);
    for j in 0..n {
        // The id's slot (unit.js UnitIdIndex: the table's probe), once.
        let id = g(ids, j);
        let mut h = (id as u32).wrapping_mul(2654435761u32) & mask;
        let mut q = usize::MAX;
        loop {
            let slot = g(tab, h as usize);
            if slot < 0 { break; }
            let sl = slot as usize;
            if g(idc, sl) == id && g(live, sl) != 0 { q = sl; break; }
            h = (h + 1) & mask;
        }
        if q == usize::MAX || g(stamps, q) == stamp { continue; }
        s(stamps, q, stamp);
        if g(own, q) as i32 != player { continue; }
        match op {
            1 => {
                // Hold: movement off, everything else kept.
                let o = hget(q);
                if o != h_true { s(hobj, q, g(hobj, q).wrapping_add(hterm(k_hold, 0x3bd)).wrapping_sub(hterm(k_hold, henc(o)))); hset(q, h_true); }
                s(holdf, q, 1); s(on, q, 0); nc += 1;
            }
            2 => {
                // Stop: a held unit released (its orders resume); a free one stops.
                if g(holdf, q) != 0 {
                    let o = hget(q);
                    if o != h_false { s(hobj, q, g(hobj, q).wrapping_add(hterm(k_hold, 0x2bd)).wrapping_sub(hterm(k_hold, henc(o)))); hset(q, h_false); }
                    s(holdf, q, 0); s(on, q, 0); nc += 1;
                    continue;
                }
                if g(iswk, q) != 0 { s(left, nl, q as i32); nl += 1; continue; }
                if g(cmd, q) != cmd_idle { s(on, q, 0); s(cmd, q, cmd_idle); }
                let_go_path(q, nvpk, mpath, pfs, on, mcd, pout, list_paths, &mut np);
                crate::path_release(pth, q, parena, pfree);
                s(tus, q, -1); s(tuid, q, 0); s(tbt, q, -1); s(acqb, q, 0);
                pending_clear(q, pst, pgx, pgy, hobj, mpp, mpf, k_ppt, k_pfa, false);
                s(fatf, q, 0); s(lsx, q, f32::NAN); s(lsy, q, f32::NAN); s(amgx, q, -1); s(amgy, q, -1);
                nc += 1;
            }
            3 | 4 => {
                // An attack order (unit.js unitAttackOrder): no way of its own,
                // the movement kernel follows its target (mv.rs forced).
                if g(dead, q) != 0 || g(iswk, q) != 0 { continue; }
                if g(cmd, q) != cmd_att { s(on, q, 0); s(cmd, q, cmd_att); }
                s(amgx, q, -1); s(amgy, q, -1);
                let_go_path(q, nvpk, mpath, pfs, on, mcd, pout, list_paths, &mut np);
                crate::path_release(pth, q, parena, pfree);
                if g(pidx, q) != 0 { s(on, q, 0); s(pidx, q, 0); }
                s(rkf, q, 0);
                pending_clear(q, pst, pgx, pgy, hobj, mpp, mpf, k_ppt, k_pfa, true);
                s(cmm, q, 0); s(on, q, 0); s(mvwk, q, 0);
                if op == 3 {
                    s(tus, q, t_slot); s(tuid, q, t_id); s(tbt, q, -1); s(acqb, q, 0); s(fatf, q, 1);
                    s(lsx, q, t_x); s(lsy, q, t_y);
                } else {
                    s(tbt, q, t_tile); s(acqb, q, 1); s(tus, q, -1); s(tuid, q, 0); s(fatf, q, 0);
                    s(lsx, q, f32::NAN); s(lsy, q, f32::NAN);
                }
                s(tgx, q, t_x); s(tgy, q, t_y);
                nc += 1;
            }
            5 => {
                // Killed (not a king): gameTick's sweep removes it.
                if g(dead, q) != 0 || g(upt, q) as i32 == king { continue; }
                s(en, q, 0.0); s(dead, q, 1); nc += 1;
            }
            _ => {}
        }
    }
    s(cnt, 0, nl as i32); s(cnt, 1, np as i32); s(cnt, 2, nc);
}
// (unit.js path = null: its flow key and pool path let go, unarmed.)
#[inline(always)]
unsafe fn let_go_path(q: usize, nvpk: *mut i32, mpath: *mut i32, pfs: *mut i32, on: *mut u8, mcd: *mut i32, pout: *mut i32, list: bool, np: &mut usize) {
    s(nvpk, q, -1);
    let p = g(mpath, q);
    if p >= 0 && !pfs.is_null() { let top = g(pfs, 0) + 1; s(pfs, 0, top); s(pfs, top as usize, p); s(mpath, q, -1); }
    s(on, q, 0); s(mcd, q * 8, -1);
    if list && !pout.is_null() { s(pout, *np, q as i32); *np += 1; }
}
// (sim_unit_state.js simPendingClear: target null and, flag, the fallback flag false; their digest terms, the kernels' mirrors.)
#[inline(always)]
unsafe fn pending_clear(q: usize, pst: *mut u8, pgx: *mut i16, pgy: *mut i16, hobj: *mut i32, mpp: *mut u8, mpf: *mut u8, kp: i32, kf: i32, flag: bool) {
    let t = g(pst, q) as i32;
    let want = if flag { 5 } else { (t & 12) | 1 };
    if t != want {
        let mut h = g(hobj, q);
        if t & 3 != 1 {
            let e = match t & 3 { 2 => (-16i32).wrapping_sub((g(pgy, q) as i32).wrapping_mul(65536).wrapping_add(g(pgx, q) as i32)), _ => H_UNDEF };
            h = h.wrapping_add(hterm(kp, H_NULL)).wrapping_sub(hterm(kp, e));
        }
        if flag && (t >> 2) & 3 != 1 {
            let e = match (t >> 2) & 3 { 2 => 0x3bd, _ => H_UNDEF };
            h = h.wrapping_add(hterm(kf, 0x2bd)).wrapping_sub(hterm(kf, e));
        }
        s(hobj, q, h); s(pst, q, want as u8);
    }
    // (mvPF: both set; mvPP: bit 1 the flag, 2 the target.)
    let f = ((want >> 2) & 3) == 2;
    s(mpp, q, f as u8); s(mpf, q, 0);
}
const H_NULL: i32 = -2147483647;
const H_UNDEF: i32 = -2147483648;
#[inline(always)]
fn hterm(key: i32, e: i32) -> i32 {
    let t = (key ^ e).wrapping_mul(16777619u32.wrapping_mul(2654435761u32) as i32);
    (t ^ ((t as u32) >> 15) as i32).wrapping_mul(0x2c1b3c6d)
}

/// k_unit_cmd in parallel (SIM_KERNEL_UNIT_CMD; main.js _unitCmdKernel): its
/// arrays and P[0..20]. P[21] 0: chunk `chunk` of P[22] ids, each as
/// k_unit_cmd does it (a slot's dedupe by an atomic swap of its stamp: the
/// ids are an action's, cleaned, so a slot is in one chunk), but what goes
/// onto a shared stack in order (the movement path back to its free stack,
/// the stored path's release: shared, refcounted blocks; the stopped
/// workers; the listed paths) left to the merge: the chunk's slots that let
/// go of their paths and its workers into the scratch cs [45] (2 lists of
/// P[22] a chunk), their counts and the commands' into cc [46] (4 a chunk).
/// P[21] 1 (one job, P[23] chunks): in chunk order, a path slot's movement
/// path pushed and its stored path released (k_unit_cmd's let_go_path /
/// path_release), listed in pout when P[19]; the workers into left; cnt as
/// k_unit_cmd's.
#[no_mangle]
pub unsafe extern "C" fn k_unit_cmd_par(a: u32, chunk: i32) {
    use core::sync::atomic::{AtomicI32, Ordering};
    let k = K::new(waddr(a) as *const i32);
    let (ids, tab, idc, live, stamps, left, cnt) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<u8>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6));
    let (own, dead, iswk, upt, cmd, on, holdf) = (k.p::<i8>(7), k.p::<u8>(8), k.p::<u8>(9), k.p::<i16>(10), k.p::<u8>(11), k.p::<u8>(12), k.p::<u8>(13));
    let (hold_ids, hobj, tus, tuid, tbt, acqb, fatf) = (k.p::<u8>(14), k.p::<i32>(15), k.p::<i32>(16), k.p::<i32>(17), k.p::<i32>(18), k.p::<u8>(19), k.p::<u8>(20));
    let (lsx, lsy, amgx, amgy, tgx, tgy, rkf) = (k.p::<f32>(21), k.p::<f32>(22), k.p::<i16>(23), k.p::<i16>(24), k.p::<f32>(25), k.p::<f32>(26), k.p::<u8>(27));
    let (nvpk, pidx, mpath, pfs, mcd, cmm, mvwk) = (k.p::<i32>(28), k.p::<i32>(29), k.p::<i32>(30), k.p::<i32>(31), k.p::<i32>(32), k.p::<u8>(33), k.p::<u8>(34));
    let (pst, pgx, pgy, mpp, mpf, en, pout) = (k.p::<u8>(35), k.p::<i16>(36), k.p::<i16>(37), k.p::<u8>(38), k.p::<u8>(39), k.p::<f32>(40), k.p::<i32>(41));
    let (pth, parena, pfree) = (k.p::<i32>(42), k.p::<i32>(43), k.p::<i32>(44));
    let (cs, cc) = (k.p::<i32>(45), k.p::<i32>(46));
    let (n, mask, stamp, op, player) = (k.i(0).max(0), k.i(1) as u32, k.i(2), k.i(3), k.i(4));
    let (cmd_idle, cmd_att) = (k.i(5) as u8, k.i(6) as u8);
    let (k_hold, k_ppt, k_pfa) = (k.i(7), k.i(8), k.i(9));
    let (h_undef, h_false, h_true) = (k.i(10) as u32, k.i(11) as u32, k.i(12) as u32);
    let _ = h_undef;
    let (t_slot, t_id, t_x, t_y, t_tile, king, list_paths, hw) = (k.i(13), k.i(14), k.f(15) as f32, k.f(16) as f32, k.i(17), k.i(18), k.i(19) != 0, k.i(20));
    let per = k.i(22).max(1) as usize;
    if k.i(21) == 1 {
        let nch = k.i(23).max(0) as usize;
        let (mut nl, mut np, mut nc) = (0usize, 0usize, 0i32);
        for c in 0..nch {
            let b = cs.add(c * 2 * per);
            let (npq, nlw) = (g(cc, 4 * c) as usize, g(cc, 4 * c + 1) as usize);
            for i in 0..npq {
                let q = *b.add(i) as usize;
                let p = g(mpath, q);
                if p >= 0 && !pfs.is_null() { let top = g(pfs, 0) + 1; s(pfs, 0, top); s(pfs, top as usize, p); s(mpath, q, -1); }
                if list_paths && !pout.is_null() { s(pout, np, q as i32); np += 1; }
                crate::path_release(pth, q, parena, pfree);
            }
            for i in 0..nlw { s(left, nl, *b.add(per + i)); nl += 1; }
            nc += g(cc, 4 * c + 2);
        }
        s(cnt, 0, nl as i32); s(cnt, 1, np as i32); s(cnt, 2, nc);
        return;
    }
    let hget = |q: usize| -> u32 { match hw { 2 => *(hold_ids as *const u16).add(q) as u32, 4 => *(hold_ids as *const u32).add(q), _ => *hold_ids.add(q) as u32 } };
    let hset = |q: usize, v: u32| { match hw { 2 => *(hold_ids as *mut u16).add(q) = v as u16, 4 => *(hold_ids as *mut u32).add(q) = v, _ => *hold_ids.add(q) = v as u8 } };
    let henc = |id: u32| -> i32 { if id == h_true { 0x3bd } else if id == h_false { 0x2bd } else { H_UNDEF } };
    let c = chunk.max(0) as usize;
    let (j0, j1) = super::k::job_range(chunk, per as i32, n);
    let b = cs.add(c * 2 * per);
    let (mut npq, mut nlw, mut nc) = (0usize, 0usize, 0i32);
    // (A slot's path let go here but for the shared stacks: the merge's.)
    let go = |q: usize| { s(nvpk, q, -1); s(on, q, 0); s(mcd, q * 8, -1); };
    for j in j0..j1 {
        let id = g(ids, j);
        let mut h = (id as u32).wrapping_mul(2654435761u32) & mask;
        let mut q = usize::MAX;
        loop {
            let slot = g(tab, h as usize);
            if slot < 0 { break; }
            let sl = slot as usize;
            if g(idc, sl) == id && g(live, sl) != 0 { q = sl; break; }
            h = (h + 1) & mask;
        }
        if q == usize::MAX { continue; }
        if (*(stamps.add(q) as *const AtomicI32)).swap(stamp, Ordering::Relaxed) == stamp { continue; }
        if g(own, q) as i32 != player { continue; }
        match op {
            1 => {
                let o = hget(q);
                if o != h_true { s(hobj, q, g(hobj, q).wrapping_add(hterm(k_hold, 0x3bd)).wrapping_sub(hterm(k_hold, henc(o)))); hset(q, h_true); }
                s(holdf, q, 1); s(on, q, 0); nc += 1;
            }
            2 => {
                if g(holdf, q) != 0 {
                    let o = hget(q);
                    if o != h_false { s(hobj, q, g(hobj, q).wrapping_add(hterm(k_hold, 0x2bd)).wrapping_sub(hterm(k_hold, henc(o)))); hset(q, h_false); }
                    s(holdf, q, 0); s(on, q, 0); nc += 1;
                    continue;
                }
                if g(iswk, q) != 0 { *b.add(per + nlw) = q as i32; nlw += 1; continue; }
                if g(cmd, q) != cmd_idle { s(on, q, 0); s(cmd, q, cmd_idle); }
                go(q); *b.add(npq) = q as i32; npq += 1;
                s(tus, q, -1); s(tuid, q, 0); s(tbt, q, -1); s(acqb, q, 0);
                pending_clear(q, pst, pgx, pgy, hobj, mpp, mpf, k_ppt, k_pfa, false);
                s(fatf, q, 0); s(lsx, q, f32::NAN); s(lsy, q, f32::NAN); s(amgx, q, -1); s(amgy, q, -1);
                nc += 1;
            }
            3 | 4 => {
                if g(dead, q) != 0 || g(iswk, q) != 0 { continue; }
                if g(cmd, q) != cmd_att { s(on, q, 0); s(cmd, q, cmd_att); }
                s(amgx, q, -1); s(amgy, q, -1);
                go(q); *b.add(npq) = q as i32; npq += 1;
                if g(pidx, q) != 0 { s(on, q, 0); s(pidx, q, 0); }
                s(rkf, q, 0);
                pending_clear(q, pst, pgx, pgy, hobj, mpp, mpf, k_ppt, k_pfa, true);
                s(cmm, q, 0); s(on, q, 0); s(mvwk, q, 0);
                if op == 3 {
                    s(tus, q, t_slot); s(tuid, q, t_id); s(tbt, q, -1); s(acqb, q, 0); s(fatf, q, 1);
                    s(lsx, q, t_x); s(lsy, q, t_y);
                } else {
                    s(tbt, q, t_tile); s(acqb, q, 1); s(tus, q, -1); s(tuid, q, 0); s(fatf, q, 0);
                    s(lsx, q, f32::NAN); s(lsy, q, f32::NAN);
                }
                s(tgx, q, t_x); s(tgy, q, t_y);
                nc += 1;
            }
            5 => {
                if g(dead, q) != 0 || g(upt, q) as i32 == king { continue; }
                s(en, q, 0.0); s(dead, q, 1); nc += 1;
            }
            _ => {}
        }
    }
    s(cc, 4 * c, npq as i32); s(cc, 4 * c + 1, nlw as i32); s(cc, 4 * c + 2, nc);
}

/// k_rows_fill: row runs of many columns set to each column's empty value
/// (data_state.js _sRowsFree: a structure table's expired rows). Arrays: [0]
/// the columns, five words each: the column's encoded address, its element
/// bytes (1, 2, 4, 8), its elements a row, the value's low and high 32 bits;
/// [1] the runs' first rows, [2] their ends (exclusive). P: [0] columns, [1]
/// runs, [2] 1: a job a column (chunk), else every column in one call. Each run is
/// a byte range filled with the value's 16-byte pattern: vector stores in
/// the middle, element stores at the ends.
#[no_mangle]
pub unsafe extern "C" fn k_rows_fill(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (cols, rs, re) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2));
    let (nc, nr) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize);
    let (c0, c1) = if k.i(2) != 1 { (0, nc) } else { (chunk.max(0) as usize, (chunk.max(0) as usize + 1).min(nc)) };
    for c in c0..c1 {
        let d = cols.add(5 * c);
        let (base, w, per) = (waddr(*d as u32) as *mut u8, (*d.add(1)).max(1) as usize, (*d.add(2)).max(1) as usize);
        let bits = (*d.add(3) as u32 as u64) | ((*d.add(4) as u32 as u64) << 32);
        if base.is_null() { continue; }
        let v = match w { 1 => u8x16_splat(bits as u8), 2 => u16x8_splat(bits as u16), 4 => u32x4_splat(bits as u32), _ => u64x2_splat(bits) };
        let pat: [u8; 16] = core::mem::transmute(v);
        for r in 0..nr {
            let (s0, s1) = ((*rs.add(r)).max(0) as usize, (*re.add(r)).max(0) as usize);
            if s1 <= s0 { continue; }
            let (b0, b1) = (s0 * per * w, s1 * per * w);
            let mut p = base.add(b0);
            let end = base.add(b1);
            // (Elements up to a 16-byte boundary: the pattern's phase is the element's.)
            while (p as usize) & 15 != 0 && p < end {
                *p = pat[(p as usize - base as usize) & 15];
                p = p.add(1);
            }
            while (end as usize) - (p as usize) >= 64 {
                v128_store(p as *mut v128, v); v128_store(p.add(16) as *mut v128, v);
                v128_store(p.add(32) as *mut v128, v); v128_store(p.add(48) as *mut v128, v);
                p = p.add(64);
            }
            while (end as usize) - (p as usize) >= 16 { v128_store(p as *mut v128, v); p = p.add(16); }
            while p < end { *p = pat[(p as usize - base as usize) & 15]; p = p.add(1); }
        }
    }
}
