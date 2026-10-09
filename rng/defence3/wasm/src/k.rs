//! Kernels ported from JavaScript (src/sim/sim_parallel.js and others): Rust
//! only, written for speed (native integer / f32 arithmetic), deterministic.
//!
//! Calling convention (sim_parallel.js _simRust): the thread's argument
//! block holds the kernel's array addresses as 32-bit words from word 512
//! (in the order of its _simWK name list; 0 for an unbound optional one)
//! and its params P as doubles at byte 4096. Each kernel takes (block,
//! chunk).
use super::*;

pub struct K {
    w: *const i32,
    f: *const f64,
}
impl K {
    #[inline(always)]
    pub unsafe fn new(a: *const i32) -> K {
        K { w: a.add(512), f: (a as usize + 4096) as *const f64 }
    }
    /// Array i's address as a typed pointer (null when unbound).
    #[inline(always)]
    pub unsafe fn p<T>(&self, i: usize) -> *mut T {
        *self.w.add(i) as u32 as usize as *mut T
    }
    #[inline(always)]
    pub unsafe fn f(&self, i: usize) -> f64 {
        *self.f.add(i)
    }
    /// P[i] as an integer (`| 0`-like for the values passed: whole numbers).
    #[inline(always)]
    pub unsafe fn i(&self, i: usize) -> i32 {
        *self.f.add(i) as i32
    }
}

#[inline(always)]
unsafe fn g<T: Copy>(p: *const T, i: usize) -> T {
    *p.add(i)
}
#[inline(always)]
unsafe fn s<T>(p: *mut T, i: usize, v: T) {
    *p.add(i) = v;
}
#[inline(always)]
fn job(chunk: i32, per: i32, n: i32) -> (usize, usize) {
    let a = (chunk.max(0) as i64 * per.max(0) as i64).min(n.max(0) as i64) as usize;
    let b = (a as i64 + per.max(0) as i64).min(n.max(0) as i64) as usize;
    (a, b)
}

// =====================================================================
// THE UNIT INDEX (chunk.js spatialIndexPrebuild / _spatialIndexRebuildParallel)
// =====================================================================

/// SIM_KERNEL_INDEX_KEYS: per units index its chunk (every unit not dead, by
/// the tile it stands on, clamped to the map; else nChunks) and that tile's
/// area (none: A). A units index without a slot sets ix.bad.
/// Arrays: ix.slots, unit.x, unit.y, unit.dead, ix.agrid, ix.keys, ix.areas, ix.bad.
/// P: [0] units, [1] per job, [2] chunks, [3] areas, [9] tile, [10] W, [11] H,
/// [12] chunk size, [13] chunks across.
#[no_mangle]
pub unsafe extern "C" fn k_ix_keys(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (sl, xs, ys, dead, ag) = (k.p::<i32>(0), k.p::<f32>(1), k.p::<f32>(2), k.p::<u8>(3), k.p::<i32>(4));
    let (keys, areas, bad) = (k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7));
    let (n, per, nch, na) = (k.i(0), k.i(1), k.i(2), k.i(3));
    let itile = (1.0 / k.f(9)) as f32;
    let (gw, gh, cs, cw) = (k.i(10), k.i(11), k.i(12), k.i(13));
    let (i0, i1) = job(chunk, per, n);
    for i in i0..i1 {
        let si = g(sl, i);
        if si < 0 {
            s(keys, i, nch);
            s(areas, i, na);
            s(bad, 0, 1);
            continue;
        }
        let su = si as usize;
        if g(dead, su) != 0 {
            s(keys, i, nch);
            s(areas, i, na);
            continue;
        }
        let fx = floorf(g(xs, su) * itile);
        let fy = floorf(g(ys, su) * itile);
        // (NaN: 0, as the clamp of a non-number.)
        let gx = if !(fx >= 0.0) { 0 } else if fx >= gw as f32 { gw - 1 } else { fx as i32 };
        let gy = if !(fy >= 0.0) { 0 } else if fy >= gh as f32 { gh - 1 } else { fy as i32 };
        let key = if cs == 1 { gy * gw + gx } else { idiv(gy, cs) * cw + idiv(gx, cs) };
        s(keys, i, if key >= 0 && key < nch { key } else { nch });
        let ar = g(ag, (gy * gw + gx) as usize);
        s(areas, i, if ar >= 0 && ar < na { ar } else { na });
    }
}

#[inline(always)]
fn floorf(v: f32) -> f32 {
    let t = v as i32 as f32;
    if v.is_nan() { v } else if t > v { t - 1.0 } else { t }
}

/// In-place heapsort of u64 keys (distinct): no allocation, no panics.
unsafe fn heapsort_u64(v: *mut u64, n: usize) {
    if n < 2 {
        return;
    }
    let sift = |v: *mut u64, mut root: usize, end: usize| {
        loop {
            let mut c = 2 * root + 1;
            if c >= end {
                break;
            }
            if c + 1 < end && *v.add(c + 1) > *v.add(c) {
                c += 1;
            }
            if *v.add(root) >= *v.add(c) {
                break;
            }
            core::ptr::swap(v.add(root), v.add(c));
            root = c;
        }
    };
    let mut i = n / 2;
    while i > 0 {
        i -= 1;
        sift(v, i, n);
    }
    let mut end = n;
    while end > 1 {
        end -= 1;
        core::ptr::swap(v, v.add(end));
        sift(v, 0, end);
    }
}

/// SIM_KERNEL_INDEX_MERGE (one job): the index order ix.ordC (units indices
/// by (chunk, index)) from the last index: its entries whose unit holds the
/// same slot and stands in the same chunk keep their order; the others are
/// sorted by (chunk, index) and merged in; units without a chunk after.
/// Disorder among the kept ones (never expected): everything sorted.
/// Arrays: sep.eslot, sep.ekey, ix.eid, ix.keys, ix.slots, unit.id, ix.inv,
/// ix.invStamp, ix.kept, ix.ordC, ix.chg (u64 work, as many as units).
/// P: [0] units, [1] last entries, [2] chunks, [3] epoch.
#[no_mangle]
pub unsafe extern "C" fn k_ix_merge(a: *const i32, _chunk: i32) {
    let k = K::new(a);
    let (es, ek, eid, key, sl, uid) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5));
    let (inv, invs, kept, out, ch) = (k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9), k.p::<u64>(10));
    let (n, prev, nch, ep) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2), k.i(3));
    for i in 0..n {
        let sv = g(sl, i);
        if sv >= 0 {
            s(inv, sv as usize, i as i32);
            s(invs, sv as usize, ep);
        }
    }
    let mut kn = 0usize;
    let mut sorted = true;
    let (mut lk, mut li) = (-1i32, -1i32);
    for p in 0..prev {
        let sv = g(es, p);
        if sv < 0 || g(invs, sv as usize) != ep {
            continue;
        }
        let i = g(inv, sv as usize);
        let kk = g(key, i as usize);
        if kk >= nch || kk != g(ek, p) || g(uid, sv as usize) != g(eid, p) {
            continue;
        }
        s(kept, i as usize, ep);
        if kk < lk || (kk == lk && i < li) {
            sorted = false;
        }
        lk = kk;
        li = i;
        s(out, kn, i);
        kn += 1;
    }
    let mut m = 0usize;
    if sorted {
        for i in 0..n {
            let kk = g(key, i);
            if kk < nch && g(kept, i) != ep {
                s(ch, m, ((kk as u64) << 32) | i as u64);
                m += 1;
            }
        }
    } else {
        for i in 0..n {
            let kk = g(key, i);
            if kk < nch {
                s(ch, m, ((kk as u64) << 32) | i as u64);
                m += 1;
            }
        }
        kn = 0;
    }
    heapsort_u64(ch, m);
    // Merge from the back (out's front holds the kept ones).
    let mut ai = kn as isize - 1;
    let mut bi = m as isize - 1;
    let mut w = kn as isize + m as isize - 1;
    while bi >= 0 {
        let cb = g(ch, bi as usize);
        let (kb, ib) = ((cb >> 32) as i32, (cb & 0xFFFF_FFFF) as i32);
        if ai >= 0 {
            let ia = g(out, ai as usize);
            let ka = g(key, ia as usize);
            if ka > kb || (ka == kb && ia > ib) {
                s(out, w as usize, ia);
                ai -= 1;
                w -= 1;
                continue;
            }
        }
        s(out, w as usize, ib);
        bi -= 1;
        w -= 1;
    }
    // (The units without a chunk after them.)
    let mut t = kn + m;
    let mut i = 0usize;
    while i < n && t < n {
        if !(g(key, i) < nch) {
            s(out, t, i as i32);
            t += 1;
        }
        i += 1;
    }
}

/// SIM_KERNEL_INDEX_FILL: per position in key order its unit's slot (and
/// chunk and id), and where each key's range starts (stamped); ix.listed[k]
/// the first position past the valid keys. P[14] 1: areas (ix.ordA,
/// ix.areas -> ix.aslot, ix.astart, ix.astamp), else chunks (ix.ordC,
/// ix.keys -> sep.eslot, sep.ekey, ix.eid, ix.start, ix.stamp).
/// Arrays: ix.slots, ord, key, out slots, out keys (chunks), start, stamp,
/// ix.listed, ix.eid (chunks), unit.id.
/// P: [0] units, [1] per job, [2] chunks, [3] areas, [14] areas?, [15] epoch.
#[no_mangle]
pub unsafe extern "C" fn k_ix_fill(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let area = k.i(14) == 1;
    let (sl, ord, key, outs, outk, start, stamp, listed, eidp, uid) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4),
        k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9));
    let lim = if area { k.i(3) } else { k.i(2) };
    let ep = k.i(15);
    let (i0, i1) = job(chunk, k.i(1), k.i(0));
    for pos in i0..i1 {
        let i = g(ord, pos) as usize;
        let kk = g(key, i);
        if kk >= lim {
            if pos == 0 || g(key, g(ord, pos - 1) as usize) < lim {
                s(listed, if area { 1 } else { 0 }, pos as i32);
            }
            continue;
        }
        let sv = g(sl, i);
        s(outs, pos, sv);
        if !eidp.is_null() && !area {
            s(eidp, pos, if sv >= 0 { g(uid, sv as usize) } else { -1 });
        }
        if !outk.is_null() && !area {
            s(outk, pos, kk);
        }
        if pos == 0 || g(key, g(ord, pos - 1) as usize) != kk {
            s(start, kk as usize, pos as i32);
            s(stamp, kk as usize, ep);
        }
    }
}

/// SIM_KERNEL_INDEX_RUNS: each key's count at the end of its range; for
/// areas, the units of each owner too (counted by the range's first
/// position). Arrays: ix.slots, ord, key, start, cnt, ix.listed, ix.aown,
/// unit.owner. P as INDEX_FILL's, [4] players.
#[no_mangle]
pub unsafe extern "C" fn k_ix_runs(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let area = k.i(14) == 1;
    let (sl, ord, key, start, cnt, listed, aown, own) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4),
        k.p::<i32>(5), k.p::<i32>(6), k.p::<i8>(7));
    let players = k.i(4).max(0) as usize;
    let nl = g(listed, if area { 1 } else { 0 });
    let (i0, i1) = job(chunk, k.i(1), nl);
    let nlu = nl.max(0) as usize;
    for pos in i0..i1 {
        let kk = g(key, g(ord, pos) as usize);
        if pos + 1 == nlu || g(key, g(ord, pos + 1) as usize) != kk {
            s(cnt, kk as usize, pos as i32 + 1 - g(start, kk as usize));
        }
        if area && (pos == 0 || g(key, g(ord, pos - 1) as usize) != kk) {
            let o0 = kk as usize * players;
            for p in 0..players {
                s(aown, o0 + p, 0);
            }
            let mut q = pos;
            while q < nlu {
                let i = g(ord, q) as usize;
                if g(key, i) != kk {
                    break;
                }
                let o = g(own, g(sl, i) as usize) as i32;
                if o >= 0 && (o as usize) < players {
                    let c = aown.add(o0 + o as usize);
                    *c += 1;
                }
                q += 1;
            }
        }
    }
}

/// SIM_KERNEL_TILE_OWNERS: per tile of the unit index its owners' bits
/// (ix.omask: bit p for player p, 0xFF for owners past 7). A job owns the
/// runs that start in its range. Arrays: sep.eslot, sep.ekey, unit.owner,
/// ix.omask, ix.listed. P: [0] entries, [1] per job, [2] 1: ix.listed[0].
#[no_mangle]
pub unsafe extern "C" fn k_tile_owners(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (es, ek, own, msk, listed) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i8>(2), k.p::<u8>(3), k.p::<i32>(4));
    let n = if k.i(2) == 1 { g(listed, 0) } else { k.i(0) };
    let nu = n.max(0) as usize;
    let (e0, e1) = job(chunk, k.i(1), n);
    for e in e0..e1 {
        let kk = g(ek, e);
        if e > 0 && g(ek, e - 1) == kk {
            continue;
        }
        let mut m = 0u32;
        let mut gi = e;
        while gi < nu && g(ek, gi) == kk {
            let q = g(es, gi);
            if q >= 0 {
                let o = g(own, q as usize) as i32;
                m |= if o >= 0 && o < 8 { 1 << o } else { 0xFF };
            }
            gi += 1;
        }
        s(msk, kk as usize, m as u8);
    }
}

#[inline(always)]
unsafe fn atomic_add(p: *mut i32, i: usize, v: i32) {
    (*(p.add(i) as *const core::sync::atomic::AtomicI32)).fetch_add(v, core::sync::atomic::Ordering::Relaxed);
}

/// SIM_KERNEL_SP_COUNTS: the movement and separation kernels' chunk moves
/// (unit.spMvOwn: owner + 1, from spMvOld to spMvNew) into the counts: the
/// owner's total per chunk (ix.complex), per 8x8 block (ix.bcount, the
/// moves between blocks) and its type's per type block (spatial.types).
/// Atomic integer adds (chunks are shared between slots).
/// Arrays: unit.spMvOld, unit.spMvNew, unit.spMvOwn, unit.spType, ix.complex,
/// ix.bcount, spatial.types. P: [0] slots, [1] per job, [2] players, [3]
/// stride per chunk, [4] stride per player, [5] chunks wide, [6] blocks
/// wide, [7] block size, [8] unit types, [9] type blocks wide, [10] type
/// block size, [11] ix.bcount's length.
#[no_mangle]
pub unsafe extern "C" fn k_sp_counts(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (mvo, mvn, mvw, spty, cx, bcn, tc) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i8>(2), k.p::<i16>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6));
    let (np, sc, sp, cw, bw, bs, nt, tw, tb) = (k.i(2), k.i(3), k.i(4), k.i(5), k.i(6), k.i(7), k.i(8), k.i(9), k.i(10));
    let nb = k.i(11);
    let ts = np * nt;
    let (s0, s1) = job(chunk, k.i(1), k.i(0));
    // (Sixteen slots at a time without a move: the common case.)
    let mut q = s0;
    while q < s1 {
        if q + 16 <= s1 && !v128_any_true(v128_load(mvw.add(q) as *const v128)) {
            q += 16;
            continue;
        }
        let w = g(mvw, q) as i32;
        if w == 0 {
            q += 1;
            continue;
        }
        s(mvw, q, 0);
        let owner = w - 1;
        if !(owner < np) {
            q += 1;
            continue;
        }
        let ty = g(spty, q) as i32;
        let (ko, kn) = (g(mvo, q), g(mvn, q));
        atomic_add(cx, (ko * sc + owner * sp) as usize, -1);
        atomic_add(cx, (kn * sc + owner * sp) as usize, 1);
        let (oy, ny) = (idiv(ko, cw), idiv(kn, cw));
        let (ox, nx) = (ko - oy * cw, kn - ny * cw);
        let bo = (idiv(oy, bs) * bw + idiv(ox, bs)) * np + owner;
        let bn = (idiv(ny, bs) * bw + idiv(nx, bs)) * np + owner;
        if bo != bn {
            if bo >= 0 && bo < nb { atomic_add(bcn, bo as usize, -1); }
            if bn >= 0 && bn < nb { atomic_add(bcn, bn as usize, 1); }
        }
        if ty >= 0 {
            let to = (idiv(oy, tb) * tw + idiv(ox, tb)) * ts + owner * nt + ty;
            let tn = (idiv(ny, tb) * tw + idiv(nx, tb)) * ts + owner * nt + ty;
            if to != tn {
                atomic_add(tc, to as usize, -1);
                atomic_add(tc, tn as usize, 1);
            }
        }
        q += 1;
    }
}

