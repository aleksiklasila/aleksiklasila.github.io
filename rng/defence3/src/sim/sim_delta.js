"use strict";
// ============================================================
// SIMULATION DELTA STREAM
//
// The simulation worker runs the ticks; the page keeps a full copy of the
// world (rendering and UI read it directly) updated after every tick by
// what changed, encoded here on the worker (simDeltaEncode) and applied on
// the page (simDeltaApply):
//
// - Hot fields: numeric fields that change often (positions, timers,
//   counters...), as typed arrays (transferable): only the fields that
//   changed since the last tick, per entity (its index and a field mask).
//   A value that is not a number, undefined, null or a boolean makes its
//   entity send a row instead.
// - Rows: every other field goes through the snapshot codec (references,
//   stat pointers, paths...): an entity whose non-hot fields changed since
//   it was last sent (a generated comparator per property layout), or that
//   is new, is encoded in full (snapEncodeState with explicit entities).
// - List order when membership changed (spawns, deaths, placements...), the
//   globals, players and projectiles every tick, and changed grid cells.
//
// Fields changed in place inside nested objects are not seen by the
// comparator; what drives behaviour is still caught by the rolling state
// hash check (see the page side) and repaired from the worker.
// ============================================================

// Numeric fields that change often, per snapshot list (measured on large
// battles). (prevX/prevY are the page's own: where it last had a unit.)
// Units' other (cold) fields are compared every SIM_DELTA_FULL_TICKS ticks
// for all units, otherwise only for units with a discrete hot change or on
// their staggered tick (see simDeltaEncode).
// (21: coprime with SNAP_HASH_SLICES, so the page's check of full ticks
// covers every hash slice in turn.)
const SIM_DELTA_FULL_TICKS = 21;
const SIM_DELTA_COLD_STAGGER = 8;
// Hot fields whose change marks a new decision (a command, a path step or
// request, a level, a load...): the unit's other fields are compared then.
// (Motion, timers and counters change every tick without one.)
const SIM_DELTA_TRIGGER_FIELDS = new Set(['commandState', 'pathIndex', 'effectiveStacks', 'effectiveLevel', '_lastAppliedEffectiveLevel',
    '_astarLastChargedTick', '_workerNextIdleRetargetTick', 'builderHasMaterial', '_workerLastPathTick', '_awaitGroupPath', '_builderNextRecheckTick']);
// Tests: compare every unit's fields every tick.
let simDeltaAlwaysFull = false;

const SIM_DELTA_HOT_FIELDS = {
    u: ['x', 'y', 'vx', 'vy', 'pathIndex', 'energy', 'attackTimer', 'attackFlash', 'commandState', 'effectiveStacks',
        'effectiveLevel', '_lastAppliedEffectiveLevel', '_effectiveStatsRecalcCounter', '_thingStatsRecalcCounter', '_astarLastChargedTick',
        '_astarLastChargedToKey', '_astarLastChargedFromKey', '_workerNextIdleRetargetTick', '_builderLastWatchX', '_builderLastWatchY',
        '_builderLastMoveTick', 'workerTransferCooldown', 'wet', 'frozen', 'burning', 'poisoned', 'sandy', 'watched', 'teleportHideTicks',
        'builderHasMaterial', '_workerLastPathTick', '_collectorLastMoveTick', '_healerLastMoveTick', '_researchLastMoveTick', '_awaitGroupPath',
        '_builderNextRecheckTick'],
    t: ['cd', 'energy', '_thingStatsRecalcCounter'],
    b: ['energy', '_thingStatsRecalcCounter'],
    s: ['energy', '_thingStatsRecalcCounter'],
    f: ['energy', '_thingStatsRecalcCounter', 'damage'],
    d: ['timer']
};
// Lists compared field by field (players and projectiles go whole).
const SIM_DELTA_LISTS = ['u', 't', 'b', 's', 'f', 'g', 'a', 'd'];
// Snapshot hasher per list. Buildings, mines and items (at most a few
// hundred) are also compared by a full content hash each tick: their nested
// state (production queues, stat objects...) is changed in place, which the
// field comparator cannot see.
const SIM_DELTA_HASH_KIND = { t: 'b', b: 'b', s: 'b', f: 'b', g: 'm', a: 'm', d: 'd' };

