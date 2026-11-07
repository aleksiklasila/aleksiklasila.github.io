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

/// The retire pass's decisions (main.js _gameTickBody, after the retire
/// kernel's lists): the listed units in its order (blocks from the last,
/// each from its last entry), from the columns: a slotted unit not dead
/// passed over; a dead one into the order out (index, slot) and the gone
/// list (its slot, ~slot when removed already: removeUnitNow); its death
/// sound (the first P[3] of units neither removed, workers nor kings) and
/// whether a king died; an entry without a slot into the order with slot
/// -1 (the JavaScript decides). Arrays: [0] retire list, [1] counts per
/// block, [2] the slot map (by list index), [3] unit.dead, [4] unit.jRmNow,
/// [5] unit.wkS, [6] unit.spType, [7] order out (pairs), [8] gone out, [9]
/// sounds out (slots), [10] hdr out ([0] order pairs, [1] gone, [2] sounds,
/// [3] a king died). P: [0] blocks, [1] block size, [2] the king's spatial
/// type (-1 none), [3] sounds at most.
#[no_mangle]
pub unsafe extern "C" fn k_retire_plan(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (list, cnt, sl, dead, rm, wks, spt) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<u8>(3), k.p::<u8>(4), k.p::<u32>(5), k.p::<i16>(6));
    let (ord, gone, snd, hdr) = (k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9), k.p::<i32>(10));
    let (blocks, bs, king, maxs) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2), k.i(3).max(0) as usize);
    let (mut no, mut ng, mut ns, mut kd) = (0usize, 0usize, 0usize, 0i32);
    for b in (0..blocks).rev() {
        let c = g(cnt, b).max(0) as usize;
        for j in (0..c).rev() {
            let i = g(list, b * bs + j);
            let q = g(sl, i as usize);
            if q < 0 {
                s(ord, 2 * no, i);
                s(ord, 2 * no + 1, -1);
                no += 1;
                continue;
            }
            let qu = q as usize;
            if g(dead, qu) == 0 {
                continue;
            }
            s(ord, 2 * no, i);
            s(ord, 2 * no + 1, q);
            no += 1;
            if g(rm, qu) != 0 {
                s(gone, ng, !q);
                ng += 1;
                continue;
            }
            let ws = g(wks, qu) & 31;
            let is_king = king >= 0 && g(spt, qu) as i32 == king;
            if ns < maxs && (ws == 0 || ws == 14) && !is_king {
                s(snd, ns, q);
                ns += 1;
            }
            if is_king {
                kd = 1;
            }
            s(gone, ng, q);
            ng += 1;
        }
    }
    s(hdr, 0, no as i32);
    s(hdr, 1, ng as i32);
    s(hdr, 2, ns as i32);
    s(hdr, 3, kd);
}

/// A value written into a unit column as JavaScript's typed array store
/// would: kind 2 an f32, 3 an f64, else an integer of the column's width
/// (truncated, two's complement; not finite: 0).
#[inline(always)]
unsafe fn spawn_put(tab: *const i32, kind: *const i32, c: usize, q: usize, v: f64) {
    let base = waddr(g(tab, 3 * c) as u32) as *mut u8;
    let (bytes, per) = (g(tab, 3 * c + 1) as usize, g(tab, 3 * c + 2) as usize);
    let at = base.add(q * per * bytes);
    let iv = if v.is_finite() { v as i64 } else { 0 };
    match (g(kind, c), bytes) {
        (2, 4) => *(at as *mut f32) = v as f32,
        (3, 8) => *(at as *mut f64) = v,
        (_, 1) => *at = iv as u8,
        (_, 2) => *(at as *mut u16) = iv as u16,
        (_, 4) => *(at as *mut u32) = iv as u32,
        _ => {}
    }
}
/// n program triples from triple `at` (column, source: below 0 the triple's
/// value, else the row's value at that index; value) written to slot q.
#[inline(always)]
unsafe fn spawn_prog(prog: *const f64, at: usize, n: usize, row: *const f64, tab: *const i32, kind: *const i32, q: usize) {
    for t in 0..n {
        let e = prog.add((at + t) * 3);
        let src = g(e, 1);
        let v = if src < 0.0 { g(e, 2) } else { g(row, src as usize) };
        spawn_put(tab, kind, g(e, 0) as usize, q, v);
    }
}

/// SIM_KERNEL_SPAWN_WRITE (unit.js simSpawnBatchWrite): a step's new units'
/// columns, a row each (their slots differ: any job order): the values every
/// new unit gets (the core program), its stat template's (its own program),
/// then its energy (the final program). At a million units every column of
/// a slot is a cache miss: ~40 a spawn, spread over the helpers here. Arrays:
/// [0] spw.rows (f64, P[2] a row: slot, its template's first triple, its
/// triples (below 0: the row was written already), then the row's values),
/// [1] slz.tab (per column: encoded address, bytes an element, elements a
/// slot), [2] spw.kind (per column: 1 an integer, 2 an f32, 3 an f64), [3]
/// spw.prog (f64 triples). P: [0] rows, [1] per job, [2] row stride, [3]
/// core program's first triple, [4] its triples, [5] final program's first
/// triple, [6] its triples.
#[no_mangle]
pub unsafe extern "C" fn k_spawn_write(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (rows, tab, kind, prog) = (k.p::<f64>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<f64>(3));
    let (j0, j1) = super::k::job_range(chunk, k.i(1), k.i(0));
    let w = k.i(2).max(1) as usize;
    let (c0, cn, f0, fnn) = (k.i(3).max(0) as usize, k.i(4).max(0) as usize, k.i(5).max(0) as usize, k.i(6).max(0) as usize);
    for j in j0..j1 {
        let row = rows.add(j * w) as *const f64;
        let pn = g(row, 2);
        if pn < 0.0 {
            continue;
        }
        let q = g(row, 0) as usize;
        spawn_prog(prog, c0, cn, row, tab, kind, q);
        spawn_prog(prog, g(row, 1) as usize, pn as usize, row, tab, kind, q);
        spawn_prog(prog, f0, fnn, row, tab, kind, q);
    }
}

/// SIM_KERNEL_SLOT_ZERO (sim_unit_state.js simUnitStateReleaseFreed): the
/// slots let go this tick back to a fresh slot's state before any unit takes
/// one (every unit column zero, sepKey absent, sepLayer zero), so taking a
/// slot needs no clearing. Arrays: [0] slz.list (slots), [1] slz.tab (per
/// column: encoded address, bytes an element, elements a slot), [2]
/// unit.sepKey, [3] unit.sepLayer. P: [0] slots, [1] per job, [2] columns,
/// [3] SIM_SEP_ABSENT.
#[no_mangle]
pub unsafe extern "C" fn k_slot_zero(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (list, tab, sk, sly, defs) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<u32>(2), k.p::<u8>(3), k.p::<f64>(4));
    let (j0, j1) = super::k::job_range(chunk, k.i(1), k.i(0));
    let nc = k.i(2).max(0) as usize;
    let absent = k.i(3) as u32;
    // (No list: the slots P[4] + j, a growth's new range.)
    let from = k.i(4);
    // One column at a time: keep its metadata/default outside the slot loop
    // and write a typed scalar for the usual one-element columns. The old
    // slot-major loop repeatedly visited hundreds of unrelated cache lines
    // and called a variable-size memset for every scalar.
    for c in 0..nc {
        let base = waddr(g(tab, 3 * c) as u32) as *mut u8;
        let (bytes, per) = (g(tab, 3 * c + 1) as usize, g(tab, 3 * c + 2) as usize);
        let (kind, v) = if defs.is_null() { (0, 0.0) } else { (g(defs, 2 * c) as i32, g(defs, 2 * c + 1)) };
        let value = match (kind, bytes) {
            (1, _) => v as i64 as u64,
            (2, 4) => (v as f32).to_bits() as u64,
            (3, 8) => v.to_bits(),
            _ => 0,
        };
        macro_rules! clear_column {
            ($ty:ty) => {{
                let p = base as *mut $ty;
                let value = value as $ty;
                for j in j0..j1 {
                    let q = if list.is_null() { from + j as i32 } else { g(list, j) };
                    if q < 0 { continue; }
                    let at = p.add(q as usize * per);
                    if per > 1 { core::ptr::write_bytes(at, 0, per); }
                    *at = value;
                }
            }};
        }
        match bytes {
            1 => clear_column!(u8),
            2 => clear_column!(u16),
            4 => clear_column!(u32),
            8 => clear_column!(u64),
            _ => {}
        }
    }
    for j in j0..j1 {
        let q = if list.is_null() { from + j as i32 } else { g(list, j) };
        if q < 0 { continue; }
        let q = q as usize;
        s(sk, q, absent);
        s(sly, q, 0);
    }
}

