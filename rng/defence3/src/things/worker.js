"use strict";

// Research is one pool per player: a researcher at a research building
// adds its trip's work (its rate times the building's efficiency) to its
// player's researchPoints every transfer cooldown, paying energy at the
// active task's cost per work, while the pool does not already cover that
// task (wasm/src/wai.rs research_deposit); researchDrainTick moves the pool
// into the research queue every RESEARCH_DRAIN_TICKS.
// Whether the active task still needs points beyond the pool's.
function _researchNeedsPoints(owner, task) {
    const p = players[owner];
    return !!task && (Number(task.workDone) || 0) + (Number(p && p.researchPoints) || 0) < (Number(task.workRequired) || 0);
}
const RESEARCH_DRAIN_TICKS = 10;
// Every RESEARCH_DRAIN_TICKS: each player's research pool into its queue
// (tasks completed in turn; what is left waits for the next task).
function researchDrainTick() {
    if (!simStepCrosses(0, RESEARCH_DRAIN_TICKS)) return;
    for (let pid = 0; pid < players.length; pid++) {
        const p = players[pid];
        let pts = Number(p && p.researchPoints) || 0;
        if (!(pts > 0)) continue;
        for (let guard = 0; guard < 64 && pts > 0; guard++) {
            const task = tryAdvancePlayerResearchTask(pid);
            if (!task) break;
            const done = Number(task.workDone) || 0, rem = Math.max(0, (Number(task.workRequired) || 0) - done), used = Math.min(rem, pts);
            task.workDone = done + used; pts -= used;
            if (task.workDone < task.workRequired) break;
            completeActiveResearchTaskForPlayer(pid, task);
        }
        p.researchPoints = pts;
    }
}

const WORKER_MANUAL_MOVE_MAX_PENDING_TICKS = 120;

// A worker's way to tile (targetGx, targetGy): the flow navigation alone (no
// search: a nav node toward the tile, or the open tile nearest it). null:
// no way there (the worker stays; its task looks again later).
function _requestWorkerPath(u, startGx, startGy, targetGx, targetGy, canWalk = null, cacheProfileHint = null, force = false) {
    if (!u || typeof navPathTo !== 'function') return null;
    return navPathTo(u, targetGx, targetGy);
}


// Worker AI logic - runs inside Unit.update() for collector/salvager/builder/healer types
// Helpers of updateWorkerAI (module functions: no closures per worker per tick).
function _workerSpawnerRoute(u, type) {
    return _findBestSpawnerRoute(u, type);
}
function _workerRunHealerRetargetIfDue(u, canRunHeavyAi, myGx, myGy) {
    // (Registered: the tier hands it its work.)
    if (_wsRegistered(u)) return false;
    if (!shouldRunWorkerIdleRetarget(u, canRunHeavyAi)) return false;
    _healerFindTarget(u, myGx, myGy);
    return true;
}
function _workerIsNearManualMoveTarget(u) {
    if (!(u && u.targetPos && Number.isFinite(u.targetPos.x) && Number.isFinite(u.targetPos.y))) return false;
    let tol = Math.max(8, Math.min(TILE, Math.floor((Number(u.preComputed && u.preComputed.speed) || 1) * 2)));
    return detHypot(Number(u.targetPos.x) - Number(u.x), Number(u.targetPos.y) - Number(u.y)) <= tol;
}
function _workerFinishManualMoveToIdle(u) {
    _clearWorkerTarget(u, 'manual_move_done');
    clearWorkerTaskMemoryForFreeRetarget(u);
    u.path = null;
    u.pathIndex = 0;
    u._pendingPathTarget = null;
    u.pathIsFallbackAstar = false;
    u.targetPos = null;
    u._manualMoveIssuedTick = 0;
    // The player sent it here: it looks for work at once.
    u._workerNextIdleRetargetTick = gameTime; u._idleFailVer = -1;
    u.workerState = 'IDLE';
    u.commandState = CMD_IDLE;
}

// A worker on its way (a moving state, its path not done) looks at its task
// (still there? still its own?) every WORKER_MOVE_CHECK_TICKS ticks,
// staggered by id; between those it only walks, exactly as the movement
// kernel walks it (which hands it back on those ticks; not a MANUAL_MOVE
// one: its look, with its path not done, only keeps it moving).
// (128: at 400k units ~2.5k workers a tick ran Unit.update for it at 32.)
const WORKER_MOVE_CHECK_TICKS = 128;
const BUILDER_WATCH_TICKS = 64;
const _WORKER_MOVING_STATES = new Set(['MANUAL_MOVE', 'MOVING_TO', 'MOVING_TO_ASTAR', 'RETURNING', 'RETURNING_ASTAR', 'MOVING_TO_BUILD', 'RETURNING_FOR_GOLD', 'MOVING_TO_HEAL', 'MOVING_TO_RESEARCH']);
function isWorkerBetweenMoveChecks(u) {
    return !simStepCrosses(u.id | 0, WORKER_MOVE_CHECK_TICKS) && _WORKER_MOVING_STATES.has(u.workerState)
        && !!u.path && u.pathIndex < u.path.length && !u.holdPosition;
}

// Work already accepts an adjacent tile. Exclusive occupancy may prevent
// reaching the final node inside the target; finish that approach on the
// existing worker check cadence instead of waiting forever for path completion.
function _workerFinishApproachInRange(u) {
    if (u.holdPosition || u.workerState === 'MANUAL_MOVE' || !_WORKER_MOVING_STATES.has(u.workerState)
        || !u.path || u.pathIndex >= u.path.length) return false;
    const returning = u.workerState === 'RETURNING' || u.workerState === 'RETURNING_ASTAR' || u.workerState === 'RETURNING_FOR_GOLD';
    const target = returning ? (u._builderSpawnerTarget || u._healerSpawnerTarget || u.path[u.path.length - 1]) : u.workerTarget;
    if (!target) return false;
    const gx = Number.isFinite(target.gx) ? target.gx : returning ? target.x : Math.floor(_thingTickX(target) / TILE);
    const gy = Number.isFinite(target.gy) ? target.gy : returning ? target.y : Math.floor(_thingTickY(target) / TILE);
    if (Math.abs(Math.floor(u.x / TILE) - gx) > 1 || Math.abs(Math.floor(u.y / TILE) - gy) > 1) return false;
    _clearWorkerAutoRoute(u);
    return true;
}

function updateWorkerAI(u) {
    if (!u.workerState) return;
    if (isWorkerBetweenMoveChecks(u)) return;
    // At work (gathering, building, healing, researching, depositing...):
    // every action waits for the transfer cooldown, so while it runs the
    // worker only stands or walks on, looking at nothing (a standing one is
    // parked until it runs out, simMoveTryParkWork). A player's move order
    // is followed regardless.
    if (u.workerTransferCooldown > 0 && u.workerState !== 'MANUAL_MOVE') return;
    _workerFinishApproachInRange(u);
    let workerAiTickDelay = Math.max(1, Math.floor(Number(WORKER_AI_TICK_DELAY) || 1));
    let canRunHeavyAi = simStepCrosses(u.id, workerAiTickDelay);

    // A held worker keeps its task; it just cannot walk. Do not let the
    // wait count as being stuck once it is released.
    if (u.holdPosition) u._builderLastMoveTick = gameTime;
    let owner = u.owner;
    let myGx = Math.floor(u.x / TILE), myGy = Math.floor(u.y / TILE);
    // (workerTransferCooldown: counted down by the status pre-pass.)

    if (u.workerState === 'MANUAL_MOVE') {
        // Manual rally must stay in movement mode until target is reached or explicitly canceled.
        u.commandState = CMD_MOVING;

        // If pathing state was lost (e.g. after collisions/resync), rebuild from remembered manual target.
        if ((!u.path || u.pathIndex >= u.path.length) && !u._pendingPathTarget && u.targetPos && Number.isFinite(u.targetPos.x) && Number.isFinite(u.targetPos.y)) {
            let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
            let tgx = Math.floor(Number(u.targetPos.x) / TILE), tgy = Math.floor(Number(u.targetPos.y) / TILE);
            let dest = findNearestWalkable(tgx, tgy, ugx, ugy, u);
            let canWalk = getPathCanWalkForUnit(u);
            let rebuilt = _requestWorkerPath(u, ugx, ugy, dest.x, dest.y, canWalk, null, true);
            if (rebuilt && rebuilt.length > 0) {
                u.path = rebuilt;
                u.pathIndex = 0;
            } else {
                // No way there: it stops.
                _workerFinishManualMoveToIdle(u);
            }
            return;
        }

        if ((!u.path || u.pathIndex >= u.path.length) && u._pendingPathTarget) {
            if (_workerIsNearManualMoveTarget(u)) {
                _workerFinishManualMoveToIdle(u);
                return;
            }
            if (u.pathIsFallbackAstar) {
                _tryUpgradeAstarFallbackPath(u);
                // A successful upgrade installs the path and clears the pending target.
                if (!u._pendingPathTarget) return;
            }
            // (Not while the navigation has it on its way to the closest tile
            // it can reach, or waiting there: it has not arrived.)
            let issuedTick = Math.floor(Number(u._manualMoveIssuedTick) || 0), pt = u._pendingPathTarget;
            if (!(pt.sub > 0 || pt.ver > 0 || pt.at >= 0) && (gameTime - issuedTick) >= WORKER_MANUAL_MOVE_MAX_PENDING_TICKS) {
                _workerFinishManualMoveToIdle(u);
            }
            return;
        }
        if (!u.path || u.pathIndex >= u.path.length) {
            _workerFinishManualMoveToIdle(u);
        }
        return;
    }

    if (isResourceCollectorWorkerType(u.workerType)) {
        // (Collectors: the worker kernel's, wasm/src/wai.rs.)
        return;
    } else if (u.workerType === 'salvager') {
        // (Salvagers: the worker kernel's, wasm/src/wai.rs.)
    }
    // (Builders: the worker kernel's, wasm/src/wai.rs.)
    // (Healers: the worker kernel's, wasm/src/wai.rs.)
    // (Researchers: the worker kernel's, wasm/src/wai.rs.)
}

function _getResourceCollectorMineArray(resourceCfg) {
    if (!resourceCfg) return null;
    if (resourceCfg.mineArrayKey === 'goldMines') return goldMines;
    if (resourceCfg.mineArrayKey === 'astarMines') return astarMines;
    return null;
}

function _setResourceCollectorPinnedTarget(u, target, targetType, resourceCfg = null) {
    let cfg = resourceCfg || _getResourceCollectorConfigForUnit(u);
    let mem = _getResourceCollectorMemory(u);
    mem.pinnedTarget = target || null;
    mem.pinnedTargetType = targetType || null;
    if (!cfg) return;
    if (cfg.stockpileKey === 'energy') {
        u._collectorPinnedTarget = mem.pinnedTarget;
        u._collectorPinnedTargetType = mem.pinnedTargetType;
    } else if (cfg.stockpileKey === 'astar') {
        u._astarPinnedTarget = mem.pinnedTarget;
        u._astarPinnedTargetType = mem.pinnedTargetType;
    }
}

function _getResourceCollectorPinnedTarget(u, resourceCfg = null) {
    let cfg = resourceCfg || _getResourceCollectorConfigForUnit(u);
    let mem = _getResourceCollectorMemory(u);
    if (!mem.pinnedTarget && cfg) {
        if (cfg.stockpileKey === 'energy' && u._collectorPinnedTarget) {
            mem.pinnedTarget = u._collectorPinnedTarget;
            mem.pinnedTargetType = u._collectorPinnedTargetType || null;
        } else if (cfg.stockpileKey === 'astar' && u._astarPinnedTarget) {
            mem.pinnedTarget = u._astarPinnedTarget;
            mem.pinnedTargetType = u._astarPinnedTargetType || null;
        }
    }
    return { target: mem.pinnedTarget || null, targetType: mem.pinnedTargetType || null };
}

function _resourceCollectorGetGatherPerTrip(u, owner) {
    let gatherPerTrip = Number(u && u.preComputed && u.preComputed.gatherPerTrip);
    if (!Number.isFinite(gatherPerTrip) || gatherPerTrip <= 0) {
        let effLvl = getUnitEffectiveLevel(u, getUnitBaseLevel(u));
        gatherPerTrip = Number(u && u.preComputed && u.preComputed.gatherPerTrip);
    }
    if (!Number.isFinite(gatherPerTrip) || gatherPerTrip <= 0) gatherPerTrip = 1;
    return gatherPerTrip;
}

function _depositResourceCollectorPayload(u, owner, resourceCfg) {
    let amount = Math.max(0, Number(u.carryingValue) || 0);
    if (!(amount > 0) || !resourceCfg) return;
    addPlayerResource(owner, resourceCfg.stockpileKey, amount);
    if (resourceCfg.stockpileKey === 'energy') {
        recordEnergyDelta(owner, 'collect', amount);
    } else if (resourceCfg.stockpileKey === 'astar' && typeof recordAstarDelta === 'function') {
        recordAstarDelta(owner, amount, u, 'collect');
    }
    if (owner === localPlayerId && resourceCfg.dropoffSound) playSound(resourceCfg.dropoffSound, u.x, u.y);
}

function _resourceCollectorAssignTarget(u, target, targetType, resourceCfg) {
    if (!_setWorkerTarget(u, target, targetType)) {
        u.workerState = 'IDLE';
        u.commandState = CMD_IDLE;
        return;
    }
    let canWalk = targetType === resourceCfg.mineTileType ? _resourceCollectorCanWalk : null;
    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
    u.path = _requestWorkerPath(u, startGx, startGy, target.gx, target.gy, canWalk, resourceCfg.collectorUnitKey, true);
    if (u.path) {
        _rememberResourceCollectorGatherSite(u, target, targetType, resourceCfg);
        u.workerState = 'MOVING_TO';
        u.pathIndex = 0;
        u.commandState = CMD_MOVING;
    } else if (_workerHasPendingAutoRouteToTarget(u, target)) {
        _rememberResourceCollectorGatherSite(u, target, targetType, resourceCfg);
        u.workerState = 'MOVING_TO';
    } else {
        _clearWorkerAutoRoute(u);
        _clearWorkerTarget(u);
        u.workerState = 'IDLE';
        u.commandState = CMD_IDLE;
    }
}

// Mines never move. Bucket each mine array by 8x8 tiles; rebuild when the
// array is replaced or a depleted mine is spliced out (length change).
const _mineSpatialIndexes = new WeakMap();
const MINE_INDEX_BUCKET_TILES = 8;

function _getMineIndicesNear(mineArray, wx, wy, radiusPx) {
    let index = _mineSpatialIndexes.get(mineArray);
    if (!index || index.length !== mineArray.length || index.gridW !== GRID_W || index.gridH !== GRID_H) {
        let cols = Math.ceil(GRID_W / MINE_INDEX_BUCKET_TILES) + 1;
        index = { length: mineArray.length, gridW: GRID_W, gridH: GRID_H, cols, buckets: new Map(), loose: [] };
        for (let i = 0; i < mineArray.length; i++) {
            let mine = mineArray[i];
            let x = Number(mine && mine.x), y = Number(mine && mine.y);
            // Anything without a finite position is always visited, as before.
            if (!Number.isFinite(x) || !Number.isFinite(y)) { index.loose.push(i); continue; }
            let bx = Math.floor(x / (TILE * MINE_INDEX_BUCKET_TILES)), by = Math.floor(y / (TILE * MINE_INDEX_BUCKET_TILES));
            if (bx < 0 || by < 0 || bx >= cols) { index.loose.push(i); continue; }
            let key = by * cols + bx;
            let bucket = index.buckets.get(key);
            if (!bucket) index.buckets.set(key, bucket = []);
            bucket.push(i);
        }
        _mineSpatialIndexes.set(mineArray, index);
    }
    let span = TILE * MINE_INDEX_BUCKET_TILES;
    let minBx = Math.floor((wx - radiusPx) / span), maxBx = Math.floor((wx + radiusPx) / span);
    let minBy = Math.floor((wy - radiusPx) / span), maxBy = Math.floor((wy + radiusPx) / span);
    let out = index.loose.slice();
    for (let by = minBy; by <= maxBy; by++) {
        for (let bx = minBx; bx <= maxBx; bx++) {
            if (bx < 0 || bx >= index.cols) continue;
            let bucket = index.buckets.get(by * index.cols + bx);
            if (bucket) for (let i = 0; i < bucket.length; i++) out.push(bucket[i]);
        }
    }
    return out.sort((a, b) => a - b);
}

// ---- The worker search tier ----
// Workers' searches are not the tick's, and idle workers do not wake for
// them: a worker that needs work registers its search (wsRegister: its
// origin, radius, area steps, what it looks for, in its unit columns, O(1))
// and parks. Every WS_TICKS ticks the tier selects the registered workers
// due (the first post after they registered, then once in WS_RETRY ticks:
// SIM_KERNEL_WS_SELECT) and works their searches out on the helpers (lane
// WS_LANE, SIM_KERNEL_WS_SCAN) over typed tables of the sites (the
// collectors' site groups; the work site grid; healers' damaged units) while
// the ticks go on: the post at phase WS_POST_PHASE, the commit two ticks
// later, which hands every worker that found something its result at once
// (wasm/src/wai.rs take_one: the sites still valid, the first exclusive one,
// O(K) each; no share a tick, no cap); a worker that found nothing costs the
// tick nothing. Every peer posts and
// commits at the same ticks; a resync drops it all (and the registry) on
// every peer.
const WS_TICKS = 4, WS_POST_PHASE = 3, WS_K = 6, WS_RETRY = 20, WS_SEL_CHUNK = 4096;
const WS_BACKOFF_MANY = 1000000;
const WS_LANE = typeof SIM_LANE_T1 === 'number' ? SIM_LANE_T1 : 4;
const WS_COLLECT = 1, WS_GRID = 3;
// Registry kinds (unit.wsKind): a collector, a builder or salvager (the
// grid), a healer (the grid's queues and damaged units), a researcher (the
// grid, by its owner's research).
const WSR_COLLECT = 1, WSR_GRID = 3, WSR_HEAL = 4, WSR_RESEARCH = 5;
// (A search's answer: registered, wait for it.)
const WS_WAITING = Object.freeze({ wsWaiting: true });
// (_wsCur: the result of the take being made, { s: slot, id, kind, stamp,
// res, units }; a Map by slot set and emptied around each take was ~1.5 ms
// a tick of lookups.)
let _wsPosted = null, _wsCur = null, _wsCommitTick = -1, _wsStepTick = -1, _wsInCommit = false;
const _wsGroups = new Map();
function _wsAvailable() { return typeof SIM_KERNEL_WS_SCAN === 'number' && typeof simParallelBackground === 'function' && typeof _simUnitState !== 'undefined' && !!_simUnitState; }
function _wsRegistered(u) { const c = u && u._us; return !!c && c.wsKind[u._si] !== 0 && _wsAvailable(); }
// u's search into the registry (kind, req: owner's grid needs and the
// rest); at a commit (a search that found nothing valid) not as a fresh one.
function wsRegister(u, kind, req) {
    // (The search's fields are in its worker record: sim_unit_state.js simUnitWk.)
    const c = u._us, s = u._si, w = simUnitWk(c, s);
    c.wsKind[s] = kind; c.wsT[w] = _wsInCommit ? gameTime - WS_TICKS : gameTime;
    if (!_wsInCommit) c.wsFail[s] = 0;
    c.wsCfg[w] = Number.isFinite(req.cfg) ? req.cfg : -1; c.wsOU[w] = Number.isFinite(req.ou) ? req.ou : 0;
    c.wsOx[w] = Number.isFinite(req.ox) ? req.ox : NaN; c.wsOy[w] = Number.isFinite(req.oy) ? req.oy : NaN;
    c.wsR[w] = Number(req.r) || 0; c.wsAk[w] = Number.isFinite(req.areaSteps) ? Math.max(0, Math.min(127, Math.floor(req.areaSteps))) : -1;
    c.wsAx[w] = Number.isFinite(req.ax) ? req.ax : NaN; c.wsAy[w] = Number.isFinite(req.ay) ? req.ay : NaN;
    c.wsNeed[w] = req.need | 0; c.wsJid[w] = Number.isFinite(req.jid) ? req.jid : -1;
    c.wsCur[w] = Number.isFinite(req.cur) ? req.cur : -1; c.wsMy[w] = Number.isFinite(req.my) ? req.my : -1;
}
// u's committed result for this kind (its sites, best first), once; null
// when there is none (then register).
function wsTake(u, kind) {
    const r = _wsCur;
    if (r === null || r.s !== u._si || r.id !== u.id || r.kind !== kind || r.stamp !== _wsCommitTick) return null;
    _wsCur = null;
    return r.res;
}
// A registered worker: idle, parked till the tier hands it work (see
// simMoveTryPark).
function _wsWait(u) {
    u.workerState = 'IDLE'; u.commandState = CMD_IDLE;
}
function workerSearchTierReset() {
    if (typeof simParallelBackgroundWait === 'function') simParallelBackgroundWait(WS_LANE);
    _wsPosted = null; _wsCur = null; _wsCommitTick = -1; _wsStepTick = -1; _wsInCommit = false;
    _wsGroups.clear(); _wsGroupById.length = 0; _wsPostEpoch = 0;
    _wsw = null; _wswDirty = []; _wswResvRoom()[0] = 0;
    if (typeof _simUnitState !== 'undefined' && _simUnitState) _simUnitState.columns.wsKind.fill(0);
}
// Once a tick, before the unit pass: the commit, the grid's changes (while
// no search runs: phases 1 after the commit, 2, 3 before the post), the post.
function workerSearchTierStep() {
    if (_wsStepTick === gameTime || !_wsAvailable()) return;
    _wsStepTick = gameTime;
    // (Each base tick of the step in turn: one cycle's phases at most, the
    // sweep's parts of all of them.)
    for (let b = gameTime - simDk + 1; b <= gameTime; b++) {
        const ph = ((b % WS_TICKS) + WS_TICKS) % WS_TICKS, cycle = gameTime - b < WS_TICKS;
        if (cycle && ph === (WS_POST_PHASE + 1) % WS_TICKS) _wsOrder();
        if (cycle && ph === (WS_POST_PHASE + 2) % WS_TICKS) _wsCommit();
        // (Past WSW_SLOW_UNITS units the sweep takes only every WSW_SLOW-th cycle's slices, each
        // visiting the next ones: the same coverage WSW_SLOW times slower. Stateless: by the tick.)
        const wswSlow = units.length >= WSW_SLOW_UNITS ? WSW_SLOW : 1, wswCycle = Math.floor(b / WS_TICKS);
        if (ph !== (WS_POST_PHASE + 1) % WS_TICKS) _wswStep((Math.floor(wswCycle / wswSlow) * 3 + (ph + WS_TICKS - (WS_POST_PHASE + 2) % WS_TICKS) % WS_TICKS) % WSW_SWEEP, wswCycle % wswSlow === 0);
        if (cycle && ph === WS_POST_PHASE) _wsPost();
    }
}

