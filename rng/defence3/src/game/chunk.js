"use strict";

function initSpatialHash() {
    spatialEpoch++;
    if (typeof simUnitClearSepKeys === 'function') simUnitClearSepKeys();
    CHUNKS_W = Math.ceil(GRID_W / CHUNK_SIZE);
    CHUNKS_H = Math.ceil(GRID_H / CHUNK_SIZE);
    spatialUnits = [];
    _sxDirty = true;
    closestEnemyChunkQueryCache.clear();
    // (New count tables: changes to the old ones are void.)
    _spatialCountQ.length = 0;
    // (New type indexes: the effective-stats windows are worked out again.)
    if (typeof _simUnitState !== 'undefined' && _simUnitState) _simUnitState.columns.esOk.fill(0);

    spatialUnitTypeToIndex = Object.create(null);
    let unitKeys = Object.keys(BASE_UNIT_STATS || {});
    if (!unitKeys.includes('norm')) unitKeys.push('norm');
    for (let i = 0; i < unitKeys.length; i++) spatialUnitTypeToIndex[unitKeys[i]] = i;
    spatialNormUnitTypeIndex = Number.isFinite(spatialUnitTypeToIndex.norm) ? spatialUnitTypeToIndex.norm : 0;
    spatialUnitsComplexUnitTypeCount = unitKeys.length;
    spatialUnitsComplexPlayerCount = Math.max(1, Math.floor(Number(players && players.length) || 0));
    spatialUnitsComplexStridePerPlayer = 1 + spatialUnitsComplexUnitTypeCount; // total + perUnitType
    spatialUnitsComplexStridePerChunk = spatialUnitsComplexPlayerCount * spatialUnitsComplexStridePerPlayer;
    spatialUnitsComplex = simSharedArray(Int32Array, (CHUNKS_W * CHUNKS_H) * spatialUnitsComplexStridePerChunk);
    simParallelBind('spatial.cplx', spatialUnitsComplex);
    spatialBlockCols = Math.ceil(CHUNKS_W / SPATIAL_BLOCK_SIZE);
    spatialBlockRows = Math.ceil(CHUNKS_H / SPATIAL_BLOCK_SIZE);
    spatialBlockCounts = simSharedArray(Int32Array, spatialBlockCols * spatialBlockRows * spatialUnitsComplexPlayerCount);
    simParallelBind('ix.complex', spatialUnitsComplex); simParallelBind('ix.bcount', spatialBlockCounts);
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
    let gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE);
    if (!(gx >= 0)) gx = 0; else if (gx >= GRID_W) gx = GRID_W - 1;
    if (!(gy >= 0)) gy = 0; else if (gy >= GRID_H) gy = GRID_H - 1;
    let tile = gy * GRID_W + gx;
    simUnitMirror(u);
    const c = u._us;
    if (c) {
        const s = u._si;
        if (c.spEpoch[s] === spatialEpoch && c.spOwner[s] === c.owner[s] && c.sepKey[s] !== SIM_SEP_ABSENT) {
            if (tile !== c.spTile[s]) spatialSlotMove(c, s, gx, gy, tile);
            return;
        }
    } else if (tile === u._spatialTile && u._spatialEpoch === spatialEpoch && u._spatialOwner === u.owner) return;
    _moveUnitSpatial(u, gx, gy, tile);
}

// updateUnitSpatial for a unit by its slot, from the columns (x, y).
function spatialSlotUpdate(c, s) {
    let gx = Math.floor(c.x[s] / TILE), gy = Math.floor(c.y[s] / TILE);
    if (!(gx >= 0)) gx = 0; else if (gx >= GRID_W) gx = GRID_W - 1;
    if (!(gy >= 0)) gy = 0; else if (gy >= GRID_H) gy = GRID_H - 1;
    const tile = gy * GRID_W + gx;
    if (c.spEpoch[s] === spatialEpoch && c.spOwner[s] === c.owner[s] && c.sepKey[s] !== SIM_SEP_ABSENT) {
        if (tile !== c.spTile[s]) spatialSlotMove(c, s, gx, gy, tile);
        return;
    }
    const u = _simUnitState.owners[s];
    if (u && !u.dead) updateUnitSpatial(u);
}

