"use strict";

function initSpatialHash() {
    spatialEpoch++;
    if (typeof simUnitClearSepKeys === 'function') simUnitClearSepKeys();
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
    spatialUnitsComplexStridePerPlayer = 1 + spatialUnitsComplexUnitTypeCount; // total + perUnitType
    spatialUnitsComplexStridePerChunk = spatialUnitsComplexPlayerCount * spatialUnitsComplexStridePerPlayer;
    spatialUnitsComplex = new Int32Array((CHUNKS_W * CHUNKS_H) * spatialUnitsComplexStridePerChunk);
    let areaCount = Array.isArray(areas) ? areas.length : 0;
    spatialUnitsByArea = Array.from({ length: Math.max(0, areaCount) }, () => []);
    spatialBlockCols = Math.ceil(CHUNKS_W / SPATIAL_BLOCK_SIZE);
    spatialBlockRows = Math.ceil(CHUNKS_H / SPATIAL_BLOCK_SIZE);
    spatialBlockCounts = new Int32Array(spatialBlockCols * spatialBlockRows * spatialUnitsComplexPlayerCount);
}

// Units per owner in blocks of 8x8 chunks, kept exactly in step with the
// per-chunk totals: region queries rule out areas without enemies in a few
// reads instead of visiting every chunk.
const SPATIAL_BLOCK_SIZE = 8;
let spatialBlockCols = 0, spatialBlockRows = 0, spatialBlockCounts = new Int32Array(0);

function _adjustSpatialBlockCount(chunkKey, owner, delta) {
    let cx = chunkKey % CHUNKS_W, cy = (chunkKey - cx) / CHUNKS_W;
    let index = (Math.floor(cy / SPATIAL_BLOCK_SIZE) * spatialBlockCols + Math.floor(cx / SPATIAL_BLOCK_SIZE)) * spatialUnitsComplexPlayerCount + owner;
    if (index >= 0 && index < spatialBlockCounts.length) spatialBlockCounts[index] += delta;
}

// Whether any unit not owned by ownerId is in chunks [minCx..maxCx] x
// [minCy..maxCy] (checked by whole blocks, so it may report true for units
// just outside; false is exact).
function _regionMayHaveEnemyUnits(ownerId, minCx, minCy, maxCx, maxCy) {
    let players = spatialUnitsComplexPlayerCount;
    if (spatialBlockCounts.length !== spatialBlockCols * spatialBlockRows * players || spatialBlockCols === 0) return true;
    let bx0 = Math.floor(minCx / SPATIAL_BLOCK_SIZE), bx1 = Math.floor(maxCx / SPATIAL_BLOCK_SIZE);
    let by0 = Math.floor(minCy / SPATIAL_BLOCK_SIZE), by1 = Math.floor(maxCy / SPATIAL_BLOCK_SIZE);
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
        let base = (by * spatialBlockCols + bx) * players;
        for (let pid = 0; pid < players; pid++) {
            if (pid !== ownerId && spatialBlockCounts[base + pid] > 0) return true;
        }
    }
    return false;
}

function _addUnitToSpatialArray(arr, u) {
    if (!arr) return false;
    // Arrays are sorted by id: a unit with a higher id than every member
    // (new units, whole rebuilds in id order) goes at the end directly.
    let n = arr.length, id = u.id;
    if (n === 0 || arr[n - 1].id < id) { arr.push(u); return true; }
    // Binary search for the first member with a higher id (ids are unique).
    let lo = 0, hi = n;
    while (lo < hi) { let mid = (lo + hi) >> 1; if (arr[mid].id < id) lo = mid + 1; else hi = mid; }
    if (lo < n && arr[lo] === u) return false;
    arr.splice(lo, 0, u);
    return true;
}

function _removeUnitFromSpatialArray(arr, u) {
    if (!arr) return false;
    let n = arr.length, id = u.id, lo = 0, hi = n;
    while (lo < hi) { let mid = (lo + hi) >> 1; if (arr[mid].id < id) lo = mid + 1; else hi = mid; }
    let i = lo < n && arr[lo] === u ? lo : arr.indexOf(u);
    if (i >= 0) {
        arr.splice(i, 1);
        return true;
    }
    return false;
}

