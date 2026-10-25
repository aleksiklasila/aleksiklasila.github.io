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
        const old = Q;
        const ctl = Q && Q.cap >= cap ? Q.ctl : new Int32Array(new SharedArrayBuffer(8));
        Q = _simPresentSnaps = { cap, worker: p.worker, ctl, next: 0, snaps: [] };
        for (let i = 0; i < SIM_PRESENT_SNAPS; i++) {
            // (Positions as the columns hold them, Int32 eighths: a copy, scaled
            // by the presentation worker. In the wasm heap: the helpers copy
            // them, simParallelCopyHeap; one thread's memcpy of four columns
            // was ~8 ms a tick at 2M units, ~30 at 8M.)
            const all = typeof simHeapArray === 'function' ? simHeapArray(Int32Array, 4 + cap * 4) : new Int32Array(new SharedArrayBuffer(16 + cap * 16));
            Q.snaps.push({ all, head: all.subarray(0, 2), x: all.subarray(4, 4 + cap), y: all.subarray(4 + cap, 4 + 2 * cap),
                px: all.subarray(4 + 2 * cap, 4 + 3 * cap), py: all.subarray(4 + 3 * cap, 4 + 4 * cap) });
            Q.snaps[i].head[0] = -1;
        }
        if (old) for (const q of old.snaps) if (typeof simHeapFree === 'function') simHeapFree(q.all);
        ctl[0] = -1; ctl[1] = 1;
        p.worker.postMessage({ type: 'snaps', ctl, cap, snaps: Q.snaps.map(q => ({ head: q.head, x: q.x, y: q.y, px: q.px, py: q.py })) });
    }
    // (Each slot's last visual change, for the reader's frames by changes:
    // every tick, before the reader may take this tick's snapshot.)
    if (typeof SIM_KERNEL_PV_MARKS === 'number' && S.columns.pvAt) {
        // (Small jobs: 65536 slots a job were four, and the helpers' share of them small: this thread did most of the ~2.7 ms.)
        const P = _simParams, per = 8192;
        P[0] = n; P[1] = per; P[2] = typeof currentTick === 'number' ? currentTick : 0; P[3] = GRID_W; P[4] = TILE;
        simParallelRun(SIM_KERNEL_PV_MARKS, Math.ceil(Math.max(1, n) / per));
    }
    if (Atomics.exchange(Q.ctl, 1, 0) !== 1) return;
    const i = Q.next, q = Q.snaps[i], C = S.columns;
    Q.next = (i + 1) % SIM_PRESENT_SNAPS;
    Atomics.store(q.head, 0, -1);
    if (typeof simParallelCopyHeap === 'function') simParallelCopyHeap([q.x.subarray(0, n), C.x.subarray(0, n), q.y.subarray(0, n), C.y.subarray(0, n), q.px.subarray(0, n), C.prevX.subarray(0, n), q.py.subarray(0, n), C.prevY.subarray(0, n)]);
    else { q.x.set(C.x.subarray(0, n)); q.y.set(C.y.subarray(0, n)); q.px.set(C.prevX.subarray(0, n)); q.py.set(C.prevY.subarray(0, n)); }
    q.head[1] = n;
    Atomics.store(q.head, 0, typeof currentTick === 'number' ? currentTick : 0);
    Atomics.store(Q.ctl, 0, i); Q.publishedTick = typeof currentTick === 'number' ? currentTick : 0;
}
const SIM_PRESENT_MAGIC = 0x50524553;
const SIM_PRESENT_COLUMNS = ['id','owner','x','y','prevX','prevY','vx','vy','energy','r','commandState',
    'attackFlash','stBu','stPo','stFr','stWe','stSa','stWa','stTh',
    'workerTransferCooldown','effectiveLevel','unitLevel','live','dead','maxE','stIx','cmMode','cmT','pvAt','pvOD'];

function simPresentationStop() {
    const p = _simPresentation;
    if (!p) return;
    clearTimeout(p.timer); p.worker.terminate(); _simPresentation = null;
}

