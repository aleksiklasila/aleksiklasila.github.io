//! Tile changes as a batch (unit.js simTileChangesRun): for each listed tile,
//! in order, what a change of its cell type or of its tile entity means for
//! the walk tables: the ground walls (mv.wall) with their block change counts
//! (mv.wallBlk, mv.wallBlk9), the step costs around it, the walk classes'
//! walls (flownav.js _navClassWalls: the builders pass every player's
//! structure, never a mine), and per navigation profile
//! the count of tiles that differ from its newest build (flownav.js
//! _navDiff). Tiles that became ground walls are listed (their units are
//! pushed off them by the caller).
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
#[inline(always)]
unsafe fn arr<T>(tab: *const i32, i: usize) -> *mut T {
    if tab.is_null() {
        return core::ptr::null_mut();
    }
    let a = g(tab, i);
    if a == 0 { core::ptr::null_mut() } else { waddr(a as u32) as *mut T }
}

/// Arrays: [0] list (t * 2 + kind: 0 its cell type, 1 its tile entity only),
/// [1] cell types, [2] mv.wall, [3] mv.wallBlk, [4] ?mv.wallBlk9, [5] ?step
/// costs, [6] the profiles' diff counts, [7] ?per profile its newest build's
/// walls (encoded addresses, 0 none), [8] ?per profile its class walls (0
/// none), [9] structure codes, [10] owners, [11] values, [12] hdr out ([0]
/// wall version steps, [1] new walls listed), [13] new walls out.
/// P: [0] n, [1] W, [2] H, [3] TYPE_WALL, [4] profiles, [5] the first class
/// profile (the builders'), [7] blocks wide, [8]/[9] the gold and A* mines'
/// codes.
#[no_mangle]
pub unsafe extern "C" fn k_tile_changes(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (list, ctype, wall, blk, blk9, scost) = (k.p::<i32>(0), k.p::<u8>(1), k.p::<u8>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<u8>(5));
    let (diff, newest, cwt) = (k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8));
    let (stcode, stown, stval) = (k.p::<u8>(9), k.p::<i32>(10), k.p::<f64>(11));
    let (hdr, nwl) = (k.p::<i32>(12), k.p::<i32>(13));
    // (14: the 11x11 blocks' sums, unit.js _simMoveWallBlk81.)
    let blk81 = k.p::<i32>(14);
    let n = k.i(0).max(0) as usize;
    let (w, h) = (k.i(1).max(0) as u32, k.i(2).max(0) as u32);
    let twall = k.i(3) as u8;
    let np = k.i(4).clamp(0, 32) as usize;
    let pcls = k.i(5).max(0) as usize;
    let bw = k.i(7).max(0) as u32;
    let bh = (h + 7) >> 3;
    let (mg, ma) = (k.i(8) as u8, k.i(9) as u8);
    let nt = w * h;
    let (mut ver, mut nn) = (0i32, 0i32);
    // (A block's change: its count, and its 3x3's sums.)
    let bump = |x: u32, y: u32| {
        let (bx, by) = (x >> 3, y >> 3);
        s(blk, (by * bw + bx) as usize, g(blk, (by * bw + bx) as usize).wrapping_add(1));
        if !blk9.is_null() {
            for yy in by.saturating_sub(1)..=(by + 1).min(bh.saturating_sub(1)) {
                for xx in bx.saturating_sub(1)..=(bx + 1).min(bw.saturating_sub(1)) {
                    let i = (yy * bw + xx) as usize;
                    s(blk9, i, g(blk9, i).wrapping_add(1));
                }
            }
        }
        if !blk81.is_null() {
            for yy in by.saturating_sub(5)..=(by + 5).min(bh.saturating_sub(1)) {
                for xx in bx.saturating_sub(5)..=(bx + 5).min(bw.saturating_sub(1)) {
                    let i = (yy * bw + xx) as usize;
                    s(blk81, i, g(blk81, i).wrapping_add(1));
                }
            }
        }
    };
    let diff_step = |p: usize, t: usize, was: u8, now: u8| {
        let nw = arr::<u8>(newest, p);
        if nw.is_null() {
            return;
        }
        let v = g(nw, t);
        let mut d = g(diff, p);
        if was != v { d -= 1; }
        if now != v { d += 1; }
        s(diff, p, d);
    };
    for i in 0..n {
        let e = g(list, i);
        if e < 0 {
            continue;
        }
        let t = (e >> 1) as u32;
        if t >= nt || w == 0 {
            continue;
        }
        let (y, x) = { let ti = t as i32; let wi = w as i32; let yy = idiv(ti, wi); (yy as u32, (ti - yy * wi) as u32) };
        let tu = t as usize;
        if e & 1 == 0 {
            // (Its step costs: the 5x5 around it worked out again.)
            if !scost.is_null() {
                for yy in y.saturating_sub(2)..=(y + 2).min(h - 1) {
                    for xx in x.saturating_sub(2)..=(x + 2).min(w - 1) {
                        s(scost, (yy * w + xx) as usize, 0);
                    }
                }
            }
            let v = if g(ctype, tu) == twall { 1u8 } else { 0u8 };
            let was = g(wall, tu);
            if was != v {
                s(wall, tu, v);
                ver += 1;
                bump(x, y);
                diff_step(0, tu, was, v);
                if v == 1 {
                    s(nwl, nn as usize, t as i32);
                    nn += 1;
                }
            }
        }
        // The walk classes' walls there.
        let gw = g(wall, tu);
        let code = g(stcode, tu);
        let mine = code == mg || code == ma;
        let pass = code != 0 && !mine;
        let _ = (stown, stval);
        let mut changed = false;
        for p in pcls..np {
            let cw = arr::<u8>(cwt, p);
            if cw.is_null() {
                continue;
            }
            let v = if gw != 0 && !pass { 1u8 } else { 0u8 };
            let was = g(cw, tu);
            if was == v {
                continue;
            }
            s(cw, tu, v);
            changed = true;
            diff_step(p, tu, was, v);
        }
        if changed {
            ver += 1;
            bump(x, y);
        }
    }
    s(hdr, 0, ver);
    s(hdr, 1, nn);
}

