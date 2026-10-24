// GLOBAL STATE
// ============================================================
let dirtyGrid = true, dirtyAreas = true;
let visibilityGrid = [];
let visibilityGridByPlayer = Array.from({ length: 8 }, () => []);
let visibilityVersion = 0;
let fullVisibility = false;
// The match's visibility setting, fixed at match start. `fullVisibility` is
// this client's view and turns on locally for spectators, so simulation code
// must use this instead.
let matchFullVisibility = false;

let grid = []; // 2D array [y][x] = {type, item, owner, areaId}
let areas = [];
let goldMines = []; // {gx, gy, gold, maxGold}
let astarMines = []; // {gx, gy, astar, maxAstar}
let areaNeighborIds = []; // [areaId] -> [neighborAreaId]
let areaDistanceMatrix = []; // [areaId] -> Map(areaId -> steps) of the areas reached so far
let areaIdsByDistance = []; // [areaId][distance] -> [areaId]
let areaIdsWithinDistance = []; // [areaId][distance] -> [areaId]
let areaIdGrid = []; // 2D lookup [y][x] -> areaId
let gridCellsByArea = []; // [areaId] -> [{x,y}]
let gridCellsByAreaDistance = []; // [areaId][distance] -> [{x,y}]
let gridCellsWithinAreaDistance = []; // [areaId][distance] -> [{x,y}]
let spatialUnitsByArea = []; // [areaId] -> [Unit]
let droppedItemsByArea = []; // [areaId] -> [drop]

const TILE_ENTITY_NONE = '';
const TILE_ENTITY_GOLDMINE = 'goldmine';
const TILE_ENTITY_ASTARMINE = 'astarmine';
let tileEntityType = []; // 2D lookup [y][x] -> string type
let tileEntityRef = [];  // 2D lookup [y][x] -> entity reference
let _activeTileEntities = new Set();
let _tileEntityVersion = 0; // bumped whenever the tile entity index changes
// Tiles whose adjacency is to be worked out again (_runAdjacencyRecalculation
// takes them lowest tile first, ADJACENCY_TILES_PER_TICK a tick): a flag per
// tile, their count, the lowest flagged tile (nothing below it is flagged)
// and the order-free sum the state hash takes (sum of (k + 1) * 2654435761),
// kept as tiles come and go. (A Set copied and sorted every tick cost ~60 ms
// with 230k tiles waiting after a mass placement.) Set-like: add, delete,
// has, size, clear, iteration (ascending).
class _AdjDirtySet {
    // (blk: flagged tiles per 256: empty stretches skipped by takeFirst and
    // the iteration; scanning the flags of a 1M-tile map was ~1 ms a tick.)
    constructor() { this.flag = new Uint8Array(0); this.blk = new Int32Array(0); this.n = 0; this.min = 0; this.sum = 0; }
    get size() { return this.n; }
    has(k) { return k >= 0 && k < this.flag.length && this.flag[k] === 1; }
    add(k) {
        k = k | 0;
        if (k < 0) return this;
        if (k >= this.flag.length) {
            const f = new Uint8Array(Math.max(k + 1, GRID_W * GRID_H, this.flag.length * 2)); f.set(this.flag); this.flag = f;
            const b = new Int32Array((f.length + 255) >> 8); b.set(this.blk); this.blk = b;
        }
        if (this.flag[k]) return this;
        this.flag[k] = 1; this.blk[k >> 8]++;
        if (this.n++ === 0 || k < this.min) this.min = k;
        this.sum = (this.sum + Math.imul(k + 1, 2654435761)) | 0;
        return this;
    }
    delete(k) {
        if (!this.has(k)) return false;
        this.flag[k] = 0; this.n--; this.blk[k >> 8]--;
        this.sum = (this.sum - Math.imul(k + 1, 2654435761)) | 0;
        return true;
    }
    clear() { if (this.n) { this.flag.fill(0); this.blk.fill(0); } this.n = 0; this.min = 0; this.sum = 0; }
    // The first `max` tiles by index, taken out.
    takeFirst(max) {
        const out = [], f = this.flag, B = this.blk;
        let k = this.min;
        for (; k < f.length && out.length < max && this.n > 0; k++) {
            if ((k & 255) === 0) while (k < f.length && B[k >> 8] === 0) k += 256;
            if (k >= f.length) break;
            if (!f[k]) continue;
            f[k] = 0; this.n--; B[k >> 8]--;
            this.sum = (this.sum - Math.imul(k + 1, 2654435761)) | 0;
            out.push(k);
        }
        this.min = k;
        return out;
    }
    *[Symbol.iterator]() { const f = this.flag, B = this.blk; let left = this.n; for (let k = this.min; k < f.length && left > 0; k++) { if ((k & 255) === 0) while (k < f.length && B[k >> 8] === 0) k += 256; if (k >= f.length) break; if (f[k]) { left--; yield k; } } }
}
let _adjacencyDirtyTiles = new _AdjDirtySet();
let _adjacencyNeedsRecalc = true;
let _adjacencyDirtyAll = true;
let _adjacencyLastRecalcTick = -1;
let _adjacencyPassiveRefreshMode = false;

function resetAreaDistanceCaches() {
    areaNeighborIds = [];
    areaDistanceMatrix = [];
    areaIdsByDistance = [];
    areaIdsWithinDistance = [];
    areaIdGrid = [];
    gridCellsByArea = [];
    gridCellsByAreaDistance = [];
    gridCellsWithinAreaDistance = [];
    spatialUnitsByArea = [];
    droppedItemsByArea = [];
}

function _ensureArrayBucketsLength(list, length, factory) {
    if (!Array.isArray(list)) list = [];
    while (list.length < length) list.push(factory());
    return list;
}

function _addDroppedItemToAreaBucket(drop, areaId) {
    let aId = Math.floor(Number(areaId));
    if (!drop || aId < 0) return;
    droppedItemsByArea = _ensureArrayBucketsLength(droppedItemsByArea, aId + 1, () => []);
    let bucket = droppedItemsByArea[aId];
    if (!Array.isArray(bucket)) bucket = droppedItemsByArea[aId] = [];
    if (bucket.indexOf(drop) === -1) bucket.push(drop);
    drop._areaBucketId = aId;
}

function _removeDroppedItemFromAreaBucket(drop) {
    if (!drop) return;
    let aId = Math.floor(Number(drop._areaBucketId));
    if (!(aId >= 0 && aId < droppedItemsByArea.length)) {
        delete drop._areaBucketId;
        return;
    }
    let bucket = droppedItemsByArea[aId];
    if (Array.isArray(bucket)) {
        let index = bucket.indexOf(drop);
        if (index >= 0) bucket.splice(index, 1);
    }
    delete drop._areaBucketId;
}

function rebuildAreaDistanceCachesFromAreas() {
    _areaById = [];
    let maxId = -1;
    if (Array.isArray(areas)) {
        for (let a of areas) {
            if (!a) continue;
            let aid = Number(a.id);
            if (Number.isFinite(aid)) maxId = Math.max(maxId, aid);
        }
    }
    let areaCount = maxId + 1;
    areaIdGrid = Array.from({ length: GRID_H }, () => new Int32Array(GRID_W).fill(-1));
    if (areaCount <= 0) {
        resetAreaDistanceCaches();
        return;
    }


    let neighborSets = Array.from({ length: areaCount }, () => new Set());


    for (let y = 0; y < GRID_H; y++) {
        let row = grid[y];
        if (!row) continue;
        for (let x = 0; x < GRID_W; x++) {
            let cell = row[x];
            if (!cell) continue;
            let areaId = Math.floor(Number(cell.areaId));
            areaIdGrid[y][x] = areaId;
        }
    }

    // Authoritatively populate areaId mapping from the snapshotted areas.
    // This is critical for multiplayer resyncs where the grid may have lost its areaId properties.
    for (let area of areas) {
        let aid = Number(area && area.id);
        if (!Number.isFinite(aid)) continue;
        _areaById[aid] = area;
        if (Array.isArray(area.cells)) {
            for (let i = 0; i < area.cells.length; i++) {
                let c = area.cells[i];
                if (!c) continue;
                if (c.x >= 0 && c.x < GRID_W && c.y >= 0 && c.y < GRID_H) {
                    if (grid[c.y] && grid[c.y][c.x]) grid[c.y][c.x].areaId = aid;
                    if (areaIdGrid[c.y]) areaIdGrid[c.y][c.x] = aid;
                }
            }
        }
    }

    let neighborTotal = 0;
    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            let areaId = areaIdGrid[y][x];
            if (!(areaId >= 0 && areaId < areaCount)) continue;

            if (x + 1 < GRID_W) {
                let rightId = areaIdGrid[y][x + 1];
                if (rightId >= 0 && rightId < areaCount && rightId !== areaId) {
                    if (!neighborSets[areaId].has(rightId)) neighborTotal++;
                    neighborSets[areaId].add(rightId);
                    neighborSets[rightId].add(areaId);
                }
            }
            if (y + 1 < GRID_H) {
                let downId = areaIdGrid[y + 1] ? areaIdGrid[y + 1][x] : -1;
                if (downId >= 0 && downId < areaCount && downId !== areaId) {
                    if (!neighborSets[areaId].has(downId)) neighborTotal++;
                    neighborSets[areaId].add(downId);
                    neighborSets[downId].add(areaId);
                }
            }
        }
    }


    areaNeighborIds = new Array(areaCount);
    areaDistanceMatrix = new Array(areaCount);
    _areaBfsDone = new Array(areaCount);
    areaIdsByDistance = new Array(areaCount);
    areaIdsWithinDistance = new Array(areaCount);
    gridCellsByArea = new Array(areaCount);
    gridCellsByAreaDistance = new Array(areaCount);
    gridCellsWithinAreaDistance = new Array(areaCount);
    // A new layout: fresh buckets, every indexed unit in its tile's area.
    spatialUnitsByArea = Array.from({ length: areaCount }, () => []);
    if (typeof rebuildUnitAreaBuckets === 'function') rebuildUnitAreaBuckets();
    droppedItemsByArea = Array.from({ length: areaCount }, () => []);
    for (let i = 0; i < droppedItems.length; i++) {
        let drop = droppedItems[i];
        if (!drop) continue;
        _addDroppedItemToAreaBucket(drop, getAreaIdAtTile(drop.gx, drop.gy));
    }

    for (let source = 0; source < areaCount; source++) {
        let neighbors = _areaById[source] ? Array.from(neighborSets[source] || []).sort((a, b) => a - b) : [];
        areaNeighborIds[source] = neighbors;
        if (_areaById[source]) _areaById[source].neighborAreaIds = neighbors;
        gridCellsByArea[source] = (_areaById[source] && Array.isArray(_areaById[source].cells)) ? _areaById[source].cells.slice() : [];
    }
    // Distance rows and the per-distance area/cell lists are built lazily per
    // source area and distance (see _ensureAreaDistanceRow). Building every
    // row eagerly, with cumulative cell copies per distance, took seconds on
    // huge maps.
}

let _areaBfsDone = []; // [areaId] -> true once the BFS from it is exhausted

// BFS over the area graph from one source, expanded one level at a time on
// demand: range queries need only a few levels, and a full BFS per newly
// visited area stalled large maps. Each level lists its areas by ascending
// id, exactly as a complete BFS would, so results never depend on when (or
// on which peer) a level was first requested. Unreached areas are absent.
function _ensureAreaDistanceRow(source, depth = Infinity) {
    if (!(source >= 0 && source < areaDistanceMatrix.length)) return null;
    let row = areaDistanceMatrix[source];
    if (row === null) return null;
    if (row === undefined) {
        if (!_areaById[source]) {
            areaDistanceMatrix[source] = null;
            areaIdsByDistance[source] = [];
            areaIdsWithinDistance[source] = [];
            gridCellsByAreaDistance[source] = [];
            gridCellsWithinAreaDistance[source] = [];
            return null;
        }
        // Sparse: a full row per source area (areas x areas in all) cost
        // more to allocate than the few levels range queries expand.
        row = new Map();
        row.set(source, 0);
        areaDistanceMatrix[source] = row;
        areaIdsByDistance[source] = [[source]];
        areaIdsWithinDistance[source] = [];
        gridCellsByAreaDistance[source] = [];
        gridCellsWithinAreaDistance[source] = [];
        _areaBfsDone[source] = false;
    }
    let levels = areaIdsByDistance[source];
    while (!_areaBfsDone[source] && levels.length - 1 < depth) {
        let last = levels[levels.length - 1], distance = levels.length, next = [];
        for (let current of last) {
            let neighbors = areaNeighborIds[current];
            if (!neighbors) continue;
            for (let n of neighbors) {
                if (row.has(n)) continue;
                row.set(n, distance);
                next.push(n);
            }
        }
        if (next.length === 0) { _areaBfsDone[source] = true; break; }
        next.sort((x, y) => x - y);
        levels.push(next);
    }
    return row;
}

