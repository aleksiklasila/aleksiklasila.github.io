"use strict";

function _spatialChunkPlayerFlatIndex(chunkKey, owner) {
    if (!Number.isFinite(chunkKey) || !Number.isFinite(owner)) return -1;
    let ck = Math.floor(chunkKey);
    let pid = Math.floor(owner);
    if (ck < 0 || ck >= (CHUNKS_W * CHUNKS_H)) return -1;
    if (pid < 0 || pid >= spatialUnitsComplexPlayerCount) return -1;
    return ck * spatialUnitsComplexPlayerCount + pid;
}

function _isDamagedLivingUnitForOwner(u, owner) {
    if (!u || u.dead) return false;
    if (u.owner !== owner) return false;
    let maxEnergy = Number(u.preComputed && u.preComputed.maxEnergy);
    if (!Number.isFinite(u.energy) || !Number.isFinite(maxEnergy)) return false;
    return u.energy > 0 && u.energy < maxEnergy;
}

function _isUnitHealthLowerThan(a, b) {
    if (!a || !b) return false;
    let aE = Number(a.energy), aM = Number(a.preComputed && a.preComputed.maxEnergy);
    let bE = Number(b.energy), bM = Number(b.preComputed && b.preComputed.maxEnergy);
    if (!(aM > 0) || !(bM > 0)) return false;
    return (aE * bM) < (bE * aM);
}

function _recomputeSpatialLowestHealthUnitForChunkPlayer(chunkKey, owner) {
    if (!ENABLE_SPATIAL_LOWEST_HEALTH_CACHE) return null;
    if (!Number.isFinite(chunkKey) || !Number.isFinite(owner)) return null;
    let ck = Math.floor(chunkKey);
    let pid = Math.floor(owner);
    let idx = _spatialChunkPlayerFlatIndex(ck, pid);
    if (idx < 0) return null;

    let chunk = spatialUnits[ck];
    let best = null;
    if (chunk && chunk.length > 0) {
        for (let u of chunk) {
            if (!_isDamagedLivingUnitForOwner(u, pid)) continue;
            if (!best || _isUnitHealthLowerThan(u, best)) best = u;
        }
    }
    spatialUnitsComplexLowestHealthUnit[idx] = best;
    return best;
}

function _updateSpatialLowestHealthForUnit(u, chunkKey) {
    if (!ENABLE_SPATIAL_LOWEST_HEALTH_CACHE) return;
    if (!u || !Number.isFinite(chunkKey)) return;
    let ck = Math.floor(chunkKey);
    let owner = Math.floor(Number(u.owner));
    let idx = _spatialChunkPlayerFlatIndex(ck, owner);
    if (idx < 0) return;

    let current = spatialUnitsComplexLowestHealthUnit[idx];
    let currentValid = current
        && current._spatialKey === ck
        && _isDamagedLivingUnitForOwner(current, owner);

    if (!_isDamagedLivingUnitForOwner(u, owner)) {
        if (current === u) _recomputeSpatialLowestHealthUnitForChunkPlayer(ck, owner);
        else if (!currentValid) _recomputeSpatialLowestHealthUnitForChunkPlayer(ck, owner);
        return;
    }

    if (!currentValid || current === u || _isUnitHealthLowerThan(u, current)) {
        spatialUnitsComplexLowestHealthUnit[idx] = u;
    }
}

function _getSpatialUnitVisibilityScaled(u) {
    if (!u || u.dead) return 0;
    let value = Number(u.preComputed && u.preComputed.visionRange);
    if (!Number.isFinite(value) || value <= 0) {
        value = Number(u.currentStats && u.currentStats.visionRange);
    }
    if (!Number.isFinite(value) || value <= 0) {
        value = Number((BASE_UNIT_STATS[u.unitType] || BASE_UNIT_STATS.norm || {}).visionRange) || 4;
    }
    return Math.max(0, Math.round(value * SPATIAL_VISIBILITY_SCALE));
}

