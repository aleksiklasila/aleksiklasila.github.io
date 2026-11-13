//! The hits' looks (presentation only) as SoA records: the attacks, damage
//! flashes, alerts and sounds the page shows for a step's hits, made from
//! the hit kernels' look lists and the unit columns (no unit objects, no
//! JavaScript per hit). unit.js simHitLooks: the worker sends the records
//! to the page as one buffer, the page replays them (simHitLooksReplay).
//!
//! Record i: kind (0 a unit's attack on a unit, 1 a shot's hit on a unit,
//! 2 a unit's attack on a structure), the attacker's id (0 none), the
//! target's id (kind 2: its tile), both positions (eighths of a pixel), the
//! damage (f32), the attacker's (shooter's) owner, its style code (unit.js
//! _hitStyleCode: 1-4 elements, 5 a scout's swoop) and type (spatial type
//! index: Object.keys(BASE_UNIT_STATS) order). Columns of their own,
//! narrow, so the page's replay and any filter (in view, owner) read them
//! as vectors.
use super::*;
use super::k::K;

const K_UNIT: u8 = 0;
const K_SHOT: u8 = 1;
const K_STRUCT: u8 = 2;

/// Arrays: [0] plist, [1] hit attackers (slots), [2] hit targets (slots),
/// [3] pj.uev, [4] pj.arg, [5] pj.dmg (f64), [6] pj.own (i8), [7] x, [8] y,
/// [9] id, [10] owner (i8), [11] atkSty (u8), [12] spType (i16), [13]
/// statRow (i16), [14] eff.hot (f32), [15] the structure hits' looks
/// (slot, tile, damage * 1024 triples), [16..27) the record columns (kind
/// u8, aid, tid, ax, ay, tx, ty i32, dmg f32, own i8, sty u8, typ u8), [27]
/// the header ([0] records).
/// P: [0] listed looks in view, [1] out of view, [2] the list's out-of-view
/// offset, [3] queued hits before the shots (entries), [4] shots, [5]
/// EFF_HOT_WIDTH, [6] structure looks, [7] the columns' capacity, [8] grid
/// width, [9] tile (pixels).
#[no_mangle]
pub unsafe extern "C" fn k_hit_looks(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (plist, ha, ht, uev, parg, pdmg, pown) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<f64>(5), k.p::<i8>(6));
    let (xs, ys, ids, own, sty, sptype, srow, hot, sl) = (k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9), k.p::<i8>(10), k.p::<u8>(11), k.p::<i16>(12), k.p::<i16>(13), k.p::<f32>(14), k.p::<i32>(15));
    let (okind, oaid, otid, oax, oay, otx, oty) = (k.p::<u8>(16), k.p::<i32>(17), k.p::<i32>(18), k.p::<i32>(19), k.p::<i32>(20), k.p::<i32>(21), k.p::<i32>(22));
    let (odmg, oown, osty, otyp, hdr) = (k.p::<f32>(23), k.p::<i8>(24), k.p::<u8>(25), k.p::<u8>(26), k.p::<i32>(27));
    let (np, no, off, nq, npj, hw, ns, cap, w, tile) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize, k.i(2).max(0) as usize, k.i(3).max(0) as usize,
        k.i(4).max(0) as usize, k.i(5).max(1) as usize, k.i(6).max(0) as usize, k.i(7).max(0) as usize, k.i(8).max(1), k.i(9));
    let mut m = *hdr as usize;
    let typ_of = |s: usize| -> u8 { let t = *sptype.add(s); if t >= 0 && t < 255 { t as u8 } else { 255 } };
    let dmg_of = |s: usize| -> f32 { let r = *srow.add(s); if r >= 0 && !hot.is_null() { *hot.add(r as usize * hw + 5) } else { 0.0 } };
    for p in 0..np + no {
        if m >= cap { break; }
        let e = *plist.add(if p < np { p } else { off + p - np }) as usize;
        if e < nq { continue; }
        if e < nq + npj {
            // (A shot's: its impact's look is the projectile phase's; here the target's flash and alert.)
            if uev.is_null() { continue; }
            let q = *uev.add(e - nq) as usize;
            let ts = *parg.add(q);
            if ts < 0 { continue; }
            let ts = ts as usize;
            *okind.add(m) = K_SHOT; *oaid.add(m) = 0; *otid.add(m) = *ids.add(ts);
            *oax.add(m) = *xs.add(ts); *oay.add(m) = *ys.add(ts); *otx.add(m) = *xs.add(ts); *oty.add(m) = *ys.add(ts);
            *odmg.add(m) = *pdmg.add(q) as f32; *oown.add(m) = *pown.add(q); *osty.add(m) = 0; *otyp.add(m) = 255;
            m += 1;
            continue;
        }
        let j = e - nq - npj;
        let (s, t) = (*ha.add(j), *ht.add(j));
        if s < 0 || t < 0 { continue; }
        let (s, t) = (s as usize, t as usize);
        *okind.add(m) = K_UNIT; *oaid.add(m) = *ids.add(s); *otid.add(m) = *ids.add(t);
        *oax.add(m) = *xs.add(s); *oay.add(m) = *ys.add(s); *otx.add(m) = *xs.add(t); *oty.add(m) = *ys.add(t);
        *odmg.add(m) = dmg_of(s); *oown.add(m) = *own.add(s); *osty.add(m) = *sty.add(s); *otyp.add(m) = typ_of(s);
        m += 1;
    }
    let half = (tile * 4) as i32;
    for i in 0..ns {
        if m >= cap || sl.is_null() { break; }
        let (s, tl, d) = (*sl.add(3 * i), *sl.add(3 * i + 1), *sl.add(3 * i + 2));
        if s < 0 || tl < 0 { continue; }
        let s = s as usize;
        let gx = tl % w;
        let gy = tl / w;
        *okind.add(m) = K_STRUCT; *oaid.add(m) = *ids.add(s); *otid.add(m) = tl;
        *oax.add(m) = *xs.add(s); *oay.add(m) = *ys.add(s); *otx.add(m) = gx * tile * 8 + half; *oty.add(m) = gy * tile * 8 + half;
        *odmg.add(m) = d as f32 / 1024.0; *oown.add(m) = *own.add(s); *osty.add(m) = *sty.add(s); *otyp.add(m) = typ_of(s);
        m += 1;
    }
    *hdr = m as i32;
}
