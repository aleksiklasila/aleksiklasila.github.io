"use strict";

// Research is one pool per player: a researcher at a research building
// adds its trip's work (its rate times the building's efficiency) to its
// player's researchPoints every transfer cooldown, paying energy at the
// active task's cost per work, while the pool does not already cover that
// task; researchDrainTick moves the pool into the research queue every
// RESEARCH_DRAIN_TICKS.
function _researcherDeposit(u, target, owner) {
    if (!u || !target) return false;
    const task = getPlayerResearchTask(owner);
    if (!task || !_researchNeedsPoints(owner, task)) return false;
    const required = Math.max(0, Number(task.workRequired) || 0), cost = Math.max(0, Number(task.cost) || 0);
    const fallback = Math.max(1, Math.round(Number((BASE_UNIT_STATS.researcher_unit || {}).researcherDps) || Number(UNIT_FORMULA_CONFIG.workerSpecialistBaseRate) || 1));
    const dps = Number((u.preComputed && u.preComputed.researcherDps) || 0) || target.getResearcherDps() || fallback;
    const work = Math.max(0.1, dps * getResearchBuildingEfficiency(target));
    const tripCost = required > 0 ? work * cost / required : 0;
    if (tripCost > 0) {
        addPlayerResource(owner, 'energy', -tripCost);
        recordEnergyDelta(owner, 'research', -tripCost);
    }
    const p = players[owner];
    p.researchPoints = (Number(p.researchPoints) || 0) + work;
    u.workerTransferCooldown = getWorkerTypeTransferCooldownTicks('researcher', u);
    if (target.owner === localPlayerId && _noteAmbientSoundTick(target, 'research_tick', 12)) playSound('research_tick', target.x, target.y);
    return true;
}
// Whether the active task still needs points beyond the pool's.
function _researchNeedsPoints(owner, task) {
    const p = players[owner];
    return !!task && (Number(task.workDone) || 0) + (Number(p && p.researchPoints) || 0) < (Number(task.workRequired) || 0);
}
const RESEARCH_DRAIN_TICKS = 10;
// Every RESEARCH_DRAIN_TICKS: each player's research pool into its queue
// (tasks completed in turn; what is left waits for the next task).
function researchDrainTick() {
    if (gameTime % RESEARCH_DRAIN_TICKS !== 0) return;
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
// kernel walks it (which hands it back on those ticks).
const WORKER_MOVE_CHECK_TICKS = 32;
const BUILDER_WATCH_TICKS = WORKER_MOVE_CHECK_TICKS * 2;
const _WORKER_MOVING_STATES = new Set(['MANUAL_MOVE', 'MOVING_TO', 'MOVING_TO_ASTAR', 'RETURNING', 'RETURNING_ASTAR', 'MOVING_TO_BUILD', 'RETURNING_FOR_GOLD', 'MOVING_TO_HEAL', 'MOVING_TO_RESEARCH']);
function isWorkerBetweenMoveChecks(u) {
    return ((gameTime + u.id) | 0) % WORKER_MOVE_CHECK_TICKS !== 0 && _WORKER_MOVING_STATES.has(u.workerState)
        && !!u.path && u.pathIndex < u.path.length && !u.holdPosition;
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
    let workerAiTickDelay = Math.max(1, Math.floor(Number(WORKER_AI_TICK_DELAY) || 1));
    let canRunHeavyAi = ((gameTime + u.id) % workerAiTickDelay) === 0;

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
            }
            let issuedTick = Math.floor(Number(u._manualMoveIssuedTick) || 0);
            if ((gameTime - issuedTick) >= WORKER_MANUAL_MOVE_MAX_PENDING_TICKS) {
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
        _updateResourceCollectorAI(u, owner, myGx, myGy, canRunHeavyAi);
        return;
    } else if (u.workerType === 'salvager') {
        if (u.workerState === 'IDLE') {
            if (_wsRegistered(u)) return;
            if (!shouldRunWorkerIdleRetarget(u, canRunHeavyAi)) return;
            _salvagerFindTarget(u, myGx, myGy);
        } else if (u.workerState === 'MOVING_TO') {
            if (!u.workerTarget || !u.workerTarget.markedForSalvage || !_workerOwnsReservedTarget(u)) {
                _clearWorkerTarget(u, 'target_no_work');
                _clearWorkerAutoRoute(u);
                _salvagerFindTarget(u, myGx, myGy);
                return;
            }
            if (!u.path || u.pathIndex >= u.path.length) {
                if (_workerHasPendingAutoRouteToTarget(u)) return;
                let inSalvageRange = _isWorkerWithinTileInteractionRange(u, u.workerTarget, 1);
                if (inSalvageRange) {
                    if (u.workerTransferCooldown > 0) return;
                    let tKey = u.workerTarget.type === 'barrack' ? 'barrack_' + u.workerTarget.unitType : u.workerTarget.type;
                    let p = BASE_CARD_TYPES[tKey]; let refund = Math.floor((p ? p.price : 0) * (u.workerTarget.stacks || 1) * 0.1);
                    u.carryingValue = refund * getUnitBaseLevel(u);
                    if (owner === localPlayerId) playSound('salvager_work', u.x, u.y);
                    destroyBuilding(u.workerTarget);
                    u.workerTransferCooldown = getWorkerTypeTransferCooldownTicks('salvager', u);
                    _clearWorkerTarget(u, 'target_missing'); u.workerState = 'RETURNING'; _workerReturnPath(u);
                } else {
                    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
                    let canWalk = (nx, ny) => nx === u.workerTarget.gx && ny === u.workerTarget.gy;
                    u.path = _requestWorkerPath(u, startGx, startGy, u.workerTarget.gx, u.workerTarget.gy, canWalk, null, true);
                    if (u.path) {
                        u.pathIndex = 0;
                        u.commandState = CMD_MOVING;
                    } else {
                        _clearWorkerTarget(u, 'target_missing');
                        _clearWorkerAutoRoute(u);
                        _salvagerFindTarget(u, myGx, myGy);
                    }
                }
            }
        } else if (u.workerState === 'RETURNING') {
            if (!u.path || u.pathIndex >= u.path.length) {
                if (u.carryingValue > 0) {
                    if (u.workerTransferCooldown > 0) return;
                    let closest = _findClosestSpawner(u, 'salvager');
                    addPlayerResource(owner, 'energy', u.carryingValue);
                    recordEnergyDelta(owner, 'salvage', u.carryingValue);
                    u.workerTransferCooldown = getWorkerTypeTransferCooldownTicks('salvager', u);
                    if (owner === localPlayerId) playSound('salvage_collected', u.x, u.y);
                }
                u.carryingValue = 0;
                if (!canRunHeavyAi) return;
                _salvagerFindTarget(u, myGx, myGy);
            }
        }
    } else if (u.workerType === 'builder') {
        // Long-period watchdog: builders that stop making movement progress
        // should periodically re-evaluate work instead of waiting forever.
        // Sampled on its own cadence (BUILDER_WATCH_TICKS, a multiple of the
        // move checks; a parked builder wakes for it): how often the AI
        // happens to run otherwise must not change what it measures.
        let movedSinceLast = false;
        if (!Number.isFinite(u._builderLastWatchX) || !Number.isFinite(u._builderLastWatchY)) {
            u._builderLastWatchX = u.x;
            u._builderLastWatchY = u.y;
            u._builderLastMoveTick = gameTime;
        } else if (((gameTime + u.id) | 0) % BUILDER_WATCH_TICKS === 0) {
            movedSinceLast = detHypot(u.x - u._builderLastWatchX, u.y - u._builderLastWatchY) >= 2;
            u._builderLastWatchX = u.x;
            u._builderLastWatchY = u.y;
            if (movedSinceLast) u._builderLastMoveTick = gameTime;
        }

        let builderRecheckInterval = Math.max(120, Math.floor(TICK_RATE * 8));
        let builderStuckTicks = Math.max(60, Math.floor(TICK_RATE * 3));
        if (!Number.isFinite(u._builderNextRecheckTick)) u._builderNextRecheckTick = gameTime + builderRecheckInterval;
        if (!Number.isFinite(u._builderLastMoveTick)) u._builderLastMoveTick = gameTime;

        // (An idle builder without a target searches by the work versions
        // and its backoff, below; this recheck is for a stuck one.)
        if (u.workerState === 'IDLE' && u.workerTarget && gameTime >= u._builderNextRecheckTick) {
            u._builderNextRecheckTick = gameTime + builderRecheckInterval;
            let stuckTooLong = (gameTime - u._builderLastMoveTick) >= builderStuckTicks;
            if (stuckTooLong) {
                // Drop stale route/spawner reservation and find a fresh task.
                u.path = null;
                u.pathIndex = 0;
                u._builderSpawnerTarget = null;
                _clearWorkerTarget(u);
                _builderFindTarget(u, myGx, myGy);
            }
        }

        if (u.workerState === 'IDLE') {
            if (_wsRegistered(u)) return;
            if (!shouldRunWorkerIdleRetarget(u, canRunHeavyAi)) return;
            _builderFindTarget(u, myGx, myGy);
        } else if (u.workerState === 'MOVING_TO_BUILD') {
            if (!_isBuilderWorkTarget(u.workerTarget, owner)) {
                // Building finished (maybe by another builder), find next
                _builderRememberWorkSite(u);
                _clearWorkerTarget(u);
                _builderFindTarget(u, myGx, myGy);
                return;
            }
            if (!u.path || u.pathIndex >= u.path.length) {
                let inBuildRange = _isWorkerWithinTileInteractionRange(u, u.workerTarget, 1);
                if (!inBuildRange) {
                    // If displaced while en route, re-path back to the same target.
                    let canWalk = _builderCanWalk(u.owner);
                    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
                    u.path = _requestWorkerPath(u, startGx, startGy, u.workerTarget.gx, u.workerTarget.gy, canWalk, 'builder');
                    u.pathIndex = 0;
                    u.commandState = CMD_MOVING;
                    return;
                }
                if (inBuildRange) {
                    if (!u.builderHasMaterial) {
                        let route = _workerSpawnerRoute(u, 'builder_spawner', _builderCanWalk(u.owner), canRunHeavyAi);
                        let tripCost = getBuilderTripGoldCost(u);
                        if (route) {
                            u.workerState = 'RETURNING_FOR_GOLD';
                            u.path = route.path;
                            u.pathIndex = 0; u.commandState = CMD_MOVING;
                            u._builderSpawnerTarget = route.spawner;
                            u.targetPos = route.spawner ? { x: route.spawner.gx * TILE + 16, y: route.spawner.gy * TILE + 16 } : null;
                            return;
                        } else {
                            if (u.workerTransferCooldown <= 0) {
                                // No route available: buy material on-site and keep full builder throughput.
                                addPlayerResource(owner, 'energy', -tripCost);
                                recordEnergyDelta(owner, 'builder', -tripCost);
                                u.builderHasMaterial = true;
                                u.workerTransferCooldown = getBuilderTransferCooldownTicks(u);
                            }
                            u.workerState = 'BUILDING_IN_PLACE';
                            return;
                        }
                    }
                    if (u.workerTransferCooldown > 0) return;
                    // Add Energy to building
                    let baseBuild = Number((BASE_UNIT_STATS[u.unitType] || {}).builderDps) || Number(UNIT_FORMULA_CONFIG.workerSpecialistBaseRate) || 1;
                    let dps = Number((u.preComputed && u.preComputed.builderDps) || 0) || baseBuild;
                    let t = u.workerTarget;
                    let didWork = false;
                    if (t.underConstruction) {
                        let requiredEnergy = _getBuilderProgressRequiredEnergy(t);
                        t.maxEnergy = requiredEnergy;
                        t.energy = Math.round(Math.min(requiredEnergy, t.energy + dps) * 1000) / 1000;
                        didWork = true;
                        if (t.energy >= requiredEnergy) {
                            markConstructionComplete(t);
                            refreshThingProgressState(t);
                            if (t.owner === localPlayerId) playSound('build_complete', t.x, t.y);
                            _requestAdjacencyRecalcForThing(t, 1);
                            recalculateAdjacency();
                            _builderRememberWorkSite(u, t);
                            if (!t.underConstruction && !t.isUpgrading && !t.isStacking) {
                                _clearWorkerTarget(u);
                                _builderFindTarget(u, myGx, myGy);
                            }
                        }
                    } else if (t.isUpgrading) {
                        let requiredEnergy = _getBuilderProgressRequiredEnergy(t);
                        t.upgrademaxEnergy = requiredEnergy;
                        t.maxEnergy = requiredEnergy;
                        t.energy = Math.round(Math.min(requiredEnergy, t.energy + dps) * 1000) / 1000;
                        didWork = true;
                        if (t.energy >= requiredEnergy) {
                            let prevStacked = getThingStackedStacks(t);
                            let prevManual = getThingManualStacks(t);
                            let remainingBeforeUpgrade = Math.max(0, prevManual - prevStacked);
                            let nextLevel = getThingBaseLevel(t) + 1;
                            t.level = nextLevel;
                            if (typeof upkeepThingDirty === 'function') upkeepThingDirty(t);
                            t.stacks = Math.max(prevStacked, getRequiredStacksForLevel(nextLevel));
                            t.manualStacks = Math.max(prevManual, t.stacks + remainingBeforeUpgrade);

                            t.isUpgrading = false;
                            t.upgrademaxEnergy = 0;
                            refreshThingProgressState(t);
                            if (t.owner === localPlayerId) playSound('upgrade_complete', t.x, t.y);
                            if (t.updateTextCache) t.updateTextCache(); else updateItemTextCache(t);
                            _requestAdjacencyRecalcForThing(t, 1);
                            recalculateAdjacency();
                            if (!t.underConstruction && !t.isUpgrading && !t.isStacking) {
                                _builderRememberWorkSite(u, t);
                                _clearWorkerTarget(u);
                                _builderFindTarget(u, myGx, myGy);
                            }
                        }
                    } else if (t.isStacking) {
                        let stackCost = getThingStackingEnergyCost(t);
                        t.stackingWorkDone = Math.max(0, Number(t.stackingWorkDone) || 0) + dps;
                        didWork = true;

                        let stackedAny = false;
                        while (t.stackingWorkDone >= stackCost && getThingRemainingStacks(t) > 0) {
                            // Don't stack if it would exceed researched max level
                            let nextStackLevel = stackCountToLevel(getThingStackedStacks(t) + 1);
                            let maxLevel = getThingResearchedMaxLevel(t);
                            if (nextStackLevel > maxLevel) break;
                            
                            t.stackingWorkDone -= stackCost;
                            t.stacks = getThingStackedStacks(t) + 1;
                            stackedAny = true;
                        }
                        if (stackedAny) {
                            if (t.updateTextCache) t.updateTextCache(); else updateItemTextCache(t);
                            _requestAdjacencyRecalcForThing(t, 1);
                            recalculateAdjacency();
                        }
                        refreshThingProgressState(t);
                        if (!t.underConstruction && !t.isUpgrading && !t.isStacking) {
                            _builderRememberWorkSite(u, t);
                            _clearWorkerTarget(u);
                            _builderFindTarget(u, myGx, myGy);
                        }
                    } else if (_isBuilderRepairTarget(t)) {
                        t.energy = Math.round(Math.min(t.maxEnergy, t.energy + dps) * 1000) / 1000;
                        didWork = true;
                        if (!_isBuilderRepairTarget(t)) {
                            _builderRememberWorkSite(u, t);
                            _clearWorkerTarget(u);
                            _builderFindTarget(u, myGx, myGy);
                        }
                    }

                    if (didWork) {
                        u.builderHasMaterial = false;
                        u.workerTransferCooldown = getBuilderTransferCooldownTicks(u);
                        if (t.owner === localPlayerId && _noteAmbientSoundTick(t, 'builder_work', 10)) playSound('builder_work', t.x, t.y);
                    }

                    if (u.workerTarget) {
                        // Not done yet - loop back to spawner for more gold, then come back
                        let route = _workerSpawnerRoute(u, 'builder_spawner', _builderCanWalk(u.owner), canRunHeavyAi);
                        let tripCost = getBuilderTripGoldCost(u);
                        if (route) {
                            u.workerState = 'RETURNING_FOR_GOLD';
                            u.path = route.path;
                            u.pathIndex = 0; u.commandState = CMD_MOVING;
                            u._builderSpawnerTarget = route.spawner;
                            u.targetPos = route.spawner ? { x: route.spawner.gx * TILE + 16, y: route.spawner.gy * TILE + 16 } : null;
                        } else {
                            // No spawner or no energy, just keep building for free (but slower)
                            u.workerState = 'BUILDING_IN_PLACE';
                        }
                    }
                }
            }
        } else if (u.workerState === 'RETURNING_FOR_GOLD') {
            // Safeguard: if we're actively moving to spawner with a valid path, stay in this state.
            if (u.path && u.pathIndex < u.path.length) {
                return;
            }
            if (!_isBuilderWorkTarget(u.workerTarget, owner)) {
                _builderRememberWorkSite(u);
                _clearWorkerTarget(u);
                _builderFindTarget(u, myGx, myGy);
                return;
            }
            if (!u.path || u.pathIndex >= u.path.length) {
                let spawner = u._builderSpawnerTarget || _findClosestBuilderSpawner(u);
                let atSpawner = !spawner || _isWorkerWithinTileInteractionRange(u, spawner, 1);
                if (atSpawner) {
                    if (u.workerTransferCooldown > 0) return;
                    let tripCost = getBuilderTripGoldCost(u);
                    if (spawner) {
                        addPlayerResource(owner, 'energy', -tripCost);
                        recordEnergyDelta(owner, 'builder', -tripCost);
                        u.builderHasMaterial = true;
                        u.workerTransferCooldown = getBuilderTransferCooldownTicks(u);
                    } else {
                        u._energyBlockedUntil = gameTime + _getEnergyBlockedGlyphTicks();
                    }
                    u._builderSpawnerTarget = null;
                    u.workerState = 'MOVING_TO_BUILD';
                    let canWalk = _builderCanWalk(u.owner);
                    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
                    u.path = _requestWorkerPath(u, startGx, startGy, u.workerTarget.gx, u.workerTarget.gy, canWalk, 'builder');
                    u.pathIndex = 0; u.commandState = CMD_MOVING;
                } else {
                    let route = _workerSpawnerRoute(u, 'builder_spawner', _builderCanWalk(u.owner), canRunHeavyAi);
                    if (route) {
                        u._builderSpawnerTarget = route.spawner;
                            u.targetPos = route.spawner ? { x: route.spawner.gx * TILE + 16, y: route.spawner.gy * TILE + 16 } : null;
                        u.path = route.path;
                        u.pathIndex = 0;
                        u.commandState = CMD_MOVING;
                    } else {
                        // If no valid material route exists, keep contributing on-site.
                        u._builderSpawnerTarget = null;
                        u.workerState = 'BUILDING_IN_PLACE';
                        u.commandState = CMD_IDLE;
                    }
                }
            }
        } else if (u.workerState === 'BUILDING_IN_PLACE') {
            // Build in place. Prefer full builder throughput when enough energy is available.
            if (!_isBuilderWorkTarget(u.workerTarget, owner)) {
                _builderRememberWorkSite(u);
                _clearWorkerTarget(u);
                _builderFindTarget(u, myGx, myGy);
                return;
            }

            if (!u.builderHasMaterial && u.workerTransferCooldown <= 0) {
                let tripCost = getBuilderTripGoldCost(u);
                addPlayerResource(owner, 'energy', -tripCost);
                recordEnergyDelta(owner, 'builder', -tripCost);
                u.builderHasMaterial = true;
                u.workerTransferCooldown = getBuilderTransferCooldownTicks(u);
            }

            let baseBuild = Number((BASE_UNIT_STATS[u.unitType] || {}).builderDps) || Number(UNIT_FORMULA_CONFIG.workerSpecialistBaseRate) || 1;
            let dps = Number((u.preComputed && u.preComputed.builderDps) || 0) || baseBuild;
            let buildStep = 0;
            if (u.builderHasMaterial) {
                buildStep = dps;
            } else if (gameTime % 20 === 0) {
                // Last-resort slow trickle when no full material transfer is possible.
                addPlayerResource(owner, 'energy', -1);
                recordEnergyDelta(owner, 'builder', -1);
                buildStep = 1;
            }

            if (buildStep > 0) {
                let t = u.workerTarget;
                if (t.underConstruction) {
                    let requiredEnergy = _getBuilderProgressRequiredEnergy(t);
                    t.maxEnergy = requiredEnergy;
                    t.energy = Math.round(Math.min(requiredEnergy, t.energy + buildStep) * 1000) / 1000;
                    if (t.energy >= requiredEnergy) {
                        markConstructionComplete(t);
                        refreshThingProgressState(t);
                        if (t.owner === localPlayerId) playSound('build_complete', t.x, t.y);
                        _requestAdjacencyRecalcForThing(t, 1);
                        recalculateAdjacency();
                        _builderRememberWorkSite(u, t);
                        if (!t.underConstruction && !t.isUpgrading && !t.isStacking) {
                            _clearWorkerTarget(u);
                            _builderFindTarget(u, myGx, myGy);
                        }
                    }
                } else if (t.isUpgrading) {
                    let requiredEnergy = _getBuilderProgressRequiredEnergy(t);
                    t.upgrademaxEnergy = requiredEnergy;
                    t.maxEnergy = requiredEnergy;
                    t.energy = Math.round(Math.min(requiredEnergy, t.energy + buildStep) * 1000) / 1000;
                    if (t.energy >= requiredEnergy) {
                        let prevStacked = getThingStackedStacks(t);
                        let prevManual = getThingManualStacks(t);
                        let remainingBeforeUpgrade = Math.max(0, prevManual - prevStacked);
                        let nextLevel = getThingBaseLevel(t) + 1;
                        t.level = nextLevel;
                        if (typeof upkeepThingDirty === 'function') upkeepThingDirty(t);
                        t.stacks = Math.max(prevStacked, getRequiredStacksForLevel(nextLevel));
                        t.manualStacks = Math.max(prevManual, t.stacks + remainingBeforeUpgrade);

                        t.isUpgrading = false;
                        t.upgrademaxEnergy = 0;
                        refreshThingProgressState(t);
                        if (t.owner === localPlayerId) playSound('upgrade_complete', t.x, t.y);
                        if (t.updateTextCache) t.updateTextCache(); else updateItemTextCache(t);
                        _requestAdjacencyRecalcForThing(t, 1);
                        recalculateAdjacency();
                        if (!t.underConstruction && !t.isUpgrading && !t.isStacking) {
                            _builderRememberWorkSite(u, t);
                            _clearWorkerTarget(u);
                            _builderFindTarget(u, myGx, myGy);
                        }
                    }
                } else if (t.isStacking) {
                    let stackCost = getThingStackingEnergyCost(t);
                    t.stackingWorkDone = Math.max(0, Number(t.stackingWorkDone) || 0) + buildStep;
                    let stackedAny = false;
                    while (t.stackingWorkDone >= stackCost && getThingRemainingStacks(t) > 0) {
                        // Don't stack if it would exceed researched max level
                        let nextStackLevel = stackCountToLevel(getThingStackedStacks(t) + 1);
                        let maxLevel = getThingResearchedMaxLevel(t);
                        if (nextStackLevel > maxLevel) break;
                        
                        t.stackingWorkDone -= stackCost;
                        t.stacks = getThingStackedStacks(t) + 1;
                        stackedAny = true;
                    }
                    if (stackedAny) {
                        if (t.updateTextCache) t.updateTextCache(); else updateItemTextCache(t);
                        _requestAdjacencyRecalcForThing(t, 1);
                        recalculateAdjacency();
                    }
                    refreshThingProgressState(t);
                    if (!t.underConstruction && !t.isUpgrading && !t.isStacking) {
                        _builderRememberWorkSite(u, t);
                        _clearWorkerTarget(u);
                        _builderFindTarget(u, myGx, myGy);
                    }
                } else if (_isBuilderRepairTarget(t)) {
                    t.energy = Math.round(Math.min(t.maxEnergy, t.energy + buildStep) * 1000) / 1000;
                    if (!_isBuilderRepairTarget(t)) {
                        _builderRememberWorkSite(u, t);
                        _clearWorkerTarget(u);
                        _builderFindTarget(u, myGx, myGy);
                    }
                }
                if (u.builderHasMaterial) u.builderHasMaterial = false;
                if (t.owner === localPlayerId && _noteAmbientSoundTick(t, 'builder_work', 10)) playSound('builder_work', t.x, t.y);
            }
            // Check if energy became available - switch back to gold trips
            let route = _workerSpawnerRoute(u, 'builder_spawner', _builderCanWalk(u.owner), canRunHeavyAi);
            if (route && u.workerTarget) {
                u.workerState = 'RETURNING_FOR_GOLD';
                u.path = route.path;
                u.pathIndex = 0; u.commandState = CMD_MOVING;
                u._builderSpawnerTarget = route.spawner;
                            u.targetPos = route.spawner ? { x: route.spawner.gx * TILE + 16, y: route.spawner.gy * TILE + 16 } : null;
            }
        }
    } else if (u.workerType === 'healer') {
        if (u.workerState === 'IDLE') {
            if (!_workerRunHealerRetargetIfDue(u, canRunHeavyAi, myGx, myGy)) return;
        } else if (u.workerState === 'MOVING_TO_HEAL') {
            let targetIsQueue = (u.workerTargetType === 'queue');
            if (targetIsQueue ? !_isHealerQueueTarget(u.workerTarget, owner) : !_isHealerTargetUnit(u.workerTarget, owner)) {
                if (targetIsQueue) _clearHealerQueueCommit(u);
                _clearWorkerTarget(u, 'target_no_work');
                if (!_workerRunHealerRetargetIfDue(u, canRunHeavyAi, myGx, myGy)) {
                    u.workerState = 'IDLE';
                    u.commandState = CMD_IDLE;
                }
                return;
            }
            if (!u.path || u.pathIndex >= u.path.length) {
                let tx = _thingTickX(u.workerTarget), ty = _thingTickY(u.workerTarget);
                let inHealRange = _isWorkerWithinTileInteractionRange(u, u.workerTarget, 1);
                if (!inHealRange) {
                    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
                    let targetGx = Math.floor(tx / TILE), targetGy = Math.floor(ty / TILE);
                    u.path = _requestWorkerPath(u, startGx, startGy, targetGx, targetGy, null, null);
                    u.pathIndex = 0;
                    u.commandState = CMD_MOVING;
                    return;
                }
                if (!u.healerHasMaterial) {
                    let route = _workerSpawnerRoute(u, 'healer_spawner', null, canRunHeavyAi);
                    if (route) {
                        u.workerState = 'RETURNING_FOR_GOLD';
                        u.path = route.path;
                        u.pathIndex = 0; u.commandState = CMD_MOVING;
                        u._healerSpawnerTarget = route.spawner;
                        u.targetPos = route.spawner ? { x: route.spawner.gx * TILE + 16, y: route.spawner.gy * TILE + 16 } : null;
                    } else {
                        u.workerState = 'IDLE';
                        u.commandState = CMD_IDLE;
                    }
                    return;
                }
                if (u.workerTransferCooldown > 0) return;

                if (targetIsQueue) {
                    let sp = u.workerTarget;
                    let fallbackType = getSpawnerFallbackUnitType(sp);
                    let effLvl = getThingBaseLevel(sp);
                    let front = getQueuedSpawnInfo(sp.spawnQueue[0], fallbackType, effLvl, owner);
                    let didWork = false;
                    let healWork = Math.max(1, Math.floor(Number(u._healerQueueTripCost) || Math.round(Number((u.preComputed && u.preComputed.healerDps) || 1))));

                    if (front.energyPaid < front.energyRequired) {
                        front.energyPaid = Math.min(front.energyRequired, front.energyPaid + healWork);
                        didWork = true;
                    }
                    sp.spawnQueue[0] = front;
                    if (didWork && typeof spawnerProductionChanged === 'function') spawnerProductionChanged(sp);

                    if (didWork) {
                        u.healerHasMaterial = false;
                        u._healerQueueTripCost = 0;
                        u.workerTransferCooldown = getWorkerTypeTransferCooldownTicks('healer', u);
                        if (sp.owner === localPlayerId && _noteAmbientSoundTick(sp, 'heal_tick', 12)) playSound('heal_tick', sp.x, sp.y);
                    }

                    let cooldown = Math.max(1, Math.round(sp.spawnCooldown || 1));
                    if (sp.spawnTimer >= cooldown && front.energyPaid >= front.energyRequired && !Number.isFinite(sp._spawnReadyOrder)) {
                        sp._spawnReadyOrder = globalSpawnerReadyOrderCounter++;
                        if (typeof spawnerReadyNoted === 'function') spawnerReadyNoted(sp);
                    }

                    if (!_isHealerQueueTarget(sp, owner)) {
                        _clearWorkerTarget(u, 'target_no_work');
                        if (!_workerRunHealerRetargetIfDue(u, canRunHeavyAi, myGx, myGy)) {
                            u.workerState = 'IDLE';
                            u.commandState = CMD_IDLE;
                        }
                        return;
                    }

                    let route = _workerSpawnerRoute(u, 'healer_spawner', null, canRunHeavyAi);
                    let tripCost = _getHealerQueueTripCost(u, sp);
                    if (route && tripCost > 0) {
                        u.workerState = 'RETURNING_FOR_GOLD';
                        u.path = route.path;
                        u.pathIndex = 0; u.commandState = CMD_MOVING;
                        u._healerSpawnerTarget = route.spawner;
                        u.targetPos = route.spawner ? { x: route.spawner.gx * TILE + 16, y: route.spawner.gy * TILE + 16 } : null;
                        u._healerQueueTripCost = tripCost;
                    } else {
                        u.workerState = 'IDLE';
                        u.commandState = CMD_IDLE;
                    }
                    return;
                }

                u.workerState = 'HEALING';
                let baseHeal = Number((BASE_UNIT_STATS[u.unitType] || {}).healerDps) || Number(UNIT_FORMULA_CONFIG.workerSpecialistBaseRate) || 1;
                let dps = Number((u.preComputed && u.preComputed.healerDps) || 0) || baseHeal;
                u.workerTarget.energy = Math.min(u.workerTarget.maxEnergy, u.workerTarget.energy + dps);
                u.healerHasMaterial = false;
                u.workerTransferCooldown = getWorkerTypeTransferCooldownTicks('healer', u);
                if (u.workerTarget.owner === localPlayerId && _noteAmbientSoundTick(u.workerTarget, 'heal_tick', 12)) playSound('heal_tick', u.workerTarget.x, u.workerTarget.y);

                if (!_isHealerTargetUnit(u.workerTarget, owner)) {
                    _clearWorkerTarget(u, 'target_no_work');
                    if (!_workerRunHealerRetargetIfDue(u, canRunHeavyAi, myGx, myGy)) {
                        u.workerState = 'IDLE';
                        u.commandState = CMD_IDLE;
                    }
                    return;
                }

                let route = _workerSpawnerRoute(u, 'healer_spawner', null, canRunHeavyAi);
                if (route) {
                    u.workerState = 'RETURNING_FOR_GOLD';
                    u.path = route.path;
                    u.pathIndex = 0; u.commandState = CMD_MOVING;
                    u._healerSpawnerTarget = route.spawner;
                        u.targetPos = route.spawner ? { x: route.spawner.gx * TILE + 16, y: route.spawner.gy * TILE + 16 } : null;
                } else {
                    u.workerState = 'IDLE';
                    u.commandState = CMD_IDLE;
                }
            }
        } else if (u.workerState === 'RETURNING_FOR_GOLD') {
            // Safeguard: if we're actively moving to spawner with a valid path, stay in this state.
            if (u.path && u.pathIndex < u.path.length) {
                return;
            }
            let targetIsQueue = (u.workerTargetType === 'queue');
            if (targetIsQueue ? !_isHealerQueueTarget(u.workerTarget, owner) : !_isHealerTargetUnit(u.workerTarget, owner)) {
                if (targetIsQueue) _clearHealerQueueCommit(u);
                _clearWorkerTarget(u, 'target_no_work');
                u._healerQueueTripCost = 0;
                if (!_workerRunHealerRetargetIfDue(u, canRunHeavyAi, myGx, myGy)) {
                    u.workerState = 'IDLE';
                    u.commandState = CMD_IDLE;
                }
                return;
            }
            if (!u.path || u.pathIndex >= u.path.length) {
                let spawner = u._healerSpawnerTarget || _findClosestHealerSpawner(u);
                let atSpawner = !spawner || _isWorkerWithinTileInteractionRange(u, spawner, 1);
                if (atSpawner) {
                    if (u.workerTransferCooldown > 0) return;
                    let tripCost = targetIsQueue ? _getHealerQueueTripCost(u, u.workerTarget) : 1;
                    if (spawner && tripCost > 0) {
                        addPlayerResource(owner, 'energy', -tripCost);
                        recordEnergyDelta(owner, 'healer', -tripCost);
                        u.healerHasMaterial = true;
                        u._healerQueueTripCost = targetIsQueue ? tripCost : 0;
                        u.workerTransferCooldown = getWorkerTypeTransferCooldownTicks('healer', u);
                    } else if (tripCost > 0) {
                        u._energyBlockedUntil = gameTime + _getEnergyBlockedGlyphTicks();
                    }
                    u._healerSpawnerTarget = null;
                    u.workerState = 'MOVING_TO_HEAL';
                    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
                    let targetGx = Math.floor(_thingTickX(u.workerTarget) / TILE), targetGy = Math.floor(_thingTickY(u.workerTarget) / TILE);
                    u.path = _requestWorkerPath(u, startGx, startGy, targetGx, targetGy, null, null);
                    u.pathIndex = 0; u.commandState = CMD_MOVING;
                } else {
                    let route = _workerSpawnerRoute(u, 'healer_spawner', null, canRunHeavyAi);
                    if (route) {
                        u._healerSpawnerTarget = route.spawner;
                        u.targetPos = route.spawner ? { x: route.spawner.gx * TILE + 16, y: route.spawner.gy * TILE + 16 } : null;
                        u.path = route.path;
                        u.pathIndex = 0;
                        u.commandState = CMD_MOVING;
                    } else {
                        u._healerSpawnerTarget = null;
                        u.workerState = 'IDLE';
                        u.commandState = CMD_IDLE;
                    }
                }
            }
        } else if (u.workerState === 'HEALING') {
            u.workerState = 'MOVING_TO_HEAL';
        }
    } else if (u.workerType === 'researcher') {
        if (u.workerState === 'IDLE') {
            if (_wsRegistered(u)) return;
            if (!shouldRunWorkerIdleRetarget(u, canRunHeavyAi)) return;
            _researcherSearch(u);
        } else if (u.workerState === 'MOVING_TO_RESEARCH' || u.workerState === 'RESEARCHING' || u.workerState === 'RETURNING_FOR_GOLD') {
            // (Researchers carry nothing: an older material trip goes back to
            // its research building.)
            if (u.workerState !== 'MOVING_TO_RESEARCH') { u.workerState = 'MOVING_TO_RESEARCH'; u.path = null; u.pathIndex = 0; }
            if (!_isResearcherTargetBuilding(u.workerTarget, owner)) {
                _clearWorkerTarget(u, 'target_no_work');
                u.workerState = 'IDLE';
                u.commandState = CMD_IDLE;
                return;
            }
            if (!u.path || u.pathIndex >= u.path.length) {
                let target = u.workerTarget;
                if (!_isWorkerWithinTileInteractionRange(u, target, 1)) {
                    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
                    u.path = _requestWorkerPath(u, startGx, startGy, target.gx, target.gy, null, null);
                    u.pathIndex = 0;
                    u.commandState = CMD_MOVING;
                    return;
                }
                // At its research building: a deposit every cooldown.
                if (u.workerTransferCooldown > 0) return;
                _researcherDeposit(u, target, owner);
                u.commandState = CMD_IDLE;
            }
        }
    }
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
// later, which hands each worker that found something its result (by unit
// id: _wsTakeNow, the sites still valid, the first exclusive one, O(K)); a
// worker that found nothing costs the tick nothing. Every peer posts and
// commits at the same ticks; a resync drops it all (and the registry) on
// every peer.
const WS_TICKS = 4, WS_POST_PHASE = 3, WS_K = 6, WS_RETRY = 20, WS_SEL_CHUNK = 4096;
const WS_LANE = typeof SIM_LANE_T1 === 'number' ? SIM_LANE_T1 : 4;
const WS_COLLECT = 1, WS_GRID = 3;
// Registry kinds (unit.wsKind): a collector, a builder or salvager (the
// grid), a healer (the grid's queues and damaged units), a researcher (the
// grid, by its owner's research).
const WSR_COLLECT = 1, WSR_GRID = 3, WSR_HEAL = 4, WSR_RESEARCH = 5;
// (A search's answer: registered, wait for it.)
const WS_WAITING = Object.freeze({ wsWaiting: true });
let _wsPosted = null, _wsResults = new Map(), _wsCommitTick = -1, _wsStepTick = -1, _wsInCommit = false, _wsPending = null;
// (The commit's takes are spread over this many ticks.)
const WS_TAKE_TICKS = 3;
const _wsGroups = new Map();
function _wsAvailable() { return typeof SIM_KERNEL_WS_SCAN === 'number' && typeof simParallelBackground === 'function' && typeof _simUnitState !== 'undefined' && !!_simUnitState; }
function _wsRegistered(u) { const c = u && u._us; return !!c && c.wsKind[u._si] !== 0 && _wsAvailable(); }
// u's search into the registry (kind, req: owner's grid needs and the
// rest); at a commit (a search that found nothing valid) not as a fresh one.
function wsRegister(u, kind, req) {
    const c = u._us, s = u._si;
    c.wsKind[s] = kind; c.wsT[s] = _wsInCommit ? gameTime - WS_TICKS : gameTime;
    c.wsCfg[s] = Number.isFinite(req.cfg) ? req.cfg : -1; c.wsOU[s] = Number.isFinite(req.ou) ? req.ou : 0;
    c.wsOx[s] = Number.isFinite(req.ox) ? req.ox : NaN; c.wsOy[s] = Number.isFinite(req.oy) ? req.oy : NaN;
    c.wsR[s] = Number(req.r) || 0; c.wsAk[s] = Number.isFinite(req.areaSteps) ? Math.max(0, Math.min(127, Math.floor(req.areaSteps))) : -1;
    c.wsAx[s] = Number.isFinite(req.ax) ? req.ax : NaN; c.wsAy[s] = Number.isFinite(req.ay) ? req.ay : NaN;
    c.wsNeed[s] = req.need | 0; c.wsJid[s] = Number.isFinite(req.jid) ? req.jid : -1;
    c.wsCur[s] = Number.isFinite(req.cur) ? req.cur : -1; c.wsMy[s] = Number.isFinite(req.my) ? req.my : -1;
}
// u's committed result for this kind (its sites, best first), once; null
// when there is none (then register).
function wsTake(u, kind) {
    const r = _wsResults.get(u._si);
    if (!r || r.id !== u.id || r.kind !== kind || r.stamp !== _wsCommitTick) return null;
    _wsResults.delete(u._si);
    return r.res;
}
// A registered worker: idle, parked till the tier hands it work (see
// simMoveTryPark).
function _wsWait(u) {
    u.workerState = 'IDLE'; u.commandState = CMD_IDLE;
}
function workerSearchTierReset() {
    if (typeof simParallelBackgroundWait === 'function') simParallelBackgroundWait(WS_LANE);
    _wsPosted = null; _wsResults = new Map(); _wsCommitTick = -1; _wsStepTick = -1; _wsInCommit = false; _wsPending = null;
    _wsGroups.clear();
    _wsw = null; _wswDirty = []; _wswResvDirty = [];
    if (typeof _simUnitState !== 'undefined' && _simUnitState) _simUnitState.columns.wsKind.fill(0);
}
// Once a tick, before the unit pass: the commit, the grid's changes (while
// no search runs: phases 1 after the commit, 2, 3 before the post), the post.
function workerSearchTierStep() {
    if (_wsStepTick === gameTime || !_wsAvailable()) return;
    _wsStepTick = gameTime;
    const ph = gameTime % WS_TICKS;
    if (ph === (WS_POST_PHASE + 2) % WS_TICKS) _wsCommit();
    else if (_wsPending) _wsTakeSome();
    if (ph !== (WS_POST_PHASE + 1) % WS_TICKS) _wswStep((Math.floor(gameTime / WS_TICKS) * 3 + (ph + WS_TICKS - (WS_POST_PHASE + 2) % WS_TICKS) % WS_TICKS) % WSW_SWEEP);
    if (ph === WS_POST_PHASE) _wsPost();
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
// owned structure in turn, each once in WSW_SWEEP steps (60 ticks: work that
// comes and goes without an event: damage, upgrades due after research,
// queue payments). Made anew after a resync on every peer.
const WSW_BUILD = 1, WSW_SALVAGE = 2, WSW_QUEUE = 4, WSW_RESEARCH = 8, WSW_AUTORES = 16, WSW_NBITS = 5;
const WSW_SWEEP = 45, WSW_MAXOWN = 16;
let _wsw = null, _wswDirty = [], _wswResvDirty = [];
const _wswResMax = new Map();
// Construction done (the collectors' groups are made again; the grid's tile).
let _wsBuiltVer = 0;
function workSiteDirty(gx, gy) {
    if (_wsw && gx >= 0 && gy >= 0 && gx < _wsw.w && gy < _wsw.h) _wswDirty.push(gy * _wsw.w + gx);
}
function workSiteBuilt(item) {
    _wsBuiltVer = (_wsBuiltVer + 1) | 0;
    if (item) workSiteDirty(item.gx, item.gy);
}
// (As _isBuilderWorkTarget without its side effect, and the others' tests;
// the common cases first: no upgrade due while the effective level is not
// above the level.)
function _wswFlagsOf(e, o) {
    let f = 0;
    if (e.markedForSalvage) { if (getTileEntityRef(e.gx, e.gy) === e) f |= WSW_SALVAGE; }
    else if (e.underConstruction) { if (e.buildEnabled !== false) f |= WSW_BUILD; }
    else if (e.isUpgrading || e.isStacking) f |= WSW_BUILD;
    else if (e.energy > 0 && e.energy < e.maxEnergy) f |= WSW_BUILD;
    else if (e.autoUpgradeEnabled !== false && !(e.effectiveLevel <= e.level)) {
        // (_isBuilderUpgradeCandidate, the researched level once a step per
        // owner and building.)
        const base = getThingBaseLevel(e, stackCountToLevel(e.stacks || 1)), eff = getThingEffectiveLevel(e, base);
        if (eff > base) {
            const k = o + ':' + getThingResearchBuildingKey(e);
            let rmax = _wswResMax.get(k);
            if (rmax === undefined) _wswResMax.set(k, rmax = getThingResearchedMaxLevel(e));
            if (Math.min(eff, rmax) > base) f |= WSW_BUILD;
        }
    }
    const q = e.spawnQueue;
    if (q && q.length > 0 && _isHealerQueueTarget(e, o)) f |= WSW_QUEUE;
    if (e.type === 'research' && !e.markedForSalvage && e.energy > 0 && !e.underConstruction) { f |= WSW_RESEARCH; if (isAutoResearchEnabled(e)) f |= WSW_AUTORES; }
    return f;
}
function _wswResvOf(W, t) {
    const NT = Math.min(8, _WORKER_TARGET_LOAD_TYPE_COUNT), base = t * _WORKER_TARGET_LOAD_TYPE_COUNT;
    let rv = 0;
    for (let i = 0; i < NT; i++) { const r = workerReservedTiles[base + i]; if (r && !r.dead) rv |= 1 << i; }
    return rv;
}
// u's type's reservation bit (0: none), and the tile it holds reserved (-1).
function _wsResvBit(u) { const i = _workerTypeToLoadIndex(u.workerType); return i >= 0 && i < 8 ? 1 << i : 0; }
function _wsMyTile(u) {
    const slot = Number.isFinite(u._workerReservedTileIndex) ? Math.floor(u._workerReservedTileIndex) : -1;
    return slot >= 0 ? Math.floor(slot / _WORKER_TARGET_LOAD_TYPE_COUNT) : -1;
}
// Tile t's entries from its owned structure e (or none).
function _wswSet(W, t, e) {
    let f = 0, o = -1;
    if (e) { o = e.owner | 0; f = _wswFlagsOf(e, o); }
    const f0 = W.flags[t], o0 = W.own[t];
    // (No work, as before: nothing else to keep.)
    if (!f && !f0 && o === o0) return;
    if (f0 !== f || o0 !== o) {
        const gx = t % W.w, b = (((t - gx) / W.w >> 3) * W.bw + (gx >> 3)) * 8;
        for (let i = 0; i < WSW_NBITS; i++) {
            const m = 1 << i;
            if (f0 & m) { W.cnt[b + i]--; if (o0 >= 0 && o0 < WSW_MAXOWN) W.oc[o0 * 8 + i]--; }
            if (f & m) { W.cnt[b + i]++; if (o >= 0 && o < WSW_MAXOWN) W.oc[o * 8 + i]++; }
        }
        W.flags[t] = f; W.own[t] = o;
    }
    W.area[t] = f ? (Number.isFinite(e.areaId) ? Math.floor(e.areaId) : getAreaIdAtTile(e.gx, e.gy)) : -1;
    // (A site's reservations again: a reserver that died since.)
    if (f) W.resv[t] = _wswResvOf(W, t);
}
function _wswBuild() {
    const n = GRID_W * GRID_H, bw = Math.ceil(GRID_W / 8), bh = Math.ceil(GRID_H / 8);
    const W = _wsw = { w: GRID_W, h: GRID_H, n, bw, bh, set: _activeTileEntities, areaFor: areaIdGrid, resvFor: workerReservedTiles,
        flags: simSharedArray(Uint8Array, n), own: simSharedArray(Int8Array, n), area: simSharedArray(Int32Array, n), resv: simSharedArray(Uint8Array, n),
        cnt: simSharedArray(Int32Array, bw * bh * 8), oc: new Int32Array(WSW_MAXOWN * 8), cursor: { epoch: -1, pos: 0 } };
    W.own.fill(-1); W.area.fill(-1);
    for (const k of ['flags', 'own', 'area', 'resv', 'cnt']) simParallelBind('wsw.' + k, W[k]);
    tileEntityChangesSince(W.cursor);
    _wswDirty = []; _wswResvDirty = [];
    // Every live reservation, then every owned structure.
    const R = workerReservedTiles, NT = _WORKER_TARGET_LOAD_TYPE_COUNT;
    for (let slot = 0; slot < R.length; slot++) { const r = R[slot]; if (r && !r.dead) { const i = slot % NT; if (i < 8) W.resv[(slot - i) / NT] |= 1 << i; } }
    for (const e of _activeTileEntities) {
        if (!e || !(e.gx >= 0 && e.gy >= 0 && e.gx < GRID_W && e.gy < GRID_H)) continue;
        const t = e.gy * GRID_W + e.gx, x = _ownedStructureAtTile(t);
        if (x) _wswSet(W, t, x);
    }
}
// One step: the grid made (first, or after its sources were replaced), the
// journal's and marked tiles, reservations, and the sweep's share.
function _wswStep(step) {
    if (typeof _activeTileEntities === 'undefined' || typeof tileEntityChangesSince !== 'function') return;
    _wswResMax.clear();
    let W = _wsw;
    if (!W || W.w !== GRID_W || W.h !== GRID_H || W.set !== _activeTileEntities || W.areaFor !== areaIdGrid || W.resvFor !== workerReservedTiles) { _wswBuild(); return; }
    const ch = tileEntityChangesSince(W.cursor);
    if (ch === null) { _wswBuild(); return; }
    for (let i = 0; i < ch.length; i++) _wswSet(W, ch[i], _ownedStructureAtTile(ch[i]));
    if (_wswDirty.length) { const d = _wswDirty; _wswDirty = []; for (let i = 0; i < d.length; i++) _wswSet(W, d[i], _ownedStructureAtTile(d[i])); }
    if (_wswResvDirty.length) {
        const d = _wswResvDirty, NT = _WORKER_TARGET_LOAD_TYPE_COUNT;
        _wswResvDirty = [];
        for (let i = 0; i < d.length; i++) { const t = Math.floor(d[i] / NT); if (t < W.n) W.resv[t] = _wswResvOf(W, t); }
    }
    // The sweep: every owner's structure buckets k = step (mod WSW_SWEEP).
    const np = Math.max(1, Math.floor(Number(players && players.length) || 0));
    for (let o = 0; o < np; o++) {
        const buckets = _ownedStructureBuckets(o);
        if (!buckets) continue;
        for (let k = step; k < buckets.length; k += WSW_SWEEP) {
            const list = buckets[k];
            if (list) for (let i = 0; i < list.length; i++) { const e = list[i]; _wswSet(W, e.gy * GRID_W + e.gx, e); }
        }
    }
    // The collectors' sites' reservations again, in turn (a reserver that
    // died since).
    for (const G of _wsGroups.values()) {
        const SX = G.arrays.sx, SY = G.arrays.sy;
        for (let s = step; s < G.n; s += WSW_SWEEP) {
            const gx = Math.floor(SX[s] / TILE), gy = Math.floor(SY[s] / TILE);
            if (gx >= 0 && gy >= 0 && gx < W.w && gy < W.h) W.resv[gy * W.w + gx] = _wswResvOf(W, gy * W.w + gx);
        }
    }
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
function _wsGroupBuild(G, sites, spawners) {
    const n = sites.length, np = spawners.length, pre = 'wsg' + G.id + '.';
    const arr = (name, Type, len) => { let a = G.arrays[name]; if (!a || a.length < len) { a = G.arrays[name] = simSharedArray(Type, Math.max(64, len * 2)); simParallelBind(pre + name, a); } return a; };
    const SX = arr('sx', Float64Array, n), SY = arr('sy', Float64Array, n), ST = arr('st', Int32Array, n), SO = arr('so', Int32Array, n);
    const objs = new Array(n), types = new Array(n);
    for (let s = 0; s < n; s++) {
        const e = sites[s];
        objs[s] = e.o; types[s] = e.type; SX[s] = Number(e.o.x); SY[s] = Number(e.o.y); ST[s] = e.kind; SO[s] = Number.isFinite(e.owner) ? e.owner : -1;
    }
    const bcols = Math.ceil(GRID_W / WS_BUCKET), brows = Math.ceil(GRID_H / WS_BUCKET), nb = bcols * brows;
    const BS = arr('bs', Int32Array, nb), BC = arr('bc', Int32Array, nb), BI = arr('bi', Int32Array, n);
    BC.fill(0, 0, nb);
    const bk = s => Math.max(0, Math.min(brows - 1, Math.floor(SY[s] / TILE / WS_BUCKET))) * bcols + Math.max(0, Math.min(bcols - 1, Math.floor(SX[s] / TILE / WS_BUCKET)));
    for (let s = 0; s < n; s++) if (SX[s] === SX[s] && SY[s] === SY[s]) BC[bk(s)]++;
    let fill = 0;
    for (let b = 0; b < nb; b++) { BS[b] = fill; fill += BC[b]; BC[b] = 0; }
    for (let s = 0; s < n; s++) if (SX[s] === SX[s] && SY[s] === SY[s]) { const b = bk(s); BI[BS[b] + BC[b]++] = s; }
    const PGX = arr('pgx', Int32Array, np), PGY = arr('pgy', Int32Array, np), PO = arr('po', Int32Array, np), PID = arr('pid', Int32Array, np);
    const PX = arr('px', Float64Array, np), PY = arr('py', Float64Array, np);
    for (let p = 0; p < np; p++) { const sp = spawners[p]; PGX[p] = Math.floor(Number(sp.gx) || 0); PGY[p] = Math.floor(Number(sp.gy) || 0); PO[p] = Number.isFinite(sp.owner) ? sp.owner : -9; PID[p] = Number(sp.id) || 0; PX[p] = Number(sp.x); PY[p] = Number(sp.y); }
    const meta = arr('meta', Int32Array, 5);
    meta[0] = n; meta[1] = np; meta[2] = 1; meta[3] = bcols; meta[4] = brows;
    G.objs = objs; G.types = types; G.n = n;
}
function _wsCollectorGroup(cfg) {
    const key = 'c:' + cfg.collectorUnitKey;
    let G = _wsGroups.get(key);
    if (!G) { G = { id: _wsGroups.size, key, sig: null, arrays: {}, objs: [], types: [] }; _wsGroups.set(key, G); }
    const mines = _getResourceCollectorMineArray(cfg) || [], farms = _cellItemsOfType(cfg.farmKey);
    const sig = [mines.length, cfg.supportsDropTarget ? droppedItemsVersion : -1, farms.length, typeof collectorSpawnersVersion === 'number' ? collectorSpawnersVersion : -1, collectorSpawners.length, _wsBuiltVer];
    if (G.sig && G.mines === mines && G.farms === farms && G.spl === collectorSpawners && G.sig.every((v, i) => v === sig[i])) return G;
    G.sig = sig; G.mines = mines; G.farms = farms; G.spl = collectorSpawners;
    const sites = [], spawners = [];
    if (cfg.supportsDropTarget) for (const d of _droppedItemsForBuckets()) if (d) sites.push({ o: d, type: 'drop', kind: 0, owner: -1 });
    for (const m of mines) if (m && Number.isFinite(m[cfg.mineStatKey]) && m[cfg.mineStatKey] > 0) sites.push({ o: m, type: cfg.mineTileType, kind: 1, owner: -1 });
    for (const fm of farms) if (fm && fm.type === cfg.farmKey && !fm.underConstruction && fm.energy > 0) sites.push({ o: fm, type: cfg.farmKey, kind: 2, owner: fm.owner });
    for (const sp of _getWorkerSpawnersByType(cfg.collectorBuildingKey)) if (sp && sp.type === cfg.collectorBuildingKey && sp.energy > 0 && !sp.underConstruction) spawners.push(sp);
    _wsGroupBuild(G, sites, spawners);
    return G;
}
function _wsArr(name, Type, n) {
    let a = _simParReg[name];
    if (!a || a.constructor !== Type || a.length < n) { a = simSharedArray(Type, Math.max(256, n * 2)); simParallelBind(name, a); }
    return a;
}
function _wsPost() {
    simParallelBackgroundWait(WS_LANE);
    _wsPosted = null;
    const S = _simUnitState;
    if (!S) return;
    const n = S.owners.length;
    if (!n) return;
    const CH = WS_SEL_CHUNK, chunks = Math.ceil(n / CH), cap = chunks * CH;
    for (const k of ['ws.rslot', 'ws.rid', 'ws.rwt', 'ws.rkind', 'ws.rowner', 'ws.rak', 'ws.rgrp', 'ws.rneed', 'ws.rjid', 'ws.rcur', 'ws.rmy']) _wsArr(k, Int32Array, cap);
    for (const k of ['ws.rox', 'ws.roy', 'ws.rux', 'ws.ruy', 'ws.rr', 'ws.rax', 'ws.ray']) _wsArr(k, Float64Array, cap);
    const CNT = _wsArr('ws.rcnt', Int32Array, chunks), PRE = _wsArr('ws.rpre', Int32Array, chunks + 1);
    _wsArr('ws.res', Int32Array, cap * WS_K); _wsArr('ws.score', Float64Array, cap * WS_K); _wsArr('ws.ures', Int32Array, cap * 3);
    // The registered workers due (the kernel, from their columns).
    const P = _simParams;
    P[0] = n; P[1] = CH; P[2] = gameTime; P[3] = WS_TICKS; P[4] = WS_RETRY;
    simParallelRun(SIM_KERNEL_WS_SELECT, chunks);
    let total = 0;
    for (let c = 0; c < chunks; c++) { PRE[c] = total; total += CNT[c]; }
    PRE[chunks] = total;
    if (!total) return;
    const Bp = _simBgParamsByLane[WS_LANE];
    // The collectors' groups, per resource type.
    const groups = [];
    for (let k = 0; k < RESOURCE_TYPE_LIST.length && k < 8; k++) { const G = _wsCollectorGroup(RESOURCE_TYPE_LIST[k]); groups[k] = { objs: G.objs, types: G.types }; Bp[16 + k] = G.id; }
    // Per owner: its healers' damaged units (where they are now) and the
    // research its researchers serve.
    const np = Math.max(1, Math.floor(Number(players && players.length) || 0)), HM = HEALER_DAMAGED_CANDIDATE_LIMIT;
    const HX = _wsArr('wsh.x', Float64Array, np * HM), HY = _wsArr('wsh.y', Float64Array, np * HM), HA = _wsArr('wsh.a', Int32Array, np * HM), HN = _wsArr('wsh.n', Int32Array, np);
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
    Bp[10] = _wsw ? _wsw.bw : 0; Bp[11] = chunks; Bp[12] = CH; Bp[13] = HM;
    simParallelBackground(SIM_KERNEL_WS_SCAN, Math.ceil(total / 16), WS_LANE);
    _wsPosted = { chunks, CH, groups, heal };
}
// A worker's take of its result (its type's search function, which finds
// the result: wsTake).
function _wsTakeNow(u) {
    const gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE), wt = u.workerType;
    if (isResourceCollectorWorkerType(wt)) { const cfg = _getResourceCollectorConfigForUnit(u); if (cfg) _resourceCollectorFindTarget(u, gx, gy, cfg); }
    else if (wt === 'builder') _builderFindTarget(u, gx, gy);
    else if (wt === 'salvager') _salvagerFindTarget(u, gx, gy);
    else if (wt === 'healer') _healerFindTarget(u, gx, gy);
    else if (wt === 'researcher') _researcherSearch(u);
}
function _wsCommit() {
    if (!_wsPosted) return;
    simParallelBackgroundWait(WS_LANE);
    const J = _wsPosted;
    _wsPosted = null;
    const S = _simUnitState;
    if (!S) return;
    const c = S.columns, owners = S.owners, R = _simParReg, K = WS_K;
    const OUT = R['ws.res'], OSC = R['ws.score'], UOUT = R['ws.ures'], CNT = R['ws.rcnt'], RS = R['ws.rslot'], RID = R['ws.rid'], RWT = R['ws.rwt'], RK = R['ws.rkind'], RG = R['ws.rgrp'], RO = R['ws.rowner'];
    _wsCommitTick = gameTime;
    // The workers that found something, still registered as when selected,
    // in id order.
    const found = [];
    for (let ch = 0; ch < J.chunks; ch++) for (let m = 0, e = CNT[ch]; m < e; m++) {
        const i = ch * J.CH + m, kind = RK[i];
        if (OUT[i * K] < 0 && !(kind === WSR_HEAL && UOUT[i * 3] >= 0)) continue;
        const s = RS[i], u = owners[s];
        if (!u || u.dead || (u.id | 0) !== RID[i] || c.wsKind[s] !== kind || c.wsT[s] !== RWT[i]) continue;
        found.push(i);
    }
    if (!found.length) return;
    found.sort((a, b) => RID[a] - RID[b]);
    // The takes: a share a tick, this one and the next WS_TAKE_TICKS - 1
    // (the last before the next post), in id order.
    _wsPending = { J, found, pos: 0, end: gameTime + WS_TAKE_TICKS - 1 };
    _wsTakeSome();
}
function _wsTakeSome() {
    const Q = _wsPending, S = _simUnitState;
    if (!Q || !S) { _wsPending = null; return; }
    const J = Q.J, c = S.columns, owners = S.owners, R = _simParReg, K = WS_K;
    const OUT = R['ws.res'], OSC = R['ws.score'], UOUT = R['ws.ures'], RS = R['ws.rslot'], RID = R['ws.rid'], RWT = R['ws.rwt'], RK = R['ws.rkind'], RG = R['ws.rgrp'], RO = R['ws.rowner'];
    const found = Q.found, end = Math.min(found.length, Q.pos + Math.ceil((found.length - Q.pos) / Math.max(1, Q.end - gameTime + 1)));
    _wsInCommit = true;
    try {
        for (; Q.pos < end; Q.pos++) {
            const i = found[Q.pos];
            const s = RS[i], u = owners[s], kind = RK[i], o0 = i * K, res = [];
            if (!u || u.dead || (u.id | 0) !== RID[i] || c.wsKind[s] !== kind || c.wsT[s] !== RWT[i]) continue;
            if (kind === WSR_COLLECT) {
                const G = J.groups[RG[i]];
                if (!G) continue;
                for (let k = 0; k < K; k++) { const x = OUT[o0 + k]; if (x < 0) break; res.push({ target: G.objs[x], targetType: G.types[x], dist: OSC[o0 + k] }); }
            } else for (let k = 0; k < K; k++) { const x = OUT[o0 + k]; if (x < 0) break; res.push({ site: x, dist: OSC[o0 + k] }); }
            let units = null;
            if (kind === WSR_HEAL) { units = []; const L = J.heal[RO[i]] || []; for (let k = 0; k < 3; k++) { const q = UOUT[i * 3 + k]; if (q >= 0 && L[q]) units.push(L[q]); } }
            _wsResults.set(s, { id: u.id, kind: kind === WSR_COLLECT ? WS_COLLECT : WS_GRID, stamp: _wsCommitTick, res, units });
            _wsTakeNow(u);
            _wsResults.delete(s);
        }
    } finally { _wsInCommit = false; }
    if (Q.pos >= found.length) _wsPending = null;
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
                r: _getWorkerAutoSearchDistancePx(u), ax: anchor ? anchor.x : NaN, ay: anchor ? anchor.y : NaN });
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
        if (!Number.isFinite(originDistSq) || originDistSq > maxSearchPxSq) return;
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
    let minGx = Math.max(0, Math.floor((origin.x - maxSearchPx) / TILE));
    let maxGx = Math.min(GRID_W - 1, Math.floor((origin.x + maxSearchPx) / TILE));
    let minGy = Math.max(0, Math.floor((origin.y - maxSearchPx) / TILE));
    let maxGy = Math.min(GRID_H - 1, Math.floor((origin.y + maxSearchPx) / TILE));
    if (resourceCfg.supportsDropTarget) {
        _forEachStructureInTileBox(_droppedItemsForBuckets(), minGx, minGy, maxGx, maxGy, (drop) => considerCandidate(drop, 'drop', TILE * 0.5));
    }

    let mineArray = _getResourceCollectorMineArray(resourceCfg) || [];
    // Only mines inside the search box can pass considerCandidate; visit
    // those via a static bucket index, still in mine array order.
    for (let index of _getMineIndicesNear(mineArray, origin.x, origin.y, maxSearchPx)) {
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

function _updateResourceCollectorAI(u, owner, myGx, myGy, canRunHeavyAi) {
    let resourceCfg = _getResourceCollectorConfigForUnit(u);
    if (!resourceCfg) return;
    let mem = _getResourceCollectorMemory(u);
    if (u.workerState === 'IDLE') {
        if (!u._lastIdleStateTime || u.workerState !== 'IDLE') u._lastIdleStateTime = gameTime;
        // (Registered: the tier hands it its work.)
        if (_wsRegistered(u)) return;
        if (!shouldRunWorkerIdleRetarget(u, canRunHeavyAi)) return;
        _resourceCollectorFindTarget(u, myGx, myGy, resourceCfg);
        return;
    }
    if (u.workerState === 'MOVING_TO' || u.workerState === 'MOVING_TO_ASTAR') {
        u._lastIdleStateTime = 0;
        if (!u.workerTarget || !_workerOwnsReservedTarget(u)) {
            _clearWorkerTarget(u, 'target_missing');
            _clearWorkerAutoRoute(u);
            _resourceCollectorFindTarget(u, myGx, myGy, resourceCfg);
            return;
        }
        if (!_isResourceCollectorTargetValid(u.workerTarget, u.workerTargetType, owner, resourceCfg)) {
            _clearWorkerTarget(u, 'target_no_work');
            _resourceCollectorFindTarget(u, myGx, myGy, resourceCfg);
            return;
        }
        if (!u.path || u.pathIndex >= u.path.length) {
            if (_workerHasPendingAutoRouteToTarget(u)) return;
            let inGatherRange = _isWorkerWithinTileInteractionRange(u, u.workerTarget, 1);
            if (inGatherRange) {
                if (u.workerTransferCooldown > 0) return;
                if (u.workerTargetType === 'drop') {
                    u.carryingValue = u.workerTarget.value;
                    removeDroppedItem(u.workerTarget);
                } else {
                    let gatherPerTrip = _resourceCollectorGetGatherPerTrip(u, owner);
                    if (u.workerTargetType === resourceCfg.farmKey) {
                        let farmLvl = getThingBaseLevel(u.workerTarget, stackCountToLevel(u.workerTarget.stacks || 1));
                        let mult = getBuildingStatForOwner(owner, resourceCfg.farmKey, farmLvl, 'multiplier');
                        if (!Number.isFinite(mult) || mult <= 0) mult = Math.max(1, farmLvl);
                        u.carryingValue = Math.floor(Math.max(1, gatherPerTrip * mult));
                    } else {
                        // Floor extract to integer — float gatherPerTrip (from level-scaling Math.pow)
                        // would leave a fractional mine value; Math.floor in the digest would then diverge
                        // between clients if their accumulated floats differ even slightly.
                        let extract = Math.floor(Math.min(gatherPerTrip, Math.max(0, Number(u.workerTarget[resourceCfg.mineStatKey]) || 0)));
                        u.workerTarget[resourceCfg.mineStatKey] -= extract;
                        u.carryingValue = extract;
                        // Keep static/background mine visuals in sync as mine values change.
                        let mine = u.workerTarget;
                        _markCombinedBgTileDirty(mine.gx, mine.gy, 0, true);
                        dirtyGrid = true;
                        if (u.workerTarget[resourceCfg.mineStatKey] <= 0) {
                            grid[mine.gy][mine.gx].type = TYPE_FLOOR;
                            simMoveTileTypeChanged(mine.gx, mine.gy);
                            _bumpPathTopologyVersion();
                            let mineArray = _getResourceCollectorMineArray(resourceCfg);
                            let idx = mineArray ? mineArray.indexOf(mine) : -1;
                            if (idx >= 0) mineArray.splice(idx, 1);
                            clearTileEntity(mine.gx, mine.gy, mine);
                            _markCombinedBgTileDirty(mine.gx, mine.gy, 0, true);
                            dirtyGrid = true;
                        }
                    }
                }
                if (owner === localPlayerId && u.workerTargetType !== 'drop') {
                    playSound(u.workerType === 'astar_collector' ? 'astar_work' : 'collector_work', u.x, u.y);
                }
                u.workerTransferCooldown = getWorkerTypeTransferCooldownTicks(u.workerType, u);
                _rememberResourceCollectorGatherSite(u, u.workerTarget, u.workerTargetType, resourceCfg);
                mem.lastMineTarget = (u.workerTargetType === resourceCfg.mineTileType) ? u.workerTarget : null;
                mem.lastMineTargetType = (u.workerTargetType === resourceCfg.mineTileType) ? u.workerTargetType : null;
                if (resourceCfg.stockpileKey === 'energy') u._lastMineTarget = mem.lastMineTarget;
                else if (resourceCfg.stockpileKey === 'astar') {
                    u._astarLastMineTarget = mem.lastMineTarget;
                    u._astarLastMineTargetType = mem.lastMineTargetType;
                }
                if (u.workerTargetType === 'drop') _clearWorkerTarget(u, 'target_missing');
                u.workerState = 'RETURNING';
                _workerReturnPath(u);
            } else {
                let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
                let canWalk = u.workerTargetType === resourceCfg.mineTileType ? _resourceCollectorCanWalk : null;
                u.path = _requestWorkerPath(u, startGx, startGy, u.workerTarget.gx, u.workerTarget.gy, canWalk, resourceCfg.collectorUnitKey, true);
                if (u.path) {
                    u.pathIndex = 0;
                    u.commandState = CMD_MOVING;
                } else {
                    _resourceCollectorFindTarget(u, myGx, myGy, resourceCfg);
                }
            }
        }
        return;
    }
    if (u.workerState === 'RETURNING' || u.workerState === 'RETURNING_ASTAR') {
        if (!u.path || u.pathIndex >= u.path.length) {
            let dropoff = _getResourceCollectorPreferredSpawner(u, resourceCfg.collectorBuildingKey) || _findClosestSpawner(u, resourceCfg.collectorBuildingKey);
            let isAtDropoff = !!dropoff && _isWorkerWithinTileInteractionRange(u, dropoff, 1);
            if (isAtDropoff && dropoff) {
                _setResourceCollectorLastDropoffSpawner(u, dropoff);
                _setResourceCollectorNextSpawner(u, dropoff);
            }
            if (u.carryingValue > 0 && !isAtDropoff) {
                _workerReturnPath(u);
                return;
            }
            if (u.carryingValue > 0 && isAtDropoff) {
                if (u.workerTransferCooldown > 0) return;
                _depositResourceCollectorPayload(u, owner, resourceCfg);
                u.workerTransferCooldown = getWorkerTypeTransferCooldownTicks(u.workerType, u);
            }
            u.carryingValue = 0;
            if (!canRunHeavyAi) return;
            if (_isResourceCollectorTargetValid(u.workerTarget, u.workerTargetType, owner, resourceCfg) && _workerOwnsReservedTarget(u)) {
                _resourceCollectorAssignTarget(u, u.workerTarget, u.workerTargetType, resourceCfg);
                return;
            }
            mem.lastMineTarget = null;
            mem.lastMineTargetType = null;
            u._lastMineTarget = null;
            u._astarLastMineTarget = null;
            u._astarLastMineTargetType = null;
            _clearWorkerTarget(u, 'target_no_work');
            _resourceCollectorFindTarget(u, myGx, myGy, resourceCfg);
        }
    }
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
    const gx = t % GRID_W, gy = (t - gx) / GRID_W, refs = tileEntityRef[gy], e = refs ? refs[gx] : null;
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

function _getResourceCollectorMemory(u) {
    if (!u) return null;
    if (!u._resourceCollectorMemory || typeof u._resourceCollectorMemory !== 'object') {
        u._resourceCollectorMemory = {
            pinnedTarget: null,
            pinnedTargetType: null,
            lastGatherX: null,
            lastGatherY: null,
            lastGatherGx: null,
            lastGatherGy: null,
            lastGatherType: null,
            nextSpawner: null,
            lastDropoffSpawner: null,
            lastMineTarget: null,
            lastMineTargetType: null,
        };
    }
    return u._resourceCollectorMemory;
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
        _workerWorkVer = simSharedArray(Int32Array, np * _WORKER_WORK_TYPES.length * (1 + rw * rh)); _workerWorkDims = dims;
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
    if (canRunHeavyAi && (Math.floor((gameTime + u.id) / delay) % Math.ceil(getWorkerIdleSearchTicks() / delay)) === 0) {
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
    let distArea = getUnitStatForOwner(u.owner, u.unitType, lvl, 'workerSearchDistance');
    let distTiles = Number(distArea) * AREA_UNIT_TILE_EQUIVALENT;
    if (!Number.isFinite(distTiles) || distTiles <= 0) distTiles = 10;
    return Math.max(TILE, distTiles * TILE);
}

function _getWorkerAutoSearchDistanceArea(u) {
    if (!u) return 2.0;
    let lvl = Math.max(1, getUnitEffectiveLevel(u, getUnitBaseLevel(u)));
    let distArea = getUnitStatForOwner(u.owner, u.unitType, lvl, 'workerSearchDistance');
    if (!Number.isFinite(distArea) || distArea <= 0) distArea = 2.0;
    return Math.max(0, distArea);
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
let workerReservedTiles = [];
// Every write goes through workerReservedSet: per snapshot region, the
// number of occupied slots (for the tick hash, which skips empty regions).
// Recounted when the table is replaced (_workerReservedCounts).
let _workerResCount = null, _workerResCountFor = null;
function workerReservedSet(slot, v) {
    const t = workerReservedTiles, old = t[slot];
    t[slot] = v;
    // (The work site grid's copy, at its next step.)
    if (_wsw && old !== v) _wswResvDirty.push(slot);
    if (_workerResCountFor === t && (!old) !== (!v)) _workerResCount[_snapReservationRegionIndex(slot)] += v ? 1 : -1;
}
function workerReservedCountsInvalidate() { _workerResCountFor = null; }
// The counts, current (null without the snapshot code).
function _workerReservedCounts() {
    const t = workerReservedTiles;
    if (_workerResCountFor === t) return _workerResCount;
    if (typeof _snapReservationRegionIndex !== 'function') return null;
    const n = _snapReservationRegionCount();
    if (!_workerResCount || _workerResCount.length !== n) _workerResCount = new Int32Array(n); else _workerResCount.fill(0);
    for (let s = 0; s < t.length; s++) if (t[s]) _workerResCount[_snapReservationRegionIndex(s)]++;
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
    let reservedUnit = workerReservedTiles[slotIndex];
    if (!reservedUnit || reservedUnit.dead) {
        if (slotIndex >= 0) workerReservedSet(slotIndex, null);
        return null;
    }
    return reservedUnit;
}

// Workers that may hold a target: collected from every unit when invalid
// (NaN: at first use, after the reservation table or the entities were
// replaced), then extended by _setWorkerTarget (the only place a target is
// set) and kept: a superset of the workers with a target. Callers only ask
// whether any conflicting worker exists, so order and history are
// irrelevant; entries are checked live. Compacted from its own entries
// (those still holding a target) once enough were added.
let _workersWithTargetTick = NaN, _workerConflictAdds = 0;
let _workersWithTarget = [];
let _workerConflictTiles = new Map();
let _workerMovingTargetConflicts = new Map();
let _workerConflictEntries = new Map();

function _indexWorkerTargetConflict(unit) {
    if (!unit.workerTarget) return;
    let entry = _workerConflictEntries.get(unit);
    if (!entry) {
        entry = { unit, order: _workerConflictEntries.size, slots: new Set(), moving: false };
        _workerConflictEntries.set(unit, entry);
        _workerConflictAdds++;
    }
    // Healers can target moving units. These must be tested live, even after
    // the target crossed a tile earlier in this same simulation tick.
    if (!Number.isFinite(unit.workerTarget.gx) || !Number.isFinite(unit.workerTarget.gy)) {
        if (!entry.moving) {
            entry.moving = true;
            let bucket = _workerMovingTargetConflicts.get(unit.workerType);
            if (!bucket) _workerMovingTargetConflicts.set(unit.workerType, bucket = []);
            bucket.push(entry);
        }
        return;
    }
    let slot = _getWorkerReservationSlotIndex(unit.workerTarget, unit.workerType);
    if (slot < 0 || entry.slots.has(slot)) return;
    entry.slots.add(slot);
    _workerConflictAdds++;
    let bucket = _workerConflictTiles.get(slot);
    if (!bucket) _workerConflictTiles.set(slot, bucket = []);
    bucket.push(entry);
}

function _getWorkersWithTargetThisTick() {
    let tick = typeof gameTime === 'number' ? gameTime : 0;
    const full = _workersWithTargetTick !== _workersWithTargetTick;
    if (full || _workerConflictAdds > Math.max(4096, 2 * _workersWithTarget.length)) {
        let list = [];
        if (full) { for (let other of units) if (other && other.workerTarget) list.push(other); }
        else for (const other of _workerConflictEntries.keys()) if (!other.dead && other.workerTarget) list.push(other);
        _workersWithTarget = list;
        _workersWithTargetTick = tick;
        _workerConflictTiles.clear();
        _workerMovingTargetConflicts.clear();
        _workerConflictEntries.clear();
        for (let other of list) _indexWorkerTargetConflict(other);
        _workerConflictAdds = 0;
    }
    return _workersWithTarget;
}

function _findConflictingWorkerOnTargetTile(unit, target) {
    if (!unit || !target || !unit.workerType) return null;
    let targetTileIndex = _getWorkerTargetTileIndex(target);
    if (targetTileIndex < 0) return null;
    _getWorkersWithTargetThisTick();
    let slot = _getWorkerReservationSlotIndex(target, unit.workerType);
    let bucket = _workerConflictTiles.get(slot);
    let best = null;
    for (let pass = 0; pass < 2; pass++) {
        let entries = pass === 0 ? bucket : _workerMovingTargetConflicts.get(unit.workerType);
        if (!entries) continue;
        for (let entry of entries) {
            let other = entry.unit;
            if (best && entry.order >= best.order) continue;
            if (other === unit || other.dead || !other.workerTarget) continue;
            if (other.owner !== unit.owner || other.workerType !== unit.workerType) continue;
            if (_getWorkerTargetTileIndex(other.workerTarget) !== targetTileIndex) continue;
            best = entry;
        }
    }
    return best ? best.unit : null;
}

function _invalidateWorkerTargetLoadCache() {
    _workersWithTargetTick = NaN;
    _workerConflictTiles.clear();
    _workerMovingTargetConflicts.clear();
    _workerConflictEntries.clear();
    _workersWithTarget = [];
    workerReservedTiles = new Array(Math.max(0, GRID_W * GRID_H * _WORKER_TARGET_LOAD_TYPE_COUNT)).fill(null);
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
        let reservedUnit = workerReservedTiles[nextSlotIndex];
        if (reservedUnit && reservedUnit !== unit && !reservedUnit.dead && reservedUnit.owner === unit.owner && reservedUnit.workerType === unit.workerType) {
            let contenderId = Math.floor(Number(unit.id) || 0);
            let reservedId = Math.floor(Number(reservedUnit.id) || 0);
            // Deterministic tie-break for same tile/type: lower unit id always wins.
            if (reservedId <= contenderId) return false;

            let reservedSlotIndex = Number.isFinite(reservedUnit._workerReservedTileIndex)
                ? Math.floor(reservedUnit._workerReservedTileIndex)
                : -1;
            if (reservedSlotIndex >= 0 && workerReservedTiles[reservedSlotIndex] === reservedUnit) {
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
        if (!reservedUnit) {
            let directConflict = _findConflictingWorkerOnTargetTile(unit, target);
            if (directConflict) return false;
        }
    }

    let prevTarget = unit.workerTarget;
    if (prevTarget) {
        let prevSlotIndex = Number.isFinite(unit._workerReservedTileIndex) ? Math.floor(unit._workerReservedTileIndex) : -1;
        if (prevSlotIndex >= 0 && workerReservedTiles[prevSlotIndex] === unit) workerReservedSet(prevSlotIndex, null);
    }

    unit.workerTarget = target;
    unit.workerTargetType = nextType;
    if (target && unit._us) unit._us.wsKind[unit._si] = 0;
    if (target && _workersWithTargetTick === _workersWithTargetTick) {
        if (!_workerConflictEntries.has(unit)) _workersWithTarget.push(unit);
        _indexWorkerTargetConflict(unit);
    }
    unit._workerReservedTileIndex = -1;
    if (target && nextSlotIndex >= 0) {
        workerReservedSet(nextSlotIndex, unit);
        unit._workerReservedTileIndex = nextSlotIndex;
    }
    return true;
}

function _clearWorkerTarget(unit, reason = null) {
    if (!unit) return;
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
        if (prevSlotIndex >= 0 && workerReservedTiles[prevSlotIndex] === unit) workerReservedSet(prevSlotIndex, null);
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
    if (!reservedUnit) {
        // Indexed static targets, plus a live check for moving healer targets.
        // Assignments extend the index; released/dead entries are checked live.
        return !_findConflictingWorkerOnTargetTile(u, target);
    }
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
    if (unit.workerType === 'builder') return _builderCanWalk(unit.owner);
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
    let reach = Math.ceil(maxSearch / TILE) + 1;
    for (let k = 0; k < 3; k++) _forEachStructureInTileBox(marked[k], myGx - reach, myGy - reach, myGx + reach, myGy + reach, (e) => {
        if (e.owner !== owner || !e.markedForSalvage || getTileEntityRef(e.gx, e.gy) !== e) return;
        // (Cheap tests first: only a nearer one needs the exclusivity check.)
        let d = detHypot(e.x - u.x, e.y - u.y);
        if (d > maxSearch || !(d < bestDist)) return;
        if (!_isTargetWithinWorkerSearchLimits(u, u.x, u.y, e, maxSearchArea)) return;
        if (!_canAssignWorkerTargetExclusive(u, e, null, conflictCache)) return;
        bestDist = d; bestItem = e;
    });
    // Marked cell items in the search box (in the owner's cells).
    _forEachStructureInTileBox(marked[3], myGx - reach, myGy - reach, myGx + reach, myGy + reach, (item) => {
        const cell = grid[item.gy] && grid[item.gy][item.gx];
        if (!cell || cell.item !== item || cell.owner !== owner || !item.markedForSalvage) return;
        let d = detHypot(item.x - u.x, item.y - u.y);
        if (d > maxSearch || !(d < bestDist)) return;
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
        if (_isBuilderUpgradeCandidate(target)) {
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
    if (!Array.isArray(target.spawnQueue) || target.spawnQueue.length <= 0) return false;
    let fallbackType = getSpawnerFallbackUnitType(target);
    let effLvl = getThingBaseLevel(target);
    let front = getQueuedSpawnInfo(target.spawnQueue[0], fallbackType, effLvl, owner);
    return front.energyPaid < front.energyRequired;
}

function _isHealerQueueAnchorTarget(target, owner) {
    if (!target || target.owner !== owner) return false;
    if (target.underConstruction) return false;
    return Array.isArray(target.spawnQueue);
}

function _getHealerQueueTripCost(u, target) {
    if (!u || !target || !Array.isArray(target.spawnQueue) || target.spawnQueue.length <= 0) return 0;
    if (!isQueueEnabled(target)) return 0;
    let owner = Number.isFinite(u.owner) ? u.owner : localPlayerId;
    let fallbackType = getSpawnerFallbackUnitType(target);
    let effLvl = getThingBaseLevel(target);
    let front = getQueuedSpawnInfo(target.spawnQueue[0], fallbackType, effLvl, owner);
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
        if (!Array.isArray(s.spawnQueue)) return;
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
    if (!u || !target || !Array.isArray(target.spawnQueue) || target.spawnQueue.length <= 0) {
        _clearHealerQueueCommit(u);
        return;
    }
    let owner = Number.isFinite(u.owner) ? u.owner : localPlayerId;
    let fallbackType = getSpawnerFallbackUnitType(target);
    let effLvl = getThingBaseLevel(target);
    let front = getQueuedSpawnInfo(target.spawnQueue[0], fallbackType, effLvl, owner);
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
    let fallbackType = getSpawnerFallbackUnitType(target);
    let effLvl = getThingBaseLevel(target);
    let front = getQueuedSpawnInfo(target.spawnQueue[0], fallbackType, effLvl, owner);
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
    let reach = Math.ceil(maxSearch / TILE) + 1, ogx = Math.floor(originX / TILE), ogy = Math.floor(originY / TILE);
    let owner = u.owner;
    _forEachWorkInTileBox(_ownedQueueSpawners(owner), ogx - reach, ogy - reach, ogx + reach, ogy + reach, 'queue', (s) => _isHealerQueueTarget(s, owner), (s) => {
        let d = detHypot(s.x - originX, s.y - originY);
        if (d > maxSearch) return;
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

function _isResearcherTargetBuilding(target, owner) {
    if (!target || target.type !== 'research') return false;
    if (target.owner !== owner) return false;
    if (target.energy <= 0 || target.underConstruction || target.markedForSalvage) return false;
    // (Only a building with auto-research on starts the queue's next task;
    // an active one any research building helps.)
    let task = getPlayerResearchTask(owner);
    if (!task) {
        if (!isAutoResearchEnabled(target)) return false;
        task = tryAdvancePlayerResearchTask(owner);
        target.researchTask = task || null;
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
    let reach = Math.ceil(maxSearch / TILE) + 1, ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
    let owner = u.owner;
    _forEachWorkInTileBox(_getWorkerSpawnersByType('research'), ugx - reach, ugy - reach, ugx + reach, ugy + reach, 'research:' + owner, (s) => _isResearcherTargetBuilding(s, owner), (s) => {
        let d = detHypot(s.x - u.x, s.y - u.y);
        if (d > maxSearch) return;
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
    if (!a || a.constructor !== Type || a.length < n) { a = simSharedArray(Type, Math.max(1024, n + (n >> 2))); simParallelBind(name, a); }
    return a;
}
function _hcPost(ownerCount, cap) {
    simParallelBackgroundWait(HC_LANE);
    const S = _simUnitState, c = S.columns, n = S.owners.length;
    _hcArr('hc.e', Float64Array, n).set(c.energy.subarray(0, n));
    _hcArr('hc.m', Float64Array, n).set(c.maxE.subarray(0, n));
    _hcArr('hc.o', Float64Array, n).set(c.owner.subarray(0, n));
    _hcArr('hc.id', Float64Array, n).set(c.id.subarray(0, n));
    _hcArr('hc.l', Uint8Array, n).set(c.live.subarray(0, n));
    _hcArr('hc.d', Uint8Array, n).set(c.dead.subarray(0, n));
    const chunks = Math.max(1, Math.ceil(n / HC_CHUNK));
    _hcArr('hc.res', Int32Array, chunks * ownerCount * cap); _hcArr('hc.rat', Float64Array, chunks * ownerCount * cap);
    const P = _simBgParamsByLane[HC_LANE];
    P[0] = n; P[1] = HC_CHUNK; P[2] = ownerCount; P[3] = cap;
    simParallelBackground(SIM_KERNEL_HEAL_CAND, chunks, HC_LANE);
    _hcPosted = { chunks, ownerCount, cap, n };
}
// The posted scan's lists per owner ({u, ratio, id}), or null.
function _hcCollect(ownerCount, cap) {
    const J = _hcPosted;
    _hcPosted = null;
    if (!J || J.ownerCount !== ownerCount || J.cap !== cap) return null;
    simParallelBackgroundWait(HC_LANE);
    const RES = _simParReg['hc.res'], RAT = _simParReg['hc.rat'], ID = _simParReg['hc.id'], owners = _simUnitState.owners;
    const out = [];
    for (let o = 0; o < ownerCount; o++) {
        const all = [];
        for (let ch = 0; ch < J.chunks; ch++) for (let k = 0, b = (ch * ownerCount + o) * cap; k < cap; k++) {
            const s = RES[b + k];
            if (s < 0) break;
            all.push({ s, ratio: RAT[b + k], id: Math.floor(ID[s]) });
        }
        all.sort((a, b) => a.ratio - b.ratio || a.id - b.id);
        // (The owner's `cap` best as posted, then those still alive: past
        // them the chunks' lists would depend on the slot layout, which
        // differs on a peer that restored.)
        const list = [];
        for (let k = 0; k < all.length && k < cap; k++) {
            const e = all[k], u = owners[e.s];
            if (u && u.id === e.id && !u.dead) list.push({ u, ratio: e.ratio, id: e.id });
        }
        out.push(list);
    }
    return out;
}
function healerCandidatesStep() {
    const R = HEALER_CANDIDATE_CACHE_TICKS, k = gameTime % R;
    if (_hcAvailable()) {
        const ownerCount = Math.max(1, Math.floor(Number(players && players.length) || 0)), cap = Math.max(1, HEALER_DAMAGED_CANDIDATE_LIMIT | 0);
        if (k === 0) _hcPost(ownerCount, cap);
        if (k !== R - 1) return;
        const best = _hcCollect(ownerCount, cap);
        if (best) _healerCandidatesInstall(best, ownerCount);
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
        if (distSq > maxSearchSq) continue;
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
            const entry = _wsResults.get(u._si);
            const q = _wsGridPick(u, WSW_QUEUE, origin, maxSearch, true, e => _isHealerQueueTarget(e, u.owner), 'queue', WSR_HEAL);
            if (q === WS_WAITING) { _wsWait(u); return; }
            queueTarget = q;
            healUnits = entry && entry.id === u.id && entry.units ? entry.units : [];
        } else queueTarget = _findNearestQueuedSpawnerNeedingWork(u, origin.x, origin.y);
    }
    if (queueTarget) {
        let qd = detHypot(queueTarget.x - origin.x, queueTarget.y - origin.y);
        if (!hasPinnedQueueTarget && qd > maxSearch) {
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
    let reach = Math.ceil(maxSearch / TILE) + 2, ogx = Math.floor(originX / TILE), ogy = Math.floor(originY / TILE);
    let B = STRUCTURE_BUCKET_TILES, X = _ownedStructIndex;
    let bx0 = Math.max(0, Math.floor((ogx - reach) / B)), bx1 = Math.min(X.cols - 1, Math.floor((ogx + reach) / B));
    let by0 = Math.max(0, Math.floor((ogy - reach) / B)), by1 = Math.min(X.rows - 1, Math.floor((ogy + reach) / B));
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
        let list = buckets[by * X.cols + bx];
        if (!list) continue;
        let work = _bucketWorkList(list, by * X.cols + bx, 'build', (b) => _isBuilderWorkTarget(b, owner));
        for (let i = 0; i < work.length; i++) {
            let b = work[i];
            if (Math.abs(b.x - originX) > maxSearch || Math.abs(b.y - originY) > maxSearch) continue;
            if (!_isBuilderWorkTarget(b, owner)) continue;
            if (!_isTargetWithinWorkerSearchLimits(u, originX, originY, b, maxSearchArea)) continue;
            let d = detHypot(b.x - originX, b.y - originY);
            if (d > maxSearch) continue;
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
        for (let i = 0; i < changes.length; i++) {
            const t = changes[i], item = _cellItemAtTile(t);
            for (const [ty, list] of _cellItemsByTypeCache) {
                const next = _tileOrderedReplace(list, t, item && item.type === ty ? item : null);
                if (next !== list) _cellItemsByTypeCache.set(ty, next);
            }
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

// Nearest working spawner of the type and owner by tile Manhattan distance,
// ties to the lower row then column: rings of buckets outward until no
// closer one can remain.
// A type's spawners of one owner (in the type list's order), made again with
// the type list (a new list when spawners change).
const _ownedSpawnerLists = new WeakMap();
function _ownedSpawnersOfType(type, owner) {
    const all = _getWorkerSpawnersByType(type);
    let m = _ownedSpawnerLists.get(all);
    if (!m) _ownedSpawnerLists.set(all, m = new Map());
    let l = m.get(owner);
    if (!l) { l = []; for (const s of all) if (s && s.owner === owner) l.push(s); m.set(owner, l); }
    return l;
}
function _findClosestSpawner(u, type) {
    // (The owner's own: the others never pass the test below.)
    let list = _ownedSpawnersOfType(type, u && u.owner);
    if (list.length === 0) return null;
    let index = _structureBuckets(list), B = STRUCTURE_BUCKET_TILES;
    let ux = Math.floor(Number(u && u.x) / TILE);
    let uy = Math.floor(Number(u && u.y) / TILE);
    let ubx = Math.max(0, Math.min(index.cols - 1, Math.floor(ux / B)));
    let uby = Math.max(0, Math.min(index.rows - 1, Math.floor(uy / B)));
    let closest = null, bestDist = Infinity, cx = 0, cy = 0;
    let consider = (s) => {
        if (s.type !== type || s.owner !== u.owner || !(s.energy > 0) || s.underConstruction) return;
        let sx = Math.floor(Number(s.gx) || 0), sy = Math.floor(Number(s.gy) || 0);
        let d = Math.abs(sx - ux) + Math.abs(sy - uy);
        if (d < bestDist || (d === bestDist && (sy < cy || (sy === cy && (sx < cx || (sx === cx && (Number(s.id) || 0) < (Number(closest.id) || 0))))))) { bestDist = d; closest = s; cx = sx; cy = sy; }
    };
    // (A few hundred: all of them, cheaper than rings of empty buckets when
    // the nearest is far; the same order decides.)
    if (list.length <= 512) { for (let i = 0; i < list.length; i++) if (list[i]) consider(list[i]); return closest; }
    let maxRing = Math.max(index.cols, index.rows);
    for (let r = 0; r <= maxRing; r++) {
        // Every tile in ring r is at least (r - 1) * B + 1 tiles away.
        if (r > 0 && (r - 1) * B + 1 > bestDist) break;
        for (let by = uby - r; by <= uby + r; by++) {
            if (by < 0 || by >= index.rows) continue;
            let edge = by === uby - r || by === uby + r;
            for (let bx = ubx - r; bx <= ubx + r; bx += (edge || r === 0) ? 1 : 2 * r) {
                if (bx < 0 || bx >= index.cols) continue;
                let bucket = index.buckets[by * index.cols + bx];
                if (bucket) for (let i = 0; i < bucket.length; i++) consider(bucket[i]);
            }
        }
    }
    return closest;
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


function queueAction(action) {
    if (localDefeated && action && action.action !== 'resign') return;
    if (gameOver) return;
    // Just joined and still catching up: sent once the host counts us in.
    if (isMultiplayer && gameStarted && resyncGuestHoldAction(action)) return;
    if (isMultiplayer && gameStarted && !isHost && !netGetHostConnection()) {
        // Commands issued while reconnecting are kept and sent once the link
        // is back (they are scheduled after every tick already sent).
        scheduleGuestAutoReconnect('Lost host connection');
    }
    // Fair delay starts at the completed tick the player sees, including on
    // the host. Ticks merely queued in a busy worker must not add another
    // private delay on top of the shared command lead.
    let actionLead = netCommandLeadTicks();
    let commandTick = isMultiplayer && gameStarted && netFairInputDelay ? netCompletedSimulationTick() : currentTick;
    let tick = Math.max(currentTick, commandTick + actionLead);
    if (isMultiplayer && gameStarted && !isHost && resyncGuest.liveFromTick > tick) tick = resyncGuest.liveFromTick;
    if (isMultiplayer && gameStarted) {
        // A sent packet may already be sealed by the host, and a sealed tick
        // never changes, so new commands always go to a later tick. This also
        // keeps commands safe when the input delay shrinks.
        if (!isHost) tick = Math.max(tick, lockstepHighestSentLocalTick + 1);
        while (lockstepCommittedByTick[tick] || lockstepBundleByTick[tick]) tick++;
    }
    if (!localInputBuffer[tick]) localInputBuffer[tick] = [];
    let actorId = myPeerId || `p${localPlayerId}`;
    let finalAction = { ...action, teamId: localPlayerId, netId: `${actorId}:${nextLocalActionSeq++}` };
    localInputBuffer[tick].push(finalAction);

    // The tick is unsent (guest) or unsealed (host): rebuild its packet.
    delete lockstepLocalPacketByTick[tick];
    if (isHost && lockstepHostPacketsByTick[tick] && myPeerId) {
        delete lockstepHostPacketsByTick[tick][myPeerId];
    }
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
    let targetTileIndex = _getWorkerTargetTileIndex(target);
    for (let other of units) {
        if (!other || other === assigningUnit || other.dead || !other.workerState) continue;
        if (other.owner !== assigningUnit.owner) continue;
        if (other.workerType !== assigningUnit.workerType) continue;
        let sameTarget = other.workerTarget === target && other.workerTargetType === targetType;
        let otherTileIndex = _getWorkerTargetTileIndex(other.workerTarget);
        let sameTile = targetTileIndex >= 0 && otherTileIndex >= 0 && targetTileIndex === otherTileIndex;
        if (!sameTarget && !sameTile) continue;

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
