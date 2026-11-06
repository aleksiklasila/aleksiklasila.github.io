//! Buildings' sight in the visibility cover (renderer.js _visCoverUnitsPost):
//! seeded from the per-tile structure table with the units' seeds (k.rs
//! k_vis_seed), the same spread after.
use super::*;
use super::k::K;

#[inline(always)]
unsafe fn g<T: Copy>(p: *const T, i: usize) -> T {
    *p.add(i)
}
// (An entry of the structures' steps table raised to v: jobs of a quarter
// meet in an area, the most wins whatever their order.)
#[inline(always)]
unsafe fn sst_max(sst: *mut i32, i: usize, v: i32) {
    let c = &*(sst.add(i) as *const core::sync::atomic::AtomicI32);
    if c.load(core::sync::atomic::Ordering::Relaxed) < v { c.fetch_max(v, core::sync::atomic::Ordering::Relaxed); }
}

/// SIM_KERNEL_VIS_SEED_SST, a job a player (the cover chain's first stage,
/// renderer.js _visCoverUnitsPost): the structures' steps table's half P[3]
/// (vis.sst, per player and area, -1 none; made a quarter of the map a tick)
/// into the run's seeds: vis.useed[player * A + area] = stamp << 6 | steps,
/// the area listed (vis.ulist from player * A, vis.ucnt[player]). First in
/// the chain, so no seed of this stamp is there yet: plain writes. Four
/// areas a step (i32x4, a sign test: most areas hold no building).
/// Arrays: vis.sst, vis.useed, vis.ulist, vis.ucnt. P: [0] areas, [1]
/// players, [2] stamp, [3] half.
#[no_mangle]
pub unsafe extern "C" fn k_vis_seed_sst(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (sst, seed, list, cnt) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3));
    let (na, np, stamp, half) = (k.i(0).max(0) as usize, k.i(1).max(0), k.i(2), k.i(3).max(0) as usize);
    if chunk < 0 || chunk >= np { return; }
    let p = chunk as usize;
    let (src, base) = (sst.add(half * np as usize * na + p * na) as *const i32, p * na);
    let mut n = g(cnt, p) as usize;
    let mut a = 0usize;
    while a + 4 <= na {
        let mut m = !(i32x4_bitmask(v128_load(src.add(a) as *const v128)) as u32) & 15;
        while m != 0 {
            let i = a + m.trailing_zeros() as usize;
            *seed.add(base + i) = (stamp << 6) | g(src, i); *list.add(base + n) = i as i32; n += 1;
            m &= m - 1;
        }
        a += 4;
    }
    while a < na { let v = g(src, a); if v >= 0 { *seed.add(base + a) = (stamp << 6) | v; *list.add(base + n) = a as i32; n += 1; } a += 1; }
    *cnt.add(p) = n as i32;
}

#[inline(always)]
fn job(chunk: i32, per: i32, n: i32) -> (usize, usize) {
    let a = (chunk.max(0) as i64 * per.max(0) as i64).min(n.max(0) as i64) as usize;
    let b = (a as i64 + per.max(0) as i64).min(n.max(0) as i64) as usize;
    (a, b)
}

