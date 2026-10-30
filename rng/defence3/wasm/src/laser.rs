//! Laser links and beams (tower.js laserBeamsTick), kept by lines: a laser's
//! links depend only on its row and column (the lasers there, their owners,
//! levels and construction, the walls between), so a change marks those two
//! lines and only they are worked out again (k_laser_lines), from the lines'
//! own laser lists. Each tick the beams' damage (k_laser_dmg); their effect on
//! the tiles between their lasers is the tile effects' pass (tfx.rs).
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
/// Partners a laser keeps per direction (right, left, down, up; more than one
/// only past lasers under construction, which are not walls).
pub const LZ_DIR: usize = 4;
pub const LZ_PART: usize = 4 * LZ_DIR;

struct Lines {
    code: *mut u8, brain: *mut i32, own: *mut i32, uc: *mut u8, val: *mut f64, rrow: *mut i32, ctype: *mut u8,
    lslot: *mut i32, slt: *mut i32, sfree: *mut i32, part: *mut i32, pn: *mut i32,
    rhead: *mut i32, chead: *mut i32, rnext: *mut i32, cnext: *mut i32, sb: *mut i32, sbn: *mut i32,
    ba: *mut i32, bb: *mut i32, bown: *mut i32, bfree: *mut i32, blive: *mut u8, walk: *mut u8, elev: *mut i8, blev: *mut i8, hdr: *mut i32,
    w: i32, h: i32, wall: u8, ty: i32, scap: i32, bcap: i32,
}
impl Lines {
    #[inline(always)]
    unsafe fn is_laser(&self, t: usize) -> bool { g(self.code, t) == 0x22 && (g(self.brain, t) & 65535) == self.ty }
    // (getThingEffectiveLevel: its effective level, else its level, else 1.)
    #[inline(always)]
    unsafe fn level(&self, t: usize) -> i32 {
        let r = g(self.rrow, t); if r < 0 { return 1; }
        let v = g(self.elev, r as usize); if v != -128 { return v as i32; }
        let b = g(self.blev, r as usize); if b != -128 { (b as i32).max(1) } else { 1 }
    }
    // A slot into its row's (or column's) list, kept in the line's order.
    unsafe fn link(&mut self, head: *mut i32, next: *mut i32, line: usize, sl: i32, key: i32, horiz: bool) {
        let w = self.w;
        let pos = |s: i32, slt: *mut i32| -> i32 { let t = g(slt, s as usize); if horiz { irem(t, w) } else { idiv(t, w) } };
        let mut prev = -1i32;
        let mut cur = g(head, line);
        while cur >= 0 && pos(cur, self.slt) < key { prev = cur; cur = g(next, cur as usize); }
        s(next, sl as usize, cur);
        if prev < 0 { s(head, line, sl); } else { s(next, prev as usize, sl); }
    }
    unsafe fn unlink(&mut self, head: *mut i32, next: *mut i32, line: usize, sl: i32) {
        let mut prev = -1i32;
        let mut cur = g(head, line);
        while cur >= 0 && cur != sl { prev = cur; cur = g(next, cur as usize); }
        if cur < 0 { return; }
        let nx = g(next, sl as usize);
        if prev < 0 { s(head, line, nx); } else { s(next, prev as usize, nx); }
    }
    unsafe fn add(&mut self, t: usize) {
        let n = g(self.sfree, 0);
        let sl = if n > 0 { s(self.sfree, 0, n - 1); g(self.sfree, n as usize) } else { let hw = g(self.hdr, 0); if hw >= self.scap { return; } s(self.hdr, 0, hw + 1); hw };
        s(self.lslot, t, sl); s(self.slt, sl as usize, t as i32);
        for d in 0..4 { s(self.pn, sl as usize * 4 + d, 0); }
        s(self.sbn, sl as usize * 2, 0); s(self.sbn, sl as usize * 2 + 1, 0);
        let (x, y) = (irem(t as i32, self.w), idiv(t as i32, self.w));
        let (rh, rn, ch, cn) = (self.rhead, self.rnext, self.chead, self.cnext);
        self.link(rh, rn, y as usize, sl, x, true);
        self.link(ch, cn, x as usize, sl, y, false);
    }
    unsafe fn remove(&mut self, t: usize) {
        let sl = g(self.lslot, t);
        if sl < 0 { return; }
        self.free_started(sl as usize, 0); self.free_started(sl as usize, 1);
        let (x, y) = (irem(t as i32, self.w), idiv(t as i32, self.w));
        let (rh, rn, ch, cn) = (self.rhead, self.rnext, self.chead, self.cnext);
        self.unlink(rh, rn, y as usize, sl);
        self.unlink(ch, cn, x as usize, sl);
        s(self.lslot, t, -1); s(self.slt, sl as usize, -1);
        let n = g(self.sfree, 0); s(self.sfree, (n + 1) as usize, sl); s(self.sfree, 0, n + 1);
    }
    // The beams a laser started along an orientation (0 its row, 1 its column) let go.
    unsafe fn free_started(&mut self, sl: usize, o: usize) {
        for q in 0..g(self.sbn, sl * 2 + o) as usize {
            let b = g(self.sb, sl * 8 + o * 4 + q);
            if b < 0 || g(self.blive, b as usize) == 0 { continue; }
            s(self.blive, b as usize, 0);
            let n = g(self.bfree, 0); s(self.bfree, (n + 1) as usize, b); s(self.bfree, 0, n + 1);
            s(self.hdr, 2, g(self.hdr, 2) - 1);
        }
        s(self.sbn, sl * 2 + o, 0);
    }
    // A laser's partners in one direction: along it another laser of its
    // owner with 1 <= gap <= the smaller level, no wall between; every tile
    // looked at marked (a wall set or cleared there marks the line again).
    unsafe fn partners(&mut self, t: usize, d: usize) {
        let sl = g(self.lslot, t) as usize;
        let (x, y) = (irem(t as i32, self.w), idiv(t as i32, self.w));
        let (dx, dy) = [(1, 0), (-1, 0), (0, 1), (0, -1)][d];
        let (o, l1) = (g(self.own, t), self.level(t));
        let mut m = 0usize;
        let mut dist = 1;
        loop {
            let (nx, ny) = (x + dx * dist, y + dy * dist);
            if nx < 0 || ny < 0 || nx >= self.w || ny >= self.h { break; }
            let u = (ny * self.w + nx) as usize;
            s(self.walk, u, 1);
            let gap = dist - 1;
            if gap > l1 { break; }
            if g(self.lslot, u) >= 0 && g(self.own, u) == o && gap >= 1 && gap <= l1.min(self.level(u)) && m < LZ_DIR {
                s(self.part, sl * LZ_PART + d * LZ_DIR + m, u as i32); m += 1;
            }
            if g(self.ctype, u) == self.wall { break; }
            dist += 1;
        }
        s(self.pn, sl * 4 + d, m as i32);
    }
    // A marked line: its lasers' beams of the orientation let go, their
    // partners along it, then its beams again, in the line's order (each from
    // a built laser with energy to its partners ahead: right, down).
    unsafe fn line(&mut self, horiz: bool, line: usize) {
        let (head, next, o, d0) = if horiz { (self.rhead, self.rnext, 0usize, 0usize) } else { (self.chead, self.cnext, 1, 2) };
        let mut sl = g(head, line);
        while sl >= 0 { self.free_started(sl as usize, o); sl = g(next, sl as usize); }
        sl = g(head, line);
        while sl >= 0 { let t = g(self.slt, sl as usize) as usize; self.partners(t, d0); self.partners(t, d0 + 1); sl = g(next, sl as usize); }
        sl = g(head, line);
        while sl >= 0 {
            let su = sl as usize;
            let t = g(self.slt, su) as usize;
            if g(self.uc, t) == 0 && g(self.val, t) > 0.0 {
                for q in 0..g(self.pn, su * 4 + d0) as usize {
                    let u = g(self.part, su * LZ_PART + d0 * LZ_DIR + q);
                    let n = g(self.bfree, 0);
                    let b = if n > 0 { s(self.bfree, 0, n - 1); g(self.bfree, n as usize) } else { let hw = g(self.hdr, 1); if hw >= self.bcap { continue; } s(self.hdr, 1, hw + 1); hw };
                    let bu = b as usize;
                    s(self.blive, bu, 1); s(self.hdr, 2, g(self.hdr, 2) + 1);
                    s(self.ba, bu, t as i32); s(self.bb, bu, u);
                    let ow = g(self.own, t);
                    s(self.bown, bu, if ow >= 0 && ow < 0x7ff9 { ow } else { -999 });
                    let c = g(self.sbn, su * 2 + o) as usize;
                    if c < 4 { s(self.sb, su * 8 + o * 4 + c, b); s(self.sbn, su * 2 + o, (c + 1) as i32); }
                }
            }
            sl = g(next, su);
        }
    }
}

