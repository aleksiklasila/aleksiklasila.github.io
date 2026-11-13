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
    let reach=ceil(far as f64/(k.f(5)*k.f(29).max(1.0))) as i32;
    // (And the towers' longest reach, P[36]: tower.rs k_tower_acq asks as far.)
    *k.p::<i32>(34)=reach.max(k.i(36)).max(0);
}

// Multi-source BFS: for each viewer, the nearest graph distance to a
// nonempty visible enemy area. Population affects the CSR build, not queries.
// Structure answers use the same area rule, separately for each priority.
// Stops when every area has its answer, or past `maxd` steps (no query asks
// farther: area_batch's d<=reach).
#[inline(always)]
unsafe fn spread_answers(na:usize,answers:*mut i32,dist:*mut i32,queue:*mut i32,go:*const i32,gn:*const i32,maxd:i32){
    let mut head=0;let mut tail=0;
    for ar in 0..na {if *answers.add(ar)>=0 {*dist.add(ar)=0;*queue.add(tail)=ar as i32;tail+=1;}else{*dist.add(ar)=-1;}}
    while head<tail&&tail<na {
        let u=*queue.add(head) as usize;head+=1;let d=*dist.add(u)+1;
        if d>maxd {break;}
        for j in *go.add(u)..*go.add(u+1) {
            let v=*gn.add(j as usize) as usize;if v>=na||*dist.add(v)>=0 {continue;}
            *dist.add(v)=d;*answers.add(v)=*answers.add(u);*queue.add(tail)=v as i32;tail+=1;
        }
    }
}

/// The area answers, a job each: chunk = viewer * 5 + part. Part 0: the
/// nearest area holding a visible enemy unit; parts 1-4: the nearest area
/// holding a visible enemy structure of that class (the first such tile of
/// each area). Every job writes its own slices (and its own queue), so they
/// run on any threads, in any order, with one result.
#[no_mangle]
pub unsafe extern "C" fn k_acq_area_answers(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let na=k.i(20).max(0) as usize;let players=k.i(7).max(1) as usize;
    let c=chunk.max(0) as usize;let viewer=c/5;let part=c%5;
    if viewer>=players||na==0 {return;}
    let maxd=*k.p::<i32>(34);
    let go=k.p::<i32>(38);let gn=k.p::<i32>(39);let cov=k.p::<u8>(14);
    let queue=k.p::<i32>(42).add(c*na);
    if part==0 {
        let answers=k.p::<i32>(40).add(viewer*na);let dist=k.p::<i32>(41).add(viewer*na);let mask=k.p::<i32>(37);
        let others=!(1i32<<viewer);
        for ar in 0..na {
            *answers.add(ar)=if *cov.add(viewer*na+ar)!=0&&(*mask.add(ar)&others)!=0 {ar as i32}else{-1};
        }
        spread_answers(na,answers,dist,queue,go,gn,maxd);
        return;
    }
    let group=viewer*4+part-1;
    let structures=k.p::<i32>(43).add(group*na);let struct_dist=k.p::<i32>(44).add(group*na);
    // (Seeded by k_acq_area_seed, one tile pass a team for the four
    // classes, when that stage ran before: P[35] 1.)
    if k.i(35)==1 {spread_answers(na,structures,struct_dist,queue,go,gn,maxd);return;}
    for i in 0..na {*structures.add(i)=-1;}
    let ag=k.p::<i32>(13);let cls=k.p::<i8>(0);let owners=k.p::<i8>(1);
    let class=part as i8;
    for tile in 0..(k.i(15).max(0) as usize*k.i(16).max(0) as usize) {
        let cl=*cls.add(tile);let cl=if cl==5 {1}else{cl};
        if cl!=class {continue;}
        let owner=*owners.add(tile);if owner==-1||owner as i32==viewer as i32 {continue;}
        let ar=*ag.add(tile);if ar<0||ar as usize>=na {continue;}
        let ar=ar as usize;
        if *cov.add(viewer*na+ar)==0 {continue;}
        if *structures.add(ar)<0 {*structures.add(ar)=tile as i32;}
    }
    spread_answers(na,structures,struct_dist,queue,go,gn,maxd);
}

