//! Opt-in bounded acquisition experiment. Snapshot candidates packed by area;
//! each query examines at most P[24] entries, independent of population.
use super::*;
use super::k::K;
const NEAR:usize=64;
// The area buckets' entries (acq.saE, [28]): one 16-byte record each, x and y
// (f32 bits), slot, id: a sample of four is one or two cache lines and its
// winner needs no slot -> id gather.
const EW:usize=4;
#[inline(always)] unsafe fn e_put(E:*mut i32,j:usize,x:f32,y:f32,slot:i32,id:i32){let r=E.add(j*EW);*r=x.to_bits() as i32;*r.add(1)=y.to_bits() as i32;*r.add(2)=slot;*r.add(3)=id;}
#[inline(always)] unsafe fn e_x(E:*const i32,j:usize)->f32{f32::from_bits(*E.add(j*EW) as u32)}
#[inline(always)] unsafe fn e_y(E:*const i32,j:usize)->f32{f32::from_bits(*E.add(j*EW+1) as u32)}
#[inline(always)] unsafe fn e_slot(E:*const i32,j:usize)->i32{*E.add(j*EW+2)}
#[inline(always)] unsafe fn e_id(E:*const i32,j:usize)->i32{*E.add(j*EW+3)}
// The area answers packed (acq.saRec, [47]): per (team, area) eight words,
// one 32-byte line: [0] the nearest area with a visible enemy unit, [1..5]
// the structure tile of each class, [5..8] their distances as u16 (unit
// answer, classes 0-3; 0xFFFF none). The scan reads one line a tile instead
// of one in each of ten arrays. (A distance is at most the answers' depth,
// the farthest reach in area steps: far below 0xFFFF.)
pub const RW:usize=8;
#[inline(always)] fn d_enc(d:i32)->u32{if d<0{0xFFFF}else{d.min(0xFFFE) as u32}}
#[inline(always)] fn d_dec(v:u32)->i32{let v=v&0xFFFF;if v==0xFFFF{-1}else{v as i32}}

#[inline(always)]
fn mix(mut x:u32)->u32 {
    x^=x>>16;x=x.wrapping_mul(0x7feb352d);x^=x>>15;
    x=x.wrapping_mul(0x846ca68b);x^(x>>16)
}

// One background stage after ACQ_OMT, before any sampled readers. The CSR
// scatter is stable in snapshot entry order; no atomics or shared RNG.
#[inline(always)]
unsafe fn candidate(k:&K,e:usize)->Option<(usize,usize,f32,f32,i32,i32)> {
    let slot=*k.p::<i32>(19).add(e);
    if k.i(30)==0 {
        let ar=*k.p::<i32>(25).add(e);let owner=*k.p::<i32>(24).add(e);
        if ar<0||owner<0{return None;}
        return Some((ar as usize,owner as usize,*k.p::<f32>(22).add(e),*k.p::<f32>(23).add(e),*k.p::<i32>(26).add(e),slot));
    }
    // Area packing can read the immutable slot snapshot directly. The exact
    // scan's five entry columns would otherwise be written, read, then copied.
    if slot<0||*k.p::<u8>(7).add(slot as usize)&1!=0{return None;}
    let s=slot as usize;let owner=*k.p::<i8>(6).add(s);
    if owner<0{return None;}
    let x=*k.p::<f32>(4).add(s);let y=*k.p::<f32>(5).add(s);
    let gx=floor(x as f64/k.f(5));let gy=floor(y as f64/k.f(5));
    let w=k.i(15);let h=k.i(16);
    if !(gx>=0.0&&gy>=0.0&&gx<w as f64&&gy<h as f64){return None;}
    let ar=*k.p::<i32>(13).add((gy as i32*w+gx as i32) as usize);
    if ar<0{return None;}
    Some((ar as usize,owner as usize,x,y,*k.p::<i32>(10).add(s),slot))
}
#[no_mangle]
pub unsafe extern "C" fn k_acq_area_build(a:u32,_chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let n=k.i(0).max(0) as usize;let na=k.i(20).max(0) as usize;
    let players=k.i(7).max(1) as usize;let keys=na*players;
    let off=k.p::<i32>(27);let counts=k.p::<i32>(35);let cursor=k.p::<i32>(36);
    core::ptr::write_bytes(counts,0,keys);
    // (Each entry's area and owner worked out once, into acq.saKey (-1: none): the count and the
    // scatter then read it, and only the scatter reads the rest of the entry.)
    let keyv=k.p::<i32>(45);
    if !keyv.is_null()&&k.i(30)!=0 {
        for e in 0..n {match candidate(&k,e){Some((ar,owner,_,_,_,_)) if ar<na&&owner<players=>{let key=ar*players+owner;*keyv.add(e)=key as i32;*counts.add(key)+=1;}_=>{*keyv.add(e)=-1;}}}
    }else{
        for e in 0..n {if let Some((ar,owner,_,_,_,_))=candidate(&k,e){if ar<na&&owner<players {*counts.add(ar*players+owner)+=1;}}}
    }
    let mut total=0;for key in 0..keys {*off.add(key)=total;*cursor.add(key)=total;total+=*counts.add(key);}*off.add(keys)=total;
    // (Per entry its record: the owner is its bucket's (key = area * players + owner).)
    let E=k.p::<i32>(28);
    if !keyv.is_null()&&k.i(30)!=0 {
        // (As candidate's slot-snapshot case: the entry's slot, its owner from the key, its position and id from the slot's columns.)
        let (es,xs,ys,sid)=(k.p::<i32>(19),k.p::<f32>(4),k.p::<f32>(5),k.p::<i32>(10));
        for e in 0..n {let key=*keyv.add(e);if key<0 {continue;}
            let slot=*es.add(e);let s=slot as usize;
            let cur=cursor.add(key as usize);let j=*cur as usize;*cur+=1;
            e_put(E,j,*xs.add(s),*ys.add(s),slot,*sid.add(s));
        }
    }else{
    // (The id as the samples read it: the slot's in the snapshot, acq.id.)
    let sid=k.p::<i32>(10);
    for e in 0..n {if let Some((ar,owner,x,y,_id,slot))=candidate(&k,e){if ar>=na||owner>=players {continue;}
        let cur=cursor.add(ar*players+owner);let j=*cur as usize;*cur+=1;
        e_put(E,j,x,y,slot,if slot>=0 {*sid.add(slot as usize)}else{0});
    }}
    }
    if k.i(28)==1 {
        prepare_area_answers(&k,na,players,off);
        return;
    }
    if k.i(26)==0 {return;}
    let near=k.p::<i32>(33);let near_n=k.p::<i32>(34);let seen=k.p::<i32>(37);
    let graph_off=k.p::<i32>(38);let graph_nb=k.p::<i32>(39);
    core::ptr::write_bytes(seen,0,na);
    for ar in 0..na {
        let row=near.add(ar*NEAR);*row=ar as i32;*seen.add(ar)=ar as i32+1;
        let mut head=0;let mut len=1;
        while head<len&&len<NEAR {
            let u=*row.add(head) as usize;head+=1;
            for j in *graph_off.add(u)..*graph_off.add(u+1) {
                let v=*graph_nb.add(j as usize);if v<0||(v as usize)>=na {continue;}
                if *seen.add(v as usize)==ar as i32+1 {continue;}
                *seen.add(v as usize)=ar as i32+1;*row.add(len)=v;len+=1;
                if len==NEAR {break;}
            }
        }
        *near_n.add(ar)=len as i32;
    }
}

