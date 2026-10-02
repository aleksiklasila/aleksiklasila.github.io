"use strict";

// ============================================================
// BARRACK CLASS
// ============================================================
function getBaseSpawnCooldownSeconds(unitType, buildingKey = null) {
    let cfg = BARRACK_SPAWN_CONFIG[unitType] || BARRACK_SPAWN_CONFIG.norm;
    if (Number.isFinite(cfg.baseTime) && cfg.baseTime > 0) return cfg.baseTime;
    return 1;
}

function getBarrackSpawnCooldown(unitType, level, owner = null, buildingKey = null) {
    let cfg = BARRACK_SPAWN_CONFIG[unitType] || BARRACK_SPAWN_CONFIG.norm;
    let reduction = Number.isFinite(cfg.reduction) ? cfg.reduction : 0.10;
    let baseCd = Math.max(0.05, getBaseSpawnCooldownSeconds(unitType, buildingKey) * detPow(1 - reduction, level - 1));
    if (buildingKey && Number.isFinite(owner)) {
        let researched = getBuildingStatForOwner(owner, buildingKey, level, 'spawnCd');
        if (Number.isFinite(researched)) return Math.max(0.05, researched);
    }
    return baseCd;
}

function getQueuedSpawnInfo(entry, fallbackType, fallbackLevel, owner = null) {
    if (entry && typeof entry === 'object') {
        let level = Math.max(1, entry.level || fallbackLevel || 1);
        let unitType = entry.unitType || fallbackType;
        let required = Number(entry.energyRequired);
        if (!Number.isFinite(required) || required < 1) {
            let energyCost = getUnitStatForOwner(Number.isFinite(owner) ? owner : localPlayerId, unitType, level, 'energy');
            required = Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
        }
        let paid = Number(entry.energyPaid);
        if (!Number.isFinite(paid) || paid < 0) paid = 0;
        return {
            unitType,
            level,
            energyRequired: required,
            energyPaid: Math.max(0, Math.min(required, paid))
        };
    }
    let level = Math.max(1, fallbackLevel || 1);
    let unitType = entry || fallbackType;
    let energyCost = getUnitStatForOwner(Number.isFinite(owner) ? owner : localPlayerId, unitType, level, 'energy');
    let required = Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    return {
        unitType,
        level,
        energyRequired: required,
        energyPaid: 0
    };
}

function getSpawnerFallbackUnitType(spawner) {
    if (!spawner) return 'norm';
    if (spawner.type === 'barrack') return spawner.unitType || 'norm';
    if (spawner.type === 'spawner') return 'collector';
    if (spawner.type === 'astar_spawner') return 'astar_collector';
    if (spawner.type === 'salvager') return 'salvager_unit';
    if (spawner.type === 'builder_spawner') return 'builder_unit';
    if (spawner.type === 'healer_spawner') return 'healer_unit';
    if (spawner.type === 'research') return 'researcher_unit';
    return 'norm';
}

function _shouldWaitForConstruction(self) {
    if (!self || !self.underConstruction) return false;
    let targetEnergy = Number(getUpgrademaxEnergy(self, 1));
    let visibleMax = Number(self.maxEnergy);
    // Use the visible construction cap as an upper bound to avoid impossible L0 completion thresholds.
    if (Number.isFinite(visibleMax) && visibleMax > 0) {
        targetEnergy = Number.isFinite(targetEnergy) && targetEnergy > 0
            ? Math.min(targetEnergy, visibleMax)
            : visibleMax;
    }
    let requiredEnergy = Math.max(1, Math.floor(Number.isFinite(targetEnergy) && targetEnergy > 0 ? targetEnergy : 1));
    if ((Number(self.energy) || 0) >= requiredEnergy) {
        markConstructionComplete(self);
        return false;
    }
    return true;
}

let globalSpawnerReadyOrderCounter = 1;

// A spawner's production cooldown in ticks, as its type sets it.
const _SPAWN_COOLDOWN_ARGS = { spawner: ['collector', 'spawner'], astar_spawner: ['astar_collector', 'astar_spawner'], salvager: ['salvager_unit', 'salvager'],
    builder_spawner: ['builder_unit', 'builder_spawner'], healer_spawner: ['healer_unit', 'healer_spawner'], research: ['researcher_unit', 'research'] };
