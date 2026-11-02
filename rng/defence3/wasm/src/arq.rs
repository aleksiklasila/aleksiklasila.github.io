//! Area range queries (SIMD_AREA_RANGE_QUERIES_PLAN.md): the areas packed
//! in blocks of 16, each block with its areas' hop distances confined to
//! it (16 x 16 bytes, 255 none), the edges between blocks as CSR over the
//! areas' internal ids (block * 16 + lane). Made once per map layout
//! (k_arq_build, at the match's start or a whole restore: areas never
//! change in play), so its memory is fixed: ~25 bytes an area, and a
//! query context per thread (~21 bytes a block).
//!
//! A query is a search by distance level over blocks: an area reached at
//! distance d relaxes its whole block at once (d + its row, one saturated
//! add and min of 16 bytes) and its cross edges at d + 1. Exact: every
//! path is block-confined segments joined by cross edges. Areas come out
//! level by level, each level in the order its blocks were first reached
//! (deterministic: no thread or timing in it).
//!
//! The header (arq.hdr, unit.js areaRangeIndex): encoded addresses of
//! [0] blk (area -> internal id), [1] inv (internal id -> area, -1),
//! [2] d (blocks * 256), [3] xoff (blocks * 16 + 1), [4] xnb (internal
//! ids), [5] ctx (the threads' contexts), [6] bounds (area x0 y0 x1 y1);
//! then [8] blocks, [9] areas, [10] the largest area's extent in tiles,
//! [11] a context's bytes, [12] contexts. A thread's context is its slot's
//! (the argument block's word 1002: 0 the simulation thread, helper i + 1),
//! its own memory: no other kernel writes it, and every query leaves it
//! clean (its blocks' distances 255, their marks 0).
use super::*;

pub const ARQ_HDR_WORDS: usize = 16;

pub struct Arq {
    blk: *const i32,
    inv: *const i32,
    d: *const u8,
    xoff: *const i32,
    xnb: *const i32,
    pub bounds: *const i32,
    pub na: usize,
    pub nbk: usize,
    pub emax: i32,
    best: *mut u8,
    mark: *mut u8,
    touched: *mut i32,
    nt: usize,
}

