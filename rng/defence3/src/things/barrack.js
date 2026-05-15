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
    let baseCd = Math.max(0.05, getBaseSpawnCooldownSeconds(unitType, buildingKey) * Math.pow(1 - reduction, level - 1));
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

function updateSpawnerProductionProgress(spawner) {
    if (!spawner) return;
    if (!Array.isArray(spawner.spawnQueue) || spawner.spawnQueue.length <= 0) {
        spawner.spawnTimer = 0;
        spawner._spawnReadyOrder = undefined;
        return;
    }
    let owner = Number.isFinite(spawner.owner) ? spawner.owner : localPlayerId;
    let effLvl = getThingEffectiveLevel(spawner);
    let fallbackType = getSpawnerFallbackUnitType(spawner);
    let front = getQueuedSpawnInfo(spawner.spawnQueue[0], fallbackType, effLvl, owner);
    spawner.spawnQueue[0] = front;

    let cooldown = Math.max(1, Math.round(spawner.spawnCooldown || 1));
    spawner.spawnCooldown = cooldown;
    let paidPct = front.energyRequired > 0 ? (front.energyPaid / front.energyRequired) : 0;
    spawner.spawnTimer = Math.max(0, Math.min(cooldown, Math.round(cooldown * paidPct)));
    if (front.energyPaid >= front.energyRequired && !Number.isFinite(spawner._spawnReadyOrder)) {
        spawner._spawnReadyOrder = globalSpawnerReadyOrderCounter++;
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

    let effLvl = getThingEffectiveLevel(spawner);
    let fallbackType = getSpawnerFallbackUnitType(spawner);
    if (!fallbackType) return false;

    let queued = spawner.spawnQueue.shift();
    let spawnInfo = getQueuedSpawnInfo(queued, fallbackType, effLvl, owner);
    let spawnPos = findNearestWalkable(spawner.gx, spawner.gy);
    let u = new Unit(spawnInfo.unitType, owner, spawnPos.x * TILE + 16, spawnPos.y * TILE + 16);
    configureWorkerUnitFromType(u);

    applyUnitLevelScaling(u, spawnInfo.level);
    u.energy = u.maxEnergy;
    units.push(u);
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
        if (_canUsePathfindRequestBudget(u.owner)) {
            _consumePathfindRequestBudget(u.owner);
            let rallyCacheKey = _makeSpawnerRallyTemplateKey(spawner, spawnPos.x, spawnPos.y, rgx, rgy, u);
            rallyPath = _getSpawnerRallyTemplatePath(rallyCacheKey);
            if (!rallyPath) {
                rallyPath = _findPathForUnitTagged('spawner_rally', u, spawnPos.x, spawnPos.y, rgx, rgy, u.isFlying, getPathCanWalkForUnit(u), u.owner);
                _setSpawnerRallyTemplatePath(rallyCacheKey, rallyPath);
            }
        }

        if (spawner.type === 'barrack') {
            u.path = rallyPath;
            u.pathIndex = 0;
            if (u.path && u.path.length > 0) u.commandState = CMD_ATTACK_MOVING;
        } else {
            if (!rallyPath || rallyPath.length <= 0) {
                rallyPath = _makeFallbackPathForUnit(u, spawnPos.x, spawnPos.y, rgx, rgy, CMD_MOVING, 'spawner_rally');
            }
            u.path = rallyPath;
            u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === spawnPos.x && u.path[0].y === spawnPos.y) ? 1 : 0;
            u.commandState = CMD_MOVING;
            u.workerState = 'MANUAL_MOVE';
        }
    }

    spawner.spawnTimer = 0;
    spawner._spawnReadyOrder = undefined;
    return true;
}