// ---- The work site grid ----
// Per tile, the work its owned structure (anchored there) offers workers
// (WSW_* bits from pure tests; the take tests the sites again live), its
// owner, the area it counts as in; on every tile, which worker types hold it
// reserved (workerReservedTiles: bit 1 << the type's load index, a live
// reserver; for the collectors' sites too); per 8x8 tiles, how many offer
// each kind (wsw.cnt); per owner, how many in all (oc). The search kernel
// reads it (kind WS_GRID), so it changes only between searches (the step
// ticks): from the tile journal (structures placed, removed), tiles marked
// (workSiteDirty: salvage marks, construction done, queues, effective
// levels), reservations changed (workerReservedSet), and a sweep of every
// owned structure in turn, each once in WSW_SWEEP steps (120 ticks: work that
// comes and goes without an event: damage, upgrades due after research,
// queue payments). Made anew after a resync on every peer.
const WSW_BUILD = 1, WSW_SALVAGE = 2, WSW_QUEUE = 4, WSW_RESEARCH = 8, WSW_AUTORES = 16, WSW_NBITS = 5;
// (90 steps: ~6 s. At 45, 18k structures were ~400 flag tests a step, ~1.2 ms
// a tick; what the sweep finds (damage, an upgrade come due) may wait.)
const WSW_SWEEP = 90, WSW_MAXOWN = 16;
const WSW_SLOW_UNITS = 250000, WSW_SLOW = 4;
let _wsw = null, _wswDirty = [];
// Reservation slots changed since the work site grid's last step: a heap list
// ([0] the count, the slots from 1) sized by the population (each unit at most
// once a tick; full: the grid is made again).
let _wswResvList = null;
function _wswResvRoom() {
    const n = typeof memoryBudgetUnits === 'function' && typeof getConfiguredMaxPop === 'function' ? Math.max(4096, memoryBudgetUnits(getConfiguredMaxPop(), Math.max(1, typeof activeTeamIds !== 'undefined' && activeTeamIds ? activeTeamIds.length : 2), GRID_W * GRID_H)) : 65536;
    if (!_wswResvList || _wswResvList.length !== n + 1 || (typeof simHeapHas === 'function' && !simHeapHas(_wswResvList))) {
        _wswResvList = typeof simSharedArray === 'function' ? simSharedArray(Int32Array, n + 1) : new Int32Array(n + 1);
        if (typeof simParallelBind === 'function') simParallelBind('wsw.resvDirty', _wswResvList);
    }
    return _wswResvList;
}
function _wswResvMark(slot) { const L = _wswResvList || _wswResvRoom(), n = L[0]; if (n + 1 < L.length) { L[n + 1] = slot; L[0] = n + 1; } else _wsw = null; }
// Rosters include unfinished buildings. Completion only publishes the first
// search batch allowed to use the existing row, never a roster rebuild.
let _wsPostEpoch = 0;
const _wsGroupById = [];
const WS_NOT_BUILT = 2147483647;
// The row of tile t in an ascending tile list (L[0 .. n)), -1 none.
function _wsTileRow(L, n, t) {
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (L[m] < t) lo = m + 1; else hi = m; }
    return lo < n && L[lo] === t ? lo : -1;
}
function workSiteDirty(gx, gy) {
    if (_wsw && gx >= 0 && gy >= 0 && gx < _wsw.w && gy < _wsw.h) _wswDirty.push(gy * _wsw.w + gx);
}
function workSiteBuilt(item) {
    if (!item || typeof item.type !== 'string') return;
    workSiteDirty(item.gx, item.gy);
    if (!(item.energy > 0)) return;
    // Its rows in the groups, by its tile (the groups' lists are in tile
    // order). One-way publication: an in-flight batch sees either NOT_BUILT
    // or a future epoch. Both reject the row, independent of helper scheduling.
    const t = item.gy * GRID_W + item.gx;
    for (const G of _wsGroupById) {
        if (!G || !G.arrays.tile) continue;
        const i = _wsTileRow(G.arrays.tile, G.n, t);
        if (i >= 0 && Atomics.load(G.arrays.sready, i) === WS_NOT_BUILT) Atomics.store(G.arrays.sready, i, _wsPostEpoch + 1);
        const k = G.arrays.qid ? _wsTileRow(G.arrays.qid, G.np | 0, t) : -1;
        if (k >= 0) { const q = G.arrays.qp[k]; if (Atomics.load(G.arrays.pready, q) === WS_NOT_BUILT) { Atomics.store(G.arrays.pready, q, _wsPostEpoch + 1); G.nfEligibilityDirty = true; } }
    }
}
// u's type's reservation bit (0: none), and the tile it holds reserved (-1).
function _wsResvBit(u) { const i = _workerTypeToLoadIndex(u.workerType); return i >= 0 && i < 8 ? 1 << i : 0; }
function _wsMyTile(u) {
    const slot = Number.isFinite(u._workerReservedTileIndex) ? Math.floor(u._workerReservedTileIndex) : -1;
    return slot >= 0 ? Math.floor(slot / _WORKER_TARGET_LOAD_TYPE_COUNT) : -1;
}
// The grid's entries for a list of tiles (wsw.rs k_wsw_set: each tile's owned
// structure's work flags, owner, area and reservation bits, the counts; mode 1
// only the reservation bits), from the structure tables, the id table and the
// static stat tables (k_adj_apply's: research, maximum energy).
const _WSW_CTAB_COLS = ['markedForSalvage', 'buildEnabled', 'queueEnabled', '_qN', '_qReq', '_qPaid', 'autoResearchEnabled'];
const _wswP = new Float64Array(16);
let _wswList = null;
function _wswTiles(n) { if (!_wswList || _wswList.length < n || !simHeapHas(_wswList)) _wswList = simSharedArray(Int32Array, Math.max(4096, n * 2)); return _wswList; }
function _wswRun(W, list, n, mode) {
    if (!(n > 0)) return;
    if (_ST.code && !simHeapHas(_ST.code)) structTablesRehome();
    if (!_ST.stab) return;
    const S = statTablesStatic(), X = _adjPlayerStats(S), NT = _adjTypeKeys(), R = _simParReg;
    const CT = _adjArr('adj.ctab', Int32Array, 9 * _ADJ_CTAB_COLS.length);
    _adjApplyClasses(CT);
    const WC = _adjArr('wsw.ctab', Int32Array, 9 * _WSW_CTAB_COLS.length), classes = STRUCT_STATUS_CLASSES(), w = _WSW_CTAB_COLS.length;
    for (let c = 0; c < 9; c++) {
        const T = classes[c] ? _sTables.get(classes[c]) : null;
        for (let j = 0; j < w; j++) { const a = T && T.n ? T['c_' + _WSW_CTAB_COLS[j]] : null; WC[c * w + j] = a && simHeapHas(a) ? _simWEnc(_simHeapPtrOf(a)) : 0; }
    }
    const U = typeof _simUnitState !== 'undefined' ? _simUnitState : null, idt = U && _unitById._ok() && simHeapHas(_unitById.t) ? _unitById.t : null;
    const rtype = _stationaryTypeIds.get('research'), P = _wswP;
    P[0] = n; P[1] = GRID_W; P[2] = MAX_THING_LEVEL; P[3] = NT; P[4] = S.nk; P[5] = X.np; P[6] = S.L1; P[7] = S.R1; P[8] = W.bw; P[9] = WSW_MAXOWN;
    P[10] = _WORKER_TARGET_LOAD_TYPE_COUNT; P[11] = idt ? idt.length : 1; P[12] = mode; P[13] = rtype === undefined ? 0 : rtype + 1;
    simRustDirect('k_wsw_set', [list, _ST.stab, _ST.rrow, _ST.uc, _ST.brain, CT, WC, R['adj.tykey'], R['adj.rml'], S.mxe, R['adj.rlv'],
        W.flags, W.own, W.area, W.resv, W.cnt, W.oc, cellArea, simHeapHas(workerReservedTiles) ? workerReservedTiles : null,
        idt, idt && U ? U.columns.id : null, idt && U ? U.columns.dead : null], P);
}
// A structure's work flags now (its tile through the kernel; tests).
function workSiteFlagsOf(e) {
    if (!_wsw) _wswStep(0, false);
    const t = e.gy * GRID_W + e.gx, L = _wswTiles(1);
    L[0] = t; _wswRun(_wsw, L, 1, 0);
    return _wsw.flags[t];
}
function _wswBuild() {
    const n = GRID_W * GRID_H, bw = Math.ceil(GRID_W / 8), bh = Math.ceil(GRID_H / 8);
    const W = _wsw = { w: GRID_W, h: GRID_H, n, bw, bh, set: _activeTileEntities, areaFor: areaIdGrid, resvFor: workerReservedTiles,
        flags: simSharedArray(Uint8Array, n), own: simSharedArray(Int8Array, n), area: simSharedArray(Int32Array, n), resv: simSharedArray(Uint8Array, n),
        cnt: simSharedArray(Int32Array, bw * bh * 8), oc: simSharedArray(Int32Array, WSW_MAXOWN * 8), cursor: { epoch: -1, pos: 0 } };
    W.own.fill(-1); W.area.fill(-1);
    for (const k of ['flags', 'own', 'area', 'resv', 'cnt']) simParallelBind('wsw.' + k, W[k]);
    tileEntityChangesSince(W.cursor);
    _wswDirty = []; _wswResvRoom()[0] = 0;
    // Every live reservation (mines and drops too), then every structure.
    const RS = workerReservedTiles, NT = _WORKER_TARGET_LOAD_TYPE_COUNT;
    for (let slot = 0; slot < RS.length; slot++) { const r = RS[slot] ? workerReservedAt(slot) : null; if (r && !r.dead) { const i = slot % NT; if (i < 8) W.resv[(slot - i) / NT] |= 1 << i; } }
    const m = _activeTileEntities.tileList();
    _wswRun(W, _activeTileEntities._tiles, m, 0);
}
// One step: the grid made (first, or after its sources were replaced), the
// journal's and marked tiles, reservations, and the sweep's share (every
// structure in tile order once in WSW_SWEEP steps).
function _wswStep(step, sweepOn = true) {
    if (typeof _activeTileEntities === 'undefined' || typeof tileEntityChangesSince !== 'function') return;
    let W = _wsw;
    if (!W || W.w !== GRID_W || W.h !== GRID_H || W.set !== _activeTileEntities || W.areaFor !== areaIdGrid || W.resvFor !== workerReservedTiles) { _wswBuild(); return; }
    const ch = tileEntityChangesSince(W.cursor);
    if (ch === null) { _wswBuild(); return; }
    const d = _wswDirty, occ = sweepOn ? _activeTileEntities.tileList() : 0, sw = occ > step ? Math.ceil((occ - step) / WSW_SWEEP) : 0;
    const L = _wswTiles(ch.length + d.length + sw), OT = _activeTileEntities._tiles;
    let n = 0;
    for (let i = 0; i < ch.length; i++) L[n++] = ch[i];
    for (let i = 0; i < d.length; i++) L[n++] = d[i];
    _wswDirty = [];
    for (let i = step; i < occ; i += WSW_SWEEP) L[n++] = OT[i];
    _wswRun(W, L, n, 0);
    // Reservations changed since the last step; the collectors' sites', in turn (a reserver that died since).
    const RL = _wswResvRoom(), NT = _WORKER_TARGET_LOAD_TYPE_COUNT;
    let groups = 0;
    if (sweepOn) for (const G of _wsGroups.values()) groups += G.n > step ? Math.ceil((G.n - step) / WSW_SWEEP) : 0;
    const L2 = _wswTiles(RL[0] + groups);
    let m = 0;
    for (let i = 1; i <= RL[0]; i++) { const t = Math.floor(RL[i] / NT); if (t < W.n) L2[m++] = t; }
    RL[0] = 0;
    if (sweepOn) for (const G of _wsGroups.values()) {
        const SX = G.arrays.sx, SY = G.arrays.sy;
        for (let s = step; s < G.n; s += WSW_SWEEP) {
            const gx = Math.floor(SX[s] / TILE), gy = Math.floor(SY[s] / TILE);
            if (gx >= 0 && gy >= 0 && gx < W.w && gy < W.h) L2[m++] = gy * W.w + gx;
        }
    }
    _wswRun(W, L2, m, 1);
}
// Whether owner has sites of a kind (as of the grid's last step; without
// the grid: yes).
function _wswOwnerHas(owner, bit) {
    const W = _wsw;
    if (!W || !(owner >= 0 && owner < WSW_MAXOWN)) return true;
    return W.oc[owner * 8 + (31 - Math.clz32(bit & -bit))] > 0;
}
// The tier's pick for u among the owner's grid sites offering `need`
// within r of the origin (an object; u itself: where it stands) and its area
// steps: the first of the kernel's best (by distance; with `jitter`, as
// _pickDistributedWorkerCandidate scores) that `valid` and exclusivity
// allow; null for none; WS_WAITING after registering (the caller parks u:
// _wsWait).
function _wsGridPick(u, need, origin, r, jitter, valid, targetType, kind = WSR_GRID) {
    const owner = u.owner, res = wsTake(u, WS_GRID);
    if (!res) {
        const rb = _wsResvBit(u), ci = 31 - Math.clz32(need & -need);
        const cur = u.workerTarget && Number.isFinite(u.workerTarget.gx) ? u.workerTarget.gy * GRID_W + u.workerTarget.gx : -1;
        wsRegister(u, kind, { ox: origin === u ? NaN : Number(origin.x), oy: origin === u ? NaN : Number(origin.y), r, areaSteps: _getWorkerAutoSearchDistanceArea(u),
            need: need | (ci << 8) | (rb << 16), jid: jitter ? (u.id | 0) : -1, cur, my: _wsMyTile(u) });
        return WS_WAITING;
    }
    const cc = {};
    for (const c of res) {
        const e = _ownedStructureAtTile(c.site);
        if (!e || e.owner !== owner || !valid(e)) continue;
        if (!_canAssignWorkerTargetExclusive(u, e, targetType, cc)) continue;
        return e;
    }
    return null;
}
// A healer's damaged unit from the tier's (the first still damaged that
// exclusivity allows).
function _wsHealUnit(u, list) {
    for (const t of list) if (_isHealerTargetUnit(t, u.owner) && _canAssignWorkerTargetExclusive(u, t, 'unit')) return t;
    return null;
}

// The collectors' site groups: per resource type, its drops, mines with
// something left and working farms (owner), and its working spawners; made
// again when one of those lists changed (or construction finished).
const WS_BUCKET = 8;
// The sites are written straight into the typed tables from the lists, in
// their order: drops, then mines with something left, then working farms
// (a site object per drop, mine and farm was ~20 ms a rebuild in a battle:
// drops last 120 s, tens of thousands of them, and every change of them
// makes the energy group again).
// A collector group's sites (its mines with gold or astar left, its farms
// alive) and its spawners (alive), in tile order, from the per-tile
// structure table by the kernel (ord.rs k_ws_group); then their buckets.
// (Drops: none are made in play; old snapshots' are not searched for.)
const _wsGP = new Float64Array(16);
let _wsGC = null;
function _wsGroupBuild(G, cfg) {
    if (_ST.code && !simHeapHas(_ST.code)) structTablesRehome();
    const T = _ST, n = T.n || 0, pre = 'wsg' + G.id + '.';
    const arr = (name, Type, len) => { let a = G.arrays[name]; if (!a || a.length < len || !simHeapHas(a)) { a = G.arrays[name] = simSharedArray(Type, Math.max(64, len * 2)); simParallelBind(pre + name, a); } return a; };
    if (!_wsGC || !simHeapHas(_wsGC)) _wsGC = simSharedArray(Int32Array, 4);
    const farmId = _stationaryTypeIds.get(cfg.farmKey), spId = _stationaryTypeIds.get(cfg.collectorBuildingKey), P = _wsGP, C = _wsGC;
    P[0] = 0; P[1] = n; P[2] = GRID_W; P[3] = cfg.mineArrayKey === 'astarMines' ? 0x77 : 0x66; P[4] = farmId === undefined ? 0 : farmId + 1; P[5] = spId === undefined ? 0 : spId + 1;
    P[6] = TILE; P[7] = WS_NOT_BUILT; P[8] = ST_OWNER_NONE;
    // (The structures' tiles, not every tile of the map: _wsCandidates.)
    const CAND = _wsCandidates(), cand = [];
    for (let j = 0; j < 13; j++) cand.push(null);
    cand.push(CAND.tiles);
    P[9] = CAND.n;
    C[0] = 0; C[1] = 0;
    if (n && T.code) simRustDirect('k_ws_group', [T.code, T.own, T.uc, T.val, T.brain, C, ...cand], P);
    const cap = C[0], np = C[1];
    const SX = arr('sx', Float32Array, cap), SY = arr('sy', Float32Array, cap), ST = arr('st', Int32Array, cap), SO = arr('so', Int32Array, cap);
    const SR = arr('sready', Int32Array, cap), TL = arr('tile', Int32Array, cap);
    // (The spawners as the kernel lists them, in tile order; sorted into their buckets below.)
    const QGX = arr('qgx', Int32Array, np), QGY = arr('qgy', Int32Array, np), QO = arr('qo', Int32Array, np), QID = arr('qid', Int32Array, np);
    const QX = arr('qx', Float32Array, np), QY = arr('qy', Float32Array, np), QR = arr('qready', Int32Array, np);
    if (n && T.code && (cap || np)) { P[0] = 1; simRustDirect('k_ws_group', [T.code, T.own, T.uc, T.val, T.brain, C, SX, SY, ST, SO, SR, TL, QGX, QGY, QO, QID, QX, QY, QR, CAND.tiles], P); }
    const bcols = Math.ceil(GRID_W / WS_BUCKET), brows = Math.ceil(GRID_H / WS_BUCKET), nb = bcols * brows;
    const BS = arr('bs', Int32Array, nb), BC = arr('bc', Int32Array, nb), BI = arr('bi', Int32Array, cap);
    arr('abc', Int32Array, nb); arr('abi', Int32Array, cap);
    const PGX = arr('pgx', Int32Array, np), PGY = arr('pgy', Int32Array, np), PO = arr('po', Int32Array, np), PID = arr('pid', Int32Array, np);
    const PX = arr('px', Float32Array, np), PY = arr('py', Float32Array, np), PR = arr('pready', Int32Array, np);
    // (A spawner's place: tile order (the q arrays) to bucket order (the p arrays), for workSiteBuilt.)
    const QP = arr('qp', Int32Array, np);
    // The sites by bucket (bs a bucket's first, bc its count, bi the sites); the
    // spawners sorted by the bucket of their tile (the kernel finds an owner's
    // nearest in rings of buckets): meta[5 + 2 b] a bucket's first, meta[6 + 2 b]
    // its count, then (16) the count of each owner's; (meta[5 + 2 nb + 16 + owner]:
    // the owner's slot in the nearest-spawner field, -1 none). Counting sorts: wsb.rs.
    const meta = arr('meta', Int32Array, 5 + 2 * nb + 32), sb = arr('sbk', Int32Array, np);
    // (And the near field's: rk / ro the spawners' tile order and back, hs the set's hashes.)
    const RK = arr('rk', Int32Array, np), RO = arr('ro', Int32Array, np), HS = arr('hs', Int32Array, 2);
    P[0] = cap; P[1] = np; P[2] = bcols; P[3] = brows; P[4] = TILE; P[5] = WS_BUCKET;
    simRustDirect('k_ws_buckets', [SX, SY, BS, BC, BI, QGX, QGY, QO, QID, QX, QY, QR, PGX, PGY, PO, PID, PX, PY, PR, QP, sb, meta, RK, RO, HS], P);
    G.np = np;
    _wsNearField(G, np, nb, arr, pre, PGX, PGY, PID, PO, meta);
    G.n = cap;
}
// A group's site i: its object (null: gone since the post) and its type name.
function _wsSiteTarget(g, i) {
    const t = g.tile[i], gx = t % GRID_W, gy = (t - gx) / GRID_W;
    return g.st[i] === 1 ? getTileEntityRef(gx, gy) : (grid[gy] && grid[gy][gx] && grid[gy][gx].item) || null;
}
// Each owner's nearest working spawner of the group per tile (k_ws_nearfield; the collectors' search finds it
// at once instead of in rings of buckets, ~900 buckets and 700 spawners a search at 2M workers far from
// their bases): the field slots in meta, the spawners' ranks by (row, column, id), and whether the fields
// are to be made again (the spawners as a set, or the owners among them, changed). The same answer as the
// ring search: both give the least (steps, row, column, id).
// (Off: the ring search as before; the same results either way, which the tests compare.)
let WS_NEARFIELD = true;
function _wsNearField(G, np, nb, arr, pre, PGX, PGY, PID, PO, meta) {
    G.nfBuild = false; G.nfList = [];
    if (!WS_NEARFIELD || !(np > 0 && np <= 65535)) { G.nfSetKey = null; return; }
    // (The set's hashes: wsb.rs k_ws_buckets.)
    const h1 = G.arrays.hs[0], h2 = G.arrays.hs[1];
    const owners = [];
    for (let o = 0; o < 16; o++) if (meta[5 + 2 * nb + o] > 0) owners.push(o);
    const ownersKey = owners.join(','), setKey = np + ':' + h1 + ':' + GRID_W + 'x' + GRID_H, ordKey = setKey + ':' + h2;
    // (At most 16M entries a group, 64 MB: past that the owners beyond keep the ring search.)
    const tiles = GRID_W * GRID_H, fieldOwners = owners.slice(0, Math.max(0, Math.floor(16777216 / tiles)));
    if (!fieldOwners.length) { G.nfSetKey = null; return; }
    fieldOwners.forEach((o, i) => { meta[5 + 2 * nb + 16 + o] = i; });
    const need = fieldOwners.length * tiles;
    let NF = G.arrays.nf, fresh = false;
    if (!NF || NF.length < need) { NF = G.arrays.nf = simSharedArray(Uint32Array, need); simParallelBind(pre + 'nf', NF); fresh = true; }
    // (rk / ro, the spawners by (gy, gx): tile order, one a tile: the kernel's.)
    const fkey = fieldOwners.join(',');
    G.nfBuild = fresh || G.nfSetKey !== setKey || G.nfOwnersKey !== fkey || !!G.nfEligibilityDirty;
    G.nfEligibilityDirty = false;
    G.nfSetKey = setKey; G.nfOrdKey = ordKey; G.nfOwnersKey = fkey; G.nfList = fieldOwners;
}
function _wsCollectorGroup(cfg) {
    const key = 'c:' + cfg.collectorUnitKey;
    let G = _wsGroups.get(key);
    if (!G) { G = { id: _wsGroups.size, key, sig: null, arrays: {}, n: 0 }; _wsGroups.set(key, G); _wsGroupById[G.id] = G; }
    // (Made again when any structure was placed or removed, or a spawner
    // came or went: the tile table's version.)
    const sig = _tileEntityVersion * 4096 + (typeof collectorSpawnersVersion === 'number' ? collectorSpawnersVersion % 4096 : 0);
    if (G.sig === sig && G.gridW === GRID_W) {
        if (G.nfEligibilityDirty) { G.nfBuild = true; G.nfEligibilityDirty = false; }
        return G;
    }
    G.sig = sig; G.gridW = GRID_W;
    _wsGroupBuild(G, cfg);
    return G;
}
function _wsArr(name, Type, n) {
    let a = _simParReg[name];
    // (Replaced by a larger one: the old one given back to the heap at once, not left to the collector: its payload arrays of a big round were ~390 MB held.)
    if (!a || a.constructor !== Type || a.length < n) { const old = a; a = simHeapArray(Type, Math.max(256, Math.ceil(n * 1.25 / 256) * 256)); simParallelBind(name, a); simHeapFree(old); }
    return a;
}
function _wsPost() {
    simParallelBackgroundWait(WS_LANE);
    _wsPosted = null;
    const S = _simUnitState;
    if (!S) return;
    const n = S.owners.length;
    if (!n) return;
    const CH = WS_SEL_CHUNK, chunks = Math.ceil(n / CH);
    const CNT = _wsArr('ws.rcnt', Int32Array, chunks), PRE = _wsArr('ws.rpre', Int32Array, chunks + 1);
    const P = _simParams;
    // (Workers registered since the last post made, P[3]; the retry slots as wide.)
    // (Steps of more base ticks than a cycle (simDk) post once a step: its
    // base ticks.)
    const win = Math.max(WS_TICKS, simDk);
    // (P[6]: how many times over a search that keeps finding nothing waits;
    // 8x the retry (160 ticks), 32x from WS_BACKOFF_MANY units: ~630k idle
    // workers at 2M searched ~4k a tick for nothing.)
    P[0] = n; P[1] = CH; P[2] = gameTime; P[3] = win; P[4] = WS_RETRY; P[5] = 1; P[6] = n >= WS_BACKOFF_MANY ? 5 : 3;
    // Count before allocating payloads. Both phases observe the same state:
    // no simulation writes occur between these synchronous jobs.
    simParallelRun(SIM_KERNEL_WS_SELECT, chunks);
    let total = 0;
    for (let c = 0; c < chunks; c++) { PRE[c] = total; total += CNT[c]; }
    PRE[chunks] = total;
    if (!total) return;
    _wsPostEpoch++;
    const cap = total;
    for (const k of ['ws.rslot', 'ws.rid', 'ws.rwt', 'ws.rkind', 'ws.rowner', 'ws.rak', 'ws.rgrp', 'ws.rneed', 'ws.rjid', 'ws.rcur', 'ws.rmy']) _wsArr(k, Int32Array, cap);
    for (const k of ['ws.rox', 'ws.roy', 'ws.rux', 'ws.ruy', 'ws.rr', 'ws.rax', 'ws.ray']) _wsArr(k, Float32Array, cap);
    _wsArr('ws.res', Int32Array, cap * WS_K); _wsArr('ws.score', Float32Array, cap * WS_K); _wsArr('ws.ures', Int32Array, cap * 3);
    // The registered workers due (the kernel, from their columns).
    P[5] = 2;
    simParallelRun(SIM_KERNEL_WS_SELECT, chunks);
    CNT[0] = total; // Compact requests are one logical region for ordering.
    // Stage 2 scans after eligibility compaction and near-field preparation.
    const Bp = _simBgStageParams[WS_LANE][2];
    // The collectors' groups, per resource type.
    const groups = [], nfSeen = new Set(), nfPairs = [];
    for (let k = 0; k < RESOURCE_TYPE_LIST.length && k < 8; k++) {
        const G = _wsCollectorGroup(RESOURCE_TYPE_LIST[k]); groups[k] = { tile: G.arrays.tile, st: G.arrays.st, cfg: RESOURCE_TYPE_LIST[k] }; Bp[16 + k] = G.id;
        // (Fields to make again: a job a (group, owner), before the scan in this chain.)
        if (G.nfBuild && !nfSeen.has(G.id)) { nfSeen.add(G.id); G.nfBuild = false; for (const o of G.nfList) if (nfPairs.length < 60) nfPairs.push(G.id * 16 + o); else { const nb = Math.ceil(GRID_W / WS_BUCKET) * Math.ceil(GRID_H / WS_BUCKET); _simParReg['wsg' + G.id + '.meta'][5 + 2 * nb + 16 + o] = -1; } }
    }
    // Per owner: its healers' damaged units (where they are now) and the
    // research its researchers serve.
    const np = Math.max(1, Math.floor(Number(players && players.length) || 0)), HM = HEALER_DAMAGED_CANDIDATE_LIMIT;
    const HX = _wsArr('wsh.x', Float32Array, np * HM), HY = _wsArr('wsh.y', Float32Array, np * HM), HA = _wsArr('wsh.a', Int32Array, np * HM), HN = _wsArr('wsh.n', Int32Array, np);
    _ensureHealerDamagedCandidatesCacheCurrent();
    const heal = [];
    for (let o = 0; o < np; o++) {
        const list = _healerDamagedCandidatesByOwner[o] || [], us = [];
        for (const e of list) {
            const t = e && e.u;
            if (!t || us.length >= HM) continue;
            const x = _unitTickX(t), y = _unitTickY(t), h = o * HM + us.length;
            HX[h] = x; HY[h] = y; HA[h] = getAreaIdAtWorld(x, y); us.push(t);
        }
        HN[o] = us.length; heal.push(us);
        if (o < 32) { const task = getPlayerResearchTask(o); Bp[24 + o] = task ? (_researchNeedsPoints(o, task) ? WSW_RESEARCH : 0) : (WSW_RESEARCH | WSW_AUTORES); }
    }
    // The area layout as of now (its arrays are never changed).
    simParallelBind('ws.agrid', _spatialAreaGridFlat());
    if (typeof _simAreaCsr === 'function') { _simAreaCsr(); simParallelBind('ws.aoff', _simParReg['area.off']); simParallelBind('ws.anb', _simParReg['area.nb']); }
    Bp[0] = total; Bp[1] = 16; Bp[2] = WS_K; Bp[3] = TILE; Bp[4] = WS_BUCKET; Bp[7] = TILE * 0.5; Bp[8] = GRID_W; Bp[9] = GRID_H;
    Bp[10] = _wsw ? _wsw.bw : 0; Bp[11] = 1; Bp[12] = total; Bp[13] = HM; Bp[14] = 1;
    Bp[5] = np; Bp[15] = _simParReg['ws.aoff'] ? _simParReg['ws.aoff'].length - 1 : 0;
    Bp[56]=areaSearchEnabled()?1:0;
    Bp[57]=_wsPostEpoch;
    // Near fields use stage 1; stage 0 compacts the eligible bucket rows.
    const Np = _simBgStageParams[WS_LANE][1];
    Np.fill(0); Np[0] = nfPairs.length; Np[1] = GRID_W; Np[2] = GRID_H;
    Np[63] = _wsPostEpoch;
    for (let i = 0; i < nfPairs.length; i++) Np[3 + i] = nfPairs[i];
    const eligibleGroups = [...new Set(groups.map((g, i) => Bp[16 + i]))];
    const Ep = _simBgStageParams[WS_LANE][0]; Ep.fill(0);
    Ep[0] = eligibleGroups.length; Ep[1] = 128; Ep[2] = _wsPostEpoch;
    const bucketJobs = Math.ceil(Math.ceil(GRID_W / WS_BUCKET) * Math.ceil(GRID_H / WS_BUCKET) / 128);
    Ep[3] = bucketJobs;
    for (let g = 0; g < eligibleGroups.length; g++) Ep[4 + g] = eligibleGroups[g];
    simParallelBackgroundChain(WS_LANE, [[SIM_KERNEL_WS_ELIGIBLE, eligibleGroups.length * bucketJobs], [SIM_KERNEL_WS_NEARFIELD, nfPairs.length], [SIM_KERNEL_WS_SCAN, Math.ceil(total / 16)]]);
    _wsPosted = { chunks: 1, CH: total, groups, heal, ordered: false };
}
// (Waited for here, the next phase: the scan reads the collectors' groups
// in place, which the unit pass may change; not chained with the ordering.)
function _wsOrder() {
    const J = _wsPosted;
    if (!J || J.ordered) return;
    simParallelBackgroundWait(WS_LANE);
    _wsArr('ws.order', Int32Array, J.chunks * J.CH);
    _wsArr('ws.orderCount', Int32Array, 1);
    const P = _simBgParamsByLane[WS_LANE];
    P[0] = J.chunks; P[1] = J.CH; P[2] = WS_K; P[3] = WSR_HEAL;
    simParallelBackground(SIM_KERNEL_WS_ORDER, 1, WS_LANE);
    J.ordered = true;
}
// The commit: every request that found something takes its result now, in
// the order's order, in the worker kernel (worker.js waiTake).
function _wsCommit() {
    if (!_wsPosted || !_wsPosted.ordered) return;
    simParallelBackgroundWait(WS_LANE);
    const J = _wsPosted;
    _wsPosted = null;
    if (!_simUnitState) return;
    _wsCommitTick = gameTime;
    const n = _simParReg['ws.orderCount'][0];
    if (n > 0) waiTake(J, _simParReg['ws.order'], n);
}

