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
    // Beam b on tile x: the units listed there, then a structure there (in the beams' canonical order, the tiles' along
    // each beam: a unit a beam killed is not hit by the beams after it).
    let tile = |c: &mut super::ord::SCtx, b: usize, x: usize, o: i32, bd: f32, nrep: &mut usize| {
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
            if g(ev, q) == 0 && (died || (per > 0 && (tick as i64 + g(uid, q) as i64).rem_euclid(per as i64) < dk as i64)) {
                s(ev, q, 1); s(list, *nrep, q as i32); *nrep += 1;
            }
        }
        let cls = g(stab, x);
        if cls != 0 && cls != 2 && cls <= 9 && g(own, x) != o {
            let h = super::ord::SHit { t: x as i32, dmg: g(bdmg, b) as f64 * dk as f64, fx: 0, gate: true, dur: [0; 6], td: [0.0; 3], team: -1, look: b as i32 };
            if c.hit(&k, &h) { s(hit, b, 1); }
        }
    };
    // Beams qb0..qb1 of the order, every tile.
    let scan = |c: &mut super::ord::SCtx, qb0: usize, qb1: usize, nrep: &mut usize| {
        for qb in qb0..qb1 {
            let b = g(order, qb) as usize;
            let (t, u) = (g(ba, b) as usize, g(bb, b) as usize);
            let step = if u - t < w { 1 } else { w };
            let (o, bd) = (g(bown, b), g(bdmg, b) * dk as f32);
            let mut x = t + step;
            while x < u { tile(c, b, x, o, bd, nrep); x += step; }
        }
    };
    // (Scanned on the helpers first, k_beam_scan (P[19] jobs of P[20] beams, P[21] entries a job): only the tiles with
    // something there, in order, each job's list then the rest of its beams when its list ran out (U0 + 27 the lists,
    // U0 + 28 per job [entries, the order index it stopped at]); without it every tile here: the same hits, in order.)
    let (evl, evc, jobs, pj, cap) = (k.p::<i32>(U0 + 27), k.p::<i32>(U0 + 28), k.i(19).max(0) as usize, k.i(20).max(1) as usize, k.i(21).max(0) as usize);
    if jobs > 0 && !evl.is_null() && !evc.is_null() {
        for j in 0..jobs {
            let (q0, q1) = (j * pj, ((j + 1) * pj).min(n));
            if q0 >= q1 { continue; }
            let (m, stop) = (g(evc, 2 * j).max(0) as usize, (g(evc, 2 * j + 1).max(q0 as i32) as usize).min(q1));
            for i in 0..m {
                let v = g(evl, j * cap + i) as u32;
                let (qb, k2) = ((v >> 5) as usize, (v & 31) as usize);
                let b = g(order, qb) as usize;
                let (t, u) = (g(ba, b) as usize, g(bb, b) as usize);
                let step = if u - t < w { 1 } else { w };
                tile(&mut c, b, t + step * (k2 + 1), g(bown, b), g(bdmg, b) * dk as f32, &mut nrep);
            }
            if stop < q1 { scan(&mut c, stop, q1, &mut nrep); }
        }
    } else {
        scan(&mut c, 0, n, &mut nrep);
    }
    let rrow = k.p::<i32>(15);
    let mut lit = 0;
    for qb in 0..n { let b = g(order, qb) as usize; let r = g(rrow, g(ba, b) as usize); if r >= 0 { s(lstate, r as usize, 0); } }
    for qb in 0..n { let b = g(order, qb) as usize; if g(hit, b) != 0 { let r = g(rrow, g(ba, b) as usize); if r >= 0 { s(lstate, r as usize, 1); lit = 1; } } }
    c.done(&k);
    s(out, 0, nrep as i32); s(out, 1, lit);
}