function spawnerCooldownTicks(s) {
    const lvl = getThingBaseLevel(s);
    if (s.type === 'barrack') return Math.round(getBarrackSpawnCooldown(s.unitType, lvl, s.owner, `barrack_${s.unitType}`) * TICK_RATE);
    const a = _SPAWN_COOLDOWN_ARGS[s.type];
    return a ? Math.round(getBarrackSpawnCooldown(a[0], lvl, s.owner, a[1]) * TICK_RATE) : Math.max(1, Math.round(s.spawnCooldown || 1));
}
// Where a spawner's production may have moved on (a payment, its queue or
// its queue switch changed, construction done): its timer and, once its
// front is paid, its ready order (barracks and spawners have no tick of
// their own: spawnerStructuresTick).
function spawnerProductionChanged(s) {
    if (!s || !Array.isArray(s.spawnQueue) || !(s.energy > 0) || s.underConstruction) return;
    s.spawnCooldown = spawnerCooldownTicks(s);
    const had = Number.isFinite(s._spawnReadyOrder);
    if (s.spawnQueue.length > 0) updateSpawnerProductionProgress(s);
    else { s.spawnTimer = 0; s._spawnReadyOrder = undefined; }
    // (Ready already: listed again, its entry may have been passed while it
    // could not spawn.)
    if (had && Number.isFinite(s._spawnReadyOrder)) spawnerReadyNoted(s);
    // (A research building shows its player's task: built now, say.)
    if (s.type === 'research') {
        const task = getPlayerResearchTask(s.owner) || null;
        s.researchTask = task;
        s.isResearching = !!(task && !s.isUpgrading && isAutoResearchEnabled(s) && (task.workDone || 0) < task.workRequired);
    }
}
// A tick of the barracks and spawners: those with statuses running (woken
// by damage or effects: thingStatusWake) tick them at their phase
// (spawnerDue), in tile order; any whose energy ran out are removed (the
// lists from the end, as ever); the players' research moves on.
function spawnerStructuresTick() {
    let dead = false, due = null;
    for (const e of _thingStatusSelf) {
        if (!(e instanceof Barrack) && !isSpawnerEntity(e)) continue;
        if (!(e.energy > 0)) { dead = true; continue; }
        if (spawnerDue(e)) (due || (due = [])).push(e);
    }
    if (due) {
        due.sort((a, b) => (a.gy * GRID_W + a.gx) - (b.gy * GRID_W + b.gx));
        for (const e of due) { thingStatusTickSelf(e); if (!(e.energy > 0)) dead = true; }
    }
    if (dead) {
        for (let i = barracks.length - 1; i >= 0; i--) if (barracks[i].energy <= 0) destroyBuilding(barracks[i]);
        for (let i = collectorSpawners.length - 1; i >= 0; i--) if (collectorSpawners[i].energy <= 0) destroyBuilding(collectorSpawners[i]);
        for (const e of [..._thingStatusSelf]) if (!(e.energy > 0) && ((e instanceof Barrack) || isSpawnerEntity(e)) && getTileEntityRef(e.gx, e.gy) !== e) _thingStatusSelf.delete(e);
    }
    researchAdvanceTick();
}
// Each player's research moves on once a tick while it has a research
// building (built, alive: the buildings' bins); the research buildings show
// its task, set where the task changes (and anew on every peer after a
// resync: spawnerReadyReset).
let _researchTaskSeen = [];
function researchAdvanceTick() {
    const B = typeof _upkBuildingsStep === 'function' ? _upkBuildingsStep() : null;
    if (!B) return;
    const np = players.length;
    let has = 0;
    for (let b = 0; b < B.n; b++) if (B.cnt[b] && B.type[b] === 'research' && B.owner[b] < np && B.owner[b] < 31) has |= 1 << B.owner[b];
    for (let o = 0; o < np && o < 31; o++) {
        if (!(has & (1 << o))) continue;
        _researchAdvancedTick[o] = gameTime;
        const task = tryAdvancePlayerResearchTask(o) || null;
        if (_researchTaskSeen[o] === task) continue;
        _researchTaskSeen[o] = task;
        for (const s of collectorSpawners) {
            if (!s || s.type !== 'research' || s.owner !== o) continue;
            s.researchTask = task;
            s.isResearching = !!(task && !s.isUpgrading && isAutoResearchEnabled(s) && (task.workDone || 0) < task.workRequired);
        }
    }
}
function updateSpawnerProductionProgress(spawner) {
    if (!spawner) return;
    if (!Array.isArray(spawner.spawnQueue) || spawner.spawnQueue.length <= 0) {
        spawner.spawnTimer = 0;
        spawner._spawnReadyOrder = undefined;
        return;
    }
    let owner = Number.isFinite(spawner.owner) ? spawner.owner : localPlayerId;
    let effLvl = getThingBaseLevel(spawner);
    let fallbackType = getSpawnerFallbackUnitType(spawner);
    let front = getQueuedSpawnInfo(spawner.spawnQueue[0], fallbackType, effLvl, owner);
    spawner.spawnQueue[0] = front;

    let cooldown = Math.max(1, Math.round(spawner.spawnCooldown || 1));
    spawner.spawnCooldown = cooldown;
    let paidPct = front.energyRequired > 0 ? (front.energyPaid / front.energyRequired) : 0;
    spawner.spawnTimer = Math.max(0, Math.min(cooldown, Math.round(cooldown * paidPct)));
    if (front.energyPaid >= front.energyRequired && !Number.isFinite(spawner._spawnReadyOrder)) {
        spawner._spawnReadyOrder = globalSpawnerReadyOrderCounter++;
        spawnerReadyNoted(spawner);
    } else if (front.energyPaid < front.energyRequired) {
        spawner._spawnReadyOrder = undefined;
    }
}

