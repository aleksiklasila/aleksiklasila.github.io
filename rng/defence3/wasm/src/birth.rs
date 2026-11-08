//! Batch births and q / e (main.js _resizeRun, UNIT_BIRTH_WASM_PLAN.md):
//! the selection grouped by parallel passes, the new units placed by block
//! jobs, their slots, handles and ids taken in one serial pass, their rows
//! written by the spawn batch's kernels (nfs.rs k_slot_zero, k_spawn_write).
//! Every pass is a flat loop over arrays; no pass depends on how the chunks
//! were shared out.
use super::*;
use super::k::K;
use super::k::stack_level;

#[inline(always)]
unsafe fn g<T: Copy>(p: *const T, i: usize) -> T { *p.add(i) }
#[inline(always)]
unsafe fn s<T>(p: *mut T, i: usize, v: T) { *p.add(i) = v; }

/// q / e, look (SIM_KERNEL_RZ_LOOK, chunks of P[1] ids): each id [0] (in
/// ascending order; a repeat of the one before is skipped; one out of order
/// sets the chunk's flag [13]) to its slot by the id table [1] (mask P[2];
/// unit.id [2], live [3]): the player's (P[3], unit.owner [4]) live, not
/// dead [5], not king (unit.upT [6] != P[4]) units, else -1, into slot [7];
/// its group key (type unit.esType [8], base level unit.baseLevel [9] when
/// P[5]) into key [10]; per chunk per key (P[6] keys) its count [11] and
/// its stacks and energy (unit.stackCount [14], energy [15]) summed [12]
/// (two f64 a key).
#[no_mangle]
pub unsafe extern "C" fn k_rz_look(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ids, tab, idc, live, own, dead, upt, slot) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<u8>(3), k.p::<i8>(4), k.p::<u8>(5), k.p::<i16>(6), k.p::<i32>(7));
    let (typ, blv, key, hist, sums, flag, stk, en) = (k.p::<i8>(8), k.p::<i8>(9), k.p::<i32>(10), k.p::<i32>(11), k.p::<f64>(12), k.p::<i32>(13), k.p::<f32>(14), k.p::<f32>(15));
    let (n, per, mask, player, king, by_level, km) = (k.i(0), k.i(1), k.i(2) as u32, k.i(3), k.i(4), k.i(5) != 0, k.i(6).max(1) as usize);
    // (An order [16]: the ids sorted by it, a radix sort's, when they came out of order.)
    let ord = k.p::<i32>(16);
    // (The snapshot the lane works from: position and footprint of each listed unit.)
    let (ex, ey, emeta, rec, jfly, ux, uy) = (k.p::<i32>(17), k.p::<i32>(18), k.p::<i32>(19), k.p::<i32>(20), k.p::<u8>(21), k.p::<i32>(22), k.p::<i32>(23));
    let idat = |j: usize| -> i32 { if ord.is_null() { g(ids, j) } else { g(ids, g(ord, j) as usize) } };
    let (j0, j1) = super::k::job_range(chunk, per, n);
    let c = chunk.max(0) as usize;
    let (h, sm) = (hist.add(c * km), sums.add(c * km * 2));
    for i in 0..km { s(h, i, 0); s(sm, 2 * i, 0.0); s(sm, 2 * i + 1, 0.0); }
    let mut bad = 0;
    for j in j0..j1 {
        let id = idat(j);
        let mut q = -1i32;
        let prev = if j > 0 { idat(j - 1) } else { i32::MIN };
        if id < prev { bad = 1; }
        if id != prev {
            let mut hh = (id as u32).wrapping_mul(2654435761u32) & mask;
            loop {
                let sl = g(tab, hh as usize);
                if sl < 0 { break; }
                if g(idc, sl as usize) == id && g(live, sl as usize) != 0 { q = sl; break; }
                hh = (hh + 1) & mask;
            }
        }
        if q >= 0 {
            let u = q as usize;
            if g(own, u) as i32 != player || g(dead, u) != 0 || g(upt, u) as i32 == king { q = -1; }
        }
        s(slot, j, q);
        if q < 0 { s(key, j, -1); continue; }
        let u = q as usize;
        let t = (g(typ, u) as i32).max(0);
        let kk = if by_level { t * 64 + (g(blv, u) as i32).clamp(1, 63) } else { t * 64 };
        let kk = (kk as usize).min(km - 1);
        s(key, j, kk as i32);
        if !ex.is_null() { s(ex, j, g(ux, u)); s(ey, j, g(uy, u)); s(emeta, j, (g(rec, u * 4 + 2) & 0xffff) | (((!jfly.is_null() && g(jfly, u) != 0) as i32) << 16)); }
        s(h, kk, g(h, kk) + 1);
        let sc = g(stk, u);
        s(sm, 2 * kk, g(sm, 2 * kk) + if sc >= 1.0 && sc < f32::INFINITY { floor(sc as f64) } else { 1.0 });
        let ev = g(en, u);
        if ev > 0.0 { s(sm, 2 * kk + 1, g(sm, 2 * kk + 1) + ev as f64); }
    }
    s(flag, c, bad);
}

/// q / e, plan (one job): the groups in key order from the chunks' counts
/// and sums ([0] hist, [1] sums; P[1] chunks, P[2] keys): per group [2] (6
/// words: start, units kept, spawns, key, stacks f32 bits, energy f32
/// bits; as k.rs k_unit_resize's), its spawns' first template index [3]
/// (per group), key -> group [4]; the counts become each chunk's cursor
/// for its key; [5]: [0] groups, [1] spawns, [2] units. d2 (P[3]): half
/// kept (a single one stays); x2: spawns up to the stacks, double the
/// units and the population room (P[4]).
#[no_mangle]
pub unsafe extern "C" fn k_rz_plan(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (hist, sums, grp, gsp, kg, cnt) = (k.p::<i32>(0), k.p::<f64>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5));
    let (nch, km, half, mut room) = (k.i(1).max(0) as usize, k.i(2).max(1) as usize, k.i(3) != 0, k.i(4).max(0) as i64);
    let (mut ng, mut at, mut ns) = (0usize, 0i32, 0i32);
    for key in 0..km {
        let (mut m, mut st, mut ensum) = (0i32, 0f64, 0f64);
        for c in 0..nch { m += g(hist, c * km + key); }
        if m == 0 { s(kg, key, -1); continue; }
        for c in 0..nch { st += g(sums, (c * km + key) * 2); ensum += g(sums, (c * km + key) * 2 + 1); }
        // (Each chunk's cursor: the group's start and the chunks before.)
        let mut cur = at;
        for c in 0..nch { let v = g(hist, c * km + key); s(hist, c * km + key, cur); cur += v; }
        let (keep, spawn) = if half { if m < 2 { (m, 0) } else { (m / 2, 0) } } else {
            let tgt = (st as i64).min(2 * m as i64).min(m as i64 + room).max(m as i64);
            let sp = (tgt - m as i64) as i32; room -= sp as i64; (m, sp)
        };
        let b = ng * 6;
        s(grp, b, at); s(grp, b + 1, keep); s(grp, b + 2, spawn); s(grp, b + 3, key as i32);
        s(grp, b + 4, (st as f32).to_bits() as i32); s(grp, b + 5, (ensum as f32).to_bits() as i32);
        s(gsp, ng, ns); s(kg, key, ng as i32);
        ng += 1; at += m; ns += spawn;
    }
    s(cnt, 0, ng as i32); s(cnt, 1, ns); s(cnt, 2, at);
}

