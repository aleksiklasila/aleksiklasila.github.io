//! The presentation worker's frames, slot by slot (presentation_worker.js
//! frameRange): a range's fill, its ghosts and its change marks, the fog's
//! light, units moved to other slots.
//!
//! Two memories (the presentation module, wasm/build.cjs --pres): memory 0
//! is the worker's own (the frames, its per-slot state, the tables below),
//! memory 1 the simulation's heap, read in place through the `sim_*` loads
//! (imports the build turns into loads from memory 1). Nothing is copied.
//!
//! Tables of addresses (i32 words, in memory 0): a frame's columns
//! (sim_frame.js layout: F_*), the worker's per-slot state (T_*); the
//! simulation's columns (S_*) and its presentation metadata (sim_frame.js
//! simMetaViews: M_*), addresses in memory 1. presentation_worker.js pmInit
//! checks the frame and metadata layouts.
use super::k::K;
use super::{waddr, floor};

// Loads from memory 1, the simulation's heap. Here they load memory 0 as
// stand-ins, never inlined: LLVM sees calls that only read memory, so it
// keeps everything else in registers across them (as extern calls, which
// may write anything, every loop reloaded its state after each one: ~10x
// slower). wasm/build.cjs (--pres) turns every call of them into the load
// from memory 1 and drops them; none is left in the module.
#[inline(never)] fn pres_sim_i32(a: u32) -> i32 { unsafe { *(a as usize as *const i32) } }
#[inline(never)] fn pres_sim_f32(a: u32) -> f32 { unsafe { *(a as usize as *const f32) } }
#[inline(never)] fn pres_sim_u8(a: u32) -> i32 { unsafe { *(a as usize as *const u8) as i32 } }
#[inline(never)] fn pres_sim_i8(a: u32) -> i32 { unsafe { *(a as usize as *const i8) as i32 } }
#[inline(never)] fn pres_sim_u16(a: u32) -> i32 { unsafe { *(a as usize as *const u16) as i32 } }
#[inline(never)] fn pres_sim_i16(a: u32) -> i32 { unsafe { *(a as usize as *const i16) as i32 } }
/// A column in the simulation's memory (its byte address).
#[derive(Clone, Copy)]
struct SP(u32);
impl SP {
    #[inline(always)] unsafe fn i32(self, i: usize) -> i32 { pres_sim_i32(self.0 + 4 * i as u32) }
    #[inline(always)] unsafe fn f32(self, i: usize) -> f32 { pres_sim_f32(self.0 + 4 * i as u32) }
    #[inline(always)] unsafe fn u8(self, i: usize) -> i32 { pres_sim_u8(self.0 + i as u32) }
    #[inline(always)] unsafe fn i8(self, i: usize) -> i32 { pres_sim_i8(self.0 + i as u32) }
    #[inline(always)] unsafe fn u16(self, i: usize) -> i32 { pres_sim_u16(self.0 + 2 * i as u32) }
    #[inline(always)] unsafe fn i16(self, i: usize) -> i32 { pres_sim_i16(self.0 + 2 * i as u32) }
    /// Element i of a column of sz bytes into d (memory 0).
    #[inline(always)]
    unsafe fn copy_to(self, d: *mut u8, sz: usize, i: usize) {
        match sz {
            4 => *(d as *mut i32).add(i) = self.i32(i),
            2 => *(d as *mut i16).add(i) = self.i16(i) as i16,
            _ => *d.add(i) = self.u8(i) as u8,
        }
    }
}

// Frame columns: SIM_FRAME_F32, SIM_FRAME_I32, the order, SIM_FRAME_I16, SIM_FRAME_U8.
const F_X: usize = 0; const F_Y: usize = 1; const F_PX: usize = 2; const F_PY: usize = 3;
const F_VX: usize = 4; const F_VY: usize = 5; const F_EN: usize = 6; const F_MAXE: usize = 7;
const F_TX: usize = 8; const F_TY: usize = 9; const F_FACE: usize = 10; const F_AMT: usize = 11;
const F_PHASE: usize = 12; const F_PRATE: usize = 13; const F_LIGHT: usize = 14; const F_SIG: usize = 15;
const F_R: usize = 16; const F_CARGO: usize = 17; const F_ID: usize = 18; const F_FLAGS: usize = 19;
const F_ODEST: usize = 20; const F_OTICK: usize = 21; const F_ORD: usize = 22; const F_OWN: usize = 23;
const F_WB: usize = 24; const F_LVL: usize = 25; const F_BLVL: usize = 26; const F_TYPE: usize = 27;
const F_WTYPE: usize = 28; const F_WSTATE: usize = 29; const F_STYLE: usize = 30; const F_MODE: usize = 31;
const F_STATUS: usize = 32; const F_FLASH: usize = 33; const F_CMD: usize = 34; const F_VIS: usize = 35;
#[inline(always)]
fn fsize(c: usize) -> usize { if c < 23 { 4 } else if c < 31 { 2 } else { 1 } }
// Metadata columns: SIM_META_I32, SIM_META_F32, SIM_META_I16, SIM_META_U8.
const M_ID: usize = 0; const M_FLAGS: usize = 1;
// (Lists as packed constants, 6 bits an entry, ten a 64-bit word: the module
// may hold no data segments, and a match became a lookup table in its data.)
#[inline(always)]
fn pk(w0: u64, w1: u64, w2: u64, w3: u64, i: usize) -> usize {
    let w = if i < 10 { w0 } else if i < 20 { w1 } else if i < 30 { w2 } else { w3 };
    ((w >> (6 * (i % 10))) & 63) as usize
}
// (Frame column, metadata column) i of META_COPY's 12.
#[inline(always)]
fn meta_copy(i: usize) -> (usize, usize) {
    (pk(0x2484478d879d71b, 0x554, 0x0, 0x0, i), pk(0x1c614434c2ca248, 0xc2, 0x0, 0x0, i))
}
// FILL_COLS (21), then STAMP_COPY's others (13 more).
const FILL_N: usize = 21; const STAMP_N: usize = 34;
#[inline(always)]
fn fill_col(i: usize) -> usize { pk(0x8901971440c2040, 0x30a2e07ce4e1699, 0x4478d879d71b48d, 0x554248, i) }
// The simulation's columns (its types: sim_unit_state.js).
const S_ID: usize = 0; const S_LIVE: usize = 1; const S_DEAD: usize = 2; const S_PVAT: usize = 3; const S_VX: usize = 4;
const S_VY: usize = 5; const S_AF: usize = 6; const S_STIX: usize = 7; const S_WTC: usize = 8; const S_CM: usize = 9;
const S_EN: usize = 10; const S_OWN: usize = 11; const S_CMD: usize = 12; const S_PVOD: usize = 13; const S_R: usize = 14;
const S_ELVL: usize = 15; const S_ULVL: usize = 16; const S_CMT: usize = 17;
// The status records' timers (Uint16, by record).
const S_BU: usize = 18; const S_PO: usize = 19; const S_FR: usize = 20; const S_WE: usize = 21; const S_SA: usize = 22;
const S_WA: usize = 23; const S_TH: usize = 24;
// The motion snapshot (Int32 eighths of a pixel): x, y, the tick before's.
const S_MX: usize = 25; const S_MY: usize = 26; const S_MPX: usize = 27; const S_MPY: usize = 28;
// The worker's per-slot state.
const T_LAST: usize = 0; const T_VX: usize = 1; const T_VY: usize = 2; const T_VID: usize = 3; const T_FA: usize = 4;
const T_FID: usize = 5; const T_FVX: usize = 6; const T_FVY: usize = 7; const T_FULL: usize = 8; const T_EASE: usize = 9;
const T_GX: usize = 10; const T_GY: usize = 11; const T_GID: usize = 12; const T_STAMPS: usize = 13;