// Content hash of an entity without its hot fields (those travel in the
// typed arrays every tick; a tower's cooldown would otherwise make it a row
// every tick). They are set aside while hashing and put back.
const _simHashHotSaved = [];
function _simContentHash(list, kind, e) {
    let hot = SIM_DELTA_HOT_FIELDS[list] || [];
    for (let i = 0; i < hot.length; i++) { let f = hot[i]; _simHashHotSaved[i] = e[f]; if (f in e) e[f] = 0; }
    let h = _snapHashEntity(kind, e, 7);
    for (let i = 0; i < hot.length; i++) { let f = hot[i]; if (f in e) e[f] = _simHashHotSaved[i]; }
    return h;
}

// Hot value kinds: the value itself (number) or one of these.
// ABSENT: the entity has no such field (left as is on the page).
const SIM_HOT_NUMBER = 0, SIM_HOT_UNDEFINED = 1, SIM_HOT_NULL = 2, SIM_HOT_TRUE = 3, SIM_HOT_FALSE = 4, SIM_HOT_ABSENT = 5;

let _simDeltaEnc = null;
let _simHotScratchV = new Float64Array(64), _simHotScratchK = new Uint8Array(64);

// Generated per list, with the field names written out (dynamic keyed access
// was most of the cost): pack(e, v, k, base) writes the hot values of e,
// returns false when one is not representable; unpack(e, v, k, base) sets
// them, returns true when x or y changed.
const _simHotCodecs = {};
function _simHotCodec(list) {
    let c = _simHotCodecs[list];
    if (c) return c;
    let fields = SIM_DELTA_HOT_FIELDS[list] || [];
    let pack = 'let x, ok = true;\n' + fields.map((f, i) => {
        let a = 'e[' + JSON.stringify(f) + ']', j = 'base + ' + i;
        return `x = ${a}; if (typeof x === 'number') { v[${j}] = x; k[${j}] = 0; } else if (x === undefined) k[${j}] = (${JSON.stringify(f)} in e) ? 1 : 5; `
            + `else if (x === null) k[${j}] = 2; else if (x === true) k[${j}] = 3; else if (x === false) k[${j}] = 4; else ok = false;`;
    }).join('\n') + '\nreturn ok;';
    let unpack = 'let kind, moved = false;\n' + fields.map((f, i) => {
        let a = 'e[' + JSON.stringify(f) + ']', j = 'base + ' + i;
        let set = `kind = k[${j}]; if (kind === 0) ${a} = v[${j}]; else if (kind !== 5) ${a} = kind === 1 ? undefined : kind === 2 ? null : kind === 3;`;
        if (f === 'x' || f === 'y') set = `kind = k[${j}]; if (kind === 0) { if (${a} !== v[${j}]) { ${a} = v[${j}]; moved = true; } } else if (kind !== 5) { ${a} = kind === 1 ? undefined : kind === 2 ? null : kind === 3; moved = true; }`;
        return set;
    }).join('\n') + '\nreturn moved;';
    c = _simHotCodecs[list] = { pack: new Function('e', 'v', 'k', 'base', pack), unpack: new Function('e', 'v', 'k', 'base', unpack) };
    return c;
}
// Page side: the changed hot fields of one entity (mask bits over the list's
// fields, values from v/k at p on). Returns the next p; _simHotMoved tells
// whether x or y changed.
let _simHotMoved = false;
const _simHotMaskedCodecs = {};
function _simHotMaskedUnpack(list) {
    let fn = _simHotMaskedCodecs[list];
    if (fn) return fn;
    let fields = SIM_DELTA_HOT_FIELDS[list] || [];
    let body = 'let kind, moved = false;\n' + fields.map((f, i) => {
        let a = 'e[' + JSON.stringify(f) + ']', word = i < 32 ? 'lo' : 'hi', bit = i % 32;
        let set = f === 'x' || f === 'y'
            ? `kind = k[p]; if (kind === 0) { if (${a} !== v[p]) { ${a} = v[p]; moved = true; } } else if (kind !== 5) { ${a} = kind === 1 ? undefined : kind === 2 ? null : kind === 3; moved = true; }`
            : `kind = k[p]; if (kind === 0) ${a} = v[p]; else if (kind !== 5) ${a} = kind === 1 ? undefined : kind === 2 ? null : kind === 3;`;
        return `if ((${word} >>> ${bit}) & 1) { ${set} p++; }`;
    }).join('\n') + '\n_simHotMoved = moved; return p;';
    return (_simHotMaskedCodecs[list] = new Function('e', 'lo', 'hi', 'v', 'k', 'p', body));
}

