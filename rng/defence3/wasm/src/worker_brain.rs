//! Worker brain batches over authoritative shared SoA. Each spatial job
//! owns whole cache lines; nearest-site decisions have private SIMD reductions.
use super::*;
use super::k::K;

#[no_mangle]
pub unsafe extern "C" fn k_worker_sites(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let code=k.p::<u8>(0);let owner=k.p::<i32>(1);let uc=k.p::<u8>(2);let en=k.p::<f64>(3);let brain=k.p::<u32>(4);
    let sites=k.p::<u16>(5);let cnt=k.p::<i32>(6);let any=k.p::<i32>(7);
    let np=k.i(6).max(0) as usize;let stride=k.i(7).max(16) as usize;
    if k.i(2)==1 {
        let own=chunk.max(0) as usize;if own>=np{return;}
        let mut mask=0;for b in 0..k.i(0).max(0) as usize {mask|=*cnt.add(b*stride+1+own);}
        *any.add(own*16)=mask;return;
    }
    let cols=k.i(5).max(1);let w=k.i(3).max(1);let h=k.i(4);
    for b in chunk*k.i(1)..((chunk+1)*k.i(1)).min(k.i(0)) {
        let b=b as usize;let c=cnt.add(b*stride);core::ptr::write_bytes(c,0,stride);
        let x0=(b as i32%cols)*8;let y0=(b as i32/cols)*8;let mut n=0;
        for y in y0..(y0+8).min(h){
            let mut x=x0;while x<(x0+8).min(w){
                let len=(w-x).min(4);let base=(y*w+x) as usize;
                // Tail words are read only inside the map; the last partial
                // block uses the scalar eligibility filter below.
                let bits=if len==4 {
                    let codes=u32x4_extend_low_u16x8(u16x8_extend_low_u8x16(v128_load32_zero(code.add(base) as *const u32)));
                    let unfinished=u32x4_extend_low_u16x8(u16x8_extend_low_u8x16(v128_load32_zero(uc.add(base) as *const u32)));
                    i32x4_bitmask(v128_and(i32x4_eq(codes,i32x4_splat(0x44)),i32x4_eq(unfinished,i32x4_splat(0)))) as u32
                }else{(1u32<<len)-1};
                for lane in 0..len as usize {
                    if bits&(1<<lane)==0 {continue;}let t=base+lane;
                    if *code.add(t)!=0x44||*uc.add(t)!=0||!(*en.add(t)>0.0){continue;}
                    let o=*owner.add(t);if o<0||o>=np as i32 {continue;}
                    let ty=(*brain.add(t)&65535) as i32;let mut kind= -1;
                    for q in 0..6 {if ty>0&&ty==k.i(16+q){kind=q as i32;break;}}
                    if kind<0 {continue;}
                    *sites.add(b*64+n)=((y-y0)*8+(x-x0)+lane as i32+(kind<<6)+(o<<9)) as u16;n+=1;*c.add(1+o as usize)|=1<<kind;
                }
                x+=4;
            }
        }
        *c=n as i32;
    }
}

#[inline(always)]
unsafe fn reduce4(x:v128,y:v128,mask:u32,ux:i32,uy:i32,w:i32,best:&mut i32,dist:&mut i32){
    if mask==0{return;}
    let dx=i32x4_abs(i32x4_sub(x,i32x4_splat(ux)));let dy=i32x4_abs(i32x4_sub(y,i32x4_splat(uy)));
    let distances:[i32;4]=core::mem::transmute(i32x4_add(dx,dy));let tiles:[i32;4]=core::mem::transmute(i32x4_add(i32x4_mul(y,i32x4_splat(w)),x));
    let mut bits=mask;while bits!=0{let lane=bits.trailing_zeros() as usize;bits&=bits-1;
        let t=*tiles.get_unchecked(lane);let d=*distances.get_unchecked(lane);if d<*dist||(d==*dist&&t<*best){*best=t;*dist=d;}
    }
}

