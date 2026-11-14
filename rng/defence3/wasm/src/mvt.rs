//! The mover table (MOVE_OCCUPANCY_OPTIMIZATION_PLAN.md 3.1): one
//! row a live unit, kept by spatial block (the occupancy's
//! blocks: the movement's jobs), so a block's movement state is a few KB in
//! a row instead of 15-40 columns read in spatial order.
//!
//! A row is a cache of the unit's columns with one rule: whoever writes a
//! column a row is made from (ROW_OF below) outside the movement itself sets
//! the slot's byte in mvt.dirty; the sync (mvt_sync_*) makes those rows again before the
//! movement. mvt_audit makes every row from the columns and compares: a
//! missed mark is a test failure, not a desync in play. The table is derived
//! state: made whole at a restore (mvt_rebuild), never hashed; the order of
//! rows in a block is this peer's own history and must not show in any
//! outcome (the block job orders rows by position and id).
//!
//! Layout. A slab is SLAB rows, a structure of arrays: ROW_W arrays of SLAB
//! words (mvt.rows, slab * SLAB * ROW_W words in). A block owns a chain of
//! slabs (mvt.bhead / mvt.btail, mvt.snext / mvt.sprev), its rows dense over
//! the chain (mvt.bcount of them): a row gone is replaced by the block's
//! last. mvt.hrow[slot] is the slot's row (slab * SLAB + index; -1 none).
//! Free slabs are a list through mvt.snext from cfg[C_FREE]. The pool
//! (slots / SLAB + blocks, rounded up) always has a slab: a block's partial
//! slab is the only slack.
//!
//! Stage 3b, first part: the occupancy's block job (mv.rs move_job) walks
//! its block's rows instead of the tile index, and the movement keeps the
//! rows' positions itself (Rows::moved, at the footprint record's writes:
//! occ.rs commit_preview and swap). A row holds what is exact at every
//! moment the movement reads it: the position, slot, id,
//! radius, layer and owner. One row a live unit, with a
//! footprint or not (the job's epilogue is every moved unit's). The steer's
//! target, the class, the wake and the hand come with the step (the next
//! part): the movement's kernels write those columns at too many places to
//! mark before the block job is their one writer.
use super::k::K;
use super::*;

pub const SLAB: usize = 64;
/// A row's words.
pub const ROW_W: usize = 8;
/// Position, eighths (unit.x / unit.y).
pub const R_X: usize = 0;
pub const R_Y: usize = 1;
/// (For the steer's target point: -1 until the step is the block job's.)
pub const R_TGT: usize = 2;
pub const R_SLOT: usize = 3;
pub const R_ID: usize = 4;
/// (For the route's end: 0 until the step is the block job's.)
pub const R_RTE: usize = 5;
/// (The low 16 bits for the stats row, with the step) | radius << 16 (6 bits) | layer << 22
/// (2 bits) | (24..28 for the navigation profile, with the step) | a footprint << 31.
pub const R_STAT: usize = 6;
/// owner << 24 (the low bits for the class, with the step).
pub const R_KIND: usize = 7;

// cfg words (mvt.cfg).
const C_SLABS: usize = 1;
const C_BW: usize = 2;
const C_BH: usize = 3;
const C_BLOCKQ: usize = 4;
const C_FREE: usize = 5;
const C_ROWS: usize = 6;
/// The audit's result: mismatching slots, the first one, its fields (bit f:
/// row word f differs; bit 16: a row for no unit; 17: a unit without a row;
/// 18: the row is another slot's; 19: in another block's chain).
const C_BAD: usize = 8;
const C_BAD_SLOT: usize = 9;
const C_BAD_BITS: usize = 10;
/// The audit's count of rows (the live units).
const C_SEEN: usize = 11;
/// The free slabs' lock (the sync's block jobs take and give slabs) and their count.
const C_LOCK: usize = 12;
const C_NFREE: usize = 13;
/// The sync's plan: its blocks with changes (mvt.jobs), and 1 when the free slabs may not cover every block's
/// inserts before the others' rows are taken away (then the jobs run twice: the rows out, then the rows in).
const C_JOBS: usize = 14;
const C_TWO: usize = 15;
/// The sync's scan: slots a job: the movement's first stage's chunk (unit.js SIM_MOVE_CHUNK). A list entry is two
/// words: the position (x | slot - the job's first << 23, y).
pub(super) const SCAN: usize = 512;
/// The sync's second pass: blocks a job (a block's part is a few rows).
const APPLY: usize = 16;
/// cfg[C_ADDR + i]: the address of T's array i (sim_occupancy.js _mvtArrays' order), for the movement's first
/// stage, whose argument block has one word for the table.
const C_ADDR: usize = 16;