/// q / e, scatter (chunks as look): each listed unit to its place in its
/// group (list [0]: by group, by id inside one), through its chunk's cursor
/// (hist [1]); x2: the group's first spawns units are its templates (spw
/// [2] from the group's gsp [3]); d2: those past the kept ones killed
/// (energy [8] 0, dead [9] 1). From look: slot [4], key [5]; key -> group
/// [6], groups [7]. P: [0] n, [1] per, [2] keys, [3] d2.
#[no_mangle]
pub unsafe extern "C" fn k_rz_scatter(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (list, hist, spw, gsp, slot, key, kg, grp, en, dead, tg, iswk) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7), k.p::<f32>(8), k.p::<u8>(9), k.p::<i32>(10), k.p::<u8>(11));
    let (n, per, km, half) = (k.i(0), k.i(1), k.i(2).max(1) as usize, k.i(3) != 0);
    let staged = k.i(4) != 0;
    let (tx, ty, tmeta, ex, ey, emeta) = (k.p::<i32>(12), k.p::<i32>(13), k.p::<i32>(14), k.p::<i32>(15), k.p::<i32>(16), k.p::<i32>(17));
    let (upt, ur, ucr, tup, tr, tcr) = (k.p::<i16>(18), k.p::<f32>(19), k.p::<f32>(20), k.p::<i32>(21), k.p::<f32>(22), k.p::<f32>(23));
    // (The template's type columns into tcp [26] (64 bytes a template): Z table [24] entries cp [25] (pairs: entry, byte offset), P[5].)
    let (ztab, cp, tcp, ncp) = (k.p::<i32>(24), k.p::<i32>(25), k.p::<u8>(26), k.i(5).max(0) as usize);
    let (j0, j1) = super::k::job_range(chunk, per, n);
    let h = hist.add(chunk.max(0) as usize * km);
    for j in j0..j1 {
        let kk = g(key, j);
        if kk < 0 { continue; }
        let kk = kk as usize;
        let at = g(h, kk); s(h, kk, at + 1);
        let q = g(slot, j);
        s(list, at as usize, q);
        let gi = g(kg, kk) as usize;
        let rank = at - g(grp, gi * 6);
        if half {
            if !staged && rank >= g(grp, gi * 6 + 1) { s(en, q as usize, 0.0); s(dead, q as usize, 1); }
        } else if rank < g(grp, gi * 6 + 2) {
            // (A worker: no new one yet, its record and task fields are not
            // made by the birth kernels, UNIT_BIRTH_WASM_PLAN.md.)
            let wk = !iswk.is_null() && g(iswk, q as usize) != 0;
            let ti = (g(gsp, gi) + rank) as usize;
            s(spw, ti, if wk { -1 } else { q }); s(tg, ti, gi as i32);
            if !tx.is_null() {
                let u = q as usize;
                s(tx, ti, g(ex, j)); s(ty, ti, g(ey, j)); s(tmeta, ti, g(emeta, j));
                s(tup, ti, g(upt, u) as i32); s(tr, ti, g(ur, u)); s(tcr, ti, g(ucr, u));
                for c in 0..ncp {
                    let (e, off) = (g(cp, 2 * c) as usize, g(cp, 2 * c + 1) as usize);
                    let base = waddr(g(ztab, 3 * e) as u32) as *mut u8;
                    let m = g(ztab, 3 * e + 1) as usize * g(ztab, 3 * e + 2) as usize;
                    core::ptr::copy_nonoverlapping(base.add(u * m), tcp.add(ti * 64 + off), m);
                }
            }
        }
    }
}

// ---- placement: block jobs ----
// A block is 64 x 64 occupancy cells (8 x 8 tiles at 8 cells a tile), its
// left edge on a word: a footprint placed by a block's job lies inside the
// block, so jobs of different blocks touch different bits (a 64-bit read
// may cover the next block's first word: its bits are masked out). Round 1
// blocks start at 0, round 2 (what did not fit) at 32 cells.
const BC: i32 = 64;

/// Placement, bucket (SIM_KERNEL_RZ_BHIST, chunks of P[1] templates): each
/// template still to place (pos [2] x = -1 at round 2; P[6] the round) its
/// block (by its slot's x [3], y [4]: cells, P[3] cell shift, P[7] the
/// rounds' offset in cells) into tb [0], counted per chunk [1] (P[5]
/// blocks: P[4] wide); spw [5].
#[no_mangle]
pub unsafe extern "C" fn k_rz_bhist(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (tb, hist, pos, ux, uy, spw) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5));
    let (n, per, csh, bw, nb, round, off) = (k.i(0), k.i(1), k.i(2), k.i(4).max(1), k.i(5).max(1) as usize, k.i(6), k.i(7));
    let (j0, j1) = super::k::job_range(chunk, per, n);
    let h = hist.add(chunk.max(0) as usize * nb);
    for i in 0..nb { s(h, i, 0); }
    for j in j0..j1 {
        let q = g(spw, j);
        if q < 0 || (round > 0 && g(pos, 2 * j) >= 0) { s(tb, j, -1); continue; }
        let cx = (g(ux, j) >> csh) + off; let cy = (g(uy, j) >> csh) + off;
        let b = (cy.max(0) >> 6) * bw + (cx.max(0) >> 6);
        let b = (b.max(0) as usize).min(nb - 1);
        s(tb, j, b as i32); s(h, b, g(h, b) + 1);
    }
}
/// Placement, plan (one job): per block its templates' start (cursors per
/// chunk in hist [0], P[1] chunks, P[2] blocks) and the blocks with any
/// into jobs [1] (block, start, end), their count into cnt [2][0].
#[no_mangle]
pub unsafe extern "C" fn k_rz_bplan(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (hist, jobs, cnt) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2));
    let (nch, nb) = (k.i(1).max(0) as usize, k.i(2).max(1) as usize);
    let (mut at, mut nj) = (0i32, 0usize);
    for b in 0..nb {
        let start = at;
        for c in 0..nch { let v = g(hist, c * nb + b); s(hist, c * nb + b, at); at += v; }
        if at > start { s(jobs, nj * 3, b as i32); s(jobs, nj * 3 + 1, start); s(jobs, nj * 3 + 2, at); nj += 1; }
    }
    s(cnt, k.i(3).max(0) as usize, nj as i32);
}
/// Placement, scatter (chunks as bhist): template indices by block into
/// tord [2] (stable: in template order inside a block). tb [0], hist [1].
#[no_mangle]
pub unsafe extern "C" fn k_rz_bscatter(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (tb, hist, tord) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2));
    let (n, per, nb) = (k.i(0), k.i(1), k.i(5).max(1) as usize);
    let (j0, j1) = super::k::job_range(chunk, per, n);
    let h = hist.add(chunk.max(0) as usize * nb);
    for j in j0..j1 {
        let b = g(tb, j);
        if b < 0 { continue; }
        let at = g(h, b as usize); s(h, b as usize, at + 1);
        s(tord, at as usize, j as i32);
    }
}