// Enumerable keys of an entity (its own: class methods are not enumerable).
function _simKeyCount(e) {
    let n = 0;
    for (let k in e) n++;
    return n;
}

const _simDeltaShapes = new Map(); // layout key -> { cold: [field], compare(e, vals), copy(e) }

function _simDeltaShape(list, e) {
    let keys = Object.keys(e);
    let hot = SIM_DELTA_HOT_FIELDS[list] || [];
    let layout = list + '|' + keys.join(',');
    let shape = _simDeltaShapes.get(layout);
    if (shape) return shape;
    let hotSet = new Set(hot);
    let cold = keys.filter(k => !hotSet.has(k) && !SNAP_SKIP_KEYS.has(k));
    let acc = k => 'e[' + JSON.stringify(k) + ']';
    // Changed: not identical, and not both NaN.
    let body = cold.map((k, i) => `(${acc(k)} !== v[${i}] && (${acc(k)} === ${acc(k)} || v[${i}] === v[${i}]))`).join(' || ') || 'false';
    shape = {
        layout, cold, nkeys: keys.length,
        changed: new Function('e', 'v', 'return ' + body + ';'),
        copy: new Function('e', 'return [' + cold.map(acc).join(', ') + '];')
    };
    _simDeltaShapes.set(layout, shape);
    return shape;
}

// Encoder baseline: call when the page's copy was set from a full snapshot
// of the current state (match start, resync).
// Each entity carries its encoder entry (e._simEnc: what the page was last
// sent), tagged with the encoder generation and the tick it was last seen.
let _simDeltaGen = 0;
function simDeltaEncoderReset() {
    let lists = {};
    let gen = ++_simDeltaGen;
    for (let list of SIM_DELTA_LISTS) {
        let arr = _snapListEntities(list);
        let hashKind = SIM_DELTA_HASH_KIND[list];
        let keys = new Array(arr.length);
        let nf = (SIM_DELTA_HOT_FIELDS[list] || []).length, codec = _simHotCodec(list);
        for (let i = 0; i < arr.length; i++) {
            let e = arr[i];
            if (!('_simEnc' in e)) e._simEnc = null;
            let shape = _simDeltaShape(list, e);
            let entry = { gen, stamp: 0, shape, vals: shape.copy(e), h: hashKind ? _simContentHash(list, hashKind, e) : 0, hv: null, hk: null };
            if (nf) { entry.hv = new Float64Array(nf); entry.hk = new Uint8Array(nf); codec.pack(e, entry.hv, entry.hk, 0); }
            e._simEnc = entry;
            keys[i] = _snapEntityKey(list, e, i);
        }
        lists[list] = { arr: arr.slice(), keys };
    }
    let n = GRID_W * GRID_H;
    let types = new Int32Array(n), owners = new Int32Array(n);
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) { types[y * GRID_W + x] = grid[y][x].type; owners[y * GRID_W + x] = grid[y][x].owner; }
    _simDeltaEnc = { gen, tick: 0, lists, types, owners, gridW: GRID_W, gridH: GRID_H };
}

