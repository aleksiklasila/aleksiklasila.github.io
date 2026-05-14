"use strict";

// ============================================================
// ADJACENCY & LASER CONNECTIONS
// ============================================================
function recalculateLaserConnections() {
    towers.forEach(t => { if (t.type === 'laser') t.connectedLasers = []; });
    for (let i = 0; i < towers.length; i++) {
        let t1 = towers[i]; if (t1.type !== 'laser') continue;
        for (let j = i + 1; j < towers.length; j++) {
            let t2 = towers[j]; if (t2.type !== 'laser' || t2.owner !== t1.owner) continue;
            let aX = t1.gx === t2.gx, aY = t1.gy === t2.gy;
            if (!aX && !aY) continue;
            let blocked = false, dist;
            if (aX) { dist = Math.abs(t1.gy - t2.gy); let mn = Math.min(t1.gy, t2.gy), mx = Math.max(t1.gy, t2.gy); for (let y = mn + 1; y < mx; y++) if (grid[y][t1.gx].type === TYPE_WALL) blocked = true; }
            else { dist = Math.abs(t1.gx - t2.gx); let mn = Math.min(t1.gx, t2.gx), mx = Math.max(t1.gx, t2.gx); for (let x = mn + 1; x < mx; x++) if (grid[t1.gy][x].type === TYPE_WALL) blocked = true; }
            let gap = dist - 1, limit = Math.min(t1.effectiveLevel, t2.effectiveLevel);
            if (gap > limit || gap < 1) blocked = true;
            if (!blocked) { t1.connectedLasers.push(t2); t2.connectedLasers.push(t1); }
        }
    }
}

function _isOperationalAdjacencyEntity(obj) {
    if (!obj) return false;
    if (obj.underConstruction) return false;
    let lvl = (obj.effectiveLevel !== undefined ? obj.effectiveLevel : obj.level);
    if (lvl !== undefined && lvl <= 0) return false;
    return true;
}

function _getAdjacencySignatureAt(gx, gy) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return null;
    let ref = getTileEntityRef(gx, gy);
    if (!ref || !_isOperationalAdjacencyEntity(ref)) return null;
    if (ref instanceof Tower) {
        if (!grid[gy] || !grid[gy][gx] || grid[gy][gx].type !== TYPE_WALL) return null;
        let owner = Number.isFinite(ref.owner) ? ref.owner : grid[gy][gx].owner;
        if (!Number.isFinite(owner) || owner < 0) return null;
        let type = String(ref.type || '');
        if (!type) return null;
        return {
            obj: ref,
            isTower: true,
            owner,
            type,
            unitType: '',
            sigKey: `T|${owner}|${type}`
        };
    }

    if (getTileEntityType(gx, gy) === TILE_ENTITY_GOLDMINE) return null;
    let owner = Number.isFinite(ref.owner) ? ref.owner : (grid[gy] && grid[gy][gx] ? grid[gy][gx].owner : -1);
    if (!Number.isFinite(owner) || owner < 0) return null;
    let type = String(ref.type || '');
    if (!type) return null;
    let unitType = type === 'barrack' ? String(ref.unitType || 'norm') : '';
    return {
        obj: ref,
        isTower: false,
        owner,
        type,
        unitType,
        sigKey: `I|${owner}|${type}|${unitType}`
    };
}

