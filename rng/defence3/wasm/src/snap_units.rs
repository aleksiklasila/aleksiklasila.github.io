//! A snapshot's units as a block of columns (RESTORE_WASM_PLAN.md; utils_snapshot.js _snapUb*): the sender
//! gathers the state columns of the units in id order (k_ub_count, k_ub_gather), the receiver makes the units
//! in slots (k_ub_births: slots, handles, worker and status records, the id table and hash) and writes the
//! columns over them (k_ub_scatter), their paths into the path store (k_ub_paths) and their target units'
//! slots (k_ub_targets). No unit object on either side. Base64 for the snapshot's text: k_b64_enc, k_b64_dec.
//!
//! The column table (utils_snapshot.js _snapUbTable): CT_W words a column: [0] its address (encoded), [1] its
//! bytes an element, [2] mode, [3] elements a slot (mode 3), [4] the word (mode 3), [5] flags, [6] remap
//! offset, [7] remap length. Modes: 0 by slot, 1 by worker record (unit.wkIx), 2 by status record
//! (unit.stIx), 3 a word of a slot's record. Flags: 1 ids remapped on decode (i32 in the block: the column's
//! width may differ between peers, a shared column's pool), 2 unit.esVer as the stats-behind bit, 4 unsigned.
//!
//! The block: UB_HDR words ([0] version, [1] units, [2] columns, [3] worker records, [4] status records,
//! [5] paths, [6] path nodes, [7] bytes), then per unit its worker record's index in the block (-1 none),
//! its status record's, its path (0 none, 1 empty, 2 + the path's index), then each column's values (the
//! units' in id order, a record column's in record order), each section padded to 4 bytes; then the paths
//! ([length, first node carried, users] a path) and their nodes from the first carried on (3 words a node:
//! tile, profile | wide, ready; as sim_unit_state.js SIM_PATH's blocks).
use super::*;
use super::k::K;

#[inline(always)]
unsafe fn g<T: Copy>(p: *const T, i: usize) -> T { *p.add(i) }
#[inline(always)]
unsafe fn s<T>(p: *mut T, i: usize, v: T) { *p.add(i) = v; }

const CT_W: usize = 8;
const M_WK: i32 = 1;
const M_ST: i32 = 2;
const M_WORD: i32 = 3;
const F_REMAP: i32 = 1;
const F_BEHIND: i32 = 2;
const F_UNSIGNED: i32 = 4;
const UB_HDR: usize = 16;
const UB_VERSION: i32 = 1;
/// Columns a table holds at most (the offsets' scratch on the stack).
const UB_MAX_COLS: usize = 256;

#[inline(always)]
unsafe fn ct(t: *const i32, j: usize, w: usize) -> i32 { g(t, j * CT_W + w) }
#[inline(always)]
fn pad4(x: usize) -> usize { (x + 3) & !3 }
/// A column's bytes a value in the block.
#[inline(always)]
unsafe fn bbytes(t: *const i32, j: usize) -> usize { if ct(t, j, 5) & (F_REMAP | F_BEHIND) != 0 { 4 } else { ct(t, j, 1) as usize } }
/// The values a column carries: the units', the worker records' or the status records'.
#[inline(always)]
unsafe fn ccount(t: *const i32, j: usize, n: usize, nwk: usize, nst: usize) -> usize {
    match ct(t, j, 2) { M_WK => nwk, M_ST => nst, _ => n }
}

/// The block's sections: per-unit words, each column's start, the path table, the nodes, the end.
struct Lay { uw: usize, us: usize, pref: usize, ptab: usize, nodes: usize, end: usize }
unsafe fn layout(t: *const i32, ncol: usize, n: usize, nwk: usize, nst: usize, npath: usize, nodes: usize, off: &mut [usize; UB_MAX_COLS]) -> Lay {
    let uw = UB_HDR * 4;
    let us = uw + 4 * n;
    let pref = us + 4 * n;
    let mut at = pref + 4 * n;
    for j in 0..ncol.min(UB_MAX_COLS) {
        *off.get_unchecked_mut(j) = at;
        at = pad4(at + ccount(t, j, n, nwk, nst) * bbytes(t, j));
    }
    let ptab = at;
    let nd = ptab + 12 * npath;
    Lay { uw, us, pref, ptab, nodes: nd, end: nd + 12 * nodes }
}

#[inline(always)]
unsafe fn rd_int(p: *const u8, bytes: usize, unsigned: bool) -> i32 {
    match (bytes, unsigned) {
        (1, false) => *(p as *const i8) as i32,
        (1, true) => *p as i32,
        (2, false) => core::ptr::read_unaligned(p as *const i16) as i32,
        (2, true) => core::ptr::read_unaligned(p as *const u16) as i32,
        _ => core::ptr::read_unaligned(p as *const i32),
    }
}
#[inline(always)]
unsafe fn wr_int(p: *mut u8, bytes: usize, v: i32) {
    match bytes {
        1 => *p = v as u8,
        2 => core::ptr::write_unaligned(p as *mut u16, v as u16),
        _ => core::ptr::write_unaligned(p as *mut i32, v),
    }
}
#[inline(always)]
unsafe fn copy_el(src: *const u8, dst: *mut u8, bytes: usize) {
    match bytes {
        1 => *dst = *src,
        2 => core::ptr::write_unaligned(dst as *mut u16, core::ptr::read_unaligned(src as *const u16)),
        4 => core::ptr::write_unaligned(dst as *mut u32, core::ptr::read_unaligned(src as *const u32)),
        8 => core::ptr::write_unaligned(dst as *mut u64, core::ptr::read_unaligned(src as *const u64)),
        _ => core::ptr::copy_nonoverlapping(src, dst, bytes),
    }
}
#[inline(always)]
unsafe fn wi(b: *mut u8, at: usize, v: i32) { core::ptr::write_unaligned(b.add(at) as *mut i32, v) }
#[inline(always)]
unsafe fn ri(b: *const u8, at: usize) -> i32 { core::ptr::read_unaligned(b.add(at) as *const i32) }