/// SIM_KERNEL_STATUS (unit.js statusPrepassRun): per unit (units index i,
/// slot ix.slots[i]) its tick-start position (x0, y0; with P[4] 1 also the
/// separation's radius, layer and dead), then, alive, its status effects
/// counted down and their damage dealt (stOn units only), death at no
/// energy, its attack timers counted down (tmOn units only). Events
/// (unit.stEv: 1 damage reported, unit.stDot the amount; 2 its watch ended;
/// 4 died): damage over time summed in unit.stAcc and reported every P[3]
/// ticks by id or at death; the job's units with events listed at
/// st.list[chunk * P[1]..], how many at st.count[chunk].
/// Arrays (in order): ix.slots, unit.dead, unit.energy, unit.attackTimer,
/// unit.attackFlash, unit.teleportHideTicks, unit.burning,
/// unit.burnTickDamage, unit.poisoned, unit.poisonTickDamage, unit.frozen,
/// unit.iceTickDamage, unit.wet, unit.sandy, unit.watched, unit.stEv,
/// unit.stDot, st.count, unit.x, unit.y, unit.x0, unit.y0,
/// unit.workerTransferCooldown, unit.stAcc, unit.id, unit.sepD0, unit.sepR0,
/// unit.sepL0, unit.collisionR, unit.r, unit.sepLayer, unit.stOn,
/// unit.tmOn, ?st.list. P: [0] units, [1] per job, [2] tick, [3] report
/// period, [4] 1: the separation's copy.
#[no_mangle]
pub unsafe extern "C" fn k_status(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let sl = k.p::<i32>(0);
    let dead = k.p::<u8>(1);
    let en = k.p::<f32>(2);
    let at = k.p::<f32>(3);
    let af = k.p::<u8>(4);
    let th = k.p::<i32>(5);
    let bu = k.p::<i32>(6);
    let bd = k.p::<f32>(7);
    let po = k.p::<i32>(8);
    let pd = k.p::<f32>(9);
    let fr = k.p::<i32>(10);
    let idm = k.p::<f32>(11);
    let we = k.p::<i32>(12);
    let sa = k.p::<i32>(13);
    let wa = k.p::<i32>(14);
    let ev_ = k.p::<u8>(15);
    let dotp = k.p::<f32>(16);
    let cnt = k.p::<i32>(17);
    let (xs, ys, x0, y0) = (k.p::<f32>(18), k.p::<f32>(19), k.p::<f32>(20), k.p::<f32>(21));
    let wtc = k.p::<i32>(22);
    let acc_ = k.p::<f32>(23);
    let uid = k.p::<i32>(24);
    let (sd0, sr0, sl0, cr, rad, lay) = (k.p::<u8>(25), k.p::<f32>(26), k.p::<u8>(27), k.p::<f32>(28), k.p::<f32>(29), k.p::<u8>(30));
    let (on, ton, list) = (k.p::<u8>(31), k.p::<u8>(32), k.p::<i32>(33));
    let t = k.i(2);
    let per = k.i(3).max(1);
    let sep_copy = k.i(4) == 1;
    let (i0, i1) = job(chunk, k.i(1), k.i(0));
    let mut n = 0usize;
    for i in i0..i1 {
        let si = g(sl, i);
        if si < 0 {
            continue;
        }
        let s_ = si as usize;
        s(x0, s_, g(xs, s_));
        s(y0, s_, g(ys, s_));
        if sep_copy {
            let c = g(cr, s_);
            let r = if c != 0.0 && c == c { c } else { let r0 = g(rad, s_); if r0 != 0.0 && r0 == r0 { r0 } else { 0.1 } };
            s(sr0, s_, if r > 0.1 { r } else { 0.1 });
            s(sl0, s_, g(lay, s_));
            s(sd0, s_, g(dead, s_));
        }
        if g(dead, s_) != 0 {
            continue;
        }
        let mut ev = 0u8;
        let mut dot = 0.0f32;
        if g(on, s_) != 0 {
            let mut e = g(en, s_);
            if g(th, s_) > 0 { s(th, s_, g(th, s_) - 1); }
            if g(bu, s_) > 0 {
                s(bu, s_, g(bu, s_) - 1);
                let d = g(bd, s_);
                if d > 0.0 { e -= d; dot += d; ev = 1; }
            }
            if g(po, s_) > 0 {
                s(po, s_, g(po, s_) - 1);
                let d = g(pd, s_);
                if d > 0.0 { e -= d; dot += d; ev = 1; }
            }
            if g(fr, s_) > 0 && g(we, s_) > 0 && g(idm, s_) > 0.0 {
                let d = g(idm, s_) * 1.5;
                e -= d; dot += d; ev = 1;
            }
            if g(fr, s_) > 0 { s(fr, s_, g(fr, s_) - 1); }
            if g(we, s_) > 0 { s(we, s_, g(we, s_) - 1); }
            if g(sa, s_) > 0 { s(sa, s_, g(sa, s_) - 1); }
            if g(wa, s_) > 0 {
                let w = g(wa, s_) - 1;
                s(wa, s_, w);
                if w <= 0 { ev |= 2; }
            }
            s(en, s_, e);
            if !(g(th, s_) > 0 || g(bu, s_) > 0 || g(po, s_) > 0 || g(fr, s_) > 0 || g(we, s_) > 0 || g(sa, s_) > 0 || g(wa, s_) > 0) {
                s(on, s_, 0);
            }
        }
        if g(en, s_) <= 0.0 {
            s(dead, s_, 1);
            ev |= 4;
        } else if g(ton, s_) != 0 {
            if g(at, s_) > 0.0 { s(at, s_, g(at, s_) - 1.0); }
            if g(af, s_) > 0 { s(af, s_, g(af, s_) - 1); }
            if g(wtc, s_) > 0 { s(wtc, s_, g(wtc, s_) - 1); }
            if !(g(at, s_) > 0.0 || g(af, s_) > 0 || g(wtc, s_) > 0) {
                s(ton, s_, 0);
            }
        }
        let acc = g(acc_, s_) + dot;
        ev &= !1;
        if acc > 0.0 && ((ev & 4) != 0 || (t as i64 + g(uid, s_) as i64).rem_euclid(per as i64) == 0) {
            ev |= 1;
            dot = acc;
            s(acc_, s_, 0.0);
        } else if dot != 0.0 {
            s(acc_, s_, acc);
        }
        if ev != 0 {
            s(ev_, s_, ev);
            s(dotp, s_, dot);
            if !list.is_null() {
                s(list, i0 + n, i as i32);
            }
            n += 1;
        }
    }
    s(cnt, chunk as usize, n as i32);
}

/// SIM_KERNEL_HELD_DEAD: after the unit pass, units the movement kernel
/// moved or held (outputs 1-9, 11, 12) whose energy ran out during it are
/// dead now, where they stood (moved ones back at their previous place;
/// held ones (6) stay). Arrays: unit.mvOut, unit.energy, unit.dead, unit.x,
/// unit.y, unit.prevX, unit.prevY. P: [0] slots, [1] per job.
#[no_mangle]
pub unsafe extern "C" fn k_held_dead(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (out, en, dead, xs, ys, px, py) = (k.p::<u8>(0), k.p::<f32>(1), k.p::<u8>(2), k.p::<f32>(3), k.p::<f32>(4), k.p::<f32>(5), k.p::<f32>(6));
    let (s0, s1) = job(chunk, k.i(1), k.i(0));
    let mut q = s0;
    while q < s1 {
        // (Sixteen without a kernel output at once.)
        if q + 16 <= s1 && !v128_any_true(v128_load(out.add(q) as *const v128)) {
            q += 16;
            continue;
        }
        let o = g(out, q);
        if !(o == 0 || o == 10 || o >= 13 || o == 4 || o == 5 || g(en, q) > 0.0 || g(dead, q) != 0) {
            s(dead, q, 1);
            if o != 6 {
                s(xs, q, g(px, q));
                s(ys, q, g(py, q));
            }
        }
        q += 1;
    }
}

/// SIM_KERNEL_UPD_CAND: per block of P[1] units-array indices those still
/// needing their update (no slot, or a kernel output 0, 10, 13 and above,
/// or a drive-by shot), in index order at upd.cand[block * P[1]..], how
/// many at upd.cnt[block]. Arrays: ix.slots, unit.mvOut, unit.mvFire,
/// upd.cand, upd.cnt. P: [0] units, [1] block size, [2] blocks per job.
#[no_mangle]
pub unsafe extern "C" fn k_upd_cand(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (sl, out, fire, cand, cnt) = (k.p::<i32>(0), k.p::<u8>(1), k.p::<u8>(2), k.p::<i32>(3), k.p::<i32>(4));
    let (n, bsz, per) = (k.i(0).max(0) as usize, k.i(1).max(1) as usize, k.i(2).max(0) as usize);
    let nb = (n + bsz - 1) / bsz;
    let b0 = (chunk.max(0) as usize * per).min(nb);
    let b1 = (b0 + per).min(nb);
    for b in b0..b1 {
        let mut m = 0usize;
        let end = ((b + 1) * bsz).min(n);
        for idx in b * bsz..end {
            let sv = g(sl, idx);
            if sv >= 0 {
                let o = g(out, sv as usize);
                if o != 0 && o != 10 && o < 13 && g(fire, sv as usize) == 0 {
                    continue;
                }
            }
            s(cand, b * bsz + m, idx as i32);
            m += 1;
        }
        s(cnt, b, m as i32);
    }
}

/// SIM_KERNEL_UNIT_RETIRE: the tick's end: movement outputs cleared (slots
/// of the job's range), the units-array indices of dead units (or without a
/// slot) listed at retire.list[chunk * P[1]..], how many at
/// retire.count[chunk]. Arrays: ix.slots, unit.dead, unit.mvOut,
/// retire.list, retire.count. P: [0] units, [1] block size, [2] slots.
#[no_mangle]
pub unsafe extern "C" fn k_unit_retire(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (sl, dead, out, list, cnt) = (k.p::<i32>(0), k.p::<u8>(1), k.p::<u8>(2), k.p::<i32>(3), k.p::<i32>(4));
    let (o0, o1) = job(chunk, k.i(1), k.i(2));
    if o1 > o0 {
        core::ptr::write_bytes(out.add(o0), 0, o1 - o0);
    }
    let (i0, i1) = job(chunk, k.i(1), k.i(0));
    let mut n = 0usize;
    let start = chunk.max(0) as usize * k.i(1).max(0) as usize;
    for i in i0..i1 {
        let sv = g(sl, i);
        if sv < 0 || g(dead, sv as usize) != 0 {
            s(list, start + n, i as i32);
            n += 1;
        }
    }
    s(cnt, chunk as usize, n as i32);
}

/// SIM_KERNEL_ACQ_COMMIT: the acquisition tier's answers into the units'
/// columns at the commit tick (the same unit still in the slot).
/// Arrays: acq.out, acq.tid, acq.id, acq.rng, unit.id, acq.sout, unit.cbS,
/// unit.cbT, unit.cbTick, unit.cbTId, unit.cbRangeS. P: [0] slots, [1] per
/// job, [2] tick.
#[no_mangle]
pub unsafe extern "C" fn k_acq_commit(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (outa, tid, si, sr, id, sout, cbs) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<f32>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6));
    let (ct, ctk, cti, crs) = (k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9), k.p::<f32>(10));
    let t = k.i(2);
    let (s0, s1) = job(chunk, k.i(1), k.i(0));
    for q in s0..s1 {
        let o = g(outa, q);
        if o == -2 || g(id, q) != g(si, q) {
            continue;
        }
        s(ct, q, o);
        s(cti, q, g(tid, q));
        s(crs, q, g(sr, q));
        s(ctk, q, t);
        s(cbs, q, g(sout, q));
    }
}

/// SIM_KERNEL_COMBAT_COMMIT: the combat brain's instructions into the
/// units' columns at the commit tick (the same unit, alive; 255: none).
/// Arrays: acq.bm, acq.bt, acq.btid, acq.id, unit.id, unit.dead,
/// unit.cmMode, unit.cmT, unit.cmTId. P: [0] slots, [1] per job.
#[no_mangle]
pub unsafe extern "C" fn k_combat_commit(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (bm, bt, btid, sid, id, dead, cm, ct, ctid) = (k.p::<u8>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<u8>(5),
        k.p::<u8>(6), k.p::<i32>(7), k.p::<i32>(8));
    let (s0, s1) = job(chunk, k.i(1), k.i(0));
    for q in s0..s1 {
        let m = g(bm, q);
        if m == 255 || g(id, q) != g(sid, q) || g(dead, q) != 0 {
            continue;
        }
        s(cm, q, m);
        s(ct, q, if m != 0 { g(bt, q) } else { -1 });
        s(ctid, q, if m != 0 { g(btid, q) } else { 0 });
    }
}

/// SIM_KERNEL_COMBAT_SCAN (the crowd flags, unit.js combatScanRun): for
/// moving or attack-moving units near a group's destination or waiting
/// (mvNavLD not -1), whether an idle or waiting (mvNavLD <= -2) unit of its
/// owner stands in its chunk or one beside it (unit.cwNear) and how many
/// units are listed in those chunks (unit.cwDense, at most 65535), stamped
/// with the tick (unit.cwTick). Arrays: unit.mvOut, unit.commandState,
/// unit.dead, unit.x, unit.y, unit.owner, unit.sepKey, sep.rs, sep.rc,
/// sep.rstamp, sep.eslot, unit.cwNear, unit.cwTick, unit.cwDense,
/// unit.mvNavLD. P: [0] slots, [1] per job, [2] tick, [3] chunks wide,
/// [4] high, [5] tile, [6] epoch, [8] CMD_IDLE, [9] CMD_ATTACK_MOVING,
/// [13] absent key, [14] chunk size, [17] CMD_MOVING.
#[no_mangle]
pub unsafe extern "C" fn k_combat_scan(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (out, cmd, dead, xs, ys, own, sep) = (k.p::<u8>(0), k.p::<u8>(1), k.p::<u8>(2), k.p::<f32>(3), k.p::<f32>(4), k.p::<i8>(5), k.p::<u32>(6));
    let (rs, rc, rst, es) = (k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9), k.p::<i32>(10));
    let (cwn, cwt, cwd, nld) = (k.p::<u8>(11), k.p::<i32>(12), k.p::<u16>(13), k.p::<f32>(14));
    let (t, cw, ch, ep) = (k.i(2), k.i(3), k.i(4), k.i(6));
    let (cmd_idle, cmd_am, cmd_move) = (k.i(8) as u8, k.i(9) as u8, k.i(17) as u8);
    let absent = k.f(13) as u32;
    let icws = (1.0 / (k.f(5) * k.f(14))) as f32;
    let (s0, s1) = job(chunk, k.i(1), k.i(0));
    for q in s0..s1 {
        if g(out, q) != 0 || g(dead, q) != 0 || g(sep, q) == absent {
            continue;
        }
        let c = g(cmd, q);
        if !((c == cmd_move || c == cmd_am) && g(nld, q) != -1.0) {
            continue;
        }
        let o = g(own, q);
        let gx = floorf(g(xs, q) * icws) as i32;
        let gy = floorf(g(ys, q) * icws) as i32;
        let mut near = 0u8;
        let mut dense = 0i32;
        for ty in (gy - 1)..=(gy + 1) {
            if ty < 0 || ty >= ch {
                continue;
            }
            for tx in (gx - 1)..=(gx + 1) {
                if tx < 0 || tx >= cw {
                    continue;
                }
                let kk = (ty * cw + tx) as usize;
                if g(rst, kk) != ep {
                    continue;
                }
                let n = g(rc, kk);
                dense += n;
                if near != 0 {
                    continue;
                }
                let e0 = g(rs, kk);
                for e in e0..e0 + n {
                    let u = g(es, e as usize);
                    if u >= 0 && u as usize != q {
                        let uu = u as usize;
                        if g(dead, uu) == 0 && g(own, uu) == o && (g(cmd, uu) == cmd_idle || g(nld, uu) <= -2.0) {
                            near = 1;
                            break;
                        }
                    }
                }
            }
        }
        s(cwn, q, near);
        s(cwt, q, t);
        s(cwd, q, dense.min(65535) as u16);
    }
}

/// SIM_KERNEL_ACQ_SNAP: the acquisition tier's snapshot per slot (positions
/// at the pass's start, owner, command, aggro range, id; flags 1 dead, 2
/// absent from the index, 4 attacking a unit (no structure target), 8 a
/// worker or no damage, 16 the brain's command P[5] with damage (P[4] 1);
/// the brain's instruction and range steps), the results cleared (-2: not
/// looked for; live units -1 / 0 / -1). Arrays: unit.x0, unit.y0,
/// unit.owner, unit.dead, unit.sepKey, unit.commandState, unit.cbRange,
/// unit.id, unit.acqB, acq.tid, acq.sout, acq.x, acq.y, acq.own, acq.flags,
/// acq.cmd, acq.rng, acq.id, acq.out, unit.cmMode, unit.cmT, unit.cmTId,
/// unit.isWk, unit.atkDmg, unit.mvRangeK, acq.cm, acq.ct, acq.ctid, acq.rk.
/// P: [0] slots, [1] per job, [2] absent key, [3] CMD_ATTACKING, [4], [5].
#[no_mangle]
pub unsafe extern "C" fn k_acq_snap(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (x0, y0, own, dead, sep, cmd, rng, id, acqb) = (k.p::<f32>(0), k.p::<f32>(1), k.p::<i8>(2), k.p::<u8>(3), k.p::<u32>(4), k.p::<u8>(5),
        k.p::<f32>(6), k.p::<i32>(7), k.p::<u8>(8));
    let (tid, sout, sx, sy, so, sf, sc, sr, si, outa) = (k.p::<i32>(9), k.p::<i32>(10), k.p::<f32>(11), k.p::<f32>(12), k.p::<i8>(13), k.p::<u8>(14),
        k.p::<u8>(15), k.p::<f32>(16), k.p::<i32>(17), k.p::<i32>(18));
    let (ucm, uct, uctid, uwk, admg, rangek) = (k.p::<u8>(19), k.p::<i32>(20), k.p::<i32>(21), k.p::<u8>(22), k.p::<f32>(23), k.p::<u8>(24));
    let (scm, sct, sctid, srk) = (k.p::<u8>(25), k.p::<i32>(26), k.p::<i32>(27), k.p::<u8>(28));
    let absent = k.f(2) as u32;
    let cmd_atk = k.i(3) as u8;
    let brain = k.i(4) == 1;
    let brain_cmd = k.i(5) as u8;
    let (s0, s1) = job(chunk, k.i(1), k.i(0));
    for q in s0..s1 {
        let c = g(cmd, q);
        let d = g(dead, q);
        s(sx, q, g(x0, q));
        s(sy, q, g(y0, q));
        s(so, q, g(own, q));
        s(sc, q, c);
        s(sr, q, g(rng, q));
        s(si, q, g(id, q));
        s(outa, q, -2);
        let wk = g(uwk, q) != 0;
        let dmg = g(admg, q) > 0.0;
        let f = (if d != 0 { 1 } else { 0 }) | (if g(sep, q) == absent { 2 } else { 0 }) | (if c == cmd_atk && g(acqb, q) == 0 { 4 } else { 0 })
            | (if wk || !dmg { 8 } else { 0 }) | (if brain && c == brain_cmd && !wk && dmg { 16 } else { 0 });
        s(sf, q, f);
        s(scm, q, g(ucm, q));
        s(sct, q, g(uct, q));
        s(sctid, q, g(uctid, q));
        s(srk, q, g(rangek, q));
        if d == 0 {
            s(outa, q, -1);
            s(tid, q, 0);
            s(sout, q, -1);
        }
    }
}

/// stackCountToLevel: floor(log2(max(1, stacks))) + 1, clamped to 1..max.
#[inline(always)]
fn stack_level(st: f32, maxl: i32) -> i32 {
    let v = if st >= 1.0 && st < 4.0e9 { st as u32 } else if st >= 4.0e9 { u32::MAX } else { 1 };
    let k = 31 - v.leading_zeros() as i32;
    (k + 1).max(1).min(maxl.max(1))
}

