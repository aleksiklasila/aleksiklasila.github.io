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
    let qx=k.p::<f32>(9);let qy=k.p::<f32>(10);let qo=k.p::<i32>(11);let qt=k.p::<i32>(12);
    let qoff=k.p::<i32>(13);let areas=k.p::<i32>(14);let out=k.p::<i32>(15);
    let begin=chunk*k.i(1);let end=(begin+k.i(1)).min(k.i(0));
    for q in begin..end{
        let q=q as usize;let owner=*qo.add(q);let ty=*qt.add(q);
        let immune=if ty>=1&&ty<=4{1<<ty}else if ty==5{30}else{0};
        let affected=if ty>=1&&ty<=4{1<<(ty+4)}else if ty==6{512}else if ty==7{1024}else{0};
        let own=i32x4_splat((owner+128)<<16);let origin_x=f32x4_splat(*qx.add(q));let origin_y=f32x4_splat(*qy.add(q));
        let mut best=[-1i32;3];let mut distance=[f32::INFINITY;3];
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
                    let dx=f32x4_sub(f32x4_mul(f32x4_convert_i32x4(xx),f32x4_splat(0.125)),origin_x);
                    let dy=f32x4_sub(f32x4_mul(f32x4_convert_i32x4(yy),f32x4_splat(0.125)),origin_y);
                    // Four distances per vector, without square roots.
                    let dist:[f32;4]=core::mem::transmute(f32x4_add(f32x4_mul(dx,dx),f32x4_mul(dy,dy)));
                    let im=i32x4_bitmask(i32x4_ne(v128_and(m,i32x4_splat(immune)),i32x4_splat(0))) as i32;
                    let mut af=i32x4_ne(v128_and(m,i32x4_splat(affected)),i32x4_splat(0));
                    if ty==7{af=v128_and(af,i32x4_eq(u32x4_shr(m,24),i32x4_splat((owner+128)&255)));}
                    let af=i32x4_bitmask(af) as i32;
                    for lane in 0..n as usize{
                        if valid&(1<<lane)==0{continue;}
                        let class=if im&(1<<lane)!=0{2}else if af&(1<<lane)!=0{1}else{0};
                        let d=*dist.get_unchecked(lane);
                        if d<*distance.get_unchecked(class){*distance.get_unchecked_mut(class)=d;*best.get_unchecked_mut(class)=*slots.add(at+lane);}
                    }
                }
            }
        }
        *out.add(q)=if best[0]>=0{best[0]}else if best[1]>=0{best[1]}else{best[2]};
    }
}

/// Building fallback for due towers. Read the authoritative tile SoA and
/// immutable area-cell CSR directly; each job owns 32 adjacent output words.
/// Projectile resolution follows the whole tower pass, so these queries see
/// the same state as the former serial object walks.
#[no_mangle]
pub unsafe extern "C" fn k_tower_struct(a:u32,chunk:i32) {
    let k=K::new(waddr(a) as *const i32);
    let code=k.p::<u8>(0);let own=k.p::<i32>(1);let uc=k.p::<u8>(2);let energy=k.p::<f64>(3);let cls=k.p::<i8>(4);
    let off=k.p::<i32>(5);let cells=k.p::<i32>(6);let qx=k.p::<f32>(7);let qy=k.p::<f32>(8);
    let qo=k.p::<i32>(9);let qoff=k.p::<i32>(10);let areas=k.p::<i32>(11);let out=k.p::<i32>(12);let unit=k.p::<i32>(13);
    let base=k.p::<i32>(14);let tiles=k.p::<i32>(15);let idle=k.p::<i32>(16);
    let w=k.i(3);let tile=k.f(4) as f32;
    for q in chunk*k.i(1)..((chunk+1)*k.i(1)).min(k.i(0)) {
        let q=q as usize;*idle.add(q)=0;*out.add(q)=-1;if *unit.add(q)>=0 {continue;}
        let owner=*qo.add(q);let mut best=-1;let mut priority=4;let mut best_d=f32::INFINITY;
        let x=f32x4_splat(*qx.add(q));let y=f32x4_splat(*qy.add(q));
        let mut unsupported=false;
        for ai in *qoff.add(q)..*qoff.add(q+1) {
            let a=*areas.add(ai as usize) as usize;let mut i=*off.add(a);let end=*off.add(a+1);
            while i<end {
                let mut ts=[0usize;4];let mut ps=[4i32;4];let mut xs=[0f32;4];let mut ys=[0f32;4];
                let n=(end-i).min(4) as usize;
                for lane in 0..n {
                    let t=*cells.add(i as usize+lane) as usize;*ts.get_unchecked_mut(lane)=t;
                    let c=*cls.add(t);let o=*own.add(t);
                    if c==0||*code.add(t)==0||o==owner||!(*energy.add(t)>0.0){continue;}
                    let p=match c {1|5=>0,2=>1,3=>2,4=>3,_=>continue};
                    if p>priority||((p==1||p==3)&&(*uc.add(t)!=0||o<0)){continue;}
                    // Unspecified floor ownership needs the scalar cell fallback.
                    if (p==1||p==3)&&o==0x7ff9 {unsupported=true;continue;}
                    *ps.get_unchecked_mut(lane)=p;*xs.get_unchecked_mut(lane)=(t as i32%w) as f32*tile+16.0;*ys.get_unchecked_mut(lane)=(t as i32/w) as f32*tile+16.0;
                }
                let dx=f32x4_sub(v128_load(xs.as_ptr() as *const v128),x);
                let dy=f32x4_sub(v128_load(ys.as_ptr() as *const v128),y);
                let ds:[f32;4]=core::mem::transmute(f32x4_add(f32x4_mul(dx,dx),f32x4_mul(dy,dy)));
                for lane in 0..n {
                    let p=*ps.get_unchecked(lane);let t=*ts.get_unchecked(lane) as i32;let d=*ds.get_unchecked(lane);
                    if p==4 {continue;}
                    if p<priority||(p==priority&&(d<best_d||(d==best_d&&t<best))) {priority=p;best_d=d;best=t;}
                }
                i+=n as i32;
            }
        }
        *out.add(q)=if unsupported{-2}else{best};
        if !unsupported&&best<0&&*base.add(q)>0 {
            let b=*base.add(q);let period=b+1;
            *idle.add(q)=b+((*tiles.add(q)%period-(k.i(5)+period)).rem_euclid(period));
        }
    }
}