// Area buckets also count members per owner, so enemy scans can skip areas
// that hold only the scanning player's units (e.g. a large friendly army).
// Indexed by owner (small integers): every moving unit reads it for each
// area in its attack range, every tick. Unset owners read undefined.
function _addUnitToAreaBucket(bucket, u, owner) {
    if (!_addUnitToSpatialArray(bucket, u)) return;
    let counts = bucket._ownerCounts || (bucket._ownerCounts = []);
    counts[owner] = (counts[owner] || 0) + 1;
}

function _removeUnitFromAreaBucket(bucket, u, owner) {
    if (!_removeUnitFromSpatialArray(bucket, u)) return;
    let counts = bucket._ownerCounts;
    if (!counts) return;
    let n = (counts[owner] || 0) - 1;
    counts[owner] = n > 0 ? n : undefined;
}

function getSpatialKey(wx, wy) {
    let cx = Math.floor(wx / (CHUNK_SIZE * TILE));
    let cy = Math.floor(wy / (CHUNK_SIZE * TILE));
    cx = Math.max(0, Math.min(CHUNKS_W - 1, cx));
    cy = Math.max(0, Math.min(CHUNKS_H - 1, cy));
    return cy * CHUNKS_W + cx;
}

// Replaced bucket arrays (initSpatialHash) bump this: a unit whose
// _spatialEpoch differs is in none of the current buckets.
let spatialEpoch = 1;

// Where a unit is indexed: u._spatialTile (tile index, the unit's position
// clamped to the map), u._spatialKey (chunk), u._spatialAreaId (area of the
// tile, -1 none), u._spatialOwner (owner when inserted), u._spatialEpoch.
// None of them are snapshotted (SNAP_SKIP_KEYS).
//
// Called after every move: the common case (same tile, owner and buckets)
// is one tile computation and three compares.
function updateUnitSpatial(u) {
    let fx = u.x / TILE, fy = u.y / TILE;
    let gx = Math.floor(fx), gy = Math.floor(fy);
    // Its +-0.3 tile vision window follows the zone of the tile it is in.
    let rx = fx - gx, ry = fy - gy;
    let zone = (rx < .3 ? 0 : rx < .7 ? 1 : 2) * 3 + (ry < .3 ? 0 : ry < .7 ? 1 : 2);
    if (!(gx >= 0)) gx = 0; else if (gx >= GRID_W) gx = GRID_W - 1;
    if (!(gy >= 0)) gy = 0; else if (gy >= GRID_H) gy = GRID_H - 1;
    let tile = gy * GRID_W + gx;
    simUnitMirror(u);
    if (tile === u._spatialTile && u._spatialEpoch === spatialEpoch && u._spatialOwner === u.owner) {
        if (zone !== u._spatialZone) { u._spatialZone = zone; visCoverOnUnitSpatialChanged(u); }
        return;
    }
    u._spatialZone = zone;
    _moveUnitSpatial(u, gx, gy, tile);
}

// Per chunk and owner: unit totals and per-type counts, and the 8x8 block
// totals. Adjusted only when the chunk bucket really gained or lost the unit.
function _spatialCountUnit(u, chunkKey, owner, delta) {
    if (!(owner >= 0 && owner < spatialUnitsComplexPlayerCount)) return;
    let typeIdx = u._spatialUnitTypeIdx;
    let base = chunkKey * spatialUnitsComplexStridePerChunk + owner * spatialUnitsComplexStridePerPlayer;
    spatialUnitsComplex[base] += delta;
    spatialUnitsComplex[base + 1 + typeIdx] += delta;
    _adjustSpatialBlockCount(chunkKey, owner, delta);
}