/// SIM_BLOCK_BEAM_SCAN (k_block 13, a job of P[1] beams of the canonical order, P[0] beams): each beam's tiles strictly
/// between its lasers with anything a beam acts on (a unit the index lists there this epoch P[3], or a tower,
/// barrack or spawner (st.stab 1, 3..9) of another owner), in order, as (order index << 5 | the tile's place along
/// it) into the job's list (P[4] entries a job from job * P[4]); per job [entries, the order index it stopped at: its
/// list full there, the rest k_tile_effects' own]. A beam past 31 tiles stops its job there too (the rest scanned
/// by k_tile_effects). Arrays: lz.border, lz.ba, lz.bb, lz.bown, ix.stamp, ix.count, st.stab, st.own, the lists, the
/// per-job counts. P: [2] W.
pub unsafe fn k_beam_scan(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (order, ba, bb, bown, stamp, count, stab, own, evl, evc) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4),
        k.p::<i32>(5), k.p::<u8>(6), k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9));
    let (n, per, w, epoch, cap) = (k.i(0).max(0) as usize, k.i(1).max(1) as usize, k.i(2).max(1) as usize, k.i(3), k.i(4).max(0) as usize);
    let j = chunk.max(0) as usize;
    let (q0, q1) = (j * per, ((j + 1) * per).min(n));
    let base = j * cap;
    let mut m = 0usize;
    let mut stop = q1;
    let mut row = [0u32; 32];
    let rp = row.as_mut_ptr();
    for qb in q0..q1 {
        let b = g(order, qb) as usize;
        let (t, u) = (g(ba, b) as usize, g(bb, b) as usize);
        let step = if u - t < w { 1 } else { w };
        let o = g(bown, b);
        let mut x = t + step;
        let (mut i, mut nr, mut long) = (0u32, 0usize, false);
        while x < u {
            if i >= 31 { long = true; break; }
            let units = g(stamp, x) == epoch && g(count, x) > 0;
            let cls = g(stab, x);
            if units || (cls != 0 && cls != 2 && cls <= 9 && g(own, x) != o) { s(rp, nr, ((qb as u32) << 5) | i); nr += 1; }
            x += step; i += 1;
        }
        // (A beam's entries together: one that does not fit, or a beam too long to list, stops the job's list at it.)
        if long || m + nr > cap { stop = qb; break; }
        for r in 0..nr { s(evl, base + m + r, g(rp, r) as i32); }
        m += nr;
    }
    s(evc, 2 * j, m as i32); s(evc, 2 * j + 1, stop as i32);
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

