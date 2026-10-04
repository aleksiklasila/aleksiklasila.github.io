"use strict";
// ============================================================
// SIMULATION FRAMES: STRUCTURES, PROJECTILES AND STATE
//
// As units (sim_frame.js), the rest of the world reaches the page each tick
// in transferred buffers of typed-array columns indexed by stable slots:
//
// - Structures: towers, barracks, spawners, floor items, mines and dropped
//   items, one table (their kind a column). The page sees them as views
//   (their class's prototype: instanceof and draw as for the real thing),
//   and places them on its tile index when the table's membership changes.
// - Projectiles: a table of their flight.
// - State: players (a plain copy, small), the globals, and the grid cells
//   whose type or owner changed.
//
// Selected structures also get detail records (queues, settings, stats).
// ============================================================

// ---- a slot table: columns by kind, laid out f32, i32, (order), i16, u8 ----
function simTableSpec(cols) {
    let spec = { f32: cols.f32 || [], i32: cols.i32 || [], i16: cols.i16 || [], u8: cols.u8 || [] };
    spec.slotBytes = 4 * (spec.f32.length + spec.i32.length + 1) + 2 * spec.i16.length + spec.u8.length;
    return spec;
}
function simTableViews(spec, buf, cap) {
    let f = { buf, cap }, off = 0;
    for (let k of spec.f32) { f[k] = new Float32Array(buf, off, cap); off += 4 * cap; }
    for (let k of spec.i32) { f[k] = new Int32Array(buf, off, cap); off += 4 * cap; }
    f.order = new Int32Array(buf, off, cap); off += 4 * cap;
    for (let k of spec.i16) { f[k] = new Int16Array(buf, off, cap); off += 2 * cap; }
    for (let k of spec.u8) { f[k] = new Uint8Array(buf, off, cap); off += cap; }
    return f;
}
// Worker: stable slots for the entities of a table (entity[key] holds its slot).
class SimSlots {
    constructor(key) { this.key = key; this.owner = []; this.free = []; this.stamp = new Int32Array(1024); this.tick = 0; this.version = 0; this.serial = 0; this.serials = new Int32Array(1024); this.lastOrder = null; }
    reset() { for (let e of this.owner) if (e) e[this.key] = undefined; this.owner = []; this.free = []; this.version++; this.lastOrder = null; }
    slotOf(e) {
        let s = e[this.key];
        if (s !== undefined && this.owner[s] === e) return s;
        s = this.free.length ? this.free.pop() : this.owner.length;
        this.owner[s] = e; e[this.key] = s; this.version++;
        if (s >= this.stamp.length) {
            let st = new Int32Array(Math.max(1024, (s + 1) * 2)); st.set(this.stamp); this.stamp = st;
            let se = new Int32Array(st.length); se.set(this.serials); this.serials = se;
        }
        this.serials[s] = ++this.serial;
        return s;
    }
    // After the entities of this tick were stamped: free the others.
    sweep(tick, F) {
        for (let s = 0; s < this.owner.length; s++) {
            if (this.stamp[s] === tick) continue;
            if (F && s < F.cap) F.alive[s] = 0;
            let e = this.owner[s];
            if (e) { e[this.key] = undefined; this.owner[s] = null; this.free.push(s); this.version++; }
        }
    }
    orderChanged(order, n) {
        let last = this.lastOrder, changed = !last || last.length !== n;
        if (!changed) for (let k = 0; k < n; k++) if (last[k] !== order[k]) { changed = true; break; }
        if (changed) { this.lastOrder = order.slice(0, n); this.version++; }
        return changed;
    }
}

// ---- structures ----
const SIM_STRUCT_KINDS = ['t', 'b', 's', 'f', 'g', 'a', 'd'];
const SIM_STRUCT_SPEC = simTableSpec({
    f32: ['x', 'y', 'energy', 'maxEnergy', 'spawnTimer', 'spawnCooldown', 'stackWork', 'stackReq', 'angle', 'amount', 'amountMax', 'cd',
        'tx', 'ty', 'vision', 'resDone', 'resReq', 'rallyX', 'rallyY', 'timer', 'damage'],
    i32: ['serial', 'flags', 'l0', 'l1', 'l2', 'l3'],
    i16: ['kind', 'gx', 'gy', 'owner', 'type', 'utype', 'level', 'elevel', 'stacks', 'mstacks', 'estacks', 'qlen', 'qtype', 'laser',
        'watchedBy', 'label', 'stackCount'],
    u8: ['alive', 'flash']
});
const SIM_SF_UC = 1, SIM_SF_UPGRADING = 2, SIM_SF_SALVAGE = 4, SIM_SF_STACKING = 8, SIM_SF_WATCHED = 16, SIM_SF_BURNING = 32,
    SIM_SF_POISONED = 64, SIM_SF_FROZEN = 128, SIM_SF_WET = 256, SIM_SF_SANDY = 512, SIM_SF_AUTO_UPGRADE = 1024, SIM_SF_BUILD = 2048,
    SIM_SF_QUEUE = 4096, SIM_SF_AUTO_RESEARCH = 8192, SIM_SF_ATTACK_TARGET = 16384, SIM_SF_RALLY = 32768, SIM_SF_RESEARCH_TASK = 65536,
    SIM_SF_AUTO_STACK = 131072;