/// SIM_KERNEL_SLOT_MOVE (sim_unit_state.js simUnitStateRelayoutStep): units
/// moved to other slots between ticks. Per pair (from, to) every unit column
/// is copied from -> to and `from` left as a fresh slot (zero and the
/// defaults, as k_slot_zero leaves it), the separation's key and layer and
/// the occupancy's footprint record (4 words a slot) too. The pairs' slots
/// are all different (to: free slots; from: units'), so jobs are independent.
/// Arrays: [0] rl.pairs (from, to), [1] slz.tab, [2] unit.sepKey, [3]
/// unit.sepLayer, [4] slz.defs, [5] occ.rec (optional), [6] unit.hslot (per
/// handle its slot: a moved unit's handle, unit.hnd [7], moved with the
/// columns, names its new slot). P: [0] pairs, [1] per job, [2] columns, [3]
/// SIM_SEP_ABSENT.
#[no_mangle]
pub unsafe extern "C" fn k_slot_move(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (pairs, tab, sk, sly, defs, rec) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<u32>(2), k.p::<u8>(3), k.p::<f64>(4), k.p::<i32>(5));
    let (hsl, hnd) = (k.p::<i32>(6), k.p::<i32>(7));
    // (The forward map, stamped by the step (P[4]: never cleared); the new
    // slot's presentation mark reset (unit.pvS: its next frame by changes
    // fills it).)
    let (fwd, fst, pvs) = (k.p::<i32>(8), k.p::<i32>(9), k.p::<u32>(10));
    // (A bit a moved slot, [15]: the remap's first test.)
    let mbits = k.p::<u32>(15);
    let stamp = k.i(4);
    // (The id index's table (slots by id's hash, -1 empty: main.js
    // UnitIdIndex; P[5] its length, a power of two) and the id table (ids
    // ascending [13], their slots [14]; P[6] rows): the moved unit's entry,
    // found by its id (read at its new slot, after the columns).)
    let (uid, idc, uids, uixs) = (k.p::<i32>(11), k.p::<i32>(12), k.p::<i32>(13), k.p::<i32>(14));
    let (ulen, rows) = (k.i(5).max(0) as u32, k.i(6).max(0) as usize);
    if pairs.is_null() || tab.is_null() {
        return;
    }
    let (j0, j1) = super::k::job_range(chunk, k.i(1), k.i(0));
    let nc = k.i(2).max(0) as usize;
    let absent = k.i(3) as u32;
    // (Column by column, as k_slot_zero: a column's lines of a slab's slots
    // are shared by the pairs that come from it.)
    for c in 0..nc {
        let base = waddr(g(tab, 3 * c) as u32) as *mut u8;
        let (bytes, per) = (g(tab, 3 * c + 1) as usize, g(tab, 3 * c + 2) as usize);
        let (kind, v) = if defs.is_null() { (0, 0.0) } else { (g(defs, 2 * c) as i32, g(defs, 2 * c + 1)) };
        let value = match (kind, bytes) {
            (1, _) => v as i64 as u64,
            (2, 4) => (v as f32).to_bits() as u64,
            (3, 8) => v.to_bits(),
            _ => 0,
        };
        macro_rules! move_column {
            ($ty:ty) => {{
                let p = base as *mut $ty;
                let value = value as $ty;
                // (Element by element: memory.copy / memory.fill per column and
                // unit are runtime calls, most of the step's time.)
                if per == 1 {
                    for j in j0..j1 {
                        let (f, t) = (g(pairs, 2 * j), g(pairs, 2 * j + 1));
                        if f < 0 || t < 0 { continue; }
                        let (src, dst) = (p.add(f as usize), p.add(t as usize));
                        *dst = *src;
                        *src = value;
                    }
                } else {
                    for j in j0..j1 {
                        let (f, t) = (g(pairs, 2 * j), g(pairs, 2 * j + 1));
                        if f < 0 || t < 0 { continue; }
                        let (src, dst) = (p.add(f as usize * per), p.add(t as usize * per));
                        for e in 0..per { *dst.add(e) = *src.add(e); *src.add(e) = 0 as $ty; }
                        *src = value;
                    }
                }
            }};
        }
        match bytes {
            1 => move_column!(u8),
            2 => move_column!(u16),
            4 => move_column!(u32),
            8 => move_column!(u64),
            _ => {}
        }
    }
    for j in j0..j1 {
        let (f, t) = (g(pairs, 2 * j), g(pairs, 2 * j + 1));
        if f < 0 || t < 0 { continue; }
        let (f, t) = (f as usize, t as usize);
        if !sk.is_null() { s(sk, t, g(sk, f)); s(sk, f, absent); }
        if !sly.is_null() { s(sly, t, g(sly, f)); s(sly, f, 0); }
        if !rec.is_null() {
            for w in 0..4 { s(rec as *mut i32, 4 * t + w, g(rec, 4 * f + w)); s(rec as *mut i32, 4 * f + w, 0); }
        }
        if !hsl.is_null() && !hnd.is_null() { let h = g(hnd, t); if h > 0 { s(hsl, h as usize, t as i32); } }
        if !fwd.is_null() && !fst.is_null() { s(fwd, f, t as i32); s(fst, f, stamp); }
        if !mbits.is_null() { (*(mbits.add(f as usize >> 5) as *const core::sync::atomic::AtomicU32)).fetch_or(1u32 << (f & 31), core::sync::atomic::Ordering::Relaxed); }
        if !pvs.is_null() { s(pvs, t, 0); }
        if !idc.is_null() {
            let id = g(idc, t);
            if !uid.is_null() && ulen > 0 {
                let mask = ulen - 1;
                let mut h = (id as u32).wrapping_mul(2654435761u32) & mask;
                for _ in 0..ulen { let v = g(uid, h as usize); if v == -1 { break; } if v == f as i32 { s(uid, h as usize, t as i32); break; } h = (h + 1) & mask; }
            }
            if !uids.is_null() && !uixs.is_null() && rows > 0 {
                let (mut lo, mut hi) = (0usize, rows);
                while lo < hi { let m = (lo + hi) >> 1; if g(uids, m) < id { lo = m + 1; } else { hi = m; } }
                if lo < rows && g(uids, lo) == id && g(uixs, lo) == f as i32 { s(uixs, lo, t as i32); }
            }
        }
    }
}

