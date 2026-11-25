//! Units waiting for their way (a pending target: pathfinding.js), in one
//! serial pass on the simulation thread: the units due this tick taken from
//! the wheel (a bucket a tick through the units' ppDue / ppNext / ppPrev),
//! each, by its source's priority and then its id, given its way to its
//! target when it can get there now (one navigation node; its order goes on
//! as given), else toward the closest tile it can reach (the helpers'
//! substitute: asked for once, its answer taken NAV_SUB_TICKS later, from a
//! table shared with the JavaScript), else waiting where it is until a new
//! navigation build; then each scheduled again by its retry tick. Every
//! write is the JavaScript setters' (Unit.path, pathIndex, commandState,
//! pathIsFallbackAstar, _pendingPathTarget, _astarBudgetRetryTick), with the
//! object fields' digest terms (sim_unit_state.js _simHTermE). Also one
//! unit at a time for the event callers (mode 1: no wheel).
use super::*;
use super::k::K;
use crate::tch::{nearest_walk, WalkWhere};
use crate::nfs::{hterm, H_NULL, H_UNDEF};

#[inline(always)]
unsafe fn g<T: Copy>(p: *const T, i: usize) -> T {
    *p.add(i)
}
#[inline(always)]
unsafe fn s<T>(p: *mut T, i: usize, v: T) {
    *p.add(i) = v;
}

// (The substitutes' table: entries of three words, key word (profile *
// 4194304 + component) + 1 (0 empty), destination tile, answer (-2 asked,
// -1 none, else the tile); a power of two of them. flownav.js _navSubT* the same.)
#[inline(always)]
fn sub_hash(k1: i32, to: i32, mask: u32) -> u32 {
    ((k1 as u32).wrapping_mul(0x9E37_79B1) ^ (to as u32).wrapping_mul(0x85EB_CA77)).wrapping_add((to as u32) >> 7) & mask
}
/// The entry of a key: its index, or the empty one it would take (found: false).
unsafe fn sub_find(t: *mut i32, mask: u32, k1: i32, to: i32) -> (usize, bool) {
    let mut h = sub_hash(k1, to, mask);
    loop {
        let e = (h as usize) * 3;
        let kw = g(t, e);
        if kw == 0 { return (e, false); }
        if kw == k1 + 1 && g(t, e + 1) == to { return (e, true); }
        h = (h + 1) & mask;
    }
}

const RECHECK: i32 = 256;
// (Unit.path kinds: none, an empty one, one navigation node.)
const PATH_NONE: i32 = -2;
const PATH_EMPTY: i32 = -1;

struct Pp {
    // the units' columns
    pt_st: *mut u8, pt_gx: *mut i16, pt_gy: *mut i16, pt_cmd: *mut u8, pt_src: *mut u8, pt_ver: *mut i32, pt_at: *mut i32, pt_sub: *mut i32,
    dead: *mut u8, live: *mut u8, id: *mut i32, x: *mut i32, y: *mut i32, retry: *mut f64, hobj: *mut i32,
    nvpk: *mut i32, pthh: *mut i32, pidx: *mut i32, cmd: *mut u8, on: *mut u8, steer: *mut i32, mpath: *mut i32, mfree: *mut i32,
    mvpf: *mut u8, mvpp: *mut u8, fly: *mut u8, wkix: *mut i32, wbt: *mut u8, own: *mut i8, dirty: *mut u8,
    // the path store
    arena: *mut i32, afree: *mut i32, top: i32, alen: i32,
    // navigation by profile: walls, partL, partBase, partComp; cs, cw, seq (every route on the atlas: a node's ready 0)
    wall: [*const u8; 3], pl: [*const u16; 3], pb: [*const i32; 3], pc: [*const i32; 3], cs: [i32; 3], cw: [i32; 3], seq: [i32; 3],
    // where a unit may stand (findNearestWalkable)
    ww: WalkWhere, bwall: *const u8,
    // the substitutes: table, requests (profile, to, component), their count and room
    // (asks: every ask this tick, found or not: the same count on every peer, whatever each one's table holds.)
    st: *mut i32, smask: u32, sreq: *mut i32, nreq: i32, rroom: i32, asks: i32, sub_ticks: i32,
    now: i32, gw: i32, gh: i32, tile: f64, kppt: i32, kpfa: i32, krt: i32, err: i32,
    // (Unit.path as its getter read it is the stored one: navPathReach's previous.)
    cur_ok: bool,
}

