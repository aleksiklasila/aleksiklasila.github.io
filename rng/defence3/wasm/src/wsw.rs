//! The work site grid (worker.js _wsw): per tile the owned structure's work
//! flags for the workers' searches (build, salvage, queue, research, auto
//! research), its owner, area and reservation bits, the per-block and
//! per-owner counts; made from the structure tables for a list of tiles (the
//! journal's, the marked ones, the sweep's share), what _wswSet did one
//! structure at a time.
use super::*;
use super::k::K;
use super::ord::col;

#[inline(always)]
unsafe fn g<T: Copy>(p: *const T, i: usize) -> T {
    *p.add(i)
}
#[inline(always)]
unsafe fn s<T>(p: *mut T, i: usize, v: T) {
    *p.add(i) = v;
}
// (ord.rs's: a count's level, floor(log2) + 1 in [1, max].)
fn stack_level(x: f64, max: i32) -> i32 {
    let v = if x == x && x != 0.0 { x } else { 1.0 };
    let v = if v < 1.0 { 1.0 } else { floor(v) };
    let lg = if v == f64::INFINITY { 1024 } else { ((v.to_bits() >> 52) & 0x7ff) as i32 - 1023 };
    (lg + 1).min(max).max(1)
}
const WSW_BUILD: u8 = 1;
const WSW_SALVAGE: u8 = 2;
const WSW_QUEUE: u8 = 4;
const WSW_RESEARCH: u8 = 8;
const WSW_AUTORES: u8 = 16;
const WSW_NBITS: usize = 5;
// (Per class, wsw.ctab: markedForSalvage, buildEnabled, queueEnabled
// (flags), _qN (Int8), _qReq, _qPaid (Float64), autoResearchEnabled (flag).)
const WSW_COLS: usize = 7;
#[inline(always)]
unsafe fn wcol<T>(tab: *const i32, c: usize, j: usize) -> *mut T {
    waddr(*tab.add(c * WSW_COLS + j) as u32) as *mut T
}

/// The reservation bits of tile t: per worker type slot (the first 8) held by
/// a unit alive (by id in the id table: main.js UnitIdIndex, its slot's id
/// and dead columns).
unsafe fn resv_bits(t: usize, resv: *const i32, nt: usize, uidt: *const i32, umask: u32, uid: *const i32, udead: *const u8) -> u8 {
    let mut rv = 0u8;
    if resv.is_null() {
        return 0;
    }
    for i in 0..nt.min(8) {
        let id = g(resv, t * nt + i);
        if id <= 0 || uidt.is_null() {
            continue;
        }
        let mut h = (id as u32).wrapping_mul(2654435761u32) & umask;
        loop {
            let sl = g(uidt, h as usize);
            if sl == -1 { break; }
            if g(uid, sl as usize) == id {
                if g(udead, sl as usize) == 0 { rv |= 1 << i; }
                break;
            }
            h = (h + 1) & umask;
        }
    }
    rv
}