const _simStructSlots = new SimSlots('_sslot');
// Level labels are worked out every few ticks per structure (or on a change
// of its levels): they are visual only.
const SIM_STRUCT_LABEL_TICKS = 8;

function _simStructLists() {
    return [towers, barracks, collectorSpawners, _snapFloorItems(), goldMines, astarMines, droppedItems];
}

function _simWriteStructure(F, s, e, kind, tick) {
    F.alive[s] = 1;
    F.serial[s] = _simStructSlots.serials[s];
    F.kind[s] = kind;
    let gx = e.gx | 0, gy = e.gy | 0;
    F.gx[s] = gx; F.gy[s] = gy;
    F.x[s] = Number.isFinite(e.x) ? e.x : gx * TILE + TILE * .5;
    F.y[s] = Number.isFinite(e.y) ? e.y : gy * TILE + TILE * .5;
    F.owner[s] = Number.isFinite(e.owner) ? e.owner : (kind === 3 && grid[gy] && grid[gy][gx] ? grid[gy][gx].owner : -1);
    F.type[s] = _simFrameCode(e.type);
    F.utype[s] = _simFrameCode(e.unitType);
    F.energy[s] = Number(e.energy) || 0;
    F.maxEnergy[s] = Number(e.maxEnergy) || Number(e.preComputed && e.preComputed.maxEnergy) || Number(e.preComputedEffective && e.preComputedEffective.maxEnergy) || 0;
    F.spawnTimer[s] = Number(e.spawnTimer) || 0; F.spawnCooldown[s] = Number(e.spawnCooldown) || 0;
    F.stackWork[s] = Number(e.stackingWorkDone) || 0; F.stackReq[s] = Number(e.stackingWorkRequired) || 0;
    F.angle[s] = Number(e.angle) || 0;
    F.cd[s] = Number(e.cd) || 0; F.damage[s] = Number(e.damage) || 0;
    F.amount[s] = kind === 4 ? Number(e.gold) || 0 : kind === 5 ? Number(e.astar) || 0 : kind === 6 ? Number(e.value) || 0 : 0;
    F.amountMax[s] = kind === 4 ? Number(e.maxGold) || 0 : kind === 5 ? Number(e.maxAstar) || 0 : 0;
    F.timer[s] = Number(e.timer) || 0;
    let at = e.attackTarget, task = e.researchTask;
    F.tx[s] = at ? Number(at.x) || 0 : 0; F.ty[s] = at ? Number(at.y) || 0 : 0;
    F.resDone[s] = task ? Number(task.workDone) || 0 : 0; F.resReq[s] = task ? Number(task.workRequired) || 0 : 0;
    F.rallyX[s] = Number(e.rallyX) || 0; F.rallyY[s] = Number(e.rallyY) || 0;
    F.vision[s] = kind <= 3 ? (Number(getEntityEffectiveVisibilityRangeArea(e)) || 0) : 0;
    F.level[s] = Number.isFinite(e.level) ? e.level : -1;
    F.elevel[s] = Number.isFinite(e.effectiveLevel) ? e.effectiveLevel : -1;
    F.stacks[s] = Number.isFinite(e.stacks) ? e.stacks : -1;
    F.mstacks[s] = Number.isFinite(e.manualStacks) ? e.manualStacks : -1;
    F.estacks[s] = Number.isFinite(e.effectiveStacks) ? e.effectiveStacks : -1;
    F.stackCount[s] = Number.isFinite(e.stackCount) ? e.stackCount : -1;
    let q = e.spawnQueue;
    F.qlen[s] = Array.isArray(q) ? q.length : 0;
    F.qtype[s] = Array.isArray(q) && q.length && q[0] ? _simFrameCode(typeof q[0] === 'object' ? q[0].unitType : q[0]) : 0;
    F.laser[s] = Number(e.laserState) || 0;
    F.watchedBy[s] = Number.isFinite(e.watchedByTeam) ? e.watchedByTeam : -1;
    let flash = Number(e.attackFlash) || 0;
    F.flash[s] = flash <= 0 ? 0 : flash >= 255 ? 255 : flash;
    let links = e.connectedLasers;
    for (let k = 0; k < 4; k++) {
        let o = Array.isArray(links) ? links[k] : null;
        F['l' + k][s] = o && o._sslot !== undefined && _simStructSlots.owner[o._sslot] === o ? o._sslot : -1;
    }
    F.flags[s] = (e.underConstruction ? SIM_SF_UC : 0) | (e.isUpgrading ? SIM_SF_UPGRADING : 0) | (e.markedForSalvage ? SIM_SF_SALVAGE : 0)
        | (e.isStacking ? SIM_SF_STACKING : 0) | (e.watched > 0 ? SIM_SF_WATCHED : 0) | (e.burning > 0 ? SIM_SF_BURNING : 0)
        | (e.poisoned > 0 ? SIM_SF_POISONED : 0) | (e.frozen > 0 ? SIM_SF_FROZEN : 0) | (e.wet > 0 ? SIM_SF_WET : 0) | (e.sandy > 0 ? SIM_SF_SANDY : 0)
        | (e.autoUpgradeEnabled ? SIM_SF_AUTO_UPGRADE : 0) | (e.buildEnabled ? SIM_SF_BUILD : 0) | (e.queueEnabled ? SIM_SF_QUEUE : 0)
        | (e.autoResearchEnabled ? SIM_SF_AUTO_RESEARCH : 0) | (at && Number.isFinite(at.x) ? SIM_SF_ATTACK_TARGET : 0)
        | (Number.isFinite(e.rallyX) && Number.isFinite(e.rallyY) ? SIM_SF_RALLY : 0) | (task ? SIM_SF_RESEARCH_TASK : 0)
        | (e.autoStackEnabled ? SIM_SF_AUTO_STACK : 0);
    // The level label, when its inputs change or on its staggered tick.
    if (kind <= 3 && units.length < 5000) {
        let key = F.level[s] * 7919 + F.elevel[s] * 131 + F.stacks[s] * 17 + F.mstacks[s] * 3 + F.estacks[s] + (e.underConstruction ? 0.5 : 0);
        if (e._simLabelKey !== key || ((tick + s) % SIM_STRUCT_LABEL_TICKS) === 0 || e._simLabel === undefined) {
            e._simLabelKey = key;
            e._simLabel = _simFrameCode(getLevelLabelText(e));
        }
        F.label[s] = e._simLabel;
    } else F.label[s] = 0;
}