/// SIM_KERNEL_EFF_UNITS (things_utils.js recalculateUnitEffectiveStats): for
/// the strided share (entry j: units index P[3] + j * P[2]) from the
/// columns: base stacks and level, the same-owner same-type count over its
/// window of the type block counts, effective stacks and (sticky) level.
/// eff.flag[j]: 0 done, 1 done with a new effective level (the caller
/// applies its tables), 2 for the caller (no slot, base tables to make, no
/// window or count, behind its stat tables), 3 nothing (dead, taken).
/// Upkeep bins (P[12] players, P[13] levels + 1) moved with atomic adds.
/// Arrays: ix.slots, unit.dead, unit.esOk, unit.esRad, unit.esType,
/// unit.esTaken, unit.stackCount, unit.unitLevel, unit.baseLevel,
/// unit.effectiveStacks, unit.effectiveLevel, unit._lastAppliedEffectiveLevel,
/// unit.x, unit.y, unit.owner, spatial.types, eff.flag, ?unit.upT,
/// ?unit.upB, ?upk.h, ?eff.tver, unit.esVer.
/// P: [0] entries, [1] per job, [2] step, [3] phase, [4] chunk px, [5]/[6]
/// chunks wide/high, [7] stride per block, [8] types, [9] players, [10] max
/// level, [11] stamp, [12]/[13] upkeep, [14] types per version row, [15]/[16]
/// type blocks wide / their size, [17] upk.h length.
#[no_mangle]
pub unsafe extern "C" fn k_eff_units(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (sl, dead, ok, rad, typ, taken) = (k.p::<i32>(0), k.p::<u8>(1), k.p::<u8>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5));
    let (stk, ulv, blv, esk, elv, last) = (k.p::<f32>(6), k.p::<f32>(7), k.p::<f32>(8), k.p::<f32>(9), k.p::<f32>(10), k.p::<f32>(11));
    let (xs, ys, own, data, fl) = (k.p::<f32>(12), k.p::<f32>(13), k.p::<i8>(14), k.p::<i32>(15), k.p::<u8>(16));
    let (ut, ub, uh, tv, ev) = (k.p::<i16>(17), k.p::<i32>(18), k.p::<i32>(19), k.p::<i32>(20), k.p::<i32>(21));
    let (step, phase) = (k.i(2).max(0) as usize, k.i(3).max(0) as usize);
    let ichunk = (1.0 / k.f(4)) as f32;
    let (cw, ch, strideb, nt, players, maxl, stamp) = (k.i(5), k.i(6), k.i(7), k.i(8), k.i(9), k.i(10), k.i(11));
    let (unp, ul1, ntv, tw, tb, uhn) = (k.i(12), k.i(13), k.i(14), k.i(15), k.i(16), k.i(17));
    let (j0, j1) = job(chunk, k.i(1), k.i(0));
    for j in j0..j1 {
        let sv = g(sl, phase + j * step);
        if sv < 0 {
            s(fl, j, 2);
            continue;
        }
        let q = sv as usize;
        if g(dead, q) != 0 || g(taken, q) == stamp {
            s(fl, j, 3);
            continue;
        }
        let sc = g(stk, q);
        if g(ok, q) == 0 || !(sc >= 1.0 && sc < f32::INFINITY) {
            s(fl, j, 2);
            continue;
        }
        let base = floorf(sc);
        let bl = stack_level(base, maxl);
        if g(blv, q) != bl as f32 {
            s(fl, j, 2);
            continue;
        }
        s(stk, q, base);
        s(ulv, q, bl as f32);
        let o = g(own, q) as i32;
        if !(o >= 0 && o < players) {
            s(fl, j, 2);
            continue;
        }
        let ty = g(typ, q);
        if !tv.is_null() && ntv != 0 && g(ev, q) != g(tv, (o * ntv + ty) as usize) {
            s(fl, j, 2);
            continue;
        }
        let cx = floorf(g(xs, q) * ichunk) as i32;
        let cy = floorf(g(ys, q) * ichunk) as i32;
        let r = g(rad, q);
        let x1 = (cx - r).min(cw - 1).max(0);
        let y1 = (cy - r).min(ch - 1).max(0);
        let x2 = (cx + r).min(cw - 1).max(0);
        let y2 = (cy + r).min(ch - 1).max(0);
        if !(x1 <= x2 && y1 <= y2) {
            s(fl, j, 2);
            continue;
        }
        let lane = o * nt + ty;
        let (bx1, bx2, by1, by2) = (idiv(x1, tb), idiv(x2, tb), idiv(y1, tb), idiv(y2, tb));
        let mut sum = 0i32;
        for by in by1..=by2 {
            let mut idx = (by * tw + bx1) * strideb + lane;
            for _ in bx1..=bx2 {
                sum = sum.wrapping_add(g(data, idx as usize));
                idx += strideb;
            }
        }
        if sum <= 0 {
            s(fl, j, 2);
            continue;
        }
        let effs = floorf((sum as f32 * base).max(1.0));
        let el0 = stack_level(effs, maxl);
        let lst = g(last, q);
        let el = if !(lst >= 1.0) || el0 as f32 == lst {
            el0
        } else {
            let l = lst as i32;
            if el0 == l - 1 {
                if effs * 5.0 >= 4.0 * (1u64 << (l - 1).clamp(0, 62)) as f32 { l } else { el0 }
            } else if el0 == l + 1 {
                if effs * 4.0 < 5.0 * (1u64 << l.clamp(0, 62)) as f32 { l } else { el0 }
            } else {
                el0
            }
        };
        s(esk, q, effs);
        s(elv, q, el as f32);
        s(taken, q, stamp);
        // (A new level: its stat row's tables (4: another vision range), else
        // the JavaScript's, 1.)
        let mut fv = 0u8;
        if lst != el as f32 {
            let mut vis = false;
            if k.i(18) > 0 && eff_row_apply(&k, q, o, ty, bl, el, g(ev, q), &mut vis) {
                s(last, q, el as f32);
                fv = if vis { 4 } else { 0 };
            } else {
                fv = 1;
            }
        }
        s(fl, j, fv);
        if unp != 0 && !ut.is_null() {
            let t = g(ut, q) as i32;
            let b = if t >= 0 && o < unp { (t * unp + o) * ul1 + el.min(ul1 - 1).max(1) } else { -1 };
            let ob = g(ub, q);
            if b != ob && b < uhn {
                if ob >= 0 { atomic_add(uh, ob as usize, -1); }
                if b >= 0 { atomic_add(uh, b as usize, 1); }
                s(ub, q, b);
            }
        }
    }
}

/// SIM_KERNEL_HITS (unit.js unitHitsResolve): per target (the job's groups
/// hit.jb[job]..hit.jb[job + 1] of hit.g, by target then attacker rank), in
/// rank order: none once it has fallen; its energy, its status by the
/// attack's style (1 fire, 2 water, 3 ice, 4 poison), fallen at none left.
/// hit.flag[rank]: 1 landed, 2 on an idle unit; hit.shr[job * owners + o]
/// the energy lost per owner (fixed point). Arrays: hit.g, hit.jb, hit.q,
/// hit.dmg, hit.sty, hit.flag, hit.shr, unit.energy, unit.dead, unit.owner,
/// unit.commandState, unit.stOn, unit.burning, unit.burnTickDamage,
/// unit.wet, unit.frozen, unit.poisoned, unit.poisonTickDamage.
/// P: [0] owners, [1] fixed-point scale, [2] CMD_IDLE.
#[no_mangle]
pub unsafe extern "C" fn k_hits(a: *const i32, job_: i32) {
    let k = K::new(a);
    let (gg, jb, qq, dmgp, sty, flag, shr) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<f64>(3), k.p::<u8>(4), k.p::<u8>(5), k.p::<f64>(6));
    let (en, dead, own, cmd, ston) = (k.p::<f32>(7), k.p::<u8>(8), k.p::<i8>(9), k.p::<u8>(10), k.p::<u8>(11));
    let (burn, btd, wet, frz, poi, ptd) = (k.p::<i32>(12), k.p::<f32>(13), k.p::<i32>(14), k.p::<i32>(15), k.p::<i32>(16), k.p::<f32>(17));
    let no = k.i(0).max(0) as usize;
    let scale = k.f(1);
    let idle = k.i(2) as u8;
    let jbu = job_.max(0) as usize;
    let sh = jbu * no;
    for o in 0..no {
        s(shr, sh + o, 0.0);
    }
    for gi in g(jb, jbu)..g(jb, jbu + 1) {
        let r = g(gg, gi as usize) as usize;
        let q = g(qq, r) as usize;
        if g(dead, q) != 0 {
            s(flag, r, 0);
            continue;
        }
        let dmg = g(dmgp, r) as f32;
        let before = g(en, q);
        let after = before - dmg;
        s(en, q, after);
        let amount = before - after;
        let mut fl = 1u8;
        if amount > 0.0 {
            let o = g(own, q) as i32;
            let lost = if after < 0.0 { amount + after } else { amount };
            if lost > 0.0 && o >= 0 && (o as usize) < no && lost.is_finite() {
                let c = shr.add(sh + o as usize);
                *c += round_half_up(lost as f64 * scale);
            }
        }
        if g(cmd, q) == idle {
            fl |= 2;
        }
        match g(sty, r) {
            1 => { s(burn, q, g(burn, q).max(45)); s(btd, q, g(btd, q).max(dmg * 0.04)); s(ston, q, 1); }
            2 => { s(wet, q, g(wet, q).max(60)); s(ston, q, 1); }
            3 => { s(frz, q, g(frz, q).max(40)); s(ston, q, 1); }
            4 => { s(poi, q, g(poi, q).max(50)); s(ptd, q, g(ptd, q).max(dmg * 0.04)); s(ston, q, 1); }
            _ => {}
        }
        if after <= 0.0 {
            s(dead, q, 1);
        }
        s(flag, r, fl);
    }
}

#[inline(always)]
fn round_half_up(v: f64) -> f64 {
    let f = v + 0.5;
    let t = f as i64 as f64;
    if t > f { t - 1.0 } else { t }
}

// =====================================================================
// VISIBILITY COVER OF UNITS (renderer.js _visCoverUnits)
// =====================================================================

/// A unit's sight key: steps | (player + 1) << 8 | (watching team + 1) << 16,
/// or -1 (not registered this generation, dead, absent, no range).
#[inline(always)]
unsafe fn vis_key(vg: *const i32, dead: *const u8, sk: *const u32, vr: *const i8, v1: *const i8, v2: *const i8, q: usize, gen: i32, absent: u32) -> i32 {
    let r = g(vr, q) as i32;
    if g(vg, q) != gen || g(dead, q) != 0 || g(sk, q) == absent || r < 0 {
        -1
    } else {
        (r & 63) | ((g(v1, q) as i32 + 1) << 8) | ((g(v2, q) as i32 + 1) << 16)
    }
}

/// SIM_KERNEL_VIS_SNAP: per slot its position (vt.x, vt.y) and sight key
/// (vt.key). Arrays: unit.x, unit.y, unit.dead, unit.sepKey, unit.vsGen,
/// unit.vsR, unit.vsP1, unit.vsP2, vt.x, vt.y, vt.key.
/// P: [0] slots, [1] per job, [2] coverage generation, [3] absent key.
#[no_mangle]
pub unsafe extern "C" fn k_vis_snap(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (xs, ys, dead, sk, vg, vr, v1, v2) = (k.p::<f32>(0), k.p::<f32>(1), k.p::<u8>(2), k.p::<u32>(3), k.p::<i32>(4), k.p::<i8>(5), k.p::<i8>(6), k.p::<i8>(7));
    let (tx, ty, key) = (k.p::<f32>(8), k.p::<f32>(9), k.p::<i32>(10));
    let gen = k.i(2);
    let absent = k.f(3) as u32;
    let (s0, s1) = job(chunk, k.i(1), k.i(0));
    for q in s0..s1 {
        s(tx, q, g(xs, q));
        s(ty, q, g(ys, q));
        s(key, q, vis_key(vg, dead, sk, vr, v1, v2, q, gen, absent));
    }
}

/// An area's seed for player p: the most steps this stamp (atomic max of
/// stamp << 6 | steps); its first mark this stamp lists it.
#[inline(always)]
unsafe fn vis_seed(seed: *mut i32, list: *mut i32, cnt: *mut i32, p: usize, base: usize, ar: usize, val: i32, stamp: i32) {
    let cell = &*(seed.add(base + ar) as *const core::sync::atomic::AtomicI32);
    let mut cur = cell.load(core::sync::atomic::Ordering::Relaxed);
    while cur < val {
        match cell.compare_exchange(cur, val, core::sync::atomic::Ordering::Relaxed, core::sync::atomic::Ordering::Relaxed) {
            Ok(_) => {
                if (cur >> 6) != stamp {
                    let c = &*(cnt.add(p) as *const core::sync::atomic::AtomicI32);
                    let i = c.fetch_add(1, core::sync::atomic::Ordering::Relaxed);
                    s(list, base + i as usize, ar as i32);
                }
                return;
            }
            Err(prev) => cur = prev,
        }
    }
}

/// SIM_KERNEL_VIS_SEED: every unit with a sight key marks the areas under
/// its +-0.3 tile window for its player and a watching team (vis.useed,
/// listed in vis.ulist from player * A, vis.ucnt[player] of them). P[9] 1:
/// from the live columns (the key worked out here), else the snapshot.
/// Arrays: x (unit.x or vt.x), y, vt.key, vis.useed, vis.ulist, vis.ucnt,
/// vt.agrid, unit.vsGen, unit.dead, unit.sepKey, unit.vsR, unit.vsP1,
/// unit.vsP2. P: [0] slots, [1] per job, [2] tile, [3]/[4] grid, [6] areas,
/// [7] players, [8] stamp, [9] live, [10] generation, [11] absent key.
#[no_mangle]
pub unsafe extern "C" fn k_vis_seed(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (xs, ys, keyp, seed, list, cnt, ag) = (k.p::<f32>(0), k.p::<f32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6));
    let (vg, dead, sk, vr, v1, v2) = (k.p::<i32>(7), k.p::<u8>(8), k.p::<u32>(9), k.p::<i8>(10), k.p::<i8>(11), k.p::<i8>(12));
    let itile = (1.0 / k.f(2)) as f32;
    let (w, h, na, np, stamp) = (k.i(3), k.i(4), k.i(6), k.i(7), k.i(8));
    let live = k.i(9) == 1;
    let (gen, absent) = (k.i(10), k.f(11) as u32);
    let (s0, s1) = job(chunk, k.i(1), k.i(0));
    for q in s0..s1 {
        let key = if live { vis_key(vg, dead, sk, vr, v1, v2, q, gen, absent) } else { g(keyp, q) };
        if key < 0 {
            continue;
        }
        let fx = g(xs, q) * itile;
        let fy = g(ys, q) * itile;
        if !(fx > -1e9 && fx < 1e9 && fy > -1e9 && fy < 1e9) {
            continue;
        }
        let gxf = floorf(fx);
        let gyf = floorf(fy);
        let (gx, gy) = (gxf as i32, gyf as i32);
        let (rx, ry) = (fx - gxf, fy - gyf);
        let x0 = if rx < 0.3 { gx - 1 } else { gx };
        let x1 = if rx < 0.7 { gx } else { gx + 1 };
        let y0 = if ry < 0.3 { gy - 1 } else { gy };
        let y1 = if ry < 0.7 { gy } else { gy + 1 };
        let p1 = ((key >> 8) & 255) - 1;
        let p2 = ((key >> 16) & 255) - 1;
        let val = (stamp << 6) | (key & 63);
        for ty in y0..=y1 {
            if ty < 0 || ty >= h {
                continue;
            }
            for tx in x0..=x1 {
                if tx < 0 || tx >= w {
                    continue;
                }
                let ar = g(ag, (ty * w + tx) as usize);
                if !(ar >= 0 && ar < na) {
                    continue;
                }
                if p1 >= 0 && p1 < np {
                    vis_seed(seed, list, cnt, p1 as usize, (p1 * na) as usize, ar as usize, val, stamp);
                }
                if p2 >= 0 && p2 < np {
                    vis_seed(seed, list, cnt, p2 as usize, (p2 * na) as usize, ar as usize, val, stamp);
                }
            }
        }
    }
}

/// SIM_KERNEL_VIS_SPREAD (job = player): from this stamp's seeds the steps
/// spread over the area graph (CSR vt.aoff / vt.anb), one less per
/// neighbour; every area reached is covered. Against the last run's covered
/// areas (vis.uprev, vis.uprevn; vis.ust 1 for those): newly covered in
/// vis.uplus, no longer covered in vis.uminus (vis.udiff[2p], [2p + 1]).
/// Arrays: vis.useed, vis.ulist, vis.ucnt, vt.aok, vt.aoff, vt.anb,
/// vis.urem, vis.ubufB, vis.ucur, vis.ubufA, vis.ubufC, vis.ust,
/// vis.uprev, vis.uprevn, vis.uplus, vis.uminus, vis.udiff.
/// P: [0] areas, [1] players, [2] stamp.
#[no_mangle]
pub unsafe extern "C" fn k_vis_spread(a: *const i32, p_: i32) {
    let k = K::new(a);
    let (seed, list, cnt, aok, off, nb) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<u8>(3), k.p::<i32>(4), k.p::<i32>(5));
    let (rem, bb, cur) = (k.p::<i8>(6), k.p::<i32>(7), k.p::<i32>(8));
    let (mut lv, mut nx) = (k.p::<i32>(9), k.p::<i32>(10));
    let (st, prev, prevn, plus, minus, diff) = (k.p::<u8>(11), k.p::<i32>(12), k.p::<i32>(13), k.p::<i32>(14), k.p::<i32>(15), k.p::<i32>(16));
    let na = k.i(0);
    let stamp = k.i(2);
    let p = p_.max(0) as usize;
    let base = p * na.max(0) as usize;
    let n = g(cnt, p).max(0) as usize;
    // (Seeds by steps: a counting sort, its counts on the stack.)
    let mut counts = [0i32; 66];
    let cp = counts.as_mut_ptr();
    let mut nc = 0usize;
    let mut top = -1i32;
    for i in 0..n {
        let ar = g(list, base + i);
        if !(ar >= 0 && ar < na) || g(aok, ar as usize) == 0 {
            continue;
        }
        let au = ar as usize;
        let v = g(seed, base + au);
        if (v >> 6) != stamp {
            continue;
        }
        let r = v & 63;
        let rm = g(rem, base + au) as i32;
        if rm < 0 {
            s(cur, base + nc, ar);
            nc += 1;
        }
        if r > rm {
            s(rem, base + au, r as i8);
            *cp.add(r as usize + 1) += 1;
            if r > top {
                top = r;
            }
        }
    }
    for r in 1..=64usize {
        *cp.add(r) += *cp.add(r - 1);
    }
    let mut pos = [0i32; 65];
    let pp = pos.as_mut_ptr();
    for r in 0..64usize {
        *pp.add(r) = *cp.add(r);
    }
    for i in 0..nc {
        let ar = g(cur, base + i) as usize;
        let r = g(rem, base + ar) as usize;
        let o = *pp.add(r);
        s(bb, base + o as usize, ar as i32);
        *pp.add(r) = o + 1;
    }
    // Level by level, most steps first.
    let mut nl = 0usize;
    let mut r = top;
    while r > 0 {
        let mut nn = 0usize;
        let rm1 = (r - 1) as i8;
        // (The level's areas: those reached from the level above, then its seeds.)
        for pass in 0..2 {
            let (i0, i1) = if pass == 0 { (0usize, nl) } else { (*cp.add(r as usize) as usize, *cp.add(r as usize + 1) as usize) };
            for i in i0..i1 {
                let ar = if pass == 0 { g(lv, base + i) } else { g(bb, base + i) } as usize;
                if g(rem, base + ar) as i32 != r {
                    continue;
                }
                let o1 = g(off, ar + 1);
                for j in g(off, ar)..o1 {
                    let q = g(nb, j as usize) as usize;
                    let rq = g(rem, base + q);
                    if rq >= rm1 {
                        continue;
                    }
                    if rq < 0 {
                        s(cur, base + nc, q as i32);
                        nc += 1;
                    }
                    s(rem, base + q, rm1);
                    if r > 1 {
                        s(nx, base + nn, q as i32);
                        nn += 1;
                    }
                }
            }
        }
        let sw = lv;
        lv = nx;
        nx = sw;
        nl = nn;
        r -= 1;
    }
    // Against the last run.
    let (mut nm, mut npl) = (0usize, 0usize);
    for i in 0..g(prevn, p).max(0) as usize {
        let ar = g(prev, base + i) as usize;
        if g(rem, base + ar) < 0 {
            s(minus, base + nm, ar as i32);
            nm += 1;
            s(st, base + ar, 0);
        }
    }
    for i in 0..nc {
        let ar = g(cur, base + i) as usize;
        if g(st, base + ar) == 0 {
            s(plus, base + npl, ar as i32);
            npl += 1;
            s(st, base + ar, 1);
        }
        s(rem, base + ar, -1);
        s(prev, base + i, ar as i32);
    }
    s(prevn, p, nc as i32);
    s(diff, 2 * p, npl as i32);
    s(diff, 2 * p + 1, nm as i32);
}

// =====================================================================
// THE COMBAT BRAIN (BRAIN_OFF_MAIN_THREAD_PLAN.md)
// =====================================================================

/// The thread's scratch (words) from the argument block (words 1000, 1001:
/// sim_parallel.js _simRust). Its first four words are a tag (which kernel
/// left state there) and that kernel's own words; kernels that use the
/// scratch without keeping state start after them.
#[inline(always)]
unsafe fn scratch(a: *const i32) -> (*mut i32, usize) {
    (*a.add(1000) as u32 as usize as *mut i32, (*a.add(1001)).max(0) as usize)
}
const TAG_BRAIN: i32 = 0x4252_4149;

/// Whether area b is within k steps of any of src[..ns] (breadth first over
/// the CSR area graph; stamps by epoch in the scratch).
#[inline(always)]
unsafe fn area_within(off: *const i32, nb: *const i32, na: usize, src: &[i32; 4], ns: usize, b: i32, k: i32, st: *mut i32, q: *mut i32, ep: i32) -> bool {
    for i in 0..ns {
        if *src.as_ptr().add(i) == b {
            return true;
        }
    }
    if k <= 0 {
        return false;
    }
    let (mut qh, mut qt) = (0usize, 0usize);
    for i in 0..ns {
        let a = *src.as_ptr().add(i);
        if a >= 0 && (a as usize) < na && g(st, a as usize) != ep {
            s(st, a as usize, ep);
            s(q, qt, a);
            qt += 1;
        }
    }
    let mut d = 1;
    while d <= k && qh < qt {
        let end = qt;
        while qh < end {
            let a = g(q, qh) as usize;
            qh += 1;
            for j in g(off, a)..g(off, a + 1) {
                let c = g(nb, j as usize);
                if c == b {
                    return true;
                }
                if g(st, c as usize) != ep {
                    s(st, c as usize, ep);
                    s(q, qt, c);
                    qt += 1;
                }
            }
        }
        d += 1;
    }
    false
}

