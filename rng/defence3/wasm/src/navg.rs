//! A navigation build's glue on the helpers (NAV_REBUILD_PLAN.md): the steps
//! between its kernels that size and fill the next arrays, formerly on the
//! simulation thread (flownav.js navBuildNodesFinish, navBuildGraphAlloc,
//! navBuildGraphFinish, navBuildPartsFinish, navAtlasStart, navAtlasTables,
//! navAtlasFinish, navAtlasHeader), the same values. A build lives in its
//! slot (flownav.js navReserve): one block, the build header at its start
//! (byte offsets of its arrays and its counts: H_* / O_* below, flownav.js
//! NAVH); arrays are placed upward from H_TOP, a step's scratch downward
//! from H_TEMP; a block too small sets H_FULL (the build is dropped).
//! One job a step (k_navg, P[0] the step), in the build's background chain.
use super::*;

pub const H_K: usize = 0;
pub const H_NP: usize = 1;
pub const H_E: usize = 2;
pub const H_TOTAL: usize = 3;
pub const H_L: usize = 4;
pub const H_POOL: usize = 5;
pub const H_NJ: usize = 6;
pub const H_NCOMP: usize = 7;
pub const H_TOP: usize = 8;
pub const H_CAP: usize = 9;
pub const H_FULL: usize = 10;
pub const H_B: usize = 11;
pub const H_TEMP: usize = 12;
pub const O_WALL: usize = 16;
pub const O_COST: usize = 17;
pub const O_H: usize = 18;
pub const O_PARTL: usize = 19;
pub const O_PARTN: usize = 20;
pub const O_NS: usize = 21;
pub const O_NSC: usize = 22;
pub const O_NODEBASE: usize = 23;
pub const O_NODETILE: usize = 24;
pub const O_NODEPAIR: usize = 25;
pub const O_FIELDS: usize = 26;
pub const O_ADJN: usize = 27;
pub const O_ADJS: usize = 28;
pub const O_ADJA: usize = 29;
pub const O_ADJC: usize = 30;
pub const O_ADJMAX: usize = 31;
pub const O_PARTB: usize = 32;
pub const O_PCLU: usize = 33;
pub const O_NPART: usize = 34;
pub const O_PCOMP: usize = 35;
pub const O_CSTART: usize = 36;
pub const O_CPARTS: usize = 37;
pub const O_BM: usize = 38;
pub const O_BC: usize = 39;
pub const O_CB: usize = 40;
pub const O_CN: usize = 41;
pub const O_PSX: usize = 42;
pub const O_PSY: usize = 43;
pub const O_PSN: usize = 44;
pub const O_CIP: usize = 45;
pub const O_ANC: usize = 46;
pub const O_CIN: usize = 47;
pub const O_DN: usize = 48;
pub const O_DNO: usize = 49;
pub const O_DIDX: usize = 50;
pub const O_DNODES: usize = 51;
pub const O_RCO: usize = 52;
pub const O_RC: usize = 53;
pub const O_JOBS: usize = 54;
pub const O_CO: usize = 55;
pub const O_CT: usize = 56;
pub const O_CLEAR: usize = 57;
pub const O_ATLH: usize = 58;

