"use strict";
importScripts('sim_frame.js?v=20261008-brain1','sim_frame_world.js?v=20261021-x');
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
function copyMotion(C,n,want) {
    const i=snapCtl ? Atomics.load(snapCtl,0) : -1, q=i>=0 && snaps ? snaps[i] : null;
    const src=q ? [['x',q.x],['y',q.y],['px',q.px],['py',q.py],['vx',C.vx],['vy',C.vy]] : [['x',C.x],['y',C.y],['px',C.prevX],['py',C.prevY],['vx',C.vx],['vy',C.vy]];
    const tick=q ? Atomics.load(q.head,0) : 0;
    if (q && tick<0) return -2;
    if (snapCtl) Atomics.store(snapCtl,1,1);
    if (q && tick<want) return -3;
    for (const [k,a] of src) {
        if (!mot[k] || mot[k].length<a.length) mot[k]=new Float32Array(a.length);
        // (Positions are Int32 eighths of a pixel: scaled here.)
        if (a instanceof Int32Array) {const D=mot[k], e=Math.min(n,a.length); for (let s=0;s<e;s++) D[s]=a[s]*.125;}
        else mot[k].set(n<a.length ? a.subarray(0,n) : a);
    }
    // (Rewritten while copied: dropped.)
    if (q && Atomics.load(q.head,0)!==tick) return -2;
    return q ? Math.min(n,q.head[1]) : n;
}
function release(buf) {const t=new DataView(buf,buf.byteLength-12);if(t.getInt32(0,true)!==generation)return;const e=buffers.get(t.getInt32(4,true));if(e)e.busy=false;}
function acquire(bytes, kind='units') {
    for (const entry of buffers.values()) if (entry.kind===kind && !entry.busy && entry.buf.byteLength >= bytes+12) {entry.busy=true;filling=entry;return entry.buf;}
    // Three page-owned snapshots maximum. No growing queue when rendering stops.
    if ([...buffers.values()].filter(e=>e.kind===kind && e.busy).length >= 3) return null;
    for (const [id,e] of buffers) if (e.kind===kind && !e.busy) buffers.delete(id);
    const buf=new SharedArrayBuffer(bytes+12), id=++sequence;
    const trailer=new DataView(buf,buf.byteLength-12);trailer.setInt32(0,generation,true);trailer.setInt32(4,id,true);trailer.setInt32(8,PRESENT_MAGIC,true);
    filling={buf,busy:true,kind,metaRev:-1,metaN:0};buffers.set(id,filling);return buf;
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
// Facing (presentation only: the simulation keeps none): toward the unit's
// fire target (the combat brain's, cmMode bit 4) when it has one, else its
// movement, else as it was; turning VIS_TURN of the way a frame, so a few
// ticks' change of mind is not a snap.
const face={a:null,id:null}, VIS_TURN=.3, TAU=Math.PI*2;
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
    if (!vis.x || vis.x.length<F.x.length) {const c=F.x.length;vis.x=new Float32Array(c);vis.y=new Float32Array(c);vis.id=new Int32Array(c).fill(-1);}
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
    // Metadata (the pump's table, the frame's own layout): copied whole, when
    // it changed since this buffer last had it (or covers more slots now).
    {
        const rev=metaRev ? Atomics.load(metaRev,0) : -2, e=filling;
        if (!e || e.metaRev!==rev || rev===-2 || e.metaN<n) {for (const k of META_COPY) F[k].set(meta[k].subarray(0,n)); if (e) {e.metaRev=rev;e.metaN=n;}}
    }
    {const D=F.owner,S=C.owner;for(let s=0;s<n;s++) D[s]=S[s];}
    {const D=F.energy,S=C.energy;for(let s=0;s<n;s++) D[s]=S[s];}
    {const D=F.r,S=C.r;for(let s=0;s<n;s++) D[s]=S[s];}
    {const D=F.cmd,S=C.commandState;for(let s=0;s<n;s++) D[s]=S[s];}
    // (Levels into int16: as integers, -1 when not a number.)
    {const D=F.level,S=C.effectiveLevel;for(let s=0;s<n;s++) {const v=S[s];D[s]=v>=0 && v<32767 ? v|0 : -1;}}
    {const D=F.blevel,S=C.unitLevel;for(let s=0;s<n;s++) {const v=S[s];D[s]=v>=0 && v<32767 ? v|0 : -1;}}
    {const D=F.flash,S=C.attackFlash;for(let s=0;s<n;s++) {const v=S[s];D[s]=v>255?255:v>0?v:0;}}
    {
        // (The status timers only of units with one running, stOn: the
        // rest read one byte instead of seven columns.)
        const D=F.flags, M=meta.flags, B=C.burning, P=C.poisoned, Z=C.frozen, W=C.wet, Y=C.sandy, V=C.watched, H=C.teleportHideTicks, T=C.workerTransferCooldown, ON=C.stOn;
        for (let s=0;s<n;s++) D[s]=M[s] | (T[s]>0?SIM_UF_TRANSFER:0) | (ON && !ON[s] ? 0 : (B[s]>0?SIM_UF_BURNING:0) | (P[s]>0?SIM_UF_POISONED:0) | (Z[s]>0?SIM_UF_FROZEN:0) | (W[s]>0?SIM_UF_WET:0)
            | (Y[s]>0?SIM_UF_SANDY:0) | (V[s]>0?SIM_UF_WATCHED:0) | (H[s]>0?SIM_UF_HIDDEN:0));
    }
    {
        const D=F.light, O=F.owner, V=C.watched, WB=F.watchedBy, VIS=F.vision, ON=C.stOn;
        for (let s=0;s<n;s++) D[s]=O[s]===player || ((!ON || ON[s]) && V[s]>0 && WB[s]===player) ? VIS[s]*areaUnit : 0;
    }
    {
        const X=F.x, Y=F.y, PX=F.px, PY=F.py, FL=F.flash, MO=F.mode, ST=F.status, AM=F.amount;
        for (let s=0;s<n;s++) {
            const dx=X[s]-PX[s], dy=Y[s]-PY[s], moving=dx*dx+dy*dy>.0001, flash=FL[s]>0;
            MO[s]=flash?1:moving?0:7;ST[s]=flash?1:moving?0:3;AM[s]=moving || flash ? 1 : .7;
        }
    }
    {
        if (!face.a || face.a.length<F.x.length) {const c=F.x.length;face.a=new Float32Array(c);face.id=new Int32Array(c).fill(-1);}
        const D=F.facing, VX=F.vx, VY=F.vy, CM=C.cmMode, CT=C.cmT, SX=mot.x, SY=mot.y, FA=face.a, FI=face.id;
        for (let s=0;s<n;s++) {
            const id=FID[s];
            if (id<0) {FI[s]=-1;continue;}
            let want=NaN;
            if (CM && (CM[s]&4)) {const q=CT[s];if (q>=0 && q<n) {const dx=SX[q]-SX[s], dy=SY[q]-SY[s];if (dx || dy) want=Math.atan2(dx,dy);}}
            if (want!==want) {const vx=VX[s], vy=VY[s];if (vx*vx+vy*vy>1e-6) want=Math.atan2(vx,vy);}
            let f=FI[s]===id ? FA[s] : (want===want ? want : 0);
            if (want===want) {let d=want-f;d-=Math.round(d/TAU)*TAU;f+=d*VIS_TURN;}
            FA[s]=f;FI[s]=id;D[s]=f;
        }
    }
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
// Team + history: what the player does not see now is drawn as it was
// last seen, frozen until its tile is seen again (the same as full
// visibility, but for the frozen ones outside the seen tiles). Per slot its
// unit's last seen position (while its tile was seen); a unit not seen now
// is drawn there (SIM_UF_GHOST) while that place is unseen, else hidden.
// One pass a tick here, nothing per unit on the page. (A unit that dies or
// whose slot is reused unseen loses its ghost: rare, harmless.)
const ghost={x:null,y:null,id:null};
function applyGhosts(F,n,T) {
    // (Seen = the fog's eased light, as the page and the GPU see it: the raw
    // sight flickers at vision's edges, units there went live, ghost, live.)
    const gw=T.gw|0, gh=T.gh|0, tile=T.tile||32, it=1/tile, player=T.player;
    const S=fogState.light && fogState.w===gw && fogState.h===gh ? fogState.light : T.sight;
    if (!S || S.length<gw*gh) return;
    if (!ghost.x || ghost.x.length<F.x.length) {const c=F.x.length;ghost.x=new Float32Array(c);ghost.y=new Float32Array(c);ghost.id=new Int32Array(c).fill(-1);}
    const GX=ghost.x, GY=ghost.y, GI=ghost.id, FID=F.id, X=F.x, Y=F.y, PX=F.px, PY=F.py, FL=F.flags, OWN=F.owner;
    for (let s=0;s<n;s++) {
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
const META_COPY=['type','wtype','wstate','style','watchedBy','vision','maxEnergy','cargo','tx','ty'];
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
function draw() {
    const started=performance.now();
    scheduled=false;
    const tick=latest;
    if (!tick || !source) return;
    const cap=source.id.length;
    const columns = tick.n >= 5000 && tick.gw > 0 ? Math.ceil(tick.gw / 16) : 0;
    const rows = columns ? Math.ceil(tick.gh / 16) : 0;
    const indexBytes = columns * rows ? columns * rows * 8 + cap * 8 : 0;
    const buf=acquire(cap*SIM_FRAME_SLOT_BYTES + indexBytes);
    if (!buf) return;
    latest=null;
    const C=source;
    const t0=performance.now();
    const got=copyMotion(C,tick.n,tick.tick);
    const t1=performance.now();
    if (got===-3) {release(buf);return;}
    if (got<0) {torn++;release(buf);return;}
    const F=simFrameViews(buf,cap);
    let changed=!last || last.length !== cap;
    if (!last || last.length !== cap) last=new Int32Array(cap).fill(-1);
    const count=fillUnits(F,C,meta,Math.min(tick.n,got),tick.player,tick.areaUnit,tick.time/tick.rate*10,10/tick.rate);
    if (fillChanged) changed=true;
    if (tick.history) applyGhosts(F,Math.min(tick.n,got),tick);
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
            snaps=m.bufs.map(buf=>({head:new Int32Array(buf,0,2),x:new Int32Array(buf,8,m.cap),y:new Int32Array(buf,8+m.cap*4,m.cap),px:new Int32Array(buf,8+m.cap*8,m.cap),py:new Int32Array(buf,8+m.cap*12,m.cap)}));
            return;
        }
        // A tick's end: its frame at once (no timer between: the copy must
        // be taken before the next tick starts).
        if(m.type==='tick') {
            // (The fog first: cheap, and the frame's ghosts read the same tick.)
            if (m.fog) {try {updateFog(m);} catch(err) {postMessage({type:'error',message:String(err.stack || err)});}}
            latest=m;if(!scheduled && source && ready) {scheduled=true;draw();}return;
        }
        if(m.type==='bind') {epoch=m.epoch;generation=m.generation;source=m.columns;meta=simFrameViews(m.meta.buf,m.meta.cap);metaRev=m.metaRev||null;for(const e of buffers.values()) e.metaRev=-1;last=null;buildRenderBuckets.previous=null;schedule();}
        else if(m.type==='strings') strings=m.strings;
        else if(m.type==='ready') {ready=true;schedule();}
        else if(m.type==='structures') {structure=m.table;structureRevision=m.revision;}
        else if(m.type==='projectiles') {projectiles=m.table;projectileRevision=m.revision;}
        else if(m.type==='cellBaseline') oldCells=m.cells.slice();
        else if(m.type==='cells') cells=m.cells;
        else if(m.type==='release') {release(m.buf);if(snapCtl)Atomics.store(snapCtl,1,1);schedule();}
    } catch(err) {postMessage({type:'error',message:String(err.stack || err)});}
}
self.onmessage=onMessage;