// This tick's changes since the last call. Transfer out.hot[*].v/k buffers.
function simDeltaEncode() {
    if (!_simDeltaEnc || _simDeltaEnc.gridW !== GRID_W || _simDeltaEnc.gridH !== GRID_H) simDeltaEncoderReset();
    let enc = _simDeltaEnc;
    enc.tick = (enc.tick || 0) + 1;
    // A full tick compares every unit's fields: the page's copy is then
    // exact (it checks its hash on those ticks).
    let full = simDeltaAlwaysFull || (enc.tick % SIM_DELTA_FULL_TICKS) === 0;
    let entities = new Map(), orders = new Set(), regions = new Set();
    let hot = {};
    let rowCount = 0;
    // Buildings sent as rows (their level labels are redrawn on the page), and
    // whether the map's cached layers need a redraw.
    let built = [];
    let dirtyMap = false;
    let rowsBy = {};
    for (let list of SIM_DELTA_LISTS) {
        let st = enc.lists[list];
        let arr = _snapListEntities(list);
        let fields = SIM_DELTA_HOT_FIELDS[list] || [];
        let nf = fields.length;
        let codec = _simHotCodec(list);
        let hashKind = SIM_DELTA_HASH_KIND[list];
        let sv = _simHotScratchV.length >= nf ? _simHotScratchV : (_simHotScratchV = new Float64Array(nf));
        let sk = _simHotScratchK.length >= nf ? _simHotScratchK : (_simHotScratchK = new Uint8Array(nf));
        let cIdx = [], cMask = [], cV = [], cK = [];
        let items = [];
        let triggerLo = 0, triggerHi = 0;
        for (let f = 0; f < nf; f++) if (SIM_DELTA_TRIGGER_FIELDS.has(fields[f])) { if (f < 32) triggerLo |= 1 << f; else triggerHi |= 1 << (f - 32); }
        let membershipChanged = arr.length !== st.keys.length;
        let keys = new Array(arr.length);
        for (let i = 0; i < arr.length; i++) {
            let e = arr[i];
            let key = _snapEntityKey(list, e, i);
            keys[i] = key;
            if (!membershipChanged && st.keys[i] !== key) membershipChanged = true;
            if (list !== 'u' && !('_simEnc' in e)) e._simEnc = null;
            let prev = e._simEnc;
            if (prev && prev.gen !== enc.gen) prev = null;
            let dirty = !prev;
            let shape = prev ? prev.shape : null;
            // Hot fields first: which of them changed decides, for a unit,
            // whether its other fields are compared this tick.
            let packed = !nf || codec.pack(e, sv, sk, 0);
            if (!packed) dirty = true;
            let hv = prev ? prev.hv : null, hk = prev ? prev.hk : null;
            let discrete = true;
            if (nf) {
                if (!hv) { hv = new Float64Array(nf); hk = new Uint8Array(nf).fill(255); }
                let lo = 0, hi = 0;
                for (let f = 0; f < nf; f++) {
                    let kv = sk[f], vv = sv[f];
                    if (kv !== hk[f] || (kv === 0 && vv !== hv[f])) {
                        if (f < 32) lo |= 1 << f; else hi |= 1 << (f - 32);
                        cV.push(kv === 0 ? vv : 0); cK.push(kv);
                        hv[f] = vv; hk[f] = kv;
                    }
                }
                if (lo || hi) { cIdx.push(i); cMask.push(lo >>> 0, hi >>> 0); }
                // Unrepresentable: the row has it; compare afresh next tick.
                if (!packed) hk.fill(255);
                discrete = ((lo & triggerLo) | (hi & triggerHi)) !== 0;
            }
            // The other fields. Units: when a trigger field changed (see
            // SIM_DELTA_TRIGGER_FIELDS), on the unit's
            // staggered tick (1 in SIM_DELTA_COLD_STAGGER) and on every full
            // tick; the rest of the time a unit's other fields may reach the
            // page up to a full interval late (see SIM_DELTA_FULL_TICKS).
            // Buildings and items (few): every tick.
            if (!dirty && (list !== 'u' || full || discrete || ((i + enc.tick) % SIM_DELTA_COLD_STAGGER) === 0)) {
                if (shape.changed(e, prev.vals)) dirty = true;
                // A changed property layout (a field added or removed) is a
                // new shape. (The own key count is compared first, without
                // building the layout key.)
                else if (_simKeyCount(e) !== shape.nkeys && _simDeltaShape(list, e) !== shape) dirty = true;
            }
            let h = 0;
            if (hashKind) {
                h = _simContentHash(list, hashKind, e);
                if (prev && h !== prev.h) dirty = true;
            }
            if (dirty) {
                // Same layout (key count): the shape is kept; else looked up.
                if (!shape || _simKeyCount(e) !== shape.nkeys) shape = _simDeltaShape(list, e);
                items.push([e, i]);
                rowCount++;
                if (list === 't' || list === 'b' || list === 's' || list === 'f') built.push(list, i);
            }
            if (dirty) e._simEnc = { gen: enc.gen, stamp: enc.tick, shape, vals: shape.copy(e), h, hv, hk };
            else { if (!prev.hv) { prev.hv = hv; prev.hk = hk; } prev.stamp = enc.tick; }
        }
        if (membershipChanged) {
            if (list !== 'u' && list !== 'd') dirtyMap = true;
            if (SNAP_ORDER_LISTS.includes(list)) orders.add(list);
            else {
                // Floor items: the regions where one came or went.
                let now = new Set(keys);
                for (let k of st.keys) if (!now.has(k)) { let [gx, gy] = String(k).split(',').map(Number); regions.add(_snapRegion(gx, gy)); }
                let was = new Set(st.keys);
                for (let k of keys) if (!was.has(k)) { let [gx, gy] = String(k).split(',').map(Number); regions.add(_snapRegion(gx, gy)); }
            }
        }
        if (items.length) { entities.set(list, items); rowsBy[list] = items.length; }
        // A unit that left the list: the copy keeps its reservation entry (as
        // a dead placeholder) unless told otherwise; when the authority freed
        // or reassigned it (a worker dying clears its target), that entry's
        // region goes out with its reservations.
        if (list === 'u' && membershipChanged && typeof workerReservedTiles !== 'undefined') {
            for (let e of st.arr) {
                let prev = e._simEnc;
                if (!prev || prev.gen !== enc.gen || prev.stamp === enc.tick) continue;
                let at = prev.shape.cold.indexOf('_workerReservedTileIndex');
                let slot = at >= 0 ? prev.vals[at] : -1;
                if (Number.isInteger(slot) && slot >= 0 && slot < workerReservedTiles.length && workerReservedTiles[slot] !== e) regions.add(_snapReservationRegion(slot));
            }
        }
        st.arr = arr.slice();
        st.keys = keys;
        if (nf) hot[list] = { n: arr.length, fields: nf, idx: Int32Array.from(cIdx), mask: Uint32Array.from(cMask),
            v: Float64Array.from(cV), k: Uint8Array.from(cK) };
    }
    // Grid cells whose type or owner changed.
    let cells = [];
    for (let y = 0; y < GRID_H; y++) {
        let row = grid[y];
        for (let x = 0; x < GRID_W; x++) {
            let i = y * GRID_W + x, c = row[x];
            if (c.type !== enc.types[i] || c.owner !== enc.owners[i]) {
                enc.types[i] = c.type; enc.owners[i] = c.owner;
                cells.push(i, c.type, c.owner);
            }
        }
    }
    let S = snapEncodeState({ buckets: { regions, players: true, projectiles: true, orders, entities, grid: false } });
    if (cells.length) { S.cells = (S.cells || []).concat(cells); dirtyMap = true; }
    // Per-player pathfinding budgets: hashed, not in the snapshot codec.
    let budgets = [pathfindBudgetByPlayer ? pathfindBudgetByPlayer.slice() : null,
        astarNodeBudgetRemainingByPlayer ? astarNodeBudgetRemainingByPlayer.slice() : null];
    return { S, hot, rows: rowCount, rowsBy, built, dirtyMap, budgets, full };
}

