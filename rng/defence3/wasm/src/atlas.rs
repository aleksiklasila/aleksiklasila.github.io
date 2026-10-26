//! The routing atlas (NAVIGATION_OPTIMIZATION.md): the next step from any
//! tile toward any tile by lookups, no search or field per destination.
//!
//! Built per navigation profile from a build's walls (flownav.js
//! navAtlasBuild), destination-independent:
//!  - 8x8 blocks: each block's wall mask (bit ly * 8 + lx, out of the map a
//!    wall) and its 4-connected components (a label per tile); a first move
//!    inside a block is a bitboard flood (flood_dir);
//!  - per cluster (the build's C x C), the next block component toward any
//!    other of the same part, with the crossing to take (k_atl_tables): the
//!    last leg, to the exact destination tile, inside its part;
//!  - over the build's parts, a hierarchy of domains (4 x 4 children a level:
//!    level 0 domains of 4 x 4 clusters, their nodes the parts' components
//!    within the domain; level 1 of 4 x 4 level 0 domains, ...), and for each
//!    node and each of its children the cost from every exit node of the
//!    node on to that child over the build's exit graph inside the node
//!    (k_atl_route).
//! A query (Atl::exit): the lowest node holding both parts, the destination's
//! child there; of the source part's exit nodes the one with the least local
//! way (the build's local field) plus cost on from across its border. A unit
//! follows that local field to the exit, crosses, and asks again: the costs
//! fall at every crossing inside the node, so no loop; within the
//! destination's part it takes the cluster table and the block flood.
use super::*;

const COL0: u64 = 0x0101_0101_0101_0101;
const COL7: u64 = 0x8080_8080_8080_8080;
#[inline(always)]
fn grow(b: u64) -> u64 {
    ((b << 1) & !COL0) | ((b >> 1) & !COL7) | (b << 8) | (b >> 8)
}