function simPresentationStart() {
    simPresentationStop();
    if (!SIM_PAR_SHARED || typeof Worker !== 'function') return false;
    const base = self.SIM_WORKER_BASE || location.href;
    const worker = new Worker(new URL('presentation_worker.js?v=20261025-st1', base).href);
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
    // (The table filled from the start frame: drawn at once; the cycles
    // below refresh it.)
    worker.postMessage({type:'ready'});
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
    // (By the column itself, not its buffer: columns in the wasm heap all
    // share one, see sim_wasm.js.)
    // (And again when the status records' pool grew: its arrays are new.)
    if (p.sourceBuffer !== S.columns.x || p.stSource !== S.columns.stBu) {
        const columns = {};
        for (const k of SIM_PRESENT_COLUMNS) columns[k] = S.columns[k];
        p.stSource = S.columns.stBu;
        const grown = p.sourceBuffer !== S.columns.x;
        p.columns = columns; p.sourceBuffer = S.columns.x;
        if (grown) {
            const old = p.meta;
            p.meta = simMetaViews(new SharedArrayBuffer(S.cap * SIM_META_SLOT_BYTES), S.cap);
            p.meta.id.fill(-1);
            if (old) for (const k of [...SIM_META_I32, ...SIM_META_F32, ...SIM_META_I16]) p.meta[k].set(old[k].subarray(0,p.meta.cap));
            else simPresentationSeedMetadata(p.meta);
            // (metaRev: bumped when the metadata table changed in a way a frame
            // must show at once (a slot's new unit) and at each cycle's end; the
            // reader copies the table into a frame only when its revision moved.)
            if (!p.metaRev) p.metaRev = new Int32Array(new SharedArrayBuffer(4));
            Atomics.add(p.metaRev, 0, 1);
        }
        p.worker.postMessage({type:'bind', epoch:p.epoch, generation:p.generation, columns, meta:{buf:p.meta.buf,cap:p.meta.cap}, metaRev:p.metaRev});
    }
    const strings = _simFrameStrings.list;
    if (p.strings !== strings.length) {
        p.worker.postMessage({type:'strings', strings:strings.slice()}); p.strings = strings.length;
    }
}