// This tick's structures table. Returns { buf, cap, n, count, mver }.
function simFrameEncodeStructures() {
    let S = _simStructSlots, tick = ++S.tick, lists = _simStructLists();
    let count = 0;
    for (let k = 0; k < lists.length; k++) for (let e of lists[k]) if (e) { S.slotOf(e); count++; }
    let n = S.owner.length, cap = Math.max(64, n);
    let buf = _simFrameAcquire(cap * SIM_STRUCT_SPEC.slotBytes);
    let F = simTableViews(SIM_STRUCT_SPEC, buf, cap);
    let order = F.order, j = 0;
    for (let k = 0; k < lists.length; k++) for (let e of lists[k]) {
        if (!e) continue;
        let s = e._sslot;
        S.stamp[s] = tick;
        order[j++] = s;
        _simWriteStructure(F, s, e, k, tick);
    }
    S.sweep(tick, F);
    S.orderChanged(order, j);
    return { buf, cap, n, count: j, mver: S.version };
}

// ---- projectiles ----
const SIM_PROJ_SPEC = simTableSpec({
    f32: ['x', 'y', 'px', 'py', 'vx', 'vy', 'sx', 'sy', 'aim'],
    i32: ['serial'],
    i16: ['type', 'owner', 'life'],
    u8: ['alive']
});
const _simProjSlots = new SimSlots('_pslot');
function simFrameEncodeProjectiles() {
    let S = _simProjSlots, tick = ++S.tick, list = projectiles;
    for (let p of list) if (p) S.slotOf(p);
    let n = S.owner.length, cap = Math.max(64, n);
    let buf = _simFrameAcquire(cap * SIM_PROJ_SPEC.slotBytes);
    let F = simTableViews(SIM_PROJ_SPEC, buf, cap);
    let order = F.order, j = 0;
    for (let p of list) {
        if (!p) continue;
        let s = p._pslot;
        S.stamp[s] = tick;
        order[j++] = s;
        F.alive[s] = 1; F.serial[s] = S.serials[s];
        F.x[s] = p.x; F.y[s] = p.y;
        F.px[s] = Number.isFinite(p.prevX) ? p.prevX : p.x; F.py[s] = Number.isFinite(p.prevY) ? p.prevY : p.y;
        F.vx[s] = Number(p.vx) || 0; F.vy[s] = Number(p.vy) || 0;
        F.sx[s] = Number(p.startX) || 0; F.sy[s] = Number(p.startY) || 0; F.aim[s] = Number(p.aimDist) || 0;
        F.type[s] = _simFrameCode(p.type); F.owner[s] = Number.isFinite(p.sourceOwner) ? p.sourceOwner : -1;
        F.life[s] = Math.max(-32000, Math.min(32000, Number(p.life) || 0));
    }
    S.sweep(tick, F);
    S.orderChanged(order, j);
    return { buf, cap, n, count: j, mver: S.version };
}