// What the answers' jobs share, from the packed table: per area the set of
// teams holding units there (a bit each; acq.saSeen), and how many area steps
// the farthest-looking unit reaches (acq.saNearN[0]): an answer farther than
// that is never asked for (the scan takes d<=reach, area_batch), so the searches stop
// there. P[31] the slots, P[29] the tiles an area step stands for.
unsafe fn prepare_area_answers(k:&K,na:usize,players:usize,off:*const i32){
    let mask=k.p::<i32>(37);
    for ar in 0..na {
        let mut m=0;
        for foe in 0..players {let key=ar*players+foe;if *off.add(key+1)>*off.add(key){m|=1<<foe;}}
        *mask.add(ar)=m;
    }
    let ranges=k.p::<f32>(9);let n=k.i(31).max(0) as usize;
    let mut far=0.0f32;
    for s in 0..n {let r=*ranges.add(s);if r>far {far=r;}}
    area_reach(k,far);
}
// (k_acq_area_prefix's second stage takes the masks by its blocks, the reach from the first stage's maxima.)
unsafe fn area_reach(k:&K,far:f32){
    let reach=ceil(far as f64/(k.f(5)*k.f(29).max(1.0))) as i32;
    // (And the towers' longest reach, P[36]: tower.rs k_tower_acq asks as far.)
    *k.p::<i32>(34)=reach.max(k.i(36)).max(0);
}

/// Teams a search group: five labels of twelve teams in a u64 an area (bit label * GS + team in the group).
pub const GS:usize=12;
/// A group's search state (acq.saLv, from group * lv_stride): the areas' reached masks, then two frontier masks (the
/// previous level's, the next's), a u64 each an area.
#[inline(always)] pub fn lv_stride(na:usize)->usize{24*na}
/// The level flags (acq.saLvH, 256 words a group: [d] 1 when level d took any area), cleared by k_acq_area_seed.
pub const LVH:usize=256;
#[inline(always)] unsafe fn flag_set(p:*mut i32){(*(p as *const core::sync::atomic::AtomicI32)).store(1,core::sync::atomic::Ordering::Relaxed)}