function _runAdjacencyRecalculation() {
    if (!_adjacencyNeedsRecalc) return;
    if (!_adjacencyDirtyAll && _adjacencyDirtyTiles.size <= 0) {
        _adjacencyNeedsRecalc = false;
        return;
    }

    let runFull = _adjacencyDirtyAll || _adjacencyDirtyTiles.size > 1200;
    let prevAreaActive = areas.map(a => !!(a && a.active));
    let areaVisualsChanged = false;
    let touchedAreaIds = new Set();
    let seeds = [];
    let seedKeySet = new Set();

    let pushSeedAt = (gx, gy) => {
        let sig = _getAdjacencySignatureAt(gx, gy);
        if (!sig || !sig.obj || !Number.isFinite(sig.obj.gx) || !Number.isFinite(sig.obj.gy)) return;
        let key = _adjTileKey(sig.obj.gx, sig.obj.gy);
        if (seedKeySet.has(key)) return;
        seedKeySet.add(key);
        seeds.push(sig.obj);
    };

    if (runFull) {
        for (let i = 0; i < areas.length; i++) touchedAreaIds.add(i);
        for (let ent of _activeTileEntities) {
            if (!ent || !Number.isFinite(ent.gx) || !Number.isFinite(ent.gy)) continue;
            pushSeedAt(ent.gx, ent.gy);
        }
    } else {
        for (let key of _adjacencyDirtyTiles) {
            let gx = key % GRID_W;
            let gy = Math.floor(key / GRID_W);
            if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) continue;
            let cell = grid[gy] && grid[gy][gx];
            if (cell && Number.isFinite(cell.areaId) && cell.areaId >= 0) touchedAreaIds.add(cell.areaId);
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    pushSeedAt(gx + dx, gy + dy);
                }
            }
        }
    }

    if (runFull) {
        for (let a of areas) if (a) a.active = false;
    } else {
        for (let aId of touchedAreaIds) {
            let a = getAreaById(aId);
            if (a) a.active = false;
        }
    }

    const areaSignatureCache = new Map();
    const getAreaSignatureKey = (aId) => {
        if (areaSignatureCache.has(aId)) return areaSignatureCache.get(aId);
        let area = getAreaById(aId);
        if (!area || !Array.isArray(area.cells) || area.cells.length <= 0) {
            areaSignatureCache.set(aId, null);
            return null;
        }
        let firstKey = null;
        for (let cp of area.cells) {
            let sig = _getAdjacencySignatureAt(cp.x, cp.y);
            if (!sig) {
                areaSignatureCache.set(aId, null);
                return null;
            }
            if (firstKey === null) firstKey = sig.sigKey;
            else if (firstKey !== sig.sigKey) {
                areaSignatureCache.set(aId, null);
                return null;
            }
        }
        areaSignatureCache.set(aId, firstKey);
        return firstKey;
    };

    let visited = new Set();
    let dirs4 = [[0, 1], [0, -1], [1, 0], [-1, 0]];

    for (let seed of seeds) {
        if (!seed || !Number.isFinite(seed.gx) || !Number.isFinite(seed.gy)) continue;
        let rootSig = _getAdjacencySignatureAt(seed.gx, seed.gy);
        if (!rootSig) continue;
        let rootKey = _adjTileKey(seed.gx, seed.gy);
        if (visited.has(rootKey)) continue;

        let queue = [{ x: seed.gx, y: seed.gy }];
        let qHead = 0;
        let group = [];
        let touchedAreas = new Set();

        const enqueueMatchingCell = (tx, ty) => {
            if (tx < 0 || tx >= GRID_W || ty < 0 || ty >= GRID_H) return;
            let key = _adjTileKey(tx, ty);
            if (visited.has(key)) return;
            let sig = _getAdjacencySignatureAt(tx, ty);
            if (!sig || sig.sigKey !== rootSig.sigKey) return;
            visited.add(key);
            queue.push({ x: tx, y: ty });
            group.push(sig.obj);
            let cell = grid[ty] && grid[ty][tx];
            if (cell && Number.isFinite(cell.areaId) && cell.areaId >= 0) {
                touchedAreas.add(cell.areaId);
                touchedAreaIds.add(cell.areaId);
            }
        };

        enqueueMatchingCell(seed.gx, seed.gy);

        while (qHead < queue.length) {
            let cur = queue[qHead++];
            for (let d of dirs4) {
                let nx = cur.x + d[0], ny = cur.y + d[1];
                enqueueMatchingCell(nx, ny);

                let cloud = getTowerAtTile(nx, ny);
                if (!cloud || cloud.owner !== rootSig.owner || !_isOperationalAdjacencyEntity(cloud) || !(cloud.baseStats && cloud.baseStats.isCloud)) continue;
                let partner = getPairedCloudTower(cloud, rootSig.owner);
                let endpoints = [cloud];
                if (partner) endpoints.push(partner);
                for (let ep of endpoints) {
                    for (let d2 of dirs4) {
                        enqueueMatchingCell(ep.gx + d2[0], ep.gy + d2[1]);
                    }
                }
            }
        }

        if (group.length <= 0) continue;

        let areaMult = 1;
        for (let aId of touchedAreas) {
            let area = getAreaById(aId);
            if (!area) continue;
            let areaSig = getAreaSignatureKey(aId);
            if (areaSig !== rootSig.sigKey) continue;
            let power = (area.multiplierLevel || 0) + 1;
            areaMult *= Math.pow(area.cells.length, power);
        }

        let groupSize = group.length;
        for (let obj of group) {
            let nextStacks = getThingStackedStacks(obj);
            let nextManualStacks = getThingManualStacks(obj);
            let actualStacks = nextStacks || 1;
            let nextEffectiveStacks = actualStacks * groupSize * areaMult;
            let nextPotentialLevel = stackCountToLevel(nextEffectiveStacks);
            let nextEffectiveLevel = (obj.effectiveLevel === undefined)
                ? 1
                : Math.max(1, Math.floor(obj.effectiveLevel));
            let nextIsUpgrading = !!obj.isUpgrading;

            if (nextPotentialLevel < nextEffectiveLevel) {
                nextEffectiveLevel = nextPotentialLevel;
                nextIsUpgrading = false;
            }

            if (!isAutoUpgradeEnabled(obj) && nextIsUpgrading) {
                nextIsUpgrading = false;
            }

            // Commit effective values only after deriving final state to avoid transient flicker.
            obj.stacks = nextStacks;
            obj.manualStacks = nextManualStacks;
            obj.effectiveStacks = nextEffectiveStacks;
            obj.potentialEffectiveLevel = nextPotentialLevel;
            obj.effectiveLevel = nextEffectiveLevel;
            obj.isUpgrading = nextIsUpgrading;

            if (obj.potentialEffectiveLevel > obj.effectiveLevel && !obj.underConstruction && !obj.isUpgrading && isAutoUpgradeEnabled(obj)) {
                beginUpgradeProgress(obj, obj.effectiveLevel + 1);
            }

            if (!obj.underConstruction && !obj.isUpgrading) {
                obj.isStacking = getThingRemainingStacks(obj) > 0 && isAutoStackEnabled(obj);
                if (!obj.isStacking) obj.stackingWorkDone = 0;
            } else if (obj.isUpgrading) {
                obj.isStacking = false;
            }

            if (obj.updateStats) {
                obj.effectiveGroupSize = groupSize;
                obj.effectiveAreaMult = areaMult;
                obj.updateStats();
            } else {
                obj.effectiveGroupSize = groupSize;
                obj.effectiveAreaMult = areaMult;
                let statsType = (obj.type === 'barrack' && obj.unitType) ? ('barrack_' + obj.unitType) : obj.type;
                let baseStats = calculateItemStats(statsType, getThingBaseLevel(obj), obj.owner);
                let stats = clonePrecomputedWithBaseMaxEnergy(baseStats, calculateItemStats(statsType, obj.effectiveLevel, obj.owner));
                obj.preComputedBase = baseStats;
                obj.preComputedEffective = stats;
                obj.preComputed = obj.preComputedEffective;
                if (obj.isUpgrading && obj.upgrademaxEnergy > 0) {
                    obj.maxEnergy = Math.max(1, Math.floor(obj.upgrademaxEnergy));
                    if (!Number.isFinite(obj.energy) || obj.energy < 1) obj.energy = 1;
                    obj.energy = Math.min(obj.energy, obj.maxEnergy);
                    if (stats.damage) obj.damage = stats.damage;
                } else {
                    let prevEnergy = Number(obj.energy);
                    if (!Number.isFinite(prevEnergy)) prevEnergy = Number(baseStats.maxEnergy) || 1;
                    obj.maxEnergy = baseStats.maxEnergy;
                    if (stats.damage) obj.damage = stats.damage;
                    obj.energy = Math.max(1, Math.min(obj.maxEnergy, Math.floor(prevEnergy)));
                }
                updateItemTextCache(obj);
            }
        }
    }

    for (let aId of touchedAreaIds) {
        let a = getAreaById(aId);
        if (!a) continue;
        let nextActive = !!getAreaSignatureKey(aId);
        if (!nextActive && a.multiplierLevel > 0) {
            a.multiplierLevel = 0;
            areaVisualsChanged = true;
        }
        if (!!prevAreaActive[aId] !== nextActive) areaVisualsChanged = true;
        a.active = nextActive;
    }

    if (areaVisualsChanged) dirtyAreas = true;

    _bumpPathTopologyVersion();
    _adjacencyNeedsRecalc = false;
    _adjacencyDirtyAll = false;
    _adjacencyDirtyTiles.clear();
    _adjacencyLastRecalcTick = gameTime;
}

function recalculateAdjacency(forceFull = false) {
    if (forceFull) _adjacencyDirtyAll = true;
    _adjacencyNeedsRecalc = true;
    if (_adjacencyLastRecalcTick === gameTime) return;
    _runAdjacencyRecalculation();
}

function getUnitEffectiveStatsRecalcTicks() {
    return Math.max(1, Math.min(240, Math.floor(Number(UNIT_EFFECTIVE_STATS_RECALC_TICKS) || 1)));
}

function getThingStatsRecalcIntervalTicks() {
    let seconds = Number(THING_STATS_RECALC_INTERVAL_SECONDS);
    if (!Number.isFinite(seconds)) seconds = 3;
    return Math.max(1, Math.min(36000, Math.floor(seconds * TICK_RATE) || 1));
}

function getUnitCollisionRecalcTicks() {
    return Math.max(1, Math.min(240, Math.floor(Number(UNIT_COLLISION_RECALC_TICKS) || 1)));
}

function _seedThingStatsRecalcCounter(item, intervalTicks, fallbackSeed = 0) {
    let seed = 0;
    if (item && Number.isFinite(item.id)) seed = (Math.floor(item.id) * 1103515245) >>> 0;
    else if (item && Number.isFinite(item.gx) && Number.isFinite(item.gy)) seed = (((Math.floor(item.gx) + 1) * 73856093) ^ ((Math.floor(item.gy) + 1) * 19349663)) >>> 0;
    else seed = (Math.floor(fallbackSeed) * 83492791) >>> 0;
    return intervalTicks > 1 ? (seed % intervalTicks) : 0;
}