// ---- state: players, globals, changed cells ----
let _simStateLast = { globals: '', cellTypes: null, cellOwners: null, w: 0, h: 0 };
function _simPlain(v, depth) {
    if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
    if (depth > 6) return null;
    if (v instanceof Unit) return { __ref: ['u', v.id] };
    if (typeof v.gx === 'number' && typeof v.gy === 'number' && depth > 1) return { __ref: ['b', v.gx, v.gy] };
    if (Array.isArray(v)) return v.map(x => _simPlain(x, depth + 1));
    if (v instanceof Map || v instanceof Set) return null;
    let out = {};
    for (let k in v) { if (k[0] === '_' && k !== '_resourceFixedValues') continue; let x = _simPlain(v[k], depth + 1); if (x !== undefined) out[k] = x; }
    return out;
}
function simFrameResetState() { _simStateLast = { globals: '', cellTypes: null, cellOwners: null, w: 0, h: 0, areas: null }; }
function simFrameEncodeState(includeCells = true) {
    let out = { players: players.map(p => _simPlain(p, 0)) };
    // The areas' state only when it changed (dirtyAreas: set by the
    // simulation as areas turn on or off or level up; nothing in this
    // worker draws, so it is cleared here): a pass over every area and a
    // list of them each tick, on both threads, cost ~5 ms a tick on a big map.
    if (dirtyAreas || !_simStateLast.areas || _simStateLast.areas.list !== areas) {
        let areaState = [];
        for (let ar of (areas || [])) if (ar && (ar.active || ar.multiplierLevel)) areaState.push([ar.id, ar.active ? 1 : 0, ar.multiplierLevel || 0]);
        let key = areaState.join(';');
        if (!_simStateLast.areas || _simStateLast.areas.key !== key || _simStateLast.areas.list !== areas) out.areas = areaState;
        _simStateLast.areas = { key, list: areas };
        dirtyAreas = false;
    }
    let g = { gameTime, gameOver: !!gameOver, winner, resigned: [...resignedTeams], teams: activeTeamIds,
        defeat: typeof _simLocalDefeat === 'string' ? _simLocalDefeat : '',
        pathBudget: pathfindBudgetByPlayer ? Array.from(pathfindBudgetByPlayer) : null,
        astarBudget: astarNodeBudgetRemainingByPlayer ? Array.from(astarNodeBudgetRemainingByPlayer) : null };
    let gs = JSON.stringify(g);
    if (gs !== _simStateLast.globals) { out.globals = g; _simStateLast.globals = gs; }
    if (!includeCells) return out;
    // Cells whose type or owner changed since the last frame.
    let L = _simStateLast, n = GRID_W * GRID_H;
    if (!L.cellTypes || L.w !== GRID_W || L.h !== GRID_H) { L.cellTypes = new Array(n).fill(null); L.cellOwners = new Int32Array(n).fill(-9); L.w = GRID_W; L.h = GRID_H; }
    let cells = [];
    for (let y = 0; y < GRID_H; y++) {
        let row = grid[y];
        for (let x = 0; x < GRID_W; x++) {
            let i = y * GRID_W + x, c = row[x];
            if (c.type !== L.cellTypes[i] || c.owner !== L.cellOwners[i]) { L.cellTypes[i] = c.type; L.cellOwners[i] = c.owner; cells.push(i, c.type, c.owner); }
        }
    }
    if (cells.length) out.cells = cells;
    return out;
}

// ---- structure details (the page's selected structures) ----
let _simWatchedStructures = [];
function simFrameWatchStructures(list) { _simWatchedStructures = Array.isArray(list) ? list.slice(0, 256) : []; }
function simFrameStructureDetails() {
    if (!_simWatchedStructures.length) return null;
    let out = [];
    for (let j = 0; j + 1 < _simWatchedStructures.length; j += 2) {
        let gx = _simWatchedStructures[j], gy = _simWatchedStructures[j + 1];
        let cell = grid[gy] && grid[gy][gx];
        let e = getTileEntityRef(gx, gy) || (cell && cell.item) || getDroppedItemAt(gx, gy);
        if (!e) continue;
        let d = { gx, gy };
        for (let k in e) {
            if (k[0] === '_' || SNAP_SKIP_KEYS.has(k)) continue;
            let v = _simPlain(e[k], 1);
            if (v !== undefined) d[k] = v;
        }
        out.push(d);
    }
    return out;
}

// ---- page side ----

const _pageTables = { s: null, p: null };
let _pageStructViews = [];      // by slot
let _pageProjViews = [];        // by slot