// The slot version (unit state columns `c`, slot `s`) for an indexed unit
// whose owner is unchanged, into another tile (chunk counts, area, key):
// nothing is read from the unit object, so the movement kernel's events
// cost no cache misses on it.
function spatialSlotMove(c, s, gx, gy, tile) {
    const chunkKey = CHUNK_SIZE === 1 ? tile : Math.floor(gy / CHUNK_SIZE) * CHUNKS_W + Math.floor(gx / CHUNK_SIZE);
    const oldKey = c.sepKey[s], owner = c.spOwner[s];
    if (oldKey !== chunkKey) { _spatialCountSlot(c, s, oldKey, owner, -1); _spatialCountSlot(c, s, chunkKey, owner, 1); c.sepKey[s] = chunkKey; }
    const row = areaIdGrid[gy], area = row ? row[gx] : -1;
    c.spArea[s] = area >= 0 ? area : -1;
    c.spTile[s] = tile;
    if (!visCoverSlotWindow(c, s)) visCoverOnUnitSpatialChanged(_simUnitState.owners[s]);
}
function _spatialCountSlot(c, s, chunkKey, owner, delta) {
    _spatialCountAdd(chunkKey, owner, c.spType[s], delta);
}

// Per chunk and owner: unit totals and per-type counts, and the 8x8 block
// totals. Adjusted only when the chunk bucket really gained or lost the unit.
function _spatialCountUnit(u, chunkKey, owner, delta) {
    _spatialCountAdd(chunkKey, owner, u._spatialUnitTypeIdx, delta);
}
// During the unit pass the counts stay as at its start, like the unit index
// they filter (spatialIndexRebuild): a unit the movement kernel moved
// before the pass is still counted where the index lists it, whichever
// peer moved it when. The changes are applied at the pass's end.
let _spatialCountDefer = false, _spatialCountQ = [];
function _spatialCountAdd(chunkKey, owner, typeIdx, delta) {
    if (!(owner >= 0 && owner < spatialUnitsComplexPlayerCount)) return;
    if (_spatialCountDefer) { _spatialCountQ.push(chunkKey, owner, typeIdx, delta); return; }
    const base = chunkKey * spatialUnitsComplexStridePerChunk + owner * spatialUnitsComplexStridePerPlayer;
    spatialUnitsComplex[base] += delta;
    spatialUnitsComplex[base + 1 + typeIdx] += delta;
    _adjustSpatialBlockCount(chunkKey, owner, delta);
}
function spatialCountsDeferBegin() { _spatialCountDefer = true; }
// (Set by simMoveRun when its kernel moved units into other chunks.)
let _spatialKernelMoves = false;
function spatialCountsDeferEnd() {
    _spatialCountDefer = false;
    const q = _spatialCountQ;
    for (let i = 0; i < q.length; i += 4) _spatialCountAdd(q[i], q[i + 1], q[i + 2], q[i + 3]);
    q.length = 0;
    if (_spatialKernelMoves) {
        _spatialKernelMoves = false;
        const S = _simUnitState;
        if (S && typeof SIM_KERNEL_SP_COUNTS === 'number') {
            const P = _simParams, n = S.owners.length;
            P[0] = n; P[1] = 16384; P[2] = spatialUnitsComplexPlayerCount; P[3] = spatialUnitsComplexStridePerChunk; P[4] = spatialUnitsComplexStridePerPlayer;
            P[5] = CHUNKS_W; P[6] = spatialBlockCols; P[7] = SPATIAL_BLOCK_SIZE;
            simParallelRun(SIM_KERNEL_SP_COUNTS, Math.ceil(n / 16384));
        }
    }
}