/// Placement (SIM_KERNEL_RZ_PLACE, one job a block of jobs [0]): the
/// block's templates (tord [1], template indices in order; their groups by
/// tg [2]; their footprint the first template's: occ.rec [3], unit.jFly [11]) by runs of
/// one group. Per run, the block's fit map: a bit per cell where the
/// footprint (the shape table's disk, mask [7]) lies inside the block on
/// free occupancy cells (bits [6]) and, a ground group, its centre not on a
/// wall tile (mv.wall [5]): each row's free cells eroded by every half
/// width (shift and AND, 64 cells a word), the rows ANDed over the disk.
/// A block with no fitting cell costs that much. Otherwise a search outward
/// from all of the run's templates at once (cells, not past P[8] from the
/// nearest, not through walls) takes the nearest fitting cells in turn:
/// each footprint marked in the bits, the fit map made again around it.
/// Places (x, y: eighths of a pixel) into pos [8] at the run's templates in
/// order, the rest left -1. Templates' slots spw [4], unit x [9], y [10].
/// P: [1] occupancy w, [2] h, [3] stride, [4] cell, [5] planes, [6]
/// GRID_W, [7] cells a tile, [8] search, [9] blocks wide, [10] the round's
/// offset in cells.
/// (A chunk: RZ_PLACE_GROUP block jobs in a row (a chunk a block was ~17k claims a round, most empty).)
pub const RZ_PLACE_GROUP: i32 = 64;
#[no_mangle]
pub unsafe extern "C" fn k_rz_place(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let bcnt = k.p::<i32>(12);
    let n = if bcnt.is_null() { i32::MAX } else { g(bcnt, k.i(11).max(0) as usize).max(0) };
    let j0 = chunk.max(0) * RZ_PLACE_GROUP;
    let mut j = j0;
    while j < j0 + RZ_PLACE_GROUP && j < n { rz_place_job(a, j); j += 1; }
}
unsafe fn rz_place_job(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (jobs, tord, tg, rec, spw, wall, bits, mask, pos, ux, uy, jfly) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<u8>(5), k.p::<u32>(6), k.p::<i8>(7), k.p::<i32>(8), k.p::<i32>(9), k.p::<i32>(10), k.p::<u8>(11));
    let (w, h, stride, cell, planes, gw, ctile, search, bw, off) = (k.i(1), k.i(2), k.i(3), k.i(4).max(1), k.i(5).max(1), k.i(6), k.i(7).max(1), k.i(8).max(0), k.i(9).max(1), k.i(10));
    let j = chunk.max(0) as usize;
    // (Chunks past the round's blocks: none. The templates' footprints: tmeta [3] (rec here).)
    let bcnt = k.p::<i32>(12);
    if !bcnt.is_null() && j >= g(bcnt, k.i(11).max(0) as usize).max(0) as usize { return; }
    let _ = jfly;
    let (blk, t0, t1) = (g(jobs, 3 * j), g(jobs, 3 * j + 1) as usize, g(jobs, 3 * j + 2) as usize);
    let (csh, tsh) = (cell.trailing_zeros(), ctile.trailing_zeros());
    let gd = super::occ::grid(bits, mask, w, h, stride, cell, planes);
    let plane = stride * h;
    // (The block's cells: [bx0, bx0 + 64) x [by0, by0 + 64).)
    let bx0 = irem(blk, bw) * BC - off; let by0 = idiv(blk, bw) * BC - off;
    // (A row's free cells: bit i = cell bx0 + i; outside the map none.)
    let row_free = |y: i32, layer: i32| -> u64 {
        let cy = by0 + y;
        if cy < 0 || cy >= h { return 0; }
        let base = bits.add((layer * plane + cy * stride) as usize);
        let wd = |c: i32| -> u64 { if c < 0 || c >= w { 0 } else { (!*base.add((c >> 5) as usize)) as u64 } };
        let mut f = wd(bx0) | (wd(bx0 + 32) << 32);
        // (Cells past the map's edge: not free.)
        if bx0 + 64 > w { let keep = (w - bx0).max(0); f &= if keep >= 64 { u64::MAX } else { (1u64 << keep) - 1 }; }
        f
    };
    // (A row's wall tiles as cells: bit i set when cell bx0 + i's tile is a wall.)
    let row_wall = |y: i32| -> u64 {
        let cy = by0 + y;
        if wall.is_null() || cy < 0 || cy >= h { return 0; }
        let (ty, mut m) = (cy >> tsh, 0u64);
        let span = 1i32 << tsh;
        let mut x = 0;
        while x < 64 {
            let cx = bx0 + x;
            let step = span - (cx & (span - 1));
            if cx >= 0 && cx < w && g(wall, (ty * gw + (cx >> tsh)) as usize) != 0 {
                let n = step.min(64 - x);
                m |= (if n >= 64 { u64::MAX } else { (1u64 << n) - 1 }) << x;
            }
            x += step;
        }
        m
    };
    let mut f = [0u64; 64];
    let mut wl = [0u64; 64];
    let mut e = [[0u64; 64]; 33];
    let mut fit = [0u64; 64];
    let mut i = t0;
    while i < t1 {
        let gi = g(tg, g(tord, i) as usize);
        let mut en = i;
        while en < t1 && g(tg, g(tord, en) as usize) == gi { en += 1; }
        let meta = g(rec, g(tord, i) as usize);
        let r = (meta & 255).max(1).min(32); let layer = ((meta >> 8) & 255).min(planes - 1); let ground = (meta >> 16) & 1 == 0;
        let need = en - i;
        // The disk's half widths (shape table: -1 none in that row).
        let hw = |dy: i32| -> i32 { if dy < -32 || dy > 32 { -1 } else { *mask.add((r * 65 + dy + 32) as usize) as i32 } };
        // Rows y0..=y1 of f and e made again from the bits.
        let mut erode = |f: &mut [u64; 64], e: &mut [[u64; 64]; 33], y0: i32, y1: i32| {
            for y in y0.max(0)..=y1.min(63) {
                let v = row_free(y, layer);
                *f.get_unchecked_mut(y as usize) = v;
                let mut c = v;
                *e.get_unchecked_mut(0).get_unchecked_mut(y as usize) = c;
                for hh in 1..=r as usize { c &= (c << 1) & (c >> 1); *e.get_unchecked_mut(hh).get_unchecked_mut(y as usize) = c; }
            }
        };
        // Fit rows y0..=y1 from e (the disk inside the block: rows past it none), walls out; returns their bits.
        let refit = |e: &[[u64; 64]; 33], fit: &mut [u64; 64], wl: &[u64; 64], y0: i32, y1: i32| -> i32 {
            let mut n = 0;
            for y in y0.max(0)..=y1.min(63) {
                let mut m = u64::MAX;
                for dy in -r..=r {
                    let hh = hw(dy);
                    if hh < 0 { continue; }
                    let yy = y + dy;
                    if yy < 0 || yy > 63 { m = 0; break; }
                    m &= *e.get_unchecked(hh as usize).get_unchecked(yy as usize);
                    if m == 0 { break; }
                }
                if ground { m &= !*wl.get_unchecked(y as usize); }
                *fit.get_unchecked_mut(y as usize) = m;
                n += m.count_ones() as i32;
            }
            n
        };
        // (Two footprints overlap exactly when, on a row both cover (rows a
        // and b of theirs, a - b = D, the centres' vertical offset), the
        // centres are at most hw(a) + hw(b) apart: per D the widest, -1
        // none. A placed one's centre clears those spans of the fit map.)
        let mut ex = [-1i32; 128];
        for a in 1 - r..r { let ha = hw(a); if ha < 0 { continue; } for b in 1 - r..r { let hb = hw(b); if hb < 0 { continue; } let d = (a - b + 63) as usize; if ha + hb > *ex.get_unchecked(d) { *ex.get_unchecked_mut(d) = ha + hb; } } }
        for y in 0..64 { wl[y as usize] = if ground { row_wall(y) } else { 0 }; }
        erode(&mut f, &mut e, 0, 63);
        let mut cand = refit(&e, &mut fit, &wl, 0, 63);
        if cand == 0 { i = en; continue; }
        // The search: rings of cells around the run's templates (8-neighbour
        // dilations of the frontier, 64 cells a word; ground: not into wall
        // tiles, a template's own cell is a start anyway). Each ring's fitting
        // cells are taken in row order, the next after each placement's
        // exclusion; the run ends when it has its units, no cell fits, the
        // frontier is empty or past P[8] cells.
        let mut fr = [0u64; 64];
        let mut vis = [0u64; 64];
        let (mut ylo, mut yhi) = (64i32, -1i32);
        for t in i..en {
            let ti = g(tord, t) as usize;
            let (x, y) = ((g(ux, ti) >> csh) - bx0, (g(uy, ti) >> csh) - by0);
            if x >= 0 && y >= 0 && x < 64 && y < 64 { *fr.get_unchecked_mut(y as usize) |= 1u64 << x; ylo = ylo.min(y); yhi = yhi.max(y); }
        }
        for y in 0..64 { *vis.get_unchecked_mut(y) = *fr.get_unchecked(y); }
        let mut made = 0usize;
        let mut ring = 0i32;
        while yhi >= ylo && made < need && cand > 0 {
            // (This ring's fitting cells, row by row, lowest bit first.)
            let mut y = ylo;
            while y <= yhi && made < need {
                let hit = *fr.get_unchecked(y as usize) & *fit.get_unchecked(y as usize);
                if hit == 0 { y += 1; continue; }
                let x = hit.trailing_zeros() as i32;
                let (cx, cy) = (bx0 + x, by0 + y);
                let px = (cx << csh) + (cell >> 1); let py = (cy << csh) + (cell >> 1);
                super::occ::disk_mark(&gd, px, py, r, layer);
                let ti = g(tord, i + made) as usize;
                s(pos, 2 * ti, px); s(pos, 2 * ti + 1, py);
                made += 1;
                // (Its exclusion spans out of the fit map; the same row again.)
                for d in 2 - 2 * r..=2 * r - 2 {
                    let wd = *ex.get_unchecked((d + 63) as usize);
                    let yy = y + d;
                    if wd < 0 || yy < 0 || yy > 63 { continue; }
                    let (lo, hi) = ((x - wd).max(0), (x + wd).min(63));
                    let m = if hi - lo >= 63 { u64::MAX } else { ((1u64 << (hi - lo + 1)) - 1) << lo };
                    let row = fit.get_unchecked_mut(yy as usize);
                    cand -= (*row & m).count_ones() as i32;
                    *row &= !m;
                }
            }
            if made >= need || cand <= 0 || ring >= search { break; }
            ring += 1;
            // (The next ring: the frontier dilated, less the visited and the walls.)
            let (y0, y1) = ((ylo - 1).max(0), (yhi + 1).min(63));
            let mut prev = 0u64;
            let (mut nlo, mut nhi) = (64i32, -1i32);
            let mut cur = *fr.get_unchecked(y0 as usize);
            for y in y0..=y1 {
                let next = if y < 63 { *fr.get_unchecked(y as usize + 1) } else { 0 };
                let v = prev | cur | next;
                let mut d = (v | (v << 1) | (v >> 1)) & !*vis.get_unchecked(y as usize);
                if ground { d &= !*wl.get_unchecked(y as usize); }
                prev = cur; cur = next;
                *fr.get_unchecked_mut(y as usize) = d;
                if d != 0 { *vis.get_unchecked_mut(y as usize) |= d; nlo = nlo.min(y); nhi = nhi.max(y); }
            }
            // (Rows outside the band were empty and stay so.)
            ylo = nlo; yhi = nhi;
        }
        i = en;
    }
}

