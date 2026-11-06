//! Tower unit acquisition. A per-tick spatial-entry snapshot in SoA form,
//! shared by every due tower: contiguous coordinates and packed type/status
//! flags allow four candidates to be filtered together, with f64x2 distance
//! arithmetic matching JavaScript. Reduction retains the original visiting
//! order, including exact-distance ties and primary/affected/immune priority.
use super::*;
use super::k::K;

/// One mass stationary brain input pass. Descriptors are published on
/// changes; stats are shared by owner/type/level. A query is its area and
/// reach (tac.off: area, range + 1; 0 none), answered by the area index
/// (arq.rs) in the scan; its box (tac.boxes) the tiles that reach can lie
/// in (Arq::reach_box), for the broad phase. Four adjacent query origins
/// are written with SIMD; there is no JS stat/area work per turret. A tower
/// with custom stats or position (descriptor bit 25) reads its row's (tc.*,
/// by st.rrow: tower.js towerCustomWrite). A preferred target (bit 24):
/// tac.pref 1 (k_tower_fire looks at it first).
#[no_mangle]
pub unsafe extern "C" fn k_tower_prepare(a:u32,chunk:i32) {
    let arg=waddr(a) as *const i32;let k=K::new(arg);
    let input=k.p::<i32>(0);let code=k.p::<u8>(1);let owner=k.p::<i32>(2);let uc=k.p::<u8>(3);let energy=k.p::<f64>(4);let timer=k.p::<f64>(5);let brain=k.p::<u32>(6);
    let ranges=k.p::<i32>(7);let cds=k.p::<i32>(8);let kinds=k.p::<i32>(9);let grid=k.p::<i32>(10);let arq=super::arq::Arq::new(k.p::<i32>(11),arg);
    let qx=k.p::<f32>(13);let qy=k.p::<f32>(14);let qo=k.p::<i32>(15);let qt=k.p::<i32>(16);let qb=k.p::<i32>(17);let qtile=k.p::<i32>(18);let qoff=k.p::<i32>(19);let qbox=k.p::<i32>(20);let valid=k.p::<i32>(21);
    let rrow=k.p::<i32>(32);
    let (cx,cy,crange,ccd,cdmg,cblast,crad,clvl)=(k.p::<f32>(33),k.p::<f32>(34),k.p::<i32>(35),k.p::<i32>(36),k.p::<f32>(37),k.p::<f32>(38),k.p::<f32>(39),k.p::<i32>(40));
    let pref=k.p::<i32>(41);let ext=k.p::<i32>(42);
    let w=k.i(2).max(1);let hgt=k.i(9)/w;let nt=k.i(4);
    // (The movement's per-area boxes, exact for reaches below P[3] steps once made: unit.js _simMoveAreaBoxes.)
    let (abox,aok,bsteps)=(k.p::<i32>(12),k.p::<u8>(31),k.i(3));let nl=k.i(5);let np=k.i(6);let now=k.f(7);let tile=k.f(8) as f32;
    let start=chunk*k.i(1);let end=((chunk+1)*k.i(1)).min(k.i(0));
    *ext.add(chunk as usize)=0;
    let arq=match arq{Some(x)=>x,None=>{for q in start..end{*valid.add(q as usize)=0;}return;}};
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
            range=range.min(63);
            *qoff.add(q*2)=area;*qoff.add(q*2+1)=range+1;
            let at=(area*bsteps+range) as usize;
            let bx=if range<bsteps&&!abox.is_null()&&!aok.is_null()&&*aok.add(at)!=0 {let b=abox.add(at*4);if *b>*b.add(2){[0,0,-1,-1]}else{[*b,*b.add(1),*b.add(2),*b.add(3)]}}
                else {arq.reach_box(area,range,w,hgt)};
            v128_store(qbox.add(q*4) as *mut v128,v128_load(bx.as_ptr() as *const v128));
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
}