/// The first move from bit s toward bit t over the open bits of a block
/// (4-connected): 0 +x, 1 -x, 2 +y, 3 -y (the first of those on a shortest
/// way, in that order: nav_step's), -1 none (the same bit, or no way).
#[inline(never)]
pub fn flood_dir(open: u64, s: u32, t: u32) -> i32 {
    if s == t || s > 63 || t > 63 {
        return -1;
    }
    let sb = 1u64 << s;
    let mut fr = 1u64 << t;
    if open & fr == 0 || open & sb == 0 {
        return -1;
    }
    let mut seen = fr;
    for _ in 0..64 {
        let nb = grow(fr) & open & !seen;
        if nb == 0 {
            return -1;
        }
        if nb & sb != 0 {
            let x = s & 7;
            if x < 7 && fr & (sb << 1) != 0 {
                return 0;
            }
            if x > 0 && fr & (sb >> 1) != 0 {
                return 1;
            }
            if s < 56 && fr & (sb << 8) != 0 {
                return 2;
            }
            if s >= 8 && fr & (sb >> 8) != 0 {
                return 3;
            }
            return -1;
        }
        seen |= nb;
        fr = nb;
    }
    -1
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
struct Args {
    w: *const i32,
    f: *const f64,
}
impl Args {
    #[inline(always)]
    unsafe fn new(a: *const i32) -> Args {
        Args { w: a.add(512), f: (a as usize + 4096) as *const f64 }
    }
    #[inline(always)]
    unsafe fn p<T>(&self, i: usize) -> *mut T {
        waddr(*self.w.add(i) as u32) as *mut T
    }
    #[inline(always)]
    unsafe fn i(&self, i: usize) -> i32 {
        *self.f.add(i) as i32
    }
}

/// SIM_KERNEL_ATL_BLOCKS (flownav.js navAtlasBuild), P[1] clusters a job:
/// per cluster its blocks' wall masks (atl.bm, two words a block, low the
/// rows 0-3), each open tile's component in its block (atl.bc, 0xFF a wall),
/// each block's first component index within its cluster (atl.cb) and the
/// cluster's count (atl.cn); the parts' tile sums (atl.psx, atl.psy, atl.psn,
/// by part: the cluster's own). Arrays: navb.wall, navb.partL, atl.partB,
/// atl.bm, atl.bc, atl.cb, atl.cn, atl.psx, atl.psy, atl.psn.
/// P: [0] clusters, [1] per job, [2] W, [3] H, [4] C, [5] cw, [6] blocks across.
#[no_mangle]
pub unsafe extern "C" fn k_atl_blocks(a: u32, chunk: i32) {
    let k = Args::new(waddr(a) as *const i32);
    let (wall, pl, pb) = (k.p::<u8>(0), k.p::<u16>(1), k.p::<i32>(2));
    let (bm, bc, cb, cn) = (k.p::<u32>(3), k.p::<u8>(4), k.p::<u16>(5), k.p::<i32>(6));
    let (psx, psy, psn) = (k.p::<f64>(7), k.p::<f64>(8), k.p::<i32>(9));
    let (w, h, cc, cw, bw) = (k.i(2), k.i(3), k.i(4), k.i(5), k.i(6));
    let bh = (h + 7) >> 3;
    let bpc = (cc >> 3).max(1);
    let (c0, c1) = job(chunk, k.i(1), k.i(0));
    for c in c0..c1 {
        let ci = c as i32;
        let cx = irem(ci, cw);
        let cy = idiv(ci, cw);
        let mut count: i32 = 0;
        for by in 0..bpc {
            for bx in 0..bpc {
                let gbx = cx * bpc + bx;
                let gby = cy * bpc + by;
                if gbx >= bw || gby >= bh {
                    continue;
                }
                let bi = (gby * bw + gbx) as usize;
                let mut mask: u64 = 0;
                for ly in 0..8 {
                    for lx in 0..8 {
                        let x = gbx * 8 + lx;
                        let y = gby * 8 + ly;
                        if x >= w || y >= h || g(wall, (y * w + x) as usize) != 0 {
                            mask |= 1u64 << (ly * 8 + lx);
                        }
                    }
                }
                s(bm, bi * 2, mask as u32);
                s(bm, bi * 2 + 1, (mask >> 32) as u32);
                s(cb, bi, count as u16);
                // (Components by their lowest tile, flooded.)
                let open = !mask;
                let mut left = open;
                let mut label: u8 = 0;
                while left != 0 {
                    let mut comp = left & left.wrapping_neg();
                    loop {
                        let nx = (comp | grow(comp)) & open;
                        if nx == comp {
                            break;
                        }
                        comp = nx;
                    }
                    let mut m = comp;
                    while m != 0 {
                        let b = m.trailing_zeros() as i32;
                        m &= m - 1;
                        let x = gbx * 8 + (b & 7);
                        let y = gby * 8 + (b >> 3);
                        s(bc, (y * w + x) as usize, label);
                    }
                    left &= !comp;
                    label = label.wrapping_add(1);
                }
                let mut m = mask;
                while m != 0 {
                    let b = m.trailing_zeros() as i32;
                    m &= m - 1;
                    let x = gbx * 8 + (b & 7);
                    let y = gby * 8 + (b >> 3);
                    if x < w && y < h {
                        s(bc, (y * w + x) as usize, 0xFF);
                    }
                }
                count += label as i32;
            }
        }
        s(cn, c, count);
        // The parts' sums (their tiles' coordinates).
        let p0 = g(pb, c) as usize;
        let p1 = g(pb, c + 1) as usize;
        for p in p0..p1 {
            s(psx, p, 0.0);
            s(psy, p, 0.0);
            s(psn, p, 0);
        }
        let (x0, y0) = (cx * cc, cy * cc);
        for y in y0..(y0 + cc).min(h) {
            for x in x0..(x0 + cc).min(w) {
                let l = g(pl, (y * w + x) as usize);
                if l == 0xFFFF {
                    continue;
                }
                let p = p0 + l as usize;
                *psx.add(p) += x as f64;
                *psy.add(p) += y as f64;
                *psn.add(p) += 1;
            }
        }
    }
}

/// SIM_KERNEL_ATL_TABLES, P[1] clusters a job: per cluster of n block
/// components, for every pair (a, b) the crossing toward b from a (atl.ct at
/// atl.co[cluster] + a * n + b: the tile on a's side, cluster-local, and the
/// tile across, << 16; !0 none: the same component, or b not reachable inside
/// the cluster), by a breadth-first search from each b over the components'
/// contacts across block borders (a pair's crossing: its middle contact).
/// Arrays: atl.bm, atl.bc, atl.cb, atl.cn, atl.co, atl.ct. P: as k_atl_blocks.
#[no_mangle]
pub unsafe extern "C" fn k_atl_tables(a: u32, chunk: i32) {
    let a = waddr(a) as *const i32;
    let k = Args::new(a);
    let (bm, bc, cb, cn, co, ct) = (k.p::<u32>(0), k.p::<u8>(1), k.p::<u16>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<u32>(5));
    let (w, h, cc, cw, bw) = (k.i(2), k.i(3), k.i(4), k.i(5), k.i(6));
    let bh = (h + 7) >> 3;
    let bpc = (cc >> 3).max(1);
    let (sc, words) = (waddr(*a.add(1000) as u32) as *mut i32, (*a.add(1001)).max(0) as usize);
    let (c0, c1) = job(chunk, k.i(1), k.i(0));
    for c in c0..c1 {
        let n = g(cn, c).max(0) as usize;
        let base = g(co, c) as usize;
        for i in 0..n * n {
            s(ct, base + i, !0u32);
        }
        if n <= 1 {
            continue;
        }
        let ci = c as i32;
        let cx = irem(ci, cw);
        let cy = idiv(ci, cw);
        let (x0, y0) = (cx * cc, cy * cc);
        // Contacts: (a, b, tile a, tile b) in scan order, a < b's block.
        // Scratch: contacts 4 words each, then per component its degree
        // start / list, the queue, the visit stamps.
        let maxc = (2 * bpc * (bpc - 1) * 8) as usize;
        if 4 * maxc + 4 * n + 2 * maxc * 2 + n * 2 > words {
            continue;
        }
        let con = sc;
        let mut nc = 0usize;
        let comp_of = |gx: i32, gy: i32| -> i32 {
            let l = g(bc, (gy * w + gx) as usize);
            if l == 0xFF {
                -1
            } else {
                g(cb, ((gy >> 3) * bw + (gx >> 3)) as usize) as i32 + l as i32
            }
        };
        let open_at = |gx: i32, gy: i32| -> bool {
            if gx < 0 || gy < 0 || gx >= w || gy >= h {
                return false;
            }
            let bi = ((gy >> 3) * bw + (gx >> 3)) as usize;
            let b = ((gy & 7) * 8 + (gx & 7)) as u32;
            let m = if b < 32 { g(bm, bi * 2) >> b } else { g(bm, bi * 2 + 1) >> (b - 32) };
            m & 1 == 0
        };
        for by in 0..bpc {
            for bx in 0..bpc {
                let gbx = cx * bpc + bx;
                let gby = cy * bpc + by;
                if gbx >= bw || gby >= bh {
                    continue;
                }
                // East neighbour inside the cluster.
                if bx + 1 < bpc && gbx + 1 < bw {
                    for ly in 0..8 {
                        let (xa, ya) = (gbx * 8 + 7, gby * 8 + ly);
                        if open_at(xa, ya) && open_at(xa + 1, ya) {
                            let (p, q) = (comp_of(xa, ya), comp_of(xa + 1, ya));
                            if p >= 0 && q >= 0 {
                                let o = con.add(nc * 4);
                                *o = p;
                                *o.add(1) = q;
                                *o.add(2) = (ya - y0) * cc + (xa - x0);
                                *o.add(3) = (ya - y0) * cc + (xa + 1 - x0);
                                nc += 1;
                            }
                        }
                    }
                }
                // South neighbour.
                if by + 1 < bpc && gby + 1 < bh {
                    for lx in 0..8 {
                        let (xa, ya) = (gbx * 8 + lx, gby * 8 + 7);
                        if open_at(xa, ya) && open_at(xa, ya + 1) {
                            let (p, q) = (comp_of(xa, ya), comp_of(xa, ya + 1));
                            if p >= 0 && q >= 0 {
                                let o = con.add(nc * 4);
                                *o = p;
                                *o.add(1) = q;
                                *o.add(2) = (ya - y0) * cc + (xa - x0);
                                *o.add(3) = (ya + 1 - y0) * cc + (xa - x0);
                                nc += 1;
                            }
                        }
                    }
                }
            }
        }
        // Edges: a pair's contacts are consecutive (one border each):
        // the middle one taken. Kept as the contacts' slots 0..ne.
        let mut ne = 0usize;
        let mut i = 0usize;
        while i < nc {
            let (p, q) = (*con.add(i * 4), *con.add(i * 4 + 1));
            let mut j = i;
            while j < nc && *con.add(j * 4) == p && *con.add(j * 4 + 1) == q {
                j += 1;
            }
            let m = i + (j - i) / 2;
            let (ta, tb) = (*con.add(m * 4 + 2), *con.add(m * 4 + 3));
            let o = con.add(ne * 4);
            *o = p;
            *o.add(1) = q;
            *o.add(2) = ta;
            *o.add(3) = tb;
            ne += 1;
            i = j;
        }
        // Adjacency (both ways, by edge order): deg start, then entries
        // (other component, edge, direction 0 a->b / 1 b->a).
        let st = sc.add(4 * maxc);
        for v in 0..=n {
            *st.add(v) = 0;
        }
        for e in 0..ne {
            *st.add(*sc.add(e * 4) as usize + 1) += 1;
            *st.add(*sc.add(e * 4 + 1) as usize + 1) += 1;
        }
        for v in 0..n {
            *st.add(v + 1) += *st.add(v);
        }
        let adj = st.add(n + 1);
        let fill = adj.add(4 * maxc);
        for v in 0..n {
            *fill.add(v) = *st.add(v);
        }
        for e in 0..ne {
            let (p, q) = (*sc.add(e * 4) as usize, *sc.add(e * 4 + 1) as usize);
            let fp = *fill.add(p) as usize;
            *adj.add(fp * 2) = q as i32;
            *adj.add(fp * 2 + 1) = (e * 2) as i32;
            *fill.add(p) += 1;
            let fq = *fill.add(q) as usize;
            *adj.add(fq * 2) = p as i32;
            *adj.add(fq * 2 + 1) = (e * 2 + 1) as i32;
            *fill.add(q) += 1;
        }
        let queue = fill.add(n);
        let seen = queue.add(n);
        for v in 0..n {
            *seen.add(v) = -1;
        }
        // From each target b: whoever is found from u across an edge takes
        // that edge toward u.
        for b in 0..n {
            let (mut qh, mut qt) = (0usize, 0usize);
            *queue = b as i32;
            qt = 1;
            *seen.add(b) = b as i32;
            while qh < qt {
                let u = *queue.add(qh) as usize;
                qh += 1;
                for x in *st.add(u) as usize..*st.add(u + 1) as usize {
                    let v = *adj.add(x * 2) as usize;
                    if *seen.add(v) == b as i32 {
                        continue;
                    }
                    *seen.add(v) = b as i32;
                    *queue.add(qt) = v as i32;
                    qt += 1;
                    // Edge e: (p, q, tile p, tile q); v crosses toward u.
                    let ed = *adj.add(x * 2 + 1) as usize;
                    let e = ed >> 1;
                    let (tp, tq) = (*sc.add(e * 4 + 2) as u32, *sc.add(e * 4 + 3) as u32);
                    // (ed & 1 == 0: listed at p (u = p) toward q (v = q):
                    // v's side is q.)
                    let (tv, tu) = if ed & 1 == 0 { (tq, tp) } else { (tp, tq) };
                    s(ct, base + v * n + b, tv | (tu << 16));
                }
            }
        }
    }
}

/// SIM_KERNEL_ATL_ROUTE, a job each (atl.jobs: domain node D, target child
/// T, level): the cost from every exit node of D to child T over the build's
/// exit graph within D (Dijkstra from T's nodes; an edge's cost taken for
/// its reverse too: the graph's edges come in pairs of near costs), into
/// atl.rc at atl.rco[D] + T * atl.dn[D] + the node's index in D (atl.didx);
/// !0 none. A node is in D when its part is (atl.anc); in T when its part's
/// child of D is T (atl.cip at level 0, else atl.cin of the level below).
/// Arrays: navb.adjS, navb.adjA, navb.adjC, atl.npart, atl.anc, atl.cip,
/// atl.cin, atl.didx, atl.dnodes, atl.dno, atl.dn, atl.rco, atl.rc, atl.jobs.
/// P: [0] jobs, [1] levels L.
#[no_mangle]
pub unsafe extern "C" fn k_atl_route(a: u32, chunk: i32) {
    let a = waddr(a) as *const i32;
    let k = Args::new(a);
    let (adjs, adja, adjc, npart) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3));
    let (anc, cip, cin, didx) = (k.p::<i32>(4), k.p::<u16>(5), k.p::<u16>(6), k.p::<i32>(7));
    let (dnodes, dno, dn, rco, rc, jobs) = (k.p::<i32>(8), k.p::<i32>(9), k.p::<i32>(10), k.p::<i32>(11), k.p::<u32>(12), k.p::<i32>(13));
    let l = k.i(1).max(1) as usize;
    let j = chunk.max(0) as usize;
    if chunk >= k.i(0) {
        return;
    }
    let (d, t, lv) = (g(jobs, j * 3) as usize, g(jobs, j * 3 + 1), g(jobs, j * 3 + 2) as usize);
    let n = g(dn, d).max(0) as usize;
    let list = dnodes.add(g(dno, d) as usize);
    let out = rc.add(g(rco, d) as usize + t as usize * n);
    let (sc, words) = (waddr(*a.add(1000) as u32) as *mut u32, (*a.add(1001)).max(0) as usize);
    if 3 * n + 1 > words {
        for i in 0..n {
            s(out, i, !0u32);
        }
        return;
    }
    // Scratch: dist (n), heap of local indices (n), each one's heap place (n).
    let dist = sc;
    let heap = sc.add(n);
    let pos = sc.add(2 * n);
    for i in 0..n {
        s(dist, i, !0u32);
        s(pos, i, !0u32);
    }
    let child = |node: i32| -> i32 {
        let p = g(npart, node as usize) as usize;
        if lv == 0 { g(cip, p) as i32 } else { g(cin, g(anc, p * l + lv - 1) as usize) as i32 }
    };
    let mut hn = 0usize;
    // (Min-heap by (dist, local index): the same order on every peer.)
    let less = |x: u32, y: u32| -> bool {
        let (dx, dy) = (*dist.add(x as usize), *dist.add(y as usize));
        dx < dy || (dx == dy && x < y)
    };
    macro_rules! up {
        ($i:expr) => {{
            let mut i = $i;
            while i > 0 {
                let p = (i - 1) / 2;
                let (hi, hp) = (*heap.add(i), *heap.add(p));
                if !less(hi, hp) {
                    break;
                }
                *heap.add(i) = hp;
                *heap.add(p) = hi;
                *pos.add(hp as usize) = i as u32;
                *pos.add(hi as usize) = p as u32;
                i = p;
            }
        }};
    }
    for i in 0..n {
        if child(*list.add(i)) == t {
            *dist.add(i) = 0;
            *heap.add(hn) = i as u32;
            *pos.add(i) = hn as u32;
            hn += 1;
            up!(hn - 1);
        }
    }
    while hn > 0 {
        let u = *heap;
        hn -= 1;
        *pos.add(u as usize) = !0u32 - 1;
        if hn > 0 {
            let last = *heap.add(hn);
            *heap = last;
            *pos.add(last as usize) = 0;
            let mut i = 0usize;
            loop {
                let (l1, r1) = (2 * i + 1, 2 * i + 2);
                let mut m = i;
                if l1 < hn && less(*heap.add(l1), *heap.add(m)) {
                    m = l1;
                }
                if r1 < hn && less(*heap.add(r1), *heap.add(m)) {
                    m = r1;
                }
                if m == i {
                    break;
                }
                let (hi, hm) = (*heap.add(i), *heap.add(m));
                *heap.add(i) = hm;
                *heap.add(m) = hi;
                *pos.add(hm as usize) = i as u32;
                *pos.add(hi as usize) = m as u32;
                i = m;
            }
        }
        let du = *dist.add(u as usize);
        let un = *list.add(u as usize);
        for e in g(adjs, un as usize)..g(adjs, un as usize + 1) {
            let vn = g(adja, e as usize);
            let vp = g(npart, vn as usize) as usize;
            if g(anc, vp * l + lv) as usize != d {
                continue;
            }
            let v = g(didx, vn as usize * l + lv) as usize;
            if v >= n {
                continue;
            }
            let nd = du.saturating_add(g(adjc, e as usize).max(0) as u32);
            let pv = *pos.add(v);
            if pv == !0u32 - 1 || nd >= *dist.add(v) {
                continue;
            }
            *dist.add(v) = nd;
            if pv == !0u32 {
                *heap.add(hn) = v as u32;
                *pos.add(v) = hn as u32;
                hn += 1;
                up!(hn - 1);
            } else {
                up!(pv as usize);
            }
        }
    }
    for i in 0..n {
        s(out, i, *dist.add(i));
    }
}

