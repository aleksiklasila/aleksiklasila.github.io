//! Tile effects (unit.js tileEffectsTick): every tick, each tile with an effect
//! on hostile units standing on it, through the per-tile unit index: floor
//! traps (a status: lava fire, poison, ice, water, sand) and laser beams
//! (damage; and the structures on their tiles). The tables are kept by
//! events (traps built, levelled, gone; laser links: laser.rs); this pass is
//! O(effect tiles + the units on them).
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
// Argument slots past the structure hit kernels' (ord.rs SCtx: 14..143).
const U0: usize = 144;

/// A status record for slot q (unit.js simUnitSt): its own, else one taken
/// from the free stack or the pool's next (0: none left; counted in hdr[3]).
#[inline(always)]
unsafe fn st_take(hdr: *mut i32, free: *mut i32, stix: *mut i32, q: usize) -> usize {
    let r = g(stix, q);
    if r > 0 { return r as usize; }
    let nf = g(hdr, 0);
    let r = if nf > 0 { s(hdr, 0, nf - 1); g(free, (nf - 1) as usize) } else {
        let nx = g(hdr, 1);
        if nx >= g(hdr, 2) { s(hdr, 3, g(hdr, 3) + 1); return 0; }
        s(hdr, 1, nx + 1); nx
    };
    s(stix, q, r);
    r as usize
}