/// SIM_KERNEL_LASER_LINES (one job): the lasers' slots and their row and
/// column lists (lz.rhead / lz.chead, lz.rnext / lz.cnext: kept in the
/// line's order) from the events (lz.ev, lz.hdr[4] tiles: a laser placed or
/// gone there; lz.hdr[5] 1: every tile looked at, all slots and beams let go
/// first), then every marked row (lz.rdirty) and column (lz.cdirty), rows
/// first, each mark cleared: its lasers' beams of the orientation let go
/// (lz.sb, the beams each started, lz.sbn), their partners along it
/// (lz.part, LZ_DIR a direction, lz.pn), its beams made again (lz.ba / lz.bb
/// / lz.bown, lz.blive, lz.bfree). lz.hdr: [0] slots used, [1] beams used, [2]
/// beams live. Arrays: st.code, st.brain, st.own, st.uc, st.val, st.rrow,
/// cell.type, lz.lslot, lz.slt, lz.sfree, lz.part, lz.pn, lz.rhead,
/// lz.chead, lz.rnext, lz.cnext, lz.sb, lz.sbn, lz.ba, lz.bb, lz.bown,
/// lz.bfree, lz.blive, lz.walk, tower effectiveLevel, tower level, lz.hdr,
/// lz.rdirty, lz.cdirty, lz.ev. P: [0] W, [1] H, [2] TYPE_WALL, [3] the
/// laser's stationary type, [4] slots, [5] beams.
#[no_mangle]
pub unsafe extern "C" fn k_laser_lines(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let mut l = Lines {
        code: k.p(0), brain: k.p(1), own: k.p(2), uc: k.p(3), val: k.p(4), rrow: k.p(5), ctype: k.p(6),
        lslot: k.p(7), slt: k.p(8), sfree: k.p(9), part: k.p(10), pn: k.p(11),
        rhead: k.p(12), chead: k.p(13), rnext: k.p(14), cnext: k.p(15), sb: k.p(16), sbn: k.p(17),
        ba: k.p(18), bb: k.p(19), bown: k.p(20), bfree: k.p(21), blive: k.p(22), walk: k.p(23), elev: k.p(24), blev: k.p(25), hdr: k.p(26),
        w: k.i(0).max(1), h: k.i(1).max(0), wall: k.i(2) as u8, ty: k.i(3) + 1, scap: k.i(4).max(0), bcap: k.i(5).max(0),
    };
    let (rd, cd, ev) = (k.p::<u8>(27), k.p::<u8>(28), k.p::<i32>(29));
    let n = (l.w * l.h) as usize;
    if g(l.hdr, 5) != 0 {
        // Every tile: the slots and beams start over (a restore, the map's first).
        for t in 0..n { s(l.lslot, t, -1); }
        for y in 0..l.h as usize { s(l.rhead, y, -1); }
        for x in 0..l.w as usize { s(l.chead, x, -1); }
        s(l.sfree, 0, 0); s(l.bfree, 0, 0);
        for b in 0..g(l.hdr, 1).max(0) as usize { s(l.blive, b, 0); }
        s(l.hdr, 0, 0); s(l.hdr, 1, 0); s(l.hdr, 2, 0);
        let mut t = 0usize;
        while t + 16 <= n {
            let mut bits = i8x16_bitmask(i8x16_eq(v128_load(l.code.add(t) as *const v128), i8x16_splat(0x22))) as u32;
            while bits != 0 { let u = t + bits.trailing_zeros() as usize; bits &= bits - 1; if l.is_laser(u) { l.add(u); } }
            t += 16;
        }
        while t < n { if l.is_laser(t) { l.add(t); } t += 1; }
        for y in 0..l.h as usize { s(rd, y, (g(l.rhead, y) >= 0) as u8); }
        for x in 0..l.w as usize { s(cd, x, (g(l.chead, x) >= 0) as u8); }
        s(l.hdr, 5, 0);
    }
    for i in 0..g(l.hdr, 4).max(0) as usize {
        let t = g(ev, i);
        if t < 0 || t as usize >= n { continue; }
        let tu = t as usize;
        let (is, sl) = (l.is_laser(tu), g(l.lslot, tu));
        if is && sl < 0 { l.add(tu); } else if !is && sl >= 0 { l.remove(tu); }
        s(rd, idiv(t, l.w) as usize, 1); s(cd, irem(t, l.w) as usize, 1);
    }
    s(l.hdr, 4, 0);
    for y in 0..l.h as usize { if g(rd, y) != 0 { l.line(true, y); s(rd, y, 0); } }
    for x in 0..l.w as usize { if g(cd, x) != 0 { l.line(false, x); s(cd, x, 0); } }
}

