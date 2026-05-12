// GLOBAL STATE
// ============================================================
let dirtyGrid = true, dirtyAreas = true;
let visibilityGrid = [];
let visibilityVersion = 0;
let fullVisibility = false;

let grid = []; // 2D array [y][x] = {type, item, owner, areaId}
let areas = [];
let goldMines = []; // {gx, gy, gold, maxGold}
let astarMines = []; // {gx, gy, astar, maxAstar}
let areaNeighborIds = []; // [areaId] -> [neighborAreaId]
let areaDistanceMatrix = []; // [areaId] -> Int16Array(areaCount)
let areaIdsByDistance = []; // [areaId][distance] -> [areaId]
let areaIdsWithinDistance = []; // [areaId][distance] -> [areaId]
let areaIdGrid = []; // 2D lookup [y][x] -> areaId
let gridCellsByArea = []; // [areaId] -> [{x,y}]
let gridCellsByAreaDistance = []; // [areaId][distance] -> [{x,y}]
let gridCellsWithinAreaDistance = []; // [areaId][distance] -> [{x,y}]
let spatialUnitsByArea = []; // [areaId] -> Set<Unit>
let droppedItemsByArea = []; // [areaId] -> [drop]

const TILE_ENTITY_NONE = '';
const TILE_ENTITY_GOLDMINE = 'goldmine';
const TILE_ENTITY_ASTARMINE = 'astarmine';
let tileEntityType = []; // 2D lookup [y][x] -> string type
let tileEntityRef = [];  // 2D lookup [y][x] -> entity reference
let _activeTileEntities = new Set();
let _adjacencyDirtyTiles = new Set();
let _adjacencyNeedsRecalc = true;
let _adjacencyDirtyAll = true;
let _adjacencyLastRecalcTick = -1;

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
    let areaCount = Array.isArray(areas) ? areas.length : 0;
    areaIdGrid = Array.from({ length: GRID_H }, () => new Int32Array(GRID_W).fill(-1));
    if (areaCount <= 0) {
        resetAreaDistanceCaches();
        return;
    }

    let neighborSets = Array.from({ length: areaCount }, () => new Set());
    for (let area of areas) {
        if (!area || !Number.isFinite(area.id)) continue;
        _areaById[area.id] = area;
    }

    for (let y = 0; y < GRID_H; y++) {
        let row = grid[y];
        if (!row) continue;
        for (let x = 0; x < GRID_W; x++) {
            let cell = row[x];
            if (!cell) continue;
            let areaId = Math.floor(Number(cell.areaId));
            areaIdGrid[y][x] = areaId;
            if (!(areaId >= 0 && areaId < areaCount)) continue;

            if (x + 1 < GRID_W) {
                let rightId = Math.floor(Number(grid[y][x + 1] && grid[y][x + 1].areaId));
                if (rightId >= 0 && rightId < areaCount && rightId !== areaId) {
                    neighborSets[areaId].add(rightId);
                    neighborSets[rightId].add(areaId);
                }
            }
            if (y + 1 < GRID_H) {
                let downId = Math.floor(Number(grid[y + 1] && grid[y + 1][x] && grid[y + 1][x].areaId));
                if (downId >= 0 && downId < areaCount && downId !== areaId) {
                    neighborSets[areaId].add(downId);
                    neighborSets[downId].add(areaId);
                }
            }
        }
    }

    areaNeighborIds = new Array(areaCount);
    areaDistanceMatrix = new Array(areaCount);
    areaIdsByDistance = new Array(areaCount);
    areaIdsWithinDistance = new Array(areaCount);
    gridCellsByArea = new Array(areaCount);
    gridCellsByAreaDistance = new Array(areaCount);
    gridCellsWithinAreaDistance = new Array(areaCount);
    if (!Array.isArray(spatialUnitsByArea) || spatialUnitsByArea.length !== areaCount) {
        spatialUnitsByArea = Array.from({ length: areaCount }, () => new Set());
    } else {
        for (let i = 0; i < spatialUnitsByArea.length; i++) {
            if (!(spatialUnitsByArea[i] instanceof Set)) spatialUnitsByArea[i] = new Set();
        }
    }
    droppedItemsByArea = Array.from({ length: areaCount }, () => []);
    for (let i = 0; i < droppedItems.length; i++) {
        let drop = droppedItems[i];
        if (!drop) continue;
        _addDroppedItemToAreaBucket(drop, getAreaIdAtTile(drop.gx, drop.gy));
    }

    for (let source = 0; source < areaCount; source++) {
        let neighbors = Array.from(neighborSets[source]).sort((a, b) => a - b);
        areaNeighborIds[source] = neighbors;
        if (_areaById[source]) _areaById[source].neighborAreaIds = neighbors;
        let ownCells = (_areaById[source] && Array.isArray(_areaById[source].cells)) ? _areaById[source].cells.slice() : [];
        gridCellsByArea[source] = ownCells;

        let distances = new Int16Array(areaCount);
        distances.fill(-1);
        distances[source] = 0;

        let queue = [source];
        let head = 0;
        let maxDistance = 0;
        while (head < queue.length) {
            let current = queue[head++];
            let nextDistance = distances[current] + 1;
            let currentNeighbors = neighborSets[current];
            if (!currentNeighbors) continue;
            for (let next of currentNeighbors) {
                if (distances[next] !== -1) continue;
                distances[next] = nextDistance;
                if (nextDistance > maxDistance) maxDistance = nextDistance;
                queue.push(next);
            }
        }

        let exact = Array.from({ length: maxDistance + 1 }, () => []);
        for (let target = 0; target < areaCount; target++) {
            let dist = distances[target];
            if (dist < 0) continue;
            if (!exact[dist]) exact[dist] = [];
            exact[dist].push(target);
        }

        let within = new Array(exact.length);
        let cumulative = [];
        for (let distance = 0; distance < exact.length; distance++) {
            if (exact[distance] && exact[distance].length > 0) cumulative = cumulative.concat(exact[distance]);
            within[distance] = cumulative.slice();
        }

        let exactGridCells = new Array(exact.length);
        let cumulativeGridCells = new Array(exact.length);
        let cumulativeCells = [];
        for (let distance = 0; distance < exact.length; distance++) {
            let areaIds = exact[distance] || [];
            let cellsAtDistance = [];
            for (let i = 0; i < areaIds.length; i++) {
                let targetAreaId = areaIds[i];
                let targetArea = _areaById[targetAreaId];
                if (!targetArea || !Array.isArray(targetArea.cells) || targetArea.cells.length <= 0) continue;
                cellsAtDistance = cellsAtDistance.concat(targetArea.cells);
            }
            exactGridCells[distance] = cellsAtDistance;
            if (cellsAtDistance.length > 0) cumulativeCells = cumulativeCells.concat(cellsAtDistance);
            cumulativeGridCells[distance] = cumulativeCells.slice();
        }

        areaDistanceMatrix[source] = distances;
        areaIdsByDistance[source] = exact;
        areaIdsWithinDistance[source] = within;
        gridCellsByAreaDistance[source] = exactGridCells;
        gridCellsWithinAreaDistance[source] = cumulativeGridCells;
        if (_areaById[source]) {
            _areaById[source].distanceRow = distances;
            _areaById[source].areaIdsByDistance = exact;
            _areaById[source].areaIdsWithinDistance = within;
            _areaById[source].gridCells = ownCells;
            _areaById[source].gridCellsByAreaDistance = exactGridCells;
            _areaById[source].gridCellsWithinAreaDistance = cumulativeGridCells;
        }
    }
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