// Flags (sim_frame.js SIM_UF_*).
const UF_BURNING: i32 = 16; const UF_POISONED: i32 = 32; const UF_FROZEN: i32 = 64; const UF_WET: i32 = 128;
const UF_SANDY: i32 = 256; const UF_WATCHED: i32 = 512; const UF_HIDDEN: i32 = 1024; const UF_TRANSFER: i32 = 8192;
const UF_GHOST: i32 = 65536;
const FILL_STATUS: i32 = UF_BURNING | UF_POISONED | UF_FROZEN | UF_WET | UF_SANDY | UF_WATCHED | UF_HIDDEN | UF_TRANSFER;
// presentation_worker.js constants.
const VIS_REST: f64 = 0.02; const VIS_LAG: f64 = 64.0;
const FACE_MIN_SPEED: f64 = 0.2; const FACE_DEAD: f64 = 0.04;
const PI: f64 = 3.141592653589793; const TAU: f64 = PI * 2.0; const INV_TAU: f64 = 1.0 / TAU;
const BLOCK: usize = 256;
// DIRTY_COLS (16), and the column each is marked by (DIRTY_FROM).
const DIRTY_N: usize = 16;
#[inline(always)]
fn dirty_from(i: usize) -> usize { pk(0x6d24d71900c2040, 0x7df8e184a, 0x0, 0x0, i) }
// (DIRTY_COLS' metadata columns: type and vision.)
#[inline(always)]
fn dirty_meta(i: usize) -> bool { i == 9 || i == 13 }
const DIRTY_ID: usize = 8;

/// A table of addresses (none: null).
#[derive(Clone, Copy)]
struct Tab(*const i32);
impl Tab {
    /// Column i in memory 0.
    #[inline(always)]
    unsafe fn p<T>(&self, i: usize) -> *mut T { waddr(*self.0.add(i) as u32) as *mut T }
    /// Column i in memory 1 (the simulation's).
    #[inline(always)]
    unsafe fn s(&self, i: usize) -> SP { SP(*self.0.add(i) as u32) }
    #[inline(always)]
    fn none(&self) -> bool { self.0.is_null() }
}
unsafe fn tab(k: &K, i: usize) -> Tab {
    Tab(if k.raw(i) == 0 { core::ptr::null() } else { k.p::<i32>(i) as *const i32 })
}
#[inline(always)]
unsafe fn copy_el(d: *mut u8, s: *const u8, sz: usize, i: usize) {
    match sz {
        4 => *(d as *mut u32).add(i) = *(s as *const u32).add(i),
        2 => *(d as *mut u16).add(i) = *(s as *const u16).add(i),
        _ => *d.add(i) = *s.add(i),
    }
}
#[inline(always)]
unsafe fn differs(a: *const u8, q: *const u8, sz: usize, i: usize) -> bool {
    match sz {
        4 => *(a as *const u32).add(i) != *(q as *const u32).add(i),
        2 => *(a as *const u16).add(i) != *(q as *const u16).add(i),
        _ => *a.add(i) != *q.add(i),
    }
}
// JavaScript's Math.round (halves up).
#[inline(always)]
fn js_round(x: f64) -> f64 { let r = floor(x); if x - r >= 0.5 { r + 1.0 } else { r } }
// presentation_worker.js's old fastAtan2: atan2 within ~1e-5 rad.
fn fast_atan2(y: f64, x: f64) -> f64 {
    let ax = if x < 0.0 { -x } else { x };
    let ay = if y < 0.0 { -y } else { y };
    let (mx, mn) = if ax > ay { (ax, ay) } else { (ay, ax) };
    if mx == 0.0 { return 0.0; }
    let a = mn / mx; let z = a * a;
    let mut r = (((((-0.0117212 * z + 0.05265332) * z - 0.11643287) * z + 0.19354346) * z - 0.33262347) * z + 0.99997726) * a;
    if ay > ax { r = 1.5707963267948966 - r; }
    if x < 0.0 { r = 3.141592653589793 - r; }
    if y < 0.0 { -r } else { r }
}
// A slot's position in the snapshot, in pixels (as Float32).
#[inline(always)]
unsafe fn pos(a: SP, s: usize) -> f32 { (a.i32(s) as f64 * 0.125) as f32 }