/// SIM_KERNEL_LASER_DMG (one job): every live beam's damage (lz.bdmg) from
/// its lasers' damage summed / 60, each from the static stat tables (its
/// building key adj.tykey, base level from the descriptor, its owner's
/// damage research adj.rlv[4 x + 3] and boost adj.bl: stt.dmg), or a custom
/// tower's own (the descriptor's custom bit: tc.dmg by row); and the beams
/// in canonical order (lz.border: sorted by first laser's tile, then
/// orientation; LSD radix over lz.bkeys) for the structure hits. Arrays:
/// lz.ba, lz.bb, lz.blive, lz.bdmg, st.brain, st.own, st.rrow, adj.tykey,
/// adj.rlv, adj.bl, stt.dmg, tc.dmg, lz.bkeys, lz.border, lz.hdr. P: [0]
/// keys, [1] levels + 1, [2] research + 1, [3] types, [4] MAX_THING_LEVEL,
/// [5] players, [6] W.
#[no_mangle]
pub unsafe extern "C" fn k_laser_dmg(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ba, bb, blive, bdmg, brain, own, rrow) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<u8>(2), k.p::<f32>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6));
    let (tykey, rlv, bl, sdmg, tcd, keys, order, hdr) = (k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9), k.p::<f32>(10), k.p::<f32>(11), k.p::<u64>(12), k.p::<i32>(13), k.p::<i32>(14));
    let (nk, l1, r1, nt, maxl, np, w) = (k.i(0), k.i(1).max(1) as usize, k.i(2).max(1) as usize, k.i(3), k.i(4).max(1), k.i(5), k.i(6).max(1));
    let dmg_of = |t: usize| -> f32 {
        let bw = g(brain, t);
        let r = g(rrow, t);
        if (bw >> 25) & 1 != 0 && r >= 0 && !tcd.is_null() { let v = g(tcd, r as usize); return if v == v { v } else { 0.0 }; }
        let ty = (bw & 65535) - 1;
        let kb = if ty >= 0 && ty < nt { g(tykey, ty as usize) } else { -1 };
        if kb < 0 || kb >= nk { return 0.0; }
        let o = g(own, t);
        let oi = if o < 0 || o >= np { 0 } else { o + 1 };
        let x = (oi * nk + kb) as usize;
        let base = ((bw >> 16) & 255).max(1);
        let blv = g(bl, x);
        let lv = (if blv > 0 { (base + blv).min(maxl) } else { base.min(maxl) }) as usize;
        let v = g(sdmg, (kb as usize * l1 + lv) * r1 + g(rlv, 4 * x + 3) as usize);
        if v == v { v } else { 0.0 }
    };
    let hw = g(hdr, 1).max(0) as usize;
    let mut n = 0usize;
    for b in 0..hw {
        if g(blive, b) == 0 { continue; }
        let (t, u) = (g(ba, b) as usize, g(bb, b) as usize);
        s(bdmg, b, (dmg_of(t) + dmg_of(u)) / 60.0);
        let vert = (u - t) >= w as usize;
        s(keys, n, ((((t as u64) << 1) | vert as u64) << 32) | b as u64); n += 1;
    }
    // (LSD radix, 8 bits a pass over the key bits above the beam id: tile
    // and orientation; the id below them never decides.)
    let tmp = keys.add(n);
    let (mut src, mut dst) = (keys, tmp);
    for pass in 4..8 {
        let shift = pass * 8;
        let mut cnt = [0usize; 257];
        for i in 0..n { cnt[((g(src, i) >> shift) & 255) as usize + 1] += 1; }
        for i in 0..256 { cnt[i + 1] += cnt[i]; }
        for i in 0..n { let v = g(src, i); let bkt = ((v >> shift) & 255) as usize; s(dst, cnt[bkt], v); cnt[bkt] += 1; }
        core::mem::swap(&mut src, &mut dst);
    }
    for i in 0..n { s(order, i, (g(src, i) & 0xffff_ffff) as i32); }
    s(hdr, 3, n as i32);
}