function _getAreaGridCellsAtDistance(source, dist) {
    let cached = gridCellsByAreaDistance[source][dist];
    if (cached) return cached;
    let cells = [];
    for (let targetAreaId of areaIdsByDistance[source][dist]) {
        let targetArea = _areaById[targetAreaId];
        if (!targetArea || !Array.isArray(targetArea.cells)) continue;
        for (let cell of targetArea.cells) if (cell) cells.push(cell);
    }
    gridCellsByAreaDistance[source][dist] = cells;
    return cells;
}

// Cumulative lists (distance 0..dist, in distance order) built on demand.
function _getAreaCumulative(source, dist, cache, atDistance) {
    let cached = cache[dist];
    if (cached) return cached;
    let from = dist;
    while (from > 0 && !cache[from - 1]) from--;
    let list = from > 0 ? cache[from - 1] : [];
    for (let d = from; d <= dist; d++) {
        let part = atDistance(d);
        list = part.length > 0 ? list.concat(part) : list.slice();
        cache[d] = list;
    }
    return list;
}

function getAreaIdAtTile(gx, gy) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return -1;
    let row = areaIdGrid[gy];
    if (!row) return -1;
    let areaId = Math.floor(Number(row[gx]));
    return areaId >= 0 ? areaId : -1;
}

function getAreaIdAtWorld(wx, wy) {
    let gx = Math.floor(Number(wx) / TILE);
    let gy = Math.floor(Number(wy) / TILE);
    return getAreaIdAtTile(gx, gy);
}

// Share border coverage between visibility and its range outline. No per-unit
// state: at most four nearby tiles, merged into the existing area-source map.
function addVisibilitySourceAreas(sources, wx, wy, range, light = null) {
    // (Whole area steps: 0 is its own area.)
    if (!(range >= 0) || !Number.isFinite(wx) || !Number.isFinite(wy)) return;
    const x = wx / TILE, y = wy / TILE;
    const minX = Math.floor(x - .3), maxX = Math.floor(x + .3);
    const minY = Math.floor(y - .3), maxY = Math.floor(y + .3);
    const centerArea = light ? getAreaIdAtTile(Math.floor(x), Math.floor(y)) : -1;
    for (let gy = minY; gy <= maxY; gy++) for (let gx = minX; gx <= maxX; gx++) {
        const area = getAreaIdAtTile(gx, gy);
        if (area < 0) continue;
        const had = sources.get(area);
        sources.set(area, had === undefined ? range : Math.max(had, range));
        // Start the neighboring area's fade before the center crosses into it.
        // Stamping only across area borders preserves normal within-area light.
        if (light && area !== centerArea) {
            light[gy][gx] = Math.max(light[gy][gx], areaStepsVisionTiles(range));
        }
    }
}

// Areas a source at a world position ranges from: every area under its
// +-0.3 tile window, the window visibility and the range overlay stamp, so
// gameplay ranges match what is drawn. Ascending ids. A single-area result
// is a shared array: callers must not modify it.
// Every distinct list has a small integer id (0: empty) for state kept
// in typed arrays: _sourceAreaListById[id].
const _EMPTY_SOURCE_AREAS = Object.freeze([]);
const _sourceAreaListById = [_EMPTY_SOURCE_AREAS];
let _singleSourceAreaIds = [];
let _sourceAreaPairs = new Map();
const _sourceAreaScratch = new Int32Array(4);
const _sourceAreaListIds = new Map([[_EMPTY_SOURCE_AREAS, 0]]);
function _sourceAreaListIdOf(list) {
    const id = _sourceAreaListIds.get(list);
    return id === undefined ? 0 : id;
}
function _newSourceAreaList(list) {
    const id = _sourceAreaListById.length;
    _sourceAreaListById.push(list); _sourceAreaListIds.set(list, id);
    return id;
}
function getSourceAreaIdsAtWorld(wx, wy) {
    return _sourceAreaListById[getSourceAreaListIdAtWorld(wx, wy)];
}
// The window is decided by the tile and which third of it (per axis) the
// position is in (below .3: the tile before as well, above .7: the next),
// so the ids are kept per tile and zone (filled on first use, for the
// current area grid).
let _sourceAreaZoneIds = null, _sourceAreaZoneGrid = null, _sourceAreaZoneAdm = null;
// The table of ids by tile and zone, current for the area grid (made empty
// when it changed); null before the first use.
function sourceAreaZoneTable() {
    getSourceAreaListIdAtWorld(TILE * 0.5, TILE * 0.5);
    return _sourceAreaZoneIds;
}
function getSourceAreaListIdAtWorld(wx, wy) {
    const x = Number(wx) / TILE, y = Number(wy) / TILE;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    const gx = Math.floor(x), gy = Math.floor(y);
    const rx = x - gx, ry = y - gy;
    const zx = rx < .3 ? 0 : rx < .7 ? 1 : 2, zy = ry < .3 ? 0 : ry < .7 ? 1 : 2;
    if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return _sourceAreaListIdOfWindow(gx - (zx === 0 ? 1 : 0), gx + (zx === 2 ? 1 : 0), gy - (zy === 0 ? 1 : 0), gy + (zy === 2 ? 1 : 0));
    let T = _sourceAreaZoneIds;
    if (!T || _sourceAreaZoneGrid !== areaIdGrid || _sourceAreaZoneAdm !== areaDistanceMatrix || T.length !== GRID_W * GRID_H * 9) {
        // (Shared, for kernels.)
        if (T && T.length === GRID_W * GRID_H * 9) T.fill(0);
        else { T = _sourceAreaZoneIds = simSharedArray(Int32Array, GRID_W * GRID_H * 9); simParallelBind('vis.zoneIds', T); }
        _sourceAreaZoneGrid = areaIdGrid; _sourceAreaZoneAdm = areaDistanceMatrix;
    }
    const k = (gy * GRID_W + gx) * 9 + zx * 3 + zy;
    let id = T[k] - 1;
    if (id < 0) { id = _sourceAreaListIdOfWindow(gx - (zx === 0 ? 1 : 0), gx + (zx === 2 ? 1 : 0), gy - (zy === 0 ? 1 : 0), gy + (zy === 2 ? 1 : 0)); T[k] = id + 1; }
    return id;
}
function _sourceAreaListIdOfWindow(minX, maxX, minY, maxY) {
    // At most four tiles: distinct areas collected in ascending order.
    const ids = _sourceAreaScratch;
    let n = 0;
    for (let gy = minY; gy <= maxY; gy++) for (let gx = minX; gx <= maxX; gx++) {
        const area = getAreaIdAtTile(gx, gy);
        if (area < 0) continue;
        let i = 0;
        while (i < n && ids[i] < area) i++;
        if (i < n && ids[i] === area) continue;
        for (let j = n; j > i; j--) ids[j] = ids[j - 1];
        ids[i] = area; n++;
    }
    if (n === 0) return 0;
    if (n === 1) {
        let id = _singleSourceAreaIds[ids[0]];
        if (id === undefined) { id = _singleSourceAreaIds[ids[0]] = _newSourceAreaList(Object.freeze([ids[0]])); }
        return id;
    }
    // Several areas (a window across borders): one shared frozen list per
    // set of areas, found through nested maps (no allocation once seen).
    let key = ids[0] * 1048576 + ids[1];
    let node = _sourceAreaPairs.get(key);
    if (!node) _sourceAreaPairs.set(key, node = { id: 0, more: null });
    for (let k = 2; k < n; k++) {
        if (!node.more) node.more = new Map();
        let next = node.more.get(ids[k]);
        if (!next) node.more.set(ids[k], next = { id: 0, more: null });
        node = next;
    }
    if (node.id === 0) node.id = _newSourceAreaList(Object.freeze(Array.prototype.slice.call(ids, 0, n)));
    return node.id;
}

// Union of the areas within `distance` of any source area, each once: the
// first source's list in its order, then areas only the next ones add.
// Two-area windows (units near an area border) are common: their unions are
// cached per distance until the area caches are rebuilt.
let _sourcePairUnions = new Map(), _sourcePairUnionsFor = null;
function getAreaIdsWithinDistanceOfSources(sources, distance) {
    if (sources.length === 1) return getAreaIdsWithinDistance(sources[0], distance);
    let byPair = null, pairKey = 0;
    if (sources.length === 2) {
        if (_sourcePairUnionsFor !== areaIdsWithinDistance) { _sourcePairUnions = new Map(); _sourcePairUnionsFor = areaIdsWithinDistance; }
        byPair = _sourcePairUnions.get(distance);
        if (!byPair) _sourcePairUnions.set(distance, byPair = new Map());
        pairKey = sources[0] * areaDistanceMatrix.length + sources[1];
        let cached = byPair.get(pairKey);
        if (cached) return cached;
    }
    let seen = new Set(), out = [];
    for (let source of sources) for (let id of getAreaIdsWithinDistance(source, distance)) {
        if (!seen.has(id)) { seen.add(id); out.push(id); }
    }
    if (byPair) byPair.set(pairKey, out);
    return out;
}

function getGridCellsWithinDistanceOfSources(sources, distance) {
    if (sources.length === 1) return getGridCellsWithinAreaDistance(sources[0], distance);
    let cells = [];
    for (let id of getAreaIdsWithinDistanceOfSources(sources, distance)) {
        let areaCells = gridCellsByArea[id];
        if (areaCells) for (let cell of areaCells) if (cell) cells.push(cell);
    }
    return cells;
}

// Whether a target at a world position is within `maxDistance` area steps of
// a source at another: any source window area counts, the target's own tile
// decides its area.
function isWorldTargetWithinAreaRange(sourceX, sourceY, targetX, targetY, maxDistance) {
    // (Up to 2 steps: the kernels' answer, the same one, without the maps.)
    const fast = typeof simAreaRangeFast === 'function' ? simAreaRangeFast(Number(sourceX), Number(sourceY), Number(targetX), Number(targetY), maxDistance) : -1;
    if (fast >= 0) return fast === 1;
    let targetAreaId = getAreaIdAtWorld(targetX, targetY);
    if (targetAreaId < 0) return false;
    for (let source of getSourceAreaIdsAtWorld(sourceX, sourceY)) {
        if (isAreaWithinDistance(source, targetAreaId, maxDistance)) return true;
    }
    return false;
}

function getAreaDistance(areaA, areaB) {
    let aId = Math.floor(Number(areaA));
    let bId = Math.floor(Number(areaB));
    if (aId < 0 || bId < 0 || aId >= areaDistanceMatrix.length) return -1;
    let row = _ensureAreaDistanceRow(aId, 0);
    if (!row || bId >= areaDistanceMatrix.length) return -1;
    while (!row.has(bId) && !_areaBfsDone[aId]) _ensureAreaDistanceRow(aId, areaIdsByDistance[aId].length);
    let d = row.get(bId);
    return d === undefined ? -1 : d;
}

// Whether areaB is at most maxDistance steps from areaA. Equivalent to
// 0 <= getAreaDistance(a, b) <= maxDistance, expanding only that far.
function isAreaWithinDistance(areaA, areaB, maxDistance) {
    let aId = Math.floor(Number(areaA));
    let bId = Math.floor(Number(areaB));
    if (aId < 0 || bId < 0 || aId >= areaDistanceMatrix.length || !(maxDistance >= 0)) return false;
    let limit = Math.floor(maxDistance);
    let row = _ensureAreaDistanceRow(aId, limit);
    if (!row || bId >= areaDistanceMatrix.length) return false;
    let d = row.get(bId);
    return d !== undefined && d <= limit;
}

function getAreaIdsAtDistance(areaId, distance) {
    let aId = Math.floor(Number(areaId));
    let dist = Math.max(0, Math.floor(Number(distance) || 0));
    if (!_ensureAreaDistanceRow(aId, dist)) return [];
    let buckets = areaIdsByDistance[aId];
    if (!buckets || !buckets[dist]) return [];
    return buckets[dist];
}

function getAreaIdsWithinDistance(areaId, distance) {
    let aId = Math.floor(Number(areaId));
    let dist = Math.max(0, Math.floor(Number(distance) || 0));
    if (!_ensureAreaDistanceRow(aId, dist)) return [];
    let buckets = areaIdsByDistance[aId];
    if (!buckets || buckets.length <= 0) return [];
    if (dist >= buckets.length) dist = buckets.length - 1;
    return _getAreaCumulative(aId, dist, areaIdsWithinDistance[aId], d => buckets[d]);
}

