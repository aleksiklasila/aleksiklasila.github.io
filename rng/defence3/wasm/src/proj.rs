//! Projectiles (projectile.js): the shots are a pool in the heap, a slot a
//! shot (pj.* columns by slot; pj.live the slots in flight, pj.free a stack
//! of the others, pj.hdr the counts), sized at the match's start. Nothing
//! here depends on which slot a shot has (peers may lay them out
//! differently after a restore): a step's hits are applied as sums (units,
//! k.rs k_hits) or in the order of the shots' ids (structures, ord.rs
//! k_proj_struct_hits), the hash is a sum over the shots.
//!
//! k_proj_flight: each shot's base ticks of the step, independent of the
//! others, on the helpers. A shot moves, then looks for its first unit hit
//! (the unit index's tiles and entries in the order forEachUnitInRange
//! visits them), then a structure hit (the lowest kind/tile rank within 18
//! px of a structure's tile centre), then its floor target, then range and
//! life. Its position and life are written back where it ended, its event
//! for k_proj_resolve.
use super::*;
use super::k::K;

/// Event kinds (low 4 bits; the base tick, 1.., above them).
const EV_ALIVE: i32 = 0;
const EV_UNIT: i32 = 1;
const EV_BUILD: i32 = 2;
const EV_FLOOR: i32 = 3;
const EV_EXPIRE: i32 = 4;

#[inline(always)]
fn hyp(x: f64, y: f64) -> f64 { sqrt(x * x + y * y) }
#[inline(always)]
unsafe fn g<T: Copy>(p: *const T, i: usize) -> T { *p.add(i) }
#[inline(always)]
unsafe fn s<T>(p: *mut T, i: usize, v: T) { *p.add(i) = v; }
#[inline(always)]
fn job(chunk: i32, per: i32, n: i32) -> (usize, usize) {
    let a = (chunk.max(0) as i64 * per.max(0) as i64).min(n.max(0) as i64) as usize;
    let b = (a as i64 + per.max(0) as i64).min(n.max(0) as i64) as usize;
    (a, b)
}