function _refreshThingPrecomputedStats(item) {
    if (!item || item.dead) return;

    if (item.unitType && Number.isFinite(item.owner)) {
        let baseLevel = getUnitBaseLevel(item);
        let effectiveLevel = getUnitEffectiveLevel(item, baseLevel);
        applyUnitLevelScaling(item, baseLevel);
        applyUnitEffectiveScaling(item, effectiveLevel);
        return;
    }

    if (item.updateStats) {
        item.updateStats();
        return;
    }

    let statsType = (item.type === 'barrack' && item.unitType) ? ('barrack_' + item.unitType) : item.type;
    if (!statsType) return;

    let baseLevel = getThingBaseLevel(item);
    let effectiveLevel = getThingEffectiveLevel(item, baseLevel);
    item.preComputedBase = calculateItemStats(statsType, baseLevel, item.owner);
    item.preComputedEffective = clonePrecomputedWithBaseMaxEnergy(item.preComputedBase, calculateItemStats(statsType, effectiveLevel, item.owner));
    item.preComputed = item.preComputedEffective;

    if (item.isUpgrading && item.upgrademaxEnergy > 0) {
        item.maxEnergy = Math.max(1, Math.floor(item.upgrademaxEnergy));
        if (!Number.isFinite(item.energy) || item.energy < 1) item.energy = 1;
        item.energy = Math.min(item.energy, item.maxEnergy);
        if (item.preComputed && Number.isFinite(item.preComputed.damage)) item.damage = item.preComputed.damage;
    } else {
        let prevEnergy = Number(item.energy);
        if (!Number.isFinite(prevEnergy)) prevEnergy = Number(item.preComputedBase && item.preComputedBase.maxEnergy) || 1;
        item.maxEnergy = Number(item.preComputedBase && item.preComputedBase.maxEnergy) || item.maxEnergy;
        if (item.preComputed && Number.isFinite(item.preComputed.damage)) item.damage = item.preComputed.damage;
        item.energy = Math.max(1, Math.min(item.maxEnergy, Math.floor(prevEnergy)));
    }

    updateItemTextCache(item);
}

function recalculateThingPrecomputedStats() {
    let intervalTicks = getThingStatsRecalcIntervalTicks();
    let selectedUnitSet = (selectedUnits && selectedUnits.length > 0) ? new Set(selectedUnits) : null;
    let selectedEntitySet = (selectedEntities && selectedEntities.length > 0) ? new Set(selectedEntities) : null;
    let seen = new Set();
    let seedCursor = 0;

    let processThing = (item, isSelected = false) => {
        if (!item || item.dead || seen.has(item)) return;
        seen.add(item);

        if (!Number.isFinite(item._thingStatsRecalcCounter)) {
            item._thingStatsRecalcCounter = _seedThingStatsRecalcCounter(item, intervalTicks, ++seedCursor);
        } else if (item._thingStatsRecalcCounter > intervalTicks) {
            item._thingStatsRecalcCounter = intervalTicks;
        }

        let needsImmediate = !(item.preComputed && Number.isFinite(item.preComputed.maxEnergy));
        if (!needsImmediate && isSelected) needsImmediate = true;

        if (needsImmediate || item._thingStatsRecalcCounter <= 0) {
            _refreshThingPrecomputedStats(item);
            item._thingStatsRecalcCounter = intervalTicks;
        } else {
            item._thingStatsRecalcCounter--;
        }
    };

    for (let u of units) processThing(u, !!(selectedUnitSet && selectedUnitSet.has(u)));
    for (let t of towers) processThing(t, !!(selectedEntitySet && selectedEntitySet.has(t)));
    for (let b of barracks) processThing(b, !!(selectedEntitySet && selectedEntitySet.has(b)));
    for (let s of collectorSpawners) processThing(s, !!(selectedEntitySet && selectedEntitySet.has(s)));

    for (let y = 0; y < GRID_H; y++) {
        let row = grid[y];
        if (!row) continue;
        for (let x = 0; x < GRID_W; x++) {
            let cell = row[x];
            if (!cell || !cell.item) continue;
            processThing(cell.item, !!(selectedEntitySet && selectedEntitySet.has(cell.item)));
        }
    }
}

