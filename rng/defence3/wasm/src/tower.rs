//! Tower unit acquisition. A per-tick spatial-entry snapshot in SoA form,
//! shared by every due tower: contiguous coordinates and packed type/status
//! flags allow four candidates to be filtered together, with f64x2 distance
//! arithmetic matching JavaScript. Reduction retains the original visiting
//! order, including exact-distance ties and primary/affected/immune priority.
use super::*;
use super::k::K;

#[no_mangle]
pub unsafe extern "C" fn k_tower_pack(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let slots=k.p::<i32>(0);let x=k.p::<i32>(1);let y=k.p::<i32>(2);
    let dead=k.p::<u8>(3);let owner=k.p::<i8>(4);let types=k.p::<i16>(5);let flags=k.p::<u8>(6);
    let status=k.p::<i32>(7);let burn=k.p::<u16>(8);let wet=k.p::<u16>(9);let poison=k.p::<u16>(10);
    let frozen=k.p::<u16>(11);let sand=k.p::<u16>(12);let watched=k.p::<u16>(13);let watch_team=k.p::<i8>(14);
    let out_x=k.p::<i32>(15);let out_y=k.p::<i32>(16);let meta=k.p::<i32>(17);
    let start=chunk*k.i(1);let end=(start+k.i(1)).min(k.i(0));
    for i in start..end{
        let i=i as usize;let s=*slots.add(i);
        if s<0||*dead.add(s as usize)==1{*meta.add(i)=1<<11;continue;}
        let s=s as usize;let ty=*types.add(s) as i32;
        let mut m=if ty>=0&&ty<k.i(2){*flags.add(ty as usize) as i32}else{k.i(3)};
        let st=*status.add(s) as usize;
        if *burn.add(st)>0{m|=1<<5;}if *wet.add(st)>0{m|=1<<6;}if *poison.add(st)>0{m|=1<<7;}
        if *frozen.add(st)>0{m|=1<<8;}if *sand.add(st)>0{m|=1<<9;}if *watched.add(st)>0{m|=1<<10;}
        m|=((*owner.add(s) as i32+128)&255)<<16;
        // The high byte is the watch owner; it may set the sign bit, so
        // dead uses a separate bit below the owner bytes.
        m|=((*watch_team.add(s) as i32+128)&255)<<24;
        *out_x.add(i)=*x.add(s);*out_y.add(i)=*y.add(s);*meta.add(i)=m;
    }
}

#[no_mangle]
pub unsafe extern "C" fn k_tower_scan(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let x=k.p::<i32>(0);let y=k.p::<i32>(1);let meta=k.p::<i32>(2);let slots=k.p::<i32>(3);
    let starts=k.p::<i32>(4);let counts=k.p::<i32>(5);let stamps=k.p::<i32>(6);
    let cell_off=k.p::<i32>(7);let cells=k.p::<i32>(8);
    let qx=k.p::<f64>(9);let qy=k.p::<f64>(10);let qo=k.p::<i32>(11);let qt=k.p::<i32>(12);
    let qoff=k.p::<i32>(13);let areas=k.p::<i32>(14);let out=k.p::<i32>(15);
    let begin=chunk*k.i(1);let end=(begin+k.i(1)).min(k.i(0));
    for q in begin..end{
        let q=q as usize;let owner=*qo.add(q);let ty=*qt.add(q);
        let immune=if ty>=1&&ty<=4{1<<ty}else if ty==5{30}else{0};
        let affected=if ty>=1&&ty<=4{1<<(ty+4)}else if ty==6{512}else if ty==7{1024}else{0};
        let own=i32x4_splat((owner+128)<<16);let origin_x=f64x2_splat(*qx.add(q));let origin_y=f64x2_splat(*qy.add(q));
        let mut best=[-1i32;3];let mut distance=[f64::INFINITY;3];
        for ai in *qoff.add(q)..*qoff.add(q+1){
            let area=*areas.add(ai as usize) as usize;
            for ci in *cell_off.add(area)..*cell_off.add(area+1){
                let tile=*cells.add(ci as usize) as usize;
                if *stamps.add(tile)!=k.i(2){continue;}
                let mut j=*starts.add(tile);let limit=j+*counts.add(tile);
                while j<limit{
                    let n=(limit-j).min(4);let at=j as usize;j+=n;
                    // Buffers have four spare entries, so tail loads are safe;
                    // only the actual entries participate in the reduction.
                    let m=v128_load(meta.add(at) as *const v128);
                    let dead_or_immune=i32x4_ne(v128_and(m,i32x4_splat((1<<11)|1)),i32x4_splat(0));
                    let friendly=i32x4_eq(v128_and(m,i32x4_splat(255<<16)),own);
                    let valid=(!(i32x4_bitmask(v128_or(dead_or_immune,friendly)) as i32))&((1<<n)-1);
                    if valid==0{continue;}
                    let xx=v128_load(x.add(at) as *const v128);let yy=v128_load(y.add(at) as *const v128);
                    let dx0=f64x2_sub(f64x2_mul(f64x2_convert_low_i32x4(xx),f64x2_splat(0.125)),origin_x);
                    let dy0=f64x2_sub(f64x2_mul(f64x2_convert_low_i32x4(yy),f64x2_splat(0.125)),origin_y);
                    let dx1=f64x2_sub(f64x2_mul(f64x2_convert_low_i32x4(i32x4_shuffle::<2,3,2,3>(xx,xx)),f64x2_splat(0.125)),origin_x);
                    let dy1=f64x2_sub(f64x2_mul(f64x2_convert_low_i32x4(i32x4_shuffle::<2,3,2,3>(yy,yy)),f64x2_splat(0.125)),origin_y);
                    let d0:[f64;2]=core::mem::transmute(f64x2_sqrt(f64x2_add(f64x2_mul(dx0,dx0),f64x2_mul(dy0,dy0))));
                    let d1:[f64;2]=core::mem::transmute(f64x2_sqrt(f64x2_add(f64x2_mul(dx1,dx1),f64x2_mul(dy1,dy1))));
                    let im=i32x4_bitmask(i32x4_ne(v128_and(m,i32x4_splat(immune)),i32x4_splat(0))) as i32;
                    let mut af=i32x4_ne(v128_and(m,i32x4_splat(affected)),i32x4_splat(0));
                    if ty==7{af=v128_and(af,i32x4_eq(u32x4_shr(m,24),i32x4_splat((owner+128)&255)));}
                    let af=i32x4_bitmask(af) as i32;
                    for lane in 0..n as usize{
                        if valid&(1<<lane)==0{continue;}
                        let class=if im&(1<<lane)!=0{2}else if af&(1<<lane)!=0{1}else{0};
                        let d=if lane<2{*d0.get_unchecked(lane)}else{*d1.get_unchecked(lane-2)};
                        if d<*distance.get_unchecked(class){*distance.get_unchecked_mut(class)=d;*best.get_unchecked_mut(class)=*slots.add(at+lane);}
                    }
                }
            }
        }
        *out.add(q)=if best[0]>=0{best[0]}else if best[1]>=0{best[1]}else{best[2]};
    }
}