/// A range of a frame: kernels in turn (presentation_worker.js runRange):
/// k_pres_select (which slots, the copy forward), k_pres_p0..p9 (the
/// filled slots, pass by pass), k_pres_finish (the order), k_pres_tail
/// (ghosts, change marks). (As one function, V8 compiled the passes ~10x
/// slower than each alone.) All read the same argument block:
/// Arrays: 0 frame, 1 last frame (or none), 2 simulation columns, 3
/// metadata, 4 state (tables); 5 fill list, 6 copy list (i32), 7 blocks
/// filled (u8), 8 out (i32: count, changed, by marks, filled), 9 the
/// fog's light (f32, the ghosts' grid; or none).
/// P: 0 s0, 1 s1, 2 nn, 3 n, 4 player, 5 areaUnit, 6 metaCopy, 7 mode (0
/// whole, 1 by changes, 2 by the simulation's marks), 8 seq, 9 bseq, 10 K,
/// 11 phase, 12 ta, 13 visFollow, 14 visTurn, 15 faceVel, 16 lightFull,
/// 17 (unused), 18 has cmMode, 19 has pvOD, 20 ghosts, 21 gw, 22 gh, 23
/// tile, 24 marks, 25 pn, 26 nb, 27 the last fill on this thread was by
/// marks (a range with no slots keeps it).
// (The range: s0, s1 (clamped to nn), the unclamped end, n, mode.)
#[inline(always)]
unsafe fn range_of(k: &K) -> (usize, usize, usize, usize, i32) {
    let s0 = k.i(0).max(0) as usize; let js1 = k.i(1).max(0) as usize;
    (s0, js1.min(k.i(2).max(0) as usize), js1, k.i(3).max(0) as usize, k.i(7))
}
#[no_mangle]
pub unsafe extern "C" fn k_pres_select(a: u32, _: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (f, pf, c, m, t) = (tab(&k, 0), tab(&k, 1), tab(&k, 2), tab(&k, 3), tab(&k, 4));
    let (al, cl, bk, out) = (k.p::<i32>(5), k.p::<i32>(6), k.p::<u8>(7), k.p::<i32>(8));
    let (s0, s1, js1, n, mode) = range_of(&k);
    if s0 < s1 {
        let (count, changed, na) = select(&k, f, pf, c, m, t, al, cl, bk, s0, s1, n, mode);
        *out = count as i32; *out.add(1) = changed as i32; *out.add(2) = (mode == 2) as i32; *out.add(3) = na as i32;
    } else {
        if mode != 0 { core::ptr::write_bytes(bk, 0, (js1.max(s0) - s0 + BLOCK - 1) / BLOCK + 1); }
        *out = 0; *out.add(1) = 0; *out.add(2) = (k.i(27) != 0) as i32; *out.add(3) = 0;
    }
}
// The passes' arguments, or none (no slots in the range).
#[inline(always)]
unsafe fn passes_of(k: &K) -> Option<Fl> {
    let (s0, s1, _, n, mode) = range_of(k);
    if s0 >= s1 { return None; }
    let (f, c, m, t) = (tab(k, 0), tab(k, 2), tab(k, 3), tab(k, 4));
    Some(Fl { f, c, m, t, al: k.p::<i32>(5), na: *k.p::<i32>(8).add(3) as usize, fid: f.p::<i32>(F_ID), es: t.p::<u8>(T_EASE),
        mx: c.s(S_MX), my: c.s(S_MY), n, s0, s1, stamped: mode == 2, has_cm: k.i(18) != 0 })
}
#[no_mangle] pub unsafe extern "C" fn k_pres_p0(a: u32, _: i32) { let k = K::new(waddr(a) as *const i32); if let Some(x) = passes_of(&k) { p_motion(&k, x); } }
#[no_mangle] pub unsafe extern "C" fn k_pres_p1(a: u32, _: i32) { let k = K::new(waddr(a) as *const i32); if let Some(x) = passes_of(&k) { p_velocity(&k, x); } }
#[no_mangle] pub unsafe extern "C" fn k_pres_p2(a: u32, _: i32) { let k = K::new(waddr(a) as *const i32); if let Some(x) = passes_of(&k) { p_meta(&k, x); } }
#[no_mangle] pub unsafe extern "C" fn k_pres_p3(a: u32, _: i32) { let k = K::new(waddr(a) as *const i32); if let Some(x) = passes_of(&k) { p_order_dest(&k, x); } }
#[no_mangle] pub unsafe extern "C" fn k_pres_p4(a: u32, _: i32) { let k = K::new(waddr(a) as *const i32); if let Some(x) = passes_of(&k) { p_columns(&k, x); } }
#[no_mangle] pub unsafe extern "C" fn k_pres_p5(a: u32, _: i32) { let k = K::new(waddr(a) as *const i32); if let Some(x) = passes_of(&k) { p_flags(&k, x); } }
#[no_mangle] pub unsafe extern "C" fn k_pres_p6(a: u32, _: i32) { let k = K::new(waddr(a) as *const i32); if let Some(x) = passes_of(&k) { p_light(&k, x); } }
#[no_mangle] pub unsafe extern "C" fn k_pres_p7(a: u32, _: i32) { let k = K::new(waddr(a) as *const i32); if let Some(x) = passes_of(&k) { p_mode(&k, x); } }
#[no_mangle] pub unsafe extern "C" fn k_pres_p8(a: u32, _: i32) { let k = K::new(waddr(a) as *const i32); if let Some(x) = passes_of(&k) { p_facing(&k, x); } }
#[no_mangle] pub unsafe extern "C" fn k_pres_p9(a: u32, _: i32) { let k = K::new(waddr(a) as *const i32); if let Some(x) = passes_of(&k) { p_phase(&k, x); } }
/// The range's order: units the simulation recycled during the fill dropped
/// (not shown with another unit's metadata); by marks, the listed slots.
#[no_mangle]
pub unsafe extern "C" fn k_pres_finish(a: u32, _: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (s0, s1, _, _, mode) = range_of(&k);
    if s0 >= s1 { return; }
    let (f, c, m, t, al, out) = (tab(&k, 0), tab(&k, 2), tab(&k, 3), tab(&k, 4), k.p::<i32>(5), k.p::<i32>(8));
    let (fid, ford, l) = (f.p::<i32>(F_ID), f.p::<i32>(F_ORD), t.p::<i32>(T_LAST));
    let (cid, cdead, mid) = (c.s(S_ID), c.s(S_DEAD), m.s(M_ID));
    let (mut count, mut changed, na) = (*out as usize, *out.add(1) != 0, *out.add(3) as usize);
    if mode == 0 { let d = f.p::<f32>(F_SIG); for s in s0..s1 { *d.add(s) = 0.0; } }
    if mode == 2 {
        for i in 0..na {
            let s = *al.add(i) as usize; let id = *fid.add(s);
            if id >= 0 && (cid.i32(s) != id || mid.i32(s) != id || cdead.u8(s) != 0) { *fid.add(s) = -1; *l.add(s) = -1; changed = true; }
        }
        for s in s0..s1 { if *fid.add(s) >= 0 { *ford.add(s0 + count) = s as i32; count += 1; } }
    } else {
        for q in s0..s0 + count {
            let s = *ford.add(q) as usize; let id = *fid.add(s);
            if cid.i32(s) != id || mid.i32(s) != id || cdead.u8(s) != 0 { *fid.add(s) = -1; *l.add(s) = -1; changed = true; }
        }
        if changed {
            let mut j = s0;
            for q in s0..s0 + count { let s = *ford.add(q); if *fid.add(s as usize) >= 0 { *ford.add(j) = s; j += 1; } }
            count = j - s0;
        }
    }
    *out = count as i32; *out.add(1) = changed as i32;
}
/// The range's ghosts and change marks.
#[no_mangle]
pub unsafe extern "C" fn k_pres_tail(a: u32, _: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (s0, s1, js1, n, mode) = range_of(&k);
    let (f, pf, t, al, bk, out) = (tab(&k, 0), tab(&k, 1), tab(&k, 4), k.p::<i32>(5), k.p::<u8>(7), k.p::<i32>(8));
    if k.i(20) != 0 && s0 < s1 && k.raw(9) != 0 {
        ghosts(f, t, k.p::<f32>(9), s0, s1, k.i(21).max(1) as usize, k.i(22).max(1) as usize, k.f(23), k.i(4));
    }
    if k.i(24) != 0 && !pf.none() {
        let (b0, b1) = (s0 / BLOCK, (js1 + BLOCK - 1) / BLOCK);
        let (seq, nb, pn) = (k.i(8), k.i(26).max(0) as usize, k.i(25).max(0) as usize);
        let st = t.p::<i32>(T_STAMPS);
        if *out.add(2) != 0 && s0 < s1 { marks_slots(f, pf, al, *out.add(3) as usize, n, pn, b0, b1, seq, st, nb); }
        else {
            let act = if mode != 0 && s0 < s1 { bk } else { core::ptr::null_mut() };
            marks_range(f, pf, n, pn, b0, b1, seq, st, nb, act, k.i(6) != 0);
        }
    }
}

