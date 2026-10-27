//! Projectile flight (projectile.js projectilesAdvance): each shot's base
//! ticks of a step, independent of the others, on the helpers. A shot moves,
//! then looks for its first unit hit (the unit index's tiles and entries in
//! the order forEachUnitInRange visits them), then a structure hit (the
//! lowest kind/tile rank within 18 px, _projectileBuildingHit), then its
//! floor target, then range and life. The answer is an event the JavaScript
//! applies in the shots' order; it re-checks the target there (an earlier
//! shot of the phase may have killed it: kills only remove candidates, so a
//! target still alive is still the first). Arithmetic is the JavaScript's:
//! f64 adds per base tick, squared distances, sqrt for detHypot.
use super::*;
use super::k::K;

/// Event kinds (low 4 bits; the base tick, 1.., above them).
const EV_ALIVE: i32 = 0;
const EV_UNIT: i32 = 1;
const EV_BUILD: i32 = 2;
const EV_FLOOR: i32 = 3;
const EV_EXPIRE: i32 = 4;
/// The JavaScript flies it on from this base tick (a structure with custom
/// stats or position in reach: its centre is not the tile's).
const EV_JS: i32 = 5;
const CUSTOM: i32 = 1 << 25;

#[inline(always)]
fn hyp(x: f64, y: f64) -> f64 { sqrt(x * x + y * y) }

#[no_mangle]
pub unsafe extern "C" fn k_proj_flight(a: u32, chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let px = k.p::<f64>(0); let py = k.p::<f64>(1); let pvx = k.p::<f64>(2); let pvy = k.p::<f64>(3);
    let plife = k.p::<f64>(4); let psx = k.p::<f64>(5); let psy = k.p::<f64>(6); let prange = k.p::<f64>(7);
    let pown = k.p::<i32>(8); let pft = k.p::<i32>(9);
    let stamp = k.p::<i32>(10); let start = k.p::<i32>(11); let count = k.p::<i32>(12); let eslot = k.p::<i32>(13);
    let ux = k.p::<i32>(14); let uy = k.p::<i32>(15); let ur = k.p::<f32>(16); let udead = k.p::<u8>(17); let ulive = k.p::<u8>(18); let uown = k.p::<i8>(19);
    let cplx = k.p::<i32>(20);
    let code = k.p::<u8>(21); let sown = k.p::<i32>(22); let sval = k.p::<f64>(23); let brain = k.p::<i32>(24);
    let oev = k.p::<i32>(25); let oarg = k.p::<i32>(26); let ox = k.p::<f64>(27); let oy = k.p::<f64>(28); let opx = k.p::<f64>(29); let opy = k.p::<f64>(30);
    let ol = k.p::<f64>(31); let opl = k.p::<f64>(32);
    let n = k.i(0); let per = k.i(1); let dk = k.i(2).max(1); let w = k.i(3); let h = k.i(4); let tile = k.f(5);
    let epoch = k.i(6); let np = k.i(7); let sc = k.i(8); let wh = k.i(9);
    let filters = sc > 0 && !cplx.is_null();
    let half = tile * 0.5;
    let q0 = chunk * per; let q1 = (q0 + per).min(n);
    for q in q0..q1 {
        let q = q as usize;
        let mut x = *px.add(q); let mut y = *py.add(q); let vx = *pvx.add(q); let vy = *pvy.add(q);
        let mut life = *plife.add(q); let sx = *psx.add(q); let sy = *psy.add(q); let range = *prange.add(q);
        let owner = *pown.add(q); let ft = *pft.add(q);
        // (An owner outside the players: forEachUnitInRange finds nothing.)
        let units = owner >= 0 && owner < np;
        let mut ev = EV_ALIVE | (dk << 4); let mut arg = -1;
        let (mut lx, mut ly, mut ll) = (x, y, life);
        'ticks: for j in 1..=dk {
            lx = x; ly = y; ll = life;
            x += vx; y += vy; life -= 1.0;
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
                            for pid in 0..np { if pid != owner && *cplx.add(cb + pid as usize) > 0 { pass = true; break; } }
                            if !pass { continue; }
                        }
                        if *stamp.add(ck) != epoch { continue; }
                        let minx = (cx - 1) as f64 * tile; let miny = cy as f64 * tile;
                        let nx = if x < minx { minx } else if x > minx + tile { minx + tile } else { x };
                        let ny = if y < miny { miny } else if y > miny + tile { miny + tile } else { y };
                        let (ddx, ddy) = (x - nx, y - ny);
                        if ddx * ddx + ddy * ddy > 256.0 { continue; }
                        let e0 = *start.add(ck); let e1 = e0 + *count.add(ck);
                        for e in e0..e1 {
                            let s = *eslot.add(e as usize);
                            if s < 0 { continue; }
                            let s = s as usize;
                            if *ulive.add(s) == 0 || *uown.add(s) as i32 == owner || *udead.add(s) == 1 { continue; }
                            let dx = *ux.add(s) as f64 * 0.125 - x; let dy = *uy.add(s) as f64 * 0.125 - y;
                            let d2 = dx * dx + dy * dy;
                            if d2 > 256.0 { continue; }
                            let hr = *ur.add(s) as f64 + 8.0;
                            if d2 <= hr * hr { ev = EV_UNIT | (j << 4); arg = s as i32; break 'ticks; }
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
                        let kind = match *code.add(t) { 0x22 => 0, 0x33 => 1, 0x44 => 2, _ => continue };
                        // (`b.energy <= 0` skips: NaN does not.)
                        if *sown.add(t) == owner || *sval.add(t) <= 0.0 { continue; }
                        let r = kind as i64 * wh as i64 + t as i64;
                        if r >= rank { continue; }
                        if *brain.add(t) & CUSTOM != 0 { ev = EV_JS | (j << 4); break 'ticks; }
                        if hyp(tx as f64 * tile + half - x, gy as f64 * tile + half - y) <= 18.0 { best = t as i32; rank = r; }
                    }
                    gy += 1;
                }
                if best >= 0 { ev = EV_BUILD | (j << 4); arg = best; break 'ticks; }
            }
            // Its floor target: the floor item there (code 0x55) if still standing.
            if ft >= 0 {
                let t = ft as usize;
                if *code.add(t) == 0x55 && *sown.add(t) != owner && *sval.add(t) > 0.0 {
                    if *brain.add(t) & CUSTOM != 0 { ev = EV_JS | (j << 4); break 'ticks; }
                    // (Row and column of a tile without integer division: the
                    // caller passes the target's tile as gy * w + gx, and its
                    // centre is recomputed here from floats.)
                    let fy = floor(ft as f64 / w as f64); let fx = ft as f64 - fy * w as f64;
                    if hyp(fx * tile + half - x, fy * tile + half - y) <= 18.0 { ev = EV_FLOOR | (j << 4); arg = ft; break 'ticks; }
                }
            }
            if hyp(x - sx, y - sy) >= range || life <= 0.0 { ev = EV_EXPIRE | (j << 4); break 'ticks; }
        }
        *oev.add(q) = ev; *oarg.add(q) = arg;
        *ox.add(q) = x; *oy.add(q) = y; *opx.add(q) = lx; *opy.add(q) = ly; *ol.add(q) = life; *opl.add(q) = ll;
    }
}
