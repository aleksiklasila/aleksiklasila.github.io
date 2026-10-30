//! Connected regions of the plain ground graph (pathfinding.js
//! getPathRegions): 4-connected regions of tiles that are not walls, labelled
//! by each region's lowest tile index (canonical: the same whatever the bands
//! or the order), and an owner's labels joined through its cloud portals.
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
fn job(chunk: i32, per: i32, n: i32) -> (usize, usize) {
    let a = (chunk.max(0) as i64 * per.max(0) as i64).min(n.max(0) as i64) as usize;
    let b = (a as i64 + per.max(0) as i64).min(n.max(0) as i64) as usize;
    (a, b)
}
/// A label's root (read only: the jobs run side by side).
#[inline(always)]
unsafe fn find(par: *const i32, mut a: i32) -> i32 {
    loop {
        let p = g(par, a as usize);
        if p == a { return a; }
        a = p;
    }
}

/// SIM_KERNEL_REG_LOCAL (a band of P[2] rows a job): the band's tiles
/// labelled by a flood confined to the band, each piece by its lowest tile
/// (reg.par[root] = root); walls -1. Arrays: reg.wall (1 a wall), reg.lab,
/// reg.par, reg.q (a queue: the band's own tile range of it). P: [0] W,
/// [1] H, [2] rows a band.
#[no_mangle]
pub unsafe extern "C" fn k_reg_local(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (wall, lab, par, q) = (k.p::<u8>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3));
    let (w, h, rows) = (k.i(0).max(1), k.i(1).max(0), k.i(2).max(1));
    let (y0, y1) = job(chunk, rows, h);
    if y0 >= y1 { return; }
    let (t0, t1) = (y0 * w as usize, y1 * w as usize);
    for t in t0..t1 { s(lab, t, if g(wall, t) != 0 { -1 } else { -2 }); }
    let wu = w as usize;
    for t in t0..t1 {
        if g(lab, t) != -2 { continue; }
        let root = t as i32;
        s(lab, t, root); s(par, t, root);
        let (mut qh, mut qt) = (t0, t0);
        s(q, qt, root); qt += 1;
        while qh < qt {
            let c = g(q, qh) as usize; qh += 1;
            let x = c % wu;
            if x > 0 && g(lab, c - 1) == -2 { s(lab, c - 1, root); s(q, qt, (c - 1) as i32); qt += 1; }
            if x + 1 < wu && g(lab, c + 1) == -2 { s(lab, c + 1, root); s(q, qt, (c + 1) as i32); qt += 1; }
            if c >= t0 + wu && g(lab, c - wu) == -2 { s(lab, c - wu, root); s(q, qt, (c - wu) as i32); qt += 1; }
            if c + wu < t1 && g(lab, c + wu) == -2 { s(lab, c + wu, root); s(q, qt, (c + wu) as i32); qt += 1; }
        }
    }
}

/// SIM_KERNEL_REG_MERGE (one job): the bands' pieces joined across the rows
/// where bands meet (the lower root wins). Arrays: reg.lab, reg.par. P: [0]
/// W, [1] H, [2] rows a band.
#[no_mangle]
pub unsafe extern "C" fn k_reg_merge(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (lab, par) = (k.p::<i32>(1), k.p::<i32>(2));
    let (w, h, rows) = (k.i(0).max(1) as usize, k.i(1).max(0) as usize, k.i(2).max(1) as usize);
    let mut y = rows;
    while y < h {
        for x in 0..w {
            let (t, u) = (y * w + x, (y - 1) * w + x);
            let (lt, lu) = (g(lab, t), g(lab, u));
            if lt < 0 || lu < 0 { continue; }
            // (Path halving: this job alone writes the parents.)
            let mut ra = lt;
            while g(par, ra as usize) != ra { let p = g(par, g(par, ra as usize) as usize); s(par, ra as usize, p); ra = p; }
            let mut rb = lu;
            while g(par, rb as usize) != rb { let p = g(par, g(par, rb as usize) as usize); s(par, rb as usize, p); rb = p; }
            if ra != rb { if ra < rb { s(par, rb as usize, ra); } else { s(par, ra as usize, rb); } }
        }
        y += rows;
    }
}