/// The table as the movement's block jobs use it (the arrays at words
/// ROWS_W0.. of the argument block: sim_parallel.js _simOccW: mvt.cfg,
/// mvt.hrow, mvt.dirty, mvt.bhead, mvt.snext, mvt.bcount, mvt.rows).
pub(super) const ROWS_W0: usize = 512 + 38;
pub(super) struct Rows {
    pub hrow: *const i32,
    pub dirty: *mut u8,
    pub bhead: *const i32,
    pub snext: *const i32,
    pub bcount: *const i32,
    pub rows: *mut i32,
    bw: i32,
    bh: i32,
    blockq: i32,
}
impl Rows {
    pub(super) fn none() -> Rows {
        Rows { hrow: core::ptr::null(), dirty: core::ptr::null_mut(), bhead: core::ptr::null(), snext: core::ptr::null(), bcount: core::ptr::null(), rows: core::ptr::null_mut(), bw: 1, bh: 1, blockq: 1 }
    }
    pub(super) unsafe fn load(a: *const i32) -> Rows {
        let p = |i: usize| waddr(*a.add(ROWS_W0 + i) as u32);
        let cfg = p(0) as *const i32;
        if cfg.is_null() {
            return Rows::none();
        }
        Rows { hrow: p(1) as *const i32, dirty: p(2) as *mut u8, bhead: p(3) as *const i32, snext: p(4) as *const i32, bcount: p(5) as *const i32, rows: p(6) as *mut i32,
            bw: *cfg.add(C_BW), bh: *cfg.add(C_BH), blockq: (*cfg.add(C_BLOCKQ)).max(1) }
    }
    #[inline(always)]
    fn block(&self, x: i32, y: i32) -> i32 {
        pdiv(y.max(0), self.blockq).min(self.bh - 1).max(0) * self.bw + pdiv(x.max(0), self.blockq).min(self.bw - 1).max(0)
    }
    /// The unit of slot s now stands at (x, y) (its footprint record was
    /// written): its row's position (row h when the caller has it, else by
    /// mvt.hrow). Into another block: the row is left as it is (its block is
    /// the one of the position it holds) and the slot marked: the next sync
    /// moves it there.
    #[inline(always)]
    pub(super) unsafe fn moved(&self, s: usize, h: i32, x: i32, y: i32) {
        if self.hrow.is_null() {
            return;
        }
        let h = if h >= 0 { h } else { *self.hrow.add(s) };
        if h < 0 {
            *self.dirty.add(s) = 1;
            return;
        }
        let h = h as usize;
        let (px, py) = (self.rows.add((h / SLAB) * SLAB * ROW_W + R_X * SLAB + (h % SLAB)), self.rows.add((h / SLAB) * SLAB * ROW_W + R_Y * SLAB + (h % SLAB)));
        if self.block(*px, *py) != self.block(x, y) {
            *self.dirty.add(s) = 1;
        } else {
            *px = x;
            *py = y;
        }
    }
}

