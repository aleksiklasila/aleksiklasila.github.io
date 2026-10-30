//! The occupancy movement's jobs (sim_occupancy.js occupancyJobs): per phase
//! (2x2 block parity) its blocks with units, heaviest first (load balance
//! only: a phase's blocks touch disjoint cells, their order decides nothing),
//! and the outputs of the empty blocks cleared.
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

/// k_occ_jobs. Arrays: [0] occ.offsets (a block's first unit, blocks + 1),
/// [1] out: jobs ([0..3] each phase's first, [4..7] its count, from 8 the
/// blocks), [2] post counts, [3] ?separation counts, [4] ?chFix (W a block,
/// its last word cleared), [5] occ.xswap (stride P[3], its first word
/// cleared). P: [0] blocks wide, [1] high, [2] W, [3] xswap stride.
/// Heaviest first by the count's power of two (a counting sort, 32 bins),
/// then by block.
#[no_mangle]
pub unsafe extern "C" fn k_occ_jobs(a: u32, _chunk: i32) {
    let k = K::new(waddr(a) as *const i32);
    let (f, jo, postc, sexc, chfix, xsw) = (k.p::<i32>(0), k.p::<i32>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<f64>(4), k.p::<i32>(5));
    let (bw, bh, w, xk) = (k.i(0).max(0), k.i(1).max(0), k.i(2).max(0) as usize, k.i(3).max(0) as usize);
    let mut n = 8usize;
    for p in 0..4i32 {
        s(jo, p as usize, (n - 8) as i32);
        let mut hist = [0i32; 33];
        // Counts by bin (bin 32 - log2: heaviest bin first), the empty cleared.
        let mut by = p >> 1;
        while by < bh {
            let mut bx = p & 1;
            while bx < bw {
                let j = (by * bw + bx) as usize;
                let c = g(f, j + 1) - g(f, j);
                if c > 0 {
                    hist[(c as u32).leading_zeros() as usize] += 1;
                } else {
                    s(postc, j, 0);
                    if !sexc.is_null() { s(sexc, j, 0); }
                    if !chfix.is_null() && w > 0 { s(chfix, j * w + w - 1, 0.0); }
                    s(xsw, j * xk, 0);
                }
                bx += 2;
            }
            by += 2;
        }
        let mut at = [0usize; 33];
        let mut m = 0usize;
        for b in 0..33 {
            at[b] = n + m;
            m += hist[b] as usize;
        }
        let mut by = p >> 1;
        while by < bh {
            let mut bx = p & 1;
            while bx < bw {
                let j = (by * bw + bx) as usize;
                let c = g(f, j + 1) - g(f, j);
                if c > 0 {
                    let b = (c as u32).leading_zeros() as usize;
                    s(jo, at[b], j as i32);
                    at[b] += 1;
                }
                bx += 2;
            }
            by += 2;
        }
        s(jo, 4 + p as usize, m as i32);
        n += m;
    }
}