/// SIM_KERNEL_REG_FINAL (P[1] tiles a job): every label its region's root.
/// Arrays: reg.lab, reg.par. P: [0] tiles, [1] per job.
#[no_mangle]
pub unsafe extern "C" fn k_reg_final(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (lab, par) = (k.p::<i32>(1), k.p::<i32>(2));
    let (t0, t1) = job(chunk, k.i(1), k.i(0));
    for t in t0..t1 {
        let l = g(lab, t);
        if l >= 0 { s(lab, t, find(par, l)); }
    }
}

/// SIM_KERNEL_REG_IDENT (P[1] a job): reg.opar[i] = i for i < P[0] (an
/// owner's parents before its portal joins).
#[no_mangle]
pub unsafe extern "C" fn k_reg_ident(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let op = k.p::<i32>(4);
    let (i0, i1) = job(chunk, k.i(1), k.i(0));
    for i in i0..i1 { s(op, i, i as i32); }
}

/// SIM_KERNEL_REG_OWNER (P[1] tiles a job): an owner's labels from the plain
/// ones: each plain label's root (reg.par), then its root among the owner's
/// joins (reg.opar), into reg.olab; walls -1 (its portal tiles are set by
/// the JavaScript after). Arrays: reg.lab, reg.par, reg.opar, reg.olab. P:
/// [0] tiles, [1] per job.
#[no_mangle]
pub unsafe extern "C" fn k_reg_owner(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (lab, par, op, ol) = (k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(4), k.p::<i32>(5));
    let (t0, t1) = job(chunk, k.i(1), k.i(0));
    for t in t0..t1 {
        let l = g(lab, t);
        s(ol, t, if l < 0 { -1 } else { find(op, find(par, l)) });
    }
}

/// The live cloud portals' signature (pathfinding.js
/// _pathRegionPortalSignature): over the cloud tiles (reg.cloud[0..P[0]], in
/// the cloud cache's order) alive (st.val > 0) and built (st.uc 0), the
/// running hash of tile and owner (st.own). Out: reg.sig[0].
#[no_mangle]
pub unsafe extern "C" fn k_reg_portal_sig(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (cl, val, uc, own, out) = (k.p::<i32>(0), k.p::<f64>(1), k.p::<u8>(2), k.p::<i32>(3), k.p::<i32>(4));
    let n = k.i(0).max(0) as usize;
    let mut sig = 0i32;
    for i in 0..n {
        let t = g(cl, i);
        if t < 0 { continue; }
        let tu = t as usize;
        if !(g(val, tu) > 0.0) || g(uc, tu) != 0 { continue; }
        sig = ((sig ^ (t + 1)).wrapping_mul(16777619)).wrapping_add(g(own, tu) + 3);
    }
    s(out, 0, sig);
}

/// The tiles holding a tabled structure or mine (st.ctab not 0), in tile
/// order, into out (the occupied tiles: data_state.js _activeTileEntities'
/// iteration), at most P[1] of them; the count at cnt[0]. P: [0] tiles, [1]
/// room.
#[no_mangle]
pub unsafe extern "C" fn k_tile_occupied(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ctab, out, cnt) = (k.p::<u8>(0), k.p::<i32>(1), k.p::<i32>(2));
    let (n, room) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize);
    let mut m = 0usize;
    let mut t = 0usize;
    // (Sixteen tiles a compare: most are empty.)
    while t + 16 <= n {
        let mut bits = !(i8x16_bitmask(i8x16_eq(v128_load(ctab.add(t) as *const v128), i8x16_splat(0))) as u32) & 0xffff;
        while bits != 0 { let u = t + bits.trailing_zeros() as usize; bits &= bits - 1; if m < room { s(out, m, u as i32); m += 1; } }
        t += 16;
    }
    while t < n { if g(ctab, t) != 0 && m < room { s(out, m, t as i32); m += 1; } t += 1; }
    s(cnt, 0, m as i32);
}