/// k_tile_effects (one job, through ord.rs SCtx::hit for structures):
/// 1. Traps (tfx.traps, P[14] tiles; kind mv.trapK 1 fire, 2 poison, 3 ice,
///    4 water, 5 sand; level mv.trapL; owner st.own): each unit the index
///    lists on the tile (ix.stamp this epoch P[13], ix.start / ix.count,
///    sep.eslot), alive, of another owner, its type not resisting the kind
///    (mv.tres by unit.upT, bit kind - 1), gets the kind's status timer and
///    tick damage raised to the trap's (mv.trapT / mv.trapTG by owner, kind,
///    level: applyStatusEffect's), a status record taken when it needs one.
/// 2. Beams (lz.border, lz.hdr[3] of them, canonical order): on each tile
///    strictly between their lasers, each unit listed there of another owner
///    not immune to towers (lzFlags 1) lights the beam (lz.hit); unless laser
///    resistant (2) it takes the beam's damage times P[10] (energy, lzAcc,
///    lzBeam; dead at none left); a report (lzEv 1, listed in lz.list) once
///    per P[12] ticks by id or as it dies. A tower, barrack or spawner there
///    (st.stab 1, 3..9) of another owner takes the damage (SCtx::hit).
///    Each beam's first laser lit when its beam hit.
/// Out: tfx.out [0] reports, [1] lit; the last tick's reports' lzEv cleared
/// first (P[18] of them). Arrays 0..13: lz.ba, lz.bb, lz.bown, lz.bdmg,
/// lz.hit, lz.border, lz.hdr, tower laserState, st.own, tfx.traps,
/// mv.trapK, mv.trapL, mv.trapT, mv.trapTG; SCtx's; from 144: ix.stamp,
/// ix.start, ix.count, sep.eslot, unit.dead, unit.owner, unit.energy,
/// unit.id, unit.lzFlags, unit.lzAcc, unit.lzBeam, unit.lzEv, lz.list,
/// unit.upT, mv.tres, unit.stIx, st.hdr, st.free, unit.stBu, unit.stBd,
/// unit.stPo, unit.stPd, unit.stFr, unit.stId, unit.stWe, unit.stSa,
/// tfx.out. P: [4] W, [10] simDk, [11] tick, [12] report period, [13] index
/// epoch, [14] traps, [15] / [16] the strength table's owners / levels, [17]
/// unit types, [18] last reports.
#[no_mangle]
pub unsafe extern "C" fn k_tile_effects(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ba, bb, bown, bdmg, hit, order, lhdr, lstate, own) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<f32>(3), k.p::<u8>(4), k.p::<i32>(5),
        k.p::<i32>(6), k.p::<i8>(7), k.p::<i32>(8));
    let (traps, trk, trl, trt, trtg) = (k.p::<i32>(9), k.p::<u8>(10), k.p::<u8>(11), k.p::<i32>(12), k.p::<f32>(13));
    let (stamp, start, count, eslot) = (k.p::<i32>(U0), k.p::<i32>(U0 + 1), k.p::<i32>(U0 + 2), k.p::<i32>(U0 + 3));
    let (dead, uown, en, uid, lzf, acc, lb, ev, list) = (k.p::<u8>(U0 + 4), k.p::<i8>(U0 + 5), k.p::<f32>(U0 + 6), k.p::<i32>(U0 + 7), k.p::<u8>(U0 + 8),
        k.p::<f32>(U0 + 9), k.p::<i32>(U0 + 10), k.p::<u8>(U0 + 11), k.p::<i32>(U0 + 12));
    // (upT is an Int16 column: sim_unit_state.js SIM_MOVE_COLUMNS.)
    let (upt, tres, stix, sthdr, stfree) = (k.p::<i16>(U0 + 13), k.p::<u8>(U0 + 14), k.p::<i32>(U0 + 15), k.p::<i32>(U0 + 16), k.p::<i32>(U0 + 17));
    let (stbu, stbd, stpo, stpd, stfr, stid, stwe, stsa, out) = (k.p::<u16>(U0 + 18), k.p::<f32>(U0 + 19), k.p::<u16>(U0 + 20), k.p::<f32>(U0 + 21),
        k.p::<u16>(U0 + 22), k.p::<f32>(U0 + 23), k.p::<u16>(U0 + 24), k.p::<u16>(U0 + 25), k.p::<i32>(U0 + 26));
    let (w, dk, tick, per, epoch) = (k.i(4).max(1) as usize, k.i(10).max(1), k.i(11), k.i(12).max(1), k.i(13));
    let (ntr, trpl, trlv, ntypes) = (k.i(14).max(0) as usize, k.i(15), k.i(16), k.i(17));
    for i in 0..k.i(18).max(0) as usize { s(ev, g(list, i) as usize, 0); }
    // The units the index lists on tile t (this epoch's).
    let occupants = |t: usize| -> (usize, usize) {
        if g(stamp, t) != epoch { return (0, 0); }
        let a = g(start, t).max(0) as usize; (a, a + g(count, t).max(0) as usize)
    };
    // 1. Traps: their status, as applyStatusEffect (the larger of the old and the trap's).
    if !trk.is_null() && !trt.is_null() {
        for i in 0..ntr {
            let t = g(traps, i) as usize;
            let kind = g(trk, t) as i32;
            if kind < 1 || kind > 5 { continue; }
            let (o, lv) = (g(own, t), g(trl, t) as i32);
            if o < 0 || o >= trpl || lv >= trlv { continue; }
            let ti = ((o * 6 + kind) * trlv + lv) as usize;
            let (d, gd) = (g(trt, ti), g(trtg, ti));
            let (tm, dm): (*mut u16, *mut f32) = match kind { 1 => (stbu, stbd), 2 => (stpo, stpd), 3 => (stfr, stid), 4 => (stwe, core::ptr::null_mut()), _ => (stsa, core::ptr::null_mut()) };
            let dv = d.min(65535).max(0) as u16;
            let (e0, e1) = occupants(t);
            for e in e0..e1 {
                let q = g(eslot, e) as usize;
                if g(dead, q) != 0 || g(uown, q) as i32 == o { continue; }
                let ut = g(upt, q) as i32;
                if ut < 0 || ut >= ntypes || (g(tres, ut as usize) >> (kind - 1)) & 1 != 0 { continue; }
                let r0 = g(stix, q) as usize;
                if !(g(tm, r0) < dv || (!dm.is_null() && g(dm, r0) < gd)) { continue; }
                let r = st_take(sthdr, stfree, stix, q);
                if r == 0 { continue; }
                if g(tm, r) < dv { s(tm, r, dv); }
                if !dm.is_null() && g(dm, r) < gd { s(dm, r, gd); }
            }
        }
    }
    // 2. Beams, in canonical order.
    let n = g(lhdr, 3).max(0) as usize;
    let mut c = super::ord::SCtx::new(&k);
    let stab = k.p::<u8>(14);
    let mut nrep = 0usize;
    for qb in 0..n {
        let b = g(order, qb) as usize;
        let (t, u) = (g(ba, b) as usize, g(bb, b) as usize);
        let step = if u - t < w { 1 } else { w };
        let o = g(bown, b);
        let bd = g(bdmg, b) * dk as f32;
        let mut x = t + step;
        while x < u {
            let (e0, e1) = occupants(x);
            for e in e0..e1 {
                let q = g(eslot, e) as usize;
                if g(dead, q) != 0 || g(uown, q) as i32 == o { continue; }
                let fl = g(lzf, q);
                if fl & 1 != 0 { continue; }
                s(hit, b, 1);
                if fl & 2 != 0 || !(bd > 0.0) { continue; }
                let ne = g(en, q) - bd;
                s(en, q, ne); s(acc, q, g(acc, q) + bd); s(lb, q, b as i32);
                let died = !(ne > 0.0);
                if died { s(dead, q, 1); }
                if g(ev, q) == 0 && (died || (tick as i64 + g(uid, q) as i64).rem_euclid(per as i64) < dk as i64) {
                    s(ev, q, 1); s(list, nrep, q as i32); nrep += 1;
                }
            }
            let cls = g(stab, x);
            if cls != 0 && cls != 2 && cls <= 9 && g(own, x) != o {
                let h = super::ord::SHit { t: x as i32, dmg: g(bdmg, b) as f64 * dk as f64, fx: 0, gate: true, dur: [0; 6], td: [0.0; 3], team: -1, look: b as i32 };
                if c.hit(&k, &h) { s(hit, b, 1); }
            }
            x += step;
        }
    }
    let rrow = k.p::<i32>(15);
    let mut lit = 0;
    for qb in 0..n { let b = g(order, qb) as usize; let r = g(rrow, g(ba, b) as usize); if r >= 0 { s(lstate, r as usize, 0); } }
    for qb in 0..n { let b = g(order, qb) as usize; if g(hit, b) != 0 { let r = g(rrow, g(ba, b) as usize); if r >= 0 { s(lstate, r as usize, 1); lit = 1; } } }
    c.done(&k);
    s(out, 0, nrep as i32); s(out, 1, lit);
}