// A look visits successive tiles of the same part toward the same target.
// Only the local field changes: the cost beyond each exit stays constant.
// Keep those costs on the look's stack, in exit order (including ties).
pub struct ExitCache {
    atlas: *const i32,
    sp: i32,
    dp: i32,
    count: usize,
    nodes: [i32; 64],
    costs: [u32; 64],
}
impl ExitCache {
    pub fn new() -> Self {
        Self { atlas: core::ptr::null(), sp: -1, dp: -1, count: 0, nodes: [0; 64], costs: [0; 64] }
    }
    unsafe fn best(&self, fields: *const u16, o: usize, cc2: usize) -> i32 {
        let mut best = -1;
        let mut value = u32::MAX;
        let mut i = 0;
        while i + 4 <= self.count {
            let nodes = self.nodes.as_ptr().add(i);
            let f = i32x4(g(fields, *nodes as usize * cc2 + o) as i32,
                g(fields, *nodes.add(1) as usize * cc2 + o) as i32,
                g(fields, *nodes.add(2) as usize * cc2 + o) as i32,
                g(fields, *nodes.add(3) as usize * cc2 + o) as i32);
            let r = v128_load(self.costs.as_ptr().add(i) as *const v128);
            let sum = i32x4_add(r, f);
            // Match scalar saturation and unreachable fields exactly.
            let invalid = v128_or(u32x4_lt(sum, r), i32x4_eq(f, i32x4_splat(0xFFFF)));
            let score = v128_bitselect(i32x4_splat(-1), sum, invalid);
            let low = u32x4_min(score, i32x4_shuffle::<2, 3, 0, 1>(score, score));
            let low = u32x4_min(low, i32x4_shuffle::<1, 0, 3, 2>(low, low));
            let v = i32x4_extract_lane::<0>(low) as u32;
            if v < value {
                let lane = (i32x4_bitmask(i32x4_eq(score, low)) as u32).trailing_zeros() as usize;
                value = v; best = *nodes.add(lane);
            }
            i += 4;
        }
        for i in i..self.count {
            let node = *self.nodes.get_unchecked(i);
            let f = g(fields, node as usize * cc2 + o);
            if f == 0xFFFF { continue; }
            let v = (*self.costs.get_unchecked(i)).saturating_add(f as u32);
            if v < value { value = v; best = node; }
        }
        best
    }
}
/// A profile's atlas header (flownav.js navAtlasHeader, nav.<p>.atl):
/// words [0] levels L, [1] C, [2] cw, [3] blocks across, [4] parts, then the
/// arrays' addresses: [5] bm, [6] bc, [7] cb, [8] co, [9] ct (blocks and the
/// clusters' tables), [10] anc (L a part: its node at each level), [11] cip
/// (a part's child index in its level 0 node), [12] cin (a node's child
/// index in its parent), [13] rco (a node's cost table offset), [14] rc,
/// [15] dn (a node's exit nodes), [16] the build's nodePart, [17] cn, [18]
/// didx (L an exit node: its index in its node at each level), [19] the
/// build's nodeBase.
pub struct Atl {
    pub exit_cache: *mut ExitCache,
    header: *const i32,
    pub l: usize,
    pub c: i32,
    pub cw: i32,
    pub bw: i32,
    clear_prefix: *const i32,
    bm: *const u32,
    bc: *const u8,
    cb: *const u16,
    co: *const i32,
    ct: *const u32,
    anc: *const i32,
    cip: *const u16,
    cin: *const u16,
    rco: *const i32,
    rc: *const u32,
    dn: *const i32,
    npart: *const i32,
    cn: *const i32,
    didx: *const i32,
    nb: *const i32,
}
impl Atl {
    // An empty bounding rectangle permits straight travel without routing
    // through a representative portal. Constant time, regardless of distance.
    pub unsafe fn clear_rect(&self,x:i32,y:i32,dx:i32,dy:i32)->bool {
        if self.clear_prefix.is_null(){return false;}
        let x0=x.min(dx)>>3;let x1=(x.max(dx)>>3)+1;
        let y0=y.min(dy)>>3;let y1=(y.max(dy)>>3)+1;
        let stride=self.bw+1;let p=self.clear_prefix;
        *p.add((y1*stride+x1) as usize)-*p.add((y0*stride+x1) as usize)
            -*p.add((y1*stride+x0) as usize)+*p.add((y0*stride+x0) as usize)==0
    }
    #[inline(always)]
    pub unsafe fn from(h: *const i32) -> Option<Atl> {
        if h.is_null() || *h <= 0 {
            return None;
        }
        let p = |i: usize| waddr(*h.add(i) as u32);
        Some(Atl {
            exit_cache: core::ptr::null_mut(),
            header: h,
            l: *h as usize,
            c: *h.add(1),
            cw: *h.add(2),
            bw: *h.add(3),
            clear_prefix: p(20) as *const i32,
            bm: p(5) as *const u32,
            bc: p(6) as *const u8,
            cb: p(7) as *const u16,
            co: p(8) as *const i32,
            ct: p(9) as *const u32,
            anc: p(10) as *const i32,
            cip: p(11) as *const u16,
            cin: p(12) as *const u16,
            rco: p(13) as *const i32,
            rc: p(14) as *const u32,
            dn: p(15) as *const i32,
            npart: p(16) as *const i32,
            cn: p(17) as *const i32,
            didx: p(18) as *const i32,
            nb: p(19) as *const i32,
        })
    }
    /// The exit node (the build's index) of part sp, in cluster cf, for a
    /// unit at cluster-local offset o (its local fields' index) heading for
    /// part dp: of the lowest node holding both, the exit of sp with the
    /// least local way plus cost on to dp's child there. -1 none (not
    /// reachable, or the same part).
    #[inline(never)]
    pub unsafe fn exit(&self, sp: i32, dp: i32, cf: usize, o: usize, cc2: usize, fields: *const u16, pair: *const i32) -> i32 {
        if sp == dp || sp < 0 || dp < 0 {
            return -1;
        }
        if !self.exit_cache.is_null() {
            let cache = &*self.exit_cache;
            if cache.atlas == self.header && cache.sp == sp && cache.dp == dp {
                return cache.best(fields, o, cc2);
            }
            (*self.exit_cache).atlas = core::ptr::null();
            (*self.exit_cache).count = 0;
        }
        let l = self.l;
        let (su, tu) = (sp as usize, dp as usize);
        let mut lv = 0usize;
        while lv < l && g(self.anc, su * l + lv) != g(self.anc, tu * l + lv) {
            lv += 1;
        }
        if lv >= l {
            return -1;
        }
        let d = g(self.anc, su * l + lv) as usize;
        let ct = if lv == 0 { g(self.cip, tu) as usize } else { g(self.cin, g(self.anc, tu * l + lv - 1) as usize) as usize };
        let n = g(self.dn, d) as usize;
        let base = g(self.rco, d) as usize + ct * n;
        let mut best = -1i32;
        let mut bv = u32::MAX;
        let mut cache_count = 0usize;
        for i in g(self.nb, cf)..g(self.nb, cf + 1) {
            let iu = i as usize;
            if g(self.npart, iu) != sp {
                continue;
            }
            // (The cost on from across its border: crossing there is what
            // a unit at the exit does.)
            let j = g(pair, iu);
            if j < 0 || g(self.anc, g(self.npart, j as usize) as usize * l + lv) as usize != d {
                continue;
            }
            let x = g(self.didx, j as usize * l + lv) as usize;
            if x >= n {
                continue;
            }
            let r = g(self.rc, base + x);
            if r == !0u32 { continue; }
            if !self.exit_cache.is_null() {
                if cache_count < 64 {
                    *(*self.exit_cache).nodes.as_mut_ptr().add(cache_count) = i;
                    *(*self.exit_cache).costs.as_mut_ptr().add(cache_count) = r;
                }
                cache_count += 1;
            }
            let f = g(fields, iu * cc2 + o);
            if f == 0xFFFF {
                continue;
            }
            let v = r.saturating_add(f as u32);
            if v < bv {
                bv = v;
                best = i;
            }
        }
        if !self.exit_cache.is_null() && cache_count <= 64 {
            let cache = &mut *self.exit_cache;
            cache.atlas = self.header; cache.sp = sp; cache.dp = dp; cache.count = cache_count;
        }
        best
    }
    /// The next tile from tile ti (x, y) toward tile di of the same part, in
    /// a map W wide: the block flood, or the cluster table's crossing; -1
    /// none.
    #[inline(never)]
    pub unsafe fn local(&self, w: i32, ti: i32, x: i32, y: i32, di: i32) -> i32 {
        if ti == di {
            return -1;
        }
        let (dx, dy) = (irem(di, w), idiv(di, w));
        let bw = self.bw;
        let (sb, db) = ((y >> 3) * bw + (x >> 3), (dy >> 3) * bw + (dx >> 3));
        let (sl, dl) = (g(self.bc, ti as usize), g(self.bc, di as usize));
        if sl == 0xFF || dl == 0xFF {
            return -1;
        }
        let step = |from: i32, fx: i32, fy: i32, to: i32| -> i32 {
            let bi = ((fy >> 3) * bw + (fx >> 3)) as usize;
            let open = !((g(self.bm, bi * 2) as u64) | ((g(self.bm, bi * 2 + 1) as u64) << 32));
            let (tx, ty) = (irem(to, w), idiv(to, w));
            let d = flood_dir(open, ((fy & 7) * 8 + (fx & 7)) as u32, ((ty & 7) * 8 + (tx & 7)) as u32);
            match d {
                0 => from + 1,
                1 => from - 1,
                2 => from + w,
                3 => from - w,
                _ => -1,
            }
        };
        if sb == db && sl == dl {
            return step(ti, x, y, di);
        }
        let cc = self.c;
        let cs = 31 - (cc as u32).leading_zeros() as i32;
        let (cx, cy) = (x >> cs, y >> cs);
        if (dx >> cs) != cx || (dy >> cs) != cy {
            return -1;
        }
        let c = (cy * self.cw + cx) as usize;
        let n = g(self.cn, c) as usize;
        let a = g(self.cb, sb as usize) as usize + sl as usize;
        let b = g(self.cb, db as usize) as usize + dl as usize;
        if a >= n || b >= n {
            return -1;
        }
        let e = g(self.ct, g(self.co, c) as usize + a * n + b);
        if e == !0u32 {
            return -1;
        }
        let (x0, y0) = (cx << cs, cy << cs);
        let la = (e & 0xFFFF) as i32;
        let lb = (e >> 16) as i32;
        let ta = (y0 + idiv(la, cc)) * w + x0 + irem(la, cc);
        if ta == ti {
            return (y0 + idiv(lb, cc)) * w + x0 + irem(lb, cc);
        }
        step(ti, x, y, ta)
    }
}

