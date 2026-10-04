"use strict";
// Presentation is a best-effort consumer, never a simulation barrier. Numeric
// unit state is already shared: send its bindings, not copies of its contents.
// Object-only metadata is mirrored in bounded tasks BETWEEN simulation ticks.
// The reader owns its output buffers; slow pages exhaust that pool and skip
// visual updates without delaying the authority or its helper jobs.
let _simPresentation = null;
let _simPresentationGeneration = 0;
// Every tick's positions for the presentation: at the tick's end this
// thread copies x, y, prevX, prevY (memcpy, ~1 ms at 200k units) into the
// oldest of SIM_PRESENT_SNAPS shared snapshots; the reader takes the newest
// whenever it gets to it. (Read from the live columns, a reader racing the
// next tick dropped its copy: when ticks ran back to back most were lost,
// and units stood, then jumped.) Each snapshot's header: [tick (-1 while
// written), units]; ctl[0] the newest snapshot's index.
const SIM_PRESENT_SNAPS = 3;
let _simPresentSnaps = null;
function simPresentTickBegin() { }
function simPresentTickEnd() {
    const p = _simPresentation, S = _simUnitState;
    if (!p || !S || typeof SharedArrayBuffer !== 'function') return;
    const n = S.owners.length, cap = S.columns.x.length;
    let Q = _simPresentSnaps;
    if (!Q || Q.cap < cap || Q.worker !== p.worker) {
        const ctl = Q && Q.cap >= cap ? Q.ctl : new Int32Array(new SharedArrayBuffer(8));
        Q = _simPresentSnaps = { cap, worker: p.worker, ctl, next: 0, snaps: [] };
        for (let i = 0; i < SIM_PRESENT_SNAPS; i++) {
            const buf = new SharedArrayBuffer(8 + cap * 32);
            Q.snaps.push({ buf, head: new Int32Array(buf, 0, 2), x: new Float64Array(buf, 8, cap), y: new Float64Array(buf, 8 + cap * 8, cap),
                px: new Float64Array(buf, 8 + cap * 16, cap), py: new Float64Array(buf, 8 + cap * 24, cap) });
            Q.snaps[i].head[0] = -1;
        }
        ctl[0] = -1;
        p.worker.postMessage({ type: 'snaps', ctl, cap, bufs: Q.snaps.map(q => q.buf) });
    }
    const i = Q.next, q = Q.snaps[i], C = S.columns;
    Q.next = (i + 1) % SIM_PRESENT_SNAPS;
    Atomics.store(q.head, 0, -1);
    q.x.set(C.x.subarray(0, n)); q.y.set(C.y.subarray(0, n)); q.px.set(C.prevX.subarray(0, n)); q.py.set(C.prevY.subarray(0, n));
    q.head[1] = n;
    Atomics.store(q.head, 0, typeof currentTick === 'number' ? currentTick : 0);
    Atomics.store(Q.ctl, 0, i);
}
const SIM_PRESENT_MAGIC = 0x50524553;
const SIM_PRESENT_COLUMNS = ['id','owner','x','y','prevX','prevY','vx','vy','energy','r','commandState',
    'attackFlash','burning','poisoned','frozen','wet','sandy','watched','teleportHideTicks',
    'workerTransferCooldown','effectiveLevel','unitLevel','live','dead','maxE'];

function simPresentationStop() {
    const p = _simPresentation;
    if (!p) return;
    clearTimeout(p.timer); p.worker.terminate(); _simPresentation = null;
}

