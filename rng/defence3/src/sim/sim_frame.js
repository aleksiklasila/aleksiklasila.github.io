"use strict";
// ============================================================
// SIMULATION FRAMES (worker -> page, units)
//
// Each tick the simulation worker writes what the page needs of every unit
// into one buffer: typed-array columns indexed by the unit's render
// slot (stable while the unit lives, reused after it dies), plus the unit
// list's order as slots. With isolation the buffer is shared with helpers
// and the page; otherwise it is transferred. The page owns an immutable
// frame until it hands it back. Helpers finish writing before publication.
// Core fields come directly from authoritative unit columns; reference and
// UI fields are gathered on the simulation thread. No per-unit messages.
//
// Strings (unit and worker types, worker states, attack styles) travel as
// codes; each frame lists the codes it introduces.
//
// The page sees units as PageUnit views: objects bound to a slot whose
// fields read the current frame, so page code (drawing, selection, input,
// panels) reads them as it reads units. Fields a frame does not carry
// (paths, targets, full stats) come in detail records for the units the
// page watches (the selection): see simFrameDetail.
// ============================================================

const SIM_FRAME_F32 = ['x', 'y', 'px', 'py', 'vx', 'vy', 'energy', 'maxEnergy', 'tx', 'ty', 'facing', 'amount', 'phase', 'prate',
    'light', 'sig', 'r', 'vision', 'cargo'];
const SIM_FRAME_I32 = ['id', 'flags'];
const SIM_FRAME_I16 = ['owner', 'watchedBy', 'level', 'blevel', 'type', 'wtype', 'wstate', 'style'];
const SIM_FRAME_U8 = ['mode', 'status', 'flash', 'cmd'];
// Bytes per slot: the columns, and the order entry (int32).
const SIM_FRAME_SLOT_BYTES = 4 * (SIM_FRAME_F32.length + SIM_FRAME_I32.length + 1) + 2 * SIM_FRAME_I16.length + SIM_FRAME_U8.length;

// flags
const SIM_UF_FLYING = 1, SIM_UF_SNAKE = 2, SIM_UF_WORKER = 4, SIM_UF_HOLD = 8, SIM_UF_BURNING = 16, SIM_UF_POISONED = 32,
    SIM_UF_FROZEN = 64, SIM_UF_WET = 128, SIM_UF_SANDY = 256, SIM_UF_WATCHED = 512, SIM_UF_HIDDEN = 1024, SIM_UF_ENERGY_BLOCKED = 2048,
    SIM_UF_RESEARCH_MATERIAL = 4096, SIM_UF_TRANSFER = 8192, SIM_UF_ATTACK_TARGET = 16384, SIM_UF_KING = 32768,
    // (Team + history: drawn where it was last seen, frozen; presentation_worker.js.)
    SIM_UF_GHOST = 65536;

const SIM_UNIT_STATUS_NAMES = ['walk', 'angry', 'work', 'sleep'];
const _simUnitStatusCode = { walk: 0, angry: 1, work: 2, sleep: 3 };