function _resourceCollectorFindTarget(u, myGx, myGy, resourceCfg) {
    let pinned = _getResourceCollectorPinnedTarget(u, resourceCfg);
    if (_isResourceCollectorTargetValid(pinned.target, pinned.targetType, u.owner, resourceCfg)
        && _canAssignWorkerTargetExclusive(u, pinned.target, pinned.targetType)) {
        _resourceCollectorAssignTarget(u, pinned.target, pinned.targetType, resourceCfg);
        return;
    }
    _setResourceCollectorPinnedTarget(u, null, null, resourceCfg);
    // The search tier's sites (WS_COLLECT): the valid ones, the pick among
    // them; none yet: a request, and wait.
    if (_wsAvailable() && u._us) {
        const cands = wsTake(u, WS_COLLECT);
        if (!cands) {
            // (Its origin: where it stands for its first 5 s idle, then its
            // last gather site: _getResourceCollectorSearchOrigin, by tick.)
            const mem = _getResourceCollectorMemory(u), gs = _resourceCollectorGatherSite(u, resourceCfg);
            const anchor = _isResourceCollectorSpawnerValidForUnit(u, mem.nextSpawner, resourceCfg) ? mem.nextSpawner
                : _isResourceCollectorSpawnerValidForUnit(u, mem.lastDropoffSpawner, resourceCfg) ? mem.lastDropoffSpawner : null;
            if (!u._lastIdleStateTime) u._lastIdleStateTime = gameTime;
            wsRegister(u, WSR_COLLECT, { cfg: RESOURCE_TYPE_LIST.findIndex(c => c.collectorUnitKey === resourceCfg.collectorUnitKey), ou: u._lastIdleStateTime + secondsToTicks(5),
                ox: gs ? gs.x : NaN, oy: gs ? gs.y : NaN, need: _wsResvBit(u) << 16, my: _wsMyTile(u),
                r: _getWorkerAutoSearchDistancePx(u), areaSteps:areaSearchEnabled()?_getWorkerAutoSearchDistanceArea(u):undefined,
                ax: anchor ? anchor.x : NaN, ay: anchor ? anchor.y : NaN });
            _wsWait(u);
            return;
        }
        const conflictCache = {}, candidates = [];
        for (const c of cands) {
            if (!_isResourceCollectorTargetValid(c.target, c.targetType, u.owner, resourceCfg)) continue;
            if (!_canAssignWorkerTargetExclusive(u, c.target, c.targetType, conflictCache)) continue;
            candidates.push({ target: c.target, targetType: c.targetType, dist: c.dist, worldDist: detHypot(c.target.x - u.x, c.target.y - u.y) });
        }
        const picked = _pickDistributedWorkerCandidate(u, candidates);
        if (picked && picked.target) { _resourceCollectorAssignTarget(u, picked.target, picked.targetType !== undefined ? picked.targetType : null, resourceCfg); return; }
        u.workerState = 'IDLE';
        u.commandState = CMD_IDLE;
        return;
    }

    let origin = _getResourceCollectorSearchOrigin(u, resourceCfg);
    let maxSearchPx = _getWorkerAutoSearchDistancePx(u);
    let maxSearchPxSq = maxSearchPx * maxSearchPx;
    const areaOnly=areaSearchEnabled(),maxSearchArea=_getWorkerAutoSearchDistanceArea(u);
    let mem = _getResourceCollectorMemory(u);
    let anchorSpawner = null;
    if (_isResourceCollectorSpawnerValidForUnit(u, mem.nextSpawner, resourceCfg)) {
        anchorSpawner = mem.nextSpawner;
    } else if (_isResourceCollectorSpawnerValidForUnit(u, mem.lastDropoffSpawner, resourceCfg)) {
        anchorSpawner = mem.lastDropoffSpawner;
    } else {
        anchorSpawner = _findClosestSpawner(u, resourceCfg.collectorBuildingKey);
    }

    let candidates = [];
    // One occupancy lookup per (synchronous) search instead of a unit scan
    // per candidate; nothing is assigned until the search completes.
    let conflictCache = {};
    let considerCandidate = (candidate, candidateType, dropPenalty = 0) => {
        if (!candidate) return;
        let dx = Number(candidate.x) - origin.x;
        let dy = Number(candidate.y) - origin.y;
        let originDistSq = dx * dx + dy * dy;
        if (!Number.isFinite(originDistSq)) return;
        if(areaOnly){if(!_isTargetWithinWorkerSearchLimits(u,origin.x,origin.y,candidate,maxSearchArea))return;}
        else if(originDistSq > maxSearchPxSq)return;
        if (!_canAssignWorkerTargetExclusive(u, candidate, candidateType, conflictCache)) return;

        let originDist = Math.sqrt(originDistSq);
        let spawnerDist = anchorSpawner
            ? detHypot(candidate.x - anchorSpawner.x, candidate.y - anchorSpawner.y)
            : detHypot(candidate.x - u.x, candidate.y - u.y);
        candidates.push({
            target: candidate,
            targetType: candidateType,
            dist: spawnerDist + originDist * 0.22 + dropPenalty,
            worldDist: detHypot(candidate.x - u.x, candidate.y - u.y)
        });
    };

    // Drops and farms: only those in buckets overlapping the search box.
    const searchBox=_workerSearchTileBox(u,origin.x,origin.y,maxSearchPx,0);
    let minGx=Math.max(0,searchBox[0]),minGy=Math.max(0,searchBox[1]),maxGx=Math.min(GRID_W-1,searchBox[2]),maxGy=Math.min(GRID_H-1,searchBox[3]);
    if (resourceCfg.supportsDropTarget) {
        _forEachStructureInTileBox(_droppedItemsForBuckets(), minGx, minGy, maxGx, maxGy, (drop) => considerCandidate(drop, 'drop', TILE * 0.5));
    }

    let mineArray = _getResourceCollectorMineArray(resourceCfg) || [];
    // Only mines inside the search box can pass considerCandidate; visit
    // those via a static bucket index, still in mine array order.
    const mineReach=areaOnly?Math.max(origin.x-minGx*TILE,(maxGx+1)*TILE-origin.x,origin.y-minGy*TILE,(maxGy+1)*TILE-origin.y):maxSearchPx;
    for (let index of _getMineIndicesNear(mineArray, origin.x, origin.y, mineReach)) {
        let mine = mineArray[index];
        if (!mine) continue;
        if (!(Number.isFinite(mine[resourceCfg.mineStatKey]) && mine[resourceCfg.mineStatKey] > 0)) continue;
        considerCandidate(mine, resourceCfg.mineTileType, 0);
    }

    // Farms are floor items, not collector spawners (the pick breaks ties by
    // target, so the visiting order does not matter).
    _forEachStructureInTileBox(_cellItemsOfType(resourceCfg.farmKey), minGx, minGy, maxGx, maxGy, (farm) => {
        if (farm.gx < minGx || farm.gx > maxGx || farm.gy < minGy || farm.gy > maxGy) return;
        if (!_isResourceCollectorTargetValid(farm, resourceCfg.farmKey, u.owner, resourceCfg)) return;
        considerCandidate(farm, resourceCfg.farmKey, 0);
    });

    let picked = _pickDistributedWorkerCandidate(u, candidates);
    if (picked && picked.target) {
        _resourceCollectorAssignTarget(u, picked.target, picked.targetType !== undefined ? picked.targetType : null, resourceCfg);
        return;
    }
    u.workerState = 'IDLE';
    u.commandState = CMD_IDLE;
}

function _getResourceCollectorConfigForUnit(u) {
    return getResourceCollectorConfigByWorkerType(u && u.workerType);
}

function _isResourceCollectorTargetValid(target, targetType, owner, resourceCfg) {
    if (!target || !resourceCfg) return false;
    if (targetType === resourceCfg.mineTileType) {
        return Number.isFinite(target[resourceCfg.mineStatKey]) && target[resourceCfg.mineStatKey] > 0;
    }
    if (targetType === resourceCfg.farmKey) {
        return target.type === resourceCfg.farmKey && target.owner === owner && !target.underConstruction && target.energy > 0;
    }
    if (targetType === 'drop') {
        return !!resourceCfg.supportsDropTarget && getDroppedItemAt(target.gx, target.gy) === target;
    }
    return false;
}

function _rememberResourceCollectorGatherSite(u, target = null, targetType = null, resourceCfg = null) {
    if (!u || !target) return;
    let cfg = resourceCfg || _getResourceCollectorConfigForUnit(u);
    let mem = _getResourceCollectorMemory(u);
    if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
        mem.lastGatherX = target.x;
        mem.lastGatherY = target.y;
    }
    if (Number.isFinite(target.gx) && Number.isFinite(target.gy)) {
        mem.lastGatherGx = target.gx;
        mem.lastGatherGy = target.gy;
    }
    if (targetType) mem.lastGatherType = targetType;
    if (!cfg) return;
    if (cfg.stockpileKey === 'energy') {
        u._collectorLastGatherX = mem.lastGatherX;
        u._collectorLastGatherY = mem.lastGatherY;
        u._collectorLastGatherGx = mem.lastGatherGx;
        u._collectorLastGatherGy = mem.lastGatherGy;
        u._collectorLastGatherType = mem.lastGatherType;
    } else if (cfg.stockpileKey === 'astar') {
        u._astarLastGatherX = mem.lastGatherX;
        u._astarLastGatherY = mem.lastGatherY;
        u._astarLastGatherGx = mem.lastGatherGx;
        u._astarLastGatherGy = mem.lastGatherGy;
    }
}

function _isResourceCollectorSpawnerValidForUnit(u, spawner, resourceCfg = null) {
    let cfg = resourceCfg || _getResourceCollectorConfigForUnit(u);
    if (!u || !spawner || !cfg) return false;
    return spawner.type === cfg.collectorBuildingKey
        && spawner.owner === u.owner
        && spawner.energy > 0
        && !spawner.underConstruction;
}

// A collector's last gather site (its search origin once idle 5 s), or null.
function _resourceCollectorGatherSite(u, cfg) {
    const mem = _getResourceCollectorMemory(u);
    if (Number.isFinite(mem.lastGatherX) && Number.isFinite(mem.lastGatherY)) return { x: mem.lastGatherX, y: mem.lastGatherY };
    if (cfg && cfg.stockpileKey === 'energy' && Number.isFinite(u._collectorLastGatherX) && Number.isFinite(u._collectorLastGatherY)) return { x: u._collectorLastGatherX, y: u._collectorLastGatherY };
    if (cfg && cfg.stockpileKey === 'astar' && Number.isFinite(u._astarLastGatherX) && Number.isFinite(u._astarLastGatherY)) return { x: u._astarLastGatherX, y: u._astarLastGatherY };
    return null;
}
function _getResourceCollectorSearchOrigin(u, resourceCfg = null) {
    let cfg = resourceCfg || _getResourceCollectorConfigForUnit(u);
    // (The worker itself: its search follows where it stands.)
    if (u && u.workerState === 'IDLE' && (gameTime - (u._lastIdleStateTime || 0)) < secondsToTicks(5)) {
        return u;
    }
    let mem = _getResourceCollectorMemory(u);
    if (u && Number.isFinite(mem.lastGatherX) && Number.isFinite(mem.lastGatherY)) {
        return { x: mem.lastGatherX, y: mem.lastGatherY };
    }
    if (cfg && cfg.stockpileKey === 'energy' && u && Number.isFinite(u._collectorLastGatherX) && Number.isFinite(u._collectorLastGatherY)) {
        return { x: u._collectorLastGatherX, y: u._collectorLastGatherY };
    }
    if (cfg && cfg.stockpileKey === 'astar' && u && Number.isFinite(u._astarLastGatherX) && Number.isFinite(u._astarLastGatherY)) {
        return { x: u._astarLastGatherX, y: u._astarLastGatherY };
    }
    return u;
}

function _getResourceCollectorGatherTargetAt(gx, gy, owner, resourceCfg, preferredType = null) {
    if (!resourceCfg || !Number.isFinite(gx) || !Number.isFinite(gy)) return null;
    if (preferredType === resourceCfg.mineTileType || preferredType === null) {
        let mine = getResourceMineAt(resourceCfg.key, gx, gy);
        if (mine && !(Number.isFinite(mine[resourceCfg.mineStatKey]) && mine[resourceCfg.mineStatKey] > 0)) mine = null;
        if (mine) return { target: mine, type: resourceCfg.mineTileType };
    }
    if (preferredType === resourceCfg.farmKey || preferredType === null) {
        if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H) {
            let cell = grid[gy][gx];
            let item = cell && cell.item;
            if (item && item.type === resourceCfg.farmKey && item.owner === owner && !item.underConstruction && item.energy > 0) {
                return { target: item, type: resourceCfg.farmKey };
            }
        }
    }
    if (resourceCfg.supportsDropTarget && (preferredType === 'drop' || preferredType === null)) {
        let drop = getDroppedItemAt(gx, gy);
        if (drop) return { target: drop, type: 'drop' };
    }
    return null;
}

function _getResourceCollectorGatherTargetNear(worldX, worldY, owner, resourceCfg, radius = 22) {
    if (!resourceCfg) return null;
    let best = null;
    let bestDist = radius;

    let gx = Math.floor(worldX / TILE), gy = Math.floor(worldY / TILE);
    let mineTileRadius = Math.max(1, Math.ceil(radius / TILE));
    let mineMinGx = Math.max(0, gx - mineTileRadius), mineMaxGx = Math.min(GRID_W - 1, gx + mineTileRadius);
    let mineMinGy = Math.max(0, gy - mineTileRadius), mineMaxGy = Math.min(GRID_H - 1, gy + mineTileRadius);
    for (let y = mineMinGy; y <= mineMaxGy; y++) {
        for (let x = mineMinGx; x <= mineMaxGx; x++) {
            let m = getResourceMineAt(resourceCfg.key, x, y);
            if (!m || !(Number.isFinite(m[resourceCfg.mineStatKey]) && m[resourceCfg.mineStatKey] > 0)) continue;
            let d = detHypot(m.x - worldX, m.y - worldY);
            if (d <= bestDist) {
                bestDist = d;
                best = { target: m, type: resourceCfg.mineTileType };
            }
        }
    }

    let minGx = Math.max(0, gx - 1), maxGx = Math.min(GRID_W - 1, gx + 1);
    let minGy = Math.max(0, gy - 1), maxGy = Math.min(GRID_H - 1, gy + 1);
    for (let y = minGy; y <= maxGy; y++) {
        for (let x = minGx; x <= maxGx; x++) {
            let cell = grid[y][x];
            let item = cell && cell.item;
            if (!item || item.type !== resourceCfg.farmKey || item.owner !== owner || item.underConstruction || item.energy <= 0) continue;
            let d = detHypot(item.x - worldX, item.y - worldY);
            if (d <= bestDist) {
                bestDist = d;
                best = { target: item, type: resourceCfg.farmKey };
            }
        }
    }
    if (resourceCfg.supportsDropTarget) {
        let minDropGx = Math.max(0, gx - 1), maxDropGx = Math.min(GRID_W - 1, gx + 1);
        let minDropGy = Math.max(0, gy - 1), maxDropGy = Math.min(GRID_H - 1, gy + 1);
        for (let y = minDropGy; y <= maxDropGy; y++) {
            for (let x = minDropGx; x <= maxDropGx; x++) {
                let drop = getDroppedItemAt(x, y);
                if (!drop) continue;
                let d = detHypot(drop.x - worldX, drop.y - worldY);
                if (d <= bestDist) {
                    bestDist = d;
                    best = { target: drop, type: 'drop' };
                }
            }
        }
    }
    return best;
}

function _isCollectorTargetValid(target, targetType, owner) {
    return _isResourceCollectorTargetValid(target, targetType, owner, getResourceTypeConfig('energy'));
}

function _collectorRememberGatherSite(u, target = null, targetType = null) {
    _rememberResourceCollectorGatherSite(u, target, targetType, getResourceTypeConfig('energy'));
}

function _isCollectorSpawnerValidForUnit(u, spawner) {
    return _isResourceCollectorSpawnerValidForUnit(u, spawner, getResourceTypeConfig('energy'));
}

function _collectorGetSearchOrigin(u) {
    return _getResourceCollectorSearchOrigin(u, getResourceTypeConfig('energy'));
}

function _getCollectorGatherTargetAt(gx, gy, owner, preferredType = null) {
    return _getResourceCollectorGatherTargetAt(gx, gy, owner, getResourceTypeConfig('energy'), preferredType);
}

function _getCollectorGatherTargetNear(worldX, worldY, owner, radius = 22) {
    return _getResourceCollectorGatherTargetNear(worldX, worldY, owner, getResourceTypeConfig('energy'), radius);
}

function _isAstarCollectorTargetValid(target, targetType, owner) {
    return _isResourceCollectorTargetValid(target, targetType, owner, getResourceTypeConfig('astar'));
}

function _getAstarCollectorGatherTargetAt(gx, gy, owner, preferredType = null) {
    return _getResourceCollectorGatherTargetAt(gx, gy, owner, getResourceTypeConfig('astar'), preferredType);
}

function _getAstarCollectorGatherTargetNear(worldX, worldY, owner, radius = 22) {
    return _getResourceCollectorGatherTargetNear(worldX, worldY, owner, getResourceTypeConfig('astar'), radius);
}

// Collector: find nearest gold mine/farm/drop, preferring area around last gather source.
function _collectorFindTarget(u, myGx, myGy) {
    if (_isCollectorTargetValid(u._collectorPinnedTarget, u._collectorPinnedTargetType, u.owner)
        && _canAssignWorkerTargetExclusive(u, u._collectorPinnedTarget, u._collectorPinnedTargetType)) {
        _collectorAssignTarget(u, u._collectorPinnedTarget, u._collectorPinnedTargetType, myGx, myGy);
        return;
    }
    u._collectorPinnedTarget = null;
    u._collectorPinnedTargetType = null;

    let origin = _collectorGetSearchOrigin(u);
    let maxSearchArea = _getWorkerAutoSearchDistanceArea(u);
    let anchorSpawner = null;
    if (_isCollectorSpawnerValidForUnit(u, u._collectorNextSpawner)) {
        anchorSpawner = u._collectorNextSpawner;
    } else if (_isCollectorSpawnerValidForUnit(u, u._collectorLastDropoffSpawner)) {
        anchorSpawner = u._collectorLastDropoffSpawner;
    } else {
        anchorSpawner = _findClosestSpawner(u, 'spawner');
    }

    let candidates = [];
    let conflictCache = {};

    forEachGridCellInAreaRange(origin.x, origin.y, maxSearchArea, (tileRef, cell) => {
        if (!tileRef || !cell) return false;

        let x = tileRef.x;
        let y = tileRef.y;
        let worldX = x * TILE + TILE * 0.5;
        let worldY = y * TILE + TILE * 0.5;
        let dx = worldX - origin.x;
        let dy = worldY - origin.y;
        let originDistSq = dx * dx + dy * dy;

        let drop = getDroppedItemAt(x, y);
        let mine = getGoldMineAt(x, y);
        let item = cell.item;

        let candidate = null;
        let candidateType = null;
        let dropPenalty = 0;

        if (drop) {
            candidate = drop;
            candidateType = 'drop';
            dropPenalty = TILE * 0.5;
        } else if (mine && mine.gold > 0) {
            candidate = mine;
            candidateType = 'mine';
        } else if (item && item.type === 'farm' && item.owner === u.owner && !item.underConstruction && item.energy > 0) {
            candidate = item;
            candidateType = 'farm';
        }

        if (!candidate) return false;
        if (!_isTargetWithinWorkerSearchLimits(u, origin.x, origin.y, candidate, maxSearchArea)) return false;
        if (!_canAssignWorkerTargetExclusive(u, candidate, candidateType, conflictCache)) return false;

        let originDist = Math.sqrt(originDistSq);
        let spawnerDist = anchorSpawner
            ? detHypot(candidate.x - anchorSpawner.x, candidate.y - anchorSpawner.y)
            : detHypot(candidate.x - u.x, candidate.y - u.y);

        candidates.push({
            target: candidate,
            targetType: candidateType,
            dist: spawnerDist + originDist * 0.22 + dropPenalty,
            worldDist: detHypot(candidate.x - u.x, candidate.y - u.y)
        });
        return false;
    });

    let picked = _pickDistributedWorkerCandidate(u, candidates);
    if (picked && picked.target) {
        _collectorAssignTarget(
            u,
            picked.target,
            picked.targetType !== undefined ? picked.targetType : null,
            myGx,
            myGy
        );
        return;
    }

    if (anchorSpawner) {
        // Do not set next spawner if no work was found.
        // u._collectorNextSpawner = anchorSpawner;
    }
    u.workerState = 'IDLE'; u.commandState = CMD_IDLE;
}

function _collectorCanWalk(nx, ny) {
    return _resourceCollectorCanWalk(nx, ny);
}

let _activeBuilderWorkCacheTick = -1;
let _activeBuilderWorkTargetsByOwner = new Map();
let _activeBuilderPathTiles = new Set();

function _isAnyConstructionPathTarget(item) {
    return !!(item && (item.underConstruction || item.isUpgrading || item.isStacking || item.isResearching));
}

function _builderWorkTileKey(gx, gy) {
    return gy * GRID_W + gx;
}

function _trackActiveBuilderWorkTarget(item) {
    if (!item || !Number.isFinite(item.owner)) return;
    if (!_isBuilderWorkTarget(item, item.owner)) return;
    let ownerList = _activeBuilderWorkTargetsByOwner.get(item.owner);
    if (!ownerList) {
        ownerList = [];
        _activeBuilderWorkTargetsByOwner.set(item.owner, ownerList);
    }
    ownerList.push(item);
}

function _trackActiveBuilderPathTile(item) {
    if (!item || !Number.isFinite(item.gx) || !Number.isFinite(item.gy)) return;
    _activeBuilderPathTiles.add(_builderWorkTileKey(item.gx, item.gy));
}

function _rebuildActiveBuilderWorkCache() {
    _activeBuilderWorkTargetsByOwner = new Map();
    _activeBuilderPathTiles = new Set();
    let seen = new Set();

    let consider = (item) => {
        if (!item || seen.has(item)) return;
        seen.add(item);
        if (_isAnyConstructionPathTarget(item)) _trackActiveBuilderPathTile(item);
        _trackActiveBuilderWorkTarget(item);
    };

    for (let t of towers) consider(t);
    for (let b of barracks) consider(b);
    for (let s of collectorSpawners) consider(s);
    if (typeof _activeTileEntities !== 'undefined') {
        for (const item of _activeTileEntities) {
            const cell = grid[item.gy] && grid[item.gy][item.gx];
            if (cell && cell.item === item) consider(item);
        }
    } else for (let y = 0; y < GRID_H; y++) {
        let row = grid[y];
        for (let x = 0; x < GRID_W; x++) {
            let cell = row[x];
            if (cell && cell.item) consider(cell.item);
        }
    }

    // Canonicalize per-owner target order so later scans are independent of source array order.
    for (let [owner, ownerList] of _activeBuilderWorkTargetsByOwner.entries()) {
        if (!Array.isArray(ownerList) || ownerList.length <= 1) continue;
        ownerList.sort((a, b) => {
            let ay = Math.floor(Number(a && a.gy) || Math.floor((Number(a && a.y) || 0) / TILE));
            let by = Math.floor(Number(b && b.gy) || Math.floor((Number(b && b.y) || 0) / TILE));
            if (ay !== by) return ay - by;
            let ax = Math.floor(Number(a && a.gx) || Math.floor((Number(a && a.x) || 0) / TILE));
            let bx = Math.floor(Number(b && b.gx) || Math.floor((Number(b && b.x) || 0) / TILE));
            if (ax !== bx) return ax - bx;
            let ai = Math.floor(Number(a && a.id) || -1);
            let bi = Math.floor(Number(b && b.id) || -1);
            return ai - bi;
        });
    }

    _activeBuilderWorkCacheTick = gameTime;
    _activeBuilderWorkCacheVersion = _tileEntityVersion;
}

// Candidates only (every search re-checks each one live): rebuilt when the
// tile index changes (placements show up at once) and otherwise every
// BUILDER_WORK_CACHE_TICKS, not on every tick.
const BUILDER_WORK_CACHE_TICKS = 10;
let _activeBuilderWorkCacheVersion = -1;
function _ensureActiveBuilderWorkCacheCurrent() {
    if (!Number.isFinite(_activeBuilderWorkCacheTick) || _activeBuilderWorkCacheVersion !== _tileEntityVersion || _activeBuilderWorkCacheTick > gameTime
        || gameTime - _activeBuilderWorkCacheTick >= BUILDER_WORK_CACHE_TICKS) _rebuildActiveBuilderWorkCache();
}

function _hasUnderConstructionOrUpgradingAt(nx, ny) {
    if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) return false;
    return _isAnyConstructionPathTarget(getTileEntityRef(nx, ny));
}

// Every owned structure (tile entities with an owner) by owner and bucket of
// STRUCTURE_BUCKET_TILES tiles, each bucket in tile order: kept up to date
// from the tile entity journal, so the same on every peer. Builder searches
// check the ones around them live (_isBuilderWorkTarget).
const _ownedStructIndex = { cursor: { epoch: -1, pos: 0 }, set: null, w: 0, h: 0, cols: 0, rows: 0, byOwner: new Map(), at: new Map() };
function _ownedStructureAtTile(t) {
    const gx = t % GRID_W, gy = (t - gx) / GRID_W, e = getTileEntityRef(gx, gy);
    return e && e.gx === gx && e.gy === gy && Number.isFinite(e.owner) ? e : null;
}
function _ownedStructureBuckets(owner) {
    const X = _ownedStructIndex, B = STRUCTURE_BUCKET_TILES;
    const same = X.set === _activeTileEntities && X.w === GRID_W && X.h === GRID_H;
    const changes = same ? tileEntityChangesSince(X.cursor) : null;
    const bucketsOf = o => {
        let b = X.byOwner.get(o);
        if (!b) X.byOwner.set(o, b = new Array(X.cols * X.rows));
        return b;
    };
    const put = (t, e) => {
        const gx = t % GRID_W, gy = (t - gx) / GRID_W, k = Math.floor(gy / B) * X.cols + Math.floor(gx / B);
        const old = X.at.get(t);
        if (old !== undefined && (!e || old !== e.owner)) {
            const b = bucketsOf(old);
            b[k] = _tileOrderedReplace(b[k] || [], t, null);
        }
        if (e) { const b = bucketsOf(e.owner); b[k] = _tileOrderedReplace(b[k] || [], t, e); X.at.set(t, e.owner); }
        else X.at.delete(t);
    };
    if (changes === null) {
        if (!same) tileEntityChangesSince(X.cursor);
        X.set = _activeTileEntities; X.w = GRID_W; X.h = GRID_H;
        X.cols = Math.ceil(GRID_W / B); X.rows = Math.ceil(GRID_H / B);
        X.byOwner = new Map(); X.at = new Map();
        const tiles = [];
        for (const e of _activeTileEntities) if (e && e.gx >= 0 && e.gy >= 0 && e.gx < GRID_W && e.gy < GRID_H) tiles.push(e.gy * GRID_W + e.gx);
        tiles.sort((a, b) => a - b);
        for (let i = 0; i < tiles.length; i++) if (i === 0 || tiles[i] !== tiles[i - 1]) { const e = _ownedStructureAtTile(tiles[i]); if (e) put(tiles[i], e); }
    } else for (let i = 0; i < changes.length; i++) put(changes[i], _ownedStructureAtTile(changes[i]));
    return X.byOwner.get(owner) || null;
}

function _hasOwnedTileEntityAt(owner, nx, ny) {
    if (!Number.isFinite(owner) || nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) return false;
    let ref = getTileEntityRef(nx, ny);
    if (!ref || !Number.isFinite(ref.owner)) return false;
    return ref.owner === owner;
}

function _canBuilderPassTile(owner, nx, ny) {
    return _hasOwnedTileEntityAt(owner, nx, ny);
}

const _builderCanWalkByOwner = new Map();

function _builderCanWalk(owner) {
    let o = Number.isFinite(owner) ? Math.floor(owner) : -1;
    let cached = _builderCanWalkByOwner.get(o);
    if (cached) return cached;
    let fn = (nx, ny) => _canBuilderPassTile(o, nx, ny);
    fn._pathProfileKey = `builder_${o}`;
    _builderCanWalkByOwner.set(o, fn);
    return fn;
}

function _isWorkerWithinTileInteractionRange(u, target, maxTileDelta = 1) {
    if (!u || !target) return false;
    let ux = Math.floor((Number(u.x) || 0) / TILE);
    let uy = Math.floor((Number(u.y) || 0) / TILE);
    let tx = Number.isFinite(target.gx) ? Math.floor(target.gx) : Math.floor((Number(_thingTickX(target)) || 0) / TILE);
    let ty = Number.isFinite(target.gy) ? Math.floor(target.gy) : Math.floor((Number(_thingTickY(target)) || 0) / TILE);
    if (!Number.isFinite(ux) || !Number.isFinite(uy) || !Number.isFinite(tx) || !Number.isFinite(ty)) return false;
    if (Math.abs(ux - tx) <= maxTileDelta && Math.abs(uy - ty) <= maxTileDelta) return true;
    // At the open tile the navigation takes it to for a walled-in target.
    if (typeof navApproachTile === 'function' && tx >= 0 && ty >= 0 && tx < GRID_W && ty < GRID_H) return navApproachTile(navProfileOf(u), ty * GRID_W + tx) === uy * GRID_W + ux;
    return false;
}

function getBuilderTripGoldCost(u) {
    let dps = Number(u && u.preComputed && u.preComputed.builderDps);
    if (!Number.isFinite(dps) || dps <= 0) dps = 5;
    return Math.max(1, Math.round(dps));
}

function _getBuilderProgressRequiredEnergy(target) {
    if (!target) return 1;
    if (target.underConstruction) {
        let upgradeEnergy = Number(getUpgrademaxEnergy(target, 1));
        let visibleMax = Number(target.maxEnergy);
        if (Number.isFinite(visibleMax) && visibleMax > 0) {
            upgradeEnergy = Number.isFinite(upgradeEnergy) && upgradeEnergy > 0
                ? Math.min(upgradeEnergy, visibleMax)
                : visibleMax;
        }
        return Math.max(1, Math.floor(Number.isFinite(upgradeEnergy) && upgradeEnergy > 0 ? upgradeEnergy : 1));
    }
    if (target.isUpgrading) {
        let nextLevel = Math.max(1, getThingBaseLevel(target) + 1);
        return Math.max(1, Math.floor(getUpgrademaxEnergy(target, nextLevel) || target.upgrademaxEnergy || target.maxEnergy || 1));
    }
    return Math.max(1, Math.floor(Number(target.maxEnergy) || 1));
}

function isResourceCollectorWorkerType(workerType) {
    return !!getResourceTypeByCollectorUnit(workerType);
}

function getResourceCollectorConfigByWorkerType(workerType) {
    return getResourceTypeByCollectorUnit(workerType);
}