/// The area answers: every team's five labels (label 0 the nearest area holding a visible enemy unit, labels 1-4 the
/// nearest area holding a visible enemy structure of that class: its first tile, the seeds k_acq_area_seed's, in the
/// records' words 1-4) in one breadth-first search a group of twelve teams, a bit a team and label. Each level is a
/// pull over the areas in fixed ranges (a job each: chunk = group * P[46] + range, P[47] areas a range): an area not
/// yet holding a label takes it from its first neighbour (the neighbour lists ascending, acq.anb, k_csr_sort) on the
/// level before's frontier, so from its lowest-numbered parent, as one search a label would. Its writes are its own,
/// its reads the previous level's: the jobs run anywhere in any order. P[44]: 0 the seeds (the records' answer and
/// distance words of the labels searched), 1 level P[45], 2 the levels from P[45] to the reach in one job a group
/// (past the chain's level stages). A structure class whose seeds did not change since the last run (k_acq_area_seed's
/// changed mask, acq.saSh) is not searched: its answers and distances in the records are still right. Into the
/// teams' records (acq.saRec, RW words a team and area: the scan's and the towers'), the answer word = label, its
/// distance the u16 at 10 + label (0xFFFF none). (Was a job a team of five labels, 20-70 ms a chunk in the 1M battle:
/// a third of the helpers' time; before that 40 searches with a queue each.)
#[no_mangle]
pub unsafe extern "C" fn k_acq_area_answers(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let na=k.i(20).max(0) as usize;let players=k.i(7).max(1) as usize;
    if na==0 {return;}
    let groups=(players+GS-1)/GS;
    let mode=k.i(44);let nr=k.i(46).max(1) as usize;let per=k.i(47).max(1) as usize;
    let c=chunk.max(0) as usize;
    let (g,r)=if mode==2 {(c,0)} else {(c/nr,c%nr)};
    if g>=groups {return;}
    let (a0,a1)=if mode==2 {(0,na)} else {((r*per).min(na),((r+1)*per).min(na))};
    let base=k.p::<u8>(42).add(g*lv_stride(na));
    let (rch,fa,fb)=(base as *mut u64,(base as *mut u64).add(na),(base as *mut u64).add(2*na));
    let flags=k.p::<i32>(52).add(g*LVH);
    let rec=k.p::<i32>(47);let r16=rec as *mut u16;
    let v0=g*GS;let nv=(players-v0).min(GS);
    let go=k.p::<i32>(38);let gn=k.p::<i32>(39);
    let maxd=(*k.p::<i32>(34)).clamp(0,254) as usize;
    // (The answer word and distance of team v's label l at area x.)
    let rw=|v:usize,x:usize,l:usize|rec.add((v*na+x)*RW+l);
    let dw=|v:usize,x:usize,l:usize|r16.add((v*na+x)*16+10+l);
    if mode==0 {
        let cov=k.p::<u8>(14);let mask=k.p::<i32>(37);let sh=k.p::<i32>(50);
        // (Bits of no team, and of labels not searched (kept classes), count as reached.)
        let mut kept=0u64;
        for vi in 0..GS {
            if vi>=nv {for l in 0..5 {kept|=1u64<<(l*GS+vi);}continue;}
            let chg=if sh.is_null() {15}else{*sh.add((v0+vi)*SHW+SH_CHG)&15};
            for l in 1..5 {if chg&(1<<(l-1))==0 {kept|=1u64<<(l*GS+vi);}}
        }
        let mut any=false;
        for x in a0..a1 {
            let mut seed=0u64;
            for vi in 0..nv {
                let v=v0+vi;
                let unit=*cov.add(v*na+x)!=0&&(*mask.add(x)&!(1i32<<v))!=0;
                *rw(v,x,0)=if unit {x as i32}else{-1};*dw(v,x,0)=if unit {0}else{0xFFFF};
                if unit {seed|=1u64<<vi;}
                for l in 1..5 {
                    let b=1u64<<(l*GS+vi);if kept&b!=0 {continue;}
                    let sd=*rw(v,x,l)>=0;*dw(v,x,l)=if sd {0}else{0xFFFF};
                    if sd {seed|=b;}
                }
                *r16.add((v*na+x)*16+15)=0xFFFF;
            }
            *rch.add(x)=seed|kept;*fa.add(x)=seed;
            any|=seed!=0;
        }
        if any {flag_set(flags);}
        return;
    }
    // A level: the frontiers alternate (level d's in fa when d is even).
    let level=|d:usize,x0:usize,x1:usize|->bool{
        let (fp,fnx)=if d&1==1 {(fa,fb)}else{(fb,fa)};
        let mut any=false;
        for x in x0..x1 {
            let rx=*rch.add(x);
            if rx==u64::MAX {*fnx.add(x)=0;continue;}
            let need=!rx;let mut acc=0u64;
            for j in *go.add(x)..*go.add(x+1) {
                let u=*gn.add(j as usize) as usize;if u>=na {continue;}
                let f=*fp.add(u)&need&!acc;
                if f==0 {continue;}
                let mut b=f;
                while b!=0 {let bit=b.trailing_zeros() as usize;b&=b-1;
                    let (l,vi)=(bit/GS,bit%GS);let v=v0+vi;
                    *rw(v,x,l)=*rw(v,u,l);*dw(v,x,l)=d as u16;}
                acc|=f;
                if acc==need {break;}
            }
            *fnx.add(x)=acc;
            if acc!=0 {*rch.add(x)=rx|acc;any=true;}
        }
        any
    };
    if mode==1 {
        let d=k.i(45).max(1) as usize;
        if d>maxd||*flags.add(d-1)==0 {return;}
        if level(d,a0,a1) {flag_set(flags.add(d));}
        return;
    }
    let mut d=k.i(45).max(1) as usize;
    while d<=maxd&&*flags.add(d-1)!=0 {
        if level(d,0,na) {flag_set(flags.add(d));}
        d+=1;
    }
}