#[inline(always)]
unsafe fn find(par: *mut i32, mut a: i32) -> i32 {
    while g(par, a as usize) != a {
        let up = g(par, g(par, a as usize) as usize);
        s(par, a as usize, up);
        a = up;
    }
    a
}


/// The units standing on tiles that just became walls (unit.js
/// simTileChangesFlush; forEachUnitInRange's candidates of a 1.5 tile range
/// around each tile's centre, as it finds them: the index's chunks within the
/// range plus a tile, stamped this epoch, nearest point within the range;
/// alive), those not flying whose tile it is, each tile's in id order.
/// Arrays: [0] tiles, [1] chunk stamps, [2] starts, [3] counts, [4] entry
/// slots, [5] unit.x, [6] unit.y (eighths of a pixel), [7] unit.dead, [8]
/// unit.jFly, [9] unit.id, [10] out (tile, slot pairs), [11] hdr out ([0]
/// pairs). P: [0] tiles, [1] W, [2] TILE, [3] chunk px, [4] / [5] chunks
/// wide / high, [6] epoch, [7] out room (pairs).
#[no_mangle]
pub unsafe extern "C" fn k_wall_units(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (tl, stamp, start, cnt, es) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4));
    let (ux, uy, dead, fly, id) = (k.p::<i32>(5), k.p::<i32>(6), k.p::<u8>(7), k.p::<u8>(8), k.p::<i32>(9));
    let (out, hdr) = (k.p::<i32>(10), k.p::<i32>(11));
    let n = k.i(0).max(0) as usize;
    let w = k.i(1).max(1);
    let tile = k.f(2);
    let cws = k.f(3);
    let (cw, ch, ep) = (k.i(4), k.i(5), k.i(6));
    let room = k.i(7).max(0) as usize;
    let r = tile * 1.5;
    let scan = r + tile;
    let r2 = r * r;
    let mut no = 0usize;
    for i in 0..n {
        let t = g(tl, i);
        if t < 0 { continue; }
        let gy = idiv(t, w);
        let gx = t - gy * w;
        let (wx, wy) = (gx as f64 * tile + tile / 2.0, gy as f64 * tile + tile / 2.0);
        let min_cx = (floor((wx - scan) / cws) as i32).max(0);
        let max_cx = (floor((wx + scan) / cws) as i32).min(cw - 1);
        let min_cy = (floor((wy - scan) / cws) as i32).max(0);
        let max_cy = (floor((wy + scan) / cws) as i32).min(ch - 1);
        let first = no;
        for cy in min_cy..=max_cy {
            for cx in min_cx..=max_cx {
                let ck = (cy * cw + cx) as usize;
                if g(stamp, ck) != ep { continue; }
                let (mx, my) = (cx as f64 * cws, cy as f64 * cws);
                let nx = if wx < mx { mx } else if wx > mx + cws { mx + cws } else { wx };
                let ny = if wy < my { my } else if wy > my + cws { my + cws } else { wy };
                if (wx - nx) * (wx - nx) + (wy - ny) * (wy - ny) > r2 { continue; }
                let k0 = g(start, ck);
                for e in k0..k0 + g(cnt, ck) {
                    let q = g(es, e as usize);
                    if q < 0 { continue; }
                    let q = q as usize;
                    if g(dead, q) != 0 || g(fly, q) != 0 { continue; }
                    let (x, y) = (g(ux, q) as f64 * 0.125, g(uy, q) as f64 * 0.125);
                    let (dx, dy) = (x - wx, y - wy);
                    if dx * dx + dy * dy > r2 { continue; }
                    if floor(x / tile) as i32 != gx || floor(y / tile) as i32 != gy { continue; }
                    if no >= room { continue; }
                    // (In id order: insertion among this tile's.)
                    let mut j = no;
                    while j > first && g(id, g(out, 2 * (j - 1) + 1) as usize) > g(id, q) {
                        s(out, 2 * j, g(out, 2 * (j - 1)));
                        s(out, 2 * j + 1, g(out, 2 * (j - 1) + 1));
                        j -= 1;
                    }
                    s(out, 2 * j, t);
                    s(out, 2 * j + 1, q as i32);
                    no += 1;
                }
            }
        }
    }
    s(hdr, 0, no as i32);
}