// Accessors of structure views over the table's columns.
function _pageStructCol(v, k) { let s = v._s; return s >= 0 ? _pageTables.s[k][s] : (v._last ? v._last[k] : 0); }
function _pageStructFlag(v, bit) { return (_pageStructCol(v, 'flags') & bit) !== 0; }
function _pageStructDetail(v, k) { let d = v._det; return d ? d[k] : undefined; }
function _pageNum(v, col) { let x = _pageStructCol(v, col); return x >= 0 ? x : undefined; }
const _PAGE_STRUCT_ACCESSORS = {
    x: { get() { return _pageStructCol(this, 'x'); } },
    y: { get() { return _pageStructCol(this, 'y'); } },
    gx: { get() { return _pageStructCol(this, 'gx'); } },
    gy: { get() { return _pageStructCol(this, 'gy'); } },
    // (Mines and drops have none, as in the simulation.)
    owner: { get() { let o = _pageStructCol(this, 'owner'); return o === -1 && this._kind >= 4 ? undefined : o; } },
    type: { get() { return _pageFrameStrings[_pageStructCol(this, 'type')] || undefined; } },
    unitType: { get() { return _pageFrameStrings[_pageStructCol(this, 'utype')] || undefined; } },
    energy: { get() { return _pageStructCol(this, 'energy'); } },
    maxEnergy: { get() { return _pageStructCol(this, 'maxEnergy'); } },
    spawnTimer: { get() { return _pageStructCol(this, 'spawnTimer'); } },
    spawnCooldown: { get() { return _pageStructCol(this, 'spawnCooldown'); } },
    stackingWorkDone: { get() { return _pageStructCol(this, 'stackWork'); } },
    stackingWorkRequired: { get() { return _pageStructCol(this, 'stackReq'); } },
    angle: { get() { return _pageStructCol(this, 'angle'); } },
    cd: { get() { return _pageStructCol(this, 'cd'); } },
    damage: { get() { return _pageStructCol(this, 'damage'); } },
    gold: { get() { return this._kind === 4 ? _pageStructCol(this, 'amount') : undefined; } },
    astar: { get() { return this._kind === 5 ? _pageStructCol(this, 'amount') : undefined; } },
    maxGold: { get() { return this._kind === 4 ? _pageStructCol(this, 'amountMax') : undefined; } },
    maxAstar: { get() { return this._kind === 5 ? _pageStructCol(this, 'amountMax') : undefined; } },
    value: { get() { return this._kind === 6 ? _pageStructCol(this, 'amount') : undefined; } },
    timer: { get() { return this._kind === 6 ? _pageStructCol(this, 'timer') : undefined; } },
    level: { get() { return _pageNum(this, 'level'); } },
    effectiveLevel: { get() { return _pageNum(this, 'elevel'); } },
    stacks: { get() { return _pageNum(this, 'stacks'); } },
    manualStacks: { get() { return _pageNum(this, 'mstacks'); } },
    effectiveStacks: { get() { return _pageNum(this, 'estacks'); } },
    stackCount: { get() { return _pageNum(this, 'stackCount'); } },
    laserState: { get() { return _pageStructCol(this, 'laser'); } },
    attackFlash: { get() { return _pageStructCol(this, 'flash'); } },
    watchedByTeam: { get() { return _pageNum(this, 'watchedBy'); } },
    underConstruction: { get() { return _pageStructFlag(this, SIM_SF_UC); } },
    isUpgrading: { get() { return _pageStructFlag(this, SIM_SF_UPGRADING); } },
    markedForSalvage: { get() { return _pageStructFlag(this, SIM_SF_SALVAGE); } },
    isStacking: { get() { return _pageStructFlag(this, SIM_SF_STACKING); } },
    autoUpgradeEnabled: { get() { return _pageStructFlag(this, SIM_SF_AUTO_UPGRADE); } },
    autoStackEnabled: { get() { return _pageStructFlag(this, SIM_SF_AUTO_STACK); } },
    buildEnabled: { get() { return _pageStructFlag(this, SIM_SF_BUILD); } },
    queueEnabled: { get() { return _pageStructFlag(this, SIM_SF_QUEUE); } },
    autoResearchEnabled: { get() { return _pageStructFlag(this, SIM_SF_AUTO_RESEARCH); } },
    watched: { get() { let d = _pageStructDetail(this, 'watched'); return d !== undefined ? d : _pageStructFlag(this, SIM_SF_WATCHED) ? 1 : 0; } },
    burning: { get() { let d = _pageStructDetail(this, 'burning'); return d !== undefined ? d : _pageStructFlag(this, SIM_SF_BURNING) ? 1 : 0; } },
    poisoned: { get() { let d = _pageStructDetail(this, 'poisoned'); return d !== undefined ? d : _pageStructFlag(this, SIM_SF_POISONED) ? 1 : 0; } },
    frozen: { get() { let d = _pageStructDetail(this, 'frozen'); return d !== undefined ? d : _pageStructFlag(this, SIM_SF_FROZEN) ? 1 : 0; } },
    wet: { get() { let d = _pageStructDetail(this, 'wet'); return d !== undefined ? d : _pageStructFlag(this, SIM_SF_WET) ? 1 : 0; } },
    sandy: { get() { let d = _pageStructDetail(this, 'sandy'); return d !== undefined ? d : _pageStructFlag(this, SIM_SF_SANDY) ? 1 : 0; } },
    rallyX: { get() { return _pageStructFlag(this, SIM_SF_RALLY) ? _pageStructCol(this, 'rallyX') : undefined; } },
    rallyY: { get() { return _pageStructFlag(this, SIM_SF_RALLY) ? _pageStructCol(this, 'rallyY') : undefined; } },
    attackTarget: { get() {
        if (!_pageStructFlag(this, SIM_SF_ATTACK_TARGET)) return null;
        let t = this._at || (this._at = { x: 0, y: 0 }); t.x = _pageStructCol(this, 'tx'); t.y = _pageStructCol(this, 'ty'); return t;
    } },
    // The selected structure's own queue; else as many entries as queued,
    // of the first entry's type.
    spawnQueue: { get() {
        let d = _pageStructDetail(this, 'spawnQueue');
        if (Array.isArray(d)) return d;
        let n = _pageStructCol(this, 'qlen'), t = _pageStructCol(this, 'qtype');
        let q = this._q;
        if (!q || q.length !== n || this._qt !== t) {
            let entry = { unitType: _pageFrameStrings[t] || this.unitType };
            q = this._q = new Array(n).fill(entry); this._qt = t;
        }
        return q;
    } },
    researchTask: { get() {
        let d = _pageStructDetail(this, 'researchTask');
        if (d !== undefined) return d;
        if (!_pageStructFlag(this, SIM_SF_RESEARCH_TASK)) return null;
        let t = this._rt || (this._rt = {}); t.workDone = _pageStructCol(this, 'resDone'); t.workRequired = _pageStructCol(this, 'resReq'); return t;
    } },
    connectedLasers: { get() {
        let out = this._links || (this._links = []);
        out.length = 0;
        if (this._s < 0) return out;
        for (let k = 0; k < 4; k++) { let s = _pageTables.s['l' + k][this._s]; if (s >= 0 && _pageStructViews[s]) out.push(_pageStructViews[s]); }
        return out;
    } },
    baseStats: { get() { return _pageStructDetail(this, 'baseStats') || BASE_CARD_TYPES[this.type] || {}; } },
    currentStats: { get() { return _pageStructDetail(this, 'currentStats') || this._statsFallback(); } },
    preComputed: { get() { return _pageStructDetail(this, 'preComputed') || this._statsFallback(); } },
    preComputedEffective: { get() { return _pageStructDetail(this, 'preComputedEffective') || this._statsFallback(); } },
    basePreComputed: { get() { return _pageStructDetail(this, 'basePreComputed') || this._statsFallback(); } },
    _statsFallback: { value() {
        let st = this._fst || (this._fst = {});
        st.maxEnergy = this.maxEnergy; st.visionRangeArea = _pageStructCol(this, 'vision'); st.visionRange = st.visionRangeArea;
        return st;
    } },
    _labelText: { value() { return _pageFrameStrings[_pageStructCol(this, 'label')] || 'L1'; } },
    _frameView: { value: true },
    _structView: { value: true }
};
// View prototypes per class (their methods, instanceof), made on first use.
const _pageStructProtos = new Map();
function _pageStructProto(kind, type) {
    let Cls = kind === 0 ? Tower : kind === 1 ? Barrack : kind === 2 ? _snapSpawnerClass(type) : null;
    let key = Cls || Object;
    let proto = _pageStructProtos.get(key);
    if (!proto) {
        proto = Object.create(Cls ? Cls.prototype : Object.prototype, _PAGE_STRUCT_ACCESSORS);
        _pageStructProtos.set(key, proto);
    }
    return proto;
}
function _pageNewStructView(kind, type, s, serial) {
    let v = Object.create(_pageStructProto(kind, type));
    v._s = s; v._serial = serial; v._kind = kind; v.dead = false; v._last = null; v._det = null;
    return v;
}
function _pageFreezeStruct(v) {
    let F = _pageTables.s, s = v._s, last = {};
    if (F && s >= 0) {
        for (let k of SIM_STRUCT_SPEC.f32) last[k] = F[k][s];
        for (let k of SIM_STRUCT_SPEC.i32) last[k] = F[k][s];
        for (let k of SIM_STRUCT_SPEC.i16) last[k] = F[k][s];
        for (let k of SIM_STRUCT_SPEC.u8) last[k] = F[k][s];
    }
    last.energy = 0;
    v._last = last; v._s = -1; v.dead = true;
}

