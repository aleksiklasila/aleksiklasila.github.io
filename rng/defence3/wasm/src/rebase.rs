// Presentation only: keep newly received frames continuous with the last
// displayed frame. f64 arithmetic matches JavaScript before each f32 store.
#![no_std]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { core::arch::wasm32::unreachable() }

#[no_mangle]
pub unsafe extern "C" fn rebase(base: *mut f32, cap: usize, n: usize, old_n: usize, shown: f64, indexed: u32) -> f64 {
    let ids = base.add(4 * cap) as *const i32;
    let old_ids = base.add(9 * cap) as *const i32;
    let moving = base.add(10 * cap) as *mut u32;
    let mut count = 0;
    let mut pad = 0.0_f64;
    for s in 0..n {
        let x = *base.add(s) as f64;
        let y = *base.add(cap + s) as f64;
        if s < old_n && *ids.add(s) >= 0 && *ids.add(s) == *old_ids.add(s) {
            let px = *base.add(7 * cap + s) as f64;
            let py = *base.add(8 * cap + s) as f64;
            let rx = px + (*base.add(5 * cap + s) as f64 - px) * shown;
            let ry = py + (*base.add(6 * cap + s) as f64 - py) * shown;
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
    *(base.add(11 * cap) as *mut u32) = count as u32;
    pad
}