// Typed-array views of a frame buffer laid out for `cap` slots.
function simFrameViews(buf, cap) {
    return { buf, cap,
        x: new Float32Array(buf, 0 * cap, cap),
        y: new Float32Array(buf, 4 * cap, cap),
        px: new Float32Array(buf, 8 * cap, cap),
        py: new Float32Array(buf, 12 * cap, cap),
        vx: new Float32Array(buf, 16 * cap, cap),
        vy: new Float32Array(buf, 20 * cap, cap),
        energy: new Float32Array(buf, 24 * cap, cap),
        maxEnergy: new Float32Array(buf, 28 * cap, cap),
        tx: new Float32Array(buf, 32 * cap, cap),
        ty: new Float32Array(buf, 36 * cap, cap),
        facing: new Float32Array(buf, 40 * cap, cap),
        amount: new Float32Array(buf, 44 * cap, cap),
        phase: new Float32Array(buf, 48 * cap, cap),
        prate: new Float32Array(buf, 52 * cap, cap),
        light: new Float32Array(buf, 56 * cap, cap),
        sig: new Float32Array(buf, 60 * cap, cap),
        r: new Float32Array(buf, 64 * cap, cap),
        vision: new Float32Array(buf, 68 * cap, cap),
        cargo: new Float32Array(buf, 72 * cap, cap),
        id: new Int32Array(buf, 76 * cap, cap),
        flags: new Int32Array(buf, 80 * cap, cap),
        order: new Int32Array(buf, 84 * cap, cap),
        owner: new Int16Array(buf, 88 * cap, cap),
        watchedBy: new Int16Array(buf, 90 * cap, cap),
        level: new Int16Array(buf, 92 * cap, cap),
        blevel: new Int16Array(buf, 94 * cap, cap),
        type: new Int16Array(buf, 96 * cap, cap),
        wtype: new Int16Array(buf, 98 * cap, cap),
        wstate: new Int16Array(buf, 100 * cap, cap),
        style: new Int16Array(buf, 102 * cap, cap),
        mode: new Uint8Array(buf, 104 * cap, cap),
        status: new Uint8Array(buf, 105 * cap, cap),
        flash: new Uint8Array(buf, 106 * cap, cap),
        cmd: new Uint8Array(buf, 107 * cap, cap),
    };
}

// ---- worker side ----

// Render slots: a small index per living unit, reused after it dies.
// lastX/lastY: where the unit was in the last frame (its next frame's start).
const _simRenderSlots = { owner: [], free: [], stamp: new Int32Array(0), tick: 0, lastX: new Float32Array(0), lastY: new Float32Array(0), version: 0 };
// String codes: 0 is none (null, undefined or '').
const _simFrameStrings = { codes: new Map(), list: [''], sent: 1 };
// Buffers the page gave back.
const _simFramePool = [];
// Shared buffers return from postMessage as new JS wrappers. A trailer token
// resolves them to the worker's canonical wrapper and persistent helper binding.
// Without this, rebinding on every tick makes helpers miss each new frame job.
const _simSharedFrames = new Map();
let _simSharedFrameId = 0;
function _simFrameBindBuffer(buf) {
    if (!SIM_PAR_SHARED) { simParallelBind('frame.buffer.0', new Uint8Array(buf)); return 0; }
    const trailer = new DataView(buf, buf.byteLength - 4, 4);
    let id = trailer.getUint32(0, true);
    if (!id || !_simSharedFrames.has(id)) {
        id = ++_simSharedFrameId; trailer.setUint32(0, id, true);
        _simSharedFrames.set(id, buf);
        simParallelBind('frame.buffer.' + id, new Uint8Array(buf));
    }
    return id;
}

function simFrameReset() {
    let R = _simRenderSlots;
    for (let u of R.owner) if (u) u._rslot = undefined;
    R.owner = []; R.free = []; R.version++;
    _simFrameOrderLast = null;
    _simFrameStrings.sent = 1;   // the page starts over: every code is new to it
}

function _simFrameCode(s) {
    if (s === undefined || s === null || s === '') return 0;
    let S = _simFrameStrings, c = S.codes.get(s);
    if (c === undefined) { c = S.list.length; S.list.push(String(s)); S.codes.set(s, c); }
    return c;
}

function simFrameReturn(buf) {
    if (!buf || !buf.byteLength) return;
    if (typeof SharedArrayBuffer === 'function' && buf instanceof SharedArrayBuffer) {
        const id = new DataView(buf, buf.byteLength - 4, 4).getUint32(0, true);
        buf = _simSharedFrames.get(id);
        if (!buf || _simFramePool.includes(buf)) return;
    }
    if (_simFramePool.length >= 12) {
        const old = _simFramePool.shift();
        if (typeof SharedArrayBuffer === 'function' && old instanceof SharedArrayBuffer) {
            const id = new DataView(old, old.byteLength - 4, 4).getUint32(0, true);
            _simSharedFrames.delete(id); simParallelBind('frame.buffer.' + id, null);
        }
    }
    _simFramePool.push(buf);
}