/// SIM_KERNEL_COMBAT_BRAIN: per unit of the acquisition snapshot (acq.*)
/// its instruction: keep its target while alive and in sight, else take the
/// scan's (acq.out); in its attack range by areas (acq.rk steps from its
/// +-0.3 tile window's areas) -> 5 hold and fire, else 2 chase; a moving
/// shooter (flag 16): 4 fire in range, else 0; none -> 0; 255 not the
/// brain's. Arrays: acq.x, acq.y, acq.own, acq.flags, acq.cmd, acq.id,
/// acq.out, acq.cm, acq.ct, acq.ctid, acq.rk, acq.agrid, acq.cover,
/// ?acq.aoff, ?acq.anb, acq.bm, acq.bt, acq.btid. P: [0] slots, [1] per
/// job, [2] CMD_IDLE, [3] CMD_ATTACK_MOVING, [4] tile, [5]/[6] grid, [7]
/// players, [8] areas.
#[no_mangle]
pub unsafe extern "C" fn k_combat_brain(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (xs, ys, own, flg, cmd, id) = (k.p::<f32>(0), k.p::<f32>(1), k.p::<i8>(2), k.p::<u8>(3), k.p::<u8>(4), k.p::<i32>(5));
    let (outa, cm, ct, ctid, rk, ag, covf) = (k.p::<i32>(6), k.p::<u8>(7), k.p::<i32>(8), k.p::<i32>(9), k.p::<u8>(10), k.p::<i32>(11), k.p::<u8>(12));
    let (off, nb, bm, bt, btid) = (k.p::<i32>(13), k.p::<i32>(14), k.p::<u8>(15), k.p::<i32>(16), k.p::<i32>(17));
    let (cmd_idle, cmd_am) = (k.i(2) as u8, k.i(3) as u8);
    let itile = (1.0 / k.f(4)) as f32;
    let (gw, gh, players, na) = (k.i(5), k.i(6), k.i(7), k.i(8));
    let nau = na.max(0) as usize;
    // (Stamps and queue in the scratch, kept from call to call while no
    // other kernel used it.)
    let (sc, sw) = scratch(a);
    let have_bfs = !off.is_null() && !nb.is_null() && !sc.is_null() && 4 + 2 * nau <= sw;
    let (st, qq) = (sc.add(4), sc.add(4 + nau));
    if have_bfs && (*sc != TAG_BRAIN || *sc.add(2) != na) {
        for i in 0..nau {
            s(st, i, 0);
        }
        *sc = TAG_BRAIN;
        *sc.add(1) = 0;
        *sc.add(2) = na;
    }
    let area_of = |x: f32, y: f32| -> i32 {
        let gx = floorf(x * itile) as i32;
        let gy = floorf(y * itile) as i32;
        if gx < 0 || gy < 0 || gx >= gw || gy >= gh { -1 } else { g(ag, (gy * gw + gx) as usize) }
    };
    let (s0, s1) = job(chunk, k.i(1), k.i(0));
    for q in s0..s1 {
        s(bm, q, 255);
        let fl = g(flg, q);
        if fl & 11 != 0 {
            continue;
        }
        let c = g(cmd, q);
        let mover = fl & 16 != 0;
        if c != cmd_idle && c != cmd_am && !mover {
            continue;
        }
        let owner = g(own, q) as i32;
        if !(owner >= 0 && owner < players) {
            continue;
        }
        let mut tq = -1i32;
        let cur = g(ct, q);
        if !mover && g(cm, q) != 0 && cur >= 0 {
            let cu = cur as usize;
            if g(flg, cu) & 1 == 0 && g(id, cu) == g(ctid, q) && g(own, cu) as i32 != owner {
                let ar = area_of(g(xs, cu), g(ys, cu));
                if ar >= 0 && g(covf, (owner * na + ar) as usize) > 0 {
                    tq = cur;
                }
            }
        }
        if tq < 0 && g(outa, q) >= 0 {
            tq = g(outa, q);
        }
        if tq < 0 {
            s(bm, q, 0);
            continue;
        }
        let tu = tq as usize;
        let ta = area_of(g(xs, tu), g(ys, tu));
        let mut in_range = false;
        if ta >= 0 && have_bfs {
            let fx = g(xs, q) * itile;
            let fy = g(ys, q) * itile;
            let (gxf, gyf) = (floorf(fx), floorf(fy));
            let (gx, gy) = (gxf as i32, gyf as i32);
            let (rx, ry) = (fx - gxf, fy - gyf);
            let x0 = if rx < 0.3 { gx - 1 } else { gx };
            let x1 = if rx < 0.7 { gx } else { gx + 1 };
            let y0 = if ry < 0.3 { gy - 1 } else { gy };
            let y1 = if ry < 0.7 { gy } else { gy + 1 };
            let mut src = [0i32; 4];
            let mut ns = 0usize;
            for yy in y0..=y1 {
                for xx in x0..=x1 {
                    if xx < 0 || yy < 0 || xx >= gw || yy >= gh || ns >= 4 {
                        continue;
                    }
                    let ar = g(ag, (yy * gw + xx) as usize);
                    if ar >= 0 {
                        *src.as_mut_ptr().add(ns) = ar;
                        ns += 1;
                    }
                }
            }
            if ns > 0 {
                let mut ep = *sc.add(1) + 1;
                if ep >= 0x7fff_ffff {
                    for i in 0..nau {
                        s(st, i, 0);
                    }
                    ep = 1;
                }
                *sc.add(1) = ep;
                in_range = area_within(off, nb, nau, &src, ns, ta, g(rk, q) as i32, st, qq, ep);
            }
        }
        if mover {
            s(bm, q, if in_range { 4 } else { 0 });
            if in_range {
                s(bt, q, tq);
                s(btid, q, g(id, tu));
            }
            continue;
        }
        s(bm, q, if in_range { 5 } else { 2 });
        s(bt, q, tq);
        s(btid, q, g(id, tu));
    }
}

// =====================================================================
// THE WORKER SEARCH TIER (worker.js workerSearchTierStep)
// =====================================================================

/// SIM_KERNEL_WS_SELECT (the post, per slot chunk of P[1]): a registered
/// worker (unit.wsKind, alive) due a search (the first post after it
/// registered, within P[3] ticks, then once in P[4] ticks by id): its
/// request at ws.r*[base + rank] (P[5] 2: base ws.rpre[chunk], else chunk *
/// P[1]; P[5] 1: counted only), how many at ws.rcnt[chunk].
/// Arrays: unit.wsKind, unit.wsCfg, unit.wsT, unit.wsOU, unit.wsOx,
/// unit.wsOy, unit.wsR, unit.wsAx, unit.wsAy, unit.wsAk, unit.wsNeed,
/// unit.wsJid, unit.wsCur, unit.wsMy, unit.x, unit.y, unit.owner, unit.id,
/// unit.dead, ws.rslot, ws.rid, ws.rwt, ws.rkind, ws.rowner, ws.rox,
/// ws.roy, ws.rux, ws.ruy, ws.rr, ws.rak, ws.rax, ws.ray, ws.rgrp,
/// ws.rneed, ws.rjid, ws.rcur, ws.rmy, ws.rcnt, ?ws.rpre.
/// P: [0] slots, [1] per job, [2] tick, [3] WS_TICKS, [4] retry ticks, [5] mode.
#[no_mangle]
pub unsafe extern "C" fn k_ws_select(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (kind, cfg, wt, ou, wox, woy, wr) = (k.p::<u8>(0), k.p::<i8>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<f32>(4), k.p::<f32>(5), k.p::<f32>(6));
    let (wax, way, wak, wn, wj, wc, wm) = (k.p::<f32>(7), k.p::<f32>(8), k.p::<i8>(9), k.p::<i32>(10), k.p::<i32>(11), k.p::<i32>(12), k.p::<i32>(13));
    let (xs, ys, own, id, dead) = (k.p::<f32>(14), k.p::<f32>(15), k.p::<i8>(16), k.p::<i32>(17), k.p::<u8>(18));
    let (rs, rid, rwt, rk, ro) = (k.p::<i32>(19), k.p::<i32>(20), k.p::<i32>(21), k.p::<i32>(22), k.p::<i32>(23));
    let (rox, roy, rux, ruy, rr) = (k.p::<f32>(24), k.p::<f32>(25), k.p::<f32>(26), k.p::<f32>(27), k.p::<f32>(28));
    let (rak, rax, ray, rg, rn, rj, rc, rm) = (k.p::<i32>(29), k.p::<f32>(30), k.p::<f32>(31), k.p::<i32>(32), k.p::<i32>(33), k.p::<i32>(34), k.p::<i32>(35), k.p::<i32>(36));
    let (cnt, pre) = (k.p::<i32>(37), k.p::<i32>(38));
    let (t, wt4, retry, mode) = (k.i(2), k.i(3), k.i(4).max(1), k.i(5));
    let (s0, s1) = job(chunk, k.i(1), k.i(0));
    let base = if mode == 2 { g(pre, chunk as usize) as usize } else { s0 };
    let mut m = 0usize;
    for q in s0..s1 {
        let kd = g(kind, q);
        if kd == 0 || g(dead, q) != 0 {
            continue;
        }
        let uid = g(id, q);
        if !(t - g(wt, q) < wt4 || ((t as i64 + uid as i64).rem_euclid(retry as i64) as i32) < wt4) {
            continue;
        }
        let rank = m;
        m += 1;
        if mode == 1 {
            continue;
        }
        let i = base + rank;
        let (x, y, ox) = (g(xs, q), g(ys, q), g(wox, q));
        let own_pos = ox != ox || t < g(ou, q);
        s(rs, i, q as i32);
        s(rid, i, uid);
        s(rwt, i, g(wt, q));
        s(rk, i, kd as i32);
        s(ro, i, g(own, q) as i32);
        s(rox, i, if own_pos { x } else { ox });
        s(roy, i, if own_pos { y } else { g(woy, q) });
        s(rux, i, x);
        s(ruy, i, y);
        s(rr, i, g(wr, q));
        s(rak, i, g(wak, q) as i32);
        s(rax, i, g(wax, q));
        s(ray, i, g(way, q));
        s(rg, i, g(cfg, q) as i32);
        s(rn, i, g(wn, q));
        s(rj, i, g(wj, q));
        s(rc, i, g(wc, q));
        s(rm, i, g(wm, q));
    }
    s(cnt, chunk as usize, m as i32);
}

const TAG_WS: i32 = 0x5753_4152;

/// Into the K best at out[o0..o0 + K] (score, then lower site).
#[inline(always)]
unsafe fn ws_insert(out: *mut i32, osc: *mut f32, o0: usize, kk: usize, site: i32, sc: f32) {
    let mut k = kk - 1;
    let last = g(osc, o0 + k);
    if sc > last || (sc == last && g(out, o0 + k) >= 0 && site > g(out, o0 + k)) {
        return;
    }
    while k > 0 {
        let ps = g(osc, o0 + k - 1);
        let po = g(out, o0 + k - 1);
        if sc < ps || (sc == ps && (po < 0 || site < po)) {
            s(osc, o0 + k, ps);
            s(out, o0 + k, po);
            k -= 1;
        } else {
            break;
        }
    }
    s(osc, o0 + k, sc);
    s(out, o0 + k, site);
}

/// The areas within k steps of the +-0.3 tile window at (x, y): stamped with
/// a new epoch in st (the scratch); returns the epoch.
#[inline(always)]
unsafe fn ws_areas_within(ag: *const i32, off: *const i32, nb: *const i32, na: usize, w: i32, h: i32, itile: f32, x: f32, y: f32, k: i32,
    sc: *mut i32, st: *mut i32, q: *mut i32) -> i32 {
    let mut ep = *sc.add(1) + 1;
    if ep >= 0x7fff_ffff {
        for i in 0..na {
            s(st, i, 0);
        }
        ep = 1;
    }
    *sc.add(1) = ep;
    let fx = x * itile;
    let fy = y * itile;
    let (gxf, gyf) = (floorf(fx), floorf(fy));
    let (gx, gy) = (gxf as i32, gyf as i32);
    let (rx, ry) = (fx - gxf, fy - gyf);
    let x0 = if rx < 0.3 { gx - 1 } else { gx };
    let x1 = if rx < 0.7 { gx } else { gx + 1 };
    let y0 = if ry < 0.3 { gy - 1 } else { gy };
    let y1 = if ry < 0.7 { gy } else { gy + 1 };
    let (mut qh, mut qt) = (0usize, 0usize);
    for yy in y0..=y1 {
        for xx in x0..=x1 {
            if xx < 0 || yy < 0 || xx >= w || yy >= h {
                continue;
            }
            let ar = g(ag, (yy * w + xx) as usize);
            if ar >= 0 && (ar as usize) < na && g(st, ar as usize) != ep {
                s(st, ar as usize, ep);
                s(q, qt, ar);
                qt += 1;
            }
        }
    }
    let mut d = 0;
    while d < k && qh < qt {
        let end = qt;
        while qh < end {
            let ar = g(q, qh) as usize;
            qh += 1;
            for j in g(off, ar)..g(off, ar + 1) {
                let c = g(nb, j as usize);
                if g(st, c as usize) != ep {
                    s(st, c as usize, ep);
                    s(q, qt, c);
                    qt += 1;
                }
            }
        }
        d += 1;
    }
    ep
}