function spawnQueuedUnitFromSpawner(spawner) {
    if (!spawner || !Array.isArray(spawner.spawnQueue) || spawner.spawnQueue.length <= 0) return false;
    if (spawner.energy <= 0 || spawner.underConstruction) return false;
    if (!isQueueEnabled(spawner)) return false;
    let owner = spawner.owner;
    if (!(players[owner].popCount < getPlayerPopCap(owner))) return false;

    let effLvl = getThingBaseLevel(spawner);
    let fallbackType = getSpawnerFallbackUnitType(spawner);
    if (!fallbackType) return false;

    let queued = spawner.spawnQueue.shift();
    // The queue moved on: its next item may need healers' energy.
    if (typeof workerWorkChanged === 'function') workerWorkChanged(spawner.owner, 'healer', spawner.gx, spawner.gy);
    if (typeof workSiteDirty === 'function') workSiteDirty(spawner.gx, spawner.gy);
    let spawnInfo = getQueuedSpawnInfo(queued, fallbackType, effLvl, owner);
    let spawnPos = findNearestWalkable(spawner.gx, spawner.gy);
    let u = new Unit(spawnInfo.unitType, owner, spawnPos.x * TILE + 16, spawnPos.y * TILE + 16);
    configureWorkerUnitFromType(u);

    applyUnitLevelScaling(u, spawnInfo.level);
    u.energy = u.maxEnergy;
    units.push(u); unitSlotMapPushed(u);
    players[owner].popCount++;

    // For worker units, rally is a direct move order that must be followed before auto-search resumes.
    if (u.workerType && typeof applyWorkerRallyFromSpawner === 'function') {
        if (applyWorkerRallyFromSpawner(u, spawner)) {
            spawner.spawnTimer = 0;
            spawner._spawnReadyOrder = undefined;
            return true;
        }
    }

    let rallyTarget = getSpawnerRallyTargetWorld(spawner);
    if (rallyTarget) {
        let rgx = Math.floor(rallyTarget.x / TILE), rgy = Math.floor(rallyTarget.y / TILE);
        let rallyPath = null;
        if (_canUsePathfindRequestBudget(u.owner, u)) {
            _consumePathfindRequestBudget(u.owner, u);
            let rallyCacheKey = _makeSpawnerRallyTemplateKey(spawner, spawnPos.x, spawnPos.y, rgx, rgy, u);
            rallyPath = _getSpawnerRallyTemplatePath(rallyCacheKey);
            if (!rallyPath) {
                rallyPath = _findPathForUnitTagged('spawner_rally', u, spawnPos.x, spawnPos.y, rgx, rgy, u.isFlying, getPathCanWalkForUnit(u), u.owner);
                _setSpawnerRallyTemplatePath(rallyCacheKey, rallyPath);
            }
        }

        if (spawner.type === 'barrack') {
            if (!rallyPath || rallyPath.length <= 0) {
                rallyPath = _makeFallbackPathForUnit(u, spawnPos.x, spawnPos.y, rgx, rgy, CMD_ATTACK_MOVING, 'spawner_rally');
            }
            u.path = rallyPath;
            u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === spawnPos.x && u.path[0].y === spawnPos.y) ? 1 : 0;
            if (u.path && u.path.length > 0) u.commandState = CMD_ATTACK_MOVING;
        } else {
            if (!rallyPath || rallyPath.length <= 0) {
                rallyPath = _makeFallbackPathForUnit(u, spawnPos.x, spawnPos.y, rgx, rgy, CMD_MOVING, 'spawner_rally');
            }
            u.path = rallyPath;
            u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === spawnPos.x && u.path[0].y === spawnPos.y) ? 1 : 0;
            u.commandState = CMD_MOVING;
            u.workerState = 'MANUAL_MOVE';
            u.targetPos = { x: rgx * TILE + 16, y: rgy * TILE + 16 };
            u._manualMoveIssuedTick = gameTime;
        }
    }

    spawner.spawnTimer = 0;
    spawner._spawnReadyOrder = undefined;
    return true;
}