struct B {
    base: *mut u8,
    h: *mut i32,
}
impl B {
    #[inline(always)]
    unsafe fn hv(&self, i: usize) -> i32 { *self.h.add(i) }
    #[inline(always)]
    unsafe fn hs(&self, i: usize, v: i32) { *self.h.add(i) = v; }
    #[inline(always)]
    unsafe fn full(&self) -> bool { *self.h.add(H_FULL) != 0 }
    /// n elements of size sz placed up from H_TOP (64-byte steps), recorded
    /// at header word o (o 0: not recorded); cleared when asked. None: full.
    unsafe fn alloc<T>(&self, o: usize, n: usize, clear: bool) -> *mut T {
        let bytes = n.max(1) * core::mem::size_of::<T>();
        let top = self.hv(H_TOP) as usize;
        let end = top + bytes;
        if end > self.hv(H_TEMP) as usize {
            self.hs(H_FULL, 1);
            return core::ptr::null_mut();
        }
        self.hs(H_TOP, (((end + 63) / 64) * 64) as i32);
        if o != 0 { self.hs(o, top as i32); }
        let p = self.base.add(top);
        if clear { core::ptr::write_bytes(p, 0, bytes); }
        p as *mut T
    }
    /// Scratch for this step, down from H_TEMP (given back with temp_reset).
    unsafe fn temp<T>(&self, n: usize) -> *mut T {
        let bytes = ((n.max(1) * core::mem::size_of::<T>() + 63) / 64) * 64;
        let t = self.hv(H_TEMP) as usize;
        if t < bytes || t - bytes < self.hv(H_TOP) as usize {
            self.hs(H_FULL, 1);
            return core::ptr::null_mut();
        }
        self.hs(H_TEMP, (t - bytes) as i32);
        self.base.add(t - bytes) as *mut T
    }
    #[inline(always)]
    unsafe fn at<T>(&self, o: usize) -> *mut T { self.base.add(self.hv(o) as usize) as *mut T }
    /// An array's address as the kernels' words hold it (sim_parallel.js _simWEnc).
    #[inline(always)]
    unsafe fn enc(&self, o: usize) -> i32 {
        let a = self.base as usize + self.hv(o) as usize;
        #[cfg(target_arch = "wasm64")]
        { (a >> 2) as i32 }
        #[cfg(not(target_arch = "wasm64"))]
        { a as i32 }
    }
}
#[inline(always)]
unsafe fn g<T: Copy>(p: *const T, i: usize) -> T { *p.add(i) }
#[inline(always)]
unsafe fn s<T>(p: *mut T, i: usize, v: T) { *p.add(i) = v; }
#[inline(always)]
fn cdiv(a: i32, b: i32) -> i32 { ((a.max(0) as u32 + b.max(1) as u32 - 1) / b.max(1) as u32) as i32 }
/// Union-find's root (a set's root its smallest member), halving the way.
#[inline(always)]
unsafe fn find(uf: *mut i32, mut x: i32) -> i32 {
    while g(uf, x as usize) != x {
        let up = g(uf, g(uf, x as usize) as usize);
        s(uf, x as usize, up);
        x = up;
    }
    x
}

/// The build's glue steps (P[0]): 1 the nodes numbered (navBuildNodesFinish),
/// 2 the edges placed (navBuildGraphAlloc), 3 the graph's bucket count and
/// the parts (navBuildGraphFinish, navBuildPartsFinish, the atlas's block
/// arrays), 4 the atlas's hierarchy (navAtlasStart), 5 its cluster tables'
/// places (navAtlasTables), 6 its clear prefix and header (navAtlasFinish).
/// Arrays: 0 the slot (bytes), 1 its header. P: [1] W, [2] H, [3] C, [4]
/// clusters wide, [5] high, [6] clusters, [7] node slots a cluster (NM),
/// [8] the atlas (1), [9] nodes a graph job.
#[no_mangle]
pub unsafe extern "C" fn k_navg(a: u32, _chunk: i32) {
    let k = super::k::K::new(waddr(a) as *const i32);
    let b = B { base: k.p::<u8>(0), h: k.p::<i32>(1) };
    if b.base.is_null() || b.h.is_null() || b.full() {
        return;
    }
    let (w, h, c, cw, ch, nc, nm) = (k.i(1), k.i(2), k.i(3), k.i(4), k.i(5), k.i(6), k.i(7));
    // Slots need not have a rounded byte length. Scratch must stay aligned
    // even for the builders' measured capacity (which includes 10% slack).
    let cap = b.hv(H_CAP) & !63;
    b.hs(H_TEMP, cap);
    match k.i(0) {
        1 => nodes_finish(&b, nc, cw, c, nm),
        2 => graph_alloc(&b, k.i(9)),
        3 => parts_finish(&b, w, h, nc, k.i(9), k.i(8) != 0),
        4 => if k.i(8) != 0 { atlas_levels(&b, cw, ch, nc) },
        5 => if k.i(8) != 0 { atlas_tables(&b, nc) },
        _ => if k.i(8) != 0 { atlas_finish(&b, w, h, c, cw) },
    }
    b.hs(H_TEMP, cap);
}