// A collector's memory: a view of its worker record's columns (sim_unit_state.js
// SIM_WK_MEM; the energy and A* names share them).
class _CollectorMemView {
    constructor(u) { this.u = u; }
    get pinnedTarget() { return this.u._collectorPinnedTarget; } set pinnedTarget(v) { this.u._collectorPinnedTarget = v; }
    get pinnedTargetType() { return this.u._collectorPinnedTargetType; } set pinnedTargetType(v) { this.u._collectorPinnedTargetType = v; }
    get lastGatherX() { return this.u._collectorLastGatherX; } set lastGatherX(v) { this.u._collectorLastGatherX = v; }
    get lastGatherY() { return this.u._collectorLastGatherY; } set lastGatherY(v) { this.u._collectorLastGatherY = v; }
    get lastGatherGx() { return this.u._collectorLastGatherGx; } set lastGatherGx(v) { this.u._collectorLastGatherGx = v; }
    get lastGatherGy() { return this.u._collectorLastGatherGy; } set lastGatherGy(v) { this.u._collectorLastGatherGy = v; }
    get lastGatherType() { return this.u._collectorLastGatherType; } set lastGatherType(v) { this.u._collectorLastGatherType = v; }
    get nextSpawner() { return this.u._collectorNextSpawner; } set nextSpawner(v) { this.u._collectorNextSpawner = v; }
    get lastDropoffSpawner() { return this.u._collectorLastDropoffSpawner; } set lastDropoffSpawner(v) { this.u._collectorLastDropoffSpawner = v; }
    get lastMineTarget() { return this.u._lastMineTarget; } set lastMineTarget(v) { this.u._lastMineTarget = v; }
    get lastMineTargetType() { return this.u._astarLastMineTargetType; } set lastMineTargetType(v) { this.u._astarLastMineTargetType = v; }
}
function _getResourceCollectorMemory(u) {
    return u ? new _CollectorMemView(u) : null;
}

function _setResourceCollectorNextSpawner(u, spawner) {
    let mem = _getResourceCollectorMemory(u);
    if (mem) mem.nextSpawner = spawner || null;
    let cfg = getResourceCollectorConfigByWorkerType(u && u.workerType);
    if (!cfg) return;
    if (cfg.stockpileKey === 'energy') u._collectorNextSpawner = spawner || null;
    else if (cfg.stockpileKey === 'astar') u._astarNextSpawner = spawner || null;
}

function _setResourceCollectorLastDropoffSpawner(u, spawner) {
    let mem = _getResourceCollectorMemory(u);
    if (mem) mem.lastDropoffSpawner = spawner || null;
    let cfg = getResourceCollectorConfigByWorkerType(u && u.workerType);
    if (!cfg) return;
    if (cfg.stockpileKey === 'energy') u._collectorLastDropoffSpawner = spawner || null;
}

function _getResourceCollectorPreferredSpawner(u, type) {
    if (!u || !type) return null;
    let mem = _getResourceCollectorMemory(u);
    let candidates = [
        mem && mem.nextSpawner,
        mem && mem.lastDropoffSpawner,
        u._collectorNextSpawner,
        u._astarNextSpawner,
        u._collectorLastDropoffSpawner
    ];
    for (let s of candidates) {
        if (!s) continue;
        if (s.type === type && s.owner === u.owner && s.energy > 0 && !s.underConstruction) {
            return s;
        }
    }
    return null;
}

function _clearResourceCollectorTaskMemory(u) {
    let mem = _getResourceCollectorMemory(u);
    if (mem) {
        mem.pinnedTarget = null;
        mem.pinnedTargetType = null;
        mem.lastGatherX = null;
        mem.lastGatherY = null;
        mem.lastGatherGx = null;
        mem.lastGatherGy = null;
        mem.lastGatherType = null;
        mem.nextSpawner = null;
        mem.lastDropoffSpawner = null;
        mem.lastMineTarget = null;
        mem.lastMineTargetType = null;
    }
    u._collectorPinnedTarget = null;
    u._collectorPinnedTargetType = null;
    u._collectorLastGatherX = null;
    u._collectorLastGatherY = null;
    u._collectorLastGatherGx = null;
    u._collectorLastGatherGy = null;
    u._collectorLastGatherType = null;
    u._collectorNextSpawner = null;
    u._collectorLastDropoffSpawner = null;
    u._lastMineTarget = null;
    u._astarLastGatherX = null;
    u._astarLastGatherY = null;
    u._astarLastGatherGx = null;
    u._astarLastGatherGy = null;
    u._astarPinnedTarget = null;
    u._astarPinnedTargetType = null;
    u._astarNextSpawner = null;
    u._astarLastMineTarget = null;
    u._astarLastMineTargetType = null;
}

function _resourceCollectorCanWalk(nx, ny) {
    return hasActiveGoldMineAt(nx, ny) || hasActiveAstarMineAt(nx, ny);
}

function getWorkerUnitTypeFromWorkerType(workerType) {
    let resourceCollector = getResourceCollectorConfigByWorkerType(workerType);
    if (resourceCollector) return resourceCollector.collectorUnitKey;
    if (workerType === 'salvager') return 'salvager_unit';
    if (workerType === 'builder') return 'builder_unit';
    if (workerType === 'healer') return 'healer_unit';
    if (workerType === 'researcher') return 'researcher_unit';
    return null;
}

function getWorkerTransferCooldownSeconds(workerType, unit = null) {
    let unitType = (unit && unit.unitType) ? unit.unitType : getWorkerUnitTypeFromWorkerType(workerType);
    let owner = (unit && Number.isFinite(unit.owner)) ? unit.owner : localPlayerId;
    let lvl = unit ? getUnitEffectiveLevel(unit) : 1;
    let sec = (unit && unit.preComputed) ? Number(unit.preComputed.transferCooldownSec) : NaN;
    if (!Number.isFinite(sec) || sec <= 0) sec = Number((BASE_UNIT_STATS[unitType] || {}).transferCooldown);
    if (!Number.isFinite(sec) || sec <= 0) sec = 0.01;
    return Math.max(0.01, sec);
}

function getBuilderTransferCooldownTicks(unit = null) {
    return secondsToTicks(getWorkerTransferCooldownSeconds('builder', unit));
}

function getWorkerTypeTransferCooldownTicks(workerType, unit = null) {
    if (workerType === 'builder') return getBuilderTransferCooldownTicks(unit);
    if (isResourceCollectorWorkerType(workerType) || workerType === 'salvager' || workerType === 'healer' || workerType === 'researcher') {
        return secondsToTicks(getWorkerTransferCooldownSeconds(workerType, unit));
    }
    return secondsToTicks(getWorkerTransferCooldownSeconds(workerType, unit));
}

function getWorkerIdleRetargetTicks() {
    return Math.max(30, Math.floor(TICK_RATE * 3));
}

// An idle worker's periodic search: on every k-th heavy AI tick, about
// every 1.5 seconds (a parked one is looked at then, see simMoveTryPark).
function getWorkerIdleSearchTicks() {
    return Math.max(1, Math.round(TICK_RATE * 1.5));
}

// Work for idle workers: per owner and worker type, a version bumped by
// whatever can give such a worker something to do (the owner's orders,
// buildings set or cleared, drops, targets let go of, damaged units). An
// idle worker whose search found nothing searches again only once its
// version moved on, or after WORKER_IDLE_BACKOFF_SECONDS (what the bumps
// miss: money for upgrades, research...). Orders and finished tasks force
// a search (_idleFailVer -1). Simulation state (snapshotted).
const WORKER_IDLE_BACKOFF_SECONDS = 5;
// A change at tile (gx, gy) counts for its region (WORKER_WORK_REGION_TILES
// square) only; without a tile, for the owner everywhere. A worker sums the
// owner's versions and those of the regions around it and its search origin.
// The versions: one Int32Array, [owner][type][global, region...] (types in
// a fixed order: '*' for all, then the worker types).
const WORKER_WORK_REGION_TILES = 64;
const _WORKER_WORK_TYPES = ['*', 'builder', 'healer', 'researcher', 'salvager', ...(typeof RESOURCE_COLLECTOR_UNIT_KEYS !== 'undefined' ? RESOURCE_COLLECTOR_UNIT_KEYS : []), 'other'];
const _workerWorkTypeIndex = new Map(_WORKER_WORK_TYPES.map((t, i) => [t, i]));
let _workerWorkVer = null, _workerWorkDims = '';
function _workerWorkTable() {
    const rw = Math.ceil(GRID_W / WORKER_WORK_REGION_TILES), rh = Math.ceil(GRID_H / WORKER_WORK_REGION_TILES), np = Math.max(1, typeof players !== "undefined" && players ? players.length : 1);
    const dims = np + ':' + rw + 'x' + rh;
    if (!_workerWorkVer || _workerWorkDims !== dims) {
        // (Shared: the movement kernel checks parked idle workers' versions.)
        _workerWorkVer = simHeapArrayAuto(Int32Array, np * _WORKER_WORK_TYPES.length * (1 + rw * rh)); _workerWorkDims = dims;
        simParallelBind('wk.ver', _workerWorkVer);
        _workerWorkVer.rw = rw; _workerWorkVer.rh = rh; _workerWorkVer.np = np; _workerWorkVer.sum = 0;
    }
    return _workerWorkVer;
}
function _workerWorkType(t) { const i = _workerWorkTypeIndex.get(t || '*'); return i === undefined ? _WORKER_WORK_TYPES.length - 1 : i; }
function _workerWorkBase(V, owner, typeIdx) { return (owner * _WORKER_WORK_TYPES.length + typeIdx) * (1 + V.rw * V.rh); }
function workerWorkChanged(owner, workerType = null, gx = -1, gy = -1) {
    const V = _workerWorkTable();
    if (!(owner >= 0)) { for (let p = 0; p < V.np; p++) workerWorkChanged(p, workerType, gx, gy); return; }
    if (owner >= V.np) return;
    let i = _workerWorkBase(V, owner, _workerWorkType(workerType));
    if (gx >= 0 && gy >= 0) i += 1 + Math.min(V.rh - 1, Math.floor(gy / WORKER_WORK_REGION_TILES)) * V.rw + Math.min(V.rw - 1, Math.floor(gx / WORKER_WORK_REGION_TILES));
    V[i] = (V[i] + 1) | 0;
    V.sum = (V.sum + _workerWorkMix(i)) | 0;
}
// A drop at (gx, gy): work for every player's collectors that pick drops up
// (supportsDropTarget), and no other worker's (a battle drops hundreds a
// tick; waking every idle worker near it for a search was most of a siege's
// worker time).
function workerWorkDropAdded(gx, gy) {
    for (const cfg of RESOURCE_TYPE_LIST) if (cfg.supportsDropTarget) workerWorkChanged(-1, cfg.collectorUnitKey, gx, gy);
}
// The state hash's checksum of the versions, kept as they change: the sum
// of each version times a mix of its index.
function _workerWorkMix(i) { return Math.imul((i + 1) ^ 0x9e3779b9, 2654435761) | 0; }
function workerWorkVersionsChecksum() { return _workerWorkTable().sum | 0; }
function _workerWorkOrigin(u) {
    if (isResourceCollectorWorkerType(u.workerType)) return _getResourceCollectorSearchOrigin(u);
    if (u.workerType === 'builder') return _builderGetSearchOrigin(u);
    if (u.workerType === 'healer') return _healerGetSearchOrigin(u);
    return u;
}
function _workerWorkVerOf(u) {
    const V = _workerWorkTable(), org = _workerWorkOrigin(u);
    return _workerWorkHash(V, u.owner, _workerWorkType(u.workerType), false, Math.ceil(_getWorkerAutoSearchDistancePx(u) / TILE) + 1,
        Math.floor(org.x / TILE), Math.floor(org.y / TILE), org !== u, Math.floor(u.x / TILE), Math.floor(u.y / TILE));
}
// The version of the work around an origin tile (and, `twice`, the worker's
// own tile too) within d tiles, for an owner and worker type (healers also
// count the damaged-unit candidates' changes). A pure function of the table:
// the movement kernel works it out alike for parked idle workers
// (SIM_KERNEL_MOVE, simMoveTryPark).
function _workerWorkHash(V, o, typeIdx, healer, d, ogx, ogy, twice, pgx, pgy) {
    if (!(o >= 0 && o < V.np)) return 0;
    const all = _workerWorkBase(V, o, 0), mine = _workerWorkBase(V, o, typeIdx);
    let h = (Math.imul(V[all], 31) + V[mine]) | 0;
    if (healer) h = (Math.imul(h, 31) + _healerCandidatesGen) | 0;
    const R = WORKER_WORK_REGION_TILES;
    for (let pass = 0; pass < (twice ? 2 : 1); pass++) {
        const gx = pass ? pgx : ogx, gy = pass ? pgy : ogy;
        for (let ry = Math.max(0, Math.floor((gy - d) / R)), ry1 = Math.min(V.rh - 1, Math.floor((gy + d) / R)); ry <= ry1; ry++)
            for (let rx = Math.max(0, Math.floor((gx - d) / R)), rx1 = Math.min(V.rw - 1, Math.floor((gx + d) / R)); rx <= rx1; rx++) {
                const r = 1 + ry * V.rw + rx;
                h = (Math.imul(h, 31) + Math.imul(V[all + r], 7) + V[mine + r]) | 0;
            }
    }
    return h;
}
// The tick from which a worker's search origin may change while it stays
// idle (a collector looks from where it stands for its first 5 idle seconds).
function _workerWorkOriginUntil(u) {
    if (isResourceCollectorWorkerType(u.workerType) && u.workerState === 'IDLE') {
        const since = u._lastIdleStateTime || 0, span = secondsToTicks(5);
        if (gameTime - since < span) return since + span;
    }
    return Infinity;
}
// Snapshots: the versions that are not 0, as [index, version, ...].
function resetWorkerWorkVersions(v = null) {
    _workerWorkVer = null;
    const V = _workerWorkTable();
    if (Array.isArray(v)) for (let i = 0; i + 1 < v.length; i += 2) if (v[i] >= 0 && v[i] < V.length) {
        V[v[i]] = v[i + 1] | 0;
        V.sum = (V.sum + Math.imul(v[i + 1] | 0, _workerWorkMix(v[i]))) | 0;
    }
}
function workerWorkVersionsSnapshot() {
    const V = _workerWorkTable(), out = [];
    for (let i = 0; i < V.length; i++) if (V[i] !== 0) out.push(i, V[i]);
    return out;
}

// Whether a failed search's backoff (nothing found at work version
// _idleFailVer, until _idleFailUntil) runs at `tick`; -1 is a forced search.
function workerIdleBackoff(u, tick) {
    const v = u._idleFailVer, until = u._idleFailUntil;
    return Number.isInteger(v) && v !== -1 && Number.isFinite(until) && tick < until;
}
function shouldRunWorkerIdleRetarget(u, canRunHeavyAi) {
    if (!u) return false;
    let interval = getWorkerIdleRetargetTicks();
    // A new worker (no schedule yet) looks at once.
    if (!Number.isFinite(u._workerNextIdleRetargetTick)) {
        u._workerNextIdleRetargetTick = gameTime + interval;
        u._idleFailVer = _workerWorkVerOf(u); u._idleFailUntil = gameTime + WORKER_IDLE_BACKOFF_SECONDS * TICK_RATE;
        return true;
    }
    // Nothing found last time and nothing changed since: nothing to do (a
    // change is seen on its next staggered search tick; the backoff's end
    // searches again; a parked worker stays parked until either, see
    // simMoveTryPark).
    const ver = _workerWorkVerOf(u);
    if (u._idleFailVer === ver && gameTime < u._idleFailUntil) return false;
    // An idle worker with nothing found looks again on its staggered idle
    // search tick (about twice a second), not on every heavy AI tick: a
    // worker that finishes a task searches at once anyway, and commands
    // force a search through _workerNextIdleRetargetTick.
    let delay = Math.max(1, Math.floor(Number(WORKER_AI_TICK_DELAY) || 1));
    if (canRunHeavyAi && simStepCrosses(u.id, delay * Math.ceil(getWorkerIdleSearchTicks() / delay))) {
        u._workerNextIdleRetargetTick = gameTime + interval;
        u._idleFailVer = ver; u._idleFailUntil = gameTime + WORKER_IDLE_BACKOFF_SECONDS * TICK_RATE;
        return true;
    }
    // (Its scheduled search: not while a failed search's backoff runs, which
    // only its staggered search tick above or the backoff's end breaks, as
    // a parked worker wakes; a forced search, failVer -1, at once.)
    if (gameTime >= u._workerNextIdleRetargetTick && !workerIdleBackoff(u, gameTime)) {
        u._workerNextIdleRetargetTick = gameTime + interval;
        u._idleFailVer = ver; u._idleFailUntil = gameTime + WORKER_IDLE_BACKOFF_SECONDS * TICK_RATE;
        return true;
    }
    return false;
}

function _getWorkerVisionRangePx(u) {
    let visTiles = Number(u && u.preComputed && u.preComputed.visionRange);
    if (!Number.isFinite(visTiles) || visTiles <= 0) visTiles = 4;
    return Math.max(TILE, visTiles * TILE);
}

function _getWorkerAutoSearchDistancePx(u) {
    if (!u) return TILE * 10;
    let lvl = Math.max(1, getUnitEffectiveLevel(u, getUnitBaseLevel(u)));
    let distArea = getUnitStatForOwner(u.owner, u.unitType, lvl, 'attackRange');
    let distTiles = Number(distArea) * AREA_UNIT_TILE_EQUIVALENT;
    if (!Number.isFinite(distTiles) || distTiles <= 0) distTiles = 10;
    return Math.max(TILE, distTiles * TILE);
}

function _getWorkerAutoSearchDistanceArea(u) {
    if (!u) return 2.0;
    let lvl = Math.max(1, getUnitEffectiveLevel(u, getUnitBaseLevel(u)));
    // (A worker's range is its work reach, whole area steps: 0a its own area.)
    let distArea = getUnitStatForOwner(u.owner, u.unitType, lvl, 'attackRange');
    return Number.isFinite(distArea) ? areaSteps(distArea) : 2;
}

function _workerSearchTileBox(u,x,y,r,pad=1) {
    if(areaSearchEnabled())return Array.from(getAreaRangeTileBox(getSourceAreaIdsAtWorld(x,y),Math.floor(_getWorkerAutoSearchDistanceArea(u))));
    const reach=Math.ceil(r/TILE)+pad,gx=Math.floor(x/TILE),gy=Math.floor(y/TILE);
    return [gx-reach,gy-reach,gx+reach,gy+reach];
}

function _isTargetWithinWorkerSearchArea(originX, originY, target, maxSearchArea) {
    if (!target) return false;
    let targetAreaId = Number.isFinite(target.areaId)
        ? Math.floor(target.areaId)
        : getAreaIdAtWorld(_thingTickX(target), _thingTickY(target));
    if (targetAreaId < 0) return false;
    let maxDistance = Math.floor(Math.max(0, Number(maxSearchArea) || 0));
    for (let source of getSourceAreaIdsAtWorld(originX, originY)) {
        if (isAreaWithinDistance(source, targetAreaId, maxDistance)) return true;
    }
    return false;
}

function _isTargetWithinWorkerSearchLimits(u, originX, originY, target, maxSearchArea) {
    return _isTargetWithinWorkerSearchArea(originX, originY, target, maxSearchArea);
}

function _getResearcherAutoSearchDistancePx(u) {
    // Researchers often need to cross a larger base area to find active labs.
    return Math.max(_getWorkerAutoSearchDistancePx(u), TILE * 32);
}

function _getTargetPriorityLevel(target) {
    if (!target) return 1;
    if (target.workerType) return getUnitEffectiveLevel(target, getUnitBaseLevel(target));
    return Math.max(1, Math.floor(getThingBaseLevel(target) || 1));
}

// Per-target worker load counters (updated on target set/clear).
// (Unit ids, 0 none: a heap table, tile * load types + the type's index, made
// with the map (workerReservedTable); a kernel's to read and write too.)
let workerReservedTiles = new Int32Array(0);
function workerReservedTable() {
    const n = Math.max(0, GRID_W * GRID_H * _WORKER_TARGET_LOAD_TYPE_COUNT);
    const t = typeof simSharedArray === 'function' ? simSharedArray(Int32Array, n) : new Int32Array(n);
    if (typeof simParallelBind === 'function') simParallelBind('wk.resv', t);
    return t;
}
// The unit holding reservation slot i: null none; a unit that left the list
// as a dead placeholder (its id).
function workerReservedAt(i) {
    const id = workerReservedTiles[i];
    if (!(id > 0)) return null;
    const u = getUnitById(id);
    return u || { id, dead: true, _workerReservedTileIndex: -1 };
}
// Every write goes through workerReservedSet: per snapshot region, the
// number of occupied slots (for the tick hash, which skips empty regions)
// and an order-free digest of its entries (slot and unit id: the tick hash
// takes it every slice; the full entries, with their units' deaths, only in
// the region's round). Made again when the table is replaced
// (_workerReservedCounts).
let _workerResCount = null, _workerResSum = null, _workerResCountFor = null;
function _workerResTerm(slot, id) { if (!id) return 0; const h = Math.imul((slot + 1) ^ Math.imul((id | 0) + 0x3c6ef372, 2654435761), 2246822519); return Math.imul(h ^ (h >>> 13), 3266489917); }
// (v: a unit or its id, null / 0 none.)
function workerReservedSet(slot, v) {
    const t = workerReservedTiles, old = t[slot], id = !v ? 0 : typeof v === 'number' ? v : (Number(v.id) | 0);
    t[slot] = id;
    // (The work site grid's copy, at its next step.)
    if (_wsw && old !== id) _wswResvMark(slot);
    if (_workerResCountFor === t && old !== id) {
        const r = _snapReservationRegionIndex(slot);
        if ((!old) !== (!id)) _workerResCount[r] += id ? 1 : -1;
        _workerResSum[r] = (_workerResSum[r] + _workerResTerm(slot, id) - _workerResTerm(slot, old)) | 0;
    }
}
function workerReservedCountsInvalidate() { _workerResCountFor = null; }
// The per-region digests, current (with the counts).
function _workerReservedSums() { return _workerReservedCounts() ? _workerResSum : null; }
// The counts, current (null without the snapshot code).
function _workerReservedCounts() {
    const t = workerReservedTiles;
    if (_workerResCountFor === t) return _workerResCount;
    if (typeof _snapReservationRegionIndex !== 'function') return null;
    const n = _snapReservationRegionCount();
    // (Heap arrays: the order kernel keeps them as it lets reservations go.)
    if (!_workerResCount || _workerResCount.length !== n || (typeof simHeapHas === 'function' && !simHeapHas(_workerResCount))) { const A = typeof simSharedArray === 'function' ? simSharedArray : (T, k) => new T(k); _workerResCount = A(Int32Array, n); _workerResSum = A(Int32Array, n); } else { _workerResCount.fill(0); _workerResSum.fill(0); }
    for (let s = 0; s < t.length; s++) if (t[s]) { const r = _snapReservationRegionIndex(s); _workerResCount[r]++; _workerResSum[r] = (_workerResSum[r] + _workerResTerm(s, t[s])) | 0; }
    _workerResCountFor = t;
    return _workerResCount;
}
const _WORKER_TARGET_LOAD_TYPES = [...RESOURCE_COLLECTOR_UNIT_KEYS, 'salvager', 'builder', 'healer', 'researcher'];
const _WORKER_TARGET_LOAD_TYPE_COUNT = _WORKER_TARGET_LOAD_TYPES.length;

function _workerTypeToLoadIndex(workerType) {
    return _WORKER_TARGET_LOAD_TYPES.indexOf(workerType);
}

function _getWorkerTargetTileIndex(target) {
    if (!target) return null;
    let gx = Number.isFinite(target.gx) ? Math.floor(target.gx) : Math.floor((Number(_thingTickX(target)) || 0) / TILE);
    let gy = Number.isFinite(target.gy) ? Math.floor(target.gy) : Math.floor((Number(_thingTickY(target)) || 0) / TILE);
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) return -1;
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return -1;
    return gy * GRID_W + gx;
}

function _getWorkerReservationSlotIndex(target, workerType) {
    let workerTypeIndex = _workerTypeToLoadIndex(workerType);
    if (workerTypeIndex < 0) return -1;
    let tileIndex = _getWorkerTargetTileIndex(target);
    if (tileIndex < 0) return -1;
    return tileIndex * _WORKER_TARGET_LOAD_TYPE_COUNT + workerTypeIndex;
}

function _getReservedWorkerForTarget(target, workerType) {
    let slotIndex = _getWorkerReservationSlotIndex(target, workerType);
    if (slotIndex < 0) return null;
    let reservedUnit = workerReservedAt(slotIndex);
    if (!reservedUnit || reservedUnit.dead) {
        if (slotIndex >= 0) workerReservedSet(slotIndex, null);
        return null;
    }
    return reservedUnit;
}

function _invalidateWorkerTargetLoadCache() {
    workerReservedTiles = workerReservedTable();
}

// Caches stamped with the current tick hold references to live entities. A
// snapshot restore replaces every entity while gameTime may stay the same
// (the host restores at the tick it just reached), so the caches must be
// dropped or they would steer the next tick with pre-restore objects on some
// peers and not others.
function resetSimulationTickCaches() {
    if (typeof unitHitsReset === "function") unitHitsReset();
    if (typeof visCoverHoldReset === "function") visCoverHoldReset();
    _invalidateWorkerTargetLoadCache();
    _activeBuilderWorkCacheTick = NaN;
    _activeBuilderWorkTargetsByOwner = new Map();
    _activeBuilderPathTiles = new Set();
    _healerDamagedCandidatesTick = NaN;
    _healerDamagedCandidatesByOwner = [];
    _workerSpawnerIndex = null;
    if (typeof _wsCand !== 'undefined') { _wsCand.all.sig = -1; _wsCand.spawners.sig = -1; _spIdx.sig = -1; }
    if (typeof _upKeepAccum !== 'undefined') _upKeepAccum = null;
    _adjacencyNeedsRecalc = true;
    _adjacencyLastRecalcTick = -1;
}

function _setWorkerTarget(unit, target, targetType = null) {
    if (!unit) return false;
    let nextType = (targetType === undefined) ? null : targetType;
    if (unit.workerTarget === target && unit.workerTargetType === nextType) return true;

    let nextSlotIndex = target ? _getWorkerReservationSlotIndex(target, unit.workerType) : -1;
    if (nextSlotIndex >= 0) {
        let reservedUnit = workerReservedAt(nextSlotIndex);
        if (reservedUnit && reservedUnit !== unit && !reservedUnit.dead && reservedUnit.owner === unit.owner && reservedUnit.workerType === unit.workerType) {
            let contenderId = Math.floor(Number(unit.id) || 0);
            let reservedId = Math.floor(Number(reservedUnit.id) || 0);
            // Deterministic tie-break for same tile/type: lower unit id always wins.
            if (reservedId <= contenderId) return false;

            let reservedSlotIndex = Number.isFinite(reservedUnit._workerReservedTileIndex)
                ? Math.floor(reservedUnit._workerReservedTileIndex)
                : -1;
            if (reservedSlotIndex >= 0 && workerReservedTiles[reservedSlotIndex] === reservedUnit.id) {
                workerReservedSet(reservedSlotIndex, null);
            }
            if (reservedUnit.workerTarget === target) {
                reservedUnit.workerTarget = null;
                reservedUnit.workerTargetType = null;
                if (reservedUnit.workerState === 'MOVING_TO' || reservedUnit.workerState === 'MOVING_TO_ASTAR' || reservedUnit.workerState === 'IDLE') {
                    reservedUnit.workerState = 'IDLE';
                    reservedUnit.commandState = CMD_IDLE;
                    _clearWorkerAutoRoute(reservedUnit);
                }
            }
            reservedUnit._workerReservedTileIndex = -1;
        }
    }

    let prevTarget = unit.workerTarget;
    if (prevTarget) {
        let prevSlotIndex = Number.isFinite(unit._workerReservedTileIndex) ? Math.floor(unit._workerReservedTileIndex) : -1;
        if (prevSlotIndex >= 0 && workerReservedTiles[prevSlotIndex] === unit.id) workerReservedSet(prevSlotIndex, null);
    }

    unit.workerTarget = target;
    unit.workerTargetType = nextType;
    if (target && unit._us) unit._us.wsKind[unit._si] = 0;
    unit._workerReservedTileIndex = -1;
    if (target && nextSlotIndex >= 0) {
        workerReservedSet(nextSlotIndex, unit);
        unit._workerReservedTileIndex = nextSlotIndex;
    }
    return true;
}