// Turret angles by structure slot, live (shared with the page, which reads
// them in place of the table's: structure tables are published when
// structures come, go or change, and the metadata cycle, seconds apart at
// 100k buildings, so far turrets drawn from the table did not turn).
// angleRev counts the ticks something turned. Presentation only.
function _simPresentAngles(p, F) {
    const cap = F.cap;
    if (!p.angles || p.angles.length < cap) {
        const a = new Float32Array(new SharedArrayBuffer(cap * 4));
        // (The rows' angles as written, the live ones over them: newer.)
        a.set(F.angle.subarray(0, Math.min(cap, F.angle.length)));
        if (p.angles) a.set(p.angles);
        p.angles = a;
    }
    if (!p.angleRev) p.angleRev = new Int32Array(new SharedArrayBuffer(4));
    return p.angles;
}
// A tower turned (tower.js, as it aims).
function simPresentTowerAngle(t) {
    const p = _simPresentation, A = p ? p.angles : null;
    if (!A) return;
    const s = t._sslot;
    if (!(s >= 0 && s < A.length) || _simStructSlots.owner[s] !== t) return;
    const v = Math.fround(Number(t.angle) || 0);
    if (A[s] !== v) { A[s] = v; p.angleDirty = true; }
}
// Per tile, the slot of the structure (towers, barracks, spawners, cell
// items) the table shows there, -1 none: a tile whose structure went is
// cleared by it.
function _simPresentTileSlots(p) {
    const n = GRID_W * GRID_H;
    if (!p.tileSlot || p.tileSlot.length !== n) p.tileSlot = new Int32Array(n).fill(-1);
    return p.tileSlot;
}
// A structure placed, built or changed shows at the next tick: its tile's
// structure written into the shared table at once (the tile entity journal,
// tileEntityChangesSince), not at the end of the metadata cycle, which at
// millions of units and ~200k structures came ~10 s later (a build order's
// site appeared that long after its ghost). The cycle still refreshes all.
// A copy of structure table F with room for cap slots (its columns, the
// order list): a structure placed past the shown table's end shows at the
// next tick, not after the cycle that makes a bigger one (seconds at 100k
// buildings).
function _simStructTableGrow(F, cap) {
    cap = Math.ceil(cap * 1.25 / 64) * 64;
    const G = simTableViews(SIM_STRUCT_SPEC, new SharedArrayBuffer(cap * SIM_STRUCT_SPEC.slotBytes), cap);
    for (const k of [...SIM_STRUCT_SPEC.f32, ...SIM_STRUCT_SPEC.i32, 'order', ...SIM_STRUCT_SPEC.i16, ...SIM_STRUCT_SPEC.u8]) G[k].set(F[k]);
    return G;
}
// Tiles whose structure changed in a way the tile journal does not see (a
// salvage mark, a toggle, construction finished): shown at the next tick
// too. Presentation only: nothing of the simulation reads it.
let _simPresentDirtyTiles = [];
function simPresentTileDirty(gx, gy) {
    if (!_simPresentation || !(gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H)) return;
    if (_simPresentDirtyTiles.length < 65536) _simPresentDirtyTiles.push((gy | 0) * GRID_W + (gx | 0));
}
function _simPresentStructureChanges(p) {
    let F = p.structures;
    if (!F || typeof tileEntityChangesSince !== 'function') return;
    let tiles = tileEntityChangesSince(p.teCursor || (p.teCursor = { epoch: -1, pos: 0 }));
    if (_simPresentDirtyTiles.length) {
        const d = _simPresentDirtyTiles; _simPresentDirtyTiles = [];
        tiles = tiles && tiles.length ? [...new Set([...tiles, ...d])] : [...new Set(d)];
    }
    if (!tiles || !tiles.length) return;
    const S = _simStructSlots, T = _simPresentTileSlots(p);
    let count = Math.min(F.cap, p.structCount | 0), wrote = false;
    for (const t of tiles) {
        const gx = t % GRID_W, gy = (t - gx) / GRID_W;
        let e = typeof getTileEntityRef === 'function' ? getTileEntityRef(gx, gy) : null, kind = -1;
        const cell = grid[gy] && grid[gy][gx];
        // (A floor item is its tile's entity and its cell's item: kind 3; a mine, none here.)
        if (e) kind = typeof Tower !== 'undefined' && e instanceof Tower ? 0 : typeof Barrack !== 'undefined' && e instanceof Barrack ? 1 : Array.isArray(e.spawnQueue) ? 2 : cell && cell.item === e ? 3 : -1;
        else if (cell && cell.item) { e = cell.item; kind = 3; }
        if (kind < 0) e = null;
        // The structure shown on this tile is gone (destroyed, salvaged, or
        // another there now): off the table at once, not at the cycle's end.
        // (A slot freed by a cycle's sweep may hold another tile's structure
        // since: that one stays.)
        const prev = T[t];
        if (prev >= 0 && S.owner[prev] !== e) {
            const pe = S.owner[prev];
            if (pe && pe.gx === gx && pe.gy === gy) {
                pe._sslot = undefined; S.owner[prev] = null; S.free.push(prev); S.version++;
                if (prev < F.cap) F.alive[prev] = 0;
                if (p.structuresNext && prev < p.structuresNext.cap) p.structuresNext.alive[prev] = 0;
                wrote = true;
            }
            T[t] = -1;
        }
        if (!e) continue;
        const known = e._sslot !== undefined && S.owner[e._sslot] === e;
        const s = S.slotOf(e);
        T[t] = s;
        // (Kept by the cycle running now: its sweep frees unstamped slots.)
        if (!known) S.stamp[s] = S.tick;
        // (The bigger table the cycle is filling, too.)
        let N = p.structuresNext;
        if (N && s >= N.cap) N = p.structuresNext = _simStructTableGrow(N, S.owner.length);
        if (N) _simWriteStructure(N, s, e, kind, gameTime);
        if (p.angles && s < p.angles.length) p.angles[s] = Math.fround(Number(e.angle) || 0);
        if (s >= F.cap || (!known && count >= F.cap)) { F = p.structures = _simStructTableGrow(F, Math.max(S.owner.length, count + 1)); count = Math.min(count, F.cap); }
        if (!known) F.order[count++] = s;
        _simWriteStructure(F, s, e, kind, gameTime);
        wrote = true;
    }
    if (!wrote) return;
    p.structCount = count;
    _simPresentAngles(p, F);
    p.worker.postMessage({type:'structures', table:{buf:F.buf,cap:F.cap,n:S.owner.length,count,mver:S.version,angles:p.angles,angleRev:p.angleRev}, revision:++p.revision});
}