function _simFrameAcquire(bytes, shared = false) {
    let P = _simFramePool;
    for (let i = P.length - 1; i >= 0; i--) {
        let b = P[i];
        if ((typeof SharedArrayBuffer === 'function' && b instanceof SharedArrayBuffer) === shared
            && b.byteLength >= bytes + (shared ? 4 : 0) && b.byteLength <= bytes * 4 + 65536) { P.splice(i, 1); return b; }
    }
    const Type = shared ? SharedArrayBuffer : ArrayBuffer;
    return new Type(Math.ceil(bytes * 1.25) + 4096);
}

// A pooled buffer of exactly this size (per-tick grids).
function _simFrameAcquireExact(bytes) {
    let P = _simFramePool;
    for (let i = P.length - 1; i >= 0; i--) if (P[i] instanceof ArrayBuffer && P[i].byteLength === bytes) return P.splice(i, 1)[0];
    return new ArrayBuffer(bytes);
}

function _simSignatureHash(u) {
    // Half of the units per tick (by id): a panel change reaches the page at
    // most a tick later.
    let rec0 = u._r3dSig;
    if (rec0 && rec0.hash !== undefined && ((u.id + _simRenderSlots.tick) & 1)) return rec0.hash;
    let sig = get3DExact2DVisualSignature(u, true);
    let rec = u._r3dSig;
    if (rec && rec.hashFor === sig) return rec.hash;
    let h = 2166136261 | 0;
    for (let i = 0; i < sig.length; i++) h = Math.imul(h ^ sig.charCodeAt(i), 16777619);
    // Exact in a float32: 24 bits.
    h = (h >>> 0) & 0xffffff;
    if (rec) { rec.hashFor = sig; rec.hash = h; }
    return h;
}

function _simRenderSlotOf(u) {
    let R = _simRenderSlots, slot = u._rslot;
    if (slot !== undefined && R.owner[slot] === u) return slot;
    slot = R.free.length ? R.free.pop() : R.owner.length;
    R.owner[slot] = u;
    u._rslot = slot;
    R.version++;
    if (R.lastX.length <= slot) {
        let cap = Math.max(1024, (slot + 1) * 2);
        let gx = simSharedArray(Float32Array, cap), gy = simSharedArray(Float32Array, cap);
        gx.set(R.lastX); gy.set(R.lastY);
        R.lastX = gx; R.lastY = gy;
        simParallelBind('frame.lastX', gx); simParallelBind('frame.lastY', gy);
    }
    R.lastX[slot] = u.prevX; R.lastY[slot] = u.prevY;
    return slot;
}

let _simFrameOrderLast = null;
const _simFrameInput = { cap: 0 };
function _simFrameGrowInput(n) {
    const S = _simFrameInput;
    if (S.cap >= n) return S;
    S.cap = Math.max(1024, n, S.cap * 2);
    for (const k of ['slot', 'targetX', 'targetY', 'still', 'flash']) {
        S[k] = simSharedArray(k === 'slot' ? Int32Array : k === 'flash' ? Uint8Array : Float32Array, S.cap);
        simParallelBind('frame.' + k, S[k]);
    }
    return S;
}

