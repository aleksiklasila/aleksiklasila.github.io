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
    constructor() { this.flag = new Uint8Array(0); this.n = 0; this.min = 0; this.sum = 0; }
    get size() { return this.n; }
    has(k) { return k >= 0 && k < this.flag.length && this.flag[k] === 1; }
    add(k) {
        k = k | 0;
        if (k < 0) return this;
        if (k >= this.flag.length) { const f = new Uint8Array(Math.max(k + 1, GRID_W * GRID_H, this.flag.length * 2)); f.set(this.flag); this.flag = f; }
        if (this.flag[k]) return this;
        this.flag[k] = 1;
        if (this.n++ === 0 || k < this.min) this.min = k;
        this.sum = (this.sum + Math.imul(k + 1, 2654435761)) | 0;
        return this;
    }
    delete(k) {
        if (!this.has(k)) return false;
        this.flag[k] = 0; this.n--;
        this.sum = (this.sum - Math.imul(k + 1, 2654435761)) | 0;
        return true;
    }
    clear() { if (this.n) this.flag.fill(0); this.n = 0; this.min = 0; this.sum = 0; }
    // The first `max` tiles by index, taken out.
    takeFirst(max) {
        const out = [], f = this.flag;
        let k = this.min;
        for (; k < f.length && out.length < max && this.n > 0; k++) {
            if (!f[k]) continue;
            f[k] = 0; this.n--;
            this.sum = (this.sum - Math.imul(k + 1, 2654435761)) | 0;
            out.push(k);
        }
        this.min = k;
        return out;
    }
    *[Symbol.iterator]() { const f = this.flag; let left = this.n; for (let k = this.min; k < f.length && left > 0; k++) if (f[k]) { left--; yield k; } }
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

    _areaNeighborSets = neighborSets;
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

let _areaNeighborSets = [];
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
    if (!(range > 0) || !Number.isFinite(wx) || !Number.isFinite(wy)) return;
    const x = wx / TILE, y = wy / TILE;
    const minX = Math.floor(x - .3), maxX = Math.floor(x + .3);
    const minY = Math.floor(y - .3), maxY = Math.floor(y + .3);
    const centerArea = light ? getAreaIdAtTile(Math.floor(x), Math.floor(y)) : -1;
    for (let gy = minY; gy <= maxY; gy++) for (let gx = minX; gx <= maxX; gx++) {
        const area = getAreaIdAtTile(gx, gy);
        if (area < 0) continue;
        sources.set(area, Math.max(sources.get(area) || 0, range));
        // Start the neighboring area's fade before the center crosses into it.
        // Stamping only across area borders preserves normal within-area light.
        if (light && area !== centerArea) {
            light[gy][gx] = Math.max(light[gy][gx], range * AREA_UNIT_TILE_EQUIVALENT);
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

function initTileEntityLookup() {
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
        let list = _cellItemsRowMajor;
        for (let i = 0; i < changes.length; i++) list = _tileOrderedReplace(list, changes[i], _cellItemAtTile(changes[i]));
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
    _tileEntityVersion++;
    noteTileEntityChanged(gx, gy);
    if (prevRef && typeof workerWorkChanged === 'function') workerWorkChanged(Number.isFinite(prevRef.owner) ? prevRef.owner : -1, null, gx, gy);
    if (typeof simMoveTileEntityChanged === 'function') simMoveTileEntityChanged(gx, gy);
    tileEntityType[gy][gx] = TILE_ENTITY_NONE;
    tileEntityRef[gy][gx] = null;
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
const PURCHASE_MULTIPLIERS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
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
let startingResourcesAdjustMultiplier = 1;
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
let ignoreLevelSubgroups = true;

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
let renderRangeMode = RENDER_RANGE_ALL;
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
