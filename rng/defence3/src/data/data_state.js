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
// The tile entities: the tabled structures and mines in tile order (from the
// per-tile table, W2), then any outside the tables (the page's views, kept
// here). A new one a new lookup (initTileEntityLookup): its identity tells
// the indexes the world was replaced.
class TileEntitySet {
    constructor() { this._loose = new Set(); this._ver = -1; this._tver = -1; this._list = null; this._tiles = null; this._cnt = null; }
    // (Tabled at its tile: the table holds it.)
    _tabled(e) { return !!e && _ST.n === GRID_W * GRID_H && !!_ST.ctab && e._stT >= 0 && getTileEntityRef(e.gx, e.gy) === e; }
    add(e) { if (e && !this._tabled(e)) this._loose.add(e); return this; }
    delete(e) { return this._loose.delete(e); }
    has(e) { return !!e && (this._loose.has(e) || this._tabled(e)); }
    get size() { return this._tabledList().length + this._loose.size; }
    // The tabled ones' tiles in tile order (reg.rs k_tile_occupied: this._tiles,
    // how many returned), made again when the tile entities changed.
    tileList() {
        const N = GRID_W * GRID_H;
        if (_ST.n !== N || !_ST.ctab) return 0;
        if (this._tver === _tileEntityVersion && this._tiles) return this._cnt[0];
        // (Room: every tabled row at most, no more than the tiles.)
        let rows = 0;
        for (const T of _sTables.values()) rows += T.cap;
        const room = Math.min(N, Math.max(1024, rows)), mk = (n) => typeof simSharedArray === 'function' ? simSharedArray(Int32Array, n) : new Int32Array(n);
        if (!this._tiles || this._tiles.length < room) { this._tiles = mk(room); this._cnt = mk(4); }
        // (The page's world, no kernels on its thread: a plain pass.)
        if (typeof _simWasmX !== 'undefined' && _simWasmX !== null && simHeapHas(_ST.ctab) && simHeapHas(this._tiles) && simHeapHas(this._cnt)) { _teP[0] = N; _teP[1] = this._tiles.length; simRustDirect('k_tile_occupied', [_ST.ctab, this._tiles, this._cnt], _teP); }
        else { const C = _ST.ctab, Tl = this._tiles, cap = Tl.length; let m = 0; for (let t = 0; t < N && m < cap; t++) if (C[t] !== 0) Tl[m++] = t; this._cnt[0] = m; }
        this._tver = _tileEntityVersion;
        return this._cnt[0];
    }
    // The tabled ones in tile order (their objects), made again when the tile entities changed.
    _tabledList() {
        const N = GRID_W * GRID_H;
        if (_ST.n !== N || !_ST.ctab) return _NO_TILE_ENTITIES;
        if (this._ver === _tileEntityVersion && this._list) return this._list;
        const n = this.tileList(), out = new Array(n), Tl = this._tiles;
        let w = 0;
        for (let i = 0; i < n; i++) { const t = Tl[i], gx = t % GRID_W, e = getTileEntityRef(gx, (t - gx) / GRID_W); if (e) out[w++] = e; }
        out.length = w;
        this._list = out; this._ver = _tileEntityVersion;
        return out;
    }
    *[Symbol.iterator]() { yield* this._tabledList(); yield* this._loose; }
}
const _NO_TILE_ENTITIES = Object.freeze([]), _teP = new Float64Array(2);
let _activeTileEntities = new TileEntitySet();
let _tileEntityVersion = 0; // bumped whenever the tile entity index changes
// Tiles whose adjacency is to be worked out again (the adjacency post kernel
// takes them all at a batch, ord.rs k_adj_post): a flag per tile, their count, the lowest flagged tile (nothing below it is flagged)
// and the order-free sum the state hash takes (sum of (k + 1) * 2654435761),
// kept as tiles come and go. (A Set copied and sorted every tick cost ~60 ms
// with 230k tiles waiting after a mass placement.) Set-like: add, delete,
// has, size, clear, iteration (ascending).
class _AdjDirtySet {
    // (blk: flagged tiles per 256: empty stretches skipped by the post kernel
    // and the iteration; scanning the flags of a 1M-tile map was ~1 ms a tick.)
    constructor() { this.flag = new Uint8Array(0); this.blk = new Int32Array(0); this.n = 0; this.min = 0; this.sum = 0; }
    get size() { return this.n; }
    has(k) { return k >= 0 && k < this.flag.length && this.flag[k] === 1; }
    add(k) {
        k = k | 0;
        if (k < 0) return this;
        if (k >= this.flag.length) this.room(Math.max(k + 1, GRID_W * GRID_H, this.flag.length * 2));
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
    // (Room for n tiles; the arrays in the wasm heap once it is up: the
    // adjacency post kernel takes and clears the flags, ord.rs k_adj_post.)
    room(n) {
        const heap = typeof simSharedArray === 'function' && typeof _simHeapAlloc !== 'undefined' && _simHeapAlloc !== null;
        if (n <= this.flag.length && (!heap || simHeapHas(this.flag))) return;
        n = Math.max(n, this.flag.length);
        const mk = (T, m) => heap ? simSharedArray(T, m) : new T(m);
        const f = mk(Uint8Array, n); f.set(this.flag);
        const b = mk(Int32Array, (n + 255) >> 8); b.set(this.blk);
        if (heap) { if (simHeapHas(this.flag)) simHeapFree(this.flag); if (simHeapHas(this.blk)) simHeapFree(this.blk); }
        this.flag = f; this.blk = b;
    }
    // (Every flag taken by the post kernel: the counts follow.)
    takenAll() { this.n = 0; this.min = 0; this.sum = 0; }
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
// (rtab / rrow: a rally structure's class (1 + its index in
// structRallyClasses, 0 none) and its table row, per tile: the rally kernel's,
// main.js _rallyKernel.)
const _ST = { n: 0, code: null, own: null, uc: null, val: null, tim: null, brain: null, rtab: null, rrow: null, rcnt: null, rw: 0, mineArr: new Int32Array(64), mineN: 0, mineAt: null,
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
// Structures per owner (mines and unowned ones aside): cnt holds the owner a
// tile is counted for, + 1 (0: none), so a refresh or an owner change moves
// the count once. The page's copy comes with the frame globals.
const structCountByOwner = new Int32Array(64);
function _stOwnCount(t, w) {
    const T = _ST, c = T.cnt[t];
    if (c) structCountByOwner[c - 1]--;
    if (w >= 0 && w < 64 && T.code[t] !== 0 && T.code[t] < 0x66) { structCountByOwner[w]++; T.cnt[t] = w + 1; } else T.cnt[t] = 0;
}
function playerStructureCount(pid) { return pid >= 0 && pid < 64 ? structCountByOwner[pid] : 0; }
// The limit: the match's (configuredMaxBuildings: the menu's, from the
// memory budget and the population), no more than each team's share of the
// structure pool (from constants, the map and the teams: the same on every peer).
function _structTeams() { return typeof activeTeamIds !== 'undefined' && Array.isArray(activeTeamIds) && activeTeamIds.length ? activeTeamIds.length : Math.max(1, typeof players !== 'undefined' && Array.isArray(players) ? players.length : 1); }
function getPlayerStructureLimit() {
    return Math.max(1, Math.min(configuredMaxBuildings(_structTeams(), GRID_W * GRID_H), structMemoryLimitPerPlayer()));
}
function structMemoryLimitPerPlayer() {
    return Math.max(1, Math.floor(structReserveRowsTotal() / _structTeams()));
}
function _stOwnerWord(v) { return (v | 0) === v ? v : ST_OWNER_NONE; }
// (Made at the first entity joining: the page's lookup holds views only.)
function structTableReset() {
    for (const e of _activeTileEntities) if (e && e._stT >= 0) e._stT = -1;
    const T = _ST;
    T.mineN = 0; if (T.mineAt) T.mineAt.fill(0);
    T.mineRegN = 0; if (T.mineSum) { T.mineSum.fill(0); T.mineRc.fill(0); T.mineRegAt.fill(0); }
    structCountByOwner.fill(0);
    if (T.n !== GRID_W * GRID_H) { T.n = 0; T.code = T.own = T.uc = T.val = T.tim = T.brain = T.rtab = T.stab = T.rrow = T.ctab = T.rcnt = T.cnt = null; }
    else { T.cnt.fill(0); T.code.fill(0); T.own.fill(0); T.uc.fill(0); T.val.fill(0); T.tim.fill(0); T.brain.fill(0); T.rtab.fill(0); T.stab.fill(0); T.rrow.fill(-1); T.ctab.fill(0); T.rcnt.fill(0); }
}
function _stRegion(t) { const gx = t % GRID_W, gy = (t - gx) / GRID_W, rt = SNAP_REGION_TILES; return Math.floor(gy / rt) * _ST.rw + Math.floor(gx / rt); }
function _stClear(t) { const T = _ST; if (T.code[t] !== 0) { T.rcnt[_stRegion(t)]--; if (T.code[t] >= 0x66) _stMineDel(t); } if (T.cnt[t]) _stOwnCount(t, -1); T.code[t] = 0; T.own[t] = 0; T.uc[t] = 0; T.val[t] = 0; T.tim[t] = 0; T.brain[t] = 0; T.rtab[t] = 0; T.stab[t] = 0; T.rrow[t] = -1; T.ctab[t] = 0; }
// The per-tile rally index and every table's columns into the current wasm
// heap (a restarted worker's heap is new; the kernels read only it).
function structTablesRehome() {
    if (typeof cellColumnsRehome === 'function') cellColumnsRehome();
    _teLogRoom();
    const T = _ST;
    if (T.code && typeof simSharedArray === 'function') for (const k of ['code', 'own', 'uc', 'val', 'tim', 'brain', 'rtab', 'stab', 'rrow', 'ctab', 'cnt', 'rcnt']) {
        const was = T[k], a = simSharedArray(was.constructor, was.length);
        a.set(was); T[k] = a;
    }
    for (const t of _sTables.values()) {
        if (!_sColsInHeap(t) || (typeof _simHeapPtrOf === 'function' && ((t.mTok && !(_simHeapPtrOf(t.mTok) >= 0)) || (t.ret && !(_simHeapPtrOf(t.ret) >= 0))))) _sTableGrow(t, t.cap);
        if (t.mxOvN && typeof _simHeapPtrOf === 'function' && !(_simHeapPtrOf(t.mxOvN) >= 0)) { const a = _sColAlloc(Int32Array, 4); a.set(t.mxOvN); t.mxOvN = a; }
    }
}
// The rally structures' classes (their tables' rally fields: the rally kernel's,
// ord.rs RALLY_TABLES of them, in this order).
let _stRallyCls = null, _stRallyIx = null, _stStatusIx = null, _stAllCls = null, _stAllIx = null;
function structRallyClasses() {
    if (_stRallyCls) return _stRallyCls;
    _stRallyCls = [typeof Barrack !== 'undefined' ? Barrack : null, typeof CollectorSpawner !== 'undefined' ? CollectorSpawner : null, typeof AstarSpawner !== 'undefined' ? AstarSpawner : null,
        typeof SalvagerSpawner !== 'undefined' ? SalvagerSpawner : null, typeof BuilderSpawner !== 'undefined' ? BuilderSpawner : null, typeof HealerSpawner !== 'undefined' ? HealerSpawner : null,
        typeof ResearchSpawner !== 'undefined' ? ResearchSpawner : null];
    _stRallyIx = new Map(); _stRallyCls.forEach((C, i) => { if (C) _stRallyIx.set(C, i + 1); });
    // (The status classes: renderer.js STRUCT_STATUS_CLASSES, the per-tile stab.)
    _stStatusIx = new Map(); [typeof Tower !== 'undefined' ? Tower : null, FloorItem, ..._stRallyCls].forEach((C, i) => { if (C) _stStatusIx.set(C, i + 1); });
    // (Every tabled class, mines too: the per-tile ctab, getTileEntityRef.)
    _stAllCls = [typeof Tower !== 'undefined' ? Tower : null, FloorItem, ..._stRallyCls, typeof GoldMine !== 'undefined' ? GoldMine : null, typeof AstarMine !== 'undefined' ? AstarMine : null];
    _stAllIx = new Map(); _stAllCls.forEach((C, i) => { if (C) _stAllIx.set(C, i + 1); });
    return _stRallyCls;
}
// The per-tile table sized to the map (made at the first entity joining, or
// by a pass that reads it before any did: the first adjacency pass of a
// match without structures yet). Keep the authoritative structure SoA
// directly readable by kernels: no per-tick object walk or full-grid mirror
// for tower queries.
function structTableEnsure() {
    const T = _ST, n = GRID_W * GRID_H;
    if (T.n === n) return;
    const alloc = (Type, count) => typeof simSharedArray === 'function' ? simSharedArray(Type, count) : new Type(count);
    T.n = n; T.code = alloc(Uint8Array, n); T.own = alloc(Int32Array, n); T.uc = alloc(Uint8Array, n); T.val = alloc(Float64Array, n); T.tim = alloc(Float64Array, n); T.brain = alloc(Int32Array, n);
    T.rtab = alloc(Uint8Array, n); T.stab = alloc(Uint8Array, n); T.rrow = alloc(Int32Array, n); T.rrow.fill(-1); T.ctab = alloc(Uint8Array, n);
    T.cnt = alloc(Uint8Array, n);
    T.rw = Math.ceil(GRID_W / SNAP_REGION_TILES); T.rcnt = alloc(Uint8Array, T.rw * Math.ceil(GRID_H / SNAP_REGION_TILES));
}
// Tile (gx, gy) held `prev` and now holds `ref` (null: nothing).
function structTableSet(gx, gy, prev, ref) {
    const t = gy * GRID_W + gx, T = _ST, n = GRID_W * GRID_H;
    if (t < 0 || t >= n) return;
    if (prev && prev !== ref && prev._stT === t) prev._stT = -1;
    const joins = !!ref && typeof ref._stT === 'number' && !!ref._stCode;
    // (A list's member joined or left: its view, structListView.)
    { structRallyClasses(); const k0 = T.ctab && T.n === n ? _STL_KIND[T.ctab[t]] : -1, k1 = ref ? _STL_KIND[_stAllIx.get(ref.constructor) || 0] : -1;
      if (prev !== ref || k0 !== k1) { if (k0 >= 0) _stlBump(k0); if (k1 >= 0 && k1 !== k0) _stlBump(k1); } }
    if (T.n !== n) {
        if (!joins) return;
        structTableEnsure();
    }
    _stClear(t);
    if (ref && ref._sr >= 0) {
        structRallyClasses(); T.rrow[t] = ref._sr;
        const j = _stRallyIx.get(ref.constructor); if (j) T.rtab[t] = j;
        const k = _stStatusIx.get(ref.constructor); if (k) T.stab[t] = k;
        const c = _stAllIx.get(ref.constructor); if (c) T.ctab[t] = c;
    }
    if (!joins) return;
    // (An entity moved to another tile leaves its old one.)
    if (ref._stT >= 0 && ref._stT !== t) _stClear(ref._stT);
    ref._stT = t;
    T.code[t] = ref._stCode; T.rcnt[_stRegion(t)]++;
    if (ref._stMine) _stMineAdd(t);
    _stWrite(ref, t);
}
function _stCellOwner(t) { const gx = t % GRID_W, row = typeof grid !== 'undefined' && grid ? grid[(t - gx) / GRID_W] : null; return row && row[gx] ? row[gx].owner : undefined; }
function _stWrite(ref, t) {
    const T = _ST;
    if (ref._stMine) { T.own[t] = ST_OWNER_NONE; _stMineVal(t, Number(ref._mv)); T.tim[t] = 0; }
    // (A floor item given no owner: its cell's, as the towers' floor search took it.)
    else { T.own[t] = _stOwnerWord(ref._ow !== undefined || ref._stCode !== 0x55 ? ref._ow : _stCellOwner(t)); _stOwnCount(t, T.own[t]); T.uc[t] = ref._uc ? 1 : 0; T.val[t] = Number(ref._en); T.tim[t] = ref._stCode === 0x22 ? Number(ref._cdUntil) || 0 : ref._stTimer ? Number(ref._spt) || 0 : 0; }
    stationaryBrainChanged(ref);
}

// Shared stationary descriptor: type (16 bits), base level (8), preference
// and override flags (2), effective level (6).
// Published only on placement or field changes, never packed per tick. The
// tile core above remains authoritative for life, owner and construction.
// The types' ids are the same on every peer: seeded at the first structure
// from the static definitions in their order (every card type, then a
// barrack of every unit type); others (none expected) appended after. Ids
// given in the order types first appeared differed on a peer that restored a
// snapshot, and per-type tables then answered for other types (a poison
// shot killed a barrack on one peer only).
const _stationaryTypes = [], _stationaryTypeIds = new Map();
function _stationaryTypesSeed() {
    if (_stationaryTypes.length) return;
    const add = raw => { if (raw && !_stationaryTypeIds.has(raw)) { _stationaryTypeIds.set(raw, _stationaryTypes.length); _stationaryTypes.push(raw); } };
    if (typeof BASE_CARD_TYPES !== 'undefined' && BASE_CARD_TYPES) for (const k of Object.keys(BASE_CARD_TYPES)) add(k);
    if (typeof BASE_UNIT_STATS !== 'undefined' && BASE_UNIT_STATS) for (const k of Object.keys(BASE_UNIT_STATS)) add('barrack_' + k);
}
function stationaryBrainChanged(e) {
    const tile = e._stT;
    if (!(tile >= 0) || !_ST.brain || e._stMine) return;
    const raw = e.type === 'barrack' ? 'barrack_' + e.unitType : e.type;
    if (!raw) { _ST.brain[tile] = 0; return; }
    _stationaryTypesSeed();
    let type = _stationaryTypeIds.get(raw);
    if (type === undefined) { type = _stationaryTypes.length; _stationaryTypeIds.set(raw, type); _stationaryTypes.push(raw); }
    const T = _sTables.get(e.constructor), row = e._sr;
    const effective = getThingEffectiveLevel(e);
    const custom = effective>63 || (T && ['currentStats', 'x', 'y'].some(k => T.unique[k]?.has(row)));
    // (A preferred target: tower.js Tower.preferredTargetSpec, its row's _ptK; custom values: its row's tc.*.)
    const preferred = e._stCode === 0x22 && e._ptK > 0;
    if (custom && e._stCode === 0x22 && typeof towerCustomWrite === 'function') towerCustomWrite(e, row);
    _ST.brain[tile] = (type + 1) | (Math.min(255, getThingBaseLevel(e)) << 16) | (preferred ? 1 << 24 : 0) | (custom ? 1 << 25 : 0) | (Math.min(63,effective) << 26);
}
// A structure's entry written again from its fields (a restore sets some
// fields directly, not through the accessors).
function structTableRefresh(e) {
    if (e && e._stT >= 0 && _ST.n && _ST.code[e._stT] !== 0) _stWrite(e, e._stT);
}
// The structure lists (towers, barracks, collectorSpawners): views of the
// per-tile structure table (Stage E), in tile order, the same on every peer
// whatever the history. A kind's view is filled again from the occupied
// tiles (reg.rs k_tile_occupied) when its membership version moved
// (structTableSet, the destroy batch); the arrays stay the same objects
// until a reset or a restore replaces the lists (callers key caches on
// them). The page of a simulation worker holds its own lists of views
// (structListsSetView). Kind of a class code (ctab): 0 towers, 1 barracks,
// 2 spawners, -1 none.
const _STL_KIND = [-1, 0, -1, 1, 2, 2, 2, 2, 2, 2, -1, -1];
const _stl = { arr: [[], [], []], ver: [-1, -1, -1], view: null };
function _stlVer(k) { return k === 0 ? towersVersion : k === 1 ? barracksVersion : collectorSpawnersVersion; }
function _stlBump(k) { if (k === 0) towersVersion++; else if (k === 1) barracksVersion++; else if (k === 2) collectorSpawnersVersion++; }
function structListView(k) {
    const L = _stl;
    if (L.view !== null) return L.view[k];
    if (L.ver[0] !== towersVersion || L.ver[1] !== barracksVersion || L.ver[2] !== collectorSpawnersVersion) _stlFill();
    return L.arr[k];
}
function _stlFill() {
    const L = _stl, T = _ST, A = L.arr;
    structRowStats.listFills = (structRowStats.listFills | 0) + 1;
    A[0].length = 0; A[1].length = 0; A[2].length = 0;
    L.ver[0] = towersVersion; L.ver[1] = barracksVersion; L.ver[2] = collectorSpawnersVersion;
    if (T.n !== GRID_W * GRID_H || !T.ctab) return;
    const n = _activeTileEntities.tileList(), Tl = _activeTileEntities._tiles, C = T.ctab, R = T.rrow;
    for (let i = 0; i < n; i++) {
        const t = Tl[i], c = C[t], k = _STL_KIND[c];
        if (k === undefined || k < 0) continue;
        const Tb = _stTabByCt[c] || _stTabOfCt(c), o = Tb && R[t] >= 0 ? Tb.rowObj[R[t]] : null;
        if (o && o._stT === t) A[k].push(o);
    }
}
// The lists replaced (a reset, a restore): the tables hold the members; the
// versions tell the lists' caches (the cloud and laser lists too). On the
// page of a simulation worker: its lists emptied (its views come again).
function structListsReplaced() {
    const L = _stl;
    for (let k = 0; k < 3; k++) { if (L.view !== null) L.view[k] = []; else L.arr[k] = []; _stlBump(k); }
    cloudTowersVersion++; laserTowersVersion++;
}
// towers, barracks, collectorSpawners: each the same object for the match's
// code (a lexical binding), standing for the kind's current view array.
function _stlProxy(k) {
    return new Proxy([], {
        get(_, key) { const a = structListView(k), v = a[key]; return typeof v === 'function' && key !== 'constructor' ? v.bind(a) : v; },
        set(_, key, v) { structListView(k)[key] = v; return true; },
        has(_, key) { return key in structListView(k); },
        ownKeys() { return Reflect.ownKeys(structListView(k)); },
        getOwnPropertyDescriptor(_, key) { const d = Reflect.getOwnPropertyDescriptor(structListView(k), key); if (d && key !== 'length') d.configurable = true; return d; },
        deleteProperty(_, key) { return delete structListView(k)[key]; }
    });
}
// The live structures of list kinds k0..k1 (their tables' rows held, not
// retired): the lists' sizes without filling them.
function structLiveRows(k0, k1) {
    structRallyClasses();
    let n = 0;
    for (let c = 1; c < _STL_KIND.length; c++) { const k = _STL_KIND[c]; if (k < k0 || k > k1) continue; const Tb = _stTabByCt[c] || _stTabOfCt(c); if (Tb) n += Tb.n - Tb.nfree - Tb.qn; }
    return n;
}
function structListsSetView(lists) { _stl.view = lists ? [lists[0] || [], lists[1] || [], lists[2] || []] : null; if (!lists) { _stl.arr = [[], [], []]; _stlBump(0); _stlBump(1); _stlBump(2); } }
// ---- structure rows (ENTITY_TABLES_PLAN.md T1) ----
// A structure's fields are columns of its class's table, the object only its
// row (_sr): ~0.4 KB a structure instead of ~1.5 KB of object, properties
// and boxed numbers (200k buildings: ~200 MB less on each of the page and the
// worker). Kinds: 'n' a number (Float64; undefined stored as NaN, read back
// as undefined, as a field never set), 'f' a Float32 one (the same; values
// whose precision does not matter: tick damages, angles), 'N' a number or null
// (Float64, null stored as NaN: rally points, written in bulk by
// main.js _rallySetTiles), 'i' / 's' / 'c' a
// whole number in Int32 / Int16 / Int8 (tiles, list places, stacks, levels,
// owners, timers; undefined stored as the type's lowest value), 'b' a boolean
// (Uint8: 0 unset, 1 false, 2 true), 'r' anything else (an array of values). Fields not listed
// stay the object's own. Rows are not reused within a match (a destroyed
// structure's object may still be read); the tables start over with it
// (structTableReset). Lists from a census of chaos matches
// (.claude/struct_field_census.cjs).
const _STF_BUILDING = 'i:_stT c:_ow b:_uc n:_en s:gx s:gy n:x n:y r:type i:stacks i:manualStacks i:effectiveStacks c:level c:effectiveLevel '
    + 'c:potentialEffectiveLevel b:isStacking n:stackingWorkDone n:maxEnergy b:markedForSalvage b:autoUpgradeEnabled b:buildEnabled b:isUpgrading '
    + 'i:effectiveGroupSize n:effectiveAreaMult r:preComputedBase r:preComputedEffective r:preComputed '
    + 'r:preComputedPotential i:burning f:burnTickDamage i:poisoned f:poisonTickDamage i:frozen f:iceTickDamage i:wet i:sandy i:watched c:watchedByTeam '
    + 'r:_levelTextLabel i:_vsGen c:_vsR c:_vsA c:_vsP1 c:_vsP2 i:_vsListId b:autoStackEnabled r:_ambientSoundTicks n:upgrademaxEnergy n:_mxOv n:_ovMx c:_ovVs';
const _STF_SPAWNER = 'n:_spt b:queueEnabled c:_qN n:_qLv n:_qReq n:_qPaid N:rallyX N:rallyY N:rallyTargetUnitId n:spawnCooldown r:_spawnReadyOrder N:_rallyLastSeenX N:_rallyLastSeenY b:_pendingRallyDetach';
const _STF_MINE = 'i:_stT n:_mv s:gx s:gy n:x n:y';
const STRUCT_TABLE_FIELDS = {
    Tower: _STF_BUILDING + ' r:baseStats r:currentStats r:textCtx n:_cdUntil f:angle c:laserState n:laserTimer c:_lzLv b:_lzUc c:_ptK i:_ptV',
    Barrack: _STF_BUILDING + ' ' + _STF_SPAWNER + ' r:unitType',
    CollectorSpawner: _STF_BUILDING + ' ' + _STF_SPAWNER, AstarSpawner: _STF_BUILDING + ' ' + _STF_SPAWNER, SalvagerSpawner: _STF_BUILDING + ' ' + _STF_SPAWNER,
    BuilderSpawner: _STF_BUILDING + ' ' + _STF_SPAWNER, HealerSpawner: _STF_BUILDING + ' ' + _STF_SPAWNER,
    ResearchSpawner: _STF_BUILDING + ' ' + _STF_SPAWNER + ' b:autoResearchEnabled',
    FloorItem: _STF_BUILDING + ' n:damage',
    GoldMine: _STF_MINE + ' n:maxGold', AstarMine: _STF_MINE + ' n:maxAstar'
};
const _sTables = new Map();
// The number kinds' arrays and the value standing for undefined.
const _S_NUM_KINDS = { n: [Float64Array, NaN], N: [Float64Array, NaN], f: [Float32Array, NaN], i: [Int32Array, -2147483648], s: [Int16Array, -32768], c: [Int8Array, -128] };
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
    const sr=e._sr,T=sr===undefined||sr<0?null:_sTables.get(e.constructor),ix=sr*3+(which==='effective'?1:which==='potential'?2:0);
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
    if(v==null || Number.isNaN(v) || (_thingStatViews.has(v)) || (name==='currentStats'&&v===BASE_CARD_TYPES[e.type])){map.delete(e._sr);_sOvSync(T,e._sr,name);if(name==='currentStats'||name==='x'||name==='y')stationaryBrainChanged(e);return;}
    const normal=_sDerivedValue(e,name);
    if(Object.is(v,normal))map.delete(e._sr);else map.set(e._sr,v);
    _sOvSync(T,e._sr,name);
    if(name==='currentStats'||name==='x'||name==='y')stationaryBrainChanged(e);
}
// The adjacency kernel's mirrors of a row's object overrides (ord.rs
// k_adj_apply): _ovMx its preComputedBase's maxEnergy (Tower.updateStats
// reads it), _ovVs the vision steps of its preComputedEffective (NaN / -128:
// none).
function _sOvSync(T,r,name) {
    if(T.c__ovMx===undefined)return;
    if(name==='preComputedBase'){const o=T.unique.preComputedBase.get(r),m=o?Number(o.maxEnergy):NaN;T.c__ovMx[r]=Number.isFinite(m)?m:NaN;}
    else if(name==='preComputedEffective'){
        const o=T.unique.preComputedEffective.get(r),range=!o?NaN:Number.isFinite(o.visionRangeArea)?o.visionRangeArea:Number.isFinite(o.visionRange)?o.visionRange:NaN;
        T.c__ovVs[r]=!o?-128:Number.isFinite(range)?(range>=0?Math.min(127,areaSteps(range)):-1):-2;
    }
}
function _sDerivedReconcile(T,e) {
    { const b=e._sr*3,m=T.mTok; m[b]=0; m[b+1]=0; m[b+2]=0; }
    for(const name of T.derived){const map=T.unique[name];if(!map.size)continue;const v=map.get(e._sr);if(v!==undefined&&Object.is(v,_sDerivedValue(e,name))){map.delete(e._sr);_sOvSync(T,e._sr,name);}}
    stationaryBrainChanged(e);
}
// Override columns (not snapshot keys: the derived names are) and the
// lasers' derived beam inputs (laserCheck makes them again).
const _S_OV_COLS = new Set(['_mxOv', '_ovMx', '_ovVs', '_lzLv', '_lzUc']);
// The maxEnergy overrides of a table, as a Map of row -> value over the heap
// column _mxOv (NaN none) and a heap count word (T.mxOvN[0]): the adjacency
// kernel reads and clears them (ord.rs k_adj_apply).
class SOverrideColumn {
    constructor(T) { this.T = T; if (!T.mxOvN) T.mxOvN = _sColAlloc(Int32Array, 4); }
    get size() { return this.T.mxOvN[0]; }
    get(r) { const v = this.T.c__mxOv[r]; return v === v ? v : undefined; }
    has(r) { const v = this.T.c__mxOv[r]; return v === v; }
    set(r, v) { const a = this.T.c__mxOv; if (a[r] !== a[r]) this.T.mxOvN[0]++; a[r] = v; return this; }
    delete(r) { const a = this.T.c__mxOv; if (a[r] !== a[r]) return false; a[r] = NaN; this.T.mxOvN[0]--; return true; }
    clear() { this.T.c__mxOv.fill(NaN); this.T.mxOvN[0] = 0; }
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
    T = { C, fields, derived, unique:Object.fromEntries(derived.map(k=>[k,new Map()])), cap: 0, n: 0, nfree: 0, qhdr: null, rowObj: null, keys: fields.filter(f => f.name !== '_stT' && !_S_OV_COLS.has(f.name)).map(f => f.name) };
    for (const f of fields) T[f.col] = null;
    // (The retire queue's head, tail and length: heap words the destroy kernel
    // writes, dst.rs k_struct_destroy.)
    T.qhdr = _sColAlloc(Int32Array, 4); T.qhdr[0] = -1; T.qhdr[1] = -1;
    Object.defineProperty(T, 'qh', { get() { return this.qhdr[0]; }, set(v) { this.qhdr[0] = v; } });
    Object.defineProperty(T, 'qt', { get() { return this.qhdr[1]; }, set(v) { this.qhdr[1] = v; } });
    Object.defineProperty(T, 'qn', { get() { return this.qhdr[2]; }, set(v) { this.qhdr[2] = v; } });
    _sTables.set(C, T);
    _sTableGrow(T, 1024);
    if (T.unique.maxEnergy && T.c__mxOv !== undefined) T.unique.maxEnergy = new SOverrideColumn(T);
    // (A structure taken out of the world (structRowDetach: _sr -1) keeps its values in its _sdet record, a derived override as $name.)
    for(const name of derived)Object.defineProperty(C.prototype,name,{configurable:true,get(){if(this._sr<0){const d=this._sdet,v=d?d['$'+name]:undefined;return v!==undefined?v:_sDerivedValue(this,name);}const map=T.unique[name],v=map.size?map.get(this._sr):undefined;return v!==undefined?v:_sDerivedValue(this,name);},set(v){if(this._sr<0){_sDetOf(this)['$'+name]=v==null||Number.isNaN(v)?undefined:v;return;}_sDerivedSet(T,this,name,v);}});
    for (const f of fields) {
        const col='T.' + f.col;
        const at = col + '[this._sr]';
        const nk = _S_NUM_KINDS[f.kind], fl = f.kind === 'n' || f.kind === 'f', nul = f.kind === 'N', und = nk ? String(nk[1]) : '';
        const read = nul ? 'let x = ' + at + '; return x === x ? x : null;' : nk ? (fl ? 'let x = ' + at + '; return x === x ? x : undefined;' : 'const x = ' + at + '; return x === ' + und + ' ? undefined : x;') : f.kind === 'b' ? 'const x = ' + at + '; return x === 2 ? true : x === 1 ? false : undefined;' : 'return ' + (f.shared ? col+'.get(this._sr)' : at) + ';';
        let write = nul ? at + " = typeof v === 'number' ? v : NaN;" : nk ? (fl ? at + ' = v === undefined ? NaN : v;' : at + ' = v === undefined || v === null || v !== v ? ' + und + ' : v;') : f.kind === 'b' ? at + ' = v === undefined ? 0 : v ? 2 : 1;' : f.shared ? col+'.set(this._sr,v);' : at + ' = v;';
        if(['_ow','level','effectiveLevel','potentialEffectiveLevel','type','unitType','stacks','manualStacks'].includes(f.name))write+=' _sDerivedReconcile(T,this);';
        if(f.name==='_ptK')write+=' stationaryBrainChanged(this);';
        Object.defineProperty(C.prototype, f.name, { configurable: true, enumerable: false,
            get: new Function('T', 'return function () { if (this._sr < 0) { const d = this._sdet; return d ? d[' + JSON.stringify(f.name) + '] : undefined; } ' + read + ' };')(T),
            set: new Function('T','_sDerivedReconcile','_sDetOf', 'return function (v) { if (this._sr < 0) { _sDetOf(this)[' + JSON.stringify(f.name) + '] = v; return; } ' + write + ' };')(T,_sDerivedReconcile,_sDetOf) });
    }
    // (The tick its row retired at while kept, -2 once it expired: a snapshot
    // key, so a restored peer's copy expires at the same tick, see
    // structRowRetireAt.)
    Object.defineProperty(C.prototype, '_retiredAt', { configurable: true, enumerable: false,
        get() { const r = this._sr; if (r >= 0) return T.ret[r] && T.rowObj[r] === this ? T.rt[r] : undefined; return this._sdet === _S_GONE ? -2 : undefined; },
        set(v) { if (Number.isFinite(v)) structRowRetireAt(this, v); } });
    // (A gone structure's kept tile (_sKeepTile), gy * 65536 + gx: a snapshot
    // key after _retiredAt, so a restored copy's digest term is the host's.)
    Object.defineProperty(C.prototype, '_goneTile', { configurable: true, enumerable: false,
        get() { return this._sr < 0 && this._sdet === _S_GONE && typeof this._hgx === 'number' ? (this._hgy | 0) * 65536 + (this._hgx | 0) : undefined; },
        set(v) { if (Number.isFinite(v)) { _sKeepTile({ gx: v % 65536, gy: Math.floor(v / 65536) }, this); } } });
    return T;
}
// A table's number and flag columns: in the wasm heap once it is up (the
// structure kernels read them: main.js _rallyKernel), allocated at the
// match's start (structTablesReserve), never grown in play.
function _sColAlloc(Type, n) { return typeof simHeapArray === 'function' && typeof _simHeapAlloc !== 'undefined' && _simHeapAlloc !== null ? simHeapArray(Type, n) : new Type(n); }
function _sColFree(a) { if (typeof simHeapFree === 'function' && typeof _simHeapPtrOf !== 'undefined' && _simHeapPtrOf !== null && _simHeapPtrOf(a) >= 0) simHeapFree(a); }
// (Whether its columns are where the kernels read them: false while the heap
// is up and they are not in it.)
function _sColsInHeap(T) {
    if (typeof _simHeapAlloc === 'undefined' || _simHeapAlloc === null || typeof _simHeapPtrOf === 'undefined' || _simHeapPtrOf === null) return true;
    for (const f of T.fields) if (!f.shared && f.kind !== 'r') return _simHeapPtrOf(T[f.col]) >= 0;
    return true;
}
function _sTableGrow(T, cap) {
    for (const f of T.fields) {
        const was = T[f.col];
        let a;
        if (f.shared) { a=_simRefGrow(was,cap,undefined,true); }
        else if (f.kind === 'r') { a = new Array(cap).fill(undefined); if (was) for (let i = 0; i < T.n; i++) a[i] = was[i]; }
        else { const nk = _S_NUM_KINDS[f.kind]; a = _sColAlloc(nk ? nk[0] : Uint8Array, cap); if (nk) a.fill(nk[1]); if (was) { a.set(was.subarray(0, T.n)); _sColFree(was); } }
        T[f.col] = a;
    }
    {
        // (The tokens in the heap: the adjacency kernel clears a row's.)
        const was = T.mTok, tok = _sColAlloc(Int32Array, cap * 3), ent = new Array(cap * 3).fill(undefined);
        if (was) { tok.set(was.subarray(0, T.n * 3)); for (let i = 0; i < T.n * 3; i++) ent[i] = T.mEnt[i]; _sColFree(was); }
        T.mTok = tok; T.mEnt = ent;
    }
    // (The row pool: rowObj the structure holding a row, ret 1 while it is
    // retired (out of the world, its values still in the row), rt the tick it
    // retired, rp/rn the retire queue (oldest first), free the expired rows.)
    {
        // (ret / rt / rp / rn in the heap: the destroy kernel retires rows.)
        const n = T.n, obj = new Array(cap).fill(null), ret = _sColAlloc(Uint8Array, cap), rt = _sColAlloc(Int32Array, cap), rp = _sColAlloc(Int32Array, cap), rn = _sColAlloc(Int32Array, cap), free = new Int32Array(cap);
        if (T.rowObj) { for (let i = 0; i < n; i++) obj[i] = T.rowObj[i]; ret.set(T.ret.subarray(0, n)); rt.set(T.rt.subarray(0, n)); rp.set(T.rp.subarray(0, n)); rn.set(T.rn.subarray(0, n)); free.set(T.freeRows.subarray(0, T.nfree)); _sColFree(T.ret); _sColFree(T.rt); _sColFree(T.rp); _sColFree(T.rn); }
        T.rowObj = obj; T.ret = ret; T.rt = rt; T.rp = rp; T.rn = rn; T.freeRows = free;
        { const q = _sColAlloc(Int32Array, 4); q.set(T.qhdr); _sColFree(T.qhdr); T.qhdr = q; }
    }
    T.cap = cap;
}
// Structure rows are a pool sized at the match's start (structTablesReserve)
// and reused, never copied: a structure taken out of the world keeps its row
// (its values stay readable through stale references: a worker's target, a
// selection, a pooled snapshot object) for STRUCT_ROW_KEEP_TICKS, then the
// row is cleared for the next structure and the old object reads as
// destroyed (_S_GONE). Expiry goes by the destroy order and the tick (the
// same on every peer), not by when a row is next wanted. (Detach used to copy
// every field into a dictionary record: 50 ms in a destroy wave, ~3 MB a
// tick of garbage.)
const STRUCT_ROW_KEEP_TICKS = 200;
// (What a structure whose row expired reads: out of the world, no energy.
// Writes to it go to a sink nobody reads.)
const _S_GONE = Object.freeze(Object.assign(Object.create(null), { _stT: -1, _en: 0, _ow: -1, _uc: false, _mv: 0, _spt: 0 }));
const _sGoneSink = Object.create(null);
// (Not enumerable: _sdet is no snapshot key, see _sTableKeys.)
// (Its tile kept on the object, hidden (_hgx, _hgy): a unit's digest term of
// it as a target (sim_unit_state.js _simHEnc) the same as while it was
// there; a row that expired read no tile, and the digest moved off its
// fields. Read before the row is cleared.)
function _sKeepTile(o, to = o) { const gx = o.gx, gy = o.gy; if (typeof gx === 'number') { Object.defineProperty(to, '_hgx', { value: gx, writable: true, configurable: true, enumerable: false }); Object.defineProperty(to, '_hgy', { value: gy, writable: true, configurable: true, enumerable: false }); } }
function _sSetGone(o) { o._sr = -1; Object.defineProperty(o, '_sdet', { value: _S_GONE, writable: true, configurable: true, enumerable: false }); }
let structRowStats = { retired: 0, expired: 0, grown: 0 };
function _sRowQueueUnlink(T, r) {
    const p = T.rp[r], n = T.rn[r];
    if (p < 0) T.qh = n; else T.rn[p] = n;
    if (n < 0) T.qt = p; else T.rp[n] = p;
    T.ret[r] = 0; T.qn--;
}
// Row r into the retire queue at tick (in tick order: a restore's
// structures come with their own ticks).
function _sRowQueueInsert(T, r, tick) {
    let p = T.qt;
    while (p >= 0 && T.rt[p] > tick) p = T.rp[p];
    const n = p < 0 ? T.qh : T.rn[p];
    T.rp[r] = p; T.rn[r] = n;
    if (p < 0) T.qh = r; else T.rn[p] = r;
    if (n < 0) T.qt = r; else T.rp[n] = r;
    T.ret[r] = 1; T.rt[r] = tick; T.qn++;
}
// o retired at tick (its row kept till then + STRUCT_ROW_KEEP_TICKS), or
// (-2) already expired: a snapshot's _retiredAt.
function structRowRetireAt(o, tick) {
    const r = o._sr, T = _sTables.get(o.constructor);
    if (!T) return;
    if (r >= 0 && T.rowObj[r] === o && T.ret[r]) _sRowQueueUnlink(T, r);
    if (tick === -2) { _sKeepTile(o); if (r >= 0 && T.rowObj[r] === o) _sRowFree(T, r); _sSetGone(o); return; }
    if (r >= 0 && T.rowObj[r] === o) { _sRowQueueInsert(T, r, tick); structRowStats.retired++; }
}
// Row r's retired structure lets go of it: the row cleared, onto the free stack.
function _sRowExpire(T, r) {
    const o = T.rowObj[r];
    if (o) _sKeepTile(o);
    _sRowQueueUnlink(T, r);
    _sRowFree(T, r);
    if (o) _sSetGone(o);
    structRowStats.expired++;
}
function _sRowFree(T, r) {
    for (const name of T.derived) { const m = T.unique[name]; if (m.size) m.delete(r); }
    for (const f of T.fields) {
        const a = T[f.col];
        if (f.shared) a.set(r, undefined);
        else if (f.kind === 'r') a[r] = undefined;
        else { const nk = _S_NUM_KINDS[f.kind]; a[r] = nk ? nk[1] : 0; }
    }
    T.mTok[r * 3] = 0; T.mTok[r * 3 + 1] = 0; T.mTok[r * 3 + 2] = 0;
    T.mEnt[r * 3] = undefined; T.mEnt[r * 3 + 1] = undefined; T.mEnt[r * 3 + 2] = undefined;
    T.rowObj[r] = null;
    T.freeRows[T.nfree++] = r;
}
// Once a tick: rows retired STRUCT_ROW_KEEP_TICKS ago expire.
function structRowsExpire() {
    for (const T of _sTables.values()) while (T.qn > 0 && gameTime - T.rt[T.qh] >= STRUCT_ROW_KEEP_TICKS) _sRowExpire(T, T.qh);
}
// A row for structure o (its class's table; none: its fields stay its own).
function _sRowTake(o) {
    const T = _sTableOf(o.constructor);
    if (!T) return false;
    // (An expired row first, then a fresh one; the table full: it grows, which
    // structTablesReserve's budget is there to avoid. Retired rows are not
    // taken early: when a structure reads as destroyed must not depend on a
    // peer's table size.)
    let r;
    if (T.nfree === 0 && T.n >= T.cap) { _sTableGrow(T, Math.ceil(T.cap * 1.5 / 1024) * 1024); structRowStats.grown++; }
    r = T.nfree > 0 ? T.freeRows[--T.nfree] : T.n++;
    Object.defineProperty(o, '_sr', { value: r, writable: true, configurable: true });
    T.rowObj[r] = o;
    return true;
}
// A removed structure's record (its values while it has no row: a restore's
// shell, or a structure whose row expired: its writes go nowhere).
function _sDetOf(o) {
    let d = o._sdet;
    if (d === _S_GONE) return _sGoneSink;
    if (!d) { d = Object.create(null); Object.defineProperty(o, '_sdet', { value: d, writable: true, configurable: true, enumerable: false }); }
    return d;
}
// A structure taken out of the world (its tile cleared): its row retired, its
// values left in place (see STRUCT_ROW_KEEP_TICKS); placed again, it keeps it
// (structRowAttach).
function structRowDetach(o) {
    const r = o && o._sr;
    if (!(r >= 0)) return;
    const T = _sTables.get(o.constructor);
    if (!T || T.ret[r] || T.rowObj[r] !== o) return;
    _sRowQueueInsert(T, r, gameTime);
    structRowStats.retired++;
}
function structRowAttach(o) {
    if (!o) return;
    if (o._sr >= 0) { const T = _sTables.get(o.constructor); if (T && T.ret[o._sr] && T.rowObj[o._sr] === o) _sRowQueueUnlink(T, o._sr); return; }
    if (!(o._sr < 0)) return;
    const d = o._sdet;
    if (!_sRowTake(o)) return;
    o._sdet = undefined;
    if (!d) return;
    const T = _sTables.get(o.constructor);
    for (const f of T.fields) if (d[f.name] !== undefined) o[f.name] = d[f.name];
    for (const name of T.derived) if (d['$' + name] !== undefined) o[name] = d['$' + name];
}
// The match's structure rows, allocated at its start (startGame): the
// match's building limit for every team (configuredMaxBuildings, the memory
// budget's), a share of them for each class, no more rows than the map has tiles.
// Past it, the table grows (counted in structRowStats.grown). Retired rows
// remain readable until their deterministic expiry tick on every peer.
const STRUCT_RESERVE_SHARE = { Tower: 0.4, FloorItem: 0.25, Barrack: 0.1, CollectorSpawner: 0.04, AstarSpawner: 0.04, SalvagerSpawner: 0.03, BuilderSpawner: 0.03, HealerSpawner: 0.03, ResearchSpawner: 0.04, GoldMine: 0.02, AstarMine: 0.02 };
function _sRowBytes(T) {
    let n = 12 + 24 + 21;
    for (const f of T.fields) { const nk = _S_NUM_KINDS[f.kind]; n += nk ? nk[0].BYTES_PER_ELEMENT : f.kind === 'b' ? 1 : 8; }
    return n;
}
// (Rows a class gets: its share of the teams' limits, no more than the map's
// tiles. From the settings and constants, not from the tables as they are.)
function _structReserveRows(T, name) {
    const tiles = typeof GRID_W === 'number' && typeof GRID_H === 'number' ? GRID_W * GRID_H : 0, teams = _structTeams();
    const total = Math.min(tiles || Infinity, configuredMaxBuildings(teams, tiles) * teams);
    return Math.ceil(Math.min(tiles || Infinity, total * STRUCT_RESERVE_SHARE[name]) / 1024) * 1024;
}
let _structReserveRowsCache = null;
function structReserveRowsTotal() {
    const key = GRID_W + 'x' + GRID_H + ':' + _structTeams() + ':' + CONFIG_MAX_POP + ':' + CONFIG_MAX_BUILDINGS;
    if (_structReserveRowsCache && _structReserveRowsCache.key === key) return _structReserveRowsCache.rows;
    let rows = 0;
    for (const [name, C] of Object.entries(_structClasses())) { const T = C ? _sTableOf(C) : null; if (T) rows += _structReserveRows(T, name); }
    _structReserveRowsCache = { key, rows };
    return rows;
}
function _structClasses() {
    return { Tower: typeof Tower !== 'undefined' ? Tower : null, FloorItem, Barrack: typeof Barrack !== 'undefined' ? Barrack : null,
        CollectorSpawner: typeof CollectorSpawner !== 'undefined' ? CollectorSpawner : null, AstarSpawner: typeof AstarSpawner !== 'undefined' ? AstarSpawner : null,
        SalvagerSpawner: typeof SalvagerSpawner !== 'undefined' ? SalvagerSpawner : null, BuilderSpawner: typeof BuilderSpawner !== 'undefined' ? BuilderSpawner : null,
        HealerSpawner: typeof HealerSpawner !== 'undefined' ? HealerSpawner : null, ResearchSpawner: typeof ResearchSpawner !== 'undefined' ? ResearchSpawner : null, GoldMine, AstarMine };
}
function structTablesReserve() {
    const tiles = typeof GRID_W === 'number' && typeof GRID_H === 'number' ? GRID_W * GRID_H : 0;
    const classes = { Tower: typeof Tower !== 'undefined' ? Tower : null, FloorItem, Barrack: typeof Barrack !== 'undefined' ? Barrack : null,
        CollectorSpawner: typeof CollectorSpawner !== 'undefined' ? CollectorSpawner : null, AstarSpawner: typeof AstarSpawner !== 'undefined' ? AstarSpawner : null,
        SalvagerSpawner: typeof SalvagerSpawner !== 'undefined' ? SalvagerSpawner : null, BuilderSpawner: typeof BuilderSpawner !== 'undefined' ? BuilderSpawner : null,
        HealerSpawner: typeof HealerSpawner !== 'undefined' ? HealerSpawner : null, ResearchSpawner: typeof ResearchSpawner !== 'undefined' ? ResearchSpawner : null, GoldMine, AstarMine };
    for (const name in STRUCT_RESERVE_SHARE) {
        const C = classes[name], T = C ? _sTableOf(C) : null;
        if (!T) continue;
        const want = _structReserveRows(T, name);
        if (want > T.cap || !_sColsInHeap(T)) _sTableGrow(T, Math.max(want, T.cap));
    }
}
// The tables start over (a new match: resetWorldState. Not at a restore,
// whose new structures' rows are taken before it indexes the tiles; the rows
// of the structures it replaced stay until the next match.)
function _sTablesReset() {
    for (const T of _sTables.values()) {
        for (let r = 0; r < T.n; r++) { const o = T.rowObj[r]; if (o && T.ret[r]) _sSetGone(o); T.rowObj[r] = null; }
        T.n = 0; T.nfree = 0; T.qh = -1; T.qt = -1; T.qn = 0; T.ret.fill(0);
        T.mTok.fill(0); T.mEnt.fill(undefined);
        for(const map of Object.values(T.unique))map.clear();
        for (const f of T.fields) if (f.shared) T[f.col]=new SimSharedColumn(T.cap); else if (f.kind === 'r') T[f.col].fill(undefined); else if (_S_NUM_KINDS[f.kind]) T[f.col].fill(_S_NUM_KINDS[f.kind][1]); else T[f.col].fill(0);
    }
}
// The snapshot's keys of a tabled structure: its fields that hold a value
// (as its own keys were before).
function _sTableKeys(e) {
    const T = _sTables.get(e.constructor);
    if (!T || e._sr === undefined) return null;
    const out = [];
    for (const k of T.keys) if (e[k] !== undefined) out.push(k);
    if (e._sr < 0) { const d = e._sdet; if (d) for (const name of T.derived) if (d['$' + name] !== undefined) out.push(name); }
    else for(const name of T.derived)if(T.unique[name].has(e._sr))out.push(name);
    for (const k of Object.keys(e)) out.push(k);
    // (Last: decoded after its fields, see structRowRetireAt.)
    if (e._retiredAt !== undefined) out.push('_retiredAt');
    if (e._goneTile !== undefined) out.push('_goneTile');
    return out;
}

// First thing in a structure's constructor (and a restore's shell): its
// row, then its backing fields, in one order.
function structTableInit(o) {
    _sRowTake(o);
    o._stT = -1;
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
        set(v) { this._ow = v; const t = this._stT; if (t >= 0) { _ST.own[t] = _stOwnerWord(v); _stOwnCount(t, _ST.own[t]); } } });
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
    // (The grids hold only structures outside the tables (the page's views):
    // made at the first such one.)
    tileEntityType = null; tileEntityRef = null;
    _activeTileEntities = new TileEntitySet();
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
const TE_LOG_CAP = 262144;
let _teLog = new Uint32Array(0), _teLogBase = 0, _teLogEnd = 0, _tileEntityEpoch = 1;
// (A rolling suffix of TE_LOG_CAP entries, in the wasm heap where it is up:
// the destroy kernel appends to it, dst.rs. Dropping the entire log at
// capacity also invalidated current readers, forcing all structure/work-site
// indexes to rebuild on the same tick.)
function _teLogRoom() {
    const heap = typeof simSharedArray === 'function' && typeof _simHeapAlloc !== 'undefined' && _simHeapAlloc !== null;
    if (_teLog.length === TE_LOG_CAP && (!heap || simHeapHas(_teLog))) return _teLog;
    const next = heap ? simSharedArray(Uint32Array, TE_LOG_CAP) : new Uint32Array(TE_LOG_CAP);
    // (Entries keep their places: the ring's length is the same once full size.)
    if (_teLog.length === TE_LOG_CAP) next.set(_teLog); else for (let i = _teLogBase; i < _teLogEnd; i++) next[i & (TE_LOG_CAP - 1)] = _teLog[i & (_teLog.length - 1)];
    _teLog = next;
    return next;
}
function noteTileEntityChanged(gx, gy) {
    if (_teLog.length !== TE_LOG_CAP) _teLogRoom();
    _teLog[_teLogEnd & (_teLog.length - 1)] = gy * GRID_W + gx;
    _teLogEnd++;
    _teLogBase = Math.max(0, _teLogEnd - _teLog.length);
}
function tileEntityIndexesReset() { _tileEntityEpoch++; }
// The tiles changed since the cursor (distinct, ascending), and the cursor
// moved to now; null when the index must rebuild.
function tileEntityChangesSince(c) {
    const end = _teLogEnd;
    if (c.epoch !== _tileEntityEpoch || c.pos < _teLogBase) { c.epoch = _tileEntityEpoch; c.pos = end; return null; }
    if (c.pos === end) return _TE_NO_CHANGES;
    const from = c.pos;
    c.pos = end;
    const tiles = [];
    for (let i = from; i < end; i++) tiles.push(_teLog[i & (_teLog.length - 1)]);
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
// replaceSame also publishes a fresh list for an unchanged object on a
// journaled tile: type indexes use list identity to invalidate metadata.
function _tileOrderedReplaceMany(list, tiles, itemAt, replaceSame = false) {
    if (tiles.length === 0) return list;
    if (tiles.length === 1) return _tileOrderedReplace(list, tiles[0], itemAt(tiles[0]));
    // Record only edits, then copy directly into the final list. Slicing
    // every unchanged stretch before concat copied the whole index twice
    // and left a second index's worth of references for GC on busy ticks.
    const edits = [];
    let length = list.length;
    for (let k = 0; k < tiles.length; k++) {
        const t = tiles[k], i = _tileOrderedIndexOf(list, t), e = itemAt(t);
        const has = i < list.length && list[i].gy * GRID_W + list[i].gx === t;
        if (!has && !e) continue;
        if (!replaceSame && has && e === list[i]) continue;
        edits.push(i, e, has);
        length += (e ? 1 : 0) - (has ? 1 : 0);
    }
    if (edits.length === 0) return list;
    const out = new Array(length);
    let pos = 0, w = 0;
    for (let k = 0; k < edits.length; k += 3) {
        const i = edits[k], e = edits[k + 1], has = edits[k + 2];
        while (pos < i) out[w++] = list[pos++];
        if (e) out[w++] = e;
        if (has) pos++;
    }
    while (pos < list.length) out[w++] = list[pos++];
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
    const gx = t % GRID_W, gy = (t - gx) / GRID_W, e = getTileEntityRef(gx, gy);
    if (!e || e.gx !== gx || e.gy !== gy) return null;
    return e._stMine ? null : e;
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
        let gx = e.gx, gy = e.gy;
        if (getTileEntityRef(gx, gy) !== e || e._stMine) continue;
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
        let gx = e.gx, gy = e.gy;
        if (getTileEntityRef(gx, gy) !== e || e._stMine) continue;
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
    let prevRef = getTileEntityRef(gx, gy);
    if (prevRef && prevRef !== ref) _activeTileEntities.delete(prevRef);
    // (A removed structure placed again takes a row.)
    if (ref && ref._sr !== undefined) structRowAttach(ref);
    structTableSet(gx, gy, prevRef, ref || null);
    // (Not tabled (the page's views): the grids.)
    const tabled = !!ref && _ST.n === GRID_W * GRID_H && _ST.ctab && _ST.ctab[gy * GRID_W + gx] !== 0;
    if (!tabled && ref) { _teGrids(); tileEntityType[gy][gx] = type || TILE_ENTITY_NONE; tileEntityRef[gy][gx] = ref; }
    else if (tileEntityRef) { tileEntityType[gy][gx] = TILE_ENTITY_NONE; tileEntityRef[gy][gx] = null; }
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
    if (prevRef && prevRef !== ref) structRowDetach(prevRef);
}

function clearTileEntity(gx, gy, expectedRef = null) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return;
    let prevRef = getTileEntityRef(gx, gy);
    if (expectedRef && prevRef !== expectedRef) return;
    if (prevRef) _activeTileEntities.delete(prevRef);
    structTableSet(gx, gy, prevRef, null);
    _tileEntityVersion++;
    noteTileEntityChanged(gx, gy);
    if (prevRef && typeof workerWorkChanged === 'function') workerWorkChanged(Number.isFinite(prevRef.owner) ? prevRef.owner : -1, null, gx, gy);
    if (tileEntityRef) { tileEntityType[gy][gx] = TILE_ENTITY_NONE; tileEntityRef[gy][gx] = null; }
    // (After the clear: the walk classes' walls read the tile as it is now.)
    if (typeof simMoveTileEntityChanged === 'function') simMoveTileEntityChanged(gx, gy);
    if (prevRef && typeof visCoverOnBuildingChanged === 'function') visCoverOnBuildingChanged(prevRef);
    let tileIndex = gy * GRID_W + gx;
    let baseIndex = tileIndex * _WORKER_TARGET_LOAD_TYPE_COUNT;
    for (let i = 0; i < _WORKER_TARGET_LOAD_TYPE_COUNT; i++) {
        let reservedUnit = workerReservedAt(baseIndex + i);
        if (reservedUnit) reservedUnit._workerReservedTileIndex = -1;
        workerReservedSet(baseIndex + i, null);
    }
    _markAdjacencyDirtyAt(gx, gy, 1);
    // (Out of the world: its row back to the table, its values in its record.)
    if (prevRef) structRowDetach(prevRef);
}

// A tile's entity type: a mine's from its code, a structure's key (its
// stationary type); the grids' for what is not tabled.
function getTileEntityType(gx, gy) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return TILE_ENTITY_NONE;
    const T = _ST, t = gy * GRID_W + gx;
    if (T.n === GRID_W * GRID_H && T.ctab && T.ctab[t] !== 0) {
        const c = T.code[t];
        if (c === 0x66) return TILE_ENTITY_GOLDMINE;
        if (c === 0x77) return TILE_ENTITY_ASTARMINE;
        const e = getTileEntityRef(gx, gy);
        return e ? (e.type === 'barrack' ? 'barrack_' + e.unitType : e.type) || TILE_ENTITY_NONE : TILE_ENTITY_NONE;
    }
    if (!tileEntityType || !tileEntityType[gy]) return TILE_ENTITY_NONE;
    return tileEntityType[gy][gx] || TILE_ENTITY_NONE;
}
// The structure or mine standing at a tile: its table's row (the per-tile
// ctab and rrow); the grids' for what is not tabled (the page's views).
function getTileEntityRef(gx, gy) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return null;
    const T = _ST, t = gy * GRID_W + gx;
    if (T.n === GRID_W * GRID_H && T.ctab) {
        const c = T.ctab[t];
        if (c !== 0) { const Tb = _stTabByCt[c] || _stTabOfCt(c), r = T.rrow[t], o = Tb && r >= 0 ? Tb.rowObj[r] : null; if (o && o._stT === t) return o; }
    }
    if (!tileEntityRef || !tileEntityRef[gy]) return null;
    return tileEntityRef[gy][gx] || null;
}
// The class table of a per-tile class code (ctab: 1 + the index in
// _stAllCls), kept once made (tables are never dropped).
const _stTabByCt = [];
function _stTabOfCt(c) { structRallyClasses(); const Tb = _sTables.get(_stAllCls[c - 1]); if (Tb) _stTabByCt[c] = Tb; return Tb || null; }
// The structure at tile t of the table (no bounds or grid fallback: the
// kernels' tile lists).
function structAtTile(t) {
    const T = _ST, c = T.ctab ? T.ctab[t] : 0;
    if (c === 0) return null;
    const Tb = _stTabByCt[c] || _stTabOfCt(c), r = T.rrow[t], o = Tb && r >= 0 ? Tb.rowObj[r] : null;
    return o && o._stT === t ? o : null;
}
function _teGrids() {
    if (tileEntityRef && tileEntityRef.length === GRID_H) return;
    tileEntityType = Array.from({ length: GRID_H }, () => Array(GRID_W).fill(TILE_ENTITY_NONE));
    tileEntityRef = Array.from({ length: GRID_H }, () => Array(GRID_W).fill(null));
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

// (The structure lists: views of the table, structListView.)
const towers = _stlProxy(0), barracks = _stlProxy(1), collectorSpawners = _stlProxy(2);
// Bumped whenever a tower joins or leaves towers.
let towersVersion = 0;
function towersChanged() { towersVersion++; }
// Bumped when a cloud tower joins or leaves towers (pathfinding.js keeps
// its cloud tables by it: other towers falling in a battle leave them).
let cloudTowersVersion = 0;
function towerJoinedOrLeft(t) { towersVersion++; if (t && t.baseStats && t.baseStats.isCloud) { cloudTowersVersion++; if (typeof cloudTowerToggle === 'function') cloudTowerToggle(t); } if (t && t.type === 'laser') { laserTowersVersion++; if (typeof laserListToggle === 'function') laserListToggle(t); } }
// Bumped when a laser tower joins or leaves towers (the laser links' list).
let laserTowersVersion = 0;
// The units: the id table's view (main.js _uix, unitsView), one object for
// the match's code standing for it; its length the count, without making the
// view. Whole-list assignments are calls: unitsReplaced (a reset, a restore),
// unitsSetView (the page of a simulation worker: its frame's views).
let _unitsPageView = null;
// (push / pop / splice / length = n on the table: units added and removed
// through it, unitAdded / unitRemoved; reordering is no operation on it.)
const _UNITS_EDIT = {
    push: (...a) => { for (const u of a) unitAdded(u); return unitCount(); },
    pop: () => { const v = unitsView(), u = v[v.length - 1]; if (u) unitRemoved(u); return u; },
    splice: (i, k, ...a) => { const v = unitsView().slice(), out = v.splice(i, k === undefined ? v.length : k); for (const u of out) unitRemoved(u); for (const u of a) unitAdded(u); return out; }
};
const _UNITS_FIXED = new Set(['shift', 'unshift', 'sort', 'reverse', 'fill', 'copyWithin']);
const units = new Proxy([], {
    get(_, key) {
        const pv = _unitsPageView;
        if (key === 'length') return pv !== null ? pv.length : unitCount();
        if (pv === null && typeof key === 'string' && Object.hasOwn(_UNITS_EDIT, key)) return _UNITS_EDIT[key];
        if (pv === null && _UNITS_FIXED.has(key)) throw new Error('units.' + String(key) + ': the units are the id table, in id order');
        const a = pv !== null ? pv : unitsView(), v = a[key];
        return typeof v === 'function' && key !== 'constructor' ? v.bind(a) : v;
    },
    set(_, key, v) {
        if (_unitsPageView !== null) { _unitsPageView[key] = v; return true; }
        if (key === 'length') { const w = unitsView().slice(v); for (const u of w) unitRemoved(u); return true; }
        throw new Error('units[' + String(key) + '] =: the units are the id table');
    },
    has(_, key) { return key in (_unitsPageView !== null ? _unitsPageView : unitsView()); },
    ownKeys() { return Reflect.ownKeys(_unitsPageView !== null ? _unitsPageView : unitsView()); },
    getOwnPropertyDescriptor(_, key) { const d = Reflect.getOwnPropertyDescriptor(_unitsPageView !== null ? _unitsPageView : unitsView(), key); if (d && key !== 'length') d.configurable = true; return d; }
});
function unitsReplaced(list) { if (_unitsPageView !== null) { _unitsPageView = Array.isArray(list) ? list : []; return; } _uixFromList(list === units ? unitsView().slice() : list || []); }
function unitsSetView(list) { _unitsPageView = list ? list : null; }
let projectiles = [];
let particles = [];
// Bumped whenever a barrack joins or leaves barracks.
let barracksVersion = 0;
function barracksChanged() { barracksVersion++; }
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
            let reservedUnit = workerReservedAt(baseIndex + i);
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