function _moveUnitSpatial(u, gx, gy, tile) {
    let chunkKey = CHUNK_SIZE === 1 ? tile : Math.floor(gy / CHUNK_SIZE) * CHUNKS_W + Math.floor(gx / CHUNK_SIZE);
    let areaRow = areaIdGrid[gy], area = areaRow ? areaRow[gx] : -1;
    if (!(area >= 0)) area = -1;
    let owner = u.owner;
    let indexed = u._spatialEpoch === spatialEpoch && u._spatialKey !== undefined;
    let oldKey = indexed ? u._spatialKey : -1, oldOwner = indexed ? u._spatialOwner : -1;
    let ownerChanged = indexed && oldOwner !== owner;
    // The counts move with the unit; the unit lists are the per-tick index
    // (spatialIndexRebuild).
    if (indexed && (oldKey !== chunkKey || ownerChanged)) _spatialCountUnit(u, oldKey, oldOwner, -1);
    if (!indexed || oldKey !== chunkKey || ownerChanged) {
        if (!indexed || ownerChanged || u._spatialUnitTypeIdx === undefined) {
            let typeIdx = spatialUnitTypeToIndex[u.unitType];
            u._spatialUnitTypeIdx = typeIdx >= 0 ? typeIdx : spatialNormUnitTypeIndex;
        }
        _spatialCountUnit(u, chunkKey, owner, 1);
    }
    u._spatialTile = tile;
    u._spatialKey = chunkKey;
    u._spatialAreaId = area;
    u._spatialOwner = owner;
    u._spatialEpoch = spatialEpoch;
    simUnitSetSepKey(u, chunkKey, u.isFlying ? 1 : (u.unitType === 'mole' ? 2 : 0));
    simMoveDisarm(u);
    visCoverOnUnitSpatialChanged(u);
}

function removeUnitSpatial(u) {
    let indexed = u._spatialEpoch === spatialEpoch && u._spatialKey !== undefined;
    if (indexed) _spatialCountUnit(u, u._spatialKey, u._spatialOwner, -1);
    u._spatialKey = undefined;
    u._spatialAreaId = undefined;
    u._spatialTile = -1;
    u._spatialEpoch = 0;
    simUnitSetSepKey(u, SIM_SEP_ABSENT, 0);
    simMoveDisarm(u);
    if (indexed) visCoverOnUnitSpatialChanged(u);
}

// The area layout was rebuilt (new area buckets): every indexed unit joins
// the bucket of its tile's area, in id order.
function rebuildUnitAreaBuckets() {
    for (let u of units) {
        if (!u || u._spatialEpoch !== spatialEpoch || u._spatialKey === undefined) continue;
        let t = u._spatialTile, gx = t % GRID_W, gy = (t - gx) / GRID_W;
        let row = areaIdGrid[gy], area = row ? row[gx] : -1;
        u._spatialAreaId = area >= 0 ? area : -1;
    }
    _sxDirty = true;
}

// ---- The unit index: units by chunk and by area, rebuilt once a tick ----
// spatialIndexRebuild runs at the start of each tick (gameTick), from the
// units array, their positions and the area grid alone: every unit not
// dead, by the chunk and area of the tile it stands on, in the order of the
// units array within a chunk or area (which every peer shares). So a peer
// that restored a snapshot builds the same index as the others. A unit
// that moves to another chunk later in the tick is listed under the old one
// until the next rebuild (queries pad by a tile and read live positions;
// the collision pass allows for a tick's movement); units added later join
// then. Epoch stamps keep a rebuild O(units): a chunk or area not stamped
// this epoch is empty.
let _sxEpoch = 1, _sxDirty = true;
let _sxStamp = new Int32Array(0), _sxStart = new Int32Array(0), _sxCount = new Int32Array(0), _sxList = [];
let _sxAStamp = new Int32Array(0), _sxAStart = new Int32Array(0), _sxACount = new Int32Array(0), _sxAList = [];
let _sxAOwner = new Int32Array(0), _sxKeys = new Int32Array(0), _sxAreas = new Int32Array(0);
let _sxFill = new Int32Array(0), _sxAFill = new Int32Array(0), _sxAreaCap = 0, _sxPlayers = 0;
// Per entry (shared with the collision kernels): its unit's slot (-1 none)
// and chunk; the number of entries.
let _sxESlot = new Int32Array(0), _sxEKey = new Int32Array(0), _sxSi = new Int32Array(0), _sxListed = 0;
// The parallel build lists units by slot (_sxESlot, _sxASlot; the unit is
// _simUnitState.owners[slot], null once released): _sxBySlot. The serial
// build lists the objects (_sxList, _sxAList).
let _sxBySlot = false, _sxASlot = new Int32Array(0);
function _sxOwners() { return _sxBySlot ? _simUnitState.owners : null; }
function spatialIndexEntries() { spatialIndexEnsure(); return _sxListed; }