/// SIM_KERNEL_WS_SCAN (a tier job, P[1] requests a job): each request's K
/// best sites, best first (then lower site): ws.res the site (-1 none),
/// ws.score its score. Within the radius of the origin and, with area
/// steps, in an area within that many steps of the origin's window.
///  Kind 1, a collector: the sites of its type's group (group arrays from
///   argument 30 + 14 * group id), the owner's or anyone's, not reserved by
///   another worker of its type (but its own); score: the distance from the
///   anchor (or the owner's nearest working spawner by tile steps, then row,
///   column, id; or the worker) plus 0.22 of the distance from the origin,
///   plus P[7] for a drop.
///  Kinds 3, 4, 5, the work grid: the owner's tiles offering all the needed
///   bits (kind 5: P[24 + owner]), not reserved by a worker of its type (but
///   its own tile); score the distance, less 0.75 tile for its current
///   target's tile and plus a jitter (ws.rjid >= 0). Kind 4 (a healer): also
///   its owner's damaged units (wsh.*), the best 3 in ws.ures.
/// Arrays: 0-14 ws.rkind, rowner, rox, roy, rux, ruy, rr, rak, rax, ray,
/// rgrp, rneed, rjid, rcur, rmy; 15 ws.rpre, 16 ws.res, 17 ws.score, 18
/// ws.ures, 19 ?ws.agrid, 20 ?ws.aoff, 21 ?ws.anb, 22-25 ?wsh.x, y, a, n,
/// 26-29 wsw.flags, own, area, resv (?), 30.. groups: meta, sx, sy, st, so,
/// pgx, pgy, po, pid, px, py, bs, bc, bi (14 each, 8 groups), then 142
/// ?wsw.cnt. P: [0] requests, [1] per job, [2] K, [3] tile, [4] bucket
/// tiles, [5] owners (wsh.n), [7] drop penalty, [8]/[9] grid, [10] work grid blocks wide, [11]
/// select chunks, [12] slots a select chunk, [13] healer slots per owner,
/// [14] 1: requests by position, [15] areas, [16..24) group per config,
/// [24..56) research bits per owner.
#[no_mangle]
pub unsafe extern "C" fn k_ws_scan(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (rk, ro, rox, roy, rux, ruy, rr, rak) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<f32>(2), k.p::<f32>(3), k.p::<f32>(4), k.p::<f32>(5), k.p::<f32>(6), k.p::<i32>(7));
    let (rax, ray, rg, rn, rj, rc, rm) = (k.p::<f32>(8), k.p::<f32>(9), k.p::<i32>(10), k.p::<i32>(11), k.p::<i32>(12), k.p::<i32>(13), k.p::<i32>(14));
    let (pre, out, osc, uout) = (k.p::<i32>(15), k.p::<i32>(16), k.p::<f32>(17), k.p::<i32>(18));
    let (ag, aoff, anb) = (k.p::<i32>(19), k.p::<i32>(20), k.p::<i32>(21));
    let (hx, hy, ha, hn) = (k.p::<f32>(22), k.p::<f32>(23), k.p::<i32>(24), k.p::<i32>(25));
    let (wf, wo, wsa, rv) = (k.p::<u8>(26), k.p::<i8>(27), k.p::<i32>(28), k.p::<u8>(29));
    let wcnt = k.p::<i32>(142);
    let kk = k.i(2).max(1) as usize;
    let tile = k.f(3) as f32;
    let itile = 1.0 / tile;
    let half = tile * 0.5;
    let bt = k.i(4).max(1);
    let drop_pen = k.f(7) as f32;
    let (w, h, gbw, nreg, chs, hmax) = (k.i(8), k.i(9), k.i(10), k.i(11), k.i(12), k.i(13));
    let by_pos = k.i(14) == 1;
    let na = k.i(15).max(0) as usize;
    let (sc, sw) = scratch(a);
    let have_areas = !ag.is_null() && !aoff.is_null() && !anb.is_null() && !sc.is_null() && 4 + 2 * na <= sw;
    let (ast, aq) = (sc.add(4), sc.add(4 + na));
    if have_areas && (*sc != TAG_WS || *sc.add(2) != na as i32) {
        for i in 0..na {
            s(ast, i, 0);
        }
        *sc = TAG_WS;
        *sc.add(1) = 0;
        *sc.add(2) = na as i32;
    }
    let (g0, g1) = job(chunk, k.i(1), k.i(0));
    // (The select chunk of g0: the last whose first request is at or before it.)
    let mut c = 0i32;
    if nreg > 0 {
        let (mut lo, mut hi) = (0i32, nreg - 1);
        while lo < hi {
            let mid = (lo + hi + 1) >> 1;
            if g(pre, mid as usize) <= g0 as i32 { lo = mid; } else { hi = mid - 1; }
        }
        c = lo;
    }
    for gq in g0..g1 {
        while c + 1 < nreg && g(pre, (c + 1) as usize) <= gq as i32 {
            c += 1;
        }
        let i = if by_pos { gq } else { (c * chs) as usize + (gq as i32 - g(pre, c as usize)) as usize };
        let o0 = i * kk;
        for j in 0..kk {
            s(out, o0 + j, -1);
            s(osc, o0 + j, f32::INFINITY);
        }
        let kind = g(rk, i);
        let owner = g(ro, i);
        let (ox, oy, r) = (g(rox, i), g(roy, i), g(rr, i));
        let r2 = r * r;
        let ak = g(rak, i);
        if kind == 4 && !uout.is_null() {
            s(uout, i * 3, -1);
            s(uout, i * 3 + 1, -1);
            s(uout, i * 3 + 2, -1);
        }
        let st = if ak >= 0 && have_areas { ws_areas_within(ag, aoff, anb, na, w, h, itile, ox, oy, ak, sc, ast, aq) } else { 0 };
        if kind >= 3 {
            if wf.is_null() {
                continue;
            }
            let nd = g(rn, i);
            let rb = ((nd >> 16) & 255) as u8;
            let (jid, cur, my) = (g(rj, i), g(rc, i), g(rm, i));
            let mut need = (nd & 255) as u8;
            let mut ci = (nd >> 8) & 255;
            if kind == 5 {
                need = if owner >= 0 && owner < 32 { k.i(24 + owner as usize) as u8 } else { 0 };
                ci = 3;
            }
            if need != 0 {
                let gx0 = (floorf((ox - r) * itile) as i32).max(0);
                let gx1 = (floorf((ox + r) * itile) as i32).min(w - 1);
                let gy0 = (floorf((oy - r) * itile) as i32).max(0);
                let gy1 = (floorf((oy + r) * itile) as i32).min(h - 1);
                if gx0 <= gx1 && gy0 <= gy1 {
                    for by in (gy0 >> 3)..=(gy1 >> 3) {
                        for bx in (gx0 >> 3)..=(gx1 >> 3) {
                            if !wcnt.is_null() && g(wcnt, ((by * gbw + bx) * 8 + ci) as usize) == 0 {
                                continue;
                            }
                            for ty in gy0.max(by << 3)..=gy1.min((by << 3) + 7) {
                                for tx in gx0.max(bx << 3)..=gx1.min((bx << 3) + 7) {
                                    let t = (ty * w + tx) as usize;
                                    if g(wf, t) & need != need || g(wo, t) as i32 != owner {
                                        continue;
                                    }
                                    let dx = tx as f32 * tile + half - ox;
                                    let dy = ty as f32 * tile + half - oy;
                                    let d2 = dx * dx + dy * dy;
                                    if !(d2 <= r2) {
                                        continue;
                                    }
                                    if st != 0 {
                                        let sa = g(wsa, t);
                                        if !(sa >= 0 && g(ast, sa as usize) == st) {
                                            continue;
                                        }
                                    }
                                    if !rv.is_null() && (g(rv, t) & rb) != 0 && t as i32 != my {
                                        continue;
                                    }
                                    let mut score = sqrtf(d2);
                                    if jid >= 0 {
                                        if t as i32 == cur {
                                            score -= tile * 0.75;
                                        }
                                        let hsh = (jid as u32).wrapping_mul(1103515245).wrapping_add((tx as u32).wrapping_mul(12345)).wrapping_add((ty as u32).wrapping_mul(54321));
                                        score += ((hsh % 1024) as f32 / 1024.0) * tile * 0.35;
                                    }
                                    ws_insert(out, osc, o0, kk, t as i32, score);
                                }
                            }
                        }
                    }
                }
            }
            // A healer: its owner's damaged units too.
            if kind == 4 && !hx.is_null() && !hn.is_null() && !uout.is_null() && owner >= 0 && owner < k.i(5) {
                let (ux, uy) = (g(rux, i), g(ruy, i));
                let (mut b0, mut b1, mut b2) = (-1i32, -1i32, -1i32);
                let (mut s0_, mut s1_, mut s2_) = (f32::INFINITY, f32::INFINITY, f32::INFINITY);
                let cnt = g(hn, owner as usize);
                for qn in 0..cnt {
                    let hh = (owner * hmax + qn) as usize;
                    let dx = g(hx, hh) - ox;
                    let dy = g(hy, hh) - oy;
                    let d2 = dx * dx + dy * dy;
                    if d2 > r2 {
                        continue;
                    }
                    if st != 0 {
                        let hav = g(ha, hh);
                        if !(hav >= 0 && g(ast, hav as usize) == st) {
                            continue;
                        }
                    }
                    let wx = g(hx, hh) - ux;
                    let wy = g(hy, hh) - uy;
                    let scv = d2 + (wx * wx + wy * wy) * 0.08;
                    if scv < s0_ { b2 = b1; s2_ = s1_; b1 = b0; s1_ = s0_; b0 = qn; s0_ = scv; }
                    else if scv < s1_ { b2 = b1; s2_ = s1_; b1 = qn; s1_ = scv; }
                    else if scv < s2_ { b2 = qn; s2_ = scv; }
                }
                let _ = s2_;
                s(uout, i * 3, b0);
                s(uout, i * 3 + 1, b1);
                s(uout, i * 3 + 2, b2);
            }
            continue;
        }
        let grp = g(rg, i);
        let gid = if grp >= 0 && grp < 8 { k.i(16 + grp as usize) } else { -1 };
        if kind != 1 || !(gid >= 0 && gid < 8) {
            continue;
        }
        let gb = 30 + 14 * gid as usize;
        let meta = k.p::<i32>(gb);
        if meta.is_null() {
            continue;
        }
        let (n, np, bcols, brows) = (g(meta, 0), g(meta, 1), g(meta, 3), g(meta, 4));
        let (sx, sy, stp, so) = (k.p::<f32>(gb + 1), k.p::<f32>(gb + 2), k.p::<i32>(gb + 3), k.p::<i32>(gb + 4));
        let (ux, uy) = (g(rux, i), g(ruy, i));
        let (mut ax, mut ay) = (g(rax, i), g(ray, i));
        if ax != ax {
            let (pgx, pgy, po, pid, px, py) = (k.p::<i32>(gb + 5), k.p::<i32>(gb + 6), k.p::<i32>(gb + 7), k.p::<i32>(gb + 8), k.p::<f32>(gb + 9), k.p::<f32>(gb + 10));
            let utx = floorf(ux * itile) as i32;
            let uty = floorf(uy * itile) as i32;
            let mut best = -1i32;
            let mut bd = i32::MAX;
            for p in 0..np.max(0) as usize {
                if g(po, p) != owner {
                    continue;
                }
                let d = (g(pgx, p) - utx).abs() + (g(pgy, p) - uty).abs();
                let better = if best < 0 || d < bd {
                    true
                } else if d == bd {
                    let bu = best as usize;
                    g(pgy, p) < g(pgy, bu) || (g(pgy, p) == g(pgy, bu) && (g(pgx, p) < g(pgx, bu) || (g(pgx, p) == g(pgx, bu) && g(pid, p) < g(pid, bu))))
                } else {
                    false
                };
                if better {
                    bd = d;
                    best = p as i32;
                }
            }
            if best >= 0 {
                ax = g(px, best as usize);
                ay = g(py, best as usize);
            } else {
                ax = ux;
                ay = uy;
            }
        }
        let (bs, bc, bi) = (k.p::<i32>(gb + 11), k.p::<i32>(gb + 12), k.p::<i32>(gb + 13));
        let rb = if rv.is_null() { 0u8 } else { ((g(rn, i) >> 16) & 255) as u8 };
        let my = g(rm, i);
        let ibt = itile / bt as f32;
        let bx0 = (floorf((ox - r) * ibt) as i32).max(0);
        let bx1 = (floorf((ox + r) * ibt) as i32).min(bcols - 1);
        let by0 = (floorf((oy - r) * ibt) as i32).max(0);
        let by1 = (floorf((oy + r) * ibt) as i32).min(brows - 1);
        if bx0 > bx1 || by0 > by1 {
            continue;
        }
        for by in by0..=by1 {
            for bx in bx0..=bx1 {
                let b = (by * bcols + bx) as usize;
                let e0 = g(bs, b);
                for e in e0..e0 + g(bc, b) {
                    let site = g(bi, e as usize);
                    if site >= n {
                        continue;
                    }
                    let su = site as usize;
                    let sown = g(so, su);
                    if sown >= 0 && sown != owner {
                        continue;
                    }
                    let dx = g(sx, su) - ox;
                    let dy = g(sy, su) - oy;
                    let d2 = dx * dx + dy * dy;
                    if !(d2 <= r2) {
                        continue;
                    }
                    if rb != 0 {
                        let t = floorf(g(sy, su) * itile) as i32 * w + floorf(g(sx, su) * itile) as i32;
                        if t >= 0 && (g(rv, t as usize) & rb) != 0 && t != my {
                            continue;
                        }
                    }
                    let ex = g(sx, su) - ax;
                    let ey = g(sy, su) - ay;
                    let score = sqrtf(ex * ex + ey * ey) + sqrtf(d2) * 0.22 + if g(stp, su) == 0 { drop_pen } else { 0.0 };
                    ws_insert(out, osc, o0, kk, site, score);
                }
            }
        }
    }
}

#[inline(always)]
fn sqrtf(v: f32) -> f32 {
    f32x4_extract_lane::<0>(f32x4_sqrt(f32x4_splat(v)))
}

/// SIM_KERNEL_WS_ORDER (one job): the requests with a result, in id order
/// (ws.order, ws.orderCount[0]). Arrays: ws.rcnt, ws.rkind, ws.rid, ws.res,
/// ws.ures, ws.order, ws.orderCount. P: [0] select chunks, [1] chunk size,
/// [2] K, [3] the healer kind.
#[no_mangle]
pub unsafe extern "C" fn k_ws_order(a: *const i32, _chunk: i32) {
    let k = K::new(a);
    let (cnt, kind, id, res, ures, out, oc) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6));
    let (nch, chs, kk, heal) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2).max(1) as usize, k.i(3));
    let mut n = 0usize;
    for ch in 0..nch {
        for m in 0..g(cnt, ch).max(0) as usize {
            let i = ch * chs + m;
            if g(res, i * kk) >= 0 || (g(kind, i) == heal && !ures.is_null() && g(ures, i * 3) >= 0) {
                s(out, n, i as i32);
                n += 1;
            }
        }
    }
    // (By id: a heapsort of the indices by their ids; ids are distinct.)
    let key = |x: i32| -> i32 { g(id, x as usize) };
    let sift = |root0: usize, end: usize| {
        let mut root = root0;
        loop {
            let mut c = 2 * root + 1;
            if c >= end {
                break;
            }
            if c + 1 < end && key(g(out, c + 1)) > key(g(out, c)) {
                c += 1;
            }
            if key(g(out, root)) >= key(g(out, c)) {
                break;
            }
            core::ptr::swap(out.add(root), out.add(c));
            root = c;
        }
    };
    if n > 1 {
        let mut i = n / 2;
        while i > 0 {
            i -= 1;
            sift(i, n);
        }
        let mut end = n;
        while end > 1 {
            end -= 1;
            core::ptr::swap(out, out.add(end));
            sift(0, end);
        }
    }
    s(oc, 0, n as i32);
}

// =====================================================================
// HEALER CANDIDATES, UPKEEP BINS
// =====================================================================

/// Into the K lowest (ratio, id) of res/rat[b..b + K] (-1 empty, last).
#[inline(always)]
unsafe fn hc_insert(res: *mut i32, rat: *mut f32, id: *const i32, b: usize, kk: usize, q: i32, r: f32) {
    let qid = g(id, q as usize);
    let mut k = kk - 1;
    let lr = g(res, b + k);
    if lr >= 0 && (r > g(rat, b + k) || (r == g(rat, b + k) && qid >= g(id, lr as usize))) {
        return;
    }
    while k > 0 {
        let pr = g(res, b + k - 1);
        let pa = g(rat, b + k - 1);
        if pr < 0 || r < pa || (r == pa && qid < g(id, pr as usize)) {
            s(res, b + k, pr);
            s(rat, b + k, pa);
            k -= 1;
        } else {
            break;
        }
    }
    s(res, b + k, q);
    s(rat, b + k, r);
}

/// SIM_KERNEL_HEAL_CAND (worker.js healerCandidatesStep): per chunk of P[1]
/// snapshot slots, per owner below P[2] the P[3] damaged (0 < energy < max)
/// with the lowest (energy / max, id): hc.res their slots, best first (-1
/// none), hc.rat their ratios. Arrays: hc.e, hc.m, hc.o, hc.id, hc.l, hc.d,
/// hc.res, hc.rat. P: [0] slots, [1] per job, [2] owners, [3] K.
#[no_mangle]
pub unsafe extern "C" fn k_heal_cand(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (e, m, o, id, l, d, res, rat) = (k.p::<f32>(0), k.p::<f32>(1), k.p::<i16>(2), k.p::<i32>(3), k.p::<u8>(4), k.p::<u8>(5), k.p::<i32>(6), k.p::<f32>(7));
    let (np, kk) = (k.i(2).max(0) as usize, k.i(3).max(0) as usize);
    if kk == 0 {
        return;
    }
    let base = chunk as usize * np * kk;
    for j in 0..np * kk {
        s(res, base + j, -1);
        s(rat, base + j, f32::INFINITY);
    }
    let (s0, s1) = job(chunk, k.i(1), k.i(0));
    for q in s0..s1 {
        if g(l, q) == 0 || g(d, q) != 0 {
            continue;
        }
        let ow = g(o, q) as i32;
        let (ev, mv) = (g(e, q), g(m, q));
        if !(ow >= 0 && (ow as usize) < np) || !(mv > 0.0) || !(ev > 0.0) || !(ev < mv) {
            continue;
        }
        hc_insert(res, rat, id, base + ow as usize * kk, kk, q as i32, ev / mv);
    }
}

/// SIM_KERNEL_HEAL_REDUCE (one job per owner): the chunks' lists merged into
/// hc.best / hc.bestRat[owner * K..]. Arrays: hc.res, hc.rat, hc.id,
/// hc.best, hc.bestRat. P: [0] chunks, [1] owners, [2] K.
#[no_mangle]
pub unsafe extern "C" fn k_heal_reduce(a: *const i32, owner: i32) {
    let k = K::new(a);
    let (res, rat, id, out, ratio) = (k.p::<i32>(0), k.p::<f32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<f32>(4));
    let (chunks, np, kk) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2).max(0) as usize);
    if kk == 0 {
        return;
    }
    let ow = owner as usize;
    let b = ow * kk;
    for j in 0..kk {
        s(out, b + j, -1);
        s(ratio, b + j, f32::INFINITY);
    }
    for ch in 0..chunks {
        let a0 = (ch * np + ow) * kk;
        for j in 0..kk {
            let q = g(res, a0 + j);
            if q < 0 {
                break;
            }
            hc_insert(out, ratio, id, b, kk, q, g(rat, a0 + j));
        }
    }
}

/// SIM_KERNEL_UPKEEP (main.js _upkUnitsBuild, after a resync): per block of
/// P[1] units-array indices, a unit of an owner below P[2] with a type index
/// (upT) below P[3] in its bin ((type * P[2] + owner) * (P[4] + 1) + its
/// effective level, 1..P[4]): upB the bin (-1 none), counted in upk.h.
/// Arrays: ix.slots, unit.owner, unit.upT, unit.upB, unit.effectiveLevel,
/// unit.unitLevel, unit.baseLevel, unit.stackCount, upk.h.
#[no_mangle]
pub unsafe extern "C" fn k_upkeep(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (sl, own, ut, ub) = (k.p::<i32>(0), k.p::<i8>(1), k.p::<i16>(2), k.p::<i32>(3));
    let (el, ul, bl, sc, hist) = (k.p::<f32>(4), k.p::<f32>(5), k.p::<f32>(6), k.p::<f32>(7), k.p::<i32>(8));
    let (np, nt, maxl) = (k.i(2), k.i(3), k.i(4));
    let l1 = maxl + 1;
    let fin = |v: f32| v - v == 0.0;
    let (i0, i1) = job(chunk, k.i(1), k.i(0));
    for i in i0..i1 {
        let q = g(sl, i);
        if q < 0 {
            continue;
        }
        let q = q as usize;
        s(ub, q, -1);
        let ow = g(own, q) as i32;
        let t = g(ut, q) as i32;
        if !(ow >= 0 && ow < np) || t < 0 || t >= nt {
            continue;
        }
        let mut l = g(el, q);
        if !fin(l) {
            l = g(ul, q);
            if !fin(l) {
                l = g(bl, q);
                if !fin(l) {
                    let st = g(sc, q);
                    l = if fin(st) { stack_level(if st == 0.0 { 1.0 } else { st }, i32::MAX) as f32 } else { 1.0 };
                }
            }
        }
        let lv = (floorf(l) as i32).min(maxl).max(1);
        let b = (t * np + ow) * l1 + lv;
        s(ub, q, b);
        atomic_add(hist, b as usize, 1);
    }
}

// =====================================================================
// HOSTILE TABLES, RADIX ORDER, AREA BOXES, HEAP ZEROING
// =====================================================================

/// SIM_KERNEL_SAT_ROWS (unit.js _simMoveBuildHostile): per player and
/// P[3] block rows, each row's prefix: mv.hostile other players' units
/// (ix.bcount) plus the structures hostile to the player (mv.stblk),
/// mv.hstruct the structures alone; row and column 0 zero. Arrays:
/// mv.hostile, mv.hstruct, ix.bcount, mv.stblk. P: [0] players, [1]/[2]
/// blocks wide/high, [3] rows a job.
#[no_mangle]
pub unsafe extern "C" fn k_sat_rows(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (h, hs, cnt, st) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3));
    let (players, bc, br, per) = (k.i(0).max(1) as usize, k.i(1).max(0) as usize, k.i(2).max(0) as usize, k.i(3).max(1) as usize);
    let stride = bc + 1;
    let plane = stride * (br + 1);
    let jobs = (br + per - 1) / per;
    if jobs == 0 {
        return;
    }
    let ch = chunk as usize;
    let p = ch / jobs;
    let o = p * plane;
    let by0 = (ch - p * jobs) * per;
    let by1 = br.min(by0 + per);
    if by0 == 0 {
        for i in 0..stride {
            s(h, o + i, 0);
            s(hs, o + i, 0);
        }
    }
    for by in by0..by1 {
        let row = o + (by + 1) * stride;
        s(h, row, 0);
        s(hs, row, 0);
        let (mut run, mut run_s) = (0i32, 0i32);
        for bx in 0..bc {
            let base = (by * bc + bx) * players;
            let sv = g(st, base + p);
            let mut tot = 0i32;
            for q in 0..players {
                tot = tot.wrapping_add(g(cnt, base + q));
            }
            run_s = run_s.wrapping_add(sv);
            run = run.wrapping_add(sv.wrapping_add(tot).wrapping_sub(g(cnt, base + p)));
            s(h, row + bx + 1, run);
            s(hs, row + bx + 1, run_s);
        }
    }
}

/// SIM_KERNEL_SAT_COLS: per player and P[3] columns, the rows summed down.
/// Arrays: mv.hostile, mv.hstruct. P as SAT_ROWS.
#[no_mangle]
pub unsafe extern "C" fn k_sat_cols(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (h, hs) = (k.p::<i32>(0), k.p::<i32>(1));
    let (bc, br, per) = (k.i(1).max(0) as usize, k.i(2).max(0) as usize, k.i(3).max(1) as usize);
    let stride = bc + 1;
    let plane = stride * (br + 1);
    let jobs = (bc + per - 1) / per;
    if jobs == 0 {
        return;
    }
    let ch = chunk as usize;
    let p = ch / jobs;
    let o = p * plane;
    let c0 = 1 + (ch - p * jobs) * per;
    let c1 = bc.min(c0 - 1 + per);
    if c0 > c1 {
        return;
    }
    for by in 2..=br {
        let row = o + by * stride;
        let above = row - stride;
        let mut c = c0;
        while c + 4 <= c1 + 1 {
            let (r, ab) = (h.add(row + c) as *mut v128, h.add(above + c) as *const v128);
            v128_store(r, i32x4_add(v128_load(r), v128_load(ab)));
            let (r, ab) = (hs.add(row + c) as *mut v128, hs.add(above + c) as *const v128);
            v128_store(r, i32x4_add(v128_load(r), v128_load(ab)));
            c += 4;
        }
        while c <= c1 {
            s(h, row + c, g(h, row + c).wrapping_add(g(h, above + c)));
            s(hs, row + c, g(hs, row + c).wrapping_add(g(hs, above + c)));
            c += 1;
        }
    }
}