// Spawners whose queue front is paid, by ready order (_spawnReadyOrder,
// assigned from an increasing counter: appended, each owner's list stays
// sorted): per owner its entries (spawner, order) from a head index. An
// entry whose spawner no longer holds that order (spawned, dequeued,
// removed) is dropped when reached. Made anew from the spawners on every
// peer after a resync (spawnerReadyReset).
let _spawnReady = null;
function spawnerReadyReset() { _spawnReady = null; _researchTaskSeen = []; }
// After s._spawnReadyOrder was assigned.
function spawnerReadyNoted(s) {
    const R = _spawnReady;
    if (!R || !s || !Number.isFinite(s._spawnReadyOrder)) return;
    const o = Number.isFinite(s.owner) ? s.owner : -1;
    let L = R.byOwner.get(o);
    if (!L) R.byOwner.set(o, L = { e: [], head: 0 });
    const order = s._spawnReadyOrder, e = L.e;
    if (e.length <= L.head || e[e.length - 1] <= order) e.push(s, order);
    else {
        // (An older order again, e.g. its queue enabled again: in its place.)
        let lo = L.head >> 1, hi = e.length >> 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (e[mid * 2 + 1] <= order) lo = mid + 1; else hi = mid; }
        e.splice(lo * 2, 0, s, order);
    }
    // (Stale entries pile up only behind an owner at its cap: compacted now and then.)
    if (L.e.length - L.head > 4 * (barracks.length + collectorSpawners.length) + 64) _spawnReadyCompact(L);
}
function _spawnReadyCompact(L) {
    const e = [];
    for (let k = L.head; k < L.e.length; k += 2) if (L.e[k]._spawnReadyOrder === L.e[k + 1]) e.push(L.e[k], L.e[k + 1]);
    L.e = e; L.head = 0;
}
function _spawnReadyBuild() {
    const R = _spawnReady = { byOwner: new Map() }, all = [];
    for (const b of barracks) if (b && Number.isFinite(b._spawnReadyOrder)) all.push(b);
    for (const s of collectorSpawners) if (s && Number.isFinite(s._spawnReadyOrder)) all.push(s);
    all.sort((a, b) => a._spawnReadyOrder - b._spawnReadyOrder);
    for (const s of all) spawnerReadyNoted(s);
    return R;
}
// Whether s (holding a ready order) may spawn: in the world, alive, built,
// its queue enabled and its front paid.
function _spawnReadyValid(s) {
    if (!s || s.energy <= 0 || s.underConstruction || !isQueueEnabled(s)) return false;
    if (!Array.isArray(s.spawnQueue) || s.spawnQueue.length <= 0) return false;
    if (typeof getTileEntityRef === 'function' && getTileEntityRef(s.gx, s.gy) !== s) return false;
    const owner = Number.isFinite(s.owner) ? s.owner : localPlayerId;
    const front = getQueuedSpawnInfo(s.spawnQueue[0], getSpawnerFallbackUnitType(s), getThingBaseLevel(s), owner);
    return front.energyPaid >= front.energyRequired;
}
function processGlobalSpawnerQueue() {
    // The ready spawners in ready order across owners (each owner's list is
    // sorted; owners at their population cap are passed over whole), up to
    // 2048 spawns a tick; a spawner ready again after spawning goes to the
    // end (a new order), as ever.
    const R = _spawnReady || _spawnReadyBuild();
    let spawned = 0;
    while (spawned < 2048) {
        let best = null, bestOrder = Infinity;
        for (const [o, L] of R.byOwner) {
            if (L.head >= L.e.length) continue;
            if (!(o >= 0 && players[o] && players[o].popCount < getPlayerPopCap(o))) continue;
            // (Its first entry still valid.)
            while (L.head < L.e.length) {
                const s = L.e[L.head], order = L.e[L.head + 1];
                if (s._spawnReadyOrder === order && _spawnReadyValid(s)) break;
                L.head += 2;
            }
            if (L.head >= L.e.length) { L.e = []; L.head = 0; continue; }
            const order = L.e[L.head + 1];
            if (order < bestOrder) { bestOrder = order; best = L; }
        }
        if (!best) break;
        const s = best.e[best.head];
        if (!spawnQueuedUnitFromSpawner(s)) break;
        best.head += 2;
        if (best.head > 4096 && best.head * 2 > best.e.length) { best.e = best.e.slice(best.head); best.head = 0; }
        spawned++;
        // Its next front, if paid already: ready again (a new order).
        if (spawned < 2048 && _spawnReadyValid(s) && !Number.isFinite(s._spawnReadyOrder)) { s._spawnReadyOrder = globalSpawnerReadyOrderCounter++; spawnerReadyNoted(s); }
    }
}

class Barrack {
    constructor(gx, gy, owner, unitType = 'norm', stacks = 1) {
        this.gx = gx; this.gy = gy; this.owner = owner;
        this.x = gx * TILE + 16; this.y = gy * TILE + 16;
        this.stacks = stacks; this.type = 'barrack'; this.unitType = unitType;
        this.manualStacks = stacks;
        this.effectiveStacks = stacks;
        this.level = stackCountToLevel(this.stacks);
        this.effectiveLevel = this.level;
        this.isStacking = false;
        this.stackingWorkDone = 0;
        this.spawnTimer = 0;
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown(unitType, this.level, this.owner, `barrack_${this.unitType}`) * TICK_RATE);
        this.spawnQueue = []; // queue of unit types to spawn
        this.rallyX = null; this.rallyY = null; // rally point in world coords
        this.rallyTargetUnitId = null;
        let stats = calculateItemStats('barrack_' + this.unitType, this.level, this.owner);
        this.preComputedBase = stats;
        this.preComputedEffective = stats;
        this.preComputed = this.preComputedBase;
        this.energy = stats.maxEnergy; this.maxEnergy = stats.maxEnergy;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.queueEnabled = true;
        updateItemTextCache(this);
    }

    getUnitCost() {
        let lvl = getThingBaseLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, this.unitType, lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }

    update() {
        thingStatusTickSelf(this);
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;
        let effLvl = getThingBaseLevel(this);
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown(this.unitType, effLvl, this.owner, `barrack_${this.unitType}`) * TICK_RATE);
        if (this.spawnQueue.length > 0) {
            updateSpawnerProductionProgress(this);
        } else {
            this.spawnTimer = 0;
            this._spawnReadyOrder = undefined;
        }
    }

    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
        if (this.owner >= 0) {
            ctx.strokeStyle = get2DRenderOwnerColor(this.owner); ctx.lineWidth = 1;
            ctx.strokeRect(this.x - 15, this.y - 15, 30, 30);
        }

        ctx.fillStyle = '#664'; ctx.beginPath();
        ctx.moveTo(this.x - 12, this.y - 12); ctx.lineTo(this.x + 12, this.y - 12); ctx.lineTo(this.x, this.y - 20);
        ctx.fill();

        // Unit type indicator
        let us = BASE_UNIT_STATS[this.unitType] || BASE_UNIT_STATS.norm;
        ctx.fillStyle = us.color; ctx.beginPath(); ctx.arc(this.x, this.y + 4, 5, 0, 6.28); ctx.fill();

        if (this.underConstruction) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 14, 24, 3);
        } else {
            // Spawn progress (only show when queue has items)
            if (this.spawnQueue.length > 0 && this.spawnCooldown > 0) {
                let pct = this.spawnTimer / this.spawnCooldown;
                let bw = 24, bh = 3, bx = this.x - bw / 2, by = this.y + 12;
                ctx.fillStyle = '#333'; ctx.fillRect(bx, by, bw, bh);
                ctx.fillStyle = pct > 0.8 ? '#4f4' : '#fa0'; ctx.fillRect(bx, by, bw * pct, bh);
            }
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 17, 24, 3);
        }
        if (this.textCanvas && shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);
    }
}