function _clearWorkerTarget(unit, reason = null) {
    if (!unit || (!unit.workerType && unit.workerTarget == null)) return;
    if (unit.workerTarget && unit.workerType) { const w = unit.workerTarget; workerWorkChanged(unit.owner, unit.workerType, Number.isFinite(w.gx) ? w.gx : Math.floor((w.x || 0) / TILE), Number.isFinite(w.gy) ? w.gy : Math.floor((w.y || 0) / TILE)); }
    if (unit.workerState === 'RETURNING' || unit.workerState === 'RETURNING_ASTAR' || unit.workerState === 'RETURNING_FOR_GOLD') {
        let allowed = reason === 'manual_rally_change'
            || reason === 'target_missing'
            || reason === 'target_no_work'
            || reason === 'worker_removed';
        if (!allowed) return;
    }
    if (unit.workerTarget === null && unit.workerTargetType === null) return;

    let prevTarget = unit.workerTarget;
    if (prevTarget) {
        let prevSlotIndex = Number.isFinite(unit._workerReservedTileIndex) ? Math.floor(unit._workerReservedTileIndex) : -1;
        if (prevSlotIndex >= 0 && workerReservedTiles[prevSlotIndex] === unit.id) workerReservedSet(prevSlotIndex, null);
    }

    unit.workerTarget = null;
    unit.workerTargetType = null;
    unit._workerReservedTileIndex = -1;
}

function _workerTargetTypeNeedsExclusive(workerType, targetType = null) {
    return true;
}

function _canAssignWorkerTargetExclusive(u, target, targetType = null, conflictCache = null) {
    if (!u || !target || !u.workerType) return false;
    if (u.workerTarget === target && (targetType === null || u.workerTargetType === targetType)) return true;
    let reservedUnit = _getReservedWorkerForTarget(target, u.workerType);
    // (The reservation table holds every target's tile: a free slot is free.
    // A healer's moving patient is reserved where it stood when taken.)
    if (!reservedUnit) return true;
    if (reservedUnit === u) return true;
    return reservedUnit.owner !== u.owner || reservedUnit.workerType !== u.workerType;
}

function _workerOwnsReservedTarget(u, target = null) {
    if (!u || !u.workerType) return false;
    let reservedTarget = target || u.workerTarget;
    if (!reservedTarget) return false;
    return _getReservedWorkerForTarget(reservedTarget, u.workerType) === u;
}

function _workerHasPendingAutoRouteToTarget(u, target = null) {
    if (!u || !u.pathIsFallbackAstar || !u._pendingPathTarget) return false;
    let routeTarget = target || u.workerTarget;
    if (!routeTarget) return false;
    return u._pendingPathTarget.gx === routeTarget.gx && u._pendingPathTarget.gy === routeTarget.gy;
}

function _clearWorkerAutoRoute(u) {
    if (!u) return;
    u.path = [];
    u.pathIndex = 0;
    u.commandState = CMD_IDLE;
    u.pathIsFallbackAstar = false;
    u._pendingPathTarget = null;
}

function _scoreWorkerTaskCandidate(u, candidate) {
    let score = Number(candidate.dist) || 0;
    if (u.workerTarget && u.workerTarget === candidate.target) score -= TILE * 0.75;

    let gx = Number.isFinite(candidate.target && candidate.target.gx) ? candidate.target.gx : Math.floor((candidate.target && _thingTickX(candidate.target) || 0) / TILE);
    let gy = Number.isFinite(candidate.target && candidate.target.gy) ? candidate.target.gy : Math.floor((candidate.target && _thingTickY(candidate.target) || 0) / TILE);
    let seed = ((u.id * 1103515245 + gx * 12345 + gy * 54321) >>> 0) % 1024;
    score += (seed / 1024) * TILE * 0.35;
    return score;
}

function _pickDistributedWorkerCandidate(u, candidates) {
    if (!u || !Array.isArray(candidates) || candidates.length <= 0) return null;
    let conflictCache = { tiles: null };

    let getTargetSortKey = (candidate) => {
        let t = candidate && candidate.target ? candidate.target : null;
        let tt = String((candidate && candidate.targetType) || '');
        let gx = Number.isFinite(t && t.gx) ? Math.floor(Number(t.gx)) : Math.floor(Number((t && t.x) || 0) / TILE);
        let gy = Number.isFinite(t && t.gy) ? Math.floor(Number(t.gy)) : Math.floor(Number((t && t.y) || 0) / TILE);
        let tid = Number.isFinite(t && t.id) ? Math.floor(Number(t.id)) : -1;
        return `${tt}|${gx},${gy}|${tid}`;
    };

    let best = null;
    let bestScore = Infinity;
    for (let c of candidates) {
        if (!c || !c.target) continue;
        let targetType = (c.targetType !== undefined) ? c.targetType : null;
        if (_workerTargetTypeNeedsExclusive(u.workerType, targetType) && !_canAssignWorkerTargetExclusive(u, c.target, targetType, conflictCache)) continue;
        let score = _scoreWorkerTaskCandidate(u, c);
        if (score < bestScore) {
            bestScore = score;
            best = c;
            continue;
        }
        if (Math.abs(score - bestScore) <= 1e-9 && best) {
            let aKey = getTargetSortKey(c);
            let bKey = getTargetSortKey(best);
            if (aKey < bKey) {
                best = c;
            }
        }
    }
    return best || null;
}

function _pickDistributedWorkerTarget(u, candidates) {
    let picked = _pickDistributedWorkerCandidate(u, candidates);
    return picked ? picked.target : null;
}

function getPathCanWalkForUnit(unit) {
    if (!unit || unit.isFlying) return null;
    if (isResourceCollectorWorkerType(unit.workerType)) return _resourceCollectorCanWalk;
    if (unit.workerType === 'builder' || unit.workerType === 'salvager') return _builderCanWalk(unit.owner);
    return null;
}

function _collectorAssignTarget(u, target, targetType, myGx, myGy) {
    _resourceCollectorAssignTarget(u, target, targetType, getResourceTypeConfig('energy'));
}

function _collectorAssignMine(u, mine, myGx, myGy) {
    _collectorAssignTarget(u, mine, 'mine', myGx, myGy);
}

function _astarCollectorCanWalk(nx, ny) {
    return _resourceCollectorCanWalk(nx, ny);
}

function _astarCollectorRememberGatherSite(u, target = null) {
    _rememberResourceCollectorGatherSite(u, target, target && target.type ? target.type : null, getResourceTypeConfig('astar'));
}

function _astarCollectorGetSearchOrigin(u) {
    return _getResourceCollectorSearchOrigin(u, getResourceTypeConfig('astar'));
}

function _astarCollectorAssignTarget(u, target, targetType) {
    _resourceCollectorAssignTarget(u, target, targetType, getResourceTypeConfig('astar'));
}

function _astarCollectorAssignMine(u, mine) {
    _astarCollectorAssignTarget(u, mine, 'astar_mine');
}

function _astarCollectorFindTarget(u) {
    _resourceCollectorFindTarget(u, Math.floor(u.x / TILE), Math.floor(u.y / TILE), getResourceTypeConfig('astar'));
}

// Salvager: find nearest marked building
// Whether the owner has anything marked for salvage (towers, barracks,
// spawners, cell items), and its marked towers, barracks and spawners in
// their arrays' order: made again after a mark order or a tile entity
// change (and on every peer at a resync, _snapResetWorkerCaches); most
// searches find nothing and the rest look at these lists, not every
// structure. A structure destroyed since is no longer its tile's entity.
let _salvageMarksCache = { tile: -1, ver: -1, owners: new Set(), lists: new Map() };
let _salvageMarksVersion = 0;
function salvageMarksChanged() { _salvageMarksVersion++; }
function _salvageMarksCurrent() {
    let c = _salvageMarksCache;
    if (c.ver !== _salvageMarksVersion || c.tile !== _tileEntityVersion) {
        c.tile = _tileEntityVersion; c.ver = _salvageMarksVersion;
        c.owners = new Set(); c.lists = new Map();
        let list = (e, k, owner = e.owner) => {
            if (!e || !e.markedForSalvage) return;
            c.owners.add(owner);
            let l = c.lists.get(owner);
            if (!l) c.lists.set(owner, l = [[], [], [], []]);
            l[k].push(e);
        };
        for (let t of towers) list(t, 0);
        for (let b of barracks) list(b, 1);
        for (let s of collectorSpawners) list(s, 2);
        // Marked cell items other than barracks and spawners (towers too),
        // by their cell's owner.
        const spawners = _collectorSpawnerSet();
        const cellItem = (item, cell) => { if (cell && cell.item === item && !(item instanceof Barrack) && !spawners.has(item)) list(item, 3, cell.owner); };
        if (typeof _activeTileEntities !== 'undefined') { for (const item of _activeTileEntities) if (item && item.markedForSalvage) cellItem(item, grid[item.gy] && grid[item.gy][item.gx]); }
        else for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) { let cell = grid[y][x]; if (cell && cell.item && cell.item.markedForSalvage) cellItem(cell.item, cell); }
    }
    return c;
}
// The members of collectorSpawners (a set, made again when it changes).
let _collectorSpawnerSetCache = { list: null, ver: -1, set: new Set() };
function _collectorSpawnerSet() {
    const c = _collectorSpawnerSetCache, ver = typeof collectorSpawnersVersion === 'number' ? collectorSpawnersVersion : -2;
    if (c.list !== collectorSpawners || c.ver !== ver || ver === -2) { c.list = collectorSpawners; c.ver = ver; c.set = new Set(collectorSpawners); }
    return c.set;
}
function _ownerHasSalvageMarks(owner) {
    return _salvageMarksCurrent().owners.has(owner);
}
const _NO_SALVAGE_LISTS = [[], [], [], []];

function _salvagerFindTarget(u, myGx, myGy) {
    let owner = u.owner;
    let tier = _wsAvailable() && !!u._us;
    if (!tier && !_ownerHasSalvageMarks(owner)) { u.workerState = 'IDLE'; u.commandState = CMD_IDLE; return; }
    let maxSearch = _getWorkerAutoSearchDistancePx(u);
    let maxSearchArea = _getWorkerAutoSearchDistanceArea(u);
    let bestDist = 99999, bestItem = null;
    // (The search tier's pick when it runs: the nearest marked one.)
    if (tier) {
        bestItem = _wsGridPick(u, WSW_SALVAGE, u, maxSearch, false, e => e.markedForSalvage && getTileEntityRef(e.gx, e.gy) === e, null);
        if (bestItem === WS_WAITING) { _wsWait(u); return; }
    } else {
    let conflictCache = {};
    // The owner's marked towers, then barracks, then spawners, in their
    // arrays' order (as a scan of the arrays would meet them).
    // (Those in the search box only, by their buckets.)
    let marked = _salvageMarksCurrent().lists.get(owner) || _NO_SALVAGE_LISTS;
    const box=_workerSearchTileBox(u,u.x,u.y,maxSearch);
    for (let k = 0; k < 3; k++) _forEachStructureInTileBox(marked[k], box[0],box[1],box[2],box[3], (e) => {
        if (e.owner !== owner || !e.markedForSalvage || getTileEntityRef(e.gx, e.gy) !== e) return;
        // (Cheap tests first: only a nearer one needs the exclusivity check.)
        let d = detHypot(e.x - u.x, e.y - u.y);
        if ((!areaSearchEnabled()&&d > maxSearch) || !(d < bestDist)) return;
        if (!_isTargetWithinWorkerSearchLimits(u, u.x, u.y, e, maxSearchArea)) return;
        if (!_canAssignWorkerTargetExclusive(u, e, null, conflictCache)) return;
        bestDist = d; bestItem = e;
    });
    // Marked cell items in the search box (in the owner's cells).
    _forEachStructureInTileBox(marked[3], box[0],box[1],box[2],box[3], (item) => {
        const cell = grid[item.gy] && grid[item.gy][item.gx];
        if (!cell || cell.item !== item || cell.owner !== owner || !item.markedForSalvage) return;
        let d = detHypot(item.x - u.x, item.y - u.y);
        if ((!areaSearchEnabled()&&d > maxSearch) || !(d < bestDist)) return;
        if (!_isTargetWithinWorkerSearchLimits(u, u.x, u.y, item, maxSearchArea)) return;
        if (!_canAssignWorkerTargetExclusive(u, item, null, conflictCache)) return;
        bestDist = d; bestItem = item;
    });
    }
    if (bestItem) {
        if (!_setWorkerTarget(u, bestItem, null)) {
            u.workerState = 'IDLE';
            u.commandState = CMD_IDLE;
            return;
        }
        let canWalk = (nx, ny) => nx === bestItem.gx && ny === bestItem.gy;
        let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
        u.path = _requestWorkerPath(u, startGx, startGy, bestItem.gx, bestItem.gy, canWalk, null, true);
        if (u.path) { u.workerState = 'MOVING_TO'; u.pathIndex = 0; u.commandState = CMD_MOVING; }
        else if (_workerHasPendingAutoRouteToTarget(u, bestItem)) { u.workerState = 'MOVING_TO'; }
        else { _clearWorkerAutoRoute(u); _clearWorkerTarget(u); u.workerState = 'IDLE'; u.commandState = CMD_IDLE; }
    } else {
        u.workerState = 'IDLE'; u.commandState = CMD_IDLE;
    }
}

function _isBuilderRepairTarget(target) {
    if (!target) return false;
    let energy = Number(target.energy);
    let maxEnergy = Number(target.maxEnergy);
    return Number.isFinite(energy)
        && Number.isFinite(maxEnergy)
        && maxEnergy > 0
        && energy > 0
        && energy < maxEnergy
        && !target.underConstruction
        && !target.isUpgrading
        && !target.isStacking;
}

function _isBuilderStackCandidate(target) {
    if (!target || target.underConstruction || target.isUpgrading || target.isStacking || !isAutoStackEnabled(target)) return false;
    if (!(getThingRemainingStacks(target) > 0)) return false;
    return stackCountToLevel(getThingStackedStacks(target) + 1) <= getThingResearchedMaxLevel(target);
}

function _isBuilderUpgradeCandidate(target) {
    if (!target || target.underConstruction || target.isUpgrading || target.isStacking) return false;
    // (Cheapest first: most structures are not due an upgrade.)
    if (!isAutoUpgradeEnabled(target)) return false;
    let baseLevel = getThingBaseLevel(target, stackCountToLevel((target.stacks || 1)));
    let effectiveLevel = getThingEffectiveLevel(target, baseLevel);
    if (!(effectiveLevel > baseLevel)) return false;
    let researchedMaxLevel = getThingResearchedMaxLevel(target);
    let maxAllowedUpgradeLevel = Math.min(effectiveLevel, researchedMaxLevel);
    return maxAllowedUpgradeLevel > baseLevel && isAutoUpgradeEnabled(target);
}

function _isBuilderWorkTarget(target, owner, allowDisabledBuild = false) {
    if (!target) return false;
    if (target.owner !== owner) return false;
    if (target.markedForSalvage) return false;
    if (!target.underConstruction && !target.isUpgrading && !target.isStacking && !_isBuilderRepairTarget(target)) {
        // Research can unlock queued stacks without changing adjacency.
        // Publish eligibility in the search grid, activate work on selection.
        if (_isBuilderStackCandidate(target)) {
            refreshThingProgressState(target);
        } else if (_isBuilderUpgradeCandidate(target)) {
            beginUpgradeProgress(target, Math.max(1, getThingBaseLevel(target) + 1));
        }
    }
    if (!target.underConstruction && !target.isUpgrading && !target.isStacking && !_isBuilderRepairTarget(target)) return false;
    if (!allowDisabledBuild && target.underConstruction && !isBuildEnabled(target)) return false;
    return true;
}

function _builderRememberWorkSite(u, target = null) {
    let t = target || (u ? u.workerTarget : null);
    if (!u || !t) return;
    if (Number.isFinite(t.x) && Number.isFinite(t.y)) {
        u._builderLastWorkX = t.x;
        u._builderLastWorkY = t.y;
    }
    if (Number.isFinite(t.gx) && Number.isFinite(t.gy)) {
        u._builderLastWorkGx = t.gx;
        u._builderLastWorkGy = t.gy;
    }
}

function _builderGetSearchOrigin(u) {
    if (u && Number.isFinite(u._builderLastWorkX) && Number.isFinite(u._builderLastWorkY)) {
        return { x: u._builderLastWorkX, y: u._builderLastWorkY };
    }
    return u;
}

function _getBuilderWorkTargetAt(gx, gy, owner, allowDisabledBuild = false) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return null;
    let target = getTileEntityRef(gx, gy);
    if (target && _isBuilderWorkTarget(target, owner, allowDisabledBuild)) return target;
    return null;
}

function _getBuilderWorkTargetNear(worldX, worldY, owner, radius = 22, allowDisabledBuild = false) {
    let gx = Math.floor(worldX / TILE), gy = Math.floor(worldY / TILE);
    let minGx = Math.max(0, gx - 1), maxGx = Math.min(GRID_W - 1, gx + 1);
    let minGy = Math.max(0, gy - 1), maxGy = Math.min(GRID_H - 1, gy + 1);
    let best = null;
    let bestDist = radius;
    for (let fy = minGy; fy <= maxGy; fy++) {
        for (let fx = minGx; fx <= maxGx; fx++) {
            let t = _getBuilderWorkTargetAt(fx, fy, owner, allowDisabledBuild);
            if (!t) continue;
            let d = detHypot(t.x - worldX, t.y - worldY);
            if (d <= bestDist) {
                bestDist = d;
                best = t;
            }
        }
    }
    return best;
}

// Builder: find nearest building under construction
function _builderFindTarget(u, myGx, myGy) {
    let target = null;

    if (_isBuilderWorkTarget(u.workerTarget, u.owner)) {
        if (_canAssignWorkerTargetExclusive(u, u.workerTarget, null)) target = u.workerTarget;
    }
    if (!target && Number.isFinite(u._builderLastWorkGx) && Number.isFinite(u._builderLastWorkGy)) {
        let cand = _getBuilderWorkTargetAt(u._builderLastWorkGx, u._builderLastWorkGy, u.owner);
        if (cand && _canAssignWorkerTargetExclusive(u, cand, null)) target = cand;
    }
    if (!target && Number.isFinite(u._builderLastWorkX) && Number.isFinite(u._builderLastWorkY)) {
        let cand = _getBuilderWorkTargetNear(u._builderLastWorkX, u._builderLastWorkY, u.owner, Math.max(22, TILE * 1.5));
        if (cand && _canAssignWorkerTargetExclusive(u, cand, null)) target = cand;
    }
    if (!target) {
        let origin = _builderGetSearchOrigin(u);
        // (The search tier's pick when it runs: a request, and wait.)
        if (_wsAvailable() && u._us) {
            const owner = u.owner;
            target = _wsGridPick(u, WSW_BUILD, origin, _getWorkerAutoSearchDistancePx(u), true, e => _isBuilderWorkTarget(e, owner), null);
            if (target === WS_WAITING) { _wsWait(u); return; }
        } else target = _findNearestUnderConstruction(u, origin.x, origin.y);
    }

    if (target) {
        _builderAssignTarget(u, target, myGx, myGy);
    } else {
        u.workerState = 'IDLE'; u.commandState = CMD_IDLE;
    }
}

function _builderAssignTarget(u, target, myGx, myGy) {
    if (!target || target.markedForSalvage) {
        _clearWorkerTarget(u);
        u.workerState = 'IDLE';
        _clearWorkerTarget(u);
        u.commandState = CMD_IDLE;
        return;
    }
    if (!_canAssignWorkerTargetExclusive(u, target, null)) {
        _clearWorkerTarget(u);
        u.workerState = 'IDLE';
        u.commandState = CMD_IDLE;
        return;
    }
    if (!_setWorkerTarget(u, target, null)) {
        u.workerState = 'IDLE';
        u.commandState = CMD_IDLE;
        return;
    }
    _builderRememberWorkSite(u, target);
    let canWalk = _builderCanWalk(u.owner);
    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
    if (u.builderHasMaterial) {
        u.workerState = 'MOVING_TO_BUILD';
        u.path = _requestWorkerPath(u, startGx, startGy, target.gx, target.gy, canWalk, 'builder', true);
        u.pathIndex = 0; u.commandState = CMD_MOVING;
        return;
    }
    let route = _findBestSpawnerRoute(u, 'builder_spawner', _builderCanWalk(u.owner));
    if (route) {
        u.workerState = 'RETURNING_FOR_GOLD';
        u.path = route.path;
        u.pathIndex = 0; u.commandState = CMD_MOVING;
        u._builderSpawnerTarget = route.spawner;
                            u.targetPos = route.spawner ? { x: route.spawner.gx * TILE + 16, y: route.spawner.gy * TILE + 16 } : null;
    } else {
        // No spawner or no energy - go build directly (slow mode)
        u.workerState = 'MOVING_TO_BUILD';
        u.path = _requestWorkerPath(u, startGx, startGy, target.gx, target.gy, canWalk, 'builder', true);
        u.pathIndex = 0; u.commandState = CMD_MOVING;
    }
}

let _workerSpawnerIndex = null;
const _emptyWorkerSpawners = Object.freeze([]);

// Building type/position is fixed for its lifetime. Rebuild after placement,
// removal, snapshot replacement, or at the next tick. Eligibility (energy,
// owner, construction, queues) remains live: workers may change it mid-tick.
function _getWorkerSpawnersByType(type) {
    let tick = typeof gameTime === 'number' ? gameTime : NaN;
    let version = typeof collectorSpawnersVersion === 'number' ? collectorSpawnersVersion : (typeof _tileEntityVersion === 'number' ? _tileEntityVersion : -1);
    let index = _workerSpawnerIndex;
    if (!index || index.list !== collectorSpawners
        || index.length !== collectorSpawners.length || index.version !== version) {
        index = _workerSpawnerIndex = { tick, version, list: collectorSpawners, length: collectorSpawners.length, types: new Map() };
        for (let s of collectorSpawners) {
            if (!s) continue;
            let bucket = index.types.get(s.type);
            if (!bucket) index.types.set(s.type, bucket = []);
            bucket.push(s);
        }
    }
    return index.types.get(type) || _emptyWorkerSpawners;
}

// The nearest live spawner of the type (by distance, row, column; bucketed)
// and the flow navigation's way there; null when there is none, or no way.
function _findBestSpawnerRoute(u, type) {
    const spawner = _findClosestSpawner(u, type);
    if (!spawner || typeof navPathTo !== 'function') return null;
    const path = navPathTo(u, Math.floor(Number(spawner.gx) || 0), Math.floor(Number(spawner.gy) || 0));
    return path ? { spawner, path } : null;
}

// (Nearest by distance, row, column: the bucketed search.)
function _findClosestBuilderSpawner(u) { return _findClosestSpawner(u, 'builder_spawner'); }

function _findClosestHealerSpawner(u) { return _findClosestSpawner(u, 'healer_spawner'); }

function _isHealerTargetUnit(target, owner) {
    if (!target || target.dead) return false;
    if (target.owner !== owner) return false;
    if (!Number.isFinite(target.energy) || !Number.isFinite(target.maxEnergy)) return false;
    return target.energy > 0 && target.energy < target.maxEnergy;
}

function _isHealerQueueTarget(target, owner) {
    if (!target || target.owner !== owner) return false;
    if (target.energy <= 0 || target.underConstruction) return false;
    if (!isQueueEnabled(target)) return false;
    if (!(spawnQueueCount(target) > 0)) return false;
    let front = spawnQueueFront(target);
    return front.energyPaid < front.energyRequired;
}

function _isHealerQueueAnchorTarget(target, owner) {
    if (!target || target.owner !== owner) return false;
    if (target.underConstruction) return false;
    return hasSpawnQueue(target);
}

function _getHealerQueueTripCost(u, target) {
    if (!u || !target || !(spawnQueueCount(target) > 0)) return 0;
    if (!isQueueEnabled(target)) return 0;
    let owner = Number.isFinite(u.owner) ? u.owner : localPlayerId;
    let front = spawnQueueFront(target);
    let remaining = Math.max(0, Math.floor((front.energyRequired || 0) - (front.energyPaid || 0)));
    if (remaining <= 0) return 0;
    let healWork = Math.max(1, Math.round(Number((u.preComputed && u.preComputed.healerDps) || 1)));
    return Math.max(0, Math.min(healWork, remaining));
}

function _healerRememberWorkSite(u, target = null) {
    let t = target || (u ? u.workerTarget : null);
    if (!u || !t) return;
    // (A unit target where it was at the pass's start: _unitTickX.)
    let tx = _thingTickX(t), ty = _thingTickY(t);
    if (Number.isFinite(tx) && Number.isFinite(ty)) {
        u._healerLastWorkX = tx;
        u._healerLastWorkY = ty;
    }
    if (Number.isFinite(t.gx) && Number.isFinite(t.gy)) {
        u._healerLastWorkGx = t.gx;
        u._healerLastWorkGy = t.gy;
    }
}

function _healerGetSearchOrigin(u) {
    if (u && Number.isFinite(u._healerLastWorkX) && Number.isFinite(u._healerLastWorkY)) {
        return { x: u._healerLastWorkX, y: u._healerLastWorkY };
    }
    return u;
}

function _getHealerQueueTargetNear(worldX, worldY, owner, radius = 22, requireNeedsWork = true) {
    let best = null;
    let bestDist = radius;
    let consider = (s) => {
        if (!s || s.owner !== owner || s.underConstruction) return;
        if (!hasSpawnQueue(s)) return;
        if (requireNeedsWork && !isQueueEnabled(s)) return;
        if (requireNeedsWork && !_isHealerQueueTarget(s, owner)) return;
        let d = detHypot(s.x - worldX, s.y - worldY);
        if (d < bestDist) {
            bestDist = d;
            best = s;
            return;
        }
        if (Math.abs(d - bestDist) <= 1e-9 && best) {
            let sy = Math.floor(Number(s.gy) || 0), by = Math.floor(Number(best.gy) || 0);
            let sx = Math.floor(Number(s.gx) || 0), bx = Math.floor(Number(best.gx) || 0);
            let si = Math.floor(Number(s.id) || 0), bi = Math.floor(Number(best.id) || 0);
            if (sy < by || (sy === by && (sx < bx || (sx === bx && si < bi)))) {
                best = s;
            }
        }
    };
    for (let b of barracks) consider(b);
    for (let s of collectorSpawners) consider(s);
    return best;
}

function _clearHealerQueueCommit(u) {
    if (!u) return;
    u._healerQueueCommitTarget = null;
    u._healerQueueCommitRequired = 0;
    u._healerQueueCommitMaxPaid = 0;
}

function _setHealerQueueCommit(u, target) {
    if (!u || !target || !(spawnQueueCount(target) > 0)) {
        _clearHealerQueueCommit(u);
        return;
    }
    let owner = Number.isFinite(u.owner) ? u.owner : localPlayerId;
    let front = spawnQueueFront(target);
    u._healerQueueCommitTarget = target;
    u._healerQueueCommitRequired = Math.max(1, Math.floor(Number(front.energyRequired) || 1));
    u._healerQueueCommitMaxPaid = Math.max(0, Math.floor(Number(front.energyPaid) || 0));
}

function _getHealerCommittedQueueTarget(u) {
    if (!u || u.workerTargetType !== 'queue') return null;
    let target = u.workerTarget;
    if (!target || target !== u._healerQueueCommitTarget) return null;
    if (!_isHealerQueueTarget(target, u.owner)) {
        _clearHealerQueueCommit(u);
        return null;
    }

    let owner = Number.isFinite(u.owner) ? u.owner : localPlayerId;
    let front = spawnQueueFront(target);
    let paid = Math.max(0, Math.floor(Number(front.energyPaid) || 0));
    let required = Math.max(1, Math.floor(Number(u._healerQueueCommitRequired) || 1));
    u._healerQueueCommitMaxPaid = Math.max(Math.floor(Number(u._healerQueueCommitMaxPaid) || 0), paid);

    // Keep this target until one queued unit is fully funded.
    if (u._healerQueueCommitMaxPaid >= required) {
        _clearHealerQueueCommit(u);
        return null;
    }
    return target;
}

function _findNearestQueuedSpawnerNeedingWork(u, originX = u.x, originY = u.y) {
    let candidates = [];
    let maxSearch = _getWorkerAutoSearchDistancePx(u);
    let maxSearchArea = _getWorkerAutoSearchDistanceArea(u);
    // The owner's barracks then spawners near enough (in the full lists'
    // order); the cheap distance test first (the queue test has no side
    // effects).
    // Only the owner's barracks and spawners in buckets around the search
    // box (the pick breaks ties by target: the order does not matter).
    const box=_workerSearchTileBox(u,originX,originY,maxSearch);
    let owner = u.owner;
    _forEachWorkInTileBox(_ownedQueueSpawners(owner), box[0],box[1],box[2],box[3], 'queue', (s) => _isHealerQueueTarget(s, owner), (s) => {
        let d = detHypot(s.x - originX, s.y - originY);
        if (!areaSearchEnabled()&&d > maxSearch) return;
        if (!_isHealerQueueTarget(s, owner)) return;
        if (!_isTargetWithinWorkerSearchLimits(u, originX, originY, s, maxSearchArea)) return;
        candidates.push({
            target: s,
            targetType: 'queue',
            dist: d,
        });
    });
    return _pickDistributedWorkerTarget(u, candidates);
}

