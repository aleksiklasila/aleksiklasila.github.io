"use strict";
importScripts('sim_frame.js?v=20261025-st1','sim_frame_world.js?v=20261025-st1','pres_wasm_bin.js?v=20261111-pm');
const PRESENT_MAGIC=0x50524553;
let source=null, meta=null, epoch=0, generation=0, latest=null, scheduled=false, strings=[''], ready=false;
let structure=null, structureRevision=-1, sentStructureRevision=-1, cells=null, cellBaseline=null;
let projectiles=null, projectileRevision=-1, sentProjectileRevision=-1;
let membership=0, sequence=0;
const buffers=new Map();
// out: the page's channel (frames out, buffers back). snaps: the
// simulation's per-tick position snapshots (sim_presentation.js
// simPresentTickEnd, in its heap), the newest at snapCtl[0].
let out=null, snapCtl=null, snaps=null, torn=0;
// The simulation's metadata revision (sim_presentation.js simPresentationBind)
// and the buffer being filled (its entry: the revision its metadata holds).
let metaRev=null, filling=null;

// ---- this worker's wasm (wasm/src/pres.rs, pres_fill.rs; wasm/build.cjs --pres) ----
// Two memories. Memory 0 is this worker's own: the unit frames (regions of
// it), the per-slot state (last ids, drawn positions, facings, ghosts, when
// each slot was filled, the change marks), the fog's grids, the kernels'
// scratch and tables of addresses. Memory 1 is the simulation's heap (sent
// with 'bind'), read in place: its unit columns, the presentation metadata,
// the position snapshots, the sight and cell grids. Nothing is copied from
// it and no slot is touched in JS: each frame is one kernel call a range
// (fill, ghosts, change marks), then the id order and the camera's buckets.
// A frame goes out as {buf: the memory's buffer, base, rid, gen} and comes
// back by its region id (release). Regions are kept and reused (first fit);
// the memory never shrinks.
const pm={mod:null,mem:null,sim:null,x:null,args:0,top:0,free:[],I:null,P:null,
    cap:-1,scratch:0,prevX:0,prevY:0,out:0,prevReady:false,regions:{},
    st:null,S:0,Sv:null,M:0,hasPvAt:false,hasCm:false,hasPvOD:false,main:null,cells:null};
function pmDecode(b64) {
    const T=new Uint8Array(128), A='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (let i=0;i<64;i++) T[A.charCodeAt(i)]=i;
    let n=b64.length;
    while (n>0 && b64.charCodeAt(n-1)===61) n--;
    const o8=new Uint8Array((n*3)>>2);
    let o=0, acc=0, bits=0;
    for (let i=0;i<n;i++) {acc=(acc<<6)|T[b64.charCodeAt(i)];bits+=6;if (bits>=8) {bits-=8;o8[o++]=(acc>>bits)&255;acc&=(1<<bits)-1;}}
    return o8;
}
// (pres_fill.rs F_* / M_*: the layouts its tables follow.)
const PM_FRAME_LAYOUT='x,y,px,py,vx,vy,energy,maxEnergy,tx,ty,facing,amount,phase,prate,light,sig,r,cargo|id,flags,orderDest,orderTick|owner,watchedBy,level,blevel,type,wtype,wstate,style|mode,status,flash,cmd,vision';
const PM_META_LAYOUT='id,flags,orderDest,orderTick|maxEnergy,cargo,tx,ty|type,wtype,wstate,style,watchedBy|vision';
// The instance over this worker's memory and the simulation's (again for
// another simulation memory: the helpers then start anew).
function pmInit(simMemory) {
    if (!simMemory || typeof simMemory.grow!=='function') throw new Error('presentation: the simulation\'s wasm memory is needed (bind.simMemory)');
    if (pm.x && pm.sim===simMemory) return;
    if ([SIM_FRAME_F32,SIM_FRAME_I32,SIM_FRAME_I16,SIM_FRAME_U8].map(a=>a.join(',')).join('|')!==PM_FRAME_LAYOUT) throw new Error('presentation: the frame layout is not pres_fill.rs F_*');
    if ([SIM_META_I32,SIM_META_F32,SIM_META_I16,SIM_META_U8].map(a=>a.join(',')).join('|')!==PM_META_LAYOUT) throw new Error('presentation: the metadata layout is not pres_fill.rs M_*');
    if (!pm.mod) pm.mod=new WebAssembly.Module(pmDecode(PRES_WASM_BIN));
    if (!pm.mem) pm.mem=new WebAssembly.Memory({initial:256,maximum:65536,shared:true});
    pm.x=new WebAssembly.Instance(pm.mod,{env:{memory:pm.mem,simMemory}}).exports;pm.sim=simMemory;pm.steps=rangeSteps(pm.x);
    if (!pm.args) {
        pm.args=Math.ceil(Number(pm.x.__heap_base.value)/64)*64;pm.top=pm.args+8192;
        pm.I=new Int32Array(pm.mem.buffer,pm.args,1024);pm.P=new Float64Array(pm.mem.buffer,pm.args+4096,512);
        pm.main={args:pm.args,I:pm.I,P:pm.P,AL:0,CL:0,BK:0,len:-1};
    }
    restartHelpers();
}
// A region of at least bytes (64-aligned): a free one that fits, else new at
// the top. (A cache line more than asked: arrays of a power-of-two size, one
// after another, would start at whole multiples of it, all in the same cache
// sets: a pass reading several of them evicted itself, sim_frame.js simFrameViews.)
function pmAlloc(bytes) {
    bytes=Math.ceil(Math.max(1,bytes)/64)*64+64;
    for (let i=0;i<pm.free.length;i++) if (pm.free[i].size>=bytes) {const r=pm.free[i];pm.free.splice(i,1);return r;}
    const at=pm.top;pm.top+=bytes;
    const have=pm.mem.buffer.byteLength;
    if (pm.top>have) pm.mem.grow(Math.ceil((pm.top-have)/65536));
    return {base:at,size:bytes};
}
function pmFree(r) {if (r && r.size>0) pm.free.push(r);}
// A named region of at least bytes (kept while it is big enough).
function pmRegion(name,bytes) {
    let r=pm.regions[name];
    if (r && r.size>=bytes) return r;
    if (r) pmFree(r);
    return pm.regions[name]=pmAlloc(bytes);
}
// A thread's fill lists for ranges of up to len slots.
function pmThreadScratch(th,len) {
    if (th.len>=len) return;
    for (const k of ['ALR','CLR','BKR']) if (th[k]) pmFree(th[k]);
    th.ALR=pmAlloc(4*len);th.CLR=pmAlloc(4*len);th.BKR=pmAlloc(Math.ceil(len/DIRTY_BLOCK)+2);
    th.AL=th.ALR.base;th.CL=th.CLR.base;th.BK=th.BKR.base;th.len=len;
}
// The order's and buckets' state for frames of cap slots (pres.rs).
// (scratch: the order's, 3 words a slot; lastSlots: the last frame's order, lastN of it.)
function pmState(cap) {
    if (pm.cap===cap) return;
    for (const k of ['scratch','prevX','prevY','out','lastSlots']) if (pm[k]) pmFree(pm[k+'R']);
    const take=(k,bytes) => {const r=pmAlloc(bytes);pm[k+'R']=r;pm[k]=r.base;};
    take('scratch',12*cap);take('prevX',4*cap);take('prevY',4*cap);take('out',64);take('lastSlots',4*cap);
    pm.cap=cap;pm.prevReady=false;pm.lastN=0;pm.lastView=null;
}
// The per-slot state for cap slots (pres_fill.rs T_*): its table, views of
// each column and of the stamps (the change marks). True when made anew.
const PM_STATE=[['last',Int32Array,-1],['vx',Float32Array,0],['vy',Float32Array,0],['vid',Int32Array,-1],['fa',Float32Array,0],['fid',Int32Array,-1],
    ['fvx',Float32Array,0],['fvy',Float32Array,0],['full',Int32Array,0],['ease',Uint8Array,0],['gx',Float32Array,0],['gy',Float32Array,0],['gid',Int32Array,-1]];