impl Arq {
    /// The index and this thread's context (arg: the kernel's argument
    /// block), or None when there is none (no map yet, or no context for
    /// this thread's slot).
    #[inline]
    pub unsafe fn new(hdr: *const i32, arg: *const i32) -> Option<Arq> {
        if hdr.is_null() || *hdr.add(8) <= 0 {
            return None;
        }
        let slot = *arg.add(1002);
        let (stride, nctx) = (*hdr.add(11) as usize, *hdr.add(12));
        if slot < 0 || slot >= nctx {
            return None;
        }
        let nbk = *hdr.add(8) as usize;
        let ctx = (waddr(*hdr.add(5) as u32) + slot as usize * stride) as *mut u8;
        Some(Arq {
            blk: waddr(*hdr as u32) as *const i32,
            inv: waddr(*hdr.add(1) as u32) as *const i32,
            d: waddr(*hdr.add(2) as u32) as *const u8,
            xoff: waddr(*hdr.add(3) as u32) as *const i32,
            xnb: waddr(*hdr.add(4) as u32) as *const i32,
            bounds: waddr(*hdr.add(6) as u32) as *const i32,
            na: *hdr.add(9) as usize,
            nbk,
            emax: (*hdr.add(10)).max(1),
            best: ctx,
            mark: ctx.add(nbk * 16),
            touched: ctx.add(nbk * 17 + ((16 - (nbk * 17) % 16) % 16)) as *mut i32,
            nt: 0,
        })
    }
    /// A context's bytes for nbk blocks (as Arq::new lays it out).
    pub fn ctx_bytes(nbk: usize) -> usize {
        let a = nbk * 17;
        let a = a + (16 - a % 16) % 16;
        let b = a + nbk * 4;
        b + (16 - b % 16) % 16
    }
    #[inline(always)]
    unsafe fn relax(&mut self, i: usize, dist: u8) {
        let b = i >> 4;
        let p = self.best.add(b << 4);
        if *p.add(i & 15) <= dist {
            return;
        }
        if *self.mark.add(b) == 0 {
            *self.mark.add(b) = 1;
            *self.touched.add(self.nt) = b as i32;
            self.nt += 1;
        }
        let row = v128_load(self.d.add((b << 8) + ((i & 15) << 4)) as *const v128);
        v128_store(p as *mut v128, u8x16_min(v128_load(p as *const v128), u8x16_add_sat(u8x16_splat(dist), row)));
    }
    #[inline(always)]
    unsafe fn clean(&mut self) {
        let inf = u8x16_splat(255);
        for j in 0..self.nt {
            let b = *self.touched.add(j) as usize;
            v128_store(self.best.add(b << 4) as *mut v128, inf);
            *self.mark.add(b) = 0;
        }
        self.nt = 0;
    }
    #[inline(always)]
    unsafe fn seed(&mut self, src: &[i32]) {
        for &a in src {
            if a >= 0 && (a as usize) < self.na {
                let i = *self.blk.add(a as usize);
                if i >= 0 {
                    self.relax(i as usize, 0);
                }
            }
        }
    }
    /// Every area within r hops of any of src, nearest level first:
    /// f(area, hops) for each; true from f stops the search.
    pub unsafe fn each<F: FnMut(i32, i32) -> bool>(&mut self, src: &[i32], r: i32, mut f: F) {
        self.seed(src);
        let r = r.min(250);
        let mut d = 0i32;
        while d <= r {
            let mut j = 0usize;
            let mut any = false;
            while j < self.nt {
                let b = *self.touched.add(j) as usize;
                j += 1;
                let v = v128_load(self.best.add(b << 4) as *const v128);
                let mut m = u8x16_bitmask(u8x16_eq(v, u8x16_splat(d as u8))) as u32;
                if m == 0 {
                    continue;
                }
                any = true;
                while m != 0 {
                    let l = m.trailing_zeros() as usize;
                    m &= m - 1;
                    let i = (b << 4) | l;
                    if f(*self.inv.add(i), d) {
                        self.clean();
                        return;
                    }
                    if d < r {
                        for e in *self.xoff.add(i)..*self.xoff.add(i + 1) {
                            self.relax(*self.xnb.add(e as usize) as usize, (d + 1) as u8);
                        }
                    }
                }
            }
            // (No area at this level: none further either.)
            if !any && !self.pending(d) {
                break;
            }
            d += 1;
        }
        self.clean();
    }
    /// Whether any touched area waits at a level past d.
    #[inline(always)]
    unsafe fn pending(&self, d: i32) -> bool {
        let lim = u8x16_splat((d.min(254)) as u8);
        for j in 0..self.nt {
            let b = *self.touched.add(j) as usize;
            let v = v128_load(self.best.add(b << 4) as *const v128);
            // (lanes in (d, 255): above d and not none)
            let m = v128_and(u8x16_gt(v, lim), u8x16_ne(v, u8x16_splat(255)));
            if v128_any_true(m) {
                return true;
            }
        }
        false
    }
    /// The tile box an area's r-hop reach lies in: its bounds grown by
    /// r times the largest area's extent (each hop crosses at most one
    /// area), clamped to the map (w, h). x1 < 0: no area.
    pub unsafe fn reach_box(&self, area: i32, r: i32, w: i32, h: i32) -> [i32; 4] {
        if area < 0 || area as usize >= self.na || self.bounds.is_null() {
            return [0, 0, -1, -1];
        }
        let b = self.bounds.add(area as usize * 4);
        let g = r.max(0) * self.emax;
        [(*b - g).max(0), (*b.add(1) - g).max(0), (*b.add(2) + g).min(w - 1), (*b.add(3) + g).min(h - 1)]
    }
    /// Whether any area of tgt is within k hops of any area of src.
    /// First the cheap bounds: the same area; the same block within k
    /// (its confined distance is a real path: an upper bound); every pair
    /// further apart in tiles than k hops can span (lower bound). Then the
    /// search, stopped at the first target within k.
    pub unsafe fn within(&mut self, src: &[i32], tgt: &[i32], k: i32) -> bool {
        if k < 0 {
            return false;
        }
        let mut far = true;
        for &s in src {
            if s < 0 || s as usize >= self.na {
                continue;
            }
            let is = *self.blk.add(s as usize);
            for &t in tgt {
                if t < 0 || t as usize >= self.na {
                    continue;
                }
                if s == t {
                    return true;
                }
                let it = *self.blk.add(t as usize);
                if is >= 0 && it >= 0 && (is >> 4) == (it >> 4) && (*self.d.add(((is as usize >> 4) << 8) + ((is as usize & 15) << 4) + (it as usize & 15)) as i32) <= k {
                    return true;
                }
                if far && !self.bounds.is_null() {
                    let a = self.bounds.add(s as usize * 4);
                    let b = self.bounds.add(t as usize * 4);
                    let gx = (*b - *a.add(2)).max(*a - *b.add(2)).max(0);
                    let gy = (*b.add(1) - *a.add(3)).max(*a.add(1) - *b.add(3)).max(0);
                    if gx.max(gy) <= k * self.emax {
                        far = false;
                    }
                } else {
                    far = false;
                }
            }
        }
        if far || k == 0 {
            return false;
        }
        self.seed(src);
        let hit = |me: &Arq| -> bool {
            for &t in tgt {
                if t >= 0 && (t as usize) < me.na {
                    let it = *me.blk.add(t as usize);
                    if it >= 0 && (*me.best.add(it as usize) as i32) <= k {
                        return true;
                    }
                }
            }
            false
        };
        if hit(self) {
            self.clean();
            return true;
        }
        let mut d = 0i32;
        while d < k {
            let mut j = 0usize;
            let mut any = false;
            while j < self.nt {
                let b = *self.touched.add(j) as usize;
                j += 1;
                let v = v128_load(self.best.add(b << 4) as *const v128);
                let mut m = u8x16_bitmask(u8x16_eq(v, u8x16_splat(d as u8))) as u32;
                while m != 0 {
                    any = true;
                    let l = m.trailing_zeros() as usize;
                    m &= m - 1;
                    let i = (b << 4) | l;
                    for e in *self.xoff.add(i)..*self.xoff.add(i + 1) {
                        self.relax(*self.xnb.add(e as usize) as usize, (d + 1) as u8);
                    }
                }
            }
            if hit(self) {
                self.clean();
                return true;
            }
            if !any && !self.pending(d) {
                break;
            }
            d += 1;
        }
        self.clean();
        false
    }
}