struct T {
    cfg: *mut i32,
    hrow: *mut i32,
    dirty: *mut u8,
    bhead: *mut i32,
    btail: *mut i32,
    bcount: *mut i32,
    snext: *mut i32,
    sprev: *mut i32,
    rows: *mut i32,
    x: *const i32,
    y: *const i32,
    id: *const i32,
    live: *const u8,
    dead: *const u8,
    rec: *const i32,
    own: *const i8,
    // (The sync: per scan job its rows to put in (lst, its count lcnt); per block its rows taken away (rmc), its rows
    // to put in (inc: counts, then where its slots end in ins), the blocks with any (jobs).)
    lst: *mut i32,
    lcnt: *mut i32,
    rmc: *mut i32,
    inc: *mut i32,
    ins: *mut i32,
    jobs: *mut i32,
    // (Where block b's slots end in ins: the block before's is its start.)
    ioff: *mut i32,
    off: *mut i32,
    bw: i32,
    bh: i32,
    blockq: i32,
}
impl T {
    /// The arrays (sim_parallel.js _simMvtW, the same order).
    #[inline(always)]
    unsafe fn load(k: &K) -> T {
        let cfg = k.p::<i32>(0);
        T {
            cfg, hrow: k.p(1), dirty: k.p(2), bhead: k.p(3), btail: k.p(4), bcount: k.p(5), snext: k.p(6), sprev: k.p(7), rows: k.p(8),
            x: k.p(9), y: k.p(10), id: k.p(11), live: k.p(12), dead: k.p(13), rec: k.p(14), own: k.p(15),
            lst: k.p(16), lcnt: k.p(17), rmc: k.p(18), inc: k.p(19), ins: k.p(20), jobs: k.p(21), ioff: k.p(22),
            off: k.p(24),
            bw: *cfg.add(C_BW), bh: *cfg.add(C_BH), blockq: (*cfg.add(C_BLOCKQ)).max(1),
        }
    }
    /// The same from the addresses in cfg (C_ADDR).
    #[inline(always)]
    unsafe fn from_cfg(cfg: *mut i32) -> T {
        macro_rules! p { ($i:expr) => { waddr(*cfg.add(C_ADDR + $i) as u32) as _ }; }
        T {
            cfg, hrow: p!(1), dirty: p!(2), bhead: p!(3), btail: p!(4), bcount: p!(5), snext: p!(6), sprev: p!(7), rows: p!(8),
            x: p!(9), y: p!(10), id: p!(11), live: p!(12), dead: p!(13), rec: p!(14), own: p!(15),
            lst: p!(16), lcnt: p!(17), rmc: p!(18), inc: p!(19), ins: p!(20), jobs: p!(21), ioff: p!(22),
            off: p!(24),
            bw: *cfg.add(C_BW), bh: *cfg.add(C_BH), blockq: (*cfg.add(C_BLOCKQ)).max(1),
        }
    }
    /// Where slot s's unit stands: its footprint's position (the columns hold the position it wants between the
    /// movement's two stages); without a footprint, the columns'.
    #[inline(always)]
    unsafe fn pos_of(&self, s: usize) -> (i32, i32, bool) {
        let r = self.rec.add(s * 4);
        if (*r.add(2) >> 16) & 255 != 0 { (*r, *r.add(1), true) } else { (*self.x.add(s), *self.y.add(s), false) }
    }
    /// Slot s's row with its position given.
    #[inline(always)]
    unsafe fn row_at(&self, s: usize, x: i32, y: i32) -> [i32; ROW_W] {
        let meta = *self.rec.add(s * 4 + 2);
        let active = ((meta >> 16) & 255 != 0) as i32;
        [x, y, -1, s as i32, *self.id.add(s), 0, ((meta & 63) << 16) | (((meta >> 8) & 3) << 22) | (active << 31), (*self.own.add(s) as u8 as i32) << 24]
    }
    /// Slot s's row as its columns make it; None: no row (no unit there, or dead).
    #[inline(always)]
    unsafe fn row_of(&self, s: usize) -> Option<[i32; ROW_W]> {
        if *self.live.add(s) == 0 || *self.dead.add(s) != 0 {
            return None;
        }
        let (x, y, _) = self.pos_of(s);
        Some(self.row_at(s, x, y))
    }
    /// The block of a position (clamped into the map's blocks).
    #[inline(always)]
    fn block(&self, x: i32, y: i32) -> usize {
        let bx = pdiv(x.max(0), self.blockq).min(self.bw - 1).max(0);
        let by = pdiv(y.max(0), self.blockq).min(self.bh - 1).max(0);
        (by * self.bw + bx) as usize
    }
    #[inline(always)]
    unsafe fn word(&self, h: usize, f: usize) -> *mut i32 {
        self.rows.add((h / SLAB) * SLAB * ROW_W + f * SLAB + (h % SLAB))
    }
    #[inline(always)]
    unsafe fn put(&self, h: usize, r: &[i32; ROW_W]) {
        for f in 0..ROW_W {
            *self.word(h, f) = *r.get_unchecked(f);
        }
    }
    #[inline(always)]
    unsafe fn lock(&self) {
        use core::sync::atomic::{AtomicI32, Ordering};
        let l = &*(self.cfg.add(C_LOCK) as *const AtomicI32);
        while l.compare_exchange_weak(0, 1, Ordering::Acquire, Ordering::Relaxed).is_err() {
            core::hint::spin_loop();
        }
    }
    #[inline(always)]
    unsafe fn unlock(&self) {
        use core::sync::atomic::{AtomicI32, Ordering};
        (*(self.cfg.add(C_LOCK) as *const AtomicI32)).store(0, Ordering::Release);
    }
    /// A free slab (the pool always has one: slots / SLAB + blocks, and the sync's plan keeps the jobs within it).
    unsafe fn slab_take(&self) -> i32 {
        self.lock();
        let sl = *self.cfg.add(C_FREE);
        if sl < 0 {
            core::arch::wasm32::unreachable();
        }
        *self.cfg.add(C_FREE) = *self.snext.add(sl as usize);
        *self.cfg.add(C_NFREE) -= 1;
        self.unlock();
        sl
    }
    unsafe fn slab_give(&self, sl: usize) {
        self.lock();
        *self.snext.add(sl) = *self.cfg.add(C_FREE);
        *self.cfg.add(C_FREE) = sl as i32;
        *self.cfg.add(C_NFREE) += 1;
        self.unlock();
    }
    /// A row for slot s in block b (its last). (The block's chain is the caller's alone: its job's, or the one thread's.)
    unsafe fn insert(&self, b: usize, r: &[i32; ROW_W]) {
        let n = *self.bcount.add(b) as usize;
        let mut tail = *self.btail.add(b);
        if n % SLAB == 0 {
            let sl = self.slab_take();
            *self.snext.add(sl as usize) = -1;
            *self.sprev.add(sl as usize) = tail;
            if tail >= 0 { *self.snext.add(tail as usize) = sl; } else { *self.bhead.add(b) = sl; }
            *self.btail.add(b) = sl;
            tail = sl;
        }
        let h = tail as usize * SLAB + n % SLAB;
        self.put(h, r);
        *self.hrow.add(*r.get_unchecked(R_SLOT) as usize) = h as i32;
        *self.bcount.add(b) = n as i32 + 1;
    }
    /// Block b's rows taken away by the scan (their slot word -1; rm of them) closed up: each hole gets the block's
    /// last row that stays; the emptied slabs go back to the pool.
    unsafe fn compact(&self, b: usize, rm: usize) {
        let mut n = *self.bcount.add(b) as usize;
        let mut left = rm;
        let (mut fs, mut fo) = (*self.bhead.add(b), 0usize);
        let mut tail = *self.btail.add(b);
        while left > 0 && n > 0 {
            let last = tail as usize * SLAB + (n - 1) % SLAB;
            let gone = *self.word(last, R_SLOT) < 0;
            if !gone {
                // (The first hole from the front: before the last row, as one is left and the last row is none.)
                while *self.word(fs as usize * SLAB + fo % SLAB, R_SLOT) >= 0 {
                    fo += 1;
                    if fo % SLAB == 0 { fs = *self.snext.add(fs as usize); }
                }
                let h = fs as usize * SLAB + fo % SLAB;
                for f in 0..ROW_W {
                    *self.word(h, f) = *self.word(last, f);
                }
                *self.hrow.add(*self.word(h, R_SLOT) as usize) = h as i32;
            }
            n -= 1;
            left -= 1;
            if n % SLAB == 0 {
                let prev = *self.sprev.add(tail as usize);
                *self.btail.add(b) = prev;
                if prev >= 0 { *self.snext.add(prev as usize) = -1; } else { *self.bhead.add(b) = -1; }
                self.slab_give(tail as usize);
                tail = prev;
            }
        }
        *self.bcount.add(b) = n as i32;
    }
    /// The scan's part for a marked slot s (of the job whose first slot is s0, nl in its list so far): its row
    /// written in place where its block is the same; else the row it had marked gone (its slot word -1, counted at
    /// its block) and the slot listed with its position for its new block. A slot is one job's; a block's counts
    /// are atomic adds.
    #[inline(always)]
    unsafe fn scan_slot(&self, s: usize, s0: usize, nl: &mut usize) {
        use core::sync::atomic::{AtomicI32, Ordering};
        let h = *self.hrow.add(s);
        let r = self.row_of(s);
        let nb = match &r { Some(r) => self.block(r[R_X], r[R_Y]) as i32, None => -1 };
        if h >= 0 {
            let h = h as usize;
            let ob = self.block(*self.word(h, R_X), *self.word(h, R_Y));
            if nb == ob as i32 {
                if let Some(r) = &r { self.put(h, r); }
                return;
            }
            *self.word(h, R_SLOT) = -1;
            *self.hrow.add(s) = -1;
            (*(self.rmc.add(ob) as *const AtomicI32)).fetch_add(1, Ordering::Relaxed);
        }
        if let Some(r) = &r {
            // (x in 23 bits: a map of 32k tiles; the slot's place in its job in the 9 above.)
            if r[R_X] < 0 || r[R_X] >= 1 << 23 || s - s0 >= SCAN { core::arch::wasm32::unreachable(); }
            let e = self.lst.add((s0 + *nl) * 2);
            *e = r[R_X] | (((s - s0) as i32) << 23);
            *e.add(1) = r[R_Y];
            *nl += 1;
            (*(self.inc.add(nb as usize) as *const AtomicI32)).fetch_add(1, Ordering::Relaxed);
        }
    }
    /// The scan over slots s0..e (the job `chunk`'s: s0 = chunk * SCAN): sixteen bytes a compare where none is
    /// set; a marked slot's mark cleared (the byte alone: a background lane may mark its neighbours meanwhile).
    #[inline(always)]
    unsafe fn scan(&self, s0: usize, e: usize, chunk: usize) {
        use core::sync::atomic::{AtomicU8, Ordering};
        if s0 != chunk * SCAN || e > s0 + SCAN { core::arch::wasm32::unreachable(); }
        let mut nl = 0usize;
        let mut s = s0;
        while s < e {
            if s + 16 <= e {
                let d = v128_load(self.dirty.add(s) as *const v128);
                let v = v128_or(d, v128_and(v128_load(self.dead.add(s) as *const v128), v128_load(self.live.add(s) as *const v128)));
                if !v128_any_true(v) {
                    s += 16;
                    continue;
                }
                let mut m = i8x16_bitmask(i8x16_ne(v, i8x16_splat(0))) as u32;
                while m != 0 {
                    let q = s + m.trailing_zeros() as usize;
                    (*(self.dirty.add(q) as *const AtomicU8)).store(0, Ordering::Relaxed);
                    self.scan_slot(q, s0, &mut nl);
                    m &= m - 1;
                }
                s += 16;
            } else {
                if *self.dirty.add(s) != 0 || (*self.dead.add(s) != 0 && *self.live.add(s) != 0) {
                    (*(self.dirty.add(s) as *const AtomicU8)).store(0, Ordering::Relaxed);
                    self.scan_slot(s, s0, &mut nl);
                }
                s += 1;
            }
        }
        if s0 < e {
            *self.lcnt.add(chunk) = nl as i32;
        }
    }
    /// Each block's first place in the movement jobs' lists (occ.offsets, blocks + 1 words): the rows of the blocks
    /// before it (4096 blocks at the largest map).
    unsafe fn offsets(&self) {
        if self.off.is_null() {
            return;
        }
        let nb = (self.bw * self.bh) as usize;
        let mut total = 0i32;
        for b in 0..nb {
            *self.off.add(b) = total;
            total += *self.bcount.add(b);
        }
        *self.off.add(nb) = total;
        *self.cfg.add(C_ROWS) = total;
    }
    /// Everything empty: no rows, every slab free.
    unsafe fn clear(&self, slots: usize) {
        let nb = (self.bw * self.bh) as usize;
        let slabs = *self.cfg.add(C_SLABS) as usize;
        for b in 0..nb {
            *self.bhead.add(b) = -1;
            *self.btail.add(b) = -1;
            *self.bcount.add(b) = 0;
        }
        for sl in 0..slabs {
            *self.snext.add(sl) = if sl + 1 < slabs { sl as i32 + 1 } else { -1 };
            *self.sprev.add(sl) = -1;
        }
        *self.cfg.add(C_FREE) = if slabs > 0 { 0 } else { -1 };
        *self.cfg.add(C_NFREE) = slabs as i32;
        *self.cfg.add(C_LOCK) = 0;
        *self.cfg.add(C_ROWS) = 0;
        core::ptr::write_bytes(self.rmc, 0, nb);
        core::ptr::write_bytes(self.inc, 0, nb + 1);
        *self.cfg.add(C_JOBS) = 0;
        core::ptr::write_bytes(self.hrow, 0xff, slots);
        core::ptr::write_bytes(self.dirty, 0, slots);
    }
}