/// Encode, first pass (one job): per unit (slots [0], P[0] of them, in id order) whether it has a worker
/// record (unit.wkIx [1]) and a status record (unit.stIx [2]), their places in the block, and its path
/// (unit.pthH [3]): one entry a path (a rally's path shared by many units: once), carried from the first
/// node any of its units still reads (unit.pathIndex [4] - 1). Scratch sc [6] (sim_unit_state.js SIM_PATH's
/// arena [5]): [0, n) the worker record places, [n, 2n) the status ones, [2n, 3n) the path references,
/// [3n, 7n) the paths (handle, length, first node, users), then the handles' hash (P[1] entries, a power of
/// two). out [7]: [0] worker records, [1] status records, [2] paths, [3] nodes.
#[no_mangle]
pub unsafe extern "C" fn k_ub_count(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (sl, wkix, stix, pth, pidx, arena, sc, out) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7));
    let (n, hn) = (k.i(0).max(0) as usize, k.i(1).max(1) as usize);
    let (uw, us, pref, pt, hs) = (sc, sc.add(n), sc.add(2 * n), sc.add(3 * n), sc.add(7 * n));
    for i in 0..hn { s(hs, i, 0); }
    let hm = (hn - 1) as u32;
    let (mut nwk, mut nst, mut np) = (0i32, 0i32, 0usize);
    for i in 0..n {
        let q = g(sl, i) as usize;
        s(uw, i, if g(wkix, q) > 0 { nwk += 1; nwk - 1 } else { -1 });
        s(us, i, if g(stix, q) > 0 { nst += 1; nst - 1 } else { -1 });
        let h = g(pth, q);
        if h < 2 || arena.is_null() { s(pref, i, if h == 1 { 1 } else { 0 }); continue; }
        let len = g(arena, (h - 2) as usize) & 0xffffff;
        let sk = (g(pidx, q) - 1).min(len - 1).max(0);
        let mut hq = (h as u32).wrapping_mul(2654435761) & hm;
        let kk = loop {
            let e = g(hs, hq as usize);
            if e == 0 {
                s(hs, hq as usize, np as i32 + 1);
                let r = pt.add(np * 4);
                *r = h; *r.add(1) = len; *r.add(2) = sk; *r.add(3) = 0;
                np += 1;
                break np - 1;
            }
            if g(pt, (e - 1) as usize * 4) == h { break (e - 1) as usize; }
            hq = (hq + 1) & hm;
        };
        let r = pt.add(kk * 4);
        if sk < *r.add(2) { *r.add(2) = sk; }
        *r.add(3) += 1;
        s(pref, i, 2 + kk as i32);
    }
    let mut nodes = 0usize;
    for kk in 0..np { let r = pt.add(kk * 4); nodes += (*r.add(1) - *r.add(2)) as usize; }
    s(out, 0, nwk); s(out, 1, nst); s(out, 2, np as i32); s(out, 3, nodes as i32);
}

/// Encode, second pass (one job): the block [6] (k_ub_count's counts in P[2..6]: worker records, status
/// records, paths, nodes) from the units (slots [0], P[0]; unit.wkIx [1], unit.stIx [2]), the column table
/// ct [3] (P[1] columns), the first pass's scratch [4] and the path arena [5]. The stats-behind bit
/// (things_utils.js _unitStatsBehind): unit.esVer -3 not behind, other negatives behind, else behind when
/// not its tables' version (the version table [10] at owner [7] * P[6] + its stats type, the unit type
/// [8] (unit.upT) -> stats type map [9] (P[7] long); P[8] the version table's length).
#[no_mangle]
pub unsafe extern "C" fn k_ub_gather(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (sl, wkix, stix, t, sc, arena, blk) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<u8>(6));
    let (own, upt, tymap, sver) = (k.p::<i8>(7), k.p::<i16>(8), k.p::<i8>(9), k.p::<i32>(10));
    let (n, ncol) = (k.i(0).max(0) as usize, (k.i(1).max(0) as usize).min(UB_MAX_COLS));
    let (nwk, nst, np, nodes) = (k.i(2).max(0) as usize, k.i(3).max(0) as usize, k.i(4).max(0) as usize, k.i(5).max(0) as usize);
    let (vtypes, ntymap, nsver) = (k.i(6), k.i(7), k.i(8));
    let mut off = [0usize; UB_MAX_COLS];
    let ly = layout(t, ncol, n, nwk, nst, np, nodes, &mut off);
    for w in 0..UB_HDR { wi(blk, w * 4, 0); }
    wi(blk, 0, UB_VERSION); wi(blk, 4, n as i32); wi(blk, 8, ncol as i32); wi(blk, 12, nwk as i32); wi(blk, 16, nst as i32);
    wi(blk, 20, np as i32); wi(blk, 24, nodes as i32); wi(blk, 28, ly.end as i32);
    let (uw, us, pref, pt) = (sc, sc.add(n), sc.add(2 * n), sc.add(3 * n));
    for i in 0..n { wi(blk, ly.uw + 4 * i, g(uw, i)); wi(blk, ly.us + 4 * i, g(us, i)); wi(blk, ly.pref + 4 * i, g(pref, i)); }
    for j in 0..ncol {
        let base = waddr(ct(t, j, 0) as u32) as *const u8;
        let (bytes, mode, per, word, fl) = (ct(t, j, 1) as usize, ct(t, j, 2), ct(t, j, 3).max(1) as usize, ct(t, j, 4).max(0) as usize, ct(t, j, 5));
        let bb = bbytes(t, j);
        let dst0 = blk.add(*off.get_unchecked(j));
        for i in 0..n {
            let q = g(sl, i) as usize;
            // (Its place among the column's values, and the element it is.)
            let (at, el) = match mode {
                M_WK => { let r = g(uw, i); if r < 0 { continue; } (r as usize, g(wkix, q) as usize) }
                M_ST => { let r = g(us, i); if r < 0 { continue; } (r as usize, g(stix, q) as usize) }
                M_WORD => (i, q * per + word),
                _ => (i, q),
            };
            let src = base.add(el * bytes);
            let dst = dst0.add(at * bb);
            if fl & F_BEHIND != 0 {
                let v = rd_int(src, bytes, false);
                let behind = if v == -3 { 0 } else if v < 0 { 1 } else {
                    let ty = g(upt, q) as i32;
                    let ti = if ty >= 0 && ty < ntymap { g(tymap, ty as usize) as i32 } else { -1 };
                    let o = g(own, q) as i32;
                    let cur = if o >= 0 && ti >= 0 && ti < vtypes && o * vtypes + ti < nsver { g(sver, (o * vtypes + ti) as usize) } else { 0 };
                    if v != cur { 1 } else { 0 }
                };
                wr_int(dst, 4, behind);
            } else if fl & F_REMAP != 0 {
                wr_int(dst, 4, rd_int(src, bytes, fl & F_UNSIGNED != 0));
            } else {
                copy_el(src, dst, bytes);
            }
        }
    }
    for kk in 0..np {
        let r = pt.add(kk * 4);
        wi(blk, ly.ptab + 12 * kk, *r.add(1)); wi(blk, ly.ptab + 12 * kk + 4, *r.add(2)); wi(blk, ly.ptab + 12 * kk + 8, *r.add(3));
    }
    let mut at = ly.nodes;
    for kk in 0..np {
        let r = pt.add(kk * 4);
        let (h, len, sk) = (*r, *r.add(1) as usize, *r.add(2) as usize);
        let b = (h - 2) as usize;
        for j in sk..len {
            let o = b + 3 + 3 * j;
            wi(blk, at, g(arena, o)); wi(blk, at + 4, g(arena, o + 1)); wi(blk, at + 8, g(arena, o + 2));
            at += 12;
        }
    }
}

