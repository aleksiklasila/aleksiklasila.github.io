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
// The area answers packed (acq.saRec, [47]): per (team, area) a 32-byte line (eight words, the first five used), a word a label: [0] the nearest area with a
// visible enemy unit, [1..5] the structure tile of each class; a word = the answer (low 24 bits, 0xFFFFFF none: areas
// and tiles of maps to 4096 x 4095) | its distance in area steps << 24 (255 none; the depth is at most 254). (Was the
// answers and the distances as u16 apart, two stores a label set. Five words a record, 20 bytes, straddled lines: the
// scan +11 %.)
pub const RW:usize=8;
pub const W_NONE:u32=0xFFFF_FFFF;
// (A word's answer (-1 none) and distance (0xFFFF none, as the u16 distances read).)
#[inline(always)] pub fn w_ans(w:u32)->i32{let a=w&0xFF_FFFF;if a==0xFF_FFFF{-1}else{a as i32}}
#[inline(always)] pub fn w_dist(w:u32)->u32{let d=w>>24;if d==255{0xFFFF}else{d}}
#[inline(always)] fn w_pack(a:i32,d:u32)->u32{(if a<0{0xFF_FFFF}else{a as u32&0xFF_FFFF})|(d.min(255)<<24)}

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
/// The live bits a level (acq.saLvH, 512 words a group: [2d], [2d + 1] the OR of level d's frontier masks, low and
/// high halves), cleared by k_acq_area_seed: level d + 1 looks only for those (a team and label whose frontier died
/// out is not looked for again; an area missing only such bits is passed over).
pub const LVH:usize=512;
#[inline(always)] unsafe fn live_or(p:*mut i32,m:u64){
    if m==0 {return;}
    let a=|q:*mut i32,v:u32|{if v!=0 {(*(q as *const core::sync::atomic::AtomicI32)).fetch_or(v as i32,core::sync::atomic::Ordering::Relaxed);}};
    a(p,m as u32);a(p.add(1),(m>>32) as u32);
}
#[inline(always)] unsafe fn live_get(p:*const i32)->u64{(*p as u32 as u64)|((*p.add(1) as u32 as u64)<<32)}

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
    let rec=k.p::<i32>(47) as *mut u32;
    let v0=g*GS;let nv=(players-v0).min(GS);
    let go=k.p::<i32>(38);let gn=k.p::<i32>(39);
    let maxd=(*k.p::<i32>(34)).clamp(0,254) as usize;
    // (The word of team v's label l at area x.)
    let rw=|v:usize,x:usize,l:usize|rec.add((v*na+x)*RW+l);
    if mode==0 {
        let cov=k.p::<u8>(14);let mask=k.p::<i32>(37);let sh=k.p::<i32>(50);
        // (Bits of no team, and of labels not searched (kept classes), count as reached.)
        let mut kept=0u64;
        for vi in 0..GS {
            if vi>=nv {for l in 0..5 {kept|=1u64<<(l*GS+vi);}continue;}
            let chg=if sh.is_null() {15}else{*sh.add((v0+vi)*SHW+SH_CHG)&31};
            for l in 1..5 {if chg&(1<<(l-1))==0 {kept|=1u64<<(l*GS+vi);}}
            // (Bit 4: its unit label updated in place at the seed stage, label0_update.)
            if chg&16!=0 {kept|=1u64<<vi;}
        }
        let mut any=0u64;
        for x in a0..a1 {
            let mut seed=0u64;
            for vi in 0..nv {
                let v=v0+vi;
                if kept&(1u64<<vi)==0 {
                    let unit=*cov.add(v*na+x)!=0&&(*mask.add(x)&!(1i32<<v))!=0;
                    *rw(v,x,0)=if unit {w_pack(x as i32,0)}else{W_NONE};
                    if unit {seed|=1u64<<vi;}
                }
                for l in 1..5 {
                    let b=1u64<<(l*GS+vi);if kept&b!=0 {continue;}
                    let p=rw(v,x,l);let a=w_ans(*p);
                    *p=if a>=0 {w_pack(a,0)}else{W_NONE};
                    if a>=0 {seed|=b;}
                }
            }
            *rch.add(x)=seed|kept;*fa.add(x)=seed;
            any|=seed;
        }
        live_or(flags,any);
        return;
    }
    // A level: the frontiers alternate (level d's in fa when d is even).
    let level=|d:usize,x0:usize,x1:usize|->u64{
        let (fp,fnx)=if d&1==1 {(fa,fb)}else{(fb,fa)};
        let live=live_get(flags.add(2*(d-1)));
        let mut any=0u64;
        for x in x0..x1 {
            let rx=*rch.add(x);
            let need=!rx&live;
            if need==0 {*fnx.add(x)=0;continue;}
            let mut acc=0u64;
            for j in *go.add(x)..*go.add(x+1) {
                let u=*gn.add(j as usize) as usize;if u>=na {continue;}
                let f=*fp.add(u)&need&!acc;
                if f==0 {continue;}
                let mut b=f;
                while b!=0 {let bit=b.trailing_zeros() as usize;b&=b-1;
                    let (l,vi)=(bit/GS,bit%GS);let v=v0+vi;
                    *rw(v,x,l)=(*rw(v,u,l)&0xFF_FFFF)|((d as u32)<<24);}
                acc|=f;
                if acc==need {break;}
            }
            *fnx.add(x)=acc;
            if acc!=0 {*rch.add(x)=rx|acc;any|=acc;}
        }
        any
    };
    if mode==1 {
        let d=k.i(45).max(1) as usize;
        if d>maxd||live_get(flags.add(2*(d-1)))==0 {return;}
        live_or(flags.add(2*d),level(d,a0,a1));
        return;
    }
    let mut d=k.i(45).max(1) as usize;
    while d<=maxd&&live_get(flags.add(2*(d-1)))!=0 {
        live_or(flags.add(2*d),level(d,0,na));
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
    let rec=(k.p::<i32>(47) as *mut u32).add(viewer*na*RW);
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
    // (The run's list, acq.stl: the chain's first stage made it; else the map.)
    let stl=k.p::<i32>(55);
    let each=|f:&mut dyn FnMut(usize)|{
        if !stl.is_null() {let n=(*stl).max(0) as usize;for i in 0..n {f(*stl.add(1+i) as usize);}return;}
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
    let mut fresh=true;
    // (A team's scratch for the structure classes' in-place update (acq.sinc, [56]; null: none). The tile walk below
    // marks each class's new seeds there (an area's first tile) and lists them: the update, the seeding and the
    // marks' clearing go by those lists, not the tiles again.)
    let inc=k.p::<i32>(56);
    let sl=if inc.is_null()||sh.is_null() {None}else{Some(Sinc::at(inc.add(viewer*sinc_stride(na)),na))};
    let mut nov=0u32;
    if !sh.is_null() {
        let st=sh.add(viewer*SHW);
        let mut h=[0u64;4];
        let hp=h.as_mut_ptr();
        each(&mut |tile:usize|{let c=class(tile);if c==0 {return;}
            let t=((tile as u64)<<2)|(c as u64-1);let x=hp.add(c-1);
            *x=(*x).wrapping_add(mix64(t)).wrapping_add(mix64(t^0x5851_f42d_4c95_7f2d).rotate_left(32));
            if let Some(ref s)=sl {let ar=*ag.add(tile) as usize;let p=s.ns.add(ar*4+c-1);
                if *p==0 {*p=tile as i32+1;let (l,n)=s.new_list(c);if (*n as usize)<s.room {*l.add(*n as usize)=ar as i32;*n+=1;}else{nov|=1<<(c-1);}}}});
        let reach=*k.p::<i32>(34);
        fresh=k.i(37)!=0||*st.add(SH_OK)!=1||*st.add(SH_REACH)!=reach;
        chg=0;
        for c in 0..4 {let (lo,hi)=(h[c] as u32 as i32,(h[c]>>32) as u32 as i32);
            if fresh||*st.add(2*c)!=lo||*st.add(2*c+1)!=hi {chg|=1<<c;}
            *st.add(2*c)=lo;*st.add(2*c+1)=hi;}
        *st.add(SH_REACH)=reach;*st.add(SH_OK)=1;*st.add(SH_CHG)=chg as i32;
    }
    // (The changed classes the records can be brought up to date in place: the rest searched again by the answers.)
    if let Some(ref s)=sl {
        let done=seed_update(&k,na,rec,ag,s,chg,fresh,nov);
        chg&=!done;
        let l0=label0_update(&k,viewer,na,rec,s,fresh);
        *sh.add(viewer*SHW+SH_CHG)=(chg|if l0 {16}else{0}) as i32;
    }
    if chg!=0 {
        for ar in 0..na {let r=rec.add(ar*RW);for c in 1..5 {if chg&(1<<(c-1))!=0 {*r.add(c)=W_NONE;}}}
        match sl {
            Some(ref s) if nov&chg==0 => for c in 1..5usize {if chg&(1<<(c-1))==0 {continue;}
                let (l,n)=s.new_list(c);for i in 0..(*n).max(0) as usize {let ar=*l.add(i) as usize;*rec.add(ar*RW+c)=w_pack(*s.ns.add(ar*4+c-1)-1,255);}},
            _ => each(&mut |tile:usize|{
                let c=class(tile);if c==0||chg&(1<<(c-1))==0 {return;}
                let at=rec.add(*ag.add(tile) as usize*RW+c);
                if w_ans(*at)<0 {*at=w_pack(tile as i32,255);}
            }),
        }
    }
    // (The marks cleared by the new lists (a list too long: by the tiles), the new lists the next run's old ones.)
    if let Some(ref s)=sl {
        for c in 1..5usize {let (l,n)=s.new_list(c);for i in 0..(*n).max(0) as usize {*s.ns.add(*l.add(i) as usize*4+c-1)=0;}}
        if nov!=0 {each(&mut |tile:usize|{let c=class(tile);if c==0 {return;}*s.ns.add(*ag.add(tile) as usize*4+c-1)=0;});}
        for c in 1..5usize {let (_,n)=s.new_list(c);if nov&(1<<(c-1))!=0 {*n=-1;}*s.par.add(c-1)^=1;let (_,m)=s.new_list(c);*m=0;}
    }
}

/// The unit label (word 0) of team v updated in place as seed_update updates a class: its seeds the areas holding a
/// visible enemy unit (the answers' seeds' test: covered for v, a foe's unit there, acq.saSeen [37]), a seed's answer
/// itself (no retiling); old seeds the records' areas at distance 0. One pass over the areas finds the gone and the new
/// ones; a gone seed's region cleared and pending, the new ones' wave (no farther than the old distances, ties too,
/// through pending areas), then the pending areas settled level by level from their first neighbour one level nearer.
/// False (the answers make the label whole): more changes than sinc_room, or records already touched past that.
#[cfg_attr(feature="prof",inline(never))]
unsafe fn label0_update(k:&K,v:usize,na:usize,rec:*mut u32,s:&Sinc,fresh:bool)->bool{
    let room=s.room;let pend=s.pend;
    let maxd=(*k.p::<i32>(34)).clamp(0,254) as u32;
    let (go,gn)=(k.p::<i32>(38),k.p::<i32>(39));
    let (cov,mask)=(k.p::<u8>(14),k.p::<i32>(37));
    // (No pass: the bitset no longer the last run's.)
    if go.is_null()||gn.is_null()||cov.is_null()||mask.is_null() {*s.l0b.add((na+31)/32)=0;return false;}
    let cov=cov.add(v*na);
    let seedp=|x:usize|->bool{*cov.add(x)!=0&&(*mask.add(x)&!(1i32<<v))!=0};
    // The gone and the new seed areas against the last run's (its bitset, s.l0b: kept every run, whatever made the
    // records), 32 areas a word; the new ones stored. (Records untouched so far: false leaves them to the answers.)
    // (The bitset's validity, the word after it: 0 until a pass stored every word.)
    let words=(na+31)/32;let valid=*s.l0b.add(words)==1;*s.l0b.add(words)=1;
    let (mut nrm,mut nad)=(0usize,0usize);let mut ok=!fresh&&valid;
    for wi in 0..words {let x0=wi*32;let x1=(x0+32).min(na);
        let mut nb=0u32;for x in x0..x1 {if seedp(x) {nb|=1<<(x-x0);}}
        let ob=*s.l0b.add(wi);*s.l0b.add(wi)=nb;
        let mut ch=nb^ob;
        while ok&&ch!=0 {let bi=ch.trailing_zeros();ch&=ch-1;let x=x0+bi as usize;
            if ob>>bi&1!=0 {if nrm>=room {ok=false;break;}*s.rq.add(nrm)=x as i32;nrm+=1;}
            else {if nad>=room {ok=false;break;}*s.al.add(nad)=x as i32;nad+=1;}}
    }
    if !ok {return false;}
    let (b,vb)=(1u8,16u8);let l=s.pl;let mut n=0usize;
    // The gone seeds' regions (the areas answered by them): cleared, pending.
    'rm: for i in 0..nrm {let a=*s.rq.add(i) as usize;let t0=a as i32;
        if n>=room {ok=false;break 'rm;}
        *rec.add(a*RW)=W_NONE;*pend.add(a)|=b;*l.add(n)=a as i32;n+=1;
        let mut h=n-1;
        while h<n {let x=*l.add(h) as usize;h+=1;
            for j in *go.add(x)..*go.add(x+1) {let u=*gn.add(j as usize);if u<0||(u as usize)>=na {continue;}let u=u as usize;
                if w_ans(*rec.add(u*RW))!=t0 {continue;}
                if n>=room {ok=false;break 'rm;}
                *rec.add(u*RW)=W_NONE;*pend.add(u)|=b;*l.add(n)=u as i32;n+=1;}
        }
    }
    // The new seeds' wave.
    let mut nf=0usize;
    if ok {for i in 0..nad {let ar=*s.al.add(i) as usize;
        if *pend.add(ar)&b==0 {if n>=room {ok=false;break;}*pend.add(ar)|=b;*l.add(n)=ar as i32;n+=1;}
        *pend.add(ar)|=vb;*s.qa.add(nf)=ar as i32;nf+=1;}}
    let (mut cur,mut nxt)=(s.qa,s.qb);let mut d=0u32;
    while ok&&nf>0&&d<maxd {
        let mut nn=0usize;
        'f: for i in 0..nf {let x=*cur.add(i) as usize;
            for j in *go.add(x)..*go.add(x+1) {let u=*gn.add(j as usize);if u<0||(u as usize)>=na {continue;}let u=u as usize;
                let pu=*pend.add(u);if pu&vb!=0 {continue;}
                if pu&b==0 {let od=w_dist(*rec.add(u*RW));if d+1>od {continue;}
                    // (A tie (as near as it is): only when x comes before its parent in its neighbours (ascending): its first
                    // neighbour that is x, pending, or settled one level nearer. Settled first: its parent stays, so does it.)
                    if d+1==od {let mut first_settled=false;
                        for jj in *go.add(u)..*go.add(u+1) {let w=*gn.add(jj as usize);if w<0||(w as usize)>=na {continue;}let w=w as usize;
                            if w==x||*pend.add(w)&b!=0 {break;}
                            let ww=*rec.add(w*RW);if w_ans(ww)>=0&&ww>>24==d {first_settled=true;break;}}
                        if first_settled {continue;}}}
                if n>=room||nn>=room {ok=false;break 'f;}
                *pend.add(u)=pu|vb;
                if pu&b==0 {*pend.add(u)|=b;*l.add(n)=u as i32;n+=1;}
                *nxt.add(nn)=u as i32;nn+=1;}
        }
        core::mem::swap(&mut cur,&mut nxt);nf=nn;d+=1;
    }
    for i in 0..n {*pend.add(*l.add(i) as usize)&=!vb;}
    if ok {
        // The pending areas cleared, the seeds among them placed; then by buckets as seed_update's levels.
        for i in 0..n {let x=*l.add(i) as usize;*rec.add(x*RW)=if seedp(x) {w_pack(x as i32,0)}else{W_NONE};}
        let mut cnt=[0u32;257];let cp=cnt.as_mut_ptr();
        for i in 0..n {let x=*l.add(i) as usize;if seedp(x) {*s.qa.add(i)=0;continue;}
            let mut md=255u32;
            for j in *go.add(x)..*go.add(x+1) {let u=*gn.add(j as usize);if u<0||(u as usize)>=na {continue;}
                let w=*rec.add(u as usize*RW);if w_ans(w)>=0 {md=md.min(w>>24);}}
            let lv=if md<255&&md+1<=maxd {md+1}else{0};*s.qa.add(i)=lv as i32;*cp.add(lv as usize+1)+=1;}
        for d in 1..257 {*cp.add(d)+=*cp.add(d-1);}
        let mut pos=cnt;let pp=pos.as_mut_ptr();
        for i in 0..n {let lv=*s.qa.add(i) as usize;if lv==0 {continue;}*s.qb.add(*pp.add(lv) as usize)=*l.add(i);*pp.add(lv)+=1;}
        let (mut rc,mut rn)=(s.al,s.rq);let mut nrc=0usize;
        let mut d=1u32;
        while d<=maxd {
            let (b0,b1)=(*cp.add(d as usize) as usize,*cp.add(d as usize+1) as usize);
            if b0==b1&&nrc==0 {d+=1;if (d as usize)>255||*cp.add(256) as usize<=*cp.add(d as usize) as usize {break;}continue;}
            let mut nrn=0usize;
            for pass in 0..2 {let (p,e)=if pass==0 {(s.qb.add(b0),b1-b0)}else{(rc as *mut i32,nrc)};
                for i in 0..e {let x=*p.add(i) as usize;
                    if pass==1 {*pend.add(x)&=!vb;}
                    if *rec.add(x*RW)!=W_NONE {continue;}
                    let mut got=W_NONE;
                    for j in *go.add(x)..*go.add(x+1) {let u=*gn.add(j as usize);if u<0||(u as usize)>=na {continue;}
                        let w=*rec.add(u as usize*RW);if w_ans(w)>=0&&w>>24==d-1 {got=w_pack(w_ans(w),d);break;}}
                    if got==W_NONE {continue;}
                    *rec.add(x*RW)=got;
                    if d<maxd {for j in *go.add(x)..*go.add(x+1) {let u=*gn.add(j as usize);if u<0||(u as usize)>=na {continue;}let u=u as usize;
                        let pu=*pend.add(u);if pu&b==0||pu&vb!=0||*rec.add(u*RW)!=W_NONE {continue;}
                        *pend.add(u)=pu|vb;*rn.add(nrn)=u as i32;nrn+=1;}}
                }
            }
            core::mem::swap(&mut rc,&mut rn);nrc=nrn;d+=1;
        }
        for i in 0..nrc {*pend.add(*rc.add(i) as usize)&=!vb;}
    }
    for i in 0..n {*pend.add(*l.add(i) as usize)=0;}
    ok
}
/// The incremental update's list room a class: an eighth of the areas (more changed: the class searched again whole).
#[inline(always)] fn sinc_room(na:usize)->usize{na/8+16}
/// A team's scratch in acq.sinc (i32 words): per area and class 1..4 its new seed tile + 1 (0 none: cleared after); per
/// class its list parity, two list counts (-1: too long, none kept) and two lists (its seed areas, the last run's and
/// this one's, in their first tiles' order); four pending lists, the added and retiled seeds, two queues (sinc_room
/// each); a byte an area (pending classes, bits 0-3; reached by the wave, 4-7).
/// (Then the unit label's seed areas of the last run, a bit an area: label0_update.)
#[inline(always)] pub fn sinc_stride(na:usize)->usize{4*na+12+16*sinc_room(na)+(na+3)/4+(na+31)/32+1}
struct Sinc{ns:*mut i32,par:*mut i32,cnt:*mut i32,sl:*mut i32,pl:*mut i32,al:*mut i32,rq:*mut i32,qa:*mut i32,qb:*mut i32,pend:*mut u8,l0b:*mut u32,room:usize}
impl Sinc{
    unsafe fn at(sc:*mut i32,na:usize)->Sinc{
        let room=sinc_room(na);let ns=sc;let par=sc.add(4*na);let cnt=par.add(4);let sl=cnt.add(8);let pl=sl.add(8*room);
        let al=pl.add(4*room);let rq=al.add(room);let qa=rq.add(room);let qb=qa.add(room);
        let pend=qb.add(room) as *mut u8;
        Sinc{ns,par,cnt,sl,pl,al,rq,qa,qb,pend,l0b:qb.add(room+(na+3)/4) as *mut u32,room}
    }
    #[inline(always)] unsafe fn list(&self,c:usize,w:usize)->(*mut i32,*mut i32){
        let b=(c-1)*2+w;(self.sl.add(b*self.room),self.cnt.add(b))}
    #[inline(always)] unsafe fn old_list(&self,c:usize)->(*mut i32,*mut i32){self.list(c,(*self.par.add(c-1)&1) as usize)}
    #[inline(always)] unsafe fn new_list(&self,c:usize)->(*mut i32,*mut i32){self.list(c,(*self.par.add(c-1)&1^1) as usize)}
}
/// The structure classes in chg (bit c - 1) of a team updated in place where the seeds changed little: the records a
/// search over the new seeds makes (the depth the reach; an area's answer its lowest-numbered neighbour's one level
/// nearer, k_acq_area_answers). Only these areas' answers can change: those whose answer is a seed no longer there (its
/// region: an area's answer is its parent's, so the areas of one answer are connected through it), those of a seed area
/// with another first tile (the tile only: the same distances), and those an added seed reaches as near as before or
/// nearer (ties too: another lowest-numbered parent; their descendants with them). Every other area keeps its distance
/// and parent chain. Those areas are cleared, the added seeds placed, then level by level each takes its answer from its
/// first neighbour (ascending) one level nearer, as the answers' pull. The seeds: the new lists and marks the tile walk
/// made; old ones the records' areas at distance 0, the last run's list. Returns the classes done; the others (fresh
/// records, a list too long (nov: this run's), more changes than sinc_room) are left to the whole search.
#[cfg_attr(feature="prof",inline(never))]
unsafe fn seed_update(k:&K,na:usize,rec:*mut u32,ag:*const i32,s:&Sinc,chg:u32,fresh:bool,nov:u32)->u32{
    let _=ag;
    let room=s.room;let ns=s.ns;let pend=s.pend;
    let maxd=(*k.p::<i32>(34)).clamp(0,254) as u32;
    let (go,gn)=(k.p::<i32>(38),k.p::<i32>(39));
    let mut ab=if fresh||go.is_null()||gn.is_null() {chg}else{chg&nov};
    for c in 1..5usize {let (_,n)=s.old_list(c);if chg&(1<<(c-1))!=0&&*n<0 {ab|=1<<(c-1);}}
    let mut np=[0usize;4];
    for c in 1..5usize {let b=1u32<<(c-1);if (chg&!ab)&b==0 {continue;}
        let l=s.pl.add((c-1)*room);let mut n=0usize;
        let vb=(b<<4) as u8;
        // The new seeds against the records (an old seed: an area at distance 0): the added and retiled ones.
        let (nl,nn)=s.new_list(c);let (mut nadd,mut nrq)=(0usize,0usize);
        for i in 0..(*nn).max(0) as usize {let ar=*nl.add(i) as usize;let tile=*ns.add(ar*4+c-1)-1;let w=*rec.add(ar*RW+c);
            if w>>24==0 {if w_ans(w)!=tile {*s.rq.add(nrq)=ar as i32;nrq+=1;}}
            else {*s.al.add(nadd)=ar as i32;nadd+=1;}
            if nadd>=room||nrq>=room {ab|=b;break;}
        }
        // The removed seeds' regions (the last run's seed areas without a new seed): cleared, pending.
        let (ol,on)=s.old_list(c);
        if ab&b==0 {'rm: for i in 0..(*on).max(0) as usize {let a=*ol.add(i) as usize;
            if *ns.add(a*4+c-1)!=0 {continue;}
            let w=*rec.add(a*RW+c);let t0=w_ans(w);if t0<0||w>>24!=0 {continue;}
            if n>=room {ab|=b;break 'rm;}
            *rec.add(a*RW+c)=W_NONE;*pend.add(a)|=b as u8;*l.add(n)=a as i32;n+=1;
            let mut h=n-1;
            while h<n {let x=*l.add(h) as usize;h+=1;
                for j in *go.add(x)..*go.add(x+1) {let u=*gn.add(j as usize);if u<0||(u as usize)>=na {continue;}let u=u as usize;
                    if w_ans(*rec.add(u*RW+c))!=t0 {continue;}
                    if n>=room {ab|=b;break 'rm;}
                    *rec.add(u*RW+c)=W_NONE;*pend.add(u)|=b as u8;*l.add(n)=u as i32;n+=1;}
            }
        }}
        // The retiled seeds' regions: the new tile, the same distances.
        if ab&b==0 {'rt: for i in 0..nrq {let a=*s.rq.add(i) as usize;
            let w=*rec.add(a*RW+c);let t0=w_ans(w);let nt=*ns.add(a*4+c-1)-1;if t0<0||nt<0 {continue;}
            *rec.add(a*RW+c)=w_pack(nt,0);
            let mut qn=1usize;*s.qa=a as i32;let mut h=0usize;
            while h<qn {let x=*s.qa.add(h) as usize;h+=1;
                for j in *go.add(x)..*go.add(x+1) {let u=*gn.add(j as usize);if u<0||(u as usize)>=na {continue;}let u=u as usize;
                    let wu=*rec.add(u*RW+c);if w_ans(wu)!=t0 {continue;}
                    *rec.add(u*RW+c)=w_pack(nt,wu>>24);
                    if qn>=room {ab|=b;break 'rt;}*s.qa.add(qn)=u as i32;qn+=1;}
            }
        }}
        // The added seeds' wave: the areas it reaches no farther than their distance (ties too), pending; it passes
        // through pending areas too (the ones past them may come nearer).
        let mut nf=0usize;
        if ab&b==0 {for i in 0..nadd {let ar=*s.al.add(i) as usize;
            if *pend.add(ar)&(b as u8)==0 {if n>=room {ab|=b;break;}*pend.add(ar)|=b as u8;*l.add(n)=ar as i32;n+=1;}
            *pend.add(ar)|=vb;*s.qa.add(nf)=ar as i32;nf+=1;}}
        let (mut cur,mut nxt)=(s.qa,s.qb);let mut d=0u32;
        while ab&b==0&&nf>0&&d<maxd {
            let mut nn=0usize;
            'f: for i in 0..nf {let x=*cur.add(i) as usize;
                for j in *go.add(x)..*go.add(x+1) {let u=*gn.add(j as usize);if u<0||(u as usize)>=na {continue;}let u=u as usize;
                    let pu=*pend.add(u);if pu&vb!=0 {continue;}
                    if pu&(b as u8)==0&&d+1>w_dist(*rec.add(u*RW+c)) {continue;}
                    if n>=room||nn>=room {ab|=b;break 'f;}
                    *pend.add(u)=pu|vb;
                    if pu&(b as u8)==0 {*pend.add(u)|=b as u8;*l.add(n)=u as i32;n+=1;}
                    *nxt.add(nn)=u as i32;nn+=1;}
            }
            core::mem::swap(&mut cur,&mut nxt);nf=nn;d+=1;
        }
        np[c-1]=n;
        if ab&b!=0 {continue;}
        for i in 0..n {*pend.add(*l.add(i) as usize)&=!vb;}
        // The pending areas cleared, the seeds among them placed; then a level at a time, each from its first
        // neighbour (ascending) one level nearer.
        for i in 0..n {let x=*l.add(i) as usize;let t=*ns.add(x*4+c-1)-1;*rec.add(x*RW+c)=if t>=0 {w_pack(t,0)}else{W_NONE};}
        // (Each pending area's first level: one past its nearest neighbour as the records hold them now (the settled
        // ones' distances, the placed seeds' 0), by a counting sort into qb; later only when a pending neighbour
        // settles one level nearer (al / rq, the next level's, its wave bit the mark: the wave is done).)
        let mut cnt=[0u32;257];let cp=cnt.as_mut_ptr();
        for i in 0..n {let x=*l.add(i) as usize;if *ns.add(x*4+c-1)!=0 {*s.qa.add(i)=0;continue;}
            let mut md=255u32;
            for j in *go.add(x)..*go.add(x+1) {let u=*gn.add(j as usize);if u<0||(u as usize)>=na {continue;}
                let w=*rec.add(u as usize*RW+c);if w_ans(w)>=0 {md=md.min(w>>24);}}
            let lv=if md<255&&md+1<=maxd {md+1}else{0};*s.qa.add(i)=lv as i32;*cp.add(lv as usize+1)+=1;}
        for d in 1..257 {*cp.add(d)+=*cp.add(d-1);}
        let mut pos=cnt;let pp=pos.as_mut_ptr();
        for i in 0..n {let lv=*s.qa.add(i) as usize;if lv==0 {continue;}*s.qb.add(*pp.add(lv) as usize)=*l.add(i);*pp.add(lv)+=1;}
        let (mut rc,mut rn)=(s.al,s.rq);let mut nrc=0usize;
        let mut d=1u32;
        while d<=maxd {
            let (b0,b1)=(*cp.add(d as usize) as usize,*cp.add(d as usize+1) as usize);
            if b0==b1&&nrc==0 {d+=1;if (d as usize)>255||*cp.add(256) as usize<=*cp.add(d as usize) as usize {break;}continue;}
            let mut nrn=0usize;
            for pass in 0..2 {let (p,e)=if pass==0 {(s.qb.add(b0),b1-b0)}else{(rc as *mut i32,nrc)};
                for i in 0..e {let x=*p.add(i) as usize;
                    if pass==1 {*pend.add(x)&=!vb;}
                    if *rec.add(x*RW+c)!=W_NONE {continue;}
                    let mut got=W_NONE;
                    for j in *go.add(x)..*go.add(x+1) {let u=*gn.add(j as usize);if u<0||(u as usize)>=na {continue;}
                        let w=*rec.add(u as usize*RW+c);if w_ans(w)>=0&&w>>24==d-1 {got=w_pack(w_ans(w),d);break;}}
                    if got==W_NONE {continue;}
                    *rec.add(x*RW+c)=got;
                    if d<maxd {for j in *go.add(x)..*go.add(x+1) {let u=*gn.add(j as usize);if u<0||(u as usize)>=na {continue;}let u=u as usize;
                        let pu=*pend.add(u);if pu&(b as u8)==0||pu&vb!=0||*rec.add(u*RW+c)!=W_NONE {continue;}
                        *pend.add(u)=pu|vb;*rn.add(nrn)=u as i32;nrn+=1;}}
                }
            }
            core::mem::swap(&mut rc,&mut rn);nrc=nrn;d+=1;
        }
        for i in 0..nrc {*pend.add(*rc.add(i) as usize)&=!vb;}
    }
    // (The marks cleared.)
    for c in 1..5usize {let l=s.pl.add((c-1)*room);for i in 0..np[c-1] {*pend.add(*l.add(i) as usize)=0;}}
    chg&!ab
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
    if k.i(40)==2 {
        core::ptr::write_bytes(counts.add(k0),0,k1-k0);
        // (Job 0: the run's structure tiles of class 1..5 ascending into acq.stl ([55]; [0] the count): the seed
        // stage's teams walk them, not the map. Sixteen tiles at a time by one vector test.)
        let stl=k.p::<i32>(55);let cls=k.p::<i8>(0);
        if j==0&&!stl.is_null()&&!cls.is_null() {
            let tiles=k.i(15).max(0) as usize*k.i(16).max(0) as usize;
            let (lo,hi)=(i8x16_splat(1),i8x16_splat(5));
            let (mut t,mut c)=(0usize,0usize);
            while t+16<=tiles {
                let v=v128_load(cls.add(t) as *const v128);
                let mut m=i8x16_bitmask(v128_and(i8x16_ge(v,lo),i8x16_le(v,hi))) as u32;
                while m!=0 {let l=m.trailing_zeros() as usize;m&=m-1;*stl.add(1+c)=(t+l) as i32;c+=1;}
                t+=16;
            }
            while t<tiles {let v=*cls.add(t);if v>=1&&v<=5 {*stl.add(1+c)=t as i32;c+=1;}t+=1;}
            *stl=c as i32;
        }
        return;
    }
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
        // (A distance counts up to the reach; 255 none: above any.)
        // (At most 254: no distance is longer, and 255 (none) is never within it.)
        lim[i]=(ceil(*ranges.add(s) as f64/step) as i32).clamp(-1,254) as i64;
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
    // (A word orders as its (distance, answer): the distance in its top byte. So the least key of each label over the
    // window is the least word within the reach: words 0-3 four lanes at a time, word 4 alone.)
    let _=key;
    for i in 0..nb.min(AB) {let s=bs[i];let base=(*own.add(s) as usize)*na;let lim=lim[i];let wants=wants[i];
        let mx=u32x4_splat(u32::MAX);let mut acc=mx;let mut m4=u32::MAX;
        let limv=u32x4_splat(lim.max(0) as u32);let any=lim>=0;
        for t in 0..4 {let a=ar[i][t];let ok=any&&a!=u32::MAX;
            let r=rec.add((base+if ok {a as usize}else{0})*RW) as *const u32;
            let v=v128_load(r as *const v128);
            let m=v128_and(u32x4_le(u32x4_shr(v,24),limv),i32x4_splat(-(ok as i32)));
            acc=u32x4_min(acc,v128_bitselect(v,mx,m));
            let w4=*r.add(4);if ok&&(w4>>24) as i64<=lim {m4=m4.min(w4);}
        }
        let u0=u32x4_extract_lane::<0>(acc);
        if wants {let st=[u32x4_extract_lane::<1>(acc),u32x4_extract_lane::<2>(acc),u32x4_extract_lane::<3>(acc),m4];
            for c in 0..4 {if st[c]!=u32::MAX {*sout.add(s)=(st[c]&0xFF_FFFF) as i32;break;}}}
        unit[i]=if u0==u32::MAX {u64::MAX}else{((u0>>24) as u64)<<32|(u0&0xFF_FFFF) as u64};
    }
    // The target area's bucket of an enemy (the first with any, from a seeded
    // player), a fixed batch of four in it (as the unit's id and the epoch seed).
    let mut e0=[0usize;AB];let mut e1=[0usize;AB];
    let keptv=if k.i(56)==1 {k.p::<u8>(54)}else{core::ptr::null_mut()};
    for i in 0..nb.min(AB) {if unit[i]==u64::MAX {continue;}
        // (A unit keeping its brain target: no unit answer (acq.out -3 - its slot now: the commit makes its fallback only
        // where it still stands, its snapshot columns are of this slot), its fallback lazy at the commit.)
        if !keptv.is_null()&&*keptv.add(bs[i])==2 {*out.add(bs[i])=-3-bs[i] as i32;unit[i]=u64::MAX;continue;}
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

/// The brain's kept target for unit q (k.rs k_combat_brain's test, the same): an idle or attack-moving unit that is
/// no mover and has no order, with a unit instruction (no structure) whose target, in the snapshot, is still that unit,
/// alive, hostile and in a covered area. [53] acq.ct; B: [0] slots, [5] tile, [7] teams, [8] / [9] / [18] the commands,
/// [15] / [16] the map, [20] areas.
/// Its word: 1 not kept, 2 kept, 3 / 4 kept with its range question held by the cache (brain_kept_v).
#[inline(always)]
unsafe fn brain_kept_full(k:&K,q:usize)->u8{
    let (flg,cmd,cm,ct,ctid,id,own)=(k.p::<u8>(7),k.p::<u8>(8),k.p::<u8>(48),k.p::<i32>(53),k.p::<i32>(49),k.p::<i32>(10),k.p::<i8>(6));
    if cm.is_null()||ct.is_null()||ctid.is_null() {return 1;}
    let fl=*flg.add(q);if fl&11!=0 {return 1;}
    let c=*cmd.add(q);let mover=fl&16!=0;let cmd_atk=k.i(18) as u8;
    let order=c==cmd_atk&&cmd_atk!=0&&*cm.add(q)&32!=0;
    if c!=k.i(8) as u8&&c!=k.i(9) as u8&&!mover&&!order {return 1;}
    let owner=*own.add(q) as i32;if !(owner>=0&&owner<k.i(7)) {return 1;}
    if order||mover {return 1;}
    let cur=*ct.add(q);let nsl=k.i(0).max(0) as usize;
    if *cm.add(q)==0||*cm.add(q)&16!=0||cur<0||(cur as usize)>=nsl {return 1;}
    let cu=cur as usize;
    if !(*flg.add(cu)&1==0&&*id.add(cu)==*ctid.add(q)&&*own.add(cu) as i32!=owner) {return 1;}
    brain_kept_v(k,q,cu,owner)
}
/// As brain_kept_full from the target on (cu, its owner's foe): 1 not kept, else 2, or 3 / 4 when the brain's range cache
/// (acq.brc [58], key: the unit's tile and window flags, the target's, the reach acq.rk [57]; bit 61 the answer, as
/// k.rs k_combat_brain makes it) holds its question: in range / not. The target's position read once for both.
#[inline(always)]
unsafe fn brain_kept_v(k:&K,q:usize,cu:usize,owner:i32)->u8{
    let itile=(1.0/k.f(5)) as f32;let (gw,gh,na)=(k.i(15),k.i(16),k.i(20));
    let (fx,fy)=(*k.p::<f32>(4).add(cu)*itile,*k.p::<f32>(5).add(cu)*itile);
    let (gxf,gyf)=(super::k::floorf(fx),super::k::floorf(fy));
    let (gx,gy)=(gxf as i32,gyf as i32);
    if gx<0||gy<0||gx>=gw||gy>=gh {return 1;}
    let ar=*k.p::<i32>(13).add((gy*gw+gx) as usize);
    if !(ar>=0&&*k.p::<u8>(14).add((owner*na+ar) as usize)>0) {return 1;}
    let (rk,brc)=(k.p::<u8>(57),k.p::<u64>(58));
    if rk.is_null()||brc.is_null() {return 2;}
    let r=*rk.add(q) as u64;if r>=32 {return 2;}
    let fl=|fx:f32,fy:f32,gxf:f32,gyf:f32|->u64{let (rx,ry)=(fx-gxf,fy-gyf);(rx<0.3) as u64|(((rx>=0.7) as u64)<<1)|(((ry<0.3) as u64)<<2)|(((ry>=0.7) as u64)<<3)};
    let tt=(gy*gw+gx) as u64;if tt>=1<<24 {return 2;}
    let tk=(tt<<4)|fl(fx,fy,gxf,gyf);
    let (ux,uy)=(*k.p::<f32>(4).add(q)*itile,*k.p::<f32>(5).add(q)*itile);
    let (uxf,uyf)=(super::k::floorf(ux),super::k::floorf(uy));
    let (ugx,ugy)=(uxf as i32,uyf as i32);
    if ugx<0||ugy<0||ugx>=gw||ugy>=gh {return 2;}
    let ut=(ugy*gw+ugx) as u64;if ut>=1<<24 {return 2;}
    let key=((ut<<4)|fl(ux,uy,uxf,uyf))|(tk<<28)|(r<<56)|(1u64<<62);
    let e=*brc.add(q);
    if e&!(1u64<<61)!=key {return 2;}
    if (e>>61)&1==1 {3}else{4}
}
/// The brain's area window (k.rs k_combat_brain's window): the areas under a unit's +-0.3 tile window (at most four)
/// and whether its own tile has an area.
#[inline(always)]
unsafe fn brain_window(x:f32,y:f32,itile:f32,gw:i32,gh:i32,ag:*const i32)->([i32;4],usize,bool){
    let fx=x*itile;let fy=y*itile;
    let (gxf,gyf)=(super::k::floorf(fx),super::k::floorf(fy));
    let (gx,gy)=(gxf as i32,gyf as i32);
    let (rx,ry)=(fx-gxf,fy-gyf);
    let (xa,xb)=(gx-(rx<0.3) as i32,gx+(rx>=0.7) as i32);
    let (ya,yb)=(gy-(ry<0.3) as i32,gy+(ry>=0.7) as i32);
    let mut out=[0i32;4];let mut n=0usize;let mut own=false;
    for t in 0..4usize {
        let (xx,yy)=(if t&1==0 {xa}else{xb},if t<2 {ya}else{yb});
        let inb=(xx as u32)<(gw as u32)&&(yy as u32)<(gh as u32);
        let ar=*ag.add(if inb {(yy*gw+xx) as usize}else{0});
        let take=inb&&ar>=0&&(t&1==0||xb!=xa)&&(t<2||yb!=ya);
        *out.as_mut_ptr().add(n)=ar;
        n+=take as usize;
        own=if xx==gx&&yy==gy {inb&&ar>=0}else{own};
    }
    (out,n,own)
}
/// What a commit needs for the lazy fallbacks: the run's snapshot columns of the unit (x, y, owner, flags, range, id,
/// ctid, rk), its records, bucket offsets and entries, the area grid and reach header, the run's seed, teams, areas,
/// map, tile and area step (P[16..22], P[23] 1).
pub(crate) struct LazyFb{xs:*const f32,ys:*const f32,own:*const i8,flags:*const u8,rng:*const f32,ids:*const i32,ctid:*const i32,rk:*const u8,
    rec:*const u32,off:*const i32,e:*const i32,ag:*const i32,hdr:*const i32,arg:*const i32,epoch:u32,players:usize,na:usize,gw:i32,gh:i32,tile:f64,step:f64,
    uids:*const i32,uslots:*const i32,nid:usize}
impl LazyFb{
    pub(crate) unsafe fn from(k:&K,arg:*const i32,xs:usize,ys:usize,own:usize,flags:usize,rng:usize,ids:usize,ctid:usize,rk:usize,rec:usize,off:usize,e:usize,ag:usize,hdr:usize,uid:usize)->Option<LazyFb>{
        if k.i(23)!=1 {return None;}
        let l=LazyFb{xs:k.p::<f32>(xs),ys:k.p::<f32>(ys),own:k.p::<i8>(own),flags:k.p::<u8>(flags),rng:k.p::<f32>(rng),ids:k.p::<i32>(ids),ctid:k.p::<i32>(ctid),rk:k.p::<u8>(rk),
            rec:k.p::<u32>(rec),off:k.p::<i32>(off),e:k.p::<i32>(e),ag:k.p::<i32>(ag),hdr:k.p::<i32>(hdr),arg,
            epoch:k.i(16) as u32,players:k.i(17).max(1) as usize,na:k.i(18).max(0) as usize,gw:k.i(19),gh:k.i(20),tile:k.f(21),step:k.f(21)*k.f(22).max(1.0),
            uids:k.p::<i32>(uid),uslots:k.p::<i32>(uid+1),nid:k.i(24).max(0) as usize};
        if l.rec.is_null()||l.off.is_null()||l.e.is_null()||l.ag.is_null()||l.hdr.is_null()||l.uids.is_null()||l.uslots.is_null()||l.na==0 {return None;}
        Some(l)
    }
}
/// The fallback of unit q keeping its target tq, as the scan and the brain would have made it (the scan's unit answer:
/// area_batch's records, bucket batch by its seed, the nearest of it but tq's unit; the brain's word on it: 5 in range
/// (the area distance within the reach, else the windows' search), held 0, else 2): (word, slot, id), word 0 none. The
/// answer's position from its bucket entry (the snapshot's own copy: the commit pass rewrites the snapshot block by block).
pub(crate) unsafe fn lazy_fallback(l:&LazyFb,q:usize,tq:i32)->(u8,i32,i32){
    let mut arq=match super::arq::Arq::new(l.hdr,l.arg){Some(z)=>z,None=>return (0,-1,0)};
    let (na,players,gw,gh,tile)=(l.na,l.players,l.gw,l.gh,l.tile);
    let fx=*l.xs.add(q) as f64/tile;let fy=*l.ys.add(q) as f64/tile;
    let gx=floor(fx) as i32;let gy=floor(fy) as i32;let rx=fx-gx as f64;let ry=fy-gy as f64;
    let wx=[gx-(rx<0.3) as i32,gx+(rx>=0.7) as i32];let wy=[gy-(ry<0.3) as i32,gy+(ry>=0.7) as i32];
    let lim=(ceil(*l.rng.add(q) as f64/l.step) as i32).clamp(-1,254) as i64;
    let base=(*l.own.add(q) as usize)*na;
    #[inline(always)] fn lkey(d:u32,t:i32,ok:bool)->u64{if ok {(d as u64)<<32|t as u32 as u64}else{u64::MAX}}
    let mut u=u64::MAX;
    for t in 0..4 {let (xx,yy)=(wx[t&1],wy[t>>1]);
        let inb=(xx as u32)<(gw as u32)&&(yy as u32)<(gh as u32);
        let a=*l.ag.add(if inb {(yy*gw+xx) as usize}else{0}) as u32;
        let ok=inb&&a<(na as u32);
        let w0=*l.rec.add((base+if ok {a as usize}else{0})*RW);let du=w0>>24;
        u=u.min(lkey(du,(w0&0xFF_FFFF) as i32,ok&&(du as i64)<=lim));
    }
    if u==u64::MAX {return (0,-1,0);}
    let a=u as u32 as usize;let owner=*l.own.add(q) as usize;
    let seed=mix((*l.ids.add(q) as u32)^l.epoch.wrapping_mul(0x9e3779b9));
    let f0=((seed as u64*players as u64)>>32) as usize;
    let (mut e0,mut e1)=(0usize,0usize);
    for j in 0..players {let mut foe=f0+j;if foe>=players {foe-=players;}if foe==owner {continue;}
        let key=a*players+foe;let lo=*l.off.add(key) as usize;let hi=*l.off.add(key+1) as usize;let count=hi-lo;if count==0 {continue;}
        let e=lo+if count>4 {((mix(seed^a as u32) as u64*(count-3) as u64)>>32) as usize}else{0};
        e0=e;e1=e+count.min(4);break;
    }
    if e1==0 {return (0,-1,0);}
    let E=l.e;let x=*l.xs.add(q);let y=*l.ys.add(q);let skip=*l.ctid.add(q);
    let mut best=u64::MAX;let mut win=e0;
    for j in 0..4 {let qq=e0+j;let qq=if qq<e1 {qq}else{e0};
        let dx=e_x(E,qq)-x;let dy=e_y(E,qq)-y;let d=dx*dx+dy*dy;let id=e_id(E,qq);
        let kq=if id==skip {u64::MAX}else{(d.to_bits() as u64)<<32|id as u32 as u64};
        let b=kq<best;best=if b {kq}else{best};win=if b {qq}else{win};}
    if best==u64::MAX {return (0,-1,0);}
    // (Its unit at its slot now: the relayout may have moved it since the index (the scan's answer follows such moves).)
    let otid=best as u32 as i32;let o=if e_slot(E,win)<0 {-1}else{super::tower::id_slot(l.uids,l.uslots,l.nid,otid)};
    if o<0||o==tq {return (0,-1,0);}
    let rk=*l.rk.add(q) as i32;
    let od=(u>>32).min(254) as i32;
    let in_range=if od<=rk {true}else{
        let itile=(1.0/tile) as f32;
        let src=brain_window(x,y,itile,gw,gh,l.ag);
        let tgt=brain_window(e_x(E,win),e_y(E,win),itile,gw,gh,l.ag);
        let nt=if tgt.2 {tgt.1}else{0};
        src.1>0&&nt>0&&arq.within(core::slice::from_raw_parts(src.0.as_ptr(),src.1),core::slice::from_raw_parts(tgt.0.as_ptr(),nt),rk)
    };
    (if in_range {5}else if *l.flags.add(q)&32!=0 {0}else{2},o,otid)
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
    // ([54] acq.kept, B[56] 1 with the brain: the brain's kept-target test made here for the units the scan looks at.)
    let keptv=k.p::<u8>(54);let lazy=k.i(56)==1&&!keptv.is_null();
    for s in start..end {
        if lazy {*keptv.add(s)=0;}
        let fl=*flags.add(s);let command=*cmd.add(s) as i32;
        if fl&7!=0 || (command!=k.i(8)&&command!=k.i(9)&&command!=k.i(18)&&fl&16==0) {continue;}
        let owner=*own.add(s) as i32;let r=*ranges.add(s);
        if owner<0||owner>=k.i(7)||!(r>0.0){continue;}
        *out.add(s)=-1;*tid.add(s)=0;*sout.add(s)=-1;
        let od=k.p::<u8>(51);if !od.is_null() {*od.add(s)=255;}
        let x=*xs.add(s);let y=*ys.add(s);
        if k.i(28)==1 {
            // (A unit keeping its brain target needs nothing of the batch: no unit answer (its fallback lazy at the
            // commit, acq.out -3 - its slot), no structure (the brain takes one only with no unit target), no distance.)
            // (Its range question answered here when the brain's cache (acq.brc, [58]) holds it: 3 in range, 4 not.)
            if lazy {let kv=brain_kept_full(&k,s);*keptv.add(s)=kv;if kv>=2 {*out.add(s)=-3-s as i32;continue;}}
            *bs.get_unchecked_mut(nb)=s;nb+=1;if nb==AB {area_batch(&k,&bs,nb);nb=0;}continue;}
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