/// The index's build (unit.js areaRangeIndexBuild), P[0] the mode:
/// 0 (serial): the blocks: areas packed by growth from each unassigned area
///   in id order, adding the candidate with the most edges into the block
///   (ties: the lower id) while it has fewer than 16; blk[a] = its internal
///   id. meta[0] blocks, [1] the largest extent, [2] cross edges.
/// 1 (serial): inv, xoff and xnb.
/// 2 (P[1] blocks a job): each block's matrix (breadth first inside it).
/// Arrays: 0 area.off, 1 area.nb, 2 blk, 3 inv, 4 d, 5 xoff, 6 xnb, 7 meta,
/// 8 area.bounds, 9 tmp (3 * areas words). P[2] areas.
#[no_mangle]
pub unsafe extern "C" fn k_arq_build(a: u32, chunk: i32) {
    let k = super::k::K::new(waddr(a) as *const i32);
    let (off, nb, blk, inv, d, xoff, xnb, meta, bounds, tmp) =
        (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<u8>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9));
    let na = k.i(2).max(0) as usize;
    match k.i(0) {
        0 => {
            let (stamp, cnt, cand) = (tmp, tmp.add(na), tmp.add(2 * na));
            for i in 0..na {
                *blk.add(i) = -1;
                *stamp.add(i) = -1;
            }
            let mut nbk = 0i32;
            for seed in 0..na {
                if *blk.add(seed) >= 0 {
                    continue;
                }
                let bid = nbk;
                nbk += 1;
                let mut members = 0i32;
                let mut nc = 0usize;
                let mut add = seed;
                loop {
                    *blk.add(add) = bid * 16 + members;
                    members += 1;
                    for e in *off.add(add)..*off.add(add + 1) {
                        let n = *nb.add(e as usize);
                        if n < 0 || n as usize >= na || *blk.add(n as usize) >= 0 {
                            continue;
                        }
                        let n = n as usize;
                        if *stamp.add(n) != bid {
                            *stamp.add(n) = bid;
                            *cnt.add(n) = 0;
                            *cand.add(nc) = n as i32;
                            nc += 1;
                        }
                        *cnt.add(n) += 1;
                    }
                    if members >= 16 {
                        break;
                    }
                    let (mut pick, mut pc, mut pj) = (usize::MAX, -1i32, 0usize);
                    let mut j = 0usize;
                    while j < nc {
                        let c = *cand.add(j) as usize;
                        if *blk.add(c) >= 0 {
                            nc -= 1;
                            *cand.add(j) = *cand.add(nc);
                            continue;
                        }
                        let v = *cnt.add(c);
                        if v > pc || (v == pc && c < pick) {
                            pick = c;
                            pc = v;
                            pj = j;
                        }
                        j += 1;
                    }
                    if pick == usize::MAX {
                        break;
                    }
                    nc -= 1;
                    *cand.add(pj) = *cand.add(nc);
                    add = pick;
                }
            }
            let mut emax = 1i32;
            if !bounds.is_null() {
                for i in 0..na {
                    let b = bounds.add(i * 4);
                    if *b.add(2) >= *b {
                        emax = emax.max(*b.add(2) - *b + 1).max(*b.add(3) - *b.add(1) + 1);
                    }
                }
            }
            let mut cross = 0i32;
            for i in 0..na {
                for e in *off.add(i)..*off.add(i + 1) {
                    let n = *nb.add(e as usize);
                    if n >= 0 && (n as usize) < na && (*blk.add(n as usize) >> 4) != (*blk.add(i) >> 4) {
                        cross += 1;
                    }
                }
            }
            *meta = nbk;
            *meta.add(1) = emax;
            *meta.add(2) = cross;
        }
        1 => {
            let nbk = *meta as usize;
            for i in 0..nbk * 16 {
                *inv.add(i) = -1;
            }
            for i in 0..na {
                *inv.add(*blk.add(i) as usize) = i as i32;
            }
            let mut q = 0i32;
            for i in 0..nbk * 16 {
                *xoff.add(i) = q;
                let ar = *inv.add(i);
                if ar < 0 {
                    continue;
                }
                let bi = *blk.add(ar as usize) >> 4;
                for e in *off.add(ar as usize)..*off.add(ar as usize + 1) {
                    let n = *nb.add(e as usize);
                    if n < 0 || n as usize >= na {
                        continue;
                    }
                    let ni = *blk.add(n as usize);
                    if (ni >> 4) != bi {
                        *xnb.add(q as usize) = ni;
                        q += 1;
                    }
                }
            }
            *xoff.add(nbk * 16) = q;
        }
        _ => {
            let nbk = *meta as usize;
            let per = k.i(1).max(1) as usize;
            let b0 = chunk as usize * per;
            for b in b0..(b0 + per).min(nbk) {
                let m = d.add(b << 8);
                for x in 0..256 {
                    *m.add(x) = 255;
                }
                for l in 0..16usize {
                    let ar = *inv.add((b << 4) | l);
                    if ar < 0 {
                        continue;
                    }
                    let row = m.add(l << 4);
                    *row.add(l) = 0;
                    let mut q = [0u8; 16];
                    *q.get_unchecked_mut(0) = l as u8;
                    let (mut h, mut t) = (0usize, 1usize);
                    while h < t {
                        let u = *q.get_unchecked(h) as usize;
                        h += 1;
                        let au = *inv.add((b << 4) | u) as usize;
                        let du = *row.add(u);
                        for e in *off.add(au)..*off.add(au + 1) {
                            let n = *nb.add(e as usize);
                            if n < 0 || n as usize >= na {
                                continue;
                            }
                            let ni = *blk.add(n as usize);
                            if (ni >> 4) as usize != b {
                                continue;
                            }
                            let v = (ni & 15) as usize;
                            if *row.add(v) == 255 {
                                *row.add(v) = du + 1;
                                *q.get_unchecked_mut(t) = v as u8;
                                t += 1;
                            }
                        }
                    }
                }
            }
        }
    }
}