function _moveUnitSpatial(u, gx, gy, tile) {
    let chunkKey = CHUNK_SIZE === 1 ? tile : Math.floor(gy / CHUNK_SIZE) * CHUNKS_W + Math.floor(gx / CHUNK_SIZE);
    let areaRow = areaIdGrid[gy], area = areaRow ? areaRow[gx] : -1;
    if (!(area >= 0 && area < spatialUnitsByArea.length)) area = -1;
    let owner = u.owner;
    let indexed = u._spatialEpoch === spatialEpoch && u._spatialKey !== undefined;
    let oldKey = indexed ? u._spatialKey : -1, oldArea = indexed ? u._spatialAreaId : -1, oldOwner = indexed ? u._spatialOwner : -1;
    let ownerChanged = indexed && oldOwner !== owner;
    if (indexed && (oldKey !== chunkKey || ownerChanged)) {
        if (_removeUnitFromSpatialArray(spatialUnits[oldKey], u)) _spatialCountUnit(u, oldKey, oldOwner, -1);
    }
    if (indexed && oldArea >= 0 && (oldArea !== area || ownerChanged)) _removeUnitFromAreaBucket(spatialUnitsByArea[oldArea], u, oldOwner);
    if (!indexed || oldKey !== chunkKey || ownerChanged) {
        if (!indexed || ownerChanged || u._spatialUnitTypeIdx === undefined) {
            let typeIdx = spatialUnitTypeToIndex[u.unitType];
            u._spatialUnitTypeIdx = typeIdx >= 0 ? typeIdx : spatialNormUnitTypeIndex;
        }
        if (_addUnitToSpatialArray(spatialUnits[chunkKey], u)) _spatialCountUnit(u, chunkKey, owner, 1);
    }
    if (area >= 0 && (!indexed || oldArea !== area || ownerChanged)) _addUnitToAreaBucket(spatialUnitsByArea[area], u, owner);
    u._spatialTile = tile;
    u._spatialKey = chunkKey;
    u._spatialAreaId = area;
    u._spatialOwner = owner;
    u._spatialEpoch = spatialEpoch;
    simUnitSetSepKey(u, chunkKey, u.isFlying ? 1 : (u.unitType === 'mole' ? 2 : 0));
    visCoverOnUnitSpatialChanged(u);
}

function removeUnitSpatial(u) {
    let indexed = u._spatialEpoch === spatialEpoch && u._spatialKey !== undefined;
    if (indexed) {
        if (_removeUnitFromSpatialArray(spatialUnits[u._spatialKey], u)) _spatialCountUnit(u, u._spatialKey, u._spatialOwner, -1);
        let area = u._spatialAreaId;
        if (area >= 0 && area < spatialUnitsByArea.length) _removeUnitFromAreaBucket(spatialUnitsByArea[area], u, u._spatialOwner);
    }
    u._spatialKey = undefined;
    u._spatialAreaId = undefined;
    u._spatialTile = -1;
    u._spatialEpoch = 0;
    simUnitSetSepKey(u, SIM_SEP_ABSENT, 0);
    if (indexed) visCoverOnUnitSpatialChanged(u);
}

// The area layout was rebuilt (new area buckets): every indexed unit joins
// the bucket of its tile's area, in id order.
function rebuildUnitAreaBuckets() {
    let sorted = units.filter(u => u && u._spatialEpoch === spatialEpoch && u._spatialKey !== undefined).sort((a, b) => a.id - b.id);
    for (let u of sorted) {
        let t = u._spatialTile, gx = t % GRID_W, gy = (t - gx) / GRID_W;
        let row = areaIdGrid[gy], area = row ? row[gx] : -1;
        if (!(area >= 0 && area < spatialUnitsByArea.length)) area = -1;
        u._spatialAreaId = area;
        if (area >= 0) _addUnitToAreaBucket(spatialUnitsByArea[area], u, u._spatialOwner);
    }
}

