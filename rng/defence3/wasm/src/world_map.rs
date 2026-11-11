//! Canonical map topology. All per-tile traversal and scratch storage live
//! in WASM; callers publish area metadata only once the layout is complete.
use super::k::K;
use super::waddr;

/// type, owner, area, stable tile handles (tile + 1; zero is absent).
#[no_mangle]
pub unsafe extern "C" fn k_map_init(a: u32, _: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ty, owner, area, handles) = (k.p::<u8>(0), k.p::<i8>(1), k.p::<i32>(2), k.p::<i32>(3));
    for t in 0..k.i(0).max(0) as usize {
        *ty.add(t) = k.i(1) as u8; *owner.add(t) = -1;
        *area.add(t) = -1; *handles.add(t) = t as i32 + 1;
    }
}

/// Expand a scene's terrain run stream directly into the canonical columns.
/// type, owner, area, runs; P: first tile, run words, tile capacity.
#[no_mangle]
pub unsafe extern "C" fn k_map_terrain(a: u32, _: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ty, own, ar, runs) = (k.p::<u8>(0), k.p::<i8>(1), k.p::<i32>(2), k.p::<i32>(3));
    let mut t = k.i(0).max(0) as usize;
    let cap = k.i(2).max(0) as usize;
    for i in (0..k.i(1).max(0) as usize).step_by(4) {
        let end = t.saturating_add((*runs.add(i + 3)).max(0) as usize).min(cap);
        while t < end {
            *ty.add(t) = *runs.add(i) as u8;
            *own.add(t) = *runs.add(i + 1) as i8;
            *ar.add(t) = *runs.add(i + 2); t += 1;
        }
    }
}

/// Gather tiles for a query's area IDs without recreating coordinate rows.
/// IDs, offsets, tiles, output, count. P: number of IDs.
#[no_mangle]
pub unsafe extern "C" fn k_map_gather(a: u32, _: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (ids, off, tiles, out, count) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4));
    let mut used = 0usize;
    for i in 0..k.i(0).max(0) as usize {
        let id = *ids.add(i) as usize;
        for j in *off.add(id)..*off.add(id + 1) {
            *out.add(used) = *tiles.add(j as usize); used += 1;
        }
    }
    *count = used as i32;
}

fn random(s: &mut u32) -> f64 {
    *s = s.wrapping_add(0x6d2b79f5);
    let mut t = (*s ^ (*s >> 15)).wrapping_mul(1 | *s);
    t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
    (t ^ (t >> 14)) as f64 / 4294967296.0
}

/// type, area, offsets, tiles, bounds, visited, queue, result.
/// P: width, height, RNG state. Result: area count, final RNG state.
#[no_mangle]
pub unsafe extern "C" fn k_map_generate(a: u32, _: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (w, h) = (k.i(0).max(1) as usize, k.i(1).max(0) as usize);
    let (ty, ar, off, tiles, bounds, visited, queue, result) =
        (k.p::<u8>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3),
         k.p::<i32>(4), k.p::<u8>(5), k.p::<i32>(6), k.p::<u32>(7));
    core::ptr::write_bytes(visited, 0, w * h);
    let mut seed = k.f(2) as i64 as u32;
    let (mut count, mut used) = (0usize, 0usize);
    for start in 0..w * h {
        if *visited.add(start) != 0 { continue; }
        let target = 5 + (random(&mut seed) * 8.0) as usize;
        let (mut head, mut tail) = (0usize, 1usize);
        *queue = start as i32;
        *visited.add(start) = 1;
        *off.add(count) = used as i32;
        let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
        while head < tail && used - (*off.add(count) as usize) < target {
            let t = *queue.add(head) as usize; head += 1;
            *tiles.add(used) = t as i32; used += 1;
            *ar.add(t) = count as i32;
            let (x, y) = (t % w, t / w);
            x0 = x0.min(x); y0 = y0.min(y); x1 = x1.max(x); y1 = y1.max(y);
            let mut dirs = 0x3210u32;
            for i in (1..4).rev() {
                let j = (random(&mut seed) * (i + 1) as f64) as u32;
                let (a, b) = ((dirs >> (i * 4)) & 15, (dirs >> (j * 4)) & 15);
                dirs ^= (a ^ b) << (i * 4); dirs ^= (a ^ b) << (j * 4);
            }
            for i in 0..4 {
                let d = (dirs >> (i * 4)) & 15;
                let next = match d {
                    0 if y + 1 < h => t + w,
                    1 if y > 0 => t - w,
                    2 if x + 1 < w => t + 1,
                    3 if x > 0 => t - 1,
                    _ => continue,
                };
                if *visited.add(next) == 0 && *ty.add(next) == *ty.add(start) {
                    *visited.add(next) = 1; *queue.add(tail) = next as i32; tail += 1;
                }
            }
        }
        for i in head..tail { *visited.add(*queue.add(i) as usize) = 0; }
        let b = bounds.add(count * 4);
        *b = x0 as i32; *b.add(1) = y0 as i32; *b.add(2) = x1 as i32; *b.add(3) = y1 as i32;
        count += 1;
    }
    *off.add(count) = used as i32;
    *result = count as u32; *result.add(1) = seed;
}

