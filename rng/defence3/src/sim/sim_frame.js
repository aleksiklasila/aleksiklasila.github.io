"use strict";
// ============================================================
// SIMULATION FRAMES (worker -> page, units)
//
// Each tick the simulation worker writes what the page needs of every unit
// into one ArrayBuffer: typed-array columns indexed by the unit's render
// slot (stable while the unit lives, reused after it dies), plus the unit
// list's order as slots. The buffer is transferred (moved, not copied) to
// the page, which reads units straight from it and hands it back when the
// next frame arrives; the worker reuses returned buffers (a small ring).
// Nothing is diffed, encoded or decoded: the cost is one sequential write
// per unit per tick, and moving a frame costs the same at any size.
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
    SIM_UF_RESEARCH_MATERIAL = 4096, SIM_UF_TRANSFER = 8192, SIM_UF_ATTACK_TARGET = 16384, SIM_UF_KING = 32768;

const SIM_UNIT_STATUS_NAMES = ['walk', 'angry', 'work', 'sleep'];
const _simUnitStatusCode = { walk: 0, angry: 1, work: 2, sleep: 3 };

// Typed-array views of a frame buffer laid out for `cap` slots.
function simFrameViews(buf, cap) {
    let f = { buf, cap }, off = 0;
    for (let k of SIM_FRAME_F32) { f[k] = new Float32Array(buf, off, cap); off += 4 * cap; }
    for (let k of SIM_FRAME_I32) { f[k] = new Int32Array(buf, off, cap); off += 4 * cap; }
    f.order = new Int32Array(buf, off, cap); off += 4 * cap;
    for (let k of SIM_FRAME_I16) { f[k] = new Int16Array(buf, off, cap); off += 2 * cap; }
    for (let k of SIM_FRAME_U8) { f[k] = new Uint8Array(buf, off, cap); off += cap; }
    return f;
}

// ---- worker side ----

// Render slots: a small index per living unit, reused after it dies.
// lastX/lastY: where the unit was in the last frame (its next frame's start).
const _simRenderSlots = { owner: [], free: [], stamp: new Int32Array(0), tick: 0, lastX: new Float64Array(0), lastY: new Float64Array(0), version: 0 };
// String codes: 0 is none (null, undefined or '').
const _simFrameStrings = { codes: new Map(), list: [''], sent: 1 };
// Buffers the page gave back.
const _simFramePool = [];

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
    if (buf && buf.byteLength && _simFramePool.length < 12) _simFramePool.push(buf);
}

function _simFrameAcquire(bytes) {
    let P = _simFramePool;
    for (let i = P.length - 1; i >= 0; i--) {
        let b = P[i];
        if (b.byteLength >= bytes && b.byteLength <= bytes * 4 + 65536) { P.splice(i, 1); return b; }
    }
    return new ArrayBuffer(Math.ceil(bytes * 1.25) + 4096);
}

// A pooled buffer of exactly this size (per-tick grids).
function _simFrameAcquireExact(bytes) {
    let P = _simFramePool;
    for (let i = P.length - 1; i >= 0; i--) if (P[i].byteLength === bytes) return P.splice(i, 1)[0];
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
        let gx = new Float64Array(cap), gy = new Float64Array(cap);
        gx.set(R.lastX); gy.set(R.lastY);
        R.lastX = gx; R.lastY = gy;
    }
    R.lastX[slot] = u.prevX; R.lastY[slot] = u.prevY;
    return slot;
}

const _simVisPhase = [0, 0];
let _simFrameOrderLast = null;