/// Decode, the units' slots (one job): per unit i of the block [0] (column table [1]; P[0] units) a slot,
/// a handle (free stack hfree [12], P[9] free, P[10] next; handle -> slot hslot [11], unit.hnd [21]), live
/// (unit.live [22], unit.tmOn [23]), not in the separation (sepKey [24]: P[16]), its worker record when the
/// block has one (free stack wfree [16], P[11] free, P[12] used, P[13] room; the record's columns at their
/// defaults: wtab [27], wkind [28], wdefs [29], P[20] columns; unit.wkIx [25]) and its status record (st.free
/// [17], st.hdr [18], P[22] room; unit.stIx [26]); into bs [20]. Positions from the block's x and y
/// columns (P[17], P[18]: eighths), ids from its id column (P[19]).
/// P[21] 0, a whole restore: the books (nfs.rs Books [2]..[10]: bits, sfree, home, cur, heads, entries,
/// used, ever, hdr) are empty; the units take slots 0.. by their block (sim_unit_state.js _simSlabKey: P[4]
/// tile, P[5] tiles a key, P[6] kw, P[7] kh, P[8] keys), in id order within one, no gap (keys scratch
/// [30]: n + P[8] + 1 words), and the books are made for that (as _simSlabFromLive, the slabs' homes their
/// first unit's key, then _simSlabRelist); the id table's rows [13], [14] from P[15] and the id hash [15]
/// (mask P[14]). P[21] 1, a patch: a unit the id hash has (unit.id [31]) keeps its slot (a record it has
/// and the block not: its columns at the defaults (worker), zero (status, by k_ub_scatter)); kept [32] 1;
/// the others take slots by the allocator (nfs.rs slab_alloc: P[1] slots, P[2] slack minimum, P[3] slack
/// shift) and join the hash. out [19]: [0] units made, [1] free handles, [2] next handle, [3] free worker
/// records, [4] used, [5] -1 or the unit whose slot failed, [6] worker records past the room, [7] status
/// records past the room, [8] slabs, [9] new units (a patch: their ids [33] and slots [34], in order).
#[no_mangle]
pub unsafe extern "C" fn k_ub_births(a: u32, _chunk: i32) {
    use super::nfs::{Books, slab_alloc};
    let k = K::new(waddr(a) as *const i32);
    let (blk, t) = (k.p::<u8>(0), k.p::<i32>(1));
    let books = Books::from(&k, 2, k.i(1));
    let (used, ever) = (k.p::<u32>(8), k.p::<u32>(9));
    let (bits, sfree, home, heads, entries, hdr) = (k.p::<u32>(2), k.p::<u8>(3), k.p::<i32>(4), k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(10));
    let (hslot, hfree, uids, uslots, idt) = (k.p::<i32>(11), k.p::<i32>(12), k.p::<i32>(13), k.p::<i32>(14), k.p::<i32>(15));
    let (wfree, stfree, sthdr, out, bs) = (k.p::<i32>(16), k.p::<i32>(17), k.p::<i32>(18), k.p::<i32>(19), k.p::<i32>(20));
    let (hnd, live, tmon, sepkey, wkix, stix) = (k.p::<i32>(21), k.p::<u8>(22), k.p::<u8>(23), k.p::<u32>(24), k.p::<i32>(25), k.p::<i32>(26));
    let (wtab, wkind, wdefs, keys, idc, kept) = (k.p::<i32>(27), k.p::<i32>(28), k.p::<f64>(29), k.p::<i32>(30), k.p::<i32>(31), k.p::<u8>(32));
    let (nids, nslots) = (k.p::<i32>(33), k.p::<i32>(34));
    let mut nnew = 0usize;
    let n = k.i(0).max(0) as usize;
    let (smin, ssh, tile, ktiles, kw, kh, nk) = (k.i(2), k.i(3), k.f(4), k.i(5).max(1), k.i(6).max(1), k.i(7).max(1), k.i(8).max(1) as usize);
    let (mut hfn, mut hnx, mut wfn, mut wused, wcap) = (k.i(9), k.i(10), k.i(11), k.i(12), k.i(13));
    let (mask, u0, absent) = (k.i(14) as u32, k.i(15).max(0) as usize, k.i(16) as u32);
    let (cx, cy, cid, nwc, patch, stcap) = (k.i(17) as usize, k.i(18) as usize, k.i(19) as usize, k.i(20).max(0) as usize, k.i(21) == 1, k.i(22));
    for w in 0..16 { s(out, w, 0); }
    s(out, 5, -1);
    let ncol = (ri(blk, 8).max(0) as usize).min(UB_MAX_COLS);
    let (nwk, nst, np, nodes) = (ri(blk, 12).max(0) as usize, ri(blk, 16).max(0) as usize, ri(blk, 20).max(0) as usize, ri(blk, 24).max(0) as usize);
    let mut off = [0usize; UB_MAX_COLS];
    let ly = layout(t, ncol, n, nwk, nst, np, nodes, &mut off);
    let xi = |i: usize| ri(blk, *off.get_unchecked(cx) + 4 * i);
    let yi = |i: usize| ri(blk, *off.get_unchecked(cy) + 4 * i);
    let idi = |i: usize| ri(blk, *off.get_unchecked(cid) + 4 * i);
    let keyof = |x8: i32, y8: i32| -> usize {
        let (x, y) = (x8 as f64 * 0.125, y8 as f64 * 0.125);
        if !(x >= 0.0) || !(y >= 0.0) { return nk - 1; }
        let span = tile * ktiles as f64;
        let kx = ((x / span) as i32).min(kw - 1);
        let ky = ((y / span) as i32).min(kh - 1);
        (ky * kw + kx) as usize
    };
    // (A whole restore: the slots planned by block, a counting sort; the keys of the slots kept for the homes.)
    if !patch {
        let cnt = keys.add(n);
        for kk in 0..=nk { s(cnt, kk, 0); }
        for i in 0..n { let kk = keyof(xi(i), yi(i)); s(keys, i, kk as i32); s(cnt, kk + 1, g(cnt, kk + 1) + 1); }
        for kk in 0..nk { s(cnt, kk + 1, g(cnt, kk + 1) + g(cnt, kk)); }
        for i in 0..n { let kk = g(keys, i) as usize; let q = g(cnt, kk); s(cnt, kk, q + 1); s(bs, i, q); }
    }
    let mut nb = 0usize;
    for i in 0..n {
        let id = idi(i);
        let mut q: i32 = -1;
        if patch {
            let mut hq = (id as u32).wrapping_mul(2654435761u32) & mask;
            loop {
                let v = g(idt, hq as usize);
                if v == -1 { break; }
                if v >= 0 && g(idc, v as usize) == id && g(hnd, v as usize) > 0 { q = v; break; }
                hq = (hq + 1) & mask;
            }
            if q >= 0 {
                s(kept, i, 1);
                s(bs, i, q);
                let qu = q as usize;
                // (Its records as the block has them.)
                let hw = ri(blk, ly.uw + 4 * i) >= 0;
                let w0 = g(wkix, qu);
                if hw && w0 <= 0 {
                    let w = if wfn > 0 { wfn -= 1; g(wfree, wfn as usize) } else { wused += 1; wused - 1 };
                    if w >= wcap { s(out, 6, g(out, 6) + 1); continue; }
                    for j in 0..nwc { super::nfs::spawn_put(wtab, wkind, j, w as usize, g(wdefs, j)); }
                    s(wkix, qu, w);
                } else if !hw && w0 > 0 {
                    for j in 0..nwc { super::nfs::spawn_put(wtab, wkind, j, w0 as usize, g(wdefs, j)); }
                }
                if ri(blk, ly.us + 4 * i) >= 0 && g(stix, qu) <= 0 {
                    let r = if g(sthdr, 0) > 0 { s(sthdr, 0, g(sthdr, 0) - 1); g(stfree, g(sthdr, 0) as usize) } else { s(sthdr, 1, g(sthdr, 1) + 1); g(sthdr, 1) - 1 };
                    if r >= stcap { s(out, 7, g(out, 7) + 1); continue; }
                    s(stix, qu, r);
                }
                continue;
            }
            s(kept, i, 0);
            let kk = keyof(xi(i), yi(i));
            q = slab_alloc(&books, kk as i32, smin, ssh);
            if q < 0 { s(out, 5, i as i32); break; }
            s(bs, i, q);
        } else {
            q = g(bs, i);
        }
        let qu = q as usize;
        { let (wd, m) = ((q >> 5) as usize, 1u32 << (q & 31)); *used.add(wd) |= m; *ever.add(wd) |= m; }
        let hd = if hfn > 0 { hfn -= 1; g(hfree, hfn as usize) } else { hnx += 1; hnx - 1 };
        s(hslot, hd as usize, q); s(hnd, qu, hd);
        s(live, qu, 1); s(tmon, qu, 1);
        if !sepkey.is_null() { s(sepkey, qu, absent); }
        if ri(blk, ly.uw + 4 * i) >= 0 {
            let w = if wfn > 0 { wfn -= 1; g(wfree, wfn as usize) } else { wused += 1; wused - 1 };
            if w >= wcap { s(out, 6, g(out, 6) + 1); } else {
                for j in 0..nwc { super::nfs::spawn_put(wtab, wkind, j, w as usize, g(wdefs, j)); }
                s(wkix, qu, w);
            }
        }
        if ri(blk, ly.us + 4 * i) >= 0 {
            let r = if g(sthdr, 0) > 0 { s(sthdr, 0, g(sthdr, 0) - 1); g(stfree, g(sthdr, 0) as usize) } else { s(sthdr, 1, g(sthdr, 1) + 1); g(sthdr, 1) - 1 };
            if r >= stcap { s(out, 7, g(out, 7) + 1); } else { s(stix, qu, r); }
        }
        if !patch { s(uids, u0 + i, id); s(uslots, u0 + i, q); } else { s(nids, nnew, id); s(nslots, nnew, q); nnew += 1; }
        let mut hq = (id as u32).wrapping_mul(2654435761u32) & mask;
        while g(idt, hq as usize) != -1 { hq = (hq + 1) & mask; }
        s(idt, hq as usize, q);
        nb += 1;
    }
    // (A whole restore: the books for slots 0..n, as _simSlabFromLive and _simSlabRelist make them.)
    if !patch {
        let slabs = (n + 63) / 64;
        for sl in 0..slabs {
            let (a0, live_n) = (sl * 64, (n - sl * 64).min(64));
            for q in a0 + live_n..a0 + 64 { *bits.add(q >> 5) |= 1u32 << (q & 31); }
            s(sfree, sl, (64 - live_n) as u8);
        }
        // (The slabs' homes: the key of the unit in their first slot.)
        for i in 0..n { let q = g(bs, i); if q >= 0 && q & 63 == 0 { s(home, (q >> 6) as usize, g(keys, i)); } }
        s(hdr, 0, (slabs * 64 - n) as i32); s(hdr, 1, slabs as i32); s(hdr, 7, (slabs * 64) as i32);
        // Relist.
        s(hdr, 2, 0); s(hdr, 3, 0);
        for kk in 0..nk + 2 { s(heads, kk, 0); }
        let mut ec = 0i32;
        let mut push = |list: usize, slab: i32| { ec += 1; let at = (2 * ec) as usize; s(entries, at, slab); s(entries, at + 1, g(heads, list)); s(heads, list, at as i32); };
        for sl in 0..slabs {
            let f = g(sfree, sl) as i32;
            if f == 0 { continue; }
            if f == 64 { push(nk + 1, sl as i32); continue; }
            let h = g(home, sl);
            if h >= 0 { push(h as usize, sl as i32); }
            push(nk, sl as i32);
        }
        s(hdr, 2, ec);
        s(out, 8, slabs as i32);
    }
    s(out, 0, nb as i32); s(out, 1, hfn); s(out, 2, hnx); s(out, 3, wfn); s(out, 4, wused); s(out, 9, nnew as i32);
}