impl Pp {
    #[inline(always)]
    unsafe fn mark(&self, q: usize) { if !self.dirty.is_null() { s(self.dirty, q, 1); } }
    // ---- digest words (sim_unit_state.js _simPptEnc, _simPfaEnc, _simHEnc) ----
    #[inline(always)]
    unsafe fn ppt_enc(&self, q: usize) -> i32 {
        let t = g(self.pt_st, q) & 3;
        if t == 2 { -16 - (g(self.pt_gy, q) as i32 * 65536 + g(self.pt_gx, q) as i32) } else if t == 1 { H_NULL } else { H_UNDEF }
    }
    #[inline(always)]
    unsafe fn pfa_enc(&self, q: usize) -> i32 {
        let t = (g(self.pt_st, q) >> 2) & 3;
        if t == 2 { 0x3bd } else if t == 1 { 0x2bd } else { H_UNDEF }
    }
    unsafe fn mirror(&self, q: usize) {
        let t = g(self.pt_st, q);
        let (p, f) = ((t & 3) == 2, ((t >> 2) & 3) == 2);
        s(self.mvpf, q, (p && f) as u8);
        s(self.mvpp, q, (f as u8) | ((p as u8) << 1));
    }
    #[inline(always)]
    unsafe fn hadd(&self, q: usize, key: i32, e1: i32, e0: i32) {
        if e1 != e0 { s(self.hobj, q, g(self.hobj, q).wrapping_add(hterm(key, e1)).wrapping_sub(hterm(key, e0))); }
    }
    /// u._pendingPathTarget = null.
    unsafe fn target_null(&self, q: usize) {
        let e0 = self.ppt_enc(q);
        s(self.pt_st, q, (g(self.pt_st, q) & !3) | 1);
        self.hadd(q, self.kppt, H_NULL, e0);
        self.mirror(q);
    }
    /// u.pathIsFallbackAstar = v.
    unsafe fn flag(&self, q: usize, v: bool) {
        let st = g(self.pt_st, q);
        let n: u8 = if v { 2 } else { 1 };
        if (st >> 2) & 3 != n {
            let e0 = self.pfa_enc(q);
            s(self.pt_st, q, (st & !12) | (n << 2));
            self.hadd(q, self.kpfa, self.pfa_enc(q), e0);
        }
        self.mirror(q);
    }
    /// u._astarBudgetRetryTick = t (a whole tick).
    unsafe fn set_retry(&self, q: usize, t: i32) {
        let old = g(self.retry, q);
        s(self.retry, q, t as f64);
        if old == t as f64 { return; }
        self.hadd(q, self.krt, num_enc(t as f64), num_enc(old));
    }
    unsafe fn set_cmd(&self, q: usize, v: u8) {
        if g(self.cmd, q) != v { s(self.on, q, 0); self.mark(q); }
        s(self.cmd, q, v);
    }
    unsafe fn set_pidx(&self, q: usize, v: i32) {
        if g(self.pidx, q) != v { s(self.on, q, 0); self.mark(q); }
        s(self.pidx, q, v);
    }
    /// u.path = none / [] / [node] (profile p, tile t): its key, its block
    /// (the same block when it is that node already), its movement window
    /// back, disarmed (Unit's path setter).
    unsafe fn set_path(&mut self, q: usize, p: i32, t: i32, reuse: bool) {
        s(self.nvpk, q, if p >= 0 { (p * 16777216 + t) * 2 } else { -1 });
        let h = g(self.mpath, q);
        if h >= 0 { let m = g(self.mfree, 0) + 1; s(self.mfree, 0, m); s(self.mfree, m as usize, h); s(self.mpath, q, -1); }
        let old = g(self.pthh, q);
        let nh = if p == PATH_NONE { 0 } else if p == PATH_EMPTY { 1 } else if reuse && self.is_node(old, p, t) { old } else { self.store(p, t) };
        if nh != old {
            path_drop(old, self.arena, self.afree);
            s(self.pthh, q, nh);
        }
        s(self.on, q, 0);
        s(self.steer, q * 8, -1);
        self.mark(q);
    }
    /// Whether handle h is the one-node path toward t on profile p (as navNode made it now).
    unsafe fn is_node(&self, h: i32, p: i32, t: i32) -> bool {
        if h < 2 { return false; }
        let b = (h - 2) as usize;
        (g(self.arena, b) & 0xffffff) == 1 && g(self.arena, b + 3) == t && g(self.arena, b + 4) == ((p + 1) & 31) && g(self.arena, b + 5) == 0
    }
    /// A one-node block (sim_unit_state.js simPathStore: class 3, eight words).
    unsafe fn store(&mut self, p: i32, t: i32) -> i32 {
        self.store_node(p, t, false)
    }
    /// The length of Unit.path as its getter reads it: the stored path when
    /// its last node is the route key's (nvPK), none without a key, else the
    /// key's one node (wide by its bit, ready 0), stored in its place.
    unsafe fn cur_len(&mut self, q: usize) -> i32 {
        let (h, k) = (g(self.pthh, q), g(self.nvpk, q));
        let mut lk = -1;
        if h >= 2 {
            let b = (h - 2) as usize;
            let n = (g(self.arena, b) & 0xffffff) as usize;
            if n > 0 {
                let o = b + 3 + 3 * (n - 1);
                let f = g(self.arena, o + 1);
                if f & 31 != 0 { lk = (((f & 31) - 1) * 16777216 + g(self.arena, o)) * 2 + ((f & 32 != 0) as i32); }
            }
        }
        self.cur_ok = true;
        if lk == k { return self.path_len(h); }
        if k < 0 { self.cur_ok = false; return 0; }
        let key = k >> 1;
        let p = idiv(key, 16777216);
        // (As the getter: the old one let go first, then the node stored.)
        path_drop(h, self.arena, self.afree);
        let nh = self.store_node(p, key - p * 16777216, (k & 1) != 0);
        s(self.pthh, q, nh);
        1
    }
    /// (Its ready word 0: on the atlas a route starts at once, flownav.js navNode.)
    unsafe fn store_node(&mut self, p: i32, t: i32, wide: bool) -> i32 {
        const CLS: usize = 3;
        let mut b = g(self.afree, CLS);
        if b >= 0 { s(self.afree, CLS, g(self.arena, b as usize + 1)); }
        else {
            if self.top + 8 > self.alen { self.err |= 1; return 1; }
            b = self.top; self.top += 8;
            s(self.arena, b as usize + 2, 0);
        }
        let b = b as usize;
        s(self.arena, b, 1 | ((CLS as i32) << 24));
        s(self.arena, b + 1, 1);
        s(self.arena, b + 3, t);
        s(self.arena, b + 4, ((p + 1) & 31) | if wide { 32 } else { 0 });
        s(self.arena, b + 5, 0);
        b as i32 + 2
    }
    /// The path's length (Unit.path from its handle).
    #[inline(always)]
    unsafe fn path_len(&self, h: i32) -> i32 { if h < 2 { 0 } else { g(self.arena, (h - 2) as usize) & 0xffffff } }
    // ---- navigation (flownav.js) ----
    /// navProfileOf: flying the air's, builders and salvagers the class one, else the ground's.
    unsafe fn profile(&self, q: usize) -> i32 {
        if g(self.fly, q) != 0 { return 1; }
        let w = g(self.wkix, q);
        if w > 0 { let b = g(self.wbt, w as usize); if b == 3 || b == 4 { return 2; } }
        0
    }
    /// navCompOf.
    unsafe fn comp(&self, p: usize, t: i32) -> i32 {
        let pl = (*self.pl.get_unchecked(p));
        if pl.is_null() || t < 0 || t >= self.gw * self.gh { return -1; }
        let l = g(pl, t as usize);
        if l == 0xFFFF { return -1; }
        let (x, y) = (irem(t, self.gw), idiv(t, self.gw));
        g((*self.pc.get_unchecked(p)), (g((*self.pb.get_unchecked(p)), ((y >> (*self.cs.get_unchecked(p))) * (*self.cw.get_unchecked(p)) + (x >> (*self.cs.get_unchecked(p)))) as usize) + l as i32) as usize)
    }
    /// navApproachTile on the profile's walls (rings out to six).
    unsafe fn approach(&self, p: usize, t: i32) -> i32 {
        let (gw, gh) = (self.gw, self.gh);
        let wall = (*self.wall.get_unchecked(p));
        if !(t >= 0 && t < gw * gh) { return -1; }
        if wall.is_null() || g(wall, t as usize) == 0 { return t; }
        let (tx, ty) = (irem(t, gw), idiv(t, gw));
        let mut r = -1;
        let mut d: i32 = 1;
        while d <= 6 && r < 0 {
            let mut best = i32::MAX;
            for dy in -d..=d {
                for dx in -d..=d {
                    if dx.abs().max(dy.abs()) != d { continue; }
                    let (x, y) = (tx + dx, ty + dy);
                    if x < 0 || y < 0 || x >= gw || y >= gh || g(wall, (y * gw + x) as usize) != 0 { continue; }
                    let dd = dx.abs() + dy.abs();
                    if dd < best { best = dd; r = y * gw + x; }
                }
            }
            d += 1;
        }
        r
    }
    /// _navUnitComp: its tile's, or (on a wall) its first open side's (N, S, W, E), else its approach tile's.
    unsafe fn unit_comp(&self, p: usize, t: i32) -> i32 {
        let c = self.comp(p, t);
        if c >= 0 || (*self.pl.get_unchecked(p)).is_null() || !(t >= 0 && t < self.gw * self.gh) { return c; }
        let (x, y) = (irem(t, self.gw), idiv(t, self.gw));
        let (w, h, pl) = (self.gw, self.gh, (*self.pl.get_unchecked(p)));
        // (N, S, W, E, written out: a loop by index would be a table, a data segment.)
        if y > 0 && g(pl, (t - w) as usize) != 0xFFFF { return self.comp(p, t - w); }
        if y + 1 < h && g(pl, (t + w) as usize) != 0xFFFF { return self.comp(p, t + w); }
        if x > 0 && g(pl, (t - 1) as usize) != 0xFFFF { return self.comp(p, t - 1); }
        if x + 1 < w && g(pl, (t + 1) as usize) != 0xFFFF { return self.comp(p, t + 1); }
        let a = self.approach(p, t);
        if a >= 0 { self.comp(p, a) } else { -1 }
    }
    /// navReachable.
    unsafe fn reachable(&self, p: usize, from: i32, to: i32) -> bool {
        let ct = self.comp(p, to);
        if ct < 0 { return false; }
        let c = self.comp(p, from);
        if c >= 0 || (*self.pl.get_unchecked(p)).is_null() { return c == ct; }
        let (w, h) = (self.gw, self.gh);
        let (x, y) = (irem(from, w), idiv(from, w));
        if (y > 0 && self.comp(p, from - w) == ct) || (y + 1 < h && self.comp(p, from + w) == ct)
            || (x > 0 && self.comp(p, from - 1) == ct) || (x + 1 < w && self.comp(p, from + 1) == ct) { return true; }
        self.unit_comp(p, from) == ct
    }
    /// _navGoalRecheckTick: its next look, at its own phase by id.
    #[inline(always)]
    unsafe fn recheck(&self, q: usize) -> i32 {
        let ph = irem(irem(self.now.wrapping_add(g(self.id, q)), RECHECK) + RECHECK, RECHECK);
        self.now + RECHECK - ph
    }
    /// navSubstituteRequest: asked once a key (its entry -2 till answered). False: refused, the tick's asks past
    /// the room (counted alike on every peer: a refusal by what one peer's table held, its history, made peers
    /// differ); the asker asks again next tick, reading nothing meanwhile. (The table never fills: at most a
    /// quarter full at a tick's start, the room's requests a half more.)
    unsafe fn sub_ask(&mut self, p: i32, to: i32, comp: i32) -> bool {
        self.asks += 1;
        if self.asks > self.rroom { self.err |= 2; return false; }
        let k1 = p * 4194304 + comp;
        let (e, found) = sub_find(self.st, self.smask, k1, to);
        if found { return true; }
        s(self.st, e, k1 + 1); s(self.st, e + 1, to); s(self.st, e + 2, -2);
        let r = (self.nreq * 3) as usize;
        s(self.sreq, r, p); s(self.sreq, r + 1, to); s(self.sreq, r + 2, comp);
        self.nreq += 1;
        true
    }
    /// A unit's ask (flownav.js _navSubAsk): its answer taken NAV_SUB_TICKS on; refused, asked again next tick.
    unsafe fn sub_asked(&mut self, q: usize, p: i32, to: i32, comp: i32) {
        if self.sub_ask(p, to, comp) { let ns = self.now + self.sub_ticks; s(self.pt_sub, q, ns); self.set_retry(q, ns); }
        else { s(self.pt_sub, q, 0); self.set_retry(q, self.now + 1); }
    }
    /// _tryUpgradeAstarFallbackPath (its unit has a pending target, alive).
    unsafe fn upgrade(&mut self, q: usize) {
        let rt = g(self.retry, q);
        if rt == rt && (self.now as f64) < rt { return; }
        let p = self.profile(q);
        let pu = p as usize;
        let seq = (*self.seq.get_unchecked(pu));
        // (On its way to the closest tile: looks again when there, or at its look under a newer build than the one
        // its way was chosen under (pt_ver -build): a unit that could never quite get there (a crowd on that tile)
        // never looked again, and stayed short of a destination a new wall opening made reachable.)
        if g(self.pidx, q) < self.cur_len(q) {
            let v = g(self.pt_ver, q);
            if !(v < 0 && seq > 0 && -v != seq) { let r = self.recheck(q); self.set_retry(q, r); return; }
        }
        // Waiting where it got to: only a new build changes the answer.
        if g(self.pt_ver, q) > 0 && seq > 0 && g(self.pt_ver, q) == seq { let r = self.recheck(q); self.set_retry(q, r); return; }
        s(self.pt_ver, q, 0);
        let (gw, gh) = (self.gw, self.gh);
        let ugx = floor(g(self.x, q) as f64 * 0.125 / self.tile) as i32;
        let ugy = floor(g(self.y, q) as f64 * 0.125 / self.tile) as i32;
        let here = ugy * gw + ugx;
        // Its target's tile, or the nearest it may stand on (findNearestWalkable).
        let (gx, gy) = (g(self.pt_gx, q) as i32, g(self.pt_gy, q) as i32);
        let w = g(self.wkix, q);
        let wb = if w > 0 { g(self.wbt, w as usize) } else { 0 };
        let fly = g(self.fly, q) != 0;
        self.ww.mode = if fly { 2 } else { 1 };
        self.ww.owner = g(self.own, q) as i32;
        self.ww.coll = wb == 1 || wb == 2;
        let ground = self.ww.walls;
        if (wb == 3 || wb == 4) && !fly && !self.bwall.is_null() { self.ww.walls = self.bwall; }
        let (dx, dy) = nearest_walk(&self.ww, gx, gy, ugx as f64, ugy as f64);
        self.ww.walls = ground;
        // navPathReach: one node toward the destination when it can get there.
        let to = if dx >= 0 && dy >= 0 && dx < gw && dy < gh { self.approach(pu, dy * gw + dx) } else { -1 };
        // (From its tile index, as the JavaScript's: off the map too.)
        if to >= 0 && self.reachable(pu, here, to) {
            let reuse = self.cur_ok;
            self.set_path(q, p, to, reuse);
            self.set_pidx(q, 0);
            self.flag(q, false);
            self.set_cmd(q, g(self.pt_cmd, q));
            self.target_null(q);
            return;
        }
        // navPathSubstitute: toward the closest tile it can reach, once known.
        let tsub = gy.max(0).min(gh - 1) * gw + gx.max(0).min(gw - 1);
        let comp = self.unit_comp(pu, here);
        // (None reachable: walled in, an empty path.)
        let at: i32;
        if comp < 0 { at = -1; }
        else {
            let sub = g(self.pt_sub, q);
            if !(sub > 0) || self.now < sub {
                if sub > 0 { return; }
                self.sub_asked(q, p, tsub, comp);
                return;
            }
            let (e, found) = sub_find(self.st, self.smask, p * 4194304 + comp, tsub);
            let r = if found { g(self.st, e + 2) } else { -2 };
            if r == -2 {
                self.sub_asked(q, p, tsub, comp);
                return;
            }
            at = if r < 0 { -1 } else { r };
        }
        // Walled in, or as near as it gets (on that tile, or a step from it in a crowd): it waits (its order stays).
        let (ax, ay) = if at >= 0 { (irem(at, gw), idiv(at, gw)) } else { (0, 0) };
        if at < 0 || at == here || ((ax - ugx).abs() <= 1 && (ay - ugy).abs() <= 1 && g(self.pt_at, q) == at) {
            s(self.pt_ver, q, if !(*self.pl.get_unchecked(pu)).is_null() { seq } else { 1 });
            s(self.pt_at, q, at);
            self.set_path(q, PATH_NONE, 0, false);
            self.set_pidx(q, 0);
            self.flag(q, true);
            let r = self.recheck(q); self.set_retry(q, r);
            return;
        }
        s(self.pt_at, q, at);
        // (On its way under this build: -seq, not a waiting stamp (> 0).)
        s(self.pt_ver, q, if seq > 0 { -seq } else { 0 });
        self.set_path(q, p, at, false);
        self.set_pidx(q, 0);
        self.flag(q, true);
        self.set_cmd(q, g(self.pt_cmd, q));
        let r = self.recheck(q); self.set_retry(q, r);
    }
}