function simPresentationStart() {
    simPresentationStop();
    if (!SIM_PAR_SHARED || typeof Worker !== 'function') return false;
    const base = self.SIM_WORKER_BASE || location.href;
    const worker = new Worker(new URL('presentation_worker.js?v=20261021-x', base).href);
    const p = _simPresentation = { worker, epoch:_simEpoch, generation:++_simPresentationGeneration,
        timer:0, job:null, meta:null, projectileJob:null, projectileAt:0,
        structures:null, cells:null, columns:null, sourceBuffer:null, strings:0, revision:0 };
    worker.onmessage = event => {
        if (_simPresentation !== p) return;
        const m = event.data;
        if (m.type === 'presentation') _simPost(m);
        else if (m.type === 'error') _simError('presentation', new Error(m.message));
    };
    worker.onerror = event => _simError('presentation', new Error(event.message || 'presentation reader failed'));
    _simPresentSnaps = null;
    // Frames go to the page, and their buffers come back, over a channel of
    // their own: never queued behind a tick on this thread (a frame waiting
    // here for a 30-40 ms tick reached the page late, then two at once: units
    // stood, then jumped).
    if (typeof MessageChannel === 'function') {
        const ch = new MessageChannel();
        worker.postMessage({ type: 'port', port: ch.port1 }, [ch.port1]);
        _simPost({ type: 'presentationPort', epoch: _simEpoch, generation: p.generation, port: ch.port2 }, [ch.port2]);
    }
    simPresentationBind();
    const baseline=_simStateLast;
    if(baseline.cellTypes && baseline.w===GRID_W && baseline.h===GRID_H) {
        const cells=new Int32Array(new SharedArrayBuffer(GRID_W*GRID_H*8));
        for(let i=0;i<baseline.cellTypes.length;i++) {cells[i*2]=baseline.cellTypes[i];cells[i*2+1]=baseline.cellOwners[i];}
        p.worker.postMessage({type:'cellBaseline',cells});
    }
    p.job = simPresentationMetadata();
    p.timer = setTimeout(simPresentationPump, 0);
    return true;
}

function simPresentationBind() {
    const p = _simPresentation, S = _simUnitState;
    if (!p || !S) return;
    if (p.sourceBuffer !== S.columns.x.buffer) {
        const columns = {};
        for (const k of SIM_PRESENT_COLUMNS) columns[k] = S.columns[k];
        p.columns = columns; p.sourceBuffer = S.columns.x.buffer;
        const old = p.meta;
        p.meta = simFrameViews(new SharedArrayBuffer(S.cap * SIM_FRAME_SLOT_BYTES), S.cap);
        p.meta.id.fill(-1);
        if (old) for (const k of [...SIM_FRAME_F32, ...SIM_FRAME_I32, ...SIM_FRAME_I16, ...SIM_FRAME_U8]) p.meta[k].set(old[k].subarray(0,p.meta.cap));
        p.worker.postMessage({type:'bind', epoch:p.epoch, generation:p.generation, columns, meta:{buf:p.meta.buf,cap:p.meta.cap}});
    }
    const strings = _simFrameStrings.list;
    if (p.strings !== strings.length) {
        p.worker.postMessage({type:'strings', strings:strings.slice()}); p.strings = strings.length;
    }
}

function simPresentationPublish(tick) {
    const p = _simPresentation;
    if (!p) return;
    simPresentationBind();
    p.worker.postMessage({type:'tick', epoch:p.epoch, tick, time:gameTime, rate:TICK_RATE,
        player:localPlayerId, areaUnit:AREA_UNIT_TILE_EQUIVALENT, n:_simUnitState.owners.length});
}

function simPresentationReturn(buf) {
    if (!buf || buf.byteLength < 12 || typeof SharedArrayBuffer !== 'function' || !(buf instanceof SharedArrayBuffer)) return false;
    if (new DataView(buf, buf.byteLength - 4).getInt32(0, true) !== SIM_PRESENT_MAGIC) return false;
    if (_simPresentation) _simPresentation.worker.postMessage({type:'release', buf});
    return true;
}