// The structures of a new frame: views, lists and the tile index when the
// membership changed; label sprites of structures whose label changed.
function pageApplyStructures(table, c) {
    let F = simTableViews(SIM_STRUCT_SPEC, table.buf, table.cap);
    F.n = table.n;
    let old = _pageTables.s;
    let changed = table.mver !== c.structMver || !old;
    let relabel = [];
    if (changed) {
        let lists = [[], [], [], [], [], [], []], seen = new Set();
        for (let k = 0; k < table.count; k++) {
            let s = F.order[k], kind = F.kind[s], v = _pageStructViews[s];
            if (!v || v._serial !== F.serial[s] || v.dead) {
                v = _pageNewStructView(kind, _pageFrameStrings[F.type[s]], s, F.serial[s]);
                _pageStructViews[s] = v;
                relabel.push(v);
            }
            seen.add(v);
            lists[kind].push(v);
        }
        for (let v of c.structViews || []) if (!seen.has(v)) _pageFreezeStruct(v);
        for (let s = 0; s < _pageStructViews.length; s++) { let v = _pageStructViews[s]; if (v && !seen.has(v)) _pageStructViews[s] = null; }
        c.structViews = [...seen];
        c.structMver = table.mver;
        _pageTables.s = F;
        towers = lists[0]; barracks = lists[1]; collectorSpawners = lists[2];
        goldMines.length = 0; for (let m of lists[4]) goldMines.push(m);
        astarMines.length = 0; for (let m of lists[5]) astarMines.push(m);
        // The tile index and the cells' items.
        initTileEntityLookup();
        for (let row of grid) for (let cell of row) { cell.item = null; cell.droppedItem = null; }
        for (let kind = 0; kind <= 5; kind++) {
            let list = SIM_STRUCT_KINDS[kind];
            for (let v of lists[kind]) {
                let row = grid[v.gy];
                if ((kind === 1 || kind === 2 || kind === 3) && row && row[v.gx]) row[v.gx].item = v;
                setTileEntity(v.gx, v.gy, _snapTileTypeOf(list, v), v);
            }
        }
        droppedItems = [];
        initDroppedItemGrid();
        for (let d of lists[6]) { _setDroppedItemAt(d.gx, d.gy, d); droppedItems.push(d); }
        if (typeof recalculateLaserConnections === 'function') { /* links come from the frame */ }
        _simClientMapChanged();
    } else {
        _pageTables.s = F;
    }
    // Labels: where the code changed.
    if (old && !changed) {
        let n = Math.min(F.n, old.n), a = F.label, b = old.label;
        for (let s = 0; s < n; s++) if (a[s] !== b[s] && F.alive[s] && _pageStructViews[s]) relabel.push(_pageStructViews[s]);
    } else if (old) {
        let n = Math.min(F.n, old.n);
        for (let s = 0; s < n; s++) { let v = _pageStructViews[s]; if (v && F.label[s] !== old.label[s] && !relabel.includes(v)) relabel.push(v); }
    }
    if (typeof updateItemTextCache === 'function') for (let v of relabel) if (v._kind <= 3) updateItemTextCache(v);
    return old;
}