// Which of slots s0..s1 are filled, the others copied forward: returns
// (count listed from F.order[s0], changed, filled).
#[allow(clippy::too_many_arguments)]
#[inline(always)]
unsafe fn select(k: &K, f: Tab, pf: Tab, c: Tab, m: Tab, t: Tab, al: *mut i32, cl: *mut i32, bk: *mut u8,
               s0: usize, s1: usize, n: usize, mode: i32) -> (usize, bool, usize) {
    let fid = f.p::<i32>(F_ID); let ford = f.p::<i32>(F_ORD);
    let cid = c.s(S_ID); let clive = c.s(S_LIVE); let cdead = c.s(S_DEAD);
    let mid = m.s(M_ID); let l = t.p::<i32>(T_LAST);
    let fa = t.p::<i32>(T_FULL); let es = t.p::<u8>(T_EASE);
    let (mx, my) = (c.s(S_MX), c.s(S_MY));
    let has_cm = k.i(18) != 0;
    let seq = k.i(8); let bseq = k.i(9); let kk = k.i(10).max(1) as usize; let ph = k.i(11).max(0) as usize;
    let (mut count, mut changed, mut na, mut nc) = (0usize, false, 0usize, 0usize);
    let nbk = (s1 - s0 + BLOCK - 1) / BLOCK + 1;
    if mode == 0 {
        for s in s0..s1 {
            let id = cid.i32(s);
            *al.add(na) = s as i32; na += 1;
            if clive.u8(s) == 0 || cdead.u8(s) != 0 || mid.i32(s) != id {
                *fid.add(s) = -1;
                if *l.add(s) != -1 { changed = true; *l.add(s) = -1; }
                continue;
            }
            *fid.add(s) = id; *ford.add(s0 + count) = s as i32; count += 1;
            if *l.add(s) != id { changed = true; *l.add(s) = id; }
        }
        core::ptr::write_bytes(bk, 1, nbk);
        for s in s0..s1 { *fa.add(s) = seq; }
    } else if mode == 2 {
        let ca = c.s(S_PVAT); let ta = k.i(12);
        core::ptr::write_bytes(bk, 0, nbk);
        for s in s0..s1 {
            let mm = mid.i32(s);
            if ca.i32(s) > ta || *es.add(s) != 0 || (mm != *l.add(s) && mm == cid.i32(s)) || ((s >> 8) % kk) == ph {
                *al.add(na) = s as i32; na += 1; *fa.add(s) = seq; *bk.add((s - s0) / BLOCK) = 1;
                let id = cid.i32(s);
                if clive.u8(s) == 0 || cdead.u8(s) != 0 || mm != id { *fid.add(s) = -1; if *l.add(s) != -1 { changed = true; *l.add(s) = -1; } }
                else { *fid.add(s) = id; if *l.add(s) != id { changed = true; *l.add(s) = id; } }
            } else if *fa.add(s) > bseq { *cl.add(nc) = s as i32; nc += 1; }
        }
        for ci in 0..STAMP_N {
            let col = fill_col(ci);
            let (d, sp, sz) = (f.p::<u8>(col), pf.p::<u8>(col), fsize(col));
            for i in 0..nc { copy_el(d, sp, sz, *cl.add(i) as usize); }
        }
    } else {
        let (vx_, vy_, vi) = (t.p::<f32>(T_VX), t.p::<f32>(T_VY), t.p::<i32>(T_VID));
        let (cvx, cvy, af, on, tc, cm) = (c.s(S_VX), c.s(S_VY), c.s(S_AF), c.s(S_STIX), c.s(S_WTC), c.s(S_CM));
        let (pfl_, pfla, pvx, pvy, pen, pow, pcm) = (pf.p::<u8>(F_FLASH), pf.p::<i32>(F_FLAGS), pf.p::<f32>(F_VX), pf.p::<f32>(F_VY), pf.p::<f32>(F_EN), pf.p::<i16>(F_OWN), pf.p::<u8>(F_CMD));
        let (cen, cow, ccm) = (c.s(S_EN), c.s(S_OWN), c.s(S_CMD));
        core::ptr::write_bytes(bk, 0, nbk);
        for s in s0..s1 {
            let id = cid.i32(s);
            if clive.u8(s) == 0 || cdead.u8(s) != 0 || mid.i32(s) != id {
                *fid.add(s) = -1;
                if *l.add(s) != -1 { changed = true; *l.add(s) = -1; *al.add(na) = s as i32; na += 1; *bk.add((s - s0) / BLOCK) = 1; *fa.add(s) = seq; }
                else if *fa.add(s) > bseq { *cl.add(nc) = s as i32; nc += 1; }
                continue;
            }
            *fid.add(s) = id; *ford.add(s0 + count) = s as i32; count += 1;
            let mut act = *l.add(s) != id;
            if act { changed = true; *l.add(s) = id; }
            else {
                act = *vi.add(s) != id || *vx_.add(s) != pos(mx, s) || *vy_.add(s) != pos(my, s)
                    || cvx.f32(s) != 0.0 || cvy.f32(s) != 0.0 || *pvx.add(s) != 0.0 || *pvy.add(s) != 0.0
                    || af.u8(s) > 0 || *pfl_.add(s) > 0 || on.i32(s) != 0 || tc.u16(s) > 0
                    || (*pfla.add(s) & FILL_STATUS) != 0 || cen.f32(s) != *pen.add(s) || cow.i8(s) != *pow.add(s) as i32
                    || ccm.u8(s) != *pcm.add(s) as i32 || (has_cm && (cm.u8(s) & 4) != 0) || ((s >> 8) % kk) == ph;
            }
            if act { *al.add(na) = s as i32; na += 1; *fa.add(s) = seq; *bk.add((s - s0) / BLOCK) = 1; }
            else if *fa.add(s) > bseq { *cl.add(nc) = s as i32; nc += 1; }
        }
        for ci in 0..FILL_N {
            let col = fill_col(ci);
            let (d, sp, sz) = (f.p::<u8>(col), pf.p::<u8>(col), fsize(col));
            for i in 0..nc { copy_el(d, sp, sz, *cl.add(i) as usize); }
        }
    }
    let _ = (es, mx, my, has_cm, fid);
    (count, changed, na)
}