/// The structure answers' seeds of team `chunk` (viewer), for the four
/// classes in one pass over the tiles: per area the first (row-major) tile
/// of a visible enemy structure of each class, -1 none (what each class's
/// own answer job scanned the whole map for before: eight passes with two
/// teams). Then k_acq_area_answers' parts 1-4 only spread them (P[35] 1).
#[no_mangle]
pub unsafe extern "C" fn k_acq_area_seed(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let na=k.i(20).max(0) as usize;let players=k.i(7).max(1) as usize;
    let viewer=chunk.max(0) as usize;
    if viewer>=players||na==0 {return;}
    let cov=k.p::<u8>(14).add(viewer*na);
    let seeds=k.p::<i32>(43).add(viewer*4*na);
    for i in 0..4*na {*seeds.add(i)=-1;}
    let ag=k.p::<i32>(13);let cls=k.p::<i8>(0);let owners=k.p::<i8>(1);
    let tiles=k.i(15).max(0) as usize*k.i(16).max(0) as usize;
    for tile in 0..tiles {
        let cl=*cls.add(tile);let cl=if cl==5 {1}else{cl};
        if cl<1||cl>4 {continue;}
        let owner=*owners.add(tile);if owner==-1||owner as i32==viewer as i32 {continue;}
        let ar=*ag.add(tile);if ar<0||ar as usize>=na {continue;}
        let ar=ar as usize;
        if *cov.add(ar)==0 {continue;}
        let at=seeds.add((cl as usize-1)*na+ar);
        if *at<0 {*at=tile as i32;}
    }
}

// The area table's build (k_acq_area_build's count and scatter, its slot
// snapshot case: acq.saKey) in three stages, entries in fixed ranges (P[33]
// ranges, P[34] entries each): each range's histogram by key (acq.saHist,
// ranges * keys), the offsets (one job: every range's cursor, range-major
// within a key, so the scatter keeps the serial entry order), the scatter.
// One serial job of all of it held a helper ~20-30 ms at 350k entries.
#[no_mangle]
pub unsafe extern "C" fn k_acq_area_count(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let n=k.i(0).max(0) as usize;let na=k.i(20).max(0) as usize;
    let players=k.i(7).max(1) as usize;let keys=na*players;
    let per=k.i(34).max(1) as usize;let c=chunk.max(0) as usize;
    let e0=(c*per).min(n);let e1=(e0+per).min(n);
    let hist=k.p::<i32>(46).add(c*keys);let keyv=k.p::<i32>(45);
    core::ptr::write_bytes(hist,0,keys);
    for e in e0..e1 {
        match candidate(&k,e){Some((ar,owner,_,_,_,_)) if ar<na&&owner<players=>{let key=ar*players+owner;*keyv.add(e)=key as i32;*hist.add(key)+=1;}_=>{*keyv.add(e)=-1;}}
    }
}
#[no_mangle]
pub unsafe extern "C" fn k_acq_area_prefix(a:u32,_chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let na=k.i(20).max(0) as usize;let players=k.i(7).max(1) as usize;let keys=na*players;
    let ranges=k.i(33).max(0) as usize;
    let off=k.p::<i32>(27);let counts=k.p::<i32>(35);let cursor=k.p::<i32>(36);let hist=k.p::<i32>(46);
    // Range-major, every pass a sequential row: a key's ranges are `keys`
    // apart, so walking them key by key missed the cache on each (5-19 ms
    // serial at ~500k units, the chain's longest wait). Same outputs.
    core::ptr::write_bytes(counts,0,keys);
    for c in 0..ranges {let row=hist.add(c*keys);for key in 0..keys {*counts.add(key)+=*row.add(key);}}
    let mut total=0;
    for key in 0..keys {*off.add(key)=total;*cursor.add(key)=total;total+=*counts.add(key);}
    *off.add(keys)=total;
    // (Each range's cursor: its key's offset plus the earlier ranges' counts;
    // the cursors end as the serial build left them, offset + count.)
    for c in 0..ranges {let row=hist.add(c*keys);for key in 0..keys {let h=row.add(key);let v=*h;let cur=*cursor.add(key);*h=cur;*cursor.add(key)=cur+v;}}
    if k.i(28)==1 {prepare_area_answers(&k,na,players,off);}
}
#[no_mangle]
pub unsafe extern "C" fn k_acq_area_scatter(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let n=k.i(0).max(0) as usize;let na=k.i(20).max(0) as usize;
    let players=k.i(7).max(1) as usize;let keys=na*players;
    let per=k.i(34).max(1) as usize;let c=chunk.max(0) as usize;
    let e0=(c*per).min(n);let e1=(e0+per).min(n);
    let cur=k.p::<i32>(46).add(c*keys);let keyv=k.p::<i32>(45);
    let E=k.p::<i32>(28);
    let (es,xs,ys,sid)=(k.p::<i32>(19),k.p::<f32>(4),k.p::<f32>(5),k.p::<i32>(10));
    for e in e0..e1 {let key=*keyv.add(e);if key<0 {continue;}
        let slot=*es.add(e);let s=slot as usize;
        let at=cur.add(key as usize);let j=*at as usize;*at+=1;
        e_put(E,j,*xs.add(s),*ys.add(s),slot,*sid.add(s));
    }
}