/// SIM_KERNEL_SLOT_REMAP (after SIM_KERNEL_SLOT_MOVE): every slot's
/// references to units by slot that moved follow them: the target unit
/// (tuS), the combat brain's target (cmT, a unit's slot unless cmMode has 16:
/// a structure's tile) and the pending wheel's links (ppNext, ppPrev); the
/// id table's slots (ix.slots, by row: -1 / -2 none); and, in the same pass,
/// the slabs' scores for the next step (as SIM_KERNEL_SLAB_SCORE).
/// Arrays: [0] rl.fwd (per slot its new slot, -1 not moved), [1] unit.tuS,
/// [2] unit.cmT, [3] unit.cmMode, [4] unit.ppNext, [5] unit.ppPrev, [6]
/// ix.slots, [7] unit.live, [8] unit.dead, [9] unit.x, [10] unit.y, [11]
/// rl.home, [12] rl.score, [13] the id index's table (main.js UnitIdIndex.t:
/// slots, -1 empty), [14] the order queue's ring (ord.ring), [15] the
/// pending wheel's heads. P: [0] the range the jobs cover, [1] per job (a
/// multiple of 64), [2] rl.fwd's length, [3] the id table's rows (0: not
/// remapped), [4] / [5] blocks across / down, [6] a block's width in eighths,
/// [7] slabs to score (0: none), [8] the id index's table length, [9] slots,
/// [10] the ring's used length, [11] the wheel's heads.
#[no_mangle]
pub unsafe extern "C" fn k_slot_remap(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (fwd, tu, cm, cmm, pn, pp) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<u8>(3), k.p::<i32>(4), k.p::<i32>(5));
    if fwd.is_null() {
        return;
    }
    let (s0, s1) = super::k::job_range(chunk, k.i(1), k.i(0));
    let fl = k.i(2).max(0);
    let (fst, stamp) = (k.p::<i32>(16), k.i(12));
    if fst.is_null() { return; }
    // (The moved slots' bits first, [17] (a 144 KB table at 1M slots: in cache), the forward map only for them.)
    let mbits = k.p::<u32>(17);
    let map = |v: i32| -> i32 { if v >= 0 && v < fl && (mbits.is_null() || g(mbits, v as usize >> 5) & (1u32 << (v & 31)) != 0) && g(fst, v as usize) == stamp { g(fwd, v as usize) } else { v } };
    let ns = k.i(9).max(0) as usize;
    // (By runs of slabs with units ([18] sl.sfree, P[13] its slabs: an empty
    // slab's slots hold no unit, their references are read by none).)
    let (sfree, nsl) = (k.p::<u8>(18), k.i(13).max(0) as usize);
    let per_slot = |r0: usize, r1: usize| {
        for q in r0..r1 {
            if !tu.is_null() { let v = g(tu, q); let m = map(v); if m != v { s(tu as *mut i32, q, m); } }
            if !cm.is_null() && !cmm.is_null() && (g(cmm, q) & 16) == 0 { let v = g(cm, q); let m = map(v); if m != v { s(cm as *mut i32, q, m); } }
            if !pn.is_null() { let v = g(pn, q); let m = map(v); if m != v { s(pn as *mut i32, q, m); } }
            if !pp.is_null() { let v = g(pp, q); let m = map(v); if m != v { s(pp as *mut i32, q, m); } }
        }
    };
    let e = s1.min(ns);
    if s0 < e {
        if sfree.is_null() || nsl == 0 { per_slot(s0, e); } else { super::k::slab_runs(sfree, nsl, s0, e, |r0, r1, empty| if !empty { per_slot(r0, r1); }); }
    }
    let rows = k.i(3).max(0) as usize;
    let ix = k.p::<i32>(6);
    if !ix.is_null() && s0 < rows {
        for r in s0..s1.min(rows) { let v = g(ix, r); let m = map(v); if m != v { s(ix as *mut i32, r, m); } }
    }
    // (The id index's table, the order queue's ring, the wheel's heads: slots by value.)
    for (arr, len) in [(k.p::<i32>(13), k.i(8)), (k.p::<i32>(14), k.i(10)), (k.p::<i32>(15), k.i(11))] {
        let len = len.max(0) as usize;
        if arr.is_null() || s0 >= len { continue; }
        for r in s0..s1.min(len) { let v = g(arr, r); let m = map(v); if m != v { s(arr, r, m); } }
    }
    let slabs = k.i(7).max(0) as usize;
    let (live, dead, xs, ys, home, out) = (k.p::<u8>(7), k.p::<u8>(8), k.p::<i32>(9), k.p::<i32>(10), k.p::<i32>(11), k.p::<i32>(12));
    if slabs > 0 && !live.is_null() && !out.is_null() {
        slab_scores(live, dead, xs, ys, home, out, s0 / 64, ((s1 + 63) / 64).min(slabs), k.i(4).max(1), k.i(5).max(1), k.i(6).max(1), sfree, nsl);
    }
}

/// Slabs b0..b1's scores: per slab its living units (live, not dead) and how
/// many of them stand in its home block.
unsafe fn slab_scores(live: *const u8, dead: *const u8, xs: *const i32, ys: *const i32, home: *const i32, out: *mut i32, b0: usize, b1: usize, kw: i32, kh: i32, bw: i32, sfree: *const u8, nsl: usize) {
    for b in b0..b1 {
        // (An empty slab (the allocator's free count 64): none.)
        if !sfree.is_null() && b < nsl && g(sfree, b) >= 64 { s(out, 2 * b, 0); s(out, 2 * b + 1, 0); continue; }
        let h = g(home, b);
        let (mut n, mut at) = (0i32, 0i32);
        for q in b * 64..b * 64 + 64 {
            if g(live, q) == 0 || g(dead, q) != 0 { continue; }
            n += 1;
            let (x, y) = (g(xs, q), g(ys, q));
            if x < 0 || y < 0 { continue; }
            let key = (y / bw).min(kh - 1) * kw + (x / bw).min(kw - 1);
            if key == h { at += 1; }
        }
        s(out, 2 * b, n);
        s(out, 2 * b + 1, at);
    }
}