// This tick's frame. Returns { buf, cap, n, count, mver, strings } (transfer buf).
function simFrameEncode() {
    let R = _simRenderSlots;
    let stampTick = ++R.tick;
    let list = units, count = list.length;
    // Large matches use the GPU's compact shapes at every zoom. Do not
    // spend simulation time making signatures/poses for panels never drawn.
    const compact = count >= 5000;
    // Slots first (a new unit takes one), so the size is known.
    let live = 0;
    for (let i = 0; i < count; i++) { let u = list[i]; if (!u._us.dead[u._si]) { _simRenderSlotOf(u); live++; } }
    let n = R.owner.length;
    let cap = Math.max(64, n);
    let buf = _simFrameAcquire(cap * SIM_FRAME_SLOT_BYTES, SIM_PAR_SHARED);
    let F = simFrameViews(buf, cap);
    let input = _simFrameGrowInput(cap);
    if (R.stamp.length < n) { let grown = new Int32Array(Math.max(1024, Math.ceil(n * 1.125 / 4096) * 4096)); grown.set(R.stamp); R.stamp = grown; }
    let order = F.order, k = 0, orderChanged = !_simFrameOrderLast || _simFrameOrderLast.length !== live;
    let flagsA = F.flags;
    for (let i = 0; i < count; i++) {
        let u = list[i];
        const C = u._us, slot = u._si;
        if (C.dead[slot]) continue;
        let s = u._rslot;
        R.stamp[s] = stampTick;
        if (!orderChanged && _simFrameOrderLast[k] !== s) orderChanged = true;
        order[k++] = s;
        input.slot[s] = u._si;
        let pc = u.preComputed;
        F.maxEnergy[s] = pc ? pc.maxEnergy : C.energy[slot];
        let at = u.attackTarget;
        let flags = (u.isFlying ? SIM_UF_FLYING : 0) | (u.isSnake ? SIM_UF_SNAKE : 0) | (u.isWorker ? SIM_UF_WORKER : 0)
            | (u.holdPosition ? SIM_UF_HOLD : 0)
            | (Number.isFinite(u._energyBlockedUntil) && gameTime < u._energyBlockedUntil ? SIM_UF_ENERGY_BLOCKED : 0)
            | (u.researcherHasMaterial ? SIM_UF_RESEARCH_MATERIAL : 0)
            | (at && Number.isFinite(at.x) ? SIM_UF_ATTACK_TARGET : 0) | (u.isKing ? SIM_UF_KING : 0);
        flagsA[s] = flags;
        F.tx[s] = at ? at.x : 0; F.ty[s] = at ? at.y : 0;
        let eff = u.preComputedEffective;
        F.vision[s] = eff && Number.isFinite(eff.visionRangeArea) ? eff.visionRangeArea : getEntityEffectiveVisibilityRangeArea(u);
        F.cargo[s] = Number(u.carryingValue) || 0;
        F.watchedBy[s] = Number.isFinite(u.watchedByTeam) ? u.watchedByTeam : -1;
        F.type[s] = _simFrameCode(u.unitType);
        F.wtype[s] = _simFrameCode(u.workerType);
        F.wstate[s] = _simFrameCode(u.workerState);
        F.style[s] = _simFrameCode(u.attackStyle);
        let flash = C.attackFlash[slot];
        // Numeric status/level/flash fields are gathered by the frame kernel.
        // Calling the generic status accessors here used most of the encoder's
        // time at 100k units, despite the values already living in columns.
        F.light[s] = C.owner[slot] === localPlayerId || (C.watched[slot] > 0 && u.watchedByTeam === localPlayerId)
            ? Math.max(0, F.vision[s] * AREA_UNIT_TILE_EQUIVALENT) : 0;
        // Look: activity, facing, walk phase, status face, own light, panel.
        if (compact) {
            input.still[s] = gameTime; input.flash[s] = 0;
            input.targetX[s] = input.targetY[s] = NaN;
            F.mode[s] = 0; F.amount[s] = 0; F.status[s] = 0;
            F.sig[s] = 0;
            continue;
        }
        let activity = getUnit3DActivity(u);
        if (!u.isSnake && (activity.mode !== 0 || activity.amount > 0 || u._visStill === undefined)) u._visStill = gameTime;
        input.still[s] = u._visStill;
        input.flash[s] = flash;
        const target = activity.target;
        input.targetX[s] = target && Number.isFinite(target.x) && Number.isFinite(target.y) ? target.x : NaN;
        input.targetY[s] = target ? target.y : NaN;
        F.mode[s] = activity.mode; F.amount[s] = activity.amount;
        F.status[s] = _simUnitStatusCode[getUnit3DStatusState(u, activity)] || 0;
        F.sig[s] = _simSignatureHash(u);
    }
    // Slots of units no longer in the list are free again (marked empty).
    for (let slot = 0; slot < n; slot++) {
        if (R.stamp[slot] !== stampTick) {
            F.id[slot] = -1; flagsA[slot] = 0;
            if (R.owner[slot]) { R.owner[slot]._rslot = undefined; R.owner[slot] = null; R.free.push(slot); R.version++; }
        }
    }
    if (orderChanged) { _simFrameOrderLast = order.slice(0, live); R.version++; }
    const bufferId = _simFrameBindBuffer(buf);
    const P = _simParams;
    P[0] = cap; P[1] = live; P[2] = 256; P[3] = gameTime; P[4] = TICK_RATE; P[5] = TILE; P[6] = tickAlpha;
    P[7] = RENDERER3D_IDLE_DELAY_SECONDS; P[8] = RENDERER3D_IDLE_SETTLE_SECONDS;
    P[9] = bufferId;
    simParallelRun(SIM_KERNEL_UNIT_FRAME, Math.ceil(live / P[2]));
    return { buf, cap, n, count: live, mver: R.version };
}

