//! The info panel's numbers (src/audio_visual/info_pack_worker.js): a
//! selection's structures binned straight from the presentation structure
//! table in the heap (sim_presentation.js _simStructTableNew), off the page
//! and off the simulation's threads. Read only; nothing of the match depends
//! on it.
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

/// Fields of a bin (f64 each), as info_pack_worker.js reads them.
pub const INFO_BIN_FIELDS: usize = 21;
// (The flag bits of the table, sim_frame_world.js SIM_SF_*.)
const SF_UC: i32 = 1;
const SF_UPGRADING: i32 = 2;
const SF_SALVAGE: i32 = 4;
const SF_STACKING: i32 = 8;
const SF_AUTO_UPGRADE: i32 = 1024;
const SF_BUILD: i32 = 2048;
const SF_QUEUE: i32 = 4096;
const SF_AUTO_RESEARCH: i32 = 8192;
const SF_RALLY: i32 = 32768;
const SF_AUTO_STACK: i32 = 131072;
const SF_RESEARCHING: i32 = 262144;

/// k_info_bins. Arrays: the table's columns [0] alive (u8), [1] serial,
/// [2] flags (i32), [3] owner, [4] level, [5] elevel, [6] qlen (i16), [7]
/// energy, [8] amount, [9] amountMax, [10] rallyX, [11] rallyY (f32); the
/// selection [12] slots, [13] their serials, [14] their groups (i32); [15]
/// the bin table (i32 triples: the key's two words and the bin, P[1]
/// entries, a power of two; cleared here), [16] its bin index per entry (i32), [17] the bins (f64,
/// INFO_BIN_FIELDS each, at most P[2]), [18] out: [0] bins, [1] members
/// gone (dead or another structure in the slot), [2] members past the bins.
/// P: [0] members, [1] table entries, [2] bins room, [3] the table's slots,
/// [4] the tile size.
///
/// A bin: [0] group, [1] owner, [2] level, [3] elevel (raw columns, -1 for
/// none), [4] state (0 ready, 1 building, 2 upgrading, 3 stacking), [5] its
/// first member's slot, [6] members, [7] energy, [8] queued, [9] members
/// with a queue, [10] marked for salvage, [11] auto upgrade, [12] auto
/// stack, [13] queue on, [14] build on, [15] auto research, [16]
/// researching, [17] amount, [18] amount max, [19] / [20] the smallest /
/// largest rally tile key (gx * 65536 + gy; -1 none; 1e18 / -1 when empty).
#[no_mangle]
pub unsafe extern "C" fn k_info_bins(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let alive = k.p::<u8>(0);
    let serial = k.p::<i32>(1);
    let flags = k.p::<i32>(2);
    let owner = k.p::<i16>(3);
    let level = k.p::<i16>(4);
    let elevel = k.p::<i16>(5);
    let qlen = k.p::<i16>(6);
    let energy = k.p::<f32>(7);
    let amount = k.p::<f32>(8);
    let amount_max = k.p::<f32>(9);
    let rx = k.p::<f32>(10);
    let ry = k.p::<f32>(11);
    let slots = k.p::<i32>(12);
    let sers = k.p::<i32>(13);
    let groups = k.p::<i32>(14);
    let table = k.p::<i32>(15);
    let bin_of = k.p::<i32>(16);
    let bins = k.p::<f64>(17);
    let out = k.p::<i32>(18);
    let n = k.i(0).max(0) as usize;
    let cap = k.i(1).max(2) as usize;
    let room = k.i(2).max(0) as usize;
    let tcap = k.i(3).max(0) as usize;
    let tile = k.f(4).max(1.0) as f32;
    let mask = cap - 1;
    for i in 0..cap * 3 {
        s(table, i, -1);
    }
    let (mut nb, mut gone, mut past) = (0usize, 0i32, 0i32);
    for i in 0..n {
        let sl = g(slots, i);
        if sl < 0 || sl as usize >= tcap || g(alive, sl as usize) != 1 || g(serial, sl as usize) != g(sers, i) {
            gone += 1;
            s(bin_of, i, -1);
            continue;
        }
        let si = sl as usize;
        let fl = g(flags, si);
        let state = if fl & SF_UC != 0 { 1 } else if fl & SF_UPGRADING != 0 { 2 } else if fl & SF_STACKING != 0 { 3 } else { 0 };
        let o = g(owner, si) as i32;
        let lv = (g(level, si) as i32).clamp(-1, 254);
        let el = (g(elevel, si) as i32).clamp(-1, 254);
        let grp = g(groups, i);
        let k2 = (((o + 1) & 15) << 20) | ((lv + 1) << 11) | ((el + 1) << 2) | state;
        let mut h = ((grp as u32).wrapping_mul(0x9E37_79B1) ^ (k2 as u32).wrapping_mul(0x85EB_CA6B)) as usize & mask;
        let mut b: isize = -1;
        loop {
            let t0 = g(table, h * 3);
            if t0 == -1 {
                if nb >= room || nb * 2 >= cap {
                    break;
                }
                s(table, h * 3, grp);
                s(table, h * 3 + 1, k2);
                s(table, h * 3 + 2, nb as i32);
                b = nb as isize;
                let f = bins.add(nb * INFO_BIN_FIELDS);
                for j in 0..INFO_BIN_FIELDS {
                    s(f, j, 0.0);
                }
                s(f, 0, grp as f64);
                s(f, 1, o as f64);
                s(f, 2, lv as f64);
                s(f, 3, el as f64);
                s(f, 4, state as f64);
                s(f, 5, sl as f64);
                s(f, 19, 1e18);
                s(f, 20, -1.0);
                nb += 1;
                break;
            }
            if t0 == grp && g(table, h * 3 + 1) == k2 {
                b = g(table, h * 3 + 2) as isize;
                break;
            }
            h = (h + 1) & mask;
        }
        if b == -1 {
            past += 1;
            s(bin_of, i, -1);
            continue;
        }
        let bi = b as usize;
        s(bin_of, i, bi as i32);
        let f = bins.add(bi * INFO_BIN_FIELDS);
        let q = (g(qlen, si) as i32).max(0);
        *f.add(6) += 1.0;
        *f.add(7) += g(energy, si) as f64;
        *f.add(8) += q as f64;
        if q > 0 { *f.add(9) += 1.0; }
        if fl & SF_SALVAGE != 0 { *f.add(10) += 1.0; }
        if fl & SF_AUTO_UPGRADE != 0 { *f.add(11) += 1.0; }
        if fl & SF_AUTO_STACK != 0 { *f.add(12) += 1.0; }
        if fl & SF_QUEUE != 0 { *f.add(13) += 1.0; }
        if fl & SF_BUILD != 0 { *f.add(14) += 1.0; }
        if fl & SF_AUTO_RESEARCH != 0 { *f.add(15) += 1.0; }
        if fl & SF_RESEARCHING != 0 { *f.add(16) += 1.0; }
        *f.add(17) += g(amount, si) as f64;
        *f.add(18) += g(amount_max, si) as f64;
        let rk = if fl & SF_RALLY != 0 {
            // (World positions are not negative: truncation is floor.)
            let tx = (g(rx, si) / tile).max(0.0) as i64;
            let ty = (g(ry, si) / tile).max(0.0) as i64;
            (tx * 65536 + ty) as f64
        } else {
            -1.0
        };
        if rk < *f.add(19) { *f.add(19) = rk; }
        if rk > *f.add(20) { *f.add(20) = rk; }
    }
    s(out, 0, nb as i32);
    s(out, 1, gone);
    s(out, 2, past);
}