/// SIM_KERNEL_SPATIAL_HISTOGRAM (a stable radix order's pass, per partition
/// of P[1]): the digit counts of its entries at spatial.hist[part * 256..].
/// Arrays: spatial.keys(.slot), spatial.orderA, spatial.orderB,
/// spatial.hist. P: [0] count, [1] partition, [2] shift, [3] 1: the first
/// pass (entries in index order), [4] flip (input B), [5] key slot.
#[no_mangle]
pub unsafe extern "C" fn k_radix_hist(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (keys, oa, ob, hist) = (k.p::<u32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3));
    let shift = (k.i(2) & 31) as u32;
    let first = k.i(3) != 0;
    let input = if k.i(4) != 0 { ob } else { oa };
    let base = chunk as usize * 256;
    let hh = hist.add(base);
    for d in 0..256 {
        s(hh, d, 0);
    }
    let (i0, i1) = job(chunk, k.i(1), k.i(0));
    for i in i0..i1 {
        let u = if first { i } else { g(input, i) as usize };
        let d = ((g(keys, u) >> shift) & 255) as usize;
        s(hh, d, g(hh, d) + 1);
    }
}

/// SIM_KERNEL_SPATIAL_PREFIX (one job): the histograms' cursors, per digit
/// per partition in order. Arrays: spatial.hist. P: [0] partitions.
#[no_mangle]
pub unsafe extern "C" fn k_radix_prefix(a: *const i32, _chunk: i32) {
    let k = K::new(a);
    let hist = k.p::<i32>(0);
    let parts = k.i(0).max(0) as usize;
    let mut cur = 0i32;
    for d in 0..256 {
        for p in 0..parts {
            let i = p * 256 + d;
            let n = g(hist, i);
            s(hist, i, cur);
            cur += n;
        }
    }
}

/// SIM_KERNEL_SPATIAL_SCATTER: the entries of a partition to their cursors.
/// Arrays and P as SPATIAL_HISTOGRAM.
#[no_mangle]
pub unsafe extern "C" fn k_radix_scatter(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (keys, oa, ob, hist) = (k.p::<u32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3));
    let shift = (k.i(2) & 31) as u32;
    let first = k.i(3) != 0;
    let flip = k.i(4) != 0;
    let (input, output) = if flip { (ob, oa) } else { (oa, ob) };
    let hh = hist.add(chunk as usize * 256);
    let (i0, i1) = job(chunk, k.i(1), k.i(0));
    for i in i0..i1 {
        let u = if first { i } else { g(input, i) as usize };
        let d = ((g(keys, u) >> shift) & 255) as usize;
        let c = g(hh, d);
        s(hh, d, c + 1);
        s(output, c as usize, u as i32);
    }
}

/// SIM_KERNEL_AREA_BOX (unit.js _simAreaBoxStep, one stage per distance d):
/// every area's tile box at d steps, its box at d - 1 joined with its
/// neighbours' (d = 0: its own); abox.out[(a * P[2] + d) * 4]: min gx, min
/// gy, max gx, max gy; empty [1, 1, 0, 0]. Arrays: abox.own, abox.out,
/// abox.off, abox.nb. P: [0] areas, [1] per job, [2] distances, [3] d.
#[no_mangle]
pub unsafe extern "C" fn k_area_box(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (own, out, off, nb) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3));
    let (dd, d) = (k.i(2).max(1) as usize, k.i(3).max(0) as usize);
    let (a0, a1) = job(chunk, k.i(1), k.i(0));
    for ar in a0..a1 {
        let o = (ar * dd + d) * 4;
        if d == 0 {
            for j in 0..4 {
                s(out, o + j, g(own, ar * 4 + j));
            }
            continue;
        }
        let p = o - 4;
        let (mut x0, mut y0, mut x1, mut y1) = (g(out, p), g(out, p + 1), g(out, p + 2), g(out, p + 3));
        for j in g(off, ar)..g(off, ar + 1) {
            let q = (g(nb, j as usize) as usize * dd + d - 1) * 4;
            let (qx0, qy0, qx1, qy1) = (g(out, q), g(out, q + 1), g(out, q + 2), g(out, q + 3));
            if qx0 > qx1 {
                continue;
            }
            if x0 > x1 {
                x0 = qx0; y0 = qy0; x1 = qx1; y1 = qy1;
                continue;
            }
            x0 = x0.min(qx0);
            y0 = y0.min(qy0);
            x1 = x1.max(qx1);
            y1 = y1.max(qy1);
        }
        s(out, o, x0);
        s(out, o + 1, y0);
        s(out, o + 2, x1);
        s(out, o + 3, y1);
    }
}

/// SIM_KERNEL_ZERO (simParallelZeroHeap): heap bytes P[0] + chunk * P[2] up
/// to P[0] + P[1] zeroed.
#[no_mangle]
pub unsafe extern "C" fn k_zero(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (o, n, per) = (k.f(0) as usize, k.f(1) as usize, k.f(2) as usize);
    let s0 = o + chunk as usize * per;
    let e = (o + n).min(s0 + per);
    if s0 < e {
        core::ptr::write_bytes(s0 as *mut u8, 0, e - s0);
    }
}

// =====================================================================
// LASER BEAMS, EFFECTIVE-STATS WINDOWS, ADJACENCY GROUPS
// =====================================================================

/// SIM_KERNEL_LASER_HITS (tower.js laserBeamsTick): a unit on a beam's tile
/// (lz.head per tile, lz.next / lz.beam its entries) of another owner
/// (lz.bown) takes the beam's damage (lz.bdmg) unless immune to towers
/// (lzFlags 1); laser resistant (2) it lights the beam only (lz.hit). Its
/// energy goes down now (dead at none left); a record (lzEv 1, lzAcc the sum,
/// lzBeam the last beam) every P[6] ticks by id or as it dies; lz.count[chunk]
/// the records. Arrays: unit.x, unit.y, unit.dead, unit.sepKey, unit.owner,
/// unit.energy, unit.id, unit.lzFlags, unit.lzAcc, unit.lzBeam, unit.lzEv,
/// lz.head, lz.next, lz.beam, lz.bown, lz.bdmg, lz.hit, lz.count.
/// P: [0] slots, [1] per job, [2] TILE, [3]/[4] grid, [5] tick, [6] report
/// period, [7] absent key.
#[no_mangle]
pub unsafe extern "C" fn k_laser_hits(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (xs, ys, dead, sep, own, en, uid) = (k.p::<f32>(0), k.p::<f32>(1), k.p::<u8>(2), k.p::<u32>(3), k.p::<i8>(4), k.p::<f32>(5), k.p::<i32>(6));
    let (lzf, acc, lb, ev) = (k.p::<u8>(7), k.p::<f32>(8), k.p::<i32>(9), k.p::<u8>(10));
    let (head, next, beam, bown, bdmg, hit, cnt) = (k.p::<i32>(11), k.p::<i32>(12), k.p::<i32>(13), k.p::<i32>(14), k.p::<f32>(15), k.p::<u8>(16), k.p::<i32>(17));
    let itile = (1.0 / k.f(2)) as f32;
    let (w, h, t, per) = (k.i(3), k.i(4), k.i(5), k.i(6).max(1));
    let absent = k.f(7) as u32;
    let (s0, s1) = job(chunk, k.i(1), k.i(0));
    let mut n = 0i32;
    for q in s0..s1 {
        if g(ev, q) != 0 {
            s(ev, q, 0);
        }
        if g(dead, q) != 0 || g(sep, q) == absent {
            continue;
        }
        let gx = floorf(g(xs, q) * itile) as i32;
        let gy = floorf(g(ys, q) * itile) as i32;
        if gx < 0 || gy < 0 || gx >= w || gy >= h {
            continue;
        }
        let mut e = g(head, (gy * w + gx) as usize);
        if e < 0 {
            continue;
        }
        let fl = g(lzf, q);
        if fl & 1 != 0 {
            continue;
        }
        let ow = g(own, q) as i32;
        let mut dmg = 0f32;
        let mut last = -1i32;
        while e >= 0 {
            let b = g(beam, e as usize) as usize;
            e = g(next, e as usize);
            if g(bown, b) == ow {
                continue;
            }
            s(hit, b, 1);
            if fl & 2 != 0 {
                continue;
            }
            dmg += g(bdmg, b);
            last = b as i32;
        }
        if !(dmg > 0.0) {
            continue;
        }
        let ne = g(en, q) - dmg;
        s(en, q, ne);
        s(acc, q, g(acc, q) + dmg);
        s(lb, q, last);
        let died = !(ne > 0.0);
        if died {
            s(dead, q, 1);
        }
        if died || (t as i64 + g(uid, q) as i64).rem_euclid(per as i64) == 0 {
            s(ev, q, 1);
            n += 1;
        }
    }
    s(cnt, chunk as usize, n);
}

/// SIM_KERNEL_EFF_COUNT (things_utils.js _countNearbySameTypeUnits): per
/// window (eff.win: x1, y1, x2, y2 in type blocks, lane; lane < 0 none) the
/// sum of spatial.types over it at its lane: eff.out. Arrays: eff.win,
/// eff.out, spatial.types. P: [0] windows, [1] per job, [2] blocks wide,
/// [3] stride per block.
#[no_mangle]
pub unsafe extern "C" fn k_eff_count(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (win, out, data) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2));
    let (cw, stride) = (k.i(2) as isize, k.i(3) as isize);
    let (i0, i1) = job(chunk, k.i(1), k.i(0));
    for i in i0..i1 {
        let o = i * 5;
        let lane = g(win, o + 4);
        if lane < 0 {
            continue;
        }
        let (x1, y1, x2, y2) = (g(win, o) as isize, g(win, o + 1) as isize, g(win, o + 2) as isize, g(win, o + 3) as isize);
        let mut sum = 0i32;
        for y in y1..=y2 {
            let mut idx = (y * cw + x1) * stride + lane as isize;
            for _ in x1..=x2 {
                sum = sum.wrapping_add(*data.offset(idx));
                idx += stride;
            }
        }
        s(out, i, sum);
    }
}

