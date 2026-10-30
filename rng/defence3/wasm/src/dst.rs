//! Structures destroyed as a batch (things_utils.js structDestroyTiles,
//! world model W5): the tiles' entries in the per-tile structure table, their
//! cells, the adjacency marks, the workers' work versions, the tile entity
//! journal, the movement kernel's structure codes and the trap marks, in one
//! pass over the list (in its order). What is not tables is left to the
//! caller: the walls (cells that were walls, listed), the reservations held
//! at the tiles (listed), the rows' objects and presentation.
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

const ST_OWNER_NONE: i32 = 0x7ff9;

/// k_struct_destroy. Arrays: [0] tiles (P[0] of them), the structure table
/// st.* [1] code, [2] own, [3] uc, [4] val, [5] tim, [6] brain, [7] rtab,
/// [8] stab, [9] rrow, [10] ctab, [11] rcnt (structures per hash region),
/// [12] cnt (the owner a tile is counted for + 1); cells [13] type, [14]
/// owner; adjacency dirty set [15] flags, [16] per-256 counts; [17] the work
/// versions (worker.js _workerWorkTable); [18] the journal (a power-of-two
/// ring); the movement kernel's [19] mv.struct codes, [20] mv.scls classes,
/// [21] per-block hostile counts (all three null: not kept now); [22] the trap
/// marks (tfx.dirty); [23] the reservation slots (wk.resv); out: [24] header,
/// [25] wall tiles, [26] reservations (slot, unit id) pairs, [27] per-owner
/// structure count changes (64).
/// P: [0] n, [1] map width, [2] height, [3] hash region tiles, [4] regions a
/// row, [5] TYPE_WALL, [6] TYPE_FLOOR, [7] adjacency flags' length, [8] work
/// players, [9] work types, [10] work regions a row, [11] rows, [12] work
/// region tiles, [13] journal end, [14] mv players, [15] mv block columns,
/// [16] mv block tiles, [17] trap marks so far, [18] reservation slots a
/// tile, [19] reservation room (pairs), [20] the journal's length, [21] the
/// trap marks' room.
/// Header: [0] walls, [1] adjacency flags set, [2] their digest's change,
/// [3] the lowest set (or -1), [4] the work checksum's change, [5] trap marks
/// now (-1: past the room, all), [6] journal end, [7] reservations listed,
/// [8] tiles destroyed, [9] rows retired.
///
/// Rows (the class tables', data_state.js _sTableOf): out [28] (class code
/// (ctab), row) pairs and [29] the tiles destroyed, in the list's order; per
/// class j < P[24] (ctab j + 1): [30 + 6j] ret, [31 + 6j] rt, [32 + 6j] rp,
/// [33 + 6j] rn (the retire queue), [34 + 6j] its header (head, tail,
/// length), [35 + 6j] the _stT column. A destroyed structure's row retires
/// at tick P[22] (_sRowQueueInsert) and its _stT becomes -1. P[23] 1: only
/// those out of energy (val <= 0).
#[no_mangle]
pub unsafe extern "C" fn k_struct_destroy(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let tl = k.p::<i32>(0);
    let (code, own, uc, val, tim, brain) = (k.p::<u8>(1), k.p::<i32>(2), k.p::<u8>(3), k.p::<f64>(4), k.p::<f64>(5), k.p::<i32>(6));
    let (rtab, stab, rrow, ctab, rcnt, cnt) = (k.p::<u8>(7), k.p::<u8>(8), k.p::<i32>(9), k.p::<u8>(10), k.p::<u8>(11), k.p::<u8>(12));
    let (ctype, cown) = (k.p::<u8>(13), k.p::<i8>(14));
    let (aflag, ablk) = (k.p::<u8>(15), k.p::<i32>(16));
    let wver = k.p::<i32>(17);
    let tel = k.p::<u32>(18);
    let (mvs, mcls, mblk) = (k.p::<i8>(19), k.p::<i8>(20), k.p::<i32>(21));
    let tdirty = k.p::<i32>(22);
    let resv = k.p::<i32>(23);
    let (hdr, walls, rout, ocnt) = (k.p::<i32>(24), k.p::<i32>(25), k.p::<i32>(26), k.p::<i32>(27));
    let n = k.i(0).max(0) as usize;
    let (w, h, rt, rw) = (k.i(1), k.i(2), k.i(3).max(1), k.i(4));
    let (twall, tfloor) = (k.i(5) as u8, k.i(6) as u8);
    let alen = k.i(7).max(0);
    let (wnp, wnt, wrw, wrh, wrt) = (k.i(8), k.i(9), k.i(10), k.i(11), k.i(12).max(1));
    let mut tend = k.i(13) as u32;
    let tmask = if tel.is_null() { 0 } else { (k.i(20).max(1) as u32) - 1 };
    let (mnp, mbc, mbt) = (k.i(14), k.i(15), k.i(16).max(1));
    let mut nd = k.i(17);
    let tdn = k.i(21);
    let (rpt, rroom) = (k.i(18).max(0), k.i(19).max(0));
    let (rows, dtl) = (k.p::<i32>(28), k.p::<i32>(29));
    let (tick, dead_only, ncls) = (k.i(22), k.i(23) != 0, k.i(24).max(0));
    let mut nret = 0i32;
    let (mut nw, mut na, mut asum, mut amin, mut wsum, mut nr, mut nk) = (0usize, 0i32, 0i32, -1i32, 0i32, 0i32, 0i32);
    for o in 0..64 {
        s(ocnt, o, 0);
    }
    for i in 0..n {
        let t = g(tl, i);
        if t < 0 || t >= w * h {
            continue;
        }
        let tu = t as usize;
        let c = g(code, tu);
        // (Mines are never destroyed here; an empty tile was destroyed already.)
        if g(ctab, tu) == 0 || c >= 0x66 {
            continue;
        }
        if dead_only && !(g(val, tu) <= 0.0) {
            continue;
        }
        // Its row: retired (kept readable till its expiry), off its tile.
        let (ct, row) = (g(ctab, tu) as i32, g(rrow, tu));
        if !rows.is_null() {
            s(rows, (nk * 2) as usize, ct);
            s(rows, (nk * 2 + 1) as usize, row);
        }
        if !dtl.is_null() {
            s(dtl, nk as usize, t);
        }
        let j = ct - 1;
        if row >= 0 && j < ncls && k.raw(30 + 6 * j as usize) != 0 {
            let b = 30 + 6 * j as usize;
            let (ret, rtk, rp, rn, qh) = (k.p::<u8>(b), k.p::<i32>(b + 1), k.p::<i32>(b + 2), k.p::<i32>(b + 3), k.p::<i32>(b + 4));
            let st = k.p::<i32>(b + 5);
            let r = row as usize;
            if g(ret, r) == 0 {
                // (In tick order from the tail: _sRowQueueInsert.)
                let mut p = g(qh, 1);
                while p >= 0 && g(rtk, p as usize) > tick {
                    p = g(rp, p as usize);
                }
                let nx = if p < 0 { g(qh, 0) } else { g(rn, p as usize) };
                s(rp, r, p);
                s(rn, r, nx);
                if p < 0 { s(qh, 0, row); } else { s(rn, p as usize, row); }
                if nx < 0 { s(qh, 1, row); } else { s(rp, nx as usize, row); }
                s(ret, r, 1);
                s(rtk, r, tick);
                s(qh, 2, g(qh, 2) + 1);
                nret += 1;
            }
            if !st.is_null() {
                s(st, r, -1);
            }
        }
        nk += 1;
        let (gx, gy) = (irem(t, w), idiv(t, w));
        let owner = g(own, tu);
        // The table's entry.
        if c != 0 {
            let r = (idiv(gy, rt) * rw + idiv(gx, rt)) as usize;
            s(rcnt, r, g(rcnt, r).wrapping_sub(1));
        }
        let cc = g(cnt, tu);
        if cc != 0 {
            let o = cc as usize - 1;
            s(ocnt, o, g(ocnt, o) - 1);
            s(cnt, tu, 0);
        }
        s(code, tu, 0); s(own, tu, 0); s(uc, tu, 0); s(val, tu, 0.0); s(tim, tu, 0.0); s(brain, tu, 0);
        s(rtab, tu, 0); s(stab, tu, 0); s(rrow, tu, -1); s(ctab, tu, 0);
        // Its cell: no owner; a wall (a tower) ground again.
        s(cown, tu, -1);
        if g(ctype, tu) == twall {
            s(ctype, tu, tfloor);
            s(walls, nw, t);
            nw += 1;
        }
        // The journal.
        if !tel.is_null() {
            s(tel, (tend & tmask) as usize, t as u32);
            tend = tend.wrapping_add(1);
        }
        // Workers of the owner (none: every player) near it look again.
        if !wver.is_null() {
            let reg = 1 + idiv(gy, wrt).min(wrh - 1) * wrw + idiv(gx, wrt).min(wrw - 1);
            let (p0, p1) = if owner == ST_OWNER_NONE || owner < 0 { (0, wnp) } else { (owner, owner + 1) };
            let mut p = p0;
            while p < p1 && p < wnp {
                let wi = (p * wnt) * (1 + wrw * wrh) + reg;
                s(wver, wi as usize, g(wver, wi as usize).wrapping_add(1));
                wsum = wsum.wrapping_add(((wi + 1) ^ 0x9e3779b9u32 as i32).wrapping_mul(2654435761u32 as i32));
                p += 1;
            }
        }
        // Adjacency: the tile and its neighbours worked out again.
        if !aflag.is_null() {
            for y in (gy - 1).max(0)..=(gy + 1).min(h - 1) {
                for x in (gx - 1).max(0)..=(gx + 1).min(w - 1) {
                    let q = y * w + x;
                    if q >= alen || g(aflag, q as usize) != 0 {
                        continue;
                    }
                    s(aflag, q as usize, 1);
                    s(ablk, (q >> 8) as usize, g(ablk, (q >> 8) as usize) + 1);
                    na += 1;
                    asum = asum.wrapping_add((q + 1).wrapping_mul(2654435761u32 as i32));
                    if amin < 0 || q < amin {
                        amin = q;
                    }
                }
            }
        }
        // The movement kernel's structure code and class, its blocks' counts.
        if !mvs.is_null() {
            let old = g(mvs, tu) as i32;
            if old != -1 && !mblk.is_null() {
                let b = (idiv(gy, mbt) * mbc + idiv(gx, mbt)) * mnp;
                for p in 0..mnp {
                    if old != p {
                        s(mblk, (b + p) as usize, g(mblk, (b + p) as usize) - 1);
                    }
                }
            }
            s(mvs, tu, -1);
            if !mcls.is_null() {
                s(mcls, tu, 0);
            }
        }
        if !tdirty.is_null() && nd >= 0 {
            if nd < tdn { s(tdirty, nd as usize, t); nd += 1; } else { nd = -1; }
        }
        // The reservations held there (released by the caller).
        if !resv.is_null() {
            for j in 0..rpt {
                let sl = t * rpt + j;
                let id = g(resv, sl as usize);
                if id > 0 && nr < rroom {
                    s(rout, (nr * 2) as usize, sl);
                    s(rout, (nr * 2 + 1) as usize, id);
                    nr += 1;
                }
            }
        }
    }
    s(hdr, 0, nw as i32);
    s(hdr, 1, na);
    s(hdr, 2, asum);
    s(hdr, 3, amin);
    s(hdr, 4, wsum);
    s(hdr, 5, nd);
    s(hdr, 6, tend as i32);
    s(hdr, 7, nr);
    s(hdr, 8, nk);
    s(hdr, 9, nret);
}