// This tick's frame. Returns { buf, cap, n, count, mver, strings } (transfer buf).
function simFrameEncode() {
    let R = _simRenderSlots;
    let stampTick = ++R.tick;
    let list = units, count = list.length;
    // Slots first (a new unit takes one), so the size is known.
    let live = 0;
    for (let i = 0; i < count; i++) { let u = list[i]; if (!u.dead) { _simRenderSlotOf(u); live++; } }
    let n = R.owner.length;
    let cap = Math.max(64, n);
    let buf = _simFrameAcquire(cap * SIM_FRAME_SLOT_BYTES);
    let F = simFrameViews(buf, cap);
    if (R.stamp.length < n) { let grown = new Int32Array(Math.max(1024, n * 2)); grown.set(R.stamp); R.stamp = grown; }
    let order = F.order, k = 0, orderChanged = !_simFrameOrderLast || _simFrameOrderLast.length !== live;
    let flagsA = F.flags;
    for (let i = 0; i < count; i++) {
        let u = list[i];
        if (u.dead) continue;
        let s = u._rslot;
        R.stamp[s] = stampTick;
        if (!orderChanged && _simFrameOrderLast[k] !== s) orderChanged = true;
        order[k++] = s;
        F.id[s] = u.id;
        F.x[s] = u.x; F.y[s] = u.y; F.px[s] = R.lastX[s]; F.py[s] = R.lastY[s];
        R.lastX[s] = u.x; R.lastY[s] = u.y;
        F.vx[s] = Number(u.vx) || 0; F.vy[s] = Number(u.vy) || 0;
        F.energy[s] = u.energy;
        let pc = u.preComputed;
        F.maxEnergy[s] = pc ? pc.maxEnergy : u.energy;
        F.r[s] = u.r;
        let at = u.attackTarget;
        let flags = (u.isFlying ? SIM_UF_FLYING : 0) | (u.isSnake ? SIM_UF_SNAKE : 0) | (u.isWorker ? SIM_UF_WORKER : 0)
            | (u.holdPosition ? SIM_UF_HOLD : 0) | (u.burning > 0 ? SIM_UF_BURNING : 0) | (u.poisoned > 0 ? SIM_UF_POISONED : 0)
            | (u.frozen > 0 ? SIM_UF_FROZEN : 0) | (u.wet > 0 ? SIM_UF_WET : 0) | (u.sandy > 0 ? SIM_UF_SANDY : 0)
            | (u.watched > 0 ? SIM_UF_WATCHED : 0) | (u.teleportHideTicks > 0 ? SIM_UF_HIDDEN : 0)
            | (Number.isFinite(u._energyBlockedUntil) && gameTime < u._energyBlockedUntil ? SIM_UF_ENERGY_BLOCKED : 0)
            | (u.researcherHasMaterial ? SIM_UF_RESEARCH_MATERIAL : 0) | (u.workerTransferCooldown > 0 ? SIM_UF_TRANSFER : 0)
            | (at && Number.isFinite(at.x) ? SIM_UF_ATTACK_TARGET : 0) | (u.isKing ? SIM_UF_KING : 0);
        flagsA[s] = flags;
        F.tx[s] = at ? at.x : 0; F.ty[s] = at ? at.y : 0;
        let eff = u.preComputedEffective;
        F.vision[s] = eff && Number.isFinite(eff.visionRangeArea) ? eff.visionRangeArea : getEntityEffectiveVisibilityRangeArea(u);
        F.cargo[s] = Number(u.carryingValue) || 0;
        F.owner[s] = u.owner;
        F.watchedBy[s] = Number.isFinite(u.watchedByTeam) ? u.watchedByTeam : -1;
        F.level[s] = Number.isFinite(u.effectiveLevel) ? u.effectiveLevel : -1;
        F.blevel[s] = Number.isFinite(u.unitLevel) ? u.unitLevel : -1;
        F.type[s] = _simFrameCode(u.unitType);
        F.wtype[s] = _simFrameCode(u.workerType);
        F.wstate[s] = _simFrameCode(u.workerState);
        F.style[s] = _simFrameCode(u.attackStyle);
        let flash = Number(u.attackFlash) || 0;
        F.flash[s] = flash <= 0 ? 0 : flash >= 255 ? 255 : flash;
        F.cmd[s] = u.commandState | 0;
        // Look: activity, facing, walk phase, status face, own light, panel.
        if (u.isSnake) {
            let act = getUnit3DActivity(u);
            F.mode[s] = 0; F.amount[s] = 0;
            F.facing[s] = Math.atan2(Number(u.vx) || 0, Number(u.vy) || 1);
            F.phase[s] = 0; F.prate[s] = 0;
            F.status[s] = _simUnitStatusCode[getUnit3DStatusState(u, act)] || 0;
        } else {
            let activity = getUnit3DActivity(u);
            if (activity.mode !== 0 || activity.amount > 0 || u._visStill === undefined) u._visStill = gameTime;
            activity = _unit3DIdleActivity(u, activity, u._visStill);
            let fx = Number(u.vx) || 0, fy = Number(u.vy) || 0;
            if (activity.target && Number.isFinite(activity.target.x) && Number.isFinite(activity.target.y)) {
                fx = activity.target.x - u.x; fy = activity.target.y - u.y;
            }
            F.mode[s] = activity.mode;
            F.amount[s] = Math.max(0, Math.min(1, activity.amount || Math.min(1, Math.hypot(u.x - u.prevX, u.y - u.prevY) / Math.max(.01, TILE * .025)) || 0));
            F.facing[s] = Math.atan2(fx, fy || 0.0001) || 0;
            _unit3DWalkPhaseLinear(u, activity, _simVisPhase);
            F.phase[s] = _simVisPhase[0]; F.prate[s] = _simVisPhase[1];
            F.status[s] = _simUnitStatusCode[getUnit3DStatusState(u, activity)] || 0;
        }
        F.light[s] = getVisualUnitSourceLight(u);
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
    let R = _simRenderSlots, out = [];
    for (let j = 0; j + 1 < _simWatched.length; j += 2) {
        let id = _simWatched[j], slot = _simWatched[j + 1];
        let u = slot >= 0 ? R.owner[slot] : null;
        if (!u || u.id !== id) { u = null; for (let c of units) if (c.id === id) { u = c; break; } }
        if (!u || u.dead) continue;
        let d = { id };
        for (let k of SIM_DETAIL_FIELDS) { let v = u[k]; if (v !== undefined && (v === null || typeof v !== 'object')) d[k] = v; }
        for (let k of SIM_DETAIL_REFS) { let v = u[k]; d[k] = v ? _simRef(v) || (Number.isFinite(v.x) ? { x: v.x, y: v.y } : null) : null; }
        for (let k of SIM_DETAIL_STATS) d[k] = _simPlainStats(u[k]);
        let p = u.path;
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
        this.id = id;
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