/// Decode, the columns (chunks of P[1] units): unit i's values from the block [0] (column table [1], P[2]
/// columns) into its slot (bs [2]): by slot, a word of its record, its worker record (unit.wkIx [3]) or its
/// status record (unit.stIx [4]; one it keeps that the block has none for: zero). Remapped columns through
/// remap [5]; esVer from the stats-behind bit (-2 behind, -3 not). Its tick-start and last positions
/// (unit.x0 [6], y0 [7], prevX [8], prevY [9]) its position (the block's x, y columns: P[3], P[4]), but a
/// patch's kept unit's last position (kept [10]). Its timers on (unit.tmOn [11] 1).
#[no_mangle]
pub unsafe extern "C" fn k_ub_scatter(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (blk, t, bs, wkix, stix, remap) = (k.p::<u8>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5));
    let (x0, y0, px, py, kept, tmon) = (k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9), k.p::<u8>(10), k.p::<u8>(11));
    let (n, per) = (k.i(0).max(0), k.i(1).max(1));
    let (cx, cy) = (k.i(3) as usize, k.i(4) as usize);
    let ncol = (ri(blk, 8).max(0) as usize).min(UB_MAX_COLS);
    let (nwk, nst, np, nodes) = (ri(blk, 12).max(0) as usize, ri(blk, 16).max(0) as usize, ri(blk, 20).max(0) as usize, ri(blk, 24).max(0) as usize);
    let mut off = [0usize; UB_MAX_COLS];
    let ly = layout(t, ncol, n as usize, nwk, nst, np, nodes, &mut off);
    let (j0, j1) = super::k::job_range(chunk, per, n);
    for j in 0..ncol {
        let base = waddr(ct(t, j, 0) as u32) as *mut u8;
        let (bytes, mode, rper, word, fl, mo, mn) = (ct(t, j, 1) as usize, ct(t, j, 2), ct(t, j, 3).max(1) as usize, ct(t, j, 4).max(0) as usize, ct(t, j, 5), ct(t, j, 6).max(0) as usize, ct(t, j, 7));
        let bb = bbytes(t, j);
        let src0 = blk.add(*off.get_unchecked(j));
        for i in j0..j1 {
            let q = g(bs, i);
            if q < 0 { continue; }
            let q = q as usize;
            let (at, el) = match mode {
                M_WK => { let r = ri(blk, ly.uw + 4 * i); let w = g(wkix, q); if r < 0 || w <= 0 { continue; } (r as usize, w as usize) }
                M_ST => {
                    let r = ri(blk, ly.us + 4 * i); let w = g(stix, q);
                    if w <= 0 { continue; }
                    if r < 0 { core::ptr::write_bytes(base.add(w as usize * bytes), 0, bytes); continue; }
                    (r as usize, w as usize)
                }
                M_WORD => (i, q * rper + word),
                _ => (i, q),
            };
            let src = src0.add(at * bb);
            let dst = base.add(el * bytes);
            if fl & F_BEHIND != 0 {
                wr_int(dst, bytes, if rd_int(src, 4, false) != 0 { -2 } else { -3 });
            } else if fl & F_REMAP != 0 {
                let v = rd_int(src, 4, false);
                let m = if v >= 0 && v < mn { g(remap, mo + v as usize) } else { v };
                wr_int(dst, bytes, m);
            } else {
                copy_el(src, dst, bytes);
            }
        }
    }
    for i in j0..j1 {
        let q = g(bs, i);
        if q < 0 { continue; }
        let q = q as usize;
        let (x, y) = (ri(blk, *off.get_unchecked(cx) + 4 * i), ri(blk, *off.get_unchecked(cy) + 4 * i));
        s(x0, q, x); s(y0, q, y);
        // (Its timers may run: the attack timer's setter marks it, the status kernel clears it once they are out.)
        if (!tmon.is_null()) { s(tmon, q, 1); }
        if kept.is_null() || g(kept, i) == 0 { s(px, q, x); s(py, q, y); }
    }
}