/// The table made whole from the columns (a match's start, a restore, a
/// resync, the slots' capacity changed). P[0] slots; cfg[0] their capacity.
#[no_mangle]
pub unsafe extern "C" fn mvt_rebuild(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let t = T::load(&k);
    let n = k.i(0).max(0) as usize;
    // (Every slot of the capacity, cfg[0]: a row index left at a slot past the units now there (a smaller state restored)
    // would be taken for its row when a unit is next made there.)
    t.clear((*t.cfg as usize).max(n));
    for s in 0..n {
        if let Some(r) = t.row_of(s) {
            t.insert(t.block(r[R_X], r[R_Y]), &r);
        }
    }
    t.offsets();
}

/// The sync: the rows of the slots marked in mvt.dirty made again, between the movement's two stages. A unit that
/// died needs no mark (seven kernels and the page's code set unit.dead): a dead unit not yet let go (dead and live)
/// counts as marked every time, its row taken away at the first; few stand so, and only until the retire pass.
///
/// Its scan is part of the movement's first stage (mv.rs move_job: each slot chunk's marks at the chunk's start,
/// before its units step: their columns are that job's lines anyway, and the simulation thread has no pass of
/// its own): scan_chunk, with the table's addresses from cfg. A row in the same block is written in place; else
/// it is marked gone and the slot listed with its position (T::scan_slot).
pub(super) unsafe fn scan_chunk(cfg: *mut i32, s0: usize, e: usize, chunk: usize) {
    T::from_cfg(cfg).scan(s0, e, chunk);
}
/// The scan as a kernel of its own (a test's sync outside a movement): job `chunk`, P[0] slots.
#[no_mangle]
pub unsafe extern "C" fn mvt_sync_scan(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let t = T::load(&k);
    let n = k.i(0).max(0) as usize;
    let s0 = chunk.max(0) as usize * SCAN;
    if s0 < n {
        t.scan(s0, (s0 + SCAN).min(n), chunk.max(0) as usize);
    }
}