/// Births, allocation (one job, after the placement; the only serial pass of
/// a birth): per template index in order with a place (pos [0]; tg [2] its
/// group) a slot by the allocator (nfs.rs slab_alloc_bulk; books [3]..[11]
/// as k_slab_take's, keys by the place's 16x16-tile block: P[4] tile in
/// eighths, P[5] kw, P[6] kh) and a handle (free stack hfree [12], hh [13]:
/// [0] free count, [1] next). Per birth b: its slot bs [14], handle bh [15],
/// template index bt [16], place in newl bn [17] (a group's unit made
/// already by the full path, pre [18], first in its group's run); slots
/// that held a unit before into reuse [19]; the groups' spawns made (grp
/// [20] +2, P[11] groups). out [21]: [0] births, [1] reused, [4] -1 or the
/// index whose slot failed, [5] newl entries. P: [0] templates, [1] slots
/// the columns have, [2] slack minimum, [10] slack shift.
#[no_mangle]
pub unsafe extern "C" fn k_birth_alloc(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (pos, tg) = (k.p::<i32>(0), k.p::<i32>(2));
    let books = super::nfs::Books::from(&k, 3, k.i(1));
    let (used, ever) = (k.p::<u32>(9), k.p::<u32>(10));
    let (hfree, hh, bs, bh, bt, bn, pre, reuse, made, out) = (k.p::<i32>(12), k.p::<i32>(13), k.p::<i32>(14), k.p::<i32>(15), k.p::<i32>(16), k.p::<i32>(17), k.p::<i32>(18), k.p::<i32>(19), k.p::<i32>(20), k.p::<i32>(21));
    let (n, smin, tq, kw, kh, ssh, ng) = (k.i(0).max(0) as usize, k.i(2), k.i(4).max(1), k.i(5).max(1), k.i(6).max(1), k.i(10), k.i(11).max(0) as usize);
    let (mut nb, mut nr, mut fail, mut nl, mut lastg) = (0usize, 0usize, -1i32, 0usize, -1i32);
    let (mut hfn, mut hnx) = (g(hh, 0), g(hh, 1));
    for gi in 0..ng { s(made, gi * 6 + 2, 0); }
    for i in 0..n {
        let px = g(pos, 2 * i);
        if px < 0 { continue; }
        let py = g(pos, 2 * i + 1);
        let gi = g(tg, i) as usize;
        if gi as i32 != lastg {
            lastg = gi as i32;
            if !pre.is_null() && g(pre, gi) >= 0 { nl += 1; s(made, gi * 6 + 2, g(made, gi * 6 + 2) + 1); }
        }
        let key = { let kx = idiv(px, tq * 16).min(kw - 1); let ky = idiv(py, tq * 16).min(kh - 1); ky * kw + kx };
        let sl = super::nfs::slab_alloc_bulk(&books, key, smin, ssh);
        if sl < 0 { fail = i as i32; break; }
        let (wd, m) = ((sl >> 5) as usize, 1u32 << (sl & 31));
        if *used.add(wd) & m != 0 { s(reuse, nr, sl); nr += 1; }
        *used.add(wd) |= m; *ever.add(wd) |= m;
        let hd = if hfn > 0 { hfn -= 1; g(hfree, hfn as usize) } else { hnx += 1; hnx - 1 };
        s(bs, nb, sl); s(bh, nb, hd); s(bt, nb, i as i32); s(bn, nb, nl as i32);
        nl += 1; nb += 1;
        s(made, gi * 6 + 2, g(made, gi * 6 + 2) + 1);
    }
    // (A group whose places all went to its made one: still listed.)
    if !pre.is_null() { for gi in 0..ng { if g(made, gi * 6 + 2) == 0 && g(pre, gi) >= 0 { s(made, gi * 6 + 2, 1); nl += 1; } } }
    s(out, 0, nb as i32); s(out, 1, nr as i32); s(out, 4, fail); s(out, 5, nl as i32);
    s(hh, 0, hfn); s(hh, 1, hnx);
}

/// Births, fill (SIM_KERNEL_BIRTH_FILL, chunks of P[1] births): birth b's
/// spawn row (rows [6], 12 f64: slot, its group's program (gp [7], 6 f64 a
/// group: program start, triples, r, collisionR, energy, type index), id
/// P[2] + b, owner P[3], type, x, y, r, collisionR, energy, handle), the
/// handle's slot (hslot [8]), the footprint record (occ.rec [9]: x, y,
/// radius | layer << 8 | active, gm [10]), the id table row (uix ids [11],
/// slots [12] from P[4]), the id hash table [13] (mask P[5]; an empty
/// bucket taken by compare-exchange: births share the table), newl [14] at
/// its place. From the allocation: bs [0], bh [1], bt [2], bn [3]; pos [4],
/// tg [5]. P: [0] births.
#[no_mangle]
pub unsafe extern "C" fn k_birth_fill(a: u32, chunk: i32) {
    use core::sync::atomic::{AtomicI32, Ordering};
    let k = K::new(waddr(a) as *const i32);
    let (bs, bh, bt, bn, pos, rows) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<f64>(6));
    let (hslot, rec, spw, uids, uslots, tab, newl) = (k.p::<i32>(8), k.p::<i32>(9), k.p::<i32>(10), k.p::<i32>(11), k.p::<i32>(12), k.p::<i32>(13), k.p::<i32>(14));
    // (Its template's type columns: Z table [15] entries listed in cp [16] (P[6]); type, r, collisionR: upT [17], r [18], collisionR [19].)
    let (ztab, cp, upt, ur, ucr) = (k.p::<i32>(15), k.p::<i32>(16), k.p::<i16>(17), k.p::<f32>(18), k.p::<f32>(19));
    let ncp = k.i(6).max(0) as usize;
    let (n, per, id0, owner, u0, mask) = (k.i(0), k.i(1), k.i(2), k.f(3), k.i(4).max(0) as usize, k.i(5) as u32);
    let (j0, j1) = super::k::job_range(chunk, per, n);
    for b in j0..j1 {
        let (sl, hd, ti) = (g(bs, b), g(bh, b), g(bt, b) as usize);
        let su = sl as usize;
        let (px, py) = (g(pos, 2 * ti), g(pos, 2 * ti + 1));
        let tq = g(spw, ti) as usize;
        let id = id0 + b as i32;
        let r = rows.add(b * 12);
        // (No program: the template's columns below; the shares kernel writes the levels, rows, maxEnergy and energy.)
        *r = sl as f64; *r.add(1) = 0.0; *r.add(2) = 0.0; *r.add(3) = id as f64; *r.add(4) = owner; *r.add(5) = g(upt, tq) as f64;
        *r.add(6) = px as f64; *r.add(7) = py as f64; *r.add(8) = g(ur, tq) as f64; *r.add(9) = g(ucr, tq) as f64; *r.add(10) = 1.0; *r.add(11) = hd as f64;
        s(hslot, hd as usize, sl);
        let rp = rec.add(su * 4);
        *rp = px; *rp.add(1) = py; *rp.add(2) = (g(rec, tq * 4 + 2) & 0xffff) | (1 << 16) | (*rp.add(2) & (255 << 24));
        for c in 0..ncp {
            let e = g(cp, c) as usize;
            let base = waddr(g(ztab, 3 * e) as u32) as *mut u8;
            let (bytes, per) = (g(ztab, 3 * e + 1) as usize, g(ztab, 3 * e + 2) as usize);
            let n = bytes * per;
            core::ptr::copy_nonoverlapping(base.add(tq * n), base.add(su * n), n);
        }
        s(uids, u0 + b, id); s(uslots, u0 + b, sl);
        let _ = (newl, bn);
        let mut hq = (id as u32).wrapping_mul(2654435761u32) & mask;
        loop {
            let cell = &*(tab.add(hq as usize) as *const AtomicI32);
            if cell.load(Ordering::Relaxed) < 0 && cell.compare_exchange(-1, sl, Ordering::Relaxed, Ordering::Relaxed).is_ok() { break; }
            hq = (hq + 1) & mask;
        }
    }
}

/// Upkeep bins (main.js _upkUnitBin / upkeepUnitRefresh) of the units of
/// list [0] (P[0], -1 skipped): bin (type unit.upT [2] * P[1] players +
/// owner [1]) * P[2] levels + level (effectiveLevel [3], else unitLevel
/// [4], else baseLevel [5], else from stackCount [6]); unit.upB [7] moved,
/// the counts upk.h [8] (P[3] long: a bin past it is none) adjusted.
#[no_mangle]
pub unsafe extern "C" fn k_upk_bins(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (list, own, upt, el, ul, bl, sc, upb, cnt) = (k.p::<i32>(0), k.p::<i8>(1), k.p::<i16>(2), k.p::<i8>(3), k.p::<i8>(4), k.p::<i8>(5), k.p::<f32>(6), k.p::<i32>(7), k.p::<i32>(8));
    let (n, np, l1, nc) = (k.i(0).max(0) as usize, k.i(1).max(1), k.i(2).max(2), k.i(3));
    for i in 0..n {
        let q = g(list, i);
        if q < 0 { continue; }
        let q = q as usize;
        let (ow, ty) = (g(own, q) as i32, g(upt, q) as i32);
        let b = if ow < 0 || ow >= np || ty < 0 { -1 } else {
            let mut l = g(el, q) as i32;
            if l <= 0 { l = g(ul, q) as i32; }
            if l <= 0 { l = g(bl, q) as i32; }
            if l <= 0 { let s0 = g(sc, q); l = if s0 == s0 && s0 < f32::INFINITY { let mut v = floor((s0 as f64).max(1.0)) as i64; let mut kk = 0; while v >= 2 { v /= 2; kk += 1; } kk + 1 } else { 1 }; }
            let b = (ty * np + ow) * l1 + l.clamp(1, l1 - 1);
            if b < nc { b } else { -1 }
        };
        let o = g(upb, q);
        if b == o { continue; }
        if o >= 0 && o < nc { s(cnt, o as usize, g(cnt, o as usize) - 1); }
        if b >= 0 { s(cnt, b as usize, g(cnt, b as usize) + 1); }
        s(upb, q, b);
    }
}