/// _simHEnc of a number (a tick; NaN: unset).
fn num_enc(v: f64) -> i32 {
    if v != v { return H_UNDEF; }
    let i = v as i32;
    if i as f64 == v && !(v == 0.0 && v.is_sign_negative()) { return if i < -2147483640 { i.wrapping_mul(31) } else { i }; }
    let b = v.to_bits();
    ((b as u32 as i32) ^ 0x5bd1e995).wrapping_mul(16777619) ^ ((b >> 32) as u32 as i32)
}

/// _pendingPathPriority by SIM_PPT_SRC code: player_commands 0, ai_combat 1, worker_ai 2, scout_ai 3, the rest 4.
#[inline(always)]
fn tier(src: u8) -> u64 {
    // Nibbles of an immediate (src 0..7 -> 4,4,0,4,1,2,3,4): a match or an
    // if-chain becomes a switch lookup table, which is a data segment.
    if src >= 8 { 4 } else { (0x4321_4044u64 >> ((src as u32) * 4)) & 15 }
}

/// k_pp_due. Arrays: [0] list (mode 1: the slots; mode 0: the due slots'
/// room), [1] the wheel's heads, [2] ppDue, [3] ppNext, [4] ppPrev, [5]
/// ptSt, [6] ptGx, [7] ptGy, [8] ptCmd, [9] ptSrc, [10] ptVer, [11] ptAt,
/// [12] ptSub, [13] dead, [14] live, [15] id, [16] x, [17] y, [18] the retry
/// ticks (f64), [19] hObj, [20] nvPK, [21] pthH, [22] pathIndex, [23]
/// commandState, [24] mvOn, [25] mvSteer, [26] mvPath, [27] the movement
/// windows' free stack, [28] mvPF, [29] mvPP, [30] the path store, [31] its
/// free lists, [32] jFly, [33] wkIx, [34] wbType, [35] owner, [36] ?mvt
/// dirty, [37] per profile walls, partL, partBase, partComp (encoded, 12
/// words), [38] mv.wall, [39] ?the builders' walls, [40] st.code, [41]
/// st.val, [42] st.uc, [43] st.own, [44] st.brain, [45] cloud types, [46]
/// the substitutes' table, [47] their requests, [48] hdr (in / out: [0]
/// the wheel's count change, [1] the path store's top, [2] requests, [3]
/// errors, [5] this tick's asks), [49] / [50] sort keys (u64), [51] / [52] sort
/// payloads.
/// P: [0] mode, [1] n (mode 1) or the room, [2] now, [3] W, [4] H, [5]
/// TILE, [6] wheel size, [7] the last tick taken, [8] store length, [9]
/// table entries (a power of two), [10] requests' room, [11]
/// NAV_SUB_TICKS, [12] / [13] / [14] digest keys (target, flag, retry),
/// [15] cloud types, [16..18] seq, [19..21] cs, [22..24] cw.
#[no_mangle]
pub unsafe extern "C" fn k_pp_due(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let hdr = k.p::<i32>(48);
    let tab = k.p::<i32>(37);
    let pw = |p: usize, j: usize| -> *const u8 { let v = g(tab, p * 4 + j); if v == 0 { core::ptr::null() } else { waddr(v as u32) as *const u8 } };
    // (Zeroed, then field by field: a struct literal of constants and loads was copied from a template, a data segment.)
    let mut pp: Pp = core::mem::zeroed();
    pp.pt_st = k.p(5);
    pp.pt_gx = k.p(6);
    pp.pt_gy = k.p(7);
    pp.pt_cmd = k.p(8);
    pp.pt_src = k.p(9);
    pp.pt_ver = k.p(10);
    pp.pt_at = k.p(11);
    pp.pt_sub = k.p(12);
    pp.dead = k.p(13);
    pp.live = k.p(14);
    pp.id = k.p(15);
    pp.x = k.p(16);
    pp.y = k.p(17);
    pp.retry = k.p(18);
    pp.hobj = k.p(19);
    pp.nvpk = k.p(20);
    pp.pthh = k.p(21);
    pp.pidx = k.p(22);
    pp.cmd = k.p(23);
    pp.on = k.p(24);
    pp.steer = k.p(25);
    pp.mpath = k.p(26);
    pp.mfree = k.p(27);
    pp.mvpf = k.p(28);
    pp.mvpp = k.p(29);
    pp.fly = k.p(32);
    pp.wkix = k.p(33);
    pp.wbt = k.p(34);
    pp.own = k.p(35);
    pp.dirty = k.p(36);
    pp.arena = k.p(30);
    pp.afree = k.p(31);
    pp.top = g(hdr, 1);
    pp.alen = k.i(8);
    *pp.wall.get_unchecked_mut(0) = pw(0, 0);
    *pp.wall.get_unchecked_mut(1) = pw(1, 0);
    *pp.wall.get_unchecked_mut(2) = pw(2, 0);
    *pp.pl.get_unchecked_mut(0) = pw(0, 1) as *const u16;
    *pp.pl.get_unchecked_mut(1) = pw(1, 1) as *const u16;
    *pp.pl.get_unchecked_mut(2) = pw(2, 1) as *const u16;
    *pp.pb.get_unchecked_mut(0) = pw(0, 2) as *const i32;
    *pp.pb.get_unchecked_mut(1) = pw(1, 2) as *const i32;
    *pp.pb.get_unchecked_mut(2) = pw(2, 2) as *const i32;
    *pp.pc.get_unchecked_mut(0) = pw(0, 3) as *const i32;
    *pp.pc.get_unchecked_mut(1) = pw(1, 3) as *const i32;
    *pp.pc.get_unchecked_mut(2) = pw(2, 3) as *const i32;
    *pp.cs.get_unchecked_mut(0) = k.i(19);
    *pp.cs.get_unchecked_mut(1) = k.i(20);
    *pp.cs.get_unchecked_mut(2) = k.i(21);
    *pp.cw.get_unchecked_mut(0) = k.i(22);
    *pp.cw.get_unchecked_mut(1) = k.i(23);
    *pp.cw.get_unchecked_mut(2) = k.i(24);
    *pp.seq.get_unchecked_mut(0) = k.i(16);
    *pp.seq.get_unchecked_mut(1) = k.i(17);
    *pp.seq.get_unchecked_mut(2) = k.i(18);
    pp.ww.walls = k.p::<u8>(38);
    pp.ww.code = k.p(40);
    pp.ww.val = k.p(41);
    pp.ww.uc = k.p(42);
    pp.ww.own = k.p(43);
    pp.ww.brain = k.p(44);
    pp.ww.cloud = k.p(45);
    pp.ww.nty = k.i(15).max(0);
    pp.ww.w = k.i(3).max(1);
    pp.ww.h = k.i(4).max(1);
    pp.ww.mode = 1;
    pp.ww.owner = -1;
    pp.ww.coll = false;
    pp.bwall = k.p::<u8>(39);
    pp.st = k.p(46);
    pp.smask = (k.i(9).max(1) - 1) as u32;
    pp.sreq = k.p(47);
    pp.nreq = g(hdr, 2);
    pp.rroom = k.i(10);
    pp.asks = g(hdr, 5);
    pp.sub_ticks = k.i(11);
    pp.now = k.i(2);
    pp.gw = k.i(3).max(1);
    pp.gh = k.i(4).max(1);
    pp.tile = k.f(5);
    pp.kppt = k.i(12);
    pp.kpfa = k.i(13);
    pp.krt = k.i(14);
    pp.err = 0;
    let list = k.p::<i32>(0);
    let (mode, n0) = (k.i(0), k.i(1).max(0) as usize);
    if mode == 2 {
        // (The substitutes the waiting units asked for, asked again: after a
        // restore, or the table cleared. flownav.js navSubstitutesRestore.)
        for i in 0..n0 {
            let q = g(list, i);
            if q < 0 { continue; }
            let q = q as usize;
            if g(pp.live, q) == 0 || g(pp.dead, q) != 0 || g(pp.pt_st, q) & 3 != 2 || !(g(pp.pt_sub, q) > 0) { continue; }
            let p = pp.profile(q);
            let ugx = floor(g(pp.x, q) as f64 * 0.125 / pp.tile) as i32;
            let ugy = floor(g(pp.y, q) as f64 * 0.125 / pp.tile) as i32;
            let comp = pp.unit_comp(p as usize, ugy * pp.gw + ugx);
            if comp < 0 { continue; }
            let (gx, gy) = (g(pp.pt_gx, q) as i32, g(pp.pt_gy, q) as i32);
            let _ = pp.sub_ask(p, gy.max(0).min(pp.gh - 1) * pp.gw + gx.max(0).min(pp.gw - 1), comp);
        }
    } else if mode == 1 {
        for i in 0..n0 {
            let q = g(list, i);
            if q < 0 { continue; }
            let q = q as usize;
            if g(pp.dead, q) != 0 || g(pp.pt_st, q) & 3 != 2 { continue; }
            pp.upgrade(q);
        }
    } else {
        let (heads, due, nx, pv) = (k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4));
        let wn = k.i(6).max(1);
        let wm = wn - 1;
        let (now, taken) = (pp.now, k.i(7));
        let mut count = 0i32;
        let unlink = |q: usize, count: &mut i32| {
            let b = (g(due, q) & wm) as usize;
            let (p, n) = (g(pv, q), g(nx, q));
            if p >= 0 { s(nx, p as usize, n); } else if g(heads, b) == q as i32 { s(heads, b, n); }
            if n >= 0 { s(pv, n as usize, p); }
            s(due, q, -1);
            *count -= 1;
        };
        let link = |q: usize, tick: i32, count: &mut i32| {
            let b = (tick & wm) as usize;
            let h = g(heads, b);
            s(nx, q, h); s(pv, q, -1);
            if h >= 0 { s(pv, h as usize, q as i32); }
            s(heads, b, q as i32); s(due, q, tick);
            *count += 1;
        };
        // The buckets of the ticks since the last take, each once.
        let from = if taken < 0 || now - taken >= wn { now - wn + 1 } else { taken + 1 };
        let (ka, kb, va, vb) = (k.p::<u64>(49), k.p::<u64>(50), k.p::<i32>(51), k.p::<i32>(52));
        let mut m = 0usize;
        let mut t = from;
        while t <= now {
            let mut q = g(heads, (t & wm) as usize);
            while q >= 0 {
                let next = g(nx, q as usize);
                let qu = q as usize;
                if g(due, qu) <= now {
                    unlink(qu, &mut count);
                    if g(pp.live, qu) != 0 && g(pp.dead, qu) == 0 && g(pp.pt_st, qu) & 3 == 2 {
                        if m < n0 { s(ka, m, (tier(g(pp.pt_src, qu)) << 32) | g(pp.id, qu) as u32 as u64); s(va, m, q); m += 1; } else { pp.err |= 4; }
                    }
                }
                q = next;
            }
            t += 1;
        }
        // By (priority, id): an LSD radix sort, 8 bits a pass, over the five low bytes.
        let (mut src_k, mut src_v, mut dst_k, mut dst_v) = (ka, va, kb, vb);
        let mut cnt = [0usize; 256];
        for pass in 0..5u32 {
            let sh = pass * 8;
            for c in cnt.iter_mut() { *c = 0; }
            for i in 0..m { *cnt.get_unchecked_mut(((g(src_k, i) >> sh) & 255) as usize) += 1; }
            let mut sum = 0usize;
            for c in cnt.iter_mut() { let v = *c; *c = sum; sum += v; }
            for i in 0..m {
                let kk = g(src_k, i);
                let d = cnt.get_unchecked_mut(((kk >> sh) & 255) as usize);
                s(dst_k, *d, kk); s(dst_v, *d, g(src_v, i));
                *d += 1;
            }
            core::mem::swap(&mut src_k, &mut dst_k);
            core::mem::swap(&mut src_v, &mut dst_v);
        }
        for i in 0..m { pp.upgrade(g(src_v, i) as usize); }
        // Each scheduled again (still waiting): its retry tick, else the next tick.
        for i in 0..m {
            let q = g(src_v, i) as usize;
            if g(pp.dead, q) != 0 || g(pp.pt_st, q) & 3 != 2 { continue; }
            let r = g(pp.retry, q);
            let tick = if r == r && r > (now + 1) as f64 { r as i32 } else { now + 1 };
            link(q, tick, &mut count);
        }
        s(hdr, 0, count);
    }
    s(hdr, 1, pp.top);
    s(hdr, 2, pp.nreq);
    s(hdr, 5, pp.asks);
    s(hdr, 3, pp.err);
}

/// The substitutes' answers into their table (flownav.js _navSubstitutesMake,
/// after SIM_KERNEL_NAV_SUBST): request i ([0] (profile, to, component)
/// triples) answered out[i] ([1]). Arrays: [2] the table. P: [0] requests,
/// [1] table entries (a power of two).
#[no_mangle]
pub unsafe extern "C" fn k_nav_sub_store(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (req, out, t) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2));
    let (n, mask) = (k.i(0).max(0) as usize, (k.i(1).max(1) - 1) as u32);
    for i in 0..n {
        let (p, to, c) = (g(req, i * 3), g(req, i * 3 + 1), g(req, i * 3 + 2));
        let k1 = p * 4194304 + c;
        let (e, found) = sub_find(t, mask, k1, to);
        if !found { s(t, e, k1 + 1); s(t, e + 1, to); }
        s(t, e + 2, g(out, i));
    }
}