/// SIM_KERNEL_LASER_REPORT (one job): the units' beam damage reports (the
/// hits kernel's lists: per job of P[1] slots from its first, lz.count[job]
/// of them): the energy each lost into its owner's shrine sum (fixed point
/// P[2], rounded: integers, any order); the first P[3] as looks (lz.look
/// [slot, beam, damage * 1024]); every report's sum cleared. Arrays:
/// lz.list, lz.count, unit.lzAcc, unit.lzBeam, unit.owner, unit.energy,
/// lz.shrine (f64 per owner), lz.look, lz.lcnt2. P: [0] jobs, [1] per job,
/// [2] scale, [3] looks, [4] owners.
#[no_mangle]
pub unsafe extern "C" fn k_laser_report(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (list, cnt, acc, lb, own, en, shrine, look, lcnt) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<f32>(2), k.p::<i32>(3), k.p::<i8>(4), k.p::<f32>(5),
        k.p::<f64>(6), k.p::<i32>(7), k.p::<i32>(8));
    let (jobs, per, scale, looks, nown) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.f(2), k.i(3).max(0) as usize, k.i(4));
    let mut nl = 0usize;
    for j in 0..jobs {
        for q in j * per..j * per + g(cnt, j).max(0) as usize {
            let sl = g(list, q) as usize;
            let d = g(acc, sl) as f64;
            if !(d > 0.0) { s(acc, sl, 0.0); continue; }
            let o = g(own, sl) as i32;
            let after = g(en, sl) as f64;
            let lost = if after < 0.0 { d + after } else { d };
            if o >= 0 && o < nown && lost > 0.0 { s(shrine, o as usize, g(shrine, o as usize) + floor(lost * scale + 0.5)); }
            if nl < looks { s(look, 3 * nl, sl as i32); s(look, 3 * nl + 1, g(lb, sl)); s(look, 3 * nl + 2, floor(d * 1024.0 + 0.5) as i32); nl += 1; }
            s(acc, sl, 0.0);
        }
    }
    s(lcnt, 0, nl as i32);
}