/// Decode, the paths (one job): the block's [0] paths (column table [1], P[0] units) into the path store
/// (arena [2], class free lists [3]; P[1] its top, P[3] its length in words). Phase P[2] 0: the words they
/// may take (out [5][0]: from the top). Phase 1: each path a block (its class's free list, else the top),
/// its nodes from the first carried (the ones before it: that one, never read again), its users its
/// references, generation kept (a reused block's) or 0; the units' (bs [6]) unit.pthH [4] (a patch's kept
/// unit's old path let go first): 0, 1, or the path's block + 2; out [5][0] the new top. Scratch [7]: a
/// word a path.
#[no_mangle]
pub unsafe extern "C" fn k_ub_paths(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (blk, t, arena, free, pth, out, bs, hs) = (k.p::<u8>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7));
    let (mvpath, pfs) = (k.p::<i32>(8), k.p::<i32>(9));
    let n = k.i(0).max(0) as usize;
    let (mut top, phase, alen) = (k.i(1).max(0) as usize, k.i(2), k.i(3).max(0) as usize);
    let ncol = (ri(blk, 8).max(0) as usize).min(UB_MAX_COLS);
    let (nwk, nst, np, nodes) = (ri(blk, 12).max(0) as usize, ri(blk, 16).max(0) as usize, ri(blk, 20).max(0) as usize, ri(blk, 24).max(0) as usize);
    let mut off = [0usize; UB_MAX_COLS];
    let ly = layout(t, ncol, n, nwk, nst, np, nodes, &mut off);
    let cls_of = |len: usize| -> usize { let need = 3 + 3 * len as u32; (32 - (need - 1).leading_zeros()).max(2) as usize };
    if phase == 0 {
        let mut need = 0usize;
        for kk in 0..np { need += 1usize << cls_of(ri(blk, ly.ptab + 12 * kk) as usize); }
        s(out, 0, need as i32);
        return;
    }
    // (The units' old paths let go first: a patch's kept units; a whole restore's slots hold none.)
    for i in 0..n {
        let q = g(bs, i);
        if q < 0 { continue; }
        path_release(pth, q as usize, arena, free);
        // (And its path window back to the pool (unit.mvPath [8], free stack [9]), as the path setter lets it go.)
        if !mvpath.is_null() && !pfs.is_null() { let w = g(mvpath, q as usize); if w >= 0 { let c = g(pfs, 0) + 1; s(pfs, 0, c); s(pfs, c as usize, w); s(mvpath, q as usize, -1); } }
    }
    let mut at = ly.nodes;
    for kk in 0..np {
        let (len, sk, users) = (ri(blk, ly.ptab + 12 * kk) as usize, ri(blk, ly.ptab + 12 * kk + 4) as usize, ri(blk, ly.ptab + 12 * kk + 8));
        let cls = cls_of(len);
        let mut b = g(free, cls);
        if b >= 0 { s(free, cls, g(arena, b as usize + 1)); }
        else {
            if top + (1usize << cls) > alen { s(out, 1, 1); s(hs, kk, 0); at += 12 * (len - sk); continue; }
            b = top as i32; top += 1usize << cls; s(arena, b as usize + 2, 0);
        }
        let bu = b as usize;
        s(arena, bu, (len as i32) | ((cls as i32) << 24));
        s(arena, bu + 1, users);
        let (t0, f0, r0) = (ri(blk, at), ri(blk, at + 4), ri(blk, at + 8));
        for j in 0..sk { let o = bu + 3 + 3 * j; s(arena, o, t0); s(arena, o + 1, f0); s(arena, o + 2, r0); }
        for j in sk..len {
            let o = bu + 3 + 3 * j;
            s(arena, o, ri(blk, at)); s(arena, o + 1, ri(blk, at + 4)); s(arena, o + 2, ri(blk, at + 8));
            at += 12;
        }
        s(hs, kk, b + 2);
    }
    for i in 0..n {
        let q = g(bs, i);
        if q < 0 { continue; }
        let r = ri(blk, ly.pref + 4 * i);
        s(pth, q as usize, if r < 2 { r } else { g(hs, (r - 2) as usize) });
    }
    s(out, 0, top as i32);
}

/// Decode, the target units' slots (chunks of P[1] units): unit.tuS [2] of each unit of bs [0] (P[0]) with a
/// target unit (unit.tuId [1] not 0): the slot the id hash [3] (mask P[2]; unit.id [4], unit.hnd [5]) holds
/// for it, -1 none.
#[no_mangle]
pub unsafe extern "C" fn k_ub_targets(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (bs, tuid, tus, idt, idc, hnd) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5));
    let (n, per, mask) = (k.i(0).max(0), k.i(1).max(1), k.i(2) as u32);
    let (j0, j1) = super::k::job_range(chunk, per, n);
    for i in j0..j1 {
        let q = g(bs, i);
        if q < 0 { continue; }
        let q = q as usize;
        let id = g(tuid, q);
        if id == 0 { s(tus, q, -1); continue; }
        let mut hq = (id as u32).wrapping_mul(2654435761u32) & mask;
        let mut sl = -1i32;
        loop {
            let v = g(idt, hq as usize);
            if v == -1 { break; }
            if v >= 0 && g(idc, v as usize) == id && g(hnd, v as usize) > 0 { sl = v; break; }
            hq = (hq + 1) & mask;
        }
        s(tus, q, sl);
    }
}

/// A base64 digit (computed: no static data in the module, wasm/build.cjs).
#[inline(always)]
fn b64c(v: u32) -> u8 {
    // (Branchless: a match became a lookup table, a data segment.)
    let d = (v & 63) as i32;
    (d + 65 + (((25 - d) >> 31) & 6) - (((51 - d) >> 31) & 75) - (((61 - d) >> 31) & 15) + (((62 - d) >> 31) & 3)) as u8
}
/// A base64 digit's value, -1 for a character not of the alphabet (branchless, as libsodium's).
#[inline(always)]
fn b64v(c: u8) -> i32 {
    let c = c as i32;
    let mut r = -1;
    r += (((0x40 - c) & (c - 0x5b)) >> 8) & (c - 64);
    r += (((0x60 - c) & (c - 0x7b)) >> 8) & (c - 70);
    r += (((0x2f - c) & (c - 0x3a)) >> 8) & (c + 5);
    r += (((0x2a - c) & (c - 0x2c)) >> 8) & 63;
    r += (((0x2e - c) & (c - 0x30)) >> 8) & 64;
    r
}

