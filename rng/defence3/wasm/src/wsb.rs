//! The worker search tier's collector groups (worker.js _wsPost): the tile
//! mirror the groups are made of (k_ws_mirror, on the simulation thread at a
//! post: the tiles changed since the last one), and the groups made from it
//! on the search lane (k_ws_gbuild, the first stages of its chain): the sites
//! and spawners in tile order, counted into buckets of WS_BUCKET tiles and
//! listed by bucket (counting sorts), the spawners' per-owner counts, the
//! nearest-spawner fields' slots.
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
fn clampi(v: f64, hi: i32) -> i32 {
    // (As Math.max(0, Math.min(hi, Math.floor(v))).)
    let f = floor(v);
    if !(f < hi as f64) { hi } else if !(f > 0.0) { 0 } else { f as i32 }
}

/// A tile's mirror word, what the collectors' groups are made of (data_state.js
/// _ST): bits 0-15 the stationary type (the descriptor's low 16 bits: type + 1;
/// floor items and spawners), 16-18 the kind (1 a spawner 0x44, 2 a floor item
/// 0x55, 3 / 4 a gold / astar mine 0x66 / 0x77), 19 under construction, 24-31
/// the owner (i8; -128 none); 0 for anything else. Its energy is not in it: a
/// structure leaves the table when it runs out (mines in the take's pass,
/// OUT_MINE_GONE), and a word made of journaled fields alone is the same on a
/// peer that made its mirror whole at a restore.
#[inline(always)]
unsafe fn wsm_word(code: *const u8, own: *const i32, uc: *const u8, brain: *const i32, t: usize, none: i32) -> u32 {
    let kind = match g(code, t) { 0x44 => 1u32, 0x55 => 2, 0x66 => 3, 0x77 => 4, _ => return 0 };
    let o = g(own, t);
    let ob = if o == none || o < -127 || o > 127 { -128i32 } else { o };
    let ty = if kind <= 2 { (g(brain, t) & 0xffff) as u32 } else { 0 };
    ty | (kind << 16) | (((g(uc, t) != 0) as u32) << 19) | (((ob as u8) as u32) << 24)
}
/// What a mirror word is to group config (mine kind, farm type + 1, spawner
/// type + 1; 0 none): 1 a site, 2 a spawner, 0 neither.
#[inline(always)]
fn wsm_class(w: u32, mk: i32, fa: i32, sp: i32) -> u32 {
    if w == 0 { return 0; }
    let (kind, ty) = (((w >> 16) & 7) as i32, (w & 0xffff) as i32);
    if kind == mk || (kind == 2 && fa != 0 && ty == fa) { 1 } else if kind == 1 && sp != 0 && ty == sp { 2 } else { 0 }
}
#[inline(always)]
unsafe fn wsm_groups(w: u32, cfg: *const i32, ng: usize) -> u32 {
    let mut m = 0u32;
    if w == 0 { return 0; }
    for gi in 0..ng {
        if wsm_class(w, g(cfg, 3 * gi), g(cfg, 3 * gi + 1), g(cfg, 3 * gi + 2)) != 0 { m |= 1 << gi; }
    }
    m
}