// A fill's slots and tables, for its passes.
#[derive(Clone, Copy)]
struct Fl { f: Tab, c: Tab, m: Tab, t: Tab, al: *mut i32, na: usize, fid: *mut i32, es: *mut u8, mx: SP, my: SP, n: usize, s0: usize, s1: usize, stamped: bool, has_cm: bool }
// Motion, smoothed for the eye: each unit drawn moving from where it was
// drawn last toward visFollow of the way to the simulation's place (the
// rest of the way at most VIS_LAG behind); new to its slot or hidden by
// a teleport, its simulation segment.
#[inline(never)]
unsafe fn p_motion(k: &K, x: Fl) {
    let Fl { f, c, m, t, al, na, fid, es, mx, my, n, s0, s1, stamped, has_cm } = x;
    let _ = (&f, &c, &m, &t, &al, &na, &fid, &es, &mx, &my, &n, &s0, &s1, &stamped, &has_cm, &k);
        let (dx, dy, dpx, dpy) = (f.p::<f32>(F_X), f.p::<f32>(F_Y), f.p::<f32>(F_PX), f.p::<f32>(F_PY));
        let (vx_, vy_, vi) = (t.p::<f32>(T_VX), t.p::<f32>(T_VY), t.p::<i32>(T_VID));
        let (ht, hx) = (c.s(S_TH), c.s(S_STIX));
        let (mpx, mpy) = (c.s(S_MPX), c.s(S_MPY));
        let follow0 = k.f(13);
        for i in 0..na {
            let s = *al.add(i) as usize; let id = *fid.add(s);
            if id < 0 { *vi.add(s) = -1; *es.add(s) = 0; continue; }
            let h = ht.u16(hx.i32(s) as usize);
            let (x, y) = (pos(mx, s), pos(my, s));
            let (ox, oy) = (*vx_.add(s), *vy_.add(s));
            let gap = (x as f64 - ox as f64).abs() + (y as f64 - oy as f64).abs();
            if *vi.add(s) != id || h > 0 {
                *dpx.add(s) = if h > 0 { x } else { pos(mpx, s) };
                *dpy.add(s) = if h > 0 { y } else { pos(mpy, s) };
                *dx.add(s) = x; *dy.add(s) = y; *vx_.add(s) = x; *vy_.add(s) = y; *vi.add(s) = id; *es.add(s) &= !1; continue;
            }
            if gap < VIS_REST { *dpx.add(s) = x; *dpy.add(s) = y; *dx.add(s) = x; *dy.add(s) = y; *vx_.add(s) = x; *vy_.add(s) = y; *es.add(s) &= !1; continue; }
            let follow = if gap > VIS_LAG { follow0.max(1.0 - VIS_LAG / gap) } else { follow0 };
            let nx = (ox as f64 + (x as f64 - ox as f64) * follow) as f32;
            let ny = (oy as f64 + (y as f64 - oy as f64) * follow) as f32;
            *dpx.add(s) = ox; *dpy.add(s) = oy; *dx.add(s) = nx; *dy.add(s) = ny; *vx_.add(s) = nx; *vy_.add(s) = ny;
            *es.add(s) |= 1;
        }
}
#[inline(never)]
unsafe fn p_velocity(k: &K, x: Fl) {
    let Fl { f, c, m, t, al, na, fid, es, mx, my, n, s0, s1, stamped, has_cm } = x;
    let _ = (&f, &c, &m, &t, &al, &na, &fid, &es, &mx, &my, &n, &s0, &s1, &stamped, &has_cm, &k);
        let (dvx, dvy, svx, svy) = (f.p::<f32>(F_VX), f.p::<f32>(F_VY), c.s(S_VX), c.s(S_VY));
        for i in 0..na { let s = *al.add(i) as usize; *dvx.add(s) = svx.f32(s); *dvy.add(s) = svy.f32(s); }
}
// Metadata: by slot when filled by marks, else the range whole when it changed.
#[inline(never)]
unsafe fn p_meta(k: &K, x: Fl) {
    let Fl { f, c, m, t, al, na, fid, es, mx, my, n, s0, s1, stamped, has_cm } = x;
    let _ = (&f, &c, &m, &t, &al, &na, &fid, &es, &mx, &my, &n, &s0, &s1, &stamped, &has_cm, &k);
        if stamped {
            for mi in 0..12 {
                let (fc, mc) = meta_copy(mi);
                let (d, sp, sz) = (f.p::<u8>(fc), m.s(mc), fsize(fc));
                for i in 0..na { sp.copy_to(d, sz, *al.add(i) as usize); }
            }
        } else if k.i(6) != 0 {
            for mi in 0..12 {
                let (fc, mc) = meta_copy(mi);
                let (d, sp, sz) = (f.p::<u8>(fc), m.s(mc), fsize(fc));
                for s in s0..s1 { sp.copy_to(d, sz, s); }
            }
        }
}
// (The order destinations: the units' column, made each tick by the marks kernel.)
#[inline(never)]
unsafe fn p_order_dest(k: &K, x: Fl) {
    let Fl { f, c, m, t, al, na, fid, es, mx, my, n, s0, s1, stamped, has_cm } = x;
    let _ = (&f, &c, &m, &t, &al, &na, &fid, &es, &mx, &my, &n, &s0, &s1, &stamped, &has_cm, &k);
        if k.i(19) != 0 {
            let (d, sp) = (f.p::<i32>(F_ODEST), c.s(S_PVOD));
            if stamped { for i in 0..na { let s = *al.add(i) as usize; *d.add(s) = sp.i32(s); } }
            else { for s in s0..s1 { *d.add(s) = sp.i32(s); } }
        }
}
#[inline(never)]
unsafe fn p_columns(k: &K, x: Fl) {
    let Fl { f, c, m, t, al, na, fid, es, mx, my, n, s0, s1, stamped, has_cm } = x;
    let _ = (&f, &c, &m, &t, &al, &na, &fid, &es, &mx, &my, &n, &s0, &s1, &stamped, &has_cm, &k);
        let (fo, so) = (f.p::<i16>(F_OWN), c.s(S_OWN));
        let (fe, se) = (f.p::<f32>(F_EN), c.s(S_EN));
        let (fr, sr) = (f.p::<f32>(F_R), c.s(S_R));
        let (fc, sc) = (f.p::<u8>(F_CMD), c.s(S_CMD));
        let (fl, sl) = (f.p::<i16>(F_LVL), c.s(S_ELVL));
        let (fb, sb) = (f.p::<i16>(F_BLVL), c.s(S_ULVL));
        let (ff, sf) = (f.p::<u8>(F_FLASH), c.s(S_AF));
        for i in 0..na {
            let s = *al.add(i) as usize;
            *fo.add(s) = so.i8(s) as i16; *fe.add(s) = se.f32(s); *fr.add(s) = sr.f32(s); *fc.add(s) = sc.u8(s) as u8;
            // (Levels: Int8, 0 not set; -1 in the frame below 0.)
            let v = sl.i8(s); *fl.add(s) = if v >= 0 { v as i16 } else { -1 };
            let v = sb.i8(s); *fb.add(s) = if v >= 0 { v as i16 } else { -1 };
            *ff.add(s) = sf.u8(s) as u8;
        }
}
#[inline(never)]
unsafe fn p_flags(k: &K, x: Fl) {
    let Fl { f, c, m, t, al, na, fid, es, mx, my, n, s0, s1, stamped, has_cm } = x;
    let _ = (&f, &c, &m, &t, &al, &na, &fid, &es, &mx, &my, &n, &s0, &s1, &stamped, &has_cm, &k);
        // Flags: the metadata's, the transfer cooldown, the status records' timers.
        let (d, mf) = (f.p::<i32>(F_FLAGS), m.s(M_FLAGS));
        let (bu, po, fr, we, sa, wa, th) = (c.s(S_BU), c.s(S_PO), c.s(S_FR), c.s(S_WE), c.s(S_SA), c.s(S_WA), c.s(S_TH));
        let (tc, on) = (c.s(S_WTC), c.s(S_STIX));
        for i in 0..na {
            let s = *al.add(i) as usize; let r = on.i32(s) as usize;
            let mut v = mf.i32(s) | if tc.u16(s) > 0 { UF_TRANSFER } else { 0 };
            if r != 0 {
                if bu.u16(r) > 0 { v |= UF_BURNING; } if po.u16(r) > 0 { v |= UF_POISONED; } if fr.u16(r) > 0 { v |= UF_FROZEN; }
                if we.u16(r) > 0 { v |= UF_WET; } if sa.u16(r) > 0 { v |= UF_SANDY; } if wa.u16(r) > 0 { v |= UF_WATCHED; }
                if th.u16(r) > 0 { v |= UF_HIDDEN; }
            }
            *d.add(s) = v;
        }
}
#[inline(never)]
unsafe fn p_light(k: &K, x: Fl) {
    let Fl { f, c, m, t, al, na, fid, es, mx, my, n, s0, s1, stamped, has_cm } = x;
    let _ = (&f, &c, &m, &t, &al, &na, &fid, &es, &mx, &my, &n, &s0, &s1, &stamped, &has_cm, &k);
        // The light a unit is drawn with at least: the full for a light
        // source of the viewing player (its own, or one it watches).
        let (d, o, wb, vis) = (f.p::<f32>(F_LIGHT), f.p::<i16>(F_OWN), f.p::<i16>(F_WB), f.p::<u8>(F_VIS));
        let (wa, on) = (c.s(S_WA), c.s(S_STIX));
        let (player, au, full) = (k.i(4), k.f(5), k.f(16));
        for i in 0..na {
            let s = *al.add(i) as usize; let r = on.i32(s) as usize;
            *d.add(s) = if *o.add(s) as i32 == player || (r != 0 && wa.u16(r) > 0 && *wb.add(s) as i32 == player) {
                (*vis.add(s) as f64 * au).max(full) as f32 } else { 0.0 };
        }
}
#[inline(never)]
unsafe fn p_mode(k: &K, x: Fl) {
    let Fl { f, c, m, t, al, na, fid, es, mx, my, n, s0, s1, stamped, has_cm } = x;
    let _ = (&f, &c, &m, &t, &al, &na, &fid, &es, &mx, &my, &n, &s0, &s1, &stamped, &has_cm, &k);
        let (x, y, px, py, fl, mo, st, am) = (f.p::<f32>(F_X), f.p::<f32>(F_Y), f.p::<f32>(F_PX), f.p::<f32>(F_PY), f.p::<u8>(F_FLASH), f.p::<u8>(F_MODE), f.p::<u8>(F_STATUS), f.p::<f32>(F_AMT));
        for i in 0..na {
            let s = *al.add(i) as usize;
            let dx = *x.add(s) as f64 - *px.add(s) as f64; let dy = *y.add(s) as f64 - *py.add(s) as f64;
            let moving = dx * dx + dy * dy > 0.0001; let flash = *fl.add(s) > 0;
            *mo.add(s) = if flash { 1 } else if moving { 0 } else { 7 };
            *st.add(s) = if flash { 1 } else if moving { 0 } else { 3 };
            *am.add(s) = if moving || flash { 1.0 } else { 0.7 };
        }
}
#[inline(never)]
unsafe fn p_facing(k: &K, x: Fl) {
    let Fl { f, c, m, t, al, na, fid, es, mx, my, n, s0, s1, stamped, has_cm } = x;
    let _ = (&f, &c, &m, &t, &al, &na, &fid, &es, &mx, &my, &n, &s0, &s1, &stamped, &has_cm, &k);
        // Facing: toward the fire target, else the smoothed movement, else as it was.
        let (d, vx_, vy_) = (f.p::<f32>(F_FACE), f.p::<f32>(F_VX), f.p::<f32>(F_VY));
        let (cm, ct) = (c.s(S_CM), c.s(S_CMT));
        let (fa_, fi, fvx, fvy) = (t.p::<f32>(T_FA), t.p::<i32>(T_FID), t.p::<f32>(T_FVX), t.p::<f32>(T_FVY));
        let (kv, kt) = (k.f(15), k.f(14)); let min2 = FACE_MIN_SPEED * FACE_MIN_SPEED;
        for i in 0..na {
            let s = *al.add(i) as usize; let id = *fid.add(s);
            if id < 0 { *fi.add(s) = -1; continue; }
            let fresh = *fi.add(s) != id;
            let (cvx, cvy) = (*vx_.add(s) as f64, *vy_.add(s) as f64);
            let mut vx = if fresh { cvx } else { *fvx.add(s) as f64 + (cvx - *fvx.add(s) as f64) * kv };
            let mut vy = if fresh { cvy } else { *fvy.add(s) as f64 + (cvy - *fvy.add(s) as f64) * kv };
            let mut settle = false;
            if !fresh { let ex = cvx - vx; let ey = cvy - vy; if ex * ex + ey * ey < 1e-6 { vx = cvx; vy = cvy; } else { settle = true; } }
            *fvx.add(s) = vx as f32; *fvy.add(s) = vy as f32;
            let mut want = f64::NAN;
            if has_cm && (cm.u8(s) & 20) == 4 {
                let q = ct.i32(s);
                if q >= 0 && (q as usize) < n {
                    let q = q as usize;
                    let dx = pos(mx, q) as f64 - pos(mx, s) as f64;
                    let dy = pos(my, q) as f64 - pos(my, s) as f64;
                    if dx != 0.0 || dy != 0.0 { want = fast_atan2(dx, dy); }
                }
            }
            if want != want && vx * vx + vy * vy > min2 { want = fast_atan2(vx, vy); }
            let mut a = if fresh { if want == want { want } else { 0.0 } } else { *fa_.add(s) as f64 };
            let mut turning = false;
            if want == want { let mut dd = want - a; dd -= js_round(dd * INV_TAU) * TAU; if dd.abs() > FACE_DEAD { a += dd * kt; turning = true; } }
            *fa_.add(s) = a as f32; *fi.add(s) = id; *d.add(s) = a as f32;
            *es.add(s) = if turning || settle { *es.add(s) | 2 } else { *es.add(s) & !2 };
        }
}
#[inline(never)]
unsafe fn p_phase(k: &K, x: Fl) {
    let Fl { f, c, m, t, al, na, fid, es, mx, my, n, s0, s1, stamped, has_cm } = x;
    let _ = (&f, &c, &m, &t, &al, &na, &fid, &es, &mx, &my, &n, &s0, &s1, &stamped, &has_cm, &k);
        let (d, r, fl) = (f.p::<f32>(F_PHASE), f.p::<f32>(F_PRATE), f.p::<u8>(F_FLASH));
        for i in 0..na {
            let s = *al.add(i) as usize; let p = *fid.add(s) as f64 * 2.399; let flv = *fl.add(s);
            *d.add(s) = (if flv > 0 { ((8.0 - flv as f64) / 8.0).max(0.0) * PI } else { p - floor(p * INV_TAU) * TAU }) as f32;
            *r.add(s) = if flv > 0 { (PI / 8.0) as f32 } else { 0.0 };
        }
}

