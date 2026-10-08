//! The simulation's heavy kernels in Rust (wasm32 + simd128), twins of the
//! JavaScript kernels in src/sim/sim_parallel.js (SIM_KERNEL_SEP_PACK,
//! SEP_MARK, SEP_PAIRS, SEPARATION_FINISH, ACQ_SCAN): the same inputs give
//! the same outputs bit for bit, so a chunk may run in either, on any
//! thread, and peers with and without wasm stay in lockstep.
//!
//! Arrays are the game's own typed arrays: they live in the shared wasm
//! memory (src/sim/sim_wasm.js allocates them there), and a kernel gets
//! their addresses. Every helper thread instantiates this module over that
//! one memory (each with its own stack). No statics, no allocation, no data
//! segments (wasm/build.cjs checks): instantiating it again rewrites nothing.
//!
//! JavaScript number semantics are reproduced where they show: Math.round
//! (halves up, -0), Math.max (NaN), ToInt32, typed array stores (f32
//! rounding), `||` on numbers. Float operations are IEEE-754 in both
//! (no fused multiply-add: simd128 has none), in the same order.
#![no_std]
#![allow(clippy::too_many_arguments, clippy::missing_safety_doc)]

use core::arch::wasm32::*;

mod mv;
mod k;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    unreachable()
}

// ---- JavaScript number semantics ----
// (core has no scalar floor/ceil/sqrt without std: the simd128 lane ops,
// the same IEEE results.)
#[inline(always)]
fn floor(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_floor(f64x2_splat(x)))
}
#[inline(always)]
fn ceil(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_ceil(f64x2_splat(x)))
}
#[inline(always)]
fn sqrt(x: f64) -> f64 {
    f64x2_extract_lane::<0>(f64x2_sqrt(f64x2_splat(x)))
}
#[inline(always)]
fn abs(x: f64) -> f64 {
    f64::from_bits(x.to_bits() & !(1u64 << 63))
}
/// Math.round: halves toward +Infinity; -0 for x in [-0.5, -0].
#[inline(always)]
fn js_round(x: f64) -> f64 {
    let f = floor(x);
    // (x - floor(x) is exact.)
    let r = if x - f >= 0.5 { f + 1.0 } else { f };
    if r == 0.0 && x.is_sign_negative() {
        -0.0
    } else {
        r
    }
}
/// Math.max(a, b): NaN if either is, +0 over -0.
#[inline(always)]
fn js_max(a: f64, b: f64) -> f64 {
    if a != a || b != b {
        return f64::NAN;
    }
    if a > b {
        a
    } else if b > a {
        b
    } else if a.is_sign_negative() {
        b
    } else {
        a
    }
}
/// Math.min(a, b) for the non-NaN, non-zero values it is used on here.
#[inline(always)]
fn js_min(a: f64, b: f64) -> f64 {
    if a != a || b != b {
        return f64::NAN;
    }
    if a < b {
        a
    } else {
        b
    }
}
/// ToInt32 (an Int32Array store, `| 0`).
#[inline(always)]
fn to_i32(x: f64) -> i32 {
    if x >= -2147483648.0 && x <= 2147483647.0 {
        x as i32
    } else if x.is_finite() {
        (x as i64) as i32
    } else {
        0
    }
}
/// Integer / and % without Rust's panics (a zero divisor gives 0; the
/// callers never pass one): no panic location data in the module.
#[inline(always)]
fn idiv(a: i32, b: i32) -> i32 {
    if b == 0 { 0 } else { a.wrapping_div(b) }
}
#[inline(always)]
fn irem(a: i32, b: i32) -> i32 {
    if b == 0 { 0 } else { a.wrapping_rem(b) }
}
/// `v || 0`-style truthiness of a number: not 0, -0 or NaN.
#[inline(always)]
fn truthy(v: f64) -> bool {
    v != 0.0 && v == v
}