function recalculateUnitEffectiveStats() {
    let intervalTicks = getUnitEffectiveStatsRecalcTicks();
    let dueUnits = [];
    let selectedSet = null;
    if (selectedUnits && selectedUnits.length > 0) selectedSet = new Set(selectedUnits);

    for (let u of units) {
        if (!u || u.dead) continue;

        if (!Number.isFinite(u._effectiveStatsRecalcCounter)) {
            let seed = ((u.id * 1103515245 + (u.owner + 1) * 12345) >>> 0);
            u._effectiveStatsRecalcCounter = intervalTicks > 1 ? (seed % intervalTicks) : 0;
        } else if (u._effectiveStatsRecalcCounter > intervalTicks) {
            u._effectiveStatsRecalcCounter = intervalTicks;
        }

        let needsImmediate = !Number.isFinite(u.baseLevel)
            || !(u.basePreComputed && Number.isFinite(u.basePreComputed.visionRange))
            || !(u.basePreComputed && Number.isFinite(u.basePreComputed.maxEnergy))
            || !Number.isFinite(u.effectiveLevel)
            || !Number.isFinite(u.effectiveStacks);

        // Keep selected units up-to-date in the stats panel despite staggered recalculation.
        if (!needsImmediate && selectedSet && selectedSet.has(u)) needsImmediate = true;

        if (needsImmediate || u._effectiveStatsRecalcCounter <= 0) {
            dueUnits.push(u);
            u._effectiveStatsRecalcCounter = intervalTicks;
        } else {
            u._effectiveStatsRecalcCounter--;
        }
    }

    if (dueUnits.length <= 0) return;

    let canUseSpatialCounts = spatialUnitsComplexStridePerChunk > 0
        && spatialUnitsComplexStridePerPlayer > 0
        && spatialUnitsComplex.length > 0
        && CHUNKS_W > 0
        && CHUNKS_H > 0;
    let unitTypeToSpatialIdx = new Map();
    let chunkPx = Math.max(1, CHUNK_SIZE * TILE);

    // Prefix sums per owner+unitType allow O(1) rectangular count queries per unit.
    let spatialPrefixByOwner = new Map();
    let prefixStride = CHUNKS_W + 1;
    let prefixCellCount = (CHUNKS_H + 1) * prefixStride;

    let getTypeIndexCached = (unitType) => {
        if (unitTypeToSpatialIdx.has(unitType)) return unitTypeToSpatialIdx.get(unitType);
        let idx = spatialUnitTypeToIndex[unitType];
        let valid = Number.isFinite(idx) ? idx : -1;
        unitTypeToSpatialIdx.set(unitType, valid);
        return valid;
    };

    let getSpatialPrefix = (owner, typeIdx) => {
        let byType = spatialPrefixByOwner.get(owner);
        if (!byType) {
            byType = new Map();
            spatialPrefixByOwner.set(owner, byType);
        }

        let prefix = byType.get(typeIdx);
        if (prefix) return prefix;

        prefix = new Int32Array(prefixCellCount);
        for (let cy = 1; cy <= CHUNKS_H; cy++) {
            let rowAccum = 0;
            let chunkRow = (cy - 1) * CHUNKS_W;
            let outRow = cy * prefixStride;
            let outPrevRow = (cy - 1) * prefixStride;
            for (let cx = 1; cx <= CHUNKS_W; cx++) {
                let chunkKey = chunkRow + (cx - 1);
                let playerBase = (chunkKey * spatialUnitsComplexStridePerChunk) + (owner * spatialUnitsComplexStridePerPlayer);
                let v = spatialUnitsComplex[playerBase + 1 + typeIdx] | 0;
                rowAccum += v;
                let outIdx = outRow + cx;
                prefix[outIdx] = prefix[outPrevRow + cx] + rowAccum;
            }
        }

        byType.set(typeIdx, prefix);
        return prefix;
    };

    let querySpatialCountRect = (prefix, minCx, minCy, maxCx, maxCy) => {
        if (!prefix) return 0;
        let x1 = Math.max(0, Math.min(CHUNKS_W - 1, minCx));
        let y1 = Math.max(0, Math.min(CHUNKS_H - 1, minCy));
        let x2 = Math.max(0, Math.min(CHUNKS_W - 1, maxCx));
        let y2 = Math.max(0, Math.min(CHUNKS_H - 1, maxCy));
        if (x2 < x1 || y2 < y1) return 0;

        let xa = x1;
        let ya = y1;
        let xb = x2 + 1;
        let yb = y2 + 1;

        return (prefix[yb * prefixStride + xb]
            - prefix[ya * prefixStride + xb]
            - prefix[yb * prefixStride + xa]
            + prefix[ya * prefixStride + xa]) | 0;
    };

    let dueInfo = [];
    for (let u of dueUnits) {
        let baseStacks = getUnitStackCount(u);
        let baseLevel = stackCountToLevel(baseStacks);
        let needsRefresh = !Number.isFinite(u.baseLevel) || u.baseLevel !== baseLevel ||
            !(u.basePreComputed && Number.isFinite(u.basePreComputed.visionRange)) || !(u.basePreComputed && Number.isFinite(u.basePreComputed.maxEnergy));

        u.stackCount = baseStacks;
        u.unitLevel = baseLevel;

        if (needsRefresh) {
            applyUnitLevelScaling(u, baseLevel);
            u.stackCount = baseStacks;
        }

        u.effectiveStacks = baseStacks;
        u.effectiveLevel = baseLevel;
        dueInfo.push({ u, baseStacks, needsRefresh });
    }

    for (let info of dueInfo) {
        let u = info.u;
        let radiusPx = Math.max(0.5, Number((u.basePreComputed && u.basePreComputed.visionRange) || (u.preComputed && u.preComputed.visionRange) || 0.5)) * TILE;
        let similarCount = 0;
        if (canUseSpatialCounts) {
            let owner = Math.floor(Number(u.owner));
            let typeIdx = getTypeIndexCached(u.unitType);
            if (owner >= 0 && owner < spatialUnitsComplexPlayerCount && typeIdx >= 0) {
                let cx = Math.floor(u.x / chunkPx);
                let cy = Math.floor(u.y / chunkPx);
                let chunkRadius = Math.max(0, Math.ceil(radiusPx / chunkPx));
                let prefix = getSpatialPrefix(owner, typeIdx);
                similarCount = querySpatialCountRect(prefix, cx - chunkRadius, cy - chunkRadius, cx + chunkRadius, cy + chunkRadius);
            }
        }
        if (similarCount <= 0) {
            forEachUnitInRange(u.x, u.y, radiusPx, () => {
                similarCount++;
            }, { player: u.owner, unitType: u.unitType });
        }

        if (similarCount < 1) similarCount = 1;
        let effStacks = Math.max(1, Math.floor(similarCount * info.baseStacks));
        u.effectiveStacks = effStacks;
        u.effectiveLevel = stackCountToLevel(effStacks);
    }

    for (let info of dueInfo) {
        let u = info.u;
        let nextEffLevel = getUnitEffectiveLevel(u);
        if (info.needsRefresh || u._lastAppliedEffectiveLevel !== nextEffLevel) {
            applyUnitEffectiveScaling(u, nextEffLevel);
            u._lastAppliedEffectiveLevel = nextEffLevel;
        }
    }
}

// ============================================================
// BUILDING PLACEMENT & DESTRUCTION
// ============================================================
function canBuildAt(gx, gy, playerId) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
    if (grid[gy][gx].type === TYPE_WALL) return false;
    if (grid[gy][gx].item) return false;
    // Don't allow building on gold mines
    if (getGoldMineAt(gx, gy)) return false;
    if (getAstarMineAt(gx, gy)) return false;
    // Check within 5 tiles of any fully-built owned building
    /*
    // distance thing disabled for now.
    for (let t of towers) { if (t.owner === playerId && !t.underConstruction && Math.abs(t.gx - gx) + Math.abs(t.gy - gy) <= 5) return true; }
    for (let b of barracks) { if (b.owner === playerId && !b.underConstruction && Math.abs(b.gx - gx) + Math.abs(b.gy - gy) <= 5) return true; }
    for (let s of collectorSpawners) { if (s.owner === playerId && !s.underConstruction && Math.abs(s.gx - gx) + Math.abs(s.gy - gy) <= 5) return true; }
    // Check floor items too (exclude under-construction)
    for (let y2 = 0; y2 < GRID_H; y2++) for (let x2 = 0; x2 < GRID_W; x2++) {
        if (grid[y2][x2].item && !grid[y2][x2].item.underConstruction && grid[y2][x2].owner === playerId && Math.abs(x2 - gx) + Math.abs(y2 - gy) <= 5) return true;
    }
    return false;
    */
    return true
}

function canStackAt(gx, gy, itemKey, playerId) {
    // Check if we can stack on an existing same-type building
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
    let cardDef = BASE_CARD_TYPES[itemKey];
    if (!cardDef) return false;
    if (cardDef.target === 'wall') {
        let t = getTowerAtTile(gx, gy);
        return !!(t && t.type === itemKey && t.owner === playerId);
    }
    if (itemKey.startsWith('barrack_')) {
        let unitType = cardDef.unitType || 'norm';
        let b = getBarrackAtTile(gx, gy);
        return !!(b && b.unitType === unitType && b.owner === playerId);
    }
    if (itemKey === 'spawner' || itemKey === 'astar_spawner' || itemKey === 'salvager' || itemKey === 'builder_spawner' || itemKey === 'healer_spawner' || itemKey === 'research') {
        let s = getSpawnerAtTile(gx, gy);
        return !!(s && s.type === itemKey && s.owner === playerId);
    }
    // Floor items
    let cell = grid[gy][gx];
    return cell.item && cell.item.type === itemKey && cell.owner === playerId;
}

const AREA_LEVEL_COLORS = ['#888', '#4f4', '#4af', '#c4f', '#f90', '#fd0'];
const AREA_LEVEL_NAMES = ['Gray', 'Green', 'Blue', 'Purple', 'Orange', 'Gold'];

function getAreaUpgradeCost(currentLevel) {
    return Math.floor(100 * Math.pow(3, currentLevel));
}

