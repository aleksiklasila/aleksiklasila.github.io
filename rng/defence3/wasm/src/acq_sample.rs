//! Opt-in bounded acquisition experiment. Snapshot candidates packed by area;
//! each query examines at most P[24] entries, independent of population.
use super::*;
use super::k::K;
const NEAR:usize=64;

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
    for e in 0..n {if let Some((ar,owner,_,_,_,_))=candidate(&k,e){if ar<na&&owner<players {*counts.add(ar*players+owner)+=1;}}}
    let mut total=0;for key in 0..keys {*off.add(key)=total;*cursor.add(key)=total;total+=*counts.add(key);}*off.add(keys)=total;
    let ax=k.p::<f32>(28);let ay=k.p::<f32>(29);let ao=k.p::<i32>(30);let aid=k.p::<i32>(31);let slots=k.p::<i32>(32);
    for e in 0..n {if let Some((ar,owner,x,y,id,slot))=candidate(&k,e){if ar>=na||owner>=players {continue;}
        let cur=cursor.add(ar*players+owner);let j=*cur as usize;*cur+=1;
        *ax.add(j)=x;*ay.add(j)=y;*ao.add(j)=owner as i32;*aid.add(j)=id;*slots.add(j)=slot;
    }
    }
    if k.i(28)==1 {
        build_area_answers(&k,na,players,off);
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

// Multi-source BFS: for each viewer, the nearest graph distance to a
// nonempty visible enemy area. Population affects the CSR build, not queries.
// Structure answers use the same area rule, separately for each priority.
#[inline(always)]
unsafe fn spread_answers(na:usize,answers:*mut i32,dist:*mut i32,queue:*mut i32,go:*const i32,gn:*const i32){
    let mut head=0;let mut tail=0;
    for ar in 0..na {if *answers.add(ar)>=0 {*dist.add(ar)=0;*queue.add(tail)=ar as i32;tail+=1;}else{*dist.add(ar)=-1;}}
    while head<tail {
        let u=*queue.add(head) as usize;head+=1;let d=*dist.add(u)+1;
        for j in *go.add(u)..*go.add(u+1) {
            let v=*gn.add(j as usize) as usize;if v>=na||*dist.add(v)>=0 {continue;}
            *dist.add(v)=d;*answers.add(v)=*answers.add(u);*queue.add(tail)=v as i32;tail+=1;
        }
    }
}

unsafe fn build_area_answers(k:&K,na:usize,players:usize,off:*const i32){
    let answers=k.p::<i32>(40);let dist=k.p::<i32>(41);let queue=k.p::<i32>(42);
    let structures=k.p::<i32>(43);let struct_dist=k.p::<i32>(44);
    let go=k.p::<i32>(38);let gn=k.p::<i32>(39);let cov=k.p::<u8>(14);
    for viewer in 0..players {let base=viewer*na;
        for ar in 0..na {
            let mut enemy=false;
            if *cov.add(base+ar)!=0 {for foe in 0..players {let key=ar*players+foe;if foe!=viewer&&*off.add(key+1)>*off.add(key){enemy=true;break;}}}
            *answers.add(base+ar)=if enemy {ar as i32}else{-1};
        }
        spread_answers(na,answers.add(base),dist.add(base),queue,go,gn);
    }
    for i in 0..na*players*4 {*structures.add(i)=-1;}
    let ag=k.p::<i32>(13);let cls=k.p::<i8>(0);let owners=k.p::<i8>(1);
    for tile in 0..(k.i(15).max(0) as usize*k.i(16).max(0) as usize) {
        let class=*cls.add(tile);let class=if class==5 {1}else{class};
        if class<1||class>4 {continue;}let owner=*owners.add(tile);if owner==-1 {continue;}
        let ar=*ag.add(tile);if ar<0||ar as usize>=na {continue;}let ar=ar as usize;
        for viewer in 0..players {
            if owner as i32==viewer as i32||*cov.add(viewer*na+ar)==0 {continue;}
            let i=(viewer*4+class as usize-1)*na+ar;
            if *structures.add(i)<0 {*structures.add(i)=tile as i32;}
        }
    }
    for group in 0..players*4 {spread_answers(na,structures.add(group*na),struct_dist.add(group*na),queue,go,gn);}
}

unsafe fn area_answer(k:&K,s:usize,x:f32,y:f32,owner:usize,r:f32){
    let na=k.i(20).max(0) as usize;let players=k.i(7).max(1) as usize;
    let tile=k.f(5);let gw=k.i(15);let gh=k.i(16);let fx=x as f64/tile;let fy=y as f64/tile;
    let gx=floor(fx) as i32;let gy=floor(fy) as i32;let rx=fx-gx as f64;let ry=fy-gy as f64;
    let x0=gx-if rx<0.3 {1}else{0};let x1=gx+if rx>=0.7 {1}else{0};
    let y0=gy-if ry<0.3 {1}else{0};let y1=gy+if ry>=0.7 {1}else{0};
    let reach=ceil(r as f64/(tile*k.f(29).max(1.0))) as i32;
    let ag=k.p::<i32>(13);let nearest=k.p::<i32>(40);let dist=k.p::<i32>(41);
    let structures=k.p::<i32>(43);let struct_dist=k.p::<i32>(44);
    let mut target_area=-1;let mut best_steps=i32::MAX;
    let mut structure=[-1i32;4];let mut structure_steps=[i32::MAX;4];
    for yy in y0..=y1 {for xx in x0..=x1 {
        if xx<0||yy<0||xx>=gw||yy>=gh {continue;}let ar=*ag.add((yy*gw+xx) as usize);if ar<0||ar as usize>=na {continue;}
        let ar=ar as usize;let index=owner*na+ar;let d=*dist.add(index);let target=*nearest.add(index);
        if d>=0&&d<=reach&&(d<best_steps||(d==best_steps&&target<target_area)){target_area=target;best_steps=d;}
        for class in 0..4 {let index=(owner*4+class)*na+ar;let d=*struct_dist.add(index);let target=*structures.add(index);
            if d>=0&&d<=reach&&(d<structure_steps[class]||(d==structure_steps[class]&&target<structure[class])){structure[class]=target;structure_steps[class]=d;}
        }
    }}
    let command=*k.p::<u8>(8).add(s) as i32;
    if command==k.i(8)||command==k.i(9) {for class in 0..4 {if structure[class]>=0 {*k.p::<i32>(3).add(s)=structure[class];break;}}}
    if target_area<0 {return;}
    let ar=target_area as usize;let off=k.p::<i32>(27);let slots=k.p::<i32>(32);let ids=k.p::<i32>(31);
    let ax=k.p::<f32>(28);let ay=k.p::<f32>(29);
    let seed=mix((*k.p::<i32>(10).add(s) as u32)^(k.i(25) as u32).wrapping_mul(0x9e3779b9));
    for j in 0..players {let foe=seed.wrapping_add(j as u32) as usize%players;if foe==owner {continue;}
        let key=ar*players+foe;let lo=*off.add(key) as usize;let hi=*off.add(key+1) as usize;let count=hi-lo;if count==0 {continue;}
        let e=lo+if count>4 {mix(seed^ar as u32) as usize%(count-3)}else{0};
        let mut winner=e;let mut best=f32::INFINITY;
        if count>=4 {
            let dx=f32x4_sub(v128_load(ax.add(e) as *const v128),f32x4_splat(x));
            let dy=f32x4_sub(v128_load(ay.add(e) as *const v128),f32x4_splat(y));
            let ds:[f32;4]=core::mem::transmute(f32x4_add(f32x4_mul(dx,dx),f32x4_mul(dy,dy)));
            for lane in 0..4 {let d=*ds.get_unchecked(lane);if d<best||(d==best&&*ids.add(e+lane)<*ids.add(winner)){best=d;winner=e+lane;}}
        }else{
            for lane in 0..count {let dx=*ax.add(e+lane)-x;let dy=*ay.add(e+lane)-y;let d=dx*dx+dy*dy;if d<best||(d==best&&*ids.add(e+lane)<*ids.add(winner)){best=d;winner=e+lane;}}
        }
        // Distance ranks a fixed batch only. It cannot reject an area-valid unit.
        *k.p::<i32>(11).add(s)=*slots.add(winner);*k.p::<i32>(12).add(s)=*ids.add(winner);return;
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
    let off=k.p::<i32>(27);let ax=k.p::<f32>(28);let ay=k.p::<f32>(29);let ao=k.p::<i32>(30);let aid=k.p::<i32>(31);let slots=k.p::<i32>(32);
    let near=k.p::<i32>(33);let near_n=k.p::<i32>(34);
    let gw=k.i(15);let gh=k.i(16);let tile=k.f(5);let budget=k.i(24).clamp(4,256) as usize;
    let batch_budget=budget/4;let epoch=k.i(25) as u32;let players=k.i(7).max(1) as usize;
    for s in start..end {
        let fl=*flags.add(s);let command=*cmd.add(s) as i32;
        if fl&7!=0 || (command!=k.i(8)&&command!=k.i(9)&&command!=k.i(18)&&fl&16==0) {continue;}
        let owner=*own.add(s) as i32;let r=*ranges.add(s);
        if owner<0||owner>=k.i(7)||!(r>0.0){continue;}
        *out.add(s)=-1;*tid.add(s)=0;*sout.add(s)=-1;
        let x=*xs.add(s);let y=*ys.add(s);
        if k.i(28)==1 {area_answer(&k,s,x,y,owner as usize,r);continue;}
        // Structure selection is still exact, to isolate the unit-target tradeoff.
        if command==k.i(8)||command==k.i(9) {
            let bc=k.i(11);let br=k.i(12);let stride=bc+1;let plane=stride*(br+1);
            *sout.add(s)=acq_structure(k.p::<i8>(0),k.p::<i8>(1),k.p::<i32>(2),ag,cov,na*players,owner*na as i32,owner,
                x as f64,y as f64,r as f64,tile,gw,gh,k.i(10),bc,br,stride,plane);
        }
        let gx=floor(x as f64/tile) as i32;let gy=floor(y as f64/tile) as i32;
        if gx<0||gy<0||gx>=gw||gy>=gh {continue;}
        let ar=*ag.add((gy*gw+gx) as usize);if ar<0||(ar as usize)>=na {continue;}
        let ar=ar as usize;let nareas=(*near_n.add(ar) as usize).min(NEAR);
        let ox=f32x4_splat(x);let oy=f32x4_splat(y);let owner4=i32x4_splat(owner);
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
            let take=count.min(4);
            if take==4 {
                let dx=f32x4_sub(v128_load(ax.add(e) as *const v128),ox);let dy=f32x4_sub(v128_load(ay.add(e) as *const v128),oy);
                let d2=f32x4_add(f32x4_mul(dx,dx),f32x4_mul(dy,dy));
                let mask=v128_and(f32x4_le(d2,f32x4_splat(b2)),i32x4_ne(v128_load(ao.add(e) as *const v128),owner4));
                let mut bits=i32x4_bitmask(mask);let distances:[f32;4]=core::mem::transmute(d2);
                while bits!=0 {let l=bits.trailing_zeros() as usize;bits&=bits-1;let d=*distances.get_unchecked(l);let id=*aid.add(e+l);
                    if d<=b2&&(best<0||d<b2||id<best_id){best=*slots.add(e+l);best_id=id;b2=d;}
                }
            }else{
                for l in 0..take {if *ao.add(e+l)==owner {continue;}let dx=*ax.add(e+l)-x;let dy=*ay.add(e+l)-y;let d=dx*dx+dy*dy;let id=*aid.add(e+l);
                    if d<=b2&&(best<0||d<b2||id<best_id){best=*slots.add(e+l);best_id=id;b2=d;}
                }
            }
            }
        }
        *out.add(s)=best;*tid.add(s)=if best>=0 {best_id}else{0};
    }
}