function _updateSpatialMaxUnitVisibilityForChunkPlayerWithPrevious(chunkKey, owner, previousScaled, currentScaled) {
    if (!(spatialUnitsComplexMaxUnitVisOffset >= 0)) return;
    if (!Number.isFinite(chunkKey) || !Number.isFinite(owner)) return;
    let ck = Math.floor(chunkKey);
    let pid = Math.floor(owner);
    if (pid < 0 || pid >= spatialUnitsComplexPlayerCount) return;
    let playerBase = (ck * spatialUnitsComplexStridePerChunk) + (pid * spatialUnitsComplexStridePerPlayer);
    let maxIdx = playerBase + spatialUnitsComplexMaxUnitVisOffset;
    let maxScaled = spatialUnitsComplex[maxIdx] | 0;
    if (currentScaled > maxScaled) {
        spatialUnitsComplex[maxIdx] = currentScaled;
        return;
    }
    // If this unit was (or tied for) the chunk max and dropped visibility/dead/removed, recompute max.
    if (previousScaled >= maxScaled && currentScaled < previousScaled) {
        _recomputeSpatialMaxUnitVisibilityForChunkPlayer(ck, pid);
    }
}

function _recomputeSpatialMaxUnitVisibilityForChunkPlayer(chunkKey, owner) {
    if (!(spatialUnitsComplexMaxUnitVisOffset >= 0)) return;
    if (!Number.isFinite(chunkKey) || !Number.isFinite(owner)) return;
    let ck = Math.floor(chunkKey);
    let pid = Math.floor(owner);
    if (ck < 0 || ck >= spatialUnits.length) return;
    if (pid < 0 || pid >= spatialUnitsComplexPlayerCount) return;
    let maxScaled = 0;
    let chunk = spatialUnits[ck];
    if (chunk && chunk.length > 0) {
        for (let u of chunk) {
            if (!u || u.dead || Math.floor(Number(u.owner)) !== pid) continue;
            let scaled = _getSpatialUnitVisibilityScaled(u);
            if (scaled > maxScaled) maxScaled = scaled;
        }
    }
    let playerBase = (ck * spatialUnitsComplexStridePerChunk) + (pid * spatialUnitsComplexStridePerPlayer);
    spatialUnitsComplex[playerBase + spatialUnitsComplexMaxUnitVisOffset] = maxScaled;
}

function initSpatialHash() {
    CHUNKS_W = Math.ceil(GRID_W / CHUNK_SIZE);
    CHUNKS_H = Math.ceil(GRID_H / CHUNK_SIZE);
    spatialUnits = [];
    for (let i = 0; i < CHUNKS_W * CHUNKS_H; i++) spatialUnits.push([]);
    closestEnemyChunkQueryCache.clear();

    spatialUnitTypeToIndex = Object.create(null);
    let unitKeys = Object.keys(BASE_UNIT_STATS || {});
    if (!unitKeys.includes('norm')) unitKeys.push('norm');
    for (let i = 0; i < unitKeys.length; i++) spatialUnitTypeToIndex[unitKeys[i]] = i;
    spatialNormUnitTypeIndex = Number.isFinite(spatialUnitTypeToIndex.norm) ? spatialUnitTypeToIndex.norm : 0;
    spatialUnitsComplexUnitTypeCount = unitKeys.length;
    spatialUnitsComplexPlayerCount = Math.max(1, Math.floor(Number(players && players.length) || 0));
    spatialUnitsComplexMaxUnitVisOffset = 1 + spatialUnitsComplexUnitTypeCount;
    spatialUnitsComplexMaxThingVisOffset = spatialUnitsComplexMaxUnitVisOffset + 1;
    spatialUnitsComplexStridePerPlayer = spatialUnitsComplexMaxThingVisOffset + 1; // total + perUnitType + maxUnitVis + maxThingVis
    spatialUnitsComplexStridePerChunk = spatialUnitsComplexPlayerCount * spatialUnitsComplexStridePerPlayer;
    spatialUnitsComplex = new Int32Array((CHUNKS_W * CHUNKS_H) * spatialUnitsComplexStridePerChunk);
    if (ENABLE_SPATIAL_LOWEST_HEALTH_CACHE) {
        spatialUnitsComplexLowestHealthUnit = new Array((CHUNKS_W * CHUNKS_H) * spatialUnitsComplexPlayerCount).fill(null);
    } else {
        spatialUnitsComplexLowestHealthUnit = [];
    }
    let areaCount = Array.isArray(areas) ? areas.length : 0;
    spatialUnitsByArea = Array.from({ length: Math.max(0, areaCount) }, () => []);
}