/// k_ws_mirror (direct, at a search post): the journaled tiles' mirror words
/// from the structure table (their flags cleared), and which groups changed
/// (out[0], bit g: a tile's word whose old or new self is the group's).
/// P[0] < 0: every tile (a new mirror), every group changed.
/// Arrays: [0] journal (tiles), [1] its flags (a byte a tile), st.code,
/// st.own, st.uc, st.brain, [6] mirror, [7] cfg (3 a group: mine kind 3 / 4,
/// farm type + 1, spawner type + 1), [8] out, [9] the groups' counts (2 a group: sites, spawners; kept as
/// tiles change, counted whole with the mirror).
/// P: [0] journaled tiles (-1 all), [1] tiles, [2] groups, [3] no owner.
#[no_mangle]
pub unsafe extern "C" fn k_ws_mirror(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (list, flag, code, own, uc, brain) = (k.p::<i32>(0), k.p::<u8>(1), k.p::<u8>(2), k.p::<i32>(3), k.p::<u8>(4), k.p::<i32>(5));
    let (mir, cfg, out, gc) = (k.p::<u32>(6), k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9));
    let (n, tiles, ng, none) = (k.i(0), k.i(1).max(0) as usize, k.i(2).max(0).min(8) as usize, k.i(3));
    let mut dirty = 0u32;
    // (A word's part in the groups' counts: d = 1 added, -1 taken.)
    let count = |w: u32, d: i32| {
        if gc.is_null() || w == 0 { return; }
        for gi in 0..ng {
            let c = wsm_class(w, g(cfg, 3 * gi), g(cfg, 3 * gi + 1), g(cfg, 3 * gi + 2));
            if c != 0 { let j = 2 * gi + (c as usize - 1); s(gc, j, g(gc, j) + d); }
        }
    };
    if n < 0 {
        if !gc.is_null() { for j in 0..16 { s(gc, j, 0); } }
        let z = i32x4_splat(0);
        let mut t = 0usize;
        while t < tiles {
            if code.is_null() || (t + 16 <= tiles && !v128_any_true(v128_load(code.add(t) as *const v128))) {
                if t + 16 <= tiles { for j in 0..4 { v128_store(mir.add(t + 4 * j) as *mut v128, z); } t += 16; } else { s(mir, t, 0); t += 1; }
                continue;
            }
            let w = wsm_word(code, own, uc, brain, t, none);
            s(mir, t, w); count(w, 1);
            t += 1;
        }
        if !flag.is_null() { for t in 0..tiles { s(flag, t, 0); } }
        dirty = (1u32 << ng) - 1;
    } else if !code.is_null() {
        for i in 0..n as usize {
            let t = g(list, i);
            if t < 0 || t as usize >= tiles { continue; }
            let tu = t as usize;
            s(flag, tu, 0);
            let (w0, w1) = (g(mir, tu), wsm_word(code, own, uc, brain, tu, none));
            if w0 != w1 {
                dirty |= wsm_groups(w0, cfg, ng) | wsm_groups(w1, cfg, ng);
                count(w0, -1); count(w1, 1);
                s(mir, tu, w1);
            }
        }
    }
    s(out, 0, dirty as i32);
}