// Barracks, then collector spawners, of one owner, in list order; rebuilt
// per tick (or when either list changes length).
let _ownedQueueSpawnersCache = { vb: -1, vs: -1, nb: -1, ns: -1, byOwner: new Map() };
function _ownedQueueSpawners(owner) {
    let c = _ownedQueueSpawnersCache;
    // Membership changes with the lists' versions (placements, removals).
    const vb = typeof barracksVersion === 'number' ? barracksVersion : _tileEntityVersion;
    const vs = typeof collectorSpawnersVersion === 'number' ? collectorSpawnersVersion : _tileEntityVersion;
    if (c.vb !== vb || c.vs !== vs || c.nb !== barracks.length || c.ns !== collectorSpawners.length || c.lb !== barracks || c.ls !== collectorSpawners) {
        c.vb = vb; c.vs = vs; c.nb = barracks.length; c.ns = collectorSpawners.length; c.lb = barracks; c.ls = collectorSpawners;
        c.byOwner = new Map();
        let add = (s) => {
            if (!s) return;
            let list = c.byOwner.get(s.owner);
            if (!list) c.byOwner.set(s.owner, list = []);
            list.push(s);
        };
        for (let b of barracks) add(b);
        for (let s of collectorSpawners) add(s);
    }
    return c.byOwner.get(owner) || [];
}

// (readOnly: the page's question (its mirrors are read-only): no task is
// started, a building with auto-research on counts.)
function _isResearcherTargetBuilding(target, owner, readOnly = false) {
    if (!target || target.type !== 'research') return false;
    if (target.owner !== owner) return false;
    if (target.energy <= 0 || target.underConstruction || target.markedForSalvage) return false;
    // (Only a building with auto-research on starts the queue's next task;
    // an active one any research building helps.)
    let task = getPlayerResearchTask(owner);
    if (!task) {
        if (!isAutoResearchEnabled(target)) return false;
        if (readOnly) return true;
        task = tryAdvancePlayerResearchTask(owner);
    }
    return _researchNeedsPoints(owner, task);
}

// The search tier's pick of a research building for u (or WS_WAITING): the
// tier looks by its owner's research (a task needing points: a usable
// building; no task: one with auto research on too; the take starts the
// queue's next task).
function _wsResearchPick(u) {
    const owner = u.owner;
    return _wsGridPick(u, WSW_RESEARCH, u, _getResearcherAutoSearchDistancePx(u), true, e => _isResearcherTargetBuilding(e, owner), 'research', WSR_RESEARCH);
}
// An idle researcher's search: a research building to work at, or wait.
function _researcherSearch(u) {
    let target = _wsAvailable() && u._us ? _wsResearchPick(u) : _findNearestResearchBuildingNeedingWork(u);
    if (target === WS_WAITING) { _wsWait(u); return; }
    if (target) {
        if (!_setWorkerTarget(u, target, 'research')) {
            u.workerState = 'IDLE';
            u.commandState = CMD_IDLE;
            return;
        }
        u.workerState = 'MOVING_TO_RESEARCH';
        let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
        u.path = _requestWorkerPath(u, startGx, startGy, target.gx, target.gy, null, null);
        u.pathIndex = 0;
        u.commandState = CMD_MOVING;
    } else {
        u.commandState = CMD_IDLE;
    }
}

function _findNearestResearchBuildingNeedingWork(u) {
    let candidates = [];
    let maxSearch = _getResearcherAutoSearchDistancePx(u);
    let maxSearchArea = _getWorkerAutoSearchDistanceArea(u);
    // Only buildings in the search box can be within the search distance.
    const box=_workerSearchTileBox(u,u.x,u.y,maxSearch);
    let owner = u.owner;
    _forEachWorkInTileBox(_getWorkerSpawnersByType('research'), box[0],box[1],box[2],box[3], 'research:' + owner, (s) => _isResearcherTargetBuilding(s, owner), (s) => {
        let d = detHypot(s.x - u.x, s.y - u.y);
        if (!areaSearchEnabled()&&d > maxSearch) return;
        if (!_isResearcherTargetBuilding(s, owner)) return;
        if (!_isTargetWithinWorkerSearchLimits(u, u.x, u.y, s, maxSearchArea)) return;
        candidates.push({
            target: s,
            targetType: 'research',
            dist: d,
        });
    });
    return _pickDistributedWorkerTarget(u, candidates);
}

const HEALER_CANDIDATE_CACHE_TICKS = 10;
let _healerDamagedCandidatesTick = -1;
let _healerDamagedCandidatesByOwner = [];
const HEALER_DAMAGED_CANDIDATE_LIMIT = 12;

// The most damaged units per owner (healer candidates; each is re-checked
// live when picked): made on the ticks that are multiples of
// HEALER_CANDIDATE_CACHE_TICKS by healerCandidatesStep (gameTick), so on
// every peer from the same state, and sent with snapshots.
// _healerCandidatesGen counts changes; idle healers look again when a
// candidate list changes near them (the healer work versions of the regions
// its candidates are in).
let _healerCandidatesGen = 0;
function _ensureHealerDamagedCandidatesCacheCurrent() {
    let ownerCount = Math.max(1, Math.floor(Number(players && players.length) || 0));
    if (_healerDamagedCandidatesByOwner.length !== ownerCount) {
        const prev = _healerDamagedCandidatesByOwner;
        _healerDamagedCandidatesByOwner = Array.from({ length: ownerCount }, (_, i) => prev[i] || []);
    }
}
// The scan is spread over a round of HEALER_CANDIDATE_CACHE_TICKS ticks (the
// units at index k, k + R, ... on the round's k-th tick); the round's lists
// are installed on its last tick. (The round in progress: _healerScanBest,
// dropped on every peer at a resync.)
let _healerScanBest = null;
// With the unit columns and helpers (a tier, lane HC_LANE): the round's
// first tick copies every slot's energy, max energy, owner, id, life (the
// columns, one copy each) and posts the scan (SIM_KERNEL_HEAL_CAND: per
// chunk and owner the lowest ratios); its last tick merges them (the same
// order: ratio, id) and installs the lists as below. Dropped at a resync on
// every peer (healerCandidatesTierReset), which also copies every unit's
// max energy into its column again.
const HC_LANE = typeof SIM_LANE_T05 === 'number' ? SIM_LANE_T05 : 5, HC_CHUNK = 16384;
let _hcPosted = null;
function _hcAvailable() { return typeof SIM_KERNEL_HEAL_CAND === 'number' && typeof simParallelBackground === 'function' && typeof _simUnitState !== 'undefined' && !!_simUnitState && !!_simUnitState.columns.maxE; }
function healerCandidatesTierReset() {
    if (typeof simParallelBackgroundWait === 'function') simParallelBackgroundWait(HC_LANE);
    _hcPosted = null;
    if (typeof simUnitMaxE === 'function') for (const u of units) if (u && u._us) simUnitMaxE(u);
}
function _hcArr(name, Type, n) {
    let a = _simParReg[name];
    if (!a || a.constructor !== Type || a.length < n) { const old = a; a = simHeapArray(Type, Math.max(1024, n + (n >> 2))); simParallelBind(name, a); simHeapFree(old); }
    return a;
}
function _hcPost(ownerCount, cap) {
    simParallelBackgroundWait(HC_LANE);
    const S = _simUnitState, c = S.columns, n = S.owners.length;
    // (The columns as they are now, copied on the helpers in one job.)
    const cp = [_hcArr('hc.e', Float32Array, n), c.energy, _hcArr('hc.m', Float32Array, n), c.maxE, _hcArr('hc.o', Int16Array, n), c.owner,
        _hcArr('hc.id', Int32Array, n), c.id, _hcArr('hc.l', Uint8Array, n), c.live, _hcArr('hc.d', Uint8Array, n), c.dead];
    for (let i = 1; i < cp.length; i += 2) cp[i] = cp[i].subarray(0, n);
    for (let i = 0; i < cp.length; i += 2) cp[i] = cp[i].subarray(0, n);
    if (typeof simParallelCopyHeap === 'function') simParallelCopyHeap(cp); else for (let i = 0; i < cp.length; i += 2) cp[i].set(cp[i + 1]);
    const chunks = Math.max(1, Math.ceil(n / HC_CHUNK));
    _hcArr('hc.res', Int32Array, chunks * ownerCount * cap); _hcArr('hc.rat', Float32Array, chunks * ownerCount * cap);
    const P = _simBgParamsByLane[HC_LANE];
    P[0] = n; P[1] = HC_CHUNK; P[2] = ownerCount; P[3] = cap;
    simParallelBackground(SIM_KERNEL_HEAL_CAND, chunks, HC_LANE);
    _hcPosted = { chunks, ownerCount, cap, n, reduced: false };
}
// The penultimate tick posts the merge. The final tick only consumes K
// answers per owner, independent of the number of slots/chunks scanned.
function _hcReduce() {
    const J = _hcPosted;
    if (!J || J.reduced) return;
    simParallelBackgroundWait(HC_LANE);
    _hcArr('hc.best', Int32Array, J.ownerCount * J.cap);
    _hcArr('hc.bestRat', Float32Array, J.ownerCount * J.cap);
    const P = _simBgParamsByLane[HC_LANE];
    P[0] = J.chunks; P[1] = J.ownerCount; P[2] = J.cap;
    simParallelBackground(SIM_KERNEL_HEAL_REDUCE, J.ownerCount, HC_LANE);
    J.reduced = true;
}
// The posted scan's lists per owner ({u, ratio, id}), or null.
function _hcCollect(ownerCount, cap) {
    const J = _hcPosted;
    _hcPosted = null;
    if (!J || !J.reduced || J.ownerCount !== ownerCount || J.cap !== cap) return null;
    simParallelBackgroundWait(HC_LANE);
    const RES = _simParReg['hc.best'], RAT = _simParReg['hc.bestRat'], ID = _simParReg['hc.id'], owners = _simUnitState.owners;
    const out = [];
    for (let o = 0; o < ownerCount; o++) {
        // (The owner's `cap` best as posted, then those still alive: past
        // them the chunks' lists would depend on the slot layout, which
        // differs on a peer that restored.)
        const list = [];
        for (let k = 0, b = o * cap; k < cap; k++) {
            const s = RES[b + k];
            if (s < 0) break;
            const id = Math.floor(ID[s]), u = owners[s];
            if (u && u.id === id && !u.dead) list.push({ u, ratio: RAT[b + k], id });
        }
        out.push(list);
    }
    return out;
}
function healerCandidatesStep() {
    const R = HEALER_CANDIDATE_CACHE_TICKS, ks = simStepPhases(R), k = ks[ks.length - 1];
    if (_hcAvailable()) {
        const ownerCount = Math.max(1, Math.floor(Number(players && players.length) || 0)), cap = Math.max(1, HEALER_DAMAGED_CANDIDATE_LIMIT | 0);
        // (The step's base ticks' phases in turn.)
        for (const k of ks) {
            if (k === 0) _hcPost(ownerCount, cap);
            if (k === R - 2) _hcReduce();
            if (k !== R - 1) continue;
            const best = _hcCollect(ownerCount, cap);
            if (best) _healerCandidatesInstall(best, ownerCount);
        }
        return;
    }
    let ownerCount = Math.max(1, Math.floor(Number(players && players.length) || 0));
    let cap = Math.max(1, HEALER_DAMAGED_CANDIDATE_LIMIT | 0);
    // The `cap` lowest (ratio, id) per owner, kept sorted while scanning
    // (no sort of every damaged unit).
    if (k === 0 || !_healerScanBest || _healerScanBest.length !== ownerCount) _healerScanBest = Array.from({ length: ownerCount }, () => []);
    let best = _healerScanBest;
    for (let idx = k; idx < units.length; idx += R) {
        const target = units[idx];
        if (!target || target.dead) continue;
        let owner = Math.floor(Number(target.owner));
        if (owner < 0 || owner >= ownerCount) continue;
        let energy = Number(target.energy), maxEnergy = Number(target.maxEnergy);
        if (!(maxEnergy > 0) || !(energy > 0) || !(energy < maxEnergy)) continue;
        let ratio = energy / maxEnergy, list = best[owner], id = Math.floor(Number(target.id) || -1);
        if (list.length >= cap) { const last = list[cap - 1]; if (ratio > last.ratio || (ratio === last.ratio && id >= last.id)) continue; }
        let i = list.length;
        while (i > 0 && (list[i - 1].ratio > ratio || (list[i - 1].ratio === ratio && list[i - 1].id > id))) i--;
        list.splice(i, 0, { u: target, ratio, id });
        if (list.length > cap) list.length = cap;
    }
    if (k !== R - 1) return;
    _healerScanBest = null;
    _healerCandidatesInstall(best, ownerCount);
}
function _healerCandidatesInstall(best, ownerCount) {
    // An owner's list changed: work for its idle healers within reach of its
    // candidates (their regions' healer versions), not for every healer of
    // every player.
    let changed = _healerDamagedCandidatesByOwner.length !== ownerCount;
    for (let o = 0; o < ownerCount; o++) {
        const a = _healerDamagedCandidatesByOwner[o] || [], b = best[o];
        let diff = a.length !== b.length;
        for (let i = 0; i < a.length && !diff; i++) if (a[i].u !== b[i].u) diff = true;
        if (!diff) continue;
        changed = true;
        for (const e of b) workerWorkChanged(o, 'healer', Math.floor(e.u.x / TILE), Math.floor(e.u.y / TILE));
    }
    _healerDamagedCandidatesByOwner = best;
    _healerDamagedCandidatesTick = gameTime;
    if (changed) _healerCandidatesGen = (_healerCandidatesGen + 1) | 0;
}
// Snapshots: [gen, [unit ids per owner]...].
function healerCandidatesChecksum() {
    let h = _healerCandidatesGen | 0;
    for (const l of _healerDamagedCandidatesByOwner) { h = Math.imul(h ^ l.length, 16777619); for (const e of l) h = Math.imul(h ^ (e.id | 0), 16777619); }
    return h;
}
function healerCandidatesSnapshot() { return [_healerCandidatesGen, _healerDamagedCandidatesByOwner.map(l => l.map(e => e.u.id))]; }
function healerCandidatesRestore(v, unitsById) {
    _healerCandidatesGen = Array.isArray(v) ? (v[0] | 0) : 0;
    _healerDamagedCandidatesByOwner = [];
    if (!Array.isArray(v) || !Array.isArray(v[1])) return;
    for (const ids of v[1]) {
        const list = [];
        if (Array.isArray(ids)) for (const id of ids) { const u = unitsById.get(id); if (u) list.push({ u, ratio: Number(u.energy) / Math.max(1e-9, Number(u.maxEnergy)), id }); }
        _healerDamagedCandidatesByOwner.push(list);
    }
}

function _findNearestDamagedFriendlyUnit(u, originX = u.x, originY = u.y) {
    let maxSearch = _getWorkerAutoSearchDistancePx(u);
    let maxSearchArea = _getWorkerAutoSearchDistanceArea(u);
    if (!(maxSearch > 0)) return null;
    let owner = Math.floor(Number(u.owner));
    _ensureHealerDamagedCandidatesCacheCurrent();
    if (owner < 0 || owner >= _healerDamagedCandidatesByOwner.length) return null;

    let healerX = Number(u.x) || 0;
    let healerY = Number(u.y) || 0;
    let originIsHealer = (originX === healerX && originY === healerY);
    let maxSearchSq = maxSearch * maxSearch;

    let bestA = null, bestAScore = Infinity;
    let bestB = null, bestBScore = Infinity;
    let bestC = null, bestCScore = Infinity;

    let tryAdd = (target, score) => {
        if (!target) return;
        if (target === bestA || target === bestB || target === bestC) return;
        if (score < bestAScore) {
            bestC = bestB; bestCScore = bestBScore;
            bestB = bestA; bestBScore = bestAScore;
            bestA = target; bestAScore = score;
        } else if (score < bestBScore) {
            bestC = bestB; bestCScore = bestBScore;
            bestB = target; bestBScore = score;
        } else if (score < bestCScore) {
            bestC = target; bestCScore = score;
        }
    };

    let candidates = _healerDamagedCandidatesByOwner[owner];
    if (!candidates || candidates.length <= 0) return null;

    for (let entry of candidates) {
        let target = entry && entry.u;
        if (!_isHealerTargetUnit(target, owner)) continue;
        // Both filters are pure; test the cheap distance before the area lookup.
        // (Units where they were at the pass's start: _unitTickX.)
        let tx0 = _unitTickX(target), ty0 = _unitTickY(target);
        let dx = tx0 - originX;
        let dy = ty0 - originY;
        let distSq = dx * dx + dy * dy;
        if (!areaSearchEnabled()&&distSq > maxSearchSq) continue;
        if (!_isTargetWithinWorkerSearchLimits(u, originX, originY, target, maxSearchArea)) continue;

        let worldDistSq = distSq;
        if (!originIsHealer) {
            let wdx = tx0 - healerX;
            let wdy = ty0 - healerY;
            worldDistSq = wdx * wdx + wdy * wdy;
        }

        let score = distSq + worldDistSq * 0.08;
        if (u.workerTarget === target) score -= TILE * TILE * 0.75;
        tryAdd(target, score);
    }

    if (bestA && _canAssignWorkerTargetExclusive(u, bestA, 'unit')) return bestA;
    if (bestB && _canAssignWorkerTargetExclusive(u, bestB, 'unit')) return bestB;
    if (bestC && _canAssignWorkerTargetExclusive(u, bestC, 'unit')) return bestC;
    return null;
}

function _healerFindTarget(u, myGx, myGy) {
    let origin = _healerGetSearchOrigin(u);
    let maxSearch = _getWorkerAutoSearchDistancePx(u);
    let hasPinnedQueueTarget = _isHealerQueueAnchorTarget(u._healerPinnedQueueTarget, u.owner);
    let queueTarget = _getHealerCommittedQueueTarget(u);
    if (!queueTarget && _isHealerQueueTarget(u._healerPinnedQueueTarget, u.owner)) {
        queueTarget = u._healerPinnedQueueTarget;
    }
    // (The search tier's pick when it runs: queues, then damaged units;
    // none yet: register, and wait.)
    let healUnits = null;
    if (!queueTarget) {
        if (_wsAvailable() && u._us) {
            const entry = _wsCur !== null && _wsCur.s === u._si ? _wsCur : null;
            const q = _wsGridPick(u, WSW_QUEUE, origin, maxSearch, true, e => _isHealerQueueTarget(e, u.owner), 'queue', WSR_HEAL);
            if (q === WS_WAITING) { _wsWait(u); return; }
            queueTarget = q;
            healUnits = entry && entry.id === u.id && entry.units ? entry.units : [];
        } else queueTarget = _findNearestQueuedSpawnerNeedingWork(u, origin.x, origin.y);
    }
    if (queueTarget) {
        let qd = detHypot(queueTarget.x - origin.x, queueTarget.y - origin.y);
        if (!hasPinnedQueueTarget && (areaSearchEnabled()
            ? !_isTargetWithinWorkerSearchLimits(u,origin.x,origin.y,queueTarget,_getWorkerAutoSearchDistanceArea(u))
            : qd > maxSearch)) {
            queueTarget = null;
            _clearHealerQueueCommit(u);
        }
    }
    if (queueTarget && !_canAssignWorkerTargetExclusive(u, queueTarget, 'queue')) queueTarget = null;
    if (queueTarget) {
        if (!_setWorkerTarget(u, queueTarget, 'queue')) {
            u.workerState = 'IDLE';
            u.commandState = CMD_IDLE;
            return;
        }
        _healerRememberWorkSite(u, queueTarget);
        if (queueTarget !== u._healerQueueCommitTarget) _setHealerQueueCommit(u, queueTarget);
        if (u.healerHasMaterial) {
            u.workerState = 'MOVING_TO_HEAL';
            let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
            u.path = _requestWorkerPath(u, startGx, startGy, queueTarget.gx, queueTarget.gy, null, null, true);
            u.pathIndex = 0;
            u.commandState = CMD_MOVING;
            return;
        }

        let route = _findBestSpawnerRoute(u, 'healer_spawner', null);
        let tripCost = _getHealerQueueTripCost(u, queueTarget);
        if (route && tripCost > 0) {
            u.workerState = 'RETURNING_FOR_GOLD';
            u.path = route.path;
            u.pathIndex = 0;
            u.commandState = CMD_MOVING;
            u._healerSpawnerTarget = route.spawner;
                        u.targetPos = route.spawner ? { x: route.spawner.gx * TILE + 16, y: route.spawner.gy * TILE + 16 } : null;
            u._healerQueueTripCost = tripCost;
            return;
        }

        u.workerState = 'IDLE';
        u.commandState = CMD_IDLE;
        return;
    }
    if (u._healerPinnedQueueTarget && !_isHealerQueueAnchorTarget(u._healerPinnedQueueTarget, u.owner)) {
        u._healerPinnedQueueTarget = null;
    }

    let target = healUnits ? _wsHealUnit(u, healUnits) : _findNearestDamagedFriendlyUnit(u, origin.x, origin.y);
    if (target && !_canAssignWorkerTargetExclusive(u, target, 'unit')) target = null;
    if (target) {
        _clearHealerQueueCommit(u);
        if (!_setWorkerTarget(u, target, 'unit')) {
            u.workerState = 'IDLE';
            u.commandState = CMD_IDLE;
            return;
        }
        _healerRememberWorkSite(u, target);
        if (u.healerHasMaterial) {
            u.workerState = 'MOVING_TO_HEAL';
            let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
            let targetGx = Math.floor(_unitTickX(target) / TILE), targetGy = Math.floor(_unitTickY(target) / TILE);
            u.path = _requestWorkerPath(u, startGx, startGy, targetGx, targetGy, null, null, true);
            u.pathIndex = 0;
            u.commandState = CMD_MOVING;
            return;
        }

        let route = _findBestSpawnerRoute(u, 'healer_spawner', null);
        if (route) {
            u.workerState = 'RETURNING_FOR_GOLD';
            u.path = route.path;
            u.pathIndex = 0;
            u.commandState = CMD_MOVING;
            u._healerSpawnerTarget = route.spawner;
                        u.targetPos = route.spawner ? { x: route.spawner.gx * TILE + 16, y: route.spawner.gy * TILE + 16 } : null;
            return;
        }

        u.workerState = 'IDLE';
        _clearWorkerTarget(u);
        u.commandState = CMD_IDLE;
    } else {
        _clearHealerQueueCommit(u);
        _clearWorkerTarget(u);
        u.workerState = 'IDLE';
        u.commandState = CMD_IDLE;
    }
}

// Work lists (a tier below the tick): per structure bucket and kind, the
// structures that passed the kind's work test the first time a search
// looked at the bucket in its window of WORKER_WORK_LIST_TICKS (windows
// staggered by bucket; made anew on every peer after a resync). Searches
// re-check these live instead of every structure of the bucket; work that
// appears within a window is seen in the next. (The builders' test starts
// due upgrades, so those start at a bucket's look.)
const WORKER_WORK_LIST_TICKS = 20;
let _workerWorkListGen = 0;
const _workerWorkLists = new WeakMap();
function _bucketWorkList(bucket, k, key, pred) {
    let m = _workerWorkLists.get(bucket);
    if (!m) _workerWorkLists.set(bucket, m = new Map());
    const win = Math.floor((gameTime + k % WORKER_WORK_LIST_TICKS) / WORKER_WORK_LIST_TICKS);
    const c = m.get(key);
    if (c && c.win === win && c.gen === _workerWorkListGen) return c.work;
    const work = [];
    for (let i = 0; i < bucket.length; i++) if (pred(bucket[i])) work.push(bucket[i]);
    m.set(key, { win, gen: _workerWorkListGen, work });
    return work;
}
// _forEachStructureInTileBox over the buckets' work lists of a kind.
function _forEachWorkInTileBox(list, x0, y0, x1, y1, key, pred, fn) {
    let index = _structureBuckets(list), B = STRUCTURE_BUCKET_TILES;
    let bx0 = Math.max(0, Math.floor(x0 / B)), bx1 = Math.min(index.cols - 1, Math.floor(x1 / B));
    let by0 = Math.max(0, Math.floor(y0 / B)), by1 = Math.min(index.rows - 1, Math.floor(y1 / B));
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
        const k = by * index.cols + bx, bucket = index.buckets[k];
        if (!bucket) continue;
        const work = _bucketWorkList(bucket, k, key, pred);
        for (let i = 0; i < work.length; i++) fn(work[i]);
    }
}

function _findNearestUnderConstruction(u, originX = u.x, originY = u.y) {
    let owner = Number.isFinite(u.owner) ? u.owner : localPlayerId;
    let buckets = _ownedStructureBuckets(owner);
    if (!buckets) return null;
    let candidates = [];
    let maxSearch = _getWorkerAutoSearchDistancePx(u);
    let maxSearchArea = _getWorkerAutoSearchDistanceArea(u);
    // The owner's structures in buckets around the search box, checked live
    // (the pick breaks ties by target, so the visiting order does not matter).
    const box=_workerSearchTileBox(u,originX,originY,maxSearch,2);
    let B = STRUCTURE_BUCKET_TILES, X = _ownedStructIndex;
    let bx0 = Math.max(0, Math.floor(box[0] / B)), bx1 = Math.min(X.cols - 1, Math.floor(box[2] / B));
    let by0 = Math.max(0, Math.floor(box[1] / B)), by1 = Math.min(X.rows - 1, Math.floor(box[3] / B));
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
        let list = buckets[by * X.cols + bx];
        if (!list) continue;
        let work = _bucketWorkList(list, by * X.cols + bx, 'build', (b) => _isBuilderWorkTarget(b, owner));
        for (let i = 0; i < work.length; i++) {
            let b = work[i];
            if (!areaSearchEnabled()&&(Math.abs(b.x - originX) > maxSearch || Math.abs(b.y - originY) > maxSearch)) continue;
            if (!_isBuilderWorkTarget(b, owner)) continue;
            if (!_isTargetWithinWorkerSearchLimits(u, originX, originY, b, maxSearchArea)) continue;
            let d = detHypot(b.x - originX, b.y - originY);
            if (!areaSearchEnabled()&&d > maxSearch) continue;
            candidates.push({ target: b, dist: d });
        }
    }
    return _pickDistributedWorkerTarget(u, candidates);
}

// Spawners of one type in buckets of STRUCTURE_BUCKET_TILES tiles (the
// list only changes with the tile index): nearest and box queries visit the
// buckets around a point instead of every spawner of the type.
const STRUCTURE_BUCKET_TILES = 16;
const _structureBucketIndexes = new WeakMap();
function _structureBuckets(list) {
    let index = _structureBucketIndexes.get(list);
    if (index && index.length === list.length && index.w === GRID_W && index.h === GRID_H) return index;
    let B = STRUCTURE_BUCKET_TILES, cols = Math.ceil(GRID_W / B), rows = Math.ceil(GRID_H / B);
    index = { length: list.length, w: GRID_W, h: GRID_H, cols, rows, buckets: new Array(cols * rows) };
    for (let s of list) {
        if (!s) continue;
        let bx = Math.max(0, Math.min(cols - 1, Math.floor((Number(s.gx) || 0) / B)));
        let by = Math.max(0, Math.min(rows - 1, Math.floor((Number(s.gy) || 0) / B)));
        (index.buckets[by * cols + bx] ||= []).push(s);
    }
    _structureBucketIndexes.set(list, index);
    return index;
}