// Page side: apply one tick's changes to the page's copy of the world.
function simDeltaApply(delta) {
    let unitsBefore = units;
    snapDecodeState(delta.S);
    // Units leave the list only when they die; others may still point at
    // them (a target), and their removal carries no row.
    if (units !== unitsBefore) {
        let alive = new Set(units);
        for (let u of unitsBefore) if (!alive.has(u)) u.dead = true;
    }
    for (let list in delta.hot) {
        let h = delta.hot[list];
        let arr = _snapListEntities(list);
        if (arr.length !== h.n) throw new Error(`sim delta: ${list} has ${arr.length}, expected ${h.n}`);
        let unpack = _simHotMaskedUnpack(list);
        let idx = h.idx, mask = h.mask, v = h.v, k = h.k, p = 0;
        let isUnits = list === 'u';
        for (let j = 0; j < idx.length; j++) {
            let e = arr[idx[j]];
            p = unpack(e, mask[2 * j], mask[2 * j + 1], v, k, p);
            // Units that moved to another chunk or area are re-indexed
            // (selection and range queries); the page's own per-chunk
            // statistics serve only its occasional queries.
            if (_simHotMoved && isUnits && (e._spatialKey !== getSpatialKey(e.x, e.y) || e._spatialAreaId !== getAreaIdAtWorld(e.x, e.y))) updateUnitSpatial(e);
        }
    }
    if (delta.budgets) {
        if (delta.budgets[0]) pathfindBudgetByPlayer = delta.budgets[0];
        if (delta.budgets[1]) astarNodeBudgetRemainingByPlayer = delta.budgets[1];
    }
    let built = delta.built;
    if (built && built.length && typeof updateItemTextCache === 'function') {
        for (let j = 0; j < built.length; j += 2) {
            let e = _snapListEntities(built[j])[built[j + 1]];
            if (e) updateItemTextCache(e);
        }
    }
}

