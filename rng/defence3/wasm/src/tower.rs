//! Tower unit acquisition. A per-tick spatial-entry snapshot in SoA form,
//! shared by every due tower: contiguous coordinates and packed type/status
//! flags allow four candidates to be filtered together, with f64x2 distance
//! arithmetic matching JavaScript. Reduction retains the original visiting
//! order, including exact-distance ties and primary/affected/immune priority.
use super::*;
use super::k::K;

#[inline]
unsafe fn stationary_sort(p:*mut i32,n:usize) {
    // Raw-pointer heapsort avoids pulling slice-sort panic data into the
    // shared-memory module (instantiations must have no data segments).
    if n<2 {return;}
    for root in (0..n/2).rev() {stationary_sift(p,root,n);}
    for end in (1..n).rev() {core::ptr::swap(p,p.add(end));stationary_sift(p,0,end);}
}
#[inline]
unsafe fn stationary_sift(p:*mut i32,mut root:usize,end:usize) {
    loop {let mut child=root*2+1;if child>=end {return;}if child+1<end&&*p.add(child)<*p.add(child+1){child+=1;}if *p.add(root)>=*p.add(child){return;}core::ptr::swap(p.add(root),p.add(child));root=child;}
}

/// Common short-range rows everywhere, longer rows only where stationary
/// entities can use them. This keeps rare watch/sniper ranges from expanding
/// every area on a million-tile map. Max is independent of job scheduling.
#[no_mangle]
pub unsafe extern "C" fn k_stationary_need(a:u32,chunk:i32) {
    use core::sync::atomic::{AtomicI32,Ordering};
    let k=K::new(waddr(a) as *const i32);let code=k.p::<u8>(0);let own=k.p::<i32>(1);let brain=k.p::<u32>(2);let grid=k.p::<i32>(3);let ranges=k.p::<i32>(4);let need=k.p::<AtomicI32>(5);
    for t in chunk*k.i(1)..((chunk+1)*k.i(1)).min(k.i(0)) {
        let t=t as usize;if *code.add(t)!=0x22 {continue;}
        let ty=(*brain.add(t)&65535) as i32-1;let o=*own.add(t);let ar=*grid.add(t);
        if ty<0||ty>=k.i(2)||o< -1||o>=k.i(3)||ar<0||ar>=k.i(5) {continue;}
        let r=(*ranges.add(((o+1)*k.i(2)+ty) as usize)).min(k.i(4));
        (*need.add(ar as usize)).fetch_max(r,Ordering::Relaxed);
    }
}

