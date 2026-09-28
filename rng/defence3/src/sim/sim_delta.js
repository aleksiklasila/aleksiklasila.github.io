"use strict";
// ============================================================
// SIMULATION DELTA STREAM
//
// The simulation worker runs the ticks; the page keeps a full copy of the
// world (rendering and UI read it directly) updated after every tick by
// what changed, encoded here on the worker (simDeltaEncode) and applied on
// the page (simDeltaApply):
//
// - Hot fields: numeric fields that change most ticks (positions, timers,
//   counters...), per list in list order, as typed arrays (transferable).
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
// battles). prevX/prevY are not snapshot fields (see SNAP_SKIP_KEYS) but the
// page interpolates with them.
const SIM_DELTA_HOT_FIELDS = {
    u: ['x', 'y', 'prevX', 'prevY', 'vx', 'vy', 'pathIndex', 'energy', 'attackTimer', 'attackFlash', 'commandState', 'effectiveStacks',
        'effectiveLevel', '_lastAppliedEffectiveLevel', '_effectiveStatsRecalcCounter', '_thingStatsRecalcCounter', '_astarLastChargedTick',
        '_astarLastChargedToKey', '_astarLastChargedFromKey', '_workerNextIdleRetargetTick', '_builderLastWatchX', '_builderLastWatchY',
        '_builderLastMoveTick', 'workerTransferCooldown', 'wet', 'frozen', 'burning', 'poisoned', 'sandy', 'watched', 'teleportHideTicks',
        'builderHasMaterial', '_workerLastPathTick', '_collectorLastMoveTick', '_healerLastMoveTick', '_researchLastMoveTick', '_awaitGroupPath'],
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

// Hot value kinds: the value itself (number) or one of these.
// ABSENT: the entity has no such field (left as is on the page).
const SIM_HOT_NUMBER = 0, SIM_HOT_UNDEFINED = 1, SIM_HOT_NULL = 2, SIM_HOT_TRUE = 3, SIM_HOT_FALSE = 4, SIM_HOT_ABSENT = 5;

let _simDeltaEnc = null;

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
        layout, cold,
        changed: new Function('e', 'v', 'return ' + body + ';'),
        copy: new Function('e', 'return [' + cold.map(acc).join(', ') + '];')
    };
    _simDeltaShapes.set(layout, shape);
    return shape;
}

// Encoder baseline: call when the page's copy was set from a full snapshot
// of the current state (match start, resync).
function simDeltaEncoderReset() {
    let lists = {};
    for (let list of SIM_DELTA_LISTS) {
        let arr = _snapListEntities(list);
        let hashKind = SIM_DELTA_HASH_KIND[list];
        let seen = new Map();
        let keys = new Array(arr.length);
        for (let i = 0; i < arr.length; i++) {
            let e = arr[i];
            let shape = _simDeltaShape(list, e);
            seen.set(e, { shape, vals: shape.copy(e), h: hashKind ? _snapHashEntity(hashKind, e, 7) : 0 });
            keys[i] = _snapEntityKey(list, e, i);
        }
        lists[list] = { seen, keys };
    }
    let n = GRID_W * GRID_H;
    let types = new Int32Array(n), owners = new Int32Array(n);
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) { types[y * GRID_W + x] = grid[y][x].type; owners[y * GRID_W + x] = grid[y][x].owner; }
    _simDeltaEnc = { lists, types, owners, gridW: GRID_W, gridH: GRID_H };
}

// This tick's changes since the last call. Transfer out.hot[*].v/k buffers.
function simDeltaEncode() {
    if (!_simDeltaEnc || _simDeltaEnc.gridW !== GRID_W || _simDeltaEnc.gridH !== GRID_H) simDeltaEncoderReset();
    let enc = _simDeltaEnc;
    enc.tick = (enc.tick || 0) + 1;
    let entities = new Map(), orders = new Set(), regions = new Set();
    let hot = {};
    let rowCount = 0;
    // Buildings sent as rows (their level labels are redrawn on the page), and
    // whether the map's cached layers need a redraw.
    let built = [];
    let dirtyMap = false;
    for (let list of SIM_DELTA_LISTS) {
        let st = enc.lists[list];
        let arr = _snapListEntities(list);
        let fields = SIM_DELTA_HOT_FIELDS[list] || [];
        let nf = fields.length;
        let codec = _simHotCodec(list);
        let hashKind = SIM_DELTA_HASH_KIND[list];
        let v = nf ? new Float64Array(arr.length * nf) : null;
        let kinds = nf ? new Uint8Array(arr.length * nf) : null;
        let items = [];
        let membershipChanged = arr.length !== st.keys.length;
        let keys = new Array(arr.length);
        let nextSeen = new Map();
        for (let i = 0; i < arr.length; i++) {
            let e = arr[i];
            let key = _snapEntityKey(list, e, i);
            keys[i] = key;
            if (!membershipChanged && st.keys[i] !== key) membershipChanged = true;
            let prev = st.seen.get(e);
            let dirty = false;
            let shape = prev ? prev.shape : null;
            if (!prev) dirty = true;
            else if (shape.changed(e, prev.vals)) dirty = true;
            // A changed property layout (a field added or removed) is a new
            // shape. Buildings and items (few) are checked every tick: they
            // gain fields as they go (status effects...). Units keep one
            // layout by design; a staggered 16-tick check backs that up (and
            // the page's hash check catches the rest).
            if (!dirty && prev && (list !== 'u' || ((i + enc.tick) & 15) === 0) && _simDeltaShape(list, e) !== shape) dirty = true;
            let h = 0;
            if (hashKind) {
                h = _snapHashEntity(hashKind, e, 7);
                if (prev && h !== prev.h) dirty = true;
            }
            // Not representable in the hot arrays: the row carries it.
            if (nf && !codec.pack(e, v, kinds, i * nf)) dirty = true;
            if (dirty) {
                shape = _simDeltaShape(list, e);
                items.push([e, i]);
                rowCount++;
                if (list === 't' || list === 'b' || list === 's' || list === 'f') built.push(list, i);
            }
            nextSeen.set(e, dirty ? { shape, vals: shape.copy(e), h } : prev);
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
        if (items.length) entities.set(list, items);
        st.seen = nextSeen;
        st.keys = keys;
        if (nf) hot[list] = { n: arr.length, fields: nf, v, k: kinds };
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
    return { S, hot, rows: rowCount, built, dirtyMap, budgets };
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
        let unpack = _simHotCodec(list).unpack;
        let nf = h.fields, v = h.v, k = h.k;
        let isUnits = list === 'u';
        for (let i = 0; i < arr.length; i++) {
            let e = arr[i];
            // Units that moved are re-indexed (selection, range queries...).
            if (unpack(e, v, k, i * nf) && isUnits) updateUnitSpatial(e);
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