function* simPresentationProjectiles() {
    const p=_simPresentation, S=_simProjSlots, stamp=++S.tick, list=projectiles;
    let i=0;
    for(const e of list) {if(e) S.slotOf(e);if((++i&127)===0) yield;}
    let F=p.projectiles;
    if(!F || F.cap<S.owner.length) {
        const cap=Math.max(64,Math.ceil(S.owner.length*1.25/64)*64);
        F=p.projectiles=simTableViews(SIM_PROJ_SPEC,new SharedArrayBuffer(cap*SIM_PROJ_SPEC.slotBytes),cap);
    }
    let j=0;
    for(const e of list) {
        if(!e || S.owner[e._pslot]!==e) continue;
        const s=e._pslot;S.stamp[s]=stamp;F.order[j++]=s;
        F.alive[s]=1;F.serial[s]=S.serials[s];F.x[s]=e.x;F.y[s]=e.y;
        F.px[s]=Number.isFinite(e.prevX)?e.prevX:e.x;F.py[s]=Number.isFinite(e.prevY)?e.prevY:e.y;
        F.vx[s]=Number(e.vx)||0;F.vy[s]=Number(e.vy)||0;F.sx[s]=Number(e.startX)||0;F.sy[s]=Number(e.startY)||0;
        F.aim[s]=Number(e.aimDist)||0;F.type[s]=_simFrameCode(e.type);F.owner[s]=Number.isFinite(e.sourceOwner)?e.sourceOwner:-1;
        F.life[s]=Math.max(-32000,Math.min(32000,Number(e.life)||0));
        if((j&63)===0) yield;
    }
    for(let s=0;s<S.owner.length;s++) {
        if(S.stamp[s]!==stamp) {F.alive[s]=0;const e=S.owner[s];if(e){e._pslot=undefined;S.owner[s]=null;S.free.push(s);S.version++;}}
        if((s&511)===511) yield;
    }
    S.orderChanged(F.order,j);simPresentationBind();
    p.worker.postMessage({type:'projectiles',table:{buf:F.buf,cap:F.cap,n:S.owner.length,count:j,mver:S.version},revision:++p.revision});
}

function simPresentationWriteMetadata(u, F) {
    const C = u._us, s = u._si;
    if (!C || s < 0 || s >= F.cap || C.dead[s]) return;
    // Publish identity last: a reader never assigns a recycled slot the old
    // unit's type. Dynamic positions/statuses come straight from authority.
    if (F.id[s] !== C.id[s]) F.id[s] = -1;
    F.type[s] = _simFrameCode(u.unitType); F.wtype[s] = _simFrameCode(u.workerType);
    F.wstate[s] = _simFrameCode(u.workerState); F.style[s] = _simFrameCode(u.attackStyle);
    F.watchedBy[s] = Number.isFinite(u.watchedByTeam) ? u.watchedByTeam : -1;
    const e = u.preComputedEffective, b = u.preComputed;
    F.vision[s] = e && Number.isFinite(e.visionRangeArea) ? e.visionRangeArea : getEntityEffectiveVisibilityRangeArea(u);
    F.maxEnergy[s] = b ? b.maxEnergy : C.energy[s];
    F.cargo[s] = Number(u.carryingValue) || 0;
    const at = u.attackTarget;
    F.tx[s] = at ? at.x : 0; F.ty[s] = at ? at.y : 0;
    F.flags[s] = (u.isFlying ? SIM_UF_FLYING : 0) | (u.isSnake ? SIM_UF_SNAKE : 0) | (u.isWorker ? SIM_UF_WORKER : 0)
        | (u.holdPosition ? SIM_UF_HOLD : 0) | (u.isKing ? SIM_UF_KING : 0)
        | (at && Number.isFinite(at.x) ? SIM_UF_ATTACK_TARGET : 0)
        | (u.researcherHasMaterial ? SIM_UF_RESEARCH_MATERIAL : 0)
        | (Number.isFinite(u._energyBlockedUntil) && gameTime < u._energyBlockedUntil ? SIM_UF_ENERGY_BLOCKED : 0);
    F.id[s] = C.id[s];
}