// Team + history: units not seen now drawn where last seen, frozen until
// that place is seen again; else hidden (by the fog's light, as the page sees it).
#[inline(never)]
unsafe fn ghosts(f: Tab, t: Tab, light: *const f32, s0: usize, s1: usize, gw: usize, gh: usize, tile: f64, player: i32) {
    let it = 1.0 / tile;
    let (gx_, gy_, gi) = (t.p::<f32>(T_GX), t.p::<f32>(T_GY), t.p::<i32>(T_GID));
    let (fid, x, y, px, py, fl, own) = (f.p::<i32>(F_ID), f.p::<f32>(F_X), f.p::<f32>(F_Y), f.p::<f32>(F_PX), f.p::<f32>(F_PY), f.p::<i32>(F_FLAGS), f.p::<i16>(F_OWN));
    let cell = |vx: f32, vy: f32| -> usize {
        let tx = (floor(vx as f64 * it) as i64).clamp(0, gw as i64 - 1) as usize;
        let ty = (floor(vy as f64 * it) as i64).clamp(0, gh as i64 - 1) as usize;
        ty * gw + tx
    };
    for s in s0..s1 {
        let id = *fid.add(s);
        if id < 0 { *gi.add(s) = -1; continue; }
        if *own.add(s) as i32 == player { continue; }
        if *light.add(cell(*x.add(s), *y.add(s))) > 0.0 { *gx_.add(s) = *x.add(s); *gy_.add(s) = *y.add(s); *gi.add(s) = id; continue; }
        if *gi.add(s) == id && !(*light.add(cell(*gx_.add(s), *gy_.add(s))) > 0.0) {
            *x.add(s) = *gx_.add(s); *px.add(s) = *gx_.add(s); *y.add(s) = *gy_.add(s); *py.add(s) = *gy_.add(s);
            *fl.add(s) |= UF_GHOST; continue;
        }
        *fl.add(s) |= UF_HIDDEN; *gi.add(s) = -1;
    }
}

