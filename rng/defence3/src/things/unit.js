"use strict";
// (Contexts without data_static.js, the unit tests': one base tick a step.)
if (typeof simDk === 'undefined') {
    globalThis.simDk = 1;
    globalThis.simStepCrosses = (phase, period) => !(period > 1) || ((((globalThis.gameTime | 0) + phase) % period) + period) % period < globalThis.simDk;
    globalThis.simStepPhases = period => [(((globalThis.gameTime | 0) % period) + period) % period];
}

// ============================================================
// UNIT CLASS
// ============================================================
const CMD_IDLE = 0, CMD_MOVING = 1, CMD_ATTACK_MOVING = 2, CMD_ATTACKING = 3, CMD_HOLDING = 4;
const UNIT_POSITION_QUANTIZATION = 8;

// Floor structures that harm units standing on them.
const TRAP_ITEM_TYPES = new Set(['lava', 'poison_puddle', 'ice_patch', 'water_puddle', 'sand', 'mine']);
function isTrapItem(item) { return !!(item && TRAP_ITEM_TYPES.has(item.type)); }

// A worker's command from its state: the moving states move it (the
// movement state machine runs for them this tick), the working and idle
// ones stand.
const _WORKER_MOVING_CMD_STATES = new Set(['MANUAL_MOVE', 'MOVING_TO', 'MOVING_TO_ASTAR', 'RETURNING', 'RETURNING_ASTAR', 'MOVING_TO_BUILD', 'RETURNING_FOR_GOLD', 'MOVING_TO_HEAL', 'MOVING_TO_RESEARCH']);
const _WORKER_STANDING_CMD_STATES = new Set(['IDLE', 'BUILDING_IN_PLACE', 'HEALING', 'RESEARCHING']);
function _workerSyncCommand(u) {
    const ws = u.workerState;
    if (_WORKER_MOVING_CMD_STATES.has(ws)) u.commandState = CMD_MOVING;
    else if (_WORKER_STANDING_CMD_STATES.has(ws)) u.commandState = CMD_IDLE;
}
// A worker after its event, unarmed (its AI changed what it does): armed or
// parked for the movement kernel again. (Every other unit is the kernel's
// controller's, mv.rs ctl.)
function _unitArmAgain(u, cols) {
    if (!u.workerState) return;
    const cmd = u.commandState;
    // (A worker at its task standing out its cooldown, whatever its command.)
    if (u.workerState !== 'MANUAL_MOVE' && u.workerTransferCooldown > 0) { simMoveTryParkWork(u); if (cols.mvOn[u._si] !== 0) return; }
    if (cmd === CMD_MOVING && !u.holdPosition && simMoveTryParkRoute(u, cmd)) return;
    if (cmd === CMD_MOVING) { if (u.holdPosition) simMoveTryParkHeld(u, cmd); else simMoveTryArm(u); }
    else if (cmd === CMD_IDLE && u.workerTransferCooldown > 0) simMoveTryParkWork(u);
    else if (cmd === CMD_IDLE && u.workerState === 'IDLE') simMoveTryPark(u);
}

function _quantizeUnitWorldCoord(value) {
    let n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * UNIT_POSITION_QUANTIZATION) / UNIT_POSITION_QUANTIZATION;
}

// (Whole area steps. A worker's range is its work reach, not an attack: 0 for the kernels.)
// A unit's stat tables as JavaScript reads them: the shared tables of its
// owner, type and levels (the player's precomputed ones: its effective
// level's with its base level's maxEnergy, clonePrecomputedWithBaseMaxEnergy,
// one shared object a pair). The kernels read the heap tables
// (things_utils.js unitStatTables), not these.
function _unitStatLevels(u, c, s) {
    const o = c.owner[s], key = _normalizePlayerPrecomputedUnitKey(u.unitType || 'norm');
    if (!PRECOMPUTED_STATS_MAP_PLAYER[o]) rebuildPrecomputedStatsMapPlayer(o);
    return { o, key, levels: (((PRECOMPUTED_STATS_MAP_PLAYER[o] || {}).unit || {})[key]) || [] };
}
function _unitBaseView(u, c, s) {
    const L = _unitStatLevels(u, c, s), bl = Math.max(1, c.baseLevel[s] | 0);
    return L.levels[bl] || _getUnitPlayerPrecomputedEntry(L.o, L.key, bl);
}
function _unitStatView(u, c, s) {
    const L = _unitStatLevels(u, c, s), bl = Math.max(1, c.baseLevel[s] | 0), el = Math.max(1, c.effectiveLevel[s] | 0);
    const b = L.levels[bl] || _getUnitPlayerPrecomputedEntry(L.o, L.key, bl), e = L.levels[el] || _getUnitPlayerPrecomputedEntry(L.o, L.key, el);
    return clonePrecomputedWithBaseMaxEnergy(b, e);
}
function _getUnitAttackRangeArea(unit) {
    const pc = unit && unit.preComputed;
    return pc && !pc.rangeIsWork ? areaSteps(pc.attackRangeArea) : 0;
}

// Extra reach, beyond the collision distance, at which bodies count as touching.
const UNIT_CONTACT_ATTACK_MARGIN = TILE * 0.25;

// Where another unit is during the movement kernel and the unit events: its
// position at the tick's start (x0, y0), whatever it has done since: what
// is decided does not depend on who went first. (Outside, where it is.)
let _unitPassOn = false;
// The unit events (mv.rs EV_*, unit.mvEv): what the movement kernel leaves to
// this thread, listed after it by SIM_KERNEL_UNIT_EVENTS and handled here in
// O(events) (unitEventsRun): a floor item it cannot apply (a mine), no way on
// (a pending target), a wait for a way that ended near its target, a unit not
// in the unit index, a worker's AI look on its way; and every worker the
// kernel does not move (no output: its way's end, a wake, idle): its AI.
const UNIT_EV_FLOOR = 1, UNIT_EV_NOWAY = 2, UNIT_EV_WAITED = 3, UNIT_EV_SPATIAL = 4, UNIT_EV_CHECK = 5;
const UNIT_EVENTS_PER_JOB = 8192, UNIT_DEAD_PER_JOB = 4096;
// (Worker events: all of them every tick, the worker kernel's pass, no cap.)
// The events' order: a hash of the tick and the id (21 bits), then the id:
// the same on every peer (slots are each peer's own).
function _unitEvOrderKey(t, id) {
    let h = Math.imul((t | 0) ^ 0x2545f491, 0x9e3779b1) ^ Math.imul((id | 0) + 0x632be5ab, 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
    h ^= h >>> 13;
    return (h >>> 11) * 2147483648 + ((id | 0) & 0x7fffffff);
}
let _unitEvList = null, _unitEvCnt = null;
const _unitEvSort = { cap: 0, ent: null };
let UNIT_EVENT_ROUTE_BATCH = true;
function _unitEventSortReserve(n) {
    if (_unitEvSort.cap >= n) return;
    const m = simReserveCap(n, 1024);
    // The helper binding protocol supports Float64Array; Rust treats these
    // opaque eight-byte key buffers as u64 (JavaScript never reads them).
    for (const [key, Type, stride = 1] of [['sorted', Int32Array], ['temp', Int32Array], ['keys', Float64Array], ['keytmp', Float64Array], ['routes', Int32Array, 2]]) {
        const old = _unitEvSort[key], a = _unitEvSort[key] = simSharedArray(Type, m * stride);
        simParallelBind('ev.' + key, a);
        if (old) simHeapFree(old);
    }
    _unitEvSort.cap = m; _unitEvSort.ent = _unitEvSort.sorted;
}
// The sorted events' split (k.rs k_unit_events_split): a chunk's two halves and counts, kept between ticks (bound once).
const UNIT_EVENTS_SPLIT_PER = 2048;
const _unitEvSplit = { split: null, cnt: null };
function _unitEvSplitRoom(chunks, per) {
    const X = _unitEvSplit;
    if (!X.split || X.split.length < chunks * per * 2 || !simHeapHas(X.split)) { X.split = simSharedArray(Int32Array, Math.max(chunks, 8) * per * 2); simParallelBind('ev.split', X.split); }
    if (!X.cnt || X.cnt.length < chunks * 16 || !simHeapHas(X.cnt)) { X.cnt = simSharedArray(Int32Array, Math.max(chunks, 8) * 16); simParallelBind('ev.splitCnt', X.cnt); }
    return X;
}
// (Events of no kind for a unit that is not a worker: none expected; counted.)
let unitEventsStray = 0;
function unitEventsRun() {
    const S = _simUnitState;
    if (!S) return;
    const ns = S.owners.length;
    if (!ns) return;
    const c = S.columns, owners = S.owners, per = UNIT_EVENTS_PER_JOB, chunks = Math.ceil(ns / per);
    // (The tick's shared phase list: sim_unit_state.js simPhaseList.)
    _unitEvList = simPhaseList(chunks * per);
    // Each helper owns a cache line, including the final compacted count.
    if (!_unitEvCnt || _unitEvCnt.length < (chunks + 1) * 16) { const old = _unitEvCnt; _unitEvCnt = simSharedArray(Int32Array, Math.max(64, (chunks + 1) * 16)); simParallelBind('ev.cnt', _unitEvCnt); if (old) simHeapFree(old); }
    const P = _simParams;
    P[0] = ns; P[1] = per;
    simParallelRun(SIM_KERNEL_UNIT_EVENTS, chunks);
    const L = _unitEvList, CNT = _unitEvCnt;
    let n = 0;
    for (let k = 0; k < chunks; k++) n += CNT[k * 16];
    if (n > 0) {
        _unitEventSortReserve(n);
        P[2] = gameTime; P[3] = chunks;
        _simRust(_simUnitEventSortW, P, 0, 'k_unit_event_sort', 'UNIT_EVENT_SORT');
        const E = _unitEvSort.ent, j = CNT[chunks * 16];
        if(typeof workerBrainsPrepare==='function')workerBrainsPrepare(j,true);
        let routes = null;
        if (UNIT_EVENT_ROUTE_BATCH && j >= 64 && typeof SIM_KERNEL_EVENT_ROUTES === 'number') {
            P[0] = j; P[1] = 2048; P[2] = TILE * 8;
            simParallelRun(SIM_KERNEL_EVENT_ROUTES, Math.ceil(j / 2048));
            routes = _unitEvSort.routes;
        }
        const trueTerm = _simHTerm(_UH_PFA, true);
        if(typeof workerBrainsCollect==='function')workerBrainsCollect();
        playerResourceBatchBegin();
        try {
            // (Workers: the worker kernel's pass after the others, worker.js waiRun.)
            const wai = typeof waiAvailable === 'function' && waiAvailable();
            const WL = wai ? _waiArr('list', Int32Array, j) : null;
            let wn = 0;
            // One event the JavaScript takes (its index in the sorted list).
            const one = i => {
                const ent = E[i], s = ent >> 3, u = owners.at(s);
                if (!u || u.dead) return;
                if (wai && u.workerState) {
                    if ((ent & 7) === UNIT_EV_FLOOR && _unitFloorEvent(u)) return;
                    if (c.statRow[s] < 0) _waiOwnStats(u, c, s);
                    WL[wn++] = ent;
                    return;
                }
                if (routes && routes[i * 2] >= 0 && !u.workerState && _unitNoWayCommit(u, c, s, routes[i * 2], routes[i * 2 + 1], trueTerm)) return;
                _unitEvent(u, c, s, ent & 7);
            };
            {
                // (The split on the helpers, k.rs k_unit_events_split: the worker
                // kernel's events listed, their positions kept; the rest here.)
                const per = UNIT_EVENTS_SPLIT_PER, chunks = Math.ceil(j / per), X = _unitEvSplitRoom(chunks, per);
                P[0] = j; P[1] = per; P[2] = wai ? 1 : 0; P[3] = SIM_WS_NAMES.length - 1;
                simParallelRun(SIM_KERNEL_UNIT_EVENTS_SPLIT, chunks);
                for (let k = 0; k < chunks; k++) { const m = X.cnt[k * 16]; if (m > 0) { WL.set(X.split.subarray(k * per * 2, k * per * 2 + m), wn); wn += m; } }
                for (let k = 0; k < chunks; k++) { const b = k * per * 2 + per, m = X.cnt[k * 16 + 1]; for (let r = 0; r < m; r++) one(X.split[b + r]); }
            }
            if (wn > 0) waiOutEvents(waiRun(WL, wn));
        } finally { playerResourceBatchEnd(); if(typeof workerBrainsEnd==='function')workerBrainsEnd(); }
    }
    // (Those whose energy ran out: dead now.)
    P[0] = ns; P[1] = UNIT_DEAD_PER_JOB;
    simParallelRun(SIM_KERNEL_DEAD_MARK, Math.ceil(ns / UNIT_DEAD_PER_JOB));
    // (Those on a tile that became a wall this tick are pushed off it as the
    // walls take the change at the pass's end: _simWallPushOut.)
}
// One unit's event (code: mv.rs EV_*; 0 a worker the kernel left).
function _unitEvent(u, c, s, code) {
    if (code === UNIT_EV_FLOOR && _unitFloorEvent(u)) return;
    if (u.workerState) { _unitWorkerEvent(u, c, s, code); return; }
    if (code === UNIT_EV_NOWAY) _unitNoWay(u);
    else if (code === UNIT_EV_WAITED) _unitWaitEnded(u);
    else if (code === UNIT_EV_SPATIAL) {
        pushUnitOutOfBlockedTile(u);
        u.x = _quantizeUnitWorldCoord(u.x); u.y = _quantizeUnitWorldCoord(u.y);
        updateUnitSpatial(u);
    } else if (code === 0) unitEventsStray++;
}
// A hostile floor item under the unit that the kernel cannot apply (a mine,
// or a trap it has no table for): applied (on entering its tile, then once a
// second). True: a mine went off (nothing else for the unit this tick).
function _unitFloorEvent(u) {
    const gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE);
    if (!(gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H)) return false;
    u._floorTile = gy * GRID_W + gx;
    const cell = grid[gy][gx], item = cellItemGet(cell);
    if (!item || cellOwner[(cell) - 1] === u.owner || item.underConstruction) return false;
    const itemLevel = getThingEffectiveLevel(item, stackCountToLevel(item.stacks || 1));
    switch (item.type) {
        case 'sand': applyStatusEffect(u, 'sand', itemLevel, 0, item.owner, item.type); break;
        case 'lava': applyStatusEffect(u, 'fire', itemLevel, item.damage || 1, item.owner, item.type); break;
        case 'poison_puddle': applyStatusEffect(u, 'poison', itemLevel, item.damage || 1, item.owner, item.type); break;
        case 'ice_patch': applyStatusEffect(u, 'ice', itemLevel, item.damage || 1, item.owner, item.type); break;
        case 'water_puddle': applyStatusEffect(u, 'water', itemLevel, 0, item.owner, item.type); break;
        case 'mine': u._explodeMine(cell, item, itemLevel); return true;
    }
    return false;
}
// The unit's speed this tick (Unit.update's: frozen, sandy half).
function _unitSpeedNow(u) {
    let spd = Math.fround(u.preComputed.speed * _getUnitAstarSpeedMultiplier(u));
    if (u.frozen > 0) spd *= 0.5;
    if (u.sandy > 0) spd *= 0.5;
    return spd;
}
// No way on to its path's node (the flow found none): it has not arrived. It
// keeps its target (a pending one) and heads for the closest tile it can
// reach (the helpers' answer, see _tryUpgradeAstarFallbackPath); walled in,
// it stands (the controller parks it waiting: mv.rs park_route).
function _unitNoWay(u) {
    const p = u.path, nd = p && u.pathIndex < p.length ? p[u.pathIndex] : null;
    if (!nd) return;
    let pt = u._pendingPathTarget;
    if (pt) { pt.ver = 0; pt.at = -1; pt.sub = 0; }
    else { u._pendingPathTarget = { gx: nd.x, gy: nd.y, cmd: u.commandState, src: 'nav_unreachable' }; pt = u._pendingPathTarget; }
    u.path = null; u.pathIndex = 0; u._routeKey = null; u.pathIsFallbackAstar = true;
    navPathSubstitute(u, Math.floor(u.x / TILE), Math.floor(u.y / TILE), pt);
    notePendingPathUnit(u);
}
// Ordered commit for a helper-prepared combat route failure. Preserve JS
// reference values and digest deltas exactly, as the regular setters do.
// The common native path needs no temporary JS path or repeated accessors.
function _unitNoWayCommit(u, c, s, key, comp, trueTerm) {
    if (c.nvPK[s] !== key || c.pathIndex[s] !== 0) return false;
    // (A path of more than its one node: not this one's.)
    const ph = c.pthH[s];
    if (ph >= 2 && (SIM_PATH.a[ph - 2] & 0xffffff) > 1) return false;
    const decoded = key >> 1, profile = Math.floor(decoded / 16777216), dest = decoded % 16777216;
    if (profile !== (c.jFly[s] ? NAV_PROFILE_AIR : NAV_PROFILE_GROUND)) return false;
    if ((c.ptSt[s] & 3) === 2) { c.ptVer[s] = 0; c.ptAt[s] = -1; c.ptSub[s] = 0; }
    else { _unitNoWayPt.gx = dest % GRID_W; _unitNoWayPt.gy = Math.floor(dest / GRID_W); _unitNoWayPt.cmd = c.commandState[s]; simPendingTargetSet(c, s, _unitNoWayPt); }
    c.nvPK[s] = -1; simUnitPathRelease(c, s); simPathRelease(c.pthH, s);
    c.mvOn[mvtM(s)] = 0; c.mvSteer[mvtS(s * SIM_STEER_W)] = -1; c.pathIndex[s] = 0; c.rkF[s] = 0;
    simPendingFlagSet(c, s, true);
    const pt = u._pendingPathTarget;
    if (comp === -2) comp = _navUnitComp(profile, Math.floor(c.y[s] / (TILE * 8)) * GRID_W + Math.floor(c.x[s] / (TILE * 8)));
    const to = Math.max(0, Math.min(GRID_H - 1, c.ptGy[s])) * GRID_W + Math.max(0, Math.min(GRID_W - 1, c.ptGx[s]));
    navPathSubstitutePrepared(u, profile, to, comp, pt);
    notePendingPathUnit(u);
    return true;
}
// (_unitNoWayCommit's target written into the columns: one object, reused.)
const _unitNoWayPt = { gx: 0, gy: 0, cmd: 0, src: 'nav_unreachable' };
// A unit's pending target (Unit._pendingPathTarget) as its columns hold it
// (sim_unit_state.js ptSt ...): read and written in place through these, as
// the object they replaced. Made when read, short-lived; by the unit, so a
// relayout between its reads moves nothing under it.
class SimPendingTarget {
    constructor(u) { this.u = u; }
    get gx() { const u = this.u, c = u._us; return c ? c.ptGx[u._si] : undefined; }
    set gx(v) { const u = this.u, c = u._us; if (c) simPendingTargetTile(c, u._si, v, c.ptGy[u._si]); }
    get gy() { const u = this.u, c = u._us; return c ? c.ptGy[u._si] : undefined; }
    set gy(v) { const u = this.u, c = u._us; if (c) simPendingTargetTile(c, u._si, c.ptGx[u._si], v); }
    get cmd() { const u = this.u, c = u._us; return c ? c.ptCmd[u._si] : undefined; }
    set cmd(v) { const u = this.u, c = u._us; if (c) c.ptCmd[u._si] = v | 0; }
    get src() { const u = this.u, c = u._us; if (!c) return undefined; const k = c.ptSrc[u._si]; return k === 255 ? undefined : SIM_PPT_SRC[k]; }
    set src(v) { const u = this.u, c = u._us; if (c) { const k = SIM_PPT_SRC.indexOf(v); c.ptSrc[u._si] = v === undefined ? 255 : k < 0 ? 0 : k; } }
    get ver() { const u = this.u, c = u._us; return c ? c.ptVer[u._si] : undefined; }
    set ver(v) { const u = this.u, c = u._us; if (c) c.ptVer[u._si] = v | 0; }
    get at() { const u = this.u, c = u._us; return c ? c.ptAt[u._si] : undefined; }
    set at(v) { const u = this.u, c = u._us; if (c) c.ptAt[u._si] = v | 0; }
    get sub() { const u = this.u, c = u._us; return c ? c.ptSub[u._si] : undefined; }
    set sub(v) { const u = this.u, c = u._us; if (c) c.ptSub[u._si] = v | 0; }
    // (A plain copy: snapshots, Unit._pptSnap.)
    plain() { return { gx: this.gx, gy: this.gy, cmd: this.cmd, src: this.src, ver: this.ver, at: this.at, sub: this.sub }; }
}
// A unit waiting for its way (a pending target) near its issued target (the
// controller's look): its way once more, else the order ends where it stands.
function _unitWaitEnded(u) {
    if (u.pathIsFallbackAstar) _tryUpgradeAstarFallbackPath(u);
    if ((u.path && u.pathIndex < u.path.length) || !u._pendingPathTarget) return;
    u._pendingPathTarget = null; u.pathIsFallbackAstar = false; u.targetPos = null; u.path = null;
    if (u.commandState === CMD_ATTACK_MOVING) u._attackMoveGx = u._attackMoveGy = null;
    u.commandState = CMD_IDLE;
}
// A worker the kernel left to this thread (its way's end, a wake, idle, no
// way on; or its AI's look on its way, moved by the kernel): its AI, as
// Unit.update ran it, without a step of its own (the kernel moves it, armed
// again here when its AI changed what it does).
function _unitWorkerEvent(u, c, s, code) {
    const moved = c.mvOut[s] !== 0;
    updateWorkerAI(u);
    _workerSyncCommand(u);
    // (A worker whose way ends here: its arrival is its AI's at once, below.)
    const wkLeft = u.workerState && u.path ? u.path.length - u.pathIndex : 0;
    if (!moved && u.commandState === CMD_MOVING) _unitWorkerWayEnd(u, code);
    if (wkLeft > 0 && u.workerState && !u.dead && !(u.path && u.pathIndex < u.path.length)) {
        updateWorkerAI(u);
        _workerSyncCommand(u);
    }
    if (!u.dead && c.mvOn[s] === 0) _unitArmAgain(u, c);
}
// A moving worker the kernel handed back (Unit.doMoving without its step):
// at its way's node, the node passed; no way on, at its task (a tile from it)
// done there, else (sent by the player) a pending target; its way done, the
// move ends (a pending target near its issued target too).
function _unitWorkerWayEnd(u, code) {
    const pt0 = u._pendingPathTarget;
    if ((!u.path || u.pathIndex >= u.path.length) && pt0 && pt0.cmd === CMD_MOVING) {
        if (u.pathIsFallbackAstar) _tryUpgradeAstarFallbackPath(u);
        const pt = u._pendingPathTarget;
        if ((!u.path || u.pathIndex >= u.path.length) && pt && pt.cmd === CMD_MOVING && u._isNearIssuedTarget(_unitSpeedNow(u))) {
            u._pendingPathTarget = null; u.pathIsFallbackAstar = false; u.targetPos = null; u.commandState = CMD_IDLE;
        }
        return;
    }
    // (Held: it keeps its way and its progress.)
    if (u.holdPosition) return;
    const p = u.path;
    if (p && u.pathIndex < p.length) {
        const nd = p[u.pathIndex];
        if (!nd.nav) return;
        const gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE);
        if (gx === nd.x && gy === nd.y) { u.pathIndex++; u._navLastD = -1; }
        else if (code === UNIT_EV_NOWAY) {
            if (u.workerState === 'MANUAL_MOVE') { _unitNoWay(u); return; }
            if (Math.abs(nd.x - gx) > 1 || Math.abs(nd.y - gy) > 1) return;
            u.pathIndex = p.length;
        } else return;
        if (u.pathIndex < p.length) return;
    }
    const pt = u._pendingPathTarget;
    if (pt && pt.cmd === CMD_MOVING) {
        u.path = null;
        if (u._isNearIssuedTarget(_unitSpeedNow(u))) { u._pendingPathTarget = null; u.pathIsFallbackAstar = false; u.targetPos = null; u.commandState = CMD_IDLE; }
        return;
    }
    u.commandState = CMD_IDLE; u.path = null; u.targetPos = null;
}
// A unit given an attack order (main.js processAction 'attack' and
// 'attackBuilding', its target set after): attacking, no way of its own, no
// wait, no attack-move; the movement kernel follows the order from its target
// columns (mv.rs forced).
function unitAttackOrder(u) {
    u.commandState = CMD_ATTACKING;
    u._attackMoveGx = u._attackMoveGy = null;
    u.path = null; u.pathIndex = 0; u._routeKey = null;
    u._pendingPathTarget = null; u.pathIsFallbackAstar = false;
    const c = u._us;
    if (c) { const s = u._si; c.cmMode[mvtM(s)] = 0; c.mvOn[mvtM(s)] = 0; c.mvWk[s] = 0; }
}
function unitPassBegin() { _unitPassOn = true; spatialCountsDeferBegin(); astarPassStart(); }
function unitPassEnd() {
    _unitPassOn = false;
    // (The kernels' chunk moves: counted once, after the separation commit,
    // when one follows this tick.)
    spatialCountsDeferEnd(!!(_sepPending && _sepPending.tick === currentTick));
    astarPassEnd(); simMoveWallsDeferEnd();
}
function _unitTickX(t) { const c = t._us; return c && _unitPassOn ? c.x0[t._si] * 0.125 : t.x; }
function _unitTickY(t) { const c = t._us; return c && _unitPassOn ? c.y0[t._si] * 0.125 : t.y; }
// Any target (units as _unitTickX, other things where they are).
// Whether another unit counts as dead during the pass: as at its start
// (the movement kernel's dead0, this tick), whatever fell since (a ram's
// recoil, a mine): its hits are dropped after the pass anyway.
let _simDead0Tick = -1;
function _unitTickDead(t) { const c = t._us; return c && _unitPassOn && _simDead0Tick === gameTime ? c.dead0[t._si] === 1 : !!t.dead; }
// Units whose target was set before the target had a slot (a restore): the slots are found before the state hash (its kernel reads
// them: a target counts there by its slot).
let _tuPending = [];
// Targets set during a decode (unit, target pairs): a new unit's shell has its
// id only once its row is filled, so each is taken again at the decode's end.
let _tuDecoded = [], _tbDecoded = [];
// (Worker memory set during a decode to a structure whose shell had no tile
// yet: set again at its end, unless a later row set another.)
let _wmDecoded = [];
function _unitWmDecodeLater(u, k, v) { if (typeof _snapDec !== 'undefined' && _snapDec !== null) _wmDecoded.push(u, k, v); }
function simUnitTargetsDecoded() {
    const wm = _wmDecoded;
    _wmDecoded = [];
    for (let i = 0; i < wm.length; i += 3) { const u = wm[i]; if (u._us && u[wm[i + 1]] === undefined) u[wm[i + 1]] = wm[i + 2]; }
    // (A structure's shell has its tile once its row is filled too.)
    const bl = _tbDecoded;
    _tbDecoded = [];
    for (let i = 0; i < bl.length; i += 2) { const u = bl[i], c = u._us; if (c && c.acqB[u._si] && c.tbT[u._si] < 0) u.targetBuilding = bl[i + 1]; }
    const list = _tuDecoded;
    _tuDecoded = [];
    for (let i = 0; i < list.length; i += 2) {
        const u = list[i], t = list[i + 1], c = u._us;
        if (!c) continue;
        const s = u._si;
        // (Only while it is still the unit's target: a later row may have set another.)
        if (c.tuId[s] === 0 || (c.tuS[s] >= 0 ? _simUnitState.owners.at(c.tuS[s]) !== t : false)) continue;
        u.targetUnit = t;
    }
    // Every unit's target slot from its id: a patch makes some units anew (in
    // other slots), and the units it does not carry still name their old
    // slots (the state hash reads a target by its slot).
    const S = _simUnitState;
    if (!S) return;
    const c = S.columns, owners = S.owners;
    for (const u of units) {
        if (!u || u._us !== c) continue;
        const s = u._si, id = c.tuId[s];
        if (id === 0) continue;
        const q = c.tuS[s];
        if (q >= 0 && owners.at(q) && (owners.at(q).id | 0) === id) continue;
        const t = getUnitById(id);
        c.tuS[s] = t && t._us === c && t._si >= 0 ? t._si : -1;
        if (c.tuS[s] < 0) _tuPending.push(u);
    }
}
function simUnitTargetsResolve() {
    if (!_tuPending.length) return;
    const list = _tuPending;
    _tuPending = [];
    for (let i = 0; i < list.length; i++) {
        const u = list[i], c = u._us;
        if (!c) continue;
        const s = u._si, id = c.tuId[s];
        if (id === 0 || c.tuS[s] >= 0) continue;
        const t = getUnitById(id);
        if (t && t._us === c && t._si >= 0) c.tuS[s] = t._si;
    }
}
function _thingTickX(t) { return t instanceof Unit ? _unitTickX(t) : t.x; }
function _thingTickY(t) { return t instanceof Unit ? _unitTickY(t) : t.y; }


// V8 marks a field that no object of a shape has rewritten as constant;
// the first rewrite (say, the first move order setting _pendingPathTarget)
// then gives every unit a new shape, and each of the next hundred thousand
// unit reads migrates its object (about 10 us each: a stall of a second).
// The first unit rewrites each of its fields (then restores them), so the
// shape's fields are all mutable and general from the start.
let _unitFieldsMutable = false;
function _makeUnitFieldsMutable(u) {
    _unitFieldsMutable = true;
    // Every field also takes any kind of value (small integer, object,
    // fraction): a field holding only undefined that later gets an integer,
    // or an integer field a fraction, changes the shape the same way.
    for (const k of Object.keys(u)) {
        const v = u[k];
        u[k] = 1; u[k] = _UNIT_FIELD_WIDEN; u[k] = 0.5; u[k] = v;
    }
}

// A plain object for widening unit reference fields (see the Unit constructor).
const _UNIT_FIELD_WIDEN = {};

// Largest unit collision radius in the current stats (the runtime config can
// edit them in place), re-read once per tick.
let _maxUnitCollisionRadiusCache = 0, _maxUnitCollisionRadiusTick = NaN;
function _maxUnitCollisionRadius() {
    if (_maxUnitCollisionRadiusTick !== gameTime) {
        let m = 0.1;
        for (let k in BASE_UNIT_STATS) {
            let st = BASE_UNIT_STATS[k];
            if (!st || typeof st !== 'object') continue;
            m = Math.max(m, Number(st.collisionR) || 0, Number(st.r) || 0);
        }
        _maxUnitCollisionRadiusCache = m;
        _maxUnitCollisionRadiusTick = gameTime;
    }
    return _maxUnitCollisionRadiusCache;
}

class Unit {
    // (level: its stats' level from the start, one scaling: a spawn's queue
    // level; prepare(unit): its role set up before that scaling, as a spawn's
    // worker configuration was.)
    constructor(unitType, owner, x, y, level = 1, prepare = null) {
        simUnitStateAllocate(this, x, y);
        this.id = nextUnitId++;
        this.unitType = unitType;
        this.owner = owner;
        this.x = x; this.y = y;
        this.prevX = x; this.prevY = y;
        if (this._us) { this._us.x0[this._si] = this._us.x[this._si]; this._us.y0[this._si] = this._us.y[this._si]; this._us.upT[this._si] = simUnitTypeIndex(unitType); if (typeof upkeepUnitRefresh === 'function') upkeepUnitRefresh(this); }
        // followPath: inputs of the last completed node scan (a cache).
        this._fpPath = null;
        this.teleportHideTicks = 0;

        let s = BASE_UNIT_STATS[unitType] || BASE_UNIT_STATS.norm;
        this.energy = Math.max(1, Math.floor(Number(s.energy) || 1));
        this.preComputedBase = null;
        this.preComputedEffective = null;
        this.basePreComputed = null;
        this.preComputed = null;
        this.attackTimer = 0;
        // (vis, color, the resistances, attackStyle, isKing: its type's,
        // prototype getters: UNIT_TYPE_FIELDS below.)
        this.r = s.r;
        this.collisionR = Number.isFinite(s.collisionR) ? s.collisionR : this.r;
        // References live in paged columns. Keep defaults implicit instead
        // of temporarily writing widening objects into every unit's page.
        this.attackTarget = null; // visual: current attack target for draw effects
        this.attackFlash = 0; // visual: flash timer for attack animation

        this.commandState = CMD_IDLE;
        // (Targets: per-slot arrays behind accessors, SIM_UNIT_OBJ_FIELDS.)
        this.targetUnit = null;
        this.targetBuilding = null;
        this.targetPos = null;
        this.path = null;
        this.pathIndex = 0;
        this.forcedAttackTarget = false;
        this._forcedTargetLastSeenX = null;
        this._forcedTargetLastSeenY = null;
        // (The fields a move order writes, together: see _issueGroupMoveOrder.)
        this._routeKey = null; this._routeEnd = -1; this._routeSegEnd = -1; this._navReady = 0; this._attackMoveGx = undefined; this._attackMoveGy = undefined; this.pathIsFallbackAstar = undefined; this._pendingPathTarget = undefined; this.holdPosition = undefined; this._awaitGroupPath = 0;
        this.dead = false;
        this.unitLevel = 1;
        this.stackCount = 1;
        this.effectiveStacks = 1;
        this.effectiveLevel = 1;
        this.baseLevel = 1;

        // Status effects
        this.poisoned = 0; this.poisonTickDamage = 0;
        this.burning = 0; this.burnTickDamage = 0;
        this.frozen = 0; this.iceTickDamage = 0;
        this.wet = 0; this.sandy = 0; this.watched = 0; this.watchedByTeam = -1;
        this.vx = 0; this.vy = 0;
        this.workerTransferCooldown = 0;

        // Fields that are otherwise added on first use (workers, pathing,
        // astar budget, damage flash...). Declaring every one here, in one
        // order, gives all units one hidden class: property reads in the
        // per-unit tick loops stay monomorphic instead of megamorphic.
        // Values stay undefined, as if the field had never been set.
        this._lastAppliedEffectiveLevel = undefined;
        this._floorTile = -1; this._removedNow = false; this._okTile = -1; this._okVer = 0; this._okNodeTile = -1; this._okNodeVer = 0; this._effectiveStatsStamp = 0; this._navLastD = -1; this._vsGen = 0; this._vsR = -1; this._vsA = -1; this._vsP1 = -1; this._vsP2 = -1;
        this.workerState = undefined; this.workerType = undefined; this.carryingValue = undefined; this.workerTarget = undefined;
        this.workerTargetType = undefined; this._workerReservedTileIndex = undefined;
        this._workerNextIdleRetargetTick = undefined; this._idleFailVer = -1; this._idleFailUntil = 0;
        this.builderHasMaterial = undefined; this._builderLastWatchX = undefined; this._builderLastWatchY = undefined;
        this._builderLastMoveTick = undefined; this.healerHasMaterial = undefined;
        this.researcherHasMaterial = undefined;
        this._astarBudgetRetryTick = undefined;
        // (The workers' and other roles' memory: UNIT_ROLE_FIELDS, below.)
        this._damageFlashStart = 0;
        // Same meaning as unset (no flash); typed like the values set later
        // (see the widening note above): -0 is a fractional-kind zero.
        this._damageFlashUntil = 0; this._damageFlashStrength = -0; this._damageFlashColor = '';
        this._scoutTarget = undefined;

        this._spatialKey = undefined; this._spatialAreaId = undefined; this._spatialTile = -1; this._spatialOwner = -1; this._spatialEpoch = 0;
        if (!_unitFieldsMutable) _makeUnitFieldsMutable(this);
        // A snapshot restore writes every field itself (same order, so the
        // same layout) and indexes the unit afterwards.
        if (_snapUnitShellMode) return;
        if (prepare) prepare(this);
        applyUnitLevelScaling(this, level);
        this.energy = this.preComputedEffective ? this.preComputedEffective.maxEnergy : this.energy;
        if (typeof SIM_OCCUPANCY_ENABLED !== 'undefined' && SIM_OCCUPANCY_ENABLED && !occupancySpawn(this)) { this.dead = true; simUnitStateDetach(_simUnitState,this._si); return; }
        updateUnitSpatial(this);
    }

    get id() { return this._us ? this._us.id[this._si] : (this._goneRecord ? this._goneRecord.id : this._goneId); }
    set id(v) { if (this._us) this._us.id[mvtM(this._si)] = v; else if (this._det) this._det.id = v; else Object.defineProperty(this, 'id', { value: v, writable: true, enumerable: true, configurable: true }); }
    get owner() { return this._us ? this._us.owner[this._si] : (this._goneRecord ? this._goneRecord.owner : this._goneOwner); }
    set owner(v) { if (this._us) { if (this._us.owner[this._si] !== v) this._us.mvOn[mvtM(this._si)] = 0; this._us.owner[mvtM(this._si)] = v; if (typeof upkeepUnitRefresh === 'function') upkeepUnitRefresh(this); } else if (this._det) this._det.owner = v; else Object.defineProperty(this, 'owner', { value: v, writable: true, enumerable: true, configurable: true }); }
    get x() { return this._us ? this._us.x[this._si] * 0.125 : this._goneRecord ? this._goneRecord.x : this._si === -1 ? this._goneX8 * 0.125 : undefined; }
    set x(v) { if (this._us) { if(typeof SIM_OCCUPANCY_ENABLED!=='undefined' && SIM_OCCUPANCY_ENABLED && occupancyTracks(this._si)) occupancyMovePosition(this,Math.round(v*8),this._us.y[this._si]); else this._us.x[mvtM(this._si)] = Math.round(v * 8); } else if (this._det) this._det.x = v; else Object.defineProperty(this, 'x', { value: v, writable: true, enumerable: true, configurable: true }); }
    get y() { return this._us ? this._us.y[this._si] * 0.125 : this._goneRecord ? this._goneRecord.y : this._si === -1 ? this._goneY8 * 0.125 : undefined; }
    set y(v) { if (this._us) { if(typeof SIM_OCCUPANCY_ENABLED!=='undefined' && SIM_OCCUPANCY_ENABLED && occupancyTracks(this._si)) occupancyMovePosition(this,this._us.x[this._si],Math.round(v*8)); else this._us.y[mvtM(this._si)] = Math.round(v * 8); } else if (this._det) this._det.y = v; else Object.defineProperty(this, 'y', { value: v, writable: true, enumerable: true, configurable: true }); }
    // A jump (a portal): both coordinates at once, placed at the nearest free
    // spot there in the occupancy grid (sim_occupancy.js occupancyTeleport),
    // not swept through it.
    teleportTo(x, y) {
        if (this._us && typeof SIM_OCCUPANCY_ENABLED !== 'undefined' && SIM_OCCUPANCY_ENABLED && occupancyTracks(this._si)) occupancyTeleport(this, Math.round(x * 8), Math.round(y * 8));
        else { this.x = x; this.y = y; }
    }
    get prevX() { return this._us ? this._us.prevX[this._si] * 0.125 : (this._det ? this._det.prevX : undefined); }
    set prevX(v) { if (this._us) this._us.prevX[this._si] = Math.round(v * 8); else if (this._det) this._det.prevX = v; else Object.defineProperty(this, 'prevX', { value: v, writable: true, enumerable: true, configurable: true }); }
    get prevY() { return this._us ? this._us.prevY[this._si] * 0.125 : (this._det ? this._det.prevY : undefined); }
    set prevY(v) { if (this._us) this._us.prevY[this._si] = Math.round(v * 8); else if (this._det) this._det.prevY = v; else Object.defineProperty(this, 'prevY', { value: v, writable: true, enumerable: true, configurable: true }); }
    get vx() { return this._us ? this._us.vx[this._si] : (this._det ? this._det.vx : undefined); }
    set vx(v) { if (this._us) this._us.vx[this._si] = v; else if (this._det) this._det.vx = v; else Object.defineProperty(this, 'vx', { value: v, writable: true, enumerable: true, configurable: true }); }
    get vy() { return this._us ? this._us.vy[this._si] : (this._det ? this._det.vy : undefined); }
    set vy(v) { if (this._us) this._us.vy[this._si] = v; else if (this._det) this._det.vy = v; else Object.defineProperty(this, 'vy', { value: v, writable: true, enumerable: true, configurable: true }); }
    get attackTimer() { return this._us ? this._us.attackTimer[this._si] : (this._det ? this._det.attackTimer : undefined); }
    set attackTimer(v) { if (this._us) { this._us.attackTimer[this._si] = v; if (v > 0) this._us.tmOn[this._si] = 1; } else if (this._det) this._det.attackTimer = v; else Object.defineProperty(this, 'attackTimer', { value: v, writable: true, enumerable: true, configurable: true }); }
    get attackFlash() { return this._us ? this._us.attackFlash[this._si] : (this._det ? this._det.attackFlash : undefined); }
    set attackFlash(v) { if (this._us) { this._us.attackFlash[this._si] = v; if (v > 0) this._us.tmOn[this._si] = 1; } else if (this._det) this._det.attackFlash = v; else Object.defineProperty(this, 'attackFlash', { value: v, writable: true, enumerable: true, configurable: true }); }
    get energy() { return this._us ? this._us.energy[this._si] : this._goneRecord ? this._goneRecord.energy : this._si === -1 ? 0 : undefined; }
    set energy(v) { if (this._us) this._us.energy[this._si] = v; else if (this._det) this._det.energy = v; else Object.defineProperty(this, 'energy', { value: v, writable: true, enumerable: true, configurable: true }); }
    get pathIndex() { return this._us ? this._us.pathIndex[this._si] : (this._det ? this._det.pathIndex : undefined); }
    set pathIndex(v) { if (this._us) { if (this._us.pathIndex[this._si] !== v) this._us.mvOn[mvtM(this._si)] = 0; this._us.pathIndex[this._si] = v; } else if (this._det) this._det.pathIndex = v; else Object.defineProperty(this, 'pathIndex', { value: v, writable: true, enumerable: true, configurable: true }); }
    get commandState() { return this._us ? this._us.commandState[this._si] : (this._det ? this._det.commandState : undefined); }
    set commandState(v) { if (this._us) { if (this._us.commandState[this._si] !== v) this._us.mvOn[mvtM(this._si)] = 0; this._us.commandState[this._si] = v; } else if (this._det) this._det.commandState = v; else Object.defineProperty(this, 'commandState', { value: v, writable: true, enumerable: true, configurable: true }); }
    // Spatial index and visibility registration (columns; see SIM_MOVE_COLUMNS).
    get _spatialTile() { const c = this._us; return c ? c.spTile[this._si] : -1; }
    set _spatialTile(v) { const c = this._us; if (c) c.spTile[this._si] = v; else if (c === undefined) Object.defineProperty(this, '_spatialTile', { value: v, writable: true, configurable: true }); }
    get _spatialAreaId() { const c = this._us; if (!c) return undefined; const v = c.spArea[this._si]; return v === -2 ? undefined : v; }
    set _spatialAreaId(v) { const c = this._us; if (c) c.spArea[this._si] = v === undefined ? -2 : v; else if (c === undefined) Object.defineProperty(this, '_spatialAreaId', { value: v, writable: true, configurable: true }); }
    get _spatialOwner() { const c = this._us; return c ? c.spOwner[this._si] : -1; }
    set _spatialOwner(v) { const c = this._us; if (c) c.spOwner[this._si] = v; else if (c === undefined) Object.defineProperty(this, '_spatialOwner', { value: v, writable: true, configurable: true }); }
    get _spatialEpoch() { const c = this._us; return c ? c.spEpoch[this._si] : 0; }
    set _spatialEpoch(v) { const c = this._us; if (c) c.spEpoch[this._si] = v; else if (c === undefined) Object.defineProperty(this, '_spatialEpoch', { value: v, writable: true, configurable: true }); }
    get _spatialUnitTypeIdx() { const c = this._us; if (!c) return undefined; const v = c.spType[this._si]; return v === -1 ? undefined : v; }
    set _spatialUnitTypeIdx(v) { const c = this._us; if (c) c.spType[this._si] = v === undefined ? -1 : v; else if (c === undefined) Object.defineProperty(this, '_spatialUnitTypeIdx', { value: v, writable: true, configurable: true }); }
    get _vsGen() { const c = this._us; return c ? c.vsGen[this._si] : 0; }
    set _vsGen(v) { const c = this._us; if (c) c.vsGen[this._si] = v; else if (c === undefined) Object.defineProperty(this, '_vsGen', { value: v, writable: true, configurable: true }); }
    get _vsR() { const c = this._us; return c ? c.vsR[this._si] : -1; }
    set _vsR(v) { const c = this._us; if (c) c.vsR[this._si] = v; else if (c === undefined) Object.defineProperty(this, '_vsR', { value: v, writable: true, configurable: true }); }
    get _vsA() { const c = this._us; return c ? c.vsA[this._si] : -1; }
    set _vsA(v) { const c = this._us; if (c) c.vsA[this._si] = v; else if (c === undefined) Object.defineProperty(this, '_vsA', { value: v, writable: true, configurable: true }); }
    get _vsP1() { const c = this._us; return c ? c.vsP1[this._si] : -1; }
    set _vsP1(v) { const c = this._us; if (c) c.vsP1[this._si] = v; else if (c === undefined) Object.defineProperty(this, '_vsP1', { value: v, writable: true, configurable: true }); }
    get _vsP2() { const c = this._us; return c ? c.vsP2[this._si] : -1; }
    set _vsP2(v) { const c = this._us; if (c) c.vsP2[this._si] = v; else if (c === undefined) Object.defineProperty(this, '_vsP2', { value: v, writable: true, configurable: true }); }
    get _spatialKey() { const c = this._us; if (!c) return undefined; const k = c.sepKey[this._si]; return k === SIM_SEP_ABSENT ? undefined : k; }
    set _spatialKey(v) { const c = this._us; if (c) c.sepKey[this._si] = v === undefined ? SIM_SEP_ABSENT : v; else if (c === undefined) Object.defineProperty(this, '_spatialKey', { value: v, writable: true, configurable: true }); }
    // Stacks and levels: columns (SIM_UNIT_LEVEL_COLUMNS; NaN: not set; the
    // levels Int8, 0 not set: a NaN stored is 0);
    // the upkeep bin follows them (upkeepUnitRefresh).
    get stackCount() { const c = this._us; const v = c ? c.stackCount[this._si] : (this._det ? this._det.stackCount : undefined); return v === v ? v : undefined; }
    set stackCount(v) { const c = this._us; if (c) { c.stackCount[this._si] = typeof v === 'number' ? v : NaN; if (typeof upkeepUnitRefresh === 'function') upkeepUnitRefresh(this); } else if (this._det) this._det.stackCount = v; else Object.defineProperty(this, 'stackCount', { value: v, writable: true, enumerable: true, configurable: true }); }
    get unitLevel() { const c = this._us; const v = c ? c.unitLevel[this._si] : (this._det ? this._det.unitLevel : undefined); return v > 0 ? v : undefined; }
    set unitLevel(v) { const c = this._us; if (c) { c.unitLevel[this._si] = typeof v === 'number' ? v : NaN; if (typeof upkeepUnitRefresh === 'function') upkeepUnitRefresh(this); } else if (this._det) this._det.unitLevel = v; else Object.defineProperty(this, 'unitLevel', { value: v, writable: true, enumerable: true, configurable: true }); }
    get baseLevel() { const c = this._us; const v = c ? c.baseLevel[this._si] : (this._det ? this._det.baseLevel : undefined); return v > 0 ? v : undefined; }
    set baseLevel(v) { const c = this._us; if (c) { c.baseLevel[this._si] = typeof v === 'number' ? v : NaN; if (typeof upkeepUnitRefresh === 'function') upkeepUnitRefresh(this); } else if (this._det) this._det.baseLevel = v; else Object.defineProperty(this, 'baseLevel', { value: v, writable: true, enumerable: true, configurable: true }); }
    get effectiveStacks() { const c = this._us; const v = c ? c.effectiveStacks[this._si] : (this._det ? this._det.effectiveStacks : undefined); return v === v ? v : undefined; }
    set effectiveStacks(v) { const c = this._us; if (c) c.effectiveStacks[this._si] = typeof v === 'number' ? v : NaN; else if (this._det) this._det.effectiveStacks = v; else Object.defineProperty(this, 'effectiveStacks', { value: v, writable: true, enumerable: true, configurable: true }); }
    get effectiveLevel() { const c = this._us; const v = c ? c.effectiveLevel[this._si] : (this._det ? this._det.effectiveLevel : undefined); return v > 0 ? v : undefined; }
    set effectiveLevel(v) { const c = this._us; if (c) { c.effectiveLevel[this._si] = typeof v === 'number' ? v : NaN; if (typeof upkeepUnitRefresh === 'function') upkeepUnitRefresh(this); } else if (this._det) this._det.effectiveLevel = v; else Object.defineProperty(this, 'effectiveLevel', { value: v, writable: true, enumerable: true, configurable: true }); }
    get _lastAppliedEffectiveLevel() { const c = this._us; const v = c ? c._lastAppliedEffectiveLevel[this._si] : (this._det ? this._det._lastAppliedEffectiveLevel : undefined); return v > 0 ? v : undefined; }
    set _lastAppliedEffectiveLevel(v) { const c = this._us; if (c) c._lastAppliedEffectiveLevel[this._si] = typeof v === 'number' ? v : NaN; else if (this._det) this._det._lastAppliedEffectiveLevel = v; else Object.defineProperty(this, '_lastAppliedEffectiveLevel', { value: v, writable: true, enumerable: true, configurable: true }); }
    // The tile whose floor it last checked (Unit.update's floor items): a
    // column (mvFloor) the movement kernel keeps as it moves the unit.
    get _floorTile() { const c = this._us; return c ? c.mvSteer[this._si * SIM_STEER_W + SIM_ST_FLOOR] : (this._det ? this._det._floorTile : this._flt); }
    set _floorTile(v) { const c = this._us; if (c) c.mvSteer[mvtS(this._si * SIM_STEER_W + SIM_ST_FLOOR)] = v; else if (this._det) this._det._floorTile = v; else Object.defineProperty(this, '_flt', { value: v, writable: true, configurable: true }); }
    // Arriving in a crowd (see _followNavNode): a column (mvNavLD) the kernel shares.
    get _sepMoved() { const c = this._us; return c ? c.sepMov[this._si] & 1 : (this._det ? this._det._sepMoved : (this._smv | 0)); }
    set _sepMoved(v) { const c = this._us; if (c) c.sepMov[this._si] = v ? 1 : 0; else if (this._det) this._det._sepMoved = v ? 1 : 0; else Object.defineProperty(this, '_smv', { value: v ? 1 : 0, writable: true, configurable: true }); }
    get _navLastD() { const c = this._us; return c ? c.mvNavLD[this._si] : (this._det ? this._det._navLastD : this._nld); }
    set _navLastD(v) { const c = this._us; if (c) c.mvNavLD[this._si] = v; else if (this._det) this._det._navLastD = v; else Object.defineProperty(this, '_nld', { value: v, writable: true, configurable: true }); }
    // A forced target's last seen position (null: none): columns fLsX/fLsY
    // (NaN for null), which the movement kernel writes for forced holds and
    // chases (see simMoveTryHold).
    // A builder's watchdog (worker.js): columns the kernel samples (wkWx,
    // wkWy, wkLmt) for a parked builder.
    // (In its worker record (simUnitWk): one taken by a set, unless it
    // stores the default a unit without one reads.)
    get _builderLastWatchX() { const c = this._us; if (c) { const v = c.wkWx[c.wkIx[this._si]]; return v === v ? v : undefined; } return this._det ? this._det._builderLastWatchX : this._bwx; }
    set _builderLastWatchX(v) { const c = this._us; if (c) { const x = typeof v === 'number' ? v : NaN, w = c.wkIx[this._si]; if (w > 0 || x === x) c.wkWx[w > 0 ? w : simUnitWk(c, this._si)] = x; } else if (this._det) this._det._builderLastWatchX = v; else Object.defineProperty(this, '_bwx', { value: v, writable: true, configurable: true }); }
    get _builderLastWatchY() { const c = this._us; if (c) { const v = c.wkWy[c.wkIx[this._si]]; return v === v ? v : undefined; } return this._det ? this._det._builderLastWatchY : this._bwy; }
    set _builderLastWatchY(v) { const c = this._us; if (c) { const y = typeof v === 'number' ? v : NaN, w = c.wkIx[this._si]; if (w > 0 || y === y) c.wkWy[w > 0 ? w : simUnitWk(c, this._si)] = y; } else if (this._det) this._det._builderLastWatchY = v; else Object.defineProperty(this, '_bwy', { value: v, writable: true, configurable: true }); }
    get _builderLastMoveTick() { const c = this._us; if (c) { const v = c.wkLmt[c.wkIx[this._si]]; return v === -2147483648 ? undefined : v; } return this._det ? this._det._builderLastMoveTick : this._bmt; }
    set _builderLastMoveTick(v) { const c = this._us; if (c) { const t = typeof v === 'number' && v === Math.floor(v) && Math.abs(v) < 2147483647 ? v : -2147483648, w = c.wkIx[this._si]; if (w > 0 || t !== -2147483648) c.wkLmt[w > 0 ? w : simUnitWk(c, this._si)] = t; } else if (this._det) this._det._builderLastMoveTick = v; else Object.defineProperty(this, '_bmt', { value: v, writable: true, configurable: true }); }
    // Damage dealt to it not reported yet: over time (stAcc, reported every
    // STATUS_DOT_REPORT_TICKS: its shrine share, its flash), by a laser
    // (lzAcc, every LASER_REPORT_TICKS, and the beam: lzBeam, its retaliation
    // and shrine share). State: snapshots and patches carry them (a repair
    // dropped them on every peer: the reports, shrine income and
    // retaliations of an uninterrupted match never came).
    get _dotPending() { const c = this._us; return c ? c.stAc[c.stIx[this._si]] : (this._det ? this._det._dotPending || 0 : this._dtp || 0); }
    set _dotPending(v) { v = Number(v) || 0; const c = this._us; if (c) { const s = this._si; let r = c.stIx[s]; if (r === 0 && v !== 0) r = simUnitSt(c, s); if (r !== 0) c.stAc[r] = v; } else if (this._det) this._det._dotPending = v; else Object.defineProperty(this, '_dtp', { value: v, writable: true, configurable: true }); }
    get _laserPending() { const c = this._us; return c ? c.lzAcc[this._si] : (this._det ? this._det._laserPending || 0 : this._lzp || 0); }
    set _laserPending(v) { v = Number(v) || 0; const c = this._us; if (c) c.lzAcc[this._si] = v; else if (this._det) this._det._laserPending = v; else Object.defineProperty(this, '_lzp', { value: v, writable: true, configurable: true }); }
    get _laserBeam() { const c = this._us; return c ? c.lzBeam[this._si] : (this._det ? this._det._laserBeam || 0 : this._lzb || 0); }
    set _laserBeam(v) { v = Math.floor(Number(v)) || 0; const c = this._us; if (c) c.lzBeam[this._si] = v; else if (this._det) this._det._laserBeam = v; else Object.defineProperty(this, '_lzb', { value: v, writable: true, configurable: true }); }
    get _forcedTargetLastSeenX() { const c = this._us; if (c) { const v = c.fLsX[this._si]; return v === v ? v : null; } return this._det ? this._det._forcedTargetLastSeenX : (this._flsx ?? null); }
    set _forcedTargetLastSeenX(v) { const c = this._us; if (c) c.fLsX[this._si] = typeof v === 'number' ? v : NaN; else if (this._det) this._det._forcedTargetLastSeenX = v; else Object.defineProperty(this, '_flsx', { value: v, writable: true, configurable: true }); }
    get _forcedTargetLastSeenY() { const c = this._us; if (c) { const v = c.fLsY[this._si]; return v === v ? v : null; } return this._det ? this._det._forcedTargetLastSeenY : (this._flsy ?? null); }
    set _forcedTargetLastSeenY(v) { const c = this._us; if (c) c.fLsY[this._si] = typeof v === 'number' ? v : NaN; else if (this._det) this._det._forcedTargetLastSeenY = v; else Object.defineProperty(this, '_flsy', { value: v, writable: true, configurable: true }); }
    // Whether its stats are behind its stat tables (research it has not
    // taken yet, see things_utils.js _unitStatsVerOf): kept in esVer as a
    // version (peer-local), sent as a flag; a restore sets markers that
    // effStatsAppliedSync turns into versions.
    get _statsBehind() { const c = this._us; return c ? _unitStatsBehind(this, c.esVer[this._si]) : !!(this._det && this._det._statsBehind); }
    set _statsBehind(v) { const c = this._us; if (c) c.esVer[this._si] = v ? -2 : -3; else if (this._det) this._det._statsBehind = !!v; }
    // Dead: a column (see SIM_MOVE_COLUMNS), true or false.
    get dead() { const c = this._us; return c ? c.dead[this._si] === 1 : this._goneRecord ? this._goneRecord.dead === true : this._si === -1 || this._deadv === true; }
    set dead(v) {
        const c = this._us;
        // (Outside a tick, an action's or a restore's: the prebuilt unit
        // index no longer holds.)
        if (typeof _inGameTick !== 'undefined' && !_inGameTick && typeof _sxPre !== 'undefined' && _sxPre) spatialIndexInvalidate();
        if (c) c.dead[mvtM(this._si)] = v ? 1 : 0;
        else if (this._det) this._det.dead = !!v;
        else Object.defineProperty(this, '_deadv', { value: !!v, writable: true, configurable: true });
    }
    // A worker's task: columns (sim_unit_state.js SIM_UNIT_WK_FIELDS: wkS,
    // wkT, wkR, wkN), hashed from them by the hash kernel. Before its slot
    // plain values (_wkv), detached its _det's. A change of its state or next
    // idle search wakes a parked worker (see simMoveTryPark).
    get workerState() { const c = this._us; if (c) return SIM_WS_NAMES[c.wkS[this._si] & 31]; return this._det ? this._det.workerState : this._wkv && this._wkv.workerState; }
    set workerState(v) {
        const c = this._us;
        if (c) {
            const s = this._si, w = c.wkS[s], code = simWsCode(v);
            // (A change only: the same state set again keeps a parked worker.)
            if ((w & 31) !== code) { c.mvOn[mvtM(s)] = 0; if (code !== SIM_WS_IDLE) c.wsKind[s] = 0; c.wkIdle[s] = code === SIM_WS_IDLE ? 1 : 0; c.wkS[s] = (w & ~31) | code; }
        } else _unitWkPre(this, 'workerState', v);
    }
    get _workerNextIdleRetargetTick() { const c = this._us; if (c) return _unitWkNum(c.wkN[this._si]); return this._det ? this._det._workerNextIdleRetargetTick : this._wkv && this._wkv._workerNextIdleRetargetTick; }
    set _workerNextIdleRetargetTick(v) {
        const c = this._us;
        if (c) { const s = this._si, n = _unitWkNumOf(v); if (c.wkN[s] !== n) { c.mvOn[mvtM(s)] = 0; c.wkN[s] = n; } }
        else _unitWkPre(this, '_workerNextIdleRetargetTick', v);
    }
    get workerTarget() { const c = this._us; if (c) { const s = this._si; return simWtDecode((c.wkS[s] >>> 10) & 7, c.wkT[s]); } return this._det ? this._det.workerTarget : this._wkv && this._wkv.workerTarget; }
    set workerTarget(v) {
        const c = this._us;
        if (c) {
            // (A snapshot carries the columns themselves: _wkTgt.)
            const s = this._si, [k, t] = simWtEncode(v); c.wkS[s] = (c.wkS[s] & ~(7 << 10)) | (k << 10); c.wkT[s] = t;
        }
        else _unitWkPre(this, 'workerTarget', v);
    }
    get _wkTgt() { const c = this._us; if (c) { const s = this._si; return c.wkT[s] * 8 + ((c.wkS[s] >>> 10) & 7); } return this._det ? this._det._wkTgt : undefined; }
    set _wkTgt(v) {
        const c = this._us;
        if (!c || !Number.isFinite(v)) return;
        const s = this._si, k = ((v % 8) + 8) % 8;
        c.wkS[s] = (c.wkS[s] & ~(7 << 10)) | (k << 10); c.wkT[s] = (v - k) / 8;
    }
    get workerTargetType() { const c = this._us; if (c) return _simWttNames[(c.wkS[this._si] >>> 5) & 31]; return this._det ? this._det.workerTargetType : this._wkv && this._wkv.workerTargetType; }
    set workerTargetType(v) {
        const c = this._us;
        if (c) { const s = this._si; c.wkS[s] = (c.wkS[s] & ~(31 << 5)) | (simWttCode(v) << 5); }
        else _unitWkPre(this, 'workerTargetType', v);
    }
    get _workerReservedTileIndex() { const c = this._us; if (c) return _unitWkNum(c.wkR[this._si]); return this._det ? this._det._workerReservedTileIndex : this._wkv && this._wkv._workerReservedTileIndex; }
    set _workerReservedTileIndex(v) { const c = this._us; if (c) c.wkR[this._si] = _unitWkNumOf(v); else _unitWkPre(this, '_workerReservedTileIndex', v); }
    get builderHasMaterial() { return _unitWkMat(this, 13, 'builderHasMaterial'); }
    set builderHasMaterial(v) { _unitWkMatSet(this, 13, 'builderHasMaterial', v); }
    get healerHasMaterial() { return _unitWkMat(this, 15, 'healerHasMaterial'); }
    set healerHasMaterial(v) { _unitWkMatSet(this, 15, 'healerHasMaterial', v); }
    get researcherHasMaterial() { return _unitWkMat(this, 17, 'researcherHasMaterial'); }
    set researcherHasMaterial(v) { _unitWkMatSet(this, 17, 'researcherHasMaterial', v); }
    // The path: a plain reference (non-enumerable _path, see
    // simUnitStateAllocate); a new one disarms the movement kernel.
    // A structure target (its value in _tb), mirrored into the acqB column:
    // the acquisition tier looks for units only for units that may use the
    // answer (idle, attack-moving, or attacking a structure).
    // Its order's targets and attack-move tile: columns (SIM_MOVE_COLUMNS tuS / tuId, fatF, amGx / amGy, tbT) the movement kernels
    // work on and write too (a target gone, an order done); these are views of them. (Before its slot, or detached: plain values.)
    get targetBuilding() {
        const c = this._us;
        if (c) { const t = c.tbT[this._si]; if (t < 0) return null; const gx = t % GRID_W; return getTileEntityRef(gx, (t - gx) / GRID_W) || null; }
        return this._det ? this._det.targetBuilding : this._tbv === undefined ? null : this._tbv;
    }
    set targetBuilding(v) {
        const c = this._us;
        if (c === undefined) { Object.defineProperty(this, '_tbv', { value: v, writable: true, configurable: true }); return; }
        if (c) { const s = this._si; c.tbT[s] = v && Number.isInteger(v.gx) && Number.isInteger(v.gy) ? v.gy * GRID_W + v.gx : -1; c.acqB[s] = v ? 1 : 0; if (v && typeof _snapDec !== 'undefined' && _snapDec !== null) _tbDecoded.push(this, v); }
        else if (this._det) this._det.targetBuilding = v;
    }
    // Its issued target position (mvTgX / mvTgY, NaN none: the movement kernels' arrival tolerance reads them) and its route key (rkF).
    get targetPos() {
        const c = this._us;
        if (c) { const x = c.mvTgX[this._si]; return x === x ? { x, y: c.mvTgY[this._si] } : null; }
        return this._det ? this._det.targetPos : this._tpv === undefined ? null : this._tpv;
    }
    set targetPos(v) {
        const c = this._us;
        if (c === undefined) { Object.defineProperty(this, '_tpv', { value: v, writable: true, configurable: true }); return; }
        if (c) { const s = this._si; if (v) { c.mvTgX[s] = Number(v.x); c.mvTgY[s] = Number(v.y); } else { c.mvTgX[s] = NaN; c.mvTgY[s] = NaN; } }
        else if (this._det) this._det.targetPos = v;
    }
    get _routeKey() {
        const c = this._us;
        if (c) return c.rkF[this._si] === 1 ? NAV_ROUTE_KEY : null;
        return this._det ? this._det._routeKey : this._rkv === undefined ? null : this._rkv;
    }
    set _routeKey(v) {
        const c = this._us;
        if (c === undefined) { Object.defineProperty(this, '_rkv', { value: v, writable: true, configurable: true }); return; }
        if (c) c.rkF[this._si] = v ? 1 : 0;
        else if (this._det) this._det._routeKey = v;
    }
    // Its target unit: its id (tuId) and the slot it held (tuS, a hint: slots are each peer's own). A target that is dead is none
    // (when its slot is freed is each peer's own, so it must not show), and one not in a slot yet (a restore sets a unit's target
    // before the target's slot is there) is found by its id.
    get targetUnit() {
        const c = this._us;
        if (c) {
            const s = this._si, id = c.tuId[s];
            if (id === 0) return null;
            const q = c.tuS[s];
            let o = q >= 0 ? _simUnitState.owners.at(q) : null;
            if (!(o && (o.id | 0) === id)) {
                o = getUnitById(id);
                if (!o) return null;
                if (o._us === c && o._si >= 0) c.tuS[s] = o._si;
            }
            return _unitTickDead(o) ? null : o;
        }
        return this._det ? this._det.targetUnit : this._tuv === undefined ? null : this._tuv;
    }
    set targetUnit(v) {
        const c = this._us;
        if (c === undefined) { Object.defineProperty(this, '_tuv', { value: v, writable: true, configurable: true }); return; }
        if (c) {
            const s = this._si;
            if (v) { const q = v._us === c && v._si >= 0 ? v._si : -1; c.tuS[s] = q; c.tuId[s] = v.id | 0; if (q < 0) _tuPending.push(this); if (typeof _snapDec !== 'undefined' && _snapDec !== null) _tuDecoded.push(this, v); }
            else { c.tuS[s] = -1; c.tuId[s] = 0; }
        }
        else if (this._det) this._det.targetUnit = v;
    }
    get forcedAttackTarget() {
        const c = this._us;
        if (c) return c.fatF[this._si] === 1;
        return this._det ? this._det.forcedAttackTarget : this._fatv === true;
    }
    set forcedAttackTarget(v) {
        const c = this._us;
        if (c === undefined) { Object.defineProperty(this, '_fatv', { value: !!v, writable: true, configurable: true }); return; }
        if (c) c.fatF[this._si] = v ? 1 : 0;
        else if (this._det) this._det.forcedAttackTarget = !!v;
    }
    get _attackMoveGx() {
        const c = this._us;
        if (c) { const v = c.amGx[this._si]; return v < 0 ? null : v; }
        return this._det ? this._det._attackMoveGx : this._amgx === undefined ? null : this._amgx;
    }
    set _attackMoveGx(v) {
        const c = this._us;
        if (c === undefined) { Object.defineProperty(this, '_amgx', { value: v, writable: true, configurable: true }); return; }
        if (c) c.amGx[this._si] = typeof v === 'number' && v >= 0 ? v : -1;
        else if (this._det) this._det._attackMoveGx = v;
    }
    get _attackMoveGy() {
        const c = this._us;
        if (c) { const v = c.amGy[this._si]; return v < 0 ? null : v; }
        return this._det ? this._det._attackMoveGy : this._amgy === undefined ? null : this._amgy;
    }
    set _attackMoveGy(v) {
        const c = this._us;
        if (c === undefined) { Object.defineProperty(this, '_amgy', { value: v, writable: true, configurable: true }); return; }
        if (c) c.amGy[this._si] = typeof v === 'number' && v >= 0 ? v : -1;
        else if (this._det) this._det._attackMoveGy = v;
    }
    // A fallback path with a target still pending (the separation's commit
    // retries it now and then: _tryUpgradeAstarFallbackPath): mirrored into
    // the mvPF column (1 while both are set), so the separation lists only
    // those units on their retry ticks, without reading every unit object.
    // (Both in the unit's columns, ptSt ...: sim_unit_state.js simPendingFlagSet,
    // simPendingTargetSet; the target read as a SimPendingTarget over them.)
    get pathIsFallbackAstar() { const c = this._us; if (c) { const t = (c.ptSt[this._si] >> 2) & 3; return t === 2 ? true : t === 1 ? false : undefined; } return this._det ? this._det.pathIsFallbackAstar : this._pfaO; }
    set pathIsFallbackAstar(v) {
        const c = this._us;
        if (c) { simPendingFlagSet(c, this._si, v); return; }
        if (this._det) this._det.pathIsFallbackAstar = v; else Object.defineProperty(this, '_pfaO', { value: v, writable: true, configurable: true });
    }
    get _pendingPathTarget() { const c = this._us; if (c) { const t = c.ptSt[this._si] & 3; return t === 2 ? new SimPendingTarget(this) : t === 1 ? null : undefined; } return this._det ? this._det._pendingPathTarget : this._pptO; }
    set _pendingPathTarget(v) {
        const c = this._us;
        if (c) { if (!(v instanceof SimPendingTarget && v.u === this)) simPendingTargetSet(c, this._si, v); return; }
        if (this._det) this._det._pendingPathTarget = v; else Object.defineProperty(this, '_pptO', { value: v, writable: true, configurable: true });
    }
    // (The target as a plain object: snapshots and patches.)
    get _pptSnap() { const v = this._pendingPathTarget; return v instanceof SimPendingTarget ? v.plain() : v; }
    set _pptSnap(v) { this._pendingPathTarget = v; }
    // The effective stat tables: its stat row's (unit.statRow >= 0, see
    // things_utils.js _effRowAttach), else its own (_pc, _pce: non-enumerable,
    // as the snapshot leaves derived tables out). Setting them drops the row.
    get preComputed() { const c = this._us; if (c) { const r = c.statRow[this._si]; if (r >= 0) return _unitStatView(this, c, this._si); } return this._pc; }
    set preComputed(v) {
        const oldColumns = this._us;
        if (oldColumns && oldColumns.statRow[this._si] >= 0) this._effRowKeep(_unitStatView(this, oldColumns, this._si));
        if (!('_pc' in this)) Object.defineProperty(this, '_pc', { value: v, writable: true, configurable: true }); else this._pc = v;
        const c = this._us;
        if (c) c.statRow[mvtM(this._si)] = -1;
    }
    get preComputedEffective() { const c = this._us; if (c) { const r = c.statRow[this._si]; if (r >= 0) return _unitStatView(this, c, this._si); } return this._pce; }
    set preComputedEffective(v) {
        const oldColumns = this._us;
        if (oldColumns && oldColumns.statRow[this._si] >= 0) this._effRowKeep(_unitStatView(this, oldColumns, this._si));
        if (!('_pce' in this)) Object.defineProperty(this, '_pce', { value: v, writable: true, configurable: true }); else this._pce = v;
        const c = this._us;
        if (c) c.statRow[mvtM(this._si)] = -1;
    }
    // (Its row's tables as its own: the row is going away.)
    _effRowKeep(t) {
        if (!('_pc' in this)) Object.defineProperty(this, '_pc', { value: t, writable: true, configurable: true }); else this._pc = t;
        if (!('_pce' in this)) Object.defineProperty(this, '_pce', { value: t, writable: true, configurable: true }); else this._pce = t;
    }
    // The team watching it (column wTeam, -1 none: the hits kernel sets it
    // with a scout's watch).
    get watchedByTeam() { const c = this._us; return c ? c.wTeam[this._si] : (this._det ? this._det.watchedByTeam : this._wbt); }
    set watchedByTeam(v) {
        const c = this._us;
        if (c) c.wTeam[this._si] = Number.isFinite(v) ? v : -1;
        else if (this._det) this._det.watchedByTeam = v;
        else Object.defineProperty(this, '_wbt', { value: v, writable: true, configurable: true });
    }
    // Its flow route's end (column rtEnd; with its profile, nvProf: the
    // field sweep's).
    get _routeEnd() { const c = this._us; return c ? c.rtEnd[this._si] : (this._det ? this._det._routeEnd : this._ree); }
    set _routeEnd(v) {
        const c = this._us;
        if (c) { const s = this._si; c.rtEnd[mvtM(s)] = typeof v === 'number' && v >= 0 ? v : -1; c.nvProf[s] = navProfileOf(this); }
        else if (this._det) this._det._routeEnd = v;
        else Object.defineProperty(this, '_ree', { value: v, writable: true, configurable: true });
    }
    // Its path: one navigation node, the columns' (nvPK: profile, destination, wide) when a kernel made or ended it;
    // else the array it was given.
    // (The path itself: the heap path store's, sim_unit_state.js SIM_PATH, by
    // its handle in pthH; read as a view of its block.)
    get path() {
        const c = this._us;
        if (!c) return this._det ? this._det.path : this._pathO;
        const s = this._si, p = simPathView(c.pthH[s]), k = c.nvPK[s], last = p && p.length ? p[p.length - 1] : null;
        const lk = last && last.nav ? ((last.nav - 1) * 16777216 + last.y * GRID_W + last.x) * 2 + (last.w ? 1 : 0) : -1;
        if (lk === k) return p;
        if (k < 0) return null;
        const key = k >> 1, prof = Math.floor(key / 16777216), dest = key - prof * 16777216, gx = dest % GRID_W, gy = (dest - gx) / GRID_W;
        const np = [(k & 1) ? { x: gx, y: gy, nav: prof + 1, w: 1, ready: 0 } : { x: gx, y: gy, nav: prof + 1, ready: 0 }];
        simPathRelease(c.pthH, s); c.pthH[s] = simPathStore(np);
        return simPathView(c.pthH[s]);
    }
    set path(v) {
        const c = this._us;
        if (!c) { if (this._det) this._det.path = v; else Object.defineProperty(this, '_pathO', { value: v, writable: true, configurable: true }); return; }
        const s = this._si;
        // (Its last flow node's field, for the field sweep.)
        const nd = v && v.length ? v[v.length - 1] : null;
        c.nvPK[s] = nd && nd.nav ? ((nd.nav - 1) * 16777216 + nd.y * GRID_W + nd.x) * 2 + (nd.w ? 1 : 0) : -1;
        simUnitPathRelease(c, s);
        const h = simPathStore(v);
        simPathRelease(c.pthH, s);
        c.pthH[s] = h;
        c.mvOn[mvtM(s)] = 0; c.mvSteer[mvtS(s * SIM_STEER_W)] = -1;
    }

    getCollisionLayer() {
        if (this.isFlying) return 'air';
        if (this.unitType === 'mole') return 'mole';
        return 'ground';
    }

    getCollisionRadius() {
        return Math.max(0.1, Number(this.collisionR) || Number(this.r) || 0.1);
    }

    // A hostile mine under the unit goes off (separate from update: its
    // closure's context would otherwise be allocated on every update).
    _explodeMine(cell, item, itemLevel) {
        let blastDamage = getBuildingStatForOwner(item.owner, 'mine', itemLevel, 'blastDamage');
        if (!Number.isFinite(blastDamage) || blastDamage <= 0) blastDamage = Number(item.damage) || 135;
        let blastRadiusArea = getBuildingStatForOwner(item.owner, 'mine', itemLevel, 'blastRadius');
        if (!Number.isFinite(blastRadiusArea) || blastRadiusArea <= 0) blastRadiusArea = 0.24;
        let blastRadiusPx = Math.max(0, Number(blastRadiusArea) * AREA_UNIT_TILE_EQUIVALENT * TILE);

        forEachUnitInRange(this.x, this.y, blastRadiusPx, (u) => {
            if (!u) return;
            let prevEnergy = u.energy;
            u.energy -= blastDamage;
            pushHostileDamageAlert(u, prevEnergy - u.energy, item.owner);
            recordDamageVisual(u, prevEnergy - u.energy, item.owner); shrineDamageTaken(u, prevEnergy - u.energy);
            if (u.energy <= 0 && !u.dead) u.dead = true;
        }, { enemyOfPlayer: item.owner, tickStart: true });

        createExplosion(this.x, this.y, "#f80", 15);
        playSound('mine_explode', this.x, this.y);
        clearTileEntity(cellItemGet(cell).gx, cellItemGet(cell).gy, cellItemGet(cell));
        if (this.energy <= 0) this.dead = true;
    }


    // Within arrival tolerance of the issued move target.
    _isNearIssuedTarget(spd) {
        let t = this.targetPos;
        if (!(t && Number.isFinite(t.x) && Number.isFinite(t.y))) return false;
        let tol = Math.max(8, Math.min(TILE, Math.floor((Number(spd) || 1) * 2)));
        return detHypot(Number(t.x) - Number(this.x), Number(t.y) - Number(this.y)) <= tol;
    }

    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
        if (this.dead || this.teleportHideTicks > 0) return;
        // Unit body
        let strokeColor = (this.owner >= 0) ? get2DRenderOwnerColor(this.owner) : '#000';
        let lw = 1;
        if (this.burning > 0) strokeColor = '#f50';
        else if (this.poisoned > 0) strokeColor = '#2d2';
        else if (this.frozen > 0 && this.wet > 0) strokeColor = '#fff';
        else if (this.frozen > 0) strokeColor = '#afe';
        else if (this.wet > 0) strokeColor = '#4af';
        if (this.burning > 0 || this.poisoned > 0 || this.frozen > 0 || this.wet > 0) lw = 1.5;

        drawCachedUnitBody(ctx, this, strokeColor, lw);

        // Owner dot removed in favor of colored outline

        // Energy bar
        if (this.energy < this.preComputed.maxEnergy) {
            let bw = this.r * 2 + 4, bh = 2, bx = this.x - bw / 2, by = this.y - this.r - 7;
            ctx.fillStyle = '#600'; ctx.fillRect(bx, by, bw, bh);
            ctx.fillStyle = '#0f0'; ctx.fillRect(bx, by, bw * Math.max(0, this.energy / this.preComputed.maxEnergy), bh);
        }
        // Attack visual effects
        if (this.attackTarget && this.attackFlash > 0 && (typeof renderer3dPanelRaster === 'undefined' || !renderer3dPanelRaster)) {
            let tx = this.attackTarget.x, ty = this.attackTarget.y;
            ctx.save();
            let style = this.attackStyle;
            if (style === 'laser') {
                // Laser beam from unit to target
                let grad = ctx.createLinearGradient(this.x, this.y, tx, ty);
                grad.addColorStop(0, '#f0f');
                grad.addColorStop(0.5, '#fff');
                grad.addColorStop(1, '#d0f');
                ctx.strokeStyle = grad;
                ctx.lineWidth = 2 + this.attackFlash * 0.4;
                ctx.shadowColor = '#f0f'; ctx.shadowBlur = 8 + this.attackFlash;
                ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(tx, ty); ctx.stroke();
                // Core beam
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(tx, ty); ctx.stroke();
                ctx.shadowBlur = 0;
            } else if (style === 'fire') {
                // Fire burst toward target
                let dx = tx - this.x, dy = ty - this.y, d = detHypot(dx, dy);
                let nx = dx / d, ny = dy / d;
                ctx.strokeStyle = '#f50'; ctx.lineWidth = 3;
                ctx.shadowColor = '#f80'; ctx.shadowBlur = 10;
                ctx.beginPath();
                ctx.moveTo(this.x + nx * this.r, this.y + ny * this.r);
                // Wavy flame path
                let steps = 4;
                for (let i = 1; i <= steps; i++) {
                    let t = i / steps;
                    let mx = this.x + dx * t, my = this.y + dy * t;
                    let perp = (Math.sin(i * 3 + gameTime * 0.5)) * 4;
                    ctx.lineTo(mx + ny * perp, my - nx * perp);
                }
                ctx.stroke();
                ctx.shadowBlur = 0;
            } else if (style === 'water') {
                // Water stream arc
                let mx = (this.x + tx) / 2, my = (this.y + ty) / 2 - 8;
                ctx.strokeStyle = '#4af'; ctx.lineWidth = 2.5;
                ctx.shadowColor = '#08f'; ctx.shadowBlur = 6;
                ctx.beginPath(); ctx.moveTo(this.x, this.y);
                ctx.quadraticCurveTo(mx, my, tx, ty); ctx.stroke();
                // Droplets along arc
                ctx.fillStyle = '#8cf';
                for (let i = 0; i < 3; i++) {
                    let t = (i + 1) / 4;
                    let px = this.x * (1 - t) * (1 - t) + 2 * mx * t * (1 - t) + tx * t * t;
                    let py = this.y * (1 - t) * (1 - t) + 2 * my * t * (1 - t) + ty * t * t;
                    ctx.beginPath(); ctx.arc(px, py, 1.5, 0, 6.28); ctx.fill();
                }
                ctx.shadowBlur = 0;
            } else if (style === 'ice') {
                // Ice shard line with sparkles
                ctx.strokeStyle = '#afe'; ctx.lineWidth = 2;
                ctx.shadowColor = '#fff'; ctx.shadowBlur = 8;
                ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(tx, ty); ctx.stroke();
                // Ice crystals along path
                ctx.fillStyle = '#fff';
                let dx = tx - this.x, dy = ty - this.y;
                for (let i = 1; i <= 3; i++) {
                    let t = i / 4;
                    let px = this.x + dx * t, py = this.y + dy * t;
                    ctx.save(); ctx.translate(px, py); ctx.rotate(gameTime * 0.2 + i);
                    ctx.fillRect(-2, -1, 4, 2); ctx.fillRect(-1, -2, 2, 4);
                    ctx.restore();
                }
                ctx.shadowBlur = 0;
            } else if (style === 'poison') {
                // Poison cloud trail
                let dx = tx - this.x, dy = ty - this.y;
                ctx.globalAlpha = 0.5 + this.attackFlash * 0.05;
                for (let i = 1; i <= 5; i++) {
                    let t = i / 6;
                    let px = this.x + dx * t, py = this.y + dy * t;
                    let sz = 3 + Math.sin(gameTime * 0.3 + i) * 1.5;
                    ctx.fillStyle = i % 2 === 0 ? '#2d2' : '#0a0';
                    ctx.beginPath(); ctx.arc(px, py, sz, 0, 6.28); ctx.fill();
                }
                ctx.globalAlpha = 1;
            } else if (style === 'swoop') {
                // Flying swoop - expanding ring around target on hit
                let swoopR = (8 - this.attackFlash) * 2 + 4;
                ctx.strokeStyle = '#dd0'; ctx.lineWidth = 2;
                ctx.globalAlpha = this.attackFlash / 8;
                ctx.beginPath(); ctx.arc(tx, ty, swoopR, 0, 6.28); ctx.stroke();
                ctx.globalAlpha = 1;
            } else if (style === 'ram') {
                // Snake ram - impact shockwave ring
                let shockR = (8 - this.attackFlash) * 3;
                ctx.strokeStyle = '#ff0'; ctx.lineWidth = 2;
                ctx.globalAlpha = this.attackFlash / 8;
                ctx.beginPath(); ctx.arc(tx, ty, shockR, 0, 6.28); ctx.stroke();
                // Impact lines radiating from target
                ctx.strokeStyle = '#f00'; ctx.lineWidth = 1.5;
                for (let i = 0; i < 6; i++) {
                    let a = i * Math.PI / 3 + gameTime * 0.1;
                    ctx.beginPath();
                    ctx.moveTo(tx + Math.cos(a) * 4, ty + Math.sin(a) * 4);
                    ctx.lineTo(tx + Math.cos(a) * (shockR + 4), ty + Math.sin(a) * (shockR + 4));
                    ctx.stroke();
                }
                ctx.globalAlpha = 1;
            } else if (this.attackFlash > 4) {
                // Default melee: quick slash line
                let dx = tx - this.x, dy = ty - this.y, d = detHypot(dx, dy) || 1;
                let nx = dx / d, ny = dy / d;
                let perpX = -ny * 5, perpY = nx * 5;
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
                ctx.globalAlpha = (this.attackFlash - 4) / 4;
                ctx.beginPath();
                ctx.moveTo(tx + perpX, ty + perpY);
                ctx.lineTo(tx - perpX, ty - perpY);
                ctx.stroke();
                ctx.globalAlpha = 1;
            }
            ctx.restore();
        }

        if (shouldShowUnitLevels(this)) {
            let txt = getUnitLevelLabelText(this);
            let sprite = _getUnitLevelTextSprite(txt);
            let dx = Math.round(this.x - sprite.width * 0.5);
            let dy = Math.round(this.y - this.r - 7 - sprite.height);
            queueDrawImage(ctx, sprite.canvas, dx, dy, sprite.width, sprite.height);
        }

        // Carrying value indicator for workers
        let statusY = this.y - this.r - 9;
        let energyBlocked = Number.isFinite(this._energyBlockedUntil) && gameTime < this._energyBlockedUntil;
        if (this.workerType === 'astar_collector') {
            drawUnitStatusGlyph(ctx, this.carryingValue > 0 ? '★' : '☆', this.carryingValue > 0 ? '#ddd' : '#888', this.x, statusY);
        } else if (this.carryingValue > 0) {
            drawUnitStatusGlyph(ctx, '⚡', '#fd0', this.x, statusY);
        } else if (this.workerType === 'builder' && this.workerState) {
            // Builder visual: hammer when building, ⚡ when fetching energy.
            if (this.workerState === 'RETURNING_FOR_GOLD') {
                drawUnitStatusGlyph(ctx, '⚡', energyBlocked ? '#f55' : '#fd0', this.x, statusY);
            } else if (this.workerState === 'MOVING_TO_BUILD' || this.workerState === 'BUILDING_IN_PLACE') {
                drawUnitStatusGlyph(ctx, '\uD83D\uDD28', '#fa0', this.x, statusY);
            }
        } else if (this.workerType === 'healer' && this.workerState) {
            if (this.workerState === 'RETURNING_FOR_GOLD') {
                drawUnitStatusGlyph(ctx, '⚡', energyBlocked ? '#f55' : '#fd0', this.x, statusY);
            } else if (this.workerState === 'MOVING_TO_HEAL' || this.workerState === 'HEALING') {
                drawUnitStatusGlyph(ctx, '+', '#fff', this.x, statusY);
            }
        } else if (this.workerType === 'researcher' && this.workerState) {
            if (this.workerState === 'RETURNING_FOR_GOLD' || !this.researcherHasMaterial) {
                drawUnitStatusGlyph(ctx, '⚡', energyBlocked ? '#f55' : '#fd0', this.x, statusY);
            } else if (this.workerState === 'MOVING_TO_RESEARCH' || this.workerState === 'RESEARCHING') {
                drawUnitStatusGlyph(ctx, 'R', '#7bf', this.x, statusY);
            }
        }
    }
}

// A unit's role memory: fields only some units ever set (workers of each
// kind, scouts, a sound or draw cache...), declared on every unit they were
// ~60 of its ~115 fields (~0.5 KB a unit with their slack: ~1 GB of the
// worker's heap at 2M units). Now prototype accessors over one object of
// them all (one shape), made at the first value set; undefined until then,
// as before. In the snapshot by name (simUnitStateKeys).
// (A worker's memory is its worker record's columns: SIM_WK_MEM, below.)
const UNIT_ROLE_FIELDS = ['_astarLastChargedTick', '_astarLastChargedFromKey', '_astarLastChargedToKey', '_astarBudgetBlockedUntil',
    '_nextScoutRetargetTick', '_levelTextLabel', '_ambientSoundTicks', '_r3d', '_r3dSig', '_r3dTex', '_visStill'];
// (Every field takes any kind of value from the start: see _makeUnitFieldsMutable.)
const _UnitRoleMem = new Function(UNIT_ROLE_FIELDS.map(k => 'this.' + k + ' = 1; this.' + k + ' = _UNIT_FIELD_WIDEN; this.' + k + ' = 0.5; this.' + k + ' = undefined;').join(' '));
for (const k of UNIT_ROLE_FIELDS) {
    const get = new Function('return function () { const m = this._rm; return m ? m.' + k + ' : undefined; };')();
    const set = new Function('M', 'return function (v) { let m = this._rm; if (!m) { if (v === undefined) return; m = new M();'
        + " if (this._rm === null) this._rm = m; else Object.defineProperty(this, '_rm', { value: m, writable: true, configurable: true }); } m." + k + ' = v; };')(_UnitRoleMem);
    Object.defineProperty(Unit.prototype, k, { get, set, configurable: true, enumerable: false });
}
// The route and worker fields order kernels write: heap columns
// (sim_unit_state.js SIM_UNIT_KCOL_FIELDS), detached its _det's.
for (const [k, col] of (typeof SIM_UNIT_KCOL_FIELDS !== 'undefined' ? SIM_UNIT_KCOL_FIELDS : [])) {
    const get = new Function('return function () { const c = this._us; if (c) return c.' + col + '[this._si]; return this._det ? this._det.' + k + ' : this._kc' + col + '; };')();
    const set = new Function('return function (v) { const c = this._us; if (c) c.' + col + '[this._si] = v; else if (this._det) this._det.' + k + ' = v; else Object.defineProperty(this, "_kc' + col + '", { value: v, writable: true, configurable: true }); };')();
    Object.defineProperty(Unit.prototype, k, { get, set, configurable: true, enumerable: false });
}
// Its other fields: columns of the unit table (sim_unit_state.js
// SIM_UNIT_JS_FIELDS; the radii the kernels' r and collisionR), a detached
// unit's in its _det. (Made per field with its name in the code, as the
// status accessors.)
for (const [k, kind] of (typeof SIM_UNIT_JS_FIELDS !== 'undefined' ? SIM_UNIT_JS_FIELDS : [])) {
    const nm = _simJsName(k, kind), at = 'c.' + nm + '[this._si]';
    const read = kind === 'b' ? at + ' === 1' : kind === 'u' ? '(x = ' + at + ') === x ? x : undefined' : kind === 'r'||SIM_UNIT_SPARSE_JS_FIELDS.has(k) ? 'c.' + nm + '.get(this._si)' : at;
    const write = kind === 'b' ? at + ' = v ? 1 : 0' : kind === 'u' ? at + ' = v === undefined ? NaN : v' : kind === 'r'||SIM_UNIT_SPARSE_JS_FIELDS.has(k) ? 'c.' + nm + '.set(this._si,v)' : at + ' = v';
    const get = new Function('return function () { const c = this._us; let x; if (c) return ' + read + '; return this._det ? this._det.' + k + ' : undefined; };')();
    const set = new Function('k', 'return function (v) { const c = this._us; if (c) ' + write + '; else if (this._det) this._det.' + k + ' = v; else Object.defineProperty(this, k, { value: v, writable: true, enumerable: true, configurable: true }); };')(k);
    Object.defineProperty(Unit.prototype, k, { get, set, configurable: true, enumerable: false });
}
// Its type: the type index (unit.upT, sim_unit_state.js simUnitTypeIndex) read
// as its name; no column of its own (it was a second copy of the type, as a
// string reference a unit). Setting it moves its upkeep bin too.
Object.defineProperty(Unit.prototype, 'unitType', { configurable: true, enumerable: false,
    get() { const c = this._us; if (c) { const t = c.upT[this._si]; return t >= 0 ? _simUnitTypeNames[t] : undefined; } return this._det ? this._det.unitType : undefined; },
    set(v) {
        const c = this._us;
        if (c) { const t = v === undefined || v === null ? -1 : simUnitTypeIndex(v); if (c.upT[this._si] !== t) { c.upT[this._si] = t; if (typeof upkeepUnitRefresh === 'function') upkeepUnitRefresh(this); } }
        else if (this._det) this._det.unitType = v;
        else Object.defineProperty(this, 'unitType', { value: v, writable: true, enumerable: true, configurable: true });
    } });
// Its base stat tables: its base row's (unit.bsRow >= 0, which the
// effective-level kernel gives a unit catching up with its stat tables, see
// things_utils.js _effBRowObj), else its own fields. Setting either one makes
// both its own (the row's object kept in the other).
for (const k of ['preComputedBase', 'basePreComputed']) {
    const own = 'jr_' + k, other = 'jr_' + (k === 'preComputedBase' ? 'basePreComputed' : 'preComputedBase');
    const get = new Function('return function () { const c = this._us; if (c) { const r = c.bsRow[this._si]; return r >= 0 ? _unitBaseView(this, c, this._si) : c.' + own + '.get(this._si); } return this._det ? this._det.' + k + ' : undefined; };')();
    const set = new Function('k', 'return function (v) { const c = this._us; if (c) { const s = this._si, r = c.bsRow[s]; if (r >= 0) { c.' + other + '.set(s, _unitBaseView(this, c, s)); c.bsRow[s] = -1; } c.' + own + '.set(s, v); } else if (this._det) this._det.' + k + ' = v; else Object.defineProperty(this, k, { value: v, writable: true, enumerable: true, configurable: true }); };')(k);
    Object.defineProperty(Unit.prototype, k, { get, set, configurable: true, enumerable: false });
}
// The movement columns that are state (SIM_UNIT_MOVE_SNAPSHOT_KEYS: the step
// carries), for snapshots.
for (const k of (typeof SIM_UNIT_MOVE_SNAPSHOT_KEYS !== 'undefined' ? SIM_UNIT_MOVE_SNAPSHOT_KEYS : [])) {
    const get = new Function('return function () { const c = this._us; if (c) return c.' + k + '[this._si]; return this._det ? (this._det.' + k + ' || 0) : 0; };')();
    const set = new Function('k', 'return function (v) { const c = this._us; if (c) c.' + k + '[this._si] = v; else if (this._det) this._det.' + k + ' = v; else Object.defineProperty(this, k, { value: v, writable: true, enumerable: true, configurable: true }); };')(k);
    Object.defineProperty(Unit.prototype, k, { get, set, configurable: true, enumerable: false });
}
for (const k of ['r', 'collisionR']) {
    const get = new Function('return function () { const c = this._us; if (c) return c.' + k + '[this._si]; return this._det ? this._det.' + k + ' : undefined; };')();
    const set = new Function('k', 'return function (v) { const c = this._us; if (c) c.' + k + '[this._si] = v; else if (this._det) this._det.' + k + ' = v; else Object.defineProperty(this, k, { value: v, writable: true, enumerable: true, configurable: true }); };')(k);
    Object.defineProperty(Unit.prototype, k, { get, set, configurable: true, enumerable: false });
}
// Its type's constants (BASE_UNIT_STATS), not a field each: a value set
// that differs (an old snapshot's) stays the unit's own.
const UNIT_TYPE_FIELDS = { vis: s => s.vis || 'circle', color: s => s.color || '#fff', turretImmune: s => s.turretImmune || false, isSnake: s => s.isSnake || false,
    poisonResistant: s => s.poisonResistant || false, fireResistant: s => s.fireResistant || false, waterResistant: s => s.waterResistant || false,
    iceResistant: s => s.iceResistant || false, laserResistant: s => s.laserResistant || false, sandResistant: s => s.sandResistant || false,
    attackStyle: s => s.attackStyle || 'melee' };
// (The kernels read them by type, tower.js / projectile.js flags tables: an
// instance's own value (tests) is the object's only.)
for (const [k, of] of Object.entries(UNIT_TYPE_FIELDS)) {
    Object.defineProperty(Unit.prototype, k, { configurable: true, enumerable: false,
        get() { return of(BASE_UNIT_STATS[this.unitType] || BASE_UNIT_STATS.norm); },
        set(v) { if (v !== of(BASE_UNIT_STATS[this.unitType] || BASE_UNIT_STATS.norm)) { Object.defineProperty(this, k, { value: v, writable: true, enumerable: true, configurable: true }); } } });
}
Object.defineProperty(Unit.prototype, 'isKing', { configurable: true, enumerable: false,
    get() { return this.unitType === 'king'; },
    set(v) { if (v !== (this.unitType === 'king')) Object.defineProperty(this, 'isKing', { value: v, writable: true, enumerable: true, configurable: true }); } });

// The tick's attacks (see Unit._performAttackOnUnit): attacker, target,
// whether the target is a building, the damage and where the attacker
// stood, in the order they were made.
const _hitQ = { n: 0, a: [], t: [], b: new Uint8Array(1024), dmg: new Float64Array(1024), x: new Float64Array(1024), y: new Float64Array(1024) };
function _unitHitQueue(attacker, target, building) {
    const Q = _hitQ, i = Q.n++;
    if (i >= Q.b.length) {
        const grow = (A, T) => { const r = new T(A.length * 2); r.set(A); return r; };
        Q.b = grow(Q.b, Uint8Array); Q.dmg = grow(Q.dmg, Float64Array); Q.x = grow(Q.x, Float64Array); Q.y = grow(Q.y, Float64Array);
    }
    Q.a[i] = attacker; Q.t[i] = target; Q.b[i] = building;
    Q.dmg[i] = _attackShots > 1 ? attacker.preComputed.attackDamage * _attackShots : attacker.preComputed.attackDamage; Q.x[i] = attacker.x; Q.y[i] = attacker.y;
    _attackShots = 1;
}
// The shots of the attack being made (Unit._attackerSide), for its hit.
let _attackShots = 1;
function _isHitBuildingStanding(tb) {
    if (!(tb.energy > 0)) return false;
    if (getTileEntityRef(tb.gx, tb.gy) === tb) return true;
    const row = grid[tb.gy], cell = row && row[tb.gx];
    return !!cell && cellItemGet(cell) === tb;
}
// The tick's hits. On units, on the helpers and in no order: SIM_KERNEL_HITS
// takes the queued attacks (_hitQ, as entries) and the movement kernel's
// per-chunk attack lists in place (_simMoveHitA...), each hit into its
// target's sums (damage in 1/16ths: integers, the same sum in any order;
// statuses and their tick damage by max; a scout's watch, the longest);
// SIM_KERNEL_HITS_APPLY then takes the sums off the units hit (energy,
// statuses, watch, fallen). Here: hits on structures and on units without
// columns (in queue order), the newly watched units' vision cover, and the
// looks of up to SIM_HITS_PRESENT hits a tick (whichever the helpers listed:
// within the page's view first, simLookView, a step of many ticks that many
// times as many, up to SIM_HITS_PRESENT_MAX; SIM_HITS_OUT of the rest). (The
// combat brain engages: no retaliation, see tryAutoRetaliateOnHostileDamage.)
const _hitK = { cap: 0, q: null, dmg: null, sty: null, wk: null, tcap: 0, tlist: null, wlist: null, plist: null, cnt: null, shr: null };
const SIM_HITS_PRESENT = 512, SIM_HITS_PRESENT_MAX = 4096, SIM_HITS_OUT = 128, SIM_HITS_PER_JOB = 2048, SIM_HITS_CHUNKS_JOB = 16;
// The page's view (unit.x, unit.y: eighths of a pixel; x0 > x1: none), its
// looks first (sim_worker.js: the page sends it as its camera moves).
let simLookView = [1, 0, 0, 0];
function _hitStyleCode(a) {
    const st = a.attackStyle;
    return st === 'fire' ? 1 : st === 'water' ? 2 : st === 'ice' ? 3 : st === 'poison' ? 4 : (st === 'swoop' && a.unitType === 'scout') ? 5 : 0;
}
// A scout's watch from its swoop: ticks (its stats' watchDuration), else 0.
function _unitWatchTicks(u) {
    const pc = u.preComputed;
    return _hitStyleCode(u) === 5 && pc ? secondsToTicks(Number(pc.watchDuration) || 0) : 0;
}
// A scout's watch as the kernels' key: the longest, then the highest id, the
// team (wasm/src/k.rs k_hits).
function _hitWatchKey(a) {
    const w = _unitWatchTicks(a);
    return w > 0 ? (Math.min(w, 2047) << 20) | ((a.id & 0xFFFF) << 4) | ((a.owner + 1) & 15) : 0;
}
function _hitArrays(n, total) {
    const K = _hitK;
    if (!K.q || K.cap < n) {
        const cap = simReserveCap(Math.max(1, n), 4096);
        K.q = simSharedArray(Int32Array, cap); K.dmg = simSharedArray(Float32Array, cap); K.sty = simSharedArray(Uint8Array, cap); K.wk = simSharedArray(Int32Array, cap);
        K.cap = cap;
        simParallelBind('hit.q', K.q); simParallelBind('hit.dmg', K.dmg); simParallelBind('hit.sty', K.sty); simParallelBind('hit.wk', K.wk);
    }
    if (K.tcap < total) {
        const cap = simReserveCap(total, 8192);
        K.tlist = simSharedArray(Int32Array, cap); K.wlist = simSharedArray(Int32Array, cap);
        K.tcap = cap;
        simParallelBind('hit.tlist', K.tlist); simParallelBind('hit.wlist', K.wlist);
    }
    if (!K.cnt) {
        K.cnt = simSharedArray(Int32Array, 8); K.plist = simSharedArray(Int32Array, SIM_HITS_PRESENT_MAX + SIM_HITS_OUT);
        simParallelBind('hit.cnt', K.cnt); simParallelBind('hit.plist', K.plist);
    }
    const NO = Math.max(16, players.length);
    if (!K.shr || K.shr.length < 64 * NO) { K.shr = simSharedArray(Float64Array, 64 * NO * 2); simParallelBind('hit.shr', K.shr); }
    return K;
}
// The movement kernel's attacks on structures (listed with a target of
// -(tile + 2), mv.rs move_struct; k_hits passes them over), applied here: in
// the order of their attackers' ids (a slot is a place on this peer, an id is
// the same everywhere), the first looks with their sounds.
const SIM_STRUCT_HIT_LOOKS = 256;
// By the kernel (ord.rs k_struct_hits; the shots' k_proj_struct_hits, the
// same hit): statuses, damage, shrine income, energy; then the first hits'
// looks, the watches' vision cover and the structures destroyed (in hit
// order) here.
let _shK = null;
const _shP = new Float64Array(12);
// (Per structure type id: the statuses it is immune to, bits ord.rs FX_*: 1
// fire 2 water 4 ice 8 poison 16 sand 32 watch: isEffectImmune of its type,
// made as types appear.)
function _structImmuneTable() {
    const n = _stationaryTypes.length + 1;
    if (_shK.imm && _shK.immN === n && simHeapHas(_shK.imm)) return _shK.imm;
    const M = simSharedArray(Uint8Array, Math.max(64, n * 2));
    for (let i = 0; i < _stationaryTypes.length; i++) {
        const raw = _stationaryTypes[i], type = raw.startsWith('barrack_') ? 'barrack' : raw, base = (typeof BASE_CARD_TYPES !== 'undefined' && BASE_CARD_TYPES[type]) || {};
        const probe = { type, fireResistant: !!base.fireResistant, poisonResistant: !!base.poisonResistant, waterResistant: !!base.waterResistant, iceResistant: !!base.iceResistant, sandResistant: !!base.sandResistant };
        M[i + 1] = (isEffectImmune(probe, 'fire') ? 1 : 0) | (isEffectImmune(probe, 'water') ? 2 : 0) | (isEffectImmune(probe, 'ice') ? 4 : 0) | (isEffectImmune(probe, 'poison') ? 8 : 0)
            | (isEffectImmune(probe, 'sand') ? 16 : 0) | (isEffectImmune(probe, 'watch') ? 32 : 0);
    }
    simHeapFreeAuto(_shK.imm);
    _shK.imm = M; _shK.immN = n;
    return M;
}
// A structure hit kernel over the structure tables: head its first 14
// arrays ('keys': its sort scratch), P its params (the common ones set here), room for `cap` hits.
// The kernel's lists in the returned record (null: no structure tables).
const _structHitClassCols = ['c__en', 'c__stT', 'c_burning', 'c_burnTickDamage', 'c_poisoned', 'c_poisonTickDamage',
    'c_frozen', 'c_iceTickDamage', 'c_wet', 'c_watched', 'c_watchedByTeam', 'c_sandy'];
const _structHitArgs = new Array(144).fill(null);
const _structHitTailArgs = [];
function _structHitsRun(fn, head, P, cap, tail = null) {
    const ST = _ST;
    if (!ST.stab) return null;
    if (!simHeapHas(ST.code)) structTablesRehome();
    const NO = Math.max(16, players.length);
    if (!_shK || _shK.cap < cap || !simHeapHas(_shK.cnt) || _shK.shrine.length < NO) {
        const c = simReserveCap(Math.max(cap, _shK ? _shK.cap : 0, 4096), 4096);
        if (_shK) for (const key of ['keys', 'dead', 'watch', 'looks', 'shrine', 'cnt', 'imm']) simHeapFreeAuto(_shK[key]);
        _shK = { cap: c, keys: simSharedArray(Float64Array, c), dead: simSharedArray(Int32Array, c), watch: simSharedArray(Int32Array, c), looks: simSharedArray(Int32Array, 3 * SIM_STRUCT_HIT_LOOKS),
            shrine: simSharedArray(Float64Array, NO), cnt: simSharedArray(Int32Array, 4), imm: null, immN: 0 };
    }
    const K = _shK, imm = _structImmuneTable();
    K.shrine.fill(0);
    const args = tail ? _structHitTailArgs : _structHitArgs;
    for (let j = 0; j < 14; j++) args[j] = j >= head.length ? null : head[j] === 'keys' ? K.keys : head[j];
    args[14] = ST.stab; args[15] = ST.rrow; args[16] = ST.val;
    args[17] = ST.brain; args[18] = imm; args[19] = K.cnt;
    const cls = STRUCT_STATUS_CLASSES();
    let arg = 20;
    for (let j = 0; j < 9; j++) {
        const T = cls[j] ? _sTables.get(cls[j]) : null;
        if (T && !_sColsInHeap(T)) _sTableGrow(T, T.cap);
        for (let i = 0; i < _structHitClassCols.length; i++) args[arg++] = T ? T[_structHitClassCols[i]] : null;
        args[128 + j] = T ? T.c__ow : null;
    }
    args[137] = args[138] = args[139] = null;
    args[140] = K.dead; args[141] = K.looks; args[142] = K.watch; args[143] = K.shrine;
    if (tail) {
        for (let j = 0; j < tail.length; j++) args[144 + j] = tail[j];
        args.length = 144 + tail.length;
    }
    P[2] = SIM_STRUCT_HIT_LOOKS; P[3] = NO; P[5] = TICK_RATE; P[6] = MAX_THING_LEVEL; P[7] = ST.n; P[8] = imm.length; P[9] = RESOURCE_FIXED_POINT_SCALE;
    try { simRustDirect(fn, args, P); } finally { args.fill(null); }
    for (let o = 0; o < NO; o++) if (K.shrine[o] > 0) { if (o >= _shrinePendingFixed.length) { const a = new Float64Array(o + 8); a.set(_shrinePendingFixed); _shrinePendingFixed = a; } _shrinePendingFixed[o] += K.shrine[o]; }
    return K;
}
// After a structure hit kernel: the looks (look(slot, structure, damage):
// presentation only), the watches' vision cover, the destroyed in hit order.
function _structHitsAfter(K, look) {
    const at = t => { const gx = t % GRID_W; return getTileEntityRef(gx, (t - gx) / GRID_W); };
    for (let i = 0, n = K.cnt[1]; i < n; i++) { const tb = at(K.looks[3 * i + 1]); if (tb) look(K.looks[3 * i], tb, K.looks[3 * i + 2] / 1024); }
    if (typeof visCoverOnEntityChanged === 'function') for (let i = 0, n = K.cnt[2]; i < n; i++) { const tb = at(K.watch[i]); if (tb) visCoverOnEntityChanged(tb); }
    structDestroyTiles(K.dead, K.cnt[0], true);
}
function _structHitsApply(KC, HC, HA, HT, CH) {
    const S = _simUnitState, C = S.columns, owners = S.owners;
    if (!_effHot || !simHeapHas(_effHot)) return;
    const P = _shP;
    P[0] = KC; P[1] = CH; P[4] = EFF_HOT_WIDTH;
    const K = _structHitsRun('k_struct_hits', [HC, HA, HT, 'keys', C.id, C.owner, C.atkN, C.atkSty, _effHot, C.statRow, C.unitLevel, C.baseLevel, C.effectiveLevel, C.atkWatch], P, KC * CH);
    if (!K) return;
    _structHitsAfter(K, (s, tb, dmg) => {
        const a = owners.at(s);
        if (!a) return;
        recordUnitAttackFx(a, tb); playSound(C.atkSty[s] >= 1 && C.atkSty[s] <= 4 || a.attackStyle === 'laser' ? 'attack_cast' : 'attack_swing', a.x, a.y, a.unitType);
        pushHostileDamageAlert(tb, dmg, a.owner); recordDamageVisual(tb, dmg, a.owner);
        if (dmg > 0) playSound('melee_hit', tb.x, tb.y, a.unitType);
    });
}
// The hits' status sub-records (unit.hSx: status bits, fire / poison tick
// damage, a watch key, five timers), room for ns: zeros between ticks, the
// apply kernel clears what it read.
function _hitStArrays(ns) {
    const K = _hitK;
    if (!K.rsty || K.scap < ns) {
        const cap = simReserveCap(Math.max(1, ns), 4096);
        for (const key of ['rsty', 'rbd', 'rpd', 'rwk', 'rdu']) simHeapFreeAuto(K[key]);
        K.rsty = simSharedArray(Uint8Array, cap); K.rbd = simSharedArray(Int32Array, cap); K.rpd = simSharedArray(Int32Array, cap); K.rwk = simSharedArray(Int32Array, cap);
        K.rdu = simSharedArray(Int32Array, cap * 5);
        K.scap = cap;
        simParallelBind('hit.rsty', K.rsty); simParallelBind('hit.rbd', K.rbd); simParallelBind('hit.rpd', K.rpd); simParallelBind('hit.rwk', K.rwk); simParallelBind('hit.rdu', K.rdu);
    }
    return K.scap;
}
function unitHitsResolve() {
    const Q = _hitQ, n = Q.n, S = _simUnitState;
    const KC = _simMoveHitChunks, HC = _simMoveHitC, HA = _simMoveHitA, HT = _simMoveHitT, CH = SIM_MOVE_CHUNK;
    _simMoveHitChunks = 0;
    if (KC > 0 && S && HT) _structHitsApply(KC, HC, HA, HT, CH);
    let nk = 0;
    for (let k = 0; k < KC; k++) nk += HC[k];
    // (The step's shots that hit a unit, projectile.js: their slots in
    // pj.uev; room for the units their blasts reach.)
    const PJ = _pj, npj = PJ.cap && S ? PJ.unitHits : 0;
    PJ.unitHits = 0;
    const room = npj > 0 ? projBlastRoom(npj) : null;
    const total = n + nk + npj + (room ? room[0] : 0);
    if (total === 0) return;
    if (!S || typeof SIM_KERNEL_HITS !== 'number') {
        for (let i = 0; i < n; i++) {
            const a = Q.a[i], t = Q.t[i];
            Q.a[i] = null; Q.t[i] = null;
            if (Q.b[i] === 0) _unitHitUnit(a, t, Q.dmg[i], Q.x[i], Q.y[i]);
            else _unitHitBuilding(a, t, Q.dmg[i]);
        }
        Q.n = 0;
        return;
    }
    const C = S.columns, owners = S.owners, K = _hitArrays(n, total);
    const HQ = K.q, HD = K.dmg, HS = K.sty, HW = K.wk, CNT = K.cnt;
    // (Structures and units without columns: here, below.)
    let nl = 0, ns = 0;
    for (let i = 0; i < n; i++) {
        const t = Q.t[i];
        if (Q.b[i] !== 0 || t._us !== C || !(t._si >= 0)) { HQ[i] = -1; nl++; continue; }
        const a = Q.a[i], sty = _hitStyleCode(a);
        HQ[i] = t._si; HD[i] = Q.dmg[i]; HS[i] = sty; HW[i] = sty === 5 ? _hitWatchKey(a) : 0;
        if (sty >= 1 && sty <= 5) ns++;
    }
    if (nl < total) {
        CNT[0] = 0; CNT[1] = 0; CNT[2] = 0; CNT[3] = 0; CNT[4] = 0; CNT[5] = 0;
        // (Status sub-records for every hit with a status style: the JS
        // entries' and the movement kernel's counts, mv.hitsc.)
        const HSC = _simMoveHitSC;
        if (HSC) for (let k = 0; k < KC; k++) ns += HSC[k];
        if (npj) ns += PJ.hdr[7] + room[1];
        const scap = _hitStArrays(ns);
        const P = _simParams;
        const per = Math.max(SIM_HITS_PER_JOB, Math.ceil(n / 16)), jj = n ? Math.ceil(n / per) : 0;
        const cj = Math.max(SIM_HITS_CHUNKS_JOB, Math.ceil(KC / 48)), kj = nk ? Math.ceil(KC / cj) : 0;
        const looks = Math.min(SIM_HITS_PRESENT_MAX, SIM_HITS_PRESENT * Math.max(1, simDk | 0)), V = simLookView;
        P[0] = n; P[1] = per; P[2] = looks; P[3] = jj; P[4] = cj; P[5] = nk ? KC : 0; P[6] = CH; P[7] = 0;
        P[8] = V[0]; P[9] = V[1]; P[10] = V[2]; P[11] = V[3]; P[12] = V[0] <= V[2] ? SIM_HITS_OUT : 0; P[13] = scap;
        const ppj = Math.max(SIM_HITS_PER_JOB / 4, Math.ceil(npj / 32)), pjj = npj ? Math.ceil(npj / ppj) : 0;
        P[14] = npj; P[15] = ppj; P[16] = pjj;
        if (npj) {
            P[17] = GRID_W; P[18] = GRID_H; P[19] = TILE; P[20] = _sxEpoch; P[21] = (projUnitFlagsTable(), _pj.tflN); P[22] = _projUnitFlags(BASE_UNIT_STATS.norm); P[23] = TICK_RATE;
        }
        simParallelRun(SIM_KERNEL_HITS, jj + pjj + kj);
        if (CNT[5] > 0) console.warn('hits: ' + CNT[5] + ' status sub-records past the count of hits with a status style');
        const nt = CNT[0];
        if (nt > 0) {
            const NO = Math.max(16, players.length), pa = Math.max(SIM_HITS_PER_JOB, Math.ceil(nt / 48)), ja = Math.min(64, Math.ceil(nt / pa));
            P[0] = nt; P[1] = pa; P[2] = NO; P[3] = RESOURCE_FIXED_POINT_SCALE;
            // (A status record for each unit with a status sub-record at most: taken on the helpers.)
            if (typeof simUnitStReserve === 'function') simUnitStReserve(Math.min(CNT[4], scap));
            simParallelRun(SIM_KERNEL_HITS_APPLY, ja);
            if (typeof simUnitStSettle === 'function') simUnitStSettle();
            // (The shrines' share: integers, any order.)
            const SHR = K.shr;
            for (let j = 0; j < ja; j++) for (let o = 0; o < NO; o++) {
                const v = SHR[j * NO + o];
                if (!v) continue;
                if (o >= _shrinePendingFixed.length) { const a = new Float64Array(o + 8); a.set(_shrinePendingFixed); _shrinePendingFixed = a; }
                _shrinePendingFixed[o] += v;
            }
            // (Newly watched: their vision cover; each its own.)
            const WL = K.wlist, nw = CNT[2];
            if (nw > 0 && typeof visCoverOnEntityChanged === 'function') for (let i = 0; i < nw; i++) { const u = owners.at(WL[i]); if (u) visCoverOnEntityChanged(u); }
        }
        // The looks (presentation only: which hits differs between peers).
        const PL = K.plist, np = Math.min(CNT[1], looks), no = V[0] <= V[2] ? Math.min(CNT[3], SIM_HITS_OUT) : 0;
        for (let p = 0; p < np + no; p++) {
            const e = PL[p < np ? p : looks + p - np];
            let a, t, ax, ay, dmg, sty;
            if (e < n) { a = Q.a[e]; t = Q.t[e]; ax = Q.x[e]; ay = Q.y[e]; dmg = Q.dmg[e]; sty = HS[e]; }
            else if (e < n + npj) {
                // (A shot's: its impact's look is the projectile phase's.)
                const sl = PJ.uev[e - n], tu = owners.at(PJ.a.arg[sl]), own = PJ.a.own[sl];
                if (tu) { pushHostileDamageAlert(tu, PJ.a.dmg[sl], own); recordDamageVisual(tu, PJ.a.dmg[sl], own); }
                continue;
            }
            else { const j = e - n - npj, s = HA[j]; a = owners.at(s); t = owners.at(HT[j]); ax = C.x[s] * 0.125; ay = C.y[s] * 0.125; dmg = simUnitStatValue(C,s,5); sty = C.atkSty[s]; }
            if (!a || !t) continue;
            // (A kernel attack's own look and sound, as _attackerSide's.)
            let tx, ty;
            if (e >= n || dmg > 0) {
                const tc = t._us, ts = t._si;
                tx = tc === C ? C.x[ts] * 0.125 : t.x;
                ty = tc === C ? C.y[ts] * 0.125 : t.y;
            }
            if (e >= n) { recordUnitAttackFx(a, t, true, ax, ay, tx, ty); playSound(sty >= 1 && sty <= 4 || a.attackStyle === 'laser' ? 'attack_cast' : 'attack_swing', ax, ay, a.unitType); }
            pushHostileDamageAlert(t, dmg, a.owner);
            recordDamageVisual(t, dmg, a.owner);
            if (dmg > 0) playSound('melee_hit', tx, ty, a.unitType);
        }
    }
    if (nl) for (let i = 0; i < n; i++) {
        if (HQ[i] >= 0) continue;
        const a = Q.a[i], t = Q.t[i];
        if (Q.b[i] === 0) _unitHitUnit(a, t, Q.dmg[i], Q.x[i], Q.y[i]);
        else _unitHitBuilding(a, t, Q.dmg[i]);
    }
    for (let i = 0; i < n; i++) { Q.a[i] = null; Q.t[i] = null; }
    Q.n = 0;
}
// Dropped (a restore replaces the world between ticks).
function unitHitsReset() { const Q = _hitQ; for (let i = 0; i < Q.n; i++) { Q.a[i] = null; Q.t[i] = null; } Q.n = 0; }
function _unitHitUnit(a, target, dmg, ax, ay) {
    if (target.dead) return;
    let before = target.energy;
    target.energy -= dmg;
    pushHostileDamageAlert(target, before - target.energy, a.owner);
    recordDamageVisual(target, before - target.energy, a.owner); shrineDamageTaken(target, before - target.energy);
    if (before > target.energy) playSound('melee_hit', target.x, target.y, a.unitType);
    let style = a.attackStyle;
    if (style === 'fire') {
        target.burning = Math.max(target.burning, 45);
        target.burnTickDamage = Math.max(target.burnTickDamage, dmg * 0.04);
    } else if (style === 'water') {
        target.wet = Math.max(target.wet, 60);
    } else if (style === 'ice') {
        target.frozen = Math.max(target.frozen, 40);
    } else if (style === 'poison') {
        target.poisoned = Math.max(target.poisoned, 50);
        target.poisonTickDamage = Math.max(target.poisonTickDamage, dmg * 0.04);
    } else if (style === 'swoop') {
        if (a.unitType === 'scout') applyStatusEffect(target, 'watch', getUnitEffectiveLevel(a), 0, a.owner, a.unitType);
    }
    if (target.energy <= 0) target.dead = true;
}
function _unitHitBuilding(a, tb, dmg) {
    if (!_isHitBuildingStanding(tb)) return;
    let before = tb.energy, style = a.attackStyle;
    if (style === 'fire') {
        applyStatusEffect(tb, 'fire', getUnitBaseLevel(a), dmg * 0.04);
        if (!isEffectImmune(tb, 'fire')) tb.energy -= dmg;
    } else if (style === 'water') {
        applyStatusEffect(tb, 'water', getUnitBaseLevel(a));
        if (!isEffectImmune(tb, 'water')) tb.energy -= dmg;
    } else if (style === 'ice') {
        applyStatusEffect(tb, 'ice', getUnitBaseLevel(a), dmg * 0.2);
        if (!isEffectImmune(tb, 'ice')) tb.energy -= dmg;
    } else if (style === 'poison') {
        applyStatusEffect(tb, 'poison', getUnitBaseLevel(a), dmg * 0.04);
        if (!isEffectImmune(tb, 'poison')) tb.energy -= dmg;
    } else if (style === 'swoop') {
        if (a.unitType === 'scout') applyStatusEffect(tb, 'watch', getUnitEffectiveLevel(a), 0, a.owner, a.unitType);
        tb.energy -= dmg;
    } else {
        tb.energy -= dmg;
    }
    pushHostileDamageAlert(tb, before - tb.energy, a.owner);
    recordDamageVisual(tb, before - tb.energy, a.owner); shrineDamageTaken(tb, before - tb.energy);
    if (before > tb.energy) playSound('melee_hit', tb.x, tb.y, a.unitType);
    if (tb.energy <= 0) destroyBuilding(tb);
}

// The state hash's object fields (SIM_UNIT_OBJ_FIELDS): per-slot arrays
// beside the columns (columns.oc_<field>); a set that changes the value
// moves the slot's digest (hObj) by the change of its term.
for (const k of (typeof SIM_UNIT_OBJ_FIELDS !== 'undefined' ? SIM_UNIT_OBJ_FIELDS : [])) {
    const key = _simHKey(k);
    const get = new Function(`return function () { const c = this._us; return c ? c.oc_${k}.get(this._si) : (this._det ? this._det.${k} : undefined); };`)();
    const hook = (typeof SIM_UNIT_OBJ_HOOKS !== 'undefined' && SIM_UNIT_OBJ_HOOKS[k]) || '';
    const set = new Function('k', 'T', `return function (v) { const c = this._us; if (c) { const s = this._si, a = c.oc_${k}, o = a.set(s,v); ${hook} if (o !== v) c.hObj[s] = (c.hObj[s] + T(${key}, v) - T(${key}, o)) | 0; } else if (this._det) this._det.${k} = v; else Object.defineProperty(this, k, { value: v, writable: true, enumerable: true, configurable: true }); };`)(k, _simHTerm);
    Object.defineProperty(Unit.prototype, k, { get, set, configurable: true });
}
// A worker's memory (sim_unit_state.js SIM_WK_MEM): its worker record's
// columns, by name; no record and an unset value: none taken. Without a
// slot: a plain field, as the object fields.
function _unitWmDecode(kind, x) {
    if (kind === 'N') return x === x ? x : undefined;
    if (kind === 'Y') return _simWttNames[x];
    return x === 0 ? undefined : simWtDecode(x & 7, (x - (x & 7)) / 8);
}
function _unitWmEncode(kind, v) {
    if (kind === 'N') return v === undefined || v === null ? NaN : Number(v);
    if (kind === 'Y') return simWttCode(v === undefined ? undefined : v);
    if (v === undefined || v === null) return 0;
    const [k, t] = simWtEncode(v);
    return k === SIM_WT_NULL || k === SIM_WT_UNDEF ? 0 : t * 8 + k;
}
for (const [k, col, kind] of (typeof SIM_WK_MEM !== 'undefined' ? SIM_WK_MEM : [])) {
    const zeroDefault = col === 'wmFailU';
    const unset = zeroDefault ? 'x === 0' : kind === 'N' ? 'x !== x' : kind === 'Y' ? 'x <= 1' : 'x === 0';
    const get = new Function('D', `return function () { const c = this._us; if (c) { const w = c.wkIx[this._si]; return D('${kind}', w > 0 ? c.${col}[w] : ${kind === 'N' && !zeroDefault ? 'NaN' : '0'}); } return this._det ? this._det.${k} : undefined; };`)(_unitWmDecode);
    const set = new Function('E', 'k', 'Q', `return function (v) { const c = this._us; if (c) { const s = this._si, x = E('${kind}', v); let w = c.wkIx[s]; ${kind === 'T' ? 'if (x === 0 && v) Q(this, k, v);' : ''} if (w <= 0) { if (${unset}) return; w = simUnitWk(c, s); if (w <= 0) return; } c.${col}[w] = x; } else if (this._det) this._det.${k} = v; else Object.defineProperty(this, k, { value: v, writable: true, enumerable: true, configurable: true }); };`)(_unitWmEncode, k, _unitWmDecodeLater);
    Object.defineProperty(Unit.prototype, k, { get, set, configurable: true, enumerable: false });
}
// (The accessors' plain values in the digest: their keys.)
// (Guarded as the loops above: tests load unit.js without sim_unit_state.js.)
const _uhKey = typeof _simHKey === 'function' ? _simHKey : () => 0;
const _UH_WS = _uhKey('workerState'), _UH_WNR = _uhKey('_workerNextIdleRetargetTick'), _UH_PFA = _uhKey('pathIsFallbackAstar'),
    _UH_PPT = _uhKey('_pendingPathTarget');
function _unitHD(c, s, key, o, v) { c.hObj[s] = (c.hObj[s] + _simHTerm(key, v) - _simHTerm(key, o)) | 0; }
// (A worker task field before the unit's slot, or detached: a plain value.)
function _unitWkPre(u, k, v) {
    if (u._det) { u._det[k] = v; return; }
    if (!u._wkv) Object.defineProperty(u, '_wkv', { value: {}, writable: true, configurable: true });
    u._wkv[k] = v;
}
// (wkR / wkN: a whole number, or undefined / null as sentinels.)
function _unitWkNum(n) { return n === SIM_WK_UNDEF ? undefined : n === SIM_WK_NULL ? null : n; }
function _unitWkNumOf(v) { return v === undefined ? SIM_WK_UNDEF : v === null ? SIM_WK_NULL : Math.floor(Number(v)) | 0; }
function _unitWkMat(u, b, k) { const c = u._us; if (c) { const x = (c.wkS[u._si] >>> b) & 3; return x === 0 ? undefined : x === 2; } return u._det ? u._det[k] : u._wkv && u._wkv[k]; }
function _unitWkMatSet(u, b, k, v) { const c = u._us; if (c) { const s = u._si; c.wkS[s] = (c.wkS[s] & ~(3 << b)) | ((v === undefined ? 0 : v ? 2 : 1) << b); } else _unitWkPre(u, k, v); }

// Status effect fields: the slot's status record (SIM_UNIT_ST_SIDE, unit.stIx;
// record 0 the zeros: a write of anything else takes a record first), the
// transfer cooldown a column (its count down flagged: tmOn).
// (Made per column with its name in the code: one closure over the key did
// c[k] for every column at one site, a megamorphic lookup on every read.)
// (Uint16 timers, SIM_UNIT_U16_TIMERS: a store saturates at 0..SIM_TIMER_MAX,
// as the Rust kernels' sat16; Infinity and NaN store 0, as into Int32.)
for (const k of (typeof SIM_UNIT_STATUS_COLUMNS !== 'undefined' ? SIM_UNIT_STATUS_COLUMNS : [])) {
    const timer = SIM_STATUS_TIMER_COLUMNS.includes(k);
    const sat = typeof SIM_UNIT_U16_TIMERS !== 'undefined' && SIM_UNIT_U16_TIMERS.includes(k);
    const store = sat ? `v > 0 && v !== Infinity ? (v < ${SIM_TIMER_MAX} ? v : ${SIM_TIMER_MAX}) : 0` : 'v';
    const f = SIM_UNIT_ST_FIELD[k];
    const at = f ? `c.${f}[c.stIx[this._si]]` : `c.${k}[this._si]`;
    const get = new Function(`return function () { const c = this._us; return c ? ${at} : (this._det ? this._det.${k} : undefined); };`)();
    const put = f ? `const s = this._si, w = ${store}; let r = c.stIx[s]; if (r === 0 && w !== 0) r = simUnitSt(c, s); if (r !== 0) c.${f}[r] = w;`
        : `c.${k}[this._si] = ${store}; if (v > 0) c.tmOn[this._si] = 1;`;
    const set = new Function('k', `return function (v) { const c = this._us; if (c) { ${put} } else if (this._det) this._det.${k} = v; else Object.defineProperty(this, k, { value: v, writable: true, enumerable: true, configurable: true }); };`)(k);
    Object.defineProperty(Unit.prototype, k, { get, set, configurable: true });
}

// Status effects and attack timers of every unit, counted down at once
// before the unit pass (SIM_KERNEL_STATUS; Unit.update did it per unit):
// damage over time dealt, units it kills marked dead. Then the few events
// that need the objects: damage shown, watches ended.
const STATUS_PREPASS_CHUNK = 2048, STATUS_LOOKS_PER_JOB = 4;
let _statusShr = null;
// Units' damage over time is reported (its flash, the shrines' count) every
// this many ticks, summed (see SIM_KERNEL_STATUS).
const STATUS_DOT_REPORT_TICKS = 4;
// At a resync every peer drops the sums not yet reported (a restored peer
// has none).
function statusDotAccReset() {
    if (typeof simUnitStDropPending === 'function') simUnitStDropPending();
}
let _statusCounts = null, _statusList = null;
let _statusShrSum = null;
const _statusShrP = new Float64Array(2);
function statusPrepassRun() {
    const S = _simUnitState, n = S ? S.owners.length : 0;
    if (!S || n === 0 || units.length === 0) return;
    // (By slot: every unit's slot, the free ones passed over by unit.live.)
    const chunks = Math.ceil(n / STATUS_PREPASS_CHUNK);
    if (!_statusCounts || _statusCounts.length < chunks) { _statusCounts = simSharedArray(Int32Array, Math.max(64, chunks * 2)); simParallelBind('st.count', _statusCounts); }
    _statusList = simPhaseList(chunks * STATUS_PREPASS_CHUNK);
    const P = _simParams;
    P[0] = n; P[1] = STATUS_PREPASS_CHUNK; P[2] = gameTime; P[3] = STATUS_DOT_REPORT_TICKS; P[8] = simDk;
    // (The separation's tick-start copy only when separationStart, next,
    // will not take the prebuilt one.)
    P[4] = _sepPrebuiltForTick() ? 0 : 1;
    // (The shrines' share per job, fixed point; looks of the first few a job.)
    const NO = Math.max(16, players.length);
    if (!_statusShr || _statusShr.length < chunks * NO) { _statusShr = simSharedArray(Float64Array, Math.max(1024, chunks * NO * 2)); simParallelBind('st.shr', _statusShr); }
    P[5] = NO; P[6] = RESOURCE_FIXED_POINT_SCALE; P[7] = STATUS_LOOKS_PER_JOB;
    // (Empty slabs skipped by the copies: the allocator's free counts, k.rs slab_runs.)
    P[9] = simUnitStateSlabsBind();
    simParallelRun(SIM_KERNEL_STATUS, chunks);
    {
        // (The shares per owner: wasm/src/nfs.rs k_owner_sum.)
        if (!_statusShrSum || _statusShrSum.length < NO || !simHeapHas(_statusShrSum)) _statusShrSum = simSharedArray(Float64Array, Math.max(16, NO));
        _statusShrP[0] = chunks; _statusShrP[1] = NO;
        simRustDirect('k_owner_sum', [_statusShr, _statusShrSum], _statusShrP);
        for (let o = 0; o < NO; o++) {
            const v = _statusShrSum[o];
            if (!v) continue;
            if (o >= _shrinePendingFixed.length) { const a = new Float64Array(o + 8); a.set(_shrinePendingFixed); _shrinePendingFixed = a; }
            _shrinePendingFixed[o] += v;
        }
    }
    const C = S.columns, EV = C.stEv, DOT = C.stDt, IX = C.stIx, owners = S.owners;
    // (Each job's slots with events, in slot order: the kernel's lists;
    // what is done with them does not depend on their order.)
    const LIST = _statusList;
    for (let k = 0; k < chunks; k++) {
        for (let j = k * STATUS_PREPASS_CHUNK, je = j + _statusCounts[k]; j < je; j++) {
            const s = LIST[j], r = IX[s], ev = EV[r];
            if (ev === 0) continue;
            EV[r] = 0;
            const u = owners.at(s);
            if (!u || u._si !== s) continue;
            if (ev & 1) recordDamageVisual(u, DOT[r]);
            if (ev & 2) { u.watchedByTeam = -1; if (typeof visCoverOnUnitSpatialChanged === 'function') visCoverOnUnitSpatialChanged(u); }
        }
    }
}


function getUnitStackCount(u) {
    if (!u) return 1;
    if (Number.isFinite(u.stackCount) && u.stackCount >= 1) return Math.floor(u.stackCount);
    return getRequiredStacksForLevel(getUnitBaseLevel(u));
}

function stackCountToLevel(stacks) {
    return Math.max(1, clampThingLevel(detFloorLog2(stacks || 1) + 1));
}

function distributeEvenInteger(total, count) {
    let n = Math.max(0, Math.floor(count || 0));
    if (n <= 0) return [];
    let sum = Math.max(0, Math.floor(total || 0));
    let base = Math.floor(sum / n);
    let rem = sum % n;
    let out = new Array(n).fill(base);
    for (let i = 0; i < rem; i++) out[i]++;
    return out;
}

function distributeEvenWithCaps(total, caps) {
    let n = caps.length;
    if (n === 0) return [];
    let values = new Array(n).fill(0);
    let left = Math.max(0, Number(total) || 0);
    let active = Array.from({ length: n }, (_, i) => i);
    let eps = 1e-6;
    while (left > eps && active.length > 0) {
        let share = left / active.length;
        let nextActive = [];
        for (let idx of active) {
            let capLeft = Math.max(0, (Number(caps[idx]) || 0) - values[idx]);
            if (capLeft <= eps) continue;
            let add = Math.min(capLeft, share);
            values[idx] += add;
            left -= add;
            if (((Number(caps[idx]) || 0) - values[idx]) > eps) nextActive.push(idx);
        }
        if (nextActive.length === active.length) {
            // No one capped this pass, we're done.
            break;
        }
        active = nextActive;
    }
    return values;
}

function removeUnitNow(u, adjustPop = true) {
    if (!u) return;
    if (!u.dead) {
        u.dead = true;
        u.energy = 0;
    }
    _clearWorkerTarget(u);
    removeUnitSpatial(u);
    // Left in the list, dead, for the tick's single compaction pass (which
    // also drops it from the selection): a splice per removal made removing
    // many units quadratic.
    u._removedNow = true;
    if (adjustPop && players[u.owner]) players[u.owner].popCount = Math.max(0, (players[u.owner].popCount || 0) - 1);
}

// A unit's slot: through its handle (sim_unit_state.js SimOwners; _h, set
// when it takes a slot, 0 once it let go of it): the relayout moves units
// between slots in the heap alone (the handle table), no object written.
Object.defineProperty(Unit.prototype, '_si', { configurable: true, get() { const c = this._us; return c ? c.hslot[this._h] : -1; } });
// Its columns while its handle names a slot (null once let go: the release
// gives the object handle 0 and its unit's last id, owner and position,
// sim_unit_state.js simUnitStateDetachGoneMany).
Object.defineProperty(Unit.prototype, '_us', { configurable: true, get() { const c = this.__c, h = this._h; return c && h > 0 && c.hgen[h] === this._g && c.hslot[h] >= 0 ? c : null; }, set(v) { if (Object.prototype.hasOwnProperty.call(this, '__c')) this.__c = v; else Object.defineProperty(this, '__c', { value: v, writable: true, configurable: true }); } });
// (A gone unit's id, owner and position: its handle's gone record while the
// handle is one generation on (the release kernel's), unless set on the
// object (a single detach's _simCaptureGone).)
for (const [k, i] of [['_goneId', 0], ['_goneOwner', 1], ['_goneX8', 2], ['_goneY8', 3]]) {
    Object.defineProperty(Unit.prototype, k, { configurable: true, get() { const c = this.__c, h = this._h; return c && h > 0 && c.hgen[h] === ((this._g + 1) >>> 0) ? c.hg[4 * h + i] : 0; }, set(v) { Object.defineProperty(this, k, { value: v, writable: true, configurable: true }); } });
}
Object.defineProperty(Unit.prototype, '_det', _simGoneAccessor);
// A new unit: its slot and the columns of its own values, nothing else (the
// slot holds every other column at its default already: zeroed,
// simSlotDefaults, _simJsDefaults). The object is only the slot's handle
// (its own fields are _us, _si, _det, _rm: the same layout as a
// constructed unit's). The Unit constructor wrote ~100 fields through their
// setters, 81 of them the values the slot held: ~68 us a spawn at 1.1k
// spawns a tick on the 1M-unit chaos scene.
function simSpawnUnit(unitType, owner, x, y, level = 1, prepare = null) {
    if (!_unitFieldsMutable || !SIM_SPAWN_DIRECT) return new Unit(unitType, owner, x, y, level, prepare);
    const u = Object.create(Unit.prototype);
    simUnitStateAllocate(u, x, y);
    const C = u._us, s = u._si, def = BASE_UNIT_STATS[unitType] || BASE_UNIT_STATS.norm;
    // (A unit made outside a tick (an action's, a restore's): the prebuilt
    // unit index no longer holds, as the constructor's dead setter told it.)
    if (typeof _inGameTick !== 'undefined' && !_inGameTick && typeof _sxPre !== 'undefined' && _sxPre) spatialIndexInvalidate();
    const px = Math.round(x * 8), py = Math.round(y * 8);
    C.id[mvtM(s)] = nextUnitId++;
    C.owner[mvtM(s)] = owner;
    u.unitType = unitType;
    C.x[mvtM(s)] = px; C.y[mvtM(s)] = py; C.prevX[s] = px; C.prevY[s] = py; C.x0[s] = px; C.y0[s] = py;
    C.upT[s] = simUnitTypeIndex(unitType);
    C.energy[s] = Math.max(1, Math.floor(Number(def.energy) || 1));
    u.r = def.r;
    u.collisionR = Number.isFinite(def.collisionR) ? def.collisionR : def.r;
    C.unitLevel[s] = 1; C.stackCount[s] = 1; C.effectiveStacks[s] = 1; C.effectiveLevel[s] = 1; C.baseLevel[s] = 1;
    // (No target: a slot that held no unit yet can hold a kernel's target
    // values (found by a two-peer chaos run: the host's units differed from
    // the restored guests'); the constructor's targetUnit / targetBuilding /
    // targetPos writes cleared them.)
    C.tuS[s] = -1; C.tuId[s] = 0; C.tbT[s] = -1; C.acqB[s] = 0; C.mvTgX[s] = NaN; C.mvTgY[s] = NaN;
    if (prepare) prepare(u);
    // Its stats: the columns the level scaling writes, the same for every
    // unit of its owner, type and level at the same stat tables (its row,
    // the movement kernel's values of it, its tables' references): made by
    // the full path for the first, copied for the rest (_spawnStats; a
    // worker's record is not among them: the level scaling writes none of it).
    if (SPAWN_STAT_TEMPLATES) _spawnStats(u, C, s, owner, unitType, level);
    else applyUnitLevelScaling(u, level);
    C.energy[s] = u.preComputedEffective ? u.preComputedEffective.maxEnergy : C.energy[s];
    if (typeof upkeepUnitRefresh === 'function') upkeepUnitRefresh(u);
    if (typeof SIM_OCCUPANCY_ENABLED !== 'undefined' && SIM_OCCUPANCY_ENABLED && !occupancySpawn(u)) { u.dead = true; simUnitStateDetach(_simUnitState, s); return u; }
    updateUnitSpatial(u);
    return u;
}

// The stat columns of a new unit by (owner, type, level): what
// applyUnitLevelScaling wrote on a fresh slot, as one straight-line write.
// Void when the (owner, type) tables' version (a research of that type: its
// values) or the effective rows (_effRowEpoch: their indices) changed. (Not
// on every stat rebuild, _precomputedStatsVersion: a research of any type
// finishes almost every tick in a big match; it only makes the shared
// effective tables' clones anew, with the same values.) (upB: the upkeep bins, refreshed by
// the caller; the shared rows the first one noted stay.)
let SPAWN_STAT_TEMPLATES = true;
// (false: every new unit by the Unit constructor, as before simSpawnUnit: an A/B switch.)
let SIM_SPAWN_DIRECT = true;
// (By a number: ((owner * 2 + worker) * types + type index) * 64 + level; no key strings made a spawn.)
const _spawnStatTemplates = new Map();
const _spawnStatColumnNames = new WeakMap();
const _spawnStatBefore = [];
const _SPAWN_STAT_SKIP = new Set(['upB', 'energy']);
function _spawnStats(u, C, s, owner, unitType, level) {
    const lvl = Math.max(1, Math.floor(level || 1)), ver = typeof _unitStatsVerOf === 'function' ? _unitStatsVerOf(u) : 0, epoch = typeof _effRowEpoch === 'number' ? _effRowEpoch : 0;
    const key = (((owner + 1) * 2 + (u.workerType ? 1 : 0)) * 4096 + C.upT[s]) * 64 + Math.min(63, lvl);
    let T = _spawnStatTemplates.get(key);
    if (T && T.ver === ver && T.epoch === epoch && T.C === C && T.lvl === lvl) { _spawnTplWrite(T, C, s, false); return; }
    // (The first of its key at these tables: the full path, its writes noted.)
    let names = _spawnStatColumnNames.get(C);
    if (!names) _spawnStatColumnNames.set(C, names = Object.keys(C));
    const before = _spawnStatBefore;
    for (let i = 0; i < names.length; i++) { const c = C[names[i]]; before[i] = !c ? undefined : ArrayBuffer.isView(c) ? (c.length === S_CAP_OF(C) ? c[s] : undefined) : typeof c.get === 'function' ? c.get(s) : undefined; }
    applyUnitLevelScaling(u, lvl);
    // (Kept as lists, written by a loop: _spawnTplWrite. Also split for the
    // q / e's rows: the per-slot heap columns as a program
    // k_spawn_write runs (pc, pv), the rest (jn/jv, the references) here.
    // Was a generated function, compiled again at every miss: templates go
    // stale whenever their owner's research of the type finishes.)
    const an = [], av = [], jn = [], jv = [], rn = [], refs = [], pc = [], pv = [], ix = _spbColIx();
    for (let i = 0; i < names.length; i++) {
        const k = names[i], c = C[k];
        if (!c || _SPAWN_STAT_SKIP.has(k)) continue;
        if (ArrayBuffer.isView(c)) {
            if (c.length !== S_CAP_OF(C)) continue;
            const v = c[s];
            if (!Object.is(v, before[i])) {
                an.push(k); av.push(v);
                const e = ix.get(k);
                if (e !== undefined && e[1] === 1) { pc.push(e[0]); pv.push(v); } else { jn.push(k); jv.push(v); }
            }
        } else if (typeof c.get === 'function') {
            const v = c.get(s);
            if (!Object.is(v, before[i])) { rn.push(k); refs.push(v); }
        }
    }
    before.fill(undefined, 0, names.length);
    _spawnStatTemplates.set(key, { ver, epoch, lvl, C, refs, rn, an, av: Float64Array.from(av), jn, jv: Float64Array.from(jv),
        pc: Int32Array.from(pc), pv: Float64Array.from(pv), pAt: -1, pGen: -1, e: _spawnMaxE(u) });
}
// A template's writes at slot s: every column (the one-by-one path), or
// (jsOnly) those the batch's kernel does not write: the columns outside the
// heap and the references.
function _spawnTplWrite(T, C, s, jsOnly) {
    const n = jsOnly ? T.jn : T.an, v = jsOnly ? T.jv : T.av;
    for (let i = 0; i < n.length; i++) C[n[i]][s] = v[i];
    const rn = T.rn, R = T.refs;
    for (let i = 0; i < rn.length; i++) C[rn[i]].set(s, R[i]);
}
// (A spawned unit's energy: its maxEnergy, NaN when unset (as the energy column stores undefined).)
function _spawnMaxE(u) { const v = u.maxEnergy; return v === undefined ? NaN : Number(v);
}
// ---- birth rows (q / e: main.js _rz*) ----
// A new unit's core columns written from a row (k_spawn_write, wasm/src/nfs.rs; q / e's staged births, _spbRowsRun):
// its own values, a program's, then its energy. (The spawners' spawns: barrack.js _spawnBirths, spr.rs k_spawn_births.)
const _SPB_ROW = 12;
// (Row: [0] slot, [1] its template program's first triple, [2] its triples
// (-1: written already), [3] id, [4] owner, [5] type index, [6] x, [7] y
// (1/8 px), [8] r, [9] collisionR, [10] energy, [11] handle.)
// The values every new unit gets ([column, row value index] or [column, -1,
// value]), as simSpawnUnit writes them; then its template's; then energy.
const _SPB_CORE = [['id', 3], ['owner', 4], ['upT', 5], ['x', 6], ['y', 7], ['prevX', 6], ['prevY', 7], ['x0', 6], ['y0', 7], ['r', 8], ['collisionR', 9],
    ['unitLevel', -1, 1], ['stackCount', -1, 1], ['effectiveStacks', -1, 1], ['effectiveLevel', -1, 1], ['baseLevel', -1, 1],
    ['tuS', -1, -1], ['tuId', -1, 0], ['tbT', -1, -1], ['acqB', -1, 0], ['mvTgX', -1, NaN], ['mvTgY', -1, NaN],
    // (Its handle: the slot's start's (simUnitStateAllocate), again; a staged birth's 0, set at its commit with live, birth.rs.)
    ['hnd', 11],
    // (Alive: a staged birth's reserved slot keeps its last unit's dead flags until the commit, main.js _rzZeroTable.)
    ['dead', -1, 0], ['dead0', -1, 0]];
const _SPB_FINAL = [['energy', 10]];
// (The rows' programs: the core and final ones first, SPB_PROG triples; the row buffer and the column kinds made at the
// match's start, simSpawnBatchReserve.)
const SPB_CAP = 16384, SPB_PROG = 65536;
const _spb = { rows: null, prog: null, progN: 0, base: 0, gen: 0, colIx: null, kind: null, kindN: 0, boundRows: null };
function simSpawnBatchReserve() {
    const B = _spb;
    if (B.rows === null || !simHeapHas(B.rows)) B.rows = simSharedArray(Float64Array, SPB_CAP * _SPB_ROW);
    if (B.prog === null || !simHeapHas(B.prog)) _spbProgRoom(0);
    if (B.kind === null || !simHeapHas(B.kind)) { B.kind = simSharedArray(Int32Array, 1024); B.kindN = 0; }
}
// The column kinds of the slot-zero table (Z.n columns; made at the
// match's start with room for 1024, filled at the first batch).
function _spbKind(Z) {
    const B = _spb, S = _simUnitState;
    if (B.kind === null || !simHeapHas(B.kind) || B.kind.length < Z.n) { B.kind = simSharedArray(Int32Array, Math.max(1024, Z.n)); B.kindN = 0; }
    if (B.kindN !== Z.n) {
        const kind = B.kind, cols = [...SIM_UNIT_COLUMNS, ...SIM_MOVE_COLUMNS.map(c => c[0])];
        cols.forEach((k, i) => { const a = S.columns[k]; kind[i] = a instanceof Float64Array ? 3 : a instanceof Float32Array ? 2 : 1; });
        B.kindN = Z.n;
    }
}
// Column name -> [index in the slot-zero table (sim_unit_state.js
// _simSlotZeroTable: the unit columns, then the movement ones), elements a slot].
function _spbColIx() {
    if (!_spb.colIx) {
        const m = new Map(); let i = 0;
        for (const k of SIM_UNIT_COLUMNS) m.set(k, [i++, 1]);
        for (const [k, , per] of SIM_MOVE_COLUMNS) m.set(k, [i++, per]);
        _spb.colIx = m;
    }
    return _spb.colIx;
}
// The program buffer (heap: the helpers read it) with room for n more
// triples; the core and final programs at its start.
// (false: no room for n more; made once, SPB_PROG triples.)
function _spbProgRoom(n) {
    const B = _spb, live = B.prog !== null && simHeapHas(B.prog);
    if (live) return (B.progN + n) * 3 <= B.prog.length;
    const ix = _spbColIx(), base = [];
    for (const [k, src, v] of [..._SPB_CORE, ..._SPB_FINAL]) { const e = ix.get(k); if (e === undefined || e[1] !== 1) throw new Error('spawn batch: no per-slot heap column ' + k); base.push(e[0], src, src < 0 ? v : 0); }
    const a = simSharedArray(Float64Array, SPB_PROG * 3);
    a.set(base); B.progN = base.length / 3; B.gen++;
    B.base = base.length / 3; B.prog = a;
    return (B.progN + n) * 3 <= B.prog.length;
}
// Rows bound by their own name (kernel: the spawn write kernel registered
// over it, q / e's SIM_KERNEL_RZ_SPAWN_WRITE), on the helpers.
function _spbRowsRun(rows, n, kernel, from = 0) {
    const B = _spb, Z = _simSlotZeroTable(_simUnitState);
    if (!Z) throw new Error('spawn batch: unit columns not in the heap');
    _spbKind(Z);
    if (B.prog === null || !simHeapHas(B.prog)) _spbProgRoom(0);
    simParallelBind('spw.kind', B.kind); simParallelBind('spw.prog', B.prog);
    const P = _simParams;
    P[0] = n; P[1] = 1024; P[2] = _SPB_ROW; P[3] = 0; P[4] = _SPB_CORE.length; P[5] = _SPB_CORE.length; P[6] = _SPB_FINAL.length; P[7] = from;
    simParallelRun(kernel, Math.ceil(n / 1024));
}
let _spbLayer = null, _spbLayerN = -1, _spbTy = null, _spbTyN = -1;
const _spbSpP = new Float64Array(16);
// New units (n slots of list) into the spatial index (k_spawn_spatial).
function _spbSpatialList(list, n) {
    const S = _simUnitState, c = S.columns;
    if (CHUNK_SIZE !== 1) throw new Error('spawn batch: k_spawn_spatial takes chunks of one tile');
    if (_sxPre && typeof _inGameTick !== 'undefined' && !_inGameTick) spatialIndexInvalidate();
    _spbSpatialTables();
    const NT = spatialUnitsComplexUnitTypeCount;
    if (!simHeapHas(cellArea) && typeof cellColumnsRehome === 'function') cellColumnsRehome();
    const P = _spbSpP;
    P[0] = n; P[1] = GRID_W; P[2] = GRID_H; P[3] = TILE * 8; P[4] = spatialEpoch; P[5] = spatialUnitsComplexStridePerChunk; P[6] = spatialTypeStridePerBlock; P[7] = NT;
    P[8] = spatialUnitsComplexPlayerCount; P[9] = spatialNormUnitTypeIndex; P[10] = CHUNKS_W; P[11] = SPATIAL_TYPE_BLOCK; P[12] = spatialTypeBlocksW; P[13] = SPATIAL_BLOCK_SIZE; P[14] = spatialBlockCols;
    P[15] = _spatialCountDefer ? 1 : 0;
    if (typeof tickStartChainSettleHostile === 'function') tickStartChainSettleHostile();
    simRustDirect('k_spawn_spatial', [list, c.x, c.y, c.owner, c.upT, _spbTy, _spbLayer, cellArea, c.spTile, S.sepKey, S.sepLayer, c.spArea, c.spOwner, c.spEpoch, c.spType, c.mvOn,
        spatialUnitsComplex, spatialTypeCounts, spatialBlockCounts, c.dead], P);
    // (During the unit pass the counts wait for its end, as _spatialCountAdd queues them.)
    if (_spatialCountDefer) for (let i = 0; i < n; i++) { const s = list[i]; if (c.dead[s] !== 1) _spatialCountAdd(c.sepKey[s], c.spOwner[s], c.spType[s], 1); }
}
// The spawns' spatial type tables: per spatial type its separation layer (1
// flying, 2 a mole), upkeep type (unit.upT) -> spatial type (-1 none), made
// again as the type names grow.
function _spbSpatialTables() {
    const NT = spatialUnitsComplexUnitTypeCount;
    if (_spbLayerN !== NT || !_spbLayer || !simHeapHas(_spbLayer)) {
        _spbLayer = simSharedArray(Uint8Array, Math.max(64, NT));
        for (const k in spatialUnitTypeToIndex) { const i = spatialUnitTypeToIndex[k], b = BASE_UNIT_STATS[k]; if (i >= 0 && i < NT) _spbLayer[i] = b && b.isFlying ? 1 : k === 'mole' ? 2 : 0; }
        _spbLayerN = NT;
    }
    // (Upkeep type (unit.upT) -> spatial type, as the type names grow: -1 none.)
    const names = typeof _simUnitTypeNames !== 'undefined' ? _simUnitTypeNames : [];
    if (_spbTyN !== names.length || !_spbTy || !simHeapHas(_spbTy)) {
        _spbTy = simSharedArray(Int8Array, Math.max(64, names.length + 8)); _spbTy.fill(-1);
        for (let i = 0; i < names.length; i++) { const j = spatialUnitTypeToIndex[names[i]]; if (j >= 0) _spbTy[i] = j; }
        _spbTyN = names.length;
    }
}
// (The slot count of the unit columns: per-slot columns are this long, those of other strides not.)
function S_CAP_OF(C) { return _simUnitState.cap; }

function configureWorkerUnitFromType(u) {
    if (!u) return;
    let resourceCollectorCfg = getResourceTypeByCollectorUnit(u.unitType);
    if (resourceCollectorCfg) {
        u.workerState = 'IDLE';
        u.workerType = resourceCollectorCfg.collectorUnitKey;
        u.carryingValue = 0;
        _clearWorkerTarget(u);
        if (typeof _clearResourceCollectorTaskMemory === 'function') _clearResourceCollectorTaskMemory(u);
    } else if (u.unitType === 'salvager_unit') {
        u.workerState = 'IDLE'; u.workerType = 'salvager'; u.carryingValue = 0; _clearWorkerTarget(u);
    } else if (u.unitType === 'builder_unit') {
        u.workerState = 'IDLE'; u.workerType = 'builder'; u.carryingValue = 0; _clearWorkerTarget(u);
        u.builderHasMaterial = false;
    } else if (u.unitType === 'healer_unit') {
        u.workerState = 'IDLE'; u.workerType = 'healer'; u.carryingValue = 0; _clearWorkerTarget(u);
        u.healerHasMaterial = false;
    } else if (u.unitType === 'researcher_unit') {
        u.workerState = 'IDLE'; u.workerType = 'researcher'; u.carryingValue = 0; _clearWorkerTarget(u);
        u.researcherHasMaterial = false;
    }
}

function spawnUnitNearUnit(templateUnit) {
    if (!templateUnit) return null;
    let attempts = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1],
        [2, 0], [-2, 0], [0, 2], [0, -2]
    ];
    let baseGx = Math.floor(templateUnit.x / TILE);
    let baseGy = Math.floor(templateUnit.y / TILE);
    let spawnTile = { x: baseGx, y: baseGy };
    for (let [dx, dy] of attempts) {
        let tx = Math.max(0, Math.min(GRID_W - 1, baseGx + dx));
        let ty = Math.max(0, Math.min(GRID_H - 1, baseGy + dy));
        if (templateUnit.isFlying || canUnitOccupyTile(templateUnit, tx, ty)) {
            spawnTile = { x: tx, y: ty };
            break;
        }
    }
    if (!templateUnit.isFlying) {
        spawnTile = findNearestWalkable(spawnTile.x, spawnTile.y, baseGx, baseGy);
    }
    let nu = simSpawnUnit(templateUnit.unitType, templateUnit.owner, spawnTile.x * TILE + 16, spawnTile.y * TILE + 16);
    configureWorkerUnitFromType(nu);
    return nu;
}

function shuffleInPlaceDeterministic(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        let r = simHashRand(gameTime, i, arr.length);
        let j = Math.floor(r * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function resizeUnitSubgroup(playerId, unitIds, mode, subgroupFilter = null) {
    if (!Array.isArray(unitIds) || unitIds.length === 0) return;
    let idSet = new Set(unitIds);
    // (By the id map, in id order as the units list holds them: not a pass
    // over every unit per order.)
    let source = _unitsInIdOrder([...idSet].map(id => getUnitById(id)).filter(u => u && u.owner === playerId && !u.dead && !u.isKing));
    if (subgroupFilter && subgroupFilter.unitType) {
        source = source.filter(u => u.unitType === subgroupFilter.unitType);
    }
    if (subgroupFilter && Number.isFinite(subgroupFilter.unitLevel)) {
        source = source.filter(u => getUnitBaseLevel(u) === subgroupFilter.unitLevel);
    }
    if (source.length === 0) return;
    if (mode === 'd2' && source.length < 2) return;

    // Keep deterministic order for repeatable redistribution.
    source.sort((a, b) => a.id - b.id);

    let initialCount = source.length;
    let sumStacks = source.reduce((s, u) => s + getUnitStackCount(u), 0);
    let sumEnergy = source.reduce((s, u) => s + Math.max(0, Number(u.energy) || 0), 0);

    let targetCount = initialCount;
    if (mode === 'x2') {
        targetCount = Math.min(sumStacks, initialCount * 2);
        let popCap = getPlayerPopCap(playerId);
        let room = Math.max(0, popCap - players[playerId].popCount);
        targetCount = Math.min(targetCount, initialCount + room);
    } else {
        targetCount = Math.floor(initialCount / 2);
    }
    targetCount = Math.max(0, Math.floor(targetCount));

    let survivors = [];
    if (targetCount >= initialCount) {
        survivors = [...source];
        let toSpawn = targetCount - initialCount;
        for (let i = 0; i < toSpawn; i++) {
            let template = source[i % source.length];
            let nu = spawnUnitNearUnit(template);
            if (!nu) continue;
            unitAdded(nu);
            players[playerId].popCount++;
            survivors.push(nu);
        }
    } else {
        let shuffled = shuffleInPlaceDeterministic([...source]);
        let survivorSet = new Set(shuffled.slice(0, targetCount).map(u => u.id));
        survivors = source.filter(u => survivorSet.has(u.id));
        for (let u of source) {
            if (!survivorSet.has(u.id)) removeUnitNow(u, true);
        }
    }

    if (survivors.length === 0) {
        updateInfoPanel();
        return;
    }

    // Distribute virtual stacks evenly (+-1), preserving exact combined stacks.
    let stackShares = distributeEvenInteger(sumStacks, survivors.length);
    for (let i = 0; i < survivors.length; i++) {
        let u = survivors[i];
        let stackCount = Math.max(1, stackShares[i]);
        u.stackCount = stackCount;
        let lvl = stackCountToLevel(stackCount);
        applyUnitLevelScaling(u, lvl);
        u.stackCount = stackCount;
    }

    // Preserve total Energy as much as possible without exceeding new total max Energy.
    let maxEnergyCaps = survivors.map(u => Math.max(1, Number(u.preComputed && u.preComputed.maxEnergy) || 1));
    let energyTarget = Math.min(sumEnergy, maxEnergyCaps.reduce((s, v) => s + v, 0));
    let energyShares = distributeEvenWithCaps(energyTarget, maxEnergyCaps);
    for (let i = 0; i < survivors.length; i++) {
        survivors[i].energy = Math.max(0, Math.min(maxEnergyCaps[i], energyShares[i]));
        if (survivors[i].energy <= 0) survivors[i].energy = Math.min(1, maxEnergyCaps[i]);
    }

    // Keep selection focused on transformed survivors only.
    let survivorIds = new Set(survivors.map(u => u.id));
    selectedUnits = selectedUnits.filter(u => !idSet.has(u.id) || survivorIds.has(u.id));
    for (let u of survivors) {
        if (!selectedUnits.includes(u)) selectedUnits.push(u);
    }

    updateInfoPanel();
}


// The nearest tile to (gx, gy) the unit may stand on (itself if it may), and
// in the nearest ring holding any the one nearest (fromGx, fromGy) (ties:
// smaller y, then smaller x); by the kernel (wasm/src/tch.rs k_nearest_walk)
// over the walls the unit walks by (the ground's, the builders' class walls,
// none flying), active mines for collectors, its owner's cloud towers.
const _nwP = new Float64Array(16);
let _nwOut = null, _nwCloud = null, _nwCloudN = -1;
function findNearestWalkable(gx, gy, fromGx, fromGy, unit = null, out = { x: 0, y: 0 }) {
    if (!_nwOut || !simHeapHas(_nwOut)) _nwOut = simHeapArray(Int32Array, 2);
    _stationaryTypesSeed();
    const nty = _stationaryTypes.length;
    if (_nwCloudN !== nty || !_nwCloud || !simHeapHas(_nwCloud)) {
        _nwCloud = simHeapArray(Uint8Array, Math.max(16, nty));
        for (let i = 0; i < nty; i++) { const b = BASE_CARD_TYPES[_stationaryTypes[i]]; _nwCloud[i] = b && b.isCloud ? 1 : 0; }
        _nwCloudN = nty;
    }
    const wt = unit ? unit.workerType : null, build = wt === 'builder' || wt === 'salvager', P = _nwP;
    const T = _ST.code && _ST.n === GRID_W * GRID_H ? _ST : null;
    if (T && !simHeapHas(T.code)) structTablesRehome();
    P[0] = Math.floor(gx); P[1] = Math.floor(gy);
    const hasFrom = Number.isFinite(fromGx) && Number.isFinite(fromGy);
    P[2] = hasFrom ? Math.floor(fromGx) : NaN; P[3] = hasFrom ? Math.floor(fromGy) : NaN;
    P[4] = GRID_W; P[5] = GRID_H; P[6] = unit && unit.isFlying ? 2 : unit ? 1 : 0;
    P[7] = unit && Number.isFinite(unit.owner) ? unit.owner : -1; P[8] = wt && isResourceCollectorWorkerType(wt) ? 1 : 0; P[9] = nty;
    simRustDirect('k_nearest_walk', [simMoveWallGrid(), build && !(unit && unit.isFlying) ? _navClassWalls(NAV_PROFILE_BUILD) : null,
        T && T.code, T && T.val, T && T.uc, T && T.own, T && T.brain, _nwCloud, _nwOut], P);
    out.x = _nwOut[0]; out.y = _nwOut[1];
    return out;
}

// ---- Unit separation ----
// One pass per tick after every unit has moved (gameTick). Each touching
// pair is found once (per spatial chunk: the chunk itself, then the chunks
// ahead of it) and both units are pushed apart, every tick, so crowds move
// smoothly instead of creeping into each other and snapping back.
// A unit takes part when it moved this tick or on its staggered resting
// check (getUnitCollisionRecalcTicks); a pair is tested when either does,
// and only a taking-part unit is pushed. Pushes are summed as integers
// (1/UNIT_SEPARATION_Q px), so the result does not depend on the order of
// the pairs (bucket order may differ between peers).
const UNIT_SEPARATION_Q = 1024;
// Share of an overlap a unit corrects: both of a pair (about what two
// successive 0.6 corrections gave), or the only one taking part.
const UNIT_SEPARATION_SHARE_BOTH = 0.42, UNIT_SEPARATION_SHARE_ONE = 0.6;
// The flow-relative contact response (wasm/src/lib.rs pair_exact, mv.rs
// push4): a resting friend's share of the closing motion against a mover
// (YIELD; MOVER unused).
let UNIT_SEPARATION_SHARE_MOVER = 0.2, UNIT_SEPARATION_SHARE_YIELD = 0.75;
// Geometric separation relaxes overlap as 1 - exp(-ticks / RELAX_TICKS) of
// it (the same at any step size); a resting unit sleeps while its deepest
// contact is under REST_SLEEP of its radius and wakes past REST_WAKE (the
// separation radius has a skin: about 0.35 is touching); inside a coherent
// flow FLOW_SIDE of sideways separation is kept; all contact displacement
// at most CONTACT_SPEEDS of its speed a base tick.
// (Within SEP_GOAL_TILES of its destination its neighbours heading its
// way do not count as carrying it: mv.rs alike.)
const SEP_GOAL_TILES = 8;
let UNIT_SEPARATION_RELAX_TICKS = 4, UNIT_SEPARATION_REST_SLEEP = 0.4, UNIT_SEPARATION_REST_WAKE = 0.6,
    UNIT_SEPARATION_FLOW_SIDE = 0.5, UNIT_SEPARATION_CONTACT_SPEEDS = 1.5;
// A colliding unit on a fallback path retries its path every this many ticks.
const UNIT_SEPARATION_PATH_RETRY_TICKS = 4;
// Contacts summed in full (see runUnitSeparationPass).
const UNIT_SEPARATION_CONTACTS = 3;
// Dense crowds use a bounded neighbourhood. Zero restores the full pair
// scan. SIMD batches can finish up to three contacts beyond this budget.
let UNIT_SEPARATION_PAIR_BUDGET = 8;
const _sep = { cap: 0 };
function _sepGrow(n) {
    if (n <= _sep.cap) return;
    // (Whole blocks: the movement kernel's push pass reads four slots at a time.)
    let cap = Math.ceil(Math.max(1024, n, _sep.cap * 2) / 1024) * 1024;
    _sep.cap = cap;   // (the packed and output arrays follow it: runUnitSeparationPass)
}


// Units by tile, contiguous (sorted entries): ord[k] is the unit index of
// the k-th entry; tile c holds entries start[c] .. start[c + 1] - 1. The
// separation kernel (sim_parallel.js) gathers each checking unit's pushes
// from these packed arrays, in parallel over rows of tiles; the units are
// read before and written after, here.
function _sepShared(S, name, Type, n) {
    let arr = S[name];
    // (In the wasm heap: the chain's Rust kernels read them in place.)
    if (!arr || arr.length < n || !(arr instanceof Type)) { const old = arr; arr = S[name] = simHeapArray(Type, n); simParallelBind('sep.' + name, arr); simHeapFree(old); }
    return arr;
}
// Work is split into small batches of checking units, including within one
// crowded tile, rather than rows whose occupancy varies by orders of magnitude.

// Large worlds: the entries come straight from the unit state slots. The
// spatial index keeps each slot's chunk and layer current, so nothing is
// gathered from unit objects; entries are ordered by chunk (ties by slot:
// pushes are summed as integers, so the order does not change them).
// ============================================================
// MOVEMENT KERNEL
// ============================================================
// Most units spend most ticks marching along their route through open
// ground. After such a tick of Unit.update the unit is armed (its path
// window and stats in the columns, simMoveTryArm) and its following ticks
// run as SIM_KERNEL_MOVE over the columns and a few world tables (walls,
// structures by tile, hostile counts per block, area boxes), without
// reading the unit object: node by node, tile by tile, until something
// needs Unit.update again (a hostile possibly in reach, a hostile floor,
// the end of its window or path, a wall) or its orders, path, status or
// stats change (setters and hooks disarm it, simMoveDisarm). The kernel is
// a pure function of each unit's columns and the world, so the result does
// not depend on slot order; armed units move before the update pass, and
// the rest update in the usual order.
const _simMoveAreaSource = [0];

function simMoveDisarm(u) {
    const c = u && u._us;
    if (c) c.mvOn[mvtM(u._si)] = 0;
}

// Every unit's movement stat columns from its stats (after a restore, whose
// units get their stats as plain fields, and when the stat tables change in
// place: _precomputedStatsVersion).
let _simMoveStatsVersion = -1;
function simMoveRefreshAllStats() {
    _simMoveStatsVersion = typeof _precomputedStatsVersion !== 'undefined' ? _precomputedStatsVersion : 0;
    for (const u of units) if (u && u._us) simMoveStatsChanged(u);
}

// (At a resync, on every peer, and in a restore: every unit disarmed, and
// what only an armed unit's kernel reads (its arming, steering, steady
// window, parking, pending chunk move) as a fresh slot has it, so a unit
// that was armed before and a restored one start alike: leftovers of an
// earlier arming made the two peers' units move differently.)
const SIM_MOVE_ARM_COLUMNS = ['mvFlags', 'mvReach', 'mvBase', 'mvWlen', 'mvPlen', 'mvScan', 'mvWake', 'mvFlow', 'mvFGen', 'mvDest', 'mvReady', 'mvNP',
    'mvHT', 'mvHTId', 'mvTgX', 'mvTgY', 'mvTgTol',
    'mvWk', 'mvSpent', 'mvOut', 'spMvOld', 'spMvNew', 'mvNav'];
function simMoveDisarmAll() {
    if (typeof flowLooksDrop === 'function') flowLooksDrop();
    const S = _simUnitState;
    if (!S) return;
    const c = S.columns;
    c.mvOn.fill(0); mvtInvalidate();
    for (const k of SIM_MOVE_ARM_COLUMNS) if (c[k]) c[k].fill(0);
    // (The steering records: all but the floor tile, which is not an arming's; no destination.)
    const R = c.mvSteer;
    for (let i = 0; i < R.length; i += SIM_STEER_W) { R[i] = -1; R[i + 1] = 0; R[i + 2] = 0; R[i + 3] = 0; R[i + 4] = 0; R[i + 6] = 0; R[i + 7] = 0; }
    // (Pending chunk moves are counted at the unit pass's end: none now.)
    const NV = c.mvNav; if (NV) for (let i = 0; i < NV.length; i += SIM_NAV_STRIDE) NV[i] = -1;
}
// The flow look-aheads, at a resync on every peer: a new build or wall
// change leaves them standing until the unit's refresh tick, so their
// contents count (a restoring peer starts without them).
function simMoveResetLookCaches() {
    const S = _simUnitState;
    if (S) { const NV = S.columns.mvNav; for (let i = 0; i < NV.length; i += SIM_NAV_STRIDE) NV[i] = -1; const R = S.columns.mvSteer; for (let i = 0; i < R.length; i += SIM_STEER_W) R[i] = -1; }
}

// A level/stat change rechecks the navigation reach and armed path.
// Numeric stats themselves are read directly from the shared level row.
function simMoveStatsChanged(u, previousRow) {
    const c = u && u._us;
    if (!c) return;
    const s = u._si, pc = u.preComputed, f = c.mvFlags[s];
    if (pc && c.statRow[s] < 0) _effRowAttach(u);
    if (!Number.isInteger(previousRow)) previousRow=c.statRow[s];
    let same=!!pc && previousRow>=0 && previousRow<_effRowN;
    const spd = pc ? pc.speed * _getUnitAstarSpeedMultiplier(u) : NaN;
    if (pc) {
        const o1=c.mvLane[s],o3=c.mvReachD[s],o4=c.mvReachA[s],o5=c.mvShoot[s],o6=c.mvRangeK[s];
        const rd = Math.ceil(_getUnitAttackRangeArea(u)) + 1, ra = Math.ceil(Math.max(TILE, pc.visionRange * TILE) / TILE) + 1;
        c.atkSty[s] = _hitStyleCode(u); c.atkWatch[s] = _unitWatchTicks(u);
        c.mvLane[s] = Math.max(1.5, Math.min(4, u.r * 0.6)); 
        c.mvReachD[s] = rd >= 0 && rd < SIM_MOVE_BOX_STEPS ? rd : 255; c.mvReachA[s] = ra >= 0 && ra < 255 ? ra : 255;
        c.mvShoot[s] = pc.attackDamage > 0 ? 1 : 0;
        c.mvRangeK[s] = Math.min(255, Math.floor(_getUnitAttackRangeArea(u)));
        const rga = _getUnitAttackRangeArea(u);
        c.lzFlags[s] = (u.turretImmune ? 1 : 0) | (u.laserResistant ? 2 : 0) | (Math.floor(rga) === Math.ceil(rga) ? 4 : 0);
        
        const r=previousRow*EFF_HOT_WIDTH;
        same=same && Object.is(_effHot[r],Math.fround(spd))
            && Object.is(_effHot[r+1],Math.fround(_resolveUnitAstarTileCost(u)))
            && _effHot[r+3]===Math.fround(Math.max(TILE,pc.visionRange*TILE))
            && o1===c.mvLane[s] && o3===c.mvReachD[s] && o4===c.mvReachA[s]
            && o5===c.mvShoot[s] && o6===c.mvRangeK[s];
    }
    if (same) return;
    // Holding (3: an enemy unit, 5: a structure): the hold stands on its
    // range in area steps (mvReach, as simMoveTryHold took it) and on the
    // unit dealing damage; its chase step's length follows the speed. The
    // same range, still shooting: kept, as Unit.update would decide the same
    // (in a battle effective levels change all the time: every change made
    // each holder run Unit.update again).
    const on = c.mvOn[s];
    if (on === 3 || on === 5) {
        const k = Math.floor(Math.max(0, Number(_getUnitAttackRangeArea(u)) || 0));
        if (pc && pc.attackDamage > 0 && k === c.mvReach[s]) { return; }
        c.mvOn[mvtM(s)] = 0; return;
    }
    // Parked or chasing: its checks were made with the old stats (a parked
    // one's only with a look of its own: drive-by 1, search reach 2, aggro 16).
    if (on === 2 && (c.mvFlags[s] & 19) === 0) return;
    // (An attack-mover's park (its aggro look, 16, alone): its new reach.)
    if (on === 2 && (c.mvFlags[s] & 19) === 16) { if (c.mvReachA[s] !== 255) { c.mvReach[s] = c.mvReachA[s]; return; } c.mvOn[mvtM(s)] = 0; return; }
    if (on >= 2) { c.mvOn[mvtM(s)] = 0; return; }
    if (c.mvOn[s] !== 1) return;
    let reach = 0, ok = spd >= 0;
    if (ok && (f & 16)) reach = Math.ceil(Math.max(TILE, pc.visionRange * TILE) / TILE) + 1;
    else if (ok && (f & 1)) reach = Math.ceil(_getUnitAttackRangeArea(u)) + 1;
    // A drive-by shooter that no longer shoots (or the reverse), or reaches
    // out of its tables: Unit.update decides.
    if (!ok || ((f & 16) === 0 && ((f & 1) !== 0) !== (pc.attackDamage > 0)) || !(reach >= 0 && reach < ((f & 16) ? 256 : SIM_MOVE_BOX_STEPS))) { c.mvOn[mvtM(s)] = 0; return; }
    if ((f & 1) && reach !== c.mvReach[s]) {
        const area = u._spatialAreaId;
        if (!(area >= 0)) { c.mvOn[mvtM(s)] = 0; return; }
        _simMoveEnsureAreaBox(area, reach);
    }
    c.mvReach[s] = reach; 
}


// Flow mode: a unit following the flow navigation (destination field slot
// `fid`, its generation `gen`; the air navigation for a flying unit) to tile
// `dest` under command `cmd`, armed
// from its columns alone (stats: simMoveStatsChanged). False when those do
// not allow it (Unit.update keeps the unit).
const SIM_FLOW_ARRIVE = 2;
// A unit's worker kind for the kernel (mvWk): 0 none, 1 at its task, 2 sent
// by the player.
// (3: on its way back for material (RETURNING_FOR_GOLD) or a salvager's
// return: its AI looks at nothing until its way ends, so no check ticks; a
// builder's watchdog samples in the kernel.)
function _simWorkerKind(u) {
    const ws = u.workerState;
    if (!ws) return 0;
    if (ws === 'MANUAL_MOVE') return 2;
    // (Collectors' returns keep their check ticks: a player's assignment
    // while one carries a load is looked at then.)
    return ws === 'RETURNING_FOR_GOLD' || (ws === 'RETURNING' && u.workerType === 'salvager') ? 3 : 1;
}
// (profile: its navigation's, flownav.js navProfileOf: its walls and fields.)
function simFlowArm(c, s, fid, gen, dest, cmd, flying, ready = 0, worker = false, isWorker = false, profile = flying ? NAV_PROFILE_AIR : NAV_PROFILE_GROUND) {
    if (!(simUnitStatValue(c,s,0) >= 0) || c.sepKey[s] === SIM_SEP_ABSENT) return false;
    // (Bit 128: no arriving in a crowd short of the tile: a worker's task
    // is at its tile, a lone unit's order too.)
    let flags = 64 | (flying ? 32 : 0) | (worker ? 128 : 0), reach = 0;
    if (cmd === CMD_ATTACK_MOVING) {
        reach = c.mvReachA[s];
        if (reach === 255) return false;
        flags |= 16;
    } else if (c.mvShoot[s]) {
        reach = c.mvReachD[s];
        const area = c.spArea[s];
        if (reach === 255 || !(area >= 0)) return false;
        _simMoveEnsureAreaBox(area, reach);
        flags |= 1;
    }
    c.mvFlags[mvtM(s)] = flags; c.mvReach[s] = reach; c.mvFlow[s] = fid; c.mvFGen[s] = gen; c.mvDest[mvtM(s)] = dest; c.mvReady[s] = ready; c.mvNP[mvtM(s)] = profile; c.mvSteer[mvtS(s * SIM_STEER_W + SIM_ST_STEADY)] = 0;
    // (1: a worker at its task, which stands where the way ends; 2: one the
    // player sent, handed back there.)
    c.mvWk[s] = isWorker === 2 || isWorker === 3 ? isWorker : (isWorker ? 1 : 0);
    c.mvSpent[s] = 0;
    c.mvOn[mvtM(s)] = 1;
    return true;
}

// A group's move done where the unit stands (an order given at its
// destination, main.js): idle, nothing issued. An attack-mover short of its
// attack-move tile keeps it: the controller (mv.rs ctl, its idle rule) goes
// on there as an individual.
function simFlowArrive(u) {
    let keep = false;
    if (u.commandState === CMD_ATTACK_MOVING && u._attackMoveGx != null && !u.holdPosition && !u.workerState) {
        const gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE);
        keep = !(gx === u._attackMoveGx && gy === u._attackMoveGy) && !(u._routeEnd >= 0 && gy * GRID_W + gx === u._routeEnd);
    }
    u._routeKey = null; u.path = null; u.pathIndex = 0; u._navLastD = -1;
    u._pendingPathTarget = null; u.pathIsFallbackAstar = false; u.targetPos = null;
    if (u.commandState === CMD_ATTACK_MOVING && !keep) { u._attackMoveGx = u._attackMoveGy = null; }
    u.commandState = CMD_IDLE;
}

// A worker after its event on its way (a nav node next): armed in flow mode
// toward the node's tile (the columns SIM_KERNEL_MOVE works from); waiting for
// its way (a pending target): parked till its look. (Every other unit is the
// controller's, mv.rs ctl.)
function simMoveTryArm(u) {
    const c = u._us;
    if (!c || u.dead || u.holdPosition) return;
    const cmd = u.commandState;
    if (cmd !== CMD_MOVING && cmd !== CMD_ATTACK_MOVING) return;
    if ((!u.path || u.pathIndex >= u.path.length) && u._pendingPathTarget) { simMoveTryParkWait(u, cmd); return; }
    const nd = u.path && u.pathIndex < u.path.length ? u.path[u.pathIndex] : null;
    if (!(nd && nd.nav) || u._spatialEpoch !== spatialEpoch) return;
    const s = u._si, profile = nd.nav - 1, dest = nd.y * GRID_W + nd.x;
    if (Math.floor(c.y[s] * 0.125 / TILE) * GRID_W + Math.floor(c.x[s] * 0.125 / TILE) === dest) return;
    const did = navFieldRequest(profile, dest, !!nd.w);
    // (Arriving in a crowd short of the tile: groups only.)
    if (did >= 0) simFlowArm(c, s, did, navFieldGen(did), dest, cmd, profile === NAV_PROFILE_AIR, nd.ready | 0, !!u.workerState || !nd.w, _simWorkerKind(u), profile);
}

// The units standing on tile (gx, gy) when it became a wall (a tower's
// construction finished, a wall grown): pushed to the nearest tile they may
// stand on, in id order. Called as the wall table takes the change
// (simMoveTileTypeChanged; after the unit pass for changes made in it), so
// pushUnitOutOfBlockedTile sees the new wall.
function _simWallPushOut(gx, gy) {
    if (typeof forEachUnitInRange !== 'function' || !units || !units.length) return;
    const list = [];
    forEachUnitInRange(gx * TILE + TILE / 2, gy * TILE + TILE / 2, TILE * 1.5, u => {
        if (u.dead || u.isFlying) return;
        if (Math.floor(u.x / TILE) !== gx || Math.floor(u.y / TILE) !== gy) return;
        list.push(u);
    });
    if (!list.length) return;
    list.sort((a, b) => a.id - b.id);
    for (const u of list) {
        pushUnitOutOfBlockedTile(u);
        u.x = _quantizeUnitWorldCoord(u.x); u.y = _quantizeUnitWorldCoord(u.y);
        updateUnitSpatial(u);
    }
}

// The units on tiles that just became walls (list[0..n)): found by
// wasm/src/tch.rs k_wall_units (forEachUnitInRange's candidates, each tile's
// in id order), each pushed to the nearest tile it may stand on.
// (out: WPO_CAP (unit, tile) pairs, made once (_wpoReserve); a list whose
// units do not fit is taken in halves, each its units in order (the
// list is the caller's scratch: its second half moved to its start).)
const WPO_CAP = 65536;
const _wpo = { out: null, hdr: null, P: new Float64Array(8) };
function _wpoReserve() {
    const Z = _wpo;
    if (!Z.hdr || !simHeapHas(Z.hdr)) Z.hdr = simSharedArray(Int32Array, 2);
    if (!Z.out || Z.out.length < 2 * WPO_CAP || !simHeapHas(Z.out)) Z.out = simSharedArray(Int32Array, 2 * WPO_CAP);
}
function _simWallPushOutTiles(list, n) {
    const S = _simUnitState;
    if (!S || !units.length || !_sxOwners()) { for (let i = 0; i < n; i++) { const t = list[i], gx = t % GRID_W; _simWallPushOut(gx, (t - gx) / GRID_W); } return; }
    spatialIndexEnsure();
    const Z = _wpo, C = S.columns;
    _wpoReserve();
    {
        const P = Z.P;
        P[0] = n; P[1] = GRID_W; P[2] = TILE; P[3] = CHUNK_SIZE * TILE; P[4] = CHUNKS_W; P[5] = CHUNKS_H; P[6] = _sxEpoch; P[7] = Z.out.length >> 1;
        simRustDirect('k_wall_units', [list, _sxStamp, _sxStart, _sxCount, _sxESlot, C.x, C.y, C.dead, C.jFly, C.id, Z.out, Z.hdr], P);
        // (Full: maybe more units than it holds; the list in halves.)
        if (Z.hdr[0] >= (Z.out.length >> 1) && n > 1) { const h = n >> 1; _simWallPushOutTiles(list, h); list.copyWithin(0, h, n); _simWallPushOutTiles(list, n - h); return; }
    }
    for (let i = 0, m = Math.min(Z.hdr[0], Z.out.length >> 1); i < m; i++) {
        const u = S.owners.at(Z.out[2 * i + 1]);
        if (!u) continue;
        pushUnitOutOfBlockedTile(u);
        u.x = _quantizeUnitWorldCoord(u.x); u.y = _quantizeUnitWorldCoord(u.y);
        updateUnitSpatial(u);
    }
}
// An idle combat unit with nothing in reach parks too: the kernel checks its
// floor and its aggro box (hostile units or structures there: back to
// Unit.update, which engages) each tick, and wakes it every
// SIM_IDLE_PARK_TICKS for its periodic checks, at its own phase of them
// ((tick + id) % SIM_IDLE_PARK_TICKS === 0): the units parked on one tick
// (a match's start) do not all wake on one later tick. (A safety net: the
// kernel hands a parked unit back for anything its update would act on;
// every 100 ticks cost ~1500 updates a tick with 150k idle units.)
const SIM_IDLE_PARK_TICKS = 1000;
// A unit waiting for its way (a pending target, no path: the helpers'
// answer, or a look again, at its retry tick): parked till then, so the
// simulation thread does nothing for it meanwhile (the kernel stands it,
// and hands an attack-mover back for what it would engage, as an idle one).
function simMoveTryParkWait(u, cmd) {
    const c = u._us, wake = u._astarBudgetRetryTick;
    if (!c || !(wake > gameTime + 1) || u.unitType === 'scout') return;
    const s = u._si;
    if (u._spatialEpoch !== spatialEpoch || c.sepKey[s] === SIM_SEP_ABSENT) return;
    // (Its looks as when it moves, simFlowArm: an attack-mover's aggro, a
    // shooter's drive-by.)
    let flags = 0, reach = 0;
    if (cmd === CMD_ATTACK_MOVING) {
        reach = c.mvReachA[s];
        if (reach === 255) return;
        flags = 16;
    } else if (c.mvShoot[s]) {
        reach = c.mvReachD[s];
        const area = c.spArea[s];
        if (reach === 255 || !(area >= 0)) return;
        _simMoveEnsureAreaBox(area, reach);
        flags = 1;
    }
    c.mvWake[s] = wake; c.mvFlags[mvtM(s)] = flags; c.mvReach[s] = reach;
    if (!u.workerState) c.mvWk[s] = 0;
    c.mvOn[mvtM(s)] = 2;
}
// A unit with orders to move waiting for its way (no path, a pending target
// of that order: the pending resolver, main.js, gives it one, and the path
// disarms it): Unit.update only ends the order when it stands near enough
// to the target (_isNearIssuedTarget), which the kernel checks (mvFlags 8,
// mvTgX / mvTgY / mvTgTol), and an attack-mover's looks (16). A fallback
// path's upgrade is the pending resolver's (main.js, on its due ticks). Not
// for a scout.
function simMoveTryParkRoute(u, cmd) {
    const c = u._us, pt = u._pendingPathTarget;
    if (!c || u.dead || !pt || pt.cmd !== cmd || (u.path && u.pathIndex < u.path.length) || u.unitType === 'scout' || u.workerState) return false;
    const s = u._si;
    if (u._spatialEpoch !== spatialEpoch || c.sepKey[s] === SIM_SEP_ABSENT) return false;
    const t = u.targetPos;
    if (!(t && Number.isFinite(t.x) && Number.isFinite(t.y))) return false;
    let flags = 8, reach = 0;
    if (cmd === CMD_ATTACK_MOVING) {
        reach = c.mvReachA[s];
        if (reach === 255) return false;
        flags |= 16;
    }
    let spd = Math.fround(u.preComputed.speed * _getUnitAstarSpeedMultiplier(u));
    if (u.frozen > 0) spd *= 0.5;
    if (u.sandy > 0) spd *= 0.5;
    c.mvTgX[s] = Number(t.x); c.mvTgY[s] = Number(t.y); c.mvTgTol[s] = Math.max(8, Math.min(TILE, Math.floor((Number(spd) || 1) * 2)));
    const P = SIM_IDLE_PARK_TICKS, ph = (((gameTime + (u.id | 0)) % P) + P) % P;
    c.mvWake[s] = gameTime + P - ph; c.mvFlags[mvtM(s)] = flags; c.mvReach[s] = reach; c.mvWk[s] = 0;
    c.mvOn[mvtM(s)] = 2;
    return true;
}
// A held unit with orders to move (hold keeps its orders, path and
// progress; followPath stands it): Unit.update only looks for what to shoot
// (a drive-by shooter: tryDriveByAttack) or to engage (an attack-mover:
// doAttackMoving's looks) and checks its floor. Parked with those looks, as
// a waiting one (simMoveTryParkWait); released (stop: hold off, disarmed),
// ordered again (the setters disarm) or woken at its own phase of
// SIM_IDLE_PARK_TICKS (a safety net). (Thousands of held movers ran a
// near-empty Unit.update every tick: ~9k a tick in the ACTIONS bench.)
function simMoveTryParkHeld(u, cmd) {
    const c = u._us;
    if (!c || u.dead || !u.holdPosition || u.workerState || u.unitType === 'scout') return;
    // (A way to keep: without one, its looks for a way and its arrival are
    // Unit.update's.)
    if (!u.path || !(u.pathIndex < u.path.length)) return;
    const s = u._si;
    if (u._spatialEpoch !== spatialEpoch || c.sepKey[s] === SIM_SEP_ABSENT) return;
    let flags = 0, reach = 0;
    if (cmd === CMD_ATTACK_MOVING) {
        reach = c.mvReachA[s];
        if (reach === 255) return;
        flags = 16;
    } else if (c.mvShoot[s]) {
        reach = c.mvReachD[s];
        const area = c.spArea[s];
        if (reach === 255 || !(area >= 0)) return;
        _simMoveEnsureAreaBox(area, reach);
        flags = 1;
    }
    const P = SIM_IDLE_PARK_TICKS, ph = (((gameTime + (u.id | 0)) % P) + P) % P;
    c.mvWake[s] = gameTime + P - ph; c.mvFlags[mvtM(s)] = flags; c.mvReach[s] = reach; c.mvWk[s] = 0;
    c.mvOn[mvtM(s)] = 2;
}
// A worker at its work (its path done, nothing pending) whose transfer
// cooldown runs: Unit.update only stands it there until the cooldown runs
// out (updateWorkerAI; the status pre-pass counts it down), so it is parked
// until that tick.
function simMoveTryParkWork(u) {
    const c = u._us;
    if (!c || u.dead || u.holdPosition || u.workerState === 'MANUAL_MOVE' || !(u.workerTransferCooldown > 0)) return;
    if ((u.path && u.pathIndex < u.path.length) || u._pendingPathTarget) return;
    const s = u._si;
    if (u._spatialEpoch !== spatialEpoch || c.sepKey[s] === SIM_SEP_ABSENT) return;
    c.mvWake[s] = gameTime + Math.ceil(u.workerTransferCooldown); c.mvFlags[mvtM(s)] = 0;
    c.mvOn[mvtM(s)] = 2;
}
// A tick bound for an Int32 column the kernels compare as t < bound: the
// same answer for every integer tick t (NaN: never, Infinity: always).
function _simTickBound(v) { return v === v ? (v >= 2147483647 ? 2147483647 : v <= -2147483648 ? -2147483648 : Math.ceil(v)) : -2147483648; }
function simMoveTryPark(u) {
    const c = u._us;
    if (!c || u.dead || u.holdPosition || u.workerTransferCooldown > 0) return;
    const s = u._si;
    if (u._spatialEpoch !== spatialEpoch || c.sepKey[s] === SIM_SEP_ABSENT) return;
    // Registered with the search tier (worker.js wsRegister): parked till the
    // tier hands it its work; only a builder's watchdog sample (pushed away)
    // or its recheck (with a target) wakes it.
    if (c.wsKind[s] && typeof _wsRegistered === 'function' && _wsRegistered(u)) {
        const watchStill = u.workerType === 'builder' && Number.isFinite(u._builderLastWatchX) && Number.isFinite(u._builderLastWatchY)
            && u._builderLastWatchX === c.x[s] * 0.125 && u._builderLastWatchY === c.y[s] * 0.125;
        let wake = gameTime + 0x3fffffff;
        if (u.workerType === 'builder') {
            if (u.workerTarget && Number.isFinite(u._builderNextRecheckTick) && u._builderNextRecheckTick < wake) wake = u._builderNextRecheckTick;
        }
        if (!(wake > gameTime + 1)) return;
        // (A builder's watchdog samples: the kernel's, mvFlags 4.)
        c.mvWake[s] = wake; c.mvFlags[mvtM(s)] = u.workerType === 'builder' && Number.isFinite(u._builderLastWatchX) && Number.isFinite(u._builderLastWatchY) ? 4 : 0;
        void watchStill;
        c.mvOn[mvtM(s)] = 2;
        return;
    }
    const next = u._workerNextIdleRetargetTick;
    if (!Number.isFinite(next)) return;
    // (A collector with no idle start yet sets it on its next update: not parked.)
    if (isResourceCollectorWorkerType(u.workerType) && !u._lastIdleStateTime) return;
    const id = u.id, delay = Math.max(1, Math.floor(Number(WORKER_AI_TICK_DELAY) || 1));
    const per = Math.ceil(getWorkerIdleSearchTicks() / delay);
    // (A builder's watchdog samples change nothing while it stands where
    // the last one was taken: the kernel wakes it at a sample tick only when
    // it was pushed away, mvFlags 4.)
    const watchStill = u.workerType === 'builder' && Number.isFinite(u._builderLastWatchX) && Number.isFinite(u._builderLastWatchY)
        && u._builderLastWatchX === c.x[s] * 0.125 && u._builderLastWatchY === c.y[s] * 0.125;
    // Its next wake for anything but a search: its scheduled search (none
    // while a failed search's backoff runs: its end wakes it), a builder's
    // recheck (with a target) and watchdog sample, its search origin
    // changing.
    const failVer = u._idleFailVer, failUntil = u._idleFailUntil;
    // (A collector that has no idle start yet sets it on its next update.)
    const backoff = workerIdleBackoff(u, gameTime + 1)
        && !(isResourceCollectorWorkerType(u.workerType) && !u._lastIdleStateTime);
    // (In a backoff its scheduled search comes at the backoff's end, if not
    // due later: shouldRunWorkerIdleRetarget's schedule.)
    let sched = backoff ? Math.max(next, failUntil) : next;
    const originUntil = _workerWorkOriginUntil(u);
    if (originUntil < sched) sched = originUntil;
    if (u.workerType === 'builder') {
        if (u.workerTarget && Number.isFinite(u._builderNextRecheckTick) && u._builderNextRecheckTick < sched) sched = u._builderNextRecheckTick;
    }
    // Then its periodic search tick (see shouldRunWorkerIdleRetarget).
    let wake = sched;
    for (let t = gameTime + 1; t < wake; t++) {
        if (((t + id) % delay) === 0 && (Math.floor((t + id) / delay) % per) === 0) { wake = t; break; }
    }
    if (!(wake > gameTime + 1)) return;
    c.mvWake[s] = wake; c.mvFlags[mvtM(s)] = u.workerType === 'builder' && Number.isFinite(u._builderLastWatchX) && Number.isFinite(u._builderLastWatchY) ? 4 : 0;
    void watchStill;
    // Its search ticks while nothing changed (its last search failed at work
    // version wkFail, until wkUntil): the kernel checks the version and keeps
    // it parked (shouldRunWorkerIdleRetarget would return at once).
    if (backoff) {
        const org = _workerWorkOrigin(u);
        const w = simUnitWk(c, s);
        c.wkType[w] = _workerWorkType(u.workerType); c.wkD[w] = Math.ceil(_getWorkerAutoSearchDistancePx(u) / TILE) + 1;
        c.wkOx[w] = Math.floor(org.x / TILE); c.wkOy[w] = Math.floor(org.y / TILE);
        c.wkTwice[w] = org !== u ? 1 : 0;
        c.wkFail[w] = failVer | 0; c.wkUntil[w] = _simTickBound(failUntil); c.wkSched[w] = _simTickBound(sched);
        c.mvFlags[mvtM(s)] |= 2;
    }
    c.mvOn[mvtM(s)] = 2;
}

// Drive-by boxes: per area and steps, the tile box of the areas within
// that many steps (getAreaRangeTileBox), for the kernel. Reset with the area
// layout.
const SIM_MOVE_BOX_STEPS = 9;
let _simMoveAreaBox = null, _simMoveAreaBoxOk = null, _simMoveAreaBoxFor = null;
// (Set when the table is made anew: simMoveRun makes the boxes of the armed
// shooters again, once.)
let _simMoveAreaBoxesNew = true;
function _simMoveAreaBoxes() {
    const A = Math.max(1, areaNeighborIds ? areaNeighborIds.length : 0);
    if (_simMoveAreaBoxFor !== areaNeighborIds || !_simMoveAreaBoxOk || _simMoveAreaBoxOk.length !== A * SIM_MOVE_BOX_STEPS) {
        _simMoveAreaBoxesNew = true;
        _simMoveAreaBox = simHeapArrayAuto(Int32Array, A * SIM_MOVE_BOX_STEPS * 4);
        _simMoveAreaBoxOk = simHeapArrayAuto(Uint8Array, A * SIM_MOVE_BOX_STEPS);
        _simMoveAreaBoxFor = areaNeighborIds;
        simParallelBind('mv.areaBox', _simMoveAreaBox); simParallelBind('mv.areaBoxOk', _simMoveAreaBoxOk);
        _simAreaBoxJob = { layout: areaNeighborIds, out: null };
    }
    if (_simAreaBoxJob) _simAreaBoxStep();
}
// Every area's boxes at every distance, made on the helpers for a new layout
// (SIM_KERNEL_AREA_BOX, lane SIM_LANE_BUILD) and taken whole when done: an
// army's first order, or its march into new ground, made each area's box at
// once in the tick (a 56k-unit order: ~100 ms). Until then a box is made
// when first needed, the same box. (Without helpers: made at once.)
let _simAreaBoxJob = null;
function _simAreaBoxStep() {
    const J = _simAreaBoxJob, lane = typeof SIM_LANE_BUILD === 'number' ? SIM_LANE_BUILD : -1;
    if (J.layout !== areaNeighborIds || lane < 0 || typeof SIM_KERNEL_AREA_BOX !== 'number') { _simAreaBoxJob = null; return; }
    const D = SIM_MOVE_BOX_STEPS, A = _simMoveAreaBoxOk.length / D;
    if (!J.out) {
        if (simParallelBackgroundPending(lane)) return;
        _simAreaCsr();
        const own = simHeapArrayAuto(Int32Array, A * 4), out = simHeapArrayAuto(Int32Array, A * D * 4);
        for (let a = 0; a < A; a++) {
            const ar = _areaById[a], o = a * 4;
            if (ar) { own[o] = ar.minGx; own[o + 1] = ar.minGy; own[o + 2] = ar.maxGx; own[o + 3] = ar.maxGy; }
            else { own[o] = 1; own[o + 1] = 1; own[o + 2] = 0; own[o + 3] = 0; }
        }
        simParallelBind('abox.own', own); simParallelBind('abox.out', out);
        simParallelBind('abox.off', _simParReg['area.off']); simParallelBind('abox.nb', _simParReg['area.nb']);
        const stages = [];
        for (let d = 0; d < D; d++) {
            const P = simParallelStageParams(lane, d);
            P.fill(0); P[0] = A; P[1] = 4096; P[2] = D; P[3] = d;
            stages.push([SIM_KERNEL_AREA_BOX, Math.ceil(A / 4096)]);
        }
        J.out = out;
        simParallelBackgroundChain(lane, stages, true);
    }
    if (simParallelBackgroundPending(lane) && !simParallelBackgroundDone(lane)) return;
    simParallelBackgroundWait(lane);
    // (The same layout as the table's: k = area * D + distance.)
    _simMoveAreaBox = J.out;
    simParallelBind('mv.areaBox', _simMoveAreaBox);
    _simMoveAreaBoxOk.fill(1);
    _simAreaBoxJob = null;
}
// An area's box at a distance from the table (getAreaRangeTileBox's row
// format: an empty box as [GRID_W, GRID_H, -1, -1]) when the table holds it
// for the current layout; else nothing written.
function simMoveAreaBoxRead(area, steps, out, o) {
    if (_simMoveAreaBoxFor !== areaNeighborIds || !_simMoveAreaBoxOk || !(steps >= 0 && steps < SIM_MOVE_BOX_STEPS)) return;
    const k = area * SIM_MOVE_BOX_STEPS + steps;
    if (!(k >= 0 && k < _simMoveAreaBoxOk.length) || !_simMoveAreaBoxOk[k]) return;
    const B = _simMoveAreaBox, b = k * 4;
    if (B[b] > B[b + 2]) { out[o] = GRID_W; out[o + 1] = GRID_H; out[o + 2] = -1; out[o + 3] = -1; return; }
    out[o] = B[b]; out[o + 1] = B[b + 1]; out[o + 2] = B[b + 2]; out[o + 3] = B[b + 3];
}
function _simMoveEnsureAreaBox(area, steps) {
    _simMoveAreaBoxes();
    const k = area * SIM_MOVE_BOX_STEPS + steps;
    if (!(k >= 0 && k < _simMoveAreaBoxOk.length) || _simMoveAreaBoxOk[k]) return;
    _simMoveAreaSource[0] = area;
    const box = getAreaRangeTileBox(_simMoveAreaSource, steps);
    // No area in reach: an empty box (nothing can be possible there).
    if (box[2] < 0) { _simMoveAreaBox[k * 4] = 1; _simMoveAreaBox[k * 4 + 1] = 1; _simMoveAreaBox[k * 4 + 2] = 0; _simMoveAreaBox[k * 4 + 3] = 0; }
    else for (let j = 0; j < 4; j++) _simMoveAreaBox[k * 4 + j] = box[j];
    _simMoveAreaBoxOk[k] = 1;
}

// Walls per tile (grid type TYPE_WALL), kept in step where tile types
// change (simMoveTileTypeChanged) and rebuilt with the grid.
let _simMoveWall = null, _simMoveWallGrid = null, _simMoveWallDirty = true;
// Per 8x8 tile block, a count of its wall changes (the kernel's cached
// flow look-aheads depend on the walls within 8 tiles: keyed by the sum
// over the 3x3 blocks around the unit's tile).
let _simMoveWallBlk = null, _simMoveWallBlkW = 0;
// Bumped whenever a wall changes (the kernel's cached look-aheads check it).
let _simMoveWallVer = 0;
// (Counts the runs that write a wall table (mv.wall, the class walls, mv.wallBlk): the tile changes' kernel and the
// whole rebuild. A snapshot taken at one count is good until the next: _flowWallSnap.)
let _simWallsEpoch = 0;
// During the unit pass the wall table stands still (the kernel and every
// Unit.update see the walls of the pass's start): tile type changes are
// applied at its end, in order. (Holds and chases check _simMoveWallQNear.)

// The tiles changed so far this pass (stamped with the pass's number): a
// kernel hold or chase at its turn stands unless one is within a tile of
// where the unit started or ended up. Its decisions read the walls of the
// pass's start (simMoveWallGrid: the same as the kernel's); only the end of
// Unit.update reads its own tile live (pushUnitOutOfBlockedTile). Any change
// anywhere sent every later hold and chase through Unit.update: towers
// falling in a battle, ~9k units a tick at 200k.
let _simMoveWallQT = null, _simMoveWallQGen = 0;
function _simMoveWallQMark(gx, gy) {
    const n = GRID_W * GRID_H;
    if (!_simMoveWallQT || _simMoveWallQT.length !== n) { _simMoveWallQT = new Uint8Array(n); _simMoveWallQGen = 0; }
    if (_simMoveWallQN === 1) { if (++_simMoveWallQGen > 255) { _simMoveWallQT.fill(0); _simMoveWallQGen = 1; } }
    if (gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H) _simMoveWallQT[gy * GRID_W + gx] = _simMoveWallQGen;
}
let _simMoveWallQKept = 0;
function _simMoveWallQNear(c, s) {
    const T = _simMoveWallQT, g = _simMoveWallQGen;
    if (!T) return true;
    _simMoveWallQKept++;
    const W = GRID_W, H = GRID_H;
    for (let pass = 0; pass < 2; pass++) {
        const gx = Math.floor((pass ? c.x[s] : c.prevX[s]) * 0.125 / TILE), gy = Math.floor((pass ? c.y[s] : c.prevY[s]) * 0.125 / TILE);
        if (!(gx >= 0 && gy >= 0 && gx < W && gy < H)) return true;
        for (let y = gy - 1; y <= gy + 1; y++) {
            if (y < 0 || y >= H) continue;
            for (let x = gx - 1; x <= gx + 1; x++) if (x >= 0 && x < W && T[y * W + x] === g) { _simMoveWallQKept--; return true; }
        }
    }
    return false;
}
function simMoveWallsDeferEnd() {
    _simMoveWallQN = 0;
    simTileChangesFlush();
}
// Tile changes for the walk tables (the ground walls, step costs, walk
// classes' walls, the navigation's diff counts): queued as t * 2 + kind (0
// its cell type, 1 its tile entity only), applied in a batch by
// wasm/src/tch.rs k_tile_changes in their order: during the unit pass at its
// end (the pass sees the walls of its start), else at once
// (simTileChangesFlush). Tiles that became walls push their units off.
// (Each (tile, kind) once in the queue (mark: its kinds queued): at most two
// entries a tile, the list and its new walls made for that at the match's
// start, simTileChangesReserve. A change queued twice applied once: the
// kernel reads the tile as it is then.)
const _tch = { list: null, n: 0, hdr: null, nw: null, tabN: null, tabC: null, mark: null, P: new Float64Array(10) };
function simTileChangesReserve() {
    const T = _tch, tiles = GRID_W * GRID_H;
    if (!T.list || T.list.length < 2 * tiles || !simHeapHas(T.list)) { const a = simSharedArray(Int32Array, 2 * tiles); if (T.list && T.n) a.set(T.list.subarray(0, T.n)); T.list = a; }
    if (!T.nw || T.nw.length < tiles || !simHeapHas(T.nw)) T.nw = simSharedArray(Int32Array, tiles);
    if (!T.hdr || !simHeapHas(T.hdr)) { T.hdr = simSharedArray(Int32Array, 4); T.tabN = simSharedArray(Int32Array, 32); T.tabC = simSharedArray(Int32Array, 32); }
    if (!T.mark || T.mark.length !== tiles) { T.mark = new Uint8Array(tiles); for (let i = 0; i < T.n; i++) T.mark[T.list[i] >> 1] |= 1 << (T.list[i] & 1); }
    _wpoReserve();
}
function _tchAdd(t, kind) {
    const T = _tch;
    if (!T.mark || T.mark.length !== GRID_W * GRID_H || !T.list || T.list.length < 2 * GRID_W * GRID_H || !simHeapHas(T.list)) simTileChangesReserve();
    if (T.mark[t] & (1 << kind)) return;
    T.mark[t] |= 1 << kind;
    T.list[T.n++] = t * 2 + kind;
}
function simTileChangesFlush() {
    if (_unitPassOn) return;
    const T = _tch, n = T.n;
    if (n === 0) return;
    // (The walls and their versions change: the flow looks' prewarm reading them done first.)
    if (typeof tickStartChainSettle === 'function') tickStartChainSettle();
    T.n = 0;
    if (T.mark) for (let i = 0; i < n; i++) T.mark[T.list[i] >> 1] = 0;
    if (!_simMoveWall || _simMoveWallGrid !== grid || _simMoveWall.length !== GRID_W * GRID_H || !_simMoveWallBlk || !simHeapHas(_simMoveWall) || !simHeapHas(_simMoveWallBlk)) { _simMoveWallDirty = true; return; }
    if (!T.hdr || !simHeapHas(T.hdr) || !T.nw || T.nw.length < GRID_W * GRID_H || !simHeapHas(T.nw)) simTileChangesReserve();
    const diff = navTileTables(T.tabN, T.tabC);
    const b9 = _simMoveWallBlk9 && simHeapHas(_simMoveWallBlk9) ? _simMoveWallBlk9 : null;
    const b81 = b9 && _simMoveWallBlk81 && simHeapHas(_simMoveWallBlk81) && _simMoveWallBlk81.length === b9.length ? _simMoveWallBlk81 : null;
    if (!simHeapHas(_ST.code)) structTablesRehome();
    const P = T.P;
    P[0] = n; P[1] = GRID_W; P[2] = GRID_H; P[3] = TYPE_WALL; P[4] = NAV_PROFILES; P[5] = NAV_PROFILE_BUILD; P[6] = NAV_PROFILE_BUILD;
    P[7] = _simMoveWallBlkW; P[8] = 0x66; P[9] = 0x77;
    _simWallsEpoch = (_simWallsEpoch + 1) | 0;
    simRustDirect('k_tile_changes', [T.list, cellType, _simMoveWall, _simMoveWallBlk, b9, null, diff, T.tabN, T.tabC, _ST.code, _ST.own, _ST.val, T.hdr, T.nw, b81], P);
    _simMoveWallVer = (_simMoveWallVer + T.hdr[0]) | 0;
    if (_simMoveWallBlk9 && (!b9 || !b81)) _simMoveWallBlk9All();
    if (navTileTablesRedo()) { _simMoveWallDirty = true; return; }
    // (A new wall: whoever stands there steps off it.)
    if (T.hdr[1] > 0) _simWallPushOutTiles(T.nw, T.hdr[1]);
}
// The walk classes' walls at tile k (its tile entity changed).
function _simMoveClassTileChanged(k) {
    if (!(k >= 0 && k < GRID_W * GRID_H)) return;
    _tchAdd(k, 1);
    simTileChangesFlush();
}
// Tile (gx, gy)'s cell type changed. (hold: the caller flushes, a batch's.)
let _simMoveWallQN = 0;
function simMoveTileTypeChanged(gx, gy, hold = false) {
    if (!(gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H)) return;
    if (typeof laserWallChanged === 'function') laserWallChanged(gx, gy);
    _tchAdd(gy * GRID_W + gx, 0);
    if (_unitPassOn) { _simMoveWallQN++; _simMoveWallQMark(gx, gy); return; }
    if (!hold) simTileChangesFlush();
}
// Per 8x8 block, the sum of its 3x3 blocks' wall change counts (simWallKey's
// value, the kernel's one read: simWallKey9).
let _simMoveWallBlk9 = null;
// (And over 11x11 blocks: the shared looks' key, mv.rs W_WBLK81; kept with the 3x3 sums by k_tile_changes.)
let _simMoveWallBlk81 = null;
function _simMoveWallBlk9All() {
    const W = _simMoveWallBlkW, H = (GRID_H + 7) >> 3, B = _simMoveWallBlk;
    if (!_simMoveWallBlk9 || _simMoveWallBlk9.length !== B.length) { _simMoveWallBlk9 = simHeapArrayAuto(Int32Array, B.length); simParallelBind('mv.wallBlk9', _simMoveWallBlk9); }
    for (let by = 0; by < H; by++) for (let bx = 0; bx < W; bx++) _simMoveWallBlk9[by * W + bx] = simWallKey(B, W, H, bx * 8, by * 8, 0);
    if (!_simMoveWallBlk81 || _simMoveWallBlk81.length !== B.length) { _simMoveWallBlk81 = simHeapArrayAuto(Int32Array, B.length); simParallelBind('mv.wallBlk81', _simMoveWallBlk81); }
    for (let by = 0; by < H; by++) for (let bx = 0; bx < W; bx++) {
        let v = 0;
        for (let y = Math.max(0, by - 5); y <= Math.min(H - 1, by + 5); y++) for (let x = Math.max(0, bx - 5); x <= Math.min(W - 1, bx + 5); x++) v = (v + B[y * W + x]) | 0;
        _simMoveWallBlk81[by * W + bx] = v;
    }
    // (The shared looks keyed by these sums from now: none kept from before, keyed otherwise.)
    if (typeof simMoveLookCacheClear === 'function') simMoveLookCacheClear();
}
function simMoveWallsDirty() { _simMoveWallDirty = true; }
// The wall table, current (1: grid type TYPE_WALL).
const _simWallsP = new Float64Array(4);
function simMoveWallGrid() { _simMoveWalls(); return _simMoveWall; }
function _simMoveWalls() {
    if (!_simMoveWallDirty && _simMoveWallGrid === grid && _simMoveWall && _simMoveWall.length === GRID_W * GRID_H) return;
    // (The flow looks' prewarm reads the walls: done first.)
    if (typeof tickStartChainSettle === 'function') tickStartChainSettle();
    if (!_simMoveWall || _simMoveWall.length !== GRID_W * GRID_H) { const old = _simMoveWall; _simMoveWall = simHeapArray(Uint8Array, GRID_W * GRID_H); simParallelBind('mv.wall', _simMoveWall); simHeapFree(old); }
    // (From the cell types: tch.rs k_walls_from_types.)
    if (!simHeapHas(cellType) && typeof cellColumnsRehome === 'function') cellColumnsRehome();
    _simWallsP[0] = GRID_W * GRID_H; _simWallsP[1] = TYPE_WALL;
    _simWallsEpoch = (_simWallsEpoch + 1) | 0;
    simRustDirect('k_walls_from_types', [cellType, _simMoveWall], _simWallsP);
    _simMoveWallGrid = grid; _simMoveWallDirty = false; _simMoveWallVer = (_simMoveWallVer + 1) | 0;
    simMoveLookCacheClear();
    // (Every block's version moves on: the look-aheads cached anywhere are
    // made again.)
    _simMoveWallBlkW = (GRID_W + 7) >> 3;
    const nb = _simMoveWallBlkW * ((GRID_H + 7) >> 3);
    if (!_simMoveWallBlk || _simMoveWallBlk.length !== nb) { _simMoveWallBlk = simSharedArray(Int32Array, nb); simParallelBind('mv.wallBlk', _simMoveWallBlk); }
    for (let i = 0; i < nb; i++) _simMoveWallBlk[i]++;
    _simMoveWallBlk9All();
    if (typeof _navWallDiffReset === 'function') _navWallDiffReset();
    if (typeof navClassReset === 'function') navClassReset();
}

// Structures by tile, for "hostile to player p?" without the tables of
// every player: -1 none, p when owned by p alone (the structure and its
// cell), -2 otherwise (hostile to everyone). Mines count as none. Tiles
// whose tile entity changed are redone at the next kernel run; per block
// and player, the count of structures hostile to that player.
// (The tables' dimensions as four numbers: a string made for the comparison was an allocation a call, a tower's every shot.)
let _simMoveStruct = null, _simMoveStructBlocks = null, _simMoveStructSet = null, _simMoveStructW = -1, _simMoveStructH = -1, _simMoveStructP = -1, _simMoveStructC = -1;
// (And by class, for the acquisition tier's structure look: _simStructClass.)
let _simStructCls = null;
// 0 none (or a mine), 1 turret, 2 trap, 3 barrack or spawner, 4 any other
// building (a cell item), 5 a cloud tower: the order
// _findAutoStructureTarget takes them in (cloud towers with the turrets;
// the drive-by look ranks them with the buildings).
// (The tiles whose structure changed since: a heap list; full: all again.)
let _simMoveStructDirty = null, _simMoveStructDirtyN = 0;
// (Counts the writes of mv.struct / mv.scls: here and the destroy kernel's, things_utils.js. A copy made at one count
// is good until the next: _acqPost.)
let _simMoveStructVer = 0;
// Cell owners replaced (a restore): every tile's code again.
function simMoveStructsReset() { _simMoveStructW = -1; }
function simMoveTileEntityChanged(gx, gy) {
    if (_simMoveStruct) { if (!_simMoveStructDirty || !simHeapHas(_simMoveStructDirty)) { _simMoveStructDirty = simHeapArrayAuto(Int32Array, 65536); _simMoveStructDirtyN = 0; } if (_simMoveStructDirtyN < _simMoveStructDirty.length) _simMoveStructDirty[_simMoveStructDirtyN++] = gy * GRID_W + gx; else _simMoveStructW = -1; }
    // (The walk classes' walls: a builder's own buildings, active mines; at
    // the unit pass's end when in it, as the walls.)
    if (gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H) _simMoveClassTileChanged(gy * GRID_W + gx);
}
// The movement kernel's structure tables from the tile table (tch.rs
// k_move_structs): per tile its code (mv.struct: -1 none or a mine, the
// owner when its cell's owner too, -2 otherwise), its class (mv.scls: 1 a
// tower, 5 a cloud tower, 3 a barrack or spawner, 2 a floor trap, 4 another
// floor item), per spatial block the structures hostile to each player
// (mv.stblk); whole when the layout is new, else the changed tiles'.
const _simMoveStructsP = new Float64Array(8);
let _simStructTyCls = null, _simStructTyClsN = -1;
function _simMoveStructs() {
    const players = spatialUnitsComplexPlayerCount;
    const full = !_simMoveStruct || _simMoveStructSet !== _activeTileEntities || _simMoveStructW !== GRID_W || _simMoveStructH !== GRID_H || _simMoveStructP !== players || _simMoveStructC !== spatialBlockCols;
    if (!full && _simMoveStructDirtyN === 0) { _simTrapStep(); return; }
    // (It writes the block table the tick's chain reads: its hostile stages done first.)
    if (typeof tickStartChainSettleHostile === 'function') tickStartChainSettleHostile();
    if (full) {
        if (!_simMoveStruct || _simMoveStruct.length !== GRID_W * GRID_H) { _simMoveStruct = simHeapArrayAuto(Int8Array, GRID_W * GRID_H); simParallelBind('mv.struct', _simMoveStruct); }
        if (!_simStructCls || _simStructCls.length !== GRID_W * GRID_H) { _simStructCls = simHeapArrayAuto(Int8Array, GRID_W * GRID_H); simParallelBind('mv.scls', _simStructCls); }
        _simTrapAlloc();
        _simMoveStructBlocks = simHeapArrayAuto(Int32Array, spatialBlockCols * spatialBlockRows * players);
        _simMoveStructBlocks.fill(0);
    }
    // (Per stationary type: its trap kind, 8 a cloud tower.)
    const K = _simTrapKinds(), nty = _stationaryTypes.length;
    if (_simStructTyClsN !== nty || !_simStructTyCls || !simHeapHas(_simStructTyCls)) {
        _simStructTyCls = simHeapArrayAuto(Uint8Array, Math.max(64, nty));
        for (let ty = 0; ty < nty; ty++) _simStructTyCls[ty] = (K[ty] > 0 ? 1 : 0) | (String(_stationaryTypes[ty] || '').startsWith('cloud') ? 8 : 0);
        _simStructTyClsN = nty;
    }
    const T = _ST;
    if (T.code && !simHeapHas(T.code)) structTablesRehome();
    const ok = T.code && T.n === GRID_W * GRID_H, P = _simMoveStructsP;
    P[0] = full ? GRID_W * GRID_H : _simMoveStructDirtyN; P[1] = GRID_W; P[2] = spatialBlockCols; P[3] = players; P[4] = SPATIAL_BLOCK_SIZE * CHUNK_SIZE; P[5] = nty; P[6] = full ? 1 : 0; P[7] = GRID_W * GRID_H;
    _simMoveStructVer = (_simMoveStructVer + 1) | 0;
    simRustDirect('k_move_structs', [ok ? T.code : null, ok ? T.own : null, cellOwner, ok ? T.brain : null, _simStructTyCls, _simMoveStruct, _simStructCls, _simMoveStructBlocks, full ? null : _simMoveStructDirty, _trap.dirty, _trap.hdr], P);
    // (The changed tiles' traps looked at again, as simTrapDirty.)
    if (full) { _simMoveStructSet = _activeTileEntities; _simMoveStructW = GRID_W; _simMoveStructH = GRID_H; _simMoveStructP = players; _simMoveStructC = spatialBlockCols; }
    else { for (let i = 0; i < _simMoveStructDirtyN; i++) { if (_trap.nd < _trap.dirty.length) _trap.dirty[_trap.nd++] = _simMoveStructDirty[i]; else _trap.all = true; } }
    _simMoveStructDirtyN = 0;
    if (!full) _simTrapStep();
}

// Floor traps for the movement kernel (mv.rs floor_hit): per tile the trap
// a unit hostile to its owner meets there (mv.trapK: 0 none or not built, 1
// fire, 2 poison, 3 ice, 4 water, 5 sand, 6 a mine: Unit.update's) and its
// level (mv.trapL), redone with its tile's structure, at construction's end
// and level changes (simTrapDirty). The strength (status ticks mv.trapT,
// damage per tick mv.trapTG) per owner, kind and level: a mirror of the
// owner's PRECOMPUTED_STATS_MAP_PLAYER entries (per thing and level, with
// its research), made again for an owner when its building stats are
// rebuilt (simTrapResearchDone): no trap tile is visited then. Per unit type
// its resistances (mv.tres by simUnitTypeIndex, bit kind - 1).
let _simTrapK = null, _simTrapL = null, _simTrapT = null, _simTrapTG = null, _simTrapRes = null, _simTrapResN = 0;
const _simTrapOwnersDirty = new Set();
let _simTrapTPlayers = 0, _simTrapTLevels = 0;
const SIM_TRAP_KIND = { lava: [1, 'fire'], poison_puddle: [2, 'poison'], ice_patch: [3, 'ice'], water_puddle: [4, 'water'], sand: [5, 'sand'], mine: [6, ''] };
const SIM_TRAP_TYPE_OF = [null, 'lava', 'poison_puddle', 'ice_patch', 'water_puddle', 'sand'];
const SIM_TRAP_STAT = [null, ['burnDuration', 'burnDps'], ['poisonDuration', 'poisonDps'], ['freezeDuration', 'freezeDps'], ['wetDuration', null], ['sandDuration', null]];
// The trap tiles (tfx.rs k_trap_tiles, from the per-tile structure table):
// their kinds and levels (mv.trapK / mv.trapL), the list of kinds 1-5
// (tfx.traps; any order: a trap's status is the
// larger of the old and its own) the tile effects' pass walks; the tiles to
// look at again (tfx.dirty: construction's end, level changes, placements,
// removals: simTrapDirty; all after a reset); per stationary type its trap
// kind (tfx.tkind).
const _trap = { dirty: null, nd: 0, all: true, list: null, idx: null, hdr: null, tkind: null, tkindN: -1 };
function _simTrapAlloc() {
    const N = GRID_W * GRID_H;
    if (!_simTrapK || _simTrapK.length !== N) {
        _simTrapK = simHeapArrayAuto(Uint8Array, N); _simTrapL = simHeapArrayAuto(Uint8Array, N);
        simParallelBind('mv.trapK', _simTrapK); simParallelBind('mv.trapL', _simTrapL);
        _trap.list = simHeapArrayAuto(Int32Array, 65536);
        _trap.dirty = simHeapArrayAuto(Int32Array, 65536); _trap.hdr = simHeapArrayAuto(Int32Array, 4);
    }
    _simTrapK.fill(0); _simTrapL.fill(0);
    _trap.hdr[0] = 0; _trap.hdr[1] = _trap.list.length; _trap.hdr[2] = 0; _trap.nd = 0; _trap.all = true;
    _simTrapOwnersDirty.add(-1);
}
// Units on the trap tiles (this tick's index): the most that take a status
// record in the tile effects' pass (tfx.rs k_trap_bound).
function _simTrapUnitsBound() {
    if (!_simTrapK || !_trap.hdr || !_trap.hdr[0] || !_sxBySlot || !_sxPar) return 0;
    const P = _trapP;
    P[0] = _trap.hdr[0]; P[1] = _sxEpoch;
    simRustDirect('k_trap_bound', [_trap.list, _sxPar.stamp, _sxPar.cnt, _trap.hdr], P);
    return _trap.hdr[3];
}
const _trapP = new Float64Array(8);
function simTrapDirty(gx, gy) {
    if (!_simTrapK || !(gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H)) return;
    if (_trap.nd < _trap.dirty.length) _trap.dirty[_trap.nd++] = gy * GRID_W + gx; else _trap.all = true;
}
function simTrapResearchDone(owner) { _simTrapOwnersDirty.add(Number.isInteger(owner) ? owner : -1); }
// Per stationary type its trap kind (made again as types appear).
function _simTrapKinds() {
    const n = _stationaryTypes.length;
    if (_trap.tkind && _trap.tkindN === n && simHeapHas(_trap.tkind)) return _trap.tkind;
    const K = _trap.tkind = simHeapArrayAuto(Uint8Array, Math.max(64, n));
    for (let ty = 0; ty < n; ty++) { const s = SIM_TRAP_KIND[_stationaryTypes[ty]]; K[ty] = s ? s[0] : 0; }
    _trap.tkindN = n;
    return K;
}
// The trap tiles and tables for the tile effects' pass (null: none kept).
function simTrapTiles() {
    if (!_simTrapK || !_trap.list) return null;
    _simTrapStep();
    return { n: _trap.hdr[0], list: _trap.list, k: _simTrapK, l: _simTrapL, t: _simTrapT, tg: _simTrapTG, tres: _simTrapRes, players: _simTrapTPlayers, levels: _simTrapTLevels, types: _simTrapResN };
}
// One owner's strengths: kinds 1-5 at every level, from its precomputed
// stats map (the entries applyStatusEffect reads), the defaults where a stat
// has no value.
function _simTrapTableOwner(o) {
    const L = _simTrapTLevels, pm = PRECOMPUTED_STATS_MAP_PLAYER[o], bm = pm && pm.building;
    for (let k = 1; k <= 5; k++) {
        const type = SIM_TRAP_TYPE_OF[k], effect = SIM_TRAP_KIND[type][1], base = Number((BASE_CARD_TYPES[type] || {}).damage) || 1;
        const rows = bm ? bm[_normalizePlayerPrecomputedBuildingKey(type)] : null, dk = SIM_TRAP_STAT[k][0], gk = SIM_TRAP_STAT[k][1];
        for (let lvl = 1; lvl < L; lvl++) {
            const e = rows ? rows[Math.max(1, clampThingLevel(lvl))] : null;
            const md = e ? Number(e[dk]) : NaN, mp = e && gk ? Number(e[gk]) : NaN;
            const def = effect === 'fire' || effect === 'ice' ? 3 + lvl * 0.5 : effect === 'poison' ? 5 + lvl : effect === 'water' ? 6 + lvl : 9;
            let g = 0;
            if (effect === 'fire' || effect === 'poison') g = Number.isFinite(mp) ? mp : Math.max(0.1, base);
            else if (effect === 'ice') g = Number.isFinite(mp) ? mp : Math.max(0.2, base);
            const i = (o * 6 + k) * L + lvl;
            _simTrapT[i] = secondsToTicks(Number.isFinite(md) ? md : def); _simTrapTG[i] = g;
        }
    }
}
let SIM_TRAP_KERNEL = true;
function _simTrapStep() {
    if (!_simTrapK) return;
    if (!SIM_TRAP_KERNEL) { simParallelBind('mv.trapK', null); return; }
    if (_simParReg['mv.trapK'] !== _simTrapK) simParallelBind('mv.trapK', _simTrapK);
    // The tiles to look at again (all after a reset; the list grown and all
    // again when it had no room).
    for (let guard = 0; guard < 8 && (_trap.nd > 0 || _trap.all) && _ST.code; guard++) {
        const P = _trapP;
        P[0] = _trap.nd; P[1] = _stationaryTypes.length; P[2] = GRID_W * GRID_H; P[3] = _trap.all ? 1 : 0;
        if (_trap.all) { _simTrapK.fill(0); _simTrapL.fill(0); _trap.hdr[0] = 0; }
        simRustDirect('k_trap_tiles', [_trap.dirty, _ST.code, _ST.uc, _ST.brain, _simTrapKinds(), _simTrapK, _simTrapL, null, _trap.list, _trap.hdr], P);
        _trap.nd = 0; _trap.all = false;
        if (_trap.hdr[2]) {
            const L = simHeapArrayAuto(Int32Array, _trap.list.length * 2); L.set(_trap.list); simHeapFree(_trap.list); _trap.list = L;
            _trap.hdr[1] = L.length; _trap.hdr[2] = 0; _trap.all = true;
        }
    }
    // The strength table (all owners when its size changed or after a reset).
    const NP = Math.max(1, players.length), L = Math.min(255, MAX_THING_LEVEL + 1);
    if (!_simTrapT || _simTrapTPlayers !== NP || _simTrapTLevels !== L) {
        _simTrapTPlayers = NP; _simTrapTLevels = L;
        const n = NP * 6 * L;
        if (!_simTrapT || _simTrapT.length < n) { _simTrapT = simHeapArrayAuto(Int32Array, n); _simTrapTG = simHeapArrayAuto(Float32Array, n); simParallelBind('mv.trapT', _simTrapT); simParallelBind('mv.trapTG', _simTrapTG); }
        _simTrapOwnersDirty.add(-1);
    }
    if (_simTrapOwnersDirty.size) {
        if (_simTrapOwnersDirty.has(-1)) { for (let o = 0; o < NP; o++) _simTrapTableOwner(o); }
        else for (const o of _simTrapOwnersDirty) if (o >= 0 && o < NP) _simTrapTableOwner(o);
        _simTrapOwnersDirty.clear();
    }
    // Resistances by unit type (types are added as units of them appear).
    const names = _simUnitTypeNames;
    if (!_simTrapRes || _simTrapResN !== names.length) {
        if (!_simTrapRes || _simTrapRes.length < names.length) { _simTrapRes = simHeapArrayAuto(Uint8Array, Math.max(64, names.length * 2)); simParallelBind('mv.tres', _simTrapRes); }
        for (let i = 0; i < names.length; i++) {
            const st = BASE_UNIT_STATS[names[i]] || {};
            _simTrapRes[i] = (st.fireResistant ? 1 : 0) | (st.poisonResistant ? 2 : 0) | (st.iceResistant ? 4 : 0) | (st.waterResistant ? 8 : 0) | (st.sandResistant ? 16 : 0);
        }
        _simTrapResN = names.length;
    }
}

// Per player and block of the spatial index: enemy units plus structures
// hostile to the player, as summed-area tables (the kernel's "anything in
// reach?").
let _simMoveHostile = null;
// Built once a tick, from the state as the tick begins: the tick-start chain
// on the helpers (tower.js tickStartChainPost;
// settled with it before anything that reads them or changes what they
// read: _simMoveStructs' writes, unit counts, the beams), else here at the
// first use. The towers' broad phase, the movement kernel and the
// acquisition's copy all read that one build: structures removed or units
// counted again later in the tick show from the next tick's build.
// P (rows and columns alike): [0] players, [1] blocks wide, [2] high, [3]
// rows (columns) per job. Null when the block tables are not this layout's.
let _simHostileTick = -1, _simHostileDims = '';
function _simHostileStages(P) {
    _simMoveStructs();
    const players = spatialUnitsComplexPlayerCount, bc = spatialBlockCols, br = spatialBlockRows;
    const stride = bc + 1, plane = stride * (br + 1);
    if (!_simMoveHostile || _simMoveHostile.length < players * plane) {
        simHeapFree(_simMoveHostile);
        _simMoveHostile = simHeapArray(Int32Array, Math.max(1, players * plane));
        simParallelBind('mv.hostile', _simMoveHostile);
        _simHostileTick = -1;
    }
    if (!_simMoveHostStruct || _simMoveHostStruct.length < players * plane) {
        simHeapFree(_simMoveHostStruct);
        _simMoveHostStruct = simHeapArray(Int32Array, Math.max(1, players * plane));
        simParallelBind('mv.hstruct', _simMoveHostStruct);
        _simHostileTick = -1;
    }
    if (typeof SIM_KERNEL_SAT_ROWS !== 'number' || !(bc > 0) || spatialBlockCounts.length !== bc * br * players || !_simMoveStructBlocks || _simMoveStructBlocks.length !== bc * br * players) return null;
    simParallelBind('ix.bcount', spatialBlockCounts); simParallelBind('mv.stblk', _simMoveStructBlocks);
    const per = 16;
    P[0] = players; P[1] = bc; P[2] = br; P[3] = per;
    return [[SIM_KERNEL_SAT_ROWS, players * Math.ceil(br / per)], [SIM_KERNEL_SAT_COLS, players * Math.ceil(bc / per)]];
}
// (This tick's build is there or posted: the dims it was made for.)
function _simHostileMark() { _simHostileTick = gameTime; _simHostileDims = spatialUnitsComplexPlayerCount + ':' + spatialBlockCols + ':' + spatialBlockRows; }
function _simMoveBuildHostile() {
    if (typeof tickStartChainSettle === 'function') tickStartChainSettle();
    _simMoveStructs();
    if (_simHostileTick === gameTime && _simHostileDims === spatialUnitsComplexPlayerCount + ':' + spatialBlockCols + ':' + spatialBlockRows) return;
    const P = _simParams, st = _simHostileStages(P);
    if (!st) return;
    simParallelRun(st[0][0], st[0][1]);
    simParallelRun(st[1][0], st[1][1]);
    _simHostileMark();
}
// (The same, structures hostile to the player alone.)
let _simMoveHostStruct = null;

// The area graph for the kernels (area.off, area.nb: each area's
// neighbours, as areaNeighborIds), rebuilt with the area layout.
let _simAreaCsrFor = null;
// The walls as the kernel saw them (holds are checked against them).
let _simMoveRunWallVer = -1;
// (Bumped with every new area layout: long-range holds made under another
// are handed back.)
let _simAreaLayoutVer = 1;
// isWorldTargetWithinAreaRange through the kernels' twin (_simInAreaRange
// on the flat area grid and the CSR area graph): 1 / 0, or -1 where that
// does not work it out (over 2 steps): then the general path.
function simAreaRangeFast(x, y, tx, ty, k) {
    if (!(k >= 0 && k <= 2) || k !== Math.floor(k) || typeof _simInAreaRange !== 'function') return -1;
    _simAreaCsr();
    const R = _simParReg;
    return _simInAreaRange(_spatialAreaGridFlat(), R['area.off'], R['area.nb'], GRID_W, GRID_H, TILE, x, y, tx, ty, k);
}
function _simAreaCsr() {
    if (_simAreaCsrFor === areaNeighborIds) return;
    _simAreaLayoutVer = (_simAreaLayoutVer + 1) | 0;
    const { nbOff: off, nb, bounds } = _mapAreas;
    simParallelBind('area.off', off); simParallelBind('area.nb', nb);
    simParallelBind('area.bounds',bounds);
    _simAreaCsrFor = areaNeighborIds;
}
// The area index for range queries (wasm/src/arq.rs; towers' targets, units'
// in-range checks): made once per layout (a match's start, a whole
// restore: areas never change in play), its memory fixed then. arq.hdr its
// header (arq.rs); each thread queries with its own context (the argument
// block's word 1002, sim_parallel.js _simThreadSlot): one a helper and one
// for this thread, made with it. False when there is no area.
const _arq = { for: null, helpers: -1, hdr: null, arrays: null, P: new Float64Array(4) };
function _arqCtxBytes(nbk) { let a = nbk * 17; a += (16 - a % 16) % 16; let b = a + nbk * 4; return b + (16 - b % 16) % 16; }
function areaRangeIndexEnsure() {
    const Z = _arq, helpers = typeof simParallelHelpers === 'function' ? simParallelHelpers() : 0;
    if (Z.for === areaNeighborIds && Z.hdr && simHeapHas(Z.hdr) && Z.helpers === helpers) return Z.hdr[8] > 0;
    _simAreaCsr();
    const off = _simParReg['area.off'], nb = _simParReg['area.nb'], bounds = _simParReg['area.bounds'], na = off ? off.length - 1 : 0;
    const fresh = Z.for !== areaNeighborIds || !Z.hdr || !simHeapHas(Z.hdr);
    if (fresh) {
        if (Z.arrays) for (const k in Z.arrays) simHeapFree(Z.arrays[k]);
        Z.arrays = null;
        if (!Z.hdr || !simHeapHas(Z.hdr)) { Z.hdr = simSharedArray(Int32Array, 16); simParallelBind('arq.hdr', Z.hdr); }
        Z.hdr.fill(0);
        if (na > 0) {
            const A = Z.arrays = {}, P = Z.P, meta = A.meta = simSharedArray(Int32Array, 4), tmp = simSharedArray(Int32Array, 3 * na);
            A.blk = simSharedArray(Int32Array, na);
            P[0] = 0; P[1] = 0; P[2] = na;
            simRustDirect('k_arq_build', [off, nb, A.blk, null, null, null, null, meta, bounds, tmp], P);
            simHeapFree(tmp);
            const nbk = meta[0];
            A.inv = simSharedArray(Int32Array, nbk * 16); A.d = simSharedArray(Uint8Array, nbk * 256);
            A.xoff = simSharedArray(Int32Array, nbk * 16 + 1); A.xnb = simSharedArray(Int32Array, Math.max(1, meta[2]));
            P[0] = 1; simRustDirect('k_arq_build', [off, nb, A.blk, A.inv, A.d, A.xoff, A.xnb, meta, bounds, null], P);
            P[0] = 2; P[1] = nbk; simRustDirect('k_arq_build', [off, nb, A.blk, A.inv, A.d, A.xoff, A.xnb, meta, bounds, null], P);
        }
        Z.for = areaNeighborIds;
        // (And the movement's per-area boxes for this layout: made with it, not at a first use in play.)
        if (typeof _simMoveAreaBoxes === 'function') _simMoveAreaBoxes();
    }
    // (The contexts: one for this thread and each helper.)
    const A = Z.arrays;
    if (A) {
        const nbk = A.meta[0], stride = _arqCtxBytes(nbk), slots = helpers + 1;
        if (A.ctx) simHeapFree(A.ctx);
        A.ctx = simSharedArray(Uint8Array, stride * slots);
        for (let s = 0; s < slots; s++) A.ctx.fill(255, s * stride, s * stride + nbk * 16);
        const H = Z.hdr, enc = a => _simWEnc(_simHeapPtrOf(a));
        H[0] = enc(A.blk); H[1] = enc(A.inv); H[2] = enc(A.d); H[3] = enc(A.xoff); H[4] = enc(A.xnb); H[5] = enc(A.ctx); H[6] = enc(bounds);
        H[8] = nbk; H[9] = na; H[10] = A.meta[1]; H[11] = stride; H[12] = slots;
    }
    Z.helpers = helpers;
    return Z.hdr[8] > 0;
}

// Runs the armed units' tick (before the update pass), then charges their
// node steps to their owners and updates the spatial index and visibility
// of those that moved into another tile or window.
let _simMoveSpendTypes = null, _simMovePost = null, _simMovePostC = null, _simScoutT = null;
// The kernel's attacks (unit holds, mvFlags 4): attacker and target slots per
// chunk of SIM_MOVE_CHUNK, how many per chunk; chunks this tick (0: none).
let _simMoveHitA = null, _simMoveHitT = null, _simMoveHitC = null, _simMoveHitSC = null, _simMoveHitChunks = 0;
// (The occupancy jobs' second-pass lists: mv.rs move_job.)
let _simMoveWork = null;
let SIM_KERNEL_FIRE = true;
// The movement kernel's scalar params [0..39] (simMoveRun's; the flow looks'
// kernels off the turns, flowLooksPost, give it the same): n slots, per a job.
function _simMoveScalarParams(P, n, per, players) {
    P[0] = n; P[1] = per; P[2] = gameTime; P[3] = TICK_RATE; P[4] = 0; P[5] = GRID_W; P[6] = GRID_H;
    P[7] = TILE; P[8] = UNIT_POSITION_QUANTIZATION; P[9] = spatialBlockCols; P[10] = spatialBlockRows;
    P[11] = players; P[12] = CMD_MOVING; P[13] = CMD_ATTACK_MOVING; P[14] = SPATIAL_BLOCK_SIZE * CHUNK_SIZE; P[15] = SIM_SEP_ABSENT;
    P[16] = SIM_MOVE_WINDOW; P[17] = SIM_MOVE_BOX_STEPS; P[18] = SIM_FLOW_ARRIVE; P[19] = _simMoveWallVer;
    P[20] = Math.max(0, Number(CROSS_TEAM_UNIT_COLLISION_PADDING) || 0) + UNIT_CONTACT_ATTACK_MARGIN;
    P[21] = WORKER_MOVE_CHECK_TICKS;
    {
        const V = _workerWorkTable(), delay = Math.max(1, Math.floor(Number(WORKER_AI_TICK_DELAY) || 1));
        simParallelBind('wk.ver', V);
        P[22] = V.np; P[23] = _WORKER_WORK_TYPES.length; P[24] = V.rw; P[25] = V.rh; P[26] = WORKER_WORK_REGION_TILES;
        P[27] = delay * Math.ceil(getWorkerIdleSearchTicks() / delay); P[28] = _healerCandidatesGen; P[29] = BUILDER_WATCH_TICKS;
        P[30] = _simMoveWallBlkW; P[31] = (GRID_H + 7) >> 3;
    }
    _simAreaCsr();
    P[32] = _simAreaLayoutVer;
    // (Drive-by looks: the unit index by chunk, and its owners per chunk
    // when this tick's combat scan made them.)
    P[33] = _sxEpoch; P[34] = CHUNKS_W; P[35] = CHUNKS_H; P[36] = CHUNK_SIZE; P[37] = _combatScanTick === gameTime ? 1 : 0;
    P[38] = SIM_ACQUIRE_TICKS; P[39] = _acqCommitTick;
}
// The flow looks made exact off the turns. A turn whose look-ahead record
// misses takes an O(1) answer (mv.rs flow_look_approx: along its last answer,
// or a step toward its destination) and moves on; after the movement each
// walker whose record is not the exact answer where it stands lists its key
// (mv_flow_pending, foreground), the helpers make the answers (mv_flow_exact,
// lane SIM_LANE_FLOW) through the tick's rest and up to the next movement,
// whose start puts them into the records (mv_flow_commit, by unit id: slots
// move between): its turns have them. Listed and committed at fixed points,
// each answer a function of its key, checked at the commit against what it
// read (build, field, walls in reach: their versions; one made while they
// changed is dropped): the same on every peer, with any helpers, and nothing
// waits for the helpers but the commit (and a look table reset). The
// movement kernel's arguments (bound by its first run) and params, its slots
// by FLOW_PER a job.
const SIM_FLOW_PER = 8192;
// (Its helpers' claims a job: mv.rs FLOW_SPLIT, short ones.)
const SIM_FLOW_SPLIT = 32;
// (A job is committed at the movement after its post, a tick more per SIM_FLOW_TICK_LOOKS looks it lists (the burst when
// many records miss at once): calls counts the posts' ticks, due the one it commits at; while one is in flight no other is
// posted, the records keep the O(1) answers. The same ticks on every peer: the count is the state's.)
const SIM_FLOW_TICK_LOOKS = 131072;
const _flowLooks = { posted: false, jobs: 0, P: new Float64Array(64), calls: 0, due: 0, pend: 0, ws: [], wsTab: null };
// The live walls of every navigation profile, copied at a post (in parallel:
// simParallelCopyHeap): the exact looks on the helpers read these copies
// (mv.rs flow_wall_snap, the table at word 478), so an answer is the state of
// its post whichever thread makes it and when, and its commit may keep it
// when walls changed since, if its way is still open then (mv_flow_commit).
// One copy a profile, made once and reused.
function _flowWallSnap() {
    const L = _flowLooks, R = _simParReg;
    if (!L.wsTab || !simHeapHas(L.wsTab)) { L.wsTab = simHeapArray(Int32Array, _SIM_MOVE_NAV); simParallelBind('fl.wsTab', L.wsTab); }
    const T = L.wsTab, pairs = [];
    for (let p = 0; p < _SIM_MOVE_NAV; p++) {
        const src = R[p === 0 ? 'mv.wall' : p === 1 ? 'mv.airwall' : 'mv.cwall.' + p];
        if (!src || !simHeapHas(src)) { T[p] = 0; continue; }
        let snap = L.ws[p];
        if (!snap || snap.length !== src.length || !simHeapHas(snap)) { snap = L.ws[p] = simHeapArray(Uint8Array, src.length); simParallelBind('fl.ws.' + p, snap); }
        // (Copied when a wall table was written since its last copy, or either array is another: a megabyte a
        // profile at a 1024 map, at every post 0.6 ms of this thread.)
        const K = L.wsOf || (L.wsOf = []), k = K[p] || (K[p] = { e: -1, src: null, snap: null });
        if (k.e !== _simWallsEpoch || k.src !== src || k.snap !== snap) { pairs.push(snap, src); k.e = _simWallsEpoch; k.src = src; k.snap = snap; }
        T[p] = _simWEnc(snap.byteOffset);
    }
    if (pairs.length) simParallelCopyHeap(pairs);
    // (And the ground walls' change count per 8x8 block (mv.wallBlk) as at the post: a commit
    // keeps an answer whose blocks have not changed since without a line test, mv.rs walls_same_since_post.)
    const B = R['mv.wallBlk'];
    if (B && simHeapHas(B)) {
        if (!L.wb || L.wb.length !== B.length || !simHeapHas(L.wb)) { L.wb = simHeapArray(Int32Array, B.length); simParallelBind('fl.wb', L.wb); L.wbE = -1; }
        if (L.wbE !== _simWallsEpoch || L.wbOf !== B) { L.wb.set(B); L.wbE = _simWallsEpoch; L.wbOf = B; }
    }
}
let _simMoveRanTick = -1;
// (The movement's first stage chunking this tick: slots a chunk, chunks.)
const simMovePick = { per: 0, jobs: 0 };
function _flowLooksArrays(n) {
    // (Sized for every slot of the match: made once, never grown in play.)
    const jobs = Math.ceil(n / SIM_FLOW_PER), cap = Math.ceil(Math.max(n, _simUnitState ? _simUnitState.cap : 0) / SIM_FLOW_PER) * SIM_FLOW_PER;
    for (const [name, Type, len] of [['fl.pend', Int32Array, cap * 8], ['fl.res', Int32Array, cap * 4], ['fl.cnt', Int32Array, Math.max(64, cap / SIM_FLOW_PER)]]) {
        const a = _simParReg[name];
        if (!a || a.length < len || !simHeapHas(a)) { const b = simHeapArray(Type, len); simParallelBind(name, b); if (a && simHeapHas(a)) simHeapFree(a); }
    }
    return jobs;
}
function flowLooksPost() {
    const L0 = _flowLooks;
    L0.calls++;
    if (L0.posted) { if (L0.calls - 1 < L0.due) return; flowLooksCommit(); }
    const S = _simUnitState;
    if (!S || _simMoveRanTick !== gameTime || !_simMoveLookC || typeof SIM_KERNEL_FLOW_PENDING !== 'number' || !_simWasmX || typeof _simWasmX.mv_flow_pending !== 'function') return;
    const n = S.owners.length;
    if (!n || !spatialBlockCols) return;
    const jobs = _flowLooksArrays(n), P = _simParams;
    _simMoveScalarParams(P, n, SIM_FLOW_PER, spatialUnitsComplexPlayerCount);
    P[47] = areaSearchEnabled() ? 1 : 0; P[48] = SIM_COMBAT_BRAIN ? 1 : 0; P[58] = simDk;
    _flowLooks.P.set(P);
    simParallelRun(SIM_KERNEL_FLOW_PENDING, jobs);
    { const cnt = _simParReg['fl.cnt']; let m = 0; for (let j = 0; j < jobs; j++) m += cnt[j]; _flowLooks.pend = m; }
    // (Tracing (sim_worker.js ?simtrace=1): the looks listed this step.)
    if (typeof _simTraceCur !== 'undefined' && _simTraceCur) _simTraceCur.ph.flowPend = (_simTraceCur.ph.flowPend || 0) + _flowLooks.pend;
    const Q = simParallelStageParams(SIM_LANE_FLOW, 0);
    Q.set(P);
    _flowLooks.posted = true; _flowLooks.jobs = jobs; _flowLooks.due = _flowLooks.calls + Math.floor(_flowLooks.pend / SIM_FLOW_TICK_LOOKS);
    // (Eager: without helpers made now, not at a later wait, after the state they read changed.)
    // (The walls as at this post, for the looks: the lane is idle here, its last job committed.)
    simParallelBackgroundWait(SIM_LANE_FLOW); _flowWallSnap();
    simParallelBackgroundChain(SIM_LANE_FLOW, [[SIM_KERNEL_FLOW_EXACT, jobs * SIM_FLOW_SPLIT]], true);
}
// (The helpers' answers waited for; still to commit.)
function flowLooksSettle() { if (_flowLooks.posted) simParallelBackgroundWait(SIM_LANE_FLOW); }
// The next movement's start (simMoveRun): the answers into the records.
function flowLooksCommit() {
    const L = _flowLooks;
    if (!L.posted || L.calls < L.due) return;
    simParallelBackgroundWait(SIM_LANE_FLOW);
    L.posted = false;
    const U = unitIdIndex();
    if (!U || !simHeapHas(U.ids) || !simHeapHas(U.slots)) return;
    if (_simParReg['um.ids'] !== U.ids || _simParReg['um.slots'] !== U.slots) { simParallelBind('um.ids', U.ids); simParallelBind('um.slots', U.slots); }
    _simParams.set(L.P); _simParams[63] = U.n;
    // (Each job's answers in SIM_FLOW_SPLIT parts, as the exact kernel's: mv.rs mv_flow_commit.)
    simParallelRun(SIM_KERNEL_FLOW_COMMIT, L.jobs * SIM_FLOW_SPLIT);
}
// (A resync, on every peer: nothing listed is committed.)
function flowLooksDrop() { if (_flowLooks.posted) { simParallelBackgroundWait(SIM_LANE_FLOW); _flowLooks.posted = false; } }
function simMoveRun() {
    // (The last movement's looks made exact on the helpers, into the records first.)
    flowLooksCommit();
    const S = _simUnitState;
    if (!S || !spatialBlockCols || spatialBlockCounts.length !== spatialBlockCols * spatialBlockRows * spatialUnitsComplexPlayerCount) return;
    const n = S.owners.length;
    if (!n) return;
    // (Targets set before their target had a slot (a restore): their slots,
    // which the kernel's attack orders read, on every peer alike.)
    simUnitTargetsResolve();
    const c = S.columns, players = spatialUnitsComplexPlayerCount;
    // (Changed stat tables reach the movement columns as each unit takes them,
    // simMoveStatsChanged; not every unit at once.)
    _simMoveBuildHostile();
    _simMoveWalls();
    _simMoveAreaBoxes();
    // The combat scan first: the kernel keeps aggro units moving when it
    // found no enemy unit for them (see SIM_KERNEL_MOVE).
    combatScanRun();
    // Every armed shooter's box is present (the table is a cache that may
    // have been reset: the kernel's outcome must not depend on it): after a
    // reset; otherwise arming and entering an area make them.
    if (_simMoveAreaBoxesNew) {
        _simMoveAreaBoxesNew = false;
        const ON = c.mvOn, FL = c.mvFlags, AR = c.spArea, RE = c.mvReach, ok = _simMoveAreaBoxOk;
        for (let s = 0; s < n; s++) {
            if (!ON[s] || (FL[s] & 1) === 0) continue;
            const a = AR[s];
            if (a >= 0 && !ok[a * SIM_MOVE_BOX_STEPS + RE[s]]) _simMoveEnsureAreaBox(a, RE[s]);
        }
    }
    // (Room for a status record for every unit a floor trap may meet: the
    // kernel takes them on the helpers, mv.rs floor_hit.)
    if (typeof simUnitStReserve === 'function') simUnitStReserve(_simTrapUnitsBound() + 64);
    const P = _simParams, CH = SIM_MOVE_CHUNK;
    _simMoveScalarParams(P, n, CH, players);
    // (Attack holds: sight by area, the area of each tile.)
    if (typeof _visCoverReady === 'function' && _visCoverReady()) { simParallelBind('vis.cover', _visCover.visible); simParallelBind('vis.coverf', _visCover.visibleFlat); }
    simParallelBind('ix.agrid', _spatialAreaGridFlat());
    const occupancy = typeof SIM_OCCUPANCY_ENABLED!=='undefined' && SIM_OCCUPANCY_ENABLED;
    const chunks = occupancy ? occupancyPrepareMovement() : Math.ceil(n / CH);
    if(occupancy&&typeof trafficBeforeMovement==='function')trafficBeforeMovement();
    const outputSlots = occupancy ? n : chunks * CH;
    // (The attacks are listed by slot chunk: with the occupancy, by its first stage's.)
    const stepChunks = Math.ceil(n / CH), hitChunks = occupancy ? stepChunks : chunks;
    // (The first stage's chunks: the orders' pickup lists its leftovers by them, main.js orderPickupFinish.)
    simMovePick.per = CH; simMovePick.jobs = stepChunks;
    // (The flow looks shared by the kernel's threads: see mv.rs look_cache.)
    if (!_simMoveLookC) { _simMoveLookC = simHeapArray(Int32Array, SIM_MOVE_LOOKC_ENTRIES * 16); _simMoveLookC.fill(0); simParallelBind('mv.lookc', _simMoveLookC); }
    // (The scout's type index, for the unit controller: scouts are Unit.update's.)
    if (!_simScoutT) { _simScoutT = simHeapArray(Int32Array, 4); simParallelBind('mv.scoutT', _simScoutT); }
    _simScoutT[0] = simUnitTypeIndex('scout');
    if (!_simMovePost || _simMovePost.length < outputSlots) { _simMovePost = simHeapArrayAuto(Int32Array, simReserveCap(outputSlots, 8192)); simParallelBind('mv.post', _simMovePost); }
    if (occupancy && (!_simMoveWork || _simMoveWork.length < outputSlots)) { _simMoveWork = simHeapArrayAuto(Int32Array, simReserveCap(outputSlots, 8192)); simParallelBind('occ.work', _simMoveWork); }
    if (!_simMovePostC || _simMovePostC.length < chunks) { _simMovePostC = simHeapArrayAuto(Int32Array, Math.max(64, chunks * 2)); simParallelBind('mv.postc', _simMovePostC); }
    // (The attacks the kernel made, per chunk: see unitHitsResolve.)
    if (!_simMoveHitA || _simMoveHitA.length < outputSlots) {
        _simMoveHitA = simHeapArrayAuto(Int32Array, simReserveCap(outputSlots, 8192)); _simMoveHitT = simHeapArrayAuto(Int32Array, _simMoveHitA.length);
        simParallelBind('mv.hita', _simMoveHitA); simParallelBind('mv.hitt', _simMoveHitT);
    }
    if (!_simMoveHitC || _simMoveHitC.length < hitChunks) { _simMoveHitC = simHeapArrayAuto(Int32Array, Math.max(64, hitChunks * 2)); simParallelBind('mv.hitc', _simMoveHitC); }
    // (Each chunk's attacks with a status style, mv.rs hit_sty_count.)
    if (!_simMoveHitSC || _simMoveHitSC.length < _simMoveHitC.length) { _simMoveHitSC = simHeapArrayAuto(Int32Array, _simMoveHitC.length); simParallelBind('mv.hitsc', _simMoveHitSC); }
    _simMoveHitChunks = hitChunks;
    // (The kernel's epilogue: the index columns of units in other tiles, the
    // node steps' charges per chunk, owner and type.)
    const NPa = _simMoveGamePlayers(), names = _spatialUnitTypeNames(), NT = names.length + 1;
    {
        if (!_simMoveRem || _simMoveRem.length < NPa) { _simMoveRem = simHeapArrayAuto(Float64Array, Math.max(8, NPa * 2)); simParallelBind('mv.astarRem', _simMoveRem); }
        for (let pid = 0; pid < NPa; pid++) _simMoveRem[pid] = _astarAtPassStart ? (_astarAtPassStart[pid] ?? 0) : _getPlayerAstarBudgetRemaining(pid) + _fromFixedResourceUnits(_pendingMovementAstarFixed[pid] || 0);
        if (!_simMoveChFix || _simMoveChFix.length < chunks * (NPa + 1)) { _simMoveChFix = simHeapArrayAuto(Float64Array, Math.max(64, chunks * (NPa + 1) * 2)); simParallelBind('mv.chFix', _simMoveChFix); }
        if (!_simMoveChUse || _simMoveChUse.length < chunks * NPa * NT) { _simMoveChUse = simHeapArrayAuto(Float64Array, Math.max(256, chunks * NPa * NT * 2)); simParallelBind('mv.chUse', _simMoveChUse); }
        P[40] = spatialEpoch;
        P[43] = NPa; P[44] = NT; P[45] = RESOURCE_FIXED_POINT_SCALE;
    P[55] = _simTrapResN; P[56] = _simTrapTLevels; P[57] = _simTrapTPlayers;
    }
    // (Flow units between steers first, a small kernel of their own; the
    // movement kernel does the rest.)
    const stepK = SIM_MOVE_STEP_KERNEL && typeof SIM_KERNEL_MOVE_STEP === 'number';
    P[46] = stepK ? 1 : 0; P[47] = areaSearchEnabled()?1:0; P[48] = SIM_COMBAT_BRAIN ? 1 : 0;
    // (The step's base ticks: mv.rs Mv.dk.)
    P[58] = simDk;
    // The separation's pushes (its pair kernel's, from where units stood as
    // the tick began: the unit index's prebuild after the last tick, else
    // separationStart) applied by the kernel's epilogue, where each unit
    // moved (the finish, fused: one visit of each unit).
    P[54] = 0;
    if (_sepPending && _sepPending.tick === currentTick) {
        simParallelBackgroundWait(_sepPending.lane | 0);
        _sepPending = null;
        // (Slots past the chain's arrays (made since): none this tick.)
        if (_sep && _sep.cap >= n && _sep.px && _sep.ex && _sep.exc && _sep.exc.length >= chunks) {
            const once = (UNIT_SEPARATION_MODE | 0) === 1;
            // (P[51] 0: no path retry on a push; waiting units' looks are the
            // pending-path schedule's alone.)
            P[49] = UNIT_SEPARATION_CONTACTS; P[50] = UNIT_SEPARATION_Q; P[51] = 0;
            // (Half the relaxed correction now, half the next update, at one
            // base tick a step; several: all of it now, none carried stale.)
            P[52] = once ? 1 : UNIT_SEPARATION_TIER_GAIN; P[53] = once || simDk > 1 ? 1 : 0.5; P[54] = 1;
            P[59] = 1 - detExp(-(once ? 1 : 2) * Math.max(1, simDk) / UNIT_SEPARATION_RELAX_TICKS);
            P[60] = UNIT_SEPARATION_REST_SLEEP; P[61] = UNIT_SEPARATION_REST_WAKE; P[62] = UNIT_SEPARATION_FLOW_SIDE; P[63] = UNIT_SEPARATION_CONTACT_SPEEDS;
        } else _sepDirty = true;
    }
    // The fast step and remaining movement share each scheduled chunk.
    if(occupancy){
        // Two stages: every unit's step as it wants it, by slot chunk (the
        // vector paths, the attacks; P[4] -1), then by spatial block in four
        // phases the wanted positions against the exclusive footprints (the
        // pressure's steering, shoulders, swaps, pushes) and the epilogue.
        P[4]=-1;simParallelRun(SIM_KERNEL_MOVE,stepChunks);
        // (The mover table's marked slots, scanned by that stage's chunks: their rows into their blocks, occ.offsets.)
        mvtAfterFirstStage(n);
        // (Each phase's blocks with units, heaviest first: occupancyJobs.)
        const J=occupancyJobs(_simMovePostC,P[54]===1&&_sep?_sep.exc:null,_simMoveChFix,NPa+1);
        for(let phase=0;phase<4;phase++){if(J[4+phase]>0){P[4]=phase;simParallelRun(SIM_KERNEL_MOVE_OCCUPANCY,J[4+phase]);}}
    }else simParallelRun(SIM_KERNEL_MOVE, chunks);
    if (typeof simUnitStSettle === 'function') simUnitStSettle();
    _simMoveRunWallVer = _simMoveWallVer; _simDead0Tick = gameTime; _simMoveRanTick = gameTime;
    _spatialKernelMoves = true;
    _simMoveChargeSteps(chunks, NPa, NT, names);
    // The slots the kernel listed (an arrival, a wall, a budget mark, a unit
    // whose index it did not update, a drive-by shooter in another area),
    // chunk by chunk in slot order: not every slot.
    const OUT = c.mvOut, owners = S.owners, PL = _simMovePost, PC = _simMovePostC;
    let slow = null;
    for (let k = 0; k < chunks; k++) for (let i = occupancy ? _occ.offsets[k] : k * CH, e = i + PC[k]; i < e; i++) {
        const s = PL[i], o = OUT[s];
        if (o === 0) continue;
        if (c.mvBlk[s]) { c.mvBlk[s] = 0; if (owners.at(s)) _setUnitAstarBudgetBlockedIndicator(owners.at(s), 1); }
        if (o === 1 || o === 6 || o === 7 || o === 10 || o === 11 || o === 13 || o === 14 || o === 15) continue;
        // Arrived in the crowd at its destination: the move is done.
        // Into a wall tile: the end of Unit.update (pushed out; can start
        // path work on the owner's budget): in id order afterwards.
        if (o === 4) { if (owners.at(s)) (slow ||= []).push(owners.at(s)); continue; }
        // Another tile: the spatial index, from the columns.
        spatialSlotUpdate(c, s);
        // A drive-by shooter entering another area needs its box.
        if (o === 3 && (c.mvFlags[s] & 1) && c.spArea[s] >= 0) _simMoveEnsureAreaBox(c.spArea[s], c.mvReach[s]);
    }
    if (slow) {
        slow.sort((a, b) => a.id - b.id);
        for (const u of slow) {
            if (u.dead) continue;
            pushUnitOutOfBlockedTile(u);
            u.x = _quantizeUnitWorldCoord(u.x); u.y = _quantizeUnitWorldCoord(u.y);
            updateUnitSpatial(u);
        }
    }
    if (occupancy) occupancyAfterMovement(c);
    if (P[54] === 1) _simMoveSepListed(chunks, CH);
    if(occupancy&&typeof trafficAfterMovement==='function')trafficAfterMovement();
    if (occupancy && SIM_MVT) mvtAfterMovement();
}

// The pushed units the epilogue listed (sep.ex per chunk): blocked on the way
// (sep.fast 0: the swept commit, in id order), else (2) their index entry,
// a drive-by box, a fallback path on its retry tick.
function _simMoveSepListed(chunks, per) {
    const U = _simUnitState, S = _sep, c = U.columns, owners = U.owners, fast = S.fast, EX = S.ex, EXC = S.exc;
    let retries = null, slow = null;
    for (let k = 0; k < chunks; k++) for (let j = k * per, e = j + EXC[k]; j < e; j++) {
        const i = EX[j];
        if (fast[i]) {
            if (simStepCrosses(c.id[i] | 0, UNIT_SEPARATION_PATH_RETRY_TICKS)) {
                const u = owners.at(i);
                if (u && !u.dead && u.pathIsFallbackAstar && u._pendingPathTarget) (retries ||= []).push(u);
            }
            if (c.energy[i] > 0) spatialSlotUpdate(c, i);
            if ((c.mvFlags[i] & 1) && c.spArea[i] >= 0) _simMoveEnsureAreaBox(c.spArea[i], c.mvReach[i]);
            continue;
        }
        const u = owners.at(i);
        if (!u || u.dead) continue;
        (slow ||= []).push(i);
    }
    if (slow) {
        slow.sort((a, b) => owners.at(a).id - owners.at(b).id);
        for (let i of slow) {
            const u = owners.at(i);
            applyUnitSeparation(u, S.nextX[i], S.nextY[i], Infinity);
            if (u.pathIsFallbackAstar && u._pendingPathTarget && simStepCrosses(u.id, UNIT_SEPARATION_PATH_RETRY_TICKS)) (retries ||= []).push(u);
            pushUnitOutOfBlockedTile(u);
            u.x = _quantizeUnitWorldCoord(u.x);
            u.y = _quantizeUnitWorldCoord(u.y);
            updateUnitSpatial(u);
        }
    }
    if (retries) {
        retries.sort((a, b) => a.id - b.id);
        for (let u of retries) _tryUpgradeAstarFallbackPath(u);
    }
}

// The kernel's node steps, charged like _tryConsumeAstarMoveCost (one spend
// of the unit's cost per step, a unit marked when its owner could not cover
// it: mvBlk): the kernel's sums per chunk and owner into the pending spend,
// per owner and unit type into the usage log.
function _simMoveChargeSteps(chunks, NP, NT, names) {
    // (The chunks' sums: wasm/src/nfs.rs k_charge_sum.)
    const Z = _simChSum;
    if (!Z.fix || Z.fix.length < NP || Z.use.length < NP * NT || !simHeapHas(Z.fix)) { Z.fix = simSharedArray(Float64Array, Math.max(16, NP)); Z.use = simSharedArray(Float64Array, Math.max(64, NP * NT)); Z.hdr = simSharedArray(Int32Array, 2); }
    Z.P[0] = chunks; Z.P[1] = NP; Z.P[2] = NT;
    simRustDirect('k_charge_sum', [_simMoveChFix, _simMoveChUse, Z.fix, Z.use, Z.hdr], Z.P);
    if (!Z.hdr[0]) return;
    const fix = Z.fix, used = Z.use;
    for (let pid = 0; pid < NP; pid++) {
        if (fix[pid]) _pendingMovementAstarFixed[pid] = (_pendingMovementAstarFixed[pid] || 0) + fix[pid];
        for (let ti = 0; ti < NT; ti++) {
            const u = used[pid * NT + ti];
            if (u > 0) _recordAstarUsage(pid, u, null, 'movement', (ti < NT - 1 && names[ti]) || 'norm');
        }
    }
}
const _simChSum = { fix: null, use: null, hdr: null, P: new Float64Array(3) };
let _simMoveRem = null, _simMoveChFix = null, _simMoveChUse = null;
// The movement kernel's shared flow looks (mv.rs LOOKC_ENTRIES entries of 16
// words): keyed by what a look depends on, among them the navigation build
// and the global wall version (looks extend beyond the source's wall block),
// counters that start again after a navigation
// reset or a wall rebuild: emptied then (peer-local, results unchanged).
const SIM_MOVE_LOOKC_ENTRIES = 1 << 18;
let _simMoveLookC = null;
function simMoveLookCacheClear() { if (typeof tickStartChainSettle === 'function') tickStartChainSettle(); flowLooksSettle(); if (_simMoveLookC) _simMoveLookC.fill(0); }
// (The step kernel before the movement kernel: see SIM_KERNEL_MOVE_STEP.)
let SIM_MOVE_STEP_KERNEL = true;
// Slots per job of the movement kernels: small jobs, so the helpers share
// the work evenly (4096: ~49 jobs at 200k, the last ones' wait ~3 ms a
// tick; 1024: an order's newly armed units, consecutive slots, still made
// a few jobs far longer than the rest; 256 added claim overhead and did not
// end those ticks' spikes).
// (The charges' per-job sums: integers, or the usage log's.)
const SIM_MOVE_CHUNK = 512;
// (simMoveRun's own 'players' is the index's count.)
function _simMoveGamePlayers() { return players.length; }

// Unit type names by spatial type index (the spType column).
let _spatialTypeNames = [], _spatialTypeNamesFor = null;
function _spatialUnitTypeNames() {
    if (_spatialTypeNamesFor !== spatialUnitTypeToIndex) {
        _spatialTypeNames = [];
        for (const k in spatialUnitTypeToIndex) _spatialTypeNames[spatialUnitTypeToIndex[k]] = k;
        _spatialTypeNamesFor = spatialUnitTypeToIndex;
    }
    return _spatialTypeNames;
}

// Idle and attack-moving units look for enemy units (the combat scan) on
// their acquisition ticks only: (tick + id) % SIM_ACQUIRE_TICKS === 0, a
// tier below the tick (5 a second each, staggered); the structure look
// (every 4 ticks) falls on the same ticks.
const SIM_ACQUIRE_TICKS = 4;
// The nearest visible enemy unit within `range` of an idle or attack-moving
// unit: this tick's combat scan (the world at the start of the update pass),
// else (another range, a unit the scan did not cover, or a target killed
// since) the query.
// The structure the acquisition tier found for u's look (see
// SIM_KERNEL_ACQ_SCAN), still there, hostile, standing, built (cell items)
// and in sight; else null (until the next commit).
function _acqStructureHit(u, range) {
    const c = u._us;
    if (!c) return null;
    const s = u._si;
    if (c.cbTick[s] !== _acqCommitTick || c.cbRangeS[s] !== range) return null;
    const t = c.cbS[s];
    if (!(t >= 0)) return null;
    const gx = t % GRID_W, gy = (t - gx) / GRID_W, e = getTileEntityRef(gx, gy);
    if (!e || !(e.energy > 0)) return null;
    const cell = grid[gy] && grid[gy][gx], isItem = !!cell && cellItemGet(cell) === e;
    const owner = isItem ? cellOwner[(cell) - 1] : e.owner;
    if (owner === u.owner || (isItem && e.underConstruction)) return null;
    if (!isGameplayTargetVisibleToPlayer(u.owner, gx, gy)) return null;
    return e;
}
// Runs the combat scan for every idle or attack-moving unit before the
// update pass (in parallel; see SIM_KERNEL_COMBAT_SCAN).
let _combatScanTick = -1, _combatScanOwnerMask = null;
// At a restore (snapFlushHistoryCaches): a peer that had run the restored
// tick already skipped its scan as done, and kept that tick's owner masks.
function combatScanReset() { _combatScanTick = -1; _sxOwnerMaskEpoch = -1; }
function combatScanRun() {
    if (_combatScanTick === gameTime) return;

    const S = _simUnitState;
    if (!S || typeof SIM_KERNEL_COMBAT_SCAN !== 'number') return;
    const n = S.owners.length;
    if (!n || !_visCoverReady() || !_simMoveHostile || !spatialBlockCols) return;
    if (spatialIndexEntries() <= 0) return;
    simParallelBind('vis.cover', _visCover.visible); simParallelBind('vis.coverf', _visCover.visibleFlat);
    simParallelBind('sep.eslot', _sxESlot); simParallelBind('sep.rs', _sxStart); simParallelBind('sep.rc', _sxCount); simParallelBind('sep.rstamp', _sxStamp);
    const P = _simParams;
    P[0] = n; P[1] = 2048; P[2] = gameTime; P[3] = CHUNKS_W; P[4] = CHUNKS_H; P[5] = TILE; P[6] = _sxEpoch;
    P[7] = Math.min(spatialUnitsComplexPlayerCount, _visCover.players); P[8] = CMD_IDLE; P[9] = CMD_ATTACK_MOVING;
    P[10] = SPATIAL_BLOCK_SIZE * CHUNK_SIZE; P[11] = spatialBlockCols; P[12] = spatialBlockRows; P[13] = SIM_SEP_ABSENT; P[14] = CHUNK_SIZE;
    P[15] = GRID_W; P[16] = GRID_H; P[17] = CMD_MOVING; P[18] = CMD_ATTACKING; P[19] = SIM_ACQUIRE_TICKS;
    simParallelBind('ix.agrid', _spatialAreaGridFlat());
    _combatScanTick = gameTime;
    // Owners per tile first (SIM_KERNEL_TILE_OWNERS): the scan passes over
    // tiles holding only its own player's units.
    {
        const nc = CHUNKS_W * CHUNKS_H, ne = spatialIndexEntries();
        if (!_combatScanOwnerMask || _combatScanOwnerMask.length !== nc) { simHeapFree(_combatScanOwnerMask); _combatScanOwnerMask = simHeapArray(Uint8Array, nc); _sxOwnerMaskEpoch = -1; }
        simParallelBind('ix.omask', _combatScanOwnerMask); simParallelBind('sep.ekey', _sxEKey);
        // (Made with the index after the last tick: spatialIndexPrebuild.)
        if (_sxOwnerMaskEpoch !== _sxEpoch) {
            P[0] = ne; P[1] = 8192; P[2] = 0;
            simParallelRun(SIM_KERNEL_TILE_OWNERS, Math.ceil(ne / 8192));
            _sxOwnerMaskEpoch = _sxEpoch;
        }
        P[0] = n; P[1] = 2048; P[2] = gameTime;
    }
    simParallelRun(SIM_KERNEL_COMBAT_SCAN, Math.ceil(n / 2048));
    _acqTierStep();
}

// The acquisition tier: the search for enemy units (idle and attack-moving
// units, building attackers' looks) is not the tick's: a job on the helpers
// (lane SIM_LANE_T10) every SIM_ACQUIRE_TICKS ticks. At phase 2 the tick
// takes a snapshot of what it reads (SIM_KERNEL_ACQ_SNAP and copies of the
// unit index, the hostile tables and the cover) and posts the scan
// (SIM_KERNEL_ACQ_SCAN); at phase 0 the result is committed into the units'
// columns (SIM_KERNEL_ACQ_COMMIT), stamped with that tick (_acqCommitTick).
// Until the next commit a unit takes it at its acquisition tick
// (_combatScanHit, the movement kernel's _simAcqHit): a target where it was
// up to 2-5 ticks before, alive and the same unit still. Every peer posts
// and commits at the same ticks; a resync drops a pending run on all.
const ACQ_LANE = typeof SIM_LANE_T10 === 'number' ? SIM_LANE_T10 : 2;
// Combat decisions on the helpers (BRAIN_OFF_MAIN_THREAD_PLAN.md, stage 1):
// the brain's instructions drive engaged units in the movement kernel.
let SIM_COMBAT_BRAIN = true, _acqBrain = false;
// Opt-in approximation experiment: total candidate budget, 0 = exact.
// Must match on all peers; the acquisition tick and IDs seed the samples.
let SIM_ACQ_SAMPLE_BUDGET=0;
// Local play-test toggle; the page forwards it to its simulation worker.
let SIM_ACQ_AREA_TARGETS=!(typeof location!=='undefined'&&location&&/[?&]acq=exact(?:&|$)/.test(String(location.search||'')));
let _acqSampleNearVer=-1,_acqSampleNearOf=null;
let _acqCommitTick = -1, _acqStage = 0, _acqStepTick = -1, _acqN = 0;
const _acq = { cap: 0, chunks: 0, entries: 0, A: 0, cover: null, hs: null };
function _acqTierStep() {
    if (_acqStepTick === gameTime) return;
    _acqStepTick = gameTime;
    // (The phases of the step's base ticks: with several, its commit before
    // its next post.)
    const ph = simStepPhases(SIM_ACQUIRE_TICKS);
    if (ph.includes(0)) _acqCommit();
    // (At phase 2 the chain, ~350 ms of CPU at 500k units, is 55-70% done at
    // some commits, which finish it on the tick: +10-26 ms. Posting at phase
    // 1 moved the starvation to lower lanes and the mean up 18%: 2026-11-10.)
    if (ph.includes(2)) _acqPost();
}
// Before the unit index (or the owners per chunk, the hostile tables) is
// made again: a posted scan reads them in place, so it is waited for here
// (it was posted a tick before; done by now as a rule).
function acqTierIndexWait() {
    // (Only its first stage reads the live index: the rest reads the copies
    // it made, and runs on until the commit.)
    if (_acqStage === 1) simParallelBackgroundWaitStage(ACQ_LANE, 0);
}
// (A resync: every peer's combat instructions dropped on the same tick.)
function combatBrainReset() {
    const S = _simUnitState;
    if (S) { S.columns.cmMode.fill(0); mvtInvalidate(); }
}
// The units' slots moved (sim_unit_state.js simUnitStateCompact: map old
// slot -> new, -1 gone; runs [to, from, count]): a posted run's results,
// by slot, follow their units, and the brain's targets (slots) are mapped,
// so the commit gives every unit what it would have had. (Dropped by the
// commit's id check instead, a compaction left engaged units without their
// instructions for a round: 10k of 94k idle, a different battle.)
// (The background lanes were waited for: the results are complete.)
function acqTierRemapSlots(map, runs, n0, ns) {
    if (_acqStage !== 1) return;
    const n = Math.min(_acqN, n0);
    for (const name of ['acq.out', 'acq.tid', 'acq.id', 'acq.rng', 'acq.sout', 'acq.bm', 'acq.bt', 'acq.btid']) {
        const a = _simParReg[name];
        if (!a) continue;
        const old = a.slice(0, n);
        // (Slots past the old run's: none, as if the run had not covered them.)
        a.fill(name === 'acq.bm' ? 255 : name === 'acq.out' ? -2 : name === 'acq.id' ? -1 : 0, 0, Math.min(a.length, Math.max(ns, n)));
        const R = [];
        for (let r = 0; r < runs.length; r += 3) {
            const from = runs[r + 1], cnt = Math.min(runs[r + 2], n - from);
            if (cnt > 0) R.push(runs[r], from, cnt);
        }
        _simCopyRuns(old, a, R, 1);
    }
    // (bt: a unit's slot, or a structure's tile under mode 16.)
    const bt = _simParReg['acq.bt'], bm = _simParReg['acq.bm'];
    if (bt && bm) for (let s = 0; s < ns; s++) { const t = bt[s], m = bm[s]; if (t >= 0 && m !== 255 && (m & 16) === 0) bt[s] = t < n0 ? map[t] : -1; }
    _acqN = ns;
}
// Units moved while a run is in flight (sim_unit_state.js
// simUnitStateRelayoutStep): each step's pairs (from, to), replayed in order
// at the commit, after the run (which reads only its snapshot, by the slots
// as posted): every result by slot to the unit's new slot (the old one as a
// slot the run did not cover), the brain's targets following theirs
// (SIM_KERNEL_ACQ_REMAP). A unit from a slot past the run's (made after its
// post) brings none: the run did not see it.
// (The log: the steps' pairs one after another in a heap buffer (acq.mlog),
// where each step starts (_acqMoveAt), room for SIM_ACQ_MOVE_STEPS steps of
// the most pairs a step makes: a step finding no room waits, acqTierMoveRoom.)
const SIM_ACQ_MOVE_STEPS = 8;
let _acqMoves = [], _acqMoveLog = null;
function _acqMoveLogRoom() {
    const R = typeof _rl !== 'undefined' ? _rl : null, need = R ? 2 * R.maxPairs * SIM_ACQ_MOVE_STEPS : 0;
    if (!need) return null;
    if (!_acqMoveLog || _acqMoveLog.length < need || !simHeapHas(_acqMoveLog)) { if (_acqMoveLog) simHeapFree(_acqMoveLog); _acqMoveLog = simHeapArray(Int32Array, need); simParallelBind('acq.mlog', _acqMoveLog); }
    return _acqMoveLog;
}
// (Whether a step's pairs fit the log now.)
function acqTierMoveRoom() { return _acqStage !== 1 || _acqMoves.length < SIM_ACQ_MOVE_STEPS; }
function acqTierNoteMoves(pairs, n) {
    if (_acqStage !== 1 || !(n > 0)) return;
    const L = _acqMoveLogRoom();
    if (!L) return;
    const at = _acqMoves.length ? _acqMoves[_acqMoves.length - 1][0] + _acqMoves[_acqMoves.length - 1][1] : 0;
    L.set(pairs.subarray(0, 2 * n), 2 * at);
    _acqMoves.push([at, n]);
}
// (The slab past which a step must not move units while a run is in flight:
// its commit covers the slots it was posted with.)
function acqTierSlotLimit() { return _acqStage === 1 ? _acqN : Infinity; }
function _acqApplyMoves() {
    const L = _acqMoves;
    _acqMoves = [];
    if (!L.length || typeof _rl === 'undefined' || !_rl.fwd || !_acqMoveLog) return;
    const n = _acqN, P = _simParams;
    for (const [at, m] of L) {
        // (A stamp of its own, below the relayout's steps': the forward map is
        // never cleared.) Each result to its unit's new slot (SIM_KERNEL_ACQ_
        // REPLAY, the map written), then the brain's targets (SIM_KERNEL_ACQ_REMAP).
        const stamp = _rl.acqStamp = (_rl.acqStamp | 0) - 1 | 0, per = Math.max(64, Math.ceil(m / 64));
        P.fill(0, 0, 8);
        P[0] = m; P[1] = per; P[2] = n; P[3] = stamp; P[4] = at; P[5] = _rl.fwd.length;
        simParallelRun(SIM_KERNEL_ACQ_REPLAY, Math.ceil(m / per));
        P.fill(0, 0, 8);
        P[0] = n; P[1] = 65536; P[2] = _rl.fwd.length; P[3] = stamp;
        if (n > 0) simParallelRun(SIM_KERNEL_ACQ_REMAP, Math.ceil(n / 65536));
    }
}
function acqTierReset() {
    _acqMoves = [];
    simParallelBackgroundWait(ACQ_LANE);
    _acqStage = 0; _acqCommitTick = -1; _acqStepTick = -1;
    _acqKept.sver = -1; _acqKept.aver = -1;
    if (typeof towerAcqDrop === 'function') towerAcqDrop();
}
function _acqArray(name, Type, n) {
    let a = _simParReg[name];
    // (In the wasm heap: the scan's Rust twin reads them in place.)
    if (!a || a.constructor !== Type || a.length < n) { const old = a; a = simHeapArray(Type, Math.max(1024, n)); simParallelBind(name, a); simHeapFree(old); }
    return a;
}
// The job's own arrays (never another's: these names were bound to live
// arrays once), bound under their names.
const _acqOwn = {};
// The job's copies that are still good (their sources not written since they were made): the structure tables
// (2 MB at a 1024 map: written when a structure is made or goes, _simMoveStructVer) and the area graph (17 MB:
// made once a layout, _simAreaLayoutVer). Copied at every post they were 6 ms a post of this thread.
const _acqKept = { sver: -1, s0: null, s1: null, d0: null, d1: null, aver: -1, a0: null, a1: null, e0: null, e1: null };
function _acqOwnArray(name, Type, n) {
    let a = _acqOwn[name];
    if (!a || a.constructor !== Type || a.length < n) { const old = a; a = _acqOwn[name] = simHeapArray(Type, Math.max(1024, n)); if (old) simHeapFree(old); }
    if (_simParReg[name] !== a) simParallelBind(name, a);
    return a;
}
function _acqPost() {
    const S = _simUnitState;
    simParallelBackgroundWait(ACQ_LANE);
    _acqStage = 0;
    // (No units listed: still the towers' structure answers, tower.js towersTick steps the tier then.)
    const tw = typeof towerAcqWanted === 'function' && towerAcqWanted();
    if (!S || !_visCoverReady() || !_simMoveHostile || !_simMoveStruct || !_simStructCls || !spatialBlockCols || (spatialIndexEntries() <= 0 && !tw)) return;
    const n = S.owners.length, nc = CHUNKS_W * CHUNKS_H, ne = spatialIndexEntries(), C = _visCover, A = C.areaCount, np = C.players;
    if (!_combatScanOwnerMask && tw) { _combatScanOwnerMask = simHeapArray(Uint8Array, nc); _sxOwnerMaskEpoch = -1; }
    if ((!n && !tw) || !_combatScanOwnerMask) return;
    const cap = simReserveCap(n);
    if (_acq.cap < n) {
        _acqArray('acq.x', Float32Array, cap); _acqArray('acq.y', Float32Array, cap); _acqArray('acq.own', Int8Array, cap); _acqArray('acq.flags', Uint8Array, cap);
        _acqArray('acq.cmd', Uint8Array, cap); _acqArray('acq.rng', Float32Array, cap); _acqArray('acq.id', Int32Array, cap);
        _acqArray('acq.out', Int32Array, cap); _acqArray('acq.tid', Int32Array, cap); _acqArray('acq.sout', Int32Array, cap);
        // (The combat brain's: its inputs and its instructions.)
        _acqArray('acq.cm', Uint8Array, cap); _acqArray('acq.ct', Int32Array, cap); _acqArray('acq.ctid', Int32Array, cap); _acqArray('acq.rk', Uint8Array, cap);
        _acqArray('acq.bm', Uint8Array, cap); _acqArray('acq.bt', Int32Array, cap); _acqArray('acq.btid', Int32Array, cap);
        _acq.cap = cap;
    }
    simUnitTargetsResolve();
    const P = _simParams;
    P[0] = n; P[1] = 8192; P[2] = SIM_SEP_ABSENT; P[3] = CMD_ATTACKING; P[4] = SIM_COMBAT_BRAIN ? 1 : 0; P[5] = CMD_MOVING;
    // (And the units' look for the towers: tower.js towerAcqUnitMeta, P[6] / P[7].)
    if (typeof towerAcqUnitMeta === 'function') towerAcqUnitMeta(P, cap);
    // (Empty slabs only marked: k.rs k_acq_snap.)
    P[8] = simUnitStateSlabsBind();
    simParallelRun(SIM_KERNEL_ACQ_SNAP, Math.ceil(n / 8192));
    // The index, the owners per chunk and the hostile tables as they are:
    // the job reads them in place, done before the next tick's index
    // rebuild rewrites them (acqTierIndexWait; they change nowhere else).
    // The structure tables (queries refresh them mid-tick) and the cover:
    // copies.
    // (The live index for the job's first stage, which copies it into the
    // job's own arrays: see SIM_KERNEL_ACQ_OMT. The hostile tables copied
    // here: the next tick's movement run makes them again.)
    simParallelBind('acq.rsL', _sxStart); simParallelBind('acq.rcL', _sxCount); simParallelBind('acq.rstL', _sxStamp);
    simParallelBind('acq.esL', _sxESlot); simParallelBind('acq.omL', _combatScanOwnerMask);
    _acqOwnArray('acq.rs', Int32Array, nc); _acqOwnArray('acq.rc', Int32Array, nc); _acqOwnArray('acq.rst', Int32Array, nc);
    _acqOwnArray('acq.om', Uint8Array, nc); _acqOwnArray('acq.es', Int32Array, simReserveCap(ne));
    // (The copies in one job on the helpers.)
    const NT = GRID_W * GRID_H, cp = [_acqOwnArray('acq.hs', Int32Array, _simMoveHostile.length).subarray(0, _simMoveHostile.length), _simMoveHostile];
    if (_simMoveHostStruct) cp.push(_acqOwnArray('acq.hss', Int32Array, _simMoveHostStruct.length).subarray(0, _simMoveHostStruct.length), _simMoveHostStruct);
    {
        const K = _acqKept, d0 = _acqArray('acq.sown', Int8Array, NT), d1 = _acqArray('acq.scls', Int8Array, NT);
        if (K.sver !== _simMoveStructVer || K.s0 !== _simMoveStruct || K.s1 !== _simStructCls || K.d0 !== d0 || K.d1 !== d1) {
            cp.push(d0.subarray(0, NT), _simMoveStruct.subarray(0, NT), d1.subarray(0, NT), _simStructCls.subarray(0, NT));
            K.sver = _simMoveStructVer; K.s0 = _simMoveStruct; K.s1 = _simStructCls; K.d0 = d0; K.d1 = d1;
        }
    }
    const cov = _acqArray('acq.cover', Uint8Array, Math.max(1, np * A));
    for (let p = 0; p < np; p++) cp.push(cov.subarray(p * A, p * A + A), C.visible[p].subarray(0, A));
    simParallelCopyHeap(cp);
    simParallelBind('acq.agrid', _spatialAreaGridFlat());
    // First the owners per chunk transposed (SIM_KERNEL_ACQ_OMT: the Rust
    // scan reads a ring's columns as runs), then the scan. (Each stage's
    // params written whole.)
    _acqArray('acq.omt', Uint8Array, CHUNKS_W * CHUNKS_H);
    // (And the index's entries packed in its order: acq.ex... .)
    const ecap = simReserveCap(ne);
    const sampleBudget=Math.max(0,Math.min(256,Math.floor(SIM_ACQ_SAMPLE_BUDGET/4)*4));
    const areaTargets=SIM_ACQ_AREA_TARGETS,sampled=sampleBudget>0||areaTargets;
    if(!sampled){
        _acqArray('acq.ex', Float32Array, ecap); _acqArray('acq.ey', Float32Array, ecap);
        _acqArray('acq.eo', Int32Array, ecap); _acqArray('acq.ea', Int32Array, ecap); _acqArray('acq.eid', Int32Array, ecap);
    }
    // The job's stages, in order: the packing of the index (OMT), with the area
    // tables (the build, then its answers: one job a team and part) when
    // sampled, the scan, the combat brain. Each has its own params slot.
    const answers = areaTargets, playersK = Math.min(spatialUnitsComplexPlayerCount, np);
    // (Sampled with answers: the build's count, offsets and scatter, the
    // structure seeds, the answers and their pack, six stages; sampled
    // only: the build.)
    const scanSlot = 1 + (sampled ? (answers ? 6 : 1) : 0);
    const T = simParallelStageParams(ACQ_LANE, 0), B = simParallelStageParams(ACQ_LANE, scanSlot);
    T.fill(0); B.fill(0);
    const EPER = 4096, prepJobs = Math.max(Math.ceil(CHUNKS_H / 64), Math.ceil(ne / EPER));
    T[0] = CHUNKS_W; T[1] = CHUNKS_H; T[2] = 64; T[3] = ne; T[4] = EPER; T[5] = TILE; T[6] = GRID_W; T[7] = GRID_H;
    T[8]=sampled?1:0;
    // (Small chunks: a helper takes the tick's own jobs between them.)
    B[0] = n; B[1] = 256; B[3] = CHUNKS_W; B[4] = CHUNKS_H; B[5] = TILE; B[6] = _sxEpoch;
    B[7] = Math.min(spatialUnitsComplexPlayerCount, np); B[8] = CMD_IDLE; B[9] = CMD_ATTACK_MOVING;
    B[10] = SPATIAL_BLOCK_SIZE * CHUNK_SIZE; B[11] = spatialBlockCols; B[12] = spatialBlockRows; B[14] = CHUNK_SIZE;
    // (The units in the index's order: B[22], its entries B[23].)
    B[15] = GRID_W; B[16] = GRID_H; B[18] = CMD_ATTACKING; B[20] = A; B[21] = 1; B[22] = 1; B[23] = ne;
    B[24]=sampleBudget;B[25]=gameTime;
    B[28]=areaTargets?1:0;B[29]=AREA_UNIT_TILE_EQUIVALENT;
    // Then the combat brain on the scan's results (its own copy of the area
    // graph: the layout may change before the commit).
    const C3 = simParallelStageParams(ACQ_LANE, scanSlot + 1);
    C3.fill(0);
    if (SIM_COMBAT_BRAIN || sampled) {
        _simAreaCsr();
        areaRangeIndexEnsure();
        // (The sampled acquisition's own copy of the area graph.)
        if (sampled) {
            const K = _acqKept, a0 = _simParReg['area.off'], a1 = _simParReg['area.nb'], e0 = _acqArray('acq.aoff', Int32Array, a0.length), e1 = _acqArray('acq.anb', Int32Array, a1.length);
            if (K.aver !== _simAreaLayoutVer || K.a0 !== a0 || K.a1 !== a1 || K.e0 !== e0 || K.e1 !== e1) {
                e0.set(a0); e1.set(a1);
                K.aver = _simAreaLayoutVer; K.a0 = a0; K.a1 = a1; K.e0 = e0; K.e1 = e1;
            }
        }
        C3[0] = n; C3[1] = 2048; C3[2] = CMD_IDLE; C3[3] = CMD_ATTACK_MOVING; C3[4] = TILE; C3[5] = GRID_W; C3[6] = GRID_H; C3[7] = Math.min(spatialUnitsComplexPlayerCount, np); C3[8] = A; C3[9] = CMD_ATTACKING;
    }
    const stages=[[SIM_KERNEL_ACQ_OMT,prepJobs]];
    if(sampled){
        _acqArray('acq.saOff',Int32Array,A*np+1);
        for(const name of ['saCount','saCursor'])_acqArray('acq.'+name,Int32Array,A*np);
        for(const name of ['saSeen','saNearN'])_acqArray('acq.'+name,Int32Array,A);
        // (Each entry one record, x, y, slot, id: no owner, the bucket is the
        // owner's; acq_sample.rs e_put.)
        _acqArray('acq.saE',Int32Array,4*ecap);
        _acqArray('acq.saKey',Int32Array,ecap);
        const near=_acqArray('acq.saNear',Int32Array,areaTargets?1:A*64);
        const I=simParallelStageParams(ACQ_LANE,1);I.fill(0);I[0]=ne;I[20]=A;I[7]=B[7];
        I[15]=GRID_W;I[16]=GRID_H;I[28]=areaTargets?1:0;I[30]=1;I[5]=TILE;
        // (The slots, and the tiles an area step stands for: the answers stop at the farthest reach.)
        I[31]=n;I[29]=AREA_UNIT_TILE_EQUIVALENT;
        I[26]=_acqSampleNearVer!==_simAreaLayoutVer||_acqSampleNearOf!==near?1:0;
        if(!areaTargets){_acqSampleNearVer=_simAreaLayoutVer;_acqSampleNearOf=near;}
        if(areaTargets){
            for(const name of ['saNearest','saDistance'])_acqArray('acq.'+name,Int32Array,A*np);
            for(const name of ['saStructure','saStructureDistance'])_acqArray('acq.'+name,Int32Array,A*np*4);
            // (And all five answers of a team and area in one 32-byte record, the scan's.)
            _acqArray('acq.saRec',Int32Array,A*np*8);
            // (A queue a job: the answers' jobs run side by side.)
            _acqArray('acq.saQueue',Int32Array,A*playersK*5);
        }
        if(answers){
            // The build in entry ranges on the helpers (one serial job held a
            // helper ~20-30 ms), then a tile pass a team seeding the four
            // structure classes, then the answers (spreads only: I[35] 1).
            // (The same params in every stage's own slot.)
            // (A range's histogram covers every key, areas x teams (~253k at
            // a 1024 map): 24 of them were 24 MB to zero and for the serial
            // prefix to walk. Any count keeps the entries' order.)
            const ranges=Math.min(8,Math.max(1,Math.ceil(ne/8192)));
            I[33]=ranges;I[34]=Math.ceil(ne/ranges);I[35]=1;
            // (The towers look as far: the answers' depth, tower.js towerAcqMaxReach.)
            I[36]=typeof towerAcqMaxReach==='function'?towerAcqMaxReach():0;
            _acqArray('acq.saHist',Int32Array,ranges*A*I[7]);
            // (The pack's records a job: I[37].)
            const packPer=8192;I[37]=packPer;
            for(let slot=2;slot<=6;slot++)simParallelStageParams(ACQ_LANE,slot).set(I);
            stages.push([SIM_KERNEL_ACQ_AREA_COUNT,ranges],[SIM_KERNEL_ACQ_AREA_PREFIX,1],[SIM_KERNEL_ACQ_AREA_SCATTER,ranges],
                [SIM_KERNEL_ACQ_AREA_SEED,playersK],[SIM_KERNEL_ACQ_AREA_ANSWERS,playersK*5],[SIM_KERNEL_ACQ_AREA_PACK,Math.ceil(A*I[7]/packPer)]);
        }else stages.push([SIM_KERNEL_ACQ_AREA_BUILD,1]);
    }
    stages.push([SIM_KERNEL_ACQ_SCAN,Math.ceil((sampled?n:ne)/256)],[SIM_KERNEL_COMBAT_BRAIN,SIM_COMBAT_BRAIN?Math.ceil(n/2048):0]);
    // The towers, after the area answers (tower.js towerAcqPost: their rows'
    // snapshot now, the stage its params at its place in the chain).
    if(answers&&typeof towerAcqPost==='function'){const st=towerAcqPost(ACQ_LANE,stages.length,A,playersK);if(st)stages.push(st);}
    simParallelBackgroundChain(ACQ_LANE,stages);
    _acqBrain = SIM_COMBAT_BRAIN;
    _acqStage = 1; _acqN = n;
}
function _acqCommit() {
    if (_acqStage !== 1) return;
    simParallelBackgroundWait(ACQ_LANE);
    _acqStage = 0;
    if (_acqMoves.length) _acqApplyMoves();
    const S = _simUnitState;
    if (!S) return;
    const n = Math.min(_acqN, S.owners.length), P = _simParams;
    P[0] = n; P[1] = 8192; P[2] = gameTime;
    simParallelRun(SIM_KERNEL_ACQ_COMMIT, Math.ceil(n / 8192));
    if (_acqBrain) { P[0] = n; P[1] = 8192; simParallelRun(SIM_KERNEL_COMBAT_COMMIT, Math.ceil(n / 8192)); }
    // (The towers' answers into their rows.)
    if (typeof towerAcqCommit === 'function') towerAcqCommit();
    _acqCommitTick = gameTime;
}

// How far a unit may have moved within a tick since the unit index was
// built (a unit's step plus a push), for the collision pass's culling.
const UNIT_SEPARATION_INDEX_MARGIN = TILE * 0.5;
// Large worlds (slots) run the separation as a chain on the helpers (lane
// 0, see SIM_KERNEL_SEP_PACK: pack with the chunk aggregates, mark, pairs twice; Rust twins in wasm/src/lib.rs): started at the tick's start from the
// tick-start copy of the units (SIM_KERNEL_STATUS: x0/y0, sepD0/R0/L0) and
// the unit index, while the simulation thread does the unit pass; collected
// and applied after it (runUnitSeparationPass). Movers: units that moved by
// themselves last tick (_sepMoved). Each unit's contacts are looked at
// every other tick (staggered by id), its push spread over two ticks.
// Small worlds separate after the pass from where units are then.
let SEPARATION_SLOT_MIN_UNITS = 0;
// Stagger contact sampling across two updates. Each sample produces a velocity;
// half is used now and half on the next update, both multiplied by that
// update's simDk. Presentation interpolates the combined movement endpoint.
// Modes 1 (every unit) and 2 (even updates) remain available for diagnostics.
let UNIT_SEPARATION_MODE = 0;
let UNIT_SEPARATION_TIER_GAIN = 0.8;
let _sepPending = null, _sepDirty = true;
const SEP_PACK_PER = 1024, SEP_MARK_PER = 2048;
// The chain's arrays for n slots (the sums cleared once when new or after
// the small-world pass wrote them by unit index: the commit clears them as
// it reads them).
function _sepArrays(n) {
    _sepGrow(n);
    const S = _sep, cap = S.cap;
    // (Nothing per chunk: mark and pairs find neighbours through the entries.)
    for (const [name, Type, size] of [['ord', Int32Array, cap], ['qx', Float32Array, cap], ['qy', Float32Array, cap], ['qv', Int32Array, cap],
        ['qr', Float32Array, cap], ['meta', Int32Array, cap], ['qid', Int32Array, cap], ['nextX', Float32Array, cap], ['nextY', Float32Array, cap], ['fast', Uint8Array, cap], ['ex', Int32Array, cap], ['exc', Int32Array, Math.ceil(cap / 512) + 1]]) _sepShared(S, name, Type, size);
    // The pair kernel's sums (px, py: Int32; ov: Float32; hit: Uint32) in
    // one block, zeroed by the chain's first stage (_sepZeroStage) before the
    // pairs add to them, off the movement kernel's way.
    // (Then the flow-relative response's: closing cx, cy and local flow fx,
    // fy, Int32 in 1/Q, see wasm/src/lib.rs pair_exact.)
    if (!S.sums || S.sums.length < 8 * cap || S.sums !== _simParReg['sep.sums']) {
        const old = S.sums, B = S.sums = simHeapArray(Int32Array, 8 * cap);
        S.px = simHeapView(B, Int32Array, 0, cap); S.py = simHeapView(B, Int32Array, 4 * cap, cap);
        S.ov = simHeapView(B, Float32Array, 8 * cap, cap); S.hit = simHeapView(B, Uint32Array, 12 * cap, cap);
        S.cx = simHeapView(B, Int32Array, 16 * cap, cap); S.cy = simHeapView(B, Int32Array, 20 * cap, cap);
        S.fx = simHeapView(B, Int32Array, 24 * cap, cap); S.fy = simHeapView(B, Int32Array, 28 * cap, cap);
        simParallelBind('sep.sums', B); simParallelBind('sep.px', S.px); simParallelBind('sep.py', S.py); simParallelBind('sep.ov', S.ov); simParallelBind('sep.hit', S.hit);
        simParallelBind('sep.cx', S.cx); simParallelBind('sep.cy', S.cy); simParallelBind('sep.fx', S.fx); simParallelBind('sep.fy', S.fy);
        if (old) simHeapFree(old);
    }
    if (_sepDirty || S.sumsCap !== cap) { S.sums.fill(0); _sepDirty = false; S.sumsCap = cap; }
}
// The chain's stage clearing the pair kernel's sums (SIM_KERNEL_ZERO).
function _sepZeroStage() {
    const B = _sep.sums, bytes = B.length * 4;
    return [SIM_KERNEL_ZERO, Math.ceil(bytes / SIM_ZERO_PER), [B.byteOffset, bytes, SIM_ZERO_PER]];
}
// Whether separationStart will take the separation prebuilt after the last
// tick (its own test).
function _sepPrebuiltForTick() {
    const U = _simUnitState;
    return !!(U && units.length >= SEPARATION_SLOT_MIN_UNITS && CHUNKS_W * CHUNKS_H < SIM_SEP_ABSENT && _sepPre && _sepPre.taken && _sepPre.tick === currentTick && _sepPre.n <= U.owners.length);
}
function separationStart() {
    _sepPending = null;
    if (typeof SIM_OCCUPANCY_ENABLED !== 'undefined' && SIM_OCCUPANCY_ENABLED) return;
    const U = _simUnitState;
    if (!U || units.length < SEPARATION_SLOT_MIN_UNITS || !(CHUNKS_W * CHUNKS_H < SIM_SEP_ABSENT)) return;
    // Made after the last tick with the unit index (spatialIndexPrebuild):
    // taken after this tick's unit pass.
    if (_sepPre && _sepPre.taken && _sepPre.tick === currentTick && _sepPre.n <= U.owners.length) {
        _sepPending = { tick: currentTick, n: _sepPre.n, lane: SIM_LANE_IX };
        _sepPre = null;
        return;
    }
    _sepPre = null;
    const n = U.owners.length;
    _sepArrays(n);
    const S = _sep;
    const ne = spatialIndexEntries(), mode = UNIT_SEPARATION_MODE | 0;
    // (The separation's clock is the step's (currentTick), not game time: its
    // every other step and its stagger are of work, not of a rate; with
    // steps of two base ticks gameTime's parity never changed.)
    _sepPending = { tick: currentTick, n, lane: 0 };
    // (Not a separation tick: the commit applies the pushes carried over.)
    if (!ne || (mode === 2 && (currentTick & 1) !== 0)) return;
    simParallelBind('sep.eslot', _sxESlot); simParallelBind('sep.ekey', _sxEKey);
    simParallelBind('sep.rs', _sxStart); simParallelBind('sep.rc', _sxCount); simParallelBind('sep.rstamp', _sxStamp);
    const pad = Math.max(0, Number(CROSS_TEAM_UNIT_COLLISION_PADDING) || 0), maxR = Math.max(0.1, _maxUnitCollisionRadius()) * 1.1 + 0.75, cws = CHUNK_SIZE * TILE;
    // (Bands 2 * reach rows high: a unit's pushes reach that far around it,
    // see SIM_KERNEL_SEP_PAIRS.)
    const farAny = 2 * maxR + pad, reach = Math.max(1, Math.ceil(farAny / cws)), H = Math.max(2, 2 * reach);
    const bands = Math.ceil(CHUNKS_H / H);
    // (Every stage's params written whole: lane 0 is the state hash's too
    // (utils_snapshot.js SNAP_REGION), whose P[5] 1 would make the pack read
    // the live columns the pass is moving.)
    for (let st = 0; st < 6; st++) simParallelStageParams(0, st).fill(0);
    // (Stage 0 clears the sums: _sepZeroStage.)
    const Z = _sepZeroStage();
    let P = simParallelStageParams(0, 0);
    for (let k = 0; k < 3; k++) P[k] = Z[2][k];
    P = simParallelStageParams(0, 1);
    P[0] = ne; P[1] = SEP_PACK_PER; P[2] = getUnitCollisionRecalcTicks(); P[3] = currentTick; P[4] = mode;
    P = simParallelStageParams(0, 2);
    P[0] = ne; P[1] = SEP_MARK_PER; P[2] = _sxEpoch; P[3] = CHUNKS_W; P[4] = CHUNKS_H; P[5] = currentTick; P[6] = mode;
    for (let parity = 0; parity < 2; parity++) {
        P = simParallelStageParams(0, 3 + parity);
        P[0] = CHUNKS_W; P[1] = CHUNKS_H; P[2] = H; P[3] = pad; P[4] = farAny; P[5] = UNIT_SEPARATION_Q;
        P[6] = UNIT_SEPARATION_SHARE_BOTH; P[7] = UNIT_SEPARATION_SHARE_ONE; P[9] = ne; P[10] = cws; P[11] = _sxEpoch;
        P[12] = UNIT_SEPARATION_SHARE_MOVER; P[13] = UNIT_SEPARATION_SHARE_YIELD; P[14] = parity; P[16] = UNIT_SEPARATION_PAIR_BUDGET;
    }
    simParallelBackgroundChain(0, [[SIM_KERNEL_ZERO, Z[1]], [SIM_KERNEL_SEP_PACK, Math.ceil(ne / SEP_PACK_PER)], [SIM_KERNEL_SEP_MARK, Math.ceil(ne / SEP_MARK_PER)],
        [SIM_KERNEL_SEP_PAIRS, Math.ceil(bands / 2)], [SIM_KERNEL_SEP_PAIRS, Math.floor(bands / 2)]]);
}
// The next tick's separation as stages of the unit index's prebuild chain
// (chunk.js spatialIndexPrebuild, after a tick's end, from the state the
// next tick starts from: the live columns and the index being built, its
// entry count read by the kernels), or null. tick: the next step (currentTick).
let _sepPre = null, SEPARATION_PREBUILD = true;
function separationPrebuildStages(n, ep, tick) {
    _sepPre = null;
    if (typeof SIM_OCCUPANCY_ENABLED !== 'undefined' && SIM_OCCUPANCY_ENABLED) return null;
    const U = _simUnitState;
    if (!SEPARATION_PREBUILD) return null;
    if (!U || n < SEPARATION_SLOT_MIN_UNITS || !(CHUNKS_W * CHUNKS_H < SIM_SEP_ABSENT)) return null;
    const mode = UNIT_SEPARATION_MODE | 0;
    if (mode === 2 && (tick & 1) !== 0) return null;
    const ns = U.owners.length;
    _sepArrays(ns);
    const S = _sep;
    simParallelBind('sep.eslot', _sxESlot); simParallelBind('sep.ekey', _sxEKey);
    simParallelBind('sep.rs', _sxStart); simParallelBind('sep.rc', _sxCount); simParallelBind('sep.rstamp', _sxStamp);
    const pad = Math.max(0, Number(CROSS_TEAM_UNIT_COLLISION_PADDING) || 0), maxR = Math.max(0.1, _maxUnitCollisionRadius()) * 1.1 + 0.75, cws = CHUNK_SIZE * TILE;
    const farAny = 2 * maxR + pad, reach = Math.max(1, Math.ceil(farAny / cws)), H = Math.max(2, 2 * reach), bands = Math.ceil(CHUNKS_H / H);
    // (Job counts for every unit: the kernels stop at the entries listed.)
    const pairs = parity => [CHUNKS_W, CHUNKS_H, H, pad, farAny, UNIT_SEPARATION_Q, UNIT_SEPARATION_SHARE_BOTH, UNIT_SEPARATION_SHARE_ONE, 0, n, cws, ep,
        UNIT_SEPARATION_SHARE_MOVER, UNIT_SEPARATION_SHARE_YIELD, parity, 1, UNIT_SEPARATION_PAIR_BUDGET];
    _sepPre = { tick, n: ns, ep };
    return [_sepZeroStage(), [SIM_KERNEL_SEP_PACK, Math.ceil(n / SEP_PACK_PER), [n, SEP_PACK_PER, getUnitCollisionRecalcTicks(), tick, mode, 1]],
        [SIM_KERNEL_SEP_MARK, Math.ceil(n / SEP_MARK_PER), [n, SEP_MARK_PER, ep, CHUNKS_W, CHUNKS_H, tick, mode, 1]],
        [SIM_KERNEL_SEP_PAIRS, Math.ceil(bands / 2), pairs(0)], [SIM_KERNEL_SEP_PAIRS, Math.floor(bands / 2), pairs(1)]];
}
// The prebuild chain's separation dropped (waited for: its sums are
// stale, cleared before the next use).
function separationPrebuildDrop() { if (_sepPre) { _sepPre = null; _sepDirty = true; } }
// The prebuilt index was taken (its epoch): its separation is this tick's.
function separationPrebuildTaken(ep) {
    if (_sepPre && _sepPre.ep === ep) _sepPre.taken = true;
    else _sepPre = null;
}
// A resync (every peer at the same tick): no push carried over.
function separationReset() {
    const U = _simUnitState;
    if (U) {
        U.columns.sepCx.fill(0); U.columns.sepCv.fill(0); U.columns.sepIv.fill(0);
        // Settling is derived from the cached force, dropped on every peer.
        const M = U.columns.sepMov;
        for (let s = 0; s < U.owners.length; s++) M[s] &= 1;
    }
}
function runUnitSeparationPass() {
    // (The pushes are the movement kernel's epilogue's: simMoveRun. A tick
    // whose movement kernel did not run leaves its sums: dropped, cleared
    // before the next use.)
    if (_sepPending && _sepPending.tick === currentTick) {
        simParallelBackgroundWait(_sepPending.lane | 0);
        _sepPending = null;
        _sepDirty = true;
    }
}

function applyUnitSeparation(unit, dx, dy, maxOverlap = unit.getCollisionRadius() * 2) {
    // Resolve crowded overlaps promptly, but never sum a hundred contacts into
    // a hundred-contact teleport. One correction is bounded by penetration.
    let total = Math.sqrt(dx * dx + dy * dy);
    let limit = Math.max(0, maxOverlap);
    if (total > limit) { dx *= limit / total; dy *= limit / total; }
    // Sweep large corrections, including enlarged units and enemy padding.
    // Axis sliding releases wall-side crowds without crossing a corner cap.
    let steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / (TILE / 4)));
    let startX = unit.x, startY = unit.y;
    for (let i = 1; i <= steps; i++) {
        let x = _quantizeUnitWorldCoord(startX + dx * i / steps);
        let y = _quantizeUnitWorldCoord(startY + dy * i / steps);
        if (!unit.isFlying) {
            let gx = Math.floor(unit.x / TILE), gy = Math.floor(unit.y / TILE);
            let nx = Math.floor(x / TILE), ny = Math.floor(y / TILE);
            let sideX = canUnitOccupyTile(unit, nx, gy), sideY = canUnitOccupyTile(unit, gx, ny);
            if (!canUnitOccupyTile(unit, nx, ny) || (gx !== nx && gy !== ny && (!sideX || !sideY))) {
                if (sideX && nx !== gx) unit.x = x;
                else if (sideY && ny !== gy) unit.y = y;
                break;
            }
        }
        unit.x = x; unit.y = y;
    }
}

function pushUnitOutOfBlockedTile(unit) {
    if (!unit || unit.dead || unit.isFlying) return;
    let gx = Math.floor(unit.x / TILE), gy = Math.floor(unit.y / TILE);
    // (Any tile not a wall, from the walls' byte a tile (the kernels' own,
    // current while no wall changed): no pointer to a cell object a unit.)
    if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H && !_simMoveWallDirty && _simMoveWallGrid === grid && _simMoveWall !== null && _simMoveWall.length === GRID_W * GRID_H && _simMoveWall[gy * GRID_W + gx] === 0) return;
    // (Any tile not a wall: canUnitOccupyTile's first answer, read before the
    // unit's cache fields, which miss whenever any tile changed anywhere.)
    const row = gx >= 0 && gx < GRID_W ? grid[gy] : null, cell = row ? row[gx] : null;
    if (cell && cellType[(cell) - 1] !== TYPE_WALL) return;
    if (canUnitOccupyTileCached(unit, gx, gy, 0)) return;

    let fromGx = Number.isFinite(unit.prevX) ? Math.floor(unit.prevX / TILE) : gx;
    let fromGy = Number.isFinite(unit.prevY) ? Math.floor(unit.prevY / TILE) : gy;
    let dest = findNearestWalkable(gx, gy, fromGx, fromGy, unit);
    if (!canUnitOccupyTile(unit, dest.x, dest.y)) return;

    unit.x = dest.x * TILE + TILE * 0.5;
    unit.y = dest.y * TILE + TILE * 0.5;
    unit.path = null;
    unit.pathIndex = 0;
    if (unit._pendingPathTarget) {
        _tryUpgradeAstarFallbackPath(unit);
        if (!unit.path || unit.path.length <= 0) {
            if (unit.workerState === 'MANUAL_MOVE') {
                unit.commandState = unit._pendingPathTarget.cmd;
                return;
            }
            unit.commandState = unit._pendingPathTarget.cmd;
        }
    }
}

const UNIT_STAR_PATH_CACHE = new Map();

function getUnitStarPath(radius) {
    let r = Math.max(1, Number(radius) || 1);
    let key = `${r}`;
    let cached = UNIT_STAR_PATH_CACHE.get(key);
    if (cached) return cached;

    let p = new Path2D();
    for (let i = 0; i < 5; i++) {
        let a = (i * 4 * Math.PI) / 5 - Math.PI / 2;
        let px = Math.cos(a) * r;
        let py = Math.sin(a) * r;
        if (i === 0) p.moveTo(px, py);
        else p.lineTo(px, py);
    }
    p.closePath();
    UNIT_STAR_PATH_CACHE.set(key, p);
    return p;
}


const UNIT_STATUS_GLYPH_CACHE = new Map();
const UNIT_STATUS_GLYPH_CACHE_MAX = 64;

function _getUnitStatusGlyphSprite(symbol, color, size = 'normal') {
    let txt = String(symbol || '');
    let scale = _getUiSpriteScale();
    let sizeKey = String(size || 'normal');
    let key = txt + '|' + String(color || '#fff') + '|' + scale + '|' + sizeKey;
    let cached = UNIT_STATUS_GLYPH_CACHE.get(key);
    if (cached) return cached;

    let compact = sizeKey === 'small';
    let w = compact ? 10 : 14;
    let h = compact ? 9 : 12;
    let c = document.createElement('canvas');
    c.width = w * scale;
    c.height = h * scale;
    let g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.clearRect(0, 0, w, h);
    g.font = compact
        ? '700 8px Segoe UI Emoji, Segoe UI Symbol, Segoe UI, Arial, sans-serif'
        : '700 10px Segoe UI Emoji, Segoe UI Symbol, Segoe UI, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = color;
    g.shadowColor = 'transparent';
    g.shadowBlur = 0;
    g.fillText(txt, w * 0.5, h * 0.5 + 0.5);
    g.shadowColor = 'transparent';

    cached = { canvas: c, width: w, height: h };
    UNIT_STATUS_GLYPH_CACHE.set(key, cached);
    _trimSpriteCache(UNIT_STATUS_GLYPH_CACHE, UNIT_STATUS_GLYPH_CACHE_MAX);
    return cached;
}

function drawUnitStatusGlyph(ctx, symbol, color, x, y, size = 'normal') {
    let s = _getUnitStatusGlyphSprite(symbol, color, size);
    let dx = Math.round(x - s.width * 0.5);
    let dy = Math.round(y - s.height * 0.5);
    queueDrawImage(ctx, s.canvas, dx, dy, s.width, s.height);
}

function drawCachedUnitStar(ctx, x, y, radius, color, strokeColor = '#000', lineWidth = 1) {
    let path = getUnitStarPath(radius);
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.fill(path);
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.stroke(path);
    ctx.restore();
}
// Body geometry is shared by immediate drawing and the strategic sprite cache.
// Units told apart by a mark on their shape: the healer's red cross, the
// researcher's R (on a triangle whose centre is cx, cy and half width tr;
// pointing down by default, up: the 3D top texture's).
function unitTypeMark(unitType) { return unitType === 'healer_unit' ? 'cross' : unitType === 'researcher_unit' ? 'R' : ''; }
function drawUnitTypeMark(ctx, mark, cx, cy, tr) {
    ctx.save();
    if (mark === 'cross') {
        const arm = tr * 0.4, half = tr * 0.13;
        ctx.fillStyle = '#e01818';
        ctx.fillRect(cx - half, cy - arm, half * 2, arm * 2);
        ctx.fillRect(cx - arm, cy - half, arm * 2, half * 2);
    } else if (mark === 'R') {
        ctx.fillStyle = '#06204a';
        ctx.font = 'bold ' + Math.max(5, Math.round(tr * 1.05)) + 'px Arial';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('R', cx, cy + tr * 0.04);
    }
    ctx.restore();
}
function drawUnitBodyGeometry(ctx, unit, strokeColor, lw) {
        if (unit.isSnake) {
            // Snakes render as their head only; the tail was removed.
            ctx.save();
            ctx.fillStyle = strokeColor;
            ctx.beginPath(); ctx.arc(unit.x, unit.y, unit.r + 1.5, 0, 6.28); ctx.fill();
            ctx.fillStyle = unit.color;
            ctx.beginPath(); ctx.arc(unit.x, unit.y, unit.r, 0, 6.28); ctx.fill();
            ctx.fillStyle = "black";
            ctx.beginPath(); ctx.arc(unit.x - 2, unit.y - 2, 1.5, 0, 6.28); ctx.fill();
            ctx.beginPath(); ctx.arc(unit.x + 2, unit.y - 2, 1.5, 0, 6.28); ctx.fill();
            ctx.restore();
        } else if (unit.vis === 'triangle') {
            ctx.fillStyle = unit.color; ctx.beginPath();
            // (The healer and the researcher: a bigger triangle with their
            // mark on it, a red cross and an R; the scout a plain small one.)
            let marked = unitTypeMark(unit.unitType);
            let tr = unit.r * (marked ? 0.95 : 0.5);
            ctx.moveTo(unit.x, unit.y + tr); ctx.lineTo(unit.x - tr, unit.y - tr); ctx.lineTo(unit.x + tr, unit.y - tr);
            ctx.closePath(); ctx.fill(); ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
            if (marked) drawUnitTypeMark(ctx, marked, unit.x, unit.y - tr * 0.36, tr);
        } else if (unit.vis === 'star') {
            if (unit.unitType === 'collector' || unit.unitType === 'astar_collector') {
                ctx.save();
                // Outline circle
                ctx.strokeStyle = strokeColor; ctx.lineWidth = lw;
                ctx.beginPath(); ctx.arc(unit.x, unit.y, unit.r, 0, 6.28); ctx.stroke();
                ctx.font = `${Math.round(unit.r * 2.4)}px Arial`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = unit.unitType === 'collector' ? '#ffd34d' : (unit.carryingValue > 0 ? '#f4f4f4' : '#9aa0a6');
                ctx.fillText(unit.unitType === 'collector' ? '⚡' : (unit.carryingValue > 0 ? '★' : '☆'), unit.x, unit.y + 1);
                ctx.restore();
            } else {
                drawCachedUnitStar(ctx, unit.x, unit.y, unit.r, unit.color, strokeColor, lw);
            }
        } else if (unit.vis === 'triangle_down') {
            ctx.fillStyle = unit.color; ctx.beginPath();
            let tr = unit.r;
            ctx.moveTo(unit.x, unit.y + tr); ctx.lineTo(unit.x - tr, unit.y - tr * 0.5); ctx.lineTo(unit.x + tr, unit.y - tr * 0.5);
            ctx.closePath(); ctx.fill(); ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
        } else if (unit.vis === 'mole') {
            ctx.fillStyle = unit.color; ctx.beginPath();
            ctx.ellipse(unit.x, unit.y, unit.r * 0.8, unit.r * 1.1, 0, 0, Math.PI * 2);
            ctx.fill(); ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
        } else if (unit.vis === 'rect') {
            let rr = unit.r;
            ctx.fillStyle = unit.color; ctx.fillRect(unit.x - rr, unit.y - rr * 0.7, rr * 2, rr * 1.4);
            ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.strokeRect(unit.x - rr, unit.y - rr * 0.7, rr * 2, rr * 1.4);
            if (unit.unitType === 'researcher_unit') {
                ctx.fillStyle = '#5af';
                ctx.fillRect(unit.x - rr * 0.3, unit.y - rr * 0.35, rr * 0.6, rr * 0.7);
                ctx.strokeStyle = '#93f';
                ctx.lineWidth = Math.max(1, lw * 0.8);
                ctx.strokeRect(unit.x - rr * 0.3, unit.y - rr * 0.35, rr * 0.6, rr * 0.7);
            }
        } else if (unit.vis === 'king') {
            let rr = unit.r;
            // Crown shape
            ctx.fillStyle = unit.color; ctx.beginPath();
            ctx.moveTo(unit.x - rr, unit.y + rr * 0.4);
            ctx.lineTo(unit.x - rr, unit.y - rr * 0.2);
            ctx.lineTo(unit.x - rr * 0.5, unit.y + rr * 0.1);
            ctx.lineTo(unit.x, unit.y - rr * 0.7);
            ctx.lineTo(unit.x + rr * 0.5, unit.y + rr * 0.1);
            ctx.lineTo(unit.x + rr, unit.y - rr * 0.2);
            ctx.lineTo(unit.x + rr, unit.y + rr * 0.4);
            ctx.closePath(); ctx.fill();
            ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
            // Jewel dots on crown tips
            ctx.fillStyle = '#f00';
            ctx.beginPath(); ctx.arc(unit.x - rr, unit.y - rr * 0.2, 1.5, 0, 6.28); ctx.fill();
            ctx.beginPath(); ctx.arc(unit.x, unit.y - rr * 0.7, 1.5, 0, 6.28); ctx.fill();
            ctx.beginPath(); ctx.arc(unit.x + rr, unit.y - rr * 0.2, 1.5, 0, 6.28); ctx.fill();
        } else {
            ctx.fillStyle = unit.color; ctx.beginPath(); ctx.arc(unit.x, unit.y, unit.r, 0, 6.28); ctx.fill();
            ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
        }

}