function processGlobalSpawnerQueue() {
    let collectReady = () => {
        let ready = [];
        let pushIfReady = (s) => {
            if (!s || s.energy <= 0 || s.underConstruction) return;
            if (!isQueueEnabled(s)) return;
            if (!Array.isArray(s.spawnQueue) || s.spawnQueue.length <= 0) return;
            let owner = Number.isFinite(s.owner) ? s.owner : localPlayerId;
            let effLvl = getThingEffectiveLevel(s);
            let fallbackType = getSpawnerFallbackUnitType(s);
            let front = getQueuedSpawnInfo(s.spawnQueue[0], fallbackType, effLvl, owner);
            if (front.energyPaid < front.energyRequired) return;
            if (!Number.isFinite(s._spawnReadyOrder)) s._spawnReadyOrder = globalSpawnerReadyOrderCounter++;
            ready.push(s);
        };
        for (let b of barracks) pushIfReady(b);
        for (let s of collectorSpawners) pushIfReady(s);
        return ready;
    };

    let guard = 0;
    while (guard++ < 2048) {
        let ready = collectReady();
        if (ready.length <= 0) break;

        let chosen = null;
        let chosenOrder = Infinity;
        for (let s of ready) {
            if (!(players[s.owner].popCount < getPlayerPopCap(s.owner))) continue;
            let ord = Number(s._spawnReadyOrder) || Infinity;
            if (ord < chosenOrder) {
                chosenOrder = ord;
                chosen = s;
            }
        }
        if (!chosen) break;
        if (!spawnQueuedUnitFromSpawner(chosen)) break;
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
        this.preComputed = this.preComputedEffective;
        this.energy = stats.maxEnergy; this.maxEnergy = stats.maxEnergy;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.queueEnabled = true;
        updateItemTextCache(this);
    }

    getUnitCost() {
        let lvl = getThingEffectiveLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, this.unitType, lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }

    update() {
        tickStatusEffects(this);
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;
        let effLvl = getThingEffectiveLevel(this);
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown(this.unitType, effLvl, this.owner, `barrack_${this.unitType}`) * TICK_RATE);
        if (this.spawnQueue.length > 0) {
            updateSpawnerProductionProgress(this);
        } else {
            this.spawnTimer = 0;
            this._spawnReadyOrder = undefined;
        }
    }

    draw(ctx) {
        // Owner border
        ctx.strokeStyle = PLAYER_COLORS[this.owner]; ctx.lineWidth = 1;
        ctx.strokeRect(this.x - 14, this.y - 14, 28, 28);

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
        if (this.textCanvas && shouldShowBuildingLevels()) drawLevelTextCache(ctx, this, this.x, this.y);
    }
}