function _addUnitToSpatialArray(arr, u) {
    if (!arr) return false;
    for (let i = 0; i < arr.length; i++) {
        if (arr[i] === u) return false;
        if (arr[i].id > u.id) {
            arr.splice(i, 0, u);
            return true;
        }
    }
    arr.push(u);
    return true;
}

function _removeUnitFromSpatialArray(arr, u) {
    if (!arr) return false;
    let i = arr.indexOf(u);
    if (i >= 0) {
        arr.splice(i, 1);
        return true;
    }
    return false;
}

function getSpatialKey(wx, wy) {
    let cx = Math.floor(wx / (CHUNK_SIZE * TILE));
    let cy = Math.floor(wy / (CHUNK_SIZE * TILE));
    cx = Math.max(0, Math.min(CHUNKS_W - 1, cx));
    cy = Math.max(0, Math.min(CHUNKS_H - 1, cy));
    return cy * CHUNKS_W + cx;
}
function updateUnitSpatial(u) {
    let newKey = getSpatialKey(u.x, u.y);
    let newAreaId = getAreaIdAtWorld(u.x, u.y);
    let prevScaled = Number.isFinite(u._spatialLastVisScaled) ? (u._spatialLastVisScaled | 0) : _getSpatialUnitVisibilityScaled(u);
    let currentScaled = _getSpatialUnitVisibilityScaled(u);
    if (u._spatialAreaId !== undefined && u._spatialAreaId !== newAreaId) {
        let oldAreaId = u._spatialAreaId;
        if (oldAreaId >= 0 && oldAreaId < spatialUnitsByArea.length) {
            _removeUnitFromSpatialArray(spatialUnitsByArea[oldAreaId], u);
        }
    }
    if (u._spatialKey !== undefined && u._spatialKey !== newKey) {
        let oldKey = u._spatialKey;
        if (_removeUnitFromSpatialArray(spatialUnits[u._spatialKey], u)) {
            let owner = Math.floor(Number(u.owner));
            if (owner >= 0 && owner < spatialUnitsComplexPlayerCount) {
                let typeIdx = Number.isFinite(u._spatialUnitTypeIdx)
                    ? u._spatialUnitTypeIdx
                    : (Number.isFinite(spatialUnitTypeToIndex[u.unitType]) ? spatialUnitTypeToIndex[u.unitType] : spatialNormUnitTypeIndex);
                let playerBase = (u._spatialKey * spatialUnitsComplexStridePerChunk) + (owner * spatialUnitsComplexStridePerPlayer);
                let totalIdx = playerBase;
                let typeCountIdx = playerBase + 1 + typeIdx;
                spatialUnitsComplex[totalIdx] = Math.max(0, spatialUnitsComplex[totalIdx] - 1);
                spatialUnitsComplex[typeCountIdx] = Math.max(0, spatialUnitsComplex[typeCountIdx] - 1);
                _updateSpatialMaxUnitVisibilityForChunkPlayerWithPrevious(oldKey, owner, prevScaled, 0);
            }
            if (ENABLE_SPATIAL_LOWEST_HEALTH_CACHE) {
                let oldIdx = _spatialChunkPlayerFlatIndex(oldKey, owner);
                if (oldIdx >= 0 && spatialUnitsComplexLowestHealthUnit[oldIdx] === u) {
                    _recomputeSpatialLowestHealthUnitForChunkPlayer(oldKey, owner);
                }
            }
        }
    }
    if (u._spatialKey === newKey) {
        _addUnitToSpatialArray(spatialUnits[newKey], u);
        if (newAreaId >= 0 && newAreaId < spatialUnitsByArea.length) _addUnitToSpatialArray(spatialUnitsByArea[newAreaId], u);
        let ownerSame = Math.floor(Number(u.owner));
        if (ownerSame >= 0 && ownerSame < spatialUnitsComplexPlayerCount) {
            _updateSpatialMaxUnitVisibilityForChunkPlayerWithPrevious(newKey, ownerSame, prevScaled, currentScaled);
        }
        u._spatialLastVisScaled = currentScaled;
        u._spatialAreaId = newAreaId;
        if (ENABLE_SPATIAL_LOWEST_HEALTH_CACHE) _updateSpatialLowestHealthForUnit(u, newKey);
        return;
    }
    _addUnitToSpatialArray(spatialUnits[newKey], u);
    if (newAreaId >= 0 && newAreaId < spatialUnitsByArea.length) _addUnitToSpatialArray(spatialUnitsByArea[newAreaId], u);
    let owner = Math.floor(Number(u.owner));
    if (owner >= 0 && owner < spatialUnitsComplexPlayerCount) {
        let typeIdx = spatialUnitTypeToIndex[u.unitType];
        if (!Number.isFinite(typeIdx)) typeIdx = spatialNormUnitTypeIndex;
        u._spatialUnitTypeIdx = typeIdx;
        let playerBase = (newKey * spatialUnitsComplexStridePerChunk) + (owner * spatialUnitsComplexStridePerPlayer);
        let totalIdx = playerBase;
        let typeCountIdx = playerBase + 1 + typeIdx;
        spatialUnitsComplex[totalIdx] += 1;
        spatialUnitsComplex[typeCountIdx] += 1;
        _updateSpatialMaxUnitVisibilityForChunkPlayerWithPrevious(newKey, owner, 0, currentScaled);
    }
    u._spatialKey = newKey;
    u._spatialAreaId = newAreaId;
    u._spatialLastVisScaled = currentScaled;
    if (ENABLE_SPATIAL_LOWEST_HEALTH_CACHE) _updateSpatialLowestHealthForUnit(u, newKey);
}
function removeUnitSpatial(u) {
    if (u._spatialKey !== undefined) {
        let oldKey = u._spatialKey;
        let prevScaled = Number.isFinite(u._spatialLastVisScaled) ? (u._spatialLastVisScaled | 0) : _getSpatialUnitVisibilityScaled(u);
        if (_removeUnitFromSpatialArray(spatialUnits[u._spatialKey], u)) {
            let owner = Math.floor(Number(u.owner));
            if (owner >= 0 && owner < spatialUnitsComplexPlayerCount) {
                let typeIdx = Number.isFinite(u._spatialUnitTypeIdx)
                    ? u._spatialUnitTypeIdx
                    : (Number.isFinite(spatialUnitTypeToIndex[u.unitType]) ? spatialUnitTypeToIndex[u.unitType] : spatialNormUnitTypeIndex);
                let playerBase = (u._spatialKey * spatialUnitsComplexStridePerChunk) + (owner * spatialUnitsComplexStridePerPlayer);
                let totalIdx = playerBase;
                let typeCountIdx = playerBase + 1 + typeIdx;
                spatialUnitsComplex[totalIdx] = Math.max(0, spatialUnitsComplex[totalIdx] - 1);
                spatialUnitsComplex[typeCountIdx] = Math.max(0, spatialUnitsComplex[typeCountIdx] - 1);
                _updateSpatialMaxUnitVisibilityForChunkPlayerWithPrevious(oldKey, owner, prevScaled, 0);
            }
            if (ENABLE_SPATIAL_LOWEST_HEALTH_CACHE) {
                let oldIdx = _spatialChunkPlayerFlatIndex(oldKey, owner);
                if (oldIdx >= 0 && spatialUnitsComplexLowestHealthUnit[oldIdx] === u) {
                    _recomputeSpatialLowestHealthUnitForChunkPlayer(oldKey, owner);
                }
            }
        }
        u._spatialLastVisScaled = 0;
        u._spatialKey = undefined;
    }
    if (u._spatialAreaId !== undefined) {
        let oldAreaId = u._spatialAreaId;
        if (oldAreaId >= 0 && oldAreaId < spatialUnitsByArea.length) {
            _removeUnitFromSpatialArray(spatialUnitsByArea[oldAreaId], u);
        }
        u._spatialAreaId = undefined;
    }
}