/// k_wsw_set. Arrays: [0] tiles (P[0]), st.* [1] stab, [2] rrow, [3] uc,
/// [4] brain; [5] adj.ctab, [6] wsw.ctab; static tables [7] adj.tykey, [8]
/// adj.rml, [9] stt.mxe, [10] adj.rlv; the grid [11] flags, [12] own, [13]
/// area, [14] resv, [15] cnt (8 a block of 8x8 tiles), [16] oc (8 an owner,
/// P[9] owners); [17] cell.area; [18] wk.resv; the id table [19] (P[11]
/// entries), [20] unit.id, [21] unit.dead.
/// P: [0] tiles, [1] GRID_W, [2] MAX_THING_LEVEL, [3] types known, [4] keys,
/// [5] owner rows, [6] levels + 1, [7] research rows, [8] blocks a row, [9]
/// owners counted (WSW_MAXOWN), [10] reservation slots a tile, [11] id table
/// entries, [12] mode (0 flags, area and reservations; 1 reservations only),
/// [13] the research building's stationary type + 1 (0 none).
#[no_mangle]
pub unsafe extern "C" fn k_wsw_set(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let tl = k.p::<i32>(0);
    let (stab, rrow, stuc, brain) = (k.p::<u8>(1), k.p::<i32>(2), k.p::<u8>(3), k.p::<i32>(4));
    let (tab, wtab) = (k.p::<i32>(5) as *const i32, k.p::<i32>(6) as *const i32);
    let (tykey, rml, smxe, rlv) = (k.p::<i32>(7), k.p::<i32>(8), k.p::<f64>(9), k.p::<i32>(10));
    let (wfl, wown, warea, wresv, wcnt, woc) = (k.p::<u8>(11), k.p::<i8>(12), k.p::<i32>(13), k.p::<u8>(14), k.p::<i32>(15), k.p::<i32>(16));
    let carea = k.p::<i32>(17);
    let resv = k.p::<i32>(18);
    let (uidt, uid, udead) = (k.p::<i32>(19), k.p::<i32>(20), k.p::<u8>(21));
    let n = k.i(0).max(0) as usize;
    let (gw, maxl, ntypes, nkeys, np, l1, r1) = (k.i(1).max(1), k.i(2).max(1), k.i(3), k.i(4), k.i(5), k.i(6).max(1) as usize, k.i(7).max(1) as usize);
    let (bw, nown, nt) = (k.i(8).max(1), k.i(9), k.i(10).max(0) as usize);
    let umask = (k.i(11).max(1) as u32) - 1;
    let mode = k.i(12);
    let rtype = k.i(13);
    for i in 0..n {
        let t = g(tl, i);
        if t < 0 { continue; }
        let tu = t as usize;
        if mode == 1 {
            s(wresv, tu, resv_bits(tu, resv, nt, uidt, umask, uid, udead));
            continue;
        }
        // The owned structure standing there (_ownedStructureAtTile): its row's tile is t, its owner set.
        let c = g(stab, tu) as usize;
        let row = g(rrow, tu);
        let mut f = 0u8;
        let mut o = -1i32;
        let mut have = false;
        if c >= 1 && c <= 9 && row >= 0 {
            let c = c - 1;
            let r = row as usize;
            let cgx = col::<i16>(tab, c, 0);
            if !cgx.is_null() && g(cgx, r) as i32 == irem(t, gw) && g(col::<i16>(tab, c, 1), r) as i32 == idiv(t, gw) {
                let ow = g(col::<i8>(tab, c, 15), r) as i32;
                if ow != -128 {
                    have = true;
                    o = ow;
                    f = flags_of(tab, wtab, c, r, tu, stuc, brain, tykey, rml, smxe, rlv, maxl, ntypes, nkeys, np, l1, r1, rtype, o);
                }
            }
        }
        let (f0, o0) = (g(wfl, tu), g(wown, tu) as i32);
        if f == 0 && f0 == 0 && o == o0 {
            continue;
        }
        if f0 != f || o0 != o {
            let gx = irem(t, gw);
            let b = ((idiv(t, gw) >> 3) * bw + (gx >> 3)) as usize * 8;
            for bit in 0..WSW_NBITS {
                let m = 1u8 << bit;
                if f0 & m != 0 {
                    s(wcnt, b + bit, g(wcnt, b + bit) - 1);
                    if o0 >= 0 && o0 < nown { s(woc, o0 as usize * 8 + bit, g(woc, o0 as usize * 8 + bit) - 1); }
                }
                if f & m != 0 {
                    s(wcnt, b + bit, g(wcnt, b + bit) + 1);
                    if o >= 0 && o < nown { s(woc, o as usize * 8 + bit, g(woc, o as usize * 8 + bit) + 1); }
                }
            }
            s(wfl, tu, f);
            s(wown, tu, o as i8);
        }
        let ar = g(carea, tu);
        s(warea, tu, if f != 0 && have { if ar >= 0 { ar } else { -1 } } else { -1 });
        if f != 0 {
            s(wresv, tu, resv_bits(tu, resv, nt, uidt, umask, uid, udead));
        }
    }
}