/// Each area's neighbour list ascending (acq.aoff / acq.anb, the answers' copy of the area graph, once a layout):
/// k_acq_area_answers takes an area's answer from its first neighbour on the frontier, its lowest-numbered one.
/// P: [0] areas.
#[no_mangle]
pub unsafe extern "C" fn k_csr_sort(a:u32,_chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let (off,nb)=(k.p::<i32>(0),k.p::<i32>(1));
    let na=k.i(0).max(0) as usize;
    for x in 0..na {
        let (lo,hi)=(*off.add(x) as usize,*off.add(x+1) as usize);
        for i in lo+1..hi {let v=*nb.add(i);let mut j=i;while j>lo&&*nb.add(j-1)>v {*nb.add(j)=*nb.add(j-1);j-=1;}*nb.add(j)=v;}
    }
}

// The structure seeds' state a team (acq.saSh, SHW words): [0..8) the four classes' hashes (two u32 halves each, of
// the sum of two 64-bit mixes of every visible enemy structure tile of the class), [8] the reach they were made with,
// [9] made (1), [10] the classes whose seeds changed this run (k_acq_area_answers searches only those).
pub const SHW:usize=16;const SH_REACH:usize=8;const SH_OK:usize=9;const SH_CHG:usize=10;
#[inline(always)] fn mix64(mut x:u64)->u64{x^=x>>30;x=x.wrapping_mul(0xbf58476d1ce4e5b9);x^=x>>27;x=x.wrapping_mul(0x94d049bb133111eb);x^(x>>31)}

/// The structure answers' seeds of team chunk (viewer), for the four classes: per area the first (row-major) tile
/// of a visible enemy structure of each class, -1 none, into words 1-4 of its records (acq.saRec); then
/// k_acq_area_answers spreads them (labels 1-4). A first pass over the tiles hashes each class's tiles (acq.saSh): a
/// class with the same tiles and reach as at its last run on these records (P[37] 0: the records are the last run's,
/// on this layout) keeps its records (its seeds were spread there already), the others are seeded.
#[no_mangle]
pub unsafe extern "C" fn k_acq_area_seed(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let na=k.i(20).max(0) as usize;let players=k.i(7).max(1) as usize;
    let viewer=chunk.max(0) as usize;
    if viewer>=players||na==0 {return;}
    // (Job 0: the answers' level flags cleared, every group's.)
    if viewer==0 {let fl=k.p::<i32>(52);if !fl.is_null() {for i in 0..((players+GS-1)/GS)*LVH {*fl.add(i)=0;}}}
    let cov=k.p::<u8>(14).add(viewer*na);
    let rec=k.p::<i32>(47).add(viewer*na*RW);
    let ag=k.p::<i32>(13);let cls=k.p::<i8>(0);let owners=k.p::<i8>(1);
    let tiles=k.i(15).max(0) as usize*k.i(16).max(0) as usize;
    // (A tile's class, or 0: not a visible enemy structure.)
    let class=|tile:usize|->usize{
        let cl=*cls.add(tile);let cl=if cl==5 {1}else{cl};
        if cl<1||cl>4 {return 0;}
        let owner=*owners.add(tile);if owner==-1||owner as i32==viewer as i32 {return 0;}
        let ar=*ag.add(tile);if ar<0||ar as usize>=na {return 0;}
        if *cov.add(ar as usize)==0 {return 0;}
        cl as usize
    };
    // (The tiles holding a structure of a class (1..5), in tile order: sixteen at a time by one vector test, the map
    // being mostly without.)
    let each=|f:&mut dyn FnMut(usize)|{
        let mut t=0usize;
        let (lo,hi)=(i8x16_splat(1),i8x16_splat(5));
        while t+16<=tiles {
            let v=v128_load(cls.add(t) as *const v128);
            let mut m=i8x16_bitmask(v128_and(i8x16_ge(v,lo),i8x16_le(v,hi))) as u32;
            while m!=0 {let l=m.trailing_zeros() as usize;m&=m-1;f(t+l);}
            t+=16;
        }
        while t<tiles {let c=*cls.add(t);if c>=1&&c<=5 {f(t);}t+=1;}
    };
    let mut chg=15u32;
    let sh=k.p::<i32>(50);
    if !sh.is_null() {
        let st=sh.add(viewer*SHW);
        let mut h=[0u64;4];
        let hp=h.as_mut_ptr();
        each(&mut |tile:usize|{let c=class(tile);if c==0 {return;}
            let t=((tile as u64)<<2)|(c as u64-1);let x=hp.add(c-1);
            *x=(*x).wrapping_add(mix64(t)).wrapping_add(mix64(t^0x5851_f42d_4c95_7f2d).rotate_left(32));});
        let reach=*k.p::<i32>(34);
        let fresh=k.i(37)!=0||*st.add(SH_OK)!=1||*st.add(SH_REACH)!=reach;
        chg=0;
        for c in 0..4 {let (lo,hi)=(h[c] as u32 as i32,(h[c]>>32) as u32 as i32);
            if fresh||*st.add(2*c)!=lo||*st.add(2*c+1)!=hi {chg|=1<<c;}
            *st.add(2*c)=lo;*st.add(2*c+1)=hi;}
        *st.add(SH_REACH)=reach;*st.add(SH_OK)=1;*st.add(SH_CHG)=chg as i32;
    }
    if chg==0 {return;}
    for ar in 0..na {let r=rec.add(ar*RW);for c in 1..5 {if chg&(1<<(c-1))!=0 {*r.add(c)=-1;}}}
    each(&mut |tile:usize|{
        let c=class(tile);if c==0||chg&(1<<(c-1))==0 {return;}
        let at=rec.add(*ag.add(tile) as usize*RW+c);
        if *at<0 {*at=tile as i32;}
    });
}