/// The relayout's planner (sim_unit_state.js simUnitStateRelayoutStep; one
/// job on the simulation thread, simRustDirect): from the slabs' scores
/// (rl.score: per slab its living units, and those standing in its block),
/// the slabs to empty this step and where each unit goes, the allocator's
/// books brought up to date (the new slots taken, the old ones free and
/// fresh, emptied slabs at the end given up, the lists made again). Picks,
/// cheapest first (a counting sort by living units), within P[5] units:
/// the slabs past the slabs in use and a 1/2^P[6] more, with an empty slab
/// below (whole into the lowest empty slab, same offsets and block), the
/// drifted ones (most of their units out of their block; any under P[8]
/// stress by step parity P[9]), and a block's slabs at or below its mean
/// while it holds more than its units need. A unit goes to a hole of a slab
/// of the block it stands in (its current slab, then the block's others),
/// else the lowest empty slab (given to its block); none below its limit:
/// its slab's rest stays. Only slabs whose every slot holds a living unit.
/// Arrays: [0] sfree (u8), [1] home, [2] bits (free), [3] used, [4] ever,
/// [5] cur (per block), [6] rl.score, [7] unit.live, [8] unit.dead, [9]
/// unit.x, [10] unit.y, [11] rl.pairs (out: from, to), [12] scratch (i32:
/// see below), [13] heads, [14] entries, [15] the header (out: [0] pairs,
/// [1] slabs after, [2] the lists' entries, [3] slabs given up, [4] slabs
/// picked). P: [0] slabs, [1] blocks (with the no-place one), [2] / [3]
/// blocks across / down, [4] a block's width in eighths, [5] the units'
/// budget, [6] slack shift, [7] slab limit (an acquisition run in flight),
/// [8] stress, [9] the step's parity, [10] pairs' room, [11] scratch words.
#[no_mangle]
pub unsafe extern "C" fn k_relayout_plan(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (sfree, home, bits, used, ever, cur) = (k.p::<u8>(0), k.p::<i32>(1), k.p::<u32>(2), k.p::<u32>(3), k.p::<u32>(4), k.p::<i32>(5));
    let (sc, live, dead, xs, ys, pairs) = (k.p::<i32>(6), k.p::<u8>(7), k.p::<u8>(8), k.p::<i32>(9), k.p::<i32>(10), k.p::<i32>(11));
    let (scr, heads, entries, hdr) = (k.p::<i32>(12), k.p::<i32>(13), k.p::<i32>(14), k.p::<i32>(15));
    for i in 0..5 { s(hdr, i, 0); }
    let nsl = k.i(0).max(0) as usize;
    let nk = k.i(1).max(1) as usize;
    let (kw, kh, bw) = (k.i(2).max(1), k.i(3).max(1), k.i(4).max(1));
    let budget = k.i(5).max(0) as usize;
    let shift = k.i(6).clamp(0, 30);
    let slab_limit = (k.i(7).max(0) as usize).min(nsl);
    let stress = k.i(8) != 0;
    let parity = k.i(9) as usize;
    let room = k.i(10).max(0) as usize;
    let words = k.i(11).max(0) as usize;
    s(hdr, 1, nsl as i32);
    // Scratch: per block its slabs, living units, picked slabs, holes' list
    // offsets and cursors (5 nk + 1); per slab: the empty ones, the order,
    // the evicted flags, the holes' list, the picks (3 a slab) (7 nsl).
    if nsl < 2 || words < 5 * nk + 1 + 7 * nsl || sfree.is_null() || pairs.is_null() { s(hdr, 1, nsl as i32); return; }
    let hs = scr; let hl = scr.add(nk); let he = scr.add(2 * nk); let hoff = scr.add(3 * nk); let hcur = scr.add(4 * nk + 1);
    let empty = scr.add(5 * nk + 1); let ord = empty.add(nsl); let ev = ord.add(nsl); let hlist = ev.add(nsl); let pick = hlist.add(nsl);
    for i in 0..3 * nk { s(scr, i, 0); }
    for b in 0..nsl { s(ev, b, 0); }
    let mut lives = 0usize; let mut en = 0usize;
    for b in 0..nsl {
        let f = g(sfree, b) as usize;
        if f == 64 { s(empty, en, b as i32); en += 1; continue; }
        let lv = g(sc, 2 * b).max(0);
        lives += lv as usize;
        let h = g(home, b);
        if h >= 0 && (h as usize) < nk - 1 { let h = h as usize; s(hs, h, g(hs, h) + 1); s(hl, h, g(hl, h) + lv); }
    }
    let used_slabs = nsl - en;
    let tail_from = used_slabs + (used_slabs >> shift) + 1;
    let low_empty = if en > 0 { g(empty, 0) as usize } else { nsl };
    let need = |h: usize| -> i32 { (g(hl, h) + 63) / 64 };
    // A slab's place in the sort: -1 none, 0 the tail's, else its cost; and its drift flag.
    let class = |b: usize| -> (i32, bool) {
        let cost = g(sc, 2 * b);
        if cost <= 0 || 64 - g(sfree, b) as i32 != cost { return (-1, false); }
        let h = g(home, b);
        let tail = b >= tail_from && low_empty < b;
        let drift = (stress && ((b ^ parity) & 1) == 0) || 2 * g(sc, 2 * b + 1) < cost || h < 0 || h as usize >= nk - 1 || tail;
        if !drift { let h = h as usize; if !(g(hs, h) > need(h) && cost * g(hs, h) <= g(hl, h)) { return (-1, false); } }
        (if tail { 0 } else { cost }, drift)
    };
    let mut cnt = [0usize; 66];
    for b in 0..nsl { let (c, _) = class(b); if c >= 0 { cnt[c as usize + 1] += 1; } }
    for c in 1..66 { cnt[c] += cnt[c - 1]; }
    let mut nc = 0usize;
    for b in (0..nsl).rev() {
        let (c, drift) = class(b);
        if c < 0 { continue; }
        let at = cnt[c as usize]; cnt[c as usize] += 1;
        s(ord, at, (b as i32) | if drift { 0x4000_0000 } else { 0 } | if c == 0 { 0x2000_0000 } else { 0 });
        nc += 1;
    }
    let (mut picked, mut moves) = (0usize, 0usize);
    for i in 0..nc {
        if moves >= budget { break; }
        let o = g(ord, i);
        let b = (o & 0x1fff_ffff) as usize; let drift = o & 0x4000_0000 != 0; let tail = o & 0x2000_0000 != 0;
        let h = g(home, b); let cost = g(sc, 2 * b) as usize;
        if !drift { let hu = h as usize; if g(hs, hu) - g(he, hu) <= need(hu) { continue; } }
        if moves + cost > room { break; }
        s(ev as *mut i32, b, 1);
        let lim = slab_limit.min(if tail { tail_from } else { nsl });
        s(pick, 3 * picked, b as i32); s(pick, 3 * picked + 1, lim as i32); s(pick, 3 * picked + 2, tail as i32);
        picked += 1; moves += cost;
        if h >= 0 && (h as usize) < nk - 1 { let hu = h as usize; s(he, hu, g(he, hu) + 1); }
    }
    s(hdr, 4, picked as i32);
    if picked == 0 { return; }
    // The slabs with holes by block (none evicted, none empty), for the destinations.
    for i in 0..nk + 1 { s(hoff, i, 0); }
    for b in 0..nsl { let f = g(sfree, b); if f == 0 || f == 64 || g(ev, b) != 0 { continue; } let h = g(home, b); if h < 0 || h as usize >= nk { continue; } let hu = h as usize + 1; s(hoff, hu, g(hoff, hu) + 1); }
    for i in 1..nk + 1 { s(hoff, i, g(hoff, i) + g(hoff, i - 1)); }
    for i in 0..nk { s(hcur, i, g(hoff, i)); }
    for b in 0..nsl { let f = g(sfree, b); if f == 0 || f == 64 || g(ev, b) != 0 { continue; } let h = g(home, b); if h < 0 || h as usize >= nk { continue; } let hu = h as usize; let p = g(hcur, hu); s(hlist, p as usize, b as i32); s(hcur, hu, p + 1); }
    for i in 0..nk { s(hcur, i, g(hoff, i)); }
    // (A slot of slab c taken: the lowest free.)
    let take = |c: usize| -> usize {
        let w = 2 * c; let mut bb = g(bits, w);
        let q = if bb != 0 { let q = c * 64 + bb.trailing_zeros() as usize; s(bits, w, bb & (bb - 1)); q }
            else { bb = g(bits, w + 1); let q = c * 64 + 32 + bb.trailing_zeros() as usize; s(bits, w + 1, bb & (bb - 1)); q };
        s(sfree, c, g(sfree, c) - 1);
        q
    };
    let mut ea = 0usize;
    let mut n = 0usize;
    for p in 0..picked {
        let b = g(pick, 3 * p) as usize; let lim = g(pick, 3 * p + 1) as usize; let tail = g(pick, 3 * p + 2) != 0;
        if tail {
            // Whole into the lowest empty slab below.
            let mut e = usize::MAX;
            while ea < en { let c = g(empty, ea) as usize; ea += 1; if g(sfree, c) == 64 && g(ev, c) == 0 { e = c; break; } }
            if e == usize::MAX || e >= lim { continue; }
            s(home, e, g(home, b));
            for q in b * 64..b * 64 + 64 {
                if g(live, q) != 1 || g(dead, q) != 0 { continue; }
                let to = e * 64 + (q - b * 64);
                s(bits, to >> 5, g(bits, to >> 5) & !(1u32 << (to & 31))); s(sfree, e, g(sfree, e) - 1);
                s(pairs, 2 * n, q as i32); s(pairs, 2 * n + 1, to as i32); n += 1;
            }
            continue;
        }
        for q in b * 64..b * 64 + 64 {
            if g(live, q) != 1 || g(dead, q) != 0 { continue; }
            let (x, y) = (g(xs, q), g(ys, q));
            let key = if x < 0 || y < 0 { nk - 1 } else { ((y / bw).min(kh - 1) * kw + (x / bw).min(kw - 1)) as usize };
            let mut to = usize::MAX;
            let c = g(cur, key);
            if c >= 0 && (c as usize) < lim && g(ev, c as usize) == 0 && g(home, c as usize) == key as i32 && g(sfree, c as usize) > 0 { to = take(c as usize); }
            if to == usize::MAX && key < nk - 1 {
                let end = g(hoff, key + 1);
                let mut i = g(hcur, key);
                while i < end {
                    let c = g(hlist, i as usize) as usize;
                    if c < lim && g(sfree, c) > 0 && g(home, c) == key as i32 { s(cur, key, c as i32); to = take(c); break; }
                    i += 1;
                }
                s(hcur, key, i);
            }
            if to == usize::MAX {
                while ea < en {
                    let c = g(empty, ea) as usize;
                    if g(sfree, c) != 64 || g(ev, c) != 0 { ea += 1; continue; }
                    if c < lim { s(home, c, key as i32); s(cur, key, c as i32); to = take(c); }
                    break;
                }
            }
            if to == usize::MAX && stress {
                for c in 0..lim { if g(ev, c) == 0 && g(sfree, c) > 0 { to = take(c); break; } }
            }
            if to == usize::MAX { break; }
            s(pairs, 2 * n, q as i32); s(pairs, 2 * n + 1, to as i32); n += 1;
        }
    }
    // The books: new slots used and held, old ones free and fresh (the move
    // kernel leaves them so); their ever bit stays (JavaScript fields reset
    // when the next unit takes one).
    for j in 0..n {
        let (f, to) = (g(pairs, 2 * j) as usize, g(pairs, 2 * j + 1) as usize);
        s(used, to >> 5, g(used, to >> 5) | 1u32 << (to & 31)); s(ever, to >> 5, g(ever, to >> 5) | 1u32 << (to & 31));
        s(bits, f >> 5, g(bits, f >> 5) | 1u32 << (f & 31)); s(sfree, f >> 6, g(sfree, f >> 6) + 1);
        s(used, f >> 5, g(used, f >> 5) & !(1u32 << (f & 31)));
    }
    s(hdr, 0, n as i32);
    // Empty slabs at the end given up.
    let mut slabs = nsl; let mut gone = 0;
    while slabs > 1 && g(sfree, slabs - 1) == 64 {
        slabs -= 1; s(sfree, slabs, 0); s(bits, 2 * slabs, 0); s(bits, 2 * slabs + 1, 0); s(home, slabs, -1); gone += 1;
    }
    for i in 0..nk { if g(cur, i) >= slabs as i32 { s(cur, i, -1); } }
    s(hdr, 1, slabs as i32); s(hdr, 3, gone);
    // The lists made again (sim_unit_state.js _simSlabRelist).
    if !heads.is_null() && !entries.is_null() {
        for i in 0..nk + 2 { s(heads, i, 0); }
        let mut ec = 0usize;
        let mut push = |list: usize, slab: usize| { ec += 1; let at = 2 * ec; s(entries, at, slab as i32); s(entries, at + 1, g(heads, list)); s(heads, list, at as i32); };
        for b in 0..slabs {
            let f = g(sfree, b);
            if f == 0 { continue; }
            if f == 64 { push(nk + 1, b); continue; }
            let h = g(home, b);
            if h >= 0 { push(h as usize, b); }
            push(nk, b);
        }
        s(hdr, 2, ec as i32);
    }
}

