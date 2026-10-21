//! Experimental exclusive raster occupancy. Phased spatial blocks own their
//! units; halos (including a complete packed word) do not overlap per phase.
use super::*;

struct Grid { bits:*mut u32, mask:*const i8, w:i32, h:i32, stride:i32, plane:i32, cell:i32, planes:i32 }
#[no_mangle]
pub unsafe extern "C" fn occ_count(bits:u32,words:i32)->i32 {
    let p=waddr(bits) as *const u32;let mut n=0;
    for i in 0..words.max(0) as usize {n+=(*p.add(i)).count_ones() as i32;}n
}
#[inline(always)]
unsafe fn half(g:&Grid,r:i32,dy:i32)->i32 {
    if dy < -32 || dy > 32 { -1 } else { *g.mask.add((r*65+dy+32) as usize) as i32 }
}
#[inline(always)]
fn word_mask(a:i32,b:i32,word:i32)->u32 {
    let lo=a.max(word*32)-word*32; let hi=b.min(word*32+31)-word*32;
    if lo>hi || lo>31 || hi<0 { 0 } else { (u32::MAX << lo) & (u32::MAX >> (31-hi)) }
}
#[inline(always)]
unsafe fn clear_or_mark(g:&Grid,x:i32,y:i32,r:i32,layer:i32,mark:bool) {
    let cx=idiv(x,g.cell);let cy=idiv(y,g.cell);
    for dy in -r..=r {
        let hw=half(g,r,dy);if hw<0 {continue;} let yy=cy+dy;
        if yy<0 || yy>=g.h {continue;}
        let a=(cx-hw).max(0);let b=(cx+hw).min(g.w-1);
        for ww in (a>>5)..=(b>>5) {
            let p=g.bits.add((layer*g.plane+yy*g.stride+ww) as usize);let m=word_mask(a,b,ww);
            *p=if mark {*p|m} else {*p&!m};
        }
    }
}
#[inline(always)]
unsafe fn free(g:&Grid,x:i32,y:i32,r:i32,layer:i32,ox:i32,oy:i32,orr:i32,ol:i32)->bool {
    let cx=idiv(x,g.cell);let cy=idiv(y,g.cell);
    let ocx=idiv(ox,g.cell);let ocy=idiv(oy,g.cell);
    if x<0 || y<0 {return false;}
    for dy in -r..=r {
        let hw=half(g,r,dy);if hw<0 {continue;} let yy=cy+dy;
        let a=cx-hw;let b=cx+hw;
        if yy<0 || yy>=g.h || a<0 || b>=g.w {return false;}
        let oh=if ol==layer && orr>0 {half(g,orr,yy-ocy)} else {-1};
        for ww in (a>>5)..=(b>>5) {
            let own=if oh>=0 {word_mask(ocx-oh,ocx+oh,ww)}else{0};
            let m=word_mask(a,b,ww)&!own;
            if *g.bits.add((layer*g.plane+yy*g.stride+ww) as usize)&m!=0 {return false;}
        }
    }
    true
}
#[no_mangle]
pub unsafe extern "C" fn occ_spawn(bits:u32,mask:u32,xx:u32,yy:u32,rr:u32,ll:u32,active:u32,
    w:i32,h:i32,stride:i32,cell:i32,planes:i32,s:i32,x:i32,y:i32,r:i32,layer:i32,search:i32)->i32 {
    let g=Grid{bits:waddr(bits) as *mut u32,mask:waddr(mask) as *const i8,w,h,stride,plane:stride*h,cell,planes};
    let layer=layer.max(0).min(planes-1);let r=r.max(1).min(32);let s=s as usize;
    let mut tx=x;let mut ty=y;let mut found=free(&g,x,y,r,layer,0,0,0,-1);
    'seek:for d in 1..=search {
        if found {break;}
        for dy in -d..=d {for dx in -d..=d {
            if dx.abs()!=d && dy.abs()!=d {continue;}
            tx=x+dx*cell;ty=y+dy*cell;
            if free(&g,tx,ty,r,layer,0,0,0,-1){found=true;break 'seek;}
        }}
    }
    if !found {return 0;}
    clear_or_mark(&g,tx,ty,r,layer,true);
    *(waddr(xx) as *mut i32).add(s)=tx;*(waddr(yy) as *mut i32).add(s)=ty;
    *(waddr(rr) as *mut u8).add(s)=r as u8;*(waddr(ll) as *mut u8).add(s)=layer as u8;
    *(waddr(active) as *mut u8).add(s)=1;1
}
#[no_mangle]
pub unsafe extern "C" fn occ_release(bits:u32,mask:u32,xx:u32,yy:u32,rr:u32,ll:u32,active:u32,
    w:i32,h:i32,stride:i32,cell:i32,planes:i32,s:i32) {
    let ac=waddr(active) as *mut u8;let s=s as usize;if *ac.add(s)==0{return;}
    let g=Grid{bits:waddr(bits) as *mut u32,mask:waddr(mask) as *const i8,w,h,stride,plane:stride*h,cell,planes};
    clear_or_mark(&g,*(waddr(xx) as *const i32).add(s),*(waddr(yy) as *const i32).add(s),*(waddr(rr) as *const u8).add(s) as i32,*(waddr(ll) as *const u8).add(s) as i32,false);
    *ac.add(s)=0;
}
#[inline(always)]
unsafe fn motion(g:&Grid,ox:i32,oy:i32,nx:i32,ny:i32,r:i32,layer:i32)->(i32,i32) {
    let dx=nx-ox;let dy=ny-oy;let steps=idiv(dx.abs().max(dy.abs())+g.cell-1,g.cell).max(1);
    let mut x=ox;let mut y=oy;
    for i in 1..=steps {
        let tx=ox+idiv(dx*i,steps);let ty=oy+idiv(dy*i,steps);
        if !free(g,tx,ty,r,layer,ox,oy,r,layer){break;}x=tx;y=ty;
    }
    (x,y)
}