/// navBuildNodesFinish: the nodes numbered cluster by cluster (nodeBase),
/// each with the node across its border (nodePair), the fields' place.
unsafe fn nodes_finish(b: &B, nc: i32, cw: i32, c: i32, nm: i32) {
    let (ns, nsc) = (b.at::<i32>(O_NS), b.at::<i32>(O_NSC));
    let nc = nc.max(0) as usize;
    let nb: *mut i32 = b.alloc(O_NODEBASE, nc + 1, true);
    if nb.is_null() { return; }
    let mut kk = 0i32;
    for cl in 0..nc {
        s(nb, cl, kk);
        let o = cl * 4;
        kk += nm.min(g(nsc, o) + g(nsc, o + 1) + g(nsc, o + 2) + g(nsc, o + 3));
    }
    s(nb, nc, kk);
    let k = kk.max(0) as usize;
    let nt: *mut i32 = b.alloc(O_NODETILE, k, true);
    let np: *mut i32 = b.alloc(O_NODEPAIR, k, true);
    if nt.is_null() || np.is_null() { return; }
    let cwu = cw as i32;
    for cl in 0..nc {
        let b0 = g(nb, cl);
        let n = g(nb, cl + 1) - b0;
        let o = cl * 4;
        let (nn, nw, ne) = (g(nsc, o), g(nsc, o + 1), g(nsc, o + 2));
        for i in 0..n {
            s(nt, (b0 + i) as usize, g(ns, cl * nm as usize + i as usize));
            let (q, j);
            let clc = cl as i32;
            if i < nn { q = clc - cwu; j = g(nsc, q as usize * 4) + g(nsc, q as usize * 4 + 1) + g(nsc, q as usize * 4 + 2) + i; }
            else if i < nn + nw { q = clc - 1; j = g(nsc, q as usize * 4) + g(nsc, q as usize * 4 + 1) + (i - nn); }
            else if i < nn + nw + ne { q = clc + 1; j = g(nsc, q as usize * 4) + (i - nn - nw); }
            else { q = clc + cwu; j = i - nn - nw - ne; }
            let qu = q as usize;
            s(np, (b0 + i) as usize, if j < g(nb, qu + 1) - g(nb, qu) { g(nb, qu) + j } else { -1 });
        }
    }
    let cc = (c * c) as usize;
    // (Not cleared: each node's field is written whole by the kernel that makes it.)
    let f: *mut u16 = b.alloc(O_FIELDS, k * cc, false);
    let an: *mut i32 = b.alloc(O_ADJN, k, true);
    if f.is_null() || an.is_null() { return; }
    b.hs(H_K, k as i32);
}

/// navBuildGraphAlloc: each node's first edge (the counts summed), the edges' arrays.
unsafe fn graph_alloc(b: &B, per: i32) {
    let k = b.hv(H_K).max(0) as usize;
    let an = b.at::<i32>(O_ADJN);
    let st: *mut i32 = b.alloc(O_ADJS, k + 1, true);
    if st.is_null() { return; }
    let mut e = 0i32;
    for i in 0..k { s(st, i, e); e += g(an, i); }
    s(st, k, e);
    let a1: *mut i32 = b.alloc(O_ADJA, e.max(0) as usize, true);
    let a2: *mut i32 = b.alloc(O_ADJC, e.max(0) as usize, true);
    let mx: *mut i32 = b.alloc(O_ADJMAX, cdiv(k as i32, per.max(1)).max(1) as usize, true);
    if a1.is_null() || a2.is_null() || mx.is_null() { return; }
    b.hs(H_E, e);
}