// Tile bounding box [minGx, minGy, maxGx, maxGy] of every area within
// `distance` steps of the source areas (cached per area and distance with
// the distance rows): an O(1) bound for "anything hostile in range?" checks
// before walking the areas themselves.
let _areaRangeBoxes = null, _areaRangeBoxesFor = null;
const _areaRangeBoxScratch = new Int32Array(4);
// Per distance: 4 ints per area (min gx, min gy, max gx, max gy); an empty
// box (max < 0) marks "not computed yet" (every area holds a tile).
function _areaRangeBoxRow(dist) {
    if (_areaRangeBoxesFor !== areaIdsWithinDistance) { _areaRangeBoxes = []; _areaRangeBoxesFor = areaIdsWithinDistance; }
    let row = _areaRangeBoxes[dist];
    if (!row || row.length !== _areaById.length * 4) {
        row = _areaRangeBoxes[dist] = new Int32Array(_areaById.length * 4);
        for (let i = 2; i < row.length; i += 4) { row[i] = -1; }
    }
    return row;
}
function getAreaRangeTileBox(sources, distance) {
    let out = _areaRangeBoxScratch;
    out[0] = GRID_W; out[1] = GRID_H; out[2] = -1; out[3] = -1;
    let dist = Math.max(0, Math.min(63, Math.floor(Number(distance) || 0)));
    let row = _areaRangeBoxRow(dist);
    for (let k = 0; k < sources.length; k++) {
        let aId = sources[k], o = aId * 4;
        if (!(aId >= 0 && o < row.length)) continue;
        // (The movement kernels' table, made for the whole layout on the
        // helpers, holds the same boxes: unit.js simMoveAreaBoxRead.)
        if (row[o + 2] < 0 && typeof simMoveAreaBoxRead === 'function') simMoveAreaBoxRead(aId, dist, row, o);
        if (row[o + 2] < 0) {
            let x0 = GRID_W, y0 = GRID_H, x1 = -1, y1 = -1;
            for (let id of getAreaIdsWithinDistance(aId, dist)) {
                let a = _areaById[id];
                if (!a) continue;
                if (a.minGx < x0) x0 = a.minGx;
                if (a.minGy < y0) y0 = a.minGy;
                if (a.maxGx > x1) x1 = a.maxGx;
                if (a.maxGy > y1) y1 = a.maxGy;
            }
            row[o] = x0; row[o + 1] = y0; row[o + 2] = x1; row[o + 3] = y1;
            if (x1 < 0) continue;
        }
        if (row[o] < out[0]) out[0] = row[o];
        if (row[o + 1] < out[1]) out[1] = row[o + 1];
        if (row[o + 2] > out[2]) out[2] = row[o + 2];
        if (row[o + 3] > out[3]) out[3] = row[o + 3];
    }
    return out;
}

function getGridCellsAtAreaDistance(areaId, distance) {
    let aId = Math.floor(Number(areaId));
    let dist = Math.max(0, Math.floor(Number(distance) || 0));
    if (!_ensureAreaDistanceRow(aId, dist)) return [];
    if (!areaIdsByDistance[aId][dist]) return [];
    return _getAreaGridCellsAtDistance(aId, dist);
}

function getGridCellsWithinAreaDistance(areaId, distance) {
    let aId = Math.floor(Number(areaId));
    let dist = Math.max(0, Math.floor(Number(distance) || 0));
    if (!_ensureAreaDistanceRow(aId, dist)) return [];
    let buckets = areaIdsByDistance[aId];
    if (!buckets || buckets.length <= 0) return [];
    if (dist >= buckets.length) dist = buckets.length - 1;
    return _getAreaCumulative(aId, dist, gridCellsWithinAreaDistance[aId], d => _getAreaGridCellsAtDistance(aId, d));
}

function getDroppedItemsWithinAreaDistance(areaId, distance) {
    let areaIds = getAreaIdsWithinDistance(areaId, distance);
    if (!areaIds || areaIds.length <= 0) return [];
    let drops = [];
    for (let i = 0; i < areaIds.length; i++) {
        let bucket = droppedItemsByArea[areaIds[i]];
        if (Array.isArray(bucket) && bucket.length > 0) drops = drops.concat(bucket);
    }
    return drops;
}

function _adjTileKey(gx, gy) {
    return gy * GRID_W + gx;
}

function _markAdjacencyDirtyAt(gx, gy, pad = 0) {
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) return;
    let p = Math.max(0, Math.floor(Number(pad) || 0));
    let minX = Math.max(0, Math.floor(gx) - p);
    let maxX = Math.min(GRID_W - 1, Math.floor(gx) + p);
    let minY = Math.max(0, Math.floor(gy) - p);
    let maxY = Math.min(GRID_H - 1, Math.floor(gy) + p);
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            _adjacencyDirtyTiles.add(_adjTileKey(x, y));
        }
    }
    _adjacencyNeedsRecalc = true;
}

function requestAdjacencyRecalc(gx = null, gy = null, pad = 1) {
    if (Number.isFinite(gx) && Number.isFinite(gy)) {
        _markAdjacencyDirtyAt(gx, gy, pad);
    } else {
        _adjacencyDirtyAll = true;
        _adjacencyNeedsRecalc = true;
    }
}

function _requestAdjacencyRecalcForThing(thing, pad = 1) {
    if (!thing || !Number.isFinite(thing.gx) || !Number.isFinite(thing.gy)) {
        requestAdjacencyRecalc();
        return;
    }
    requestAdjacencyRecalc(thing.gx, thing.gy, pad);
}

// ---- The structure table ----
// Per tile, the hashed core of the structure standing there (towers,
// barracks, spawners, floor items, mines): a kind code, owner, construction
// and energy (a mine: its gold or A*), in typed columns that the
// structures' own accessors keep (structTableAccessors). The state hash
// sweeps these instead of the objects (cold: ~4k a tick at 800k units).
// Derived state: an entity joins when set on its tile (setTileEntity, a
// restore's _snapSetTile) and leaves at its clear; reset with the lookup.
// Entities carry their tile in _stT (-1: on none); the page's structure
// views have no _stT and stay out.
// (rcnt: structures per hash region (SNAP_REGION_TILES square, ry * rw +
// rx), so the hash skips empty regions.)
// (tim: a tower's cooldown deadline, Tower._cdUntil; a barrack's or
// spawner's spawn timer.)
// (mines: the tiles holding mines, a compact list (mineN of them; mineAt:
// a tile's place + 1, 0 none). The hash takes every mine every hash (see
// _snapTickHashStatic) as its region's sum of their terms (mineSum, by
// dense region ry * rw + rx, kept as their values change: _stMineTerm; the
// regions with mines in a compact list, mineReg*): the same sums as each
// mine's term added there, without 20k mines read a tick (scattered tiles,
// ~0.5 ms at 105k units).)
const _ST = { n: 0, code: null, own: null, uc: null, val: null, tim: null, rcnt: null, rw: 0, mineArr: new Int32Array(64), mineN: 0, mineAt: null,
    mineSum: null, mineRc: null, mineRegArr: new Int32Array(64), mineRegN: 0, mineRegAt: null };
// A mine's term in its region's sum (the state hash's, as it was per mine).
function _stMineTerm(t) {
    const T = _ST, gx = t % GRID_W, gy = (t - gx) / GRID_W, v = T.val[t];
    let h = ((Math.imul(gx, 4099) + gy) ^ T.code[t]) ^ 0x6d1;
    h = (v | 0) === v ? Math.imul(h ^ v, 16777619) : _snapHNum(h, v);
    return Math.imul(h ^ (h >>> 15), 2246822519) | 0;
}
function _stMineRegions() {
    const T = _ST, nr = T.rcnt ? T.rcnt.length : 0;
    if (!T.mineSum || T.mineSum.length !== nr) { T.mineSum = new Int32Array(nr); T.mineRc = new Int32Array(nr); T.mineRegAt = new Int32Array(nr); T.mineRegN = 0; }
}
function _stMineAdd(t) {
    const T = _ST;
    if (!T.mineAt || T.mineAt.length !== T.n) T.mineAt = new Int32Array(T.n);
    if (T.mineAt[t]) return;
    if (T.mineN === T.mineArr.length) { const a = new Int32Array(T.mineArr.length * 2); a.set(T.mineArr); T.mineArr = a; }
    T.mineArr[T.mineN] = t; T.mineAt[t] = ++T.mineN;
    _stMineRegions();
    const r = _stRegion(t);
    if (T.mineRc[r]++ === 0) {
        if (T.mineRegN === T.mineRegArr.length) { const a = new Int32Array(T.mineRegArr.length * 2); a.set(T.mineRegArr); T.mineRegArr = a; }
        T.mineRegArr[T.mineRegN] = r; T.mineRegAt[r] = ++T.mineRegN;
    }
    T.mineSum[r] = (T.mineSum[r] + _stMineTerm(t)) | 0;
}
function _stMineDel(t) {
    const T = _ST, i = T.mineAt ? T.mineAt[t] - 1 : -1;
    if (i < 0) return;
    const r = _stRegion(t);
    T.mineSum[r] = (T.mineSum[r] - _stMineTerm(t)) | 0;
    if (--T.mineRc[r] === 0) {
        const k = T.mineRegAt[r] - 1, lastR = T.mineRegArr[--T.mineRegN];
        T.mineRegArr[k] = lastR; T.mineRegAt[lastR] = k + 1; T.mineRegAt[r] = 0;
        T.mineSum[r] = 0;
    }
    const last = T.mineArr[--T.mineN];
    T.mineArr[i] = last; T.mineAt[last] = i + 1; T.mineAt[t] = 0;
}
// A mine's amount in the table, its region's sum kept.
function _stMineVal(t, v) {
    const T = _ST;
    if (!T.mineAt || !T.mineAt[t]) { T.val[t] = v; return; }
    const r = _stRegion(t);
    T.mineSum[r] = (T.mineSum[r] - _stMineTerm(t)) | 0;
    T.val[t] = v;
    T.mineSum[r] = (T.mineSum[r] + _stMineTerm(t)) | 0;
}
const ST_OWNER_NONE = 0x7ff9;
function _stOwnerWord(v) { return (v | 0) === v ? v : ST_OWNER_NONE; }
// (Made at the first entity joining: the page's lookup holds views only.)
function structTableReset() {
    for (const e of _activeTileEntities) if (e && e._stT >= 0) e._stT = -1;
    const T = _ST;
    T.mineN = 0; if (T.mineAt) T.mineAt.fill(0);
    T.mineRegN = 0; if (T.mineSum) { T.mineSum.fill(0); T.mineRc.fill(0); T.mineRegAt.fill(0); }
    if (T.n !== GRID_W * GRID_H) { T.n = 0; T.code = T.own = T.uc = T.val = T.tim = T.rcnt = null; }
    else { T.code.fill(0); T.own.fill(0); T.uc.fill(0); T.val.fill(0); T.tim.fill(0); T.rcnt.fill(0); }
}
function _stRegion(t) { const gx = t % GRID_W, gy = (t - gx) / GRID_W, rt = SNAP_REGION_TILES; return Math.floor(gy / rt) * _ST.rw + Math.floor(gx / rt); }
function _stClear(t) { const T = _ST; if (T.code[t] !== 0) { T.rcnt[_stRegion(t)]--; if (T.code[t] >= 0x66) _stMineDel(t); } T.code[t] = 0; T.own[t] = 0; T.uc[t] = 0; T.val[t] = 0; T.tim[t] = 0; }
// Tile (gx, gy) held `prev` and now holds `ref` (null: nothing).
function structTableSet(gx, gy, prev, ref) {
    const t = gy * GRID_W + gx, T = _ST, n = GRID_W * GRID_H;
    if (t < 0 || t >= n) return;
    if (prev && prev !== ref && prev._stT === t) prev._stT = -1;
    const joins = !!ref && typeof ref._stT === 'number' && !!ref._stCode;
    if (T.n !== n) {
        if (!joins) return;
        T.n = n; T.code = new Uint8Array(n); T.own = new Int32Array(n); T.uc = new Uint8Array(n); T.val = new Float64Array(n); T.tim = new Float64Array(n);
        T.rw = Math.ceil(GRID_W / SNAP_REGION_TILES); T.rcnt = new Uint8Array(T.rw * Math.ceil(GRID_H / SNAP_REGION_TILES));
    }
    _stClear(t);
    if (!joins) return;
    // (An entity moved to another tile leaves its old one.)
    if (ref._stT >= 0 && ref._stT !== t) _stClear(ref._stT);
    ref._stT = t;
    T.code[t] = ref._stCode; T.rcnt[_stRegion(t)]++;
    if (ref._stMine) _stMineAdd(t);
    _stWrite(ref, t);
}
function _stWrite(ref, t) {
    const T = _ST;
    if (ref._stMine) { T.own[t] = ST_OWNER_NONE; _stMineVal(t, Number(ref._mv)); T.tim[t] = 0; }
    else { T.own[t] = _stOwnerWord(ref._ow); T.uc[t] = ref._uc ? 1 : 0; T.val[t] = Number(ref._en); T.tim[t] = ref._stCode === 0x22 ? Number(ref._cdUntil) || 0 : ref._stTimer ? Number(ref._spt) || 0 : 0; }
}
// A structure's entry written again from its fields (a restore sets some
// fields directly, not through the accessors).
function structTableRefresh(e) {
    if (e && e._stT >= 0 && _ST.n && _ST.code[e._stT] !== 0) _stWrite(e, e._stT);
}
// The structure lists (towers, barracks, collectorSpawners): an entry
// removed in O(1), the last entry taking its place (indexOf and splice over
// tens of thousands of spawners per destroyed building were ~1 ms a tick
// under salvage). Each entry's place in e._li; a list replaced or spliced
// elsewhere (a restore, a cleanup) is indexed again at its first removal
// that finds a stale place. The order changes alike on every peer.
function structListPush(list, e) { e._li = list.length; list.push(e); }
function structListRemove(list, e) {
    let i = e._li;
    if (!(i >= 0 && i < list.length && list[i] === e)) {
        for (let k = 0; k < list.length; k++) if (list[k]) list[k]._li = k;
        i = e._li;
        if (!(i >= 0 && i < list.length && list[i] === e)) return -1;
    }
    const last = list.pop();
    if (last !== e) { list[i] = last; last._li = i; }
    e._li = -1;
    return i;
}
// ---- structure rows (ENTITY_TABLES_PLAN.md T1) ----
// A structure's fields are columns of its class's table, the object only its
// row (_sr): ~0.4 KB a structure instead of ~1.5 KB of object, properties
// and boxed numbers (200k buildings: ~200 MB less on each of the page and the
// worker). Kinds: 'n' a number (Float64; undefined stored as NaN, read back
// as undefined, as a field never set), 'b' a boolean (Uint8: 0 unset, 1
// false, 2 true), 'r' anything else (an array of values). Fields not listed
// stay the object's own. Rows are not reused within a match (a destroyed
// structure's object may still be read); the tables start over with it
// (structTableReset). Lists from a census of chaos matches
// (.claude/struct_field_census.cjs).
const _STF_BUILDING = 'n:_stT n:_li n:_ow b:_uc n:_en n:gx n:gy n:x n:y r:type n:stacks n:manualStacks n:effectiveStacks n:level n:effectiveLevel '
    + 'n:potentialEffectiveLevel b:isStacking n:stackingWorkDone n:maxEnergy b:markedForSalvage b:autoUpgradeEnabled b:buildEnabled b:isUpgrading '
    + 'n:effectiveGroupSize n:effectiveAreaMult r:preComputedBase r:preComputedEffective r:preComputed '
    + 'r:preComputedPotential n:burning n:burnTickDamage n:poisoned n:poisonTickDamage n:frozen n:iceTickDamage n:wet n:sandy n:watched n:watchedByTeam '
    + 'r:_levelTextLabel n:_vsGen n:_vsR n:_vsA n:_vsP1 n:_vsP2 n:_vsListId b:autoStackEnabled r:_ambientSoundTicks';