/// SIM_KERNEL_META_UNITS (sim_presentation.js simPresentationMetadata): the
/// presentation's metadata of every slot's unit from the columns, as
/// simPresentationWriteMetadata writes it from the unit's fields: codes by
/// type (type, attack style, snake / king flags), by worker type and state,
/// the watch, the vision (its stat row's steps), max energy (its row's),
/// cargo and the energy block (its worker record), flying and hold flags.
/// A changed value marks the slot (unit.pvAt: the next frame by changes
/// fills it); a slot's new unit counts (fresh, the metadata revision); a
/// unit without a row's steps is listed for the JavaScript.
/// Arrays: [0..12] the table's id, flags, orderTick, maxEnergy, cargo, tx,
/// ty, type, wtype, wstate, style, watchedBy, vision; [13] unit.live, [14]
/// unit.dead, [15] unit.id, [16] unit.upT, [17] unit.wkS, [18] unit.wTeam,
/// [19] unit.statRow, [20] eff.rVsA, [21] unit.maxE, [22] unit.energy, [23]
/// unit.wkIx, [24] unit.wmCarry, [25] unit.wmBlk, [26] unit.jFly, [27]
/// unit.holdF, [28] the worker types' ids (oc_workerType), [29] the code
/// tables (i32: by type: type code, style code, flags; by worker type id;
/// by worker state), [30] the JavaScript's slots (out), [31] counts (out:
/// [0] listed, [1] fresh), [32] unit.pvAt. P: [0] slots, [1] per job, [2]
/// the tick, [3] game time, [4] types, [5] worker type ids, [6] worker type
/// ids' bytes, [7] list room, [8] flying, [9] hold, [10] research material,
/// [11] energy blocked flag bits.
#[no_mangle]
pub unsafe extern "C" fn k_meta_units(a: u32, chunk: i32) {
    use core::sync::atomic::{AtomicI32, Ordering};
    let k = K::new(waddr(a) as *const i32);
    let (mid, mfl, mot, mme, mca, mtx, mty) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<f32>(3), k.p::<f32>(4), k.p::<f32>(5), k.p::<f32>(6));
    let (mty2, mwt, mws, mst, mwb, mvi) = (k.p::<i16>(7), k.p::<i16>(8), k.p::<i16>(9), k.p::<i16>(10), k.p::<i16>(11), k.p::<u8>(12));
    let (live, dead, id, upt, wks, wteam) = (k.p::<u8>(13), k.p::<u8>(14), k.p::<i32>(15), k.p::<i16>(16), k.p::<u32>(17), k.p::<i8>(18));
    let (srow, rvsa, rmaxe, en, wkix, wcar, wblk) = (k.p::<i16>(19), k.p::<i8>(20), k.p::<f32>(21), k.p::<f32>(22), k.p::<i32>(23), k.p::<f32>(24), k.p::<f32>(25));
    let (fly, hold, wtid, tab, list, cnt, pvat) = (k.p::<u8>(26), k.p::<u8>(27), k.p::<u8>(28), k.p::<i32>(29), k.p::<i32>(30), k.p::<i32>(31), k.p::<i32>(32));
    if mid.is_null() || live.is_null() || tab.is_null() { return; }
    let (s0, s1) = super::k::job_range(chunk, k.i(1), k.i(0));
    let (tick, now) = (k.i(2), k.f(3));
    let (nt, nw, wb, room) = (k.i(4).max(0) as usize, k.i(5).max(0) as usize, k.i(6), k.i(7).max(0));
    let (f_fly, f_hold, f_mat, f_blk) = (k.i(8), k.i(9), k.i(10), k.i(11));
    let lc = &*(cnt as *const AtomicI32);
    let fc = &*(cnt.add(1) as *const AtomicI32);
    for q in s0..s1 {
        if g(live, q) == 0 || g(dead, q) != 0 { continue; }
        let uid = g(id, q);
        let fresh = g(mid, q) != uid;
        let mut ch = fresh;
        let t = g(upt, q);
        let (tc, sc, tf) = if t >= 0 && (t as usize) < nt { let t = t as usize; (g(tab, t), g(tab, nt + t), g(tab, 2 * nt + t)) } else { (0, 0, 0) };
        let wid = if wtid.is_null() { 0usize } else if wb == 1 { g(wtid, q) as usize } else if wb == 2 { g(wtid as *const u16, q) as usize } else { g(wtid as *const u32, q) as usize };
        let wc = if wid < nw { g(tab, 3 * nt + wid) } else { 0 };
        let ws = g(wks, q);
        let sc2 = g(tab, 3 * nt + nw + (ws & 31) as usize);
        let row = g(srow, q);
        let steps = if row >= 0 && !rvsa.is_null() { g(rvsa, row as usize) as i32 } else { -1 };
        if steps < 0 {
            // (No row's steps: the JavaScript writes this one.)
            let at = lc.fetch_add(1, Ordering::Relaxed);
            if at < room { s(list, at as usize, q as i32); }
            continue;
        }
        // (Its maxEnergy: its base level's, unit.maxE.)
        let me = if !rmaxe.is_null() { g(rmaxe, q) } else { g(en, q) };
        let w = g(wkix, q);
        let (car, blk) = if w > 0 { (g(wcar, w as usize) as f64, g(wblk, w as usize) as f64) } else { (f64::NAN, f64::NAN) };
        let car = if car == car { car as f32 } else { 0.0 };
        let mut fl = tf;
        if g(fly, q) != 0 { fl |= f_fly; }
        if g(hold, q) != 0 { fl |= f_hold; }
        if (ws >> 17) & 3 == 2 { fl |= f_mat; }
        if blk == blk && now < blk { fl |= f_blk; }
        if fresh { s(mid, q, -1); }
        macro_rules! set { ($p:expr, $v:expr) => {{ let v = $v; if g($p, q) != v { s($p, q, v); ch = true; } }}; }
        set!(mty2, tc as i16); set!(mwt, wc as i16); set!(mws, sc2 as i16); set!(mst, sc as i16);
        set!(mwb, g(wteam, q) as i16);
        set!(mvi, steps.clamp(0, 255) as u8);
        let mev = me; if g(mme, q).to_bits() != mev.to_bits() { s(mme, q, mev); ch = true; }
        if g(mca, q).to_bits() != car.to_bits() { s(mca, q, car); ch = true; }
        if g(mtx, q) != 0.0 { s(mtx, q, 0.0); ch = true; }
        if g(mty, q) != 0.0 { s(mty, q, 0.0); ch = true; }
        s(mot, q, tick - 1);
        set!(mfl, fl);
        s(mid, q, uid);
        if ch && !pvat.is_null() { s(pvat, q, tick + 1); }
        if fresh { fc.fetch_add(1, Ordering::Relaxed); }
    }
}

// (sim_unit_state.js _simHTermE and its words for null and unset.)
pub(crate) const H_NULL: i32 = -2147483647;
pub(crate) const H_UNDEF: i32 = -2147483648;
#[inline(always)]
pub(crate) fn hterm(key: i32, e: i32) -> i32 {
    let t = (key ^ e).wrapping_mul(16777619u32.wrapping_mul(2654435761u32) as i32);
    (t ^ ((t as u32) >> 15) as i32).wrapping_mul(0x2c1b3c6d)
}
#[inline(always)]
unsafe fn s_(p: *mut i32, i: usize, v: i32) { *p.add(i) = v; }