function simPresentationPublish(tick) {
    const p = _simPresentation;
    if (!p) return;
    simPresentationBind();
    try { _simPresentStructureChanges(p); } catch (err) { _simError('presentation structures', err); }
    // (Turrets that turned this tick: the page's columns take their angles.)
    if (p.angleDirty && p.angleRev) { p.angleDirty = false; Atomics.add(p.angleRev, 0, 1); }
    // (Team + history: this player's sight grid, shared, for the reader's
    // last-seen positions; units are drawn frozen where last seen.)
    // (With fog: also the fog's light and memory, made there, see
    // presentation_worker.js updateFog.)
    const fog = typeof fullVisibility !== 'undefined' && !fullVisibility;
    const history = fog && typeof teamVisibilityHistory !== 'undefined' && teamVisibilityHistory;
    const rows = fog && typeof visibilityGridRawByPlayerCache !== 'undefined' ? visibilityGridRawByPlayerCache.get(localPlayerId) : null;
    const sight = rows && rows._flat && typeof SharedArrayBuffer === 'function' && rows._flat.buffer instanceof SharedArrayBuffer ? rows._flat : null;
    p.worker.postMessage({type:'tick', epoch:p.epoch, tick, time:gameTime, rate:TICK_RATE,
        player:localPlayerId, areaUnit:AREA_UNIT_TILE_EQUIVALENT, n:_simUnitState.owners.length,
        history: history && !!sight, fog: fog && !!sight, sight, gw: GRID_W, gh: GRID_H, tile: TILE,
        lightRange: VISIBILITY_LIGHT_NORMALIZATION_RANGE, rise: VISIBILITY_LIGHT_MAX_CHANGE_PER_SECOND, fall: VISIBILITY_FADE_MAX_CHANGE_PER_SECOND,
        historyFloor: typeof HISTORY_LIGHT_FLOOR === 'number' ? HISTORY_LIGHT_FLOOR : .14});
}

