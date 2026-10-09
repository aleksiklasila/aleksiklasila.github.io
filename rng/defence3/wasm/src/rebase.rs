// Presentation only: keep newly received frames continuous with the last
// displayed frame. f64 arithmetic matches JavaScript before each f32 store.
#![no_std]
use core::arch::wasm32::*;
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { core::arch::wasm32::unreachable() }

#[no_mangle]
pub unsafe extern "C" fn rebase(base: *mut f32, old: *const f32, cap: usize, n: usize, old_n: usize, shown: f64, indexed: u32) -> f64 {
    let ids = base.add(4 * cap) as *const i32;
    let old_ids = old.add(4 * cap) as *const i32;
    let moving = base.add(5 * cap) as *mut u32;
    let mut count = 0;
    let mut pad = 0.0_f64;
    let end=n.min(old_n);
    let mut s=0;
    let mut bound=f64x2_splat(0.0);
    let alpha=f64x2_splat(shown);
    while s+2<=end {
        let id=v128_load64_zero(ids.add(s).cast());
        let oid=v128_load64_zero(old_ids.add(s).cast());
        let valid=v128_and(i32x4_eq(id,oid),i32x4_ge(id,i32x4_splat(0)));
        let valid64=i64x2_extend_low_i32x4(valid);
        let x=v128_load64_zero(base.add(s).cast());
        let y=v128_load64_zero(base.add(cap+s).cast());
        let px=f64x2_promote_low_f32x4(v128_load64_zero(old.add(2*cap+s).cast()));
        let py=f64x2_promote_low_f32x4(v128_load64_zero(old.add(3*cap+s).cast()));
        let ox=f64x2_promote_low_f32x4(v128_load64_zero(old.add(s).cast()));
        let oy=f64x2_promote_low_f32x4(v128_load64_zero(old.add(cap+s).cast()));
        let rx=f64x2_add(px,f64x2_mul(f64x2_sub(ox,px),alpha));
        let ry=f64x2_add(py,f64x2_mul(f64x2_sub(oy,py),alpha));
        let out_x=v128_bitselect(f32x4_demote_f64x2_zero(rx),v128_load64_zero(base.add(2*cap+s).cast()),valid);
        let out_y=v128_bitselect(f32x4_demote_f64x2_zero(ry),v128_load64_zero(base.add(3*cap+s).cast()),valid);
        v128_store64_lane::<0>(out_x,base.add(2*cap+s).cast());
        v128_store64_lane::<0>(out_y,base.add(3*cap+s).cast());
        if indexed!=0 {
            bound=f64x2_max(bound,v128_and(f64x2_abs(f64x2_sub(rx,f64x2_promote_low_f32x4(x))),valid64));
            bound=f64x2_max(bound,v128_and(f64x2_abs(f64x2_sub(ry,f64x2_promote_low_f32x4(y))),valid64));
        }
        let moved=i32x4_bitmask(v128_or(f32x4_ne(out_x,x),f32x4_ne(out_y,y)));
        if moved&1!=0 {*moving.add(count)=s as u32;count+=1;}
        if moved&2!=0 {*moving.add(count)=(s+1) as u32;count+=1;}
        s+=2;
    }
    if indexed!=0 {pad=f64x2_extract_lane::<0>(bound).max(f64x2_extract_lane::<1>(bound));}
    for s in s..n {
        let x = *base.add(s) as f64;
        let y = *base.add(cap + s) as f64;
        if s < old_n && *ids.add(s) >= 0 && *ids.add(s) == *old_ids.add(s) {
            let px = *old.add(2 * cap + s) as f64;
            let py = *old.add(3 * cap + s) as f64;
            let rx = px + (*old.add(s) as f64 - px) * shown;
            let ry = py + (*old.add(cap + s) as f64 - py) * shown;
            *base.add(2 * cap + s) = rx as f32;
            *base.add(3 * cap + s) = ry as f32;
            if indexed != 0 {
                pad = pad.max((rx - x).abs()).max((ry - y).abs());
            }
        }
        if *base.add(2 * cap + s) as f64 != x || *base.add(3 * cap + s) as f64 != y {
            *moving.add(count) = s as u32;
            count += 1;
        }
    }
    *(base.add(6 * cap) as *mut u32) = count as u32;
    pad
}