// Projectiles: views by slot (stable for a projectile's flight).
const _PAGE_PROJ_ACCESSORS = {
    x: { get() { return this._ox !== undefined ? this._ox : _pageProjCol(this, 'x'); }, set(v) { this._ox = v === _pageProjCol(this, 'x') ? undefined : v; } },
    y: { get() { return this._oy !== undefined ? this._oy : _pageProjCol(this, 'y'); }, set(v) { this._oy = v === _pageProjCol(this, 'y') ? undefined : v; } },
    prevX: { get() { return _pageProjCol(this, 'px'); }, set(v) { } },
    prevY: { get() { return _pageProjCol(this, 'py'); }, set(v) { } },
    vx: { get() { return _pageProjCol(this, 'vx'); } },
    vy: { get() { return _pageProjCol(this, 'vy'); } },
    startX: { get() { return _pageProjCol(this, 'sx'); } },
    startY: { get() { return _pageProjCol(this, 'sy'); } },
    aimDist: { get() { return _pageProjCol(this, 'aim'); } },
    life: { get() { return _pageProjCol(this, 'life'); } },
    type: { get() { return _pageFrameStrings[_pageProjCol(this, 'type')] || undefined; } },
    sourceOwner: { get() { return _pageProjCol(this, 'owner'); } },
    _frameView: { value: true }
};
function _pageProjCol(v, k) { let s = v._s; return s >= 0 ? _pageTables.p[k][s] : (v._last ? v._last[k] : 0); }
let _pageProjProto = null;
function pageApplyProjectiles(table, c, shown) {
    let F = simTableViews(SIM_PROJ_SPEC, table.buf, table.cap);
    F.n = table.n;
    let old = _pageTables.p;
    // Continuing flights start where they are drawn.
    if (old && shown < 1) {
        let n = Math.min(F.n, old.n);
        for (let s = 0; s < n; s++) {
            if (!F.alive[s] || F.serial[s] !== old.serial[s]) continue;
            F.px[s] = old.px[s] + (old.x[s] - old.px[s]) * shown;
            F.py[s] = old.py[s] + (old.y[s] - old.py[s]) * shown;
        }
    }
    if (!_pageProjProto) _pageProjProto = Object.create(Projectile.prototype, _PAGE_PROJ_ACCESSORS);
    if (table.mver !== c.projMver || !old) {
        let list = new Array(table.count);
        for (let k = 0; k < table.count; k++) {
            let s = F.order[k], v = _pageProjViews[s];
            if (!v || v._serial !== F.serial[s]) { v = Object.create(_pageProjProto); v._s = s; v._serial = F.serial[s]; v._last = null; _pageProjViews[s] = v; }
            list[k] = v;
        }
        projectiles = list;
        c.projMver = table.mver;
    }
    _pageTables.p = F;
    return old;
}