#[inline(always)]
unsafe fn rd<T: Scalar>(p: *const T, i: usize) -> T::Value { (*p.add(i)).load() }
#[inline(always)]
unsafe fn wr<T: Scalar>(p: *mut T, i: usize, v: T::Value) { *p.add(i) = T::store(v); }
trait Scalar: Copy { type Value; fn load(self) -> Self::Value; fn store(v: Self::Value) -> Self; }
macro_rules! scalar { ($($t:ty),*) => { $(impl Scalar for $t { type Value = $t; #[inline(always)] fn load(self)->$t { self } #[inline(always)] fn store(v:$t)->Self { v } })* }; }
scalar!(u8,i8,u16,i16,u32,i32,u64,i64,usize,f32,f64);
#[repr(transparent)]
#[derive(Clone, Copy)]
pub struct F32(f32);
impl Scalar for F32 { type Value=f64; #[inline(always)] fn load(self)->f64 { self.0 as f64 } #[inline(always)] fn store(v:f64)->Self { Self(v as f32) } }
#[repr(transparent)]
#[derive(Clone, Copy)]
pub struct I32Number(i32);
impl Scalar for I32Number { type Value=f64; #[inline(always)] fn load(self)->f64 { self.0 as f64 } #[inline(always)] fn store(v:f64)->Self { Self(to_i32(v)) } }
// Narrow integer columns read and written as i32 (owners: Int8Array, -1 none;
// commands and flash timers: Uint8Array), as the JS typed arrays convert.
#[repr(transparent)]
#[derive(Clone, Copy)]
pub struct I8I32(i8);
impl Scalar for I8I32 { type Value=i32; #[inline(always)] fn load(self)->i32 { self.0 as i32 } #[inline(always)] fn store(v:i32)->Self { Self(v as i8) } }
#[repr(transparent)]
#[derive(Clone, Copy)]
pub struct U8I32(u8);
impl Scalar for U8I32 { type Value=i32; #[inline(always)] fn load(self)->i32 { self.0 as i32 } #[inline(always)] fn store(v:i32)->Self { Self(v as u8) } }

// =====================================================================
// SEPARATION
// =====================================================================
// The chain (unit.js separationStart / separationPrebuildStages):
//   sep_pack: each entry of the unit index packed (sep.qx/qy/qr: Float32
//     position and radius, sep.meta: owner | layer << 8 | bits << 16 (1 takes
//     part, 2 moved by itself), sep.qid, sep.ord: its slot or -1).
//   sep_mark: units at rest beside a chunk where one moved take part too.
//   sep_pairs (twice: even bands of chunk rows, then odd): every touching
//     pair once, both sides' pushes summed into their slots.
//   sep_finish: the summed pushes applied (by slot).
// Mark and pairs look at neighbouring chunks through the entries alone
// (sorted by chunk key): a cursor per neighbouring row moves forward with
// the entry, so nothing of the (mostly empty) chunk grid is read.

/// Math.max(.1, CR || R || .1): a unit's collision radius from its columns.
#[inline(always)]
fn sep_radius(cr: f64, r: f64) -> f64 {
    let v = if truthy(cr) {
        cr
    } else if truthy(r) {
        r
    } else {
        0.1
    };
    js_max(0.1, v)
}

#[no_mangle]
pub unsafe extern "C" fn sep_pack(
    eslot: *const i32,
    xs: *const F32,
    ys: *const F32,
    dead: *const u8,
    r0: *const F32,
    layer: *const u8,
    crl: *const F32,
    rdl: *const F32,
    owner: *const I8I32,
    id: *const i32,
    smv: *const u8,
    ord: *mut i32,
    qx: *mut f32,
    qy: *mut f32,
    qr: *mut f32,
    meta: *mut i32,
    qid: *mut i32,
    nl: i32,
    per: i32,
    rest0: i32,
    t0: i32,
    mode: i32,
    live: i32,
    chunk: i32,
) {
    let nl = if nl > 0 { nl as usize } else { 0 };
    let start = chunk as usize * per as usize;
    let end = core::cmp::min(nl, start + per as usize);
    let rest = if mode == 2 { core::cmp::max(1, rest0 >> 1) } else { rest0 };
    let run = if mode == 2 { t0 >> 1 } else { t0 };
    let live = live != 0;
    for j in start..end {
        let s0 = rd(eslot, j);
        let s = if s0 >= 0 && rd(dead, s0 as usize) != 0 { -1 } else { s0 };
        wr(ord, j, s);
        if s < 0 {
            wr(meta, j, 0xFFFF);
            wr(qx, j, 1e9);
            wr(qy, j, 1e9);
            wr(qr, j, 0.1);
            wr(qid, j, 0);
            continue;
        }
        let su = s as usize;
        let uid = rd(id, su);
        let moved = rd(smv, su) == 1;
        let own = mode != 0 || (t0.wrapping_add(uid) & 1) == 0;
        wr(qx, j, rd(xs, su) as f32);
        wr(qy, j, rd(ys, su) as f32);
        wr(qr, j, (if live { sep_radius(rd(crl, su), rd(rdl, su)) } else { rd(r0, su) }) as f32);
        wr(qid, j, uid);
        let part = own && (moved || rest <= 1 || irem(run.wrapping_add(uid), rest) == 0);
        let sc = (if moved { 2 } else { 0 }) | (if part { 1 } else { 0 });
        wr(meta, j, sc << 16 | ((rd(layer, su) as i32) & 255) << 8 | (rd(owner, su) & 255));
    }
}

/// The first entry in [lo, hi) whose key is at least k (keys sorted).
#[inline(always)]
unsafe fn lower_bound(keys: *const i32, mut lo: usize, mut hi: usize, k: i32) -> usize {
    while lo < hi {
        let m = (lo + hi) >> 1;
        if rd(keys, m) < k {
            lo = m + 1;
        } else {
            hi = m;
        }
    }
    lo
}

/// Units at rest (not yet taking part, on their own tick when staggered)
/// with a unit that moved in their chunk's 3x3 take part. (The JS kernel's
/// rule: a chunk is "moved" when an entry in it has the moved bit; empty and
/// dead entries never do.)
#[no_mangle]
pub unsafe extern "C" fn sep_mark(
    meta: *mut i32,
    ekey: *const i32,
    ord: *const i32,
    qid: *const i32,
    nl: i32,
    per: i32,
    cw: i32,
    ch: i32,
    t0: i32,
    stag: i32,
    chunk: i32,
) {
    let nl = if nl > 0 { nl as usize } else { 0 };
    let start = chunk as usize * per as usize;
    let end = core::cmp::min(nl, start + per as usize);
    if start >= end {
        return;
    }
    // A byte per chunk of the job's rows and the rows beside them: 1 where
    // an entry has the moved bit (other jobs only set the takes-part bit
    // meanwhile). On the stack (64 KB); else the cursors below.
    const TAB_MAX: usize = 65536;
    let ra = { let r = idiv(rd(ekey, start), cw) - 1; if r > 0 { r } else { 0 } };
    let rb = { let r = idiv(rd(ekey, end - 1), cw) + 1; if r < ch - 1 { r } else { ch - 1 } };
    let cwu = cw as usize;
    if rb >= ra && ((rb - ra + 1) as usize) * cwu <= TAB_MAX {
        let mut tab_buf = core::mem::MaybeUninit::<[u8; TAB_MAX]>::uninit();
        let tab = tab_buf.as_mut_ptr() as *mut u8;
        let base = ra * cw;
        core::ptr::write_bytes(tab, 0, ((rb - ra + 1) as usize) * cwu);
        let e1 = lower_bound(ekey, start, nl, (rb + 1) * cw);
        let mut e = lower_bound(ekey, 0, start, base);
        while e < e1 {
            if (rd(meta, e) & 131072) != 0 {
                wr(tab, (rd(ekey, e) - base) as usize, 1);
            }
            e += 1;
        }
        let mut last_key = -1i32;
        let mut last_near = false;
        for k in start..end {
            let m = rd(meta, k);
            if (m & 65536) != 0 || rd(ord, k) < 0 || (stag != 0 && (t0.wrapping_add(rd(qid, k)) & 1) != 0) {
                continue;
            }
            let key = rd(ekey, k);
            if key != last_key {
                last_key = key;
                let cx = irem(key, cw);
                let cy = idiv(key - cx, cw);
                let c0 = if cx > 0 { cx - 1 } else { 0 };
                let c1 = if cx + 1 < cw { cx + 1 } else { cw - 1 };
                let y0 = if cy > ra { cy - 1 } else { ra };
                let y1 = if cy < rb { cy + 1 } else { rb };
                let mut near = 0u8;
                let mut y = y0;
                while y <= y1 {
                    let row = tab.add(((y - ra) as usize) * cwu);
                    let mut c = c0;
                    while c <= c1 {
                        near |= rd(row, c as usize);
                        c += 1;
                    }
                    y += 1;
                }
                last_near = near != 0;
            }
            if last_near {
                wr(meta, k, m | 65536);
            }
        }
        return;
    }
    // Cursors of the rows above, at and below: the first entry at or past
    // the row's leftmost chunk of the 3x3 (only ever forward).
    let mut cur = [usize::MAX; 3];
    let mut last_key = -1i32;
    let mut last_near = false;
    for k in start..end {
        let m = rd(meta, k);
        if (m & 65536) != 0 || rd(ord, k) < 0 || (stag != 0 && (t0.wrapping_add(rd(qid, k)) & 1) != 0) {
            continue;
        }
        let key = rd(ekey, k);
        if key != last_key {
            last_key = key;
            let cx = irem(key, cw);
            let cy = idiv(key - cx, cw);
            let c0 = if cx > 0 { cx - 1 } else { 0 };
            let c1 = if cx + 1 < cw { cx + 1 } else { cw - 1 };
            let mut near = false;
            for r in 0..3 {
                let ny = cy + r as i32 - 1;
                if ny < 0 || ny >= ch {
                    continue;
                }
                let k0 = ny * cw + c0;
                let k1 = ny * cw + c1;
                let mut e = if cur[r] == usize::MAX { lower_bound(ekey, 0, nl, k0) } else { cur[r] };
                while e < nl && rd(ekey, e) < k0 {
                    e += 1;
                }
                cur[r] = e;
                while e < nl && rd(ekey, e) <= k1 {
                    if (rd(meta, e) & 131072) != 0 {
                        near = true;
                        break;
                    }
                    e += 1;
                }
                if near {
                    break;
                }
            }
            last_near = near;
        }
        if last_near {
            wr(meta, k, m | 65536);
        }
    }
}

/// One side's push direction (unit.js _simSepSide): away from the other
/// unit (ux, uy: from it to this one), or, exactly on top of it, sideways by id.
#[inline(always)]
fn push_dir(ux: f64, uy: f64, d: f64, id: i32, oid: i32) -> (f64, f64) {
    if d > 0.001 {
        (ux / d, uy / d)
    } else {
        let dir = id & 3;
        let mdx = if dir == 0 { 1.0 } else if dir == 2 { -1.0 } else { 0.0 };
        let mdy = if dir == 1 { 1.0 } else if dir == 3 { -1.0 } else { 0.0 };
        let sign = if id < oid { -1.0 } else { 1.0 };
        if abs(mdx) >= abs(mdy) {
            (0.0, (if mdx >= 0.0 { -1.0 } else { 1.0 }) * sign)
        } else {
            ((if mdy >= 0.0 { 1.0 } else { -1.0 }) * sign, 0.0)
        }
    }
}

/// The pair kernel's state for one entry p (its own side summed locally).
struct PairP {
    xp: f64,
    yp: f64,
    rp: f64,
    ip: i32,
    op: i32,
    pl: i32,
    p_part: i32,
    p_moved: bool,
    acc_px: f64,
    acc_py: f64,
    acc_ov: f64,
    acc_hit: u32,
}

/// The pair kernel's constants and outputs.
struct PairOut {
    ord: *const i32,
    qx: *const f32,
    qy: *const f32,
    qr: *const f32,
    meta: *const i32,
    qid: *const i32,
    px_out: *mut f64,
    py_out: *mut f64,
    ov_out: *mut F32,
    hit_out: *mut u32,
    pad: f64,
    qscale: f64,
    both: f64,
    one: f64,
    mover: f64,
    yield_: f64,
}

/// The exact test of entry q against p and both sides' pushes (the JS
/// kernel's arithmetic, in its order). Layer and participation are checked
/// by the caller.
#[inline(always)]
unsafe fn pair_exact(o: &PairOut, p: &mut PairP, q: usize) {
    let qm = rd(o.meta, q);
    let dxe = rd(o.qx, q) as f64 - p.xp;
    let dye = rd(o.qy, q) as f64 - p.yp;
    let d2e = dxe * dxe + dye * dye;
    let min_dist = p.rp + rd(o.qr, q) as f64 + (if (qm & 255) == p.op { 0.0 } else { o.pad });
    if d2e >= min_dist * min_dist {
        return;
    }
    let bq = rd(o.ord, q);
    if bq < 0 {
        return;
    }
    let q_part = (qm >> 16) & 1;
    let d = sqrt(d2e);
    let dm = if d != d { d } else if d > 0.001 { d } else { 0.001 };
    let overlap = min_dist - dm;
    let q_moved = (qm & 131072) != 0;
    let iq = rd(o.qid, q);
    if p.p_part != 0 {
        let share = if p.p_moved == q_moved {
            if q_part != 0 { o.both } else { o.one }
        } else if p.p_moved {
            if q_part != 0 { o.mover } else { o.one }
        } else {
            o.yield_
        };
        let (nx, ny) = push_dir(-dxe, -dye, d, p.ip, iq);
        let f = overlap * share * o.qscale;
        p.acc_px += js_round(nx * f);
        p.acc_py += js_round(ny * f);
        if overlap > p.acc_ov {
            p.acc_ov = overlap;
        }
        p.acc_hit += 1;
    }
    if q_part != 0 {
        let share = if q_moved == p.p_moved {
            if p.p_part != 0 { o.both } else { o.one }
        } else if q_moved {
            if p.p_part != 0 { o.mover } else { o.one }
        } else {
            o.yield_
        };
        let (nx, ny) = push_dir(dxe, dye, d, iq, p.ip);
        let f = overlap * share * o.qscale;
        let b = bq as usize;
        wr(o.px_out, b, rd(o.px_out, b) + js_round(nx * f));
        wr(o.py_out, b, rd(o.py_out, b) + js_round(ny * f));
        if overlap > rd(o.ov_out, b) {
            wr(o.ov_out, b, overlap);
        }
        wr(o.hit_out, b, rd(o.hit_out, b) + 1);
    }
}

/// p's lanes for the four-at-a-time test.
struct PairV {
    xp4: v128,
    yp4: v128,
    rp4: v128,
    op4: v128,
    pl4: v128,
    pi4: v128,
}

/// Entries s0..s1 against p (which takes part), four at a time: a
/// conservative f32 distance test, the layer, and the pair rule (not p
/// itself; a q taking part too counts the pair itself when it comes
/// first), no branch per entry; only the candidates go on to the exact
/// test.
#[inline(always)]
unsafe fn pair_run(o: &PairOut, p: &mut PairP, v: &PairV, s0: usize, s1: usize) {
    let padf = f32x4_splat(o.pad as f32);
    // (A margin far above the f32 test's rounding: it never rejects a pair
    // the exact test takes; NaN distances go on, as in JS.)
    let kmul = f32x4_splat(1.0001);
    let m255 = i32x4_splat(255);
    let mlay = i32x4_splat(0xFF00);
    let mpart = i32x4_splat(0x10000);
    let zero = i32x4_splat(0);
    let iota = i32x4(0, 1, 2, 3);
    let mut q = s0;
    while q < s1 {
        let x4 = v128_load(o.qx.add(q) as *const v128);
        let y4 = v128_load(o.qy.add(q) as *const v128);
        let r4 = v128_load(o.qr.add(q) as *const v128);
        let m4 = v128_load(o.meta.add(q) as *const v128);
        let dx = f32x4_sub(x4, v.xp4);
        let dy = f32x4_sub(y4, v.yp4);
        let d2 = f32x4_add(f32x4_mul(dx, dx), f32x4_mul(dy, dy));
        let same = i32x4_eq(v128_and(m4, m255), v.op4);
        let md = f32x4_add(f32x4_add(v.rp4, r4), v128_andnot(padf, same));
        let lim2 = f32x4_mul(f32x4_mul(md, md), kmul);
        let idx4 = i32x4_add(i32x4_splat(q as i32), iota);
        let skip = v128_or(i32x4_eq(idx4, v.pi4), v128_and(i32x4_ne(v128_and(m4, mpart), zero), i32x4_lt(idx4, v.pi4)));
        let ok = v128_andnot(v128_and(v128_not(f32x4_ge(d2, lim2)), i32x4_eq(v128_and(m4, mlay), v.pl4)), skip);
        let mut bits = (i32x4_bitmask(ok) as u32) & (i32x4_bitmask(i32x4_lt(iota, i32x4_splat((s1 - q) as i32))) as u32);
        while bits != 0 {
            let qi = q + bits.trailing_zeros() as usize;
            bits &= bits - 1;
            pair_exact(o, p, qi);
        }
        q += 4;
    }
}

/// Every touching pair of units of the same layer, at least one taking
/// part, once: found by the unit that takes part (both: the earlier entry),
/// which looks at the units around it. Units of a band of chunk rows look
/// (bands 2 * reach rows apart in one stage write different slots). The
/// same pairs as the JS kernel's, so the same integer sums. Each row's run
/// of entries over the chunks in reach from a table of the chunks' starts.
#[no_mangle]
pub unsafe extern "C" fn sep_pairs(
    ord: *const i32,
    qx: *const f32,
    qy: *const f32,
    qr: *const f32,
    meta: *const i32,
    qid: *const i32,
    keys: *const i32,
    px_out: *mut f64,
    py_out: *mut f64,
    ov_out: *mut F32,
    hit_out: *mut u32,
    cw: i32,
    ch: i32,
    h: i32,
    pad: f64,
    far_any: f64,
    qscale: f64,
    both: f64,
    one: f64,
    listed: i32,
    cws: f64,
    mover: f64,
    yield_: f64,
    parity: i32,
    chunk: i32,
) {
    let band = chunk * 2 + parity;
    let row0 = band * h;
    if row0 >= ch {
        return;
    }
    let row1 = core::cmp::min(ch, row0 + h);
    let listed = if listed > 0 { listed as usize } else { 0 };
    let reach = js_max(1.0, ceil(far_any / cws));
    let reach_i = to_i32(reach);
    let max_r = (far_any - pad) / 2.0;
    let lo = lower_bound(keys, 0, listed, row0 * cw);
    let hi = lower_bound(keys, lo, listed, row1 * cw);
    let o = PairOut { ord, qx, qy, qr, meta, qid, px_out, py_out, ov_out, hit_out, pad, qscale, both, one, mover, yield_ };
    // Where each chunk's entries start, per row the band's units may reach
    // (tab[r * stride + c], c = 0..=cw: c = cw the row's end), from the
    // counts per chunk. On the stack (64 KB); a bigger band (a wide map, a
    // long reach) finds its runs by binary search.
    const TAB_MAX: usize = 16384;
    let trow0 = if row0 - reach_i > 0 { row0 - reach_i } else { 0 };
    let trow1 = if row1 + reach_i < ch { row1 + reach_i } else { ch };
    let tab_rows = (trow1 - trow0) as usize;
    let stride = (cw + 1) as usize;
    let mut tab_buf = core::mem::MaybeUninit::<[i32; TAB_MAX]>::uninit();
    let tab = tab_buf.as_mut_ptr() as *mut i32;
    let use_tab = tab_rows * stride <= TAB_MAX;
    if use_tab {
        let mut pos = lower_bound(keys, 0, lo, trow0 * cw);
        for r in 0..tab_rows {
            let t = tab.add(r * stride);
            let k0 = (trow0 + r as i32) * cw;
            core::ptr::write_bytes(t, 0, stride);
            let mut e = pos;
            while e < listed && rd(keys, e) < k0 + cw {
                *t.add((rd(keys, e) - k0 + 1) as usize) += 1;
                e += 1;
            }
            *t = pos as i32;
            for c in 1..stride {
                *t.add(c) += *t.add(c - 1);
            }
            pos = e;
        }
    }
    // p's chunks in reach (the JS kernel's, or a chunk more: the culls only
    // leave out chunks with nothing in reach, so a superset finds the same
    // pairs): by products with 1 / chunk size, a margin below and above.
    let inv = 1.0 / cws;
    const EPS: f64 = 1e-6;
    // p's row, followed from key to key (no division per entry).
    let mut row_start = i32::MIN;
    let mut next_row = i32::MIN;
    let mut cy = 0i32;
    for p in lo..hi {
        let pm = rd(meta, p);
        // (Only units taking part look.)
        if (pm & 65536) == 0 {
            continue;
        }
        let a = rd(ord, p);
        if a < 0 {
            continue;
        }
        let key = rd(keys, p);
        if key >= next_row || key < row_start {
            cy = idiv(key, cw);
            row_start = cy * cw;
            next_row = row_start + cw;
        }
        let cx = key - row_start;
        let xpf = rd(qx, p);
        let ypf = rd(qy, p);
        let rpf = rd(qr, p);
        let mut st = PairP {
            xp: xpf as f64,
            yp: ypf as f64,
            rp: rpf as f64,
            ip: rd(qid, p),
            op: pm & 255,
            pl: pm & 65280,
            p_part: 1,
            p_moved: (pm & 131072) != 0,
            acc_px: 0.0,
            acc_py: 0.0,
            acc_ov: 0.0,
            acc_hit: 0,
        };
        let v = PairV {
            xp4: f32x4_splat(xpf),
            yp4: f32x4_splat(ypf),
            rp4: f32x4_splat(rpf),
            op4: i32x4_splat(st.op),
            pl4: i32x4_splat(st.pl),
            pi4: i32x4_splat(p as i32),
        };
        let lim = st.rp + max_r + pad;
        // (Columns from, to; rows from, to. NaN positions: none.)
        let fx = f64x2_floor(f64x2_add(f64x2_mul(f64x2(st.xp - lim, st.xp + lim), f64x2_splat(inv)), f64x2(-EPS, EPS)));
        let fy = f64x2_floor(f64x2_add(f64x2_mul(f64x2(st.yp - lim, st.yp + lim), f64x2_splat(inv)), f64x2(-EPS, EPS)));
        let (fl0, fl1) = (f64x2_extract_lane::<0>(fx), f64x2_extract_lane::<1>(fx));
        let (fr0, fr1) = (f64x2_extract_lane::<0>(fy), f64x2_extract_lane::<1>(fy));
        if !(fl0 == fl0 && fl1 == fl1 && fr0 == fr0 && fr1 == fr1) {
            // (As in JS: a unit at a NaN position looks at nothing.)
            continue;
        }
        let clamp = |f: f64, lo_: i32, hi_: i32| -> i32 { if f > lo_ as f64 { if f < hi_ as f64 { f as i32 } else { hi_ } } else { lo_ } };
        let mut c0 = clamp(fl0, cx - reach_i, cx);
        let mut c1 = clamp(fl1, cx, cx + reach_i);
        let mut r0 = clamp(fr0, cy - reach_i, cy);
        let mut r1 = clamp(fr1, cy, cy + reach_i);
        if c0 < 0 {
            c0 = 0;
        }
        if c1 >= cw {
            c1 = cw - 1;
        }
        if r0 < 0 {
            r0 = 0;
        }
        if r1 >= ch {
            r1 = ch - 1;
        }
        let mut ny = r0;
        while ny <= r1 {
            let (s, e) = if use_tab {
                let t = tab.add((ny - trow0) as usize * stride);
                (*t.add(c0 as usize) as usize, *t.add(c1 as usize + 1) as usize)
            } else {
                let s = lower_bound(keys, 0, listed, ny * cw + c0);
                (s, lower_bound(keys, s, listed, ny * cw + c1 + 1))
            };
            pair_run(&o, &mut st, &v, s, e);
            ny += 1;
        }
        if st.acc_hit != 0 {
            let au = a as usize;
            wr(px_out, au, rd(px_out, au) + st.acc_px);
            wr(py_out, au, rd(py_out, au) + st.acc_py);
            if st.acc_ov > rd(ov_out, au) {
                wr(ov_out, au, st.acc_ov);
            }
            wr(hit_out, au, rd(hit_out, au) + st.acc_hit);
        }
    }
}

/// The summed pushes of the slots of a job applied (SIM_KERNEL_SEPARATION_FINISH):
/// spread over this tick and the next, committed here when the unit stays in
/// its tile or crosses into an open one (fast 1/3, or 2: the simulation
/// thread updates its index or path retry), else listed for the swept
/// object commit (fast 0). Slots with nothing to apply (the most) go four
/// at a time.
/// flags: 1 tile a power of two, 2 quantization, 4 push quantization,
/// 8 tile / 4; 16 walls given.
#[no_mangle]
pub unsafe extern "C" fn sep_finish(
    xs: *mut F32,
    ys: *mut F32,
    on: *const u8,
    fl: *const u8,
    id: *const i32,
    dead: *const u8,
    pxs: *mut f64,
    pys: *mut f64,
    ovs: *mut F32,
    hits: *mut u32,
    out_x: *mut F32,
    out_y: *mut F32,
    fast: *mut u8,
    ex: *mut i32,
    exc: *mut i32,
    cxs: *mut F32,
    cys: *mut F32,
    wall: *const u8,
    layer: *const u8,
    smv: *mut u8,
    prx: *const F32,
    pry: *const F32,
    spe: *const i32,
    spo: *const I8I32,
    owno: *const I8I32,
    sepk: *mut u32,
    vsg: *const i32,
    spt: *mut i32,
    area: *mut i32,
    mvo: *mut i32,
    mvn: *mut i32,
    mvw: *mut i8,
    agf: *const i32,
    moves_out: *mut i32,
    pf: *const u8,
    n: i32,
    per: i32,
    tile: f64,
    quant: f64,
    contacts: f64,
    push_q: f64,
    t: i32,
    retry: i32,
    gw: i32,
    gh: i32,
    gain: f64,
    now: f64,
    ix: i32,
    epoch: i32,
    vis_gen: i32,
    vis_all: i32,
    cs: i32,
    cwk: i32,
    absent: u32,
    flags: i32,
    itile: f64,
    iquant: f64,
    ipq: f64,
    iqt: f64,
    chunk: i32,
) {
    let t_p2 = flags & 1 != 0;
    let q_p2 = flags & 2 != 0;
    let pq_p2 = flags & 4 != 0;
    let qt_p2 = flags & 8 != 0;
    let has_wall = flags & 16 != 0;
    let ix = ix != 0;
    let vis_all = vis_all != 0;
    let base = chunk as usize * per as usize;
    let end = core::cmp::min(if n > 0 { n as usize } else { 0 }, base + per as usize);
    let mut ne = 0usize;
    let mut moves = false;
    let retry_hit = |s: usize| -> bool { retry != 0 && irem(t.wrapping_add(rd(id, s)), retry) == 0 };
    let mut i = base;
    while i < end {
        // Four slots with no push found and none carried over: only whether
        // each moved by itself.
        if i + 4 <= end && (i & 3) == 0 {
            let h4 = v128_load(hits.add(i) as *const v128);
            if !v128_any_true(h4) {
                let c0 = f32x4_eq(v128_load(cxs.add(i) as *const v128), f32x4_splat(0.0));
                let c1 = f32x4_eq(v128_load(cys.add(i) as *const v128), f32x4_splat(0.0));
                if i32x4_all_true(v128_and(c0, c1)) {
                    let m0 = v128_or(
                        f32x4_ne(v128_load(xs.add(i) as *const v128), v128_load(prx.add(i) as *const v128)),
                        f32x4_ne(v128_load(ys.add(i) as *const v128), v128_load(pry.add(i) as *const v128)));
                    let mb = i32x4_bitmask(m0) as u32;
                    // (One byte per slot: 1 where it moved.)
                    let bytes = (mb & 1) | (mb & 2) << 7 | (mb & 4) << 14 | (mb & 8) << 21;
                    (smv.add(i) as *mut u32).write_unaligned(bytes);
                    (fast.add(i) as *mut u32).write_unaligned(0x0101_0101);
                    i += 4;
                    continue;
                }
            }
        }
        let x = rd(xs, i);
        let y = rd(ys, i);
        wr(smv, i, if x != rd(prx, i) || y != rd(pry, i) { 1 } else { 0 });
        wr(fast, i, 0);
        let mut dx = rd(cxs, i);
        let mut dy = rd(cys, i);
        if dx != 0.0 || dy != 0.0 {
            wr(cxs, i, 0.0);
            wr(cys, i, 0.0);
        }
        let h = rd(hits, i);
        let is_dead = rd(dead, i) != 0;
        if h != 0 {
            let hf = h as f64;
            let scale = (if hf <= contacts { 1.0 } else { sqrt(contacts / hf) }) * gain;
            let mut px = if pq_p2 { rd(pxs, i) * scale * ipq } else { rd(pxs, i) * scale / push_q };
            let mut py = if pq_p2 { rd(pys, i) * scale * ipq } else { rd(pys, i) * scale / push_q };
            let length = sqrt(px * px + py * py);
            let ov = rd(ovs, i);
            let limit = js_max(0.0, ov);
            wr(pxs, i, 0.0);
            wr(pys, i, 0.0);
            wr(ovs, i, 0.0);
            wr(hits, i, 0);
            if length > limit {
                px *= limit / length;
                py *= limit / length;
            }
            let hx = px * now;
            let hy = py * now;
            dx += hx;
            dy += hy;
            if !is_dead {
                wr(cxs, i, px - hx);
                wr(cys, i, py - hy);
            }
        }
        if (dx == 0.0 && dy == 0.0) || is_dead {
            wr(fast, i, 1);
            i += 1;
            continue;
        }
        wr(out_x, i, dx);
        wr(out_y, i, dy);
        let am = js_max(abs(dx), abs(dy));
        let steps = js_max(1.0, ceil(if qt_p2 { am * iqt } else { am / (tile / 4.0) }));
        let raw_x = if steps == 1.0 { x + dx } else { x + dx * steps / steps };
        let raw_y = if steps == 1.0 { y + dy } else { y + dy * steps / steps };
        let nx = if raw_x.is_finite() {
            if q_p2 { js_round(raw_x * quant) * iquant } else { js_round(raw_x * quant) / quant }
        } else {
            0.0
        };
        let ny = if raw_y.is_finite() {
            if q_p2 { js_round(raw_y * quant) * iquant } else { js_round(raw_y * quant) / quant }
        } else {
            0.0
        };
        let gx = floor(if t_p2 { nx * itile } else { nx / tile });
        let gy = floor(if t_p2 { ny * itile } else { ny / tile });
        let ox = floor(if t_p2 { x * itile } else { x / tile });
        let oy = floor(if t_p2 { y * itile } else { y / tile });
        if gx != ox || gy != oy {
            let mut open = has_wall;
            if open && rd(layer, i) != 1 {
                if abs(gx - ox) > 1.0 || abs(gy - oy) > 1.0 {
                    open = false;
                } else {
                    let x0 = if gx < ox { gx } else { ox };
                    let x1 = if gx < ox { ox } else { gx };
                    let y0 = if gy < oy { gy } else { oy };
                    let y1 = if gy < oy { oy } else { gy };
                    if x0 < 0.0 || y0 < 0.0 || x1 >= gw as f64 || y1 >= gh as f64 {
                        open = false;
                    } else if x0 == x0 && x1 == x1 && y0 == y0 && y1 == y1 {
                        // (A NaN corner reads undefined in JS: 0.)
                        let (ix0, ix1, iy0, iy1) = (x0 as usize, x1 as usize, y0 as usize, y1 as usize);
                        let g = gw as usize;
                        if (rd(wall, iy0 * g + ix0) | rd(wall, iy0 * g + ix1) | rd(wall, iy1 * g + ix0) | rd(wall, iy1 * g + ix1)) != 0 {
                            open = false;
                        }
                    }
                }
            }
            if open {
                wr(xs, i, nx);
                wr(ys, i, ny);
                wr(fast, i, 2);
                if ix
                    && rd(spe, i) == epoch
                    && rd(spo, i) == rd(owno, i)
                    && rd(sepk, i) != absent
                    && (vis_all || rd(vsg, i) == vis_gen)
                {
                    let cgx = if gx < 0.0 { 0 } else if gx >= gw as f64 { gw - 1 } else { gx as i32 };
                    let cgy = if gy < 0.0 { 0 } else if gy >= gh as f64 { gh - 1 } else { gy as i32 };
                    let tl = cgy * gw + cgx;
                    if tl != rd(spt, i) {
                        let key = if cs == 1 { tl } else { idiv(cgy, cs) * cwk + idiv(cgx, cs) } as u32;
                        let old = rd(sepk, i);
                        if old != key {
                            if rd(mvw, i) == 0 {
                                wr(mvo, i, old as i32);
                            }
                            wr(mvn, i, key as i32);
                            wr(mvw, i, (rd(spo, i).wrapping_add(1)) as i8);
                            wr(sepk, i, key);
                            moves = true;
                        }
                        let a = rd(agf, tl as usize);
                        wr(area, i, if a >= 0 { a } else { -1 });
                        wr(spt, i, tl);
                    }
                    if !(h != 0 && retry_hit(i) && (pf.is_null() || rd(pf, i) != 0)) {
                        wr(fast, i, 3);
                        i += 1;
                        continue;
                    }
                }
            }
            wr(ex, base + ne, i as i32);
            ne += 1;
            i += 1;
            continue;
        }
        wr(xs, i, nx);
        wr(ys, i, ny);
        // (On a retry tick: listed for its fallback path (mvPF), or for an
        // index entry that is not current, put right by the simulation
        // thread for a listed unit.)
        let mut f = 1u8;
        if h != 0 && retry_hit(i) && !(rd(on, i) != 0 && (rd(fl, i) & 4) == 0) {
            if pf.is_null() || rd(pf, i) != 0 {
                f = 2;
            } else {
                let cgx = if !(gx >= 0.0) { 0 } else if gx >= gw as f64 { gw - 1 } else { gx as i32 };
                let cgy = if !(gy >= 0.0) { 0 } else if gy >= gh as f64 { gh - 1 } else { gy as i32 };
                if !(ix && rd(spe, i) == epoch && rd(spo, i) == rd(owno, i) && rd(sepk, i) != absent && rd(spt, i) == cgy * gw + cgx) {
                    f = 2;
                }
            }
        }
        wr(fast, i, f);
        if f == 2 {
            wr(ex, base + ne, i as i32);
            ne += 1;
        }
        i += 1;
    }
    wr(exc, chunk as usize, ne as i32);
    if moves && !moves_out.is_null() {
        wr(moves_out, 0, 1);
    }
}

// =====================================================================
// FLOW NAVIGATION: A DESTINATION'S FIELD (SIM_KERNEL_NAV_FIELDS)
// =====================================================================

const NAV_UNREACHED: u16 = 0xFFFF;

/// One destination field: the costs to reach `dest` from every tile of the
/// box (bx, by, bw x bh) into pool[off..off + bw * bh] (stepping onto a tile
/// costs its step cost, 1 without costs; walls never entered: a Dial queue
/// of four buckets), then (make_row) its row over the exit graph: 255 no
/// way, 254 the field covers the part, else the part's node to leave by.
/// `work`: this thread's scratch (words). Returns 0 when it does not fit.
#[no_mangle]
pub unsafe extern "C" fn nav_field(
    pool: *mut u16, off: i32, slot_size: i32, bx: i32, by: i32, bw: i32, bh: i32, w: i32, h: i32, dest: i32,
    wall: *const u8, cost: *const u8,
    make_row: i32, nb: *const i32, nt: *const i32, npair: *const i32, npart: *const i32,
    adj_s: *const i32, adj_a: *const i32, adj_c: *const i32, part_l: *const u16, part_b: *const i32,
    csz: i32, cw: i32, nc: i32, np: i32, bcount: i32, k: i32, edges: i32,
    rows: *mut u8, ro: i32, work: *mut i32, work_words: i32,
) -> i32 {
    // (The scratch's first four words: a kernel's tag and state, see k.rs
    // scratch(): cleared, as this overwrites what follows.)
    if work.is_null() || work_words < 4 {
        return 0;
    }
    *work = 0;
    let work = work.add(4);
    let work_words = work_words - 4;
    let (bwu, bhu) = (bw.max(0) as usize, bh.max(0) as usize);
    let n = bwu * bhu;
    let out = pool.add(off.max(0) as usize);
    // (The whole slot: a made slot is written whole.)
    for i in 0..(slot_size.max(0) as usize).max(n) {
        *out.add(i) = NAV_UNREACHED;
    }
    let ww = work_words.max(0) as usize;
    // ---- the field: Dial, four buckets of tile indices ----
    let tx = irem(dest, w);
    let ty = idiv(dest, w);
    let (lx0, ly0) = (tx - bx, ty - by);
    if lx0 >= 0 && ly0 >= 0 && lx0 < bw && ly0 < bh {
        let qcap = n * 3;
        if 4 + 4 * qcap > ww {
            return 0;
        }
        // (Bucket b's count at work[b], its tiles from work[4 + b * qcap].)
        let qn = work;
        let qs = work.add(4);
        for b in 0..4 {
            *qn.add(b) = 0;
        }
        let l0 = (ly0 * bw + lx0) as usize;
        *out.add(l0) = 0;
        *qs = l0 as i32;
        *qn = 1;
        let mut pending = 1usize;
        let mut d: u32 = 0;
        while pending > 0 {
            let b = (d & 3) as usize;
            let qb = qs.add(b * qcap);
            let mut i = 0usize;
            while i < *qn.add(b) as usize {
                let l = *qb.add(i) as usize;
                i += 1;
                pending -= 1;
                if *out.add(l) as u32 != d {
                    continue;
                }
                let ly = idiv(l as i32, bw);
                let lx = l as i32 - ly * bw;
                let (x, y) = (bx + lx, by + ly);
                let t = (y * w + x) as usize;
                let nd = d + if cost.is_null() { 1 } else { *cost.add(t) as u32 };
                if nd > 0xFFFE {
                    continue;
                }
                let nbk = (nd & 3) as usize;
                let ndv = nd as u16;
                let nq = qs.add(nbk * qcap);
                let nc_ = qn.add(nbk);
                macro_rules! push {
                    ($l:expr) => {{ *out.add($l) = ndv; *nq.add(*nc_ as usize) = $l as i32; *nc_ += 1; pending += 1; }};
                }
                if lx + 1 < bw && x + 1 < w && *wall.add(t + 1) == 0 && ndv < *out.add(l + 1) { push!(l + 1); }
                if lx > 0 && *wall.add(t - 1) == 0 && ndv < *out.add(l - 1) { push!(l - 1); }
                if ly + 1 < bh && y + 1 < h && *wall.add(t + w as usize) == 0 && ndv < *out.add(l + bwu) { push!(l + bwu); }
                if ly > 0 && *wall.add(t - w as usize) == 0 && ndv < *out.add(l - bwu) { push!(l - bwu); }
            }
            *qn.add(b) = 0;
            d += 1;
        }
    }
    if make_row == 0 || rows.is_null() || np <= 0 {
        return 1;
    }
    // ---- the row: seeds (exits inside the field reaching the destination,
    // by distance then node), then the search over the exit graph ----
    let npu = np as usize;
    let row = rows.add(ro.max(0) as usize);
    for i in 0..npu {
        *row.add(i) = 255;
    }
    if nb.is_null() || npart.is_null() || adj_s.is_null() || part_l.is_null() {
        return 1;
    }
    let pl = *part_l.add(dest as usize);
    if pl != 0xFFFF {
        let dc = idiv(ty, csz) * cw + idiv(tx, csz);
        *row.add((*part_b.add(dc as usize) + pl as i32) as usize) = 254;
    }
    let ku = k.max(0) as usize;
    if 2 * ku > ww {
        return 0;
    }
    let seed_n = work;
    let seed_d = work.add(ku);
    let mut ns = 0usize;
    let (cx0, cy0, cx1, cy1) = (idiv(bx, csz), idiv(by, csz), idiv(bx + bw - 1, csz), idiv(by + bh - 1, csz));
    for cy in cy0..=cy1 {
        for cx in cx0..=cx1 {
            let c = (cy * cw + cx) as usize;
            for i in *nb.add(c)..*nb.add(c + 1) {
                let t = *nt.add(i as usize);
                let nty = idiv(t, w);
                let ntx = t - nty * w;
                let v = *out.add(((nty - by) * bw + (ntx - bx)) as usize);
                if v == NAV_UNREACHED {
                    continue;
                }
                *row.add(*npart.add(i as usize) as usize) = 254;
                let v = v as i32;
                // (Sorted by distance, then node: an insertion.)
                let mut j = ns;
                ns += 1;
                while j > 0 && (*seed_d.add(j - 1) > v || (*seed_d.add(j - 1) == v && *seed_n.add(j - 1) > i)) {
                    *seed_d.add(j) = *seed_d.add(j - 1);
                    *seed_n.add(j) = *seed_n.add(j - 1);
                    j -= 1;
                }
                *seed_d.add(j) = v;
                *seed_n.add(j) = i;
            }
        }
    }
    nav_row(nb, npair, npart, adj_s, adj_a, adj_c, nc, k, np, bcount, edges, seed_n, seed_d, ns as i32, row,
        work.add(2 * ku), (ww - 2 * ku) as i32)
}

/// Rows copied from their key's slot (the batch's other slots of a key):
/// list[i]'s row from src[i]'s, for i in i0..i1 with src[i] >= 0.
#[no_mangle]
pub unsafe extern "C" fn nav_rows_copy(rows: *mut u8, list: *const i32, src: *const i32, row_w: i32, i0: i32, i1: i32) {
    let rw = row_w.max(0) as usize;
    for i in i0.max(0) as usize..i1.max(0) as usize {
        let from = *src.add(i);
        if from >= 0 {
            core::ptr::copy(rows.add(from as usize * rw), rows.add(*list.add(i) as usize * rw), rw);
        }
    }
}

// =====================================================================
// FLOW NAVIGATION: A DESTINATION'S ROW
// =====================================================================

/// A destination field's row (flownav.js _navFieldRow, after its seeds):
/// one Dijkstra with a bucket queue (Dial: small integer costs) over the
/// exit graph from the seeds (nodes inside the field that reach the
/// destination, at their distances there, sorted by distance then node,
/// let in as the search's distance gets there), then each part's cheapest
/// node to leave by (crossing to its pair; the first such node on a tie).
/// `row` (np bytes) comes with 255 (no way) and 254 (the field covers the
/// part) set; the rest is written here. Work arrays in `work` (this
/// thread's scratch): returns 0 when they do not fit (the JS search then).
unsafe fn nav_row(
    nb: *const i32,
    npair: *const i32,
    npart: *const i32,
    adj_s: *const i32,
    adj_a: *const i32,
    adj_c: *const i32,
    nc: i32,
    k: i32,
    np: i32,
    bcount: i32,
    edges: i32,
    seed_n: *const i32,
    seed_d: *const i32,
    ns: i32,
    row: *mut u8,
    work: *mut i32,
    work_words: i32,
) -> i32 {
    let k = if k > 0 { k as usize } else { 0 };
    let np = if np > 0 { np as usize } else { 0 };
    let b = if bcount > 0 { bcount as usize } else { 1 };
    let ns = if ns > 0 { ns as usize } else { 0 };
    let cap = (if edges > 0 { edges as usize } else { 0 }) + k + 16;
    if k + b + 2 * cap + np > (if work_words > 0 { work_words as usize } else { 0 }) {
        return 0;
    }
    const INF: i32 = 0x3fffffff;
    let dist = work;
    let head = dist.add(k);
    let val = head.add(b);
    let nxt = val.add(cap);
    let best = nxt.add(cap);
    for i in 0..k {
        wr(dist, i, INF);
    }
    for i in 0..b {
        wr(head, i, -1);
    }
    for s in 0..ns {
        wr(dist, rd(seed_n, s) as usize, rd(seed_d, s));
    }
    let bi = b as i32;
    let mut pool0 = 0usize;
    let mut count = 0i64;
    let mut si = 0usize;
    let mut cur = 0i32;
    while count > 0 || si < ns {
        // (Nothing queued: on to the next seed's distance.)
        if count == 0 && rd(seed_d, si) > cur {
            cur = rd(seed_d, si);
        }
        while si < ns && rd(seed_d, si) == cur {
            let i = rd(seed_n, si);
            si += 1;
            // (Reached cheaper through another seed: queued already.)
            if rd(dist, i as usize) == cur {
                let bk0 = irem(cur, bi) as usize;
                wr(val, pool0, i);
                wr(nxt, pool0, rd(head, bk0));
                wr(head, bk0, pool0 as i32);
                pool0 += 1;
                count += 1;
            }
        }
        let bk = irem(cur, bi) as usize;
        // (Zero-cost edges add to the bucket being emptied: again.)
        while rd(head, bk) != -1 {
            let mut e = rd(head, bk);
            wr(head, bk, -1);
            while e != -1 {
                let eu = e as usize;
                let u = rd(val, eu);
                let en = rd(nxt, eu);
                count -= 1;
                if rd(dist, u as usize) == cur {
                    let x1 = rd(adj_s, u as usize + 1) as usize;
                    let mut x = rd(adj_s, u as usize) as usize;
                    while x < x1 {
                        let v = rd(adj_a, x) as usize;
                        let nd = cur + rd(adj_c, x);
                        if nd < rd(dist, v) {
                            wr(dist, v, nd);
                            let nbk = irem(nd, bi) as usize;
                            wr(val, pool0, v as i32);
                            wr(nxt, pool0, rd(head, nbk));
                            wr(head, nbk, pool0 as i32);
                            pool0 += 1;
                            count += 1;
                        }
                        x += 1;
                    }
                }
                e = en;
            }
        }
        cur += 1;
    }
    for q in 0..np {
        wr(best, q, INF);
    }
    for c in 0..(if nc > 0 { nc as usize } else { 0 }) {
        let i0 = rd(nb, c);
        let i1 = rd(nb, c + 1);
        let mut i = i0;
        while i < i1 {
            let q = rd(npart, i as usize) as usize;
            if rd(row, q) != 254 {
                // Leaving through node i: cross to its pair (the pair's distance).
                let j = rd(npair, i as usize);
                let di = if j >= 0 { rd(dist, j as usize) } else { INF };
                if di < rd(best, q) {
                    wr(best, q, di);
                    wr(row, q, (i - i0) as u8);
                }
            }
            i += 1;
        }
    }
    1
}

// =====================================================================
// ACQUISITION SCAN
// =====================================================================

/// The summed-area count of block rows by0..by1, columns bx0..bx1 of plane o.
#[inline(always)]
unsafe fn sat_sum(t: *const i32, o: usize, stride: usize, bx0: usize, by0: usize, bx1: usize, by1: usize) -> i32 {
    rd(t, o + (by1 + 1) * stride + bx1 + 1)
        .wrapping_sub(rd(t, o + by0 * stride + bx1 + 1))
        .wrapping_sub(rd(t, o + (by1 + 1) * stride + bx0))
        .wrapping_add(rd(t, o + by0 * stride + bx0))
}

/// The structure a look of player `owner` at (x, y), range r takes
/// (sim_parallel.js _simAcqStructure): of the classes the first with one,
/// of it the nearest by its tile's centre within the range, lowest tile on
/// a tie; hostile and in sight. Tiles holding no structure (the most) are
/// skipped sixteen at a time.
#[inline(always)]
unsafe fn acq_structure(
    scls: *const i8,
    sown: *const i8,
    hss: *const i32,
    ag: *const i32,
    covf: *const u8,
    covf_len: usize,
    cbase: i32,
    owner: i32,
    x: f64,
    y: f64,
    r: f64,
    tile: f64,
    gw: i32,
    gh: i32,
    b: i32,
    bc: i32,
    br: i32,
    stride: i32,
    plane: i32,
) -> i32 {
    let reach = ceil(r / tile) + 1.0;
    let ugx = floor(x / tile);
    let ugy = floor(y / tile);
    let x0 = js_max(0.0, ugx - reach);
    let x1 = js_min((gw - 1) as f64, ugx + reach);
    let y0 = js_max(0.0, ugy - reach);
    let y1 = js_min((gh - 1) as f64, ugy + reach);
    if !(x0 <= x1) || !(y0 <= y1) {
        return -1;
    }
    let (x0, x1, y0, y1) = (x0 as i32, x1 as i32, y0 as i32, y1 as i32);
    if !hss.is_null() {
        let bx0 = idiv(x0, b);
        let by0 = idiv(y0, b);
        let bx1 = core::cmp::min(bc - 1, idiv(x1, b));
        let by1 = core::cmp::min(br - 1, idiv(y1, b));
        if bx0 <= bx1 && by0 <= by1 && sat_sum(hss, (owner * plane) as usize, stride as usize, bx0 as usize, by0 as usize, bx1 as usize, by1 as usize) <= 0 {
            return -1;
        }
    }
    let r2 = r * r;
    let half = tile / 2.0;
    let mut best_c = 5i32;
    let mut best_d = f64::INFINITY;
    let mut best = -1i32;
    let zero = i8x16_splat(0);
    let mut gy = y0;
    while gy <= y1 {
        let dy = gy as f64 * tile + half - y;
        let row = (gy * gw) as usize;
        // Sixteen tiles at a time: only those with a structure class (> 0),
        // in order (lanes past the row's end masked off; the array has room).
        let mut gx = x0;
        while gx <= x1 {
            let t = row + gx as usize;
            let c16 = v128_load(scls.add(t) as *const v128);
            let mut bits = i8x16_bitmask(i8x16_gt(c16, zero)) as u32;
            let rem = x1 - gx + 1;
            if rem < 16 {
                bits &= (1u32 << rem) - 1;
            }
            while bits != 0 {
                let l = bits.trailing_zeros() as i32;
                bits &= bits - 1;
                acq_structure_tile(sown, ag, covf, covf_len, cbase, owner, x, dy, r2, tile, half, (gx + l) as usize + row, gx + l, rd(scls, t + l as usize), &mut best_c, &mut best_d, &mut best);
            }
            gx += 16;
        }
        gy += 1;
    }
    best
}

#[inline(always)]
unsafe fn acq_structure_tile(
    sown: *const i8,
    ag: *const i32,
    covf: *const u8,
    covf_len: usize,
    cbase: i32,
    owner: i32,
    x: f64,
    dy: f64,
    r2: f64,
    tile: f64,
    half: f64,
    t: usize,
    gx: i32,
    cl0: i8,
    best_c: &mut i32,
    best_d: &mut f64,
    best: &mut i32,
) {
    let cls = if cl0 == 5 { 1 } else { cl0 as i32 };
    if cls <= 0 || cls > *best_c {
        return;
    }
    let code = rd(sown, t) as i32;
    if code == -1 || code == owner {
        return;
    }
    let dx = gx as f64 * tile + half - x;
    let d2 = dx * dx + dy * dy;
    if !(d2 < r2) || (cls == *best_c && d2 >= *best_d) {
        return;
    }
    let a = rd(ag, t);
    if !(a >= 0) || !cover(covf, covf_len, cbase + a) {
        return;
    }
    *best_c = cls;
    *best_d = d2;
    *best = t as i32;
}

/// The owners per chunk transposed (omt[tx * ch + ty] = om[ty * cw + tx]),
/// rows y0..y1 (SIM_KERNEL_ACQ_OMT): eight columns at a time, so each
/// column's run of rows is written as one span per row block.
#[no_mangle]
pub unsafe extern "C" fn acq_omt(om: *const u8, omt: *mut u8, cw: i32, ch: i32, y0: i32, y1: i32) {
    let (cw, ch) = (cw as usize, ch as usize);
    let (y0, y1) = (y0 as usize, y1 as usize);
    let mut x = 0usize;
    while x < cw {
        let x1 = core::cmp::min(cw, x + 8);
        for y in y0..y1 {
            let row = om.add(y * cw);
            for xx in x..x1 {
                wr(omt, xx * ch + y, rd(row, xx));
            }
        }
        x = x1;
    }
}

/// The index's entries e0..e1 packed in its order for the ring search
/// (SIM_KERNEL_ACQ_OMT): position, owner, id, and the area its player looks
/// up, -1 when the scan passes the entry over (empty, dead, off the map, no
/// area: the scan's own tests, made once per entry).
#[no_mangle]
pub unsafe extern "C" fn acq_pack(
    es: *const i32,
    xs: *const F32,
    ys: *const F32,
    own: *const I8I32,
    flg: *const u8,
    id: *const i32,
    ag: *const i32,
    ex: *mut F32,
    ey: *mut F32,
    eo: *mut i32,
    ea: *mut i32,
    eid: *mut i32,
    e0: i32,
    e1: i32,
    tile: f64,
    gw: i32,
    gh: i32,
) {
    for e in (e0 as usize)..(e1 as usize) {
        let q = rd(es, e);
        if q < 0 || (rd(flg, q as usize) & 1) != 0 {
            wr(ea, e, -1);
            wr(eo, e, 0);
            wr(ex, e, 0.0);
            wr(ey, e, 0.0);
            wr(eid, e, 0);
            continue;
        }
        let qu = q as usize;
        let qx = rd(xs, qu);
        let qy = rd(ys, qu);
        wr(ex, e, qx);
        wr(ey, e, qy);
        wr(eo, e, rd(own, qu));
        wr(eid, e, rd(id, qu));
        let qgx = floor(qx / tile);
        let qgy = floor(qy / tile);
        let a = if qgx < 0.0 || qgy < 0.0 || qgx >= gw as f64 || qgy >= gh as f64 || qgx != qgx || qgy != qgy {
            -1
        } else {
            rd(ag, (qgy as i32 * gw + qgx as i32) as usize)
        };
        wr(ea, e, if a >= 0 { a } else { -1 });
    }
}

/// What the ring search reads.
struct AcqCtx {
    rst: *const i32,
    rs: *const i32,
    rc: *const i32,
    es: *const i32,
    flg: *const u8,
    own: *const I8I32,
    xs: *const F32,
    ys: *const F32,
    ag: *const i32,
    covf: *const u8,
    covf_len: usize,
    id: *const i32,
    ep: i32,
    owner: i32,
    cbase: i32,
    tile: f64,
    gw: i32,
    gh: i32,
    x: f64,
    y: f64,
    // (The entries packed by acq_pack, or null.)
    ex: *const F32,
    ey: *const F32,
    eo: *const i32,
    ea: *const i32,
    eid: *const i32,
}

/// The packed entries e0..e1 against the best so far (b2 its squared
/// distance): four at a time (f32), within the best distance, another
/// owner's, in an area; then the cover and the tie, one by one.
#[inline(always)]
unsafe fn acq_run(c: &AcqCtx, e0: usize, e1: usize, best: &mut i32, b2: &mut f32, best_id: &mut i32) {
    let (ex, ey) = (c.ex as *const f32, c.ey as *const f32);
    let (xf, yf) = (c.x as f32, c.y as f32);
    let (ox, oy, ow, zero) = (f32x4_splat(xf), f32x4_splat(yf), i32x4_splat(c.owner), i32x4_splat(0));
    let mut take = |e: usize, d2: f32, b2: &mut f32| {
        let a = *c.ea.add(e);
        if !cover(c.covf, c.covf_len, c.cbase + a) || d2 > *b2 {
            return;
        }
        let qid = *c.eid.add(e);
        if *best < 0 || d2 < *b2 || qid < *best_id {
            *best = *c.es.add(e);
            *b2 = d2;
            *best_id = qid;
        }
    };
    let mut e = e0;
    while e + 4 <= e1 {
        let dx = f32x4_sub(v128_load(ex.add(e) as *const v128), ox);
        let dy = f32x4_sub(v128_load(ey.add(e) as *const v128), oy);
        let d2 = f32x4_add(f32x4_mul(dx, dx), f32x4_mul(dy, dy));
        let m = v128_and(
            v128_and(f32x4_le(d2, f32x4_splat(*b2)), v128_not(i32x4_eq(v128_load(c.eo.add(e) as *const v128), ow))),
            i32x4_ge(v128_load(c.ea.add(e) as *const v128), zero),
        );
        let mut bits = i32x4_bitmask(m);
        if bits != 0 {
            let mut d = [0f32; 4];
            v128_store(d.as_mut_ptr() as *mut v128, d2);
            while bits != 0 {
                let l = bits.trailing_zeros() as usize;
                bits &= bits - 1;
                take(e + l, *d.as_ptr().add(l), b2);
            }
        }
        e += 4;
    }
    while e < e1 {
        if *c.ea.add(e) >= 0 && *c.eo.add(e) != c.owner {
            let dx = *ex.add(e) - xf;
            let dy = *ey.add(e) - yf;
            take(e, dx * dx + dy * dy, b2);
        }
        e += 1;
    }
}

/// A row of chunks for the row search: the chunks of row ty within the
/// best distance of the unit (gap: the row's distance from it), from the
/// first to the last with an enemy owner in it, one run of entries (the
/// index lists them by chunk, row-major).
#[inline(always)]
unsafe fn acq_row(c: &AcqCtx, om: *const u8, foe: u8, cw: i32, cws: f32, ty: i32, gap: f32, xf: f32, best: &mut i32, b2: &mut f32, best_id: &mut i32) {
    let xr = sqrt32((*b2 - gap * gap).max(0.0)) + 0.01;
    let x0 = (floor32((xf - xr) / cws) as i32).max(0);
    let x1 = (floor32((xf + xr) / cws) as i32).min(cw - 1);
    if x0 > x1 {
        return;
    }
    let row = (ty * cw) as usize;
    let (foe16, zero16) = (u8x16_splat(foe), u8x16_splat(0));
    let (mut first, mut last) = (usize::MAX, 0usize);
    let mut tx = x0;
    while tx <= x1 {
        let k = row + tx as usize;
        let mut bits = i8x16_bitmask(i8x16_ne(v128_and(v128_load(om.add(k) as *const v128), foe16), zero16)) as u32;
        let rem = x1 - tx + 1;
        if rem < 16 {
            bits &= (1u32 << rem) - 1;
        }
        while bits != 0 {
            let kk = k + bits.trailing_zeros() as usize;
            bits &= bits - 1;
            if *c.rst.add(kk) == c.ep {
                if first == usize::MAX {
                    first = kk;
                }
                last = kk;
            }
        }
        tx += 16;
    }
    if first == usize::MAX {
        return;
    }
    let e0 = *c.rs.add(first) as usize;
    let e1 = (*c.rs.add(last) + *c.rc.add(last)) as usize;
    acq_run(c, e0, e1, best, b2, best_id);
}

#[inline(always)]
fn floor32(x: f32) -> f32 {
    f32x4_extract_lane::<0>(f32x4_floor(f32x4_splat(x)))
}
#[inline(always)]
fn sqrt32(x: f32) -> f32 {
    f32x4_extract_lane::<0>(f32x4_sqrt(f32x4_splat(x)))
}

/// The enemies listed in chunk k (stamped this epoch) against the best so
/// far: nearer, or as near with a lower id (best_id: the best's).
#[inline(always)]
unsafe fn acq_chunk(c: &AcqCtx, k: usize, best: &mut i32, bd2: &mut f64, best_id: &mut i32) {
    if rd(c.rst, k) != c.ep {
        return;
    }
    let e0 = rd(c.rs, k) as usize;
    let e1 = e0 + rd(c.rc, k) as usize;
    if !c.ea.is_null() {
        let mut b2 = *bd2 as f32;
        acq_run(c, e0, e1, best, &mut b2, best_id);
        *bd2 = b2 as f64;
        return;
    }
    for e in e0..e1 {
        let q = rd(c.es, e);
        if q < 0 {
            continue;
        }
        let qu = q as usize;
        if (rd(c.flg, qu) & 1) != 0 || rd(c.own, qu) == c.owner {
            continue;
        }
        let qx = rd(c.xs, qu);
        let qy = rd(c.ys, qu);
        let qgx = floor(qx / c.tile);
        let qgy = floor(qy / c.tile);
        if qgx < 0.0 || qgy < 0.0 || qgx >= c.gw as f64 || qgy >= c.gh as f64 || qgx != qgx || qgy != qgy {
            continue;
        }
        let a = rd(c.ag, (qgy as i32 * c.gw + qgx as i32) as usize);
        if !(a >= 0) || !cover(c.covf, c.covf_len, c.cbase + a) {
            continue;
        }
        let dx = qx - c.x;
        let dy = qy - c.y;
        let d2 = dx * dx + dy * dy;
        if d2 > *bd2 {
            continue;
        }
        let qid = rd(c.id, qu);
        if *best < 0 || d2 < *bd2 || qid < *best_id {
            *best = q;
            *bd2 = d2;
            *best_id = qid;
        }
    }
}

/// COVF[i] > 0, undefined (past the array) false.
#[inline(always)]
unsafe fn cover(covf: *const u8, len: usize, i: i32) -> bool {
    i >= 0 && (i as usize) < len && rd(covf, i as usize) > 0
}

/// The acquisition tier's scan (SIM_KERNEL_ACQ_SCAN): for each idle,
/// attack-moving or attacking unit of the snapshot the nearest enemy unit
/// within its aggro range whose area its player sees (nearest, then lowest
/// id), and for the first two the structure its look would take.
#[no_mangle]
pub unsafe extern "C" fn acq_scan(
    scls: *const i8,
    sown: *const i8,
    hss: *const i32,
    sout: *mut i32,
    xs: *const F32,
    ys: *const F32,
    own: *const I8I32,
    flg: *const u8,
    cmds: *const U8I32,
    rng: *const F32,
    id: *const i32,
    outa: *mut i32,
    tid: *mut i32,
    ag: *const i32,
    covf: *const u8,
    hs: *const i32,
    rs: *const i32,
    rc: *const i32,
    rst: *const i32,
    es: *const i32,
    om: *const u8,
    omt: *const u8,
    ex: *const F32,
    ey: *const F32,
    eo: *const i32,
    ea: *const i32,
    eid: *const i32,
    n: i32,
    per: i32,
    cw: i32,
    ch: i32,
    tile: f64,
    ep: i32,
    players: i32,
    cmd_idle: i32,
    cmd_am: i32,
    b: i32,
    bc: i32,
    br: i32,
    cs: i32,
    gw: i32,
    gh: i32,
    cmd_atk: i32,
    a_count: i32,
    covf_len: i32,
    by_entry: i32,
    entries: i32,
    chunk: i32,
) {
    let cws = tile * cs as f64;
    let stride = bc + 1;
    let plane = stride * (br + 1);
    let covf_len = if covf_len > 0 { covf_len as usize } else { 0 };
    // (by_entry: the units in the index's order, as the JS kernel: each
    // looks around where the one before did, in the caches.)
    let total = if by_entry != 0 { entries } else { n };
    let start = chunk as usize * per as usize;
    let end = core::cmp::min(if total > 0 { total as usize } else { 0 }, start + per as usize);
    for i in start..end {
        let s = if by_entry != 0 { rd(es, i) } else { i as i32 };
        if s < 0 {
            continue;
        }
        let s = s as usize;
        let fl = rd(flg, s);
        if fl & 7 != 0 {
            continue;
        }
        let cmd = rd(cmds, s);
        // (Flag 16: a moving shooter, looked for too: the combat brain's
        // fire on the move.)
        if cmd != cmd_idle && cmd != cmd_am && cmd != cmd_atk && (fl & 16) == 0 {
            continue;
        }
        let owner = rd(own, s);
        let r = rd(rng, s);
        if !(owner >= 0 && owner < players) || !(r > 0.0) {
            continue;
        }
        let cbase = owner * a_count;
        let foe: u8 = if owner < 8 { 0xFF ^ (1u8 << owner) } else { 0xFF };
        wr(outa, s, -1);
        wr(tid, s, 0);
        wr(sout, s, -1);
        let x = rd(xs, s);
        let y = rd(ys, s);
        let cx = floor(x / cws);
        let cy = floor(y / cws);
        if cmd == cmd_idle || cmd == cmd_am {
            wr(sout, s, acq_structure(scls, sown, hss, ag, covf, covf_len, cbase, owner, x, y, r, tile, gw, gh, b, bc, br, stride, plane));
        }
        let rt = ceil(r / cws) + 1.0;
        // Nothing hostile in the blocks around: none.
        {
            let x0 = js_max(0.0, cx - rt) * cs as f64;
            let y0 = js_max(0.0, cy - rt) * cs as f64;
            let x1 = js_min((cw - 1) as f64, cx + rt) * cs as f64;
            let y1 = js_min((ch - 1) as f64, cy + rt) * cs as f64;
            let bx0 = floor(x0 / b as f64);
            let by0 = floor(y0 / b as f64);
            let bx1 = js_min((bc - 1) as f64, floor(x1 / b as f64));
            let by1 = js_min((br - 1) as f64, floor(y1 / b as f64));
            if bx0 <= bx1 && by0 <= by1 {
                let (o, st) = ((owner * plane) as usize, stride as usize);
                let all = sat_sum(hs, o, st, bx0 as usize, by0 as usize, bx1 as usize, by1 as usize);
                // (No enemy units: the hostile count less the structures'.)
                if all <= 0 || (!hss.is_null() && all - sat_sum(hss, o, st, bx0 as usize, by0 as usize, bx1 as usize, by1 as usize) <= 0) {
                    continue;
                }
            }
        }
        let mut best = -1i32;
        let mut best_id = 0i32;
        let mut bd2 = r * r;
        let rti = to_i32(rt);
        let (cxi, cyi) = (to_i32(cx), to_i32(cy));
        // The JS kernel's rings, the same chunks and the same stops (the
        // result is the nearest, then lowest id, of what was looked at: the
        // order within a ring does not change it). A chunk is looked at only
        // with an enemy owner in it (ix.omask, a byte: current wherever the
        // chunk is stamped, so tested first); the ring's top and bottom rows
        // sixteen chunks at a time.
        let c = AcqCtx { rst, rs, rc, es, flg, own, xs, ys, ag, covf, covf_len, id, ep, owner, cbase, tile, gw, gh, x, y, ex, ey, eo, ea, eid };
        // The row search (with the packed entries): the unit's row, then the
        // rows above and below in turn, each direction until a row lies
        // farther than the best; each row within the best distance only.
        if !ea.is_null() {
            let mut b2 = bd2 as f32;
            let cwsf = cws as f32;
            let (xf, yf) = (x as f32, y as f32);
            if cyi >= 0 && cyi < ch {
                acq_row(&c, om, foe, cw, cwsf, cyi, 0.0, xf, &mut best, &mut b2, &mut best_id);
            }
            let (mut up, mut dn, mut k) = (true, true, 1i32);
            while up || dn {
                if up {
                    let ty = cyi - k;
                    let gap = (yf - (ty + 1) as f32 * cwsf - 0.01).max(0.0);
                    if ty < 0 || gap * gap > b2 {
                        up = false;
                    } else if ty < ch {
                        acq_row(&c, om, foe, cw, cwsf, ty, gap, xf, &mut best, &mut b2, &mut best_id);
                    }
                }
                if dn {
                    let ty = cyi + k;
                    let gap = (ty as f32 * cwsf - yf - 0.01).max(0.0);
                    if ty >= ch || gap * gap > b2 {
                        dn = false;
                    } else if ty >= 0 {
                        acq_row(&c, om, foe, cw, cwsf, ty, gap, xf, &mut best, &mut b2, &mut best_id);
                    }
                }
                k += 1;
            }
            wr(outa, s, best);
            wr(tid, s, if best >= 0 { rd(id, best as usize) } else { 0 });
            continue;
        }
        let foe16 = u8x16_splat(foe);
        let zero16 = u8x16_splat(0);
        let mut ring = 0i32;
        while ring <= rti {
            // (Every chunk of this ring is at least the distance from the unit
            // to the ring's inner edge away: none nearer than the best.)
            if ring > 0 {
                let gx = (x - (cxi - ring + 1) as f64 * cws).min((cxi + ring) as f64 * cws - x);
                let gy = (y - (cyi - ring + 1) as f64 * cws).min((cyi + ring) as f64 * cws - y);
                let lb = gx.min(gy) - 0.01;
                if lb > 0.0 && lb * lb > bd2 {
                    break;
                }
            }
            let (ty0, ty1) = (cyi - ring, cyi + ring);
            let (t0, t1) = (if cxi - ring > 0 { cxi - ring } else { 0 }, if cxi + ring < cw { cxi + ring } else { cw - 1 });
            for (side, ty) in [ty0, ty1].into_iter().enumerate() {
                if (side == 1 && ring == 0) || ty < 0 || ty >= ch || t0 > t1 {
                    continue;
                }
                let row = (ty * cw) as usize;
                let mut tx = t0;
                while tx <= t1 {
                    let k = row + tx as usize;
                    let v = v128_load(om.add(k) as *const v128);
                    let mut bits = i8x16_bitmask(i8x16_ne(v128_and(v, foe16), zero16)) as u32;
                    let rem = t1 - tx + 1;
                    if rem < 16 {
                        bits &= (1u32 << rem) - 1;
                    }
                    while bits != 0 {
                        let l = bits.trailing_zeros() as usize;
                        bits &= bits - 1;
                        acq_chunk(&c, k + l, &mut best, &mut bd2, &mut best_id);
                    }
                    tx += 16;
                }
            }
            // The rows between: the ring's left and right chunks (with the
            // transposed owners, sixteen rows at a time).
            if ring > 0 && !omt.is_null() {
                let ya = if ty0 + 1 > 0 { ty0 + 1 } else { 0 };
                let yb = if ty1 - 1 < ch - 1 { ty1 - 1 } else { ch - 1 };
                for xs_ in [cxi - ring, cxi + ring] {
                    if xs_ < 0 || xs_ >= cw || ya > yb {
                        continue;
                    }
                    let col = (xs_ * ch) as usize;
                    let mut ty = ya;
                    while ty <= yb {
                        let v = v128_load(omt.add(col + ty as usize) as *const v128);
                        let mut bits = i8x16_bitmask(i8x16_ne(v128_and(v, foe16), zero16)) as u32;
                        let rem = yb - ty + 1;
                        if rem < 16 {
                            bits &= (1u32 << rem) - 1;
                        }
                        while bits != 0 {
                            let l = bits.trailing_zeros() as i32;
                            bits &= bits - 1;
                            acq_chunk(&c, ((ty + l) * cw + xs_) as usize, &mut best, &mut bd2, &mut best_id);
                        }
                        ty += 16;
                    }
                }
            } else if ring > 0 {
                let ya = if ty0 + 1 > 0 { ty0 + 1 } else { 0 };
                let yb = if ty1 - 1 < ch - 1 { ty1 - 1 } else { ch - 1 };
                let (xl, xr) = (cxi - ring, cxi + ring);
                let mut ty = ya;
                while ty <= yb {
                    let row = ty * cw;
                    if xl >= 0 && xl < cw {
                        let k = (row + xl) as usize;
                        if (rd(om, k) & foe) != 0 {
                            acq_chunk(&c, k, &mut best, &mut bd2, &mut best_id);
                        }
                    }
                    if xr >= 0 && xr < cw {
                        let k = (row + xr) as usize;
                        if (rd(om, k) & foe) != 0 {
                            acq_chunk(&c, k, &mut best, &mut bd2, &mut best_id);
                        }
                    }
                    ty += 1;
                }
            }
            ring += 1;
        }
        wr(outa, s, best);
        wr(tid, s, if best >= 0 { rd(id, best as usize) } else { 0 });
    }
}

// =====================================================================
// STATE HASH (utils_snapshot.js snapTickHash, SIM_KERNEL_SNAP_REGION with
// the slice's sums): per job, its slots (live, not dead): the region of
// each, and for the slice's ones the hash of its column fields (snap.hc),
// listed per job without atomics: (region, sum) pairs, the rotation group's
// slots, slots outside the regions; then the units list's order sum over
// the job's positions and its units without a slot. The caller merges the
// jobs' lists. Same values as the JavaScript kernel.
// =====================================================================
#[inline(always)]
fn imul(a: i32, b: i32) -> i32 { a.wrapping_mul(b) }
#[inline(always)]
fn mix_i(h: i32, kc: i32, x: i32) -> i32 { h.wrapping_add(imul(imul(kc ^ x, 16777619), 2654435761u32 as i32)) }
#[inline(always)]
fn mix_f(h: i32, kc: i32, x: f64) -> i32 {
    let v;
    if x >= -2147483648.0 && x < 2147483648.0 && (x as i32) as f64 == x && !(x == 0.0 && x.is_sign_negative()) {
        v = imul(kc ^ (x as i32), 16777619);
    } else if x != x {
        v = kc ^ 0x7ff8;
    } else {
        let b = x.to_bits();
        v = imul(imul(kc ^ (b as u32 as i32), 16777619) ^ ((b >> 32) as u32 as i32), 0x5bd1e995);
    }
    h.wrapping_add(imul(v, 2654435761u32 as i32))
}
#[inline(always)]
fn order_mix(i: i32, id: i32) -> i32 {
    let mut h = imul(i.wrapping_add(1), 2654435761u32 as i32) ^ imul(id.wrapping_add(0x3c6ef372), 2246822519u32 as i32);
    h = imul(h ^ ((h as u32) >> 15) as i32, 3266489917u32 as i32);
    h ^ ((h as u32) >> 13) as i32
}
#[no_mangle]
pub unsafe extern "C" fn snap_region(
    live: *const u8, dead: *const u8, xs: *const F32, ys: *const F32, id: *const i32, sl: *const i32, kc: *const i32,
    own: *const I8I32, vx: *const F32, vy: *const F32, en: *const F32, cmd: *const U8I32, at: *const F32, af: *const U8I32,
    st: *const *const i32,
    reg: *mut i32, hc: *mut i32, pr: *mut i32, ph: *mut i32, rl: *mut i32, nl: *mut i32, nu: *mut i32, cc: *mut i32, ords: *mut i32,
    n_units: i32, _n_slots: i32, per: i32, ts: f64, slices: i32, slice: i32, rot: i32, groups: i32, rmax: i32, chunk: i32,
) {
    // The slice: the units list's positions slice, slice + slices, ... (a
    // tenth of the units a tick, each once in SNAP_HASH_SLICES ticks), the
    // job's run of them; per unit its region, its column hash, its region
    // sum entry (or the rotation group's list, or outside the regions), and
    // the list's order sum.
    let base = chunk as usize * per as usize;
    let (mut n0, mut n1, mut n2, mut n3) = (0usize, 0usize, 0usize, 0usize);
    let k = |i: usize| rd(kc, i);
    let sl_n = slices.max(1) as usize;
    let mut ord: i32 = 0;
    let mut j = base;
    let j_end = base + per as usize;
    loop {
        let ii = slice.max(0) as usize + j * sl_n;
        if j >= j_end || ii >= n_units.max(0) as usize {
            break;
        }
        j += 1;
        let si = rd(sl, ii);
        if si < 0 {
            wr(nu, base + n3, ii as i32);
            n3 += 1;
            continue;
        }
        let si = si as usize;
        ord = ord.wrapping_add(order_mix(ii as i32, rd(id, si)));
        if rd(live, si) == 0 || rd(dead, si) != 0 {
            continue;
        }
        let r = floor(rd(ys, si) / ts) * 1024.0 + floor(rd(xs, si) / ts);
        let mut h = mix_i(0, k(0), rd(own, si));
        h = mix_f(h, k(1), rd(xs, si));
        h = mix_f(h, k(2), rd(ys, si));
        h = mix_f(h, k(3), rd(vx, si));
        h = mix_f(h, k(4), rd(vy, si));
        h = mix_f(h, k(5), rd(en, si));
        h = mix_i(h, k(6), rd(cmd, si));
        h = mix_i(h, k(7), rd(dead, si) as i32);
        h = mix_f(h, k(8), rd(at, si));
        h = mix_i(h, k(9), rd(af, si));
        let mut c = 0usize;
        while c < 8 {
            h = mix_i(h, k(10 + c), rd(*st.add(c), si));
            c += 1;
        }
        wr(hc, si, h);
        let ri = to_i32(r);
        wr(reg, si, ri);
        if !(r >= 0.0 && r < rmax as f64) {
            wr(nl, base + n2, -(si as i32 + 1));
            n2 += 1;
            continue;
        }
        let uid = rd(id, si);
        if irem(irem(uid, groups) + groups, groups) == rot {
            wr(rl, base + n1, si as i32);
            n1 += 1;
            continue;
        }
        let mut hh = (imul(uid, 7919) ^ 0x11).wrapping_add(h);
        hh = imul(hh ^ ((hh as u32) >> 15) as i32, 2246822519u32 as i32);
        wr(pr, base + n0, ri);
        wr(ph, base + n0, hh);
        n0 += 1;
    }
    wr(ords, chunk as usize, ord);
    let cb = chunk as usize * 4;
    wr(cc, cb, n0 as i32);
    wr(cc, cb + 1, n1 as i32);
    wr(cc, cb + 2, n2 as i32);
    wr(cc, cb + 3, n3 as i32);
}