/// q / e's shares (SIM_KERNEL_RZ_SHARES; k.rs k_unit_resize's phase 1 as
/// two passes). Phase P[0] 0 (one job): per group (grp [0], cnt [1][0]
/// groups) its units m = kept + spawns made (grp +1, +2), its stacks spread
/// as base or base + 1 (the first rem one more), their levels and the
/// table's maxEnergy at them (eff.bMaxE [11] at (player P[4] * P[2] types +
/// type) * P[3] levels + level), the group's energy (at most what it had,
/// at most the caps) water-filled in closed form (two caps at most: the
/// smaller fills first); into gsh [2] (8 f64 a group: unit start, newl
/// start, base, rem, energy of the first rem, of the rest, their levels);
/// cnt[3] the units. Phase 1 (chunks of P[1] units over all groups): each
/// unit (kept: list [3] from the group's start; new: newl [4]) its stacks
/// (unit.stackCount [5], effectiveStacks [6]), levels (unitLevel [7],
/// baseLevel [8], effectiveLevel [9], _lastAppliedEffectiveLevel [10] 0),
/// maxEnergy (unit.maxE [12], jMaxE [13]), window (eff.bRad [14] ->
/// unit.esRad [15]), rows (statRow [16], bsRow [17]) and energy [18].
#[no_mangle]
pub unsafe extern "C" fn k_rz_shares(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (grp, cnt, gsh, list, newl) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<f64>(2), k.p::<i32>(3), k.p::<i32>(4));
    let (stk, esk, ulv, blv, elv, last, bmx) = (k.p::<f32>(5), k.p::<f32>(6), k.p::<i8>(7), k.p::<i8>(8), k.p::<i8>(9), k.p::<i8>(10), k.p::<f32>(11));
    let (maxe, jmaxe, brad, rad, srow, bsrow, en) = (k.p::<f32>(12), k.p::<f32>(13), k.p::<i32>(14), k.p::<u8>(15), k.p::<i16>(16), k.p::<i16>(17), k.p::<f32>(18));
    let (phase, per, nt, l1, player) = (k.i(0), k.i(1), k.i(2).max(1), k.i(3).max(2), k.i(4));
    let ng = g(cnt, 0).max(0) as usize;
    let maxl = l1 - 1;
    let row = |ty: i32, lv: i32| -> usize { ((player * nt + ty) * l1 + lv) as usize };
    if phase == 0 {
        let (mut at, mut nb) = (0i32, 0i32);
        for gi in 0..ng {
            let b = gi * 6;
            let (keep, made, key) = (g(grp, b + 1), g(grp, b + 2), g(grp, b + 3));
            let m = keep + made;
            let st = f32::from_bits(g(grp, b + 4) as u32) as f64;
            let ensum = f32::from_bits(g(grp, b + 5) as u32) as f64;
            let o = gsh.add(gi * 8);
            *o = at as f64; *o.add(1) = nb as f64;
            at += m; nb += made;
            if m <= 0 { for i in 2..8 { *o.add(i) = 0.0; } continue; }
            let total = st.max(m as f64);
            let base = floor(total / m as f64);
            let rem = (total - base * m as f64).max(0.0).min(m as f64);
            let ty = key >> 6;
            let (lh, ll) = (stack_level((base + 1.0) as f32, maxl), stack_level(base.max(1.0) as f32, maxl));
            let cap = |lv: i32| -> f64 { if ty >= 0 && ty < nt { let v = g(bmx, row(ty, lv)) as f64; if v > 0.0 { v } else { 0.0 } } else { 0.0 } };
            let (ch, cl) = (cap(lh), cap(ll));
            let (nh, nl) = (rem, m as f64 - rem);
            let left = ensum.min(nh * ch + nl * cl);
            let (mut eh, mut el) = (0.0f64, 0.0f64);
            if left > 1e-6 {
                let even = left / m as f64;
                let (small, big, ns, nbg) = if ch <= cl { (ch, cl, nh, nl) } else { (cl, ch, nl, nh) };
                let (es, eb) = if even <= small || nbg <= 0.0 { (even.min(small), even.min(big)) } else { (small, ((left - ns * small) / nbg).min(big)) };
                if ch <= cl { eh = es; el = eb; } else { eh = eb; el = es; }
            }
            *o.add(2) = base; *o.add(3) = rem; *o.add(4) = eh; *o.add(5) = el; *o.add(6) = lh as f64; *o.add(7) = ll as f64;
        }
        s(cnt, 3, at);
        return;
    }
    let total = g(cnt, 3);
    let (j0, j1) = super::k::job_range(chunk, per, total);
    if j0 >= j1 { return; }
    // (The group of the chunk's first unit; then on in order.)
    let mut gi = 0usize;
    while gi + 1 < ng && *gsh.add((gi + 1) * 8) as usize <= j0 { gi += 1; }
    for j in j0..j1 {
        while gi + 1 < ng && *gsh.add((gi + 1) * 8) as usize <= j { gi += 1; }
        let o = gsh.add(gi * 8);
        let x = j - *o as usize;
        let b = gi * 6;
        let (start, keep, key) = (g(grp, b) as usize, g(grp, b + 1) as usize, g(grp, b + 3));
        let q = if x < keep { g(list, start + x) } else { g(newl, *o.add(1) as usize + x - keep) };
        if q < 0 { continue; }
        let q = q as usize;
        let dead = k.p::<u8>(19);
        if !dead.is_null() && g(dead, q) != 0 { continue; }
        let hi = (x as f64) < *o.add(3);
        let share = ((*o.add(2) + if hi { 1.0 } else { 0.0 }).max(1.0)) as f32;
        let lvl = if hi { *o.add(6) } else { *o.add(7) } as i32;
        s(stk, q, share); s(esk, q, share);
        s(ulv, q, lvl as i8); s(blv, q, lvl as i8); s(elv, q, lvl as i8); s(last, q, 0);
        let ty = key >> 6;
        let mx = if ty >= 0 && ty < nt {
            let bi = row(ty, lvl);
            let mx = g(bmx, bi);
            s(maxe, q, mx); s(jmaxe, q, mx);
            s(rad, q, g(brad, bi) as u8);
            s(srow, q, bi as i16); s(bsrow, q, bi as i16);
            mx
        } else { g(maxe, q) };
        let e = (if hi { *o.add(4) } else { *o.add(5) }) as f32;
        s(en, q, if e > 0.0 { e } else { mx.min(1.0) });
    }
}

// ---- staged q / e (UNIT_BIRTH_WASM_PLAN.md "Staged q / e"): slab reservation, the lane's slot assignment, the commit ----

/// A slab reserved for a staged batch's births (home RZ_RESERVED: neither the
/// allocator (nfs.rs) nor a list hands it out; its free count 64 keeps the
/// passes over slots off it until the commit).
pub(super) const RZ_RESERVED: i32 = -2;