function forEachUnitInAreaRange(wx, wy, rangeAreaUnits, visitor, opts = null) {
    if (typeof visitor !== 'function') return false;
    let sourceAreaId = getAreaIdAtWorld(wx, wy);
    if (sourceAreaId < 0) return false;
    let maxDistance = Math.max(0, Math.floor(Number(rangeAreaUnits) || 0));
    let areaIds = getAreaIdsWithinDistance(sourceAreaId, maxDistance);
    if (!areaIds || areaIds.length <= 0) return false;

    let includeDead = !!(opts && opts.includeDead);
    let predicate = (opts && typeof opts.predicate === 'function') ? opts.predicate : null;
    let playerFilter = Number.isFinite(opts && opts.player) ? Math.floor(opts.player) : -1;
    let enemyFilter = Number.isFinite(opts && opts.enemyOfPlayer) ? Math.floor(opts.enemyOfPlayer) : -1;
    let unitTypeFilter = (opts && typeof opts.unitType === 'string' && opts.unitType.length > 0) ? opts.unitType : '';

    for (let i = 0; i < areaIds.length; i++) {
        let areaId = areaIds[i];
        let bucket = spatialUnitsByArea[areaId];
        if (!bucket || bucket.length <= 0) continue;
        for (let u of bucket) {
            if (!includeDead && u.dead) continue;
            if (playerFilter >= 0 && u.owner !== playerFilter) continue;
            if (enemyFilter >= 0 && u.owner === enemyFilter) continue;
            if (unitTypeFilter && u.unitType !== unitTypeFilter) continue;
            if (predicate && !predicate(u)) continue;
            if (visitor(u, areaId) === true) return true;
        }
    }
    return false;
}