// ============================================================
// COLLECTOR / SALVAGER (barrack-like spawners + worker units)
// ============================================================
// A barrack or spawner whose update would change nothing: nothing queued,
// its timer at rest, no status running, alive; not a research building
// (its update moves research on). (Its spawn cooldown is worked
// out again by its next update, once something is queued.)
function spawnerQuiet(b) {
    return b.type !== 'research' && !!b.spawnQueue && b.spawnQueue.length === 0 && !(b.spawnTimer > 0) && b._spawnReadyOrder === undefined
        && b.energy > 0 && !thingStatusPending(b);
}

// Production is a tier below the tick: a barrack or spawner brings its
// queue's front up to date (timer from the energy paid, its ready order
// once paid; a research building also its player's research task: a
// finished one completes) every SPAWNER_UPDATE_TICKS ticks, staggered by
// tile (payments and research work themselves are not delayed; a spawn is
// ready, research completes, up to that many ticks later).
const SPAWNER_UPDATE_TICKS = 4;
// Per player, the tick its research task was last moved on (by a research
// building's update; idempotent within a tick, so this only saves calls).
const _researchAdvancedTick = [];
function spawnerDue(b) {
    return ((gameTime + b.gx + b.gy * 7) % SPAWNER_UPDATE_TICKS) === 0;
}

class CollectorSpawner {
    constructor(gx, gy, owner, stacks = 1) {
        this.gx = gx; this.gy = gy; this.owner = owner;
        this.x = gx * TILE + 16; this.y = gy * TILE + 16;
        this.stacks = stacks; this.type = 'spawner';
        this.manualStacks = stacks;
        this.effectiveStacks = stacks;
        this.level = stackCountToLevel(this.stacks);
        this.effectiveLevel = this.level;
        this.isStacking = false;
        this.stackingWorkDone = 0;
        let stats = calculateItemStats('spawner', this.level, this.owner);
        this.preComputedBase = stats;
        this.preComputedEffective = stats;
        this.preComputed = this.preComputedBase;
        this.energy = stats.maxEnergy; this.maxEnergy = stats.maxEnergy;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.queueEnabled = true;
        this.spawnQueue = []; this.spawnTimer = 0;
        this.rallyX = null; this.rallyY = null; this.rallyTargetUnitId = null;
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('collector', this.level, this.owner, 'spawner') * TICK_RATE);
        updateItemTextCache(this);
    }
    getUnitCost() {
        let lvl = getThingBaseLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'collector', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }
    update() {
        thingStatusTickSelf(this);
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;
        let effLvl = getThingBaseLevel(this);
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('collector', effLvl, this.owner, 'spawner') * TICK_RATE);
        if (this.spawnQueue.length > 0) {
            updateSpawnerProductionProgress(this);
        } else { this.spawnTimer = 0; this._spawnReadyOrder = undefined; }
    }
    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
        if (this.owner >= 0) {
            ctx.strokeStyle = get2DRenderOwnerColor(this.owner); ctx.lineWidth = 1;
            ctx.strokeRect(this.x - 15, this.y - 15, 30, 30);
        }
        ctx.fillStyle = '#432'; ctx.fillRect(this.x - 12, this.y - 12, 24, 24);
        ctx.fillStyle = '#f3d55b';
        ctx.fillRect(this.x - 7, this.y - 5, 14, 10);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(this.x - 7, this.y - 5, 14, 10);
        ctx.fillStyle = '#111';
        ctx.font = 'bold 12px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚡', this.x, this.y + 1);
        if (this.underConstruction) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 10, 24, 3);
        } else {
            if (this.spawnQueue.length > 0 && this.spawnCooldown > 0) {
                let pct = this.spawnTimer / this.spawnCooldown;
                ctx.fillStyle = '#333'; ctx.fillRect(this.x - 12, this.y + 6, 24, 3);
                ctx.fillStyle = pct > 0.8 ? '#4f4' : '#fa0'; ctx.fillRect(this.x - 12, this.y + 6, 24 * pct, 3);
            }
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 11, 20, 3);
        }
        if (this.textCanvas && shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);
    }
}

