"use strict";

function _researcherTryPickupMaterial(u, target, owner) {
    if (!u || !target) return false;
    let task = target.researchTask;
    if (!task) return false;

    let required = Math.max(0, Number(task.workRequired) || 0);
    let done = Math.max(0, Number(task.workDone) || 0);
    let remainingWork = Math.max(0, required - done);
    if (remainingWork <= 0) return false;

    let workerBaseFallback = Math.max(1, Math.round(Number((BASE_UNIT_STATS.researcher_unit || {}).researcherDps) || Number(UNIT_FORMULA_CONFIG.workerSpecialistBaseRate) || 1));
    let dps = u.researcherDps || target.getResearcherDps() || workerBaseFallback;
    let efficiency = getResearchBuildingEfficiency(target);
    let researchWorkPerTrip = Math.max(0.1, dps * efficiency);
    let tripWork = Math.min(remainingWork, researchWorkPerTrip);
    if (!(tripWork > 0)) return false;

    let cost = Math.max(0, Number(task.cost) || 0);
    let costPerWork = required > 0 ? (cost / required) : 0;
    let tripCost = Math.max(0, tripWork * costPerWork);
    let available = Math.max(0, Number(players[owner].energy) || 0);

    if (tripCost > available + 1e-9) {
        if (!(costPerWork > 0)) return false;
        tripWork = Math.min(tripWork, available / costPerWork);
        if (!(tripWork > 1e-6)) {
            u._energyBlockedUntil = gameTime + _getEnergyBlockedGlyphTicks();
            return false;
        }
        tripCost = Math.max(0, tripWork * costPerWork);
    }

    if (tripCost > 0) {
        players[owner].energy = Math.max(0, players[owner].energy - tripCost);
        recordEnergyDelta(owner, 'research', -tripCost);
    }

    u.researcherHasMaterial = true;
    u._researcherTripWork = tripWork;
    u._researcherTripCost = tripCost;
    let researcherCooldown = getWorkerTypeTransferCooldownTicks('researcher', u);
    u._researcherMaterialReadyTick = gameTime + researcherCooldown;
    u.workerTransferCooldown = researcherCooldown;
    return true;
}

const WORKER_REPATH_MIN_INTERVAL_TICKS = 8;
const WORKER_REPATH_STALL_TICKS = 45;

function _requestWorkerPath(u, startGx, startGy, targetGx, targetGy, canWalk = null, cacheProfileHint = null, force = false) {
    if (!u) return null;
    let ignoreWalls = !!u.isFlying;
    let cacheProfile = cacheProfileHint || (ignoreWalls ? 'ignore_walls' : null);
    let key = String(targetGx) + ',' + String(targetGy) + '|' + (cacheProfile || 'default') + '|' + (canWalk ? 'cw1' : 'cw0') + '|' + (ignoreWalls ? 'fly1' : 'fly0');
    if (!Number.isFinite(u._workerLastPathX) || !Number.isFinite(u._workerLastPathY)) {
        u._workerLastPathX = u.x;
        u._workerLastPathY = u.y;
        u._workerPathStallTicks = 0;
    } else {
        let moved = Math.hypot(u.x - u._workerLastPathX, u.y - u._workerLastPathY);
        u._workerPathStallTicks = moved >= 1.5 ? 0 : Math.max(0, Number(u._workerPathStallTicks) || 0) + 1;
        u._workerLastPathX = u.x;
        u._workerLastPathY = u.y;
    }

    let lastTick = Math.floor(Number(u._workerLastPathTick) || -999999);
    let sameTarget = (u._workerLastPathKey === key);
    let stalled = (Number(u._workerPathStallTicks) || 0) >= WORKER_REPATH_STALL_TICKS;
    if (!force && sameTarget && !stalled && (gameTime - lastTick) < WORKER_REPATH_MIN_INTERVAL_TICKS) {
        return u.path || null;
    }

    if (!_canUsePathfindRequestBudget(u.owner)) {
        _makeFallbackPathForUnit(u, startGx, startGy, targetGx, targetGy, u.commandState || CMD_MOVING, 'worker_ai');
        return null;
    }

    _consumePathfindRequestBudget(u.owner);
    let path = _findPathForUnitTagged('worker_ai', u, startGx, startGy, targetGx, targetGy, ignoreWalls, canWalk, u.owner, cacheProfile);
    if (!path && _lastPathfindAbortedByBudget) {
        _makeFallbackPathForUnit(u, startGx, startGy, targetGx, targetGy, u.commandState || CMD_MOVING, 'worker_ai');
    }
    u._workerLastPathKey = key;
    u._workerLastPathTick = gameTime;
    return path;
}