/// For JavaScript (flownav.js navAtlasStep): the next tile from t toward
/// dest by a profile's atlas (header h) and build (partL, partB, nodeTile,
/// nodePair, fields), -1 none. Pointers as the kernels' 32-bit words.
#[no_mangle]
pub unsafe extern "C" fn nav_atlas_step(h: u32, partl: u32, partb: u32, nt: u32, np: u32, fields: u32, w: i32, t: i32, dest: i32) -> i32 {
    let a = match Atl::from(waddr(h) as *const i32) {
        Some(a) => a,
        None => return -1,
    };
    atlas_step(&a, waddr(partl) as *const u16, waddr(partb) as *const i32, waddr(nt) as *const i32, waddr(np) as *const i32, waddr(fields) as *const u16, w, t, dest)
}

/// The next tile from t toward dest (the movement kernel's nav_step on the
/// atlas): -1 none, at dest, or t a wall (the caller's step out).
#[inline(never)]
pub unsafe fn atlas_step(a: &Atl, pl: *const u16, pb: *const i32, nt: *const i32, np: *const i32, fields: *const u16, w: i32, t: i32, dest: i32) -> i32 {
    if t == dest || t < 0 || dest < 0 {
        return -1;
    }
    let cc = a.c;
    let cs = 31 - (cc as u32).leading_zeros() as i32;
    let (x, y) = (irem(t, w), idiv(t, w));
    let (dx, dy) = (irem(dest, w), idiv(dest, w));
    let ls = g(pl, t as usize);
    let ld = g(pl, dest as usize);
    if ls == 0xFFFF || ld == 0xFFFF {
        return -1;
    }
    let cf = ((y >> cs) * a.cw + (x >> cs)) as usize;
    let cd = ((dy >> cs) * a.cw + (dx >> cs)) as usize;
    let sp = g(pb, cf) + ls as i32;
    let dp = g(pb, cd) + ld as i32;
    if sp == dp {
        return a.local(w, t, x, y, dest);
    }
    let c = cc as usize;
    let lx = x - ((x >> cs) << cs);
    let ly = y - ((y >> cs) << cs);
    let lo = ly as usize * c + lx as usize;
    let node = a.exit(sp, dp, cf, lo, c * c, fields, np);
    if node < 0 {
        return -1;
    }
    let nu = node as usize;
    if g(nt, nu) == t {
        let p = g(np, nu);
        return if p >= 0 { g(nt, p as usize) } else { -1 };
    }
    let o = nu * c * c + lo;
    let mut best = -1;
    let mut bv = g(fields, o);
    if lx + 1 < cc && g(fields, o + 1) < bv {
        bv = g(fields, o + 1);
        best = t + 1;
    }
    if lx > 0 && g(fields, o - 1) < bv {
        bv = g(fields, o - 1);
        best = t - 1;
    }
    if ly + 1 < cc && g(fields, o + c) < bv {
        bv = g(fields, o + c);
        best = t + w;
    }
    if ly > 0 && g(fields, o - c) < bv {
        best = t - w;
    }
    best
}