/// Reserve (one job, the action's tick): free slots for P[0] births: whole
/// empty slabs (the empty list) first, then the holes of partly free slabs
/// (the "any" list), then new slabs (P[1] slots the columns have). Per
/// reserved slab (rsl [9]) its free bits then (rmask [11], two words) and its
/// home (rhome [12]); the slots in order into rslot [13]; out [10]: [0]
/// slabs, [1] slots. A reserved slab's home is RZ_RESERVED (the allocator
/// and the lists pass it over), its free bits none, its slots out of the free
/// count; its free count stays (a whole one reads as empty to the passes).
/// Books [0]..[8] as k_slab_take's.
#[no_mangle]
pub unsafe extern "C" fn k_rz_reserve(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let b = super::nfs::Books::from(&k, 0, k.i(1));
    let (rsl, out, rmask, rhome, rslot) = (k.p::<i32>(9), k.p::<i32>(10), k.p::<u32>(11), k.p::<i32>(12), k.p::<i32>(13));
    let want = k.i(0).max(0) as usize;
    let (mut ns, mut nsl) = (0usize, 0usize);
    let take = |sl: i32, nsl: &mut usize, ns: &mut usize| {
        let (lo, hi) = (g(b.bits, sl as usize * 2), g(b.bits, sl as usize * 2 + 1));
        s(rsl, *nsl, sl); s(rmask, *nsl * 2, lo); s(rmask, *nsl * 2 + 1, hi); s(rhome, *nsl, g(b.home, sl as usize));
        *nsl += 1;
        let mut m = (lo as u64) | ((hi as u64) << 32);
        while m != 0 { let j = m.trailing_zeros() as i32; m &= m - 1; s(rslot, *ns, sl * 64 + j); *ns += 1; }
        *b.hdr -= ((lo.count_ones() + hi.count_ones()) as i32);
        s(b.home, sl as usize, RZ_RESERVED); s(b.bits, sl as usize * 2, 0); s(b.bits, sl as usize * 2 + 1, 0);
    };
    let nk = g(b.hdr, 4);
    for list in [nk + 1, nk] {
        let li = list as usize;
        while ns < want && g(b.heads, li) != 0 {
            let at = g(b.heads, li) as usize; let sl = g(b.entries, at); s(b.heads, li, g(b.entries, at + 1));
            let f = g(b.sfree, sl as usize) as i32;
            if g(b.home, sl as usize) == RZ_RESERVED || f == 0 || (list == nk + 1 && f != 64) { continue; }
            take(sl, &mut nsl, &mut ns);
        }
    }
    while ns < want {
        let sl = super::nfs::slab_fresh_pub(&b);
        if sl < 0 { break; }
        take(sl, &mut nsl, &mut ns);
    }
    s(out, 0, nsl as i32); s(out, 1, ns as i32);
}

/// Assign (the lane, one job, after both placement rounds): births in block
/// order (round 0's jobs [0] (P[2] of them, bcnt [1][0]) with their tord
/// [2], then round 1's jobs [3], tord [4], bcnt [1][1]), each placed
/// template (pos [5] x >= 0) one: its template index into bt [6], its slot
/// the reserved slabs' (rsl [7], P[0] slabs) next into bs [8] (-1 past the
/// births, P[1] entries), its row (rows [9], 12 f64: k_spawn_write's: no
/// program, id and handle written at the commit; type, r, collisionR the
/// template's: tup [10], tr [11], tcr [12]; owner P[3]) (-1 triples past
/// the births: skipped); commit jobs cj [13] (start, end, round: a block's
/// births; 4 words: start, end, round, block); out [14]: [0] births, [1] commit jobs, [2] those of round 0.
#[no_mangle]
pub unsafe extern "C" fn k_rz_assign(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (jobs0, bcnt, tord0, jobs1, tord1, pos, bt, rsl, bs, rows) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8), k.p::<f64>(9));
    let (tup, tr, tcr, cj, out) = (k.p::<i32>(10), k.p::<f32>(11), k.p::<f32>(12), k.p::<i32>(13), k.p::<i32>(14));
    let (cap, ne, owner) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.f(3));
    // (The reserved slots in order: k_rz_reserve's rslot [15].)
    let rslot = k.p::<i32>(15);
    let (mut nb, mut nj, mut nj0) = (0usize, 0usize, 0usize);
    for round in 0..2 {
        let (jobs, tord) = if round == 0 { (jobs0, tord0) } else { (jobs1, tord1) };
        let njobs = g(bcnt, round).max(0) as usize;
        for j in 0..njobs {
            let (t0, t1) = (g(jobs, 3 * j + 1) as usize, g(jobs, 3 * j + 2) as usize);
            let start = nb;
            for t in t0..t1 {
                let ti = g(tord, t) as usize;
                if g(pos, 2 * ti) < 0 || nb >= cap || nb >= ne { continue; }
                let sl = g(rslot, nb);
                s(bt, nb, ti as i32); s(bs, nb, sl);
                let r = rows.add(nb * 12);
                *r = sl as f64; *r.add(1) = 0.0; *r.add(2) = 0.0; *r.add(3) = 0.0; *r.add(4) = owner; *r.add(5) = g(tup, ti) as f64;
                *r.add(6) = g(pos, 2 * ti) as f64; *r.add(7) = g(pos, 2 * ti + 1) as f64; *r.add(8) = g(tr, ti) as f64; *r.add(9) = g(tcr, ti) as f64; *r.add(10) = 1.0; *r.add(11) = 0.0;
                nb += 1;
            }
            if nb > start { s(cj, nj * 4, start as i32); s(cj, nj * 4 + 1, nb as i32); s(cj, nj * 4 + 2, round as i32); s(cj, nj * 4 + 3, g(jobs, 3 * j)); nj += 1; }
        }
        if round == 0 { nj0 = nj; }
    }
    for b in nb..ne { s(bs, b, -1); let r = rows.add(b * 12); *r.add(2) = -1.0; }
    s(out, 0, nb as i32); s(out, 1, nj as i32); s(out, 2, nj0 as i32);
}

/// Commit, places (one job a block of births: cj [0] from P[0] (round 0's,
/// then round 1's)): each birth's footprint (pos [2] of its template bt [1];
/// meta tmeta [3]) checked against the live occupancy bits [4] (mask [5])
/// and marked; one taken since the placement moves to the nearest free
/// place within P[9] cells inside its block (not onto a wall tile, mv.wall
/// [7], a ground unit; pos rewritten); ok [6] 1 when it stood. P: [1] w,
/// [2] h, [3] stride, [4] cell, [5] planes, [6] blocks wide, [7] GRID_W,
/// [8] cells a tile.
#[no_mangle]
pub unsafe extern "C" fn k_rz_cplace(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (cj, bt, pos, tmeta, bits, mask, ok) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<u32>(4), k.p::<i8>(5), k.p::<u8>(6));
    let (w, h, stride, cell, planes) = (k.i(1), k.i(2), k.i(3), k.i(4).max(1), k.i(5).max(1));
    let (bw, gw, ctile, retry) = (k.i(6).max(1), k.i(7), k.i(8).max(1), k.i(9).max(0));
    let wall = k.p::<u8>(7);
    let j = (k.i(0) + chunk.max(0)) as usize;
    let gd = super::occ::grid(bits, mask, w, h, stride, cell, planes);
    let (csh, tsh) = (cell.trailing_zeros(), ctile.trailing_zeros());
    // (The job's block: a retry's footprint stays inside it, as the placement's did.)
    let (round, blk) = (g(cj, 4 * j + 2), g(cj, 4 * j + 3));
    let off = if round != 0 { 32 } else { 0 };
    let bx0 = irem(blk, bw) * BC - off; let by0 = idiv(blk, bw) * BC - off;
    for b in g(cj, 4 * j) as usize..g(cj, 4 * j + 1) as usize {
        let ti = g(bt, b) as usize;
        let (px, py, meta) = (g(pos, 2 * ti), g(pos, 2 * ti + 1), g(tmeta, ti));
        let (r, layer, ground) = ((meta & 255).max(1).min(32), ((meta >> 8) & 255).min(planes - 1), (meta >> 16) & 1 == 0);
        let (cx, cy) = (px >> csh, py >> csh);
        let fits_at = |x: i32, y: i32| -> bool {
            if x - r < bx0 || y - r < by0 || x + r >= bx0 + BC || y + r >= by0 + BC || x < 0 || y < 0 || x >= w || y >= h { return false; }
            if ground && !wall.is_null() && g(wall, ((y >> tsh) * gw + (x >> tsh)) as usize) != 0 { return false; }
            !super::occ::cell_taken(&gd, x, y, layer) && super::occ::disk_free(&gd, (x << csh) + (cell >> 1), (y << csh) + (cell >> 1), r, layer)
        };
        let mut at = if !super::occ::cell_taken(&gd, cx, cy, layer) && super::occ::disk_free(&gd, px, py, r, layer) { Some((px, py)) } else { None };
        // (Taken since the placement: the nearest free one within P[9] cells, ring by ring.)
        let mut d = 1;
        while at.is_none() && d <= retry {
            'ring: for dy in -d..=d { for dx in -d..=d {
                if dx.abs() != d && dy.abs() != d { continue; }
                if fits_at(cx + dx, cy + dy) { at = Some((((cx + dx) << csh) + (cell >> 1), ((cy + dy) << csh) + (cell >> 1))); break 'ring; }
            }}
            d += 1;
        }
        match at {
            Some((x, y)) => { super::occ::disk_mark(&gd, x, y, r, layer); s(pos, 2 * ti, x); s(pos, 2 * ti + 1, y); s(ok, b, 1); }
            None => s(ok, b, 0),
        }
    }
}