/// The tiles holding a tabled structure or mine (st.ctab not 0), in tile
/// order, into out (the occupied tiles: data_state.js _activeTileEntities'
/// iteration), at most P[1] of them; the count at cnt[0]. P: [0] tiles, [1]
/// room.
#[no_mangle]
pub unsafe extern "C" fn k_tile_occupied(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ctab, out, cnt) = (k.p::<u8>(0), k.p::<i32>(1), k.p::<i32>(2));
    let (n, room) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize);
    let mut m = 0usize;
    let mut t = 0usize;
    // (Sixteen tiles a compare: most are empty.)
    while t + 16 <= n {
        let mut bits = !(i8x16_bitmask(i8x16_eq(v128_load(ctab.add(t) as *const v128), i8x16_splat(0))) as u32) & 0xffff;
        while bits != 0 { let u = t + bits.trailing_zeros() as usize; bits &= bits - 1; if m < room { s(out, m, u as i32); m += 1; } }
        t += 16;
    }
    while t < n { if g(ctab, t) != 0 && m < room { s(out, m, t as i32); m += 1; } t += 1; }
    s(cnt, 0, m as i32);
}

/// unit.js findNearestWalkable: the tile (P[0], P[1]) if the unit may stand
/// there, else the nearest ring around it holding such tiles and in it the
/// one nearest (P[2], P[3]) (NaN: the ring's first; ties: smaller y, then
/// smaller x), the ring's order its top and bottom rows by x, then its sides
/// by y; none: the tile clamped to the map. out [8] (x, y). Where a unit may
/// stand: the map ([0] mv.wall, or the builders' class walls [1]) open, or an
/// active mine (st.code [2] 0x66 / 0x77 with st.val [3] > 0) for a collector
/// (P[8]), or a built (st.uc [4] 0) live cloud tower (code 0x22, its type
/// (st.brain [6] low word - 1) a cloud in [7]) of its owner (st.own [5]; P[7]
/// < 0 any owner); flying (P[6] 2) anywhere; no unit (P[6] 0) the map's
/// walls only. P: [4] W, [5] H.
#[no_mangle]
pub unsafe extern "C" fn k_nearest_walk(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ground, cwall, code, val, uc, own, brain, cloud, out) = (k.p::<u8>(0), k.p::<u8>(1), k.p::<u8>(2), k.p::<f64>(3), k.p::<u8>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<u8>(7), k.p::<i32>(8));
    if out.is_null() { return; }
    let (gx, gy, fx, fy) = (k.i(0), k.i(1), k.f(2), k.f(3));
    let (w, h, mode, owner, coll) = (k.i(4).max(1), k.i(5).max(1), k.i(6), k.i(7), k.i(8) != 0);
    let walls = if cwall.is_null() { ground } else { cwall };
    let nty = k.i(9).max(0);
    let ok = |x: i32, y: i32| -> bool {
        if x < 0 || y < 0 || x >= w || y >= h { return false; }
        if mode == 2 { return true; }
        let t = (y * w + x) as usize;
        if walls.is_null() || g(walls, t) == 0 { return true; }
        // (No unit: the map's walls only.)
        if mode == 0 || code.is_null() { return false; }
        let c = g(code, t);
        if coll && (c == 0x66 || c == 0x77) && !val.is_null() && g(val, t) > 0.0 { return true; }
        if c == 0x22 && !cloud.is_null() && !brain.is_null() && (uc.is_null() || g(uc, t) == 0) {
            let ty = (g(brain, t) & 65535) - 1;
            if ty >= 0 && ty < nty && g(cloud, ty as usize) != 0 && (owner < 0 || own.is_null() || g(own, t) == owner) { return true; }
        }
        false
    };
    if ok(gx, gy) { s(out, 0, gx); s(out, 1, gy); return; }
    let has_from = fx == fx && fy == fy;
    let (fxi, fyi) = (if has_from { fx as i64 } else { 0 }, if has_from { fy as i64 } else { 0 });
    let maxr = w.max(h);
    let mut r = 1;
    while r <= maxr {
        let (mut bx, mut by, mut bd, mut found) = (0i32, 0i32, 0i64, false);
        let mut take = |x: i32, y: i32| {
            if !ok(x, y) { return; }
            if !has_from { if !found { bx = x; by = y; found = true; } return; }
            let (dx, dy) = (x as i64 - fxi, y as i64 - fyi);
            let d = dx * dx + dy * dy;
            if !found || d < bd || (d == bd && (y < by || (y == by && x < bx))) { bx = x; by = y; bd = d; found = true; }
        };
        let mut x = gx - r;
        while x <= gx + r { take(x, gy - r); take(x, gy + r); x += 1; }
        let mut y = gy - r + 1;
        while y <= gy + r - 1 { take(gx - r, y); take(gx + r, y); y += 1; }
        if found { s(out, 0, bx); s(out, 1, by); return; }
        r += 1;
    }
    s(out, 0, gx.max(0).min(w - 1)); s(out, 1, gy.max(0).min(h - 1));
}