/// Layout-derived stationary reach tables. Each source is independent. A
/// source's BFS layers are sorted by area id, matching the existing query
/// visiting order (and therefore exact-distance unit ties). Counts/prefixes
/// and filling are separate background stages; no per-turret list copies.
#[no_mangle]
pub unsafe extern "C" fn k_stationary_areas(a:u32,chunk:i32) {
    let arg=waddr(a) as *const i32;let k=K::new(arg);
    let na=k.i(0) as usize;let dd=k.i(2) as usize;let mode=k.i(3);
    let off=k.p::<i32>(0);let nb=k.p::<i32>(1);let bounds=k.p::<i32>(2);
    let offsets=k.p::<i32>(3);let ids=k.p::<i32>(4);let boxes=k.p::<i32>(5);let meta=k.p::<i32>(6);let need=k.p::<i32>(7);
    if mode==2 {
        let mut sum=0i64;
        for source in 0..na {
            let row=offsets.add(source*(dd+1));let count=*row.add(dd);
            *row=sum.min(i32::MAX as i64) as i32;
            for d in 1..=dd {*row.add(d)=(*row.add(d) as i64+sum).min(i32::MAX as i64) as i32;}
            sum+=count as i64;
        }
        *meta.add(1)=sum.min(i32::MAX as i64) as i32;
        *meta=if sum>k.i(4) as i64 {-1}else{sum as i32};return;
    }
    let sc=waddr(*arg.add(1000) as u32) as *mut i32;
    if sc.is_null()||(*arg.add(1001) as usize)<2*na { *meta=-1;return; }
    let queue=sc.add(na);
    core::ptr::write_bytes(sc,0,na);
    let begin=chunk as usize*k.i(1) as usize;
    for source in begin..((chunk as usize+1)*k.i(1) as usize).min(na) {
        let epoch=(source-begin+1) as i32;*sc.add(source)=epoch;*queue=source as i32;
        let mut lo=0;let mut hi=1;let mut x0=i32::MAX;let mut y0=i32::MAX;let mut x1=-1;let mut y1=-1;
        for d in 0..dd {
            let row=source*dd+d;
            if mode==0 {*offsets.add(source*(dd+1)+d+1)=hi as i32;}
            else {
                let start=*offsets.add(source*(dd+1)) as usize;
                core::ptr::copy_nonoverlapping(queue.add(lo),ids.add(start+lo),hi-lo);
                for j in lo..hi {let b=bounds.add(*queue.add(j) as usize*4);if *b<=*b.add(2){x0=x0.min(*b);y0=y0.min(*b.add(1));x1=x1.max(*b.add(2));y1=y1.max(*b.add(3));}}
                let b=boxes.add(row*4);*b=x0;*b.add(1)=y0;*b.add(2)=x1;*b.add(3)=y1;
            }
            if d+1==dd {break;}
            if d>=*need.add(source) as usize {lo=hi;continue;}
            let mut tail=hi;
            for j in lo..hi {let ar=*queue.add(j) as usize;for p in *off.add(ar)..*off.add(ar+1) {let n=*nb.add(p as usize) as usize;if *sc.add(n)!=epoch {*sc.add(n)=epoch;*queue.add(tail)=n as i32;tail+=1;}}}
            stationary_sort(queue.add(hi),tail-hi);lo=hi;hi=tail;
        }
    }
}