/// The sync's plan, one job on the simulation thread after the first stage (4096 blocks and the listed slots, ~11k
/// a step at 1M units; P[0] the slots the scan's jobs covered): the marks of slots past those (released ones: no
/// unit there, their rows marked gone); the blocks with rows taken away or to put in (mvt.jobs, cfg[C_JOBS] of
/// them); the listed entries by block (mvt.ins, mvt.ioff[b] where block b's end), in the scan jobs' order; each
/// block's first place in the movement jobs' lists (occ.offsets) from the row counts the block pass will leave.
/// cfg[C_TWO]: the free slabs may not cover the inserts of blocks whose turn comes before the others gave theirs
/// back (then the block pass runs twice: the rows out, then the rows in).
#[no_mangle]
pub unsafe extern "C" fn mvt_sync_plan(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let t = T::load(&k);
    let n = k.i(0).max(0) as usize;
    let cap = (*t.cfg).max(0) as usize;
    let mut s = n;
    while s < cap {
        if s + 16 <= cap && !v128_any_true(v128_load(t.dirty.add(s) as *const v128)) {
            s += 16;
            continue;
        }
        if *t.dirty.add(s) != 0 {
            *t.dirty.add(s) = 0;
            let h = *t.hrow.add(s);
            if *t.live.add(s) != 0 && *t.dead.add(s) == 0 { core::arch::wasm32::unreachable(); }
            if h >= 0 {
                let h = h as usize;
                *t.rmc.add(t.block(*t.word(h, R_X), *t.word(h, R_Y))) += 1;
                *t.word(h, R_SLOT) = -1;
                *t.hrow.add(s) = -1;
            }
        }
        s += 1;
    }
    let nb = (t.bw * t.bh) as usize;
    let (mut nj, mut total, mut takes, mut rows) = (0usize, 0i32, 0i32, 0i32);
    for b in 0..nb {
        let (rm, c) = (*t.rmc.add(b), *t.inc.add(b));
        let kept = (*t.bcount.add(b) - rm).max(0);
        if rm | c != 0 {
            *t.jobs.add(nj) = b as i32;
            nj += 1;
            takes += ((kept + c + SLAB as i32 - 1) / SLAB as i32 - (kept + SLAB as i32 - 1) / SLAB as i32).max(0);
            *t.inc.add(b) = 0;
        }
        *t.ioff.add(b) = total;
        total += c;
        *t.off.add(b) = rows;
        rows += kept + c;
    }
    *t.off.add(nb) = rows;
    *t.cfg.add(C_ROWS) = rows;
    if total > 0 {
        let chunks = (n + SCAN - 1) / SCAN;
        for c in 0..chunks {
            let base = c * SCAN;
            for i in 0..*t.lcnt.add(c) as usize {
                let e = t.lst.add((base + i) * 2);
                let p = t.ioff.add(t.block(*e & 0x7fffff, *e.add(1)));
                *t.ins.add(*p as usize) = (base + i) as i32;
                *p += 1;
            }
        }
    }
    *t.cfg.add(C_JOBS) = nj as i32;
    *t.cfg.add(C_TWO) = (takes > *t.cfg.add(C_NFREE)) as i32;
}