function pmStateFor(cap) {
    const old=pm.st;
    if (old && old.cap===cap) return false;
    const st={cap,regions:[],T:0,views:{},stamps:null}, nb=Math.ceil(cap/DIRTY_BLOCK);
    const tab=pmAlloc(64);st.regions.push(tab);st.T=tab.base;
    const T=new Int32Array(pm.mem.buffer,tab.base,16);
    PM_STATE.forEach(([k,A,fill],i) => {
        const r=pmAlloc(cap*A.BYTES_PER_ELEMENT);st.regions.push(r);T[i]=r.base;
        const v=st.views[k]=new A(pm.mem.buffer,r.base,cap);
        // (The drawn places and facings carried over from a smaller state.)
        const keep=old ? Math.min(cap,old.cap) : 0;
        if (keep) v.set(old.views[k].subarray(0,keep));
        v.fill(fill,keep);
    });
    const sr=pmAlloc(DIRTY_COLS.length*nb*4);st.regions.push(sr);T[13]=sr.base;
    st.stamps=new Int32Array(pm.mem.buffer,sr.base,DIRTY_COLS.length*nb);
    st.views.last.fill(-1);
    if (old) for (const r of old.regions) pmFree(r);
    pm.st=st;
    dirty.cap=-1;
    return true;
}
// The simulation's columns and metadata (pres_fill.rs S_*, M_*): their
// addresses in its memory, of the types the kernels read them as.
const PM_SOURCE=[['id','Int32Array'],['live','Uint8Array'],['dead','Uint8Array'],['pvAt','Int32Array',1],['vx','Float32Array'],['vy','Float32Array'],
    ['attackFlash','Uint8Array'],['stIx','Int32Array'],['workerTransferCooldown','Uint16Array'],['cmMode','Uint8Array',1],['energy','Float32Array'],
    ['owner','Int8Array'],['commandState','Uint8Array'],['pvOD','Int32Array',1],['r','Float32Array'],['effectiveLevel','Int8Array'],['unitLevel','Int8Array'],
    ['cmT','Int32Array',1],['stBu','Uint16Array'],['stPo','Uint16Array'],['stFr','Uint16Array'],['stWe','Uint16Array'],['stSa','Uint16Array'],
    ['stWa','Uint16Array'],['stTh','Uint16Array']];
function pmBindSource(C,M) {
    const tab=pmRegion('S',29*4);pm.S=tab.base;pm.Sv=new Int32Array(pm.mem.buffer,tab.base,29);
    PM_SOURCE.forEach(([k,type,optional],i) => {
        const a=C[k];
        if (!a) {if (!optional) throw new Error('presentation: the column '+k+' is missing');pm.Sv[i]=0;return;}
        if (a.constructor.name!==type) throw new Error('presentation: the column '+k+' is '+a.constructor.name+', not '+type);
        pm.Sv[i]=a.byteOffset;
    });
    pm.hasPvAt=!!C.pvAt;pm.hasCm=!!(C.cmMode && C.cmT);pm.hasPvOD=!!C.pvOD;
    for (const k of ['x','y','prevX','prevY']) if (!C[k] || C[k].constructor.name!=='Int32Array') throw new Error('presentation: the column '+k+' is not Int32 eighths');
    const mt=pmRegion('M',14*4);pm.M=mt.base;
    const Mv=new Int32Array(pm.mem.buffer,mt.base,14), V=simMetaViews(M.buf,M.cap,M.off||0);
    [...SIM_META_I32,...SIM_META_F32,...SIM_META_I16,...SIM_META_U8].forEach((k,i) => {Mv[i]=V[k].byteOffset;});
}
// A unit frame back from the page, by its region id.
function releaseRegion(rid,gen) {if (gen!==generation) return;const e=buffers.get(rid);if (e && e.kind==='units') e.busy=false;}
function release(buf) {const t=new DataView(buf,buf.byteLength-12);if(t.getInt32(0,true)!==generation)return;const e=buffers.get(t.getInt32(4,true));if(e)e.busy=false;}
// A unit frame's region entry ({base, rid, F: its views (F.tab: its
// columns' table)}) for cap slots, or null.
function acquireUnits(bytes,cap) {
    for (const [id,e] of buffers) if (e.kind==='units' && !e.busy && e.size>=bytes && e.cap===cap) {e.busy=true;filling=e;e.rid=id;return e;}
    // Three page-owned snapshots maximum. No growing queue when rendering stops.
    // (Two of a frame of 192 MB or more, ~1.3M units: three were a gigabyte at 2.3M.)
    const most = bytes > (192 << 20) ? 2 : 3;
    let busy=0;
    for (const e of buffers.values()) if (e.kind==='units' && e.busy) busy++;
    if (busy >= most) return null;
    for (const [id,e] of buffers) if (e.kind==='units' && !e.busy) {pmFree(e.r);pmFree(e.tr);buffers.delete(id);}
    const r=pmAlloc(bytes), tr=pmAlloc(4*36), id=++sequence;
    const F=simFrameViews(pm.mem.buffer,cap,r.base), T=new Int32Array(pm.mem.buffer,tr.base,36);
    [...SIM_FRAME_F32,...SIM_FRAME_I32,'order',...SIM_FRAME_I16,...SIM_FRAME_U8].forEach((k,i) => {T[i]=F[k].byteOffset;});
    F.tab=tr.base;
    filling={busy:true,kind:'units',r,tr,base:r.base,size:r.size,cap,F,rid:id,metaRev:-1,metaN:0,seq:0};buffers.set(id,filling);
    return filling;
}
function acquire(bytes, kind) {
    for (const entry of buffers.values()) if (entry.kind===kind && !entry.busy && entry.buf.byteLength >= bytes+12) {entry.busy=true;return entry.buf;}
    let busy=0;
    for (const e of buffers.values()) if (e.kind===kind && e.busy) busy++;
    if (busy >= 3) return null;
    for (const [id,e] of buffers) if (e.kind===kind && !e.busy) buffers.delete(id);
    const buf=new SharedArrayBuffer(bytes+12), id=++sequence;
    const trailer=new DataView(buf,buf.byteLength-12);trailer.setInt32(0,generation,true);trailer.setInt32(4,id,true);trailer.setInt32(8,PRESENT_MAGIC,true);
    buffers.set(id,{buf,busy:true,kind});return buf;
}
function schedule() {
    if (scheduled || !latest || !source || !ready) return;
    scheduled=true;setTimeout(draw,0);
}
const SHARED=typeof SharedArrayBuffer==='function';