/// Base64 (standard, padded) of P[0] bytes [0] into [1] (4 * ceil(P[0] / 3) bytes).
#[no_mangle]
pub unsafe extern "C" fn k_b64_enc(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (src, dst) = (k.p::<u8>(0), k.p::<u8>(1));
    let n = k.i(0).max(0) as usize;
    // (The digits as a table on the stack: no static data; the arithmetic per digit cost 4x.)
    let mut tab = [0u8; 64];
    for d in 0..64u32 { *tab.get_unchecked_mut(d as usize) = b64c(core::hint::black_box(d)); }
    let (mut i, mut o) = (0usize, 0usize);
    while i + 3 <= n {
        let v = ((g(src, i) as u32) << 16) | ((g(src, i + 1) as u32) << 8) | g(src, i + 2) as u32;
        let w = (*tab.get_unchecked((v >> 18) as usize) as u32) | ((*tab.get_unchecked(((v >> 12) & 63) as usize) as u32) << 8)
            | ((*tab.get_unchecked(((v >> 6) & 63) as usize) as u32) << 16) | ((*tab.get_unchecked((v & 63) as usize) as u32) << 24);
        core::ptr::write_unaligned(dst.add(o) as *mut u32, w);
        i += 3; o += 4;
    }
    let r = n - i;
    if r > 0 {
        let v = ((g(src, i) as u32) << 16) | if r == 2 { (g(src, i + 1) as u32) << 8 } else { 0 };
        s(dst, o, b64c(v >> 18)); s(dst, o + 1, b64c((v >> 12) & 63));
        s(dst, o + 2, if r == 2 { b64c((v >> 6) & 63) } else { b'=' }); s(dst, o + 3, b'=');
    }
}

/// Base64 text [0] (P[0] bytes, a multiple of 4) to bytes [1]; out [2]: [0] the bytes, -1 a character not
/// of the alphabet.
#[no_mangle]
pub unsafe extern "C" fn k_b64_dec(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (src, dst, out) = (k.p::<u8>(0), k.p::<u8>(1), k.p::<i32>(2));
    let n = k.i(0).max(0) as usize;
    // (The values as a table on the stack, -1 not a digit: no static data.)
    let mut tab = [0i8; 256];
    for c in 0..256usize { *tab.get_unchecked_mut(c) = b64v(core::hint::black_box(c as u8)) as i8; }
    let val = |c: u8| -> i32 { *tab.get_unchecked(c as usize) as i32 };
    if n % 4 != 0 { s(out, 0, -1); return; }
    let (mut i, mut o) = (0usize, 0usize);
    // (Every quad but the last: four digits, three bytes.)
    while i + 4 < n {
        let (a0, a1, a2, a3) = (val(g(src, i)), val(g(src, i + 1)), val(g(src, i + 2)), val(g(src, i + 3)));
        if (a0 | a1 | a2 | a3) < 0 { s(out, 0, -1); return; }
        let v = ((a0 as u32) << 18) | ((a1 as u32) << 12) | ((a2 as u32) << 6) | a3 as u32;
        s(dst, o, (v >> 16) as u8); s(dst, o + 1, (v >> 8) as u8); s(dst, o + 2, v as u8);
        i += 4; o += 3;
    }
    while i < n {
        let (c2, c3) = (g(src, i + 2), g(src, i + 3));
        let (a0, a1) = (val(g(src, i)), val(g(src, i + 1)));
        let a2 = if c2 == b'=' { 0 } else { val(c2) };
        let a3 = if c3 == b'=' { 0 } else { val(c3) };
        if (a0 | a1 | a2 | a3) < 0 || (c2 == b'=' && c3 != b'=') || ((c2 == b'=' || c3 == b'=') && i + 4 != n) { s(out, 0, -1); return; }
        let v = ((a0 as u32) << 18) | ((a1 as u32) << 12) | ((a2 as u32) << 6) | a3 as u32;
        s(dst, o, (v >> 16) as u8); o += 1;
        if c2 != b'=' { s(dst, o, (v >> 8) as u8); o += 1; }
        if c3 != b'=' { s(dst, o, v as u8); o += 1; }
        i += 4;
    }
    s(out, 0, o as i32);
}

/// The units to send (one job): the id table's rows (ids [0], slots [1]; P[0] rows; holes -2 and units
/// without a slot -1 skipped, the latter counted in cnt [7][1]) in order: all (P[2] 1), or those standing
/// in a carried region (region bits [4]: (y / P[1]) * 1024 + x / P[1], positions unit.x [2], unit.y [3] in
/// eighths, P[1] a region's pixels) or marked (mark [5] by slot, P[3] 1). Their slots into out [6], the
/// count into cnt [7][0].
#[no_mangle]
pub unsafe extern "C" fn k_ub_select(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ids, slots, xs, ys, bits, mark, out, cnt) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<u32>(4), k.p::<u8>(5), k.p::<i32>(6), k.p::<i32>(7));
    let (n, ts, all, marked) = (k.i(0).max(0) as usize, k.f(1), k.i(2) == 1, k.i(3) == 1 && !mark.is_null());
    let _ = ids;
    let (mut m, mut loose) = (0usize, 0i32);
    for r in 0..n {
        let q = g(slots, r);
        if q == -1 { loose += 1; continue; }
        if q < 0 { continue; }
        let qu = q as usize;
        let take = all || (marked && g(mark, qu) != 0) || (!bits.is_null() && {
            let (x, y) = (g(xs, qu) as f64 * 0.125, g(ys, qu) as f64 * 0.125);
            let rg = floor(y / ts) * 1024.0 + floor(x / ts);
            rg >= 0.0 && rg < 1048576.0 && { let r2 = rg as usize; g(bits, r2 >> 5) & (1u32 << (r2 & 31)) != 0 }
        });
        if take { s(out, m, q); m += 1; }
    }
    s(cnt, 0, m as i32); s(cnt, 1, loose);
}

/// The units' order as runs of consecutive ids (start, count) from the id table (ids [0], slots [1]: holes
/// -2 skipped; P[0] rows) into out [2], its length into cnt [3][0].
#[no_mangle]
pub unsafe extern "C" fn k_ub_order(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ids, slots, out, cnt) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3));
    let n = k.i(0).max(0) as usize;
    let (mut w, mut start, mut run) = (0usize, 0i32, 0i32);
    for r in 0..n {
        if g(slots, r) == -2 { continue; }
        let id = g(ids, r);
        if run > 0 && id == start + run { run += 1; continue; }
        if run > 0 { s(out, w, start); s(out, w + 1, run); w += 2; }
        start = id; run = 1;
    }
    if run > 0 { s(out, w, start); s(out, w + 1, run); w += 2; }
    s(cnt, 0, w as i32);
}

