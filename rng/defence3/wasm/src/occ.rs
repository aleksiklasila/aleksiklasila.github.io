//! Exclusive raster occupancy. Phased spatial blocks own their units; halos (including a complete packed word) do
//! not overlap per phase.
use super::*;

// The bitmap's layout (sim_occupancy.js occupancyEnsure): per plane OCC_MY rows above and below the map, all taken,
// and each row's last word (past the map's columns, w / 32 + 1 words a row) taken too: it is the row's right margin
// and, read at word -1, the next row's left margin. Cells past the map read as taken: no edge tests in reads that stay
// within OCC_MY rows and one word of the map (legal-centre fields). bits below is the map's origin (row 0, word 0).
pub(crate) const OCC_MY:i32=16;
#[inline(always)]
pub(crate) fn occ_plane(stride:i32,h:i32)->i32{stride*(h+2*OCC_MY)}
#[inline(always)]
pub(crate) unsafe fn origin(bits:*mut u32,stride:i32)->*mut u32{bits.add((OCC_MY*stride) as usize)}
// After the planes: one i32 a coarse traffic cell (32 x 32 cells: a word's columns, 32 rows), its taken cells,
// kept by every write of the bitmap (tally): the traffic's capture reads them instead of counting the bitmap.
#[inline(always)]
pub(crate) unsafe fn occ_counts(base:*mut u32,stride:i32,h:i32,planes:i32)->*mut i32{base.add((planes*occ_plane(stride,h)) as usize) as *mut i32}
// (atomic: the counts' adds atomic (writers not separated by coarse cells); the movement's jobs are: plain adds.)
// The occupancy cell: 4 px (32 eighths), 8 a tile (sim_occupancy.js SIM_OCCUPANCY_SUBCELLS; occ_layout carries it, a
// grid of another size traps in mkgrid). A constant: positions to cells by a fixed shift everywhere.
pub(crate) const OCC_CELL:i32=32;
const OCC_SH:u32=5;
struct Grid { bits:*mut u32, w:i32, h:i32, stride:i32, plane:i32, planes:i32, diag:*mut u32,
    cnt:*mut i32, cw:i32, ch:i32, atomic:bool }
