// Spatial hash (10x10 tile chunks)
const CHUNK_SIZE = 1;
let CHUNKS_W = Math.ceil(GRID_W / CHUNK_SIZE);
let CHUNKS_H = Math.ceil(GRID_H / CHUNK_SIZE);
let spatialUnits = []; // flat array of Sets
let spatialUnitsComplex = new Int32Array(0); // [chunk][player][total + perUnitType...]
let spatialUnitTypeToIndex = Object.create(null);
let spatialNormUnitTypeIndex = 0;
let spatialUnitsComplexUnitTypeCount = 0;
let spatialUnitsComplexPlayerCount = 0;
let spatialUnitsComplexStridePerPlayer = 0;
let spatialUnitsComplexStridePerChunk = 0;
const ENABLE_SPATIAL_LOWEST_HEALTH_CACHE = false;
let spatialUnitsComplexLowestHealthUnit = []; // [chunk][player] => lowest damaged living unit
const CLOSEST_ENEMY_CHUNK_CACHE_MAX = 12000;
let closestEnemyChunkQueryCache = new Map();

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
    if (!Number.isFinite(u.energy) || !Number.isFinite(u.maxEnergy)) return false;
    return u.energy > 0 && u.energy < u.maxEnergy;
}

function _isUnitHealthLowerThan(a, b) {
    if (!a || !b) return false;
    let aE = Number(a.energy), aM = Number(a.maxEnergy);
    let bE = Number(b.energy), bM = Number(b.maxEnergy);
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
    if (chunk && chunk.size > 0) {
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

function initSpatialHash() {
    CHUNKS_W = Math.ceil(GRID_W / CHUNK_SIZE);
    CHUNKS_H = Math.ceil(GRID_H / CHUNK_SIZE);
    spatialUnits = [];
    for (let i = 0; i < CHUNKS_W * CHUNKS_H; i++) spatialUnits.push(new Set());
    closestEnemyChunkQueryCache.clear();

    spatialUnitTypeToIndex = Object.create(null);
    let unitKeys = Object.keys(BASE_UNIT_STATS || {});
    if (!unitKeys.includes('norm')) unitKeys.push('norm');
    for (let i = 0; i < unitKeys.length; i++) spatialUnitTypeToIndex[unitKeys[i]] = i;
    spatialNormUnitTypeIndex = Number.isFinite(spatialUnitTypeToIndex.norm) ? spatialUnitTypeToIndex.norm : 0;
    spatialUnitsComplexUnitTypeCount = unitKeys.length;
    spatialUnitsComplexPlayerCount = Math.max(1, Math.floor(Number(players && players.length) || 0));
    spatialUnitsComplexStridePerPlayer = 1 + spatialUnitsComplexUnitTypeCount; // total + each unit type
    spatialUnitsComplexStridePerChunk = spatialUnitsComplexPlayerCount * spatialUnitsComplexStridePerPlayer;
    spatialUnitsComplex = new Int32Array((CHUNKS_W * CHUNKS_H) * spatialUnitsComplexStridePerChunk);
    if (ENABLE_SPATIAL_LOWEST_HEALTH_CACHE) {
        spatialUnitsComplexLowestHealthUnit = new Array((CHUNKS_W * CHUNKS_H) * spatialUnitsComplexPlayerCount).fill(null);
    } else {
        spatialUnitsComplexLowestHealthUnit = [];
    }
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
    if (u._spatialKey !== undefined && u._spatialKey !== newKey) {
        let oldKey = u._spatialKey;
        if (spatialUnits[u._spatialKey].delete(u)) {
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
        spatialUnits[newKey].add(u);
        if (ENABLE_SPATIAL_LOWEST_HEALTH_CACHE) _updateSpatialLowestHealthForUnit(u, newKey);
        return;
    }
    spatialUnits[newKey].add(u);
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
    }
    u._spatialKey = newKey;
    if (ENABLE_SPATIAL_LOWEST_HEALTH_CACHE) _updateSpatialLowestHealthForUnit(u, newKey);
}
function removeUnitSpatial(u) {
    if (u._spatialKey !== undefined) {
        let oldKey = u._spatialKey;
        if (spatialUnits[u._spatialKey].delete(u)) {
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
            }
            if (ENABLE_SPATIAL_LOWEST_HEALTH_CACHE) {
                let oldIdx = _spatialChunkPlayerFlatIndex(oldKey, owner);
                if (oldIdx >= 0 && spatialUnitsComplexLowestHealthUnit[oldIdx] === u) {
                    _recomputeSpatialLowestHealthUnitForChunkPlayer(oldKey, owner);
                }
            }
        }
        u._spatialKey = undefined;
    }
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
                if (!chunk || chunk.size <= 0) continue;
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
                if (!chunk || chunk.size <= 0) continue;
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
            if (!chunk || chunk.size <= 0) continue;
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
    if (!chunk || chunk.size <= 0) return null;

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

// ============================================================
// A* PATHFINDING
// ============================================================
let pathfindBudget = 0; // fallback budget for non-player-owned path requests
let MAX_PATHS_PER_TICK = 30;
const MIN_PATHS_PER_TICK = 12;
const MAX_PATHS_PER_TICK_HARD = 64;
let pendingPathResolveCursor = 0;
let pathTopologyVersion = 1;
const PATH_CACHE_TTL_TICKS = 24;
const PATH_CACHE_MAX_ENTRIES = 3000;
const PATH_CACHE_TRIM_CHUNK = 96;
const PARTIAL_PATH_CACHE_TTL_TICKS = 36;
const PARTIAL_PATH_CACHE_MAX_ENTRIES = 2000;
const SPAWNER_ROUTE_CACHE_TTL_TICKS = 10;
const SPAWNER_ROUTE_CACHE_MAX_ENTRIES = 800;
const SPAWNER_RALLY_TEMPLATE_TTL_TICKS = 20;
const SPAWNER_RALLY_TEMPLATE_MAX_ENTRIES = 1000;
const ASTAR_MAX_ITERS_BASE = 2048;
const ASTAR_MAX_ITERS_HARD = 18000;
const ASTAR_NODE_BUDGET_PER_PATH = 360;
const ASTAR_NODE_BUDGET_MIN_PER_TICK = 2400;
const ASTAR_NODE_BUDGET_MAX_PER_TICK = 22000;
let astarNodeBudgetPerTick = 9000; // fallback for non-player-owned path requests
let astarNodeBudgetRemaining = 9000; // fallback for non-player-owned path requests
let pathfindBudgetByPlayer = new Int32Array(0);
let astarNodeBudgetPerTickByPlayer = new Int32Array(0);
let astarNodeBudgetRemainingByPlayer = new Int32Array(0);
let sharedPathCache = new Map();
let sharedPartialPathCache = new Map();
let sharedSpawnerRouteCache = new Map();
let sharedSpawnerRallyTemplateCache = new Map();

const PATH_SOURCE_UNSPECIFIED = 'unspecified';
let _activePathfindSource = PATH_SOURCE_UNSPECIFIED;
let _activePathfindUnitId = null;
let _activePathfindUnitType = '';
let _activePathfindOwner = -1;
let _lastPathfindAbortedByBudget = false;
let _pathfindPerfTick = null;
let _pathfindPerfHistory = [];
const PATHFIND_PERF_HISTORY_MAX = 480;

function _ensurePathBudgetArrays() {
    let count = Math.max(0, players.length || 0);
    if (pathfindBudgetByPlayer.length !== count) pathfindBudgetByPlayer = new Int32Array(count);
    if (astarNodeBudgetPerTickByPlayer.length !== count) astarNodeBudgetPerTickByPlayer = new Int32Array(count);
    if (astarNodeBudgetRemainingByPlayer.length !== count) astarNodeBudgetRemainingByPlayer = new Int32Array(count);
}

function _resetPathBudgetTrackingPerTick() {
    _ensurePathBudgetArrays();
    pathfindBudget = 0;
    _updateAdaptivePathBudget();
    astarNodeBudgetPerTick = Math.max(0, Math.floor(Number(ASTAR_ITER_BUDGET_PER_PLAYER_TICK) || 0));
    astarNodeBudgetRemaining = astarNodeBudgetPerTick;
    for (let i = 0; i < players.length; i++) {
        pathfindBudgetByPlayer[i] = 0;
        astarNodeBudgetPerTickByPlayer[i] = astarNodeBudgetPerTick;
        astarNodeBudgetRemainingByPlayer[i] = astarNodeBudgetPerTick;
    }
}

function _setPlayerAstarBudget(owner, value) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0 || !players[pid]) return;
    players[pid].astar = Math.max(0, Number(value) || 0);
}

function _getPlayerAstarBudgetAvailable(owner) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0 || !players[pid]) return 0;
    return Math.max(0, Number(players[pid].astar) || 0);
}

function _getPlayerAstarBudgetRemaining(owner) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0 || !players[pid]) return 0;
    return Math.max(0, Number(players[pid].astar) || 0);
}

function _getPlayerAstarBudgetUsed(owner) {
    return 0;
}

function _getPlayerAstarIterationBudgetRemaining(owner) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0) return astarNodeBudgetRemaining;
    return Math.max(0, Number(astarNodeBudgetRemainingByPlayer[pid]) || 0);
}

function _canUsePathfindRequestBudget(owner) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0) return pathfindBudget < MAX_PATHS_PER_TICK;
    return pathfindBudgetByPlayer[pid] < MAX_PATHS_PER_TICK;
}

function _consumePathfindRequestBudget(owner) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0) {
        pathfindBudget++;
        return;
    }
    pathfindBudgetByPlayer[pid] = Math.max(0, Number(pathfindBudgetByPlayer[pid]) || 0) + 1;
}

function _consumeAstarNodeBudget(owner, count = 1, unit = null, sourceTag = null) {
    let amount = Math.max(0, Math.floor(Number(count) || 0));
    if (amount <= 0) return;
    let pid = _normalizeOwnerId(owner);
    if (pid < 0) {
        astarNodeBudgetRemaining = Math.max(0, astarNodeBudgetRemaining - amount);
        return;
    }
    astarNodeBudgetRemainingByPlayer[pid] = Math.max(0, astarNodeBudgetRemainingByPlayer[pid] - amount);
}

function _tryConsumeAstarNodeBudget(owner, count = 1) {
    let amount = Math.max(0, Math.floor(Number(count) || 0));
    if (amount <= 0) return true;
    if (_getPlayerAstarIterationBudgetRemaining(owner) < amount) return false;
    _consumeAstarNodeBudget(owner, amount);
    return true;
}

function _consumePlayerAstarStockpile(owner, amount, unit = null, sourceTag = null) {
    let delta = Math.max(0, Number(amount) || 0);
    if (!(delta > 0)) return;
    let pid = _normalizeOwnerId(owner);
    if (pid < 0 || !players[pid]) return;
    players[pid].astar = Math.max(0, (Number(players[pid].astar) || 0) - delta);
    _recordAstarUsage(pid, delta, unit, sourceTag);
}

function _tryConsumeAstarMoveCost(u, tiles = 1) {
    if (!u) return false;
    let tileCount = Math.max(0, Number(tiles) || 0);
    let amount = tileCount * Math.max(0.1, Number(u.astarCost) || Number((BASE_UNIT_STATS[u.unitType] || {}).astarCost) || 1);
    if (amount <= 0) return true;
    let pid = _normalizeOwnerId(u.owner);
    if (pid < 0) return true;
    if (_getPlayerAstarBudgetRemaining(u.owner) < amount) {
        _setUnitAstarBudgetBlockedIndicator(u, 1);
        u.vx = 0;
        u.vy = 0;
        return false;
    }
    _consumePlayerAstarStockpile(u.owner, amount, u, 'movement');
    return true;
}

function _setUnitAstarBudgetBlockedIndicator(u, cooldownTicks = null) {
    if (!u) return;
    let cd = Math.max(1, Math.floor(Number(cooldownTicks) || _getAstarBudgetIdleCooldownTicks()));
    u._astarBudgetBlockedUntil = gameTime + _getAstarBlockedGlyphTicks();
    u._astarBudgetRetryTick = gameTime + cd;
}

function _markUnitAstarBudgetBlocked(u, cooldownTicks = null) {
    if (!u) return;
    _setUnitAstarBudgetBlockedIndicator(u, cooldownTicks);
    let cd = Math.max(1, Math.floor(Number(cooldownTicks) || _getAstarBudgetIdleCooldownTicks()));
    if (u.workerState) {
        u._workerNextIdleRetargetTick = Math.max(gameTime + cd, Number(u._workerNextIdleRetargetTick) || 0);
    }
}

function _makeFallbackPathForUnit(u, sx, sy, ex, ey, cmd = CMD_MOVING, src = 'fallback') {
    if (!u) return null;
    u.pathIsFallbackAstar = true;
    u.path = null;
    u.pathIndex = 0;
    u._pendingPathTarget = { gx: ex, gy: ey, cmd, src };
    u.commandState = cmd;
    _setUnitAstarBudgetBlockedIndicator(u, 1);
    return null;
}

function _tryUpgradeAstarFallbackPath(u) {
    if (!u || !u.pathIsFallbackAstar || !u._pendingPathTarget || u.dead) return;
    if (Number.isFinite(u._astarBudgetRetryTick) && gameTime < u._astarBudgetRetryTick) return;
    if (!_canUsePathfindRequestBudget(u.owner)) return;

    let pt = u._pendingPathTarget;
    let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
    let dest = findNearestWalkable(pt.gx, pt.gy, ugx, ugy, u);
    _consumePathfindRequestBudget(u.owner);
    let path = _findPathForUnitTagged(pt.src || 'deferred_resolver', u, ugx, ugy, dest.x, dest.y, !!u.isFlying, getPathCanWalkForUnit(u), u.owner);
    if (path && path.length > 0) {
        u.path = path;
        u.pathIndex = (path.length > 1 && path[0].x === ugx && path[0].y === ugy) ? 1 : 0;
        u.pathIsFallbackAstar = false;
        u.commandState = pt.cmd;
        u._pendingPathTarget = null;
        return;
    }
    if (_lastPathfindAbortedByBudget) _setUnitAstarBudgetBlockedIndicator(u);
}

function _recordAstarUsage(owner, usedNodes, unit = null, sourceTag = null) {
    let pid = _normalizeOwnerId(owner);
    if (pid < 0) return;
    let used = Math.max(0, Number(usedNodes) || 0);
    if (!(used > 0)) return;

    let bucket = _ensureAstarLogPlayer(pid);
    if (!bucket) return;

    let unitType = String((unit && unit.unitType) || _activePathfindUnitType || 'other');
    let unitMetric = _astarMetricKeyForUnitType(unitType);
    let unitId = (unit && Number.isFinite(Number(unit.id)))
        ? Math.floor(Number(unit.id))
        : (Number.isFinite(Number(_activePathfindUnitId)) ? Math.floor(Number(_activePathfindUnitId)) : null);
    bucket.push({
        tick: gameTime,
        owner: pid,
        unitType,
        unitMetric,
        unitId,
        source: String(sourceTag || _activePathfindSource || PATH_SOURCE_UNSPECIFIED),
        used
    });

    let pruneBefore = gameTime - Math.max(1, Math.floor(TICK_RATE * ASTAR_USAGE_LOG_MAX_SECONDS));
    while (bucket.length > 0 && Number(bucket[0].tick) < pruneBefore) bucket.shift();
}

function _withPathfindContext(source, owner, unit, fn) {
    let prevSource = _activePathfindSource;
    let prevOwner = _activePathfindOwner;
    let prevUnitId = _activePathfindUnitId;
    let prevUnitType = _activePathfindUnitType;
    _activePathfindSource = source || PATH_SOURCE_UNSPECIFIED;
    _activePathfindOwner = _normalizeOwnerId(owner);
    _activePathfindUnitId = unit && Number.isFinite(unit.id) ? unit.id : null;
    _activePathfindUnitType = unit && unit.unitType ? String(unit.unitType) : '';
    try {
        return fn();
    } finally {
        _activePathfindSource = prevSource;
        _activePathfindOwner = prevOwner;
        _activePathfindUnitId = prevUnitId;
        _activePathfindUnitType = prevUnitType;
    }
}

function _findPathForUnitTagged(sourceTag, unit, sx, sy, ex, ey, ignoreWalls = false, canWalk = null, pathOwner = null, cacheProfileHint = null) {
    let owner = _normalizeOwnerId(pathOwner);
    return _withPathfindContext(sourceTag, owner, unit, () => findPathAStar(sx, sy, ex, ey, ignoreWalls, canWalk, pathOwner, cacheProfileHint));
}

function _newPathfindPerfTick() {
    return {
        tick: gameTime,
        maxPathsPerTick: MAX_PATHS_PER_TICK,
        totalCalls: 0,
        cacheHits: 0,
        totalMs: 0,
        backlog: 0,
        bySource: {
            player_commands: 0,
            spawner_rally: 0,
            worker_ai: 0,
            scout_ai: 0,
            deferred_resolver: 0,
            ai_combat: 0,
            unspecified: 0
        }
    };
}

function _resetPathfindPerfTick() {
    _pathfindPerfTick = _newPathfindPerfTick();
}

function _recordPathfindCall(source, elapsedMs, cacheHit) {
    if (!_pathfindPerfTick) _resetPathfindPerfTick();
    let src = (source && _pathfindPerfTick.bySource[source] !== undefined) ? source : PATH_SOURCE_UNSPECIFIED;
    _pathfindPerfTick.totalCalls++;
    _pathfindPerfTick.bySource[src]++;
    if (cacheHit) _pathfindPerfTick.cacheHits++;
    _pathfindPerfTick.totalMs += Math.max(0, Number(elapsedMs) || 0);
}

function _finalizePathfindPerfTick(backlogCount) {
    if (!_pathfindPerfTick) return;
    _pathfindPerfTick.backlog = Math.max(0, Math.floor(Number(backlogCount) || 0));
    _pathfindPerfTick.maxPathsPerTick = MAX_PATHS_PER_TICK;
    _pathfindPerfHistory.push(_pathfindPerfTick);
    if (_pathfindPerfHistory.length > PATHFIND_PERF_HISTORY_MAX) {
        _pathfindPerfHistory.splice(0, _pathfindPerfHistory.length - PATHFIND_PERF_HISTORY_MAX);
    }
}

function _withPathfindSource(source, fn) {
    let prev = _activePathfindSource;
    _activePathfindSource = source || PATH_SOURCE_UNSPECIFIED;
    try {
        return fn();
    } finally {
        _activePathfindSource = prev;
    }
}

function _countPendingPathBacklog() {
    let c = 0;
    for (let u of units) {
        if (u && !u.dead && u._pendingPathTarget) c++;
    }
    return c;
}

function _pendingPathPriority(src) {
    if (src === 'player_commands') return 0;
    if (src === 'ai_combat') return 1;
    if (src === 'worker_ai') return 2;
    if (src === 'scout_ai') return 3;
    return 4;
}

function _updateAdaptivePathBudget() {
    let fps = Number(_fpsDisplay);
    let tickLoad = Number(_tickAccumulator) / Math.max(1, Number(TICK_MS));
    if (!Number.isFinite(fps)) fps = 60;
    if (!Number.isFinite(tickLoad)) tickLoad = 0;

    let fpsScale = 1;
    if (fps < 44) fpsScale = 0.72;
    else if (fps < 52) fpsScale = 0.9;
    else if (fps > 72) fpsScale = 1.2;

    let loadScale = 1;
    if (tickLoad > 1.4) loadScale = 0.7;
    else if (tickLoad > 1.05) loadScale = 0.82;
    else if (tickLoad < 0.55) loadScale = 1.1;

    let nextCap = Math.round(30 * fpsScale * loadScale);
    MAX_PATHS_PER_TICK = Math.max(MIN_PATHS_PER_TICK, Math.min(MAX_PATHS_PER_TICK_HARD, nextCap));
}

function getPathfindingPerfSnapshot() {
    return {
        latest: _pathfindPerfHistory.length > 0 ? _pathfindPerfHistory[_pathfindPerfHistory.length - 1] : null,
        history: _pathfindPerfHistory.slice()
    };
}

function _isPathValidForScenario(path, sx, sy, ex, ey, ignoreWalls, canWalk, owner, usePortalEdges) {
    if (!Array.isArray(path) || path.length <= 0) return false;
    if (path[0].x !== sx || path[0].y !== sy) return false;
    let last = path[path.length - 1];
    if (last.x !== ex || last.y !== ey) return false;
    for (let i = 1; i < path.length; i++) {
        let p = path[i - 1], n = path[i];
        let dx = Math.abs(n.x - p.x), dy = Math.abs(n.y - p.y);
        let adjacent = (dx + dy) === 1;
        if (!adjacent) {
            if (!usePortalEdges || !isCloudPortalLink(p.x, p.y, n.x, n.y, owner)) return false;
        }
        if (n.x < 0 || n.x >= GRID_W || n.y < 0 || n.y >= GRID_H) return false;
        if (!ignoreWalls && grid[n.y][n.x].type === TYPE_WALL) {
            if (!(usePortalEdges && !!_getCloudTowerFast(n.x, n.y, owner)) && !(canWalk && canWalk(n.x, n.y))) {
                return false;
            }
        }
    }
    return true;
}

function _findPathBfsReference(sx, sy, ex, ey, ignoreWalls, canWalk, owner, usePortalEdges) {
    if (sx === ex && sy === ey) return [{ x: sx, y: sy }];
    let w = GRID_W, h = GRID_H;
    let size = w * h;
    let q = new Int32Array(size);
    let from = new Int32Array(size);
    from.fill(-1);
    let head = 0, tail = 0;
    let start = sy * w + sx;
    let end = ey * w + ex;
    q[tail++] = start;
    from[start] = start;

    while (head < tail) {
        let k = q[head++];
        if (k === end) break;
        let cx = k % w, cy = (k / w) | 0;

        for (let di = 0; di < 8; di += 2) {
            let nx = cx + _ASTAR_DIRS[di], ny = cy + _ASTAR_DIRS[di + 1];
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            if (!ignoreWalls && grid[ny][nx].type === TYPE_WALL) {
                if (!(usePortalEdges && !!_getCloudTowerFast(nx, ny, owner)) && !(canWalk && canWalk(nx, ny))) continue;
            }
            let nk = ny * w + nx;
            if (from[nk] !== -1) continue;
            from[nk] = k;
            q[tail++] = nk;
        }

        if (usePortalEdges) {
            let cloud = _getCloudTowerFast(cx, cy, owner);
            if (cloud) {
                let partner = getPairedCloudTower(cloud, owner);
                if (partner) {
                    let pk = partner.gy * w + partner.gx;
                    if (from[pk] === -1) {
                        from[pk] = k;
                        q[tail++] = pk;
                    }
                }
            }
        }
    }

    if (from[end] === -1) return null;
    let out = [];
    let cur = end;
    while (true) {
        out.push({ x: cur % w, y: (cur / w) | 0 });
        if (cur === start) break;
        cur = from[cur];
    }
    out.reverse();
    return out;
}

function runPathfindingCorrectnessHarness() {
    let scenarios = [];
    let midSx = Math.floor(GRID_W * 0.15), midSy = Math.floor(GRID_H * 0.15);
    let midEx = Math.floor(GRID_W * 0.85), midEy = Math.floor(GRID_H * 0.85);
    scenarios.push({
        name: 'open_map',
        sx: Math.max(0, Math.min(GRID_W - 1, midSx)),
        sy: Math.max(0, Math.min(GRID_H - 1, midSy)),
        ex: Math.max(0, Math.min(GRID_W - 1, midEx)),
        ey: Math.max(0, Math.min(GRID_H - 1, midEy)),
        ignoreWalls: true,
        canWalk: null,
        owner: localPlayerId
    });

    let wallA = null, wallB = null;
    for (let y = 1; y < GRID_H - 1 && (!wallA || !wallB); y++) {
        for (let x = 1; x < GRID_W - 1 && (!wallA || !wallB); x++) {
            if (grid[y][x].type !== TYPE_WALL) continue;
            if (!wallA) wallA = { x: Math.max(0, x - 1), y };
            else wallB = { x: Math.min(GRID_W - 1, x + 1), y };
        }
    }
    if (wallA && wallB) {
        scenarios.push({
            name: 'dense_walls',
            sx: wallA.x,
            sy: wallA.y,
            ex: wallB.x,
            ey: wallB.y,
            ignoreWalls: false,
            canWalk: null,
            owner: localPlayerId
        });
    }

    let cloud = towers.find(t => t && t.baseStats && t.baseStats.isCloud && t.energy > 0 && !t.underConstruction);
    if (cloud) {
        let pair = getPairedCloudTower(cloud, cloud.owner);
        if (pair) {
            scenarios.push({
                name: 'cloud_portal',
                sx: cloud.gx,
                sy: cloud.gy,
                ex: pair.gx,
                ey: pair.gy,
                ignoreWalls: false,
                canWalk: null,
                owner: cloud.owner
            });
        }
    }

    let mine = goldMines.find(m => m && m.gold > 0);
    if (mine) {
        scenarios.push({
            name: 'worker_can_walk',
            sx: Math.max(0, mine.gx - 1),
            sy: mine.gy,
            ex: mine.gx,
            ey: mine.gy,
            ignoreWalls: false,
            canWalk: _collectorCanWalk,
            owner: localPlayerId
        });
    }

    let results = [];
    for (let s of scenarios) {
        let usePortalEdges = (s.owner !== null && s.owner !== undefined);
        let astar = findPathAStarTagged('unspecified', s.sx, s.sy, s.ex, s.ey, s.ignoreWalls, s.canWalk, s.owner);
        let bfs = _findPathBfsReference(s.sx, s.sy, s.ex, s.ey, s.ignoreWalls, s.canWalk, s.owner, usePortalEdges);
        let astarValid = astar ? _isPathValidForScenario(astar, s.sx, s.sy, s.ex, s.ey, s.ignoreWalls, s.canWalk, s.owner, usePortalEdges) : false;
        let bfsValid = bfs ? _isPathValidForScenario(bfs, s.sx, s.sy, s.ex, s.ey, s.ignoreWalls, s.canWalk, s.owner, usePortalEdges) : false;
        results.push({
            name: s.name,
            astarFound: !!astar,
            bfsFound: !!bfs,
            astarValid,
            bfsValid,
            parity: (!!astar === !!bfs),
            astarLen: astar ? astar.length : 0,
            bfsLen: bfs ? bfs.length : 0
        });
    }

    return {
        tick: gameTime,
        topologyVersion: pathTopologyVersion,
        scenarios: results,
        allPassed: results.every(r => r.astarValid && r.bfsValid && r.parity)
    };
}

window.getPathfindingPerfSnapshot = getPathfindingPerfSnapshot;
window.runPathfindingCorrectnessHarness = runPathfindingCorrectnessHarness;

function _bumpPathTopologyVersion() {
    pathTopologyVersion++;
    if (pathTopologyVersion > 1000000000) pathTopologyVersion = 1;
    if (sharedPathCache.size > 0) sharedPathCache.clear();
    if (sharedPartialPathCache.size > 0) sharedPartialPathCache.clear();
    if (sharedSpawnerRouteCache.size > 0) sharedSpawnerRouteCache.clear();
    if (sharedSpawnerRallyTemplateCache.size > 0) sharedSpawnerRallyTemplateCache.clear();
}

function _isPathCacheExpired(entry, ttlTicks) {
    if (!entry) return true;
    if (entry.version !== pathTopologyVersion) return true;
    return (gameTime - entry.tick) > ttlTicks;
}

function _makePathCacheKey(sx, sy, ex, ey, movementProfile, pathOwner, usePortalEdges) {
    return movementProfile + '|' + (pathOwner === null ? 'n' : String(pathOwner)) + '|' + (usePortalEdges ? 'p1' : 'p0') + '|' + sx + ',' + sy + '>' + ex + ',' + ey;
}

function _trimPathCacheIfNeeded(cacheMap, maxEntries) {
    if (cacheMap.size <= maxEntries) return;
    if (cacheMap.size <= (maxEntries + PATH_CACHE_TRIM_CHUNK)) return;
    let removeCount = Math.max(PATH_CACHE_TRIM_CHUNK, cacheMap.size - maxEntries);
    for (let k of cacheMap.keys()) {
        cacheMap.delete(k);
        removeCount--;
        if (removeCount <= 0) break;
    }
}

function _resolveMovementProfile(ignoreWalls, canWalk, cacheProfileHint = null) {
    if (cacheProfileHint) return cacheProfileHint;
    if (ignoreWalls) return 'ignore_walls';
    if (!canWalk) return 'ground';
    if (canWalk === _collectorCanWalk) return 'collector';
    if (canWalk && canWalk._pathProfileKey) return canWalk._pathProfileKey;
    return null;
}

// ---- A* scratch buffers: reused across calls via epoch trick, avoids per-call alloc ----
let _astarCap = 0;
let _astarEpoch = 0;
let _astarVisitedGen = null;  // Int32Array: [key] === epoch G�� visited this call
let _astarGScoreGen = null;  // Int32Array: [key] === epoch G�� gScore valid this call
let _astarGScoreVal = null;  // Int32Array: best g-score per tile
let _astarFrom = null;  // Int32Array: parent key (for path reconstruction)
let _astarHeapF = null;  // Int32Array: heap f-values (packed int heap)
let _astarHeapK = null;  // Int32Array: heap node keys

function _ensureAstarBuffers(size) {
    if (size > _astarCap) {
        _astarCap = size + 2048;
        _astarVisitedGen = new Int32Array(_astarCap);
        _astarGScoreGen = new Int32Array(_astarCap);
        _astarGScoreVal = new Int32Array(_astarCap);
        _astarFrom = new Int32Array(_astarCap);
        _astarHeapF = new Int32Array(_astarCap * 4);
        _astarHeapK = new Int32Array(_astarCap * 4);
    }
}

// Static 4-directional offsets: avoids per-iteration array allocation in hot path
const _ASTAR_DIRS = new Int8Array([0, 1, 0, -1, 1, 0, -1, 0]);

// Cloud tower tile cache G�� keyed by (gy*GRID_W+gx), invalidated by pathTopologyVersion
let _cloudTileCache = null;
let _cloudTileCacheVer = -1;
let _cloudPairIndexCache = null;

function _makeCloudPairKey(pairId, owner) {
    return String(pairId) + '|' + String(owner);
}

function _rebuildCloudTileCache() {
    let m = new Map();
    let pairIndex = new Map();
    for (let t of towers) {
        if (t.baseStats && t.baseStats.isCloud) {
            m.set(t.gy * GRID_W + t.gx, t);
            let pairId = t.baseStats.pairId;
            if (pairId !== undefined && pairId !== null) {
                let key = _makeCloudPairKey(pairId, t.owner);
                let list = pairIndex.get(key);
                if (!list) {
                    list = [];
                    pairIndex.set(key, list);
                }
                list.push(t);
            }
        }
    }
    _cloudTileCache = m;
    _cloudPairIndexCache = pairIndex;
    _cloudTileCacheVer = pathTopologyVersion;
}

// Fast O(1) cloud-tower lookup with live energy/construction check
function _getCloudTowerFast(gx, gy, owner) {
    if (_cloudTileCacheVer !== pathTopologyVersion) _rebuildCloudTileCache();
    let t = _cloudTileCache.get(gy * GRID_W + gx);
    if (!t) return null;
    if (!(t.energy > 0 && !t.underConstruction)) return null;
    if (owner !== null && t.owner !== owner) return null;
    return t;
}

// Typed-array min-heap (no object allocation per push)
// _astarHeapF / _astarHeapK must be ensured before use; _astarHeapSz tracks current size.
let _astarHeapSz = 0;

function _heapPush(f, k) {
    let i = _astarHeapSz++;
    _astarHeapF[i] = f; _astarHeapK[i] = k;
    let hF = _astarHeapF, hK = _astarHeapK;
    while (i > 0) {
        let p = (i - 1) >> 1;
        if (hF[p] > hF[i]) {
            let tf = hF[i]; hF[i] = hF[p]; hF[p] = tf;
            let tk = hK[i]; hK[i] = hK[p]; hK[p] = tk;
            i = p;
        } else break;
    }
}

// Returns popped f in _astarPopF, key in _astarPopK
let _astarPopF = 0, _astarPopK = 0;
function _heapPop() {
    _astarPopF = _astarHeapF[0]; _astarPopK = _astarHeapK[0];
    let n = --_astarHeapSz;
    if (n > 0) {
        let hF = _astarHeapF, hK = _astarHeapK;
        hF[0] = hF[n]; hK[0] = hK[n];
        let i = 0;
        while (true) {
            let l = (i << 1) + 1, r = l + 1, s = i;
            if (l < n && hF[l] < hF[s]) s = l;
            if (r < n && hF[r] < hF[s]) s = r;
            if (s !== i) {
                let tf = hF[i]; hF[i] = hF[s]; hF[s] = tf;
                let tk = hK[i]; hK[i] = hK[s]; hK[s] = tk;
                i = s;
            } else break;
        }
    }
}

class MinHeap {
    constructor() { this.data = []; }
    push(item) { this.data.push(item); this._bubbleUp(this.data.length - 1); }
    pop() {
        let top = this.data[0];
        let len = this.data.length - 1;
        if (len > 0) {
            let last = this.data[len];
            this.data[0] = last;
            this._sinkDown(0, len, last.f);
        }
        this.data.pop();
        return top;
    }
    get length() { return this.data.length; }
    _bubbleUp(i) {
        let item = this.data[i];
        let f = item.f;
        while (i > 0) {
            let p = (i - 1) >> 1;
            let pf = this.data[p].f;
            if (f < pf) { this.data[i] = this.data[p]; i = p; }
            else break;
        }
        this.data[i] = item;
    }
    _sinkDown(i, n, itemF) {
        let data = this.data;
        while (true) {
            let l = (i << 1) + 1, r = l + 1, smallest = i;
            let smallestF = itemF;
            if (l < n && data[l].f < smallestF) { smallest = l; smallestF = data[l].f; }
            if (r < n && data[r].f < smallestF) smallest = r;
            if (smallest !== i) { data[i] = data[smallest]; i = smallest; }
            else break;
        }
        data[i] = data[n];
    }
}

function getCloudTowerAt(gx, gy, owner = null) {
    return _getCloudTowerFast(gx, gy, owner);
}

function getPairedCloudTower(cloud, owner = null) {
    if (!cloud || !cloud.baseStats || !cloud.baseStats.isCloud) return null;
    let pairId = cloud.baseStats.pairId;
    if (pairId === undefined || pairId === null) return null;
    let matchOwner = owner !== null ? owner : cloud.owner;
    if (_cloudTileCacheVer !== pathTopologyVersion) _rebuildCloudTileCache();
    let list = _cloudPairIndexCache.get(_makeCloudPairKey(pairId, matchOwner));
    if (!list || list.length <= 0) return null;
    for (let i = 0; i < list.length; i++) {
        let t = list[i];
        if (t === cloud) continue;
        if (t.energy > 0 && !t.underConstruction) return t;
    }
    return null;
}

function isCloudPortalLink(gx1, gy1, gx2, gy2, owner) {
    let c1 = getCloudTowerAt(gx1, gy1, owner);
    let c2 = getCloudTowerAt(gx2, gy2, owner);
    if (!c1 || !c2) return false;
    if (c1.baseStats.pairId === undefined || c2.baseStats.pairId === undefined) return false;
    return c1.baseStats.pairId === c2.baseStats.pairId;
}

function canUnitOccupyTile(unit, gx, gy) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
    if (unit && unit.isFlying) return true;
    if (grid[gy][gx].type !== TYPE_WALL) return true;

    if (!!getCloudTowerAt(gx, gy, unit ? unit.owner : null)) return true;
    if (!unit) return false;

    // Collectors can stand on active gold mines.
    if (unit.workerType === 'collector') {
        if (hasActiveGoldMineAt(gx, gy)) return true;
    }

    if (unit.workerType === 'astar_collector') {
        if (hasActiveAstarMineAt(gx, gy)) return true;
    }

    // Builders can stand on active build/upgrade targets.
    if (unit.workerType === 'builder') {
        if (_canBuilderPassTile(unit.owner, gx, gy)) return true;
    }

    // Salvagers can stand on owned marked-for-salvage targets.
    if (unit.workerType === 'salvager') {
        let isOwnedMarkedTarget = (obj) => !!obj && obj.owner === unit.owner && !!obj.markedForSalvage && (!(obj.energy !== undefined) || obj.energy > 0);
        if (isOwnedMarkedTarget(getTileEntityRef(gx, gy))) return true;
    }

    return false;
}

function isWalkableTileFor(unit, gx, gy) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
    if (unit) return canUnitOccupyTile(unit, gx, gy);
    return grid[gy][gx].type !== TYPE_WALL;
}

function findPathAStar(sx, sy, ex, ey, ignoreWalls = false, canWalk = null, pathOwner = null, cacheProfileHint = null) {
    let perfStart = performance.now();
    let sourceTag = _activePathfindSource || PATH_SOURCE_UNSPECIFIED;
    let ownerForBudget = _normalizeOwnerId(pathOwner !== null ? pathOwner : _activePathfindOwner);
    _lastPathfindAbortedByBudget = false;
    if (sx === ex && sy === ey) {
        _recordPathfindCall(sourceTag, performance.now() - perfStart, false);
        return [{ x: ex, y: ey }];
    }
    // Cloud portals should be usable for all unit pathing modes whenever owner context is known.
    let usePortalEdges = (pathOwner !== null);
    let movementProfile = _resolveMovementProfile(ignoreWalls, canWalk, cacheProfileHint);
    let cacheKey = null;
    let resumePrefixPath = null;
    let resumeStartX = sx;
    let resumeStartY = sy;

    let gridData = grid;
    let gridW = GRID_W;
    let gridH = GRID_H;

    if (movementProfile) {
        cacheKey = _makePathCacheKey(sx, sy, ex, ey, movementProfile, pathOwner, usePortalEdges);
        let cached = sharedPathCache.get(cacheKey);
        if (cached && !_isPathCacheExpired(cached, PATH_CACHE_TTL_TICKS)) {
            _recordPathfindCall(sourceTag, performance.now() - perfStart, true);
            return cached.path;
        }
        if (cached) sharedPathCache.delete(cacheKey);

        let partial = sharedPartialPathCache.get(cacheKey);
        if (partial && !_isPathCacheExpired(partial, PARTIAL_PATH_CACHE_TTL_TICKS) && Array.isArray(partial.path) && partial.path.length > 1) {
            let last = partial.path[partial.path.length - 1];
            if (last && Number.isFinite(last.x) && Number.isFinite(last.y) && last.x >= 0 && last.x < GRID_W && last.y >= 0 && last.y < GRID_H) {
                resumePrefixPath = partial.path;
                resumeStartX = Math.floor(last.x);
                resumeStartY = Math.floor(last.y);
            }
        } else if (partial) {
            sharedPartialPathCache.delete(cacheKey);
        }
    }

    if (resumePrefixPath) {
        sx = resumeStartX;
        sy = resumeStartY;
        if (sx === ex && sy === ey) {
            let full = resumePrefixPath;
            if (movementProfile) {
                sharedPathCache.set(cacheKey, { path: full, tick: gameTime, version: pathTopologyVersion });
                sharedPartialPathCache.delete(cacheKey);
                _trimPathCacheIfNeeded(sharedPathCache, PATH_CACHE_MAX_ENTRIES);
            }
            _recordPathfindCall(sourceTag, performance.now() - perfStart, false);
            return full;
        }
    }

    // Resolve cloud tile cache once per call (O(1) per lookup in hot path)
    if (usePortalEdges && _cloudTileCacheVer !== pathTopologyVersion) _rebuildCloudTileCache();

    if (!ignoreWalls && sx >= 0 && sx < gridW && sy >= 0 && sy < gridH) {
        if (gridData[ey] && gridData[ey][ex] && !(ignoreWalls || gridData[ey][ex].type !== TYPE_WALL || (usePortalEdges && _getCloudTowerFast(ex, ey, pathOwner)) || (canWalk && canWalk(ex, ey)))) {
            // Find nearest walkable neighbor of target
            let best = null, bestD = 9999;
            for (let di = 0; di < 8; di += 2) {
                let nx = ex + _ASTAR_DIRS[di], ny = ey + _ASTAR_DIRS[di + 1];
                if (nx >= 0 && nx < gridW && ny >= 0 && ny < gridH && (ignoreWalls || gridData[ny][nx].type !== TYPE_WALL || (usePortalEdges && _getCloudTowerFast(nx, ny, pathOwner)) || (canWalk && canWalk(nx, ny)))) {
                    let d = Math.abs(nx - sx) + Math.abs(ny - sy);
                    if (d < bestD) { bestD = d; best = { x: nx, y: ny }; }
                }
            }
            if (best) { ex = best.x; ey = best.y; }
            else {
                _recordPathfindCall(sourceTag, performance.now() - perfStart, false);
                return null;
            }
        }
    }

    let bufSize = gridW * gridH;
    _ensureAstarBuffers(bufSize);
    let configuredAstarLimit = Math.max(ASTAR_MAX_ITERS_BASE, Math.min(ASTAR_MAX_ITERS_HARD, Math.floor(Number(ASTAR_MAX_ITERS_LIMIT) || ASTAR_MAX_ITERS_HARD)));
    let maxAstarIterations = Math.max(ASTAR_MAX_ITERS_BASE, Math.min(configuredAstarLimit, (bufSize >> 1) + ASTAR_MAX_ITERS_BASE));
    let astarIterations = 0;
    let abortedByBudget = false;
    let budgetOwner = Number.isFinite(pathOwner) ? pathOwner : _activePathfindOwner;
    let partialResumeKey = -1;

    // Bump epoch; on overflow reset arrays
    if (++_astarEpoch > 2000000000) {
        _astarEpoch = 1;
        _astarVisitedGen.fill(0);
        _astarGScoreGen.fill(0);
    }
    let epoch = _astarEpoch;
    let visitedGen = _astarVisitedGen;
    let gScoreGen = _astarGScoreGen;
    let gScoreVal = _astarGScoreVal;
    let astarFrom = _astarFrom;

    let startKey = sy * gridW + sx;
    let endKey = ey * gridW + ex;

    // Init start node
    gScoreGen[startKey] = epoch;
    gScoreVal[startKey] = 0;
    astarFrom[startKey] = startKey; // sentinel for path reconstruction

    _astarHeapSz = 0;
    let startH = usePortalEdges ? 0 : (Math.abs(ex - sx) + Math.abs(ey - sy));
    _heapPush(startH, startKey);

    while (_astarHeapSz > 0) {
        let heapSz = --_astarHeapSz;
        let curKey = _astarHeapK[0];
        if (heapSz > 0) {
            let hF = _astarHeapF, hK = _astarHeapK;
            hF[0] = hF[heapSz];
            hK[0] = hK[heapSz];
            let i = 0;
            while (true) {
                let l = (i << 1) + 1;
                if (l >= heapSz) break;
                let r = l + 1;
                let s = l;
                if (r < heapSz && hF[r] < hF[l]) s = r;
                if (hF[i] <= hF[s]) break;
                let tf = hF[i]; hF[i] = hF[s]; hF[s] = tf;
                let tk = hK[i]; hK[i] = hK[s]; hK[s] = tk;
                i = s;
            }
        }
        if (visitedGen[curKey] === epoch) continue;
        visitedGen[curKey] = epoch;

        if (curKey === endKey) {
            // Reconstruct path (follow astarFrom back to startKey)
            let path = [];
            let k = endKey;
            while (true) {
                path.push({ x: k % gridW, y: (k / gridW) | 0 });
                if (k === startKey) break;
                k = astarFrom[k];
            }
            path.reverse();
            if (resumePrefixPath && resumePrefixPath.length > 0) {
                let merged = resumePrefixPath.slice();
                for (let i = 1; i < path.length; i++) merged.push(path[i]);
                path = merged;
            }
            if (movementProfile) {
                sharedPathCache.set(cacheKey, { path: path, tick: gameTime, version: pathTopologyVersion });
                sharedPartialPathCache.delete(cacheKey);
                _trimPathCacheIfNeeded(sharedPathCache, PATH_CACHE_MAX_ENTRIES);
            }
            _recordPathfindCall(sourceTag, performance.now() - perfStart, false);
            return path;
        }

        if (!_tryConsumeAstarNodeBudget(budgetOwner, 1)) {
            abortedByBudget = true;
            _lastPathfindAbortedByBudget = true;
            partialResumeKey = curKey;
            break;
        }
        astarIterations++;
        if (astarIterations > maxAstarIterations) {
            abortedByBudget = true;
            _lastPathfindAbortedByBudget = true;
            partialResumeKey = curKey;
            break;
        }

        let cx = curKey % gridW, cy = (curKey / gridW) | 0;
        let cg = gScoreVal[curKey];

        // Expand 4 cardinal neighbors inline (no array allocation)
        for (let di = 0; di < 8; di += 2) {
            let nx = cx + _ASTAR_DIRS[di], ny = cy + _ASTAR_DIRS[di + 1];
            if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
            if (!ignoreWalls && gridData[ny][nx].type === TYPE_WALL) {
                if (!(usePortalEdges && _getCloudTowerFast(nx, ny, pathOwner)) && !(canWalk && canWalk(nx, ny))) continue;
            }
            let nKey = ny * gridW + nx;
            if (visitedGen[nKey] === epoch) continue;
            let ng = cg + 1;
            if (gScoreGen[nKey] !== epoch || ng < gScoreVal[nKey]) {
                gScoreGen[nKey] = epoch;
                gScoreVal[nKey] = ng;
                astarFrom[nKey] = curKey;
                let h = usePortalEdges ? 0 : (Math.abs(ex - nx) + Math.abs(ey - ny));
                _heapPush(ng + h, nKey);
            }
        }

        // Cloud portal teleport edges
        if (usePortalEdges) {
            let cloud = _getCloudTowerFast(cx, cy, pathOwner);
            if (cloud) {
                let partner = getPairedCloudTower(cloud, pathOwner);
                if (partner) {
                    let nKey = partner.gy * gridW + partner.gx;
                    if (visitedGen[nKey] !== epoch) {
                        let ng = cg + 1;
                        if (gScoreGen[nKey] !== epoch || ng < gScoreVal[nKey]) {
                            gScoreGen[nKey] = epoch;
                            gScoreVal[nKey] = ng;
                            astarFrom[nKey] = curKey;
                            _heapPush(ng, nKey); // h=0 in portal/Dijkstra mode
                        }
                    }
                }
            }
        }
    }

    if (abortedByBudget && movementProfile && cacheKey) {
        let partialPath = [];
        let pk = partialResumeKey >= 0 ? partialResumeKey : (_astarHeapSz > 0 ? _astarHeapK[0] : -1);
        if (!(pk >= 0)) {
            // Fallback: at least keep current local start so next attempt can resume deterministically.
            partialPath = [{ x: sx, y: sy }];
        } else {
            let guard = 0;
            while (pk >= 0 && guard <= (GRID_W * GRID_H)) {
                guard++;
                partialPath.push({ x: pk % gridW, y: (pk / gridW) | 0 });
                if (pk === startKey) break;
                let parent = astarFrom[pk];
                if (!Number.isFinite(parent) || parent < 0 || parent === pk) break;
                pk = parent;
            }
            partialPath.reverse();
        }

        if (resumePrefixPath && resumePrefixPath.length > 0 && partialPath.length > 0) {
            let mergedPartial = resumePrefixPath.slice();
            for (let i = 1; i < partialPath.length; i++) mergedPartial.push(partialPath[i]);
            partialPath = mergedPartial;
        }

        if (partialPath.length > 1) {
            sharedPartialPathCache.set(cacheKey, { path: partialPath, tick: gameTime, version: pathTopologyVersion });
            _trimPathCacheIfNeeded(sharedPartialPathCache, PARTIAL_PATH_CACHE_MAX_ENTRIES);
        }
    }

    if (movementProfile && !abortedByBudget) {
        sharedPathCache.set(cacheKey, { path: null, tick: gameTime, version: pathTopologyVersion });
        sharedPartialPathCache.delete(cacheKey);
        _trimPathCacheIfNeeded(sharedPathCache, PATH_CACHE_MAX_ENTRIES);
    }
    _recordPathfindCall(sourceTag, performance.now() - perfStart, false);
    return null;
}

function findPathAStarTagged(sourceTag, sx, sy, ex, ey, ignoreWalls = false, canWalk = null, pathOwner = null, cacheProfileHint = null) {
    return _withPathfindContext(sourceTag, pathOwner, null, () => findPathAStar(sx, sy, ex, ey, ignoreWalls, canWalk, pathOwner, cacheProfileHint));
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

function findNearestWalkable(gx, gy, fromGx, fromGy, unit = null) {
    if (isWalkableTileFor(unit, gx, gy)) return { x: gx, y: gy };

    let maxRadius = Math.max(GRID_W, GRID_H);
    for (let r = 1; r <= maxRadius; r++) {
        let candidates = [];
        for (let x = gx - r; x <= gx + r; x++) {
            candidates.push({ x, y: gy - r });
            candidates.push({ x, y: gy + r });
        }
        for (let y = gy - r + 1; y <= gy + r - 1; y++) {
            candidates.push({ x: gx - r, y });
            candidates.push({ x: gx + r, y });
        }

        if (Number.isFinite(fromGx) && Number.isFinite(fromGy)) {
            candidates.sort((a, b) => {
                let da = Math.hypot(a.x - fromGx, a.y - fromGy);
                let db = Math.hypot(b.x - fromGx, b.y - fromGy);
                if (da !== db) return da - db;
                if (a.y !== b.y) return a.y - b.y;
                return a.x - b.x;
            });
        }

        for (let c of candidates) {
            if (!isWalkableTileFor(unit, c.x, c.y)) continue;
            return { x: c.x, y: c.y };
        }
    }

    return {
        x: Math.max(0, Math.min(GRID_W - 1, gx)),
        y: Math.max(0, Math.min(GRID_H - 1, gy))
    };
}

function pushUnitOutOfBlockedTile(unit) {
    if (!unit || unit.dead || unit.isFlying) return;
    let gx = Math.floor(unit.x / TILE), gy = Math.floor(unit.y / TILE);
    if (canUnitOccupyTile(unit, gx, gy)) return;

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

// ============================================================
// GRID & MAP INITIALIZATION
// ============================================================
function initGrid() {
    grid = [];
    initDroppedItemGrid();
    workerReservedTiles = new Array(Math.max(0, GRID_W * GRID_H * _WORKER_TARGET_LOAD_TYPE_COUNT)).fill(null);
    for (let y = 0; y < GRID_H; y++) {
        let row = [];
        for (let x = 0; x < GRID_W; x++) {
            row.push({ type: TYPE_FLOOR, item: null, owner: -1, areaId: -1, droppedItem: null });
        }
        grid.push(row);
    }
}

function generateAreas() {
    areas = [];
    _areaById = [];
    let visited = Array.from({ length: GRID_H }, () => new Array(GRID_W).fill(false));
    let areaId = 0;

    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            if (visited[y][x]) continue;
            let targetSize = 5 + Math.floor(rng() * 8);
            let cells = [];
            let queue = [{ x, y }];
            visited[y][x] = true;
            let cellType = grid[y][x].type;
            let minAreaGx = x, minAreaGy = y, maxAreaGx = x, maxAreaGy = y;

            while (queue.length > 0 && cells.length < targetSize) {
                let cur = queue.shift();
                cells.push({ x: cur.x, y: cur.y });
                grid[cur.y][cur.x].areaId = areaId;
                if (cur.x < minAreaGx) minAreaGx = cur.x;
                if (cur.y < minAreaGy) minAreaGy = cur.y;
                if (cur.x > maxAreaGx) maxAreaGx = cur.x;
                if (cur.y > maxAreaGy) maxAreaGy = cur.y;

                let dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
                for (let i = dirs.length - 1; i > 0; i--) {
                    let j = Math.floor(rng() * (i + 1));
                    [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
                }
                for (let [dx, dy] of dirs) {
                    let nx = cur.x + dx, ny = cur.y + dy;
                    if (nx >= 0 && nx < GRID_W && ny >= 0 && ny < GRID_H && !visited[ny][nx] && grid[ny][nx].type === cellType) {
                        visited[ny][nx] = true;
                        queue.push({ x: nx, y: ny });
                    }
                }
            }
            // Un-visit cells left in queue so they can form their own areas
            for (let rem of queue) visited[rem.y][rem.x] = false;
            let area = {
                id: areaId,
                type: cellType,
                cells,
                active: false,
                multiplierLevel: 0,
                minGx: minAreaGx,
                minGy: minAreaGy,
                maxGx: maxAreaGx,
                maxGy: maxAreaGy
            };
            areas.push(area);
            _areaById[areaId] = area;
            areaId++;
        }
    }

    _areaColorCache = null;
    _areaOutlinePathCache = null;
    _markCombinedBgFullDirty();
}

function generateResourceMinesMixed() {
    let spawnTiles = arguments.length > 0 && arguments[0] ? arguments[0] : [];

    for (let m of goldMines) {
        if (!m) continue;
        clearTileEntity(Math.floor(Number(m.gx)), Math.floor(Number(m.gy)), m);
    }
    for (let m of astarMines) {
        if (!m) continue;
        clearTileEntity(Math.floor(Number(m.gx)), Math.floor(Number(m.gy)), m);
    }
    goldMines = [];
    astarMines = [];

    let totalGold = Math.max(0, Math.floor(GOLD_MINE_COUNT || 0));
    let totalAstar = Math.max(0, Math.floor(ASTAR_MINE_COUNT || 0));
    let totalMines = totalGold + totalAstar;
    if (totalMines <= 0) return;

    let margin = 1;
    let spawnSafeRadius = 3;
    let mapMin = Math.min(GRID_W, GRID_H);
    let centerX = (GRID_W - 1) / 2;
    let centerY = (GRID_H - 1) / 2;
    let shapeMask = null;

    let nearAnySpawn = (gx, gy) => {
        if (!spawnTiles || spawnTiles.length === 0) return false;
        return spawnTiles.some(s => Math.hypot(gx - s.gx, gy - s.gy) <= spawnSafeRadius);
    };

    let isAllowedByShape = (gx, gy) => {
        if (!shapeMask) return true;
        return !!shapeMask(gx, gy);
    };

    let candidateSet = new Set();
    let candidates = [];
    let addCandidate = (gx, gy) => {
        if (gx < margin || gx >= GRID_W - margin || gy < margin || gy >= GRID_H - margin) return false;
        let key = `${gx},${gy}`;
        if (candidateSet.has(key)) return false;
        if (!grid[gy] || !grid[gy][gx] || grid[gy][gx].type !== TYPE_FLOOR) return false;
        if (!isAllowedByShape(gx, gy)) return false;
        if (MAP_TYPE !== 'arena' && nearAnySpawn(gx, gy)) return false;
        candidateSet.add(key);
        candidates.push({ gx, gy });
        return true;
    };

    let addCandidatesFromList = (list, shuffle = true) => {
        if (!Array.isArray(list) || list.length === 0) return;
        let src = list.slice();
        if (shuffle) {
            for (let i = src.length - 1; i > 0; i--) {
                let j = Math.floor(rng() * (i + 1));
                [src[i], src[j]] = [src[j], src[i]];
            }
        }
        for (let c of src) {
            if (candidates.length >= totalMines) break;
            addCandidate(c.gx, c.gy);
        }
    };

    let buildArenaEdgeSpiralCandidates = (ringWidth) => {
        let out = [];
        let seen = new Set();
        let add = (gx, gy) => {
            if (gx < margin || gx >= GRID_W - margin || gy < margin || gy >= GRID_H - margin) return;
            let k = `${gx},${gy}`;
            if (seen.has(k)) return;
            seen.add(k);
            out.push({ gx, gy });
        };

        for (let layer = 0; layer <= ringWidth; layer++) {
            let left = margin + layer;
            let right = GRID_W - 1 - margin - layer;
            let top = margin + layer;
            let bottom = GRID_H - 1 - margin - layer;
            if (left > right || top > bottom) break;

            for (let gx = left; gx <= right; gx++) add(gx, top);
            for (let gy = top + 1; gy <= bottom; gy++) add(right, gy);
            if (bottom > top) {
                for (let gx = right - 1; gx >= left; gx--) add(gx, bottom);
            }
            if (right > left) {
                for (let gy = bottom - 1; gy > top; gy--) add(left, gy);
            }
        }

        return out;
    };

    if (MAP_TYPE === 'arena') {
        let ringWidth = Math.max(2, Math.floor(mapMin * 0.16));
        shapeMask = (gx, gy) => {
            let edgeDist = Math.min(gx, gy, GRID_W - 1 - gx, GRID_H - 1 - gy);
            return edgeDist <= ringWidth;
        };
        addCandidatesFromList(buildArenaEdgeSpiralCandidates(ringWidth), false);
    } else if (MAP_TYPE === 'island') {
        let islandRadius = Math.max(4, Math.floor(mapMin * 0.19));
        shapeMask = (gx, gy) => Math.hypot(gx - centerX, gy - centerY) <= islandRadius;
        let list = [];
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let d = Math.hypot(gx - centerX, gy - centerY);
                if (d <= islandRadius) list.push({ gx, gy, d });
            }
        }
        list.sort((a, b) => a.d - b.d);
        addCandidatesFromList(list, false);
    } else if (MAP_TYPE === 'islands') {
        let anchors = (spawnTiles && spawnTiles.length > 0) ? spawnTiles : pickEdgePlayerSpawns(2);
        let centerPull = 0.3;
        let islandRadius = Math.max(4, Math.floor(mapMin * Math.max(0.08, 0.2 - anchors.length * 0.015)));
        let islandCenters = anchors.map(s => ({
            cx: s.gx + (centerX - s.gx) * centerPull,
            cy: s.gy + (centerY - s.gy) * centerPull
        }));

        shapeMask = (gx, gy) => islandCenters.some(c => Math.hypot(gx - c.cx, gy - c.cy) <= islandRadius);

        let list = [];
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let best = Infinity;
                for (let c of islandCenters) {
                    let d = Math.hypot(gx - c.cx, gy - c.cy);
                    if (d < best) best = d;
                }
                if (best <= islandRadius) list.push({ gx, gy, d: best });
            }
        }
        list.sort((a, b) => a.d - b.d);
        addCandidatesFromList(list, false);
    } else if (MAP_TYPE === 'solar_system') {
        shapeMask = (gx, gy) => {
            let d = Math.hypot(gx - centerX, gy - centerY);
            let maxDist = Math.hypot(centerX - margin, centerY - margin);
            let norm = Math.min(1, d / Math.max(1, maxDist));
            return norm <= 0.98;
        };
        let list = [];
        let maxDist = Math.hypot(centerX - margin, centerY - margin);
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let d = Math.hypot(gx - centerX, gy - centerY);
                let norm = Math.min(1, d / Math.max(1, maxDist));
                let p = Math.pow(Math.max(0, 1 - norm), 6.5);
                if (norm <= 0.12 || rng() < p) list.push({ gx, gy });
            }
        }
        addCandidatesFromList(list, true);
    } else if (MAP_TYPE === 'crossroads') {
        let armHalf = Math.max(2, Math.floor(mapMin * 0.08));
        shapeMask = (gx, gy) => Math.abs(gx - centerX) <= armHalf || Math.abs(gy - centerY) <= armHalf;
        let list = [];
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let onVertical = Math.abs(gx - centerX) <= armHalf;
                let onHorizontal = Math.abs(gy - centerY) <= armHalf;
                if (onVertical || onHorizontal) list.push({ gx, gy });
            }
        }
        addCandidatesFromList(list, true);
    }

    let fallbackAttempts = Math.max(totalMines * 30, 300);
    for (let i = 0; i < fallbackAttempts && candidates.length < totalMines; i++) {
        let gx = margin + Math.floor(rng() * Math.max(1, GRID_W - margin * 2));
        let gy = margin + Math.floor(rng() * Math.max(1, GRID_H - margin * 2));
        addCandidate(gx, gy);
    }

    let goldRange = Math.max(0, GOLD_MINE_MAX - GOLD_MINE_MIN);
    let astarRange = Math.max(0, ASTAR_MINE_MAX - ASTAR_MINE_MIN);
    let occupied = new Set();
    let remainingGold = totalGold;
    let remainingAstar = totalAstar;
    let targetPlacements = Math.max(0, Math.min(totalMines, candidates.length));
    let placedRecords = [];

    let placeGoldMine = (gx, gy) => {
        let gold = GOLD_MINE_MIN + Math.floor(rng() * goldRange);
        let mine = { gx, gy, gold, maxGold: gold, x: gx * TILE + 16, y: gy * TILE + 16 };
        goldMines.push(mine);
        setTileEntity(gx, gy, TILE_ENTITY_GOLDMINE, mine);
        return mine;
    };

    let placeAstarMine = (gx, gy) => {
        let astar = ASTAR_MINE_MIN + Math.floor(rng() * astarRange);
        let mine = { gx, gy, astar, maxAstar: astar, x: gx * TILE + 16, y: gy * TILE + 16 };
        astarMines.push(mine);
        setTileEntity(gx, gy, TILE_ENTITY_ASTARMINE, mine);
        return mine;
    };

    for (let i = 0; i < candidates.length; i++) {
        let c = candidates[i];
        if (placedRecords.length >= targetPlacements) break;
        let key = `${c.gx},${c.gy}`;
        if (occupied.has(key)) continue;
        if (!grid[c.gy] || !grid[c.gy][c.gx] || grid[c.gy][c.gx].type !== TYPE_FLOOR) continue;

        let totalLeft = remainingGold + remainingAstar;
        if (totalLeft <= 0) break;
        let pickAstar = remainingAstar > 0 && (remainingGold <= 0 || rng() < (remainingAstar / totalLeft));

        if (pickAstar) {
            let mine = placeAstarMine(c.gx, c.gy);
            remainingAstar--;
            placedRecords.push({ type: 'astar', gx: c.gx, gy: c.gy, mine });
        } else {
            let mine = placeGoldMine(c.gx, c.gy);
            remainingGold--;
            placedRecords.push({ type: 'gold', gx: c.gx, gy: c.gy, mine });
        }
        occupied.add(key);
        grid[c.gy][c.gx].type = TYPE_WALL;
    }

    // If both resource types are configured, ensure both appear when at least two mines were placed.
    if (totalGold > 0 && totalAstar > 0 && placedRecords.length >= 2) {
        let placedGold = placedRecords.filter(r => r.type === 'gold');
        let placedAstar = placedRecords.filter(r => r.type === 'astar');

        if (placedGold.length === 0 && placedAstar.length > 0) {
            let pick = placedAstar[Math.floor(rng() * placedAstar.length)];
            clearTileEntity(pick.gx, pick.gy, pick.mine);
            let idx = astarMines.indexOf(pick.mine);
            if (idx !== -1) astarMines.splice(idx, 1);
            let converted = placeGoldMine(pick.gx, pick.gy);
            pick.type = 'gold';
            pick.mine = converted;
        } else if (placedAstar.length === 0 && placedGold.length > 0) {
            let pick = placedGold[Math.floor(rng() * placedGold.length)];
            clearTileEntity(pick.gx, pick.gy, pick.mine);
            let idx = goldMines.indexOf(pick.mine);
            if (idx !== -1) goldMines.splice(idx, 1);
            let converted = placeAstarMine(pick.gx, pick.gy);
            pick.type = 'astar';
            pick.mine = converted;
        }
    }
}

function generateGoldMines() {
    let spawnTiles = arguments.length > 0 && arguments[0] ? arguments[0] : [];
    for (let m of goldMines) {
        if (!m) continue;
        clearTileEntity(Math.floor(Number(m.gx)), Math.floor(Number(m.gy)), m);
    }
    goldMines = [];
    let totalMines = Math.max(0, Math.floor(GOLD_MINE_COUNT || 0));
    let margin = 1;
    let spawnSafeRadius = 3;
    let placed = new Set();
    let goldRange = Math.max(0, GOLD_MINE_MAX - GOLD_MINE_MIN);
    let shapeMask = null;

    let nearAnySpawn = (gx, gy) => {
        if (!spawnTiles || spawnTiles.length === 0) return false;
        return spawnTiles.some(s => Math.hypot(gx - s.gx, gy - s.gy) <= spawnSafeRadius);
    };

    let isAllowedByShape = (gx, gy) => {
        if (!shapeMask) return true;
        return !!shapeMask(gx, gy);
    };

    let addMine = (gx, gy) => {
        if (gx < margin || gx >= GRID_W - margin || gy < margin || gy >= GRID_H - margin) return false;
        if (placed.has(`${gx},${gy}`)) return false;
        if (!grid[gy] || !grid[gy][gx] || grid[gy][gx].type !== TYPE_FLOOR) return false;
        if (!isAllowedByShape(gx, gy)) return false;
        if (MAP_TYPE !== 'arena' && nearAnySpawn(gx, gy)) return false;
        placed.add(`${gx},${gy}`);
        let gold = GOLD_MINE_MIN + Math.floor(rng() * goldRange);
        let mine = { gx, gy, gold, maxGold: gold, x: gx * TILE + 16, y: gy * TILE + 16 };
        goldMines.push(mine);
        setTileEntity(gx, gy, TILE_ENTITY_GOLDMINE, mine);
        grid[gy][gx].type = TYPE_WALL;
        return true;
    };

    let addMinesFromCandidates = (candidates, shuffle = true) => {
        if (shuffle) {
            for (let i = candidates.length - 1; i > 0; i--) {
                let j = Math.floor(rng() * (i + 1));
                [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
            }
        }
        for (let c of candidates) {
            if (goldMines.length >= totalMines) break;
            addMine(c.gx, c.gy);
        }
    };

    let buildArenaEdgeSpiralCandidates = (ringWidth) => {
        let candidates = [];
        let seen = new Set();
        let add = (gx, gy) => {
            if (gx < margin || gx >= GRID_W - margin || gy < margin || gy >= GRID_H - margin) return;
            let k = `${gx},${gy}`;
            if (seen.has(k)) return;
            seen.add(k);
            candidates.push({ gx, gy });
        };

        for (let layer = 0; layer <= ringWidth; layer++) {
            let left = margin + layer;
            let right = GRID_W - 1 - margin - layer;
            let top = margin + layer;
            let bottom = GRID_H - 1 - margin - layer;
            if (left > right || top > bottom) break;

            for (let gx = left; gx <= right; gx++) add(gx, top);
            for (let gy = top + 1; gy <= bottom; gy++) add(right, gy);
            if (bottom > top) {
                for (let gx = right - 1; gx >= left; gx--) add(gx, bottom);
            }
            if (right > left) {
                for (let gy = bottom - 1; gy > top; gy--) add(left, gy);
            }
        }

        return candidates;
    };

    let generateRandomMines = () => {
        let remaining = totalMines - goldMines.length;
        let veinSeeds = [];
        while (remaining > 0) {
            let veinSize = Math.min(remaining, 3 + Math.floor(rng() * 4));
            veinSeeds.push(veinSize);
            remaining -= veinSize;
        }

        for (let veinSize of veinSeeds) {
            let seedGx = -1, seedGy = -1;
            for (let att = 0; att < 100; att++) {
                let gx = margin + Math.floor(rng() * Math.max(1, GRID_W - margin * 2));
                let gy = margin + Math.floor(rng() * Math.max(1, GRID_H - margin * 2));
                if (!placed.has(`${gx},${gy}`) && !nearAnySpawn(gx, gy) && isAllowedByShape(gx, gy) && grid[gy][gx].type === TYPE_FLOOR) {
                    seedGx = gx; seedGy = gy;
                    break;
                }
            }
            if (seedGx < 0) continue;

            let frontier = [{ x: seedGx, y: seedGy }];
            let placedCount = 0;
            while (placedCount < veinSize && frontier.length > 0) {
                let idx = Math.floor(rng() * frontier.length);
                let tile = frontier[idx];
                frontier.splice(idx, 1);
                if (addMine(tile.x, tile.y)) {
                    placedCount++;
                    for (let [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
                        let nx = tile.x + dx, ny = tile.y + dy;
                        if (nx >= margin && nx < GRID_W - margin && ny >= margin && ny < GRID_H - margin) {
                            frontier.push({ x: nx, y: ny });
                        }
                    }
                }
            }
        }
    };

    let mapMin = Math.min(GRID_W, GRID_H);
    let centerX = (GRID_W - 1) / 2;
    let centerY = (GRID_H - 1) / 2;

    if (MAP_TYPE === 'arena') {
        let ringWidth = Math.max(2, Math.floor(mapMin * 0.16));
        shapeMask = (gx, gy) => {
            let edgeDist = Math.min(gx, gy, GRID_W - 1 - gx, GRID_H - 1 - gy);
            return edgeDist <= ringWidth;
        };
        let candidates = buildArenaEdgeSpiralCandidates(ringWidth);
        totalMines = Math.max(totalMines, candidates.length);
        addMinesFromCandidates(candidates, false);
    } else if (MAP_TYPE === 'island') {
        let islandRadius = Math.max(4, Math.floor(mapMin * 0.19));
        shapeMask = (gx, gy) => Math.hypot(gx - centerX, gy - centerY) <= islandRadius;
        let candidates = [];
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let d = Math.hypot(gx - centerX, gy - centerY);
                if (d <= islandRadius) candidates.push({ gx, gy, d });
            }
        }
        candidates.sort((a, b) => a.d - b.d);
        addMinesFromCandidates(candidates, false);
    } else if (MAP_TYPE === 'islands') {
        let anchors = (spawnTiles && spawnTiles.length > 0) ? spawnTiles : pickEdgePlayerSpawns(2);
        let centerPull = 0.3;
        let islandRadius = Math.max(4, Math.floor(mapMin * Math.max(0.08, 0.2 - anchors.length * 0.015)));
        let islandCenters = anchors.map(s => ({
            cx: s.gx + (centerX - s.gx) * centerPull,
            cy: s.gy + (centerY - s.gy) * centerPull
        }));

        shapeMask = (gx, gy) => islandCenters.some(c => Math.hypot(gx - c.cx, gy - c.cy) <= islandRadius);

        let candidates = [];
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let best = Infinity;
                for (let c of islandCenters) {
                    let d = Math.hypot(gx - c.cx, gy - c.cy);
                    if (d < best) best = d;
                }
                if (best <= islandRadius) candidates.push({ gx, gy, d: best });
            }
        }
        candidates.sort((a, b) => a.d - b.d);
        addMinesFromCandidates(candidates, false);
    } else if (MAP_TYPE === 'solar_system') {
        shapeMask = (gx, gy) => {
            let d = Math.hypot(gx - centerX, gy - centerY);
            let maxDist = Math.hypot(centerX - margin, centerY - margin);
            let norm = Math.min(1, d / Math.max(1, maxDist));
            return norm <= 0.98;
        };
        let candidates = [];
        let maxDist = Math.hypot(centerX - margin, centerY - margin);
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let d = Math.hypot(gx - centerX, gy - centerY);
                let norm = Math.min(1, d / Math.max(1, maxDist));
                let p = Math.pow(Math.max(0, 1 - norm), 6.5);
                if (norm <= 0.12 || rng() < p) candidates.push({ gx, gy });
            }
        }
        addMinesFromCandidates(candidates);
    } else if (MAP_TYPE === 'crossroads') {
        let armHalf = Math.max(2, Math.floor(mapMin * 0.08));
        shapeMask = (gx, gy) => Math.abs(gx - centerX) <= armHalf || Math.abs(gy - centerY) <= armHalf;
        let candidates = [];
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                let onVertical = Math.abs(gx - centerX) <= armHalf;
                let onHorizontal = Math.abs(gy - centerY) <= armHalf;
                if (onVertical || onHorizontal) candidates.push({ gx, gy });
            }
        }
        addMinesFromCandidates(candidates);
    } else {
        generateRandomMines();
    }

    if (MAP_TYPE !== 'arena' && goldMines.length < totalMines) {
        generateRandomMines();
    }
}

function generateAstarMines() {
    let spawnTiles = arguments.length > 0 && arguments[0] ? arguments[0] : [];
    for (let m of astarMines) {
        if (!m) continue;
        clearTileEntity(Math.floor(Number(m.gx)), Math.floor(Number(m.gy)), m);
    }
    astarMines = [];
    let totalMines = Math.max(0, Math.floor(ASTAR_MINE_COUNT || 0));
    let margin = 1;
    let spawnSafeRadius = 3;
    let placed = new Set();
    let astarRange = Math.max(0, ASTAR_MINE_MAX - ASTAR_MINE_MIN);

    let nearAnySpawn = (gx, gy) => {
        if (!spawnTiles || spawnTiles.length === 0) return false;
        return spawnTiles.some(s => Math.hypot(gx - s.gx, gy - s.gy) <= spawnSafeRadius);
    };

    let addMine = (gx, gy) => {
        if (gx < margin || gx >= GRID_W - margin || gy < margin || gy >= GRID_H - margin) return false;
        if (placed.has(`${gx},${gy}`)) return false;
        if (!grid[gy] || !grid[gy][gx] || grid[gy][gx].type !== TYPE_FLOOR) return false;
        if (MAP_TYPE !== 'arena' && nearAnySpawn(gx, gy)) return false;
        if (getGoldMineAt(gx, gy) || getAstarMineAt(gx, gy)) return false;
        placed.add(`${gx},${gy}`);
        let astar = ASTAR_MINE_MIN + Math.floor(rng() * astarRange);
        let mine = { gx, gy, astar, maxAstar: astar, x: gx * TILE + 16, y: gy * TILE + 16 };
        astarMines.push(mine);
        setTileEntity(gx, gy, TILE_ENTITY_ASTARMINE, mine);
        grid[gy][gx].type = TYPE_WALL;
        return true;
    };

    let attempts = Math.max(totalMines * 20, 200);
    for (let i = 0; i < attempts && astarMines.length < totalMines; i++) {
        let gx = margin + Math.floor(rng() * Math.max(1, GRID_W - margin * 2));
        let gy = margin + Math.floor(rng() * Math.max(1, GRID_H - margin * 2));
        addMine(gx, gy);
    }
}

function pickRandomPlayerSpawns(teamCount = 2) {
    teamCount = Math.max(2, Math.min(8, Math.floor(teamCount || 2)));
    let margin = 2;
    let minSpawnSeparation = Math.max(8, Math.floor(Math.min(GRID_W, GRID_H) * (teamCount <= 3 ? 0.28 : 0.18)));

    function randomFloorTile() {
        for (let i = 0; i < 120; i++) {
            let gx = margin + Math.floor(rng() * Math.max(1, GRID_W - margin * 2));
            let gy = margin + Math.floor(rng() * Math.max(1, GRID_H - margin * 2));
            if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H && grid[gy][gx].type === TYPE_FLOOR) {
                return { gx, gy };
            }
        }
        return null;
    }

    for (let att = 0; att < 240; att++) {
        let picks = [];
        let ok = true;
        for (let i = 0; i < teamCount; i++) {
            let tile = randomFloorTile();
            if (!tile) { ok = false; break; }
            let tooClose = picks.some(p => (Math.abs(p.gx - tile.gx) + Math.abs(p.gy - tile.gy)) < minSpawnSeparation);
            if (tooClose) { ok = false; break; }
            picks.push(tile);
        }
        if (ok && picks.length === teamCount) return picks;
    }

    let fallback = [];
    for (let i = 0; i < teamCount; i++) {
        let t = i / teamCount;
        let gx = Math.max(1, Math.min(GRID_W - 2, Math.floor((GRID_W - 2) * t) + 1));
        let gy = (i % 2 === 0) ? Math.max(1, Math.min(GRID_H - 2, 3)) : Math.max(1, Math.min(GRID_H - 2, GRID_H - 4));
        fallback.push({ gx, gy });
    }
    return fallback;
}

function pickEdgePlayerSpawns(teamCount = 2) {
    teamCount = Math.max(2, Math.min(8, Math.floor(teamCount || 2)));
    let margin = 2;
    let candidates = [];
    for (let gy = margin; gy < GRID_H - margin; gy++) {
        for (let gx = margin; gx < GRID_W - margin; gx++) {
            if (grid[gy][gx].type !== TYPE_FLOOR) continue;
            let edgeDist = Math.min(gx - margin, gy - margin, (GRID_W - 1 - margin) - gx, (GRID_H - 1 - margin) - gy);
            if (edgeDist <= 1) candidates.push({ gx, gy });
        }
    }
    if (!candidates.length) return pickRandomPlayerSpawns(teamCount);

    let picks = [];
    let first = candidates[Math.floor(rng() * candidates.length)];
    picks.push(first);
    while (picks.length < teamCount) {
        let best = null;
        let bestScore = -1;
        for (let c of candidates) {
            if (picks.some(p => p.gx === c.gx && p.gy === c.gy)) continue;
            let nearest = Infinity;
            for (let p of picks) {
                let d = Math.hypot(c.gx - p.gx, c.gy - p.gy);
                if (d < nearest) nearest = d;
            }
            if (nearest > bestScore) {
                bestScore = nearest;
                best = c;
            }
        }
        if (!best) break;
        picks.push(best);
    }

    if (picks.length < teamCount) return pickRandomPlayerSpawns(teamCount);
    return picks;
}

function pickIslandPlayerSpawns(teamCount = 2) {
    teamCount = Math.max(2, Math.min(8, Math.floor(teamCount || 2)));
    let centerX = (GRID_W - 1) / 2;
    let centerY = (GRID_H - 1) / 2;
    let radius = Math.max(6, Math.floor(Math.min(GRID_W, GRID_H) * 0.34));
    let picks = [];
    for (let i = 0; i < teamCount; i++) {
        let ang = (Math.PI * 2 * i) / teamCount;
        let gx = Math.round(centerX + Math.cos(ang) * radius);
        let gy = Math.round(centerY + Math.sin(ang) * radius);
        gx = Math.max(1, Math.min(GRID_W - 2, gx));
        gy = Math.max(1, Math.min(GRID_H - 2, gy));
        if (grid[gy][gx].type !== TYPE_FLOOR) {
            let n = findNearestWalkable(gx, gy, centerX, centerY);
            gx = n.x; gy = n.y;
        }
        picks.push({ gx, gy });
    }
    return picks;
}

function pickIslandsPlayerSpawns(teamCount = 2) {
    teamCount = Math.max(2, Math.min(8, Math.floor(teamCount || 2)));
    let margin = 1;
    let candidates = [];
    for (let gy = margin; gy < GRID_H - margin; gy++) {
        for (let gx = margin; gx < GRID_W - margin; gx++) {
            if (grid[gy][gx].type !== TYPE_FLOOR) continue;
            let edgeDist = Math.min(gx - margin, gy - margin, (GRID_W - 1 - margin) - gx, (GRID_H - 1 - margin) - gy);
            if (edgeDist <= 1) candidates.push({ gx, gy });
        }
    }
    if (!candidates.length) return pickEdgePlayerSpawns(teamCount);

    let picks = [];
    let first = candidates[Math.floor(rng() * candidates.length)];
    picks.push(first);
    while (picks.length < teamCount) {
        let best = null;
        let bestScore = -1;
        for (let c of candidates) {
            if (picks.some(p => p.gx === c.gx && p.gy === c.gy)) continue;
            let nearest = Infinity;
            for (let p of picks) {
                let d = Math.hypot(c.gx - p.gx, c.gy - p.gy);
                if (d < nearest) nearest = d;
            }
            if (nearest > bestScore) {
                bestScore = nearest;
                best = c;
            }
        }
        if (!best) break;
        picks.push(best);
    }

    if (picks.length < teamCount) return pickEdgePlayerSpawns(teamCount);
    return picks;
}

function pickArenaPlayerSpawns(teamCount = 2) {
    teamCount = Math.max(2, Math.min(8, Math.floor(teamCount || 2)));
    let margin = 1;
    let ringWidth = Math.max(2, Math.floor(Math.min(GRID_W, GRID_H) * 0.16));
    let targetEdgeDist = ringWidth + 1;
    let candidates = [];

    for (let gy = margin; gy < GRID_H - margin; gy++) {
        for (let gx = margin; gx < GRID_W - margin; gx++) {
            if (grid[gy][gx].type !== TYPE_FLOOR) continue;
            let edgeDist = Math.min(gx, gy, GRID_W - 1 - gx, GRID_H - 1 - gy);
            if (edgeDist === targetEdgeDist) candidates.push({ gx, gy });
        }
    }

    if (!candidates.length) {
        for (let gy = margin; gy < GRID_H - margin; gy++) {
            for (let gx = margin; gx < GRID_W - margin; gx++) {
                if (grid[gy][gx].type !== TYPE_FLOOR) continue;
                let edgeDist = Math.min(gx, gy, GRID_W - 1 - gx, GRID_H - 1 - gy);
                if (Math.abs(edgeDist - targetEdgeDist) <= 1) candidates.push({ gx, gy });
            }
        }
    }

    if (!candidates.length) return pickEdgePlayerSpawns(teamCount);

    let picks = [];
    let first = candidates[Math.floor(rng() * candidates.length)];
    picks.push(first);
    while (picks.length < teamCount) {
        let best = null;
        let bestScore = -1;
        for (let c of candidates) {
            if (picks.some(p => p.gx === c.gx && p.gy === c.gy)) continue;
            let nearest = Infinity;
            for (let p of picks) {
                let d = Math.hypot(c.gx - p.gx, c.gy - p.gy);
                if (d < nearest) nearest = d;
            }
            if (nearest > bestScore) {
                bestScore = nearest;
                best = c;
            }
        }
        if (!best) break;
        picks.push(best);
    }

    if (picks.length < teamCount) return pickEdgePlayerSpawns(teamCount);
    return picks;
}

function pickPlayerSpawns(teamCount = 2) {
    if (MAP_TYPE === 'arena') return pickArenaPlayerSpawns(teamCount);
    if (MAP_TYPE === 'solar_system') return pickEdgePlayerSpawns(teamCount);
    if (MAP_TYPE === 'islands') return pickIslandsPlayerSpawns(teamCount);
    if (MAP_TYPE === 'island') return pickIslandPlayerSpawns(teamCount);
    return pickRandomPlayerSpawns(teamCount);
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

function getPlayerPopCap(playerId) {
    let cfgCap = getConfiguredMaxPop();
    if (playerId < 0 || playerId >= playerPopCaps.length) return cfgCap;
    let cap = playerPopCaps[playerId];
    return Number.isFinite(cap) ? cap : cfgCap;
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

function saveUiSettingsToStorage() {
    try {
        localStorage.setItem(LS_UI_SETTINGS_KEY, JSON.stringify({
            levelVisibilityMode,
            renderRangeMode,
            audioEnabled,
            showGoldMineAmountText,
            rallyLineType,
            rallyLineScope,
            selectionOutlineType,
            selectionOutlineScope,
            buildPlacementMode
        }));
    } catch { }
}

function loadUiSettingsFromStorage() {
    try {
        let raw = localStorage.getItem(LS_UI_SETTINGS_KEY);
        if (!raw) return;
        let s = JSON.parse(raw);
        if (!s || typeof s !== 'object') return;

        if (Number.isFinite(s.levelVisibilityMode)) {
            levelVisibilityMode = Math.max(0, Math.min(2, Math.floor(s.levelVisibilityMode)));
        }
        if (Number.isFinite(s.renderRangeMode)) {
            renderRangeMode = Math.max(0, Math.min(2, Math.floor(s.renderRangeMode)));
        }
        if (typeof s.audioEnabled === 'boolean') {
            audioEnabled = s.audioEnabled;
        }
        if (typeof s.showGoldMineAmountText === 'boolean') {
            showGoldMineAmountText = s.showGoldMineAmountText;
        }
        if (s.rallyLineType === OVERLAY_LINE_SOLID || s.rallyLineType === OVERLAY_LINE_DOTTED) {
            rallyLineType = s.rallyLineType;
        }
        if (s.rallyLineScope === OVERLAY_SCOPE_BUILDINGS || s.rallyLineScope === OVERLAY_SCOPE_BUILDINGS_UNITS || s.rallyLineScope === OVERLAY_SCOPE_NONE) {
            rallyLineScope = s.rallyLineScope;
        }
        if (s.selectionOutlineType === OVERLAY_LINE_SOLID || s.selectionOutlineType === OVERLAY_LINE_DOTTED) {
            selectionOutlineType = s.selectionOutlineType;
        }
        if (s.selectionOutlineScope === OVERLAY_SCOPE_BUILDINGS || s.selectionOutlineScope === OVERLAY_SCOPE_BUILDINGS_UNITS || s.selectionOutlineScope === OVERLAY_SCOPE_NONE) {
            selectionOutlineScope = s.selectionOutlineScope;
        }
        if (Number.isFinite(s.buildPlacementMode)) {
            buildPlacementMode = Math.max(0, Math.min(2, Math.floor(s.buildPlacementMode)));
        }
    } catch { }
}

function formatRangeStatTiles(v) {
    return (Number.isFinite(v) && v > 0) ? `${v.toFixed(1)}` : '-';
}

function getEntityVisibilityRangeTiles(e) {
    if (!e) return null;
    if (e.currentStats && Number.isFinite(e.currentStats.visionRange)) return e.currentStats.visionRange;
    if (Number.isFinite(e.baseLevelVisionRange)) return e.baseLevelVisionRange;
    if (Number.isFinite(e.visionRange)) return e.visionRange;
    return null;
}

function getEntityStatsCalcType(e) {
    if (!e) return '';
    if (e.type === 'barrack' && e.unitType) return 'barrack_' + e.unitType;
    return e.type || '';
}

function getEntityBaseVisibilityRangeTiles(e) {
    if (!e) return null;
    let statsType = getEntityStatsCalcType(e);
    let baseLevel = getThingBaseLevel(e, stackCountToLevel((e.stacks || 1)));
    if (statsType) {
        let s = calculateItemStats(statsType, baseLevel, e.owner);
        if (s && Number.isFinite(s.visionRange)) return s.visionRange;
    }
    if (Number.isFinite(e.baseLevelVisionRange)) return e.baseLevelVisionRange;
    return getEntityVisibilityRangeTiles(e);
}

function getEntityEffectiveVisibilityRangeTiles(e) {
    if (!e) return null;
    let statsType = getEntityStatsCalcType(e);
    let baseLevel = getThingBaseLevel(e, stackCountToLevel((e.stacks || 1)));
    let effLevel = getThingEffectiveLevel(e, baseLevel);
    if (statsType) {
        let s = calculateItemStats(statsType, effLevel, e.owner);
        if (s && Number.isFinite(s.visionRange)) return s.visionRange;
    }
    return getEntityVisibilityRangeTiles(e);
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

function getUnitRenderActionRangePx(u) {
    if (!u) return 0;
    // Worker interaction checks use a fixed touch distance in AI logic.
    if (u.workerType === 'collector' || u.workerType === 'astar_collector' || u.workerType === 'salvager' || u.workerType === 'builder' || u.workerType === 'healer' || u.workerType === 'researcher') {
        return 24;
    }
    let atkRange = Math.max(0, Number(u.attackRange) || 0);
    if (atkRange <= 0) return 0;
    // Combat checks are center distance <= attackRange + self radius + target radius.
    // Use a typical target radius for preview circles so this reflects practical reach.
    let selfR = Math.max(0, Number(u.r) || 0);
    let typicalTargetR = 8;
    return atkRange + selfR + typicalTargetR;
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

function updateDefaultToggleButtons() {
    let btnBuild = document.getElementById('btn-default-build');
    if (btnBuild) {
        btnBuild.textContent = `\uD83D\uDD28 New: ${defaultAutoBuildEnabled ? 'ON' : 'OFF'}`;
        btnBuild.style.borderColor = defaultAutoBuildEnabled ? '#6f6' : '#555';
        btnBuild.style.color = defaultAutoBuildEnabled ? '#9f9' : '#888';
        btnBuild.style.background = defaultAutoBuildEnabled ? 'rgba(40,90,40,0.25)' : 'transparent';
    }
    let btnAuto = document.getElementById('btn-default-auto-upgrade');
    if (btnAuto) {
        btnAuto.textContent = `L+New: ${defaultAutoUpgradeEnabled ? 'ON' : 'OFF'}`;
        btnAuto.style.borderColor = defaultAutoUpgradeEnabled ? '#4af' : '#555';
        btnAuto.style.color = defaultAutoUpgradeEnabled ? '#8cf' : '#888';
        btnAuto.style.background = defaultAutoUpgradeEnabled ? 'rgba(40,70,110,0.25)' : 'transparent';
    }
}

function updateIgnoreLevelButton() {
    let buttons = [
        document.getElementById('btn-ignore-level'),
        document.getElementById('btn-ignore-level-popup')
    ].filter(Boolean);
    if (buttons.length <= 0) return;
    for (let btn of buttons) {
        btn.textContent = `Collapse Same Type: ${ignoreLevelSubgroups ? 'ON' : 'OFF'}`;
        btn.style.borderColor = ignoreLevelSubgroups ? '#fd0' : '#555';
        btn.style.color = ignoreLevelSubgroups ? '#fd0' : '#999';
        btn.style.background = ignoreLevelSubgroups ? 'rgba(110,90,20,0.25)' : '#181818';
    }
}

function renderMultiplierBar(containerId, currentValue, onChange, label) {
    let bar = document.getElementById(containerId);
    if (!bar) return;
    let html = '';
    for (let mult of PURCHASE_MULTIPLIERS) {
        let activeCls = mult === currentValue ? ' active' : '';
        html += `<button class="mult-toggle-btn${activeCls}" data-mult="${mult}">x${mult}</button>`;
    }
    bar.innerHTML = html;
    bar.querySelectorAll('.mult-toggle-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let val = parseInt(btn.dataset.mult);
            if (!Number.isFinite(val) || val < 1) return;
            onChange(val);
        });
    });
}

function updatePurchaseMultiplierBars() {
    renderMultiplierBar('build-multiplier-bar', buildPurchaseMultiplier, (val) => {
        buildPurchaseMultiplier = val;
        updatePurchaseMultiplierBars();
        updateBuildMenu();
    }, 'Buy');
    renderMultiplierBar('queue-multiplier-bar', queuePurchaseMultiplier, (val) => {
        queuePurchaseMultiplier = val;
        updatePurchaseMultiplierBars();
        updateInfoPanel();
    }, 'Queue');
    renderMultiplierBar('queue-multiplier-bar-popup', queuePurchaseMultiplier, (val) => {
        queuePurchaseMultiplier = val;
        updatePurchaseMultiplierBars();
        updateInfoPanel();
        renderResearchPopupContent();
    }, 'Queue');
}

function queueResizeForEachActiveUnitSubgroup(mode) {
    let activeUnits = getActiveUnits();
    if (!activeUnits || activeUnits.length === 0) return;
    let groups = new Map();
    for (let u of activeUnits) {
        let key = getUnitGroupKey(u);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(u);
    }
    for (let group of groups.values()) {
        if (!group || group.length === 0) continue;
        if (mode === 'd2' && group.length < 2) continue;
        let u0 = group[0];
        let unitType = u0.unitType;
        let unitLevel = ignoreLevelSubgroups ? null : getUnitBaseLevel(u0);
        let ids = group.map(u => u.id);
        queueAction({ action: 'resizeUnitGroup', unitIds: ids, mode, unitType, unitLevel });
    }
    setTimeout(updateInfoPanel, 50);
}

function getNextLevelUpgradeInfo(item) {
    let stacks = Math.max(1, item.stacks || 1);
    let level = stackCountToLevel(stacks);
    let nextLevel = Math.max(1, level + 1);
    let nextStacksNeeded = getRequiredStacksForLevel(nextLevel);
    let missingStacks = Math.max(0, nextStacksNeeded - stacks);
    let key = item instanceof Tower ? item.type : (item.type === 'barrack' ? 'barrack_' + item.unitType : item.type);
    let def = BASE_CARD_TYPES[key] || { price: 0 };
    let goldCost = missingStacks * (def.price || 0);
    let energyNow = item.maxEnergy || 0;
    let energyNext = item instanceof Tower ? getUpgrademaxEnergy(item, nextLevel) : (calculateItemStats(item.type || 'farm', nextLevel, item.owner).maxEnergy || energyNow);
    return { nextLevel, missingStacks, goldCost, energyNow, energyNext };
}

function normalizeBuildingResearchKey(type) {
    if (!type) return 'farm';
    if (type === 'barrack') return 'barrack_norm';
    if (type.startsWith('barrack_')) return type;
    return type;
}

function calculateItemStats(type, level, owner = null) {
    let stats = { maxEnergy: 0, damage: 0, blastDamage: NaN, blastRadius: NaN, multiplier: NaN };
    let ownerId = Number.isFinite(owner) ? owner : localPlayerId;
    let bKey = normalizeBuildingResearchKey(type);
    let lvl = Math.max(1, clampThingLevel(level));
    let maxEnergy = getBuildingStatForOwner(ownerId, bKey, lvl, 'maxEnergy');
    let damage = getBuildingStatForOwner(ownerId, bKey, lvl, 'damage');
    let blastDamage = getBuildingStatForOwner(ownerId, bKey, lvl, 'blastDamage');
    let blastRadius = getBuildingStatForOwner(ownerId, bKey, lvl, 'blastRadius');
    let multiplier = getBuildingStatForOwner(ownerId, bKey, lvl, 'multiplier');
    if (Number.isFinite(maxEnergy)) stats.maxEnergy = Math.max(1, Math.floor(maxEnergy));
    if (Number.isFinite(damage)) stats.damage = damage;
    if (Number.isFinite(blastDamage)) stats.blastDamage = blastDamage;
    if (Number.isFinite(blastRadius)) stats.blastRadius = Math.max(0, blastRadius);
    if (Number.isFinite(multiplier)) stats.multiplier = multiplier;
    return stats;
}

function ensureStatusState(target) {
    if (!target) return;
    if (target.burning === undefined) target.burning = 0;
    if (target.burnTickDamage === undefined) target.burnTickDamage = 0;
    if (target.poisoned === undefined) target.poisoned = 0;
    if (target.poisonTickDamage === undefined) target.poisonTickDamage = 0;
    if (target.frozen === undefined) target.frozen = 0;
    if (target.iceTickDamage === undefined) target.iceTickDamage = 0;
    if (target.wet === undefined) target.wet = 0;
    if (target.sandy === undefined) target.sandy = 0;
    if (target.watched === undefined) target.watched = 0;
}

function isEffectImmune(target, effect) {
    if (!target) return false;
    if (effect === 'fire' && target.fireResistant) return true;
    if (effect === 'poison' && target.poisonResistant) return true;
    if (effect === 'water' && target.waterResistant) return true;
    if (effect === 'ice' && target.iceResistant) return true;
    if (effect === 'sand' && target.sandResistant) return true;

    let tType = target.type || '';
    if (tType === 'fire' && effect === 'fire') return true;
    if (tType === 'poison' && effect === 'poison') return true;
    if (tType === 'water' && effect === 'water') return true;
    if (tType === 'ice' && effect === 'ice') return true;
    if (tType === 'sand_gun' && effect === 'sand') return true;
    if (tType === 'watch_tower' && effect === 'watch') return true;
    if (tType === 'elements' && ['fire', 'poison', 'water', 'ice', 'sand'].includes(effect)) return true;
    return false;
}

function _getEffectStatKey(effect, statKind) {
    if (effect === 'fire') return statKind === 'dps' ? 'burnDps' : 'burnDuration';
    if (effect === 'poison') return statKind === 'dps' ? 'poisonDps' : 'poisonDuration';
    if (effect === 'ice') return statKind === 'dps' ? 'freezeDps' : 'freezeDuration';
    if (effect === 'water') return statKind === 'duration' ? 'wetDuration' : '';
    if (effect === 'sand') return statKind === 'duration' ? 'sandDuration' : '';
    if (effect === 'watch') return statKind === 'duration' ? 'watchDuration' : '';
    return '';
}

function _getBuildingEffectStat(owner, sourceType, level, effect, statKind) {
    let statKey = _getEffectStatKey(effect, statKind);
    if (!statKey || !sourceType) return NaN;
    let ownerId = Number.isFinite(owner) ? owner : localPlayerId;
    let lvl = Math.max(1, clampThingLevel(level || 1));
    return getBuildingStatForOwner(ownerId, sourceType, lvl, statKey);
}

function applyStatusEffect(target, effect, level, baseDamage = 0, sourceOwner = null, sourceType = '') {
    if (!target) return false;
    ensureStatusState(target);
    if (isEffectImmune(target, effect)) return false;

    let lvl = Math.max(1, level || 1);
    let mappedDuration = _getBuildingEffectStat(sourceOwner, sourceType, lvl, effect, 'duration');
    let mappedDps = _getBuildingEffectStat(sourceOwner, sourceType, lvl, effect, 'dps');
    if (effect === 'fire') {
        let durSec = Number.isFinite(mappedDuration) ? mappedDuration : (3 + lvl * 0.5);
        let dur = secondsToTicks(durSec);
        target.burning = Math.max(target.burning, dur);
        let d = Number.isFinite(mappedDps) ? mappedDps : Math.max(0.1, baseDamage > 0 ? baseDamage : 0.5);
        target.burnTickDamage = Math.max(target.burnTickDamage, d);
    } else if (effect === 'poison') {
        let durSec = Number.isFinite(mappedDuration) ? mappedDuration : (5 + lvl);
        let dur = secondsToTicks(durSec);
        target.poisoned = Math.max(target.poisoned, dur);
        let d = Number.isFinite(mappedDps) ? mappedDps : Math.max(0.1, baseDamage > 0 ? baseDamage : 0.5);
        target.poisonTickDamage = Math.max(target.poisonTickDamage, d);
    } else if (effect === 'ice') {
        let durSec = Number.isFinite(mappedDuration) ? mappedDuration : (3 + lvl * 0.5);
        let dur = secondsToTicks(durSec);
        target.frozen = Math.max(target.frozen, dur);
        let d = Number.isFinite(mappedDps) ? mappedDps : Math.max(0.2, baseDamage > 0 ? baseDamage : 0.5);
        target.iceTickDamage = Math.max(target.iceTickDamage, d);
    } else if (effect === 'water') {
        let durSec = Number.isFinite(mappedDuration) ? mappedDuration : (6 + lvl);
        let dur = secondsToTicks(durSec);
        target.wet = Math.max(target.wet, dur);
    } else if (effect === 'sand') {
        let durSec = Number.isFinite(mappedDuration) ? mappedDuration : 9;
        let dur = secondsToTicks(durSec);
        target.sandy = Math.max(target.sandy, dur);
    } else if (effect === 'watch') {
        let durSec = Number.isFinite(mappedDuration) ? mappedDuration : (4 + lvl);
        let dur = secondsToTicks(durSec);
        target.watched = Math.max(target.watched, dur);
    }
    return true;
}

function tickStatusEffects(target) {
    if (!target) return false;
    ensureStatusState(target);

    if (target.burning > 0) {
        target.burning--;
        if (target.burnTickDamage > 0) target.energy -= target.burnTickDamage;
    }
    if (target.poisoned > 0) {
        target.poisoned--;
        if (target.poisonTickDamage > 0) target.energy -= target.poisonTickDamage;
    }
    if (target.frozen > 0 && target.wet > 0 && target.iceTickDamage > 0) {
        target.energy -= target.iceTickDamage;
    }
    if (target.frozen > 0) target.frozen--;
    if (target.wet > 0) target.wet--;
    if (target.sandy > 0) target.sandy--;
    if (target.watched > 0) target.watched--;

    if (target.energy !== undefined && target.energy <= 0) {
        target.energy = 0;
        return true;
    }
    return false;
}

function ensureLevelTextCanvas(target) {
    let scale = 2;
    if (!target.textCanvas || !target.textCtx || target._textCanvasScale !== scale) {
        target.textCanvas = document.createElement('canvas');
        target.textCanvas.width = 32 * scale;
        target.textCanvas.height = 48 * scale;
        target.textCtx = target.textCanvas.getContext('2d');
        target._textCanvasScale = scale;
    }
    return target.textCtx;
}

const LEVEL_TEXT_SPRITE_CACHE = new Map();
const LEVEL_TEXT_SPRITE_CACHE_MAX = 512;
const UNIT_LEVEL_TEXT_SPRITE_CACHE = new Map();
const UNIT_LEVEL_TEXT_SPRITE_CACHE_MAX = 256;

function _getUiSpriteScale() {
    // Render tiny text/glyph sprites at higher internal resolution to reduce color interpolation.
    let dpr = Number(window.devicePixelRatio) || 1;
    return Math.max(1, Math.min(3, Math.round(dpr * 2)));
}

function _trimSpriteCache(cache, maxEntries) {
    if (cache.size <= maxEntries) return;
    let removeCount = cache.size - maxEntries;
    for (let key of cache.keys()) {
        cache.delete(key);
        removeCount--;
        if (removeCount <= 0) break;
    }
}

function _getBuildingLevelTextSprite(label) {
    let txt = String(label || '');
    let scale = _getUiSpriteScale();
    let key = txt + '|' + scale;
    let cached = LEVEL_TEXT_SPRITE_CACHE.get(key);
    if (cached) return cached;

    let width = 32;
    let height = 48;
    let canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    let c = canvas.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.clearRect(0, 0, width, height);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = '700 8px Segoe UI, Arial, sans-serif';
    c.lineJoin = 'round';
    c.strokeStyle = 'rgba(0,0,0,0.95)';
    c.lineWidth = 2;
    c.strokeText(txt, 16, 11);
    c.fillStyle = '#eee';
    c.fillText(txt, 16, 11);

    cached = { canvas, scale };
    LEVEL_TEXT_SPRITE_CACHE.set(key, cached);
    _trimSpriteCache(LEVEL_TEXT_SPRITE_CACHE, LEVEL_TEXT_SPRITE_CACHE_MAX);
    return cached;
}

function _bindBuildingLevelTextSprite(target, label) {
    if (!target) return;
    let sprite = _getBuildingLevelTextSprite(label);
    target.textCanvas = sprite.canvas;
    target.textCtx = null;
    target._textCanvasScale = sprite.scale;
}

function _getUnitLevelTextSprite(label) {
    let txt = String(label || '');
    let scale = _getUiSpriteScale();
    let key = txt + '|' + scale;
    let cached = UNIT_LEVEL_TEXT_SPRITE_CACHE.get(key);
    if (cached) return cached;

    let width = 28;
    let height = 14;
    let canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    let c = canvas.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.setTransform(scale, 0, 0, scale, 0, 0);
    c.clearRect(0, 0, width, height);
    c.font = '700 7px Segoe UI, Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'bottom';
    c.fillStyle = '#ddd';
    c.strokeStyle = 'rgba(0,0,0,0.95)';
    c.lineJoin = 'round';
    c.lineWidth = 1.5;
    c.strokeText(txt, width * 0.5, height - 1);
    c.fillText(txt, width * 0.5, height - 1);

    cached = { canvas, width, height };
    UNIT_LEVEL_TEXT_SPRITE_CACHE.set(key, cached);
    _trimSpriteCache(UNIT_LEVEL_TEXT_SPRITE_CACHE, UNIT_LEVEL_TEXT_SPRITE_CACHE_MAX);
    return cached;
}

// Frame-local drawImage queue: batches by source image to improve sprite cache locality.
let _frameDrawImageQueueActive = false;
let _frameDrawImageQueue = [];
let _frameDrawImageContexts = new Set();
let _frameDrawImageCurrentZ = 0;
let _frameDrawImageFrameId = 0;
let _frameDrawImageIdCounter = 1;
const _frameDrawImageIdBySource = new WeakMap();
const _frameDrawImageCtxStateCache = new WeakMap();

function _setDrawImageTrackedTransform(ctx, a, b, c, d, e, f) {
    ctx.setTransform(a, b, c, d, e, f);
    let st = _frameDrawImageCtxStateCache.get(ctx);
    if (!st) st = {};
    st.frameId = _frameDrawImageFrameId;
    st.ta = a; st.tb = b; st.tc = c; st.td = d; st.te = e; st.tf = f;
    _frameDrawImageCtxStateCache.set(ctx, st);
}

function _captureDrawImageCtxState(ctx) {
    let st = _frameDrawImageCtxStateCache.get(ctx);
    if (!st) st = {};
    if (st.frameId !== _frameDrawImageFrameId ||
        !Number.isFinite(st.ta) || !Number.isFinite(st.tb) || !Number.isFinite(st.tc) ||
        !Number.isFinite(st.td) || !Number.isFinite(st.te) || !Number.isFinite(st.tf)) {
        let t = ctx.getTransform();
        st.frameId = _frameDrawImageFrameId;
        st.ta = t.a;
        st.tb = t.b;
        st.tc = t.c;
        st.td = t.d;
        st.te = t.e;
        st.tf = t.f;
    }
    st.alpha = ctx.globalAlpha;
    st.comp = ctx.globalCompositeOperation;
    st.smooth = ctx.imageSmoothingEnabled;
    st.filter = ctx.filter || 'none';
    _frameDrawImageCtxStateCache.set(ctx, st);
    return st;
}

function beginFrameDrawImageQueue() {
    _frameDrawImageQueueActive = true;
    _frameDrawImageFrameId++;
    _frameDrawImageQueue.length = 0;
    _frameDrawImageContexts.clear();
    _frameDrawImageCurrentZ = 0;
}

function setFrameDrawImageDepth(z) {
    _frameDrawImageCurrentZ = Number.isFinite(z) ? z : 0;
}

function queueDrawImage(ctx, image, a0, a1, a2, a3, a4, a5, a6, a7) {
    if (!ctx || !image) return;
    let argc = arguments.length - 2;

    if (!_frameDrawImageQueueActive) {
        if (argc === 2) ctx.drawImage(image, a0, a1);
        else if (argc === 4) ctx.drawImage(image, a0, a1, a2, a3);
        else if (argc === 8) ctx.drawImage(image, a0, a1, a2, a3, a4, a5, a6, a7);
        else ctx.drawImage(image, a0, a1);
        return;
    }

    _frameDrawImageContexts.add(ctx);

    let imageId = _frameDrawImageIdBySource.get(image);
    if (!imageId) {
        imageId = _frameDrawImageIdCounter++;
        _frameDrawImageIdBySource.set(image, imageId);
    }

    let st = _captureDrawImageCtxState(ctx);
    _frameDrawImageQueue.push({
        ctx,
        image,
        argc,
        a0,
        a1,
        a2,
        a3,
        a4,
        a5,
        a6,
        a7,
        z: _frameDrawImageCurrentZ,
        imageId,
        ta: st.ta,
        tb: st.tb,
        tc: st.tc,
        td: st.td,
        te: st.te,
        tf: st.tf,
        alpha: st.alpha,
        comp: st.comp,
        smooth: st.smooth,
        filter: st.filter
    });
}

function flushFrameDrawImageQueue() {
    if (!_frameDrawImageQueueActive) return;
    if (_frameDrawImageQueue.length <= 0) {
        _frameDrawImageQueueActive = false;
        return;
    }

    let bucketsByZ = new Map();
    let zOrder = [];
    for (let cmd of _frameDrawImageQueue) {
        let zKey = cmd.z;
        if (!bucketsByZ.has(zKey)) {
            bucketsByZ.set(zKey, []);
            zOrder.push(zKey);
        }
        bucketsByZ.get(zKey).push(cmd);
    }
    zOrder.sort((a, b) => b - a); // Furthest/highest z first, closest last.

    let liveStateByCtx = new Map();
    let layerStateByCtx = new Map();
    for (let c of _frameDrawImageContexts) c.save();
    let layerContextsToRestore = [];
    for (let z of zOrder) {
        let layerCtx = renderer3dLayerContexts.get(z);
        if (layerCtx) {
            layerCtx.save();
            layerContextsToRestore.push(layerCtx);
        }
        let imageBuckets = new Map();
        let imageOrder = [];
        let zCmds = bucketsByZ.get(z);
        for (let cmd of zCmds) {
            let id = cmd.imageId;
            if (!imageBuckets.has(id)) {
                imageBuckets.set(id, []);
                imageOrder.push(id);
            }
            imageBuckets.get(id).push(cmd);
        }

        for (let id of imageOrder) {
            let cmds = imageBuckets.get(id);
            for (let cmd of cmds) {
                let replayToContext = (targetCtx, stateMap) => {
                    if (!targetCtx) return;
                    let s = stateMap.get(targetCtx);
                    if (!s || s.ta !== cmd.ta || s.tb !== cmd.tb || s.tc !== cmd.tc || s.td !== cmd.td || s.te !== cmd.te || s.tf !== cmd.tf) {
                        targetCtx.setTransform(cmd.ta, cmd.tb, cmd.tc, cmd.td, cmd.te, cmd.tf);
                        if (!s) s = {};
                        s.ta = cmd.ta; s.tb = cmd.tb; s.tc = cmd.tc; s.td = cmd.td; s.te = cmd.te; s.tf = cmd.tf;
                    }
                    if (!s || s.alpha !== cmd.alpha) {
                        targetCtx.globalAlpha = cmd.alpha;
                        if (!s) s = {};
                        s.alpha = cmd.alpha;
                    }
                    if (!s || s.comp !== cmd.comp) {
                        targetCtx.globalCompositeOperation = cmd.comp;
                        if (!s) s = {};
                        s.comp = cmd.comp;
                    }
                    if (!s || s.smooth !== cmd.smooth) {
                        targetCtx.imageSmoothingEnabled = cmd.smooth;
                        if (!s) s = {};
                        s.smooth = cmd.smooth;
                    }
                    if (!s || s.filter !== cmd.filter) {
                        targetCtx.filter = cmd.filter;
                        if (!s) s = {};
                        s.filter = cmd.filter;
                    }
                    stateMap.set(targetCtx, s);

                    if (cmd.argc === 2) targetCtx.drawImage(cmd.image, cmd.a0, cmd.a1);
                    else if (cmd.argc === 4) targetCtx.drawImage(cmd.image, cmd.a0, cmd.a1, cmd.a2, cmd.a3);
                    else if (cmd.argc === 8) targetCtx.drawImage(cmd.image, cmd.a0, cmd.a1, cmd.a2, cmd.a3, cmd.a4, cmd.a5, cmd.a6, cmd.a7);
                    else targetCtx.drawImage(cmd.image, cmd.a0, cmd.a1);
                };

                replayToContext(cmd.ctx, liveStateByCtx);
                if (layerCtx) {
                    replayToContext(layerCtx, layerStateByCtx);
                    let stats = renderer3dLayerStats.get(z);
                    if (stats) stats.commandCount++;
                }
            }
        }
    }

    for (let c of _frameDrawImageContexts) c.restore();
    for (let c of layerContextsToRestore) c.restore();

    _frameDrawImageQueue.length = 0;
    _frameDrawImageContexts.clear();
    _frameDrawImageQueueActive = false;
}

function ensureRenderer3DLayerCanvas(z) {
    let dpr = window.devicePixelRatio || 1;
    let width = Math.max(1, Math.floor(viewW * dpr));
    let height = Math.max(1, Math.floor(viewH * dpr));
    let layerCanvas = renderer3dLayerCanvases.get(z);
    let layerCtx = renderer3dLayerContexts.get(z);
    if (!layerCanvas || layerCanvas.width !== width || layerCanvas.height !== height) {
        layerCanvas = document.createElement('canvas');
        layerCanvas.width = width;
        layerCanvas.height = height;
        layerCtx = layerCanvas.getContext('2d');
        layerCtx.imageSmoothingEnabled = false;
        renderer3dLayerCanvases.set(z, layerCanvas);
        renderer3dLayerContexts.set(z, layerCtx);
    }
    return { canvas: layerCanvas, ctx: layerCtx };
}

function beginRenderer3DLayerCapture() {
    for (let config of renderer3dLayerConfigs) {
        let layer = ensureRenderer3DLayerCanvas(config.z);
        layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
        layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
        layer.ctx.globalAlpha = 1;
        layer.ctx.globalCompositeOperation = 'source-over';
        layer.ctx.filter = 'none';
        layer.ctx.imageSmoothingEnabled = false;
        renderer3dLayerStats.set(config.z, { commandCount: 0 });
    }
}

function build3DLayerFrameData() {
    let layers = [];
    if (bgCanvas) {
        layers.push({
            key: 'background',
            canvas: bgCanvas,
            slices: 1,
            thickness: 0.02,
            opacity: 1
        });
    } else {
        let fallbackBackground = renderer3dLayerCanvases.get(DRAW_Z_BACKGROUND);
        if (fallbackBackground) {
            layers.push({
                key: 'background',
                canvas: fallbackBackground,
                slices: 1,
                thickness: 0.02,
                opacity: 1
            });
        }
    }

    for (let config of renderer3dLayerConfigs) {
        if (config.z === DRAW_Z_BACKGROUND && bgCanvas) continue;
        let stats = renderer3dLayerStats.get(config.z);
        let canvasForLayer = renderer3dLayerCanvases.get(config.z);
        if (!canvasForLayer || !stats || stats.commandCount <= 0) continue;
        layers.push({
            key: config.key,
            canvas: canvasForLayer,
            slices: config.slices,
            thickness: config.thickness,
            opacity: config.opacity
        });
    }

    if (layers.length <= 0) return null;
    return {
        layers,
        viewportWidth: viewW,
        viewportHeight: viewH,
        camera: {
            zoom: camera.zoom
        }
    };
}

function drawLevelTextCache(ctx, target, x, y) {
    if (!target || !target.textCanvas || !target._textCanvasScale) return;
    let dx = Math.round(x - 16);
    let dy = Math.round(y - 24);
    queueDrawImage(ctx, target.textCanvas, dx, dy, 32, 48);
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

function updateItemTextCache(item) {
    let label = getLevelLabelText(item);
    _bindBuildingLevelTextSprite(item, label);
}

// ============================================================
// TOWER CLASS
// ============================================================
class Tower {
    constructor(gx, gy, type, owner, startStacks = 1) {
        this.gx = gx; this.gy = gy; this.type = type; this.owner = owner;
        this.x = gx * TILE + 16; this.y = gy * TILE + 16;
        this.stacks = startStacks;
        this.manualStacks = startStacks;
        this.effectiveStacks = startStacks;
        this.level = stackCountToLevel(this.stacks);
        this.effectiveLevel = this.level;
        this.isStacking = false;
        this.stackingWorkDone = 0;
        this.baseStats = BASE_CARD_TYPES[type];
        this.currentStats = { ...this.baseStats };

        // ENERGY
        let baseEnergy = calculateItemStats(type, this.level, owner).maxEnergy;
        this.maxEnergy = baseEnergy;
        this.energy = baseEnergy;

        this.textCtx = null;
        this.updateTextCache();
        this.updateStats();
        this.cd = 0; this.angle = 0;
        this.connectedLasers = [];
        this.laserState = 0; this.laserTimer = 0;
        this.markedForSalvage = false;
        this.autoUpgradeEnabled = true;
        this.buildEnabled = true;
        this.preferredTarget = null;
        this.preferredTargetSpec = null;
    }

    upgrade() {
        addManualStackToThing(this, 1);
    }

    updateTextCache() {
        let label = getLevelLabelText(this);
        _bindBuildingLevelTextSprite(this, label);
    }

    updateStats() {
        let effLevel = getThingEffectiveLevel(this);
        this.currentStats = this.calcStats(effLevel);

        let newmaxEnergy = getBuildingStatForOwner(this.owner, this.type, effLevel, 'maxEnergy');
        if (!Number.isFinite(newmaxEnergy)) newmaxEnergy = this.maxEnergy || 1;
        newmaxEnergy = Math.max(1, Math.floor(newmaxEnergy));
        if (this.isUpgrading && this.upgrademaxEnergy > 0) {
            this.maxEnergy = Math.max(1, Math.floor(this.upgrademaxEnergy));
            if (!Number.isFinite(this.energy) || this.energy < 1) this.energy = 1;
            this.energy = Math.min(this.energy, this.maxEnergy);
        } else {
            let ratio = this.maxEnergy > 0 ? this.energy / this.maxEnergy : 1;
            this.maxEnergy = newmaxEnergy;
            this.energy = Math.floor(newmaxEnergy * ratio);
        }
        this.updateTextCache();
    }

    calcStats(lvl) {
        let s = { ...this.baseStats };
        let effLvl = Math.max(1, clampThingLevel(lvl));
        let dmg = getBuildingStatForOwner(this.owner, this.type, effLvl, 'damage');
        let blastDamage = getBuildingStatForOwner(this.owner, this.type, effLvl, 'blastDamage');
        let blastRadius = getBuildingStatForOwner(this.owner, this.type, effLvl, 'blastRadius');
        let cd = getBuildingStatForOwner(this.owner, this.type, effLvl, 'cd');
        let vr = getBuildingStatForOwner(this.owner, this.type, effLvl, 'visionRange');
        if (Number.isFinite(dmg)) s.damage = dmg;
        if (Number.isFinite(blastDamage)) s.blastDamage = blastDamage;
        if (Number.isFinite(blastRadius)) s.blastRadius = Math.max(0, blastRadius);
        if (Number.isFinite(cd)) s.cd = Math.max(0.15, cd);
        if (Number.isFinite(vr)) s.visionRange = vr;
        return s;
    }

    update() {
        if (this.energy <= 0) return;
        tickStatusEffects(this);
        if (this.energy <= 0) return;
        if (this.underConstruction) return;
        if (this.type.startsWith('cloud')) return;

        if (this.type === 'laser') {
            this.laserState = 0;
            for (let other of this.connectedLasers) {
                if (this.gx < other.gx || (this.gx === other.gx && this.gy < other.gy)) {
                    let dmg = this.currentStats.damage + other.currentStats.damage;
                    let sx = this.x, sy = this.y, ex = other.x, ey = other.y;
                    let isVert = (this.gx === other.gx);
                    let mn = isVert ? Math.min(sy, ey) : Math.min(sx, ex);
                    let mx = isVert ? Math.max(sy, ey) : Math.max(sx, ex);
                    let hitAny = false;
                    let nearUnits = getUnitsInRange((sx + ex) / 2, (sy + ey) / 2, Math.max(Math.abs(ex - sx), Math.abs(ey - sy)) / 2 + TILE);
                    for (let u of nearUnits) {
                        if (u.owner === this.owner) continue;
                        if (u.turretImmune) continue;
                        let hit = false;
                        if (isVert) { hit = Math.abs(u.x - sx) < u.r + 4 && u.y >= mn && u.y <= mx; }
                        else { hit = Math.abs(u.y - sy) < u.r + 4 && u.x >= mn && u.x <= mx; }
                        if (hit) {
                            hitAny = true;
                            if (gameTime % 40 === 0) playSound('laser_tick', (this.x + other.x) / 2, (this.y + other.y) / 2);
                            if (u.laserResistant) { if (gameTime % 10 === 0) createExplosion(u.x, u.y, "#888", 1); }
                            else {
                                let prevEnergy = u.energy;
                                u.energy -= dmg / 60;
                                pushHostileDamageAlert(u, prevEnergy - u.energy, this.owner);
                                if (gameTime % 10 === 0) createExplosion(u.x, u.y, "#f00", 1);
                                if (u.energy <= 0 && !u.dead) { u.dead = true; }
                            }
                        }
                    }
                    // Check Buildings
                    for (let list of [towers, barracks, collectorSpawners]) {
                        for (let b of list) {
                            if (b.owner === this.owner || b.energy <= 0) continue;
                            let hit = false;
                            if (isVert) { hit = Math.abs(b.x - sx) < 18 && b.y >= mn && b.y <= mx; }
                            else { hit = Math.abs(b.y - sy) < 18 && b.x >= mn && b.x <= mx; }
                            if (hit) {
                                hitAny = true;
                                let prevEnergy = b.energy;
                                b.energy -= dmg / 60;
                                pushHostileDamageAlert(b, prevEnergy - b.energy, this.owner);
                                if (gameTime % 10 === 0) createExplosion(b.x, b.y, "#f84", 1);
                                if (b.energy <= 0) destroyBuilding(b);
                            }
                        }
                    }
                    if (hitAny) this.laserState = 1;
                }
            }
            return;
        }

        if (this.cd > 0) { this.cd--; return; }
        this.shoot();
    }

    shoot() {
        if (this.cd > 0) return;
        let rangePx = this.currentStats.visionRange * TILE;
        let preferredTarget = getTowerPreferredTargetInRange(this, rangePx);
        if (preferredTarget) {
            let target = preferredTarget;
            projectiles.push(new Projectile(this.x, this.y, target, this.type, this.currentStats.damage, getThingEffectiveLevel(this), this, rangePx, this.currentStats.blastDamage, this.currentStats.blastRadius));
            this.cd = secondsToTicks(this.currentStats.cd || 1.5);
            this.angle = Math.atan2(target.y - this.y, target.x - this.x);
            createExplosion(this.x + Math.cos(this.angle) * 12, this.y + Math.sin(this.angle) * 12, '#fff', 2);
            if (this.owner === localPlayerId || true) {
                let sndType = 'shoot_' + this.type;
                if (!['shoot_pistol', 'shoot_smg', 'shoot_fire', 'shoot_water', 'shoot_poison', 'shoot_ice', 'shoot_sand_gun', 'shoot_elements'].includes(sndType))
                    sndType = 'shoot_generic';
                if (this.owner === localPlayerId) playSound(sndType, this.x, this.y);
                else if (Math.random() < 0.3) playSound(sndType, this.x, this.y);
            }
            return;
        }
        let bestPrimary = null, bestSecondary = null, bestImmune = null;
        let dPrimary = rangePx, dSecondary = rangePx, dImmune = rangePx;

        forEachUnitInRange(this.x, this.y, rangePx, (u, d2) => {
            if (u.turretImmune) return;
            let d = Math.sqrt(d2);

            let immune = (this.type === 'fire' && u.fireResistant) || (this.type === 'water' && u.waterResistant) ||
                (this.type === 'poison' && u.poisonResistant) || (this.type === 'ice' && u.iceResistant) ||
                (this.type === 'elements' && (u.waterResistant || u.fireResistant || u.poisonResistant || u.iceResistant));

            if (immune) { if (d < dImmune) { dImmune = d; bestImmune = u; } }
            else {
                let affected = false;
                if (this.type === 'fire') affected = u.burning > 0;
                else if (this.type === 'poison') affected = u.poisoned > 0;
                else if (this.type === 'water') affected = u.wet > 0;
                else if (this.type === 'ice') affected = u.frozen > 0;
                else if (this.type === 'sand_gun') affected = u.sandy > 0;
                else if (this.type === 'watch_tower') affected = u.watched > 0;
                if (!affected) { if (d < dPrimary) { dPrimary = d; bestPrimary = u; } }
                else { if (d < dSecondary) { dSecondary = d; bestSecondary = u; } }
            }
        }, { enemyOfPlayer: this.owner });

        let target = bestPrimary || bestSecondary || bestImmune;

        // If no unit target, try closest enemy building
        if (!target) {
            // Auto-find nearest enemy building: towers first, then barracks/spawners
            let bestDist = rangePx;
            this.cd = secondsToTicks(this.currentStats.cd || 1.5);
            for (let t of towers) {
                if (t === this || t.owner === this.owner || t.energy <= 0) continue;
                let d = Math.hypot(t.x - this.x, t.y - this.y);
                if (d < bestDist) { bestDist = d; target = t; }
            }
            // Try barracks and spawners (lower priority, only if no tower found)
            if (!target) {
                for (let b of barracks) {
                    if (b.owner === this.owner || b.energy <= 0) continue;
                    let d = Math.hypot(b.x - this.x, b.y - this.y);
                    if (d < bestDist) { bestDist = d; target = b; }
                }
                for (let s of collectorSpawners) {
                    if (s.owner === this.owner || s.energy <= 0) continue;
                    let d = Math.hypot(s.x - this.x, s.y - this.y);
                    if (d < bestDist) { bestDist = d; target = s; }
                }
            }
        }

        if (target) {
            projectiles.push(new Projectile(this.x, this.y, target, this.type, this.currentStats.damage, getThingEffectiveLevel(this), this, rangePx, this.currentStats.blastDamage, this.currentStats.blastRadius));
            this.cd = secondsToTicks(this.currentStats.cd || 1.5);
            this.angle = Math.atan2(target.y - this.y, target.x - this.x);
            createExplosion(this.x + Math.cos(this.angle) * 12, this.y + Math.sin(this.angle) * 12, '#fff', 2);
            if (this.owner === localPlayerId || true) {
                let sndType = 'shoot_' + this.type;
                if (!['shoot_pistol', 'shoot_smg', 'shoot_fire', 'shoot_water', 'shoot_poison', 'shoot_ice', 'shoot_sand_gun', 'shoot_elements'].includes(sndType))
                    sndType = 'shoot_generic';
                if (this.owner === localPlayerId) playSound(sndType, this.x, this.y);
                else if (Math.random() < 0.3) playSound(sndType, this.x, this.y); // sparsify enemy turret sounds
            }
        }
    }

    draw(ctx) {
        // Owner color border
        ctx.strokeStyle = PLAYER_COLORS[this.owner];
        ctx.lineWidth = 1;
        ctx.strokeRect(this.x - 15, this.y - 15, 30, 30);

        // Under construction overlay
        if (this.underConstruction || this.isUpgrading) {
            let isUpg = this.isUpgrading;
            if (!isUpg) {
                ctx.fillStyle = '#333'; ctx.fillRect(this.x - 14, this.y - 14, 28, 28);
                ctx.globalAlpha = 0.35;
                drawTowerIcon(ctx, this.x, this.y, this.baseStats.color, 0, this.level, this.type, false);
                ctx.globalAlpha = 1;
            } else {
                if (this.type === 'laser') {
                    if (this.laserState === 1) {
                        ctx.strokeStyle = '#f00'; ctx.lineWidth = 4;
                        ctx.shadowColor = '#f00'; ctx.shadowBlur = 10;
                        for (let other of this.connectedLasers) {
                            if (this.gx < other.gx || (this.gx === other.gx && this.gy < other.gy)) {
                                ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(other.x, other.y); ctx.stroke();
                            }
                        }
                        ctx.shadowBlur = 0; ctx.lineWidth = 1;
                    }
                    drawTowerIcon(ctx, this.x, this.y, this.baseStats.color, 0, Math.max(1, this.level - 1), this.type, this.connectedLasers.length > 0);
                } else {
                    drawTowerIcon(ctx, this.x, this.y, this.baseStats.color, this.angle, Math.max(1, this.level - 1), this.type);
                }
                ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(this.x - 14, this.y - 14, 28, 28);
            }
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 11, 20, 3);
            if (!isUpg) return;
        } else {
            if (this.type === 'laser') {
                if (this.laserState === 1) {
                    ctx.strokeStyle = '#f00'; ctx.lineWidth = 4;
                    ctx.shadowColor = '#f00'; ctx.shadowBlur = 10;
                    for (let other of this.connectedLasers) {
                        if (this.gx < other.gx || (this.gx === other.gx && this.gy < other.gy)) {
                            ctx.beginPath(); ctx.moveTo(this.x, this.y); ctx.lineTo(other.x, other.y); ctx.stroke();
                        }
                    }
                    ctx.shadowBlur = 0; ctx.lineWidth = 1;
                }
                drawTowerIcon(ctx, this.x, this.y, this.baseStats.color, 0, this.level, this.type, this.connectedLasers.length > 0);
            } else {
                drawTowerIcon(ctx, this.x, this.y, this.baseStats.color, this.angle, this.level, this.type);
            }
        }
        if (shouldShowBuildingLevels()) drawLevelTextCache(ctx, this, this.x, this.y);

        // Energy bar (single bar for damage/progress)
        if (!this.underConstruction && !this.isUpgrading) {
            drawBuildingEnergyProgressBar(ctx, this, this.x, this.y + 14, 24, 3);
        }
    }
}

// ============================================================
// PROJECTILE CLASS
// ============================================================
class Projectile {
    constructor(x, y, t, type, dmg, level, source, maxRange, blastDamage = NaN, blastRadius = NaN) {
        this.x = x; this.y = y; this.prevX = x; this.prevY = y; this.type = type; this.speed = 8; this.life = 100;
        this.startX = x; this.startY = y; this.maxRange = maxRange || 9999;
        let a = Math.atan2(t.y - y, t.x - x);
        this.vx = Math.cos(a) * 8; this.vy = Math.sin(a) * 8;
        this.dmg = dmg; this.level = level;
        this.blastDamage = Number.isFinite(blastDamage) ? Math.max(0, blastDamage) : NaN;
        this.blastRadius = Number.isFinite(blastRadius) ? Math.max(0, blastRadius) : NaN;
        this.sourceOwner = source ? source.owner : -1;
        this.sx = source ? source.gx : -1;
        this.sy = source ? source.gy : -1;
    }
    update() {
        this.x += this.vx; this.y += this.vy;
        this.life--;

        let checkHits = () => {
            if (forEachUnitInRange(this.x, this.y, 16, (u) => {
                let hitRange = u.r + 8;
                let dx = u.x - this.x, dy = u.y - this.y;
                if (dx * dx + dy * dy <= hitRange * hitRange) {
                    this.hit(u);
                    return true;
                }
            }, { enemyOfPlayer: this.sourceOwner })) return true;
            for (let list of [towers, barracks, collectorSpawners]) {
                for (let b of list) {
                    if (b.owner === this.sourceOwner || b.energy <= 0) continue;
                    if (Math.hypot(b.x - this.x, b.y - this.y) <= 18) { this.hitBuilding(b); return true; }
                }
            }
            return false;
        };

        if (checkHits()) return false;
        if (Math.hypot(this.x - this.startX, this.y - this.startY) >= this.maxRange || this.life <= 0) return false;
        return true;
    }
    hit(t) {
        if (t.turretImmune) { createExplosion(t.x, t.y, "#888", 3); return; }
        let targetEnergyBefore = t.energy;
        let baseDmg = this.dmg;
        let splashDmg = Number.isFinite(this.blastDamage) ? this.blastDamage : baseDmg;
        let splashRadiusPx = Math.max(0, (Number.isFinite(this.blastRadius) ? this.blastRadius : (64 / TILE)) * TILE);
        let hasBlast = Number.isFinite(this.blastDamage) && this.blastDamage > 0 && Number.isFinite(this.blastRadius) && this.blastRadius > 0;
        if (this.type === 'fire') {
            applyStatusEffect(t, 'fire', this.level || 1, baseDmg * 0.05, this.sourceOwner, this.type);
            if (!t.fireResistant) { t.energy -= this.dmg; }
            let radius = 12 + this.level * 4;
            createExplosion(this.x, this.y, "orange", Math.min(radius, 20));
        } else if (this.type === 'ice') {
            applyStatusEffect(t, 'ice', this.level || 1, baseDmg * 0.2, this.sourceOwner, this.type);
            if (!t.iceResistant) t.energy -= this.dmg;
        } else if (this.type === 'elements') {
            applyStatusEffect(t, 'poison', this.level || 1, baseDmg * 0.2, this.sourceOwner, this.type);
            applyStatusEffect(t, 'fire', this.level || 1, baseDmg * 0.2, this.sourceOwner, this.type);
            applyStatusEffect(t, 'water', this.level || 1, 0, this.sourceOwner, this.type);
            applyStatusEffect(t, 'ice', this.level || 1, baseDmg * 0.2, this.sourceOwner, this.type);
            applyStatusEffect(t, 'sand', this.level || 1, 0, this.sourceOwner, this.type);
            if (!t.poisonResistant && !t.fireResistant && !t.waterResistant && !t.iceResistant) {
                // extra direct damage is handled below by projectile damage model
            }
        } else if (this.type === 'water') {
            applyStatusEffect(t, 'water', this.level || 1, 0, this.sourceOwner, this.type);
            if (!t.waterResistant) t.energy -= this.dmg;
            createExplosion(this.x, this.y, "#4af", 4);
        } else if (this.type === 'poison') {
            applyStatusEffect(t, 'poison', this.level || 1, baseDmg * 0.1, this.sourceOwner, this.type);
            if (!t.poisonResistant) t.energy -= this.dmg;
        } else if (this.type === 'sand_gun') {
            applyStatusEffect(t, 'sand', this.level || 1, 0, this.sourceOwner, this.type);
            if (!t.sandResistant) { t.energy -= this.dmg; createExplosion(this.x, this.y, "#c96", 4); }
        } else if (this.type === 'watch_tower') {
            applyStatusEffect(t, 'watch', this.level || 1, 0, this.sourceOwner, this.type);
            if (this.dmg > 0) t.energy -= this.dmg;
            createExplosion(this.x, this.y, "#fd0", 3);
        } else {
            t.energy -= this.dmg;
            createExplosion(this.x, this.y, "#fff", 4);
        }

        pushHostileDamageAlert(t, targetEnergyBefore - t.energy, this.sourceOwner);

        if (hasBlast) {
            forEachUnitInRange(this.x, this.y, splashRadiusPx, (e) => {
                if (e === t || e.turretImmune) return;
                let prevEnergy = e.energy;
                e.energy -= splashDmg;
                pushHostileDamageAlert(e, prevEnergy - e.energy, this.sourceOwner);
                if (this.type === 'fire') applyStatusEffect(e, 'fire', this.level || 1, splashDmg * 0.05, this.sourceOwner, this.type);
                if (e.energy <= 0 && !e.dead) e.dead = true;
            }, { enemyOfPlayer: this.sourceOwner });
        }
        if (t.energy <= 0 && !t.dead) { t.dead = true; createExplosion(t.x, t.y, "#e44", 6); }
    }
    hitBuilding(b) {
        let buildingEnergyBefore = b.energy;
        // Apply damage to a building (tower, barrack, spawner)
        let actualDmg = this.dmg;
        if (this.type === 'fire' || this.type === 'ice' || this.type === 'poison' || this.type === 'water' || this.type === 'sand_gun' || this.type === 'elements') {
            actualDmg += (this.level * 2); // Elements apply burst damage to buildings
        }

        if (this.type === 'watch_tower') {
            applyStatusEffect(b, 'watch', this.level || 1, 0, this.sourceOwner, this.type);
        } else if (this.type === 'fire') {
            applyStatusEffect(b, 'fire', this.level || 1, this.dmg * 0.05, this.sourceOwner, this.type);
            if (!isEffectImmune(b, 'fire')) b.energy -= actualDmg;
        } else if (this.type === 'poison') {
            applyStatusEffect(b, 'poison', this.level || 1, this.dmg * 0.1, this.sourceOwner, this.type);
            if (!isEffectImmune(b, 'poison')) b.energy -= actualDmg;
        } else if (this.type === 'water') {
            applyStatusEffect(b, 'water', this.level || 1, 0, this.sourceOwner, this.type);
            if (!isEffectImmune(b, 'water')) b.energy -= actualDmg;
        } else if (this.type === 'ice') {
            applyStatusEffect(b, 'ice', this.level || 1, this.dmg * 0.2, this.sourceOwner, this.type);
            if (!isEffectImmune(b, 'ice')) b.energy -= actualDmg;
        } else if (this.type === 'sand_gun') {
            applyStatusEffect(b, 'sand', this.level || 1, 0, this.sourceOwner, this.type);
            if (!isEffectImmune(b, 'sand')) b.energy -= actualDmg;
        } else if (this.type === 'elements') {
            let appliedAny = false;
            appliedAny = applyStatusEffect(b, 'fire', this.level || 1, this.dmg * 0.2, this.sourceOwner, this.type) || appliedAny;
            appliedAny = applyStatusEffect(b, 'poison', this.level || 1, this.dmg * 0.2, this.sourceOwner, this.type) || appliedAny;
            appliedAny = applyStatusEffect(b, 'water', this.level || 1, 0, this.sourceOwner, this.type) || appliedAny;
            appliedAny = applyStatusEffect(b, 'ice', this.level || 1, this.dmg * 0.2, this.sourceOwner, this.type) || appliedAny;
            appliedAny = applyStatusEffect(b, 'sand', this.level || 1, 0, this.sourceOwner, this.type) || appliedAny;
            if (appliedAny) b.energy -= actualDmg;
        } else {
            b.energy -= actualDmg;
        }

        pushHostileDamageAlert(b, buildingEnergyBefore - b.energy, this.sourceOwner);

        createExplosion(this.x, this.y, "#f84", 4);
        if (b.energy <= 0) { createExplosion(b.x, b.y, "#e44", 8); destroyBuilding(b); }
    }
    draw(ctx) {
        ctx.fillStyle = BASE_CARD_TYPES[this.type] ? BASE_CARD_TYPES[this.type].color : '#fff';
        ctx.beginPath(); ctx.arc(this.x, this.y, 4, 0, 6.28); ctx.fill();
    }
}

// ============================================================
// PARTICLE CLASS
// ============================================================
class Particle {
    constructor(x, y, color) {
        this.x = x; this.y = y; this.prevX = x; this.prevY = y; this.color = color;
        let r = visualRng || rng;
        let a = r() * 6.28, s = r() * 3;
        this.vx = Math.cos(a) * s; this.vy = Math.sin(a) * s;
        this.life = 20 + r() * 15;
    }
    update() { this.prevX = this.x; this.prevY = this.y; this.x += this.vx; this.y += this.vy; this.life--; return this.life > 0; }
    draw(ctx) { ctx.globalAlpha = this.life / 35; ctx.fillStyle = this.color; ctx.fillRect(this.x, this.y, 3, 3); ctx.globalAlpha = 1; }
}
function createExplosion(x, y, c, n) {
    if (particles.length > 500) return;
    for (let i = 0; i < n; i++) particles.push(new Particle(x, y, c));
}
function createDirectedParticles(fromX, fromY, toX, toY, c, n) {
    if (particles.length > 500) return;
    let dx = toX - fromX, dy = toY - fromY;
    let d = Math.hypot(dx, dy) || 1;
    let nx = dx / d, ny = dy / d;
    let r = visualRng || rng;
    for (let i = 0; i < n; i++) {
        let p = new Particle(fromX, fromY, c);
        let spd = 1.5 + r() * 2.5;
        let spread = (r() - 0.5) * 0.6;
        p.vx = (nx + spread * -ny) * spd;
        p.vy = (ny + spread * nx) * spd;
        p.life = 12 + r() * 10;
        particles.push(p);
    }
}

// ============================================================
// UNIT CLASS
// ============================================================
const CMD_IDLE = 0, CMD_MOVING = 1, CMD_ATTACK_MOVING = 2, CMD_ATTACKING = 3, CMD_HOLDING = 4;

class Unit {
    constructor(unitType, owner, x, y) {
        this.id = nextUnitId++;
        this.unitType = unitType;
        this.owner = owner;
        this.x = x; this.y = y;
        this.prevX = x; this.prevY = y;
        this.teleportHideTicks = 0;

        let s = BASE_UNIT_STATS[unitType] || BASE_UNIT_STATS.norm;
        this.energy = s.energy; this.maxEnergy = s.energy;
        this.speed = s.speed;
        this.attackDamage = s.atk;
        this.attackRange = s.attackRange * TILE;
        this.visionRange = s.visionRange || 4;
        this.attackCooldown = secondsToTicks(s.atkCd);
        this.attackTimer = 0;
        this.color = s.color; this.r = s.r;
        this.collisionR = Number.isFinite(s.collisionR) ? s.collisionR : this.r;
        this.vis = s.vis || 'circle';
        this.isFlying = s.isFlying || false;
        this.turretImmune = s.turretImmune || false;
        this.isSnake = s.isSnake || false;
        this.snakeMaxHistory = s.snakeMaxHistory || 0;
        this.poisonResistant = s.poisonResistant || false;
        this.fireResistant = s.fireResistant || false;
        this.waterResistant = s.waterResistant || false;
        this.iceResistant = s.iceResistant || false;
        this.laserResistant = s.laserResistant || false;
        this.sandResistant = s.sandResistant || false;
        this.attackStyle = s.attackStyle || 'melee';
        this.isKing = (unitType === 'king');
        this.attackTarget = null; // visual: current attack target for draw effects
        this.attackFlash = 0; // visual: flash timer for attack animation

        this.commandState = CMD_IDLE;
        this.targetUnit = null;
        this.targetBuilding = null;
        this.targetPos = null;
        this.path = null;
        this.pathIndex = 0;
        this.forcedAttackTarget = false;
        this._forcedTargetLastSeenX = null;
        this._forcedTargetLastSeenY = null;
        this.dead = false;
        this.unitLevel = 1;
        this.stackCount = 1;
        this.effectiveStacks = 1;
        this.effectiveLevel = 1;

        this.baseEnergy = this.maxEnergy;
        this.baseAttackDamage = this.attackDamage;
        this.baseSpeed = this.speed;
        this.baseAttackCooldown = this.attackCooldown;
        this.baseVisionRange = this.visionRange;
        this.baseAttackRange = this.attackRange / TILE;

        this.baseLevel = 1;
        this.baseLevelmaxEnergy = this.maxEnergy;
        this.baseLevelAttackDamage = this.attackDamage;
        this.baseLevelAttackCooldown = this.attackCooldown;
        this.baseLevelSpeed = this.speed;
        this.baseLevelVisionRange = this.visionRange;
        this.baseLevelGatherPerTrip = 0;
        this.baseLevelBuilderDps = 0;
        this.baseLevelhealerDps = 0;

        // Status effects
        this.poisoned = 0; this.poisonTickDamage = 0;
        this.burning = 0; this.burnTickDamage = 0;
        this.frozen = 0; this.iceTickDamage = 0;
        this.wet = 0; this.sandy = 0; this.watched = 0;
        this.vx = 0; this.vy = 0;
        this.workerTransferCooldown = 0;

        // Snake
        if (this.isSnake) { this.snakeHistory = []; this.snakeRecordTimer = 0; }

        this._spatialKey = undefined;
        updateUnitSpatial(this);
    }

    getCollisionLayer() {
        if (this.isFlying) return 'air';
        if (this.unitType === 'mole') return 'mole';
        return 'ground';
    }

    getCollisionRadius() {
        return Math.max(0.1, Number(this.collisionR) || Number(this.r) || 0.1);
    }

    pickScoutDestination() {
        if (Number.isFinite(this._nextScoutRetargetTick) && gameTime < this._nextScoutRetargetTick) return;
        let ugx = Math.floor(this.x / TILE), ugy = Math.floor(this.y / TILE);
        let rgx = Math.floor((typeof rng === 'function' ? rng() : Math.random()) * GRID_W);
        let rgy = Math.floor((typeof rng === 'function' ? rng() : Math.random()) * GRID_H);
        rgx = Math.max(0, Math.min(GRID_W - 1, rgx));
        rgy = Math.max(0, Math.min(GRID_H - 1, rgy));
        this._scoutTarget = { gx: rgx, gy: rgy };
        if (_canUsePathfindRequestBudget(this.owner)) {
            _consumePathfindRequestBudget(this.owner);
            this.path = _findPathForUnitTagged('scout_ai', this, ugx, ugy, rgx, rgy, true, null, this.owner);
            this.pathIndex = (this.path && this.path.length > 1 && this.path[0].x === ugx && this.path[0].y === ugy) ? 1 : 0;
        } else {
            this.path = _makeFallbackPathForUnit(this, ugx, ugy, rgx, rgy, CMD_MOVING, 'scout_ai');
            this.pathIndex = (this.path && this.path.length > 1 && this.path[0].x === ugx && this.path[0].y === ugy) ? 1 : 0;
        }
        this._nextScoutRetargetTick = gameTime + Math.max(8, Math.floor(TICK_RATE * 0.5));
        this.commandState = CMD_MOVING;
    }

    update() {
        if (this.dead) return;

        if (this.teleportHideTicks > 0) this.teleportHideTicks--;

        // Status effects tick
        if (this.burning > 0) {
            this.burning--;
            if (this.burnTickDamage > 0) this.energy -= this.burnTickDamage;
        }
        if (this.poisoned > 0) {
            this.poisoned--;
            if (this.poisonTickDamage > 0) this.energy -= this.poisonTickDamage;
        }
        if (this.frozen > 0 && this.wet > 0 && this.iceTickDamage > 0) {
            this.energy -= this.iceTickDamage * 1.5;
        }
        if (this.frozen > 0) this.frozen--;
        if (this.wet > 0) this.wet--;
        if (this.sandy > 0) this.sandy--;
        if (this.watched > 0) this.watched--;

        if (this.energy <= 0) { this.dead = true; return; }

        // Floor item interaction
        let gx = Math.floor(this.x / TILE), gy = Math.floor(this.y / TILE);
        if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H) {
            let cell = grid[gy][gx];
            if (cell.item && cell.owner !== this.owner && !cell.item.underConstruction) {
                let item = cell.item;
                let itemLevel = getThingEffectiveLevel(item, stackCountToLevel(item.stacks || 1));
                if (item.type === 'sand') {
                    applyStatusEffect(this, 'sand', itemLevel, 0, item.owner, item.type);
                }
                else if (item.type === 'lava') {
                    applyStatusEffect(this, 'fire', itemLevel, item.damage || 1, item.owner, item.type);
                }
                else if (item.type === 'poison_puddle') {
                    applyStatusEffect(this, 'poison', itemLevel, item.damage || 1, item.owner, item.type);
                }
                else if (item.type === 'ice_patch') {
                    applyStatusEffect(this, 'ice', itemLevel, item.damage || 1, item.owner, item.type);
                }
                else if (item.type === 'water_puddle') {
                    applyStatusEffect(this, 'water', itemLevel, 0, item.owner, item.type);
                }
                else if (item.type === 'mine') {
                    let blastDamage = getBuildingStatForOwner(item.owner, 'mine', itemLevel, 'blastDamage');
                    if (!Number.isFinite(blastDamage) || blastDamage <= 0) blastDamage = Number(item.damage) || 135;
                    let blastRadiusTiles = getBuildingStatForOwner(item.owner, 'mine', itemLevel, 'blastRadius');
                    if (!Number.isFinite(blastRadiusTiles) || blastRadiusTiles <= 0) blastRadiusTiles = 1.2;
                    let blastRadiusPx = Math.max(0, blastRadiusTiles * TILE);

                    forEachUnitInRange(this.x, this.y, blastRadiusPx, (u) => {
                        if (!u) return;
                        let prevEnergy = u.energy;
                        u.energy -= blastDamage;
                        pushHostileDamageAlert(u, prevEnergy - u.energy, item.owner);
                        if (u.energy <= 0 && !u.dead) u.dead = true;
                    }, { enemyOfPlayer: item.owner });

                    createExplosion(this.x, this.y, "#f80", 15);
                    playSound('mine_explode', this.x, this.y);
                    clearTileEntity(cell.item.gx, cell.item.gy, cell.item);
                    cell.item = null;
                    if (this.energy <= 0) this.dead = true;
                    return;
                }
            }
        }

        // Speed modifier
        let spd = this.speed;
        if (this.frozen > 0) spd *= 0.5;
        if (this.sandy > 0) spd *= 0.5;

        // Snake history
        if (this.isSnake) {
            this.snakeRecordTimer++;
            if (this.snakeRecordTimer >= 3) {
                this.snakeRecordTimer = 0;
                this.snakeHistory.unshift({ x: this.x, y: this.y });
                if (this.snakeHistory.length > this.snakeMaxHistory) this.snakeHistory.pop();
            }
        }

        // Attack timer
        if (this.attackTimer > 0) this.attackTimer--;
        if (this.attackFlash > 0) this.attackFlash--;

        // Worker AI (collector/salvager units)
        if (this.workerState) {
            updateWorkerAI(this);
            // Workers still follow paths via the normal system
        }

        // State machine
        switch (this.commandState) {
            case CMD_IDLE: if (!this.workerState) this.doIdle(spd); break;
            case CMD_MOVING: this.doMoving(spd); break;
            case CMD_ATTACK_MOVING: this.doAttackMoving(spd); break;
            case CMD_ATTACKING: this.doAttacking(spd); break;
            case CMD_HOLDING: this.doHolding(); break;
        }
        // Separation from nearby units (staggered to reduce per-tick cost spikes).
        let collisionInterval = getUnitCollisionRecalcTicks();
        let hadUnitCollision = false;
        if (collisionInterval <= 1 || ((gameTime + this.id) % collisionInterval) === 0) {
            let selfCollisionR = this.getCollisionRadius();
            let sepRange = selfCollisionR * 2;
            let pushX = 0, pushY = 0;
            let myLayer = this.getCollisionLayer();
            forEachUnitInRange(this.x, this.y, sepRange, (other, d2, dx, dy) => {
                if (other === this || other.dead) return;
                if (other.getCollisionLayer() !== myLayer) return;
                dx = -dx; dy = -dy;
                let d = Math.sqrt(Math.max(0, d2));
                let minDist = selfCollisionR + other.getCollisionRadius();
                if (d < minDist) {
                    hadUnitCollision = true;
                    let nx = 0, ny = 0;
                    if (d > 0.001) {
                        nx = dx / d;
                        ny = dy / d;
                    } else {
                        // Exact overlap fallback: use current movement direction (no random/id jitter).
                        let mdx = this.vx, mdy = this.vy;
                        if (Math.hypot(mdx, mdy) < 0.001 && this.path && this.pathIndex < this.path.length) {
                            let pn = this.path[this.pathIndex];
                            mdx = pn.x * TILE + 16 - this.x;
                            mdy = pn.y * TILE + 16 - this.y;
                        }
                        if (Math.abs(mdx) >= Math.abs(mdy)) {
                            nx = mdx >= 0 ? 0 : 0;
                            ny = mdx >= 0 ? -1 : 1;
                        } else {
                            nx = mdy >= 0 ? 1 : -1;
                            ny = 0;
                        }
                    }
                    let force = (minDist - Math.max(d, 0.001)) * 0.3;
                    pushX += nx * force;
                    pushY += ny * force;
                }
            });
            if (pushX !== 0 || pushY !== 0) {
                this.x += pushX; this.y += pushY;
                // Clamp to walkable area
                let ngx = Math.floor(this.x / TILE), ngy = Math.floor(this.y / TILE);
                if (!this.isFlying && !canUnitOccupyTile(this, ngx, ngy)) {
                    this.x -= pushX; this.y -= pushY;
                    hadUnitCollision = true;
                }
            }
        }
        if (hadUnitCollision && this.pathIsFallbackAstar && this._pendingPathTarget) {
            _tryUpgradeAstarFallbackPath(this);
        }
        pushUnitOutOfBlockedTile(this);
        updateUnitSpatial(this);
    }

    doIdle(spd) {
        if (this.unitType === 'scout') {
            this.pickScoutDestination();
            return;
        }
        // Auto-aggro nearby enemies
        let aggroRange = this.visionRange * TILE;
        let closest = _findClosestEnemyUnitByChunks(this.owner, this.x, this.y, aggroRange);
        if (closest) {
            this.targetUnit = closest;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
            return;
        }
        // Priority for structures: towers -> barracks/spawners -> floor items.
        let closestTower = null, closestTowerD = aggroRange;
        for (let t of towers) {
            if (t.owner === this.owner || t.energy <= 0) continue;
            let d = Math.hypot(t.x - this.x, t.y - this.y);
            if (d < closestTowerD) { closestTowerD = d; closestTower = t; }
        }
        if (closestTower) {
            this.targetBuilding = closestTower;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
            return;
        }

        let closestStruct = null, closestStructD = aggroRange;
        let scanStructList = (list) => {
            for (let b of list) {
                if (b.owner === this.owner || b.energy <= 0) continue;
                let d = Math.hypot(b.x - this.x, b.y - this.y);
                if (d < closestStructD) { closestStructD = d; closestStruct = b; }
            }
        };
        scanStructList(barracks);
        scanStructList(collectorSpawners);
        if (closestStruct) {
            this.targetBuilding = closestStruct;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
            return;
        }

        let rTiles = Math.ceil(aggroRange / TILE) + 1;
        let ugx = Math.floor(this.x / TILE), ugy = Math.floor(this.y / TILE);
        let minGx = Math.max(0, ugx - rTiles), maxGx = Math.min(GRID_W - 1, ugx + rTiles);
        let minGy = Math.max(0, ugy - rTiles), maxGy = Math.min(GRID_H - 1, ugy + rTiles);
        let closestItem = null, closestItemD = aggroRange;
        for (let gy = minGy; gy <= maxGy; gy++) {
            for (let gx = minGx; gx <= maxGx; gx++) {
                let cell = grid[gy][gx];
                if (!cell || !cell.item || cell.owner === this.owner) continue;
                let item = cell.item;
                if (item.energy <= 0 || item.underConstruction) continue;
                let d = Math.hypot(item.x - this.x, item.y - this.y);
                if (d < closestItemD) { closestItemD = d; closestItem = item; }
            }
        }
        if (closestItem) {
            this.targetBuilding = closestItem;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
        }
    }

    doMoving(spd) {
        if (this.unitType === 'scout') {
            if (this.path && this.pathIndex < this.path.length) {
                if (this.followPath(spd)) {
                    this.path = null;
                    this.commandState = CMD_IDLE;
                }
            } else if (this._scoutTarget) {
                let tx = this._scoutTarget.gx * TILE + 16;
                let ty = this._scoutTarget.gy * TILE + 16;
                let dx = tx - this.x, dy = ty - this.y;
                let dist = Math.hypot(dx, dy) || 1;
                if (dist <= Math.max(4, spd)) {
                    this.commandState = CMD_IDLE;
                } else {
                    this.x += (dx / dist) * spd;
                    this.y += (dy / dist) * spd;
                }
            } else {
                this.commandState = CMD_IDLE;
            }
            return;
        }
        if ((!this.path || this.pathIndex >= this.path.length) && this._pendingPathTarget && this._pendingPathTarget.cmd === CMD_MOVING) {
            if (this.pathIsFallbackAstar) _tryUpgradeAstarFallbackPath(this);
            // Keep move command active while waiting for deferred pathfinding.
            return;
        }
        if (this.followPath(spd)) {
            if (this._pendingPathTarget && this._pendingPathTarget.cmd === CMD_MOVING) {
                this.path = null;
                return;
            }
            this.commandState = CMD_IDLE;
            this.path = null;
        }
    }

    doAttackMoving(spd) {
        // Check for nearby enemies first
        let aggroRange = this.visionRange * TILE;
        let closest = _findClosestEnemyUnitByChunks(this.owner, this.x, this.y, aggroRange);
        if (closest) {
            this.targetUnit = closest;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
            return;
        }
        let closestTower = null, closestTowerD = aggroRange;
        for (let t of towers) {
            if (t.owner === this.owner || t.energy <= 0) continue;
            let d = Math.hypot(t.x - this.x, t.y - this.y);
            if (d < closestTowerD) { closestTowerD = d; closestTower = t; }
        }
        if (closestTower) {
            this.targetBuilding = closestTower;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
            return;
        }

        let closestStruct = null, closestStructD = aggroRange;
        let scanStructList = (list) => {
            for (let b of list) {
                if (b.owner === this.owner || b.energy <= 0) continue;
                let d = Math.hypot(b.x - this.x, b.y - this.y);
                if (d < closestStructD) { closestStructD = d; closestStruct = b; }
            }
        };
        scanStructList(barracks);
        scanStructList(collectorSpawners);
        if (closestStruct) {
            this.targetBuilding = closestStruct;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
            return;
        }

        let rTiles = Math.ceil(aggroRange / TILE) + 1;
        let ugx = Math.floor(this.x / TILE), ugy = Math.floor(this.y / TILE);
        let minGx = Math.max(0, ugx - rTiles), maxGx = Math.min(GRID_W - 1, ugx + rTiles);
        let minGy = Math.max(0, ugy - rTiles), maxGy = Math.min(GRID_H - 1, ugy + rTiles);
        let closestItem = null, closestItemD = aggroRange;
        for (let gy = minGy; gy <= maxGy; gy++) {
            for (let gx = minGx; gx <= maxGx; gx++) {
                let cell = grid[gy][gx];
                if (!cell || !cell.item || cell.owner === this.owner) continue;
                let item = cell.item;
                if (item.energy <= 0 || item.underConstruction) continue;
                let d = Math.hypot(item.x - this.x, item.y - this.y);
                if (d < closestItemD) { closestItemD = d; closestItem = item; }
            }
        }
        if (closestItem) {
            this.targetBuilding = closestItem;
            this.forcedAttackTarget = false;
            this.commandState = CMD_ATTACKING;
            return;
        }
        if ((!this.path || this.pathIndex >= this.path.length) && this._pendingPathTarget && this._pendingPathTarget.cmd === CMD_ATTACK_MOVING) {
            if (this.pathIsFallbackAstar) _tryUpgradeAstarFallbackPath(this);
            // Keep attack-move active while waiting for deferred pathfinding.
            return;
        }
        if (this.followPath(spd)) {
            if (this._pendingPathTarget && this._pendingPathTarget.cmd === CMD_ATTACK_MOVING) {
                this.path = null;
                return;
            }
            this.commandState = CMD_IDLE;
            this.path = null;
        }
    }

    _performAttackOnUnit(target) {
        let targetEnergyBefore = target.energy;
        target.energy -= this.attackDamage;
        pushHostileDamageAlert(target, targetEnergyBefore - target.energy, this.owner);
        this.attackTimer = this.attackCooldown;
        this.attackTarget = target;
        this.attackFlash = 8;
        let style = this.attackStyle;
        if (style === 'fire') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#f50', 3);
            target.burning = Math.max(target.burning, 45);
            target.burnTickDamage = Math.max(target.burnTickDamage, this.attackDamage * 0.04);
        } else if (style === 'water') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#4af', 3);
            target.wet = Math.max(target.wet, 60);
        } else if (style === 'ice') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#afe', 3);
            target.frozen = Math.max(target.frozen, 40);
        } else if (style === 'poison') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#2d2', 3);
            target.poisoned = Math.max(target.poisoned, 50);
            target.poisonTickDamage = Math.max(target.poisonTickDamage, this.attackDamage * 0.04);
        } else if (style === 'laser') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#f0f', 2);
        } else if (style === 'swoop') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#dd0', 2);
        } else if (style === 'ram') {
            createDirectedParticles(this.x, this.y, target.x, target.y, '#0f0', 3);
            createDirectedParticles(target.x, target.y, this.x, this.y, '#f00', 2);
            this.energy -= this.maxEnergy * 0.03;
            if (this.energy <= 0) { this.dead = true; }
        } else {
            // Default melee
            createDirectedParticles(this.x, this.y, target.x, target.y, '#f88', 2);
        }
        if (target.energy <= 0) { target.dead = true; return true; }
        return false;
    }

    _performAttackOnBuilding(tb) {
        let buildingEnergyBefore = tb.energy;
        this.attackTimer = this.attackCooldown;
        this.attackTarget = tb;
        this.attackFlash = 8;
        let style = this.attackStyle;
        if (style === 'fire') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#f50', 3);
            applyStatusEffect(tb, 'fire', getUnitBaseLevel(this), this.attackDamage * 0.04);
            if (!isEffectImmune(tb, 'fire')) tb.energy -= this.attackDamage;
        } else if (style === 'water') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#4af', 3);
            applyStatusEffect(tb, 'water', getUnitBaseLevel(this));
            if (!isEffectImmune(tb, 'water')) tb.energy -= this.attackDamage;
        } else if (style === 'ice') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#afe', 3);
            applyStatusEffect(tb, 'ice', getUnitBaseLevel(this), this.attackDamage * 0.2);
            if (!isEffectImmune(tb, 'ice')) tb.energy -= this.attackDamage;
        } else if (style === 'poison') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#2d2', 3);
            applyStatusEffect(tb, 'poison', getUnitBaseLevel(this), this.attackDamage * 0.04);
            if (!isEffectImmune(tb, 'poison')) tb.energy -= this.attackDamage;
        } else if (style === 'laser') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#f0f', 2);
            tb.energy -= this.attackDamage;
        } else if (style === 'swoop') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#dd0', 2);
            tb.energy -= this.attackDamage;
        } else if (style === 'ram') {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#0f0', 3);
            createDirectedParticles(tb.x, tb.y, this.x, this.y, '#f00', 2);
            tb.energy -= this.attackDamage;
            this.energy -= this.maxEnergy * 0.03;
            if (this.energy <= 0) { this.dead = true; }
        } else {
            createDirectedParticles(this.x, this.y, tb.x, tb.y, '#f88', 2);
            tb.energy -= this.attackDamage;
        }
        pushHostileDamageAlert(tb, buildingEnergyBefore - tb.energy, this.owner);
        if (tb.energy <= 0) { destroyBuilding(tb); return true; }
        return false;
    }

    doAttacking(spd) {
        // Attack unit target
        if (this.targetUnit) {
            if (this.targetUnit.dead) { this.targetUnit = null; this.attackTarget = null; this.forcedAttackTarget = false; this.commandState = CMD_IDLE; return; }
            let tgx = Math.floor(this.targetUnit.x / TILE), tgy = Math.floor(this.targetUnit.y / TILE);
            let targetVisible = isGameplayTargetVisibleToPlayer(this.owner, tgx, tgy);
            if (!targetVisible) {
                if (this.forcedAttackTarget) {
                    let lockX = Number.isFinite(this._forcedTargetLastSeenX) ? this._forcedTargetLastSeenX : this.targetUnit.x;
                    let lockY = Number.isFinite(this._forcedTargetLastSeenY) ? this._forcedTargetLastSeenY : this.targetUnit.y;
                    this.targetUnit = null;
                    this.attackTarget = null;
                    this.forcedAttackTarget = false;
                    this.path = null;
                    this.pathIndex = 0;
                    this._pendingPathTarget = null;
                    if (Number.isFinite(lockX) && Number.isFinite(lockY)) {
                        let ugx = Math.floor(this.x / TILE), ugy = Math.floor(this.y / TILE);
                        let lgx = Math.floor(lockX / TILE), lgy = Math.floor(lockY / TILE);
                        let dest = findNearestWalkable(lgx, lgy, ugx, ugy, this);
                        if (_canUsePathfindRequestBudget(this.owner)) {
                            _consumePathfindRequestBudget(this.owner);
                            this.path = _findPathForUnitTagged('ai_combat', this, ugx, ugy, dest.x, dest.y, this.isFlying, null, this.owner);
                            this.pathIndex = (this.path && this.path.length > 1 && this.path[0].x === ugx && this.path[0].y === ugy) ? 1 : 0;
                        } else {
                            this.path = _makeFallbackPathForUnit(this, ugx, ugy, dest.x, dest.y, CMD_MOVING, 'ai_combat');
                            this.pathIndex = (this.path && this.path.length > 1 && this.path[0].x === ugx && this.path[0].y === ugy) ? 1 : 0;
                        }
                        this.commandState = CMD_MOVING;
                    } else {
                        this.commandState = CMD_IDLE;
                    }
                    return;
                } else {
                    this.targetUnit = null;
                    this.attackTarget = null;
                    this.path = null;
                    this.pathIndex = 0;
                    this._pendingPathTarget = null;
                    this.forcedAttackTarget = false;
                    this.commandState = CMD_IDLE;
                    return;
                }
            }
            if (this.forcedAttackTarget) {
                this._forcedTargetLastSeenX = this.targetUnit.x;
                this._forcedTargetLastSeenY = this.targetUnit.y;
            }
            let d = Math.hypot(this.targetUnit.x - this.x, this.targetUnit.y - this.y);
            if (d <= this.attackRange + this.r + this.targetUnit.r) {
                this.attackTarget = this.targetUnit;
                this.path = null;
                // In range - attack
                if (this.attackTimer <= 0) {
                    if (this._performAttackOnUnit(this.targetUnit)) {
                        this.targetUnit = null; this.attackTarget = null; this.forcedAttackTarget = false; this.commandState = CMD_IDLE;
                    }
                }
            } else if (!this.forcedAttackTarget && d > 8 * TILE) {
                // Leash
                this.targetUnit = null; this.attackTarget = null; this.path = null; this.forcedAttackTarget = false; this.commandState = CMD_IDLE;
            } else {
                // Move toward target using path if available, direct if close
                if (this.path && this.pathIndex < this.path.length) {
                    this.followPath(spd);
                } else if (d < 2 * TILE || this.isFlying) {
                    // Close enough or flying - direct move
                    let dx = this.targetUnit.x - this.x, dy = this.targetUnit.y - this.y;
                    let dist = Math.hypot(dx, dy);
                    this.x += (dx / dist) * spd; this.y += (dy / dist) * spd;
                } else {
                    // Need a new path toward target
                    let tgx = Math.floor(this.targetUnit.x / TILE), tgy = Math.floor(this.targetUnit.y / TILE);
                    let ugx = Math.floor(this.x / TILE), ugy = Math.floor(this.y / TILE);
                    if (_canUsePathfindRequestBudget(this.owner)) {
                        _consumePathfindRequestBudget(this.owner);
                        let dest = findNearestWalkable(tgx, tgy, ugx, ugy, this);
                        this.path = _findPathForUnitTagged('ai_combat', this, ugx, ugy, dest.x, dest.y, this.isFlying, null, this.owner);
                        this.pathIndex = (this.path && this.path.length > 1 && this.path[0].x === ugx && this.path[0].y === ugy) ? 1 : 0;
                    } else {
                        let dest = findNearestWalkable(tgx, tgy, ugx, ugy, this);
                        this.path = _makeFallbackPathForUnit(this, ugx, ugy, dest.x, dest.y, CMD_ATTACKING, 'ai_combat');
                        this.pathIndex = (this.path && this.path.length > 1 && this.path[0].x === ugx && this.path[0].y === ugy) ? 1 : 0;
                    }
                }
            }
            return;
        }
        // Attack building target
        if (this.targetBuilding) {
            let tb = this.targetBuilding;
            if (tb.energy <= 0) { this.targetBuilding = null; this.attackTarget = null; this.forcedAttackTarget = false; this.commandState = CMD_IDLE; return; }
            let d = Math.hypot(tb.x - this.x, tb.y - this.y);
            if (d <= this.attackRange + this.r + 16) {
                this.attackTarget = tb;
                this.path = null;
                if (this.attackTimer <= 0) {
                    if (this._performAttackOnBuilding(tb)) {
                        this.targetBuilding = null; this.attackTarget = null; this.forcedAttackTarget = false; this.commandState = CMD_IDLE;
                    }
                }
            } else {
                if (this.path && this.pathIndex < this.path.length) {
                    this.followPath(spd);
                } else if (d < 2 * TILE || this.isFlying) {
                    let dx = tb.x - this.x, dy = tb.y - this.y;
                    let dist = Math.hypot(dx, dy);
                    this.x += (dx / dist) * spd; this.y += (dy / dist) * spd;
                } else {
                    let tgx = Math.floor(tb.x / TILE), tgy = Math.floor(tb.y / TILE);
                    let ugx = Math.floor(this.x / TILE), ugy = Math.floor(this.y / TILE);
                    if (_canUsePathfindRequestBudget(this.owner)) {
                        _consumePathfindRequestBudget(this.owner);
                        let dest = findNearestWalkable(tgx, tgy, ugx, ugy, this);
                        this.path = _findPathForUnitTagged('ai_combat', this, ugx, ugy, dest.x, dest.y, this.isFlying, null, this.owner);
                        this.pathIndex = (this.path && this.path.length > 1 && this.path[0].x === ugx && this.path[0].y === ugy) ? 1 : 0;
                    } else {
                        let dest = findNearestWalkable(tgx, tgy, ugx, ugy, this);
                        this.path = _makeFallbackPathForUnit(this, ugx, ugy, dest.x, dest.y, CMD_ATTACKING, 'ai_combat');
                        this.pathIndex = (this.path && this.path.length > 1 && this.path[0].x === ugx && this.path[0].y === ugy) ? 1 : 0;
                    }
                }
            }
            return;
        }
        this.attackTarget = null;
        this.forcedAttackTarget = false;
        this.commandState = CMD_IDLE;
    }

    doHolding() {
        forEachUnitInRange(this.x, this.y, this.attackRange, (u) => {
            let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
            if (!isGameplayTargetVisibleToPlayer(this.owner, ugx, ugy)) return;
            if (this.attackTimer <= 0) {
                this._performAttackOnUnit(u);
                return true;
            }
        }, { enemyOfPlayer: this.owner });
    }

    followPath(spd) {
        if (!this.path || this.pathIndex >= this.path.length) return true;

        // Consume stale nodes first so we never steer back toward an already-reached tile center.
        while (this.path && this.pathIndex < this.path.length) {
            let curNode = this.path[this.pathIndex];
            let ugx = Math.floor(this.x / TILE), ugy = Math.floor(this.y / TILE);
            if (curNode.x !== ugx || curNode.y !== ugy) break;

            let nextNodeInTile = this.path[this.pathIndex + 1];
            if (nextNodeInTile && isCloudPortalLink(curNode.x, curNode.y, nextNodeInTile.x, nextNodeInTile.y, this.owner)) {
                if (!_tryConsumeAstarMoveCost(this, 1)) return false;
                let laneOffsetNow = Math.max(1.5, Math.min(4, this.r * 0.6));
                let nTx = nextNodeInTile.x * TILE + 16;
                let nTy = nextNodeInTile.y * TILE + 16;
                let postNodeNow = this.path[this.pathIndex + 2] || null;
                let linkDxNow = postNodeNow ? (postNodeNow.x - nextNodeInTile.x) : (nextNodeInTile.x - curNode.x);
                let linkDyNow = postNodeNow ? (postNodeNow.y - nextNodeInTile.y) : (nextNodeInTile.y - curNode.y);
                if (Math.abs(linkDxNow) >= Math.abs(linkDyNow)) {
                    nTy += (linkDxNow < 0 ? laneOffsetNow : -laneOffsetNow);
                } else {
                    nTx += (linkDyNow < 0 ? -laneOffsetNow : laneOffsetNow);
                }
                this.x = nTx;
                this.y = nTy;
                this.teleportHideTicks = Math.max(this.teleportHideTicks, 2);
                this.pathIndex += 2;
            } else {
                if (this.pathIndex > 0 && !_tryConsumeAstarMoveCost(this, 1)) return false;
                this.pathIndex++;
            }

            if (this.pathIndex >= this.path.length) return true;
        }
        if (!this.path || this.pathIndex >= this.path.length) return true;

        let node = this.path[this.pathIndex];
        if (!this.pathIsFallbackAstar && !this.isFlying && !canUnitOccupyTile(this, node.x, node.y)) {
            this.path = null;
            this.pathIndex = 0;
            if (this.pathIsFallbackAstar && this._pendingPathTarget) {
                _tryUpgradeAstarFallbackPath(this);
            }
            if (this._pendingPathTarget) {
                this.commandState = this._pendingPathTarget.cmd;
            }
            return true;
        }
        let laneOffset = Math.max(1.5, Math.min(4, this.r * 0.6));
        let baseTx = node.x * TILE + 16;
        let baseTy = node.y * TILE + 16;
        let tx = baseTx;
        let ty = baseTy;

        // Use path-segment direction (stable) instead of live position delta (can flip/jitter).
        let segDx = 0, segDy = 0;
        if (this.pathIndex > 0) {
            let prevNode = this.path[this.pathIndex - 1];
            segDx = node.x - prevNode.x;
            segDy = node.y - prevNode.y;
        } else if (this.pathIndex + 1 < this.path.length) {
            let nextNodeForDir = this.path[this.pathIndex + 1];
            segDx = nextNodeForDir.x - node.x;
            segDy = nextNodeForDir.y - node.y;
        }
        if (segDx === 0 && segDy === 0) {
            if (Math.abs(this.vx) >= Math.abs(this.vy)) segDx = (this.vx >= 0 ? 1 : -1);
            else segDy = (this.vy >= 0 ? 1 : -1);
        }

        // Directional lane rule:
        // horizontal: left -> below center, right -> above center
        // vertical: up -> left of center, down -> right of center
        if (Math.abs(segDx) >= Math.abs(segDy)) {
            ty += (segDx < 0 ? laneOffset : -laneOffset);
        } else {
            tx += (segDy < 0 ? -laneOffset : laneOffset);
        }
        let dx = tx - this.x, dy = ty - this.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 4) {
            let nextNode = this.path[this.pathIndex + 1];
            if (nextNode && isCloudPortalLink(node.x, node.y, nextNode.x, nextNode.y, this.owner)) {
                if (!_tryConsumeAstarMoveCost(this, 1)) return false;
                let nTx = nextNode.x * TILE + 16;
                let nTy = nextNode.y * TILE + 16;
                let postNode = this.path[this.pathIndex + 2] || null;
                let linkDx = postNode ? (postNode.x - nextNode.x) : (nextNode.x - node.x);
                let linkDy = postNode ? (postNode.y - nextNode.y) : (nextNode.y - node.y);
                if (Math.abs(linkDx) >= Math.abs(linkDy)) {
                    nTy += (linkDx < 0 ? laneOffset : -laneOffset);
                } else {
                    nTx += (linkDy < 0 ? -laneOffset : laneOffset);
                }
                this.x = nTx;
                this.y = nTy;
                this.teleportHideTicks = Math.max(this.teleportHideTicks, 2);
                this.pathIndex += 2;
                if (this.pathIndex >= this.path.length) return true;
                return false;
            }
            if (this.pathIndex > 0 && !_tryConsumeAstarMoveCost(this, 1)) return false;
            this.pathIndex++;
            if (this.pathIndex >= this.path.length) return true;
            return false;
        }
        this.vx = (dx / dist) * spd; this.vy = (dy / dist) * spd;
        this.x += this.vx; this.y += this.vy;
        return false;
    }

    draw(ctx) {
        if (this.dead || this.teleportHideTicks > 0) return;
        // Unit body
        let strokeColor = '#000', lw = 1;
        if (this.burning > 0) strokeColor = '#f50';
        else if (this.poisoned > 0) strokeColor = '#2d2';
        else if (this.frozen > 0 && this.wet > 0) strokeColor = '#fff';
        else if (this.frozen > 0) strokeColor = '#afe';
        else if (this.wet > 0) strokeColor = '#4af';
        if (this.burning > 0 || this.poisoned > 0 || this.frozen > 0 || this.wet > 0) lw = 2;

        if (this.isSnake && this.snakeHistory.length > 0) {
            ctx.save();
            ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = this.r * 2;
            ctx.strokeStyle = this.color;
            ctx.beginPath(); ctx.moveTo(this.x, this.y);
            for (let p of this.snakeHistory) ctx.lineTo(p.x, p.y);
            ctx.stroke();
            ctx.fillStyle = this.color;
            ctx.beginPath(); ctx.arc(this.x, this.y, this.r + 2, 0, 6.28); ctx.fill();
            ctx.fillStyle = "black";
            ctx.beginPath(); ctx.arc(this.x - 2, this.y - 2, 2, 0, 6.28); ctx.fill();
            ctx.beginPath(); ctx.arc(this.x + 2, this.y - 2, 2, 0, 6.28); ctx.fill();
            ctx.restore();
        } else if (this.vis === 'triangle') {
            ctx.fillStyle = this.color; ctx.beginPath();
            let tr = this.r * 0.5;
            ctx.moveTo(this.x, this.y + tr); ctx.lineTo(this.x - tr, this.y - tr); ctx.lineTo(this.x + tr, this.y - tr);
            ctx.closePath(); ctx.fill(); ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
        } else if (this.vis === 'star') {
            if (this.unitType === 'collector' || this.unitType === 'astar_collector') {
                ctx.save();
                ctx.font = `${Math.round(this.r * 2.4)}px Arial`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = this.unitType === 'collector' ? '#ffd34d' : (this.carryingValue > 0 ? '#f4f4f4' : '#9aa0a6');
                ctx.fillText(this.unitType === 'collector' ? '⭐' : (this.carryingValue > 0 ? '★' : '☆'), this.x, this.y + 1);
                ctx.restore();
            } else {
                drawCachedUnitStar(ctx, this.x, this.y, this.r, this.color, strokeColor, lw);
            }
        } else if (this.vis === 'triangle_down') {
            ctx.fillStyle = this.color; ctx.beginPath();
            let tr = this.r;
            ctx.moveTo(this.x, this.y + tr); ctx.lineTo(this.x - tr, this.y - tr * 0.5); ctx.lineTo(this.x + tr, this.y - tr * 0.5);
            ctx.closePath(); ctx.fill(); ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
        } else if (this.vis === 'mole') {
            ctx.fillStyle = this.color; ctx.beginPath();
            ctx.ellipse(this.x, this.y, this.r * 0.8, this.r * 1.1, 0, 0, Math.PI * 2);
            ctx.fill(); ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
        } else if (this.vis === 'rect') {
            let rr = this.r;
            ctx.fillStyle = this.color; ctx.fillRect(this.x - rr, this.y - rr * 0.7, rr * 2, rr * 1.4);
            ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.strokeRect(this.x - rr, this.y - rr * 0.7, rr * 2, rr * 1.4);
            if (this.unitType === 'researcher_unit') {
                ctx.fillStyle = '#5af';
                ctx.fillRect(this.x - rr * 0.3, this.y - rr * 0.35, rr * 0.6, rr * 0.7);
                ctx.strokeStyle = '#93f';
                ctx.lineWidth = Math.max(1, lw * 0.8);
                ctx.strokeRect(this.x - rr * 0.3, this.y - rr * 0.35, rr * 0.6, rr * 0.7);
            }
        } else if (this.vis === 'king') {
            let rr = this.r;
            // Crown shape
            ctx.fillStyle = this.color; ctx.beginPath();
            ctx.moveTo(this.x - rr, this.y + rr * 0.4);
            ctx.lineTo(this.x - rr, this.y - rr * 0.2);
            ctx.lineTo(this.x - rr * 0.5, this.y + rr * 0.1);
            ctx.lineTo(this.x, this.y - rr * 0.7);
            ctx.lineTo(this.x + rr * 0.5, this.y + rr * 0.1);
            ctx.lineTo(this.x + rr, this.y - rr * 0.2);
            ctx.lineTo(this.x + rr, this.y + rr * 0.4);
            ctx.closePath(); ctx.fill();
            ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
            // Jewel dots on crown tips
            ctx.fillStyle = '#f00';
            ctx.beginPath(); ctx.arc(this.x - rr, this.y - rr * 0.2, 2, 0, 6.28); ctx.fill();
            ctx.beginPath(); ctx.arc(this.x, this.y - rr * 0.7, 2, 0, 6.28); ctx.fill();
            ctx.beginPath(); ctx.arc(this.x + rr, this.y - rr * 0.2, 2, 0, 6.28); ctx.fill();
        } else {
            ctx.fillStyle = this.color; ctx.beginPath(); ctx.arc(this.x, this.y, this.r, 0, 6.28); ctx.fill();
            ctx.strokeStyle = strokeColor; ctx.lineWidth = lw; ctx.stroke();
        }

        // Owner dot
        ctx.fillStyle = PLAYER_COLORS[this.owner];
        ctx.beginPath(); ctx.arc(this.x, this.y - this.r - 3, 2, 0, 6.28); ctx.fill();

        // Energy bar
        if (this.energy < this.maxEnergy) {
            let bw = this.r * 2 + 4, bh = 2, bx = this.x - bw / 2, by = this.y - this.r - 7;
            ctx.fillStyle = '#600'; ctx.fillRect(bx, by, bw, bh);
            ctx.fillStyle = '#0f0'; ctx.fillRect(bx, by, bw * Math.max(0, this.energy / this.maxEnergy), bh);
        }
        // Attack visual effects
        if (this.attackTarget && this.attackFlash > 0) {
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
                let dx = tx - this.x, dy = ty - this.y, d = Math.hypot(dx, dy);
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
                let dx = tx - this.x, dy = ty - this.y, d = Math.hypot(dx, dy) || 1;
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

        if (shouldShowUnitLevels()) {
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

    if (spawner.type === 'spawner') {
        u.workerState = 'IDLE'; u.workerType = 'collector'; u.carryingValue = 0; _clearWorkerTarget(u);
    } else if (spawner.type === 'astar_spawner') {
        u.workerState = 'IDLE'; u.workerType = 'astar_collector'; u.carryingValue = 0; _clearWorkerTarget(u);
    } else if (spawner.type === 'salvager') {
        u.workerState = 'IDLE'; u.workerType = 'salvager'; u.carryingValue = 0; _clearWorkerTarget(u);
    } else if (spawner.type === 'builder_spawner') {
        u.workerState = 'IDLE'; u.workerType = 'builder'; u.carryingValue = 0; _clearWorkerTarget(u);
        u.builderHasMaterial = false;
    } else if (spawner.type === 'healer_spawner') {
        u.workerState = 'IDLE'; u.workerType = 'healer'; u.carryingValue = 0; _clearWorkerTarget(u);
        u.healerHasMaterial = false;
    } else if (spawner.type === 'research') {
        u.workerState = 'IDLE'; u.workerType = 'researcher'; u.carryingValue = 0; _clearWorkerTarget(u);
        u.researcherHasMaterial = false;
    }

    applyUnitLevelScaling(u, spawnInfo.level);
    u.energy = u.maxEnergy;
    units.push(u);
    players[owner].popCount++;

    let rallyTarget = getSpawnerRallyTargetWorld(spawner);
    if (rallyTarget) {
        let rgx = Math.floor(rallyTarget.x / TILE), rgy = Math.floor(rallyTarget.y / TILE);
        if (_canUsePathfindRequestBudget(u.owner)) {
            _consumePathfindRequestBudget(u.owner);
            let rallyCacheKey = _makeSpawnerRallyTemplateKey(spawner, spawnPos.x, spawnPos.y, rgx, rgy, u);
            let templatedPath = _getSpawnerRallyTemplatePath(rallyCacheKey);
            if (!templatedPath) {
                templatedPath = _findPathForUnitTagged('spawner_rally', u, spawnPos.x, spawnPos.y, rgx, rgy, u.isFlying, getPathCanWalkForUnit(u), u.owner);
                _setSpawnerRallyTemplatePath(rallyCacheKey, templatedPath);
            }
            u.path = templatedPath;
            u.pathIndex = 0;
            if (spawner.type === 'barrack') {
                u.commandState = CMD_ATTACK_MOVING;
            } else {
                u.commandState = CMD_MOVING;
                u.workerState = 'MANUAL_MOVE';
            }
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
        if (this.energy <= 0 || this.underConstruction) return;
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
        if (this.energy <= 0 || this.underConstruction) return;
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
        if (this.energy <= 0 || this.underConstruction) return;
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
        if (this.energy <= 0 || this.underConstruction) return;
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
        if (this.energy <= 0 || this.underConstruction) return;
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
        if (this.energy <= 0 || this.underConstruction) return;
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
        if (this.energy <= 0 || this.underConstruction) return;

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
                if (_isCollectorTargetValid(u.workerTarget, u.workerTargetType, owner)) {
                    _collectorAssignTarget(u, u.workerTarget, u.workerTargetType, myGx, myGy);
                } else {
                    u._lastMineTarget = null;
                    _clearWorkerTarget(u, 'target_no_work');
                    _collectorFindTarget(u, myGx, myGy);
                }
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
                }
                u.carryingValue = 0;
                if (!canRunHeavyAi) return;
                if (_isAstarCollectorTargetValid(u.workerTarget, u.workerTargetType, owner)) {
                    _astarCollectorAssignTarget(u, u.workerTarget, u.workerTargetType);
                } else {
                    u._astarLastMineTarget = null;
                    u._astarLastMineTargetType = null;
                    _clearWorkerTarget(u, 'target_no_work');
                    _astarCollectorFindTarget(u);
                }
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
            if (!u.workerTarget || u.workerTarget.markedForSalvage || (!u.workerTarget.underConstruction && !u.workerTarget.isUpgrading && !u.workerTarget.isStacking) || (u.workerTarget.underConstruction && !isBuildEnabled(u.workerTarget))) {
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
                    }

                    if (didWork) {
                        u.builderHasMaterial = false;
                        u.workerTransferCooldown = getBuilderTransferCooldownTicks(u);
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
            if (!u.workerTarget || u.workerTarget.markedForSalvage || (!u.workerTarget.underConstruction && !u.workerTarget.isUpgrading && !u.workerTarget.isStacking) || (u.workerTarget.underConstruction && !isBuildEnabled(u.workerTarget))) {
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
            if (!u.workerTarget || u.workerTarget.markedForSalvage || (!u.workerTarget.underConstruction && !u.workerTarget.isUpgrading && !u.workerTarget.isStacking) || (u.workerTarget.underConstruction && !isBuildEnabled(u.workerTarget))) {
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
                }
                if (u.builderHasMaterial) u.builderHasMaterial = false;
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
    let maxSearch = _getWorkerAutoSearchDistancePx(u);
    let anchorSpawner = null;
    if (_isCollectorSpawnerValidForUnit(u, u._collectorNextSpawner)) {
        anchorSpawner = u._collectorNextSpawner;
    } else if (_isCollectorSpawnerValidForUnit(u, u._collectorLastDropoffSpawner)) {
        anchorSpawner = u._collectorLastDropoffSpawner;
    } else {
        anchorSpawner = _findClosestSpawner(u, 'spawner');
    }

    let originGx = Math.max(0, Math.min(GRID_W - 1, Math.floor(origin.x / TILE)));
    let originGy = Math.max(0, Math.min(GRID_H - 1, Math.floor(origin.y / TILE)));
    let tileRadius = Math.max(0, Math.ceil(maxSearch / TILE));

    let minX = Math.max(0, originGx - tileRadius);
    let maxX = Math.min(GRID_W - 1, originGx + tileRadius);
    let minY = Math.max(0, originGy - tileRadius);
    let maxY = Math.min(GRID_H - 1, originGy + tileRadius);
    let maxSearchSq = maxSearch * maxSearch;

    let candidates = [];

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            let worldX = x * TILE + TILE * 0.5;
            let worldY = y * TILE + TILE * 0.5;
            let dx = worldX - origin.x;
            let dy = worldY - origin.y;
            let originDistSq = dx * dx + dy * dy;
            if (originDistSq > maxSearchSq) continue;

            let drop = getDroppedItemAt(x, y);
            let mine = getGoldMineAt(x, y);
            let cell = grid[y][x];
            let item = cell && cell.item;

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

            if (!candidate) continue;
            if (!_canAssignWorkerTargetExclusive(u, candidate, candidateType)) continue;

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
        }
    }

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
    return hasActiveGoldMineAt(nx, ny);
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
    let distTiles = getUnitStatForOwner(u.owner, u.unitType, lvl, 'workerSearchDistance');
    if (!Number.isFinite(distTiles) || distTiles <= 0) distTiles = 10;
    return Math.max(TILE, distTiles * TILE);
}

function _getTargetPriorityLevel(target) {
    if (!target) return 1;
    if (target.workerType) return getUnitEffectiveLevel(target, getUnitBaseLevel(target));
    if (Number.isFinite(target.effectiveLevel)) return Math.max(0, Math.floor(target.effectiveLevel));
    if (Number.isFinite(target.level)) return Math.max(0, Math.floor(target.level));
    if (Number.isFinite(target.stacks)) return Math.max(0, stackCountToLevel(target.stacks));
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

function _isBuilderWorkTarget(target, owner, allowDisabledBuild = false) {
    if (!target) return false;
    if (target.owner !== owner) return false;
    if (target.markedForSalvage) return false;
    if (!target.underConstruction && !target.isUpgrading && !target.isStacking) return false;
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
    return hasActiveAstarMineAt(nx, ny);
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
    let maxSearch = _getWorkerAutoSearchDistancePx(u);
    let anchorSpawner =
        (u._astarNextSpawner
            && u._astarNextSpawner.type === 'astar_spawner'
            && u._astarNextSpawner.owner === u.owner
            && u._astarNextSpawner.energy > 0
            && !u._astarNextSpawner.underConstruction)
            ? u._astarNextSpawner
            : _findClosestSpawner(u, 'astar_spawner');

    let originGx = Math.max(0, Math.min(GRID_W - 1, Math.floor(origin.x / TILE)));
    let originGy = Math.max(0, Math.min(GRID_H - 1, Math.floor(origin.y / TILE)));
    let tileRadius = Math.max(0, Math.ceil(maxSearch / TILE));
    let minX = Math.max(0, originGx - tileRadius);
    let maxX = Math.min(GRID_W - 1, originGx + tileRadius);
    let minY = Math.max(0, originGy - tileRadius);
    let maxY = Math.min(GRID_H - 1, originGy + tileRadius);
    let maxSearchSq = maxSearch * maxSearch;

    let candidates = [];

    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            let worldX = x * TILE + TILE * 0.5;
            let worldY = y * TILE + TILE * 0.5;
            let dx = worldX - origin.x;
            let dy = worldY - origin.y;
            let originDistSq = dx * dx + dy * dy;
            if (originDistSq > maxSearchSq) continue;

            let mine = getAstarMineAt(x, y);
            let cell = grid[y][x];
            let item = cell && cell.item;

            let candidate = null;
            let candidateType = null;

            if (mine && mine.astar > 0) {
                candidate = mine;
                candidateType = 'astar_mine';
            } else if (item && item.type === 'astar_farm' && item.owner === u.owner && !item.underConstruction && item.energy > 0) {
                candidate = item;
                candidateType = 'astar_farm';
            }

            if (!candidate) continue;
            if (!_canAssignWorkerTargetExclusive(u, candidate, candidateType)) continue;

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
        }
    }

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
    let bestDist = 99999, bestItem = null;
    let spawnerSet = new Set(collectorSpawners);
    for (let t of towers) { if (t.owner === owner && t.markedForSalvage && _canAssignWorkerTargetExclusive(u, t, null)) { let d = Math.hypot(t.x - u.x, t.y - u.y); if (d > maxSearch) continue; if (d < bestDist) { bestDist = d; bestItem = t; } } }
    for (let b of barracks) { if (b.owner === owner && b.markedForSalvage && _canAssignWorkerTargetExclusive(u, b, null)) { let d = Math.hypot(b.x - u.x, b.y - u.y); if (d > maxSearch) continue; if (d < bestDist) { bestDist = d; bestItem = b; } } }
    for (let s of collectorSpawners) { if (s.owner === owner && s.markedForSalvage && _canAssignWorkerTargetExclusive(u, s, null)) { let d = Math.hypot(s.x - u.x, s.y - u.y); if (d > maxSearch) continue; if (d < bestDist) { bestDist = d; bestItem = s; } } }
    for (let fy = 0; fy < GRID_H; fy++) for (let fx = 0; fx < GRID_W; fx++) { let c = grid[fy][fx]; if (c.item && c.owner === owner && c.item.markedForSalvage && !(c.item instanceof Barrack) && !spawnerSet.has(c.item) && _canAssignWorkerTargetExclusive(u, c.item, null)) { let d = Math.hypot(c.item.x - u.x, c.item.y - u.y); if (d > maxSearch) continue; if (d < bestDist) { bestDist = d; bestItem = c.item; } } }
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
    if (target.energy <= 0 || target.underConstruction) return false;
    if (!isQueueEnabled(target)) return false;
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
        if (!s || s.owner !== owner || s.energy <= 0 || s.underConstruction) return;
        if (!isQueueEnabled(s)) return;
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
    let consider = (s) => {
        if (!_isHealerQueueTarget(s, u.owner)) return;
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
    if (!isAutoResearchEnabled(target) || target.isUpgrading) return false;
    let task = target.researchTask;
    if (!task) {
        task = tryAdvancePlayerResearchTask(owner);
        target.researchTask = task || null;
    }
    if (!task) return false;
    return (task.workDone || 0) < task.workRequired;
}

function _findNearestResearchBuildingNeedingWork(u) {
    let candidates = [];
    let maxSearch = _getWorkerAutoSearchDistancePx(u);
    for (let s of collectorSpawners) {
        if (!_isResearcherTargetBuilding(s, u.owner)) continue;
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
    for (let b of ownedTargets) {
        if (!_isBuilderWorkTarget(b, owner)) continue;
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
                let stats = calculateItemStats(statsType, obj.effectiveLevel, obj.owner);
                if (obj.isUpgrading && obj.upgrademaxEnergy > 0) {
                    obj.maxEnergy = Math.max(1, Math.floor(obj.upgrademaxEnergy));
                    if (!Number.isFinite(obj.energy) || obj.energy < 1) obj.energy = 1;
                    obj.energy = Math.min(obj.energy, obj.maxEnergy);
                    if (stats.damage) obj.damage = stats.damage;
                } else {
                    let ratio = obj.maxEnergy > 0 ? obj.energy / obj.maxEnergy : 1;
                    obj.maxEnergy = stats.maxEnergy;
                    if (stats.damage) obj.damage = stats.damage;
                    obj.energy = obj.maxEnergy * ratio;
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

function getUnitCollisionRecalcTicks() {
    return Math.max(1, Math.min(240, Math.floor(Number(UNIT_COLLISION_RECALC_TICKS) || 1)));
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
            || !Number.isFinite(u.baseLevelVisionRange)
            || !Number.isFinite(u.baseLevelmaxEnergy)
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
            !Number.isFinite(u.baseLevelVisionRange) || !Number.isFinite(u.baseLevelmaxEnergy);

        u.stackCount = baseStacks;
        u.unitLevel = baseLevel;

        if (needsRefresh) {
            applyUnitLevelScaling(u, baseLevel);
            u.stackCount = baseStacks;
        }

        if (!Number.isFinite(u.baseLevelVisionRange)) u.baseLevelVisionRange = Math.max(1, Number(u.visionRange) || 1);
        if (!Number.isFinite(u.baseLevelmaxEnergy)) u.baseLevelmaxEnergy = Math.max(1, Number(u.maxEnergy) || 1);
        if (!Number.isFinite(u.baseLevelAttackDamage)) u.baseLevelAttackDamage = Math.max(0, Number(u.attackDamage) || 0);
        if (!Number.isFinite(u.baseLevelAttackCooldown)) u.baseLevelAttackCooldown = Math.max(1, Number(u.attackCooldown) || 1);
        if (!Number.isFinite(u.baseLevelSpeed)) u.baseLevelSpeed = Math.max(0.1, Number(u.speed) || 0.1);

        u.effectiveStacks = baseStacks;
        u.effectiveLevel = baseLevel;
        dueInfo.push({ u, baseStacks, needsRefresh });
    }

    for (let info of dueInfo) {
        let u = info.u;
        let radiusPx = Math.max(0.5, Number(u.baseLevelVisionRange) || Number(u.visionRange) || 0.5) * TILE;
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

function checkWinCondition() {
    let teams = (activeTeamIds && activeTeamIds.length > 0) ? activeTeamIds : [0, 1];
    let alive = [];
    if (gameMode === 'killking') {
        alive = teams.filter(pid => !resignedTeams.has(pid) && units.some(u => u.owner === pid && u.isKing && !u.dead));
    } else {
        for (let pid of teams) {
            if (isTeamAliveByAssets(pid)) alive.push(pid);
        }
    }

    if (!gameOver && !localDefeated && !alive.includes(localPlayerId)) {
        enterSpectateMode('defeated');
    }

    if (alive.length <= 1 && teams.length > 1) {
        gameOver = true;
        winner = alive.length === 1 ? alive[0] : -1;
        showGameOver();
    }
}

// ============================================================
function _buildDeterministicUnitUpdateOrderForTick() {
    let order = units.slice();
    if (order.length <= 1) return order;
    let s = (((gameTime + 1) * 1664525) + ((order.length + 1) * 1013904223)) >>> 0;
    for (let i = order.length - 1; i > 0; i--) {
        s = ((s * 1664525) + 1013904223) >>> 0;
        let j = s % (i + 1);
        let tmp = order[i];
        order[i] = order[j];
        order[j] = tmp;
    }
    return order;
}



// ============================================================
// GAME TICK
// ============================================================
function gameTick() {
    if (gameOver) return;
    gameTime++;
    _resetPathfindPerfTick();
    _resetPathBudgetTrackingPerTick();

    let floorChanged = false;
    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            let cell = grid[y][x];
            let item = cell.item;
            if (!item) continue;
            if (tickStatusEffects(item)) {
                clearTileEntity(item.gx, item.gy, item);
                cell.item = null;
                cell.owner = -1;
                floorChanged = true;
            }
        }
    }
    if (floorChanged) {
        _minimapStaticDirty = true;
        _requestStaticCacheCommit();
        recalculateAdjacency();
    }

    recomputePlayerPopCaps();

    // Save previous positions for interpolation
    for (let u of units) { u.prevX = u.x; u.prevY = u.y; }
    for (let p of projectiles) { p.prevX = p.x; p.prevY = p.y; }

    // Resolve deferred pathfinding from previous ticks fairly.
    // A rotating cursor prevents early-array units from starving later units.
    if (units.length > 0) {
        let start = pendingPathResolveCursor % units.length;
        let checked = 0;
        let pendingBuckets = [[], [], [], [], []];
        while (checked < units.length) {
            let idx = (start + checked) % units.length;
            checked++;
            let u = units[idx];
            if (u.dead || !u._pendingPathTarget) continue;
            let src = u._pendingPathTarget && u._pendingPathTarget.src;
            let srcTier = Math.max(0, Math.min(4, _pendingPathPriority(src)));
            pendingBuckets[srcTier].push(u);
        }

        for (let srcTier = 0; srcTier <= 4; srcTier++) {
            let pending = pendingBuckets[srcTier];
            for (let i = 0; i < pending.length; i++) {
                let u = pending[i];
                let pt = u && u._pendingPathTarget;
                if (!u || u.dead || !pt) continue;
                if (u.pathIsFallbackAstar) {
                    _tryUpgradeAstarFallbackPath(u);
                    continue;
                }
                if (Number.isFinite(u._astarBudgetRetryTick) && gameTime < u._astarBudgetRetryTick) continue;
                if (!_canUsePathfindRequestBudget(u.owner)) {
                    _markUnitAstarBudgetBlocked(u);
                    continue;
                }

                let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                let dest = findNearestWalkable(pt.gx, pt.gy, ugx, ugy, u);
                let src = pt && pt.src ? pt.src : 'deferred_resolver';
                _consumePathfindRequestBudget(u.owner);
                u.path = _findPathForUnitTagged(src === 'player_commands' ? 'player_commands' : 'deferred_resolver', u, ugx, ugy, dest.x, dest.y, u.isFlying, getPathCanWalkForUnit(u), u.owner);
                if (u.path && u.path.length > 0) {
                    u.pathIndex = (u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                    u.commandState = pt.cmd;
                    u._pendingPathTarget = null;
                } else {
                    _markUnitAstarBudgetBlocked(u, 1);
                }
            }
        }
        pendingPathResolveCursor = (start + checked) % units.length;
    }

    recalculateUnitEffectiveStats();

    // Towers
    for (let t of towers) t.update();

    // Destroy dead towers
    for (let i = towers.length - 1; i >= 0; i--) {
        if (towers[i].energy <= 0) destroyBuilding(towers[i]);
    }

    // Projectiles
    for (let i = projectiles.length - 1; i >= 0; i--) { if (!projectiles[i].update()) projectiles.splice(i, 1); }

    // Units
    // Shuffle unit update order per tick so A* budget contention is shared
    // across different units over time (deterministically for lockstep).
    let unitUpdateOrder = _buildDeterministicUnitUpdateOrderForTick();
    for (let i = 0; i < unitUpdateOrder.length; i++) {
        let u = unitUpdateOrder[i];
        if (!u) continue;
        u.update();
    }

    for (let i = units.length - 1; i >= 0; i--) {
        let u = units[i];
        if (u.dead) {
            if (!u.isKing && !u.workerState) playSound('unit_death', u.x, u.y);
            // Drop energy on death (bounty)
            let cost = BASE_UNIT_STATS[u.unitType] ? BASE_UNIT_STATS[u.unitType].energy * 0.5 : 5;
            let bounty = Math.floor(cost * 0.1);
            if (bounty > 0) {
                let gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE);
                if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H && !getDroppedItemAt(gx, gy)) {
                    let drop = { type: 'energy', value: bounty, gx, gy, x: gx * TILE + 16, y: gy * TILE + 16, timer: TICK_RATE * 120 };
                    addDroppedItem(drop);
                }
            }
            // Release worker lock on target
            _clearWorkerTarget(u);
            if (u.workerTarget && u.workerTarget.lockedBy === u) {
                u.workerTarget.lockedBy = null;
            }
            if (u.isKing) checkWinCondition();
            removeUnitSpatial(u);
            players[u.owner].popCount--;
            selectedUnits = selectedUnits.filter(su => su !== u);
            units.splice(i, 1);
            if (gameOver) return;
        }
    }

    // Barracks
    for (let i = barracks.length - 1; i >= 0; i--) {
        let b = barracks[i];
        if (b.energy <= 0) { destroyBuilding(b); continue; }
        b.update();
    }

    // Collector/Salvager spawners (barrack-like)
    for (let i = collectorSpawners.length - 1; i >= 0; i--) {
        let cs = collectorSpawners[i];
        if (cs.energy <= 0) { destroyBuilding(cs); continue; }
        cs.update();
    }

    processGlobalSpawnerQueue();

    // Dropped items decay
    for (let i = droppedItems.length - 1; i >= 0; i--) {
        droppedItems[i].timer--;
        if (droppedItems[i].timer <= 0) {
            removeDroppedItem(droppedItems[i]);
        }
    }

    // Particles
    for (let i = particles.length - 1; i >= 0; i--) { if (!particles[i].update()) particles.splice(i, 1); }

    // Laser buzzer sound control
    let anyLaserActive = false;
    for (let t of towers) { if (t.type === 'laser' && t.laserState === 1 && !t.underConstruction) { anyLaserActive = true; break; } }
    if (anyLaserActive) startLaserSound();
    else stopLaserSound();

    if (_adjacencyNeedsRecalc && _adjacencyLastRecalcTick !== gameTime) {
        _runAdjacencyRecalculation();
    }

    updateVisibility(localPlayerId);
    _finalizePathfindPerfTick(_countPendingPathBacklog());
}

// ============================================================
// INPUT HANDLING
// ============================================================
function screenToWorld(sx, sy) {
    let gameArea = document.getElementById('game-area');
    let rect = gameArea.getBoundingClientRect();
    if (renderDimensionMode === '3d' && renderer3dInstance && typeof renderer3dInstance.screenToGround === 'function') {
        let picked = renderer3dInstance.screenToGround(sx, sy, rect);
        if (picked && Number.isFinite(picked.x) && Number.isFinite(picked.y)) {
            return {
                x: picked.x * TILE,
                y: picked.y * TILE,
            };
        }
    }
    let x = (sx - rect.left) / camera.zoom + camera.x;
    let y = (sy - rect.top) / camera.zoom + camera.y;
    return { x, y };
}

function initInput() {
    let gameArea = document.getElementById('game-area');
    let multiRallyPoints = [];
    let multiUnitCommandPoints = [];
    let multiTowerTargetPoints = [];
    let multiBuilderAssignTargets = [];
    let multiCollectorAssignTargets = [];
    let multiHealerAssignTargets = [];
    let multiResearcherAssignTargets = [];

    function isCtrlMultiCommand(evt) {
        if (!evt) return false;
        // Use only event modifier state here to avoid sticky-key issues when
        // browser context menus swallow keyup events (e.g. Firefox Shift+RMB).
        return !!(evt.shiftKey || evt.ctrlKey || evt.metaKey ||
            (evt.getModifierState && (
                evt.getModifierState('Shift') ||
                evt.getModifierState('Control') ||
                evt.getModifierState('Meta')
            )));
    }

    function applyRallyTargets(selSpawners, targetX, targetY, appendToMultiRally, targetUnitId = null) {
        if (!selSpawners || selSpawners.length === 0) return;
        if (appendToMultiRally && multiRallyPoints.length > 0) {
            multiRallyPoints.push({ x: targetX, y: targetY, targetUnitId });
        } else {
            multiRallyPoints = [{ x: targetX, y: targetY, targetUnitId }];
        }
        if (multiRallyPoints.length === 0) multiRallyPoints = [{ x: targetX, y: targetY, targetUnitId }];
        for (let i = 0; i < selSpawners.length; i++) {
            let b = selSpawners[i];
            let rp = multiRallyPoints[i % multiRallyPoints.length];
            queueAction({ action: 'setRally', gx: b.gx, gy: b.gy, targetX: rp.x, targetY: rp.y, targetUnitId: rp.targetUnitId || null });
            b.rallyX = rp.x; b.rallyY = rp.y; b.rallyTargetUnitId = rp.targetUnitId || null;
        }
    }

    function isRallyCapableEntity(ent) {
        if (!ent || ent.owner !== localPlayerId) return false;
        let byType = ['barrack', 'spawner', 'astar_spawner', 'salvager', 'builder_spawner', 'healer_spawner', 'research'].includes(ent.type);
        let byShape = Number.isFinite(ent.gx) && Number.isFinite(ent.gy) && ('rallyX' in ent) && ('rallyY' in ent);
        return !!(byType || byShape);
    }

    function findOwnRallyAnchorNear(worldX, worldY) {
        let candidates = [];
        for (let b of barracks) {
            if (b.owner !== localPlayerId || b.energy <= 0 || b.underConstruction) continue;
            if (!isTileVisible(b.gx, b.gy)) continue;
            candidates.push({ ref: b, x: b.x, y: b.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
        }
        for (let s of collectorSpawners) {
            if (s.owner !== localPlayerId || s.energy <= 0 || s.underConstruction) continue;
            if (!isTileVisible(s.gx, s.gy)) continue;
            candidates.push({ ref: s, x: s.x, y: s.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
        }
        let hit = pickNearestHitCandidate(candidates, worldX, worldY);
        return hit ? hit.ref : null;
    }

    function getUnitClickShape(u) {
        if (!u) return { kind: 'circle', r: 0 };
        let r = Math.max(0, Number(u.r) || 0);
        let vis = u.vis || 'circle';
        if (vis === 'rect') {
            return { kind: 'rect', hw: r, hh: r * 0.7 };
        }
        if (vis === 'mole') {
            return { kind: 'ellipse', rx: r * 0.8, ry: r * 1.1 };
        }
        return { kind: 'circle', r };
    }

    function isPointInsideCandidate(c, dx, dy) {
        if (!c || !c.hitShape) return false;
        let s = c.hitShape;
        if (s.kind === 'rect') {
            let hw = Math.max(0, Number(s.hw) || 0);
            let hh = Math.max(0, Number(s.hh) || 0);
            return Math.abs(dx) <= hw && Math.abs(dy) <= hh;
        }
        if (s.kind === 'ellipse') {
            let rx = Math.max(0.001, Number(s.rx) || 0.001);
            let ry = Math.max(0.001, Number(s.ry) || 0.001);
            let nx = dx / rx, ny = dy / ry;
            return (nx * nx + ny * ny) <= 1;
        }
        let r = Math.max(0, Number(s.r) || 0);
        return (dx * dx + dy * dy) <= (r * r);
    }

    function pickNearestHitCandidate(candidates, worldX, worldY) {
        let bestPointHit = null;
        let bestPointZ = -Infinity;
        let bestPointD2 = Infinity;

        let bestFallback = null;
        let bestFallbackD2 = Infinity;
        for (let c of candidates) {
            if (!c) continue;
            let cx = Number(c.x), cy = Number(c.y), hr = Number(c.hitRadius);
            if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
            let dx = cx - worldX, dy = cy - worldY;
            let d2 = dx * dx + dy * dy;

            // Precise shape hit takes priority, with draw-order style tie-break.
            if (isPointInsideCandidate(c, dx, dy)) {
                let z = Number.isFinite(c.hitZ) ? c.hitZ : 0;
                if (z > bestPointZ || (z === bestPointZ && d2 < bestPointD2)) {
                    bestPointHit = c;
                    bestPointZ = z;
                    bestPointD2 = d2;
                }
            }

            // Fallback: nearest candidate still inside permissive click radius.
            if (Number.isFinite(hr) && hr > 0 && d2 <= hr * hr && d2 < bestFallbackD2) {
                bestFallback = c;
                bestFallbackD2 = d2;
            }
        }
        return bestPointHit || bestFallback;
    }

    function collectEnemyClickTargetCandidates(worldX, worldY, includeUnits = true) {
        let out = [];
        if (includeUnits) {
            for (let u of units) {
                if (u.owner === localPlayerId || u.dead) continue;
                let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                if (!isTileVisible(ugx, ugy)) continue;
                out.push({
                    kind: 'unit',
                    ref: u,
                    x: u.x,
                    y: u.y,
                    hitShape: getUnitClickShape(u),
                    hitRadius: (Number(u.r) || 0) + 10,
                    hitZ: 30,
                });
            }
        }
        for (let t of towers) {
            if (t.owner === localPlayerId || t.energy <= 0) continue;
            if (!isTileVisible(t.gx, t.gy)) continue;
            out.push({ kind: 'tower', ref: t, x: t.x, y: t.y, hitShape: { kind: 'rect', hw: 15, hh: 15 }, hitRadius: 20, hitZ: 20 });
        }
        for (let b of barracks) {
            if (b.owner === localPlayerId || b.energy <= 0) continue;
            if (!isTileVisible(b.gx, b.gy)) continue;
            out.push({ kind: 'barrack', ref: b, x: b.x, y: b.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
        }
        for (let s of collectorSpawners) {
            if (s.owner === localPlayerId || s.energy <= 0) continue;
            if (!isTileVisible(s.gx, s.gy)) continue;
            out.push({ kind: 'spawner', ref: s, x: s.x, y: s.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
        }
        let clickGx = Math.floor(worldX / TILE), clickGy = Math.floor(worldY / TILE);
        if (clickGx >= 0 && clickGx < GRID_W && clickGy >= 0 && clickGy < GRID_H && isTileVisible(clickGx, clickGy)) {
            let cell = grid[clickGy][clickGx];
            if (cell.item && cell.item.energy > 0 && cell.owner !== localPlayerId) {
                out.push({
                    kind: 'item',
                    ref: cell.item,
                    x: clickGx * TILE + TILE * 0.5,
                    y: clickGy * TILE + TILE * 0.5,
                    hitShape: { kind: 'rect', hw: 14, hh: 14 },
                    hitRadius: 20,
                    hitZ: 10,
                    gx: clickGx,
                    gy: clickGy,
                });
            }
        }
        return out;
    }

    function findNearestOwnedSelectableClickTarget(worldX, worldY) {
        let candidates = [];
        for (let u of units) {
            if (u.owner !== localPlayerId || u.dead) continue;
            let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
            if (!isTileVisible(ugx, ugy)) continue;
            candidates.push({
                kind: 'unit',
                ref: u,
                x: u.x,
                y: u.y,
                hitShape: getUnitClickShape(u),
                hitRadius: (Number(u.r) || 0) + 8,
                hitZ: 30,
            });
        }
        for (let b of barracks) {
            if (b.owner !== localPlayerId || b.energy <= 0) continue;
            if (!isTileVisible(b.gx, b.gy)) continue;
            candidates.push({ kind: 'entity', ref: b, x: b.x, y: b.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
        }
        for (let t of towers) {
            if (t.owner !== localPlayerId || t.energy <= 0) continue;
            if (!isTileVisible(t.gx, t.gy)) continue;
            candidates.push({ kind: 'entity', ref: t, x: t.x, y: t.y, hitShape: { kind: 'rect', hw: 15, hh: 15 }, hitRadius: 20, hitZ: 20 });
        }
        for (let s of collectorSpawners) {
            if (s.owner !== localPlayerId || s.energy <= 0) continue;
            if (!isTileVisible(s.gx, s.gy)) continue;
            candidates.push({ kind: 'entity', ref: s, x: s.x, y: s.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
        }
        let gx = Math.floor(worldX / TILE), gy = Math.floor(worldY / TILE);
        if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H && isTileVisible(gx, gy)) {
            let cell = grid[gy][gx];
            if (cell.item && cell.owner === localPlayerId) {
                candidates.push({
                    kind: 'entity',
                    ref: cell.item,
                    x: gx * TILE + TILE * 0.5,
                    y: gy * TILE + TILE * 0.5,
                    hitShape: { kind: 'rect', hw: 14, hh: 14 },
                    hitRadius: 20,
                    hitZ: 10,
                    post: () => { cell.item._gx = gx; cell.item._gy = gy; cell.item._cell = cell; }
                });
            }
        }
        for (let m of goldMines) {
            if (!isTileVisible(m.gx, m.gy)) continue;
            candidates.push({
                kind: 'entity',
                ref: m,
                x: m.x,
                y: m.y,
                hitShape: { kind: 'circle', r: 12 },
                hitRadius: 20,
                hitZ: 5,
                post: () => { m._isGoldMine = true; }
            });
        }
        for (let m of astarMines) {
            if (!isTileVisible(m.gx, m.gy)) continue;
            candidates.push({
                kind: 'entity',
                ref: m,
                x: m.x,
                y: m.y,
                hitShape: { kind: 'circle', r: 12 },
                hitRadius: 20,
                hitZ: 5,
                post: () => { m._isAstarMine = true; }
            });
        }
        return pickNearestHitCandidate(candidates, worldX, worldY);
    }

    function isWorldPointInCurrentView(x, y, pad = 0) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        let worldViewW = viewW / camera.zoom;
        let worldViewH = viewH / camera.zoom;
        return x >= camera.x - pad && x <= camera.x + worldViewW + pad &&
            y >= camera.y - pad && y <= camera.y + worldViewH + pad;
    }

    function getVisibleSameTypeUnits(sampleUnit) {
        if (!sampleUnit) return [];
        let typeKey = sampleUnit.unitType;
        let out = [];
        for (let u of units) {
            if (!u || u.dead || u.owner !== localPlayerId) continue;
            if (u.unitType !== typeKey) continue;
            let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
            if (!isTileVisible(ugx, ugy)) continue;
            if (!isWorldPointInCurrentView(u.x, u.y, Math.max(4, Number(u.r) || 0))) continue;
            out.push(u);
        }
        return out;
    }

    function getVisibleSameTypeEntities(sampleEntity) {
        if (!sampleEntity) return [];
        let out = [];

        if (sampleEntity._isGoldMine) {
            for (let m of goldMines) {
                if (!m || !isTileVisible(m.gx, m.gy)) continue;
                if (!isWorldPointInCurrentView(m.x, m.y, 12)) continue;
                m._isGoldMine = true;
                out.push(m);
            }
            return out;
        }

        if (sampleEntity._isAstarMine) {
            for (let m of astarMines) {
                if (!m || !isTileVisible(m.gx, m.gy)) continue;
                if (!isWorldPointInCurrentView(m.x, m.y, 12)) continue;
                m._isAstarMine = true;
                out.push(m);
            }
            return out;
        }

        if (barracks.includes(sampleEntity)) {
            for (let b of barracks) {
                if (!b || b.energy <= 0) continue;
                if (b.unitType !== sampleEntity.unitType) continue;
                if (!isTileVisible(b.gx, b.gy)) continue;
                if (!isWorldPointInCurrentView(b.x, b.y, 14)) continue;
                out.push(b);
            }
            return out;
        }

        if (towers.includes(sampleEntity)) {
            for (let t of towers) {
                if (!t || t.energy <= 0) continue;
                if (t.type !== sampleEntity.type) continue;
                if (!isTileVisible(t.gx, t.gy)) continue;
                if (!isWorldPointInCurrentView(t.x, t.y, 15)) continue;
                out.push(t);
            }
            return out;
        }

        if (collectorSpawners.includes(sampleEntity)) {
            for (let s of collectorSpawners) {
                if (!s || s.energy <= 0) continue;
                if (s.type !== sampleEntity.type) continue;
                if (!isTileVisible(s.gx, s.gy)) continue;
                if (!isWorldPointInCurrentView(s.x, s.y, 14)) continue;
                out.push(s);
            }
            return out;
        }

        let sampleType = sampleEntity.type;
        for (let gy = 0; gy < GRID_H; gy++) {
            for (let gx = 0; gx < GRID_W; gx++) {
                if (!isTileVisible(gx, gy)) continue;
                let cell = grid[gy][gx];
                if (!cell || !cell.item || cell.item.energy <= 0) continue;
                if (cell.item.type !== sampleType) continue;
                if (!isWorldPointInCurrentView(gx * TILE + TILE * 0.5, gy * TILE + TILE * 0.5, 14)) continue;
                cell.item._gx = gx; cell.item._gy = gy; cell.item._cell = cell;
                out.push(cell.item);
            }
        }
        return out;
    }

    function toggleVisibleSameTypeSelectionFromHit(hit) {
        if (!hit || !hit.ref) return;

        if (hit.kind === 'unit') {
            let group = getVisibleSameTypeUnits(hit.ref);
            if (group.length <= 0) return;
            let isSelected = selectedUnits.includes(hit.ref);
            if (isSelected) {
                let groupSet = new Set(group);
                selectedUnits = selectedUnits.filter(u => !groupSet.has(u));
            } else {
                for (let u of group) {
                    if (!selectedUnits.includes(u)) selectedUnits.push(u);
                }
            }
            return;
        }

        if (hit.kind === 'entity') {
            let group = getVisibleSameTypeEntities(hit.ref);
            if (group.length <= 0) return;
            let isSelected = selectedEntities.includes(hit.ref);
            if (isSelected) {
                let groupSet = new Set(group);
                selectedEntities = selectedEntities.filter(ent => !groupSet.has(ent));
            } else {
                for (let ent of group) {
                    if (!selectedEntities.includes(ent)) selectedEntities.push(ent);
                }
            }
        }
    }

    function findEnemyUnitNear(worldX, worldY) {
        let cands = collectEnemyClickTargetCandidates(worldX, worldY, true)
            .filter(c => c.kind === 'unit');
        let best = pickNearestHitCandidate(cands, worldX, worldY);
        return best ? best.ref : null;
    }

    function applyUnitCommandTargets(unitIds, targetX, targetY, appendToMultiPoints, actionName = 'move') {
        if (!unitIds || unitIds.length === 0) return;
        if (appendToMultiPoints && multiUnitCommandPoints.length > 0) {
            multiUnitCommandPoints.push({ x: targetX, y: targetY });
        } else {
            multiUnitCommandPoints = [{ x: targetX, y: targetY }];
        }
        if (multiUnitCommandPoints.length === 0) multiUnitCommandPoints = [{ x: targetX, y: targetY }];

        let buckets = Array.from({ length: multiUnitCommandPoints.length }, () => []);
        for (let i = 0; i < unitIds.length; i++) buckets[i % multiUnitCommandPoints.length].push(unitIds[i]);

        for (let i = 0; i < buckets.length; i++) {
            if (buckets[i].length === 0) continue;
            let rp = multiUnitCommandPoints[i];
            queueAction({ action: actionName, unitIds: buckets[i], targetX: rp.x, targetY: rp.y });
        }
    }

    function applyTowerTargetAssignments(selTowers, targetSpec, appendToMultiTargets) {
        if (!selTowers || selTowers.length === 0 || !targetSpec) return;
        if (appendToMultiTargets && multiTowerTargetPoints.length > 0) {
            multiTowerTargetPoints.push({ ...targetSpec });
        } else {
            multiTowerTargetPoints = [{ ...targetSpec }];
        }
        if (multiTowerTargetPoints.length === 0) multiTowerTargetPoints = [{ ...targetSpec }];

        let buckets = Array.from({ length: multiTowerTargetPoints.length }, () => []);
        for (let i = 0; i < selTowers.length; i++) buckets[i % multiTowerTargetPoints.length].push(selTowers[i]);

        for (let i = 0; i < buckets.length; i++) {
            if (buckets[i].length === 0) continue;
            let target = multiTowerTargetPoints[i];
            let towerCoords = buckets[i].map(t => ({ gx: t.gx, gy: t.gy }));
            queueAction({ action: 'towerTarget', towerCoords, target });
        }
    }

    function applyWorkerAssignTargets(workerUnits, targetType, targetGx, targetGy, appendToMultiTargets) {
        if (!workerUnits || workerUnits.length === 0) return;
        let multiTargets = targetType === 'build'
            ? multiBuilderAssignTargets
            : (targetType === 'mine' || targetType === 'farm' || targetType === 'astar_mine' || targetType === 'astar_farm')
                ? multiCollectorAssignTargets
                : (targetType === 'research')
                    ? multiResearcherAssignTargets
                    : multiHealerAssignTargets;
        if (appendToMultiTargets && multiTargets.length > 0) {
            multiTargets.push({ targetGx, targetGy });
        } else {
            multiTargets.length = 0;
            multiTargets.push({ targetGx, targetGy });
        }
        if (multiTargets.length === 0) multiTargets.push({ targetGx, targetGy });

        let unitIds = workerUnits.map(u => u.id);
        let buckets = Array.from({ length: multiTargets.length }, () => []);
        for (let i = 0; i < unitIds.length; i++) {
            buckets[i % multiTargets.length].push(unitIds[i]);
        }

        for (let i = 0; i < buckets.length; i++) {
            if (buckets[i].length === 0) continue;
            let target = multiTargets[i];
            queueAction({
                action: 'workerAssign',
                unitIds: buckets[i],
                targetType,
                targetGx: target.targetGx,
                targetGy: target.targetGy
            });
        }
    }

    function screenToWorldClamped(sx, sy) {
        let rect = gameArea.getBoundingClientRect();
        let clampedX = Math.max(rect.left, Math.min(rect.right - 1, sx));
        let clampedY = Math.max(rect.top, Math.min(rect.bottom - 1, sy));
        return screenToWorld(clampedX, clampedY);
    }

    function stopBuildPlacementDrag() {
        buildPlacementDragActive = false;
        buildPlacementDragVisitedTiles = null;
    }

    function canPlaceSelectedBuildItemAt(gx, gy, purchaseCount) {
        if (!selectedBuildItem) return false;
        if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return false;
        let _cd = BASE_CARD_TYPES[selectedBuildItem];
        if (selectedBuildItem === 'area_upgrader') {
            let aId = grid[gy][gx].areaId;
            let area = getAreaById(aId);
            if (!area) return false;
            let filledCount = 0;
            for (let cp of area.cells) {
                let c = grid[cp.y][cp.x];
                if (c.type === TYPE_WALL && getTowerAtTile(cp.x, cp.y)) filledCount++;
                else if (c.item) filledCount++;
                else if (getBarrackAtTile(cp.x, cp.y)) filledCount++;
                else if (getSpawnerAtTile(cp.x, cp.y)) filledCount++;
            }
            return filledCount === area.cells.length && (area.multiplierLevel || 0) < 5;
        }
        return _cd &&
            (canStackAt(gx, gy, selectedBuildItem, localPlayerId) || canBuildAt(gx, gy, localPlayerId));
    }

    function tryPlaceSelectedBuildAt(gx, gy, playCantPlaceSound = true) {
        if (!selectedBuildItem) return false;
        if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H || !isTileVisible(gx, gy)) {
            if (playCantPlaceSound) playSound('cant_place');
            return false;
        }
        let purchaseCount = Math.max(1, Math.floor(buildPurchaseMultiplier || 1));
        let canPlace = canPlaceSelectedBuildItemAt(gx, gy, purchaseCount);
        if (!canPlace) {
            if (playCantPlaceSound) playSound('cant_place');
            return false;
        }
        queueAction({ action: 'place', gx, gy, itemType: selectedBuildItem, autoUpgradeEnabled: defaultAutoUpgradeEnabled, buildEnabled: defaultAutoBuildEnabled, count: purchaseCount });
        requestBuildMenuRefresh();
        return true;
    }

    function tryBuildPlacementDragAtClient(clientX, clientY) {
        if (!buildPlacementDragActive || !selectedBuildItem || !buildPlacementDragVisitedTiles) return;
        let world = screenToWorldClamped(clientX, clientY);
        let gx = Math.floor(world.x / TILE), gy = Math.floor(world.y / TILE);
        if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return;
        let tileKey = `${gx},${gy}`;
        if (buildPlacementDragVisitedTiles.has(tileKey)) return;
        buildPlacementDragVisitedTiles.add(tileKey);
        tryPlaceSelectedBuildAt(gx, gy, false);
    }

    gameArea.addEventListener('mousedown', (e) => {
        if (!gameStarted || gameOver) return;
        if (renderDimensionMode === '3d' && e.button === 1) {
            renderer3dRotateDrag = { clientX: e.clientX, clientY: e.clientY };
            e.preventDefault();
            return;
        }
        let rect = gameArea.getBoundingClientRect();
        let world = screenToWorld(e.clientX, e.clientY);

        if (e.button === 0) { // Left click
            if (selectedBuildItem) {
                if (localDefeated) {
                    selectedBuildItem = null;
                    requestBuildMenuRefresh();
                    stopBuildPlacementDrag();
                    return;
                }
                let gx = Math.floor(world.x / TILE), gy = Math.floor(world.y / TILE);
                let shiftHeld = !!e.shiftKey;
                let dragPlace = shouldShiftDragBuildPlace(shiftHeld);
                let keepSelected = shouldKeepBuildSelectionAfterLeftClick(shiftHeld);

                if (dragPlace) {
                    buildPlacementDragActive = true;
                    buildPlacementDragVisitedTiles = new Set();
                    buildPlacementDragVisitedTiles.add(`${gx},${gy}`);
                    tryPlaceSelectedBuildAt(gx, gy, true);
                } else {
                    stopBuildPlacementDrag();
                    tryPlaceSelectedBuildAt(gx, gy, true);
                }

                if (!keepSelected) {
                    selectedBuildItem = null;
                    requestBuildMenuRefresh();
                    stopBuildPlacementDrag();
                }
                return;
            }
            // Start box selection
            isBoxSelecting = true;
            selectionBox = { sx: world.x, sy: world.y, ex: world.x, ey: world.y };
            selectionBoxScreen = {
                sx: e.clientX - rect.left,
                sy: e.clientY - rect.top,
                ex: e.clientX - rect.left,
                ey: e.clientY - rect.top,
            };
        } else if (e.button === 2) { // Right click
            e.preventDefault();
            if (localDefeated) return;
            if (selectedBuildItem) { selectedBuildItem = null; requestBuildMenuRefresh(); stopBuildPlacementDrag(); return; }
            let isCtrlMulti = isCtrlMultiCommand(e);
            let clickedEnemyUnit = findEnemyUnitNear(world.x, world.y);
            let issuedStructureCommand = false;
            // Set rally for active selected barracks and spawners
            let selSpawners = getActiveEntities().filter(isRallyCapableEntity);
            if (selSpawners.length > 0) {
                let gatherTarget = clickedEnemyUnit
                    ? null
                    : (_getCollectorGatherTargetNear(world.x, world.y, localPlayerId, 22)
                        || _getAstarCollectorGatherTargetNear(world.x, world.y, localPlayerId, 22));
                let rallyAnchor = clickedEnemyUnit ? null : findOwnRallyAnchorNear(world.x, world.y);
                let rallyX = clickedEnemyUnit
                    ? clickedEnemyUnit.x
                    : (gatherTarget ? gatherTarget.target.x : (rallyAnchor ? rallyAnchor.x : world.x));
                let rallyY = clickedEnemyUnit
                    ? clickedEnemyUnit.y
                    : (gatherTarget ? gatherTarget.target.y : (rallyAnchor ? rallyAnchor.y : world.y));
                applyRallyTargets(selSpawners, rallyX, rallyY, isCtrlMulti, clickedEnemyUnit ? clickedEnemyUnit.id : null);
                issuedStructureCommand = true;
            } else if (!isCtrlMulti) {
                multiRallyPoints = [];
            }
            // Set preferred target for selected own towers
            let selTowers = getActiveEntities().filter(e => e instanceof Tower && e.owner === localPlayerId && e.energy > 0);
            if (selTowers.length > 0) {
                // Pick nearest clicked enemy target (unit/building/item) by center distance.
                let towerTarget = null;
                let targetHit = pickNearestHitCandidate(collectEnemyClickTargetCandidates(world.x, world.y, true), world.x, world.y);
                if (targetHit) {
                    if (targetHit.kind === 'unit') towerTarget = { type: 'unit', id: targetHit.ref.id };
                    else if (targetHit.kind === 'tower') towerTarget = { type: 'tower', gx: targetHit.ref.gx, gy: targetHit.ref.gy };
                    else if (targetHit.kind === 'barrack') towerTarget = { type: 'barrack', gx: targetHit.ref.gx, gy: targetHit.ref.gy };
                    else if (targetHit.kind === 'spawner') towerTarget = { type: 'spawner', gx: targetHit.ref.gx, gy: targetHit.ref.gy };
                    else if (targetHit.kind === 'item') towerTarget = { type: 'item', gx: targetHit.gx, gy: targetHit.gy };
                }
                if (towerTarget) {
                    applyTowerTargetAssignments(selTowers, towerTarget, isCtrlMulti);
                    issuedStructureCommand = true;
                } else {
                    // Right-click on ground: clear preferred target for selected towers
                    let towerCoords = selTowers.map(t => ({ gx: t.gx, gy: t.gy }));
                    queueAction({ action: 'towerTarget', towerCoords, target: null });
                    if (!isCtrlMulti) multiTowerTargetPoints = [];
                    issuedStructureCommand = true;
                }
            }
            let activeUnits = getActiveUnits();
            if (issuedStructureCommand && activeUnits.length === 0) {
                updateInfoPanel();
                return;
            }
            // Right-click own barrack to queue unit (only if no workers or combat units selected)
            if (selSpawners.length === 0 && activeUnits.length === 0) {
                let ownBarrackHits = [];
                for (let b of barracks) {
                    if (b.owner !== localPlayerId || b.energy <= 0 || b.underConstruction) continue;
                    if (!isTileVisible(b.gx, b.gy)) continue;
                    ownBarrackHits.push({ ref: b, x: b.x, y: b.y, hitShape: { kind: 'rect', hw: 14, hh: 14 }, hitRadius: 20, hitZ: 20 });
                }
                let clickedBarrack = pickNearestHitCandidate(ownBarrackHits, world.x, world.y);
                if (clickedBarrack) {
                    queueAction({ action: 'queueUnit', gx: clickedBarrack.ref.gx, gy: clickedBarrack.ref.gy, count: queuePurchaseMultiplier });
                    return;
                }
            }
            if (activeUnits.length > 0) {
                // --- Worker targeting logic ---
                let builderUnits = activeUnits.filter(u => u.workerType === 'builder');
                let collectorUnits = activeUnits.filter(u => u.workerType === 'collector');
                let astarCollectorUnits = activeUnits.filter(u => u.workerType === 'astar_collector');
                let salvagerUnits = activeUnits.filter(u => u.workerType === 'salvager');
                let healerUnits = activeUnits.filter(u => u.workerType === 'healer');
                let researcherUnits = activeUnits.filter(u => u.workerType === 'researcher');
                let workerIds = [...builderUnits, ...collectorUnits, ...astarCollectorUnits, ...salvagerUnits, ...healerUnits, ...researcherUnits].map(u => u.id);

                if (builderUnits.length > 0) {
                    // Generic builder-targeting for any placeable object that can be built/upgraded.
                    let buildTarget = _getBuilderWorkTargetNear(world.x, world.y, localPlayerId, 22, true);
                    if (buildTarget) {
                        applyWorkerAssignTargets(builderUnits, 'build', buildTarget.gx, buildTarget.gy, isCtrlMulti);
                        updateInfoPanel();
                        // If no non-worker units, return
                        let nonWorkers = activeUnits.filter(u => !u.workerType);
                        if (nonWorkers.length === 0) return;
                    }
                } else if (!isCtrlMulti) {
                    multiBuilderAssignTargets = [];
                }

                if (collectorUnits.length > 0) {
                    let gatherTarget = _getCollectorGatherTargetNear(world.x, world.y, localPlayerId, 22);
                    if (gatherTarget) {
                        applyWorkerAssignTargets(collectorUnits, gatherTarget.type, gatherTarget.target.gx, gatherTarget.target.gy, isCtrlMulti);
                        updateInfoPanel();
                        let nonWorkers = activeUnits.filter(u => !u.workerType);
                        if (nonWorkers.length === 0) return;
                    }
                } else if (!isCtrlMulti) {
                    multiCollectorAssignTargets = [];
                }

                if (astarCollectorUnits.length > 0) {
                    let gatherTarget = _getAstarCollectorGatherTargetNear(world.x, world.y, localPlayerId, 22);
                    if (gatherTarget) {
                        applyWorkerAssignTargets(astarCollectorUnits, gatherTarget.type, gatherTarget.target.gx, gatherTarget.target.gy, isCtrlMulti);
                        updateInfoPanel();
                        let nonWorkers = activeUnits.filter(u => !u.workerType);
                        if (nonWorkers.length === 0) return;
                    }
                } else if (!isCtrlMulti) {
                    multiCollectorAssignTargets = [];
                }

                if (healerUnits.length > 0) {
                    let queueTarget = _getHealerQueueTargetNear(world.x, world.y, localPlayerId, 22, false);
                    if (queueTarget) {
                        applyWorkerAssignTargets(healerUnits, 'queue', queueTarget.gx, queueTarget.gy, isCtrlMulti);
                        updateInfoPanel();
                        let nonWorkers = activeUnits.filter(u => !u.workerType);
                        if (nonWorkers.length === 0) return;
                    }
                } else if (!isCtrlMulti) {
                    multiHealerAssignTargets = [];
                }

                if (researcherUnits.length > 0) {
                    let researchTarget = null;
                    let researchBestDist = Infinity;
                    for (let s of collectorSpawners) {
                        if (!_isResearcherTargetBuilding(s, localPlayerId)) continue;
                        if (!isTileVisible(s.gx, s.gy)) continue;
                        let d = Math.hypot(s.x - world.x, s.y - world.y);
                        if (d > 22 || d >= researchBestDist) continue;
                        researchBestDist = d;
                        researchTarget = s;
                    }
                    if (researchTarget) {
                        applyWorkerAssignTargets(researcherUnits, 'research', researchTarget.gx, researchTarget.gy, isCtrlMulti);
                        updateInfoPanel();
                        let nonWorkers = activeUnits.filter(u => !u.workerType);
                        if (nonWorkers.length === 0) return;
                    }
                } else if (!isCtrlMulti) {
                    multiResearcherAssignTargets = [];
                }

                // --- Normal combat unit targeting ---
                let combatUnits = activeUnits.filter(u => !u.workerType);
                if (combatUnits.length > 0) {
                    let targetUnit = null, targetBuilding = null;
                    let targetBuildingGx = null, targetBuildingGy = null;
                    let combatHit = pickNearestHitCandidate(collectEnemyClickTargetCandidates(world.x, world.y, true), world.x, world.y);
                    if (combatHit) {
                        if (combatHit.kind === 'unit') targetUnit = combatHit.ref;
                        else {
                            targetBuilding = combatHit.ref;
                            if (combatHit.kind === 'item') {
                                targetBuildingGx = combatHit.gx;
                                targetBuildingGy = combatHit.gy;
                            } else {
                                targetBuildingGx = combatHit.ref.gx;
                                targetBuildingGy = combatHit.ref.gy;
                            }
                        }
                    }
                    let unitIds = combatUnits.map(u => u.id);
                    if (targetUnit) {
                        if (isCtrlMulti) {
                            // Allow enemy clicks to be part of multi-point command chains.
                            applyUnitCommandTargets(unitIds, targetUnit.x, targetUnit.y, true, 'attackMove');
                        } else {
                            queueAction({ action: 'attack', unitIds, targetId: targetUnit.id, targetX: targetUnit.x, targetY: targetUnit.y });
                            multiUnitCommandPoints = [];
                        }
                        if (workerIds.length > 0) {
                            // Keep mixed selections moving; workers cannot attack unit targets directly.
                            queueAction({ action: 'move', unitIds: workerIds, targetX: targetUnit.x, targetY: targetUnit.y });
                        }
                    } else if (targetBuilding) {
                        let targetBuildingX = Number.isFinite(targetBuilding.x) ? targetBuilding.x : (targetBuildingGx * TILE + TILE * 0.5);
                        let targetBuildingY = Number.isFinite(targetBuilding.y) ? targetBuilding.y : (targetBuildingGy * TILE + TILE * 0.5);
                        if (isCtrlMulti) {
                            // Allow enemy clicks to be part of multi-point command chains.
                            applyUnitCommandTargets(unitIds, targetBuildingX, targetBuildingY, true, 'attackMove');
                        } else {
                            queueAction({ action: 'attackBuilding', unitIds, targetGx: targetBuildingGx, targetGy: targetBuildingGy });
                            multiUnitCommandPoints = [];
                        }
                        if (workerIds.length > 0) {
                            // Keep mixed selections moving; workers cannot attack building targets directly.
                            queueAction({ action: 'move', unitIds: workerIds, targetX: targetBuildingX, targetY: targetBuildingY });
                        }
                    } else if (attackMoveMode) {
                        applyUnitCommandTargets(unitIds, world.x, world.y, isCtrlMulti, 'attackMove');
                        attackMoveMode = false;
                    } else {
                        // Workers also move to the position if no special target found
                        let allIds = activeUnits.map(u => u.id);
                        applyUnitCommandTargets(allIds, world.x, world.y, isCtrlMulti, 'move');
                    }
                } else if (workerIds.length > 0) {
                    // Only workers selected and no special target - move them
                    applyUnitCommandTargets(workerIds, world.x, world.y, isCtrlMulti, 'move');
                }
            } else if (!isCtrlMulti) {
                multiUnitCommandPoints = [];
            }
            updateInfoPanel();
        }
    });

    gameArea.addEventListener('mousemove', (e) => {
        if (renderer3dRotateDrag && renderDimensionMode === '3d' && renderer3dInstance && typeof renderer3dInstance.adjustOrbit === 'function') {
            let dx = e.clientX - renderer3dRotateDrag.clientX;
            let dy = e.clientY - renderer3dRotateDrag.clientY;
            renderer3dRotateDrag.clientX = e.clientX;
            renderer3dRotateDrag.clientY = e.clientY;
            renderer3dInstance.adjustOrbit(-dx * 0.008, dy * 0.006);
        }
        let rect = gameArea.getBoundingClientRect();
        let world = screenToWorldClamped(e.clientX, e.clientY);
        mouseWorldX = world.x; mouseWorldY = world.y;
        mouseScreenX = e.clientX; mouseScreenY = e.clientY;
        tryBuildPlacementDragAtClient(e.clientX, e.clientY);
        if (isBoxSelecting && selectionBox) {
            selectionBox.ex = world.x; selectionBox.ey = world.y;
            if (selectionBoxScreen) {
                selectionBoxScreen.ex = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
                selectionBoxScreen.ey = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
            }
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (renderer3dRotateDrag && renderDimensionMode === '3d' && renderer3dInstance && typeof renderer3dInstance.adjustOrbit === 'function') {
            let dx = e.clientX - renderer3dRotateDrag.clientX;
            let dy = e.clientY - renderer3dRotateDrag.clientY;
            renderer3dRotateDrag.clientX = e.clientX;
            renderer3dRotateDrag.clientY = e.clientY;
            renderer3dInstance.adjustOrbit(-dx * 0.008, dy * 0.006);
        }
        tryBuildPlacementDragAtClient(e.clientX, e.clientY);
        if (!isBoxSelecting || !selectionBox) return;
        let rect = gameArea.getBoundingClientRect();
        let world = screenToWorldClamped(e.clientX, e.clientY);
        mouseWorldX = world.x; mouseWorldY = world.y;
        selectionBox.ex = world.x; selectionBox.ey = world.y;
        if (selectionBoxScreen) {
            selectionBoxScreen.ex = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
            selectionBoxScreen.ey = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
        }
    });

    gameArea.addEventListener('mouseup', (e) => {
        if (e.button === 1) renderer3dRotateDrag = null;
        if (e.button === 0) stopBuildPlacementDrag();
        if (e.button === 0 && isBoxSelecting) {
            isBoxSelecting = false;
            if (selectionBox) {
                let sx = Math.min(selectionBox.sx, selectionBox.ex);
                let sy = Math.min(selectionBox.sy, selectionBox.ey);
                let ex = Math.max(selectionBox.sx, selectionBox.ex);
                let ey = Math.max(selectionBox.sy, selectionBox.ey);
                let w = ex - sx, h = ey - sy;
                let screenW = selectionBoxScreen ? Math.abs(selectionBoxScreen.ex - selectionBoxScreen.sx) : w;
                let screenH = selectionBoxScreen ? Math.abs(selectionBoxScreen.ey - selectionBoxScreen.sy) : h;

                if (screenW < 5 && screenH < 5) {
                    // Click select: choose nearest hit among units/buildings/items/mines.
                    let clickHit = findNearestOwnedSelectableClickTarget(selectionBox.sx, selectionBox.sy);
                    if (clickHit && clickHit.post) clickHit.post();
                    let isCtrlLeftClick = !!(e.ctrlKey || e.metaKey || (e.getModifierState && (e.getModifierState('Control') || e.getModifierState('Meta'))));
                    if (isCtrlLeftClick && clickHit) {
                        toggleVisibleSameTypeSelectionFromHit(clickHit);
                    } else if (clickHit && clickHit.kind === 'unit') {
                        let clicked = clickHit.ref;
                        if (e.shiftKey) {
                            let idx = selectedUnits.indexOf(clicked);
                            if (idx >= 0) selectedUnits.splice(idx, 1);
                            else selectedUnits.push(clicked);
                        } else { selectedUnits = [clicked]; selectedEntities = []; }
                    } else if (clickHit && clickHit.kind === 'entity') {
                        let clickedEntity = clickHit.ref;
                        if (e.shiftKey) {
                            let idx = selectedEntities.indexOf(clickedEntity);
                            if (idx >= 0) selectedEntities.splice(idx, 1);
                            else selectedEntities.push(clickedEntity);
                        } else { selectedEntities = [clickedEntity]; selectedUnits = []; }
                    } else {
                        if (!e.shiftKey) { selectedUnits = []; selectedEntities = []; }
                    }
                } else {
                    // Box select - pick up units AND buildings
                    let newUnits = [];
                    let newEntities = [];
                    if (renderDimensionMode === '3d' && selectionBoxScreen) {
                        let projectedSelection = get3DBoxSelection(selectionBoxScreen);
                        newUnits = projectedSelection.units;
                        newEntities = projectedSelection.entities;
                    } else {
                        for (let u of units) {
                            if (u.owner !== localPlayerId || u.dead) continue;
                            let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                            if (!isTileVisible(ugx, ugy)) continue;
                            if (u.x >= sx && u.x <= ex && u.y >= sy && u.y <= ey) newUnits.push(u);
                        }
                        for (let b of barracks) {
                            if (b.energy > 0 && b.owner === localPlayerId && isTileVisible(b.gx, b.gy) && b.x >= sx && b.x <= ex && b.y >= sy && b.y <= ey) newEntities.push(b);
                        }
                        for (let t of towers) {
                            if (t.energy > 0 && t.owner === localPlayerId && isTileVisible(t.gx, t.gy) && t.x >= sx && t.x <= ex && t.y >= sy && t.y <= ey) newEntities.push(t);
                        }
                        for (let s of collectorSpawners) {
                            if (s.energy > 0 && s.owner === localPlayerId && isTileVisible(s.gx, s.gy) && s.x >= sx && s.x <= ex && s.y >= sy && s.y <= ey) newEntities.push(s);
                        }
                        let minGx = Math.max(0, Math.floor(sx / TILE)), maxGx = Math.min(GRID_W - 1, Math.floor(ex / TILE));
                        let minGy = Math.max(0, Math.floor(sy / TILE)), maxGy = Math.min(GRID_H - 1, Math.floor(ey / TILE));
                        for (let gy = minGy; gy <= maxGy; gy++) {
                            for (let gx = minGx; gx <= maxGx; gx++) {
                                if (!isTileVisible(gx, gy)) continue;
                                let cell = grid[gy][gx];
                                if (cell.item && cell.owner === localPlayerId && !newEntities.includes(cell.item)) {
                                    cell.item._gx = gx; cell.item._gy = gy; cell.item._cell = cell;
                                    newEntities.push(cell.item);
                                }
                            }
                        }
                        for (let m of goldMines) {
                            if (!isTileVisible(m.gx, m.gy)) continue;
                            if (m.x >= sx && m.x <= ex && m.y >= sy && m.y <= ey) { m._isGoldMine = true; newEntities.push(m); }
                        }
                        for (let m of astarMines) {
                            if (!isTileVisible(m.gx, m.gy)) continue;
                            if (m.x >= sx && m.x <= ex && m.y >= sy && m.y <= ey) { m._isAstarMine = true; newEntities.push(m); }
                        }
                    }
                    if (e.shiftKey) {
                        for (let u of newUnits) { if (!selectedUnits.includes(u)) selectedUnits.push(u); }
                        for (let ent of newEntities) { if (!selectedEntities.includes(ent)) selectedEntities.push(ent); }
                    } else {
                        selectedUnits = newUnits;
                        selectedEntities = newEntities;
                    }
                }
                activeSubGroups = {};
                selectionBox = null;
                selectionBoxScreen = null;
            }
            updateInfoPanel();
        }
    });

    window.addEventListener('mouseup', (e) => {
        if (e.button === 1) renderer3dRotateDrag = null;
        if (e.button === 0) stopBuildPlacementDrag();
        if (e.button !== 0 || !isBoxSelecting) return;
        let syntheticUp = new MouseEvent('mouseup', { button: 0, clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey });
        gameArea.dispatchEvent(syntheticUp);
    });

    gameArea.addEventListener('contextmenu', e => e.preventDefault());
    gameArea.addEventListener('auxclick', (e) => {
        if (e.button === 1) e.preventDefault();
    });

    gameArea.addEventListener('wheel', (e) => {
        // Zoom centered on mouse cursor position
        let worldBeforeX = mouseWorldX;
        let worldBeforeY = mouseWorldY;
        let rect = gameArea.getBoundingClientRect();
        let screenX = e.clientX - rect.left;
        let screenY = e.clientY - rect.top;
        let oldZoom = camera.zoom;
        let minZoom = Math.max(viewW / WORLD_W, viewH / WORLD_H, 0.4);
        if (e.deltaY < 0) camera.zoom = Math.min(2, camera.zoom * 1.2);
        else camera.zoom = Math.max(minZoom, camera.zoom / 1.2);
        // Adjust camera so world point under cursor stays under cursor
        camera.x = worldBeforeX - screenX / camera.zoom;
        camera.y = worldBeforeY - screenY / camera.zoom;
        clampCamera();
    });

    minimapCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Minimap click / command
    minimapCanvas.addEventListener('mousedown', (e) => {
        let rect = minimapCanvas.getBoundingClientRect();
        let mx = (e.clientX - rect.left) * (MINIMAP_SIZE / rect.width);
        let my = (e.clientY - rect.top) * (MINIMAP_SIZE / rect.height);
        let scale = MINIMAP_SIZE / GRID_W;
        let gx = Math.max(0, Math.min(GRID_W - 1, Math.floor(mx / scale)));
        let gy = Math.max(0, Math.min(GRID_H - 1, Math.floor(my / scale)));
        let worldX = gx * TILE + TILE / 2;
        let worldY = gy * TILE + TILE / 2;

        if (e.button === 2) {
            e.preventDefault();
            if (!gameStarted || gameOver) return;
            if (localDefeated) return;
            if (selectedBuildItem) { selectedBuildItem = null; requestBuildMenuRefresh(); stopBuildPlacementDrag(); return; }

            let isCtrlMulti = isCtrlMultiCommand(e);
            let selSpawners = getActiveEntities().filter(isRallyCapableEntity);
            if (selSpawners.length > 0) {
                applyRallyTargets(selSpawners, worldX, worldY, isCtrlMulti);
            } else if (!isCtrlMulti) {
                multiRallyPoints = [];
            }

            let activeUnits = getActiveUnits();
            if (activeUnits.length > 0) {
                let combatUnits = activeUnits.filter(u => !u.workerType).map(u => u.id);
                let workerUnits = activeUnits.filter(u => !!u.workerType).map(u => u.id);
                if (combatUnits.length > 0) {
                    if (attackMoveMode) {
                        applyUnitCommandTargets(combatUnits, worldX, worldY, isCtrlMulti, 'attackMove');
                        attackMoveMode = false;
                    } else {
                        applyUnitCommandTargets(combatUnits, worldX, worldY, isCtrlMulti, 'move');
                    }
                }
                if (workerUnits.length > 0) {
                    applyUnitCommandTargets(workerUnits, worldX, worldY, isCtrlMulti, 'move');
                }
            } else if (!isCtrlMulti) {
                multiUnitCommandPoints = [];
            }

            updateInfoPanel();
            return;
        }

        // Left click centers camera
        camera.x = (mx / scale) * TILE - viewW / camera.zoom / 2;
        camera.y = (my / scale) * TILE - viewH / camera.zoom / 2;
        clampCamera();
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
        keysDown[e.key.toLowerCase()] = true;
        if (!gameStarted) return;
        if (e.key === 'Escape') {
            if (researchThingLevelDropdown) {
                closeResearchThingLevelDropdown();
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (setResearchStatMatrixPopupOpen(false)) return;
            if (setResearchPopupOpen(false)) return;
            if (setStartingResourcesPopupOpen(false)) return;
            if (setHelpPopupOpen(false)) return;
            stopBuildPlacementDrag();
            selectedBuildItem = null; selectedUnits = []; selectedEntities = []; activeSubGroups = {}; attackMoveMode = false; requestBuildMenuRefresh(); updateInfoPanel();
        }

        let popupGroupKey = String(e.key || '').toLowerCase();
        if (!e.ctrlKey && !e.metaKey && !e.altKey && POPUP_CONTROL_GROUP_KEYS.includes(popupGroupKey)) {
            handlePopupControlGroupKey(popupGroupKey, !!e.shiftKey);
            return;
        }

        if ((e.key === 'z' || e.key === 'Z') && selectedUnits.length > 0) attackMoveMode = true;
        if ((e.key === 'x' || e.key === 'X') && selectedUnits.length > 0) { let au = getActiveUnits(); if (au.length) queueAction({ action: 'stop', unitIds: au.map(u => u.id) }); }
        if (e.key === 'c' || e.key === 'C') { let au = getActiveUnits(); if (au.length) queueAction({ action: 'hold', unitIds: au.map(u => u.id) }); }
        if (e.key === 'f' || e.key === 'F') {
            cycleLevelVisibilityMode();
        }
        if (e.key === '/' || e.code === 'NumpadDivide' || e.key === 'q' || e.key === 'Q') {
            queueResizeForEachActiveUnitSubgroup('d2');
        }
        if (e.key === '*' || e.code === 'NumpadMultiply' || e.key === 'e' || e.key === 'E') {
            queueResizeForEachActiveUnitSubgroup('x2');
        }
        // Control groups
        let num = null;
        if (e.code && e.code.startsWith('Digit')) {
            let d = e.code.slice(5);
            if (d >= '1' && d <= '9') num = d;
        } else if (e.code && e.code.startsWith('Numpad')) {
            let d = e.code.slice(6);
            if (d >= '1' && d <= '9') num = d;
        } else if (e.key >= '1' && e.key <= '9') {
            num = e.key;
        }
        if (num) {
            handleControlGroupKey(num, !!e.shiftKey);
        }
    });
    document.addEventListener('keyup', (e) => { keysDown[e.key.toLowerCase()] = false; });
    window.addEventListener('blur', () => { keysDown = {}; stopBuildPlacementDrag(); });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            keysDown = {};
            stopBuildPlacementDrag();
        }
    });

    // HUD Settings
    const audioToggle = document.getElementById('setting-audio');
    const goldMineTextToggle = document.getElementById('setting-gold-mine-text');
    const rallyLineTypeSelect = document.getElementById('setting-rally-line-type');
    const rallyLineScopeSelect = document.getElementById('setting-show-rally-lines');
    const selectionOutlineScopeSelect = document.getElementById('setting-show-selection-outlines');
    const selectionOutlineTypeSelect = document.getElementById('setting-selection-outline-type');
    if (audioToggle) {
        audioToggle.checked = !!audioEnabled;
        audioToggle.addEventListener('change', () => {
            audioEnabled = audioToggle.checked;
            saveUiSettingsToStorage();
            if (!audioEnabled) {
                stopLaserSound();
                stopBackgroundMusic();
            } else {
                startBackgroundMusic();
            }
        });
    }
    if (goldMineTextToggle) {
        goldMineTextToggle.checked = !!showGoldMineAmountText;
        goldMineTextToggle.addEventListener('change', () => {
            showGoldMineAmountText = goldMineTextToggle.checked;
            saveUiSettingsToStorage();
        });
    }
    if (rallyLineTypeSelect) {
        rallyLineTypeSelect.value = rallyLineType;
        rallyLineTypeSelect.addEventListener('change', () => {
            rallyLineType = rallyLineTypeSelect.value === OVERLAY_LINE_SOLID ? OVERLAY_LINE_SOLID : OVERLAY_LINE_DOTTED;
            saveUiSettingsToStorage();
        });
    }
    if (rallyLineScopeSelect) {
        rallyLineScopeSelect.value = rallyLineScope;
        rallyLineScopeSelect.addEventListener('change', () => {
            let v = String(rallyLineScopeSelect.value || OVERLAY_SCOPE_BUILDINGS);
            if (v !== OVERLAY_SCOPE_BUILDINGS && v !== OVERLAY_SCOPE_BUILDINGS_UNITS && v !== OVERLAY_SCOPE_NONE) v = OVERLAY_SCOPE_BUILDINGS;
            rallyLineScope = v;
            saveUiSettingsToStorage();
        });
    }
    if (selectionOutlineScopeSelect) {
        selectionOutlineScopeSelect.value = selectionOutlineScope;
        selectionOutlineScopeSelect.addEventListener('change', () => {
            let v = String(selectionOutlineScopeSelect.value || OVERLAY_SCOPE_BUILDINGS_UNITS);
            if (v !== OVERLAY_SCOPE_BUILDINGS && v !== OVERLAY_SCOPE_BUILDINGS_UNITS && v !== OVERLAY_SCOPE_NONE) v = OVERLAY_SCOPE_BUILDINGS_UNITS;
            selectionOutlineScope = v;
            saveUiSettingsToStorage();
        });
    }
    if (selectionOutlineTypeSelect) {
        selectionOutlineTypeSelect.value = selectionOutlineType;
        selectionOutlineTypeSelect.addEventListener('change', () => {
            selectionOutlineType = selectionOutlineTypeSelect.value === OVERLAY_LINE_SOLID ? OVERLAY_LINE_SOLID : OVERLAY_LINE_DOTTED;
            saveUiSettingsToStorage();
        });
    }

    updateControlGroupBar();

    // Fullscreen
    const btnFs = document.getElementById('btn-fullscreen');
    function syncFullscreenUi() {
        let isNativeFullscreen = !!document.fullscreenElement;
        appFullscreen = false;
        document.body.classList.remove('app-fullscreen');
        if (btnFs) btnFs.textContent = isNativeFullscreen ? '\uD83D\uDDD6 FS' : '\u26F6 FS';
        window.dispatchEvent(new Event('resize'));
    }
    document.addEventListener('fullscreenchange', syncFullscreenUi);
    if (btnFs) {
        btnFs.addEventListener('click', () => {
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => { });
                return;
            }
            let root = document.documentElement;
            if (root && root.requestFullscreen) {
                root.requestFullscreen().catch(() => {
                    appFullscreen = false;
                    document.body.classList.remove('app-fullscreen');
                    btnFs.textContent = '\u26F6 FS';
                    window.dispatchEvent(new Event('resize'));
                });
            } else {
                appFullscreen = false;
                document.body.classList.remove('app-fullscreen');
                btnFs.textContent = '\u26F6 FS';
                window.dispatchEvent(new Event('resize'));
            }
        });
        syncFullscreenUi();
    }

    const btnView2d = document.getElementById('btn-view-2d');
    const btnView3d = document.getElementById('btn-view-3d');
    if (btnView2d) btnView2d.addEventListener('click', () => setRenderDimensionMode('2d'));
    if (btnView3d) btnView3d.addEventListener('click', () => setRenderDimensionMode('3d'));
    syncRenderModeUi();

    const btnLevelVisibility = document.getElementById('btn-level-visibility');
    if (btnLevelVisibility) {
        updateLevelVisibilityButton();
        btnLevelVisibility.addEventListener('click', () => {
            cycleLevelVisibilityMode();
        });
    }

    const btnRenderRange = document.getElementById('btn-render-range');
    if (btnRenderRange) {
        updateRenderRangeButton();
        btnRenderRange.addEventListener('click', () => {
            cycleRenderRangeMode();
        });
    }

    const btnBuildPlaceMode = document.getElementById('btn-build-place-mode');
    if (btnBuildPlaceMode) {
        updateBuildPlacementModeButton();
        btnBuildPlaceMode.addEventListener('click', () => {
            cycleBuildPlacementMode();
        });
    }

    const btnDefaultBuild = document.getElementById('btn-default-build');
    if (btnDefaultBuild) {
        btnDefaultBuild.addEventListener('click', () => {
            defaultAutoBuildEnabled = !defaultAutoBuildEnabled;
            updateDefaultToggleButtons();
        });
    }

    const btnDefaultAutoUpgrade = document.getElementById('btn-default-auto-upgrade');
    if (btnDefaultAutoUpgrade) {
        btnDefaultAutoUpgrade.addEventListener('click', () => {
            defaultAutoUpgradeEnabled = !defaultAutoUpgradeEnabled;
            updateDefaultToggleButtons();
        });
    }

    const btnIgnoreLevel = document.getElementById('btn-ignore-level');
    if (btnIgnoreLevel) {
        btnIgnoreLevel.addEventListener('click', () => {
            ignoreLevelSubgroups = !ignoreLevelSubgroups;
            updateIgnoreLevelButton();
            activeSubGroups = {};
            updateInfoPanel();
        });
    }
    updateDefaultToggleButtons();
    updateIgnoreLevelButton();
    updatePurchaseMultiplierBars();

    const btnHelp = document.getElementById('btn-help');
    const btnHelpClose = document.getElementById('btn-help-close');
    const btnResearchClose = document.getElementById('btn-research-close');
    const btnOpenStartingResources = document.getElementById('btn-open-starting-resources');
    const btnStartingResourcesClose = document.getElementById('btn-starting-resources-close');
    const btnOpenOptimization = document.getElementById('btn-open-optimization');
    const btnOptimizationClose = document.getElementById('btn-optimization-close');
    const btnOpenConfig = document.getElementById('btn-open-config');
    const btnConfigClose = document.getElementById('btn-config-close');
    const btnConfigApply = document.getElementById('btn-config-apply');
    const btnConfigReset = document.getElementById('btn-config-reset');
    const btnExportSettings = document.getElementById('btn-export-settings');
    const btnImportSettings = document.getElementById('btn-import-settings');
    const inputImportSettings = document.getElementById('input-import-settings');
    const btnShowStatsMap = document.getElementById('btn-show-statsmap');
    const btnRefreshStatsMap = document.getElementById('btn-refresh-statsmap');
    const btnStatsMapClose = document.getElementById('btn-statsmap-close');
    const btnResearchMatrixClose = document.getElementById('btn-research-matrix-close');
    const helpPopup = document.getElementById('help-popup');
    const researchPopup = document.getElementById('research-popup');
    const startingResourcesPopup = document.getElementById('starting-resources-popup');
    const statsMapPopup = document.getElementById('statsmap-popup');
    const researchMatrixPopup = document.getElementById('research-matrix-popup');
    const optimizationPopup = document.getElementById('optimization-popup');
    const configPopup = document.getElementById('config-popup');
    const btnResign = document.getElementById('btn-resign');
    const goBtnSpectate = document.getElementById('go-btn-spectate');
    const goBtnGraph = document.getElementById('go-btn-graph');
    const goBtnPlayAgain = document.getElementById('go-btn-play-again');
    const goGraphWrap = document.getElementById('go-graph-wrap');
    if (btnHelp) {
        btnHelp.addEventListener('click', () => {
            setHelpPopupOpen(true);
        });
    }
    if (btnShowStatsMap) {
        btnShowStatsMap.addEventListener('click', () => {
            setStatsMapPopupOpen(true);
        });
    }
    if (btnOpenStartingResources) {
        btnOpenStartingResources.addEventListener('click', () => {
            setStartingResourcesPopupOpen(true);
        });
    }
    if (btnOpenOptimization) {
        btnOpenOptimization.addEventListener('click', () => {
            setOptimizationPopupOpen(true);
        });
    }
    if (btnOptimizationClose) {
        btnOptimizationClose.addEventListener('click', () => {
            setOptimizationPopupOpen(false);
        });
    }
    if (btnOpenConfig) {
        btnOpenConfig.addEventListener('click', () => {
            setConfigPopupOpen(true);
        });
    }
    if (btnConfigApply) {
        btnConfigApply.addEventListener('click', () => {
            applyConfigEditorChanges();
        });
    }
    if (btnConfigReset) {
        btnConfigReset.addEventListener('click', () => {
            resetConfigEditorToDefaults();
        });
    }
    if (btnConfigClose) {
        btnConfigClose.addEventListener('click', () => {
            setConfigPopupOpen(false);
        });
    }
    if (btnStartingResourcesClose) {
        btnStartingResourcesClose.addEventListener('click', () => {
            setStartingResourcesPopupOpen(false);
        });
    }
    if (btnExportSettings) {
        btnExportSettings.addEventListener('click', () => {
            downloadMainMenuSettings();
        });
    }
    if (btnImportSettings && inputImportSettings) {
        btnImportSettings.addEventListener('click', () => {
            inputImportSettings.value = '';
            let opened = false;
            if (typeof inputImportSettings.showPicker === 'function') {
                try {
                    inputImportSettings.showPicker();
                    opened = true;
                } catch { }
            }
            if (!opened) inputImportSettings.click();
        });
        inputImportSettings.addEventListener('change', () => {
            let file = inputImportSettings.files && inputImportSettings.files[0] ? inputImportSettings.files[0] : null;
            importMainMenuSettingsFromFile(file);
        });
    }
    if (btnRefreshStatsMap) {
        btnRefreshStatsMap.addEventListener('click', () => {
            refreshStatsMapPopupText();
        });
    }
    if (btnResign) {
        btnResign.addEventListener('click', () => {
            let el = document.getElementById('game-over');
            if (gameOver) {
                if (spectateMode === 'postgame' && el && el.style.display === 'none') {
                    el.style.display = 'flex';
                }
                return;
            }
            if (!gameStarted || localDefeated) return;
            if (!confirm('Resign and become a spectator?')) return;
            queueAction({ action: 'resign' });
        });
    }
    if (goBtnSpectate) {
        goBtnSpectate.addEventListener('click', () => {
            if (!gameOver) return;
            enterSpectateMode('postgame');
            let el = document.getElementById('game-over');
            if (el) el.style.display = 'none';
        });
    }
    if (goBtnGraph) {
        goBtnGraph.addEventListener('click', () => {
            if (!goGraphWrap) return;
            goGraphWrap.style.display = goGraphWrap.style.display === 'none' ? 'block' : 'none';
            if (goGraphWrap.style.display !== 'none') renderGameGraph(graphMetric);
        });
    }
    if (goBtnPlayAgain) {
        goBtnPlayAgain.addEventListener('click', () => {
            if (!gameOver || !isHost || !isMultiplayer) return;
            hostPlayAgain();
        });
    }
    document.querySelectorAll('.go-graph-metric').forEach(btn => {
        btn.addEventListener('click', () => {
            let metric = btn.dataset.metric || 'units';
            renderGameGraph(metric);
        });
    });
    if (btnHelpClose) {
        btnHelpClose.addEventListener('click', () => {
            setHelpPopupOpen(false);
        });
    }
    if (btnResearchClose) {
        btnResearchClose.addEventListener('click', () => {
            setResearchPopupOpen(false);
        });
    }
    if (btnStatsMapClose) {
        btnStatsMapClose.addEventListener('click', () => {
            setStatsMapPopupOpen(false);
        });
    }
    if (btnResearchMatrixClose) {
        btnResearchMatrixClose.addEventListener('click', () => {
            setResearchStatMatrixPopupOpen(false);
        });
    }
    if (helpPopup) {
        helpPopup.addEventListener('click', (e) => {
            let tabBtn = e.target.closest('.help-tab-btn');
            if (tabBtn && tabBtn.dataset.tab) setHelpTab(tabBtn.dataset.tab);
        });
        helpPopup.addEventListener('mousedown', (e) => {
            if (e.target === helpPopup) setHelpPopupOpen(false);
        });
    }
    if (researchPopup) {
        researchPopup.addEventListener('mousedown', (e) => {
            if (e.target === researchPopup) setResearchPopupOpen(false);
        });
    }
    if (startingResourcesPopup) {
        startingResourcesPopup.addEventListener('mousedown', (e) => {
            if (e.target === startingResourcesPopup) setStartingResourcesPopupOpen(false);
        });
    }
    if (statsMapPopup) {
        statsMapPopup.addEventListener('mousedown', (e) => {
            if (e.target === statsMapPopup) setStatsMapPopupOpen(false);
        });
    }
    if (researchMatrixPopup) {
        researchMatrixPopup.addEventListener('mousedown', (e) => {
            if (e.target === researchMatrixPopup) setResearchStatMatrixPopupOpen(false);
        });
    }
    if (optimizationPopup) {
        optimizationPopup.addEventListener('mousedown', (e) => {
            if (e.target === optimizationPopup) setOptimizationPopupOpen(false);
        });
    }
    if (configPopup) {
        configPopup.addEventListener('mousedown', (e) => {
            if (e.target === configPopup) setConfigPopupOpen(false);
        });
    }

    ensureDefaultEditableRuntimeConfigSnapshot();

    // Minimap toggle
    const btnMap = document.getElementById('btn-minimap');
    const mapCont = document.getElementById('minimap-container');
    const statsCont = document.getElementById('shop-stats-container');
    if (btnMap && mapCont) {
        btnMap.addEventListener('click', () => {
            let isCollapsed = btnMap.innerText === '\u25B2';
            btnMap.innerText = isCollapsed ? '\u25BC' : '\u25B2';
            let showPanel = btnMap.innerText === '\u25BC';
            if (selectedBuildItem) {
                mapCont.style.display = 'none';
                if (statsCont) statsCont.style.display = showPanel ? 'block' : 'none';
            } else {
                mapCont.style.display = showPanel ? 'block' : 'none';
                if (statsCont) statsCont.style.display = 'none';
            }
        });
    }

    // Touch events for gameArea
    let activeTouches = {};
    let touchDistInitial = 0;
    let touchCenterInitial = null;
    let cameraZoomInitial = 1;
    let cameraXInitial = 0;
    let cameraYInitial = 0;
    let singleTouchId = null;
    let longPressTimer = null;
    let longPressFired = false;
    let touchStartX = 0;
    let touchStartY = 0;

    gameArea.addEventListener('touchstart', (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            activeTouches[e.changedTouches[i].identifier] = e.changedTouches[i];
        }
        let keys = Object.keys(activeTouches);

        if (keys.length === 1) {
            let t = activeTouches[keys[0]];
            singleTouchId = t.identifier;
            longPressFired = false;
            touchStartX = t.clientX;
            touchStartY = t.clientY;

            let syntheticDown = new MouseEvent('mousedown', { button: 0, clientX: t.clientX, clientY: t.clientY });
            gameArea.dispatchEvent(syntheticDown);

            if (longPressRallyEnabled) {
                longPressTimer = setTimeout(() => {
                    longPressTimer = null;
                    longPressFired = true;
                    isBoxSelecting = false;
                    selectionBox = null;
                    let syntheticRight = new MouseEvent('mousedown', { button: 2, clientX: t.clientX, clientY: t.clientY });
                    gameArea.dispatchEvent(syntheticRight);
                }, 300);
            }
        } else if (keys.length === 2) {
            if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
            isBoxSelecting = false;
            selectionBox = null;
            let t1 = activeTouches[keys[0]], t2 = activeTouches[keys[1]];
            let dx = t1.clientX - t2.clientX;
            let dy = t1.clientY - t2.clientY;
            touchDistInitial = Math.hypot(dx, dy);
            touchCenterInitial = { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
            cameraZoomInitial = camera.zoom;
            cameraXInitial = camera.x;
            cameraYInitial = camera.y;
        }
    }, { passive: false });

    gameArea.addEventListener('touchmove', (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            activeTouches[e.changedTouches[i].identifier] = e.changedTouches[i];
        }
        let keys = Object.keys(activeTouches);

        if (keys.length === 1 && keys[0] == singleTouchId) {
            let t = activeTouches[keys[0]];

            if (longPressTimer) {
                let limit = Math.min(gameArea.clientWidth, gameArea.clientHeight) * 0.10;
                let dx = t.clientX - touchStartX;
                let dy = t.clientY - touchStartY;
                if (Math.hypot(dx, dy) > limit) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
            }

            if (!longPressFired) {
                let syntheticMove = new MouseEvent('mousemove', { clientX: t.clientX, clientY: t.clientY });
                gameArea.dispatchEvent(syntheticMove);
            }
        } else if (keys.length === 2 && touchCenterInitial) {
            let t1 = activeTouches[keys[0]], t2 = activeTouches[keys[1]];
            let dx = t1.clientX - t2.clientX;
            let dy = t1.clientY - t2.clientY;
            let dist = Math.hypot(dx, dy);
            let cx = (t1.clientX + t2.clientX) / 2;
            let cy = (t1.clientY + t2.clientY) / 2;

            // Zoom
            let zoomRatio = dist / touchDistInitial;
            let minZoom = Math.max(viewW / WORLD_W, viewH / WORLD_H, 0.4);
            camera.zoom = Math.max(minZoom, Math.min(2, cameraZoomInitial * zoomRatio));

            // Pan (keeping center stable)
            let rect = gameArea.getBoundingClientRect();
            let worldBeforeX = cameraXInitial + (touchCenterInitial.x - rect.left) / cameraZoomInitial;
            let worldBeforeY = cameraYInitial + (touchCenterInitial.y - rect.top) / cameraZoomInitial;

            camera.x = worldBeforeX - (cx - rect.left) / camera.zoom;
            camera.y = worldBeforeY - (cy - rect.top) / camera.zoom;

            clampCamera();
        }
    }, { passive: false });

    gameArea.addEventListener('touchend', (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            delete activeTouches[e.changedTouches[i].identifier];
        }
        let keys = Object.keys(activeTouches);

        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

        if (keys.length === 0) {
            if (!longPressFired) {
                let t = e.changedTouches[0];
                let syntheticUp = new MouseEvent('mouseup', { button: 0, clientX: t.clientX, clientY: t.clientY });
                gameArea.dispatchEvent(syntheticUp);
            }

            touchCenterInitial = null;
            singleTouchId = null;
            longPressFired = false;
        }
    }, { passive: false });

    gameArea.addEventListener('touchcancel', (e) => {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            delete activeTouches[e.changedTouches[i].identifier];
        }
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        isBoxSelecting = false;
        selectionBox = null;
        touchCenterInitial = null;
        singleTouchId = null;
        longPressFired = false;
    }, { passive: false });

    let longPressToggle = document.getElementById('setting-long-press');
    if (longPressToggle) {
        longPressToggle.checked = longPressRallyEnabled;
        longPressToggle.addEventListener('change', (e) => {
            longPressRallyEnabled = e.target.checked;
        });
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

function getUnitStackCount(u) {
    if (!u) return 1;
    if (Number.isFinite(u.stackCount) && u.stackCount >= 1) return Math.floor(u.stackCount);
    return getRequiredStacksForLevel(getUnitBaseLevel(u));
}

function stackCountToLevel(stacks) {
    return Math.max(1, clampThingLevel(Math.floor(Math.log2(Math.max(1, Math.floor(stacks || 1)))) + 1));
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
    selectedUnits = selectedUnits.filter(su => su !== u);
    let idx = units.indexOf(u);
    if (idx >= 0) units.splice(idx, 1);
    if (adjustPop && players[u.owner]) players[u.owner].popCount = Math.max(0, (players[u.owner].popCount || 0) - 1);
}

function configureWorkerUnitFromType(u) {
    if (!u) return;
    if (u.unitType === 'collector') {
        u.workerState = 'IDLE'; u.workerType = 'collector'; u.carryingValue = 0; _clearWorkerTarget(u);
    } else if (u.unitType === 'astar_collector') {
        u.workerState = 'IDLE'; u.workerType = 'astar_collector'; u.carryingValue = 0; _clearWorkerTarget(u);
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
    let nu = new Unit(templateUnit.unitType, templateUnit.owner, spawnTile.x * TILE + 16, spawnTile.y * TILE + 16);
    configureWorkerUnitFromType(nu);
    return nu;
}

function shuffleInPlaceDeterministic(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        let r = (typeof rng === 'function')
            ? rng()
            : ((((i + 1) * 1103515245 + (gameTime + 1) * 12345) >>> 0) / 4294967296);
        let j = Math.floor(r * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function resizeUnitSubgroup(playerId, unitIds, mode, subgroupFilter = null) {
    if (!Array.isArray(unitIds) || unitIds.length === 0) return;
    let idSet = new Set(unitIds);
    let source = units.filter(u => idSet.has(u.id) && u.owner === playerId && !u.dead && !u.isKing);
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
            units.push(nu);
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
    let maxEnergyCaps = survivors.map(u => Math.max(1, Number(u.maxEnergy) || 1));
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

function processActions(actions, playerId) {
    for (let a of actions) {
        if (a.action === 'place') {
            let count = Math.max(1, Math.floor(a.count || 1));
            for (let i = 0; i < count; i++) {
                placeBuilding(a.gx, a.gy, a.itemType, playerId, { autoUpgradeEnabled: a.autoUpgradeEnabled, buildEnabled: a.buildEnabled });
            }
        } else if (a.action === 'move') {
            let targetGx = Math.floor(a.targetX / TILE), targetGy = Math.floor(a.targetY / TILE);
            for (let u of units) {
                if (a.unitIds.includes(u.id) && u.owner === playerId && !u.dead) {
                    u.targetUnit = null; u.targetBuilding = null; u.forcedAttackTarget = false;
                    u._forcedTargetLastSeenX = null; u._forcedTargetLastSeenY = null;
                    u.commandState = CMD_MOVING;
                    if (u.workerState) {
                        _clearWorkerTarget(u);
                        Object.assign(u, { workerState: 'MANUAL_MOVE', workerTarget: null, workerTargetType: null });
                        clearWorkerTaskMemoryForFreeRetarget(u);
                    }
                    if (_canUsePathfindRequestBudget(u.owner)) {
                        _consumePathfindRequestBudget(u.owner);
                        let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                        let dest = findNearestWalkable(targetGx, targetGy, ugx, ugy, u);
                        u.path = _findPathForUnitTagged('player_commands', u, ugx, ugy, dest.x, dest.y, u.isFlying, getPathCanWalkForUnit(u), u.owner);
                        if (u.path && u.path.length > 0) {
                            u.pathIndex = (u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                            u._pendingPathTarget = null;
                        } else {
                            u.path = _makeFallbackPathForUnit(u, ugx, ugy, targetGx, targetGy, CMD_MOVING, 'player_commands');
                            u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                        }
                    } else {
                        let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                        let dest = findNearestWalkable(targetGx, targetGy, ugx, ugy, u);
                        u.path = _makeFallbackPathForUnit(u, ugx, ugy, dest.x, dest.y, CMD_MOVING, 'player_commands');
                        u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                    }
                }
            }
        } else if (a.action === 'attackMove') {
            let targetGx = Math.floor(a.targetX / TILE), targetGy = Math.floor(a.targetY / TILE);
            for (let u of units) {
                if (a.unitIds.includes(u.id) && u.owner === playerId && !u.dead) {
                    u.targetUnit = null; u.targetBuilding = null; u.forcedAttackTarget = false;
                    u._forcedTargetLastSeenX = null; u._forcedTargetLastSeenY = null;
                    u.commandState = CMD_ATTACK_MOVING;
                    if (u.workerState) {
                        _clearWorkerTarget(u);
                        Object.assign(u, { workerState: 'MANUAL_MOVE', workerTarget: null, workerTargetType: null });
                        clearWorkerTaskMemoryForFreeRetarget(u);
                    }
                    if (_canUsePathfindRequestBudget(u.owner)) {
                        _consumePathfindRequestBudget(u.owner);
                        let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                        let dest = findNearestWalkable(targetGx, targetGy, ugx, ugy, u);
                        u.path = _findPathForUnitTagged('player_commands', u, ugx, ugy, dest.x, dest.y, u.isFlying, getPathCanWalkForUnit(u), u.owner);
                        if (u.path && u.path.length > 0) {
                            u.pathIndex = (u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                            u._pendingPathTarget = null;
                        } else {
                            u.path = _makeFallbackPathForUnit(u, ugx, ugy, targetGx, targetGy, CMD_ATTACK_MOVING, 'player_commands');
                            u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                        }
                    } else {
                        let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                        let dest = findNearestWalkable(targetGx, targetGy, ugx, ugy, u);
                        u.path = _makeFallbackPathForUnit(u, ugx, ugy, dest.x, dest.y, CMD_ATTACK_MOVING, 'player_commands');
                        u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                    }
                }
            }
        } else if (a.action === 'attack') {
            let target = units.find(u => u.id === a.targetId);
            if (target) {
                let targetGx = Math.floor(target.x / TILE), targetGy = Math.floor(target.y / TILE);
                for (let u of units) {
                    if (a.unitIds.includes(u.id) && u.owner === playerId && !u.dead) {
                        u.targetUnit = target; u.commandState = CMD_ATTACKING; u.targetBuilding = null; u.forcedAttackTarget = true;
                        u._forcedTargetLastSeenX = target.x; u._forcedTargetLastSeenY = target.y;
                        let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                        let dest = findNearestWalkable(targetGx, targetGy, ugx, ugy, u);
                        if (_canUsePathfindRequestBudget(u.owner)) {
                            _consumePathfindRequestBudget(u.owner);
                            u.path = _findPathForUnitTagged('player_commands', u, ugx, ugy, dest.x, dest.y, u.isFlying, getPathCanWalkForUnit(u), u.owner);
                            if (u.path && u.path.length > 0) {
                                u.pathIndex = (u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                                u._pendingPathTarget = null;
                            } else {
                                u.path = null;
                                u.pathIndex = 0;
                                u._pendingPathTarget = { gx: dest.x, gy: dest.y, cmd: CMD_ATTACKING, src: 'player_commands' };
                            }
                        } else {
                            u.path = _makeFallbackPathForUnit(u, ugx, ugy, dest.x, dest.y, CMD_ATTACKING, 'player_commands');
                            u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                        }
                    }
                }
            } else if (Number.isFinite(a.targetX) && Number.isFinite(a.targetY)) {
                // Target vanished before processing: continue toward last known position.
                processActions([{ action: 'attackMove', unitIds: a.unitIds, targetX: a.targetX, targetY: a.targetY }], playerId);
            }
        } else if (a.action === 'attackBuilding') {
            let tb = getTileEntityRef(a.targetGx, a.targetGy);
            if (!(tb && tb.energy > 0)) tb = null;
            if (tb) {
                for (let u of units) {
                    if (a.unitIds.includes(u.id) && u.owner === playerId && !u.dead) {
                        u.targetBuilding = tb; u.commandState = CMD_ATTACKING; u.targetUnit = null; u.forcedAttackTarget = false;
                        u._forcedTargetLastSeenX = null; u._forcedTargetLastSeenY = null;
                        let ugx = Math.floor(u.x / TILE), ugy = Math.floor(u.y / TILE);
                        let dest = findNearestWalkable(tb.gx, tb.gy, ugx, ugy, u);
                        if (_canUsePathfindRequestBudget(u.owner)) {
                            _consumePathfindRequestBudget(u.owner);
                            u.path = _findPathForUnitTagged('player_commands', u, ugx, ugy, dest.x, dest.y, u.isFlying, getPathCanWalkForUnit(u), u.owner);
                            if (u.path && u.path.length > 0) {
                                u.pathIndex = 0;
                                u._pendingPathTarget = null;
                            } else {
                                u.path = null;
                                u.pathIndex = 0;
                                u._pendingPathTarget = { gx: dest.x, gy: dest.y, cmd: CMD_ATTACKING, src: 'player_commands' };
                            }
                        } else {
                            u.path = _makeFallbackPathForUnit(u, ugx, ugy, dest.x, dest.y, CMD_ATTACKING, 'player_commands');
                            u.pathIndex = (u.path && u.path.length > 1 && u.path[0].x === ugx && u.path[0].y === ugy) ? 1 : 0;
                        }
                    }
                }
            }
        } else if (a.action === 'stop') {
            for (let u of units) {
                if (a.unitIds.includes(u.id) && u.owner === playerId) {
                    u.commandState = CMD_IDLE; u.path = null; u.targetUnit = null; u.targetBuilding = null; u._pendingPathTarget = null; u.forcedAttackTarget = false; u._forcedTargetLastSeenX = null; u._forcedTargetLastSeenY = null;
                    if (u.workerState) {
                        _clearWorkerTarget(u);
                        clearWorkerTaskMemoryForFreeRetarget(u);
                        u.workerState = 'IDLE';
                    }
                }
            }
        } else if (a.action === 'hold') {
            for (let u of units) {
                if (a.unitIds.includes(u.id) && u.owner === playerId) {
                    u.commandState = CMD_HOLDING; u.path = null; u.targetUnit = null; u.targetBuilding = null; u._pendingPathTarget = null; u.forcedAttackTarget = false; u._forcedTargetLastSeenX = null; u._forcedTargetLastSeenY = null;
                    if (u.workerState) {
                        _clearWorkerTarget(u);
                        clearWorkerTaskMemoryForFreeRetarget(u);
                        u.workerState = 'IDLE';
                    }
                }
            }
        } else if (a.action === 'queueUnit') {
            let b = getBarrackAtTile(a.gx, a.gy);
            if (!(b && b.owner === playerId)) b = null;
            if (b && b.energy > 0 && !b.underConstruction) {
                let count = Math.max(1, Math.floor(a.count || 1));
                for (let i = 0; i < count; i++) {
                    if (b.spawnQueue.length >= 20) break;
                    let queuedLevel = getThingEffectiveLevel(b);
                    b.spawnQueue.push(getQueuedSpawnInfo({ unitType: b.unitType, level: queuedLevel }, b.unitType, queuedLevel, playerId));
                }
            }
        } else if (a.action === 'queueWorker') {
            let s = getSpawnerAtTile(a.gx, a.gy);
            if (!(s && s.owner === playerId)) s = null;
            if (s && s.energy > 0 && !s.underConstruction) {
                let count = Math.max(1, Math.floor(a.count || 1));
                for (let i = 0; i < count; i++) {
                    if (s.spawnQueue.length >= 10) break;
                    let queuedLevel = getThingEffectiveLevel(s);
                    let queuedType = s.type === 'spawner'
                        ? 'collector'
                        : s.type === 'astar_spawner'
                            ? 'astar_collector'
                            : s.type === 'builder_spawner'
                                ? 'builder_unit'
                                : s.type === 'healer_spawner'
                                    ? 'healer_unit'
                                    : s.type === 'research'
                                        ? 'researcher_unit'
                                        : 'salvager_unit';
                    s.spawnQueue.push(getQueuedSpawnInfo({ unitType: queuedType, level: queuedLevel }, queuedType, queuedLevel, playerId));
                }
            }
        } else if (a.action === 'queueResearch') {
            let r = getSpawnerAtTile(a.gx, a.gy);
            if (!(r && r.owner === playerId && r.type === 'research')) r = null;
            let stat = getResearchStatEntry(a.kind, a.key, a.statKey);
            if (r && r.energy > 0 && !r.underConstruction && stat) {
                let p = ensurePlayerResearchQueueState(playerId);
                let count = Math.max(1, Math.floor(a.count || 1));
                for (let i = 0; i < count; i++) {
                    if (getPlayerResearchQueueTotalLength(playerId) >= getResearchQueueCapacityForPlayer(playerId)) break;
                    let baseLevel = getPlayerResearchLevel(playerId, a.kind, a.key, a.statKey);
                    let queuedDepth = getResearchQueuedDepthForPlayer(playerId, a.kind, a.key, a.statKey);
                    let projected = baseLevel + queuedDepth;
                    if (projected >= MAX_RESEARCH_LEVEL) break;
                    let task = makeResearchTask(playerId, a.kind, a.key, a.statKey, projected);
                    p.researchQueue.push(task);
                    tryAdvancePlayerResearchTask(playerId);
                }
            }
        } else if (a.action === 'workerAssign') {
            // Assign selected worker units to a specific target
            for (let u of units) {
                if (!a.unitIds.includes(u.id) || u.owner !== playerId || u.dead || !u.workerState) continue;
                let myGx = Math.floor(u.x / TILE), myGy = Math.floor(u.y / TILE);
                if (u.workerType === 'builder' && a.targetType === 'build') {
                    // Generic lookup: includes both under-construction and upgrading targets.
                    let target = _getBuilderWorkTargetAt(a.targetGx, a.targetGy, playerId, true);
                    if (target) {
                        _releaseManualWorkerAssignmentConflicts(u, target, null);
                        if (!_canAssignWorkerTargetExclusive(u, target, null)) {
                            issueWorkerBlockedAssignFallbackMove(u, a.targetGx, a.targetGy);
                            continue;
                        }
                        // Manual assignment should always allow builders to work this target,
                        // even if auto-build for new objects is currently disabled.
                        target.buildEnabled = true;
                        _clearWorkerTarget(u); // clear old target
                        _builderAssignTarget(u, target, myGx, myGy);
                    }
                } else if (u.workerType === 'collector' && (a.targetType === 'mine' || a.targetType === 'farm')) {
                    let gather = _getCollectorGatherTargetAt(a.targetGx, a.targetGy, playerId, a.targetType);
                    if (gather && _isCollectorTargetValid(gather.target, gather.type, playerId)) {
                        _releaseManualWorkerAssignmentConflicts(u, gather.target, gather.type);
                        if (!_canAssignWorkerTargetExclusive(u, gather.target, gather.type)) {
                            _clearWorkerTarget(u);
                            u.workerState = 'IDLE';
                            u.commandState = CMD_IDLE;
                            _collectorFindTarget(u, myGx, myGy);
                            continue;
                        }
                        _clearWorkerTarget(u);
                        u._collectorPinnedTarget = gather.target;
                        u._collectorPinnedTargetType = gather.type;
                        _collectorAssignTarget(u, gather.target, gather.type, myGx, myGy);
                    }
                } else if (u.workerType === 'astar_collector' && (a.targetType === 'astar_mine' || a.targetType === 'astar_farm')) {
                    let gather = _getAstarCollectorGatherTargetAt(a.targetGx, a.targetGy, playerId, a.targetType);
                    if (gather && _isAstarCollectorTargetValid(gather.target, gather.type, playerId)) {
                        _releaseManualWorkerAssignmentConflicts(u, gather.target, gather.type);
                        if (!_canAssignWorkerTargetExclusive(u, gather.target, gather.type)) {
                            _clearWorkerTarget(u);
                            u.workerState = 'IDLE';
                            u.commandState = CMD_IDLE;
                            _astarCollectorFindTarget(u);
                            continue;
                        }
                        _clearWorkerTarget(u);
                        u._astarPinnedTarget = gather.target;
                        u._astarPinnedTargetType = gather.type;
                        _astarCollectorAssignTarget(u, gather.target, gather.type);
                    }
                } else if (u.workerType === 'healer' && a.targetType === 'queue') {
                    let qTarget = getTileEntityRef(a.targetGx, a.targetGy);
                    if (!(qTarget && qTarget.owner === playerId && ((qTarget instanceof Barrack) || isSpawnerEntity(qTarget)))) qTarget = null;
                    if (_isHealerQueueAnchorTarget(qTarget, playerId)) {
                        _releaseManualWorkerAssignmentConflicts(u, qTarget, 'queue');
                        if (!_canAssignWorkerTargetExclusive(u, qTarget, 'queue')) {
                            issueWorkerBlockedAssignFallbackMove(u, a.targetGx, a.targetGy);
                            continue;
                        }
                        _clearWorkerTarget(u);
                        u._healerPinnedQueueTarget = qTarget;
                        if (_isHealerQueueTarget(qTarget, playerId)) _setHealerQueueCommit(u, qTarget);
                        else _clearHealerQueueCommit(u);
                        _healerFindTarget(u, myGx, myGy);
                    }
                } else if (u.workerType === 'researcher' && a.targetType === 'research') {
                    let rTarget = getTileEntityRef(a.targetGx, a.targetGy);
                    if (!_isResearcherTargetBuilding(rTarget, playerId)) rTarget = null;
                    if (rTarget) {
                        _releaseManualWorkerAssignmentConflicts(u, rTarget, 'research');
                        if (!_canAssignWorkerTargetExclusive(u, rTarget, 'research')) {
                            issueWorkerBlockedAssignFallbackMove(u, a.targetGx, a.targetGy);
                            continue;
                        }
                        _clearWorkerTarget(u);
                        if (!_setWorkerTarget(u, rTarget, 'research')) {
                            issueWorkerBlockedAssignFallbackMove(u, a.targetGx, a.targetGy);
                            continue;
                        }
                        u.workerState = 'MOVING_TO_RESEARCH';
                        u._workerNextIdleRetargetTick = gameTime;
                        u._researchSpawnerTarget = null;
                        let path = _requestWorkerPath(u, myGx, myGy, rTarget.gx, rTarget.gy, null, null);
                        if (path && path.length > 0) {
                            u.path = path;
                            u.pathIndex = 0;
                            u.commandState = CMD_MOVING;
                        } else {
                            u.commandState = CMD_IDLE;
                        }
                    }
                }
            }
        } else if (a.action === 'setRally') {
            let b = getTileEntityRef(a.gx, a.gy);
            if (!(b && b.owner === playerId && ((b instanceof Barrack) || isSpawnerEntity(b)))) b = null;
            if (b) {
                b.rallyX = a.targetX;
                b.rallyY = a.targetY;
                b.rallyTargetUnitId = (a.targetUnitId != null) ? a.targetUnitId : null;
                b._rallyLastSeenX = Number.isFinite(a.targetX) ? a.targetX : null;
                b._rallyLastSeenY = Number.isFinite(a.targetY) ? a.targetY : null;
                b._pendingRallyDetach = false;
            }
        } else if (a.action === 'resign') {
            resignedTeams.add(playerId);
            if (playerId === localPlayerId) enterSpectateMode('defeated');
            checkWinCondition();
        } else if (a.action === 'forceResignTeam') {
            let targetTeam = Number.isFinite(a.targetTeam) ? Math.floor(a.targetTeam) : null;
            if (targetTeam !== null) {
                resignedTeams.add(targetTeam);
                if (targetTeam === localPlayerId) enterSpectateMode('defeated');
                checkWinCondition();
            }
        } else if (a.action === 'dequeueUnit') {
            let b = getBarrackAtTile(a.gx, a.gy);
            if (!(b && b.owner === playerId)) b = null;
            if (b) {
                let count = Math.max(1, Math.floor(a.count || 1));
                for (let i = 0; i < count; i++) {
                    if (b.spawnQueue.length <= 0) break;
                    b.spawnQueue.shift();
                }
            }
        } else if (a.action === 'dequeueWorker') {
            let s = getSpawnerAtTile(a.gx, a.gy);
            if (!(s && s.owner === playerId)) s = null;
            if (s) {
                let count = Math.max(1, Math.floor(a.count || 1));
                for (let i = 0; i < count; i++) {
                    if (s.spawnQueue.length <= 0) break;
                    s.spawnQueue.shift();
                }
            }
        } else if (a.action === 'dequeueResearch') {
            let r = getSpawnerAtTile(a.gx, a.gy);
            if (!(r && r.owner === playerId && r.type === 'research')) r = null;
            if (r) {
                let p = ensurePlayerResearchQueueState(playerId);
                let count = Math.max(1, Math.floor(a.count || 1));
                for (let i = 0; i < count; i++) {
                    let idx = -1;
                    if (a.kind && a.key && a.statKey) {
                        for (let qi = p.researchQueue.length - 1; qi >= 0; qi--) {
                            let q = p.researchQueue[qi];
                            if (q && q.kind === a.kind && q.key === a.key && q.statKey === a.statKey) {
                                idx = qi;
                                break;
                            }
                        }
                    } else if (p.researchQueue.length > 0) {
                        idx = p.researchQueue.length - 1;
                    }

                    if (idx >= 0) {
                        p.researchQueue.splice(idx, 1);
                        continue;
                    }

                    if (p.researchTask) {
                        if (!a.kind || !a.key || !a.statKey || (p.researchTask.kind === a.kind && p.researchTask.key === a.key && p.researchTask.statKey === a.statKey)) {
                            p.researchTask = null;
                            tryAdvancePlayerResearchTask(playerId);
                        }
                    }
                }
            }
        } else if (a.action === 'reorderResearch') {
            let r = getSpawnerAtTile(a.gx, a.gy);
            if (!(r && r.owner === playerId && r.type === 'research')) r = null;
            if (r || getOwnedActiveResearchLabs(playerId).length > 0) {
                let p = ensurePlayerResearchQueueState(playerId);
                let fromIsActive = !!a.fromActive;
                let toIsActive = !!a.toActive;
                let ordered = [];
                if (p.researchTask) ordered.push(p.researchTask);
                for (let task of p.researchQueue) ordered.push(task);
                if (ordered.length <= 1) continue;

                let from = fromIsActive ? 0 : (Math.floor(Number(a.fromIndex)) + 1);
                if (!Number.isFinite(from) || from < 0 || from >= ordered.length) continue;

                let rawTo = Math.floor(Number(a.toIndex));
                let to = 0;
                if (toIsActive) {
                    to = 0;
                } else {
                    if (!Number.isFinite(rawTo)) continue;
                    if (fromIsActive) {
                        to = Math.max(0, Math.min(ordered.length - 1, rawTo + 1));
                    } else {
                        to = rawTo <= 0
                            ? 0
                            : Math.max(0, Math.min(ordered.length - 1, rawTo + 1));
                    }
                }
                if (from === to) continue;

                let [task] = ordered.splice(from, 1);
                if (!task) continue;
                ordered.splice(to, 0, task);

                p.researchTask = ordered[0] || null;
                p.researchQueue.length = 0;
                for (let i = 1; i < ordered.length; i++) p.researchQueue.push(ordered[i]);
            }
        } else if (a.action === 'markSalvage') {
            // Toggle salvage mark on a building at gx,gy
            let target = getTileEntityRef(a.gx, a.gy);
            if (target && target.owner === playerId && target.markedForSalvage !== undefined) {
                target.markedForSalvage = !target.markedForSalvage;
            }
        } else if (a.action === 'setAutoUpgrade') {
            let target = getTileEntityRef(a.gx, a.gy);
            if (!(target && target.owner === playerId)) target = null;
            if (target) {
                target.autoUpgradeEnabled = !!a.enabled;
                if (!target.autoUpgradeEnabled) {
                    target.isUpgrading = false;
                }
                refreshThingProgressState(target);
            }
        } else if (a.action === 'setAutoStack') {
            let target = getTileEntityRef(a.gx, a.gy);
            if (!(target && target.owner === playerId)) target = null;
            if (target) {
                target.autoStackEnabled = !!a.enabled;
                refreshThingProgressState(target);
            }
        } else if (a.action === 'setBuildEnabled') {
            let target = getTileEntityRef(a.gx, a.gy);
            if (!(target && target.owner === playerId)) target = null;
            if (target) {
                target.buildEnabled = !!a.enabled;
            }
        } else if (a.action === 'setQueueEnabled') {
            let target = getTileEntityRef(a.gx, a.gy);
            if (!(target && target.owner === playerId && ((target instanceof Barrack) || isSpawnerEntity(target)))) target = null;
            if (target) {
                target.queueEnabled = !!a.enabled;
            }
        } else if (a.action === 'setAutoResearch') {
            let target = getSpawnerAtTile(a.gx, a.gy);
            if (!(target && target.owner === playerId && target.type === 'research')) target = null;
            if (target) {
                target.autoResearchEnabled = !!a.enabled;
                if (target.autoResearchEnabled) {
                    let task = getPlayerResearchTask(playerId);
                    target.researchTask = task || null;
                    if (!target.isUpgrading && task && task.workDone < task.workRequired) {
                        target.isResearching = true;
                    }
                } else {
                    target.isResearching = false;
                }
            }
        } else if (a.action === 'killUnit') {
            let u = units.find(u => u.id === a.unitId && u.owner === playerId);
            if (u && !u.dead && !u.isKing) { u.energy = 0; u.dead = true; players[playerId].popCount--; }
        } else if (a.action === 'resizeUnitGroup') {
            let subgroupFilter = {
                unitType: a.unitType || null,
                unitLevel: Number.isFinite(a.unitLevel) ? a.unitLevel : null
            };
            resizeUnitSubgroup(playerId, a.unitIds || [], a.mode, subgroupFilter);
        } else if (a.action === 'towerTarget') {
            // Set preferredTarget on own towers
            for (let tc of (a.towerCoords || [])) {
                let t = getTowerAtTile(tc.gx, tc.gy);
                if (!(t && t.owner === playerId)) t = null;
                if (!t) continue;
                if (!a.target) { t.preferredTarget = null; t.preferredTargetSpec = null; continue; }
                if (a.target.type === 'unit') {
                    let tu = units.find(u => u.id === a.target.id && !u.dead && u.owner !== playerId);
                    t.preferredTarget = tu || null;
                    t.preferredTargetSpec = tu ? { type: 'unit', id: tu.id } : null;
                } else if (a.target.type === 'tower') {
                    let tb = getTowerAtTile(a.target.gx, a.target.gy);
                    t.preferredTarget = (tb && tb.energy > 0 && tb.owner !== playerId) ? tb : null;
                    t.preferredTargetSpec = t.preferredTarget ? { type: 'tower', gx: a.target.gx, gy: a.target.gy } : null;
                } else if (a.target.type === 'barrack') {
                    let b = getBarrackAtTile(a.target.gx, a.target.gy);
                    t.preferredTarget = (b && b.energy > 0 && b.owner !== playerId) ? b : null;
                    t.preferredTargetSpec = t.preferredTarget ? { type: 'barrack', gx: a.target.gx, gy: a.target.gy } : null;
                } else if (a.target.type === 'spawner') {
                    let s = getSpawnerAtTile(a.target.gx, a.target.gy);
                    t.preferredTarget = (s && s.energy > 0 && s.owner !== playerId) ? s : null;
                    t.preferredTargetSpec = t.preferredTarget ? { type: 'spawner', gx: a.target.gx, gy: a.target.gy } : null;
                } else if (a.target.type === 'item') {
                    let item = getFloorItemAtTile(a.target.gx, a.target.gy);
                    t.preferredTarget = (item && item.energy > 0 && item.owner !== playerId) ? item : null;
                    t.preferredTargetSpec = t.preferredTarget ? { type: 'item', gx: a.target.gx, gy: a.target.gy } : null;
                } else {
                    t.preferredTarget = null;
                    t.preferredTargetSpec = null;
                }
            }
        }
    }
}

// ============================================================
// CAMERA CONTROLS
// ============================================================
function clampCamera() {
    let maxX = WORLD_W - viewW / camera.zoom;
    let maxY = WORLD_H - viewH / camera.zoom;
    camera.x = Math.max(0, Math.min(maxX, camera.x));
    camera.y = Math.max(0, Math.min(maxY, camera.y));
}

function updateCamera() {
    let speed = 12 / camera.zoom;
    if (renderDimensionMode === '3d' && renderer3dInstance && typeof renderer3dInstance.getGroundMovementBasis === 'function') {
        let basis = renderer3dInstance.getGroundMovementBasis();
        let moveX = 0;
        let moveY = 0;
        if (keysDown['arrowup'] || keysDown['w']) {
            moveX += basis.forwardX;
            moveY += basis.forwardZ;
        }
        if (keysDown['arrowdown'] || keysDown['s']) {
            moveX -= basis.forwardX;
            moveY -= basis.forwardZ;
        }
        if (keysDown['arrowright'] || keysDown['d']) {
            moveX += basis.rightX;
            moveY += basis.rightZ;
        }
        if (keysDown['arrowleft'] || keysDown['a']) {
            moveX -= basis.rightX;
            moveY -= basis.rightZ;
        }
        if (moveX !== 0 || moveY !== 0) {
            let moveLen = Math.hypot(moveX, moveY) || 1;
            camera.x += moveX / moveLen * speed;
            camera.y += moveY / moveLen * speed;
        }
    } else {
        if (keysDown['arrowup'] || keysDown['w']) camera.y -= speed;
        if (keysDown['arrowdown'] || keysDown['s']) camera.y += speed;
        if (keysDown['arrowleft'] || keysDown['a']) camera.x -= speed;
        if (keysDown['arrowright'] || keysDown['d']) camera.x += speed;
    }

    clampCamera();
}

// ============================================================


// ============================================================
// GAME INIT & MAIN LOOP
// ============================================================
function startGame() {
    document.getElementById('lobby').style.display = 'none';
    let go = document.getElementById('game-over');
    if (go) go.style.display = 'none';

    loadUiSettingsFromStorage();
    updateBuildPlacementModeButton();

    rebuildPrecomputedStatsMap();

    resetWorldState();

    mapAlerts = [];
    controlGroupAlertState = {};
    controlGroups = {};
    popupControlGroups = {};
    activePopupControlGroupKey = '';
    localDefeated = false;
    spectateMode = 'none';
    resignedTeams = new Set();
    graphMetric = 'units';
    gameStatsHistory = [];
    researchPanelOpenState = {};
    researchQueuePanelOpenState = {};

    for (let p of players) {
        p.energy = STARTING_MONEY;
        p.astar = STARTING_ASTAR;
        p.popCount = 0;
        p.researchLevels = {};
        p.researchMultipliers = {};
        p.researchQueue = [];
        p.researchTask = null;
    }

    rng = mulberry32(gameSeed);
    visualRng = mulberry32(gameSeed ^ 0xDEADBEEF); // separate RNG for visual effects
    generateAreas();
    let teams = (activeTeamIds && activeTeamIds.length > 0) ? activeTeamIds : [0, 1];
    let spawns = pickPlayerSpawns(teams.length);
    generateResourceMinesMixed(spawns);

    let teamBuilderSpawners = {};
    let teamHealerSpawners = {};
    let teamCollectorSpawners = {};
    let teamResearchSpawners = {};
    let teamSpawnPos = {};
    let teamStarterSpawnState = {};

    startingResourcesConfig = normalizeStartingResourcesConfig(startingResourcesConfig);

    let findStarterBuildSpot = (origin, maxRadius = 12) => {
        for (let r = 1; r <= maxRadius; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    let fx = origin.gx + dx, fy = origin.gy + dy;
                    if (fx < 0 || fx >= GRID_W || fy < 0 || fy >= GRID_H) continue;
                    if (Math.abs(dx) + Math.abs(dy) > r) continue;
                    let cell = grid[fy][fx];
                    if (!cell || cell.type === TYPE_WALL || cell.item) continue;
                    let blockedByMine = !!getGoldMineAt(fx, fy) || !!getAstarMineAt(fx, fy);
                    if (blockedByMine) continue;
                    return { gx: fx, gy: fy };
                }
            }
        }
        return null;
    };

    let applyWorkerDefaults = (u) => {
        if (!u) return;
        if (u.unitType === 'collector') {
            u.workerState = 'IDLE'; u.workerType = 'collector'; u.carryingValue = 0; _clearWorkerTarget(u);
        } else if (u.unitType === 'astar_collector') {
            u.workerState = 'IDLE'; u.workerType = 'astar_collector'; u.carryingValue = 0; _clearWorkerTarget(u);
        } else if (u.unitType === 'salvager_unit') {
            u.workerState = 'IDLE'; u.workerType = 'salvager'; u.carryingValue = 0; _clearWorkerTarget(u);
        } else if (u.unitType === 'builder_unit') {
            u.workerState = 'IDLE'; u.workerType = 'builder'; u.carryingValue = 0; _clearWorkerTarget(u); u.builderHasMaterial = false;
        } else if (u.unitType === 'healer_unit') {
            u.workerState = 'IDLE'; u.workerType = 'healer'; u.carryingValue = 0; _clearWorkerTarget(u); u.healerHasMaterial = false;
        } else if (u.unitType === 'researcher_unit') {
            u.workerState = 'IDLE'; u.workerType = 'researcher'; u.carryingValue = 0; _clearWorkerTarget(u); u.researcherHasMaterial = false;
        }
    };

    let completeStarterBuilding = (item, itemKey, owner, level) => {
        if (!item) return;
        let lvl = Math.max(1, clampThingLevel(level || 1));
        let stacks = getRequiredStacksForLevel(lvl);
        item.stacks = stacks;
        item.effectiveStacks = stacks;
        item.level = lvl;
        item.effectiveLevel = lvl;
        item.potentialEffectiveLevel = lvl;
        item.underConstruction = false;
        item.isUpgrading = false;

        if (item instanceof Tower) {
            item.updateStats();
        } else {
            let calcType = itemKey;
            if (item.type === 'barrack') calcType = `barrack_${item.unitType}`;
            let stats = calculateItemStats(calcType, lvl, owner);
            if (Number.isFinite(stats.maxEnergy)) {
                item.maxEnergy = Math.max(1, Math.floor(stats.maxEnergy));
                item.energy = item.maxEnergy;
            }
            if (Number.isFinite(stats.damage)) item.damage = stats.damage;
            if (item.spawnCooldown !== undefined) {
                let fallbackType = getSpawnerFallbackUnitType(item);
                let buildingKey = (item.type === 'barrack') ? `barrack_${item.unitType}` : item.type;
                item.spawnCooldown = Math.round(getBarrackSpawnCooldown(fallbackType, lvl, owner, buildingKey) * TICK_RATE);
            }
        }
        updateItemTextCache(item);
    };

    let getPlacedBuildingEntityAt = (gx, gy, itemKey, owner) => {
        if ((BASE_CARD_TYPES[itemKey] || {}).target === 'wall') {
            let t = getTowerAtTile(gx, gy);
            return (t && t.owner === owner && t.type === itemKey) ? t : null;
        }
        if (itemKey.startsWith('barrack_')) {
            let unitType = (BASE_CARD_TYPES[itemKey] || {}).unitType || 'norm';
            let b = getBarrackAtTile(gx, gy);
            return (b && b.owner === owner && b.unitType === unitType) ? b : null;
        }
        if (itemKey === 'spawner' || itemKey === 'salvager' || itemKey === 'builder_spawner' || itemKey === 'healer_spawner' || itemKey === 'research') {
            let s = getSpawnerAtTile(gx, gy);
            return (s && s.owner === owner && s.type === itemKey) ? s : null;
        }
        return (grid[gy] && grid[gy][gx]) ? grid[gy][gx].item : null;
    };

    let spawnStartingBuilding = (pid, origin, itemKey, level) => {
        let spot = findStarterBuildSpot(origin, 16);
        if (!spot) return null;
        let ok = placeBuilding(spot.gx, spot.gy, itemKey, pid, { autoUpgradeEnabled: true, buildEnabled: true, silent: true });
        if (!ok) return null;
        let placed = getPlacedBuildingEntityAt(spot.gx, spot.gy, itemKey, pid);
        if (!placed) return null;
        completeStarterBuilding(placed, itemKey, pid, level);
        return placed;
    };

    let buildStarterUnitSpawnTilesBfs = (origin, maxRadius = 24) => {
        let out = [];
        let q = [];
        let seen = new Set();
        let startGx = Math.max(0, Math.min(GRID_W - 1, Math.floor(origin.gx)));
        let startGy = Math.max(0, Math.min(GRID_H - 1, Math.floor(origin.gy)));
        q.push({ gx: startGx, gy: startGy });
        seen.add(startGy * GRID_W + startGx);

        while (q.length > 0) {
            let cur = q.shift();
            let gx = cur.gx, gy = cur.gy;
            let md = Math.abs(gx - startGx) + Math.abs(gy - startGy);
            if (md > maxRadius) continue;

            let cell = (grid[gy] && grid[gy][gx]) ? grid[gy][gx] : null;
            let isFloorTile = !!cell && cell.type !== TYPE_WALL;
            let isFreeTile = isFloorTile && !cell.item && !getGoldMineAt(gx, gy);
            if (isFreeTile) out.push({ gx, gy });

            if (!isFloorTile) continue;
            let n0 = gx + 1, n1 = gx - 1, n2 = gy + 1, n3 = gy - 1;
            if (n0 < GRID_W) {
                let k = gy * GRID_W + n0;
                if (!seen.has(k)) { seen.add(k); q.push({ gx: n0, gy }); }
            }
            if (n1 >= 0) {
                let k = gy * GRID_W + n1;
                if (!seen.has(k)) { seen.add(k); q.push({ gx: n1, gy }); }
            }
            if (n2 < GRID_H) {
                let k = n2 * GRID_W + gx;
                if (!seen.has(k)) { seen.add(k); q.push({ gx, gy: n2 }); }
            }
            if (n3 >= 0) {
                let k = n3 * GRID_W + gx;
                if (!seen.has(k)) { seen.add(k); q.push({ gx, gy: n3 }); }
            }
        }

        if (out.length <= 0) {
            let fallback = findNearestWalkable(startGx, startGy, startGx, startGy);
            out.push({ gx: fallback.x, gy: fallback.y });
        }
        return out;
    };

    let getNextStarterUnitSpawnTile = (pid, origin) => {
        let state = teamStarterSpawnState[pid];
        if (!state) {
            state = {
                tiles: buildStarterUnitSpawnTilesBfs(origin),
                cursor: 0
            };
            teamStarterSpawnState[pid] = state;
        }
        if (!state.tiles || state.tiles.length <= 0) {
            let fallback = findNearestWalkable(origin.gx, origin.gy, origin.gx, origin.gy);
            return { gx: fallback.x, gy: fallback.y };
        }
        let idx = state.cursor % state.tiles.length;
        let tile = state.tiles[idx];
        state.cursor = (idx + 1) % state.tiles.length;
        return tile;
    };

    let spawnStartingUnit = (pid, origin, unitType, level) => {
        let spawnTile = getNextStarterUnitSpawnTile(pid, origin);
        let u = new Unit(unitType, pid, spawnTile.gx * TILE + 16, spawnTile.gy * TILE + 16);
        applyWorkerDefaults(u);
        applyUnitLevelScaling(u, Math.max(1, clampThingLevel(level || 1)));
        u.energy = u.maxEnergy;
        units.push(u);
        players[pid].popCount++;
        return u;
    };

    for (let pid of teams) {
        let researchByThing = startingResourcesConfig.researchLevels || {};
        for (let thingId in researchByThing) {
            let parsed = parseStartingThingId(thingId);
            if (!parsed) continue;
            let levelMap = researchByThing[thingId];
            if (!levelMap || typeof levelMap !== 'object') continue;
            for (let statKey in levelMap) {
                if (!getResearchStatEntry(parsed.kind, parsed.key, statKey)) continue;
                let lvl = Math.max(0, Math.min(MAX_RESEARCH_LEVEL, Math.floor(Number(levelMap[statKey]) || 0)));
                if (lvl <= 0) continue;
                let id = makeResearchLevelId(parsed.kind, parsed.key, statKey);
                players[pid].researchLevels[id] = lvl;
                players[pid].researchMultipliers[id] = Math.pow(getResearchBonusExpForStat(parsed.kind, statKey), lvl);
            }
        }
    }

    for (let i = 0; i < teams.length; i++) {
        let pid = teams[i];
        let pos = spawns[i] || spawns[0];
        teamSpawnPos[pid] = pos;

        let builderSpawner = new BuilderSpawner(pos.gx, pos.gy, pid);
        completeStarterBuilding(builderSpawner, 'builder_spawner', pid, 1);
        teamBuilderSpawners[pid] = builderSpawner;
        collectorSpawners.push(builderSpawner);
        grid[pos.gy][pos.gx].item = builderSpawner;
        grid[pos.gy][pos.gx].owner = pid;
        setTileEntity(pos.gx, pos.gy, 'builder_spawner', builderSpawner);

        let healerSpawner = spawnStartingBuilding(pid, pos, 'healer_spawner', 1);
        if (healerSpawner) teamHealerSpawners[pid] = healerSpawner;

        let collectorSpawner = spawnStartingBuilding(pid, pos, 'spawner', 1);
        if (collectorSpawner) teamCollectorSpawners[pid] = collectorSpawner;

        let researchSpawner = spawnStartingBuilding(pid, pos, 'research', 1);
        if (researchSpawner) teamResearchSpawners[pid] = researchSpawner;

        spawnStartingBuilding(pid, pos, 'house', 6);
        spawnStartingBuilding(pid, pos, 'house', 6);
        // spawnStartingBuilding(pid, pos, 'house', 4);
    }

    recomputePlayerPopCaps();

    for (let pid of teams) {
        let pos = teamSpawnPos[pid];
        let builderSpawner = teamBuilderSpawners[pid];
        let healerSpawner = teamHealerSpawners[pid];
        let collectorSpawner = teamCollectorSpawners[pid];
        let researchSpawner = teamResearchSpawners[pid];

        for (let i = 0; i < 3; i++) {
            let u = spawnStartingUnit(pid, pos, 'builder_unit', builderSpawner ? getThingEffectiveLevel(builderSpawner) : 1);
            if (u && builderSpawner && builderSpawner.getBuilderDps) u.builderDps = builderSpawner.getBuilderDps();
        }
        for (let i = 0; i < 3; i++) {
            let u = spawnStartingUnit(pid, pos, 'healer_unit', healerSpawner ? getThingEffectiveLevel(healerSpawner) : 1);
            if (u && healerSpawner && healerSpawner.gethealerDps) u.healerDps = healerSpawner.gethealerDps();
        }

        // Requested starter replacements: give each team one collector + one researcher.
        spawnStartingUnit(pid, pos, 'collector', collectorSpawner ? getThingEffectiveLevel(collectorSpawner) : 1);
        let starterResearcher = spawnStartingUnit(pid, pos, 'researcher_unit', researchSpawner ? getThingEffectiveLevel(researchSpawner) : 1);
        if (starterResearcher && researchSpawner && researchSpawner.getResearcherDps) starterResearcher.researcherDps = researchSpawner.getResearcherDps();
    }

    for (let pid of teams) {
        let pos = teamSpawnPos[pid];
        let spawnByThing = startingResourcesConfig.spawnCounts || {};
        for (let thingId in spawnByThing) {
            let parsed = parseStartingThingId(thingId);
            if (!parsed) continue;
            let levelMap = spawnByThing[thingId];
            if (!levelMap || typeof levelMap !== 'object') continue;
            for (let levelText in levelMap) {
                let lvl = Math.max(1, Math.min(MAX_THING_LEVEL, Math.floor(Number(levelText) || 1)));
                let count = Math.max(0, Math.min(1000, Math.floor(Number(levelMap[levelText]) || 0)));
                for (let i = 0; i < count; i++) {
                    if (parsed.kind === 'building') {
                        spawnStartingBuilding(pid, pos, parsed.key, lvl);
                    } else {
                        spawnStartingUnit(pid, pos, parsed.key, lvl);
                    }
                }
            }
        }
    }

    // Spawn kings for each team
    for (let pid of teams) {
        let pos = teamSpawnPos[pid];
        let king = spawnStartingUnit(pid, pos, 'king', 1);
        if (king) applyUnitLevelScaling(king, 1);
    }

    // Center camera on own base
    let localSpawn = teamSpawnPos[localPlayerId] || spawns[0];
    camera.x = localSpawn.gx * TILE - viewW / 2;
    camera.y = localSpawn.gy * TILE - viewH / 2;
    clampCamera();

    recalculateAdjacency();
    dirtyGrid = true; dirtyAreas = true;
    gameStarted = true;
    requestBuildMenuRefresh();
    updateControlGroupBar();
    startBackgroundMusic();

    if (isMultiplayer) {
        lockstepLocalPacketByTick = {};
        lockstepHostPacketsByTick = {};
        lockstepBundleByTick = {};
        lockstepPendingBundleByTick = {};
        lockstepPendingBundleAckByTick = {};
        lockstepPendingCommitByTick = {};
        lockstepCommittedByTick = {};
        lockstepBundleAckByTick = {};
        lockstepLastPacketSentAtByTick = {};
        lockstepLastBundleSentAtByTick = {};
        lockstepLastFinalizeSentAtByTick = {};
        lockstepLastResendRequestAtByTick = {};
        lockstepLastHardResyncRequestAt = 0;
        lockstepExpectedStateHashByTick = {};
        lockstepLocalStateHashByTick = {};
        lockstepExpectedStateDigestByTick = {};
        lockstepLocalStateDigestByTick = {};
        lockstepDesyncDetected = false;
    }

    // Start unified game loop
    _lastTickTime = performance.now();
    _tickAccumulator = 0;
    _tpsTickCount = 0;
    _tpsDisplay = 0;
    _tpsLastTime = _lastTickTime;
    startMainThreadLoops();
}

let _lastTickTime = 0;
let _tickAccumulator = 0;
let _simulationFrameHandle = 0;
let _renderFrameHandle = 0;

function stableSerializeForLockstep(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableSerializeForLockstep).join(',') + ']';
    if (typeof v === 'object') {
        let keys = Object.keys(v).sort();
        return '{' + keys.map(k => JSON.stringify(k) + ':' + stableSerializeForLockstep(v[k])).join(',') + '}';
    }
    return JSON.stringify(String(v));
}

function normalizeLockstepPayload(v) {
    if (v === null || v === undefined) return null;
    let t = typeof v;
    if (t === 'number') return Number.isFinite(v) ? v : null;
    if (t === 'string' || t === 'boolean') return v;
    if (Array.isArray(v)) return v.map(normalizeLockstepPayload);
    if (t === 'object') {
        let out = {};
        for (let k of Object.keys(v)) {
            let vv = v[k];
            if (vv === undefined || typeof vv === 'function' || typeof vv === 'symbol') continue;
            out[k] = normalizeLockstepPayload(vv);
        }
        return out;
    }
    return null;
}

function hashStringLockstep(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

function computeTickPacketChecksum(tick, peerId, teamId, actions) {
    return hashStringLockstep(stableSerializeForLockstep({
        tick: Math.floor(tick),
        peerId: String(peerId || ''),
        teamId: Math.floor(Number(teamId) || 0),
        actions: Array.isArray(actions) ? actions : []
    }));
}

function computeTickBundleChecksum(tick, packets) {
    let sorted = (Array.isArray(packets) ? packets : [])
        .map(p => ({
            tick: Math.floor(Number(p.tick) || 0),
            peerId: String(p.peerId || ''),
            teamId: Math.floor(Number(p.teamId) || 0),
            actions: Array.isArray(p.actions) ? p.actions : [],
            checksum: String(p.checksum || '')
        }))
        .sort((a, b) => a.peerId.localeCompare(b.peerId));
    return hashStringLockstep(stableSerializeForLockstep({ tick: Math.floor(tick), packets: sorted }));
}

function logLockstepWarning(reason, details = {}) {
    try {
        console.warn('[LOCKSTEP]', reason, details);
    } catch { }
}

function isPeerExplicitlyRemoved(peerId) {
    let pid = String(peerId || '').trim();
    return !!pid && removedFromMatchPeerIds.has(pid);
}

function markPeerRemovedFromMatch(peerId) {
    let pid = String(peerId || '').trim();
    if (!pid) return;
    removedFromMatchPeerIds.add(pid);
    try { lockstepTickPacketsByPeer.delete(pid); } catch { }
    try { lockstepBundlePendingAcksByPeer.delete(pid); } catch { }
    try { remoteInputBuffer.delete(pid); } catch { }
    try {
        for (let [tick, waitingSet] of lockstepWaitingPeersByTick.entries()) {
            if (waitingSet && waitingSet.delete(pid) && waitingSet.size <= 0) {
                lockstepWaitingPeersByTick.delete(tick);
            }
        }
    } catch { }
}

function clearPeerRemovedFromMatch(peerId) {
    let pid = String(peerId || '').trim();
    if (!pid) return;
    removedFromMatchPeerIds.delete(pid);
}

function hostRemovePlayerFromMatch(peerId) {
    let pid = String(peerId || '').trim();
    if (!isHost || !pid || pid === myPeerId) return;
    let teamId = getTeamIdForPeer(pid);
    let uid = getPeerProfileUid(pid);
    markPeerRemovedFromMatch(pid);
    delete matchRoleByPeerId[pid];
    if (uid) delete matchRoleByUid[uid];
    delete peerUidByPeerId[pid];
    lobbyPlayers = lobbyPlayers.filter(p => p && p.peerId !== pid);
    matchStartLobbyPlayers = matchStartLobbyPlayers.filter(p => p && p.peerId !== pid);
    peerPresenceById[pid] = false;
    connections
        .filter(c => c && c.peer === pid)
        .forEach(c => {
            try { c.send({ type: 'PLAYER_REMOVED_FROM_MATCH', peerId: pid, teamId }); } catch { }
            try { c.close(); } catch { }
        });
    if (teamId >= 0 && !resignedTeams.has(teamId)) {
        queueAction({ action: 'forceResignTeam', targetTeam: teamId });
    }
    broadcastLobbyState();
    renderOnlineLobby();
    updateInfoPanel();
}

function scheduleGuestAutoReconnect(reason = 'Connection lost') {
    if (isHost || !isMultiplayer || !gameStarted || !wsHostId) return;
    if (duplicateUidBlocked) return;
    if (isPeerExplicitlyRemoved(myPeerId)) return;
    if (guestReconnectTimer) return;
    let st = document.getElementById('lobby-status');
    if (st) {
        st.textContent = `${reason}. Reconnecting...`;
        st.style.color = '#fa4';
    }
    let waitMs = Math.min(4000, 700 + guestReconnectAttempt * 700);
    guestReconnectTimer = setTimeout(() => {
        guestReconnectTimer = null;
        guestReconnectAttempt++;
        joinGame(wsHostId, { rejoin: true });
    }, waitMs);
}

function getActiveMatchPeerIds() {
    if (gameStarted) {
        let ids = [];
        for (let pid of Object.keys(matchRoleByPeerId || {})) {
            if (normalizeMatchRole(matchRoleByPeerId[pid], '') !== 'playing') continue;
            if (isPeerExplicitlyRemoved(pid)) continue;
            ids.push(pid);
        }
        if (myPeerId && !ids.includes(myPeerId) && !isPeerExplicitlyRemoved(myPeerId)) {
            ids.push(myPeerId);
        }
        if (ids.length > 0) {
            ids.sort();
            return ids;
        }
    }
    let ids = [];
    for (let lp of (lobbyPlayers || [])) {
        if (!lp || !lp.peerId) continue;
        if (isPeerExplicitlyRemoved(lp.peerId)) continue;
        ids.push(lp.peerId);
    }
    if (myPeerId && !ids.includes(myPeerId)) ids.push(myPeerId);
    ids.sort();
    return ids;
}

function buildLocalTickPacket(tick) {
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0 || !myPeerId) return null;
    let actions = (localInputBuffer[t] || []).map(a => normalizeLockstepPayload({ ...a, teamId: localPlayerId }));
    let packet = {
        tick: t,
        peerId: myPeerId,
        teamId: localPlayerId,
        actions
    };
    packet = normalizeLockstepPayload(packet) || packet;
    packet.checksum = computeTickPacketChecksum(packet.tick, packet.peerId, packet.teamId, packet.actions);
    lockstepLocalPacketByTick[t] = packet;
    return packet;
}

function validateTickPacket(packet) {
    if (!packet || typeof packet !== 'object') return false;
    let t = Math.floor(Number(packet.tick));
    if (!Number.isFinite(t) || t < 0) return false;
    let peerId = String(packet.peerId || '');
    if (!peerId) return false;
    let teamId = Math.floor(Number(packet.teamId) || 0);
    let actions = Array.isArray(packet.actions) ? packet.actions : [];
    let expected = computeTickPacketChecksum(t, peerId, teamId, actions);
    return String(packet.checksum || '') === expected;
}

function validateTickBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') return false;
    let t = Math.floor(Number(bundle.tick));
    if (!Number.isFinite(t) || t < 0) return false;
    let packets = Array.isArray(bundle.packets) ? bundle.packets : [];
    for (let p of packets) {
        if (!validateTickPacket(p)) return false;
    }
    let expected = computeTickBundleChecksum(t, packets);
    return String(bundle.combinedChecksum || '') === expected;
}

function sendLocalTickPacket(tick, force = false) {
    if (!isMultiplayer || connections.length === 0) return;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return;
    let now = performance.now();
    if (!force && lockstepLastPacketSentAtByTick[t] && (now - lockstepLastPacketSentAtByTick[t]) < LOCKSTEP_PACKET_RESEND_MS) return;
    let packet = lockstepLocalPacketByTick[t] || buildLocalTickPacket(t);
    if (!packet) return;
    connections.forEach(c => c.send({ type: 'TICK_PACKET', packet }));
    lockstepLastPacketSentAtByTick[t] = now;
    if (isHost) {
        if (!lockstepHostPacketsByTick[t]) lockstepHostPacketsByTick[t] = {};
        lockstepHostPacketsByTick[t][myPeerId] = packet;
    }
}

function sendLocalTickPacketWindow(tick, force = false) {
    let baseTick = Math.floor(Number(tick));
    if (!Number.isFinite(baseTick) || baseTick < 0) return;
    let endTick = baseTick + LOCKSTEP_PIPELINE_TICKS;
    for (let t = baseTick; t <= endTick; t++) {
        sendLocalTickPacket(t, force);
    }
}

function handleIncomingTickPacket(conn, data) {
    if (!isHost) return;
    let packet = data && data.packet ? data.packet : null;
    if (!packet || typeof packet !== 'object') return;
    let connPeerId = String((conn && conn.peer) || '');
    packet.peerId = connPeerId || String(packet.peerId || '');
    packet.tick = Math.floor(Number(packet.tick));
    if (!Number.isFinite(packet.tick) || packet.tick < 0 || !packet.peerId) return;
    packet.teamId = Math.floor(Number(packet.teamId) || 0);
    packet.actions = Array.isArray(packet.actions) ? packet.actions.map(a => normalizeLockstepPayload(a)) : [];
    packet = normalizeLockstepPayload(packet) || packet;

    if (!validateTickPacket(packet)) {
        logLockstepWarning('Packet checksum mismatch; requesting resend', {
            tick: packet.tick,
            packetPeerId: packet.peerId,
            fromPeer: connPeerId || null
        });
        conn.send({ type: 'TICK_RESEND_REQUEST', tick: packet.tick, packetPeerId: packet.peerId });
        return;
    }

    if (lockstepCommittedByTick[packet.tick] || lockstepBundleByTick[packet.tick]) {
        // This tick is already sealed by the host; late packet updates must be ignored.
        return;
    }

    let setup = computeTeamSetupFromLobby();
    let enforcedTeamId = setup.teamByPeer[packet.peerId] ?? packet.teamId;
    if (packet.teamId !== enforcedTeamId || packet.actions.some(a => Math.floor(Number(a && a.teamId) || 0) !== enforcedTeamId)) {
        packet.teamId = enforcedTeamId;
        packet.actions = packet.actions.map(a => normalizeLockstepPayload({ ...(a || {}), teamId: enforcedTeamId }));
        packet.checksum = computeTickPacketChecksum(packet.tick, packet.peerId, packet.teamId, packet.actions);
    }

    if (!lockstepHostPacketsByTick[packet.tick]) lockstepHostPacketsByTick[packet.tick] = {};
    lockstepHostPacketsByTick[packet.tick][packet.peerId] = packet;
}

function maybeBuildHostBundle(tick) {
    if (!isHost) return null;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return null;
    if (!lockstepHostPacketsByTick[t]) lockstepHostPacketsByTick[t] = {};
    if (myPeerId && !lockstepHostPacketsByTick[t][myPeerId]) {
        let own = lockstepLocalPacketByTick[t] || buildLocalTickPacket(t);
        if (own) lockstepHostPacketsByTick[t][myPeerId] = own;
    }

    let participants = getActiveMatchPeerIds();
    let pmap = lockstepHostPacketsByTick[t];
    if (!participants.every(pid => !!pmap[pid])) return null;

    let packets = participants.map(pid => pmap[pid]).sort((a, b) => String(a.peerId).localeCompare(String(b.peerId)));
    let combinedChecksum = computeTickBundleChecksum(t, packets);
    let bundle = { tick: t, packets, combinedChecksum };
    lockstepBundleByTick[t] = bundle;

    if (!lockstepBundleAckByTick[t]) lockstepBundleAckByTick[t] = {};
    if (myPeerId) lockstepBundleAckByTick[t][myPeerId] = true;
    return bundle;
}

function sendHostBundle(tick, force = false) {
    if (!isHost || connections.length === 0) return;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return;
    let bundle = lockstepBundleByTick[t] || maybeBuildHostBundle(t);
    if (!bundle) return;
    let now = performance.now();
    if (!force && lockstepLastBundleSentAtByTick[t] && (now - lockstepLastBundleSentAtByTick[t]) < LOCKSTEP_BUNDLE_RESEND_MS) return;
    connections.forEach(c => c.send({ type: 'TICK_BUNDLE', bundle }));
    lockstepLastBundleSentAtByTick[t] = now;
}

function maybeCommitHostTick(tick) {
    if (!isHost) return false;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return false;
    if (lockstepCommittedByTick[t]) return true;
    let bundle = lockstepBundleByTick[t];
    if (!bundle) return false;
    lockstepCommittedByTick[t] = true;
    connections.forEach(c => c.send({ type: 'TICK_COMMIT', tick: t, combinedChecksum: bundle.combinedChecksum }));
    return true;
}

function sendHostFinalize(tick, force = false) {
    if (!isHost || connections.length === 0) return;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return;
    let resend = getHostResendBundleForTick(t);
    if (!resend || !resend.bundle || !resend.committed) return;
    let now = performance.now();
    if (!force && lockstepLastFinalizeSentAtByTick[t] && (now - lockstepLastFinalizeSentAtByTick[t]) < LOCKSTEP_BUNDLE_RESEND_MS) return;
    connections.forEach(c => {
        c.send({ type: 'TICK_BUNDLE', bundle: resend.bundle });
        c.send({ type: 'TICK_COMMIT', tick: t, combinedChecksum: resend.bundle.combinedChecksum });
    });
    lockstepLastFinalizeSentAtByTick[t] = now;
}

function handleIncomingTickBundle(conn, data) {
    if (isHost) return;
    let bundle = data && data.bundle ? data.bundle : null;
    if (!bundle || typeof bundle !== 'object') return;
    let t = Math.floor(Number(bundle.tick));
    if (!Number.isFinite(t) || t < 0) return;
    bundle.tick = t;
    lockstepPendingBundleByTick[t] = bundle;
}

function handleIncomingTickBundleAck(conn, data) {
    if (!isHost) return;
    let t = Math.floor(Number(data && data.tick));
    if (!Number.isFinite(t) || t < 0 || !conn || !conn.peer) return;
    let bundle = lockstepBundleByTick[t];
    if (!bundle) return;
    if (String(data.combinedChecksum || '') !== String(bundle.combinedChecksum || '')) {
        logLockstepWarning('Bundle ACK checksum mismatch; resending bundle', {
            tick: t,
            peerId: conn.peer,
            expected: String(bundle.combinedChecksum || ''),
            received: String(data.combinedChecksum || '')
        });
        conn.send({ type: 'TICK_BUNDLE', bundle });
        return;
    }
    if (!lockstepBundleAckByTick[t]) lockstepBundleAckByTick[t] = {};
    lockstepBundleAckByTick[t][conn.peer] = true;
}

function handleIncomingTickCommit(conn, data) {
    if (isHost) return;
    let t = Math.floor(Number(data && data.tick));
    if (!Number.isFinite(t) || t < 0) return;
    lockstepPendingCommitByTick[t] = String(data.combinedChecksum || '');
}

function quantizeLockstepNumber(v) {
    let n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 1000) / 1000;
}

function computeLockstepStateDigest(tick) {
    let t = Math.floor(Number(tick));
    let computePopCapFromGrid = (pid) => {
        let owner = Math.floor(Number(pid) || 0);
        let cfgCap = Math.max(1, Math.floor(CONFIG_MAX_POP || 200));
        let housePop = 0;
        for (let gy = 0; gy < GRID_H; gy++) {
            for (let gx = 0; gx < GRID_W; gx++) {
                let cell = grid[gy] && grid[gy][gx];
                let item = cell ? cell.item : null;
                if (!item || item.type !== 'house' || Math.floor(Number(cell.owner) || 0) !== owner) continue;
                if (!(Number(item.energy) > 0) || !!item.underConstruction) continue;
                let lvl = Math.max(1, Math.floor(getDisplayLevel(item) || 1));
                housePop += getHousePopCapContribution(owner, lvl);
            }
        }
        return Math.min(cfgCap, housePop);
    };

    let digest = {
        tick: Number.isFinite(t) ? t : currentTick,
        gameTime,
        players: players.map((p, idx) => ({
            idx,
            money: quantizeLockstepNumber(p && p.money),
            popCount: Math.floor(Number((p && p.popCount) || 0)),
            popCap: Math.floor(Number(computePopCapFromGrid(idx) || 0))
        })),
        units: units
            .filter(u => u && !u.dead)
            .map(u => ({
                id: Math.floor(Number(u.id) || 0),
                owner: Math.floor(Number(u.owner) || 0),
                type: String(u.unitType || ''),
                x: quantizeLockstepNumber(u.x),
                y: quantizeLockstepNumber(u.y),
                energy: quantizeLockstepNumber(u.energy),
                cmd: Math.floor(Number(u.commandState) || 0),
                workerState: String(u.workerState || ''),
                workerType: String(u.workerType || ''),
                stack: Math.floor(Number(u.stackCount || 1))
            }))
            .sort((a, b) => a.id - b.id),
        towers: towers
            .filter(tw => !!tw)
            .map(tw => ({
                gx: Math.floor(Number(tw.gx) || 0),
                gy: Math.floor(Number(tw.gy) || 0),
                owner: Math.floor(Number(tw.owner) || 0),
                type: String(tw.type || ''),
                level: Math.floor(Number(tw.level) || 1),
                energy: quantizeLockstepNumber(tw.energy),
                underConstruction: !!tw.underConstruction,
                isUpgrading: !!tw.isUpgrading
            }))
            .sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx) || (a.owner - b.owner)),
        barracks: barracks
            .filter(b => !!b)
            .map(b => ({
                gx: Math.floor(Number(b.gx) || 0),
                gy: Math.floor(Number(b.gy) || 0),
                owner: Math.floor(Number(b.owner) || 0),
                unitType: String(b.unitType || ''),
                level: Math.floor(Number(b.level) || 1),
                energy: quantizeLockstepNumber(b.energy),
                queueLen: Array.isArray(b.spawnQueue) ? b.spawnQueue.length : 0,
                underConstruction: !!b.underConstruction,
                isUpgrading: !!b.isUpgrading
            }))
            .sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx) || (a.owner - b.owner)),
        spawners: collectorSpawners
            .filter(s => !!s)
            .map(s => ({
                gx: Math.floor(Number(s.gx) || 0),
                gy: Math.floor(Number(s.gy) || 0),
                owner: Math.floor(Number(s.owner) || 0),
                type: String(s.type || ''),
                level: Math.floor(Number(s.level) || 1),
                energy: quantizeLockstepNumber(s.energy),
                queueLen: Array.isArray(s.spawnQueue) ? s.spawnQueue.length : 0,
                underConstruction: !!s.underConstruction,
                isUpgrading: !!s.isUpgrading
            }))
            .sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx) || (a.owner - b.owner)),
        floorItems: [],
        mines: goldMines
            .map(m => ({
                gx: Math.floor(Number(m.gx) || 0),
                gy: Math.floor(Number(m.gy) || 0),
                gold: Math.floor(Number(m.gold) || 0)
            }))
            .sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx))
    };

    for (let gy = 0; gy < GRID_H; gy++) {
        for (let gx = 0; gx < GRID_W; gx++) {
            let cell = grid[gy][gx];
            if (!cell || !cell.item) continue;
            digest.floorItems.push({
                gx,
                gy,
                owner: Math.floor(Number(cell.owner) || 0),
                type: String(cell.item.type || ''),
                level: Math.floor(Number(cell.item.level) || 1),
                energy: quantizeLockstepNumber(cell.item.energy),
                underConstruction: !!cell.item.underConstruction,
                isUpgrading: !!cell.item.isUpgrading
            });
        }
    }

    return digest;
}

function summarizeLockstepDigestMismatch(expectedDigest, localDigest) {
    if (!expectedDigest || !localDigest) return null;
    let summary = {
        expectedTick: Math.floor(Number(expectedDigest.tick) || 0),
        localTick: Math.floor(Number(localDigest.tick) || 0),
        expectedGameTime: Math.floor(Number(expectedDigest.gameTime) || 0),
        localGameTime: Math.floor(Number(localDigest.gameTime) || 0),
        counts: {},
        firstDiff: {}
    };

    let keys = ['players', 'units', 'towers', 'barracks', 'spawners', 'floorItems', 'mines'];
    for (let key of keys) {
        let expArr = Array.isArray(expectedDigest[key]) ? expectedDigest[key] : [];
        let locArr = Array.isArray(localDigest[key]) ? localDigest[key] : [];
        summary.counts[key] = { expected: expArr.length, local: locArr.length };
        let n = Math.min(expArr.length, locArr.length);
        for (let i = 0; i < n; i++) {
            let es = stableSerializeForLockstep(expArr[i]);
            let ls = stableSerializeForLockstep(locArr[i]);
            if (es !== ls) {
                summary.firstDiff[key] = { index: i, expected: expArr[i], local: locArr[i] };
                break;
            }
        }
        if (!summary.firstDiff[key] && expArr.length !== locArr.length) {
            summary.firstDiff[key] = {
                index: n,
                expected: expArr[n] || null,
                local: locArr[n] || null
            };
        }
    }

    return summary;
}

function computeLockstepStateHash(tick) {
    let digest = computeLockstepStateDigest(tick);
    return hashStringLockstep(stableSerializeForLockstep(digest));
}

function maybeCompareLockstepStateHash(tick) {
    if (isHost || lockstepDesyncDetected) return;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return;
    let expected = String(lockstepExpectedStateHashByTick[t] || '');
    let local = String(lockstepLocalStateHashByTick[t] || '');
    if (!expected || !local) return;

    let expectedDigest = lockstepExpectedStateDigestByTick[t] || null;
    let localDigest = lockstepLocalStateDigestByTick[t] || null;

    delete lockstepExpectedStateHashByTick[t];
    delete lockstepLocalStateHashByTick[t];
    delete lockstepExpectedStateDigestByTick[t];
    delete lockstepLocalStateDigestByTick[t];

    if (expected === local) return;

    let mismatchSummary = summarizeLockstepDigestMismatch(expectedDigest, localDigest);

    lockstepDesyncDetected = true;
    waitingForRemoteSince = performance.now();
    logLockstepWarning('State hash mismatch; pausing lockstep and requesting hard resync', {
        tick: t,
        expected,
        local,
        details: mismatchSummary
    });

    if (connections[0] && mismatchSummary) {
        connections[0].send({
            type: 'TICK_STATE_HASH_MISMATCH_REPORT',
            tick: t,
            expectedHash: expected,
            localHash: local,
            details: mismatchSummary
        });
    }

    if (connections[0]) {
        connections[0].send({ type: 'REQUEST_MATCH_SYNC', tick: t, reason: 'state hash mismatch' });
    }
}

function handleIncomingTickStateHash(conn, data) {
    if (isHost) return;
    let t = Math.floor(Number(data && data.tick));
    if (!Number.isFinite(t) || t < 0) return;
    lockstepExpectedStateHashByTick[t] = String(data.stateHash || '');
    if (data && data.stateDigest && typeof data.stateDigest === 'object') {
        lockstepExpectedStateDigestByTick[t] = data.stateDigest;
    }
    maybeCompareLockstepStateHash(t);
}

function maybeRequestHardLockstepResync(now, tick, reason = 'tick timeout') {
    if (isHost || !isMultiplayer || !gameStarted) return;
    let conn = connections[0];
    if (!conn) return;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return;

    let startedAt = Number(waitingForRemoteSince) || 0;
    if (!startedAt) return;
    if ((now - startedAt) < LOCKSTEP_HARD_RESYNC_MS) return;

    let minGap = Math.max(LOCKSTEP_HARD_RESYNC_MS, 2500);
    if (lockstepLastHardResyncRequestAt && (now - lockstepLastHardResyncRequestAt) < minGap) return;

    lockstepLastHardResyncRequestAt = now;
    logLockstepWarning('Lockstep stalled; requesting full match sync', {
        tick: t,
        waitMs: Math.round(now - startedAt),
        reason
    });
    conn.send({ type: 'REQUEST_MATCH_SYNC', tick: t, reason: String(reason || 'tick timeout') });
}

function processDeferredGuestLockstepWindow(now, tick) {
    if (isHost) return;
    let baseTick = Math.floor(Number(tick));
    if (!Number.isFinite(baseTick) || baseTick < 0) return;
    let endTick = baseTick + LOCKSTEP_PIPELINE_TICKS;

    for (let t = baseTick; t <= endTick; t++) {
        let pendingBundle = lockstepPendingBundleByTick[t];
        if (pendingBundle) {
            if (!validateTickBundle(pendingBundle)) {
                let lastReq = lockstepLastResendRequestAtByTick[t] || 0;
                if ((now - lastReq) >= LOCKSTEP_RESEND_REQUEST_MS && connections[0]) {
                    logLockstepWarning('Bundle checksum mismatch; requesting resend', {
                        tick: t,
                        combinedChecksum: String(pendingBundle.combinedChecksum || '')
                    });
                    connections[0].send({ type: 'TICK_RESEND_REQUEST', tick: t });
                    lockstepLastResendRequestAtByTick[t] = now;
                }
                delete lockstepPendingBundleByTick[t];
            } else {
                lockstepBundleByTick[t] = pendingBundle;
                lockstepPendingBundleAckByTick[t] = String(pendingBundle.combinedChecksum || '');
                delete lockstepPendingBundleByTick[t];
            }
        }

        if (lockstepPendingBundleAckByTick[t] && connections[0]) {
            connections[0].send({ type: 'TICK_BUNDLE_ACK', tick: t, combinedChecksum: lockstepPendingBundleAckByTick[t] });
            delete lockstepPendingBundleAckByTick[t];
        }

        let pendingCommitChecksum = lockstepPendingCommitByTick[t];
        if (!pendingCommitChecksum) continue;

        let bundle = lockstepBundleByTick[t];
        if (!bundle) {
            let lastReq = lockstepLastResendRequestAtByTick[t] || 0;
            if ((now - lastReq) >= LOCKSTEP_RESEND_REQUEST_MS && connections[0]) {
                logLockstepWarning('Commit received before bundle; requesting resend', { tick: t });
                connections[0].send({ type: 'TICK_RESEND_REQUEST', tick: t });
                lockstepLastResendRequestAtByTick[t] = now;
            }
            continue;
        }

        if (String(bundle.combinedChecksum || '') !== pendingCommitChecksum) {
            let lastReq = lockstepLastResendRequestAtByTick[t] || 0;
            if ((now - lastReq) >= LOCKSTEP_RESEND_REQUEST_MS && connections[0]) {
                logLockstepWarning('Commit checksum mismatch; requesting resend', {
                    tick: t,
                    bundleChecksum: String(bundle.combinedChecksum || ''),
                    commitChecksum: String(pendingCommitChecksum || '')
                });
                connections[0].send({ type: 'TICK_RESEND_REQUEST', tick: t });
                lockstepLastResendRequestAtByTick[t] = now;
            }
            delete lockstepPendingCommitByTick[t];
            continue;
        }

        lockstepCommittedByTick[t] = true;
        delete lockstepPendingCommitByTick[t];
    }
}

function getHostResendBundleForTick(tick) {
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return null;

    let liveBundle = lockstepBundleByTick[t];
    if (liveBundle && validateTickBundle(liveBundle)) {
        return {
            bundle: liveBundle,
            committed: !!lockstepCommittedByTick[t]
        };
    }

    let historyBundle = lockstepHistoryByTick[t];
    if (!historyBundle || !Array.isArray(historyBundle.packets)) return null;

    let resendBundle = {
        tick: t,
        packets: historyBundle.packets,
        combinedChecksum: String(historyBundle.combinedChecksum || '')
    };
    if (!validateTickBundle(resendBundle)) {
        logLockstepWarning('Unable to resend historical bundle due validation failure', { tick: t });
        return null;
    }
    return {
        bundle: resendBundle,
        committed: true
    };
}

function handleIncomingTickResendRequest(conn, data) {
    let t = Math.floor(Number(data && data.tick));
    if (!Number.isFinite(t) || t < 0) return;

    if (isHost) {
        let packetPeerId = data && data.packetPeerId ? String(data.packetPeerId) : '';
        if (packetPeerId) {
            if (packetPeerId === myPeerId) {
                sendLocalTickPacket(t, true);
            } else {
                let target = connections.find(c => c && c.peer === packetPeerId);
                if (target) target.send({ type: 'TICK_RESEND_REQUEST', tick: t, packetPeerId });
            }
            return;
        }

        let resend = getHostResendBundleForTick(t);
        if (!resend) {
            let liveBundle = maybeBuildHostBundle(t);
            if (liveBundle) {
                resend = {
                    bundle: liveBundle,
                    committed: !!lockstepCommittedByTick[t]
                };
            }
        }

        if (resend && resend.bundle) {
            conn.send({ type: 'TICK_BUNDLE', bundle: resend.bundle });
            if (resend.committed) {
                conn.send({ type: 'TICK_COMMIT', tick: t, combinedChecksum: resend.bundle.combinedChecksum });
            }
        }
        return;
    }

    let packetPeerId = data && data.packetPeerId ? String(data.packetPeerId) : '';
    if (!packetPeerId || packetPeerId === myPeerId) {
        sendLocalTickPacket(t, true);
    }
}

function driveStrictLockstep(now, tick) {
    if (!isMultiplayer) return;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return;

    if (!isHost && lockstepDesyncDetected) {
        maybeRequestHardLockstepResync(now, t, 'state hash mismatch');
        return;
    }

    sendLocalTickPacketWindow(t);

    if (isHost) {
        let participants = getActiveMatchPeerIds();
        let pmap = lockstepHostPacketsByTick[t] || {};
        let missing = participants.filter(pid => !pmap[pid]);
        if (missing.length > 0) {
            let lastReq = lockstepLastResendRequestAtByTick[t] || 0;
            if ((now - lastReq) >= LOCKSTEP_RESEND_REQUEST_MS) {
                for (let pid of missing) {
                    if (pid === myPeerId) {
                        sendLocalTickPacket(t, true);
                        continue;
                    }
                    let conn = connections.find(c => c && c.peer === pid);
                    if (conn) {
                        logLockstepWarning('Missing tick packet; requesting resend from peer', {
                            tick: t,
                            packetPeerId: pid
                        });
                        conn.send({ type: 'TICK_RESEND_REQUEST', tick: t, packetPeerId: pid });
                    }
                }
                lockstepLastResendRequestAtByTick[t] = now;
            }
            return;
        }

        maybeBuildHostBundle(t);
        sendHostBundle(t);
        maybeCommitHostTick(t);

        for (let pt = t + 1; pt <= t + LOCKSTEP_PIPELINE_TICKS; pt++) {
            maybeBuildHostBundle(pt);
            sendHostBundle(pt);
            maybeCommitHostTick(pt);
        }

        let recentStart = Math.max(0, t - Math.max(2, LOCKSTEP_PIPELINE_TICKS));
        for (let rt = recentStart; rt < t; rt++) {
            sendHostFinalize(rt);
        }
        return;
    }

    processDeferredGuestLockstepWindow(now, t);

    if (!lockstepCommittedByTick[t]) {
        let lastReq = lockstepLastResendRequestAtByTick[t] || 0;
        if ((now - lastReq) >= LOCKSTEP_RESEND_REQUEST_MS && connections[0]) {
            logLockstepWarning('Tick not committed in time; requesting resend', {
                tick: t,
                hasBundle: !!lockstepBundleByTick[t],
                hasPendingBundle: !!lockstepPendingBundleByTick[t],
                hasPendingCommit: !!lockstepPendingCommitByTick[t],
                bundleAckQueued: !!lockstepPendingBundleAckByTick[t]
            });
            connections[0].send({ type: 'TICK_RESEND_REQUEST', tick: t });
            lockstepLastResendRequestAtByTick[t] = now;
        }
        maybeRequestHardLockstepResync(now, t, 'tick not committed in time');
    }
}

function isStrictTickReady(tick) {
    if (!isMultiplayer) return true;
    if (!isHost && lockstepDesyncDetected) return false;
    let t = Math.floor(Number(tick));
    if (!Number.isFinite(t) || t < 0) return false;
    return !!lockstepCommittedByTick[t] && !!lockstepBundleByTick[t];
}

let _researchPopupRefreshRequested = false;

function requestResearchPopupRefresh() {
    _researchPopupRefreshRequested = true;
}

function flushTickUiRequests() {
    if (!_researchPopupRefreshRequested) return;
    _researchPopupRefreshRequested = false;
    let researchPopup = document.getElementById('research-popup');
    if (researchPopup && !researchPopup.classList.contains('hidden') && !researchQueueDragInProgress) {
        renderResearchPopupContent();
    }
}

function runOneTick() {
    // Reset pathfinding budget before processing actions
    pathfindBudget = 0;
    let processedTick = currentTick;

    if (isHost && isMultiplayer) {
        let b = lockstepBundleByTick[currentTick];
        if (b && Array.isArray(b.packets)) {
            lockstepHistoryByTick[currentTick] = {
                tick: currentTick,
                packets: b.packets.map(p => ({
                    tick: p.tick,
                    peerId: p.peerId,
                    teamId: p.teamId,
                    actions: Array.isArray(p.actions) ? p.actions.map(a => ({ ...a })) : [],
                    checksum: p.checksum
                })),
                combinedChecksum: b.combinedChecksum
            };
        }
    }

    // Process deterministic combined actions for this tick.
    let allActs = isMultiplayer
        ? ((lockstepBundleByTick[currentTick] && Array.isArray(lockstepBundleByTick[currentTick].packets))
            ? lockstepBundleByTick[currentTick].packets.flatMap(p => Array.isArray(p.actions) ? p.actions : [])
            : [])
        : (localInputBuffer[currentTick] || []);
    let teams = (activeTeamIds && activeTeamIds.length > 0) ? [...activeTeamIds].sort((a, b) => a - b) : [0, 1];
    for (let teamId of teams) {
        let acts = allActs.filter(a => (a.teamId ?? 0) === teamId);
        if (acts.length > 0) processActions(acts, teamId);
    }

    delete localInputBuffer[currentTick];
    delete lockstepLocalPacketByTick[currentTick];
    delete lockstepHostPacketsByTick[currentTick];
    delete lockstepBundleByTick[currentTick];
    delete lockstepPendingBundleByTick[currentTick];
    delete lockstepPendingBundleAckByTick[currentTick];
    delete lockstepPendingCommitByTick[currentTick];
    delete lockstepCommittedByTick[currentTick];
    delete lockstepBundleAckByTick[currentTick];
    delete lockstepLastPacketSentAtByTick[currentTick];
    delete lockstepLastBundleSentAtByTick[currentTick];
    delete lockstepLastFinalizeSentAtByTick[currentTick];
    delete lockstepLastResendRequestAtByTick[currentTick];

    gameTick();

    if (currentTick % TICK_RATE === 0) sampleGameStats();
    requestResearchPopupRefresh();

    if (isMultiplayer && (processedTick % LOCKSTEP_STATE_CHECK_INTERVAL) === 0) {
        let stateDigest = computeLockstepStateDigest(processedTick);
        let stateHash = hashStringLockstep(stableSerializeForLockstep(stateDigest));
        if (isHost) {
            connections.forEach(c => {
                if (c) {
                    let msg = { type: 'TICK_STATE_HASH', tick: processedTick, stateHash };
                    if (LOCKSTEP_DEBUG_HASH_DETAILS) msg.stateDigest = stateDigest;
                    c.send(msg);
                }
            });
        } else {
            lockstepLocalStateHashByTick[processedTick] = stateHash;
            if (LOCKSTEP_DEBUG_HASH_DETAILS) lockstepLocalStateDigestByTick[processedTick] = stateDigest;
            maybeCompareLockstepStateHash(processedTick);
        }
    }

    if (isMultiplayer && !isHost) {
        let pruneBefore = processedTick - Math.max(200, LOCKSTEP_STATE_CHECK_INTERVAL * 20);
        for (let key of Object.keys(lockstepExpectedStateHashByTick)) {
            let t = Math.floor(Number(key));
            if (Number.isFinite(t) && t < pruneBefore) {
                delete lockstepExpectedStateHashByTick[key];
                delete lockstepExpectedStateDigestByTick[key];
            }
        }
        for (let key of Object.keys(lockstepLocalStateHashByTick)) {
            let t = Math.floor(Number(key));
            if (Number.isFinite(t) && t < pruneBefore) {
                delete lockstepLocalStateHashByTick[key];
                delete lockstepLocalStateDigestByTick[key];
            }
        }
    }

    _tpsTickCount++;
    let tpsNow = performance.now();
    if (tpsNow - _tpsLastTime >= 1000) {
        _tpsDisplay = Math.round(_tpsTickCount * 1000 / (tpsNow - _tpsLastTime));
        _tpsTickCount = 0;
        _tpsLastTime = tpsNow;
    }

    currentTick++;
}

Object.assign(globalThis, {
    gameTick,
    screenToWorld,
    initInput,
    startGame,
    runOneTick,
});

// ============================================================