/// A patch's units this peer has that the sender's order lacks (one job): the id table's rows (ids [0],
/// slots [1]; P[0] rows) whose id no run of the order (runs [2]: start, count; P[1] words, ascending)
/// covers: their slots into out [3] and the rows made holes (-2); cnt [4][0] how many (units without a
/// slot: [1], left to the caller, their rows not touched).
#[no_mangle]
pub unsafe extern "C" fn k_ub_drop(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ids, slots, runs, out, cnt) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4));
    let (n, nr) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize);
    let (mut j, mut m, mut loose) = (0usize, 0usize, 0i32);
    for r in 0..n {
        let q = g(slots, r);
        if q == -2 { continue; }
        let id = g(ids, r);
        while j + 1 < nr && g(runs, j) + g(runs, j + 1) <= id { j += 2; }
        let covered = j + 1 < nr && id >= g(runs, j) && id < g(runs, j) + g(runs, j + 1);
        if covered { continue; }
        if q < 0 { loose += 1; continue; }
        s(out, m, q); m += 1;
        s(slots, r, -2);
    }
    s(cnt, 0, m as i32); s(cnt, 1, loose);
}

/// A patch's new units into the id table (one job): rows ids [0], slots [1] (P[0] rows, ascending ids,
/// room for P[1] more) merged with the new ones (ids [2], slots [3], P[1] of them, ascending), from the back.
#[no_mangle]
pub unsafe extern "C" fn k_ub_uix_merge(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ids, slots, nids, nslots) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3));
    let (n, m) = (k.i(0).max(0) as isize, k.i(1).max(0) as isize);
    let (mut i, mut j, mut w) = (n - 1, m - 1, n + m - 1);
    while j >= 0 {
        if i >= 0 && g(ids, i as usize) > g(nids, j as usize) {
            s(ids, w as usize, g(ids, i as usize)); s(slots, w as usize, g(slots, i as usize)); i -= 1;
        } else {
            s(ids, w as usize, g(nids, j as usize)); s(slots, w as usize, g(nslots, j as usize)); j -= 1;
        }
        w -= 1;
    }
}

/// Units out of the unit index (chunk.js removeUnitSpatial's counts, one job): each slot of list [0] (P[0])
/// indexed this epoch (unit.spEpoch [1] = P[1], sepKey [2] not P[2]) leaves its chunk's counts (chunks of
/// one tile: the key its tile; owner unit.spOwner [3], type unit.spType [4]: ix.complex [5] (P[3] a chunk),
/// the type blocks' [6] (P[4] tiles a block, P[5] blocks wide, P[6] a block), the 8x8 blocks' [7] (P[7]
/// tiles, P[8] wide); P[9] players, P[10] types, P[11] chunks wide); then not indexed (sepKey P[2], spEpoch
/// 0, spTile -1 [8]) and not armed (mvOn [9]).
#[no_mangle]
pub unsafe extern "C" fn k_ub_spatial_out(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (list, spep, sepkey, spown, sptype, cplx, tcnt, bcnt, sptile, mvon) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<u32>(2), k.p::<i8>(3), k.p::<i16>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8), k.p::<u8>(9));
    let (n, ep, absent, sch, tb, tbw, sbl, bsz, bcols, np, nt, cw) = (k.i(0).max(0) as usize, k.i(1), k.f(2) as u32, k.i(3), k.i(4).max(1), k.i(5), k.i(6), k.i(7).max(1), k.i(8), k.i(9), k.i(10), k.i(11).max(1));
    for i in 0..n {
        let q = g(list, i);
        if q < 0 { continue; }
        let q = q as usize;
        let key = g(sepkey, q);
        if g(spep, q) == ep && key != absent {
            let (key, o, ty) = (key as i32, g(spown, q) as i32, g(sptype, q) as i32);
            if o >= 0 && o < np {
                if !cplx.is_null() { let j = (key * sch + o) as usize; s(cplx, j, g(cplx, j) - 1); }
                let (cx, cy) = (key % cw, key / cw);
                if !tcnt.is_null() && ty >= 0 { let j = (((cy / tb) * tbw + cx / tb) * sbl + o * nt + ty) as usize; s(tcnt, j, g(tcnt, j) - 1); }
                if !bcnt.is_null() { let j = (((cy / bsz) * bcols + cx / bsz) * np + o) as usize; s(bcnt, j, g(bcnt, j) - 1); }
            }
        }
        s(sepkey, q, absent); s(spep, q, 0); s(sptile, q, -1);
        if !mvon.is_null() { s(mvon, q, 0); }
    }
}

/// Each slot of list [0] (P[0]) its stat type (out [3] by slot) from its unit type (unit.upT [1]) through
/// map [2] (P[1] long; -1 none): for k.rs k_unit_stats_apply, which takes the type by slot.
#[no_mangle]
pub unsafe extern "C" fn k_ub_types(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (list, upt, map, out) = (k.p::<i32>(0), k.p::<i16>(1), k.p::<i8>(2), k.p::<i8>(3));
    let (n, nm) = (k.i(0).max(0) as usize, k.i(1));
    for i in 0..n {
        let q = g(list, i);
        if q < 0 { continue; }
        let t = g(upt, q as usize) as i32;
        s(out, q as usize, if t >= 0 && t < nm { g(map, t as usize) } else { -1 });
    }
}

/// Worker reservations as (slot, unit id) pairs (one job): every entry of the table [0] (P[0] long; 0 none),
/// or (P[1] 1) the entries of the units of list [1] (P[2] of them; their entry: unit.wkR [2] when the table
/// holds their id (unit.id [3]) there) outside the carried regions (bits [4]: a region of the entry's tile,
/// P[3] reservation kinds a tile, P[4] map width, P[5] a region's tiles). Into out [5], the words into
/// cnt [6][0].
#[no_mangle]
pub unsafe extern "C" fn k_ub_res(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (tab, list, wkr, idc, bits, out, cnt) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<u32>(4), k.p::<i32>(5), k.p::<i32>(6));
    let (tn, units, n, kinds, gw, rt) = (k.i(0).max(0) as usize, k.i(1) == 1, k.i(2).max(0) as usize, k.i(3).max(1), k.i(4).max(1), k.i(5).max(1));
    let mut w = 0usize;
    if !units {
        for r in 0..tn { let v = g(tab, r); if v != 0 { s(out, w, r as i32); s(out, w + 1, v); w += 2; } }
        s(cnt, 0, w as i32);
        return;
    }
    for i in 0..n {
        let q = g(list, i);
        if q < 0 { continue; }
        let q = q as usize;
        let r = g(wkr, q);
        if r < 0 || r as usize >= tn { continue; }
        let id = g(idc, q);
        if g(tab, r as usize) != id { continue; }
        let tile = r / kinds;
        let rg = ((tile / gw) / rt) * 1024 + (tile % gw) / rt;
        if !bits.is_null() && rg >= 0 && rg < 1048576 && g(bits, (rg >> 5) as usize) & (1u32 << (rg & 31)) != 0 { continue; }
        s(out, w, r); s(out, w + 1, id); w += 2;
    }
    s(cnt, 0, w as i32);
}

/// A patch's kept units' worker reservations let go (one job, before their columns are written): each unit
/// of the block's list that kept its slot (bs [0], kept [1]; P[0] units) whose entry (unit.wkR [2]) the table
/// [3] (P[1] long) holds its id (unit.id [4]) there: 0 (the patch's entries come after).
#[no_mangle]
pub unsafe extern "C" fn k_ub_res_drop(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (bs, kept, wkr, tab, idc) = (k.p::<i32>(0), k.p::<u8>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4));
    let (n, tn) = (k.i(0).max(0) as usize, k.i(1).max(0));
    for i in 0..n {
        if g(kept, i) == 0 { continue; }
        let q = g(bs, i);
        if q < 0 { continue; }
        let r = g(wkr, q as usize);
        if r >= 0 && r < tn && g(tab, r as usize) == g(idc, q as usize) { s(tab, r as usize, 0); }
    }
}