/// unit.js _simMoveWalls: the ground walls (mv.wall [1]) from the cell types
/// ([0] map.js cellType), 1 where TYPE_WALL (P[1]); P[0] tiles.
#[no_mangle]
pub unsafe extern "C" fn k_walls_from_types(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ct, wall) = (k.p::<u8>(0), k.p::<u8>(1));
    if ct.is_null() || wall.is_null() { return; }
    let (n, tw) = (k.i(0).max(0) as usize, k.i(1) as u8);
    let mut t = 0usize;
    let (sp, one) = (i8x16_splat(tw as i8), i8x16_splat(1));
    while t + 16 <= n {
        let v = v128_load(ct.add(t) as *const v128);
        v128_store(wall.add(t) as *mut v128, v128_and(i8x16_eq(v, sp), one));
        t += 16;
    }
    while t < n { s(wall, t, if g(ct, t) == tw { 1 } else { 0 }); t += 1; }
}

/// renderer.js _visCoverRows: a player's visibility rows ([2] f32 a tile)
/// from its cover ([1] i32 an area): P[2] (the light) where the tile's area
/// ([0] map.js cellArea) is covered, else 0. P: [0] tiles, [1] areas.
#[no_mangle]
pub unsafe extern "C" fn k_vis_paint(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ca, cover, out) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<f32>(2));
    if ca.is_null() || cover.is_null() || out.is_null() { return; }
    let (n, na, light) = (k.i(0).max(0) as usize, k.i(1), k.f(2) as f32);
    for t in 0..n {
        let ar = g(ca, t);
        s(out, t, if ar >= 0 && ar < na && g(cover, ar as usize) > 0 { light } else { 0.0 });
    }
}