/// Commit, rank (one job). P[2] 0, a sub-commit's births [P[3], P[4]):
/// each that stood (ok [0]; its template bt [1], the template's group tg
/// [2]) its rank in the range (its id and id table row offset) into brk [3],
/// its group's made count (grp [4] +2) one more; one that did not: no slot
/// (bs [8] -1: no spatial entry, no upkeep bin); out [6][0] those made. P[2]
/// 1, the final step: every birth that stood (P[0] births: bs >= 0, ok) in
/// newl [5] by group (the groups' starts from their made counts, P[1]
/// groups; gofs [7] scratch); out [6][1] their count.
#[no_mangle]
pub unsafe extern "C" fn k_rz_crank(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ok, bt, tg, brk, grp, newl, out, gofs, bs) = (k.p::<u8>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8));
    // (rows [9]: a failed birth's row marked none (row[2] -1), so the core write leaves its slot as it was: fresh.)
    let rows = k.p::<f64>(9);
    let (n, ng, mode) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2));
    if mode == 0 {
        let (b0, b1) = (k.i(3).max(0) as usize, k.i(4).max(0) as usize);
        let mut nr = 0i32;
        for b in b0..b1 {
            if g(ok, b) != 0 { let gi = g(tg, g(bt, b) as usize) as usize; s(grp, gi * 6 + 2, g(grp, gi * 6 + 2) + 1); s(brk, b, nr); nr += 1; }
            else { s(brk, b, -1); s(bs, b, -1); if !rows.is_null() { *rows.add(b * 12 + 2) = -1.0; } }
        }
        s(out, 0, nr);
        return;
    }
    let mut at = 0i32;
    for gi in 0..ng { s(gofs, gi, at); at += g(grp, gi * 6 + 2); }
    let mut nl = 0i32;
    for b in 0..n {
        if g(ok, b) == 0 || g(bs, b) < 0 { continue; }
        let gi = g(tg, g(bt, b) as usize) as usize; let o = g(gofs, gi); s(newl, o as usize, g(bs, b)); s(gofs, gi, o + 1); nl += 1;
    }
    s(out, 1, nl);
}

/// Commit, fill (chunks of P[1] births): each birth that stood (brk [0] >= 0;
/// its slot bs [1], template bt [2]) its id P[2] + rank (unit.id [3]),
/// live [4], tmOn [5], handle (the free stack's from the top hfree [6] (P[3]
/// free), then new from P[4]: unit.hnd [7], hslot [8]), the footprint
/// record (occ.rec [9]: pos [10], tmeta [11]), the template's type columns
/// (Z table [12] entries cp [13], P[5]; the template's slot spw [14]), the
/// id table row (uix ids [15], slots [16] from P[6]; type columns from the action tick's capture tcp [14]), the id hash (table
/// [17], mask P[7]; compare-exchange), its place in newl [18] (bn [19]), its
/// used / ever bits (slab books [20], [21]; atomic or).
#[no_mangle]
pub unsafe extern "C" fn k_rz_cfill(a: u32, chunk: i32) {
    use core::sync::atomic::{AtomicI32, AtomicU32, Ordering};
    let k = K::new(waddr(a) as *const i32);
    let (brk, bs, bt, idc, live, tmon, hfree, hnd, hslot, rec, pos, tmeta) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<u8>(4), k.p::<u8>(5), k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9), k.p::<i32>(10), k.p::<i32>(11));
    let (ztab, cp, tcp, uids, uslots, tab, newl, bn, used, ever) = (k.p::<i32>(12), k.p::<i32>(13), k.p::<u8>(14), k.p::<i32>(15), k.p::<i32>(16), k.p::<i32>(17), k.p::<i32>(18), k.p::<i32>(19), k.p::<u32>(20), k.p::<u32>(21));
    let (n, per, id0, hfn, hnx, ncp, u0, mask) = (k.i(0), k.i(1), k.i(2), k.i(3), k.i(4), k.i(5).max(0) as usize, k.i(6).max(0) as usize, k.i(7) as u32);
    let (j0, j1) = super::k::job_range(chunk, per, n);
    let b0 = k.i(8).max(0) as usize;
    for b in b0 + j0..b0 + j1 {
        let rk = g(brk, b);
        if rk < 0 { continue; }
        let (sl, ti) = (g(bs, b), g(bt, b) as usize);
        let su = sl as usize;
        let id = id0 + rk;
        // (Its type columns: its group's first template's, as every peer has them, a restored one too.)
        let (gsp, tgp) = (k.p::<i32>(29), k.p::<i32>(30));
        let t0 = if gsp.is_null() || tgp.is_null() { ti } else { g(gsp, g(tgp, ti) as usize) as usize };
        s(idc, su, id); s(live, su, 1); s(tmon, su, 1);
        let hd = if rk < hfn { g(hfree, (hfn - 1 - rk) as usize) } else { hnx + (rk - hfn) };
        s(hnd, su, hd); s(hslot, hd as usize, sl);
        let rp = rec.add(su * 4);
        let (px, py) = (g(pos, 2 * ti), g(pos, 2 * ti + 1));
        *rp = px; *rp.add(1) = py; *rp.add(2) = (g(tmeta, ti) & 0xffff) | (1 << 16) | (*rp.add(2) & (255 << 24));
        for (i, v) in [px, py, px, py, px, py].iter().enumerate() { let col = k.p::<i32>(22 + i); if !col.is_null() { s(col, su, *v); } }
        // (An event the movement left on the slot while it was reserved, not live (k_unit_events clears only live ones' events): none.)
        let ev = k.p::<u8>(28); if !ev.is_null() { s(ev, su, 0); }
        for c in 0..ncp {
            let (e, off) = (g(cp, 2 * c) as usize, g(cp, 2 * c + 1) as usize);
            let base = waddr(g(ztab, 3 * e) as u32) as *mut u8;
            let m = g(ztab, 3 * e + 1) as usize * g(ztab, 3 * e + 2) as usize;
            core::ptr::copy_nonoverlapping(tcp.add(t0 * 64 + off), base.add(su * m), m);
        }
        s(uids, u0 + rk as usize, id); s(uslots, u0 + rk as usize, sl);
        s(newl, g(bn, b) as usize, sl);
        let mut hq = (id as u32).wrapping_mul(2654435761u32) & mask;
        loop {
            let cell = &*(tab.add(hq as usize) as *const AtomicI32);
            if cell.load(Ordering::Relaxed) < 0 && cell.compare_exchange(-1, sl, Ordering::Relaxed, Ordering::Relaxed).is_ok() { break; }
            hq = (hq + 1) & mask;
        }
        let (wd, m) = ((sl >> 5) as usize, 1u32 << (sl & 31));
        (*(used.add(wd) as *const AtomicU32)).fetch_or(m, Ordering::Relaxed);
        (*(ever.add(wd) as *const AtomicU32)).fetch_or(m, Ordering::Relaxed);
    }
}

/// Commit, slabs (one job): each reserved slab (rsl [9], P[0]; its free
/// bits then rmask [14], its home rhome [15]) back to the books: its
/// reserved slots (rslot [16], in order) that got no unit that stood (births
/// in slot order: P[1] births, ok [11]) free again, its free count, its home
/// (as it was; a slab that had none: the block of its first new unit, unit
/// x [12], y [13], P[2] tile in eighths, P[3] kw, P[4] kh), listed as a
/// freed slab is (its block's list and "any", or "empty"). Books [0]..[8].
#[no_mangle]
pub unsafe extern "C" fn k_rz_cslabs(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let b = super::nfs::Books::from(&k, 0, 0);
    let (rsl, ok, ux, uy, rmask, rhome, rslot) = (k.p::<i32>(9), k.p::<u8>(11), k.p::<i32>(12), k.p::<i32>(13), k.p::<u32>(14), k.p::<i32>(15), k.p::<i32>(16));
    let (nsl, nb, tq, kw, kh) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2).max(1), k.i(3).max(1), k.i(4).max(1));
    // (Reserved slot kk is birth done + kk: P[5], a restored job's births made before its snapshot.)
    let done = k.i(5).max(0) as usize;
    let nk = g(b.hdr, 4);
    let mut at = 0usize;
    for i in 0..nsl {
        let slab = g(rsl, i);
        let mut m = (g(rmask, 2 * i) as u64) | ((g(rmask, 2 * i + 1) as u64) << 32);
        let mut home = g(rhome, i);
        let n = m.count_ones() as usize;
        for kk in at..at + n {
            if done + kk < nb && g(ok, done + kk) != 0 {
                let q = g(rslot, kk);
                m &= !(1u64 << (q & 63));
                if home < 0 { let kx = idiv(g(ux, q as usize), tq * 16).min(kw - 1).max(0); let ky = idiv(g(uy, q as usize), tq * 16).min(kh - 1).max(0); home = ky * kw + kx; }
            }
        }
        at += n;
        // (Its free slots: those freed since the reservation (units of a partly
        // free slab that died meanwhile: counted free already) and the reserved
        // ones that got no unit (back into the free count).)
        let back = m.count_ones() as i32;
        let cur = (g(b.bits, slab as usize * 2) as u64) | ((g(b.bits, slab as usize * 2 + 1) as u64) << 32);
        let fm = cur | m;
        let free = fm.count_ones() as i32;
        s(b.bits, slab as usize * 2, fm as u32); s(b.bits, slab as usize * 2 + 1, (fm >> 32) as u32);
        s(b.sfree, slab as usize, free as u8); s(b.home, slab as usize, home);
        *b.hdr += back;
        if free == 64 { super::nfs::list_push(&b, nk + 1, slab); }
        else if free > 0 { if home >= 0 { super::nfs::list_push(&b, home, slab); } super::nfs::list_push(&b, nk, slab); }
    }
}