/// SIM_KERNEL_WS_GROUP (k_ws_gbuild, the search lane's first stages): one
/// collectors' group made from the mirror. Mode 1 (a job a stretch of P[5]
/// tiles, P[6] jobs a group, job c: group P[16 + c / P[6]], stretch c % P[6]):
/// its sites and spawners counted (cc[2 j], cc[2 j + 1]); 2: written from the
/// stretches' starts (the counts of those before it), in tile order; 3 (a job
/// a group): the totals, the buckets, the spawners by bucket and back, the
/// field slots. Sites: mines of the group's kind (kind 1, no owner), floor
/// items of its farm type (kind 2, their owner, P[4] under construction);
/// spawners of its spawner type: tile, owner (-9 none), id (their tile),
/// centre, P[4] under construction. Centres of P[3]-px tiles.
/// Arrays: [0] mirror, [1] cfg, [2] cc, then sx, sy, st, so, sready, tile,
/// qgx, qgy, qo, qid, qx, qy, qready (tile order), bs, bc, bi (by bucket),
/// pgx, pgy, po, pid, px, py, pready (bucket order), qp (tile order ->
/// bucket order), sbk, meta (5 + 2 b a bucket's first, 6 + 2 b its count;
/// 5 + 2 nb + owner the owner's count (16), 5 + 2 nb + 16 + owner its field
/// slot or -1; [0] sites, [1] spawners, [2] 1, [3] columns, [4] rows), rk
/// (place in tile order -> bucket order), ro (its inverse), bki (each site's
/// bucket), gst ([0] sites, [1] spawners, [2] 1 when past the room).
/// P: [0] mode, [1] tiles, [2] width, [3] tile px, [4] not built, [5] tiles a
/// job, [6] jobs a group, [7] / [8] room for sites / spawners, [9] / [10]
/// bucket columns / rows, [11] WS_BUCKET, [12] field slots (owners 0 .. P[12]
/// - 1), [13] groups listed, [16 + i] their ids.
#[no_mangle]
pub unsafe extern "C" fn k_ws_gbuild(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (mir, cfg, cc) = (k.p::<u32>(0), k.p::<i32>(1), k.p::<i32>(2));
    let (mode, tiles, w, tile, nb_) = (k.i(0), k.i(1).max(0) as usize, k.i(2).max(1) as usize, k.f(3) as f32, k.i(4));
    let (per, jobs, caps, capp) = (k.i(5).max(1) as usize, k.i(6).max(1) as usize, k.i(7).max(0) as usize, k.i(8).max(0) as usize);
    let c = chunk.max(0) as usize;
    let gi = if mode == 3 { c } else { c / jobs };
    if gi >= k.i(13).max(0) as usize || mir.is_null() || cc.is_null() { return; }
    let gid = k.i(16 + gi).max(0).min(7) as usize;
    let (mk, fa, sp) = (g(cfg, 3 * gid), g(cfg, 3 * gid + 1), g(cfg, 3 * gid + 2));
    if mode == 1 || mode == 2 {
        let j = c % jobs;
        let t0 = (j * per).min(tiles);
        let t1 = (t0 + per).min(tiles);
        let (mut ns, mut np) = (0usize, 0usize);
        if mode == 2 { for jj in 0..j { ns += g(cc, 2 * jj) as usize; np += g(cc, 2 * jj + 1) as usize; } }
        let (sx, sy, st, so, sr, tl) = (k.p::<f32>(3), k.p::<f32>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8));
        let (qgx, qgy, qo, qid, qx, qy, qr) = (k.p::<i32>(9), k.p::<i32>(10), k.p::<i32>(11), k.p::<i32>(12), k.p::<f32>(13), k.p::<f32>(14), k.p::<i32>(15));
        let write = mode == 2;
        let mut t = t0;
        while t < t1 {
            if t + 16 <= t1 {
                let v = v128_or(v128_or(v128_load(mir.add(t) as *const v128), v128_load(mir.add(t + 4) as *const v128)),
                    v128_or(v128_load(mir.add(t + 8) as *const v128), v128_load(mir.add(t + 12) as *const v128)));
                if !v128_any_true(v) { t += 16; continue; }
            }
            let wd = g(mir, t);
            let cl = wsm_class(wd, mk, fa, sp);
            if cl != 0 {
                if write {
                    let (gx, gy) = ((t % w) as i32, (t / w) as i32);
                    let (cx, cy) = (gx as f32 * tile + tile * 0.5, gy as f32 * tile + tile * 0.5);
                    let o = ((wd >> 24) as u8) as i8 as i32;
                    let ucb = (wd >> 19) & 1 != 0;
                    if cl == 1 {
                        if ns < caps {
                            let mine = ((wd >> 16) & 7) >= 3;
                            s(sx, ns, cx); s(sy, ns, cy); s(st, ns, if mine { 1 } else { 2 });
                            s(so, ns, if mine || o == -128 { -1 } else { o }); s(sr, ns, if !mine && ucb { nb_ } else { 0 }); s(tl, ns, t as i32);
                        }
                    } else if np < capp {
                        s(qgx, np, gx); s(qgy, np, gy); s(qo, np, if o == -128 { -9 } else { o }); s(qid, np, t as i32);
                        s(qx, np, cx); s(qy, np, cy); s(qr, np, if ucb { nb_ } else { 0 });
                    }
                }
                if cl == 1 { ns += 1; } else { np += 1; }
            }
            t += 1;
        }
        if mode == 1 { s(cc, 2 * j, ns as i32); s(cc, 2 * j + 1, np as i32); }
        return;
    }
    if mode != 3 { return; }
    // The totals (the room is the match's structure rows: never past it).
    let (mut ts, mut tp) = (0usize, 0usize);
    for jj in 0..jobs { ts += g(cc, 2 * jj) as usize; tp += g(cc, 2 * jj + 1) as usize; }
    let gst = k.p::<i32>(32);
    let (cap, np) = (ts.min(caps), tp.min(capp));
    s(gst, 0, cap as i32); s(gst, 1, np as i32); s(gst, 2, (ts > caps || tp > capp) as i32);
    let (sx, sy) = (k.p::<f32>(3), k.p::<f32>(4));
    let (qgx, qgy, qo, qid, qx, qy, qr) = (k.p::<i32>(9), k.p::<i32>(10), k.p::<i32>(11), k.p::<i32>(12), k.p::<f32>(13), k.p::<f32>(14), k.p::<i32>(15));
    let (bs, bc, bi) = (k.p::<i32>(16), k.p::<i32>(17), k.p::<i32>(18));
    let (pgx, pgy, po, pid, px, py, pr, qp, sbk, meta) = (k.p::<i32>(19), k.p::<i32>(20), k.p::<i32>(21), k.p::<i32>(22), k.p::<f32>(23), k.p::<f32>(24), k.p::<i32>(25), k.p::<i32>(26), k.p::<i32>(27), k.p::<i32>(28));
    let (rk, ro, bki) = (k.p::<i32>(29), k.p::<i32>(30), k.p::<i32>(31));
    let (bcols, brows, wsb) = (k.i(9), k.i(10), k.f(11));
    let nb = (bcols * brows).max(0) as usize;
    let tf = tile as f64;
    // The sites by bucket (each site's bucket once, bki).
    for b in 0..nb { s(bc, b, 0); }
    for i in 0..cap {
        let by = clampi(g(sy, i) as f64 / tf / wsb, brows - 1);
        let bx = clampi(g(sx, i) as f64 / tf / wsb, bcols - 1);
        let b = (by * bcols + bx) as usize;
        s(bki, i, b as i32);
        s(bc, b, g(bc, b) + 1);
    }
    let mut fill = 0;
    for b in 0..nb { s(bs, b, fill); fill += g(bc, b); s(bc, b, 0); }
    for i in 0..cap {
        let b = g(bki, i) as usize;
        let c = g(bc, b);
        s(bi, (g(bs, b) + c) as usize, i as i32);
        s(bc, b, c + 1);
    }
    // The spawners by bucket, the owners' counts.
    let mlen = 5 + 2 * nb + 32;
    for i in 0..mlen { s(meta, i, 0); }
    let wsbi = wsb as i32;
    for q in 0..np {
        let by = clampi(idiv(g(qgy, q), wsbi) as f64, brows - 1);
        let bx = clampi(idiv(g(qgx, q), wsbi) as f64, bcols - 1);
        let b = (by * bcols + bx) as usize;
        s(sbk, q, b as i32);
        s(meta, 6 + 2 * b, g(meta, 6 + 2 * b) + 1);
        let o = g(qo, q);
        if o >= 0 && o < 16 { s(meta, 5 + 2 * nb + o as usize, g(meta, 5 + 2 * nb + o as usize) + 1); }
    }
    let mut at = 0;
    for b in 0..nb { s(meta, 5 + 2 * b, at); at += g(meta, 6 + 2 * b); s(meta, 6 + 2 * b, 0); }
    for kk in 0..np {
        let b = g(sbk, kk) as usize;
        let q = (g(meta, 5 + 2 * b) + g(meta, 6 + 2 * b)) as usize;
        s(meta, 6 + 2 * b, g(meta, 6 + 2 * b) + 1);
        s(pgx, q, g(qgx, kk)); s(pgy, q, g(qgy, kk)); s(po, q, g(qo, kk)); s(pid, q, g(qid, kk));
        s(px, q, g(qx, kk)); s(py, q, g(qy, kk)); s(pr, q, g(qr, kk)); s(qp, kk, q as i32);
    }
    // The spawners in tile order (the q arrays') and back.
    for r in 0..np { let q = g(qp, r); s(rk, r, q); s(ro, q as usize, r as i32); }
    // Each owner's field slot: its own (owners 0 .. P[12] - 1; none past
    // 65535 spawners, the fields' rank limit). An owner without spawners of
    // the group has its slot unused (the scan looks at a field only for an
    // owner with some).
    let slots = if np <= 65535 { k.i(12).max(0).min(16) } else { 0 };
    for o in 0..16i32 { s(meta, 5 + 2 * nb + 16 + o as usize, if o < slots { o } else { -1 }); }
    s(meta, 0, cap as i32);
    s(meta, 1, np as i32);
    s(meta, 2, 1);
    s(meta, 3, bcols);
    s(meta, 4, brows);
}