/// The grid over the bitmap array at base (its first margin row). (_mask: the old disk table's address, unused.)
#[inline(always)]
unsafe fn mkgrid(base:*mut u32,_mask:*const i8,w:i32,h:i32,stride:i32,cell:i32,planes:i32,diag:*mut u32,atomic:bool)->Grid{
    if cell!=OCC_CELL{unreachable();}
    Grid{bits:origin(base,stride),w,h,stride,plane:occ_plane(stride,h),planes,diag,
        cnt:occ_counts(base,stride,h,planes),cw:(w+31)>>5,ch:(h+31)>>5,atomic}
}
/// A word's change of taken cells into its coarse cell's count.
#[inline(always)]
unsafe fn tally(g:&Grid,layer:i32,yy:i32,word:i32,d:i32){
    if d==0||word>=g.cw{return;}
    let p=g.cnt.add(((layer*g.ch+(yy>>5))*g.cw+word) as usize);
    if g.atomic{(*(p as *const core::sync::atomic::AtomicI32)).fetch_add(d,core::sync::atomic::Ordering::Relaxed);}else{*p+=d;}
}
/// Rows y0..=y1 of the 64 bits from word w0 written, row y's (clr, set) = f(y) cleared and set (one unaligned
/// read-modify-write a row); the words' count changes summed by coarse row and added once each. count false: the
/// caller knows they do not change (the cells move inside one coarse cell).
#[inline(always)]
unsafe fn rows64(g:&Grid,layer:i32,y0:i32,y1:i32,w0:i32,count:bool,f:impl Fn(i32)->(u64,u64)){
    let base=g.bits.add((layer*g.plane+w0) as usize);
    let (mut d0,mut d1,mut cy)=(0i32,0i32,y0>>5);
    for y in y0..=y1{
        let (clr,set)=f(y);if clr|set==0{continue;}
        let p=base.add((y*g.stride) as usize) as *mut u64;
        let v=p.read_unaligned();let n=(v&!clr)|set;p.write_unaligned(n);
        if count{
            if y>>5!=cy{tally(g,layer,cy<<5,w0,d0);tally(g,layer,cy<<5,w0+1,d1);d0=0;d1=0;cy=y>>5;}
            d0+=(n as u32).count_ones() as i32-(v as u32).count_ones() as i32;
            d1+=((n>>32) as u32).count_ones() as i32-((v>>32) as u32).count_ones() as i32;
        }
    }
    if count{tally(g,layer,cy<<5,w0,d0);tally(g,layer,cy<<5,w0+1,d1);}
}
macro_rules! occdiag {($g:expr,$n:expr)=>{#[cfg(feature="dbgc")] {if !$g.diag.is_null(){let p=$g.diag.add($n);*p=(*p).wrapping_add(1);}}};}

#[inline(always)]
fn cell_coord(_g:&Grid,x:i32)->i32 {x>>OCC_SH}
pub(super) const XSWAP_CAP:usize=32;

// ---- footprints: squares of w cells (the record's low byte, 1..=OCC_WMAX) ----
// A footprint's cells are [a, a + w) on each axis from its anchor a = cell(p - off), off = (w - 1) * cell / 2: centred
// on the position for any width (odd widths: the position's cell and (w - 1) / 2 each side, as the old odd squares;
// even widths: the anchor turns over at the cells' middles). The sweeps below work on shifted positions s = p - off,
// whose cell is the anchor: the same discrete steps for every width.
pub(crate) const OCC_WMAX:i32=32;
/// The shift of a w-wide footprint's positions (eighths).
#[inline(always)]
fn foff(_g:&Grid,w:i32)->i32{((w-1)*OCC_CELL)>>1}
/// The anchor cell of a w-wide footprint at p (eighths).
#[inline(always)]
fn anchor(g:&Grid,p:i32,w:i32)->i32{cell_coord(g,p-foff(g,w))}
/// The bits of the cells [s, s + n) of a 64-bit window (s may lie left of it or past it; n <= 32).
#[inline(always)]
fn span64(s:i32,n:i32)->u64{
    let m=(1u64<<n)-1;
    if s>=64||s+n<=0{0}else if s>=0{m<<s}else{m>>(-s)}
}
/// The w x w cells at anchor (ax, ay) all free (a cell past the map's edge is not), own: a footprint (anchor, width)
/// on the same plane whose cells do not count (the mover's own).
#[cfg_attr(not(feature="prof"),inline(always))]
#[cfg_attr(feature="prof",inline(never))]
unsafe fn fits(g:&Grid,ax:i32,ay:i32,w:i32,layer:i32,own:Option<(i32,i32,i32)>)->bool{
    occdiag!(g,40);
    if ax<0||ay<0||ax+w>g.w||ay+w>g.h{return false;}
    let w0=ax>>5;let base=g.bits.add((layer*g.plane+ay*g.stride+w0) as usize);
    let m=((1u64<<w)-1)<<(ax&31);
    let st=g.stride as usize;
    match own{
        None=>{for j in 0..w as usize{if (base.add(j*st) as *const u64).read_unaligned()&m!=0{return false;}}}
        Some((ox,oy,ow))=>{
            let om=!span64(ox-(w0<<5),ow);let (y0,y1)=(oy-ay,oy-ay+ow);
            for j in 0..w{
                let mm=if j>=y0&&j<y1{m&om}else{m};
                if (base.add(j as usize*st) as *const u64).read_unaligned()&mm!=0{return false;}
            }
        }
    }
    true
}
/// A one-cell move of a w-wide footprint from anchor (ox, oy) by (dx, dy) (each -1..1, not both 0; the old anchor in
/// the map): the cells it enters are free (the row it enters, one 64-bit read; the column, a bit a row). The same answer
/// as fits() with its own footprint left out, without the own mask.
#[cfg_attr(not(feature="prof"),inline(always))]
#[cfg_attr(feature="prof",inline(never))]
unsafe fn fits_step(g:&Grid,ox:i32,oy:i32,dx:i32,dy:i32,w:i32,layer:i32)->bool{
    occdiag!(g,49);
    let (ax,ay)=(ox+dx,oy+dy);
    if ax<0||ay<0||ax+w>g.w||ay+w>g.h{return false;}
    let pl=g.bits.add((layer*g.plane) as usize);
    if dy!=0{
        let r=if dy>0{ay+w-1}else{ay};
        let p=pl.add((r*g.stride+(ax>>5)) as usize) as *const u64;
        if p.read_unaligned()&(((1u64<<w)-1)<<(ax&31))!=0{return false;}
    }
    if dx!=0{
        let c=if dx>0{ax+w-1}else{ax};let bit=1u32<<(c&31);
        let mut p=pl.add((ay*g.stride+(c>>5)) as usize);
        // (The rows the row test above did not cover.)
        let n=if dy!=0{w-1}else{w};if dy>0{}else if dy<0{p=p.add(g.stride as usize);}
        let mut hit=0u32;for _ in 0..n{hit|=*p;p=p.add(g.stride as usize);}
        if hit&bit!=0{return false;}
    }
    true
}
/// Any of the cells [x0, x0 + n) of row r taken (one 64-bit read; n <= 32).
#[inline(always)]
unsafe fn row_taken(g:&Grid,r:i32,x0:i32,n:i32,layer:i32)->bool{
    let p=g.bits.add((layer*g.plane+r*g.stride+(x0>>5)) as usize) as *const u64;
    p.read_unaligned()&(((1u64<<n)-1)<<(x0&31))!=0
}
/// Any of the cells of column c, rows [y0, y0 + n), taken (a bit a row).
#[inline(always)]
unsafe fn col_taken(g:&Grid,c:i32,y0:i32,n:i32,layer:i32)->bool{
    let mut p=g.bits.add((layer*g.plane+y0*g.stride+(c>>5)) as usize);let mut hit=0u32;
    for _ in 0..n{hit|=*p;p=p.add(g.stride as usize);}
    hit&(1u32<<(c&31))!=0
}
/// A mover's place (shifted positions, from (ox, oy) to (tx, ty), its anchor in the map or its margins) held a quarter
/// cell past its cell's middle on each axis it moved along toward a taken neighbour cell (or where it was, when that was
/// further already). A footprint is its anchor cell's; the unit's square overhangs it by its offset from the cell's
/// middle, so two facing units that closed up to their cells' edges overlapped by a whole cell (a 1-cell worker by its
/// whole size: separation-rally's packed crowd sat on itself). Held, facing units overlap by at most half a cell. (At
/// the middle itself head-on walkers lost 12% of their progress: they no longer came within reach of the swap; a
/// quarter cell keeps it.) The neighbour test reads no own cell: the old footprint lies behind the step.
#[cfg_attr(not(feature="prof"),inline(always))]
#[cfg_attr(feature="prof",inline(never))]
unsafe fn hold_mid(g:&Grid,ox:i32,oy:i32,tx:i32,ty:i32,w:i32,layer:i32)->(i32,i32){
    let sh=OCC_SH;let (half,q)=(OCC_CELL>>1,OCC_CELL>>2);
    let (ax,ay)=(tx>>sh,ty>>sh);if ax<0||ay<0||ax+w>g.w||ay+w>g.h{return (tx,ty);}
    let (mx,my)=((ax<<sh)+half,(ay<<sh)+half);
    let (mut x,mut y)=(tx,ty);
    if tx>ox&&tx>mx+q{if col_taken(g,ax+w,ay,w,layer){x=(mx+q).max(ox);}}
    else if tx<ox&&tx<mx-q{if col_taken(g,ax-1,ay,w,layer){x=(mx-q).min(ox);}}
    if ty>oy&&ty>my+q{if row_taken(g,ay+w,ax,w,layer){y=(my+q).max(oy);}}
    else if ty<oy&&ty<my-q{if row_taken(g,ay-1,ax,w,layer){y=(my-q).min(oy);}}
    (x,y)
}
/// The w x w cells at anchor (ax, ay) marked (mark) or cleared, the parts past the map's edges left out; the coarse
/// counts kept.
#[cfg_attr(not(feature="prof"),inline(always))]
#[cfg_attr(feature="prof",inline(never))]
unsafe fn paint(g:&Grid,ax:i32,ay:i32,w:i32,layer:i32,mark:bool){
    if mark {occdiag!(g,45);}else{occdiag!(g,46);}
    let (a,b)=(ax.max(0),(ax+w).min(g.w));let (y0,y1)=(ay.max(0),(ay+w).min(g.h));
    if a>=b||y0>=y1{return;}
    let w0=a>>5;let m=((1u64<<(b-a))-1)<<(a&31);
    rows64(g,layer,y0,y1-1,w0,true,|_|if mark{(0,m)}else{(m,0)});
}
/// A w-wide footprint at (x, y) (eighths) marked or cleared.
#[inline(always)]
unsafe fn clear_or_mark(g:&Grid,x:i32,y:i32,w:i32,layer:i32,mark:bool){paint(g,anchor(g,x,w),anchor(g,y,w),w,layer,mark)}
/// A w-wide footprint fits at (x, y) (eighths), the footprint at (ox, oy) of width ow on plane ol left out (ow 0: none).
#[inline(always)]
unsafe fn free(g:&Grid,x:i32,y:i32,w:i32,layer:i32,ox:i32,oy:i32,ow:i32,ol:i32)->bool{
    if x<0||y<0{return false;}
    let own=if ol==layer&&ow>0{Some((anchor(g,ox,ow),anchor(g,oy,ow),ow))}else{None};
    fits(g,anchor(g,x,w),anchor(g,y,w),w,layer,own)
}
/// The taken cells of the map (margins and the cells past its last column left out): the audit's count.
#[no_mangle]
pub unsafe extern "C" fn occ_count(bits:u32,w:i32,h:i32,stride:i32,planes:i32)->i32 {
    let o=origin(waddr(bits) as *mut u32,stride);let full=w>>5;let tail=if w&31!=0{(1u32<<(w&31))-1}else{0};
    let mut n=0;
    for l in 0..planes{for y in 0..h{
        let row=o.add((l*occ_plane(stride,h)+y*stride) as usize);
        for i in 0..full as usize{n+=(*row.add(i)).count_ones() as i32;}
        if tail!=0{n+=(*row.add(full as usize)&tail).count_ones() as i32;}
    }}
    n
}
/// The bitmap array's layout (sim_occupancy.js checks its own against it): OCC_MY margin rows, then the counts (1 << 8),
/// square footprints anchored at their middle (2 << 8), the cell in eighths (<< 16).
#[no_mangle]
pub extern "C" fn occ_layout()->i32{OCC_MY|(3<<8)|(OCC_CELL<<16)}
/// The coarse cells whose kept count differs from the bitmap's (the audit: 0).
#[no_mangle]
pub unsafe extern "C" fn occ_counts_bad(bits:u32,w:i32,h:i32,stride:i32,planes:i32)->i32{
    let base=waddr(bits) as *mut u32;let o=origin(base,stride);let cnt=occ_counts(base,stride,h,planes);
    let (cw,ch)=((w+31)>>5,(h+31)>>5);let tail=if w&31!=0{(1u32<<(w&31))-1}else{u32::MAX};
    let mut bad=0;
    for l in 0..planes{for cy in 0..ch{for cx in 0..cw{
        let mut n=0i32;
        for yy in cy*32..((cy+1)*32).min(h){n+=(*o.add((l*occ_plane(stride,h)+yy*stride+cx) as usize)&if cx==cw-1{tail}else{u32::MAX}).count_ones() as i32;}
        if n!=*cnt.add(((l*ch+cy)*cw+cx) as usize){bad+=1;}
    }}}
    bad
}
/// The margins set taken (allocation and rebuild: the array zeroed before): every plane's margin rows, each map row's
/// last word, and the cells past the map's last column in the word before it.
#[no_mangle]
pub unsafe extern "C" fn occ_margins(bits:u32,w:i32,h:i32,stride:i32,planes:i32){
    let base=waddr(bits) as *mut u32;let full=w>>5;let tail=if w&31!=0{!((1u32<<(w&31))-1)}else{0};
    for l in 0..planes{
        let p=base.add((l*occ_plane(stride,h)) as usize);
        for i in 0..(OCC_MY*stride) as usize{*p.add(i)=u32::MAX;}
        let q=p.add(((OCC_MY+h)*stride) as usize);
        for i in 0..(OCC_MY*stride) as usize{*q.add(i)=u32::MAX;}
        for y in 0..h{
            let row=p.add(((OCC_MY+y)*stride) as usize);
            for i in full+(tail!=0) as i32..stride{*row.add(i as usize)=u32::MAX;}
            if tail!=0{*row.add(full as usize)|=tail;}
        }
    }
}
#[inline(always)]
fn word_mask(a:i32,b:i32,word:i32)->u32 {
    let lo=a.max(word*32)-word*32; let hi=b.min(word*32+31)-word*32;
    if lo>hi || lo>31 || hi<0 { 0 } else { (u32::MAX << lo) & (u32::MAX >> (31-hi)) }
}
/// A spawn's footprint place (occ_spawn's search, nothing marked): the free place nearest (x, y) by rings of cells, at most
/// search rings out; None when there is none. (spr.rs k_spawn_births: the place found before the slot is taken.)
pub(crate) unsafe fn occ_find(bits:*mut u32,mask:*const i8,w:i32,h:i32,stride:i32,cell:i32,planes:i32,x:i32,y:i32,fw:i32,layer:i32,search:i32)->Option<(i32,i32)> {
    let g=mkgrid(bits,mask,w,h,stride,cell,planes,core::ptr::null_mut(),true);
    let (fw,layer)=(fw.max(1).min(OCC_WMAX),layer.max(0).min(planes-1));
    // (The first rings place by place: most spawns find a place there. Past them, the window at once.)
    if search>OCC_NEAR && search<=OCC_WIN_S && x>=0 && y>=0 {
        if let Some(p)=find_rings(&g,x,y,fw,layer,OCC_NEAR) { return Some(p); }
        return find_win64(&g,x,y,fw,layer,search);
    }
    find_rings(&g,x,y,fw,layer,search)
}
/// occ_find as a test of each place in turn (the reference: occ_find_cmp).
unsafe fn find_rings(g:&Grid,x:i32,y:i32,fw:i32,layer:i32,search:i32)->Option<(i32,i32)> {
    let cell=OCC_CELL;
    if free(g,x,y,fw,layer,0,0,0,-1) {return Some((x,y));}
    for d in 1..=search {
        for dy in -d..=d {for dx in -d..=d {
            if dx.abs()!=d && dy.abs()!=d {continue;}
            let (tx,ty)=(x+dx*cell,y+dy*cell);
            if free(g,tx,ty,fw,layer,0,0,0,-1){return Some((tx,ty));}
        }}
    }
    None
}
const OCC_WIN_S:i32=32;
const OCC_NEAR:i32=2;
/// Columns [c, c+64) of map row yy (layer) as bits, cells off the map taken.
#[inline(always)]
unsafe fn row64(g:&Grid,layer:i32,yy:i32,c:i32)->u64 {
    if yy<0 || yy>=g.h { return u64::MAX; }
    let row=g.bits.add((layer*g.plane+yy*g.stride) as usize);
    let w0=c>>5; let sh=(c-(w0<<5)) as u32;
    let wd=|k:i32|->u64 { let x=w0+k; (if x<0 || (x<<5)>=g.w {u32::MAX} else {*row.add(x as usize)}) as u64 };
    let lo=wd(0)|(wd(1)<<32);
    let mut v=if sh==0 {lo} else {(lo>>sh)|(wd(2)<<(64-sh))};
    if c<0 { let n=(-c).min(64) as u32; v|=if n>=64 {u64::MAX} else {(1u64<<n)-1}; }
    let past=g.w-c;
    if past<64 { v|=if past<=0 {u64::MAX} else {u64::MAX<<(past as u32)}; }
    v
}
/// Each bit j: any of bits j..j+n of v (n < 64).
#[inline(always)]
fn spread64(v:u64,n:i32)->u64 {
    let (mut acc,mut have)=(v,1i32);
    while have*2<=n+1 { acc|=acc>>(have as u32); have*=2; }
    if have<n+1 { acc|=acc>>((n+1-have) as u32); }
    acc
}
const WIN_ROWS:usize=2*OCC_WIN_S as usize+OCC_WMAX as usize;
/// occ_find over the whole window at once: for every anchor search rings around (x, y)'s, whether its footprint is
/// taken (the window's map rows spread by the width once, 32 anchors a word; an anchor row the OR of its w footprint
/// rows), then the rings in occ_find's order.
unsafe fn find_win64(g:&Grid,x:i32,y:i32,fw:i32,layer:i32,search:i32)->Option<(i32,i32)> {
    let (ax0,ay0)=(anchor(g,x,fw),anchor(g,y,fw));
    let n=2*search+1;let nch=(n+31)>>5;let rows=n+fw-1;
    let mut blk=[0u32;3*(2*OCC_WIN_S as usize+1)];
    let mut sp=[0u32;3*WIN_ROWS];
    for t in 0..rows { let yy=ay0-search+t; for ch in 0..nch {
        *sp.get_unchecked_mut((t*3+ch) as usize)=spread64(row64(g,layer,yy,ax0-search+32*ch),fw-1) as u32;
    }}
    for j in 0..n { for dy in 0..fw { let t=j+dy; for ch in 0..nch {
        *blk.get_unchecked_mut((j*3+ch) as usize)|=*sp.get_unchecked((t*3+ch) as usize);
    }}}
    ring_scan(&blk,search,x,y,OCC_CELL)
}
/// The first free centre in occ_find's order (rings out; in a ring by row, then column) of the blocked bits (rows of
/// three words, centre (search, search)): a ring's first and last rows as words, its sides as two bits a row.
unsafe fn ring_scan(blk:&[u32],search:i32,x:i32,y:i32,cell:i32)->Option<(i32,i32)> {
    let bit=|i:i32,j:i32|->bool { (*blk.get_unchecked((j*3+(i>>5)) as usize)>>(i&31))&1!=0 };
    // The lowest free column of row j in [a, b].
    let first=|j:i32,a:i32,b:i32|->i32 {
        let mut i=a;
        while i<=b {
            let w=*blk.get_unchecked((j*3+(i>>5)) as usize)>>(i&31);
            let f=(!w).trailing_zeros() as i32;
            if f<32-(i&31) { let c=i+f; return if c<=b {c} else {-1}; }
            i=(i|31)+1;
        }
        -1
    };
    let s=search;
    if !bit(s,s) { return Some((x,y)); }
    for d in 1..=s {
        let c=first(s-d,s-d,s+d);
        if c>=0 { return Some((x+(c-s)*cell,y-d*cell)); }
        for dy in 1-d..d {
            let j=s+dy;
            if !bit(s-d,j) { return Some((x-d*cell,y+dy*cell)); }
            if !bit(s+d,j) { return Some((x+d*cell,y+dy*cell)); }
        }
        let c=first(s+d,s-d,s+d);
        if c>=0 { return Some((x+(c-s)*cell,y+d*cell)); }
    }
    None
}
/// occ_find's window search against the place-by-place one (tests/occ-find-window.test.cjs): the two packed results
/// (x * 65536 + y, -1 none) in out[0], out[1].
#[no_mangle]
pub unsafe extern "C" fn occ_find_cmp(bits:u32,mask:u32,w:i32,h:i32,stride:i32,cell:i32,planes:i32,x:i32,y:i32,fw:i32,layer:i32,search:i32,out:u32) {
    let (b,m)=(waddr(bits) as *mut u32,waddr(mask) as *const i8);
    let o=waddr(out) as *mut i32;
    let pk=|p:Option<(i32,i32)>|p.map_or(-1,|(a,c)|a*65536+c);
    *o=pk(occ_find(b,m,w,h,stride,cell,planes,x,y,fw,layer,search));
    let g=mkgrid(b,m,w,h,stride,cell,planes,core::ptr::null_mut(),true);
    *o.add(1)=pk(find_rings(&g,x,y,fw.max(1).min(OCC_WMAX),layer.max(0).min(planes-1),search));
}
/// The footprint marked at (x, y) and slot s's record written (occ_spawn's end).
pub(crate) unsafe fn occ_mark(bits:*mut u32,mask:*const i8,rec:*mut i32,w:i32,h:i32,stride:i32,cell:i32,planes:i32,s:usize,x:i32,y:i32,fw:i32,layer:i32) {
    let g=mkgrid(bits,mask,w,h,stride,cell,planes,core::ptr::null_mut(),true);
    let layer=layer.max(0).min(planes-1);let fw=fw.max(1).min(OCC_WMAX);
    clear_or_mark(&g,x,y,fw,layer,true);
    let p=rec.add(s*4);
    *p=x;*p.add(1)=y;*p.add(2)=(fw&255)|((layer&255)<<8)|(1<<16)|(*p.add(2)&(255<<24));
}
#[no_mangle]
pub unsafe extern "C" fn occ_spawn(bits:u32,mask:u32,rec:u32,
    w:i32,h:i32,stride:i32,cell:i32,planes:i32,s:i32,x:i32,y:i32,fw:i32,layer:i32,search:i32)->i32 {
    let (b,m)=(waddr(bits) as *mut u32,waddr(mask) as *const i8);
    match occ_find(b,m,w,h,stride,cell,planes,x,y,fw,layer,search) {
        Some((tx,ty))=>{occ_mark(b,m,waddr(rec) as *mut i32,w,h,stride,cell,planes,s as usize,tx,ty,fw,layer);1}
        None=>0,
    }
}
#[no_mangle]
pub unsafe extern "C" fn occ_release(bits:u32,mask:u32,rec:u32,
    w:i32,h:i32,stride:i32,cell:i32,planes:i32,s:i32) {
    let p=(waddr(rec) as *mut i32).add(s as usize*4);let s=s as usize;let meta=*p.add(2);if (meta>>16)&255==0{return;}
    let g=mkgrid(waddr(bits) as *mut u32,waddr(mask) as *const i8,w,h,stride,cell,planes,core::ptr::null_mut(),true);
    clear_or_mark(&g,*p,*p.add(1),(meta&255).max(1).min(OCC_WMAX),(meta>>8)&255,false);
    *p.add(2)=meta&!(255<<16);
}
/// A w-wide mover's sweep from (ox, oy) to (nx, ny), shifted positions (the anchor is the position's cell), against
/// the other footprints: where it stops.
#[inline(never)]
unsafe fn motion_s(g:&Grid,ox:i32,oy:i32,nx:i32,ny:i32,w:i32,layer:i32)->(i32,i32) {
    occdiag!(g,41);
    let (ocx,ocy)=(cell_coord(g,ox),cell_coord(g,oy));
    if cell_coord(g,nx)==ocx && cell_coord(g,ny)==ocy {occdiag!(g,42);return (nx,ny);}
    let own=Some((ocx,ocy,w));
    if (nx-ox).abs().max((ny-oy).abs())<=OCC_CELL {
        return if fits_step(g,ocx,ocy,cell_coord(g,nx)-ocx,cell_coord(g,ny)-ocy,w,layer) {(nx,ny)}else{(ox,oy)};
    }
    if cell_coord(g,ny)==ocy && ocx>=0 && ocx+w<=g.w && ocy>=0 && ocy+w<=g.h {
        return horizontal_motion(g,ox,oy,nx,ny,w,layer,ocx,ocy);
    }
    let dx=nx-ox;let dy=ny-oy;let steps=pdiv(dx.abs().max(dy.abs())+OCC_CELL-1,OCC_CELL).max(1);
    let mut x=ox;let mut y=oy;
    for i in 1..=steps {
        let tx=ox+idiv(dx*i,steps);let ty=oy+idiv(dy*i,steps);
        if !fits(g,cell_coord(g,tx),cell_coord(g,ty),w,layer,own){break;}x=tx;y=ty;
    }
    (x,y)
}

// A same-row sweep (shifted positions; anchor (cx, cy) in the map) tests the columns newly entered, a word at a time,
// instead of the whole footprint at every step; the first hit back to the discrete sweep's step.
#[inline(never)]
unsafe fn horizontal_motion(g:&Grid,ox:i32,oy:i32,nx:i32,ny:i32,w:i32,layer:i32,cx:i32,cy:i32)->(i32,i32){
    let dx=nx-ox;let target=cell_coord(g,nx);
    let mut allowed=target.max(0).min(g.w-w);
    for row in 0..w{
        let base=g.bits.add((layer*g.plane+(cy+row)*g.stride) as usize);
        if dx>0{
            let left=cx+w;let right=allowed+w-1;
            if right>=left{for word in (left>>5)..=(right>>5){
                let hit=*base.add(word as usize)&word_mask(left,right,word);
                if hit!=0{allowed=allowed.min(word*32+hit.trailing_zeros() as i32-w);break;}
            }}
        }else{
            let left=allowed;let right=cx-1;
            if right>=left{let mut word=right>>5;while word>=left>>5{
                let hit=*base.add(word as usize)&word_mask(left,right,word);
                if hit!=0{allowed=allowed.max(word*32+31-hit.leading_zeros() as i32+1);break;}word-=1;
            }}
        }
        if allowed==cx{break;}
    }
    horizontal_end(g,ox,oy,nx,ny,allowed,target)
}
/// A same-row sweep's end (shifted positions): the last anchor it may take (allowed) back to the discrete sweep step.
#[inline(always)]
fn horizontal_end(g:&Grid,ox:i32,oy:i32,nx:i32,ny:i32,allowed:i32,target:i32)->(i32,i32){
    if allowed==target{return (nx,ny);}
    let dx=nx-ox;let dy=ny-oy;
    let steps=pdiv(dx.abs().max(dy.abs())+OCC_CELL-1,OCC_CELL).max(1);
    let threshold=if dx>0{(allowed+1)*OCC_CELL-ox}else{ox-allowed*OCC_CELL+1};
    let first=idiv(threshold*steps+dx.abs()-1,dx.abs());let done=(first-1).max(0).min(steps);
    (ox+idiv(dx*done,steps),oy+idiv(dy*done,steps))
}

/// A footprint moved from (ox, oy) to (tx, ty) (eighths): cleared where it was, marked where it is (rows64: a
/// 64-bit read-modify-write a row, the coarse counts kept). (A union-row delta write measured slower.)
#[inline(always)]
unsafe fn move_footprint(g:&Grid,ox:i32,oy:i32,tx:i32,ty:i32,w:i32,layer:i32){
    clear_or_mark(g,ox,oy,w,layer,false);clear_or_mark(g,tx,ty,w,layer,true);
}

// ---- legal-anchor fields (widths 1-4) ----
// One mover's nearby anchors, offsets -K..K+1 on each axis from its own anchor (oax, oay): row j (offset j-K), bit i
// (offset i-K) set = its footprint does not fit there (another footprint, or past the map's edge: the margins read as
// taken). K 3 (8 x 8 anchors, steps up to 3 cells) or 7 (16 x 16, up to 7). Its own footprint is masked out of the
// patch in registers only. Built once per position and read by every motion of it (the wanted step, its two slides,
// the shoulders): the answers fits() gives, without its row reads. W = width - 1: a footprint covers its anchor's
// patch column and W to the right, its row and W below.
#[derive(Clone,Copy)]
pub(super) struct Field{rows:[u16;16],k:i32}
/// The 8 x 8 field (K 3): 8 + W patch rows of 16 bits, i16x8 lanes.
#[inline(always)]
unsafe fn field8<const W:i32>(g:&Grid,oax:i32,oay:i32,layer:i32)->Field{
    let c0=oax-3;let y0=oay-3;
    // (The own anchor in the map (preview checks): the patch lies within the margins, whose cells read as taken: the
    // rows straight into lanes, one unaligned 64-bit read each, no edge tests; the own footprint (rows and columns
    // 3..=3+W, inside the map) cleared by a constant.)
    let st=g.stride as usize;let base=g.bits.add((layer*g.plane+y0*g.stride+(c0>>5)) as usize);let sh=(c0&31) as u32;
    let rd=|k:usize|((base.add(k*st) as *const u64).read_unaligned()>>sh) as u16;
    let v0=u16x8(rd(0),rd(1),rd(2),rd(3),rd(4),rd(5),rd(6),rd(7));
    let v1=match W{0=>u16x8_splat(0),1=>u16x8(rd(8),0,0,0,0,0,0,0),2=>u16x8(rd(8),rd(9),0,0,0,0,0,0),_=>u16x8(rd(8),rd(9),rd(10),0,0,0,0,0)};
    let o=!(((1u16<<(W+1))-1)<<3);let f=0xFFFFu16;
    let own=match W{0=>u16x8(f,f,f,o,f,f,f,f),1=>u16x8(f,f,f,o,o,f,f,f),2=>u16x8(f,f,f,o,o,o,f,f),_=>u16x8(f,f,f,o,o,o,o,f)};
    let v0=v128_and(v0,own);
    // Across: an anchor's footprint covers its patch column and W to the right.
    let dil=|v:v128|->v128{
        match W{0=>v,1=>v128_or(v,u16x8_shr(v,1)),
            2=>{let a=v128_or(v,u16x8_shr(v,1));v128_or(a,u16x8_shr(v,2))},
            _=>{let a=v128_or(v,u16x8_shr(v,1));v128_or(a,u16x8_shr(a,2))}}
    };
    let (d0,d1)=(dil(v0),dil(v1));
    // Down: patch rows j..=j+W.
    let mut out=d0;
    if W>=1{out=v128_or(out,i16x8_shuffle::<1,2,3,4,5,6,7,8>(d0,d1));}
    if W>=2{out=v128_or(out,i16x8_shuffle::<2,3,4,5,6,7,8,9>(d0,d1));}
    if W>=3{out=v128_or(out,i16x8_shuffle::<3,4,5,6,7,8,9,10>(d0,d1));}
    let mut fl=Field{rows:[0;16],k:3};
    v128_store(fl.rows.as_mut_ptr() as *mut v128,v128_and(out,i16x8_splat(0xFF)));
    fl
}
/// The 16 x 16 field (K 7): 16 + W patch rows of up to 19 bits, i32x4 lanes (four rows a vector).
#[inline(always)]
unsafe fn field16<const W:i32>(g:&Grid,oax:i32,oay:i32,layer:i32)->Field{
    let c0=oax-7;let y0=oay-7;
    let st=g.stride as usize;let base=g.bits.add((layer*g.plane+y0*g.stride+(c0>>5)) as usize);let sh=(c0&31) as u32;
    let rd=|k:usize|((base.add(k*st) as *const u64).read_unaligned()>>sh) as u32;
    let row4=|k:usize|u32x4(rd(k),rd(k+1),rd(k+2),rd(k+3));
    let o=!(((1u32<<(W+1))-1)<<7);let f=u32::MAX;
    // (The own footprint: patch rows and columns 7..=7+W.)
    let v0=row4(0);
    let v1=v128_and(row4(4),u32x4(f,f,f,o));
    let v2=match W{0=>row4(8),1=>v128_and(row4(8),u32x4(o,f,f,f)),2=>v128_and(row4(8),u32x4(o,o,f,f)),_=>v128_and(row4(8),u32x4(o,o,o,f))};
    let v3=row4(12);
    let v4=match W{0=>u32x4_splat(0),1=>u32x4(rd(16),0,0,0),2=>u32x4(rd(16),rd(17),0,0),_=>u32x4(rd(16),rd(17),rd(18),0)};
    let dil=|v:v128|->v128{
        match W{0=>v,1=>v128_or(v,u32x4_shr(v,1)),
            2=>{let a=v128_or(v,u32x4_shr(v,1));v128_or(a,u32x4_shr(v,2))},
            _=>{let a=v128_or(v,u32x4_shr(v,1));v128_or(a,u32x4_shr(a,2))}}
    };
    let (d0,d1,d2,d3,d4)=(dil(v0),dil(v1),dil(v2),dil(v3),dil(v4));
    // Down: rows 4q..4q+3 of the field from patch vectors q and q + 1.
    let down=|a:v128,b:v128|->v128{
        let mut out=a;
        if W>=1{out=v128_or(out,i32x4_shuffle::<1,2,3,4>(a,b));}
        if W>=2{out=v128_or(out,i32x4_shuffle::<2,3,4,5>(a,b));}
        if W>=3{out=v128_or(out,i32x4_shuffle::<3,4,5,6>(a,b));}
        v128_and(out,u32x4_splat(0xFFFF))
    };
    let mut fl=Field{rows:[0;16],k:7};
    v128_store(fl.rows.as_mut_ptr() as *mut v128,u16x8_narrow_i32x4(down(d0,d1),down(d1,d2)));
    v128_store(fl.rows.as_mut_ptr().add(8) as *mut v128,u16x8_narrow_i32x4(down(d2,d3),down(d3,d4)));
    fl
}
/// The field of a mover of any width w (1..=OCC_WMAX; field8 / field16 are the 1-4 ones in 16-bit lanes): the patch's
/// 2K + 2 + W rows as 64 bits each (columns from the field's first, its own footprint's rows and columns cleared),
/// two rows a vector: spread across by W (bit i: any of i..=i+W, doubling shifts), then down (row j: any of rows
/// j..=j+W, doubling ORs in place, each row read before it is written), the low 2K + 2 bits of the first 2K + 2 rows.
/// (Reads: rows oay - K .. oay + K + 1 + W, within the margins for an anchor in the map; three words a row from the
/// patch's first column's word, bits past the patch only ever reach columns past the field, masked off.)
#[cfg_attr(not(feature="prof"),inline(always))]
#[cfg_attr(feature="prof",inline(never))]
unsafe fn field_any(g:&Grid,oax:i32,oay:i32,w:i32,layer:i32,wide:bool)->Field{
    let k=if wide{7}else{3};let n=2*k+2;let ww=(w-1).max(0).min(OCC_WMAX-1);
    let (c0,y0)=(oax-k,oay-k);let rows=(n+ww) as usize;
    let st=g.stride as usize;let base=g.bits.add((layer*g.plane+y0*g.stride+(c0>>5)) as usize);let sh=(c0&31) as u32;
    let own=!(((1u64<<(ww+1))-1)<<k);
    // (48 rows: 16 + 31 at most, padded to whole vectors.)
    let mut h=[0u64;48];
    for t in 0..rows{
        let p=base.add(t*st);
        let v=((p as *const u64).read_unaligned()>>sh)|((((*p.add(2)) as u64)<<1)<<(63-sh));
        let o=(t as i32-k) as u32<=ww as u32;
        *h.get_unchecked_mut(t)=if o{v&own}else{v};
    }
    let hp=h.as_mut_ptr();let nv=(rows+1)>>1;
    // Across: bit i of a row is any of bits i..=i+W.
    for t in 0..nv{
        let a=v128_load(hp.add(2*t) as *const v128);
        let (mut acc,mut have)=(a,1i32);
        while have*2<=ww+1{acc=v128_or(acc,u64x2_shr(acc,have as u32));have*=2;}
        if have<ww+1{acc=v128_or(acc,u64x2_shr(acc,(ww+1-have) as u32));}
        v128_store(hp.add(2*t) as *mut v128,acc);
    }
    // Down: row j is any of rows j..=j+W (windows doubled in place).
    let down=|s:usize|{let mut j=0usize;while j+s<rows{
        let a=v128_load(hp.add(j) as *const v128);let b=(hp.add(j+s) as *const v128).read_unaligned();
        v128_store(hp.add(j) as *mut v128,v128_or(a,b));j+=2;}};
    let mut have=1i32;
    while have*2<=ww+1{down(have as usize);have*=2;}
    if have<ww+1{down((ww+1-have) as usize);}
    let mut fl=Field{rows:[0;16],k};let m=(1u64<<n)-1;
    for j in 0..n as usize{*fl.rows.get_unchecked_mut(j)=(*h.get_unchecked(j)&m) as u16;}
    fl
}
/// A mover's field at its anchor (oax, oay): widths 1-4 in 16-bit lanes, any other by field_any.
#[cfg_attr(not(feature="prof"),inline(always))]
#[cfg_attr(feature="prof",inline(never))]
unsafe fn field(g:&Grid,oax:i32,oay:i32,w:i32,layer:i32,wide:bool)->Field{
    occdiag!(g,53);
    if wide{occdiag!(g,126);match w{1=>field16::<0>(g,oax,oay,layer),2=>field16::<1>(g,oax,oay,layer),3=>field16::<2>(g,oax,oay,layer),4=>field16::<3>(g,oax,oay,layer),_=>field_any(g,oax,oay,w,layer,true)}}
    else{match w{1=>field8::<0>(g,oax,oay,layer),2=>field8::<1>(g,oax,oay,layer),3=>field8::<2>(g,oax,oay,layer),4=>field8::<3>(g,oax,oay,layer),_=>field_any(g,oax,oay,w,layer,false)}}
}
impl Field{
    #[inline(always)]
    fn bit(&self,dx:i32,dy:i32)->bool{
        let k=self.k;unsafe{(*self.rows.get_unchecked(((dy+k)&15) as usize)>>((dx+k)&15))&1!=0}
    }
}
/// motion_s for a width 1-4 mover from its field f (built at its anchor), on shifted positions: the same positions.
/// Steps whose anchors leave the field's offsets take motion_s itself.
#[cfg_attr(not(feature="prof"),inline(always))]
#[cfg_attr(feature="prof",inline(never))]
unsafe fn motion_f(g:&Grid,f:&Field,ox:i32,oy:i32,nx:i32,ny:i32,w:i32,layer:i32)->(i32,i32){
    occdiag!(g,41);
    let sh=OCC_SH;let k=f.k;
    let (ocx,ocy)=(ox>>sh,oy>>sh);let (tcx,tcy)=(nx>>sh,ny>>sh);
    if tcx==ocx&&tcy==ocy{occdiag!(g,42);return (nx,ny);}
    let dx=nx-ox;let dy=ny-oy;
    // (One cell: its anchor's bit. Offsets within one.)
    if dx.abs().max(dy.abs())<=OCC_CELL{occdiag!(g,54);return if f.bit(tcx-ocx,tcy-ocy){(ox,oy)}else{(nx,ny)};}
    let (ex,ey)=(tcx-ocx,tcy-ocy);
    if ex< -k||ex>k+1||ey< -k||ey>k+1{occdiag!(g,55);return motion_s(g,ox,oy,nx,ny,w,layer);}
    if ey==0&&ocx>=0&&ocx+w<=g.w&&ocy>=0&&ocy+w<=g.h{
        // (Along its row: the first taken anchor on the way, from the field's row (offset 0).)
        occdiag!(g,62);
        let row=*f.rows.get_unchecked(k as usize) as u32;
        let allowed=if ex>0{
            let hit=row&(((1u32<<ex)-1)<<(k+1));
            if hit==0{tcx}else{ocx+hit.trailing_zeros() as i32-k-1}
        }else{
            let hit=row&(((1u32<<(-ex))-1)<<(k+ex));
            if hit==0{tcx}else{ocx+(31-hit.leading_zeros() as i32)-k+1}
        };
        return horizontal_end(g,ox,oy,nx,ny,allowed,tcx);
    }
    // (Any other: its discrete sweep's points, four at a time: the first taken one ends it.)
    let steps=pdiv(dx.abs().max(dy.abs())+OCC_CELL-1,OCC_CELL).max(1);
    if steps>16{occdiag!(g,55);return motion_s(g,ox,oy,nx,ny,w,layer);}
    occdiag!(g,63);
    let lo=v128_load(f.rows.as_ptr() as *const v128);let hi16=v128_load(f.rows.as_ptr().add(8) as *const v128);
    let bits=u8x16(1,2,4,8,16,32,64,128,0,0,0,0,0,0,0,0);
    let (vdx,vdy,vs)=(f32x4_splat(dx as f32),f32x4_splat(dy as f32),f32x4_splat(steps as f32));
    let (vox,voy)=(i32x4_splat(ox),i32x4_splat(oy));
    let (bx,by)=(i32x4_splat(ocx-k),i32x4_splat(ocy-k));
    let span=i32x4_splat(2*k+1);let hi=i32x4_splat(0x80808000u32 as i32);let s16=i32x4_splat(16);
    let mut last=(ox,oy);
    let mut i0=0;
    while i0<steps{
        // (dx * i / steps truncated: exact in f32 for these magnitudes: a non-integer quotient is >= 1/16 from one.)
        let iv=f32x4_convert_i32x4(i32x4(i0+1,i0+2,i0+3,i0+4));
        let px=i32x4_add(vox,i32x4_trunc_sat_f32x4(f32x4_div(f32x4_mul(vdx,iv),vs)));
        let py=i32x4_add(voy,i32x4_trunc_sat_f32x4(f32x4_div(f32x4_mul(vdy,iv),vs)));
        let cx=i32x4_sub(i32x4_shr(px,sh),bx);let cy=i32x4_sub(i32x4_shr(py,sh),by);
        let lanes=(steps-i0).min(4);let valid=(1u32<<lanes)-1;
        if (i32x4_bitmask(v128_or(u32x4_gt(cx,span),u32x4_gt(cy,span))) as u32)&valid!=0{
            occdiag!(g,55);return motion_s(g,ox,oy,nx,ny,w,layer);
        }
        // (Each point's field byte (row * 2 + column / 8, of 32) and bit (column % 8), looked up in registers.)
        let byte=i32x4_add(i32x4_shl(cy,1),i32x4_shr(cx,3));
        let rowb=v128_or(u8x16_swizzle(lo,v128_or(byte,hi)),u8x16_swizzle(hi16,v128_or(i32x4_sub(byte,s16),hi)));
        let col=u8x16_swizzle(bits,v128_or(v128_and(cx,i32x4_splat(7)),hi));
        let taken=(i32x4_bitmask(i32x4_ne(v128_and(rowb,col),i32x4_splat(0))) as u32)&valid;
        let xs:[i32;4]=core::mem::transmute(px);let ys:[i32;4]=core::mem::transmute(py);
        if taken!=0{
            let j=taken.trailing_zeros() as usize;
            if j==0{return last;}
            return (*xs.get_unchecked(j-1),*ys.get_unchecked(j-1));
        }
        last=(*xs.get_unchecked(lanes as usize-1),*ys.get_unchecked(lanes as usize-1));
        i0+=4;
    }
    last
}

// Loaded once per spatial movement job, then used at each position write.
pub(super) struct MoveGrid {
    // The mover table (mvt.rs): its rows' positions are written where the footprint records are (commit_preview, swap).
    // cur: the slot the job is at and its row (the job walks rows: no look-up for its own).
    pub(super) rows:super::mvt::Rows, cur:core::cell::Cell<(usize,i32)>,
    g:Grid, rec:*mut i32, stats:*mut i32, blockq:i32, bx:i32, by:i32,
    // The tick-start unit index (per chunk: slots, start, count, stamp).
    ix_slot:*const i32, ix_start:*const i32, ix_count:*const i32, ix_stamp:*const i32,
    cw:i32, ch:i32, epoch:i32, chq:i32,
    // This job's cross-block swap list ([count, slots...]; null: none).
    xsw:*mut i32,
    // The (start, count) of every chunk of this block and the ring around it, made once per job (cache_chunks): the
    // swap's look at 3x3 chunks read three index tables at each of them, nine lines a call.
    // (Made at the job's first look: most jobs' units never look for a swap.)
    lc:core::cell::Cell<*const i32>, lcx:core::cell::Cell<i32>, lcy:core::cell::Cell<i32>, lcn:core::cell::Cell<i32>,
    lcb:*mut i32, lcc:usize, lcbk:i32, lcm:core::cell::Cell<bool>,
    // (Inside the map: the rows of the cache filled so far, a bit a row: a look at 3 x 3 chunks fills its 3 rows.)
    lrows:core::cell::Cell<u32>,
    // (A summary a cached chunk for the swap's look (mv.rs swap_summary): u32::MAX until made; set unmade by fill_row.)
    lsum:*mut u32,
    // The legal-centre field of the mover last resolved (slot, x, y; slot -1: none) and its bits: every bitmap write
    // of this job (commit_preview, swap) drops it.
    fk:core::cell::Cell<(i32,i32,i32)>, fv:core::cell::Cell<Field>,
    // Wall grids seen by this job and whether its block and a ring of RING tiles around (inside the map) has no wall
    // tile in them: a segment inside that region is open without walking its tiles (mv.rs seg_clear).
    wr:core::cell::Cell<[(usize,bool);4]>, wrn:core::cell::Cell<usize>, tq:i32,
}
const RING:i32=6;
impl MoveGrid {
    /// (rows: the caller's argument block holds the mover table's arrays (the movement's jobs); a single move from the page's code does not: its writer marks the slot, sim_unit_state.js mvtM.)
    pub(super) unsafe fn load(a:*const i32,bx:i32,by:i32,job:i32,rows:bool)->Self {
        let cfg=waddr(*a.add(512+33) as u32) as *const i32;
        let get=|i| *cfg.add(i);
        let ptr=|i:usize|waddr(*a.add(512+i) as u32);
        // (The movement's jobs: their footprints' coarse cells are their own in a phase (blocks of four coarse cells,
        // the halo less than a block): plain count adds.)
        let g=mkgrid(ptr(0) as *mut u32,ptr(1) as *const i8,get(0),get(1),get(2),get(3),get(4),(a as *mut u32).add(1536),false);
        let stats=(ptr(28) as *mut i32).add(job as usize*16);
        Self{rows:if rows{super::mvt::Rows::load(a)}else{super::mvt::Rows::none()},cur:core::cell::Cell::new((usize::MAX,-1)),g,rec:ptr(2) as *mut i32,stats,
            blockq:get(7)*get(15)*get(14),bx,by,
            ix_slot:ptr(24) as *const i32,ix_start:ptr(25) as *const i32,ix_count:ptr(26) as *const i32,ix_stamp:ptr(27) as *const i32,
            cw:get(9),ch:get(10),epoch:get(11),chq:get(15)*get(14),
            xsw:if *a.add(512+34)==0{core::ptr::null_mut()}else{(ptr(34) as *mut i32).add(job as usize*48)},
            lc:core::cell::Cell::new(core::ptr::null()),lcx:core::cell::Cell::new(0),lcy:core::cell::Cell::new(0),lcn:core::cell::Cell::new(0),
            lcb:core::ptr::null_mut(),lcc:0,lcbk:0,lcm:core::cell::Cell::new(true),lrows:core::cell::Cell::new(u32::MAX),lsum:core::ptr::null_mut(),
            fk:core::cell::Cell::new((-1,0,0)),fv:core::cell::Cell::new(Field{rows:[0;16],k:3}),
            wr:core::cell::Cell::new([(0,false);4]),wrn:core::cell::Cell::new(0),tq:get(14)}
    }
    /// The chunk records of this block and one chunk around it into buf (room for 2 words a cell, `cells` cells): the tick-start
    /// index does not change during the job, so a lookup reads the buffer (a few lines) instead of three tables at the chunk.
    pub(super) unsafe fn cache_chunks(&mut self,buf:*mut i32,sum:*mut u32,cells:usize,block:i32){
        self.lcb=buf;self.lsum=sum;self.lcc=cells;self.lcbk=block;self.lcm.set(false);
    }
    #[inline(never)]
    unsafe fn fill_chunks(&self){
        self.lcm.set(true);
        let (buf,cells,block)=(self.lcb,self.lcc,self.lcbk);
        let n=block+2;
        if self.ix_slot.is_null()||block<1||(n*n) as usize>cells{self.lc.set(core::ptr::null());return;}
        let cx0=self.bx*block-1;let cy0=self.by*block-1;
        // (Inside the map: rows filled when first looked at (fill_row).)
        if cx0>=0&&cy0>=0&&cx0+n<=self.cw&&cy0+n<=self.ch&&n<=32{
            self.lrows.set(0);
            self.lc.set(buf);self.lcx.set(cx0);self.lcy.set(cy0);self.lcn.set(n);
            return;
        }
        self.lrows.set(u32::MAX);
        if !self.lsum.is_null(){for i in 0..(n*n) as usize{*self.lsum.add(i)=u32::MAX;}}
        for j in 0..n{for i in 0..n{
            let cx=cx0+i;let cy=cy0+j;let (mut a,mut c)=(0,0);
            if cx>=0&&cy>=0&&cx<self.cw&&cy<self.ch{
                let k=(cy*self.cw+cx) as usize;
                if *self.ix_stamp.add(k)==self.epoch{a=*self.ix_start.add(k);c=*self.ix_count.add(k);}
            }
            let o=((j*n+i)*2) as usize;*buf.add(o)=a;*buf.add(o+1)=c;
        }}
        self.lc.set(buf);self.lcx.set(cx0);self.lcy.set(cy0);self.lcn.set(n);
    }
    /// Row j of the chunk cache (inside the map): four chunks a step, the stamps' compare masking start and count, interleaved.
    #[inline(never)]
    unsafe fn fill_row(&self,j:i32){
        self.lrows.set(self.lrows.get()|(1u32<<j));
        let (buf,n,cx0,cy0)=(self.lc.get() as *mut i32,self.lcn.get(),self.lcx.get(),self.lcy.get());
        let ep=i32x4_splat(self.epoch);
        let k=((cy0+j)*self.cw+cx0) as usize;let o=(j*n*2) as usize;
        if !self.lsum.is_null(){for i in 0..n as usize{*self.lsum.add((j*n) as usize+i)=u32::MAX;}}
        let mut i=0usize;
        while i+4<=n as usize{
            let m=i32x4_eq(v128_load(self.ix_stamp.add(k+i) as *const v128),ep);
            let a=v128_and(v128_load(self.ix_start.add(k+i) as *const v128),m);
            let c=v128_and(v128_load(self.ix_count.add(k+i) as *const v128),m);
            v128_store(buf.add(o+2*i) as *mut v128,i32x4_shuffle::<0,4,1,5>(a,c));
            v128_store(buf.add(o+2*i+4) as *mut v128,i32x4_shuffle::<2,6,3,7>(a,c));
            i+=4;
        }
        while i<n as usize{
            let (a,c)=if *self.ix_stamp.add(k+i)==self.epoch{(*self.ix_start.add(k+i),*self.ix_count.add(k+i))}else{(0,0)};
            *buf.add(o+2*i)=a;*buf.add(o+2*i+1)=c;i+=1;
        }
    }
    /// The tile region (x0, y0, x1, y1: the block and RING tiles around, inside the map) when the wall grid wl has
    /// no wall tile in it; None otherwise. Worked out once a job and grid.
    #[inline(always)]
    pub(super) unsafe fn open_ring(&self,wl:*const u8,mw:i32,mh:i32)->Option<(i32,i32,i32,i32)>{
        let bt=self.blockq/self.tq.max(1);
        let (x0,y0)=((self.bx*bt-RING).max(0),(self.by*bt-RING).max(0));
        let (x1,y1)=(((self.bx+1)*bt+RING).min(mw),((self.by+1)*bt+RING).min(mh));
        let key=wl as usize;let n=self.wrn.get();let c=self.wr.get();
        for i in 0..n.min(4){let e=*c.get_unchecked(i);if e.0==key{return if e.1{Some((x0,y0,x1,y1))}else{None};}}
        let mut open=!wl.is_null();
        if open{'scan: for y in y0..y1{let row=wl.add((y*mw) as usize);
            let mut x=x0;while x+8<=x1{if (row.add(x as usize) as *const u64).read_unaligned()!=0{open=false;break 'scan;}x+=8;}
            while x<x1{if *row.add(x as usize)!=0{open=false;break 'scan;}x+=1;}}}
        if n<4{let mut c=c;*c.get_unchecked_mut(n)=(key,open);self.wr.set(c);self.wrn.set(n+1);}
        if open{Some((x0,y0,x1,y1))}else{None}
    }
    /// The occupancy cell's shift in eighths.
    pub(super) fn cell_shift(&self)->u32{OCC_SH}
    /// The unit the job is at: slot s, row h.
    #[inline(always)]
    pub(super) fn at(&self,s:usize,h:i32){self.cur.set((s,h));}
    #[inline(always)]
    unsafe fn row_moved(&self,s:usize,x:i32,y:i32){let (cs,ch)=self.cur.get();self.rows.moved(s,if cs==s{ch}else{-1},x,y);}
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
    pub(super) unsafe fn radius_q(&self,s:usize)->i32{(((*self.rec.add(s*4+2)&255)+1)*OCC_CELL)>>1}
    pub(super) unsafe fn active(&self,s:usize)->bool{(*self.rec.add(s*4+2)>>16)&255!=0}
    /// The index entries of the chunk at (x, y) (Q8) if it is this job's
    /// and indexed this tick: (first, end) into slot().
    pub(super) unsafe fn chunk_entries(&self,x:i32,y:i32)->(i32,i32){
        if !self.owns(x,y){return (0,0);}
        self.chunk_entries_near(x,y)
    }
    /// The same for a chunk of this block or one chunk past its edge (a
    /// neighbouring block's: its job runs in another phase).
    pub(super) unsafe fn chunk_entries_near(&self,x:i32,y:i32)->(i32,i32){let (a,e,_)=self.chunk_near_ix(x,y);(a,e)}
    /// The same and the chunk's place in the job's cache (its summary's index; -1: not cached).
    #[cfg_attr(feature="prof",inline(never))]
    pub(super) unsafe fn chunk_near_ix(&self,x:i32,y:i32)->(i32,i32,i32){
        let e=self.chq;
        if self.ix_slot.is_null()||x<0||y<0||x<self.bx*self.blockq-e||x>=(self.bx+1)*self.blockq+e||y<self.by*self.blockq-e||y>=(self.by+1)*self.blockq+e{return (0,0,-1);}
        let cx=pdiv(x,self.chq);let cy=pdiv(y,self.chq);if cx>=self.cw||cy>=self.ch{return (0,0,-1);}
        if !self.lcm.get(){self.fill_chunks();}
        let lc=self.lc.get();
        if !lc.is_null(){
            // (The bounds above keep (cx, cy) in the cached block and ring: block + 2 chunks a side.)
            let j=cy-self.lcy.get();if (self.lrows.get()>>j)&1==0{self.fill_row(j);}
            let ix=j*self.lcn.get()+(cx-self.lcx.get());let o=(ix*2) as usize;
            let a=*lc.add(o);return (a,a+*lc.add(o+1),if self.lsum.is_null(){-1}else{ix});
        }
        let k=(cy*self.cw+cx) as usize;if *self.ix_stamp.add(k)!=self.epoch{return (0,0,-1);}
        let a=*self.ix_start.add(k);(a,a+*self.ix_count.add(k),-1)
    }
    #[inline(always)]
    pub(super) unsafe fn csum(&self,ix:i32)->u32{*self.lsum.add(ix as usize)}
    #[inline(always)]
    pub(super) unsafe fn set_csum(&self,ix:i32,v:u32){*self.lsum.add(ix as usize)=v;}
    /// Slot s's first-stage word (record word 3, mv.rs FW_*).
    #[inline(always)]
    pub(super) unsafe fn fw(&self,s:usize)->i32{*self.rec.add(s*4+3)}
    pub(super) unsafe fn slot(&self,i:i32)->i32{*self.ix_slot.add(i as usize)}
    pub(super) fn chunk_q(&self)->i32{self.chq}
    pub(super) unsafe fn pos(&self,s:usize)->(i32,i32){let p=self.rec.add(s*4);(*p,*p.add(1))}
    /// Gather four packed occupancy records, transpose hot fields to SoA,
    /// and reject distant swap candidates together. A one-Q8-unit margin
    /// keeps this f32 broad phase conservative; exact f64 tests follow.
    /// Also their first-stage words (record word 3, mv.rs FW_*: class, brain mode, flags), for the caller's filter.
    #[cfg_attr(not(feature="prof"),inline(always))]
    #[cfg_attr(feature="prof",inline(never))]
    pub(super) unsafe fn swap_candidates4(&self,slots:&[i32;4],ox:i32,oy:i32,rq:i32)->(u32,v128) {
        let load=|s:i32|if s<0{i32x4_splat(0)}else{v128_load(self.rec.add(s as usize*4) as *const v128)};
        let (a,b,c,d)=(load(slots[0]),load(slots[1]),load(slots[2]),load(slots[3]));
        let ab=i32x4_shuffle::<0,4,1,5>(a,b);let cd=i32x4_shuffle::<0,4,1,5>(c,d);
        let x=i32x4_shuffle::<0,1,4,5>(ab,cd);let y=i32x4_shuffle::<2,3,6,7>(ab,cd);
        let abh=i32x4_shuffle::<2,6,3,7>(a,b);let cdh=i32x4_shuffle::<2,6,3,7>(c,d);
        let m=i32x4_shuffle::<0,1,4,5>(abh,cdh);let fw=i32x4_shuffle::<2,3,6,7>(abh,cdh);
        // (Each one's radius_q: (width + 1) / 2 cells.)
        let radius=i32x4_add(i32x4_shr(i32x4_mul(i32x4_add(v128_and(m,i32x4_splat(255)),i32x4_splat(1)),i32x4_splat(OCC_CELL)),1),i32x4_splat(rq+97));
        let dx=f32x4_convert_i32x4(i32x4_sub(x,i32x4_splat(ox)));let dy=f32x4_convert_i32x4(i32x4_sub(y,i32x4_splat(oy)));
        let r=f32x4_convert_i32x4(radius);
        let ok=v128_and(i32x4_ne(v128_and(m,i32x4_splat(255<<16)),i32x4_splat(0)),
            f32x4_le(f32x4_add(f32x4_mul(dx,dx),f32x4_mul(dy,dy)),f32x4_mul(r,r)));
        (i32x4_bitmask(ok) as u32,fw)
    }
    /// Whether (x, y) lies in this job's block (its units' tick-start tiles).
    pub(super) fn owns(&self,x:i32,y:i32)->bool{
        x>=self.bx*self.blockq&&x<(self.bx+1)*self.blockq&&y>=self.by*self.blockq&&y<(self.by+1)*self.blockq
    }
    /// a and b trade places, if both footprints fit there (same plane);
    /// else the grid is left as it was. A larger b may settle a cell or two
    /// further along (dx, dy) (b's way, unit length), or beside that.
    /// Returns b's new position.
    #[cfg_attr(feature="prof",inline(never))]
    pub(super) unsafe fn swap(&self,a:usize,b:usize,dx:f64,dy:f64)->Option<(i32,i32)>{
        let (pa,pb)=(self.rec.add(a*4),self.rec.add(b*4));let (ma,mb)=(*pa.add(2),*pb.add(2));
        if (ma>>16)&255==0||(mb>>16)&255==0||(ma>>8)&255!=(mb>>8)&255{return None;}
        let l=(ma>>8)&255;let ra=ma&255;let rb=mb&255;
        let (ax,ay)=(*pa,*pa.add(1));let (bx,by)=(*pb,*pb.add(1));
        self.field_drop();
        clear_or_mark(&self.g,ax,ay,ra,l,false);clear_or_mark(&self.g,bx,by,rb,l,false);
        if free(&self.g,bx,by,ra,l,0,0,0,-1){
            clear_or_mark(&self.g,bx,by,ra,l,true);
            let c=OCC_CELL as f64;let (px,py)=(-dy,dx);
            // (A larger partner: places near where the mover stood, back along the mover's way and to its sides, up to 4
            // cells back and 2 aside. With 10 (up to 3 back, 1 aside) a builder in a parked group of bigger fighters
            // failed 56% of its swaps, all of them for the partner's place.)
            let tries:[(f64,f64);23]=[(0.0,0.0),(1.0,0.0),(1.0,1.0),(1.0,-1.0),(2.0,0.0),(0.0,1.0),(0.0,-1.0),(2.0,1.0),(2.0,-1.0),(3.0,0.0),
                (0.0,2.0),(0.0,-2.0),(1.0,2.0),(1.0,-2.0),(2.0,2.0),(2.0,-2.0),(3.0,1.0),(3.0,-1.0),(3.0,2.0),(3.0,-2.0),(4.0,0.0),(4.0,1.0),(4.0,-1.0)];
            for k in 0..(if rb>ra{23}else{1}){
                let (f,g)=*tries.as_ptr().add(k);
                let tx=ax+js_round((dx*f+px*g)*c) as i32;let ty=ay+js_round((dy*f+py*g)*c) as i32;
                if free(&self.g,tx,ty,rb,l,0,0,0,-1){
                    clear_or_mark(&self.g,tx,ty,rb,l,true);
                    *pa=bx;*pa.add(1)=by;*pb=tx;*pb.add(1)=ty;
                    self.row_moved(a,bx,by);self.row_moved(b,tx,ty);
                    *self.stats.add(6)+=2;return Some((tx,ty));
                }
            }
            clear_or_mark(&self.g,bx,by,ra,l,false);
        }
        clear_or_mark(&self.g,ax,ay,ra,l,true);clear_or_mark(&self.g,bx,by,rb,l,true);
        None
    }
    /// Steps slot s's moves ended blocked in a row (the record's top byte, mv.rs checked_traffic_q).
    #[inline(always)]
    pub(super) unsafe fn stuck(&self,s:usize)->u32{(*self.rec.add(s*4+2) as u32)>>24}
    #[inline(always)]
    pub(super) unsafe fn set_stuck(&self,s:usize,v:u32){let p=self.rec.add(s*4+2);*p=(*p&0x00FF_FFFF)|((v.min(255)<<24) as i32);}
    pub(super) unsafe fn layer_mass(&self,s:usize)->(i32,i32){
        // (Its footprint's cells.)
        let m=*self.rec.add(s*4+2);let w=m&255;((m>>8)&255,(w*w).max(1))
    }
    /// Where slot s's footprint may go toward (nx, ny): the sweep; when it is blocked and the step is diagonal, its
    /// two axis slides. Each attempt's end held at its cell's middle toward a taken neighbour (hold_mid): a held
    /// attempt that gets nowhere is a blocked one (the slides, the caller's shoulders).
    #[inline(never)]
    pub(super) unsafe fn preview(&self,s:usize,nx:i32,ny:i32)->(i32,i32) {
        let p=self.rec.add(s*4);let meta=*p.add(2);
        if (meta>>16)&255==0 {return (nx,ny);}
        let ox=*p;let oy=*p.add(1);
        if nx==ox && ny==oy {return (nx,ny);}
        let w=meta&255;let layer=(meta>>8)&255;
        // (Past its block by at most half a block, less its footprint and 1024 eighths (4 tiles: what the colour phases keep
        // apart).)
        let limit=(self.blockq/2-(((w+1)*OCC_CELL)>>1)-1024).max(0);
        if !(nx>=self.bx*self.blockq-limit && nx<(self.bx+1)*self.blockq+limit
            && ny>=self.by*self.blockq-limit && ny<(self.by+1)*self.blockq+limit) {return (ox,oy);}
        let g=&self.g;let sh=OCC_SH;
        // (Shifted positions: the anchor is the position's cell.)
        let o=foff(g,w);let (sox,soy,snx,sny)=(ox-o,oy-o,nx-o,ny-o);
        let held=|r:(i32,i32)|->(i32,i32){if r.0==sox&&r.1==soy{r}else{hold_mid(g,sox,soy,r.0,r.1,w,layer)}};
        let diag=nx!=ox&&ny!=oy;
        let mut r;
        if ((sox>>sh) as u32)<g.w as u32&&((soy>>sh) as u32)<g.h as u32{
            // (Anchored in the map: the wanted step and its slides from the mover's field, made once per position.)
            let (dx,dy)=(nx-ox,ny-oy);
            if (snx>>sh)==(sox>>sh)&&(sny>>sh)==(soy>>sh){
                occdiag!(g,41);occdiag!(g,42);
                r=held((snx,sny));if r!=(sox,soy){return (r.0+o,r.1+o);}
                if !diag{occdiag!(g,48);return (ox,oy);}
            }else if dx.abs().max(dy.abs())<=OCC_CELL&&self.fk.get()!=(s as i32,ox,oy){
                // (A step of one cell with no field made yet: its footprint tested where it ends (a free one needs no
                // field; a taken one goes on to the slides with one).)
                occdiag!(g,41);
                if fits_step(g,sox>>sh,soy>>sh,(snx>>sh)-(sox>>sh),(sny>>sh)-(soy>>sh),w,layer){
                    r=held((snx,sny));if r!=(sox,soy){return (r.0+o,r.1+o);}
                }
                if !diag{occdiag!(g,48);return (ox,oy);}
            }
            // (Steps up to 3 cells (shoulders as long, any heading): the 8 x 8 field; longer: 16 x 16.)
            let c3=3*OCC_CELL;
            let f=self.field_of(s,ox,oy,sox>>sh,soy>>sh,w,layer,dx*dx+dy*dy>c3*c3);let f=&f;
            r=held(motion_f(g,f,sox,soy,snx,sny,w,layer));
            if r==(sox,soy) && diag {
                occdiag!(g,43);
                r=held(motion_f(g,f,sox,soy,snx,soy,w,layer));
                if r==(sox,soy) {occdiag!(g,44);r=held(motion_f(g,f,sox,soy,sox,sny,w,layer));}
            }else if r==(sox,soy) {occdiag!(g,48);}
            return (r.0+o,r.1+o);
        }
        r=held(motion_s(g,sox,soy,snx,sny,w,layer));
        if r==(sox,soy) && diag {
            occdiag!(g,43);
            r=held(motion_s(g,sox,soy,snx,soy,w,layer));
            if r==(sox,soy) {occdiag!(g,44);r=held(motion_s(g,sox,soy,sox,sny,w,layer));}
        }else if r==(sox,soy) {occdiag!(g,48);}
        (r.0+o,r.1+o)
    }
    /// Slot s's legal-anchor field at (ox, oy) (its anchor (ax, ay); width 1-4; wide: 16 x 16): the cached one while no
    /// bitmap write came between.
    #[inline(always)]
    unsafe fn field_of(&self,s:usize,ox:i32,oy:i32,ax:i32,ay:i32,w:i32,layer:i32,wide:bool)->Field{
        if self.fk.get()==(s as i32,ox,oy){let f=self.fv.get();if f.k==7||!wide{return f;}}
        let f=field(&self.g,ax,ay,w,layer,wide);
        self.fk.set((s as i32,ox,oy));self.fv.set(f);f
    }
    #[inline(always)]
    fn field_drop(&self){self.fk.set((-1,0,0));}
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
        let w=meta&255;let layer=(meta>>8)&255;
        let limit=(self.blockq/2-(((w+1)*OCC_CELL)>>1)-1024).max(0);
        if nx<self.bx*self.blockq-limit || nx>=(self.bx+1)*self.blockq+limit
            || ny<self.by*self.blockq-limit || ny>=(self.by+1)*self.blockq+limit {*self.stats.add(5)+=1;}
        if tx!=ox || ty!=oy {
            if anchor(&self.g,tx,w)!=anchor(&self.g,ox,w) || anchor(&self.g,ty,w)!=anchor(&self.g,oy,w) {
                self.field_drop();
                move_footprint(&self.g,ox,oy,tx,ty,w,layer);*self.stats.add(6)+=1;
            }
            *p=tx;*p.add(1)=ty;*self.stats.add(2)+=1;
            self.row_moved(s,tx,ty);
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
    let grid=MoveGrid::load(a,bx,by,*cfg.add(5)* *cfg.add(6),false);
    grid.visit(1);
    let (x,y)=grid.position(s as usize,nx,ny);
    (x as u32 as i64)|((y as i64)<<32)
}

// ---- for the batch births (birth.rs) ----
pub(super) struct OccGrid(Grid);
pub(super) unsafe fn grid(bits:*mut u32,mask:*const i8,w:i32,h:i32,stride:i32,cell:i32,planes:i32)->OccGrid{OccGrid(mkgrid(bits,mask,w,h,stride,cell,planes,core::ptr::null_mut(),true))}
/// A plane's map row cy as written (birth.rs reads rows of free cells itself): its first word.
pub(super) unsafe fn grid_row(g:&OccGrid,layer:i32,cy:i32)->*const u32{let g=&g.0;g.bits.add((layer*g.plane+cy*g.stride) as usize)}
#[inline(always)]
pub(super) unsafe fn cell_taken(g:&OccGrid,cx:i32,cy:i32,layer:i32)->bool{let g=&g.0;*g.bits.add((layer*g.plane+cy*g.stride+(cx>>5)) as usize)&(1u32<<(cx&31))!=0}
#[inline(always)]
pub(super) unsafe fn disk_free(g:&OccGrid,x:i32,y:i32,w:i32,layer:i32)->bool{free(&g.0,x,y,w,layer,0,0,0,-1)}
#[inline(always)]
pub(super) unsafe fn disk_mark(g:&OccGrid,x:i32,y:i32,w:i32,layer:i32){clear_or_mark(&g.0,x,y,w,layer,true)}
/// The shift of a w-wide footprint's positions (eighths) for the cell size (birth.rs: places from anchors).
#[inline(always)]
pub(super) fn foot_off(cell:i32,w:i32)->i32{((w-1)*cell)>>1}

/// occ_release with atomic word clears (k_unit_gone_par: other jobs' footprints share words).
pub(super) unsafe fn occ_release_atomic(bits:u32,mask:u32,rec:u32,w:i32,h:i32,stride:i32,cell:i32,planes:i32,s:i32) {
    use core::sync::atomic::{AtomicU32,Ordering};
    let p=(waddr(rec) as *mut i32).add(s as usize*4);let meta=*p.add(2);if (meta>>16)&255==0{return;}
    let g=mkgrid(waddr(bits) as *mut u32,waddr(mask) as *const i8,w,h,stride,cell,planes,core::ptr::null_mut(),true);
    let (fw,layer)=((meta&255).max(1).min(OCC_WMAX),((meta>>8)&255).min(planes-1));
    let (ax,ay)=(anchor(&g,*p,fw),anchor(&g,*p.add(1),fw));
    let (a,b)=(ax.max(0),(ax+fw).min(g.w)-1);
    for yy in ay.max(0)..(ay+fw).min(g.h) {
        if a>b {break;}
        for ww in (a>>5)..=(b>>5) {
            let q=g.bits.add((layer*g.plane+yy*g.stride+ww) as usize) as *const AtomicU32;let m=word_mask(a,b,ww);
            let old=(*q).fetch_and(!m,Ordering::Relaxed);
            tally(&g,layer,yy,ww,-((old&m).count_ones() as i32));
        }
    }
    *p.add(2)=meta&!(255<<16);
}