/// SIM_KERNEL_VIS_SEED_STRUCTS (P[1] 256-tile blocks a job, blocks P[11] ..
/// P[0]: a quarter of the map a tick, renderer.js _visCoverStructQuarter):
/// every built structure with energy (st.code, not a mine; st.uc 0, st.val >
/// 0) marks its tile's area (a building's +-0.3 tile window at its tile's
/// centre is its tile) in the structures' steps table (vis.sst, per player
/// and area the most steps, -1 none; the half P[12] of two) for its owner
/// (st.own) and a watching team (its row's watched >
/// 0, watchedByTeam, not its owner) with its vision steps: its custom
/// vision's (_ovVs) or the static tables' (ord.rs k_adj_apply's vis_at: the
/// vision and attack range at its effective level, from the stationary
/// descriptor, boosted, by its owner's research). Arrays: st.code, st.own,
/// st.uc, st.val, st.brain, st.stab, st.rrow, vt.agrid, vis.sst, -, -, adj.ctab, adj.tykey, adj.rlv, adj.bl, stt.vis,
/// stt.atk. P: [0] blocks, [1] per job, [2] tiles, [3] areas, [4] players,
/// [5] stamp, [6] keys, [7] levels + 1, [8] research levels + 1, [9]
/// stationary types, [10] MAX_THING_LEVEL, [11] first block, [12] half.
#[no_mangle]
pub unsafe extern "C" fn k_vis_seed_structs(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (code, own, uc, val, brain, stab, rrow, ag) = (k.p::<u8>(0), k.p::<i32>(1), k.p::<u8>(2), k.p::<f64>(3), k.p::<i32>(4), k.p::<u8>(5),
        k.p::<i32>(6), k.p::<i32>(7));
    let (sst, tab) = (k.p::<i32>(8), k.p::<i32>(11) as *const i32);
    let (tykey, rlv, bl, svis, satk) = (k.p::<i32>(12), k.p::<i32>(13), k.p::<i32>(14), k.p::<i32>(15), k.p::<i32>(16));
    let (n, na, np, stamp, nk, l1, r1, ntypes, maxl) = (k.i(2).max(0) as usize, k.i(3), k.i(4), k.i(5), k.i(6), k.i(7).max(1) as usize,
        k.i(8).max(1) as usize, k.i(9), k.i(10).max(1));
    let first = k.i(11).max(0);
    let (b0, b1) = job(chunk, k.i(1), k.i(0) - first);
    let (b0, b1) = (b0 + first as usize, b1 + first as usize);
    let half = (k.i(12).max(0) as usize) * (np.max(0) * na.max(0)) as usize;
    for b in b0..b1 {
        for t in b * 256..((b + 1) * 256).min(n) {
            let cd = g(code, t);
            if cd == 0 || cd >= 0x66 || g(uc, t) != 0 || !(g(val, t) > 0.0) { continue; }
            let ar = g(ag, t);
            if ar < 0 || ar >= na { continue; }
            let c = g(stab, t) as usize;
            let r = g(rrow, t);
            if c == 0 || c > 9 || r < 0 { continue; }
            let (c, r) = (c - 1, r as usize);
            let o = g(own, t);
            let p1 = if o >= 0 && o < np { o } else { -1 };
            let mut p2 = -1;
            let wp = super::ord::col::<i32>(tab, c, 25);
            if !wp.is_null() {
                let wt = g(wp, r);
                if wt != i32::MIN && wt > 0 { let tm = g(super::ord::col::<i8>(tab, c, 26), r) as i32; if tm >= 0 && tm < np && tm != p1 { p2 = tm; } }
            }
            if p1 < 0 && p2 < 0 { continue; }
            // Its steps: a custom vision's, else the tables'.
            let ov = g(super::ord::col::<i8>(tab, c, 23), r) as i32;
            let steps = if ov != -128 { ov } else {
                let ty = (g(brain, t) & 65535) - 1;
                let kb = if ty >= 0 && ty < ntypes { g(tykey, ty as usize) } else { -1 };
                if kb < 0 || kb >= nk { -1 } else {
                    let oi = if o < 0 || o + 1 >= np + 1 { 0 } else { o + 1 };
                    let otx = (oi * nk + kb) as usize;
                    let el = ((g(brain, t) >> 26) & 63).max(1);
                    let blv = g(bl, otx);
                    let lv = (if blv > 0 { (el + blv).min(maxl) } else { el.min(maxl) }) as usize;
                    let base = (kb as usize * l1 + lv) * r1;
                    g(svis, base + g(rlv, 4 * otx + 1) as usize).max(g(satk, base + g(rlv, 4 * otx + 2) as usize))
                }
            };
            if steps < 0 { continue; }
            let v = steps.min(63);
            if p1 >= 0 { sst_max(sst, half + (p1 * na + ar) as usize, v); }
            if p2 >= 0 { sst_max(sst, half + (p2 * na + ar) as usize, v); }
        }
    }
}