const _STF_SPAWNER = 'n:_spt b:queueEnabled r:spawnQueue r:rallyX r:rallyY r:rallyTargetUnitId n:spawnCooldown r:_spawnReadyOrder r:_rallyLastSeenX r:_rallyLastSeenY b:_pendingRallyDetach';
const _STF_MINE = 'n:_stT n:_li n:_mv n:gx n:gy n:x n:y';
const STRUCT_TABLE_FIELDS = {
    Tower: _STF_BUILDING + ' r:baseStats r:currentStats r:textCtx n:_cdUntil n:angle r:connectedLasers n:laserState n:laserTimer r:_laserLinkLevel r:preferredTarget r:preferredTargetSpec r:_lzRow r:_lzCol',
    Barrack: _STF_BUILDING + ' ' + _STF_SPAWNER + ' r:unitType',
    CollectorSpawner: _STF_BUILDING + ' ' + _STF_SPAWNER, AstarSpawner: _STF_BUILDING + ' ' + _STF_SPAWNER, SalvagerSpawner: _STF_BUILDING + ' ' + _STF_SPAWNER,
    BuilderSpawner: _STF_BUILDING + ' ' + _STF_SPAWNER, HealerSpawner: _STF_BUILDING + ' ' + _STF_SPAWNER,
    ResearchSpawner: _STF_BUILDING + ' ' + _STF_SPAWNER + ' b:autoResearchEnabled r:researchTask b:isResearching',
    FloorItem: _STF_BUILDING + ' n:damage',
    GoldMine: _STF_MINE + ' n:maxGold', AstarMine: _STF_MINE + ' n:maxAstar'
};
const _sTables = new Map();
const STRUCT_SHARED_REFS = new Set(['type','unitType']);
// Only genuinely unique overrides have instance storage. Ordinary stats
// resolve owner/type/level directly into shared flat-table views.
const STRUCT_DERIVED_STATS=new Set(['preComputedBase','preComputedEffective','preComputed','preComputedPotential','baseStats','currentStats','maxEnergy','damage','spawnCooldown','x','y']);
const _sBuildingStatKeys=new Map();
// The entry is kept in the structure's row (T.mEnt, valid while T.mTok is the
// stat tables' version + 1): it depends on the owner, type and levels, whose
// setters clear it (_sDerivedReconcile), and on the tables (a version). The
// sweeps over thousands of structures (cover, work sites, statuses) read it
// for each one: ~4 us a lookup was a third of a tick at 4M units.
function _sThingStatEntry(e,which='base') {
    const sr=e._sr,T=sr===undefined?null:_sTables.get(e.constructor),ix=sr*3+(which==='effective'?1:which==='potential'?2:0);
    if(T!==null&&T.mTok[ix]===_precomputedStatsVersion+1)return T.mEnt[ix];
    const res=_sThingStatEntryCompute(e,which);
    if(T!==null&&res!==undefined){T.mTok[ix]=_precomputedStatsVersion+1;T.mEnt[ix]=res;}
    return res;
}
function _sThingStatEntryCompute(e,which) {
    const type=e.type;if(!type)return undefined;
    const raw=type==='barrack'?'barrack_'+e.unitType:type;
    let key=_sBuildingStatKeys.get(raw);
    if(key===undefined){key=normalizeBuildingResearchKey(raw);_sBuildingStatKeys.set(raw,key);}
    const base=getThingBaseLevel(e);
    let level=which==='effective'?getThingEffectiveLevel(e,base):which==='potential'?getThingPotentialLevel(e,getThingEffectiveLevel(e,base)):base;
    level=Math.max(1,clampThingLevel(level));
    const owner=Number.isFinite(e.owner)?e.owner:localPlayerId;
    if(owner>=0){const direct=PRECOMPUTED_STATS_MAP_PLAYER[owner]?.building?.[key]?.[level];return direct || calculateItemStats(key,level,owner);}
    const normalized=normalizeBuildingResearchKey(key),table=_thingStatTables.get('-1|building|'+normalized);
    return table?.entries[level] || _getBuildingPlayerPrecomputedEntry(-1,normalized,level);
}
function _sDerivedValue(e,name) {
    if(name==='x'||name==='y'){const q=name==='x'?e.gx:e.gy;return Number.isFinite(q)?q*TILE+TILE*.5:undefined;}
    if(name==='baseStats')return BASE_CARD_TYPES[e.type];
    if(name==='preComputedEffective')return _sThingStatEntry(e,'effective');
    if(name==='preComputedPotential')return _sThingStatEntry(e,'potential');
    if(name==='preComputedBase'||name==='preComputed'||name==='currentStats')return _sThingStatEntry(e);
    if(name==='spawnCooldown'){
        if(!e.type)return undefined;
        if(e.type==='barrack'||_SPAWN_COOLDOWN_ARGS[e.type])return spawnerCooldownTicks(e);
        return undefined;
    }
    const st=_sThingStatEntry(e);if(!st)return undefined;
    if(name==='maxEnergy'){
        if(e.isUpgrading && e.upgrademaxEnergy>0)return Math.max(1,Math.floor(e.upgrademaxEnergy));
        return Math.max(1,Math.floor(Number(st.maxEnergy)||1));
    }
    if(name==='damage')return Number(_sThingStatEntry(e,'effective').damage)||0;
}
function _sDerivedSet(T,e,name,v) {
    const map=T.unique[name];
    if(v==null || Number.isNaN(v) || (_thingStatViews.has(v)) || (name==='currentStats'&&v===BASE_CARD_TYPES[e.type])){map.delete(e._sr);return;}
    const normal=_sDerivedValue(e,name);
    if(Object.is(v,normal))map.delete(e._sr);else map.set(e._sr,v);
}
function _sDerivedReconcile(T,e) {
    { const b=e._sr*3,m=T.mTok; m[b]=0; m[b+1]=0; m[b+2]=0; }
    for(const name of T.derived){const map=T.unique[name];if(!map.size)continue;const v=map.get(e._sr);if(v!==undefined&&Object.is(v,_sDerivedValue(e,name)))map.delete(e._sr);}
}
// Class C's table (made, and its accessors defined, at its first row).
function _sTableOf(C) {
    let T = _sTables.get(C);
    if (T) return T;
    const spec = STRUCT_TABLE_FIELDS[C.name];
    if (!spec) return null;
    const allFields = spec.split(' ').map(f => { const [kind, name] = f.split(':'); return { kind, name, shared:kind==='r' && STRUCT_SHARED_REFS.has(name), col: 'c_' + name }; });
    const derived=allFields.filter(f=>STRUCT_DERIVED_STATS.has(f.name)).map(f=>f.name);
    const fields=allFields.filter(f=>!STRUCT_DERIVED_STATS.has(f.name));
    T = { C, fields, derived, unique:Object.fromEntries(derived.map(k=>[k,new Map()])), cap: 0, n: 0, keys: fields.filter(f => f.name !== '_stT' && f.name !== '_li').map(f => f.name) };
    for (const f of fields) T[f.col] = null;
    _sTables.set(C, T);
    _sTableGrow(T, 1024);
    for(const name of derived)Object.defineProperty(C.prototype,name,{configurable:true,get(){const map=T.unique[name],v=map.size?map.get(this._sr):undefined;return v!==undefined?v:_sDerivedValue(this,name);},set(v){_sDerivedSet(T,this,name,v);}});
    for (const f of fields) {
        const col='T.' + f.col;
        const at = col + '[this._sr]';
        const read = f.kind === 'n' ? 'let x = ' + at + '; return x === x ? x : undefined;' : f.kind === 'b' ? 'const x = ' + at + '; return x === 2 ? true : x === 1 ? false : undefined;' : 'return ' + (f.shared ? col+'.get(this._sr)' : at) + ';';
        let write = f.kind === 'n' ? at + ' = v === undefined ? NaN : v;' : f.kind === 'b' ? at + ' = v === undefined ? 0 : v ? 2 : 1;' : f.shared ? col+'.set(this._sr,v);' : at + ' = v;';
        if(['_ow','level','effectiveLevel','potentialEffectiveLevel','type','unitType','stacks','manualStacks'].includes(f.name))write+=' _sDerivedReconcile(T,this);';
        Object.defineProperty(C.prototype, f.name, { configurable: true, enumerable: false,
            get: new Function('T', 'return function () { ' + read + ' };')(T), set: new Function('T','_sDerivedReconcile', 'return function (v) { ' + write + ' };')(T,_sDerivedReconcile) });
    }
    return T;
}
function _sTableGrow(T, cap) {
    for (const f of T.fields) {
        const was = T[f.col];
        let a;
        if (f.shared) { a=_simRefGrow(was,cap,undefined,true); }
        else if (f.kind === 'r') { a = new Array(cap).fill(undefined); if (was) for (let i = 0; i < T.n; i++) a[i] = was[i]; }
        else { a = f.kind === 'n' ? new Float64Array(cap).fill(NaN) : new Uint8Array(cap); if (was) a.set(was.subarray(0, T.n)); }
        T[f.col] = a;
    }
    {
        const was = T.mTok, tok = new Int32Array(cap * 3), ent = new Array(cap * 3).fill(undefined);
        if (was) { tok.set(was.subarray(0, T.n * 3)); for (let i = 0; i < T.n * 3; i++) ent[i] = T.mEnt[i]; }
        T.mTok = tok; T.mEnt = ent;
    }
    T.cap = cap;
}
// A row for structure o (its class's table; none: its fields stay its own).
function _sRowTake(o) {
    const T = _sTableOf(o.constructor);
    if (!T) return false;
    if (T.n >= T.cap) _sTableGrow(T, Math.ceil(T.cap * 1.5 / 1024) * 1024);
    Object.defineProperty(o, '_sr', { value: T.n++, writable: true, configurable: true });
    return true;
}
// The tables start over (a new match: resetWorldState. Not at a restore,
// whose new structures' rows are taken before it indexes the tiles; the rows
// of the structures it replaced stay until the next match.)
function _sTablesReset() {
    for (const T of _sTables.values()) {
        T.n = 0;
        T.mTok.fill(0); T.mEnt.fill(undefined);
        for(const map of Object.values(T.unique))map.clear();
        for (const f of T.fields) if (f.shared) T[f.col]=new SimSharedColumn(T.cap); else if (f.kind === 'r') T[f.col].fill(undefined); else if (f.kind === 'n') T[f.col].fill(NaN); else T[f.col].fill(0);
    }
}
// The snapshot's keys of a tabled structure: its fields that hold a value
// (as its own keys were before).
function _sTableKeys(e) {
    const T = _sTables.get(e.constructor);
    if (!T || e._sr === undefined) return null;
    const out = [];
    for (const k of T.keys) if (e[k] !== undefined) out.push(k);
    for(const name of T.derived)if(T.unique[name].has(e._sr))out.push(name);
    for (const k of Object.keys(e)) out.push(k);
    return out;
}