/// SIM_KERNEL_PROJ_FLIGHT. Arrays: pj.live, pj.x, pj.y, pj.vx, pj.vy,
/// pj.life, pj.sx, pj.sy, pj.range, pj.own, pj.ft (its floor target's tile,
/// -1 none), ix.stamp, ix.start, ix.cnt, sep.eslot, unit.x, unit.y, unit.r,
/// unit.dead, unit.live, unit.owner, ?ix.complex, st.code, st.own, st.val,
/// pj.ev, pj.arg (the unit's slot or the structure's tile), pj.px, pj.py
/// (where it was as the step began: the page's interpolation).
/// P: [0] shots in flight, [1] per job, [2] base ticks, [3] grid width,
/// [4] height, [5] tile, [6] the index's epoch, [7] players, [8] the
/// complex filter's stride (0 none), [9] tiles.
#[no_mangle]
pub unsafe extern "C" fn k_proj_flight(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let live = k.p::<i32>(0);
    let px = k.p::<f64>(1); let py = k.p::<f64>(2); let pvx = k.p::<f64>(3); let pvy = k.p::<f64>(4);
    let plife = k.p::<i32>(5); let psx = k.p::<f64>(6); let psy = k.p::<f64>(7); let prange = k.p::<f64>(8);
    let pown = k.p::<i8>(9); let pft = k.p::<i32>(10);
    let stamp = k.p::<i32>(11); let start = k.p::<i32>(12); let count = k.p::<i32>(13); let eslot = k.p::<i32>(14);
    let ux = k.p::<i32>(15); let uy = k.p::<i32>(16); let ur = k.p::<f32>(17); let udead = k.p::<u8>(18); let ulive = k.p::<u8>(19); let uown = k.p::<i8>(20);
    let cplx = k.p::<i32>(21);
    let code = k.p::<u8>(22); let sown = k.p::<i32>(23); let sval = k.p::<f64>(24);
    let oev = k.p::<i32>(25); let oarg = k.p::<i32>(26); let opx = k.p::<f32>(27); let opy = k.p::<f32>(28);
    let n = k.i(0); let per = k.i(1); let dk = k.i(2).max(1); let w = k.i(3); let h = k.i(4); let tile = k.f(5);
    let epoch = k.i(6); let np = k.i(7); let sc = k.i(8); let wh = k.i(9);
    let filters = sc > 0 && !cplx.is_null();
    let half = tile * 0.5;
    let (q0, q1) = job(chunk, per, n);
    for q in q0..q1 {
        let q = g(live, q) as usize;
        let mut x = g(px, q); let mut y = g(py, q); let vx = g(pvx, q); let vy = g(pvy, q);
        let mut life = g(plife, q); let sx = g(psx, q); let sy = g(psy, q); let range = g(prange, q);
        let owner = g(pown, q) as i32; let ft = g(pft, q);
        s(opx, q, x as f32); s(opy, q, y as f32);
        // (An owner outside the players: forEachUnitInRange finds nothing.)
        let units = owner >= 0 && owner < np;
        let mut ev = EV_ALIVE | (dk << 4); let mut arg = -1;
        'ticks: for j in 1..=dk {
            x += vx; y += vy; life -= 1;
            // Units: radius 16, scan pad one tile (CHUNK_SIZE 1: a chunk is a tile).
            if units {
                let scan = 16.0 + tile;
                let cx0 = (floor((x - scan) / tile) as i32).max(0); let cx1 = (floor((x + scan) / tile) as i32).min(w - 1);
                let cy0 = (floor((y - scan) / tile) as i32).max(0); let cy1 = (floor((y + scan) / tile) as i32).min(h - 1);
                let mut cy = cy0;
                while cy <= cy1 {
                    let mut cx = cx0;
                    while cx <= cx1 {
                        let ck = (cy * w + cx) as usize; cx += 1;
                        if filters {
                            let cb = ck * sc as usize; let mut pass = false;
                            for pid in 0..np { if pid != owner && g(cplx, cb + pid as usize) > 0 { pass = true; break; } }
                            if !pass { continue; }
                        }
                        if g(stamp, ck) != epoch { continue; }
                        let minx = (cx - 1) as f64 * tile; let miny = cy as f64 * tile;
                        let nx = if x < minx { minx } else if x > minx + tile { minx + tile } else { x };
                        let ny = if y < miny { miny } else if y > miny + tile { miny + tile } else { y };
                        let (ddx, ddy) = (x - nx, y - ny);
                        if ddx * ddx + ddy * ddy > 256.0 { continue; }
                        let e0 = g(start, ck); let e1 = e0 + g(count, ck);
                        for e in e0..e1 {
                            let su = g(eslot, e as usize);
                            if su < 0 { continue; }
                            let su = su as usize;
                            if g(ulive, su) == 0 || g(uown, su) as i32 == owner || g(udead, su) == 1 { continue; }
                            let dx = g(ux, su) as f64 * 0.125 - x; let dy = g(uy, su) as f64 * 0.125 - y;
                            let d2 = dx * dx + dy * dy;
                            if d2 > 256.0 { continue; }
                            let hr = g(ur, su) as f64 + 8.0;
                            if d2 <= hr * hr { ev = EV_UNIT | (j << 4); arg = su as i32; break 'ticks; }
                        }
                    }
                    cy += 1;
                }
            }
            // Structures: the lowest rank (kind, then tile) within 18 px.
            {
                let gx0 = (floor((x - 18.0) / tile) as i32).max(0); let gx1 = (floor((x + 18.0) / tile) as i32).min(w - 1);
                let gy0 = (floor((y - 18.0) / tile) as i32).max(0); let gy1 = (floor((y + 18.0) / tile) as i32).min(h - 1);
                let mut best = -1i32; let mut rank = i64::MAX;
                let mut gy = gy0;
                while gy <= gy1 {
                    let mut gx = gx0;
                    while gx <= gx1 {
                        let t = (gy * w + gx) as usize; let tx = gx; gx += 1;
                        let kind = match g(code, t) { 0x22 => 0, 0x33 => 1, 0x44 => 2, _ => continue };
                        // (`b.energy <= 0` skips: NaN does not.)
                        if g(sown, t) == owner || g(sval, t) <= 0.0 { continue; }
                        let r = kind as i64 * wh as i64 + t as i64;
                        if r >= rank { continue; }
                        if hyp(tx as f64 * tile + half - x, gy as f64 * tile + half - y) <= 18.0 { best = t as i32; rank = r; }
                    }
                    gy += 1;
                }
                if best >= 0 { ev = EV_BUILD | (j << 4); arg = best; break 'ticks; }
            }
            // Its floor target: the floor item there (code 0x55) if still standing.
            if ft >= 0 {
                let t = ft as usize;
                if g(code, t) == 0x55 && g(sown, t) != owner && g(sval, t) > 0.0 {
                    // (Row and column of a tile without integer division: the
                    // caller passes the target's tile as gy * w + gx, and its
                    // centre is recomputed here from floats.)
                    let fy = floor(ft as f64 / w as f64); let fx = ft as f64 - fy * w as f64;
                    if hyp(fx * tile + half - x, fy * tile + half - y) <= 18.0 { ev = EV_FLOOR | (j << 4); arg = ft; break 'ticks; }
                }
            }
            if hyp(x - sx, y - sy) >= range || life <= 0 { ev = EV_EXPIRE | (j << 4); break 'ticks; }
        }
        s(oev, q, ev); s(oarg, q, arg);
        s(px, q, x); s(py, q, y); s(plife, q, life);
    }
}

/// k_proj_resolve (direct, after the flight): the shots still flying kept in
/// pj.live (hdr[0] of them, their order kept), the others' slots onto the
/// free stack (pj.free, hdr[1]; their columns stay as they are until a new
/// shot takes the slot, which is never before the step's hits are applied);
/// those that hit a unit listed in pj.uev (hdr[4]; with a status, by pj.ty:
/// hdr[7]), a structure or their floor target in pj.sev (hdr[5]), the first
/// P[0] of either in pj.look (hdr[6]: the looks).
/// Arrays: pj.live, pj.free, pj.hdr, pj.ev, pj.uev, pj.sev, pj.look, pj.ty.
#[no_mangle]
pub unsafe extern "C" fn k_proj_resolve(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (live, free, hdr, ev, uev, sev, look, ty) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<u8>(7));
    let looks = k.i(0).max(0) as usize;
    let n = g(hdr, 0).max(0) as usize;
    let mut nf = g(hdr, 1).max(0) as usize;
    let (mut w, mut nu, mut ns, mut nl, mut nst) = (0usize, 0usize, 0usize, 0usize, 0i32);
    for i in 0..n {
        let q = g(live, i);
        let e = g(ev, q as usize) & 15;
        if e == EV_ALIVE { s(live, w, q); w += 1; continue; }
        if e == EV_UNIT { s(uev, nu, q); nu += 1; if g(ty, q as usize) != 0 { nst += 1; } }
        else if e == EV_BUILD || e == EV_FLOOR { s(sev, ns, q); ns += 1; }
        if e != EV_EXPIRE && nl < looks { s(look, nl, q); nl += 1; }
        s(free, nf, q); nf += 1;
    }
    s(hdr, 0, w as i32); s(hdr, 1, nf as i32); s(hdr, 4, nu as i32); s(hdr, 5, ns as i32); s(hdr, 6, nl as i32); s(hdr, 7, nst);
}

/// SIM_KERNEL_PROJ_BLAST: per job, how many units the blasts of its shots
/// that hit a unit (pj.uev, P[0] of them, P[1] a job) can reach at most (as
/// k_hits counts them, without the type flags: room for that many touched
/// units and, for fire, status records): pj.bsum[2 job] all, [2 job + 1]
/// fire's. Arrays: pj.uev, pj.x, pj.y, pj.bd, pj.br, pj.own, pj.ty,
/// ix.stamp, ix.start, ix.cnt, sep.eslot, unit.live, unit.dead, unit.owner,
/// unit.x, unit.y, pj.bsum. P: [0] shots, [1] per job, [2] grid width, [3]
/// height, [4] tile, [5] the index's epoch.
#[no_mangle]
pub unsafe extern "C" fn k_proj_blast(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (uev, pxs, pys, pbd, pbr, pown, pty) = (k.p::<i32>(0), k.p::<f64>(1), k.p::<f64>(2), k.p::<f64>(3), k.p::<f64>(4), k.p::<i8>(5), k.p::<u8>(6));
    let (stamp, start, count, eslot, live, dead, own, ux, uy, sum) = (k.p::<i32>(7), k.p::<i32>(8), k.p::<i32>(9), k.p::<i32>(10), k.p::<u8>(11), k.p::<u8>(12),
        k.p::<i8>(13), k.p::<i32>(14), k.p::<i32>(15), k.p::<i32>(16));
    let (w, h, tile, epoch) = (k.i(2), k.i(3), k.f(4), k.i(5));
    let (i0, i1) = job(chunk, k.i(1), k.i(0));
    let (mut all, mut fire) = (0i32, 0i32);
    for i in i0..i1 {
        let sl = g(uev, i) as usize;
        let (bdm, br) = (g(pbd, sl), g(pbr, sl));
        if !(bdm > 0.0 && br > 0.0) { continue; }
        let (x, y, o) = (g(pxs, sl), g(pys, sl), g(pown, sl) as i32);
        let r2 = br * br;
        let gx0 = (floor((x - br) / tile) as i32).max(0); let gx1 = (floor((x + br) / tile) as i32).min(w - 1);
        let gy0 = (floor((y - br) / tile) as i32).max(0); let gy1 = (floor((y + br) / tile) as i32).min(h - 1);
        let mut c = 0i32;
        for gy in gy0..=gy1 {
            for gx in gx0..=gx1 {
                let ck = (gy * w + gx) as usize;
                if g(stamp, ck) != epoch { continue; }
                let e0 = g(start, ck);
                for e in e0..e0 + g(count, ck) {
                    let su = g(eslot, e as usize);
                    if su < 0 { continue; }
                    let su = su as usize;
                    if g(live, su) == 0 || g(dead, su) != 0 || g(own, su) as i32 == o { continue; }
                    let dx = g(ux, su) as f64 * 0.125 - x; let dy = g(uy, su) as f64 * 0.125 - y;
                    if dx * dx + dy * dy <= r2 { c += 1; }
                }
            }
        }
        all += c;
        if g(pty, sl) == 1 { fire += c; }
    }
    s(sum, 2 * chunk.max(0) as usize, all); s(sum, 2 * chunk.max(0) as usize + 1, fire);
}

#[inline(always)]
fn mix(h: u32, v: u32) -> u32 { (h ^ v).wrapping_mul(16777619) }
#[inline(always)]
fn mixf(h: u32, v: f64) -> u32 { let b = v.to_bits(); mix(mix(h, b as u32), (b >> 32) as u32) }

/// k_proj_hash (direct): the shots in flight as one word (pj.hdr[9]): the
/// sum of each shot's hash (any order, any slots) with their count and the
/// next id. Arrays: pj.live, pj.hdr, pj.x, pj.y, pj.vx, pj.vy, pj.life,
/// pj.sx, pj.sy, pj.range, pj.own, pj.ft, pj.dmg, pj.lvl, pj.ty, pj.tt,
/// pj.bd, pj.br, pj.shots, pj.sd, pj.sp, pj.id.
#[no_mangle]
pub unsafe extern "C" fn k_proj_hash(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (live, hdr) = (k.p::<i32>(0), k.p::<i32>(1));
    let (x, y, vx, vy, life, sx, sy, rg) = (k.p::<f64>(2), k.p::<f64>(3), k.p::<f64>(4), k.p::<f64>(5), k.p::<i32>(6), k.p::<f64>(7), k.p::<f64>(8), k.p::<f64>(9));
    let (own, ft, dmg, lvl, ty, tt, bd, br) = (k.p::<i8>(10), k.p::<i32>(11), k.p::<f64>(12), k.p::<i32>(13), k.p::<u8>(14), k.p::<i16>(15), k.p::<f64>(16), k.p::<f64>(17));
    let (shots, sd, sp, id) = (k.p::<i32>(18), k.p::<i32>(19), k.p::<f32>(20), k.p::<i32>(21));
    let n = g(hdr, 0).max(0) as usize;
    let mut sum = 0u32;
    for i in 0..n {
        let q = g(live, i) as usize;
        let mut h = 2166136261u32;
        for v in [g(x, q), g(y, q), g(vx, q), g(vy, q), g(sx, q), g(sy, q), g(rg, q), g(dmg, q), g(bd, q), g(br, q)] { h = mixf(h, v); }
        for v in [g(life, q), g(own, q) as i32, g(ft, q), g(lvl, q), g(ty, q) as i32, g(tt, q) as i32, g(shots, q), g(sd, q), g(sp, q).to_bits() as i32, g(id, q)] { h = mix(h, v as u32); }
        h = (h ^ (h >> 15)).wrapping_mul(2246822519);
        sum = sum.wrapping_add(h);
    }
    s(hdr, 9, mix(mix(sum, n as u32), g(hdr, 2) as u32) as i32);
}
