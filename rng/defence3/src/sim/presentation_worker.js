"use strict";
importScripts('sim_frame.js?v=20261004-stream','sim_frame_world.js?v=20261021-x');
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
const mot={x:null,y:null,px:null,py:null,vx:null,vy:null};
function copyMotion(C,n) {
    const i=snapCtl ? Atomics.load(snapCtl,0) : -1, q=i>=0 && snaps ? snaps[i] : null;
    const src=q ? [['x',q.x],['y',q.y],['px',q.px],['py',q.py],['vx',C.vx],['vy',C.vy]] : [['x',C.x],['y',C.y],['px',C.prevX],['py',C.prevY],['vx',C.vx],['vy',C.vy]];
    const tick=q ? Atomics.load(q.head,0) : 0;
    if (q && tick<0) return -2;
    for (const [k,a] of src) {
        if (!mot[k] || mot[k].length<a.length) mot[k]=new Float64Array(a.length);
        mot[k].set(n<a.length ? a.subarray(0,n) : a);
    }
    // (Rewritten while copied: dropped.)
    if (q && Atomics.load(q.head,0)!==tick) return -2;
    return q ? Math.min(n,q.head[1]) : n;
}
function release(buf) {const t=new DataView(buf,buf.byteLength-12);if(t.getInt32(0,true)!==generation)return;const e=buffers.get(t.getInt32(4,true));if(e)e.busy=false;}
function acquire(bytes, kind='units') {
    for (const entry of buffers.values()) if (entry.kind===kind && !entry.busy && entry.buf.byteLength >= bytes+12) {entry.busy=true;return entry.buf;}
    // Three page-owned snapshots maximum. No growing queue when rendering stops.
    if ([...buffers.values()].filter(e=>e.kind===kind && e.busy).length >= 3) return null;
    for (const [id,e] of buffers) if (e.kind===kind && !e.busy) buffers.delete(id);
    const buf=new SharedArrayBuffer(bytes+12), id=++sequence;
    const trailer=new DataView(buf,buf.byteLength-12);trailer.setInt32(0,generation,true);trailer.setInt32(4,id,true);trailer.setInt32(8,PRESENT_MAGIC,true);
    buffers.set(id,{buf,busy:true,kind});return buf;
}
function schedule() {
    if (scheduled || !latest || !source || !ready) return;
    scheduled=true;setTimeout(draw,0);
}
// Every unit's slot of a frame from the columns and this worker's motion
// copy; the count listed (F.order). fillChanged: a slot's unit changed.
// Column by column: each loop reads one or two columns and writes one
// (memcpy for the metadata, which has the frame's layout), ~10x faster than
// one loop writing all ~30 columns of a unit (~60 ms a frame at 200k units,
// so frames reached the page a few times a second: units stood, then
// jumped). Slots not listed (FID -1) are not read, whatever they hold.
// (Its own function: as a long loop inside draw() it was compiled on the
// stack before draw's later code had run, and fell back to the interpreter
// at its end every frame.)
let fillChanged=false;
// The drawn positions per slot (and whose they are), VIS_FOLLOW: the share
// of the way to the simulation's position a drawn unit goes each tick (a
// steady lag of about two steps behind it, a third of its step's
// variation: smooth before prompt, the user's choice); VIS_SNAP:
// a gap past which it is drawn at the simulation's position at once.
const vis={x:null,y:null,id:null}, VIS_FOLLOW=.35, VIS_SNAP=64;
function fillUnits(F,C,meta,n,player,areaUnit,phase0,prate) {
    let count=0, changed=false;
    const L=last, FID=F.id, FORD=F.order, CID=C.id, CLIVE=C.live, CDEAD=C.dead, MID=meta.id;
    for (let s=0;s<n;s++) {
        const id=CID[s];
        if (!CLIVE[s] || CDEAD[s] || MID[s] !== id) {FID[s]=-1;if(L[s]!==-1) {changed=true;L[s]=-1;}continue;}
        FID[s]=id;FORD[count++]=s;
        if(L[s]!==id) {changed=true;L[s]=id;}
    }
    // Motion, smoothed for the eye (this worker's own state, never the
    // simulation's): each unit is drawn moving from where it was drawn last
    // tick toward VIS_FOLLOW of the way to where the simulation has it. A
    // tick's step varies with the pushes of a crowd (1.9, 3.9, 2.1 px...);
    // drawn as is, units sped up and stalled tick to tick. A unit new to its
    // slot, or one that jumped (over VIS_SNAP px: a teleport, a resync)
    // starts where the simulation has it.
    if (!vis.x || vis.x.length<F.x.length) {const c=F.x.length;vis.x=new Float64Array(c);vis.y=new Float64Array(c);vis.id=new Int32Array(c).fill(-1);}
    {
        const DX=F.x, DY=F.y, DPX=F.px, DPY=F.py, SX=mot.x, SY=mot.y, SPX=mot.px, SPY=mot.py, VX=vis.x, VY=vis.y, VI=vis.id;
        for (let s=0;s<n;s++) {
            const id=FID[s];
            if (id<0) {VI[s]=-1;continue;}
            const x=SX[s], y=SY[s];
            const ox=VX[s], oy=VY[s];
            if (VI[s]!==id || Math.abs(x-ox)+Math.abs(y-oy)>VIS_SNAP) {DPX[s]=SPX[s];DPY[s]=SPY[s];DX[s]=x;DY[s]=y;VX[s]=x;VY[s]=y;VI[s]=id;continue;}
            const nx=ox+(x-ox)*VIS_FOLLOW, ny=oy+(y-oy)*VIS_FOLLOW;
            DPX[s]=ox;DPY[s]=oy;DX[s]=nx;DY[s]=ny;VX[s]=nx;VY[s]=ny;
        }
    }
    {const D=F.vx,S=mot.vx;for(let s=0;s<n;s++) D[s]=S[s];}
    {const D=F.vy,S=mot.vy;for(let s=0;s<n;s++) D[s]=S[s];}
    // Metadata (the pump's table, the frame's own layout): copied whole.
    for (const k of META_COPY) F[k].set(meta[k].subarray(0,n));
    {const D=F.owner,S=C.owner;for(let s=0;s<n;s++) D[s]=S[s];}
    {const D=F.energy,S=C.energy;for(let s=0;s<n;s++) D[s]=S[s];}
    {const D=F.r,S=C.r;for(let s=0;s<n;s++) D[s]=S[s];}
    {const D=F.cmd,S=C.commandState;for(let s=0;s<n;s++) D[s]=S[s];}
    // (Levels into int16: as integers, -1 when not a number.)
    {const D=F.level,S=C.effectiveLevel;for(let s=0;s<n;s++) {const v=S[s];D[s]=v>=0 && v<32767 ? v|0 : -1;}}
    {const D=F.blevel,S=C.unitLevel;for(let s=0;s<n;s++) {const v=S[s];D[s]=v>=0 && v<32767 ? v|0 : -1;}}
    {const D=F.flash,S=C.attackFlash;for(let s=0;s<n;s++) {const v=S[s];D[s]=v>255?255:v>0?v:0;}}
    {
        const D=F.flags, M=meta.flags, B=C.burning, P=C.poisoned, Z=C.frozen, W=C.wet, Y=C.sandy, V=C.watched, H=C.teleportHideTicks, T=C.workerTransferCooldown;
        for (let s=0;s<n;s++) D[s]=M[s] | (B[s]>0?SIM_UF_BURNING:0) | (P[s]>0?SIM_UF_POISONED:0) | (Z[s]>0?SIM_UF_FROZEN:0) | (W[s]>0?SIM_UF_WET:0)
            | (Y[s]>0?SIM_UF_SANDY:0) | (V[s]>0?SIM_UF_WATCHED:0) | (H[s]>0?SIM_UF_HIDDEN:0) | (T[s]>0?SIM_UF_TRANSFER:0);
    }
    {
        const D=F.light, O=F.owner, V=C.watched, WB=F.watchedBy, VIS=F.vision;
        for (let s=0;s<n;s++) D[s]=O[s]===player || (V[s]>0 && WB[s]===player) ? VIS[s]*areaUnit : 0;
    }
    {
        const X=F.x, Y=F.y, PX=F.px, PY=F.py, FL=F.flash, MO=F.mode, ST=F.status, AM=F.amount;
        for (let s=0;s<n;s++) {
            const dx=X[s]-PX[s], dy=Y[s]-PY[s], moving=dx*dx+dy*dy>.0001, flash=FL[s]>0;
            MO[s]=flash?1:moving?0:7;ST[s]=flash?1:moving?0:3;AM[s]=moving || flash ? 1 : .7;
        }
    }
    {const D=F.facing,VX=F.vx,VY=F.vy;for(let s=0;s<n;s++) D[s]=Math.atan2(VX[s],VY[s] || .0001);}
    {const D=F.phase,I=F.id;for(let s=0;s<n;s++) D[s]=phase0+I[s]*2.399;}
    F.prate.fill(prate,0,n);F.sig.fill(0,0,n);
    // The simulation may recycle a slot during the scan: dropped rather than
    // shown with the old unit's metadata at the new one's place.
    for (let k=0;k<count;k++) {
        const s=FORD[k], id=FID[s];
        if (CID[s]!==id || MID[s]!==id || CDEAD[s]) {FID[s]=-1;L[s]=-1;changed=true;}
    }
    if (changed) {let j=0;for(let k=0;k<count;k++) {const s=FORD[k];if(FID[s]>=0) FORD[j++]=s;}count=j;}
    fillChanged=changed;
    return count;
}
// The metadata columns copied whole each frame (the pump writes them).
const META_COPY=['type','wtype','wstate','style','watchedBy','vision','maxEnergy','cargo','tx','ty'];
function draw() {
    const started=performance.now();
    scheduled=false;
    const tick=latest;
    if (!tick || !source) return;
    const cap=source.id.length, buf=acquire(cap*SIM_FRAME_SLOT_BYTES);
    if (!buf) return;
    latest=null;
    const C=source;
    const t0=performance.now();
    const got=copyMotion(C,tick.n);
    const t1=performance.now();
    if (got<0) {torn++;release(buf);return;}
    const F=simFrameViews(buf,cap);
    let changed=!last || last.length !== cap;
    if (!last || last.length !== cap) last=new Int32Array(cap).fill(-1);
    const count=fillUnits(F,C,meta,Math.min(tick.n,got),tick.player,tick.areaUnit,tick.time/tick.rate*10,10/tick.rate);
    if (fillChanged) changed=true;
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
    (out || self).postMessage({type:'presentation',epoch,tick:tick.tick,world,buildMs:t4-started,torn,phases:[t1-t0,t2-t1,t3-t2,t4-t3]});
    schedule();
}
function onMessage(event) {
    const m=event.data;
    try {
        if(m.type==='port') {out=m.port;out.onmessage=onMessage;return;}
        if(m.type==='snaps') {
            snapCtl=m.ctl;
            snaps=m.bufs.map(buf=>({head:new Int32Array(buf,0,2),x:new Float64Array(buf,8,m.cap),y:new Float64Array(buf,8+m.cap*8,m.cap),px:new Float64Array(buf,8+m.cap*16,m.cap),py:new Float64Array(buf,8+m.cap*24,m.cap)}));
            return;
        }
        // A tick's end: its frame at once (no timer between: the copy must
        // be taken before the next tick starts).
        if(m.type==='tick') {latest=m;if(!scheduled && source && ready) {scheduled=true;draw();}return;}
        if(m.type==='bind') {epoch=m.epoch;generation=m.generation;source=m.columns;meta=simFrameViews(m.meta.buf,m.meta.cap);last=null;schedule();}
        else if(m.type==='strings') strings=m.strings;
        else if(m.type==='ready') {ready=true;schedule();}
        else if(m.type==='structures') {structure=m.table;structureRevision=m.revision;}
        else if(m.type==='projectiles') {projectiles=m.table;projectileRevision=m.revision;}
        else if(m.type==='cellBaseline') oldCells=m.cells.slice();
        else if(m.type==='cells') cells=m.cells;
        else if(m.type==='release') {release(m.buf);schedule();}
    } catch(err) {postMessage({type:'error',message:String(err.stack || err)});}
}
self.onmessage=onMessage;