#[inline(always)]
unsafe fn visit(k:&K,bx:i32,by:i32,owner:i32,kind:i32,ux:i32,uy:i32,best:&mut i32,dist:&mut i32){
    let b=(by*k.i(5)+bx) as usize;
    let stride=k.i(7).max(16) as usize;let cnt=k.p::<i32>(10).add(b*stride);
    if *cnt.add(1+owner as usize)&(1<<kind)==0 {return;}
    let list=k.p::<u16>(9).add(b*64);let n=*cnt as usize;let w=k.i(3).max(1);
    let mut first=0;while first<n {
        // Eight compact stationary records, one 16-byte load. The packed
        // local coordinates eliminate divisions and random tile-table gathers.
        let len=(n-first).min(8);let v=v128_load(list.add(first) as *const v128);
        let mask=(i16x8_bitmask(i16x8_eq(u16x8_shr(v,6),i16x8_splat((owner*8+kind) as i16))) as u32)&((1<<len)-1);
        if mask!=0 {
            let xx=v128_and(v,i16x8_splat(7));let yy=v128_and(u16x8_shr(v,3),i16x8_splat(7));
            let x0=i32x4_splat(bx*8);let y0=i32x4_splat(by*8);
            reduce4(i32x4_add(u32x4_extend_low_u16x8(xx),x0),i32x4_add(u32x4_extend_low_u16x8(yy),y0),mask&15,ux,uy,w,best,dist);
            reduce4(i32x4_add(u32x4_extend_high_u16x8(xx),x0),i32x4_add(u32x4_extend_high_u16x8(yy),y0),mask>>4,ux,uy,w,best,dist);
        }
        first+=8;
    }
}

#[no_mangle]
pub unsafe extern "C" fn k_worker_spawners(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let events=k.p::<i32>(0);let wk=k.p::<u8>(1);let wi=k.p::<i32>(2);let wt=k.p::<u8>(3);let tick=k.p::<i32>(4);let out=k.p::<i32>(5);
    let x=k.p::<i32>(6);let y=k.p::<i32>(7);let owner=k.p::<i8>(8);let any=k.p::<i32>(11);
    let w=k.i(3).max(1);let h=k.i(4);let cols=k.i(5).max(1);let rows=(h+7)/8;
    for q in chunk*k.i(1)..((chunk+1)*k.i(1)).min(k.i(0)) {
        let s=(*events.add(q as usize)>>3) as usize;if *wk.add(s)==0 {continue;}
        let rec=*wi.add(s);if rec<=0 {continue;}let rec=rec as usize;*tick.add(rec)=-1;
        // These brains cannot consume a return-site decision in this pass:
        // their transfer timer is running, or the work-search tier owns them.
        if *k.p::<u16>(14).add(s)>0||*k.p::<u8>(15).add(s)!=0 {continue;}
        let kind=*wt.add(rec) as i32-1;let own=*owner.add(s) as i32;
        if kind<0||kind>=6||own<0||own>=k.i(6){continue;}
        let ux=floor(*x.add(s) as f64/k.f(8)) as i32;let uy=floor(*y.add(s) as f64/k.f(8)) as i32;
        if ux<0||uy<0||ux>=w||uy>=h {continue;}
        let mut best= -1;let mut distance=i32::MAX;
        if *any.add(own as usize*16)&(1<<kind)!=0 {
            let cx=ux/8;let cy=uy/8;
            for r in 0..cols.max(rows) {
                let x0=(cx-r).max(0);let x1=(cx+r).min(cols-1);let y0=(cy-r).max(0);let y1=(cy+r).min(rows-1);
                if cy-r>=0 {for bx in x0..=x1 {visit(&k,bx,cy-r,own,kind,ux,uy,&mut best,&mut distance);}}
                if r>0&&cy+r<rows {for bx in x0..=x1 {visit(&k,bx,cy+r,own,kind,ux,uy,&mut best,&mut distance);}}
                for by in (cy-r+1).max(0)..=(cy+r-1).min(rows-1) {
                    if cx-r>=0 {visit(&k,cx-r,by,own,kind,ux,uy,&mut best,&mut distance);}
                    if r>0&&cx+r<cols {visit(&k,cx+r,by,own,kind,ux,uy,&mut best,&mut distance);}
                }
                let outside=(if x0>0 {ux-x0*8+1}else{i32::MAX}).min(if x1<cols-1{(x1+1)*8-ux}else{i32::MAX})
                    .min(if y0>0{uy-y0*8+1}else{i32::MAX}).min(if y1<rows-1{(y1+1)*8-uy}else{i32::MAX});
                if outside==i32::MAX||outside>distance {break;}
            }
        }
        *out.add(rec)=best;*tick.add(rec)=k.i(2);
    }
}