// ---- motion ----
// The newest position snapshot (in the simulation's heap): its columns'
// addresses into the source table (pres_fill.rs S_MX..S_MPY), read by the
// ranges in place. The simulation publishes a snapshot only while
// snapCtl[1] is 1 (this worker asks for the next one when it took the
// newest, or found it older than the tick it draws: then it waits for the
// next tick, -3). Without snapshots: the position columns themselves. The
// slots it covers, or -2 (being written).
let motHead=null, motTick=0;
function takeSnapshot(want,n) {
    const i=snapCtl ? Atomics.load(snapCtl,0) : -1, q=i>=0 && snaps ? snaps[i] : null;
    const tick=q ? Atomics.load(q.head,0) : 0;
    if (q && tick<0) return -2;
    if (snapCtl) Atomics.store(snapCtl,1,1);
    if (q && tick<want) return -3;
    const S=pm.Sv;
    S[25]=(q ? q.x : source.x).byteOffset;S[26]=(q ? q.y : source.y).byteOffset;
    S[27]=(q ? q.px : source.prevX).byteOffset;S[28]=(q ? q.py : source.prevY).byteOffset;
    motHead=q ? q.head : null;motTick=tick;
    return q ? Math.min(n,q.head[1]) : n;
}

// The drawn positions per slot: VIS_FOLLOW, the share of the way to the
// simulation's position a drawn unit goes each tick (a steady lag of about
// two steps behind it: smooth before prompt); the rest bounded (VIS_LAG,
// pres_fill.rs). visFollow: the share for the ticks a frame covers.
const VIS_FOLLOW=.35;
let visFollow=VIS_FOLLOW, lastBuiltTick=-1;
// (The fog's full light, VISIBILITY_LIGHT_NORMALIZATION_RANGE: with each tick.)
let lightFull=6;
// Facing (pres_fill.rs): toward the fire target, else the movement smoothed
// over a few ticks (FACE_VEL a tick), else as it was; turning VIS_TURN of
// the way a tick.
const VIS_TURN=.3, FACE_VEL=.3;
let visTurn=VIS_TURN, faceVel=FACE_VEL;

