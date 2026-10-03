"use strict";
importScripts('sim_frame.js?v=20261004-stream','sim_frame_world.js?v=20261004-stream');
const PRESENT_MAGIC=0x50524553;
let source=null, meta=null, epoch=0, generation=0, latest=null, scheduled=false, strings=[''], ready=false;
let structure=null, structureRevision=-1, sentStructureRevision=-1, cells=null, oldCells=null;
let projectiles=null, projectileRevision=-1, sentProjectileRevision=-1;
let last=null, lastOrder=null, membership=0, sequence=0;
const buffers=new Map();
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
function draw() {
    const started=performance.now();
    scheduled=false;
    const tick=latest;
    if (!tick || !source) return;
    const cap=source.id.length, buf=acquire(cap*SIM_FRAME_SLOT_BYTES);
    if (!buf) return;
    latest=null;
    const F=simFrameViews(buf,cap), C=source;
    let count=0, changed=!last || last.length !== cap;
    if (!last || last.length !== cap) last=new Int32Array(cap).fill(-1);
    for (let s=0;s<tick.n;s++) {
        const id=C.id[s];
        if (!C.live[s] || C.dead[s] || meta.id[s] !== id) {F.id[s]=-1;if(last[s]!==-1) changed=true;last[s]=-1;continue;}
        F.id[s]=id;F.order[count++]=s;
        if(last[s]!==id) changed=true;last[s]=id;
        const x=C.x[s],y=C.y[s],vx=C.vx[s],vy=C.vy[s],flash=C.attackFlash[s];
        F.x[s]=x;F.y[s]=y;F.px[s]=C.prevX[s];F.py[s]=C.prevY[s];F.vx[s]=vx;F.vy[s]=vy;
        F.owner[s]=C.owner[s];F.energy[s]=C.energy[s];F.r[s]=C.r[s];F.cmd[s]=C.commandState[s];
        F.level[s]=Number.isFinite(C.effectiveLevel[s])?C.effectiveLevel[s]:-1;
        F.blevel[s]=Number.isFinite(C.unitLevel[s])?C.unitLevel[s]:-1;F.flash[s]=Math.max(0,Math.min(255,flash));
        F.flags[s]=meta.flags[s] | (C.burning[s]>0?SIM_UF_BURNING:0) | (C.poisoned[s]>0?SIM_UF_POISONED:0)
            | (C.frozen[s]>0?SIM_UF_FROZEN:0) | (C.wet[s]>0?SIM_UF_WET:0) | (C.sandy[s]>0?SIM_UF_SANDY:0)
            | (C.watched[s]>0?SIM_UF_WATCHED:0) | (C.teleportHideTicks[s]>0?SIM_UF_HIDDEN:0) | (C.workerTransferCooldown[s]>0?SIM_UF_TRANSFER:0);
        F.type[s]=meta.type[s];F.wtype[s]=meta.wtype[s];F.wstate[s]=meta.wstate[s];F.style[s]=meta.style[s];
        F.watchedBy[s]=meta.watchedBy[s];F.vision[s]=meta.vision[s];F.maxEnergy[s]=meta.maxEnergy[s];F.cargo[s]=meta.cargo[s];
        F.tx[s]=meta.tx[s];F.ty[s]=meta.ty[s];
        F.light[s]=F.owner[s]===tick.player || (C.watched[s]>0 && F.watchedBy[s]===tick.player) ? F.vision[s]*tick.areaUnit : 0;
        const moving=Math.hypot(x-F.px[s],y-F.py[s])>.01;
        F.mode[s]=flash>0?1:moving?0:7;F.status[s]=flash>0?1:moving?0:3;
        F.amount[s]=moving || flash>0 ? 1 : .7;
        F.facing[s]=Math.atan2(vx,vy || .0001);F.phase[s]=tick.time/tick.rate*10+id*2.399;F.prate[s]=10/tick.rate;F.sig[s]=0;
        // The simulation may recycle a slot during the scan. Drop it rather
        // than presenting old metadata at the replacement unit's position.
        if (C.id[s]!==id || meta.id[s]!==id || C.dead[s]) {F.id[s]=-1;count--;changed=true;last[s]=-1;}
    }
    if(changed) membership++;
    // Stable simulation identity order even after authoritative slot reuse.
    if(changed || !lastOrder || lastOrder.length!==count) {
        F.order.subarray(0,count).sort((a,b)=>F.id[a]-F.id[b]);
        lastOrder=F.order.slice(0,count);
    } else F.order.set(lastOrder);
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
    postMessage({type:'presentation',epoch,tick:tick.tick,world,buildMs:performance.now()-started});
    schedule();
}
self.onmessage=event=>{
    const m=event.data;
    try {
        if(m.type==='bind') {epoch=m.epoch;generation=m.generation;source=m.columns;meta=simFrameViews(m.meta.buf,m.meta.cap);last=null;schedule();}
        else if(m.type==='strings') strings=m.strings;
        else if(m.type==='ready') {ready=true;schedule();}
        else if(m.type==='tick') {latest=m;schedule();}
        else if(m.type==='structures') {structure=m.table;structureRevision=m.revision;}
        else if(m.type==='projectiles') {projectiles=m.table;projectileRevision=m.revision;}
        else if(m.type==='cellBaseline') oldCells=m.cells.slice();
        else if(m.type==='cells') cells=m.cells;
        else if(m.type==='release') {const t=new DataView(m.buf,m.buf.byteLength-12);if(t.getInt32(0,true)!==generation)return;const e=buffers.get(t.getInt32(4,true));if(e)e.busy=false;schedule();}
    } catch(err) {postMessage({type:'error',message:String(err.stack || err)});}
};