// The area table's build (k_acq_area_build's count and scatter, its slot snapshot case: acq.saKey) in stages: the
// counts zeroed (k_acq_area_prefix mode 2), the entries' keys and counts in fixed ranges (P[33] ranges, P[34]
// entries each; one histogram, acq.saCount, by atomic adds), the offsets (two stages of key blocks), the scatter (an
// atomic cursor a key: the order within a bucket is the threads', and k_acq_area_sort orders every bucket by id
// next). (A histogram a range over every key was ~31 MB to zero, sum and rewrite a run with 8 teams on a 1024 map.)
#[inline(always)] unsafe fn atomic_add(p:*mut i32,v:i32)->i32{(*(p as *const core::sync::atomic::AtomicI32)).fetch_add(v,core::sync::atomic::Ordering::Relaxed)}
#[no_mangle]
pub unsafe extern "C" fn k_acq_area_count(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let n=k.i(0).max(0) as usize;let na=k.i(20).max(0) as usize;
    let players=k.i(7).max(1) as usize;
    let per=k.i(34).max(1) as usize;let c=chunk.max(0) as usize;
    let e0=(c*per).min(n);let e1=(e0+per).min(n);
    let counts=k.p::<i32>(35);let keyv=k.p::<i32>(45);
    // (Entries of one key come together (the index's order): their count in a register, one atomic add a run.)
    let (mut lk,mut ln)=(usize::MAX,0i32);
    for e in e0..e1 {
        match candidate(&k,e){Some((ar,owner,_,_,_,_)) if ar<na&&owner<players=>{let key=ar*players+owner;*keyv.add(e)=key as i32;
            if key!=lk {if ln>0 {atomic_add(counts.add(lk),ln);}lk=key;ln=0;}ln+=1;}_=>{*keyv.add(e)=-1;}}
    }
    if ln>0 {atomic_add(counts.add(lk),ln);}
}
// The offsets in two stages of P[41] jobs, a block of P[39] keys each (a multiple of the players: whole areas):
// [40] 0: the sum of the block's counts, and the largest aggro range of its share of the slots (P[42] each), into
// acq.saPre ([30]: sums, then the ranges' bits); [40] 1: the block's offsets from the earlier blocks' sums, its
// cursors (the offsets: the scatter adds to them), its areas' team masks, and (job 0) the answers' reach; [40] 2 (the
// chain's first stage): the block's counts zeroed. The same outputs as one pass over every key (5-19 ms serial at ~500k units, then ~14 ms a post at
// the 1M battle: the chain's one single-job stage, waited for at its commit).
#[no_mangle]
pub unsafe extern "C" fn k_acq_area_prefix(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let na=k.i(20).max(0) as usize;let players=k.i(7).max(1) as usize;let keys=na*players;
    let off=k.p::<i32>(27);let counts=k.p::<i32>(35);let cursor=k.p::<i32>(36);
    let pre=k.p::<i32>(30);let jobs=k.i(41).max(1) as usize;let per=k.i(39).max(1) as usize;
    let j=chunk.max(0) as usize;if j>=jobs {return;}
    let k0=(j*per).min(keys);let k1=(k0+per).min(keys);
    if k.i(40)==2 {core::ptr::write_bytes(counts.add(k0),0,k1-k0);return;}
    if k.i(40)==0 {
        let mut sum=0i32;for key in k0..k1 {sum+=*counts.add(key);}
        *pre.add(j)=sum;
        // (The largest aggro range of the job's slots, as prepare_area_answers takes it: from 0, NaN never above.)
        let rng=k.p::<f32>(9);let n=k.i(31).max(0) as usize;let sp=k.i(42).max(1) as usize;
        let s0=(j*sp).min(n);let s1=(s0+sp).min(n);let mut far=0.0f32;
        for s in s0..s1 {let r=*rng.add(s);if r>far {far=r;}}
        *pre.add(jobs+j)=far.to_bits() as i32;
        return;
    }
    let mut base=0i32;for i in 0..j {base+=*pre.add(i);}
    for key in k0..k1 {*off.add(key)=base;*cursor.add(key)=base;base+=*counts.add(key);}
    if j+1==jobs {*off.add(keys)=base;}
    if k.i(28)==1 {
        let mask=k.p::<i32>(37);
        for ar in k0/players..k1/players {
            let mut m=0;
            for foe in 0..players {if *counts.add(ar*players+foe)>0 {m|=1<<foe;}}
            *mask.add(ar)=m;
        }
        if j==0 {
            let mut far=0.0f32;for i in 0..jobs {let r=f32::from_bits(*pre.add(jobs+i) as u32);if r>far {far=r;}}
            area_reach(&k,far);
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn k_acq_area_scatter(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let n=k.i(0).max(0) as usize;let na=k.i(20).max(0) as usize;
    let per=k.i(34).max(1) as usize;let c=chunk.max(0) as usize;
    let e0=(c*per).min(n);let e1=(e0+per).min(n);
    let _=na;
    let cur=k.p::<i32>(36);let keyv=k.p::<i32>(45);
    let E=k.p::<i32>(28);
    let (es,xs,ys,sid)=(k.p::<i32>(19),k.p::<f32>(4),k.p::<f32>(5),k.p::<i32>(10));
    // (A run of one key's entries takes its places with one atomic add.)
    let mut e=e0;
    while e<e1 {let key=*keyv.add(e);if key<0 {e+=1;continue;}
        let mut r=e+1;while r<e1&&*keyv.add(r)==key {r+=1;}
        let mut j=atomic_add(cur.add(key as usize),(r-e) as i32) as usize;
        for q in e..r {let slot=*es.add(q);let s=slot as usize;e_put(E,j,*xs.add(s),*ys.add(s),slot,*sid.add(s));j+=1;}
        e=r;
    }
}

/// Each area bucket's entries in id order (keys [chunk * P[38], ..)): the scatter leaves them in the unit
/// index's order, by slot within a cell, and a unit's answer is a batch of four at a seeded place in its target's
/// bucket (area_batch): with another slot layout (a restore lays the slots out anew) the same unit met other
/// candidates and took another target, so the restored peer diverged. An LSD radix sort (8-bit passes, the bytes
/// all ids share skipped) through acq.saE2 ([29], as long as acq.saE): a bucket's range there is its own, so the
/// jobs never meet. (Two to sixteen entries: an insertion sort, the radix pass's 256 counters for nothing.)
#[no_mangle]
pub unsafe extern "C" fn k_acq_area_sort(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let na=k.i(20).max(0) as usize;let players=k.i(7).max(1) as usize;let keys=na*players;
    let per=k.i(38).max(1) as usize;let k0=(chunk.max(0) as usize*per).min(keys);let k1=(k0+per).min(keys);
    let (off,E,T)=(k.p::<i32>(27),k.p::<i32>(28),k.p::<i32>(29));
    for key in k0..k1 {
        let lo=*off.add(key) as usize;let n=*off.add(key+1) as usize-lo;
        if n>=2 {sort_bucket(E.add(lo*EW),T.add(lo*EW),n);}
    }
}
#[inline(always)]
unsafe fn sort_bucket(e:*mut i32,t:*mut i32,n:usize){
    let id=|p:*const i32,j:usize|->u32{*p.add(j*EW+3) as u32};
    if n<=16 {
        for i in 1..n {
            let r=[*e.add(i*EW),*e.add(i*EW+1),*e.add(i*EW+2),*e.add(i*EW+3)];let v=r[3] as u32;
            let mut j=i;
            while j>0&&id(e,j-1)>v {for w in 0..EW {*e.add(j*EW+w)=*e.add((j-1)*EW+w);}j-=1;}
            for w in 0..EW {*e.add(j*EW+w)=*r.get_unchecked(w);}
        }
        return;
    }
    let (mut or,mut and)=(0u32,u32::MAX);
    for j in 0..n {let v=id(e,j);or|=v;and&=v;}
    let diff=or^and;
    let (mut src,mut dst)=(e,t);
    let mut cnt=[0u32;256];
    for b in 0..4u32 {
        let sh=8*b;
        if (diff>>sh)&0xFF==0 {continue;}
        for c in cnt.iter_mut() {*c=0;}
        for j in 0..n {*cnt.get_unchecked_mut(((id(src,j)>>sh)&0xFF) as usize)+=1;}
        let mut sum=0u32;
        for c in cnt.iter_mut() {let v=*c;*c=sum;sum+=v;}
        for j in 0..n {
            let d=cnt.get_unchecked_mut(((id(src,j)>>sh)&0xFF) as usize);let at=*d as usize;*d+=1;
            for w in 0..EW {*dst.add(at*EW+w)=*src.add(j*EW+w);}
        }
        core::mem::swap(&mut src,&mut dst);
    }
    if src!=e {core::ptr::copy_nonoverlapping(src,e,n*EW);}
}



// The area answers of a batch of units, a stage a memory level: the window's
// tiles (agrid), the records (acq.saRec), the target's bucket (acq.saOff), its
// entries (acq.saE). Each unit's reads hang on the one before (one chain: a
// unit at a time, ~150 ns of misses one after another); a stage's sixteen
// are independent, in flight together. The window's tiles two by two (a tile
// twice when the unit is not near that edge: a minimum takes it once), each
// answer the least (distance, target) as one u64 key, u64::MAX none.
const AB:usize=32;
#[cfg_attr(feature = "prof", inline(never))]
unsafe fn area_batch(k:&K,bs:&[usize;AB],nb:usize){
    let na=k.i(20).max(0) as usize;let players=k.i(7).max(1) as usize;
    let tile=k.f(5);let gw=k.i(15);let gh=k.i(16);let step=tile*k.f(29).max(1.0);
    let (xs,ys,own,flags,cmd,ranges,ids)=(k.p::<f32>(4),k.p::<f32>(5),k.p::<i8>(6),k.p::<u8>(7),k.p::<u8>(8),k.p::<f32>(9),k.p::<i32>(10));
    let (out,tid,sout,ag,rec,off,E)=(k.p::<i32>(11),k.p::<i32>(12),k.p::<i32>(3),k.p::<i32>(13),k.p::<i32>(47),k.p::<i32>(27),k.p::<i32>(28));
    let (c8,c9)=(k.i(8),k.i(9));let epoch=k.i(25) as u32;
    let mut ar=[[u32::MAX;4];AB];let mut lim=[0i64;AB];let mut wants=[false;AB];
    // The window's areas (u32::MAX none).
    for i in 0..nb.min(AB) {let s=bs[i];
        let fx=*xs.add(s) as f64/tile;let fy=*ys.add(s) as f64/tile;
        let gx=floor(fx) as i32;let gy=floor(fy) as i32;let rx=fx-gx as f64;let ry=fy-gy as f64;
        let wx=[gx-(rx<0.3) as i32,gx+(rx>=0.7) as i32];let wy=[gy-(ry<0.3) as i32,gy+(ry>=0.7) as i32];
        // (A distance counts up to the reach; 0xFFFF none: above any.)
        lim[i]=(ceil(*ranges.add(s) as f64/step) as i32).clamp(-1,0xFFFE) as i64;
        let command=*cmd.add(s) as i32;
        // (A moving shooter too, flag 16: its drive-by's structure, k_combat_brain.
        // Only those take a structure: an attacking unit's eight class reads a
        // tile were made and dropped.)
        wants[i]=command==c8||command==c9||(*flags.add(s))&16!=0;
        for t in 0..4 {let (xx,yy)=(wx[t&1],wy[t>>1]);
            let inb=(xx as u32)<(gw as u32)&&(yy as u32)<(gh as u32);
            let a=*ag.add(if inb {(yy*gw+xx) as usize}else{0}) as u32;
            ar[i][t]=if inb&&a<(na as u32) {a}else{u32::MAX};
        }
    }
    // The records: the nearest enemy unit's area; the structure (sout) at once.
    #[inline(always)] fn key(d:u32,t:i32,ok:bool)->u64{if ok {(d as u64)<<32|t as u32 as u64}else{u64::MAX}}
    let mut unit=[u64::MAX;AB];
    for i in 0..nb.min(AB) {let s=bs[i];let base=(*own.add(s) as usize)*na;let lim=lim[i];let wants=wants[i];
        let mut u=u64::MAX;let mut st=[u64::MAX;4];
        for t in 0..4 {let a=ar[i][t];let ok=a!=u32::MAX;
            let r=rec.add((base+if ok {a as usize}else{0})*RW);
            let w5=*r.add(5) as u32;let du=w5&0xFFFF;
            u=u.min(key(du,*r,ok&&(du as i64)<=lim));
            if wants {
                // (Class c's distance: the record's u16 at 11 + c, after the unit answer's at 10.)
                let w6=*r.add(6) as u32;let w7=*r.add(7) as u32;
                let ds=[w5>>16,w6&0xFFFF,w6>>16,w7&0xFFFF];
                for c in 0..4 {st[c]=st[c].min(key(ds[c],*r.add(1+c),ok&&(ds[c] as i64)<=lim));}
            }
        }
        if wants {for c in 0..4 {if st[c]!=u64::MAX {*sout.add(s)=st[c] as u32 as i32;break;}}}
        unit[i]=u;
    }
    // The target area's bucket of an enemy (the first with any, from a seeded
    // player), a fixed batch of four in it (as the unit's id and the epoch seed).
    let mut e0=[0usize;AB];let mut e1=[0usize;AB];
    for i in 0..nb.min(AB) {if unit[i]==u64::MAX {continue;}
        let s=bs[i];let a=unit[i] as u32 as usize;let owner=*own.add(s) as usize;
        let seed=mix((*ids.add(s) as u32)^epoch.wrapping_mul(0x9e3779b9));
        let f0=((seed as u64*players as u64)>>32) as usize;
        for j in 0..players {let mut foe=f0+j;if foe>=players {foe-=players;}if foe==owner {continue;}
            let key=a*players+foe;let lo=*off.add(key) as usize;let hi=*off.add(key+1) as usize;let count=hi-lo;if count==0 {continue;}
            let e=lo+if count>4 {((mix(seed^a as u32) as u64*(count-3) as u64)>>32) as usize}else{0};
            e0[i]=e;e1[i]=e+count.min(4);break;
        }
    }
    // The batch's nearest, lowest id on a tie: the least (distance bits, id)
    // (non-negative distances order as their bits; lane by lane as the
    // four-wide sum was, the same rounding). Distance ranks a fixed batch
    // only: it cannot reject an area-valid unit.
    // (The unit's current target left out: its answer is another, the brain's
    // fallback when the target falls (k.rs brain_pick); a unit that keeps its
    // target needs no answer of it.)
    let (cms,ctid)=(k.p::<u8>(48),k.p::<i32>(49));
    let od=k.p::<u8>(51);
    for i in 0..nb.min(AB) {let (e,end)=(e0[i],e1[i]);if end==0 {continue;}
        let s=bs[i];let x=*xs.add(s);let y=*ys.add(s);
        let cm=if cms.is_null() {0}else{*cms.add(s)};
        let skip=if cm!=0&&cm&16==0&&!ctid.is_null() {*ctid.add(s)}else{i32::MIN};
        let mut best=u64::MAX;let mut win=e;
        for j in 0..4 {let q=e+j;let q=if q<end {q}else{e};
            let dx=e_x(E,q)-x;let dy=e_y(E,q)-y;let d=dx*dx+dy*dy;let id=e_id(E,q);
            let kq=if id==skip {u64::MAX}else{(d.to_bits() as u64)<<32|id as u32 as u64};
            let b=kq<best;best=if b {kq}else{best};win=if b {q}else{win};}
        if best==u64::MAX {continue;}
        *out.add(s)=e_slot(E,win);*tid.add(s)=best as u32 as i32;
        // (Its area distance, the window's to the answer's area: the brain's range question needs no search when it is
        // within the unit's attack reach, k.rs k_combat_brain.)
        if !od.is_null() {*od.add(s)=(unit[i]>>32).min(254) as u8;}
    }
}

#[no_mangle]
pub unsafe extern "C" fn k_acq_sample(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let n=k.i(0).max(0) as usize;let per=k.i(1).max(1) as usize;
    let start=(chunk.max(0) as usize*per).min(n);let end=(start+per).min(n);
    let xs=k.p::<f32>(4);let ys=k.p::<f32>(5);let own=k.p::<i8>(6);let flags=k.p::<u8>(7);let cmd=k.p::<u8>(8);
    let ranges=k.p::<f32>(9);let ids=k.p::<i32>(10);let out=k.p::<i32>(11);let tid=k.p::<i32>(12);let sout=k.p::<i32>(3);
    let ag=k.p::<i32>(13);let cov=k.p::<u8>(14);let na=k.i(20).max(0) as usize;
    let off=k.p::<i32>(27);let E=k.p::<i32>(28);
    let near=k.p::<i32>(33);let near_n=k.p::<i32>(34);
    let gw=k.i(15);let gh=k.i(16);let tile=k.f(5);let budget=k.i(24).clamp(4,256) as usize;
    let batch_budget=budget/4;let epoch=k.i(25) as u32;let players=k.i(7).max(1) as usize;
    let mut bs=[0usize;AB];let mut nb=0;
    for s in start..end {
        let fl=*flags.add(s);let command=*cmd.add(s) as i32;
        if fl&7!=0 || (command!=k.i(8)&&command!=k.i(9)&&command!=k.i(18)&&fl&16==0) {continue;}
        let owner=*own.add(s) as i32;let r=*ranges.add(s);
        if owner<0||owner>=k.i(7)||!(r>0.0){continue;}
        *out.add(s)=-1;*tid.add(s)=0;*sout.add(s)=-1;
        let od=k.p::<u8>(51);if !od.is_null() {*od.add(s)=255;}
        let x=*xs.add(s);let y=*ys.add(s);
        if k.i(28)==1 {*bs.get_unchecked_mut(nb)=s;nb+=1;if nb==AB {area_batch(&k,&bs,nb);nb=0;}continue;}
        // Structure selection is still exact, to isolate the unit-target tradeoff.
        if command==k.i(8)||command==k.i(9)||fl&16!=0 {
            let bc=k.i(11);let br=k.i(12);let stride=bc+1;let plane=stride*(br+1);
            *sout.add(s)=acq_structure(k.p::<i8>(0),k.p::<i8>(1),k.p::<i32>(2),ag,cov,na*players,owner*na as i32,owner,
                x as f64,y as f64,r as f64,tile,gw,gh,k.i(10),bc,br,stride,plane);
        }
        let gx=floor(x as f64/tile) as i32;let gy=floor(y as f64/tile) as i32;
        if gx<0||gy<0||gx>=gw||gy>=gh {continue;}
        let ar=*ag.add((gy*gw+gx) as usize);if ar<0||(ar as usize)>=na {continue;}
        let ar=ar as usize;let nareas=(*near_n.add(ar) as usize).min(NEAR);
        let seed=mix((*ids.add(s) as u32)^epoch.wrapping_mul(0x9e3779b9));
        let mut best=-1;let mut best_id=0;let mut b2=r*r;
        let mut batches=0;
        'areas: for j in 0..nareas {
            let target_area=*near.add(ar*NEAR+j) as usize;
            if *cov.add(owner as usize*na+target_area)==0 {continue;}
            for foe in 0..players {if foe==owner as usize {continue;}
            let key=target_area*players+foe;
            let lo=*off.add(key) as usize;let hi=*off.add(key+1) as usize;let count=hi-lo;
            if count==0 {continue;}
            if batches==batch_budget {break 'areas;}batches+=1;
            let e=lo+if count>4 {mix(seed^(target_area as u32).wrapping_mul(0x85ebca6b)) as usize%(count-3)}else{0};
            // (Lane by lane: b2 only falls, so the check against the current
            // b2 is the four-wide mask's against the first, and the sums round alike.)
            for q in e..e+count.min(4) {let dx=e_x(E,q)-x;let dy=e_y(E,q)-y;let d=dx*dx+dy*dy;let id=e_id(E,q);
                if d<=b2&&(best<0||d<b2||id<best_id){best=e_slot(E,q);best_id=id;b2=d;}
            }
            }
        }
        *out.add(s)=best;*tid.add(s)=if best>=0 {best_id}else{0};
    }
    if nb>0 {area_batch(&k,&bs,nb);}
}