class AstarSpawner {
    constructor(gx, gy, owner, stacks = 1) {
        this.gx = gx; this.gy = gy; this.owner = owner;
        this.x = gx * TILE + 16; this.y = gy * TILE + 16;
        this.stacks = stacks; this.type = 'astar_spawner';
        this.manualStacks = stacks;
        this.effectiveStacks = stacks;
        this.level = stackCountToLevel(this.stacks);
        this.effectiveLevel = this.level;
        this.isStacking = false;
        this.stackingWorkDone = 0;
        let stats = calculateItemStats('astar_spawner', this.level, this.owner);
        this.preComputedBase = stats;
        this.preComputedEffective = stats;
        this.preComputed = this.preComputedBase;
        this.energy = stats.maxEnergy; this.maxEnergy = stats.maxEnergy;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.queueEnabled = true;
        this.spawnQueue = []; this.spawnTimer = 0;
        this.rallyX = null; this.rallyY = null; this.rallyTargetUnitId = null;
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('astar_collector', this.level, this.owner, 'astar_spawner') * TICK_RATE);
        updateItemTextCache(this);
    }
    getUnitCost() {
        let lvl = getThingBaseLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'astar_collector', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }
    update() {
        thingStatusTickSelf(this);
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;
        let effLvl = getThingBaseLevel(this);
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('astar_collector', effLvl, this.owner, 'astar_spawner') * TICK_RATE);
        if (this.spawnQueue.length > 0) {
            updateSpawnerProductionProgress(this);
        } else { this.spawnTimer = 0; this._spawnReadyOrder = undefined; }
    }
    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
        if (this.owner >= 0) {
            ctx.strokeStyle = get2DRenderOwnerColor(this.owner); ctx.lineWidth = 1;
            ctx.strokeRect(this.x - 15, this.y - 15, 30, 30);
        }
        ctx.fillStyle = '#432'; ctx.fillRect(this.x - 12, this.y - 12, 24, 24);
        ctx.fillStyle = '#f0f0f0';
        ctx.font = 'bold 16px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('★', this.x, this.y + 1);
        if (this.underConstruction) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 10, 24, 3);
        } else {
            if (this.spawnQueue.length > 0 && this.spawnCooldown > 0) {
                let pct = this.spawnTimer / this.spawnCooldown;
                ctx.fillStyle = '#333'; ctx.fillRect(this.x - 12, this.y + 6, 24, 3);
                ctx.fillStyle = pct > 0.8 ? '#4f4' : '#fa0'; ctx.fillRect(this.x - 12, this.y + 6, 24 * pct, 3);
            }
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 11, 20, 3);
        }
        if (this.textCanvas && shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);
    }
}

class SalvagerSpawner {
    constructor(gx, gy, owner, stacks = 1) {
        this.gx = gx; this.gy = gy; this.owner = owner;
        this.x = gx * TILE + 16; this.y = gy * TILE + 16;
        this.stacks = stacks; this.type = 'salvager';
        this.manualStacks = stacks;
        this.effectiveStacks = stacks;
        this.level = stackCountToLevel(this.stacks);
        this.effectiveLevel = this.level;
        this.isStacking = false;
        this.stackingWorkDone = 0;
        let stats = calculateItemStats('salvager', this.level, this.owner);
        this.preComputedBase = stats;
        this.preComputedEffective = stats;
        this.preComputed = this.preComputedBase;
        this.energy = stats.maxEnergy; this.maxEnergy = stats.maxEnergy;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.queueEnabled = true;
        this.spawnQueue = []; this.spawnTimer = 0;
        this.rallyX = null; this.rallyY = null; this.rallyTargetUnitId = null;
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('salvager_unit', this.level, this.owner, 'salvager') * TICK_RATE);
        updateItemTextCache(this);
    }
    getUnitCost() {
        let lvl = getThingBaseLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'salvager_unit', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }
    update() {
        thingStatusTickSelf(this);
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;
        let effLvl = getThingBaseLevel(this);
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('salvager_unit', effLvl, this.owner, 'salvager') * TICK_RATE);
        if (this.spawnQueue.length > 0) {
            updateSpawnerProductionProgress(this);
        } else { this.spawnTimer = 0; this._spawnReadyOrder = undefined; }
    }
    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
        if (this.owner >= 0) {
            ctx.strokeStyle = get2DRenderOwnerColor(this.owner); ctx.lineWidth = 1;
            ctx.strokeRect(this.x - 15, this.y - 15, 30, 30);
        }
        ctx.fillStyle = '#543'; ctx.fillRect(this.x - 12, this.y - 12, 24, 24);
        ctx.fillStyle = '#8d8'; ctx.beginPath();
        for (let i = 0; i < 3; i++) { let a = (i * 2 * Math.PI) / 3 - Math.PI / 2; ctx.lineTo(this.x + Math.cos(a) * 8, this.y + Math.sin(a) * 8); }
        ctx.closePath(); ctx.fill();
        if (this.underConstruction) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 10, 24, 3);
        } else {
            if (this.spawnQueue.length > 0 && this.spawnCooldown > 0) {
                let pct = this.spawnTimer / this.spawnCooldown;
                ctx.fillStyle = '#333'; ctx.fillRect(this.x - 12, this.y + 6, 24, 3);
                ctx.fillStyle = pct > 0.8 ? '#4f4' : '#fa0'; ctx.fillRect(this.x - 12, this.y + 6, 24 * pct, 3);
            }
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 11, 20, 3);
        }
        if (this.textCanvas && shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);
    }
}