// I: bits,mask,oldX,oldY,radius,layer,active, unitX,unitY,prevX,prevY,
// vx,vy,dead,live, spTile,sepKey,spArea,spMvOld,spMvNew,spMvOwn,owner,
// spOwner,areaGrid, eslot,start,count,stamp,stats,mvSteady,mvCT,mvCD.
#[no_mangle]
pub unsafe extern "C" fn occ_commit(a:u32,chunk:i32) {
    let a=waddr(a) as *const i32;let f=(a as usize+4096) as *const f64;
    macro_rules! p {($i:expr,$t:ty)=>{waddr(*a.add(512+$i) as u32) as *mut $t};}
    let g=Grid{bits:p!(0,u32),mask:p!(1,i8),w:rd(f,0) as i32,h:rd(f,1) as i32,stride:rd(f,2) as i32,cell:rd(f,3) as i32,planes:rd(f,4) as i32,plane:rd(f,2) as i32*rd(f,1) as i32};
    let bw=rd(f,5) as i32;let bh=rd(f,6) as i32;let block=rd(f,7) as i32;let phase=rd(f,8) as i32;
    let halfw=(bw+1)>>1;let bx=irem(chunk,halfw)*2+(phase&1);let by=idiv(chunk,halfw)*2+(phase>>1);
    if bx>=bw || by>=bh{return;}
    let cw=rd(f,9) as i32;let ch=rd(f,10) as i32;let ep=rd(f,11) as i32;
    let mapw=rd(f,12) as i32;let maph=rd(f,13) as i32;let tileq=rd(f,14) as i32;let cs=rd(f,15) as i32;
    let stats=p!(28,i32).add(((by*bw+bx)*8) as usize);
    core::ptr::write_bytes(stats,0,8);
    for cy in by*block..((by+1)*block).min(ch) {for cx in bx*block..((bx+1)*block).min(cw) {
        let key=(cy*cw+cx) as usize;if *p!(27,i32).add(key)!=ep {continue;}
        let start=*p!(25,i32).add(key);let end=start+*p!(26,i32).add(key);
        for e in start..end {
            let si=*p!(24,i32).add(e as usize);if si<0 {continue;}let s=si as usize;
            if *p!(6,u8).add(s)==0 {continue;}*stats.add(0)+=1;
            let ox=*p!(2,i32).add(s);let oy=*p!(3,i32).add(s);let r=*p!(4,u8).add(s) as i32;let layer=*p!(5,u8).add(s) as i32;
            if *p!(13,u8).add(s)!=0 || *p!(14,u8).add(s)==0 {
                clear_or_mark(&g,ox,oy,r,layer,false);*p!(6,u8).add(s)=0;*stats.add(4)+=1;
                for dy in -r..=r {let hw=half(&g,r,dy);if hw>=0 {*stats.add(7)+=hw*2+1;}}
                continue;
            }
            let nx=*p!(7,i32).add(s);let ny=*p!(8,i32).add(s);
            if nx==ox && ny==oy {continue;}*stats.add(1)+=1;
            // The halo includes one full packed word: helpers never RMW a
            // common occupancy word in the same colour, even at cell seams.
            let limit=(block*cs*tileq/2-(r+32)*g.cell).max(0);
            let mut tx=ox;let mut ty=oy;
            if (nx-ox).abs()<=limit && (ny-oy).abs()<=limit {
                (tx,ty)=motion(&g,ox,oy,nx,ny,r,layer);
                if tx==ox && ty==oy {
                    (tx,ty)=motion(&g,ox,oy,nx,oy,r,layer);
                    if tx==ox && ty==oy {(tx,ty)=motion(&g,ox,oy,ox,ny,r,layer);}
                }
            }else{*stats.add(5)+=1;}
            if tx!=ox || ty!=oy {
                if idiv(tx,g.cell)!=idiv(ox,g.cell)||idiv(ty,g.cell)!=idiv(oy,g.cell) {
                    clear_or_mark(&g,ox,oy,r,layer,false);clear_or_mark(&g,tx,ty,r,layer,true);*stats.add(6)+=1;
                }
                *p!(2,i32).add(s)=tx;*p!(3,i32).add(s)=ty;*stats.add(2)+=1;
            }
            if tx!=nx || ty!=ny {
                *stats.add(3)+=1;*p!(29,i32).add(s)=0;*p!(30,i32).add(s)=-1;*p!(31,i32).add(s)=-1;
            }
            *p!(7,i32).add(s)=tx;*p!(8,i32).add(s)=ty;
            *p!(9,i32).add(s)=ox;*p!(10,i32).add(s)=oy;
            let dk=rd(f,16).max(1.0);*p!(11,f32).add(s)=(tx-ox) as f32/(8.0*dk as f32);*p!(12,f32).add(s)=(ty-oy) as f32/(8.0*dk as f32);
            let gx=idiv(tx,tileq).max(0).min(mapw-1);let gy=idiv(ty,tileq).max(0).min(maph-1);let tt=gy*mapw+gx;
            let nk=idiv(gy,cs)*cw+idiv(gx,cs);let old=*p!(16,u32).add(s) as i32;
            if old!=nk {
                if *p!(20,i8).add(s)==0 {*p!(18,i32).add(s)=old;}
                *p!(19,i32).add(s)=nk;*p!(20,i8).add(s)=(*p!(22,i8).add(s)).wrapping_add(1);
                *p!(16,u32).add(s)=nk as u32;
            }
            *p!(15,i32).add(s)=tt;*p!(17,i32).add(s)=*p!(23,i32).add(tt as usize);
        }
    }}
}