// Every column of block b marked.
#[inline(always)]
unsafe fn mark_all(st: *mut i32, nb: usize, b: usize, seq: i32) { for c in 0..DIRTY_N { *st.add(c * nb + b) = seq; } }
// Blocks b0..b1 of frame f against the last one: a live slot that differs
// (bit for bit), a unit new to its slot or a block past the last frame's
// count (every column); the id column at every difference. meta_only: the
// metadata's columns only.
#[inline(never)]
unsafe fn marks_run(f: Tab, pf: Tab, n: usize, pn: usize, b0: usize, b1: usize, seq: i32, st: *mut i32, nb: usize, meta_only: bool) {
    let (i_, j_) = (f.p::<i32>(F_ID), pf.p::<i32>(F_ID));
    for b in b0..b1 {
        let s0 = b * BLOCK; let e = if s0 + BLOCK < n { s0 + BLOCK } else { n };
        let (mut born, mut idhit) = (false, false);
        if !meta_only {
            born = e > pn; idhit = born;
            if !born { for s in s0..e { if *i_.add(s) != *j_.add(s) { idhit = true; if *i_.add(s) >= 0 { born = true; break; } } } }
        }
        let mut done = [0u8; 64];
        for ci in 0..DIRTY_N {
            if meta_only && !dirty_meta(ci) { continue; }
            let from = dirty_from(ci);
            let hit = if from == F_ID { idhit } else {
                if done[from] == 0 {
                    let mut h = born;
                    if !h {
                        let (a, q, sz) = (f.p::<u8>(from), pf.p::<u8>(from), fsize(from));
                        for s in s0..e { if differs(a, q, sz, s) && *i_.add(s) >= 0 { h = true; break; } }
                    }
                    done[from] = if h { 2 } else { 1 };
                }
                done[from] == 2
            };
            if hit { *st.add(ci * nb + b) = seq; }
        }
    }
}
// (act: per block from b0, whether the fill wrote a slot there; the others
// only the metadata's columns, when it was copied.)
unsafe fn marks_range(f: Tab, pf: Tab, n: usize, pn: usize, b0: usize, b1: usize, seq: i32, st: *mut i32, nb: usize, act: *const u8, meta_all: bool) {
    if act.is_null() { marks_run(f, pf, n, pn, b0, b1, seq, st, nb, false); return; }
    let mut b = b0;
    while b < b1 {
        let on = *act.add(b - b0) != 0;
        let mut e = b + 1;
        while e < b1 && (*act.add(e - b0) != 0) == on { e += 1; }
        if on { marks_run(f, pf, n, pn, b, e, seq, st, nb, false); }
        else if meta_all { marks_run(f, pf, n, pn, b, e, seq, st, nb, true); }
        b = e;
    }
}
// A frame by the simulation's marks: its filled slots only. (The columns
// compared by their marks' index (DIRTY_COLS), resolved once.)
#[inline(never)]
unsafe fn marks_slots(f: Tab, pf: Tab, al: *const i32, na: usize, n: usize, pn: usize, b0: usize, b1: usize, seq: i32, st: *mut i32, nb: usize) {
    let (i_, j_) = (f.p::<i32>(F_ID), pf.p::<i32>(F_ID));
    if n > pn { for b in b0.max(pn / BLOCK)..b1 { if (b + 1) * BLOCK > pn && b * BLOCK < n { mark_all(st, nb, b, seq); } } }
    let w = |c: usize| (f.p::<u32>(c) as *const u32, pf.p::<u32>(c) as *const u32);
    let h = |c: usize| (f.p::<u16>(c) as *const u16, pf.p::<u16>(c) as *const u16);
    let y = |c: usize| (f.p::<u8>(c) as *const u8, pf.p::<u8>(c) as *const u8);
    let (x, yy, px, py, r, en, fl, fa) = (w(F_X), w(F_Y), w(F_PX), w(F_PY), w(F_R), w(F_EN), w(F_FLAGS), w(F_FACE));
    let (ow, ty) = (h(F_OWN), h(F_TYPE));
    let (fs, vi, mo) = (y(F_FLASH), y(F_VIS), y(F_MODE));
    for i in 0..na {
        let s = *al.add(i) as usize; let b = s / BLOCK; let id = *i_.add(s);
        if s >= n { continue; }
        if id != *j_.add(s) { *st.add(DIRTY_ID * nb + b) = seq; if id >= 0 { mark_all(st, nb, b, seq); continue; } }
        if id < 0 { continue; }
        let mut mark = |ci: usize| { *st.add(ci * nb + b) = seq; };
        if *x.0.add(s) != *x.1.add(s) { mark(0); }
        if *yy.0.add(s) != *yy.1.add(s) { mark(1); }
        if *px.0.add(s) != *px.1.add(s) { mark(2); }
        if *py.0.add(s) != *py.1.add(s) { mark(3); }
        if *r.0.add(s) != *r.1.add(s) { mark(4); }
        if *en.0.add(s) != *en.1.add(s) { mark(5); }
        if *ow.0.add(s) != *ow.1.add(s) { mark(6); }
        if *fl.0.add(s) != *fl.1.add(s) { mark(7); }
        if *ty.0.add(s) != *ty.1.add(s) { mark(9); }
        if *fa.0.add(s) != *fa.1.add(s) { mark(10); }
        if *fs.0.add(s) != *fs.1.add(s) { mark(11); mark(12); }
        if *vi.0.add(s) != *vi.1.add(s) { mark(13); }
        if *mo.0.add(s) != *mo.1.add(s) { mark(14); mark(15); }
    }
}