/// unit.js _simMoveStructs: the movement kernel's structure tables from the
/// tile table (st.code [0], st.own [1], cell owners [2] (map.js cellOwner),
/// st.brain [3]; per stationary type [4]: 1 a floor trap, 8 a cloud tower):
/// the code (mv.struct [5]: -1 none or a mine; the owner, a floor item's or a
/// building's that is its cell's owner too; -2 otherwise), the class
/// (mv.scls [6]: 1 tower, 5 cloud tower, 3 barrack or spawner, 2 trap, 4
/// another floor item, 0 none) and the counts of structures hostile to each
/// player per spatial block (mv.stblk [7]: (block * players + p), every
/// code but p's). P[6] 1: every tile (P[0] of them), tables cleared first;
/// else the listed tiles ([8], P[0]) again. P: [1] W, [2] block columns, [3]
/// players, [4] tiles a block side, [5] types, [7] tiles.
#[no_mangle]
pub unsafe extern "C" fn k_move_structs(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (code, own, cown, brain, tycls, mvs, scls, blk, list) = (k.p::<u8>(0), k.p::<i32>(1), k.p::<i8>(2), k.p::<i32>(3), k.p::<u8>(4), k.p::<i8>(5), k.p::<i8>(6), k.p::<i32>(7), k.p::<i32>(8));
    if mvs.is_null() || scls.is_null() { return; }
    let (n, w, bcols, np, bs, nty, full) = (k.i(0).max(0) as usize, k.i(1).max(1), k.i(2).max(1), k.i(3).max(0), k.i(4).max(1), k.i(5).max(0), k.i(6) != 0);
    let cnt = |t: usize, c: i32, d: i32| {
        if blk.is_null() || c == -1 { return; }
        let (gx, gy) = (t as i32 % w, t as i32 / w);
        let b = ((gy / bs) * bcols + gx / bs) * np;
        for p in 0..np { if c != p { let i = (b + p) as usize; s(blk, i, g(blk, i) + d); } }
    };
    let eval = |t: usize| -> (i32, i32) {
        if code.is_null() { return (-1, 0); }
        let c = g(code, t);
        if c == 0 || c == 0x66 || c == 0x77 { return (-1, 0); }
        let o = if own.is_null() { -1 } else { g(own, t) };
        let item = c == 0x33 || c == 0x44 || c == 0x55;
        let co = if item && !cown.is_null() { g(cown, t) as i32 } else { o };
        let cd = if o >= 0 && o < 127 && o == co { o } else { -2 };
        let ty = if brain.is_null() { -1 } else { (g(brain, t) & 65535) - 1 };
        let tc = if ty >= 0 && ty < nty && !tycls.is_null() { g(tycls, ty as usize) } else { 0 };
        let cl = if c == 0x22 { if tc & 8 != 0 { 5 } else { 1 } } else if c == 0x33 || c == 0x44 { 3 } else if c == 0x55 { if tc & 1 != 0 { 2 } else { 4 } } else { 0 };
        (cd, cl)
    };
    if full {
        for t in 0..n { s(mvs, t, -1); s(scls, t, 0); }
        for t in 0..n {
            if code.is_null() || g(code, t) == 0 { continue; }
            let (cd, cl) = eval(t);
            s(mvs, t, cd as i8); s(scls, t, cl as i8);
            cnt(t, cd, 1);
        }
        return;
    }
    if list.is_null() { return; }
    for i in 0..n {
        let t = g(list, i);
        if t < 0 || t >= k.i(7) { continue; }
        let t = t as usize;
        let old = g(mvs, t) as i32;
        let (cd, cl) = eval(t);
        s(scls, t, cl as i8);
        if old == cd { continue; }
        cnt(t, old, -1);
        cnt(t, cd, 1);
        s(mvs, t, cd as i8);
    }
}

/// worker.js _wswBuild: the work-site grid's reservation bits (wsw.resv [5],
/// a tile each: bit i for load type i < 8) from the reservations (wk.resv
/// [0]: P[0] slots, P[1] types a tile, a unit id each, 0 none) whose unit is
/// alive (by the unit id index: [1] its table, P[2] its mask; [2] unit.id,
/// [3] unit.live, [4] unit.dead).
#[no_mangle]
pub unsafe extern "C" fn k_wsw_resv(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (rs, tab, idc, live, dead, out) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<u8>(3), k.p::<u8>(4), k.p::<u8>(5));
    if rs.is_null() || tab.is_null() || out.is_null() { return; }
    let (n, nt, mask) = (k.i(0).max(0) as usize, k.i(1).max(1) as usize, k.i(2) as u32);
    for slot in 0..n {
        let id = g(rs, slot);
        if id <= 0 { continue; }
        let i = slot % nt;
        if i >= 8 { continue; }
        let mut h = (id as u32).wrapping_mul(2654435761u32) & mask;
        let mut q = usize::MAX;
        loop {
            let sl = g(tab, h as usize);
            if sl < 0 { break; }
            if g(idc, sl as usize) == id && g(live, sl as usize) != 0 { q = sl as usize; break; }
            h = (h + 1) & mask;
        }
        if q == usize::MAX || g(dead, q) != 0 { continue; }
        let t = slot / nt;
        s(out, t, g(out, t) | (1u8 << i));
    }
}