function forEachUnitInAreaRange(wx, wy, rangeAreaUnits, visitor, opts = null) {
    if (typeof visitor !== 'function') return false;
    let sources = getSourceAreaIdsAtWorld(wx, wy);
    if (sources.length === 0) return false;
    let numericRangeArea = Math.max(0, Number(rangeAreaUnits) || 0);
    let maxDistance = Math.max(0, Math.ceil(numericRangeArea));
    let maxRangePx = numericRangeArea * AREA_UNIT_TILE_EQUIVALENT * TILE;
    let includeDead = !!(opts && opts.includeDead);
    let predicate = (opts && typeof opts.predicate === 'function') ? opts.predicate : null;
    let playerFilter = Number.isFinite(opts && opts.player) ? Math.floor(opts.player) : -1;
    let enemyFilter = Number.isFinite(opts && opts.enemyOfPlayer) ? Math.floor(opts.enemyOfPlayer) : -1;
    // Enemies only: no enemy unit in the tiles those areas cover (per-block
    // counts), nothing to visit (O(1) before walking the areas).
    if (enemyFilter >= 0 && !includeDead) {
        let box = getAreaRangeTileBox(sources, maxDistance), cs = CHUNK_SIZE;
        if (box[2] < 0 || !_regionMayHaveEnemyUnits(enemyFilter, Math.floor(box[0] / cs), Math.floor(box[1] / cs), Math.floor(box[2] / cs), Math.floor(box[3] / cs))) return false;
    }
    let unitTypeFilter = (opts && typeof opts.unitType === 'string' && opts.unitType.length > 0) ? opts.unitType : '';
    let areaOnly = !!(opts && opts.areaOnly);
    let areaIds = getAreaIdsWithinDistanceOfSources(sources, maxDistance);
    if (!areaIds || areaIds.length <= 0) return false;


    for (let i = 0; i < areaIds.length; i++) {
        let areaId = areaIds[i];
        let bucket = spatialUnitsByArea[areaId];
        if (!bucket || bucket.length <= 0) continue;
        if (enemyFilter >= 0 && bucket._ownerCounts && bucket._ownerCounts[enemyFilter] === bucket.length) continue;
        for (let u of bucket) {
            if (!includeDead && u.dead) continue;
            if (playerFilter >= 0 && u.owner !== playerFilter) continue;
            if (enemyFilter >= 0 && u.owner === enemyFilter) continue;
            if (unitTypeFilter && u.unitType !== unitTypeFilter) continue;
            let dx = (Number(u.x) || 0) - wx;
            let dy = (Number(u.y) || 0) - wy;
            let hitRadius = Math.max(0, Number(u.r) || 0);
            let maxHitRangePx = maxRangePx + hitRadius;
            if (!areaOnly && (dx * dx + dy * dy) > (maxHitRangePx * maxHitRangePx)) continue;
            if (predicate && !predicate(u)) continue;
            if (visitor(u, areaId) === true) return true;
        }
    }
    return false;
}

function forEachGridCellInAreaRange(wx, wy, rangeAreaUnits, visitor) {
    if (typeof visitor !== 'function') return false;
    let sources = getSourceAreaIdsAtWorld(wx, wy);
    if (sources.length === 0) return false;
    let sourceAreaId = sources[0];
    let maxDistance = Math.max(0, Math.floor(Number(rangeAreaUnits) || 0));
    let cells = getGridCellsWithinDistanceOfSources(sources, maxDistance);
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

// Chunks holding enemies, as (distance², key) pairs: reused scratch.
const _closestEnemyChunkScratch = [];

// Closest visible enemy unit in the nearest chunk holding enemies (as it
// always was). When that chunk has none visible within range, the other
// chunks in range are searched, nearest first: otherwise an unseen or
// out-of-range enemy there hid a visible one nearby, and the unit stood
// among enemies without engaging.
function _computeClosestEnemyUnitByChunks(ownerId, wx, wy, rangeSq, minCx, minCy, maxCx, maxCy, cws) {
    let candidates = _closestEnemyChunkScratch, count = 0;
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
            // Stable insertion by distance² (scan order breaks ties, so the
            // first entry is the chunk the original scan chose).
            let i = count++;
            while (i > 0 && candidates[(i - 1) * 2] > chunkD2) {
                candidates[i * 2] = candidates[(i - 1) * 2];
                candidates[i * 2 + 1] = candidates[(i - 1) * 2 + 1];
                i--;
            }
            candidates[i * 2] = chunkD2;
            candidates[i * 2 + 1] = ck;
        }
    }

    for (let c = 0; c < count; c++) {
        let chunk = spatialUnits[candidates[c * 2 + 1]];
        if (!chunk || chunk.length <= 0) continue;
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
        if (best) return best;
    }
    return null;
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
    // No enemy anywhere near: every path below would return null.
    if (!_regionMayHaveEnemyUnits(ownerId, minCx, minCy, maxCx, maxCy)) return null;

    let centerCx = Math.max(0, Math.min(CHUNKS_W - 1, Math.floor(wx / cws)));
    let centerCy = Math.max(0, Math.min(CHUNKS_H - 1, Math.floor(wy / cws)));
    let centerChunkId = centerCy * CHUNKS_W + centerCx;

    let tps = Math.max(1, Math.floor(Number(TICK_RATE) || 1));
    let rangeKey = Math.max(0, Math.floor(r));
    // Numeric key (exact below 2^53): string keys dominated this hot lookup.
    let cacheKey = ownerId + 16 * (minCx + 1024 * (minCy + 1024 * (maxCx + 1024 * (maxCy + 1024 * Math.min(rangeKey, 4095)))));
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