// ============================================================
// COLLECTOR / SALVAGER (barrack-like spawners + worker units)
// ============================================================
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
        this.preComputed = this.preComputedEffective;
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
        let lvl = getThingEffectiveLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'collector', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }
    update() {
        tickStatusEffects(this);
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;
        let effLvl = getThingEffectiveLevel(this);
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('collector', effLvl, this.owner, 'spawner') * TICK_RATE);
        if (this.spawnQueue.length > 0) {
            updateSpawnerProductionProgress(this);
        } else { this.spawnTimer = 0; this._spawnReadyOrder = undefined; }
    }
    draw(ctx) {
        ctx.strokeStyle = PLAYER_COLORS[this.owner]; ctx.lineWidth = 1;
        ctx.strokeRect(this.x - 14, this.y - 14, 28, 28);
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
        if (this.textCanvas && shouldShowBuildingLevels()) drawLevelTextCache(ctx, this, this.x, this.y);
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
        this.preComputed = this.preComputedEffective;
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
        let lvl = getThingEffectiveLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'astar_collector', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }
    update() {
        tickStatusEffects(this);
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;
        let effLvl = getThingEffectiveLevel(this);
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('astar_collector', effLvl, this.owner, 'astar_spawner') * TICK_RATE);
        if (this.spawnQueue.length > 0) {
            updateSpawnerProductionProgress(this);
        } else { this.spawnTimer = 0; this._spawnReadyOrder = undefined; }
    }
    draw(ctx) {
        ctx.strokeStyle = PLAYER_COLORS[this.owner]; ctx.lineWidth = 1;
        ctx.strokeRect(this.x - 14, this.y - 14, 28, 28);
        ctx.fillStyle = '#555'; ctx.fillRect(this.x - 12, this.y - 12, 24, 24);
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
        if (this.textCanvas && shouldShowBuildingLevels()) drawLevelTextCache(ctx, this, this.x, this.y);
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
        this.preComputed = this.preComputedEffective;
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
        let lvl = getThingEffectiveLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'salvager_unit', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }
    update() {
        tickStatusEffects(this);
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;
        let effLvl = getThingEffectiveLevel(this);
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('salvager_unit', effLvl, this.owner, 'salvager') * TICK_RATE);
        if (this.spawnQueue.length > 0) {
            updateSpawnerProductionProgress(this);
        } else { this.spawnTimer = 0; this._spawnReadyOrder = undefined; }
    }
    draw(ctx) {
        ctx.strokeStyle = PLAYER_COLORS[this.owner]; ctx.lineWidth = 1;
        ctx.strokeRect(this.x - 14, this.y - 14, 28, 28);
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
        if (this.textCanvas && shouldShowBuildingLevels()) drawLevelTextCache(ctx, this, this.x, this.y);
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
        this.preComputed = this.preComputedEffective;
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
        let lvl = getThingEffectiveLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'builder_unit', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }
    // Builder DPS per unit: scales with effective level
    getBuilderDps() {
        let lvl = getThingEffectiveLevel(this);
        let dps = getUnitStatForOwner(this.owner, 'builder_unit', lvl, 'builderDps');
        let fallback = Number(UNIT_FORMULA_CONFIG.workerSpecialistBaseRate) || 1;
        return Math.max(1, Math.round(Number.isFinite(dps) ? dps : fallback));
    }
    update() {
        tickStatusEffects(this);
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;
        let effLvl = getThingEffectiveLevel(this);
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('builder_unit', effLvl, this.owner, 'builder_spawner') * TICK_RATE);
        if (this.spawnQueue.length > 0) {
            updateSpawnerProductionProgress(this);
        } else { this.spawnTimer = 0; this._spawnReadyOrder = undefined; }
    }
    draw(ctx) {
        ctx.strokeStyle = PLAYER_COLORS[this.owner]; ctx.lineWidth = 1;
        ctx.strokeRect(this.x - 14, this.y - 14, 28, 28);
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
        if (this.textCanvas && shouldShowBuildingLevels()) drawLevelTextCache(ctx, this, this.x, this.y);
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
        this.preComputed = this.preComputedEffective;
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
        let lvl = getThingEffectiveLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'healer_unit', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }
    gethealerDps() {
        let lvl = getThingEffectiveLevel(this);
        let dps = getUnitStatForOwner(this.owner, 'healer_unit', lvl, 'healerDps');
        let fallback = Number(UNIT_FORMULA_CONFIG.workerSpecialistBaseRate) || 1;
        return Math.max(1, Math.round(Number.isFinite(dps) ? dps : fallback));
    }
    update() {
        tickStatusEffects(this);
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;
        let effLvl = getThingEffectiveLevel(this);
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('healer_unit', effLvl, this.owner, 'healer_spawner') * TICK_RATE);
        if (this.spawnQueue.length > 0) {
            updateSpawnerProductionProgress(this);
        } else { this.spawnTimer = 0; this._spawnReadyOrder = undefined; }
    }
    draw(ctx) {
        ctx.strokeStyle = PLAYER_COLORS[this.owner]; ctx.lineWidth = 1;
        ctx.strokeRect(this.x - 14, this.y - 14, 28, 28);
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
        if (this.textCanvas && shouldShowBuildingLevels()) drawLevelTextCache(ctx, this, this.x, this.y);
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
        this.preComputed = this.preComputedEffective;
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
        let lvl = getThingEffectiveLevel(this);
        let energyCost = getUnitStatForOwner(this.owner, 'researcher_unit', lvl, 'energy');
        return Math.max(1, Math.floor(Number.isFinite(energyCost) ? energyCost : 1));
    }

    getResearcherDps() {
        let lvl = getThingEffectiveLevel(this);
        let dps = getUnitStatForOwner(this.owner, 'researcher_unit', lvl, 'researcherDps');
        let fallback = Number(UNIT_FORMULA_CONFIG.workerSpecialistBaseRate) || 1;
        return Math.max(1, Math.round(Number.isFinite(dps) ? dps : fallback));
    }

    update() {
        tickStatusEffects(this);
        if (this.energy <= 0) return;
        if (_shouldWaitForConstruction(this)) return;

        let effLvl = getThingEffectiveLevel(this);
        this.spawnCooldown = Math.round(getBarrackSpawnCooldown('researcher_unit', effLvl, this.owner, 'research') * TICK_RATE);
        if (this.spawnQueue.length > 0) {
            updateSpawnerProductionProgress(this);
        } else {
            this.spawnTimer = 0;
            this._spawnReadyOrder = undefined;
        }

        let task = tryAdvancePlayerResearchTask(this.owner);
        this.researchTask = task || null;
        this.isResearching = !!(
            task
            && !this.isUpgrading
            && isAutoResearchEnabled(this)
            && (task.workDone || 0) < task.workRequired
        );
    }

    draw(ctx) {
        ctx.strokeStyle = PLAYER_COLORS[this.owner]; ctx.lineWidth = 1;
        ctx.strokeRect(this.x - 14, this.y - 14, 28, 28);
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

        if (this.textCanvas && shouldShowBuildingLevels()) drawLevelTextCache(ctx, this, this.x, this.y);
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