// Cell items of one type (farms...), in tile order: kept up to date from
// the tile entity journal (a new list when one of the type changed).
let _cellItemsByTypeCache = new Map(), _cellItemsByTypeSet = null;
const _cellItemsByTypeCursor = { epoch: -1, pos: 0 };
function _cellItemsOfType(type) {
    // (Without the journal, e.g. in isolated tests: a list per call.)
    if (typeof tileEntityChangesSince !== 'function' || typeof _activeTileEntities === 'undefined') {
        let out = [];
        for (let item of getCellItemsRowMajor()) if (item.type === type) out.push(item);
        return out;
    }
    const changes = _cellItemsByTypeSet === _activeTileEntities ? tileEntityChangesSince(_cellItemsByTypeCursor) : null;
    if (changes === null) {
        if (_cellItemsByTypeSet !== _activeTileEntities) tileEntityChangesSince(_cellItemsByTypeCursor);
        _cellItemsByTypeCache = new Map(); _cellItemsByTypeSet = _activeTileEntities;
    } else if (changes.length && _cellItemsByTypeCache.size) {
        // A burst of removals/placements used to copy each type's entire
        // list once per edited tile. Apply its journal in one copy, keeping
        // the old list intact for searches already holding it.
        for (const [ty, list] of _cellItemsByTypeCache) {
            const next = _tileOrderedReplaceMany(list, changes, t => {
                const item = _cellItemAtTile(t);
                return item && item.type === ty ? item : null;
            }, true);
            if (next !== list) _cellItemsByTypeCache.set(ty, next);
        }
    }
    let list = _cellItemsByTypeCache.get(type);
    if (!list) {
        list = [];
        for (let item of getCellItemsRowMajor()) if (item.type === type) list.push(item);
        _cellItemsByTypeCache.set(type, list);
    }
    return list;
}

// The live drops as a list for the bucket index, re-made when drops change.
let _dropBucketList = [], _dropBucketVersion = -1, _dropBucketSource = null, _dropBucketLength = -1;
function _droppedItemsForBuckets() {
    if (_dropBucketVersion !== droppedItemsVersion || _dropBucketSource !== droppedItems || _dropBucketLength !== droppedItems.length) {
        _dropBucketList = droppedItems.filter(d => !!d);
        _dropBucketVersion = droppedItemsVersion; _dropBucketSource = droppedItems; _dropBucketLength = droppedItems.length;
    }
    return _dropBucketList;
}

// Every structure of `list` in buckets overlapping the tile box.
function _forEachStructureInTileBox(list, x0, y0, x1, y1, fn) {
    let index = _structureBuckets(list), B = STRUCTURE_BUCKET_TILES;
    let bx0 = Math.max(0, Math.floor(x0 / B)), bx1 = Math.min(index.cols - 1, Math.floor(x1 / B));
    let by0 = Math.max(0, Math.floor(y0 / B)), by1 = Math.min(index.rows - 1, Math.floor(y1 / B));
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
        let bucket = index.buckets[by * index.cols + bx];
        if (bucket) for (let i = 0; i < bucket.length; i++) fn(bucket[i]);
    }
}

// The structures' tiles worth a look, ascending (ord.rs k_ws_candidates):
// the collectors' groups' from the floor items' and spawners' rows and the
// mines, made again when any structure comes or goes (the tile table's
// version); the spawner index's from the spawners' rows alone, when
// spawners come or go. Not every tile of the map.
const _wsCand = { all: { sig: -1 }, spawners: { sig: -1 }, P: new Float64Array(12) };
function _wsCandidates(spawnersOnly = false) {
    const C = spawnersOnly ? _wsCand.spawners : _wsCand.all;
    const sig = spawnersOnly ? (typeof collectorSpawnersVersion === 'number' ? collectorSpawnersVersion : _tileEntityVersion) : _tileEntityVersion;
    if (C.sig === sig && C.tiles && simHeapHas(C.tiles) && C.w === GRID_W) return C;
    if (_ST.code && !simHeapHas(_ST.code)) structTablesRehome();
    const cls = STRUCT_STATUS_CLASSES().filter(K => K && K !== Tower && K !== Barrack && (!spawnersOnly || K !== FloorItem)), tabs = [];
    let room = 0;
    for (const K of cls) { const T = _sTables.get(K); if (!T || !T.n) continue; if (!_sColsInHeap(T)) _sTableGrow(T, T.cap); tabs.push(T); room += T.n; }
    if (!spawnersOnly && _ST.mineArr && !simHeapHas(_ST.mineArr)) { const m = simSharedArray(Int32Array, Math.max(64, _ST.mineArr.length)); m.set(_ST.mineArr); _ST.mineArr = m; }
    if (!spawnersOnly) room += _ST.mineN || 0;
    if (!C.tiles || C.tiles.length < room || !simHeapHas(C.tiles)) { C.tiles = simSharedArray(Int32Array, Math.max(1024, Math.ceil(room * 1.25))); C.tmp = simSharedArray(Int32Array, C.tiles.length); }
    if (!C.cnt || !simHeapHas(C.cnt)) C.cnt = simSharedArray(Int32Array, 4);
    const P = _wsCand.P, args = [];
    for (let j = 0; j < 8; j++) { const T = tabs[j]; args.push(T ? T.c__stT : null); P[1 + j] = T ? T.n : 0; }
    P[0] = Math.min(8, tabs.length); P[9] = spawnersOnly ? 0 : _ST.mineN || 0; P[10] = _ST.n || 0;
    args.push(spawnersOnly ? null : _ST.mineArr || null, _ST.rrow, _ST.code, C.tmp, C.tiles, C.cnt);
    C.cnt[0] = 0;
    if (_ST.n && _ST.code) simRustDirect('k_ws_candidates', args, P);
    C.n = C.cnt[0]; C.sig = sig; C.w = GRID_W;
    return C;
}
// Spawners by (type, owner) in tile order (ord.rs k_spawner_index), from
// the candidates: the nearest working one by k_spawner_nearest.
const SPAWNER_OWNER_SLOTS = 17;
const _spIdx = { sig: -1, nty: 0, tiles: null, off: null, out: null, P: new Float64Array(8) };
function _spawnerIndex() {
    const X = _spIdx, C = _wsCandidates(true), nty = _stationaryTypes.length;
    if (X.sig === C.sig && X.nty === nty && X.w === GRID_W && X.tiles && simHeapHas(X.tiles) && X.cand === C.tiles) return X;
    const nb = nty * SPAWNER_OWNER_SLOTS;
    if (!X.tiles || X.tiles.length < C.n || !simHeapHas(X.tiles)) X.tiles = simSharedArray(Int32Array, Math.max(1024, Math.ceil(C.n * 1.25)));
    if (!X.off || X.off.length < 2 * nb + 2 || !simHeapHas(X.off)) X.off = simSharedArray(Int32Array, Math.max(256, 2 * (2 * nb + 2)));
    if (!X.out || !simHeapHas(X.out)) X.out = simSharedArray(Int32Array, 4);
    const P = X.P;
    P[0] = C.n; P[1] = nty; P[2] = SPAWNER_OWNER_SLOTS; P[3] = ST_OWNER_NONE;
    simRustDirect('k_spawner_index', [C.tiles, _ST.code, _ST.own, _ST.brain, X.tiles, X.off], P);
    X.sig = C.sig; X.nty = nty; X.w = GRID_W; X.cand = C.tiles;
    return X;
}
// The nearest working spawner of the type and owner to (x, y) (by tile
// Manhattan distance, then row, column): its object, null none.
function _spawnerNearest(type, owner, x, y, retry = false) {
    const ty = _stationaryTypeIds.get(type);
    if (ty === undefined || !(owner >= -1 && owner < SPAWNER_OWNER_SLOTS - 1) || !_ST.n) return null;
    const X = _spawnerIndex(), b = ty * SPAWNER_OWNER_SLOTS + owner + 1;
    if (ty >= X.nty || X.off[b + 1] === X.off[b]) return null;
    const P = X.P;
    P[0] = b; P[1] = Math.floor(Number(x) / TILE); P[2] = Math.floor(Number(y) / TILE); P[3] = GRID_W;
    simRustDirect('k_spawner_nearest', [X.tiles, X.off, _ST.val, _ST.uc, X.out], P);
    const t = X.out[0], s = t >= 0 ? getTileEntityRef(t % GRID_W, (t - t % GRID_W) / GRID_W) : null;
    // (A change the spawners' version missed: the index made again, once.)
    if (t >= 0 && !(s && s.type === type && s.owner === owner)) { if (retry) return null; _wsCand.spawners.sig = -1; return _spawnerNearest(type, owner, x, y, true); }
    return s;
}
let WORKER_BRAIN_WASM=true;
const _workerBrainSpawnerTypes=['spawner','astar_spawner','salvager','builder_spawner','healer_spawner','research'];
const _workerBrain={arrays:{},tick:-1,prepared:0,used:0,misses:0};
function _workerBrainArray(name,Type,n){
    const B=_workerBrain,old=B.arrays[name];if(old&&old.length>=n)return old;
    const a=B.arrays[name]=simSharedArray(Type,simReserveCap(Math.max(n,1),256));simParallelBind('wb.'+name,a);if(old)simHeapFree(old);return a;
}
// (list: slot * 8 + code entries, the first n: the tick's events by default.)
function workerBrainsPrepare(n,defer=false,list=null){
    simParallelBind('wb.list',list||_unitEvSort.sorted);
    if(_workerBrain.pending)workerBrainsCollect();
    const B=_workerBrain;B.active=false;B.tick=-1;B.prepared=0;B.used=0;B.misses=0;
    // (Any number of events: the worker kernel takes its nearest spawners from it, wai.rs brain_spawner.)
    if(!WORKER_BRAIN_WASM||n<1||!_ST.n||!_simUnitState?.wk||_simUnitState.wk.used-_simUnitState.wk.free.length<=1||!_simWasmOk(_simParReg)||typeof _simWasmX.k_worker_spawners!=='function')return;
    const w=GRID_W,h=GRID_H,cols=Math.ceil(w/8),nb=cols*Math.ceil(h/8),np=players.length,stride=Math.ceil((np+1)/16)*16;
    _workerBrainArray('sites',Uint16Array,nb*64);_workerBrainArray('count',Int32Array,nb*stride);_workerBrainArray('any',Int32Array,np*16);
    for(const key of ['code','own','uc','val','brain'])simParallelBind('st.'+key,_ST[key]);
    const lane=SIM_LANE_TICK;
    for(let stage=0;stage<3;stage++){
        const P=simParallelStageParams(lane,stage);P.fill(0);P[0]=nb;P[1]=32;P[2]=stage;P[3]=w;P[4]=h;P[5]=cols;P[6]=np;P[7]=stride;
        for(let k=0;k<6;k++)P[16+k]=(_stationaryTypeIds.get(_workerBrainSpawnerTypes[k])??-1)+1;
        if(stage===2){P[0]=n;P[1]=256;P[2]=gameTime;P[8]=TILE*8;}
    }
    B.pending={tick:gameTime,n};
    simParallelBackgroundChain(lane,[[SIM_KERNEL_WORKER_SITES,Math.ceil(nb/32)],[SIM_KERNEL_WORKER_SITES,np],[SIM_KERNEL_WORKER_SPAWNERS,Math.ceil(n/256)]]);
    if(!defer)workerBrainsCollect();
}
function workerBrainsCollect(){
    const B=_workerBrain,J=B.pending;if(!J)return;
    simParallelBackgroundWait(SIM_LANE_TICK);B.tick=J.tick;B.prepared=J.n;B.pending=null;B.active=true;
}
function workerBrainsEnd(){_workerBrain.active=false;}
function _findClosestSpawner(u, type) {
    if(WORKER_BRAIN_WASM&&_workerBrain.active&&_workerBrain.tick===gameTime&&u&&u._us){
        const c=u._us,w=c.wkIx[u._si];
        if(w>0&&c.wbTick[w]===gameTime&&type===_workerBrainSpawnerTypes[c.wbType[w]-1]){
            const t=c.wbSpawner[w];
            if(t===-1){_workerBrain.used++;return null;}
            const s=t>=0?getTileEntityRef(t%GRID_W,Math.floor(t/GRID_W)):null;
            if(s&&s.type===type&&s.owner===u.owner&&s.energy>0&&!s.underConstruction){_workerBrain.used++;return s;}
            _workerBrain.misses++;
        }
    }
    return _spawnerNearest(type, u && u.owner, u && u.x, u && u.y);
}

function _workerReturnPath(u) {
    if (!u) return;
    let resourceCollector = getResourceCollectorConfigByWorkerType(u.workerType);
    let needsReturnPayload = (!!resourceCollector || u.workerType === 'salvager');
    if (needsReturnPayload && !(Number(u.carryingValue) > 0)) {
        _clearWorkerAutoRoute(u);
        return;
    }
    let type = resourceCollector
        ? resourceCollector.collectorBuildingKey
        : (u.workerType === 'salvager' ? 'salvager' : null);
    let route = _findBestSpawnerRoute(u, type);
    if (route) {
        if (resourceCollector && route.spawner) _setResourceCollectorNextSpawner(u, route.spawner);
        u.path = route.path || [];
        u.pathIndex = 0; u.commandState = CMD_MOVING;
    } else {
        u.path = []; u.pathIndex = 0; u.commandState = CMD_IDLE;
    }
}


// Orders that mean the same given to their units in parts: one with more
// units than an action may carry (ACTION_MAX_UNIT_IDS, main.js; the rest
// would be dropped) goes as several.
const ACTION_SPLIT_BY_UNITS = new Set(['move', 'attackMove', 'attack', 'attackBuilding', 'stop', 'hold']);
// The tick a command of this player goes in now.
function _localActionTick() {
    // Fair delay starts at the completed tick the player sees, including on
    // the host. Ticks merely queued in a busy worker must not add another
    // private delay on top of the shared command lead.
    let actionLead = netCommandLeadTicks();
    let commandTick = isMultiplayer && gameStarted ? netCompletedSimulationTick() : currentTick;
    let tick = Math.max(currentTick, commandTick + actionLead);
    if (isMultiplayer && gameStarted && !isHost && resyncGuest.liveFromTick > tick) tick = resyncGuest.liveFromTick;
    if (isMultiplayer && gameStarted) {
        // A sent packet may already be sealed by the host, and a sealed tick
        // never changes, so new commands always go to a later tick. This also
        // keeps commands safe when the input delay shrinks.
        if (!isHost) tick = Math.max(tick, lockstepHighestSentLocalTick + 1);
        // The host caps packets against floods. Spill legitimate local bursts
        // into later unsent ticks instead of letting that cap discard orders.
        while (lockstepCommittedByTick[tick] || lockstepBundleByTick[tick]
            || (localInputBuffer[tick] || []).length >= LOCKSTEP_MAX_ACTIONS_PER_PACKET) tick++;
    }
    return tick;
}
// A command already made (its id kept) into the tick it may go in now: a
// command not yet sent when the match was reloaded on this peer
// (utils_networking.js applyIncomingMatchSyncPayload).
function requeueLocalAction(finalAction) {
    if (!finalAction || gameOver) return;
    let tick = _localActionTick();
    (localInputBuffer[tick] || (localInputBuffer[tick] = [])).push(finalAction);
    delete lockstepLocalPacketByTick[tick];
    if (isHost && lockstepHostPacketsByTick[tick] && myPeerId) delete lockstepHostPacketsByTick[tick][myPeerId];
}
// (Returns the tick it goes in: undefined when it went nowhere.)
function queueAction(action) {
    if (localDefeated && action && action.action !== 'resign') return;
    return _queueLocalAction(action);
}
// The host's administrative commands (HOST_ADMIN_ACTIONS: a leaving
// player's team resigned): the match's, not the host's player's, so they go
// in while the host is defeated or spectates too (queueAction refused them:
// in a three-team match whose host had resigned, a leaving player's team
// stayed in and the last one never won: audit 2026-10-16, 26). Guests'
// copies are dropped by the host (main.js _hostSanitizeTickPacket).
function queueHostAdminAction(action) {
    if (!isHost || !action || !HOST_ADMIN_ACTIONS.has(action.action)) return;
    _queueLocalAction(action);
}
// (Told of each unit order this player makes: main.js keeps those made
// while a big multi-point split is still on its worker, whose late answer
// leaves their units out: the later order wins, as on the wire.)
let localUnitOrderHook = null;
function _queueLocalAction(action) {
    if (gameOver) return;
    if (localUnitOrderHook && action && Array.isArray(action.unitIds)) localUnitOrderHook(action);
    // (A research order: shown at once, see hud.js noteResearchOrder.)
    if (action && (action.action === 'queueResearch' || action.action === 'dequeueResearch') && typeof noteResearchOrder === 'function') {
        noteResearchOrder(action.kind, action.key, action.statKey, (action.action === 'queueResearch' ? 1 : -1) * Math.max(1, Math.floor(Number(action.count) || 1)));
    }
    if (action && Array.isArray(action.unitIds) && typeof ACTION_MAX_UNIT_IDS === 'number' && action.unitIds.length > ACTION_MAX_UNIT_IDS && ACTION_SPLIT_BY_UNITS.has(action.action)) {
        for (let i = 0; i < action.unitIds.length; i += ACTION_MAX_UNIT_IDS) queueAction({ ...action, unitIds: action.unitIds.slice(i, i + ACTION_MAX_UNIT_IDS) });
        return;
    }
    // Just joined and still catching up: sent once the host counts us in.
    if (isMultiplayer && gameStarted && resyncGuestHoldAction(action)) return;
    if (isMultiplayer && gameStarted && !isHost && !netGetHostConnection()) {
        // Commands issued while reconnecting are kept and sent once the link
        // is back (they are scheduled after every tick already sent).
        scheduleGuestAutoReconnect('Lost host connection');
    }
    let tick = _localActionTick();
    if (!localInputBuffer[tick]) localInputBuffer[tick] = [];
    let actorId = myPeerId || `p${localPlayerId}`;
    let finalAction = { ...action, teamId: localPlayerId, netId: `${actorId}:${_localActionEpoch}:${nextLocalActionSeq++}` };
    if (typeof noteOrderMarker === 'function') noteOrderMarker(action, tick);
    // A long id list goes compactly (main.js actionIdsEncode; every peer,
    // this one too, decodes it when it processes the action).
    if (Array.isArray(finalAction.unitIds) && finalAction.unitIds.length >= 64 && typeof actionIdsEncode === 'function') {
        const z = actionIdsEncode(finalAction.unitIds);
        if (z !== null) { finalAction.uidz = z; delete finalAction.unitIds; }
    }
    localInputBuffer[tick].push(finalAction);

    // The tick is unsent (guest) or unsealed (host): rebuild its packet.
    delete lockstepLocalPacketByTick[tick];
    if (isHost && lockstepHostPacketsByTick[tick] && myPeerId) {
        delete lockstepHostPacketsByTick[tick][myPeerId];
    }
    return tick;
}

// A worker's role memory of its task (unit.js UNIT_ROLE_FIELDS) let go: the
// part of clearWorkerTaskMemoryForFreeRetarget an order kernel leaves pending.
function clearWorkerRoleMemory(u) {
    if (isResourceCollectorWorkerType(u.workerType)) _clearResourceCollectorTaskMemory(u);
    else if (u.workerType === 'builder') { u._builderLastWorkX = null; u._builderLastWorkY = null; u._builderLastWorkGx = null; u._builderLastWorkGy = null; u._builderSpawnerTarget = null; }
    else if (u.workerType === 'healer') {
        u._healerPinnedQueueTarget = null; _clearHealerQueueCommit(u);
        u._healerLastWorkX = null; u._healerLastWorkY = null; u._healerLastWorkGx = null; u._healerLastWorkGy = null; u._healerSpawnerTarget = null; u._healerQueueTripCost = 0;
    } else if (u.workerType === 'researcher') { u._researchSpawnerTarget = null; u._researcherTripWork = 0; u._researcherTripCost = 0; u._researcherMaterialReadyTick = 0; }
}
function clearWorkerTaskMemoryForFreeRetarget(u) {
    if (!u || !u.workerState) return;
    if (isResourceCollectorWorkerType(u.workerType)) {
        _clearResourceCollectorTaskMemory(u);
    } else if (u.workerType === 'builder') {
        u._builderLastWorkX = null;
        u._builderLastWorkY = null;
        u._builderLastWorkGx = null;
        u._builderLastWorkGy = null;
        u._builderSpawnerTarget = null;
        u.builderHasMaterial = false;
    } else if (u.workerType === 'healer') {
        u._healerPinnedQueueTarget = null;
        _clearHealerQueueCommit(u);
        u._healerLastWorkX = null;
        u._healerLastWorkY = null;
        u._healerLastWorkGx = null;
        u._healerLastWorkGy = null;
        u._healerSpawnerTarget = null;
        u._healerQueueTripCost = 0;
        u.healerHasMaterial = false;
    } else if (u.workerType === 'researcher') {
        u._researchSpawnerTarget = null;
        u._researcherTripWork = 0;
        u._researcherTripCost = 0;
        u._researcherMaterialReadyTick = 0;
        u.researcherHasMaterial = false;
    }
    u._workerNextIdleRetargetTick = gameTime; u._idleFailVer = -1;
}

function interruptWorkerForManualMove(u) {
    if (!u || u.dead || !u.workerState) return;
    _clearWorkerTarget(u, 'manual_rally_change');
    clearWorkerTaskMemoryForFreeRetarget(u);
    u.targetUnit = null;
    u.targetBuilding = null;
    u.forcedAttackTarget = false;
    u._forcedTargetLastSeenX = null;
    u._forcedTargetLastSeenY = null;
    u.path = null;
    u.pathIndex = 0;
    u._pendingPathTarget = null;
    u.pathIsFallbackAstar = false;
    u._manualMoveIssuedTick = gameTime;
    u.workerState = 'MANUAL_MOVE';
}

function issueWorkerBlockedAssignFallbackMove(u, targetGx, targetGy) {
    if (!u || u.dead || !u.workerState) return;
    let gx = Math.max(0, Math.min(GRID_W - 1, Math.floor(targetGx)));
    let gy = Math.max(0, Math.min(GRID_H - 1, Math.floor(targetGy)));
    let targetX = gx * TILE + TILE / 2;
    let targetY = gy * TILE + TILE / 2;

    interruptWorkerForManualMove(u);
    u.commandState = CMD_MOVING;
    u.targetPos = { x: targetX, y: targetY };

    // (The flow navigation's way; none: it stays.)
    u.path = typeof navPathTo === 'function' ? navPathTo(u, gx, gy) : null;
    u.pathIndex = 0;
    u._pendingPathTarget = null;
}

function _releaseManualWorkerAssignmentConflicts(assigningUnit, target, targetType = null) {
    if (!assigningUnit || !target || !assigningUnit.workerState) return;
    // (The worker holding the target's tile for this type: the reservation table's.)
    const slot = _getWorkerReservationSlotIndex(target, assigningUnit.workerType);
    const other = slot >= 0 ? workerReservedAt(slot) : null;
    if (other && other !== assigningUnit && !other.dead && other.workerState && other.owner === assigningUnit.owner && other.workerType === assigningUnit.workerType) {
        _clearWorkerTarget(other, 'manual_rally_change');
        clearWorkerTaskMemoryForFreeRetarget(other);
        other.path = null;
        other.pathIndex = 0;
        other._pendingPathTarget = null;
        other.commandState = CMD_IDLE;
        other.workerState = 'IDLE';
    }
}

function applyWorkerRallyFromSpawner(u, spawner) {
    if (!u || u.dead || !u.workerType || !spawner) return false;
    let rallyTarget = getSpawnerRallyTargetWorld(spawner);
    if (!rallyTarget || !Number.isFinite(rallyTarget.x) || !Number.isFinite(rallyTarget.y)) return false;

    let targetGx = Math.max(0, Math.min(GRID_W - 1, Math.floor(rallyTarget.x / TILE)));
    let targetGy = Math.max(0, Math.min(GRID_H - 1, Math.floor(rallyTarget.y / TILE)));
    let myGx = Math.floor(u.x / TILE);
    let myGy = Math.floor(u.y / TILE);
    u.targetPos = { x: targetGx * TILE + 16, y: targetGy * TILE + 16 };

    if (isResourceCollectorWorkerType(u.workerType)) {
        let resourceCfg = getResourceCollectorConfigByWorkerType(u.workerType);
        let gather = resourceCfg ? _getResourceCollectorGatherTargetNear(rallyTarget.x, rallyTarget.y, u.owner, resourceCfg, TILE) : null;
        if (!(gather && gather.target && _isResourceCollectorTargetValid(gather.target, gather.type, u.owner, resourceCfg))) return false;
        _releaseManualWorkerAssignmentConflicts(u, gather.target, gather.type);
        if (!_canAssignWorkerTargetExclusive(u, gather.target, gather.type)) return false;
        _clearWorkerTarget(u, 'manual_rally_change');
        _setResourceCollectorPinnedTarget(u, gather.target, gather.type, resourceCfg);
        _resourceCollectorAssignTarget(u, gather.target, gather.type, resourceCfg);
        u._workerNextIdleRetargetTick = gameTime; u._idleFailVer = -1;
        return true;
    }

    if (u.workerType === 'builder') {
        let target = _getBuilderWorkTargetAt(targetGx, targetGy, u.owner, true);
        if (!target) return false;
        _releaseManualWorkerAssignmentConflicts(u, target, null);
        if (!_canAssignWorkerTargetExclusive(u, target, null)) return false;
        target.buildEnabled = true;
        _clearWorkerTarget(u, 'manual_rally_change');
        _builderAssignTarget(u, target, myGx, myGy);
        u._workerNextIdleRetargetTick = gameTime; u._idleFailVer = -1;
        return true;
    }

    if (u.workerType === 'healer') {
        let qTarget = getTileEntityRef(targetGx, targetGy);
        if (!_isHealerQueueAnchorTarget(qTarget, u.owner)) return false;
        _releaseManualWorkerAssignmentConflicts(u, qTarget, 'queue');
        if (!_canAssignWorkerTargetExclusive(u, qTarget, 'queue')) return false;
        _clearWorkerTarget(u, 'manual_rally_change');
        u._healerPinnedQueueTarget = qTarget;
        if (_isHealerQueueTarget(qTarget, u.owner)) _setHealerQueueCommit(u, qTarget);
        else _clearHealerQueueCommit(u);
        _healerFindTarget(u, myGx, myGy);
        u._workerNextIdleRetargetTick = gameTime; u._idleFailVer = -1;
        return true;
    }

    if (u.workerType === 'researcher') {
        let rTarget = getTileEntityRef(targetGx, targetGy);
        if (!_isResearcherTargetBuilding(rTarget, u.owner)) return false;
        _releaseManualWorkerAssignmentConflicts(u, rTarget, 'research');
        if (!_canAssignWorkerTargetExclusive(u, rTarget, 'research')) return false;
        _clearWorkerTarget(u, 'manual_rally_change');
        if (!_setWorkerTarget(u, rTarget, 'research')) return false;
        u.workerState = 'MOVING_TO_RESEARCH';
        u._researchSpawnerTarget = null;
        u.path = _requestWorkerPath(u, myGx, myGy, rTarget.gx, rTarget.gy, null, null);
        u.pathIndex = 0;
        u.commandState = u.path && u.path.length > 0 ? CMD_MOVING : CMD_IDLE;
        u._workerNextIdleRetargetTick = gameTime; u._idleFailVer = -1;
        return true;
    }

    if (u.workerType === 'salvager') {
        let target = getTileEntityRef(targetGx, targetGy) || getFloorItemAtTile(targetGx, targetGy);
        if (!(target && target.owner === u.owner && target.markedForSalvage)) return false;
        _releaseManualWorkerAssignmentConflicts(u, target, null);
        if (!_canAssignWorkerTargetExclusive(u, target, null)) return false;
        _clearWorkerTarget(u, 'manual_rally_change');
        if (!_setWorkerTarget(u, target, null)) return false;
        let canWalk = (nx, ny) => nx === target.gx && ny === target.gy;
        u.path = _requestWorkerPath(u, myGx, myGy, target.gx, target.gy, canWalk, null, true);
        if (u.path) {
            u.workerState = 'MOVING_TO';
            u.pathIndex = 0;
            u.commandState = CMD_MOVING;
        } else if (_workerHasPendingAutoRouteToTarget(u, target)) {
            u.workerState = 'MOVING_TO';
        } else {
            _clearWorkerAutoRoute(u);
            _clearWorkerTarget(u);
            u.workerState = 'IDLE';
            u.commandState = CMD_IDLE;
        }
        u._workerNextIdleRetargetTick = gameTime; u._idleFailVer = -1;
        return true;
    }

    return false;
}