/// renderer.js _visibilityKernelAreas: each area's tiles (vis.cells [2]),
/// in tile order, from offsets (vis.cellOff [1], P[1] areas + 1) made by
/// counting the tiles' areas ([0] map.js cellArea, P[0] tiles; -1 none).
#[no_mangle]
pub unsafe extern "C" fn k_area_cells(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ca, off, cells) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2));
    if ca.is_null() || off.is_null() || cells.is_null() { return; }
    let (n, na) = (k.i(0).max(0) as usize, k.i(1).max(0) as usize);
    for a in 0..=na { s(off, a, 0); }
    for t in 0..n { let ar = g(ca, t); if ar >= 0 && (ar as usize) < na { let i = ar as usize + 1; s(off, i, g(off, i) + 1); } }
    for a in 0..na { s(off, a + 1, g(off, a + 1) + g(off, a)); }
    // (Filled from each area's start: its cursor the next one's offset, put back after.)
    for t in 0..n {
        let ar = g(ca, t);
        if ar < 0 || (ar as usize) >= na { continue; }
        let at = g(off, ar as usize);
        s(cells, at as usize, t as i32);
        s(off, ar as usize, at + 1);
    }
    let mut prev = 0;
    for a in 0..na { let end = g(off, a); s(off, a, prev); prev = end; }
    s(off, na, prev);
}

/// unit.js _spbSpatial (chunk.js updateUnitSpatial of a new unit) for a spawn
/// batch's units (slots [0], P[0]; dead ones [19] skipped): its tile from its
/// position ([1] x, [2] y, 1/8 px; P[3] a tile's eighths), clamped; its
/// chunk key (the tile: chunks of one tile), area ([7] cellArea), owner [3],
/// type (its upkeep type [4] by [5] U.upTy; none: P[9] norm's), separation
/// layer by type [6]; into unit.spTile [8], sepKey [9], sepLayer [10],
/// spArea [11], spOwner [12], spEpoch [13] (P[4]), spType [14]; disarmed
/// (mvOn [15] 0); counted (unless P[15]: the caller queues them): per chunk
/// and owner [16] (P[5] a chunk), per type block, owner and type [17] (P[6] a
/// block; P[11] chunks a block side, P[12] blocks wide), per 8x8 block and
/// owner [18] (P[13], P[14] blocks wide). P: [1] W, [2] H, [7] types, [8]
/// players, [10] chunks wide.
#[no_mangle]
pub unsafe extern "C" fn k_spawn_spatial(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (list, xs, ys, own, upt, upty, lay, ca) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i8>(3), k.p::<i16>(4), k.p::<i8>(5), k.p::<u8>(6), k.p::<i32>(7));
    let (sptile, sepkey, seplay, sparea, spown, spep, sptype, mvon) = (k.p::<i32>(8), k.p::<u32>(9), k.p::<u8>(10), k.p::<i32>(11), k.p::<i8>(12), k.p::<i32>(13), k.p::<i16>(14), k.p::<u8>(15));
    let (cplx, tcnt, bcnt, dead) = (k.p::<i32>(16), k.p::<i32>(17), k.p::<i32>(18), k.p::<u8>(19));
    if list.is_null() || xs.is_null() || sptile.is_null() { return; }
    let (n, w, h, tl, ep, sch, sbl, nt, np, norm, cw, tb, tbw, bs, bcols, defer) = (k.i(0).max(0) as usize, k.i(1).max(1), k.i(2).max(1), k.i(3).max(1), k.i(4), k.i(5), k.i(6), k.i(7), k.i(8), k.i(9), k.i(10).max(1), k.i(11).max(1), k.i(12), k.i(13).max(1), k.i(14), k.i(15) != 0);
    for i in 0..n {
        let q = g(list, i);
        if q < 0 { continue; }
        let q = q as usize;
        if !dead.is_null() && g(dead, q) == 1 { continue; }
        let gx = (g(xs, q).div_euclid(tl)).max(0).min(w - 1);
        let gy = (g(ys, q).div_euclid(tl)).max(0).min(h - 1);
        let tile = gy * w + gx;
        let o = g(own, q) as i32;
        let ut = if upt.is_null() { -1 } else { g(upt, q) as i32 };
        let ty0 = if ut >= 0 && !upty.is_null() { g(upty, ut as usize) as i32 } else { -1 };
        let ty = if ty0 >= 0 && ty0 < nt { ty0 } else { norm };
        let ar = if ca.is_null() { -1 } else { g(ca, tile as usize) };
        s(sptile, q, tile); s(sepkey, q, tile as u32);
        if !seplay.is_null() { s(seplay, q, if ty >= 0 && ty < nt && !lay.is_null() { g(lay, ty as usize) } else { 0 }); }
        s(sparea, q, if ar >= 0 { ar } else { -1 }); s(spown, q, o as i8); s(spep, q, ep); s(sptype, q, ty as i16);
        if !mvon.is_null() { s(mvon, q, 0); }
        if defer || !(o >= 0 && o < np) { continue; }
        // (Chunks of one tile: the key is the tile, its chunk (gx, gy).)
        let key = tile;
        if !cplx.is_null() { let i2 = (key * sch + o) as usize; s(cplx, i2, g(cplx, i2) + 1); }
        let (cx, cy) = (key % cw, key / cw);
        if !tcnt.is_null() && ty >= 0 { let i2 = (((cy / tb) * tbw + cx / tb) * sbl + o * nt + ty) as usize; s(tcnt, i2, g(tcnt, i2) + 1); }
        if !bcnt.is_null() { let i2 = (((cy / bs) * bcols + cx / bs) * np + o) as usize; s(bcnt, i2, g(bcnt, i2) + 1); }
    }
}