function placeBuilding(gx, gy, itemKey, playerId, defaults = null) {
    let cardDef = BASE_CARD_TYPES[itemKey];
    if (!cardDef) return false;
    let placedNewStructure = false;
    let placedNewWallStructure = false;

    let useDefaultAutoUpgrade = defaultAutoUpgradeEnabled;
    let useDefaultBuild = defaultAutoBuildEnabled;
    let silentPlace = false;
    if (defaults && typeof defaults === 'object') {
        if (defaults.autoUpgradeEnabled !== undefined) useDefaultAutoUpgrade = !!defaults.autoUpgradeEnabled;
        if (defaults.buildEnabled !== undefined) useDefaultBuild = !!defaults.buildEnabled;
        if (defaults.silent !== undefined) silentPlace = !!defaults.silent;
    }

    if (itemKey.startsWith('cloud_')) {
        let hasSameCloud = towers.some(t => t.owner === playerId && t.type === itemKey && t.energy > 0);
        if (hasSameCloud) return false;
    }

    // Area upgrader: special handling
    if (itemKey === 'area_upgrader') {
        let aId = grid[gy][gx].areaId;
        if (aId === -1) return false;
        let area = getAreaById(aId);
        if (!area) return false;
        // Check if ALL cells in area are occupied by any building/item (any owner)
        let allFilled = area.cells.every(cp => {
            let c = grid[cp.y][cp.x];
            if (c.type === TYPE_WALL) {
                let t = getTowerAtTile(cp.x, cp.y);
                if (t && !t.underConstruction && getDisplayLevel(t) > 0) return true;
            }
            if (c.item && !c.item.underConstruction && getDisplayLevel(c.item) > 0) return true;
            let b = getBarrackAtTile(cp.x, cp.y);
            if (b && !b.underConstruction && getDisplayLevel(b) > 0) return true;
            let s = getSpawnerAtTile(cp.x, cp.y);
            if (s && !s.underConstruction && getDisplayLevel(s) > 0) return true;
            return false;
        });
        if (!allFilled) return false;
        if ((area.multiplierLevel || 0) >= 5) return false;
        area.multiplierLevel = (area.multiplierLevel || 0) + 1;
        _markCombinedBgAreaDirty(aId, 1);
        for (let cp of area.cells) requestAdjacencyRecalc(cp.x, cp.y, 0);
        recalculateAdjacency();
        return true;
    }

    // Allow stacking on existing same-type buildings, otherwise check canBuildAt
    if (!canStackAt(gx, gy, itemKey, playerId) && !canBuildAt(gx, gy, playerId)) return false;

    if (cardDef.target === 'wall') {
        // Tower - check if same type exists for stacking
        let existing = getTowerAtTile(gx, gy);
        if (!(existing && existing.type === itemKey && existing.owner === playerId)) existing = null;
        if (existing) { existing.upgrade(); }
        else {
            grid[gy][gx].type = TYPE_WALL;
            grid[gy][gx].owner = playerId;
            let t = new Tower(gx, gy, itemKey, playerId);
            t.underConstruction = true; t.energy = 1;
            t.autoUpgradeEnabled = useDefaultAutoUpgrade;
            t.buildEnabled = useDefaultBuild;
            t.level = 0; t.effectiveLevel = 0; t.potentialEffectiveLevel = 0;
            t.updateTextCache();
            towers.push(t);
            setTileEntity(gx, gy, itemKey, t);
            placedNewStructure = true;
            placedNewWallStructure = true;
        }
        _markCombinedBgTileDirty(gx, gy, 0, true);
    } else if (itemKey.startsWith('barrack_')) {
        let unitType = cardDef.unitType || 'norm';
        let existing = getBarrackAtTile(gx, gy);
        if (!(existing && existing.unitType === unitType && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let b = new Barrack(gx, gy, playerId, unitType);
            b.underConstruction = true; b.energy = 1;
            b.autoUpgradeEnabled = useDefaultAutoUpgrade;
            b.buildEnabled = useDefaultBuild;
            b.level = 0; b.effectiveLevel = 0; b.potentialEffectiveLevel = 0;
            updateItemTextCache(b);
            barracks.push(b);
            grid[gy][gx].item = b;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, b);
            placedNewStructure = true;
        }
    } else if (itemKey === 'spawner') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'spawner' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new CollectorSpawner(gx, gy, playerId);
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            collectorSpawners.push(s);
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else if (itemKey === 'astar_spawner') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'astar_spawner' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new AstarSpawner(gx, gy, playerId);
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            collectorSpawners.push(s);
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else if (itemKey === 'salvager') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'salvager' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new SalvagerSpawner(gx, gy, playerId);
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            collectorSpawners.push(s);
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else if (itemKey === 'builder_spawner') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'builder_spawner' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new BuilderSpawner(gx, gy, playerId);
            // builder spawner starts under construction too
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            collectorSpawners.push(s);
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else if (itemKey === 'healer_spawner') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'healer_spawner' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new HealerSpawner(gx, gy, playerId);
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            collectorSpawners.push(s);
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else if (itemKey === 'research') {
        let existing = getSpawnerAtTile(gx, gy);
        if (!(existing && existing.type === 'research' && existing.owner === playerId)) existing = null;
        if (existing) {
            addManualStackToThing(existing, 1);
        }
        else {
            let s = new ResearchSpawner(gx, gy, playerId);
            s.underConstruction = true; s.energy = 1;
            s.autoUpgradeEnabled = useDefaultAutoUpgrade;
            s.buildEnabled = useDefaultBuild;
            s.level = 0; s.effectiveLevel = 0; s.potentialEffectiveLevel = 0;
            updateItemTextCache(s);
            collectorSpawners.push(s);
            grid[gy][gx].item = s;
            grid[gy][gx].owner = playerId;
            setTileEntity(gx, gy, itemKey, s);
            placedNewStructure = true;
        }
    } else {
        // Floor item
        let cell = grid[gy][gx];
        if (cell.item && cell.item.type === itemKey && cell.owner === playerId) {
            addManualStackToThing(cell.item, 1);
        } else {
            let stats = calculateItemStats(itemKey, 1, playerId);
            let item = { type: itemKey, stacks: 1, manualStacks: 1, effectiveStacks: 1, level: 0, effectiveLevel: 0, potentialEffectiveLevel: 0, isStacking: false, stackingWorkDone: 0, energy: 1, maxEnergy: stats.maxEnergy, damage: stats.damage || 0, gx, gy, x: gx * TILE + 16, y: gy * TILE + 16, underConstruction: true, owner: playerId, autoUpgradeEnabled: useDefaultAutoUpgrade, buildEnabled: useDefaultBuild };
            cell.item = item;
            cell.owner = playerId;
            setTileEntity(gx, gy, itemKey, item);
            updateItemTextCache(item);
            placedNewStructure = true;
        }
    }
    // Newly placed structures start under construction, so they don't affect adjacency yet.
    // Avoid expensive full-map adjacency recalculation on every placement.
    if (placedNewStructure) _bumpPathTopologyVersion();
    if (placedNewWallStructure) recalculateLaserConnections();
    if (playerId === localPlayerId && !silentPlace) playSound('place', gx * TILE + 16, gy * TILE + 16);
    return true;
}

function destroyBuilding(building) {
    if (building instanceof Tower || (building.constructor && building.constructor.name === 'Tower')) {
        let idx = towers.indexOf(building);
        if (idx !== -1) towers.splice(idx, 1);
        clearTileEntity(building.gx, building.gy, building);
        grid[building.gy][building.gx].type = TYPE_FLOOR;
        grid[building.gy][building.gx].owner = -1;
        _markCombinedBgTileDirty(building.gx, building.gy, 0, true);
        recalculateAdjacency();
        recalculateLaserConnections();
    } else if (building instanceof Barrack || (building.type === 'barrack')) {
        let idx = barracks.indexOf(building);
        if (idx !== -1) barracks.splice(idx, 1);
        clearTileEntity(building.gx, building.gy, building);
        grid[building.gy][building.gx].item = null;
        grid[building.gy][building.gx].owner = -1;
        recalculateAdjacency();
    } else if (building instanceof CollectorSpawner || building instanceof AstarSpawner || building instanceof SalvagerSpawner || building instanceof BuilderSpawner || building instanceof HealerSpawner || building instanceof ResearchSpawner) {
        let idx = collectorSpawners.indexOf(building);
        if (idx !== -1) collectorSpawners.splice(idx, 1);
        clearTileEntity(building.gx, building.gy, building);
        grid[building.gy][building.gx].item = null;
        grid[building.gy][building.gx].owner = -1;
    } else if (building.type) {
        // Floor item
        clearTileEntity(building.gx, building.gy, building);
        grid[building.gy][building.gx].item = null;
        grid[building.gy][building.gx].owner = -1;
    }
    createExplosion(building.x, building.y, '#f44', 10);
    playSound('building_destroyed', building.x, building.y);
    checkWinCondition();
}