function getAreaDistance(areaA, areaB) {
    let aId = Math.floor(Number(areaA));
    let bId = Math.floor(Number(areaB));
    if (aId < 0 || bId < 0 || aId >= areaDistanceMatrix.length) return -1;
    let row = areaDistanceMatrix[aId];
    if (!row || bId >= row.length) return -1;
    return row[bId];
}

function getAreaIdsAtDistance(areaId, distance) {
    let aId = Math.floor(Number(areaId));
    let dist = Math.max(0, Math.floor(Number(distance) || 0));
    let buckets = areaIdsByDistance[aId];
    if (!buckets || !buckets[dist]) return [];
    return buckets[dist];
}

function getAreaIdsWithinDistance(areaId, distance) {
    let aId = Math.floor(Number(areaId));
    let dist = Math.max(0, Math.floor(Number(distance) || 0));
    let buckets = areaIdsWithinDistance[aId];
    if (!buckets || buckets.length <= 0) return [];
    if (dist >= buckets.length) dist = buckets.length - 1;
    return dist >= 0 && buckets[dist] ? buckets[dist] : [];
}

function getGridCellsAtAreaDistance(areaId, distance) {
    let aId = Math.floor(Number(areaId));
    let dist = Math.max(0, Math.floor(Number(distance) || 0));
    let buckets = gridCellsByAreaDistance[aId];
    if (!buckets || !buckets[dist]) return [];
    return buckets[dist];
}