function spatialIndexEnsure() { if (_sxDirty) spatialIndexRebuild(); }
function spatialIndexInvalidate() { _sxDirty = true; }

// Large worlds build it with the kernels (SIM_KERNEL_INDEX_*): the same
// result (chunk and area ranges in key order, each in units order).
let _sxPar = null;
// From this many units the index is built by the kernels (tests lower it;
// both builds give the same queries).
let SPATIAL_PARALLEL_MIN_UNITS = 4096;
function spatialIndexRebuild() {
    // (A posted acquisition scan reads the index in place.)
    if (typeof acqTierIndexWait === 'function') acqTierIndexWait();
    _sxDirty = false;
    if (typeof simUnitStateReleaseFreed === 'function') simUnitStateReleaseFreed();
    const n = units.length;
    if (n >= SPATIAL_PARALLEL_MIN_UNITS && _simUnitState && typeof SIM_KERNEL_INDEX_COUNT === 'number' && _spatialIndexRebuildParallel()) return;
    _spatialIndexRebuildSerial();
}
function _spatialIndexRebuildParallel() {
    const nChunks = CHUNKS_W * CHUNKS_H, n = units.length, players = spatialUnitsComplexPlayerCount;
    const A = Math.max(areaDistanceMatrix ? areaDistanceMatrix.length : 0, Array.isArray(areas) ? areas.length : 0, 1);
    let X = _sxPar;
    if (!X || X.nChunks !== nChunks || X.A < A || X.players !== players) {
        X = _sxPar = { nChunks, A, players, bad: simSharedArray(Int32Array, 1),
            stamp: simSharedArray(Int32Array, nChunks), start: simSharedArray(Int32Array, nChunks), cnt: simSharedArray(Int32Array, nChunks), fill: simSharedArray(Int32Array, nChunks),
            astamp: simSharedArray(Int32Array, A), astart: simSharedArray(Int32Array, A), acnt: simSharedArray(Int32Array, A), afill: simSharedArray(Int32Array, A), aown: simSharedArray(Int32Array, A * players),
            listed: simSharedArray(Int32Array, 2), keys: null, areas: null, ent: null, aent: null, aslot: null, cap: 0 };
        for (const k of ['bad', 'stamp', 'start', 'cnt', 'fill', 'astamp', 'astart', 'acnt', 'afill', 'aown', 'listed']) simParallelBind('ix.' + k, X[k]);
        _sxEpoch = 1;
    }
    if (X.cap < n) {
        X.cap = Math.max(4096, n * 2);
        for (const k of ['keys', 'areas', 'ent', 'aent', 'aslot']) { X[k] = simSharedArray(Int32Array, X.cap); simParallelBind('ix.' + k, X[k]); }
    }
    if (_sxESlot.length < n) { _sxESlot = simSharedArray(Int32Array, Math.max(1024, n * 2)); _sxEKey = simSharedArray(Int32Array, Math.max(1024, n * 2)); }
    simParallelBind('sep.eslot', _sxESlot); simParallelBind('sep.ekey', _sxEKey);
    const slots = _unitSlotMapEnsure();
    simParallelBind('ix.slots', slots);
    simParallelBind('ix.agrid', _spatialAreaGridFlat());
    // The query views are the parallel build's arrays.
    _sxStamp = X.stamp; _sxStart = X.start; _sxCount = X.cnt;
    _sxAStamp = X.astamp; _sxAStart = X.astart; _sxACount = X.acnt; _sxAOwner = X.aown; _sxAreaCap = A; _sxPlayers = players;
    if (++_sxEpoch >= 0x3fffffff) { _sxEpoch = 1; X.stamp.fill(0); X.astamp.fill(0); }
    const ep = _sxEpoch, P = _simParams;
    const CJ = 65536, AJ = 16384, cj = Math.ceil(nChunks / CJ), aj = Math.ceil(A / AJ), UJ = 8192;
    P[0] = n; P[1] = UJ; P[2] = nChunks; P[3] = A; P[4] = players; P[5] = SIM_SEP_ABSENT; P[6] = cj; P[7] = CJ; P[8] = AJ;
    P[9] = TILE; P[10] = GRID_W; P[11] = GRID_H; P[12] = CHUNK_SIZE; P[13] = CHUNKS_W;
    X.bad[0] = 0;
    // Each unit's chunk and area (the kernels), then the units sorted by
    // chunk and by area with the stable parallel radix sort (units order
    // within one): ranges in key order, as the serial build lists them.
    simParallelRun(SIM_KERNEL_INDEX_KEYS, Math.ceil(n / UJ));
    // A unit without a state slot (none in play, normally): the serial build.
    if (X.bad[0]) return false;
    // Entries by slot (owners[slot]: slots freed this tick are not reused
    // before the next rebuild, simUnitStateReleaseFreed); per position in
    // key order the slot, per key its range, then the counts (and owners
    // per area), all in the kernels.
    P[15] = ep;
    X.listed[0] = n; X.listed[1] = n;
    for (let pass = 0; pass < 2; pass++) {
        const order = simSpatialStableOrder(pass ? X.areas : X.keys, n, pass ? A : nChunks, pass ? 2 : 1);
        simParallelBind(pass ? 'ix.ordA' : 'ix.ordC', order);
        P[0] = n; P[1] = UJ; P[2] = nChunks; P[3] = A; P[4] = players; P[14] = pass; P[15] = ep;
        simParallelRun(SIM_KERNEL_INDEX_FILL, Math.ceil(n / UJ));
        simParallelRun(SIM_KERNEL_INDEX_RUNS, Math.ceil(n / UJ));
    }
    _sxASlot = X.aslot;
    _sxListed = X.listed[0];
    _sxBySlot = true;
    return true;
}
function _spatialIndexRebuildSerial() {
    const nChunks = CHUNKS_W * CHUNKS_H, n = units.length, players = spatialUnitsComplexPlayerCount;
    _sxBySlot = false;
    if (_sxPar) {
        // Back from the parallel build: arrays of its own.
        _sxPar = null; _sxStamp = new Int32Array(0); _sxAreaCap = 0;
    }
    if (_sxStamp.length !== nChunks) {
        _sxStamp = simSharedArray(Int32Array, nChunks); _sxStart = simSharedArray(Int32Array, nChunks); _sxCount = simSharedArray(Int32Array, nChunks); _sxFill = new Int32Array(nChunks);
    }
    const A = Math.max(areaDistanceMatrix ? areaDistanceMatrix.length : 0, Array.isArray(areas) ? areas.length : 0, 1);
    if (_sxAreaCap < A || _sxPlayers !== players) {
        _sxAreaCap = A; _sxPlayers = players;
        _sxAStamp = new Int32Array(A); _sxAStart = new Int32Array(A); _sxACount = new Int32Array(A); _sxAFill = new Int32Array(A);
        _sxAOwner = new Int32Array(A * players);
    }
    if (_sxKeys.length < n) { _sxKeys = new Int32Array(n * 2); _sxAreas = new Int32Array(n * 2); _sxSi = new Int32Array(n * 2); }
    if (_sxESlot.length < n) { _sxESlot = simSharedArray(Int32Array, Math.max(1024, n * 2)); _sxEKey = simSharedArray(Int32Array, Math.max(1024, n * 2)); }
    if (++_sxEpoch >= 0x3fffffff) { _sxEpoch = 1; _sxStamp.fill(0); _sxAStamp.fill(0); }
    const ep = _sxEpoch;
    const S = _simUnitState, slots = S ? _unitSlotMapEnsure() : null, owners = S ? S.owners : null;
    const keys = _sxKeys, arOf = _sxAreas;
    // Counts per chunk and area (and owners per area).
    for (let i = 0; i < n; i++) {
        const u = units[i];
        const si = slots ? slots[i] : -1;
        _sxSi[i] = si >= 0 && owners[si] === u ? si : -1;
        if (!u || u.dead) { keys[i] = -1; continue; }
        let gx = Math.floor(u.x / TILE), gy = Math.floor(u.y / TILE);
        if (!(gx >= 0)) gx = 0; else if (gx >= GRID_W) gx = GRID_W - 1;
        if (!(gy >= 0)) gy = 0; else if (gy >= GRID_H) gy = GRID_H - 1;
        const key = CHUNK_SIZE === 1 ? gy * GRID_W + gx : Math.floor(gy / CHUNK_SIZE) * CHUNKS_W + Math.floor(gx / CHUNK_SIZE);
        const owner = u.owner;
        if (!(key >= 0 && key < nChunks)) { keys[i] = -1; continue; }
        keys[i] = key;
        if (_sxStamp[key] !== ep) { _sxStamp[key] = ep; _sxCount[key] = 0; }
        _sxCount[key]++;
        const row = areaIdGrid[gy], area = row ? row[gx] : -1;
        if (!(area >= 0 && area < A)) { arOf[i] = -1; continue; }
        arOf[i] = area;
        if (_sxAStamp[area] !== ep) { _sxAStamp[area] = ep; _sxACount[area] = 0; _sxAOwner.fill(0, area * players, area * players + players); }
        _sxACount[area]++;
        if (owner >= 0 && owner < players) _sxAOwner[area * players + owner]++;
    }
    // Ranges in order of first appearance (a range's count is negated
    // once placed), then the members from each range's start.
    let pos = 0, posA = 0;
    const fill = _sxFill, fillA = _sxAFill;
    for (let i = 0; i < n; i++) {
        const key = keys[i];
        if (key < 0) continue;
        const c = _sxCount[key];
        if (c > 0) { _sxStart[key] = pos; fill[key] = pos; pos += c; _sxCount[key] = -c; }
        const a = arOf[i];
        if (a < 0) continue;
        const ca = _sxACount[a];
        if (ca > 0) { _sxAStart[a] = posA; fillA[a] = posA; posA += ca; _sxACount[a] = -ca; }
    }
    const list = _sxList, listA = _sxAList;
    if (list.length < pos) list.length = pos;
    if (listA.length < posA) listA.length = posA;
    for (let i = 0; i < n; i++) {
        const key = keys[i];
        if (key < 0) continue;
        const u = units[i], e = fill[key]++;
        list[e] = u; _sxESlot[e] = _sxSi[i]; _sxEKey[e] = key;
        if (_sxCount[key] < 0) _sxCount[key] = -_sxCount[key];
        const a = arOf[i];
        if (a < 0) continue;
        listA[fillA[a]++] = u;
        if (_sxACount[a] < 0) _sxACount[a] = -_sxACount[a];
    }
    _sxListed = pos;
    for (let k = pos; k < list.length; k++) list[k] = undefined;
    for (let k = posA; k < listA.length; k++) listA[k] = undefined;
}

