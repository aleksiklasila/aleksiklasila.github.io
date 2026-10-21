//! Coarse crowd pressure. Frozen 4x4-tile density/intent inputs, Jacobi
//! diffusion on helpers, fixed-lag publication. No identity/neighbor scans.
use super::*;
#[inline(always)]
unsafe fn ptr<T>(c:*const i32,i:usize)->*mut T {waddr(*c.add(i) as u32) as *mut T}
#[inline(always)]
unsafe fn args(a:u32)->(*const i32,*const f64,*const i32){
    let a=waddr(a) as *const i32;(a,(a as usize+4096) as *const f64,waddr(*a.add(512) as u32) as *const i32)
}
#[inline(always)]
unsafe fn range(f:*const f64,chunk:i32)->(usize,usize){
    let n=*f as usize;let per=*f.add(1) as usize;let start=(chunk.max(0) as usize*per).min(n);(start,(start+per).min(n))
}
pub(super) unsafe fn clear_job(c:*const i32,x0:i32,y0:i32,x1:i32,y1:i32){
    if c.is_null()||*c<2{return;}
    let w=*c.add(1);let h=*c.add(2);let shift=*c.add(3);
    for l in 0..*c.add(4){for y in (y0>>shift).max(0)..(((y1-1)>>shift)+1).min(h){
        for x in (x0>>shift).max(0)..(((x1-1)>>shift)+1).min(w){
            let k=((l*h+y)*w+x) as usize;
            *ptr::<i32>(c,18).add(k)=0;*ptr::<i32>(c,19).add(k)=0;*ptr::<i32>(c,29).add(k)=0;
        }
    }}
}
pub(super) unsafe fn deposit(c:*const i32,x:i32,y:i32,layer:i32,mass:i32,dx:f64,dy:f64,loss:f64,dk:f64){
    if c.is_null()||*c<2{return;}
    let w=*c.add(1);let h=*c.add(2);let gx=x>>*c.add(3);let gy=y>>*c.add(3);
    if gx<0||gy<0||gx>=w||gy>=h{return;}
    let k=((layer*h+gy)*w+gx) as usize;
    for (i,v) in [(18,dx),(19,dy),(29,loss)]{
        let p=ptr::<i32>(c,i).add(k);*p=(*p).saturating_add(js_round(v/dk*mass as f64) as i32);
    }
}
pub(super) unsafe fn sample(c:*const i32,x:i32,y:i32,layer:i32)->(f64,f64){
    if c.is_null()||*c<2||*c.add(5)==0{return (0.0,0.0);}
    let w=*c.add(1);let h=*c.add(2);let shift=*c.add(3);let half=1<<(shift-1);
    let ux=(x-half).max(0);let uy=(y-half).max(0);
    let gx=(ux>>shift).min(w-1);let gy=(uy>>shift).min(h-1);
    let gx1=(gx+1).min(w-1);let gy1=(gy+1).min(h-1);
    let mask=ptr::<u8>(c,32);
    if !mask.is_null()&&*mask.add(((layer*h+gy)*w+gx) as usize)==0{return (0.0,0.0);}
    let fx=(ux&((1<<shift)-1)) as f64/(1<<shift) as f64;
    let fy=(uy&((1<<shift)-1)) as f64/(1<<shift) as f64;
    let sample=|i|{let p=ptr::<f32>(c,i);let a=*p.add(((layer*h+gy)*w+gx) as usize) as f64;
        let b=*p.add(((layer*h+gy)*w+gx1) as usize) as f64;let d=*p.add(((layer*h+gy1)*w+gx) as usize) as f64;
        let e=*p.add(((layer*h+gy1)*w+gx1) as usize) as f64;
        (a+(b-a)*fx)*(1.0-fy)+(d+(e-d)*fx)*fy};
    (sample(16),sample(17))
}
#[no_mangle]
pub unsafe extern "C" fn traffic_capture(a:u32,chunk:i32){
    let (a,f,c)=args(a);let (start,end)=range(f,chunk);
    let bits=waddr(*a.add(513) as u32) as *const u32;let wall=waddr(*a.add(514) as u32) as *const u8;
    let w=*c.add(1);let h=*c.add(2);let stride=*c.add(6);let rows=*c.add(7);
    let gw=*c.add(8);let gh=*c.add(9);
    for k in start..end{
        let x=irem(k as i32,w);let y=irem(idiv(k as i32,w),h);let l=idiv(k as i32,w*h);
        let mut sum=i32x4_splat(0);let mut yy=y*32;
        let maxy=((y+1)*32).min(rows);
        while yy+4<=maxy{
            let p=bits.add(((l*rows+yy)*stride+x) as usize);
            let v=u32x4(*p,*p.add(stride as usize),*p.add(stride as usize*2),*p.add(stride as usize*3));
            let bytes=i8x16_popcnt(v);let pairs=i16x8_extadd_pairwise_u8x16(bytes);sum=i32x4_add(sum,i32x4_extadd_pairwise_u16x8(pairs));yy+=4;
        }
        sum=i32x4_add(sum,i32x4_shuffle::<2,3,0,1>(sum,sum));sum=i32x4_add(sum,i32x4_shuffle::<1,0,3,2>(sum,sum));
        let mut occupied=i32x4_extract_lane::<0>(sum);
        while yy<maxy{occupied+=(*bits.add(((l*rows+yy)*stride+x) as usize)).count_ones() as i32;yy+=1;}
        let mut floor=0;
        for ty in y*4..((y+1)*4).min(gh){for tx in x*4..((x+1)*4).min(gw){if wall.is_null()||*wall.add((ty*gw+tx) as usize)==0{floor+=1;}}}
        let rho=occupied as f32/1024.0;let cap=floor as f32/16.0;
        *ptr::<f32>(c,22).add(k)=rho;*ptr::<f32>(c,25).add(k)=cap;
        let ix=*ptr::<i32>(c,18).add(k);let iy=*ptr::<i32>(c,19).add(k);let loss=*ptr::<i32>(c,29).add(k);
        *ptr::<i32>(c,20).add(k)=ix;*ptr::<i32>(c,21).add(k)=iy;*ptr::<i32>(c,30).add(k)=loss;
        let demand=((ix.abs() as f32+iy.abs() as f32+loss as f32)/8192.0).min(2.0);
        let jam=(loss as f32/8192.0).min(2.0);
        *ptr::<f32>(c,26).add(k)=if cap>0.0{(rho-cap*0.35).max(0.0)*demand*32.0+jam*16.0}else{0.0};
        *ptr::<f32>(c,23).add(k)=0.0;*ptr::<f32>(c,24).add(k)=0.0;
    }
}
#[no_mangle]
pub unsafe extern "C" fn traffic_solve(a:u32,chunk:i32){
    let (_,f,c)=args(a);let (start,end)=range(f,chunk);
    let w=*c.add(1) as usize;let h=*c.add(2) as usize;let stage=*f.add(2) as usize;
    let src=ptr::<f32>(c,23+(stage&1));let dst=ptr::<f32>(c,24-(stage&1));
    let cap=ptr::<f32>(c,25);let rhs=ptr::<f32>(c,26);let zero=f32x4_splat(0.0);
    let mut k=start;
    while k<end{
        let x=irem(k as i32,w as i32) as usize;let y=irem(idiv(k as i32,w as i32),h as i32) as usize;
        if k+4<=end&&x>0&&x+4<w{
            let center=v128_load(src.add(k) as *const v128);let mut sum=v128_load(rhs.add(k) as *const v128);
            for nk in [k-1,k+1,if y>0{k-w}else{k},if y+1<h{k+w}else{k}]{
                let open=f32x4_gt(v128_load(cap.add(nk) as *const v128),zero);
                sum=f32x4_add(sum,v128_bitselect(v128_load(src.add(nk) as *const v128),center,open));
            }
            let valid=f32x4_gt(v128_load(cap.add(k) as *const v128),zero);
            v128_store(dst.add(k) as *mut v128,v128_and(f32x4_mul(sum,f32x4_splat(0.2425)),valid));k+=4;
        }else{
            let mut sum=*rhs.add(k);for nk in [if x>0{k-1}else{k},if x+1<w{k+1}else{k},if y>0{k-w}else{k},if y+1<h{k+w}else{k}]{sum+=if *cap.add(nk)>0.0{*src.add(nk)}else{*src.add(k)};}
            *dst.add(k)=if *cap.add(k)>0.0{sum*0.2425}else{0.0};k+=1;
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn traffic_output(a:u32,chunk:i32){
    let (_,f,c)=args(a);let (start,end)=range(f,chunk);let w=*c.add(1) as usize;let h=*c.add(2) as usize;
    let p=ptr::<f32>(c,23);let rho=ptr::<f32>(c,22);let cap=ptr::<f32>(c,25);
    let ix=ptr::<i32>(c,20);let iy=ptr::<i32>(c,21);
    for k in start..end{
        let x=irem(k as i32,w as i32) as usize;let y=irem(idiv(k as i32,w as i32),h as i32) as usize;let left=if x>0{k-1}else{k};let right=if x+1<w{k+1}else{k};
        let up=if y>0{k-w}else{k};let down=if y+1<h{k+w}else{k};
        let mut fx=0.0;let mut fy=0.0;
        if *cap.add(k)>0.0{
            let pressure=|j|if *cap.add(j)>0.0{*p.add(j)}else{*p.add(k)};
            fx=(pressure(left)-pressure(right))*0.2;fy=(pressure(up)-pressure(down))*0.2;
            let mut mx=0.0;let mut my=0.0;
            for j in [k,k,left,right,up,down]{let den=(*rho.add(j)*8192.0).max(64.0);mx+=*ix.add(j) as f32/den;my+=*iy.add(j) as f32/den;}
            let gain=((*rho.add(k)-0.2)*3.0).max(0.0).min(1.0);
            fx+=mx*0.25*gain;fy+=my*0.25*gain;
        }
        *ptr::<f32>(c,27).add(k)=fx.max(-8.0).min(8.0);
        *ptr::<f32>(c,28).add(k)=fy.max(-8.0).min(8.0);
    }
}
#[no_mangle]
pub unsafe extern "C" fn traffic_mask(a:u32,chunk:i32){
    let (_,f,c)=args(a);let (start,end)=range(f,chunk);let w=*c.add(1) as usize;let h=*c.add(2) as usize;
    let xx=ptr::<f32>(c,27);let yy=ptr::<f32>(c,28);let mask=ptr::<u8>(c,33);
    for k in start..end{
        let x=irem(k as i32,w as i32) as usize;let y=irem(idiv(k as i32,w as i32),h as i32) as usize;
        let right=if x+1<w{k+1}else{k};let down=if y+1<h{k+w}else{k};let diag=down+right-k;
        let mut nz=false;for j in [k,right,down,diag]{nz|=*xx.add(j)!=0.0||*yy.add(j)!=0.0;}
        *mask.add(k)=nz as u8;
    }
}