// First thing in a structure's constructor (and a restore's shell): its
// row, then its backing fields, in one order.
function structTableInit(o) {
    _sRowTake(o);
    o._stT = -1;
    o._li = -1;
    if (o._stMine) o._mv = 0;
    else { o._ow = -1; o._uc = false; o._en = 0; if (o._stTimer) o._spt = 0; }
}
// Accessors of the hashed core on a structure class (code: the hash's kind
// code; mineKey: a mine's amount field, gold or astar).
function structTableAccessors(C, code, mineKey = null) {
    const P = C.prototype;
    Object.defineProperty(P, '_stCode', { value: code, enumerable: false });
    if (mineKey) {
        Object.defineProperty(P, '_stMine', { value: true, enumerable: false });
        Object.defineProperty(P, mineKey, { enumerable: true, configurable: true,
            get() { return this._mv; },
            set(v) { this._mv = v; const t = this._stT; if (t >= 0) _stMineVal(t, Number(v)); } });
        return;
    }
    Object.defineProperty(P, 'owner', { enumerable: true, configurable: true,
        get() { return this._ow; },
        set(v) { this._ow = v; const t = this._stT; if (t >= 0) _ST.own[t] = _stOwnerWord(v); } });
    Object.defineProperty(P, 'underConstruction', { enumerable: true, configurable: true,
        get() { return this._uc; },
        set(v) { this._uc = v; const t = this._stT; if (t >= 0) _ST.uc[t] = v ? 1 : 0; } });
    Object.defineProperty(P, 'energy', { enumerable: true, configurable: true,
        get() { return this._en; },
        set(v) { this._en = v; const t = this._stT; if (t >= 0) _ST.val[t] = Number(v); } });
    // (Barracks and spawners: their spawn timer, hashed with the core: a
    // timer that differs shows in the units made only seconds later.)
    if (code === 0x33 || code === 0x44) {
        Object.defineProperty(P, '_stTimer', { value: true, enumerable: false });
        Object.defineProperty(P, 'spawnTimer', { enumerable: true, configurable: true,
            get() { return this._spt; },
            set(v) { this._spt = v; const t = this._stT; if (t >= 0) _ST.tim[t] = Number(v) || 0; } });
    }
}
// Floor items (traps, walls, roads...) are structures like the buildings;
// mines hold an amount. Their other fields are set by whoever places or
// restores them (Object.assign(new FloorItem(), {...}): through the
// accessors).
class FloorItem { constructor() { structTableInit(this); } }
class GoldMine { constructor() { structTableInit(this); } }
class AstarMine { constructor() { structTableInit(this); } }
structTableAccessors(FloorItem, 0x55);
structTableAccessors(GoldMine, 0x66, 'gold');
structTableAccessors(AstarMine, 0x77, 'astar');
// A structure's snapshot keys: the accessors' names in place of their
// backing fields (the table tile and list place are not state).
const _ST_KEY_OF = { _ow: 'owner', _uc: 'underConstruction', _en: 'energy', _spt: 'spawnTimer' };
function structTableKeys(e, keys) {
    keys = _sTableKeys(e) || keys;
    const out = [];
    for (const k of keys) {
        if (k === '_stT' || k === '_li' || k === '_sr') continue;
        if (k === '_mv') { out.push(e instanceof AstarMine ? 'astar' : 'gold'); continue; }
        const a = _ST_KEY_OF[k];
        out.push(a === undefined ? k : a);
    }
    return out;
}

function initTileEntityLookup() {
    structTableReset();
    tileEntityType = Array.from({ length: GRID_H }, () => Array(GRID_W).fill(TILE_ENTITY_NONE));
    tileEntityRef = Array.from({ length: GRID_H }, () => Array(GRID_W).fill(null));
    _activeTileEntities = new Set();
    _tileEntityVersion++;
    tileEntityIndexesReset();
    requestAdjacencyRecalc();
}

// ---- Tile entity changes, for indexes kept up to date as they happen ----
// Every change of a tile's entity appends the tile to the journal; an index
// keeps a cursor ({ epoch, pos }) and applies the tiles changed since. A new
// epoch (a new lookup, cell owners replaced by a restore) means everything
// may have changed: the indexes rebuild. The indexes hold their entries in
// tile order, so they are the same on every peer whatever the history.
let _teLog = [], _teLogBase = 0, _tileEntityEpoch = 1;
function noteTileEntityChanged(gx, gy) {
    _teLog.push(gy * GRID_W + gx);
    // (A long journal is dropped: indexes that far behind rebuild.)
    if (_teLog.length >= 262144) { _teLogBase += _teLog.length; _teLog = []; }
}
function tileEntityIndexesReset() { _tileEntityEpoch++; }
// The tiles changed since the cursor (distinct, ascending), and the cursor
// moved to now; null when the index must rebuild.
function tileEntityChangesSince(c) {
    const end = _teLogBase + _teLog.length;
    if (c.epoch !== _tileEntityEpoch || c.pos < _teLogBase) { c.epoch = _tileEntityEpoch; c.pos = end; return null; }
    if (c.pos === end) return _TE_NO_CHANGES;
    const from = c.pos - _teLogBase;
    c.pos = end;
    const tiles = [];
    for (let i = from; i < _teLog.length; i++) tiles.push(_teLog[i]);
    tiles.sort((a, b) => a - b);
    let w = 0;
    for (let i = 0; i < tiles.length; i++) if (i === 0 || tiles[i] !== tiles[i - 1]) tiles[w++] = tiles[i];
    tiles.length = w;
    return tiles;
}
const _TE_NO_CHANGES = Object.freeze([]);
// Index of the first entry at tile `t` or after in a list of entities in
// tile order (gy * GRID_W + gx).
function _tileOrderedIndexOf(list, t) {
    let lo = 0, hi = list.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1, e = list[mid];
        if (e.gy * GRID_W + e.gx < t) lo = mid + 1; else hi = mid;
    }
    return lo;
}
// A copy of `list` (tile order) with the entry at tile t replaced by `e`
// (null: removed).
function _tileOrderedReplace(list, t, e) {
    let i = _tileOrderedIndexOf(list, t);
    const has = i < list.length && list[i].gy * GRID_W + list[i].gx === t;
    if (!has && !e) return list;
    const out = list.slice();
    if (has && e) out[i] = e;
    else if (has) out.splice(i, 1);
    else out.splice(i, 0, e);
    return out;
}

// The same for several tiles (distinct, ascending): one new list, the
// stretches between the changes copied as they are (a copy of the whole list
// for each of the tiles took ~1 ms each at 300k items); `itemAt(t)` gives
// the entry at tile t, null for none. The list itself when nothing changed.
function _tileOrderedReplaceMany(list, tiles, itemAt) {
    if (tiles.length === 1) return _tileOrderedReplace(list, tiles[0], itemAt(tiles[0]));
    const parts = [];
    let pos = 0, changed = false;
    for (let k = 0; k < tiles.length; k++) {
        const t = tiles[k], i = _tileOrderedIndexOf(list, t), e = itemAt(t);
        const has = i < list.length && list[i].gy * GRID_W + list[i].gx === t;
        if (!has && !e) continue;
        if (has && e === list[i]) continue;
        if (i > pos) parts.push(list.slice(pos, i));
        pos = i;
        if (e) parts.push([e]);
        if (has) pos = i + 1;
        changed = true;
    }
    if (!changed) return list;
    if (pos < list.length) parts.push(pos ? list.slice(pos) : list);
    return [].concat(...parts);
}

// Cell items (floor items, barracks, spawners...) in row-major tile order,
// rebuilt when the tile entity index changes. Iterating it visits items in
// the same order as a full grid scan. Callers still check
// grid[gy][gx].item === item: removals during a pass keep the old list.
let _cellItemsRowMajor = [];
let _cellItemsRowMajorVersion = -1;
let _cellItemsRowMajorSet = null;

const _cellItemsCursor = { epoch: -1, pos: 0 };
// The cell item standing on tile t (the tile's cell item, an active tile
// entity placed there), or null.
function _cellItemAtTile(t) {
    const gx = t % GRID_W, gy = (t - gx) / GRID_W, cell = grid[gy] && grid[gy][gx], item = cell ? cell.item : null;
    return item && _activeTileEntities.has(item) && item.gx === gx && item.gy === gy ? item : null;
}
function getCellItemsRowMajor() {
    const journal = typeof tileEntityChangesSince === 'function';
    if (!journal && _cellItemsRowMajorVersion === _tileEntityVersion && _cellItemsRowMajorSet === _activeTileEntities) return _cellItemsRowMajor;
    const changes = journal && _cellItemsRowMajorSet === _activeTileEntities ? tileEntityChangesSince(_cellItemsCursor) : null;
    if (changes !== null) {
        // (A new list when anything changed: a pass over the old one keeps it.)
        const list = _tileOrderedReplaceMany(_cellItemsRowMajor, changes, _cellItemAtTile);
        _cellItemsRowMajor = list;
        _cellItemsRowMajorVersion = _tileEntityVersion;
        return list;
    }
    if (journal && _cellItemsRowMajorSet !== _activeTileEntities) tileEntityChangesSince(_cellItemsCursor);
    let list = [];
    for (let item of _activeTileEntities) {
        let cell = grid[item.gy] && grid[item.gy][item.gx];
        if (cell && cell.item === item) list.push(item);
    }
    list.sort((a, b) => (a.gy - b.gy) || (a.gx - b.gx));
    _cellItemsRowMajor = list;
    _cellItemsRowMajorVersion = _tileEntityVersion;
    _cellItemsRowMajorSet = _activeTileEntities;
    return list;
}

// Structures (towers and cell items, never resource mines) bucketed by area,
// rebuilt when the tile entity index or the areas change. Range scans visit
// only the areas that hold one instead of every tile in range.
let _structuresByArea = null;
let _structuresByAreaVersion = -1;
let _structuresByAreaSet = null;
let _structuresByAreaCells = null;

const _structuresByAreaCursor = { epoch: -1, pos: 0 };
// The structure on tile t for getStructuresByArea (not a mine), or null.
function _structureAtTile(t) {
    const gx = t % GRID_W, gy = (t - gx) / GRID_W, refs = tileEntityRef[gy], e = refs ? refs[gx] : null;
    if (!e || e.gx !== gx || e.gy !== gy) return null;
    const type = tileEntityType[gy][gx];
    return type === TILE_ENTITY_GOLDMINE || type === TILE_ENTITY_ASTARMINE ? null : e;
}
function getStructuresByArea() {
    const same = _structuresByArea && _structuresByAreaSet === _activeTileEntities && _structuresByAreaCells === gridCellsByArea;
    const changes = same ? tileEntityChangesSince(_structuresByAreaCursor) : null;
    if (changes !== null) {
        // Per area, a new list where one changed (in tile order).
        for (let i = 0; i < changes.length; i++) {
            const t = changes[i], gx = t % GRID_W, area = getAreaIdAtTile(gx, (t - gx) / GRID_W);
            if (area < 0) continue;
            const next = _tileOrderedReplace(_structuresByArea[area] || [], t, _structureAtTile(t));
            _structuresByArea[area] = next.length ? next : undefined;
        }
        _structuresByAreaVersion = _tileEntityVersion;
        return _structuresByArea;
    }
    if (!same) tileEntityChangesSince(_structuresByAreaCursor);
    let byArea = new Array(gridCellsByArea.length);
    for (let e of _activeTileEntities) {
        let gx = e.gx, gy = e.gy, refs = tileEntityRef[gy];
        if (!refs || refs[gx] !== e) continue;
        let type = tileEntityType[gy][gx];
        if (type === TILE_ENTITY_GOLDMINE || type === TILE_ENTITY_ASTARMINE) continue;
        let area = getAreaIdAtTile(gx, gy);
        if (area < 0) continue;
        (byArea[area] || (byArea[area] = [])).push(e);
    }
    // (Tile order: the same on every peer.)
    for (let a = 0; a < byArea.length; a++) if (byArea[a] && byArea[a].length > 1) byArea[a].sort((p, q) => (p.gy - q.gy) || (p.gx - q.gx));
    _structuresByArea = byArea;
    _structuresByAreaVersion = _tileEntityVersion;
    _structuresByAreaSet = _activeTileEntities;
    _structuresByAreaCells = gridCellsByArea;
    return byArea;
}

// Per player, a summed-area table of structures that are hostile to it
// (towers and cell items, never mines; a cell item is the player's own only
// when both it and its tile are). Rebuilt when the tile entity index
// changes, it answers "any hostile structure in this tile rectangle?" in
// four reads, so idle armies skip structure scans with nothing around.
let _hostileStructureSats = [];