function forEachGridCellInAreaRange(wx, wy, rangeAreaUnits, visitor) {
    if (typeof visitor !== 'function') return false;
    let sourceAreaId = getAreaIdAtWorld(wx, wy);
    if (sourceAreaId < 0) return false;
    let maxDistance = Math.max(0, Math.floor(Number(rangeAreaUnits) || 0));
    let cells = getGridCellsWithinAreaDistance(sourceAreaId, maxDistance);
    if (!cells || cells.length <= 0) return false;
    for (let i = 0; i < cells.length; i++) {
        let cell = cells[i];
        if (!cell) continue;
        if (visitor(cell, grid[cell.y] && grid[cell.y][cell.x], sourceAreaId) === true) return true;
    }
    return false;
}
function getUnitsInRange(wx, wy, rangePx) {
    let result = [];
    let r = rangePx + TILE;
    let minCx = Math.floor((wx - r) / (CHUNK_SIZE * TILE));
    let maxCx = Math.floor((wx + r) / (CHUNK_SIZE * TILE));
    let minCy = Math.floor((wy - r) / (CHUNK_SIZE * TILE));
    let maxCy = Math.floor((wy + r) / (CHUNK_SIZE * TILE));
    minCx = Math.max(0, minCx); maxCx = Math.min(CHUNKS_W - 1, maxCx);
    minCy = Math.max(0, minCy); maxCy = Math.min(CHUNKS_H - 1, maxCy);
    for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let u of spatialUnits[cy * CHUNKS_W + cx]) result.push(u);
        }
    }
    return result;
}