/// SIM_KERNEL_ACQ_REPLAY (unit.js _acqApplyMoves): one logged relayout
/// step's moves (acq.mlog from P[4]: pairs from, to) on an acquisition run
/// that was in flight: each result by slot to the unit's new slot (from past
/// the run's slots P[2]: none, the run did not see that unit), the old slot
/// as one the run did not cover; the forward map stamped P[3] (for
/// SIM_KERNEL_ACQ_REMAP). Arrays: [0] acq.mlog, [1] acq.out, [2] acq.tid,
/// [3] acq.id, [4] acq.rng, [5] acq.sout, [6] acq.bm, [7] acq.bt, [8]
/// acq.btid, [9] rl.fwd, [10] rl.fst. P: [0] pairs, [1] per job, [2] the
/// run's slots, [3] stamp, [4] the step's first pair, [5] rl.fwd's length.
#[no_mangle]
pub unsafe extern "C" fn k_acq_replay(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let log = k.p::<i32>(0);
    let (out, tid, id, rng, sout, bm, bt, btid) = (k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<u32>(4), k.p::<i32>(5), k.p::<u8>(6), k.p::<i32>(7), k.p::<i32>(8));
    let (fwd, fst) = (k.p::<i32>(9), k.p::<i32>(10));
    if log.is_null() || out.is_null() { return; }
    let (j0, j1) = super::k::job_range(chunk, k.i(1), k.i(0));
    let n = k.i(2).max(0) as usize;
    let stamp = k.i(3);
    let base = k.i(4).max(0) as usize;
    let fl = k.i(5).max(0) as usize;
    for j in j0..j1 {
        let (f, t) = (g(log, 2 * (base + j)) as usize, g(log, 2 * (base + j) + 1) as usize);
        let had = f < n;
        macro_rules! mv { ($p:expr, $d:expr) => {{ if !$p.is_null() { let v = if had { g($p, f) } else { $d }; s($p, t, v); s($p, f, $d); } }}; }
        mv!(out, -2i32); mv!(tid, 0i32); mv!(id, -1i32); mv!(rng, 0u32); mv!(sout, 0i32); mv!(bm, 255u8); mv!(bt, 0i32); mv!(btid, 0i32);
        if f < fl && !fwd.is_null() && !fst.is_null() { s(fwd, f, t as i32); s(fst, f, stamp); }
    }
}

/// SIM_KERNEL_ACQ_REMAP (unit.js _acqApplyMoves): an acquisition run that
/// was in flight while units moved (the online relayout): the combat brain's
/// unit targets (acq.bt, a unit's slot where acq.bm is neither 255 none, 0
/// nothing, nor has 16 a structure's tile) follow their units. Arrays: [0]
/// rl.fwd, [1] acq.bt, [2] acq.bm. P: [0] slots, [1] per job, [2] rl.fwd's length.
#[no_mangle]
pub unsafe extern "C" fn k_acq_remap(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (fwd, bt, bm, fst) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<u8>(2), k.p::<i32>(3));
    if fwd.is_null() || bt.is_null() || bm.is_null() || fst.is_null() {
        return;
    }
    let (s0, s1) = super::k::job_range(chunk, k.i(1), k.i(0));
    let fl = k.i(2).max(0);
    let stamp = k.i(3);
    for q in s0..s1 {
        let m = g(bm, q);
        if m == 255 || m == 0 || (m & 16) != 0 { continue; }
        let v = g(bt, q);
        if v >= 0 && v < fl && g(fst, v as usize) == stamp { s(bt as *mut i32, q, g(fwd, v as usize)); }
    }
}

/// SIM_KERNEL_SLAB_SCORE (sim_unit_state.js simUnitStateRelayoutStep): per
/// slab of 64 slots, its living units (live, not dead) and how many of them
/// stand in the slab's home block (16x16 tiles). Arrays: [0] unit.live, [1]
/// unit.dead, [2] unit.x, [3] unit.y (eighths of a pixel), [4] rl.home (per
/// slab its block, -1 none), [5] rl.score (per slab: live, home). P: [0]
/// slabs, [1] per job, [2] blocks across, [3] blocks down, [4] a block's
/// width in eighths.
#[no_mangle]
pub unsafe extern "C" fn k_slab_score(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (live, dead, xs, ys, home, out) = (k.p::<u8>(0), k.p::<u8>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5));
    if live.is_null() || out.is_null() {
        return;
    }
    let (b0, b1) = super::k::job_range(chunk, k.i(1), k.i(0));
    // ([6] sl.sfree, P[5] its slabs: empty slabs scored without their slots.)
    slab_scores(live, dead, xs, ys, home, out, b0, b1, k.i(2).max(1), k.i(3).max(1), k.i(4).max(1), k.p::<u8>(6), k.i(5).max(0) as usize);
}