// The metadata table's first fill from the last frame this worker made
// (sim_frame.js _simFrameLastViews, by render slot; this table is by unit
// slot): a gather over typed columns. (Written unit by unit, between ticks,
// its first pass took minutes at 2M units with ticks back to back, and the
// reader showed nothing until it ended: the page kept the start frame.)
const SIM_PRESENT_META_COLUMNS = ['type', 'wtype', 'wstate', 'style', 'watchedBy', 'vision', 'maxEnergy', 'cargo', 'tx', 'ty', 'orderDest', 'orderTick'];
const SIM_PRESENT_META_FLAGS = SIM_UF_FLYING | SIM_UF_SNAKE | SIM_UF_WORKER | SIM_UF_HOLD | SIM_UF_KING | SIM_UF_ATTACK_TARGET | SIM_UF_RESEARCH_MATERIAL | SIM_UF_ENERGY_BLOCKED;
function simPresentationSeedMetadata(M) {
    const F = typeof _simFrameLastViews !== 'undefined' ? _simFrameLastViews : null, S = _simUnitState;
    if (!F || !S) return 0;
    const C = S.columns, RS = C.j__rslot, n = Math.min(S.owners.length, M.cap);
    if (!RS) return 0;
    const cols = SIM_PRESENT_META_COLUMNS.map(k => [M[k], F[k]]), FID = F.id, MF = M.flags, FF = F.flags, MID = M.id, CID = C.id, DEAD = C.dead;
    let seeded = 0;
    for (let s = 0; s < n; s++) {
        const r = RS[s];
        if (!(r >= 0 && r < F.cap) || DEAD[s] || FID[r] !== CID[s]) continue;
        for (let k = 0; k < cols.length; k++) cols[k][0][s] = cols[k][1][r];
        MF[s] = FF[r] & SIM_PRESENT_META_FLAGS;
        MID[s] = CID[s];
        seeded++;
    }
    return seeded;
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

// (A value changed: the slot's next mark, unit.pvAt, so frames by changes
// fill it; orderTick, the same tick for all, is not a change.)
let _simMetaChanged = false;
function _simMetaSet(A, s, v) { if (A[s] !== v && !(v !== v && A[s] !== A[s])) { A[s] = v; _simMetaChanged = true; } }
function simPresentationWriteMetadata(u, F) {
    const C = u._us, s = u._si, p0Dest = !!(_simPresentation && _simPresentation.meta === F);
    if (!C || s < 0 || s >= F.cap || C.dead[s]) return;
    // Publish identity last: a reader never assigns a recycled slot the old
    // unit's type. Dynamic positions/statuses come straight from authority.
    const fresh = F.id[s] !== C.id[s];
    if (fresh) F.id[s] = -1;
    _simMetaChanged = fresh;
    const set = _simMetaSet;
    set(F.type, s, _simFrameCode(u.unitType)); set(F.wtype, s, _simFrameCode(u.workerType));
    set(F.wstate, s, _simFrameCode(u.workerState)); set(F.style, s, _simFrameCode(u.attackStyle));
    set(F.watchedBy, s, Number.isFinite(u.watchedByTeam) ? u.watchedByTeam : -1);
    const e = u.preComputedEffective, b = u.preComputed;
    set(F.vision, s, areaSteps(e && Number.isFinite(e.visionRangeArea) ? e.visionRangeArea : getEntityEffectiveVisibilityRangeArea(u)));
    set(F.maxEnergy, s, Math.fround(b ? b.maxEnergy : C.energy[s]));
    set(F.cargo, s, Math.fround(Number(u.carryingValue) || 0));
    const at = u.attackTarget;
    set(F.tx, s, Math.fround(at ? at.x : 0)); set(F.ty, s, Math.fround(at ? at.y : 0));
    // (A unit of the columns: its destination is the marks kernel's, each
    // tick (unit.pvOD; the reader takes it from there).)
    if (!(p0Dest && C.pvOD)) set(F.orderDest, s, getUnitOrderDestinationCode(u) | 0);
    F.orderTick[s] = currentTick - 1;
    set(F.flags, s, (u.isFlying ? SIM_UF_FLYING : 0) | (u.isSnake ? SIM_UF_SNAKE : 0) | (u.isWorker ? SIM_UF_WORKER : 0)
        | (u.holdPosition ? SIM_UF_HOLD : 0) | (u.isKing ? SIM_UF_KING : 0)
        | (at && Number.isFinite(at.x) ? SIM_UF_ATTACK_TARGET : 0)
        | (u.researcherHasMaterial ? SIM_UF_RESEARCH_MATERIAL : 0)
        | (Number.isFinite(u._energyBlockedUntil) && gameTime < u._energyBlockedUntil ? SIM_UF_ENERGY_BLOCKED : 0));
    F.id[s] = C.id[s];
    if (_simMetaChanged && C.pvAt) C.pvAt[s] = (typeof currentTick === 'number' ? currentTick : 0) + 1;
    const p = _simPresentation;
    if (fresh && p && p.metaRev) Atomics.add(p.metaRev, 0, 1);
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
    if (p.metaRev) Atomics.add(p.metaRev, 0, 1);
    simPresentationBind();
    p.worker.postMessage({type:'ready'});
    const S = _simStructSlots, stamp = ++S.tick, lists = _simStructLists();
    let n = 0;
    for (const list of lists) for (const e of list) {
        if (e) { S.slotOf(e); n++; }
        if ((n & 127) === 127) yield;
    }
    const cap = Math.max(64, S.owner.length);
    let F = p.structures, fresh = false;
    if (!F || F.cap < cap) {
        // (A bigger table is filled beside the shown one and takes its place
        // at the cycle's end: published before, half empty, every structure
        // not yet written looked gone for the frames meanwhile. The changes
        // of the ticks between go to both: _simPresentStructureChanges.)
        F = simTableViews(SIM_STRUCT_SPEC, new SharedArrayBuffer(Math.ceil(cap * 1.25 / 64) * 64 * SIM_STRUCT_SPEC.slotBytes), Math.ceil(cap * 1.25 / 64) * 64);
        if (p.structures) { p.structuresNext = F; fresh = true; } else p.structures = F;
    }
    let j=0;
    const T=_simPresentTileSlots(p);
    // (The table again after each yield: a tick's changes may have grown it
    // since, _simStructTableGrow.)
    const cur = () => fresh ? p.structuresNext : p.structures;
    for (let kind=0;kind<lists.length;kind++) for (const e of lists[kind]) {
        if (!e || S.owner[e._sslot] !== e) continue;
        F = cur();
        const s=e._sslot; S.stamp[s]=stamp; F.order[j++]=s;
        _simWriteStructure(F,s,e,kind,gameTime);
        if (p.angles && s < p.angles.length) p.angles[s] = F.angle[s];
        if (kind<=3 && e.gx>=0 && e.gy>=0 && e.gx<GRID_W && e.gy<GRID_H) T[(e.gy|0)*GRID_W+(e.gx|0)]=s;
        if ((j & 31) === 31) yield;
    }
    for (let s=0;s<S.owner.length;s++) {
        if (S.stamp[s] !== stamp) {
            F = cur(); F.alive[s]=0;
            const e=S.owner[s];
            if (e) { e._sslot=undefined;S.owner[s]=null;S.free.push(s);S.version++; }
        }
        if ((s & 511) === 511) yield;
    }
    F = cur();
    S.orderChanged(F.order,j);
    simPresentationBind();
    if (fresh) { p.structures = F; p.structuresNext = null; }
    p.structCount = j;
    _simPresentAngles(p, F);
    p.worker.postMessage({type:'structures', table:{buf:F.buf,cap:F.cap,n:S.owner.length,count:j,mver:S.version,angles:p.angles,angleRev:p.angleRev}, revision:++p.revision});
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
// their own path. A slice waits for a tick due within it, but for no more
// than SIM_PRESENT_PUMP_STARVE_MS: with ticks back to back (millions of
// units) the cycle never ran at all.)
const SIM_PRESENT_PUMP_REST_MS = 250, SIM_PRESENT_PUMP_STARVE_MS = 50;
function simPresentationPump() {
    const p = _simPresentation;
    if (!p) return;
    const next = typeof _simStream !== 'undefined' && _simStream.length ? _simStream[0] : null;
    if (next && next.type === 'tick' && Number.isFinite(next.due)) {
        const wait = next.due - _simNowAbs();
        // (A million units or more: a slice every 4x as long, ~5% of a 2.3M-unit step otherwise: the cycle
        // only refreshes slow attributes; a new unit's metadata is written at its start.)
        const starve = SIM_PRESENT_PUMP_STARVE_MS * (units.length >= 1000000 ? 4 : 1);
        if (wait < 2 && performance.now() - (p.sliceAt || 0) < starve) { p.timer = setTimeout(simPresentationPump, Math.max(1, wait + 1)); return; }
    }
    const start=performance.now();
    p.sliceAt = start;
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