/// Commit, kills (d2; chunks of P[1] over the listed units, P[0]): a unit
/// past its group's kept ones (grp [0], cnt [1][0] groups; list [2]) dies
/// (energy [3] 0, dead [4] 1), one dead already left as it is.
#[no_mangle]
pub unsafe extern "C" fn k_rz_kill(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (grp, cnt, list, en, dead) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<f32>(3), k.p::<u8>(4));
    let (j0, j1) = super::k::job_range(chunk, k.i(1), k.i(0));
    let ng = g(cnt, 0).max(0) as usize;
    let mut gi = 0usize;
    for j in j0..j1 {
        while gi + 1 < ng && g(grp, (gi + 1) * 6) as usize <= j { gi += 1; }
        let (start, keep) = (g(grp, gi * 6) as usize, g(grp, gi * 6 + 1) as usize);
        if j < start + keep { continue; }
        let q = g(list, j);
        if q < 0 || g(dead, q as usize) != 0 { continue; }
        s(en, q as usize, 0.0); s(dead, q as usize, 1);
    }
}

/// Spatial entries of new units (tch.rs k_spawn_spatial's, chunks of P[16]
/// units of list [0], P[0]): the same columns, the counts by atomic adds.
#[no_mangle]
pub unsafe extern "C" fn k_spawn_spatial_par(a: u32, chunk: i32) {
    use core::sync::atomic::{AtomicI32, Ordering};
    let k = K::new(waddr(a) as *const i32);
    let (list, xs, ys, own, upt, upty, lay, ca) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i8>(3), k.p::<i16>(4), k.p::<i8>(5), k.p::<u8>(6), k.p::<i32>(7));
    let (sptile, sepkey, seplay, sparea, spown, spep, sptype, mvon) = (k.p::<i32>(8), k.p::<u32>(9), k.p::<u8>(10), k.p::<i32>(11), k.p::<i8>(12), k.p::<i32>(13), k.p::<i16>(14), k.p::<u8>(15));
    let (cplx, tcnt, bcnt, dead) = (k.p::<i32>(16), k.p::<i32>(17), k.p::<i32>(18), k.p::<u8>(19));
    if list.is_null() || xs.is_null() || sptile.is_null() { return; }
    let (n, w, h, tl, ep, sch, sbl, nt, np, norm, cw, tb, tbw, bsz, bcols) = (k.i(0), k.i(1).max(1), k.i(2).max(1), k.i(3).max(1), k.i(4), k.i(5), k.i(6), k.i(7), k.i(8), k.i(9), k.i(10).max(1), k.i(11).max(1), k.i(12), k.i(13).max(1), k.i(14));
    let add = |p: *mut i32, i: usize| { (*(p.add(i) as *const AtomicI32)).fetch_add(1, Ordering::Relaxed); };
    let (j0, j1) = super::k::job_range(chunk, k.i(16).max(1), n);
    let l0 = k.i(17).max(0) as usize;
    for i in l0 + j0..l0 + j1 {
        let q = g(list, i);
        if q < 0 { continue; }
        let q = q as usize;
        if !dead.is_null() && g(dead, q) == 1 { continue; }
        let gx = (g(xs, q).div_euclid(tl)).max(0).min(w - 1);
        let gy = (g(ys, q).div_euclid(tl)).max(0).min(h - 1);
        let tile = gy * w + gx;
        let o = g(own, q) as i32;
        let ut = if upt.is_null() { -1 } else { g(upt, q) as i32 };
        let ty0 = if ut >= 0 && !upty.is_null() { g(upty, ut as usize) as i32 } else { -1 };
        let ty = if ty0 >= 0 && ty0 < nt { ty0 } else { norm };
        let ar = if ca.is_null() { -1 } else { g(ca, tile as usize) };
        s(sptile, q, tile); s(sepkey, q, tile as u32);
        if !seplay.is_null() { s(seplay, q, if ty >= 0 && ty < nt && !lay.is_null() { g(lay, ty as usize) } else { 0 }); }
        s(sparea, q, if ar >= 0 { ar } else { -1 }); s(spown, q, o as i8); s(spep, q, ep); s(sptype, q, ty as i16);
        if !mvon.is_null() { s(mvon, q, 0); }
        if !(o >= 0 && o < np) { continue; }
        let key = tile;
        if !cplx.is_null() { add(cplx, (key * sch + o) as usize); }
        let (cx, cy) = (irem(key, cw), idiv(key, cw));
        if !tcnt.is_null() && ty >= 0 { add(tcnt, ((idiv(cy, tb) * tbw + idiv(cx, tb)) * sbl + o * nt + ty) as usize); }
        if !bcnt.is_null() { add(bcnt, ((idiv(cy, bsz) * bcols + idiv(cx, bsz)) * np + o) as usize); }
    }
}

/// Upkeep bins as k_upk_bins, in parallel (chunks of P[4]; counts by atomic adds).
#[no_mangle]
pub unsafe extern "C" fn k_upk_bins_par(a: u32, chunk: i32) {
    use core::sync::atomic::{AtomicI32, Ordering};
    let k = K::new(waddr(a) as *const i32);
    let (list, own, upt, el, ul, bl, sc, upb, cnt) = (k.p::<i32>(0), k.p::<i8>(1), k.p::<i16>(2), k.p::<i8>(3), k.p::<i8>(4), k.p::<i8>(5), k.p::<f32>(6), k.p::<i32>(7), k.p::<i32>(8));
    let (n, np, l1, nc) = (k.i(0), k.i(1).max(1), k.i(2).max(2), k.i(3));
    let add = |i: i32, v: i32| { (*(cnt.add(i as usize) as *const AtomicI32)).fetch_add(v, Ordering::Relaxed); };
    let (j0, j1) = super::k::job_range(chunk, k.i(4).max(1), n);
    let l0 = k.i(5).max(0) as usize;
    for i in l0 + j0..l0 + j1 {
        let q = g(list, i);
        if q < 0 { continue; }
        let q = q as usize;
        let (ow, ty) = (g(own, q) as i32, g(upt, q) as i32);
        let b = if ow < 0 || ow >= np || ty < 0 { -1 } else {
            let mut l = g(el, q) as i32;
            if l <= 0 { l = g(ul, q) as i32; }
            if l <= 0 { l = g(bl, q) as i32; }
            if l <= 0 { let s0 = g(sc, q); l = if s0 == s0 && s0 < f32::INFINITY { let mut v = floor((s0 as f64).max(1.0)) as i64; let mut kk = 0; while v >= 2 { v /= 2; kk += 1; } kk + 1 } else { 1 }; }
            let b = (ty * np + ow) * l1 + l.clamp(1, l1 - 1);
            if b < nc { b } else { -1 }
        };
        let o = g(upb, q);
        if b == o { continue; }
        if o >= 0 && o < nc { add(o, -1); }
        if b >= 0 { add(b, 1); }
        s(upb, q, b);
    }
}

/// A restored staged q / e's births (main.js rzRestore): birth b (P[0], its
/// template bt [0], pos [1]) gets the reserved slot rslot [2][b] (bs [3]) and
/// its row (rows [4], as k_rz_assign writes it: tup [5], tr [6], tcr [7];
/// owner P[3]); entries past the births (P[1]) -1.
#[no_mangle]
pub unsafe extern "C" fn k_rz_rows(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (bt, pos, rslot, bs, rows, tup, tr, tcr) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<f64>(4), k.p::<i32>(5), k.p::<f32>(6), k.p::<f32>(7));
    let (nb, ne, owner, done) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.f(3), k.i(4).max(0) as usize);
    for b in 0..ne {
        let r = rows.add(b * 12);
        if b >= nb { s(bs, b, -1); *r.add(2) = -1.0; continue; }
        if b < done { *r.add(2) = -1.0; continue; }
        let ti = g(bt, b) as usize;
        let sl = g(rslot, b - done);
        s(bs, b, sl);
        *r = sl as f64; *r.add(1) = 0.0; *r.add(2) = 0.0; *r.add(3) = 0.0; *r.add(4) = owner; *r.add(5) = g(tup, ti) as f64;
        *r.add(6) = g(pos, 2 * ti) as f64; *r.add(7) = g(pos, 2 * ti + 1) as f64; *r.add(8) = g(tr, ti) as f64; *r.add(9) = g(tcr, ti) as f64; *r.add(10) = 1.0; *r.add(11) = 0.0;
    }
}