// ============================================================
// ITEM STATS
// ============================================================
function getUpgrademaxEnergy(item, nextLevel) {
    if (item.type === 'barrack' || (item.type && item.type.startsWith('barrack'))) {
        let bType = item.unitType ? ('barrack_' + item.unitType) : 'barrack_norm';
        return calculateItemStats(bType, nextLevel, item.owner).maxEnergy;
    }
    if (item.type === 'spawner' || item.type === 'astar_spawner' || item.type === 'salvager' || item.type === 'builder_spawner' || item.type === 'healer_spawner' || item.type === 'research') return calculateItemStats(item.type, nextLevel, item.owner).maxEnergy;
    if (item instanceof Tower) return calculateItemStats(item.type, nextLevel, item.owner).maxEnergy;
    return calculateItemStats(item.type || 'farm', nextLevel, item.owner).maxEnergy;
}

function beginUpgradeProgress(item, nextLevel) {
    if (!item) return;
    let targetmaxEnergy = Math.max(1, Math.floor(getUpgrademaxEnergy(item, nextLevel) || (item.maxEnergy || 1)));
    item.isUpgrading = true;
    item.isStacking = false;
    item.upgrademaxEnergy = targetmaxEnergy;
    item.maxEnergy = targetmaxEnergy;
    if (!Number.isFinite(item.energy) || item.energy < 1) item.energy = 1;
    item.energy = Math.min(item.energy, item.maxEnergy);
}

function getDisplayLevel(item) {
    if (!item) return 1;
    if (item.underConstruction) return 0;
    if (item.effectiveLevel !== undefined) return clampThingLevel(item.effectiveLevel);
    if (item.level !== undefined) return clampThingLevel(item.level);
    return stackCountToLevel(item.stacks || 1);
}

function getRequiredStacksForLevel(level) {
    let lvl = Math.max(1, clampThingLevel(Math.floor(Number(level) || 1)));
    return Math.max(1, Math.round(Math.pow(2, lvl - 1)));
}

function getThingStackedStacks(item) {
    if (!item) return 1;
    return Math.max(1, Math.floor(Number(item.stacks) || 1));
}

function getThingManualStacks(item) {
    if (!item) return 1;
    let stacked = getThingStackedStacks(item);
    let manual = Number.isFinite(item.manualStacks) ? Math.floor(item.manualStacks) : stacked;
    return Math.max(stacked, Math.max(1, manual));
}

function getThingRemainingStacks(item) {
    return Math.max(0, getThingManualStacks(item) - getThingStackedStacks(item));
}

function getThingStackingProgressRatio(item) {
    let stacked = getThingStackedStacks(item);
    let total = getThingManualStacks(item);
    if (total <= 0) return 1;
    let stackCost = getThingStackingEnergyCost(item);
    let partial = 0;
    if (stackCost > 0) {
        let work = Math.max(0, Number(item && item.stackingWorkDone) || 0);
        partial = Math.max(0, Math.min(1, work / stackCost));
    }
    let progressStacks = Math.min(total, stacked + partial);
    return Math.max(0, Math.min(1, progressStacks / total));
}

function getThingStackingRemainingEnergy(item) {
    if (!item) return 0;
    let remainingStacks = getThingRemainingStacks(item);
    if (remainingStacks <= 0) return 0;
    let stackCost = getThingStackingEnergyCost(item);
    let done = Math.max(0, Number(item.stackingWorkDone) || 0);
    return Math.max(0, remainingStacks * stackCost - done);
}

function getThingStackingEnergyCost(item) {
    if (!item) return 1;
    let baseEnergy = getUpgrademaxEnergy(item, 1);
    if (!Number.isFinite(baseEnergy) || baseEnergy <= 0) baseEnergy = item.maxEnergy || 1;
    return Math.max(1, Math.floor(baseEnergy));
}

function refreshThingProgressState(item) {
    if (!item) return;

    item.stacks = getThingStackedStacks(item);
    item.manualStacks = getThingManualStacks(item);
    if (!Number.isFinite(item.stackingWorkDone) || item.stackingWorkDone < 0) item.stackingWorkDone = 0;

    let hasPendingStacks = getThingRemainingStacks(item) > 0;
    if (item.underConstruction || item.isUpgrading) {
        item.isStacking = false;
        return;
    }

    let effLevel = getThingEffectiveLevel(item);
    let potLevel = getThingPotentialLevel(item, effLevel);
    if (potLevel > effLevel && isAutoUpgradeEnabled(item)) {
        beginUpgradeProgress(item, effLevel + 1);
        item.isStacking = false;
        return;
    }

    item.isStacking = hasPendingStacks && isAutoStackEnabled(item);
    if (!item.isStacking) item.stackingWorkDone = 0;
    if (!item.underConstruction && !item.isUpgrading && !item.isStacking && Number.isFinite(item.gx) && Number.isFinite(item.gy)) {
        let builderTypeIndex = _workerTypeToLoadIndex('builder');
        let tileIndex = Math.floor(item.gy) * GRID_W + Math.floor(item.gx);
        let slotIndex = tileIndex * _WORKER_TARGET_LOAD_TYPE_COUNT + builderTypeIndex;
        let reservedUnit = workerReservedTiles[slotIndex];
        if (reservedUnit) reservedUnit._workerReservedTileIndex = -1;
        workerReservedTiles[slotIndex] = null;
    }
}

function addManualStackToThing(item, amount = 1) {
    if (!item) return;
    let addCount = Math.max(1, Math.floor(Number(amount) || 1));
    item.stacks = getThingStackedStacks(item);
    item.manualStacks = getThingManualStacks(item) + addCount;
    item.level = stackCountToLevel(item.stacks);
    refreshThingProgressState(item);
    if (item.updateTextCache) item.updateTextCache();
    else updateItemTextCache(item);
}

function getThingBaseLevel(item, fallback = 1) {
    if (!item) return Math.max(1, clampThingLevel(fallback));
    if (Number.isFinite(item.level)) return Math.max(1, clampThingLevel(item.level));
    if (Number.isFinite(item.stacks)) return stackCountToLevel(item.stacks || 1);
    return Math.max(1, clampThingLevel(fallback));
}

function getThingEffectiveLevel(item, fallback = 1) {
    if (!item) return Math.max(1, clampThingLevel(fallback));
    if (Number.isFinite(item.effectiveLevel)) return Math.max(1, clampThingLevel(item.effectiveLevel));
    return getThingBaseLevel(item, fallback);
}

function getThingPotentialLevel(item, fallback = 1) {
    let lvl = getThingEffectiveLevel(item, fallback);
    if (!item) return lvl;
    if (Number.isFinite(item.potentialEffectiveLevel)) lvl = Math.max(lvl, Math.max(1, clampThingLevel(item.potentialEffectiveLevel)));
    if (Number.isFinite(item.level)) lvl = Math.max(lvl, Math.max(1, clampThingLevel(item.level)));
    if (Number.isFinite(item.stacks)) lvl = Math.max(lvl, stackCountToLevel(item.stacks || 1));
    return lvl;
}