/// navBuildGraphFinish (the bucket count) and navBuildPartsFinish (the
/// parts' numbering, each node's part, the components), then the atlas's
/// block arrays (navAtlasStart's first).
unsafe fn parts_finish(b: &B, w: i32, h: i32, nc: i32, per: i32, atlas: bool) {
    let k = b.hv(H_K).max(0) as usize;
    let mx = b.at::<i32>(O_ADJMAX);
    let mut m = 0i32;
    for j in 0..cdiv(k as i32, per.max(1)).max(1) as usize { m = m.max(g(mx, j)); }
    b.hs(H_B, m + 1);
    let nc = nc.max(0) as usize;
    let (nb, nt, np, pl, pn) = (b.at::<i32>(O_NODEBASE), b.at::<i32>(O_NODETILE), b.at::<i32>(O_NODEPAIR), b.at::<u16>(O_PARTL), b.at::<i32>(O_PARTN));
    let pb: *mut i32 = b.alloc(O_PARTB, nc + 1, true);
    if pb.is_null() { return; }
    let mut nparts = 0i32;
    for cl in 0..nc { s(pb, cl, nparts); nparts += g(pn, cl); }
    s(pb, nc, nparts);
    let npu = nparts.max(0) as usize;
    let pc: *mut i32 = b.alloc(O_PCLU, npu, true);
    let npart: *mut i32 = b.alloc(O_NPART, k, true);
    if pc.is_null() || npart.is_null() { return; }
    for cl in 0..nc { for p in g(pb, cl)..g(pb, cl + 1) { s(pc, p as usize, cl as i32); } }
    for cl in 0..nc { for i in g(nb, cl)..g(nb, cl + 1) { s(npart, i as usize, g(pb, cl) + g(pl, g(nt, i as usize) as usize) as i32); } }
    let uf: *mut i32 = b.temp(npu);
    let cor: *mut i32 = b.temp(npu);
    if uf.is_null() || cor.is_null() { return; }
    for p in 0..npu { s(uf, p, p as i32); }
    for i in 0..k {
        let j = g(np, i);
        if j < 0 { continue; }
        let ra = find(uf, g(npart, i));
        let rc = find(uf, g(npart, j as usize));
        if ra < rc { s(uf, rc as usize, ra); } else if rc < ra { s(uf, ra as usize, rc); }
    }
    let pcomp: *mut i32 = b.alloc(O_PCOMP, npu, true);
    if pcomp.is_null() { return; }
    for p in 0..npu { s(cor, p, -1); }
    let mut ncomp = 0i32;
    for p in 0..npu {
        let r = find(uf, p as i32) as usize;
        if g(cor, r) < 0 { s(cor, r, ncomp); ncomp += 1; }
        s(pcomp, p, g(cor, r));
    }
    let cst: *mut i32 = b.alloc(O_CSTART, ncomp as usize + 1, true);
    let cpt: *mut i32 = b.alloc(O_CPARTS, npu, true);
    if cst.is_null() || cpt.is_null() { return; }
    for p in 0..npu { let q = g(pcomp, p) as usize; s(cst, q + 1, g(cst, q + 1) + 1); }
    for i in 0..ncomp as usize { s(cst, i + 1, g(cst, i + 1) + g(cst, i)); }
    // (The fill counts in the union-find's scratch, its work done.)
    let fill = uf;
    for i in 0..ncomp as usize { s(fill, i, 0); }
    for p in 0..npu { let q = g(pcomp, p) as usize; let x = g(fill, q); s(fill, q, x + 1); s(cpt, (g(cst, q) + x) as usize, p as i32); }
    b.hs(H_NP, nparts);
    b.hs(H_NCOMP, ncomp);
    if !atlas || nparts <= 0 { return; }
    let (bw, bh) = (cdiv(w, 8), cdiv(h, 8));
    let nbk = (bw * bh) as usize;
    let t = (w * h) as usize;
    if b.alloc::<u32>(O_BM, nbk * 2, true).is_null() || b.alloc::<u8>(O_BC, t, true).is_null() || b.alloc::<u16>(O_CB, nbk, true).is_null()
        || b.alloc::<i32>(O_CN, nc, true).is_null() || b.alloc::<f64>(O_PSX, npu, true).is_null() || b.alloc::<f64>(O_PSY, npu, true).is_null()
        || b.alloc::<i32>(O_PSN, npu, true).is_null() { return; }
}