/// SIM_KERNEL_TRAP_TILES (one job; unit.js simTrapDirty): the trap of each
/// listed tile (tfx.dirty[0..P[0]]; P[3] 1: every tile, after a reset) from
/// the per-tile structure table: a built floor item (st.code 0x55, st.uc 0)
/// whose stationary type is a trap (tfx.tkind by type: 1 fire .. 5 sand, 6
/// a mine) gets its kind (mv.trapK) and effective level (mv.trapL, the
/// descriptor's, at least 1); else none. Kinds 1-5 kept in the trap list
/// (tfx.traps; tfx.thdr[0] its length, [1] its room: past it the tile is left
/// out and thdr[2] set). (A full look starts from no kinds: P[3].)
#[no_mangle]
pub unsafe extern "C" fn k_trap_tiles(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (dirty, code, uc, brain, tkind, trk, trl, tidx, list, hdr) = (k.p::<i32>(0), k.p::<u8>(1), k.p::<u8>(2), k.p::<i32>(3), k.p::<u8>(4),
        k.p::<u8>(5), k.p::<u8>(6), k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9));
    let (nd, ntypes, n, all) = (k.i(0).max(0) as usize, k.i(1), k.i(2).max(0) as usize, k.i(3) != 0);
    let mut one = |t: usize| {
        let was = g(trk, t);
        let mut kind = 0u8;
        let mut lv = 0u8;
        if g(code, t) == 0x55 && g(uc, t) == 0 {
            let ty = (g(brain, t) & 65535) - 1;
            if ty >= 0 && ty < ntypes { kind = g(tkind, ty as usize); }
            if kind != 0 { lv = ((g(brain, t) >> 26) & 63).max(1) as u8; }
        }
        s(trk, t, kind); s(trl, t, lv);
        // (In the list while its kind is 1-5: by its kind before; a removal
        // finds its entry, a rare event, no index by tile.)
        let (on, was_on) = (kind >= 1 && kind <= 5, was >= 1 && was <= 5);
        if on && !was_on {
            let m = g(hdr, 0);
            if m < g(hdr, 1) { s(list, m as usize, t as i32); s(hdr, 0, m + 1); } else { s(hdr, 2, 1); }
        } else if !on && was_on {
            let m = g(hdr, 0);
            let mut i = 0;
            while i < m && g(list, i as usize) != t as i32 { i += 1; }
            if i < m { s(list, i as usize, g(list, (m - 1) as usize)); s(hdr, 0, m - 1); }
        }
    };
    if all { for t in 0..n { one(t); } } else { for i in 0..nd { let t = g(dirty, i); if t >= 0 && (t as usize) < n { one(t as usize); } } }
}

/// SIM_KERNEL_TRAP_BOUND (one job): how many units the index lists on the trap
/// tiles (tfx.traps, P[0] of them; this epoch's P[1]): the most that may take
/// a status record in the tile effects' pass. Out: tfx.thdr[3].
#[no_mangle]
pub unsafe extern "C" fn k_trap_bound(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (list, stamp, count, hdr) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3));
    let (n, epoch) = (k.i(0).max(0) as usize, k.i(1));
    let mut sum = 0i32;
    for i in 0..n { let t = g(list, i) as usize; if g(stamp, t) == epoch { sum += g(count, t).max(0); } }
    s(hdr, 3, sum);
}