// The table for one player, rebuilt on its first query after a change.
function _getHostileStructureSat(owner) {
    let entry = _hostileStructureSats[owner];
    if (entry && entry.version === _tileEntityVersion && entry.set === _activeTileEntities
        && entry.width === GRID_W && entry.height === GRID_H) return entry.sat;
    let stride = GRID_W + 1;
    let sat = entry && entry.sat.length === stride * (GRID_H + 1) ? entry.sat.fill(0) : new Int32Array(stride * (GRID_H + 1));
    for (let e of _activeTileEntities) {
        let gx = e.gx, gy = e.gy, refs = tileEntityRef[gy];
        if (!refs || refs[gx] !== e) continue;
        let type = tileEntityType[gy][gx];
        if (type === TILE_ENTITY_GOLDMINE || type === TILE_ENTITY_ASTARMINE) continue;
        let cell = grid[gy] && grid[gy][gx];
        let cellOwner = cell && cell.item === e ? cell.owner : e.owner;
        if (!(e.owner === owner && cellOwner === owner)) sat[(gy + 1) * stride + gx + 1]++;
    }
    for (let y = 1; y <= GRID_H; y++) {
        let row = y * stride, above = row - stride, run = 0;
        for (let x = 1; x <= GRID_W; x++) { run += sat[row + x]; sat[row + x] = sat[above + x] + run; }
    }
    _hostileStructureSats[owner] = { sat, version: _tileEntityVersion, set: _activeTileEntities, width: GRID_W, height: GRID_H };
    return sat;
}

// Whether a structure hostile to `owner` stands in tiles [x0..x1] x [y0..y1]
// (clamped to the map). Unknown owners answer true.
function hasHostileStructureInTileRect(owner, x0, y0, x1, y1) {
    let playerCount = typeof players !== 'undefined' && Array.isArray(players) ? players.length : 0;
    if (!Number.isInteger(owner) || owner < 0 || owner >= playerCount) return true;
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(GRID_W - 1, x1); y1 = Math.min(GRID_H - 1, y1);
    if (x0 > x1 || y0 > y1) return false;
    // The movement kernel's structure tables (kept up to date tile by tile):
    // blocks holding structures hostile to the owner, then their tiles.
    if (typeof _simMoveStructs === 'function' && typeof spatialBlockCols !== 'undefined' && spatialBlockCols > 0 && owner < spatialUnitsComplexPlayerCount) {
        _simMoveStructs();
        const codes = _simMoveStruct, blocks = _simMoveStructBlocks, pc = spatialUnitsComplexPlayerCount, B = SPATIAL_BLOCK_SIZE * CHUNK_SIZE;
        if (codes && blocks && codes.length === GRID_W * GRID_H) {
            for (let by = Math.floor(y0 / B), by1 = Math.floor(y1 / B); by <= by1; by++) for (let bx = Math.floor(x0 / B), bx1 = Math.floor(x1 / B); bx <= bx1; bx++) {
                if (!(blocks[(by * spatialBlockCols + bx) * pc + owner] > 0)) continue;
                for (let y = Math.max(y0, by * B), ye = Math.min(y1, by * B + B - 1); y <= ye; y++) {
                    const row = y * GRID_W;
                    for (let x = Math.max(x0, bx * B), xe = Math.min(x1, bx * B + B - 1); x <= xe; x++) {
                        const c = codes[row + x];
                        if (c !== -1 && c !== owner) return true;
                    }
                }
            }
            return false;
        }
    }
    let sat = _getHostileStructureSat(owner), stride = GRID_W + 1;
    return sat[(y1 + 1) * stride + x1 + 1] - sat[y0 * stride + x1 + 1] - sat[(y1 + 1) * stride + x0] + sat[y0 * stride + x0] > 0;
}

// Index of the first row-major cell item at or after row gy.
function findCellItemRowStart(list, gy) {
    let lo = 0, hi = list.length;
    while (lo < hi) {
        let mid = (lo + hi) >> 1;
        if (list[mid].gy < gy) lo = mid + 1; else hi = mid;
    }
    return lo;
}

function setTileEntity(gx, gy, type, ref) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return;
    if (!tileEntityType[gy] || !tileEntityRef[gy]) return;
    let prevRef = tileEntityRef[gy][gx];
    if (prevRef && prevRef !== ref) _activeTileEntities.delete(prevRef);
    structTableSet(gx, gy, prevRef, ref || null);
    tileEntityType[gy][gx] = type || TILE_ENTITY_NONE;
    tileEntityRef[gy][gx] = ref || null;
    if (ref) _activeTileEntities.add(ref);
    _tileEntityVersion++;
    noteTileEntityChanged(gx, gy);
    if (typeof workerWorkChanged === 'function') { if (ref) workerWorkChanged(Number.isFinite(ref.owner) ? ref.owner : -1, null, gx, gy); if (prevRef && prevRef !== ref) workerWorkChanged(Number.isFinite(prevRef.owner) ? prevRef.owner : -1, null, gx, gy); }
    if (typeof simMoveTileEntityChanged === 'function') simMoveTileEntityChanged(gx, gy);
    _markAdjacencyDirtyAt(gx, gy, 1);
    if (typeof visCoverOnBuildingChanged === 'function') {
        if (prevRef && prevRef !== ref) visCoverOnBuildingChanged(prevRef);
        if (ref) visCoverOnBuildingChanged(ref);
    }
}

function clearTileEntity(gx, gy, expectedRef = null) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return;
    if (!tileEntityType[gy] || !tileEntityRef[gy]) return;
    if (expectedRef && tileEntityRef[gy][gx] !== expectedRef) return;
    let prevRef = tileEntityRef[gy][gx];
    if (prevRef) _activeTileEntities.delete(prevRef);
    structTableSet(gx, gy, prevRef, null);
    _tileEntityVersion++;
    noteTileEntityChanged(gx, gy);
    if (prevRef && typeof workerWorkChanged === 'function') workerWorkChanged(Number.isFinite(prevRef.owner) ? prevRef.owner : -1, null, gx, gy);
    tileEntityType[gy][gx] = TILE_ENTITY_NONE;
    tileEntityRef[gy][gx] = null;
    // (After the clear: the walk classes' walls read the tile as it is now.)
    if (typeof simMoveTileEntityChanged === 'function') simMoveTileEntityChanged(gx, gy);
    if (prevRef && typeof visCoverOnBuildingChanged === 'function') visCoverOnBuildingChanged(prevRef);
    let tileIndex = gy * GRID_W + gx;
    let baseIndex = tileIndex * _WORKER_TARGET_LOAD_TYPE_COUNT;
    for (let i = 0; i < _WORKER_TARGET_LOAD_TYPE_COUNT; i++) {
        let reservedUnit = workerReservedTiles[baseIndex + i];
        if (reservedUnit) reservedUnit._workerReservedTileIndex = -1;
        workerReservedSet(baseIndex + i, null);
    }
    _markAdjacencyDirtyAt(gx, gy, 1);
}

function getTileEntityType(gx, gy) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return TILE_ENTITY_NONE;
    if (!tileEntityType[gy]) return TILE_ENTITY_NONE;
    return tileEntityType[gy][gx] || TILE_ENTITY_NONE;
}

function getTileEntityRef(gx, gy) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return null;
    if (!tileEntityRef[gy]) return null;
    return tileEntityRef[gy][gx] || null;
}

function getGoldMineAt(gx, gy) {
    if (getTileEntityType(gx, gy) !== TILE_ENTITY_GOLDMINE) return null;
    return getTileEntityRef(gx, gy);
}

function getAstarMineAt(gx, gy) {
    if (getTileEntityType(gx, gy) !== TILE_ENTITY_ASTARMINE) return null;
    return getTileEntityRef(gx, gy);
}

function getResourceMineAt(resourceKey, gx, gy) {
    let cfg = getResourceTypeConfig(resourceKey);
    if (!cfg) return null;
    if (cfg.mineTileType === 'mine') return getGoldMineAt(gx, gy);
    if (cfg.mineTileType === 'astar_mine') return getAstarMineAt(gx, gy);
    return null;
}

function isSpawnerEntity(ref) {
    return !!ref && (
        (ref instanceof CollectorSpawner) ||
        (ref instanceof AstarSpawner) ||
        (ref instanceof SalvagerSpawner) ||
        (ref instanceof BuilderSpawner) ||
        (ref instanceof HealerSpawner) ||
        (ref instanceof ResearchSpawner)
    );
}

function getTowerAtTile(gx, gy) {
    let ref = getTileEntityRef(gx, gy);
    return (ref instanceof Tower) ? ref : null;
}

function getBarrackAtTile(gx, gy) {
    let ref = getTileEntityRef(gx, gy);
    return (ref instanceof Barrack) ? ref : null;
}

function getSpawnerAtTile(gx, gy) {
    let ref = getTileEntityRef(gx, gy);
    return isSpawnerEntity(ref) ? ref : null;
}

function getFloorItemAtTile(gx, gy) {
    if (getTileEntityType(gx, gy) === TILE_ENTITY_GOLDMINE) return null;
    let ref = getTileEntityRef(gx, gy);
    if (!ref) return null;
    if ((ref instanceof Tower) || (ref instanceof Barrack) || isSpawnerEntity(ref)) return null;
    return ref;
}

function hasActiveGoldMineAt(gx, gy) {
    let mine = getGoldMineAt(gx, gy);
    return !!(mine && Number.isFinite(mine.gold) && mine.gold > 0);
}

function hasActiveAstarMineAt(gx, gy) {
    let mine = getAstarMineAt(gx, gy);
    return !!(mine && Number.isFinite(mine.astar) && mine.astar > 0);
}

function hasActiveResourceMineAt(resourceKey, gx, gy) {
    let cfg = getResourceTypeConfig(resourceKey);
    if (!cfg) return false;
    let mine = getResourceMineAt(resourceKey, gx, gy);
    let mineStatKey = String(cfg.mineStatKey || '');
    return !!(mine && mineStatKey && Number.isFinite(mine[mineStatKey]) && mine[mineStatKey] > 0);
}

let rng = null; // shared PRNG
let gameSeed = 0;

let towers = [];
// Bumped whenever a tower joins or leaves towers.
let towersVersion = 0;
function towersChanged() { towersVersion++; }
// Bumped when a cloud tower joins or leaves towers (pathfinding.js keeps
// its cloud tables by it: other towers falling in a battle leave them).
let cloudTowersVersion = 0;
function towerJoinedOrLeft(t) { towersVersion++; if (t && t.baseStats && t.baseStats.isCloud) cloudTowersVersion++; if (t && t.type === 'laser') { laserTowersVersion++; if (typeof laserListToggle === 'function') laserListToggle(t); } }
// Bumped when a laser tower joins or leaves towers (the laser links' list).
let laserTowersVersion = 0;
let units = [];
let projectiles = [];
let particles = [];
let barracks = [];
// Bumped whenever a barrack joins or leaves barracks.
let barracksVersion = 0;
function barracksChanged() { barracksVersion++; }
let collectorSpawners = [];
// Bumped whenever a spawner joins or leaves collectorSpawners (indexes of
// it are kept until then).
let collectorSpawnersVersion = 0;
function collectorSpawnersChanged() { collectorSpawnersVersion++; }
let collectors = []; // deprecated - worker units now in units array
let droppedItems = [];
let droppedItemGrid = [];

function initDroppedItemGrid() {
    droppedItemGrid = [];
    for (let y = 0; y < GRID_H; y++) {
        droppedItemGrid.push(new Array(GRID_W).fill(null));
    }
    droppedItemsByArea = Array.from({ length: Array.isArray(areas) ? areas.length : 0 }, () => []);
}

function getDroppedItemAt(gx, gy) {
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) return null;
    let x = Math.floor(gx), y = Math.floor(gy);
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return null;
    if (!droppedItemGrid[y]) return null;
    return droppedItemGrid[y][x] || null;
}

function _setDroppedItemAt(gx, gy, drop) {
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) return;
    let x = Math.floor(gx), y = Math.floor(gy);
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
    if (!droppedItemGrid[y]) return;
    droppedItemGrid[y][x] = drop || null;
    if (grid[y] && grid[y][x]) grid[y][x].droppedItem = drop || null;
}

// Bumped whenever a drop is added or removed (bucket indexes rebuild on it).
let droppedItemsVersion = 0;

function addDroppedItem(drop) {
    if (!drop) return null;
    droppedItemsVersion++;
    if (typeof workerWorkDropAdded === 'function') workerWorkDropAdded(Math.floor(Number(drop.gx)), Math.floor(Number(drop.gy)));
    let gx = Math.floor(Number(drop.gx));
    let gy = Math.floor(Number(drop.gy));
    if (!(gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H)) return null;
    if (getDroppedItemAt(gx, gy)) return null;

    drop.gx = gx;
    drop.gy = gy;
    if (!Number.isFinite(drop.x)) drop.x = gx * TILE + 16;
    if (!Number.isFinite(drop.y)) drop.y = gy * TILE + 16;
    if (!Number.isFinite(drop.timer)) drop.timer = TICK_RATE * 120;

    _setDroppedItemAt(gx, gy, drop);
    _addDroppedItemToAreaBucket(drop, getAreaIdAtTile(gx, gy));
    drop._droppedIndex = droppedItems.length;
    droppedItems.push(drop);
    return drop;
}