// Details the page watches (its selection): what a frame does not carry,
// for these units only. Entities as refs: ['u', id] or ['b', gx, gy].
const SIM_DETAIL_FIELDS = ['pathIndex', 'workerTargetType', 'effectiveStacks', 'stacks', 'stackCount', 'baseLevel',
    'baseLevelAstarCost', 'astarCost', '_astarBudgetBlockedUntil', '_energyBlockedUntil', '_forcedTargetLastSeenX', '_forcedTargetLastSeenY',
    'watched', 'burning', 'poisoned', 'frozen', 'wet', 'sandy', 'teleportHideTicks', 'workerTransferCooldown', 'carryingValue',
    'attackTimer', 'collisionR', 'fireResistant', 'iceResistant', 'laserResistant', 'poisonResistant', 'waterResistant', 'sandResistant',
    'turretImmune', 'manualStacks', 'upKeep'];
const SIM_DETAIL_REFS = ['targetUnit', 'targetBuilding', 'attackTarget', 'workerTarget', 'forcedAttackTarget', 'target'];
const SIM_DETAIL_STATS = ['preComputed', 'basePreComputed', 'preComputedEffective', 'preComputedBase'];
let _simWatched = [];
function _simPlainStats(o) {
    if (!o || typeof o !== 'object') return null;
    let out = {};
    for (let k in o) { let v = o[k]; if (v === null || typeof v !== 'object' && typeof v !== 'function') out[k] = v; }
    return out;
}
function simFrameDetails() {
    if (!_simWatched.length) return null;
    let R = typeof _simPresentation !== 'undefined' && _simPresentation ? {owner:_simUnitState.owners} : _simRenderSlots, out = [];
    for (let j = 0; j + 1 < _simWatched.length; j += 2) {
        let id = _simWatched[j], slot = _simWatched[j + 1];
        let u = slot >= 0 ? R.owner[slot] : null;
        if (!u || u.id !== id) { u = null; for (let c of units) if (c.id === id) { u = c; break; } }
        if (!u || u.dead) continue;
        let d = { id };
        for (let k of SIM_DETAIL_FIELDS) { let v = u[k]; if (v !== undefined && (v === null || typeof v !== 'object')) d[k] = v; }
        for (let k of SIM_DETAIL_REFS) { let v = u[k]; d[k] = v ? _simRef(v) || (Number.isFinite(v.x) ? { x: v.x, y: v.y } : null) : null; }
        for (let k of SIM_DETAIL_STATS) d[k] = _simPlainStats(u[k]);
        let p = typeof unitDisplayPath === 'function' ? unitDisplayPath(u) : u.path;
        if (Array.isArray(p)) {
            let from = Math.max(0, (u.pathIndex | 0) - 1), pts = new Float32Array(Math.max(0, p.length - from) * 2);
            for (let i = from, q = 0; i < p.length; i++) { pts[q++] = p[i] ? p[i].x : 0; pts[q++] = p[i] ? p[i].y : 0; }
            d.path = pts; d.pathFrom = from; d.pathLength = p.length;
        } else d.path = null;
        let pt = u._pendingPathTarget;
        d._pendingPathTarget = pt ? { x: pt.x, y: pt.y } : null;
        out.push(d);
    }
    return out;
}
function simFrameWatch(list) { _simWatched = Array.isArray(list) ? list.slice(0, 1024) : []; }