function forEachUnitInRange(wx, wy, rangePx, visitor, opts = null) {
    if (typeof visitor !== 'function') return false;
    let r = Math.max(0, Number(rangePx) || 0);
    let pad = (opts && Number.isFinite(opts.pad)) ? Math.max(0, opts.pad) : TILE;
    let scan = r + pad;
    let cws = CHUNK_SIZE * TILE;
    let minCx = Math.max(0, Math.floor((wx - scan) / cws));
    let maxCx = Math.min(CHUNKS_W - 1, Math.floor((wx + scan) / cws));
    let minCy = Math.max(0, Math.floor((wy - scan) / cws));
    let maxCy = Math.min(CHUNKS_H - 1, Math.floor((wy + scan) / cws));
    let radiusSq = r * r;
    let includeDead = !!(opts && opts.includeDead);
    let exact = !(opts && opts.exact === false);
    let predicate = (opts && typeof opts.predicate === 'function') ? opts.predicate : null;

    let playerFilter = -1, enemyFilter = -1, unitTypeFilterIdx = -1, unitTypeFilter = '';
    let hasPlayerFilter = false, hasEnemyFilter = false, hasUnitTypeFilter = false;
    let cplx = spatialUnitsComplex, cplxSC = spatialUnitsComplexStridePerChunk;
    let cplxSP = spatialUnitsComplexStridePerPlayer, nPlayers = spatialUnitsComplexPlayerCount;
    let canCplx = cplx.length > 0 && cplxSC > 0 && cplxSP > 0;
    if (opts) {
        if (Number.isFinite(opts.player)) {
            playerFilter = Math.floor(opts.player);
            if (playerFilter < 0 || playerFilter >= nPlayers) return false;
            hasPlayerFilter = true;
        }
        if (Number.isFinite(opts.enemyOfPlayer)) {
            enemyFilter = Math.floor(opts.enemyOfPlayer);
            if (enemyFilter < 0 || enemyFilter >= nPlayers) return false;
            hasEnemyFilter = true;
        }
        if (hasPlayerFilter && hasEnemyFilter && playerFilter === enemyFilter) return false;
        if (typeof opts.unitType === 'string' && opts.unitType.length > 0) {
            unitTypeFilter = opts.unitType;
            unitTypeFilterIdx = spatialUnitTypeToIndex[unitTypeFilter];
            if (!Number.isFinite(unitTypeFilterIdx)) return false;
            hasUnitTypeFilter = true;
        }
    }
    let useFilters = canCplx && (hasPlayerFilter || hasEnemyFilter || hasUnitTypeFilter);
    let typeOff = 1 + unitTypeFilterIdx; // only valid when hasUnitTypeFilter
    let chunks = spatialUnits, chunkCols = CHUNKS_W;

    // Hot path: exact alive scan for one player (healer/ally scans).
    if (!includeDead && exact && !predicate && hasPlayerFilter && !hasEnemyFilter && !hasUnitTypeFilter) {
        for (let cy = minCy; cy <= maxCy; cy++) {
            let rowBase = cy * chunkCols;
            for (let cx = minCx; cx <= maxCx; cx++) {
                let ck = rowBase + cx;
                if (canCplx) {
                    let cb = ck * cplxSC;
                    let pb = cb + playerFilter * cplxSP;
                    if (cplx[pb] <= 0) continue;
                }
                let chunk = chunks[ck];
                if (!chunk || chunk.length <= 0) continue;
                let minX = cx * cws, minY = cy * cws;
                let nx = wx < minX ? minX : (wx > minX + cws ? minX + cws : wx);
                let ny = wy < minY ? minY : (wy > minY + cws ? minY + cws : wy);
                let ddx = wx - nx, ddy = wy - ny;
                if (ddx * ddx + ddy * ddy > radiusSq) continue;
                for (let u of chunk) {
                    if (u.owner !== playerFilter || u.dead) continue;
                    let dx = u.x - wx, dy = u.y - wy;
                    let d2 = dx * dx + dy * dy;
                    if (d2 > radiusSq) continue;
                    if (visitor(u, d2, dx, dy) === true) return true;
                }
            }
        }
        return false;
    }

    // Hot path: no dead, exact, no predicate (all combat/vision/aggro scans)
    if (!includeDead && exact && !predicate) {
        for (let cy = minCy; cy <= maxCy; cy++) {
            let rowBase = cy * chunkCols;
            for (let cx = minCx; cx <= maxCx; cx++) {
                let ck = rowBase + cx;
                if (useFilters) {
                    let cb = ck * cplxSC;
                    if (hasPlayerFilter) {
                        let pb = cb + playerFilter * cplxSP;
                        if (hasUnitTypeFilter ? cplx[pb + typeOff] <= 0 : cplx[pb] <= 0) continue;
                    } else if (hasEnemyFilter) {
                        let ok = false;
                        for (let pid = 0; pid < nPlayers; pid++) {
                            if (pid === enemyFilter) continue;
                            let pb = cb + pid * cplxSP;
                            if (hasUnitTypeFilter ? cplx[pb + typeOff] > 0 : cplx[pb] > 0) { ok = true; break; }
                        }
                        if (!ok) continue;
                    } else {
                        let ok = false;
                        for (let pid = 0; pid < nPlayers; pid++) {
                            if (cplx[cb + pid * cplxSP + typeOff] > 0) { ok = true; break; }
                        }
                        if (!ok) continue;
                    }
                }
                let chunk = chunks[ck];
                if (!chunk || chunk.length <= 0) continue;
                let minX = cx * cws, minY = cy * cws;
                let nx = wx < minX ? minX : (wx > minX + cws ? minX + cws : wx);
                let ny = wy < minY ? minY : (wy > minY + cws ? minY + cws : wy);
                let ddx = wx - nx, ddy = wy - ny;
                if (ddx * ddx + ddy * ddy > radiusSq) continue;
                for (let u of chunk) {
                    if (hasPlayerFilter && u.owner !== playerFilter) continue;
                    if (hasEnemyFilter && u.owner === enemyFilter) continue;
                    if (hasUnitTypeFilter && u.unitType !== unitTypeFilter) continue;
                    if (u.dead) continue;
                    let dx = u.x - wx, dy = u.y - wy;
                    let d2 = dx * dx + dy * dy;
                    if (d2 > radiusSq) continue;
                    if (visitor(u, d2, dx, dy) === true) return true;
                }
            }
        }
        return false;
    }

    // General path
    for (let cy = minCy; cy <= maxCy; cy++) {
        let rowBase = cy * chunkCols;
        for (let cx = minCx; cx <= maxCx; cx++) {
            let ck = rowBase + cx;
            if (useFilters) {
                let cb = ck * cplxSC;
                if (hasPlayerFilter) {
                    let pb = cb + playerFilter * cplxSP;
                    if (hasUnitTypeFilter ? cplx[pb + typeOff] <= 0 : cplx[pb] <= 0) continue;
                } else if (hasEnemyFilter) {
                    let ok = false;
                    for (let pid = 0; pid < nPlayers; pid++) {
                        if (pid === enemyFilter) continue;
                        let pb = cb + pid * cplxSP;
                        if (hasUnitTypeFilter ? cplx[pb + typeOff] > 0 : cplx[pb] > 0) { ok = true; break; }
                    }
                    if (!ok) continue;
                } else {
                    let ok = false;
                    for (let pid = 0; pid < nPlayers; pid++) {
                        if (cplx[cb + pid * cplxSP + typeOff] > 0) { ok = true; break; }
                    }
                    if (!ok) continue;
                }
            }
            let chunk = chunks[ck];
            if (!chunk || chunk.length <= 0) continue;
            if (exact) {
                let minX = cx * cws, minY = cy * cws;
                let nx = wx < minX ? minX : (wx > minX + cws ? minX + cws : wx);
                let ny = wy < minY ? minY : (wy > minY + cws ? minY + cws : wy);
                let ddx = wx - nx, ddy = wy - ny;
                if (ddx * ddx + ddy * ddy > radiusSq) continue;
            }
            for (let u of chunk) {
                if (hasPlayerFilter && u.owner !== playerFilter) continue;
                if (hasEnemyFilter && u.owner === enemyFilter) continue;
                if (hasUnitTypeFilter && u.unitType !== unitTypeFilter) continue;
                if (!includeDead && u.dead) continue;
                let dx = u.x - wx, dy = u.y - wy;
                let d2 = dx * dx + dy * dy;
                if (exact && d2 > radiusSq) continue;
                if (predicate && !predicate(u, d2, dx, dy)) continue;
                if (visitor(u, d2, dx, dy) === true) return true;
            }
        }
    }
    return false;
}