function getGridCellsWithinAreaDistance(areaId, distance) {
    let aId = Math.floor(Number(areaId));
    let dist = Math.max(0, Math.floor(Number(distance) || 0));
    let buckets = gridCellsWithinAreaDistance[aId];
    if (!buckets || buckets.length <= 0) return [];
    if (dist >= buckets.length) dist = buckets.length - 1;
    return dist >= 0 && buckets[dist] ? buckets[dist] : [];
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
    requestAdjacencyRecalc();
}

function setTileEntity(gx, gy, type, ref) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return;
    if (!tileEntityType[gy] || !tileEntityRef[gy]) return;
    let prevRef = tileEntityRef[gy][gx];
    if (prevRef && prevRef !== ref) _activeTileEntities.delete(prevRef);
    tileEntityType[gy][gx] = type || TILE_ENTITY_NONE;
    tileEntityRef[gy][gx] = ref || null;
    if (ref) _activeTileEntities.add(ref);
    _markAdjacencyDirtyAt(gx, gy, 1);
}

function clearTileEntity(gx, gy, expectedRef = null) {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return;
    if (!tileEntityType[gy] || !tileEntityRef[gy]) return;
    if (expectedRef && tileEntityRef[gy][gx] !== expectedRef) return;
    let prevRef = tileEntityRef[gy][gx];
    if (prevRef) _activeTileEntities.delete(prevRef);
    tileEntityType[gy][gx] = TILE_ENTITY_NONE;
    tileEntityRef[gy][gx] = null;
    let tileIndex = gy * GRID_W + gx;
    let baseIndex = tileIndex * _WORKER_TARGET_LOAD_TYPE_COUNT;
    for (let i = 0; i < _WORKER_TARGET_LOAD_TYPE_COUNT; i++) {
        let reservedUnit = workerReservedTiles[baseIndex + i];
        if (reservedUnit) reservedUnit._workerReservedTileIndex = -1;
        workerReservedTiles[baseIndex + i] = null;
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

let rng = null; // shared PRNG
let gameSeed = 0;

let towers = [];
let units = [];
let projectiles = [];
let particles = [];
let barracks = [];
let collectorSpawners = [];
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

function addDroppedItem(drop) {
    if (!drop) return null;
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
    let gx = Math.floor(Number(drop.gx));
    let gy = Math.floor(Number(drop.gy));
    if (gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H) {
        if (getDroppedItemAt(gx, gy) === drop) _setDroppedItemAt(gx, gy, null);
        let tileIndex = gy * GRID_W + gx;
        let baseIndex = tileIndex * _WORKER_TARGET_LOAD_TYPE_COUNT;
        for (let i = 0; i < _WORKER_TARGET_LOAD_TYPE_COUNT; i++) {
            let reservedUnit = workerReservedTiles[baseIndex + i];
            if (reservedUnit) reservedUnit._workerReservedTileIndex = -1;
            workerReservedTiles[baseIndex + i] = null;
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
let renderRangeMode = RENDER_RANGE_TURRETS;
let showGoldMineAmountText = false;
let audioVolume = 1;
let audioBackgroundVolume = 1;

const OVERLAY_LINE_DOTTED = 'dotted';
const OVERLAY_LINE_SOLID = 'solid';
const OVERLAY_SCOPE_BUILDINGS = 'buildings';
const OVERLAY_SCOPE_BUILDINGS_UNITS = 'buildings_units';
const OVERLAY_SCOPE_NONE = 'none';

let rallyLineType = OVERLAY_LINE_DOTTED;
let rallyLineScope = OVERLAY_SCOPE_BUILDINGS;
let selectionOutlineType = OVERLAY_LINE_DOTTED;
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
    return selectionOutlineScope === OVERLAY_SCOPE_BUILDINGS || selectionOutlineScope === OVERLAY_SCOPE_BUILDINGS_UNITS;
}

function showSelectionOutlinesForUnits() {
    return selectionOutlineScope === OVERLAY_SCOPE_BUILDINGS_UNITS;
}

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
    let len = Math.hypot(dx, dy);
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
let nextLocalActionSeq = 1;
let waitingForRemoteSince = 0;
let lockstepLastHardResyncRequestAt = 0;
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