// ---- page side ----

// Where the current frame's columns are read from (PageUnit fields).
let _pageFrame = null;
const _pageFrameStrings = [''];

// A unit as the page sees it: bound to its frame slot while it lives;
// afterwards (dead) its last values. Page-only state (render caches,
// flashes) is set on it as on a unit.
class PageUnit {
    constructor(id, slot) {
        Object.defineProperty(this, 'id', { value: id, writable: true, enumerable: true });
        this._s = slot;
        this.dead = false;
        this._last = null;   // last values, once dead
        this._det = null;    // detail record (watched units)
        this._at = { x: 0, y: 0 };
        this._ox = undefined; this._oy = undefined;
    }
    _col(k) { let s = this._s; return s >= 0 ? _pageFrame[k][s] : (this._last ? this._last[k] : 0); }
    _flag(bit) { return (this._col('flags') & bit) !== 0; }
    _str(k) { return _pageFrameStrings[this._col(k)] || undefined; }
    _detail(k) { let d = this._det; return d ? d[k] : undefined; }
    // Its values now, kept when it dies.
    _freeze() {
        let s = this._s, F = _pageFrame, last = {};
        if (s >= 0 && F) {
            for (let k of SIM_FRAME_F32) last[k] = F[k][s];
            for (let k of SIM_FRAME_I32) last[k] = F[k][s];
            for (let k of SIM_FRAME_I16) last[k] = F[k][s];
            for (let k of SIM_FRAME_U8) last[k] = F[k][s];
        }
        this._last = last;
        this._s = -1;
    }
    // A position set on the page (the 2D pass draws units at their
    // interpolated position, then sets it back): kept until set back to
    // the frame's value.
    get x() { return this._ox !== undefined ? this._ox : this._col('x'); }
    get y() { return this._oy !== undefined ? this._oy : this._col('y'); }
    set x(v) { this._ox = v === this._col('x') ? undefined : v; }
    set y(v) { this._oy = v === this._col('y') ? undefined : v; }
    get prevX() { return this._col('px'); }
    get prevY() { return this._col('py'); }
    get vx() { return this._col('vx'); }
    get vy() { return this._col('vy'); }
    get energy() { return this._col('energy'); }
    get maxEnergy() { return this._col('maxEnergy'); }
    get r() { return this._col('r'); }
    get owner() { return this._col('owner'); }
    get watchedByTeam() { let v = this._col('watchedBy'); return v >= 0 ? v : undefined; }
    get effectiveLevel() { let v = this._col('level'); return v >= 0 ? v : undefined; }
    get unitLevel() { let v = this._col('blevel'); return v >= 0 ? v : undefined; }
    get unitType() { return this._str('type'); }
    get workerType() { return this._str('wtype'); }
    get workerState() { return this._str('wstate'); }
    get attackStyle() { return this._str('style'); }
    get attackFlash() { return this._col('flash'); }
    get commandState() { return this._col('cmd'); }
    get carryingValue() { return this._col('cargo'); }
    get isFlying() { return this._flag(SIM_UF_FLYING); }
    get isSnake() { return this._flag(SIM_UF_SNAKE); }
    get isWorker() { return this._flag(SIM_UF_WORKER); }
    get isKing() { return this._flag(SIM_UF_KING); }
    get holdPosition() { return this._flag(SIM_UF_HOLD); }
    get burning() { let d = this._detail('burning'); return d !== undefined ? d : this._flag(SIM_UF_BURNING) ? 1 : 0; }
    get poisoned() { let d = this._detail('poisoned'); return d !== undefined ? d : this._flag(SIM_UF_POISONED) ? 1 : 0; }
    get frozen() { let d = this._detail('frozen'); return d !== undefined ? d : this._flag(SIM_UF_FROZEN) ? 1 : 0; }
    get wet() { let d = this._detail('wet'); return d !== undefined ? d : this._flag(SIM_UF_WET) ? 1 : 0; }
    get sandy() { let d = this._detail('sandy'); return d !== undefined ? d : this._flag(SIM_UF_SANDY) ? 1 : 0; }
    get watched() { let d = this._detail('watched'); return d !== undefined ? d : this._flag(SIM_UF_WATCHED) ? 1 : 0; }
    get teleportHideTicks() { return this._flag(SIM_UF_HIDDEN) ? 1 : 0; }
    get workerTransferCooldown() { let d = this._detail('workerTransferCooldown'); return d !== undefined ? d : this._flag(SIM_UF_TRANSFER) ? 1 : 0; }
    get researcherHasMaterial() { return this._flag(SIM_UF_RESEARCH_MATERIAL); }
    get _energyBlockedUntil() { return this._flag(SIM_UF_ENERGY_BLOCKED) ? gameTime + 1 : undefined; }
    get attackTarget() {
        if (!this._flag(SIM_UF_ATTACK_TARGET)) return null;
        let t = this._at; t.x = this._col('tx'); t.y = this._col('ty'); return t;
    }
    get vis() { let s = BASE_UNIT_STATS[this.unitType]; return s ? s.vis : undefined; }
    get color() { let s = BASE_UNIT_STATS[this.unitType]; return s ? s.color : undefined; }
    get collisionR() { let d = this._detail('collisionR'); return d !== undefined ? d : this.r; }
    // Stats: the watched unit's own, else what the frame has.
    get preComputed() { return this._detail('preComputed') || this._effStats(); }
    get preComputedEffective() { return this._detail('preComputedEffective') || this._effStats(); }
    get basePreComputed() { return this._detail('basePreComputed') || this._frameStats(); }
    // Effective stats unwatched: the frame's energy and vision over the table's.
    _effStats() {
        let base = this._frameStats(), st = this._fest;
        if (!st || Object.getPrototypeOf(st) !== base) st = this._fest = Object.create(base);
        st.visionRangeArea = this._col('vision'); st.maxEnergy = this._col('maxEnergy');
        return st;
    }
    // Unwatched: its owner's stats for its type at its level (the page's
    // copy of the stat tables), else the little the frame has.
    _frameStats() {
        let map = typeof PRECOMPUTED_STATS_MAP_PLAYER !== 'undefined' ? PRECOMPUTED_STATS_MAP_PLAYER[this.owner] : null;
        if (map && map.unit) {
            let key = typeof _normalizePlayerPrecomputedUnitKey === 'function' ? _normalizePlayerPrecomputedUnitKey(this.unitType) : this.unitType;
            let byLevel = map.unit[key], lvl = Math.max(1, this._col('level'));
            let entry = byLevel ? (byLevel[lvl] || byLevel[1]) : null;
            if (entry) return entry;
        }
        let st = this._fst || (this._fst = {});
        st.maxEnergy = this.maxEnergy; st.visionRangeArea = this._col('vision');
        return st;
    }
    // Watched units: paths, targets and the rest from their detail record.
    get path() {
        let d = this._det;
        if (!d || !d.path) return null;
        if (d._pathArr && d._pathFor === d.path) return d._pathArr;
        let arr = new Array(d.pathLength), p = d.path;
        for (let i = 0, q = 0; i < d.pathLength; i++) arr[i] = i < d.pathFrom ? null : { x: p[q++], y: p[q++] };
        d._pathArr = arr; d._pathFor = d.path;
        return arr;
    }
    get pathIndex() { let d = this._detail('pathIndex'); return d !== undefined ? d : 0; }
    get _pendingPathTarget() { return this._detail('_pendingPathTarget') || null; }
    get targetUnit() { return _pageResolveDetailRef(this, 'targetUnit'); }
    get targetBuilding() { return _pageResolveDetailRef(this, 'targetBuilding'); }
    get workerTarget() { return _pageResolveDetailRef(this, 'workerTarget'); }
    get forcedAttackTarget() { return _pageResolveDetailRef(this, 'forcedAttackTarget'); }
    get target() { return _pageResolveDetailRef(this, 'target'); }
    get workerTargetType() { return this._detail('workerTargetType'); }
    get effectiveStacks() { return this._detail('effectiveStacks'); }
    get stacks() { return this._detail('stacks'); }
    get stackCount() { return this._detail('stackCount'); }
    get baseLevel() { return this._detail('baseLevel'); }
    get astarCost() { return this._detail('astarCost'); }
    get baseLevelAstarCost() { return this._detail('baseLevelAstarCost'); }
    get _astarBudgetBlockedUntil() { return this._detail('_astarBudgetBlockedUntil'); }
    get _forcedTargetLastSeenX() { return this._detail('_forcedTargetLastSeenX'); }
    get _forcedTargetLastSeenY() { return this._detail('_forcedTargetLastSeenY'); }
    get upKeep() { return this._detail('upKeep'); }
    get gx() { return Math.floor(this.x / TILE); }
    get gy() { return Math.floor(this.y / TILE); }
    // Resistances and immunities: the unit type's.
    get fireResistant() { let s = BASE_UNIT_STATS[this.unitType]; return !!(s && s.fireResistant); }
    get iceResistant() { let s = BASE_UNIT_STATS[this.unitType]; return !!(s && s.iceResistant); }
    get laserResistant() { let s = BASE_UNIT_STATS[this.unitType]; return !!(s && s.laserResistant); }
    get poisonResistant() { let s = BASE_UNIT_STATS[this.unitType]; return !!(s && s.poisonResistant); }
    get waterResistant() { let s = BASE_UNIT_STATS[this.unitType]; return !!(s && s.waterResistant); }
    get sandResistant() { let s = BASE_UNIT_STATS[this.unitType]; return !!(s && s.sandResistant); }
    get turretImmune() { let s = BASE_UNIT_STATS[this.unitType]; return !!(s && s.turretImmune); }
    // Its activity as the worker read it (getUnit3DActivity).
    _activity() {
        let a = this._act || (this._act = { mode: 0, amount: 0, target: null });
        a.mode = this._col('mode'); a.amount = this._col('amount');
        a.target = a.mode === 1 ? this.attackTarget : null;
        return a;
    }
}
PageUnit.prototype._frameView = true;
// A view is a unit to the page's code (instanceof Unit, its methods such as
// draw), with every field it reads coming from the frame.
if (typeof Unit === 'function') Object.setPrototypeOf(PageUnit.prototype, Unit.prototype);

// Detail refs resolve to what the page has: a unit view or a structure.
let _pageUnitsById = new Map();
function _pageResolveDetailRef(u, k) {
    let d = u._det;
    let ref = d ? d[k] : null;
    if (!ref) return null;
    if (!Array.isArray(ref)) return ref;   // a position
    if (ref[0] === 'u') return _pageUnitsById.get(ref[1]) || null;
    let gx = ref[1], gy = ref[2];
    let cell = grid[gy] && grid[gy][gx];
    return (typeof getTileEntityRef === 'function' ? getTileEntityRef(gx, gy) : null) || (cell && cell.item) || null;
}