function _chunkHasEnemyForOwnerFast(chunkKey, ownerId) {
    if (!(spatialUnitsComplex && spatialUnitsComplex.length > 0)) return true;
    if (!(spatialUnitsComplexStridePerChunk > 0 && spatialUnitsComplexStridePerPlayer > 0)) return true;
    if (!Number.isFinite(chunkKey) || !Number.isFinite(ownerId)) return true;
    if (ownerId < 0 || ownerId >= spatialUnitsComplexPlayerCount) return true;

    let cb = chunkKey * spatialUnitsComplexStridePerChunk;
    for (let pid = 0; pid < spatialUnitsComplexPlayerCount; pid++) {
        if (pid === ownerId) continue;
        let pb = cb + pid * spatialUnitsComplexStridePerPlayer;
        if ((spatialUnitsComplex[pb] | 0) > 0) return true;
    }
    return false;
}

function _isCachedEnemyTargetStillValid(target, ownerId, wx, wy, rangeSq, minCx, minCy, maxCx, maxCy, cws) {
    if (!target || target.dead || target.owner === ownerId) return false;
    let ugx = Math.floor(target.x / TILE);
    let ugy = Math.floor(target.y / TILE);
    if (!isGameplayTargetVisibleToPlayer(ownerId, ugx, ugy)) return false;
    let tcx = Math.floor(target.x / cws);
    let tcy = Math.floor(target.y / cws);
    if (tcx < minCx || tcx > maxCx || tcy < minCy || tcy > maxCy) return false;
    let dx = target.x - wx;
    let dy = target.y - wy;
    return (dx * dx + dy * dy) <= rangeSq;
}