// ---- the fog ----
// The fog's light (each tile's light easing toward what is seen: up at
// T.rise a second, down at T.fall after a second's hold) and the fog's own
// grid (the light, plus with history a floor where once explored), from
// the simulation's sight grid (pres_fill.rs k_pres_fog). Shared: the page
// reads them as its grids (and the GPU's fog); head[0] the version.
const fogState={w:0,h:0,light:null,fog:null,explored:null,head:null,tick:-1,history:null,bound:false,at:null};
function updateFog(T) {
    const S=T.sight, W=T.gw|0, H=T.gh|0, n=W*H;
    if (!S || S.length<n) return;
    if (S.constructor.name!=='Float32Array') throw new Error('presentation: the sight grid is not Float32');
    const st=fogState;
    let reset=false;
    if (st.w!==W || st.h!==H || !st.light) {
        if (st.at) for (const r of st.at) pmFree(r);
        const L=pmAlloc(4*n), G=pmAlloc(4*n), E=pmAlloc(n), HD=pmAlloc(4*n);
        st.at=[L,G,E,HD];st.w=W;st.h=H;
        st.light=new Float32Array(pm.mem.buffer,L.base,n).fill(0);st.fog=new Float32Array(pm.mem.buffer,G.base,n).fill(0);
        st.explored=new Uint8Array(pm.mem.buffer,E.base,n).fill(0);new Int32Array(pm.mem.buffer,HD.base,n).fill(-1);
        st.head=new Int32Array(new SharedArrayBuffer(8));
        st.tick=T.time;st.bound=false;reset=true;
    }
    const now=T.time, holdTicks=Math.max(1,T.rate|0);
    let back=0;
    if (now<st.tick) {back=st.tick-now;st.tick=now;}
    const dt=Math.min(2,Math.max(0,now-st.tick))/holdTicks, hist=!!T.history, full=reset || st.history!==hist, range=T.lightRange||6;
    st.history=hist;
    const I=pm.I, P=pm.P, A=st.at;
    I[512]=S.byteOffset;I[513]=A[0].base;I[514]=A[1].base;I[515]=A[2].base;I[516]=A[3].base;
    P[0]=n;P[1]=now;P[2]=holdTicks;P[3]=T.rise*dt;P[4]=T.fall*dt;P[5]=full?1:0;P[6]=reset?1:0;P[7]=hist?1:0;P[8]=range;P[9]=range*(T.historyFloor||.14);P[10]=back;
    pm.x.k_pres_fog(pm.args,0);
    st.tick=now;
    Atomics.store(st.head,0,now);
    if (!st.bound) {(out || self).postMessage({type:'fogBind',epoch,light:st.light,fog:st.fog,explored:st.explored,head:st.head,width:W,height:H});st.bound=true;}
}
// A frame's first count order entries (slots) by unit id (pres.rs
// k_pres_order: a radix sort in this worker's memory; F is a frame there).
function frameIdOrder(F, count) {
    pmState(F.cap);
    const I=pm.I, P=pm.P;
    I[512]=F.order.byteOffset;I[513]=F.id.byteOffset;I[514]=pm.scratch;P[0]=count;
    pm.x.k_pres_order(pm.args,0);
    // (Kept: the next frame's order when the membership did not change. An
    // order kept and merged with the units new to it was ~5x slower than this
    // sort at 1M: the ids by slot are random, every look-up a cache miss.)
    if (!pm.lastView || pm.lastView.length!==pm.cap) pm.lastView=new Int32Array(pm.mem.buffer,pm.lastSlots,pm.cap);
    pm.lastView.set(F.order.subarray(0,count));
    pm.lastN=count;
}
// The last frame's order (frameIdOrder keeps it) into F's: the
// order when the membership did not change.
function frameLastOrder(F, count) {
    if (!pm.lastView || pm.lastView.length!==pm.cap) pm.lastView=new Int32Array(pm.mem.buffer,pm.lastSlots,pm.cap);
    F.order.set(pm.lastView.subarray(0,count));
}
// The camera's buckets (pres.rs k_pres_bucket_part, k_pres_bucket_merge):
// after the frame's columns, head and motion a cell, next an order entry,
// the moving slots. Offsets absolute in the buffer. (Teleports and stops
// count as moving too: the positions of the last frame built are kept
// there.) In parts of the order (BUCKET_PARTS from BUCKET_PARTS_MIN
// entries, whatever the threads: the same lists), taken by this thread and
// the helpers in turn, then joined.
const BUCKET_PARTS=16, BUCKET_PARTS_MIN=65536;
const bucketJob={F:null,count:0,columns:0,rows:0,tile:32,cells:0,offset:0,movingOffset:0,parts:1,per:0};
function bucketParts(cells,parts) {
    const need=3*cells*parts*4+parts*4;
    if (!pm.bk || pm.bk.size<need) {
        if (pm.bk) pmFree(pm.bk.r);
        const r=pmAlloc(need);pm.bk={r,size:need};
    }
    const b=pm.bk.r.base, n=cells*parts*4;
    return {heads:b,tails:b+n,motion:b+2*n,moved:b+3*n};
}
// A part's arguments (all but which part) into a thread's block.
function writeBucketJob(I,P) {
    const J=bucketJob, F=J.F, A=bucketParts(J.cells,J.parts);
    I[512]=F.order.byteOffset;I[513]=F.x.byteOffset;I[514]=F.y.byteOffset;I[515]=F.px.byteOffset;I[516]=F.py.byteOffset;
    I[517]=J.offset+J.cells*8;I[518]=J.movingOffset;I[519]=pm.prevX;I[520]=pm.prevY;I[521]=A.heads;I[522]=A.tails;I[523]=A.motion;I[524]=A.moved;
    P[2]=J.columns;P[3]=J.rows;P[4]=J.tile;P[5]=pm.prevReady ? 1 : 0;
}
// Parts taken until none is left (ctl[4] the next; ctl[5] parts, ctl[6] a
// part's entries, ctl[7] count).
function runBucketParts(x,args,P,ctl) {
    const parts=ctl[5], per=ctl[6], count=ctl[7];
    for (;;) {
        const c=Atomics.add(ctl,4,1);
        if (c>=parts) return;
        P[0]=c*per;P[1]=Math.min(count,(c+1)*per);P[6]=c;
        x.k_pres_bucket_part(args,0);
    }
}
const BUCKET_MSG={type:'buckets'};
function buildRenderBuckets(F, count, columns, rows, tile) {
    pmState(F.cap);
    const J=bucketJob, cells=columns*rows, offset=F.base+simFrameBytes(F.cap);
    const parts=count>=BUCKET_PARTS_MIN ? BUCKET_PARTS : 1, per=Math.max(1,Math.ceil(count/parts));
    J.F=F;J.count=count;J.columns=columns;J.rows=rows;J.tile=tile;J.cells=cells;J.offset=offset;J.movingOffset=offset+cells*8+F.cap*4;J.parts=parts;J.per=per;
    const ctl=pmChunks().v;
    ctl[5]=parts;ctl[6]=per;ctl[7]=count;Atomics.store(ctl,4,0);
    // (The helpers the ranges had, when there are parts for them.)
    const H=parts>1 && rangeHelpers>0 ? helpers : null, nh=H ? rangeHelpers : 0;
    if (nh) {
        Atomics.store(helperDone,0,0);
        for (let r=0;r<nh;r++) {writeBucketJob(H[r].th.I,H[r].th.P);H[r].worker.postMessage(BUCKET_MSG);}
    }
    writeBucketJob(pm.I,pm.P);
    runBucketParts(pm.x,pm.args,pm.P,ctl);
    if (nh && !waitHelpers(nh)) return null;
    const A=bucketParts(cells,parts), I=pm.I, P=pm.P;
    I[512]=offset;I[513]=offset+cells*4;I[514]=offset+cells*8;I[515]=J.movingOffset;I[516]=A.heads;I[517]=A.tails;I[518]=A.motion;I[519]=A.moved;I[520]=pm.out;
    P[0]=parts;P[1]=cells;P[2]=per;
    pm.x.k_pres_bucket_merge(pm.args,0);
    pm.prevReady=true;J.F=null;
    return { columns, rows, tile, offset, movingOffset: J.movingOffset, movingCount: new Int32Array(pm.mem.buffer, pm.out, 1)[0] };
}
// Which parts of the renderer's unit columns changed, so the page uploads
// only those (renderer3d.js _columnStoreUpload). Per column and block of
// DIRTY_BLOCK slots: the last frame (seq) it changed in (pres_fill.rs
// marks), kept here and copied into each frame, so a page that skipped
// frames still knows what changed since the one its GPU holds.
const DIRTY_COLS=['x','y','px','py','r','energy','owner','flags','id','type','facing','phase','prate','vision','mode','amount'], DIRTY_BLOCK=256;
const dirty={stream:(Math.random()*2147483647)|0,seq:0,cap:-1,stamps:null,prev:null,prevN:0,prevTick:-1};
function dirtyBytes(cap) {return DIRTY_COLS.length*Math.ceil(cap/DIRTY_BLOCK)*4;}
// A frame's marks begin (this frame's seq; the last frame to compare with,
// or none: every block marked) and end (copied into the frame: its record).
function dirtyBegin(F,n) {
    const nc=DIRTY_COLS.length, nb=Math.ceil(F.cap/DIRTY_BLOCK), used=Math.ceil(n/DIRTY_BLOCK), D=dirty;
    if (D.cap!==F.cap) {D.cap=F.cap;D.stamps=pm.st.stamps;D.prev=null;}
    const seq=++D.seq, P=D.prev && D.prev.base!==F.base ? D.prev : null;
    if (!P) for (let c=0;c<nc;c++) D.stamps.fill(seq,c*nb,c*nb+used);
    return {seq,prev:P,pn:Math.min(D.prevN,n),nb};
}
// (prevTick: the tick the last frame was made from, its marks' bound.)
function dirtyEnd(F,n,offset,seq,tick) {
    const D=dirty, nb=Math.ceil(F.cap/DIRTY_BLOCK);
    D.prev=F;D.prevN=n;D.prevTick=Number.isFinite(tick) ? tick : -1;
    new Int32Array(F.buf,F.base+offset,D.stamps.length).set(D.stamps);
    return {offset:F.base+offset,seq,stream:D.stream,block:DIRTY_BLOCK,nb,cols:DIRTY_COLS};
}
// The frame's job (one a frame, its fields rewritten: no objects a frame).
const job={n:0,nn:0,player:0,areaUnit:0,metaCopy:false,mode:0,seq:0,bseq:0,phase:0,ta:-1,ghosts:false,gw:0,gh:0,tile:32,light:0,marks:false,pn:0,nb:0};
// A range's kernels, in turn (pres_fill.rs: which slots, the filled ones pass
// by pass, the order, ghosts and marks; each its own function: as one, V8
// compiled the passes ~10x slower), over a thread's argument block.
const RANGE_STEPS=['k_pres_select','k_pres_p0','k_pres_p1','k_pres_p2','k_pres_p3','k_pres_p4','k_pres_p5','k_pres_p6','k_pres_p7','k_pres_p8','k_pres_p9','k_pres_finish','k_pres_tail'];
function rangeSteps(x) {return RANGE_STEPS.map(k => x[k]);}
function runRange(steps,args) {for (let i=0;i<steps.length;i++) steps[i](args,0);}
// (This thread's range, each step timed: the frame reports them, phases 8.. .)
const stepMs=new Float64Array(RANGE_STEPS.length);
function runRangeTimed(steps,args) {let t=performance.now();for (let i=0;i<steps.length;i++) {steps[i](args,0);const u=performance.now();stepMs[i]+=u-t;t=u;}}
// A range's arguments (the kernels' block) for a thread.
function writeJob(th,F,Pf) {
    const I=th.I, P=th.P, J=job;
    I[512]=F.tab;I[513]=Pf ? Pf.tab : 0;I[514]=pm.S;I[515]=pm.M;I[516]=pm.st.T;I[517]=th.AL;I[518]=th.CL;I[519]=th.BK;I[521]=J.light;
    P[2]=J.nn;P[3]=J.n;P[4]=J.player;P[5]=J.areaUnit;P[6]=J.metaCopy?1:0;P[7]=J.mode;P[8]=J.seq;P[9]=J.bseq;P[10]=PRESENT_DELTA_ROUNDS;
    P[11]=J.phase;P[12]=J.ta;P[13]=visFollow;P[14]=visTurn;P[15]=faceVel;P[16]=lightFull;P[17]=0;P[18]=pm.hasCm?1:0;P[19]=pm.hasPvOD?1:0;
    P[20]=J.ghosts?1:0;P[21]=J.gw;P[22]=J.gh;P[23]=J.tile;P[24]=J.marks?1:0;P[25]=J.pn;P[26]=J.nb;
}
// ---- chunks ----
// A frame's slots in chunks (whole blocks of DIRTY_BLOCK slots), each taken
// by the next thread free (this one and the helpers: Atomics on chunk[0]),
// so they finish together however the filled units lie (with a range a
// thread, the slowest took ~35 ms where this thread's took ~15). Each chunk
// has its words (pres_fill.rs out: count, changed, by marks, filled) at
// 64 + 64 * c in this region: chunk[1] chunks, chunk[2] slots each, chunk[3] n.
const CHUNK_MAX=64, CHUNKS_A_THREAD=4;
function pmChunks() {
    if (!pm.chunks) {const r=pmAlloc(64+64*CHUNK_MAX);pm.chunks={base:r.base,v:new Int32Array(pm.mem.buffer,r.base,16+16*CHUNK_MAX)};}
    return pm.chunks;
}
// This thread's share: chunks taken until none is left. (ctl: the region's
// Int32 view; I, P: this thread's argument block.)
function runChunks(steps,args,I,P,ctl,base,timed) {
    const nch=ctl[1], per=ctl[2], n=ctl[3];
    for (;;) {
        const c=Atomics.add(ctl,0,1);
        if (c>=nch) return;
        const s0=c*per;
        P[0]=s0;P[1]=Math.min(n,s0+per);I[520]=base+64+64*c;P[27]=ctl[16+16*c+2];
        if (timed) runRangeTimed(steps,args); else runRange(steps,args);
    }
}
// ---- helpers: this script again, named present-helper ----
// From PRESENT_HELPER_MIN slots a frame's ranges are split over this thread
// and up to 3 helpers (a quarter of the cores less one), each range written
// by one thread. A helper has its own instance of the module over the same
// two memories, its own stack and argument block; this thread writes a
// job's arguments there and posts it a trigger; it reports through
// helperDone (Atomics), which this thread waits on after its own range.
const HELPER=typeof self==='object' && self.name==='present-helper';
const NO_PRESENT=typeof self==='object' && !!self.location && /[?&]present=0(?:&|$)/.test(self.location.search || '');
const PRESENT_HELPER_MIN=60000;
const PRESENT_ALL_HELPERS_MIN=1000000;
// Frames by changes from this many slots; every slot refilled at least every
// PRESENT_DELTA_ROUNDS frames (a change the rules miss shows that late).
let PRESENT_DELTA_MIN=100000;
const PRESENT_DELTA_ROUNDS=32;
const HELPER_STACK=256*1024;
let helpers=null, helpersOff=false, helperDone=null, helperResults=null;
const FILL_MSG={type:'fill'};
function stopHelpers(why) {
    if (helpers) for (const h of helpers) {try {h.worker.terminate();} catch {}}
    helpers=null;helpersOff=true;
    if (why) console.warn('presentation helpers off: '+why);
}
// (Another simulation memory: helpers made anew, on it.)
function restartHelpers() {if (helpers) {stopHelpers(null);helpersOff=false;}}
function presentHelpers(nn) {
    if (helpersOff || HELPER || nn<PRESENT_HELPER_MIN || !SHARED || typeof Worker!=='function' || !(self.location && self.location.href)) return null;
    if (!helpers) {
        const cores=(self.navigator && navigator.hardwareConcurrency) || 4, want=Math.max(0,Math.min(3,(cores>>2)-1));
        if (!want) {helpersOff=true;return null;}
        helperDone=new Int32Array(new SharedArrayBuffer(4));helperResults=new Int32Array(new SharedArrayBuffer(4*want));
        helpers=[];
        for (let i=0;i<want;i++) {
            let worker;
            try {worker=new Worker(self.location.href,{name:'present-helper'});} catch (err) {break;}
            const a=pmAlloc(8192), stack=pmAlloc(HELPER_STACK);
            const th={args:a.base,I:new Int32Array(pm.mem.buffer,a.base,1024),P:new Float64Array(pm.mem.buffer,a.base+4096,512),AL:0,CL:0,BK:0,len:-1};
            const h={worker,ready:false,th};
            worker.onmessage=ev=>{const m=ev.data||{};if (m.type==='helperReady') h.ready=true;else if (m.type==='error') console.warn(m.message);};
            worker.onerror=ev=>{if (ev && ev.preventDefault) ev.preventDefault();stopHelpers(String(ev && ev.message || 'a helper failed'));};
            worker.postMessage({type:'helperInit',module:pm.mod,memory:pm.mem,simMemory:pm.sim,stackTop:stack.base+HELPER_STACK,args:a.base,slot:i,done:helperDone,results:helperResults,chunks:pmChunks().base});
            helpers.push(h);
        }
        if (!helpers.length) {helpers=null;helpersOff=true;return null;}
    }
    for (let i=0;i<helpers.length;i++) if (!helpers[i].ready) return null;
    return helpers;
}
// The frame's ranges (this thread the last): the count listed, F.order
// made contiguous, fillChanged; -1 when the helpers failed (the frame is
// dropped, the helpers off).
let fillChanged=false, rangeThreads=1, helperWait=0, helperWork=0, filledAll=0, byMarks=0, rangeHelpers=0;
// The helpers' jobs done (helperDone), or false: they failed or took 2 s (turned off).
function waitHelpers(nh) {
    const deadline=performance.now()+2000;
    for (;;) {
        const d=Atomics.load(helperDone,0);
        if (d>=nh) break;
        if (performance.now()>deadline) {stopHelpers('no answer in 2 s');return false;}
        Atomics.wait(helperDone,0,d,100);
    }
    for (let r=0;r<nh;r++) if (helperResults[r]<0) {stopHelpers('a job failed');return false;}
    return true;
}
const rangeAt=new Int32Array(10);
function runRanges(F,Pf) {
    // (Paced, a frame has some ticks' time: fewer threads at once beside a
    // simulation short of them. Millions of slots: every helper whatever the pace.)
    const J=job, all=presentHelpers(J.nn);
    const nh=!all ? 0 : pacing.pace>1 && J.nn<PRESENT_ALL_HELPERS_MIN ? (pacing.pace===2 ? 1 : 0) : all.length;
    const B=DIRTY_BLOCK, parts=nh+1, want=nh ? Math.min(CHUNK_MAX,parts*CHUNKS_A_THREAD) : 1;
    const per=Math.max(1,Math.ceil(Math.ceil(J.n/B)/want))*B, nch=Math.ceil(J.n/per);
    stepMs.fill(0);
    if (!nch) {fillChanged=false;return 0;}
    const K=pmChunks(), ctl=K.v;
    ctl[1]=nch;ctl[2]=per;ctl[3]=J.n;Atomics.store(ctl,0,0);
    if (nh) {
        Atomics.store(helperDone,0,0);
        for (let r=0;r<nh;r++) {
            const th=all[r].th;
            pmThreadScratch(th,per);
            writeJob(th,F,Pf);
            all[r].worker.postMessage(FILL_MSG);
        }
    }
    const M=pm.main;
    pmThreadScratch(M,per);
    writeJob(M,F,Pf);
    runChunks(pm.steps,M.args,M.I,M.P,ctl,K.base,true);
    rangeHelpers=nh;
    if (nh) {
        const waitAt=performance.now();
        if (!waitHelpers(nh)) return -1;
        // (The helpers: the longest one's work and this thread's wait for them.)
        helperWait=performance.now()-waitAt;helperWork=0;
        for (let r=0;r<nh;r++) helperWork=Math.max(helperWork,(helperResults[r]-1)/1000);
    }
    // F.order contiguous: each chunk's listed slots from its start on.
    const FORD=F.order;
    let total=0, changed=false;
    filledAll=0;
    for (let c=0;c<nch;c++) {
        const o=16+16*c, cnt=ctl[o];
        if (ctl[o+1]) changed=true;
        filledAll+=ctl[o+3];
        if (c*per!==total && cnt) FORD.copyWithin(total,c*per,c*per+cnt);
        total+=cnt;
    }
    byMarks=ctl[16+2];
    fillChanged=changed;rangeThreads=parts;
    return total;
}
// A helper: its instance (the module over the two memories, its own stack), then ranges.
const helper={x:null,steps:null,args:0,slot:0,done:null,results:null,I:null,P:null,ctl:null,chunks:0};
function onHelperMessage(event) {
    const m=event.data;
    if (m.type==='helperInit') {
        try {
            helper.x=new WebAssembly.Instance(m.module,{env:{memory:m.memory,simMemory:m.simMemory}}).exports;
            helper.x.__stack_pointer.value=m.stackTop;helper.steps=rangeSteps(helper.x);
            helper.args=m.args;helper.slot=m.slot;helper.done=m.done;helper.results=m.results;helper.chunks=m.chunks;
            helper.I=new Int32Array(m.memory.buffer,m.args,1024);helper.P=new Float64Array(m.memory.buffer,m.args+4096,512);
            helper.ctl=new Int32Array(m.memory.buffer,m.chunks,16+16*CHUNK_MAX);
            postMessage({type:'helperReady'});
        } catch (err) {postMessage({type:'error',message:'presentation helper: '+String(err.stack || err)});}
        return;
    }
    if (m.type==='buckets') {
        let res=-1;
        try {runBucketParts(helper.x,helper.args,helper.P,helper.ctl);res=1;}
        catch (err) {postMessage({type:'error',message:'presentation helper: '+String(err.stack || err)});}
        finally {helper.results[helper.slot]=res;Atomics.add(helper.done,0,1);Atomics.notify(helper.done,0);}
        return;
    }
    if (m.type!=='fill') return;
    let res=-1;
    // (res: 1 + the microseconds it took, for the frame's report.)
    const t0=performance.now();
    try {runChunks(helper.steps,helper.args,helper.I,helper.P,helper.ctl,helper.chunks,false);res=1+Math.round((performance.now()-t0)*1000);}
    catch (err) {postMessage({type:'error',message:'presentation helper: '+String(err.stack || err)});}
    finally {helper.results[helper.slot]=res;Atomics.add(helper.done,0,1);Atomics.notify(helper.done,0);}
}
// Frames yield to the simulation: while ticks come slower than their rate
// (the simulation short of time), a frame is made only every `pace` ticks
// (up to PACE_MAX), back a step toward every tick after 3 s at the rate.
// (At 600k units the simulation ran 18.7 TPS beside 3-4 frames a second,
// 15.5 beside one a tick: frames cost the threads it needs.) The tick
// before a frame's asks for its snapshot (else the frame waits a tick
// more). self.presentPacing = false: a frame every tick (tests).
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
// (A new source or state: the next frame's membership counts as changed.)
let membershipReset=true;
function draw() {
    const started=performance.now();
    scheduled=false;
    const tick=latest;
    if (!tick || !source || !pm.x) return;
    const cap=source.id.length;
    const columns = tick.n >= 5000 && tick.gw > 0 ? Math.ceil(tick.gw / 16) : 0;
    const rows = columns ? Math.ceil(tick.gh / 16) : 0;
    const indexBytes = columns * rows ? columns * rows * 8 + cap * 8 : 0;
    const frameBytes=simFrameBytes(cap) + indexBytes + dirtyBytes(cap);
    if (pmStateFor(cap)) membershipReset=true;
    const e=acquireUnits(frameBytes,cap);
    if (!e) return;
    latest=null;
    const t0=performance.now();
    const got=takeSnapshot(tick.tick,tick.n);
    const t1=performance.now();
    if (got===-3) {e.busy=false;return;}
    if (got<0) {torn++;e.busy=false;return;}
    let changed=membershipReset;
    membershipReset=false;
    const F=e.F, nn=Math.min(tick.n,got);
    {const dk=lastBuiltTick>=0 ? Math.max(1,Math.min(16,tick.tick-lastBuiltTick)) : 1;visFollow=1-Math.pow(1-VIS_FOLLOW,dk);visTurn=1-Math.pow(1-VIS_TURN,dk);faceVel=1-Math.pow(1-FACE_VEL,dk);lastBuiltTick=tick.tick;}
    if (tick.lightRange>0) lightFull=tick.lightRange;
    // (The metadata: copied when this buffer's is older.)
    const rev=metaRev ? Atomics.load(metaRev,0) : -2;
    const metaCopy=e.metaRev!==rev || rev===-2 || e.metaN<nn;
    if (metaCopy) {e.metaRev=rev;e.metaN=nn;}
    // Team + history: ghosts by the fog's light (made for this tick).
    const ghosts=!!tick.history && !!fogState.light && fogState.w===(tick.gw|0) && fogState.h===(tick.gh|0);
    const D=dirtyBegin(F,tick.n);
    // By changes: from PRESENT_DELTA_MIN slots, this buffer built before at
    // this size, the last frame another buffer, no ghosts; by the
    // simulation's marks when it keeps them (pvAt).
    const bseq=e.seq>0 ? e.seq : 0;
    const delta=nn>=PRESENT_DELTA_MIN && !ghosts && !!D.prev && bseq>0 && D.prev.cap===cap;
    const J=job;
    J.n=tick.n;J.nn=nn;J.player=tick.player;J.areaUnit=tick.areaUnit;J.metaCopy=metaCopy;
    J.mode=!delta ? 0 : pm.hasPvAt && dirty.prevTick>=0 ? 2 : 1;
    J.seq=D.seq;J.bseq=bseq;J.phase=D.seq%PRESENT_DELTA_ROUNDS;J.ta=dirty.prevTick;
    J.ghosts=ghosts;J.gw=tick.gw|0;J.gh=tick.gh|0;J.tile=tick.tile||32;J.light=ghosts ? fogState.at[0].base : 0;
    J.marks=!!D.prev;J.pn=D.pn;J.nb=D.nb;
    const count=runRanges(F,D.prev);
    if (count<0) {e.busy=false;dirty.prev=null;e.metaRev=-1;e.seq=0;membershipReset=true;return;}
    e.seq=D.seq;
    // (The snapshot rewritten while the ranges read it: positions of two
    // ticks in this frame, a glitch of a frame; counted.)
    if (motHead && Atomics.load(motHead,0)!==motTick) torn++;
    if (fillChanged) changed=true;
    const t2=performance.now();
    if(changed) membership++;
    // Stable simulation identity order even after authoritative slot reuse.
    // (Sorted again when membership changed; else the last order, kept.)
    const FORD=F.order;
    if (changed || pm.lastN!==count || pm.cap!==F.cap) frameIdOrder(F,count);
    else frameLastOrder(F,count);
    const t3=performance.now();
    const world={units:{buf:pm.mem.buffer,base:e.base,bytes:frameBytes,rid:e.rid,gen:generation,cap,n:tick.n,count,mver:membership},strings:[0,strings]};
    if (indexBytes) {
        const B=buildRenderBuckets(F, count, columns, rows, tick.tile || 32);
        if (!B) {e.busy=false;dirty.prev=null;e.metaRev=-1;e.seq=0;membershipReset=true;return;}
        world.units.renderBuckets=B;
    }
    const tb=performance.now();
    world.units.dirty = dirtyEnd(F, tick.n, simFrameBytes(cap) + indexBytes, D.seq, tick.tick);
    const tm=performance.now();
    if(structure && structureRevision!==sentStructureRevision) {
        // (Its block only: the table is in the wasm heap's memory.)
        const bytes=structure.bytes||structure.buf.byteLength, off=structure.off||0;
        const b=acquire(bytes,'structures');
        if(b) {new Uint8Array(b,0,bytes).set(new Uint8Array(structure.buf,off,bytes));world.structures={...structure,buf:b,off:0,bytes};sentStructureRevision=structureRevision;}
    }
    if(projectiles && projectileRevision!==sentProjectileRevision) {
        const b=acquire(projectiles.buf.byteLength,'projectiles');
        if(b) {new Uint8Array(b,0,projectiles.buf.byteLength).set(new Uint8Array(projectiles.buf));world.projectiles={...projectiles,buf:b};sentProjectileRevision=projectileRevision;}
    }
    const tt=performance.now();
    if(cells) {const d=cellChanges();if (d) world.state={cells:d};cells=null;}
    const t4=performance.now();
    // (phases: the snapshot, the ranges (fill, ghosts, marks), the order,
    // the rest; then how many threads made the ranges, the pace, the slots
    // filled on this thread and whether by the simulation's marks.)
    (out || self).postMessage({type:'presentation',epoch,tick:tick.tick,world,buildMs:t4-started,torn,phases:[t1-t0,t2-t1,t3-t2,t4-t3,rangeThreads,pacing.pace,filledAll,byMarks,...stepMs,helperWork,helperWait,tb-t3,tm-tb,tt-tm,t4-tt]});helperWait=helperWork=0;
    schedule();
}
// The tiles whose type or owner changed since the last frame (pres_fill.rs
// k_pres_cells over the map's columns in the simulation's heap; from the
// baseline the simulation sent, else every tile): (tile, type, owner)
// triples, or null.
function cellChanges() {
    const ct=cells.type, co=cells.owner, n=Math.min(ct.length,co.length);
    if (ct.constructor.name!=='Uint8Array' || co.constructor.name!=='Int8Array') throw new Error('presentation: the cell columns are not Uint8 / Int8');
    if (!pm.cells || pm.cells.n!==n) {
        if (pm.cells) {pmFree(pm.cells.oldR);pmFree(pm.cells.outR);pmFree(pm.cells.cntR);}
        const oldR=pmAlloc(8*n), outR=pmAlloc(12*n), cntR=pmAlloc(64);
        pm.cells={n,oldR,outR,cntR,old:new Int32Array(pm.mem.buffer,oldR.base,2*n).fill(-2147483648),out:new Int32Array(pm.mem.buffer,outR.base,3*n),cnt:new Int32Array(pm.mem.buffer,cntR.base,1)};
    }
    const K=pm.cells;
    if (cellBaseline) {if (cellBaseline.length===2*n) K.old.set(cellBaseline);cellBaseline=null;}
    const I=pm.I, P=pm.P;
    I[512]=ct.byteOffset;I[513]=co.byteOffset;I[514]=K.oldR.base;I[515]=K.outR.base;I[516]=K.cntR.base;P[0]=n;
    pm.x.k_pres_cells(pm.args,0);
    const m=K.cnt[0];
    return m ? K.out.slice(0,3*m) : null;
}
// Units the simulation moved to other slots (sim_unit_state.js
// simUnitStateRelayoutStep: pairs from, to): their drawn position, facing,
// easing and last-seen ghost follow them (pres_fill.rs k_pres_moves). The
// frames' own per-slot records (last ids, when filled) stay: the new slot
// is filled anew.
function slotMoves(pairs) {
    if (!pairs || !source || !source.id || !pm.st || !pm.x) return;
    const np=pairs.length>>1;
    if (!np) return;
    const r=pmRegion('moves',8*np);
    new Int32Array(pm.mem.buffer,r.base,2*np).set(pairs.subarray(0,2*np));
    const I=pm.I, P=pm.P;
    I[512]=r.base;I[513]=source.id.byteOffset;I[514]=pm.st.T;P[0]=np;P[1]=pm.st.cap;P[2]=1;
    pm.x.k_pres_moves(pm.args,0);
}
function onMessage(event) {
    const m=event.data;
    try {
        if(m.type==='port') {out=m.port;out.onmessage=onMessage;return;}
        if(m.type==='snaps') {
            snapCtl=m.ctl;
            // (Views into the simulation's wasm heap: read there in place.)
            if (!m.snaps) throw new Error('presentation: the snapshots must be in the simulation\'s heap');
            snaps=m.snaps;
            return;
        }
        // A tick's end: its frame at once (no timer between: the snapshot
        // must be taken before the next tick starts).
        if(m.type==='tick') {
            // (?present=0, a measurement: no frames.)
            if (NO_PRESENT) return;
            // (The fog first: cheap, and the frame's ghosts read the same tick.)
            if (m.fog && pm.x) {try {updateFog(m);} catch(err) {postMessage({type:'error',message:String(err.stack || err)});}}
            if (!paceDue(m)) return;
            latest=m;if(!scheduled && source && ready) {scheduled=true;draw();}return;
        }
        if(m.type==='bind') {
            pmInit(m.simMemory);pm.prevReady=false;epoch=m.epoch;generation=m.generation;source=m.columns;
            meta={buf:m.meta.buf,cap:m.meta.cap,off:m.meta.off||0};pmBindSource(source,meta);
            metaRev=m.metaRev||null;for(const e of buffers.values()) e.metaRev=-1;
            if (pm.st) pm.st.views.last.fill(-1);
            membershipReset=true;lastBuiltTick=-1;schedule();
        }
        else if(m.type==='strings') strings=m.strings;
        else if(m.type==='slotMoves') slotMoves(m.pairs);
        else if(m.type==='ready') {ready=true;schedule();}
        else if(m.type==='structures') {structure=m.table;structureRevision=m.revision;}
        else if(m.type==='projectiles') {projectiles=m.table;projectileRevision=m.revision;}
        else if(m.type==='cellBaseline') cellBaseline=m.cells;
        else if(m.type==='cells') cells={type:m.ctype,owner:m.cowner};
        else if(m.type==='release') {if (m.rid>0) releaseRegion(m.rid,m.gen); else release(m.buf);if(snapCtl)Atomics.store(snapCtl,1,1);schedule();}
    } catch(err) {postMessage({type:'error',message:String(err.stack || err)});}
}
self.onmessage=HELPER ? onHelperMessage : onMessage;