/// One mass stationary brain input pass. Descriptors are published on
/// changes; stats and reach tables are shared by owner/type/level and area.
/// Queries reference immutable CSR slices directly. Four adjacent query
/// origins are written with SIMD; there is no JS stat/area work per turret.
/// A tower with custom stats or position (descriptor bit 25) reads its row's
/// (tc.*, by st.rrow: tower.js towerCustomWrite). A reach past what the
/// table holds (its area's need, its depth) is the table's for now, counted
/// (tac.ext[job]): the next table is made deep enough (tower.js). A preferred
/// target (bit 24): tac.pref 1 (k_tower_fire looks at it first).
#[no_mangle]
pub unsafe extern "C" fn k_tower_prepare(a:u32,chunk:i32) {
    let k=K::new(waddr(a) as *const i32);
    let input=k.p::<i32>(0);let code=k.p::<u8>(1);let owner=k.p::<i32>(2);let uc=k.p::<u8>(3);let energy=k.p::<f64>(4);let timer=k.p::<f64>(5);let brain=k.p::<u32>(6);
    let ranges=k.p::<i32>(7);let cds=k.p::<i32>(8);let kinds=k.p::<i32>(9);let grid=k.p::<i32>(10);let offsets=k.p::<i32>(11);let boxes=k.p::<i32>(12);
    let qx=k.p::<f32>(13);let qy=k.p::<f32>(14);let qo=k.p::<i32>(15);let qt=k.p::<i32>(16);let qb=k.p::<i32>(17);let qtile=k.p::<i32>(18);let qoff=k.p::<i32>(19);let qbox=k.p::<i32>(20);let valid=k.p::<i32>(21);
    let need=k.p::<i32>(31);let rrow=k.p::<i32>(32);
    let (cx,cy,crange,ccd,cdmg,cblast,crad,clvl)=(k.p::<f32>(33),k.p::<f32>(34),k.p::<i32>(35),k.p::<i32>(36),k.p::<f32>(37),k.p::<f32>(38),k.p::<f32>(39),k.p::<i32>(40));
    let pref=k.p::<i32>(41);let ext=k.p::<i32>(42);
    let w=k.i(2).max(1);let dd=k.i(3);let nt=k.i(4);let nl=k.i(5);let np=k.i(6);let now=k.f(7);let tile=k.f(8) as f32;
    let start=chunk*k.i(1);let end=((chunk+1)*k.i(1)).min(k.i(0));
    let mut extended=0;
    for first in (start..end).step_by(4) {
        let mut xs=[0i32;4];let mut ys=[0i32;4];let mut cpos=[(-1i32,0f32,0f32);4];
        for lane in 0..(end-first).min(4) as usize {
            let q=first as usize+lane;*valid.add(q)=0;*qoff.add(q*2)=0;*qoff.add(q*2+1)=0;*qbox.add(q*4+2)=-1;*qb.add(q)=0;*pref.add(q)=0;
            let t=*input.add(q);*qtile.add(q)=t;
            if t<0||t>=k.i(9)||*code.add(t as usize)!=0x22||*uc.add(t as usize)!=0||!(*energy.add(t as usize)>0.0)||now<=ceil(*timer.add(t as usize)) {continue;}
            if q>0&&*input.add(q-1)==t {continue;}
            let t=t as usize;let descriptor=*brain.add(t);let ty=(descriptor&65535) as i32-1;let level=((descriptor>>16)&255) as i32;let own=*owner.add(t);
            if ty<0||ty>=nt||own< -1||own>=np {continue;}
            let kind=*kinds.add(ty as usize);if kind<0 {continue;}
            let custom=descriptor&(1<<25)!=0;let row=*rrow.add(t);
            if custom&&row<0 {continue;}
            let ru=row.max(0) as usize;
            let stat=(((own+1)*nt+ty)*nl+level.max(1).min(nl-1)) as usize;
            let (mut range,cd,damage,blast,radius,elvl)=if custom{(*crange.add(ru),*ccd.add(ru),*cdmg.add(ru) as f64,*cblast.add(ru) as f64,*crad.add(ru) as f64,*clvl.add(ru))}
                else{if level<1||level>=nl {continue;}(*ranges.add(stat),*cds.add(stat),*k.p::<f32>(22).add(stat) as f64,*k.p::<f32>(23).add(stat) as f64,*k.p::<f32>(24).add(stat) as f64,(descriptor>>26) as i32)};
            let area=*grid.add(t);
            if range<0||area<0||area>=k.i(10) {continue;}
            let cap=(*need.add(area as usize)).min(dd-1);
            if range>cap {range=cap.max(0);extended+=1;}
            let row4=(area*dd+range) as usize;
            let list=(area*(dd+1)) as usize;
            *qoff.add(q*2)=*offsets.add(list);*qoff.add(q*2+1)=*offsets.add(list+range as usize+1);
            v128_store(qbox.add(q*4) as *mut v128,v128_load(boxes.add(row4*4) as *const v128));
            *xs.get_unchecked_mut(lane)=t as i32%w;*ys.get_unchecked_mut(lane)=t as i32/w;*qo.add(q)=own;*qt.add(q)=kind;
            if custom {*cpos.get_unchecked_mut(lane)=(q as i32,*cx.add(ru),*cy.add(ru));}
            *qb.add(q)=cd;
            if descriptor&(1<<24)!=0 {*pref.add(q)=1;}
            let late=(now-(ceil(*timer.add(t))+1.0)).max(0.0).min((k.f(11)-1.0).max(0.0));
            let shots=1.0+floor(late/(cd as f64+1.0));
            *k.p::<i32>(28).add(q)=shots as i32;
            *k.p::<i32>(29).add(q)=(shots*(cd as f64+1.0)-1.0-late) as i32;
            *k.p::<i32>(30).add(q)=elvl;
            *k.p::<f64>(25).add(q)=damage*shots;
            *k.p::<f64>(26).add(q)=if shots>1.0&&blast!=0.0&&!blast.is_nan(){blast*shots}else{blast};
            *k.p::<f64>(27).add(q)=radius;
            *valid.add(q)=1;
        }
        let half=f32x4_splat(tile*0.5);let scale=f32x4_splat(tile);
        // Output allocations include a four-query tail for safe SIMD stores.
        v128_store(qx.add(first as usize) as *mut v128,f32x4_add(f32x4_mul(f32x4_convert_i32x4(v128_load(xs.as_ptr() as *const v128)),scale),half));
        v128_store(qy.add(first as usize) as *mut v128,f32x4_add(f32x4_mul(f32x4_convert_i32x4(v128_load(ys.as_ptr() as *const v128)),scale),half));
        for &(q,x,y) in cpos.iter(){if q>=0{*qx.add(q as usize)=x;*qy.add(q as usize)=y;}}
    }
    *ext.add(chunk as usize)=extended;
}

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
        for ai in *qoff.add(q*2)..*qoff.add(q*2+1){
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
        for ai in *qoff.add(q*2)..*qoff.add(q*2+1) {
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
                    // (No owner given: none, as a cell without one; tower.js resolves a floor item's from its cell.)
                    if (p==1||p==3)&&o==0x7ff9 {continue;}
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

/// Broad phase over contiguous query rectangles. Unit blocks are conservative
/// exactly as the JS query; structure blocks use eight aligned tile bytes per
/// row, masked to the rectangle. No object access or area-list allocation.
#[no_mangle]
pub unsafe extern "C" fn k_tower_coarse(a:u32,chunk:i32) {
    let k=K::new(waddr(a) as *const i32);
    let boxes=k.p::<i32>(0);let own=k.p::<i32>(1);let live=k.p::<u32>(2);
    let units=k.p::<i32>(3);let blocks=k.p::<i32>(4);let codes=k.p::<i8>(5);
    let pc=k.i(2);let bw=k.i(3);let w=k.i(4);let bs=k.i(5);let mut active=0;let mut prepared=0;let mut fallback=0;let mut extend=0;
    for q in chunk*k.i(1)..((chunk+1)*k.i(1)).min(k.i(0)) {
        let q=q as usize;*live.add(q)=0;let b=boxes.add(q*4);
        let (x0,y0,x1,y1)=(*b,*b.add(1),*b.add(2),*b.add(3));
        if x1<0 {if k.i(6)!=0 {let v=*k.p::<i32>(8).add(q);if v<0 {fallback+=1;}if v== -1 {extend+=1;}}continue;}
        prepared+=1;
        let owner=*own.add(q);
        if owner<0||owner>=pc||bs!=8 { *live.add(q)=1;active+=1;continue; }
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
        if hit {active+=1;}else if k.i(6)!=0 {let off=k.p::<i32>(6);*off.add(q*2+1)=*off.add(q*2);}
    }
    if k.i(6)!=0 {let count=k.p::<i32>(7).add(chunk as usize*16);*count=active;*count.add(1)=prepared;*count.add(2)=fallback;*count.add(3)=extend;}
}

/// The towers due this step (towersTick; no JS wheel): every row of the
/// tower table (_stT its tile, P[0] rows) standing at its tile (st.rrow),
/// a tower (0x22), built, with energy, past its cooldown (now > ceil(st.tim)),
/// of a kind that shoots (sta.kind >= 0; an unknown type id is listed: the
/// prepare marks it for the JavaScript). Listed in row order: tac.input its
/// tile, tac.row its row; cnt[0] how many. Nothing after depends on the order.
#[no_mangle]
pub unsafe extern "C" fn k_tower_due(a:u32,_chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let stt=k.p::<i32>(0);let code=k.p::<u8>(1);let uc=k.p::<u8>(2);let val=k.p::<f64>(3);let tim=k.p::<f64>(4);let brain=k.p::<u32>(5);
    let kinds=k.p::<i32>(6);let rrow=k.p::<i32>(7);let out=k.p::<i32>(8);let orow=k.p::<i32>(9);let cnt=k.p::<i32>(10);
    let rows=k.i(0).max(0) as usize;let now=k.f(1);let nt=k.i(2);let tiles=k.i(3);
    let mut n=0usize;
    for r in 0..rows{
        let t=*stt.add(r);
        if t<0||t>=tiles{continue;}
        let tu=t as usize;
        if *code.add(tu)!=0x22||*rrow.add(tu)!=r as i32||*uc.add(tu)!=0||!(*val.add(tu)>0.0)||now<=ceil(*tim.add(tu)){continue;}
        let ty=(*brain.add(tu)&65535) as i32-1;
        if ty>=0&&ty<nt&&*kinds.add(ty as usize)<0{continue;}
        *out.add(n)=t;*orow.add(n)=r as i32;n+=1;
    }
    *cnt=n as i32;
}

/// atan2 for the turret's look (presentation only: never hashed, not
/// required to agree between peers): an octant-reduced polynomial, ~1e-4 rad.
#[inline]
fn look_atan2(y:f64,x:f64)->f32{
    let (ax,ay)=(if x<0.0{-x}else{x},if y<0.0{-y}else{y});
    if ax==0.0&&ay==0.0{return 0.0;}
    let (mn,mx)=if ax<ay{(ax,ay)}else{(ay,ax)};
    let t=mn/mx;let s=t*t;
    let mut r=((-0.0464964749*s+0.15931422)*s-0.327622764)*s*t+t;
    if ay>ax{r=1.57079637-r;}
    if x<0.0{r=3.14159274-r;}
    if y<0.0{r=-r;}
    r as f32
}

/// A preferred target's unit by its id (main.js unitIdIndex: ids ascending,
/// their slots; -2 a hole): its slot, -1 none.
#[inline]
unsafe fn id_slot(ids:*const i32,slots:*const i32,n:usize,id:i32)->i32{
    let (mut lo,mut hi)=(0usize,n);
    while lo<hi{let m=(lo+hi)/2;let v=*ids.add(m);if v<id{lo=m+1;}else{hi=m;}}
    if lo<n&&*ids.add(lo)==id{let s=*slots.add(lo);if s>=0{return s;}}
    -1
}

/// The due towers' turns (towersTick), one job on the simulation thread,
/// from the prepare kernels' answers (tac.valid 1; the others do not act).
/// A preferred target first (tac.pref; the tower row's tc.ptK kind: 1 a
/// unit by id tc.ptV, 2 tower, 3 barrack, 4 spawner, 5 floor item at tile
/// tc.ptV; as data_dynamic.js getTowerPreferredTargetInRange): gone, its
/// owner's, or not visible to the tower's owner (vis.cover of the area at
/// its tile): the preference cleared (tc.ptK 0, descriptor bit 24); out of
/// the tower's reach (its area not among tac.areas of the query): the usual
/// target. Then idle (tac.idle > 0): its cooldown that long; else its shot
/// at the unit (tac.out: its slot) or structure (tac.sout: its tile, at the
/// tile's centre; a floor item there its floor target) written into the
/// projectile pool as projectile.js projectileFire does (the type's status
/// duration and dps from its owner's stats: sta.sd / sta.sp by stat
/// (owner, type, effective level); id (now & 1023) << 22 | tile: one shot a
/// tower a step, unique among the shots in flight), its cooldown
/// (tac.shotCd: Tower._cdUntil and st.tim), its angle (Tower.angle). The
/// shots' tiles and angles (cnt[1]: the presentation's turrets), the first
/// P[8] shots' indexes and targets (looks, ltgt: unit slot, tile; cnt[2]);
/// cnt[3] shots not made (pool full).
/// P: [0] towers, [1] now, [2] grid width, [3] tile, [4] the shots' range,
/// [5] blast radius scale (area units to pixels), [6] types, [7] levels,
/// [8] looks, [9] ids in the id index, [10] the cover's stride, [11]
/// players covered.
#[no_mangle]
pub unsafe extern "C" fn k_tower_fire(a:u32,_chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let (input,row,valid,sout,uout,idle,qx,qy,qo,qt)=(k.p::<i32>(0),k.p::<i32>(1),k.p::<i32>(2),k.p::<i32>(4),k.p::<i32>(5),k.p::<i32>(6),
        k.p::<f32>(7),k.p::<f32>(8),k.p::<i32>(9),k.p::<i32>(10));
    let (shots,shot_cd,level,damage,blast,radius)=(k.p::<i32>(11),k.p::<i32>(12),k.p::<i32>(13),k.p::<f64>(14),k.p::<f64>(15),k.p::<f64>(16));
    let (ux,uy,code,tim,cdu,ang,stt_tt,brain,ssd,ssp)=(k.p::<i32>(17),k.p::<i32>(18),k.p::<u8>(20),k.p::<f64>(21),k.p::<f64>(22),k.p::<f32>(23),
        k.p::<i32>(24),k.p::<u32>(25),k.p::<i32>(26),k.p::<f32>(27));
    let (live,free,hdr)=(k.p::<i32>(28),k.p::<i32>(29),k.p::<i32>(30));
    let (px,py,pvx,pvy,psx,psy,ppx,ppy,paim,plife,prange,pdmg)=(k.p::<f64>(31),k.p::<f64>(32),k.p::<f64>(33),k.p::<f64>(34),k.p::<f64>(35),k.p::<f64>(36),
        k.p::<f32>(37),k.p::<f32>(38),k.p::<f32>(39),k.p::<i32>(40),k.p::<f64>(41),k.p::<f64>(42));
    let (plvl,pown,pty,ptt,pshots,pbd,pbr,pft,psd,psp,pid,pev,parg)=(k.p::<i32>(43),k.p::<i8>(44),k.p::<u8>(45),k.p::<i16>(46),k.p::<i32>(47),k.p::<f64>(48),
        k.p::<f64>(49),k.p::<i32>(50),k.p::<i32>(51),k.p::<f32>(52),k.p::<i32>(53),k.p::<i32>(54),k.p::<i32>(55));
    let (ltgt,ftile,fang,looks,cnt)=(k.p::<i32>(56),k.p::<i32>(57),k.p::<f32>(58),k.p::<i32>(59),k.p::<i32>(60));
    let (pref,ptk,ptv,uids,uslots,udead,uown,sown,sval,cover,agrid,qoff,areas)=(k.p::<i32>(61),k.p::<i8>(62),k.p::<i32>(63),k.p::<i32>(64),k.p::<i32>(65),k.p::<u8>(66),
        k.p::<i8>(67),k.p::<i32>(68),k.p::<f64>(69),k.p::<i32>(70),k.p::<i32>(71),k.p::<i32>(72),k.p::<i32>(73));
    let n=k.i(0).max(0) as usize;let now=k.f(1);let w=k.i(2).max(1);let tile=k.f(3);let range=k.f(4);let rscale=k.f(5);
    let nt=k.i(6);let nl=k.i(7);let nlook=k.i(8).max(0) as usize;let nid=k.i(9).max(0) as usize;let cstride=k.i(10).max(0) as usize;let ncov=k.i(11);
    let (mut nf,mut nk,mut drop)=(0usize,0usize,0i32);
    let mut nlive=*hdr as usize;let mut nfree=*hdr.add(1) as usize;let live0=nlive as i32;
    let tick=(now as i64 & 1023) as i32;
    for q in 0..n{
        if *valid.add(q)!=1{continue;}
        let (t,r)=(*input.add(q),*row.add(q) as usize);
        let own=*qo.add(q);
        // Its target: (unit slot or -1, tile or -1, x, y).
        let mut pick:(i32,i32,f64,f64)=(-1,-1,0.0,0.0);
        if *pref.add(q)!=0{
            let kind=*ptk.add(r) as i32;let v=*ptv.add(r);
            // (slot, tile, x, y, the tile it stands on)
            let mut found:(i32,i32,f64,f64,i32)=(-1,-1,0.0,0.0,-1);
            if kind==1{
                let s=if uids.is_null(){-1}else{id_slot(uids,uslots,nid,v)};
                if s>=0&&*udead.add(s as usize)==0&&*uown.add(s as usize) as i32!=own{
                    let x=*ux.add(s as usize) as f64*0.125;let y=*uy.add(s as usize) as f64*0.125;
                    let gx=floor(x/tile) as i32;let gy=floor(y/tile) as i32;
                    if gx>=0&&gx<w&&gy>=0&&gy*w+gx<k.i(12){found=(s,-1,x,y,gy*w+gx);}
                }
            }else if kind>=2&&kind<=5&&v>=0&&v<k.i(12){
                let want=[0x22u8,0x33,0x44,0x55][(kind-2) as usize];let tu=v as usize;
                if *code.add(tu)==want&&*sval.add(tu)>0.0&&*sown.add(tu)!=own{let gx=v%w;let gy=v/w;found=(-1,v,gx as f64*tile+tile*0.5,gy as f64*tile+tile*0.5,v);}
            }
            let at=found.4;
            let ar=if at>=0{*agrid.add(at as usize)}else{-1};
            let seen=ar>=0&&own>=0&&own<ncov&&!cover.is_null()&&*cover.add(own as usize*cstride+ar as usize)>0;
            if !seen{*ptk.add(r)=0;*brain.add(t as usize)&=!(1u32<<24);}
            else{
                let mut inr=false;
                for i in *qoff.add(q*2)..*qoff.add(q*2+1){if *areas.add(i as usize)==ar{inr=true;break;}}
                if inr{pick=(found.0,found.1,found.2,found.3);}
            }
        }
        if pick.0<0&&pick.1<0{
            let id=*idle.add(q);
            if id>0{let until=now+id as f64;*cdu.add(r)=until;*tim.add(t as usize)=until;continue;}
            let s_out=*sout.add(q);let u_out=*uout.add(q);
            if u_out>=0{pick=(u_out,-1,*ux.add(u_out as usize) as f64*0.125,*uy.add(u_out as usize) as f64*0.125);}
            else if s_out>=0{let gx=s_out%w;let gy=s_out/w;pick=(-1,s_out,gx as f64*tile+tile*0.5,gy as f64*tile+tile*0.5);}
            else{continue;}
        }
        let (tx,ty)=(pick.2,pick.3);
        let ft=if pick.1>=0&&*code.add(pick.1 as usize)==0x55{pick.1}else{-1};
        let x=*qx.add(q) as f64;let y=*qy.add(q) as f64;let dx=tx-x;let dy=ty-y;
        let until=now+*shot_cd.add(q) as f64;*cdu.add(r)=until;*tim.add(t as usize)=until;
        let a=look_atan2(dy,dx);*ang.add(r)=a;
        *ftile.add(nf)=t;*fang.add(nf)=a;nf+=1;
        if nk<nlook{*looks.add(nk)=q as i32;*ltgt.add(2*nk)=pick.0;*ltgt.add(2*nk+1)=pick.1;nk+=1;}
        if nfree==0{drop+=1;continue;}
        nfree-=1;let s=*free.add(nfree) as usize;*live.add(nlive)=s as i32;nlive+=1;
        let len=sqrt(dx*dx+dy*dy);
        *px.add(s)=x;*py.add(s)=y;*psx.add(s)=x;*psy.add(s)=y;*ppx.add(s)=x as f32;*ppy.add(s)=y as f32;*paim.add(s)=len as f32;
        if len>0.0{*pvx.add(s)=dx/len*8.0;*pvy.add(s)=dy/len*8.0;}else{*pvx.add(s)=8.0;*pvy.add(s)=0.0;}
        *plife.add(s)=100;*prange.add(s)=range;*pdmg.add(s)=*damage.add(q);
        let lvl=*level.add(q);*plvl.add(s)=lvl;*pown.add(s)=own as i8;*pty.add(s)=*qt.add(q) as u8;
        let sh=*shots.add(q);*pshots.add(s)=if sh>1{sh}else{1};
        let bd=*blast.add(q);let br=*radius.add(q);
        let blast_on=bd>0.0&&br>0.0;*pbd.add(s)=if blast_on{bd}else{0.0};*pbr.add(s)=if blast_on{br*rscale}else{0.0};
        *pft.add(s)=ft;
        let typ=(*brain.add(t as usize)&65535) as i32-1;
        *ptt.add(s)=if typ>=0&&typ<nt{*stt_tt.add(typ as usize) as i16}else{-1};
        let lv=lvl.max(1).min(nl-1);
        if typ>=0&&typ<nt{let stat=(((own+1)*nt+typ)*nl+lv) as usize;*psd.add(s)=*ssd.add(stat);*psp.add(s)=*ssp.add(stat);}else{*psd.add(s)=0;*psp.add(s)=-1.0;}
        *pid.add(s)=(tick<<22)|t;*pev.add(s)=0;*parg.add(s)=-1;
    }
    *hdr.add(2)=(*hdr.add(2)).wrapping_add(nlive as i32-live0);
    *hdr=nlive as i32;*hdr.add(1)=nfree as i32;*hdr.add(3)+=drop;
    *cnt=0;*cnt.add(1)=nf as i32;*cnt.add(2)=nk as i32;*cnt.add(3)=drop;
}