function _computeClosestEnemyUnitByChunks(ownerId, wx, wy, rangeSq, minCx, minCy, maxCx, maxCy, cws) {
    let bestChunkKey = -1;
    let bestChunkD2 = Infinity;

    for (let cy = minCy; cy <= maxCy; cy++) {
        let rowBase = cy * CHUNKS_W;
        for (let cx = minCx; cx <= maxCx; cx++) {
            let ck = rowBase + cx;
            if (!_chunkHasEnemyForOwnerFast(ck, ownerId)) continue;

            let chunkMinX = cx * cws;
            let chunkMinY = cy * cws;
            let nx = wx < chunkMinX ? chunkMinX : (wx > chunkMinX + cws ? chunkMinX + cws : wx);
            let ny = wy < chunkMinY ? chunkMinY : (wy > chunkMinY + cws ? chunkMinY + cws : wy);
            let ddx = wx - nx;
            let ddy = wy - ny;
            let chunkD2 = ddx * ddx + ddy * ddy;
            if (chunkD2 > rangeSq) continue;
            if (chunkD2 < bestChunkD2) {
                bestChunkD2 = chunkD2;
                bestChunkKey = ck;
            }
        }
    }

    if (bestChunkKey < 0) return null;
    let chunk = spatialUnits[bestChunkKey];
    if (!chunk || chunk.length <= 0) return null;

    let best = null;
    let bestD2 = Infinity;
    for (let u of chunk) {
        if (!u || u.dead || u.owner === ownerId) continue;
        let ugx = Math.floor(u.x / TILE);
        let ugy = Math.floor(u.y / TILE);
        if (!isGameplayTargetVisibleToPlayer(ownerId, ugx, ugy)) continue;
        let dx = u.x - wx;
        let dy = u.y - wy;
        let d2 = dx * dx + dy * dy;
        if (d2 > rangeSq) continue;
        if (d2 < bestD2) {
            best = u;
            bestD2 = d2;
        }
    }
    return best;
}

function _findClosestEnemyUnitByChunks(owner, wx, wy, rangePx) {
    let ownerId = Math.floor(Number(owner));
    if (ownerId < 0 || ownerId >= spatialUnitsComplexPlayerCount) return null;
    if (!(spatialUnits && spatialUnits.length > 0)) return null;

    let cws = CHUNK_SIZE * TILE;
    let r = Math.max(0, Number(rangePx) || 0);
    let rangeSq = r * r;
    let scan = r + TILE;
    let minCx = Math.max(0, Math.floor((wx - scan) / cws));
    let maxCx = Math.min(CHUNKS_W - 1, Math.floor((wx + scan) / cws));
    let minCy = Math.max(0, Math.floor((wy - scan) / cws));
    let maxCy = Math.min(CHUNKS_H - 1, Math.floor((wy + scan) / cws));

    let centerCx = Math.max(0, Math.min(CHUNKS_W - 1, Math.floor(wx / cws)));
    let centerCy = Math.max(0, Math.min(CHUNKS_H - 1, Math.floor(wy / cws)));
    let centerChunkId = centerCy * CHUNKS_W + centerCx;

    let tps = Math.max(1, Math.floor(Number(TICK_RATE) || 1));
    let rangeKey = Math.max(0, Math.floor(r));
    let cacheKey = ownerId + '|' + minCx + '|' + minCy + '|' + maxCx + '|' + maxCy + '|' + rangeKey;
    let cacheEntry = closestEnemyChunkQueryCache.get(cacheKey);

    if (cacheEntry) {
        if (_isCachedEnemyTargetStillValid(cacheEntry.target, ownerId, wx, wy, rangeSq, minCx, minCy, maxCx, maxCy, cws)) {
            return cacheEntry.target;
        }
        if (cacheEntry.target === null && (gameTime - cacheEntry.updatedAt) < tps) {
            if (((gameTime + centerChunkId) % tps) !== 0) return null;
        }
        if ((gameTime - cacheEntry.updatedAt) < tps && ((gameTime + centerChunkId) % tps) !== 0) {
            return null;
        }
    } else if (((gameTime + centerChunkId) % tps) !== 0) {
        return null;
    }

    let best = _computeClosestEnemyUnitByChunks(ownerId, wx, wy, rangeSq, minCx, minCy, maxCx, maxCy, cws);
    closestEnemyChunkQueryCache.set(cacheKey, {
        updatedAt: gameTime,
        target: best
    });
    if (closestEnemyChunkQueryCache.size > CLOSEST_ENEMY_CHUNK_CACHE_MAX) {
        closestEnemyChunkQueryCache.clear();
    }
    return best;
}