/// The answers packed into acq.saRec (see RW), records [chunk * P[37], ..)
/// of the players * areas, after k_acq_area_answers wrote its ten arrays
/// (which the spreads keep as their own: dist is their visited mark).
#[no_mangle]
pub unsafe extern "C" fn k_acq_area_pack(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let na=k.i(20).max(0) as usize;let players=k.i(7).max(1) as usize;let total=na*players;
    if na==0 {return;}
    let per=k.i(37).max(1) as usize;let i0=(chunk.max(0) as usize*per).min(total);let i1=(i0+per).min(total);
    let (nearest,dist,structs,sdist,rec)=(k.p::<i32>(40),k.p::<i32>(41),k.p::<i32>(43),k.p::<i32>(44),k.p::<i32>(47));
    for i in i0..i1 {
        let owner=i/na;let ar=i%na;let r=rec.add(i*RW);
        *r=*nearest.add(i);
        let j0=owner*4*na+ar;let (j1,j2,j3)=(j0+na,j0+2*na,j0+3*na);
        *r.add(1)=*structs.add(j0);*r.add(2)=*structs.add(j1);*r.add(3)=*structs.add(j2);*r.add(4)=*structs.add(j3);
        *r.add(5)=(d_enc(*dist.add(i))|d_enc(*sdist.add(j0))<<16) as i32;
        *r.add(6)=(d_enc(*sdist.add(j1))|d_enc(*sdist.add(j2))<<16) as i32;
        *r.add(7)=(d_enc(*sdist.add(j3))|0xFFFF<<16) as i32;
    }
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
    for i in 0..nb.min(AB) {let (e,end)=(e0[i],e1[i]);if end==0 {continue;}
        let s=bs[i];let x=*xs.add(s);let y=*ys.add(s);
        let mut best=u64::MAX;let mut win=e;
        for j in 0..4 {let q=e+j;let q=if q<end {q}else{e};
            let dx=e_x(E,q)-x;let dy=e_y(E,q)-y;let d=dx*dx+dy*dy;
            let kq=(d.to_bits() as u64)<<32|e_id(E,q) as u32 as u64;
            let b=kq<best;best=if b {kq}else{best};win=if b {q}else{win};}
        *out.add(s)=e_slot(E,win);*tid.add(s)=best as u32 as i32;
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