/// Units a patch drops, before their slots are let go (simUnitStateDetachGoneMany; as sim_unit_state.js
/// simUnitStateDetach): each slot of list [0] (P[0]) no stat rows (unit.statRow [1], bsRow [2] -1), not live
/// (unit.live [3], mvOut [4] 0), its path window back to the pool (unit.mvPath [5] -> -1, onto the free stack
/// [6]: [0] the count) and its path let go (unit.pthH [7]; path store arena [8], free lists [9]).
#[no_mangle]
pub unsafe extern "C" fn k_ub_unslot(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (list, srow, bsrow, live, mvout, mvpath, pfs, pth, arena, free) = (k.p::<i32>(0), k.p::<i16>(1), k.p::<i16>(2), k.p::<u8>(3), k.p::<u8>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9));
    let n = k.i(0).max(0) as usize;
    for i in 0..n {
        let q = g(list, i);
        if q < 0 { continue; }
        let q = q as usize;
        s(srow, q, -1); s(bsrow, q, -1); s(live, q, 0); s(mvout, q, 0);
        let w = g(mvpath, q);
        if w >= 0 && !pfs.is_null() { let c = g(pfs, 0) + 1; s(pfs, 0, c); s(pfs, c as usize, w); s(mvpath, q, -1); }
        path_release(pth, q, arena, free);
    }
}

/// A patch that made some players' stat tables again (things_utils.js effStatsAllUnits): every unit (the id
/// table's slots [0], P[0] rows; holes and units without a slot skipped) but those of the owners whose tables
/// changed (owners [2]: 1 a player, P[2] players; unit.owner [1]) that the patch did not carry (its units'
/// slots [3], P[1] of them; mark [4] by slot, cleared after) marked taken (unit.esTaken [5] = P[3]).
#[no_mangle]
pub unsafe extern "C" fn k_ub_eff_taken(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (rows, own, owners, list, mark, taken) = (k.p::<i32>(0), k.p::<i8>(1), k.p::<u8>(2), k.p::<i32>(3), k.p::<u8>(4), k.p::<i32>(5));
    let (n, m, np, stamp) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2), k.i(3));
    for i in 0..m { let q = g(list, i); if q >= 0 { s(mark, q as usize, 1); } }
    for r in 0..n {
        let q = g(rows, r);
        if q < 0 { continue; }
        let q = q as usize;
        let o = g(own, q) as i32;
        let stale = o >= 0 && o < np && g(owners, o as usize) != 0;
        if !stale || g(mark, q) != 0 { s(taken, q, stamp); }
    }
    for i in 0..m { let q = g(list, i); if q >= 0 { s(mark, q as usize, 0); } }
}

/// The pending way wheel made again (pathfinding.js resetPendingPathUnits; one job): each unit of the id
/// table (slots [0], P[0] rows; holes and units without a slot skipped), in id order, alive (unit.dead [1] 0)
/// with a pending target (unit.ptSt [2] bits 0-1 = 2), linked at the head of its due tick's bucket (heads
/// [4], P[2] buckets, a power of two; unit.ppNext [5], ppPrev [6], ppDue [7]): due its retry tick (the Float64
/// column [3], NaN none) when past P[1] + 1, else P[1] + 1 (P[1] the game time). The heads and ppDue are -1
/// before. out [8][0]: how many.
#[no_mangle]
pub unsafe extern "C" fn k_pp_reset(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (rows, dead, ptst, retry, heads, nxt, prv, due, out) = (k.p::<i32>(0), k.p::<u8>(1), k.p::<u8>(2), k.p::<f64>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8));
    let (n, gt, nb) = (k.i(0).max(0) as usize, k.f(1), k.i(2).max(1));
    let mut cnt = 0i32;
    for r in 0..n {
        let q = g(rows, r);
        if q < 0 { continue; }
        let q = q as usize;
        if g(dead, q) != 0 || g(ptst, q) & 3 != 2 { continue; }
        let rt = if retry.is_null() { f64::NAN } else { g(retry, q) };
        let t = if rt.is_finite() && rt > gt + 1.0 { rt } else { gt + 1.0 };
        let ti = t as i32;
        let b = (ti & (nb - 1)) as usize;
        let h = g(heads, b);
        s(nxt, q, h); s(prv, q, -1);
        if h >= 0 { s(prv, h as usize, q as i32); }
        s(heads, b, q as i32); s(due, q, ti);
        cnt += 1;
    }
    s(out, 0, cnt);
}

/// Every unit let go at once (sim_unit_state.js simUnitStateReleaseAll; one job): each slot below P[0] with
/// a handle (unit.hnd [0]) gives it back (hslot [1] -1, generation hgen [2] one more, its gone record hg [3]:
/// id [4], owner [5], x [6], y [7] as the release kernel writes it; onto the free stack hfree [8] from P[1]),
/// unit.hnd 0. out [9][0]: the free stack's count.
#[no_mangle]
pub unsafe extern "C" fn k_ub_release_all(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (hnd, hslot, hgen, hg, idc, own, xs, ys, hfree, out) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<u32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i8>(5), k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9));
    let (n, mut hfn) = (k.i(0).max(0) as usize, k.i(1).max(0));
    for q in 0..n {
        let h = g(hnd, q);
        if h <= 0 { continue; }
        let hu = h as usize;
        s(hgen, hu, g(hgen, hu).wrapping_add(1));
        s(hg, 4 * hu, g(idc, q)); s(hg, 4 * hu + 1, g(own, q) as i32); s(hg, 4 * hu + 2, g(xs, q)); s(hg, 4 * hu + 3, g(ys, q));
        s(hslot, hu, -1); s(hnd, q, 0);
        s(hfree, hfn as usize, h); hfn += 1;
    }
    s(out, 0, hfn);
}

/// Slots holding a unit the id table does not (one job; a patch's collection, as simUnitStateCollect after a
/// new units list): the id table's slots (rows [1], P[1] of them) marked (mark [2] by slot, cleared after),
/// then each slot below P[0] with a handle (unit.hnd [0]) not marked into out [3], their count into cnt [4][0].
#[no_mangle]
pub unsafe extern "C" fn k_ub_ghosts(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (hnd, rows, mark, out, cnt) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<u8>(2), k.p::<i32>(3), k.p::<i32>(4));
    let (n, nr) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize);
    for r in 0..nr { let q = g(rows, r); if q >= 0 && (q as usize) < n { s(mark, q as usize, 1); } }
    let mut m = 0usize;
    for q in 0..n {
        if g(hnd, q) > 0 && g(mark, q) == 0 { s(out, m, q as i32); m += 1; }
    }
    for r in 0..nr { let q = g(rows, r); if q >= 0 && (q as usize) < n { s(mark, q as usize, 0); } }
    s(cnt, 0, m as i32);
}