// The area grid as one shared array (tile -> area, -1 none), for the kernels.
let _spatialAreaFlat = null, _spatialAreaFlatOf = null;
function _spatialAreaGridFlat() {
    if (_spatialAreaFlatOf === areaIdGrid && _spatialAreaFlat && _spatialAreaFlat.length === GRID_W * GRID_H) return _spatialAreaFlat;
    const f = simSharedArray(Int32Array, Math.max(1, GRID_W * GRID_H));
    for (let y = 0; y < GRID_H; y++) { const row = areaIdGrid[y]; if (row) f.set(row.length === GRID_W ? row : Array.from({ length: GRID_W }, (_, x) => row[x] ?? -1), y * GRID_W); else f.fill(-1, y * GRID_W, (y + 1) * GRID_W); }
    _spatialAreaFlat = f; _spatialAreaFlatOf = areaIdGrid;
    return f;
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
    // (As forEachUnitInRange's.)
    let tickStart = !!(opts && opts.tickStart);
    let areaIds = getAreaIdsWithinDistanceOfSources(sources, maxDistance);
    if (!areaIds || areaIds.length <= 0) return false;
    spatialIndexEnsure();
    const ep = _sxEpoch, players = _sxPlayers, cap = _sxAreaCap, own = _sxOwners(), listA = own ? null : _sxAList, AS = _sxASlot;
    for (let i = 0; i < areaIds.length; i++) {
        let areaId = areaIds[i];
        if (!(areaId >= 0 && areaId < cap) || _sxAStamp[areaId] !== ep) continue;
        let k0 = _sxAStart[areaId], cnt = _sxACount[areaId];
        // Only the scanning player's own units there.
        if (enemyFilter >= 0 && enemyFilter < players && _sxAOwner[areaId * players + enemyFilter] === cnt) continue;
        for (let k = k0, k1 = k0 + cnt; k < k1; k++) {
            let u = own ? own[AS[k]] : listA[k];
            if (!u || (!includeDead && u.dead)) continue;
            if (playerFilter >= 0 && u.owner !== playerFilter) continue;
            if (enemyFilter >= 0 && u.owner === enemyFilter) continue;
            if (unitTypeFilter && u.unitType !== unitTypeFilter) continue;
            let dx = (Number(tickStart ? _unitTickX(u) : u.x) || 0) - wx;
            let dy = (Number(tickStart ? _unitTickY(u) : u.y) || 0) - wy;
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
    spatialIndexEnsure();
    const own = _sxOwners();
    for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
            let ck = cy * CHUNKS_W + cx;
            if (_sxStamp[ck] !== _sxEpoch) continue;
            for (let k = _sxStart[ck], k1 = k + _sxCount[ck]; k < k1; k++) { const u = own ? own[_sxESlot[k]] : _sxList[k]; if (u) result.push(u); }
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
    // Units where they were at the unit pass's start (_unitTickX): the index
    // lists them by that tile, and decisions in the pass read them there.
    let tickStart = !!(opts && opts.tickStart);

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
    let chunkCols = CHUNKS_W;
    spatialIndexEnsure();
    const sxEp = _sxEpoch, sxStamp = _sxStamp, sxStart = _sxStart, sxCount = _sxCount, own = _sxOwners(), sxList = own ? null : _sxList, ES = _sxESlot;

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
                if (sxStamp[ck] !== sxEp) continue;
                let minX = cx * cws, minY = cy * cws;
                let nx = wx < minX ? minX : (wx > minX + cws ? minX + cws : wx);
                let ny = wy < minY ? minY : (wy > minY + cws ? minY + cws : wy);
                let ddx = wx - nx, ddy = wy - ny;
                if (ddx * ddx + ddy * ddy > radiusSq) continue;
                for (let k = sxStart[ck], k1 = k + sxCount[ck]; k < k1; k++) {
                    let u = own ? own[ES[k]] : sxList[k];
                if (!u) continue;
                    if (u.owner !== playerFilter || u.dead) continue;
                    let dx = (tickStart ? _unitTickX(u) : u.x) - wx, dy = (tickStart ? _unitTickY(u) : u.y) - wy;
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
                if (sxStamp[ck] !== sxEp) continue;
                let minX = cx * cws, minY = cy * cws;
                let nx = wx < minX ? minX : (wx > minX + cws ? minX + cws : wx);
                let ny = wy < minY ? minY : (wy > minY + cws ? minY + cws : wy);
                let ddx = wx - nx, ddy = wy - ny;
                if (ddx * ddx + ddy * ddy > radiusSq) continue;
                for (let k = sxStart[ck], k1 = k + sxCount[ck]; k < k1; k++) {
                    let u = own ? own[ES[k]] : sxList[k];
                if (!u) continue;
                    if (hasPlayerFilter && u.owner !== playerFilter) continue;
                    if (hasEnemyFilter && u.owner === enemyFilter) continue;
                    if (hasUnitTypeFilter && u.unitType !== unitTypeFilter) continue;
                    if (u.dead) continue;
                    let dx = (tickStart ? _unitTickX(u) : u.x) - wx, dy = (tickStart ? _unitTickY(u) : u.y) - wy;
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
            if (sxStamp[ck] !== sxEp) continue;
            if (exact) {
                let minX = cx * cws, minY = cy * cws;
                let nx = wx < minX ? minX : (wx > minX + cws ? minX + cws : wx);
                let ny = wy < minY ? minY : (wy > minY + cws ? minY + cws : wy);
                let ddx = wx - nx, ddy = wy - ny;
                if (ddx * ddx + ddy * ddy > radiusSq) continue;
            }
            for (let k = sxStart[ck], k1 = k + sxCount[ck]; k < k1; k++) {
                let u = own ? own[ES[k]] : sxList[k];
                if (!u) continue;
                if (hasPlayerFilter && u.owner !== playerFilter) continue;
                if (hasEnemyFilter && u.owner === enemyFilter) continue;
                if (hasUnitTypeFilter && u.unitType !== unitTypeFilter) continue;
                if (!includeDead && u.dead) continue;
                let dx = (tickStart ? _unitTickX(u) : u.x) - wx, dy = (tickStart ? _unitTickY(u) : u.y) - wy;
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

// The nearest visible enemy unit within rangePx of (wx, wy) for `owner`, as
// the combat scan kernel picks it (SIM_KERNEL_COMBAT_SCAN): enemies where
// they were at the unit pass's start (_unitTickX), nearest first, then
// lowest id. A pure function of the state (no query cache: a cache's
// history differs between peers after a restore).
function _findClosestEnemyUnitByChunks(owner, wx, wy, rangePx) {
    let ownerId = Math.floor(Number(owner));
    if (ownerId < 0 || ownerId >= spatialUnitsComplexPlayerCount) return null;
    if (!(CHUNKS_W * CHUNKS_H > 0)) return null;
    let cws = CHUNK_SIZE * TILE;
    let r = Math.max(0, Number(rangePx) || 0);
    let rangeSq = r * r;
    let scan = r + TILE;
    let minCx = Math.max(0, Math.floor((wx - scan) / cws));
    let maxCx = Math.min(CHUNKS_W - 1, Math.floor((wx + scan) / cws));
    let minCy = Math.max(0, Math.floor((wy - scan) / cws));
    let maxCy = Math.min(CHUNKS_H - 1, Math.floor((wy + scan) / cws));
    // No enemy anywhere near: none.
    if (!_regionMayHaveEnemyUnits(ownerId, minCx, minCy, maxCx, maxCy)) return null;
    spatialIndexEnsure();
    const own = _sxOwners();
    let best = null, bestD2 = rangeSq;
    for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cx = minCx; cx <= maxCx; cx++) {
            let ck = cy * CHUNKS_W + cx;
            if (!_chunkHasEnemyForOwnerFast(ck, ownerId) || _sxStamp[ck] !== _sxEpoch) continue;
            for (let k = _sxStart[ck], k1 = k + _sxCount[ck]; k < k1; k++) {
                let u = own ? own[_sxESlot[k]] : _sxList[k];
                if (!u || u.dead || u.owner === ownerId) continue;
                let ux = _unitTickX(u), uy = _unitTickY(u);
                let dx = ux - wx, dy = uy - wy, d2 = dx * dx + dy * dy;
                if (d2 > bestD2 || (d2 === bestD2 && best && u.id > best.id)) continue;
                if (!isGameplayTargetVisibleToPlayer(ownerId, Math.floor(ux / TILE), Math.floor(uy / TILE))) continue;
                best = u; bestD2 = d2;
            }
        }
    }
    return best;
}