function getUnitBaseLevel(unit, fallback = 1) {
    if (!unit) return Math.max(1, clampThingLevel(fallback));
    if (Number.isFinite(unit.unitLevel)) return Math.max(1, clampThingLevel(unit.unitLevel));
    if (Number.isFinite(unit.baseLevel)) return Math.max(1, clampThingLevel(unit.baseLevel));
    if (Number.isFinite(unit.stackCount)) return stackCountToLevel(unit.stackCount || 1);
    return Math.max(1, clampThingLevel(fallback));
}

function getUnitEffectiveLevel(unit, fallback = 1) {
    if (!unit) return Math.max(1, clampThingLevel(fallback));
    if (Number.isFinite(unit.effectiveLevel)) return Math.max(1, clampThingLevel(unit.effectiveLevel));
    return getUnitBaseLevel(unit, fallback);
}

function getConfiguredMaxPop() {
    return Math.max(1, Math.floor(CONFIG_MAX_POP || 200));
}

function getHousePopCapContribution(ownerId, level) {
    let lvl = Math.max(1, clampThingLevel(Math.floor(Number(level) || 1)));
    let mapped = getBuildingStatForOwner(ownerId, 'house', lvl, 'popCap');
    if (Number.isFinite(mapped)) return Math.max(1, Math.floor(mapped));
    return Math.max(1, Math.floor(Math.pow(1.6, lvl)));
}

function recomputePlayerPopCaps() {
    let cfgCap = getConfiguredMaxPop();
    if (_popCapScratchByOwner.length !== players.length) _popCapScratchByOwner = new Int32Array(players.length);
    else _popCapScratchByOwner.fill(0);
    let popByOwner = _popCapScratchByOwner;

    // Single grid pass: avoid O(players * grid) work.
    for (let y = 0; y < GRID_H; y++) {
        let row = grid[y];
        if (!row) continue;
        for (let x = 0; x < GRID_W; x++) {
            let cell = row[x];
            if (!cell) continue;
            let item = cell.item;
            if (!item || item.type !== 'house') continue;
            let owner = cell.owner;
            if (owner < 0 || owner >= players.length) continue;
            if (item.energy <= 0 || item.underConstruction) continue;
            let level = Math.max(1, Math.floor(getDisplayLevel(item) || 1));
            popByOwner[owner] += getHousePopCapContribution(owner, level);
        }
    }

    for (let pid = 0; pid < players.length; pid++) {
        playerPopCaps[pid] = Math.min(cfgCap, popByOwner[pid] || 0);
    }
}


function getEntityVisibilityRangeArea(e) {
    if (!e) return null;
    if (e.preComputed && Number.isFinite(e.preComputed.visionRangeArea)) return e.preComputed.visionRangeArea;
    if (e.currentStats && Number.isFinite(e.currentStats.visionRangeArea)) return e.currentStats.visionRangeArea;
    if (e.basePreComputed && Number.isFinite(e.basePreComputed.visionRangeArea)) return e.basePreComputed.visionRangeArea;
    if (e.currentStats && Number.isFinite(e.currentStats.visionRange)) return e.currentStats.visionRange;
    if (e.preComputed && Number.isFinite(e.preComputed.visionRange)) return Number(e.preComputed.visionRange) / AREA_UNIT_TILE_EQUIVALENT;
    if (e.basePreComputed && Number.isFinite(e.basePreComputed.visionRange)) return Number(e.basePreComputed.visionRange) / AREA_UNIT_TILE_EQUIVALENT;
    return null;
}

function getEntityVisibilityRangeTiles(e) {
    let area = getEntityVisibilityRangeArea(e);
    return Number.isFinite(area) ? (Number(area) * AREA_UNIT_TILE_EQUIVALENT) : null;
}

function getEntityStatsCalcType(e) {
    if (!e) return '';
    if (e.type === 'barrack' && e.unitType) return 'barrack_' + e.unitType;
    return e.type || '';
}

function getEntityBaseVisibilityRangeArea(e) {
    if (!e) return null;
    if (e.basePreComputed && Number.isFinite(e.basePreComputed.visionRangeArea)) return e.basePreComputed.visionRangeArea;
    let statsType = getEntityStatsCalcType(e);
    let baseLevel = getThingBaseLevel(e, stackCountToLevel((e.stacks || 1)));
    if (statsType) {
        let s = calculateItemStats(statsType, baseLevel, e.owner);
        if (s && Number.isFinite(s.visionRange)) return s.visionRange;
        if (typeof getBuildingStatForOwner === 'function') {
            let statVision = Number(getBuildingStatForOwner(e.owner, statsType, baseLevel, 'visionRange'));
            if (Number.isFinite(statVision)) return statVision;
        }
        let defVision = Number(BASE_CARD_TYPES && BASE_CARD_TYPES[statsType] && BASE_CARD_TYPES[statsType].visionRange);
        if (Number.isFinite(defVision)) return defVision;
    }
    return getEntityVisibilityRangeArea(e);
}

function getEntityBaseVisibilityRangeTiles(e) {
    let area = getEntityBaseVisibilityRangeArea(e);
    return Number.isFinite(area) ? (Number(area) * AREA_UNIT_TILE_EQUIVALENT) : null;
}

function getEntityEffectiveVisibilityRangeArea(e) {
    if (!e) return null;
    if (e.preComputed && Number.isFinite(e.preComputed.visionRangeArea)) return e.preComputed.visionRangeArea;
    let statsType = getEntityStatsCalcType(e);
    let baseLevel = getThingBaseLevel(e, stackCountToLevel((e.stacks || 1)));
    let effLevel = getThingEffectiveLevel(e, baseLevel);
    if (statsType) {
        let s = calculateItemStats(statsType, effLevel, e.owner);
        if (s && Number.isFinite(s.visionRange)) return s.visionRange;
        if (typeof getBuildingStatForOwner === 'function') {
            let statVision = Number(getBuildingStatForOwner(e.owner, statsType, effLevel, 'visionRange'));
            if (Number.isFinite(statVision)) return statVision;
        }
        let defVision = Number(BASE_CARD_TYPES && BASE_CARD_TYPES[statsType] && BASE_CARD_TYPES[statsType].visionRange);
        if (Number.isFinite(defVision)) return defVision;
    }
    return getEntityVisibilityRangeArea(e);
}

function getEntityEffectiveVisibilityRangeTiles(e) {
    let area = getEntityEffectiveVisibilityRangeArea(e);
    return Number.isFinite(area) ? (Number(area) * AREA_UNIT_TILE_EQUIVALENT) : null;
}

function getEntityBaseEnergyMax(e) {
    if (!e) return 0;
    let statsType = getEntityStatsCalcType(e);
    let baseLevel = getThingBaseLevel(e, stackCountToLevel((e.stacks || 1)));
    if (statsType) {
        let s = calculateItemStats(statsType, baseLevel, e.owner);
        if (s && Number.isFinite(s.maxEnergy)) return Math.max(1, Math.floor(s.maxEnergy));
    }
    return getEntityEnergyDisplayMax(e);
}