/// sim_unit_state.js _simRelayoutIndex: after a relayout's moves, the unit
/// index's entries (sep.eslot [1], P[0] of them) name the new slots (rl.fwd
/// [0]: per slot its new one where rl.fst [7] is the step's stamp P[4]: never
/// cleared; P[1] its length), and the
/// by-changes listing by slot (ixd.k [2], ixd.id [3], ixd.own [4]; P[3] its
/// slots, 0: none) moves by the pairs (rl.pairs [6]: from, to; P[2] of them):
/// every source read first (scratch [5], 3 a pair), cleared, then written
/// at its target (swaps and cycles alike).
#[no_mangle]
pub unsafe extern "C" fn k_ixd_relayout(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (fwd, es, dk, did, down, scr, pairs, fst) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i8>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7));
    let stamp = k.i(4);
    let (listed, nf, np, ds) = (k.i(0).max(0) as usize, k.i(1).max(0), k.i(2).max(0) as usize, k.i(3).max(0));
    if fwd.is_null() || es.is_null() || fst.is_null() { return; }
    for p in 0..listed {
        let s = g(es, p);
        if s >= 0 && s < nf && g(fst, s as usize) == stamp { let t = g(fwd, s as usize); if t >= 0 { s_(es, p, t); } }
    }
    if dk.is_null() || did.is_null() || down.is_null() || scr.is_null() || pairs.is_null() || ds == 0 { return; }
    let ok = |x: i32| x >= 0 && x < ds;
    for i in 0..np {
        let f = g(pairs, 2 * i);
        if !ok(f) { continue; }
        let fu = f as usize;
        s_(scr, 3 * i, g(dk, fu)); s_(scr, 3 * i + 1, g(did, fu)); s_(scr, 3 * i + 2, g(down, fu) as i32);
    }
    for i in 0..np {
        let f = g(pairs, 2 * i);
        if !ok(f) { continue; }
        let fu = f as usize;
        s_(dk, fu, -1); s_(did, fu, 0); s_(down, fu, 0);
    }
    for i in 0..np {
        let (f, t) = (g(pairs, 2 * i), g(pairs, 2 * i + 1));
        if !ok(f) || !ok(t) { continue; }
        let tu = t as usize;
        s_(dk, tu, g(scr, 3 * i)); s_(did, tu, g(scr, 3 * i + 1)); s_(down, tu, g(scr, 3 * i + 2) as i8);
    }
}
#[inline(always)]
unsafe fn s_<T>(p: *mut T, i: usize, v: T) { *p.add(i) = v; }