// ---- Unit visual records (worker, each tick) ----
// What the page's 3D unit layer needs per unit that follows from simulation
// state alone, computed here where that state lives (the worker has time to
// spare), SIM_UNIT_VIS_STRIDE floats per unit in list order:
//   activity mode, amount, facing (rad), walk phase at the tick, phase rate
//   per tick of interpolation, status icon code, the unit's own light range
//   for the local player, a hash of its 2D panel's visual signature (the
//   page redraws a panel only when this changes), its render slot (stable
//   while it lives: the page keeps per-slot render data), position and
//   previous position (world px), and id.
const SIM_UNIT_VIS_STRIDE = 14;
// Render slots: a small index per living unit, reused after it dies.
// lastX/lastY: the position the page was last sent (the start of the next
// interpolation, a group of ticks back).
const _simRenderSlots = { owner: [], free: [], stamp: new Int32Array(0), tick: 0, lastX: new Float64Array(0), lastY: new Float64Array(0) };
const SIM_UNIT_STATUS_NAMES = ['walk', 'angry', 'work', 'sleep'];
const _simUnitStatusCode = { walk: 0, angry: 1, work: 2, sleep: 3 };
const _simVisPhase = [0, 0];

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
    if (R.lastX.length <= slot) {
        let cap = Math.max(1024, (slot + 1) * 2);
        let gx = new Float64Array(cap), gy = new Float64Array(cap);
        gx.set(R.lastX); gy.set(R.lastY);
        R.lastX = gx; R.lastY = gy;
    }
    R.lastX[slot] = u.prevX; R.lastY[slot] = u.prevY;
    return slot;
}

// ticks: how many ticks the result covers (the page interpolates over them).
function simUnitVisEncode(ticks = 1) {
    let n = units.length, S = SIM_UNIT_VIS_STRIDE;
    let out = new Float32Array(n * S);
    let R = _simRenderSlots;
    let stampTick = ++R.tick;
    if (R.stamp.length < R.owner.length + n) { let grown = new Int32Array((R.owner.length + n) * 2); grown.set(R.stamp); R.stamp = grown; }
    for (let i = 0; i < n; i++) {
        let u = units[i], o = i * S;
        if (u.dead) { out[o + 8] = -1; continue; }
        let slot = _simRenderSlotOf(u);
        if (R.stamp.length <= slot) { let grown = new Int32Array((slot + 1) * 2); grown.set(R.stamp); R.stamp = grown; }
        R.stamp[slot] = stampTick;
        out[o + 8] = slot;
        out[o + 9] = u.x; out[o + 10] = u.y; out[o + 11] = R.lastX[slot]; out[o + 12] = R.lastY[slot];
        R.lastX[slot] = u.x; R.lastY[slot] = u.y;
        out[o + 13] = u.id;
        if (u.isSnake) {
            let act = getUnit3DActivity(u);
            out[o] = 0; out[o + 1] = 0;
            out[o + 2] = Math.atan2(Number(u.vx) || 0, Number(u.vy) || 1);
            out[o + 3] = 0; out[o + 4] = 0;
            out[o + 5] = _simUnitStatusCode[getUnit3DStatusState(u, act)] || 0;
        } else {
            let activity = getUnit3DActivity(u);
            if (activity.mode !== 0 || activity.amount > 0 || u._visStill === undefined) u._visStill = gameTime;
            activity = _unit3DIdleActivity(u, activity, u._visStill);
            let fx = Number(u.vx) || 0, fy = Number(u.vy) || 0;
            if (activity.target && Number.isFinite(activity.target.x) && Number.isFinite(activity.target.y)) {
                fx = activity.target.x - u.x; fy = activity.target.y - u.y;
            }
            out[o] = activity.mode;
            out[o + 1] = Math.max(0, Math.min(1, activity.amount || Math.min(1, Math.hypot(u.x - u.prevX, u.y - u.prevY) / Math.max(.01, TILE * .025)) || 0));
            out[o + 2] = Math.atan2(fx, fy || 0.0001) || 0;
            _unit3DWalkPhaseLinear(u, activity, _simVisPhase);
            // Over a group of ticks: the phase from the group's start, at
            // the whole group's rate.
            out[o + 3] = _simVisPhase[0] - _simVisPhase[1] * (ticks - 1); out[o + 4] = _simVisPhase[1] * ticks;
            out[o + 5] = _simUnitStatusCode[getUnit3DStatusState(u, activity)] || 0;
        }
        out[o + 6] = getVisualUnitSourceLight(u);
        out[o + 7] = _simSignatureHash(u);
    }
    // Slots of units no longer in the list are free again.
    for (let slot = 0; slot < R.owner.length; slot++) {
        if (R.owner[slot] && R.stamp[slot] !== stampTick) { R.owner[slot] = null; R.free.push(slot); }
    }
    return out;
}