function getEntityEffectiveEnergyMax(e) {
    if (!e) return 0;
    let statsType = getEntityStatsCalcType(e);
    let baseLevel = getThingBaseLevel(e, stackCountToLevel((e.stacks || 1)));
    let effLevel = getThingEffectiveLevel(e, baseLevel);
    if (statsType) {
        let s = calculateItemStats(statsType, effLevel, e.owner);
        if (s && Number.isFinite(s.maxEnergy)) return Math.max(1, Math.floor(s.maxEnergy));
    }
    return getEntityEnergyDisplayMax(e);
}

function getUnitRenderActionRangeArea(u) {
    if (!u) return 0;
    if (u.workerType === 'collector' || u.workerType === 'astar_collector' || u.workerType === 'salvager' || u.workerType === 'builder' || u.workerType === 'healer' || u.workerType === 'researcher') {
        return (24 / TILE) / AREA_UNIT_TILE_EQUIVALENT;
    }
    let atkRange = Math.max(0, Number(u.preComputed && u.preComputed.attackRangeArea) || 0);
    if (atkRange <= 0 && Number.isFinite(u.preComputed && u.preComputed.attackRange)) {
        atkRange = ((Number(u.preComputed.attackRange) || 0) / TILE) / AREA_UNIT_TILE_EQUIVALENT;
    }
    return Math.max(0, atkRange);
}

function getUnitRenderActionRangePx(u) {
    let area = getUnitRenderActionRangeArea(u);
    return area > 0 ? (Number(area) * AREA_UNIT_TILE_EQUIVALENT * TILE) : 0;
}

function getAreaRangeCellsAtWorld(wx, wy, rangeArea) {
    let sourceAreaId = getAreaIdAtWorld(wx, wy);
    if (sourceAreaId < 0) return [];
    return getGridCellsWithinAreaDistance(sourceAreaId, Math.floor(Math.max(0, Number(rangeArea) || 0)));
}

function markConstructionComplete(item) {
    if (!item) return;
    item.underConstruction = false;
    if ((item.level || 0) < 1) item.level = 1;
    if ((item.effectiveLevel || 0) < 1) item.effectiveLevel = 1;
    if ((item.potentialEffectiveLevel || 0) < 1) item.potentialEffectiveLevel = 1;
    refreshThingProgressState(item);
    if (item.updateTextCache) item.updateTextCache();
    else updateItemTextCache(item);
}

function isAutoUpgradeEnabled(item) {
    return item && item.autoUpgradeEnabled !== false;
}

function isBuildEnabled(item) {
    return item && item.buildEnabled !== false;
}

function isAutoStackEnabled(item) {
    return item && item.autoStackEnabled !== false;
}

function isQueueEnabled(item) {
    return item && item.queueEnabled !== false;
}

function isAutoResearchEnabled(item) {
    if (!item || item.type !== 'research') return true;
    return item.autoResearchEnabled !== false;
}


function getLevelLabelText(item) {
    let currentLevel = Math.max(0, Math.floor(getDisplayLevel(item) || 0));
    let potentialLevel = item && item.potentialEffectiveLevel !== undefined
        ? Math.max(0, Math.floor(item.potentialEffectiveLevel || 0))
        : currentLevel;
    if (item && !item.underConstruction) {
        let manualLevel = stackCountToLevel(getThingManualStacks(item));
        potentialLevel = Math.max(potentialLevel, manualLevel);
    }
    return potentialLevel !== currentLevel
        ? `L${currentLevel}->L${potentialLevel}`
        : `L${currentLevel}`;
}

function getUnitLevelLabelText(unit) {
    let lvl = getUnitBaseLevel(unit);
    return `L${lvl}`;
}

function shouldShowBuildingLevels() {
    if (!(levelVisibilityMode === LEVEL_VISIBILITY_ALL || levelVisibilityMode === LEVEL_VISIBILITY_BUILDINGS)) return false;
    if (!camera || !Number.isFinite(camera.zoom)) return true;
    return camera.zoom >= 0.62;
}

function shouldShowUnitLevels() {
    if (levelVisibilityMode !== LEVEL_VISIBILITY_ALL) return false;
    if (!camera || !Number.isFinite(camera.zoom)) return true;
    return camera.zoom >= 0.7;
}

function getLevelVisibilityButtonText() {
    if (levelVisibilityMode === LEVEL_VISIBILITY_ALL) return 'Levels: Everything';
    if (levelVisibilityMode === LEVEL_VISIBILITY_BUILDINGS) return 'Levels: Buildings';
    return 'Levels: Off';
}

function updateLevelVisibilityButton() {
    let btn = document.getElementById('btn-level-visibility');
    if (!btn) return;
    btn.textContent = getLevelVisibilityButtonText();
}

function cycleLevelVisibilityMode() {
    levelVisibilityMode = (levelVisibilityMode + 1) % 3;
    updateLevelVisibilityButton();
    saveUiSettingsToStorage();
}

function getRenderRangeButtonText() {
    if (renderRangeMode === RENDER_RANGE_TURRETS) return 'Render range: Turrets';
    if (renderRangeMode === RENDER_RANGE_TURRETS_AND_UNITS) return 'Render range: Turrets + Units';
    return 'Render range: None';
}

function updateRenderRangeButton() {
    let btn = document.getElementById('btn-render-range');
    if (!btn) return;
    btn.textContent = getRenderRangeButtonText();
}

function cycleRenderRangeMode() {
    renderRangeMode = (renderRangeMode + 1) % 3;
    updateRenderRangeButton();
    saveUiSettingsToStorage();
}

function getBuildPlacementModeButtonText() {
    return `Build place: ${buildPlacementMode + 1}`;
}

function getBuildPlacementModeDescription() {
    if (buildPlacementMode === BUILD_PLACE_MODE_DRAG_KEEP) {
        return 'Left Click: place + keep selected | Shift + Left Click: place + drag place + keep selected';
    }
    if (buildPlacementMode === BUILD_PLACE_MODE_SHIFT_KEEP) {
        return 'Left Click: place + unselect | Shift + Left Click: place + keep selected';
    }
    return 'Left Click: place + unselect | Shift + Left Click: place + keep selected + drag place';
}

function updateBuildPlacementModeButton() {
    let btn = document.getElementById('btn-build-place-mode');
    if (btn) btn.textContent = getBuildPlacementModeButtonText();
    let desc = document.getElementById('build-place-mode-desc');
    if (desc) desc.textContent = getBuildPlacementModeDescription();
}

function cycleBuildPlacementMode() {
    buildPlacementMode = (buildPlacementMode + 1) % 3;
    updateBuildPlacementModeButton();
    saveUiSettingsToStorage();
}

function shouldShiftDragBuildPlace(shiftHeld) {
    if (!shiftHeld) return false;
    return buildPlacementMode === BUILD_PLACE_MODE_DRAG_KEEP || buildPlacementMode === BUILD_PLACE_MODE_SHIFT_DRAG;
}

function shouldKeepBuildSelectionAfterLeftClick(shiftHeld) {
    if (buildPlacementMode === BUILD_PLACE_MODE_DRAG_KEEP) return true;
    if (!shiftHeld) return false;
    return buildPlacementMode === BUILD_PLACE_MODE_SHIFT_KEEP || buildPlacementMode === BUILD_PLACE_MODE_SHIFT_DRAG;
}

function formatRangeStatTiles(v) {
    return Number.isFinite(v) ? `${Math.max(0, Math.floor(Number(v) / AREA_UNIT_TILE_EQUIVALENT))}a` : '-';
}