/// SIM_KERNEL_ADJ_FLOOD (one job; things_utils.js adjacencyLaneStep): from
/// the signature grid (adj.sig, -1 none), the 4-connected equal-signature
/// groups (joined through paired cloud portals of the signature's owner:
/// adj.cloud [tile, partner or -1, owner] triples) reached from the seeds'
/// 3x3s (adj.seed): their tiles in order (adj.otile, adj.ogrp), each group's
/// size and multiplier (adj.gsize, adj.gmul: every area it touches whose
/// cells all bear its signature multiplies by cells^(level + 1), adj.mul the
/// level), and the areas touched (adj.oarea, adj.oact 1: uniform). Counts:
/// adj.ocnt [members, groups, areas]. Work: adj.wk (stamps; kept from run
/// to run). Arrays: adj.sig, adj.seed, adj.cloud, adj.ag, adj.coff,
/// adj.ctile, adj.mul, adj.otile, adj.ogrp, adj.gsize, adj.gmul, adj.oarea,
/// adj.oact, adj.ocnt, adj.wk. P: [0]/[1] grid, [2] seeds, [3] cloud
/// triples, [4] areas.
#[no_mangle]
pub unsafe extern "C" fn k_adj_flood(a: *const i32, _chunk: i32) {
    let k = K::new(a);
    let (sig, seed, cl, ag, coff, ct, mul) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6));
    let (ot, og, gs, gm, oa, oact, cnt, wk) = (k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9), k.p::<f64>(10), k.p::<i32>(11), k.p::<u8>(12), k.p::<i32>(13), k.p::<i32>(14));
    let (w, h, ns, nc, na) = (k.i(0), k.i(1), k.i(2).max(0) as usize, k.i(3).max(0) as usize, k.i(4).max(0) as usize);
    let n = (w * h).max(0) as usize;
    // (adj.wk: [0] epoch, [1] group stamp, then per tile visited, queue,
    // cloud stamp, cloud index; per area signature seen, signature, listed,
    // seen by the group.)
    let vis = wk.add(8);
    let qq = vis.add(n);
    let cls = qq.add(n);
    let cli = cls.add(n);
    let aseen = cli.add(n);
    let asig = aseen.add(na);
    let alist = asig.add(na);
    let gseen = alist.add(na);
    let mut ep = *wk + 1;
    if ep >= 0x7fff_ffff {
        core::ptr::write_bytes(vis, 0, 4 * n + 4 * na);
        *wk.add(1) = 0;
        ep = 1;
    }
    *wk = ep;
    let mut gst = *wk.add(1);
    for i in 0..nc {
        let t = g(cl, 3 * i);
        if t >= 0 && (t as usize) < n {
            s(cls, t as usize, ep);
            s(cli, t as usize, i as i32);
        }
    }
    let area_sig = |ar: usize| -> i32 {
        if g(aseen, ar) == ep {
            return g(asig, ar);
        }
        s(aseen, ar, ep);
        let mut sg = -2i32;
        for i in g(coff, ar)..g(coff, ar + 1) {
            let v = g(sig, g(ct, i as usize) as usize);
            if v < 0 || (sg != -2 && v != sg) {
                sg = -1;
                break;
            }
            sg = v;
        }
        if sg == -2 {
            sg = -1;
        }
        s(asig, ar, sg);
        sg
    };
    let (mut no, mut ng, mut nl) = (0usize, 0i32, 0usize);
    let note_area = |ar: i32, nl: &mut usize| {
        if ar >= 0 && (ar as usize) < na && g(alist, ar as usize) != ep {
            s(alist, ar as usize, ep);
            s(oa, *nl, ar);
            *nl += 1;
        }
    };
    // (Down, up, right, left; no tables: no data segment.)
    let ddx = |d: usize| (d == 2) as i32 - (d == 3) as i32;
    let ddy = |d: usize| (d == 0) as i32 - (d == 1) as i32;
    for kq in 0..ns {
        let t0 = g(seed, kq);
        if t0 >= 0 && (t0 as usize) < n {
            note_area(g(ag, t0 as usize), &mut nl);
        }
        let sx = irem(t0, w);
        let sy = idiv(t0 - sx, w);
        for dy in -1..=1 {
            for dx in -1..=1 {
                let (x, y) = (sx + dx, sy + dy);
                if x < 0 || y < 0 || x >= w || y >= h {
                    continue;
                }
                let r = (y * w + x) as usize;
                let sg = g(sig, r);
                if sg < 0 || g(vis, r) == ep {
                    continue;
                }
                let grp = ng;
                ng += 1;
                let first = no;
                let (mut qh, mut qt) = (0usize, 0usize);
                s(vis, r, ep);
                s(qq, qt, r as i32);
                qt += 1;
                s(ot, no, r as i32);
                s(og, no, grp);
                no += 1;
                while qh < qt {
                    let cur = g(qq, qh);
                    qh += 1;
                    let cx = irem(cur, w);
                    let cy = idiv(cur, w);
                    for d in 0..4 {
                        let nx = cx + ddx(d);
                        let ny = cy + ddy(d);
                        if nx < 0 || ny < 0 || nx >= w || ny >= h {
                            continue;
                        }
                        let nt = (ny * w + nx) as usize;
                        if g(vis, nt) != ep && g(sig, nt) == sg {
                            s(vis, nt, ep);
                            s(qq, qt, nt as i32);
                            qt += 1;
                            s(ot, no, nt as i32);
                            s(og, no, grp);
                            no += 1;
                        }
                        // (A paired cloud portal of the group's owner beside
                        // it: the tiles around both ends join too.)
                        if nc != 0 && g(cls, nt) == ep {
                            let ci = g(cli, nt) as usize;
                            if g(cl, 3 * ci + 2) == (sg & 255) {
                                for end in 0..2 {
                                    let e = g(cl, 3 * ci + end);
                                    if e < 0 {
                                        continue;
                                    }
                                    let ex = irem(e, w);
                                    let ey = idiv(e, w);
                                    for d2 in 0..4 {
                                        let mx = ex + ddx(d2);
                                        let my = ey + ddy(d2);
                                        if mx < 0 || my < 0 || mx >= w || my >= h {
                                            continue;
                                        }
                                        let mt = (my * w + mx) as usize;
                                        if g(vis, mt) != ep && g(sig, mt) == sg {
                                            s(vis, mt, ep);
                                            s(qq, qt, mt as i32);
                                            qt += 1;
                                            s(ot, no, mt as i32);
                                            s(og, no, grp);
                                            no += 1;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                // Its areas: the multiplier of those uniform in its signature.
                gst += 1;
                if gst >= 0x7fff_ffff {
                    for i in 0..na {
                        s(gseen, i, 0);
                    }
                    gst = 1;
                }
                let mut mult = 1f64;
                for i in first..no {
                    let ar = g(ag, g(ot, i) as usize);
                    if ar < 0 || ar as usize >= na || g(gseen, ar as usize) == gst {
                        continue;
                    }
                    s(gseen, ar as usize, gst);
                    note_area(ar, &mut nl);
                    if area_sig(ar as usize) != sg {
                        continue;
                    }
                    let cells = (g(coff, ar as usize + 1) - g(coff, ar as usize)).max(1) as f64;
                    let mut e = g(mul, ar as usize) + 1;
                    let (mut res, mut p) = (1f64, cells);
                    while e > 0 {
                        if e & 1 == 1 {
                            res *= p;
                        }
                        p *= p;
                        e >>= 1;
                    }
                    mult *= res;
                }
                s(gs, grp as usize, (no - first) as i32);
                s(gm, grp as usize, mult);
            }
        }
    }
    *wk.add(1) = gst;
    for i in 0..nl {
        s(oact, i, if area_sig(g(oa, i) as usize) >= 0 { 1 } else { 0 });
    }
    s(cnt, 0, no as i32);
    s(cnt, 1, ng);
    s(cnt, 2, nl as i32);
}

// =====================================================================
// THE NAVIGATION BUILD (flownav.js navBuild*)
// =====================================================================

/// SIM_KERNEL_NAV_COST (navStepCosts by rows, P[2] a job): pass P[0] 0 the
/// rows' horizontal reach flags into navb.h (bit 0: a wall within 1, bit 1:
/// within 2), pass 1 the costs (3, 2, 1) from those of the rows around.
/// Arrays: navb.wall, navb.h, navb.cost. P: [0] pass, [2] rows a job,
/// [3]/[4] grid.
#[no_mangle]
pub unsafe extern "C" fn k_nav_cost(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (wall, hh, out) = (k.p::<u8>(0), k.p::<u8>(1), k.p::<u8>(2));
    let (w, h) = (k.i(3).max(0) as usize, k.i(4).max(0) as usize);
    let (y0, y1) = job(chunk, k.i(2), h as i32);
    if k.i(0) == 0 {
        for y in y0..y1 {
            let o = y * w;
            for x in 0..w {
                let wl = |dx: isize| g(wall, (o as isize + x as isize + dx) as usize) != 0;
                let a1 = g(wall, o + x) != 0 || x < 1 || x + 1 >= w || wl(-1) || wl(1);
                let a2 = a1 || x < 2 || x + 2 >= w || wl(-2) || wl(2);
                s(hh, o + x, (a1 as u8) | ((a2 as u8) << 1));
            }
        }
        return;
    }
    for y in y0..y1 {
        let o = y * w;
        for x in 0..w {
            let t = o + x;
            let ht = g(hh, t);
            if ht & 1 != 0 || y < 1 || y + 1 >= h || g(hh, t - w) & 1 != 0 || g(hh, t + w) & 1 != 0 {
                s(out, t, 3);
                continue;
            }
            let two = ht & 2 != 0 || y < 2 || y + 2 >= h || g(hh, t - w) & 2 != 0 || g(hh, t + w) & 2 != 0 || g(hh, t - 2 * w) & 2 != 0 || g(hh, t + 2 * w) & 2 != 0;
            s(out, t, if two { 2 } else { 1 });
        }
    }
}

/// SIM_KERNEL_NAV_NODES (P[2] clusters a job): where walkable tiles face
/// each other across a cluster border, spans of at most C / 2 tiles, a node
/// at each span's middle on either side: a cluster's nodes on its side by
/// border N, W, E, S (each along it) at navb.ns (P[11] slots a cluster),
/// their counts navb.nsc (4 a cluster). Arrays: navb.wall, navb.ns,
/// navb.nsc. P: [0] first, [1] end, [2] per job, [3]/[4] grid, [5] C, [6]
/// clusters wide, [7] clusters, [11] slots a cluster.
#[no_mangle]
pub unsafe extern "C" fn k_nav_nodes(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (wall, ns, nsc) = (k.p::<u8>(0), k.p::<i32>(1), k.p::<i32>(2));
    let (w, h, c_, cw, nc, nm) = (k.i(3), k.i(4), k.i(5), k.i(6), k.i(7), k.i(11));
    let span = c_ >> 1;
    let open = |t: i32| g(wall, t as usize) == 0;
    let (c0, c1) = job(chunk, k.i(2), nc);
    for c in c0 as i32..c1 as i32 {
        let cx = irem(c, cw);
        let cy = idiv(c, cw);
        let (x0, y0) = (cx * c_, cy * c_);
        let x1 = w.min(x0 + c_) - 1;
        let y1 = h.min(y0 + c_) - 1;
        let n0 = c * nm;
        let mut kk = 0i32;
        for side in 0..4 {
            let mut cnt = 0;
            let has = match side { 0 => cy > 0, 1 => cx > 0, 2 => x1 + 1 < w, _ => y1 + 1 < h };
            if has {
                let along = side == 0 || side == 3;
                let (a0, a1) = if along { (x0, x1) } else { (y0, y1) };
                let mut start = -1i32;
                for av in a0..=a1 + 1 {
                    let ok = av <= a1 && match side {
                        0 => open((y0 - 1) * w + av) && open(y0 * w + av),
                        1 => open(av * w + x0 - 1) && open(av * w + x0),
                        2 => open(av * w + x1) && open(av * w + x1 + 1),
                        _ => open(y1 * w + av) && open((y1 + 1) * w + av),
                    };
                    if ok && start < 0 {
                        start = av;
                    }
                    let len = if start < 0 { 0 } else if ok { av - start + 1 } else { av - start };
                    if start >= 0 && (!ok || len == span) {
                        let m = start + (len >> 1);
                        if kk < nm {
                            s(ns, (n0 + kk) as usize, match side { 0 => y0 * w + m, 1 => m * w + x0, 2 => m * w + x1, _ => y1 * w + m });
                        }
                        kk += 1;
                        cnt += 1;
                        start = -1;
                    }
                }
            }
            s(nsc, (c * 4 + side) as usize, cnt);
        }
    }
}

/// SIM_KERNEL_NAV_PARTS (P[2] clusters a job): the walkable tiles connected
/// inside a cluster (4-way), numbered in row-major order of their first
/// tile: navb.partL per tile (0xFFFF a wall), navb.partN per cluster.
/// Arrays: navb.wall, navb.partL, navb.partN. P as NAV_NODES. (The queue in
/// the thread's scratch.)
#[no_mangle]
pub unsafe extern "C" fn k_nav_parts(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (wall, pl, pn) = (k.p::<u8>(0), k.p::<u16>(1), k.p::<i32>(2));
    let (w, h, c_, cw, nc) = (k.i(3), k.i(4), k.i(5), k.i(6), k.i(7));
    let (sc, sw) = scratch(a);
    if sc.is_null() || sw < 4 + (c_ * c_).max(0) as usize {
        return;
    }
    *sc = 0;
    let qq = sc.add(4);
    let wu = w as usize;
    let (c0, c1) = job(chunk, k.i(2), nc);
    for c in c0 as i32..c1 as i32 {
        let cx = irem(c, cw);
        let cy = idiv(c, cw);
        let (x0, y0) = (cx * c_, cy * c_);
        let (x1, y1) = (w.min(x0 + c_), h.min(y0 + c_));
        for y in y0..y1 {
            for x in x0..x1 {
                s(pl, (y * w + x) as usize, 0xFFFF);
            }
        }
        let mut n = 0u16;
        for y in y0..y1 {
            for x in x0..x1 {
                let t0 = (y * w + x) as usize;
                if g(wall, t0) != 0 || g(pl, t0) != 0xFFFF {
                    continue;
                }
                s(pl, t0, n);
                let (mut qh, mut qt) = (0usize, 1usize);
                s(qq, 0, t0 as i32);
                while qh < qt {
                    let t = g(qq, qh) as usize;
                    qh += 1;
                    let ti = t as i32;
                    let tx = irem(ti, w);
                    let ty = idiv(ti, w);
                    let mut take = |u: usize| {
                        if g(wall, u) == 0 && g(pl, u) == 0xFFFF {
                            s(pl, u, n);
                            s(qq, qt, u as i32);
                            qt += 1;
                        }
                    };
                    if tx + 1 < x1 { take(t + 1); }
                    if tx > x0 { take(t - 1); }
                    if ty + 1 < y1 { take(t + wu); }
                    if ty > y0 { take(t - wu); }
                }
                n = n.wrapping_add(1);
            }
        }
        s(pn, c as usize, n as i32);
    }
}

/// SIM_KERNEL_NAV_GRAPH (P[2] nodes a job). Mode P[12] 0: each node's edge
/// count into navb.adjN; 1: its edges from navb.adjS on (navb.adjA the node,
/// navb.adjC the cost) and the job's largest cost into navb.adjMax[chunk].
/// A node's edges: its cluster's other nodes whose local field reaches its
/// tile (that value), then the node across its border (the step cost of its
/// tile; 1 without costs). Arrays: navb.fields, navb.nt, navb.nb, navb.np,
/// ?navb.cost, navb.adjN, ?navb.adjS, ?navb.adjA, ?navb.adjC, ?navb.adjMax.
#[no_mangle]
pub unsafe extern "C" fn k_nav_graph(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (fields, nt, nb, np, cost) = (k.p::<u16>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<u8>(4));
    let (nn, ss, aa, ac, amax) = (k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9));
    let (w, c_, cw) = (k.i(3), k.i(5), k.i(6));
    let cc = (c_ * c_) as usize;
    let fill = k.i(12) == 1;
    if fill && (ss.is_null() || aa.is_null() || ac.is_null() || amax.is_null()) {
        return;
    }
    let first = k.i(0).max(0) as usize;
    let per = k.i(2).max(1) as usize;
    let i0 = first + chunk as usize * per;
    let i1 = (k.i(1).max(0) as usize).min(i0 + per);
    let mut mx = 0i32;
    for i in i0..i1 {
        let t = g(nt, i);
        let tx = irem(t, w);
        let ty = idiv(t, w);
        let cx = idiv(tx, c_);
        let cy = idiv(ty, c_);
        let c = (cy * cw + cx) as usize;
        let (b0, b1) = (g(nb, c) as usize, g(nb, c + 1) as usize);
        let loc = ((ty - cy * c_) * c_ + (tx - cx * c_)) as usize;
        let mut e = if fill { g(ss, i) as usize } else { 0 };
        let mut n = 0i32;
        for j in b0..b1 {
            if j == i {
                continue;
            }
            let v = g(fields, j * cc + loc);
            if v == 0xFFFF {
                continue;
            }
            if fill {
                s(aa, e, j as i32);
                s(ac, e, v as i32);
                e += 1;
                mx = mx.max(v as i32);
            } else {
                n += 1;
            }
        }
        let p = g(np, i);
        if p >= 0 {
            if fill {
                let v = if cost.is_null() { 1 } else { g(cost, g(nt, p as usize) as usize) as i32 };
                s(aa, e, p);
                s(ac, e, v);
                mx = mx.max(v);
            } else {
                n += 1;
            }
        }
        if !fill {
            s(nn, i, n);
        }
    }
    if fill {
        s(amax, chunk as usize, mx);
    }
}

/// SIM_KERNEL_NAV_SUBST (one request: chunk): component K's tile nearest tile
/// `to` (profile p's build), the lowest tile of those as near; -1 none.
/// Its parts by their cluster's distance to `to`: the nearest first, then
/// every other that may hold a nearer tile. Arrays: nav.sreq [p, to, K],
/// nav.sout, ?nav.<p>.meta, partL, partB, pclu, cstart, cparts (meta[11]:
/// components).
#[no_mangle]
pub unsafe extern "C" fn k_nav_subst(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (req, out, meta, pl, pb, pclu, cst, cpt) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<u16>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7));
    let i = chunk as usize;
    s(out, i, -1);
    if meta.is_null() || pl.is_null() || cst.is_null() {
        return;
    }
    let (to, kc) = (g(req, i * 3 + 1), g(req, i * 3 + 2));
    let (c_, cw, w, h, ncomp) = (g(meta, 0), g(meta, 1), g(meta, 4), g(meta, 5), g(meta, 11));
    if !(kc >= 0 && kc < ncomp) || w <= 0 {
        return;
    }
    let tx = irem(to, w);
    let ty = idiv(to, w);
    let a0 = g(cst, kc as usize) as usize;
    let n = (g(cst, kc as usize + 1) as usize).saturating_sub(a0);
    if n == 0 {
        return;
    }
    // (The squared distance from `to` to a part's cluster box.)
    let lb = |j: usize| -> i64 {
        let c = g(pclu, g(cpt, a0 + j) as usize);
        let cx = irem(c, cw);
        let cy = idiv(c, cw);
        let (x0, y0) = (cx * c_, cy * c_);
        let x1 = w.min(x0 + c_) - 1;
        let y1 = h.min(y0 + c_) - 1;
        let dx = (if tx < x0 { x0 - tx } else if tx > x1 { tx - x1 } else { 0 }) as i64;
        let dy = (if ty < y0 { y0 - ty } else if ty > y1 { ty - y1 } else { 0 }) as i64;
        dx * dx + dy * dy
    };
    let mut best = -1i32;
    let mut bd = i64::MAX;
    let scan = |j: usize, best: &mut i32, bd: &mut i64| {
        let q = g(cpt, a0 + j);
        let c = g(pclu, q as usize);
        let l = (q - g(pb, c as usize)) as u16;
        let cx = irem(c, cw);
        let cy = idiv(c, cw);
        let (x0, y0) = (cx * c_, cy * c_);
        let (x1, y1) = (w.min(x0 + c_), h.min(y0 + c_));
        for y in y0..y1 {
            let ddy = (y - ty) as i64;
            let mut t = y * w + x0;
            for x in x0..x1 {
                if g(pl, t as usize) == l {
                    let ddx = (x - tx) as i64;
                    let dd = ddx * ddx + ddy * ddy;
                    if dd < *bd || (dd == *bd && t < *best) {
                        *bd = dd;
                        *best = t;
                    }
                }
                t += 1;
            }
        }
    };
    // The nearest part first (a bound for the rest), then the others that
    // may be nearer.
    let mut j0 = 0usize;
    let mut l0 = i64::MAX;
    for j in 0..n {
        let v = lb(j);
        if v < l0 {
            l0 = v;
            j0 = j;
        }
    }
    scan(j0, &mut best, &mut bd);
    for j in 0..n {
        if j != j0 && lb(j) <= bd {
            scan(j, &mut best, &mut bd);
        }
    }
    s(out, i, best);
}

// =====================================================================
// A PLAYER'S VISIBILITY GRID (renderer.js computeVisibilityGridForPlayer)
// =====================================================================

/// The words k_visibility works in for a W x H grid of `na` areas.
#[inline(always)]
fn vis_work_words(n: usize, h: usize, na: usize) -> usize {
    (n + 3) / 4 + 2 * h + 5 * na + 8
}

/// SIM_KERNEL_VISIBILITY (one job per (player, grid) of vis.jobs): the
/// player's light from its sources (vis.src (x, y, range) from
/// vis.srcOff[2 * player], that many): each source lights its own tile
/// (range * P[3] tiles), across the borders of the areas under its +-0.3
/// tile window; areas within its range in area steps of those are lit
/// whole (an area-less source: a circle of tiles); then values fall by one
/// per tile away from where they are set, within the lit tiles. Arrays: the
/// grid vis.g.<player>.<k> (Float32), vis.src, vis.srcOff, vis.jobs,
/// vis.areaGrid, vis.nbOff, vis.nb, vis.cellOff, vis.cells, vis.areaExists,
/// ?vis.wk (P[5] words a job; else the thread's scratch).
/// P: [0]/[1] grid, [2] TILE, [3] tiles per area step, [4] areas, [5] work
/// words per job (0: the scratch).
#[no_mangle]
pub unsafe extern "C" fn k_visibility(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (out, src, soff, jobs, ag) = (k.p::<f32>(0), k.p::<f32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4));
    let (nbo, nb, co, cells, ex, wkb) = (k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8), k.p::<u8>(9), k.p::<i32>(10));
    let (w, h) = (k.i(0).max(0), k.i(1).max(0));
    let itile = (1.0 / k.f(2)) as f32;
    let aute = k.f(3) as f32;
    let na = k.i(4).max(0) as usize;
    let need = k.i(5).max(0) as usize;
    let (wu, hu) = (w as usize, h as usize);
    let n = wu * hu;
    let pid = g(jobs, chunk as usize * 2) as usize;
    let so = g(soff, pid * 2).max(0) as usize;
    let sn = g(soff, pid * 2 + 1).max(0) as usize;
    core::ptr::write_bytes(out, 0, n);
    if sn == 0 {
        return;
    }
    let (wk, ww) = if !wkb.is_null() && need > 0 {
        (wkb.add(chunk as usize * need), need)
    } else {
        let (sc, sw) = scratch(a);
        if sc.is_null() || sw < 4 {
            return;
        }
        *sc = 0;
        (sc.add(4), sw - 4)
    };
    if vis_work_words(n, hu, na) > ww {
        return;
    }
    let inc = wk as *mut u8;
    let span0 = wk.add((n + 3) / 4);
    let span1 = span0.add(hu);
    let amax = span1.add(hu) as *mut f32;
    let touched = amax.add(na) as *mut i32;
    let rem = touched.add(na);
    let srt = rem.add(na);
    let queue = srt.add(na);
    core::ptr::write_bytes(inc, 0, n);
    for y in 0..hu {
        s(span0, y, w);
        s(span1, y, -1);
    }
    for i in 0..na {
        s(amax, i, -1.0);
        s(rem, i, -1);
    }
    let area_at = |gx: i32, gy: i32| -> i32 {
        if gx < 0 || gy < 0 || gx >= w || gy >= h {
            return -1;
        }
        let ar = g(ag, (gy * w + gx) as usize);
        if ar >= 0 && (ar as usize) < na { ar } else { -1 }
    };
    let (mut nt, mut y0s, mut y1s) = (0usize, h, -1i32);
    for i in 0..sn {
        let o = (so + i) * 3;
        let (x, y, rg) = (g(src, o), g(src, o + 1), g(src, o + 2));
        // (No light: no range, or no place.)
        if !(rg > 0.0) || x - x != 0.0 || y - y != 0.0 {
            continue;
        }
        let rt = rg * aute;
        let fx = x * itile;
        let fy = y * itile;
        let (sx, sy) = (floorf(fx) as i32, floorf(fy) as i32);
        let area_id = area_at(sx, sy);
        // Areas under the source's +-0.3 tile window, and the light stamped
        // across area borders.
        for gy in floorf(fy - 0.3) as i32..=floorf(fy + 0.3) as i32 {
            for gx in floorf(fx - 0.3) as i32..=floorf(fx + 0.3) as i32 {
                let ar = area_at(gx, gy);
                if ar < 0 {
                    continue;
                }
                let au = ar as usize;
                if g(amax, au) < 0.0 {
                    s(touched, nt, ar);
                    nt += 1;
                    s(amax, au, 0.0);
                }
                if rg > g(amax, au) {
                    s(amax, au, rg);
                }
                if ar != area_id {
                    let t = (gy * w + gx) as usize;
                    if rt > g(out, t) {
                        s(out, t, rt);
                    }
                }
            }
        }
        // (The rows a stamp of it can light: within its reach.)
        let reach = ceilf(rt) as i32 + 1;
        let (x0, x1) = ((sx - reach).max(0), (sx + reach).min(w - 1));
        let (y0, y1) = ((sy - reach).max(0), (sy + reach).min(h - 1));
        if x0 <= x1 && y0 <= y1 {
            y0s = y0s.min(y0);
            y1s = y1s.max(y1);
            for yy in y0 as usize..=y1 as usize {
                if x0 < g(span0, yy) { s(span0, yy, x0); }
                if x1 > g(span1, yy) { s(span1, yy, x1); }
            }
        }
        // Its own tile.
        if sx >= 0 && sx < w && sy >= 0 && sy < h {
            let t = (sy * w + sx) as usize;
            if rt > g(out, t) {
                s(out, t, rt);
            }
            // Outside every area: a circle of tiles around it.
            let r = ceilf(rt) as i32;
            if area_id < 0 && r > 0 {
                let r2 = r * r;
                for yy in (sy - r).max(0)..=(sy + r).min(h - 1) {
                    let dy = yy - sy;
                    for xx in (sx - r).max(0)..=(sx + r).min(w - 1) {
                        let dx = xx - sx;
                        if dx * dx + dy * dy <= r2 {
                            s(inc, (yy * w + xx) as usize, 1);
                        }
                    }
                }
            }
        }
    }
    // Areas within each source area's range (steps over neighbours), level by
    // level from the most range left: an area is reached first at its most.
    let mut max_r = -1i32;
    for i in 0..nt {
        let au = g(touched, i) as usize;
        let r = floorf(g(amax, au).max(0.0)) as i32;
        s(srt, i, if g(ex, au) != 0 { r } else { -1 });
        if g(ex, au) != 0 && r > max_r {
            max_r = r;
        }
    }
    let (mut qt, mut ps, mut pe) = (0usize, 0usize, 0usize);
    let mut d = max_r;
    while d >= 0 {
        let ls = qt;
        for i in 0..nt {
            if g(srt, i) == d {
                let au = g(touched, i) as usize;
                if g(rem, au) == -1 {
                    s(rem, au, d);
                    s(queue, qt, au as i32);
                    qt += 1;
                }
            }
        }
        for j in ps..pe {
            let au = g(queue, j) as usize;
            for e in g(nbo, au)..g(nbo, au + 1) {
                let nn = g(nb, e as usize);
                if nn >= 0 && (nn as usize) < na && g(rem, nn as usize) == -1 {
                    s(rem, nn as usize, d);
                    s(queue, qt, nn);
                    qt += 1;
                }
            }
        }
        ps = ls;
        pe = qt;
        d -= 1;
    }
    for j in 0..qt {
        let au = g(queue, j) as usize;
        for e in g(co, au)..g(co, au + 1) {
            s(inc, g(cells, e as usize) as usize, 1);
        }
    }
    // Values fall by one per tile away from where they are set, within the
    // lit tiles (a sweep down and one up).
    let last_x = w - 1;
    let lit = |t: usize| g(inc, t) != 0;
    let mut y = y0s;
    while y <= y1s {
        let yu = y as usize;
        let (x0, x1) = (g(span0, yu), g(span1, yu));
        if x1 >= 0 {
            let row = yu * wu;
            for x in x0..=x1 {
                let t = row + x as usize;
                if !lit(t) {
                    s(out, t, 0.0);
                    continue;
                }
                let mut v = g(out, t);
                if x > 0 && lit(t - 1) { v = v.max(g(out, t - 1) - 1.0); }
                if y > 0 {
                    let p = t - wu;
                    if lit(p) { v = v.max(g(out, p) - 1.0); }
                    if x > 0 && lit(p - 1) { v = v.max(g(out, p - 1) - 1.0); }
                    if x < last_x && lit(p + 1) { v = v.max(g(out, p + 1) - 1.0); }
                }
                s(out, t, v);
            }
        }
        y += 1;
    }
    let mut y = y1s;
    while y >= y0s && y >= 0 {
        let yu = y as usize;
        let (x0, x1) = (g(span0, yu), g(span1, yu));
        if x1 >= 0 {
            let row = yu * wu;
            let mut x = x1;
            while x >= x0 {
                let t = row + x as usize;
                if !lit(t) {
                    s(out, t, 0.0);
                    x -= 1;
                    continue;
                }
                let mut v = g(out, t);
                if x < last_x && lit(t + 1) { v = v.max(g(out, t + 1) - 1.0); }
                if y < h - 1 {
                    let nx = t + wu;
                    if lit(nx) { v = v.max(g(out, nx) - 1.0); }
                    if x < last_x && lit(nx + 1) { v = v.max(g(out, nx + 1) - 1.0); }
                    if x > 0 && lit(nx - 1) { v = v.max(g(out, nx - 1) - 1.0); }
                }
                s(out, t, v);
                x -= 1;
            }
        }
        y -= 1;
    }
}

#[inline(always)]
fn ceilf(v: f32) -> f32 {
    f32x4_extract_lane::<0>(f32x4_ceil(f32x4_splat(v)))
}

/// A unit's new effective level from its stat row (SIM_KERNEL_EFF_UNITS,
/// things_utils.js _effRowAttach): the row of (owner, type, base, level) at
/// the unit's stat tables' version, else false (the JavaScript applies its
/// tables). The movement columns as simMoveStatsChanged writes them, with
/// its keeps and disarms; energy floored into [1, max]. *vis: its vision
/// changed (renderer.js visCoverOnUnitSpatialChanged).
#[inline(always)]
unsafe fn eff_row_apply(k: &K, q: usize, o: i32, ty: i32, bl: i32, el: i32, ver: i32, vis: &mut bool) -> bool {
    let (row_of, row_ver) = (k.p::<i32>(23), k.p::<i32>(24));
    if row_of.is_null() || row_ver.is_null() {
        return false;
    }
    let (np, nt, l1) = (k.i(9), k.i(8), k.i(10) + 1);
    if !(o >= 0 && o < np && ty >= 0 && ty < nt && bl >= 1 && bl < l1 && el >= 1 && el < l1) {
        return false;
    }
    let r = g(row_of, (((o * nt + ty) * l1 + bl) * l1 + el) as usize);
    if r < 0 || r >= k.i(18) || g(row_ver, r as usize) != ver {
        return false;
    }
    let ru = r as usize;
    let (r_spd, r_cost, r_rd, r_ra, r_rk, r_lzw) = (k.p::<f32>(25), k.p::<f32>(26), k.p::<i32>(27), k.p::<i32>(28), k.p::<u8>(29), k.p::<u8>(30));
    let (r_cb, r_cd, r_dmg, _r_vis, r_chs) = (k.p::<f32>(31), k.p::<f32>(32), k.p::<f32>(33), k.p::<f32>(34), k.p::<f32>(35));
    let (srow, on, fl, reach, chs, spd) = (k.p::<i32>(22), k.p::<u8>(36), k.p::<u8>(37), k.p::<u8>(38), k.p::<f32>(39), k.p::<f32>(40));
    let (cost, rdc, rac, shoot, rkc, lz) = (k.p::<f32>(41), k.p::<u8>(42), k.p::<u8>(43), k.p::<u8>(44), k.p::<u8>(45), k.p::<u8>(46));
    let (cb, acd, admg, area, en, maxe, abok) = (k.p::<f32>(47), k.p::<f32>(48), k.p::<f32>(49), k.p::<i32>(50), k.p::<f32>(51), k.p::<f32>(52), k.p::<u8>(53));
    let boxsteps = k.i(19);
    // (A moving drive-by shooter whose new reach's box is not made: the
    // JavaScript applies its tables, making the box, as on every peer.)
    {
        let f = g(fl, q);
        let rdv = g(r_rd, ru);
        if g(on, q) == 1 && (f & 16) == 0 && (f & 1) != 0 && g(r_spd, ru) >= 0.0 && rdv >= 0 && rdv < boxsteps && rdv != g(reach, q) as i32 {
            let a = g(area, q);
            if !(a >= 0) || abok.is_null() || g(abok, (a * boxsteps + rdv) as usize) == 0 {
                return false;
            }
        }
    }
    let old = g(srow, q);
    // (The cover is synced for every new level, as the JavaScript does.)
    *vis = true;
    let _ = old;
    s(srow, q, r);
    // (simMoveStatsChanged)
    let rsp = g(r_spd, ru);
    let rdv = g(r_rd, ru);
    let rav = g(r_ra, ru);
    let dmg = g(r_dmg, ru);
    let nrd = if rdv >= 0 && rdv < boxsteps { rdv as u8 } else { 255 };
    let nra = if rav >= 0 && rav < 255 { rav as u8 } else { 255 };
    let nsh = if dmg > 0.0 { 1u8 } else { 0 };
    let same = g(spd, q).to_bits() == rsp.to_bits() && g(cost, q).to_bits() == g(r_cost, ru).to_bits() && g(rdc, q) == nrd && g(rac, q) == nra
        && g(shoot, q) == nsh && g(rkc, q) == g(r_rk, ru) && g(cb, q) == g(r_cb, ru);
    s(acd, q, g(r_cd, ru));
    s(admg, q, dmg);
    s(spd, q, rsp);
    s(cost, q, g(r_cost, ru));
    s(rdc, q, nrd);
    s(rac, q, nra);
    s(shoot, q, nsh);
    s(rkc, q, g(r_rk, ru));
    s(lz, q, (g(lz, q) & 3) | (g(r_lzw, ru) << 2));
    s(cb, q, g(r_cb, ru));
    if !same {
        let o_on = g(on, q);
        let f = g(fl, q);
        if o_on == 3 || o_on == 5 {
            if dmg > 0.0 && g(r_rk, ru) == g(reach, q) {
                if o_on == 3 {
                    s(chs, q, g(r_chs, ru));
                }
            } else {
                s(on, q, 0);
            }
        } else if o_on == 2 && (f & 19) == 0 {
        } else if o_on == 2 && (f & 19) == 16 {
            // (An attack-mover's park: its new aggro reach.)
            if nra != 255 { s(reach, q, nra); } else { s(on, q, 0); }
        } else if o_on >= 2 {
            s(on, q, 0);
        } else if o_on == 1 {
            let ok = rsp >= 0.0;
            let rch = if ok && (f & 16) != 0 { rav } else if ok && (f & 1) != 0 { rdv } else { 0 };
            if !ok || ((f & 16) == 0 && ((f & 1) != 0) != (dmg > 0.0)) || !(rch >= 0 && rch < if (f & 16) != 0 { 256 } else { boxsteps }) {
                s(on, q, 0);
            } else {
                s(reach, q, rch as u8);
            }
        }
    }
    // (applyUnitEffectiveScaling: energy floored into [1, max].)
    let mx = g(maxe, q);
    let e = g(en, q);
    s(en, q, if e - e != 0.0 { mx.max(1.0) } else { floorf(e).min(mx).max(1.0) });
    true
}

// =====================================================================
// STATE HASH (utils_snapshot.js snapTickHash)
// =====================================================================

/// The hash's word mix: field c's term for word w, (c's key ^ w) * M (the
/// unit setters' digest, sim_unit_state.js _simHTerm, mixes the same way).
const SNAP_M: i32 = 16777619u32.wrapping_mul(2654435761u32) as i32;
#[inline(always)]
fn snap_key(c: i32) -> i32 {
    (c + 1).wrapping_mul(0x9e3779b9u32 as i32) ^ 0x5bd1e995
}
#[inline(always)]
fn snap_order_mix(i: i32, id: i32) -> i32 {
    let mut h = i.wrapping_add(1).wrapping_mul(2654435761u32 as i32) ^ id.wrapping_add(0x3c6ef372).wrapping_mul(2246822519u32 as i32);
    h = (h ^ ((h as u32) >> 15) as i32).wrapping_mul(3266489917u32 as i32);
    h ^ ((h as u32) >> 13) as i32
}

/// SIM_KERNEL_SNAP_REGION: one slice of the units list, its positions
/// P[3]..P[4] (a block: units listed together mostly hold slots together,
/// so their columns are read in runs), the job's run of P[1] of them, four
/// units a lane (consecutive slots: one vector load per column). Per
/// position with a slot, the list's order sum (snap.ord[job]); per live
/// unit not dead, the hash of every hashed field from its columns (the
/// object fields through their digest, unit.hObj: sim_unit_state.js), seeded
/// by its id, and its region (floor(y / P[2]) * 1024 + floor(x / P[2])):
/// listed per job from job * P[1] as (snap.pr region, snap.ph hash); a
/// region outside 0..P[9] as (snap.nl slot, snap.nlh hash); positions
/// without a slot in snap.nu. Counts in snap.cc[4 * job ..]: pairs, 0,
/// outside, without a slot.
/// Arrays: unit.live, unit.dead, unit.x, unit.y, unit.id, ix.slots,
/// unit.owner, unit.vx, unit.vy, unit.energy, unit.commandState,
/// unit.attackTimer, unit.attackFlash, unit.teleportHideTicks, unit.poisoned,
/// unit.burning, unit.frozen, unit.wet, unit.sandy, unit.watched,
/// unit.workerTransferCooldown, unit.stackCount, unit.unitLevel,
/// unit.effectiveStacks, unit.effectiveLevel, unit.pathIndex, unit.hObj,
/// snap.pr, snap.ph, snap.nl, snap.nlh, snap.nu, snap.cc, snap.ord.
/// P: [0] units, [1] per job, [2] region size in pixels, [3] first
/// position, [4] end, [9] regions.
#[no_mangle]
pub unsafe extern "C" fn k_snap_units(a: *const i32, chunk: i32) {
    let k = K::new(a);
    let (live, dead, xs, ys, uid, sl) = (k.p::<u8>(0), k.p::<u8>(1), k.p::<f32>(2), k.p::<f32>(3), k.p::<i32>(4), k.p::<i32>(5));
    let (own, vx, vy, en, cmd, at, af) = (k.p::<i8>(6), k.p::<f32>(7), k.p::<f32>(8), k.p::<f32>(9), k.p::<u8>(10), k.p::<f32>(11), k.p::<u8>(12));
    let (tp, po, bu, fr, we, sa, wa, wt) = (k.p::<i32>(13), k.p::<i32>(14), k.p::<i32>(15), k.p::<i32>(16), k.p::<i32>(17), k.p::<i32>(18), k.p::<i32>(19), k.p::<i32>(20));
    let (sc, ul, es, el, pi, ho) = (k.p::<f32>(21), k.p::<f32>(22), k.p::<f32>(23), k.p::<f32>(24), k.p::<i32>(25), k.p::<i32>(26));
    let (pr, ph, nl, nlh, nu, cc, ords) = (k.p::<i32>(27), k.p::<i32>(28), k.p::<i32>(29), k.p::<i32>(30), k.p::<i32>(31), k.p::<i32>(32), k.p::<i32>(33));
    let n = k.i(0).max(0) as usize;
    let per = k.i(1).max(0) as usize;
    let its = (1.0 / k.f(2)) as f32;
    let p0 = k.i(3).max(0) as usize;
    let p1 = (k.i(4).max(0) as usize).min(n);
    let rmax = k.i(9);
    let base = chunk.max(0) as usize * per;
    let (mut n0, mut n2, mut n3) = (0usize, 0usize, 0usize);
    let mut ord: i32 = 0;
    let mm = i32x4_splat(SNAP_M);
    let qnan = i32x4_splat(0x7fc00000);
    let mut ii = p0 + base;
    let i1 = (p0 + base + per).min(p1);
    while ii < i1 {
        // (Up to four positions: their slots, the order sum, which hash.)
        let (mut q0, mut q1, mut q2, mut q3) = (0usize, 0usize, 0usize, 0usize);
        let mut okm = 0u32;
        let mut q = 0usize;
        while q < 4 && ii < i1 {
            let at_i = ii;
            ii += 1;
            let si = g(sl, at_i);
            if si < 0 {
                s(nu, base + n3, at_i as i32);
                n3 += 1;
                continue;
            }
            let su = si as usize;
            ord = ord.wrapping_add(snap_order_mix(at_i as i32, g(uid, su)));
            if g(live, su) == 0 || g(dead, su) != 0 {
                continue;
            }
            match q {
                0 => q0 = su,
                1 => q1 = su,
                2 => q2 = su,
                _ => q3 = su,
            }
            okm |= 1 << q;
            q += 1;
        }
        if okm == 0 {
            continue;
        }
        // Four consecutive slots: vector loads; else gathered (lanes past
        // the units read slot 0, not listed).
        let run = okm == 15 && q1 == q0 + 1 && q2 == q0 + 2 && q3 == q0 + 3;
        macro_rules! g32 {
            ($p:expr) => {
                if run {
                    v128_load($p.add(q0) as *const v128)
                } else {
                    i32x4(g($p as *const i32, q0), g($p as *const i32, q1), g($p as *const i32, q2), g($p as *const i32, q3))
                }
            };
        }
        macro_rules! gu8 {
            ($p:expr) => {
                if run {
                    u32x4_extend_low_u16x8(u16x8_extend_low_u8x16(v128_load32_zero($p.add(q0) as *const u32)))
                } else {
                    i32x4(g($p, q0) as i32, g($p, q1) as i32, g($p, q2) as i32, g($p, q3) as i32)
                }
            };
        }
        macro_rules! gi8 {
            ($p:expr) => {
                if run {
                    i32x4_extend_low_i16x8(i16x8_extend_low_i8x16(v128_load32_zero($p.add(q0) as *const u32)))
                } else {
                    i32x4(g($p, q0) as i32, g($p, q1) as i32, g($p, q2) as i32, g($p, q3) as i32)
                }
            };
        }
        macro_rules! gf {
            ($p:expr) => {{
                let v = g32!($p);
                // (NaN as one word: its bits may differ.)
                v128_bitselect(qnan, v, f32x4_ne(v, v))
            }};
        }
        let mut h = g32!(ho);
        macro_rules! mix {
            ($c:expr, $v:expr) => {
                h = i32x4_add(h, i32x4_mul(v128_xor(i32x4_splat(snap_key($c)), $v), mm));
            };
        }
        mix!(0, gi8!(own));
        mix!(1, gf!(xs));
        mix!(2, gf!(ys));
        mix!(3, gf!(vx));
        mix!(4, gf!(vy));
        mix!(5, gf!(en));
        mix!(6, gu8!(cmd));
        mix!(7, gf!(at));
        mix!(8, gu8!(af));
        mix!(9, g32!(tp));
        mix!(10, g32!(po));
        mix!(11, g32!(bu));
        mix!(12, g32!(fr));
        mix!(13, g32!(we));
        mix!(14, g32!(sa));
        mix!(15, g32!(wa));
        mix!(16, g32!(wt));
        mix!(17, gf!(sc));
        mix!(18, gf!(ul));
        mix!(19, gf!(es));
        mix!(20, gf!(el));
        mix!(21, g32!(pi));
        // (Seeded by id, then finished; the regions from the positions.)
        let ids = g32!(uid);
        let mut hh = i32x4_add(v128_xor(i32x4_mul(ids, i32x4_splat(7919)), i32x4_splat(0x11)), h);
        hh = i32x4_mul(v128_xor(hh, u32x4_shr(hh, 15)), i32x4_splat(2246822519u32 as i32));
        let vits = f32x4_splat(its);
        let fy = f32x4_floor(f32x4_mul(g32!(ys), vits));
        let fx = f32x4_floor(f32x4_mul(g32!(xs), vits));
        let rr = f32x4_add(f32x4_mul(fy, f32x4_splat(1024.0)), fx);
        let inr = v128_and(
            v128_and(f32x4_ge(rr, f32x4_splat(0.0)), f32x4_lt(rr, f32x4_splat(rmax as f32))),
            v128_and(f32x4_ge(fx, f32x4_splat(0.0)), f32x4_lt(fx, f32x4_splat(1024.0))),
        );
        let ri = i32x4_trunc_sat_f32x4(rr);
        let mut l = 0u32;
        while l < 4 {
            if okm & (1 << l) != 0 {
                let (su, v, r, ok) = match l {
                    0 => (q0, i32x4_extract_lane::<0>(hh), i32x4_extract_lane::<0>(ri), i32x4_extract_lane::<0>(inr)),
                    1 => (q1, i32x4_extract_lane::<1>(hh), i32x4_extract_lane::<1>(ri), i32x4_extract_lane::<1>(inr)),
                    2 => (q2, i32x4_extract_lane::<2>(hh), i32x4_extract_lane::<2>(ri), i32x4_extract_lane::<2>(inr)),
                    _ => (q3, i32x4_extract_lane::<3>(hh), i32x4_extract_lane::<3>(ri), i32x4_extract_lane::<3>(inr)),
                };
                if ok != 0 {
                    s(pr, base + n0, r);
                    s(ph, base + n0, v);
                    n0 += 1;
                } else {
                    s(nl, base + n2, su as i32);
                    s(nlh, base + n2, v);
                    n2 += 1;
                }
            }
            l += 1;
        }
    }
    s(ords, chunk.max(0) as usize, ord);
    let cb = chunk.max(0) as usize * 4;
    s(cc, cb, n0 as i32);
    s(cc, cb + 1, 0);
    s(cc, cb + 2, n2 as i32);
    s(cc, cb + 3, n3 as i32);
}

/// SIM_KERNEL_SNAP_MERGE (one job): the units kernel's jobs' (region, hash)
/// lists summed into the tick's region sums (snap.racc, first touch by
/// snap.rstamp = P[2], listed in snap.rlist after the P[3] regions already
/// there: the structures' and others', utils_snapshot.js _snapRegionAdd),
/// then every listed region as a pair (code P[5] + region, its sum) into
/// snap.pout; snap.pres: [0] regions listed, [1] their part of the hash's
/// sum (as snapTickHash's push).
/// Arrays: snap.pr, snap.ph, snap.cc, snap.racc, snap.rstamp, snap.rlist,
/// snap.pout, snap.pres. P: [0] jobs, [1] per job, [2] stamp, [3] listed,
/// [4] regions, [5] code base.
#[no_mangle]
pub unsafe extern "C" fn k_snap_merge(a: *const i32, _chunk: i32) {
    let k = K::new(a);
    let (pr, ph, cc, acc, st, list, out, res) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7));
    let (jobs, per, now) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2));
    let mut n = k.i(3).max(0) as usize;
    let rmax = k.i(4);
    let code = k.i(5);
    for jb in 0..jobs {
        let b = jb * per;
        let c = g(cc, jb * 4).max(0) as usize;
        for i in b..b + c {
            let r = g(pr, i);
            if r < 0 || r >= rmax {
                continue;
            }
            let ru = r as usize;
            let h = g(ph, i);
            if g(st, ru) != now {
                s(st, ru, now);
                s(acc, ru, h);
                s(list, n, r);
                n += 1;
            } else {
                s(acc, ru, g(acc, ru).wrapping_add(h));
            }
        }
    }
    let mut sum: i32 = 0;
    for i in 0..n {
        let r = g(list, i);
        let h = g(acc, r as usize);
        let c = code.wrapping_add(r);
        s(out, 2 * i, c);
        s(out, 2 * i + 1, h);
        sum = sum.wrapping_add((h ^ c.wrapping_add(1).wrapping_mul(2654435761u32 as i32)).wrapping_mul(2246822519u32 as i32));
    }
    s(res, 0, n as i32);
    s(res, 1, sum);
}