/// Towers as stationary units of the acquisition tier (unit.js _acqPost):
/// at the post (phase 2) the tick snapshots each tower row
/// (k_tower_acq_snap, a parallel job over the rows), the tier's background
/// chain answers them after its area answers (k_tower_acq), the commit
/// (phase 0) copies the answers to the rows (tower.js), and k_tower_fire
/// shoots at them after an O(1) check. No search on the tick.
/// k_tower_acq_snap: [0] the rows' tiles (Tower _stT) [1] st.code [2] st.uc
/// [3] st.val [4] st.brain [5] st.rrow [6] st.own [7] sta.kind [8] sta.range
/// [9] tc.range [10] the tiles' areas; out [11] area (-1: not looking)
/// [12] owner [13] kind [14] reach (area steps) [15] tile.
/// P: [0] rows, [1] per job, [2] types, [3] levels, [4] players, [5] tiles.
#[no_mangle]
pub unsafe extern "C" fn k_tower_acq_snap(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let (stt,code,uc,val,brain,rrow,own)=(k.p::<i32>(0),k.p::<u8>(1),k.p::<u8>(2),k.p::<f64>(3),k.p::<u32>(4),k.p::<i32>(5),k.p::<i32>(6));
    let (kinds,ranges,crange,agrid)=(k.p::<i32>(7),k.p::<i32>(8),k.p::<i32>(9),k.p::<i32>(10));
    let (oa,oo,ok,or,ot)=(k.p::<i32>(11),k.p::<i32>(12),k.p::<i32>(13),k.p::<i32>(14),k.p::<i32>(15));
    let (nt,nl,np,tiles)=(k.i(2),k.i(3),k.i(4),k.i(5));
    let start=chunk*k.i(1);let end=(start+k.i(1)).min(k.i(0));
    for r in start..end{
        let r=r as usize;*oa.add(r)=-1;*ot.add(r)=-1;
        let t=*stt.add(r);
        if t<0||t>=tiles{continue;}
        let tu=t as usize;
        if *code.add(tu)!=0x22||*rrow.add(tu)!=r as i32||*uc.add(tu)!=0||!(*val.add(tu)>0.0){continue;}
        let d=*brain.add(tu);let ty=(d&65535) as i32-1;let level=((d>>16)&255) as i32;let o=*own.add(tu);
        if ty<0||ty>=nt||o<0||o>=np{continue;}
        let kind=*kinds.add(ty as usize);if kind<0{continue;}
        let range=if d&(1<<25)!=0{if crange.is_null(){continue;}*crange.add(r)}
            else{if level<1||level>=nl{continue;}*ranges.add((((o+1)*nt+ty)*nl+level) as usize)};
        if range<0{continue;}
        let ar=*agrid.add(tu);if ar<0{continue;}
        *oa.add(r)=ar;*oo.add(r)=o;*ok.add(r)=kind;*or.add(r)=range.min(63);*ot.add(r)=t;
    }
}
/// k_tower_acq (a stage of the tier's chain, after k_acq_area_answers):
/// each snapshot row looking (area >= 0) takes, as a unit's area_answer,
/// its owner's nearest area holding a visible enemy unit (acq.saNearest /
/// saDistance at its area) when within its reach, and the best of a batch
/// of four of that area's enemy units (a team's bucket at a time, from a
/// seeded offset): not turret-immune; one its shot does not affect yet
/// (status not on it, not resisting its kind) before one it does, before a
/// resisting one; then the nearest; ties by id (the snapshot's: its type
/// acq.upt and tac.flags by type, its status record acq.stix and the
/// records' copies acq.sb0-5 (burning, wet, poisoned, frozen, sandy,
/// watched), its watch team acq.wt). None: the nearest visible
/// enemy structure within reach by class (acq.saStructure, classes in
/// order). Out: [16] slot, [17] unit id, [18] structure tile (-1 none).
/// Args [0..4] k_tower_acq_snap's, [5] acq.saOff [6] saX [7] saY [8] saSlot
/// [9] acq.id [10] acq.upt [11] acq.wt [12] saNearest [13] saDistance
/// [14] saStructure [15] saStructureDistance, [19] tac.flags [20] acq.stix
/// [21..26] acq.sb0-5. P: [0] rows, [1] per job, [2] areas, [3] players,
/// [4] grid width, [5] tile, [6] the post's tick, [7] unit types, [8] an
/// unknown type's flags, [9] status records copied.
#[no_mangle]
pub unsafe extern "C" fn k_tower_acq(a:u32,chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let (qa,qo,qk,qr,qt)=(k.p::<i32>(0),k.p::<i32>(1),k.p::<i32>(2),k.p::<i32>(3),k.p::<i32>(4));
    let (off,ax,ay,slots,ids,upt,wt)=(k.p::<i32>(5),k.p::<f32>(6),k.p::<f32>(7),k.p::<i32>(8),k.p::<i32>(9),k.p::<i16>(10),k.p::<i8>(11));
    let (tfl,stix)=(k.p::<u8>(19),k.p::<i32>(20));let sb=[k.p::<u16>(21),k.p::<u16>(22),k.p::<u16>(23),k.p::<u16>(24),k.p::<u16>(25),k.p::<u16>(26)];
    let (nt,unk,nrec)=(k.i(7),k.i(8) as u16,k.i(9).max(0) as usize);
    // (A unit's type flags and statuses, as the old pack's meta bits 0-10.)
    let meta=|su:usize|->u16{
        let ty=*upt.add(su) as i32;let mut m:u16=if ty>=0&&ty<nt{*tfl.add(ty as usize) as u16}else{unk};
        let r=*stix.add(su) as usize;
        if r!=0&&r<nrec{for (b,p) in sb.iter().enumerate(){if !p.is_null()&&*p.add(r)>0{m|=32<<b;}}}
        m
    };
    let (nearest,dist,structs,sdist)=(k.p::<i32>(12),k.p::<i32>(13),k.p::<i32>(14),k.p::<i32>(15));
    let (os,oid,ost)=(k.p::<i32>(16),k.p::<i32>(17),k.p::<i32>(18));
    let na=k.i(2).max(0) as usize;let players=k.i(3).max(1) as usize;let w=k.i(4).max(1);let tile=k.f(5) as f32;let epoch=k.i(6) as u32;
    let start=chunk*k.i(1);let end=(start+k.i(1)).min(k.i(0));
    for r in start..end{
        let r=r as usize;*os.add(r)=-1;*oid.add(r)=0;*ost.add(r)=-1;
        let ar=*qa.add(r);if ar<0||ar as usize>=na||nearest.is_null(){continue;}
        let own=*qo.add(r) as usize;if own>=players{continue;}
        let reach=*qr.add(r);let ty=*qk.add(r);let t=*qt.add(r);
        let ix=own*na+ar as usize;
        let d=*dist.add(ix);let ta=*nearest.add(ix);
        if d>=0&&d<=reach&&ta>=0&&(ta as usize)<na{
            let immune:u16=if ty>=1&&ty<=4{1<<ty}else if ty==5{30}else{0};
            let affected:u16=if ty>=1&&ty<=4{1<<(ty+4)}else if ty==6{512}else if ty==7{1024}else{0};
            let x=((t%w) as f32+0.5)*tile;let y=((t/w) as f32+0.5)*tile;
            let seed=mix((t as u32).wrapping_mul(0x27d4eb2f)^epoch.wrapping_mul(0x9e3779b9));
            let ta=ta as usize;
            let (mut win,mut wcls,mut wd,mut wid)=(-1i32,3i32,f32::INFINITY,0i32);
            for j in 0..players{
                let foe=seed.wrapping_add(j as u32) as usize%players;if foe==own{continue;}
                let key=ta*players+foe;let lo=*off.add(key) as usize;let hi=*off.add(key+1) as usize;let count=hi-lo;
                if count==0{continue;}
                let e=lo+if count>4{mix(seed^ta as u32) as usize%(count-3)}else{0};
                for q in e..e+count.min(4){
                    let s=*slots.add(q);if s<0{continue;}let su=s as usize;
                    let m=meta(su);if m&1!=0{continue;}
                    let cls=if m&immune!=0{2}else if m&affected!=0&&(ty!=7||*wt.add(su) as i32==own as i32){1}else{0};
                    let dx=*ax.add(q)-x;let dy=*ay.add(q)-y;let dd=dx*dx+dy*dy;let id=*ids.add(su);
                    if cls<wcls||(cls==wcls&&(dd<wd||(dd==wd&&id<wid))){win=s;wcls=cls;wd=dd;wid=id;}
                }
                if win>=0{break;}
            }
            if win>=0{*os.add(r)=win;*oid.add(r)=wid;continue;}
        }
        if structs.is_null(){continue;}
        for class in 0..4usize{
            let ix=(own*4+class)*na+ar as usize;let sd=*sdist.add(ix);let st=*structs.add(ix);
            if sd>=0&&sd<=reach&&st>=0{*ost.add(r)=st;break;}
        }
    }
}
#[inline(always)]
fn mix(mut x:u32)->u32{x^=x>>16;x=x.wrapping_mul(0x7feb352d);x^=x>>15;x=x.wrapping_mul(0x846ca68b);x^(x>>16)}