/// Reconcile an imported CSR, derive bounds and sorted unique neighbours.
/// area, offsets, tiles, exists, bounds, neighbour offsets, neighbours,
/// scratch offsets, scratch neighbours, stamps. Scratch neighbours: 4*N.
/// P: width, height, area count. Absent area records retain their grid IDs,
/// but have empty outgoing lists, matching the snapshot topology contract.
#[no_mangle]
pub unsafe extern "C" fn k_map_topology(a: u32, _: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (w, h, n) = (k.i(0).max(1) as usize, k.i(1).max(0) as usize, k.i(2).max(0) as usize);
    let (ar, off, tiles, exists, bounds, noff, nb, tmpoff, tmp, stamp) =
        (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<u8>(3),
         k.p::<i32>(4), k.p::<i32>(5), k.p::<i32>(6), k.p::<i32>(7),
         k.p::<i32>(8), k.p::<i32>(9));
    for id in 0..n {
        let (mut x0, mut y0, mut x1, mut y1) = (w as i32, h as i32, -1, -1);
        for i in *off.add(id)..*off.add(id + 1) {
            let t = *tiles.add(i as usize);
            if t < 0 || t as usize >= w * h { continue; }
            *ar.add(t as usize) = id as i32;
            let (x, y) = (t % w as i32, t / w as i32);
            x0 = x0.min(x); y0 = y0.min(y); x1 = x1.max(x); y1 = y1.max(y);
        }
        let b = bounds.add(id * 4);
        *b = x0; *b.add(1) = y0; *b.add(2) = x1; *b.add(3) = y1;
    }
    core::ptr::write_bytes(tmpoff, 0, n + 1);
    // Two passes: degree counts, then directed edge scatter. Visit all four
    // directions so each source writes its own bucket only.
    for pass in 0..2 {
        for t in 0..w * h {
            let id = *ar.add(t);
            if id < 0 || id as usize >= n { continue; }
            let (x, y) = (t % w, t / w);
            for d in 0..4 {
                let q = match d { 0 if x + 1 < w => t + 1, 1 if y + 1 < h => t + w,
                    2 if x > 0 => t - 1, 3 if y > 0 => t - w, _ => continue };
                let other = *ar.add(q);
                if other < 0 || other as usize >= n || other == id { continue; }
                if pass == 0 { *tmpoff.add(id as usize + 1) += 1; }
                else { let p = noff.add(id as usize); *tmp.add(*p as usize) = other; *p += 1; }
            }
        }
        if pass == 0 {
            for id in 0..n { *tmpoff.add(id + 1) += *tmpoff.add(id); *noff.add(id) = *tmpoff.add(id); }
        }
    }
    core::ptr::write_bytes(stamp, 0, n);
    let mut used = 0usize;
    for id in 0..n {
        *noff.add(id) = used as i32;
        if *exists.add(id) == 0 { continue; }
        let begin = used;
        for j in *tmpoff.add(id)..*tmpoff.add(id + 1) {
            let other = *tmp.add(j as usize) as usize;
            if *stamp.add(other) != id as i32 + 1 {
                *stamp.add(other) = id as i32 + 1; *nb.add(used) = other as i32; used += 1;
            }
        }
        core::slice::from_raw_parts_mut(nb.add(begin), used - begin).sort_unstable();
    }
    *noff.add(n) = used as i32;
}