function* simPresentationMetadata() {
    const p = _simPresentation;
    // Metadata changes more slowly than positions. This scan never runs in
    // _simTick, has no Atomics.wait, and yields every small block of records.
    const list = units;
    for (let i=0;i<list.length;i++) {
        simPresentationWriteMetadata(list[i], p.meta);
        if ((i & 127) === 127) yield;
    }
    simPresentationBind();
    p.worker.postMessage({type:'ready'});
    const S = _simStructSlots, stamp = ++S.tick, lists = _simStructLists();
    let n = 0;
    for (const list of lists) for (const e of list) {
        if (e) { S.slotOf(e); n++; }
        if ((n & 127) === 127) yield;
    }
    const cap = Math.max(64, S.owner.length);
    let F = p.structures;
    if (!F || F.cap < cap) {
        F = p.structures = simTableViews(SIM_STRUCT_SPEC, new SharedArrayBuffer(Math.ceil(cap * 1.25 / 64) * 64 * SIM_STRUCT_SPEC.slotBytes), Math.ceil(cap * 1.25 / 64) * 64);
    }
    let j=0;
    for (let kind=0;kind<lists.length;kind++) for (const e of lists[kind]) {
        if (!e || S.owner[e._sslot] !== e) continue;
        const s=e._sslot; S.stamp[s]=stamp; F.order[j++]=s;
        _simWriteStructure(F,s,e,kind,gameTime);
        if ((j & 31) === 31) yield;
    }
    for (let s=0;s<S.owner.length;s++) {
        if (S.stamp[s] !== stamp) {
            F.alive[s]=0;
            const e=S.owner[s];
            if (e) { e._sslot=undefined;S.owner[s]=null;S.free.push(s);S.version++; }
        }
        if ((s & 511) === 511) yield;
    }
    S.orderChanged(F.order,j);
    simPresentationBind();
    p.worker.postMessage({type:'structures', table:{buf:F.buf,cap:F.cap,n:S.owner.length,count:j,mver:S.version}, revision:++p.revision});
    // Grid data is not shared by the simulation yet. Publish its primitive
    // columns in small slices too; the reader computes the display delta.
    // (Only when a tile changed, or every few seconds: a million cells
    // copied each cycle took this thread's time between ticks for nothing.)
    const size = GRID_W * GRID_H, tev = typeof _tileEntityVersion === 'number' ? _tileEntityVersion : -1, nowMs = performance.now();
    if (p.cells && p.cells.length === size * 2 && p.cellsVersion === tev && nowMs - (p.cellsAt || 0) < 5000) return;
    p.cellsVersion = tev; p.cellsAt = nowMs;
    if (!p.cells || p.cells.length !== size * 2) p.cells = new Int32Array(new SharedArrayBuffer(size * 8));
    for (let y=0;y<GRID_H;y++) {
        const row=grid[y];
        for (let x=0;x<GRID_W;x++) { const i=y*GRID_W+x; p.cells[i*2]=row[x].type;p.cells[i*2+1]=row[x].owner; }
        yield;
    }
    p.worker.postMessage({type:'cells', cells:p.cells, width:GRID_W});
}

// (The metadata cycle again SIM_PRESENT_PUMP_REST_MS after one ends: types,
// worker states and levels change slowly; the positions go every tick on
// their own path. A slice waits for a tick due within it.)
const SIM_PRESENT_PUMP_REST_MS = 250;
function simPresentationPump() {
    const p = _simPresentation;
    if (!p) return;
    const next = typeof _simStream !== 'undefined' && _simStream.length ? _simStream[0] : null;
    if (next && next.type === 'tick' && Number.isFinite(next.due)) {
        const wait = next.due - _simNowAbs();
        if (wait < 2) { p.timer = setTimeout(simPresentationPump, Math.max(1, wait + 1)); return; }
    }
    const start=performance.now();
    let done=false;
    try {
        if(!p.projectileJob && start-p.projectileAt>=33) {p.projectileJob=simPresentationProjectiles();p.projectileAt=start;}
        if(p.projectileJob) {
            do {if(p.projectileJob.next().done) {p.projectileJob=null;break;}} while(performance.now()-start<.5);
        }
        do { done=p.job.next().done; } while (!done && performance.now()-start < 1);
    } catch (err) { _simError('presentation metadata',err);done=true; }
    if (done) p.job=simPresentationMetadata();
    p.timer=setTimeout(simPresentationPump,done ? SIM_PRESENT_PUMP_REST_MS : 0);
}