class BuilderSpawner {
    constructor(gx, gy, owner, stacks = 1) {
        this.gx = gx; this.gy = gy; this.owner = owner;
        this.x = gx * TILE + 16; this.y = gy * TILE + 16;
        this.stacks = stacks; this.type = 'builder_spawner';
        this.manualStacks = stacks;
        this.effectiveStacks = stacks;
        this.level = stackCountToLevel(this.stacks);
        this.effectiveLevel = this.level;
        this.isStacking = false;
        this.stackingWorkDone = 0;
        let stats = calculateItemStats('builder_spawner', this.level, this.owner);
        this.preComputedBase = stats;
        this.preComputedEffective = stats;
        this.preComputed = this.preComputedBase;
        this.energy = stats.maxEnergy; this.maxEnergy = stats.maxEnergy;
        this.underConstruction = true;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.queueEnabled = true;
        this.spawnQueue = []; this.spawnTimer = 0;
        this.rallyX = null; this.rallyY = null; this.rallyTargetUnitId = null;
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('builder_unit', this.level, this.owner, 'builder_spawner') * TICK_RATE);
        updateItemTextCache(this);
    }
    getUnitCost() {
        let lvl = getThingBaseLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'builder_unit', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }
    // Builder DPS per unit: scales with base level
    getBuilderDps() {
        let lvl = getThingBaseLevel(this);
        let dps = getUnitStatForOwner(this.owner, 'builder_unit', lvl, 'builderDps');
        let fallback = Number(UNIT_FORMULA_CONFIG.workerSpecialistBaseRate) || 1;
        return Math.max(1, Math.round(Number.isFinite(dps) ? dps : fallback));
    }
    update() {
        thingStatusTickSelf(this);
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;
        let effLvl = getThingBaseLevel(this);
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('builder_unit', effLvl, this.owner, 'builder_spawner') * TICK_RATE);
        if (this.spawnQueue.length > 0) {
            updateSpawnerProductionProgress(this);
        } else { this.spawnTimer = 0; this._spawnReadyOrder = undefined; }
    }
    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
        if (this.owner >= 0) {
            ctx.strokeStyle = get2DRenderOwnerColor(this.owner); ctx.lineWidth = 1;
            ctx.strokeRect(this.x - 15, this.y - 15, 30, 30);
        }
        ctx.fillStyle = '#354'; ctx.fillRect(this.x - 12, this.y - 12, 24, 24);
        // Rectangle icon
        ctx.fillStyle = '#8b5';
        ctx.fillRect(this.x - 7, this.y - 5, 14, 10);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(this.x - 7, this.y - 5, 14, 10);
        if (this.underConstruction) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 10, 24, 3);
        } else {
            if (this.spawnQueue.length > 0 && this.spawnCooldown > 0) {
                let pct = this.spawnTimer / this.spawnCooldown;
                ctx.fillStyle = '#333'; ctx.fillRect(this.x - 12, this.y + 6, 24, 3);
                ctx.fillStyle = pct > 0.8 ? '#4f4' : '#fa0'; ctx.fillRect(this.x - 12, this.y + 6, 24 * pct, 3);
            }
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 11, 20, 3);
        }
        if (this.textCanvas && shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);
    }
}

class HealerSpawner {
    constructor(gx, gy, owner, stacks = 1) {
        this.gx = gx; this.gy = gy; this.owner = owner;
        this.x = gx * TILE + 16; this.y = gy * TILE + 16;
        this.stacks = stacks; this.type = 'healer_spawner';
        this.manualStacks = stacks;
        this.effectiveStacks = stacks;
        this.level = stackCountToLevel(this.stacks);
        this.effectiveLevel = this.level;
        this.isStacking = false;
        this.stackingWorkDone = 0;
        let stats = calculateItemStats('healer_spawner', this.level, this.owner);
        this.preComputedBase = stats;
        this.preComputedEffective = stats;
        this.preComputed = this.preComputedBase;
        this.energy = stats.maxEnergy; this.maxEnergy = stats.maxEnergy;
        this.underConstruction = true;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.queueEnabled = true;
        this.spawnQueue = []; this.spawnTimer = 0;
        this.rallyX = null; this.rallyY = null; this.rallyTargetUnitId = null;
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('healer_unit', this.level, this.owner, 'healer_spawner') * TICK_RATE);
        updateItemTextCache(this);
    }
    getUnitCost() {
        let lvl = getThingBaseLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'healer_unit', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }
    gethealerDps() {
        let lvl = getThingBaseLevel(this);
        let dps = getUnitStatForOwner(this.owner, 'healer_unit', lvl, 'healerDps');
        let fallback = Number(UNIT_FORMULA_CONFIG.workerSpecialistBaseRate) || 1;
        return Math.max(1, Math.round(Number.isFinite(dps) ? dps : fallback));
    }
    update() {
        thingStatusTickSelf(this);
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;
        let effLvl = getThingBaseLevel(this);
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('healer_unit', effLvl, this.owner, 'healer_spawner') * TICK_RATE);
        if (this.spawnQueue.length > 0) {
            updateSpawnerProductionProgress(this);
        } else { this.spawnTimer = 0; this._spawnReadyOrder = undefined; }
    }
    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
        if (this.owner >= 0) {
            ctx.strokeStyle = get2DRenderOwnerColor(this.owner); ctx.lineWidth = 1;
            ctx.strokeRect(this.x - 15, this.y - 15, 30, 30);
        }
        ctx.fillStyle = '#355'; ctx.fillRect(this.x - 12, this.y - 12, 24, 24);
        ctx.fillStyle = '#fff';
        ctx.fillRect(this.x - 7, this.y - 5, 14, 10);
        ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1; ctx.strokeRect(this.x - 7, this.y - 5, 14, 10);
        if (this.underConstruction) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 10, 24, 3);
        } else {
            if (this.spawnQueue.length > 0 && this.spawnCooldown > 0) {
                let pct = this.spawnTimer / this.spawnCooldown;
                ctx.fillStyle = '#333'; ctx.fillRect(this.x - 12, this.y + 6, 24, 3);
                ctx.fillStyle = pct > 0.8 ? '#4f4' : '#fa0'; ctx.fillRect(this.x - 12, this.y + 6, 24 * pct, 3);
            }
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 11, 20, 3);
        }
        if (this.textCanvas && shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);
    }
}