/// navAtlasStart's hierarchy: items of the level below (parts first) in
/// domains of 4 x 4 (clusters, then the domains below); a level's nodes the
/// components of its items within a domain joined by exit pairs (union-find,
/// a set's root its lowest item; nodes in the order of their first item),
/// each item's place among its node's children; then each part's node at
/// every level (anc), each node's exit nodes (dnodes by dno, with each exit
/// node's place: didx), the route costs' places (rco, rc) and their jobs.
unsafe fn atlas_levels(b: &B, cw: i32, ch: i32, _nc: i32) {
    let cw = cw.max(1);
    let np = b.hv(H_NP).max(0) as usize;
    let k = b.hv(H_K).max(0) as usize;
    if np == 0 { return; }
    let (pclu, npart, npair) = (b.at::<i32>(O_PCLU), b.at::<i32>(O_NPART), b.at::<i32>(O_NODEPAIR));
    // (The levels: until a domain covers the clusters.)
    let mut lmax = 0i32;
    let mut sp = 1i32;
    while lmax < 16 { sp *= 4; lmax += 1; if cdiv(cw, sp) <= 1 && cdiv(ch, sp) <= 1 { break; } }
    let l = lmax as usize;
    let anc: *mut i32 = b.alloc(O_ANC, np * l, true);
    let cip: *mut u16 = b.alloc(O_CIP, np, true);
    if anc.is_null() || cip.is_null() { return; }
    // Scratch: the items' coordinates (two sets: this level's, the next's),
    // each part's item, the union-find, each item's node, each root's node;
    // per level its node count, children counts and children's places (kept
    // to the end: cin, nch).
    let ix: *mut i32 = b.temp(np);
    let iy: *mut i32 = b.temp(np);
    let jx: *mut i32 = b.temp(np);
    let jy: *mut i32 = b.temp(np);
    let item: *mut i32 = b.temp(np);
    let uf: *mut i32 = b.temp(np);
    let node: *mut i32 = b.temp(np);
    let root: *mut i32 = b.temp(np);
    let lev_n: *mut i32 = b.temp(17);
    let lev_nch: *mut i32 = b.temp(np * l);
    let lev_cin: *mut u16 = b.temp(np * l);
    if ix.is_null() || iy.is_null() || jx.is_null() || jy.is_null() || item.is_null() || uf.is_null() || node.is_null() || root.is_null()
        || lev_n.is_null() || lev_nch.is_null() || lev_cin.is_null() { return; }
    let (mut cx, mut cy, mut nx, mut ny) = (ix, iy, jx, jy);
    for p in 0..np { let c = g(pclu, p); s(cx, p, c % cw); s(cy, p, c / cw); s(item, p, p as i32); }
    let mut n0 = np;
    let mut total = 0usize;
    let mut span = 1i32;
    let mut lv = 0usize;
    while lv < 16 {
        span *= 4;
        let (dwx, dhy) = (cdiv(cw, span), cdiv(ch, span));
        // (An item's domain: its coordinates at the level below, / 4.)
        let dom = |i: usize| -> i32 { (g(cy, i) >> 2) * dwx + (g(cx, i) >> 2) };
        for i in 0..n0 { s(uf, i, i as i32); }
        for e in 0..k {
            let f = g(npair, e);
            if f < 0 { continue; }
            let a = g(item, g(npart, e) as usize);
            let c = g(item, g(npart, f as usize) as usize);
            if a == c || dom(a as usize) != dom(c as usize) { continue; }
            let ra = find(uf, a);
            let rc = find(uf, c);
            if ra < rc { s(uf, rc as usize, ra); } else if rc < ra { s(uf, ra as usize, rc); }
        }
        for i in 0..n0 { s(root, i, -1); }
        let mut n1 = 0usize;
        for i in 0..n0 {
            let r = find(uf, i as i32) as usize;
            if g(root, r) < 0 { s(root, r, n1 as i32); n1 += 1; }
            s(node, i, g(root, r));
        }
        let nch = lev_nch.add(total);
        // (This level's items' places among their nodes' children, laid out
        // by the levels' item counts: item_base.)
        let cin = lev_cin.add(item_base(lev_n, lv, np));
        for d in 0..n1 { s(nch, d, 0); }
        for i in 0..n0 { let d = g(node, i) as usize; s(cin, i, g(nch, d) as u16); s(nch, d, g(nch, d) + 1); }
        if lv == 0 { for p in 0..np { s(cip, p, g(cin, p)); } }
        for i in 0..n0 { let d = g(node, i) as usize; s(nx, d, g(cx, i) >> 2); s(ny, d, g(cy, i) >> 2); }
        for p in 0..np {
            let it = g(node, g(item, p) as usize);
            s(item, p, it);
            s(anc, p * l + lv, (total as i32) + it);
        }
        s(lev_n, lv, n1 as i32);
        total += n1;
        core::mem::swap(&mut cx, &mut nx);
        core::mem::swap(&mut cy, &mut ny);
        n0 = n1;
        lv += 1;
        if dwx <= 1 && dhy <= 1 { break; }
    }
    let lv_count = lv;
    // (Levels as the loop made them: l was counted the same way.)
    let _ = lv_count;
    let cin_a: *mut u16 = b.alloc(O_CIN, total, true);
    let dn: *mut i32 = b.alloc(O_DN, total, true);
    let dno: *mut i32 = b.alloc(O_DNO, total + 1, true);
    let didx: *mut i32 = b.alloc(O_DIDX, k * l, true);
    if cin_a.is_null() || dn.is_null() || dno.is_null() || didx.is_null() { return; }
    // (cinA[base + d]: the level above's place of node d (cinUp of level lv,
    // the children's places counted over level lv + 1's items).)
    let mut base = 0usize;
    for v in 0..l {
        let n = g(lev_n, v) as usize;
        if v + 1 < l {
            let up = lev_cin.add(item_base(lev_n, v + 1, np));
            for d in 0..n { s(cin_a, base + d, g(up, d)); }
        }
        base += n;
    }
    for v in 0..l { for e in 0..k { let d = g(anc, g(npart, e) as usize * l + v) as usize; s(dn, d, g(dn, d) + 1); } }
    for d in 0..total { s(dno, d + 1, g(dno, d) + g(dn, d)); }
    let dnodes: *mut i32 = b.alloc(O_DNODES, g(dno, total).max(0) as usize, true);
    let fill: *mut i32 = b.temp(total);
    if dnodes.is_null() || fill.is_null() { return; }
    for d in 0..total { s(fill, d, 0); }
    for v in 0..l {
        for e in 0..k {
            let d = g(anc, g(npart, e) as usize * l + v) as usize;
            let x = g(fill, d);
            s(fill, d, x + 1);
            s(dnodes, (g(dno, d) + x) as usize, e as i32);
            s(didx, e * l + v, x);
        }
    }
    let rco: *mut i32 = b.alloc(O_RCO, total, true);
    if rco.is_null() { return; }
    let (mut pool, mut nj) = (0i64, 0i64);
    for d in 0..total {
        s(rco, d, pool as i32);
        let nch = g(lev_nch, d);
        if nch > 1 { pool += nch as i64 * g(dn, d) as i64; nj += nch as i64; }
    }
    if pool > i32::MAX as i64 || nj * 3 > i32::MAX as i64 { b.hs(H_FULL, 1); return; }
    let rc: *mut u32 = b.alloc(O_RC, pool as usize, false);
    let jobs: *mut i32 = b.alloc(O_JOBS, (nj as usize * 3).max(3), true);
    if rc.is_null() || jobs.is_null() { return; }
    let mut jx_ = 0usize;
    let mut base = 0usize;
    for v in 0..l {
        let n = g(lev_n, v) as usize;
        for d in base..base + n {
            let nch = g(lev_nch, d);
            if nch > 1 { for t in 0..nch { s(jobs, jx_, d as i32); s(jobs, jx_ + 1, t); s(jobs, jx_ + 2, v as i32); jx_ += 3; } }
        }
        base += n;
    }
    b.hs(H_TOTAL, total as i32);
    b.hs(H_L, l as i32);
    b.hs(H_POOL, pool as i32);
    b.hs(H_NJ, nj as i32);
}
/// Where level lv's items' children places start in the scratch (level 0:
/// the parts, then each level's nodes are the next level's items).
#[inline(always)]
unsafe fn item_base(lev_n: *const i32, lv: usize, np: usize) -> usize {
    let mut o = 0usize;
    for v in 0..lv { o += if v == 0 { np } else { g(lev_n, v - 1) as usize }; }
    o
}