// ---- The worker state machine as a kernel (wasm/src/wai.rs k_worker_ai) ----
// The tick's worker events, after the others (unit.js unitEventsRun): one
// serial pass in their order over the columns, the structure tables, the
// reservations and work versions, payments into the resource batch's rows;
// then its out events here in their order: sounds, the research queue's
// advance, arming off the atlas, and the events of the worker types it does
// not take yet (their JavaScript, as before). MAIN_THREAD_SERIAL_PLAN.md
// "Stage D". Off: every worker event goes the JavaScript way.
let WORKER_AI_WASM = true;
const WAI_RS_W = 12, WAI_ES_W = 8, WAI_ES_SOURCES = ['research', 'salvage', 'collect', 'healer', 'builder'];
const WAI_OUT_SOUND_RESEARCH = 1, WAI_OUT_RESEARCH_ADVANCE = 2, WAI_OUT_DECLINED = 3, WAI_OUT_ARM = 4, WAI_OUT_SALVAGE = 5, WAI_OUT_SOUND_UNIT = 6, WAI_OUT_MINE = 7, WAI_OUT_ASTAR_LOG = 8, WAI_OUT_CLEAR_ROUTE = 9, WAI_OUT_QUEUE_PAID = 10, WAI_OUT_SOUND_HEAL = 11, WAI_OUT_BUILT = 12, WAI_OUT_SOUND_BUILD = 13, WAI_OUT_BUILD_START = 14;
const WAI_UNIT_SOUNDS = [null, 'salvager_work', 'salvage_collected', 'collector_work', 'astar_work', 'gold_collected', 'astar_collected'];
// The class columns the kernel reads (wai.ctab: per class of data_state.js
// _stAllCls, 1 + its index, WAI_CTAB_COLS.length words; wai.rs CT_*).
const WAI_CTAB_COLS = ['markedForSalvage', 'stacks', 'level', 'queueEnabled', '_qN', '_qReq', '_qPaid', ''];
const _wai = { tver: '', P: new Float64Array(80), declined: 0 };
function _waiArr(name, Type, n) {
    let a = _wai[name];
    if (!a || a.length < n || !simHeapHas(a)) { if (a && simHeapHas(a)) simHeapFree(a); a = _wai[name] = simSharedArray(Type, Math.max(64, n)); }
    return a;
}
// (The batch's rows for every player: payments go into them.)
function _waiRowsReady() {
    if (!_resourceBatchActive) return false;
    for (let o = 0; o < players.length; o++) { const r = _resourceBatchRows[o]; if (!r || r.player !== players[o] || !simHeapHas(r.deltas)) return false; }
    return true;
}
function waiAvailable() {
    return WORKER_AI_WASM && typeof _simWasmX !== 'undefined' && !!_simWasmX && typeof _simWasmX.k_worker_ai === 'function' && _wsAvailable()
        && !!_ST.ctab && simHeapHas(_ST.ctab) && !!_effHot && _waiRowsReady();
}
// Per owner and level: the research building's efficiency and researcher
// dps (getResearchBuildingEfficiency, getResearcherDps); per owner, worker
// record type and level the search range (_getWorkerAutoSearchDistancePx,
// _getWorkerAutoSearchDistanceArea). Made again when the stat tables change.
const _WAI_WB_TYPES = ['', 'collector', 'astar_collector', 'salvager', 'builder', 'healer', 'researcher'];
function _waiTables() {
    const np = players.length, L1 = MAX_THING_LEVEL + 1, key = _precomputedStatsVersion + ':' + np + ':' + L1;
    if (_wai.tver === key && simHeapHas(_wai.teff)) return;
    const teff = _waiArr('teff', Float64Array, np * L1), tdps = _waiArr('tdps', Float64Array, np * L1);
    const tspx = _waiArr('tspx', Float64Array, np * 8 * L1), tsak = _waiArr('tsak', Float64Array, np * 8 * L1);
    const tt = _waiArr('ttab', Int32Array, 8);
    // (Per owner, resource (energy, A*) and level: a farm's multiplier, collector-ai's.)
    const tfarm = _waiArr('tfarm', Float64Array, np * 2 * L1);
    for (let o = 0; o < np; o++) for (let l = 0; l < L1; l++) {
        teff[o * L1 + l] = getResearchBuildingEfficiency({ type: 'research', level: l, owner: o });
        for (let rz = 0; rz < 2; rz++) {
            const cfg = RESOURCE_TYPE_LIST[rz];
            let m = getBuildingStatForOwner(o, cfg.farmKey, Math.max(1, l), 'multiplier');
            if (!Number.isFinite(m) || m <= 0) m = Math.max(1, l);
            tfarm[(o * 2 + rz) * L1 + l] = m;
        }
        const d = getUnitStatForOwner(o, 'researcher_unit', Math.max(1, l), 'researcherDps');
        tdps[o * L1 + l] = Math.max(1, Math.round(Number.isFinite(d) ? d : 1));
        for (let wb = 1; wb < _WAI_WB_TYPES.length; wb++) {
            const u = { owner: o, unitType: getWorkerUnitTypeFromWorkerType(_WAI_WB_TYPES[wb]), effectiveLevel: l }, i = (o * 8 + wb) * L1 + l;
            tspx[i] = _getWorkerAutoSearchDistancePx(u); tsak[i] = _getWorkerAutoSearchDistanceArea(u);
        }
    }
    _WAI_WB_TYPES.forEach((t, i) => { tt[i] = t ? (Math.max(0, _workerTypeToLoadIndex(t)) | (_workerWorkType(t) << 8)) : 0; });
    _wai.tver = key;
}
// The pass over the n worker events listed (slot * 8 + code, their order).
function waiRun(list, n, take = null) {
    const S = _simUnitState, c = S.columns, np = players.length, P = _wai.P;
    _waiTables();
    // Research per owner: [active, required, done, cost, points, next queued,
    // its required, done, cost] (wai.rs research_deposit's words).
    const rs = _waiArr('rs', Float64Array, np * WAI_RS_W);
    rs.fill(0, 0, np * WAI_RS_W);
    for (let o = 0; o < np; o++) {
        const b = o * WAI_RS_W, task = getPlayerResearchTask(o);
        rs[b + 4] = Number(players[o] && players[o].researchPoints) || 0;
        if (task) { rs[b] = 1; rs[b + 1] = Number(task.workRequired) || 0; rs[b + 2] = Number(task.workDone) || 0; rs[b + 3] = Number(task.cost) || 0; continue; }
        for (const q of getPlayerResearchQueue(o)) {
            const t = _normalizeResearchTaskForOwner(q, o);
            if (!t) continue;
            rs[b + 5] = 1; rs[b + 6] = Number(t.workRequired) || 0; rs[b + 7] = Number(t.workDone) || 0; rs[b + 8] = Number(t.cost) || 0;
            break;
        }
    }
    // Payments: the batch rows' deltas (room for two a worker), their counts and sums.
    const payt = _waiArr('payt', Int32Array, np * 4), payl = _waiArr('payl', Float64Array, np * 2);
    for (let o = 0; o < np; o++) {
        const r = _resourceBatchRows[o];
        if ((r.n + 2 * n + 2) * 2 > r.deltas.length) { const old = r.deltas; r.deltas = simSharedArray(Float64Array, Math.max(old.length * 2, (r.n + 2 * n + 2) * 4)); r.deltas.set(old); simHeapFree(old); }
        payt[o * 4] = _simWEnc(_simHeapPtrOf(r.deltas)); payt[o * 4 + 1] = r.deltas.length >> 1; payt[o * 4 + 2] = r.n;
        payl[o * 2] = r.logical[0]; payl[o * 2 + 1] = r.logical[1];
    }
    const es = _waiArr('es', Float64Array, np * WAI_ES_W);
    es.fill(0, 0, np * WAI_ES_W);
    const out = _waiArr('out', Int32Array, n * 8 + 64), cnt = _waiArr('cnt', Int32Array, 8);
    cnt.fill(0, 0, 8);
    const V = _workerWorkTable();
    if (!simHeapHas(workerReservedTiles)) { const t = workerReservedTable(); t.set(workerReservedTiles.subarray(0, Math.min(t.length, workerReservedTiles.length))); workerReservedTiles = t; workerReservedCountsInvalidate(); }
    const resKept = _workerResCountFor === workerReservedTiles && !!_workerResCount && simHeapHas(_workerResCount);
    const wsl = _wsw ? _wswResvRoom() : null;
    structRallyClasses();
    const RT = typeof ResearchSpawner !== 'undefined' ? _sTables.get(ResearchSpawner) : null, rcol = k => RT && RT.n && simHeapHas(RT['c_' + k]) ? RT['c_' + k] : null;
    let atlas = 0;
    for (let p = 0; p < NAV_PROFILES; p++) { const nav = _nav[p]; if (NAV_ATLAS && nav && nav.atlas && nav.atlas.header) atlas |= 1 << p; }
    // (Every profile's walls, as navApproachTile reads them.)
    const cwall = _waiArr('cwall', Int32Array, NAV_PROFILES);
    for (let p = 0; p < NAV_PROFILES; p++) { const a = navWallTable(p); cwall[p] = a && simHeapHas(a) ? _simWEnc(_simHeapPtrOf(a)) : 0; }
    const CW = WAI_CTAB_COLS.length, ctab = _waiArr('ctab', Int32Array, (_stAllCls.length + 1) * CW);
    ctab.fill(0, 0, (_stAllCls.length + 1) * CW);
    _stAllCls.forEach((C, i) => {
        const T = C ? _sTables.get(C) : null;
        for (let j = 0; j < CW; j++) { const a = T && T.n && WAI_CTAB_COLS[j] ? T['c_' + WAI_CTAB_COLS[j]] : null; ctab[(i + 1) * CW + j] = a && simHeapHas(a) ? _simWEnc(_simHeapPtrOf(a)) : 0; }
    });
    // (Prices by stationary type: a salvage's refund.)
    const nty = _stationaryTypes.length, price = _waiArr('price', Float64Array, nty + 1);
    for (let i = 0; i < nty; i++) { const p = BASE_CARD_TYPES[_stationaryTypes[i]]; price[i] = p ? Number(p.price) || 0 : 0; }
    // (The id table, made from the units list when none yet: unit targets and reservation holders by id.)
    if (!_unitById._ok()) _unitById._refill();
    const idt = _unitById._ok() && simHeapHas(_unitById.t) ? _unitById.t : null;
    const salv = BASE_UNIT_STATS.salvager_unit || {};
    const base = BASE_UNIT_STATS.researcher_unit || {};
    P.fill(0);
    P[0] = n; P[1] = gameTime; P[2] = simDk; P[3] = GRID_W; P[4] = GRID_H; P[5] = TILE; P[6] = Math.max(1, Math.floor(Number(WORKER_AI_TICK_DELAY) || 1));
    P[7] = getWorkerIdleRetargetTicks(); P[8] = getWorkerIdleSearchTicks(); P[9] = WORKER_IDLE_BACKOFF_SECONDS * TICK_RATE;
    P[10] = _WORKER_TARGET_LOAD_TYPE_COUNT; P[11] = SNAP_REGION_TILES; P[12] = Math.ceil(GRID_W / SNAP_REGION_TILES);
    P[13] = _WORKER_WORK_TYPES.length; P[14] = V.rw; P[15] = V.rh; P[16] = V.np; P[17] = WORKER_WORK_REGION_TILES;
    P[18] = spatialEpoch; P[19] = SIM_SEP_ABSENT; P[20] = atlas; P[21] = localPlayerId; P[22] = _stAllIx.get(ResearchSpawner) || 0;
    P[23] = MAX_THING_LEVEL + 1; P[24] = MAX_THING_LEVEL; P[25] = n * 2 + 16; P[26] = workerReservedTiles.length; P[27] = V.length;
    P[28] = wsl ? wsl.length : 0; P[29] = np; P[30] = RESOURCE_FIXED_POINT_SCALE; P[31] = simWttCode('research');
    P[32] = Math.max(1, Math.round(Number(base.researcherDps) || 1)); P[33] = secondsToTicks(Math.max(0.01, Number(base.transferCooldown) || 0.01));
    P[34] = idt ? idt.length : 1; P[35] = _stationaryTypeIds.has('salvager') ? _stationaryTypeIds.get('salvager') + 1 : -1;
    P[36] = secondsToTicks(Math.max(0.01, Number(salv.transferCooldown) || 0.01)); P[37] = nty;
    // (Per resource, RESOURCE_TYPE_LIST's first two: energy, A*.)
    // (Stationary types as the structure table's descriptor holds them: id + 1.)
    const sty = k => _stationaryTypeIds.has(k) ? _stationaryTypeIds.get(k) + 1 : -1, RL = RESOURCE_TYPE_LIST;
    P[38] = simWttCode(RL[0].mineTileType); P[39] = simWttCode(RL[1].mineTileType); P[40] = simWttCode(RL[0].farmKey); P[41] = simWttCode(RL[1].farmKey); P[42] = simWttCode('drop');
    P[43] = sty(RL[0].farmKey); P[44] = sty(RL[1].farmKey); P[45] = sty(RL[0].collectorBuildingKey); P[46] = sty(RL[1].collectorBuildingKey);
    P[47] = 0x66; P[48] = 0x77;
    for (let rz = 0; rz < 2; rz++) { const b = BASE_UNIT_STATS[RL[rz].collectorUnitKey] || {}; P[49 + rz] = secondsToTicks(Math.max(0.01, Number(b.transferCooldown) || 0.01)); P[51 + rz] = rz; }
    P[53] = secondsToTicks(5); P[54] = areaSearchEnabled() ? 1 : 0;
    const heal = BASE_UNIT_STATS.healer_unit || {};
    P[55] = sty('healer_spawner'); P[56] = Number(heal.healerDps) || 1; P[57] = secondsToTicks(Math.max(0.01, Number(heal.transferCooldown) || 0.01));
    P[58] = _getEnergyBlockedGlyphTicks(); P[59] = _unitPassOn ? 1 : 0; P[60] = simWttCode('queue'); P[61] = simWttCode('unit');
    // (Builders: the structures' build columns, adj.ctab and wsw.ctab, and the static stat tables, as k_wsw_set reads them.)
    const SS = statTablesStatic(), SX = _adjPlayerStats(SS), STY = _adjTypeKeys(), SR = _simParReg, bld = BASE_UNIT_STATS.builder_unit || {};
    const ACT = _adjArr('adj.ctab', Int32Array, 9 * _ADJ_CTAB_COLS.length);
    _adjApplyClasses(ACT);
    const WCT = _adjArr('wsw.ctab', Int32Array, 9 * _WSW_CTAB_COLS.length), SCL = STRUCT_STATUS_CLASSES(), WW = _WSW_CTAB_COLS.length;
    for (let k = 0; k < 9; k++) {
        const T = SCL[k] ? _sTables.get(SCL[k]) : null;
        for (let j = 0; j < WW; j++) { const a = T && T.n ? T['c_' + _WSW_CTAB_COLS[j]] : null; WCT[k * WW + j] = a && simHeapHas(a) ? _simWEnc(_simHeapPtrOf(a)) : 0; }
    }
    P[62] = STY; P[63] = SS.nk; P[64] = SX.np; P[65] = SS.L1; P[66] = SS.R1; P[67] = sty('builder_spawner'); P[68] = Number(bld.builderDps) || 1;
    const R2 = _simParReg;
    P[72] = take ? 1 : 0; P[73] = WS_K; P[74] = HEALER_DAMAGED_CANDIDATE_LIMIT; P[75] = WS_TICKS;
    P[69] = secondsToTicks(Math.max(0.01, Number(bld.transferCooldown) || 0.01)); P[70] = Math.max(120, Math.floor(TICK_RATE * 8)); P[71] = Math.max(60, Math.floor(TICK_RATE * 3));
    simRustDirect('k_worker_ai', [list, out, cnt,
        c.id, c.owner, c.x, c.y, c.dead, c.wkS, c.wkT, c.wkR, c.wkN, c.idleFV, c.commandState, c.pathIndex, c.nvPK,
        c.mvOn, c.mvCD, c.mvPath, S.pathPool.fs, c.mvOut, c.wsKind, c.wkIdle, S.sepKey, c.spEpoch, c.workerTransferCooldown, c.mvTgX, c.mvTgY, c.mvNavLD, c.statRow, c.effectiveLevel, c.wkIx,
        c.wbType, c.mvWake, c.mvFlags, c.mvReach, c.mvFlow, c.mvFGen, c.mvDest, c.mvReady, c.mvNP, c.mvSteady, c.mvWk, c.mvSpent, c.mvShoot,
        c.wkType, c.wkD, c.wkOx, c.wkOy, c.wkTwice, c.wkFail, c.wkUntil, c.wkSched,
        c.wsT, c.wsCfg, c.wsOU, c.wsOx, c.wsOy, c.wsR, c.wsAx, c.wsAy, c.wsAk, c.wsNeed, c.wsJid, c.wsCur, c.wsMy, c.wsFail,
        c.wmSp, c.wmFailU, c.holdF, c.mvPP, _effHot,
        _ST.ctab, _ST.rrow, _ST.own, _ST.uc, _ST.val, rcol('markedForSalvage'), rcol('autoResearchEnabled'), rcol('level'), rcol('stacks'),
        navWallTable(NAV_PROFILE_GROUND), workerReservedTiles, resKept ? _workerResCount : null, resKept ? _workerResSum : null, wsl, V, _wai.ttab,
        rs, _wai.teff, _wai.tdps, _wai.tspx, _wai.tsak, payt, payl, es, navWallTable(NAV_PROFILE_AIR), S.sepLayer, c.tmOn,
        cwall, ctab, price, c.unitLevel, idt, _ST.brain, c.wbTick, c.wbSpawner, c.wmCarry,
        c.wmPin, c.wmPinTy, c.wmWx, c.wmWy, c.wmWgx, c.wmWgy, c.wmWty, c.wmDrop, c.wmMine, c.wmMineTy, c.wmIdle, _wai.tfarm, _ST.code,
        c.wmQc, c.wmQr, c.wmQp, c.wmTrip, c.wmBlk, c.energy, c.maxE, c.x0, c.y0,
        _ST.stab, ACT, WCT, SR['adj.tykey'], SR['adj.rml'], SS.mxe, SR['adj.rlv'], c.wkWx, c.wkWy, c.wkLmt, c.wmRe, _wai.ownStats,
        take ? R2['ws.rslot'] : null, take ? R2['ws.rid'] : null, take ? R2['ws.rkind'] : null, take ? R2['ws.rwt'] : null, take ? R2['ws.rgrp'] : null,
        take ? R2['ws.res'] : null, take ? R2['ws.score'] : null, take ? R2['ws.ures'] : null, take ? _wai.gtab : null, take ? _wai.hid : null], P);
    if (cnt[1]) throw new Error('k_worker_ai: out of room (payments or out events)');
    // Its writes the JavaScript keeps beside the tables.
    for (let o = 0; o < np; o++) {
        const r = _resourceBatchRows[o];
        r.n = payt[o * 4 + 2]; r.logical[0] = payl[o * 2]; r.logical[1] = payl[o * 2 + 1];
        if (players[o]) players[o].researchPoints = rs[o * WAI_RS_W + 4];
        for (let k = 0; k < WAI_ES_SOURCES.length; k++) { const v = es[o * WAI_ES_W + k]; if (v) recordEnergyDelta(o, WAI_ES_SOURCES[k], v); }
    }
    _wai.researchDeposits = (_wai.researchDeposits || 0) + cnt[4];
    _wai.collectorDeposits = (_wai.collectorDeposits || 0) + cnt[5]; _wai.astarDeposits = (_wai.astarDeposits || 0) + cnt[6];
    if (cnt[2]) V.sum = (V.sum + cnt[2]) | 0;
    if (cnt[3]) _wsw = null;
    return cnt[0];
}
// Its out events, in their order (unit.js unitEventsRun, after the pass).
function waiOutEvents(m) {
    const S = _simUnitState, c = S.columns, owners = S.owners, out = _wai.out;
    _wai.declined = 0;
    for (let i = 0; i < m; i++) {
        const code = out[i * 4], a = out[i * 4 + 1], b = out[i * 4 + 2];
        if (code === WAI_OUT_DECLINED) {
            const u = owners[a];
            if (!u || u.dead) continue;
            _wai.declined++;
            // (Its floor was looked at before the pass.)
            _unitWorkerEvent(u, c, a, b);
        } else if (code === WAI_OUT_SOUND_RESEARCH) {
            const t = getTileEntityRef(b % GRID_W, Math.floor(b / GRID_W));
            if (t && _noteAmbientSoundTick(t, 'research_tick', 12)) playSound('research_tick', t.x, t.y);
        } else if (code === WAI_OUT_RESEARCH_ADVANCE) tryAdvancePlayerResearchTask(a);
        else if (code === WAI_OUT_ARM) { const u = owners[a]; if (u && !u.dead) simMoveTryArm(u); }
        else if (code === WAI_OUT_SALVAGE) { const e = simWtDecode(b, a); if (e) destroyBuilding(e); }
        else if (code === WAI_OUT_SOUND_UNIT) { const u = owners[a]; if (u) playSound(WAI_UNIT_SOUNDS[out[i * 4 + 3]], u.x, u.y); }
        else if (code === WAI_OUT_MINE) _waiMineTaken(a, RESOURCE_TYPE_LIST[b], out[i * 4 + 3]);
        else if (code === WAI_OUT_ASTAR_LOG) { const u = owners[a]; if (typeof recordAstarDelta === 'function') recordAstarDelta(u ? u.owner : -1, out[i * 4 + 3], u, 'collect'); }
        else if (code === WAI_OUT_QUEUE_PAID) {
            // (A healer paid its front, or found it paid: its production, and a ready order once paid and timed.)
            const sp = getTileEntityRef(a % GRID_W, Math.floor(a / GRID_W));
            if (!sp) continue;
            if (b && typeof spawnerProductionChanged === 'function') spawnerProductionChanged(sp);
            const cooldown = Math.max(1, Math.round(sp.spawnCooldown || 1)), front = spawnQueueFront(sp);
            if (front && sp.spawnTimer >= cooldown && front.energyPaid >= front.energyRequired && !Number.isFinite(sp._spawnReadyOrder)) {
                sp._spawnReadyOrder = globalSpawnerReadyOrderCounter++;
                if (typeof spawnerReadyNoted === 'function') spawnerReadyNoted(sp);
            }
        } else if (code === WAI_OUT_SOUND_HEAL) {
            const t = a >= 0 ? getTileEntityRef(a % GRID_W, Math.floor(a / GRID_W)) : owners[b];
            if (t && _noteAmbientSoundTick(t, 'heal_tick', 12)) playSound('heal_tick', t.x, t.y);
        }
        else if (code === WAI_OUT_BUILT) _waiBuilt(a, b, out[i * 4 + 3]);
        else if (code === WAI_OUT_SOUND_BUILD) { const t = getTileEntityRef(a % GRID_W, Math.floor(a / GRID_W)); if (t && _noteAmbientSoundTick(t, 'builder_work', 10)) playSound('builder_work', t.x, t.y); }
        else if (code === WAI_OUT_BUILD_START) {
            const t = getTileEntityRef(a % GRID_W, Math.floor(a / GRID_W));
            if (t) { if (b === 1) beginUpgradeProgress(t, out[i * 4 + 3]); else refreshThingProgressState(t); }
        }
        else if (code === WAI_OUT_CLEAR_ROUTE) { const u = owners[a]; if (u) { u.pathIsFallbackAstar = false; u._pendingPathTarget = null; } }
    }
}
// The search tier's takes (worker.js _wsCommit): the n requests of the
// order (indices into its result arrays), all in one pass (wai.rs
// take_one). The collectors' groups' arrays and the healers' damaged units
// (by id) for the kernel.
function waiTake(J, order, n) {
    const L = _waiArr('takeList', Int32Array, n);
    L.set(order.subarray(0, n));
    const gt = _waiArr('gtab', Int32Array, 32);
    gt.fill(0, 0, 32);
    J.groups.forEach((G, k) => { if (G && k < 16 && simHeapHas(G.tile) && simHeapHas(G.st)) { gt[k * 2] = _simWEnc(_simHeapPtrOf(G.tile)); gt[k * 2 + 1] = _simWEnc(_simHeapPtrOf(G.st)); } });
    const HM = HEALER_DAMAGED_CANDIDATE_LIMIT, np = J.heal.length, hid = _waiArr('hid', Int32Array, Math.max(1, np) * HM);
    hid.fill(0, 0, Math.max(1, np) * HM);
    for (let o = 0; o < np; o++) { const Lh = J.heal[o] || []; for (let q = 0; q < Lh.length && q < HM; q++) hid[o * HM + q] = Lh[q] && !Lh[q].dead ? Lh[q].id | 0 : 0; }
    // (Their nearest spawners: the worker brain over their slots; and their own stat words, without a row.)
    const RS = _simParReg['ws.rslot'], E = _waiArr('takeSlots', Int32Array, n), S = _simUnitState, c = S.columns;
    for (let i = 0; i < n; i++) { const q = RS[L[i]]; E[i] = q >= 0 ? q * 8 : -8; if (q >= 0 && c.statRow[q] < 0 && S.owners[q]) _waiOwnStats(S.owners[q], c, q); }
    workerBrainsPrepare(n, false, E);
    playerResourceBatchBegin();
    try { if (waiAvailable()) waiOutEvents(waiRun(L, n, J)); } finally { playerResourceBatchEnd(); workerBrainsEnd(); }
}
// One worker's event through the kernel, alone (tests: the tick runs its events as a list).
function waiStepUnit(u, code = 0) {
    const c = u && u._us;
    if (!c) return;
    const L = _waiArr('list1', Int32Array, 1);
    L[0] = u._si * 8 + code;
    playerResourceBatchBegin();
    try { if (waiAvailable()) waiOutEvents(waiRun(L, 1)); } finally { playerResourceBatchEnd(); }
}
// A worker with its own stat tables (no shared row: a restored one, a custom one): its words for the pass (wai.rs hot).
function _waiOwnStats(u, c, s) {
    const w = c.wkIx[s], A = _waiArr('ownStats', Float32Array, (_simUnitState.wk.cap + 1) * SIM_WK_STATS_W);
    if (!(w > 0)) return;
    const pc = u.preComputed || {}, o = w * SIM_WK_STATS_W;
    A[o] = Number(pc.builderDps) || 0; A[o + 1] = Number(pc.healerDps) || 0; A[o + 2] = Number(pc.researcherDps) || 0; A[o + 3] = Number(pc.gatherPerTrip) || 0; A[o + 4] = Number(pc.transferCooldownTicks) || 0;
}
// A builder's work done at tile t (wai.rs b_work): 0 built, 1 upgraded to
// level v, 2 stacked (v: any), 3 its maxEnergy to v. What the kernel did not
// write: the completions' JavaScript (things_utils.js), sounds, adjacency.
function _waiBuilt(at, kind, v) {
    const t = getTileEntityRef(at % GRID_W, Math.floor(at / GRID_W));
    if (!t) return;
    if (kind === 3) { t.maxEnergy = v; return; }
    if (kind === 0) {
        markConstructionComplete(t);
        refreshThingProgressState(t);
        if (t.owner === localPlayerId) playSound('build_complete', t.x, t.y);
    } else if (kind === 1) {
        const prevStacked = getThingStackedStacks(t), prevManual = getThingManualStacks(t), left = Math.max(0, prevManual - prevStacked);
        t.level = v;
        if (typeof upkeepThingDirty === 'function') upkeepThingDirty(t);
        t.stacks = Math.max(prevStacked, getRequiredStacksForLevel(v));
        t.manualStacks = Math.max(prevManual, t.stacks + left);
        t.isUpgrading = false;
        t.upgrademaxEnergy = 0;
        refreshThingProgressState(t);
        if (t.owner === localPlayerId) playSound('upgrade_complete', t.x, t.y);
        if (t.updateTextCache) t.updateTextCache(); else updateItemTextCache(t);
    } else if (kind === 2) {
        // (Its stacks as the kernel left them, through their setter: the derived tables.)
        if (v) { t.stacks = t.stacks; if (t.updateTextCache) t.updateTextCache(); else updateItemTextCache(t); }
        refreshThingProgressState(t);
        if (!v) return;
    }
    _requestAdjacencyRecalcForThing(t, 1);
    recalculateAdjacency();
}
// A collector took `ex` from the mine at tile t (its resource cfg): the
// mine's value, its look, and an emptied mine gone to ground.
function _waiMineTaken(t, cfg, ex) {
    const mine = getTileEntityRef(t % GRID_W, Math.floor(t / GRID_W));
    if (!mine || !cfg || !(Number.isFinite(mine[cfg.mineStatKey]))) return;
    mine[cfg.mineStatKey] -= ex;
    _markCombinedBgTileDirty(mine.gx, mine.gy, 0, true);
    dirtyGrid = true;
    if (mine[cfg.mineStatKey] <= 0) {
        grid[mine.gy][mine.gx].type = TYPE_FLOOR;
        simMoveTileTypeChanged(mine.gx, mine.gy);
        _bumpPathTopologyVersion();
        const mineArray = _getResourceCollectorMineArray(cfg), idx = mineArray ? mineArray.indexOf(mine) : -1;
        if (idx >= 0) mineArray.splice(idx, 1);
        clearTileEntity(mine.gx, mine.gy, mine);
        _markCombinedBgTileDirty(mine.gx, mine.gy, 0, true);
    }
}
