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
// The same, by block (OCC_COUNT_BLOCKS a chunk): each block's own count into
// occ.offsets (the simulation thread then sums them up), on the helpers.
pub(super) const OCC_COUNT_BLOCKS:i32=64;
#[no_mangle]
pub unsafe extern "C" fn occ_block_counts(a:u32,chunk:i32) {
    let a=waddr(a) as *const i32;
    let ptr=|i:usize|waddr(*a.add(512+i) as u32) as *mut i32;
    let per=OCC_COUNT_BLOCKS;
    let cfg=ptr(33);let bw=*cfg.add(5);let bh=*cfg.add(6);let block=*cfg.add(7);
    let cw=*cfg.add(9);let ch=*cfg.add(10);let ep=*cfg.add(11);let epoch=i32x4_splat(ep);
    let counts=ptr(26);let stamps=ptr(27);let offsets=ptr(32);
    let j0=chunk.max(0)*per;let j1=(j0+per).min(bw*bh);
    for job in j0..j1 {
        let bx=irem(job,bw);let by=idiv(job,bw);
        let mut total=0;let mut sum=i32x4_splat(0);
        for y in by*block..((by+1)*block).min(ch) {
            let mut x=bx*block;let end=((bx+1)*block).min(cw);
            while x+4<=end {
                let k=(y*cw+x) as usize;
                let valid=i32x4_eq(v128_load(stamps.add(k) as *const v128),epoch);
                sum=i32x4_add(sum,v128_and(valid,v128_load(counts.add(k) as *const v128)));x+=4;
            }
            while x<end {let k=(y*cw+x) as usize;if *stamps.add(k)==ep{total+=*counts.add(k);}x+=1;}
        }
        sum=i32x4_add(sum,i32x4_shuffle::<2,3,0,1>(sum,sum));
        sum=i32x4_add(sum,i32x4_shuffle::<1,0,3,2>(sum,sum));
        *offsets.add(job as usize)=total+i32x4_extract_lane::<0>(sum);
    }
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
pub(super) const XSWAP_CAP:usize=32;

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
pub unsafe extern "C" fn occ_spawn(bits:u32,mask:u32,rec:u32,
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
    let p=(waddr(rec) as *mut i32).add(s*4);
    *p=tx;*p.add(1)=ty;*p.add(2)=(r&255)|((layer&255)<<8)|(1<<16)|(*p.add(2)&(255<<24));1
}
#[no_mangle]
pub unsafe extern "C" fn occ_release(bits:u32,mask:u32,rec:u32,
    w:i32,h:i32,stride:i32,cell:i32,planes:i32,s:i32) {
    let p=(waddr(rec) as *mut i32).add(s as usize*4);let s=s as usize;let meta=*p.add(2);if (meta>>16)&255==0{return;}
    let g=Grid{bits:waddr(bits) as *mut u32,mask:waddr(mask) as *const i8,w,h,stride,plane:stride*h,cell,planes,diag:core::ptr::null_mut()};
    clear_or_mark(&g,*p,*p.add(1),meta&255,(meta>>8)&255,false);
    *p.add(2)=meta&!(255<<16);
}
#[cfg_attr(not(feature="prof"),inline(always))]
#[cfg_attr(feature="prof",inline(never))]
unsafe fn motion(g:&Grid,ox:i32,oy:i32,nx:i32,ny:i32,r:i32,layer:i32)->(i32,i32) {
    occdiag!(g,41);
    if cell_coord(g,nx)==cell_coord(g,ox) && cell_coord(g,ny)==cell_coord(g,oy) {occdiag!(g,42);return (nx,ny);}
    if (nx-ox).abs().max((ny-oy).abs())<=g.cell {
        return if free(g,nx,ny,r,layer,ox,oy,r,layer) {(nx,ny)}else{(ox,oy)};
    }
    let cx=cell_coord(g,ox);let cy=cell_coord(g,oy);
    if cell_coord(g,ny)==cy && cx>=r-1 && cx+r<=g.w && cy>=r-1 && cy+r<=g.h {
        return horizontal_motion(g,ox,oy,nx,ny,r,layer,cx,cy);
    }
    let dx=nx-ox;let dy=ny-oy;let steps=idiv(dx.abs().max(dy.abs())+g.cell-1,g.cell).max(1);
    let mut x=ox;let mut y=oy;
    for i in 1..=steps {
        let tx=ox+idiv(dx*i,steps);let ty=oy+idiv(dy*i,steps);
        if !free(g,tx,ty,r,layer,ox,oy,r,layer){break;}x=tx;y=ty;
    }
    (x,y)
}

// A same-row sweep tests newly entered row spans a word at a time instead
// of re-testing a complete disk at every intermediate cell. Convert the
// first hit back to the original discrete sweep step, preserving positions.
#[inline(never)]
unsafe fn horizontal_motion(g:&Grid,ox:i32,oy:i32,nx:i32,ny:i32,r:i32,layer:i32,cx:i32,cy:i32)->(i32,i32){
    let dx=nx-ox;let dy=ny-oy;let target=cell_coord(g,nx);
    let mut allowed=target.max(r-1).min(g.w-r);
    for row in 1-r..r{
        let hw=half(g,r,row);if hw<0{continue;}
        let base=g.bits.add((layer*g.plane+(cy+row)*g.stride) as usize);
        if dx>0{
            let left=cx+hw+1;let right=allowed+hw;
            if right>=left{for word in (left>>5)..=(right>>5){
                let hit=*base.add(word as usize)&word_mask(left,right,word);
                if hit!=0{allowed=allowed.min(word*32+hit.trailing_zeros() as i32-hw-1);break;}
            }}
        }else{
            let left=allowed-hw;let right=cx-hw-1;
            if right>=left{let mut word=right>>5;while word>=left>>5{
                let hit=*base.add(word as usize)&word_mask(left,right,word);
                if hit!=0{allowed=allowed.max(word*32+31-hit.leading_zeros() as i32+hw+1);break;}word-=1;
            }}
        }
        if allowed==cx{break;}
    }
    if allowed==target{return (nx,ny);}
    let steps=idiv(dx.abs().max(dy.abs())+g.cell-1,g.cell).max(1);
    let threshold=if dx>0{(allowed+1)*g.cell-ox}else{ox-allowed*g.cell+1};
    let first=idiv(threshold*steps+dx.abs()-1,dx.abs());let done=(first-1).max(0).min(steps);
    (ox+idiv(dx*done,steps),oy+idiv(dy*done,steps))
}


// Loaded once per spatial movement job, then used at each position write.
pub(super) struct MoveGrid {
    g:Grid, rec:*mut i32, stats:*mut i32, blockq:i32, bx:i32, by:i32,
    // The tick-start unit index (per chunk: slots, start, count, stamp).
    ix_slot:*const i32, ix_start:*const i32, ix_count:*const i32, ix_stamp:*const i32,
    cw:i32, ch:i32, epoch:i32, chq:i32,
    // This job's cross-block swap list ([count, slots...]; null: none).
    xsw:*mut i32,
    // The (start, count) of every chunk of this block and the ring around it, made once per job (cache_chunks): the
    // swap's look at 3x3 chunks read three index tables at each of them, nine lines a call.
    lc:*const i32, lcx:i32, lcy:i32, lcn:i32,
}
impl MoveGrid {
    pub(super) unsafe fn load(a:*const i32,bx:i32,by:i32,job:i32)->Self {
        let cfg=waddr(*a.add(512+33) as u32) as *const i32;
        let get=|i| *cfg.add(i);
        let ptr=|i:usize|waddr(*a.add(512+i) as u32);
        let g=Grid{bits:ptr(0) as *mut u32,mask:ptr(1) as *const i8,
            w:get(0),h:get(1),stride:get(2),cell:get(3),planes:get(4),plane:get(2)*get(1),diag:(a as *mut u32).add(1536)};
        let stats=(ptr(28) as *mut i32).add(job as usize*16);
        Self{g,rec:ptr(2) as *mut i32,stats,
            blockq:get(7)*get(15)*get(14),bx,by,
            ix_slot:ptr(24) as *const i32,ix_start:ptr(25) as *const i32,ix_count:ptr(26) as *const i32,ix_stamp:ptr(27) as *const i32,
            cw:get(9),ch:get(10),epoch:get(11),chq:get(15)*get(14),
            xsw:if *a.add(512+34)==0{core::ptr::null_mut()}else{(ptr(34) as *mut i32).add(job as usize*48)},
            lc:core::ptr::null(),lcx:0,lcy:0,lcn:0}
    }
    /// The chunk records of this block and one chunk around it into buf (room for 2 words a cell, `cells` cells): the tick-start
    /// index does not change during the job, so a lookup reads the buffer (a few lines) instead of three tables at the chunk.
    pub(super) unsafe fn cache_chunks(&mut self,buf:*mut i32,cells:usize,block:i32){
        let n=block+2;
        if self.ix_slot.is_null()||block<1||(n*n) as usize>cells{self.lc=core::ptr::null();return;}
        let cx0=self.bx*block-1;let cy0=self.by*block-1;
        for j in 0..n{for i in 0..n{
            let cx=cx0+i;let cy=cy0+j;let (mut a,mut c)=(0,0);
            if cx>=0&&cy>=0&&cx<self.cw&&cy<self.ch{
                let k=(cy*self.cw+cx) as usize;
                if *self.ix_stamp.add(k)==self.epoch{a=*self.ix_start.add(k);c=*self.ix_count.add(k);}
            }
            let o=((j*n+i)*2) as usize;*buf.add(o)=a;*buf.add(o+1)=c;
        }}
        self.lc=buf;self.lcx=cx0;self.lcy=cy0;self.lcn=n;
    }
    pub(super) unsafe fn visit(&self,n:usize){
        *self.stats+=n as i32;
        *self.stats.add(4)+=1;
    }
    pub(super) unsafe fn scalar_lane(&self){*self.stats.add(7)+=1;}
    pub(super) unsafe fn reset(&self){core::ptr::write_bytes(self.stats,0,8);if !self.xsw.is_null(){*self.xsw=0;}}
    /// Room for one more cross-block swap.
    pub(super) unsafe fn xswap_room(&self)->bool{!self.xsw.is_null()&&*self.xsw<XSWAP_CAP as i32}
    pub(super) unsafe fn xswap_push(&self,b:usize){let n=*self.xsw+1;*self.xsw.add(n as usize)=b as i32;*self.xsw=n;}
    /// Its footprint radius in Q8 position units.
    pub(super) unsafe fn radius_q(&self,s:usize)->i32{(*self.rec.add(s*4+2)&255)*self.g.cell}
    pub(super) unsafe fn active(&self,s:usize)->bool{(*self.rec.add(s*4+2)>>16)&255!=0}
    /// The index entries of the chunk at (x, y) (Q8) if it is this job's
    /// and indexed this tick: (first, end) into slot().
    pub(super) unsafe fn chunk_entries(&self,x:i32,y:i32)->(i32,i32){
        if !self.owns(x,y){return (0,0);}
        self.chunk_entries_near(x,y)
    }
    /// The same for a chunk of this block or one chunk past its edge (a
    /// neighbouring block's: its job runs in another phase).
    pub(super) unsafe fn chunk_entries_near(&self,x:i32,y:i32)->(i32,i32){
        let e=self.chq;
        if self.ix_slot.is_null()||x<0||y<0||x<self.bx*self.blockq-e||x>=(self.bx+1)*self.blockq+e||y<self.by*self.blockq-e||y>=(self.by+1)*self.blockq+e{return (0,0);}
        let cx=idiv(x,self.chq);let cy=idiv(y,self.chq);if cx>=self.cw||cy>=self.ch{return (0,0);}
        if !self.lc.is_null(){
            // (The bounds above keep (cx, cy) in the cached block and ring: block + 2 chunks a side.)
            let o=(((cy-self.lcy)*self.lcn+(cx-self.lcx))*2) as usize;
            let a=*self.lc.add(o);return (a,a+*self.lc.add(o+1));
        }
        let k=(cy*self.cw+cx) as usize;if *self.ix_stamp.add(k)!=self.epoch{return (0,0);}
        let a=*self.ix_start.add(k);(a,a+*self.ix_count.add(k))
    }
    pub(super) unsafe fn slot(&self,i:i32)->i32{*self.ix_slot.add(i as usize)}
    pub(super) fn chunk_q(&self)->i32{self.chq}
    pub(super) unsafe fn pos(&self,s:usize)->(i32,i32){let p=self.rec.add(s*4);(*p,*p.add(1))}
    /// Gather four packed occupancy records, transpose hot fields to SoA,
    /// and reject distant swap candidates together. A one-Q8-unit margin
    /// keeps this f32 broad phase conservative; exact f64 tests follow.
    #[inline(always)]
    pub(super) unsafe fn swap_candidates4(&self,slots:&[i32;4],ox:i32,oy:i32,rq:i32)->u32 {
        let load=|s:i32|if s<0{i32x4_splat(0)}else{v128_load(self.rec.add(s as usize*4) as *const v128)};
        let (a,b,c,d)=(load(slots[0]),load(slots[1]),load(slots[2]),load(slots[3]));
        let ab=i32x4_shuffle::<0,4,1,5>(a,b);let cd=i32x4_shuffle::<0,4,1,5>(c,d);
        let x=i32x4_shuffle::<0,1,4,5>(ab,cd);let y=i32x4_shuffle::<2,3,6,7>(ab,cd);
        let m=i32x4(i32x4_extract_lane::<2>(a),i32x4_extract_lane::<2>(b),i32x4_extract_lane::<2>(c),i32x4_extract_lane::<2>(d));
        let radius=i32x4_add(i32x4_mul(v128_and(m,i32x4_splat(255)),i32x4_splat(self.g.cell)),i32x4_splat(rq+97));
        let dx=f32x4_convert_i32x4(i32x4_sub(x,i32x4_splat(ox)));let dy=f32x4_convert_i32x4(i32x4_sub(y,i32x4_splat(oy)));
        let r=f32x4_convert_i32x4(radius);
        let ok=v128_and(i32x4_ne(v128_and(m,i32x4_splat(255<<16)),i32x4_splat(0)),
            f32x4_le(f32x4_add(f32x4_mul(dx,dx),f32x4_mul(dy,dy)),f32x4_mul(r,r)));
        i32x4_bitmask(ok) as u32
    }
    /// Whether (x, y) lies in this job's block (its units' tick-start tiles).
    pub(super) fn owns(&self,x:i32,y:i32)->bool{
        x>=self.bx*self.blockq&&x<(self.bx+1)*self.blockq&&y>=self.by*self.blockq&&y<(self.by+1)*self.blockq
    }
    /// a and b trade places, if both footprints fit there (same plane);
    /// else the grid is left as it was. A larger b may settle a cell or two
    /// further along (dx, dy) (b's way, unit length), or beside that.
    /// Returns b's new position.
    pub(super) unsafe fn swap(&self,a:usize,b:usize,dx:f64,dy:f64)->Option<(i32,i32)>{
        let (pa,pb)=(self.rec.add(a*4),self.rec.add(b*4));let (ma,mb)=(*pa.add(2),*pb.add(2));
        if (ma>>16)&255==0||(mb>>16)&255==0||(ma>>8)&255!=(mb>>8)&255{return None;}
        let l=(ma>>8)&255;let ra=ma&255;let rb=mb&255;
        let (ax,ay)=(*pa,*pa.add(1));let (bx,by)=(*pb,*pb.add(1));
        clear_or_mark(&self.g,ax,ay,ra,l,false);clear_or_mark(&self.g,bx,by,rb,l,false);
        if free(&self.g,bx,by,ra,l,0,0,0,-1){
            clear_or_mark(&self.g,bx,by,ra,l,true);
            let c=self.g.cell as f64;let (px,py)=(-dy,dx);
            let tries:[(f64,f64);6]=[(0.0,0.0),(1.0,0.0),(1.0,1.0),(1.0,-1.0),(2.0,0.0),(0.0,1.0)];
            for k in 0..(if rb>ra{6}else{1}){
                let (f,g)=*tries.as_ptr().add(k);
                let tx=ax+js_round((dx*f+px*g)*c) as i32;let ty=ay+js_round((dy*f+py*g)*c) as i32;
                if free(&self.g,tx,ty,rb,l,0,0,0,-1){
                    clear_or_mark(&self.g,tx,ty,rb,l,true);
                    *pa=bx;*pa.add(1)=by;*pb=tx;*pb.add(1)=ty;
                    *self.stats.add(6)+=2;return Some((tx,ty));
                }
            }
            clear_or_mark(&self.g,bx,by,ra,l,false);
        }
        clear_or_mark(&self.g,ax,ay,ra,l,true);clear_or_mark(&self.g,bx,by,rb,l,true);
        None
    }
    pub(super) unsafe fn layer_mass(&self,s:usize)->(i32,i32){
        let m=*self.rec.add(s*4+2);let r=m&255;((m>>8)&255,(3*r*r-3).max(1))
    }
    #[inline(never)]
    pub(super) unsafe fn preview(&self,s:usize,nx:i32,ny:i32)->(i32,i32) {
        let p=self.rec.add(s*4);let meta=*p.add(2);
        if (meta>>16)&255==0 {return (nx,ny);}
        let ox=*p;let oy=*p.add(1);
        if nx==ox && ny==oy {return (nx,ny);}
        let r=meta&255;let layer=(meta>>8)&255;
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
        }
        (tx,ty)
    }
    #[inline(never)]
    pub(super) unsafe fn position(&self,s:usize,nx:i32,ny:i32)->(i32,i32) {
        let p=self.rec.add(s*4);
        if (*p.add(2)>>16)&255==0 {return (nx,ny);}
        let ox=*p;let oy=*p.add(1);
        if nx==ox && ny==oy{return (nx,ny);}
        let (tx,ty)=self.preview(s,nx,ny);
        self.commit_preview(s,tx,ty,nx,ny)
    }
    // Only after preview, with no intervening bitmap writer in this job.
    #[inline(never)]
    pub(super) unsafe fn commit_preview(&self,s:usize,tx:i32,ty:i32,nx:i32,ny:i32)->(i32,i32) {
        let p=self.rec.add(s*4);let meta=*p.add(2);
        if (meta>>16)&255==0{return (tx,ty);}
        let ox=*p;let oy=*p.add(1);
        if nx==ox && ny==oy{return (tx,ty);}
        *self.stats.add(1)+=1;
        let r=meta&255;let layer=(meta>>8)&255;
        let limit=(self.blockq/2-(r+32)*self.g.cell).max(0);
        if nx<self.bx*self.blockq-limit || nx>=(self.bx+1)*self.blockq+limit
            || ny<self.by*self.blockq-limit || ny>=(self.by+1)*self.blockq+limit {*self.stats.add(5)+=1;}
        if tx!=ox || ty!=oy {
            if cell_coord(&self.g,tx)!=cell_coord(&self.g,ox) || cell_coord(&self.g,ty)!=cell_coord(&self.g,oy) {
                clear_or_mark(&self.g,ox,oy,r,layer,false);
                clear_or_mark(&self.g,tx,ty,r,layer,true);*self.stats.add(6)+=1;
            }
            *p=tx;*p.add(1)=ty;*self.stats.add(2)+=1;
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
    let rec=waddr(*a.add(514) as u32) as *const i32;
    let blockq=*cfg.add(7)* *cfg.add(15)* *cfg.add(14);
    let bx=idiv(*rec.add(s as usize*4),blockq);let by=idiv(*rec.add(s as usize*4+1),blockq);
    // A dedicated scratch stats job, so JS moves do not reset a block's stats.
    let grid=MoveGrid::load(a,bx,by,*cfg.add(5)* *cfg.add(6));
    grid.visit(1);
    let (x,y)=grid.position(s as usize,nx,ny);
    (x as u32 as i64)|((y as i64)<<32)
}
