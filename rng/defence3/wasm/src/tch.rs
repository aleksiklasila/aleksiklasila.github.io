//! Tile changes as a batch (unit.js simTileChangesRun): for each listed tile,
//! in order, what a change of its cell type or of its tile entity means for
//! the walk tables: the ground walls (mv.wall) with their block change counts
//! (mv.wallBlk, mv.wallBlk9), the step costs around it, the walk classes'
//! walls (flownav.js navClassTileChanged: collectors pass active mines, a
//! player's builders pass its own structures), and per navigation profile
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
/// P: [0] n, [1] W, [2] H, [3] TYPE_WALL, [4] profiles, [5] the collectors'
/// profile, [6] the first builders' profile, [7] blocks wide, [8]/[9] the
/// gold and A* mines' codes.
#[no_mangle]
pub unsafe extern "C" fn k_tile_changes(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (list, ctype, wall, blk, blk9, scost) = (k.p::<i32>(0), k.p::<u8>(1), k.p::<u8>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<u8>(5));
    let (diff, newest, cwt) = (k.p::<i32>(6), k.p::<i32>(7), k.p::<i32>(8));
    let (stcode, stown, stval) = (k.p::<u8>(9), k.p::<i32>(10), k.p::<f64>(11));
    let (hdr, nwl) = (k.p::<i32>(12), k.p::<i32>(13));
    let n = k.i(0).max(0) as usize;
    let (w, h) = (k.i(1).max(0) as u32, k.i(2).max(0) as u32);
    let twall = k.i(3) as u8;
    let np = k.i(4).clamp(0, 32) as usize;
    let (pcol, pb0) = (k.i(5).max(0) as usize, k.i(6).max(0) as usize);
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
        let mine_on = (code == mg || code == ma) && g(stval, tu) > 0.0;
        let own = if code != 0 { g(stown, tu) } else { -1 };
        let mut changed = false;
        for p in pcol..np {
            let cw = arr::<u8>(cwt, p);
            if cw.is_null() {
                continue;
            }
            let pass = if p == pcol { mine_on } else { code != 0 && own == (p - pb0) as i32 };
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

/// The path regions' labels follow the listed tiles' cell types
/// (pathfinding.js pathRegionsTileChanged, for each kept label set in
/// turn): an opened tile joins the regions around it (a new region when
/// none), a closed one is left out, and when its open 4-neighbours may have
/// come apart (more than one run of them in its ring) and no way around it
/// within the window joins them, the set is marked to be made again.
/// Arrays: [0] list (t * 2 + kind; kind 1 skipped), [1] cell types, [2]
/// ?the regions' wall copy, [3] the sets (4 words each: labels, parents
/// (encoded addresses), parents' length, next region), [4] out per set
/// (next, dirty, canon), [5] stamps (a tile each), [6] queue, [7] hdr ([0]
/// the stamps' counter, kept).
/// P: [0] n, [1] W, [2] H, [3] TYPE_WALL, [4] sets, [5] window radius.
#[no_mangle]
pub unsafe extern "C" fn k_reg_tiles(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (list, ctype, rwall, sets, out, stamp, q, hdr) = (k.p::<i32>(0), k.p::<u8>(1), k.p::<u8>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7));
    let n = k.i(0).max(0) as usize;
    let (w, h) = (k.i(1).max(0), k.i(2).max(0));
    let twall = k.i(3) as u8;
    let ns = k.i(4).max(0) as usize;
    let rad = k.i(5).max(0);
    let nt = w * h;
    let mut now = g(hdr, 0);
    for e in 0..ns {
        s(out, e * 3, g(sets, e * 4 + 3));
        s(out, e * 3 + 1, 0);
        s(out, e * 3 + 2, 0);
    }
    const RING: [i32; 16] = [0, -1, 1, -1, 1, 0, 1, 1, 0, 1, -1, 1, -1, 0, -1, -1];
    for i in 0..n {
        let en = g(list, i);
        if en < 0 || en & 1 != 0 {
            continue;
        }
        let t = en >> 1;
        if t >= nt || w == 0 {
            continue;
        }
        let gy = idiv(t, w);
        let gx = t - gy * w;
        let open = g(ctype, t as usize) != twall;
        if !rwall.is_null() {
            s(rwall, t as usize, if open { 0 } else { 1 });
        }
        for e in 0..ns {
            if g(out, e * 3 + 1) != 0 {
                continue;
            }
            let lab = waddr(g(sets, e * 4) as u32) as *mut i32;
            let par = waddr(g(sets, e * 4 + 1) as u32) as *mut i32;
            let plen = g(sets, e * 4 + 2);
            if open == (g(lab, t as usize) >= 0) {
                continue;
            }
            if open {
                let mut root = -1i32;
                for d in 0..4 {
                    let kk = match d { 0 => if gx > 0 { t - 1 } else { -1 }, 1 => if gx < w - 1 { t + 1 } else { -1 }, 2 => if gy > 0 { t - w } else { -1 }, _ => if gy < h - 1 { t + w } else { -1 } };
                    if kk < 0 || g(lab, kk as usize) < 0 {
                        continue;
                    }
                    let r = find(par, g(lab, kk as usize));
                    if root < 0 {
                        root = r;
                    } else if r != root {
                        if r < root { s(par, root as usize, r); root = r; } else { s(par, r as usize, root); }
                        s(out, e * 3 + 2, 1);
                    }
                }
                if root < 0 {
                    root = g(out, e * 3);
                    if root >= plen {
                        // (No room for a new region: made again.)
                        s(out, e * 3 + 1, 1);
                        continue;
                    }
                    s(out, e * 3, root + 1);
                    s(par, root as usize, root);
                }
                s(lab, t as usize, root);
            } else {
                s(lab, t as usize, -1);
                let (mut n4, mut first_closed) = (0, -1i32);
                let mut ring = [0u8; 8];
                for r in 0..8 {
                    let (x, y) = (gx + RING[2 * r], gy + RING[2 * r + 1]);
                    let o = x >= 0 && y >= 0 && x < w && y < h && g(lab, (y * w + x) as usize) >= 0;
                    ring[r] = o as u8;
                    if o && r & 1 == 0 { n4 += 1; }
                    if !o && first_closed < 0 { first_closed = r as i32; }
                }
                if n4 <= 1 || first_closed < 0 {
                    continue;
                }
                let (mut runs, mut has4) = (0, false);
                for kk in 1..=8 {
                    let r = ((first_closed + kk) & 7) as usize;
                    if ring[r] != 0 { if r & 1 == 0 { has4 = true; } } else { if has4 { runs += 1; } has4 = false; }
                }
                if runs > 1 {
                    // (A breadth-first search from one open neighbour, in the window, until it meets the others.)
                    now += 1;
                    if now >= 0x7fff_ffff {
                        for z in 0..nt as usize { s(stamp, z, 0); }
                        now = 1;
                    }
                    let (x0, y0, x1, y1) = ((gx - rad).max(0), (gy - rad).max(0), (gx + rad).min(w - 1), (gy + rad).min(h - 1));
                    let nb = [if gx > 0 { t - 1 } else { -1 }, if gx < w - 1 { t + 1 } else { -1 }, if gy > 0 { t - w } else { -1 }, if gy < h - 1 { t + w } else { -1 }];
                    let (mut want, mut start) = (0, -1i32);
                    for &kk in nb.iter() {
                        if kk >= 0 && g(lab, kk as usize) >= 0 {
                            if start < 0 { start = kk; } else { s(stamp, kk as usize, -now); want += 1; }
                        }
                    }
                    let mut joined = start < 0 || want == 0;
                    if !joined {
                        let (mut head, mut tail) = (0usize, 0usize);
                        s(stamp, start as usize, now);
                        s(q, tail, start);
                        tail += 1;
                        'bfs: while head < tail {
                            let kk = g(q, head);
                            head += 1;
                            let y = idiv(kk, w);
                            let x = kk - y * w;
                            for d in 0..4 {
                                let (nx, ny) = match d { 0 => (x - 1, y), 1 => (x + 1, y), 2 => (x, y - 1), _ => (x, y + 1) };
                                if nx < x0 || nx > x1 || ny < y0 || ny > y1 { continue; }
                                let m = (ny * w + nx) as usize;
                                let sm = g(stamp, m);
                                if sm == now || g(lab, m) < 0 { continue; }
                                if sm == -now {
                                    want -= 1;
                                    if want == 0 { joined = true; break 'bfs; }
                                }
                                s(stamp, m, now);
                                s(q, tail, m as i32);
                                tail += 1;
                            }
                        }
                    }
                    if !joined {
                        s(out, e * 3 + 1, 1);
                    }
                }
            }
        }
    }
    s(hdr, 0, now);
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