/// Stable tile order over dedicated contiguous scratch. Four streaming byte
/// passes replace comparator calls through paged structure accessors. The
/// source index retains stale wheel-entry identity and equal-key ordering.
#[no_mangle]
pub unsafe extern "C" fn k_tower_order(a:u32,_chunk:i32) {
    let k=K::new(waddr(a) as *const i32);let n=k.i(0) as usize;
    let keys=k.p::<u32>(0);let mut src=k.p::<i32>(1);let mut dst=k.p::<i32>(2);
    for i in 0..n {*src.add(i)=i as i32;}
    for shift in [0,8,16,24] {
        let mut hist=[0usize;256];
        for i in 0..n {let b=((*keys.add(*src.add(i) as usize)^0x80000000)>>shift)&255;hist[b as usize]+=1;}
        let mut sum=0;for c in hist.iter_mut(){let count=*c;*c=sum;sum+=count;}
        for i in 0..n {let s=*src.add(i);let b=(((*keys.add(s as usize)^0x80000000)>>shift)&255) as usize;*dst.add(hist[b])=s;hist[b]+=1;}
        core::mem::swap(&mut src,&mut dst);
    }
}

/// Broad phase over contiguous query rectangles. Unit blocks are conservative
/// exactly as the JS query; structure blocks use eight aligned tile bytes per
/// row, masked to the rectangle. No object access or area-list allocation.
#[no_mangle]
pub unsafe extern "C" fn k_tower_coarse(a:u32,chunk:i32) {
    let k=K::new(waddr(a) as *const i32);
    let boxes=k.p::<i32>(0);let own=k.p::<i32>(1);let live=k.p::<u32>(2);
    let units=k.p::<i32>(3);let blocks=k.p::<i32>(4);let codes=k.p::<i8>(5);
    let pc=k.i(2);let bw=k.i(3);let w=k.i(4);let bs=k.i(5);
    for q in chunk*k.i(1)..((chunk+1)*k.i(1)).min(k.i(0)) {
        let q=q as usize;*live.add(q)=0;let b=boxes.add(q*4);
        let (x0,y0,x1,y1)=(*b,*b.add(1),*b.add(2),*b.add(3));
        if x1<0 {continue;}
        let owner=*own.add(q);
        if owner<0||owner>=pc||bs!=8 { *live.add(q)=1;continue; }
        let mut hit=false;
        'scan:for by in y0/bs..=y1/bs {for bx in x0/bs..=x1/bs {
            let at=((by*bw+bx)*pc) as usize;
            for p in 0..pc {if p!=owner&&*units.add(at+p as usize)>0 {hit=true;break 'scan;}}
            if *blocks.add(at+owner as usize)<=0 {continue;}
            let lo=(x0-bx*8).max(0);let hi=(x1-bx*8).min(7);
            let mask=(((1u32<<(hi-lo+1))-1)<<lo) as i32;
            for y in y0.max(by*8)..=y1.min(by*8+7) {
                // The last partial map block has fewer than eight bytes.
                if bx*8+8>w {
                    for x in (bx*8+lo)..=(bx*8+hi) {let c=*codes.add((y*w+x) as usize);if c!=-1&&c!=owner as i8 {hit=true;break 'scan;}}
                } else {
                    let v=v128_load64_zero(codes.add((y*w+bx*8) as usize) as *const u64);
                    let hostile=v128_and(i8x16_ne(v,i8x16_splat(-1)),i8x16_ne(v,i8x16_splat(owner as i8)));
                    if i8x16_bitmask(hostile) as i32&mask!=0 {hit=true;break 'scan;}
                }
            }
        }}
        *live.add(q)=hit as u32;
    }
}
