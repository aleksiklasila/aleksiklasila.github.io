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
    const worker = new Worker(new URL('presentation_worker.js?v=20261105-cells', base).href);
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
            // (In the wasm heap, the slot kernels' table holds its columns:
            // a released slot's row reset, a moved unit's row moved with it,
            // sim_unit_state.js _simSlotZeroTable. A replaced one given back
            // later: the reader may still read it.)
            const hb = typeof simHeapArray === 'function' && typeof _simHeap !== 'undefined' && _simHeap.ready ? simHeapArray(Uint8Array, S.cap * SIM_META_SLOT_BYTES) : null;
            p.meta = hb && simHeapHas(hb) ? simMetaViews(hb.buffer, S.cap, hb.byteOffset) : simMetaViews(new SharedArrayBuffer(S.cap * SIM_META_SLOT_BYTES), S.cap);
            p.meta.heap = hb && simHeapHas(hb) ? hb : null;
            if (old && old.heap) _simStructTableRetired.push({ heap: old.heap, at: performance.now() });
            if (typeof _simSharedVer !== 'undefined') _simSharedVer++;
            p.meta.id.fill(-1);
            if (old) for (const k of [...SIM_META_I32, ...SIM_META_F32, ...SIM_META_I16]) p.meta[k].set(old[k].subarray(0,p.meta.cap));
            else simPresentationSeedMetadata(p.meta);
            // (metaRev: bumped when the metadata table changed in a way a frame
            // must show at once (a slot's new unit) and at each cycle's end; the
            // reader copies the table into a frame only when its revision moved.)
            if (!p.metaRev) p.metaRev = new Int32Array(new SharedArrayBuffer(4));
            Atomics.add(p.metaRev, 0, 1);
        }
        p.worker.postMessage({type:'bind', epoch:p.epoch, generation:p.generation, columns, meta:{buf:p.meta.buf,cap:p.meta.cap,off:p.meta.off||0}, metaRev:p.metaRev});
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
// The turrets that turned this step (tower.js towersTick: k_tower_fire's
// tiles and angles), by the tile's slot.
function simPresentTowerAngles(tiles, angles, n) {
    const p = _simPresentation, A = p ? p.angles : null, TS = p ? p.tileSlot : null;
    if (!A || !TS) return;
    for (let i = 0; i < n; i++) {
        const s = TS[tiles[i]];
        if (s >= 0 && s < A.length && A[s] !== angles[i]) { A[s] = angles[i]; p.angleDirty = true; }
    }
}
// Per tile, the slot of the structure (towers, barracks, spawners, cell
// items) the table shows there, -1 none: a tile whose structure went is
// cleared by it.
function _simPresentTileSlots(p) {
    const n = GRID_W * GRID_H;
    // (In the wasm heap: the metadata kernel writes it in place.)
    if (!p.tileSlot || p.tileSlot.length !== n || !simHeapHas(p.tileSlot)) { if (p.tileSlot && simHeapHas(p.tileSlot)) simHeapFree(p.tileSlot); p.tileSlot = simHeapArray(Int32Array, n).fill(-1); }
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
    cap = Math.ceil(Math.max(cap * 1.25, _simStructReserveCap) / 64) * 64;
    const G = _simStructTableNew(cap);
    for (const k of [...SIM_STRUCT_SPEC.f32, ...SIM_STRUCT_SPEC.i32, 'order', ...SIM_STRUCT_SPEC.i16, ...SIM_STRUCT_SPEC.u8]) G[k].set(F[k]);
    _simStructTableRetire(F);
    return G;
}
// A structure table of cap slots: a block of the wasm heap (the info
// panel's packer reads it there with a kernel, info_pack_worker.js), a
// SharedArrayBuffer only without the heap. A replaced one goes back to the
// heap SIM_STRUCT_TABLE_RETIRE_MS later: the presentation worker and the
// packer, outside the ticks, may still read it until they have the new one.
const SIM_STRUCT_TABLE_RETIRE_MS = 5000;
// The tables' slots for the match (main.js simMatchReserve): every structure
// row the match holds (B.structs), so the table made at the start is not
// made again bigger during play.
// (The first table made then too, taken by simPresentationMetadata.)
let _simStructReserveCap = 0, _simStructReserved = null;
function simPresentStructReserve(B) {
    _simStructReserveCap = Math.ceil((Math.max(0, (B.structs | 0) + (B.mines | 0)) + 64) / 64) * 64;
    if (!_simStructReserved || _simStructReserved.cap < _simStructReserveCap || (_simStructReserved.heap && !simHeapHas(_simStructReserved.heap))) _simStructReserved = _simStructTableNew(_simStructReserveCap);
}
const _simStructTableRetired = [];
function _simStructTableNew(cap) {
    const bytes = cap * SIM_STRUCT_SPEC.slotBytes;
    const heap = typeof _simHeap !== 'undefined' && _simHeap.ready && typeof simHeapArray === 'function' ? simHeapArray(Uint8Array, bytes) : null;
    const inHeap = heap && _simHeapPtrOf !== null && _simHeapPtrOf(heap) >= 0;
    const F = inHeap ? simTableViews(SIM_STRUCT_SPEC, heap.buffer, cap, heap.byteOffset) : simTableViews(SIM_STRUCT_SPEC, new SharedArrayBuffer(bytes), cap);
    F.heap = inHeap ? heap : null;
    return F;
}
function _simStructTableRetire(F) {
    if (F && F.heap) _simStructTableRetired.push({ heap: F.heap, at: performance.now() });
    const now = performance.now();
    while (_simStructTableRetired.length && now - _simStructTableRetired[0].at > SIM_STRUCT_TABLE_RETIRE_MS) simHeapFree(_simStructTableRetired.shift().heap);
}
// (The message form of a table: its block of the buffer.)
function _simStructTableMsg(F, extra) { return { buf: F.buf, off: F.off, bytes: F.bytes, cap: F.cap, ...extra }; }
// Tiles whose structure changed in a way the tile journal does not see (a
// salvage mark, a toggle, construction finished): shown at the next tick
// too. Presentation only: nothing of the simulation reads it.
let _simPresentDirtyTiles = [];
function simPresentTileDirty(gx, gy) {
    if (!_simPresentation || !(gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H)) return;
    if (_simPresentDirtyTiles.length < 65536) _simPresentDirtyTiles.push((gy | 0) * GRID_W + (gx | 0));
}
// A rally order's building (main.js _rallySetTiles): its rally cells of the
// shown table (and the one being filled) written at once, its row not rewritten
// (a bulk rally of 250k buildings as dirty tiles: a full row each, ~0.5 s).
function simPresentRally(e, x, y, id) {
    const p = _simPresentation, s = e._sslot;
    if (!p || s === undefined || _simStructSlots.owner[s] !== e) return;
    const on = x === x && y === y;
    _simPresentRallyCells(p.structures, s, on, x, y, id);
    _simPresentRallyCells(p.structuresNext, s, on, x, y, id);
    p.rallyDirty = true;
}
// The rally kernel's buildings (main.js _rallyKernelRun): by their tiles,
// the presentation's slot of each (p.tileSlot, its tile still its: gx, gy).
function simPresentRallyTiles(keys, m, x, y, id) {
    const p = _simPresentation;
    if (!p || !p.tileSlot) return;
    const T = p.tileSlot, on = x === x && y === y, W = GRID_W;
    for (const F of [p.structures, p.structuresNext]) {
        if (!F) continue;
        for (let i = 0; i < m; i++) {
            const t = keys[i], s = T[t];
            if (s < 0 || s >= F.cap) continue;
            const gx = t % W;
            if (F.gx[s] !== gx || F.gy[s] !== (t - gx) / W) continue;
            _simPresentRallyCells(F, s, on, x, y, id);
        }
    }
    p.rallyDirty = true;
}
function _simPresentRallyCells(F, s, on, x, y, id) {
    if (!F || s >= F.cap) return;
    F.rallyX[s] = on ? x : 0; F.rallyY[s] = on ? y : 0; F.rallyTargetId[s] = id === id ? id : -1;
    F.flags[s] = on ? F.flags[s] | SIM_SF_RALLY : F.flags[s] & ~SIM_SF_RALLY;
    F.orderTick[s] = currentTick;
}
// (The changed tiles' slots, for the metadata kernel: a heap list.)
let _simChgL = null;
function _simPresentStructureChanges(p) {
    let F = p.structures;
    if (!F || typeof tileEntityChangesSince !== 'function') return;
    let tiles = tileEntityChangesSince(p.teCursor || (p.teCursor = { epoch: -1, pos: 0 }));
    if (_simPresentDirtyTiles.length) {
        const d = _simPresentDirtyTiles; _simPresentDirtyTiles = [];
        tiles = tiles && tiles.length ? [...new Set([...tiles, ...d])] : [...new Set(d)];
    }
    const rally = p.rallyDirty === true;
    p.rallyDirty = false;
    if ((!tiles || !tiles.length) && !rally) return;
    if (!tiles) tiles = [];
    const S = _simStructSlots, T = _simPresentTileSlots(p);
    let count = Math.min(F.cap, p.structCount | 0), wrote = rally, nl = 0;
    if (!_simChgL || _simChgL.length < tiles.length || !simHeapHas(_simChgL)) _simChgL = simHeapArray(Int32Array, Math.max(1024, tiles.length * 2));
    const L = _simChgL;
    for (const t of tiles) {
        const gx = t % GRID_W, gy = (t - gx) / GRID_W;
        let e = typeof getTileEntityRef === 'function' ? getTileEntityRef(gx, gy) : null, kind = -1;
        const cell = grid[gy] && grid[gy][gx];
        // (A floor item is its tile's entity and its cell's item: kind 3; a mine, none here.)
        if (e) kind = typeof Tower !== 'undefined' && e instanceof Tower ? 0 : typeof Barrack !== 'undefined' && e instanceof Barrack ? 1 : hasSpawnQueue(e) ? 2 : cell && cell.item === e ? 3 : -1;
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
                pe._sslot = undefined; S.owner[prev] = null; S.free.push(prev); S.version++; S.psrcSet(prev, null);
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
        if (s >= F.cap || (!known && count >= F.cap)) { F = p.structures = _simStructTableGrow(F, Math.max(S.owner.length, count + 1)); count = Math.min(count, F.cap); }
        if (!known) F.order[count++] = s;
        L[nl++] = s;
        wrote = true;
    }
    // Their rows by the metadata kernel (both tables while a bigger one fills).
    if (nl) {
        const N = p.structuresNext;
        _simMetaStructsRun(p, F, S, T, L, nl, N);
        for (let i = 0; i < nl; i++) {
            const s = L[i];
            if (p.angles && s < p.angles.length) p.angles[s] = F.angle[s];
        }
    }
    if (!wrote) return;
    p.structCount = count;
    _simPresentAngles(p, F);
    _simInfoPackTable(F);
    simInfoPackStatDirCheck();
    p.worker.postMessage({type:'structures', table:_simStructTableMsg(F,{n:S.owner.length,count,mver:S.version,angles:p.angles,angleRev:p.angleRev}), revision:++p.revision});
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
    const p=_simPresentation, n=_pj.hw;
    let F=p.projectiles;
    if(!F || F.cap<n) {
        const cap=Math.max(64,Math.ceil(n*1.25/64)*64);
        F=p.projectiles=simTableViews(SIM_PROJ_SPEC,new SharedArrayBuffer(cap*SIM_PROJ_SPEC.slotBytes),cap);
    }
    yield;
    const j=simProjFill(F,n);
    simPresentationBind();
    p.worker.postMessage({type:'projectiles',table:{buf:F.buf,cap:F.cap,n,count:j,mver:_simProjPres.version},revision:++p.revision});
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

// The units' metadata by the kernel: false when it cannot run (no heap
// table, no kernel), the JavaScript pass instead.
// (false: the JavaScript pass, an A/B switch.)
let SIM_META_KERNEL = true;
const _simMeta = { tab: null, list: null, cnt: null, M: null, nt: -1, nw: -1, ns: -1 };
function _simMetaKernel(p) {
    const S = _simUnitState, M = p.meta;
    if (!SIM_META_KERNEL || !S || !M || !M.heap || !simHeapHas(M.heap) || typeof SIM_KERNEL_META_UNITS !== 'number' || typeof _simWasmX === 'undefined' || !_simWasmX || typeof _simWasmX.k_meta_units !== 'function') return false;
    const C = S.columns, n = Math.min(S.owners.length, M.cap), K = _simMeta;
    if (M.cap < S.owners.length) return false;
    // (The table's columns bound when it is another.)
    if (K.M !== M) { for (const k of [...SIM_META_I32, ...SIM_META_F32, ...SIM_META_I16, ...SIM_META_U8]) simParallelBind('pm.' + k, M[k]); K.M = M; }
    const W = C.oc_workerType, wd = W && W.data && simHeapHas(W.data) ? W.data : null;
    if (wd) simParallelBind('pm.wtid', wd);
    // (Codes: by type, by worker type id, by worker state.)
    const types = _simUnitTypeNames, nt = types.length, wv = W && W.pool ? W.pool.values : [], nw = wv.length, ns = SIM_WS_NAMES.length;
    const need = 3 * nt + nw + 32;
    if (!K.tab || K.tab.length < need || !simHeapHas(K.tab)) { if (K.tab) simHeapFree(K.tab); K.tab = simHeapArray(Int32Array, Math.max(1024, need * 2)); simParallelBind('pm.tab', K.tab); }
    const T = K.tab;
    for (let t = 0; t < nt; t++) {
        const st = BASE_UNIT_STATS[types[t]] || BASE_UNIT_STATS.norm;
        T[t] = _simFrameCode(types[t]); T[nt + t] = _simFrameCode(st.attackStyle || 'melee');
        T[2 * nt + t] = (st.isSnake ? SIM_UF_SNAKE : 0) | (types[t] === 'king' ? SIM_UF_KING : 0);
    }
    for (let w = 0; w < nw; w++) T[3 * nt + w] = _simFrameCode(wv[w]);
    for (let w = 0; w < 32; w++) T[3 * nt + nw + w] = w < ns ? _simFrameCode(SIM_WS_NAMES[w]) : 0;
    const room = Math.max(4096, n >> 4);
    if (!K.list || K.list.length < room || !simHeapHas(K.list)) { if (K.list) simHeapFree(K.list); K.list = simHeapArray(Int32Array, room); simParallelBind('pm.list', K.list); }
    if (!K.cnt || !simHeapHas(K.cnt)) { K.cnt = simHeapArray(Int32Array, 16); simParallelBind('pm.cnt', K.cnt); }
    K.cnt[0] = 0; K.cnt[1] = 0;
    const P = _simParams, per = 16384;
    P.fill(0, 0, 16);
    P[0] = n; P[1] = per; P[2] = typeof currentTick === 'number' ? currentTick : 0; P[3] = gameTime; P[4] = nt; P[5] = wd ? nw : 0; P[6] = wd ? wd.BYTES_PER_ELEMENT : 0; P[7] = room;
    P[8] = SIM_UF_FLYING; P[9] = SIM_UF_HOLD; P[10] = SIM_UF_RESEARCH_MATERIAL; P[11] = SIM_UF_ENERGY_BLOCKED;
    simParallelRun(SIM_KERNEL_META_UNITS, Math.ceil(Math.max(1, n) / per));
    // (The units it left: their full JavaScript write; past the list's room, every unit as before.)
    const listed = K.cnt[0], O = S.owners;
    if (listed > room) { for (let s = 0; s < n; s++) { const u = O.at(s); if (u) simPresentationWriteMetadata(u, M); } }
    else for (let i = 0; i < listed; i++) { const u = O.at(K.list[i]); if (u) simPresentationWriteMetadata(u, M); }
    if (K.cnt[1] > 0 && p.metaRev) Atomics.add(p.metaRev, 0, 1);
    return true;
}
// The structure metadata by the kernel (wasm/src/nfs.rs k_meta_structs).
const _simMetaP = new Float64Array(16);
let _simMetaB = null;
// (list, nl: only those slots' rows (the tick's changed tiles), into F and F2 if given.)
function _simMetaStructsRun(p, F, S, T, list = null, nl = 0, F2 = null) {
    _simMetaClassOf(null);
    const CL = _simMetaCls, CW = 56, nc = CL.length;
    if (!_simMetaB || !simHeapHas(_simMetaB.cls)) _simMetaB = { cls: simHeapArray(Int32Array, nc * CW), gone: null, cnt: simHeapArray(Int32Array, 4), res: null, ser: null, tslot: null, codes: [] };
    const B = _simMetaB, cls = B.cls, enc = a => a && typeof simHeapHas === 'function' && simHeapHas(a) ? _simWEnc(_simHeapPtrOf(a)) : 0;
    cls.fill(0);
    if (typeof structRallyClasses === 'function') structRallyClasses();
    const stt = statTablesStatic(), adj = _adjPlayerStats(stt), L1 = MAX_THING_LEVEL + 1;
    const KIND = [0, 1, 2, 2, 2, 2, 2, 2, 3, 4, 5];
    const COLS = { 11: '_stT', 12: '_ow', 13: '_uc', 14: '_en', 15: 'gx', 16: 'gy', 17: 'stacks', 18: 'manualStacks', 19: 'effectiveStacks', 20: 'level', 21: 'effectiveLevel', 22: 'isStacking',
        23: 'stackingWorkDone', 24: 'markedForSalvage', 25: 'autoUpgradeEnabled', 26: 'buildEnabled', 27: 'isUpgrading', 28: 'burning', 29: 'poisoned', 30: 'frozen', 31: 'wet', 32: 'sandy', 33: 'watched',
        34: 'watchedByTeam', 35: 'autoStackEnabled', 36: 'upgrademaxEnergy', 37: '_mxOv', 38: '_spt', 39: 'queueEnabled', 40: '_qN', 41: 'rallyX', 42: 'rallyY', 43: 'rallyTargetUnitId',
        44: 'autoResearchEnabled', 45: '_cdUntil', 46: 'angle', 47: 'laserState', 48: '_mv', 50: 'damage', 51: 'potentialEffectiveLevel' };
    for (let k = 0; k < nc; k++) {
        const C = CL[k], Tb = C ? _sTables.get(C) : null, b = k * CW;
        if (!Tb || !(Tb.n > 0)) continue;
        cls[b] = Tb.n; cls[b + 1] = _stAllIx.get(C) || 0; cls[b + 2] = KIND[k];
        for (const j in COLS) cls[b + (+j)] = enc(Tb['c_' + COLS[j]]);
        cls[b + 49] = enc(Tb.c_maxGold || Tb.c_maxAstar || null);
        // (The type and unit type ids: their pools' values as frame codes, stat keys, queued unit types.)
        const tc = Tb.c_type, uc = Tb.c_unitType;
        if (tc && tc.data) { cls[b + 3] = tc.data.BYTES_PER_ELEMENT; cls[b + 5] = enc(tc.data); }
        if (uc && uc.data) { cls[b + 4] = uc.data.BYTES_PER_ELEMENT; cls[b + 6] = enc(uc.data); }
        const tab = (name, vals, fn) => { const m = Math.max(1, vals.length); let a = B.codes[k * 4 + name]; if (!a || a.length < m || !simHeapHas(a)) a = B.codes[k * 4 + name] = simHeapArray(Int32Array, Math.max(64, m * 2)); for (let i = 0; i < vals.length; i++) a[i] = fn(vals[i]); return a; };
        const tv = tc && tc.pool ? tc.pool.values : [], uv = uc && uc.pool ? uc.pool.values : [];
        cls[b + 7] = enc(tab(0, tv, v => _simFrameCode(v)));
        cls[b + 8] = enc(tab(1, uv, v => _simFrameCode(v)));
        const keyOf = raw => { if (!raw) return -1; const kk = _normalizePlayerPrecomputedBuildingKey(normalizeBuildingResearchKey(raw)); return _statKeyIds.has(kk) ? _statKeyIds.get(kk) : -1; };
        cls[b + 9] = enc(KIND[k] === 1 ? tab(2, uv, v => keyOf(v ? 'barrack_' + v : null)) : tab(2, tv, v => keyOf(v)));
        cls[b + 10] = enc(KIND[k] === 1 ? tab(3, uv, v => _simFrameCode(v || 'norm')) : tab(3, tv, v => _simFrameCode(v ? getSpawnedUnitTypeForBuildingKey(v) : null)));
    }
    // (Each owner's research: done, required, a task, still to research.)
    const np = players.length;
    if (!B.res || B.res.length < 4 * np || !simHeapHas(B.res)) B.res = simHeapArray(Float64Array, Math.max(64, 8 * np));
    for (let o = 0; o < np; o++) {
        const task = players[o] ? getPlayerResearchTask(o) : null, b = 4 * o;
        B.res[b] = task ? Number(task.workDone) || 0 : 0; B.res[b + 1] = task ? Number(task.workRequired) || 0 : 0;
        B.res[b + 2] = task ? 1 : 0; B.res[b + 3] = task && (task.workDone || 0) < task.workRequired ? 1 : 0;
    }
    const nslots = Math.min(S.owner.length, F.cap, F2 ? F2.cap : F.cap);
    if (!B.gone || B.gone.length < nslots || !simHeapHas(B.gone)) { const m = Math.max(1024, nslots * 2); B.gone = simHeapArray(Int32Array, m); B.missK = simHeapArray(Int32Array, m); B.missS = simHeapArray(Int32Array, m); }
    S.psrcSet(Math.max(0, nslots - 1), S.owner[Math.max(0, nslots - 1)] || null);
    const spt = typeof _spp !== 'undefined' && _spp.tab && simHeapHas(_spp.tab) ? _spp.tab : null;
    const P = _simMetaP;
    P.fill(0);
    P[0] = nslots; P[1] = nc; P[2] = gameTime; P[3] = currentTick - 1; P[4] = TILE; P[5] = L1; P[6] = MAX_RESEARCH_LEVEL + 1; P[7] = stt.nk; P[8] = SPAWN_PROD_TYPES; P[9] = AREA_STEPS_MAX;
    P[10] = GRID_W; P[11] = GRID_W * GRID_H; P[12] = np + 1; P[13] = _precomputedStatsVersion; P[14] = nl;
    for (const Ft of F2 ? [F, F2] : [F]) {
    const args = [cls, S.psrc, _ST.ctab, _ST.rrow, _ST.own, _ST.brain, stt.mxe, stt.vis, stt.atk, stt.dmg, adj.rlv, adj.blx, spt, B.res, B.missK, B.missS];
    const F = Ft;
    for (const k of SIM_STRUCT_SPEC.f32) args.push(F[k]);
    for (const k of SIM_STRUCT_SPEC.i32) args.push(F[k]);
    args.push(F.order);
    for (const k of SIM_STRUCT_SPEC.i16) args.push(F[k]);
    for (const k of SIM_STRUCT_SPEC.u8) args.push(F[k]);
    const LM = typeof _laserMap !== 'undefined' && _laserMap.lslot && simHeapHas(_laserMap.lslot) ? _laserMap : null;
    args.push(T, S.pser, B.gone, B.cnt, list, _ST.val, LM && LM.lslot, LM && LM.pn, LM && LM.part, adj.rml);
    simRustDirect('k_meta_structs', args, P);
    // (Spawn cooldowns of keys not in the table for these stats: filled, written.)
    for (let i = 0, nm = B.cnt[2]; i < nm; i++) { const key = B.missK[i]; if (spt[key * 3 + 2] !== _precomputedStatsVersion) _spTabFill(spt, key, _precomputedStatsVersion); const v = spt[key * 3]; F.spawnCooldown[B.missS[i]] = v === v ? v : 0; }
    }
    if (list) return B.cnt[1];
    // The slots of structures gone: freed.
    for (let i = 0, ng = B.cnt[0]; i < ng; i++) {
        const s = B.gone[i], e = S.owner[s];
        if (e) { e._sslot = undefined; S.owner[s] = null; S.free.push(s); S.version++; }
        S.psrcSet(s, null);
    }
    return B.cnt[1];
}
function* simPresentationMetadata() {
    const p = _simPresentation;
    // Metadata changes more slowly than positions. This scan never runs in
    // _simTick, has no Atomics.wait, and yields every small block of records.
    // (The units' array itself, again after each yield: through the units
    // proxy two trapped reads a unit were ~600 ms of this thread per 10 s
    // at 390k units.)
    // (With the kernels and the table in the heap: every slot's unit at once
    // on the helpers, SIM_KERNEL_META_UNITS; the units it lists (no stat row's
    // steps) here.)
    if (_simMetaKernel(p)) yield;
    else {
    const view = () => _unitsPageView !== null ? _unitsPageView : unitsView();
    let list = view();
    for (let i=0;i<list.length;i++) {
        simPresentationWriteMetadata(list[i], p.meta);
        if ((i & 127) === 127) { yield; list = view(); }
    }
    }
    if (p.metaRev) Atomics.add(p.metaRev, 0, 1);
    simPresentationBind();
    p.worker.postMessage({type:'ready'});
    // (Index loops: for-of in a generator allocated an iteration result a
    // structure, ~5 MB a cycle at 65k structures.)
    const S = _simStructSlots, stamp = ++S.tick, lists = _simStructLists();
    // (Every structure has its slot from the tile journal, _simPresentStructureChanges;
    // all of them again only when the journal started over, a restore.)
    const tep = typeof _tileEntityEpoch === 'number' ? _tileEntityEpoch : -1;
    let n = 0;
    if (p.slotsEpoch !== tep) {
        for (let kind = 0; kind < lists.length; kind++) {
            const list = lists[kind];
            for (let i = 0; i < list.length; i++) {
                const e = list[i];
                if (e) { S.psrcSet(S.slotOf(e), e); n++; }
                if ((n & 127) === 127) yield;
            }
        }
        p.slotsEpoch = tep;
    }
    const cap = Math.max(64, S.owner.length, _simStructReserveCap);
    let F = p.structures, fresh = false;
    if (!F || F.cap < cap) {
        // (A bigger table is filled beside the shown one and takes its place
        // at the cycle's end: published before, half empty, every structure
        // not yet written looked gone for the frames meanwhile. The changes
        // of the ticks between go to both: _simPresentStructureChanges.)
        const R = _simStructReserved;
        if (R && R.cap >= cap && (!R.heap || simHeapHas(R.heap))) { F = R; _simStructReserved = null; }
        else F = _simStructTableNew(Math.ceil((cap > _simStructReserveCap ? cap * 1.25 : cap) / 64) * 64);
        if (p.structures) { p.structuresNext = F; fresh = true; } else p.structures = F;
    }
    let j=0;
    const T=_simPresentTileSlots(p);
    // (The table again after each yield: a tick's changes may have grown it
    // since, _simStructTableGrow.)
    const cur = () => fresh ? p.structuresNext : p.structures;
    {
        // Every tabled structure's row by the kernel; what it finds gone freed here.
        F = cur();
        j = _simMetaStructsRun(p, F, S, T);
        yield;
    }
    F = cur();
    S.orderChanged(F.order,j);
    simPresentationBind();
    if (fresh) { _simStructTableRetire(p.structures); p.structures = F; p.structuresNext = null; }
    p.structCount = j;
    _simPresentAngles(p, F);
    _simInfoPackTable(F);
    simInfoPackStatDirCheck();
    p.worker.postMessage({type:'structures', table:_simStructTableMsg(F,{n:S.owner.length,count:j,mver:S.version,angles:p.angles,angleRev:p.angleRev}), revision:++p.revision});
    // The cells: the reader reads the simulation's columns (map.js cellType,
    // cellOwner: shared) and computes the display delta; nothing copied here.
    // (When a tile changed, or every few seconds.)
    const tev = typeof _tileEntityVersion === 'number' ? _tileEntityVersion : -1, nowMs = performance.now();
    if (p.cells === cellType && p.cellsVersion === tev && nowMs - (p.cellsAt || 0) < 5000) return;
    p.cellsVersion = tev; p.cellsAt = nowMs; p.cells = cellType;
    p.worker.postMessage({type:'cells', ctype:cellType, cowner:cellOwner, width:GRID_W});
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

// ---- the info panel's packer (src/audio_visual/info_pack_worker.js) ----
// A thread of the page's that bins a selection's structures from the
// structure table above with a kernel (info.rs k_info_bins). What it needs,
// made once at its first request: the kernels' module and memory and a
// stack (as a helper's), and heap blocks of its own: a header with where the
// structure table is now ([0] its byte address (0: none in the heap), [1]
// its slots, [2] a version), the selection's members (slot, serial, group), the bin table
// and the bins. Nothing of the match reads them.
const SIM_INFO_PACK_MEMBERS = 1 << 18, SIM_INFO_PACK_BINS = 8192, SIM_INFO_BIN_FIELDS = 21;
let _simInfoPack = null;
function simInfoPackPayload() {
    // (Asked again at a new match: the same blocks, the directory and table now.)
    if (_simInfoPack) { _simInfoPack.msg.stats = simInfoPackStatDir(); const p = _simPresentation; if (p && p.structures) { _simInfoPack.A.hdr[0] = 0; _simInfoPackTable(p.structures); } return _simInfoPack.msg; }
    if (typeof simWasmHelperPayload !== 'function' || _simHeapPtrOf === null || !_simHeap.ready) return null;
    const w = simWasmHelperPayload();
    if (!w) return null;
    const M = SIM_INFO_PACK_MEMBERS, B = SIM_INFO_PACK_BINS;
    const A = { hdr: simHeapArray(Uint32Array, 4), slots: simHeapArray(Int32Array, M), sers: simHeapArray(Int32Array, M), groups: simHeapArray(Int32Array, M),
        binOf: simHeapArray(Int32Array, M), table: simHeapArray(Int32Array, B * 2 * 3), bins: simHeapArray(Float64Array, B * SIM_INFO_BIN_FIELDS), out: simHeapArray(Int32Array, 4) };
    const at = {};
    for (const k in A) { const p = _simHeapPtrOf(A[k]); if (!(p >= 0)) return null; at[k] = p; }
    _simInfoPack = { A, msg: { wasm: w, at, members: M, bins: B, tableEntries: B * 2, binFields: SIM_INFO_BIN_FIELDS, tile: TILE, stats: null,
        spec: { f32: SIM_STRUCT_SPEC.f32, i32: SIM_STRUCT_SPEC.i32, i16: SIM_STRUCT_SPEC.i16, u8: SIM_STRUCT_SPEC.u8 } } };
    const p = _simPresentation;
    if (p && p.structures) _simInfoPackTable(p.structures);
    _simInfoPack.msg.stats = simInfoPackStatDir();
    return _simInfoPack.msg;
}
// The table the packer reads: the shown one (from its publication on).
function _simInfoPackTable(F) {
    const I = _simInfoPack;
    if (!I || !F) return;
    // (Byte addresses up to 4 GiB: unsigned; 0 none.)
    const H = I.A.hdr, at = F.heap ? F.off : 0;
    if (H[0] === at && H[1] === F.cap) return;
    Atomics.store(H, 1, at > 0 ? F.cap : 0);
    Atomics.store(H, 0, at);
    Atomics.add(H, 2, 1);
}
// The stat tables (data_dynamic.js _flatThingStatEntry) as the packer reads
// them in place: per owner, kind and key, the table's byte address, its
// levels, strides and stat names (the columns). Made again when a table was
// (re)made (_thingStatDirVersion); research rewrites the numbers in place.
let _simInfoStatDirSent = -1;
function simInfoPackStatDir() {
    if (typeof _thingStatTables === 'undefined' || _simHeapPtrOf === null) return null;
    // (Tables made before the heap was up: into it now, at the match's start.)
    for (const t of _thingStatTables.values()) {
        if (_simHeapPtrOf(t.data) >= 0) continue;
        const d = simHeapArray(Float32Array, t.data.length);
        if (_simHeapPtrOf(d) < 0) continue;
        d.set(t.data); t.data = d; _thingStatDirVersion++;
    }
    const tables = [];
    for (const [id, t] of _thingStatTables) {
        const p = _simHeapPtrOf(t.data);
        if (!(p >= 0)) continue;
        const [owner, kind, key] = id.split('|');
        tables.push({ owner: Number(owner), kind, key, at: p, levels: t.levels, rowStride: t.rowStride, statStride: t.statStride, cols: t.schema.keys });
    }
    _simInfoStatDirSent = _thingStatDirVersion;
    return { version: _thingStatDirVersion, tables };
}
// (A table made again during play, a new schema: the packer's directory too.)
function simInfoPackStatDirCheck() {
    if (!_simInfoPack || typeof _thingStatDirVersion === 'undefined' || _thingStatDirVersion === _simInfoStatDirSent) return;
    const dir = simInfoPackStatDir();
    if (dir) _simPost({ type: 'infoPackStats', stats: dir });
}