function removeDroppedItem(drop) {
    if (!drop) return false;
    droppedItemsVersion++;
    let gx = Math.floor(Number(drop.gx));
    let gy = Math.floor(Number(drop.gy));
    if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H) {
        if (getDroppedItemAt(gx, gy) === drop) _setDroppedItemAt(gx, gy, null);
        let tileIndex = gy * GRID_W + gx;
        let baseIndex = tileIndex * _WORKER_TARGET_LOAD_TYPE_COUNT;
        for (let i = 0; i < _WORKER_TARGET_LOAD_TYPE_COUNT; i++) {
            let reservedUnit = workerReservedTiles[baseIndex + i];
            if (reservedUnit) reservedUnit._workerReservedTileIndex = -1;
            workerReservedSet(baseIndex + i, null);
        }
    }

    let idx = Number.isFinite(drop._droppedIndex) ? Math.floor(drop._droppedIndex) : -1;
    if (idx < 0 || idx >= droppedItems.length || droppedItems[idx] !== drop) {
        return false;
    }
    _removeDroppedItemFromAreaBucket(drop);
    let lastIdx = droppedItems.length - 1;
    let moved = droppedItems[lastIdx];
    droppedItems[idx] = moved;
    droppedItems.pop();
    if (idx !== lastIdx && moved) moved._droppedIndex = idx;
    delete drop._droppedIndex;
    return true;
}

const TEAM_PRESET_COLORS = ['#ff4d4f', '#4da6ff', '#4dff88', '#ffd24d', '#b366ff', '#ff8c4d', '#4dfff5', '#ff4dd2'];
let players = Array.from({ length: 8 }, () => ({ energy: 2000, astar: 9000, popCount: 0 }));
let playerPopCaps = Array.from({ length: 8 }, () => 200);
// The slots of the teams playing, not eight: every per-player table and loop
// of the simulation (the unit index's counts, the sight cover, the
// acquisition's area answers, the navigation profiles) is as long as the
// players list, and a match of two teams paid 4x in each. Before any of them
// is made: the start of resetWorldState.
function fitPlayersToTeams() {
    const ids = activeTeamIds && activeTeamIds.length ? activeTeamIds : [0, 1];
    const slots = Math.max(2, 1 + Math.max(0, ...ids));
    while (players.length > slots) players.pop();
    while (players.length < slots) players.push({ energy: 2000, astar: 9000, popCount: 0 });
}
let _popCapScratchByOwner = new Int32Array(0);
let localPlayerId = 0;
let activeTeamIds = [0, 1];
let teamColorById = {};
let gameStarted = false;
let gameOver = false;
let winner = -1;
let gameMode = 'destroy'; // 'destroy' or 'killking'
let gameTime = 0; // in ticks
let localDefeated = false;
let spectateMode = 'none'; // 'none' | 'defeated' | 'postgame'
let resignedTeams = new Set();

let gameStatsHistory = [];
let graphMetric = 'units';

// Camera
let camera = { x: 0, y: 0, zoom: 1 };
let viewW = 960, viewH = 640;

// Selection
let selectedUnits = [];
let selectedEntities = []; // towers, barracks, floor items, gold mines, collectors
let activeSubGroups = {}; // key: groupKey, value: true/false for sub-group filtering
let controlGroups = {};
let popupControlGroups = {};
let activePopupControlGroupKey = '';
let researchQueueDragInProgress = false;
let researchQueueDragReleaseHooksBound = false;
const POPUP_CONTROL_GROUP_KEYS = ['r', 't', 'y', 'u', 'i', 'o', 'p'];
let controlGroupAlertState = {}; // key: 1..9 => {damageUntil, kingUntil}
let mapAlerts = []; // {x,y,start,dur,kind}
let selectionBox = null; // {sx, sy, ex, ey} in world coords
let isBoxSelecting = false;
let selectionBoxScreen = null; // {sx, sy, ex, ey} in screen coords relative to game area
let mouseWorldX = 0, mouseWorldY = 0;
let mouseScreenX = 0, mouseScreenY = 0;

// Build
let selectedBuildItem = null; // key from BASE_CARD_TYPES
let activeBuildTab = 'barracks';
let buildPurchaseMultiplier = 1;
let queuePurchaseMultiplier = 1;
let researchPanelOpenState = {};
let researchQueuePanelOpenState = {};
let researchPreviewThingLevel = 1;
let researchThingLevelDropdown = null;
let researchThingLevelDropdownOutsideHandler = null;
let researchStatMatrixPopupPayload = null;
let startingResourcesConfig = makeDefaultStartingResourcesConfig();
let startingResourcesSelectedThingId = '';
let shopStatMatrixDescriptorById = {};
let nextShopStatMatrixDescriptorId = 1;
let infoPanelStatMatrixDescriptorById = {};
let nextInfoPanelStatMatrixDescriptorId = 1;
let activeInfoPanelStatMatrixContext = null;
let infoPanelGlobalMouseTrackingBound = false;
let infoPanelInteractionTrackingBoundByEl = new WeakSet();
let infoPanelLastManualScrollTsByEl = new WeakMap();
let infoPanelManualScrollInteractionUntilByEl = new WeakMap();
let infoPanelProgrammaticScrollUntilByEl = new WeakMap();
let uiMouseClientX = 0;
let uiMouseClientY = 0;
let defaultAutoBuildEnabled = true;
let defaultAutoUpgradeEnabled = true;
// Selection groups are by type only (levels are never split out).
const ignoreLevelSubgroups = true;

const BUILD_PLACE_MODE_DRAG_KEEP = 0;
const BUILD_PLACE_MODE_SHIFT_KEEP = 1;
const BUILD_PLACE_MODE_SHIFT_DRAG = 2;
let buildPlacementMode = BUILD_PLACE_MODE_SHIFT_DRAG;
let buildPlacementDragActive = false;
let buildPlacementDragVisitedTiles = null;

// Input
let keysDown = {};
let attackMoveMode = false;

const LEVEL_VISIBILITY_ALL = 0;
const LEVEL_VISIBILITY_BUILDINGS = 1;
const LEVEL_VISIBILITY_NONE = 2;
// Default keeps existing behavior (building labels only)
let levelVisibilityMode = LEVEL_VISIBILITY_BUILDINGS;

const RENDER_RANGE_TURRETS = 0;
const RENDER_RANGE_TURRETS_AND_UNITS = 1;
const RENDER_RANGE_NONE = 2;
const RENDER_RANGE_ALL = 3;
const RENDER_RANGE_UNITS = 4;
const RENDER_RANGE_BUILDINGS = 5;
let renderRangeAllTeam = true;
let renderRangeSeeThrough = false;
let renderRangeMode = RENDER_RANGE_NONE;
let showGoldMineAmountText = false;
let audioVolume = 1;
let audioBackgroundVolume = 0.1;

const OVERLAY_LINE_DOTTED = 'dotted';
const OVERLAY_LINE_SOLID = 'solid';
const OVERLAY_SCOPE_BUILDINGS = 'buildings';
const OVERLAY_SCOPE_BUILDINGS_UNITS = 'buildings_units';
const OVERLAY_SCOPE_UNITS = 'units';
const OVERLAY_SCOPE_NONE = 'none';

let rallyLineType = OVERLAY_LINE_DOTTED;
let rallyLineScope = OVERLAY_SCOPE_NONE;
let selectionOutlineType = OVERLAY_LINE_SOLID;
let selectionOutlineSeeThrough = false;
let selectionOutlineScope = OVERLAY_SCOPE_BUILDINGS_UNITS;

function applyOverlayLineType(ctx, lineType) {
    if (!ctx || !ctx.setLineDash) return;
    if (lineType === OVERLAY_LINE_DOTTED) ctx.setLineDash([4, 3]);
    else ctx.setLineDash([]);
}

function showRallyLinesForBuildings() {
    return rallyLineScope === OVERLAY_SCOPE_BUILDINGS || rallyLineScope === OVERLAY_SCOPE_BUILDINGS_UNITS;
}

function showRallyLinesForUnits() {
    return rallyLineScope === OVERLAY_SCOPE_BUILDINGS_UNITS;
}

function showSelectionOutlinesForBuildings() {
    return selectionOutlineScope === OVERLAY_SCOPE_BUILDINGS_UNITS;
}

function showSelectionOutlinesForUnits() {
    return selectionOutlineScope === OVERLAY_SCOPE_UNITS || selectionOutlineScope === OVERLAY_SCOPE_BUILDINGS_UNITS;
}

// Settings > Rendering > Post process (3D). 'simple' is the original
// pipeline: MSAA scene target plus projected drop shadows. The default is
// 'high'. 'detailed' and
// 'high' shadows are shadow-mapped (2048 / 4096 texels).
const GRAPHICS_AA_MODES = ['off', 'fxaa', 'msaa', 'msaa_fxaa'];
const GRAPHICS_AO_MODES = ['off', 'low', 'high'];
const GRAPHICS_SHADOW_MODES = ['off', 'simple', 'detailed', 'high'];
const GRAPHICS_OPTION_KEYS = ['aa', 'shadows', 'ao', 'outline', 'bloom', 'grade', 'sharpen', 'resolution'];
// Sharpen: false (off), 'low', true (medium, the original strength) or
// 'high'. Stronger keeps moving edges crisper (less smear while panning).
const GRAPHICS_SHARPEN_MODES = [false, 'low', true, 'high'];
const GRAPHICS_SHARPEN_AMOUNT = { low: 0.1, true: 0.18, high: 0.32 };
const GRAPHICS_PRESETS = {
    off: { aa: 'off', shadows: 'off', ao: 'off', outline: false, bloom: false, grade: false, sharpen: false, resolution: 1 },
    simple: { aa: 'msaa', shadows: 'simple', ao: 'off', outline: false, bloom: false, grade: false, sharpen: false, resolution: 1 },
    balanced: { aa: 'fxaa', shadows: 'simple', ao: 'off', outline: true, bloom: false, grade: true, sharpen: false, resolution: 1 },
    high: { aa: 'msaa', shadows: 'high', ao: 'low', outline: true, bloom: false, grade: true, sharpen: true, resolution: 1 },
    ultra: { aa: 'msaa_fxaa', shadows: 'high', ao: 'high', outline: true, bloom: true, grade: true, sharpen: true, resolution: 1 }
};

function normalizeGraphicsOptions(raw, fallback = GRAPHICS_PRESETS.high) {
    let src = raw && typeof raw === 'object' ? raw : {};
    let pick = (value, list, def) => list.includes(value) ? value : def;
    let bool = (value, def) => typeof value === 'boolean' ? value : def;
    let res = Number(src.resolution);
    return {
        aa: pick(src.aa, GRAPHICS_AA_MODES, fallback.aa),
        shadows: pick(src.shadows, GRAPHICS_SHADOW_MODES, fallback.shadows),
        ao: pick(src.ao, GRAPHICS_AO_MODES, fallback.ao),
        outline: bool(src.outline, fallback.outline),
        bloom: bool(src.bloom, fallback.bloom),
        grade: bool(src.grade, fallback.grade),
        sharpen: GRAPHICS_SHARPEN_MODES.includes(src.sharpen) ? src.sharpen : fallback.sharpen,
        resolution: src.resolution !== undefined && src.resolution !== null && Number.isFinite(res) ? Math.max(0.5, Math.min(1, res)) : fallback.resolution
    };
}

// The preset whose options equal these, or 'custom'.
function matchGraphicsPreset(options) {
    let o = normalizeGraphicsOptions(options);
    for (let name in GRAPHICS_PRESETS) {
        let p = GRAPHICS_PRESETS[name];
        if (GRAPHICS_OPTION_KEYS.every(k => p[k] === o[k])) return name;
    }
    return 'custom';
}

// Default: High, the best-looking set that stays cheap (see PERFORMANCE.md).
const GRAPHICS_DEFAULT_PRESET = 'high';
let graphicsOptions = normalizeGraphicsOptions(GRAPHICS_PRESETS[GRAPHICS_DEFAULT_PRESET]);

const OVERLAY_SPRITE_CACHE_MAX_SIDE = 2048;
const OVERLAY_SPRITE_CACHE_MAX_AREA = 2200000;
const _unitSelectionRingSpriteCache = new Map();
const _overlayRectOutlineSpriteCache = new Map();
const _overlayLineSpriteCache = new Map();
const _overlayMarkerSpriteCache = new Map();

function _getCachedOverlaySprite(cacheEntry, key, minX, minY, maxX, maxY, drawFn) {
    if (!cacheEntry || typeof drawFn !== 'function') return null;
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) return null;

    let pad = 4;
    let sx = Math.floor(minX - pad);
    let sy = Math.floor(minY - pad);
    let ex = Math.ceil(maxX + pad);
    let ey = Math.ceil(maxY + pad);
    let w = Math.max(1, ex - sx + 1);
    let h = Math.max(1, ey - sy + 1);

    if (w > OVERLAY_SPRITE_CACHE_MAX_SIDE || h > OVERLAY_SPRITE_CACHE_MAX_SIDE || (w * h) > OVERLAY_SPRITE_CACHE_MAX_AREA) {
        cacheEntry.key = '';
        cacheEntry.sprite = null;
        return null;
    }

    if (cacheEntry.key === key && cacheEntry.sprite) return cacheEntry.sprite;

    let canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    let c = canvas.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.translate(-sx, -sy);
    drawFn(c);

    let sprite = { canvas, x: sx, y: sy };
    cacheEntry.key = key;
    cacheEntry.sprite = sprite;
    return sprite;
}