/// SIM_META_STRUCTS (sim_presentation.js simPresentationMetadata): every
/// presentation slot of a tabled structure (slot -> class << 24 | row: [1])
/// written from its class table's row (class records [0], META_CW words
/// each: rows, ctab tag, presentation kind, the type / unit type ids' widths,
/// then the columns, see META_C_*), the derived stats from the static
/// building tables (stt.mxe [6], stt.vis [7], stt.atk [8], stt.dmg [9] at
/// (key * L1 + level) * R1 + research level) with the owner's research
/// (adj.rlv [10], four a (owner + 1, key): maxEnergy, visionRange,
/// attackRange, damage) and boost levels (adj.blx [11], the same layout),
/// the spawn cooldown from spr.tab [12], a lab's research from its owner's
/// ([13]: done, required, has a task, researching ok, per owner). A slot
/// whose row is no longer in the world (its tile [2] ctab, [3] rrow): alive
/// 0, listed ([67], count [68][0]); the slots written in order into the
/// order column, count [68][1]. The presentation table's columns: [16..36)
/// f32, [36..45) i32, [45] order, [46..62) i16, [62..65) u8 (sim_frame_world.js
/// SIM_STRUCT_SPEC's order); [65] the tile -> slot map, [66] the slots'
/// serials. P: [0] slots, [1] classes, [2] game time, [3] order tick, [4]
/// tile, [5] L1, [6] R1, [7] keys, [8] spr types, [9] area steps max, [10]
/// grid width, [11] tiles, [12] players, [13] the stat tables' version: a
/// spawn cooldown key of another version listed (key [14], slot [15], count
/// [68][2]) for the JavaScript to fill; [14] a slot list's length ([69]).
const META_CW: usize = 56;
const MC_N: usize = 0; const MC_TAG: usize = 1; const MC_KIND: usize = 2; const MC_TW: usize = 3; const MC_UW: usize = 4;
const MC_TID: usize = 5; const MC_UID: usize = 6; const MC_TCODE: usize = 7; const MC_UCODE: usize = 8; const MC_KEY: usize = 9; const MC_QT: usize = 10;
const MC_ST: usize = 11; const MC_OW: usize = 12; const MC_UC: usize = 13; const MC_EN: usize = 14; const MC_GX: usize = 15; const MC_GY: usize = 16;
const MC_STK: usize = 17; const MC_MSTK: usize = 18; const MC_ESTK: usize = 19; const MC_LV: usize = 20; const MC_ELV: usize = 21; const MC_ISSTK: usize = 22;
const MC_SWD: usize = 23; const MC_SALV: usize = 24; const MC_AUP: usize = 25; const MC_BLD: usize = 26; const MC_UPG: usize = 27; const MC_BURN: usize = 28;
const MC_POIS: usize = 29; const MC_FROZ: usize = 30; const MC_WET: usize = 31; const MC_SAND: usize = 32; const MC_WATCH: usize = 33; const MC_WBT: usize = 34;
const MC_AST: usize = 35; const MC_UPMX: usize = 36; const MC_MXOV: usize = 37; const MC_SPT: usize = 38; const MC_QON: usize = 39; const MC_QN: usize = 40;
const MC_RX: usize = 41; const MC_RY: usize = 42; const MC_RT: usize = 43; const MC_ARS: usize = 44; const MC_CDU: usize = 45; const MC_ANG: usize = 46;
const MC_LZ: usize = 47; const MC_MV: usize = 48; const MC_MXA: usize = 49; const MC_DMG: usize = 50; const MC_PEL: usize = 51;
#[inline(always)]
unsafe fn mcol<T>(cls: *const i32, c: usize, j: usize) -> *mut T { let v = g(cls, c * META_CW + j); if v == 0 { core::ptr::null_mut() } else { waddr(v as u32) as *mut T } }
#[inline(always)]
unsafe fn mid(p: *const u8, w: i32, r: usize) -> usize { if p.is_null() { 0 } else if w == 2 { g(p as *const u16, r) as usize } else if w == 4 { g(p as *const u32, r) as usize } else { g(p, r) as usize } }
#[no_mangle]
pub unsafe extern "C" fn k_meta_structs(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (cls, psrc, ctab, rrow, own, brain) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<u8>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5));
    let (mxe, vis, atk, dmgt, rlv, blx, sptab, res) = (k.p::<f64>(6), k.p::<i32>(7), k.p::<i32>(8), k.p::<f32>(9), k.p::<i32>(10), k.p::<i32>(11), k.p::<f64>(12), k.p::<f64>(13));
    let (miss_k, miss_s) = (k.p::<i32>(14), k.p::<i32>(15));
    let spver = k.f(13);
    let mut nm = 0usize;
    let f = |i: usize| k.p::<f32>(16 + i);
    let i4 = |i: usize| k.p::<i32>(36 + i);
    let i2 = |i: usize| k.p::<i16>(46 + i);
    let u1 = |i: usize| k.p::<u8>(62 + i);
    let (order, tslot, serials, gone, cnt) = (k.p::<i32>(45), k.p::<i32>(65), k.p::<i32>(66), k.p::<i32>(67), k.p::<i32>(68));
    // (The owners' researched maximum level per building key: adj.rml [74], (owner + 1) * keys + key.)
    let rml = k.p::<i32>(74);
    let (n, ncls, now, otick, tile, l1, r1, nk, types, smax, gw, ntiles, np) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.f(2), k.i(3), k.f(4), k.i(5).max(2), k.i(6).max(1), k.i(7).max(0),
        k.i(8).max(1), k.i(9), k.i(10).max(1), k.i(11), k.i(12).max(0));
    if cls.is_null() || psrc.is_null() || order.is_null() { return; }
    let (mut ng, mut no) = (0usize, 0usize);
    let maxl = l1 - 1;
    // (A list ([69], P[14] its length): only those slots, the order column and gone list untouched.)
    let list = k.p::<i32>(69);
    let tval = k.p::<f64>(70);
    let nl = if list.is_null() { n } else { k.i(14).max(0) as usize };
    for ii in 0..nl {
        let sl = if list.is_null() { ii } else { let x = g(list, ii); if x < 0 || x as usize >= n { continue; } x as usize };
        let v = g(psrc, sl);
        if v < 0 { continue; }
        let (c, r) = ((v as u32 >> 24) as usize, (v & 0xFFFFFF) as usize);
        if c >= ncls || r >= g(cls, c * META_CW + MC_N).max(0) as usize { continue; }
        let t = g(mcol::<i32>(cls, c, MC_ST), r);
        if t < 0 || t >= ntiles || g(ctab, t as usize) as i32 != g(cls, c * META_CW + MC_TAG) || g(rrow, t as usize) != r as i32 {
            s(u1(0), sl, 0);
            if !gone.is_null() && list.is_null() { s(gone, ng, sl as i32); ng += 1; }
            continue;
        }
        let tu = t as usize;
        let kind = g(cls, c * META_CW + MC_KIND);
        let rd8 = |j: usize| -> i32 { let p = mcol::<i8>(cls, c, j); if p.is_null() { -128 } else { g(p, r) as i32 } };
        let rdb = |j: usize| -> bool { let p = mcol::<u8>(cls, c, j); !p.is_null() && g(p, r) == 2 };
        let rdi = |j: usize| -> i32 { let p = mcol::<i32>(cls, c, j); if p.is_null() { i32::MIN } else { g(p, r) } };
        let rdf = |j: usize| -> f64 { let p = mcol::<f64>(cls, c, j); if p.is_null() { f64::NAN } else { g(p, r) } };
        let pos = |x: i32| x != i32::MIN && x > 0;
        let (gx, gy) = (g(mcol::<i16>(cls, c, MC_GX), r) as i32, g(mcol::<i16>(cls, c, MC_GY), r) as i32);
        let ow = g(own, tu);
        let owner = if ow == 0x7ff9 { -1 } else { ow };
        let tid = mid(mcol::<u8>(cls, c, MC_TID) as *const u8, g(cls, c * META_CW + MC_TW), r);
        let uid = mid(mcol::<u8>(cls, c, MC_UID) as *const u8, g(cls, c * META_CW + MC_UW), r);
        let tcode = { let p = mcol::<i32>(cls, c, MC_TCODE); if p.is_null() { 0 } else { g(p, tid) } };
        let ucode = { let p = mcol::<i32>(cls, c, MC_UCODE); if p.is_null() { 0 } else { g(p, uid) } };
        // (Its building stat key: barracks by their unit type.)
        let key = { let p = mcol::<i32>(cls, c, MC_KEY); if p.is_null() { -1 } else { g(p, if kind == 1 { uid } else { tid }) } };
        let lv0 = rd8(MC_LV);
        let stk = rdi(MC_STK);
        let bl = if lv0 != -128 { lv0.max(1).min(maxl) } else if stk != i32::MIN && stk > 0 { (32 - (stk as u32).leading_zeros() as i32).max(1).min(maxl) } else { 1 };
        let el0 = rd8(MC_ELV);
        let el = if el0 != -128 { el0.max(1).min(maxl) } else { bl };
        // (A stat of key at level lv, its research and boost as the owner has them; j: maxEnergy 0, visionRange 1, attackRange 2, damage 3.)
        let ri = if key >= 0 && owner >= -1 && owner + 1 < np { (((owner + 1) * nk + key) * 4) as usize } else { usize::MAX };
        let at = |lv: i32, j: usize| -> usize {
            let (rl, up) = if ri != usize::MAX && !rlv.is_null() { (g(rlv, ri + j), if blx.is_null() { 0 } else { g(blx, ri + j) }) } else { (0, 0) };
            let lb = if up > 0 { (lv.max(1) + up).min(maxl) } else { lv };
            ((key * l1 + lb) * r1 + rl.max(0).min(r1 - 1)) as usize
        };
        let mut max_e = f64::NAN;
        let ov = rdf(MC_MXOV);
        if ov == ov { max_e = ov; }
        else if rdb(MC_UPG) && rdf(MC_UPMX) > 0.0 { max_e = floor(rdf(MC_UPMX)).max(1.0); }
        else if kind <= 3 && key >= 0 && !mxe.is_null() { let m = g(mxe, at(bl, 0)); max_e = if m == m { m } else { 1.0 }; }
        let vision = if kind <= 3 && key >= 0 && !vis.is_null() && !atk.is_null() { let vo = g(vis, at(el, 1)).max(0); let ar = g(atk, at(el, 2)).max(0); vo.max(ar).min(smax.max(0)) } else { 0 };
        // (Only floor items show a damage: their row's, else their stat at their effective level.)
        let damage = if kind != 3 { 0.0 } else { let d = rdf(MC_DMG); if d == d { d } else if key >= 0 && !dmgt.is_null() { let d = g(dmgt, at(el, 3)) as f64; if d == d { d } else { 0.0 } } else { 0.0 } };
        // f32: x y energy maxEnergy spawnTimer spawnCooldown stackWork stackReq angle amount amountMax cd tx ty resDone resReq rallyX rallyY timer damage
        let en = rdf(MC_EN);
        s(f(0), sl, (gx as f64 * tile + tile * 0.5) as f32); s(f(1), sl, (gy as f64 * tile + tile * 0.5) as f32);
        s(f(2), sl, if en == en { en as f32 } else { 0.0 });
        s(f(3), sl, if max_e == max_e { max_e as f32 } else { 0.0 });
        let spt = rdf(MC_SPT);
        s(f(4), sl, if spt == spt { spt as f32 } else { 0.0 });
        let mut scd = 0.0f64;
        if (kind == 1 || kind == 2) && !sptab.is_null() {
            let b = g(brain, tu);
            let ty = (b & 65535) - 1;
            let lvb = ((b >> 16) & 255).max(1).min(63);
            if ty >= 0 && ty < types && owner >= -1 && owner <= 62 { let kk = (((owner + 1) * types + ty) * 64 + lvb) as usize; if g(sptab, kk * 3 + 2) != spver { if !miss_k.is_null() && !miss_s.is_null() { s(miss_k, nm, kk as i32); s(miss_s, nm, sl as i32); nm += 1; } } else { let v = g(sptab, kk * 3); if v == v { scd = v; } } }
        }
        s(f(5), sl, scd as f32);
        let swd = rdf(MC_SWD);
        s(f(6), sl, if swd == swd { swd as f32 } else { 0.0 }); s(f(7), sl, 0.0);
        let ang = mcol::<f32>(cls, c, MC_ANG);
        s(f(8), sl, if ang.is_null() { 0.0 } else { let a0 = g(ang, r); if a0 == a0 { a0 } else { 0.0 } });
        // (A mine's amount: the tile table's ([70] _ST.val), its row's only before it is tabled.)
        let mv = if (kind == 4 || kind == 5) && !tval.is_null() { g(tval, tu) } else { rdf(MC_MV) };
        s(f(9), sl, if (kind == 4 || kind == 5) && mv == mv { mv as f32 } else { 0.0 });
        let mxa = rdf(MC_MXA);
        s(f(10), sl, if (kind == 4 || kind == 5) && mxa == mxa { mxa as f32 } else { 0.0 });
        let cdu = rdf(MC_CDU);
        s(f(11), sl, if cdu == cdu { (cdu - now).max(0.0) as f32 } else { 0.0 });
        s(f(12), sl, 0.0); s(f(13), sl, 0.0);
        let lab = kind == 2 && !mcol::<u8>(cls, c, MC_ARS).is_null();
        let (rdone, rreq, rhas, rok) = if lab && !res.is_null() && owner >= 0 && (owner as usize) < np as usize { let b = owner as usize * 4; (g(res, b), g(res, b + 1), g(res, b + 2) != 0.0, g(res, b + 3) != 0.0) } else { (0.0, 0.0, false, false) };
        s(f(14), sl, rdone as f32); s(f(15), sl, rreq as f32);
        let (rx, ry) = (rdf(MC_RX), rdf(MC_RY));
        s(f(16), sl, if rx == rx { rx as f32 } else { 0.0 }); s(f(17), sl, if ry == ry { ry as f32 } else { 0.0 });
        s(f(18), sl, 0.0); s(f(19), sl, damage as f32);
        // i32: serial flags l0 l1 l2 l3 orderTick rallyTargetId label (the links: the second pass)
        if !serials.is_null() { s(i4(0), sl, g(serials, sl)); }
        let researching = rhas && !rdb(MC_UPG) && rdb(MC_ARS) && rok;
        let flags = (if rdb(MC_UC) { 1 } else { 0 }) | (if rdb(MC_UPG) { 2 } else { 0 }) | (if rdb(MC_SALV) { 4 } else { 0 }) | (if rdb(MC_ISSTK) { 8 } else { 0 })
            | (if pos(rdi(MC_WATCH)) { 16 } else { 0 }) | (if pos(rdi(MC_BURN)) { 32 } else { 0 }) | (if pos(rdi(MC_POIS)) { 64 } else { 0 }) | (if pos(rdi(MC_FROZ)) { 128 } else { 0 })
            | (if pos(rdi(MC_WET)) { 256 } else { 0 }) | (if pos(rdi(MC_SAND)) { 512 } else { 0 }) | (if rdb(MC_AUP) { 1024 } else { 0 }) | (if rdb(MC_BLD) { 2048 } else { 0 })
            | (if rdb(MC_QON) { 4096 } else { 0 }) | (if rdb(MC_ARS) { 8192 } else { 0 }) | (if rx == rx && ry == ry { 32768 } else { 0 }) | (if rhas { 65536 } else { 0 })
            | (if rdb(MC_AST) { 131072 } else { 0 }) | (if researching { 262144 } else { 0 });
        s(i4(1), sl, flags);
        s(i4(6), sl, otick);
        let rt = rdf(MC_RT);
        s(i4(7), sl, if rt == rt { rt as i32 } else { -1 });
        // i16: kind gx gy owner type utype level elevel stacks mstacks estacks qlen qtype laser watchedBy stackCount
        s(i2(0), sl, kind as i16); s(i2(1), sl, gx as i16); s(i2(2), sl, gy as i16); s(i2(3), sl, owner as i16);
        s(i2(4), sl, tcode as i16); s(i2(5), sl, ucode as i16);
        s(i2(6), sl, if lv0 != -128 { lv0 as i16 } else { -1 }); s(i2(7), sl, if el0 != -128 { el0 as i16 } else { -1 });
        let opt = |x: i32| -> i16 { if x == i32::MIN { -1 } else { x as i16 } };
        s(i2(8), sl, opt(stk)); s(i2(9), sl, opt(rdi(MC_MSTK))); s(i2(10), sl, opt(rdi(MC_ESTK)));
        let qn = rd8(MC_QN);
        let ql = if qn == -128 { 0 } else { qn.max(0) };
        s(i2(11), sl, ql as i16);
        let qt = if ql > 0 { let p = mcol::<i32>(cls, c, MC_QT); if p.is_null() { 0 } else { g(p, if kind == 1 { uid } else { tid }) } } else { 0 };
        s(i2(12), sl, qt as i16);
        let lz = rd8(MC_LZ);
        s(i2(13), sl, if lz == -128 { 0 } else { lz as i16 });
        let wb = rd8(MC_WBT);
        s(i2(14), sl, if wb == -128 { -1 } else { wb as i16 });
        s(i2(15), sl, -1);
        // The level label's numbers (things_utils.js getLevelLabelText): its
        // level (0 under construction), effective and potential levels, the
        // owner's researched maximum, each 7 bits, bit 28 set; the page makes
        // the text (sim_frame_world.js simLabelText).
        let label = if kind <= 3 {
            let s2l = |x: i32| -> i32 { if x > 0 { (32 - (x as u32).leading_zeros() as i32).max(1).min(maxl) } else { 1 } };
            let pel = rd8(MC_PEL);
            let mst = rdi(MC_MSTK);
            let mut pl = el;
            if pel != -128 { pl = pl.max(pel.max(1).min(maxl)); }
            if lv0 != -128 { pl = pl.max(lv0.max(1).min(maxl)); }
            if stk != i32::MIN { pl = pl.max(s2l(stk)); }
            if mst != i32::MIN { pl = pl.max(s2l(mst)); }
            let uc = rdb(MC_UC);
            let cl = if uc { 0 } else { bl };
            let pl = if uc { pl } else { pl.max(el) };
            let rm = if key < 0 { maxl } else if owner < 0 || rml.is_null() || owner + 1 >= np { 1 } else { g(rml, ((owner + 1) * nk + key) as usize).max(1).min(maxl) };
            (1 << 28) | (cl & 127) | ((el & 127) << 7) | ((pl & 127) << 14) | ((rm & 127) << 21)
        } else { 0 };
        s(i4(8), sl, label);
        // (Laser links: -1, the JavaScript writes the lasers'.)
        s(i4(2), sl, -1); s(i4(3), sl, -1); s(i4(4), sl, -1); s(i4(5), sl, -1);
        // u8: alive flash vision
        s(u1(0), sl, 1); s(u1(1), sl, 0); s(u1(2), sl, vision as u8);
        if kind <= 3 && !tslot.is_null() && gx >= 0 && gy >= 0 { let tt = (gy * gw + gx) as usize; if (tt as i32) < ntiles { s(tslot, tt, sl as i32); } }
        if list.is_null() { s(order, no, sl as i32); }
        no += 1;
    }
    // The laser towers' links (tower.js laserPartnersOf): their partners' tiles
    // (lz.lslot [71] by tile, lz.pn [72] four counts a laser slot, lz.part [73]
    // four tiles a direction), in tile order, the first four with a structure,
    // as their slots by the tile -> slot map. (After every row: a partner's
    // slot this pass's.)
    let (lslot, lpn, lpart) = (k.p::<i32>(71), k.p::<i32>(72), k.p::<i32>(73));
    if !lslot.is_null() && !lpn.is_null() && !lpart.is_null() && !tslot.is_null() {
        let mut tl = [0i32; 16];
        for ii in 0..nl {
            let sl = if list.is_null() { ii } else { let x = g(list, ii); if x < 0 || x as usize >= n { continue; } x as usize };
            if g(u1(0), sl) != 1 || g(i2(0), sl) != 0 { continue; }
            let t = g(i2(2), sl) as i32 * gw + g(i2(1), sl) as i32;
            if t < 0 || t >= ntiles { continue; }
            let ls = g(lslot, t as usize);
            if ls < 0 { continue; }
            let mut m = 0usize;
            for d in 0..4usize {
                let c = g(lpn, ls as usize * 4 + d).max(0).min(4) as usize;
                for q in 0..c { tl[m] = g(lpart, ls as usize * 16 + d * 4 + q); m += 1; }
            }
            // (Insertion sort: at most 16.)
            for i in 1..m { let v = tl[i]; let mut j = i; while j > 0 && tl[j - 1] > v { tl[j] = tl[j - 1]; j -= 1; } tl[j] = v; }
            let mut w = 0usize;
            for i in 0..m {
                if w >= 4 { break; }
                let pt = tl[i];
                if pt < 0 || pt >= ntiles || g(ctab, pt as usize) == 0 { continue; }
                s(i4(2 + w), sl, g(tslot, pt as usize)); w += 1;
            }
        }
    }
    if !cnt.is_null() { s(cnt, 0, ng as i32); s(cnt, 1, no as i32); s(cnt, 2, nm as i32); }
}