/// _wswFlagsOf for the structure in row r of class c at tile t, owner o.
#[inline(never)]
unsafe fn flags_of(tab: *const i32, wtab: *const i32, c: usize, r: usize, tu: usize, stuc: *const u8, brain: *const i32, tykey: *const i32, rml: *const i32,
    smxe: *const f64, rlv: *const i32, maxl: i32, ntypes: i32, nkeys: i32, np: i32, l1: usize, r1: usize, rtype: i32, o: i32) -> u8 {
    let flag = |p: *mut u8| -> u8 { if p.is_null() { 0 } else { g(p, r) } };
    let marked = flag(wcol::<u8>(wtab, c, 0)) == 2;
    let uc = g(stuc, tu) != 0;
    let upg = flag(col::<u8>(tab, c, 11)) == 2;
    let stk = flag(col::<u8>(tab, c, 8)) == 2;
    let energy = g(col::<f64>(tab, c, 16), r);
    let (st0, man0) = (g(col::<i32>(tab, c, 2), r), g(col::<i32>(tab, c, 3), r));
    let (lv, elv) = (g(col::<i8>(tab, c, 5), r), g(col::<i8>(tab, c, 6), r));
    // getThingStackedStacks, getThingManualStacks, getThingBaseLevel / EffectiveLevel.
    let stacked = if st0 == i32::MIN || st0 < 1 { 1 } else { st0 };
    let manual = stacked.max(if man0 == i32::MIN { stacked } else { man0 }.max(1));
    let base = if lv != -128 { (lv as i32).min(maxl).max(1) } else if st0 != i32::MIN { stack_level(if st0 == 0 { 1.0 } else { st0 as f64 }, maxl) } else { 1 };
    let eff = if elv != -128 { (elv as i32).min(maxl).max(1) } else { base };
    // (The tables' owner row and building key, as k_adj_apply's.)
    let ty = (g(brain, tu) & 65535) - 1;
    let oi = if o < 0 || o + 1 >= np { 0 } else { o + 1 };
    let kb = if ty >= 0 && ty < ntypes { g(tykey, ty as usize) } else { -1 };
    let typed = kb >= 0 && kb < nkeys;
    let otx = if typed { (oi * nkeys + kb) as usize } else { 0 };
    let rmax = if typed { g(rml, otx) } else { maxl };
    let mut f = 0u8;
    if marked {
        f |= WSW_SALVAGE;
    } else if uc {
        if flag(wcol::<u8>(wtab, c, 1)) != 1 { f |= WSW_BUILD; }
    } else if upg || stk {
        f |= WSW_BUILD;
    } else {
        // The maxEnergy getter: its override, an upgrade's target, the base tables' (an object override's).
        let mxo = g(col::<f64>(tab, c, 21), r);
        let maxe = if mxo == mxo { mxo } else {
            let um = g(col::<f64>(tab, c, 20), r);
            let ovmx = g(col::<f64>(tab, c, 22), r);
            if upg && um > 0.0 { floor(um).max(1.0) }
            else if ovmx == ovmx { floor(ovmx).max(1.0) }
            else if typed { g(smxe, ((kb as usize * l1) + base.max(1).min(maxl) as usize) * r1 + g(rlv, 4 * otx) as usize) }
            else { f64::NAN }
        };
        if energy > 0.0 && energy < maxe {
            f |= WSW_BUILD;
        } else if flag(col::<u8>(tab, c, 14)) != 1 && manual - stacked > 0 && stack_level((stacked + 1) as f64, maxl) <= rmax {
            // _isBuilderStackCandidate.
            f |= WSW_BUILD;
        } else if flag(col::<u8>(tab, c, 10)) != 1 && !(elv != -128 && lv != -128 && elv <= lv) {
            // _isBuilderUpgradeCandidate.
            if eff > base && eff.min(rmax) > base { f |= WSW_BUILD; }
        }
    }
    // _isHealerQueueTarget: queued, alive, built, its queue on, its front not paid.
    let qn = { let p = wcol::<i8>(wtab, c, 3); if p.is_null() { 0 } else { g(p, r) as i32 } };
    if qn > 0 && energy > 0.0 && !uc && flag(wcol::<u8>(wtab, c, 2)) != 1 {
        let (req, paid) = (g(wcol::<f64>(wtab, c, 4), r), g(wcol::<f64>(wtab, c, 5), r));
        if paid < req { f |= WSW_QUEUE; }
    }
    if rtype > 0 && ty + 1 == rtype && !marked && energy > 0.0 && !uc {
        f |= WSW_RESEARCH;
        if flag(wcol::<u8>(wtab, c, 6)) != 1 { f |= WSW_AUTORES; }
    }
    f
}