/// The sync's block pass, a job APPLY blocks with changes (mvt.jobs): a block's rows taken away closed up
/// (P[1] & 1), its listed slots' rows put in at their listed positions (P[1] & 2: where the scan found them; the
/// columns hold the wanted positions by now, and a unit without a footprint has moved). A block's chain is its
/// job's alone; the free slabs are shared under their lock.
#[no_mangle]
pub unsafe extern "C" fn mvt_sync_apply(a: u32, job: i32) {
    let k = K::new(waddr(a) as *const i32);
    let t = T::load(&k);
    let mode = k.i(1);
    let nj = (*t.cfg.add(C_JOBS)).max(0) as usize;
    let j0 = job.max(0) as usize * APPLY;
    for j in j0..(j0 + APPLY).min(nj) {
        let b = *t.jobs.add(j) as usize;
        if mode & 1 != 0 {
            let rm = *t.rmc.add(b);
            if rm > 0 {
                t.compact(b, rm as usize);
                *t.rmc.add(b) = 0;
            }
        }
        if mode & 2 != 0 {
            let (i0, i1) = (if b > 0 { *t.ioff.add(b - 1) } else { 0 }, *t.ioff.add(b));
            for i in i0..i1 {
                let ei = *t.ins.add(i as usize) as usize;
                let e = t.lst.add(ei * 2);
                let s = ei / SCAN * SCAN + ((*e as u32) >> 23) as usize;
                t.insert(b, &t.row_at(s, *e & 0x7fffff, *e.add(1)));
            }
        }
    }
}