class ResearchSpawner {
    constructor(gx, gy, owner, stacks = 1) {
        this.gx = gx; this.gy = gy; this.owner = owner;
        this.x = gx * TILE + 16; this.y = gy * TILE + 16;
        this.stacks = stacks; this.type = 'research';
        this.manualStacks = stacks;
        this.effectiveStacks = stacks;
        this.level = stackCountToLevel(this.stacks);
        this.effectiveLevel = this.level;
        this.isStacking = false;
        this.stackingWorkDone = 0;
        this.spawnTimer = 0;
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('researcher_unit', this.level, this.owner, 'research') * TICK_RATE);
        this.spawnQueue = [];
        this.rallyX = null; this.rallyY = null;
        this.rallyTargetUnitId = null;
        let stats = calculateItemStats('research', this.level, this.owner);
        this.preComputedBase = stats;
        this.preComputedEffective = stats;
        this.preComputed = this.preComputedBase;
        this.energy = stats.maxEnergy; this.maxEnergy = stats.maxEnergy;
        this.underConstruction = true;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.queueEnabled = true;
        this.autoResearchEnabled = true;
        this.researchTask = null;
        this.isResearching = false;
        updateItemTextCache(this);
    }

    getUnitCost() {
        let lvl = getThingBaseLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'researcher_unit', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }

    getResearcherDps() {
        let lvl = getThingBaseLevel(this);
        let dps = getUnitStatForOwner(this.owner, 'researcher_unit', lvl, 'researcherDps');
        let fallback = Number(UNIT_FORMULA_CONFIG.workerSpecialistBaseRate) || 1;
        return Math.max(1, Math.round(Number.isFinite(dps) ? dps : fallback));
    }

    update() {
        thingStatusTickSelf(this);
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;

        let effLvl = getThingBaseLevel(this);
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('researcher_unit', effLvl, this.owner, 'research') * TICK_RATE);
        if (this.spawnQueue.length > 0) {
            updateSpawnerProductionProgress(this);
        } else {
            this.spawnTimer = 0;
            this._spawnReadyOrder = undefined;
        }

        // (The player's research is one global pool: moved on at most once a
        // tick, by the first of its research buildings to update.)
        let task;
        if (_researchAdvancedTick[this.owner] === gameTime) task = getPlayerResearchTask(this.owner);
        else { _researchAdvancedTick[this.owner] = gameTime; task = tryAdvancePlayerResearchTask(this.owner); }
        this.researchTask = task || null;
        this.isResearching = !!(
            task
            && !this.isUpgrading
            && isAutoResearchEnabled(this)
            && (task.workDone || 0) < task.workRequired
        );
    }

    draw(ctx) {
        const gameTime = this._historyGhost ? this._historyTick : getRenderGameTime();
        if (this.owner >= 0) {
            ctx.strokeStyle = get2DRenderOwnerColor(this.owner); ctx.lineWidth = 1;
            ctx.strokeRect(this.x - 15, this.y - 15, 30, 30);
        }
        ctx.fillStyle = '#446'; ctx.fillRect(this.x - 12, this.y - 12, 24, 24);
        ctx.fillStyle = '#aef';
        ctx.font = '11px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('R', this.x, this.y + 1);

        if (this.underConstruction) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 10, 24, 3);
        } else {
            if (this.spawnQueue.length > 0 && this.spawnCooldown > 0) {
                let pct = this.spawnTimer / this.spawnCooldown;
                ctx.fillStyle = '#333'; ctx.fillRect(this.x - 12, this.y + 6, 24, 3);
                ctx.fillStyle = pct > 0.8 ? '#4f4' : '#fa0'; ctx.fillRect(this.x - 12, this.y + 6, 24 * pct, 3);
            }
            if (this.researchTask && this.researchTask.workRequired > 0) {
                let pct = Math.max(0, Math.min(1, (this.researchTask.workDone || 0) / this.researchTask.workRequired));
                ctx.fillStyle = '#333'; ctx.fillRect(this.x - 12, this.y + 2, 24, 3);
                ctx.fillStyle = pct > 0.8 ? '#4f4' : '#4af'; ctx.fillRect(this.x - 12, this.y + 2, 24 * pct, 3);
            }
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 11, 20, 3);
        }

        if (this.textCanvas && shouldShowBuildingLevels(this)) drawLevelTextCache(ctx, this, this.x, this.y);
    }
}


function _makeSpawnerRallyTemplateKey(spawner, startGx, startGy, endGx, endGy, unit) {
    let movementProfile = _resolveMovementProfile(!!(unit && unit.isFlying), getPathCanWalkForUnit(unit), null) || 'dynamic';
    return [
        spawner.type,
        spawner.owner,
        spawner.gx,
        spawner.gy,
        startGx,
        startGy,
        endGx,
        endGy,
        movementProfile,
        pathTopologyVersion
    ].join('|');
}

function _getSpawnerRallyTemplatePath(cacheKey) {
    let entry = sharedSpawnerRallyTemplateCache.get(cacheKey);
    if (entry && !_isPathCacheExpired(entry, SPAWNER_RALLY_TEMPLATE_TTL_TICKS)) {
        return entry.path;
    }
    if (entry) sharedSpawnerRallyTemplateCache.delete(cacheKey);
    return null;
}

function _setSpawnerRallyTemplatePath(cacheKey, path) {
    sharedSpawnerRallyTemplateCache.set(cacheKey, {
        path,
        tick: gameTime,
        version: pathTopologyVersion
    });
    _trimPathCacheIfNeeded(sharedSpawnerRallyTemplateCache, SPAWNER_RALLY_TEMPLATE_MAX_ENTRIES);
}