/// The towers due this step (towersTick; no JS wheel): every row of the
/// tower table (_stT its tile, P[0] rows) standing at its tile (st.rrow),
/// a tower (0x22), built, with energy, past its cooldown (now > ceil(st.tim)),
/// of a kind that shoots (sta.kind >= 0; an unknown type id is listed: the
/// prepare marks it for the JavaScript). Listed in row order: tac.input its
/// tile, tac.row its row; cnt[0] how many. Nothing after depends on the order.
/// The rows are found by tw.due [11] (a row's earliest tick to act, i32 by
/// row: tower.js towerDueReset), four rows a compare; only those it lets
/// through read the tile table. A row looked at and not due gets its next
/// tick there: ceil(st.tim) + 1 (its cooldown), i32::MAX (no tower standing
/// at its tile, of a kind that does not shoot, or being built: until its
/// brain word is written again or its construction ends); one without
/// energy stays (looked at each tick).
/// A value below the true one only costs a look: 0 is always safe.
#[no_mangle]
pub unsafe extern "C" fn k_tower_due(a:u32,_chunk:i32){
    let k=K::new(waddr(a) as *const i32);
    let stt=k.p::<i32>(0);let code=k.p::<u8>(1);let uc=k.p::<u8>(2);let val=k.p::<f64>(3);let tim=k.p::<f64>(4);let brain=k.p::<u32>(5);
    let kinds=k.p::<i32>(6);let rrow=k.p::<i32>(7);let out=k.p::<i32>(8);let orow=k.p::<i32>(9);let cnt=k.p::<i32>(10);let due=k.p::<i32>(11);
    let rows=k.i(0).max(0) as usize;let now=k.f(1);let nt=k.i(2);let tiles=k.i(3);
    // (now rounded up: a row with due <= it is looked at, never one fewer.)
    let nowi=if now>=2147483647.0{i32::MAX}else{ceil(now) as i32};
    let mut n=0usize;let mut looks=0i32;
    let mut look=|r:usize,n:&mut usize|{
        looks+=1;let t=*stt.add(r);
        if t<0||t>=tiles{*due.add(r)=i32::MAX;return;}
        let tu=t as usize;
        if *code.add(tu)!=0x22||*rrow.add(tu)!=r as i32{*due.add(r)=i32::MAX;return;}
        let ty=(*brain.add(tu)&65535) as i32-1;
        if ty>=0&&ty<nt&&*kinds.add(ty as usize)<0{*due.add(r)=i32::MAX;return;}
        // (Being built: until its construction ends, data_state.js _stUcSet.)
        if *uc.add(tu)!=0{*due.add(r)=i32::MAX;return;}
        let end=ceil(*tim.add(tu));
        if now<=end{*due.add(r)=if end>=2147483646.0{i32::MAX}else{end as i32+1};return;}
        if !(*val.add(tu)>0.0){return;}
        *out.add(*n)=t;*orow.add(*n)=r as i32;*n+=1;
    };
    let lim=i32x4_splat(nowi);
    let mut r=0usize;
    while r+4<=rows{
        // (Four rows: the lanes with due <= now.)
        let m=i32x4_bitmask(i32x4_le(v128_load(due.add(r) as *const v128),lim)) as u32;
        if m!=0{let mut b=m;while b!=0{let l=b.trailing_zeros() as usize;b&=b-1;look(r+l,&mut n);}}
        r+=4;
    }
    while r<rows{if *due.add(r)<=nowi{look(r,&mut n);}r+=1;}
    drop(look);
    // (cnt[1]: rows looked at, a diagnostic.)
    *cnt=n as i32;*cnt.add(1)=looks;
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
/// target. Then its row's committed answer (the acquisition tier's,
/// k_tower_acq: Tower._aqI a unit by id [6], Tower._aqT a structure's tile
/// [4]) still good (the unit alive, not its owner's, its area within reach;
/// the structure standing, hostile, within reach); none at all: idle its
/// cooldown by its tile's phase; gone since: wait for the next commit
/// (P[13] ticks). Its shot at the unit or structure (at the
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
/// players covered, [12] tiles, [13] ticks until a new commit is used.
#[no_mangle]
pub unsafe extern "C" fn k_tower_fire(a:u32,_chunk:i32){
    let arg=waddr(a) as *const i32;let k=K::new(arg);
    let (input,row,valid,sout,idle,qx,qy,qo,qt)=(k.p::<i32>(0),k.p::<i32>(1),k.p::<i32>(2),k.p::<i32>(4),k.p::<i32>(6),
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
        k.p::<i8>(67),k.p::<i32>(68),k.p::<f64>(69),k.p::<i32>(70),k.p::<i32>(71),k.p::<i32>(72),super::arq::Arq::new(k.p::<i32>(73),arg));
    let mut areas=areas;
    let n=k.i(0).max(0) as usize;let now=k.f(1);let w=k.i(2).max(1);let tile=k.f(3);let range=k.f(4);let rscale=k.f(5);
    let nt=k.i(6);let nl=k.i(7);let nlook=k.i(8).max(0) as usize;let nid=k.i(9).max(0) as usize;let cstride=k.i(10).max(0) as usize;let ncov=k.i(11);
    let (mut nf,mut nk,mut drop)=(0usize,0usize,0i32);
    // (Outcomes, a diagnostic: cnt[4] committed unit shot, [5] structure, [6] none (idle), [7] gone since (retry), [8] preferred.)
    let mut oc=[0i32;5];
    let mut nlive=*hdr as usize;let mut nfree=*hdr.add(1) as usize;let live0=nlive as i32;
    let tick=(now as i64 & 1023) as i32;
    // (Its row's next tick to act in tw.due [74], as k_tower_due writes it.)
    let due=k.p::<i32>(74);
    // (The committed answers' checks: unit ids by slot [19], mv.scls [75],
    // st.uc [76], the cooldown [3]; P[13] ticks to the next commit's use.)
    let (uids_col,scls,suc,base_cd)=(k.p::<i32>(19),k.p::<i8>(75),k.p::<u8>(76),k.p::<i32>(3));
    let retry=k.i(13).max(1)-1;
    let set_due=|r:usize,until:f64|{if !due.is_null(){let e=ceil(until);*due.add(r)=if e>=2147483646.0{i32::MAX}else{e as i32+1};}};
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
                let reach=*qoff.add(q*2+1)-1;
                let inr=match areas.as_mut(){Some(x)=>reach>=0&&x.within(&[*qoff.add(q*2)],&[ar],reach),None=>false};
                if inr{pick=(found.0,found.1,found.2,found.3);oc[4]+=1;}
            }
        }
        if pick.0<0&&pick.1<0{
            // Its row's committed answer (the acquisition tier's, k_tower_acq):
            // the unit still there (alive, the same id, of another owner, its
            // area within the reach), else the structure (standing, hostile,
            // built where it must be, within the reach).
            let reach=*qoff.add(q*2+1)-1;let qa=*qoff.add(q*2);
            let mut inr=|tl:i32|->bool{let ar=*agrid.add(tl as usize);ar>=0&&reach>=0&&match areas.as_mut(){Some(x)=>x.within(&[qa],&[ar],reach),None=>false}};
            // (By id: slots are the peer's own. [6] Tower._aqI, [4] Tower._aqT.)
            let (cid,cst)=(*idle.add(r),*sout.add(r));
            let cs=if cid!=0&&cid!=i32::MIN&&!uids.is_null(){id_slot(uids,uslots,nid,cid)}else{-1};
            // (Nothing found: the commit's 0 and -1; never committed (a new row: unset columns) waits for one.)
            let none=cid==0&&cst==-1;
            if cs>=0{
                let su=cs as usize;
                if *udead.add(su)!=1&&*uids_col.add(su)==cid&&*uown.add(su) as i32!=own{
                    let x=*ux.add(su) as f64*0.125;let y=*uy.add(su) as f64*0.125;
                    let gx=floor(x/tile) as i32;let gy=floor(y/tile) as i32;
                    if gx>=0&&gx<w&&gy>=0&&gy*w+gx<k.i(12)&&inr(gy*w+gx){pick=(cs,-1,x,y);oc[0]+=1;}
                }
            }
            if pick.0<0&&cst>=0&&cst<k.i(12){
                let tu=cst as usize;let c=if scls.is_null(){1}else{*scls.add(tu)};let o=*sown.add(tu);
                let need_built=c==2||c==4;
                if c!=0&&*code.add(tu)!=0&&o!=own&&*sval.add(tu)>0.0&&!(need_built&&(o<0||o==0x7ff9||(!suc.is_null()&&*suc.add(tu)!=0)))&&inr(cst){
                    let gx=cst%w;let gy=cst/w;pick=(-1,cst,gx as f64*tile+tile*0.5,gy as f64*tile+tile*0.5);oc[1]+=1;
                }
            }
            if pick.0<0&&pick.1<0{
                // Nothing then: idle its cooldown, by its tile's phase (as the
                // structure look did); its answer gone since: the next commit's.
                let b=*base_cd.add(q);
                if none{oc[2]+=1;}else{oc[3]+=1;}
                let wait=if none&&b>0{let period=b+1;b+((t%period-(now as i32+period)).rem_euclid(period))}else{retry};
                if wait>0{let until=now+wait as f64;*cdu.add(r)=until;*tim.add(t as usize)=until;set_due(r,until);}
                continue;
            }
        }
        let (tx,ty)=(pick.2,pick.3);
        let ft=if pick.1>=0&&*code.add(pick.1 as usize)==0x55{pick.1}else{-1};
        let x=*qx.add(q) as f64;let y=*qy.add(q) as f64;let dx=tx-x;let dy=ty-y;
        let until=now+*shot_cd.add(q) as f64;*cdu.add(r)=until;*tim.add(t as usize)=until;set_due(r,until);
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
    for i in 0..5{*cnt.add(4+i)=oc[i];}
}