function _overlayBoundsVisible(minX, minY, maxX, maxY, viewMinX, viewMinY, viewMaxX, viewMaxY, pad = 0) {
    let p = Math.max(0, Number(pad) || 0);
    if ((maxX + p) < viewMinX) return false;
    if ((maxY + p) < viewMinY) return false;
    if ((minX - p) > viewMaxX) return false;
    if ((minY - p) > viewMaxY) return false;
    return true;
}

function _getUnitSelectionRingSprite(radius, lineType, strokeColor) {
    let r = Math.max(2, Math.round(Number(radius) || 0));
    let key = r + '|' + String(lineType || OVERLAY_LINE_SOLID) + '|' + String(strokeColor || '#9aa');
    let cached = _unitSelectionRingSpriteCache.get(key);
    if (cached) return cached;

    let pad = 3;
    let size = Math.max(8, (r + pad) * 2 + 2);
    let half = size * 0.5;
    let scale = _getUiSpriteScale();
    let c = document.createElement('canvas');
    c.width = size * scale;
    c.height = size * scale;
    let g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.strokeStyle = strokeColor || '#9aa';
    g.lineWidth = 1;
    if (lineType === OVERLAY_LINE_DOTTED) g.setLineDash([4, 3]);
    else g.setLineDash([]);
    g.beginPath();
    g.arc(half, half, r, 0, 6.28);
    g.stroke();
    g.setLineDash([]);

    cached = { canvas: c, size, half, drawW: size, drawH: size };
    _unitSelectionRingSpriteCache.set(key, cached);
    if (_unitSelectionRingSpriteCache.size > 80) {
        let trim = _unitSelectionRingSpriteCache.size - 80;
        for (let k of _unitSelectionRingSpriteCache.keys()) {
            _unitSelectionRingSpriteCache.delete(k);
            trim--;
            if (trim <= 0) break;
        }
    }
    return cached;
}

function _trimSmallSpriteCache(cache, maxEntries) {
    if (!cache || cache.size <= maxEntries) return;
    let trim = cache.size - maxEntries;
    for (let k of cache.keys()) {
        cache.delete(k);
        trim--;
        if (trim <= 0) break;
    }
}

function _getOverlayRectOutlineSprite(w, h, lineType, strokeColor, lineWidth = 1) {
    let rw = Math.max(2, Math.round(Number(w) || 0));
    let rh = Math.max(2, Math.round(Number(h) || 0));
    let lw = Math.max(1, Number(lineWidth) || 1);
    let color = String(strokeColor || '#9aa');
    let key = rw + '|' + rh + '|' + String(lineType || OVERLAY_LINE_SOLID) + '|' + color + '|' + lw;
    let cached = _overlayRectOutlineSpriteCache.get(key);
    if (cached) return cached;

    let pad = Math.ceil(lw) + 2;
    let cw = rw + pad * 2;
    let ch = rh + pad * 2;
    let scale = _getUiSpriteScale();
    let c = document.createElement('canvas');
    c.width = cw * scale;
    c.height = ch * scale;
    let g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.strokeStyle = color;
    g.lineWidth = lw;
    if (lineType === OVERLAY_LINE_DOTTED) g.setLineDash([4, 3]);
    else g.setLineDash([]);
    g.strokeRect(pad + 0.5, pad + 0.5, rw - 1, rh - 1);
    g.setLineDash([]);

    cached = { canvas: c, offsetX: pad, offsetY: pad, drawW: cw, drawH: ch };
    _overlayRectOutlineSpriteCache.set(key, cached);
    _trimSmallSpriteCache(_overlayRectOutlineSpriteCache, 32);
    return cached;
}

function _getOverlayLineSprite(lineType, strokeColor, lineWidth = 1) {
    let len = 64;
    let lw = Math.max(1, Number(lineWidth) || 1);
    let color = String(strokeColor || '#9aa');
    let key = String(lineType || OVERLAY_LINE_SOLID) + '|' + color + '|' + lw;
    let cached = _overlayLineSpriteCache.get(key);
    if (cached) return cached;

    let pad = Math.ceil(lw) + 2;
    let cw = len + pad * 2;
    let ch = pad * 2 + 2;
    let cy = ch * 0.5;
    let scale = _getUiSpriteScale();
    let c = document.createElement('canvas');
    c.width = cw * scale;
    c.height = ch * scale;
    let g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.strokeStyle = color;
    g.lineWidth = lw;
    if (lineType === OVERLAY_LINE_DOTTED) g.setLineDash([4, 3]);
    else g.setLineDash([]);
    g.beginPath();
    g.moveTo(pad, cy + 0.5);
    g.lineTo(pad + len, cy + 0.5);
    g.stroke();
    g.setLineDash([]);

    cached = { canvas: c, halfW: cw * 0.5, halfH: ch * 0.5, baseLen: len, drawW: cw, drawH: ch };
    _overlayLineSpriteCache.set(key, cached);
    _trimSmallSpriteCache(_overlayLineSpriteCache, 128);
    return cached;
}

function _drawOverlayLineSprite(ctx, x1, y1, x2, y2, lineType, strokeColor, lineWidth = 1) {
    let dx = x2 - x1;
    let dy = y2 - y1;
    let len = detHypot(dx, dy);
    if (len < 1) return;
    let sprite = _getOverlayLineSprite(lineType, strokeColor, lineWidth);
    let cx = (x1 + x2) * 0.5;
    let cy = (y1 + y2) * 0.5;
    let ang = Math.atan2(dy, dx);
    let sx = len / sprite.baseLen;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(Math.round(cx), Math.round(cy));
    ctx.rotate(ang);
    ctx.scale(sx, 1);
    ctx.drawImage(sprite.canvas, -sprite.halfW, -sprite.halfH, sprite.drawW, sprite.drawH);
    ctx.restore();
}

function _getOverlayMarkerSprite(kind, color) {
    let k = String(kind || 'plus');
    let cKey = String(color || '#9aa');
    let key = k + '|' + cKey;
    let cached = _overlayMarkerSpriteCache.get(key);
    if (cached) return cached;

    let drawSize = 20;
    let scale = _getUiSpriteScale();
    let c = document.createElement('canvas');
    c.width = drawSize * scale;
    c.height = drawSize * scale;
    let g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.setTransform(scale, 0, 0, scale, 0, 0);

    if (k === 'rally_arrow') {
        g.fillStyle = cKey;
        g.beginPath();
        g.moveTo(6, 2);
        g.lineTo(14, 6);
        g.lineTo(6, 10);
        g.closePath();
        g.fill();
        cached = { canvas: c, offsetX: 6, offsetY: 10, drawW: drawSize, drawH: drawSize };
    } else {
        g.strokeStyle = cKey;
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(16, 10);
        g.arc(10, 10, 6, 0, 6.28);
        g.moveTo(6, 10);
        g.lineTo(14, 10);
        g.moveTo(10, 6);
        g.lineTo(10, 14);
        g.stroke();
        cached = { canvas: c, offsetX: 10, offsetY: 10, drawW: drawSize, drawH: drawSize };
    }

    _overlayMarkerSpriteCache.set(key, cached);
    _trimSmallSpriteCache(_overlayMarkerSpriteCache, 16);
    return cached;
}

// Tick system
let currentTick = 0;
let localInputBuffer = {}; // {tick: [actions]}
let lockstepLocalPacketByTick = {}; // {tick: packet}
let lockstepHostPacketsByTick = {}; // host only: {tick: {peerId: packet}}
let lockstepBundleByTick = {}; // {tick: {tick, packets, combinedChecksum}}
let lockstepPendingBundleByTick = {}; // guest only: {tick: raw bundle pending validation}
let lockstepPendingBundleAckByTick = {}; // guest only: {tick: combinedChecksum pending ack send}
let lockstepPendingCommitByTick = {}; // guest only: {tick: combinedChecksum pending apply}
let lockstepCommittedByTick = {}; // {tick: true}
let lockstepBundleAckByTick = {}; // host only: {tick: {peerId: true}}
let lockstepLastPacketSentAtByTick = {}; // {tick: timestamp}
let lockstepLastBundleSentAtByTick = {}; // host only: {tick: timestamp}
let lockstepLastFinalizeSentAtByTick = {}; // host only: {tick: timestamp} for proactive committed rebroadcasts
let lockstepLastResendRequestAtByTick = {}; // host/guest: {tick: timestamp}
let lockstepHostHardResyncRequestedByTick = {}; // host only: {tick: true}
let nextLocalActionSeq = 1;
// A command's id is actor:epoch:seq; the epoch is new at every reset of the
// world (a guest's reload of the match starts its count again under the same
// peer id: without it a new command took the id of one that ran before, and
// the host's record of the commands that ran dropped it: main.js
// lockstepCommandRan).
function _newLocalActionEpoch() { return Math.floor(Math.random() * 2176782336).toString(36); }
let _localActionEpoch = _newLocalActionEpoch();
let waitingForRemoteSince = 0;
let lockstepLastHardResyncRequestAt = 0;
let lockstepHardResyncInFlightUntil = 0;
let lockstepPostSnapshotGraceUntilAt = 0;
let lockstepSnapshotLastSentAtByPeer = {};
let lockstepResyncPauseActive = false;
let lockstepResyncSessionId = '';
let lockstepResyncPendingAckByPeer = {};
let lockstepResyncSnapshotCache = null;
let lockstepResyncFreezeActive = false;
let lockstepResyncFreezeTick = -1;
let lockstepResyncResumeTick = -1;
let lockstepStrictDebugMode = false;
let lockstepFatalStopActive = false;
let lockstepFatalStopTick = -1;
let lockstepFatalStopReason = '';
let lockstepFatalStopDetails = null;
let nextUnitId = 1;
let visualRng = null; // separate RNG for particles/visual effects (not synced)

// Multiplayer
let peer = null, myPeerId = null, connections = [], connectedPlayers = [];
let wsRoomId = null, wsHostId = null;
let networkSessionEpoch = 0;
let removedFromMatchPeerIds = new Set();
let guestReconnectTimer = null;
let guestReconnectAttempt = 0;
let remoteMatchRunning = false;
let pendingJoinAsSpectator = false;
let duplicateUidBlocked = false;
let duplicateUidBlockReason = '';
let matchStartLobbyPlayers = [];
let matchStartConfig = null;
let matchStartSessionId = '';
let matchStartWaitingForReady = false;
let matchStartExpectedReadyPeerIds = [];
let matchStartReadyByPeerId = {};
let matchStartTeamByPeerId = {};
let matchStartTeamByUid = {};
let matchRoleByPeerId = {};
let matchRoleByUid = {};
let peerUidByPeerId = {};
let remoteRoleByPeerId = {};
let remotePresenceByPeerId = {};
let peerLatencyByPeerId = {};
let peerLatencyUpdatedAtByPeerId = {};
let pendingPingByPeerId = {};
let remoteLatencyByPeerId = {};
let nextNetworkPingSeq = 1;
let lastNetworkPingSweepAt = 0;
let lockstepHistoryByTick = {};
let lockstepExpectedStateHashByTick = {};
let lockstepLocalStateHashByTick = {};
let lockstepExpectedStateDigestByTick = {};
let lockstepLocalStateDigestByTick = {};
let lockstepDesyncDetected = false;
let lockstepHashGraceUntilTick = -1;
// Highest tick whose local packet a guest has sent. Commands are never added
// to a sent tick, so they cannot be lost when the host already sealed it.
let lockstepHighestSentLocalTick = -1;
let lockstepResyncRequestedAt = 0;
let lockstepResyncDeadlineAt = 0;
let lockstepReceivedResyncSessionId = '';
let lockstepAppliedResyncSessionId = '';
let lockstepPendingResumeSessionId = '';
let lockstepLastWarnAtByKey = {};
let lockstepHostWaitRequestByPeer = {};
// Host: ticks sealed without a playing guest's packet, because it came too
// late ({tick: Set(peerId)}), and the commands of those packets once they
// arrive, waiting for that guest's next open tick ({peerId: [action]}).
let lockstepHostLateByTick = {};
let lockstepHostCarryByPeer = {};
let lockstepHostLastOnTimeAt = {}; // host: {peerId: host tick when its last in-time packet came}
let lockstepHostLastPacketAt = {}; // host: {peerId: time any packet of it last came}
let lockstepHostLastPacketTick = {}; // host: {peerId: newest tick it sent a packet for}
let lockstepGuestWaitRequest = null;
const LS_PLAYER_UID_KEY = 'defence3_player_uid';
const LS_PLAYER_NAME_KEY = 'defence3_player_name';
const LS_UI_SETTINGS_KEY = 'defence3_ui_settings_v1';
const NETWORK_PING_INTERVAL_MS = 1000;
const NETWORK_LATENCY_STALE_MS = 8000;
let localPersistentPeerId = '';
let localPreferredName = '';
let isHost = false, isMultiplayer = false;
let lobbyPlayers = [];
let peerPresenceById = {};
let longPressRallyEnabled = window.innerWidth <= 800;