/// One query from the JavaScript (data_state.js _areaQuery), on the calling
/// thread's context. Arrays: 0 arq.hdr, 1 areas (P[1] sources, then P[2]
/// targets), 2 out. P[0] the mode: 0 out[0] = 1 when a target is within
/// P[3] hops of a source; 1 the areas within P[3] hops, nearest first:
/// out[0] their count, out[1..] the areas (at most P[4]); 2 their tiles' box
/// in out[0..4] (x1 < 0: none).
#[no_mangle]
pub unsafe extern "C" fn k_arq_query(a: u32, _chunk: i32) {
    let arg = waddr(a) as *const i32;
    let k = super::k::K::new(arg);
    let (ids, out) = (k.p::<i32>(1), k.p::<i32>(2));
    let mut q = match Arq::new(k.p::<i32>(0), arg) { Some(x) => x, None => { *out = 0; if k.i(0) == 2 { *out.add(2) = -1; } return; } };
    let ns = k.i(1).max(0) as usize;
    let src = core::slice::from_raw_parts(ids, ns);
    let r = k.i(3);
    match k.i(0) {
        0 => {
            let tgt = core::slice::from_raw_parts(ids.add(ns), k.i(2).max(0) as usize);
            *out = q.within(src, tgt, r) as i32;
        }
        1 => {
            let cap = k.i(4).max(0) as usize;
            let mut n = 0usize;
            q.each(src, r, |ar, _| {
                if n < cap {
                    *out.add(1 + n) = ar;
                }
                n += 1;
                false
            });
            *out = n.min(cap) as i32;
        }
        _ => {
            let bounds = q.bounds;
            let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, -1i32, -1i32);
            q.each(src, r, |ar, _| {
                let b = bounds.add(ar as usize * 4);
                if *b.add(2) >= 0 {
                    x0 = x0.min(*b);
                    y0 = y0.min(*b.add(1));
                    x1 = x1.max(*b.add(2));
                    y1 = y1.max(*b.add(3));
                }
                false
            });
            *out = x0;
            *out.add(1) = y0;
            *out.add(2) = x1;
            *out.add(3) = y1;
        }
    }
}