/// Every row against its columns, every unit against its row, every block's
/// chain against its count: cfg[C_BAD] the slots (or rows) that differ,
/// cfg[C_BAD_SLOT] / cfg[C_BAD_BITS] the first and how. Slots still marked
/// dirty are not compared (their rows are made at the next sync). P[0] slots; P[1] 1: between the movement's stages
/// (a unit without a footprint has stepped, its row's position is the block job's to write).
#[no_mangle]
pub unsafe extern "C" fn mvt_audit(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let t = T::load(&k);
    let n = k.i(0).max(0) as usize;
    let mid = k.i(1) == 1;
    let (mut bad, mut first, mut bits0, mut seen) = (0i32, -1i32, 0i32, 0i32);
    let mut note = |s: usize, bits: i32| {
        if bits != 0 {
            if bad == 0 { first = s as i32; bits0 = bits; }
            bad += 1;
        }
    };
    for s in 0..n {
        if *t.dirty.add(s) != 0 {
            if *t.hrow.add(s) >= 0 { seen += 1; }
            continue;
        }
        let h = *t.hrow.add(s);
        let mut bits = 0i32;
        match t.row_of(s) {
            None => { if h >= 0 { bits |= 1 << 16; seen += 1; } }
            Some(r) => {
                if h < 0 {
                    bits |= 1 << 17;
                } else {
                    seen += 1;
                    let h = h as usize;
                    if *t.word(h, R_SLOT) != s as i32 {
                        bits |= 1 << 18;
                    } else {
                        let f0 = if mid && r[R_STAT] >= 0 { 2 } else { 0 };
                        for f in f0..ROW_W {
                            if *t.word(h, f) != r[f] { bits |= 1 << f; }
                        }
                        // (Outside the movement the columns hold the footprint's position too: a write to them alone is a missed mark.)
                        if !mid {
                            if *t.x.add(s) != r[R_X] { bits |= 1 << R_X; }
                            if *t.y.add(s) != r[R_Y] { bits |= 1 << R_Y; }
                        }
                    }
                }
            }
        }
        note(s, bits);
    }
    // The chains: each block's rows are its own (their positions' block), as many as its count, every one its slot's row.
    let nb = (t.bw * t.bh) as usize;
    let mut total = 0i32;
    for b in 0..nb {
        let cnt = *t.bcount.add(b) as usize;
        total += cnt as i32;
        let (mut sl, mut i) = (*t.bhead.add(b), 0usize);
        while i < cnt {
            if sl < 0 { note(0, 1 << 19); break; }
            let h = sl as usize * SLAB + i % SLAB;
            let s = *t.word(h, R_SLOT);
            if s < 0 || s as usize >= n || *t.hrow.add(s as usize) != h as i32 {
                note(s.max(0) as usize, 1 << 18);
            } else if t.block(*t.word(h, R_X), *t.word(h, R_Y)) != b {
                note(s as usize, 1 << 19);
            }
            i += 1;
            if i % SLAB == 0 { sl = *t.snext.add(sl as usize); }
        }
    }
    if total != seen || total != *t.cfg.add(C_ROWS) { note(0, 1 << 19); }
    *t.cfg.add(C_BAD) = bad;
    *t.cfg.add(C_BAD_SLOT) = first;
    *t.cfg.add(C_BAD_BITS) = bits0;
    *t.cfg.add(C_SEEN) = seen;
}
