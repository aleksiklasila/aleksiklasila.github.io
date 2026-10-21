"use strict";
importScripts('sim_frame.js?v=20261018-meta','sim_frame_world.js?v=20261021-x');
const PRESENT_MAGIC=0x50524553;
let source=null, meta=null, epoch=0, generation=0, latest=null, scheduled=false, strings=[''], ready=false;
let structure=null, structureRevision=-1, sentStructureRevision=-1, cells=null, oldCells=null;
let projectiles=null, projectileRevision=-1, sentProjectileRevision=-1;
let last=null, lastOrder=null, membership=0, sequence=0;
const buffers=new Map();
// out: the page's channel (frames out, buffers back). snaps: the
// simulation's per-tick position snapshots (sim_presentation.js
// simPresentTickEnd), the newest at snapCtl[0]. mot: this worker's copy of
// the newest (and the live velocities: facing only).
let out=null, snapCtl=null, snaps=null, torn=0;
// The simulation's metadata revision (sim_presentation.js simPresentationBind)
// and the buffer being filled (its entry: the revision its metadata holds).
let metaRev=null, filling=null;
const mot={x:null,y:null,px:null,py:null,vx:null,vy:null};
// The simulation publishes a snapshot only while snapCtl[1] is 1 (this
// worker asks for the next one when it took the newest, or found it older
// than the tick it draws: then it waits for the next tick, -3; a newer one
// is drawn, as before).
// (split: the copy left to the frame's ranges, each its own slots (a pass
// of every slot on this thread was ~110 ms a frame at 8M units); motSrc
// what they copy from, the snapshot's head checked after them.)
let motSrc=null, motHead=null, motTick=0;
function copyMotion(C,n,want,split) {
    const i=snapCtl ? Atomics.load(snapCtl,0) : -1, q=i>=0 && snaps ? snaps[i] : null;
    const src=q ? [['x',q.x],['y',q.y],['px',q.px],['py',q.py],['vx',C.vx],['vy',C.vy]] : [['x',C.x],['y',C.y],['px',C.prevX],['py',C.prevY],['vx',C.vx],['vy',C.vy]];
    const tick=q ? Atomics.load(q.head,0) : 0;
    if (q && tick<0) return -2;
    if (snapCtl) Atomics.store(snapCtl,1,1);
    if (q && tick<want) return -3;
    for (const [k,a] of src) if (!mot[k] || mot[k].length<a.length) mot[k]=sharedArray(Float32Array,a.length);
    motSrc=split ? src : null; motHead=q ? q.head : null; motTick=tick;
    if (!split) {
        copyMotionRange(src,0,n);
        // (Rewritten while copied: dropped.)
        if (q && Atomics.load(q.head,0)!==tick) return -2;
    }
    return q ? Math.min(n,q.head[1]) : n;
}
// Slots s0..s1 of the motion copy from src ([name, array]...).
function copyMotionRange(src,s0,s1) {
    for (const [k,a] of src) {
        const D=mot[k], e=Math.min(s1,a.length);
        // (Positions are Int32 eighths of a pixel: scaled here.)
        if (a instanceof Int32Array) {for (let s=s0;s<e;s++) D[s]=a[s]*.125;}
        else if (s0<e) D.set(a.subarray(s0,e),s0);
    }
}
// Where a fire target is (facing): its own copy, or with the copy split
// over the ranges the snapshot itself (the target's range may not have
// copied it yet).
const motTarget={x:null,y:null,k:1};
function motTargetFor(src) {
    if (!src) {motTarget.x=mot.x;motTarget.y=mot.y;motTarget.k=1;return;}
    const X=src[0][1], Y=src[1][1];
    motTarget.x=X;motTarget.y=Y;motTarget.k=X instanceof Int32Array ? .125 : 1;
}
function release(buf) {const t=new DataView(buf,buf.byteLength-12);if(t.getInt32(0,true)!==generation)return;const e=buffers.get(t.getInt32(4,true));if(e)e.busy=false;}
function acquire(bytes, kind='units') {
    for (const entry of buffers.values()) if (entry.kind===kind && !entry.busy && entry.buf.byteLength >= bytes+12) {entry.busy=true;filling=entry;return entry.buf;}
    // Three page-owned snapshots maximum. No growing queue when rendering stops.
    // (Two of a frame past 512 MB, millions of units: the page holds one, the
    // next is filled; a third was a gigabyte at 8M units.)
    const most = bytes > (512 << 20) ? 2 : 3;
    if ([...buffers.values()].filter(e=>e.kind===kind && e.busy).length >= most) return null;
    for (const [id,e] of buffers) if (e.kind===kind && !e.busy) buffers.delete(id);
    const buf=new SharedArrayBuffer(bytes+12), id=++sequence;
    const trailer=new DataView(buf,buf.byteLength-12);trailer.setInt32(0,generation,true);trailer.setInt32(4,id,true);trailer.setInt32(8,PRESENT_MAGIC,true);
    filling={buf,busy:true,kind,metaRev:-1,metaN:0};buffers.set(id,filling);return buf;
}
function schedule() {
    if (scheduled || !latest || !source || !ready) return;
    scheduled=true;setTimeout(draw,0);
}
// Per-slot state of this worker (last ids, drawn positions, facings,
// ghosts, the motion copy) is on shared memory: with helpers each thread
// writes the slots of its range (presentHelpers). stateVersion: one was
// made anew (the helpers get it again).
const SHARED=typeof SharedArrayBuffer==='function';
let stateVersion=0;
function sharedArray(T,n,fill) {
    const a=new T(SHARED ? new SharedArrayBuffer(n*T.BYTES_PER_ELEMENT) : n);
    if (fill!==undefined) a.fill(fill);
    stateVersion++;
    return a;
}
// Slots s0..s1 of a frame (n listed in all) from the columns and this
// worker's motion copy: the listed ones in F.order from s0 on, their count
// returned; rangeChanged: a slot's unit changed. Column by column: each
// loop reads one or two columns and writes one (memcpy for the metadata,
// which has the frame's layout), ~10x faster than one loop writing all ~30
// columns of a unit (~60 ms a frame at 200k units, so frames reached the
// page a few times a second: units stood, then jumped). Slots not listed
// (FID -1) are not read, whatever they hold. (Its own function: as a long
// loop inside draw() it was compiled on the stack before draw's later code
// had run, and fell back to the interpreter at its end every frame.)
let rangeChanged=false;
// The drawn positions per slot (and whose they are), VIS_FOLLOW: the share
// of the way to the simulation's position a drawn unit goes each tick (a
// steady lag of about two steps behind it, a third of its step's
// variation: smooth before prompt, the user's choice). VIS_LAG bounds the
// remaining offset: long low-TPS steps catch up without resetting the start
// of the segment. A distance threshold cannot distinguish walking from a
// teleport when one simulation step covers a second of movement.
const vis={x:null,y:null,id:null}, VIS_FOLLOW=.35, VIS_LAG=64;
// (VIS_FOLLOW is the share per tick: a frame made some ticks after the last
// one goes the share those ticks add up to, so the drawn pace is the same
// whether a frame is made every tick or every third.)
let visFollow=VIS_FOLLOW, lastBuiltTick=-1;
// (The fog's full light, VISIBILITY_LIGHT_NORMALIZATION_RANGE: with each tick.)
let lightFull=6;
// Facing (presentation only: the simulation keeps none): toward the unit's
// fire target (the combat brain's, cmMode bit 4) when it has one, else its
// movement, else as it was. The movement is its velocity smoothed over a few
// ticks (FACE_VEL a tick): in a crowd one tick's sideways shove or shoulder
// step, then back, must not turn it there and back. Below FACE_MIN_SPEED
// (smoothed, px a base tick) it keeps its facing; within FACE_DEAD of it,
// too. It turns VIS_TURN of the way a tick (visTurn: per frame, by the ticks
// it covers), so a few ticks' change of mind is not a snap.
const face={a:null,id:null,vx:null,vy:null}, VIS_TURN=.3, TAU=Math.PI*2, INV_TAU=1/TAU;
const FACE_VEL=.3, FACE_MIN_SPEED=.2, FACE_DEAD=.04;
let visTurn=VIS_TURN, faceVel=FACE_VEL;
// atan2(y, x) within ~1e-5 rad, a few times faster than Math.atan2 (a third
// of the fill at 400k slots; facing is drawn only).
function fastAtan2(y,x) {
    const ax=x<0 ? -x : x, ay=y<0 ? -y : y, mx=ax>ay ? ax : ay, mn=ax>ay ? ay : ax;
    if (mx===0) return 0;
    const a=mn/mx, z=a*a;
    let r=(((((-0.0117212*z+0.05265332)*z-0.11643287)*z+0.19354346)*z-0.33262347)*z+0.99997726)*a;
    if (ay>ax) r=1.5707963267948966-r;
    if (x<0) r=3.141592653589793-r;
    return y<0 ? -r : r;
}
function ensureState(cap,history) {
    if (!vis.x || vis.x.length<cap) {vis.x=sharedArray(Float32Array,cap);vis.y=sharedArray(Float32Array,cap);vis.id=sharedArray(Int32Array,cap,-1);}
    if (!face.a || face.a.length<cap) {face.a=sharedArray(Float32Array,cap);face.id=sharedArray(Int32Array,cap,-1);face.vx=sharedArray(Float32Array,cap);face.vy=sharedArray(Float32Array,cap);}
    if (!fullAt || fullAt.length<cap) fullAt=sharedArray(Int32Array,cap);
    if (!easing || easing.length<cap) easing=sharedArray(Uint8Array,cap);
    if (history && (!ghost.x || ghost.x.length<cap)) {ghost.x=sharedArray(Float32Array,cap);ghost.y=sharedArray(Float32Array,cap);ghost.id=sharedArray(Int32Array,cap,-1);}
}
// Columns the fill writes (besides id and order): what a frame by changes
// copies forward from the newest frame for slots it does not fill.
const FILL_COLS=['x','y','px','py','vx','vy','owner','energy','r','cmd','level','blevel','flash','flags','light','mode','status','amount','facing','phase','prate'];
// (A frame by the simulation's marks copies the id and the metadata too: it
// lists slots and copies metadata only where it fills.)
const STAMP_COPY=FILL_COLS.concat(['id','type','wtype','wstate','style','watchedBy','vision','maxEnergy','cargo','tx','ty','orderDest','orderTick']);
// Per slot: still easing to its place (1) or turning (2) here: filled
// again while so (frames by marks). With the other per-slot state.
let easing=null;
const FILL_STATUS=SIM_UF_BURNING|SIM_UF_POISONED|SIM_UF_FROZEN|SIM_UF_WET|SIM_UF_SANDY|SIM_UF_WATCHED|SIM_UF_HIDDEN|SIM_UF_TRANSFER;
// (A drawn position within this of the simulation's: there, at rest, so a
// still unit is not filled again.)
const VIS_REST=.02;
// A frame by changes (dl: the newest frame A, this buffer's last build bseq,
// this frame's seq, every K-th block of slots refilled anyway at `phase`):
// this buffer was whole as of bseq, so a slot is filled when it may have
// changed since the newest frame (in or out of the frame, moving or still
// easing, turning, its energy, owner or command changed, a flash, a status
// timer, or its block's turn), copied from A when it was filled after bseq,
// else left. (95% of millions of units stand still: a frame wrote ~25
// columns of every slot, 0.5-2 s of threads a frame at 2M-8M units.)
// fullAt: per slot the frame it was last filled in. A thread's own lists:
// fillList (filled), copyList (copied), fillBlocks (blocks with a fill).
let fullAt=null, fillList=null, copyList=null, fillBlocks=null, lastStamped=false, lastFilled=0;
function fillRange(F,C,meta,s0,s1,n,player,areaUnit,metaCopy,dl,frameSeq) {
    let count=0, changed=false;
    const stamped=!!dl && !!C.pvAt && dl.ta>=0 && !!easing;
    lastStamped=false;lastFilled=0;
    const L=last, FID=F.id, FORD=F.order, CID=C.id, CLIVE=C.live, CDEAD=C.dead, MID=meta.id, len=Math.max(0,s1-s0);
    if (!fillList || fillList.length<len) {fillList=new Int32Array(len);copyList=new Int32Array(len);}
    const nbk=Math.ceil(len/DIRTY_BLOCK)+1;
    if (!fillBlocks || fillBlocks.length<nbk) fillBlocks=new Uint8Array(nbk);
    const AL=fillList, CL=copyList, BK=fillBlocks;
    let na=0, nc=0;
    if (!dl) {
        for (let s=s0;s<s1;s++) {
            const id=CID[s];
            AL[na++]=s;
            if (!CLIVE[s] || CDEAD[s] || MID[s] !== id) {FID[s]=-1;if(L[s]!==-1) {changed=true;L[s]=-1;}continue;}
            FID[s]=id;FORD[s0+count++]=s;
            if(L[s]!==id) {changed=true;L[s]=id;}
        }
        BK.fill(1,0,nbk);
        if (fullAt) {const FA=fullAt, seq=frameSeq|0;for (let s=s0;s<s1;s++) FA[s]=seq;}
    } else if (stamped) {
        // (By the simulation's marks: a slot changed after the newest frame's
        // tick dl.ta, one still easing or turning here, one whose metadata
        // came, or its block's turn; four reads a slot.)
        const CA=C.pvAt, ES=easing, ta=dl.ta, FA=fullAt, bseq=dl.bseq, seq=dl.seq, K=dl.K, ph=dl.phase, B=DIRTY_BLOCK;
        BK.fill(0,0,nbk);
        for (let s=s0;s<s1;s++) {
            const m=MID[s];
            if (CA[s]>ta || ES[s]!==0 || (m!==L[s] && m===CID[s]) || ((s>>8)%K)===ph) {
                AL[na++]=s;FA[s]=seq;BK[((s-s0)/B)|0]=1;
                const id=CID[s];
                if (!CLIVE[s] || CDEAD[s] || m !== id) {FID[s]=-1;if (L[s]!==-1) {changed=true;L[s]=-1;}}
                else {FID[s]=id;if (L[s]!==id) {changed=true;L[s]=id;}}
            } else if (FA[s]>bseq) CL[nc++]=s;
        }
        const A=dl.A;
        for (let c=0;c<STAMP_COPY.length;c++) {const D=F[STAMP_COPY[c]], S=A[STAMP_COPY[c]];for (let i=0;i<nc;i++) {const s=CL[i];D[s]=S[s];}}
    } else {
        const VX=vis.x, VY=vis.y, VI=vis.id, SX=mot.x, SY=mot.y, CVX=C.vx, CVY=C.vy, AF=C.attackFlash, ON=C.stOn, TC=C.workerTransferCooldown, CM=C.cmMode;
        const A=dl.A, PF=A.flash, PFL=A.flags, PVX=A.vx, PVY=A.vy, PEN=A.energy, POW=A.owner, PCM=A.cmd, CEN=C.energy, COW=C.owner, CCM=C.commandState;
        const FA=fullAt, bseq=dl.bseq, seq=dl.seq, K=dl.K, ph=dl.phase, B=DIRTY_BLOCK;
        BK.fill(0,0,nbk);
        for (let s=s0;s<s1;s++) {
            const id=CID[s];
            if (!CLIVE[s] || CDEAD[s] || MID[s] !== id) {
                FID[s]=-1;
                if (L[s]!==-1) {changed=true;L[s]=-1;AL[na++]=s;BK[((s-s0)/B)|0]=1;FA[s]=seq;}
                else if (FA[s]>bseq) CL[nc++]=s;
                continue;
            }
            FID[s]=id;FORD[s0+count++]=s;
            let act=L[s]!==id;
            if (act) {changed=true;L[s]=id;}
            else act=VI[s]!==id || VX[s]!==SX[s] || VY[s]!==SY[s] || CVX[s]!==0 || CVY[s]!==0 || PVX[s]!==0 || PVY[s]!==0 || AF[s]>0 || PF[s]>0 || (ON && ON[s]===1) || TC[s]>0
                || (PFL[s]&FILL_STATUS)!==0 || CEN[s]!==PEN[s] || COW[s]!==POW[s] || CCM[s]!==PCM[s] || (CM && (CM[s]&4)!==0) || ((s>>8)%K)===ph;
            if (act) {AL[na++]=s;FA[s]=seq;BK[((s-s0)/B)|0]=1;}
            else if (FA[s]>bseq) CL[nc++]=s;
        }
        // (Copied forward: as the newest frame has them.)
        for (let c=0;c<FILL_COLS.length;c++) {const D=F[FILL_COLS[c]], S=A[FILL_COLS[c]];for (let i=0;i<nc;i++) {const s=CL[i];D[s]=S[s];}}
    }
    // Motion, smoothed for the eye (this worker's own state, never the
    // simulation's): each unit is drawn moving from where it was drawn last
    // tick toward VIS_FOLLOW of the way to where the simulation has it. A
    // tick's step varies with the pushes of a crowd (1.9, 3.9, 2.1 px...);
    // drawn as is, units sped up and stalled tick to tick. A unit new to its
    // slot starts with its simulation segment. Real portal teleports carry
    // a hidden flag; a restore starts a new reader. Ordinary movement always
    // continues from the preceding visual endpoint, including large steps.
    {
        const DX=F.x, DY=F.y, DPX=F.px, DPY=F.py, SX=mot.x, SY=mot.y, SPX=mot.px, SPY=mot.py, VX=vis.x, VY=vis.y, VI=vis.id, ES=easing, H=C.teleportHideTicks;
        for (let i=0;i<na;i++) {
            const s=AL[i], id=FID[s];
            if (id<0) {VI[s]=-1;if (ES) ES[s]=0;continue;}
            const x=SX[s], y=SY[s];
            const ox=VX[s], oy=VY[s], gap=Math.abs(x-ox)+Math.abs(y-oy);
            if (VI[s]!==id || H[s]>0) {DPX[s]=H[s]>0?x:SPX[s];DPY[s]=H[s]>0?y:SPY[s];DX[s]=x;DY[s]=y;VX[s]=x;VY[s]=y;VI[s]=id;if (ES) ES[s]&=~1;continue;}
            if (gap<VIS_REST) {DPX[s]=x;DPY[s]=y;DX[s]=x;DY[s]=y;VX[s]=x;VY[s]=y;if (ES) ES[s]&=~1;continue;}
            // The usual crowd filter is unchanged. Beyond its lag budget,
            // increase only the endpoint's catch-up, never jump the start.
            // O(1) in this existing fill; no new columns or render-frame work.
            const follow=gap>VIS_LAG ? Math.max(visFollow,1-VIS_LAG/gap) : visFollow;
            const nx=ox+(x-ox)*follow, ny=oy+(y-oy)*follow;
            DPX[s]=ox;DPY[s]=oy;DX[s]=nx;DY[s]=ny;VX[s]=nx;VY[s]=ny;
            if (ES) ES[s]|=1;
        }
    }
    {const D=F.vx,S=mot.vx;for(let i=0;i<na;i++) {const s=AL[i];D[s]=S[s];}}
    {const D=F.vy,S=mot.vy;for(let i=0;i<na;i++) {const s=AL[i];D[s]=S[s];}}
    // Metadata (the pump's table, the frame's own layout): copied whole, when
    // it changed since this buffer last had it (or covers more slots now).
    if (stamped) {for (const k of META_COPY) {const D=F[k], S=meta[k];for (let i=0;i<na;i++) {const s=AL[i];D[s]=S[s];}}}
    else if (metaCopy) for (const k of META_COPY) F[k].set(meta[k].subarray(s0,s1),s0);
    {const D=F.owner,S=C.owner;for(let i=0;i<na;i++) {const s=AL[i];D[s]=S[s];}}
    {const D=F.energy,S=C.energy;for(let i=0;i<na;i++) {const s=AL[i];D[s]=S[s];}}
    {const D=F.r,S=C.r;for(let i=0;i<na;i++) {const s=AL[i];D[s]=S[s];}}
    {const D=F.cmd,S=C.commandState;for(let i=0;i<na;i++) {const s=AL[i];D[s]=S[s];}}
    // (Levels into int16: as integers, -1 when not a number.)
    {const D=F.level,S=C.effectiveLevel;for(let i=0;i<na;i++) {const s=AL[i], v=S[s];D[s]=v>=0 && v<32767 ? v|0 : -1;}}
    {const D=F.blevel,S=C.unitLevel;for(let i=0;i<na;i++) {const s=AL[i], v=S[s];D[s]=v>=0 && v<32767 ? v|0 : -1;}}
    {const D=F.flash,S=C.attackFlash;for(let i=0;i<na;i++) {const s=AL[i], v=S[s];D[s]=v>255?255:v>0?v:0;}}
    {
        // (The status timers only of units with one running, stOn: the
        // rest read one byte instead of seven columns.)
        const D=F.flags, M=meta.flags, B=C.burning, P=C.poisoned, Z=C.frozen, W=C.wet, Y=C.sandy, V=C.watched, H=C.teleportHideTicks, T=C.workerTransferCooldown, ON=C.stOn;
        for (let i=0;i<na;i++) {const s=AL[i];D[s]=M[s] | (T[s]>0?SIM_UF_TRANSFER:0) | (ON && !ON[s] ? 0 : (B[s]>0?SIM_UF_BURNING:0) | (P[s]>0?SIM_UF_POISONED:0) | (Z[s]>0?SIM_UF_FROZEN:0) | (W[s]>0?SIM_UF_WET:0)
            | (Y[s]>0?SIM_UF_SANDY:0) | (V[s]>0?SIM_UF_WATCHED:0) | (H[s]>0?SIM_UF_HIDDEN:0));}
    }
    {
        // The light a unit is drawn with at least: a unit that is a light
        // source for the viewing player (its own, or one it watches) lights
        // its own area to the full whatever its range, so it is drawn at the
        // full at once. (Its range in tiles before: a unit seeing only its
        // own area got half, and the fog's light of an area it had just
        // walked into rises over most of a second: it dimmed and brightened
        // at every border it crossed.)
        const D=F.light, O=F.owner, V=C.watched, WB=F.watchedBy, VIS=F.vision, ON=C.stOn, full=lightFull;
        for (let i=0;i<na;i++) {const s=AL[i];D[s]=O[s]===player || ((!ON || ON[s]) && V[s]>0 && WB[s]===player) ? Math.max(VIS[s]*areaUnit,full) : 0;}
    }
    {
        const X=F.x, Y=F.y, PX=F.px, PY=F.py, FL=F.flash, MO=F.mode, ST=F.status, AM=F.amount;
        for (let i=0;i<na;i++) {
            const s=AL[i], dx=X[s]-PX[s], dy=Y[s]-PY[s], moving=dx*dx+dy*dy>.0001, flash=FL[s]>0;
            MO[s]=flash?1:moving?0:7;ST[s]=flash?1:moving?0:3;AM[s]=moving || flash ? 1 : .7;
        }
    }
    {
        const D=F.facing, VX=F.vx, VY=F.vy, CM=C.cmMode, CT=C.cmT, SX=mot.x, SY=mot.y, FA=face.a, FI=face.id, FVX=face.vx, FVY=face.vy, TX=motTarget.x, TY=motTarget.y, TK=motTarget.k, ES=easing;
        const kv=faceVel, kt=visTurn, min2=FACE_MIN_SPEED*FACE_MIN_SPEED;
        for (let i=0;i<na;i++) {
            const s=AL[i], id=FID[s];
            if (id<0) {FI[s]=-1;continue;}
            const fresh=FI[s]!==id;
            let vx=fresh ? VX[s] : FVX[s]+(VX[s]-FVX[s])*kv, vy=fresh ? VY[s] : FVY[s]+(VY[s]-FVY[s])*kv, settle=false;
            // (Within a hair of its velocity: settled; else filled again next
            // frame, as turning is, so frames made by changes stay the same.)
            if (!fresh) {const ex=VX[s]-vx, ey=VY[s]-vy;if (ex*ex+ey*ey<1e-6) {vx=VX[s];vy=VY[s];} else settle=true;}
            FVX[s]=vx;FVY[s]=vy;
            let want=NaN;
            if (CM && (CM[s]&4)) {const q=CT[s];if (q>=0 && q<n) {const dx=TX[q]*TK-SX[s], dy=TY[q]*TK-SY[s];if (dx || dy) want=fastAtan2(dx,dy);}}
            if (want!==want && vx*vx+vy*vy>min2) want=fastAtan2(vx,vy);
            let f=fresh ? (want===want ? want : 0) : FA[s], turning=false;
            if (want===want) {let d=want-f;d-=Math.round(d*INV_TAU)*TAU;if (Math.abs(d)>FACE_DEAD) {f+=d*kt;turning=true;}}
            FA[s]=f;FI[s]=id;D[s]=f;
            if (ES) ES[s]=turning || settle ? ES[s]|2 : ES[s]&~2;
        }
    }
    {const D=F.phase,I=F.id,R=F.prate,FL=F.flash;
        for(let i=0;i<na;i++) {
            const s=AL[i], p=I[s]*2.399;
            D[s]=FL[s]>0?Math.max(0,(8-FL[s])/8)*Math.PI:p-Math.floor(p*INV_TAU)*TAU;
            R[s]=FL[s]>0?Math.PI/8:0;
        }
    }
    if (!dl) F.sig.fill(0,s0,s1);
    if (stamped) {
        for (let i=0;i<na;i++) {const s=AL[i], id=FID[s];if (id>=0 && (CID[s]!==id || MID[s]!==id || CDEAD[s])) {FID[s]=-1;L[s]=-1;changed=true;}}
        for (let s=s0;s<s1;s++) if (FID[s]>=0) FORD[s0+count++]=s;
        rangeChanged=changed;lastStamped=true;lastFilled=na;
        return count;
    }
    // The simulation may recycle a slot during the scan: dropped rather than
    // shown with the old unit's metadata at the new one's place.
    for (let k=s0;k<s0+count;k++) {
        const s=FORD[k], id=FID[s];
        if (CID[s]!==id || MID[s]!==id || CDEAD[s]) {FID[s]=-1;L[s]=-1;changed=true;}
    }
    if (changed) {let j=s0;for(let k=s0;k<s0+count;k++) {const s=FORD[k];if(FID[s]>=0) FORD[j++]=s;}count=j-s0;}
    rangeChanged=changed;
    return count;
}
// Team + history: what the player does not see now is drawn as it was
// last seen, frozen until its tile is seen again (the same as full
// visibility, but for the frozen ones outside the seen tiles). Per slot its
// unit's last seen position (while its tile was seen); a unit not seen now
// is drawn there (SIM_UF_GHOST) while that place is unseen, else hidden.
// One pass a tick here, nothing per unit on the page. (A unit that dies or
// whose slot is reused unseen loses its ghost: rare, harmless.)
const ghost={x:null,y:null,id:null};
// (Seen = the fog's eased light, as the page and the GPU see it: the raw
// sight flickers at vision's edges, units there went live, ghost, live.)
function ghostSight(T) {
    const gw=T.gw|0, gh=T.gh|0;
    const S=fogState.light && fogState.w===gw && fogState.h===gh ? fogState.light : T.sight;
    return S && S.length>=gw*gh ? {gw,gh,tile:T.tile||32,player:T.player,light:S} : null;
}
function applyGhosts(F,s0,s1,G) {
    const gw=G.gw, gh=G.gh, it=1/G.tile, player=G.player, S=G.light;
    const GX=ghost.x, GY=ghost.y, GI=ghost.id, FID=F.id, X=F.x, Y=F.y, PX=F.px, PY=F.py, FL=F.flags, OWN=F.owner;
    for (let s=s0;s<s1;s++) {
        const id=FID[s];
        if (id<0) {GI[s]=-1;continue;}
        if (OWN[s]===player) continue;
        let tx=Math.floor(X[s]*it), ty=Math.floor(Y[s]*it);
        tx=tx<0?0:tx>=gw?gw-1:tx; ty=ty<0?0:ty>=gh?gh-1:ty;
        if (S[ty*gw+tx]>0) {GX[s]=X[s];GY[s]=Y[s];GI[s]=id;continue;}
        if (GI[s]===id) {
            let gx=Math.floor(GX[s]*it), gy=Math.floor(GY[s]*it);
            gx=gx<0?0:gx>=gw?gw-1:gx; gy=gy<0?0:gy>=gh?gh-1:gy;
            if (!(S[gy*gw+gx]>0)) {X[s]=PX[s]=GX[s];Y[s]=PY[s]=GY[s];FL[s]|=SIM_UF_GHOST;continue;}
        }
        FL[s]|=SIM_UF_HIDDEN;GI[s]=-1;
    }
}
// The fog's light (each tile's light easing toward what is seen: up at
// T.rise a second, down at T.fall after a second's hold) and the fog's own
// grid (the light, plus with history a floor where once explored), as
// visibility_history.js updateVisualVisibility made them on the page each
// tick (a pass over every tile there). Shared: the page reads them as its
// grids (and the GPU's fog); head[0] the version (the tick made for).
const fogState={w:0,h:0,light:null,fog:null,explored:null,hold:null,head:null,tick:-1,history:null,bound:false};
function updateFog(T) {
    const S=T.sight, W=T.gw|0, H=T.gh|0, n=W*H;
    if (!S || S.length<n) return;
    const st=fogState;
    let reset=false;
    if (st.w!==W || st.h!==H || !st.light) {
        st.w=W;st.h=H;
        st.light=new Float32Array(new SharedArrayBuffer(n*4));st.fog=new Float32Array(new SharedArrayBuffer(n*4));
        st.explored=new Uint8Array(new SharedArrayBuffer(n));st.hold=new Int32Array(n).fill(-1);st.head=new Int32Array(new SharedArrayBuffer(8));
        st.tick=T.time;st.bound=false;reset=true;
    }
    const now=T.time, holdTicks=Math.max(1,T.rate|0);
    if (now<st.tick) {const back=st.tick-now;for(let i=0;i<n;i++) st.hold[i]-=back;st.tick=now;}
    const dt=Math.min(2,Math.max(0,now-st.tick))/holdTicks, rise=T.rise*dt, fall=T.fall*dt;
    const full=reset || st.history!==!!T.history, hist=!!T.history, range=T.lightRange||6, floor=range*(T.historyFloor||.14);
    st.history=hist;
    const L=st.light, G=st.fog, E=st.explored, HD=st.hold;
    for (let i=0;i<n;i++) {
        const target=S[i], current=L[i];
        if (target===0 && current===0 && !full) continue;
        if (target>0) {HD[i]=now+holdTicks;E[i]=1;}
        let next=target;
        if (!reset) {
            if (target===0 && now<=HD[i]) next=current;
            else {const d=target-current;next=current+(d>rise?rise:d<-fall?-fall:d);}
        }
        L[i]=next;
        let f=L[i];
        if (hist && E[i]) {const dark=1-Math.min(1,f/range);f+=floor*dark*dark*dark;}
        G[i]=f;
    }
    st.tick=now;
    Atomics.store(st.head,0,now);
    if (!st.bound) {(out || self).postMessage({type:'fogBind',epoch,light:st.light,fog:st.fog,explored:st.explored,head:st.head,width:W,height:H});st.bound=true;}
}
// The metadata columns copied whole each frame (the pump writes them).
const META_COPY=['type','wtype','wstate','style','watchedBy','vision','maxEnergy','cargo','tx','ty','orderDest','orderTick'];
// Append the render-only spatial index to the immutable presentation buffer.
// Its lifetime follows the existing three-buffer pool; no extra messages or
// population-sized indexing pass on the animation thread.
function buildRenderBuckets(F, count, columns, rows, tile) {
    const cells = columns * rows, offset = F.cap * SIM_FRAME_SLOT_BYTES;
    const head = new Int32Array(F.buf, offset, cells);
    const motion = new Float32Array(F.buf, offset + cells * 4, cells);
    const next = new Int32Array(F.buf, offset + cells * 8, F.cap);
    const movingOffset = offset + cells * 8 + F.cap * 4;
    const moving = new Int32Array(F.buf, movingOffset, F.cap);
    let previous = buildRenderBuckets.previous;
    if (!previous || previous.x.length !== F.cap) previous = buildRenderBuckets.previous = {
        x:new Float32Array(F.cap),y:new Float32Array(F.cap),ready:false
    };
    let movingCount = 0;
    head.fill(-1); motion.fill(0);
    const invCell = 1 / (tile * 16), invTile = 1 / tile;
    for (let k = 0; k < count; k++) {
        const s = F.order[k], x = F.x[s], y = F.y[s];
        const bx = Math.max(0, Math.min(columns - 1, Math.floor(x * invCell)));
        const by = Math.max(0, Math.min(rows - 1, Math.floor(y * invCell)));
        const b = by * columns + bx;
        next[k] = head[b]; head[b] = k;
        const distance = Math.max(Math.abs(F.px[s] - x), Math.abs(F.py[s] - y)) * invTile;
        if (distance > motion[b]) motion[b] = distance;
        // Include teleports/stops even when the simulation's previous position
        // already equals its destination. The page merges with its old movers.
        if (distance > 0 || (previous.ready && (previous.x[s] !== x || previous.y[s] !== y))) moving[movingCount++] = s;
        previous.x[s] = x; previous.y[s] = y;
    }
    previous.ready = true;
    return { columns, rows, tile, offset, movingOffset, movingCount };
}
// Which parts of the renderer's unit columns changed, so the page uploads
// only those (renderer3d.js _columnStoreUpload: all ~16 columns of every
// slot were ~11 MB a tick at 100k a team, and a GPU process busy for a
// moment held the page in bufferSubData for 70-200 ms). Per column and
// block of DIRTY_BLOCK slots: the last frame (seq) it changed in, kept here
// and copied into each frame, so a page that skipped frames still knows
// what changed since the one its GPU holds. Changed: a slot whose unit is
// live and was not in the last frame (or past its count: the GPU holds
// something else there), or whose value differs; dead slots are not drawn,
// what they hold does not count (the id column: every difference).
// (~40% of slots move in a battle, in squads of nearby slots: ~70-80% less
// a tick; most columns change only where units die or are made.) Columns
// made from others are marked where those changed: phase and prate from
// the id and the attack flash, amount from the mode (fillRange).
const DIRTY_COLS=['x','y','px','py','r','energy','owner','flags','id','type','facing','phase','prate','vision','mode','amount'], DIRTY_BLOCK=256;
const DIRTY_FROM={phase:'flash',prate:'flash',amount:'mode'};
const dirty={stream:(Math.random()*2147483647)|0,seq:0,cap:-1,stamps:null,prev:null,prevN:0,prevTick:-1};
// (A thread's own per-block scratch: blocks new to a unit, and per column
// the blocks changed.)
const dirtyWork={nb:-1,born:null,masks:null};
function dirtyBytes(cap) {return DIRTY_COLS.length*Math.ceil(cap/DIRTY_BLOCK)*4;}
// Columns compared 8 bytes at a time (a word: `per` slots), as integers
// slot by slot only in words that differ: most words are equal. Equal words
// are equal slots but for +0 / -0 (the sign in the word's top slot). (4-byte
// columns as Int32: bit for bit; no words when a column is not 8-byte aligned.)
function dirtyInts(a) {return a.BYTES_PER_ELEMENT===4 && !(a instanceof Int32Array) ? new Int32Array(a.buffer,a.byteOffset,a.length) : a;}
function dirtyWords(a) {return (a.byteOffset&7)===0 ? new Float64Array(a.buffer,a.byteOffset,a.byteLength>>3) : null;}
function dirtyHalves(a) {return new Int32Array(a.buffer,a.byteOffset,a.length*2);}
// Per block b0..b1 (HIT): a live slot changed, or a unit is new there (BORN).
// (a, q: the words; ah, qh: their halves as Int32, the sign in the upper
// one: only these in the loop over equal words, one element type each.)
function dirtyScan(A,Q,a,q,ah,qh,per,I,HIT,BORN,b0,b1,n) {
    const B=DIRTY_BLOCK;
    for (let b=b0;b<b1;b++) {
        if (BORN[b]) {HIT[b]=1;continue;}
        const s0=b*B, e=s0+B<n?s0+B:n;
        let hit=false, k=s0;
        if (a) {
            for (let w=(s0/per)|0, we=(e/per)|0;w<we;w++) {
                const x=a[w];
                if (x===q[w] && (x!==0 || ah[2*w+1]===qh[2*w+1])) continue;
                for (let j=w*per, je=j+per;j<je;j++) if (A[j]!==Q[j] && I[j]>=0) {hit=true;break;}
                if (hit) break;
            }
            k=e-e%per;
        }
        if (!hit) for (;k<e;k++) if (A[k]!==Q[k] && I[k]>=0) {hit=true;break;}
        HIT[b]=hit?1:0;
    }
}
// The id column (every difference) and the blocks with a unit new to its slot.
function dirtyIds(I,J,HIT,BORN,b0,b1,n,pn) {
    const B=DIRTY_BLOCK;
    for (let b=b0;b<b1;b++) {
        const s0=b*B, e=s0+B<n?s0+B:n;
        let born=e>pn, hit=born;
        if (!born) for (let s=s0;s<e;s++) if (I[s]!==J[s]) {hit=true;if (I[s]>=0) {born=true;break;}}
        BORN[b]=born?1:0;HIT[b]=hit?1:0;
    }
}
// Blocks b0..b1 of frame F against the last one, P (n slots now, pn then):
// the changed ones get seq in the stamps (ST, nb blocks a column).
// (ACT: per block from b0 whether the fill wrote a slot there, a frame by
// changes: the others equal the last frame but in the metadata columns,
// compared where the metadata was copied, metaAll.)
const DIRTY_META=new Set(['type','vision']);
function markDirtyRange(F,P,n,pn,b0,b1,seq,ST,nb,ACT,metaAll) {
    if (!ACT) {markDirtyRun(F,P,n,pn,b0,b1,seq,ST,nb,false);return;}
    for (let b=b0;b<b1;) {
        let e=b+1;
        const on=ACT[b-b0]!==0;
        while (e<b1 && (ACT[e-b0]!==0)===on) e++;
        if (on) markDirtyRun(F,P,n,pn,b,e,seq,ST,nb,false);
        else if (metaAll) markDirtyRun(F,P,n,pn,b,e,seq,ST,nb,true);
        b=e;
    }
}
// The marks of a frame by the simulation's marks: only its filled slots
// (AL, na of them) may differ from the last frame P, so they are compared
// slot by slot, with the same result as the blocks' compare (a live slot
// that differs, bit for bit; a unit new to its slot, or a block past the
// last frame's count when it grew, every column; the id column at every
// difference). b0..b1 the range's blocks.
const DIRTY_FROM_COLS=DIRTY_COLS.map(c => DIRTY_FROM[c] || c);
function markDirtySlots(F,P,AL,na,n,pn,b0,b1,seq,ST,nb) {
    const B=DIRTY_BLOCK, nc=DIRTY_COLS.length, I=F.id, J=P.id, A=DIRTY_FROM_COLS.map(c => dirtyInts(F[c])), Q=DIRTY_FROM_COLS.map(c => dirtyInts(P[c])), idc=DIRTY_COLS.indexOf('id');
    const all=b => {for (let c=0;c<nc;c++) ST[c*nb+b]=seq;};
    if (n>pn) for (let b=Math.max(b0,Math.floor(pn/B));b<b1;b++) if ((b+1)*B>pn && b*B<n) all(b);
    for (let i=0;i<na;i++) {
        const s=AL[i], b=(s/B)|0, id=I[s];
        if (s>=n) continue;
        if (id!==J[s]) {ST[idc*nb+b]=seq;if (id>=0) {all(b);continue;}}
        if (id<0) continue;
        for (let c=0;c<nc;c++) if (A[c][s]!==Q[c][s]) ST[c*nb+b]=seq;
    }
}
function markDirtyRun(F,P,n,pn,b0,b1,seq,ST,nb,metaOnly) {
    const W=dirtyWork;
    if (W.nb!==nb) {W.nb=nb;W.born=new Uint8Array(nb);W.masks=new Map();}
    const mask=name => {let M=W.masks.get(name);if (!M) W.masks.set(name,M=new Uint8Array(nb));return M;};
    const I=F.id, scanned=new Set(['id']);
    if (metaOnly) W.born.fill(0,b0,b1);
    else dirtyIds(I,P.id,mask('id'),W.born,b0,b1,n,pn);
    for (let c=0;c<DIRTY_COLS.length;c++) {
        if (metaOnly && !DIRTY_META.has(DIRTY_COLS[c])) continue;
        const from=DIRTY_FROM[DIRTY_COLS[c]] || DIRTY_COLS[c], M=mask(from);
        if (!scanned.has(from)) {
            const A=dirtyInts(F[from]), Q=dirtyInts(P[from]), a=dirtyWords(A), q=a && dirtyWords(Q);
            dirtyScan(A,Q,q ? a : null,q,q && dirtyHalves(a),q && dirtyHalves(q),8/A.BYTES_PER_ELEMENT,I,M,W.born,b0,b1,n);
            scanned.add(from);
        }
        for (let b=b0,base=c*nb;b<b1;b++) if (M[b]) ST[base+b]=seq;
    }
}
// A frame's marks begin (this frame's seq; the last frame to compare with,
// or none: every block marked) and end (copied into the frame: its record).
function dirtyBegin(F,n) {
    const nc=DIRTY_COLS.length, nb=Math.ceil(F.cap/DIRTY_BLOCK), used=Math.ceil(n/DIRTY_BLOCK), D=dirty;
    if (D.cap!==F.cap) {D.cap=F.cap;D.stamps=sharedArray(Int32Array,nc*nb);D.prev=null;}
    const seq=++D.seq, P=D.prev && D.prev.buf!==F.buf ? D.prev : null;
    if (!P) for (let c=0;c<nc;c++) D.stamps.fill(seq,c*nb,c*nb+used);
    return {seq,prev:P,pn:Math.min(D.prevN,n),nb};
}
// (prevTick: the tick the last frame was made from, its marks' bound.)
function dirtyEnd(F,n,offset,seq,tick) {
    const D=dirty, nb=Math.ceil(F.cap/DIRTY_BLOCK);
    D.prev=F;D.prevN=n;D.prevTick=Number.isFinite(tick) ? tick : -1;
    new Int32Array(F.buf,offset,D.stamps.length).set(D.stamps);
    return {offset,seq,stream:D.stream,block:DIRTY_BLOCK,nb,cols:DIRTY_COLS};
}
// A frame's slot ranges, split for this worker and its helpers (whole
// blocks of DIRTY_BLOCK slots each): a range's fill (J.nn slots listed of
// J.n), its ghosts and its change marks. Returns its count listed (from
// F.order[s0] on), rangeChanged as it left it.
function frameRange(J,F,P) {
    const s1=Math.min(J.s1,J.nn);
    let count=0;
    rangeChanged=false;
    // (By changes: J.delta, from the last frame P, this buffer whole as of J.bseq.)
    const dl=J.delta && P ? {A:P,bseq:J.bseq,seq:J.seq,K:J.K,phase:J.phase,ta:J.ta} : null;
    if (J.msrc) copyMotionRange(J.msrc,J.s0,J.s1);
    motTargetFor(J.msrc);
    if (J.s0<s1) count=fillRange(F,source,meta,J.s0,s1,J.nn,J.player,J.areaUnit,J.metaCopy,dl,J.seq);
    else if (dl && fillBlocks) fillBlocks.fill(0);
    const changed=rangeChanged;
    if (J.ghosts && J.s0<s1) applyGhosts(F,J.s0,s1,J.ghosts);
    if (J.marks && P) {
        if (lastStamped && J.s0<s1) markDirtySlots(F,P,fillList,lastFilled,J.n,J.pn,(J.s0/DIRTY_BLOCK)|0,Math.ceil(J.s1/DIRTY_BLOCK),J.seq,dirty.stamps,J.nb);
        else markDirtyRange(F,P,J.n,J.pn,(J.s0/DIRTY_BLOCK)|0,Math.ceil(J.s1/DIRTY_BLOCK),J.seq,dirty.stamps,J.nb,dl && J.s0<s1 ? fillBlocks : null,J.metaCopy);
    }
    rangeChanged=changed;
    return count;
}
// ---- helpers: this script again, named present-helper ----
// From PRESENT_HELPER_MIN slots a frame's ranges are split over this thread
// and up to 3 helpers (a quarter of the cores less one), each range written
// by one thread: the frame, the columns and the per-slot state are shared.
// (One thread at 400k slots: 60-80 ms a frame, a frame every 2-3 ticks.)
// Jobs go by message; they report through helperDone (Atomics), which this
// thread waits on after its own range. A helper is used once it said it is
// ready (its script loaded); one that fails turns the helpers off.
const HELPER=typeof self==='object' && self.name==='present-helper';
const PRESENT_HELPER_MIN=60000;
const PRESENT_ALL_HELPERS_MIN=1000000;
// Frames by changes from this many slots; every slot refilled at least every
// PRESENT_DELTA_ROUNDS frames (a change the rules miss shows that late).
let PRESENT_DELTA_MIN=100000;
const PRESENT_DELTA_ROUNDS=32;
let helpers=null, helpersOff=false, helperBound='', helperDone=null, helperResults=null, bindVersion=0;
function stopHelpers(why) {
    if (helpers) for (const h of helpers) {try {h.worker.terminate();} catch {}}
    helpers=null;helpersOff=true;
    helperBound='';
    if (why) console.warn('presentation helpers off: '+why);
}
function presentHelpers(nn) {
    if (helpersOff || HELPER || nn<PRESENT_HELPER_MIN || !SHARED || typeof Worker!=='function' || !(self.location && self.location.href)) return null;
    if (!helpers) {
        const cores=(self.navigator && navigator.hardwareConcurrency) || 4, want=Math.max(0,Math.min(3,(cores>>2)-1));
        if (!want) {helpersOff=true;return null;}
        helperDone=new Int32Array(new SharedArrayBuffer(4));helperResults=new Int32Array(new SharedArrayBuffer(8*want));
        helpers=[];
        for (let i=0;i<want;i++) {
            let worker;
            try {worker=new Worker(self.location.href,{name:'present-helper'});} catch (err) {break;}
            const h={worker,ready:false};
            worker.onmessage=ev=>{const m=ev.data||{};if (m.type==='helperReady') h.ready=true;else if (m.type==='error') console.warn(m.message);};
            worker.onerror=ev=>{if (ev && ev.preventDefault) ev.preventDefault();stopHelpers(String(ev && ev.message || 'a helper failed'));};
            helpers.push(h);
        }
        if (!helpers.length) {helpers=null;helpersOff=true;return null;}
        helperBound='';
    }
    if (!helpers.every(h=>h.ready)) return null;
    const key=stateVersion+':'+bindVersion;
    if (helperBound!==key) {
        for (const h of helpers) h.worker.postMessage({type:'helperBind',columns:source,meta:{buf:meta.buf,cap:meta.cap},last,vis,face,ghost,mot,fullAt,easing,stamps:dirty.stamps,done:helperDone,results:helperResults});
        helperBound=key;
    }
    return helpers;
}
// The frame's ranges (this thread the last): the count listed, F.order
// made contiguous, fillChanged; -1 when the helpers failed (the frame is
// dropped, the helpers off).
let fillChanged=false, rangeThreads=1;
function runRanges(J,F,P) {
    // (Paced, a frame has some ticks' time: fewer threads at once beside a
    // simulation short of them. Four at a time cost it ~1.5 TPS more at 600k
    // than one, at the same frames a second.)
    // (Millions of slots: every helper whatever the pace; one thread took
    // ~260 ms a frame at 2M units, frames 1.5 s behind the simulation.)
    const all=presentHelpers(J.nn), H=all && pacing.pace>1 && J.nn<PRESENT_ALL_HELPERS_MIN ? (pacing.pace===2 ? all.slice(0,1) : null) : all;
    const B=DIRTY_BLOCK, parts=H ? H.length+1 : 1;
    const per=Math.max(1,Math.ceil(Math.ceil(J.n/B)/parts))*B, R=[];
    for (let s=0;s<J.n;s+=per) R.push([s,Math.min(J.n,s+per)]);
    if (!R.length) {fillChanged=false;return 0;}
    const sent=R.length-1;
    if (sent) {
        Atomics.store(helperDone,0,0);
        for (let r=0;r<sent;r++) H[r].worker.postMessage({...J,type:'fill',s0:R[r][0],s1:R[r][1],slot:r,buf:F.buf,prevBuf:P ? P.buf : null,cap:F.cap,visFollow,visTurn,faceVel,lightFull});
    }
    const own=frameRange({...J,s0:R[sent][0],s1:R[sent][1]},F,P);
    let changed=rangeChanged;
    if (sent) {
        const deadline=performance.now()+2000;
        for (;;) {
            const d=Atomics.load(helperDone,0);
            if (d>=sent) break;
            if (performance.now()>deadline) {stopHelpers('no answer in 2 s');return -1;}
            Atomics.wait(helperDone,0,d,100);
        }
        for (let r=0;r<sent;r++) if (helperResults[2*r]<0) {stopHelpers('a range failed');return -1;}
    }
    const FORD=F.order;
    let total=0;
    for (let r=0;r<R.length;r++) {
        const c=r===sent ? own : helperResults[2*r];
        if (r<sent && helperResults[2*r+1]) changed=true;
        if (R[r][0]!==total && c) FORD.copyWithin(total,R[r][0],R[r][0]+c);
        total+=c;
    }
    fillChanged=changed;rangeThreads=R.length;
    return total;
}
function onHelperMessage(event) {
    const m=event.data;
    if (m.type==='helperBind') {
        source=m.columns;meta=simMetaViews(m.meta.buf,m.meta.cap);last=m.last;
        Object.assign(vis,m.vis);Object.assign(face,m.face);Object.assign(ghost,m.ghost);Object.assign(mot,m.mot);fullAt=m.fullAt;easing=m.easing;
        dirty.stamps=m.stamps;helperDone=m.done;helperResults=m.results;
        return;
    }
    if (m.type!=='fill') return;
    let count=-1, changed=0;
    try {
        // (After the job's post, which follows the motion copy: read it after this.)
        Atomics.load(helperDone,0);
        visFollow=m.visFollow;visTurn=m.visTurn;faceVel=m.faceVel;lightFull=m.lightFull;
        count=frameRange(m,simFrameViews(m.buf,m.cap),m.prevBuf ? simFrameViews(m.prevBuf,m.cap) : null);
        changed=rangeChanged ? 1 : 0;
    } catch (err) {postMessage({type:'error',message:'presentation helper: '+String(err.stack || err)});}
    finally {helperResults[2*m.slot]=count;helperResults[2*m.slot+1]=changed;Atomics.add(helperDone,0,1);Atomics.notify(helperDone,0);}
}
// Frames yield to the simulation: while ticks come slower than their rate
// (the simulation short of time), a frame is made only every `pace` ticks
// (up to PACE_MAX), back a step toward every tick after 3 s at the rate.
// (At 600k units the simulation ran 18.7 TPS beside 3-4 frames a second,
// 15.5 beside one a tick: frames cost the threads it needs.) The tick
// before a frame's asks for its snapshot (copyMotion: else the frame waits
// a tick more). self.presentPacing = false: a frame every tick (tests).
const PACE_MAX=4, PACE_FRAME_MS=250;
const pacing={pace:1,ticks:[],times:[],at:0,good:0};
function paceDue(m) {
    const P=pacing, now=performance.now();
    if (self.presentPacing===false) return true;
    P.ticks.push(m.tick);P.times.push(now);
    // (The last 1.5 s of ticks: after a pause, only those since.)
    while (P.times.length && now-P.times[0]>1500) {P.ticks.shift();P.times.shift();}
    if (now-P.at>=1000 && P.times.length>=10) {
        P.at=now;
        const tps=(P.ticks[P.ticks.length-1]-P.ticks[0])*1000/Math.max(1,now-P.times[0]), rate=m.rate>0 ? m.rate : 20;
        if (tps<rate*.95) {P.pace=Math.min(PACE_MAX,P.pace+1);P.good=0;}
        else if (tps>rate*.985 && ++P.good>=3) {P.pace=Math.max(1,P.pace-1);P.good=0;}
        // (But a frame at least every PACE_FRAME_MS: a simulation that never
        // reaches the rate (millions of units, ticks of 150 ms and more) kept
        // the pace at its most, a frame a second, the picture behind by it.)
        P.pace=Math.max(1,Math.min(P.pace,Math.floor(PACE_FRAME_MS*tps/1000)));
    }
    if (lastBuiltTick<0 || P.pace<=1 || m.tick-lastBuiltTick>=P.pace || m.tick<lastBuiltTick) return true;
    if (m.tick+1-lastBuiltTick>=P.pace && snapCtl) Atomics.store(snapCtl,1,1);
    return false;
}
function draw() {
    const started=performance.now();
    scheduled=false;
    const tick=latest;
    if (!tick || !source) return;
    const cap=source.id.length;
    const columns = tick.n >= 5000 && tick.gw > 0 ? Math.ceil(tick.gw / 16) : 0;
    const rows = columns ? Math.ceil(tick.gh / 16) : 0;
    const indexBytes = columns * rows ? columns * rows * 8 + cap * 8 : 0;
    const buf=acquire(cap*SIM_FRAME_SLOT_BYTES + indexBytes + dirtyBytes(cap));
    if (!buf) return;
    latest=null;
    const C=source;
    const t0=performance.now();
    const split=tick.n>=PRESENT_DELTA_MIN;
    const got=copyMotion(C,tick.n,tick.tick,split);
    const t1=performance.now();
    if (got===-3) {release(buf);return;}
    if (got<0) {torn++;release(buf);return;}
    const F=simFrameViews(buf,cap), nn=Math.min(tick.n,got);
    let changed=!last || last.length !== cap;
    if (!last || last.length !== cap) last=sharedArray(Int32Array,cap,-1);
    ensureState(cap,!!tick.history);
    {const dk=lastBuiltTick>=0 ? Math.max(1,Math.min(16,tick.tick-lastBuiltTick)) : 1;visFollow=1-Math.pow(1-VIS_FOLLOW,dk);visTurn=1-Math.pow(1-VIS_TURN,dk);faceVel=1-Math.pow(1-FACE_VEL,dk);lastBuiltTick=tick.tick;}
    if (tick.lightRange>0) lightFull=tick.lightRange;
    // (The metadata: copied when this buffer's is older, fillRange.)
    let metaCopy=true;
    {
        const rev=metaRev ? Atomics.load(metaRev,0) : -2, e=filling;
        metaCopy=!e || e.metaRev!==rev || rev===-2 || e.metaN<nn;
        if (metaCopy && e) {e.metaRev=rev;e.metaN=nn;}
    }
    // Ghosts and marks in the ranges, but for ghosts from a grid the
    // helpers do not share (then both here after them).
    const G=tick.history ? ghostSight(tick) : null, gShared=!G || G.light.buffer instanceof SharedArrayBuffer;
    const D=dirtyBegin(F,tick.n);
    // By changes (fillRange): from PRESENT_DELTA_MIN slots, this buffer built
    // before at this size, the last frame another buffer, no ghosts.
    const e=filling, bseq=e && e.cap===cap && e.seq>0 ? e.seq : 0;
    const delta=nn>=PRESENT_DELTA_MIN && !G && !!D.prev && bseq>0 && D.prev.cap===cap;
    const J={n:tick.n,nn,player:tick.player,areaUnit:tick.areaUnit,metaCopy,ghosts:gShared ? G : null,marks:gShared && !!D.prev,pn:D.pn,seq:D.seq,nb:D.nb,
        delta,bseq,K:PRESENT_DELTA_ROUNDS,phase:D.seq%PRESENT_DELTA_ROUNDS,msrc:motSrc,ta:dirty.prevTick};
    const count=runRanges(J,F,D.prev);
    if (count<0) {release(buf);dirty.prev=null;if (filling) {filling.metaRev=-1;filling.seq=0;}return;}
    if (e) {e.seq=D.seq;e.cap=cap;}
    // (The snapshot rewritten while the ranges copied it: positions of two
    // ticks in this frame, a glitch of a frame; counted.)
    if (motSrc && motHead && Atomics.load(motHead,0)!==motTick) torn++;
    if (fillChanged) changed=true;
    if (!gShared) {
        applyGhosts(F,0,nn,G);
        if (D.prev) markDirtyRange(F,D.prev,tick.n,D.pn,0,Math.ceil(tick.n/DIRTY_BLOCK),D.seq,dirty.stamps,D.nb);
    }
    const t2=performance.now();
    if(changed) membership++;
    // Stable simulation identity order even after authoritative slot reuse:
    // by id (a native numeric sort of id * 2^21 + slot, not a comparator
    // over 200k slots).
    const FORD=F.order, FID=F.id;
    if(changed || !lastOrder || lastOrder.length!==count) {
        const keys=new Float64Array(count);
        for (let k=0;k<count;k++) {const sl=FORD[k];keys[k]=FID[sl]*2097152+sl;}
        keys.sort();
        for (let k=0;k<count;k++) FORD[k]=keys[k]%2097152;
        lastOrder=FORD.slice(0,count);
    } else FORD.set(lastOrder);
    const t3=performance.now();
    const world={units:{buf,cap,n:tick.n,count,mver:membership},strings:[0,strings]};
    if (indexBytes) world.units.renderBuckets = buildRenderBuckets(F, count, columns, rows, tick.tile || 32);
    world.units.dirty = dirtyEnd(F, tick.n, cap * SIM_FRAME_SLOT_BYTES + indexBytes, D.seq, tick.tick);
    if(structure && structureRevision!==sentStructureRevision) {
        const b=acquire(structure.buf.byteLength,'structures');
        if(b) {new Uint8Array(b,0,structure.buf.byteLength).set(new Uint8Array(structure.buf));world.structures={...structure,buf:b};sentStructureRevision=structureRevision;}
    }
    if(projectiles && projectileRevision!==sentProjectileRevision) {
        const b=acquire(projectiles.buf.byteLength,'projectiles');
        if(b) {new Uint8Array(b,0,projectiles.buf.byteLength).set(new Uint8Array(projectiles.buf));world.projectiles={...projectiles,buf:b};sentProjectileRevision=projectileRevision;}
    }
    if(cells) {
        const delta=[];
        if(!oldCells || oldCells.length!==cells.length) oldCells=new Int32Array(cells.length).fill(-2147483648);
        for(let i=0;i<cells.length;i+=2) if(cells[i]!==oldCells[i] || cells[i+1]!==oldCells[i+1]) {
            oldCells[i]=cells[i];oldCells[i+1]=cells[i+1];delta.push(i/2,oldCells[i],oldCells[i+1]);
        }
        if(delta.length) world.state={cells:delta};
        cells=null;
    }
    const t4=performance.now();
    // (phases: the motion copy, the ranges (fill, ghosts, marks), the order,
    // the rest; then how many threads made the ranges, and the pace.)
    (out || self).postMessage({type:'presentation',epoch,tick:tick.tick,world,buildMs:t4-started,torn,phases:[t1-t0,t2-t1,t3-t2,t4-t3,rangeThreads,pacing.pace,lastFilled,lastStamped?1:0]});
    schedule();
}
function onMessage(event) {
    const m=event.data;
    try {
        if(m.type==='port') {out=m.port;out.onmessage=onMessage;return;}
        if(m.type==='snaps') {
            snapCtl=m.ctl;
            // (Views into the simulation's wasm heap, or buffers of their own.)
            snaps=m.snaps ? m.snaps : m.bufs.map(buf=>({head:new Int32Array(buf,0,2),x:new Int32Array(buf,8,m.cap),y:new Int32Array(buf,8+m.cap*4,m.cap),px:new Int32Array(buf,8+m.cap*8,m.cap),py:new Int32Array(buf,8+m.cap*12,m.cap)}));
            return;
        }
        // A tick's end: its frame at once (no timer between: the copy must
        // be taken before the next tick starts).
        if(m.type==='tick') {
            // (The fog first: cheap, and the frame's ghosts read the same tick.)
            if (m.fog) {try {updateFog(m);} catch(err) {postMessage({type:'error',message:String(err.stack || err)});}}
            if (!paceDue(m)) return;
            latest=m;if(!scheduled && source && ready) {scheduled=true;draw();}return;
        }
        if(m.type==='bind') {bindVersion++;epoch=m.epoch;generation=m.generation;source=m.columns;meta=simMetaViews(m.meta.buf,m.meta.cap);metaRev=m.metaRev||null;for(const e of buffers.values()) e.metaRev=-1;last=null;lastBuiltTick=-1;buildRenderBuckets.previous=null;schedule();}
        else if(m.type==='strings') strings=m.strings;
        else if(m.type==='ready') {ready=true;schedule();}
        else if(m.type==='structures') {structure=m.table;structureRevision=m.revision;}
        else if(m.type==='projectiles') {projectiles=m.table;projectileRevision=m.revision;}
        else if(m.type==='cellBaseline') oldCells=m.cells.slice();
        else if(m.type==='cells') cells=m.cells;
        else if(m.type==='release') {release(m.buf);if(snapCtl)Atomics.store(snapCtl,1,1);schedule();}
    } catch(err) {postMessage({type:'error',message:String(err.stack || err)});}
}
self.onmessage=HELPER ? onHelperMessage : onMessage;
if (HELPER) postMessage({type:'helperReady'});
