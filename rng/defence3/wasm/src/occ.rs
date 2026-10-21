//! Experimental exclusive raster occupancy. Phased spatial blocks own their
//! units; halos (including a complete packed word) do not overlap per phase.
use super::*;

struct Grid { bits:*mut u32, mask:*const i8, w:i32, h:i32, stride:i32, plane:i32, cell:i32, planes:i32, diag:*mut u32 }
macro_rules! occdiag {($g:expr,$n:expr)=>{#[cfg(feature="dbgc")] {if !$g.diag.is_null(){let p=$g.diag.add($n);*p=(*p).wrapping_add(1);}}};}

// Output-list ranges for spatial jobs. SIMD over tile counts, no unit or
// bitmap traversal. Kept on the main thread: only 4096 prefix entries at 4M.
#[no_mangle]
pub unsafe extern "C" fn occ_prepare(a:u32,_chunk:i32) {
    let a=waddr(a) as *const i32;
    let ptr=|i:usize|waddr(*a.add(512+i) as u32) as *mut i32;
    let cfg=ptr(33);let bw=*cfg.add(5);let bh=*cfg.add(6);let block=*cfg.add(7);
    let cw=*cfg.add(9);let ch=*cfg.add(10);let epoch=i32x4_splat(*cfg.add(11));
    let counts=ptr(26);let stamps=ptr(27);let offsets=ptr(32);let mut total=0;
    for by in 0..bh {for bx in 0..bw {
        *offsets.add((by*bw+bx) as usize)=total;let mut sum=i32x4_splat(0);
        for y in by*block..((by+1)*block).min(ch) {
            let mut x=bx*block;let end=((bx+1)*block).min(cw);
            while x+4<=end {
                let k=(y*cw+x) as usize;
                let valid=i32x4_eq(v128_load(stamps.add(k) as *const v128),epoch);
                sum=i32x4_add(sum,v128_and(valid,v128_load(counts.add(k) as *const v128)));x+=4;
            }
            while x<end {let k=(y*cw+x) as usize;if *stamps.add(k)==*cfg.add(11){total+=*counts.add(k);}x+=1;}
        }
        sum=i32x4_add(sum,i32x4_shuffle::<2,3,0,1>(sum,sum));
        sum=i32x4_add(sum,i32x4_shuffle::<1,0,3,2>(sum,sum));total+=i32x4_extract_lane::<0>(sum);
    }}
    *offsets.add((bw*bh) as usize)=total;
}
#[inline(always)]
fn cell_coord(g:&Grid,x:i32)->i32 {x>>g.cell.trailing_zeros()}
// A padding word at each row end permits a single unaligned 64-bit access
// for every supported disk row, including footprints crossing a word seam.
#[inline(always)]
unsafe fn row_mark<const MARK:bool>(row:*mut u32,left:i32,width:i32) {
    let p=row.add((left>>5) as usize) as *mut u64;
    let mask=((1u64<<width)-1)<<(left&31);
    let old=p.read_unaligned();p.write_unaligned(if MARK {old|mask}else{old&!mask});
}
#[inline(always)]
unsafe fn row_hit(row:*mut u32,left:i32,width:i32,old_left:i32,old_width:i32,own:u64)->u64 {
    let p=row.add((left>>5) as usize) as *const u64;
    let mask=((1u64<<width)-1)<<(left&31);
    let shift=old_left-((left>>5)<<5);
    let old=(1u64<<old_width)-1;
    // The shape leaf excludes old centres >= 2r cells away. For r <= 10,
    // the two row spans together cover < 64 bits: any wrapped rotation bits
    // lie outside the candidate mask. Rotation avoids sign-dependent shifts
    // (LLVM otherwise lowers those into branches for every footprint row).
    p.read_unaligned()&mask&!(old.rotate_left(shift as u32)&own)
}
#[inline(always)]
fn old_width(lo:v128,hi:v128,index:i32)->i32 {
    let a=u8x16_swizzle(lo,i8x16_splat(index as i8));
    let b=u8x16_swizzle(hi,i8x16_splat((index-16) as i8));
    u8x16_extract_lane::<0>(v128_or(a,b)) as i32
}
macro_rules! finish_hits {($first:expr $(,$rest:expr)*)=>{($first $(|$rest)*)==0};}
include!("occ_shapes.rs");

// Radius 2 is a 3x3 raster. A one-cell move only needs the newly entered
// fringe: one row for vertical movement, one column for horizontal, or
// one row plus two cells for a diagonal. Each leaf is straight-line.
#[inline(never)]
unsafe fn free_step_r2_x(g:&Grid,cx:i32,cy:i32,dx:i32,layer:i32)->bool {
    let col=cx+dx;let word=col>>5;let mask=1u32<<(col&31);
    let p=g.bits.add((layer*g.plane+cy*g.stride+word) as usize);
    ((*p.offset(-g.stride as isize))|*p|*p.offset(g.stride as isize))&mask==0
}
#[inline(never)]
unsafe fn free_step_r2_y(g:&Grid,cx:i32,cy:i32,dy:i32,layer:i32)->bool {
    let left=cx-1;let p=g.bits.add((layer*g.plane+(cy+dy)*g.stride+(left>>5)) as usize) as *const u64;
    p.read_unaligned()&(7u64<<(left&31))==0
}
#[inline(never)]
unsafe fn free_step_r2_xy(g:&Grid,cx:i32,cy:i32,dx:i32,dy:i32,layer:i32)->bool {
    let left=cx-1;let row=g.bits.add((layer*g.plane+(cy+dy)*g.stride+(left>>5)) as usize) as *const u64;
    let col=cx+dx;let p=g.bits.add((layer*g.plane+cy*g.stride+(col>>5)) as usize);
    let hit=row.read_unaligned()&(7u64<<(left&31));
    hit|(((*p|*p.offset((-dy*g.stride) as isize))&(1u32<<(col&31))) as u64)==0
}
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
#[cfg_attr(not(feature="prof"),inline(always))]
#[cfg_attr(feature="prof",inline(never))]
unsafe fn clear_or_mark(g:&Grid,x:i32,y:i32,r:i32,layer:i32,mark:bool) {
    if mark {occdiag!(g,45);}else{occdiag!(g,46);}
    let cx=cell_coord(g,x);let cy=cell_coord(g,y);
    if r<=10 && cx>=r-1 && cy>=r-1 && cx+r<=g.w && cy+r<=g.h {
        if mark {mark_special::<true>(g,cx,cy,r,layer)} else {mark_special::<false>(g,cx,cy,r,layer)}
        return;
    }
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
#[cfg_attr(not(feature="prof"),inline(always))]
#[cfg_attr(feature="prof",inline(never))]
unsafe fn free(g:&Grid,x:i32,y:i32,r:i32,layer:i32,ox:i32,oy:i32,orr:i32,ol:i32)->bool {
    occdiag!(g,40);
    let cx=cell_coord(g,x);let cy=cell_coord(g,y);
    let ocx=cell_coord(g,ox);let ocy=cell_coord(g,oy);
    if x<0 || y<0 {return false;}
    if r<=10 && (orr==0 || orr==r) {
        if cx<r-1 || cy<r-1 || cx+r>g.w || cy+r>g.h {return false;}
        if r==2 && orr==2 && ol==layer {
            let dx=cx-ocx;let dy=cy-ocy;
            if dx.abs()<=1 && dy.abs()<=1 {
                occdiag!(g,49);
                if dx==0 {occdiag!(g,50);return dy==0 || free_step_r2_y(g,cx,cy,dy,layer);}
                if dy==0 {occdiag!(g,51);return free_step_r2_x(g,cx,cy,dx,layer);}
                occdiag!(g,52);return free_step_r2_xy(g,cx,cy,dx,dy,layer);
            }
        }
        return free_special(g,cx,cy,r,layer,ocx,ocy,0u64.wrapping_sub((ol==layer && orr==r) as u64));
    }
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
    let g=Grid{bits:waddr(bits) as *mut u32,mask:waddr(mask) as *const i8,w,h,stride,plane:stride*h,cell,planes,diag:core::ptr::null_mut()};
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
    let g=Grid{bits:waddr(bits) as *mut u32,mask:waddr(mask) as *const i8,w,h,stride,plane:stride*h,cell,planes,diag:core::ptr::null_mut()};
    clear_or_mark(&g,*(waddr(xx) as *const i32).add(s),*(waddr(yy) as *const i32).add(s),*(waddr(rr) as *const u8).add(s) as i32,*(waddr(ll) as *const u8).add(s) as i32,false);
    *ac.add(s)=0;
}
#[cfg_attr(not(feature="prof"),inline(always))]
#[cfg_attr(feature="prof",inline(never))]
unsafe fn motion(g:&Grid,ox:i32,oy:i32,nx:i32,ny:i32,r:i32,layer:i32)->(i32,i32) {
    occdiag!(g,41);
    if cell_coord(g,nx)==cell_coord(g,ox) && cell_coord(g,ny)==cell_coord(g,oy) {occdiag!(g,42);return (nx,ny);}
    if (nx-ox).abs().max((ny-oy).abs())<=g.cell {
        return if free(g,nx,ny,r,layer,ox,oy,r,layer) {(nx,ny)}else{(ox,oy)};
    }
    let dx=nx-ox;let dy=ny-oy;let steps=idiv(dx.abs().max(dy.abs())+g.cell-1,g.cell).max(1);
    let mut x=ox;let mut y=oy;
    for i in 1..=steps {
        let tx=ox+idiv(dx*i,steps);let ty=oy+idiv(dy*i,steps);
        if !free(g,tx,ty,r,layer,ox,oy,r,layer){break;}x=tx;y=ty;
    }
    (x,y)
}


// Loaded once per spatial movement job, then used at each position write.
pub(super) struct MoveGrid {
    g:Grid, xx:*mut i32, yy:*mut i32, rr:*const u8, layer:*const u8,
    active:*const u8, stats:*mut i32, blockq:i32, bx:i32, by:i32,
}
impl MoveGrid {
    pub(super) unsafe fn load(a:*const i32,bx:i32,by:i32,job:i32)->Self {
        let cfg=waddr(*a.add(512+33) as u32) as *const i32;
        let get=|i| *cfg.add(i);
        let ptr=|i:usize|waddr(*a.add(512+i) as u32);
        let g=Grid{bits:ptr(0) as *mut u32,mask:ptr(1) as *const i8,
            w:get(0),h:get(1),stride:get(2),cell:get(3),planes:get(4),plane:get(2)*get(1),diag:(a as *mut u32).add(1536)};
        let stats=(ptr(28) as *mut i32).add(job as usize*8);
        Self{g,xx:ptr(2) as *mut i32,yy:ptr(3) as *mut i32,rr:ptr(4) as *const u8,
            layer:ptr(5) as *const u8,active:ptr(6) as *const u8,stats,
            blockq:get(7)*get(15)*get(14),bx,by}
    }
    pub(super) unsafe fn visit(&self,n:usize){
        *self.stats+=n as i32;
        *self.stats.add(4)+=1;
    }
    pub(super) unsafe fn scalar_lane(&self){*self.stats.add(7)+=1;}
    pub(super) unsafe fn reset(&self){core::ptr::write_bytes(self.stats,0,8);}
    #[inline(never)]
    pub(super) unsafe fn position(&self,s:usize,nx:i32,ny:i32)->(i32,i32) {
        if *self.active.add(s)==0 {return (nx,ny);}
        let ox=*self.xx.add(s);let oy=*self.yy.add(s);
        if nx==ox && ny==oy {return (nx,ny);}
        *self.stats.add(1)+=1;
        let r=*self.rr.add(s) as i32;let layer=*self.layer.add(s) as i32;
        let limit=(self.blockq/2-(r+32)*self.g.cell).max(0);
        let mut tx=ox;let mut ty=oy;
        if nx>=self.bx*self.blockq-limit && nx<(self.bx+1)*self.blockq+limit
            && ny>=self.by*self.blockq-limit && ny<(self.by+1)*self.blockq+limit {
            (tx,ty)=motion(&self.g,ox,oy,nx,ny,r,layer);
            if tx==ox && ty==oy && nx!=ox && ny!=oy {
                occdiag!(&self.g,43);
                (tx,ty)=motion(&self.g,ox,oy,nx,oy,r,layer);
                if tx==ox && ty==oy {occdiag!(&self.g,44);(tx,ty)=motion(&self.g,ox,oy,ox,ny,r,layer);}
            }else if tx==ox && ty==oy {occdiag!(&self.g,48);}
        }else{*self.stats.add(5)+=1;}
        if tx!=ox || ty!=oy {
            if cell_coord(&self.g,tx)!=cell_coord(&self.g,ox) || cell_coord(&self.g,ty)!=cell_coord(&self.g,oy) {
                clear_or_mark(&self.g,ox,oy,r,layer,false);
                clear_or_mark(&self.g,tx,ty,r,layer,true);*self.stats.add(6)+=1;
            }
            *self.xx.add(s)=tx;*self.yy.add(s)=ty;*self.stats.add(2)+=1;
        }
        if tx!=nx || ty!=ny {*self.stats.add(3)+=1;}
        (tx,ty)
    }
}
// Main-thread movement uses the same immediate check and update, one unit
// at a time. No queued positions and no whole-population occupancy pass.
#[no_mangle]
pub unsafe extern "C" fn occ_move_one(a:u32,s:i32,nx:i32,ny:i32)->i64 {
    let a=waddr(a) as *const i32;
    let cfg=waddr(*a.add(512+33) as u32) as *const i32;
    let xx=waddr(*a.add(514) as u32) as *const i32;
    let yy=waddr(*a.add(515) as u32) as *const i32;
    let blockq=*cfg.add(7)* *cfg.add(15)* *cfg.add(14);
    let bx=idiv(*xx.add(s as usize),blockq);let by=idiv(*yy.add(s as usize),blockq);
    // A dedicated scratch stats job, so JS moves do not reset a block's stats.
    let grid=MoveGrid::load(a,bx,by,*cfg.add(5)* *cfg.add(6));
    grid.visit(1);
    let (x,y)=grid.position(s as usize,nx,ny);
    (x as u32 as i64)|((y as i64)<<32)
}

// Read-only diagnostic: replay the same cardinal one-cell queries over
// identical copies of the grid. Increasing copies changes the cache working
// set without changing query count, coordinates, masks or answers.
#[cfg(feature="prof")]
#[no_mangle]
pub unsafe extern "C" fn occ_probe_bench(bits:u32,mask:u32,xx:u32,yy:u32,rr:u32,ll:u32,active:u32,
    w:i32,h:i32,stride:i32,cell:i32,planes:i32,n:i32,rounds:i32,copies:i32,variant:i32)->i32 {
    let x=waddr(xx) as *const i32;let y=waddr(yy) as *const i32;
    let r=waddr(rr) as *const u8;let layer=waddr(ll) as *const u8;let live=waddr(active) as *const u8;
    let mut sum=0;
    for k in 0..rounds {
        let mut g=Grid{bits:waddr(bits) as *mut u32,mask:waddr(mask) as *const i8,
            w,h,stride,cell,planes,plane:stride*h,diag:core::ptr::null_mut()};
        let dx=match k&3 {0=>cell,1=> -cell,_=>0};let dy=match k&3 {2=>cell,3=> -cell,_=>0};
        for s in 0..n.max(0) as usize {if *live.add(s)!=0 {
            g.bits=(waddr(bits) as *mut u32).add(((s as i32&(copies-1))*stride*h*planes) as usize);
            let ox=*x.add(s);let oy=*y.add(s);let rad=*r.add(s) as i32;let l=*layer.add(s) as i32;
            let nx=ox+dx;let ny=oy+dy;
            let ok=if variant==0 && rad<=10 {
                let cx=cell_coord(&g,nx);let cy=cell_coord(&g,ny);
                nx>=0 && ny>=0 && cx>=rad-1 && cy>=rad-1 && cx+rad<=w && cy+rad<=h
                    && free_special(&g,cx,cy,rad,l,cell_coord(&g,ox),cell_coord(&g,oy),u64::MAX)
            }else{free(&g,nx,ny,rad,l,ox,oy,rad,l)};
            sum+=ok as i32;
        }}
    }sum
}