/// A towerTarget order's towers (main.js processAction): tiles [0][0..P[0])
/// (-1 skipped); a tower there (ctab [1] = P[1], row [2] >= 0, owner [3] =
/// P[2]) takes target kind P[3], value P[4] into its row's _ptK [5] (i8) and
/// _ptV [6] (i32), and its brain word [4] the preferred bit (1 << 24) as
/// data_state.js stationaryBrainChanged makes it (a word 0: none made yet).
#[no_mangle]
pub unsafe extern "C" fn k_tower_target(a: u32, _chunk: i32) {
    let k = crate::k::K::new(crate::waddr(a) as *const i32);
    let (tl, ctab, rrow, own, brain, pk, pv) = (k.p::<i32>(0), k.p::<u8>(1), k.p::<i32>(2), k.p::<i32>(3), k.p::<i32>(4), k.p::<i8>(5), k.p::<i32>(6));
    if tl.is_null() || ctab.is_null() || rrow.is_null() || own.is_null() || brain.is_null() || pk.is_null() || pv.is_null() { return; }
    let (n, tct, ow, kind, value) = (k.i(0).max(0) as usize, k.i(1), k.i(2), k.i(3), k.i(4));
    for i in 0..n {
        let t = *tl.add(i);
        if t < 0 { continue; }
        let t = t as usize;
        let row = *rrow.add(t);
        if *ctab.add(t) as i32 != tct || row < 0 || *own.add(t) != ow { continue; }
        *pk.add(row as usize) = kind as i8;
        *pv.add(row as usize) = value;
        let b = *brain.add(t);
        if b != 0 { *brain.add(t) = if kind > 0 { b | (1 << 24) } else { b & !(1 << 24) }; }
    }
}