/// The fog's light: each tile's light easing toward what is seen (up at
/// rise a tick, down at fall after the hold), the fog's grid (with history
/// a floor where once explored). Arrays: 0 sight (f32, memory 1: the
/// simulation's grid), 1 light, 2 fog (f32), 3 explored (u8), 4 hold (i32).
/// P: 0 tiles, 1 now, 2 hold ticks, 3 rise, 4 fall, 5 full, 6 reset, 7
/// history, 8 range, 9 floor, 10 rewind (ticks back).
#[no_mangle]
pub unsafe extern "C" fn k_pres_fog(a: u32, _: i32) {
    let k = K::new(waddr(a) as *const i32);
    let sg = SP(k.raw(0));
    let (l, g, e, hd) = (k.p::<f32>(1), k.p::<f32>(2), k.p::<u8>(3), k.p::<i32>(4));
    let n = k.i(0).max(0) as usize; let now = k.i(1); let hold = k.i(2);
    let (rise, fall) = (k.f(3), k.f(4));
    let (full, reset, hist) = (k.i(5) != 0, k.i(6) != 0, k.i(7) != 0);
    let (range, flo) = (k.f(8), k.f(9)); let back = k.i(10);
    if back > 0 { for i in 0..n { *hd.add(i) -= back; } }
    for i in 0..n {
        let target = sg.f32(i) as f64; let current = *l.add(i) as f64;
        if target == 0.0 && current == 0.0 && !full { continue; }
        if target > 0.0 { *hd.add(i) = now + hold; *e.add(i) = 1; }
        let mut next = target;
        if !reset {
            if target == 0.0 && now <= *hd.add(i) { next = current; }
            else { let d = target - current; next = current + if d > rise { rise } else if d < -fall { -fall } else { d }; }
        }
        *l.add(i) = next as f32;
        let mut fv = *l.add(i) as f64;
        if hist && *e.add(i) != 0 { let dark = 1.0 - (fv / range).min(1.0); fv += flo * dark * dark * dark; }
        *g.add(i) = fv as f32;
    }
}

/// Units the simulation moved to other slots: their drawn position, facing,
/// easing and last-seen ghost follow them. Arrays: 0 pairs (from, to; memory
/// 0), 1 ids by slot (memory 1: the simulation's column), 2 state. P: 0
/// pairs, 1 slots (cap), 2 ghosts.
#[no_mangle]
pub unsafe extern "C" fn k_pres_moves(a: u32, _: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (pr, ids, t) = (k.p::<i32>(0), SP(k.raw(1)), tab(&k, 2));
    let (np, cap, gh) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2) != 0);
    let (vx, vy, vi) = (t.p::<f32>(T_VX), t.p::<f32>(T_VY), t.p::<i32>(T_VID));
    let (fa, fi, fvx, fvy) = (t.p::<f32>(T_FA), t.p::<i32>(T_FID), t.p::<f32>(T_FVX), t.p::<f32>(T_FVY));
    let (gx, gy, gi, es) = (t.p::<f32>(T_GX), t.p::<f32>(T_GY), t.p::<i32>(T_GID), t.p::<u8>(T_EASE));
    for j in 0..np {
        let (f_, t_) = (*pr.add(2 * j), *pr.add(2 * j + 1));
        if f_ < 0 || t_ < 0 || f_ as usize >= cap || t_ as usize >= cap { continue; }
        let (f_, t_) = (f_ as usize, t_ as usize);
        let id = ids.i32(t_);
        if id <= 0 { continue; }
        if *vi.add(f_) == id { *vx.add(t_) = *vx.add(f_); *vy.add(t_) = *vy.add(f_); *vi.add(t_) = id; *vi.add(f_) = -1; }
        if *fi.add(f_) == id { *fa.add(t_) = *fa.add(f_); *fvx.add(t_) = *fvx.add(f_); *fvy.add(t_) = *fvy.add(f_); *fi.add(t_) = id; *fi.add(f_) = -1; }
        if gh && *gi.add(f_) == id { *gx.add(t_) = *gx.add(f_); *gy.add(t_) = *gy.add(f_); *gi.add(t_) = id; *gi.add(f_) = -1; }
        *es.add(t_) = *es.add(f_); *es.add(f_) = 0;
    }
}

/// The tiles whose type or owner changed since the last call (the page's
/// map: presentation_worker.js world.state.cells): (tile, type, owner)
/// triples. Arrays: 0 types (u8), 1 owners (i8; memory 1: the map's
/// columns), 2 last (i32 pairs a tile), 3 out (i32 triples), 4 count (i32).
/// P: 0 tiles.
#[no_mangle]
pub unsafe extern "C" fn k_pres_cells(a: u32, _: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ty, ow) = (SP(k.raw(0)), SP(k.raw(1)));
    let (old, out, cnt) = (k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4));
    let mut j = 0usize;
    for i in 0..k.i(0).max(0) as usize {
        let (a_, b_) = (ty.u8(i), ow.i8(i));
        if a_ != *old.add(2 * i) || b_ != *old.add(2 * i + 1) {
            *old.add(2 * i) = a_; *old.add(2 * i + 1) = b_;
            *out.add(3 * j) = i as i32; *out.add(3 * j + 1) = a_; *out.add(3 * j + 2) = b_; j += 1;
        }
    }
    *cnt = j as i32;
}