/// k_mine_events (unit.js unitEventsRun, after the events' split; one job on the simulation thread): the floor
/// events of the tick's sorted list (ev.sorted [0], P[0] of them; code P[1]) in their order, as Unit's floor look
/// (unit.js _unitFloorEvent was): the unit's floor tile noted (its steering record's floor word, [19] mv.steer, P[13]
/// words a slot, the floor word P[14]); a built mine there ([10] mv.trapK 6) whose cell is not the unit's owner's
/// ([14] cell.owner) goes off (as Unit._explodeMine did): every unit of another owner than the mine's ([12] st.own; none: every
/// unit), alive, within the mine's blast radius of the unit (the units where they stood at the pass's start: unit.x0 /
/// y0; the unit index's chunks, [15..18] sep.rstamp / rs / rc / eslot, epoch P[8]) loses its blast damage (by the
/// mine's owner and level, [11] mv.trapL: [20] mine.tab, f64 pairs damage / radius px, owners P[9] + 1 (the last: no
/// owner), levels P[10]): energy as Float32, what it lost (no more than it had) into its owner's shrine sum ([23],
/// fixed point P[11]), fallen at none left; the unit itself fallen at none; the mine's tile off the trap table (its
/// destroy is the caller's) and its event dropped from the list (-1: the worker kernel and the JavaScript pass it
/// over). Outputs: [21] the mines (tile, x, y as f32 bits, owner; P[15] room), [24] counts (mines, hits); each hit a
/// look appended to the hits' looks (unit.js _lk: [22] kind 1 (alert and flash, no attack's), [25] the unit's id
/// ([31] unit.id), [26] / [27] where (eighths), [28] what it lost, [29] the mine's owner; [30] hdr[0] their count, P[16]
/// their room): presentation only.
/// Arrays: [0] ev.sorted, [2] unit.x, [3] unit.y, [4] unit.x0, [5] unit.y0, [6] unit.owner, [7] unit.dead, [8] unit.live,
/// [9] unit.energy, [10] mv.trapK, [11] mv.trapL, [12] st.own, [13] st.uc, [14] cell.owner, [15..18] the index,
/// [19] mv.steer, [20] mine.tab, [21] the mines, [22] / [25..30] the looks, [23] shrine sums (f64 a player), [24] counts,
/// [31] unit.id.
/// P: [0] events, [1] the floor code, [2] TILE, [3] / [4] grid, [5] chunk tiles, [6] / [7] chunks across / down,
/// [8] index epoch, [9] owners in the table (the index's players: a mine of another owner hits none, of none every unit), [10] levels, [11] fixed-point scale, [12] ST_OWNER_NONE, [13] steering
/// words a slot, [14] its floor word, [15] the mines' room, [16] the looks' room, [17] shrine owners.
#[no_mangle]
pub unsafe extern "C" fn k_mine_events(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let ev = k.p::<i32>(0);
    let (xs, ys, x0s, y0s, own, dead, live, en) = (k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i8>(6), k.p::<u8>(7), k.p::<u8>(8), k.p::<f32>(9));
    let (trk, trl, stown, stuc, cown) = (k.p::<u8>(10), k.p::<u8>(11), k.p::<i32>(12), k.p::<u8>(13), k.p::<i8>(14));
    let (stamp, rs, rc, eslot) = (k.p::<i32>(15), k.p::<i32>(16), k.p::<i32>(17), k.p::<i32>(18));
    let (steer, tab, om, shr, cnt) = (k.p::<i32>(19), k.p::<f64>(20), k.p::<i32>(21), k.p::<f64>(23), k.p::<i32>(24));
    let (lkind, ltid, ltx, lty, ldmg, lown, lhdr, uid) = (k.p::<u8>(22), k.p::<i32>(25), k.p::<i32>(26), k.p::<i32>(27), k.p::<f32>(28), k.p::<i8>(29), k.p::<i32>(30), k.p::<i32>(31));
    s(cnt, 0, 0); s(cnt, 1, 0);
    if ev.is_null() || xs.is_null() || cnt.is_null() { return; }
    let (n, floor_code, tile) = (k.i(0).max(0) as usize, k.i(1), k.f(2));
    let (gw, gh, csz, cw, ch, epoch) = (k.i(3), k.i(4), k.i(5).max(1), k.i(6), k.i(7), k.i(8));
    let (nown, nlv, scale, none, sw, sfl) = (k.i(9).max(0), k.i(10).max(1), k.f(11), k.i(12), k.i(13).max(1) as usize, k.i(14).max(0) as usize);
    let (mroom, lroom, nshr) = (k.i(15).max(0) as usize, k.i(16).max(0) as usize, k.i(17).max(0));
    let (mut nm, mut nh) = (0usize, 0usize);
    let cws = csz as f64 * tile;
    for i in 0..n {
        let e = g(ev, i);
        if e < 0 || (e & 7) != floor_code { continue; }
        let q = (e >> 3) as usize;
        if g(live, q) == 0 || g(dead, q) != 0 { continue; }
        let (wx, wy) = (g(xs, q) as f64 * 0.125, g(ys, q) as f64 * 0.125);
        let (gx, gy) = (floor(wx / tile) as i32, floor(wy / tile) as i32);
        if !(gx >= 0 && gx < gw && gy >= 0 && gy < gh) { continue; }
        let t = (gy * gw + gx) as usize;
        if !steer.is_null() { s(steer, q * sw + sfl, t as i32); }
        let uo = g(own, q) as i32;
        if trk.is_null() || g(trk, t) != 6 || (!stuc.is_null() && g(stuc, t) != 0) || (!cown.is_null() && g(cown, t) as i32 == uo) { continue; }
        // It goes off.
        let mo = if stown.is_null() { none } else { g(stown, t) };
        // (forEachUnitInRange's enemyOfPlayer: no owner, every unit; one outside the index's players, none.)
        let hits = mo == none || (mo >= 0 && mo < nown);
        let row = if mo >= 0 && mo < nown && mo != none { mo } else { nown };
        let lv = (if trl.is_null() { 1 } else { g(trl, t) as i32 }).max(1).min(nlv - 1);
        let ti = ((row * nlv + lv) * 2) as usize;
        let (bd, r) = (g(tab, ti), g(tab, ti + 1).max(0.0));
        let enemy = row < nown;
        let r2 = r * r;
        let scan = r + tile;
        let cx0 = (floor((wx - scan) / cws) as i32).max(0); let cx1 = (floor((wx + scan) / cws) as i32).min(cw - 1);
        let cy0 = (floor((wy - scan) / cws) as i32).max(0); let cy1 = (floor((wy + scan) / cws) as i32).min(ch - 1);
        let mut cy = if hits { cy0 } else { cy1 + 1 };
        while cy <= cy1 {
            let mut cx = cx0;
            while cx <= cx1 {
                let ck = (cy * cw + cx) as usize;
                cx += 1;
                if g(stamp, ck) != epoch { continue; }
                let (mnx, mny) = ((cx - 1) as f64 * cws, cy as f64 * cws);
                let nx = if wx < mnx { mnx } else if wx > mnx + cws { mnx + cws } else { wx };
                let ny = if wy < mny { mny } else if wy > mny + cws { mny + cws } else { wy };
                let (ddx, ddy) = (wx - nx, wy - ny);
                if ddx * ddx + ddy * ddy > r2 { continue; }
                let k0 = g(rs, ck);
                for kk in k0..k0 + g(rc, ck) {
                    let s2 = g(eslot, kk as usize);
                    if s2 < 0 { continue; }
                    let s2 = s2 as usize;
                    if g(live, s2) == 0 || g(dead, s2) != 0 { continue; }
                    let o2 = g(own, s2) as i32;
                    if enemy && o2 == mo { continue; }
                    let (dx, dy) = (g(x0s, s2) as f64 * 0.125 - wx, g(y0s, s2) as f64 * 0.125 - wy);
                    if dx * dx + dy * dy > r2 { continue; }
                    let e0 = g(en, s2) as f64;
                    let e1 = (e0 - bd) as f32;
                    s(en, s2, e1);
                    let lost = e0 - e1 as f64;
                    nh += 1;
                    if !lhdr.is_null() && !lkind.is_null() {
                        let li = g(lhdr, 0).max(0) as usize;
                        if li < lroom { s(lkind, li, 1); s(ltid, li, g(uid, s2)); s(ltx, li, g(x0s, s2)); s(lty, li, g(y0s, s2)); s(ldmg, li, lost as f32); s(lown, li, mo as i8); s(lhdr, 0, li as i32 + 1); }
                    }
                    // (shrineDamageTaken: the energy after, the amount past it not.)
                    if lost > 0.0 && o2 >= 0 && o2 < nshr && !shr.is_null() {
                        let after = e1 as f64;
                        let l = if after < 0.0 { lost + after } else { lost };
                        if l > 0.0 { *shr.add(o2 as usize) += floor(l * scale + 0.5); }
                    }
                    if e1 <= 0.0 { s(dead, s2, 1); }
                }
            }
            cy += 1;
        }
        if g(en, q) <= 0.0 { s(dead, q, 1); }
        s(trk, t, 0);
        if nm < mroom && !om.is_null() { s(om, 4 * nm, t as i32); s(om, 4 * nm + 1, (wx as f32).to_bits() as i32); s(om, 4 * nm + 2, (wy as f32).to_bits() as i32); s(om, 4 * nm + 3, mo); nm += 1; }
        s(ev, i, -1);
    }
    s(cnt, 0, nm as i32); s(cnt, 1, nh as i32);
}