/// navAtlasTables: the clusters' tables' places (cn[c]^2 entries each).
unsafe fn atlas_tables(b: &B, nc: i32) {
    if b.hv(H_NP) <= 0 { return; }
    let nc = nc.max(0) as usize;
    let cn = b.at::<i32>(O_CN);
    let co: *mut i32 = b.alloc(O_CO, nc + 1, true);
    if co.is_null() { return; }
    for c in 0..nc { let v = g(cn, c); s(co, c + 1, g(co, c) + v * v); }
    if b.alloc::<u32>(O_CT, g(co, nc).max(0) as usize, false).is_null() { return; }
}

/// navAtlasFinish: the clear prefix (an 8x8 block with any wall counts) and
/// the header the kernels read (atlas.rs Atl, navAtlasHeader's words).
unsafe fn atlas_finish(b: &B, w: i32, h: i32, c: i32, cw: i32) {
    if b.hv(H_NP) <= 0 { return; }
    let bw = cdiv(w, 8);
    let bh = (h + 7) >> 3;
    let stride = (bw + 1) as usize;
    let cp: *mut i32 = b.alloc(O_CLEAR, stride * (bh as usize + 1), true);
    let hd: *mut i32 = b.alloc(O_ATLH, 24, true);
    if cp.is_null() || hd.is_null() { return; }
    let bm = b.at::<u32>(O_BM);
    for y in 0..bh as usize {
        let mut row = 0i32;
        for x in 0..bw as usize {
            let kk = (y * bw as usize + x) * 2;
            if (g(bm, kk) | g(bm, kk + 1)) != 0 { row += 1; }
            s(cp, (y + 1) * stride + x + 1, g(cp, y * stride + x + 1) + row);
        }
    }
    s(hd, 0, b.hv(H_L)); s(hd, 1, c); s(hd, 2, cw); s(hd, 3, bw); s(hd, 4, b.hv(H_NP));
    // (One by one: a table of them would be a data segment.)
    s(hd, 5, b.enc(O_BM)); s(hd, 6, b.enc(O_BC)); s(hd, 7, b.enc(O_CB)); s(hd, 8, b.enc(O_CO)); s(hd, 9, b.enc(O_CT));
    s(hd, 10, b.enc(O_ANC)); s(hd, 11, b.enc(O_CIP)); s(hd, 12, b.enc(O_CIN)); s(hd, 13, b.enc(O_RCO)); s(hd, 14, b.enc(O_RC));
    s(hd, 15, b.enc(O_DN)); s(hd, 16, b.enc(O_NPART)); s(hd, 17, b.enc(O_CN)); s(hd, 18, b.enc(O_DIDX)); s(hd, 19, b.enc(O_NODEBASE));
    s(hd, 20, b.enc(O_CLEAR));
}