// Worker AI logic - runs inside Unit.update() for collector/salvager/builder/healer types
function updateWorkerAI(u) {
    if (!u.workerState) return;
    let workerAiTickDelay = Math.max(1, Math.floor(Number(WORKER_AI_TICK_DELAY) || 1));
    let canRunHeavyAi = ((gameTime + u.id) % workerAiTickDelay) === 0;
    let getSpawnerRoute = (type, canWalk = null) => _findBestSpawnerRoute(u, type, canWalk, { cacheOnly: !canRunHeavyAi });
    if (u.commandState === CMD_HOLDING) {
        _clearWorkerTarget(u);
        clearWorkerTaskMemoryForFreeRetarget(u);
        u.workerState = 'IDLE';
        u.path = null;
        u.targetUnit = null;
        u.targetBuilding = null;
        u._pendingPathTarget = null;
        return;
    }
    let owner = u.owner;
    let myGx = Math.floor(u.x / TILE), myGy = Math.floor(u.y / TILE);
    let runHealerRetargetIfDue = () => {
        if (!shouldRunWorkerIdleRetarget(u, canRunHeavyAi)) return false;
        _healerFindTarget(u, myGx, myGy);
        return true;
    };
    if (u.workerTransferCooldown > 0) u.workerTransferCooldown--;

    if (u.workerState === 'MANUAL_MOVE') {
        if ((!u.path || u.pathIndex >= u.path.length) && u._pendingPathTarget) {
            if (u.pathIsFallbackAstar) {
                _tryUpgradeAstarFallbackPath(u);
            }
            // Keep manual move active while deferred pathfinding catches up.
            return;
        }
        if (!u.path || u.pathIndex >= u.path.length) {
            u._workerNextIdleRetargetTick = gameTime;
            u.workerState = 'IDLE'; u.commandState = CMD_IDLE;
        }
        return; // Suppress auto-AI while manually moving
    }

    if (u.workerType === 'collector') {
        if (u.workerState === 'IDLE') {
            if (!u._lastIdleStateTime || u.workerState !== 'IDLE') u._lastIdleStateTime = gameTime;
            if (!shouldRunWorkerIdleRetarget(u, canRunHeavyAi)) return;
            _collectorFindTarget(u, myGx, myGy);
        } else if (u.workerState === 'MOVING_TO') {
            u._lastIdleStateTime = 0;
            if (!u.workerTarget || !_workerOwnsReservedTarget(u)) {
                _clearWorkerTarget(u, 'target_missing');
                _clearWorkerAutoRoute(u);
                _collectorFindTarget(u, myGx, myGy);
                return;
            }
            if (u.workerTargetType === 'drop' && getDroppedItemAt(u.workerTarget.gx, u.workerTarget.gy) !== u.workerTarget) {
                _clearWorkerTarget(u, 'target_missing'); _collectorFindTarget(u, myGx, myGy); return;
            }
            if (u.workerTargetType === 'mine' && u.workerTarget.gold <= 0) {
                _clearWorkerTarget(u, 'target_no_work'); _collectorFindTarget(u, myGx, myGy); return;
            }
            if (u.workerTargetType === 'farm' && (!u.workerTarget || u.workerTarget.type !== 'farm' || u.workerTarget.owner !== owner || u.workerTarget.underConstruction || u.workerTarget.energy <= 0)) {
                _clearWorkerTarget(u, 'target_no_work'); _collectorFindTarget(u, myGx, myGy); return;
            }
            if (!u.path || u.pathIndex >= u.path.length) {
                if (_workerHasPendingAutoRouteToTarget(u)) return;
                let dist = Math.hypot(u.workerTarget.x - u.x, u.workerTarget.y - u.y);
                if (dist <= 24) {
                    if (u.workerTransferCooldown > 0) return;
                    if (u.workerTargetType === 'drop') {
                        u.carryingValue = u.workerTarget.value;
                        removeDroppedItem(u.workerTarget);
                    } else if (u.workerTargetType === 'farm') {
                        let gatherPerTrip = Number(u.gatherPerTrip);
                        if (!Number.isFinite(gatherPerTrip) || gatherPerTrip <= 0) {
                            let effLvl = getUnitEffectiveLevel(u, getUnitBaseLevel(u));
                            gatherPerTrip = getUnitStatForOwner(owner, u.unitType, effLvl, 'gatherPerTrip');
                        }
                        if (!Number.isFinite(gatherPerTrip) || gatherPerTrip <= 0) gatherPerTrip = 1;
                        let farmLvl = getThingEffectiveLevel(u.workerTarget, stackCountToLevel(u.workerTarget.stacks || 1));
                        let mult = getBuildingStatForOwner(owner, 'farm', farmLvl, 'multiplier');
                        if (!Number.isFinite(mult) || mult <= 0) mult = Math.max(1, farmLvl);
                        u.carryingValue = Math.max(1, gatherPerTrip * mult);
                    } else {
                        let gatherPerTrip = Number(u.gatherPerTrip);
                        if (!Number.isFinite(gatherPerTrip) || gatherPerTrip <= 0) {
                            let effLvl = getUnitEffectiveLevel(u, getUnitBaseLevel(u));
                            gatherPerTrip = getUnitStatForOwner(owner, u.unitType, effLvl, 'gatherPerTrip');
                        }
                        if (!Number.isFinite(gatherPerTrip) || gatherPerTrip <= 0) gatherPerTrip = 1;
                        let extract = Math.min(gatherPerTrip, u.workerTarget.gold);
                        u.workerTarget.gold -= extract;
                        // u.workerTarget.gold -= 1
                        u.carryingValue = extract;
                        if (u.workerTarget.gold <= 0) {
                            let mine = u.workerTarget;
                            grid[mine.gy][mine.gx].type = TYPE_FLOOR;
                            let idx = goldMines.indexOf(mine);
                            if (idx >= 0) goldMines.splice(idx, 1);
                            clearTileEntity(mine.gx, mine.gy, mine);
                            _markCombinedBgTileDirty(mine.gx, mine.gy, 0, true);
                            dirtyGrid = true;
                        }
                    }
                    u.workerTransferCooldown = getWorkerTypeTransferCooldownTicks('collector', u);
                    _collectorRememberGatherSite(u, u.workerTarget, u.workerTargetType);
                    // Remember the mine we just used for re-targeting after return
                    u._lastMineTarget = (u.workerTargetType === 'mine') ? u.workerTarget : null;
                    if (u.workerTargetType === 'drop') _clearWorkerTarget(u, 'target_missing');
                    u.workerState = 'RETURNING'; _workerReturnPath(u);
                } else {
                    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
                    let canWalk = u.workerTargetType === 'mine' ? _collectorCanWalk : null;
                    u.path = _requestWorkerPath(u, startGx, startGy, u.workerTarget.gx, u.workerTarget.gy, canWalk, null, true);
                    if (u.path) {
                        u.pathIndex = 0;
                        u.commandState = CMD_MOVING;
                    } else {
                        _collectorFindTarget(u, myGx, myGy);
                    }
                }
            }
        } else if (u.workerState === 'RETURNING') {
            if (!u.path || u.pathIndex >= u.path.length) {
                let closest = _findClosestSpawner(u, 'spawner');
                let isAtDropoff = !!closest && Math.hypot(closest.x - u.x, closest.y - u.y) <= 24;
                if (isAtDropoff && closest) {
                    u._collectorLastDropoffSpawner = closest;
                    u._collectorNextSpawner = closest;
                }
                if (u.carryingValue > 0 && !isAtDropoff) {
                    _workerReturnPath(u);
                    return;
                }
                if (u.carryingValue > 0 && isAtDropoff) {
                    if (u.workerTransferCooldown > 0) return;
                    players[owner].energy += u.carryingValue;
                    recordEnergyDelta(owner, 'collect', u.carryingValue);
                    u.workerTransferCooldown = getWorkerTypeTransferCooldownTicks('collector', u);
                    if (owner === localPlayerId) playSound('gold_collected', u.x, u.y);
                }
                u.carryingValue = 0;
                if (!canRunHeavyAi) return;
                if (_isCollectorTargetValid(u.workerTarget, u.workerTargetType, owner) && _workerOwnsReservedTarget(u)) {
                    _collectorAssignTarget(u, u.workerTarget, u.workerTargetType, myGx, myGy);
                    return;
                }
                u._lastMineTarget = null;
                _clearWorkerTarget(u, 'target_no_work');
                _collectorFindTarget(u, myGx, myGy);
            }
        }
    } else if (u.workerType === 'astar_collector') {
        if (u.workerState === 'IDLE') {
            if (!shouldRunWorkerIdleRetarget(u, canRunHeavyAi)) return;
            _astarCollectorFindTarget(u);
        } else if (u.workerState === 'MOVING_TO_ASTAR') {
            if (!_isAstarCollectorTargetValid(u.workerTarget, u.workerTargetType, owner) || !_workerOwnsReservedTarget(u)) {
                _clearWorkerTarget(u, 'target_no_work');
                _clearWorkerAutoRoute(u);
                _astarCollectorFindTarget(u);
                return;
            }
            if (!u.path || u.pathIndex >= u.path.length) {
                if (_workerHasPendingAutoRouteToTarget(u)) return;
                let dist = Math.hypot(u.workerTarget.x - u.x, u.workerTarget.y - u.y);
                if (dist <= 24) {
                    if (u.workerTransferCooldown > 0) return;
                    let gatherPerTrip = Number(u.gatherPerTrip);
                    if (!Number.isFinite(gatherPerTrip) || gatherPerTrip <= 0) {
                        let effLvl = getUnitEffectiveLevel(u, getUnitBaseLevel(u));
                        gatherPerTrip = getUnitStatForOwner(owner, u.unitType, effLvl, 'gatherPerTrip');
                    }
                    if (!Number.isFinite(gatherPerTrip) || gatherPerTrip <= 0) gatherPerTrip = 1;
                    if (u.workerTargetType === 'astar_farm') {
                        let lvl = getThingEffectiveLevel(u.workerTarget, stackCountToLevel(u.workerTarget.effectiveStacks || u.workerTarget.stacks || 1));
                        let mult = getBuildingStatForOwner(owner, 'astar_farm', lvl, 'multiplier');
                        if (!Number.isFinite(mult) || mult <= 0) mult = 1;
                        gatherPerTrip *= mult;
                    }
                    let extract = u.workerTargetType === 'astar_mine'
                        ? Math.min(gatherPerTrip, u.workerTarget.astar)
                        : gatherPerTrip;
                    if (u.workerTargetType === 'astar_mine') u.workerTarget.astar -= extract;
                    u.carryingValue = extract;
                    if (u.workerTargetType === 'astar_mine' && u.workerTarget.astar <= 0) {
                        let mine = u.workerTarget;
                        grid[mine.gy][mine.gx].type = TYPE_FLOOR;
                        let idx = astarMines.indexOf(mine);
                        if (idx >= 0) astarMines.splice(idx, 1);
                        clearTileEntity(mine.gx, mine.gy, mine);
                        _markCombinedBgTileDirty(mine.gx, mine.gy, 0, true);
                        dirtyGrid = true;
                    }
                    u.workerTransferCooldown = getWorkerTypeTransferCooldownTicks('astar_collector', u);
                    _astarCollectorRememberGatherSite(u, u.workerTarget);
                    u._astarLastMineTarget = u.workerTarget;
                    u._astarLastMineTargetType = u.workerTargetType;
                    u.workerState = 'RETURNING_ASTAR'; _workerReturnPath(u);
                } else {
                    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
                    let canWalk = u.workerTargetType === 'astar_mine' ? _astarCollectorCanWalk : null;
                    u.path = _requestWorkerPath(u, startGx, startGy, u.workerTarget.gx, u.workerTarget.gy, canWalk, 'astar_collector', true);
                    if (u.path) {
                        u.pathIndex = 0;
                        u.commandState = CMD_MOVING;
                    } else {
                        _astarCollectorFindTarget(u);
                    }
                }
            }
        } else if (u.workerState === 'RETURNING_ASTAR') {
            if (!u.path || u.pathIndex >= u.path.length) {
                let closest = _findClosestSpawner(u, 'astar_spawner');
                let isAtDropoff = !!closest && Math.hypot(closest.x - u.x, closest.y - u.y) <= 24;
                if (isAtDropoff && closest) {
                    u._astarNextSpawner = closest;
                }
                if (u.carryingValue > 0 && !isAtDropoff) {
                    _workerReturnPath(u);
                    return;
                }
                if (u.carryingValue > 0 && isAtDropoff) {
                    if (u.workerTransferCooldown > 0) return;
                    let player = players[owner];
                    let curAstar = Math.max(0, Number(player.astar) || 0);
                    let nextValue = curAstar + Math.max(0, Number(u.carryingValue) || 0);
                    _setPlayerAstarBudget(owner, nextValue);
                    u.workerTransferCooldown = getWorkerTypeTransferCooldownTicks('astar_collector', u);
                    if (owner === localPlayerId) playSound('astar_collected', u.x, u.y);
                }
                u.carryingValue = 0;
                if (!canRunHeavyAi) return;
                if (_isAstarCollectorTargetValid(u.workerTarget, u.workerTargetType, owner) && _workerOwnsReservedTarget(u)) {
                    _astarCollectorAssignTarget(u, u.workerTarget, u.workerTargetType);
                    return;
                }
                u._astarLastMineTarget = null;
                u._astarLastMineTargetType = null;
                _clearWorkerTarget(u, 'target_no_work');
                _astarCollectorFindTarget(u);
            }
        }
    } else if (u.workerType === 'salvager') {
        if (u.workerState === 'IDLE') {
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
                let dist = Math.hypot(u.workerTarget.x - u.x, u.workerTarget.y - u.y);
                if (dist <= 24) {
                    if (u.workerTransferCooldown > 0) return;
                    let tKey = u.workerTarget.type === 'barrack' ? 'barrack_' + u.workerTarget.unitType : u.workerTarget.type;
                    let p = BASE_CARD_TYPES[tKey]; let refund = Math.floor((p ? p.price : 0) * (u.workerTarget.stacks || 1) * 0.1);
                    u.carryingValue = refund * getUnitBaseLevel(u);
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
                    players[owner].energy += u.carryingValue;
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
        let movedSinceLast = false;
        if (!Number.isFinite(u._builderLastWatchX) || !Number.isFinite(u._builderLastWatchY)) {
            u._builderLastWatchX = u.x;
            u._builderLastWatchY = u.y;
            u._builderLastMoveTick = gameTime;
        } else {
            movedSinceLast = Math.hypot(u.x - u._builderLastWatchX, u.y - u._builderLastWatchY) >= 2;
            u._builderLastWatchX = u.x;
            u._builderLastWatchY = u.y;
            if (movedSinceLast) u._builderLastMoveTick = gameTime;
        }

        let builderRecheckInterval = Math.max(120, Math.floor(TICK_RATE * 8));
        let builderStuckTicks = Math.max(60, Math.floor(TICK_RATE * 3));
        if (!Number.isFinite(u._builderNextRecheckTick)) u._builderNextRecheckTick = gameTime + builderRecheckInterval;
        if (!Number.isFinite(u._builderLastMoveTick)) u._builderLastMoveTick = gameTime;

        if (u.workerState === 'IDLE' && gameTime >= u._builderNextRecheckTick) {
            u._builderNextRecheckTick = gameTime + builderRecheckInterval;
            let stuckTooLong = (gameTime - u._builderLastMoveTick) >= builderStuckTicks;
            let shouldRetarget = !u.workerTarget || stuckTooLong;
            if (shouldRetarget) {
                if (stuckTooLong) {
                    // Drop stale route/spawner reservation and find a fresh task.
                    u.path = null;
                    u.pathIndex = 0;
                    u._builderSpawnerTarget = null;
                    _clearWorkerTarget(u);
                }
                _builderFindTarget(u, myGx, myGy);
            }
        }

        if (u.workerState === 'IDLE') {
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
                let dist = Math.hypot(u.workerTarget.x - u.x, u.workerTarget.y - u.y);
                if (dist > 24) {
                    // If displaced while en route, re-path back to the same target.
                    let canWalk = _builderCanWalk(u.owner);
                    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
                    u.path = _requestWorkerPath(u, startGx, startGy, u.workerTarget.gx, u.workerTarget.gy, canWalk, 'builder');
                    u.pathIndex = 0;
                    u.commandState = CMD_MOVING;
                    return;
                }
                if (dist <= 24) {
                    if (!u.builderHasMaterial) {
                        let route = getSpawnerRoute('builder_spawner', null);
                        let tripCost = getBuilderTripGoldCost(u);
                        if (route && players[owner].energy >= tripCost) {
                            u.workerState = 'RETURNING_FOR_GOLD';
                            u.path = route.path;
                            u.pathIndex = 0; u.commandState = CMD_MOVING;
                            u._builderSpawnerTarget = route.spawner;
                            return;
                        } else {
                            if (players[owner].energy < tripCost) u._energyBlockedUntil = gameTime + _getEnergyBlockedGlyphTicks();
                            if (u.workerTransferCooldown <= 0 && players[owner].energy >= tripCost) {
                                // No route available: buy material on-site and keep full builder throughput.
                                players[owner].energy -= tripCost;
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
                    let dps = u.builderDps || baseBuild;
                    let t = u.workerTarget;
                    let didWork = false;
                    if (t.underConstruction) {
                        t.energy = Math.min(t.maxEnergy, t.energy + dps);
                        didWork = true;
                        if (t.energy >= t.maxEnergy) {
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
                        t.energy = Math.min(t.maxEnergy, t.energy + dps);
                        didWork = true;
                        if (t.energy >= t.maxEnergy) {
                            if (t.effectiveLevel === undefined) t.effectiveLevel = 1;
                            t.effectiveLevel++;

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
                            t.stackingWorkDone -= stackCost;
                            t.stacks = getThingStackedStacks(t) + 1;
                            t.level = stackCountToLevel(t.stacks);
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
                        t.energy = Math.min(t.maxEnergy, t.energy + dps);
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
                        let route = getSpawnerRoute('builder_spawner', null);
                        let tripCost = getBuilderTripGoldCost(u);
                        if (route && players[owner].energy >= tripCost) {
                            u.workerState = 'RETURNING_FOR_GOLD';
                            u.path = route.path;
                            u.pathIndex = 0; u.commandState = CMD_MOVING;
                            u._builderSpawnerTarget = route.spawner;
                        } else {
                            if (players[owner].energy < tripCost) u._energyBlockedUntil = gameTime + _getEnergyBlockedGlyphTicks();
                            // No spawner or no energy, just keep building for free (but slower)
                            u.workerState = 'BUILDING_IN_PLACE';
                        }
                    }
                }
            }
        } else if (u.workerState === 'RETURNING_FOR_GOLD') {
            if (!_isBuilderWorkTarget(u.workerTarget, owner)) {
                _builderRememberWorkSite(u);
                _clearWorkerTarget(u);
                _builderFindTarget(u, myGx, myGy);
                return;
            }
            if (!u.path || u.pathIndex >= u.path.length) {
                let spawner = u._builderSpawnerTarget || _findClosestBuilderSpawner(u);
                let dist = spawner ? Math.hypot(spawner.x - u.x, spawner.y - u.y) : 0;
                if (!spawner || dist <= 24) {
                    if (u.workerTransferCooldown > 0) return;
                    let tripCost = getBuilderTripGoldCost(u);
                    if (spawner && players[owner].energy >= tripCost) {
                        players[owner].energy -= tripCost;
                        recordEnergyDelta(owner, 'builder', -tripCost);
                        u.builderHasMaterial = true;
                        u.workerTransferCooldown = getBuilderTransferCooldownTicks(u);
                        if (canRunHeavyAi) {
                            // Material just picked up: re-check nearest active build target from current position.
                            let bestNow = _findNearestUnderConstruction(u, u.x, u.y);
                            if (bestNow) {
                                _builderAssignTarget(u, bestNow, myGx, myGy);
                                return;
                            }
                        }
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
                    let route = getSpawnerRoute('builder_spawner', null);
                    if (route) {
                        u._builderSpawnerTarget = route.spawner;
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
                if (players[owner].energy >= tripCost) {
                    players[owner].energy -= tripCost;
                    recordEnergyDelta(owner, 'builder', -tripCost);
                    u.builderHasMaterial = true;
                    u.workerTransferCooldown = getBuilderTransferCooldownTicks(u);
                } else {
                    u._energyBlockedUntil = gameTime + _getEnergyBlockedGlyphTicks();
                }
            }

            let baseBuild = Number((BASE_UNIT_STATS[u.unitType] || {}).builderDps) || Number(UNIT_FORMULA_CONFIG.workerSpecialistBaseRate) || 1;
            let dps = u.builderDps || baseBuild;
            let buildStep = 0;
            if (u.builderHasMaterial) {
                buildStep = dps;
            } else if (gameTime % 20 === 0 && players[owner].energy >= 1) {
                // Last-resort slow trickle when no full material transfer is possible.
                players[owner].energy -= 1;
                buildStep = 1;
            }

            if (buildStep > 0) {
                let t = u.workerTarget;
                if (t.underConstruction) {
                    t.energy = Math.min(t.maxEnergy, t.energy + buildStep);
                    if (t.energy >= t.maxEnergy) {
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
                    t.energy = Math.min(t.maxEnergy, t.energy + buildStep);
                    if (t.energy >= t.maxEnergy) {
                        if (t.effectiveLevel === undefined) t.effectiveLevel = 1;
                        t.effectiveLevel++;

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
                        t.stackingWorkDone -= stackCost;
                        t.stacks = getThingStackedStacks(t) + 1;
                        t.level = stackCountToLevel(t.stacks);
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
                    t.energy = Math.min(t.maxEnergy, t.energy + buildStep);
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
            let route = getSpawnerRoute('builder_spawner', null);
            let tripCost = getBuilderTripGoldCost(u);
            if (route && players[owner].energy >= tripCost && u.workerTarget) {
                u.workerState = 'RETURNING_FOR_GOLD';
                u.path = route.path;
                u.pathIndex = 0; u.commandState = CMD_MOVING;
                u._builderSpawnerTarget = route.spawner;
            } else if (u.workerTarget && players[owner].energy < tripCost) {
                u._energyBlockedUntil = gameTime + _getEnergyBlockedGlyphTicks();
            }
        }
    } else if (u.workerType === 'healer') {
        if (u.workerState === 'IDLE') {
            if (!runHealerRetargetIfDue()) return;
        } else if (u.workerState === 'MOVING_TO_HEAL') {
            let targetIsQueue = (u.workerTargetType === 'queue');
            if (targetIsQueue ? !_isHealerQueueTarget(u.workerTarget, owner) : !_isHealerTargetUnit(u.workerTarget, owner)) {
                if (targetIsQueue) _clearHealerQueueCommit(u);
                _clearWorkerTarget(u, 'target_no_work');
                if (!runHealerRetargetIfDue()) {
                    u.workerState = 'IDLE';
                    u.commandState = CMD_IDLE;
                }
                return;
            }
            if (!u.path || u.pathIndex >= u.path.length) {
                let tx = targetIsQueue ? u.workerTarget.x : u.workerTarget.x;
                let ty = targetIsQueue ? u.workerTarget.y : u.workerTarget.y;
                let dist = Math.hypot(tx - u.x, ty - u.y);
                if (dist > 24) {
                    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
                    let targetGx = Math.floor(tx / TILE), targetGy = Math.floor(ty / TILE);
                    u.path = _requestWorkerPath(u, startGx, startGy, targetGx, targetGy, null, null);
                    u.pathIndex = 0;
                    u.commandState = CMD_MOVING;
                    return;
                }
                if (!u.healerHasMaterial) {
                    let route = getSpawnerRoute('healer_spawner', null);
                    if (route && players[owner].energy >= 1) {
                        u.workerState = 'RETURNING_FOR_GOLD';
                        u.path = route.path;
                        u.pathIndex = 0; u.commandState = CMD_MOVING;
                        u._healerSpawnerTarget = route.spawner;
                    } else {
                        u._energyBlockedUntil = gameTime + _getEnergyBlockedGlyphTicks();
                        u.workerState = 'IDLE';
                        u.commandState = CMD_IDLE;
                    }
                    return;
                }
                if (u.workerTransferCooldown > 0) return;

                if (targetIsQueue) {
                    let sp = u.workerTarget;
                    let fallbackType = getSpawnerFallbackUnitType(sp);
                    let effLvl = getThingEffectiveLevel(sp);
                    let front = getQueuedSpawnInfo(sp.spawnQueue[0], fallbackType, effLvl, owner);
                    let didWork = false;
                    let healWork = Math.max(1, Math.floor(Number(u._healerQueueTripCost) || Math.round(Number(u.healerDps) || 1)));

                    if (front.energyPaid < front.energyRequired) {
                        front.energyPaid = Math.min(front.energyRequired, front.energyPaid + healWork);
                        didWork = true;
                    }
                    sp.spawnQueue[0] = front;

                    if (didWork) {
                        u.healerHasMaterial = false;
                        u._healerQueueTripCost = 0;
                        u.workerTransferCooldown = getWorkerTypeTransferCooldownTicks('healer', u);
                        if (sp.owner === localPlayerId && _noteAmbientSoundTick(sp, 'heal_tick', 12)) playSound('heal_tick', sp.x, sp.y);
                    }

                    let cooldown = Math.max(1, Math.round(sp.spawnCooldown || 1));
                    if (sp.spawnTimer >= cooldown && front.energyPaid >= front.energyRequired && !Number.isFinite(sp._spawnReadyOrder)) {
                        sp._spawnReadyOrder = globalSpawnerReadyOrderCounter++;
                    }

                    if (!_isHealerQueueTarget(sp, owner)) {
                        _clearWorkerTarget(u, 'target_no_work');
                        if (!runHealerRetargetIfDue()) {
                            u.workerState = 'IDLE';
                            u.commandState = CMD_IDLE;
                        }
                        return;
                    }

                    let route = getSpawnerRoute('healer_spawner', null);
                    let tripCost = _getHealerQueueTripCost(u, sp);
                    if (route && players[owner].energy >= tripCost && tripCost > 0) {
                        u.workerState = 'RETURNING_FOR_GOLD';
                        u.path = route.path;
                        u.pathIndex = 0; u.commandState = CMD_MOVING;
                        u._healerSpawnerTarget = route.spawner;
                        u._healerQueueTripCost = tripCost;
                    } else {
                        if (tripCost > 0 && players[owner].energy < tripCost) u._energyBlockedUntil = gameTime + _getEnergyBlockedGlyphTicks();
                        u.workerState = 'IDLE';
                        u.commandState = CMD_IDLE;
                    }
                    return;
                }

                u.workerState = 'HEALING';
                let baseHeal = Number((BASE_UNIT_STATS[u.unitType] || {}).healerDps) || Number(UNIT_FORMULA_CONFIG.workerSpecialistBaseRate) || 1;
                let dps = u.healerDps || baseHeal;
                u.workerTarget.energy = Math.min(u.workerTarget.maxEnergy, u.workerTarget.energy + dps);
                u.healerHasMaterial = false;
                u.workerTransferCooldown = getWorkerTypeTransferCooldownTicks('healer', u);
                if (u.workerTarget.owner === localPlayerId && _noteAmbientSoundTick(u.workerTarget, 'heal_tick', 12)) playSound('heal_tick', u.workerTarget.x, u.workerTarget.y);

                if (!_isHealerTargetUnit(u.workerTarget, owner)) {
                    _clearWorkerTarget(u, 'target_no_work');
                    if (!runHealerRetargetIfDue()) {
                        u.workerState = 'IDLE';
                        u.commandState = CMD_IDLE;
                    }
                    return;
                }

                let route = getSpawnerRoute('healer_spawner', null);
                if (route && players[owner].energy >= 1) {
                    u.workerState = 'RETURNING_FOR_GOLD';
                    u.path = route.path;
                    u.pathIndex = 0; u.commandState = CMD_MOVING;
                    u._healerSpawnerTarget = route.spawner;
                } else {
                    u._energyBlockedUntil = gameTime + _getEnergyBlockedGlyphTicks();
                    u.workerState = 'IDLE';
                    u.commandState = CMD_IDLE;
                }
            }
        } else if (u.workerState === 'RETURNING_FOR_GOLD') {
            let targetIsQueue = (u.workerTargetType === 'queue');
            if (targetIsQueue ? !_isHealerQueueTarget(u.workerTarget, owner) : !_isHealerTargetUnit(u.workerTarget, owner)) {
                if (targetIsQueue) _clearHealerQueueCommit(u);
                _clearWorkerTarget(u, 'target_no_work');
                u._healerQueueTripCost = 0;
                if (!runHealerRetargetIfDue()) {
                    u.workerState = 'IDLE';
                    u.commandState = CMD_IDLE;
                }
                return;
            }
            if (!u.path || u.pathIndex >= u.path.length) {
                let spawner = u._healerSpawnerTarget || _findClosestHealerSpawner(u);
                let dist = spawner ? Math.hypot(spawner.x - u.x, spawner.y - u.y) : 0;
                if (!spawner || dist <= 24) {
                    if (u.workerTransferCooldown > 0) return;
                    let tripCost = targetIsQueue ? _getHealerQueueTripCost(u, u.workerTarget) : 1;
                    if (spawner && tripCost > 0 && players[owner].energy >= tripCost) {
                        players[owner].energy -= tripCost;
                        recordEnergyDelta(owner, 'healer', -tripCost);
                        u.healerHasMaterial = true;
                        u._healerQueueTripCost = targetIsQueue ? tripCost : 0;
                        u.workerTransferCooldown = getWorkerTypeTransferCooldownTicks('healer', u);
                        if (canRunHeavyAi) {
                            // After pickup, re-evaluate best heal target (queue or unit) from current location.
                            _healerFindTarget(u, myGx, myGy);
                            return;
                        }
                    } else if (tripCost > 0) {
                        u._energyBlockedUntil = gameTime + _getEnergyBlockedGlyphTicks();
                    }
                    u._healerSpawnerTarget = null;
                    u.workerState = 'MOVING_TO_HEAL';
                    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
                    let targetGx = Math.floor(u.workerTarget.x / TILE), targetGy = Math.floor(u.workerTarget.y / TILE);
                    u.path = _requestWorkerPath(u, startGx, startGy, targetGx, targetGy, null, null);
                    u.pathIndex = 0; u.commandState = CMD_MOVING;
                } else {
                    let route = getSpawnerRoute('healer_spawner', null);
                    if (route) {
                        u._healerSpawnerTarget = route.spawner;
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
            if (!shouldRunWorkerIdleRetarget(u, canRunHeavyAi)) return;
            let target = _findNearestResearchBuildingNeedingWork(u);
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
        } else if (u.workerState === 'MOVING_TO_RESEARCH') {
            if (!_isResearcherTargetBuilding(u.workerTarget, owner)) {
                _clearWorkerTarget(u, 'target_no_work');
                u.workerState = 'IDLE';
                u.commandState = CMD_IDLE;
                return;
            }
            if (!u.path || u.pathIndex >= u.path.length) {
                let target = u.workerTarget;
                let dist = Math.hypot(target.x - u.x, target.y - u.y);
                if (dist > 24) {
                    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
                    u.path = _requestWorkerPath(u, startGx, startGy, target.gx, target.gy, null, null);
                    u.pathIndex = 0;
                    u.commandState = CMD_MOVING;
                    return;
                }
                if (!u.researcherHasMaterial) {
                    // If we're already next to a research lab, pick material here and wait normal transfer cooldown.
                    let sourceLab = _findClosestSpawner(u, 'research');
                    let sourceDist = sourceLab ? Math.hypot(sourceLab.x - u.x, sourceLab.y - u.y) : Infinity;
                    if (sourceLab && sourceDist <= 24) {
                        if (u.workerTransferCooldown > 0) return;
                        _researcherTryPickupMaterial(u, target, owner);
                        return;
                    }

                    let route = getSpawnerRoute('research', null);
                    if (route) {
                        u.workerState = 'RETURNING_FOR_GOLD';
                        u.path = route.path;
                        u.pathIndex = 0;
                        u.commandState = CMD_MOVING;
                        u._researchSpawnerTarget = route.spawner;
                    } else {
                        u.workerState = 'IDLE';
                        u.commandState = CMD_IDLE;
                    }
                    return;
                }
                let materialReadyTick = Number.isFinite(u._researcherMaterialReadyTick) ? u._researcherMaterialReadyTick : 0;
                if (gameTime < materialReadyTick) return;
                if (u.workerTransferCooldown > 0) return;

                u.workerState = 'RESEARCHING';
                let task = target.researchTask;
                if (!task) {
                    _clearWorkerTarget(u, 'target_no_work');
                    u.workerState = 'IDLE';
                    u.commandState = CMD_IDLE;
                    return;
                }

                let fallbackDps = Math.max(0.1, Number(u.researcherDps || target.getResearcherDps() || 0));
                let fallbackWork = Math.max(0.1, fallbackDps * getResearchBuildingEfficiency(target));
                let tripWork = Number.isFinite(u._researcherTripWork) && u._researcherTripWork > 0 ? u._researcherTripWork : fallbackWork;
                let remainingWork = Math.max(0, (task.workRequired || 0) - (task.workDone || 0));
                let appliedWork = Math.min(remainingWork, tripWork);
                if (appliedWork > 0) task.workDone = Math.min(task.workRequired, (task.workDone || 0) + appliedWork);
                u.researcherHasMaterial = false;
                u._researcherTripWork = 0;
                u._researcherTripCost = 0;
                u._researcherMaterialReadyTick = 0;
                u.workerTransferCooldown = getWorkerTypeTransferCooldownTicks('researcher', u);
                if (appliedWork > 0 && target.owner === localPlayerId && _noteAmbientSoundTick(target, 'research_tick', 12)) playSound('research_tick', target.x, target.y);

                if (task.workDone >= task.workRequired) {
                    completeActiveResearchTaskForPlayer(target.owner, task);
                    target.researchTask = getPlayerResearchTask(target.owner);
                    target.isResearching = !!(isAutoResearchEnabled(target) && !target.isUpgrading && target.researchTask && target.researchTask.workDone < target.researchTask.workRequired);
                    if (target.owner === localPlayerId) playSound('upgrade_complete', target.x, target.y);
                }

                if (!_isResearcherTargetBuilding(target, owner)) {
                    _clearWorkerTarget(u, 'target_no_work');
                    u.workerState = 'IDLE';
                    u.commandState = CMD_IDLE;
                    return;
                }

                // Stay on research target; next loop will pick material again when cooldown allows.
                u.workerState = 'MOVING_TO_RESEARCH';
                u.commandState = CMD_IDLE;
            }
        } else if (u.workerState === 'RETURNING_FOR_GOLD') {
            if (!_isResearcherTargetBuilding(u.workerTarget, owner)) {
                _clearWorkerTarget(u, 'target_no_work');
                u.workerState = 'IDLE';
                u.commandState = CMD_IDLE;
                return;
            }
            if (!u.path || u.pathIndex >= u.path.length) {
                let spawner = u._researchSpawnerTarget || _findClosestSpawner(u, 'research');
                let dist = spawner ? Math.hypot(spawner.x - u.x, spawner.y - u.y) : 0;
                if (!spawner || dist <= 24) {
                    if (u.workerTransferCooldown > 0) return;
                    if (spawner) _researcherTryPickupMaterial(u, u.workerTarget, owner);
                    if (u.researcherHasMaterial && canRunHeavyAi) {
                        // After pickup, re-evaluate nearest active lab so researchers follow changing demand.
                        let retarget = _findNearestResearchBuildingNeedingWork(u);
                        if (retarget && _setWorkerTarget(u, retarget, 'research')) {
                            u.workerState = 'MOVING_TO_RESEARCH';
                            let startGx2 = Math.floor(u.x / TILE), startGy2 = Math.floor(u.y / TILE);
                            let targetGx2 = Math.floor(retarget.x / TILE), targetGy2 = Math.floor(retarget.y / TILE);
                            u.path = _requestWorkerPath(u, startGx2, startGy2, targetGx2, targetGy2, null, null);
                            u.pathIndex = 0;
                            u.commandState = CMD_MOVING;
                            u._researchSpawnerTarget = null;
                            return;
                        }
                    }
                    u._researchSpawnerTarget = null;
                    u.workerState = 'MOVING_TO_RESEARCH';
                    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
                    let targetGx = Math.floor(u.workerTarget.x / TILE), targetGy = Math.floor(u.workerTarget.y / TILE);
                    u.path = _requestWorkerPath(u, startGx, startGy, targetGx, targetGy, null, null);
                    u.pathIndex = 0;
                    u.commandState = CMD_MOVING;
                } else {
                    let route = getSpawnerRoute('research', null);
                    if (route) {
                        u._researchSpawnerTarget = route.spawner;
                        u.path = route.path;
                        u.pathIndex = 0;
                        u.commandState = CMD_MOVING;
                    } else {
                        u._researchSpawnerTarget = null;
                        u.workerState = 'IDLE';
                        u.commandState = CMD_IDLE;
                    }
                }
            }
        } else if (u.workerState === 'RESEARCHING') {
            u.workerState = 'MOVING_TO_RESEARCH';
        }
    }
}

function _isCollectorTargetValid(target, targetType, owner) {
    if (!target) return false;
    if (targetType === 'mine') {
        return Number.isFinite(target.gold) && target.gold > 0;
    }
    if (targetType === 'farm') {
        return target.type === 'farm' && target.owner === owner && !target.underConstruction && target.energy > 0;
    }
    if (targetType === 'drop') {
        return getDroppedItemAt(target.gx, target.gy) === target;
    }
    return false;
}

function _collectorRememberGatherSite(u, target = null, targetType = null) {
    if (!u || !target) return;
    if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
        u._collectorLastGatherX = target.x;
        u._collectorLastGatherY = target.y;
    }
    if (Number.isFinite(target.gx) && Number.isFinite(target.gy)) {
        u._collectorLastGatherGx = target.gx;
        u._collectorLastGatherGy = target.gy;
    }
    if (targetType) u._collectorLastGatherType = targetType;
}

function _isCollectorSpawnerValidForUnit(u, spawner) {
    if (!u || !spawner) return false;
    return spawner.type === 'spawner'
        && spawner.owner === u.owner
        && spawner.energy > 0
        && !spawner.underConstruction;
}

function _collectorGetSearchOrigin(u) {
    if (u && u.workerState === 'IDLE' && (gameTime - (u._lastIdleStateTime || 0)) < secondsToTicks(5)) {
        return { x: u.x, y: u.y };
    }
    if (u && Number.isFinite(u._collectorLastGatherX) && Number.isFinite(u._collectorLastGatherY)) {
        return { x: u._collectorLastGatherX, y: u._collectorLastGatherY };
    }
    return { x: u.x, y: u.y };
}

function _getCollectorGatherTargetAt(gx, gy, owner, preferredType = null) {
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) return null;
    if (preferredType === 'mine' || preferredType === null) {
        let mine = getGoldMineAt(gx, gy);
        if (mine && mine.gold <= 0) mine = null;
        if (mine) return { target: mine, type: 'mine' };
    }
    if (preferredType === 'farm' || preferredType === null) {
        if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H) {
            let cell = grid[gy][gx];
            let item = cell && cell.item;
            if (item && item.type === 'farm' && item.owner === owner && !item.underConstruction && item.energy > 0) {
                return { target: item, type: 'farm' };
            }
        }
    }
    return null;
}

function _getCollectorGatherTargetNear(worldX, worldY, owner, radius = 22) {
    let best = null;
    let bestDist = radius;

    // Mine lookup is tile-indexed, so check only nearby tiles instead of scanning all mines.
    let gx = Math.floor(worldX / TILE), gy = Math.floor(worldY / TILE);
    let mineTileRadius = Math.max(1, Math.ceil(radius / TILE));
    let mineMinGx = Math.max(0, gx - mineTileRadius), mineMaxGx = Math.min(GRID_W - 1, gx + mineTileRadius);
    let mineMinGy = Math.max(0, gy - mineTileRadius), mineMaxGy = Math.min(GRID_H - 1, gy + mineTileRadius);
    for (let y = mineMinGy; y <= mineMaxGy; y++) {
        for (let x = mineMinGx; x <= mineMaxGx; x++) {
            let m = getGoldMineAt(x, y);
            if (!m || m.gold <= 0) continue;
            let d = Math.hypot(m.x - worldX, m.y - worldY);
            if (d <= bestDist) {
                bestDist = d;
                best = { target: m, type: 'mine' };
            }
        }
    }

    let minGx = Math.max(0, gx - 1), maxGx = Math.min(GRID_W - 1, gx + 1);
    let minGy = Math.max(0, gy - 1), maxGy = Math.min(GRID_H - 1, gy + 1);
    for (let y = minGy; y <= maxGy; y++) {
        for (let x = minGx; x <= maxGx; x++) {
            let cell = grid[y][x];
            let item = cell && cell.item;
            if (!item || item.type !== 'farm' || item.owner !== owner || item.underConstruction || item.energy <= 0) continue;
            let d = Math.hypot(item.x - worldX, item.y - worldY);
            if (d <= bestDist) {
                bestDist = d;
                best = { target: item, type: 'farm' };
            }
        }
    }
    return best;
}

function _isAstarCollectorTargetValid(target, targetType, owner) {
    if (!target) return false;
    if (targetType === 'astar_mine') {
        return Number.isFinite(target.astar) && target.astar > 0;
    }
    if (targetType === 'astar_farm') {
        return target.type === 'astar_farm' && target.owner === owner && !target.underConstruction && target.energy > 0;
    }
    return false;
}

function _getAstarCollectorGatherTargetAt(gx, gy, owner, preferredType = null) {
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) return null;
    if (preferredType === 'astar_mine' || preferredType === null) {
        let mine = getAstarMineAt(gx, gy);
        if (mine && mine.astar <= 0) mine = null;
        if (mine) return { target: mine, type: 'astar_mine' };
    }
    if (preferredType === 'astar_farm' || preferredType === null) {
        if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H) {
            let cell = grid[gy][gx];
            let item = cell && cell.item;
            if (item && item.type === 'astar_farm' && item.owner === owner && !item.underConstruction && item.energy > 0) {
                return { target: item, type: 'astar_farm' };
            }
        }
    }
    return null;
}

function _getAstarCollectorGatherTargetNear(worldX, worldY, owner, radius = 22) {
    let best = null;
    let bestDist = radius;

    let gx = Math.floor(worldX / TILE), gy = Math.floor(worldY / TILE);
    let mineTileRadius = Math.max(1, Math.ceil(radius / TILE));
    let mineMinGx = Math.max(0, gx - mineTileRadius), mineMaxGx = Math.min(GRID_W - 1, gx + mineTileRadius);
    let mineMinGy = Math.max(0, gy - mineTileRadius), mineMaxGy = Math.min(GRID_H - 1, gy + mineTileRadius);
    for (let y = mineMinGy; y <= mineMaxGy; y++) {
        for (let x = mineMinGx; x <= mineMaxGx; x++) {
            let m = getAstarMineAt(x, y);
            if (!m || m.astar <= 0) continue;
            let d = Math.hypot(m.x - worldX, m.y - worldY);
            if (d <= bestDist) {
                bestDist = d;
                best = { target: m, type: 'astar_mine' };
            }
        }
    }

    let minGx = Math.max(0, gx - 1), maxGx = Math.min(GRID_W - 1, gx + 1);
    let minGy = Math.max(0, gy - 1), maxGy = Math.min(GRID_H - 1, gy + 1);
    for (let y = minGy; y <= maxGy; y++) {
        for (let x = minGx; x <= maxGx; x++) {
            let cell = grid[y][x];
            let item = cell && cell.item;
            if (!item || item.type !== 'astar_farm' || item.owner !== owner || item.underConstruction || item.energy <= 0) continue;
            let d = Math.hypot(item.x - worldX, item.y - worldY);
            if (d <= bestDist) {
                bestDist = d;
                best = { target: item, type: 'astar_farm' };
            }
        }
    }
    return best;
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
        if (!_canAssignWorkerTargetExclusive(u, candidate, candidateType)) return false;

        let originDist = Math.sqrt(originDistSq);
        let spawnerDist = anchorSpawner
            ? Math.hypot(candidate.x - anchorSpawner.x, candidate.y - anchorSpawner.y)
            : Math.hypot(candidate.x - u.x, candidate.y - u.y);

        candidates.push({
            target: candidate,
            targetType: candidateType,
            dist: spawnerDist + originDist * 0.22 + dropPenalty,
            worldDist: Math.hypot(candidate.x - u.x, candidate.y - u.y)
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
    return hasActiveGoldMineAt(nx, ny) || hasActiveAstarMineAt(nx, ny);
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
    for (let y = 0; y < GRID_H; y++) {
        let row = grid[y];
        for (let x = 0; x < GRID_W; x++) {
            let cell = row[x];
            if (cell && cell.item) consider(cell.item);
        }
    }

    _activeBuilderWorkCacheTick = gameTime;
}

function _ensureActiveBuilderWorkCacheCurrent() {
    if (_activeBuilderWorkCacheTick !== gameTime) _rebuildActiveBuilderWorkCache();
}

function _hasUnderConstructionOrUpgradingAt(nx, ny) {
    if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) return false;
    _ensureActiveBuilderWorkCacheCurrent();
    return _activeBuilderPathTiles.has(_builderWorkTileKey(nx, ny));
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

function getBuilderTripGoldCost(u) {
    let dps = Number(u && u.builderDps);
    if (!Number.isFinite(dps) || dps <= 0) dps = 5;
    return Math.max(1, Math.round(dps));
}

function getWorkerUnitTypeFromWorkerType(workerType) {
    if (workerType === 'collector') return 'collector';
    if (workerType === 'astar_collector') return 'astar_collector';
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
    let sec = Number.isFinite(lvl) ? getUnitStatForOwner(owner, unitType, lvl, 'transferCooldown') : NaN;
    if (!Number.isFinite(sec) || sec <= 0) sec = Number((BASE_UNIT_STATS[unitType] || {}).transferCooldown);
    if (!Number.isFinite(sec) || sec <= 0) sec = 0.01;
    return Math.max(0.01, sec);
}

function getBuilderTransferCooldownTicks(unit = null) {
    return secondsToTicks(getWorkerTransferCooldownSeconds('builder', unit));
}

function getWorkerTypeTransferCooldownTicks(workerType, unit = null) {
    if (workerType === 'builder') return getBuilderTransferCooldownTicks(unit);
    if (workerType === 'collector' || workerType === 'astar_collector' || workerType === 'salvager' || workerType === 'healer' || workerType === 'researcher') {
        return secondsToTicks(getWorkerTransferCooldownSeconds(workerType, unit));
    }
    return secondsToTicks(getWorkerTransferCooldownSeconds(workerType, unit));
}

function getWorkerIdleRetargetTicks() {
    return Math.max(30, Math.floor(TICK_RATE * 3));
}

function shouldRunWorkerIdleRetarget(u, canRunHeavyAi) {
    if (!u) return false;
    let interval = getWorkerIdleRetargetTicks();
    if (!Number.isFinite(u._workerNextIdleRetargetTick)) {
        u._workerNextIdleRetargetTick = gameTime + interval;
    }
    if (canRunHeavyAi) {
        u._workerNextIdleRetargetTick = gameTime + interval;
        return true;
    }
    if (gameTime >= u._workerNextIdleRetargetTick) {
        u._workerNextIdleRetargetTick = gameTime + interval;
        return true;
    }
    return false;
}

function _getWorkerVisionRangePx(u) {
    let visTiles = Number(u && u.visionRange);
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
    let sourceAreaId = getAreaIdAtWorld(originX, originY);
    if (sourceAreaId < 0) return false;
    let targetAreaId = Number.isFinite(target.areaId)
        ? Math.floor(target.areaId)
        : getAreaIdAtWorld(target.x, target.y);
    if (targetAreaId < 0) return false;
    let areaDistance = getAreaDistance(sourceAreaId, targetAreaId);
    if (areaDistance < 0) return false;
    return areaDistance <= Math.floor(Math.max(0, Number(maxSearchArea) || 0));
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
    if (Number.isFinite(target.effectiveLevel)) return Math.max(0, Math.floor(target.effectiveLevel));
    if (Number.isFinite(target.level)) return Math.max(0, Math.floor(target.level));
    let maxSearchArea = _getWorkerAutoSearchDistanceArea(u);
    return 1;
}

// Per-target worker load counters (updated on target set/clear).
let workerReservedTiles = [];
const _WORKER_TARGET_LOAD_TYPE_COUNT = 6;

function _workerTypeToLoadIndex(workerType) {
    switch (workerType) {
        case 'collector': return 0;
        case 'astar_collector': return 1;
        case 'salvager': return 2;
        case 'builder': return 3;
        case 'healer': return 4;
        case 'researcher': return 5;
    }
    return -1;
}

function _getWorkerTargetTileIndex(target) {
    if (!target) return null;
    let gx = Number.isFinite(target.gx) ? Math.floor(target.gx) : Math.floor((Number(target.x) || 0) / TILE);
    let gy = Number.isFinite(target.gy) ? Math.floor(target.gy) : Math.floor((Number(target.y) || 0) / TILE);
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
        if (slotIndex >= 0) workerReservedTiles[slotIndex] = null;
        return null;
    }
    return reservedUnit;
}

function _invalidateWorkerTargetLoadCache() {
    workerReservedTiles = new Array(Math.max(0, GRID_W * GRID_H * _WORKER_TARGET_LOAD_TYPE_COUNT)).fill(null);
}

function _setWorkerTarget(unit, target, targetType = null) {
    if (!unit) return false;
    let nextType = (targetType === undefined) ? null : targetType;
    if (unit.workerTarget === target && unit.workerTargetType === nextType) return true;

    let nextSlotIndex = target ? _getWorkerReservationSlotIndex(target, unit.workerType) : -1;
    if (nextSlotIndex >= 0) {
        let reservedUnit = workerReservedTiles[nextSlotIndex];
        if (reservedUnit && reservedUnit !== unit && !reservedUnit.dead && reservedUnit.owner === unit.owner && reservedUnit.workerType === unit.workerType) return false;
    }

    let prevTarget = unit.workerTarget;
    if (prevTarget) {
        let prevSlotIndex = Number.isFinite(unit._workerReservedTileIndex) ? Math.floor(unit._workerReservedTileIndex) : -1;
        if (prevSlotIndex >= 0 && workerReservedTiles[prevSlotIndex] === unit) workerReservedTiles[prevSlotIndex] = null;
    }

    unit.workerTarget = target;
    unit.workerTargetType = nextType;
    unit._workerReservedTileIndex = -1;
    if (target && nextSlotIndex >= 0) {
        workerReservedTiles[nextSlotIndex] = unit;
        unit._workerReservedTileIndex = nextSlotIndex;
    }
    return true;
}

function _clearWorkerTarget(unit, reason = null) {
    if (!unit) return;
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
        if (prevSlotIndex >= 0 && workerReservedTiles[prevSlotIndex] === unit) workerReservedTiles[prevSlotIndex] = null;
    }

    unit.workerTarget = null;
    unit.workerTargetType = null;
    unit._workerReservedTileIndex = -1;
}

function _workerTargetTypeNeedsExclusive(workerType, targetType = null) {
    return true;
}

function _canAssignWorkerTargetExclusive(u, target, targetType = null) {
    if (!u || !target || !u.workerType) return false;
    if (u.workerTarget === target && (targetType === null || u.workerTargetType === targetType)) return true;
    let reservedUnit = _getReservedWorkerForTarget(target, u.workerType);
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

    let gx = Number.isFinite(candidate.target && candidate.target.gx) ? candidate.target.gx : Math.floor((candidate.target && candidate.target.x || 0) / TILE);
    let gy = Number.isFinite(candidate.target && candidate.target.gy) ? candidate.target.gy : Math.floor((candidate.target && candidate.target.y || 0) / TILE);
    let seed = ((u.id * 1103515245 + gx * 12345 + gy * 54321) >>> 0) % 1024;
    score += (seed / 1024) * TILE * 0.35;
    return score;
}

function _pickDistributedWorkerCandidate(u, candidates) {
    if (!u || !Array.isArray(candidates) || candidates.length <= 0) return null;

    let best = null;
    let bestScore = Infinity;
    for (let c of candidates) {
        if (!c || !c.target) continue;
        let targetType = (c.targetType !== undefined) ? c.targetType : null;
        if (_workerTargetTypeNeedsExclusive(u.workerType, targetType) && !_canAssignWorkerTargetExclusive(u, c.target, targetType)) continue;
        let score = _scoreWorkerTaskCandidate(u, c);
        if (score < bestScore) {
            bestScore = score;
            best = c;
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
    if (unit.workerType === 'collector') return _collectorCanWalk;
    if (unit.workerType === 'astar_collector') return _astarCollectorCanWalk;
    if (unit.workerType === 'builder') return _builderCanWalk(unit.owner);
    return null;
}

function applyWorkerRallyFromSpawner(u, spawner) {
    if (!u || !spawner || !u.workerType) return false;
    let rally = getSpawnerRallyTargetWorld(spawner);
    if (!rally) return false;
    let rgx = Math.floor(rally.x / TILE), rgy = Math.floor(rally.y / TILE);
    issueWorkerBlockedAssignFallbackMove(u, rgx, rgy);
    return true;
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

function _isBuilderWorkTarget(target, owner, allowDisabledBuild = false) {
    if (!target) return false;
    if (target.owner !== owner) return false;
    if (target.markedForSalvage) return false;
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
    return { x: u.x, y: u.y };
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
            let d = Math.hypot(t.x - worldX, t.y - worldY);
            if (d <= bestDist) {
                bestDist = d;
                best = t;
            }
        }
    }
    return best;
}

function _collectorAssignTarget(u, target, targetType, myGx, myGy) {
    if (!_setWorkerTarget(u, target, targetType)) {
        u.workerState = 'IDLE';
        u.commandState = CMD_IDLE;
        return;
    }
    let canWalk = targetType === 'mine' ? _collectorCanWalk : null;
    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
    u.path = _requestWorkerPath(u, startGx, startGy, target.gx, target.gy, canWalk, null, true);
    if (u.path) {
        _collectorRememberGatherSite(u, target, targetType);
        u.workerState = 'MOVING_TO'; u.pathIndex = 0; u.commandState = CMD_MOVING;
    }
    else if (_workerHasPendingAutoRouteToTarget(u, target)) {
        _collectorRememberGatherSite(u, target, targetType);
        u.workerState = 'MOVING_TO';
    }
    else { _clearWorkerAutoRoute(u); _clearWorkerTarget(u); u.workerState = 'IDLE'; u.commandState = CMD_IDLE; }
}

function _collectorAssignMine(u, mine, myGx, myGy) {
    _collectorAssignTarget(u, mine, 'mine', myGx, myGy);
}

function _astarCollectorCanWalk(nx, ny) {
    return hasActiveGoldMineAt(nx, ny) || hasActiveAstarMineAt(nx, ny);
}

function _astarCollectorRememberGatherSite(u, target = null) {
    if (!u || !target) return;
    if (Number.isFinite(target.x) && Number.isFinite(target.y)) {
        u._astarLastGatherX = target.x;
        u._astarLastGatherY = target.y;
    }
    if (Number.isFinite(target.gx) && Number.isFinite(target.gy)) {
        u._astarLastGatherGx = target.gx;
        u._astarLastGatherGy = target.gy;
    }
}

function _astarCollectorGetSearchOrigin(u) {
    if (u && Number.isFinite(u._astarLastGatherX) && Number.isFinite(u._astarLastGatherY)) {
        return { x: u._astarLastGatherX, y: u._astarLastGatherY };
    }
    return { x: u.x, y: u.y };
}

function _astarCollectorAssignTarget(u, target, targetType) {
    if (!_setWorkerTarget(u, target, targetType)) {
        u.workerState = 'IDLE';
        u.commandState = CMD_IDLE;
        return;
    }
    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);
    let canWalk = targetType === 'astar_mine' ? _astarCollectorCanWalk : null;
    u.path = _requestWorkerPath(u, startGx, startGy, target.gx, target.gy, canWalk, 'astar_collector', true);
    if (u.path) {
        _astarCollectorRememberGatherSite(u, target);
        u.workerState = 'MOVING_TO_ASTAR';
        u.pathIndex = 0;
        u.commandState = CMD_MOVING;
    } else if (_workerHasPendingAutoRouteToTarget(u, target)) {
        _astarCollectorRememberGatherSite(u, target);
        u.workerState = 'MOVING_TO_ASTAR';
    } else {
        _clearWorkerAutoRoute(u);
        _clearWorkerTarget(u);
        u.workerState = 'IDLE';
        u.commandState = CMD_IDLE;
    }
}

function _astarCollectorAssignMine(u, mine) {
    _astarCollectorAssignTarget(u, mine, 'astar_mine');
}

function _astarCollectorFindTarget(u) {
    if (_isAstarCollectorTargetValid(u._astarPinnedTarget, u._astarPinnedTargetType, u.owner)
        && _canAssignWorkerTargetExclusive(u, u._astarPinnedTarget, u._astarPinnedTargetType)) {
        _astarCollectorAssignTarget(u, u._astarPinnedTarget, u._astarPinnedTargetType);
        return;
    }
    u._astarPinnedTarget = null;
    u._astarPinnedTargetType = null;

    let origin = _astarCollectorGetSearchOrigin(u);
    let maxSearchArea = _getWorkerAutoSearchDistanceArea(u);
    let anchorSpawner =
        (u._astarNextSpawner
            && u._astarNextSpawner.type === 'astar_spawner'
            && u._astarNextSpawner.owner === u.owner
            && u._astarNextSpawner.energy > 0
            && !u._astarNextSpawner.underConstruction)
            ? u._astarNextSpawner
            : _findClosestSpawner(u, 'astar_spawner');

    let candidates = [];

    forEachGridCellInAreaRange(origin.x, origin.y, maxSearchArea, (tileRef, cell) => {
        if (!tileRef || !cell) return false;

        let x = tileRef.x;
        let y = tileRef.y;
        let worldX = x * TILE + TILE * 0.5;
        let worldY = y * TILE + TILE * 0.5;
        let dx = worldX - origin.x;
        let dy = worldY - origin.y;
        let originDistSq = dx * dx + dy * dy;

        let mine = getAstarMineAt(x, y);
        let item = cell.item;

        let candidate = null;
        let candidateType = null;

        if (mine && mine.astar > 0) {
            candidate = mine;
            candidateType = 'astar_mine';
        } else if (item && item.type === 'astar_farm' && item.owner === u.owner && !item.underConstruction && item.energy > 0) {
            candidate = item;
            candidateType = 'astar_farm';
        }

        if (!candidate) return false;
        if (!_isTargetWithinWorkerSearchLimits(u, origin.x, origin.y, candidate, maxSearchArea)) return false;
        if (!_canAssignWorkerTargetExclusive(u, candidate, candidateType)) return false;

        let originDist = Math.sqrt(originDistSq);
        let spawnerDist = anchorSpawner
            ? Math.hypot(candidate.x - anchorSpawner.x, candidate.y - anchorSpawner.y)
            : Math.hypot(candidate.x - u.x, candidate.y - u.y);

        candidates.push({
            target: candidate,
            targetType: candidateType,
            dist: spawnerDist + originDist * 0.22,
            worldDist: Math.hypot(candidate.x - u.x, candidate.y - u.y)
        });
        return false;
    });

    let picked = _pickDistributedWorkerCandidate(u, candidates);
    if (picked && picked.target) {
        _astarCollectorAssignTarget(u, picked.target, picked.targetType !== undefined ? picked.targetType : null);
        return;
    }

    if (anchorSpawner) u._astarNextSpawner = anchorSpawner;
    u.workerState = 'IDLE';
    u.commandState = CMD_IDLE;
}

// Salvager: find nearest marked building
function _salvagerFindTarget(u, myGx, myGy) {
    let owner = u.owner;
    let maxSearch = _getWorkerAutoSearchDistancePx(u);
    let maxSearchArea = _getWorkerAutoSearchDistanceArea(u);
    let bestDist = 99999, bestItem = null;
    let spawnerSet = new Set(collectorSpawners);
    for (let t of towers) { if (t.owner === owner && t.markedForSalvage && _canAssignWorkerTargetExclusive(u, t, null)) { if (!_isTargetWithinWorkerSearchLimits(u, u.x, u.y, t, maxSearchArea)) continue; let d = Math.hypot(t.x - u.x, t.y - u.y); if (d > maxSearch) continue; if (d < bestDist) { bestDist = d; bestItem = t; } } }
    for (let b of barracks) { if (b.owner === owner && b.markedForSalvage && _canAssignWorkerTargetExclusive(u, b, null)) { if (!_isTargetWithinWorkerSearchLimits(u, u.x, u.y, b, maxSearchArea)) continue; let d = Math.hypot(b.x - u.x, b.y - u.y); if (d > maxSearch) continue; if (d < bestDist) { bestDist = d; bestItem = b; } } }
    for (let s of collectorSpawners) { if (s.owner === owner && s.markedForSalvage && _canAssignWorkerTargetExclusive(u, s, null)) { if (!_isTargetWithinWorkerSearchLimits(u, u.x, u.y, s, maxSearchArea)) continue; let d = Math.hypot(s.x - u.x, s.y - u.y); if (d > maxSearch) continue; if (d < bestDist) { bestDist = d; bestItem = s; } } }
    forEachGridCellInAreaRange(u.x, u.y, maxSearchArea, (tileRef, c) => {
        if (!tileRef || !c || !c.item) return false;
        if (c.owner !== owner || !c.item.markedForSalvage) return false;
        if (c.item instanceof Barrack || spawnerSet.has(c.item)) return false;
        if (!_canAssignWorkerTargetExclusive(u, c.item, null)) return false;
        let d = Math.hypot(c.item.x - u.x, c.item.y - u.y);
        if (d > maxSearch) return false;
        if (d < bestDist) {
            bestDist = d;
            bestItem = c.item;
        }
        return false;
    });
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
        target = _findNearestUnderConstruction(u, origin.x, origin.y);
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
    let route = _findBestSpawnerRoute(u, 'builder_spawner', null);
    let tripCost = getBuilderTripGoldCost(u);
    if (route && players[u.owner].energy >= tripCost) {
        u.workerState = 'RETURNING_FOR_GOLD';
        u.path = route.path;
        u.pathIndex = 0; u.commandState = CMD_MOVING;
        u._builderSpawnerTarget = route.spawner;
    } else {
        // No spawner or no energy - go build directly (slow mode)
        u.workerState = 'MOVING_TO_BUILD';
        u.path = _requestWorkerPath(u, startGx, startGy, target.gx, target.gy, canWalk, 'builder', true);
        u.pathIndex = 0; u.commandState = CMD_MOVING;
    }
}

function _findBestSpawnerRoute(u, type, canWalk = null, options = null) {
    let cacheOnly = !!(options && options.cacheOnly);
    let bestSpawner = null;
    let bestPath = null;
    let bestScore = Infinity;
    let startGx = Math.floor(u.x / TILE), startGy = Math.floor(u.y / TILE);

    let movementProfile = _resolveMovementProfile(!!u.isFlying, canWalk, null);
    let routeKey = null;
    if (movementProfile) {
        routeKey = 'spawner|' + type + '|' + u.owner + '|' + movementProfile + '|' + startGx + ',' + startGy;
        let cached = sharedSpawnerRouteCache.get(routeKey);
        if (cached && !_isPathCacheExpired(cached, SPAWNER_ROUTE_CACHE_TTL_TICKS)) {
            let s = cached.spawner;
            if (s && s.type === type && s.owner === u.owner && s.energy > 0 && !s.underConstruction && cached.path && cached.path.length > 0) {
                return { spawner: s, path: cached.path };
            }
        }
        if (cacheOnly) return null;
    } else if (cacheOnly) {
        return null;
    }

    for (let s of collectorSpawners) {
        if (s.type !== type || s.owner !== u.owner || s.energy <= 0 || s.underConstruction) continue;
        let path = _requestWorkerPath(u, startGx, startGy, s.gx, s.gy, canWalk, null);
        if (!path || path.length === 0) continue;
        let score = Math.max(0, path.length - 1);
        if (score < bestScore) {
            bestScore = score;
            bestSpawner = s;
            bestPath = path;
        }
    }

    if (!bestSpawner || !bestPath) return null;
    if (routeKey) {
        sharedSpawnerRouteCache.set(routeKey, {
            spawner: bestSpawner,
            path: bestPath,
            tick: gameTime,
            version: pathTopologyVersion
        });
        _trimPathCacheIfNeeded(sharedSpawnerRouteCache, SPAWNER_ROUTE_CACHE_MAX_ENTRIES);
    }
    return { spawner: bestSpawner, path: bestPath };
}

function _findClosestBuilderSpawner(u) {
    let closest = null, bestDist = Infinity;
    for (let s of collectorSpawners) {
        if (s.type === 'builder_spawner' && s.owner === u.owner && s.energy > 0 && !s.underConstruction) {
            let d = Math.hypot(s.x - u.x, s.y - u.y);
            if (d < bestDist) { bestDist = d; closest = s; }
        }
    }
    return closest;
}

function _findClosestHealerSpawner(u) {
    let closest = null, bestDist = Infinity;
    for (let s of collectorSpawners) {
        if (s.type === 'healer_spawner' && s.owner === u.owner && s.energy > 0 && !s.underConstruction) {
            let d = Math.hypot(s.x - u.x, s.y - u.y);
            if (d < bestDist) { bestDist = d; closest = s; }
        }
    }
    return closest;
}

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
    let effLvl = getThingEffectiveLevel(target);
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
    let effLvl = getThingEffectiveLevel(target);
    let front = getQueuedSpawnInfo(target.spawnQueue[0], fallbackType, effLvl, owner);
    let remaining = Math.max(0, Math.floor((front.energyRequired || 0) - (front.energyPaid || 0)));
    if (remaining <= 0) return 0;
    let healWork = Math.max(1, Math.round(Number(u.healerDps) || 1));
    return Math.max(0, Math.min(healWork, remaining));
}

function _healerRememberWorkSite(u, target = null) {
    let t = target || (u ? u.workerTarget : null);
    if (!u || !t) return;
    if (Number.isFinite(t.x) && Number.isFinite(t.y)) {
        u._healerLastWorkX = t.x;
        u._healerLastWorkY = t.y;
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
    return { x: u.x, y: u.y };
}

function _getHealerQueueTargetNear(worldX, worldY, owner, radius = 22, requireNeedsWork = true) {
    let best = null;
    let bestDist = radius;
    let consider = (s) => {
        if (!s || s.owner !== owner || s.underConstruction) return;
        if (!Array.isArray(s.spawnQueue)) return;
        if (requireNeedsWork && !isQueueEnabled(s)) return;
        if (requireNeedsWork && !_isHealerQueueTarget(s, owner)) return;
        let d = Math.hypot(s.x - worldX, s.y - worldY);
        if (d <= bestDist) {
            bestDist = d;
            best = s;
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
    let effLvl = getThingEffectiveLevel(target);
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
    let effLvl = getThingEffectiveLevel(target);
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
    let consider = (s) => {
        if (!_isHealerQueueTarget(s, u.owner)) return;
        if (!_isTargetWithinWorkerSearchLimits(u, originX, originY, s, maxSearchArea)) return;
        let d = Math.hypot(s.x - originX, s.y - originY);
        if (d > maxSearch) return;
        let worldDist = Math.hypot(s.x - u.x, s.y - u.y);
        candidates.push({
            target: s,
            targetType: 'queue',
            dist: d,
            worldDist: worldDist,
            level: _getTargetPriorityLevel(s),
            isUpgrading: !!s.isUpgrading
        });
    };
    for (let b of barracks) consider(b);
    for (let s of collectorSpawners) {
        if (!s) continue;
        consider(s);
    }
    return _pickDistributedWorkerTarget(u, candidates);
}

function _isResearcherTargetBuilding(target, owner) {
    if (!target || target.type !== 'research') return false;
    if (target.owner !== owner) return false;
    if (target.energy <= 0 || target.underConstruction || target.markedForSalvage) return false;
    if (target.isUpgrading) return false;
    let task = target.researchTask;
    if (!task) {
        // Only auto-start new research when auto-research is enabled.
        // If a task already exists, researchers may still assist it.
        if (!isAutoResearchEnabled(target)) return false;
        task = tryAdvancePlayerResearchTask(owner);
        target.researchTask = task || null;
    }
    if (!task) return false;
    return (task.workDone || 0) < task.workRequired;
}

function _findNearestResearchBuildingNeedingWork(u) {
    let candidates = [];
    let maxSearch = _getResearcherAutoSearchDistancePx(u);
    let maxSearchArea = _getWorkerAutoSearchDistanceArea(u);
    for (let s of collectorSpawners) {
        if (!_isResearcherTargetBuilding(s, u.owner)) continue;
        if (!_isTargetWithinWorkerSearchLimits(u, u.x, u.y, s, maxSearchArea)) continue;
        let d = Math.hypot(s.x - u.x, s.y - u.y);
        if (d > maxSearch) continue;
        candidates.push({
            target: s,
            targetType: 'research',
            dist: d,
            worldDist: d,
            level: _getTargetPriorityLevel(s),
            isUpgrading: !!s.isUpgrading
        });
    }
    return _pickDistributedWorkerTarget(u, candidates);
}

let _healerDamagedCandidatesTick = -1;
let _healerDamagedCandidatesByOwner = [];
const HEALER_DAMAGED_CANDIDATE_LIMIT = 12;

function _ensureHealerDamagedCandidatesCacheCurrent() {
    let ownerCount = Math.max(1, Math.floor(Number(players && players.length) || 0));
    if (_healerDamagedCandidatesTick === gameTime && _healerDamagedCandidatesByOwner.length === ownerCount) return;

    _healerDamagedCandidatesByOwner = Array.from({ length: ownerCount }, () => []);
    _healerDamagedCandidatesTick = gameTime;

    let cap = Math.max(1, HEALER_DAMAGED_CANDIDATE_LIMIT | 0);
    for (let target of units) {
        if (!target || target.dead) continue;
        let owner = Math.floor(Number(target.owner));
        if (owner < 0 || owner >= ownerCount) continue;
        let energy = Number(target.energy);
        let maxEnergy = Number(target.maxEnergy);
        if (!(maxEnergy > 0) || !(energy > 0) || !(energy < maxEnergy)) continue;

        let ratio = energy / maxEnergy;
        let arr = _healerDamagedCandidatesByOwner[owner];
        if (!arr) continue;

        if (arr.length < cap) {
            arr.push({ u: target, ratio: ratio });
            continue;
        }

        let worstIdx = -1;
        let worstRatio = -1;
        for (let i = 0; i < arr.length; i++) {
            let r = arr[i].ratio;
            if (r > worstRatio) {
                worstRatio = r;
                worstIdx = i;
            }
        }
        if (worstIdx >= 0 && ratio < worstRatio) {
            arr[worstIdx] = { u: target, ratio: ratio };
        }
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
        if (!_isTargetWithinWorkerSearchLimits(u, originX, originY, target, maxSearchArea)) continue;

        let dx = target.x - originX;
        let dy = target.y - originY;
        let distSq = dx * dx + dy * dy;
        if (distSq > maxSearchSq) continue;

        let worldDistSq = distSq;
        if (!originIsHealer) {
            let wdx = target.x - healerX;
            let wdy = target.y - healerY;
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
    let queueTarget = _getHealerCommittedQueueTarget(u);
    if (!queueTarget && _isHealerQueueTarget(u._healerPinnedQueueTarget, u.owner)) {
        queueTarget = u._healerPinnedQueueTarget;
    }
    if (!queueTarget) queueTarget = _findNearestQueuedSpawnerNeedingWork(u, origin.x, origin.y);
    if (queueTarget) {
        let qd = Math.hypot(queueTarget.x - origin.x, queueTarget.y - origin.y);
        if (qd > maxSearch) {
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
        if (route && players[u.owner].energy >= tripCost && tripCost > 0) {
            u.workerState = 'RETURNING_FOR_GOLD';
            u.path = route.path;
            u.pathIndex = 0;
            u.commandState = CMD_MOVING;
            u._healerSpawnerTarget = route.spawner;
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

    let target = _findNearestDamagedFriendlyUnit(u, origin.x, origin.y);
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
            let targetGx = Math.floor(target.x / TILE), targetGy = Math.floor(target.y / TILE);
            u.path = _requestWorkerPath(u, startGx, startGy, targetGx, targetGy, null, null, true);
            u.pathIndex = 0;
            u.commandState = CMD_MOVING;
            return;
        }

        let route = _findBestSpawnerRoute(u, 'healer_spawner', null);
        if (route && players[u.owner].energy >= 1) {
            u.workerState = 'RETURNING_FOR_GOLD';
            u.path = route.path;
            u.pathIndex = 0;
            u.commandState = CMD_MOVING;
            u._healerSpawnerTarget = route.spawner;
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

function _findNearestUnderConstruction(u, originX = u.x, originY = u.y) {
    _ensureActiveBuilderWorkCacheCurrent();
    let owner = Number.isFinite(u.owner) ? u.owner : localPlayerId;
    let ownedTargets = _activeBuilderWorkTargetsByOwner.get(owner);
    if (!ownedTargets || ownedTargets.length <= 0) return null;
    let candidates = [];
    let maxSearch = _getWorkerAutoSearchDistancePx(u);
    let maxSearchArea = _getWorkerAutoSearchDistanceArea(u);
    for (let b of ownedTargets) {
        if (!_isBuilderWorkTarget(b, owner)) continue;
        if (!_isTargetWithinWorkerSearchLimits(u, originX, originY, b, maxSearchArea)) continue;
        let d = Math.hypot(b.x - originX, b.y - originY);
        if (d > maxSearch) continue;
        let worldDist = Math.hypot(b.x - u.x, b.y - u.y);
        candidates.push({
            target: b,
            dist: d,
            worldDist: worldDist,
            level: _getTargetPriorityLevel(b),
            isUpgrading: !!b.isUpgrading,
            isStacking: !!b.isStacking
        });
    }
    return _pickDistributedWorkerTarget(u, candidates);
}

function _findClosestSpawner(u, type) {
    let closest = null, bestDist = Infinity;
    for (let s of collectorSpawners) {
        if (s.type === type && s.owner === u.owner && s.energy > 0 && !s.underConstruction) {
            let d = Math.hypot(s.x - u.x, s.y - u.y);
            if (d < bestDist) { bestDist = d; closest = s; }
        }
    }
    return closest;
}

function _workerReturnPath(u) {
    if (!u) return;
    let needsReturnPayload = (u.workerType === 'collector' || u.workerType === 'astar_collector' || u.workerType === 'salvager');
    if (needsReturnPayload && !(Number(u.carryingValue) > 0)) {
        _clearWorkerAutoRoute(u);
        return;
    }
    let type = u.workerType === 'collector'
        ? 'spawner'
        : (u.workerType === 'astar_collector' ? 'astar_spawner' : 'salvager');
    let canWalk = u.workerType === 'collector'
        ? _collectorCanWalk
        : (u.workerType === 'astar_collector' ? _astarCollectorCanWalk : null);
    let workerAiTickDelay = Math.max(1, Math.floor(Number(WORKER_AI_TICK_DELAY) || 1));
    let forceImmediateRoute = (u.workerType === 'collector' || u.workerType === 'astar_collector')
        && (Number(u.carryingValue) > 0);
    let cacheOnly = !forceImmediateRoute && (((gameTime + u.id) % workerAiTickDelay) !== 0);
    let route = _findBestSpawnerRoute(u, type, canWalk, { cacheOnly: cacheOnly });
    if (route) {
        if (u.workerType === 'collector' && route.spawner) {
            u._collectorNextSpawner = route.spawner;
        } else if (u.workerType === 'astar_collector' && route.spawner) {
            u._astarNextSpawner = route.spawner;
        }
        u.path = route.path || [];
        u.pathIndex = 0; u.commandState = CMD_MOVING;
    } else {
        u.path = []; u.pathIndex = 0; u.commandState = CMD_IDLE;
    }
}


function queueAction(action) {
    if (localDefeated && action && action.action !== 'resign') return;
    if (gameOver) return;
    if (isMultiplayer && gameStarted && !isHost && !getPeerConnectionState(wsHostId)) {
        let allowedWhileDisconnected = action && (action.action === 'resign' || action.action === 'syncSpectateMode');
        if (!allowedWhileDisconnected) {
            let st = document.getElementById('lobby-status');
            if (st) {
                st.textContent = 'Reconnecting to host... commands are paused.';
                st.style.color = '#fa4';
            }
            scheduleGuestAutoReconnect('Lost host connection');
            return;
        }
    }
    let actionLead = Math.max(0, Math.floor(INPUT_DELAY || 0));
    // Host prebuilds bundles up to current+pipeline. Guests must target beyond that window.
    if (isMultiplayer && gameStarted && !isHost) {
        actionLead = Math.max(actionLead, Math.max(0, Math.floor(LOCKSTEP_PIPELINE_TICKS || 0)) + 1);
    }
    let tick = currentTick + actionLead;
    if (isMultiplayer && gameStarted) {
        // With low input delay, the target tick may already be packetized/committed.
        // Move to the nearest still-editable tick so actions never get dropped.
        while (lockstepCommittedByTick[tick] || lockstepBundleByTick[tick]) tick++;
    }
    if (!localInputBuffer[tick]) localInputBuffer[tick] = [];
    let actorId = myPeerId || `p${localPlayerId}`;
    let finalAction = { ...action, teamId: localPlayerId, netId: `${actorId}:${nextLocalActionSeq++}` };
    localInputBuffer[tick].push(finalAction);

    // Invalidate prebuilt packet/bundle state for this tick so the new action is included.
    delete lockstepLocalPacketByTick[tick];
    if (isHost && lockstepHostPacketsByTick[tick] && myPeerId) {
        delete lockstepHostPacketsByTick[tick][myPeerId];
        delete lockstepBundleByTick[tick];
        delete lockstepBundleAckByTick[tick];
        delete lockstepCommittedByTick[tick];
    }
}

function clearWorkerTaskMemoryForFreeRetarget(u) {
    if (!u || !u.workerState) return;
    if (u.workerType === 'collector') {
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
    } else if (u.workerType === 'astar_collector') {
        u._astarLastGatherX = null;
        u._astarLastGatherY = null;
        u._astarLastGatherGx = null;
        u._astarLastGatherGy = null;
        u._astarPinnedTarget = null;
        u._astarPinnedTargetType = null;
        u._astarNextSpawner = null;
        u._astarLastMineTarget = null;
        u._astarLastMineTargetType = null;
    } else if (u.workerType === 'builder') {
        u._builderLastWorkX = null;
        u._builderLastWorkY = null;
        u._builderLastWorkGx = null;
        u._builderLastWorkGy = null;
        u._builderSpawnerTarget = null;
    } else if (u.workerType === 'healer') {
        u._healerPinnedQueueTarget = null;
        _clearHealerQueueCommit(u);
        u._healerLastWorkX = null;
        u._healerLastWorkY = null;
        u._healerLastWorkGx = null;
        u._healerLastWorkGy = null;
        u._healerSpawnerTarget = null;
        u._healerQueueTripCost = 0;
    } else if (u.workerType === 'researcher') {
        u._researchSpawnerTarget = null;
        u._researcherTripWork = 0;
        u._researcherTripCost = 0;
    }
    u._workerNextIdleRetargetTick = gameTime;
}

function issueWorkerBlockedAssignFallbackMove(u, targetGx, targetGy) {
    if (!u || u.dead || !u.workerState) return;
    let gx = Math.max(0, Math.min(GRID_W - 1, Math.floor(targetGx)));
    let gy = Math.max(0, Math.min(GRID_H - 1, Math.floor(targetGy)));
    let targetX = gx * TILE + TILE / 2;
    let targetY = gy * TILE + TILE / 2;

    u.targetUnit = null;
    u.targetBuilding = null;
    u.forcedAttackTarget = false;
    u._forcedTargetLastSeenX = null;
    u._forcedTargetLastSeenY = null;
    u.commandState = CMD_MOVING;
    _clearWorkerTarget(u);
    Object.assign(u, { workerState: 'MANUAL_MOVE' });
    clearWorkerTaskMemoryForFreeRetarget(u);

    if (_canUsePathfindRequestBudget(u.owner)) {
        _consumePathfindRequestBudget(u.owner);
        let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
        u.path = _findPathForUnitTagged('player_commands', u, ugx, ugy, gx, gy, u.isFlying, getPathCanWalkForUnit(u), u.owner);
        if (u.path && u.path.length > 0) {
            u.pathIndex = (u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
            u._pendingPathTarget = null;
        } else {
            u.path = _makeFallbackPathForUnit(u, ugx, ugy, gx, gy, CMD_MOVING, 'player_commands');
            u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
        }
    } else {
        let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
        u.path = _makeFallbackPathForUnit(u, ugx, ugy, gx, gy, CMD_MOVING, 'player_commands');
        u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
    }
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