// Players, globals and changed cells.
function _pageResolveRefs(v) {
    if (v === null || typeof v !== 'object') return v;
    if (v.__ref) return v.__ref[0] === 'u' ? (_pageUnitsById.get(v.__ref[1]) || null) : _simClientResolve(v.__ref);
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = _pageResolveRefs(v[i]); return v; }
    for (let k in v) v[k] = _pageResolveRefs(v[k]);
    return v;
}
function pageApplyState(st) {
    if (!st) return;
    if (st.players) {
        let sigBefore = players.map((_, pid) => typeof _snapStatMapSignature === 'function' ? _snapStatMapSignature(pid) : '');
        for (let i = 0; i < st.players.length; i++) {
            let p = _pageResolveRefs(st.players[i]);
            if (players[i] && typeof players[i] === 'object') {
                for (let k of Object.keys(players[i])) if (k[0] !== '_' && !(k in p)) delete players[i][k];
                Object.assign(players[i], p);
            } else players[i] = p;
        }
        players.length = st.players.length;
        // Stat tables follow research.
        for (let pid = 0; pid < players.length; pid++) {
            let sig = typeof _snapStatMapSignature === 'function' ? _snapStatMapSignature(pid) : '';
            if (sig !== sigBefore[pid] && typeof rebuildPrecomputedStatsMapPlayer === 'function') rebuildPrecomputedStatsMapPlayer(pid);
        }
    }
    let g = st.globals;
    if (g) {
        gameTime = g.gameTime;
        gameOver = g.gameOver;
        // The simulation's win check found this player defeated: spectate.
        if (g.defeat && !localDefeated && !g.gameOver && typeof enterSpectateMode === 'function') enterSpectateMode(g.defeat);
        winner = g.winner;
        resignedTeams = new Set(g.resigned || []);
        if (Array.isArray(g.teams) && g.teams.length) activeTeamIds = g.teams;
        if (g.pathBudget) for (let i = 0; i < g.pathBudget.length; i++) pathfindBudgetByPlayer[i] = g.pathBudget[i];
        if (g.astarBudget) for (let i = 0; i < g.astarBudget.length; i++) astarNodeBudgetRemainingByPlayer[i] = g.astarBudget[i];
    }
    // (Only when the areas changed: see simFrameEncodeState.)
    if (st.areas) {
        let now = new Map(st.areas.map(e => [e[0], e]));
        for (let ar of (areas || [])) {
            if (!ar) continue;
            let e = now.get(ar.id), active = !!(e && e[1]), level = e ? e[2] : 0;
            if (ar.active !== active || (ar.multiplierLevel || 0) !== level) {
                ar.active = active; ar.multiplierLevel = level; dirtyAreas = true;
                if (typeof _markCombinedBgAreaDirty === 'function') _markCombinedBgAreaDirty(ar.id, 1);
            }
        }
    }
    if (st.cells) {
        for (let j = 0; j + 2 < st.cells.length; j += 3) {
            let idx = st.cells[j], row = grid[Math.floor(idx / GRID_W)];
            if (!row) continue;
            let cell = row[idx % GRID_W];
            cell.type = st.cells[j + 1]; cell.owner = st.cells[j + 2];
        }
        _tileEntityVersion++;
        if (typeof tileEntityIndexesReset === 'function') tileEntityIndexesReset();
        _simClientMapChanged();
    }
}

function pageApplyStructureDetails(details, c) {
    for (let v of c.detailedStructs || []) {
        v._det = null;
        for (let k of v._detKeys || []) delete v[k];
        v._detKeys = null;
    }
    c.detailedStructs = [];
    if (!details) return;
    for (let d of details) {
        let cell = grid[d.gy] && grid[d.gy][d.gx];
        let v = getTileEntityRef(d.gx, d.gy) || (cell && cell.item) || getDroppedItemAt(d.gx, d.gy);
        if (!v || !v._structView) continue;
        _pageResolveRefs(d);
        v._det = d;
        // Fields views have no accessor for: set on it while selected.
        let keys = [];
        for (let k in d) if (!(k in _PAGE_STRUCT_ACCESSORS) && k !== 'gx' && k !== 'gy' && !(k in v && !Object.prototype.hasOwnProperty.call(v, k) && typeof v[k] === 'function')) { v[k] = d[k]; keys.push(k); }
        v._detKeys = keys;
        c.detailedStructs.push(v);
    }
}

function pageResetWorldTables(c) {
    for (let v of (c && c.structViews) || []) _pageFreezeStruct(v);
    _pageStructViews = []; _pageProjViews = [];
    let bufs = [];
    if (_pageTables.s) bufs.push(_pageTables.s.buf);
    if (_pageTables.p) bufs.push(_pageTables.p.buf);
    _pageTables.s = null; _pageTables.p = null;
    if (c) { c.structViews = []; c.structMver = -1; c.projMver = -1; c.detailedStructs = []; }
    return bufs;
}
